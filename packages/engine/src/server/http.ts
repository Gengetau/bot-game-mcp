/**
 * HTTP 服务：
 *  - POST/GET/DELETE {path}   Streamable HTTP（MCP 2025-03-26 起的标准远程传输）
 *  - GET /sse + POST /messages 旧版 HTTP+SSE 传输（兼容老客户端）
 *  - GET /health               健康检查
 *  - GET /api/games[/:id]      只读公开观战接口（只含公开信息）
 *
 * 认证：Authorization: Bearer <key>（或 X-API-Key 头 / ?key= 查询参数）。
 */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { extractKey, type SessionContext } from '../mcp/auth.js';
import { createMcpServer } from '../mcp/server.js';
import type { Runtime } from './runtime.js';

interface Session {
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  server: McpServer;
  ctx: SessionContext;
  key: string | undefined;
  lastSeen: number;
}

export interface HttpHandle {
  server: HttpServer;
  url: string;
  sessions: () => number;
  close(): Promise<void>;
}

function jsonRpcError(res: Response, status: number, message: string, code = -32000): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export async function startHttpServer(rt: Runtime, log: (msg: string) => void = console.error): Promise<HttpHandle> {
  const { config, manager, auth } = rt;
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  const sessions = new Map<string, Session>();

  /** 解析请求身份；keys 模式下无效/缺失密钥直接 401。返回 false 表示已响应。 */
  function authenticate(req: Request, res: Response): { ok: true; ctx: SessionContext; key?: string } | { ok: false } {
    const key = extractKey(req.headers, req.query as Record<string, unknown>);
    const identity = auth.identityFromKey(key);
    if (identity === null) {
      jsonRpcError(res, 401, 'Unauthorized: 无效的密钥');
      return { ok: false };
    }
    if (identity === undefined && auth.mode === 'keys') {
      jsonRpcError(res, 401, 'Unauthorized: 需要 Authorization: Bearer <key> 请求头');
      return { ok: false };
    }
    return { ok: true, key, ctx: { identity: identity ?? null, fixed: Boolean(identity), transport: 'http' } };
  }

  const deps = { manager, auth, version: rt.version };

  // ───────── Streamable HTTP ─────────
  const handleMcp = async (req: Request, res: Response) => {
    try {
      const sid = req.header('mcp-session-id');
      if (sid) {
        const s = sessions.get(sid);
        if (!s || !(s.transport instanceof StreamableHTTPServerTransport)) {
          jsonRpcError(res, 404, 'Session not found（会话已过期，请重新初始化）', -32001);
          return;
        }
        const key = extractKey(req.headers, req.query as Record<string, unknown>);
        if (s.key !== undefined && key !== s.key) {
          jsonRpcError(res, 403, 'Forbidden: 会话与密钥不匹配');
          return;
        }
        if (s.key !== undefined && auth.identityFromKey(s.key) === null) {
          // 密钥在会话期间被作废/轮换：立刻失效
          sessions.delete(sid);
          void s.transport.close().catch(() => undefined);
          jsonRpcError(res, 401, 'Unauthorized: 密钥已失效');
          return;
        }
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res, req.body);
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, 'Bad Request: 缺少有效的 Mcp-Session-Id（请先发送 initialize）');
        return;
      }
      const a = authenticate(req, res);
      if (!a.ok) return;
      const server = createMcpServer(deps, a.ctx);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, ctx: a.ctx, key: a.key, lastSeen: Date.now() });
          log(`[mcp] 新会话 ${id.slice(0, 8)} ${a.ctx.identity ? `${a.ctx.identity.name}(${a.ctx.identity.id})` : '(未登录)'}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`[mcp] 请求处理出错：${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error', -32603);
    }
  };
  app.post(config.path, handleMcp);
  app.get(config.path, handleMcp);
  app.delete(config.path, handleMcp);

  // ───────── 旧版 HTTP+SSE ─────────
  if (config.legacySse) {
    app.get('/sse', async (req, res) => {
      const a = authenticate(req, res);
      if (!a.ok) return;
      const transport = new SSEServerTransport('/messages', res);
      const ctx: SessionContext = { ...a.ctx, transport: 'sse' };
      const server = createMcpServer(deps, ctx);
      sessions.set(transport.sessionId, { transport, server, ctx, key: a.key, lastSeen: Date.now() });
      res.on('close', () => {
        sessions.delete(transport.sessionId);
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        log(`[sse] 新会话 ${transport.sessionId.slice(0, 8)} ${ctx.identity ? `${ctx.identity.name}(${ctx.identity.id})` : '(未登录)'}`);
      } catch (e) {
        log(`[sse] 连接失败：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    app.post('/messages', async (req, res) => {
      const sid = String(req.query.sessionId ?? '');
      const s = sessions.get(sid);
      if (!s || !(s.transport instanceof SSEServerTransport)) {
        res.status(404).send('Session not found');
        return;
      }
      s.lastSeen = Date.now();
      await s.transport.handlePostMessage(req, res, req.body);
    });
  }

  // ───────── 其他 ─────────
  app.get('/health', (_req, res) => {
    res.json({ ok: true, name: 'bot-game-mcp', version: rt.version, sessions: sessions.size, auth_mode: auth.mode });
  });

  if (config.publicApi) {
    app.get('/api/games', (req, res) => {
      res.json({ games: manager.listGames({ groupId: req.query.group_id as string | undefined, includeFinished: req.query.all === '1' }) });
    });
    app.get('/api/games/:id', (req, res) => {
      try {
        const rec = manager.getRecord(req.params.id);
        // 只有正常结束的对局公开完整复盘；中止的对局仍只给公开记录
        const finished = rec.status === 'ended';
        res.json({
          summary: manager.summary(rec),
          players: rec.players.map((p) => ({ seat: p.seat, name: p.name, kind: p.kind, alive: p.alive })),
          result: rec.result,
          events: rec.log
            .filter((e) => finished || e.audience.type === 'public')
            .map((e) => ({ seq: e.seq, round: e.round, kind: e.kind, text: e.text })),
        });
      } catch {
        res.status(404).json({ error: 'not found' });
      }
    });
  }

  // 空闲会话清理
  const idleMs = config.sessionIdleMinutes * 60_000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > idleMs) {
        sessions.delete(id);
        void s.transport.close().catch(() => undefined);
      }
    }
  }, 60_000);
  sweeper.unref();

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const srv = app.listen(config.port, config.host, () => resolve(srv));
    srv.on('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const hostForUrl = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const url = `http://${hostForUrl}:${port}${config.path}`;
  return {
    server,
    url,
    sessions: () => sessions.size,
    async close() {
      clearInterval(sweeper);
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
