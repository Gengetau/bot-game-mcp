/**
 * CityRunner 单元测试：
 *  1. 事件三级分类（urgent / normal / ignore，含自身回显与 trip_progress 过滤）；
 *  2. 3s–10s 短窗合并成单次模型观察，以及 urgent 事件插队立即唤醒；
 *  3. 控制权停写栅栏：enter 返回 mine=false、事件流触发 mine=false、act 抛 CONTROL_LOST 均立即停写且绝不自动调 claim_control；
 *  4. 内置 1h + 滚动 24h 预算、最小决策间隔、共享预算池（40/h、300/24h）及耗尽后不阻塞在途行程的优雅降级。
 */
import { describe, expect, it } from 'vitest';
import {
  CityControlLostError,
  CityRunner,
  SlidingWindowBudgetPool,
  defaultCityClassify,
  type CityAction,
  type CityEnterOptions,
  type CityEnterResult,
  type CityEvent,
  type CityPort,
  type CityView,
  type CityWaitOptions,
  type CityWaitResult,
  type RunnerClock,
} from '../src/index.js';

class ManualClock implements RunnerClock {
  t = 1_794_930_000_000;
  private sleepers: Array<{ due: number; resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = {
        due: this.t + ms,
        resolve,
        reject,
        signal,
        onAbort: undefined as (() => void) | undefined,
      };
      entry.onAbort = () => {
        const idx = this.sleepers.indexOf(entry);
        if (idx >= 0) this.sleepers.splice(idx, 1);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.sleepers.push(entry);
      this.sleepers.sort((a, b) => a.due - b.due);
    });
  }

  async advance(ms: number): Promise<void> {
    await this.flushMicrotasks();
    const target = this.t + ms;
    while (this.sleepers.length > 0 && this.sleepers[0]!.due <= target) {
      const next = this.sleepers.shift()!;
      this.t = next.due;
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
      await this.flushMicrotasks();
    }
    this.t = target;
    await this.flushMicrotasks();
  }

  async flushMicrotasks(ticks = 40): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
  }
}

class FakeCityPort implements CityPort {
  readonly acts: Array<{ requestId: string; action: CityAction }> = [];
  claimCalls = 0;
  leaveCalls = 0;
  controlEpoch = 1;
  controlMine = true;
  inTransit = false;
  place = 'kagamiike:kissa-tomoshibi';
  actHook?: (action: CityAction, requestId: string) => void;

  private seq = 0;
  private events: Array<{ cursor: string; ev: CityEvent }> = [];
  private waiters: Array<{ resolve: () => void }> = [];

  constructor(private readonly clock: ManualClock, readonly residentId = 'res_bot1') {}

  private cursorOf(n: number): string {
    return `r${n}.sig`;
  }

  private parseCursor(c?: string): number {
    const m = /^r(\d+)\./.exec(c ?? '');
    return m ? Number(m[1]) : 0;
  }

  emit(ev: Omit<CityEvent, 'at'> & { at?: number }): void {
    this.seq += 1;
    this.events.push({
      cursor: this.cursorOf(this.seq),
      ev: { ...ev, at: ev.at ?? this.clock.now() } as CityEvent,
    });
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  buildView(): CityView {
    return {
      world_id: 'city',
      at_ms: this.clock.now(),
      local_time: '14:00',
      me: { id: this.residentId, name: '小旅', origin: 'external', in_city: true },
      control: { epoch: this.controlEpoch, mine: this.controlMine },
      location: this.inTransit
        ? { in_transit: true, trip: { trip_id: 'tr_1', from: 'hiwatari:station', to: this.place } }
        : { place: this.place },
      wallet: { yen: 199_000, held_yen: 0, spendable_yen: 199_000 },
      items: [],
      locker_items: [],
      here: this.inTransit
        ? null
        : {
            place: { id: this.place, name: '喫茶「灯」', area: 'kagamiike', type: 'cafe', open: true },
            people: [],
            goods: [{ sku: 'coffee', name: '混合咖啡', price_yen: 450 }],
            exits: [],
            recent_chat: [],
          },
      can: this.inTransit ? [] : ['say', 'travel', 'buy', 'consume', 'give'],
      mappings_version: 3,
      action_window: 'city',
      context: { version: 0 },
      cursor: this.cursorOf(this.seq),
    };
  }

  async enterWorld(_opts?: CityEnterOptions): Promise<CityEnterResult> {
    return {
      ok: true,
      created: false,
      resident_id: this.residentId,
      ...this.buildView(),
    };
  }

  async view(): Promise<CityView> {
    return this.buildView();
  }

  async wait(opts: CityWaitOptions = {}): Promise<CityWaitResult> {
    const after = this.parseCursor(opts.cursor);
    const unread = () => this.events.slice(after);
    if (unread().length === 0 && (opts.waitSeconds ?? 25) > 0) {
      await new Promise<void>((resolve, reject) => {
        const waiter = { resolve: () => {} };
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve();
        };
        waiter.resolve = done;
        this.waiters.push(waiter);
        this.clock.sleep((opts.waitSeconds ?? 25) * 1000, opts.signal).then(done, (err) => {
          if (settled) return;
          settled = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(err);
        });
      });
    }
    const batch = unread();
    return {
      reason: batch.length > 0 ? 'events' : 'timeout',
      events: batch.map((b) => b.ev),
      cursor: batch.length > 0 ? batch[batch.length - 1]!.cursor : this.cursorOf(after),
      more: false,
      context: { version: 0 },
      control: { epoch: this.controlEpoch, mine: this.controlMine },
      present: true,
    };
  }

