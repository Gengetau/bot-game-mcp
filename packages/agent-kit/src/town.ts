/**
 * 栖灯镇（持续世界）的客户端：把 enter_world / get_my_view / world_act / world_wait / world_query /
 * heartbeat / claim_control / leave_world 包成方法。
 *
 * 要点：
 *  - 每个有意的新动作自动生成一个 request_id；调用方可以自己指定（重试同一件事就用同一个）。
 *    只有 recovering 和 rate_limited 会用同一个 request_id 自动重试，其余错误原样抛出，由调用方决定。
 *  - 动作会自动带上最近一次视图里的 action_window、context.version 和 activity_id；
 *    想按「决策时的视图」提交（运行器就是这样做的），在 ActOptions 里显式传。
 *  - 错误按 docs/TOWN.md 的错误码表分成不同的类（ControlLostError、ContextStaleError、RateLimitedError……），
 *    调用方用 instanceof 或 error.code 区分。网络层的失败是 TownNetworkError：不知道服务器有没有执行，
 *    带着同一个 request_id 重试是安全的（服务器保证同一个请求号只做一次）。
 */
import { randomUUID } from 'node:crypto';
import { BotGameClient, ToolError, type BotGameClientOptions } from './client.js';

// ───────────────────────── 类型 ─────────────────────────

/** 一个动作，type 见 docs/TOWN.md 的「动作一览」。 */
export interface TownAction {
  type: string;
  [k: string]: unknown;
}

/** 小镇里每个动作类型（docs/TOWN.md 动作一览）。 */
export const TOWN_ACTION_TYPES = [
  'move',
  'speak',
  'ask_hobby',
  'update_profile',
  'buy',
  'use_item',
  'display_item',
  'place_furniture',
  'offer',
  'accept_offer',
  'decline_offer',
  'cancel_offer',
  'borrow_book',
  'return_item',
  'send_letter',
  'read_letter',
  'delete_letter',
  'invite',
  'revoke_invite',
  'start_interaction',
  'join_interaction',
  'begin_interaction',
  'leave_interaction',
  'replace_goal',
  'propose_game',
  'join_game',
  'leave_game_lobby',
  'start_game',
  'game_act',
  'quit_game',
] as const;

export interface TownEvent {
  type: string;
  at: number;
  [k: string]: unknown;
}

/** 小游戏里的待办（和桌游的 todo 同一个格式）。 */
export interface TownGameTodo {
  prompt: string;
  kind: string;
  actions: { action: string; description?: string; example?: string; [k: string]: unknown }[];
  seconds_left: number | null;
}

/** 紧凑视图（agentView）。没列出的字段原样保留。 */
export interface TownView {
  world: { name: string; clock: string; date: string; weather: string };
  me: { id: string; name: string; needs: { energy: number; social: number; interest: number }; mood: string | null; home: string; [k: string]: unknown };
  control: { epoch: number; mine: boolean; presenceEpoch: number };
  context: { version: number; activityId: string | null };
  action_window: string;
  cursor: string;
  location: { space?: string; name?: string; moving_to?: string; arrive_at?: number };
  here: {
    kind: string;
    blurb: string;
    residents: { id: string; name: string; kind: string; mood?: string }[];
    exits: { to: string; name: string }[];
    activities: { id: string; name: string; status: string; players: string[]; need: number }[];
    games: { type: string; name: string; players: string }[];
    recent_chat: { from: string; text: string }[];
    [k: string]: unknown;
  } | null;
  coins: number;
  items: { itemId?: string; type: string; name: string; qty: number; borrowed_from?: string }[];
  goals: unknown[];
  mail_unread: number;
  invites: unknown[];
  offers: { id: string; text: string; mine: boolean }[];
  doing: unknown | null;
  game: {
    game_id: string;
    name: string;
    status: string;
    phase_id: number | null;
    your_turn: boolean;
    todo: TownGameTodo | null;
    you?: Record<string, unknown>;
    public: Record<string, unknown>;
    events: unknown[];
  } | null;
  suggestions: unknown;
  new_events?: TownEvent[];
  resync?: boolean;
  [k: string]: unknown;
}

export interface EnterResult extends TownView {
  ok: true;
  created: boolean;
  resident_id: string;
}

