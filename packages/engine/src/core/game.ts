/**
 * 所有游戏的基类。
 *
 * 子类只需实现：
 *   - start()                开局：分配身份、发身份信息、开启第一个阶段
 *   - onAction()             校验并执行一个动作（非法时抛 GameError）
 *   - advance()              当前阶段所有待办都完成（或超时补齐）后，结算并开启下一阶段 / 结束游戏
 *   - timeoutDefault()       超时时为某个未行动的座位套用默认动作（托管）
 *   - privateView()/publicView()  视角数据
 *   - parseCommand()         把真人的 QQ 文本解析成动作
 *   - randomAction()         （可选）生成随机合法动作，用于模拟/测试
 *
 * 子类不得在实例上保存状态：所有状态都放在 this.rec.state / this.rec.phase.data 中（可序列化）。
 */
import { GameError, invalidAction, invalidState } from './errors.js';
import type { Rng } from './rng.js';
import { cleanSpeech, formatDuration } from './text.js';
import {
  PUBLIC,
  type ActionInput,
  type ActionMeta,
  type ActionSpec,
  type Audience,
  type Delivery,
  type DeliveryCategory,
  type DeliveryTarget,
  type GameRecord,
  type GameResult,
  type LogEntry,
  type MessageSegment,
  type PendingRequest,
  type PhaseState,
  type Player,
  type Seat,
} from './types.js';

export interface GameEnv {
  now(): number;
  rng: Rng;
}

export interface PhaseRequestSpec {
  seat: Seat;
  kind?: 'speech' | 'action';
  prompt: string;
  actions: ActionSpec[];
  /** 真人在哪里回应，默认 group。private 时会自动私聊提示真人。 */
  channel?: 'group' | 'private';
}

export interface OpenPhaseSpec {
  key: string;
  title: string;
  requests: PhaseRequestSpec[];
  timeoutMs: number;
  secret?: boolean;
  minDurationMs?: number;
  data?: Record<string, any>;
}

export interface AnnounceOptions {
  kind?: string;
  data?: Record<string, unknown>;
  delayMs?: number;
  category?: DeliveryCategory;
}

export interface TellOptions {
  kind?: string;
  data?: Record<string, unknown>;
  category?: DeliveryCategory;
}

const AT_RE = /\{@(\d+)\}/g;
/** 限时短于这个值的阶段不发过半提醒。 */
const REMIND_MIN_MS = 60_000;

export abstract class BaseGame<S = any, O = any> {
  constructor(
    readonly rec: GameRecord<S, O>,
    protected readonly env: GameEnv,
  ) {}

  // ───────────────────────── 子类实现 ─────────────────────────

  abstract start(): void;
  abstract onAction(seat: Seat, input: ActionInput, meta: ActionMeta): string;
  abstract advance(): void;
  abstract privateView(seat: Seat): Record<string, unknown>;
  abstract publicView(): Record<string, unknown>;

  /** 超时默认动作（托管）。默认什么都不做（视为放弃）。 */
  protected timeoutDefault(_seat: Seat, _req: PendingRequest): void {}

  /** 解析真人的文字指令。返回 null 表示与游戏无关 / 无法识别。 */
  parseCommand(_seat: Seat, _text: string, _channel: 'group' | 'private'): ActionInput | null {
    return null;
  }

  /** 为某座位生成一个随机合法动作（模拟器使用）。返回 null 表示无可用动作。 */
  randomAction(_seat: Seat): ActionInput | null {
    return null;
  }

  // ───────────────────────── 框架调用 ─────────────────────────

  /** 当前阶段到期：给未行动者套用默认动作并标记完成，随后由管理器调用 advance()。 */
  onTimeout(): void {
    const ph = this.rec.phase;
    if (!ph) return;
    for (const seat of this.unresolvedSeats()) {
      const req = ph.pending[String(seat)]!;
      this.timeoutDefault(seat, req);
      // timeoutDefault 可能已经推进到新阶段；只有仍是同一阶段时才标记
      if (this.rec.phase === ph) req.done = true;
      if (this.rec.phase !== ph) return;
    }
  }

