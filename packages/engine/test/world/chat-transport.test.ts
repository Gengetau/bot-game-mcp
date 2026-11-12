/**
 * 聊天的各个入口：HTTP、WebSocket、MCP 走同一套规则（受众、额度、对局中只读、AI 唤醒）。
 * 服务层的规则细节在 chat.test.ts；这里只验证入口：权限、格式、共享额度、推送。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { mountTown } from '../../src/world/http.js';
import { Actor, makeTown, type Town } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

// ───────────────────────── HTTP / WebSocket ─────────────────────────

interface App {
  t: Town;
  base: string;
  wsUrl: string;
}

async function serve(townOpts?: Parameters<typeof makeTown>[0]): Promise<App> {
  const t = makeTown(townOpts);
  const app = express();
  const closeTown = mountTown(app, t.w, () => undefined, { requestsPerMinute: 100_000 });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  closeTown.attach(server);
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    closeTown();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { t, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/town/ws` };
}

let tabN = 100;
class User {
  cookie = '';
  clientId = `chat-tab-${++tabN}`;
  residentId = '';
  actor!: Actor;
  constructor(readonly app: App) {}

  async req(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const res = await fetch(this.app.base + path, {
      method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json', origin: this.app.base } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const sc = res.headers.getSetCookie().find((c) => c.startsWith('town_session='));
    if (sc && !/Max-Age=0/i.test(sc)) this.cookie = sc.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 不是 JSON */
    }
    return { status: res.status, json, text };
  }

  async login(name: string): Promise<this> {
    expect((await this.req('POST', '/town/api/auth/dev', { name })).status).toBe(200);
    const e = await this.req('POST', '/town/api/enter', { clientId: this.clientId, profile: { name } });
    expect(e.status, e.text).toBe(200);
    this.residentId = e.json.residentId;
    const pid = this.app.t.w.db.get('SELECT principal_id FROM residents WHERE resident_id = ?', this.residentId)!.principal_id as string;
    this.actor = new Actor(this.app.t, pid, this.residentId, `web:${this.clientId}`, name);
    return this;
  }

  /** 像浏览器那样：读最新视图拿期望值，再提交动作。 */
  async act(action: Record<string, unknown>, requestId?: string): Promise<{ status: number; json: any }> {
    const v = (await this.req('GET', `/town/api/me?clientId=${this.clientId}`)).json;
    return this.req('POST', '/town/api/actions', {
      clientId: this.clientId,
      requestId: requestId ?? `chat-req-${++tabN}-${Math.random().toString(36).slice(2, 8)}`,
      actionWindow: v.actionWindow,
      expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: v.context.activityId },
      action,
    });
  }
}

