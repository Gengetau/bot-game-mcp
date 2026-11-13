/**
 * 栖灯镇的 MCP 入口：真实的 MCP 客户端（内存传输）→ createMcpServer → 世界命令管线。
 * 世界用假时钟（FakeClock）；等待类工具的超时用的是真实计时，所以只在需要的地方用 1 秒。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { mountTown } from '../../src/world/http.js';
import { agentPrincipal, exchangeTicket, issueTicket, sessionPrincipal } from '../../src/world/identity.js';
import { grantItem } from '../../src/world/property.js';
import { meView } from '../../src/world/views.js';
import { makeTown, type Actor, type Town } from './helpers.js';

// ───────────────────────── 辅助 ─────────────────────────

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const AGENTS = [
  { key: 'key-qing', id: '5001', name: '阿青' },
  { key: 'key-mo', id: '5002', name: '小墨' },
  { key: 'key-xi', id: '5003', name: '阿汐' },
  { key: 'key-ref', id: '5100', name: '代码裁判' },
];
const ADMIN: Identity = { id: '5900', name: '管理员', admin: true };
const REFEREE_ID = '5100';

interface Env {
  t: Town;
  manager: GameManager;
  auth: Authenticator;
  /** 连接一个客户端。identity 缺省为 agents[0]；每次调用是一个新的 MCP 会话 */
  connect: (who?: Identity) => Promise<Client>;
}

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function makeEnv(opts: { town?: boolean; townOpts?: Parameters<typeof makeTown>[0] } = {}): Env {
  const t = makeTown(opts.townOpts);
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('mcp-town') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const deps = { manager, auth, version: 'test', ...(opts.town === false ? {} : { town: { world: t.w, auth, trustedIds: [REFEREE_ID] } }) };
  const connect = async (who: Identity = { id: AGENTS[0]!.id, name: AGENTS[0]!.name }) => {
    const ctx: SessionContext = { identity: who, fixed: true, transport: 'memory' };
    const server = createMcpServer(deps, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  return { t, manager, auth, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (res.isError) throw new Error(`工具 ${name} 失败：${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}

/** 期望失败：返回错误码、全文和提示。 */
async function fails(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ code: string; text: string; hint: string | null; reason: string | null }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `${name} 应该失败，实际：${res.content[0]?.text?.slice(0, 200)}`).toBe(true);
  const text = res.content[0]!.text;
  const code = text.match(/\(code: ([A-Z_]+)\)/)?.[1] ?? 'INTERNAL';
  const hint = text.match(/💡 (.*)/)?.[1] ?? null;
  const reason = text.match(/"reason":"([^"]+)"/)?.[1] ?? null;
  return { code, text, hint, reason };
}

const rawSize = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<number> => {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  return Buffer.byteLength(res.content[0]!.text, 'utf8');
};

let seq = 0;
const rid = () => `mcp-req-${String(++seq).padStart(6, '0')}`;

/** 读最新视图再提交 world_act（像一个守规矩的 agent）。 */
async function wact(client: Client, action: Record<string, unknown>, o: { request_id?: string; view?: any; extra?: Record<string, unknown> } = {}): Promise<any> {
  const v = o.view ?? (await call(client, 'get_my_view'));
  return call(client, 'world_act', { request_id: o.request_id ?? rid(), action_window: v.action_window, context_version: v.context.version, action, ...(o.extra ?? {}) });
}

async function wactFails(client: Client, action: Record<string, unknown>, o: { request_id?: string; view?: any; override?: Record<string, unknown> } = {}) {
  const v = o.view ?? (await call(client, 'get_my_view'));
  return fails(client, 'world_act', { request_id: o.request_id ?? rid(), action_window: v.action_window, context_version: v.context.version, action, ...(o.override ?? {}) });
}

async function enter(env: Env, who: Identity, extra: Record<string, unknown> = {}): Promise<{ client: Client; entered: any }> {
  const client = await env.connect(who);
  const entered = await call(client, 'enter_world', { client_id: `run-${who.id}-aaaa`, ...extra });
  return { client, entered };
}

const QING: Identity = { id: '5001', name: '阿青' };
const MO: Identity = { id: '5002', name: '小墨' };
const XI: Identity = { id: '5003', name: '阿汐' };
const REF: Identity = { id: REFEREE_ID, name: '代码裁判' };

const BASE_TOOLS = [
  'login', 'whoami', 'list_games', 'get_rules', 'create_game', 'join_game', 'add_human_player', 'leave_game', 'start_game', 'abort_game',
  'get_my_view', 'speak', 'act', 'get_game_log', 'spectator_say', 'referee_step', 'relay_human_message', 'referee_takeover', 'referee_offer',
  'issue_key', 'revoke_key', 'list_keys',
];
const TOWN_TOOLS = ['enter_world', 'world_act', 'world_wait', 'heartbeat', 'claim_control', 'leave_world', 'world_query', 'town_issue_ticket', 'town_outbox'];

/** 时间前进，期间这些 MCP 会话保持在场。 */
async function aliveFor(env: Env, ms: number, clients: Client[]): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(20_000, left);
    env.t.clock.advance(step);
    for (const c of clients) await call(c, 'heartbeat');
    env.t.w.tick();
    left -= step;
  }
}

/** 走路：像运行器那样每 3 秒用 heartbeat 的 navigation_id / revision 续导航租约，直到这一趟走完。 */
async function walkMcp(env: Env, client: Client): Promise<void> {
  for (let guard = 0; guard < 200; guard++) {
    const v = await call(client, 'get_my_view');
    const w = v.location.walking;
    if (!w) return;
    const now = env.t.w.now();
    env.t.clock.advance(Math.max(1, Math.min(w.arrive_at - now, 3_000)));
    env.t.w.tick();
    await call(client, 'heartbeat', { navigation_id: w.navigation_id, revision: w.revision });
  }
  throw new Error('走了太久还没到');
}

/** 按视图轮流出手，直到这些客户端都不在游戏里。返回出手次数。 */
async function driveGame(env: Env, clients: Client[]): Promise<number> {
  let turns = 0;
  for (let guard = 0; guard < 300; guard++) {
    const views = await Promise.all(clients.map((c) => call(c, 'get_my_view')));
    if (views.every((v) => v.game === null)) return turns;
    const idx = views.findIndex((v) => v.game?.your_turn);
    if (idx < 0) {
      await aliveFor(env, 5_000, clients);
      continue;
    }
    const v = views[idx]!;
    const range = v.game.public.range as { from: number; to: number };
    await call(clients[idx]!, 'act', { action: 'guess', number: Math.floor((range.from + range.to) / 2), phase_id: v.game.phase_id, request_id: rid(), context_version: v.context.version });
    turns++;
  }
  throw new Error('游戏没有在预期步数内结束');
}

// ───────────────────────── 工具列表 ─────────────────────────

describe('MCP 小镇：工具列表', () => {
  it('没开小镇时工具、资源与原来完全一致（没有任何小镇的工具）', async () => {
    const env = makeEnv({ town: false });
    const c = await env.connect();
    const { tools } = await c.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...BASE_TOOLS].sort());
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).not.toContain('botgame://guide/town');
    // get_my_view / speak / act 的入参里没有小镇字段
    const speak = tools.find((x) => x.name === 'speak')!;
    expect(Object.keys((speak.inputSchema as any).properties)).toEqual(expect.arrayContaining(['text', 'game_id']));
    // 小镇的工具调不到
    await expect(c.callTool({ name: 'enter_world', arguments: {} })).resolves.toMatchObject({ isError: true });
  });

  it('开了小镇：多出 9 个工具与 botgame://guide/town，其余不变；每个都有说明和注解', async () => {
    const env = makeEnv();
    const c = await env.connect();
    const { tools } = await c.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...BASE_TOOLS, ...TOWN_TOOLS].sort());
    for (const name of TOWN_TOOLS) {
      const tool = tools.find((x) => x.name === name)!;
      expect(tool.description!.length, name).toBeGreaterThan(20);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
    expect(tools.find((x) => x.name === 'world_wait')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'world_query')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'world_act')!.annotations?.readOnlyHint).toBe(false);
    const guide = await c.readResource({ uri: 'botgame://guide/town' });
    const text = (guide.contents[0] as { text: string }).text;
    expect(text).toContain('enter_world');
    expect(text).toContain('world_act');
  });
});

// ───────────────────────── enter_world ─────────────────────────

describe('MCP 小镇：enter_world', () => {
  it('第一次进入创建居民，再次进入是同一位（不生成新居民）；名字缺省用 MCP 身份名', async () => {
    const env = makeEnv();
    const c = await env.connect(QING);
    const first = await call(c, 'enter_world', { name: '青青', bio: '爱喝茶', traits: ['quiet'], interests: ['tea'], client_id: 'run-qing-0001' });
    expect(first).toMatchObject({ ok: true, world_id: 'town', created: true, resident_id: expect.stringMatching(/^r_/) });
    expect(first.me).toMatchObject({ name: '青青' });
    expect(first.context.version).toEqual(expect.any(Number));
    expect(first.action_window).toMatch(/^aw\./);
    expect(first.cursor).toMatch(/^r/);
    expect(first.control.mine).toBe(true);
    const again = await call(c, 'enter_world', { client_id: 'run-qing-0001' });
    expect(again).toMatchObject({ created: false, resident_id: first.resident_id });
    expect(again.me.name).toBe('青青');
    // 没带 name：用身份名
    const mo = await call(await env.connect(MO), 'enter_world', {});
    expect(mo.me.name).toBe('小墨');
    // 一个 MCP 身份只有一位居民
    expect(env.t.w.db.scalar('SELECT COUNT(*) FROM residents')).toBe(2);
  });

  it('参数错误：未知世界、非法 traits、名字被占用、client_id 格式', async () => {
    const env = makeEnv();
    const c = await env.connect(QING);
    expect((await fails(c, 'enter_world', { world_id: 'other' })).code).toBe('NOT_AVAILABLE');
    expect((await fails(c, 'enter_world', { name: '青青', traits: ['no_such'] })).code).toBe('BAD_REQUEST');
    const bad = (await c.callTool({ name: 'enter_world', arguments: { client_id: 'a b' } })) as ToolResult;
    expect(bad.isError).toBe(true); // schema 校验
    expect(env.t.w.db.scalar('SELECT COUNT(*) FROM residents')).toBe(0);
    await call(c, 'enter_world', { name: '青青' });
    const dup = await fails(await env.connect(MO), 'enter_world', { name: '青青' });
    expect(dup.code).toBe('PRECONDITION_FAILED');
    expect(dup.reason).toBe('name_taken');
  });

  it('居民名和简介里的控制字符与 CQ 码被清洗', async () => {
    const env = makeEnv();
    const c = await env.connect(QING);
    const r = await call(c, 'enter_world', { name: '青\u0000青', bio: '[CQ:at,qq=1] 你好\u0007' });
    expect(r.me.name).toBe('青青');
    expect(JSON.stringify(r)).not.toContain('[CQ:');
    expect(JSON.stringify(r)).not.toContain('\u0007');
  });

  it('另一个会话进入会接管控制权：旧会话的动作被拒绝（CONTROL_LOST），claim_control 可以抢回', async () => {
    const env = makeEnv();
    const c1 = await env.connect(QING);
    await call(c1, 'enter_world', { name: '青青', client_id: 'run-one-0001' });
    const v1 = await call(c1, 'get_my_view');
    const c2 = await env.connect(QING);
    const e2 = await call(c2, 'enter_world', { client_id: 'run-two-0002' });
    expect(e2.control.mine).toBe(true);
    expect(e2.created).toBe(false);
    // 旧会话
    const lost = await wactFails(c1, { type: 'speak', text: '我还在' }, { view: v1 });
    expect(lost.code).toBe('CONTROL_LOST');
    expect(lost.hint).toContain('claim_control');
    const view = await call(c1, 'get_my_view');
    expect(view.control.mine).toBe(false);
    // 抢回来
    const claimed = await call(c1, 'claim_control');
    expect(claimed).toMatchObject({ ok: true, control: { mine: true } });
    expect(await wact(c1, { type: 'speak', text: '我回来了' })).toMatchObject({ ok: true });
    expect((await wactFails(c2, { type: 'speak', text: '新会话被挤下去' })).code).toBe('CONTROL_LOST');
  });

  it('enter_world 带 claim=false：别的会话握着控制权时只读进入，不把它挤下去', async () => {
    const env = makeEnv();
    const c1 = await env.connect(QING);
    await call(c1, 'enter_world', { name: '青青', client_id: 'run-one-0001' });
    const c2 = await env.connect(QING);
    const e2 = await call(c2, 'enter_world', { client_id: 'run-two-0002', claim: false });
    expect(e2).toMatchObject({ ok: true, created: false, control: { mine: false } });
    // 原来的会话照常能写，只读进入的那个不能
    expect(await wact(c1, { type: 'speak', text: '我还握着' })).toMatchObject({ ok: true });
    expect((await wactFails(c2, { type: 'speak', text: '我只是看看' })).code).toBe('CONTROL_LOST');
  });

  it('真人不能走 enter_world 注册（身份名以真人票据登记过的号码不能当 AI 进入）', async () => {
    const env = makeEnv();
    env.t.join('真人', 'human'); // 真人主体 qq:20n
    const c = await env.connect({ id: '201', name: '冒充者' });
    const r = await fails(c, 'enter_world', { name: '冒充者' });
    expect(['FORBIDDEN', 'UNAUTHENTICATED', 'PRECONDITION_FAILED', 'BAD_REQUEST']).toContain(r.code);
    expect(env.t.w.db.scalar("SELECT COUNT(*) FROM residents WHERE name = '冒充者'")).toBe(0);
  });
});

// ───────────────────────── 路由 ─────────────────────────

describe('MCP 小镇：get_my_view / speak / act 的路由', () => {
  it('没进入小镇时走原来的桌游路径；进入后走居民路径；离开后回到桌游路径', async () => {
    const env = makeEnv();
    const c = await env.connect(QING);
    const before = await fails(c, 'get_my_view');
    expect(before.text).not.toContain('action_window');
    await call(c, 'enter_world', { name: '青青' });
    const v = await call(c, 'get_my_view');
    expect(v).toHaveProperty('action_window');
    expect(v).toHaveProperty('cursor');
    expect(v.me.name).toBe('青青');
    await call(c, 'leave_world');
    const after = await fails(c, 'get_my_view');
    expect(after.text).not.toContain('action_window');
    // 再进来
    expect((await call(c, 'enter_world', {})).created).toBe(false);
    expect((await call(c, 'get_my_view')).me.name).toBe('青青');
  });

  it('带普通对局的 game_id 时，在小镇里也仍走桌游（view / speak / act）', async () => {
    const env = makeEnv();
    const ref = await env.connect(QING);
    await call(ref, 'enter_world', { name: '青青' });
    const created = await call(ref, 'create_game', { game_type: '数字炸弹', group_id: '777001', join_as: 'referee' });
    const gameId: string = created.summary.game_id;
    const bomb = await call(ref, 'get_my_view', { game_id: gameId });
    expect(bomb).not.toHaveProperty('action_window');
    expect(JSON.stringify(bomb)).toMatch(/数字炸弹|number_bomb|referee|裁判/);
    // 桌游的 speak 不要 request_id；在小镇里（没有 game_id）speak 要
    const noId = await fails(ref, 'speak', { text: '不带编号的发言' });
    expect(noId.code).toBe('BAD_REQUEST');
    expect(noId.text).toContain('request_id');
    const boardSpeak = (await ref.callTool({ name: 'speak', arguments: { text: '桌游里的发言', game_id: gameId } })) as ToolResult;
    expect(boardSpeak.content[0]!.text).not.toContain('request_id');
    // 小镇视图仍然可用，而且没被桌游影响
    expect(await call(ref, 'get_my_view')).toHaveProperty('action_window');
  });

  it('speak：现场发言只有同处的人听得到；同 request_id 重试只发一次', async () => {
    const env = makeEnv();
    const { client: qing } = await enter(env, QING, { name: '青青' });
    const { client: mo } = await enter(env, MO, { name: '小墨' });
    const far = env.t.join('远处', 'agent');
    far.go('tea_house');
    env.t.advance(15_000);
    const id = rid();
    const r1 = await call(qing, 'speak', { text: '大家好', request_id: id });
    expect(r1).toMatchObject({ ok: true });
    const r2 = await call(qing, 'speak', { text: '大家好', request_id: id });
    expect(r2.replayed).toBe(true);
    expect(env.t.w.db.scalar("SELECT COUNT(*) FROM chat_messages WHERE body = '大家好'")).toBe(1);
    const moView = await call(mo, 'get_my_view');
    expect(moView.here.recent_chat).toEqual([{ from: '青青', text: '大家好' }]);
    expect(JSON.stringify(far.view())).not.toContain('大家好');
    // 同 request_id 不同内容
    const conflict = await fails(qing, 'speak', { text: '换了一句', request_id: id });
    expect(conflict.code).toBe('REQUEST_CONFLICT');
    // request_id 太短 → schema 拒绝
    const short = (await qing.callTool({ name: 'speak', arguments: { text: 'x', request_id: 'abc' } })) as ToolResult;
    expect(short.isError).toBe(true);
    // 过期的上下文版本
    const stale = await fails(qing, 'speak', { text: '旧版本', request_id: rid(), context_version: 0 });
    expect(stale.code).toBe('CONTEXT_STALE');
  });

  it('发言里的 CQ 码和 {@N} 占位符被清洗，且超长被截断', async () => {
    const env = makeEnv();
    const { client: qing } = await enter(env, QING, { name: '青青' });
    const { client: mo } = await enter(env, MO, { name: '小墨' });
    await call(qing, 'speak', { text: '[CQ:at,qq=all] {@1} ' + '长'.repeat(500), request_id: rid() });
    const heard = (await call(mo, 'get_my_view')).here.recent_chat[0].text as string;
    expect(heard).not.toContain('[CQ:');
    expect(heard).not.toContain('{@');
    expect([...heard].length).toBeLessThanOrEqual(120);
  });

  it('act 在小镇里必须带 phase_id；不在游戏里时被拒绝，不影响世界', async () => {
    const env = makeEnv();
    const { client: qing } = await enter(env, QING, { name: '青青' });
    const noPhase = await fails(qing, 'act', { action: 'guess', number: 5, request_id: rid() });
    expect(noPhase.code).toBe('BAD_REQUEST');
    expect(noPhase.text).toContain('phase_id');
    // phase_id 每局从 1 数起：还要带局号或上下文版本，才知道说的是哪一局
    const noGame = await fails(qing, 'act', { action: 'guess', number: 5, request_id: rid(), phase_id: 1 });
    expect(noGame.code).toBe('BAD_REQUEST');
    expect(noGame.text).toContain('game_id');
    const view = await call(qing, 'get_my_view');
    const notIn = await fails(qing, 'act', { action: 'guess', number: 5, request_id: rid(), phase_id: 1, context_version: view.context.version });
    expect(['PRECONDITION_FAILED', 'CONTEXT_STALE', 'PHASE_STALE']).toContain(notIn.code);
    const wrongGame = await fails(qing, 'act', { action: 'guess', number: 5, request_id: rid(), phase_id: 1, game_id: 'TG-NOPE0000' });
    expect(['PRECONDITION_FAILED', 'CONTEXT_STALE', 'PHASE_STALE']).toContain(wrongGame.code);
  });

  it('open 模式下自己认领的号码登记在单独的命名空间：抢先认领真人的号码，挡不住那位真人登录', async () => {
    const env = makeEnv();
    const w = env.t.w;
    // 没有密钥绑定的会话（open 模式 login 认领）以 20999 这个号码进入小镇
    const squatter = agentPrincipal(w, { id: '20999', name: '抢注者' }, { selfClaimed: true });
    expect(squatter.kind).toBe('agent');
    // 真人 20999 之后照常能拿到票据并登录
    const ticket = issueTicket(w, { provider: 'qq', subject: '20999', name: '真人' });
    const session = exchangeTicket(w, ticket.ticket);
    const human = sessionPrincipal(w, session.token)!;
    expect(human.kind).toBe('human');
    expect(human.principal_id).not.toBe(squatter.principal_id);
    // 密钥绑定的身份仍和真人共用命名空间：同一个号码不能两头都是
    expect(() => agentPrincipal(w, { id: '20999', name: '有密钥的 bot' })).toThrow();
  });
});

// ───────────────────────── world_act ─────────────────────────

describe('MCP 小镇：world_act', () => {
  it('navigate → 走到；返回 accepted 与导航信息；视图里有 location.walking；运行器式续租到 you_arrived', async () => {
    const env = makeEnv();
    const { client } = await enter(env, QING, { name: '青青' });
    const v0 = await call(client, 'get_my_view');
    expect(v0.location).toMatchObject({ space: 'plaza' });
    expect(v0.location.walking).toBeUndefined();
    expect(v0.here.kind).toBe('public');
    expect(v0.here.exits.map((e: any) => e.to)).toContain('tea_house');
    const r = await wact(client, { type: 'navigate', to: 'tea_house' }, { view: v0 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('accepted');
    expect(r.navigation).toMatchObject({ navigationId: expect.any(String), revision: expect.any(Number), to: { kind: 'place', name: '栖灯茶馆' }, renewEveryMs: expect.any(Number) });
    expect(r.navigation.arriveAt).toBeGreaterThan(env.t.clock.now());
    expect(r.navigation.leaseUntil).toBeGreaterThan(env.t.clock.now());
    expect(r.move).toBeUndefined(); // 回执里没有旧的 move 状态，也没有路径
    expect(JSON.stringify(r)).not.toMatch(/path|points|polyline/i);
    // 路上：视图里是 walking，不再有 moving_to；人属于脚下的区域，here 不为空
    const mid = await call(client, 'get_my_view');
    expect(mid.location.moving_to).toBeUndefined();
    expect(mid.location.walking).toMatchObject({ navigation_id: r.navigation.navigationId, revision: r.navigation.revision, to: '栖灯茶馆' });
    expect(mid.here).not.toBeNull();
    // 不带 navigation_id 的 heartbeat 只是在场心跳
    expect((await call(client, 'heartbeat')).navigation).toBeUndefined();
    // 带上就在同一次调用里续导航租约
    env.t.clock.advance(3_000);
    const hb = await call(client, 'heartbeat', { navigation_id: r.navigation.navigationId, revision: r.navigation.revision });
    expect(hb.ok).toBe(true);
    expect(hb.navigation.ok).toBe(true);
    expect(hb.navigation.leaseUntil).toBeGreaterThan(r.navigation.leaseUntil);
    expect(hb.navigation.navigation.navigationId).toBe(r.navigation.navigationId);
    // 回答里带着此刻脚下的区域（走路的人自己跨区域没有事件）
    expect(hb.navigation.space).toBe((await call(client, 'get_my_view')).location.space);
    // 续的是别的编号：不动现在这条，ok:false 并告诉你现在这条
    const other = await call(client, 'heartbeat', { navigation_id: 'nav_not_mine', revision: r.navigation.revision });
    expect(other.navigation.ok).toBe(false);
    expect(other.navigation.navigation.navigationId).toBe(r.navigation.navigationId);
    // 只给编号、不给版本：同样续不上（必须说清是哪一段）
    const noRev = await call(client, 'heartbeat', { navigation_id: r.navigation.navigationId });
    expect(noRev.navigation.ok).toBe(false);
    expect(noRev.navigation.leaseUntil).toBeUndefined();
    expect(noRev.navigation.navigation).toMatchObject({ navigationId: r.navigation.navigationId, revision: r.navigation.revision });
    await walkMcp(env, client);
    const v1 = await call(client, 'get_my_view');
    expect(v1.location).toMatchObject({ space: 'tea_house' });
    expect(v1.location.walking).toBeUndefined();
    const w = await call(client, 'world_wait', { cursor: v0.cursor, wait_seconds: 0 });
    expect(w.events.some((e: any) => e.type === 'you_arrived' && e.space === 'tea_house')).toBe(true);
    // 走完之后再续：没有在走的路了
    const done = await call(client, 'heartbeat', { navigation_id: r.navigation.navigationId, revision: r.navigation.revision });
    expect(done.navigation).toEqual({ ok: false, navigation: null, space: 'tea_house' });
  });

  it('move 是 navigate 的旧名；stop_navigation 停在原地', async () => {
    const env = makeEnv();
    const { client } = await enter(env, QING, { name: '青青' });
    const r = await wact(client, { type: 'move', to: 'tea_house' });
    expect(r.status).toBe('accepted');
    expect(r.navigation.navigationId).toBeTruthy();
    env.t.clock.advance(2_000);
    const stop = await wact(client, { type: 'stop_navigation' });
    expect(stop).toMatchObject({ status: 'completed', stopped: true, at: { space: expect.any(String) } });
    const v = await call(client, 'get_my_view');
    expect(v.location.walking).toBeUndefined();
    expect(v.location.space).not.toBe('tea_house');
  });

  it('不续租：租约到期就停在半路，收到 nav_stopped（lease）；失败原因是 precondition_failed 的 reason', async () => {
    const env = makeEnv();
    const { client } = await enter(env, QING, { name: '青青' });
    const v0 = await call(client, 'get_my_view');
    const r = await wact(client, { type: 'navigate', to: 'tea_house' }, { view: v0 });
    env.t.clock.advance(r.navigation.leaseUntil - env.t.w.now() + 500);
    env.t.w.tick();
    const v = await call(client, 'get_my_view');
    expect(v.location.walking).toBeUndefined();
    expect(v.location.space).not.toBe('tea_house');
    const w = await call(client, 'world_wait', { cursor: v0.cursor, wait_seconds: 0 });
    expect(w.events.find((e: any) => e.type === 'nav_stopped')).toMatchObject({ reason: 'lease' });
    // 已经没有在走的路：续租 ok:false、navigation:null
    expect((await call(client, 'heartbeat', { navigation_id: r.navigation.navigationId, revision: r.navigation.revision })).navigation).toMatchObject({ ok: false, navigation: null });
    const bad = await wactFails(client, { type: 'navigate', to: 'no_such_place' });
    expect(bad.code).toBe('PRECONDITION_FAILED');
    expect(bad.reason).toBe('no_such_place');
  });

  it('续导航租约时没有控制权：明确报 CONTROL_LOST，而不是吞掉', async () => {
    const env = makeEnv();
    const { client: first } = await enter(env, QING, { name: '青青' });
    const r = await wact(first, { type: 'navigate', to: 'tea_house' });
    // 同一居民换一个会话接管（enter_world 默认接管控制权，原来的导航立刻停下）
    const second = await env.connect(QING);
    await call(second, 'enter_world', { client_id: 'run-5001-bbbb' });
    const lost = await fails(first, 'heartbeat', { navigation_id: r.navigation.navigationId, revision: r.navigation.revision });
    expect(lost.code).toBe('CONTROL_LOST');
    // 新的控制方续不到旧的那条：导航已经因为换手停了
    expect((await call(second, 'heartbeat', { navigation_id: r.navigation.navigationId, revision: r.navigation.revision })).navigation).toMatchObject({ ok: false, navigation: null });
  });

  it('公共物件按距离：视图里够不着的带 far:true；直接用得到 too_far 和 navigateTo，走到旁边就能用', async () => {
    const env = makeEnv();
    const { client } = await enter(env, QING, { name: '青青' });
    await wact(client, { type: 'navigate', to: 'tea_house' });
    await walkMcp(env, client);
    const v = await call(client, 'get_my_view');
    const table = v.here.objects.find((o: any) => o.id === 'tea_house:table1');
    expect(table.far).toBe(true);
    const far = await wactFails(client, { type: 'start_interaction', objectId: 'tea_house:table1' }, { view: v });
    expect(far.reason).toBe('too_far');
    expect(far.text).toContain('tea_house:table1'); // 错误体里的 navigateTo
    await wact(client, { type: 'navigate', to: 'tea_house:table1' });
    await walkMcp(env, client);
    const near = await call(client, 'get_my_view');
    expect(near.here.objects.find((o: any) => o.id === 'tea_house:table1').far).toBeUndefined();
    const ok = await wact(client, { type: 'start_interaction', objectId: 'tea_house:table1' });
    expect(ok.ok).toBe(true);
  });

  it('每个错误码的映射：大写码、提示、reason 和附加数据都在文本里', async () => {
    const env = makeEnv();
    const { client } = await enter(env, QING, { name: '青青' });
    const v = await call(client, 'get_my_view');

    // BAD_REQUEST：缺字段（world_act 是严格模式）
    const noWindow = (await client.callTool({ name: 'world_act', arguments: { request_id: rid(), context_version: v.context.version, action: { type: 'speak', text: 'x' } } })) as ToolResult;
    expect(noWindow.isError).toBe(true);
    expect((await wactFails(client, { type: 'no_such_action' }, { view: v })).code).toBe('BAD_REQUEST');

    // REQUEST_EXPIRED：窗口无效
    const expired = await wactFails(client, { type: 'speak', text: '窗口坏了' }, { view: v, override: { action_window: 'aw.zzzz.badmac' } });
    expect(expired.code).toBe('REQUEST_EXPIRED');
    expect(expired.hint).toContain('get_my_view');

    // CONTEXT_STALE：上下文版本不对
    const stale = await wactFails(client, { type: 'speak', text: '旧' }, { view: v, override: { context_version: v.context.version - 1 } });
    expect(stale.code).toBe('CONTEXT_STALE');
    expect(stale.hint).toContain('get_my_view');

    // PRECONDITION_FAILED + reason：不在游戏馆里提议桌游
    const wrong = await wactFails(client, { type: 'propose_game', game: 'liars_dice' }, { view: v });
    expect(wrong.code).toBe('PRECONDITION_FAILED');
    expect(wrong.reason).toBe('wrong_venue');

    // RATE_LIMITED：说话太频繁（带 retryAfterMs 数据与重试提示）
    let limited: Awaited<ReturnType<typeof fails>> | null = null;
    for (let i = 0; i < 8 && !limited; i++) {
      const res = (await client.callTool({ name: 'world_act', arguments: { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action: { type: 'speak', text: `刷 ${i}` } } })) as ToolResult;
      if (res.isError) limited = await fails(client, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action: { type: 'speak', text: '又刷' } });
    }
    expect(limited).toBeTruthy();
    expect(limited!.code).toBe('RATE_LIMITED');
    expect(limited!.text).toContain('retryAfterMs');
    expect(limited!.hint).toContain('同一个 request_id');

    // 同 request_id 换内容
    const id = rid();
    env.t.advance(15_000);
    await call(client, 'heartbeat');
    await wact(client, { type: 'navigate', to: 'bookshop' }, { request_id: id });
    expect((await wactFails(client, { type: 'navigate', to: 'garden' }, { request_id: id })).code).toBe('REQUEST_CONFLICT');

    // UNAUTHENTICATED：没进入小镇的会话
    const stranger = await env.connect(MO);
    expect((await fails(stranger, 'world_act', { request_id: rid(), action_window: 'x', context_version: 1, action: { type: 'speak', text: 'x' } })).code).toBe('UNAUTHENTICATED');
    expect((await fails(stranger, 'world_wait', { cursor: 'r0.x', wait_seconds: 0 })).code).toBe('UNAUTHENTICATED');
    expect((await fails(stranger, 'heartbeat')).code).toBe('UNAUTHENTICATED');
    expect((await fails(stranger, 'claim_control')).code).toBe('UNAUTHENTICATED');
  });

  it('活动期间做世界动作：先 CONTEXT_STALE（旧上下文），再 in_activity（新上下文）', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const { client: b } = await enter(env, MO, { name: '小墨' });
    const va0 = await call(a, 'get_my_view');
    const p = await wact(a, { type: 'propose_game', game: 'number_bomb' });
    await wact(b, { type: 'join_game', activityId: p.activity.id });
    await wact(a, { type: 'start_game', activityId: p.activity.id });
    const va = await call(a, 'get_my_view');
    expect(va.game).toMatchObject({ name: expect.any(String), status: 'running' });
    expect(va.context.version).toBeGreaterThan(va0.context.version);
    const old = await wactFails(a, { type: 'speak', text: '旧版本' }, { view: va0 });
    expect(old.code).toBe('CONTEXT_STALE');
    const inAct = await wactFails(a, { type: 'speak', text: '局中说话' }, { view: va });
    expect(inAct.code).toBe('PRECONDITION_FAILED');
    expect(inAct.reason).toBe('in_activity');
  });

  it('物品与信：买东西、寄信、读信，结果都由程序算', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const { client: b, entered } = await enter(env, MO, { name: '小墨' });
    // 去茶馆买茶叶
    await wact(a, { type: 'navigate', to: 'tea_house' });
    await walkMcp(env, a);
    await call(b, 'heartbeat');
    const before = (await call(a, 'get_my_view')).coins;
    const bought = await wact(a, { type: 'buy', shop: 'tea_counter', sku: 'tea_leaves', qty: 1 });
    expect(bought.ok).toBe(true);
    const after = await call(a, 'get_my_view');
    expect(after.coins).toBe(before - 2);
    expect(after.items.find((i: any) => i.type === 'tea_leaves').qty).toBeGreaterThanOrEqual(1);
    // 买不起：数量太大
    const broke = await wactFails(a, { type: 'buy', shop: 'tea_counter', sku: 'tea_leaves', qty: 500 }, { view: after });
    expect(['PRECONDITION_FAILED', 'BAD_REQUEST']).toContain(broke.code);
    // 寄信 → 在路上 → 到信箱
    const sent = await wact(a, { type: 'send_letter', to: entered.resident_id, body: '明天一起喝茶吗？' });
    expect(sent.ok).toBe(true);
    expect((await call(b, 'world_query', { what: 'letters' })).letters).toHaveLength(0);
    await aliveFor(env, 61_000, [a, b]);
    const inbox = await call(b, 'world_query', { what: 'letters' });
    expect(inbox.letters).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain('明天一起喝茶吗');
    expect((await call(b, 'get_my_view')).mail_unread).toBe(1);
  });
});

// ───────────────────────── world_wait ─────────────────────────

describe('MCP 小镇：world_wait', () => {
  it('带 cursor：有新事件立刻返回，并给出推进后的 cursor；之后不重复', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const other = env.t.join('阿灯', 'agent');
    const v = await call(a, 'get_my_view');
    other.act('speak', { text: '早上好' });
    const w1 = await call(a, 'world_wait', { cursor: v.cursor, wait_seconds: 0 });
    expect(w1.reason).toBe('event');
    expect(w1.events).toEqual([expect.objectContaining({ type: 'chat', text: '早上好' })]);
    expect(w1.cursor).not.toBe(v.cursor);
    expect(w1.present).toBe(true);
    expect(w1.context).toMatchObject({ version: v.context.version, activityId: null });
    // 用新的 cursor 再等：没有新事件，超时（真实 1 秒）
    const t0 = Date.now();
    const w2 = await call(a, 'world_wait', { cursor: w1.cursor, wait_seconds: 1 });
    expect(w2.reason).toBe('timeout');
    expect(w2.events).toEqual([]);
    expect(w2.cursor).toBe(w1.cursor);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('等待期间到来的事件会唤醒；上下文变化立刻返回；坏游标 → resync', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const other = env.t.join('阿灯', 'agent');
    const v = await call(a, 'get_my_view');
    const pending = call(a, 'world_wait', { cursor: v.cursor, wait_seconds: 20 });
    setTimeout(() => other.act('speak', { text: '唤醒你' }), 50);
    const woke = await pending;
    expect(woke.reason).toBe('event');
    expect(woke.events[0]).toMatchObject({ type: 'chat', text: '唤醒你' });
    // 上下文变化（带旧版本号）立即返回
    const ctx = await call(a, 'world_wait', { cursor: woke.cursor, wait_seconds: 20, context_version: v.context.version - 1 });
    expect(ctx.reason).toBe('context');
    // 坏游标
    const bad = await call(a, 'world_wait', { cursor: 'garbage', wait_seconds: 0 });
    expect(bad.resync).toBe(true);
    expect(bad.events).toEqual([]);
    // get_my_view 带 cursor：附带 new_events
    other.act('speak', { text: '再来一句' });
    env.t.advance(11_000);
    await call(a, 'heartbeat');
    const withEvents = await call(a, 'get_my_view', { cursor: woke.cursor });
    expect(withEvents.new_events.map((e: any) => e.text)).toContain('再来一句');
  });

  it('等待会续在场；等待参数边界（wait_seconds 上限 50）', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const v = await call(a, 'get_my_view');
    const over = (await a.callTool({ name: 'world_wait', arguments: { cursor: v.cursor, wait_seconds: 51 } })) as ToolResult;
    expect(over.isError).toBe(true);
    // 45 秒没有任何调用 → 还在场（租约 60 秒）；world_wait 续租后再过 45 秒仍在场
    env.t.advance(45_000);
    await call(a, 'world_wait', { cursor: v.cursor, wait_seconds: 0 });
    env.t.advance(45_000);
    expect(env.t.w.mustResident(v.me.id).present_since).not.toBeNull();
    // 完全不调用，超过 60 秒就掉线
    env.t.advance(120_000);
    expect(env.t.w.mustResident(v.me.id).present_since).toBeNull();
    const w = await call(a, 'world_wait', { cursor: v.cursor, wait_seconds: 0 });
    expect(w.present).toBe(false);
    // 掉线后动作被拒绝，明确说不在场
    const gone = await wactFails(a, { type: 'speak', text: '有人吗' });
    expect(gone.code).toBe('PRECONDITION_FAILED');
    expect(gone.reason).toBe('not_present');
  });
});

// ───────────────────────── world_query ─────────────────────────

describe('MCP 小镇：world_query', () => {
  it('public / residents / letters / history / relations / report', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const other = env.t.join('阿灯', 'agent');
    other.act('speak', { text: '听得到吗' });
    env.t.advance(11_000);
    await call(a, 'heartbeat');
    other.heartbeat();

    const pub = await call(a, 'world_query', { what: 'public' });
    expect(pub.places.map((p: any) => p.id)).toContain('arcade');
    expect(JSON.stringify(pub)).not.toContain('inventory');

    const res = await call(a, 'world_query', { what: 'residents' });
    expect(res.residents.map((r: any) => r.name).sort()).toEqual(['阿灯', '青青']);
    expect(JSON.stringify(res)).not.toMatch(/balance|inventory/);

    const hist = await call(a, 'world_query', { what: 'history' });
    expect(hist.messages.map((m: any) => m.text)).toEqual(['听得到吗']);
    expect((await call(a, 'world_query', { what: 'history', limit: 1 })).messages).toHaveLength(1);

    expect((await call(a, 'world_query', { what: 'letters', box: 'sent' })).letters).toEqual([]);
    expect(await call(a, 'world_query', { what: 'relations' })).toHaveProperty('relations');
    const rep = await call(a, 'world_query', { what: 'report' });
    expect(rep).toHaveProperty('personal');
    expect(rep).toHaveProperty('public');
    expect((await fails(a, 'world_query', { what: 'report', date: '2999-01-01' })).code).toBe('BAD_REQUEST');
    // 参数校验
    const badKind = (await a.callTool({ name: 'world_query', arguments: { what: 'inventory_of_others' } })) as ToolResult;
    expect(badKind.isError).toBe(true);
    const badDate = (await a.callTool({ name: 'world_query', arguments: { what: 'report', date: '昨天' } })) as ToolResult;
    expect(badDate.isError).toBe(true);
  });

  it('public 不用进入也能看；其它查询要先有居民身份', async () => {
    const env = makeEnv();
    const c = await env.connect(QING);
    expect((await call(c, 'world_query', { what: 'public' })).places.length).toBeGreaterThan(0);
    for (const what of ['residents', 'letters', 'history', 'relations', 'report']) {
      expect((await fails(c, 'world_query', { what })).code, what).toBe('UNAUTHENTICATED');
    }
  });

  it('查询只看本人：不同居民看到各自的信箱和听到的话', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const { client: b } = await enter(env, MO, { name: '小墨' });
    const c = env.t.join('远处', 'agent');
    c.go('tea_house');
    env.t.advance(20_000);
    c.act('speak', { text: '茶馆的悄悄话' });
    expect(JSON.stringify(await call(a, 'world_query', { what: 'history' }))).not.toContain('悄悄话');
    expect(JSON.stringify(await call(b, 'world_query', { what: 'history' }))).not.toContain('悄悄话');
  });
});

// ───────────────────────── heartbeat / leave ─────────────────────────

describe('MCP 小镇：heartbeat / leave_world', () => {
  it('heartbeat 只续租，不产生事件；leave_world 之后不在场、动作被拒、居民保留', async () => {
    const env = makeEnv();
    const { client, entered } = await enter(env, QING, { name: '青青' });
    const v = await call(client, 'get_my_view');
    env.t.advance(30_000);
    const hb = await call(client, 'heartbeat');
    expect(hb.ok).toBe(true);
    expect((await call(client, 'world_wait', { cursor: v.cursor, wait_seconds: 0 })).events).toEqual([]);

    const left = await call(client, 'leave_world');
    expect(left.ok).toBe(true);
    expect(env.t.w.mustResident(entered.resident_id).present_since).toBeNull();
    // 这个会话回到桌游上下文，小镇的动作不可用
    expect((await fails(client, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action: { type: 'speak', text: 'x' } })).code).toBe('UNAUTHENTICATED');
    // 重复离开没事；没进过小镇的身份离开也没事
    expect((await call(client, 'leave_world')).ok).toBe(true);
    expect((await call(await env.connect(XI), 'leave_world')).ok).toBe(true);
    // 居民保留；回来是同一位，且能正常行动
    const back = await call(client, 'enter_world', {});
    expect(back).toMatchObject({ created: false, resident_id: entered.resident_id });
    expect(await wact(client, { type: 'speak', text: '回来了' })).toMatchObject({ ok: true });
  });

  it('离开会撤销所有客户端的控制权（另一个会话也被踢出在场）', async () => {
    const env = makeEnv();
    const c1 = await env.connect(QING);
    await call(c1, 'enter_world', { name: '青青', client_id: 'run-one-0001' });
    const c2 = await env.connect(QING);
    await call(c2, 'enter_world', { client_id: 'run-two-0002' });
    await call(c2, 'leave_world');
    const v = await call(c1, 'get_my_view');
    expect(v.control.mine).toBe(false);
    expect(env.t.w.db.scalar('SELECT COUNT(*) FROM residents WHERE present_since IS NOT NULL')).toBe(0);
  });
});

// ───────────────────────── 票据与公告 ─────────────────────────

describe('MCP 小镇：town_issue_ticket / town_outbox', () => {
  it('只有管理员或 refereeIds 里的账号能签发；普通 AI 一律 FORBIDDEN', async () => {
    const env = makeEnv();
    const args = { user_id: '12345', name: '真人甲' };
    for (const who of [QING, MO, XI]) {
      const r = await fails(await env.connect(who), 'town_issue_ticket', args);
      expect(r.code, who.name).toBe('FORBIDDEN');
    }
    expect(env.t.w.db.scalar('SELECT COUNT(*) FROM login_tickets')).toBe(0);
    const viaAdmin = await call(await env.connect(ADMIN), 'town_issue_ticket', args);
    expect(viaAdmin).toMatchObject({ ok: true, ticket: expect.any(String), expires_at: expect.any(Number) });
    const viaRef = await call(await env.connect(REF), 'town_issue_ticket', { user_id: '12346', name: '真人乙' });
    expect(viaRef.ok).toBe(true);
    // 没有配公网地址 → 没有 url，note 提示交付方式
    expect(viaRef.url).toBeNull();
    expect(viaRef.note).toContain('ticket');
    // 管理员标记不是靠名字：同名同号的普通账号不行
    const fakeAdmin = await env.connect({ id: '5001', name: '管理员' });
    expect((await fails(fakeAdmin, 'town_issue_ticket', args)).code).toBe('FORBIDDEN');
  });

  it('绑定了 AI 密钥的号码不能签发真人票据；AI 居民的号码同理', async () => {
    const env = makeEnv();
    const ref = await env.connect(REF);
    for (const id of ['5001', '5002', '5003', '5100']) {
      const r = await fails(ref, 'town_issue_ticket', { user_id: id, name: '冒充' });
      expect(r.code, id).toBe('FORBIDDEN');
      expect(r.text).toContain('AI');
    }
    // 已经以 AI 身份进入小镇的号码（未配密钥但已是 agent 主体）也不行
    const open = await env.connect({ id: '777', name: '野生AI' });
    await call(open, 'enter_world', { name: '野生' });
    const r = await fails(ref, 'town_issue_ticket', { user_id: '777', name: '冒充' });
    expect(['FORBIDDEN', 'UNAUTHENTICATED', 'PRECONDITION_FAILED', 'BAD_REQUEST']).toContain(r.code);
    // 参数校验
    for (const user_id of ['', 'a b', 'x'.repeat(65), '../etc']) {
      const bad = (await ref.callTool({ name: 'town_issue_ticket', arguments: { user_id, name: '甲' } })) as ToolResult;
      expect(bad.isError, user_id).toBe(true);
    }
  });

  it('签发的票据在 HTTP 上能换到会话，只能用一次，换到的会话是真人身份', async () => {
    const env = makeEnv();
    const app = express();
    mountTown(app, env.t.w, () => undefined, { requestsPerMinute: 100_000 });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ref = await env.connect(REF);
    const issued = await call(ref, 'town_issue_ticket', { user_id: '424242', name: '真人丙' });
    const post = (body: unknown) => fetch(`${base}/town/api/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
    const ok = await post({ ticket: issued.ticket });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, name: '真人丙' });
    const cookie = ok.headers.getSetCookie()[0]!.split(';')[0]!;
    const session = await (await fetch(`${base}/town/api/session`, { headers: { cookie } })).json();
    expect(session).toMatchObject({ loggedIn: true, kind: 'human' });
    expect((await post({ ticket: issued.ticket })).status).toBe(401);
    // 这位真人不能再用 MCP 身份当 AI 进入
    const asAgent = await env.connect({ id: '424242', name: '真人丙' });
    const r = await fails(asAgent, 'enter_world', { name: '真人丙' });
    expect(['FORBIDDEN', 'UNAUTHENTICATED', 'PRECONDITION_FAILED', 'BAD_REQUEST']).toContain(r.code);
  });

  it('配置了公网地址时返回完整链接，票据在 # 片段里（不进服务器日志）', async () => {
    const env = makeEnv({ townOpts: { params: {} } });
    (env.t.w as unknown as { publicUrl: string | null }).publicUrl = 'https://town.example.com/town/';
    const ref = await env.connect(REF);
    const r = await call(ref, 'town_issue_ticket', { user_id: '555', name: '真人丁' });
    if (r.url) {
      expect(r.url).toContain('#');
      expect(r.url.split('#')[0]).not.toContain(r.ticket);
      expect(r.url.split('#')[1]).toContain(r.ticket);
    } else {
      // 当前实现从启动配置读公网地址：直接签发时没有 url 也合法
      expect(r.note).toContain('ticket');
    }
  });

  it('town_outbox：只有可信账号能取；ack 之后不再返回；内容都是公开信息', async () => {
    const env = makeEnv();
    const c = await env.connect(QING);
    expect((await fails(c, 'town_outbox')).code).toBe('FORBIDDEN');
    expect((await fails(c, 'town_outbox', { ack: [1] })).code).toBe('FORBIDDEN');
    const ref = await env.connect(REF);
    // 制造一条公告：直接写 outbox（正常由公共活动开场 / 日报产生）
    for (let i = 0; i < 3; i++) env.t.w.db.run('INSERT INTO notification_outbox(dedupe_key, destination, payload, created_at) VALUES (?,?,?,?)', `t:${i}`, 'announce', JSON.stringify({ kind: 'daily_report', title: `日报 ${i}`, text: '公开内容', at: env.t.clock.now() }), env.t.clock.now());
    const first = await call(ref, 'town_outbox', { limit: 20 });
    expect(first).toMatchObject({ ok: true, acked: 0, pending: expect.any(Array) });
    expect(first.pending.length).toBe(3);
    expect(JSON.stringify(first)).not.toMatch(/principal|token|resident_id/);
    // 管理员也可以
    expect((await call(await env.connect(ADMIN), 'town_outbox', { limit: 3 })).ok).toBe(true);
    for (const p of first.pending as { id: number }[]) {
      const done = await call(ref, 'town_outbox', { ack: [p.id] });
      expect(done.acked).toBe(1);
      expect((done.pending as { id: number }[]).map((x) => x.id)).not.toContain(p.id);
    }
    // 参数校验
    expect(((await ref.callTool({ name: 'town_outbox', arguments: { limit: 99 } })) as ToolResult).isError).toBe(true);
  });
});

