/**
 * GameRunner：对一条（候选的）GameRecord 执行一步，不持久化、不广播、不持有任何对局。
 *
 * - 普通独立对局：GameManager 持有记录，调用这里的函数推进（pumpGame 等），再自己存档、唤醒等待者。
 * - 持续世界里的小游戏：世界服务的提交协调层拿候选记录调用 GameRunner，
 *   和世界侧的变化（占座、奖励、事件）放进同一个数据库事务；事务失败就丢掉候选记录。
 *
 * 这里的函数都是同步的，不等待模型或网络。
 */
import { badRequest, forbidden, invalidState } from './errors.js';
import type { BaseGame, GameEnv } from './game.js';
import type { GameDefinition, GameRegistry } from './registry.js';
import { shuffle } from './rng.js';
import { parseIntLoose, resolveSeat, sanitizeName, sanitizeUserText, stripTrailing } from './text.js';
import type { ActionInput, GameRecord, LogEntry, ParticipantKind, PendingRequest, PhaseState, Player, Seat } from './types.js';

const MAX_PUMP = 200;

export interface TodoView {
  prompt: string;
  kind: 'speech' | 'action';
  actions: PendingRequest['actions'];
  seconds_left: number | null;
}

/** 阶段是否可以开放：自动主持直接放行；否则等裁判拿走此前的门控消息。 */
export function gateOpen(rec: GameRecord, ph: PhaseState): boolean {
  if (rec.autoReferee) return true;
  const cursor = rec.referee?.cursor ?? 0;
  if (cursor >= ph.gateSeq) return true;
  // 网页舞台的群镜像不门控：只等还没交付的门控消息
  return !rec.outbox.some((d) => d.seq > cursor && d.seq <= ph.gateSeq && !d.noGate);
}

/**
 * 推进：开放已到达的阶段、结算已完成的阶段；processTimeouts 时还会处理超时（托管）。
 * forfeited：已主动离席的座位，轮到时立刻按超时规则托管。
 * 返回是否有变化。
 */
export function pumpGame(rec: GameRecord, inst: BaseGame, now: () => number, processTimeouts: boolean, forfeited?: ReadonlySet<Seat>): boolean {
  let changed = false;
  for (let i = 0; i < MAX_PUMP; i++) {
    const ph = rec.phase;
    if (rec.status !== 'running' || !ph) break;
    if (ph.gateSeq === -1) ph.gateSeq = rec.outboxSeq;
    const t = now();
    if (ph.openedAt === null) {
      if (!gateOpen(rec, ph)) break;
      ph.openedAt = t;
      ph.deadline = t + ph.timeoutMs;
      changed = true;
    }
    if (forfeited && forfeited.size > 0) {
      let any = false;
      for (const seat of forfeited) {
        if (rec.phase !== ph) break;
        if (inst.forfeitSeat(seat)) any = true;
      }
      if (any) changed = true;
      if (rec.phase !== ph) continue;
    }
    if (inst.isPhaseComplete()) {
      if (ph.minDurationMs > 0 && t < ph.openedAt + ph.minDurationMs) break;
      const before = ph.id;
      inst.advance();
      changed = true;
      if (rec.status === 'running' && rec.phase?.id === before && inst.isPhaseComplete()) {
        throw new Error(`[${rec.type}] advance() 未推进阶段 ${ph.key}`);
      }
      continue;
    }
    if (processTimeouts && ph.deadline !== null && t >= ph.deadline) {
      inst.onTimeout();
      changed = true;
      if (rec.phase === ph && !inst.isPhaseComplete()) {
        // onTimeout 未能补齐所有待办（不应发生），强制标记
        for (const r of Object.values(ph.pending)) r.done = true;
      }
      continue;
    }
    if (processTimeouts && inst.remindPending()) changed = true;
    break;
  }
  if (rec.phase && rec.phase.gateSeq === -1) rec.phase.gateSeq = rec.outboxSeq;
  return changed;
}

