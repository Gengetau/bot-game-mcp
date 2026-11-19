/**
 * 东京城市世界的 HTTP 接口。
 *
 *  公开（不用登录，只有公开投影）：
 *   GET  /city/                          文字版的城市页面（服务器直接渲染，没有脚本）
 *   GET  /city/api/public                公开视图（JSON）
 *
 *  桥接（只给小屋内核用；`Authorization: Bearer <city.bridgeKey>`；没配密钥时整组接口不存在）。前缀 /city/bridge/v1：
 *   GET  /catalog                        目录版本、映射表、地点和票价（内核做出门前的检查用）
 *   POST /visits/prepare                 建待接收记录
 *   POST /visits/:id/commit              激活随身钱包和物品，动作权交给城市
 *   POST /visits/:id/abort               取消一次还没交接的访问
 *   GET  /visits/:id                     状态和全部交接回执
 *   POST /visits/:id/return-request      内核要求她回家
 *   POST /visits/:id/release             内核已应用结算，结束访问
 *   GET  /outbox?after=&limit=&wait_ms=  按 seq 拉取 outbox（wait_ms 是长轮询）
 *   GET  /weather                        三片的天气快照
 *   GET  /reconcile                      最近的对账报告
 *   代行（都要带当前的 domain_epoch）：
 *   POST /visits/:id/act                 {request_id, domain_epoch, action} 等同 world_act
 *   GET  /visits/:id/view?domain_epoch=  等同 get_my_view
 *   GET  /visits/:id/wait?domain_epoch=&cursor=&wait_ms=   等同 world_wait
 *
 * 引擎不主动调内核：这里只有被调用的接口。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { cityCommand, requireActingVisit, resolvePendingOrder, visitAct } from './actions.js';
import {
  CITY_CATALOG_VERSION,
  FARE_RULE_VERSION,
  HOUSE_ENTRANCE,
  ITEM_TYPES,
  TRANSIT_EDGES,
  goodsForPlace,
  homeward,
  isCarryHome,
  isStorable,
  publicPlaces,
  station,
} from './catalog.js';
import { CITY_HTTP_STATUS, CityError, cityBadRequest } from './errors.js';
import { MAPPINGS } from './mappings.js';
import { latestReconcile } from './reconcile.js';
import {
  ENTRY_PLACES,
  cityHeartbeat,
  citySessionAuth,
  claimCityControl,
  devLoginCitySession,
  enterCity,
  exchangeCityTicket,
  leaveCity,
  normalizeClientId,
  revokeCitySession,
  touchPresence,
  type CityWebSession,
} from './residents.js';
import type { CityService } from './service.js';
import { stampBookView } from './stamps.js';
import { SELF_VIEW_MAX_BYTES, chatHistory, publicCityView, routePreview, selfView } from './views.js';
import { BRIDGE_PROTOCOL, abortVisit, commitVisit, describeVisit, prepareVisit, readOutbox, releaseVisit, requestReturn } from './visits.js';
import { allWeather } from './weather.js';

export interface CityHttpOptions {
  /** 桥接密钥。不给 = 不挂桥接接口 */
  bridgeKey?: string | undefined;
  /** 管理员密钥列表（用于 /city/api/admin/* 运维入口） */
  adminKeys?: readonly string[] | undefined;
  /** 人类网页端静态文件目录（默认 packages/engine/city） */
  webDir?: string | undefined;
  requestsPerMinute?: number;
  authRequestsPerMinute?: number;
}

const MAX_WAIT_MS = 50_000;
const SESSION_COOKIE = 'city_session';
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../city', import.meta.url));
const PLAY_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const PLAY_ASSETS: Record<string, { file: string; mime: string }> = {
  'index.html': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  'style.css': { file: 'style.css', mime: 'text/css; charset=utf-8' },
  'app.css': { file: 'style.css', mime: 'text/css; charset=utf-8' },
  'app.js': { file: 'app.js', mime: 'application/javascript; charset=utf-8' },
  'icon.svg': { file: 'icon.svg', mime: 'image/svg+xml' },
};

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

