/**
 * 栖灯镇的空间同步通道（/town/ws）：真的 HTTP 服务器 + `ws` 客户端。
 * 世界时间用 FakeClock；WebSocket 的超时、合并间隔用真实计时器，所以这里的等待都带明确的超时。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mountTown, type TownHttpOptions } from '../../src/world/http.js';
import { sceneKeyOfResident, whereabouts } from '../../src/world/space.js';
import { Actor, makeTown, type Town } from './helpers.js';

// ───────────────────────── 测试辅助 ─────────────────────────

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface App {
  t: Town;
  base: string;
  wsUrl: string;
  close: () => Promise<void>;
}

async function serve(opts: TownHttpOptions = {}, townOpts?: Parameters<typeof makeTown>[0]): Promise<App> {
  const t = makeTown(townOpts);
  const app = express();
  const closeTown = mountTown(app, t.w, () => undefined, { requestsPerMinute: 100_000, ...opts });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  closeTown.attach(server);
  const port = (server.address() as AddressInfo).port;
  let closed = false;
  const handle: App = {
    t,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/town/ws`,
    close: async () => {
      if (closed) return;
      closed = true;
      closeTown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  cleanups.push(handle.close);
  return handle;
}

let tab = 5000;
/** 一位通过 HTTP 登录并进入小镇的网页用户。 */
class User {
  cookie = '';
  clientId = `ws-tab-${++tab}`;
  residentId = '';
  actor!: Actor;
  constructor(readonly app: App) {}

  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(this.app.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.app.base, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('town_session='));
    if (sc && !/Max-Age=0/i.test(sc)) this.cookie = sc.split(';')[0]!;
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async login(name: string): Promise<this> {
    expect((await this.post('/town/api/auth/dev', { name })).status).toBe(200);
    const e = await this.post('/town/api/enter', { clientId: this.clientId, profile: { name } });
    expect(e.status).toBe(200);
    this.residentId = e.json.residentId;
    const pid = this.app.t.w.db.get('SELECT principal_id FROM residents WHERE resident_id = ?', this.residentId)!.principal_id as string;
    this.actor = new Actor(this.app.t, pid, this.residentId, `web:${this.clientId}`, name);
    return this;
  }

  async ticket(clientId = this.clientId): Promise<string> {
    const r = await this.post('/town/api/ws-ticket', { clientId });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.ticket;
  }
}

class Client {
  msgs: any[] = [];
  closed: { code: number } | null = null;
  private poke: (() => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      this.notify();
    });
    ws.on('close', (code) => {
      this.closed = { code };
      this.notify();
    });
    ws.on('error', () => undefined);
  }
  private notify() {
    for (const f of this.poke.splice(0)) f();
  }

  /** 握手成功返回客户端；被拒绝时抛出 {status}。 */
  static open(url: string, o: { origin?: string; autoPong?: boolean; cookie?: string } = {}): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { ...(o.origin ? { origin: o.origin } : {}), ...(o.cookie ? { headers: { cookie: o.cookie } } : {}), ...(o.autoPong === false ? { autoPong: false } : {}) });
      const c = new Client(ws);
      cleanups.push(() => ws.terminate());
      ws.once('open', () => resolve(c));
      ws.once('unexpected-response', (_req, res) => {
        res.resume();
        reject(Object.assign(new Error(`handshake ${res.statusCode}`), { status: res.statusCode }));
      });
      ws.once('error', (e) => reject(e));
    });
  }

  send(m: unknown): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }
  hello(ticket: string, extra: Record<string, unknown> = {}): void {
    this.send({ t: 'hello', v: 1, ticket, ...extra });
  }

  /** 等到第 from 条之后出现满足条件的消息（带超时）。 */
  async waitFor(pred: (m: any) => boolean, ms = 3000, from = 0): Promise<any> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.msgs.slice(from).find(pred);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等消息超时。已收到：${JSON.stringify(this.msgs.slice(from)).slice(0, 600)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.poke.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
  type = (t: string, ms?: number, from?: number) => this.waitFor((m) => m.t === t, ms, from);

  async waitClosed(ms = 3000): Promise<number> {
    const deadline = Date.now() + ms;
    while (!this.closed) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('等连接关闭超时');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.poke.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return this.closed.code;
  }
  count = (t: string, from = 0) => this.msgs.slice(from).filter((m) => m.t === t).length;
}

