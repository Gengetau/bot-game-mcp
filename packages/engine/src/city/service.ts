/**
 * CityService：晴空都城市世界的内核（事务、事件流、定时作业、启动恢复）。
 *
 * 和栖灯镇的 WorldService 是同一套纪律，但没有坐标、没有导航租约、没有控制权代数：
 *  - 所有写入都在 commit() 的同一个 SQLite 事务里：状态、账本、物品、事件、回执、outbox、定时作业一起提交或一起回滚。
 *    处理过程同步，不等模型、不等网络（天气抓取在事务外面做，抓到了再提交）。
 *  - 订阅者（world_wait、桥接的 wait）只在提交之后被唤醒。
 *  - 时间用 now()，随机用 rng；不用 Date.now() 和 Math.random()。
 *  - 机械步骤（走路、乘车、到点回家）是持久作业：没有人在线也照常到期处理，重启后按 due_at 补跑。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { CryptoRng, type Rng } from '../core/rng.js';
import { parseJson, type Row, type TownDb } from '../world/db.js';
import { businessDate, localParts } from '../world/time.js';
import { CITY_WORLD_ID, CITY_WORLD_NAME, validateCatalog, type CatalogTimeContext } from './catalog.js';
import { openCityDb } from './db.js';
import { CityError } from './errors.js';
import { resolveCityParams, type CityParams } from './params.js';
import type { WeatherFetcher } from './weather.js';

/** 小屋的一位室友（身份映射，规格 2.1）。QQ 号之类的私密配置只在服务器的配置文件里，不进仓库。 */
export interface HouseMemberConfig {
  /** 内核里的 actor_id：nia / claire / alicia / grok / xingli / whale */
  actorId: string;
  /** 城里的显示名 */
  name: string;
  /** 公开的一句话简介 */
  bio?: string;
  /** 她在 QQ 侧的 bot 密钥对应的身份 id：这些身份在城市世界里只能看、不能进城（ENTRY_VIA_HOME_ONLY） */
  qqIds?: string[];
}

export interface CityOptions {
  /** 数据库文件；':memory:' 只用于测试 */
  dbPath: string;
  params?: Record<string, unknown>;
  now?: () => number;
  rng?: Rng;
  log?: (msg: string) => void;
  /** 小屋的室友名单。不给就没有桥接身份 */
  house?: HouseMemberConfig[];
  /** 天气抓取函数；null = 不抓（一直用退路天气）。缺省是 open-meteo */
  fetchWeather?: WeatherFetcher | null;
  /** 人类网页端公网地址（如 https://example.com/city/play/），用于拼接登录票据链接 */
  publicUrl?: string | null;
  /** 是否开启本机试玩登录（仅隔离测试环境开启） */
  devLogin?: boolean;
}

export interface CityResident {
  resident_id: string;
  principal_id: string;
  name: string;
  bio: string;
  origin: 'external' | 'house' | 'human';
  place_id: string | null;
  trip_id: string | null;
  in_city: number;
  present_until: number;
  control_epoch: number;
  controller_id: string | null;
  revision: number;
  created_at: number;
  last_seen_at: number;
}

export interface CityJobRow {
  job_id: number;
  dedupe_key: string;
  due_at: number;
  kind: string;
  payload: string;
  attempts: number;
}
export type CityJobHandler = (payload: Record<string, any>, job: CityJobRow, now: number) => void;

/** 同一时刻先处理到站、到点，再处理别的。数字小的先执行。 */
export const CITY_JOB_PRIORITY: Record<string, number> = {
  trip_leg: 1,
  visit_return: 2,
  presence_expire: 3,
  locker_expire: 4,
  reconcile_daily: 9,
  prune: 9,
};

export interface CityStreamEvent {
  id: string;
  type: string;
  at: number;
  data: Record<string, unknown>;
}
export interface CityStreamRead {
  events: CityStreamEvent[];
  cursor: string;
  resync: boolean;
  more: boolean;
}

