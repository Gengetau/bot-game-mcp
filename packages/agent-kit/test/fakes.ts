/**
 * 运行器测试用的假时钟和假小镇端口：事件、视图、动作结果都由测试脚本控制，时间由 FakeClock 推进。
 */
import type { ActOptions, ActResult, EnterProfile, EnterResult, NavigationRenewal, RunnerClock, TownAction, TownEvent, TownPort, TownView, WaitOptions, WaitResult } from '../src/index.js';

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

export class FakeClock implements RunnerClock {
  t = 1_700_000_000_000;
  private timers: { at: number; seq: number; fire: () => void; cancel: () => void }[] = [];
  private seq = 0;
  now() {
    return this.t;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const entry = {
        at: this.t + Math.max(0, ms),
        seq: this.seq++,
        fire: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        cancel: () => {
          this.timers = this.timers.filter((x) => x !== entry);
        },
      };
      const onAbort = () => {
        entry.cancel();
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.timers.push(entry);
    });
  }
  /** 推进 ms 毫秒：到期的定时器按顺序触发，每次触发后让出事件循环让异步流程跑完。 */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await flush();
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fire();
      await flush();
    }
    this.t = target;
    await flush();
  }
  get pendingTimers(): number {
    return this.timers.length;
  }
}

export interface ActCall {
  action: TownAction;
  opts: ActOptions;
  at: number;
}

export class FakePort implements TownPort {
  readonly acts: ActCall[] = [];
  readonly waits: { cursor: string | undefined; seconds: number | undefined; at: number }[] = [];
  readonly views: { resetCursor: boolean; at: number }[] = [];
  enters = 0;
  claims = 0;
  leaves = 0;
  closed = false;
  /** 视图状态：测试可以直接改 */
  version = 1;
  activityId: string | null = null;
  mine = true;
  present = true;
  game: TownView['game'] = null;
  here: TownView['here'] = null;
  offers: TownView['offers'] = [];
  cursorN = 1;
  /** 下一次 act 的行为：返回 undefined = 成功；抛错 = 失败 */
  actBehavior: ((a: ActCall) => ActResult | undefined | Promise<ActResult | undefined>) | null = null;
  /** 下一次 wait / view 的故障注入 */
  waitFail: (() => Error | null) | null = null;
  viewFail: (() => Error | null) | null = null;
  private queue: TownEvent[] = [];
  private waiters: (() => void)[] = [];
  /** wait 返回 resync */
  nextResync = false;
  /** 视图里的 location.walking（测试可以直接改） */
  walking: NonNullable<TownView['location']['walking']> | null = null;
  readonly renews: { navigationId: string; revision?: number; at: number }[] = [];
  stops = 0;
  /** 续租的行为：返回结果或抛错；不设就一直 ok */
  renewBehavior: ((nav: { navigationId: string; revision?: number }) => NavigationRenewal | Promise<NavigationRenewal>) | null = null;

  constructor(
    readonly clock: FakeClock,
    readonly residentId = 'r_me',
    readonly name = '小测',
  ) {}

  push(...evs: TownEvent[]): void {
    this.queue.push(...evs);
    for (const w of this.waiters.splice(0)) w();
  }

  viewObj(): TownView {
    return {
      world: { name: '栖灯镇', clock: '10:00', date: '2026-11-12', weather: '晴' },
      me: { id: this.residentId, name: this.name, needs: { energy: 80, social: 60, interest: 60 }, mood: null, home: `home:${this.residentId}` },
      control: { epoch: 1, mine: this.mine, presenceEpoch: 0 },
      context: { version: this.version, activityId: this.activityId },
      action_window: `aw.${this.version}`,
      cursor: `c${this.cursorN}`,
      location: { space: 'plaza', name: '灯下广场', ...(this.walking ? { walking: this.walking } : {}) },
      here: this.here,
      coins: 20,
      items: [],
      goals: [],
      mail_unread: 0,
      invites: [],
      offers: this.offers,
      doing: null,
      game: this.game,
      suggestions: [],
    } as TownView;
  }

  async enter(_profile?: EnterProfile): Promise<EnterResult> {
    this.enters++;
    return { ...this.viewObj(), ok: true, created: false, resident_id: this.residentId } as EnterResult;
  }

  async view(opts: { resetCursor?: boolean; signal?: AbortSignal } = {}): Promise<TownView> {
    this.views.push({ resetCursor: Boolean(opts.resetCursor), at: this.clock.now() });
    const f = this.viewFail?.();
    if (f) throw f;
    if (opts.resetCursor) this.cursorN++;
    return this.viewObj();
  }

  async wait(opts: WaitOptions = {}): Promise<WaitResult> {
    this.waits.push({ cursor: opts.cursor, seconds: opts.waitSeconds, at: this.clock.now() });
    const f = this.waitFail?.();
    if (f) throw f;
    const result = (reason: string): WaitResult => {
      const events = this.queue.splice(0);
      if (events.length) this.cursorN++;
      return { reason, events, cursor: `c${this.cursorN}`, more: false, context: { version: this.version, activityId: this.activityId }, present: this.present, ...(this.nextResync ? ((this.nextResync = false), { resync: true }) : {}) };
    };
    if (this.queue.length || (opts.waitSeconds ?? 0) <= 0 || this.nextResync) return result(this.queue.length ? 'event' : 'timeout');
    const ac = new AbortController();
    const signal = opts.signal;
    let onAbort: () => void = () => undefined;
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(resolve);
      this.clock.sleep((opts.waitSeconds ?? 25) * 1000, ac.signal).then(resolve, () => undefined);
    }).finally(() => {
      ac.abort();
      signal?.removeEventListener('abort', onAbort);
    });
    return result(this.queue.length ? 'event' : 'timeout');
  }

  async act(action: TownAction, opts: ActOptions = {}): Promise<ActResult> {
    const call: ActCall = { action, opts, at: this.clock.now() };
    this.acts.push(call);
    const r = await this.actBehavior?.(call);
    return r ?? ({ ok: true, requestId: opts.requestId ?? 'x', status: 'completed', contextVersion: this.version, activityId: this.activityId, cursor: `c${this.cursorN}` } as ActResult);
  }

  async renewNavigation(nav: { navigationId: string; revision?: number }): Promise<NavigationRenewal> {
    this.renews.push({ ...nav, at: this.clock.now() });
    if (this.renewBehavior) return this.renewBehavior(nav);
    return { ok: true, leaseUntil: this.clock.now() + 10_000, navigation: { navigationId: nav.navigationId, revision: nav.revision ?? 1, renewEveryMs: 3000 } };
  }
  async stopNavigation() {
    this.stops++;
    return { ok: true };
  }
  async heartbeat() {
    return { ok: true };
  }
  async claim() {
    this.claims++;
    this.mine = true;
    return { ok: true };
  }
  async leave() {
    this.leaves++;
    return { ok: true };
  }
  async close() {
    this.closed = true;
  }
}

let evSeq = 0; // 自增保证每个事件内容唯一（runner 按内容哈希去重，随机的 at 可能碰巧相同）
export const chat = (from = 'r_other', text = '你好', extra: Record<string, unknown> = {}): TownEvent => ({ type: 'chat', at: Date.now(), space: 'plaza', from: { id: from, name: from }, text, messageId: 1e9 + ++evSeq, ...extra });
export const ev = (type: string, extra: Record<string, unknown> = {}): TownEvent => ({ type, at: Date.now() + 1e6 + ++evSeq, ...extra });
export { flush };
