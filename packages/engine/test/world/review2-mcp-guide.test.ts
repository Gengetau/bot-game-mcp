/**
 * 二轮审查 #9 请求号字符集、#10 TOWN_GUIDE / 居民提示词覆盖全部动作。
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { TOWN_GUIDE } from '../../src/mcp/town.js';
import { REQUEST_ID_RE } from '../../src/world/service.js';
import { makeTown } from './helpers.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const mentions = (text: string, name: string) => new RegExp(`(?<![a-z_])${name}(?![a-z_])`).test(text);

async function connect() {
  const t = makeTown({ params: { shortGoals: 0, longGoals: 0 } });
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('r2-guide') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: [{ key: 'key-qing', id: '5001', name: '阿青' }] }, manager);
  const deps = { manager, auth, version: 'test', town: { world: t.w, auth, trustedIds: [] as string[] } };
  const ctx: SessionContext = { identity: { id: '5001', name: '阿青' }, fixed: true, transport: 'memory' };
  const server = createMcpServer(deps, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(res.isError), text: res.content[0]!.text };
  };
  return { t, client, call };
}

describe('TOWN_GUIDE / 居民提示词覆盖服务端注册的每个动作', () => {
  it('TOWN_GUIDE 提到每个 handler；resident-zh.md 也是', () => {
    const t = makeTown();
    const names = [...t.w.handlers.keys()];
    expect(names.length).toBeGreaterThan(25);
    const prompt = read('../../../agent-kit/prompts/resident-zh.md');
    for (const n of names) {
      expect(mentions(TOWN_GUIDE, n), `TOWN_GUIDE 缺 ${n}`).toBe(true);
      expect(mentions(prompt, n), `resident-zh.md 缺 ${n}`).toBe(true);
    }
  });

  it('TOWN_GUIDE 说明 world_query、start_interaction 的 itemId、choose_goal 和请求号字符集', () => {
    expect(TOWN_GUIDE).toContain('world_query');
    expect(TOWN_GUIDE).toMatch(/start_interaction \{objectId, wait\?, itemId\?\}/);
    expect(TOWN_GUIDE).toContain('choose_goal');
    expect(TOWN_GUIDE).toContain('delete_letter');
    expect(TOWN_GUIDE).toContain('leave_game_lobby');
    expect(TOWN_GUIDE).toContain('字母、数字、下划线和 . : -');
  });
});

describe('TOWN_GUIDE 是新的空间模型', () => {
  it('讲 navigate / stop_navigation / 到达与被截住 / 够得着 / 会馆；不再有旧的在途说法；模型不自己续租', () => {
    const prompt = read('../../../agent-kit/prompts/resident-zh.md');
    for (const text of [TOWN_GUIDE, prompt]) {
      for (const k of ['navigate', 'stop_navigation', 'you_arrived', 'nav_stopped', 'far:true', 'too_far', '灯巷会馆', 'home:<对方id>']) expect(text, k).toContain(k);
      expect(text).toMatch(/续租由运行器自动完成/);
      for (const old of ['在路上不能', '路上不能做', '到了再说', '巷子', 'street_east', 'street_west', 'exits 是相邻', '东灯巷', '西灯巷']) expect(text, old).not.toContain(old);
    }
    // world_wait 的描述提到会被 you_arrived / nav_stopped 唤醒（任何新事件都唤醒）
    expect(TOWN_GUIDE).toMatch(/world_wait[^\n]*you_arrived/);
  });
});

describe('请求号字符集', () => {
  it('正则只放行 8~80 个字母、数字、下划线和 . : -', () => {
    for (const ok of ['abcdefgh', 'a.b:c-d_e1', 'x'.repeat(80)]) expect(REQUEST_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ['short', 'x'.repeat(81), 'move to tea 001', '请求号一二三四五六七八', 'req#00000001', 'a/b/c/d/e/f/g/h']) expect(REQUEST_ID_RE.test(bad), bad).toBe(false);
  });

  it('world_act 的 schema 在到达服务端之前就拒绝非法字符', async () => {
    const { call } = await connect();
    await call('enter_world', { client_id: 'run-5001-aaaa' });
    const v = JSON.parse((await call('get_my_view')).text);
    const base = { action_window: v.action_window, context_version: v.context.version, action: { type: 'speak', text: '你好' } };
    const bad = await call('world_act', { ...base, request_id: 'move to tea 001' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/request_id|字母、数字/);
    const ok = await call('world_act', { ...base, request_id: 'good.req:0001-x' });
    expect(ok.isError).toBe(false);
  });
});

describe('world_query relations 翻页', () => {
  it('with / cursor 翻看共同记忆；不认识的人报错', async () => {
    const { t, call } = await connect();
    const me = JSON.parse((await call('enter_world', { client_id: 'run-5001-aaaa' })).text);
    const b = t.join('小岚', 'agent');
    const rid = me.resident?.id ?? me.residentId ?? me.me?.id;
    expect(rid).toBeTruthy();
    t.w.db.run('INSERT INTO relationships(resident_id, other_id, familiarity, closeness, updated_at) VALUES (?,?,5,0,0)', rid, b.residentId);
    for (let i = 0; i < 12; i++) t.w.db.run('INSERT INTO memory_refs(owner_id, other_id, event_id, kind, summary, occurred_at) VALUES (?,?,?,?,?,?)', rid, b.residentId, 1, 'k', `m${i}`, 1000 + i);
    const p1 = JSON.parse((await call('world_query', { what: 'relations', with: b.residentId, limit: 5 })).text);
    expect(p1.memories.map((m: any) => m.text)).toEqual(['m11', 'm10', 'm9', 'm8', 'm7']);
    const p2 = JSON.parse((await call('world_query', { what: 'relations', with: b.residentId, limit: 5, cursor: p1.next })).text);
    expect(p2.memories.map((m: any) => m.text)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    const stranger = t.join('阿墨', 'agent');
    expect((await call('world_query', { what: 'relations', with: stranger.residentId })).isError).toBe(true);
    expect(JSON.parse((await call('world_query', { what: 'relations' })).text)).toHaveProperty('relations');
  });
});
