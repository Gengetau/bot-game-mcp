/**
 * AI 居民运行器：让一个（或多个）AI 作为居民长期住在栖灯镇。
 *
 * 运行器自己不调任何模型：决策函数 decide(ctx) 由调用方注入（里面想调哪家模型都行）。运行器负责：
 *  - 事件驱动：world_wait 长轮询；没有值得反应的事件就不调用 decide；按事件重要性去抖（见 defaultClassify）；
 *  - 预算：每居民每小时调用次数（滑动窗口，默认 30）、两次决策最小间隔（8 秒）、全运行器并发上限（4）；
 *  - 决策去重：一次决策 = 一个 decisionId，每一步动作的请求号由它稳定派生，网络失败重试不会重复执行；
 *    决策期间世界变了（context_stale / phase_stale / precondition_failed …）就丢弃，不盲目重试；
 *  - 小游戏：进入小游戏后只在「轮到我」时决策；阶段超时前没决策出来就放弃，让引擎托管，不抢答；
 *  - 走路：navigate 被接受后，运行器用普通程序（不经过模型）按 renewEveryMs 续导航控制租约，直到到了 / 被截住 / 停下；
 *    续租出错（网络抖动）下个周期再试，连续失败由租约自然到期兜底；
 *  - 在场：等待本身续在场；被别的客户端接管（control_lost）后停止一切写入，可选自动接管；
 *    断线指数退避重连并用游标续传，resync 时重读视图；
 *  - 模型出错 / 超时只记一次失败，退避后再试，不影响在场。
 *
 * 叙述记忆不在服务端：memory 钩子由调用方实现，运行器只在决策前后各调用一次。
 * 时钟与等待函数可注入（clock），测试可以用假时钟。
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDiscardError, toTownError, TownError, type ActOptions, type ActResult, type EnterProfile, type EnterResult, type NavigationBrief, type NavigationRenewal, type TownAction, type TownEvent, type TownView, type WaitOptions, type WaitResult } from './town.js';

// ───────────────────────── 接口 ─────────────────────────

/** 运行器需要的小镇端口（TownClient 满足；测试里可以换成假的）。 */
export interface TownPort {
  enter(profile?: EnterProfile): Promise<EnterResult>;
  view(opts?: { resetCursor?: boolean; signal?: AbortSignal }): Promise<TownView>;
  wait(opts?: WaitOptions): Promise<WaitResult>;
  act(action: TownAction, opts?: ActOptions): Promise<ActResult>;
  heartbeat(): Promise<unknown>;
  /** 续导航控制租约（走路时运行器定时调，不经过模型）。没有这个方法的端口不续租 */
  renewNavigation?(nav: { navigationId: string; revision: number }, opts?: { signal?: AbortSignal }): Promise<NavigationRenewal>;
  /** 停下正在走的路（运行器正常退出时用） */
  stopNavigation?(opts?: ActOptions): Promise<unknown>;
  claim(): Promise<unknown>;
  leave(): Promise<unknown>;
  close?(): Promise<void>;
}

