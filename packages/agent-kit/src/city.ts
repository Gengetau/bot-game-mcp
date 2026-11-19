/**
 * 东京都持续世界（world_id = "tokyo"）的 MCP 客户端：
 * 封装 enter_world / get_my_view / speak / world_act / world_wait / world_query /
 * heartbeat / claim_control / leave_world。
 *
 * 契约依据：docs/city/CLIENT-AND-WEB-CONTRACT.md、IDENTITY-AND-FACTS.md、ITEM-AND-LOCKER-SPEC.md。
 *  - 幂等重试：每个新写动作生成唯一 request_id（或使用调用方传入的 requestId）；
 *    遇到 RECOVERING（503）、RATE_LIMITED（429，等待不超过上限）或网络超时/断连（CityNetworkError）时，
 *    自动携带原 request_id 退避重试，服务端保证 24h 内同一 request_id 只执行一次。
 *  - 控制权栅栏：enter_world 默认不抢占已有活跃控制者（claim 默认 false）；
 *    遇到 CONTROL_LOST（409）立即原样抛出 CityControlLostError，绝不自动调 claim_control 抢权。
 *  - 门禁硬拦截：ENTRY_VIA_HOME_ONLY / FORBIDDEN / UNAUTHENTICATED / PRECONDITION_FAILED 原样抛出，不盲目重试。
 */
import { randomUUID } from 'node:crypto';
import { BotGameClient, ToolError, type BotGameClientOptions } from './client.js';
import { parseToolErrorText, type ToolCaller } from './town.js';

// ───────────────────────── 类型 ─────────────────────────

export const CITY_WORLD_ID = 'tokyo';

/** 外部 Bot / 人类居民在东京可用的结构化动作类型（M1 基线 + M1-D 储物柜/资料）。 */
export const CITY_ACTION_TYPES = [
  'travel',
  'say',
  'buy',
  'consume',
  'give',
  'read_item',
  'inspect_item',
  'drift_book',
  'take_book',
  'store_locker',
  'take_locker',
  'stamp_station',
  'update_profile',
] as const;

export type CityActionType = (typeof CITY_ACTION_TYPES)[number];

export interface CityAction {
  type: string;
  [k: string]: unknown;
}

export interface CityControlState {
  epoch: number;
  mine: boolean;
}

export interface CityItemView {
  item_id: string;
  type: string;
  name: string;
  qty: number;
  edible?: boolean;
  instance?: boolean;
  carry_home?: boolean;
  storable?: boolean;
  meta?: Record<string, unknown>;
  borrowed_from?: string | null;
  [k: string]: unknown;
}