export interface EnterProfile {
  /** 居民显示名（第一次进入必填，最多 16 字） */
  name?: string;
  bio?: string;
  traits?: string[];
  interests?: string[];
}

export interface ActResult {
  ok: true;
  requestId: string;
  status: 'completed' | 'accepted';
  contextVersion: number;
  activityId: string | null;
  cursor: string;
  /** 同一个请求号第二次提交：返回的是第一次的结果，没有再执行 */
  replayed?: boolean;
  [k: string]: unknown;
}

export interface ActOptions {
  /** 自己指定请求号（重试同一件事时用同一个）；不给就生成一个新的 */
  requestId?: string;
  /** 按这份视图提交；不给就用最近一次视图 */
  actionWindow?: string;
  contextVersion?: number;
  /** 你所在小游戏的 activityId（不在游戏里是 null） */
  activityId?: string | null;
  signal?: AbortSignal;
}

export interface WaitOptions {
  /** 上次确认的游标；不给就用客户端记着的 */
  cursor?: string;
  /** 最多等几秒（0~50，默认 25）；0 = 只取已有的 */
  waitSeconds?: number;
  /** 你手上的 context.version：变了会立刻返回 */
  contextVersion?: number;
  signal?: AbortSignal;
}

export interface WaitResult {
  reason: string;
  events: TownEvent[];
  cursor: string;
  more: boolean;
  /** 游标失效：请重新 view()，再从视图里的 cursor 继续 */
  resync?: boolean;
  context: { version: number; activityId: string | null };
  present: boolean;
}

export type TownQueryWhat = 'public' | 'residents' | 'letters' | 'history' | 'relations' | 'report';

// ───────────────────────── 错误 ─────────────────────────

export type TownErrorCode =
  | 'unauthenticated'
  | 'control_lost'
  | 'context_stale'
  | 'phase_stale'
  | 'precondition_failed'
  | 'request_conflict'
  | 'request_expired'
  | 'rate_limited'
  | 'resync_required'
  | 'recovering'
  | 'bad_request'
  | 'not_available'
  /** 没有权限（如 town_issue_ticket 只有可信账号能调） */
  | 'forbidden'
  /** 引擎没开小镇（没有 enter_world 这类工具） */
  | 'town_disabled'
  /** 网络层失败：不知道服务器有没有执行。带同一个 request_id 重试是安全的 */
  | 'network'
  | 'unknown';

export interface TownErrorInit {
  tool: string;
  reason?: string;
  data?: Record<string, unknown>;
  hint?: string;
  requestId?: string;
  cause?: unknown;
}

export class TownError extends Error {
  readonly tool: string;
  /** precondition_failed 的细分原因，如 insufficient_coins、not_same_place */
  readonly reason: string | undefined;
  /** 服务器附带的其余字段（如 context_stale 的 contextVersion、rate_limited 的 retryAfterMs） */
  readonly data: Record<string, unknown>;
  readonly hint: string | undefined;
  /** 失败的动作用的请求号（act 才有） */
  requestId: string | undefined;

  constructor(
    readonly code: TownErrorCode,
    message: string,
    init: TownErrorInit,
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'TownError';
    this.tool = init.tool;
    this.reason = init.reason;
    this.data = init.data ?? {};
    this.hint = init.hint;
    this.requestId = init.requestId;
  }

  /** 这次决策基于的世界已经变了：丢掉它，重新读视图，不要原样重试。 */
  get isStale(): boolean {
    return this.code === 'context_stale' || this.code === 'phase_stale' || this.code === 'request_expired' || this.code === 'precondition_failed';
  }
}