export interface RunnerClock {
  now(): number;
  /** 等 ms 毫秒；signal 取消时 reject（AbortError） */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: RunnerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** 事件的重要性：urgent 立刻（只受最小间隔和预算约束），normal 合并窗口去抖，ignore 不触发决策（但会记进 events）。 */
export type EventClass = 'urgent' | 'normal' | 'ignore';

export interface ClassifyContext {
  residentId: string;
  mode: 'world' | 'game';
}

/**
 * 默认的事件归类（设计文档第 12 节：普通聊天事件合并窗口 3 秒、最长 10 秒；有截止时间的小游戏优先）：
 *  - urgent：轮到我的小游戏（game.yourTurn）、进了一局（game_started）、别人发给我的报价、收到邀请、被问爱好；
 *  - normal：聊天、公屏上提到我（town_chat_mention）、有人来 / 走、我到了、来信、共同活动、愿望、凑桌、一局结束 / 我出局、别的报价状态变化、程序提示；
 *  - ignore：presence、control（运行器自己处理）、别人的 game 进展（不是轮到我）、我自己的发言，以及不认识的类型。
 * 小游戏里（mode = game）只有轮到我才触发，其余世界事件一律忽略。
 */
export function defaultClassify(ev: TownEvent, c: ClassifyContext): EventClass {
  const inGame = c.mode === 'game';
  switch (ev.type) {
    case 'game':
      return ev.yourTurn === true ? 'urgent' : 'ignore';
    case 'game_started':
      return 'urgent';
    case 'game_ended':
    case 'game_out':
      return 'normal';
    case 'chat': {
      const from = ev.from as { id?: string; kind?: string } | undefined;
      if (from?.id === c.residentId) return 'ignore';
      // NPC 的话（程序台词，只在有人 ask_npc 时说）进上下文，但不触发思考：免得 AI 和 NPC 来回自动接话
      if (from?.kind === 'npc') return 'ignore';
      return inGame ? 'ignore' : 'normal';
    }
    case 'town_chat_mention':
      // 公屏上明确提到我 / 和我有约定的人说话：普通事件，对局中不触发
      return inGame ? 'ignore' : 'normal';
    case 'offer': {
      if (inGame) return 'ignore';
      const o = ev.offer as { from?: { id?: string }; to?: { id?: string } } | undefined;
      return o?.to?.id === c.residentId && o?.from?.id !== c.residentId ? 'urgent' : 'normal';
    }
    case 'invite':
    case 'asked_hobby':
      return inGame ? 'ignore' : 'urgent';
    case 'you_arrived':
    case 'nav_stopped':
    case 'arrived':
    case 'left':
    case 'mail':
    case 'interaction':
    case 'interaction_done':
    case 'goal':
    case 'activity':
    case 'notice':
      return inGame ? 'ignore' : 'normal';
    default:
      return 'ignore';
  }
}

/** 一次决策的上下文。 */
export interface DecisionContext {
  /** 这次决策的稳定编号；每一步动作的 request_id 由它派生 */
  decisionId: string;
  residentId: string;
  name: string;
  /** world = 普通生活；game = 在小游戏里（只在轮到我时决策） */
  mode: 'world' | 'game';
  /** 触发原因：事件类型，外加 start（刚进镇）/ resume（接管后恢复）/ idle（空闲定时） */
  triggers: string[];
  /** 决策前刚读到的紧凑视图（动作按这份视图提交） */
  view: TownView;
  /** 自上次决策以来收到的事件（已按事件去重，含不触发决策的类型；不含我自己的发言） */
  events: TownEvent[];
  /** 剩余预算 */
  budget: { remaining: number; limit: number; resetsInMs: number };
  /** memory.load 返回的叙述记忆（调用方自己的格式） */
  memory: unknown;
  /** 小游戏：这一手必须在这个时刻（毫秒时间戳）之前决策完，过了就作废 */
  deadlineAt: number | null;
  /** 超时 / 停止时取消 */
  signal: AbortSignal;
}

/** 决策：要依次执行的动作（最多 5 步），note 只交给 memory.save。 */
export interface Decision {
  actions: TownAction[];
  note?: string;
}

export type DecideFn = (ctx: DecisionContext) => Promise<Decision | null> | Decision | null;

export interface MemorySaveEntry {
  residentId: string;
  decisionId: string;
  at: number;
  triggers: string[];
  events: TownEvent[];
  decision: Decision | null;
  outcome: 'executed' | 'noop' | 'discarded' | 'failed' | 'timeout' | 'partial';
  results: ActResult[];
  error?: string;
}

/** 叙述记忆钩子：运行器只在决策前后调用，不保存任何东西。 */
export interface ResidentMemory {
  load?(info: { residentId: string; view: TownView; events: TownEvent[] }): Promise<unknown> | unknown;
  save?(entry: MemorySaveEntry): Promise<void> | void;
}

export interface PendingDecision {
  decisionId: string;
  actions: TownAction[];
  /** 已经完成的步数 */
  done: number;
  /** 决策时的上下文版本（恢复时用来判断世界是否变了） */
  contextVersion: number;
  createdAt: number;
}

export interface JournalState {
  /** wait 的游标（处理完一批事件后保存） */
  cursor: string | null;
  /** 最近处理过的事件指纹（重放去重） */
  seen: string[];
  /** 最近一小时每次模型调用的时刻（预算的滑动窗口，跨重启保留） */
  calls: number[];
  /** 自动接管的时刻 */
  claims: number[];
  /** 执行到一半的决策（崩溃后恢复；用同样的请求号重放，服务器保证只做一次） */
  pending: PendingDecision | null;
}

/** 运行器自己的小账本（游标、预算、没做完的决策）。默认放内存；要跨重启就实现它存到磁盘 / 数据库。 */
export interface ResidentJournal {
  load(): Promise<JournalState | null> | JournalState | null;
  save(state: JournalState): Promise<void> | void;
}

export class InMemoryJournal implements ResidentJournal {
  state: JournalState | null = null;
  load() {
    return this.state ? structuredClone(this.state) : null;
  }
  save(state: JournalState) {
    this.state = structuredClone(state);
  }
}

/** 一个居民的调参（默认值取自设计文档第 12 / 14 节）。 */
export interface ResidentTuning {
  /** 每小时最多调用决策函数几次（滑动窗口），默认 30 */
  budgetPerHour: number;
  /** 两次决策（开始时刻）的最小间隔，默认 8000 */
  minIntervalMs: number;
  /** 普通事件的合并窗口：安静这么久才决策，默认 3000 */
  debounceMs: number;
  /** 普通事件最长等多久（从第一个事件算起），默认 10000 */
  debounceMaxMs: number;
  /** 紧急事件的去抖，默认 0（立刻，仍受最小间隔和预算约束） */
  urgentDebounceMs: number;
  /** 每轮长轮询秒数（0~50），默认 25；必须小于在场宽限（默认 60 秒） */
  waitSeconds: number;
  /** 决策函数超时，默认 60000 */
  decideTimeoutMs: number;
  /** 恢复没做完的决策的年龄上限：创建超过这么久就作废（清日志、计入 discarded），不重放，默认 300000（5 分钟） */
  maxResumeAgeMs: number;
  /** 小游戏：留给提交的安全余量，默认 1500；剩余时间不够就不决策 */
  gameSafetyMarginMs: number;
  /** 决策失败后的退避（指数），默认 5000 起、最长 300000 */
  failureBackoffBaseMs: number;
  failureBackoffMaxMs: number;
  /** 断线重连的退避（指数），默认 1000 起、最长 30000 */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** 网络失败时同一个请求号最多重试几次，默认 3 */
  actRetries: number;
  actRetryBaseMs: number;
  /** 刚进镇时是否做一次决策（reason = start），默认 true */
  decideOnStart: boolean;
  /** 空闲策略：这么久没有任何值得反应的事件、也没有决策，就主动 leave（null = 不离开，默认） */
  idleLeaveMs: number | null;
  /** 空闲定时器：每隔这么久没有事件就触发一次决策（reason = idle），null = 关（默认）。仍受预算约束 */
  idleTickMs: number | null;
  /** 被别的客户端接管后是否自动 claim 回来，默认 false（不抢） */
  autoClaim: boolean;
  autoClaimDelayMs: number;
  /** 一小时内最多自动接管几次（防止和另一个客户端互相抢），默认 3 */
  autoClaimMaxPerHour: number;
  /** 一次决策里最多执行几步动作，默认 5 */
  maxActionsPerDecision: number;
  /** 两次决策之间最多攒多少条事件交给 decide，默认 100 */
  backlogLimit: number;
  /** 事件归类，默认 defaultClassify */
  classify: (ev: TownEvent, c: ClassifyContext) => EventClass;
}

export const DEFAULT_TUNING: ResidentTuning = {
  budgetPerHour: 30,
  minIntervalMs: 8_000,
  debounceMs: 3_000,
  debounceMaxMs: 10_000,
  urgentDebounceMs: 0,
  waitSeconds: 25,
  decideTimeoutMs: 60_000,
  maxResumeAgeMs: 300_000,
  gameSafetyMarginMs: 1_500,
  failureBackoffBaseMs: 5_000,
  failureBackoffMaxMs: 300_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  actRetries: 3,
  actRetryBaseMs: 500,
  decideOnStart: true,
  idleLeaveMs: null,
  idleTickMs: null,
  autoClaim: false,
  autoClaimDelayMs: 5_000,
  autoClaimMaxPerHour: 3,
  maxActionsPerDecision: 5,
  backlogLimit: 100,
  classify: defaultClassify,
};

export interface ResidentSpec extends Partial<ResidentTuning> {
  /** 日志里的名字，默认取 profile.name */
  label?: string;
  town: TownPort;
  /** 断线后重新建立连接（会话丢失、引擎重启）；不给就一直用 town 重试 */
  reconnect?: () => Promise<TownPort>;
  /** 第一次进入小镇用的资料（新居民必须有 name） */
  profile?: EnterProfile;
  decide: DecideFn;
  memory?: ResidentMemory;
  journal?: ResidentJournal;
}

export interface ResidentRunnerOptions extends Partial<ResidentTuning> {
  /** 全运行器同时进行的决策函数调用数，默认 4 */
  maxConcurrentDecisions?: number;
  clock?: RunnerClock;
  log?: (line: string) => void;
}

export interface ResidentStats {
  /** 调用决策函数的次数（含失败） */
  decisions: number;
  /** 被预算挡掉的决策次数 */
  budgetBlocked: number;
  /** 决策函数抛错 / 超时的次数 */
  failures: number;
  timeouts: number;
  /** 决策作废的次数（世界变了、规则不允许） */
  discarded: number;
  /** 成功提交的动作数 */
  actions: number;
  /** 决策函数返回 null（选择什么都不做）的次数 */
  noops: number;
  /** 触发了但视图显示已不需要决策（比如小游戏已经不是我的回合）而跳过的次数 */
  skipped: number;
  reconnects: number;
  controlLost: number;
  resyncs: number;
  /** 收到的（去重后的）事件数 */
  events: number;
}

export type ResidentStatus = 'starting' | 'running' | 'control_lost' | 'away' | 'left' | 'stopped';

export interface ResidentHandle {
  readonly label: string;
  readonly stats: ResidentStats;
  readonly status: ResidentStatus;
  /** 当前预算：剩余次数、限额、最早多久后恢复一次额度 */
  budget(): { remaining: number; limit: number; resetsInMs: number };
  /** 被接管 / 离开后恢复：claim（默认 true）并继续决策 */
  resume(opts?: { claim?: boolean }): Promise<void>;
  /** 只停这一个居民（不 leave） */
  stop(opts?: { leave?: boolean }): Promise<void>;
  /** 居民循环结束（stop / idleLeave）时 resolve；出现无法恢复的错误时 reject */
  readonly done: Promise<void>;
}

// ───────────────────────── 并发闸 ─────────────────────────

class Semaphore {
  private free: number;
  private readonly queue: { priority: number; seq: number; resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  private seq = 0;
  constructor(readonly limit: number) {
    this.free = limit;
  }
  /** priority 数字小的先走（小游戏回合 0，普通 1）。 */
  acquire(priority: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    if (this.free > 0) {
      this.free--;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const item = {
        priority,
        seq: this.seq++,
        resolve: () => resolve(this.releaser()),
        reject,
        signal,
        onAbort: undefined as (() => void) | undefined,
      };
      item.onAbort = () => {
        const i = this.queue.indexOf(item);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new DOMException('aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', item.onAbort, { once: true });
      this.queue.push(item);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }
  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve();
      } else this.free++;
    };
  }
  get inUse(): number {
    return this.limit - this.free;
  }
}

// ───────────────────────── 运行器 ─────────────────────────

const HOUR_MS = 3_600_000;
const emptyStats = (): ResidentStats => ({ decisions: 0, budgetBlocked: 0, failures: 0, timeouts: 0, discarded: 0, actions: 0, noops: 0, skipped: 0, reconnects: 0, controlLost: 0, resyncs: 0, events: 0 });
const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ResidentRunner {
  private readonly clock: RunnerClock;
  private readonly sem: Semaphore;
  private readonly log: (line: string) => void;
  private readonly defaults: ResidentTuning;
  private readonly residents = new Set<Resident>();
  private stopping = false;

  constructor(opts: ResidentRunnerOptions = {}) {
    const { maxConcurrentDecisions, clock, log, ...tuning } = opts;
    this.clock = clock ?? systemClock;
    this.sem = new Semaphore(Math.max(1, maxConcurrentDecisions ?? 4));
    this.log = log ?? (() => undefined);
    this.defaults = { ...DEFAULT_TUNING, ...stripUndefined(tuning) };
  }

  /** 让一位居民住进小镇并开始运行。同一个运行器可以带多个居民，共用决策并发上限。 */
  add(spec: ResidentSpec): ResidentHandle {
    if (this.stopping) throw new Error('运行器已经停止');
    const r = new Resident(spec, { ...this.defaults, ...stripUndefined(specTuning(spec)) }, this.clock, this.sem, this.log, () => this.residents.delete(r));
    this.residents.add(r);
    r.start();
    return r;
  }

  /** 当前同时进行的决策函数调用数（测试 / 监控用）。 */
  get decisionsInFlight(): number {
    return this.sem.inUse;
  }

  /** 全部居民的统计合计。 */
  get stats(): ResidentStats {
    const total = emptyStats();
    for (const r of this.residents) for (const k of Object.keys(total) as (keyof ResidentStats)[]) total[k] += r.stats[k];
    return total;
  }

  /** 停止所有居民并等它们干净退出（不 leave：居民留在原地，在场租约自然到期）。 */
  async stop(opts: { leave?: boolean } = {}): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.residents].map((r) => r.stop(opts)));
  }
}

