/**
 * 栖灯镇的网页接口（/town/）。
 *
 *  公开（不用登录，只有公开投影）：
 *   GET  /town/                         页面（静态文件，全部来自仓库）
 *   GET  /town/3d/…                     三维网页客户端（静态托管 town.clientDir，见 docs/TOWN.md）
 *   GET  /town/api/config               世界名、可选的个性与兴趣、是否开放开发登录
 *   GET  /town/api/public               公开的小镇地图
 *   GET  /town/api/map                  空间地图清单（带 ETag，可缓存；客户端按 checksum 校验）
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
 *   GET  /town/api/scene                本人所在场景的完整快照（SceneView）
 *   POST /town/api/nav/renew            {clientId, navigationId, revision} 续导航控制租约
 *   POST /town/api/ws-ticket            {clientId} → {ticket, expiresAt}：一次性、30 秒内有效，换 WebSocket 登录
 *   WS   /town/ws                       空间同步（hello 里带票据；协议见 ws.ts）
 *   POST /town/api/claim                {clientId} 接管控制权
 *   POST /town/api/leave                主动离开小镇
 *   GET  /town/api/events?clientId=     SSE：本人的事件 + 公开事件（各有游标）
 *   GET  /town/api/letters | history | residents | relations | report | game
 *
 * 身份只来自会话 Cookie：请求里自报的居民编号、号码一律不认。
 */
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { INTERESTS, TRAITS } from './content.js';
import { HTTP_STATUS, WorldError } from './errors.js';
import { gameViewFor, publicGameView } from './games.js';
import { claimControl, devLoginSession, exchangeTicket, heartbeat, leaveWorld, revokeSession, sessionPrincipal } from './identity.js';
import { enterWorld } from './index.js';
import { listLetters } from './mail.js';
import { report } from './reports.js';
import { sha256, type WorldService } from './service.js';
import { relationMemories, relationsOf } from './social.js';
import { mapManifest, renewNavigation, sceneView } from './space.js';
import { townChatPage } from './chat.js';
import { chatHistory, directory, meView, publicView } from './views.js';
import type { Principal } from './types.js';
import { createTownWs, type TownWsOptions } from './ws.js';

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

/** /town/3d/ 能发的文件类型（Godot 网页导出 + 随包资源）；不在表里的后缀一律 404 */
const TYPES_3D: Record<string, string> = {
  ...TYPES,
  wasm: 'application/wasm',
  pck: 'application/octet-stream',
  glb: 'model/gltf-binary',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8', // 开源许可文本 licenses.txt（export.sh 生成）
};

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * /town/3d/ 的 CSP：在 CSP 的基础上只放宽三维客户端必需的部分。
 * connect-src 另外显式列出同源的 ws:// / wss:// 源（extraConnect）：CSP3 规定 'self' 匹配同源 ws/wss，
 * 但旧版 Safari（约 15.4 之前的 WebKit）不认，会拦掉同源 WebSocket。
 */
