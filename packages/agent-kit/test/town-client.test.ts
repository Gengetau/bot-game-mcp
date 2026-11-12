/**
 * TownClient：对着真引擎（开了小镇）走通进入 / 移动 / 说话 / 买东西 / 一局小游戏，验证请求号幂等和各类错误。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import {
  BotGameClient,
  ContextStaleError,
  ControlLostError,
  PhaseStaleError,
  PreconditionFailedError,
  RateLimitedError,
  RequestConflictError,
  RequestExpiredError,
  TownClient,
  TownDisabledError,
  UnauthenticatedError,
  type TownEvent,
  type TownView,
} from '../src/index.js';

const KEY_A = 'bgk_town_key_A_000000';
const KEY_B = 'bgk_town_key_B_000000';
const dir = mkdtempSync(join(tmpdir(), 'agentkit-town-'));
let rt: Runtime;
let http: HttpHandle;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const config = configSchema.parse({
    host: '127.0.0.1',
    port: 0,
    stateFile: null,
    seed: 'agent-kit-town',
    auth: {
      mode: 'keys',
      adminKeys: [],
      agents: [
        { key: KEY_A, id: '1001', name: '甲' },
        { key: KEY_B, id: '1002', name: '乙' },
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

/** 不断 wait，直到出现满足条件的事件。 */
async function waitFor(c: TownClient, pred: (e: TownEvent) => boolean, tries = 20): Promise<TownEvent> {
  for (let i = 0; i < tries; i++) {
    const r = await c.wait({ waitSeconds: 1 });
    const hit = r.events.find(pred);
    if (hit) return hit;
  }
  throw new Error('等不到想要的事件');
}