export interface CityLockerItemView {
  item_id: string;
  type: string;
  name: string;
  qty: number;
  instance?: boolean;
  stored_at_ms?: number;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CityTripLegView {
  mode: 'walk' | 'train' | string;
  from: string;
  to: string;
  line?: string;
  minutes: number;
  fare_yen: number;
  [k: string]: unknown;
}

export interface CityTripView {
  trip_id: string;
  from: string;
  to: string;
  started_at_ms?: number;
  ends_at_ms?: number;
  leg_index?: number;
  legs?: CityTripLegView[];
  [k: string]: unknown;
}

export interface CityHereView {
  place: {
    id: string;
    name: string;
    area: string;
    type: string;
    indoor?: boolean;
    hours?: string;
    open?: boolean;
    closed_reason?: string;
    fictional?: boolean;
    source?: string;
    blurb?: string;
    rain_notice?: string;
    [k: string]: unknown;
  };
  people: { id: string; name: string; bio?: string }[];
  goods: { sku: string; name: string; type?: string; price_yen: number }[];
  actions?: string[];
  exits: {
    id: string;
    name: string;
    area: string;
    type: string;
    minutes: number;
    fare_yen: number;
    open: boolean;
    closed_reason?: string;
  }[];
  recent_chat: {
    message_id: number;
    from: { id: string; name: string };
    mine?: boolean;
    text: string;
    at_ms: number;
    untrusted?: true;
  }[];
  weather?: {
    code?: number;
    text?: string;
    temp_c?: number;
    precip_mm?: number;
    rain?: boolean;
    source?: string;
    status?: string;
    observed_at_ms?: number;
  } | null;
  events?: Record<string, unknown>[];
  [k: string]: unknown;
}

export interface CityEvent {
  type: string;
  at: number;
  [k: string]: unknown;
}

export interface CityView {
  world_id: string;
  at_ms: number;
  local_time: string;
  me: {
    id: string;
    name: string;
    bio?: string;
    origin: 'external' | 'house' | 'human' | string;
    in_city: boolean;
    [k: string]: unknown;
  };
  /** 控制权状态（M1-D 起服务端返回；旧基线缺省归一化为 { epoch: 0, mine: true }） */
  control: CityControlState;
  location:
    | { place: string | null; in_transit?: false }
    | { in_transit: true; trip: CityTripView }
    | null;
  wallet: {
    yen: number;
    held_yen: number;
    spendable_yen: number;
    return_reserve_yen?: number;
  };
  items: CityItemView[];
  /** 本人城市储物柜清单（M1-D 起服务端返回；缺省为空数组） */
  locker_items: CityLockerItemView[];
  /** 本人车站印章帐精简计数摘要（M3-D 起服务端返回） */
  stamp_book?: {
    collected: number;
    total: number;
    here_stamped?: boolean;
  };
  pending_orders?: { order_id: string; what: string; yen: number }[];
  here: CityHereView | null;
  can: string[];
  mappings_version: number;
  action_window: string;
  context: { version: number };
  cursor: string;
  note?: string;
  new_events?: CityEvent[];
  more?: boolean;
  resync?: boolean;
  [k: string]: unknown;
}

export interface CityEnterOptions {
  /** 首次进城必填（1~16 字） */
  name?: string;
  /** 公开一句话简介（<=80 字） */
  bio?: string;
  /** 首次进城落点（如 shinjuku:station 或 ikebukuro:station） */
  entry?: string;
  /** 已有其他活跃客户端持权时是否立即抢占控制权（默认 false：安全旁观，避免双实例互抢） */
  claim?: boolean;
  signal?: AbortSignal;
}

export interface CityEnterResult extends CityView {
  ok: true;
  created: boolean;
  resident_id: string;
  granted_yen?: number;
}

export interface CityActOptions {
  /** 指定幂等请求号（8~80 字符）；不传则自动生成并在自动重试中保持不变 */
  requestId?: string;
  actionWindow?: string;
  contextVersion?: number;
  /** 网络超时/断连时是否用原 requestId 自动退避重试（默认 true） */
  retryNetwork?: boolean;
  signal?: AbortSignal;
}

export interface CityActResult {
  ok?: boolean;
  request_id?: string;
  at_ms?: number;
  status: 'completed' | 'accepted' | 'pending' | string;
  replayed?: boolean;
  [k: string]: unknown;
}

export interface CityWaitOptions {
  cursor?: string;
  /** 最长等待秒数（0~50，默认 25） */
  waitSeconds?: number;
  signal?: AbortSignal;
}

export interface CityWaitResult {
  reason: 'events' | 'timeout' | string;
  events: CityEvent[];
  cursor: string;
  more: boolean;
  resync?: boolean;
  context: { version: number };
  control?: CityControlState;
  present: boolean;
}

export interface CityHeartbeatResult {
  ok: true;
  present: boolean;
  present_until_ms?: number;
  control?: CityControlState;
  server_time_ms?: number;
  next_heartbeat_ms?: number;
}

export interface CityClaimResult {
  ok: true;
  control: CityControlState;
}

export type CityQueryWhat = 'public' | 'residents' | 'history' | 'route' | 'stamps';

export interface CityItemSelector {
  /** 指定具名实例件 ID（优先） */
  itemId?: string;
  /** 指定物品类型（如 'coffee'、'umbrella'） */
  item?: string;
}

// ───────────────────────── 结构化错误类 ─────────────────────────

export type CityErrorCode =
  | 'recovering'
  | 'rate_limited'
  | 'control_lost'
  | 'entry_via_home_only'
  | 'unauthenticated'
  | 'forbidden'
  | 'precondition_failed'
  | 'conflict'
  | 'not_found'
  | 'bad_request'
  | 'internal'
  | 'city_disabled'
  | 'network'
  | 'unknown';

export interface CityErrorInit {
  tool: string;
  reason?: string;
  data?: Record<string, unknown>;
  hint?: string;
  requestId?: string;
  cause?: unknown;
}

export class CityClientError extends Error {
  readonly tool: string;
  readonly reason: string | undefined;
  readonly data: Record<string, unknown>;
  readonly hint: string | undefined;
  requestId: string | undefined;