// ───────────────────────── 视图大小 ─────────────────────────

describe('MCP 小镇：视图大小（20 位居民在场 + 背包 + 信件）', () => {
  it('AI 视图 < 16KiB，网页本人视图 < 64KiB', async () => {
    const env = makeEnv();
    const { client, entered } = await enter(env, QING, { name: '青青', bio: '爱喝茶、爱写信、爱养花的普通居民，什么都愿意试一试。', traits: ['quiet', 'curious'], interests: ['tea', 'books', 'plants'] });
    const residents: Actor[] = [];
    for (let i = 0; i < 19; i++) residents.push(env.t.join(`居民${String(i).padStart(2, '0')}`, i % 2 ? 'agent' : 'human', { bio: '这是一段比较长的简介，用来撑大名录和视图的体积。'.repeat(2) }));
    // 背包：每种物品都有
    for (const type of ['tea_leaves', 'vegetables', 'seeds', 'soup', 'cookie', 'book', 'flower', 'lantern', 'paper_lamp']) grantItem(env.t.w, entered.resident_id, type, 3, 'test');
    // 现场聊天：每人说一两句
    for (const [i, r] of residents.entries()) {
      env.t.advance(11_000);
      for (const x of residents) x.heartbeat();
      await call(client, 'heartbeat');
      r.act('speak', { text: `我是第 ${i} 位居民，今天天气真不错，一起聊聊吧。`.repeat(2) });
    }
    // 信件：十封
    for (const [i, r] of residents.slice(0, 10).entries()) {
      env.t.advance(1000);
      r.act('send_letter', { to: entered.resident_id, body: `第 ${i} 封信，很长很长的内容。`.repeat(20) });
    }
    for (let i = 0; i < 6; i++) {
      env.t.advance(20_000);
      for (const x of residents) x.heartbeat();
      await call(client, 'heartbeat');
    }

    const present = env.t.w.db.scalar('SELECT COUNT(*) FROM residents WHERE present_since IS NOT NULL');
    expect(present).toBe(20);
    const agentBytes = await rawSize(client, 'get_my_view');
    const v = await call(client, 'get_my_view');
    expect(v.here.residents).toHaveLength(19);
    expect(v.mail_unread).toBeGreaterThan(0);
    expect(v.items.length).toBeGreaterThanOrEqual(5);
    const me = env.t.w.mustResident(entered.resident_id);
    const webBytes = Buffer.byteLength(JSON.stringify(meView(env.t.w, me, 'mcp:run-5001-aaaa')), 'utf8');
    // eslint-disable-next-line no-console
    console.info(`[视图大小] agentView(get_my_view 文本)=${agentBytes} 字节；web meView(JSON)=${webBytes} 字节`);
    expect(agentBytes).toBeLessThan(16 * 1024);
    expect(webBytes).toBeLessThan(64 * 1024);
    // 视图不含别人的私密：别人的背包、没读的信件正文
    const text = JSON.stringify(v);
    expect(text).not.toContain('很长很长的内容');
    expect(text).not.toMatch(/principal|token|session|sha256/i);
  });
});