/** 登录、取票、连上并完成 hello，等到第一份 scene。 */
async function connect(app: App, name: string, o: { cursor?: string; clientId?: string } = {}): Promise<{ u: User; c: Client; hello: any }> {
  const u = await new User(app).login(name);
  const c = await Client.open(app.wsUrl);
  c.hello(await u.ticket(o.clientId), o.cursor ? { cursor: o.cursor } : {});
  const hello = await c.type('hello');
  await c.type('scene');
  return { u, c, hello };
}
async function attach(app: App, u: User, o: { cursor?: string } = {}): Promise<{ c: Client; hello: any }> {
  const c = await Client.open(app.wsUrl);
  c.hello(await u.ticket(), o.cursor ? { cursor: o.cursor } : {});
  return { c, hello: await c.type('hello') };
}

/** 轮询一个条件（世界状态的变化要等 close 事件传到服务器）。 */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等条件超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ───────────────────────── 票据与握手 ─────────────────────────

describe('WS：票据与握手', () => {
  it('hello 之后先收到 hello 再收到 scene；hello 带居民编号、地图校验值与续租间隔', async () => {
    const app = await serve();
    const { u, c, hello } = await connect(app, '阿灯');
    expect(c.msgs[0].t).toBe('hello');
    expect(c.msgs[1].t).toBe('scene');
    expect(hello).toMatchObject({ t: 'hello', v: 1, resident: u.residentId, renewEveryMs: app.t.w.params.navRenewEveryMs, serverTime: app.t.clock.now() });
    expect(hello.map).toEqual({ mapVersion: app.t.w.map.mapVersion, checksum: app.t.w.map.checksum });
    expect(hello.cursor).toMatch(/^r/);
    const sc = c.msgs[1];
    expect(sc).toMatchObject({ protocol: 1, scene: 'town', space: 'plaza', self: u.residentId });
    expect(sc.actors.map((a: any) => a.id)).toContain(u.residentId);
  });

  it('票据一次性：第二次用同一张被拒，以 4401 关闭', async () => {
    const app = await serve();
    const u = await new User(app).login('阿灯');
    const ticket = await u.ticket();
    const a = await Client.open(app.wsUrl);
    a.hello(ticket);
    await a.type('hello');
    const b = await Client.open(app.wsUrl);
    b.hello(ticket);
    expect((await b.type('error')).code).toBe('unauthenticated');
    expect(await b.waitClosed()).toBe(4401);
  });

  it('票据 30 秒过期；瞎编的票据、格式不对的票据也是 4401', async () => {
    const app = await serve();
    const u = await new User(app).login('阿灯');
    const old = await u.ticket();
    app.t.clock.advance(30_001);
    const a = await Client.open(app.wsUrl);
    a.hello(old);
    await a.type('error');
    expect(await a.waitClosed()).toBe(4401);
    for (const bad of ['x'.repeat(43), '', 123, null, 'a'.repeat(500)]) {
      const c = await Client.open(app.wsUrl);
      c.send({ t: 'hello', v: 1, ticket: bad });
      await c.type('error');
      expect(await c.waitClosed()).toBe(4401);
    }
  });

  it('票据绑定身份：谁取的票就是谁；换到别人的 hello 里也只能得到取票人', async () => {
    const app = await serve();
    const a = await new User(app).login('阿灯');
    const b = await new User(app).login('小满');
    const ta = await a.ticket();
    const tb = await b.ticket();
    const c1 = await Client.open(app.wsUrl);
    c1.hello(tb);
    expect((await c1.type('hello')).resident).toBe(b.residentId);
    const c2 = await Client.open(app.wsUrl);
    c2.hello(ta);
    expect((await c2.type('hello')).resident).toBe(a.residentId);
  });

  it('每个 principal 最多 8 张未用票据：超了作废最旧的', async () => {
    const app = await serve();
    const u = await new User(app).login('阿灯');
    const tickets: string[] = [];
    for (let i = 0; i < 9; i++) tickets.push(await u.ticket());
    const first = await Client.open(app.wsUrl);
    first.hello(tickets[0]!);
    await first.type('error');
    expect(await first.waitClosed()).toBe(4401);
    const last = await Client.open(app.wsUrl);
    last.hello(tickets[8]!);
    await last.type('hello');
    const second = await Client.open(app.wsUrl);
    second.hello(tickets[1]!);
    await second.type('hello');
  });

  it('Origin：跨源被 403 拒绝；同源、没有 Origin、等于 publicUrl 的源都放行；放行了也仍然需要票据', async () => {
    const app = await serve();
    (app.t.w as unknown as { publicUrl: string }).publicUrl = 'https://town.example.com/';
    await expect(Client.open(app.wsUrl, { origin: 'https://evil.example' })).rejects.toMatchObject({ status: 403 });
    await expect(Client.open(app.wsUrl, { origin: 'null' })).rejects.toMatchObject({ status: 403 });
    await expect(Client.open(app.wsUrl, { origin: `${app.base}.evil.example` })).rejects.toMatchObject({ status: 403 });
    const u = await new User(app).login('阿灯');
    for (const origin of [app.base, 'https://town.example.com', undefined]) {
      const c = await Client.open(app.wsUrl, origin ? { origin } : {});
      c.hello(await u.ticket());
      await c.type('hello');
    }
    // 没票据就是没票据
    const bare = await Client.open(app.wsUrl, { origin: app.base });
    bare.send({ t: 'ping', n: 1 });
    await bare.type('error');
    expect(await bare.waitClosed()).toBe(4401);
  });

  it('不信任 Cookie：浏览器自动带的会话 Cookie 换不来身份，必须先 hello', async () => {
    const app = await serve();
    const u = await new User(app).login('阿灯');
    const c = await Client.open(app.wsUrl, { origin: app.base, cookie: u.cookie });
    await new Promise((r) => setTimeout(r, 150));
    expect(c.msgs).toEqual([]); // 不会主动给任何东西
    c.send({ t: 'renew', navigationId: 'x', revision: 1 });
    expect((await c.type('error')).code).toBe('bad_request');
    expect(await c.waitClosed()).toBe(4401);
  });

  it('没发 hello 超时被关；第一条不是 hello 立即关；hello 后再 hello 报错但不关', async () => {
    const app = await serve({ ws: { helloTimeoutMs: 150 } });
    const slow = await Client.open(app.wsUrl);
    expect((await slow.type('error')).code).toBe('hello_timeout');
    expect(await slow.waitClosed()).toBe(4408);

    const wrong = await Client.open(app.wsUrl);
    wrong.send({ t: 'ping', n: 1 });
    expect((await wrong.type('error')).code).toBe('bad_request');
    expect(await wrong.waitClosed()).toBe(4401);

    const u = await new User(app).login('阿灯');
    const c = await Client.open(app.wsUrl);
    c.hello(await u.ticket());
    await c.type('hello');
    c.hello(await u.ticket());
    expect((await c.type('error')).code).toBe('bad_request');
    c.send({ t: 'ping', n: 7 });
    expect(await c.type('pong')).toMatchObject({ n: 7, serverTime: app.t.clock.now() });
    // 已经过了 hello 超时，连接仍然开着
    await new Promise((r) => setTimeout(r, 250));
    expect(c.closed).toBeNull();
  });

  it('帧上限 4 KiB（超了关连接）；二进制帧被拒；坏 JSON 与未知类型只报错不关', async () => {
    const app = await serve();
    const { c } = await connect(app, '阿灯');
    c.send('not json');
    expect((await c.type('error', 3000)).code).toBe('bad_request');
    c.send('[1,2]');
    c.send({ t: 'dance' });
    c.send({ t: 'actions', action: { type: 'speak', text: 'hi' } }); // 耐久动作不走 WebSocket
    await until(() => c.count('error') >= 4);
    expect(c.closed).toBeNull();
    c.send({ t: 'ping', n: 1 });
    await c.type('pong');

    c.send(JSON.stringify({ t: 'ping', n: 1, pad: 'x'.repeat(5000) }));
    expect(await c.waitClosed()).toBe(1009);

    const { c: c2 } = await connect(app, '小满');
    c2.ws.send(Buffer.from([1, 2, 3]));
    expect(await c2.waitClosed()).toBe(1003);
  });
});

