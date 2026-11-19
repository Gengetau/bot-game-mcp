/**
 * 城市的 MCP 入口：真实的 MCP 客户端（内存传输）→ createMcpServer → 城市的命令管线。
 * 和栖灯镇共用工具名：enter_world（world_id="city"）之后这个会话走城市。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeTown } from '../world/helpers.js';
import { HOUSE_ENTRANCE, KISSA, MIN, makeCity, type CityTest } from './helpers.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const AGENTS = [
  { key: 'key-b', id: '7001', name: '小B' },
  { key: 'key-c', id: '7002', name: '小C' },
  // 妮娅在 QQ 侧的那把密钥（配置里 house[].qqIds 写着它）
  { key: 'key-nia', id: '3001', name: '妮娅' },
];
const B: Identity = { id: '7001', name: '小B' };
const C: Identity = { id: '7002', name: '小C' };
const NIA_QQ: Identity = { id: '3001', name: '妮娅' };

function makeEnv(opts: { town?: boolean; allowed?: string[] } = {}): { t: CityTest; connect: (who: Identity, fixed?: boolean) => Promise<Client> } {
  const t = makeCity();
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('mcp-city') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const town = opts.town ? makeTown() : null;
  const deps = { manager, auth, version: 'test', city: { city: t.c, ...(opts.allowed ? { allowedAgents: opts.allowed } : {}) }, ...(town ? { town: { world: town.w, auth, trustedIds: [] } } : {}) };
  const connect = async (who: Identity, fixed = true) => {
    const ctx: SessionContext = { identity: who, fixed, transport: 'memory' };
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

let seq = 0;
const rid = () => `mcp-city-${String(++seq).padStart(6, '0')}`;
const act = async (client: Client, action: Record<string, unknown>): Promise<any> => {
  const v = await call(client, 'get_my_view');
  return call(client, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action });
};

for (const withTown of [false, true]) {
  describe(withTown ? '城市和栖灯镇同时开着' : '只开了城市', () => {
    it('外部 bot：进城、看、走、买、说、等、查、离开', async () => {
      const { t, connect } = makeEnv({ town: withTown });
      const b = await connect(B);
      // 没进城之前：公开视图可以看，别的不行
      expect((await call(b, 'world_query', { what: 'public', world_id: 'city' })).world_id).toBe('city');
      expect((await fails(b, 'enter_world', { world_id: 'tokyo', name: '小B' })).code).toBe('NOT_FOUND');
      expect((await fails(b, 'world_query', { what: 'public', world_id: 'tokyo' })).code).toBe('NOT_FOUND');
      const entered = await call(b, 'enter_world', { world_id: 'city', name: '小B', entry: 'kagamiike:station' });
      expect(entered).toMatchObject({ ok: true, world_id: 'city', created: true, granted_yen: 200_000, location: { place: 'kagamiike:station' }, wallet: { yen: 200_000 } });
      // 再进一次只是回来
      expect(await call(b, 'enter_world', { world_id: 'city' })).toMatchObject({ created: false, resident_id: entered.resident_id });
      expect((await call(b, 'enter_world', { world_id: 'city' })).granted_yen).toBeUndefined();

      const view = await call(b, 'get_my_view');
      expect(view).toMatchObject({ world_id: 'city', action_window: 'city', context: { version: 0 } });
      expect(view.here.exits.map((x: any) => x.id)).toContain(KISSA);
      const go = await act(b, { type: 'travel', to: KISSA });
      expect(go).toMatchObject({ ok: true, status: 'accepted', trip: { to: KISSA, minutes: 6 } });

      // world_wait：到站事件叫醒等待
      const onTheWay = await call(b, 'get_my_view');
      expect(onTheWay.location).toMatchObject({ in_transit: true });
      const waiting = call(b, 'world_wait', { cursor: onTheWay.cursor, wait_seconds: 5 });
      await new Promise((r) => setTimeout(r, 30));
      t.run(6 * MIN);
      const woke = await waiting;
      expect(woke).toMatchObject({ reason: 'events', present: true });
      expect(woke.events.map((e: any) => e.type)).toEqual(['you_arrived']);

      expect(await act(b, { type: 'buy', sku: 'coffee' })).toMatchObject({ status: 'completed', paid_yen: 450 });
      expect(await act(b, { type: 'consume', item: 'coffee' })).toMatchObject({ status: 'completed' });
      // speak 工具在城里就是 say
      expect(await call(b, 'speak', { text: '这里真安静', request_id: rid() })).toMatchObject({ status: 'completed', heard_by: 0 });
      const poor = await fails(b, 'world_act', { request_id: rid(), action_window: 'city', context_version: 0, action: { type: 'buy', sku: 'nothing' } });
      expect(poor).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'no_such_good' });

      expect((await call(b, 'world_query', { what: 'residents' })).residents).toEqual([expect.objectContaining({ name: '小B', place: KISSA })]);
      expect((await call(b, 'world_query', { what: 'history' })).messages.map((m: any) => m.text)).toEqual(['这里真安静']);
      // 带 cursor 的 get_my_view 把新事件一起带回来
      const again = await call(b, 'get_my_view', { cursor: woke.cursor });
      expect(again.new_events).toEqual([]);

      expect(await call(b, 'leave_world')).toEqual({ ok: true });
      expect(t.c.mustResident(entered.resident_id).in_city).toBe(0);
      // 离开后这个会话不再在城市上下文里
      if (!withTown) expect((await fails(b, 'get_my_view')).code).not.toBe('INTERNAL');
    });

    it('F16：室友在 QQ 侧的密钥进不了城，只能看公开视图', async () => {
      const { t, connect } = makeEnv({ town: withTown });
      const nia = await connect(NIA_QQ);
      const refused = await fails(nia, 'enter_world', { world_id: 'city', name: '妮娅' });
      expect(refused.code).toBe('ENTRY_VIA_HOME_ONLY');
      expect(refused.text).toContain('不要重试');
      expect(t.c.db.scalar("SELECT COUNT(*) FROM principals WHERE provider <> 'ai-house'")).toBe(0);
      expect(t.c.mustResident(t.residentOf('nia')).in_city).toBe(0);
      // 只读查询保留；内容里没有小屋门口
      const pub = await call(nia, 'world_query', { what: 'public', world_id: 'city' });
      expect(JSON.stringify(pub).includes(HOUSE_ENTRANCE)).toBe(false);
      expect((await fails(nia, 'world_query', { what: 'residents', world_id: 'city' })).code).toBe('ENTRY_VIA_HOME_ONLY');
      // 她经外出访问在城里时，这把密钥也不能替她做动作
      const k = t.kernel('nia');
      k.depart({ yen: 3000, to: 'hiwatari:ekimae-plaza' });
      if (!withTown) {
        expect((await fails(nia, 'world_act', { request_id: rid(), action: { type: 'say', text: '我自己来' } })).code).toBe('ENTRY_VIA_HOME_ONLY');
      }
      expect(k.view().here?.recent_chat ?? []).toEqual([]);
    });

    it('两个 bot 在同一个地点：互相看得到、听得到；没进城的会话不能做动作', async () => {
      const { t, connect } = makeEnv({ town: withTown });
      const b = await connect(B);
      const c = await connect(C);
      await call(b, 'enter_world', { world_id: 'city', name: '小B' });
      const cv = await call(c, 'enter_world', { world_id: 'city', name: '小C' });
      expect(cv.here.people.map((p: any) => p.name)).toEqual(['小B']);
      await call(b, 'speak', { text: '你也刚到？', request_id: rid() });
      const heard = await call(c, 'world_wait', { cursor: cv.cursor, wait_seconds: 1 });
      expect(heard.events).toEqual([expect.objectContaining({ type: 'chat', text: '你也刚到？', untrusted: true })]);
      // 另一个没进过城的身份，自己认领的（open 模式）：登记在另一个命名空间，和密钥身份不是同一个居民
      const stranger = await connect({ id: '7001', name: '冒名' }, false);
      const s = await call(stranger, 'enter_world', { world_id: 'city', name: '路人甲' });
      expect(s.created).toBe(true);
      expect(t.c.db.scalar("SELECT COUNT(*) FROM residents WHERE origin = 'external'")).toBe(3);
    });
  });
}

describe('和栖灯镇共用工具名', () => {
  it('同一个会话：进镇走小镇，进城走城市，互不串', async () => {
    const { connect } = makeEnv({ town: true });
    const b = await connect(B);
    const town = await call(b, 'enter_world', { name: '小B' });
    expect(town.world_id).toBe('town');
    expect((await call(b, 'get_my_view')).world_id).toBe('town');
    // 进城之后，不带 game_id 的调用走城市
    await call(b, 'enter_world', { world_id: 'city', name: '小B' });
    expect((await call(b, 'get_my_view')).world_id).toBe('city');
    expect((await call(b, 'world_query', { what: 'public' })).world_id).toBe('city');
    // world_query 可以点名另一个世界
    expect((await call(b, 'world_query', { what: 'residents', world_id: 'city' })).residents).toHaveLength(1);
    // 城市不认识的查询
    expect((await fails(b, 'world_query', { what: 'letters' })).reason).toBe('not_available');
    // 回到小镇
    const back = await call(b, 'enter_world', {});
    expect(back.world_id).toBe('town');
    expect((await call(b, 'get_my_view')).world_id).toBe('town');
    expect((await fails(b, 'enter_world', { world_id: 'osaka' })).code).toBe('NOT_AVAILABLE');
  });

  it('工具说明里写了灯都；有城市指南资源', async () => {
    const { connect } = makeEnv({ town: true });
    const b = await connect(B);
    const tools = (await b.listTools()).tools;
    expect(tools.find((x) => x.name === 'enter_world')!.description).toContain('city');
    expect(tools.find((x) => x.name === 'enter_world')!.description).not.toContain('tokyo');
    expect(tools.find((x) => x.name === 'world_act')!.description).toContain('travel');
    const guide = await b.readResource({ uri: 'botgame://guide/city' });
    expect(String((guide.contents[0] as { text: string }).text)).toContain('enter_world');
  });
});

describe('城市准入名单', () => {
  it('配了名单：名单外的身份进不了城，也不留下任何记录；公开视图照常；室友的密钥仍然是 ENTRY_VIA_HOME_ONLY', async () => {
    const { t, connect } = makeEnv({ allowed: ['7001'] });
    const b = await connect(B);
    const c = await connect(C);
    expect((await call(b, 'enter_world', { world_id: 'city', name: '小B' })).created).toBe(true);
    const refused = await fails(c, 'enter_world', { world_id: 'city', name: '小C' });
    expect(refused).toMatchObject({ code: 'FORBIDDEN', reason: 'not_admitted' });
    expect(t.c.db.scalar("SELECT COUNT(*) FROM principals WHERE subject = '7002'")).toBe(0);
    expect((await call(c, 'world_query', { what: 'public', world_id: 'city' })).world_id).toBe('city');
    expect((await fails(c, 'world_query', { what: 'residents', world_id: 'city' })).code).toBe('FORBIDDEN');
    const nia = await connect(NIA_QQ);
    expect((await fails(nia, 'enter_world', { world_id: 'city' })).code).toBe('ENTRY_VIA_HOME_ONLY');
  });

  it('后来才被移出名单的居民：不能再行动', async () => {
    const open = makeEnv();
    const b = await open.connect(B);
    await call(b, 'enter_world', { world_id: 'city', name: '小B' });
    // 同一个城市，换一份名单（相当于改配置后重启）
    const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('mcp-city-2') });
    const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
    const server = createMcpServer({ manager, auth, version: 'test', city: { city: open.t.c, allowedAgents: [] } }, { identity: B, fixed: true, transport: 'memory' });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(y);
    await client.connect(x);
    expect((await fails(client, 'world_act', { request_id: rid(), action: { type: 'say', text: '还在吗' } })).code).toBe('FORBIDDEN');
    expect((await fails(client, 'get_my_view')).code).not.toBe('INTERNAL');
  });
});
