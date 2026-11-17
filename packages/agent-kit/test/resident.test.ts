/**
 * ResidentRunner：假时钟 + 假端口，逐条验证去抖、最小间隔、预算、并发、作废、小游戏、接管、重连等行为。
 */
import { describe, expect, it } from 'vitest';
import {
  ContextStaleError,
  PhaseStaleError,
  ControlLostError,
  InMemoryJournal,
  PreconditionFailedError,
  ResidentRunner,
  TownNetworkError,
  defaultClassify,
  type Decision,
  type DecisionContext,
  type JournalState,
  type MemorySaveEntry,
  type ResidentSpec,
} from '../src/index.js';
import { FakeClock, FakePort, chat, ev, flush } from './fakes.js';

const T0 = 0;
interface Rig {
  clock: FakeClock;
  port: FakePort;
  runner: ResidentRunner;
  calls: { ctx: DecisionContext; at: number }[];
  handle: ReturnType<ResidentRunner['add']>;
  rel: (at: number) => number;
}

/** 起一个居民；decide 默认记录调用并返回 null。 */
async function rig(spec: Partial<ResidentSpec> = {}, runnerOpts: { maxConcurrentDecisions?: number } = {}, decide?: (ctx: DecisionContext) => Promise<Decision | null> | Decision | null): Promise<Rig> {
  const clock = new FakeClock();
  const port = new FakePort(clock);
  const start = clock.now();
  const calls: Rig['calls'] = [];
  const runner = new ResidentRunner({ clock, ...runnerOpts });
  const handle = runner.add({
    town: port,
    profile: { name: '小测' },
    decideOnStart: false,
    decide: async (ctx) => {
      calls.push({ ctx, at: clock.now() });
      return decide ? decide(ctx) : null;
    },
    ...spec,
  });
  await clock.advance(0);
  return { clock, port, runner, calls, handle, rel: (at) => at - start };
}

const speak = (text = '嗨'): Decision => ({ actions: [{ type: 'speak', text }] });

describe('defaultClassify', () => {
  const c = { residentId: 'r_me', mode: 'world' as const };
  it('按重要性归类', () => {
    expect(defaultClassify(ev('chat', { from: { id: 'r_x' } }), c)).toBe('normal');
    expect(defaultClassify(ev('chat', { from: { id: 'r_me' } }), c)).toBe('ignore');
    expect(defaultClassify(ev('presence'), c)).toBe('ignore');
    expect(defaultClassify(ev('control'), c)).toBe('ignore');
    expect(defaultClassify(ev('mystery'), c)).toBe('ignore');
    expect(defaultClassify(ev('game', { yourTurn: true }), c)).toBe('urgent');
    expect(defaultClassify(ev('game', { yourTurn: false }), c)).toBe('ignore');
    expect(defaultClassify(ev('offer', { offer: { from: { id: 'r_x' }, to: { id: 'r_me' } } }), c)).toBe('urgent');
    expect(defaultClassify(ev('offer', { offer: { from: { id: 'r_me' }, to: { id: 'r_x' } } }), c)).toBe('normal');
    expect(defaultClassify(ev('invite'), c)).toBe('urgent');
    expect(defaultClassify(ev('arrived'), c)).toBe('normal');
    // 小游戏里：只有轮到我才算
    const g = { residentId: 'r_me', mode: 'game' as const };
    expect(defaultClassify(ev('chat', { from: { id: 'r_x' } }), g)).toBe('ignore');
    expect(defaultClassify(ev('arrived'), g)).toBe('ignore');
    expect(defaultClassify(ev('game', { yourTurn: true }), g)).toBe('urgent');
    expect(defaultClassify(ev('game_ended'), g)).toBe('normal');
  });
});