describe('HTTP：GET /town/api/town-chat', () => {
  it('匿名读不到：没有登录 401；公开接口里没有公屏内容', async () => {
    const app = await serve();
    const a = await new User(app).login('阿灯');
    expect((await a.act({ type: 'say_town', text: 'HTTP-公屏-暗号' })).status).toBe(200);
    const anon = new User(app);
    for (const path of ['/town/api/town-chat', '/town/api/town-chat?after=x', '/town/api/worlds/town/town-chat']) {
      const r = await anon.req('GET', path);
      expect(r.status, path).toBe(401);
      expect(r.text).not.toContain('暗号');
    }
    for (const path of ['/town/api/public', '/town/api/config', '/town/api/public/report', '/town/api/map']) {
      expect((await anon.req('GET', path)).text, path).not.toContain('暗号');
    }
  });

  it('已登录的居民读保留期内的历史：首屏最近一页，before 往前翻，after 追新；坏游标返回 resync 而不是全量', async () => {
    const app = await serve({ params: { townChatPerMinute: 600, townChatBurst: 100 } });
    const a = await new User(app).login('阿灯');
    const b = await new User(app).login('小岚');
    for (let i = 0; i < 7; i++) expect((await a.act({ type: 'say_town', text: `第${i}句` })).status).toBe(200);
    const first = (await b.req('GET', '/town/api/town-chat?limit=3')).json;
    expect(first.messages.map((m: any) => m.text)).toEqual(['第4句', '第5句', '第6句']);
    expect(first.messages[0]).toMatchObject({ kind: 'chat', mine: false, from: { id: a.residentId, name: '阿灯' } });
    const older = (await b.req('GET', `/town/api/town-chat?limit=3&before=${encodeURIComponent(first.older)}`)).json;
    expect(older.messages.map((m: any) => m.text)).toEqual(['第1句', '第2句', '第3句']);
    expect((await b.req('GET', `/town/api/town-chat?after=${encodeURIComponent(first.cursor)}`)).json.messages).toEqual([]);
    await a.act({ type: 'say_town', text: '追新' });
    expect((await b.req('GET', `/town/api/town-chat?after=${encodeURIComponent(first.cursor)}`)).json.messages.map((m: any) => m.text)).toEqual(['追新']);
    const bad = (await b.req('GET', '/town/api/town-chat?after=nonsense')).json;
    expect(bad).toMatchObject({ resync: true, messages: [] });
    // 别人的游标在我这里无效
    const aCursor = (await a.req('GET', '/town/api/town-chat?limit=1')).json.cursor;
    expect((await b.req('GET', `/town/api/town-chat?after=${encodeURIComponent(aCursor)}`)).json.resync).toBe(true);
    // 不在场也能读
    await b.req('POST', '/town/api/leave', {});
    expect((await b.req('GET', '/town/api/town-chat')).json.messages).toHaveLength(8);
  });

  it('网页发公屏：回执带 scope 和消息 id；超长明确报错；额度与同一居民的其他入口共享', async () => {
    const app = await serve();
    const a = await new User(app).login('阿灯');
    const ok = await a.act({ type: 'say_town', text: '一', kind: 'activity', place: 'tea_house' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, scope: 'town', id: expect.any(String) });
    const long = await a.act({ type: 'say_town', text: '灯'.repeat(121) });
    expect(long.status).toBe(400);
    expect(long.json).toMatchObject({ error: 'bad_request', reason: 'text_too_long' });
    // 同一居民换一个入口（这里用服务层动作代表 MCP 之类的另一条路）发第二条：占的是同一份额度
    a.actor.act('say_town', { text: '二（另一个入口）' });
    const third = await a.act({ type: 'say_town', text: '三' });
    expect(third.status).toBe(429);
    expect(third.json).toMatchObject({ error: 'rate_limited' });
    expect(app.t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(2);
  });

  it('对局中只读：网页动作被拒绝，历史照常能读', async () => {
    const app = await serve({ params: { townChatPerMinute: 600, townChatBurst: 100 } });
    const [p1, p2, p3] = [await new User(app).login('甲'), await new User(app).login('乙'), await new User(app).login('丙')];
    for (const p of [p1, p2]) p.actor.go('arcade');
    for (const p of [p1, p2, p3]) p.actor.heartbeat();
    const g = p1.actor.act('propose_game', { game: 'number_bomb' });
    p2.actor.act('join_game', { activityId: g.activity.id });
    p1.actor.act('start_game', { activityId: g.activity.id });
    expect((await p3.act({ type: 'say_town', text: '局外人发的' })).status).toBe(200);
    const denied = await p1.act({ type: 'say_town', text: '局内人想发' });
    expect(denied.status).toBe(422);
    expect(denied.json).toMatchObject({ error: 'precondition_failed', reason: 'in_activity' });
    const page = (await p1.req('GET', '/town/api/town-chat')).json;
    expect(page.messages.map((m: any) => m.text)).toEqual(['局外人发的']);
  });

  it('附近聊天的 /history：before 是不透明游标，旧客户端传数字序号也认；坏游标返回 resync', async () => {
    const app = await serve({ params: { chatPerMinute: 600, chatBurst: 100 } });
    const a = await new User(app).login('阿灯');
    const b = await new User(app).login('小岚');
    for (let i = 0; i < 5; i++) await a.act({ type: 'say_nearby', text: `近${i}` });
    const p1 = (await b.req('GET', '/town/api/history?limit=2')).json;
    expect(p1.messages.map((m: any) => m.text)).toEqual(['近4', '近3']);
    expect(typeof p1.next).toBe('string');
    const p2 = (await b.req('GET', `/town/api/history?limit=2&before=${encodeURIComponent(p1.next)}`)).json;
    expect(p2.messages.map((m: any) => m.text)).toEqual(['近2', '近1']);
    const legacy = (await b.req('GET', `/town/api/history?limit=2&before=${p1.messages.at(-1).messageId}`)).json;
    expect(legacy.messages.map((m: any) => m.text)).toEqual(['近2', '近1']);
    expect((await b.req('GET', '/town/api/history?before=nonsense')).json).toMatchObject({ resync: true, messages: [] });
    // 别人的游标（绑定了主体）无效
    const aNext = (await a.req('GET', '/town/api/history?limit=2')).json.next;
    expect((await b.req('GET', `/town/api/history?before=${encodeURIComponent(aNext)}`)).json.resync).toBe(true);
  });
});

// ───────────────────────── WebSocket ─────────────────────────

class WsClient {
  msgs: any[] = [];
  private poke: (() => void)[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      for (const f of this.poke.splice(0)) f();
    });
    ws.on('error', () => undefined);
  }
  static open(url: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new WsClient(ws);
      cleanups.push(() => ws.terminate());
      ws.once('open', () => resolve(c));
      ws.once('error', reject);
    });
  }
  async waitFor(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`等消息超时。已收到：${JSON.stringify(this.msgs).slice(0, 500)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.poke.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

async function wsConnect(app: App, u: User): Promise<{ c: WsClient; hello: any }> {
  const tk = await u.req('POST', '/town/api/ws-ticket', { clientId: u.clientId });
  const c = await WsClient.open(app.wsUrl);
  c.ws.send(JSON.stringify({ t: 'hello', v: 1, ticket: tk.json.ticket }));
  const hello = await c.waitFor((m) => m.t === 'hello');
  await c.waitFor((m) => m.t === 'scene');
  return { c, hello };
}

describe('WebSocket：公屏新消息推送', () => {
  it('hello 带公屏游标；连上之后的新消息以 town_chat 推来（不回放历史、不重复）；附近聊天走原来的 events', async () => {
    const app = await serve({ params: { townChatPerMinute: 600, townChatBurst: 100, chatPerMinute: 600, chatBurst: 100 } });
    const a = await new User(app).login('阿灯');
    const b = await new User(app).login('小岚');
    await a.act({ type: 'say_town', text: '连上之前的' });
    const { c, hello } = await wsConnect(app, b);
    expect(hello.townChat.cursor).toEqual(expect.any(String));
    await a.act({ type: 'say_town', text: '连上之后的', kind: 'help', place: 'kitchen' });
    const push = await c.waitFor((m) => m.t === 'town_chat');
    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]).toMatchObject({ text: '连上之后的', kind: 'help', place: { id: 'kitchen' }, mine: false, from: { id: a.residentId } });
    expect(push.cursor).toBe(push.messages[0].id);
    // 推来的 id 能当 after 游标用：之后没有更新的
    const tail = await b.req('GET', `/town/api/town-chat?after=${encodeURIComponent(push.cursor)}`);
    expect(tail.json.messages).toEqual([]);
    expect(c.msgs.filter((m) => m.t === 'town_chat').flatMap((m) => m.messages.map((x: any) => x.text))).toEqual(['连上之后的']);
    // 附近聊天没有走 town_chat
    await a.act({ type: 'say_nearby', text: '近处的话' });
    const ev = await c.waitFor((m) => m.t === 'events' && m.events.some((e: any) => e.type === 'chat'));
    expect(ev.events.find((e: any) => e.type === 'chat').data).toMatchObject({ scope: 'nearby', text: '近处的话' });
    expect(JSON.stringify(c.msgs.filter((m) => m.t === 'town_chat'))).not.toContain('近处的话');
  });

  it('推送里的 id 绑定收消息的人（同一条消息，两个连接拿到的 id 不同）', async () => {
    const app = await serve();
    const a = await new User(app).login('阿灯');
    const b = await new User(app).login('小岚');
    const c2 = await new User(app).login('小满');
    const x = await wsConnect(app, b);
    const y = await wsConnect(app, c2);
    await a.act({ type: 'say_town', text: '给大家的' });
    const mb = (await x.c.waitFor((m) => m.t === 'town_chat')).messages[0];
    const mc = (await y.c.waitFor((m) => m.t === 'town_chat')).messages[0];
    expect(mb.text).toBe(mc.text);
    expect(mb.id).not.toBe(mc.id);
  });
});

// ───────────────────────── MCP ─────────────────────────

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const AGENTS = [
  { key: 'key-qing', id: '6001', name: '阿青' },
  { key: 'key-mo', id: '6002', name: '小墨' },
  { key: 'key-xi', id: '6003', name: '阿汐' },
];
const QING: Identity = { id: '6001', name: '阿青' };
const MO: Identity = { id: '6002', name: '小墨' };
const XI: Identity = { id: '6003', name: '阿汐' };

function makeEnv(townOpts?: Parameters<typeof makeTown>[0]) {
  const t = makeTown(townOpts);
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('chat-mcp') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const deps = { manager, auth, version: 'test', town: { world: t.w, auth, trustedIds: [] as string[] } };
  const connect = async (who: Identity) => {
    const ctx: SessionContext = { identity: who, fixed: true, transport: 'memory' };
    const server = createMcpServer(deps, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: 'test-client', version: '1.0.0' });
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  return { t, connect };
}

async function call(client: McpClient, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (res.isError) throw new Error(`工具 ${name} 失败：${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}
async function failure(client: McpClient, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `${name} 应该失败`).toBe(true);
  return res.content[0]!.text;
}

