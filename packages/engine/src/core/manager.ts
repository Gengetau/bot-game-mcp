/**
 * GameManager：所有对局的权威状态机宿主。
 *
 * 职责划分：
 *  - 程序（本类 + 各游戏实现）：开局抽签选裁判、随机座位、分配身份、校验动作、结算、判胜负、超时托管。
 *  - AI 裁判：调用 refereeStep() 拉取待发送消息并发到 QQ（这一步同时「推进」游戏：
 *    阶段只有在裁判拿到对应公告后才开放计时；超时也在裁判调用时处理），
 *    以及把真人的 QQ 消息原样转发给 relayHumanMessage()，由程序解析。
 *  - bot 玩家：getView()/act()/speak()。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BaseGame, type GameEnv } from './game.js';
import { GameError, badRequest, forbidden, invalidState, notFound } from './errors.js';
import type { AssetStore } from './assets.js';
import type { GameRegistry, GameDefinition } from './registry.js';
import { CryptoRng, pick, shortCode, shuffle, type Rng } from './rng.js';
import type { ClaimRecord, PersistedState, StateStore } from './store.js';
import {
  extractCqAts,
  formatDuration,
  normalizeText,
  parseIntLoose,
  resolveSeat,
  sanitizeName,
  sanitizeUserText,
  cqToSpeech,
  splitTrailingEnd,
  stripTrailing,
} from './text.js';
import type {
  ActionInput,
  Delivery,
  GameRecord,
  GameStatus,
  Identity,
  JoinPreference,
  LobbyEntry,
  LogEntry,
  PendingRequest,
  PhaseState,
  Player,
  RefereeDraw,
  Seat,
} from './types.js';

export interface ManagerOptions {
  registry: GameRegistry;
  now?: () => number;
  rng?: Rng;
  store?: StateStore;
  /** 裁判多久没调用视为失联，可被接管（默认 120 秒）。 */
  refereeStaleMs?: number;
  /** 大厅最长保留时间（默认 2 小时）。 */
  lobbyTtlMs?: number;
  /** 进行中的对局多久无任何变化即自动中止（默认 6 小时）。 */
  idleGameTtlMs?: number;
  /** 最多保留多少个已结束对局（默认 100）。 */
  keepFinishedGames?: number;
  /** 只允许在这些群开房；空数组为不限制。 */
  allowedGroups?: string[];
  /** 整个服务器同时最多几局（报名中 + 进行中）；0 为不限制。 */
  maxActiveGames?: number;
  /** 只有这些 QQ 号能当裁判（抽签、候补、接管）；空数组为不限制。名单外的 AI 只能当玩家。 */
  refereeIds?: string[];
  /** 开房时的默认选项（所有游戏共用，游戏不认识的键会被忽略；开房时传的选项覆盖它）。bot 直接调用 create_game 开的房也生效 */
  defaultOptions?: Record<string, unknown>;
  /** 图片素材（剧本杀线索图）；referee_step 的 inline_images=true 时从这里读图 */
  assets?: AssetStore;
  /** 网页舞台「灯下剧场」的公网地址（如 https://example.com/web/）；开局时拼成观战链接发到群里。 */
  webUrl?: string;
}

export interface CreateGameInput {
  type: string;
  groupId: string;
  options?: Record<string, unknown>;
  /** 创建者是否加入以及以何种身份加入；none 表示只开房不参加。 */
  joinAs?: JoinPreference | 'none';
  selfPost?: boolean;
  /** 无需 AI 裁判，程序自动推进（测试/模拟/纯 MCP 对战）。 */
  autoReferee?: boolean;
}

export interface GameSummary {
  game_id: string;
  type: string;
  name: string;
  group_id: string;
  status: GameStatus;
  host: string;
  referee: string | null;
  referee_id: string | null;
  /** 裁判事务由哪个代行进程（host_id）执行；null = 裁判账号自己（AI）主持 */
  referee_hosted_by: string | null;
  /** 裁判距上次调用 referee_step 过了多少秒（候补裁判判断是否可以接管） */
  referee_idle_s: number | null;
  players: number;
  min_players: number;
  max_players: number;
  lobby?: { name: string; id: string; kind: string; join_as: JoinPreference; hosted: boolean }[];
  referee_draw?: RefereeDraw | null;
  round: number;
  phase: string | null;
  auto_referee: boolean;
  /** group = 在群里玩；web = 在网页「灯下剧场」上玩，群里只收镜像 */
  stage: 'group' | 'web';
  created_at: string;
}

export interface EventView {
  seq: number;
  round: number;
  kind: string;
  text: string;
  private?: true;
}

export interface TodoView {
  prompt: string;
  kind: 'speech' | 'action';
  actions: PendingRequest['actions'];
  seconds_left: number | null;
}

export interface RefereeStepResult {
  game_id: string;
  group_id: string;
  status: GameStatus;
  deliveries: Delivery[];
  last_seq: number;
  undelivered_later: number;
  phase: ReturnType<GameManager['phaseHeader']>;
  waiting_for: string[];
  next_call_hint: string;
  finished: boolean;
  /** true：裁判事务由代行进程执行，这次调用没有推进也没有消息（调用方这局休息） */
  hosted?: true;
  /** 现在不该在群里说话的 AI 玩家 QQ 号（秘密阶段，例如狼人杀的夜晚；出局的不算）。代码裁判据此撤回并禁言。 */
  /** web = 网页舞台：群消息都是镜像（mirror=true，不门控） */
  stage?: 'group' | 'web';
  quiet_ids?: string[];
  /** 公开阶段正在等的 AI 玩家 QQ 号（秘密阶段为空）。代码裁判据此提醒「在群里说了话却没调用工具」的 bot。 */
  turn_ids?: string[];
  /** 进行中的对局里的所有玩家（含出局的）和裁判的 QQ 号。代码裁判据此管住没参加本局、却在群里插话的 bot。 */
  participant_ids?: string[];
  /** 本局真人玩家（网页舞台上真人在座位网页发言，裁判提醒他们时用不同的说法） */
  human_ids?: string[];
}

export interface RelayResult {
  recognized: boolean;
  accepted: boolean;
  action?: ActionInput;
  message: string;
}

type Waiter = () => void;

const MAX_PUMP = 200;
/** 观众席：每条最多几个字、每人每个时间窗最多几条、每局最多留多少条 */
const SPECTATOR_MAX_CHARS = 200;
const SPECTATOR_WINDOW_MS = 30_000;
const SPECTATOR_PER_WINDOW = 5;
const SPECTATOR_KEEP = 500;
const WEB_NO_HUMANS = '本局在网页「灯下剧场」上进行，服务器没有配置网页地址，真人暂时上不了场；想和 AI 一起玩，开房时加上 stage=group（在群里玩）。';

export class GameManager {
  readonly registry: GameRegistry;
  readonly now: () => number;
  readonly rng: Rng;
  private readonly store?: StateStore;
  private readonly refereeStaleMs: number;
  private readonly lobbyTtlMs: number;
  private readonly idleGameTtlMs: number;
  private readonly keepFinishedGames: number;
  private readonly allowedGroups: Set<string>;
  private readonly maxActiveGames: number;
  private readonly refereeIds: Set<string>;
  private readonly defaultOptions: Record<string, unknown>;
  private readonly webUrl: string | undefined;
  /** 这个 QQ 号是不是持有密钥的 AI（由运行时接到鉴权上）。持有密钥的号不能以真人身份报名。 */
  isKeyedAgent: (id: string) => boolean = () => false;

  private readonly games = new Map<string, GameRecord>();
  private readonly assets?: AssetStore;
  private readonly instances = new Map<string, BaseGame>();
  private readonly viewCursors = new Map<string, number>();
  private readonly emitter = new EventEmitter();
  readonly claims = new Map<string, ClaimRecord>();

  constructor(opts: ManagerOptions) {
    this.registry = opts.registry;
    this.now = opts.now ?? (() => Date.now());
    this.rng = opts.rng ?? new CryptoRng();
    this.store = opts.store;
    this.refereeStaleMs = opts.refereeStaleMs ?? 120_000;
    this.lobbyTtlMs = opts.lobbyTtlMs ?? 2 * 3600_000;
    this.idleGameTtlMs = opts.idleGameTtlMs ?? 6 * 3600_000;
    this.keepFinishedGames = opts.keepFinishedGames ?? 100;
    this.allowedGroups = new Set(opts.allowedGroups ?? []);
    this.maxActiveGames = opts.maxActiveGames ?? 0;
    this.refereeIds = new Set(opts.refereeIds ?? []);
    this.defaultOptions = { ...(opts.defaultOptions ?? {}) };
    this.assets = opts.assets;
    this.webUrl = opts.webUrl?.trim() || undefined;
    this.emitter.setMaxListeners(0);
    const loaded = this.store?.load();
    if (loaded) this.restore(loaded);
  }

  // ═══════════════════════════ 持久化 ═══════════════════════════

  snapshot(): PersistedState {
    return {
      version: 1,
      savedAt: this.now(),
      games: [...this.games.values()],
      claims: [...this.claims.values()],
    };
  }

  private restore(state: PersistedState): void {
    for (const g of state.games) this.games.set(g.id, g);
    for (const c of state.claims ?? []) this.claims.set(c.id, c);
  }

  /** 状态变化后：保存 + 唤醒等待者。 */
  /** 观众席限流：key → 最近发言时间 */
  private chatHits = new Map<string, number[]>();

  touch(rec?: GameRecord): void {
    if (rec) {
      // 对局一结束（或中止）真人座位链接就作废
      if (rec.status !== 'running' && rec.seatTokens) delete rec.seatTokens;
      rec.updatedAt = this.now();
      this.emitter.emit(`bump:${rec.id}`);
    }
    this.emitter.emit('change', rec?.id);
    this.store?.schedule(() => this.snapshot());
  }

  flush(): void {
    this.store?.flush();
  }

  /** 订阅任意对局变化（HTTP 观战等使用）。 */
  onChange(listener: (gameId: string | undefined) => void): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  // ═══════════════════════════ 查询 ═══════════════════════════

  private env(): GameEnv {
    return { now: this.now, rng: this.rng };
  }

  private def(rec: GameRecord): GameDefinition {
    const def = this.registry.get(rec.type);
    if (!def) throw new Error(`未注册的游戏类型：${rec.type}`);
    return def;
  }

  private inst(rec: GameRecord): BaseGame {
    let inst = this.instances.get(rec.id);
    if (!inst || inst.rec !== rec) {
      inst = this.def(rec).create(rec, this.env());
      this.instances.set(rec.id, inst);
    }
    return inst;
  }

  getRecord(gameId: string): GameRecord {
    const rec = this.games.get(gameId.trim().toUpperCase());
    if (!rec) throw notFound(`找不到对局 ${gameId}。`, '可调用 list_games 查看进行中的对局。');
    return rec;
  }

  listGames(filter: { groupId?: string; includeFinished?: boolean } = {}): GameSummary[] {
    return [...this.games.values()]
      .filter((g) => (filter.groupId ? g.groupId === filter.groupId : true))
      .filter((g) => filter.includeFinished || g.status === 'lobby' || g.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => this.summary(g));
  }

  summary(rec: GameRecord): GameSummary {
    const def = this.def(rec);
    return {
      game_id: rec.id,
      type: rec.type,
      name: def.name,
      group_id: rec.groupId,
      status: rec.status,
      host: rec.hostId,
      referee: rec.referee ? `${rec.referee.name}(${rec.referee.id})` : null,
      referee_id: rec.referee?.id ?? null,
      referee_hosted_by: rec.referee?.hostedBy ?? null,
      referee_idle_s: rec.referee && rec.status === 'running' ? Math.max(0, Math.round((this.now() - rec.referee.lastSeenAt) / 1000)) : null,
      players: rec.status === 'lobby' ? rec.lobby.filter((e) => e.pref !== 'referee').length : rec.players.length,
      ...this.limitsView(rec),
      ...(rec.status === 'lobby'
        ? { lobby: rec.lobby.map((e) => ({ name: e.name, id: e.id, kind: e.kind, join_as: e.pref, hosted: Boolean(e.hostedBy) })) }
        : {}),
      ...(rec.refereeDraw ? { referee_draw: rec.refereeDraw } : {}),
      round: rec.round,
      phase: rec.phase?.title ?? null,
      auto_referee: rec.autoReferee,
      stage: rec.stage ?? 'group',
      created_at: new Date(rec.createdAt).toISOString(),
    };
  }

