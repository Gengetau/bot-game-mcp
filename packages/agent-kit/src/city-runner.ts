/**
 * 晴空都持续世界 AI 居民运行器（CityRunner）：
 * 复用 ResidentRunner 已验证的事件驱动与预算思想，针对晴空都「无帧级坐标、持久电车/步行行程（trips）」模型定制。
 *
 * 核心保证（对齐计划书 §五 M1-B 与 docs/city/IDENTITY-AND-FACTS.md §3.2）：
 *  1. 事件三级分类：
 *     - urgent（立即唤醒）：收到礼物（gift_received）、收到邀约/报价（appointment_* / invite / offer）、
 *       同地点他人现场发言（chat，不含自身回显）、轮到本人的店内桌游回合（game_started / game.yourTurn）；
 *     - normal（3s–10s 短窗合并成单次模型观察）：到站/到达（you_arrived）、行程中止（trip_stopped）、
 *       天气变化（weather）、同地点他人进出（arrived / left）、订单或制作完成（order_resolved / craft_completed / work_completed）；
 *     - ignore（零模型消耗）：自身发言或动作回显、电车途经中间站（trip_progress）、控制权事件（由运行器控制栅栏直接处理）。
 *  2. 内置双窗口调用预算与最小决策间隔：
 *     - 单角色滑动 1h 上限（默认 20 次）+ 滚动 24h 上限（默认 120 次）+ 最小决策间隔（默认 10s），并支持挂载外部共享预算池；
 *     - 预算耗尽时优雅降级：不卡死城内状态，在途电车照常到站，支持空闲自动或模型主动调 leave_world 离城休息。
 *  3. 严格控制权停写栅栏：
 *     - 一旦观察到 view.control.mine === false、wait 返回 control.mine === false，或写动作捕获 CONTROL_LOST，
 *       立即进入 'control_lost' 停写态，清空未发动作，绝不自动循环调用 claim_control 抢夺控制权。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  CityClientError,
  isCityDiscardError,
  isFatalCityEnterError,
  toCityError,
  type CityActOptions,
  type CityActResult,
  type CityAction,
  type CityClaimResult,
  type CityEnterOptions,
  type CityEnterResult,
  type CityEvent,
  type CityHeartbeatResult,
  type CityView,
  type CityWaitOptions,
  type CityWaitResult,
} from './city.js';
import { systemClock, type EventClass, type RunnerClock } from './resident.js';

// ───────────────────────── 接口定义 ─────────────────────────

/** CityRunner 依赖的最小城市客户端端口（CityClient 满足；单测可注入桩实现）。 */
export interface CityPort {
  enterWorld(opts?: CityEnterOptions): Promise<CityEnterResult>;
  view(opts?: { cursor?: string; waitSeconds?: number; resetCursor?: boolean; signal?: AbortSignal }): Promise<CityView>;
  wait(opts?: CityWaitOptions): Promise<CityWaitResult>;
  act(action: CityAction, opts?: CityActOptions): Promise<CityActResult>;
  heartbeat(opts?: { signal?: AbortSignal }): Promise<CityHeartbeatResult>;
  claimControl(opts?: { signal?: AbortSignal }): Promise<CityClaimResult>;
  leaveWorld(opts?: { signal?: AbortSignal }): Promise<{ ok: true }>;
  close?(): Promise<void>;
}

export interface CityClassifyContext {
  residentId: string;
}

/**
 * 晴空都城市世界默认事件分级器（对齐计划书 §五 M1-B）：
 *  - urgent：收到礼物、邀约、面向本人的交易报价、同行现场搭话、轮到本人的桌游回合；
 *  - normal：you_arrived、trip_stopped、weather、他人进出（arrived / left）、订单/委托结算、离线留言/明信片；
 *  - ignore：自身回显、trip_progress（途经换乘站）、control（运行器内部处理）及其他无关事件。
 */
export function defaultCityClassify(ev: CityEvent, ctx: CityClassifyContext): EventClass {
  switch (ev.type) {
    case 'trip_progress':
    case 'trip_started':
    case 'order_pending':
    case 'control':
    case 'presence':
    case 'heartbeat':
      return 'ignore';

    case 'chat': {
      const from = ev.from as { id?: string } | undefined;
      if (ev.mine === true || from?.id === ctx.residentId) return 'ignore';
      return 'urgent';
    }

    case 'gift_received':
    case 'appointment_proposed':
    case 'appointment_soon':
    case 'invite':
    case 'game_started':
      return 'urgent';

    case 'game':
      return ev.yourTurn === true ? 'urgent' : 'ignore';

    case 'offer': {
      const offer = (ev.offer ?? ev) as { from?: { id?: string }; to?: { id?: string } };
      if (offer.from?.id === ctx.residentId) return 'ignore';
      return offer.to?.id === ctx.residentId ? 'urgent' : 'normal';
    }

    case 'you_arrived':
    case 'trip_stopped':
    case 'weather':
    case 'arrived':
    case 'left':
    case 'order_resolved':
    case 'craft_completed':
    case 'work_completed':
    case 'postcard_received':
    case 'message_received':
    case 'game_ended':
    case 'game_out':
      return 'normal';

    default:
      return 'ignore';
  }
}