// ───────────────────────── 场景同步 ─────────────────────────

describe('WS：scene 同步', () => {
  it('别人 navigate 后收到含折线的 scene，停步后收到不含折线的', async () => {
    const app = await serve();
    const { u: a, c } = await connect(app, '阿灯');
    const b = await new User(app).login('小满');
    const mark = c.msgs.length;
    const out = b.actor.act('navigate', { to: 'tea_house' });
    expect(out.status).toBe('accepted');
    const walking = await c.waitFor((m) => m.t === 'scene' && m.actors.some((x: any) => x.id === b.residentId && x.nav), 3000, mark);
    const bv = walking.actors.find((x: any) => x.id === b.residentId);
    expect(bv.nav.points.length).toBeGreaterThanOrEqual(2);
    expect(bv.nav.id).toBe(out.navigation.navigationId);
    expect(walking.self).toBe(a.residentId);

    const mark2 = c.msgs.length;
    b.actor.act('stop_navigation');
    const stopped = await c.waitFor((m) => m.t === 'scene' && m.actors.some((x: any) => x.id === b.residentId && !x.nav), 3000, mark2);
    expect(stopped.actors.find((x: any) => x.id === b.residentId).nav).toBeUndefined();
  });

  it('有人进镇、离开：站着不动也会推新的 scene（不用等她第一次走动）', async () => {
    const app = await serve();
    const { u, c } = await connect(app, '阿灯');
    const from = c.msgs.length;
    const other = await new User(app).login('小满');
    const withOther = await c.waitFor((m) => m.t === 'scene' && m.actors.some((x: any) => x.id === other.residentId), 3000, from);
    expect(withOther.actors.map((x: any) => x.id).sort()).toEqual([u.residentId, other.residentId].sort());
    const from2 = c.msgs.length;
    other.actor.leave();
    const without = await c.waitFor((m) => m.t === 'scene' && !m.actors.some((x: any) => x.id === other.residentId), 3000, from2);
    expect(without.actors.map((x: any) => x.id)).toEqual([u.residentId]);
  });

  it('进了自己家：收到 home 场景的快照，留在外面的人的快照里没有她', async () => {
    const app = await serve();
    const { u: a, c: ca } = await connect(app, '阿灯');
    const { u: b, c: cb } = await connect(app, '小满');
    const markB = cb.msgs.length;
    a.actor.go('home');
    const inside = await ca.waitFor((m) => m.t === 'scene' && m.scene === 'home', 3000);
    expect(inside.space).toBe(`home:${a.residentId}`);
    expect(inside.actors.map((x: any) => x.id)).toEqual([a.residentId]);
    // 外面的人：最新一份快照里不再有她
    const outside = await cb.waitFor((m) => m.t === 'scene' && m.scene === 'town' && !m.actors.some((x: any) => x.id === a.residentId), 3000, markB);
    expect(outside.actors.map((x: any) => x.id)).toContain(b.residentId);
    // 之后再来的快照也不会带她
    const idx = cb.msgs.indexOf(outside);
    b.actor.act('navigate', { to: 'tea_house' });
    await cb.waitFor((m) => m.t === 'scene' && m.actors.some((x: any) => x.id === b.residentId && x.nav), 3000, idx);
    for (const m of cb.msgs.slice(idx).filter((x) => x.t === 'scene')) expect(JSON.stringify(m)).not.toContain(a.residentId);
  });

  it('发送合并：短时间内多次变化，每秒不超过 10 帧', async () => {
    const app = await serve();
    const { u, c } = await connect(app, '阿灯');
    const w = app.t.w;
    const key = sceneKeyOfResident(w, u.residentId)!;
    const from = c.msgs.length;
    // 先是同一瞬间 50 次变化：合并成很少几帧（之后没有新的变化，机器再慢帧数也不会变多）
    for (let i = 0; i < 50; i++) w.commit(() => w.bumpSpace(key));
    await c.type('scene', 3000, from);
    await new Promise((r) => setTimeout(r, 250));
    expect(c.count('scene', from)).toBeLessThanOrEqual(3);
    // 再是一秒左右每 5 毫秒一次变化：帧数不超过「经过的时间 / 100 毫秒」（按实际经过的时间算，慢机器上也成立）
    const from2 = c.msgs.length;
    const start = Date.now();
    while (Date.now() - start < 1000) {
      w.commit(() => w.bumpSpace(key));
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 150));
    const elapsed = Date.now() - start;
    const n = c.count('scene', from2);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 1);
    // 最后一帧是最新的：没有哪次变化被合并丢掉
    const last = c.msgs.filter((m) => m.t === 'scene').at(-1);
    expect(last.serverTime).toBe(w.now());
  });

  it('别的场景的变化不会触发这条连接的快照', async () => {
    const app = await serve();
    const { c } = await connect(app, '阿灯');
    const from = c.msgs.length;
    app.t.w.commit(() => app.t.w.bumpSpace('home|nobody'));
    await new Promise((r) => setTimeout(r, 300));
    expect(c.count('scene', from)).toBe(0);
  });
});

