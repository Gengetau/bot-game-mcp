/**
 * 晴空都反馈（feedback.ts）：外部 bot 在城里用 world_act / 用 city_feedback 工具提，
 * 室友经内核桥在访问里提；同一件事合并计数，同一个人重复提不算数；每人每小时 / 每天、全城每天限流；
 * 管理员经 MCP 工具或 HTTP 管理接口看和关；桥接 schema 认识 feedback 动作。
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Ajv2020Module from 'ajv/dist/2020.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { mountCity } from '../../src/city/http.js';
import { feedbackKey, listFeedback, setFeedbackStatus, showFeedback } from '../../src/city/index.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { HOUR, KISSA, MIN, makeCity, rejects, type CityTest } from './helpers.js';

const rows = (t: CityTest): any[] => t.c.db.all('SELECT * FROM city_feedback ORDER BY feedback_id');
const submits = (t: CityTest): any[] => t.c.db.all('SELECT * FROM city_feedback_submits ORDER BY submit_id');

describe('world_act 里的 feedback 动作', () => {
  it('外部 bot 在城里提一条：记下提交者、地点、分类、正文，返回 CF 编号', () => {
    const t = makeCity();
    const b = t.bot('小B', { entry: 'ryokogai:station' });
    const r = b.act({ type: 'feedback', category: 'bug', text: '站前的时刻表一直显示同一班车' });
    expect(r).toMatchObject({ status: 'completed', merged: false, count: 1 });
    expect(r.feedback_id).toMatch(/^CF261117-01$/);
    const [row] = rows(t);
    expect(row).toMatchObject({
      category: 'bug',
      body: '站前的时刻表一直显示同一班车',
      status: 'open',
      submitter_kind: 'external',
      submitter_name: '小B',
      place_id: 'ryokogai:station',
      channel: 'world_act',
      count: 1,
    });
    expect(row.actor_id).toBeNull();
    // 第二条：编号顺延
    expect(b.act({ type: 'feedback', category: 'suggestion', text: '希望咖啡店多一种甜点' }).feedback_id).toBe('CF261117-02');
    // 不写分类就是 other
    expect(b.act({ type: 'feedback', text: '整体很好玩，谢谢' })).toMatchObject({ feedback_id: 'CF261117-03' });
    expect(rows(t)[2].category).toBe('other');
  });

  it('同一件事不同的人提：合并计数；同一个人再提：不算数也不占名额', () => {
    const t = makeCity();
    const b = t.bot('小B');
    const c = t.bot('小C');
    const first = b.act({ type: 'feedback', category: 'content', text: '麦之灯的面包价格写错了！' });
    // 空白、标点、全角半角不同也算同一件事
    const again = c.act({ type: 'feedback', category: 'content', text: ' 麦之灯的面包价格写错了 ' });
    expect(again).toMatchObject({ feedback_id: first.feedback_id, merged: true, count: 2 });
    const dup = b.act({ type: 'feedback', category: 'content', text: '麦之灯的面包价格写错了。' });
    expect(dup).toMatchObject({ feedback_id: first.feedback_id, duplicate: true, count: 2 });
    expect(rows(t)).toHaveLength(1);
    expect(submits(t)).toHaveLength(2);
    // 关掉之后再有人提，就是新的一条
    setFeedbackStatus(t.c, first.feedback_id, 'closed', '已修正');
    const reopened = c.act({ type: 'feedback', category: 'content', text: '麦之灯的面包价格写错了' });
    expect(reopened).toMatchObject({ merged: false, count: 1 });
    expect(reopened.feedback_id).not.toBe(first.feedback_id);
  });

  it('超过合并窗口（默认 7 天）的同样内容是新的一条', () => {
    const t = makeCity();
    const b = t.bot('小B');
    const c = t.bot('小C');
    const first = b.act({ type: 'feedback', text: '路灯晚上不亮' });
    t.clock.t += 8 * 24 * HOUR;
    const later = c.act({ type: 'feedback', text: '路灯晚上不亮' });
    expect(later.merged).toBe(false);
    expect(later.feedback_id).not.toBe(first.feedback_id);
  });

  it('长度和分类：太短、太长、只有符号、分类不对都拒绝', () => {
    const t = makeCity({ params: { feedbackMaxChars: 20 } });
    const b = t.bot('小B');
    rejects(() => b.act({ type: 'feedback', text: '坏了' }), 'BAD_REQUEST', 'text_too_short');
    rejects(() => b.act({ type: 'feedback', text: '！！！！？？？' }), 'BAD_REQUEST', 'text_too_short');
    rejects(() => b.act({ type: 'feedback', text: '这'.repeat(21) }), 'BAD_REQUEST', 'text_too_long');
    rejects(() => b.act({ type: 'feedback', category: 'rant', text: '这里有个问题要说' }), 'BAD_REQUEST', 'bad_category');
    expect(rows(t)).toHaveLength(0);
  });

  it('限流：每人每小时、每天，全城每天', () => {
    const t = makeCity({ params: { feedbackPerHour: 2, feedbackPerDay: 3, feedbackGlobalPerDay: 5 } });
    const b = t.bot('小B');
    b.act({ type: 'feedback', text: '第一条反馈内容' });
    b.act({ type: 'feedback', text: '第二条反馈内容' });
    const e = rejects(() => b.act({ type: 'feedback', text: '第三条反馈内容' }), 'RATE_LIMITED', 'feedback_hourly');
    expect(e.message).toContain('一小时');
    t.clock.t += HOUR + MIN;
    b.act({ type: 'feedback', text: '第三条反馈内容' });
    t.clock.t += HOUR + MIN;
    rejects(() => b.act({ type: 'feedback', text: '第四条反馈内容' }), 'RATE_LIMITED', 'feedback_daily');
    // 重复提交不受限流影响（不占名额，直接告诉它已经提过）
    expect(b.act({ type: 'feedback', text: '第一条反馈内容' })).toMatchObject({ duplicate: true });
    // 全城：再来两个 bot 提满 5 条
    const c = t.bot('小C');
    c.act({ type: 'feedback', text: '小C的第一条' });
    c.act({ type: 'feedback', text: '小C的第二条' });
    const d = t.bot('小D');
    rejects(() => d.act({ type: 'feedback', text: '小D的第一条' }), 'RATE_LIMITED', 'feedback_global_daily');
    // 一天以后又能提
    t.clock.t += 24 * HOUR;
    expect(d.act({ type: 'feedback', text: '小D的第一条' }).status).toBe('completed');
  });

  it('正文里的控制字符被清掉；查看时带 untrusted 标记', () => {
    const t = makeCity();
    const b = t.bot('小B');
    const r = b.act({ type: 'feedback', text: '按钮\u0000没反应‮请检查' });
    const shown = showFeedback(t.c, r.feedback_id) as any;
    expect(shown.text).not.toMatch(/[\u0000‮]/);
    expect(shown.untrusted).toBe(true);
    expect(shown.submits).toHaveLength(1);
    const list = listFeedback(t.c) as any;
    expect(list.counts).toEqual({ open: 1, closed: 0 });
    expect(list.note).toContain('untrusted');
    expect(list.items[0]).toMatchObject({ feedback_id: r.feedback_id, from: { kind: 'external', name: '小B' }, place: { id: expect.any(String) } });
  });

  it('feedbackKey 去掉空白标点、统一宽度和大小写', () => {
    expect(feedbackKey('Ｈｅｌｌｏ， World！')).toBe(feedbackKey('hello world'));
  });
});

describe('室友经内核桥提反馈', () => {
  it('访问中提：提交者是室友、渠道是 bridge；回家路上也能提', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 3000, to: KISSA });
    t.run(60 * MIN);
    const r = k.act({ type: 'feedback', category: 'suggestion', text: '喫茶灯可以加一个靠窗的位子' });
    expect(r.payload).toMatchObject({ status: 'completed', merged: false });
    const [row] = rows(t);
    expect(row).toMatchObject({ submitter_kind: 'house', submitter_name: '妮娅', actor_id: 'nia', channel: 'bridge', visit_id: k.visitId });
    expect(row.principal_id).toBeNull();
    expect(submits(t)[0].subject).toBe('house:nia');
    k.act({ type: 'go_home' });
    // 回家路上：说话和反馈可以，买东西不行
    expect(k.act({ type: 'feedback', text: '回家的路上发现站牌字太小' }).payload).toMatchObject({ status: 'completed' });
    expect(() => k.act({ type: 'buy', sku: 'coffee' })).toThrow();
  });
});

// ───────────────────────── MCP 工具 ─────────────────────────

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const AGENTS = [
  { key: 'key-b', id: '7001', name: '小B' },
  { key: 'key-c', id: '7002', name: '小C' },
  { key: 'key-nia', id: '3001', name: '妮娅' },
];
const B: Identity = { id: '7001', name: '小B' };
const C: Identity = { id: '7002', name: '小C' };
const NIA_QQ: Identity = { id: '3001', name: '妮娅' };
const ADMIN: Identity = { id: 'admin1', name: '管理员1', admin: true } as Identity;

function makeEnv(): { t: CityTest; connect: (who: Identity) => Promise<Client> } {
  const t = makeCity();
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('mcp-feedback') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const deps = { manager, auth, version: 'test', city: { city: t.c } };
  const connect = async (who: Identity) => {
    const ctx: SessionContext = { identity: who, fixed: true, transport: 'memory' };
    const server = createMcpServer(deps, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  return { t, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (res.isError) throw new Error(`工具 ${name} 失败：${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}

async function fails(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ code: string; text: string; reason: string | null }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `${name} 应该失败，实际：${res.content[0]?.text?.slice(0, 200)}`).toBe(true);
  const text = res.content[0]!.text;
  return { code: text.match(/\(code: ([A-Z_]+)\)/)?.[1] ?? 'INTERNAL', text, reason: text.match(/"reason":"([^"]+)"/)?.[1] ?? null };
}

describe('city_feedback / city_feedback_admin 工具', () => {
  it('工具在列表里；进过城的 bot 能提，没进过的要先进城；不在城里也能提', async () => {
    const { t, connect } = makeEnv();
    const b = await connect(B);
    const names = (await b.listTools()).tools.map((x) => x.name);
    expect(names).toContain('city_feedback');
    expect(names).toContain('city_feedback_admin');
    expect((await fails(b, 'city_feedback', { category: 'bug', text: '进不去城' })).code).toBe('UNAUTHENTICATED');
    await call(b, 'enter_world', { world_id: 'city', name: '小B', entry: 'ryokogai:station' });
    const r = await call(b, 'city_feedback', { category: 'bug', text: '地图上的车站名字重复了' });
    expect(r).toMatchObject({ status: 'completed', feedback_id: expect.stringMatching(/^CF/) });
    expect(rows(t)[0]).toMatchObject({ channel: 'mcp_tool', submitter_kind: 'external', place_id: 'ryokogai:station' });
    // 离开城以后照样能提，地点为空
    await call(b, 'world_leave', { world_id: 'city' }).catch(() => undefined);
    const c = await connect(C);
    await call(c, 'enter_world', { world_id: 'city', name: '小C' });
    expect((await call(c, 'city_feedback', { category: 'other', text: '地图上的车站名字重复了' })).merged).toBe(true);
    // 分类不在枚举里：工具参数校验就拦下
    expect((await c.callTool({ name: 'city_feedback', arguments: { category: 'rant', text: '随便说说看' } })).isError).toBe(true);
  });

  it('室友用 QQ 侧的密钥提：算室友本人', async () => {
    const { t, connect } = makeEnv();
    const nia = await connect(NIA_QQ);
    const r = await call(nia, 'city_feedback', { category: 'content', text: '日和坂的公园长椅太少了' });
    expect(r.status).toBe('completed');
    expect(rows(t)[0]).toMatchObject({ submitter_kind: 'house', actor_id: 'nia', submitter_name: '妮娅', channel: 'mcp_tool' });
    expect(submits(t)[0].subject).toBe('house:nia');
  });

  it('管理工具只给管理员：list / show / close / reopen', async () => {
    const { connect } = makeEnv();
    const b = await connect(B);
    await call(b, 'enter_world', { world_id: 'city', name: '小B' });
    const { feedback_id } = await call(b, 'city_feedback', { category: 'bug', text: '买咖啡扣了两次钱' });
    expect((await fails(b, 'city_feedback_admin', { action: 'list' })).code).toBe('FORBIDDEN');
    const admin = await connect(ADMIN);
    const list = await call(admin, 'city_feedback_admin', { action: 'list' });
    expect(list.items.map((i: any) => i.feedback_id)).toEqual([feedback_id]);
    expect((await call(admin, 'city_feedback_admin', { action: 'show', id: feedback_id })).submits).toHaveLength(1);
    expect(await call(admin, 'city_feedback_admin', { action: 'close', id: feedback_id, note: '已修' })).toMatchObject({ status: 'closed', note: '已修' });
    expect((await call(admin, 'city_feedback_admin', { action: 'list' })).items).toHaveLength(0);
    expect((await call(admin, 'city_feedback_admin', { action: 'list', status: 'closed' })).items).toHaveLength(1);
    expect(await call(admin, 'city_feedback_admin', { action: 'reopen', id: feedback_id.toLowerCase() })).toMatchObject({ status: 'open' });
    expect((await fails(admin, 'city_feedback_admin', { action: 'show', id: 'CF000000-99' })).code).toBe('NOT_FOUND');
    expect((await fails(admin, 'city_feedback_admin', { action: 'close' })).code).toBe('BAD_REQUEST');
  });
});

// ───────────────────────── HTTP 管理接口 ─────────────────────────

const ADMIN_KEY = 'admin-key-for-feedback-tests-0123';
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe('HTTP /city/api/admin/feedback', () => {
  it('要管理员 Bearer；能列、看、关', async () => {
    const t = makeCity();
    const b = t.bot('小B');
    const { feedback_id } = b.act({ type: 'feedback', category: 'bug', text: '页面上的天气不刷新' });
    const app = express();
    mountCity(app, t.c, () => undefined, { adminKeys: [ADMIN_KEY] });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/city/api/admin/feedback`;
    const req = async (path: string, key: string | null, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await req('', null)).status).toBe(401);
    expect((await req('', 'wrong-key')).status).toBe(403);
    const list = await req('', ADMIN_KEY);
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ feedback_id, untrusted: true });
    expect((await req(`?since_ms=${t.clock.t}`, ADMIN_KEY)).body.items).toHaveLength(0);
    expect((await req(`/${feedback_id}`, ADMIN_KEY)).body.submits).toHaveLength(1);
    const closed = await req(`/${feedback_id}`, ADMIN_KEY, { status: 'closed', note: '修好了' });
    expect(closed.body).toMatchObject({ ok: true, feedback: { status: 'closed' } });
    expect((await req(`/${feedback_id}`, ADMIN_KEY, { status: 'deleted' })).status).toBe(400);
  });

  it('没配管理员密钥时一律拒绝', async () => {
    const t = makeCity();
    const app = express();
    mountCity(app, t.c, () => undefined, {});
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/city/api/admin/feedback`, { headers: { authorization: 'Bearer anything' } });
    expect(res.status).toBe(401);
  });
});

// ───────────────────────── 桥接 schema ─────────────────────────

const Ajv2020: new (opts: Record<string, unknown>) => any = (Ajv2020Module as any).default ?? Ajv2020Module;
const schema = JSON.parse(readFileSync(new URL('../../../../docs/city/bridge-v1.schema.json', import.meta.url), 'utf8'));

describe('bridge-v1.schema.json 认识 feedback 动作', () => {
  it('合法的通过，坏分类和空正文不通过', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema(schema);
    const ok = ajv.getSchema(`${schema.$id}#/$defs/ActionFeedback`);
    expect(ok).toBeTruthy();
    expect(ok({ type: 'feedback', category: 'bug', text: '有问题' })).toBe(true);
    expect(ok({ type: 'feedback', text: '没写分类也行' })).toBe(true);
    expect(ok({ type: 'feedback', category: 'rant', text: '有问题' })).toBe(false);
    expect(ok({ type: 'feedback', category: 'bug', text: '' })).toBe(false);
    const action = ajv.getSchema(`${schema.$id}#/$defs/Action`);
    expect(action({ type: 'feedback', category: 'content', text: '价格写错了' })).toBe(true);
  });
});