function specTuning(spec: ResidentSpec): Partial<ResidentTuning> {
  const { label: _l, town: _t, reconnect: _r, profile: _p, decide: _d, memory: _m, journal: _j, ...rest } = spec;
  return rest;
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface Pending {
  triggers: Set<string>;
  urgentAt: number | null;
  firstNormalAt: number | null;
  lastNormalAt: number | null;
  /** 触发里有没有「轮到我的小游戏」（决策并发闸里优先） */
  gameTurn: boolean;
}

class Resident implements ResidentHandle {
  readonly label: string;
  readonly stats = emptyStats();
  status: ResidentStatus = 'starting';
  readonly done: Promise<void>;

  private town: TownPort;
  private readonly ac = new AbortController();
  private readonly journal: ResidentJournal;
  private js: JournalState = { cursor: null, seen: [], calls: [], claims: [], pending: null };
  private residentId = '';
  private name = '';
  private mode: 'world' | 'game' = 'world';
  private cursor: string | null = null;
  private ctxVersion: number | null = null;
  private pending: Pending | null = null;
  private backlog: TownEvent[] = [];
  private seen = new Set<string>();
  private inflight: Promise<void> | null = null;
  private lastDecisionAt = Number.NEGATIVE_INFINITY;
  private backoffUntil = 0;
  private failStreak = 0;
  private netFails = 0;
  private lastActivityAt = 0;
  private lastIdleTickAt = 0;
  private verifyControl = false;
  private blockedCounted = false;
  private resumeWaiters: (() => void)[] = [];
  private resolveDone!: () => void;
  private rejectDone!: (e: unknown) => void;
  private pendingResume: PendingDecision | null = null;
  private autoClaimClaimedAt = 0;
  /** 正在续租的那条导航（没有在走就是 null）。后台循环用 navAc 取消 */
  private nav: { navigationId: string; revision: number; everyMs: number } | null = null;
  private navAc: AbortController | null = null;

  constructor(
    private readonly spec: ResidentSpec,
    private readonly t: ResidentTuning,
    private readonly clock: RunnerClock,
    private readonly sem: Semaphore,
    private readonly runnerLog: (line: string) => void,
    private readonly onEnd: () => void,
  ) {
    this.town = spec.town;
    this.label = spec.label ?? spec.profile?.name ?? 'resident';
    this.journal = spec.journal ?? new InMemoryJournal();
    this.done = new Promise<void>((res, rej) => {
      this.resolveDone = res;
      this.rejectDone = rej;
    });
    this.done.catch(() => undefined);
  }

  private log(line: string): void {
    this.runnerLog(`[resident ${this.label}] ${line}`);
  }

  // ── 预算 ──

  private prune(now = this.clock.now()): number[] {
    this.js.calls = this.js.calls.filter((x) => now - x < HOUR_MS);
    return this.js.calls;
  }
  budget() {
    const now = this.clock.now();
    const calls = this.prune(now);
    return { remaining: Math.max(0, this.t.budgetPerHour - calls.length), limit: this.t.budgetPerHour, resetsInMs: calls.length ? Math.max(0, calls[0]! + HOUR_MS - now) : 0 };
  }

  // ── 生命周期 ──

  start(): void {
    void this.main().then(
      () => {
        this.stopRenewing();
        if (this.status !== 'left') this.status = 'stopped';
        this.onEnd();
        this.resolveDone();
      },
      (e) => {
        this.stopRenewing();
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
        await this.town.leave();
        this.status = 'left';
      } catch (e) {
        this.log(`离开小镇失败：${errText(e)}`);
      }
    } else if (this.nav && this.status === 'running') {
      // 不 leave 就退出：别让居民带着一条没人续的路站在半路，先停步
      try {
        await this.town.stopNavigation?.();
      } catch (e) {
        this.log(`退出前停步失败（租约到期后会自己停）：${errText(e)}`);
      }
    }
    this.stopRenewing();
    this.ac.abort();
    for (const w of this.resumeWaiters.splice(0)) w();
    await this.done.catch(() => undefined);
  }

  async resume(opts: { claim?: boolean } = {}): Promise<void> {
    if (this.status !== 'control_lost' && this.status !== 'away') return;
    if (opts.claim !== false) await this.town.claim();
    this.status = 'running';
    this.pending = null;
    this.addTrigger('resume', 'urgent');
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  private get stopped(): boolean {
    return this.ac.signal.aborted;
  }

  // ── 主循环 ──

  private async main(): Promise<void> {
    await this.bootstrap();
    while (!this.stopped) {
      if (this.status === 'control_lost' || this.status === 'away') {
        await this.passive();
        continue;
      }
      if (this.status === 'left') return;
      this.maybeStart();
      const plan = this.plan();
      try {
        if (plan.sleepMs > 0) await this.clock.sleep(plan.sleepMs, this.ac.signal);
        const res = await this.town.wait({ cursor: this.cursor ?? undefined, waitSeconds: plan.seconds, contextVersion: this.ctxVersion ?? undefined, signal: this.ac.signal });
        this.netFails = 0;
        await this.ingest(res);
        if (this.verifyControl) await this.checkControl();
        this.checkIdle();
        if ((this.status as ResidentStatus) === 'left') return;
      } catch (e) {
        if (this.stopped || isAbort(e)) break;
        await this.recover(e);
      }
    }
    await this.inflight?.catch(() => undefined);
  }

  private async bootstrap(): Promise<void> {
    const saved = await this.journal.load();
    if (saved) this.js = { cursor: saved.cursor ?? null, seen: saved.seen ?? [], calls: saved.calls ?? [], claims: saved.claims ?? [], pending: saved.pending ?? null };
    for (const k of this.js.seen) this.seen.add(k);
    let entered: EnterResult | null = null;
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        const r = await this.town.enter(this.spec.profile);
        entered = r;
        this.adopt(r, true);
        this.residentId = r.resident_id ?? r.me.id;
        this.name = r.me.name;
        // 有保存的游标就从那里续传（服务器会在游标失效时要求 resync）；没有就从进来这一刻开始
        this.cursor = this.js.cursor ?? r.cursor;
        break;
      } catch (e) {
        if (this.stopped || isAbort(e)) return;
        if (e instanceof TownError && (e.code === 'town_disabled' || e.code === 'bad_request' || e.code === 'forbidden')) throw e;
        this.stats.reconnects++;
        const wait = Math.min(this.t.reconnectMaxMs, this.t.reconnectBaseMs * 2 ** Math.min(attempt, 16));
        this.log(`进入小镇失败（${errText(e)}），${wait} 毫秒后重试`);
        await this.sleepQuiet(wait);
      }
    }
    if (this.stopped) return;
    this.status = 'running';
    // 重启时居民还在路上：接着续租
    const walking = entered?.location?.walking;
    if (walking?.navigation_id) this.startRenewing({ navigationId: walking.navigation_id, revision: walking.revision, ...(walking.renew_every_ms ? { renewEveryMs: walking.renew_every_ms } : {}) }, true);
    this.lastActivityAt = this.lastIdleTickAt = this.clock.now();
    if (this.js.pending && this.js.pending.done < this.js.pending.actions.length) {
      if (this.resumeTooOld(this.js.pending)) {
        this.log('日志里没做完的决策已过期，作废不重放');
        this.stats.discarded++;
        this.js.pending = null;
      } else this.pendingResume = this.js.pending;
    } else if (this.js.pending) this.js.pending = null;
    if (this.t.decideOnStart || this.pendingResume) this.addTrigger('start', 'urgent');
    await this.saveJournal();
  }

  private adopt(v: TownView, initial = false): void {
    this.ctxVersion = v.context?.version ?? this.ctxVersion;
    this.mode = v.context?.activityId ? 'game' : 'world';
    if (initial) this.residentId = v.me?.id ?? this.residentId;
    const w = v.location?.walking;
    if (w?.navigation_id) this.startRenewing({ navigationId: w.navigation_id, revision: w.revision, ...(w.renew_every_ms ? { renewEveryMs: w.renew_every_ms } : {}) }, true);
  }

  // ── 导航续租（普通程序，不调用模型） ──

  /** 开始（或改道后换成新的一条）续租。同一条（编号 + 版本都一样）不重复起。 */
  private startRenewing(nav: NavigationBrief, fromView = false): void {
    if (this.stopped || this.status !== 'running' || !this.town.renewNavigation) return;
    const everyMs = Math.max(200, nav.renewEveryMs ?? this.nav?.everyMs ?? 3_000);
    if (this.nav && this.navAc && this.nav.navigationId === nav.navigationId) {
      this.nav.revision = nav.revision;
      this.nav.everyMs = everyMs;
      return;
    }
    this.stopRenewing();
    this.nav = { navigationId: nav.navigationId, revision: nav.revision, everyMs };
    const ac = (this.navAc = new AbortController());
    const onStop = () => ac.abort();
    this.ac.signal.addEventListener('abort', onStop, { once: true });
    // 从视图里发现「已经在走」（运行器重启、接管、重连）：不知道租约还剩多久，先立刻续一次；
    // 刚被接受的 navigate 带着满的租约，等一个周期再续
    void this.renewLoop(ac.signal, fromView).finally(() => {
      this.ac.signal.removeEventListener('abort', onStop);
      if (this.navAc === ac) {
        this.navAc = null;
        this.nav = null;
      }
    });
  }

  private stopRenewing(): void {
    this.navAc?.abort();
    this.navAc = null;
    this.nav = null;
  }

  private async renewLoop(signal: AbortSignal, immediate = false): Promise<void> {
    let skipWait = immediate;
    while (!signal.aborted) {
      const cur = this.nav;
      if (!cur) return;
      if (skipWait) {
        skipWait = false;
        // 让出一拍：调用方（读视图、进镇）先把自己的事做完
        await Promise.resolve();
      } else {
        try {
          await this.clock.sleep(cur.everyMs, signal);
        } catch {
          return;
        }
      }
      const n = this.nav;
      if (signal.aborted || !n || !this.town.renewNavigation) return;
      try {
        const r = await this.town.renewNavigation({ navigationId: n.navigationId, revision: n.revision }, { signal });
        if (signal.aborted) return;
        if (!r.navigation) return; // 已经没有在走的路（到了 / 被截住 / 停下）
        if (!r.ok && r.navigation.navigationId === n.navigationId && r.navigation.revision === n.revision) return;
        // 改道或者版本前进：以服务器说的现在这条为准
        this.nav = { navigationId: r.navigation.navigationId, revision: r.navigation.revision, everyMs: Math.max(200, r.navigation.renewEveryMs ?? n.everyMs) };
      } catch (e) {
        if (signal.aborted || isAbort(e)) return;
        const te = toTownError(e, 'heartbeat');
        if (te instanceof TownError && (te.code === 'control_lost' || te.code === 'unauthenticated')) {
          this.log(`导航续租停止：${te.code}`);
          return;
        }
        // 网络抖动等：下个周期再试，连续失败由租约自然到期兜底
        this.log(`导航续租出错（下个周期再试）：${errText(e)}`);
      }
    }
  }

  private async saveJournal(): Promise<void> {
    this.js.cursor = this.cursor;
    this.js.seen = [...this.seen].slice(-500);
    try {
      await this.journal.save(this.js);
    } catch (e) {
      this.log(`保存运行记录失败：${errText(e)}`);
    }
  }

  private async sleepQuiet(ms: number): Promise<void> {
    try {
      await this.clock.sleep(ms, this.ac.signal);
    } catch (e) {
      if (!isAbort(e)) throw e;
    }
  }

  // ── 触发与去抖 ──

  private addTrigger(type: string, cls: EventClass): void {
    if (cls === 'ignore') return;
    const now = this.clock.now();
    const p = (this.pending ??= { triggers: new Set(), urgentAt: null, firstNormalAt: null, lastNormalAt: null, gameTurn: false });
    p.triggers.add(type);
    if (cls === 'urgent') {
      p.urgentAt ??= now;
      if (this.mode === 'game' && type === 'game') p.gameTurn = true;
    } else {
      p.firstNormalAt ??= now;
      p.lastNormalAt = now;
    }
    this.blockedCounted = false;
  }

  /** 触发已经攒够、可以决策的时刻；没有触发返回 Infinity。 */
  private readyAt(): number {
    const p = this.pending;
    if (!p) return Number.POSITIVE_INFINITY;
    let debounce = Number.POSITIVE_INFINITY;
    if (p.urgentAt !== null) debounce = Math.min(debounce, p.urgentAt + this.t.urgentDebounceMs);
    if (p.firstNormalAt !== null && p.lastNormalAt !== null) debounce = Math.min(debounce, Math.min(p.lastNormalAt + this.t.debounceMs, p.firstNormalAt + this.t.debounceMaxMs));
    return Math.max(debounce, this.lastDecisionAt + this.t.minIntervalMs, this.backoffUntil);
  }

  /** 下一轮怎么等：长轮询多少秒；差不到 1 秒的先本地睡一下再取。 */
  private plan(): { seconds: number; sleepMs: number } {
    const max = Math.max(0, Math.min(50, Math.floor(this.t.waitSeconds)));
    const now = this.clock.now();
    // 有决策在跑 / 有触发在等：别等满，免得决策结束后迟迟不处理
    let seconds = this.inflight || this.pending ? Math.min(max, 2) : max;
    // 下一个需要醒来的时刻（只算现在真的能行动的）
    let nextMs = Number.POSITIVE_INFINITY;
    if (this.pending && !this.inflight) nextMs = Math.min(nextMs, this.readyAt() - now);
    if (!this.pending && !this.inflight) {
      if (this.t.idleTickMs !== null) nextMs = Math.min(nextMs, this.lastIdleTickAt + this.t.idleTickMs - now);
      if (this.t.idleLeaveMs !== null) nextMs = Math.min(nextMs, this.lastActivityAt + this.t.idleLeaveMs - now);
    }
    if (nextMs === Number.POSITIVE_INFINITY) return { seconds, sleepMs: 0 };
    if (nextMs >= 1000) return { seconds: Math.min(seconds, Math.floor(nextMs / 1000)), sleepMs: 0 };
    return { seconds: 0, sleepMs: Math.max(0, Math.ceil(nextMs)) };
  }

  private maybeStart(): void {
    if (this.stopped || this.status !== 'running' || this.inflight) return;
    if (this.pendingResume) {
      void this.tryResumePending();
      return;
    }
    const now = this.clock.now();
    if (this.t.idleTickMs !== null && !this.pending && now - this.lastIdleTickAt >= this.t.idleTickMs) {
      this.lastIdleTickAt = now;
      this.addTrigger('idle', 'normal');
    }
    const p = this.pending;
    if (!p || now < this.readyAt()) return;
    if (this.budget().remaining <= 0) {
      // 预算用完：只保持在场、不决策。触发作废（事件仍留在 backlog）
      if (!this.blockedCounted) {
        this.stats.budgetBlocked++;
        this.blockedCounted = true;
        this.log(`预算用完（${this.t.budgetPerHour} 次/小时），${p.triggers.size ? [...p.triggers].join(',') : ''} 的决策被挡掉`);
      }
      this.pending = null;
      return;
    }
    this.pending = null;
    const snapshot = p;
    this.inflight = this.decideOnce(snapshot).catch((e) => this.log(`决策流程异常：${errText(e)}`)).finally(() => {
      this.inflight = null;
    });
  }

  // ── 收事件 ──

  private async ingest(res: WaitResult): Promise<void> {
    if (res.context) {
      this.ctxVersion = res.context.version;
      this.mode = res.context.activityId ? 'game' : 'world';
    }
    if (res.resync) {
      // 游标失效：重读视图并对齐游标。丢掉的事件不补，决策基于当前视图
      this.stats.resyncs++;
      const v = await this.town.view({ resetCursor: true });
      this.adopt(v);
      this.cursor = v.cursor;
      this.log('游标失效，已重读视图');
      await this.saveJournal();
      return;
    }
    this.cursor = res.cursor;
    for (const ev of res.events) {
      const key = eventKey(ev);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (this.seen.size > 600) this.seen.delete(this.seen.values().next().value as string);
      this.stats.events++;
      if (ev.type === 'control') {
        this.verifyControl = true;
        continue;
      }
      if (ev.type === 'you_arrived' || ev.type === 'nav_stopped') this.stopRenewing();
      if (ev.type === 'game_started') this.mode = 'game';
      if (ev.type === 'game_ended' || ev.type === 'game_out') this.mode = 'world';
      const own = ev.type === 'chat' && (ev.from as { id?: string } | undefined)?.id === this.residentId;
      if (!own) {
        this.backlog.push(ev);
        if (this.backlog.length > this.t.backlogLimit) this.backlog.splice(0, this.backlog.length - this.t.backlogLimit);
      }
      const cls = this.t.classify(ev, { residentId: this.residentId, mode: this.mode });
      if (cls !== 'ignore') {
        this.addTrigger(ev.type, cls);
        this.lastActivityAt = this.clock.now();
      }
    }
    if (res.present === false && this.status === 'running') {
      this.log('服务器说我已不在场（在别处 leave 了？）：停止写入');
      this.setPassive('away');
    }
    await this.saveJournal();
  }

  private checkIdle(): void {
    if (this.t.idleLeaveMs === null || this.status !== 'running' || this.inflight || this.pending) return;
    if (this.clock.now() - this.lastActivityAt >= this.t.idleLeaveMs) {
      this.log(`空闲 ${this.t.idleLeaveMs} 毫秒，离开小镇`);
      void this.town.leave().catch((e) => this.log(`离开小镇失败：${errText(e)}`));
      this.stopRenewing();
      this.status = 'left';
    }
  }

  // ── 控制权 ──

  private setPassive(reason: 'control_lost' | 'away'): void {
    if (this.status === reason) return;
    this.status = reason;
    this.stopRenewing();
    if (reason === 'control_lost') this.stats.controlLost++;
    this.pending = null;
    this.log(reason === 'control_lost' ? '被别的客户端接管，停止写入' : '不在场，停止写入');
  }

  private async checkControl(): Promise<void> {
    this.verifyControl = false;
    const v = await this.town.view();
    this.adopt(v);
    if (!v.control.mine) this.setPassive('control_lost');
  }

  /** 被动状态：不写、不等（等待会续在场）。autoClaim 打开就隔一会儿接管回来，否则等 resume() / stop()。 */
  private async passive(): Promise<void> {
    if (this.t.autoClaim && this.status === 'control_lost') {
      await this.sleepQuiet(this.t.autoClaimDelayMs);
      if (this.stopped || this.status !== 'control_lost') return;
      const now = this.clock.now();
      this.js.claims = this.js.claims.filter((x) => now - x < HOUR_MS);
      if (this.js.claims.length < this.t.autoClaimMaxPerHour) {
        this.js.claims.push(now);
        try {
          await this.town.claim();
          this.adopt(await this.town.view());
          this.status = 'running';
          this.addTrigger('resume', 'urgent');
          this.log('已自动接管回来');
          await this.saveJournal();
        } catch (e) {
          if (this.stopped || isAbort(e)) return;
          this.log(`自动接管失败：${errText(e)}`);
          await this.sleepQuiet(this.t.autoClaimDelayMs * 4);
        }
        return;
      }
      this.log('一小时内自动接管次数已到上限，等待手动恢复');
    }
    await new Promise<void>((res) => {
      if (this.stopped) return res();
      this.resumeWaiters.push(res);
    });
  }

  // ── 出错与重连 ──

  private async recover(e: unknown): Promise<void> {
    const te = toTownError(e, 'world_wait');
    if (te instanceof TownError) {
      switch (te.code) {
        case 'control_lost':
          this.setPassive('control_lost');
          return;
        case 'resync_required': {
          this.stats.resyncs++;
          const v = await this.town.view({ resetCursor: true }).catch(() => null);
          if (v) {
            this.adopt(v);
            this.cursor = v.cursor;
          }
          return;
        }
        case 'unauthenticated': {
          // 会话丢了（引擎重启）：重新进入，游标照旧续传
          this.log('会话失效，重新进入小镇');
          try {
            const r = await this.town.enter(this.spec.profile);
            this.adopt(r);
          } catch (e2) {
            if (!isAbort(e2)) await this.backoff(e2);
          }
          return;
        }
        case 'recovering':
        case 'rate_limited':
          await this.sleepQuiet(Math.max(1000, typeof te.data.retryAfterMs === 'number' ? te.data.retryAfterMs : 2000));
          return;
        default:
      }
    }
    await this.backoff(e);
    if (this.stopped) return;
    if (this.spec.reconnect) {
      // 新连接是新的 MCP 会话，世界上下文要重新进入（带同一个 client_id，游标照旧续传）
      try {
        const next = await this.spec.reconnect();
        const old = this.town;
        this.town = next;
        void old.close?.()?.catch?.(() => undefined);
        this.adopt(await this.town.enter(this.spec.profile));
        return;
      } catch (e2) {
        if (this.stopped || isAbort(e2)) return;
        this.log(`重新连接失败：${errText(e2)}`);
        return;
      }
    }
    // 没有 reconnect：用游标续传，先读一次视图确认会话还在；会话没了就重新进入
    try {
      const v = await this.town.view();
      this.adopt(v);
      if (!v.control.mine) this.setPassive('control_lost');
    } catch (e3) {
      if (isAbort(e3)) return;
      const t3 = toTownError(e3, 'get_my_view');
      if (t3 instanceof TownError && t3.code === 'unauthenticated') {
        try {
          this.adopt(await this.town.enter(this.spec.profile));
        } catch {
          /* 下一轮再试 */
        }
      }
    }
  }

  private async backoff(e: unknown): Promise<void> {
    this.stats.reconnects++;
    const wait = Math.min(this.t.reconnectMaxMs, this.t.reconnectBaseMs * 2 ** Math.min(this.netFails, 16));
    this.netFails++;
    this.log(`连接出错（${errText(e)}），${wait} 毫秒后重试，游标 ${this.cursor ?? '-'}`);
    await this.sleepQuiet(wait);
  }

  // ── 决策 ──

  private async decideOnce(p: Pending): Promise<void> {
    const triggers = [...p.triggers];
    let release: (() => void) | null = null;
    const decisionId = `d${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const ctrl = new AbortController();
    const onStop = () => ctrl.abort();
    this.ac.signal.addEventListener('abort', onStop, { once: true });
    let decision: Decision | null = null;
    let view: TownView | null = null;
    let events: TownEvent[] = [];
    let outcome: MemorySaveEntry['outcome'] = 'noop';
    let error: string | undefined;
    const results: ActResult[] = [];
    let called = false;
    try {
      release = await this.sem.acquire(p.gameTurn ? 0 : 1, this.ac.signal);
      // 决策前读一次最新视图：动作按这份视图提交；顺便确认控制权和小游戏回合
      view = await this.town.view({ signal: this.ac.signal });
      this.adopt(view);
      if (!view.control.mine) {
        this.setPassive('control_lost');
        return;
      }
      let deadlineAt: number | null = null;
      let timeoutMs = this.t.decideTimeoutMs;
      if (view.context.activityId) {
        this.mode = 'game';
        const todo = view.game?.todo;
        if (!view.game?.your_turn || !todo) {
          this.stats.skipped++;
          return;
        }
        if (typeof todo.seconds_left === 'number') {
          const left = todo.seconds_left * 1000 - this.t.gameSafetyMarginMs;
          if (left <= 0) {
            this.stats.skipped++;
            this.log('小游戏这一手剩余时间太少，交给引擎托管');
            return;
          }
          deadlineAt = this.clock.now() + todo.seconds_left * 1000 - this.t.gameSafetyMarginMs;
          timeoutMs = Math.min(timeoutMs, left);
        }
      } else this.mode = 'world';
      const budgetNow = this.budget();
      if (budgetNow.remaining <= 0) {
        this.stats.budgetBlocked++;
        return;
      }
      // 记一次模型调用（滑动窗口），并开始计两次决策的间隔
      const startedAt = this.clock.now();
      this.js.calls.push(startedAt);
      this.lastDecisionAt = startedAt;
      this.stats.decisions++;
      called = true;
      events = this.backlog.splice(0);
      let memory: unknown;
      try {
        memory = await this.spec.memory?.load?.({ residentId: this.residentId, view, events });
      } catch (e) {
        this.log(`读叙述记忆失败（忽略）：${errText(e)}`);
      }
      await this.saveJournal();
      const ctx: DecisionContext = {
        decisionId,
        residentId: this.residentId,
        name: this.name,
        mode: this.mode,
        triggers,
        view,
        events,
        budget: { remaining: this.budget().remaining, limit: this.t.budgetPerHour, resetsInMs: this.budget().resetsInMs },
        memory,
        deadlineAt,
        signal: ctrl.signal,
      };
      try {
        decision = await this.withTimeout(this.spec.decide(ctx), timeoutMs, ctrl);
        this.failStreak = 0;
      } catch (e) {
        if (this.stopped) return;
        const timedOut = e instanceof DecideTimeout;
        this.stats.failures++;
        if (timedOut) this.stats.timeouts++;
        this.failStreak++;
        this.backoffUntil = this.clock.now() + Math.min(this.t.failureBackoffMaxMs, this.t.failureBackoffBaseMs * 2 ** (this.failStreak - 1));
        outcome = timedOut ? 'timeout' : 'failed';
        error = errText(e);
        this.log(`决策${timedOut ? '超时' : '失败'}：${error}，退避到 ${this.backoffUntil - this.clock.now()} 毫秒后`);
        return;
      } finally {
        release?.();
        release = null;
      }
      if (!decision || !decision.actions?.length) {
        this.stats.noops++;
        outcome = 'noop';
        return;
      }
      if (deadlineAt !== null && this.clock.now() > deadlineAt) {
        // 小游戏这一手已经过了截止时间：不抢答，让引擎托管
        this.stats.discarded++;
        outcome = 'discarded';
        error = 'deadline_passed';
        return;
      }
      const actions = decision.actions.slice(0, this.t.maxActionsPerDecision);
      const pending: PendingDecision = { decisionId, actions, done: 0, contextVersion: view.context.version, createdAt: this.clock.now() };
      this.js.pending = pending;
      await this.saveJournal();
      const r = await this.execute(pending, view, results);
      outcome = r.outcome;
      error = r.error;
    } catch (e) {
      if (this.stopped || isAbort(e)) return;
      outcome = 'failed';
      error = errText(e);
      this.stats.failures++;
      this.log(`决策流程出错：${error}`);
    } finally {
      release?.();
      this.ac.signal.removeEventListener('abort', onStop);
      if (called && this.spec.memory?.save) {
        try {
          await this.spec.memory.save({ residentId: this.residentId, decisionId, at: this.clock.now(), triggers, events, decision, outcome, results, ...(error ? { error } : {}) });
        } catch (e) {
          this.log(`写叙述记忆失败（忽略）：${errText(e)}`);
        }
      }
    }
  }

  /**
   * 执行一次决策的各步动作。每一步的请求号 = `${decisionId}-${序号}`，所以崩溃后重放、网络失败重试都不会重复执行。
   * 每步前（第一步之外）重读视图：上下文变了就作废剩下的步骤。
   */
  private async execute(pending: PendingDecision, first: TownView, results: ActResult[]): Promise<{ outcome: MemorySaveEntry['outcome']; error?: string }> {
    let view = first;
    let outcome: MemorySaveEntry['outcome'] = 'executed';
    let error: string | undefined;
    const first0 = pending.done;
    for (let i = pending.done; i < pending.actions.length; i++) {
      if (this.stopped) return { outcome: 'partial', error: 'stopped' };
      if (i > first0) {
        try {
          view = await this.town.view({ signal: this.ac.signal });
          this.adopt(view);
        } catch (e) {
          return { outcome: 'partial', error: errText(e) };
        }
        if (!view.control.mine) {
          this.setPassive('control_lost');
          return { outcome: 'partial', error: 'control_lost' };
        }
        if (view.context.version !== pending.contextVersion) {
          this.stats.discarded++;
          this.js.pending = null;
          await this.saveJournal();
          return { outcome: 'partial', error: 'context_changed' };
        }
      }
      const action = this.fill(pending.actions[i]!, view);
      const requestId = `${pending.decisionId}-${i}`;
      const act = await this.actWithRetry(action, requestId, view, pending.contextVersion);
      if ('result' in act) {
        results.push(act.result);
        this.stats.actions++;
        this.afterAct(action, act.result);
        pending.done = i + 1;
        this.js.pending = pending;
        await this.saveJournal();
        continue;
      }
      // 失败
      const e = act.error;
      if (e instanceof TownError && e.code === 'control_lost') {
        this.setPassive('control_lost');
        this.js.pending = null;
        await this.saveJournal();
        return { outcome: 'partial', error: 'control_lost' };
      }
      if (isDiscardError(e)) {
        this.stats.discarded++;
        this.js.pending = null;
        await this.saveJournal();
        this.log(`决策作废（${(e as TownError).code}${(e as TownError).reason ? `/${(e as TownError).reason}` : ''}）`);
        return { outcome: 'discarded', error: (e as TownError).code };
      }
      // 网络问题重试用完：留着记录，重连后用同一个请求号续做
      this.pendingResume = pending;
      this.stats.failures++;
      error = errText(e);
      outcome = 'partial';
      break;
    }
    if (outcome === 'executed') {
      this.js.pending = null;
      await this.saveJournal();
    }
    return { outcome, ...(error ? { error } : {}) };
  }

  /** 动作成功之后：导航被接受就开始续租，停步 / 进了小游戏就收掉。 */
  private afterAct(action: TownAction, result: ActResult): void {
    if (action.type === 'navigate' || action.type === 'move') {
      if (result.status === 'accepted' && result.navigation?.navigationId) this.startRenewing(result.navigation);
      else if (result.status === 'completed') this.stopRenewing();
    } else if (action.type === 'stop_navigation') this.stopRenewing();
  }

  /** game_act 没写 phaseId 就用决策时视图里的阶段编号。 */
  private fill(action: TownAction, view: TownView): TownAction {
    if (action.type === 'game_act' && (action.phaseId === undefined || action.phaseId === null) && view.game?.phase_id !== null && view.game?.phase_id !== undefined) {
      return { ...action, phaseId: view.game.phase_id };
    }
    return action;
  }

  /** 提交一步动作。网络失败用同一个请求号重试几次；recovering / rate_limited 由 TownClient 自己重试。 */
  private async actWithRetry(action: TownAction, requestId: string, view: TownView, contextVersion: number): Promise<{ result: ActResult } | { error: unknown }> {
    const opts: ActOptions = { requestId, actionWindow: view.action_window, contextVersion, activityId: view.context.activityId, signal: this.ac.signal };
    for (let attempt = 0; ; attempt++) {
      try {
        return { result: await this.town.act(action, opts) };
      } catch (e) {
        if (this.stopped || isAbort(e)) return { error: e };
        const te = toTownError(e, 'world_act', requestId);
        const network = te instanceof TownError && te.code === 'network';
        if (!network || attempt >= this.t.actRetries) return { error: te };
        await this.sleepQuiet(this.t.actRetryBaseMs * 2 ** attempt);
      }
    }
  }

  private resumeTooOld(p: PendingDecision): boolean {
    return this.clock.now() - p.createdAt > this.t.maxResumeAgeMs;
  }

  /** 崩溃 / 断线后接着做没做完的决策（世界变了服务器会拒绝，那就作废）。 */
  private async tryResumePending(): Promise<void> {
    const pending = this.pendingResume;
    if (!pending || this.inflight || this.status !== 'running') return;
    this.pendingResume = null;
    if (this.resumeTooOld(pending)) {
      this.log('没做完的决策已过期，作废不重放');
      this.stats.discarded++;
      this.js.pending = null;
      await this.saveJournal();
      return;
    }
    this.inflight = (async () => {
      try {
        const view = await this.town.view({ signal: this.ac.signal });
        this.adopt(view);
        if (!view.control.mine) return this.setPassive('control_lost');
        // 重放：同样的请求号同样的内容，服务器要么返回第一次的结果，要么因为世界已变而拒绝
        const results: ActResult[] = [];
        await this.execute(pending, view, results);
      } catch (e) {
        if (!this.stopped && !isAbort(e)) this.log(`恢复没做完的决策失败：${errText(e)}`);
      }
    })().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  /** 用运行器的时钟计时：超时就取消 ctx.signal 并抛 DecideTimeout，之后决策函数迟到的结果被忽略；停止时立刻放弃等待。 */
  private withTimeout<T>(p: Promise<T> | T, ms: number, ctrl: AbortController): Promise<T> {
    const timerAc = new AbortController();
    const timeout = this.clock.sleep(ms, timerAc.signal).then<never>(() => {
      ctrl.abort();
      throw new DecideTimeout(`决策函数超过 ${ms} 毫秒没有返回`);
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

class DecideTimeout extends Error {}

function eventKey(ev: TownEvent): string {
  return createHash('sha1').update(JSON.stringify(ev)).digest('base64url').slice(0, 20);
}