// ───────────────────────── 续租与断开 ─────────────────────────

describe('WS：renew 与断开', () => {
  it('renew：成功 / 旧版本号 ok:false / 没有导航 ok:false / 非控制者 control_lost（连接不关）', async () => {
    const app = await serve();
    const { u, c } = await connect(app, '阿灯');
    c.send({ t: 'renew', navigationId: 'none', revision: 1 });
    expect(await c.type('renewed')).toMatchObject({ ok: false, navigation: null });

    const nav = u.actor.act('navigate', { to: 'tea_house' }).navigation;
    app.t.advance(4000);
    const from = c.msgs.length;
    c.send({ t: 'renew', navigationId: nav.navigationId, revision: nav.revision });
    const ok = await c.type('renewed', 3000, from);
    expect(ok.ok).toBe(true);
    expect(ok.leaseUntil).toBeGreaterThan(nav.leaseUntil);
    expect(ok.navigation.navigationId).toBe(nav.navigationId);

    const from2 = c.msgs.length;
    c.send({ t: 'renew', navigationId: nav.navigationId, revision: nav.revision + 3 });
    const stale = await c.type('renewed', 3000, from2);
    expect(stale.ok).toBe(false);
    expect(stale.leaseUntil).toBeUndefined();
    expect(stale.navigation.revision).toBe(nav.revision);

    // 另一个客户端编号的连接：不握着控制权
    const other = await attach(app, u);
    const o2 = await Client.open(app.wsUrl);
    o2.hello(await u.ticket('someone-else-0001'));
    await o2.type('hello');
    o2.send({ t: 'renew', navigationId: nav.navigationId, revision: nav.revision });
    expect((await o2.type('error')).code).toBe('control_lost');
    expect(o2.closed).toBeNull();
    o2.send({ t: 'ping', n: 1 });
    await o2.type('pong');
    void other;
  });

  it('握着控制权的连接正常关闭（1000）：立即停步；异常断开：不停，等租约自己到期', async () => {
    const app = await serve();
    const w = app.t.w;
    const { u, c } = await connect(app, '阿灯');
    const walking = () => whereabouts(w, w.mustResident(u.residentId), w.now()).navigation;
    u.actor.act('navigate', { to: 'tea_house' });
    expect(walking()).not.toBeNull();
    c.ws.close(1000);
    await until(() => walking() === null);
    expect(app.t.w.readResidentEvents(u.residentId, undefined).resync).toBe(false);

    // 再走一趟，这次断线（terminate = 1006）
    u.actor.act('navigate', { to: 'bookshop' });
    expect(walking()).not.toBeNull();
    const { c: c2 } = await attach(app, u);
    c2.ws.terminate();
    await new Promise((r) => setTimeout(r, 300));
    expect(walking()).not.toBeNull(); // 还在走
    app.t.advance(w.params.navLeaseMs + 1000);
    expect(walking()).toBeNull(); // 租约到期才停

    // 1001（页面离开）和 1000 一样算明确断开
    u.actor.act('navigate', { to: 'garden' });
    const { c: c3 } = await attach(app, u);
    expect(walking()).not.toBeNull();
    c3.ws.close(1001);
    await until(() => walking() === null);
  });

  it('同一个客户端重连：新旧两条连接并存时关掉旧的不停步，最后一条正常关闭才停', async () => {
    const app = await serve();
    const w = app.t.w;
    const { u, c } = await connect(app, '阿灯');
    const walking = () => whereabouts(w, w.mustResident(u.residentId), w.now()).navigation;
    u.actor.act('navigate', { to: 'tea_house' });
    const { c: c2 } = await attach(app, u); // 同一个 clientId 的第二条连接
    c.ws.close(1000);
    await c.waitClosed();
    await new Promise((r) => setTimeout(r, 200)); // 等 close 事件传到服务器
    expect(walking()).not.toBeNull();
    c2.ws.close(1000);
    await until(() => walking() === null);
  });

  it('服务器先关的连接（登出）不算客户端明确离开：路不会因此立刻停', async () => {
    const app = await serve();
    const w = app.t.w;
    const { u, c } = await connect(app, '阿灯');
    u.actor.act('navigate', { to: 'tea_house' });
    // 客户端收到服务器的关闭帧后，照常用 1000 结束自己这一侧
    c.ws.on('close', () => undefined);
    expect((await u.post('/town/api/auth/logout', {})).status).toBe(200);
    expect(await c.waitClosed()).toBe(4403);
    await new Promise((r) => setTimeout(r, 100));
    expect(whereabouts(w, w.mustResident(u.residentId), w.now()).navigation).not.toBeNull();
  });

  it('不握着控制权的连接正常关闭，不影响别的页面在走的路', async () => {
    const app = await serve();
    const w = app.t.w;
    const { u } = await connect(app, '阿灯');
    const o = await Client.open(app.wsUrl);
    o.hello(await u.ticket('someone-else-0002'));
    await o.type('hello');
    u.actor.act('navigate', { to: 'tea_house' });
    o.ws.close(1000);
    await o.waitClosed();
    await new Promise((r) => setTimeout(r, 200));
    expect(whereabouts(w, w.mustResident(u.residentId), w.now()).navigation).not.toBeNull();
  });
});