function csp3d(extraConnect: string[]): string {
  return (
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    `connect-src ${["'self'", ...extraConnect].join(' ')}; media-src 'self' blob:; worker-src 'self' blob:; ` +
    "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
}

/** 只接受 主机名 / IPv4 / [IPv6] 加可选端口；任何别的字符（空格、分号、引号、逗号……）都不能进 CSP */
const SAFE_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

function secure(res: Response, csp: string = CSP): void {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function rateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; since: number }>();
  /** 当前窗口还要多久才重置（毫秒，至少 1000，供 Retry-After / retryAfterMs 用） */
  const retryMs = (key: string): number => {
    const h = hits.get(key);
    return h ? Math.max(1000, h.since + windowMs - Date.now()) : 1000;
  };
  const check = (key: string): boolean => {
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
  return Object.assign(check, { retryMs });
}

export interface TownHttpOptions {
  heartbeatMs?: number;
  requestsPerMinute?: number;
  /** 同一 IP 同时开着的事件流上限（旁观流、居民流各算各的），默认 8 */
  maxStreamsPerIp?: number;
  /** WebSocket 的参数（测试里缩短超时用） */
  ws?: TownWsOptions;
  /** 三维客户端的导出目录（town.clientDir）；不给或目录不存在时 /town/3d/ 返回 404 */
  clientDir?: string | null;
}

/** mountTown 的返回值：调用即关闭所有长连接；还要把 attach 挂到 HTTP 服务器上才有 /town/ws。 */
export type TownMount = (() => void) & { attach(server: HttpServer): void };

export function mountTown(app: Express, w: WorldService, log: (msg: string) => void, opts: TownHttpOptions = {}): TownMount {
  const wsHub = createTownWs(w, log, { maxPerIp: opts.maxStreamsPerIp ?? 8, ...(opts.ws ?? {}) });
  const allow = rateLimiter(opts.requestsPerMinute ?? 240);
  const allowAuth = rateLimiter(20);
  const pingMs = opts.heartbeatMs ?? 20_000;
  const closers = new Set<() => void>();
  /** 每个登录会话打开的居民流：会话撤销（登出）或过期时一起关掉，不能让已失效的会话继续收私有事件 */
  const streamsOfToken = new Map<string, Set<() => void>>();
  let residentStreams = 0;
  let publicStreams = 0;
  const perResident = new Map<string, number>();
  const maxPerIp = opts.maxStreamsPerIp ?? 8;
  const perIpPublic = new Map<string, number>();
  const perIpResident = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, d: number) => {
    const n = Math.max(0, (m.get(k) ?? 0) + d);
    if (n === 0) m.delete(k);
    else m.set(k, n);
  };
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
      if (i > 0 && part.slice(0, i).trim() === COOKIE) {
        try {
          return decodeURIComponent(part.slice(i + 1).trim());
        } catch {
          return null; // 坏掉的 Cookie 等于没登录，不是服务器错误
        }
      }
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
        const retryAfterMs = allow.retryMs(ipOf(req));
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        res.status(429).json({ ok: false, error: 'rate_limited', message: '请求太频繁，请稍后再试。', retryAfterMs });
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
        if (host !== expected) throw new WorldError('bad_request', '跨站请求被拒绝。');
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
  // ── 三维客户端（静态托管导出目录）──
  // 必须排在 /town/:file 之前，免得 "3d" 被当成文件名吞掉。
  const sameOriginConnect = (req: Request): string[] => {
    const out = new Set<string>();
    const add = (host: string | undefined, https: boolean) => {
      if (!host || !SAFE_HOST.test(host)) return;
      out.add(`${https ? 'wss' : 'ws'}://${host.toLowerCase()}`);
    };
    // 请求自己的主机（和 ws.ts 的同源判断一致：先看 X-Forwarded-Host）；Host 头不可信，必须过格式校验
    const host = req.header('x-forwarded-host')?.split(',')[0]?.trim() || req.header('host');
    add(host, isHttps(req));
    if (w.publicUrl) {
      try {
        const u = new URL(w.publicUrl);
        add(u.host, u.protocol === 'https:');
      } catch {
        /* publicUrl 不合法就当没配 */
      }
    }
    return [...out];
  };
  const notFound3d = (req: Request, res: Response, msg = '没有这个文件。') => {
    // 流打开失败时头已按文件设好；404 的纯文本体不能再带着原文件的编码和校验头（浏览器会按 br/gzip 解码出乱码）
    for (const h of ['Content-Encoding', 'ETag', 'Last-Modified', 'Content-Length']) res.removeHeader(h);
    secure(res, csp3d(sameOriginConnect(req)));
    res.status(404).type('text/plain; charset=utf-8').send(msg);
  };
  /** 请求路径 → clientDir 里的真实文件；任何可疑写法都返回 null */
  const resolve3d = (root: string, rawPath: string): string | null => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const segs = decoded === '' ? ['index.html'] : decoded.split('/');
    if (segs.some((s) => s === '' || s.startsWith('.'))) return null;
    const full = resolvePath(root, ...segs);
    if (!full.startsWith(root + sep)) return null;
    return full;
  };
  const acceptsEncoding = (header: string | undefined, enc: string): boolean => {
    if (!header) return false;
    for (const part of header.split(',')) {
      const [name, ...params] = part.trim().split(';');
      if (name!.trim().toLowerCase() !== enc) continue;
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)).find(Boolean);
      return !q || Number(q[1]) > 0;
    }
    return false;
  };
  app.use('/town/3d', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      secure(res, csp3d(sameOriginConnect(req)));
      res.status(405).type('text/plain; charset=utf-8').send('只支持 GET。');
      return;
    }
    const full = req.originalUrl;
    const q = full.indexOf('?');
    const urlPath = q < 0 ? full : full.slice(0, q);
    if (urlPath === '/town/3d') {
      res.redirect(301, `/town/3d/${q < 0 ? '' : full.slice(q)}`);
      return;
    }
    if (!urlPath.startsWith('/town/3d/')) return next();
    const csp = csp3d(sameOriginConnect(req));
    if (!opts.clientDir) return notFound3d(req, res, '三维客户端还没有部署：服务器没有配置 town.clientDir。请先用旧页面 /town/。');
    let root: string;
    try {
      root = realpathSync(resolvePath(opts.clientDir));
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
    } catch {
      return notFound3d(req, res, '三维客户端还没有部署：town.clientDir 指向的目录不存在。请先用旧页面 /town/。');
    }
    const target = resolve3d(root, urlPath.slice('/town/3d/'.length));
    const name = target?.split(sep).pop() ?? '';
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const type = TYPES_3D[ext];
    if (!target || !type) return notFound3d(req, res);
    // 符号链接逃逸：真实路径必须还在 clientDir 的真实路径之内（预压缩文件同理）
    const inside = (p: string): string | null => {
      try {
        const real = realpathSync(p);
        return real.startsWith(root + sep) && statSync(real).isFile() ? real : null;
      } catch {
        return null;
      }
    };
    const plain = inside(target);
    if (!plain) return notFound3d(req, res);
    let file = plain;
    let encoding: 'br' | 'gzip' | null = null;
    const ae = req.header('accept-encoding');
    for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
      if (!acceptsEncoding(ae, enc)) continue;
      const pre = inside(target + suffix);
      if (pre) {
        file = pre;
        encoding = enc;
        break;
      }
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      return notFound3d(req, res);
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}${encoding ? `-${encoding}` : ''}"`;
    secure(res, csp);
    res.setHeader('Content-Type', type);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    if (encoding) res.setHeader('Content-Encoding', encoding);
    const inm = req.header('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*')) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Length', String(st.size));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    // 大文件（wasm 约 40 MB）用流发送，不进内存缓存
    const stream = createReadStream(file);
    stream.on('error', (e) => {
      log(`[town] 静态文件读取失败：${e.message}`);
      if (!res.headersSent) notFound3d(req, res);
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
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
    let wanted = '';
    try {
      wanted = decodeURIComponent(m[1]!);
    } catch {
      /* 无法解码的世界编号当作不存在 */
    }
    if (wanted !== w.worldId) {
      secure(res);
      res.status(404).json({ ok: false, error: 'not_available', message: '没有这个世界。' });
      return;
    }
    req.url = `/town/api${m[2] ?? ''}${m[3] ?? ''}`;
    next();
  });

  const parseJson = express.json({ limit: '16kb' });
  /** 请求体过大或不是合法 JSON 时也按统一的错误格式回复（不让 Express 的默认错误页带着堆栈出去）。 */
  const json: express.RequestHandler = (req, res, next) => {
    parseJson(req, res, (err?: unknown) => {
      if (!err) return next();
      const status = Number((err as { status?: unknown }).status);
      secure(res);
      res.setHeader('Cache-Control', 'no-store');
      res.status(status >= 400 && status < 500 ? status : 400).json({ ok: false, error: 'bad_request', message: status === 413 ? '请求体太大了。' : '请求格式不对（需要有效的 JSON）。' });
    });
  };

  // ── 公开 ──
  app.get(
    '/town/api/config',
    api(() => ({
      world: { id: w.worldId, name: w.worldName, timezone: w.params.timezone },
      devLogin: w.devLogin,
      traits: TRAITS,
      interests: INTERESTS.map((i) => ({ id: i.id, name: i.name })),
      limits: { traits: w.params.traitCount, interests: w.params.interestCount, chatMaxChars: w.params.chatMaxChars, letterMaxChars: w.params.letterMaxChars, personReach: w.params.personReach },
      heartbeatMs: w.params.heartbeatIntervalMs,
    })),
  );
  app.get('/town/api/public', api(() => publicView(w)));
  // 地图清单：公开、可缓存。校验值就是 ETag，地图一变（checksum 变）客户端自然取到新的
  let mapBody: { checksum: string; body: string } | null = null;
  app.get(
    '/town/api/map',
    api((req, res) => {
      const m = mapManifest(w);
      if (!mapBody || mapBody.checksum !== m.checksum) mapBody = { checksum: m.checksum, body: JSON.stringify(m) };
      const etag = `"${m.checksum}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=300');
      const inm = req.header('if-none-match');
      if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag || t.trim() === '*')) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(mapBody.body);
    }),
  );
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
      const ip = ipOf(req);
      if (!allowAuth(ip)) throw new WorldError('rate_limited', '尝试太频繁，请稍后再试。', undefined, { retryAfterMs: allowAuth.retryMs(ip) });
      const s = exchangeTicket(w, req.body?.ticket);
      setCookie(req, res, s.token, s.expires_at - w.now());
      return { ok: true, name: s.principal.display_name, hasResident: Boolean(w.residentOfPrincipal(s.principal.principal_id)) };
    }),
  );
  app.post(
    '/town/api/auth/dev',
    json,
    post((req, res) => {
      const ip = ipOf(req);
      if (!allowAuth(ip)) throw new WorldError('rate_limited', '尝试太频繁，请稍后再试。', undefined, { retryAfterMs: allowAuth.retryMs(ip) });
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
      if (token) {
        revokeSession(w, token);
        for (const close of [...(streamsOfToken.get(token) ?? [])]) close();
        wsHub.closeSession(sha256(token));
      }
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
  app.get(
    '/town/api/scene',
    api((req) => {
      const { r } = residentOf(req);
      return sceneView(w, r, w.now());
    }),
  );
  app.post(
    '/town/api/nav/renew',
    json,
    post((req) => {
      const p = principalOf(req);
      const b = req.body ?? {};
      return renewNavigation(w, { principalId: p.principal_id, clientId: clientIdOf(req) }, { navigationId: b.navigationId, revision: b.revision });
    }),
  );
  app.post(
    '/town/api/ws-ticket',
    json,
    post((req) => {
      const { p } = residentOf(req);
      // 票据记着取票时的登录会话：会话过期或登出，用它连上的 WebSocket 也跟着断
      const token = tokenOf(req);
      const session = token ? { key: sha256(token), valid: () => sessionPrincipal(w, token)?.principal_id === p.principal_id } : undefined;
      return { ok: true, ...wsHub.issueTicket(p.principal_id, clientIdOf(req), session) };
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
      // before：上一页返回的 next（不透明游标）；旧客户端传的序号数字也认
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null;
      return chatHistory(w, r.resident_id, before, Number(req.query.limit ?? 50) || 50);
    }),
  );
  // 全镇公屏的历史（已认证的居民，不要求在场；匿名读不到，也没有任何公开出口带它）。
  // 不带游标：最近一页（默认 50 条）；before=<消息 id>：更早的一页；after=<消息 id 或 cursor>：追新。
  app.get(
    '/town/api/town-chat',
    api((req) => {
      const { r } = residentOf(req);
      const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 80) : null);
      return townChatPage(w, r.resident_id, { before: str(req.query.before), after: str(req.query.after), limit: Number(req.query.limit) || undefined });
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
      // ?with=<居民id>[&before=<next>&limit=]：翻看与这位居民的共同记忆
      if (typeof req.query.with === 'string' && req.query.with) {
        return relationMemories(w, r.resident_id, req.query.with, typeof req.query.before === 'string' ? req.query.before : null, Number(req.query.limit) || undefined);
      }
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
  const openStream = (req: Request, res: Response, residentId: string | null, token: string | null = null) => {
    const ip = ipOf(req);
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
      if (closed) return;
      // 会话过期或被撤销：连接不再有效
      if (token && !sessionPrincipal(w, token)) {
        close();
        return;
      }
      res.write(': ping\n\n');
    }, pingMs);
    timer.unref();
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const off of offs) off();
      closers.delete(close);
      if (token) {
        const set = streamsOfToken.get(token);
        set?.delete(close);
        if (set && set.size === 0) streamsOfToken.delete(token);
      }
      if (residentId) {
        residentStreams--;
        perResident.set(residentId, Math.max(0, (perResident.get(residentId) ?? 1) - 1));
        bump(perIpResident, ip, -1);
      } else {
        publicStreams--;
        bump(perIpPublic, ip, -1);
      }
      res.end();
    }
    closers.add(close);
    if (token) {
      const set = streamsOfToken.get(token) ?? new Set<() => void>();
      set.add(close);
      streamsOfToken.set(token, set);
    }
    req.on('close', close);
    // hello 里只回显验证过的游标；客户端带来的坏游标由随后的 resync 事件处理，不原样回显
    const usable = (kind: 'r' | 'p', scope: string, key: string, c: string | undefined) => {
      if (!c) return false;
      const n = w.decodeCursor(kind, scope, c);
      if (n === null) return false;
      const head = w.streamHead(key);
      return n <= head.highWater && n >= head.retainedFrom - 1;
    };
    const goodCursor = residentId && usable('r', residentId, `r:${residentId}`, cursor) ? cursor : residentId ? w.cursorOf(residentId) : undefined;
    const goodPcursor = usable('p', 'public', `pub:${w.worldId}`, pcursor) ? pcursor : w.publicCursor();
    send('hello', { cursor: goodCursor, pcursor: goodPcursor, time: w.now() });
    pump();
  };

  app.get('/town/api/public/events', (req, res) => {
    secure(res);
    const ip = ipOf(req);
    if (!allow(ip) || publicStreams >= w.params.maxPublicStreams || (perIpPublic.get(ip) ?? 0) >= maxPerIp) {
      res.setHeader('Retry-After', '1');
      res.status(429).json({ ok: false, error: 'rate_limited', message: '连接太多，请稍后再试。', retryAfterMs: 1000 });
      return;
    }
    publicStreams++;
    bump(perIpPublic, ip, 1);
    openStream(req, res, null);
  });

  app.get('/town/api/events', (req, res) => {
    secure(res);
    try {
      const { r } = residentOf(req);
      const ip = ipOf(req);
      if (!allow(ip) || residentStreams >= w.params.maxResidentStreams || (perResident.get(r.resident_id) ?? 0) >= 4 || (perIpResident.get(ip) ?? 0) >= maxPerIp) {
        res.setHeader('Retry-After', '1');
        res.status(429).json({ ok: false, error: 'rate_limited', message: '连接太多，请稍后再试。', retryAfterMs: 1000 });
        return;
      }
      residentStreams++;
      bump(perIpResident, ip, 1);
      perResident.set(r.resident_id, (perResident.get(r.resident_id) ?? 0) + 1);
      openStream(req, res, r.resident_id, tokenOf(req));
    } catch (e) {
      fail(res, e);
    }
  });

  // 没有这个接口：统一的 JSON 404（放在所有 /town/api 路由之后）
  app.use('/town/api', (_req, res) => {
    secure(res);
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ ok: false, error: 'not_available', message: '没有这个接口。' });
  });

  const closeAll = () => {
    for (const close of [...closers]) close();
    wsHub.close();
  };
  return Object.assign(closeAll, { attach: (server: HttpServer) => wsHub.attach(server) });
}