  /** 当前阶段是否所有待办都已完成。 */
  isPhaseComplete(): boolean {
    const ph = this.rec.phase;
    if (!ph) return false;
    return Object.values(ph.pending).every((r) => r.done);
  }

  // ───────────────────────── 基础帮助 ─────────────────────────

  now(): number {
    return this.env.now();
  }

  get rng(): Rng {
    return this.env.rng;
  }

  get options(): O {
    return this.rec.options;
  }

  get state(): S {
    return this.rec.state;
  }

  get players(): Player[] {
    return this.rec.players;
  }

  get phase(): PhaseState | null {
    return this.rec.phase;
  }

  player(seat: Seat): Player {
    const p = this.rec.players.find((pl) => pl.seat === seat);
    if (!p) throw invalidAction(`座位 ${seat} 不存在（本局座位为 1~${this.rec.players.length}）`);
    return p;
  }

  hasSeat(seat: unknown): seat is Seat {
    return typeof seat === 'number' && this.rec.players.some((p) => p.seat === seat);
  }

  isAlive(seat: Seat): boolean {
    return this.rec.players.some((p) => p.seat === seat && p.alive);
  }

  aliveSeats(): Seat[] {
    return this.rec.players.filter((p) => p.alive).map((p) => p.seat);
  }

  allSeats(): Seat[] {
    return this.rec.players.map((p) => p.seat);
  }

  /** 群消息里的 @ 占位符，渲染时会变成真正的 @。 */
  at(seat: Seat): string {
    return `{@${seat}}`;
  }

  /** 「3号 小明」 */
  label(seat: Seat): string {
    const p = this.player(seat);
    return `${p.seat}号 ${p.name}`;
  }

  /** 从 alive 座位里按座位顺序，从 start 开始（含）顺时针排列。 */
  orderFrom(start: Seat, seats: Seat[] = this.aliveSeats()): Seat[] {
    const sorted = [...seats].sort((a, b) => a - b);
    const idx = sorted.findIndex((s) => s >= start);
    if (idx <= 0) return sorted;
    return [...sorted.slice(idx), ...sorted.slice(0, idx)];
  }

  /** 下一个存活座位（顺时针，不含自己）。 */
  nextAlive(from: Seat): Seat | null {
    const alive = this.aliveSeats().sort((a, b) => a - b);
    if (alive.length === 0) return null;
    return alive.find((s) => s > from) ?? alive[0]!;
  }

  // ───────────────────────── 日志与消息 ─────────────────────────