// ───────────────────────── 事件 ─────────────────────────

describe('WS：耐久事件', () => {
  it('耐久私有事件经 WebSocket 送达，带游标；用 hello.cursor 续传只补缺的', async () => {
    const app = await serve();
    const w = app.t.w;
    const { u, c, hello } = await connect(app, '阿灯');
    const emit = (text: string) => w.commit(() => w.emitTo([u.residentId], 'notice', { text }));
    emit('第一条');
    const first = await c.type('events');
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({ type: 'notice', data: { text: '第一条' }, id: expect.stringMatching(/^r/) });
    expect(first.cursor).toBe(first.events[0].id);
    expect(first.cursor).not.toBe(hello.cursor);
    // 与 SSE / 长轮询同一套投影
    expect(w.readResidentEvents(u.residentId, hello.cursor).events[0]).toMatchObject({ id: first.events[0].id, type: 'notice', data: { text: '第一条' } });

    c.ws.close(1000);
    await c.waitClosed();
    emit('断线期间');
    emit('断线期间二');
    const r = await attach(app, u, { cursor: first.cursor });
    expect(r.hello.cursor).toBe(first.cursor);
    const resumed = await r.c.type('events');
    expect(resumed.events.map((e: any) => e.data.text)).toEqual(['断线期间', '断线期间二']);
    expect(r.c.msgs.some((m) => m.t === 'resync')).toBe(false);
    expect(resumed.events.some((e: any) => e.data.text === '第一条')).toBe(false);
  });

  it('没带游标从当前水位开始（不回放历史）；坏游标收到 resync 和新游标', async () => {
    const app = await serve();
    const w = app.t.w;
    const { u, c } = await connect(app, '阿灯');
    w.commit(() => w.emitTo([u.residentId], 'notice', { text: '旧事' }));
    await c.type('events');
    const fresh = await attach(app, u);
    await new Promise((r) => setTimeout(r, 150));
    expect(fresh.c.count('events')).toBe(0);

    const bad = await attach(app, u, { cursor: 'r1.garbage' });
    expect(bad.hello.cursor).toBe(w.cursorOf(u.residentId));
    const rs = await bad.c.type('resync');
    expect(rs.cursor).toBe(w.cursorOf(u.residentId));
    // 别的居民的游标同样无效
    const other = await new User(app).login('小满');
    const foreign = await attach(app, u, { cursor: w.cursorOf(other.residentId) });
    await foreign.c.type('resync');
  });
});