/** 把外部传入的动作参数清洗成 ActionInput（数字取整、目标解析成座位号、文字过 sanitize）。 */
export function normalizeActionInput(rec: GameRecord, raw: ActionInput & Record<string, unknown>): ActionInput {
  const action = String(raw.action ?? '').trim();
  if (!action) throw badRequest('需要 action。');
  const out: ActionInput = { action };
  const toInt = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    const n = parseIntLoose(stripTrailing(String(v)).replace(/号$/u, ''));
    if (n === null) throw badRequest(`无法识别的数字：${String(v)}`);
    return n;
  };
  const rawTarget: unknown = raw.target;
  if (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') {
    if (typeof rawTarget === 'number') out.target = Math.trunc(rawTarget);
    else {
      const seat = resolveSeat(String(rawTarget), rec.players);
      if (seat === null) throw badRequest(`无法识别的目标：${String(rawTarget)}（请填座位号数字）`);
      out.target = seat;
    }
  }
  const q = toInt(raw.quantity);
  if (q !== undefined) out.quantity = q;
  const f = toInt(raw.face);
  if (f !== undefined) out.face = f;
  const num = toInt(raw.number);
  if (num !== undefined) out.number = num;
  if (typeof raw.text === 'string') out.text = sanitizeUserText(raw.text);
  if (typeof raw.card === 'string') out.card = sanitizeUserText(raw.card).slice(0, 40);
  if (typeof raw.color === 'string') out.color = sanitizeUserText(raw.color).slice(0, 20);
  if (raw.call !== undefined && raw.call !== null) {
    if (typeof raw.call !== 'boolean') throw badRequest('call 必须是 true 或 false。');
    out.call = raw.call;
  }
  return out;
}

/** 某座位当前的待办（阶段没开放或已行动则为 null）。 */
export function todoOf(rec: GameRecord, seat: Seat, now: number): TodoView | null {
  const ph = rec.phase;
  if (rec.status !== 'running' || !ph || ph.openedAt === null) return null;
  const req = ph.pending[String(seat)];
  if (!req || req.done) return null;
  return {
    prompt: req.prompt,
    kind: req.kind,
    actions: req.actions,
    seconds_left: ph.deadline === null ? null : Math.max(0, Math.round((ph.deadline - now) / 1000)),
  };
}

export function phaseHeaderOf(rec: GameRecord, now: number) {
  const ph = rec.phase;
  if (!ph) return null;
  return {
    key: ph.key,
    title: ph.title,
    round: ph.round,
    open: ph.openedAt !== null,
    seconds_left: ph.deadline === null ? null : Math.max(0, Math.round((ph.deadline - now) / 1000)),
    waiting_for: ph.secret
      ? '（秘密阶段，不公开等待对象）'
      : Object.values(ph.pending)
          .filter((r) => !r.done)
          .map((r) => `${r.seat}号`)
          .join('、') || '无',
  };
}

export interface EmbeddedEntry {
  /** 稳定的玩家标识（持续世界里是 residentId，不是 QQ 号） */
  id: string;
  name: string;
  kind: ParticipantKind;
}

export interface CreateEmbeddedInput {
  gameId: string;
  type: string;
  worldId: string;
  activityId: string;
  options?: Record<string, unknown>;
  entries: EmbeddedEntry[];
}

/** 嵌入小游戏某座位的视图（只含公开信息和这个座位自己的私密信息）。 */
export interface EmbeddedSeatView {
  game_id: string;
  type: string;
  name: string;
  status: GameRecord['status'];
  round: number;
  phase: ReturnType<typeof phaseHeaderOf>;
  /** 稳定的阶段编号：提交动作时带上，服务端据此拒绝上一阶段迟到的动作 */
  phase_id: number | null;
  players: { seat: Seat; name: string; kind: ParticipantKind; alive: boolean }[];
  public: Record<string, unknown>;
  you?: Record<string, unknown>;
  your_turn?: boolean;
  todo?: TodoView | null;
  events: { seq: number; round: number; kind: string; text: string; private?: true }[];
  result?: GameRecord['result'];
  aborted?: string | true;
}

