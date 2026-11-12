/**
 * WorldService：栖灯镇的规则与提交入口。
 *
 * 所有动作（真人网页、AI 的 MCP、定时任务、小游戏）都从这里进：认证主体 → 查历史回执 → 校验上下文与规则 →
 * 在一个写事务里完成全部变化（物品、账本、游戏记录、事件、回执、待通知）→ 提交成功后才唤醒订阅者。
 * 事务就是候选状态：中途抛错整体回滚，不会留下扣款、占座或已经广播的成功消息。
 *
 * 世界不继承 BaseGame，也没有「一局」的概念：时间就是现实时间，无人在线时到期事务照常处理。
 * 这里不调用任何模型，也不等待网络。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import type { GameRegistry } from '../core/registry.js';
import { CryptoRng, SeededRng, type Rng } from '../core/rng.js';
import { GameRunner } from '../core/runner.js';
import type { GameRecord } from '../core/types.js';
import { CONTENT_VERSION } from './content.js';
import { TownDb, parseJson, type Row } from './db.js';
import { WorldError, badRequest, precondition } from './errors.js';
import { resolveParams, type TownParams } from './params.js';
import { businessDate } from './time.js';
import type { ResidentRow, ResidentState } from './types.js';
import { compileMap } from './spatial/compile.js';
import { TOWN_MAP_SOURCE } from './spatial/town-map.js';
import type { CompiledMap, MapSource } from './spatial/types.js';

export interface WorldOptions {
  /** 数据库文件；':memory:' 只用于测试 */
  dbPath: string;
  registry: GameRegistry;
  worldId?: string;
  worldName?: string;
  params?: Record<string, unknown>;
  now?: () => number;
  /** 非秘密用途的随机源（编号、抽新居民的书）。默认密码学随机 */
  rng?: Rng;
  /**
   * 测试用固定种子：小游戏的随机流按活动隔离、可序列化，和候选状态一起提交。
   * 生产环境不要设：不设时小游戏的秘密随机用密码学随机源，结果随状态原子保存。
   */
  seed?: string;
  log?: (msg: string) => void;
  /** 网页的公网地址（如 https://example.com/town/），用来拼登录链接 */
  publicUrl?: string | null;
  /** 允许本地开发登录（不经可信平台核实身份）。只该在本机试玩时打开 */
  devLogin?: boolean;
  /** 地图源。缺省是栖灯镇的地图；测试可以换一张小图 */
  map?: MapSource;
}

export interface Auth {
  principalId: string;
  /** 这个设备/标签页/运行器的稳定编号。同一居民同一时刻只有一个客户端有写入控制权 */
  clientId: string;
}

export interface CommandRequest {
  requestId: string;
  actionWindow?: string;
  expected?: { contextVersion?: number; controlEpoch?: number; activityId?: string | null };
  action: { type: string; [k: string]: unknown };
}

export interface CommandContext {
  w: WorldService;
  /** 发起动作的居民（事务内刚读出来的） */
  r: ResidentRow;
  action: Record<string, any>;
  now: number;
  requestId: string;
}

export type ActionHandler = (c: CommandContext) => Record<string, unknown> | void;
export interface JobRow {
  job_id: number;
  dedupe_key: string;
  due_at: number;
  kind: string;
  payload: string;
  attempts: number;
}
export type JobHandler = (payload: Record<string, any>, job: JobRow, now: number) => void;