  /** 观战链接（网页舞台且配置了 webUrl 时）。 */
  watchUrl(rec: GameRecord): string | null {
    if (rec.stage !== 'web' || !rec.watchToken || !this.webUrl) return null;
    const base = this.webUrl.endsWith('/') ? this.webUrl : `${this.webUrl}/`;
    return `${base}?g=${encodeURIComponent(rec.id)}&t=${encodeURIComponent(rec.watchToken)}`;
  }

  /** 真人座位链接（配置了 webUrl 且这个座位有令牌时）。 */
  seatUrl(rec: GameRecord, seat: Seat): string | null {
    const tok = rec.seatTokens?.[String(seat)];
    if (!tok || !this.webUrl) return null;
    const base = this.webUrl.endsWith('/') ? this.webUrl : `${this.webUrl}/`;
    return `${base}?g=${encodeURIComponent(rec.id)}&s=${encodeURIComponent(tok)}`;
  }

  private seatOf(rec: GameRecord, userId: string): Seat | null {
    return rec.players.find((p) => p.id === userId)?.seat ?? null;
  }

  /**
   * 只认 AI 玩家的座位。真人不调用工具，他的私密信息只通过裁判私聊发给本人；
   * 即使有人（例如 open 模式下）用真人的 QQ 号连上来，也只能看到公开信息。
   */
  private agentSeatOf(rec: GameRecord, userId: string): Seat | null {
    const p = rec.players.find((pl) => pl.id === userId);
    return p && p.kind === 'agent' ? p.seat : null;
  }

  /** 该 QQ 号是否作为真人登记在报名中/进行中的对局里。 */
  isActiveHuman(userId: string): boolean {
    for (const g of this.games.values()) {
      if (g.status === 'lobby' && g.lobby.some((e) => e.id === userId && e.kind === 'human')) return true;
      if (g.status === 'running' && g.players.some((p) => p.id === userId && p.kind === 'human')) return true;
    }
    return false;
  }

  /** 写进对局的昵称一律清洗（去掉 CQ 码、@ 占位符、换行等）。 */
  private nameOf(actor: Identity): string {
    return sanitizeName(actor.name) || actor.id;
  }

  private isReferee(rec: GameRecord, actor: Identity): boolean {
    return rec.referee?.id === actor.id;
  }

  /** 找调用者「当前」的对局：显式 gameId 优先，否则找其参与的进行中/大厅对局。 */
  private resolveGame(actor: Identity, gameId: string | undefined, mode: 'player' | 'referee' | 'any'): GameRecord {
    if (gameId && gameId.trim()) return this.getRecord(gameId);
    const active = [...this.games.values()].filter((g) => g.status === 'running' || g.status === 'lobby');
    const mine = active.filter((g) => {
      const inPlay = g.status === 'running' ? this.seatOf(g, actor.id) !== null : g.lobby.some((e) => e.id === actor.id);
      const asRef = g.referee?.id === actor.id;
      if (mode === 'player') return inPlay;
      if (mode === 'referee')
        return asRef || (g.status === 'lobby' && (g.hostId === actor.id || g.lobby.some((e) => e.id === actor.id)));
      return inPlay || asRef || g.hostId === actor.id;
    });
    if (mine.length === 1) return mine[0]!;
    if (mine.length === 0) {
      // 最近结束的、自己参与过的对局（便于赛后查看结果）
      const recent = [...this.games.values()]
        .filter((g) => g.players.some((p) => p.id === actor.id) || g.referee?.id === actor.id)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (recent && (mode !== 'referee' || recent.referee?.id === actor.id)) return recent;
      throw notFound('你当前没有参与任何对局。', '可调用 list_games 查看，或用 create_game / join_game。');
    }
    const running = mine.filter((g) => g.status === 'running');
    if (running.length === 1) return running[0]!;
    throw badRequest(`你同时参与了多个对局：${mine.map((g) => g.id).join('、')}，请指定 game_id。`);
  }

  private keyedAgentNote(rec: GameRecord, name: string): string {
    return `${name} 是接入了 MCP 的 AI，不能以真人身份报名：请调用 join_game(game_id="${rec.id}", join_as="player")。`;
  }

  /** 这个账号能不能当裁判（服务器配置了 refereeIds 时只有名单里的能） */
  canReferee(id: string): boolean {
    return this.refereeIds.size === 0 || this.refereeIds.has(id);
  }

  /** 名单外的账号：想当裁判就拒绝，「都行」就按玩家处理 */
  private refereeGate(actor: Identity, pref: JoinPreference): JoinPreference {
    if (this.canReferee(actor.id)) return pref;
    if (pref === 'referee') {
      throw forbidden('这台服务器的裁判只从指定账号里抽，你不能当裁判。', '可以 join_as="player" 报名当玩家。');
    }
    return pref === 'either' ? 'player' : pref;
  }

  // ═══════════════════════════ 大厅 ═══════════════════════════

  createGame(actor: Identity, input: CreateGameInput): { summary: GameSummary; group_message: string } {
    const def = this.registry.resolve(input.type);
    if (!def) {
      throw badRequest(
        `未知游戏类型「${input.type}」。`,
        `可选：${this.registry
          .list()
          .map((d) => `${d.type}（${d.name}）`)
          .join('、')}`,
      );
    }
    const groupId = String(input.groupId ?? '').trim();
    if (!groupId) throw badRequest('需要 group_id（QQ 群号）。');
    if (this.allowedGroups.size > 0 && !this.allowedGroups.has(groupId)) {
      throw new GameError('FORBIDDEN', `这台服务器不在群 ${groupId} 开房。`, '只有管理员配置过的群可以开房（allowedGroups）。');
    }
    const activeGames = [...this.games.values()].filter((g) => g.status === 'lobby' || g.status === 'running');
    const existing = activeGames.find((g) => g.groupId === groupId);
    if (!existing && this.maxActiveGames > 0 && activeGames.length >= this.maxActiveGames) {
      const busy = activeGames.map((g) => `${g.id}（群 ${g.groupId}）`).join('、');
      throw new GameError(
        'CONFLICT',
        `这台服务器同时最多开 ${this.maxActiveGames} 局，现在已有：${busy}。`,
        '等它结束或中止后再开。',
      );
    }
    if (existing) {
      throw new GameError(
        'CONFLICT',
        `群 ${groupId} 已有进行中的对局 ${existing.id}（${this.def(existing).name}，${existing.status === 'lobby' ? '报名中' : '进行中'}）。`,
        '同一个群同时只能有一局。可以 join_game 加入它，或由房主/裁判 abort_game 结束后再开。',
      );
    }
    const parsed = def.optionsSchema.safeParse({ ...this.defaultOptions, ...(input.options ?? {}) });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；');
      throw badRequest(`选项无效：${issues}`, `可用选项：${Object.keys(def.optionsHelp).join('、')}（get_rules 可查看说明）`);
    }
    let id: string;
    do id = `${def.idPrefix}-${shortCode(this.rng, 4)}`;
    while (this.games.has(id));