export class GameRunner {
  constructor(readonly registry: GameRegistry) {}

  def(type: string): GameDefinition {
    const def = this.registry.get(type);
    if (!def) throw new Error(`未注册的游戏类型：${type}`);
    return def;
  }

  inst(rec: GameRecord, env: GameEnv): BaseGame {
    return this.def(rec.type).create(rec, env);
  }

  /** 校验选项与人数（不创建记录）。返回解析后的选项。 */
  check(type: string, options: Record<string, unknown> | undefined, entries: readonly EmbeddedEntry[]): unknown {
    const def = this.def(type);
    if (!def.embeddable) throw forbidden(`${def.name}还没有通过嵌入持续世界的接入检查。`);
    const parsed = def.optionsSchema.safeParse(options ?? {});
    if (!parsed.success) {
      throw badRequest(`选项无效：${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；')}`);
    }
    const n = entries.length;
    if (n < def.minPlayers || n > def.maxPlayers) throw invalidState(`${def.name}需要 ${def.minPlayers}~${def.maxPlayers} 名玩家，当前 ${n} 名。`);
    const extra = def.checkStart?.(n, parsed.data, entries.map((e) => ({ id: e.id, name: e.name, kind: e.kind })));
    if (extra) throw invalidState(extra);
    return parsed.data;
  }

  /**
   * 内部活动创建路径：直接生成一条已开局的记录（程序自动主持、不产生任何 QQ 消息、不发座位链接）。
   * 规则、人数范围、超时行为都沿用游戏定义；随机座位照旧由程序抽。
   */
  create(input: CreateEmbeddedInput, env: GameEnv): GameRecord {
    const def = this.def(input.type);
    const options = this.check(input.type, input.options, input.entries);
    const now = env.now();
    const randomSeats = (options as { random_seats?: boolean } | undefined)?.random_seats !== false;
    const ordered = randomSeats ? shuffle(env.rng, input.entries) : [...input.entries];
    const players: Player[] = ordered.map((e, i) => ({
      seat: i + 1,
      id: e.id,
      name: sanitizeName(e.name),
      kind: e.kind,
      alive: true,
      selfPost: false,
    }));
    const rec: GameRecord = {
      id: input.gameId,
      type: def.type,
      groupId: `world:${input.worldId}`,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      endedAt: null,
      hostId: `world:${input.worldId}`,
      options,
      lobby: [],
      referee: null,
      standbyReferees: [],
      autoReferee: true,
      players,
      round: 0,
      phase: null,
      phaseCounter: 0,
      log: [],
      logSeq: 0,
      outbox: [],
      outboxSeq: 0,
      notBeforeFloor: 0,
      result: null,
      state: {},
      stage: 'web',
      embed: { worldId: input.worldId, activityId: input.activityId },
      delivery: 'embedded_web',
    };
    const inst = def.create(rec, env);
    inst.systemAnnounce(
      `🎲【${def.name}】开始！本局由程序自动主持。\n座位表（程序随机分配）：\n${players.map((p) => `${p.seat}号 ${p.name}${p.kind === 'human' ? '（真人）' : '（AI）'}`).join('\n')}`,
    );
    inst.start();
    pumpGame(rec, inst, env.now, false);
    rec.updatedAt = env.now();
    return rec;
  }