describe('ResidentRunner：触发、去抖、间隔', () => {
  it('没有值得反应的事件就不调用决策函数', async () => {
    const r = await rig();
    r.port.push(ev('presence'), ev('control_unknown'), chat('r_me', '我自己说的'));
    await r.clock.advance(60_000);
    expect(r.calls).toHaveLength(0);
    expect(r.handle.status).toBe('running');
    // 一直在长轮询（续在场）
    expect(r.port.waits.length).toBeGreaterThan(1);
    expect(r.port.waits.every((w) => (w.seconds ?? 0) <= 25)).toBe(true);
  });

  it('普通事件：安静 3 秒才决策，新事件顺延窗口', async () => {
    const r = await rig();
    r.port.push(chat());
    await r.clock.advance(2900);
    expect(r.calls).toHaveLength(0);
    r.port.push(chat('r_other', '还有一句'));
    await r.clock.advance(2900);
    expect(r.calls).toHaveLength(0);
    await r.clock.advance(200);
    expect(r.calls).toHaveLength(1);
    expect(r.rel(r.calls[0]!.at)).toBe(5900); // 第二句在 2.9 秒到，窗口顺延到 2.9 + 3 秒
    expect(r.calls[0]!.ctx.triggers).toEqual(['chat']);
    expect(r.calls[0]!.ctx.events).toHaveLength(2);
    expect(r.calls[0]!.ctx.mode).toBe('world');
  });

  it('普通事件最长等 10 秒：一直有人说话也不无限推迟', async () => {
    const r = await rig();
    for (let i = 0; i < 9; i++) {
      r.port.push(chat('r_other', `第${i}句`));
      await r.clock.advance(2000);
    }
    expect(r.calls).toHaveLength(1);
    expect(r.rel(r.calls[0]!.at)).toBe(10_000);
  });

  it('紧急事件（小游戏回合 / 发给我的报价）不去抖，但受最小间隔约束', async () => {
    const r = await rig();
    const offer = (id: string) => ev('offer', { offer: { id, from: { id: 'r_x' }, to: { id: 'r_me' } } });
    r.port.push(offer('o1'));
    await r.clock.advance(100);
    expect(r.calls).toHaveLength(1);
    expect(r.rel(r.calls[0]!.at)).toBeLessThan(200);
    // 3 秒后又来一个：要等到距上次决策开始满 8 秒
    await r.clock.advance(2900);
    r.port.push(offer('o2'));
    await r.clock.advance(4000);
    expect(r.calls).toHaveLength(1);
    await r.clock.advance(1500);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]!.at - r.calls[0]!.at).toBeGreaterThanOrEqual(8000);
    expect(r.calls[1]!.at - r.calls[0]!.at).toBeLessThan(9000);
  });

  it('刚进镇做一次决策（reason = start）', async () => {
    const r = await rig({ decideOnStart: true });
    await r.clock.advance(100);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.ctx.triggers).toEqual(['start']);
  });

  it('事件重放（同一个事件再来一次）按指纹去重', async () => {
    const r = await rig();
    const e = chat('r_other', '重复的');
    r.port.push(e);
    await r.clock.advance(100);
    r.port.push({ ...e });
    await r.clock.advance(4000);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.ctx.events).toHaveLength(1);
    expect(r.handle.stats.events).toBe(1);
  });
});

