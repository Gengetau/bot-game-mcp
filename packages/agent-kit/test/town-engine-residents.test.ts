/**
 * 两个运行器居民在真引擎里互相聊天：预算和最小间隔能挡住，不会无限对话下去。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { ResidentRunner, TownClient, type DecisionContext } from '../src/index.js';

const KEY_A = 'bgk_res_key_A_0000000';
const KEY_B = 'bgk_res_key_B_0000000';
const dir = mkdtempSync(join(tmpdir(), 'agentkit-res-'));
let rt: Runtime;
let http: HttpHandle;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const config = configSchema.parse({
    host: '127.0.0.1',
    port: 0,
    stateFile: null,
    seed: 'agent-kit-residents',
    auth: {
      mode: 'keys',
      adminKeys: [],
      agents: [
        { key: KEY_A, id: '2001', name: '甲' },
        { key: KEY_B, id: '2002', name: '乙' },
      ],
    },
    town: { enabled: true, dbFile: join(dir, 'town.db'), params: { moveDurationMs: 40, doorDurationMs: 20, chatPerMinute: 600, chatBurst: 100 } },
  });
  rt = createRuntime(config, () => undefined);
  await rt.world!.start();
  http = await startHttpServer(rt, () => undefined);
}, 20_000);

afterAll(async () => {
  await http.close();
  rt.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('两个居民互相聊天', () => {
  it('预算挡住对话：决策次数不超过预算，聊完后安静，两人都还在镇上', async () => {
    const ca = await TownClient.connect({ url: http.url, key: KEY_A, clientId: 'res-a' });
    const cb = await TownClient.connect({ url: http.url, key: KEY_B, clientId: 'res-b' });
    const runner = new ResidentRunner({ minIntervalMs: 30, debounceMs: 20, debounceMaxMs: 60, waitSeconds: 1, budgetPerHour: 5 });
    const said: Record<string, string[]> = { 甲: [], 乙: [] };
    const mkDecide = (name: string) => async (ctx: DecisionContext) => {
      const heard = ctx.events.filter((e) => e.type === 'chat');
      // 刚进镇的人先打招呼；之后每次听到对方说话都回一句，只靠预算来结束
      if (heard.length === 0 && !ctx.triggers.includes('start')) return null;
      const text = `${name}说第${said[name]!.length + 1}句`;
      said[name]!.push(text);
      return { actions: [{ type: 'speak', text }] };
    };
    const ha = runner.add({ town: ca, profile: { name: '甲' }, decide: mkDecide('甲') });
    const hb = runner.add({ town: cb, profile: { name: '乙' }, decide: mkDecide('乙') });

    // 等到两边都用完预算（或超时）
    const t0 = Date.now();
    while (Date.now() - t0 < 12_000 && (ha.budget().remaining > 0 || hb.budget().remaining > 0)) await sleep(100);
    await sleep(500);

    const before = ha.stats.decisions + hb.stats.decisions;
    expect(ha.stats.decisions).toBeLessThanOrEqual(5);
    expect(hb.stats.decisions).toBeLessThanOrEqual(5);
    expect(ha.stats.decisions + hb.stats.decisions).toBeGreaterThanOrEqual(2);
    expect(ha.stats.actions + hb.stats.actions).toBeGreaterThanOrEqual(2);
    expect(ha.stats.budgetBlocked + hb.stats.budgetBlocked).toBeGreaterThanOrEqual(1);
    expect(ha.status).toBe('running');
    expect(hb.status).toBe('running');

    // 安静期：不再有新决策
    await sleep(800);
    expect(ha.stats.decisions + hb.stats.decisions).toBe(before);

    const s = runner.stats;
    expect(s.decisions).toBe(before);
    await runner.stop();
    expect(ha.status).toBe('stopped');
    await ca.close();
    await cb.close();
  }, 30_000);
});