  /** 某座位提交一个动作（真人和 AI 走同一条路径）。返回游戏给本人的回执文字。 */
  act(rec: GameRecord, env: GameEnv, seat: Seat, raw: ActionInput & Record<string, unknown>, forfeited?: ReadonlySet<Seat>): string {
    if (rec.status !== 'running') throw invalidState('这局已经结束了。');
    const p = rec.players.find((x) => x.seat === seat);
    if (!p) throw forbidden('你不是本局玩家。');
    const inst = this.inst(rec, env);
    const input = normalizeActionInput(rec, raw);
    // 真人的结构化动作等同于私聊裁判下指令：保密出价之类的动作不会因为「在群里」被拒
    const message = inst.onAction(seat, input, p.kind === 'agent' ? { via: 'agent' } : { via: 'relay', channel: 'private' });
    pumpGame(rec, inst, env.now, false, forfeited);
    rec.updatedAt = env.now();
    return message;
  }

  /** 定时推进：处理到期的阶段（超时托管）和离席座位。返回是否有变化。 */
  tick(rec: GameRecord, env: GameEnv, forfeited?: ReadonlySet<Seat>): boolean {
    if (rec.status !== 'running') return false;
    const changed = pumpGame(rec, this.inst(rec, env), env.now, true, forfeited);
    if (changed) rec.updatedAt = env.now();
    return changed;
  }

  /** 中止（无胜负）。 */
  abort(rec: GameRecord, env: GameEnv, reason: string): void {
    if (rec.status !== 'running') return;
    rec.status = 'aborted';
    rec.abortReason = reason;
    rec.endedAt = env.now();
    rec.phase = null;
    this.inst(rec, env).systemAnnounce(`⛔ 本局已中止：${reason}`);
    rec.updatedAt = env.now();
  }

  /** 这个座位之后是否确定不会再行动（适配器明确证明时才为 true）。 */
  seatFinished(rec: GameRecord, env: GameEnv, seat: Seat): boolean {
    if (rec.status !== 'running') return true;
    return this.inst(rec, env).seatFinished(seat);
  }

  /**
   * 视图。seat 为 null 时只给公开部分（观战投影）。
   * 嵌入小游戏结束后也不公开别人的私密记录：世界里的一局不走「结束即完整复盘」。
   */
  view(rec: GameRecord, env: GameEnv, seat: Seat | null, opts: { sinceSeq?: number; limit?: number } = {}): EmbeddedSeatView {
    const def = this.def(rec.type);
    const inst = this.inst(rec, env);
    const visible = (e: LogEntry) => e.audience.type === 'public' || (e.audience.type === 'seats' && seat !== null && e.audience.seats.includes(seat));
    // 序号按「该视角可见的事件」重新编号，避免从空档推断别人的私密事件
    const numbered = rec.log.filter(visible).map((e, i) => ({ e, n: i + 1 }));
    const since = opts.sinceSeq ?? 0;
    const events = numbered
      .filter((x) => x.n > since)
      .slice(-(opts.limit ?? 40))
      .map((x) => ({ seq: x.n, round: x.e.round, kind: x.e.kind, text: x.e.text, ...(x.e.audience.type !== 'public' ? { private: true as const } : {}) }));
    const now = env.now();
    const base: EmbeddedSeatView = {
      game_id: rec.id,
      type: rec.type,
      name: def.name,
      status: rec.status,
      round: rec.round,
      phase: phaseHeaderOf(rec, now),
      phase_id: rec.phase && rec.phase.openedAt !== null ? rec.phase.id : null,
      players: rec.players.map((p) => ({ seat: p.seat, name: p.name, kind: p.kind, alive: p.alive })),
      public: inst.publicView(),
      events,
      ...(rec.result ? { result: rec.result } : {}),
      ...(rec.status === 'aborted' ? { aborted: rec.abortReason ?? true } : {}),
    };
    if (seat === null) return base;
    const me = rec.players.find((p) => p.seat === seat);
    if (!me) return base;
    const todo = todoOf(rec, seat, now);
    return { ...base, you: { seat, name: me.name, alive: me.alive, ...inst.privateView(seat) }, your_turn: Boolean(todo), todo };
  }
}