export class UnauthenticatedError extends TownError {}
/** 这个客户端没有控制权（别的客户端接管了）。只读展示，要写就 claim()。 */
export class ControlLostError extends TownError {}
/** 上下文变了（进入 / 离开了小游戏）。重新读视图。 */
export class ContextStaleError extends TownError {
  get contextVersion(): number | undefined {
    return typeof this.data.contextVersion === 'number' ? this.data.contextVersion : undefined;
  }
}
/** 小游戏的阶段变了。重新读视图。 */
export class PhaseStaleError extends TownError {}
/** 规则不允许，reason 是细分原因；message 可以直接给人看。 */
export class PreconditionFailedError extends TownError {}
/** 同一个请求号换了内容。用新的请求号。 */
export class RequestConflictError extends TownError {}
/** 动作窗口过期。重新读视图，用新请求号。 */
export class RequestExpiredError extends TownError {}
/** 太频繁。retryAfterMs 之后可以用同一个请求号重试（act 会自动重试几次）。 */
export class RateLimitedError extends TownError {
  get retryAfterMs(): number | undefined {
    return typeof this.data.retryAfterMs === 'number' ? this.data.retryAfterMs : undefined;
  }
}
/** 游标失效。重新读视图。 */
export class ResyncRequiredError extends TownError {}
/** 小镇正在恢复或暂时不能保存。稍后用同一个请求号重试（act 会自动重试几次）。 */
export class RecoveringError extends TownError {}
export class BadRequestError extends TownError {}
export class NotAvailableError extends TownError {}
export class ForbiddenError extends TownError {}
export class TownDisabledError extends TownError {}
/** 网络层失败（超时、断线、会话丢失）。 */
export class TownNetworkError extends TownError {}

const ERROR_CLASSES: Record<TownErrorCode, new (code: TownErrorCode, message: string, init: TownErrorInit) => TownError> = {
  unauthenticated: UnauthenticatedError,
  control_lost: ControlLostError,
  context_stale: ContextStaleError,
  phase_stale: PhaseStaleError,
  precondition_failed: PreconditionFailedError,
  request_conflict: RequestConflictError,
  request_expired: RequestExpiredError,
  rate_limited: RateLimitedError,
  resync_required: ResyncRequiredError,
  recovering: RecoveringError,
  bad_request: BadRequestError,
  not_available: NotAvailableError,
  forbidden: ForbiddenError,
  town_disabled: TownDisabledError,
  network: TownNetworkError,
  unknown: TownError,
};

const KNOWN_CODES = new Set<string>(Object.keys(ERROR_CLASSES));

/** 引擎返回的错误文本：「❌ 消息\n{json 细节}\n💡 提示\n(code: X)」。 */
export function parseToolErrorText(raw: string): { message: string; data: Record<string, unknown>; hint?: string; code?: string } {
  const lines = raw.replace(/^❌\s*/, '').split('\n');
  const message = (lines[0] ?? raw).trim();
  let data: Record<string, unknown> = {};
  let hint: string | undefined;
  let code: string | undefined;
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        data = JSON.parse(t) as Record<string, unknown>;
      } catch {
        /* 不是 JSON 就忽略 */
      }
    } else if (t.startsWith('💡')) hint = t.replace(/^💡\s*/, '');
    else {
      const m = /^\(code: ([A-Z_]+)\)$/.exec(t);
      if (m) code = m[1];
    }
  }
  return { message, data, ...(hint ? { hint } : {}), ...(code ? { code } : {}) };
}

