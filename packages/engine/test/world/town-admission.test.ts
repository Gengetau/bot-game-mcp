/**
 * 小镇准入名单（town.allowedAgents）和「真人登录票据只有管理员能签」（town.adminOnlyTickets）。
 * 真实的 MCP 客户端（内存传输）→ createMcpServer → 世界；世界用假时钟。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema, loadConfig } from '../../src/config.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { townPolicy, type TownDeps } from '../../src/mcp/town.js';
import { createRuntime } from '../../src/server/runtime.js';
import { makeTown, type Town } from './helpers.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

// 固定文案：故意写成字面量，不从代码里取，这样代码里的文字被改了测试会红
const DENIED = '栖灯镇正在限定测试，这个身份不在进镇名单里。公共对局不受影响；想加入请联系小镇的管理员。';
const DENIED_HINT = '不要重试。名单更新后重新连接再调用 enter_world。';
const TICKETS_ADMIN_ONLY = '栖灯镇正在限定测试，真人登录链接暂时只有管理员能签发。';

const AGENTS = [
  { key: 'key-qing', id: '5001', name: '阿青' },
  { key: 'key-mo', id: '5002', name: '小墨' },
  { key: 'key-xi', id: '5003', name: '阿汐' },
  { key: 'key-ref', id: '5100', name: '代码裁判' },
];
const QING: Identity = { id: '5001', name: '阿青' };
const MO: Identity = { id: '5002', name: '小墨' };
const XI: Identity = { id: '5003', name: '阿汐' };
const REF: Identity = { id: '5100', name: '代码裁判' };
const ADMIN: Identity = { id: '5900', name: '管理员', admin: true };

let seq = 0;
const rid = () => `adm-req-${String(++seq).padStart(6, '0')}`;

interface Env {
  t: Town;
  deps: TownDeps;
  /** town=true：这个会话已经有世界上下文（像是在不限制的时候进过镇的老会话） */
  connect: (who: Identity, o?: { town?: boolean }) => Promise<Client>;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEnv(policy: { allowedAgents?: string[]; adminOnlyTickets?: boolean } = {}, t: Town = makeTown()): Env {
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('adm') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const deps: TownDeps = { world: t.w, auth, trustedIds: [REF.id], ...townPolicy(policy) };
  const connect = async (who: Identity, o: { town?: boolean } = {}) => {
    const ctx: SessionContext & { town?: { clientId: string } } = { identity: who, fixed: true, transport: 'memory' };
    if (o.town) ctx.town = { clientId: `mcp:preset-${who.id}` };
    const server = createMcpServer({ manager, auth, version: 'test', town: deps }, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  return { t, deps, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (res.isError) throw new Error(`工具 ${name} 失败：${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}

async function raw(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** 世界数据库全部表的内容（按表名排序）：被拒的调用前后必须一模一样。 */
function dump(t: Town): string {
  const db = t.w.db.db;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
  const out: Record<string, unknown[]> = {};
  for (const name of tables) out[name] = db.prepare(`SELECT * FROM "${name}"`).all();
  return JSON.stringify(out);
}
const count = (t: Town, table: string) => Number(t.w.db.scalar(`SELECT COUNT(*) FROM ${table}`));

/** 名单外的身份能试的全部居民工具调用（不带世界上下文的会话）。 */
const WORLD_CALLS: { name: string; args: () => Record<string, unknown> }[] = [
  { name: 'enter_world', args: () => ({ name: '路人' }) },
  { name: 'world_act', args: () => ({ request_id: rid(), action_window: 'aw', context_version: 1, action: { type: 'say_nearby', text: '你好' } }) },
  { name: 'world_wait', args: () => ({ cursor: 'c', wait_seconds: 0 }) },
  { name: 'heartbeat', args: () => ({}) },
  { name: 'claim_control', args: () => ({}) },
  { name: 'leave_world', args: () => ({}) },
  { name: 'world_query', args: () => ({ what: 'residents' }) },
  { name: 'world_query', args: () => ({ what: 'history' }) },
];
/** 带世界上下文的会话里，get_my_view / act / speak 改道去小镇。 */
const CONTEXT_CALLS: { name: string; args: () => Record<string, unknown> }[] = [
  { name: 'get_my_view', args: () => ({}) },
  { name: 'get_my_view', args: () => ({ cursor: 'c', wait_seconds: 0 }) },
  { name: 'speak', args: () => ({ text: '你好', request_id: rid() }) },
  { name: 'act', args: () => ({ action: 'guess', number: 5, phase_id: 1, request_id: rid(), context_version: 1 }) },
  { name: 'act', args: () => ({ action: 'guess', number: 5, request_id: rid() }) },
];

async function expectDenied(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await raw(client, name, args);
  const text = res.content[0]!.text;
  expect(res.isError, `${name} 应该被拒：${text.slice(0, 120)}`).toBe(true);
  expect(text, name).toContain(DENIED);
  expect(text, name).toContain('(code: FORBIDDEN)');
  expect(text, name).toContain(`💡 ${DENIED_HINT}`);
  return text;
}

describe('小镇准入名单：放行', () => {
  it('不配 allowedAgents：任何有密钥的身份都能进镇，三位都建出居民', async () => {
    const env = makeEnv();
    for (const who of [QING, MO, XI]) {
      const c = await env.connect(who);
      const r = await call(c, 'enter_world', { name: who.name });
      expect(r.ok).toBe(true);
    }
    expect(count(env.t, 'residents')).toBe(3);
    expect(count(env.t, 'principals')).toBe(3);
  });

  it('配了名单：名单里的身份能进镇、读视图、做动作、等事件、离开', async () => {
    const env = makeEnv({ allowedAgents: ['5001', '5003'] });
    for (const who of [QING, XI]) {
      const c = await env.connect(who);
      const entered = await call(c, 'enter_world', { name: who.name });
      expect(entered.ok).toBe(true);
      const v = await call(c, 'get_my_view');
      expect(v.me.name).toBe(who.name);
      const spoke = await call(c, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action: { type: 'say_nearby', text: '你好' } });
      expect(spoke.ok).toBe(true);
      const waited = await call(c, 'world_wait', { cursor: v.cursor, wait_seconds: 0 });
      expect(waited.reason).toBeDefined();
      expect((await call(c, 'heartbeat')).ok).toBe(true);
      expect((await call(c, 'world_query', { what: 'residents' })).residents).not.toHaveLength(0);
      expect((await call(c, 'leave_world')).ok).toBe(true);
    }
  });
});

describe('小镇准入名单：拒绝', () => {
  it('名单外的身份，每个居民工具都得到逐字相同的 FORBIDDEN（有没有世界上下文各测一遍）', async () => {
    const env = makeEnv({ allowedAgents: ['5001'] });
    const texts = new Set<string>();
    for (const withCtx of [false, true]) {
      const c = await env.connect(MO, { town: withCtx });
      const calls = withCtx ? [...WORLD_CALLS, ...CONTEXT_CALLS] : WORLD_CALLS;
      for (const x of calls) texts.add(await expectDenied(c, x.name, x.args()));
    }
    // 管理员身份不豁免
    for (const x of WORLD_CALLS) texts.add(await expectDenied(await env.connect(ADMIN), x.name, x.args()));
    expect(texts.size).toBe(1);
    // world_query 的公开地图本来就是匿名可读，不受名单影响
    const pub = await call(await env.connect(MO), 'world_query', { what: 'public' });
    expect(pub).toBeDefined();
  });

  it('没有世界上下文的 get_my_view / speak / act 不碰小镇：走原来的桌游路径，不是名单的拒绝', async () => {
    const env = makeEnv({ allowedAgents: ['5001'] });
    const c = await env.connect(MO);
    for (const x of CONTEXT_CALLS.slice(0, 3)) {
      const res = await raw(c, x.name, x.args());
      expect(res.content[0]!.text, x.name).not.toContain('进镇名单');
    }
    expect(count(env.t, 'principals')).toBe(0);
  });

  it('被拒不落任何痕迹；同样的调用在放行时确实会写东西（先证明断言看得见变化）', async () => {
    const env = makeEnv({ allowedAgents: ['5001'] });
    const before = dump(env.t);
    const tables = { principals: count(env.t, 'principals'), residents: count(env.t, 'residents'), sessions: count(env.t, 'sessions') };
    // 放行的身份做同样的调用：数据库必然变
    const q = await env.connect(QING);
    await call(q, 'enter_world', { name: '阿青' });
    await call(q, 'enter_world', { name: '阿青' });
    expect(dump(env.t)).not.toBe(before);
    expect(count(env.t, 'principals')).toBe(tables.principals + 1);
    expect(count(env.t, 'residents')).toBe(tables.residents + 1);
    expect(count(env.t, 'recipient_events') + count(env.t, 'public_events') + count(env.t, 'world_events')).toBeGreaterThan(0);

    const settled = dump(env.t);
    for (const withCtx of [false, true]) {
      const c = await env.connect(MO, { town: withCtx });
      for (const x of [...WORLD_CALLS, ...(withCtx ? CONTEXT_CALLS : [])]) await expectDenied(c, x.name, x.args());
    }
    for (const x of WORLD_CALLS) await expectDenied(await env.connect(ADMIN), x.name, x.args());
    expect(dump(env.t)).toBe(settled);
    expect(count(env.t, 'principals')).toBe(tables.principals + 1);
  });

  it('文字不泄露：从没进过镇的身份，和「不限制时建了居民、再带名单重启」的身份，被拒的文字逐字相同', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'adm-'));
    dirs.push(tmp);
    // 情形 A：从没进过
    const a = makeEnv({ allowedAgents: ['5001'] });
    const textA = await expectDenied(await a.connect(MO), 'enter_world', { name: '小墨' });
    const viewA = await expectDenied(await a.connect(MO, { town: true }), 'get_my_view', {});

    // 情形 B：先不限制，建了居民，再带名单重启
    const t = makeTown({ dbPath: join(tmp, 'town.db') });
    const open = makeEnv({}, t);
    const mo = await open.connect(MO);
    await call(mo, 'enter_world', { name: '小墨' });
    const qing = await open.connect(QING);
    await call(qing, 'enter_world', { name: '阿青' });
    expect(count(t, 'residents')).toBe(2);
    t.restart();
    const b = makeEnv({ allowedAgents: ['5001'] }, t);
    const textB = await expectDenied(await b.connect(MO), 'enter_world', { name: '小墨' });
    const viewB = await expectDenied(await b.connect(MO, { town: true }), 'get_my_view', {});
    expect(textB).toBe(textA);
    expect(viewB).toBe(viewA);
    for (const x of WORLD_CALLS) expect(await expectDenied(await b.connect(MO), x.name, x.args()), x.name).toBe(textA);

    // 那位居民还在名录里，数据没少；租约到期后显示离线
    expect(count(t, 'residents')).toBe(2);
    const q = await b.connect(QING);
    await call(q, 'enter_world', { name: '阿青' });
    t.clock.advance(10 * 60_000);
    t.w.tick();
    await call(q, 'enter_world', { name: '阿青' });
    const dir = (await call(q, 'world_query', { what: 'residents' })).residents as { name: string; present: boolean }[];
    expect(dir.find((x) => x.name === '小墨')).toMatchObject({ present: false });
    expect(dir.find((x) => x.name === '阿青')).toMatchObject({ present: true });
    t.w.close();
  });

  it('空数组：谁都进不来；管理员不在名单里同样被拒，写进名单就能进', async () => {
    const empty = makeEnv({ allowedAgents: [] });
    for (const who of [QING, MO, XI, REF, ADMIN]) await expectDenied(await empty.connect(who), 'enter_world', { name: who.name });
    expect(count(empty.t, 'principals')).toBe(0);
    expect(count(empty.t, 'residents')).toBe(0);
    const withAdmin = makeEnv({ allowedAgents: [ADMIN.id] });
    const r = await call(await withAdmin.connect(ADMIN), 'enter_world', { name: '管理员' });
    expect(r.ok).toBe(true);
    await expectDenied(await withAdmin.connect(QING), 'enter_world', { name: '阿青' });
  });

  it('不受名单影响：town_issue_ticket / town_outbox 有自己的权限；公共对局照常', async () => {
    const env = makeEnv({ allowedAgents: [] });
    const ref = await env.connect(REF);
    expect((await call(ref, 'town_issue_ticket', { user_id: '12345', name: '真人甲' })).ok).toBe(true);
    expect((await call(ref, 'town_outbox')).ok).toBe(true);
    const c = await env.connect(MO);
    const list = await call(c, 'list_games');
    expect(JSON.stringify(list)).toContain('number_bomb');
  });
});

describe('adminOnlyTickets', () => {
  it('默认关：可信账号和管理员都能签票据', async () => {
    const env = makeEnv();
    expect((await call(await env.connect(REF), 'town_issue_ticket', { user_id: '12345', name: '真人甲' })).ok).toBe(true);
    expect((await call(await env.connect(ADMIN), 'town_issue_ticket', { user_id: '12346', name: '真人乙' })).ok).toBe(true);
  });

  it('打开后：可信账号被拒（固定文案、不签票），管理员照常；town_outbox 两种身份都照常', async () => {
    const env = makeEnv({ adminOnlyTickets: true });
    const before = count(env.t, 'login_tickets');
    const res = await raw(await env.connect(REF), 'town_issue_ticket', { user_id: '12345', name: '真人甲' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain(TICKETS_ADMIN_ONLY);
    expect(res.content[0]!.text).toContain('(code: FORBIDDEN)');
    expect(count(env.t, 'login_tickets')).toBe(before);
    expect((await call(await env.connect(ADMIN), 'town_issue_ticket', { user_id: '12346', name: '真人乙' })).ok).toBe(true);
    expect(count(env.t, 'login_tickets')).toBe(before + 1);
    // 普通 AI 仍是原来的拒绝，不是新文案
    const plain = await raw(await env.connect(QING), 'town_issue_ticket', { user_id: '12347', name: '真人丙' });
    expect(plain.content[0]!.text).not.toContain(TICKETS_ADMIN_ONLY);
    expect(plain.isError).toBe(true);
    for (const who of [REF, ADMIN]) expect((await call(await env.connect(who), 'town_outbox')).ok).toBe(true);
  });
});

describe('配置', () => {
  const base = { auth: { mode: 'keys' as const, agents: [{ key: 'bgk_adm_cfg_key_1', id: '5001', name: 'a' }] }, town: { enabled: true } };
  const load = (cfg: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'adm-cfg-'));
    dirs.push(dir);
    const file = join(dir, 'c.json');
    writeFileSync(file, JSON.stringify(cfg));
    return loadConfig(file, {});
  };

  it('allowedAgents 加 auth.mode=open 拒绝启动，说明怎么改', () => {
    expect(() => load({ auth: { mode: 'open' }, town: { enabled: true, allowedAgents: ['5001'] } })).toThrow(/allowedAgents.*密钥模式/);
    // 没写 mode、也没配 agents，同样是开放模式
    expect(() => load({ town: { enabled: true, allowedAgents: [] } })).toThrow(/auth.mode/);
    // 不配名单的开放模式照旧
    expect(() => load({ auth: { mode: 'open' }, town: { enabled: true } })).not.toThrow();
  });

  it('空白元素被拒；重复元素去重；首尾空白去掉；不配就是 undefined', () => {
    expect(() => load({ ...base, town: { enabled: true, allowedAgents: ['5001', '  '] } })).toThrow(/allowedAgents/);
    expect(() => load({ ...base, town: { enabled: true, allowedAgents: [''] } })).toThrow(/allowedAgents/);
    expect(load({ ...base, town: { enabled: true, allowedAgents: ['5001', ' 5001 ', '5002', '5001'] } }).town.allowedAgents).toEqual(['5001', '5002']);
    expect(load(base).town.allowedAgents).toBeUndefined();
    expect(load(base).town.adminOnlyTickets).toBe(false);
    expect(configSchema.parse({}).town.adminOnlyTickets).toBe(false);
  });

  it('启动日志只有个数，没有任何 id', async () => {
    const ids = ['qd-id-aaaa-111111', 'qd-id-bbbb-222222'];
    const cfg = configSchema.parse({
      stateFile: null,
      auth: { mode: 'keys', agents: [{ key: 'bgk_adm_log_key_1', id: ids[0], name: '甲' }, { key: 'bgk_adm_log_key_2', id: ids[1], name: '乙' }], issuedKeysFile: null },
      town: { enabled: true, dbFile: ':memory:', allowedAgents: ids, adminOnlyTickets: true },
    });
    const logs: string[] = [];
    const rt = createRuntime(cfg, (l) => logs.push(l));
    await rt.world!.start();
    await new Promise((r) => setTimeout(r, 50));
    const all = logs.join('\n');
    expect(all).toContain('栖灯镇准入名单已启用：2 个身份可以经 MCP 进镇');
    expect(all).toContain('栖灯镇的真人登录票据只有管理员能签');
    for (const id of ids) expect(all).not.toContain(id);
    rt.close();
  });

  it('不配时不打这两行日志', async () => {
    const cfg = configSchema.parse({ stateFile: null, town: { enabled: true, dbFile: ':memory:' } });
    const logs: string[] = [];
    const rt = createRuntime(cfg, (l) => logs.push(l));
    await rt.world!.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.join('\n')).toContain('栖灯镇已就绪');
    expect(logs.join('\n')).not.toContain('准入名单');
    rt.close();
  });
});