/** 可选的外部共享预算池接口（如跨多实例统一限流）。 */
export interface CitySharedBudgetPool {
  /** 检查当前是否允许消耗 1 次模型决策；返回 true 则原子扣减 1 次配额 */
  tryConsume(nowMs: number, residentId: string): boolean;
  /** 查询共享池当前剩余可用次数（供上下文展示） */
  remaining?(nowMs: number): number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 双滑动窗口共享预算池实现（例如每小时 40 次、滚动 24 小时 300 次）。 */
export class SlidingWindowBudgetPool implements CitySharedBudgetPool {
  private timestamps: number[] = [];

  constructor(
    readonly maxPerHour: number,
    readonly maxPerDay: number,
  ) {
    if (maxPerHour <= 0 || maxPerDay <= 0) {
      throw new Error('预算池上限必须为正整数');
    }
  }

  private prune(nowMs: number): void {
    this.timestamps = this.timestamps.filter((t) => nowMs - t < DAY_MS);
  }

  remaining(nowMs: number): number {
    this.prune(nowMs);
    const usedHour = this.timestamps.filter((t) => nowMs - t < HOUR_MS).length;
    const usedDay = this.timestamps.length;
    return Math.max(0, Math.min(this.maxPerHour - usedHour, this.maxPerDay - usedDay));
  }

  tryConsume(nowMs: number, _residentId?: string): boolean {
    if (this.remaining(nowMs) <= 0) return false;
    this.timestamps.push(nowMs);
    return true;
  }
}

export interface CityBudgetSnapshot {
  remainingHour: number;
  limitHour: number;
  remainingDay: number;
  limitDay: number;
  sharedRemaining?: number;
  resetsInMs: number;
}

export interface CityDecisionContext {
  /** 本次决策唯一标识，子动作按 `${decisionId}-${i}` 稳定派生幂等 request_id */
  decisionId: string;
  residentId: string;
  name: string;
  triggers: string[];
  view: CityView;
  events: CityEvent[];
  budget: CityBudgetSnapshot;
  memory: unknown;
  signal: AbortSignal;
}

export interface CityDecision {
  actions?: CityAction[];
  /** 设为 true 时执行完动作后主动调用 leave_world 离城休息 */
  leave?: boolean;
  note?: string;
}

export type CityDecideFn = (ctx: CityDecisionContext) => Promise<CityDecision | null> | CityDecision | null;

export interface CityMemorySaveEntry {
  residentId: string;
  decisionId: string;
  at: number;
  triggers: string[];
  events: CityEvent[];
  decision: CityDecision | null;
  outcome: 'executed' | 'noop' | 'discarded' | 'failed' | 'timeout' | 'partial' | 'control_lost';
  results: CityActResult[];
  error?: string;
}

export interface CityResidentMemory {
  load?(info: { residentId: string; view: CityView; events: CityEvent[] }): Promise<unknown> | unknown;
  save?(entry: CityMemorySaveEntry): Promise<void> | void;
}

export interface CityPendingDecision {
  decisionId: string;
  actions: CityAction[];
  leave?: boolean;
  done: number;
  createdAt: number;
}

export interface CityJournalState {
  cursor: string | null;
  seen: string[];
  calls: number[];
  pending: CityPendingDecision | null;
}

export interface CityResidentJournal {
  load(): Promise<CityJournalState | null> | CityJournalState | null;
  save(state: CityJournalState): Promise<void> | void;
}

export class InMemoryCityJournal implements CityResidentJournal {
  state: CityJournalState | null = null;
  load(): CityJournalState | null {
    return this.state ? structuredClone(this.state) : null;
  }
  save(state: CityJournalState): void {
    this.state = structuredClone(state);
  }
}

export interface CityRunnerTuning {
  /** 单居民每小时最大决策次数（滑动窗口），默认 20 */
  budgetPerHour: number;
  /** 单居民滚动 24 小时最大决策次数，默认 120 */
  budgetPerDay: number;
  /** 两次模型决策之间的最小间隔毫秒，默认 10000（10s） */
  minIntervalMs: number;
  /** normal 事件短窗合并静默毫秒（默认 3000 = 3s） */
  debounceMs: number;
  /** normal 事件短窗最长合并等待毫秒（默认 10000 = 10s） */
  debounceMaxMs: number;
  /** urgent 事件去抖毫秒（默认 0：立即响应） */
  urgentDebounceMs: number;
  /** world_wait 单次长轮询秒数（0~50，默认 25） */
  waitSeconds: number;
  /** 单次 decide() 超时毫秒，默认 60000 */
  decideTimeoutMs: number;
  /** 未完成决策跨崩溃恢复最大有效毫秒，默认 300000（5 分钟） */
  maxResumeAgeMs: number;
  /** 模型调用失败指数退避初值与上限 */
  failureBackoffBaseMs: number;
  failureBackoffMaxMs: number;
  /** 网络断线重连指数退避初值与上限 */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** 刚入城且持有控制权时是否触发一次初始观察决策（默认 true） */
  decideOnStart: boolean;
  /** 连续无有效事件超过该毫秒数且不在乘车途中时主动 leave_world 休息（默认 null 不自动离城） */
  idleLeaveMs: number | null;
  /** 预算耗尽且当前不在乘车途中时是否主动调 leave_world 休息（默认 false：安静旁观等电车到站与预算恢复） */
  leaveOnBudgetExhausted: boolean;
  /** 单次决策最多顺序提交几个动作，默认 4 */
  maxActionsPerDecision: number;
  /** 两次决策之间最多保留多少条事件摘要，默认 80 */
  backlogLimit: number;
  /** 事件分级函数 */
  classify: (ev: CityEvent, ctx: CityClassifyContext) => EventClass;
}

export const DEFAULT_CITY_TUNING: CityRunnerTuning = {
  budgetPerHour: 20,
  budgetPerDay: 120,
  minIntervalMs: 10_000,
  debounceMs: 3_000,
  debounceMaxMs: 10_000,
  urgentDebounceMs: 0,
  waitSeconds: 25,
  decideTimeoutMs: 60_000,
  maxResumeAgeMs: 300_000,
  failureBackoffBaseMs: 5_000,
  failureBackoffMaxMs: 300_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  decideOnStart: true,
  idleLeaveMs: null,
  leaveOnBudgetExhausted: false,
  maxActionsPerDecision: 4,
  backlogLimit: 80,
  classify: defaultCityClassify,
};

export interface CityResidentSpec extends Partial<CityRunnerTuning> {
  label?: string;
  city: CityPort;
  reconnect?: () => Promise<CityPort>;
  profile?: Omit<CityEnterOptions, 'signal'>;
  decide: CityDecideFn;
  memory?: CityResidentMemory;
  journal?: CityResidentJournal;
  sharedBudget?: CitySharedBudgetPool;
}

export interface CityRunnerOptions extends Partial<CityRunnerTuning> {
  maxConcurrentDecisions?: number;
  sharedBudget?: CitySharedBudgetPool;
  clock?: RunnerClock;
  log?: (line: string) => void;
}

export interface CityResidentStats {
  decisions: number;
  budgetBlocked: number;
  failures: number;
  timeouts: number;
  discarded: number;
  actions: number;
  noops: number;
  skipped: number;
  reconnects: number;
  controlLost: number;
  resyncs: number;
  events: number;
}

export type CityResidentStatus = 'starting' | 'running' | 'control_lost' | 'away' | 'left' | 'stopped';

export interface CityResidentHandle {
  readonly label: string;
  readonly stats: CityResidentStats;
  readonly status: CityResidentStatus;
  readonly budgetExhausted: boolean;
  budget(): CityBudgetSnapshot;
  /** 显式恢复（仅由外部宿主主动调用；claim=true 时调用 claim_control 接管控制权） */
  resume(opts?: { claim?: boolean }): Promise<void>;
  /** 停止运行器循环；leave=true 时先调 leave_world 主动离城 */
  stop(opts?: { leave?: boolean }): Promise<void>;
  readonly done: Promise<void>;
}

// ───────────────────────── 内部并发信号量 ─────────────────────────

class Semaphore {
  private free: number;
  private readonly queue: { resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];