// ───────────────────────── 关闭、限额与保活 ─────────────────────────

describe('WS：关闭、限额与保活', () => {
  it('居民离开小镇：连接被关（4403），之后不再收到她的事件', async () => {
    const app = await serve();
    const { u, c } = await connect(app, '阿灯');
    u.actor.leave();
    expect((await c.type('error')).code).toBe('revoked');
    expect(await c.waitClosed()).toBe(4403);
  });

  it('登出：这个登录会话的连接被关、没用过的票据作废；同一个人在别的设备上的会话不受影响', async () => {
    const app = await serve();
    const { u, c } = await connect(app, '阿灯');
    // 同一个人在另一台设备上登录：另一个会话、另一个 clientId
    const other = await new User(app).login('阿灯');
    expect(other.residentId).toBe(u.residentId);
    const { c: c2 } = await attach(app, other);
    const spare = await u.ticket();
    expect((await u.post('/town/api/auth/logout', {})).status).toBe(200);
    expect(await c.waitClosed()).toBe(4403);
    const again = await Client.open(app.wsUrl);
    again.hello(spare);
    await again.type('error');
    expect(await again.waitClosed()).toBe(4401);
    // 另一台设备还连着，照常能用
    c2.send({ t: 'ping', n: 7 });
    expect(await c2.type('pong')).toMatchObject({ n: 7 });
    expect(c2.closed).toBeNull();
  });

  it('登录会话过期：用它连上的 WebSocket 跟着断开（4403），不会比会话活得更久', async () => {
    const app = await serve({ ws: { pingMs: 40 } });
    const { u, c } = await connect(app, '阿灯');
    const other = await connect(app, '小满');
    // 让阿灯的会话过期（只动她的；小满的不受影响）
    const pid = app.t.w.db.get('SELECT principal_id FROM residents WHERE resident_id = ?', u.residentId)!.principal_id;
    app.t.w.db.db.prepare('UPDATE sessions SET expires_at = ? WHERE principal_id = ?').run(app.t.clock.t - 1, pid);
    await c.waitFor((m) => m.t === 'error' && m.code === 'revoked');
    expect(await c.waitClosed()).toBe(4403);
    // 过期的会话也取不到新票
    expect((await u.post('/town/api/ws-ticket', { clientId: u.clientId })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 150));
    expect(other.c.closed).toBeNull();
  });

  it('世界先于连接关闭（数据库已关）：探活和续租不去读库，不抛未捕获的异常', async () => {
    const app = await serve({ ws: { pingMs: 30 } });
    const { u, c } = await connect(app, '阿灯');
    const nav = u.actor.act('navigate', { to: 'tea_house' }).navigation;
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onError);
    try {
      app.t.w.close();
      c.send({ t: 'renew', navigationId: nav.navigationId, revision: nav.revision });
      // 等几轮探活
      await new Promise((r) => setTimeout(r, 150));
    } finally {
      process.off('uncaughtException', onError);
    }
    expect(errors).toEqual([]);
  });

  it('取票之后、hello 之前会话就失效了：票据换不来连接', async () => {
    const app = await serve();
    const u = await new User(app).login('阿灯');
    const ticket = await u.ticket();
    app.t.w.db.db.prepare('UPDATE sessions SET revoked_at = ?').run(app.t.clock.t);
    const c = await Client.open(app.wsUrl);
    c.hello(ticket);
    expect(await c.type('error')).toMatchObject({ code: 'unauthenticated' });
    expect(await c.waitClosed()).toBe(4401);
  });

  it('续租有限流：一口气发一堆 renew 只处理前几条，其余回 rate_limited，连接不断', async () => {
    const app = await serve();
    const { u, c } = await connect(app, '阿灯');
    const nav = u.actor.act('navigate', { to: 'tea_house' }).navigation;
    const from = c.msgs.length;
    for (let i = 0; i < 20; i++) c.send({ t: 'renew', navigationId: nav.navigationId, revision: nav.revision });
    c.send({ t: 'ping', n: 1 });
    await c.waitFor((m) => m.t === 'pong', 3000, from);
    const renewed = c.msgs.slice(from).filter((m) => m.t === 'renewed').length;
    const limited = c.msgs.slice(from).filter((m) => m.t === 'error' && m.code === 'rate_limited').length;
    expect(renewed).toBeGreaterThanOrEqual(1);
    expect(renewed).toBeLessThanOrEqual(8);
    expect(renewed + limited).toBe(20);
    expect(c.closed).toBeNull();
  });

  it('世界所在的服务关闭时全部连接关闭', async () => {
    const app = await serve();
    const { c } = await connect(app, '阿灯');
    await app.close();
    await c.waitClosed();
    expect(c.closed).not.toBeNull();
  });

  it('连接数上限：每个 IP 超了在握手阶段 429；每位居民超了 hello 后拒绝；关掉一个又能连', async () => {
    const app = await serve({ maxStreamsPerIp: 2, ws: { maxPerResident: 1 } });
    const u1 = await new User(app).login('阿灯');
    const a = await Client.open(app.wsUrl);
    a.hello(await u1.ticket());
    await a.type('hello');
    // 同一居民第二条：握手放行，hello 阶段拒绝
    const dup = await Client.open(app.wsUrl);
    dup.hello(await u1.ticket());
    expect((await dup.type('error')).code).toBe('rate_limited');
    expect(await dup.waitClosed()).toBe(1013);
    // 同一 IP 同时 2 条（a 和一条还没 hello 的），第 3 条握手就被拒
    const idle = await Client.open(app.wsUrl);
    await expect(Client.open(app.wsUrl)).rejects.toMatchObject({ status: 429 });
    idle.ws.terminate();
    await idle.waitClosed();
    const again = await Client.open(app.wsUrl);
    again.ws.terminate();
  });

  it('心跳：不回协议层 pong 的客户端被断开；会回的不受影响', async () => {
    const app = await serve({ ws: { pingMs: 40 } });
    const u = await new User(app).login('阿灯');
    const dead = await Client.open(app.wsUrl, { autoPong: false });
    dead.hello(await u.ticket());
    await dead.type('hello');
    const live = await attach(app, await new User(app).login('小满'));
    expect(await dead.waitClosed(3000)).toBe(1006);
    await new Promise((r) => setTimeout(r, 200));
    expect(live.c.closed).toBeNull();
  });

  it('别的 upgrade 路径不受影响（不被我们接走）', async () => {
    const app = await serve();
    const ws = new WebSocket(`${app.wsUrl.replace('/town/ws', '/other/ws')}`);
    cleanups.push(() => ws.terminate());
    ws.on('error', () => undefined);
    await new Promise<void>((r) => {
      ws.once('close', () => r());
      setTimeout(r, 2000);
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED); // 和没挂 upgrade 监听时一样被直接断开
  });
});
