/**
 * 栖灯镇的网页接口（/town/）。
 *
 *  公开（不用登录，只有公开投影）：
 *   GET  /town/                         页面（静态文件，全部来自仓库）
 *   GET  /town/api/config               世界名、可选的个性与兴趣、是否开放开发登录
 *   GET  /town/api/public               公开的小镇地图
 *   GET  /town/api/public/events        SSE：公开事件流（?cursor= 续传）
 *   GET  /town/api/public/game/:id      小游戏的观战投影
 *   GET  /town/api/public/report        公开日报（?date=）
 *  登录：
 *   POST /town/api/auth/exchange        {ticket} 一次性登录票据 → 会话 Cookie（HttpOnly）
 *   POST /town/api/auth/dev             {name} 本机试玩登录（只在 devLogin 打开时）
 *   POST /town/api/auth/logout
 *   GET  /town/api/session              当前登录状态
 *  居民（要会话；写操作要 clientId，并且这个客户端握着控制权）：
 *   POST /town/api/enter                {clientId, profile?} 注册或恢复居民，登记在场
 *   GET  /town/api/me?clientId=         本人视图
 *   POST /town/api/actions              {clientId, requestId, actionWindow, expected, action}
 *   POST /town/api/heartbeat            {clientId, presenceEpoch}
 *   POST /town/api/claim                {clientId} 接管控制权
 *   POST /town/api/leave                主动离开小镇
 *   GET  /town/api/events?clientId=     SSE：本人的事件 + 公开事件（各有游标）
 *   GET  /town/api/letters | history | residents | relations | report | game
 *
 * 身份只来自会话 Cookie：请求里自报的居民编号、号码一律不认。
 */
import { readFileSync, statSync } from 'node:fs';
import express, { type Express, type Request, type Response } from 'express';
import { INTERESTS, TRAITS } from './content.js';
import { HTTP_STATUS, WorldError } from './errors.js';
import { gameViewFor, publicGameView } from './games.js';
import { claimControl, devLoginSession, exchangeTicket, heartbeat, leaveWorld, revokeSession, sessionPrincipal } from './identity.js';
import { enterWorld } from './index.js';
import { listLetters } from './mail.js';
import { report } from './reports.js';
import type { WorldService } from './service.js';
import { relationsOf } from './social.js';
import { chatHistory, directory, meView, publicView } from './views.js';
import type { Principal } from './types.js';

const TOWN_DIR = new URL('../../town/', import.meta.url);
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  json: 'application/json; charset=utf-8',
  woff2: 'font/woff2',
};
const COOKIE = 'town_session';

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function rateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; since: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.since > windowMs) hits.delete(k);
    const h = hits.get(key);
    if (!h || now - h.since > windowMs) {
      hits.set(key, { n: 1, since: now });
      return true;
    }
    h.n += 1;
    return h.n <= limit;
  };
}

export interface TownHttpOptions {
  heartbeatMs?: number;
  requestsPerMinute?: number;
}