describe('TownClient：真引擎', () => {
  let a: TownClient;
  let b: TownClient;

  beforeAll(async () => {
    a = await TownClient.connect({ url: http.url, key: KEY_A, clientId: 'kit-a-client' });
    b = await TownClient.connect({ url: http.url, key: KEY_B, clientId: 'kit-b-client' });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('进入、读视图、说话、买东西、移动，再玩一局小游戏', async () => {
    const ea = await a.enter({ name: '甲居' });
    expect(ea.resident_id).toMatch(/^r_/);
    expect(a.state.residentId).toBe(ea.resident_id);
    expect(a.state.cursor).toBe(ea.cursor);
    expect(ea.control.mine).toBe(true);
    const eb = await b.enter({ name: '乙居' });
    expect(eb.resident_id).not.toBe(ea.resident_id);

    // 说话：b 在同一处，收到 chat 事件
    const say = await a.speak('大家好，我是甲居');
    expect(say.status).toBe('completed');
    expect(say.requestId).toMatch(/^rq-/);
    const heard = await waitFor(b, (e) => e.type === 'chat');
    expect(heard.text).toBe('大家好，我是甲居');
    expect((heard.from as { name: string }).name).toBe('甲居');

    // 买东西：广场小摊的小饼干
    const before = (await a.view()).coins;
    const bought = await a.buy('stall', 'cookie', 1);
    expect(bought.ok).toBe(true);
    const v2 = await a.view();
    expect(v2.coins).toBeLessThan(before);
    expect(v2.items.some((i) => i.type === 'cookie')).toBe(true);

    // 移动：accepted，到了以后有 you_arrived 事件
    const mv = await a.move('tea_house');
    expect(mv.status).toBe('accepted');
    const arrived = await waitFor(a, (e) => e.type === 'you_arrived');
    expect(arrived.space).toBe('tea_house');
    expect((await a.view()).location.space).toBe('tea_house');
    await a.move('plaza');
    await waitFor(a, (e) => e.type === 'you_arrived');
    await b.view();

    // 查询、心跳
    expect((await a.query('public')).places.length).toBeGreaterThan(3);
    expect((await a.query('residents')).residents.length).toBeGreaterThanOrEqual(2);
    const hb = await a.heartbeat();
    expect(hb.control.mine).toBe(true);

    // 一局小游戏：凑桌 → 加入 → 开局 → 轮流出牌 → 结束
    const prop = await a.proposeGame('number_bomb');
    expect(prop.ok).toBe(true);
    const va = await a.view();
    const act = va.here!.activities.find((x) => x.name.includes('数字炸弹'))!;
    expect(act).toBeDefined();
    await b.view();
    await b.joinGame(act.id);
    const coinsBefore = [(await a.view()).coins, (await b.view()).coins];
    const started = await a.startGame(act.id);
    expect(started.ok).toBe(true);
    // 进入小游戏后上下文版本变了：旧版本的动作被拒绝，不会落到游戏里
    const stale = await a.act({ type: 'speak', text: '旧上下文' }, { contextVersion: va.context.version }).catch((e) => e);
    expect(stale).toBeInstanceOf(ContextStaleError);

    let ended = false;
    const clients = [a, b];
    for (let i = 0; i < 80 && !ended; i++) {
      for (const c of clients) {
        const v: TownView = await c.view();
        if (!v.game) {
          ended = true;
          break;
        }
        if (!v.game.your_turn || !v.game.todo) continue;
        const m = /"number":\s*(\d+)/.exec(v.game.todo.actions[0]?.example ?? '');
        if (!m) throw new Error(`todo 里没有猜数示例：${JSON.stringify(v.game.todo)}`);
        // 阶段编号不对：局内动作被拒绝（PhaseStale），之后用对的
        if (i === 0) {
          const bad = await c.gameAct({ action: 'guess', number: Number(m[1]) }, { phaseId: 9999 }).catch((e) => e);
          expect(bad).toBeInstanceOf(PhaseStaleError);
          expect((bad as PhaseStaleError).code).toBe('phase_stale');
        }
        await c.gameAct({ action: 'guess', number: Number(m[1]) });
      }
    }
    expect(ended).toBe(true);
    // 回到世界了，上下文版本又变了；结算奖励到账
    const after = [await a.view(), await b.view()];
    expect(after[0]!.context.activityId).toBeNull();
    expect(after[0]!.coins + after[1]!.coins).toBeGreaterThan(coinsBefore[0]! + coinsBefore[1]!);
    // 重新能正常说话（客户端记着的上下文版本已经跟着视图更新）
    expect((await a.speak('这局真刺激')).status).toBe('completed');
  }, 60_000);

  it('同一个 request_id 重试只做一次；换了内容是 request_conflict', async () => {
    await a.view();
    const coins0 = (await a.view()).coins;
    const requestId = 'idem-req-0000000001';
    const first = await a.buy('stall', 'cookie', 1, { requestId });
    expect(first.replayed).toBeUndefined();
    const second = await a.buy('stall', 'cookie', 1, { requestId });
    expect(second.replayed).toBe(true);
    expect(second.requestId).toBe(requestId);
    expect((await a.view()).coins).toBe(coins0 - 3); // 只扣了一次（小饼干 3 枚）
    const clash = await a.buy('stall', 'lantern', 1, { requestId }).catch((e) => e);
    expect(clash).toBeInstanceOf(RequestConflictError);
    expect((clash as RequestConflictError).requestId).toBe(requestId);
    expect((await a.view()).coins).toBe(coins0 - 3);
  });

  it('错误类型：context_stale、request_expired、precondition_failed（带 reason）', async () => {
    const v = await a.view();
    const stale = await a.speak('x', { contextVersion: v.context.version + 50 }).catch((e) => e);
    expect(stale).toBeInstanceOf(ContextStaleError);
    expect(stale.code).toBe('context_stale');
    expect(stale.isStale).toBe(true);
    expect(stale.contextVersion).toBe(v.context.version);
    expect(stale.requestId).toMatch(/^rq-/);

    const expired = await a.speak('x', { actionWindow: 'aw.bad.bad' }).catch((e) => e);
    expect(expired).toBeInstanceOf(RequestExpiredError);

    const broke = await a.buy('stall', 'lantern', 10).catch((e) => e);
    expect(broke).toBeInstanceOf(PreconditionFailedError);
    expect(['sold_out', 'insufficient_coins']).toContain(broke.reason); // 库存不够或硬币不够，reason 是机器可读的细分原因
    expect(broke.message.length).toBeGreaterThan(0);
    expect(broke.isStale).toBe(true);
  });

  it('另一个客户端接管后，旧客户端的动作是 control_lost；claim 之后接回来', async () => {
    const a2 = await TownClient.connect({ url: http.url, key: KEY_A, clientId: 'kit-a-second' });
    try {
      await a.view();
      await a2.enter();
      const lost = await a.speak('我还在吗').catch((e) => e);
      expect(lost).toBeInstanceOf(ControlLostError);
      expect(lost.code).toBe('control_lost');
      expect(lost.isStale).toBe(false);
      const ok = await a2.speak('现在由我控制');
      expect(ok.status).toBe('completed');
      await a.claim();
      expect((await a.speak('我拿回来了')).status).toBe('completed');
      expect(await a2.speak('我又说话了').catch((e) => e)).toBeInstanceOf(ControlLostError);
    } finally {
      await a2.close();
    }
  });

  it('没进小镇的会话：unauthenticated', async () => {
    const c = await TownClient.connect({ url: http.url, key: KEY_B, clientId: 'kit-b-fresh' });
    try {
      const e = await c.act({ type: 'speak', text: 'x' }, { actionWindow: 'aw.whatever.zzzzzzzzzz', contextVersion: 1 }).catch((x) => x);
      expect(e).toBeInstanceOf(UnauthenticatedError);
    } finally {
      await c.close();
    }
  });

  it('leave 之后不在场；再 enter 回来', async () => {
    const left = await b.leave();
    expect(left.ok).toBe(true);
    const back = await b.enter();
    expect(back.created).toBe(false);
    expect(back.control.mine).toBe(true);
  });
});

describe('TownClient：限流与没开小镇', () => {
  it('rate_limited：带 retryAfterMs；自动重试用同一个 request_id（等太久就直接抛）', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'agentkit-town-rl-'));
    const config = configSchema.parse({
      host: '127.0.0.1',
      port: 0,
      stateFile: null,
      seed: 'rl',
      auth: { mode: 'keys', adminKeys: [], agents: [{ key: KEY_A, id: '1001', name: '甲' }] },
      town: { enabled: true, dbFile: join(d2, 'town.db') },
    });
    const rt2 = createRuntime(config, () => undefined);
    await rt2.world!.start();
    const h2 = await startHttpServer(rt2, () => undefined);
    const base = await BotGameClient.connect({ url: h2.url, key: KEY_A });
    const c = new TownClient(base, { clientId: 'rl-client', maxRetries: 0 });
    try {
      await c.enter({ name: '话痨' });
      let err: unknown = null;
      for (let i = 0; i < 12 && !err; i++) err = await c.speak(`第${i}句`).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(RateLimitedError);
      const rl = err as RateLimitedError;
      expect(rl.code).toBe('rate_limited');
      expect(rl.retryAfterMs).toBeGreaterThan(0);
      expect(rl.requestId).toMatch(/^rq-/);
      // 愿意多等一点就会用同一个请求号自动重试直到成功
      const patient = new TownClient(base, { clientId: 'rl-client', maxRetries: 3, rateLimitMaxWaitMs: 60_000, sleep: async () => sleep(rl.retryAfterMs! + 50) });
      await patient.view();
      const done = await patient.speak('终于轮到我了', { requestId: rl.requestId! });
      expect(done.status).toBe('completed');
    } finally {
      await base.close();
      await h2.close();
      rt2.close();
      rmSync(d2, { recursive: true, force: true });
    }
  }, 40_000);

  it('引擎没开小镇：TownDisabledError', async () => {
    const config = configSchema.parse({ host: '127.0.0.1', port: 0, stateFile: null, seed: 'nt', auth: { mode: 'keys', adminKeys: [], agents: [{ key: KEY_A, id: '1001', name: '甲' }] } });
    const rt3 = createRuntime(config, () => undefined);
    const h3 = await startHttpServer(rt3, () => undefined);
    const c = await TownClient.connect({ url: h3.url, key: KEY_A });
    try {
      const e = await c.enter({ name: '甲' }).catch((x) => x);
      expect(e).toBeInstanceOf(TownDisabledError);
      expect(e.code).toBe('town_disabled');
    } finally {
      await c.close();
      await h3.close();
      rt3.close();
    }
  });
});