function safeEqualText(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]!
    .trim()
    .toLowerCase();
  return proto === 'https';
}

function writeSessionCookie(req: Request, res: Response, token: string, maxAgeSeconds: number): void {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/city; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}${secure}`,
  );
}

function clearSessionCookie(req: Request, res: Response): void {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/city; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function requireJsonAndSameOrigin(req: Request): void {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    throw cityBadRequest('请求头需要 Content-Type: application/json。', 'json_required');
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string;
    try {
      originHost = new URL(String(origin)).host.toLowerCase();
    } catch {
      throw new CityError('FORBIDDEN', 'Origin 请求头不合法。', 'cross_origin');
    }
    const expectedHost = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
      .split(',')[0]!
      .trim()
      .toLowerCase();
    if (!expectedHost || originHost !== expectedHost) {
      throw new CityError('FORBIDDEN', '拒绝跨站请求。', 'cross_origin');
    }
  }
}

function requireSession(c: CityService, req: Request, opts: { csrf?: boolean } = {}): { rawToken: string; session: CityWebSession } {
  const rawToken = readCookie(req, SESSION_COOKIE);
  const session = citySessionAuth(c, rawToken);
  if (!rawToken || !session) {
    throw new CityError('UNAUTHENTICATED', '登录会话不存在或已过期，请重新打开登录链接。', 'session_expired');
  }
  if (opts.csrf) {
    const got = String(req.headers['x-city-csrf'] ?? '').trim();
    if (!safeEqualText(got, session.csrfToken)) {
      throw new CityError('FORBIDDEN', 'CSRF 校验未通过，请刷新会话后重试。', 'csrf_invalid');
    }
  }
  return { rawToken, session };
}

function rateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now(); // 只是 HTTP 层的防刷窗口，不是世界时间
    const h = hits.get(key);
    if (!h || h.reset <= now) {
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      hits.set(key, { n: 1, reset: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}

function sendError(res: Response, e: unknown, log: (msg: string) => void): void {
  if (e instanceof CityError) {
    if (e.code === 'RATE_LIMITED' && typeof e.data?.retryAfterMs === 'number') res.setHeader('Retry-After', String(Math.ceil(e.data.retryAfterMs / 1000)));
    res.status(CITY_HTTP_STATUS[e.code]).json(e.toJSON());
    return;
  }
  log(`[city] 接口出错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  res.status(500).json({ error: 'INTERNAL', message: '服务器内部错误。用同一个请求号稍后重试。' });
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 文字版的城市页面。所有内容都来自公开投影；居民起的名字全部转义。 */
export function renderCityPage(c: CityService): string {
  const v = publicCityView(c) as any;
  const clock = (ms: number): string => c.clock(ms);
  const statusText: Record<string, string> = { ok: '实时', stale: '稍旧（沿用上一次）', fallback: '合成（没取到实时数据）' };
  const areas = (v.areas as any[])
    .map((a) => {
      const w = a.weather;
      const weather = w
        ? `<p class="w">天气：${esc(w.text)}，${esc(w.temp_c)}°C${w.rain ? '，正在下雨' : ''}。<small>来源：${w.source === 'open-meteo' ? 'Open-Meteo' : '合成天气'}，${esc(statusText[w.status] ?? w.status)}，${esc(clock(w.observed_at_ms))} 的数据</small></p>`
        : '';
      const places = (a.places as any[])
        .map((p) => {
          const people = (p.here as any[]).map((r) => esc(r.name)).join('、');
          const goods = (p.goods as any[]).map((g) => `${esc(g.name)} ¥${esc(g.price_yen)}`).join('，');
          const state = p.open ? '' : p.closed_reason === 'rain' ? '（下雨，暂不开放）' : '（现在不营业）';
          return `<li><b>${esc(p.name)}</b>${state} <small>${esc(p.hours)}${p.fictional ? ' · 虚构店铺' : ''}</small><br>${esc(p.blurb)}${goods ? `<br><small>${goods}</small>` : ''}${people ? `<br>这里有：${people}` : ''}</li>`;
        })
        .join('');
      return `<section><h2>${esc(a.name)} <small>${esc(a.ward)}</small></h2><p>${esc(a.blurb)}</p>${weather}<ul>${places}</ul></section>`;
    })
    .join('');
  const events = (v.events_today as any[]).map((e) => `<li><b>${esc(e.title)}</b> <small>${esc(clock(e.starts_at_ms))}–${esc(clock(e.ends_at_ms))}</small><br>${esc(e.body)}</li>`).join('');
  const edges = (v.transit.edges as any[]).map((e) => `<li>${esc(e.from)} ↔ ${esc(e.to)}（${esc(e.line)}）：约 ${esc(e.minutes)} 分钟，¥${esc(e.fare_yen)}</li>`).join('');
  const sources = (v.sources as any[]).map((s) => `<li>${esc(s.title)}：${esc(s.note)}${s.license ? `<br><small>许可：${esc(s.license)}</small>` : ''}</li>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>东京 · 城市页面</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1rem;color:#222;background:#fbfaf7}h1{font-size:1.5rem}h2{font-size:1.2rem;border-bottom:1px solid #ddd;padding-bottom:.2rem}small{color:#777}li{margin:.5rem 0}.w{background:#f1efe8;padding:.4rem .6rem;border-radius:.3rem}@media(prefers-color-scheme:dark){body{color:#ddd;background:#1c1b19}.w{background:#2a2925}h2{border-color:#444}small{color:#999}}</style></head>
<body><h1>东京</h1><p>现在是 ${esc(v.local_time)}（${esc(v.timezone)}）。路上有 ${esc(v.in_transit)} 人。</p>
${events ? `<section><h2>今天</h2><ul>${events}</ul></section>` : ''}
${areas}
<section><h2>电车</h2><p><small>${esc(v.transit.note)}（规则版本 ${esc(v.transit.rule_version)}）</small></p><ul>${edges}</ul></section>
<section><h2>来源</h2><ul>${sources}</ul><p><small>天气数据：<a href="https://open-meteo.com/">Open-Meteo</a>（CC BY 4.0）。目录版本 ${esc(v.city_catalog_version)}。</small></p></section>
</body></html>`;
}

export function mountCity(app: Express, c: CityService, log: (msg: string) => void, opts: CityHttpOptions = {}): () => void {
  const allow = rateLimiter(opts.requestsPerMinute ?? 240);
  const allowAuth = rateLimiter(opts.authRequestsPerMinute ?? 20);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const openStreams = new Set<() => void>();
  const streamCountByResident = new Map<string, number>();
  const streamCountByIp = new Map<string, number>();

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (!allow(req.ip ?? 'unknown')) {
      res.setHeader('Retry-After', '10');
      res.status(429).json({ error: 'RATE_LIMITED', message: '请求太密了。', retryAfterMs: 10_000 });
      return;
    }
    next();
  };

  const jsonObj = (req: Request): Record<string, unknown> => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw cityBadRequest('请求体要是一个 JSON 对象。');
    }
    return req.body as Record<string, unknown>;
  };
  const parseOffset = (raw: unknown): number => {
    if (raw === undefined || raw === null || raw === '') return 0;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > 10_000) {
      throw cityBadRequest('分页偏移量必须是非负整数。', 'bad_offset');
    }
    return n;
  };

  app.get(['/city', '/city/'], guard, (_req, res) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(renderCityPage(c));
    } catch (e) {
      sendError(res, e, log);
    }
  });

  // ───────────────────────── 人类文字网页端（/city/play/） ─────────────────────────
  app.get(['/city/play', '/city/play/', '/city/play/:asset'], guard, (req, res) => {
    const rawAsset = req.params.asset;
    if (!rawAsset && !req.path.endsWith('/')) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      res.redirect(302, `/city/play/${qs}`);
      return;
    }
    const name = typeof rawAsset === 'string' && rawAsset ? rawAsset : 'index.html';
    const spec = PLAY_ASSETS[name];
    if (!spec) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    const filePath = join(webDir, spec.file);
    if (!existsSync(filePath)) {
      res.status(404).type('text/plain').send('City web client not found');
      return;
    }
    res.setHeader('Content-Type', spec.mime);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', PLAY_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.send(readFileSync(filePath));
  });

  // ───────────────────────── 公开与居民 REST / SSE（/city/api/*） ─────────────────────────
  const api = express.Router();
  api.use(guard);
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  api.use(express.json({ limit: '32kb' }));

  const apiSync = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      sendError(res, e, log);
    }
  };

  api.get('/public', apiSync(() => publicCityView(c)));
  api.get(
    '/config',
    apiSync(() => ({
      world: { id: c.worldId, name: c.worldName, timezone: c.params.timezone },
      catalog_version: CITY_CATALOG_VERSION,
      fare_rule_version: FARE_RULE_VERSION,
      dev_login: c.devLogin,
      entry_places: [...ENTRY_PLACES],
      limits: { chat_max_chars: c.params.chatMaxChars, name_max_chars: 16, bio_max_chars: 80 },
      heartbeat_ms: Math.max(10_000, Math.min(60_000, Math.floor(c.params.presenceLeaseMs / 3))),
    })),
  );
  api.get(
    '/route',
    apiSync((req) => {
      const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
      const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
      if (!from || !to) throw cityBadRequest('需要提供 from 和 to 地点编号。', 'bad_route_params');
      return routePreview(c, from, to);
    }),
  );

  api.post(
    '/auth/exchange',
    apiSync((req, res) => {
      if (!allowAuth(`ex:${req.ip ?? 'unknown'}`)) {
        throw new CityError('RATE_LIMITED', '登录尝试太频繁，请稍后再试。', 'auth', { retryAfterMs: 15_000 });
      }
      requireJsonAndSameOrigin(req);
      const b = jsonObj(req);
      const out = exchangeCityTicket(c, b.ticket);
      writeSessionCookie(req, res, out.sessionToken, Math.floor(c.params.sessionTtlMs / 1000));
      return {
        ok: true,
        csrf_token: out.csrfToken,
        expires_at_ms: out.expiresAtMs,
        principal: { display_name: out.principal.display_name, kind: out.principal.kind },
        resident: out.resident,
      };
    }),
  );

  api.post(
    '/auth/dev',
    apiSync((req, res) => {
      if (!allowAuth(`dev:${req.ip ?? 'unknown'}`)) {
        throw new CityError('RATE_LIMITED', '登录尝试太频繁，请稍后再试。', 'auth', { retryAfterMs: 15_000 });
      }
      requireJsonAndSameOrigin(req);
      const b = jsonObj(req);
      const out = devLoginCitySession(c, b.name);
      writeSessionCookie(req, res, out.sessionToken, Math.floor(c.params.sessionTtlMs / 1000));
      return {
        ok: true,
        csrf_token: out.csrfToken,
        expires_at_ms: out.expiresAtMs,
        principal: { display_name: out.principal.display_name, kind: out.principal.kind },
        resident: out.resident,
      };
    }),
  );

  api.get(
    '/session',
    apiSync((req) => {
      const sess = citySessionAuth(c, readCookie(req, SESSION_COOKIE));
      if (!sess) return { logged_in: false };
      return {
        logged_in: true,
        csrf_token: sess.csrfToken,
        expires_at_ms: sess.expiresAtMs,
        principal: { display_name: sess.principal.display_name, kind: sess.principal.kind },
        resident: sess.resident ? { id: sess.resident.resident_id, name: sess.resident.name, in_city: sess.resident.in_city === 1 } : null,
      };
    }),
  );

  api.post(
    '/auth/logout',
    apiSync((req, res) => {
      requireJsonAndSameOrigin(req);
      const { rawToken } = requireSession(c, req, { csrf: true });
      revokeCitySession(c, rawToken);
      clearSessionCookie(req, res);
      return { ok: true };
    }),
  );

  api.post(
    '/enter',
    apiSync((req) => {
      requireJsonAndSameOrigin(req);
      const { session } = requireSession(c, req, { csrf: true });
      const b = jsonObj(req);
      const clientId = normalizeClientId('web', b.client_id ?? req.headers['x-city-client']);
      const out = enterCity(c, session.principal, {
        name: b.name,
        bio: b.bio,
        entry: b.entry,
        clientId,
        claim: Boolean(b.claim),
      });
      return {
        ok: true,
        created: out.created,
        resident_id: out.resident.resident_id,
        ...(out.granted_yen ? { granted_yen: out.granted_yen } : {}),
        control: out.control,
        view: selfView(c, out.resident, { clientId }),
      };
    }),
  );

  api.get(
    '/me',
    apiSync((req) => {
      const { session } = requireSession(c, req);
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      const rawClient = req.query.client_id ?? req.headers['x-city-client'];
      const clientId = rawClient !== undefined ? normalizeClientId('web', rawClient) : undefined;
      const itemOffset = parseOffset(req.query.item_offset);
      const lockerOffset = parseOffset(req.query.locker_offset);
      touchPresence(c, session.resident.resident_id);
      return selfView(c, c.mustResident(session.resident.resident_id), {
        ...(clientId ? { clientId } : {}),
        itemOffset,
        lockerOffset,
      });
    }),
  );

  api.post(
    '/act',
    apiSync((req) => {
      requireJsonAndSameOrigin(req);
      const { session } = requireSession(c, req, { csrf: true });
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      const b = jsonObj(req);
      const clientId = normalizeClientId('web', b.client_id ?? req.headers['x-city-client']);
      const itemOffset = parseOffset(b.item_offset);
      const lockerOffset = parseOffset(b.locker_offset);
      const out = cityCommand(c, session.resident.resident_id, b.request_id, b.action, { clientId });
      return {
        ...out,
        view: selfView(c, c.mustResident(session.resident.resident_id), { clientId, itemOffset, lockerOffset }),
      };
    }),
  );

  api.post(
    '/heartbeat',
    apiSync((req) => {
      requireJsonAndSameOrigin(req);
      const { session } = requireSession(c, req, { csrf: true });
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      const b = jsonObj(req);
      const rawClient = b.client_id ?? req.headers['x-city-client'];
      const clientId = rawClient !== undefined ? normalizeClientId('web', rawClient) : undefined;
      return cityHeartbeat(c, session.resident.resident_id, clientId);
    }),
  );

  api.post(
    ['/claim', '/claim-control'],
    apiSync((req) => {
      requireJsonAndSameOrigin(req);
      const { session } = requireSession(c, req, { csrf: true });
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      const b = jsonObj(req);
      const clientId = normalizeClientId('web', b.client_id ?? req.headers['x-city-client']);
      const itemOffset = parseOffset(b.item_offset);
      const lockerOffset = parseOffset(b.locker_offset);
      const out = claimCityControl(c, session.resident.resident_id, clientId);
      return {
        ...out,
        view: selfView(c, c.mustResident(session.resident.resident_id), { clientId, itemOffset, lockerOffset }),
      };
    }),
  );

  api.post(
    '/leave',
    apiSync((req) => {
      requireJsonAndSameOrigin(req);
      const { session } = requireSession(c, req, { csrf: true });
      if (session.resident) leaveCity(c, session.resident.resident_id);
      return { ok: true };
    }),
  );

  api.get(
    '/history',
    apiSync((req) => {
      const { session } = requireSession(c, req);
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      let before: number | null = null;
      if (req.query.before !== undefined && req.query.before !== '') {
        const n = Number(req.query.before);
        if (!Number.isSafeInteger(n) || n <= 0) throw cityBadRequest('before 要是正整数。', 'bad_before');
        before = n;
      }
      const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 30) || 30));
      return chatHistory(c, session.resident.resident_id, before, limit);
    }),
  );

  api.get(
    '/stamps',
    apiSync((req) => {
      const { session } = requireSession(c, req);
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      return stampBookView(c, session.resident.resident_id);
    }),
  );

  api.get('/stream', (req, res) => {
    try {
      const { rawToken, session } = requireSession(c, req);
      if (!session.resident) throw new CityError('UNAUTHENTICATED', '还没有进入东京，请先起名入城。', 'no_resident');
      const residentId = session.resident.resident_id;
      const ip = req.ip ?? 'unknown';
      const resCount = streamCountByResident.get(residentId) ?? 0;
      const ipCount = streamCountByIp.get(ip) ?? 0;
      if (resCount >= 6 || ipCount >= 20) {
        throw new CityError('RATE_LIMITED', '实时连接数已达上限，请关闭多余窗口。', 'too_many_streams', { retryAfterMs: 5000 });
      }
      if (req.query.client_id !== undefined) normalizeClientId('web', req.query.client_id);

      streamCountByResident.set(residentId, resCount + 1);
      streamCountByIp.set(ip, ipCount + 1);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let closed = false;
      let privCursor =
        typeof req.query.cursor === 'string' && req.query.cursor
          ? req.query.cursor
          : req.header('last-event-id') || c.cursorOf(residentId);
      let pubCursor = typeof req.query.pcursor === 'string' && req.query.pcursor ? req.query.pcursor : c.publicCursor();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(pingTimer);
        offRes();
        offPub();
        offRevoke();
        openStreams.delete(forceClose);
        const nextRes = (streamCountByResident.get(residentId) ?? 1) - 1;
        if (nextRes <= 0) streamCountByResident.delete(residentId);
        else streamCountByResident.set(residentId, nextRes);
        const nextIp = (streamCountByIp.get(ip) ?? 1) - 1;
        if (nextIp <= 0) streamCountByIp.delete(ip);
        else streamCountByIp.set(ip, nextIp);
      };

      const forceClose = () => {
        cleanup();
        if (!res.writableEnded && !res.destroyed) res.end();
      };

      const writeSse = (event: string, data: unknown, id?: string): boolean => {
        if (closed || res.writableEnded || res.destroyed) return false;
        if (res.writableLength > 256 * 1024) {
          cleanup();
          res.destroy();
          return false;
        }
        if (id) res.write(`id: ${id}\n`);
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      };

      const onRevoked = () => {
        writeSse('revoked', { reason: 'session_revoked' });
        forceClose();
      };

      const flush = () => {
        if (closed) return;
        if (!citySessionAuth(c, rawToken)) {
          onRevoked();
          return;
        }
        try {
          for (;;) {
            const priv = c.readResidentEvents(residentId, privCursor, 50);
            if (priv.resync) {
              privCursor = priv.cursor;
              if (!writeSse('resync', { stream: 'private', cursor: priv.cursor })) return;
              break;
            }
            for (const ev of priv.events) {
              if (!writeSse('private', { id: ev.id, type: ev.type, at_ms: ev.at, ...ev.data }, ev.id)) return;
            }
            privCursor = priv.cursor;
            if (!priv.more) break;
          }
          for (;;) {
            const pub = c.readPublicEvents(pubCursor, 50);
            if (pub.resync) {
              pubCursor = pub.cursor;
              if (!writeSse('resync', { stream: 'public', cursor: pub.cursor })) return;
              break;
            }
            for (const ev of pub.events) {
              if (!writeSse('public', { id: ev.id, type: ev.type, at_ms: ev.at, ...ev.data })) return;
            }
            pubCursor = pub.cursor;
            if (!pub.more) break;
          }
        } catch {
          forceClose();
        }
      };

      const offRes = c.onResidentBump(residentId, flush);
      const offPub = c.onPublicBump(flush);
      const offRevoke = c.onSessionRevoked(session.tokenHash, onRevoked);
      const pingTimer = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) {
          cleanup();
          return;
        }
        if (!citySessionAuth(c, rawToken)) {
          onRevoked();
          return;
        }
        res.write(': ping\n\n');
      }, 25_000);
      pingTimer.unref();
      openStreams.add(forceClose);
      res.on('close', cleanup);

      res.write(': connected\n\n');
      flush();
    } catch (e) {
      sendError(res, e, log);
    }
  });

  const adminDigests = (opts.adminKeys ?? []).map((k) => digest(k));
  api.post(
    '/admin/orders/:id/resolve',
    apiSync((req) => {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
      if (!m || adminDigests.length === 0) {
        throw new CityError('UNAUTHENTICATED', '管理接口需要管理员 Bearer 密钥。', 'admin_auth_required');
      }
      const got = digest(m[1]!.trim());
      if (!adminDigests.some((want) => timingSafeEqual(got, want))) {
        throw new CityError('FORBIDDEN', '管理员密钥无效。', 'admin_forbidden');
      }
      const b = jsonObj(req);
      const outcome = b.outcome;
      if (outcome !== 'completed' && outcome !== 'failed') {
        throw cityBadRequest('outcome 必须是 completed 或 failed。', 'bad_outcome');
      }
      const out = resolvePendingOrder(c, String(req.params.id ?? ''), outcome);
      return { ok: true, ...out };
    }),
  );

  api.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: '没有这个接口。' });
  });
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    res.status(400).json({ error: 'BAD_REQUEST', message: err instanceof Error && /too large/i.test(err.message) ? '请求体太大。' : '请求体不是合法的 JSON。' });
  });
  app.use('/city/api', api);

  // ───────────────────────── 桥接 ─────────────────────────
  const closeAll = () => {
    for (const fn of [...openStreams]) fn();
    openStreams.clear();
  };
  const key = opts.bridgeKey;
  if (!key) return closeAll;
  const want = digest(key);
  const bridge = express.Router();
  // 桥接是服务器到服务器的调用，频率上限放宽
  const allowBridge = rateLimiter(1200);
  bridge.use((req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(digest(m[1]!.trim()), want)) {
      res.status(401).json({ error: 'UNAUTHENTICATED', message: '桥接接口需要密钥。' });
      return;
    }
    if (!allowBridge('bridge')) {
      res.setHeader('Retry-After', '5');
      res.status(429).json({ error: 'RATE_LIMITED', message: '请求太密了。', retryAfterMs: 5000 });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  bridge.use(express.json({ limit: '64kb' }));

  const body = (req: Request): Record<string, unknown> => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw cityBadRequest('请求体要是一个 JSON 对象。');
    return req.body as Record<string, unknown>;
  };
  const visitId = (req: Request): string => String(req.params.id ?? '');
  const sync = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.json(fn(req));
    } catch (e) {
      sendError(res, e, log);
    }
  };
  const waitMs = (req: Request): number => Math.max(0, Math.min(MAX_WAIT_MS, Number(req.query.wait_ms ?? 0) || 0));
  const abortOnClose = (req: Request, res: Response): AbortSignal => {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    void req;
    return ac.signal;
  };

  bridge.get(
    '/catalog',
    sync(() => ({
      protocol: BRIDGE_PROTOCOL,
      city_catalog_version: CITY_CATALOG_VERSION,
      fare_rule_version: FARE_RULE_VERSION,
      mappings: MAPPINGS,
      handover_node: HOUSE_ENTRANCE,
      item_types: ITEM_TYPES.map((i) => ({
        type: i.type,
        name: i.name,
        kind: i.kind,
        carry_home: isCarryHome(i.type),
        storable: isStorable(i.type),
      })),
      places: publicPlaces().map((p) => ({ id: p.id, name: p.name, area: p.area, type: p.type, hours: p.hours, rain: p.rain, homeward: { fare_yen: homeward(p.id).fareYen, minutes: homeward(p.id).minutes }, goods: goodsForPlace(p, c.today(c.now())).map((g) => ({ sku: g.sku, type: g.type, name: g.name, price_yen: g.priceYen })) })),
      transit: TRANSIT_EDGES.map((e) => ({
        from: station(e.a)!.placeId,
        to: station(e.b)!.placeId,
        line: e.line,
        ...(e.operator ? { operator: e.operator } : {}),
        ...(e.transportKind ? { transport_kind: e.transportKind } : {}),
        ...(e.distanceKm !== undefined ? { distance_km: e.distanceKm } : {}),
        minutes: e.minutes,
        fare_yen: e.fareYen,
        source: 'simulated',
      })),
    })),
  );
  bridge.post('/visits/prepare', sync((req) => prepareVisit(c, body(req))));
  bridge.post('/visits/:id/commit', sync((req) => commitVisit(c, visitId(req), body(req))));
  bridge.post('/visits/:id/abort', sync((req) => abortVisit(c, visitId(req), body(req))));
  bridge.post('/visits/:id/return-request', sync((req) => requestReturn(c, visitId(req), body(req))));
  bridge.post('/visits/:id/release', sync((req) => releaseVisit(c, visitId(req), body(req))));
  bridge.get('/visits/:id', sync((req) => describeVisit(c, visitId(req))));
  bridge.get('/weather', sync(() => ({ at_ms: c.now(), attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)', areas: allWeather(c) })));
  bridge.get('/reconcile', sync(() => ({ reports: latestReconcile(c, 10) })));

  bridge.get('/outbox', async (req, res) => {
    try {
      const after = Number(req.query.after ?? 0);
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));
      if (!Number.isSafeInteger(after) || after < 0) throw cityBadRequest('after 要是非负整数（上一次返回的 next_after）。');
      const ms = waitMs(req);
      if (ms > 0) await c.waitOutbox(after, ms, abortOnClose(req, res));
      if (res.writableEnded || res.destroyed) return;
      res.json(readOutbox(c, after, limit));
    } catch (e) {
      sendError(res, e, log);
    }
  });

  // ── 代行 ──
  bridge.post('/visits/:id/act', sync((req) => visitAct(c, visitId(req), body(req))));
  bridge.get(
    '/visits/:id/view',
    sync((req) => {
      const visit = requireActingVisit(c, visitId(req), Number(req.query.domain_epoch));
      const itemOffset = parseOffset(req.query.item_offset);
      const lockerOffset = parseOffset(req.query.locker_offset);
      const prefixBytes = Buffer.byteLength(JSON.stringify({ visit_id: visit.visit_id, state: visit.state }), 'utf8');
      return {
        visit_id: visit.visit_id,
        state: visit.state,
        ...selfView(c, c.mustResident(visit.resident_id), {
          maxBytes: Math.max(1024, SELF_VIEW_MAX_BYTES - prefixBytes),
          itemOffset,
          lockerOffset,
        }),
      };
    }),
  );
  bridge.get('/visits/:id/wait', async (req, res) => {
    try {
      const epoch = Number(req.query.domain_epoch);
      const visit = requireActingVisit(c, visitId(req), epoch);
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const ms = waitMs(req);
      if (ms > 0) await c.waitResident(visit.resident_id, cursor, ms, abortOnClose(req, res));
      if (res.writableEnded || res.destroyed) return;
      const read = c.readResidentEvents(visit.resident_id, cursor, 50);
      res.json({ visit_id: visit.visit_id, state: requireActingVisit(c, visit.visit_id, epoch).state, events: read.events.map((e) => ({ type: e.type, at_ms: e.at, ...e.data })), cursor: read.cursor, more: read.more, ...(read.resync ? { resync: true } : {}) });
    } catch (e) {
      sendError(res, e, log);
    }
  });

  bridge.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: '没有这个接口。' });
  });
  bridge.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // express.json 解析失败
    void _next;
    res.status(400).json({ error: 'BAD_REQUEST', message: err instanceof Error && /too large/i.test(err.message) ? '请求体太大。' : '请求体不是合法的 JSON。' });
  });
  app.use('/city/bridge/v1', bridge);
  return closeAll;
}