/** 把任何调用失败转成 TownError。取消（AbortError）原样返回，不转。 */
export function toTownError(e: unknown, tool: string, requestId?: string): unknown {
  if (e instanceof TownError) {
    if (requestId && !e.requestId) e.requestId = requestId;
    return e;
  }
  if (e instanceof ToolError) {
    const parsed = parseToolErrorText(e.raw ?? e.message);
    const rawCode = (e.code ?? parsed.code ?? '').toLowerCase();
    const code: TownErrorCode = KNOWN_CODES.has(rawCode) ? (rawCode as TownErrorCode) : 'unknown';
    const { reason, ...rest } = parsed.data;
    const Cls = ERROR_CLASSES[code];
    return new Cls(code, parsed.message, {
      tool,
      ...(typeof reason === 'string' ? { reason } : {}),
      data: rest,
      ...(parsed.hint ? { hint: parsed.hint } : {}),
      ...(requestId ? { requestId } : {}),
    });
  }
  if (e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const mcpCode = (e as { code?: unknown } | null)?.code;
  // MCP 层「工具不存在」(-32602)：引擎没开小镇
  if (mcpCode === -32602 && /not found/i.test(msg)) {
    return new TownDisabledError('town_disabled', '引擎没有开小镇（town.enabled）。', { tool, cause: e });
  }
  return new TownNetworkError('network', `${tool}：${msg}`, { tool, ...(requestId ? { requestId } : {}), cause: e });
}

/** 这个错误说明「这次决策作废」：世界变了或规则不允许，不要原样重试。 */
export function isDiscardError(e: unknown): boolean {
  return (
    e instanceof TownError &&
    (e.code === 'context_stale' || e.code === 'phase_stale' || e.code === 'precondition_failed' || e.code === 'request_expired' || e.code === 'request_conflict' || e.code === 'bad_request' || e.code === 'not_available')
  );
}

// ───────────────────────── 客户端 ─────────────────────────

/** TownClient 需要的最小调用能力（BotGameClient 满足它，测试里可以换成假的）。 */
export interface ToolCaller {
  call<T = any>(name: string, args?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  close?(): Promise<void>;
}

export interface TownClientOptions {
  /** 这个客户端的稳定编号（4~60 位字母数字或 ._-）。重连、重启后带同一个，可以无缝接着用；不给就生成一个 */
  clientId?: string;
  /** 世界编号，默认 town */
  worldId?: string;
  /** 自动生成请求号的前缀（默认 rq） */
  requestIdPrefix?: string;
  /** recovering / rate_limited 时用同一个请求号最多重试几次，默认 3 */
  maxRetries?: number;
  /** recovering 的重试基础间隔（毫秒，指数增长），默认 500 */
  retryBaseMs?: number;
  /** rate_limited 时愿意等多久（毫秒）；服务器要求等得更久就直接抛 RateLimitedError，默认 15000 */
  rateLimitMaxWaitMs?: number;
  /** 注入等待函数（测试用） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 普通调用的超时（毫秒），默认 60 秒 */
  timeoutMs?: number;
}

/** 客户端记着的「最近一次」状态。 */
export interface TownClientState {
  residentId: string | null;
  actionWindow: string | null;
  contextVersion: number | null;
  activityId: string | null;
  controlEpoch: number | null;
  /** 下一次 wait() 默认用的游标（enter 时从视图里取，wait 返回后前进） */
  cursor: string | null;
  /** 最近一次视图里小游戏的阶段编号 */
  phaseId: number | null;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
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
  });

export class TownClient {
  readonly clientId: string;
  readonly state: TownClientState = { residentId: null, actionWindow: null, contextVersion: null, activityId: null, controlEpoch: null, cursor: null, phaseId: null };
  /** 最近一次读到的视图 */
  lastView: TownView | null = null;
  private readonly caller: ToolCaller;
  private readonly o: Required<Pick<TownClientOptions, 'maxRetries' | 'retryBaseMs' | 'rateLimitMaxWaitMs' | 'requestIdPrefix' | 'timeoutMs'>> & Pick<TownClientOptions, 'worldId'>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(caller: ToolCaller | BotGameClient, opts: TownClientOptions = {}) {
    this.caller = caller as ToolCaller;
    this.clientId = opts.clientId ?? `tc-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (!/^[\w.-]{4,60}$/.test(this.clientId)) throw new Error('clientId 需要 4~60 位字母数字或 ._-');
    this.o = {
      maxRetries: opts.maxRetries ?? 3,
      retryBaseMs: opts.retryBaseMs ?? 500,
      rateLimitMaxWaitMs: opts.rateLimitMaxWaitMs ?? 15_000,
      requestIdPrefix: opts.requestIdPrefix ?? 'rq',
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...(opts.worldId ? { worldId: opts.worldId } : {}),
    };
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** 连接引擎并包成 TownClient。 */
  static async connect(opts: BotGameClientOptions & TownClientOptions): Promise<TownClient> {
    return new TownClient(await BotGameClient.connect(opts), opts);
  }

  /** 关闭底层连接。 */
  async close(): Promise<void> {
    await this.caller.close?.();
  }

  /** 生成一个新的请求号（8~80 个字符）。 */
  newRequestId(): string {
    return `${this.o.requestIdPrefix}-${randomUUID()}`;
  }

  private async raw<T>(tool: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal; requestId?: string } = {}): Promise<T> {
    try {
      return await this.caller.call<T>(tool, args, opts.timeoutMs ?? this.o.timeoutMs, opts.signal);
    } catch (e) {
      throw toTownError(e, tool, opts.requestId);
    }
  }

  private applyView(v: TownView, adoptCursor: boolean): void {
    this.lastView = v;
    this.state.actionWindow = v.action_window ?? this.state.actionWindow;
    this.state.contextVersion = v.context?.version ?? this.state.contextVersion;
    this.state.activityId = v.context ? v.context.activityId : this.state.activityId;
    this.state.controlEpoch = v.control?.epoch ?? this.state.controlEpoch;
    this.state.phaseId = v.game?.phase_id ?? null;
    this.state.residentId = v.me?.id ?? this.state.residentId;
    if (adoptCursor || !this.state.cursor) this.state.cursor = v.cursor;
  }

  // ── 进出与读取 ──

  /** 进入小镇（第一次要 profile.name；之后再调用只是回来）。会接管这位居民的控制权。 */
  async enter(profile: EnterProfile = {}): Promise<EnterResult> {
    const r = await this.raw<EnterResult>('enter_world', {
      ...(this.o.worldId ? { world_id: this.o.worldId } : {}),
      client_id: this.clientId,
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.bio ? { bio: profile.bio } : {}),
      ...(profile.traits ? { traits: profile.traits } : {}),
      ...(profile.interests ? { interests: profile.interests } : {}),
    });
    this.applyView(r, true);
    this.state.residentId = r.resident_id ?? this.state.residentId;
    return r;
  }

  /**
   * 读取我的视图（同时刷新 action_window 和 context 版本）。
   * 默认不动 wait() 的游标（免得跳过还没消费的事件）；resetCursor 用于 resync 之后重新对齐。
   */
  async view(opts: { resetCursor?: boolean; signal?: AbortSignal } = {}): Promise<TownView> {
    const v = await this.raw<TownView>('get_my_view', {}, { signal: opts.signal });
    this.applyView(v, Boolean(opts.resetCursor));
    return v;
  }

  /** 长轮询新事件。返回后客户端记着的游标前进到返回的 cursor。resync 为 true 时请 view({resetCursor:true})。 */
  async wait(opts: WaitOptions = {}): Promise<WaitResult> {
    const cursor = opts.cursor ?? this.state.cursor;
    if (!cursor) throw new Error('wait：还没有游标，先 enter() 或 view()。');
    const seconds = Math.max(0, Math.min(50, Math.floor(opts.waitSeconds ?? 25)));
    const r = await this.raw<WaitResult>(
      'world_wait',
      { cursor, wait_seconds: seconds, ...((opts.contextVersion ?? this.state.contextVersion) !== null ? { context_version: opts.contextVersion ?? this.state.contextVersion } : {}) },
      { timeoutMs: Math.max(this.o.timeoutMs, (seconds + 30) * 1000), ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!r.resync) this.state.cursor = r.cursor;
    return r;
  }

  query(what: TownQueryWhat, opts: { box?: 'inbox' | 'sent'; before?: number; limit?: number; date?: string } = {}): Promise<any> {
    return this.raw('world_query', {
      what,
      ...(opts.box ? { box: opts.box } : {}),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.date ? { date: opts.date } : {}),
    });
  }

  /** 只续在场租约。平时 wait() 就在续了。 */
  heartbeat(): Promise<{ ok: true; presenceEpoch: number; control: { epoch: number; mine: boolean }; contextVersion: number; activityId: string | null; nextHeartbeatMs: number }> {
    return this.raw('heartbeat', {});
  }

  /** 接管控制权：别的客户端之后发来的动作会被拒绝。 */
  claim(): Promise<{ ok: true; control: { epoch: number; mine: boolean } }> {
    return this.raw('claim_control', {});
  }

  /** 主动离开小镇（居民、房子、东西都保留）。 */
  leave(): Promise<{ ok: true; presenceEpoch?: number }> {
    return this.raw('leave_world', {});
  }

  // ── 动作 ──

  /**
   * 提交一个动作。请求号自动生成（或用 opts.requestId）；recovering / rate_limited 时用同一个请求号自动重试，
   * 其余错误转成对应的 TownError 抛出（error.requestId 是这次用的请求号）。
   * 网络层失败抛 TownNetworkError：不知道有没有执行，用 error.requestId 再调一次 act 即可（服务器只做一次）。
   */
  async act(action: TownAction, opts: ActOptions = {}): Promise<ActResult> {
    const requestId = opts.requestId ?? this.newRequestId();
    if (!/^.{8,80}$/.test(requestId)) throw new Error('requestId 需要 8~80 个字符');
    if (!opts.actionWindow && !this.state.actionWindow) await this.view();
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.caller.call<ActResult>(
          'world_act',
          {
            request_id: requestId,
            action_window: opts.actionWindow ?? this.state.actionWindow,
            context_version: opts.contextVersion ?? this.state.contextVersion,
            activity_id: opts.activityId !== undefined ? opts.activityId : this.state.activityId,
            action,
          },
          this.o.timeoutMs,
          opts.signal,
        );
        // 动作之后的上下文版本（进入 / 离开小游戏会变）；游标不动：它不等于「事件已读到哪」
        if (typeof r.contextVersion === 'number' && opts.contextVersion === undefined) this.state.contextVersion = r.contextVersion;
        if (r.activityId !== undefined && opts.activityId === undefined) this.state.activityId = r.activityId;
        return r;
      } catch (raw) {
        const e = toTownError(raw, 'world_act', requestId);
        if (!(e instanceof TownError)) throw e;
        const retriable = (e.code === 'recovering' || e.code === 'rate_limited') && attempt < this.o.maxRetries && !opts.signal?.aborted;
        if (!retriable) throw e;
        const wait = e instanceof RateLimitedError ? (e.retryAfterMs ?? this.o.retryBaseMs) + 50 : this.o.retryBaseMs * 2 ** attempt;
        if (e.code === 'rate_limited' && wait > this.o.rateLimitMaxWaitMs) throw e;
        await this.sleep(wait, opts.signal);
      }
    }
  }

  // 常用动作的便捷写法（都走 act，参数同 ActOptions）
  move(to: string, o?: ActOptions) {
    return this.act({ type: 'move', to }, o);
  }
  speak(text: string, o?: ActOptions) {
    return this.act({ type: 'speak', text }, o);
  }
  buy(shop: string, sku: string, qty = 1, o?: ActOptions) {
    return this.act({ type: 'buy', shop, sku, qty }, o);
  }
  /** 用掉一件消耗品（汤、饼干）。字段叫 itemType，因为 type 已经是动作类型。 */
  useItem(itemType: string, o?: ActOptions) {
    return this.act({ type: 'use_item', itemType }, o);
  }
  sendLetter(to: string, body: string, o?: ActOptions) {
    return this.act({ type: 'send_letter', to, body }, o);
  }
  readLetter(letterId: string, o?: ActOptions) {
    return this.act({ type: 'read_letter', letterId }, o);
  }

  // ── 小游戏 ──

  proposeGame(game: string, o?: ActOptions) {
    return this.act({ type: 'propose_game', game }, o);
  }
  joinGame(activityId: string, o?: ActOptions) {
    return this.act({ type: 'join_game', activityId }, o);
  }
  leaveGameLobby(activityId: string, o?: ActOptions) {
    return this.act({ type: 'leave_game_lobby', activityId }, o);
  }
  startGame(activityId: string, o?: ActOptions) {
    return this.act({ type: 'start_game', activityId }, o);
  }
  /**
   * 局内动作。input 的格式来自视图 game.todo.actions[].example（如 {"action":"guess","number":5}）。
   * phaseId 默认取最近一次视图里的阶段编号：进入游戏或阶段变化后先 view()。阶段已变会得到 PhaseStaleError。
   */
  gameAct(input: Record<string, unknown>, o: ActOptions & { phaseId?: number | null } = {}) {
    const { phaseId, ...rest } = o;
    const pid = phaseId ?? this.state.phaseId;
    if (pid === null || pid === undefined) throw new Error('gameAct：没有 phaseId，请先 view()（视图里 game.phase_id）。');
    return this.act({ type: 'game_act', phaseId: pid, input }, rest);
  }
  quitGame(o?: ActOptions) {
    return this.act({ type: 'quit_game' }, o);
  }
}