  constructor(
    readonly code: CityErrorCode,
    message: string,
    init: CityErrorInit,
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.tool = init.tool;
    this.reason = init.reason;
    this.data = init.data ?? {};
    this.hint = init.hint;
    this.requestId = init.requestId;
  }

  /** 是否可安全携带同一 request_id 自动退避重试 */
  get isIdempotentRetriable(): boolean {
    return this.code === 'recovering' || this.code === 'rate_limited' || this.code === 'network';
  }
}

/** 503 RECOVERING：引擎启动恢复或数据库暂不可写，须带原 request_id 退避重试 */
export class CityRecoveringError extends CityClientError {}

/** 429 RATE_LIMITED：触发动作或聊天频率上限，按 retryAfterMs 等待后带原 request_id 重试 */
export class CityRateLimitedError extends CityClientError {
  get retryAfterMs(): number | undefined {
    return typeof this.data.retryAfterMs === 'number' ? this.data.retryAfterMs : undefined;
  }
}

/** 409 CONTROL_LOST：另一客户端持有该居民控制权，CityRunner 必须立即停写，不自动抢权 */
export class CityControlLostError extends CityClientError {
  get control(): CityControlState | undefined {
    const c = this.data.control as { epoch?: unknown; mine?: unknown } | undefined;
    if (c && typeof c.epoch === 'number' && typeof c.mine === 'boolean') {
      return { epoch: c.epoch, mine: c.mine };
    }
    return undefined;
  }
}

/** 403 ENTRY_VIA_HOME_ONLY：小屋室友 QQ 密钥硬拦截，绝不重试 */
export class CityEntryViaHomeOnlyError extends CityClientError {}

/** 401 UNAUTHENTICATED：尚未进城或会话已失效 */
export class CityUnauthenticatedError extends CityClientError {}

/** 403 FORBIDDEN：不在 allowedAgents 准入名单或无权签票，绝不重试 */
export class CityForbiddenError extends CityClientError {}

/** 422 PRECONDITION_FAILED：业务前置不满足（余额不足、打烊、乘车途中等），丢弃意图重读视图 */
export class CityPreconditionError extends CityClientError {}

/** 409 CONFLICT：同一 request_id 提交了不同动作载荷 */
export class CityConflictError extends CityClientError {}

/** 404 NOT_FOUND：目标地点/世界不存在（含隐藏交接点） */
export class CityNotFoundError extends CityClientError {}

/** 400 BAD_REQUEST：参数不合法 */
export class CityBadRequestError extends CityClientError {}

/** 500 INTERNAL：服务端内部错误 */
export class CityInternalError extends CityClientError {}

/** 引擎未开启东京城市模块 */
export class CityDisabledError extends CityClientError {}

/** 传输层超时、断连或回包丢失：未知服务端是否已落盘，必须带原 request_id 重试 */
export class CityNetworkError extends CityClientError {}

const CITY_ERROR_CLASSES: Record<CityErrorCode, new (code: CityErrorCode, message: string, init: CityErrorInit) => CityClientError> = {
  recovering: CityRecoveringError,
  rate_limited: CityRateLimitedError,
  control_lost: CityControlLostError,
  entry_via_home_only: CityEntryViaHomeOnlyError,
  unauthenticated: CityUnauthenticatedError,
  forbidden: CityForbiddenError,
  precondition_failed: CityPreconditionError,
  conflict: CityConflictError,
  not_found: CityNotFoundError,
  bad_request: CityBadRequestError,
  internal: CityInternalError,
  city_disabled: CityDisabledError,
  network: CityNetworkError,
  unknown: CityClientError,
};

function mapRawCityCode(rawUpper: string): CityErrorCode {
  switch (rawUpper) {
    case 'RECOVERING':
      return 'recovering';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'CONTROL_LOST':
      return 'control_lost';
    case 'ENTRY_VIA_HOME_ONLY':
      return 'entry_via_home_only';
    case 'UNAUTHENTICATED':
      return 'unauthenticated';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'PRECONDITION_FAILED':
      return 'precondition_failed';
    case 'CONFLICT':
    case 'REQUEST_CONFLICT':
      return 'conflict';
    case 'NOT_FOUND':
      return 'not_found';
    case 'BAD_REQUEST':
      return 'bad_request';
    case 'INTERNAL':
      return 'internal';
    default:
      return 'unknown';
  }
}

/** 将底层异常转换为结构化 CityClientError；AbortError 原样保留不转换。 */
export function toCityError(e: unknown, tool: string, requestId?: string): unknown {
  if (e instanceof CityClientError) {
    if (requestId && !e.requestId) e.requestId = requestId;
    return e;
  }
  if (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message))) {
    return e;
  }
  if (e instanceof ToolError) {
    if (!e.code && /Tool \S+ not found/i.test(e.raw ?? e.message)) {
      return new CityDisabledError('city_disabled', '引擎未开启东京城市模块（city.enabled）。', {
        tool,
        ...(requestId ? { requestId } : {}),
        cause: e,
      });
    }
    const parsed = parseToolErrorText(e.raw ?? e.message);
    const rawUpper = (e.code ?? parsed.code ?? '').toUpperCase();
    if (rawUpper === 'NOT_FOUND' && tool === 'enter_world') {
      return new CityDisabledError('city_disabled', parsed.message || '引擎未开启东京城市世界（world_id="tokyo"）。', {
        tool,
        data: parsed.data,
        ...(parsed.hint ? { hint: parsed.hint } : {}),
        ...(requestId ? { requestId } : {}),
        cause: e,
      });
    }
    const code = mapRawCityCode(rawUpper);
    const { reason, ...rest } = parsed.data;
    const Cls = CITY_ERROR_CLASSES[code];
    return new Cls(code, parsed.message, {
      tool,
      ...(typeof reason === 'string' ? { reason } : {}),
      data: rest,
      ...(parsed.hint ? { hint: parsed.hint } : {}),
      ...(requestId ? { requestId } : {}),
      cause: e,
    });
  }
  const msg = e instanceof Error ? e.message : String(e);
  const mcpCode = (e as { code?: unknown } | null)?.code;
  if (mcpCode === -32602 && /not found/i.test(msg)) {
    return new CityDisabledError('city_disabled', '引擎未开启东京城市模块（工具不存在）。', {
      tool,
      ...(requestId ? { requestId } : {}),
      cause: e,
    });
  }
  return new CityNetworkError('network', `${tool}：${msg}`, {
    tool,
    ...(requestId ? { requestId } : {}),
    cause: e,
  });
}