  constructor(readonly limit: number) {
    this.free = limit;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const item = {
        resolve: () => resolve(this.releaser()),
        reject,
        signal,
        onAbort: undefined as (() => void) | undefined,
      };
      item.onAbort = () => {
        const idx = this.queue.indexOf(item);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      this.queue.push(item);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve();
      } else {
        this.free++;
      }
    };
  }

  get inUse(): number {
    return this.limit - this.free;
  }
}

const emptyStats = (): CityResidentStats => ({
  decisions: 0,
  budgetBlocked: 0,
  failures: 0,
  timeouts: 0,
  discarded: 0,
  actions: 0,
  noops: 0,
  skipped: 0,
  reconnects: 0,
  controlLost: 0,
  resyncs: 0,
  events: 0,
});

const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function specTuning(spec: CityResidentSpec): Partial<CityRunnerTuning> {
  const {
    label: _label,
    city: _city,
    reconnect: _reconnect,
    profile: _profile,
    decide: _decide,
    memory: _memory,
    journal: _journal,
    sharedBudget: _shared,
    ...rest
  } = spec;
  return rest;
}

// ───────────────────────── CityRunner ─────────────────────────

export class CityRunner {
  private readonly clock: RunnerClock;
  private readonly sem: Semaphore;
  private readonly log: (line: string) => void;
  private readonly defaults: CityRunnerTuning;
  private readonly sharedBudget: CitySharedBudgetPool | undefined;
  private readonly residents = new Set<CityResidentWorker>();
  private stopping = false;

  constructor(opts: CityRunnerOptions = {}) {
    const { maxConcurrentDecisions, sharedBudget, clock, log, ...tuning } = opts;
    this.clock = clock ?? systemClock;
    this.sem = new Semaphore(Math.max(1, maxConcurrentDecisions ?? 4));
    this.log = log ?? (() => undefined);
    this.sharedBudget = sharedBudget;
    this.defaults = { ...DEFAULT_CITY_TUNING, ...stripUndefined(tuning) };
  }

  add(spec: CityResidentSpec): CityResidentHandle {
    if (this.stopping) throw new Error('CityRunner 已经停止');
    const worker = new CityResidentWorker(
      spec,
      { ...this.defaults, ...stripUndefined(specTuning(spec)) },
      spec.sharedBudget ?? this.sharedBudget,
      this.clock,
      this.sem,
      this.log,
      () => this.residents.delete(worker),
    );
    this.residents.add(worker);
    worker.start();
    return worker;
  }

  get decisionsInFlight(): number {
    return this.sem.inUse;
  }

  get stats(): CityResidentStats {
    const total = emptyStats();
    for (const r of this.residents) {
      for (const k of Object.keys(total) as (keyof CityResidentStats)[]) {
        total[k] += r.stats[k];
      }
    }
    return total;
  }

  async stop(opts: { leave?: boolean } = {}): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.residents].map((r) => r.stop(opts)));
  }
}

interface PendingBatch {
  triggers: Set<string>;
  urgentAt: number | null;
  firstNormalAt: number | null;
  lastNormalAt: number | null;
}