let rseq = 0;
const rid = () => `chat-mcp-${String(++rseq).padStart(6, '0')}`;
const wact = async (client: McpClient, action: Record<string, unknown>) => {
  const v = await call(client, 'get_my_view');
  return call(client, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action });
};
const wactFail = async (client: McpClient, action: Record<string, unknown>) => {
  const v = await call(client, 'get_my_view');
  return failure(client, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action });
};

async function enterAgent(env: ReturnType<typeof makeEnv>, who: Identity): Promise<{ client: McpClient; actor: Actor }> {
  const client = await env.connect(who);
  const entered = await call(client, 'enter_world', { client_id: `run-${who.id}-aaaa`, name: who.name });
  const w = env.t.w;
  const r = w.mustResident(entered.resident_id);
  const actor = new Actor(env.t, r.principal_id, r.resident_id, `mcp:run-${who.id}-aaaa`, who.name);
  return { client, actor };
}

describe('MCP：附近聊天和公屏', () => {
  it('speak 是附近聊天；world_act say_town 发公屏；world_query town_chat 读公屏；两条通道互不串', async () => {
    const env = makeEnv({ params: { townChatPerMinute: 600, townChatBurst: 100, chatPerMinute: 600, chatBurst: 100 } });
    const qing = await enterAgent(env, QING);
    const mo = await enterAgent(env, MO);
    const xi = await enterAgent(env, XI);
    xi.actor.go('garden');
    for (const x of [qing, mo, xi]) x.actor.heartbeat();
    await call(qing.client, 'speak', { text: '附近一句', request_id: rid() });
    expect((await call(mo.client, 'get_my_view')).here.recent_chat.map((c: any) => c.text)).toEqual(['附近一句']);
    expect((await call(xi.client, 'get_my_view')).here.recent_chat).toEqual([]);
    expect((await call(xi.client, 'world_query', { what: 'history' })).messages).toEqual([]);
    const out = await wact(qing.client, { type: 'say_town', text: '全镇一句', kind: 'activity', place: 'plaza' });
    expect(out).toMatchObject({ scope: 'town' });
    // 公屏：不要求同处，远处的阿汐也读得到；附近那句不在公屏里
    const page = await call(xi.client, 'world_query', { what: 'town_chat' });
    expect(page.messages.map((m: any) => m.text)).toEqual(['全镇一句']);
    expect(page.messages[0]).toMatchObject({ kind: 'activity', place: { id: 'plaza', name: '灯下广场' }, from: { name: '阿青' } });
    const afterFirst = page.cursor;
    await wact(mo.client, { type: 'say_town', text: '第二句' });
    const older = await call(xi.client, 'world_query', { what: 'town_chat', limit: 1 });
    expect(older.messages.map((m: any) => m.text)).toEqual(['第二句']);
    const prev = await call(xi.client, 'world_query', { what: 'town_chat', cursor: older.older, direction: 'before' });
    expect(prev.messages.map((m: any) => m.text)).toEqual(['全镇一句']);
    const news = await call(xi.client, 'world_query', { what: 'town_chat', cursor: afterFirst, direction: 'after' });
    expect(news.messages.map((m: any) => m.text)).toEqual(['第二句']);
    expect((await call(xi.client, 'world_query', { what: 'town_chat', cursor: 'garbage', direction: 'after' })).resync).toBe(true);
    // 视图里的摘要只带公共活动和求助（不是全部）
    const view = await call(xi.client, 'get_my_view');
    expect(view.town_chat).toEqual([{ from: '阿青', kind: 'activity', text: '全镇一句', place: '灯下广场' }]);
  });

  it('提到我才叫醒我：world_wait 因提及返回，普通闲聊不会；MCP 与网页共享同一份公屏额度', async () => {
    const env = makeEnv();
    const qing = await enterAgent(env, QING);
    const mo = await enterAgent(env, MO);
    const cursor = (await call(mo.client, 'get_my_view')).cursor;
    await wact(qing.client, { type: 'say_town', text: '今天天气不错' });
    const quiet = await call(mo.client, 'world_wait', { cursor, wait_seconds: 0 });
    expect(quiet.events).toEqual([]);
    expect(quiet.reason).toBe('timeout');
    env.t.advance(1_000);
    for (const x of [qing, mo]) x.actor.heartbeat();
    await wact(qing.client, { type: 'say_town', text: '小墨，你在吗？' });
    const loud = await call(mo.client, 'world_wait', { cursor, wait_seconds: 0 });
    expect(loud.reason).toBe('event');
    expect(loud.events).toEqual([expect.objectContaining({ type: 'town_chat_mention', reason: 'mention', text: '小墨，你在吗？', from: expect.objectContaining({ name: '阿青' }) })]);
    // 额度：阿青已经发了 2 条（突发 2），再发一条被限流；服务层的另一个入口同样被限流
    expect(await wactFail(qing.client, { type: 'say_town', text: '第三条' })).toContain('RATE_LIMITED');
    expect(qing.actor.fail('say_town', { text: '另一个入口' }).code).toBe('rate_limited');
  });

  it('对局中只读：MCP 写被拒绝；对局中的 AI 的视图、等待、摘要里没有公屏内容', async () => {
    const env = makeEnv({ params: { townChatPerMinute: 600, townChatBurst: 100 } });
    const qing = await enterAgent(env, QING);
    const mo = await enterAgent(env, MO);
    const xi = await enterAgent(env, XI);
    for (const x of [qing, mo]) x.actor.go('arcade');
    for (const x of [qing, mo, xi]) x.actor.heartbeat();
    // 开局之前就有一条提到阿青的公屏（进了事件队列）
    const cursor = (await call(qing.client, 'get_my_view')).cursor;
    await wact(xi.client, { type: 'say_town', text: '阿青 来打一局？', kind: 'activity', place: 'arcade' });
    const g = qing.actor.act('propose_game', { game: 'number_bomb' });
    mo.actor.act('join_game', { activityId: g.activity.id });
    qing.actor.act('start_game', { activityId: g.activity.id });
    for (const x of [qing, mo, xi]) x.actor.heartbeat();
    expect(qing.actor.row().activity_id).not.toBeNull();
    expect(await wactFail(qing.client, { type: 'say_town', text: '局内想发' })).toMatch(/in_activity|游戏/);
    // 局中再有人提到：不触发
    await wact(xi.client, { type: 'say_town', text: '阿青 小墨 加油' });
    const view = await call(qing.client, 'get_my_view', { cursor, wait_seconds: 0 });
    expect(JSON.stringify(view)).not.toContain('来打一局');
    expect(JSON.stringify(view)).not.toContain('加油');
    expect(view.town_chat).toBeUndefined();
    const wait = await call(qing.client, 'world_wait', { cursor, wait_seconds: 0 });
    expect(JSON.stringify(wait)).not.toMatch(/来打一局|加油|town_chat_mention/);
    // 读照常可以（观战式地看）
    const page = await call(qing.client, 'world_query', { what: 'town_chat' });
    expect(page.messages.map((m: any) => m.text)).toEqual(['阿青 来打一局？', '阿青 小墨 加油']);
  });
});