const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const MAX_JOB_ATTEMPTS = 5;
/** 这几类作业搁置了就有人永远停在路上或回不了家：失败到上限后不标 failed，改成退避着一直重试（对账会报 stuck_jobs） */
const MUST_COMPLETE_JOBS = new Set(['trip_leg', 'visit_return']);
const JOB_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export class CityService {
  readonly db: TownDb;
  readonly worldId = CITY_WORLD_ID;
  readonly worldName = CITY_WORLD_NAME;
  readonly params: CityParams;
  readonly now: () => number;
  readonly rng: Rng;
  readonly log: (msg: string) => void;
  readonly house: readonly HouseMemberConfig[];
  readonly fetchWeather: WeatherFetcher | null | undefined;
  readonly publicUrl: string | null;
  readonly devLogin: boolean;
  status: 'recovering' | 'running' | 'degraded' | 'closed' = 'recovering';

  readonly jobHandlers = new Map<string, CityJobHandler>();
  readonly hooks = {
    /** 启动恢复时（追赶到期作业之前） */
    recover: [] as ((now: number) => void)[],
    /** 每次 tick（已在 running 状态；可以发起事务外的异步工作，比如抓天气） */
    tick: [] as ((now: number) => void)[],
  };
  /** 测试用故障注入：返回 true 时这笔购买的店家入账「结果未知」（规格 F9） */
  failpoints: { purchaseUnknown?: (ctx: { residentId: string; sku: string }) => boolean } = {};

  readonly metrics = { commands: 0, rejected: 0, replays: 0, jobs: 0, jobRetries: 0, jobFailures: 0, bridgeRequests: 0 };

  private readonly emitter = new EventEmitter();
  private readonly secret: Buffer;
  private pendingBumps = new Set<string>();
  private pendingPublic = false;
  private pendingOutbox = false;
  private recoverFailed = false;
  private nextRecoverTry = 0;

  constructor(opts: CityOptions) {
    const problems = validateCatalog();
    if (problems.length > 0) throw new Error(`城市目录有问题，拒绝启动：${problems.join('；')}`);
    this.params = resolveCityParams(opts.params ?? {});
    this.now = opts.now ?? (() => Date.now());
    this.rng = opts.rng ?? new CryptoRng();
    this.log = opts.log ?? (() => undefined);
    this.house = opts.house ?? [];
    this.fetchWeather = opts.fetchWeather;
    this.publicUrl = opts.publicUrl ?? null;
    this.devLogin = Boolean(opts.devLogin);
    const seen = new Set<string>();
    for (const m of this.house) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(m.actorId)) throw new Error(`小屋室友的 actorId 不合法：${m.actorId}`);
      if (seen.has(m.actorId)) throw new Error(`小屋室友的 actorId 重复：${m.actorId}`);
      seen.add(m.actorId);
    }
    this.emitter.setMaxListeners(0);
    this.db = openCityDb(opts.dbPath);
    try {
      this.secret = this.db.tx(() => {
        let secret = this.db.getMeta('stream_secret');
        if (!secret) {
          secret = randomBytes(32).toString('hex');
          this.db.setMeta('stream_secret', secret);
        }
        const tz = this.db.getMeta('timezone');
        if (!tz) this.db.setMeta('timezone', this.params.timezone);
        else if (tz !== this.params.timezone) throw new Error(`城市世界开服时的时区是 ${tz}，配置里现在是 ${this.params.timezone}，拒绝启动。`);
        return Buffer.from(secret, 'hex');
      });
    } catch (e) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // ═══════════════════════════ 基础工具 ═══════════════════════════

  /** 生成编号（不是秘密）。 */
  id(prefix: string): string {
    let out = '';
    for (let i = 0; i < 12; i++) out += ID_ALPHABET[this.rng.int(ID_ALPHABET.length)];
    return `${prefix}_${out}`;
  }

  today(at: number = this.now()): string {
    return businessDate(this.params.timezone, at);
  }

  /** 给目录纯函数用的世界日历与时段切面（无副作用）。 */
  catalogTime(at: number = this.now()): CatalogTimeContext {
    const dateStr = this.today(at);
    return {
      dateStr,
      jstMonth: Number(dateStr.slice(5, 7)),
      minuteOfDay: this.minuteOfDay(at),
    };
  }

  /** 世界时区里这一刻是当天第几分钟。 */
  minuteOfDay(at: number = this.now()): number {
    const p = localParts(this.params.timezone, at);
    return p.hour * 60 + p.minute;
  }

  /** 给人看的钟点（世界时区，HH:MM）。 */
  clock(at: number): string {
    const p = localParts(this.params.timezone, at);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  }

  /** 永久去重：这个键第一次出现返回 true，之后都是 false。 */
  once(key: string): boolean {
    return this.db.run('INSERT OR IGNORE INTO business_keys(key, created_at) VALUES (?,?)', key, this.now()).changes > 0;
  }

  // ═══════════════════════════ 居民 ═══════════════════════════

  resident(id: string): CityResident | undefined {
    return this.db.get<CityResident & Row>('SELECT * FROM residents WHERE resident_id = ?', id);
  }

  mustResident(id: string): CityResident {
    const r = this.resident(id);
    if (!r) throw new CityError('NOT_FOUND', '找不到这位居民。');
    return r;
  }

  residentOfPrincipal(principalId: string): CityResident | undefined {
    return this.db.get<CityResident & Row>('SELECT * FROM residents WHERE principal_id = ?', principalId);
  }

  /** 某个地点里此刻在场的居民（现场互动、现场聊天的受众）。在路上的人不在任何地点。 */
  presentAt(placeId: string): CityResident[] {
    return this.db.all<CityResident & Row>('SELECT * FROM residents WHERE place_id = ? AND in_city = 1 AND trip_id IS NULL ORDER BY resident_id', placeId);
  }

  headcount(placeId: string): number {
    return this.db.scalar('SELECT COUNT(*) FROM residents WHERE place_id = ? AND in_city = 1 AND trip_id IS NULL', placeId);
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

  /** 给指定居民各写一条私有事件（投影先落盘，提交后才唤醒）。投影里不能有别人的私密信息。 */
  emitTo(residentIds: Iterable<string>, type: string, projection: Record<string, unknown>, occurredAt: number = this.now()): void {
    const body = JSON.stringify(projection);
    const created = this.now();
    for (const rid of new Set(residentIds)) {
      const cursor = this.nextCursor(`r:${rid}`);
      this.db.run('INSERT INTO resident_events(resident_id, cursor, type, projection, occurred_at, created_at) VALUES (?,?,?,?,?,?)', rid, cursor, type, body, occurredAt, created);
      this.pendingBumps.add(rid);
    }
  }

  /** 公开事件流：只放允许公开的投影（没有小屋门口、背包、钱包、私聊）。 */
  emitPublic(type: string, projection: Record<string, unknown>, occurredAt: number = this.now()): void {
    const cursor = this.nextCursor('pub');
    this.db.run('INSERT INTO public_events(cursor, type, projection, occurred_at, created_at) VALUES (?,?,?,?,?)', cursor, type, JSON.stringify(projection), occurredAt, this.now());
    this.pendingPublic = true;
  }

  /** 桥接 outbox 有新记录（提交之后才通知等待的长轮询）。 */
  bumpOutbox(): void {
    this.pendingOutbox = true;
  }

  private mac(text: string): string {
    return createHmac('sha256', this.secret).update(text).digest('base64url').slice(0, 10);
  }

  encodeCursor(kind: 'r' | 'p', scope: string, n: number): string {
    return `${kind}${n.toString(36)}.${this.mac(`${kind}:${scope}:${n}`)}`;
  }

  decodeCursor(kind: 'r' | 'p', scope: string, cursor: string | undefined | null): number | null {
    if (cursor === undefined || cursor === null || cursor === '') return null;
    const m = /^([rp])([0-9a-z]+)\.([\w-]+)$/.exec(String(cursor));
    if (!m || m[1] !== kind) return null;
    const n = Number.parseInt(m[2]!, 36);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    const want = Buffer.from(this.mac(`${kind}:${scope}:${n}`));
    const got = Buffer.from(m[3]!);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    return n;
  }

  cursorOf(residentId: string): string {
    return this.encodeCursor('r', residentId, this.streamHead(`r:${residentId}`).highWater);
  }

  publicCursor(): string {
    return this.encodeCursor('p', 'pub', this.streamHead('pub').highWater);
  }

  /** 读某位居民游标之后的事件。不带游标 = 从当前水位开始；游标无效或落在已清理的区间 = resync。 */
  readResidentEvents(residentId: string, cursor: string | undefined | null, limit = 50): CityStreamRead {
    const head = this.streamHead(`r:${residentId}`);
    const headCursor = this.encodeCursor('r', residentId, head.highWater);
    if (cursor === undefined || cursor === null || cursor === '') return { events: [], cursor: headCursor, resync: false, more: false };
    const after = this.decodeCursor('r', residentId, cursor);
    if (after === null || after > head.highWater || after < head.retainedFrom - 1) return { events: [], cursor: headCursor, resync: true, more: false };
    const rows = this.db.all('SELECT cursor, type, projection, occurred_at FROM resident_events WHERE resident_id = ? AND cursor > ? ORDER BY cursor LIMIT ?', residentId, after, limit + 1);
    const more = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ({
      id: this.encodeCursor('r', residentId, Number(row.cursor)),
      type: String(row.type),
      at: Number(row.occurred_at),
      data: parseJson<Record<string, unknown>>(row.projection, {}),
    }));
    return { events, cursor: events.length ? events[events.length - 1]!.id : this.encodeCursor('r', residentId, after), resync: false, more };
  }

  /** 读公开游标之后的公开事件流。 */
  readPublicEvents(cursor: string | undefined | null, limit = 50): CityStreamRead {
    const head = this.streamHead('pub');
    const headCursor = this.encodeCursor('p', 'pub', head.highWater);
    if (cursor === undefined || cursor === null || cursor === '') return { events: [], cursor: headCursor, resync: false, more: false };
    const after = this.decodeCursor('p', 'pub', cursor);
    if (after === null || after > head.highWater || after < head.retainedFrom - 1) return { events: [], cursor: headCursor, resync: true, more: false };
    const rows = this.db.all('SELECT cursor, type, projection, occurred_at FROM public_events WHERE cursor > ? ORDER BY cursor LIMIT ?', after, limit + 1);
    const more = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => ({
      id: this.encodeCursor('p', 'pub', Number(row.cursor)),
      type: String(row.type),
      at: Number(row.occurred_at),
      data: parseJson<Record<string, unknown>>(row.projection, {}),
    }));
    return { events, cursor: events.length ? events[events.length - 1]!.id : this.encodeCursor('p', 'pub', after), resync: false, more };
  }

  // ═══════════════════════════ 订阅与等待 ═══════════════════════════

  onResidentBump(residentId: string, fn: () => void): () => void {
    const channel = `r:${residentId}`;
    this.emitter.on(channel, fn);
    return () => {
      this.emitter.off(channel, fn);
    };
  }

  onPublicBump(fn: () => void): () => void {
    this.emitter.on('public', fn);
    return () => {
      this.emitter.off('public', fn);
    };
  }

  onSessionRevoked(tokenHash: string, fn: () => void): () => void {
    const channel = `revoked:${tokenHash}`;
    this.emitter.on(channel, fn);
    return () => {
      this.emitter.off(channel, fn);
    };
  }

  notifySessionRevoked(tokenHash: string): void {
    for (const fn of this.emitter.listeners(`revoked:${tokenHash}`)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  private flushBumps(): void {
    const ids = this.pendingBumps;
    const pub = this.pendingPublic;
    const outbox = this.pendingOutbox;
    this.pendingBumps = new Set();
    this.pendingPublic = false;
    this.pendingOutbox = false;
    const safeEmit = (name: string) => {
      for (const fn of this.emitter.listeners(name)) {
        try {
          fn();
        } catch (e) {
          this.log(`[city] 事件订阅者出错（已忽略）：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    for (const id of ids) safeEmit(`r:${id}`);
    if (pub) safeEmit('public');
    if (outbox) safeEmit('outbox');
  }

  private dropBumps(): void {
    this.pendingBumps = new Set();
    this.pendingPublic = false;
    this.pendingOutbox = false;
  }

  private waitOn(name: string, check: () => boolean, maxMs: number, signal?: AbortSignal): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    if (maxMs <= 0 || signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (hit: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.emitter.off(name, onBump);
        signal?.removeEventListener('abort', onAbort);
        resolve(hit);
      };
      const onBump = () => {
        if (check()) finish(true);
      };
      const onAbort = () => finish(false);
      this.emitter.on(name, onBump);
      const timer = setTimeout(() => finish(false), maxMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // 登记之后再查一次：检查和开始等待之间不会漏事件
      onBump();
    });
  }

  /** 等到这位居民有游标之后的新事件，或超时。返回有没有新事件。 */
  waitResident(residentId: string, cursor: string | undefined | null, maxMs: number, signal?: AbortSignal): Promise<boolean> {
    const baseline = cursor ? null : this.streamHead(`r:${residentId}`).highWater;
    const check = (): boolean => {
      const head = this.streamHead(`r:${residentId}`);
      if (baseline !== null) return head.highWater > baseline;
      const after = this.decodeCursor('r', residentId, cursor);
      return after === null || after < head.highWater;
    };
    return this.waitOn(`r:${residentId}`, check, maxMs, signal);
  }

  /** 等到桥接 outbox 里有 seq 大于 after 的记录，或超时。 */
  waitOutbox(after: number, maxMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.waitOn('outbox', () => this.db.scalar('SELECT COALESCE(MAX(seq), 0) FROM bridge_outbox') > after, maxMs, signal);
  }

  // ═══════════════════════════ 事务包装 ═══════════════════════════

  /** 写事务 + 提交后唤醒。失败时丢弃候选状态和待唤醒名单。嵌套调用并入外层事务。 */
  commit<T>(fn: () => T): T {
    if (this.db.inTx) return fn();
    try {
      const out = this.db.tx(fn);
      this.flushBumps();
      return out;
    } catch (e) {
      this.dropBumps();
      this.noteWriteFailure(e);
      throw e;
    }
  }

  private noteWriteFailure(e: unknown): void {
    if (e instanceof CityError) return;
    const x = e as { code?: unknown; errstr?: unknown } | null;
    const code = String(x?.code ?? '');
    const errstr = String(x?.errstr ?? '');
    if (!(code === 'ERR_SQLITE_ERROR' || /^SQLITE_/i.test(code) || errstr !== '')) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (/SQLITE_(FULL|IOERR|READONLY|CORRUPT|CANTOPEN)|disk is full|readonly database|disk I\/O error/i.test(`${code} ${errstr} ${msg}`)) {
      if (this.status === 'running') {
        this.status = 'degraded';
        this.log(`[city] 数据库不可写，暂停接受变更：${msg}`);
      }
    }
  }

  /** 写接口的入口检查：恢复中或数据库不可写时，让调用方用同一个请求号稍后重试。 */
  assertRunning(): void {
    if (this.status !== 'running') {
      throw new CityError('RECOVERING', this.status === 'recovering' ? '城市正在恢复，请稍后用同一个请求号重试。' : '城市暂时不能保存变化，请稍后用同一个请求号重试。');
    }
  }

  // ═══════════════════════════ 定时作业 ═══════════════════════════

  /** 一次性作业：同一个去重键只会存在一条。 */
  schedule(kind: string, dedupeKey: string, dueAt: number, payload: Record<string, unknown> = {}): void {
    this.db.run(
      `INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at) VALUES (?,?,?,?,?,'pending',?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
      dedupeKey,
      Math.round(dueAt),
      CITY_JOB_PRIORITY[kind] ?? 9,
      kind,
      JSON.stringify(payload),
      this.now(),
    );
  }

  /** 可反复改期的作业：同一个键只有一条，重新安排就是改它的到期时间。 */
  reschedule(kind: string, dedupeKey: string, dueAt: number, payload: Record<string, unknown> = {}): void {
    this.db.run(
      `INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at) VALUES (?,?,?,?,?,'pending',?)
       ON CONFLICT(dedupe_key) DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload, status = 'pending', attempts = 0, last_error = NULL, processed_at = NULL`,
      dedupeKey,
      Math.round(dueAt),
      CITY_JOB_PRIORITY[kind] ?? 9,
      kind,
      JSON.stringify(payload),
      this.now(),
    );
  }

  cancelJob(dedupeKey: string): void {
    this.db.run("UPDATE scheduled_jobs SET status = 'cancelled', processed_at = ? WHERE dedupe_key = ? AND status = 'pending'", this.now(), dedupeKey);
  }

  /** 处理已经到期的作业。每条作业一个事务；失败的保留原去重键稍后重试。返回处理了几条。 */
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
      const job = candidates.find((j) => !skipped.has(j.job_id)) as CityJobRow | undefined;
      if (!job) break;
      const handler = this.jobHandlers.get(job.kind);
      try {
        this.commit(() => {
          const fresh = this.db.get("SELECT status, due_at FROM scheduled_jobs WHERE job_id = ? AND status = 'pending'", job.job_id);
          if (!fresh || fresh.due_at > this.now()) return;
          if (!handler) throw new Error(`没有处理器的作业类型：${job.kind}`);
          handler(parseJson<Record<string, any>>(job.payload, {}), { ...job, due_at: Number(fresh.due_at) }, this.now());
          // 处理器可能把同一条作业改期了：只有仍是原来那次到期时才标记完成
          this.db.run("UPDATE scheduled_jobs SET status = 'done', processed_at = ? WHERE job_id = ? AND status = 'pending' AND due_at = ?", this.now(), job.job_id, fresh.due_at);
        });
        this.metrics.jobs++;
        done++;
      } catch (e) {
        skipped.add(job.job_id);
        if (this.status === 'degraded') break;
        const msg = e instanceof Error ? e.message : String(e);
        const attempts = job.attempts + 1;
        const exhausted = attempts >= MAX_JOB_ATTEMPTS;
        const keep = exhausted && MUST_COMPLETE_JOBS.has(job.kind);
        // 退避只推迟「下次什么时候再试」；处理器拿到的仍是作业原定的时刻（payload 里），事件时间不受影响
        const retryAt = keep ? this.now() + JOB_BACKOFF_MS[Math.min(attempts - MAX_JOB_ATTEMPTS, JOB_BACKOFF_MS.length - 1)]! : null;
        try {
          this.db.tx(() => {
            this.db.run(
              "UPDATE scheduled_jobs SET attempts = ?, last_error = ?, status = ?, due_at = COALESCE(?, due_at) WHERE job_id = ? AND status = 'pending'",
              attempts,
              msg.slice(0, 300),
              exhausted && !keep ? 'failed' : 'pending',
              retryAt,
              job.job_id,
            );
          });
        } catch {
          /* 数据库不可写：下次 tick 再试 */
        }
        this.metrics.jobRetries++;
        if (exhausted) {
          this.metrics.jobFailures++;
          this.log(`[city] 作业 ${job.kind}#${job.job_id} 重试 ${attempts} 次仍失败，${keep ? `${Math.round((retryAt! - this.now()) / 60_000)} 分钟后再试` : '已搁置'}：${msg}`);
        }
      }
    }
    return done;
  }

  // ═══════════════════════════ 启动恢复与心跳 ═══════════════════════════

  private recover(yieldFn: (() => Promise<void>) | null): Promise<void> | void {
    this.commit(() => {
      for (const h of this.hooks.recover) h(this.now());
    });
    const finish = () => {
      this.status = 'running';
    };
    if (!yieldFn) {
      while (this.runDue(200) > 0) {
        /* 追赶到期作业：已出发的电车按原定时刻到站 */
      }
      finish();
      return;
    }
    return (async () => {
      while (this.runDue(100) > 0) await yieldFn();
      finish();
    })();
  }

  /** 启动恢复：追赶停机期间到期的作业（各结算一次，保留应完成的时刻）。完成前写接口返回 RECOVERING。 */
  async start(): Promise<void> {
    try {
      await this.recover(async () => new Promise((resolve) => setImmediate(resolve)));
      this.recoverFailed = false;
    } catch (e) {
      this.recoverFailed = true;
      this.nextRecoverTry = this.now() + 5000;
      this.log(`[city] 启动恢复失败，稍后重试：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 同步版本（测试用）。 */
  startSync(): void {
    void this.recover(null);
  }

  /** 调度器的一次检查机会（运行时每秒一次）。tick 不是时间本身：作业按各自的 due_at 结算。 */
  tick(): void {
    if (this.status === 'closed') return;
    if (this.status === 'recovering') {
      if (this.recoverFailed && this.now() >= this.nextRecoverTry) {
        this.recoverFailed = false;
        void this.start();
      }
      return;
    }
    const now = this.now();
    try {
      if (this.status === 'degraded') {
        this.db.tx(() => this.db.setMeta('last_alive_at', String(now)));
        this.status = 'running';
        this.log('[city] 数据库恢复可写，继续追赶到期作业');
      }
      this.runDue();
      for (const h of this.hooks.tick) h(now);
    } catch (e) {
      this.noteWriteFailure(e);
      this.log(`[city] tick 出错：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  close(): void {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.emitter.removeAllListeners();
    this.db.close();
  }

  /** 做一份一致备份并验证能恢复。内存库不备份。 */
  backup(dest?: string): { path: string; bytes: number; ms: number } | null {
    if (this.db.inMemory) return null;
    const target = dest ?? join(dirname(this.db.path), 'backups', `city-${this.today()}.db`);
    return this.db.backup(target, dest ? 0 : this.params.backupKeep);
  }
}