describe('ResidentRunner：每小时预算', () => {
  it('预算用完只保持在场、不决策；滑动窗口过了才恢复', async () => {
    const r = await rig({ budgetPerHour: 3, minIntervalMs: 1000, debounceMs: 0, debounceMaxMs: 0 });
    const poke = async () => {
      r.port.push(ev('invite', { invite: { id: Math.random() } }));
      await r.clock.advance(2000);
    };
    await poke(); // t=0
    await poke(); // t=2
    await poke(); // t=4
    expect(r.calls).toHaveLength(3);
    expect(r.handle.budget().remaining).toBe(0);
    await poke();
    await poke();
    expect(r.calls).toHaveLength(3);
    expect(r.handle.stats.budgetBlocked).toBe(2);
    expect(r.handle.status).toBe('running');
    const wc = r.port.waits.length;
    await r.clock.advance(30_000);
    expect(r.port.waits.length).toBeGreaterThan(wc); // 仍在长轮询
    expect(r.port.acts).toHaveLength(0);
    // 第一次调用满一小时后释放一个额度（不是整点重置、不是三个全放）
    await r.clock.advance(3_600_500 - 10_000 - 30_000);
    r.port.push(ev('invite', { invite: { id: 'late-1' } }));
    await r.clock.advance(300);
    expect(r.calls).toHaveLength(4);
    r.port.push(ev('invite', { invite: { id: 'late-2' } }));
    await r.clock.advance(1500);
    expect(r.calls).toHaveLength(4); // 剩下两次（t=2s、4s）还在窗口里
    expect(r.handle.budget().limit).toBe(3);
  });

  it('预算跨重启保留（记在 journal 里）', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryJournal();
    journal.save({ cursor: null, seen: [], calls: Array.from({ length: 30 }, (_, i) => clock.now() - 60_000 + i), claims: [], pending: null });
    const calls: number[] = [];
    const runner = new ResidentRunner({ clock });
    const port = new FakePort(clock);
    const h = runner.add({ town: port, profile: { name: '小测' }, journal, decide: () => (calls.push(1), null) });
    await clock.advance(100);
    expect(calls).toHaveLength(0);
    expect(h.stats.budgetBlocked).toBe(1);
    expect(h.budget().remaining).toBe(0);
    await runner.stop();
  });
});

describe('ResidentRunner：全局并发上限', () => {
  it('多个居民共用一个运行器时，同时调用决策函数不超过 4 个', async () => {
    const clock = new FakeClock();
    const runner = new ResidentRunner({ clock });
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const finished: string[] = [];
    const ports: FakePort[] = [];
    for (let i = 0; i < 7; i++) {
      const port = new FakePort(clock, `r_${i}`, `居民${i}`);
      ports.push(port);
      runner.add({
        town: port,
        profile: { name: `居民${i}` },
        decide: async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise<void>((res) => gates.push(res));
          running--;
          finished.push(`r_${i}`);
          return null;
        },
      });
    }
    await clock.advance(100);
    expect(running).toBe(4);
    expect(runner.decisionsInFlight).toBe(4);
    gates.splice(0, 1)[0]!();
    await clock.advance(10);
    expect(running).toBe(4); // 空出一个，排队的补上
    for (let i = 0; i < 20 && finished.length < 7; i++) {
      for (const g of gates.splice(0)) g();
      await clock.advance(10);
    }
    expect(finished).toHaveLength(7);
    expect(peak).toBe(4);
    expect(runner.stats.decisions).toBe(7);
    await runner.stop();
  });

  it('可配并发上限；小游戏回合在排队时优先', async () => {
    const clock = new FakeClock();
    const runner = new ResidentRunner({ clock, maxConcurrentDecisions: 1 });
    const order: string[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const mk = (id: string, game: boolean) => {
      const port = new FakePort(clock, id, id);
      if (game) {
        port.activityId = 'act1';
        port.game = { game_id: 'g', name: '数字炸弹', status: 'running', phase_id: 1, your_turn: true, todo: { prompt: '猜', kind: 'guess', actions: [{ action: 'guess', example: 'act({"action":"guess","number":3})' }], seconds_left: 40 }, public: {}, events: [] };
      }
      return port;
    };
    const first = mk('first', false);
    runner.add({
      town: first,
      profile: { name: 'first' },
      decide: async () => {
        order.push('first');
        await new Promise<void>((res) => (gate.release = res));
        return null;
      },
    });
    await clock.advance(10);
    const normal = mk('normal', false);
    runner.add({ town: normal, profile: { name: 'normal' }, decide: () => (order.push('normal'), null) });
    await clock.advance(10);
    const gamer = mk('gamer', true);
    runner.add({ town: gamer, profile: { name: 'gamer' }, decideOnStart: false, decide: () => (order.push('gamer'), null) });
    gamer.push(ev('game', { yourTurn: true }));
    await clock.advance(10);
    expect(order).toEqual(['first']);
    gate.release!();
    await clock.advance(100);
    expect(order).toEqual(['first', 'gamer', 'normal']);
    await runner.stop();
  });
});

