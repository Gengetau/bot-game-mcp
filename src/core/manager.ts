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
import { EventEmitter } from 'node:events';
import { BaseGame, type GameEnv } from './game.js';
import { GameError, badRequest, forbidden, invalidState, notFound } from './errors.js';
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
  players: number;
  lobby?: { name: string; id: string; kind: string; join_as: JoinPreference }[];
  round: number;
  phase: string | null;
  auto_referee: boolean;
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
}

export interface RelayResult {
  recognized: boolean;
  accepted: boolean;
  action?: ActionInput;
  message: string;
}

type Waiter = () => void;

const MAX_PUMP = 200;

export class GameManager {
  readonly registry: GameRegistry;
  readonly now: () => number;
  readonly rng: Rng;
  private readonly store?: StateStore;
  private readonly refereeStaleMs: number;
  private readonly lobbyTtlMs: number;
  private readonly idleGameTtlMs: number;
  private readonly keepFinishedGames: number;

  private readonly games = new Map<string, GameRecord>();
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
  touch(rec?: GameRecord): void {
    if (rec) {
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
      players: rec.status === 'lobby' ? rec.lobby.filter((e) => e.pref !== 'referee').length : rec.players.length,
      ...(rec.status === 'lobby'
        ? { lobby: rec.lobby.map((e) => ({ name: e.name, id: e.id, kind: e.kind, join_as: e.pref })) }
        : {}),
      round: rec.round,
      phase: rec.phase?.title ?? null,
      auto_referee: rec.autoReferee,
      created_at: new Date(rec.createdAt).toISOString(),
    };
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
    const existing = [...this.games.values()].find(
      (g) => g.groupId === groupId && (g.status === 'lobby' || g.status === 'running'),
    );
    if (existing) {
      throw new GameError(
        'CONFLICT',
        `群 ${groupId} 已有进行中的对局 ${existing.id}（${this.def(existing).name}，${existing.status === 'lobby' ? '报名中' : '进行中'}）。`,
        '同一个群同时只能有一局。可以 join_game 加入它，或由房主/裁判 abort_game 结束后再开。',
      );
    }
    const parsed = def.optionsSchema.safeParse(input.options ?? {});
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
    const joinAs = input.joinAs ?? 'either';
    if (joinAs !== 'none') {
      rec.lobby.push({ id: actor.id, name: this.nameOf(actor), kind: 'agent', pref: joinAs, selfPost: input.selfPost ?? true, joinedAt: now });
    }
    this.games.set(id, rec);
    this.touch(rec);
    return {
      summary: this.summary(rec),
      group_message:
        `🎮【${def.name}】房间 ${id} 已开启（${def.minPlayers}~${def.maxPlayers} 人）！\n` +
        `真人想玩请在群里发送「加入」，AI 玩家调用 join_game 加入。\n` +
        `${rec.autoReferee ? '本局由程序自动主持。' : '本局需要一位 AI 裁判（由程序从报名裁判的 AI 中抽签产生），裁判只负责推进流程和私聊发身份。'}\n` +
        `人齐后由房主开始游戏。`,
    };
  }

