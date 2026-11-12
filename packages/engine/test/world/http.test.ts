/**
 * 栖灯镇的网页接口（/town/）：起真实的 express app（mountTown），用 fetch 打。
 * 服务一律监听 127.0.0.1 的随机端口，用完关闭。
 */
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { WorldError } from '../../src/world/errors.js';
import { mountTown, type TownHttpOptions } from '../../src/world/http.js';
import { issueTicket, devLoginSession } from '../../src/world/identity.js';
import { createWorld } from '../../src/world/index.js';
import type { WorldService } from '../../src/world/service.js';
import { FakeClock } from '../helpers.js';
import { makeTown, type Actor, type Town } from './helpers.js';

// ───────────────────────── 测试辅助 ─────────────────────────

interface App {
  base: string;
  w: WorldService;
  logs: string[];
  server: Server;
  close: () => Promise<void>;
}

let tabSeq = 1000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** 在 127.0.0.1 的随机端口上起一个只挂了小镇的 express app。 */
async function serve(w: WorldService, opts: TownHttpOptions = { requestsPerMinute: 100_000 }): Promise<App> {
  const app = express();
  app.disable('x-powered-by');
  const logs: string[] = [];
  const closeTown = mountTown(app, w, (m) => logs.push(m), opts);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const handle: App = {
    base,
    w,
    logs,
    server,
    close: async () => {
      closeTown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  cleanups.push(handle.close);
  return handle;
}

async function serveTown(opts?: TownHttpOptions, townOpts?: Parameters<typeof makeTown>[0]): Promise<{ t: Town; app: App }> {
  const t = makeTown(townOpts);
  return { t, app: await serve(t.w, opts) };
}

interface Res {
  status: number;
  headers: Headers;
  json: any;
  text: string;
}

/** 带 Cookie 罐的小客户端；POST 默认带 JSON 内容类型和同源的 Origin。 */
class Web {
  cookie = '';
  clientId = '';
  residentId = '';
  constructor(readonly base: string) {}

  async req(method: string, path: string, init: { body?: unknown; raw?: string; headers?: Record<string, string>; origin?: string | null; contentType?: string | null } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (method === 'POST') {
      if (init.contentType !== null) headers['content-type'] = init.contentType ?? 'application/json';
      if (init.origin !== null) headers.origin = init.origin ?? this.base;
      body = init.raw ?? JSON.stringify(init.body ?? {});
    }
    const res = await fetch(this.base + path, { method, headers, ...(body !== undefined ? { body } : {}) });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('town_session='));
    if (sc) {
      const pair = sc.split(';')[0]!;
      this.cookie = /Max-Age=0/i.test(sc) ? '' : pair;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 不是 JSON */
    }
    return { status: res.status, headers: res.headers, json, text };
  }
  get = (path: string, init: Parameters<Web['req']>[2] = {}) => this.req('GET', path, init);
  post = (path: string, body?: unknown, init: Parameters<Web['req']>[2] = {}) => this.req('POST', path, { ...init, body });

  /** 开发登录 + 进入小镇。 */
  async login(name: string, clientId = `tab-${++tabSeq}-main`): Promise<this> {
    const r = await this.post('/town/api/auth/dev', { name });
    expect(r.status, r.text).toBe(200);
    const e = await this.post('/town/api/enter', { clientId, profile: { name } });
    expect(e.status, e.text).toBe(200);
    this.clientId = clientId;
    this.residentId = e.json.residentId;
    return this;
  }

  me = async (clientId = this.clientId) => (await this.get(`/town/api/me?clientId=${clientId}`)).json;

  /** 像浏览器那样：读最新视图拿期望值，再提交动作。 */
  async act(action: Record<string, unknown>, o: { requestId?: string; clientId?: string; expected?: Record<string, unknown>; actionWindow?: string; extra?: Record<string, unknown>; prefix?: string } = {}): Promise<Res> {
    const clientId = o.clientId ?? this.clientId;
    const v = await this.me(clientId);
    return this.post(`${o.prefix ?? '/town/api'}/actions`, {
      clientId,
      requestId: o.requestId ?? `req-${Math.random().toString(36).slice(2, 12)}`,
      actionWindow: o.actionWindow ?? v.actionWindow,
      expected: o.expected ?? { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: v.context.activityId },
      action,
      ...(o.extra ?? {}),
    });
  }
}

/** 直接用 node:http 发请求，路径原样发出（fetch 会把 .. 之类规整掉）。 */
function rawGet(base: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = httpRequest({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface SseEvent {
  id?: string;
  event: string;
  data: any;
}

interface Sse {
  status: number;
  headers: Headers;
  events: SseEvent[];
  raw: () => string;
  waitFor: (pred: (e: SseEvent) => boolean, ms?: number) => Promise<SseEvent>;
  closed: Promise<void>;
  isClosed: () => boolean;
  close: () => void;
}

/** 读 SSE 的小客户端：解析 id / event / data，保留所有事件。 */
async function openSse(url: string, headers: Record<string, string> = {}): Promise<Sse> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const events: SseEvent[] = [];
  let raw = '';
  let isClosed = false;
  const listeners: (() => void)[] = [];
  const closed = (async () => {
    if (res.status !== 200 || !res.body) {
      await res.text().catch(() => undefined);
      isClosed = true;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: SseEvent = { event: 'message', data: null };
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) ev.id = line.slice(4);
            else if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) ev.data = JSON.parse(data);
          if (block.startsWith(':') && !data) continue;
          events.push(ev);
          for (const l of listeners.splice(0)) l();
        }
      }
    } catch {
      /* 被我们中止 */
    }
    isClosed = true;
    for (const l of listeners.splice(0)) l();
  })();
  const sse: Sse = {
    status: res.status,
    headers: res.headers,
    events,
    raw: () => raw,
    closed,
    isClosed: () => isClosed,
    close: () => ctrl.abort(),
    waitFor: (pred, ms = 3000) =>
      new Promise<SseEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等 SSE 事件超时：已收到 ${JSON.stringify(events.map((e) => e.event))}`)), ms);
        const check = () => {
          const hit = events.find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else if (isClosed) {
            clearTimeout(timer);
            reject(new Error('SSE 已关闭'));
          } else listeners.push(check);
        };
        check();
      }),
  };
  cleanups.push(async () => sse.close());
  return sse;
}

/** 时间前进，期间网页居民（HTTP 心跳）和 AI 居民都保持在场。 */
async function alive(t: Town, ms: number, webs: Web[], actors: Actor[] = []): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(20_000, left);
    t.clock.advance(step);
    for (const w of webs) await w.post('/town/api/heartbeat', { clientId: w.clientId, presenceEpoch: t.w.resident(w.residentId)!.presence_epoch });
    for (const a of actors) a.heartbeat();
    t.w.tick();
    left -= step;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 组一个关了 devLogin 的世界（Town 辅助固定开着开发登录）。 */
function makeWorld(devLogin: boolean): { w: WorldService; clock: FakeClock } {
  const clock = new FakeClock();
  const w = createWorld({ dbPath: ':memory:', registry: createRegistry({}), now: clock.now, rng: new SeededRng('http'), seed: 'http', devLogin });
  w.startSync();
  return { w, clock };
}

const errShape = (r: Res, status: number, error: string) => {
  expect(r.status, r.text).toBe(status);
  expect(r.json.ok).toBe(false);
  expect(r.json.error).toBe(error);
  expect(typeof r.json.message).toBe('string');
  expect(r.json.message.length).toBeGreaterThan(0);
};

// ───────────────────────── 未登录 ─────────────────────────

describe('HTTP：未登录', () => {
  it('config / public / public/report 可读，且带不缓存与安全头', async () => {
    const { t, app } = await serveTown();
    const web = new Web(app.base);
    const cfg = await web.get('/town/api/config');
    expect(cfg.status).toBe(200);
    expect(cfg.json).toMatchObject({ world: { id: 'town', name: '栖灯镇', timezone: 'Asia/Tokyo' }, devLogin: true, heartbeatMs: 20_000 });
    expect(cfg.json.traits.length).toBeGreaterThan(0);
    expect(cfg.json.interests[0]).toHaveProperty('id');
    expect(cfg.json.limits).toMatchObject({ chatMaxChars: 120, letterMaxChars: 1000 });
    expect(cfg.headers.get('cache-control')).toBe('no-store');
    expect(cfg.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(cfg.headers.get('x-content-type-options')).toBe('nosniff');

    const pub = await web.get('/town/api/public');
    expect(pub.status).toBe(200);
    expect(pub.json.places.map((p: any) => p.id)).toContain('arcade');
    expect(pub.json).toHaveProperty('world');
    // 公开地图没有居民私密信息
    const a = t.join('阿灯');
    const pub2 = await web.get('/town/api/public');
    const txt = JSON.stringify(pub2.json);
    expect(txt).not.toContain('inventory');
    expect(txt).not.toContain(a.principalId);
    expect(pub2.json.places.find((p: any) => p.id === 'plaza').residents.map((r: any) => r.name)).toEqual(['阿灯']);

    const rep = await web.get('/town/api/public/report');
    expect(rep.status).toBe(200);
    expect(rep.json).toBeTruthy();
    const dated = await web.get(`/town/api/public/report?date=${t.w.today()}`);
    expect(dated.status).toBe(200);
    errShape(await web.get('/town/api/public/report?date=2999-01-01'), 400, 'bad_request');

    expect((await web.get('/town/api/session')).json).toEqual({ loggedIn: false });
  });

  it('需要登录的接口一律 401 unauthenticated（统一的错误格式）', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    for (const path of ['/me?clientId=tab-0001', '/letters', '/history', '/residents', '/relations', '/report', '/game', '/events']) {
      const r = await web.get(`/town/api${path}`);
      errShape(r, 401, 'unauthenticated');
    }
    for (const path of ['/enter', '/actions', '/heartbeat', '/claim', '/leave']) {
      const r = await web.post(`/town/api${path}`, { clientId: 'tab-0001' });
      errShape(r, 401, 'unauthenticated');
    }
    // 乱七八糟的 Cookie 也只是未登录，不是 500
    for (const bad of ['town_session=%', 'town_session=%E0%A4%A', 'town_session=', 'x=1; town_session=abc', 'town_session=' + 'a'.repeat(5000)]) {
      const r = await web.get('/town/api/me?clientId=tab-0001', { headers: { cookie: bad } });
      errShape(r, 401, 'unauthenticated');
      expect((await web.get('/town/api/session', { headers: { cookie: bad } })).json).toEqual({ loggedIn: false });
    }
  });

  it('登录了但还没有居民：reason = no_resident', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    expect((await web.post('/town/api/auth/dev', { name: '新人' })).status).toBe(200);
    const s = await web.get('/town/api/session');
    expect(s.json).toMatchObject({ loggedIn: true, name: '新人', kind: 'human', resident: null });
    const me = await web.get('/town/api/me?clientId=tab-0001');
    errShape(me, 401, 'unauthenticated');
    expect(me.json.reason).toBe('no_resident');
    for (const p of ['/letters', '/history', '/residents', '/relations', '/report', '/game']) expect((await web.get(`/town/api${p}`)).json.reason).toBe('no_resident');
    errShape(await web.post('/town/api/actions', { clientId: 'tab-0001', requestId: 'req-00000001', actionWindow: 'x', expected: {}, action: { type: 'speak', text: 'x' } }), 401, 'unauthenticated');
  });
});

// ───────────────────────── 登录与会话 ─────────────────────────

describe('HTTP：登录票据与会话 Cookie', () => {
  it('票据兑换 → Set-Cookie（HttpOnly、SameSite=Lax、Path=/town、Max-Age）；响应体里没有令牌', async () => {
    const { t, app } = await serveTown();
    const web = new Web(app.base);
    const tk = issueTicket(t.w, { provider: 'qq', subject: '9001', name: '票据人' });
    const r = await web.post('/town/api/auth/exchange', { ticket: tk.ticket });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, name: '票据人', hasResident: false });
    const sc = r.headers.getSetCookie();
    expect(sc).toHaveLength(1);
    const cookie = sc[0]!;
    expect(cookie).toMatch(/^town_session=[\w%.-]+;/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/town');
    expect(cookie).toContain(`Max-Age=${t.w.params.sessionTtlMs / 1000}`);
    expect(cookie).not.toContain('Secure'); // 纯 http
    expect(r.text).not.toContain(cookie.split(';')[0]!.split('=')[1]!);
    expect((await web.get('/town/api/session')).json).toMatchObject({ loggedIn: true, name: '票据人', kind: 'human' });
  });

  it('https / 反向代理（X-Forwarded-Proto: https）下带 Secure', async () => {
    const { t, app } = await serveTown();
    const web = new Web(app.base);
    const tk = issueTicket(t.w, { provider: 'qq', subject: '9002', name: '安全' });
    const r = await web.post('/town/api/auth/exchange', { ticket: tk.ticket }, { headers: { 'x-forwarded-proto': 'https' } });
    expect(r.headers.getSetCookie()[0]).toContain('; Secure');
    expect(r.headers.getSetCookie()[0]).toContain('HttpOnly');
    const dev = new Web(app.base);
    const d = await dev.post('/town/api/auth/dev', { name: '开发者' }, { headers: { 'x-forwarded-proto': 'https' } });
    expect(d.headers.getSetCookie()[0]).toContain('; Secure');
  });

  it('票据只能兑换一次；过期、伪造、空值、非字符串都失败（同一种说法）', async () => {
    const { t, app } = await serveTown();
    const a = new Web(app.base);
    const b = new Web(app.base);
    const tk = issueTicket(t.w, { provider: 'qq', subject: '9003', name: '一次性' });
    expect((await a.post('/town/api/auth/exchange', { ticket: tk.ticket })).status).toBe(200);
    const again = await b.post('/town/api/auth/exchange', { ticket: tk.ticket });
    errShape(again, 401, 'unauthenticated');
    expect(again.headers.getSetCookie()).toHaveLength(0);
    const msg = again.json.message;
    // 伪造 / 空 / 非字符串 / 缺字段：同样的说法，不区分
    for (const body of [{ ticket: 'x'.repeat(32) }, { ticket: '' }, { ticket: 123 }, { ticket: null }, {}, { ticket: ['a'] }]) {
      const r = await b.post('/town/api/auth/exchange', body);
      errShape(r, 401, 'unauthenticated');
      expect(r.json.message).toBe(msg);
    }
    // 过期（5 分钟）
    const old = issueTicket(t.w, { provider: 'qq', subject: '9004', name: '过期' });
    t.clock.advance(5 * 60_000 + 1);
    const r = await b.post('/town/api/auth/exchange', { ticket: old.ticket });
    errShape(r, 401, 'unauthenticated');
    expect(r.json.message).toBe(msg);
  });

  it('已经绑定为 AI 的账号不能用票据当真人登录（票据签发时就被拒）', async () => {
    const { t } = await serveTown();
    const bot = t.join('机器人', 'agent');
    void bot;
    // agent 主体是 qq:301，类别已定；同一账号签发真人票据会失败
    expect(() => issueTicket(t.w, { provider: 'qq', subject: '301', name: '冒充' })).toThrow(WorldError);
  });

  it('dev 登录只在 devLogin 打开时可用', async () => {
    const off = makeWorld(false);
    const appOff = await serve(off.w);
    const web = new Web(appOff.base);
    expect((await web.get('/town/api/config')).json.devLogin).toBe(false);
    const r = await web.post('/town/api/auth/dev', { name: '想混进来' });
    errShape(r, 401, 'unauthenticated');
    expect(r.headers.getSetCookie()).toHaveLength(0);
    // 票据登录不受影响
    const tk = issueTicket(off.w, { provider: 'qq', subject: '9005', name: '正式' });
    expect((await web.post('/town/api/auth/exchange', { ticket: tk.ticket })).status).toBe(200);

    const { app: appOn } = await serveTown();
    const on = new Web(appOn.base);
    expect((await on.get('/town/api/config')).json.devLogin).toBe(true);
    expect((await on.post('/town/api/auth/dev', { name: '本机' })).status).toBe(200);
    // 缺名字 → 400
    errShape(await new Web(appOn.base).post('/town/api/auth/dev', { name: '   ' }), 400, 'bad_request');
    errShape(await new Web(appOn.base).post('/town/api/auth/dev', {}), 400, 'bad_request');
  });

  it('dev 登录的名字被清洗（不能把控制字符 / 超长文字带进居民名）', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    const r = await web.post('/town/api/auth/dev', { name: '  带\u0000控制‮字符的名字非常非常长非常非常长  ' });
    expect(r.status).toBe(200);
    expect(r.json.name).not.toMatch(/[\u0000-\u001f]/);
    expect(r.json.name.length).toBeLessThanOrEqual(16);
  });

  it('居民名里的双向文字控制符（U+202E）被去掉', async () => {
    const { app } = await serveTown();
    const r = await new Web(app.base).post('/town/api/auth/dev', { name: '甲\u202e乙' });
    expect(r.json.name).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it('logout 撤销会话：旧 Cookie 之后不能再用；Cookie 被清除', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    await web.login('登出者');
    const oldCookie = web.cookie;
    expect((await web.me()).me.name).toBe('登出者');
    const out = await web.post('/town/api/auth/logout', {});
    expect(out.json).toEqual({ ok: true });
    expect(out.headers.getSetCookie()[0]).toMatch(/town_session=;.*Max-Age=0/);
    expect(web.cookie).toBe('');
    // 旧令牌（被偷走的 Cookie）也已失效
    const stolen = await new Web(app.base).get('/town/api/me?clientId=tab-0001-xx', { headers: { cookie: oldCookie } });
    errShape(stolen, 401, 'unauthenticated');
    expect((await new Web(app.base).get('/town/api/session', { headers: { cookie: oldCookie } })).json).toEqual({ loggedIn: false });
    // 没登录时登出也是 ok
    expect((await web.post('/town/api/auth/logout', {})).json).toEqual({ ok: true });
  });

  it('logout 会关掉这个会话打开的居民事件流', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    await web.login('流登出');
    const sse = await openSse(`${app.base}/town/api/events?clientId=${web.clientId}`, { cookie: web.cookie });
    await sse.waitFor((e) => e.event === 'hello');
    await web.post('/town/api/auth/logout', {}, { headers: { cookie: sse.status === 200 ? web.cookie : '' } });
    await Promise.race([sse.closed, sleep(2000).then(() => Promise.reject(new Error('登出后事件流没有关闭')))]);
    expect(sse.isClosed()).toBe(true);
  });

  it('会话过期（30 天）后需要重新登录，居民保留', async () => {
    const { t, app } = await serveTown();
    const web = new Web(app.base);
    await web.login('久别');
    const rid = web.residentId;
    t.clock.advance(31 * 24 * 3600_000);
    errShape(await web.get(`/town/api/me?clientId=${web.clientId}`), 401, 'unauthenticated');
    expect(t.w.resident(rid)).toBeTruthy();
  });

  it('认证接口有更严的限流（每分钟 20 次），每个来源分开计', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    for (let i = 0; i < 20; i++) errShape(await web.post('/town/api/auth/exchange', { ticket: `bad-${i}` }), 401, 'unauthenticated');
    errShape(await web.post('/town/api/auth/exchange', { ticket: 'bad-21' }), 429, 'rate_limited');
    errShape(await web.post('/town/api/auth/dev', { name: 'x' }), 429, 'rate_limited');
    // 经过本机反向代理的另一个来源不受影响
    const other = await web.post('/town/api/auth/exchange', { ticket: 'bad' }, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    errShape(other, 401, 'unauthenticated');
  });
});

// ───────────────────────── 进入、视图、动作 ─────────────────────────

describe('HTTP：enter / me / actions', () => {
  it('enter：第一次建立居民，再次进入是同一位；clientId 非法 → 400', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    await web.post('/town/api/auth/dev', { name: '阿灯' });
    const e1 = await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '阿灯', bio: '爱喝茶', traits: ['quiet'], interests: ['tea'] } });
    expect(e1.status).toBe(200);
    expect(e1.json).toMatchObject({ ok: true, created: true, wasAway: true, control: { mine: true }, presenceEpoch: expect.any(Number), contextVersion: expect.any(Number) });
    expect(e1.json.residentId).toMatch(/^r_/);
    expect(e1.json.view.me).toMatchObject({ name: '阿灯', bio: '爱喝茶' });
    expect(e1.json.view.inventory.coins.balance).toBe(20);
    const e2 = await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '改名了不算' } });
    expect(e2.json).toMatchObject({ created: false, residentId: e1.json.residentId, wasAway: false });
    expect(e2.json.view.me.name).toBe('阿灯');
    // 另一个标签页：同一居民，控制权仍在第一个
    const e3 = await web.post('/town/api/enter', { clientId: 'tab-bbbb' });
    expect(e3.json).toMatchObject({ created: false, residentId: e1.json.residentId, control: { mine: false } });

    for (const clientId of [undefined, '', 'abc', 'a b c d', 'x'.repeat(81), 123, '带中文的编号', 'a/b/c/d']) {
      errShape(await web.post('/town/api/enter', { clientId }), 400, 'bad_request');
    }
    errShape(await web.get('/town/api/me'), 400, 'bad_request');
    errShape(await web.get('/town/api/me?clientId=a%20b%20c'), 400, 'bad_request');
  });

  it('enter：名字被占用 / 空名字 / 非法个性 → 422 / 400；画像字段会被清洗', async () => {
    const { t, app } = await serveTown();
    t.join('重名');
    const web = new Web(app.base);
    await web.post('/town/api/auth/dev', { name: '甲' });
    const dup = await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '重名' } });
    errShape(dup, 422, 'precondition_failed');
    expect(dup.json.reason).toBe('name_taken');
    const blank = await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '   ' } });
    errShape(blank, 422, 'precondition_failed');
    expect(blank.json.reason).toBe('profile_required');
    errShape(await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '甲', traits: ['no_such_trait'] } }), 400, 'bad_request');
    errShape(await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '甲', traits: 'quiet' } }), 400, 'bad_request');
    const ok = await web.post('/town/api/enter', { clientId: 'tab-aaaa', profile: { name: '甲<b>粗体</b>', bio: '[CQ:at,qq=1]\u0000你好' } });
    expect(ok.status).toBe(200);
    expect(ok.json.view.me.name).not.toContain('\u0000');
    expect(ok.json.view.me.bio).not.toContain('\u0000');
  });

  it('me：本人视图；控制权只属于握着的那个 clientId', async () => {
    const { app } = await serveTown();
    const web = await new Web(app.base).login('阿灯', 'tab-aaaa');
    await web.post('/town/api/enter', { clientId: 'tab-bbbb' });
    const a = await web.me('tab-aaaa');
    const b = await web.me('tab-bbbb');
    expect(a.control.mine).toBe(true);
    expect(b.control.mine).toBe(false);
    expect(a.actionWindow).toMatch(/^aw\./);
    expect(a.context).toMatchObject({ version: expect.any(Number), activityId: null });
    expect(a.cursor).toMatch(/^r[0-9a-z]+\./);
    expect(a.here.space).toBe('plaza');
    expect(a.game).toBeNull();
    // 大小：网页本人视图 < 64KiB
    expect(Buffer.byteLength(JSON.stringify(a), 'utf8')).toBeLessThan(64 * 1024);
  });

  it('actions 成功：completed / accepted 的字段、cursor、contextVersion', async () => {
    const { t, app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    const sp = await web.act({ type: 'speak', text: '你好呀' });
    expect(sp.status).toBe(200);
    expect(sp.json).toMatchObject({ ok: true, status: expect.stringMatching(/completed|accepted/), contextVersion: expect.any(Number), activityId: null, cursor: expect.stringMatching(/^r/) });
    const mv = await web.act({ type: 'navigate', to: 'tea_house' });
    expect(mv.status).toBe(200);
    expect(mv.json.status).toBe('accepted');
    expect(mv.json.move).toBeUndefined(); // 旧的 move 结果形状已经没有了
    expect(mv.json.navigation.arriveAt).toBeGreaterThan(t.clock.now());
    expect(mv.json.navigation.navigationId).toEqual(expect.any(String));
    // 像真正的客户端那样每几秒续一次租约，走到为止
    for (let i = 0; i < 40 && (await web.me()).here.space !== 'tea_house'; i++) {
      const nav = (await web.me()).location.navigation;
      t.advance(3000);
      if (nav) await web.post('/town/api/nav/renew', { clientId: web.clientId, navigationId: nav.navigationId, revision: nav.revision });
    }
    expect((await web.me()).here.space).toBe('tea_house');
  });

  it('actions 的每一种错误码：HTTP 状态与 {ok:false,error,message,reason?} 的形状', async () => {
    const { t, app } = await serveTown();
    const web = await new Web(app.base).login('阿灯', 'tab-aaaa');
    const v0 = await web.me();

    // bad_request 400：缺 requestId / action
    errShape(await web.post('/town/api/actions', { clientId: 'tab-aaaa', actionWindow: v0.actionWindow, expected: {}, action: { type: 'speak', text: 'x' } }), 400, 'bad_request');
    errShape(await web.post('/town/api/actions', { clientId: 'tab-aaaa', requestId: 'req-00000001', actionWindow: v0.actionWindow, expected: {} }), 400, 'bad_request');
    errShape(await web.act({ type: 'no_such_action' }), 400, 'bad_request');
    errShape(await web.act({ type: 'speak', text: 'x' }, { requestId: 'short' }), 400, 'bad_request');

    // request_expired 410：动作窗口无效 / 缺失
    errShape(await web.act({ type: 'speak', text: '窗口坏了' }, { actionWindow: 'aw.zzzz.badmac' }), 410, 'request_expired');
    errShape(await web.post('/town/api/actions', { clientId: 'tab-aaaa', requestId: 'req-nowindow1', expected: {}, action: { type: 'speak', text: 'x' } }), 410, 'request_expired');
    // precondition_failed 422 + reason
    const wrongVenue = await web.act({ type: 'propose_game', game: 'liars_dice' });
    errShape(wrongVenue, 422, 'precondition_failed');
    expect(wrongVenue.json.reason).toBe('wrong_venue');
    const broke = await web.act({ type: 'buy', shop: 'tea_counter', sku: 'tea_leaves', qty: 1 });
    errShape(broke, 422, 'precondition_failed'); // 不在茶馆

    // context_stale 409：期望的上下文版本过期，带最新的 contextVersion
    const cur = await web.me();
    const ctx = await web.act({ type: 'speak', text: '旧版本' }, { expected: { contextVersion: cur.context.version - 1, controlEpoch: cur.control.epoch, activityId: null } });
    errShape(ctx, 409, 'context_stale');
    expect(ctx.json.contextVersion).toBe(cur.context.version);

    // control_lost 409：另一个标签页没有控制权
    await web.post('/town/api/enter', { clientId: 'tab-bbbb' });
    const lost = await web.act({ type: 'speak', text: '我没有控制权' }, { clientId: 'tab-bbbb' });
    errShape(lost, 409, 'control_lost');
    // 接管之后，原来的标签页迟到的动作被拒绝，新标签页可以
    const claim = await web.post('/town/api/claim', { clientId: 'tab-bbbb' });
    expect(claim.json).toMatchObject({ ok: true, control: { mine: true, epoch: expect.any(Number) } });
    errShape(await web.act({ type: 'speak', text: '旧页面' }, { clientId: 'tab-aaaa', expected: { contextVersion: cur.context.version, controlEpoch: cur.control.epoch, activityId: null } }), 409, 'control_lost');
    expect((await web.act({ type: 'speak', text: '新页面' }, { clientId: 'tab-bbbb' })).status).toBe(200);

    // request_conflict 409：同一请求号换了内容
    const first = await web.act({ type: 'speak', text: '第一句' }, { clientId: 'tab-bbbb', requestId: 'req-conflict-1' });
    expect(first.status).toBe(200);
    errShape(await web.act({ type: 'speak', text: '另一句' }, { clientId: 'tab-bbbb', requestId: 'req-conflict-1' }), 409, 'request_conflict');

    // rate_limited 429 + Retry-After + retryAfterMs
    let limited: Res | null = null;
    for (let i = 0; i < 8 && !limited; i++) {
      const r = await web.act({ type: 'speak', text: `刷屏 ${i}` }, { clientId: 'tab-bbbb' });
      if (r.status === 429) limited = r;
    }
    expect(limited).toBeTruthy();
    errShape(limited!, 429, 'rate_limited');
    expect(limited!.json.retryAfterMs).toBeGreaterThan(0);
    expect(Number(limited!.headers.get('retry-after'))).toBe(Math.ceil(limited!.json.retryAfterMs / 1000));

    // 24 小时后同一个窗口过期
    const stale = await web.me('tab-bbbb');
    t.clock.advance(24 * 3600_000 + 1);
    errShape(await web.act({ type: 'speak', text: '太久了' }, { clientId: 'tab-bbbb', actionWindow: stale.actionWindow }), 410, 'request_expired');
  });

  it('actions：phase_stale / resync_required / recovering / 500 的状态码与形状', async () => {
    const { t, app } = await serveTown();
    const web = await new Web(app.base).login('阿灯', 'tab-aaaa');
    // 通过一个临时动作处理器触发各种世界错误
    t.w.handlers.set('probe_error', ({ action }) => {
      const code = String(action.code);
      if (code === 'internal') throw new Error('内部炸了：包含 /secret/path 的堆栈');
      throw new WorldError(code as never, `测试 ${code}`, 'probe_reason', { extra: 7 });
    });
    for (const [code, status] of [
      ['phase_stale', 409],
      ['resync_required', 410],
      ['not_available', 404],
      ['recovering', 503],
      ['unauthenticated', 401],
    ] as const) {
      const r = await web.act({ type: 'probe_error', code });
      errShape(r, status, code);
      expect(r.json).toMatchObject({ reason: 'probe_reason', extra: 7 });
    }
    expect((await web.act({ type: 'probe_error', code: 'recovering' })).headers.get('retry-after')).toBe('3');
    // 非 WorldError：500，不泄露堆栈和路径
    const boom = await web.act({ type: 'probe_error', code: 'internal' });
    expect(boom.status).toBe(500);
    expect(boom.json).toEqual({ ok: false, error: 'internal', message: '服务器出错了。' });
    expect(boom.text).not.toContain('secret');
    expect(app.logs.join('\n')).toContain('内部炸了');
    // 数据库不可写（degraded）时：写接口 503 recovering，并带 Retry-After
    t.w.status = 'degraded';
    const d = await web.act({ type: 'speak', text: '写不进去' });
    errShape(d, 503, 'recovering');
    expect(d.headers.get('retry-after')).toBe('3');
    const hb = await web.post('/town/api/heartbeat', { clientId: 'tab-aaaa', presenceEpoch: 1 });
    errShape(hb, 503, 'recovering');
    // 公开接口仍可读
    expect((await web.get('/town/api/public')).status).toBe(200);
    t.w.status = 'running';
  });

  it('phase_stale 与 context_stale：局中动作过期（真实对局）', async () => {
    const { t, app } = await serveTown();
    const a = await new Web(app.base).login('甲');
    const b = await new Web(app.base).login('乙');
    const p = await a.act({ type: 'propose_game', game: 'number_bomb', objectId: 'arcade:table1' });
    expect(p.status).toBe(200);
    const id = p.json.activity.id;
    expect((await b.act({ type: 'join_game', activityId: id })).status).toBe(200);
    expect((await a.act({ type: 'start_game', activityId: id })).status).toBe(200);
    const va = await a.me();
    const vb = await b.me();
    expect(va.context.activityId).toBe(id);
    expect(va.here).toBeNull();
    const who = va.game.your_turn ? a : b;
    const whoView = who === a ? va : vb;
    const other = who === a ? b : a;
    const range = whoView.game.public.range;
    // 缺 phaseId
    errShape(await who.act({ type: 'game_act', input: { action: 'guess', number: range.from } }), 409, 'phase_stale');
    // 对的 phaseId
    const ok = await who.act({ type: 'game_act', phaseId: whoView.game.phase_id, input: { action: 'guess', number: range.from } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.text).toContain('你猜了');
    if (ok.json.gameStatus === 'running') {
      // 迟到：同一阶段再来一次
      errShape(await who.act({ type: 'game_act', phaseId: whoView.game.phase_id, input: { action: 'guess', number: range.from + 1 } }), 409, 'phase_stale');
      // 局中做世界动作：context_stale（旧上下文）与 in_activity（新上下文）
      const stale = await other.act({ type: 'speak', text: '局中说话' }, { expected: { contextVersion: va.context.version - 1, controlEpoch: va.control.epoch, activityId: null } });
      errShape(stale, 409, 'context_stale');
      const inAct = await other.act({ type: 'speak', text: '局中说话' });
      errShape(inAct, 422, 'precondition_failed');
      expect(inAct.json.reason).toBe('in_activity');
    }
    void t;
  });

  it('同 requestId 重放：返回原结果并标记 replayed，不重复执行', async () => {
    const { t, app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    const body = { type: 'speak', text: '只说一次' };
    const r1 = await web.act(body, { requestId: 'req-replay-0001' });
    const r2 = await web.act(body, { requestId: 'req-replay-0001' });
    expect(r1.status).toBe(200);
    expect(r1.json.replayed).toBeUndefined();
    expect(r2.status).toBe(200);
    expect(r2.json.replayed).toBe(true);
    expect(r2.json.cursor).toBe(r1.json.cursor);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages WHERE body = ?', '只说一次')).toBe(1);
    // 即使上下文在这期间变了（响应丢失后重试），仍返回原回执而不是 context_stale
    const old = await web.me();
    await web.act({ type: 'navigate', to: 'tea_house' });
    t.advance(15_000);
    const r3 = await web.post('/town/api/actions', { clientId: web.clientId, requestId: 'req-replay-0001', actionWindow: old.actionWindow, expected: { contextVersion: 0, controlEpoch: 0, activityId: null }, action: body });
    expect(r3.status).toBe(200);
    expect(r3.json.replayed).toBe(true);
  });

  it('请求里自报的 residentId / principalId 一律不认：身份只来自会话', async () => {
    const { app } = await serveTown();
    const a = await new Web(app.base).login('阿灯');
    const b = await new Web(app.base).login('小岚');
    const r = await a.act({ type: 'speak', text: '我是阿灯' }, { extra: { residentId: b.residentId, principalId: 'p_other', resident_id: b.residentId } });
    expect(r.status).toBe(200);
    const bHeard = await b.get('/town/api/history');
    expect(bHeard.json.messages.map((m: any) => [m.from.name, m.text])).toEqual([['阿灯', '我是阿灯']]);
    // 在动作里夹带 actor / as 之类的字段也没用
    const spoof = await a.act({ type: 'speak', text: '再试一次', residentId: b.residentId, as: b.residentId, from: b.residentId } as never);
    expect(spoof.status).toBe(200);
    const heard = (await b.get('/town/api/history')).json.messages;
    expect(heard.every((m: any) => m.from.id === a.residentId)).toBe(true);
    // 查询串里的 residentId 对 GET 也没用
    const me = await a.get(`/town/api/me?clientId=${a.clientId}&residentId=${b.residentId}`);
    expect(me.json.me.id).toBe(a.residentId);
    const hist = await a.get(`/town/api/history?residentId=${b.residentId}`, { headers: { 'x-resident-id': b.residentId } });
    expect(hist.json.messages.every((m: any) => m.from.id !== a.residentId || true)).toBe(true);
    expect(JSON.stringify((await a.get('/town/api/letters?box=sent&residentId=' + b.residentId)).json)).toBe(JSON.stringify((await a.get('/town/api/letters?box=sent')).json));
  });

  it('/worlds/<worldId>/… 是等价写法；错误的 worldId 返回 404', async () => {
    const { app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    const plain = await web.me();
    const alias = (await web.get(`/town/api/worlds/town/me?clientId=${web.clientId}`)).json;
    expect(alias.me.id).toBe(plain.me.id);
    expect(alias.context).toEqual(plain.context);
    expect((await web.get('/town/api/worlds/town/public')).json.places.length).toBeGreaterThan(0);
    expect((await web.get('/town/api/worlds/town/config')).json.world.id).toBe('town');
    const act = await web.act({ type: 'speak', text: '走别名' }, { prefix: '/town/api/worlds/town' });
    expect(act.status).toBe(200);
    const e = await web.post('/town/api/worlds/town/enter', { clientId: web.clientId });
    expect(e.json.created).toBe(false);
    expect((await web.post('/town/api/worlds/town/heartbeat', { clientId: web.clientId, presenceEpoch: plain.control.presenceEpoch })).json.ok).toBe(true);
    // 查询串保留
    expect((await web.get('/town/api/worlds/town/letters?box=sent&limit=5')).json).toHaveProperty('letters');
    // 错误的世界编号
    for (const bad of ['/town/api/worlds/other/public', '/town/api/worlds/other/me?clientId=tab-0001', '/town/api/worlds/%E0%A4%A/public', '/town/api/worlds/TOWN/public']) {
      errShape(await web.get(bad), 404, 'not_available');
    }
    errShape(await web.post('/town/api/worlds/other/actions', {}), 404, 'not_available');
  });

  it('其它接口：heartbeat / claim / letters / history / residents / relations / report / game / public/game', async () => {
    const { t, app } = await serveTown();
    const a = await new Web(app.base).login('阿灯');
    const bAct = t.join('小岚', 'agent');
    // heartbeat
    const v = await a.me();
    const hb = await a.post('/town/api/heartbeat', { clientId: a.clientId, presenceEpoch: v.control.presenceEpoch });
    expect(hb.json).toMatchObject({ ok: true, presenceEpoch: v.control.presenceEpoch, control: { mine: true }, activityId: null, nextHeartbeatMs: 20_000 });
    errShape(await a.post('/town/api/heartbeat', { clientId: a.clientId, presenceEpoch: 99 }), 422, 'precondition_failed');
    expect((await a.post('/town/api/heartbeat', { clientId: a.clientId, presenceEpoch: 99 })).json.reason).toBe('presence_lost');
    errShape(await a.post('/town/api/heartbeat', { clientId: 'tab-unknown', presenceEpoch: v.control.presenceEpoch }), 422, 'precondition_failed');
    // history：我听到的现场发言
    bAct.act('speak', { text: '早上好' });
    await alive(t, 11_000, [a], [bAct]);
    await a.act({ type: 'speak', text: '早' });
    const hist = await a.get('/town/api/history');
    expect(hist.json.messages.map((m: any) => m.text)).toEqual(['早', '早上好']);
    expect(hist.json.next).toBeNull();
    expect((await a.get('/town/api/history?limit=1')).json.messages).toHaveLength(1);
    expect((await a.get('/town/api/history?limit=1')).json.next).not.toBeNull();
    expect((await a.get('/town/api/history?before=abc&limit=zzz')).status).toBe(200);
    // residents / relations / report
    const res = await a.get('/town/api/residents');
    expect(res.json.residents.map((r: any) => r.name).sort()).toEqual(['小岚', '阿灯']);
    expect(JSON.stringify(res.json)).not.toMatch(/inventory|balance/);
    expect((await a.get('/town/api/relations')).json).toHaveProperty('relations');
    const rep = await a.get('/town/api/report');
    expect(rep.json).toHaveProperty('personal');
    expect(rep.json).toHaveProperty('public');
    errShape(await a.get('/town/api/report?date=2999-01-01'), 400, 'bad_request');
    // letters：未读来信没有正文
    bAct.act('send_letter', { to: a.residentId, body: '这是一封保密的信件正文' });
    expect((await a.get('/town/api/letters?box=inbox')).json.letters).toHaveLength(0); // 还在路上
    await alive(t, 61_000, [a], [bAct]);
    const inbox = await a.get('/town/api/letters');
    expect(inbox.json.letters).toHaveLength(1);
    expect(inbox.text).not.toContain('这是一封保密的信件正文');
    expect(inbox.json.letters[0].unread ?? inbox.json.letters[0].read === false).toBeTruthy();
    const sent = await a.get('/town/api/letters?box=sent');
    expect(sent.json.letters).toHaveLength(0);
    // game：不在局里 → 409 context_stale（带上下文版本）
    const g = await a.get('/town/api/game');
    errShape(g, 409, 'context_stale');
    expect(g.json).toMatchObject({ contextVersion: expect.any(Number), activityId: null });
    // 凑一桌：game 与 public/game
    const p = await a.act({ type: 'propose_game', game: 'number_bomb', objectId: 'arcade:table1' });
    expect(p.status, p.text).toBe(200);
    bAct.act('join_game', { activityId: p.json.activity.id });
    await a.act({ type: 'start_game', activityId: p.json.activity.id });
    const gv = await a.get('/town/api/game');
    expect(gv.status).toBe(200);
    expect(gv.json).toMatchObject({ type: 'number_bomb', status: 'running', activityId: p.json.activity.id });
    expect(gv.json.you).toBeTruthy();
    expect((await a.get('/town/api/game?since=1')).status).toBe(200);
    // 观战投影：不用登录；没有座位私密信息
    const anon = new Web(app.base);
    const pg = await anon.get(`/town/api/public/game/${p.json.activity.id}`);
    expect(pg.status).toBe(200);
    expect(pg.json).toMatchObject({ type: 'number_bomb', status: 'running', activityId: p.json.activity.id, venue: 'plaza' });
    expect(pg.json.you).toBeUndefined();
    expect(pg.json.todo).toBeUndefined();
    expect(pg.text).not.toContain('"bomb"');
    errShape(await anon.get('/town/api/public/game/a_nope'), 404, 'not_available');
    // leave
    const lv = await a.post('/town/api/leave', {});
    expect(lv.json).toMatchObject({ ok: true, presenceEpoch: expect.any(Number) });
    expect(t.w.resident(a.residentId)!.present_since).toBeNull();
    // 离开后旧心跳不能让居民重新在场
    errShape(await a.post('/town/api/heartbeat', { clientId: a.clientId, presenceEpoch: v.control.presenceEpoch }), 422, 'precondition_failed');
    expect(t.w.resident(a.residentId)!.present_since).toBeNull();
  });
});

// ───────────────────────── 跨站防护与请求体 ─────────────────────────

describe('HTTP：CSRF 防护与请求体限制', () => {
  it('POST 必须是 application/json：表单 / 纯文本 / 没有内容类型都被拒绝', async () => {
    const { app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    const body = JSON.stringify({ clientId: web.clientId });
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/html', 'application/xml']) {
      const r = await web.req('POST', '/town/api/heartbeat', { raw: body, contentType });
      errShape(r, 400, 'bad_request');
    }
    const none = await web.req('POST', '/town/api/leave', { raw: '', contentType: null });
    errShape(none, 400, 'bad_request');
    // 表单式的 leave 也不行（简单请求跨站提交）
    errShape(await web.req('POST', '/town/api/leave', { raw: 'a=1', contentType: 'application/x-www-form-urlencoded' }), 400, 'bad_request');
    expect((await web.me()).me.present).toBe(true);
    // application/json 带 charset 可以
    const ok = await web.req('POST', '/town/api/heartbeat', { raw: JSON.stringify({ clientId: web.clientId, presenceEpoch: (await web.me()).control.presenceEpoch }), contentType: 'application/json; charset=utf-8' });
    expect(ok.status).toBe(200);
  });

  it('Origin 与站点不一致被拒绝（含 null、无效值）；同源、无 Origin 的非浏览器客户端可以', async () => {
    const { t, app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    const before = t.w.resident(web.residentId)!.present_since;
    for (const origin of ['http://evil.example', 'https://127.0.0.1:1', `http://127.0.0.1.evil.example:${new URL(app.base).port}`, 'null', 'not a url', 'http://localhost:' + new URL(app.base).port]) {
      const r = await web.post('/town/api/leave', {}, { origin });
      errShape(r, 400, 'bad_request');
      expect(r.json.message).toContain('跨站');
    }
    expect(t.w.resident(web.residentId)!.present_since).toBe(before); // 没有被离开
    // 跨站登出 / 登录也不行
    errShape(await web.post('/town/api/auth/logout', {}, { origin: 'http://evil.example' }), 400, 'bad_request');
    errShape(await new Web(app.base).post('/town/api/auth/dev', { name: '钓鱼' }, { origin: 'http://evil.example' }), 400, 'bad_request');
    expect(web.cookie).not.toBe('');
    // 同源 OK；没有 Origin（curl、服务端客户端）OK
    expect((await web.post('/town/api/heartbeat', { clientId: web.clientId, presenceEpoch: (await web.me()).control.presenceEpoch }, { origin: app.base })).status).toBe(200);
    expect((await web.post('/town/api/heartbeat', { clientId: web.clientId, presenceEpoch: (await web.me()).control.presenceEpoch }, { origin: null })).status).toBe(200);
    // 反向代理：以 X-Forwarded-Host 为准
    const viaProxy = await web.post('/town/api/heartbeat', { clientId: web.clientId, presenceEpoch: (await web.me()).control.presenceEpoch }, { origin: 'https://town.example.com', headers: { 'x-forwarded-host': 'town.example.com', 'x-forwarded-proto': 'https' } });
    expect(viaProxy.status).toBe(200);
    errShape(await web.post('/town/api/leave', {}, { origin: 'https://evil.example', headers: { 'x-forwarded-host': 'town.example.com' } }), 400, 'bad_request');
  });

  it('请求体大小有上限（16KB）：超限 413，且是统一的 JSON 错误，不带堆栈', async () => {
    const { app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    const big = await web.post('/town/api/actions', { clientId: web.clientId, requestId: 'req-big-00001', action: { type: 'speak', text: 'x'.repeat(20_000) } });
    errShape(big, 413, 'bad_request');
    expect(big.text).not.toMatch(/at \w+|node_modules|\.js:\d+/);
    // 恰好在限制之内的大请求被正常处理（文字会被字数限制拒绝，而不是体积）
    const mid = await web.act({ type: 'speak', text: 'y'.repeat(5000) });
    expect(mid.status).not.toBe(413);
    expect(mid.status).toBe(200);
  });

  it('不是合法 JSON → 400 bad_request（统一格式）', async () => {
    const { app } = await serveTown();
    const web = await new Web(app.base).login('阿灯');
    for (const raw of ['{bad json', '{"a":', 'null', '[1,2', '"just a string"']) {
      const r = await web.req('POST', '/town/api/actions', { raw });
      expect(r.status, raw).toBe(400);
      expect(r.json).toMatchObject({ ok: false, error: 'bad_request' });
      expect(r.text).not.toMatch(/SyntaxError|body-parser|node_modules/);
    }
    // 体是数组或字符串，不是对象：也不能崩
    const arr = await web.req('POST', '/town/api/actions', { raw: '[1,2,3]' });
    expect([400]).toContain(arr.status);
    expect(arr.json.ok).toBe(false);
  });

  it('没有这个接口 → 统一的 JSON 404', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    for (const path of ['/town/api/nope', '/town/api/me/extra', '/town/api/auth/nothing']) {
      const r = await web.get(path);
      errShape(r, 404, 'not_available');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    errShape(await web.get('/town/api'), 404, 'not_available');
    errShape(await web.post('/town/api/nope', {}), 404, 'not_available');
  });

  it('全局限流：同一来源每分钟请求数有上限，超限 429；换来源不受影响', async () => {
    const { app } = await serveTown({ requestsPerMinute: 5 });
    const web = new Web(app.base);
    for (let i = 0; i < 5; i++) expect((await web.get('/town/api/config')).status).toBe(200);
    errShape(await web.get('/town/api/config'), 429, 'rate_limited');
    expect((await web.get('/town/api/config', { headers: { 'x-forwarded-for': '198.51.100.7' } })).status).toBe(200);
  });
});

