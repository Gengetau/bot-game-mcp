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
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { requireActingVisit, visitAct } from './actions.js';
import { CITY_CATALOG_VERSION, FARE_RULE_VERSION, HOUSE_ENTRANCE, ITEM_TYPES, TRANSIT_EDGES, homeward, publicPlaces, station } from './catalog.js';
import { CITY_HTTP_STATUS, CityError, cityBadRequest } from './errors.js';
import { MAPPINGS } from './mappings.js';
import { latestReconcile } from './reconcile.js';
import type { CityService } from './service.js';
import { publicCityView, selfView } from './views.js';
import { BRIDGE_PROTOCOL, abortVisit, commitVisit, describeVisit, prepareVisit, readOutbox, releaseVisit, requestReturn } from './visits.js';
import { allWeather } from './weather.js';

export interface CityHttpOptions {
  /** 桥接密钥。不给 = 不挂桥接接口 */
  bridgeKey?: string | undefined;
  requestsPerMinute?: number;
}

const MAX_WAIT_MS = 50_000;

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

export function mountCity(app: Express, c: CityService, log: (msg: string) => void, opts: CityHttpOptions = {}): void {
  const allow = rateLimiter(opts.requestsPerMinute ?? 240);
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (!allow(req.ip ?? 'unknown')) {
      res.setHeader('Retry-After', '10');
      res.status(429).json({ error: 'RATE_LIMITED', message: '请求太密了。', retryAfterMs: 10_000 });
      return;
    }
    next();
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
  app.get('/city/api/public', guard, (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(publicCityView(c));
    } catch (e) {
      sendError(res, e, log);
    }
  });

  // ───────────────────────── 桥接 ─────────────────────────
  const key = opts.bridgeKey;
  if (!key) return;
  const digest = (s: string) => createHash('sha256').update(s).digest();
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
      item_types: ITEM_TYPES,
      places: publicPlaces().map((p) => ({ id: p.id, name: p.name, area: p.area, type: p.type, hours: p.hours, rain: p.rain, homeward: { fare_yen: homeward(p.id).fareYen, minutes: homeward(p.id).minutes }, goods: p.goods.map((g) => ({ sku: g.sku, type: g.type, name: g.name, price_yen: g.priceYen })) })),
      transit: TRANSIT_EDGES.map((e) => ({ from: station(e.a)!.placeId, to: station(e.b)!.placeId, line: e.line, minutes: e.minutes, fare_yen: e.fareYen, source: 'simulated' })),
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
      return { visit_id: visit.visit_id, state: visit.state, ...selfView(c, c.mustResident(visit.resident_id)) };
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
}