describe('ResidentRunner：决策失败与超时', () => {
  it('决策函数抛错：记一次失败、退避后再试，在场不受影响', async () => {
    let n = 0;
    const r = await rig({ minIntervalMs: 1000, failureBackoffBaseMs: 5000 }, {}, () => {
      n++;
      if (n === 1) throw new Error('模型 529');
      return speak();
    });
    const poke = () => r.port.push(ev('invite', { invite: { id: Math.random() } }));
    poke();
    await r.clock.advance(100);
    expect(r.handle.stats.failures).toBe(1);
    expect(r.handle.status).toBe('running');
    poke();
    await r.clock.advance(3000);
    expect(r.calls).toHaveLength(1); // 退避中
    await r.clock.advance(2500);
    expect(r.calls).toHaveLength(2); // 退避到了就再试
    expect(r.port.acts).toHaveLength(1);
    // 失败期间一直在长轮询
    expect(r.port.waits.length).toBeGreaterThan(3);
    expect(r.port.leaves).toBe(0);
  });

  it('决策函数超时：取消 signal、记超时，迟到的结果不执行', async () => {
    let signal: AbortSignal | null = null;
    let finish: ((d: Decision) => void) | null = null;
    const r = await rig({ decideTimeoutMs: 2000 }, {}, (ctx) => {
      signal = ctx.signal;
      return new Promise<Decision>((res) => (finish = res));
    });
    r.port.push(ev('invite'));
    await r.clock.advance(1500);
    expect(signal!.aborted).toBe(false);
    await r.clock.advance(1000);
    expect(signal!.aborted).toBe(true);
    expect(r.handle.stats.timeouts).toBe(1);
    expect(r.handle.stats.failures).toBe(1);
    finish!(speak('太晚了'));
    await r.clock.advance(100);
    expect(r.port.acts).toHaveLength(0);
    expect(r.handle.status).toBe('running');
  });

  it('叙述记忆钩子：决策前 load、决策后 save；钩子出错不影响决策', async () => {
    const saved: MemorySaveEntry[] = [];
    const r = await rig(
      {
        memory: {
          load: async (info) => ({ 见过: info.events.length }),
          save: async (e) => {
            saved.push(e);
            throw new Error('磁盘满了');
          },
        },
      },
      {},
      (ctx) => (ctx.memory ? speak(`记忆 ${JSON.stringify(ctx.memory)}`) : null),
    );
    r.port.push(chat());
    await r.clock.advance(4000);
    expect(r.calls[0]!.ctx.memory).toEqual({ 见过: 1 });
    expect(r.port.acts).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.outcome).toBe('executed');
    expect(saved[0]!.decision?.actions[0]!.type).toBe('speak');
    expect(saved[0]!.results).toHaveLength(1);
    expect(r.handle.status).toBe('running');
  });
});