    const now = this.now();
    const rec: GameRecord = {
      id,
      type: def.type,
      groupId,
      status: 'lobby',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      hostId: actor.id,
      options: parsed.data,
      lobby: [],
      referee: null,
      standbyReferees: [],
      autoReferee: Boolean(input.autoReferee),
      players: [],
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
    };
    const wanted = (parsed.data as { stage?: unknown } | undefined)?.stage;
    if (wanted === 'web' && def.stages?.includes('web')) {
      rec.stage = 'web';
      rec.watchToken = randomBytes(18).toString('base64url');
    }
    const rawJoin = input.joinAs ?? 'either';
    const joinAs = rawJoin === 'none' ? 'none' : this.refereeGate(actor, rawJoin);
    if (joinAs !== 'none') {
      rec.lobby.push({ id: actor.id, name: this.nameOf(actor), kind: 'agent', pref: joinAs, selfPost: input.selfPost ?? true, joinedAt: now });
    }
    this.games.set(id, rec);
    this.touch(rec);
    return {
      summary: this.summary(rec),
      group_message:
        `🎮【${def.name}】房间 ${id} 已开启（${this.limitsText(rec)}）！\n` +
        `真人想玩请在群里发送「加入」，AI 玩家调用 join_game 加入。\n` +
        `${rec.autoReferee ? '本局由程序自动主持。' : '本局需要一位 AI 裁判（由程序从报名裁判的 AI 中抽签产生），裁判只负责推进流程和私聊发身份。'}\n` +
        (rec.stage === 'web' ? `🎭 本局在网页「灯下剧场」上进行（真人报名后，开局时裁判私聊发座位链接，在网页上发言和行动；不报名的开局后点链接观战）。\n` : '') +
        `人齐后由房主开始游戏。`,
    };
  }

  joinGame(actor: Identity, gameId: string, opts: { as?: JoinPreference; selfPost?: boolean } = {}) {
    const rec = this.getRecord(gameId);
    const def = this.def(rec);
    const pref = this.refereeGate(actor, opts.as ?? 'either');
    if (rec.status === 'running' && pref === 'referee') {
      if (this.seatOf(rec, actor.id) !== null) throw forbidden('你是本局玩家，不能担任裁判。');
      if (!rec.standbyReferees.some((r) => r.id === actor.id) && rec.referee?.id !== actor.id) {
        rec.standbyReferees.push({ id: actor.id, name: this.nameOf(actor) });
        this.touch(rec);
      }
      return {
        summary: this.summary(rec),
        message: '已登记为候补裁判。若当前裁判失联超过时限，可调用 referee_takeover 接管。',
        group_message: null,
      };
    }
    if (rec.status !== 'lobby') throw invalidState(`对局 ${rec.id} 已${rec.status === 'running' ? '开始' : '结束'}，无法加入。`);
    const existing = rec.lobby.find((e) => e.id === actor.id);
    if (existing && existing.kind === 'human') throw badRequest('该 QQ 号已作为真人玩家报名。');
    const playerCount = rec.lobby.filter((e) => e.pref !== 'referee' && e.id !== actor.id).length;
    const cap = this.lobbyLimits(rec).max;
    // 「玩家或裁判」的报名以前不占名额（可能被抽去当裁判）；人数定死的游戏已经给裁判多留了位置，也要算上
    const counts = pref === 'player' || (pref === 'either' && Boolean(def.playerRange?.(rec.options as never)));
    if (!existing && counts && playerCount >= cap) {
      throw invalidState(`人数已满（${this.limitsText(rec)}）。`, '可以 join_as="referee" 报名当裁判。');
    }
    if (existing) {
      existing.pref = pref;
      existing.name = this.nameOf(actor);
      if (opts.selfPost !== undefined) existing.selfPost = opts.selfPost;
    } else {
      rec.lobby.push({ id: actor.id, name: this.nameOf(actor), kind: 'agent', pref, selfPost: opts.selfPost ?? true, joinedAt: this.now() });
    }
    this.touch(rec);
    const prefText = pref === 'player' ? '玩家' : pref === 'referee' ? '裁判候选' : '玩家或裁判（由程序抽签）';
    return {
      summary: this.summary(rec),
      message: `已${existing ? '更新报名' : '加入'}：${prefText}。`,
      group_message: `✅ ${this.nameOf(actor)} 报名了【${def.name}】（${prefText}），当前 ${this.lobbyCountText(rec)}。`,
    };
  }

  /** 上场人数范围（不含裁判）：游戏按选项定的（如剧本人数），否则 minPlayers~maxPlayers */
  private seatRange(rec: GameRecord): { min: number; max: number } {
    const def = this.def(rec);
    const r = def.playerRange?.(rec.options as never);
    return r ? { min: Math.max(def.minPlayers, r.min), max: Math.min(def.maxPlayers, r.max) } : { min: def.minPlayers, max: def.maxPlayers };
  }

  /**
   * 报名人数范围（不含只当裁判的人）。人数定死的游戏，裁判要从报名玩家里抽时（没有只当裁判的候选、也不是程序主持）多留一个位置。
   */
  private lobbyLimits(rec: GameRecord): { min: number; max: number; slack: number } {
    const r = this.seatRange(rec);
    if (!this.def(rec).playerRange?.(rec.options as never)) return { ...r, slack: 0 };
    const pureReferee = rec.lobby.some((e) => e.kind === 'agent' && e.pref === 'referee' && this.canReferee(e.id));
    const slack = rec.autoReferee || pureReferee ? 0 : 1;
    return { min: r.min + slack, max: r.max + slack, slack };
  }

  private limitsView(rec: GameRecord) {
    const l = this.lobbyLimits(rec);
    const r = this.seatRange(rec);
    return { min_players: l.min, max_players: l.max, ...(l.slack || r.min !== this.def(rec).minPlayers || r.max !== this.def(rec).maxPlayers ? { seats: r } : {}) };
  }

  private limitsText(rec: GameRecord): string {
    const r = this.seatRange(rec);
    const l = this.lobbyLimits(rec);
    const seats = r.min === r.max ? `${r.min} 人` : `${r.min}~${r.max} 人`;
    return l.slack ? `上场 ${seats}，另要一位报名者当裁判，最多报名 ${l.max} 人` : seats;
  }

  private lobbyCountText(rec: GameRecord): string {
    const players = rec.lobby.filter((e) => e.pref === 'player').length;
    const either = rec.lobby.filter((e) => e.pref === 'either').length;
    const refs = rec.lobby.filter((e) => e.pref === 'referee').length;
    return `玩家 ${players} 人${either ? ` + 待定 ${either} 人` : ''}${refs ? `，裁判候选 ${refs} 人` : ''}`;
  }

  /**
   * 代行裁判登记：一个裁判进程（host_id）声明「如果开局抽中这个账号当裁判，裁判事务由我来执行」。
   * 登记过的账号进入开局抽签池（玩家报名的账号被抽中就改当裁判，其余照常入座）；
   * 抽中后，这个账号自己的模型再调 referee_step 只会得到空结果，保证裁判的每句话都是程序发的。
   * 账号还没报名时，自动以 referee 身份报名（纯「嗓子」账号，不参加游戏）。
   */
  offerReferee(actor: Identity, gameId: string, hostId: string, withdraw = false) {
    const rec = this.getRecord(gameId);
    if (rec.status !== 'lobby') throw invalidState(`对局 ${rec.id} 不在报名阶段，不能登记代行裁判。`);
    const host = String(hostId ?? '').trim();
    if (!host || host.length > 100) throw badRequest('需要 host_id（裁判进程的标识，1~100 字符）。');
    if (!withdraw && !this.canReferee(actor.id)) throw forbidden('这台服务器的裁判只从指定账号里抽，你的账号不能进抽签池。');
    let entry = rec.lobby.find((e) => e.id === actor.id);
    if (entry && entry.kind === 'human') throw badRequest('该 QQ 号已作为真人玩家报名。');
    if (withdraw) {
      if (entry) entry.hostedBy = null;
      this.touch(rec);
      return { summary: this.summary(rec), message: '已撤销代行裁判登记。' };
    }
    if (!entry) {
      entry = { id: actor.id, name: this.nameOf(actor), kind: 'agent', pref: 'referee', selfPost: true, joinedAt: this.now() };
      rec.lobby.push(entry);
    }
    entry.hostedBy = host;
    this.touch(rec);
    const pool = rec.lobby.filter((e) => e.hostedBy).length;
    return {
      summary: this.summary(rec),
      message: `已登记：开局若抽中 ${entry.name} 当裁判，由 ${host} 代行。当前抽签池 ${pool} 人。`,
    };
  }

  /** 登记真人玩家（真人不能直接调用工具，由大厅里的任意 AI 代为登记）。 */
  addHuman(actor: Identity, gameId: string, human: { userId: string; name: string }) {
    const rec = this.getRecord(gameId);
    const def = this.def(rec);
    if (rec.status !== 'lobby') throw invalidState('游戏已开始，无法再加入。');
    this.assertLobbyHelper(rec, actor);
    const userId = String(human.userId ?? '').trim();
    const name = sanitizeName(String(human.name ?? '')) || userId;
    if (!userId) throw badRequest('需要真人的 QQ 号 qq_id。');
    if (rec.stage === 'web' && !this.webUrl) throw forbidden(WEB_NO_HUMANS);
    if (this.isKeyedAgent(userId)) throw forbidden(this.keyedAgentNote(rec, name));
    const existing = rec.lobby.find((e) => e.id === userId);
    if (existing) {
      if (existing.kind === 'agent') throw badRequest('该 QQ 号已作为 AI 报名。');
      existing.name = name;
      return { summary: this.summary(rec), message: `${name} 已在名单中。`, group_message: null };
    }
    if (rec.lobby.filter((e) => e.pref !== 'referee').length >= this.lobbyLimits(rec).max) {
      throw invalidState(`人数已满（${this.limitsText(rec)}）。`);
    }
    rec.lobby.push({ id: userId, name, kind: 'human', pref: 'player', selfPost: false, joinedAt: this.now() });
    this.touch(rec);
    return {
      summary: this.summary(rec),
      message: `已登记真人玩家 ${name}(${userId})。`,
      group_message: `✅ ${name} 加入了【${def.name}】，当前 ${this.lobbyCountText(rec)}。开局后身份将由裁判私聊（或群临时会话）发送，请留意。`,
    };
  }

  private assertLobbyHelper(rec: GameRecord, actor: Identity): void {
    if (actor.admin || rec.hostId === actor.id) return;
    if (rec.lobby.some((e) => e.id === actor.id && e.kind === 'agent')) return;
    throw forbidden('只有房主或已报名本局的 AI 才能代为登记/移除真人。', '先调用 join_game 加入本局。');
  }

  leaveGame(actor: Identity, gameId: string, userId?: string) {
    const rec = this.getRecord(gameId);
    if (rec.status === 'running') {
      const who = userId?.trim() || actor.id;
      if (rec.standbyReferees.some((r) => r.id === who)) {
        if (who !== actor.id && !actor.admin && rec.hostId !== actor.id) {
          throw forbidden('只能让自己退出候补裁判（或由房主/管理员移除）。');
        }
        rec.standbyReferees = rec.standbyReferees.filter((r) => r.id !== who);
        this.touch(rec);
        return { summary: this.summary(rec), message: '已退出候补裁判。', group_message: null };
      }
      throw invalidState('游戏进行中不能退出。', '如需提前结束，请房主或裁判调用 abort_game。');
    }
    if (rec.status !== 'lobby') throw invalidState('对局已结束。');
    const target = userId?.trim() || actor.id;
    const entry = rec.lobby.find((e) => e.id === target);
    if (!entry) throw notFound('该用户不在报名名单中。');
    if (target !== actor.id) {
      if (entry.kind === 'agent' && !actor.admin && rec.hostId !== actor.id) throw forbidden('只能移除自己（或由房主移除他人）。');
      if (entry.kind === 'human') this.assertLobbyHelper(rec, actor);
    }
    rec.lobby = rec.lobby.filter((e) => e.id !== target);
    this.touch(rec);
    return {
      summary: this.summary(rec),
      message: `已移除 ${entry.name}。`,
      group_message: `👋 ${entry.name} 退出了报名，当前 ${this.lobbyCountText(rec)}。`,
    };
  }

  startGame(actor: Identity, gameId: string) {
    const rec = this.getRecord(gameId);
    const def = this.def(rec);
    if (rec.status !== 'lobby') throw invalidState(`对局 ${rec.id} 不在报名阶段。`);
    const hostPresent = rec.lobby.some((e) => e.id === rec.hostId);
    const isLobbyAgent = rec.lobby.some((e) => e.id === actor.id && e.kind === 'agent');
    // 服务器指定的裁判账号（refereeIds）报了名也能开局：bot 自己开的房由代码裁判自动开局
    const trustedReferee = this.refereeIds.size > 0 && this.refereeIds.has(actor.id) && isLobbyAgent;
    if (!(actor.admin || rec.hostId === actor.id || (!hostPresent && isLobbyAgent) || trustedReferee)) {
      throw forbidden('只有房主可以开始游戏。');
    }

    // —— 1. 抽签选裁判（程序决定）——
    // 名单外的账号（比如名单收紧之前报的名）不进任何裁判候选
    const must = new Set((def.mustPlay?.(rec.options as never, rec.lobby) ?? []).filter(Boolean));
    const mustPlay = (e: LobbyEntry) => must.has(e.id) || must.has(e.name);
    const agents = rec.lobby.filter((e) => e.kind === 'agent' && this.canReferee(e.id) && !mustPlay(e));
    let referee: LobbyEntry | null = null;
    let standby: LobbyEntry[] = [];
    const refPref = agents.filter((e) => e.pref === 'referee');
    const either = agents.filter((e) => e.pref === 'either');
    // 代行登记过的账号组成抽签池：非玩家的候选随时可抽；玩家报名的候选只有在抽走一人后人数仍够时才可抽
    const playerCount = rec.lobby.filter((e) => e.pref !== 'referee' || mustPlay(e)).length;
    const range = this.seatRange(rec);
    const pool = agents.filter((e) => e.hostedBy && (e.pref === 'referee' || playerCount - 1 >= range.min));
    let draw: RefereeDraw | null = null;
    if (!rec.autoReferee) {
      if (pool.length > 0) {
        referee = pick(this.rng, pool);
        draw = { candidates: pool.map((e) => ({ id: e.id, name: e.name })), picked: referee.id };
        standby = refPref.filter((e) => e !== referee);
      } else if (refPref.length > 0) {
        referee = pick(this.rng, refPref);
        standby = refPref.filter((e) => e !== referee);
      } else if (either.length > 0) {
        referee = pick(this.rng, either);
      } else {
        const lim = this.lobbyLimits(rec);
        if (lim.slack && playerCount < lim.min) {
          throw invalidState(
            `${def.name}需要 ${lim.min - lim.slack} 人上场，另要一位报名者当裁判，当前报名 ${playerCount} 人。`,
            '请再拉人报名（或让一个 AI 以 join_as="referee" 只报名当裁判）。',
          );
        }
        throw invalidState(
          '没有可担任裁判的 AI。',
          '至少需要一个 AI 以 join_as="referee" 或 "either" 报名（裁判不参与游戏，只负责推进和私聊发身份）；或创建对局时设置 auto_referee=true。',
        );
      }
    } else {
      standby = refPref;
    }

    // —— 2. 确定玩家并检查人数 ——
    let entries = rec.lobby.filter((e) => e !== referee && (e.pref !== 'referee' || mustPlay(e)));
    // 人数按选项定死的游戏（剧本杀）：报名多了按报名先后入座（必须上场的人优先），多出的人这局不上场
    let benched: LobbyEntry[] = [];
    if (def.playerRange?.(rec.options as never) && entries.length > range.max) {
      const k = Math.min(range.max, def.seatsFor?.(rec.options as never, entries) ?? range.max);
      const order = [...entries].sort((a, b) => Number(mustPlay(b)) - Number(mustPlay(a)) || a.joinedAt - b.joinedAt);
      const keep = new Set(order.slice(0, k));
      benched = entries.filter((e) => !keep.has(e));
      entries = entries.filter((e) => keep.has(e));
    }
    const n = entries.length;
    if (n < range.min || n > range.max) {
      throw invalidState(
        `${def.name}需要 ${range.min === range.max ? range.min : `${range.min}~${range.max}`} 名玩家，当前 ${n} 名（不含裁判${referee ? ` ${referee.name}` : ''}）。`,
        n < def.minPlayers ? '请继续拉人报名（真人发送「加入」，AI 调用 join_game）。' : '请让部分人退出报名。',
      );
    }
    const extra = def.checkStart?.(n, rec.options, entries.map((e) => ({ id: e.id, name: e.name, kind: e.kind })));
    if (extra) throw invalidState(extra);

    // —— 3. 随机座位 ——
    const randomSeats = (rec.options as any)?.random_seats !== false;
    const ordered = randomSeats ? shuffle(this.rng, entries) : [...entries].sort((a, b) => a.joinedAt - b.joinedAt);
    rec.players = ordered.map<Player>((e, i) => ({
      seat: i + 1,
      id: e.id,
      name: e.name,
      kind: e.kind,
      alive: true,
      // 网页舞台：bot 不自己往群里发言，发言交给引擎，网页显示、群里镜像
      selfPost: e.kind === 'agent' && rec.stage !== 'web' ? e.selfPost : false,
    }));
    rec.referee = referee ? { id: referee.id, name: referee.name, cursor: 0, lastSeenAt: this.now(), hostedBy: referee.hostedBy ?? null } : null;
    rec.standbyReferees = standby.map((e) => ({ id: e.id, name: e.name }));
    rec.refereeDraw = draw;
    rec.status = 'running';
    rec.startedAt = this.now();

    // —— 4. 开局公告 + 游戏初始化 ——
    const inst = this.inst(rec);
    const seatsText = rec.players
      .map((p) => `${p.seat}号 ${inst.at(p.seat)}${p.kind === 'human' ? '（真人）' : '（AI）'}`)
      .join('\n');
    const drawText = draw
      ? `本局裁判：${rec.referee!.name}（程序在 ${draw.candidates.length} 位候选里抽签：${draw.candidates.map((c) => c.name).join('、')}；裁判的话全部由程序生成和发出，不参与游戏、不决定任何结果）\n`
      : rec.referee
        ? `本局裁判：${rec.referee.name}（AI，由程序抽签产生，只负责推进流程，不参与游戏、不决定任何结果）\n`
        : '本局由程序自动主持。\n';
    if (rec.stage === 'web') {
      const link = this.watchUrl(rec);
      inst.mirrorToGroup(
        `🎭 本局在「灯下剧场」网页上进行${link ? `，点开观战：\n${link}` : '（服务器没有配置网页地址，暂时没有观战链接）'}\n` +
          `群里会同步每条发言和环节提示，剧本和线索请在网页上看。参赛的 AI 请不要在群里说话，发言用 speak。`,
      );
    }
    inst.systemAnnounce(
      `🎲【${def.name}】对局 ${rec.id} 开始！\n` +
        drawText +
        `座位表（程序随机分配）：\n${seatsText}\n` +
        (benched.length ? `报名人数超过本局上限，按报名先后入座；${benched.map((e) => e.name).join('、')} 这局没上场。\n` : '') +
        `身份已由程序随机分配${rec.players.some((p) => p.kind === 'human') ? '，真人玩家请查收裁判私聊' : ''}。`,
    );
    this.issueSeatLinks(rec, inst);
    inst.start();
    this.pump(rec, inst, false);
    this.touch(rec);
    return {
      summary: this.summary(rec),
      referee: rec.referee ? { id: rec.referee.id, name: rec.referee.name, hosted_by: rec.referee.hostedBy ?? null } : null,
      referee_draw: draw,
      message: rec.referee
        ? `游戏已开始。裁判是 ${rec.referee.name}(${rec.referee.id})${rec.referee.hostedBy ? `，由 ${rec.referee.hostedBy} 代行` : ''}：裁判请循环调用 referee_step 拉取消息并按顺序发送（群消息发群里，私聊发给对应真人）。`
        : '游戏已开始（程序自动主持）。玩家请调用 get_my_view 查看自己的身份与待办。',
      // 代行时不点名、不提 referee_step：这句话由别的账号发到群里，被抽中账号的模型看到「裁判 X 请开始主持」
      // 会以为要自己主持（2026-11-08 WW-YHVC：克蕾雅调 referee_step 被挡，在群里说流程推不动，局被中止）
      ...(rec.stage === 'web' ? { stage: 'web' as const, watch_url: this.watchUrl(rec) } : {}),
      group_message: !rec.referee
        ? `🎲 ${def.name}开局！`
        : rec.referee.hostedBy
          ? `🎲 ${def.name}开局！本局由程序代为主持，被抽中的裁判账号这局休息，什么都不用做。`
          : `🎲 ${def.name}开局！裁判 ${rec.referee.name} 请开始主持（调用 referee_step）。`,
    };
  }

  abortGame(actor: Identity, gameId: string, reason?: string) {
    const rec = this.getRecord(gameId);
    if (rec.status === 'ended' || rec.status === 'aborted') throw invalidState('对局已经结束。');
    const allowed = actor.admin || rec.hostId === actor.id || this.isReferee(rec, actor);
    if (!allowed) throw forbidden('只有房主、裁判或管理员可以中止对局。');
    const why = sanitizeName((reason ?? '').trim(), 100) || '房主/裁判中止';
    this.closeGame(rec, why);
    return { summary: this.summary(rec), message: `对局已中止：${why}`, group_message: `⛔ 对局 ${rec.id} 已中止：${why}` };
  }

  /** 中止对局（无胜负）。已开局的对局会留下一条群公告，由裁判在下次 referee_step 时发出。 */
  private closeGame(rec: GameRecord, reason: string): void {
    rec.status = 'aborted';
    rec.abortReason = reason;
    rec.endedAt = this.now();
    if (rec.players.length > 0) {
      const inst = this.inst(rec);
      rec.phase = null;
      inst.systemAnnounce(`⛔ 对局 ${rec.id} 已中止：${reason}`);
    }
    this.touch(rec);
  }

  // ═══════════════════════════ 推进循环 ═══════════════════════════

  private gateOpen(rec: GameRecord, ph: PhaseState): boolean {
    if (rec.autoReferee) return true;
    const cursor = rec.referee?.cursor ?? 0;
    if (cursor >= ph.gateSeq) return true;
    // 网页舞台的群镜像不门控：只等还没交付的门控消息
    return !rec.outbox.some((d) => d.seq > cursor && d.seq <= ph.gateSeq && !d.noGate);
  }

  /**
   * 推进：开放已到达的阶段、结算已完成的阶段；processTimeouts 时还会处理超时（托管）。
   * 返回是否有变化。
   */
  private pump(rec: GameRecord, inst: BaseGame, processTimeouts: boolean): boolean {
    let changed = false;
    for (let i = 0; i < MAX_PUMP; i++) {
      const ph = rec.phase;
      if (rec.status !== 'running' || !ph) break;
      if (ph.gateSeq === -1) ph.gateSeq = rec.outboxSeq;
      const now = this.now();
      if (ph.openedAt === null) {
        if (!this.gateOpen(rec, ph)) break;
        ph.openedAt = now;
        ph.deadline = now + ph.timeoutMs;
        changed = true;
      }
      if (inst.isPhaseComplete()) {
        if (ph.minDurationMs > 0 && now < ph.openedAt + ph.minDurationMs) break;
        const before = ph.id;
        inst.advance();
        changed = true;
        if (rec.status === 'running' && rec.phase?.id === before && inst.isPhaseComplete()) {
          throw new Error(`[${rec.type}] advance() 未推进阶段 ${ph.key}`);
        }
        continue;
      }
      if (processTimeouts && ph.deadline !== null && now >= ph.deadline) {
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

  /** 后台计时：自动主持的对局处理超时；清理过期大厅与长期无人推进的对局。 */
  tick(): void {
    const now = this.now();
    for (const rec of [...this.games.values()]) {
      if (rec.status === 'running' && rec.autoReferee) {
        if (this.pump(rec, this.inst(rec), true)) this.touch(rec);
      } else if (rec.status === 'lobby' && now - rec.createdAt > this.lobbyTtlMs) {
        this.closeGame(rec, '报名超时');
      } else if (rec.status === 'running' && now - rec.updatedAt > this.idleGameTtlMs) {
        this.closeGame(rec, '长时间无人推进，自动中止');
      }
    }
    const finished = [...this.games.values()]
      .filter((g) => g.status === 'ended' || g.status === 'aborted')
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
    for (const g of finished.slice(this.keepFinishedGames)) {
      this.games.delete(g.id);
      this.instances.delete(g.id);
      for (const key of [...this.viewCursors.keys()]) if (key.startsWith(`${g.id}:`)) this.viewCursors.delete(key);
    }
  }

  // ═══════════════════════════ 等待 ═══════════════════════════

  private waitBump(gameId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.emitter.off(`bump:${gameId}`, done as Waiter);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      this.emitter.on(`bump:${gameId}`, done as Waiter);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** 长轮询被取消后（客户端超时、断开或服务关闭），结果送不到调用方手里，之后不能再产生任何副作用。 */
  private assertNotCancelled(signal: AbortSignal | undefined, tool: string): void {
    if (signal?.aborted) {
      throw invalidState(`${tool} 调用已被取消（客户端断开、超时或服务关闭），本次没有推进任何游标。`, `请重新调用 ${tool}。`);
    }
  }

  /** 等到 cond 成立或超时（超时按真实时间计算；nextWake 用于在截止时间附近醒来）。 */
  private async waitUntil(
    gameId: string,
    cond: () => boolean,
    maxMs: number,
    signal?: AbortSignal,
    nextWake?: () => number | null,
  ): Promise<void> {
    const realEnd = Date.now() + maxMs;
    while (!cond()) {
      const remaining = realEnd - Date.now();
      if (remaining <= 0 || signal?.aborted) return;
      let sleep = remaining;
      const wake = nextWake?.();
      if (wake !== null && wake !== undefined) sleep = Math.min(sleep, Math.max(0, wake - this.now()) + 20);
      await this.waitBump(gameId, sleep, signal);
    }
  }

  // ═══════════════════════════ 玩家 ═══════════════════════════

  private normalizeInput(rec: GameRecord, raw: ActionInput & Record<string, unknown>): ActionInput {
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

  /** bot 玩家执行动作。 */
  act(actor: Identity, gameId: string | undefined, input: ActionInput) {
    const rec = this.resolveGame(actor, gameId, 'player');
    if (rec.status !== 'running') throw invalidState(`对局 ${rec.id} 当前不在进行中（${rec.status}）。`);
    const seat = this.seatOf(rec, actor.id);
    if (seat === null) throw forbidden('你不是本局玩家。');
    const player = rec.players.find((p) => p.seat === seat)!;
    if (player.kind !== 'agent') throw forbidden('真人玩家的指令需由裁判通过 relay_human_message 转发。');
    const inst = this.inst(rec);
    const normalized = this.normalizeInput(rec, input as ActionInput & Record<string, unknown>);
    const message = inst.onAction(seat, normalized, { via: 'agent' });
    this.pump(rec, inst, false);
    this.touch(rec);
    const todo = this.todoFor(rec, inst, seat);
    return {
      ok: true,
      game_id: rec.id,
      message,
      still_your_turn: Boolean(todo),
      ...(todo ? { todo } : {}),
      phase: this.phaseHeader(rec, inst),
      ...(rec.status !== 'running' ? { game_over: true, result: rec.result } : {}),
    };
  }

  speak(actor: Identity, gameId: string | undefined, text: string, channel: 'public' | 'team' = 'public') {
    const t = String(text ?? '').trim();
    if (!t) throw badRequest('发言内容不能为空。');
    const res = this.act(actor, gameId, { action: channel === 'team' ? 'team_chat' : 'speech', text: t });
    const rec = this.getRecord(res.game_id);
    const seat = this.seatOf(rec, actor.id)!;
    const p = rec.players.find((pl) => pl.seat === seat)!;
    return {
      ...res,
      post_to_group:
        channel === 'public' && p.selfPost
          ? '发言已被记录。请现在把你的发言原文作为一条群消息发出去（不要提及工具调用，也不要暴露你不想公开的信息）。'
          : undefined,
    };
  }

  private todoFor(rec: GameRecord, inst: BaseGame, seat: Seat): TodoView | null {
    const ph = rec.phase;
    if (rec.status !== 'running' || !ph || ph.openedAt === null) return null;
    const req = ph.pending[String(seat)];
    if (!req || req.done) return null;
    void inst;
    return {
      prompt: req.prompt,
      kind: req.kind,
      actions: req.actions,
      seconds_left: ph.deadline === null ? null : Math.max(0, Math.round((ph.deadline - this.now()) / 1000)),
    };
  }

  phaseHeader(rec: GameRecord, inst?: BaseGame) {
    const ph = rec.phase;
    if (!ph) return null;
    void inst;
    return {
      key: ph.key,
      title: ph.title,
      round: ph.round,
      open: ph.openedAt !== null,
      seconds_left: ph.deadline === null ? null : Math.max(0, Math.round((ph.deadline - this.now()) / 1000)),
      waiting_for: ph.secret
        ? '（秘密阶段，不公开等待对象）'
        : Object.values(ph.pending)
            .filter((r) => !r.done)
            .map((r) => `${r.seat}号`)
            .join('、') || '无',
    };
  }

  /** 正常结束（ended）后完整复盘对所有人公开；中止的对局不公开私密记录，防止「中止后偷看」。 */
  private visibleEvents(rec: GameRecord, actor: Identity, seat: Seat | null): LogEntry[] {
    const finished = rec.status === 'ended';
    const isRef = this.isReferee(rec, actor);
    return rec.log.filter((e) => {
      if (finished) return true;
      if (e.audience.type === 'public') return true;
      if (e.audience.type === 'seats') return seat !== null && e.audience.seats.includes(seat);
      return isRef || Boolean(actor.admin);
    });
  }

  /** seq 按「该视角可见的事件」重新编号：全局序号会因为别人的私密事件出现空档，数空档就能推断谁还在行动。 */
  private eventView(e: LogEntry, seq: number): EventView {
    return {
      seq,
      round: e.round,
      kind: e.kind,
      text: e.text,
      ...(e.audience.type !== 'public' ? { private: true as const } : {}),
    };
  }

  // ═══════════════════════════ 网页舞台（灯下剧场） ═══════════════════════════

  /**
   * 开局时给每个真人座位生成一个网页链接，私聊发给本人：在网页上看自己的私密信息、下指令（网页舞台上还能发言）。
   * 链接只属于这个座位，对局结束或中止就作废（见 touch）。没配置 webUrl 时不发。
   */
  private issueSeatLinks(rec: GameRecord, inst: BaseGame): void {
    if (!this.webUrl) return;
    const humans = rec.players.filter((p) => p.kind === 'human');
    if (humans.length === 0) return;
    rec.seatTokens = {};
    for (const p of humans) {
      rec.seatTokens[String(p.seat)] = randomBytes(18).toString('base64url');
      const url = this.seatUrl(rec, p.seat)!;
      inst.seatLinkTell(
        p.seat,
        `🔗 你的座位网页（只属于你，别转发给别人；对局结束后自动作废）：\n${url}\n` +
          (rec.stage === 'web'
            ? '本局在网页上进行：发言、行动都在这个页面上操作，不要在群里说话。'
            : '页面上能看你的身份、私密消息和当前待办，也能直接下指令；私聊裁判照样有效。'),
      );
    }
  }

  /** 按座位令牌取对局和座位；令牌不对、对局不在进行中一律当作不存在。 */
  webSeat(gameId: string, token: string): { rec: GameRecord; seat: Seat } | null {
    const rec = this.games.get(String(gameId ?? ''));
    if (!rec || rec.status !== 'running' || !rec.seatTokens) return null;
    const a = Buffer.from(String(token ?? ''));
    for (const [seat, tok] of Object.entries(rec.seatTokens)) {
      const b = Buffer.from(tok);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        const p = rec.players.find((x) => x.seat === Number(seat));
        return p && p.kind === 'human' ? { rec, seat: p.seat } : null;
      }
    }
    return null;
  }

  /**
   * 真人座位的网页视图：公开部分和观战视图同一口径（不含观众席，参与者看不到观众席），
   * 外加本座位自己的东西：私密视图、待办、发给本座位的私密消息（按本座位的私密消息重新编号，since 之后的才给）。
   */
  webSeatView(rec: GameRecord, seat: Seat, since = 0, mineSince = 0) {
    const pub = this.webView(rec, since, 0);
    const { chat: _chat, chat_seq: _chatSeq, replay: _replay, ...rest } = pub;
    void _chat;
    void _chatSeq;
    void _replay;
    const me = rec.players.find((p) => p.seat === seat)!;
    const inst = rec.startedAt !== null ? this.inst(rec) : null;
    const mine = rec.log.filter((e) => e.audience.type === 'seats' && e.audience.seats.includes(seat));
    const from = Math.max(0, Math.min(Math.floor(Number(mineSince) || 0), mine.length));
    const todo = inst ? this.todoFor(rec, inst, seat) : null;
    return {
      ...rest,
      me: {
        seat,
        name: me.name,
        alive: me.alive,
        private: inst ? inst.privateView(seat) : null,
        todo: todo
          ? {
              prompt: todo.prompt,
              kind: todo.kind,
              seconds_left: todo.seconds_left,
              channel: rec.phase?.pending[String(seat)]?.channel ?? 'group',
              // 网页舞台上发言在页面上发：游戏给的「在群里说」示例不适用
              actions: todo.actions.map((a) => ({
                action: a.action,
                label: a.label,
                ...(a.command && !(rec.stage === 'web' && a.action === 'speech') ? { command: a.command } : {}),
                ...(a.targets ? { targets: a.targets } : {}),
              })),
            }
          : null,
        // 网页舞台上真人在页面上发言；群舞台上发言还是在 QQ 群里
        can_speak: rec.stage === 'web' && me.alive,
      },
      mine: mine.slice(from).map((e, i) => ({ seq: from + i + 1, at: e.at, round: e.round, kind: e.kind, text: e.text })),
      mine_seq: mine.length,
    };
  }

  /**
   * 真人在座位网页上提交：mode=command 等同于私聊裁判的指令；mode=speech 是网页舞台上的发言（等同于群舞台在群里说话）。
   * 走和 relay_human_message 完全相同的解析和校验。
   */
  webSeatAct(rec: GameRecord, seat: Seat, input: { text: string; mode: 'command' | 'speech' }): RelayResult {
    if (rec.status !== 'running') return { recognized: false, accepted: false, message: '对局已结束。' };
    const player = rec.players.find((p) => p.seat === seat);
    if (!player || player.kind !== 'human') return { recognized: false, accepted: false, message: '链接无效。' };
    const text = [...String(input.text ?? '')].slice(0, 2000).join('');
    if (!text.trim()) throw badRequest('说点什么吧（不能是空的）。');
    if (input.mode === 'speech' && rec.stage !== 'web') {
      throw badRequest('本局在 QQ 群里进行：发言请直接在群里说，网页上只下私聊类指令。');
    }
    return this.humanInput(rec, this.inst(rec), player, text, input.mode === 'speech' ? 'group' : 'private', undefined, true);
  }

  /**
   * 按观战令牌取对局；令牌不对、不是网页舞台的局一律当作不存在（不让人借此探测对局 ID）。
   */
  webRecord(gameId: string, token: string): GameRecord | null {
    const rec = this.games.get(String(gameId ?? ''));
    if (!rec || rec.stage !== 'web' || !rec.watchToken) return null;
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(rec.watchToken);
    return a.length === b.length && timingSafeEqual(a, b) ? rec : null;
  }

  /**
   * 网页观战视图：只含公开信息，和 get_my_view 的旁观者视角同一口径。
   * 事件按「公开事件」重新编号（从 1 开始），免得从序号空档推断别人的私密行动；
   * since 之后的事件才返回（断线续传）。正常结束的局附上完整复盘（含私密事件）。
   */
  webView(rec: GameRecord, since = 0, chatSince = 0) {
    const def = this.def(rec);
    const pub = rec.log.filter((e) => e.audience.type === 'public');
    const from = Math.max(0, Math.min(Math.floor(Number(since) || 0), pub.length));
    const ev = (e: LogEntry, i: number) => ({
      seq: i,
      at: e.at,
      round: e.round,
      kind: e.kind,
      text: e.text,
      ...(e.seat !== undefined ? { seat: e.seat } : {}),
      ...(typeof e.data?.text === 'string' ? { speech: e.data.text } : {}),
    });
    const started = rec.startedAt !== null;
    const inst = started ? this.inst(rec) : null;
    const ph = rec.status === 'running' ? rec.phase : null;
    const open = Boolean(ph && ph.openedAt !== null);
    const pending = ph ? Object.values(ph.pending) : [];
    // 秘密阶段不给「谁还没行动」：那本身就是秘密
    const showTodo = open && !ph!.secret;
    const waiting = showTodo ? pending.filter((r) => !r.done).map((r) => r.seat) : [];
    const finished = rec.status === 'ended';
    return {
      game: {
        id: rec.id,
        type: rec.type,
        name: def.name,
        status: rec.status,
        round: rec.round,
        started_at: rec.startedAt,
        ended_at: rec.endedAt,
      },
      phase: ph
        ? {
            key: ph.key,
            title: ph.title,
            opened: open,
            deadline: open ? ph.deadline : null,
            timeout_ms: ph.timeoutMs,
            secret: ph.secret,
            total: showTodo ? pending.length : null,
            waiting,
            done: showTodo ? pending.filter((r) => r.done).map((r) => r.seat) : [],
          }
        : null,
      players: rec.status === 'lobby' ? [] : rec.players.map((p) => ({ seat: p.seat, name: p.name, kind: p.kind, alive: p.alive })),
      lobby: rec.status === 'lobby' ? rec.lobby.filter((e) => e.pref !== 'referee').map((e) => ({ name: e.name, kind: e.kind })) : undefined,
      board: inst && started ? inst.publicView() : null,
      events: pub.slice(from).map((e, i) => ev(e, from + i + 1)),
      last_seq: pub.length,
      ...(rec.result ? { result: rec.result } : {}),
      ...(rec.status === 'aborted' ? { aborted: rec.abortReason ?? '已中止' } : {}),
      chat: this.chatSince(rec, chatSince, 200),
      chat_seq: rec.spectatorChatSeq ?? 0,
      ...(finished && from === 0
        ? {
            replay: rec.log.map((e) => ({
              at: e.at,
              round: e.round,
              kind: e.kind,
              text: e.text,
              ...(e.seat !== undefined ? { seat: e.seat } : {}),
              audience: e.audience.type === 'seats' ? { seats: e.audience.seats } : e.audience.type,
            })),
          }
        : {}),
      server_time: this.now(),
    };
  }

  // ═══════════════════════════ 观众席 ═══════════════════════════

  /** 是不是本局参与者（报名的人、玩家、裁判、候补裁判）：参与者看不到观众席，也不能在观众席说话 */
  isParticipant(rec: GameRecord, id: string): boolean {
    return (
      rec.players.some((p) => p.id === id) ||
      rec.lobby.some((e) => e.id === id) ||
      rec.referee?.id === id ||
      rec.standbyReferees.some((r) => r.id === id) ||
      (rec.formerReferees ?? []).some((r) => r.id === id)
    );
  }

  private chatSince(rec: GameRecord, since: number, limit: number) {
    const all = rec.spectatorChat ?? [];
    const from = all.filter((c) => c.seq > (Number(since) || 0));
    return from.slice(-limit).map((c) => ({ seq: c.seq, at: c.at, from: c.from, name: c.name, text: c.text }));
  }

  /**
   * 观众席发言。web = 网页观众（key 用来限流，比如 IP）；agent = 没参加本局的 bot。
   * 只在开局之后能说；不进群、不进任何参与者的视图；不唤醒玩家的长轮询。
   */
  spectatorSay(rec: GameRecord, from: { kind: 'web'; name: string; key: string } | { kind: 'agent'; actor: Identity }, text: string) {
    if (rec.startedAt === null) throw invalidState('对局还没开始，观众席还没开放。');
    if (from.kind === 'agent' && this.isParticipant(rec, from.actor.id)) {
      throw forbidden('你是本局参与者（报名的人、玩家或裁判），不能在观众席说话：观众席的讨论对参与者保密。');
    }
    const body = [...sanitizeUserText(String(text ?? '')).replace(/\s+/g, ' ').trim()].slice(0, SPECTATOR_MAX_CHARS).join('');
    if (!body) throw badRequest('说点什么吧（不能是空的）。');
    const name =
      from.kind === 'agent'
        ? this.nameOf(from.actor)
        : sanitizeName(String(from.name ?? ''), 16) || '观众';
    const key = from.kind === 'agent' ? `agent:${from.actor.id}` : `web:${from.key}`;
    const now = this.now();
    const hits = (this.chatHits.get(key) ?? []).filter((t) => now - t < SPECTATOR_WINDOW_MS);
    if (hits.length >= SPECTATOR_PER_WINDOW) {
      throw invalidState(`说得太快了：每 ${SPECTATOR_WINDOW_MS / 1000} 秒最多 ${SPECTATOR_PER_WINDOW} 条。`);
    }
    hits.push(now);
    this.chatHits.set(key, hits);
    if (this.chatHits.size > 5000) for (const [k, v] of this.chatHits) if (now - (v[v.length - 1] ?? 0) > SPECTATOR_WINDOW_MS) this.chatHits.delete(k);
    const seq = (rec.spectatorChatSeq ?? 0) + 1;
    rec.spectatorChatSeq = seq;
    const chat = (rec.spectatorChat ??= []);
    chat.push({ seq, at: now, from: from.kind, name, text: body });
    if (chat.length > SPECTATOR_KEEP) chat.splice(0, chat.length - SPECTATOR_KEEP);
    // 只通知观战页面和存档；不 bump，免得唤醒玩家的长轮询
    this.emitter.emit('change', rec.id);
    this.store?.schedule(() => this.snapshot());
    return { seq, name, text: body };
  }

  /** bot 在观众席发言（MCP 工具 spectator_say） */
  spectatorSayAs(actor: Identity, gameId: string, text: string) {
    const id = String(gameId ?? '').trim();
    if (!id) throw badRequest('需要 game_id：要在哪一局的观众席说话。', '用 list_games 看正在进行的对局。');
    const rec = this.getRecord(id);
    const r = this.spectatorSay(rec, { kind: 'agent', actor }, text);
    return { ok: true, seq: r.seq, message: '已发到观众席（只有观众能看到，参与者看不到，也不会进群）。' };
  }

  /** 统一视角：玩家看到自己的身份与待办，裁判看到主持信息，旁观者只看公开信息。 */
  getView(actor: Identity, gameId?: string, opts: { fullLog?: boolean } = {}) {
    const rec = this.resolveGame(actor, gameId, 'any');
    const def = this.def(rec);
    const header = {
      game_id: rec.id,
      type: rec.type,
      name: def.name,
      group_id: rec.groupId,
      status: rec.status,
      round: rec.round,
    };
    if (rec.status === 'lobby') {
      const me = rec.lobby.find((e) => e.id === actor.id);
      return {
        game: header,
        lobby: rec.lobby.map((e) => ({ name: e.name, qq: e.id, kind: e.kind, join_as: e.pref })),
        you: me ? { joined: true, join_as: me.pref, host: rec.hostId === actor.id } : { joined: false },
        ...this.limitsView(rec),
        hint:
          rec.hostId === actor.id
            ? '你是房主：人齐后调用 start_game 开局（程序会抽签选出 AI 裁判、随机座位与身份）。'
            : me
              ? '等待房主开局。开局后调用 get_my_view 查看身份。'
              : '可调用 join_game 加入本局。',
      };
    }
    // 在大厅里就中止的局从没开过局：没有座位，游戏状态是空的，不能交给游戏生成视图
    if (rec.startedAt === null) {
      return { game: header, players: [], game_over: true, ...(rec.status === 'aborted' ? { aborted: rec.abortReason ?? true } : {}) };
    }
    const inst = this.inst(rec);
    const seat = this.agentSeatOf(rec, actor.id);
    const isRef = this.isReferee(rec, actor);
    const events = this.visibleEvents(rec, actor, seat);
    const cursorKey = `${rec.id}:${actor.id}`;
    const cursor = this.viewCursors.get(cursorKey) ?? 0;
    const numbered = events.map((e, i) => ({ e, view: this.eventView(e, i + 1) }));
    const fresh = opts.fullLog ? numbered : numbered.filter((x) => x.e.seq > cursor);
    const limited = (opts.fullLog ? fresh : fresh.slice(-60)).map((x) => x.view);
    if (events.length > 0) this.viewCursors.set(cursorKey, events[events.length - 1]!.seq);

    const players = rec.players.map((p) => ({ seat: p.seat, name: p.name, qq: p.id, kind: p.kind, alive: p.alive }));
    const base = {
      game: { ...header, phase: this.phaseHeader(rec, inst) },
      players,
      public: inst.publicView(),
      // 和 act 的返回一致：对局结束或中止时明确给出 game_over，接入端据此退出游戏状态
      ...(rec.status === 'ended' || rec.status === 'aborted' ? { game_over: true } : {}),
      ...(rec.result ? { result: rec.result } : {}),
      ...(rec.status === 'aborted' ? { aborted: rec.abortReason ?? true } : {}),
    };

    if (seat !== null) {
      const me = rec.players.find((p) => p.seat === seat)!;
      const todo = this.todoFor(rec, inst, seat);
      const upcoming = rec.phase && rec.phase.openedAt === null && rec.phase.pending[String(seat)] && !rec.phase.pending[String(seat)]!.done;
      return {
        ...base,
        you: { seat, name: me.name, alive: me.alive, ...inst.privateView(seat) },
        your_turn: Boolean(todo),
        todo,
        new_events: limited,
        ...(fresh.length > limited.length ? { omitted_events: fresh.length - limited.length } : {}),
        hint: this.playerHint(rec, me, todo, Boolean(upcoming)),
      };
    }
    if (isRef) {
      const ref = rec.referee!;
      const undelivered = rec.outbox.filter((d) => d.seq > ref.cursor).length;
      return {
        ...base,
        you: {
          role: 'referee',
          note: ref.hostedBy
            ? `你被抽中为本局裁判，但裁判事务由程序（${ref.hostedBy}）代行：你这局休息，不要调用 referee_step，不要在群里发言。`
            : '你是本局 AI 裁判：只负责推进流程（调用 referee_step 并发送消息）与转发真人消息，不参与、不改变任何结果。',
          ...(ref.hostedBy ? { hosted_by: ref.hostedBy } : {}),
        },
        undelivered,
        waiting_for: this.refereeWaiting(rec),
        new_events: limited,
        hint: ref.hostedBy
          ? '什么都不用做。'
          : rec.status === 'running' || undelivered > 0
            ? `调用 referee_step(game_id="${rec.id}", wait_seconds=25) 拉取并发送消息；收到玩家的群聊/私聊消息时调用 relay_human_message 转发。`
            : '对局已结束，所有消息已发送。',
      };
    }
    const humanSeat = rec.players.some((p) => p.id === actor.id && p.kind === 'human');
    // 观众席：只给真正的观众（参与者一律看不到）
    let chat: ReturnType<GameManager['chatSince']> | null = null;
    if (!this.isParticipant(rec, actor.id)) {
      const ck = `${rec.id}:${actor.id}:chat`;
      chat = this.chatSince(rec, opts.fullLog ? 0 : (this.viewCursors.get(ck) ?? 0), 30);
      this.viewCursors.set(ck, rec.spectatorChatSeq ?? 0);
    }
    return {
      ...base,
      you: { role: 'spectator' },
      new_events: limited,
      ...(chat
        ? {
            spectator_chat: chat,
            spectator_note: '观众席：网页观众和其他没参加本局的 bot 的讨论，参与者看不到。想说话用 spectator_say（每条最多 200 字，别把观众席的讨论带到群里）。',
          }
        : {}),
      hint: humanSeat
        ? '这个 QQ 号是本局的真人玩家：真人的身份与私密信息只由裁判私聊发给本人，MCP 会话里只能看到公开信息。'
        : '你不是本局玩家，只能看到公开信息。',
    };
  }

  private playerHint(rec: GameRecord, me: Player, todo: TodoView | null, upcoming: boolean): string {
    if (rec.status === 'ended') return '游戏已结束，可查看 result。get_game_log 可查看完整复盘（含所有私密信息）。';
    if (rec.status === 'aborted') return '对局已中止。';
    if (!me.alive && !todo) return '你已出局，可以继续观战（不要在群里透露你知道的信息）。';
    const web = rec.stage === 'web' ? '本局在网页舞台进行：发言只用 speak，不要在 QQ 群里说话（群里说话会被撤回）。' : '';
    if (todo) {
      const first = todo.actions[0];
      const how = todo.kind === 'speech' ? '调用 speak({"text":"……"}) 发言' : `调用 act(...) 行动，例如 ${first?.example ?? ''}`;
      return `轮到你了：${todo.prompt}（剩余约 ${todo.seconds_left ?? '?'} 秒）。请${how}。${web}`;
    }
    if (upcoming) return `马上轮到你（等待裁判发布消息后开放），请稍候再查看。${web}`;
    return `现在不是你的回合。可调用 get_my_view(wait_seconds=30) 等待轮到你。${web}`;
  }

  private refereeWaiting(rec: GameRecord): string[] {
    const ph = rec.phase;
    if (!ph || rec.status !== 'running') return [];
    return Object.values(ph.pending)
      .filter((r) => !r.done)
      .map((r) => rec.players.find((p) => p.seat === r.seat)!)
      .filter((p) => !ph.secret || p.kind === 'human')
      .map((p) => `${p.seat}号 ${p.name}（${p.kind === 'human' ? `真人，需在${ph.pending[String(p.seat)]!.channel === 'private' ? '私聊' : '群里'}回应` : 'AI'}）`);
  }

  /** 长轮询：等到轮到自己（或游戏结束 / 有新事件），再返回视角。 */
  async waitView(
    actor: Identity,
    gameId: string | undefined,
    waitMs: number,
    opts: { fullLog?: boolean; wakeOn?: 'turn' | 'any' } = {},
    signal?: AbortSignal,
  ) {
    const rec = this.resolveGame(actor, gameId, 'any');
    if (waitMs > 0) {
      const startLog = rec.logSeq;
      const cond = () => {
        if (rec.status !== 'running') return true;
        const seat = this.agentSeatOf(rec, actor.id);
        if (seat !== null && this.todoFor(rec, this.inst(rec), seat)) return true;
        if (this.isReferee(rec, actor)) {
          const now = this.now();
          if (rec.outbox.some((d) => d.seq > rec.referee!.cursor && d.notBefore <= now)) return true;
        }
        if (opts.wakeOn === 'any' && rec.logSeq !== startLog) return true;
        return false;
      };
      await this.waitUntil(rec.id, cond, waitMs, signal);
      // 取消后不能再调 getView，否则「新事件」游标被推进，而调用方什么都没收到
      this.assertNotCancelled(signal, 'get_my_view');
    }
    return this.getView(actor, rec.id, opts);
  }

  getLog(actor: Identity, gameId: string | undefined, opts: { sinceSeq?: number; limit?: number } = {}) {
    const rec = this.resolveGame(actor, gameId, 'any');
    const seat = this.agentSeatOf(rec, actor.id);
    const events = this.visibleEvents(rec, actor, seat)
      .map((e, i) => this.eventView(e, i + 1))
      .filter((v) => v.seq > (opts.sinceSeq ?? 0));
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const page = events.slice(0, limit);
    return {
      game_id: rec.id,
      status: rec.status,
      complete_replay: rec.status === 'ended',
      events: page,
      has_more: events.length > page.length,
      ...(rec.result ? { result: rec.result } : {}),
    };
  }

  // ═══════════════════════════ 裁判 ═══════════════════════════

  /** 裁判事务被代行时，其它会话（没带正确 host_id 的）不能推进、不能转交：返回 true 表示「你这局休息」。 */
  private hostedElsewhere(rec: GameRecord, hostId: string | undefined): boolean {
    const h = rec.referee?.hostedBy;
    return Boolean(h) && (hostId ?? '') !== h;
  }

  private hostedNote(rec: GameRecord): string {
    return `本局裁判事务由程序（${rec.referee?.hostedBy}）代行，你这局休息：不要调用 referee_step，不要在群里发言，也不要转交消息。`;
  }

  private assertReferee(rec: GameRecord, actor: Identity): void {
    if (this.isReferee(rec, actor)) return;
    if (actor.admin && rec.referee === null) return;
    throw forbidden(
      `你不是对局 ${rec.id} 的裁判${rec.referee ? `（当前裁判：${rec.referee.name}）` : ''}。`,
      rec.referee ? '若裁判失联，已登记的候补裁判（join_game 时 join_as="referee"）可调用 referee_takeover 接管。' : undefined,
    );
  }

  private refereeHasWork(rec: GameRecord): boolean {
    const now = this.now();
    const cursor = rec.referee?.cursor ?? 0;
    if (rec.outbox.some((d) => d.seq > cursor && d.notBefore <= now)) return true;
    if (rec.status !== 'running') return true;
    const ph = rec.phase;
    if (!ph) return true;
    if (ph.openedAt === null) return this.gateOpen(rec, ph);
    if (ph.deadline !== null && now >= ph.deadline) return true;
    const inst = this.inst(rec);
    if (inst.isPhaseComplete() && now >= ph.openedAt + ph.minDurationMs) return true;
    const remind = inst.remindAt();
    if (remind !== null && now >= remind) return true;
    return false;
  }

  private refereeNextWake(rec: GameRecord): number | null {
    const cursor = rec.referee?.cursor ?? 0;
    const times: number[] = [];
    const nextDelivery = rec.outbox.find((d) => d.seq > cursor);
    if (nextDelivery) times.push(nextDelivery.notBefore);
    const ph = rec.phase;
    if (ph?.deadline != null) times.push(ph.deadline);
    if (ph?.openedAt != null && ph.minDurationMs > 0) times.push(ph.openedAt + ph.minDurationMs);
    if (rec.status === 'running') {
      const remind = this.inst(rec).remindAt();
      if (remind !== null) times.push(remind);
    }
    return times.length ? Math.min(...times) : null;
  }

  /**
   * 裁判的「推进」：处理超时/结算 → 交出到期的待发消息 → 开放下一阶段。
   * 消息按 seq 顺序交付；since_seq 可用于重发（例如上一批没发出去）。
   */
  /** 秘密阶段里不该在群里说话的存活 AI 玩家。 */
  private turnIds(rec: GameRecord): string[] {
    const ph = rec.phase;
    if (rec.status !== 'running' || !ph || ph.secret || ph.openedAt === null) return [];
    return Object.values(ph.pending)
      .filter((r) => !r.done)
      .map((r) => rec.players.find((p) => p.seat === r.seat)!)
      .filter((p) => p && p.kind !== 'human')
      .map((p) => p.id);
  }

  private quietIds(rec: GameRecord): string[] {
    if (rec.status !== 'running' || !rec.phase?.secret) return [];
    return rec.players.filter((p) => p.alive && p.kind !== 'human').map((p) => p.id);
  }

  async refereeStep(
    actor: Identity,
    gameId: string | undefined,
    opts: { sinceSeq?: number; waitMs?: number; hostId?: string; inlineImages?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<RefereeStepResult> {
    const rec = this.resolveGame(actor, gameId, 'referee');
    if (rec.status === 'lobby') throw invalidState('对局还在报名阶段，等房主 start_game 后再推进。');
    this.assertReferee(rec, actor);
    if (this.hostedElsewhere(rec, opts.hostId)) {
      const inst0 = this.inst(rec);
      return {
        game_id: rec.id,
        group_id: rec.groupId,
        status: rec.status,
        deliveries: [],
        last_seq: rec.referee?.cursor ?? 0,
        undelivered_later: 0,
        phase: this.phaseHeader(rec, inst0),
        waiting_for: [],
        finished: rec.status !== 'running',
        hosted: true,
        next_call_hint: this.hostedNote(rec),
      };
    }
    if (rec.referee) rec.referee.lastSeenAt = this.now();
    const inst = this.inst(rec);
    if (rec.status === 'running') this.pump(rec, inst, true);

    if ((opts.waitMs ?? 0) > 0 && !this.refereeHasWork(rec)) {
      await this.waitUntil(rec.id, () => this.refereeHasWork(rec), opts.waitMs!, signal, () => this.refereeNextWake(rec));
      // 调用方已取消（客户端超时、断开或服务关闭）：响应送不出去，绝不能推进游标，否则这批消息就丢了
      this.assertNotCancelled(signal, 'referee_step');
      if (rec.status === 'running') this.pump(rec, inst, true);
    }

    const now = this.now();
    const ref = rec.referee;
    // since_seq 只用于重发（不能借它跳过还没发出的消息）
    const from =
      opts.sinceSeq !== undefined
        ? Math.max(0, ref ? Math.min(opts.sinceSeq, ref.cursor) : opts.sinceSeq)
        : (ref?.cursor ?? 0);
    let deliveries: Delivery[] = [];
    for (const d of rec.outbox) {
      if (d.seq <= from) continue;
      if (d.notBefore > now) break;
      deliveries.push(d);
    }
    if (opts.inlineImages) deliveries = await this.inlineImages(rec.id, deliveries);
    this.assertNotCancelled(signal, 'referee_step');
    if (ref && deliveries.length > 0) ref.cursor = Math.max(ref.cursor, deliveries[deliveries.length - 1]!.seq);
    if (rec.status === 'running') this.pump(rec, inst, true);
    if (ref) ref.lastSeenAt = this.now();
    this.touch(rec);

    const cursor = ref?.cursor ?? rec.outboxSeq;
    const later = rec.outbox.filter((d) => d.seq > cursor);
    const finished = rec.status !== 'running' && later.length === 0;
    let hint: string;
    if (finished) hint = '游戏已结束且所有消息都已交付。发送完本批消息后即可停止调用 referee_step。';
    else if (later.length > 0) {
      const wait = Math.max(0, Math.ceil((later[0]!.notBefore - this.now()) / 1000));
      hint = `还有 ${later.length} 条消息将在约 ${wait} 秒后可发送。先发送本批消息，然后立即再次调用 referee_step(wait_seconds=25)。`;
    } else {
      const ph = rec.phase;
      const left = ph?.deadline != null ? Math.max(0, Math.round((ph.deadline - this.now()) / 1000)) : null;
      hint =
        `先按顺序发送本批消息，然后立即再次调用 referee_step(wait_seconds=25)。` +
        (left !== null ? `当前阶段约 ${left} 秒后超时，到时程序会自动托管未行动者。` : '');
    }
    return {
      game_id: rec.id,
      group_id: rec.groupId,
      status: rec.status,
      deliveries,
      last_seq: cursor,
      undelivered_later: later.length,
      phase: this.phaseHeader(rec, inst),
      waiting_for: this.refereeWaiting(rec),
      next_call_hint: hint,
      finished,
      stage: rec.stage ?? 'group',
      quiet_ids: this.quietIds(rec),
      turn_ids: this.turnIds(rec),
      participant_ids: rec.status === 'running' ? [...rec.players.map((p) => p.id), ...(rec.referee ? [rec.referee.id] : [])] : [],
      human_ids: rec.status === 'running' ? rec.players.filter((p) => p.kind === 'human').map((p) => p.id) : [],
    };
  }

  /** 进行中（含报名中）的对局 ID，用于清理图片缓存。 */
  activeGameIds(): Set<string> {
    return new Set([...this.games.values()].filter((g) => g.status === 'running' || g.status === 'lobby').map((g) => g.id));
  }

  /** 把图片段的数据以 base64 填进副本（存档里的原消息不变）。读不到的图只留文字说明。 */
  private async inlineImages(gameId: string, ds: Delivery[]): Promise<Delivery[]> {
    if (!ds.some((d) => d.segments.some((s) => s.type === 'image'))) return ds;
    return Promise.all(
      ds.map(async (d) => {
        if (!d.segments.some((s) => s.type === 'image')) return d;
        const segments = await Promise.all(
          d.segments.map(async (s) => {
            if (s.type !== 'image' || !this.assets) return s;
            try {
              const img = await withTimeout(this.assets.load(gameId, s.asset), 30_000);
              return { ...s, data: img.data.toString('base64'), mime: img.mime };
            } catch {
              return s;
            }
          }),
        );
        return { ...d, segments };
      }),
    );
  }

  /**
   * 裁判转发真人消息，由程序解析。
   * - 报名阶段：「加入/报名/上车」「退出/下车」。
   * - 游戏中：交给游戏解析（投票、夜间行动、发言等）。
   * - action：当文字无法自动识别、但玩家意思明确时，裁判可提交结构化指令（会私聊告知该玩家，便于监督）。
   */
  relayHumanMessage(
    actor: Identity,
    gameId: string | undefined,
    msg: { userId: string; nickname?: string; text: string; channel: 'group' | 'private'; action?: ActionInput; hostId?: string },
  ): RelayResult {
    const rec = this.resolveGame(actor, gameId, 'referee');
    const userId = String(msg.userId ?? '').trim();
    if (!userId) throw badRequest('需要 qq_id（发消息的真人 QQ 号）。');
    if (rec.status === 'running' && this.isReferee(rec, actor) && this.hostedElsewhere(rec, msg.hostId)) {
      return { recognized: false, accepted: false, message: this.hostedNote(rec) };
    }
    const addressed = this.stripAddressing(String(msg.text ?? ''), rec, actor);

    if (rec.status === 'lobby') {
      this.assertLobbyHelper(rec, actor);
      const t = stripTrailing(normalizeText(addressed)).replace(/^[\/#！!]/u, '');
      if (/^(加入|报名|上车|参加|我要玩|我玩|join|\+1)/iu.test(t)) {
        if (this.isKeyedAgent(userId)) {
          return { recognized: true, accepted: false, message: this.keyedAgentNote(rec, sanitizeName(msg.nickname ?? '') || userId) };
        }
        if (rec.stage === 'web' && !this.webUrl) return { recognized: true, accepted: false, message: WEB_NO_HUMANS };
        const r = this.addHuman(actor, rec.id, { userId, name: msg.nickname ?? userId });
        return { recognized: true, accepted: true, message: r.group_message ?? r.message };
      }
      if (/^(退出|下车|不玩了|取消报名|leave)/iu.test(t)) {
        if (!rec.lobby.some((e) => e.id === userId)) return { recognized: true, accepted: false, message: '该用户不在名单中。' };
        const r = this.leaveGame(actor, rec.id, userId);
        return { recognized: true, accepted: true, message: r.group_message ?? r.message };
      }
      return { recognized: false, accepted: false, message: '报名阶段只识别「加入」「退出」。' };
    }

    if (rec.status !== 'running') return { recognized: false, accepted: false, message: '对局已结束，无需转发。' };
    this.assertReferee(rec, actor);
    if (rec.referee) rec.referee.lastSeenAt = this.now();
    const player = rec.players.find((p) => p.id === userId);
    if (!player) return { recognized: false, accepted: false, message: '该用户不是本局玩家，无需转发。' };
    if (player.kind !== 'human') {
      return { recognized: false, accepted: false, message: '该玩家是 AI，会自己调用工具，无需转发。' };
    }
    const inst = this.inst(rec);
    const channel = msg.channel === 'private' ? 'private' : 'group';
    // 网页舞台：真人的发言在座位网页上，群里只是镜像；群里说的话不算数
    if (rec.stage === 'web' && channel === 'group' && !msg.action) {
      return { recognized: false, accepted: false, message: '网页舞台：真人在自己的座位网页上发言，群里的话不算数（无需处理）。' };
    }
    // QQ 的 @ 变成「@昵称」（@ 局外的人、回复引用、图片表情去掉），发言里就不会出现 CQ 码；「投@昵称」仍能识别
    const text = cqToSpeech(addressed, rec.players);
    return this.humanInput(rec, inst, player, text, channel, msg.action, false);
  }

  /** 真人的一条消息或结构化指令（裁判转发或座位网页提交）：交给游戏解析并执行。 */
  private humanInput(
    rec: GameRecord,
    inst: BaseGame,
    player: Player,
    text: string,
    channel: 'group' | 'private',
    action: ActionInput | undefined,
    fromWeb: boolean,
  ): RelayResult {
    const msg = { action };
    if (channel === 'private' && !msg.action && isIdentityQuery(text)) {
      const n = this.resendRole(rec, inst, player.seat);
      this.pump(rec, inst, false);
      this.touch(rec);
      return { recognized: true, accepted: n > 0, message: n > 0 ? `已补发身份信息（${n} 条）。` : '本局没有可补发的身份信息。' };
    }
    let input: ActionInput | null;
    const structured = Boolean(msg.action);
    if (msg.action) input = this.normalizeInput(rec, msg.action as ActionInput & Record<string, unknown>);
    else input = inst.parseCommand(player.seat, text, channel);
    // 发言末尾带「过」：先记发言，再结束发言
    let endAfter = false;
    if (input?.action === 'speech' && input.text !== undefined && !structured) {
      const sp = splitTrailingEnd(input.text);
      if (sp.end && sp.body) {
        input = { ...input, text: sp.body };
        endAfter = true;
      }
    }
    if (input?.text !== undefined) input = { ...input, text: sanitizeUserText(input.text) };
    if (!input) {
      // 私聊里没看懂：轮到他私聊行动就重发说明；不轮到他、但像是指令（验3/刀2/毒5…）就说一声现在不是他的行动时间。
      // 只回私聊本人，内容只涉及他自己的待办和公开的阶段名，不泄露秘密。闲聊不回。
      if (channel === 'private' && !fromWeb) {
        const ph = rec.phase;
        const hint =
          inst.privateHint(player.seat) ??
          (ph && looksLikeCommand(text) ? `现在不是你的私聊行动时间（当前阶段：${ph.title}），这条指令没有生效。` : null);
        if (hint) {
          inst.systemTell(player.seat, `⚠️ ${hint}`, 'feedback');
          this.pump(rec, inst, false);
          this.touch(rec);
          return { recognized: true, accepted: false, message: '指令未生效，已私聊提示该玩家。' };
        }
      }
      if (fromWeb) {
        const hint = inst.privateHint(player.seat);
        return { recognized: false, accepted: false, message: hint ?? (rec.phase ? `没看懂这条指令，或者现在不是你的行动时间（当前阶段：${rec.phase.title}）。` : '没看懂这条指令。') };
      }
      return { recognized: false, accepted: false, message: '不是当前阶段的游戏指令，已忽略（无需处理）。' };
    }
    try {
      const phaseBefore = rec.phase ? `${rec.phase.key}@${rec.phase.openedAt}` : '';
      const fb = inst.onAction(player.seat, input, { via: 'relay', channel });
      // 只结束同一个阶段里自己的发言（一句话就自动轮到下一阶段的游戏，不能误结束下一轮）
      const samePhase = rec.phase ? `${rec.phase.key}@${rec.phase.openedAt}` === phaseBefore : false;
      if (endAfter && samePhase && rec.status === 'running') {
        try {
          inst.onAction(player.seat, { action: 'end_speech' }, { via: 'relay', channel });
        } catch (e) {
          // 有的游戏一句话就结束本轮发言，这里再结束会报错：忽略
          if (!(e instanceof GameError)) throw e;
        }
      }
      if (structured) {
        inst.systemTell(player.seat, `🧾 裁判已代你提交指令：${this.describeInput(input)}。如非本意请立即私聊裁判。`, 'feedback');
      } else if (channel === 'private' && fb && !fromWeb) {
        // 网页上提交的结果直接显示在页面上，不再私聊一遍
        inst.systemTell(player.seat, `✅ ${fb}`, 'feedback');
      }
      this.pump(rec, inst, false);
      this.touch(rec);
      return { recognized: true, accepted: true, action: input, message: fb || '已接受。' };
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      const tip = e.hint ? `${e.message}（${e.hint}）` : e.message;
      if ((channel === 'private' || structured) && !fromWeb) inst.systemTell(player.seat, `⚠️ 指令未生效：${tip}`, 'feedback');
      this.touch(rec);
      return { recognized: true, accepted: false, action: input, message: `指令未生效：${tip}` };
    }
  }

  /** 把发给这个座位的身份牌类私密消息（每种只取最新一条）重新私聊给他 */
  private resendRole(rec: GameRecord, inst: BaseGame, seat: number): number {
    const latest = new Map<string, string>();
    for (const e of rec.log) {
      if (e.audience.type !== 'seats' || !e.audience.seats.includes(seat) || !e.data?.role) continue;
      latest.delete(e.kind); // 保持原来的先后顺序
      latest.set(e.kind, e.text);
    }
    for (const text of latest.values()) inst.systemTell(seat, `🔁 补发：${text}`, 'role');
    if (latest.size === 0) inst.systemTell(seat, '本局没有需要私聊的身份信息。', 'feedback');
    return latest.size;
  }

  /**
   * 去掉消息开头的「回复」引用和对裁判（或转发者）的 @：
   * 真人常常回复裁判的消息，或者先 @ 裁判再说「投3」。
   */
  private stripAddressing(text: string, rec: GameRecord, actor: Identity): string {
    // 真人习惯 @ 裁判发指令；裁判被接管后往往还在 @ 原裁判，所以历任裁判一并剥离
    const former = rec.formerReferees ?? [];
    const bots = new Set([actor.id, rec.referee?.id, ...former.map((r) => r.id)].filter((x): x is string => Boolean(x)));
    const names = [this.nameOf(actor), rec.referee?.name, ...former.map((r) => r.name)].filter((x): x is string => Boolean(x));
    let t = text.trimStart();
    for (let i = 0; i < 4; i++) {
      const m = t.match(/^\[CQ:(reply|at),[^\]]*\]\s*/);
      if (m && (m[1] === 'reply' || bots.has(extractCqAts(m[0])[0] ?? ''))) {
        t = t.slice(m[0].length);
        continue;
      }
      const name = names.find((n) => t.startsWith(`@${n}`));
      if (name) {
        t = t.slice(name.length + 1).trimStart();
        continue;
      }
      break;
    }
    return t;
  }

  private describeInput(input: ActionInput): string {
    const parts = [input.action];
    if (input.target !== undefined) parts.push(`目标 ${input.target}号`);
    if (input.quantity !== undefined) parts.push(`${input.quantity}个`);
    if (input.face !== undefined) parts.push(`${input.face}点`);
    if (input.number !== undefined) parts.push(`数字 ${input.number}`);
    if (input.card) parts.push(`牌 ${input.card}`);
    if (input.color) parts.push(`颜色 ${input.color}`);
    if (input.call) parts.push('宣告');
    if (input.text) parts.push(`「${input.text.slice(0, 40)}」`);
    return parts.join(' ');
  }

  refereeTakeover(actor: Identity, gameId: string, hostId?: string) {
    const rec = this.getRecord(gameId);
    if (rec.status !== 'running') throw invalidState('只有进行中的对局可以接管裁判。');
    if (rec.autoReferee) throw invalidState('本局由程序自动主持，没有 AI 裁判，无需接管。');
    if (this.seatOf(rec, actor.id) !== null) throw forbidden('玩家不能担任裁判。');
    if (rec.referee?.id === actor.id) return { message: '你已经是本局裁判。', summary: this.summary(rec) };
    if (!actor.admin && !this.canReferee(actor.id)) throw forbidden('这台服务器的裁判只从指定账号里抽，你不能接管。');
    if (!actor.admin && !rec.standbyReferees.some((r) => r.id === actor.id)) {
      throw forbidden(
        '只有候补裁判可以接管。',
        `先调用 join_game(game_id="${rec.id}", join_as="referee") 登记为候补裁判，等当前裁判失联超时后再接管。`,
      );
    }
    const stale = !rec.referee || this.now() - rec.referee.lastSeenAt > this.refereeStaleMs;
    if (!stale && !actor.admin) {
      const left = Math.ceil((this.refereeStaleMs - (this.now() - rec.referee!.lastSeenAt)) / 1000);
      throw invalidState(`当前裁判 ${rec.referee!.name} 仍在线（${left} 秒内无响应才可接管）。`);
    }
    const old = rec.referee;
    if (old) {
      rec.formerReferees = [...(rec.formerReferees ?? []).filter((r) => r.id !== old.id && r.id !== actor.id), { id: old.id, name: old.name }];
    }
    rec.referee = { id: actor.id, name: this.nameOf(actor), cursor: old?.cursor ?? 0, lastSeenAt: this.now(), hostedBy: hostId?.trim() || null };
    rec.standbyReferees = rec.standbyReferees.filter((r) => r.id !== actor.id);
    const inst = this.inst(rec);
    inst.systemAnnounce(`🔁 裁判由 ${this.nameOf(actor)} 接管${old ? `（原裁判 ${old.name} 失联）` : ''}。`);
    this.touch(rec);
    return {
      message: `已接管对局 ${rec.id} 的裁判。上一任裁判已交付到 seq=${rec.referee.cursor}；若怀疑有消息没发出，可用 referee_step(since_seq=更小的值) 重发。`,
      summary: this.summary(rec),
    };
  }

  /** 供测试/模拟器：当前阶段每个待办座位的随机合法动作。 */
  randomActionFor(gameId: string, seat: Seat): ActionInput | null {
    const rec = this.getRecord(gameId);
    return this.inst(rec).randomAction(seat);
  }

  /** 给游戏规则说明用。 */
  describeType(type: string) {
    const def = this.registry.resolve(type);
    if (!def) throw badRequest(`未知游戏类型「${type}」。`);
    return def;
  }

  /** 剩余时间的人类可读文本。 */
  remainingText(rec: GameRecord): string {
    const ph = rec.phase;
    if (!ph?.deadline) return '';
    return formatDuration(ph.deadline - this.now());
  }
}

/** 真人私聊里问自己的身份（「我身份呢」「我是什么身份」「补发身份」「我的词」「我的骰子」） */
export function isIdentityQuery(text: string): boolean {
  const t = stripTrailing(normalizeText(text)).replace(/[?？。!！~～\s]/gu, '');
  return (
    /^(请|麻烦)?(补发|重发|再发)(一下|一遍)?(我的?)?(身份|身份牌|词|词语|骰子)/u.test(t) ||
    /^(我的?|我是)?(什么|啥)?(身份|身份牌|底牌|词|词语|骰子)(是什么|是啥|呢|呀|啊|在哪|没收到|发一下)*$/u.test(t) ||
    /^我?(是)?(什么|啥)(身份|牌)(来着)?$/u.test(t) ||
    /^(没|没有)收到(我的)?(身份|身份牌|词|骰子)/u.test(t)
  );
}

/** 私聊里像是游戏指令的话（「验3」「刀 2号」「毒小明」「投5」「救」「过」），用来在不轮到他时提醒一声；闲聊不算 */
export function looksLikeCommand(text: string): boolean {
  const t = stripTrailing(normalizeText(text)).replace(/\s/gu, '');
  if (!t || t.length > 20) return false;
  return /^(查验|验|查|刀|杀|袭击|毒|救|守护|守|投|票|开枪|带走|空刀|空守|过|跳过|放弃|顺序|逆序)/u.test(t) || /^\d{1,2}号?$/u.test(t);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