/** 定时任务的固定优先级：同一时刻先处理到达与失效，再处理别的。数字小的先执行。 */
export const JOB_PRIORITY: Record<string, number> = {
  nav_step: 1,
  // 旧版的到达任务：v3 迁移时已全部作废，留着优先级只为读旧库
  move_arrive: 1,
  grant_expire: 2,
  offer_expire: 2,
  presence_expire: 3,
  game_tick: 3,
  letter_deliver: 4,
  interaction_finish: 5,
  interaction_lobby_expire: 5,
  activity_lobby_expire: 6,
  activity_deadline: 6,
  loan_due: 7,
  public_event_open: 8,
  public_event_close: 8,
  daily_rollover: 9,
  prune: 9,
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const MAX_JOB_ATTEMPTS = 5;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

class Histogram {
  private readonly buf: number[] = [];
  private i = 0;
  count = 0;
  constructor(private readonly cap = 5000) {}
  add(v: number): void {
    this.count++;
    if (this.buf.length < this.cap) this.buf.push(v);
    else {
      this.buf[this.i] = v;
      this.i = (this.i + 1) % this.cap;
    }
  }
  summary(): { n: number; p50: number; p95: number; p99: number; max: number } {
    const s = [...this.buf].sort((a, b) => a - b);
    const q = (p: number) => (s.length === 0 ? 0 : Number(s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(3)));
    return { n: this.count, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.length ? Number(s[s.length - 1]!.toFixed(3)) : 0 };
  }
}

/** 请求号：8~80 个字符，只能是字母、数字、下划线和 . : -（文档、MCP schema、接入端同一个规则）。 */
export const REQUEST_ID_RE = /^[\w.:-]{8,80}$/;

export class WorldService {
  readonly db: TownDb;
  readonly worldId: string;
  readonly worldName: string;
  readonly params: TownParams;
  readonly now: () => number;
  readonly rng: Rng;
  readonly runner: GameRunner;
  readonly log: (msg: string) => void;
  readonly publicUrl: string | null;
  readonly devLogin: boolean;
  readonly seed: string | null;
  /** 编译好的地图：可行走网格、区域、锚点、物件位置。空间模块（space.ts）据此判定 */
  readonly map: CompiledMap;
  /** 每次进程启动一个新值：重启后的在场状态要重新确认 */
  readonly bootId: string;
  status: 'recovering' | 'running' | 'degraded' | 'closed' = 'recovering';
  /** 上次启动时估计的停机时长（毫秒） */
  lastOutageMs = 0;

  readonly handlers = new Map<string, ActionHandler>();
  /** 小游戏里的动作：要求居民当前在这局里（其余动作要求不在小游戏里） */
  readonly activityActions = new Set<string>();
  readonly jobHandlers = new Map<string, JobHandler>();
  /** 模块注册的钩子 */
  readonly hooks = {
    /** 居民离线（租约到期、显式离开、重启）时 */
    offline: [] as ((r: ResidentRow, at: number, reason: string) => void)[],
    /** 居民离开一个区域（走出去、被请出门）时。区域 = location_id，同一区域内走动不触发 */
    leaveSpace: [] as ((r: ResidentRow, spaceId: string, at: number) => void)[],
    /** 居民进入一个区域时 */
    arrive: [] as ((r: ResidentRow, spaceId: string, at: number) => void)[],
    /** 居民迈步（开始或改变导航）时：坐着做的事在这里收尾 */
    walk: [] as ((r: ResidentRow, at: number) => void)[],
    /** 一条居民动作执行成功之后（同一事务内） */
    afterCommand: [] as ((r: ResidentRow, at: number) => void)[],
    /** 启动恢复时（估计的停机时长） */
    recover: [] as ((downtimeMs: number, now: number) => void)[],
    /** 每次 tick（已在 running 状态） */
    tick: [] as ((now: number) => void)[],
    /** 新的世界日开始时（日报、补货、清理） */
    newDay: [] as ((date: string, now: number) => void)[],
    /** 新居民注册完成（同一事务内） */
    registered: [] as ((r: ResidentRow, now: number) => void)[],
    /** 一条结构化事实写入后（同一事务内）：愿望、关系、回顾都从这里读 */
    fact: [] as ((f: FactRecord) => void)[],
  };

  private readonly emitter = new EventEmitter();
  private readonly secret: Buffer;
  private pendingBumps = new Set<string>();
  private pendingPublic = false;
  private pendingSpace = new Set<string>();
  private lastAliveWrite = 0;
  /** 已提交的小游戏记录缓存（可以随时从数据库重建） */
  readonly gameCache = new Map<string, { rec: GameRecord; rng: string | null; revision: number }>();
  readonly metrics = {
    domain: new Histogram(),
    commit: new Histogram(),
    total: new Histogram(),
    commands: 0,
    rejected: 0,
    jobs: 0,
    jobRetries: 0,
    jobFailures: 0,
    eventsPrivate: 0,
    eventsPublic: 0,
    pruned: 0,
    replays: 0,
  };

  constructor(opts: WorldOptions) {
    this.worldId = opts.worldId ?? 'town';
    this.worldName = opts.worldName ?? '栖灯镇';
    this.params = resolveParams(opts.params ?? {});
    this.now = opts.now ?? (() => Date.now());
    this.rng = opts.rng ?? new CryptoRng();
    this.runner = new GameRunner(opts.registry);
    this.log = opts.log ?? (() => undefined);
    this.publicUrl = opts.publicUrl?.trim() || null;
    this.devLogin = Boolean(opts.devLogin);
    this.seed = opts.seed ?? null;
    this.map = compileMap(opts.map ?? TOWN_MAP_SOURCE);
    this.bootId = randomBytes(8).toString('hex');
    this.emitter.setMaxListeners(0);
    this.db = new TownDb(opts.dbPath);
    const now = this.now();
    try {
      this.secret = this.db.tx(() => {
        const w = this.db.get('SELECT * FROM worlds WHERE world_id = ?', this.worldId);
        if (!w) {
          this.db.run(
            'INSERT INTO worlds(world_id, timezone, status, schema_version, content_version, created_at, last_alive_at) VALUES (?,?,?,?,?,?,?)',
            this.worldId,
            this.params.timezone,
            'open',
            this.db.userVersion(),
            CONTENT_VERSION,
            now,
            now,
          );
          for (const [id, kind] of [
            ['sys:mint', 'system'],
            ['sys:sink', 'system'],
          ] as const) {
            this.db.run('INSERT OR IGNORE INTO accounts(account_id, world_id, resident_id, kind, balance) VALUES (?,?,NULL,?,0)', id, this.worldId, kind);
          }
        } else if (w.timezone !== this.params.timezone) {
          throw new Error(
            `世界 ${this.worldId} 开服时的时区是 ${w.timezone}，配置里现在是 ${this.params.timezone}。已有每日任务后改时区需要迁移计划，拒绝启动。`,
          );
        }
        let secret = this.db.getMeta('stream_secret');
        if (!secret) {
          secret = randomBytes(32).toString('hex');
          this.db.setMeta('stream_secret', secret);
        }
        return Buffer.from(secret, 'hex');
      });
    } catch (e) {
      // 拒绝启动时不要把数据库文件句柄留在进程里
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // ═══════════════════════════ 基础工具 ═══════════════════════════

  /** 生成编号（不是秘密：登录票据、会话令牌另用密码学随机源）。 */
  id(prefix: string): string {
    let out = '';
    for (let i = 0; i < 12; i++) out += ID_ALPHABET[this.rng.int(ID_ALPHABET.length)];
    return `${prefix}_${out}`;
  }

  today(at: number = this.now()): string {
    return businessDate(this.params.timezone, at);
  }

  private mac(text: string): string {
    return createHmac('sha256', this.secret).update(text).digest('base64url').slice(0, 10);
  }

  /** 小游戏的随机流：有种子时按活动隔离、可序列化；没有种子时用密码学随机。 */
  gameRng(activityId: string, saved: string | null): { rng: Rng; save: () => string | null } {
    if (this.seed === null) return { rng: new CryptoRng(), save: () => null };
    const rng = saved ? SeededRng.restore(saved) : new SeededRng(`${this.seed}:${this.worldId}:${activityId}`);
    return { rng, save: () => rng.saveState() };
  }

  // ═══════════════════════════ 居民读写 ═══════════════════════════

  private hydrate(row: Row): ResidentRow {
    return {
      ...(row as ResidentRow),
      state: parseJson<ResidentState>(row.state_json, {} as ResidentState),
    };
  }

  resident(id: string): ResidentRow | undefined {
    const row = this.db.get('SELECT * FROM residents WHERE resident_id = ? AND world_id = ?', id, this.worldId);
    return row ? this.hydrate(row) : undefined;
  }

  mustResident(id: string): ResidentRow {
    const r = this.resident(id);
    if (!r) throw new WorldError('not_available', '找不到这位居民。');
    return r;
  }

  residentOfPrincipal(principalId: string): ResidentRow | undefined {
    const row = this.db.get('SELECT * FROM residents WHERE world_id = ? AND principal_id = ?', this.worldId, principalId);
    return row ? this.hydrate(row) : undefined;
  }

  /** 把居民行写回，并递增 revision。 */
  saveResident(r: ResidentRow): void {
    r.revision += 1;
    this.db.run(
      `UPDATE residents SET name = ?, location_id = ?, activity_id = ?, context_version = ?, control_epoch = ?,
        controller_client = ?, controller_until = ?, presence_epoch = ?, present_since = ?, present_ms = ?, revision = ?,
        state_json = ?, last_seen_at = ? WHERE resident_id = ?`,
      r.name,
      r.location_id,
      r.activity_id,
      r.context_version,
      r.control_epoch,
      r.controller_client,
      r.controller_until,
      r.presence_epoch,
      r.present_since,
      r.present_ms,
      r.revision,
      JSON.stringify(r.state),
      r.last_seen_at,
      r.resident_id,
    );
  }

  /** 居民当前所在的区域。走在路上也有区域（'road' 或正经过的地点），不会是空的。 */
  spaceOf(r: ResidentRow): string {
    return r.location_id;
  }

  /** 在场、不在小游戏里：可以现场互动。正在走路也算。 */
  interactive(r: ResidentRow): boolean {
    return r.present_since !== null && !r.activity_id;
  }

  /** 某个空间里此刻可互动的居民（现场消息的受众）。 */
  audienceIn(spaceId: string): ResidentRow[] {
    return this.db
      .all(
        `SELECT * FROM residents WHERE world_id = ? AND location_id = ? AND present_since IS NOT NULL AND activity_id IS NULL
         ORDER BY resident_id`,
        this.worldId,
        spaceId,
      )
      .map((row) => this.hydrate(row));
  }

  presentCount(): number {
    return this.db.scalar('SELECT COUNT(*) FROM residents WHERE world_id = ? AND present_since IS NOT NULL', this.worldId);
  }

  // ═══════════════════════════ 事件流 ═══════════════════════════

  private nextCursor(streamKey: string): number {
    const head = this.db.get<{ high_water: number }>('SELECT high_water FROM stream_heads WHERE stream_key = ?', streamKey);
    const next = (head?.high_water ?? 0) + 1;
    if (head) this.db.run('UPDATE stream_heads SET high_water = ? WHERE stream_key = ?', next, streamKey);
    else this.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1)', streamKey, next);
    return next;
  }

  streamHead(streamKey: string): { highWater: number; retainedFrom: number } {
    const head = this.db.get<{ high_water: number; retained_from: number }>('SELECT high_water, retained_from FROM stream_heads WHERE stream_key = ?', streamKey);
    return { highWater: head?.high_water ?? 0, retainedFrom: head?.retained_from ?? 1 };
  }

  /**
   * 给指定居民各写一条可见事件（投影先落盘，提交后才推送）。
   * 每位居民用自己的连续游标：不会因为别人的私密事件出现空档。
   */
  emitTo(residentIds: Iterable<string>, type: string, projection: Record<string, unknown>, occurredAt: number = this.now()): void {
    const body = JSON.stringify(projection);
    const created = this.now();
    for (const rid of new Set(residentIds)) {
      const cursor = this.nextCursor(`r:${rid}`);
      this.db.run('INSERT INTO recipient_events(resident_id, cursor, type, projection, occurred_at, created_at) VALUES (?,?,?,?,?,?)', rid, cursor, type, body, occurredAt, created);
      this.pendingBumps.add(rid);
      this.metrics.eventsPrivate++;
    }
  }

  /** 公开事件流（旁观者也能看）：只放允许公开的投影。 */
  emitPublic(type: string, projection: Record<string, unknown>, occurredAt: number = this.now()): void {
    const cursor = this.nextCursor(`pub:${this.worldId}`);
    this.db.run(
      'INSERT INTO public_events(world_id, cursor, type, projection, occurred_at, created_at) VALUES (?,?,?,?,?,?)',
      this.worldId,
      cursor,
      type,
      JSON.stringify(projection),
      occurredAt,
      this.now(),
    );
    this.pendingPublic = true;
    this.metrics.eventsPublic++;
  }

  /**
   * 记一条结构化事实（内部事实表）。愿望进度、关系、共同经历、日报都从事实出发，不从聊天文字出发。
   * visibility=public 的事实才可能进公开日报。
   */
  fact(
    type: string,
    parties: { id: string; role: string }[],
    data: Record<string, unknown>,
    opts: { visibility?: 'public' | 'private'; occurredAt?: number } = {},
  ): FactRecord {
    const occurredAt = opts.occurredAt ?? this.now();
    const visibility = opts.visibility ?? 'private';
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO world_events(world_id, type, visibility, occurred_at, processed_at, payload) VALUES (?,?,?,?,?,?)',
      this.worldId,
      type,
      visibility,
      occurredAt,
      this.now(),
      JSON.stringify(data),
    );
    const seen = new Set<string>();
    for (const p of parties) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      this.db.run('INSERT INTO event_parties(event_id, resident_id, role) VALUES (?,?,?)', lastInsertRowid, p.id, p.role);
    }
    const rec: FactRecord = { eventId: lastInsertRowid, type, parties, data, occurredAt, visibility };
    for (const h of this.hooks.fact) h(rec);
    return rec;
  }

  /** 游标对外是不透明字符串，绑定世界、主体和流类型：拿别人的或别的流的游标来用会被要求重同步。 */
  encodeCursor(kind: 'r' | 'p', scope: string, n: number): string {
    return `${kind}${n.toString(36)}.${this.mac(`${kind}:${this.worldId}:${scope}:${n}`)}`;
  }

  decodeCursor(kind: 'r' | 'p', scope: string, cursor: string | undefined | null): number | null {
    if (cursor === undefined || cursor === null || cursor === '') return null;
    const m = /^([rp])([0-9a-z]+)\.([\w-]+)$/.exec(String(cursor));
    if (!m || m[1] !== kind) return null;
    const n = Number.parseInt(m[2]!, 36);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    const want = Buffer.from(this.mac(`${kind}:${this.worldId}:${scope}:${n}`));
    const got = Buffer.from(m[3]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return n;
  }

  /**
   * 读取某位居民游标之后的事件。游标无效、或者中间的事件已经被裁剪，返回 resync=true（调用方给一份新的授权快照）。
   */
  readResidentEvents(residentId: string, cursor: string | undefined | null, limit = 100): StreamRead {
    return this.readStream('r', residentId, `r:${residentId}`, cursor, limit, (after, lim) =>
      this.db.all('SELECT cursor, type, projection, occurred_at FROM recipient_events WHERE resident_id = ? AND cursor > ? ORDER BY cursor LIMIT ?', residentId, after, lim),
    );
  }

  readPublicEvents(cursor: string | undefined | null, limit = 100): StreamRead {
    return this.readStream('p', 'public', `pub:${this.worldId}`, cursor, limit, (after, lim) =>
      this.db.all('SELECT cursor, type, projection, occurred_at FROM public_events WHERE world_id = ? AND cursor > ? ORDER BY cursor LIMIT ?', this.worldId, after, lim),
    );
  }

  private readStream(kind: 'r' | 'p', scope: string, key: string, cursor: string | undefined | null, limit: number, query: (after: number, limit: number) => Row[]): StreamRead {
    const head = this.streamHead(key);
    const after = this.decodeCursor(kind, scope, cursor);
    const headCursor = this.encodeCursor(kind, scope, head.highWater);
    // 没带游标 = 从当前水位开始（新连接不回放历史）；带了无效游标、超出水位或落在已裁剪区间 = 重同步
    if (cursor === undefined || cursor === null || cursor === '') return { events: [], cursor: headCursor, resync: false, more: false };
    if (after === null || after > head.highWater || after < head.retainedFrom - 1) return { events: [], cursor: headCursor, resync: true, more: false };
    const rows = query(after, limit + 1);
    const more = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ({
      id: this.encodeCursor(kind, scope, row.cursor),
      type: String(row.type),
      at: Number(row.occurred_at),
      data: parseJson<Record<string, unknown>>(row.projection, {}),
    }));
    return { events, cursor: events.length ? events[events.length - 1]!.id : this.encodeCursor(kind, scope, after), resync: false, more };
  }

  cursorOf(residentId: string): string {
    return this.encodeCursor('r', residentId, this.streamHead(`r:${residentId}`).highWater);
  }

  publicCursor(): string {
    return this.encodeCursor('p', 'public', this.streamHead(`pub:${this.worldId}`).highWater);
  }

  // ═══════════════════════════ 订阅与等待 ═══════════════════════════

  /** 事务提交后调用：唤醒有新事件的居民和公开流的订阅者。事务回滚时待唤醒名单被丢弃。 */
  private flushBumps(): void {
    const ids = this.pendingBumps;
    const pub = this.pendingPublic;
    const space = this.pendingSpace;
    this.pendingBumps = new Set();
    this.pendingPublic = false;
    this.pendingSpace = new Set();
    // 订阅者出错不能影响已经提交的结果（否则调用方会把成功的事务当成失败重试）
    const safeEmit = (name: string) => {
      // 逐个调用：一个订阅者抛错不影响其他订阅者
      for (const fn of this.emitter.listeners(name)) {
        try {
          fn();
        } catch (e) {
          this.log(`[town] 事件订阅者出错（已忽略）：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    for (const id of ids) safeEmit(`r:${id}`);
    if (pub) safeEmit('public');
    if (space.size > 0) {
      const keys = [...space];
      for (const fn of this.emitter.listeners('space')) {
        try {
          (fn as (keys: string[]) => void)(keys);
        } catch (e) {
          this.log(`[town] 空间订阅者出错（已忽略）：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  private dropBumps(): void {
    this.pendingBumps = new Set();
    this.pendingPublic = false;
    this.pendingSpace = new Set();
  }

  /**
   * 某个场景实例里有人的位置或运动变了（键是「场景|实例」）。和事件一样，提交之后才通知订阅者。
   * 空间更新是可合并的画面同步，不是耐久事件：不进事件表，丢了重新取快照就行。
   */
  bumpSpace(sceneKey: string): void {
    this.pendingSpace.add(sceneKey);
  }

  onSpace(fn: (sceneKeys: string[]) => void): () => void {
    this.emitter.on('space', fn);
    return () => this.emitter.off('space', fn);
  }

  /** 订阅某位居民的新事件通知（SSE 用）。返回取消函数。 */
  onResident(residentId: string, fn: () => void): () => void {
    this.emitter.on(`r:${residentId}`, fn);
    return () => this.emitter.off(`r:${residentId}`, fn);
  }

  onPublic(fn: () => void): () => void {
    this.emitter.on('public', fn);
    return () => this.emitter.off('public', fn);
  }

  /** 强制关闭某位居民的所有订阅（权限撤销、显式离开）。 */
  onRevoke(residentId: string, fn: () => void): () => void {
    this.emitter.on(`revoke:${residentId}`, fn);
    return () => this.emitter.off(`revoke:${residentId}`, fn);
  }

  revokeStreams(residentId: string): void {
    this.emitter.emit(`revoke:${residentId}`);
  }

  /**
   * 等到这位居民有游标之后的新事件、上下文版本变化，或超时。先登记监听再复查，检查和开始等待之间不会漏事件。
   * 心跳和等待超时本身不产生事件。
   */
  async waitResident(residentId: string, cursor: string | undefined, contextVersion: number | undefined, maxMs: number, signal?: AbortSignal): Promise<'event' | 'context' | 'timeout'> {
    // 没带游标 = 从调用这一刻的位置开始等（和事件流「无游标从当前位置开始」一致）
    const baseline = cursor ? null : this.streamHead(`r:${residentId}`).highWater;
    const check = (): 'event' | 'context' | null => {
      const r = this.resident(residentId);
      if (!r) return 'context';
      if (contextVersion !== undefined && r.context_version !== contextVersion) return 'context';
      const head = this.streamHead(`r:${residentId}`);
      if (baseline !== null) return head.highWater > baseline ? 'event' : null;
      const after = this.decodeCursor('r', residentId, cursor);
      if (after === null || after < head.highWater) return 'event';
      return null;
    };
    const first = check();
    if (first) return first;
    if (maxMs <= 0 || signal?.aborted) return 'timeout';
    return new Promise((resolve) => {
      let done = false;
      const finish = (why: 'event' | 'context' | 'timeout') => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(why);
      };
      const onBump = () => {
        const why = check();
        if (why) finish(why);
      };
      const onAbort = () => finish('timeout');
      const off = this.onResident(residentId, onBump);
      const timer = setTimeout(() => finish('timeout'), maxMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // 登记之后再查一次
      onBump();
    });
  }

  // ═══════════════════════════ 事务包装 ═══════════════════════════

  /** 写事务 + 提交后唤醒。失败时丢弃候选状态和待唤醒名单。 */
  commit<T>(fn: () => T): T {
    if (this.db.inTx) return fn();
    try {
      const out = this.db.tx(fn);
      this.flushBumps();
      return out;
    } catch (e) {
      this.dropBumps();
      // 候选的小游戏记录可能已经换进缓存之外的对象：缓存只在提交成功后替换（见 games.ts），这里不用动
      this.noteWriteFailure(e);
      throw e;
    }
  }

  private noteWriteFailure(e: unknown): void {
    if (e instanceof WorldError) return;
    const x = e as { name?: unknown; code?: unknown; errstr?: unknown } | null;
    // 游戏规则错误的消息里原样带着玩家输入，绝不能据此判断数据库状态
    if (x && x.name === 'GameError') return;
    const code = String(x?.code ?? '');
    const errstr = String(x?.errstr ?? '');
    // 只信数据库层抛出的错误（node:sqlite 的 code 为 ERR_SQLITE_ERROR，或带 SQLITE_ 前缀，或有 errstr）
    if (!(code === 'ERR_SQLITE_ERROR' || /^SQLITE_/i.test(code) || errstr !== '')) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (/SQLITE_(FULL|IOERR|READONLY|CORRUPT|CANTOPEN)|disk is full|readonly database|disk I\/O error/i.test(`${code} ${errstr} ${msg}`)) {
      if (this.status === 'running') {
        this.status = 'degraded';
        this.log(`[town] 数据库不可写，暂停接受变更：${msg}`);
      }
    }
  }

  // ═══════════════════════════ 动作窗口与回执 ═══════════════════════════

  /** 服务端签发的动作窗口：带有效期，过期后同一个请求号不能再执行。重新读取视图会拿到新的窗口。 */
  issueActionWindow(residentId: string, at: number = this.now()): string {
    const issued = at.toString(36);
    return `aw.${issued}.${this.mac(`aw:${residentId}:${issued}`)}`;
  }

  private actionWindowValid(residentId: string, window: string | undefined, now: number): boolean {
    if (!window) return false;
    const m = /^aw\.([0-9a-z]+)\.([\w-]+)$/.exec(window);
    if (!m) return false;
    const want = Buffer.from(this.mac(`aw:${residentId}:${m[1]}`));
    const got = Buffer.from(m[2]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    const issued = Number.parseInt(m[1]!, 36);
    return now >= issued - 60_000 && now - issued <= this.params.commandRetryWindowMs;
  }

  /**
   * 执行一条居民动作。顺序：
   *  1. 先把已经到期的定时任务处理掉（到达、失效先于新动作生效）。
   *  2. 认证主体对应的居民 → 查历史回执：同请求号同内容返回原回执；同请求号换了内容返回冲突。
   *  3. 新请求才检查动作窗口、控制权、上下文，再执行业务规则。
   *  4. 变化、回执、事件在同一事务提交；提交成功后才唤醒订阅者。
   */
  command(auth: Auth, req: CommandRequest): Record<string, unknown> {
    const t0 = performance.now();
    if (this.status !== 'running') {
      throw new WorldError('recovering', this.status === 'recovering' ? '小镇正在恢复，请稍后用同一个请求号重试。' : '小镇暂时不能保存变化，请稍后用同一个请求号重试。');
    }
    const requestId = typeof req?.requestId === 'string' ? req.requestId : '';
    if (!REQUEST_ID_RE.test(requestId)) throw badRequest('需要 requestId（8~80 个字母、数字或 -_.:）。每个有意的新动作用一个新的请求号。');
    const action = req.action;
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw badRequest('需要 action.type。');
    const handler = this.handlers.get(action.type);
    if (!handler) throw badRequest(`不认识的动作类型：${String(action.type).slice(0, 40)}`);
    this.runDue();
    const payloadHash = sha256(stableStringify(action));
    let domainMs = 0;
    try {
      const out = this.commit(() => {
        const now = this.now();
        const r = this.residentOfPrincipal(auth.principalId);
        if (!r) throw new WorldError('unauthenticated', '还没有居民身份，请先进入小镇。', 'no_resident');
        const receipt = this.db.get('SELECT payload_hash, response FROM request_receipts WHERE resident_id = ? AND request_id = ?', r.resident_id, requestId);
        if (receipt) {
          if (receipt.payload_hash !== payloadHash) {
            throw new WorldError('request_conflict', '这个请求号已经用于另一个不同的动作。新的动作请用新的请求号。');
          }
          this.metrics.replays++;
          return { ...parseJson<Record<string, unknown>>(receipt.response, {}), replayed: true };
        }
        if (!this.actionWindowValid(r.resident_id, req.actionWindow, now)) {
          throw new WorldError('request_expired', '动作窗口已过期。请重新读取视图，再用新的请求号发起动作。');
        }
        if (r.present_since === null) throw precondition('你现在不在小镇里，请先进入。', 'not_present');
        if (r.controller_client !== auth.clientId || r.controller_until <= now || req.expected?.controlEpoch !== r.control_epoch) {
          throw new WorldError('control_lost', '这个页面（或运行器）现在没有这位居民的控制权。', undefined, { controlEpoch: undefined });
        }
        const expectedActivity = req.expected?.activityId ?? null;
        if (req.expected?.contextVersion !== r.context_version || expectedActivity !== r.activity_id) {
          throw new WorldError('context_stale', '你的上下文已经变化（进入或离开了一局游戏）。这条动作没有执行，请重新读取视图。', undefined, {
            contextVersion: r.context_version,
            activityId: r.activity_id,
          });
        }
        const inGameAction = this.activityActions.has(action.type);
        if (r.activity_id && !inGameAction) throw precondition('你正在一局游戏里，这个动作要等游戏结束或退出后才能做。', 'in_activity');
        if (!r.activity_id && inGameAction) throw new WorldError('context_stale', '你现在不在这局游戏里。', undefined, { contextVersion: r.context_version, activityId: null });
        const d0 = performance.now();
        const result = handler({ w: this, r, action: action as Record<string, any>, now, requestId }) ?? {};
        domainMs = performance.now() - d0;
        const after = this.mustResident(r.resident_id);
        for (const h of this.hooks.afterCommand) h(after, now);
        const response: Record<string, unknown> = {
          ok: true,
          requestId,
          status: 'accepted',
          ...result,
          contextVersion: after.context_version,
          activityId: after.activity_id,
          cursor: this.cursorOf(r.resident_id),
        };
        this.db.run(
          'INSERT INTO request_receipts(resident_id, request_id, payload_hash, context_version, response, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
          r.resident_id,
          requestId,
          payloadHash,
          r.context_version,
          JSON.stringify(response),
          now,
          now + this.params.receiptRetentionMs,
        );
        return response;
      });
      this.metrics.commands++;
      this.metrics.domain.add(domainMs);
      this.metrics.commit.add(this.db.lastCommitMs);
      this.metrics.total.add(performance.now() - t0);
      return out;
    } catch (e) {
      this.metrics.rejected++;
      throw this.translate(e);
    }
  }

  /** 把小游戏规则错误（GameError）翻译成世界错误码；其余原样抛出。 */
  translate(e: unknown): unknown {
    if (e instanceof WorldError) return e;
    const ge = e as { name?: string; code?: string; message?: string; hint?: string };
    if (ge?.name === 'GameError') {
      return new WorldError('precondition_failed', `${ge.message ?? '这个动作现在不能做。'}${ge.hint ? ` ${ge.hint}` : ''}`, `game_${String(ge.code ?? '').toLowerCase()}`);
    }
    if (this.status === 'degraded') return new WorldError('recovering', '小镇暂时不能保存变化，请稍后用同一个请求号重试。');
    return e;
  }

  // ═══════════════════════════ 定时任务 ═══════════════════════════

  /** 一次性任务：同一个去重键只会存在一条，重复安排不产生第二条。 */
  schedule(kind: string, dedupeKey: string, dueAt: number, payload: Record<string, unknown> = {}): void {
    this.db.run(
      `INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at) VALUES (?,?,?,?,?,'pending',?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
      dedupeKey,
      Math.round(dueAt),
      JOB_PRIORITY[kind] ?? 9,
      kind,
      JSON.stringify(payload),
      this.now(),
    );
  }

  /** 可反复续期的任务（在场租约之类）：同一个键只有一条，重新安排就是改它的到期时间。 */
  reschedule(kind: string, dedupeKey: string, dueAt: number, payload: Record<string, unknown> = {}): void {
    this.db.run(
      `INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at) VALUES (?,?,?,?,?,'pending',?)
       ON CONFLICT(dedupe_key) DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload, status = 'pending', attempts = 0, last_error = NULL, processed_at = NULL`,
      dedupeKey,
      Math.round(dueAt),
      JOB_PRIORITY[kind] ?? 9,
      kind,
      JSON.stringify(payload),
      this.now(),
    );
  }

  cancelJob(dedupeKey: string): void {
    this.db.run("UPDATE scheduled_jobs SET status = 'cancelled', processed_at = ? WHERE dedupe_key = ? AND status = 'pending'", this.now(), dedupeKey);
  }

  /**
   * 处理已经到期的任务。每条任务一个事务：执行、状态变化、标记完成一起提交；失败的任务保留原去重键稍后重试。
   * 同一时刻的任务按固定优先级和编号排序。返回处理了几条。
   */
  runDue(limit = 500): number {
    if (this.status === 'closed' || this.db.inTx) return 0;
    let done = 0;
    const skipped = new Set<number>();
    for (;;) {
      if (done >= limit) break;
      const now = this.now();
      const candidates = this.db.all<Row>(
        "SELECT job_id, dedupe_key, due_at, kind, payload, attempts FROM scheduled_jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, priority, job_id LIMIT ?",
        now,
        skipped.size + 1,
      );
      const job = candidates.find((j) => !skipped.has(j.job_id)) as JobRow | undefined;
      if (!job) break;
      const handler = this.jobHandlers.get(job.kind);
      try {
        this.commit(() => {
          // 事务内再确认一次：没有被别的路径处理或取消
          const fresh = this.db.get("SELECT status, due_at FROM scheduled_jobs WHERE job_id = ? AND status = 'pending'", job.job_id);
          if (!fresh || fresh.due_at > this.now()) return;
          if (!handler) throw new Error(`没有处理器的任务类型：${job.kind}`);
          handler(parseJson<Record<string, any>>(job.payload, {}), { ...job, due_at: Number(fresh.due_at) }, this.now());
          // 处理器可能把同一条任务重新安排了（续期）：只有仍是原来那次到期时才标记完成
          this.db.run("UPDATE scheduled_jobs SET status = 'done', processed_at = ? WHERE job_id = ? AND status = 'pending' AND due_at = ?", this.now(), job.job_id, fresh.due_at);
        });
        this.metrics.jobs++;
        done++;
      } catch (e) {
        skipped.add(job.job_id);
        // 数据库写不进去（磁盘满、只读）不是任务自己的错：不计重试、不搁置，等恢复可写后按现实时间追赶
        if (this.status === 'degraded') break;
        const msg = e instanceof Error ? e.message : String(e);
        const attempts = job.attempts + 1;
        try {
          this.db.tx(() => {
            // 只改还在待办里的任务：事务其实已经提交（任务是 done）时，不能把它改回待办再执行一次
            this.db.run(
              "UPDATE scheduled_jobs SET attempts = ?, last_error = ?, status = ? WHERE job_id = ? AND status = 'pending'",
              attempts,
              msg.slice(0, 300),
              attempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'pending',
              job.job_id,
            );
          });
        } catch {
          /* 数据库不可写：下次 tick 再试 */
        }
        this.metrics.jobRetries++;
        if (attempts >= MAX_JOB_ATTEMPTS) {
          this.metrics.jobFailures++;
          this.log(`[town] 任务 ${job.kind}#${job.job_id} 重试 ${attempts} 次仍失败，已搁置：${msg}`);
        }
      }
    }
    return done;
  }

  pendingJobs(): number {
    return this.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'pending' AND due_at <= ?", this.now());
  }

  // ═══════════════════════════ 启动恢复与心跳 ═══════════════════════════

  /**
   * 启动恢复：按停机前的健康检查点和现在的真实时间追赶。到期事务各结算一次（保留应完成时间），不逐秒重演。
   * 恢复完成前命令一律返回 recovering。分批处理，批与批之间让出事件循环。
   */
  async start(): Promise<void> {
    try {
      await this.recover(async () => new Promise((resolve) => setImmediate(resolve)));
      this.recoverFailed = false;
    } catch (e) {
      this.markRecoverFailed(e);
    }
  }

  /** 同步版本（测试用）。 */
  startSync(): void {
    try {
      void this.recover(null);
      this.recoverFailed = false;
    } catch (e) {
      this.markRecoverFailed(e);
    }
  }

  /** 启动恢复失败：保持 recovering（命令照旧拒绝），由 tick 退避重试，而不是永远停住。 */
  private recoverFailed = false;
  private recoverRetrying = false;
  private nextRecoverTry = 0;

  private markRecoverFailed(e: unknown): void {
    this.recoverFailed = true;
    this.nextRecoverTry = this.now() + 5000;
    this.log(`[town] 启动恢复失败，稍后重试：${e instanceof Error ? e.message : String(e)}`);
  }

  private recoverPhase1Done = false;
  private recoverDowntime = 0;

  private recoverPhase1(now: number): number {
    const world = this.db.get<{ last_alive_at: number }>('SELECT last_alive_at FROM worlds WHERE world_id = ?', this.worldId)!;
    const downtime = Math.max(0, now - world.last_alive_at);
    this.commit(() => {
      // 在场状态等待重新确认：重启前在场的人先按「停机那一刻离线」处理，租约留着，心跳回来就恢复
      const present = this.db.all('SELECT * FROM residents WHERE world_id = ? AND present_since IS NOT NULL', this.worldId).map((row) => this.hydrate(row));
      for (const r of present) this.goOffline(r, Math.max(r.present_since ?? 0, world.last_alive_at), 'restart');
      for (const h of this.hooks.recover) h(downtime, now);
      this.db.run('UPDATE worlds SET last_alive_at = ? WHERE world_id = ?', now, this.worldId);
    });
    this.recoverPhase1Done = true;
    this.recoverDowntime = downtime;
    this.lastOutageMs = downtime;
    return downtime;
  }

  private recover(yieldFn: (() => Promise<void>) | null): Promise<void> | void {
    const now = this.now();
    // 第一段（离线处理 + recover 钩子）只做一次：成功提交后即使后面失败重试，也不再重跑，
    // 否则各局截止时间会按更大的停机时长再顺延一次。同时把 last_alive_at 写进同一个事务，进程再重启也不会重复顺延。
    const downtime = this.recoverPhase1Done ? this.recoverDowntime : this.recoverPhase1(now);
    const finish = () => {
      this.commit(() => {
        for (const h of this.hooks.newDay) h(this.today(), this.now());
        this.db.run('UPDATE worlds SET last_alive_at = ? WHERE world_id = ?', this.now(), this.worldId);
      });
      this.lastAliveWrite = this.now();
      this.status = 'running';
      if (downtime > 5000) this.log(`[town] 恢复完成：停机约 ${Math.round(downtime / 1000)} 秒`);
    };
    if (!yieldFn) {
      while (this.runDue(200) > 0) {
        /* 追赶到期任务 */
      }
      finish();
      return;
    }
    return (async () => {
      while (this.runDue(100) > 0) await yieldFn();
      finish();
    })();
  }

  /**
   * 调度器的一次检查机会（运行时每秒调用一次）。tick 不是时间本身：任务按各自的 dueAt 结算。
   * 数据库不可写时停在 degraded，写入恢复后再按现实时间追赶。
   */
  tick(): void {
    if (this.status === 'closed') return;
    if (this.status === 'recovering') {
      // 启动恢复失败过：到点重试整个恢复流程（goOffline 对已离线者无操作，第一段已完成则只重跑追赶和收尾）
      if (this.recoverFailed && !this.recoverRetrying && this.now() >= this.nextRecoverTry) {
        this.recoverRetrying = true;
        void this.start().finally(() => {
          this.recoverRetrying = false;
        });
      }
      return;
    }
    const now = this.now();
    try {
      if (this.status === 'degraded') {
        this.db.tx(() => this.db.run('UPDATE worlds SET last_alive_at = ? WHERE world_id = ?', now, this.worldId));
        this.lastAliveWrite = now;
        this.status = 'running';
        this.log('[town] 数据库恢复可写，继续追赶到期事务');
      }
      this.runDue();
      for (const h of this.hooks.tick) h(now);
      if (now - this.lastAliveWrite >= 5000 || now < this.lastAliveWrite) {
        this.db.tx(() => this.db.run('UPDATE worlds SET last_alive_at = ? WHERE world_id = ?', now, this.worldId));
        this.lastAliveWrite = now;
      }
    } catch (e) {
      this.noteWriteFailure(e);
      this.log(`[town] tick 出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  close(): void {
    if (this.status === 'closed') return;
    try {
      this.db.tx(() => this.db.run('UPDATE worlds SET last_alive_at = ? WHERE world_id = ?', this.now(), this.worldId));
    } catch {
      /* 关闭时写不进去就算了：恢复时按更早的检查点保守估计 */
    }
    this.status = 'closed';
    this.emitter.removeAllListeners();
    this.db.close();
  }

  // ═══════════════════════════ 在场 ═══════════════════════════

  /** 居民转为离线：冻结有效在场时间，交给各模块释放预留、让出没开始的席位。已提交的移动和制作照常完成。 */
  goOffline(r: ResidentRow, at: number, reason: string): void {
    if (r.present_since === null) {
      // 已经离线（租约过期/刚重启）的居民明确离开小镇：不再结算在场时间，但仍要通知各模块（如退出进行中的小游戏）
      if (reason === 'leave') for (const h of this.hooks.offline) h(r, at, reason);
      return;
    }
    r.present_ms += Math.max(0, at - r.present_since);
    r.present_since = null;
    r.last_seen_at = at;
    this.saveResident(r);
    for (const h of this.hooks.offline) h(r, at, reason);
  }

  // ═══════════════════════════ 备份与指标 ═══════════════════════════

  /** 做一份一致备份并验证能恢复。返回 null 表示内存库不备份。 */
  backup(dest?: string): { path: string; bytes: number; ms: number } | null {
    if (this.db.inMemory) return null;
    const target = dest ?? join(dirname(this.db.path), 'backups', `town-${this.today()}.db`);
    return this.db.backup(target, dest ? 0 : this.params.backupKeep);
  }

  metricsSnapshot(): Record<string, unknown> {
    return {
      status: this.status,
      present: this.presentCount(),
      residents: this.db.scalar('SELECT COUNT(*) FROM residents WHERE world_id = ?', this.worldId),
      commands: this.metrics.commands,
      rejected: this.metrics.rejected,
      replays: this.metrics.replays,
      domain_ms: this.metrics.domain.summary(),
      commit_ms: this.metrics.commit.summary(),
      total_ms: this.metrics.total.summary(),
      jobs: this.metrics.jobs,
      job_retries: this.metrics.jobRetries,
      job_failures: this.metrics.jobFailures,
      jobs_due: this.pendingJobs(),
      events_private: this.metrics.eventsPrivate,
      events_public: this.metrics.eventsPublic,
      pruned_rows: this.metrics.pruned,
      db_bytes: this.db.dbBytes(),
      wal_bytes: this.db.walBytes(),
      last_outage_ms: this.lastOutageMs,
      params_version: this.params.version,
      content_version: CONTENT_VERSION,
    };
  }
}

export interface FactRecord {
  eventId: number;
  type: string;
  parties: { id: string; role: string }[];
  data: Record<string, unknown>;
  occurredAt: number;
  visibility: 'public' | 'private';
}

export interface StreamEvent {
  /** 不透明的事件编号，同时就是续传游标 */
  id: string;
  type: string;
  at: number;
  data: Record<string, unknown>;
}

export interface StreamRead {
  events: StreamEvent[];
  cursor: string;
  resync: boolean;
  more: boolean;
}

export { sha256, stableStringify };