  async act(action: CityAction, opts?: { requestId?: string }): Promise<any> {
    const reqId = opts?.requestId ?? 'missing';
    this.actHook?.(action, reqId);
    this.acts.push({ requestId: reqId, action });
    return { ok: true, request_id: reqId, status: 'completed' };
  }

  async heartbeat() {
    return { ok: true as const, present: true, control: { epoch: this.controlEpoch, mine: this.controlMine } };
  }

  async claimControl() {
    this.claimCalls += 1;
    this.controlEpoch += 1;
    this.controlMine = true;
    return { ok: true as const, control: { epoch: this.controlEpoch, mine: true } };
  }

  async leaveWorld() {
    this.leaveCalls += 1;
    return { ok: true as const };
  }
}

describe('CityRunner：事件分级、3s–10s 短窗合并、预算治理与 CONTROL_LOST 停写栅栏', () => {
  it('defaultCityClassify 严格区分 urgent / normal / ignore（过滤自身回显与途经站）', () => {
    const ctx = { residentId: 'res_me' };
    expect(defaultCityClassify({ type: 'gift_received', at: 1 }, ctx)).toBe('urgent');
    expect(defaultCityClassify({ type: 'appointment_proposed', at: 1 }, ctx)).toBe('urgent');
    expect(defaultCityClassify({ type: 'appointment_soon', at: 1 }, ctx)).toBe('urgent');
    expect(defaultCityClassify({ type: 'chat', at: 1, from: { id: 'res_other' } }, ctx)).toBe('urgent');
    expect(defaultCityClassify({ type: 'offer', at: 1, to: { id: 'res_me' }, from: { id: 'res_other' } }, ctx)).toBe('urgent');

    expect(defaultCityClassify({ type: 'you_arrived', at: 1 }, ctx)).toBe('normal');
    expect(defaultCityClassify({ type: 'trip_stopped', at: 1 }, ctx)).toBe('normal');
    expect(defaultCityClassify({ type: 'weather', at: 1 }, ctx)).toBe('normal');
    expect(defaultCityClassify({ type: 'arrived', at: 1 }, ctx)).toBe('normal');
    expect(defaultCityClassify({ type: 'left', at: 1 }, ctx)).toBe('normal');

    expect(defaultCityClassify({ type: 'chat', at: 1, from: { id: 'res_me' } }, ctx)).toBe('ignore');
    expect(defaultCityClassify({ type: 'chat', at: 1, mine: true }, ctx)).toBe('ignore');
    expect(defaultCityClassify({ type: 'trip_progress', at: 1 }, ctx)).toBe('ignore');
    expect(defaultCityClassify({ type: 'trip_started', at: 1 }, ctx)).toBe('ignore');
    expect(defaultCityClassify({ type: 'control', at: 1 }, ctx)).toBe('ignore');
  });

  it('normal 事件在 3s–10s 短窗内合并为单次模型决策，ignore 事件不唤醒模型', async () => {
    const clock = new ManualClock();
    const port = new FakeCityPort(clock);
    const seenBatches: CityEvent[][] = [];

    const runner = new CityRunner({
      clock,
      decideOnStart: false,
      minIntervalMs: 1_000,
      debounceMs: 3_000,
      debounceMaxMs: 10_000,
    });
    const handle = runner.add({
      city: port,
      decide: (ctx) => {
        seenBatches.push(ctx.events);
        return null;
      },
    });
    await clock.flushMicrotasks();

    // 连续推送 ignore 事件：自身回显 + 电车途经中间站 -> 0 次决策
    port.emit({ type: 'chat', from: { id: port.residentId }, text: '自言自语' });
    port.emit({ type: 'trip_progress', at_place: 'kagamiike:station' });
    await clock.advance(15_000);
    expect(handle.stats.decisions).toBe(0);

    // 连续推送 3 条 normal 事件（间隔各 2s，均未满 3s 静默），应在最后一条后 3s（t+7s）合并触发 1 次决策
    port.emit({ type: 'arrived', who: { id: 'res_a', name: '妮娅' } });
    await clock.advance(2_000);
    port.emit({ type: 'weather', kind: 'rain_started' });
    await clock.advance(2_000);
    port.emit({ type: 'you_arrived', place: 'kagamiike:kissa-tomoshibi' });
    await clock.advance(2_500);
    expect(handle.stats.decisions).toBe(0); // 距最后一条仅 2.5s，仍在合并窗内

    await clock.advance(600);
    expect(handle.stats.decisions).toBe(1);
    expect(seenBatches[0]!.map((e) => e.type)).toEqual(['arrived', 'weather', 'you_arrived']);

    // 验证 10s 最长合并上限（每 2s 持续来 normal 事件，第 10s 强制触发）
    await clock.advance(5_000);
    for (let i = 0; i < 6; i++) {
      port.emit({ type: 'left', who: { id: `res_${i}` } });
      await clock.advance(2_000);
    }
    expect(handle.stats.decisions).toBe(2);

    await runner.stop();
  });

  it('进入时 control.mine === false 立即进入 control_lost 停写态，绝不自动调用 claim_control', async () => {
    const clock = new ManualClock();
    const port = new FakeCityPort(clock);
    port.controlMine = false;
    port.controlEpoch = 3;

    let decideCalled = 0;
    const runner = new CityRunner({ clock, decideOnStart: true });
    const handle = runner.add({
      city: port,
      decide: () => {
        decideCalled += 1;
        return { actions: [{ type: 'say', text: '不该发出去的话' }] };
      },
    });

    await clock.flushMicrotasks();
    await clock.advance(30_000);
    expect(handle.status).toBe('control_lost');
    expect(handle.stats.controlLost).toBe(1);
    expect(decideCalled).toBe(0);
    expect(port.acts).toHaveLength(0);
    expect(port.claimCalls).toBe(0);

    // 仅当外部宿主显式调用 resume({ claim: true }) 时才接管恢复
    await handle.resume({ claim: true });
    await clock.advance(1_000);
    expect(port.claimCalls).toBe(1);
    expect(handle.status).toBe('running');
    expect(decideCalled).toBe(1);
    expect(port.acts).toHaveLength(1);

    await runner.stop();
  });

  it('执行多步动作中途捕获 CONTROL_LOST 时立即停写，丢弃后续步骤且不抢控制权', async () => {
    const clock = new ManualClock();
    const port = new FakeCityPort(clock);
    port.actHook = () => {
      port.controlMine = false;
      port.controlEpoch = 9;
      throw new CityControlLostError('control_lost', '已被另一客户端接管', {
        tool: 'world_act',
        data: { control: { epoch: 9, mine: false } },
      });
    };

    const runner = new CityRunner({ clock, decideOnStart: true });
    const handle = runner.add({
      city: port,
      decide: () => ({
        actions: [
          { type: 'buy', sku: 'coffee', qty: 1 },
          { type: 'say', text: '第二步不应执行' },
        ],
      }),
    });

    await clock.flushMicrotasks();
    await clock.advance(5_000);
    expect(handle.status).toBe('control_lost');
    expect(port.acts).toHaveLength(0);
    expect(port.claimCalls).toBe(0);

    await runner.stop();
  });

  it('共享预算池（40/h、300/24h）与单居民预算耗尽时优雅降级，不阻塞在途事件且支持主动 leave_world', async () => {
    const clock = new ManualClock();
    const port = new FakeCityPort(clock);
    const sharedPool = new SlidingWindowBudgetPool(40, 300);
    // 预先消耗 39 次共享池额度，仅剩 1 次
    for (let i = 0; i < 39; i++) {
      expect(sharedPool.tryConsume(clock.now(), 'other')).toBe(true);
    }
    expect(sharedPool.remaining(clock.now())).toBe(1);

    const runner = new CityRunner({
      clock,
      sharedBudget: sharedPool,
      decideOnStart: false,
      minIntervalMs: 1_000,
      budgetPerHour: 5,
      budgetPerDay: 20,
    });
    const handle = runner.add({
      city: port,
      decide: () => ({ actions: [{ type: 'say', text: '收到礼物啦' }] }),
    });
    await clock.flushMicrotasks();

    // 第 1 次紧急事件：正常消耗最后 1 次共享配额
    port.emit({ type: 'gift_received', from: { id: 'res_2', name: '星璃' } });
    await clock.advance(2_000);
    expect(handle.stats.decisions).toBe(1);
    expect(sharedPool.remaining(clock.now())).toBe(0);

    // 角色进入乘车途中，共享预算已耗尽：电车到站事件照常推进游标，不死锁、不调模型
    port.inTransit = true;
    port.emit({ type: 'gift_received', from: { id: 'res_3', name: '克蕾雅' } });
    await clock.advance(2_000);
    expect(handle.budgetExhausted).toBe(true);
    expect(handle.stats.budgetBlocked).toBeGreaterThanOrEqual(1);
    expect(handle.stats.decisions).toBe(1);

    port.emit({ type: 'you_arrived', place: 'sentou:station' });
    await clock.advance(5_000);
    expect(handle.stats.events).toBe(3); // 游标照常推进，未卡死

    // 推进满 1 小时后，40/h 窗口释放，再次触发决策并主动请求 leave: true 离城休息
    await clock.advance(3_600_000);
    expect(sharedPool.remaining(clock.now())).toBe(40);

    await runner.stop({ leave: true });
    expect(port.leaveCalls).toBe(1);
    expect(handle.status).toBe('left');
  });
});