describe('ResidentRunner：动作执行、去重、作废', () => {
  it('每步动作的 request_id 由 decisionId 稳定派生，并带决策时视图的窗口和版本', async () => {
    const r = await rig({}, {}, () => ({ actions: [{ type: 'speak', text: 'a' }, { type: 'speak', text: 'b' }] }));
    r.port.push(ev('invite'));
    await r.clock.advance(100);
    expect(r.port.acts).toHaveLength(2);
    const id = r.calls[0]!.ctx.decisionId;
    expect(r.port.acts.map((a) => a.opts.requestId)).toEqual([`${id}-0`, `${id}-1`]);
    expect(r.port.acts[0]!.opts.contextVersion).toBe(1);
    expect(r.port.acts[0]!.opts.actionWindow).toBe('aw.1');
    expect(id.length).toBeLessThan(40);
    expect(r.handle.stats.actions).toBe(2);
  });

  it('网络失败：同一个 request_id 重试，只算一次', async () => {
    let fails = 2;
    const r = await rig({ actRetryBaseMs: 100 }, {}, () => speak());
    r.port.actBehavior = () => {
      if (fails-- > 0) throw new TownNetworkError('network', '断线', { tool: 'world_act' });
      return undefined;
    };
    r.port.push(ev('invite'));
    await r.clock.advance(2000);
    expect(r.port.acts).toHaveLength(3);
    expect(new Set(r.port.acts.map((a) => a.opts.requestId)).size).toBe(1);
    expect(r.handle.stats.actions).toBe(1);
    expect(r.handle.stats.discarded).toBe(0);
  });

  it('决策期间世界变了（context_stale / precondition_failed）：丢弃，不重试，不继续后面的步骤', async () => {
    for (const make of [() => new ContextStaleError('context_stale', '变了', { tool: 'world_act', data: { contextVersion: 2 } }), () => new PreconditionFailedError('precondition_failed', '硬币不够', { tool: 'world_act', reason: 'insufficient_coins' })]) {
      const r = await rig({}, {}, () => ({ actions: [{ type: 'buy', shop: 'stall', sku: 'cookie' }, { type: 'speak', text: '买到啦' }] }));
      r.port.actBehavior = () => {
        throw make();
      };
      r.port.push(ev('invite'));
      await r.clock.advance(2000);
      expect(r.port.acts).toHaveLength(1);
      expect(r.handle.stats.discarded).toBe(1);
      expect(r.handle.stats.actions).toBe(0);
      expect(r.handle.status).toBe('running');
      await r.runner.stop();
    }
  });

  it('多步决策：两步之间上下文变了就作废剩下的', async () => {
    const r = await rig({}, {}, () => ({ actions: [{ type: 'move', to: 'arcade' }, { type: 'speak', text: '到啦' }] }));
    r.port.actBehavior = (a) => {
      if (a.action.type === 'move') r.port.version = 2; // 第一步之后进了小游戏 / 上下文变了
      return undefined;
    };
    r.port.push(ev('invite'));
    await r.clock.advance(2000);
    expect(r.port.acts).toHaveLength(1);
    expect(r.handle.stats.discarded).toBe(1);
  });

  it('崩溃重启：journal 里没做完的决策用原来的 request_id 续做', async () => {
    const clock = new FakeClock();
    const journal = new InMemoryJournal();
    const state: JournalState = {
      cursor: 'c1',
      seen: [],
      calls: [],
      claims: [],
      pending: { decisionId: 'dcrash1', actions: [{ type: 'speak', text: '第一句' }, { type: 'speak', text: '第二句' }], done: 1, contextVersion: 1, createdAt: clock.now() },
    };
    journal.save(state);
    const port = new FakePort(clock);
    const runner = new ResidentRunner({ clock });
    runner.add({ town: port, profile: { name: '小测' }, journal, decideOnStart: false, decide: () => null });
    await clock.advance(500);
    expect(port.acts.map((a) => a.opts.requestId)).toEqual(['dcrash1-1']);
    expect(journal.state?.pending).toBeNull();
    await runner.stop();
  });
});