class DecideTimeout extends Error {}

function eventKey(ev: CityEvent): string {
  return createHash('sha1').update(JSON.stringify(ev)).digest('base64url').slice(0, 20);
}

class CityResidentWorker implements CityResidentHandle {
  readonly label: string;
  readonly stats = emptyStats();
  status: CityResidentStatus = 'starting';
  budgetExhausted = false;
  readonly done: Promise<void>;

  private city: CityPort;
  private readonly ac = new AbortController();
  private readonly journal: CityResidentJournal;
  private js: CityJournalState = { cursor: null, seen: [], calls: [], pending: null };
  private residentId = '';
  private name = '';
  private cursor: string | null = null;
  private inTransit = false;
  private pending: PendingBatch | null = null;
  private backlog: CityEvent[] = [];
  private seen = new Set<string>();
  private inflight: Promise<void> | null = null;
  private lastDecisionAt = Number.NEGATIVE_INFINITY;
  private backoffUntil = 0;
  private failStreak = 0;
  private netFails = 0;
  private lastActivityAt = 0;
  private verifyControl = false;
  private blockedCounted = false;
  private resumeWaiters: (() => void)[] = [];
  private pendingResume: CityPendingDecision | null = null;
  private resolveDone!: () => void;
  private rejectDone!: (e: unknown) => void;

  constructor(
    private readonly spec: CityResidentSpec,
    private readonly t: CityRunnerTuning,
    private readonly sharedBudget: CitySharedBudgetPool | undefined,
    private readonly clock: RunnerClock,
    private readonly sem: Semaphore,
    private readonly runnerLog: (line: string) => void,
    private readonly onEnd: () => void,
  ) {
    this.city = spec.city;
    this.label = spec.label ?? spec.profile?.name ?? 'city-resident';
    this.journal = spec.journal ?? new InMemoryCityJournal();
    this.done = new Promise<void>((res, rej) => {
      this.resolveDone = res;
      this.rejectDone = rej;
    });
    this.done.catch(() => undefined);
  }

  private log(line: string): void {
    this.runnerLog(`[city-runner ${this.label}] ${line}`);
  }

  private get stopped(): boolean {
    return this.ac.signal.aborted;
  }

  // ── 预算核算 ──

  private pruneCalls(now = this.clock.now()): { hourCalls: number[]; dayCalls: number[] } {
    this.js.calls = this.js.calls.filter((x) => now - x < DAY_MS);
    const hourCalls = this.js.calls.filter((x) => now - x < HOUR_MS);
    return { hourCalls, dayCalls: this.js.calls };
  }

  budget(): CityBudgetSnapshot {
    const now = this.clock.now();
    const { hourCalls, dayCalls } = this.pruneCalls(now);
    const remainingHour = Math.max(0, this.t.budgetPerHour - hourCalls.length);
    const remainingDay = Math.max(0, this.t.budgetPerDay - dayCalls.length);
    const sharedRemaining = this.sharedBudget?.remaining ? this.sharedBudget.remaining(now) : undefined;
    let resetsInMs = 0;
    if (remainingHour <= 0 && hourCalls.length > 0) {
      resetsInMs = Math.max(resetsInMs, hourCalls[0]! + HOUR_MS - now);
    }
    if (remainingDay <= 0 && dayCalls.length > 0) {
      resetsInMs = Math.max(resetsInMs, dayCalls[0]! + DAY_MS - now);
    }
    return {
      remainingHour,
      limitHour: this.t.budgetPerHour,
      remainingDay,
      limitDay: this.t.budgetPerDay,
      ...(sharedRemaining !== undefined ? { sharedRemaining } : {}),
      resetsInMs: Math.max(0, resetsInMs),
    };
  }

  private canSpendBudget(now = this.clock.now()): boolean {
    const snap = this.budget();
    if (snap.remainingHour <= 0 || snap.remainingDay <= 0) return false;
    if (snap.sharedRemaining !== undefined && snap.sharedRemaining <= 0) return false;
    void now;
    return true;
  }

  private tryConsumeBudget(now = this.clock.now()): boolean {
    const { hourCalls, dayCalls } = this.pruneCalls(now);
    if (hourCalls.length >= this.t.budgetPerHour || dayCalls.length >= this.t.budgetPerDay) {
      this.budgetExhausted = true;
      return false;
    }
    if (this.sharedBudget && !this.sharedBudget.tryConsume(now, this.residentId)) {
      this.budgetExhausted = true;
      return false;
    }
    this.budgetExhausted = false;
    this.js.calls.push(now);
    return true;
  }

  // ── 生命周期 ──

  start(): void {
    void this.main().then(
      () => {
        if (this.status !== 'left') this.status = 'stopped';
        this.onEnd();
        this.resolveDone();
      },
      (e) => {
        this.status = 'stopped';
        this.onEnd();
        this.log(`异常退出：${errText(e)}`);
        this.rejectDone(e);
      },
    );
  }

  async stop(opts: { leave?: boolean } = {}): Promise<void> {
    if (opts.leave && this.status !== 'stopped' && this.status !== 'left') {
      try {
        await this.city.leaveWorld();
        this.status = 'left';
      } catch (e) {
        this.log(`主动离城失败：${errText(e)}`);
      }
    }
    this.ac.abort();
    for (const w of this.resumeWaiters.splice(0)) w();
    await this.done.catch(() => undefined);
  }