/** 业务规则拒绝：丢弃本次决策意图、重读 get_my_view 后用新 request_id 重新决策。 */
export function isCityDiscardError(e: unknown): boolean {
  return (
    e instanceof CityClientError &&
    (e.code === 'precondition_failed' || e.code === 'conflict' || e.code === 'not_found' || e.code === 'bad_request')
  );
}

/** 进城致命拒绝（准入拦截、室友密钥、城市未开、参数错误）：运行器应立即停止，绝不循环重试。 */
export function isFatalCityEnterError(e: unknown): boolean {
  return (
    e instanceof CityClientError &&
    (e.code === 'entry_via_home_only' || e.code === 'forbidden' || e.code === 'city_disabled' || e.code === 'bad_request')
  );
}

// ───────────────────────── CityClient ─────────────────────────

export interface CityClientOptions {
  /** 客户端稳定标识（4~60 位字母数字或 ._-）；重连沿用同一 clientId 可无缝续持控制权 */
  clientId?: string;
  /** 世界 ID，固定默认 "tokyo" */
  worldId?: string;
  /** 自动生成请求号的前缀（默认 "city"） */
  requestIdPrefix?: string;
  /** RECOVERING / RATE_LIMITED / 网络错误时带原 request_id 的最大重试次数（默认 3） */
  maxRetries?: number;
  /** 退避重试基础间隔毫秒（默认 500，指数递增） */
  retryBaseMs?: number;
  /** RATE_LIMITED 最大愿意等待毫秒数（默认 15000；超出则直接抛 CityRateLimitedError） */
  rateLimitMaxWaitMs?: number;
  /** 普通调用超时毫秒（默认 60000） */
  timeoutMs?: number;
  /** 可注入睡眠函数（便于单测假时钟验证退避） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CityClientState {
  residentId: string | null;
  actionWindow: string;
  contextVersion: number;
  controlEpoch: number;
  controlMine: boolean;
  cursor: string | null;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function normalizeView<T extends Record<string, any>>(raw: T): T & CityView {
  const controlRaw = raw.control as { epoch?: unknown; mine?: unknown } | undefined;
  const control: CityControlState =
    controlRaw && typeof controlRaw.epoch === 'number' && typeof controlRaw.mine === 'boolean'
      ? { epoch: controlRaw.epoch, mine: controlRaw.mine }
      : { epoch: 0, mine: true };
  const lockerItems = Array.isArray(raw.locker_items) ? (raw.locker_items as CityLockerItemView[]) : [];
  return {
    ...raw,
    control,
    locker_items: lockerItems,
  } as T & CityView;
}

export class CityClient {
  readonly clientId: string;
  readonly worldId: string;
  readonly state: CityClientState = {
    residentId: null,
    actionWindow: 'tokyo',
    contextVersion: 0,
    controlEpoch: 0,
    controlMine: true,
    cursor: null,
  };
  lastView: CityView | null = null;

  private readonly caller: ToolCaller;
  private readonly o: {
    maxRetries: number;
    retryBaseMs: number;
    rateLimitMaxWaitMs: number;
    requestIdPrefix: string;
    timeoutMs: number;
  };
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(caller: ToolCaller | BotGameClient, opts: CityClientOptions = {}) {
    this.caller = caller as ToolCaller;
    this.clientId = opts.clientId ?? `cc-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    if (!/^[\w.-]{4,60}$/.test(this.clientId)) {
      throw new Error('clientId 需要 4~60 位字母、数字或 ._-');
    }
    this.worldId = opts.worldId ?? CITY_WORLD_ID;
    this.o = {
      maxRetries: opts.maxRetries ?? 3,
      retryBaseMs: opts.retryBaseMs ?? 500,
      rateLimitMaxWaitMs: opts.rateLimitMaxWaitMs ?? 15_000,
      requestIdPrefix: opts.requestIdPrefix ?? 'city',
      timeoutMs: opts.timeoutMs ?? 60_000,
    };
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** 连接 MCP 服务器并包装为 CityClient。 */
  static async connect(opts: BotGameClientOptions & CityClientOptions): Promise<CityClient> {
    return new CityClient(await BotGameClient.connect(opts), opts);
  }