describe('ResidentRunner：小游戏', () => {
  const game = (over: Record<string, unknown> = {}) =>
    ({
      game_id: 'g1',
      name: '数字炸弹',
      status: 'running',
      phase_id: 7,
      your_turn: true,
      todo: { prompt: '猜一个数', kind: 'guess', actions: [{ action: 'guess', example: 'act({"action":"guess","number":5})' }], seconds_left: 40 },
      public: {},
      events: [],
      ...over,
    }) as never;

  it('小游戏里只在轮到我时决策；动作自动带 phaseId', async () => {
    const r = await rig({}, {}, () => ({ actions: [{ type: 'game_act', input: { action: 'guess', number: 5 } }] }));
    r.port.activityId = 'act1';
    r.port.version = 2;
    r.port.game = game({ your_turn: false, todo: null });
    r.port.push(ev('game_started', { activityId: 'act1' }));
    await r.clock.advance(200);
    // game_started 是紧急事件，但这时不是我的回合：跳过
    expect(r.calls).toHaveLength(0);
    expect(r.handle.stats.skipped).toBe(1);
    // 小游戏里的聊天 / 别人的进展都不触发
    r.port.push(chat(), ev('game', { yourTurn: false }), ev('arrived'));
    await r.clock.advance(20_000);
    expect(r.calls).toHaveLength(0);
    // 轮到我
    r.port.game = game();
    r.port.push(ev('game', { yourTurn: true, phaseId: 7 }));
    await r.clock.advance(200);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.ctx.mode).toBe('game');
    expect(r.calls[0]!.ctx.deadlineAt).not.toBeNull();
    expect(r.port.acts).toHaveLength(1);
    expect(r.port.acts[0]!.action).toEqual({ type: 'game_act', input: { action: 'guess', number: 5 }, phaseId: 7 });
    expect(r.port.acts[0]!.opts.activityId).toBe('act1');
  });

  it('这一手剩余时间太少：不决策，让引擎托管', async () => {
    const r = await rig();
    r.port.activityId = 'act1';
    r.port.game = game({ todo: { prompt: '猜', kind: 'guess', actions: [], seconds_left: 1 } });
    r.port.push(ev('game', { yourTurn: true }));
    await r.clock.advance(300);
    expect(r.calls).toHaveLength(0);
    expect(r.handle.stats.skipped).toBe(1);
    expect(r.handle.budget().remaining).toBe(30); // 没花预算
  });

  it('决策到截止时间还没出来：不抢答，作废', async () => {
    let finish: ((d: Decision | null) => void) | null = null;
    const r = await rig({ gameSafetyMarginMs: 500, decideTimeoutMs: 60_000 }, {}, () => new Promise<Decision | null>((res) => (finish = res)));
    r.port.activityId = 'act1';
    r.port.game = game({ todo: { prompt: '猜', kind: 'guess', actions: [{ action: 'guess' }], seconds_left: 5 } });
    r.port.push(ev('game', { yourTurn: true }));
    await r.clock.advance(100);
    expect(r.calls).toHaveLength(1);
    // 决策函数的超时被压到 剩余时间 - 余量 = 4.5 秒
    await r.clock.advance(5000);
    expect(r.calls[0]!.ctx.signal.aborted).toBe(true);
    expect(r.handle.stats.timeouts).toBe(1);
    finish!({ actions: [{ type: 'game_act', input: { action: 'guess', number: 1 } }] });
    await r.clock.advance(100);
    expect(r.port.acts).toHaveLength(0);
  });

  it('局内动作被拒绝（phase_stale）→ 作废，不重试', async () => {
    const r = await rig({}, {}, () => ({ actions: [{ type: 'game_act', input: { action: 'guess', number: 1 } }] }));
    r.port.activityId = 'act1';
    r.port.game = game();
    r.port.actBehavior = () => {
      throw new PhaseStaleError('phase_stale', '阶段变了', { tool: 'world_act' });
    };
    r.port.push(ev('game', { yourTurn: true }));
    await r.clock.advance(500);
    expect(r.port.acts).toHaveLength(1);
    expect(r.handle.stats.discarded).toBe(1);
  });
});