  async resume(opts: { claim?: boolean } = {}): Promise<void> {
    if (this.status !== 'control_lost' && this.status !== 'away') return;
    if (opts.claim !== false) {
      await this.city.claimControl();
    }
    const fresh = await this.city.view({ resetCursor: !this.cursor });
    this.adoptView(fresh);
    if (!fresh.control.mine) {
      this.setPassive('control_lost');
      return;
    }
    this.status = 'running';
    this.pending = null;
    this.addTrigger('resume', 'urgent');
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  // ── 主循环 ──

  private async main(): Promise<void> {
    await this.bootstrap();
    while (!this.stopped) {
      if (this.status === 'control_lost' || this.status === 'away') {
        await this.waitPassive();
        continue;
      }
      if (this.status === 'left') return;

      await this.maybeStartDecision();
      if ((this.status as CityResidentStatus) === 'left' || (this.status as CityResidentStatus) === 'control_lost') {
        continue;
      }

      const plan = this.planWait();
      try {
        if (plan.sleepMs > 0) {
          await this.clock.sleep(plan.sleepMs, this.ac.signal);
        }
        const res = await this.city.wait({
          cursor: this.cursor ?? undefined,
          waitSeconds: plan.seconds,
          signal: this.ac.signal,
        });
        this.netFails = 0;
        await this.ingest(res);
        if (this.verifyControl && this.status === 'running') {
          await this.checkControl();
        }
        await this.checkIdleLeave();
        if ((this.status as CityResidentStatus) === 'left') return;
      } catch (e) {
        if (this.stopped || isAbort(e)) break;
        await this.recover(e);
      }
    }
    await this.inflight?.catch(() => undefined);
  }

  private async bootstrap(): Promise<void> {
    const saved = await this.journal.load();
    if (saved) {
      this.js = {
        cursor: saved.cursor ?? null,
        seen: saved.seen ?? [],
        calls: saved.calls ?? [],
        pending: saved.pending ?? null,
      };
    }
    for (const k of this.js.seen) this.seen.add(k);

    let entered: CityEnterResult | null = null;
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        // 默认不传 claim:true，遵守 M0 规范「已有活跃控制者时安全旁观、绝不暗抢」
        const r = await this.city.enterWorld({ ...this.spec.profile, claim: this.spec.profile?.claim ?? false });
        entered = r;
        this.adoptView(r, true);
        this.residentId = r.resident_id ?? r.me.id;
        this.name = r.me.name;
        this.cursor = this.js.cursor ?? r.cursor;
        break;
      } catch (e) {
        if (this.stopped || isAbort(e)) return;
        const ce = toCityError(e, 'enter_world');
        if (isFatalCityEnterError(ce)) throw ce;
        this.stats.reconnects++;
        const wait = Math.min(this.t.reconnectMaxMs, this.t.reconnectBaseMs * 2 ** Math.min(attempt, 16));
        this.log(`进入晴空都失败（${errText(ce)}），${wait}ms 后重试`);
        await this.sleepQuiet(wait);
      }
    }
    if (this.stopped || !entered) return;

    this.lastActivityAt = this.clock.now();
    if (!entered.control.mine) {
      this.setPassive('control_lost');
      await this.saveJournal();
      return;
    }