  async close(): Promise<void> {
    await this.caller.close?.();
  }

  /** 生成符合 /^[\w.:-]{8,80}$/ 的幂等请求号。 */
  newRequestId(): string {
    return `${this.o.requestIdPrefix}-${randomUUID()}`;
  }

  private async raw<T>(
    tool: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal; requestId?: string } = {},
  ): Promise<T> {
    try {
      return await this.caller.call<T>(tool, args, opts.timeoutMs ?? this.o.timeoutMs, opts.signal);
    } catch (e) {
      throw toCityError(e, tool, opts.requestId);
    }
  }

  private applyView(v: CityView, adoptCursor: boolean): void {
    this.lastView = v;
    this.state.residentId = v.me?.id ?? this.state.residentId;
    this.state.actionWindow = v.action_window ?? this.state.actionWindow;
    this.state.contextVersion = v.context?.version ?? this.state.contextVersion;
    this.state.controlEpoch = v.control.epoch;
    this.state.controlMine = v.control.mine;
    if (adoptCursor || !this.state.cursor) {
      this.state.cursor = v.cursor;
    }
  }

  // ── 进出城、视图与控制权 ──

  /**
   * 进入东京都（world_id = "tokyo"）。
   * 首次进城需传 name，发放一次性启动日元；后续重入回到原地点或在途电车。
   * 默认 claim = false：若已有另一活跃客户端持有控制权，返回 control.mine === false（只读旁观，不暗抢）。
   */
  async enterWorld(opts: CityEnterOptions = {}): Promise<CityEnterResult> {
    const raw = await this.raw<Record<string, any>>(
      'enter_world',
      {
        world_id: this.worldId,
        client_id: this.clientId,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.bio !== undefined ? { bio: opts.bio } : {}),
        ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
        ...(opts.claim !== undefined ? { claim: opts.claim } : {}),
      },
      { ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    const res = normalizeView(raw) as CityEnterResult;
    this.applyView(res, true);
    this.state.residentId = res.resident_id ?? this.state.residentId;
    return res;
  }

  /** enterWorld 的简写别名。 */
  enter(opts?: CityEnterOptions): Promise<CityEnterResult> {
    return this.enterWorld(opts);
  }

  /** 读取本人视图（selfView）。resetCursor=true 时将本地等待游标同步到视图最新水位。 */
  async view(opts: { cursor?: string; waitSeconds?: number; resetCursor?: boolean; signal?: AbortSignal } = {}): Promise<CityView> {
    const waitSec = opts.waitSeconds !== undefined ? Math.max(0, Math.min(50, Math.floor(opts.waitSeconds))) : undefined;
    const raw = await this.raw<Record<string, any>>(
      'get_my_view',
      {
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(waitSec !== undefined && waitSec > 0 ? { wait_seconds: waitSec } : {}),
      },
      {
        timeoutMs: waitSec ? Math.max(this.o.timeoutMs, (waitSec + 30) * 1000) : this.o.timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    const v = normalizeView(raw);
    this.applyView(v, Boolean(opts.resetCursor));
    return v;
  }

  /** 长轮询本人私有事件并续在场租约。 */
  async wait(opts: CityWaitOptions = {}): Promise<CityWaitResult> {
    const cursor = opts.cursor ?? this.state.cursor;
    if (!cursor) {
      throw new Error('CityClient.wait：尚未初始化游标，请先调用 enterWorld() 或 view()。');
    }
    const seconds = Math.max(0, Math.min(50, Math.floor(opts.waitSeconds ?? 25)));
    const r = await this.raw<CityWaitResult>(
      'world_wait',
      { cursor, wait_seconds: seconds },
      {
        timeoutMs: Math.max(this.o.timeoutMs, (seconds + 30) * 1000),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!r.resync && r.cursor) {
      this.state.cursor = r.cursor;
    }
    if (r.control) {
      this.state.controlEpoch = r.control.epoch;
      this.state.controlMine = r.control.mine;
    }
    return r;
  }

  /** 显式接管当前居民控制权（递增 control_epoch）。仅在宿主明确要求接管时调用。 */
  async claimControl(opts: { signal?: AbortSignal } = {}): Promise<CityClaimResult> {
    const r = await this.raw<CityClaimResult>('claim_control', {}, { ...(opts.signal ? { signal: opts.signal } : {}) });
    if (r.control) {
      this.state.controlEpoch = r.control.epoch;
      this.state.controlMine = r.control.mine;
    }
    return r;
  }

  /** claimControl 的简写别名。 */
  claim(opts?: { signal?: AbortSignal }): Promise<CityClaimResult> {
    return this.claimControl(opts);
  }

  /** 续期在场租约（零模型事件）。 */
  async heartbeat(opts: { signal?: AbortSignal } = {}): Promise<CityHeartbeatResult> {
    const r = await this.raw<CityHeartbeatResult>('heartbeat', {}, { ...(opts.signal ? { signal: opts.signal } : {}) });
    if (r.control) {
      this.state.controlEpoch = r.control.epoch;
      this.state.controlMine = r.control.mine;
    }
    return r;
  }

  /** 主动离开东京休息：立即下线释放控制权，日元、背包、储物柜与在途电车保留。 */
  async leaveWorld(opts: { signal?: AbortSignal } = {}): Promise<{ ok: true }> {
    const r = await this.raw<{ ok: true }>('leave_world', {}, { ...(opts.signal ? { signal: opts.signal } : {}) });
    this.state.controlMine = false;
    return r;
  }

  /** leaveWorld 的简写别名。 */
  leave(opts?: { signal?: AbortSignal }): Promise<{ ok: true }> {
    return this.leaveWorld(opts);
  }

  /** 查询公开城市视图、在场居民、聊天历史或路线票价预览。 */
  query<T = any>(
    what: CityQueryWhat,
    opts: { before?: number | string; limit?: number; from?: string; to?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.raw<T>(
      'world_query',
      {
        world_id: this.worldId,
        what,
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
      },
      { ...(opts.signal ? { signal: opts.signal } : {}) },
    );
  }

  // ── 幂等写动作 ──

  private async callIdempotentWrite<T>(
    tool: 'world_act' | 'speak',
    buildArgs: (requestId: string) => Record<string, unknown>,
    opts: CityActOptions = {},
  ): Promise<T> {
    const requestId = opts.requestId ?? this.newRequestId();
    if (!/^[\w.:-]{8,80}$/.test(requestId)) {
      throw new Error('requestId 需要 8~80 个字符，仅允许字母、数字、下划线和 . : -');
    }
    const retryNetwork = opts.retryNetwork ?? true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.caller.call<T>(tool, buildArgs(requestId), this.o.timeoutMs, opts.signal);
      } catch (rawErr) {
        const e = toCityError(rawErr, tool, requestId);
        if (!(e instanceof CityClientError)) throw e;
        if (e.code === 'control_lost') {
          this.state.controlMine = false;
          if (e instanceof CityControlLostError && e.control) {
            this.state.controlEpoch = e.control.epoch;
          }
          throw e;
        }
        const canRetry =
          attempt < this.o.maxRetries &&
          !opts.signal?.aborted &&
          (e.code === 'recovering' || e.code === 'rate_limited' || (retryNetwork && e.code === 'network'));
        if (!canRetry) throw e;
        const waitMs =
          e instanceof CityRateLimitedError
            ? (e.retryAfterMs ?? this.o.retryBaseMs) + 50
            : this.o.retryBaseMs * 2 ** attempt;
        if (e.code === 'rate_limited' && waitMs > this.o.rateLimitMaxWaitMs) {
          throw e;
        }
        await this.sleep(waitMs, opts.signal);
      }
    }
  }

  /** 提交一条城市动作（world_act），自带 request_id 幂等生成与安全退避重试。 */
  async act(action: CityAction, opts: CityActOptions = {}): Promise<CityActResult> {
    return this.callIdempotentWrite<CityActResult>(
      'world_act',
      (requestId) => ({
        request_id: requestId,
        action_window: opts.actionWindow ?? this.state.actionWindow,
        context_version: opts.contextVersion ?? this.state.contextVersion,
        action,
      }),
      opts,
    );
  }

  /** 现场发言（走 MCP speak 工具，同样携带幂等 request_id）。 */
  speak(text: string, opts: CityActOptions = {}): Promise<CityActResult> {
    return this.callIdempotentWrite<CityActResult>(
      'speak',
      (requestId) => ({
        text,
        request_id: requestId,
      }),
      opts,
    );
  }

  // ── 常用动作便捷封装 ──

  travel(to: string, opts?: CityActOptions): Promise<CityActResult> {
    return this.act({ type: 'travel', to }, opts);
  }

  say(text: string, opts?: CityActOptions): Promise<CityActResult> {
    return this.act({ type: 'say', text }, opts);
  }

  buy(sku: string, qty = 1, opts?: CityActOptions): Promise<CityActResult> {
    return this.act({ type: 'buy', sku, qty }, opts);
  }

  consume(target: string | CityItemSelector, qty = 1, opts?: CityActOptions): Promise<CityActResult> {
    const sel = typeof target === 'string' ? { item: target } : { ...(target.itemId ? { item_id: target.itemId } : {}), ...(target.item ? { item: target.item } : {}) };
    return this.act({ type: 'consume', ...sel, qty }, opts);
  }

  give(to: string, target: string | CityItemSelector, qty = 1, opts?: CityActOptions): Promise<CityActResult> {
    const sel = typeof target === 'string' ? { item: target } : { ...(target.itemId ? { item_id: target.itemId } : {}), ...(target.item ? { item: target.item } : {}) };
    return this.act({ type: 'give', to, ...sel, qty }, opts);
  }

  storeLocker(target: string | CityItemSelector, qty = 1, opts?: CityActOptions): Promise<CityActResult> {
    const sel = typeof target === 'string' ? { item: target } : { ...(target.itemId ? { item_id: target.itemId } : {}), ...(target.item ? { item: target.item } : {}) };
    return this.act({ type: 'store_locker', ...sel, qty }, opts);
  }

  takeLocker(target: string | CityItemSelector, qty = 1, opts?: CityActOptions): Promise<CityActResult> {
    const sel = typeof target === 'string' ? { item: target } : { ...(target.itemId ? { item_id: target.itemId } : {}), ...(target.item ? { item: target.item } : {}) };
    return this.act({ type: 'take_locker', ...sel, qty }, opts);
  }

  stampStation(opts?: CityActOptions): Promise<CityActResult> {
    return this.act({ type: 'stamp_station' }, opts);
  }

  updateProfile(patch: { name?: string; bio?: string }, opts?: CityActOptions): Promise<CityActResult> {
    return this.act({ type: 'update_profile', ...patch }, opts);
  }
}