describe('ResidentRunner：控制权与在场', () => {
  it('act 返回 control_lost：停止写入，之后的事件不再决策', async () => {
    const r = await rig({}, {}, () => speak());
    r.port.actBehavior = () => {
      throw new ControlLostError('control_lost', '被接管', { tool: 'world_act' });
    };
    r.port.push(ev('invite'));
    await r.clock.advance(200);
    expect(r.handle.status).toBe('control_lost');
    expect(r.handle.stats.controlLost).toBe(1);
    const decisions = r.calls.length;
    r.port.push(ev('invite'), chat());
    await r.clock.advance(60_000);
    expect(r.calls.length).toBe(decisions);
    expect(r.port.acts).toHaveLength(1);
    expect(r.port.claims).toBe(0); // 默认不抢
    // 手动恢复
    r.port.actBehavior = null;
    await r.handle.resume();
    await r.clock.advance(200);
    expect(r.port.claims).toBe(1);
    expect(r.handle.status).toBe('running');
    expect(r.calls.length).toBe(decisions + 1);
  });

  it('control 事件 + 视图显示不是我：停止写入', async () => {
    const r = await rig({}, {}, () => speak());
    r.port.mine = false;
    r.port.push(ev('control', { epoch: 2 }));
    await r.clock.advance(200);
    expect(r.handle.status).toBe('control_lost');
    r.port.push(ev('invite'));
    await r.clock.advance(20_000);
    expect(r.port.acts).toHaveLength(0);
  });

  it('control 事件是自己接管产生的（视图显示是我）：不受影响', async () => {
    const r = await rig({}, {}, () => speak());
    r.port.push(ev('control', { epoch: 2 }));
    await r.clock.advance(200);
    expect(r.handle.status).toBe('running');
  });

  it('autoClaim 打开：隔一会儿接管回来继续，且有每小时次数上限', async () => {
    const r = await rig({ autoClaim: true, autoClaimDelayMs: 1000, autoClaimMaxPerHour: 2, minIntervalMs: 100 }, {}, () => speak());
    const lose = async () => {
      r.port.mine = false;
      r.port.push(ev('control'));
      await r.clock.advance(300);
    };
    await lose();
    expect(r.handle.status).toBe('control_lost');
    await r.clock.advance(1500);
    expect(r.port.claims).toBe(1);
    expect(r.handle.status).toBe('running');
    await lose();
    await r.clock.advance(1500);
    expect(r.port.claims).toBe(2);
    await lose();
    await r.clock.advance(10_000);
    expect(r.port.claims).toBe(2); // 到上限不再抢
    expect(r.handle.status).toBe('control_lost');
  });

  it('空闲策略：长时间没事可做就 leave（默认不 leave）', async () => {
    const r = await rig({ idleLeaveMs: 60_000 });
    await r.clock.advance(59_000);
    expect(r.port.leaves).toBe(0);
    await r.clock.advance(3000);
    expect(r.port.leaves).toBe(1);
    expect(r.handle.status).toBe('left');
    await r.handle.done;
    const d = await rig();
    await d.clock.advance(3_600_000);
    expect(d.port.leaves).toBe(0);
    expect(d.handle.status).toBe('running');
  });

  it('stop() 干净退出：中断长轮询和在途决策，done 结束', async () => {
    let signal: AbortSignal | null = null;
    const r = await rig({}, {}, (ctx) => {
      signal = ctx.signal;
      return new Promise<Decision | null>(() => undefined);
    });
    r.port.push(ev('invite'));
    await r.clock.advance(200);
    expect(signal!.aborted).toBe(false);
    await r.runner.stop();
    expect(signal!.aborted).toBe(true);
    await r.handle.done;
    expect(r.handle.status).toBe('stopped');
    expect(r.clock.pendingTimers).toBe(0);
    expect(r.port.leaves).toBe(0);
  });

  it('stop({leave:true}) 会离开小镇', async () => {
    const r = await rig();
    await r.runner.stop({ leave: true });
    expect(r.port.leaves).toBe(1);
  });
});

