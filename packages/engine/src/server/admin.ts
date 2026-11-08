/**
 * 管理页（主人用）：剧本库与默认剧本、对局（中止、观战链接）、已发放的密钥（作废）。
 *
 * 不设密码，只靠网络隔离：配置里 admin.host 应是内网地址（比如 Tailscale 的 100.x），不要经 Funnel 暴露。
 * 另外两道防线：
 *  - 只认 Host 头是本机监听地址（或 admin.allowedHosts）的请求 → 外部网页借 DNS 重绑定打不进来；
 *  - 写操作必须是 JSON、带 X-Admin-Request: 1 请求头，有 Origin 时必须是本页 → 别的网页没法跨站提交。
 * 不显示任何对局里的秘密（身份、剧本正文、线索），只有公开的摘要。
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import type { Identity } from '../core/types.js';
import { GameError } from '../core/errors.js';
import type { Runtime } from './runtime.js';

const ADMIN_DIR = new URL('../../admin/', import.meta.url);
const FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
  'admin.css': 'text/css; charset=utf-8',
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** 管理页操作时的身份（写进日志和中止原因） */
const ADMIN: Identity = { id: 'admin-page', name: '管理页', admin: true };

export interface AdminHandle {
  url: string;
  close(): Promise<void>;
}

export async function startAdminServer(rt: Runtime, log: (msg: string) => void): Promise<AdminHandle | null> {
  const cfg = rt.config.admin;
  if (cfg.port === null) return null;
  const { manager, auth, settings } = rt;
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(FILES)) {
    try {
      files.set(name, readFileSync(new URL(name, ADMIN_DIR)));
    } catch {
      log(`[admin] 缺少页面文件 admin/${name}`);
    }
  }

  const app = express();
  app.disable('x-powered-by');
  let allowed = new Set<string>();
  // 先检查 Host：只认本机监听地址和配置的名字
  app.use((req, res, next) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!allowed.has(host)) {
      res.status(421).type('text/plain').send('misdirected request');
      return;
    }
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  const sendFile = (name: string, res: Response) => {
    const body = files.get(name);
    if (!body) return void res.status(404).type('text/plain').send('not found');
    res.setHeader('Content-Type', FILES[name]!);
    res.send(body);
  };
  app.get('/', (_req, res) => sendFile('index.html', res));
  app.get('/:file', (req, res, next) => {
    const name = String(req.params.file);
    if (!(name in FILES) || name === 'index.html') return next();
    sendFile(name, res);
  });

  /** 写操作的防跨站检查 */
  const guard = (req: Request, res: Response): boolean => {
    const origin = req.headers.origin;
    const okOrigin = !origin || allowed.has(String(origin).replace(/^https?:\/\//, '').toLowerCase());
    if (req.header('x-admin-request') !== '1' || !req.is('application/json') || !okOrigin) {
      res.status(403).json({ error: 'forbidden', message: '请从管理页操作。' });
      return false;
    }
    return true;
  };
  const fail = (res: Response, e: unknown) => {
    if (e instanceof GameError) res.status(400).json({ error: e.code, message: e.message });
    else {
      log(`[admin] ${e instanceof Error ? e.stack : String(e)}`);
      res.status(500).json({ error: 'internal', message: '服务器出错了，详见引擎日志。' });
    }
  };

  app.get('/api/overview', (_req, res) => {
    try {
      res.json(overview());
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/default-script', (req, res) => {
    if (!guard(req, res)) return;
    try {
      const id = req.body?.id === null || req.body?.id === '' ? null : String(req.body?.id ?? '').trim();
      if (id !== null && !rt.scripts?.get(id)) throw new GameError('NOT_FOUND', `剧本库里没有 ${id}。`);
      settings.setJubenshaDefaultScript(id);
      log(`[admin] 剧本杀默认剧本：${id ?? '（不设）'}`);
      res.json(overview());
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/games/:id/abort', (req, res) => {
    if (!guard(req, res)) return;
    try {
      const reason = String(req.body?.reason ?? '').trim() || '主人在管理页中止';
      manager.abortGame(ADMIN, String(req.params.id), reason);
      log(`[admin] 中止对局 ${req.params.id}：${reason}`);
      res.json(overview());
    } catch (e) {
      fail(res, e);
    }
  });

  app.post('/api/keys/:id/revoke', (req, res) => {
    if (!guard(req, res)) return;
    try {
      if (!auth.revokeKey(ADMIN, String(req.params.id))) throw new GameError('NOT_FOUND', `没有发给 ${req.params.id} 的密钥。`);
      res.json(overview());
    } catch (e) {
      fail(res, e);
    }
  });

  app.use((_req, res) => void res.status(404).json({ error: 'not_found' }));

  function overview() {
    const lib = rt.scripts;
    const def = settings.jubenshaDefaultScript;
    const scripts = (lib?.list() ?? []).map((s) => {
      const p = lib!.get(s.id);
      return {
        id: s.id,
        title: s.title,
        players: s.players,
        summary: s.summary,
        roles: p?.roles.length ?? 0,
        acts: p?.acts.length ?? 0,
        images: p?.images.length ?? 0,
        clues: p?.clues.length ?? 0,
        questions: p?.questionnaire.length ?? 0,
        is_default: s.id === def,
      };
    });
    const all = manager.listGames({ includeFinished: true });
    const withLink = (g: (typeof all)[number]) => {
      const rec = manager.getRecord(g.game_id);
      return {
        id: g.game_id,
        name: g.name,
        type: g.type,
        group_id: g.group_id,
        status: g.status,
        stage: g.stage,
        players: g.players,
        phase: g.phase,
        round: g.round,
        referee: g.referee,
        created_at: g.created_at,
        ended_at: rec.endedAt ? new Date(rec.endedAt).toISOString() : null,
        watch_url: rec.stage === 'web' ? manager.watchUrl(rec) : null,
      };
    };
    const issued = auth.canIssue ? auth.listIssued(ADMIN) : [];
    return {
      server: {
        version: rt.version,
        uptime_s: Math.round((Date.now() - rt.startedAt) / 1000),
        web_url: rt.config.webUrl,
        scripts_dir: Boolean(rt.config.scriptsDir),
      },
      scripts,
      script_errors: lib?.errors() ?? {},
      default_script: def && scripts.some((s) => s.id === def) ? def : null,
      // 只有一个剧本时不用设默认
      default_needed: scripts.length > 1,
      games: {
        active: all.filter((g) => g.status === 'lobby' || g.status === 'running').map(withLink),
        recent: all.filter((g) => g.status === 'ended' || g.status === 'aborted').slice(0, 20).map(withLink),
      },
      keys: issued
        .map((k) => ({ id: k.id, name: k.name, owner: k.owner ?? null, issued_at: k.issuedAt ? new Date(k.issuedAt).toISOString() : null }))
        .sort((a, b) => String(b.issued_at).localeCompare(String(a.issued_at))),
    };
  }

  const server = await new Promise<import('node:http').Server>((resolve, reject) => {
    const s = app.listen(cfg.port!, cfg.host, () => resolve(s));
    s.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const hostPart = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  allowed = new Set([`${hostPart}:${port}`.toLowerCase(), ...cfg.allowedHosts.map((h) => h.toLowerCase())]);
  if (cfg.host === '127.0.0.1' || cfg.host === 'localhost') {
    allowed.add(`127.0.0.1:${port}`);
    allowed.add(`localhost:${port}`);
  }
  const url = `http://${hostPart}:${port}/`;
  log(`[admin] 管理页：${url}`);
  return {
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