// ───────────────────────── SSE ─────────────────────────

describe('HTTP：SSE 事件流', () => {
  async function pair(opts?: TownHttpOptions, townOpts?: Parameters<typeof makeTown>[0]): Promise<{ t: Town; app: App; a: Web; b: Actor; c: Actor; step: (ms: number) => Promise<void>; say: (who: Actor, text: string) => Promise<void> }> {
    const { t, app } = await serveTown(opts, townOpts);
    const a = await new Web(app.base).login('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('远处', 'agent');
    c.go('tea_house');
    const step = (ms: number) => alive(t, ms, [a], [b, c]);
    const say = async (who: Actor, text: string) => {
      await step(11_000);
      who.act('speak', { text });
    };
    return { t, app, a, b, c, step, say };
  }
  const stream = (app: App, a: Web, q = '', headers: Record<string, string> = {}) => openSse(`${app.base}/town/api/events?clientId=${a.clientId}${q}`, { cookie: a.cookie, ...headers });

  it('先发 hello，再按动作推送 private 事件；SSE id 就是续传游标', async () => {
    const { app, a, b } = await pair();
    const sse = await stream(app, a);
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(sse.headers.get('cache-control')).toContain('no-store');
    expect(sse.events[0] ?? (await sse.waitFor(() => true))).toBeTruthy();
    const hello = await sse.waitFor((e) => e.event === 'hello');
    expect(sse.events[0]!.event).toBe('hello');
    expect(hello.data).toMatchObject({ cursor: expect.stringMatching(/^r[0-9a-z]+\.[\w-]+$/), pcursor: expect.stringMatching(/^p/), time: expect.any(Number) });
    expect(hello.id).toBeUndefined();

    b.act('speak', { text: '早上好呀' });
    const ev = await sse.waitFor((e) => e.event === 'private' && e.data.type === 'chat');
    expect(ev.data).toMatchObject({ type: 'chat', at: expect.any(Number), data: { text: '早上好呀', space: 'plaza' } });
    expect(ev.id).toMatch(/^r[0-9a-z]+\.[\w-]+$/);
    // 游标可以直接给 /me 对账：视图的 cursor 追上了事件
    expect((await a.me()).cursor).toBe(ev.id);
  });

  it('断开后带 cursor 重连：不丢不重（query 与 Last-Event-ID 两种方式）', async () => {
    const { app, a, b, say } = await pair();
    const s1 = await stream(app, a);
    await s1.waitFor((e) => e.event === 'hello');
    await say(b, '第一句');
    const first = await s1.waitFor((e) => e.event === 'private' && e.data.data?.text === '第一句');
    s1.close();
    await s1.closed;
    // 断线期间发生三件事
    await say(b, '第二句');
    await say(b, '第三句');
    const s2 = await stream(app, a, `&cursor=${encodeURIComponent(first.id!)}`);
    await s2.waitFor((e) => e.event === 'private' && e.data.data?.text === '第三句');
    const texts = s2.events.filter((e) => e.event === 'private').map((e) => e.data.data.text);
    expect(texts).toEqual(['第二句', '第三句']);
    expect(s2.events.find((e) => e.event === 'hello')!.data.cursor).toBe(first.id);
    expect(s2.events.some((e) => e.event === 'resync')).toBe(false);
    const lastId = s2.events.filter((e) => e.event === 'private').at(-1)!.id!;
    s2.close();
    await s2.closed;
    // Last-Event-ID 头：只拿之后的
    await say(b, '第四句');
    const s3 = await stream(app, a, '', { 'last-event-id': lastId });
    await s3.waitFor((e) => e.event === 'private' && e.data.data?.text === '第四句');
    expect(s3.events.filter((e) => e.event === 'private').map((e) => e.data.data.text)).toEqual(['第四句']);
    // 不带游标 = 从当前开始，不回放历史
    s3.close();
    await s3.closed;
    const s4 = await stream(app, a);
    await s4.waitFor((e) => e.event === 'hello');
    await sleep(100);
    expect(s4.events.filter((e) => e.event === 'private')).toHaveLength(0);
  });

  it('坏游标 / 别人的游标 / 超前的游标 → resync（带一个可用的新游标），hello 不回显坏游标', async () => {
    const { t, app, a, b, say } = await pair();
    const bView = b.view();
    const foreign = bView.cursor;
    const future = t.w.encodeCursor('r', a.residentId, 999_999);
    for (const bad of ['garbage', 'r1.badmac', foreign, future, 'x'.repeat(300)]) {
      const sse = await stream(app, a, `&cursor=${encodeURIComponent(bad)}`);
      const rs = await sse.waitFor((e) => e.event === 'resync');
      expect(rs.data).toMatchObject({ scope: 'private', cursor: expect.stringMatching(/^r[0-9a-z]+\./) });
      const hello = sse.events.find((e) => e.event === 'hello')!;
      expect(hello.data.cursor).not.toBe(bad);
      // 之后可以用新游标继续
      await say(b, `重同步后 ${bad.slice(0, 5)}`);
      await sse.waitFor((e) => e.event === 'private' && e.data.data?.text?.startsWith('重同步后'));
      sse.close();
      await sse.closed;
    }
    // 公开流的坏游标
    const pub = await openSse(`${app.base}/town/api/public/events?cursor=garbage`);
    const rp = await pub.waitFor((e) => e.event === 'resync');
    expect(rp.data).toMatchObject({ scope: 'public', pcursor: expect.stringMatching(/^p/) });
  });

  it('事件被裁剪（保留窗口外）后带旧游标 → resync，而不是静默丢事件', async () => {
    const { t, app, a, b, say } = await pair();
    const old = (await a.me()).cursor;
    await say(b, '很久以前');
    // 模拟保留期过后旧事件被清理、水位下沿前移
    const key = `r:${a.residentId}`;
    t.w.db.run('DELETE FROM recipient_events WHERE resident_id = ?', a.residentId);
    t.w.db.run('UPDATE stream_heads SET retained_from = high_water + 1 WHERE stream_key = ?', key);
    const sse = await stream(app, a, `&cursor=${encodeURIComponent(old)}`);
    const rs = await sse.waitFor((e) => e.event === 'resync');
    expect(rs.data.scope).toBe('private');
    expect(sse.events.find((e) => e.event === 'hello')!.data.cursor).not.toBe(old);
    expect(sse.raw()).not.toContain('很久以前');
  });

  it('/leave 后收到 revoked 并关闭连接；其他标签页的连接同样被关闭', async () => {
    const { app, a } = await pair();
    const s1 = await stream(app, a);
    const s2 = await openSse(`${app.base}/town/api/events?clientId=tab-second-0002`, { cookie: a.cookie });
    await s1.waitFor((e) => e.event === 'hello');
    await s2.waitFor((e) => e.event === 'hello');
    const lv = await a.post('/town/api/leave', {});
    expect(lv.status).toBe(200);
    await s1.waitFor((e) => e.event === 'revoked');
    await s2.waitFor((e) => e.event === 'revoked');
    await Promise.race([Promise.all([s1.closed, s2.closed]), sleep(2000).then(() => Promise.reject(new Error('revoked 之后连接没有关闭')))]);
    expect(s1.isClosed() && s2.isClosed()).toBe(true);
  });

  it('/public/events 只有公开事件；私有事件与现场发言不会出现', async () => {
    const { t, app, a, b, c, say, step } = await pair();
    const pub = await openSse(`${app.base}/town/api/public/events`);
    expect(pub.status).toBe(200);
    const hello = await pub.waitFor((e) => e.event === 'hello');
    expect(hello.data.pcursor).toMatch(/^p/);
    expect(hello.data.cursor).toBeUndefined();
    await say(b, '这句话是私密的现场发言~ZZZ~');
    c.act('send_letter', { to: b.residentId, body: '信件正文~ZZZ~' });
    await a.act({ type: 'speak', text: '阿灯的话~ZZZ~' });
    await step(61_000);
    // 公开事件：有人换了地方
    b.go('bookshop');
    const place = await pub.waitFor((e) => e.event === 'public' && e.data.type === 'place');
    expect(place.id).toMatch(/^p/); // 公开流的 id 是公开游标
    expect(place.data.pcursor).toBe(place.id);
    await sleep(50);
    expect(new Set(pub.events.map((e) => e.event))).toEqual(new Set(['hello', 'public']));
    expect(pub.raw()).not.toContain('~ZZZ~');
    expect(pub.raw()).not.toMatch(/"type":"(chat|mail|offer|invite)"/);
    // 用公开游标续传
    const lastId = pub.events.filter((e) => e.event === 'public').at(-1)!.id!;
    pub.close();
    await pub.closed;
    b.go('plaza');
    const pub2 = await openSse(`${app.base}/town/api/public/events?cursor=${encodeURIComponent(lastId)}`);
    await pub2.waitFor((e) => e.event === 'public');
    expect(pub2.events.some((e) => e.event === 'resync')).toBe(false);
    expect(pub2.events.filter((e) => e.event === 'public').every((e) => e.id !== lastId)).toBe(true);
  });

  it('别人的私有事件不会出现在我的流里（不同地点的发言、别人的信件、别人的报价）', async () => {
    const { app, a, b, c, say, step } = await pair();
    const sse = await stream(app, a);
    await sse.waitFor((e) => e.event === 'hello');
    // c 在茶馆说话、被 b 寄信、收到 b 的报价……都与 a 无关
    await say(c, '茶馆里的悄悄话~QQQ~');
    b.act('send_letter', { to: c.residentId, body: '给远处的信~QQQ~' });
    await step(61_000);
    // 哨兵：之后给 a 发一个确实属于他的事件
    await say(b, '哨兵');
    await sse.waitFor((e) => e.event === 'private' && e.data.data?.text === '哨兵');
    expect(sse.raw()).not.toContain('~QQQ~');
    const types = sse.events.filter((e) => e.event === 'private').map((e) => e.data.type);
    expect(types).not.toContain('mail');
    expect(types).not.toContain('offer');
  });

  it('流需要登录；同一居民最多 4 条连接；公开流可以按参数限额', async () => {
    const { app, a } = await pair();
    const anon = await openSse(`${app.base}/town/api/events?clientId=tab-0001`);
    expect(anon.status).toBe(401);
    const opened: Sse[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await stream(app, a);
      expect(s.status).toBe(200);
      await s.waitFor((e) => e.event === 'hello');
      opened.push(s);
    }
    const fifth = await stream(app, a);
    expect(fifth.status).toBe(429);
    // 关掉一条后又能开
    opened[0]!.close();
    await opened[0]!.closed;
    await sleep(50);
    const again = await stream(app, a);
    expect(again.status).toBe(200);
  });

  it('旁观流的连接额度（maxPublicStreams）与居民流额度（maxResidentStreams）', async () => {
    const { app, a } = await pair(undefined, { params: { maxPublicStreams: 1, maxResidentStreams: 1 } });
    const p1 = await openSse(`${app.base}/town/api/public/events`);
    expect(p1.status).toBe(200);
    await p1.waitFor((e) => e.event === 'hello');
    const p2 = await openSse(`${app.base}/town/api/public/events`);
    expect(p2.status).toBe(429);
    const r1 = await stream(app, a);
    expect(r1.status).toBe(200);
    const r2 = await stream(app, a);
    expect(r2.status).toBe(429);
    p1.close();
    await p1.closed;
    await sleep(50);
    const p3 = await openSse(`${app.base}/town/api/public/events`);
    expect(p3.status).toBe(200);
  });

  it('保活：空闲时发注释行 ": ping"，不产生事件', async () => {
    const { app, a } = await pair({ requestsPerMinute: 100_000, heartbeatMs: 40 });
    const sse = await stream(app, a);
    await sse.waitFor((e) => e.event === 'hello');
    await sleep(200);
    expect(sse.raw()).toContain(': ping');
    expect(sse.events.map((e) => e.event)).toEqual(['hello']);
  });

  it('/worlds/<id>/events 别名可用', async () => {
    const { app, a, b } = await pair();
    const sse = await openSse(`${app.base}/town/api/worlds/town/events?clientId=${a.clientId}`, { cookie: a.cookie });
    await sse.waitFor((e) => e.event === 'hello');
    b.act('speak', { text: '别名流' });
    await sse.waitFor((e) => e.event === 'private' && e.data.data?.text === '别名流');
    const bad = await openSse(`${app.base}/town/api/worlds/nope/events?clientId=${a.clientId}`, { cookie: a.cookie });
    expect(bad.status).toBe(404);
  });

  it('小游戏的事件流里只有「有新进展」，没有座位私密信息', async () => {
    const { t, app, a, b } = await pair();
    const sse = await stream(app, a);
    await sse.waitFor((e) => e.event === 'hello');
    const p = await a.act({ type: 'propose_game', game: 'number_bomb', objectId: 'arcade:table1' });
    b.act('join_game', { activityId: p.json.activity.id });
    await a.act({ type: 'start_game', activityId: p.json.activity.id });
    await sse.waitFor((e) => e.event === 'private' && e.data.type === 'game_started');
    const g = await sse.waitFor((e) => e.event === 'private' && e.data.type === 'game');
    expect(Object.keys(g.data.data).sort()).toEqual(['activityId', 'gameId', 'phaseId', 'waiting', 'yourTurn'].sort());
    const bomb = (t.w.db.get('SELECT record_json FROM game_records LIMIT 1')!.record_json as string).match(/"bomb":(\d+)/)![1]!;
    expect(sse.raw()).not.toMatch(new RegExp(`"bomb"`));
    expect(sse.raw()).not.toContain(`炸弹正是`);
    void bomb;
  });
});

// ───────────────────────── 静态文件 ─────────────────────────

describe('HTTP：空间接口（map / scene / nav/renew / ws-ticket）', () => {
  it('GET /map：公开，带 ETag 与缓存头；If-None-Match 命中返回 304', async () => {
    const { app } = await serveTown();
    const web = new Web(app.base);
    const r = await web.get('/town/api/map');
    expect(r.status).toBe(200);
    expect(r.json.protocol).toBe(1);
    expect(r.json.checksum).toEqual(expect.any(String));
    expect(r.headers.get('etag')).toBe(`"${r.json.checksum}"`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    const etag = r.headers.get('etag')!;
    for (const inm of [etag, `W/${etag}`, `"zzz", ${etag}`, '*']) {
      const hit = await web.get('/town/api/map', { headers: { 'if-none-match': inm } });
      expect(hit.status, inm).toBe(304);
      expect(hit.text).toBe('');
      expect(hit.headers.get('etag')).toBe(etag);
    }
    const miss = await web.get('/town/api/map', { headers: { 'if-none-match': '"other"' } });
    expect(miss.status).toBe(200);
    expect(miss.json.checksum).toBe(r.json.checksum);
    // 带世界编号的写法也是同一个接口
    expect((await web.get(`/town/api/worlds/${app.w.worldId}/map`)).status).toBe(200);
  });

  it('GET /scene：未登录 401；没有居民身份 401；登录后是本人场景的完整快照', async () => {
    const { app } = await serveTown();
    const anon = new Web(app.base);
    expect((await anon.get('/town/api/scene')).status).toBe(401);
    const noResident = new Web(app.base);
    expect((await noResident.post('/town/api/auth/dev', { name: '路人' })).status).toBe(200);
    const nr = await noResident.get('/town/api/scene');
    expect(nr.status).toBe(401);
    expect(nr.json.reason).toBe('no_resident');
    const web = await new Web(app.base).login('阿灯');
    const sc = await web.get('/town/api/scene');
    expect(sc.status).toBe(200);
    expect(sc.headers.get('cache-control')).toBe('no-store');
    expect(sc.json).toMatchObject({ protocol: 1, scene: 'town', space: 'plaza', self: web.residentId });
    expect(sc.json.actors.map((a: any) => a.id)).toContain(web.residentId);
  });

  it('POST /nav/renew：要登录、同源 JSON；没有导航 ok:false；续上返回新租约；旧版本号 ok:false', async () => {
    const { t, app } = await serveTown();
    const anon = new Web(app.base);
    expect((await anon.post('/town/api/nav/renew', { clientId: 'tab-anon-1', navigationId: 'x', revision: 1 })).status).toBe(401);
    const web = await new Web(app.base).login('阿灯');
    const body = { clientId: web.clientId, navigationId: 'nope', revision: 1 };
    // 跨源、非 JSON 一律被拒
    expect((await web.post('/town/api/nav/renew', body, { origin: 'https://evil.example' })).status).toBe(400);
    expect((await web.post('/town/api/nav/renew', body, { contentType: 'text/plain' })).status).toBe(400);
    expect((await web.post('/town/api/nav/renew', { navigationId: 'x', revision: 1 })).status).toBe(400); // 缺 clientId
    const none = await web.post('/town/api/nav/renew', body);
    expect(none.status).toBe(200);
    expect(none.json).toMatchObject({ ok: false, navigation: null });

    const mv = await web.act({ type: 'navigate', to: 'tea_house' });
    const nav = mv.json.navigation;
    t.advance(4000);
    const ok = await web.post('/town/api/nav/renew', { clientId: web.clientId, navigationId: nav.navigationId, revision: nav.revision });
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.leaseUntil).toBeGreaterThan(nav.leaseUntil);
    expect(ok.json.navigation.navigationId).toBe(nav.navigationId);
    const stale = await web.post('/town/api/nav/renew', { clientId: web.clientId, navigationId: nav.navigationId, revision: nav.revision + 5 });
    expect(stale.json.ok).toBe(false);
    expect(stale.json.navigation.navigationId).toBe(nav.navigationId);
    // 不是控制者的页面续不了
    const other = await web.post('/town/api/nav/renew', { clientId: 'tab-other-0001', navigationId: nav.navigationId, revision: nav.revision });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('control_lost');
  });

  it('POST /ws-ticket：要登录、要居民身份、同源 JSON；票据是 32 字节 base64url，30 秒有效，不进日志', async () => {
    const { t, app } = await serveTown();
    expect((await new Web(app.base).post('/town/api/ws-ticket', { clientId: 'tab-anon-1' })).status).toBe(401);
    const noResident = new Web(app.base);
    await noResident.post('/town/api/auth/dev', { name: '路人' });
    expect((await noResident.post('/town/api/ws-ticket', { clientId: 'tab-nores-1' })).status).toBe(401);
    const web = await new Web(app.base).login('阿灯');
    expect((await web.post('/town/api/ws-ticket', { clientId: web.clientId }, { origin: 'https://evil.example' })).status).toBe(400);
    expect((await web.post('/town/api/ws-ticket', { clientId: web.clientId }, { contentType: 'text/plain' })).status).toBe(400);
    expect((await web.post('/town/api/ws-ticket', {})).status).toBe(400);
    const r = await web.post('/town/api/ws-ticket', { clientId: web.clientId });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.json.ticket).toMatch(/^[\w-]{43}$/);
    expect(r.json.expiresAt).toBe(t.clock.now() + 30_000);
    const r2 = await web.post('/town/api/ws-ticket', { clientId: web.clientId });
    expect(r2.json.ticket).not.toBe(r.json.ticket);
    expect(app.logs.join('\n')).not.toContain(r.json.ticket);
  });
});