  protected toSegments(text: string): MessageSegment[] {
    const segs: MessageSegment[] = [];
    let last = 0;
    AT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = AT_RE.exec(text))) {
      if (m.index > last) segs.push({ type: 'text', text: text.slice(last, m.index) });
      const p = this.rec.players.find((pl) => pl.seat === Number(m![1]));
      segs.push(p ? { type: 'at', id: p.id, name: p.name } : { type: 'text', text: m[0] });
      last = AT_RE.lastIndex;
    }
    if (last < text.length) segs.push({ type: 'text', text: text.slice(last) });
    return segs;
  }

  protected plain(text: string): string {
    return this.toSegments(text)
      .map((s) => (s.type === 'text' ? s.text : `@${s.name}`))
      .join('');
  }

  /** 写日志（不产生 QQ 消息）。 */
  protected addLog(
    kind: string,
    text: string,
    audience: Audience = PUBLIC,
    extra: { seat?: Seat; data?: Record<string, unknown> } = {},
  ): LogEntry {
    const entry: LogEntry = {
      seq: ++this.rec.logSeq,
      at: this.now(),
      round: this.rec.round,
      phase: this.rec.phase?.key ?? null,
      kind,
      text: this.plain(text),
      audience,
      ...(extra.seat !== undefined ? { seat: extra.seat } : {}),
      ...(extra.data ? { data: extra.data } : {}),
    };
    this.rec.log.push(entry);
    return entry;
  }

  /** 生成一条待裁判发送的消息。 */
  protected pushDelivery(
    target: DeliveryTarget,
    text: string,
    category: DeliveryCategory,
    delayMs = 0,
  ): Delivery {
    const now = this.now();
    const segments = this.toSegments(text);
    const notBefore = Math.max(now + delayMs, this.rec.notBeforeFloor);
    this.rec.notBeforeFloor = notBefore;
    const delivery: Delivery = {
      seq: ++this.rec.outboxSeq,
      createdAt: now,
      notBefore,
      target,
      segments,
      text: segments.map((s) => (s.type === 'text' ? s.text : `@${s.name}`)).join(''),
      mentions: segments.flatMap((s) => (s.type === 'at' ? [{ id: s.id, name: s.name }] : [])),
      category,
    };
    this.rec.outbox.push(delivery);
    return delivery;
  }

  /** 公告：写公开日志 + 让裁判发到群里。文本中可用 this.at(seat) 产生 @。 */
  protected announce(text: string, opts: AnnounceOptions = {}): void {
    this.addLog(opts.kind ?? 'announce', text, PUBLIC, opts.data ? { data: opts.data } : {});
    this.pushDelivery({ type: 'group', groupId: this.rec.groupId }, text, opts.category ?? 'announce', opts.delayMs ?? 0);
  }

  /** 私密信息：仅该座位可见；若是真人则由裁判私聊发送。 */
  protected tell(seat: Seat, text: string, opts: TellOptions = {}): void {
    this.tellMany([seat], text, opts);
  }

  /** 发给多个座位（如狼队）。每个真人都会收到私聊。 */
  protected tellMany(seats: Seat[], text: string, opts: TellOptions = {}): void {
    if (seats.length === 0) return;
    // 身份牌类消息打上标记：真人私聊问「我身份呢」时可以补发
    const data = opts.category === 'role' ? { ...(opts.data ?? {}), role: true } : opts.data;
    this.addLog(opts.kind ?? 'private', text, { type: 'seats', seats: [...seats] }, data ? { data } : {});
    for (const seat of seats) {
      const p = this.player(seat);
      if (p.kind === 'human') {
        this.pushDelivery({ type: 'private', userId: p.id, name: p.name, seat: p.seat }, text, opts.category ?? 'info');
      }
    }
  }

  /** 仅裁判可见的运维提示（不得包含 bot 身份信息）。 */
  protected refereeNote(text: string): void {
    this.addLog('system', text, { type: 'referee' });
  }

  /** bot 自己发群时，后续消息延后一点，确保 bot 的发言先出现在群里。 */
  protected speechGap(): void {
    const gap = Number((this.rec.options as any)?.speech_gap_ms ?? 3000);
    this.rec.notBeforeFloor = Math.max(this.rec.notBeforeFloor, this.now() + Math.max(0, gap));
  }

  /**
   * 记录一段公开发言。
   * - 真人：已经在群里说过了，只记日志。
   * - bot 且 selfPost：bot 会自己发群，这里只记日志并插入间隔。
   * - bot 且非 selfPost：由裁判代发「【3号 名字】内容」。
   */
  protected recordSpeech(seat: Seat, text: string, kind = 'speech', title?: string): string {
    const p = this.player(seat);
    const clean = cleanSpeech(text);
    this.addLog(kind, `${p.seat}号 ${p.name}${title ? `（${title}）` : ''}：${clean}`, PUBLIC, {
      seat,
      data: { text: clean },
    });
    if (p.kind === 'agent') {
      if (p.selfPost) this.speechGap();
      else
        this.pushDelivery(
          { type: 'group', groupId: this.rec.groupId },
          `【${p.seat}号 ${p.name}${title ? `·${title}` : ''}】${clean}`,
          'speech',
        );
    }
    return clean;
  }

  // ───────────────────────── 阶段管理 ─────────────────────────

  /**
   * 开启新阶段。阶段会在裁判拿到此前产生的所有消息后才真正开放（开始计时、接受动作）。
   * channel=private 的真人待办会自动收到私聊提示。
   */
  protected openPhase(spec: OpenPhaseSpec): PhaseState {
    const pending: Record<string, PendingRequest> = {};
    for (const r of spec.requests) {
      pending[String(r.seat)] = {
        seat: r.seat,
        kind: r.kind ?? 'action',
        prompt: r.prompt,
        actions: r.actions,
        channel: r.channel ?? 'group',
        done: false,
      };
    }
    const phase: PhaseState = {
      id: ++this.rec.phaseCounter,
      key: spec.key,
      title: spec.title,
      round: this.rec.round,
      pending,
      timeoutMs: spec.timeoutMs,
      secret: spec.secret ?? false,
      minDurationMs: spec.minDurationMs ?? 0,
      gateSeq: -1,
      openedAt: null,
      deadline: null,
      remindedAt: null,
      data: spec.data ?? {},
    };
    this.rec.phase = phase;
    for (const req of Object.values(pending)) {
      const p = this.player(req.seat);
      if (p.kind === 'human' && req.channel === 'private') {
        const cmds = req.actions
          .filter((a) => a.command)
          .map((a) => `「${a.command}」`)
          .join(' / ');
        this.tell(
          req.seat,
          `【${spec.title}】${req.prompt}${cmds ? `\n请私聊回复：${cmds}` : ''}\n限时 ${formatDuration(spec.timeoutMs)}。`,
          { kind: 'prompt', category: 'prompt' },
        );
      }
    }
    if ((this.rec.options as any)?.nudge_ai) this.nudgeAgents(phase, spec);
    return phase;
  }

  /**
   * 给只有被 @ 才会醒来的聊天 bot 发一条「请查看行动面板」的群提示（nudge_ai 选项）。
   * - 秘密阶段：@ 全部存活的 AI 玩家。名单不随身份变化，所以不泄露谁有行动。
   * - 公开阶段：只在多人同时行动（如投票）时 @ 有待办的 AI 玩家；单人行动的提示已经 @ 过本人。
   * 只进 outbox，不写日志，视角里看不到它。
   */
  private nudgeAgents(phase: PhaseState, spec: OpenPhaseSpec): void {
    const agents = (seats: Seat[]) => seats.filter((s) => this.player(s).kind === 'agent').sort((a, b) => a - b);
    const todo = Object.values(phase.pending).map((r) => r.seat);
    const targets = phase.secret ? agents(this.aliveSeats()) : todo.length >= 2 ? agents(todo) : [];
    if (targets.length === 0) return;
    this.pushDelivery(
      { type: 'group', groupId: this.rec.groupId },
      `${targets.map((s) => this.at(s)).join(' ')} 【${spec.title}】请调用 get_my_view 查看自己的行动面板：有待办就在 ${formatDuration(spec.timeoutMs)} 内完成，没有就不用回应。`,
      'prompt',
    );
  }

  /**
   * nudge_ai：公开阶段限时过半仍有人没行动时，再在群里 @ 一次（真人和 AI 都 @），每个阶段最多一次。
   * 返回提醒应当发出的时刻；不需要提醒（选项关闭、秘密阶段、限时太短、都已行动、已提醒过）返回 null。
   * 秘密阶段不提醒：谁还没行动本身就是秘密。
   */
  remindAt(): number | null {
    const ph = this.rec.phase;
    if (!(this.rec.options as any)?.nudge_ai || !ph || ph.openedAt === null || ph.secret || ph.remindedAt) return null;
    if (ph.timeoutMs < REMIND_MIN_MS || this.unresolvedSeats().length === 0) return null;
    return ph.openedAt + Math.floor(ph.timeoutMs / 2);
  }

  /** 框架调用：到了提醒时刻就发提醒（只进 outbox，不写日志）。返回是否发了。 */
  remindPending(): boolean {
    const at = this.remindAt();
    const now = this.now();
    if (at === null || now < at) return false;
    const ph = this.rec.phase!;
    ph.remindedAt = now;
    const seats = this.unresolvedSeats().sort((a, b) => a - b);
    const left = formatDuration(Math.max(0, (ph.deadline ?? now) - now));
    this.pushDelivery(
      { type: 'group', groupId: this.rec.groupId },
      `⏰ ${seats.map((s) => this.at(s)).join(' ')} 【${ph.title}】还剩 ${left}，请尽快行动（真人按提示发指令，AI 调用 get_my_view 查看待办），超时按放弃处理。`,
      'prompt',
    );
    return true;
  }

  /** 当前阶段该座位的未完成待办（不存在返回 undefined）。 */
  protected pendingOf(seat: Seat): PendingRequest | undefined {
    const req = this.rec.phase?.pending[String(seat)];
    return req && !req.done ? req : undefined;
  }

  /** 校验轮到该座位、且动作在允许列表中；返回待办。 */
  protected requireTurn(seat: Seat, action: string): PendingRequest {
    const ph = this.rec.phase;
    if (!ph) throw invalidState('当前没有进行中的阶段。');
    if (ph.openedAt === null)
      throw new GameError('NOT_YOUR_TURN', '本阶段尚未开放（正在等待裁判发布消息），请稍后再试。');
    const req = ph.pending[String(seat)];
    if (!req) throw new GameError('NOT_YOUR_TURN', `现在不是你行动的时候（当前阶段：${ph.title}）。`);
    if (req.done) throw invalidAction(`你在「${ph.title}」已经行动过了。`);
    if (!req.actions.some((a) => a.action === action)) {
      throw invalidAction(
        `当前阶段不能执行「${action}」。可用动作：${req.actions.map((a) => `${a.action}（${a.label}）`).join('、')}`,
      );
    }
    return req;
  }

  /** 校验目标座位在允许列表内。 */
  protected requireTarget(req: PendingRequest, action: string, target: Seat | undefined): Seat {
    const spec = req.actions.find((a) => a.action === action);
    if (target === undefined || target === null) throw invalidAction(`「${spec?.label ?? action}」需要指定目标座位号 target。`);
    if (!this.hasSeat(target)) throw invalidAction(`座位 ${target} 不存在。`);
    if (spec?.targets && !spec.targets.includes(target)) {
      throw invalidAction(`不能选择 ${target} 号。可选目标：${spec.targets.map((s) => `${s}号`).join('、') || '无'}`);
    }
    return target;
  }

  protected markDone(seat: Seat): void {
    const req = this.rec.phase?.pending[String(seat)];
    if (req) req.done = true;
  }

  protected unresolvedSeats(): Seat[] {
    const ph = this.rec.phase;
    if (!ph) return [];
    return Object.values(ph.pending)
      .filter((r) => !r.done)
      .map((r) => r.seat);
  }

  /** 框架使用：发一条系统公告（开局介绍、裁判接管、中止等）。 */
  systemAnnounce(text: string): void {
    this.announce(text, { kind: 'system' });
  }

  /** 框架使用：给某座位发私密回执（真人会收到私聊）。 */
  systemTell(seat: Seat, text: string, category: DeliveryCategory = 'feedback'): void {
    this.tell(seat, text, { kind: 'feedback', category });
  }

  // ───────────────────────── 结束 ─────────────────────────

  /** 结束游戏并公布结果与全部身份。 */
  protected finish(result: GameResult, extraText?: string): void {
    this.rec.result = result;
    const winners = result.winnerSeats.map((s) => this.label(s)).join('、') || '无';
    const reveal = result.reveal.map((r) => `${r.seat}号 ${r.name}：${r.identity}`).join('\n');
    const text =
      `🏁 游戏结束！获胜方：${result.winnerTeam}\n` +
      `原因：${result.reason}\n` +
      `获胜玩家：${winners}\n` +
      (extraText ? `${extraText}\n` : '') +
      `—— 身份揭晓 ——\n${reveal}`;
    this.rec.phase = null;
    this.announce(text, { kind: 'game_over', data: { winnerTeam: result.winnerTeam, winnerSeats: result.winnerSeats } });
    this.rec.status = 'ended';
    this.rec.endedAt = this.now();
  }

  // ───────────────────────── 动作说明构造器 ─────────────────────────

  protected specSpeech(command = '直接在群里发言，说完发送「过」'): ActionSpec {
    return { action: 'speech', label: '发言', example: 'speak({"text":"你的发言内容"})', command };
  }

  protected specTarget(action: string, label: string, targets: Seat[], command: string): ActionSpec {
    return {
      action,
      label,
      targets,
      example: `act({"action":"${action}","target":${targets[0] ?? 1}})`,
      command,
    };
  }

  protected specSkip(label = '放弃', command = '过'): ActionSpec {
    return { action: 'skip', label, example: 'act({"action":"skip"})', command };
  }
}