    this.status = 'running';
    if (this.js.pending && this.js.pending.done < this.js.pending.actions.length) {
      if (this.clock.now() - this.js.pending.createdAt > this.t.maxResumeAgeMs) {
        this.stats.discarded++;
        this.js.pending = null;
      } else {
        this.pendingResume = this.js.pending;
      }
    } else if (this.js.pending) {
      this.js.pending = null;
    }
    if ((this.t.decideOnStart && !this.inTransit) || this.pendingResume) {
      this.addTrigger('start', 'urgent');
    }
    await this.saveJournal();
  }

  private adoptView(v: CityView, initial = false): void {
    if (initial) this.residentId = v.me?.id ?? this.residentId;
    this.inTransit = Boolean(v.location && 'in_transit' in v.location && v.location.in_transit);
  }

  private setPassive(reason: 'control_lost' | 'away'): void {
    if (this.status === reason) return;
    this.status = reason;
    if (reason === 'control_lost') this.stats.controlLost++;
    this.pending = null;
    this.pendingResume = null;
    this.js.pending = null;
    this.log(reason === 'control_lost' ? '感知失去控制权（mine=false / CONTROL_LOST），立即停写且不自动抢权' : '居民已不在城内，停止写入');
  }

  private async waitPassive(): Promise<void> {
    // 严禁在 control_lost 状态下自动调 claim_control，仅静默等待外部宿主显式 resume() 或 stop()
    await new Promise<void>((resolve) => {
      if (this.stopped) return resolve();
      this.resumeWaiters.push(resolve);
    });
  }

  private async checkControl(): Promise<void> {
    this.verifyControl = false;
    const v = await this.city.view({ signal: this.ac.signal });
    this.adoptView(v);
    if (!v.control.mine) {
      this.setPassive('control_lost');
    }
  }

  // ── 触发与 3s–10s 短窗合并 ──

  private addTrigger(type: string, cls: EventClass): void {
    if (cls === 'ignore') return;
    const now = this.clock.now();
    const p = (this.pending ??= {
      triggers: new Set(),
      urgentAt: null,
      firstNormalAt: null,
      lastNormalAt: null,
    });
    p.triggers.add(type);
    if (cls === 'urgent') {
      p.urgentAt ??= now;
    } else {
      p.firstNormalAt ??= now;
      p.lastNormalAt = now;
    }
    this.blockedCounted = false;
  }

  private readyAt(): number {
    const p = this.pending;
    if (!p) return Number.POSITIVE_INFINITY;
    let debounce = Number.POSITIVE_INFINITY;
    if (p.urgentAt !== null) {
      debounce = Math.min(debounce, p.urgentAt + this.t.urgentDebounceMs);
    }
    if (p.firstNormalAt !== null && p.lastNormalAt !== null) {
      debounce = Math.min(debounce, Math.min(p.lastNormalAt + this.t.debounceMs, p.firstNormalAt + this.t.debounceMaxMs));
    }
    return Math.max(debounce, this.lastDecisionAt + this.t.minIntervalMs, this.backoffUntil);
  }

  private planWait(): { seconds: number; sleepMs: number } {
    const maxSec = Math.max(0, Math.min(50, Math.floor(this.t.waitSeconds)));
    const now = this.clock.now();
    const seconds = this.inflight || this.pending ? Math.min(maxSec, 2) : maxSec;
    let nextMs = Number.POSITIVE_INFINITY;
    if (this.pending && !this.inflight) {
      nextMs = Math.min(nextMs, this.readyAt() - now);
    }
    if (!this.pending && !this.inflight && this.t.idleLeaveMs !== null && !this.inTransit) {
      nextMs = Math.min(nextMs, this.lastActivityAt + this.t.idleLeaveMs - now);
    }
    if (nextMs === Number.POSITIVE_INFINITY) return { seconds, sleepMs: 0 };
    if (nextMs >= 1000) return { seconds: Math.min(seconds, Math.floor(nextMs / 1000)), sleepMs: 0 };
    return { seconds: 0, sleepMs: Math.max(0, Math.ceil(nextMs)) };
  }

  private async ingest(res: CityWaitResult): Promise<void> {
    if (res.control && !res.control.mine) {
      this.setPassive('control_lost');
      await this.saveJournal();
      return;
    }
    if (res.resync) {
      this.stats.resyncs++;
      const v = await this.city.view({ resetCursor: true, signal: this.ac.signal });
      this.adoptView(v);
      this.cursor = v.cursor;
      if (!v.control.mine) {
        this.setPassive('control_lost');
      }
      await this.saveJournal();
      return;
    }
    this.cursor = res.cursor;
    for (const ev of res.events) {
      const key = eventKey(ev);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 600) {
        this.seen.delete(this.seen.values().next().value as string);
      }
      this.stats.events++;

      if (ev.type === 'control') {
        this.verifyControl = true;
        continue;
      }
      if (ev.type === 'you_arrived' || ev.type === 'trip_stopped') {
        this.inTransit = false;
      } else if (ev.type === 'trip_started' || ev.type === 'trip_progress') {
        this.inTransit = true;
      }

      const cls = this.t.classify(ev, { residentId: this.residentId });
      const isOwnChat = ev.type === 'chat' && (ev.mine === true || (ev.from as { id?: string } | undefined)?.id === this.residentId);
      if (!isOwnChat && ev.type !== 'trip_progress') {
        this.backlog.push(ev);
        if (this.backlog.length > this.t.backlogLimit) {
          this.backlog.splice(0, this.backlog.length - this.t.backlogLimit);
        }
      }
      if (cls !== 'ignore') {
        this.addTrigger(ev.type, cls);
        this.lastActivityAt = this.clock.now();
      }
    }
    if (res.present === false && this.status === 'running') {
      this.setPassive('away');
    }
    await this.saveJournal();
  }

  private async checkIdleLeave(): Promise<void> {
    if (this.t.idleLeaveMs === null || this.status !== 'running' || this.inflight || this.pending || this.inTransit) {
      return;
    }
    if (this.clock.now() - this.lastActivityAt >= this.t.idleLeaveMs) {
      this.log(`空闲满 ${this.t.idleLeaveMs}ms，主动调用 leave_world 离城休息`);
      try {
        await this.city.leaveWorld({ signal: this.ac.signal });
      } catch (e) {
        this.log(`空闲离城失败：${errText(e)}`);
      }
      this.status = 'left';
    }
  }

  // ── 决策执行与恢复 ──

  private async maybeStartDecision(): Promise<void> {
    if (this.stopped || this.status !== 'running' || this.inflight) return;
    if (this.pendingResume) {
      await this.tryResumePending();
      return;
    }
    const now = this.clock.now();
    const p = this.pending;
    if (!p || now < this.readyAt()) return;

    if (!this.canSpendBudget(now)) {
      this.budgetExhausted = true;
      if (!this.blockedCounted) {
        this.stats.budgetBlocked++;
        this.blockedCounted = true;
        this.log(`budget_exhausted：调用预算耗尽，跳过唤醒（在途行程照常推进）`);
      }
      this.pending = null;
      if (this.t.leaveOnBudgetExhausted && !this.inTransit) {
        try {
          await this.city.leaveWorld({ signal: this.ac.signal });
          this.status = 'left';
        } catch (e) {
          this.log(`预算耗尽主动离城失败：${errText(e)}`);
        }
      }
      return;
    }

    this.pending = null;
    const snapshot = p;
    this.inflight = this.decideOnce(snapshot)
      .catch((e) => this.log(`决策异常：${errText(e)}`))
      .finally(() => {
        this.inflight = null;
      });
    await this.inflight;
  }

  private async decideOnce(p: PendingBatch): Promise<void> {
    const triggers = [...p.triggers];
    let release: (() => void) | null = null;
    const decisionId = `cd-${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const ctrl = new AbortController();
    const onStop = () => ctrl.abort();
    this.ac.signal.addEventListener('abort', onStop, { once: true });

    let decision: CityDecision | null = null;
    let view: CityView | null = null;
    let events: CityEvent[] = [];
    let outcome: CityMemorySaveEntry['outcome'] = 'noop';
    let error: string | undefined;
    const results: CityActResult[] = [];
    let modelCalled = false;

    try {
      release = await this.sem.acquire(this.ac.signal);
      view = await this.city.view({ signal: this.ac.signal });
      this.adoptView(view);

      if (!view.control.mine) {
        this.setPassive('control_lost');
        outcome = 'control_lost';
        return;
      }

      // 在途电车/步行期间外部 Bot 无法做任何动作（can 为空）：不白耗模型调用，等 you_arrived 再决策
      if (this.inTransit && view.can.length === 0) {
        this.stats.skipped++;
        return;
      }

      const startedAt = this.clock.now();
      if (!this.tryConsumeBudget(startedAt)) {
        this.stats.budgetBlocked++;
        return;
      }

      this.lastDecisionAt = startedAt;
      this.stats.decisions++;
      modelCalled = true;
      events = this.backlog.splice(0);

      let memory: unknown;
      try {
        memory = await this.spec.memory?.load?.({ residentId: this.residentId, view, events });
      } catch (e) {
        this.log(`读取记忆失败（已忽略）：${errText(e)}`);
      }
      await this.saveJournal();

      const ctx: CityDecisionContext = {
        decisionId,
        residentId: this.residentId,
        name: this.name,
        triggers,
        view,
        events,
        budget: this.budget(),
        memory,
        signal: ctrl.signal,
      };

      try {
        decision = await this.withTimeout(this.spec.decide(ctx), this.t.decideTimeoutMs, ctrl);
        this.failStreak = 0;
      } catch (e) {
        if (this.stopped) return;
        const timedOut = e instanceof DecideTimeout;
        this.stats.failures++;
        if (timedOut) this.stats.timeouts++;
        this.failStreak++;
        this.backoffUntil =
          this.clock.now() + Math.min(this.t.failureBackoffMaxMs, this.t.failureBackoffBaseMs * 2 ** (this.failStreak - 1));
        outcome = timedOut ? 'timeout' : 'failed';
        error = errText(e);
        this.log(`决策${timedOut ? '超时' : '失败'}：${error}`);
        return;
      } finally {
        release?.();
        release = null;
      }

      const rawActions = decision?.actions ?? [];
      const wantLeave = Boolean(decision?.leave) || rawActions.some((a) => a.type === 'leave_world');
      const filteredActions = rawActions.filter((a) => a.type !== 'leave_world').slice(0, this.t.maxActionsPerDecision);

      if (filteredActions.length === 0 && !wantLeave) {
        this.stats.noops++;
        outcome = 'noop';
        return;
      }

      if (filteredActions.length > 0) {
        const pending: CityPendingDecision = {
          decisionId,
          actions: filteredActions,
          ...(wantLeave ? { leave: true } : {}),
          done: 0,
          createdAt: this.clock.now(),
        };
        this.js.pending = pending;
        await this.saveJournal();
        const execRes = await this.execute(pending, view, results);
        outcome = execRes.outcome;
        error = execRes.error;
        if (outcome !== 'executed') return;
      }

      if (wantLeave && this.status === 'running') {
        await this.city.leaveWorld({ signal: this.ac.signal });
        this.status = 'left';
        outcome = 'executed';
      }
    } catch (e) {
      if (this.stopped || isAbort(e)) return;
      const ce = toCityError(e, 'decide');
      if (ce instanceof CityClientError && ce.code === 'control_lost') {
        this.setPassive('control_lost');
        outcome = 'control_lost';
        return;
      }
      outcome = 'failed';
      error = errText(ce);
      this.stats.failures++;
      this.log(`执行流程错误：${error}`);
    } finally {
      release?.();
      this.ac.signal.removeEventListener('abort', onStop);
      if (modelCalled && this.spec.memory?.save) {
        try {
          await this.spec.memory.save({
            residentId: this.residentId,
            decisionId,
            at: this.clock.now(),
            triggers,
            events,
            decision,
            outcome,
            results,
            ...(error ? { error } : {}),
          });
        } catch (e) {
          this.log(`保存记忆失败（已忽略）：${errText(e)}`);
        }
      }
    }
  }

  private async execute(
    pending: CityPendingDecision,
    firstView: CityView,
    results: CityActResult[],
  ): Promise<{ outcome: CityMemorySaveEntry['outcome']; error?: string }> {
    let view = firstView;
    const startIdx = pending.done;
    for (let i = startIdx; i < pending.actions.length; i++) {
      if (this.stopped) return { outcome: 'partial', error: 'stopped' };
      if (i > startIdx) {
        view = await this.city.view({ signal: this.ac.signal });
        this.adoptView(view);
        if (!view.control.mine) {
          this.setPassive('control_lost');
          return { outcome: 'control_lost', error: 'control_lost' };
        }
        if (this.inTransit && view.can.length === 0) {
          // 前一步已触发乘车出发，后续现场动作不再适用，安全收口
          this.js.pending = null;
          await this.saveJournal();
          return { outcome: 'executed' };
        }
      }

      const action = pending.actions[i]!;
      const requestId = `${pending.decisionId}-${i}`;
      try {
        const res = await this.city.act(action, {
          requestId,
          actionWindow: view.action_window,
          contextVersion: view.context.version,
          signal: this.ac.signal,
        });
        results.push(res);
        this.stats.actions++;
        if (action.type === 'travel') {
          this.inTransit = true;
        }
        pending.done = i + 1;
        this.js.pending = pending;
        await this.saveJournal();
      } catch (rawErr) {
        const e = toCityError(rawErr, 'world_act', requestId);
        if (e instanceof CityClientError && e.code === 'control_lost') {
          this.setPassive('control_lost');
          await this.saveJournal();
          return { outcome: 'control_lost', error: 'control_lost' };
        }
        if (isCityDiscardError(e)) {
          this.stats.discarded++;
          this.js.pending = null;
          await this.saveJournal();
          return { outcome: 'discarded', error: (e as CityClientError).code };
        }
        // 网络或临时不可用：保留 pending 供重连后用同一 requestId 幂等续跑
        this.pendingResume = pending;
        this.stats.failures++;
        return { outcome: 'partial', error: errText(e) };
      }
    }
    this.js.pending = null;
    await this.saveJournal();
    return { outcome: 'executed' };
  }

  private async tryResumePending(): Promise<void> {
    const pending = this.pendingResume;
    if (!pending || this.inflight || this.status !== 'running') return;
    this.pendingResume = null;
    if (this.clock.now() - pending.createdAt > this.t.maxResumeAgeMs) {
      this.stats.discarded++;
      this.js.pending = null;
      await this.saveJournal();
      return;
    }
    const view = await this.city.view({ signal: this.ac.signal });
    this.adoptView(view);
    if (!view.control.mine) {
      this.setPassive('control_lost');
      return;
    }
    const results: CityActResult[] = [];
    const r = await this.execute(pending, view, results);
    if (r.outcome === 'executed' && pending.leave && this.status === 'running') {
      await this.city.leaveWorld({ signal: this.ac.signal });
      this.status = 'left';
    }
  }

  private async recover(e: unknown): Promise<void> {
    const ce = toCityError(e, 'world_wait');
    if (ce instanceof CityClientError) {
      if (ce.code === 'control_lost') {
        this.setPassive('control_lost');
        return;
      }
      if (ce.code === 'entry_via_home_only' || ce.code === 'forbidden') {
        throw ce;
      }
      if (ce.code === 'unauthenticated') {
        try {
          const r = await this.city.enterWorld({ ...this.spec.profile, claim: false });
          this.adoptView(r);
          if (!r.control.mine) this.setPassive('control_lost');
          return;
        } catch (e2) {
          const ce2 = toCityError(e2, 'enter_world');
          if (isFatalCityEnterError(ce2)) throw ce2;
        }
      }
      if (ce.code === 'recovering' || ce.code === 'rate_limited') {
        const retryMs = typeof ce.data.retryAfterMs === 'number' ? ce.data.retryAfterMs : 2_000;
        await this.sleepQuiet(Math.max(500, retryMs));
        return;
      }
    }

    this.stats.reconnects++;
    const wait = Math.min(this.t.reconnectMaxMs, this.t.reconnectBaseMs * 2 ** Math.min(this.netFails, 16));
    this.netFails++;
    this.log(`连接中断（${errText(ce)}），${wait}ms 后重连`);
    await this.sleepQuiet(wait);
    if (this.stopped) return;

    if (this.spec.reconnect) {
      try {
        const next = await this.spec.reconnect();
        const prev = this.city;
        this.city = next;
        void prev.close?.()?.catch?.(() => undefined);
        const entered = await this.city.enterWorld({ ...this.spec.profile, claim: false });
        this.adoptView(entered);
        if (!entered.control.mine) this.setPassive('control_lost');
        return;
      } catch (e2) {
        const ce2 = toCityError(e2, 'enter_world');
        if (isFatalCityEnterError(ce2)) throw ce2;
        return;
      }
    }

    try {
      const v = await this.city.view({ signal: this.ac.signal });
      this.adoptView(v);
      if (!v.control.mine) this.setPassive('control_lost');
    } catch (e3) {
      const ce3 = toCityError(e3, 'get_my_view');
      if (ce3 instanceof CityClientError && ce3.code === 'unauthenticated') {
        const r = await this.city.enterWorld({ ...this.spec.profile, claim: false });
        this.adoptView(r);
        if (!r.control.mine) this.setPassive('control_lost');
      }
    }
  }

  private async saveJournal(): Promise<void> {
    this.js.cursor = this.cursor;
    this.js.seen = [...this.seen].slice(-500);
    try {
      await this.journal.save(this.js);
    } catch (e) {
      this.log(`保存运行日志失败：${errText(e)}`);
    }
  }

  private async sleepQuiet(ms: number): Promise<void> {
    try {
      await this.clock.sleep(ms, this.ac.signal);
    } catch (e) {
      if (!isAbort(e)) throw e;
    }
  }

  private withTimeout<T>(p: Promise<T> | T, ms: number, ctrl: AbortController): Promise<T> {
    const timerAc = new AbortController();
    const timeout = this.clock.sleep(ms, timerAc.signal).then<never>(() => {
      ctrl.abort();
      throw new DecideTimeout(`决策超过 ${ms}ms 未返回`);
    });
    let onStop: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onStop = () => reject(new DOMException('aborted', 'AbortError'));
      if (this.ac.signal.aborted) onStop();
      else this.ac.signal.addEventListener('abort', onStop, { once: true });
    });
    return Promise.race([Promise.resolve(p), timeout, stopped]).finally(() => {
      timerAc.abort();
      this.ac.signal.removeEventListener('abort', onStop);
    });
  }
}