  joinGame(actor: Identity, gameId: string, opts: { as?: JoinPreference; selfPost?: boolean } = {}) {
    const rec = this.getRecord(gameId);
    const def = this.def(rec);
    const pref = opts.as ?? 'either';
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
    if (!existing && pref === 'player' && playerCount >= def.maxPlayers) {
      throw invalidState(`人数已满（最多 ${def.maxPlayers} 人）。`, '可以 join_as="referee" 报名当裁判。');
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

  private lobbyCountText(rec: GameRecord): string {
    const players = rec.lobby.filter((e) => e.pref === 'player').length;
    const either = rec.lobby.filter((e) => e.pref === 'either').length;
    const refs = rec.lobby.filter((e) => e.pref === 'referee').length;
    return `玩家 ${players} 人${either ? ` + 待定 ${either} 人` : ''}${refs ? `，裁判候选 ${refs} 人` : ''}`;
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
    const existing = rec.lobby.find((e) => e.id === userId);
    if (existing) {
      if (existing.kind === 'agent') throw badRequest('该 QQ 号已作为 AI 报名。');
      existing.name = name;
      return { summary: this.summary(rec), message: `${name} 已在名单中。`, group_message: null };
    }
    if (rec.lobby.filter((e) => e.pref !== 'referee').length >= def.maxPlayers) {
      throw invalidState(`人数已满（最多 ${def.maxPlayers} 人）。`);
    }
    rec.lobby.push({ id: userId, name, kind: 'human', pref: 'player', selfPost: false, joinedAt: this.now() });
    this.touch(rec);
    return {
      summary: this.summary(rec),
      message: `已登记真人玩家 ${name}(${userId})。`,
      group_message: `✅ ${name} 加入了【${def.name}】，当前 ${this.lobbyCountText(rec)}。开局后身份将由裁判私聊发送，请确保能收到 bot 私聊。`,
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
    if (!(actor.admin || rec.hostId === actor.id || (!hostPresent && isLobbyAgent))) {
      throw forbidden('只有房主可以开始游戏。');
    }

    // —— 1. 抽签选裁判（程序决定）——
    const agents = rec.lobby.filter((e) => e.kind === 'agent');
    let referee: LobbyEntry | null = null;
    let standby: LobbyEntry[] = [];
    const refPref = agents.filter((e) => e.pref === 'referee');
    const either = agents.filter((e) => e.pref === 'either');
    if (!rec.autoReferee) {
      if (refPref.length > 0) {
        referee = pick(this.rng, refPref);
        standby = refPref.filter((e) => e !== referee);
      } else if (either.length > 0) {
        referee = pick(this.rng, either);
      } else {
        throw invalidState(
          '没有可担任裁判的 AI。',
          '至少需要一个 AI 以 join_as="referee" 或 "either" 报名（裁判不参与游戏，只负责推进和私聊发身份）；或创建对局时设置 auto_referee=true。',
        );
      }
    } else {
      standby = refPref;
    }

    // —— 2. 确定玩家并检查人数 ——
    const entries = rec.lobby.filter((e) => e !== referee && e.pref !== 'referee');
    const n = entries.length;
    if (n < def.minPlayers || n > def.maxPlayers) {
      throw invalidState(
        `${def.name}需要 ${def.minPlayers}~${def.maxPlayers} 名玩家，当前 ${n} 名（不含裁判${referee ? ` ${referee.name}` : ''}）。`,
        n < def.minPlayers ? '请继续拉人报名（真人发送「加入」，AI 调用 join_game）。' : '请让部分人退出报名。',
      );
    }
    const extra = def.checkStart?.(n, rec.options);
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
      selfPost: e.kind === 'agent' ? e.selfPost : false,
    }));
    rec.referee = referee ? { id: referee.id, name: referee.name, cursor: 0, lastSeenAt: this.now() } : null;
    rec.standbyReferees = standby.map((e) => ({ id: e.id, name: e.name }));
    rec.status = 'running';
    rec.startedAt = this.now();

    // —— 4. 开局公告 + 游戏初始化 ——
    const inst = this.inst(rec);
    const seatsText = rec.players
      .map((p) => `${p.seat}号 ${inst.at(p.seat)}${p.kind === 'human' ? '（真人）' : '（AI）'}`)
      .join('\n');
    inst.systemAnnounce(
      `🎲【${def.name}】对局 ${rec.id} 开始！\n` +
        (rec.referee ? `本局裁判：${rec.referee.name}（AI，由程序抽签产生，只负责推进流程，不参与游戏、不决定任何结果）\n` : '本局由程序自动主持。\n') +
        `座位表（程序随机分配）：\n${seatsText}\n` +
        `身份已由程序随机分配${rec.players.some((p) => p.kind === 'human') ? '，真人玩家请查收裁判私聊' : ''}。`,
    );
    inst.start();
    this.pump(rec, inst, false);
    this.touch(rec);
    return {
      summary: this.summary(rec),
      referee: rec.referee ? { id: rec.referee.id, name: rec.referee.name } : null,
      message: rec.referee
        ? `游戏已开始。裁判是 ${rec.referee.name}(${rec.referee.id})：裁判请循环调用 referee_step 拉取消息并按顺序发送（群消息发群里，私聊发给对应真人）。`
        : '游戏已开始（程序自动主持）。玩家请调用 get_my_view 查看自己的身份与待办。',
      group_message: rec.referee
        ? `🎲 ${def.name}开局！裁判 ${rec.referee.name} 请开始主持（调用 referee_step）。`
        : `🎲 ${def.name}开局！`,
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
    return (rec.referee?.cursor ?? 0) >= ph.gateSeq;
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

  private eventView(e: LogEntry): EventView {
    return {
      seq: e.seq,
      round: e.round,
      kind: e.kind,
      text: e.text,
      ...(e.audience.type !== 'public' ? { private: true as const } : {}),
    };
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
        min_players: def.minPlayers,
        max_players: def.maxPlayers,
        hint:
          rec.hostId === actor.id
            ? '你是房主：人齐后调用 start_game 开局（程序会抽签选出 AI 裁判、随机座位与身份）。'
            : me
              ? '等待房主开局。开局后调用 get_my_view 查看身份。'
              : '可调用 join_game 加入本局。',
      };
    }
    const inst = this.inst(rec);
    const seat = this.agentSeatOf(rec, actor.id);
    const isRef = this.isReferee(rec, actor);
    const events = this.visibleEvents(rec, actor, seat);
    const cursorKey = `${rec.id}:${actor.id}`;
    const cursor = this.viewCursors.get(cursorKey) ?? 0;
    const fresh = opts.fullLog ? events : events.filter((e) => e.seq > cursor);
    const limited = opts.fullLog ? fresh : fresh.slice(-60);
    if (events.length > 0) this.viewCursors.set(cursorKey, events[events.length - 1]!.seq);

    const players = rec.players.map((p) => ({ seat: p.seat, name: p.name, qq: p.id, kind: p.kind, alive: p.alive }));
    const base = {
      game: { ...header, phase: this.phaseHeader(rec, inst) },
      players,
      public: inst.publicView(),
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
        new_events: limited.map((e) => this.eventView(e)),
        ...(fresh.length > limited.length ? { omitted_events: fresh.length - limited.length } : {}),
        hint: this.playerHint(rec, me, todo, Boolean(upcoming)),
      };
    }
    if (isRef) {
      const ref = rec.referee!;
      const undelivered = rec.outbox.filter((d) => d.seq > ref.cursor).length;
      return {
        ...base,
        you: { role: 'referee', note: '你是本局 AI 裁判：只负责推进流程（调用 referee_step 并发送消息）与转发真人消息，不参与、不改变任何结果。' },
        undelivered,
        waiting_for: this.refereeWaiting(rec),
        new_events: limited.map((e) => this.eventView(e)),
        hint:
          rec.status === 'running' || undelivered > 0
            ? `调用 referee_step(game_id="${rec.id}", wait_seconds=25) 拉取并发送消息；收到玩家的群聊/私聊消息时调用 relay_human_message 转发。`
            : '对局已结束，所有消息已发送。',
      };
    }
    const humanSeat = rec.players.some((p) => p.id === actor.id && p.kind === 'human');
    return {
      ...base,
      you: { role: 'spectator' },
      new_events: limited.map((e) => this.eventView(e)),
      hint: humanSeat
        ? '这个 QQ 号是本局的真人玩家：真人的身份与私密信息只由裁判私聊发给本人，MCP 会话里只能看到公开信息。'
        : '你不是本局玩家，只能看到公开信息。',
    };
  }

  private playerHint(rec: GameRecord, me: Player, todo: TodoView | null, upcoming: boolean): string {
    if (rec.status === 'ended') return '游戏已结束，可查看 result。get_game_log 可查看完整复盘（含所有私密信息）。';
    if (rec.status === 'aborted') return '对局已中止。';
    if (!me.alive && !todo) return '你已出局，可以继续观战（不要在群里透露你知道的信息）。';
    if (todo) {
      const first = todo.actions[0];
      const how = todo.kind === 'speech' ? '调用 speak({"text":"……"}) 发言' : `调用 act(...) 行动，例如 ${first?.example ?? ''}`;
      return `轮到你了：${todo.prompt}（剩余约 ${todo.seconds_left ?? '?'} 秒）。请${how}。`;
    }
    if (upcoming) return '马上轮到你（等待裁判发布消息后开放），请稍候再查看。';
    return '现在不是你的回合。可调用 get_my_view(wait_seconds=30) 等待轮到你。';
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
    const events = this.visibleEvents(rec, actor, seat).filter((e) => e.seq > (opts.sinceSeq ?? 0));
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const page = events.slice(0, limit);
    return {
      game_id: rec.id,
      status: rec.status,
      complete_replay: rec.status === 'ended',
      events: page.map((e) => this.eventView(e)),
      has_more: events.length > page.length,
      ...(rec.result ? { result: rec.result } : {}),
    };
  }

  // ═══════════════════════════ 裁判 ═══════════════════════════

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
    if (this.inst(rec).isPhaseComplete() && now >= ph.openedAt + ph.minDurationMs) return true;
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
    return times.length ? Math.min(...times) : null;
  }

  /**
   * 裁判的「推进」：处理超时/结算 → 交出到期的待发消息 → 开放下一阶段。
   * 消息按 seq 顺序交付；since_seq 可用于重发（例如上一批没发出去）。
   */
  async refereeStep(
    actor: Identity,
    gameId: string | undefined,
    opts: { sinceSeq?: number; waitMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<RefereeStepResult> {
    const rec = this.resolveGame(actor, gameId, 'referee');
    if (rec.status === 'lobby') throw invalidState('对局还在报名阶段，等房主 start_game 后再推进。');
    this.assertReferee(rec, actor);
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
    const deliveries: Delivery[] = [];
    for (const d of rec.outbox) {
      if (d.seq <= from) continue;
      if (d.notBefore > now) break;
      deliveries.push(d);
    }
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
    };
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
    msg: { userId: string; nickname?: string; text: string; channel: 'group' | 'private'; action?: ActionInput },
  ): RelayResult {
    const rec = this.resolveGame(actor, gameId, 'referee');
    const userId = String(msg.userId ?? '').trim();
    if (!userId) throw badRequest('需要 qq_id（发消息的真人 QQ 号）。');
    const text = this.stripAddressing(String(msg.text ?? ''), rec, actor);

    if (rec.status === 'lobby') {
      this.assertLobbyHelper(rec, actor);
      const t = stripTrailing(normalizeText(text)).replace(/^[\/#！!]/u, '');
      if (/^(加入|报名|上车|参加|我要玩|我玩|join|\+1)/iu.test(t)) {
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
    let input: ActionInput | null;
    const structured = Boolean(msg.action);
    if (msg.action) input = this.normalizeInput(rec, msg.action as ActionInput & Record<string, unknown>);
    else input = inst.parseCommand(player.seat, text, channel);
    if (input?.text !== undefined) input = { ...input, text: sanitizeUserText(input.text) };
    if (!input) {
      return { recognized: false, accepted: false, message: '不是当前阶段的游戏指令，已忽略（无需处理）。' };
    }
    try {
      const fb = inst.onAction(player.seat, input, { via: 'relay', channel });
      if (structured) {
        inst.systemTell(player.seat, `🧾 裁判已代你提交指令：${this.describeInput(input)}。如非本意请立即私聊裁判。`, 'feedback');
      } else if (channel === 'private' && fb) {
        inst.systemTell(player.seat, `✅ ${fb}`, 'feedback');
      }
      this.pump(rec, inst, false);
      this.touch(rec);
      return { recognized: true, accepted: true, action: input, message: fb || '已接受。' };
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      const tip = e.hint ? `${e.message}（${e.hint}）` : e.message;
      if (channel === 'private' || structured) inst.systemTell(player.seat, `⚠️ 指令未生效：${tip}`, 'feedback');
      this.touch(rec);
      return { recognized: true, accepted: false, action: input, message: `指令未生效：${tip}` };
    }
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
    if (input.text) parts.push(`「${input.text.slice(0, 40)}」`);
    return parts.join(' ');
  }

  refereeTakeover(actor: Identity, gameId: string) {
    const rec = this.getRecord(gameId);
    if (rec.status !== 'running') throw invalidState('只有进行中的对局可以接管裁判。');
    if (rec.autoReferee) throw invalidState('本局由程序自动主持，没有 AI 裁判，无需接管。');
    if (this.seatOf(rec, actor.id) !== null) throw forbidden('玩家不能担任裁判。');
    if (rec.referee?.id === actor.id) return { message: '你已经是本局裁判。', summary: this.summary(rec) };
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
    rec.referee = { id: actor.id, name: this.nameOf(actor), cursor: old?.cursor ?? 0, lastSeenAt: this.now() };
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