describe('ResidentRunner：断线重连与游标续传', () => {
  it('wait 连续失败：指数退避重连，游标不丢，重连后仍能收事件', async () => {
    const r = await rig({ reconnectBaseMs: 1000, reconnectMaxMs: 30_000 }, {}, () => null);
    // 先正常收一批事件，游标前进
    r.port.push(ev('presence'));
    await r.clock.advance(100);
    const cursorBefore = r.port.waits.at(-1)!.cursor;
    expect(cursorBefore).toBeDefined();
    let fails = 3;
    const failAt: number[] = [];
    r.port.waitFail = () => {
      if (fails-- > 0) {
        failAt.push(r.rel(r.clock.now()));
        return new TownNetworkError('network', '连接断开', { tool: 'world_wait' });
      }
      return null;
    };
    r.port.push(ev('presence'));
    await r.clock.advance(60_000);
    expect(r.handle.stats.reconnects).toBe(3);
    // 退避间隔 1s、2s、4s
    expect(failAt.slice(1).map((t, i) => t - failAt[i]!)).toEqual([1000, 2000]);
    expect(r.handle.status).toBe('running');
    // 重连之后游标是连续的（用的是最后确认的游标，没有回到起点）
    const after = r.port.waits.filter((w) => w.at > r.clock.now() - 20_000).map((w) => w.cursor);
    expect(after.every((c) => c !== undefined && c >= cursorBefore!)).toBe(true);
    r.port.push(ev('invite'));
    r.port.waitFail = null;
    await r.clock.advance(500);
    expect(r.calls).toHaveLength(1);
  });

  it('提供 reconnect：断线后换新连接重新进入，游标照旧', async () => {
    const clock = new FakeClock();
    const first = new FakePort(clock);
    const second = new FakePort(clock);
    second.cursorN = 99;
    const runner = new ResidentRunner({ clock });
    first.push(ev('presence'));
    const h = runner.add({
      town: first,
      profile: { name: '小测' },
      decideOnStart: false,
      decide: () => null,
      reconnect: async () => second,
    });
    await clock.advance(200);
    const last = first.waits.at(-1)!.cursor;
    first.waitFail = () => new TownNetworkError('network', '会话丢了', { tool: 'world_wait' });
    first.push(ev('presence'));
    await clock.advance(5000);
    expect(first.closed).toBe(true);
    expect(second.enters).toBe(1);
    expect(second.waits.length).toBeGreaterThan(0);
    expect(second.waits[0]!.cursor).toBeDefined();
    expect(second.waits[0]!.cursor).not.toBe('c99');
    expect(last).toBeDefined();
    expect(h.stats.reconnects).toBeGreaterThanOrEqual(1);
    await runner.stop();
  });

  it('resync：重读视图并对齐游标，不触发决策', async () => {
    const r = await rig();
    r.port.nextResync = true;
    r.port.push(chat());
    await r.clock.advance(200);
    expect(r.handle.stats.resyncs).toBe(1);
    expect(r.port.views.some((v) => v.resetCursor)).toBe(true);
    expect(r.calls).toHaveLength(0);
    await r.clock.advance(20_000);
    expect(r.calls).toHaveLength(0);
    // 之后的 wait 用的是视图给的新游标
    expect(r.port.waits.at(-1)!.cursor).toBe(`c${r.port.cursorN}`);
  });

  it('会话失效（unauthenticated）→ 重新进入', async () => {
    const r = await rig();
    const { UnauthenticatedError } = await import('../src/index.js');
    let once = true;
    r.port.waitFail = () => {
      if (!once) return null;
      once = false;
      return new UnauthenticatedError('unauthenticated', '先 enter_world', { tool: 'world_wait' });
    };
    r.port.push(ev('presence'));
    await r.clock.advance(500);
    expect(r.port.enters).toBe(2);
    expect(r.handle.status).toBe('running');
  });
});

describe('ResidentRunner：统计', () => {
  it('runner.stats 汇总各居民', async () => {
    const clock = new FakeClock();
    const runner = new ResidentRunner({ clock });
    for (const id of ['a', 'b']) {
      const port = new FakePort(clock, `r_${id}`, id);
      runner.add({ town: port, profile: { name: id }, decide: () => speak() });
    }
    await clock.advance(300);
    expect(runner.stats.decisions).toBe(2);
    expect(runner.stats.actions).toBe(2);
    await runner.stop();
  });
});

void T0;
void flush;