export function mountTown(app: Express, w: WorldService, log: (msg: string) => void, opts: TownHttpOptions = {}): () => void {
  const allow = rateLimiter(opts.requestsPerMinute ?? 240);
  const allowAuth = rateLimiter(20);
  const pingMs = opts.heartbeatMs ?? 20_000;
  const closers = new Set<() => void>();
  let residentStreams = 0;
  let publicStreams = 0;
  const perResident = new Map<string, number>();
  const fileCache = new Map<string, { mtime: number; body: Buffer }>();

  const ipOf = (req: Request) => {
    const direct = req.socket.remoteAddress ?? '?';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(direct)) return direct;
    const fwd = req.header('cf-connecting-ip') ?? req.header('x-forwarded-for')?.split(',')[0];
    return fwd?.trim().slice(0, 64) || direct;
  };
  const isHttps = (req: Request) => req.secure || req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';

  const tokenOf = (req: Request): string | null => {
    const raw = req.header('cookie');
    if (!raw) return null;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  };
  const setCookie = (req: Request, res: Response, token: string, maxAgeMs: number) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/town; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${isHttps(req) ? '; Secure' : ''}`);
  };

  const fail = (res: Response, e: unknown) => {
    if (e instanceof WorldError) {
      if (e.code === 'rate_limited' && typeof e.data?.retryAfterMs === 'number') res.setHeader('Retry-After', String(Math.ceil(e.data.retryAfterMs / 1000)));
      if (e.code === 'recovering') res.setHeader('Retry-After', '3');
      res.status(HTTP_STATUS[e.code]).json({ ok: false, ...e.toJSON() });
      return;
    }
    log(`[town] 接口出错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    res.status(500).json({ ok: false, error: 'internal', message: '服务器出错了。' });
  };

  /** 包一层：安全头、不缓存、限流、统一错误格式。 */
  const api =
    (fn: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response): void => {
      secure(res);
      res.setHeader('Cache-Control', 'no-store');
      if (!allow(ipOf(req))) {
        res.status(429).json({ ok: false, error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
        return;
      }
      try {
        const out = fn(req, res);
        if (out !== undefined && !res.headersSent) res.json(out);
      } catch (e) {
        fail(res, e);
      }
    };

  /** 写操作：必须是 JSON，并且来源就是这个站点（跨站页面带不上别的来源还能通过这一关）。 */
  const post = (fn: (req: Request, res: Response) => unknown) =>
    api((req, res) => {
      if (!req.is('application/json')) throw new WorldError('bad_request', '请用 JSON 提交。');
      const origin = req.header('origin');
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          /* 无效的 Origin 当作跨站 */
        }
        const expected = req.header('x-forwarded-host')?.split(',')[0]?.trim() || req.header('host');
        if (host !== expected) throw new WorldError('unauthenticated', '跨站请求被拒绝。');
      }
      return fn(req, res);
    });

  const principalOf = (req: Request): Principal => {
    const p = sessionPrincipal(w, tokenOf(req));
    if (!p) throw new WorldError('unauthenticated', '请先登录。');
    return p;
  };
  const residentOf = (req: Request) => {
    const p = principalOf(req);
    const r = w.residentOfPrincipal(p.principal_id);
    if (!r) throw new WorldError('unauthenticated', '还没有居民身份，请先进入小镇。', 'no_resident');
    return { p, r };
  };
  const clientIdOf = (req: Request): string => {
    const id = String((req.method === 'GET' ? req.query.clientId : req.body?.clientId) ?? '');
    if (!/^[\w.:-]{4,80}$/.test(id)) throw new WorldError('bad_request', '需要 clientId。');
    return `web:${id}`;
  };

  // ── 静态页面 ──
  const sendFile = (name: string, res: Response) => {
    const ext = name.split('.').pop() ?? '';
    if (!/^[\w][\w.-]*$/.test(name) || !TYPES[ext]) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    try {
      const url = new URL(name, TOWN_DIR);
      const st = statSync(url);
      let hit = fileCache.get(name);
      if (!hit || hit.mtime !== st.mtimeMs) {
        hit = { mtime: st.mtimeMs, body: readFileSync(url) };
        fileCache.set(name, hit);
      }
      secure(res);
      res.setHeader('Content-Type', TYPES[ext]!);
      res.setHeader('Cache-Control', 'no-cache');
      res.send(hit.body);
    } catch {
      res.status(404).type('text/plain').send('not found');
    }
  };
  app.get('/town', (req, res) => {
    const url = req.originalUrl;
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    if (path.endsWith('/')) return sendFile('index.html', res);
    res.redirect(301, `/town/${q < 0 ? '' : url.slice(q)}`);
  });
  app.get('/town/:file', (req, res, next) => {
    const name = String(req.params.file);
    if (name === 'api') return next();
    sendFile(name, res);
  });

  // 契约里的 /worlds/{id}/… 写法：和不带世界编号的路径是同一组接口（这个进程只有一个世界）
  app.use((req, res, next) => {
    const m = /^\/town\/api\/worlds\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url);
    if (!m) return next();
    if (decodeURIComponent(m[1]!) !== w.worldId) {
      secure(res);
      res.status(404).json({ ok: false, error: 'not_available', message: '没有这个世界。' });
      return;
    }
    req.url = `/town/api${m[2] ?? ''}${m[3] ?? ''}`;
    next();
  });

  const json = express.json({ limit: '16kb' });

  // ── 公开 ──
  app.get(
    '/town/api/config',
    api(() => ({
      world: { id: w.worldId, name: w.worldName, timezone: w.params.timezone },
      devLogin: w.devLogin,
      traits: TRAITS,
      interests: INTERESTS.map((i) => ({ id: i.id, name: i.name })),
      limits: { traits: w.params.traitCount, interests: w.params.interestCount, chatMaxChars: w.params.chatMaxChars, letterMaxChars: w.params.letterMaxChars },
      heartbeatMs: w.params.heartbeatIntervalMs,
    })),
  );
  app.get('/town/api/public', api(() => publicView(w)));
  app.get(
    '/town/api/public/game/:id',
    api((req) => {
      const v = publicGameView(w, String(req.params.id));
      if (!v) throw new WorldError('not_available', '找不到这一局。');
      return v;
    }),
  );
  app.get(
    '/town/api/public/report',
    api((req) => {
      const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : w.today();
      if (date > w.today()) throw new WorldError('bad_request', '还没到那一天。');
      return report(w, 'public', date, w.now());
    }),
  );

  // ── 登录 ──
  app.post(
    '/town/api/auth/exchange',
    json,
    post((req, res) => {
      if (!allowAuth(ipOf(req))) throw new WorldError('rate_limited', '尝试太频繁，请稍后再试。');
      const s = exchangeTicket(w, req.body?.ticket);
      setCookie(req, res, s.token, s.expires_at - w.now());
      return { ok: true, name: s.principal.display_name, hasResident: Boolean(w.residentOfPrincipal(s.principal.principal_id)) };
    }),
  );
  app.post(
    '/town/api/auth/dev',
    json,
    post((req, res) => {
      if (!allowAuth(ipOf(req))) throw new WorldError('rate_limited', '尝试太频繁，请稍后再试。');
      const s = devLoginSession(w, req.body?.name);
      setCookie(req, res, s.token, s.expires_at - w.now());
      return { ok: true, name: s.principal.display_name, hasResident: Boolean(w.residentOfPrincipal(s.principal.principal_id)) };
    }),
  );
  app.post(
    '/town/api/auth/logout',
    json,
    post((req, res) => {
      const token = tokenOf(req);
      if (token) revokeSession(w, token);
      setCookie(req, res, '', 0);
      return { ok: true };
    }),
  );
  app.get(
    '/town/api/session',
    api((req) => {
      const p = sessionPrincipal(w, tokenOf(req));
      if (!p) return { loggedIn: false };
      const r = w.residentOfPrincipal(p.principal_id);
      return { loggedIn: true, name: p.display_name, kind: p.kind, resident: r ? { id: r.resident_id, name: r.name, present: r.present_since !== null } : null };
    }),
  );

  // ── 居民 ──
  app.post(
    '/town/api/enter',
    json,
    post((req) => {
      const p = principalOf(req);
      const out = enterWorld(w, { principalId: p.principal_id, clientId: clientIdOf(req) }, { clientKind: 'web', ...(req.body?.profile ? { profile: req.body.profile } : {}) });
      return { ok: true, ...out.enter, view: out.view };
    }),
  );
  app.get(
    '/town/api/me',
    api((req) => {
      const { r } = residentOf(req);
      return meView(w, r, clientIdOf(req));
    }),
  );
  app.post(
    '/town/api/actions',
    json,
    post((req) => {
      const p = principalOf(req);
      const b = req.body ?? {};
      return w.command({ principalId: p.principal_id, clientId: clientIdOf(req) }, { requestId: b.requestId, actionWindow: b.actionWindow, expected: b.expected, action: b.action });
    }),
  );
  app.post(
    '/town/api/heartbeat',
    json,
    post((req) => {
      const p = principalOf(req);
      return { ok: true, ...heartbeat(w, { principalId: p.principal_id, clientId: clientIdOf(req) }, req.body?.presenceEpoch) };
    }),
  );
  app.post(
    '/town/api/claim',
    json,
    post((req) => {
      const p = principalOf(req);
      return { ok: true, ...claimControl(w, { principalId: p.principal_id, clientId: clientIdOf(req) }) };
    }),
  );
  app.post(
    '/town/api/leave',
    json,
    post((req) => {
      const p = principalOf(req);
      return leaveWorld(w, p.principal_id);
    }),
  );
  app.get(
    '/town/api/letters',
    api((req) => {
      const { r } = residentOf(req);
      const before = req.query.before ? Number(req.query.before) : null;
      return listLetters(w, r.resident_id, req.query.box === 'sent' ? 'sent' : 'inbox', Number.isFinite(before) ? before : null, Number(req.query.limit ?? 20) || 20, w.now());
    }),
  );
  app.get(
    '/town/api/history',
    api((req) => {
      const { r } = residentOf(req);
      const before = req.query.before ? Number(req.query.before) : null;
      return chatHistory(w, r.resident_id, Number.isFinite(before) ? before : null, Number(req.query.limit ?? 50) || 50);
    }),
  );
  app.get(
    '/town/api/residents',
    api((req) => {
      residentOf(req);
      return { residents: directory(w, w.now()) };
    }),
  );
  app.get(
    '/town/api/relations',
    api((req) => {
      const { r } = residentOf(req);
      return { relations: relationsOf(w, r.resident_id) };
    }),
  );
  app.get(
    '/town/api/report',
    api((req) => {
      const { r } = residentOf(req);
      const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : w.today();
      if (date > w.today()) throw new WorldError('bad_request', '还没到那一天。');
      return { personal: report(w, { residentId: r.resident_id }, date, w.now()), public: report(w, 'public', date, w.now()) };
    }),
  );
  app.get(
    '/town/api/game',
    api((req) => {
      const { r } = residentOf(req);
      const v = gameViewFor(w, r, req.query.since ? Number(req.query.since) : undefined);
      if (!v) throw new WorldError('context_stale', '你现在不在一局游戏里。', undefined, { contextVersion: r.context_version, activityId: null });
      return v;
    }),
  );

  // ── SSE ──
  const openStream = (req: Request, res: Response, residentId: string | null) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    let closed = false;
    let cursor: string | undefined = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : (req.header('last-event-id') ?? undefined);
    let pcursor: string | undefined = typeof req.query.pcursor === 'string' && req.query.pcursor ? req.query.pcursor : undefined;
    if (!residentId) {
      pcursor = cursor ?? pcursor;
      cursor = undefined;
    }
    const send = (event: string, data: unknown, id?: string) => {
      if (closed) return;
      // 缓冲有上限：客户端读得太慢就断开，让它带着游标重连，不无限攒在内存里
      if (res.writableLength > w.params.streamBufferLimit) {
        close();
        return;
      }
      res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const pump = () => {
      if (closed) return;
      try {
        if (residentId) {
          for (let i = 0; i < 20; i++) {
            const read = w.readResidentEvents(residentId, cursor ?? w.cursorOf(residentId), 100);
            if (read.resync) {
              cursor = read.cursor;
              send('resync', { scope: 'private', cursor });
              break;
            }
            for (const ev of read.events) send('private', { type: ev.type, at: ev.at, data: ev.data }, ev.id);
            cursor = read.cursor;
            if (!read.more) break;
          }
        }
        for (let i = 0; i < 20; i++) {
          const read = w.readPublicEvents(pcursor ?? w.publicCursor(), 100);
          if (read.resync) {
            pcursor = read.cursor;
            send('resync', { scope: 'public', pcursor });
            break;
          }
          for (const ev of read.events) send('public', { type: ev.type, at: ev.at, data: ev.data, pcursor: ev.id }, residentId ? undefined : ev.id);
          pcursor = read.cursor;
          if (!read.more) break;
        }
      } catch (e) {
        log(`[town] 事件流出错：${e instanceof Error ? e.message : String(e)}`);
        close();
      }
    };
    const offs: (() => void)[] = [w.onPublic(pump)];
    if (residentId) {
      offs.push(w.onResident(residentId, pump));
      offs.push(
        w.onRevoke(residentId, () => {
          send('revoked', {});
          close();
        }),
      );
    }
    const timer = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, pingMs);
    timer.unref();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const off of offs) off();
      closers.delete(close);
      if (residentId) {
        residentStreams--;
        perResident.set(residentId, Math.max(0, (perResident.get(residentId) ?? 1) - 1));
      } else publicStreams--;
      res.end();
    }
    closers.add(close);
    req.on('close', close);
    send('hello', { cursor: cursor ?? (residentId ? w.cursorOf(residentId) : undefined), pcursor: pcursor ?? w.publicCursor(), time: w.now() });
    pump();
  };

  app.get('/town/api/public/events', (req, res) => {
    secure(res);
    if (!allow(ipOf(req)) || publicStreams >= w.params.maxPublicStreams) {
      res.status(429).json({ ok: false, error: 'rate_limited', message: '连接太多，请稍后再试。' });
      return;
    }
    publicStreams++;
    openStream(req, res, null);
  });

  app.get('/town/api/events', (req, res) => {
    secure(res);
    try {
      const { r } = residentOf(req);
      if (!allow(ipOf(req)) || residentStreams >= w.params.maxResidentStreams || (perResident.get(r.resident_id) ?? 0) >= 4) {
        res.status(429).json({ ok: false, error: 'rate_limited', message: '连接太多，请稍后再试。' });
        return;
      }
      residentStreams++;
      perResident.set(r.resident_id, (perResident.get(r.resident_id) ?? 0) + 1);
      openStream(req, res, r.resident_id);
    } catch (e) {
      fail(res, e);
    }
  });

  return () => {
    for (const close of [...closers]) close();
  };
}