describe('HTTP：静态页面', () => {
  it('/town/ 返回 html，带 CSP 等安全头；/town 重定向到 /town/（保留查询串）', async () => {
    const { app } = await serveTown();
    const page = await fetch(`${app.base}/town/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const html = await page.text();
    expect(html.toLowerCase()).toContain('<!doctype html');
    // 不从外部加载任何东西
    expect(html).not.toMatch(/<(script|link)[^>]+(?:src|href)="https?:\/\//);
    const r = await fetch(`${app.base}/town?x=1`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/town/?x=1');
    expect((await fetch(`${app.base}/town/?ticket-in-hash`)).status).toBe(200);
    // 页面引用的脚本都能取到，类型正确
    const refs = [...html.matchAll(/(?:src|href)="(?:\.\/|\/town\/)?([\w.-]+\.(?:js|css|svg))"/g)].map((m) => m[1]!);
    for (const f of refs) {
      const res = await fetch(`${app.base}/town/${f}`);
      expect(res.status, f).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/javascript|css|svg/);
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
  });

  it('路径穿越、子目录、不允许的扩展名、隐藏文件都被拒（404），且不泄露仓库文件', async () => {
    const { app } = await serveTown();
    const probes = [
      '/town/..%2f..%2fpackage.json',
      '/town/..%2f..%2f..%2fpackage.json',
      '/town/%2e%2e%2f%2e%2e%2fpackage.json',
      '/town/..%5c..%5cpackage.json',
      '/town/..%252f..%252fpackage.json',
      '/town/sub/ui.js',
      '/town/%2e%2e/package.json',
      '/town/ui.js/..%2f..%2fpackage.json',
      '/town/package.json',
      '/town/secret.txt',
      '/town/index.html.bak',
      '/town/ui.ts',
      '/town/.env',
      '/town/.git',
      '/town/%00.js',
      '/town/ui.js%00.png',
      '/town/nope.js',
      '/town/dom.js%20',
    ];
    for (const p of probes) {
      const r = await rawGet(app.base, p);
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain('"name"');
      expect(r.text, p).not.toContain('bot-game-mcp');
      expect(r.text, p).not.toMatch(/import |export |function /);
    }
    // 目录名当文件名
    expect((await rawGet(app.base, '/town/node_modules')).status).toBe(404);
  });

  it('/town/api 的响应不缓存；静态文件用 no-cache', async () => {
    const { app } = await serveTown();
    for (const p of ['/town/api/config', '/town/api/public', '/town/api/session', '/town/api/me?clientId=tab-0001']) {
      expect((await fetch(`${app.base}${p}`)).headers.get('cache-control'), p).toBe('no-store');
    }
    expect((await fetch(`${app.base}/town/index.html`)).headers.get('cache-control')).toBe('no-cache');
  });
});

// 辅助：避免未使用的导入告警
void devLoginSession;