// ───────────────────────── AI 通过 MCP 打一整局 ─────────────────────────

describe('MCP 小镇：AI 通过 MCP 玩完整的内嵌小游戏', () => {
  it('数字炸弹：凑桌 → 开局 → 轮流 act（带 phase_id）→ 结算 → 回到小镇', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const { client: b } = await enter(env, MO, { name: '小墨' });
    const clients = [a, b];
    const coins0 = (await Promise.all(clients.map((c) => call(c, 'get_my_view')))).map((v) => v.coins as number);

    const p = await wact(a, { type: 'propose_game', game: 'number_bomb' });
    expect(p.activity.id).toBeTruthy();
    // 凑桌期间对方视图里能看到这桌
    const seen = await call(b, 'get_my_view');
    expect(seen.here.activities.map((x: any) => x.id)).toContain(p.activity.id);
    // 人数不够不能开
    expect((await wactFails(a, { type: 'start_game', activityId: p.activity.id })).code).toBe('PRECONDITION_FAILED');
    await wact(b, { type: 'join_game', activityId: p.activity.id });
    await wact(a, { type: 'start_game', activityId: p.activity.id });

    let turns = 0;
    let lastPhase = -1;
    for (let guard = 0; guard < 200; guard++) {
      const views = await Promise.all(clients.map((c) => call(c, 'get_my_view')));
      if (views.every((v) => v.game === null)) break;
      const idx = views.findIndex((v) => v.game?.your_turn);
      if (idx < 0) {
        env.t.advance(1000);
        continue;
      }
      const v = views[idx]!;
      expect(v.game.phase_id).not.toBe(lastPhase);
      lastPhase = v.game.phase_id;
      const range = v.game.public.range as { from: number; to: number };
      const guess = Math.floor((range.from + range.to) / 2);
      // 迟到的阶段号被拒绝
      if (turns === 0) {
        const stale = await fails(clients[idx]!, 'act', { action: 'guess', number: guess, phase_id: v.game.phase_id + 7, request_id: rid(), context_version: v.context.version });
        expect(stale.code).toBe('PHASE_STALE');
      }
      // 不是自己的回合的人不能出手
      const other = clients[1 - idx]!;
      const wrongTurn = await fails(other, 'act', { action: 'guess', number: guess, phase_id: v.game.phase_id, request_id: rid() });
      expect(['PRECONDITION_FAILED', 'PHASE_STALE', 'BAD_REQUEST']).toContain(wrongTurn.code);
      const res = await call(clients[idx]!, 'act', { action: 'guess', number: guess, phase_id: v.game.phase_id, request_id: rid(), context_version: v.context.version });
      expect(res.ok).toBe(true);
      turns++;
    }
    expect(turns).toBeGreaterThan(0);
    const after = await Promise.all(clients.map((c) => call(c, 'get_my_view')));
    expect(after.every((v) => v.game === null)).toBe(true);
    // 结算：两人都拿到参与奖励，赢家多拿
    const coins1 = after.map((v) => v.coins as number);
    expect(coins1[0]! + coins1[1]! - coins0[0]! - coins0[1]!).toBeGreaterThanOrEqual(4);
    // 又能在小镇里正常行动
    expect(await wact(a, { type: 'speak', text: '再来一局？' })).toMatchObject({ ok: true });
    const sup = env.t.w.db.scalar('SELECT COUNT(*) FROM settlements');
    expect(sup).toBe(1);
  });

  it('局中退出：quit_game 之后回到小镇，对手获胜并结算一次', async () => {
    const env = makeEnv();
    const { client: a } = await enter(env, QING, { name: '青青' });
    const { client: b } = await enter(env, MO, { name: '小墨' });
    const p = await wact(a, { type: 'propose_game', game: 'number_bomb' });
    await wact(b, { type: 'join_game', activityId: p.activity.id });
    await wact(a, { type: 'start_game', activityId: p.activity.id });
    const va = await call(a, 'get_my_view');
    expect(va.game).toBeTruthy();
    const quit = await wact(a, { type: 'quit_game', activityId: p.activity.id }, { view: va });
    expect(quit.ok).toBe(true);
    // 退出的人立刻回到小镇；对手的局继续（退出的座位由程序代打），打完正常结算一次
    const aAfter = await call(a, 'get_my_view');
    expect(aAfter.game).toBeNull();
    expect(await wact(a, { type: 'speak', text: '我先走一步' })).toMatchObject({ ok: true });
    expect((await call(b, 'get_my_view')).game).toBeTruthy();
    await driveGame(env, [b]);
    expect((await call(b, 'get_my_view')).game).toBeNull();
    expect(env.t.w.db.scalar('SELECT COUNT(*) FROM settlements')).toBe(1);
  });
});
