/**
 * 审计回归：mcp/town.ts（townView 的 cursor/more、townGameAct 的 game_id、enter_world 的 recap）。
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
import { townGameAct, type TownDeps } from '../../src/mcp/town.js';
import { makeTown } from './helpers.js';

const QING: Identity = { id: '5001', name: '阿青' };
const MO: Identity = { id: '5002', name: '小墨' };
const AGENTS = [
  { key: 'key-qing', id: '5001', name: '阿青' },
  { key: 'key-mo', id: '5002', name: '小墨' },
];

function makeEnv() {
  const t = makeTown();
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('audit-mcp-town') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const town: TownDeps = { world: t.w, auth, trustedIds: [] };
  const deps = { manager, auth, version: 'test', town };
  const connect = async (who: Identity) => {
    const ctx: SessionContext = { identity: who, fixed: true, transport: 'memory' };
    const server = createMcpServer(deps, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await server.connect(b);
    await client.connect(a);
    return { client, ctx };
  };
  return { t, town, connect };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  if (res.isError) throw new Error(`工具 ${name} 失败：${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}

let seq = 0;
const rid = () => `audit-req-${++seq}`;

describe('审计 3：get_my_view 的 cursor 不能越过没读到的事件', () => {
  it('积压 60 条时只返回前 50 条，more=true，cursor 停在第 50 条', async () => {
    const env = makeEnv();
    const { client } = await env.connect(QING);
    const entered = await call(client, 'enter_world', { name: '青青', client_id: 'run-qing-0001' });
    const start = entered.cursor as string;
    const residentId = entered.resident_id as string;
    env.t.w.commit(() => {
      for (let i = 0; i < 60; i++) env.t.w.emitTo([residentId], 'audit_note', { n: i });
    });
    const first = await call(client, 'get_my_view', { cursor: start });
    expect(first.new_events.filter((e: any) => e.type === 'audit_note')).toHaveLength(50);
    expect(first.more).toBe(true);
    const read50 = env.t.w.readResidentEvents(residentId, start, 50);
    expect(first.cursor).toBe(read50.cursor);
    // 沿着返回的 cursor 继续：剩下的 10 条一条不丢，之后 more 消失
    const second = await call(client, 'get_my_view', { cursor: first.cursor });
    const ns = [...first.new_events, ...second.new_events].filter((e: any) => e.type === 'audit_note').map((e: any) => e.n);
    expect(ns).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(second.more).toBeUndefined();
  });
});

describe('审计 8：townGameAct 把 game_id 带进动作', () => {
  it('game_id 与当前局不符 → context_stale；相符则被接受', async () => {
    const env = makeEnv();
    const a = await env.connect(QING);
    const b = await env.connect(MO);
    await call(a.client, 'enter_world', { name: '青青', client_id: 'run-qing-0001' });
    await call(b.client, 'enter_world', { name: '小墨', client_id: 'run-mo-00001' });
    const w = async (c: Client, action: Record<string, unknown>) => {
      const v = await call(c, 'get_my_view');
      return call(c, 'world_act', { request_id: rid(), action_window: v.action_window, context_version: v.context.version, action });
    };
    const p = await w(a.client, { type: 'propose_game', game: 'number_bomb' });
    await w(b.client, { type: 'join_game', activityId: p.activity.id });
    await w(a.client, { type: 'start_game', activityId: p.activity.id });
    const who = [a, b];
    const views = await Promise.all(who.map((x) => call(x.client, 'get_my_view')));
    const idx = views.findIndex((v) => v.game.your_turn);
    const v = views[idx]!;
    const me = idx === 0 ? QING : MO;
    const range = v.game.public.range;
    const input = { action: 'guess', number: Math.floor((range.from + range.to) / 2) };
    const base = { request_id: rid(), action_window: v.action_window, context_version: v.context.version, phase_id: v.game.phase_id };
    let err: any;
    try {
      townGameAct(env.town, who[idx]!.ctx, me, { ...base, game_id: 'TG-上一局' }, input);
    } catch (e) {
      err = e;
    }
    expect(String(err?.message ?? err)).toMatch(/context_stale|CONTEXT_STALE|不是你现在所在的那一局/);
    // activity_id 显式给了不符的值 → 不能被回填成当前值而放行
    let err2: any;
    try {
      townGameAct(env.town, who[idx]!.ctx, me, { ...base, request_id: rid(), game_id: v.game.game_id, activity_id: 'A-上一场' }, input);
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeTruthy();
    const ok = townGameAct(env.town, who[idx]!.ctx, me, { ...base, request_id: rid(), game_id: v.game.game_id }, input) as any;
    expect(ok.ok ?? ok.status ?? true).toBeTruthy();
  });
});

describe('审计 15：enter_world 默认接管时 recap 不丢', () => {
  it('离开超过 10 分钟再回来，返回里带 recap；created 仍以第一次为准', async () => {
    const env = makeEnv();
    const { client } = await env.connect(QING);
    const first = await call(client, 'enter_world', { name: '青青', client_id: 'run-qing-0001' });
    expect(first.created).toBe(true);
    await call(client, 'leave_world');
    env.t.clock.advance(20 * 60_000);
    env.t.w.tick();
    const back = await call(client, 'enter_world', { client_id: 'run-qing-0001' });
    expect(back.created).toBe(false);
    expect(back.recap).toBeDefined();
  });
});
