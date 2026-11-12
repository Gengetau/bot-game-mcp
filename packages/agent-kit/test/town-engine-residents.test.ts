/**
 * 运行器居民在真引擎里：
 *  - 两个居民互相聊天：预算和最小间隔能挡住，不会无限对话下去；
 *  - navigate 到茶馆：运行器自动续导航租约，直到 you_arrived；
 *  - 运行器续不上（模拟断线）：10 秒后停在半路，收到 nav_stopped（lease）；
 *  - 走到物件旁边再发起共同活动。
 * 走路用的是真实时间（广场 → 茶馆约 13 秒），所以这几条各自要十几秒。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { BotGameClient, ResidentRunner, TownClient, TownNetworkError, type Decision, type DecisionContext, type TownEvent } from '../src/index.js';

const KEY_A = 'bgk_res_key_A_0000000';
const KEY_B = 'bgk_res_key_B_0000000';
const KEY_C = 'bgk_res_key_C_0000000';
const KEY_D = 'bgk_res_key_D_0000000';
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
        { key: KEY_C, id: '2003', name: '丙' },
        { key: KEY_D, id: '2004', name: '丁' },
      ],
    },
    town: { enabled: true, dbFile: join(dir, 'town.db'), params: { chatPerMinute: 600, chatBurst: 100 } },
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

/** 数一数续了几次租约。 */
class CountingClient extends TownClient {
  renewals = 0;
  override renewNavigation(...args: Parameters<TownClient['renewNavigation']>) {
    this.renewals++;
    return super.renewNavigation(...args);
  }
}

/** 续不上租约的客户端（模拟断线 / 运行器卡死）：其余一切正常。 */
class DeafClient extends TownClient {
  attempts = 0;
  override renewNavigation(..._args: Parameters<TownClient['renewNavigation']>): ReturnType<TownClient['renewNavigation']> {
    this.attempts++;
    return Promise.reject(new TownNetworkError('network', '模拟断线', { tool: 'heartbeat' }));
  }
}

const FAST = { minIntervalMs: 20, debounceMs: 10, debounceMaxMs: 30, waitSeconds: 2, budgetPerHour: 50, decideOnStart: true } as const;

async function until(cond: () => boolean, ms: number, step = 100): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

describe('走路：运行器自动续导航租约', () => {
  it('AI 居民 navigate 到茶馆：整个过程里运行器自动续租，直到 you_arrived；再走到茶桌旁边发起共同活动', async () => {
    const cc = new CountingClient(await BotGameClient.connect({ url: http.url, key: KEY_C }), { clientId: 'res-c' });
    const runner = new ResidentRunner(FAST);
    const seen: TownEvent[] = [];
    let modelCalls = 0;
    let started: unknown = null;
    const decide = async (ctx: DecisionContext): Promise<Decision | null> => {
      modelCalls++;
      seen.push(...ctx.events);
      const v = ctx.view;
      if (v.location.space !== 'tea_house') return v.location.walking ? null : { actions: [{ type: 'navigate', to: 'tea_house' }] };
      const table = v.here?.objects?.find((o) => o.id === 'tea_house:table1');
      if (!table) return null;
      if (table.far) return v.location.walking ? null : { actions: [{ type: 'navigate', to: 'tea_house:table1' }] };
      if (!v.doing) {
        started = 'asked';
        return { actions: [{ type: 'start_interaction', objectId: 'tea_house:table1' }] };
      }
      return null;
    };
    const h = runner.add({ town: cc, profile: { name: '丙' }, decide, ...FAST });
    // 第一程：广场 → 茶馆（约 13 秒）
    expect(await until(() => seen.some((e) => e.type === 'you_arrived' && e.space === 'tea_house'), 25_000)).toBe(true);
    expect(cc.renewals).toBeGreaterThanOrEqual(3); // 约每 3 秒一次，不经过模型
    expect(seen.some((e) => e.type === 'nav_stopped')).toBe(false);
    // 够不着的茶桌：直接发起会得到 too_far，并告诉你该走到哪
    const far = await cc.act({ type: 'start_interaction', objectId: 'tea_house:table2' }).catch((e) => e);
    expect(far.reason).toBe('too_far');
    expect(far.data.navigateTo).toBe('tea_house:table2');
    // 第二程：走到 table1 旁边，再发起（模型只下了 navigate 和 start_interaction 两条动作）
    expect(await until(() => started !== null, 20_000)).toBe(true);
    expect(await until(() => h.stats.actions >= 3, 10_000)).toBe(true);
    const v = await cc.view();
    expect(v.doing).not.toBeNull();
    expect(v.location.walking).toBeUndefined();
    expect(modelCalls).toBeLessThanOrEqual(10); // 续租几十次，模型只在有新情况时才被叫
    expect(h.status).toBe('running');
    await runner.stop({ leave: true });
    await cc.close();
  }, 70_000);

  it('运行器续不上（模拟断线）：租约 10 秒后到期，停在半路并收到 nav_stopped（lease）', async () => {
    const cd = new DeafClient(await BotGameClient.connect({ url: http.url, key: KEY_D }), { clientId: 'res-d' });
    const runner = new ResidentRunner(FAST);
    const seen: TownEvent[] = [];
    let last: Awaited<ReturnType<TownClient['view']>> | null = null;
    const decide = async (ctx: DecisionContext): Promise<Decision | null> => {
      seen.push(...ctx.events);
      last = ctx.view;
      return ctx.view.location.space === 'plaza' && !ctx.view.location.walking && !seen.some((e) => e.type === 'nav_stopped') ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : null;
    };
    const h = runner.add({ town: cd, profile: { name: '丁' }, decide, ...FAST });
    const t0 = Date.now();
    expect(await until(() => seen.some((e) => e.type === 'nav_stopped'), 20_000)).toBe(true);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(9_000); // 租约 10 秒
    expect(took).toBeLessThan(16_000); // 没有走完全程（约 13 秒）
    const stopped = seen.find((e) => e.type === 'nav_stopped')!;
    expect(stopped.reason).toBe('lease');
    expect(cd.attempts).toBeGreaterThanOrEqual(2); // 运行器试过，但每次都失败，也没有崩
    expect(h.status).toBe('running');
    await sleep(300);
    const v = await cd.view();
    expect(v.location.space).not.toBe('tea_house');
    expect(v.location.walking).toBeUndefined();
    void last;
    await runner.stop({ leave: true });
    await cd.close();
  }, 40_000);
});
