/**
 * 栖灯镇验证脚本（world-simulate / world-load）共用的小工具：
 *   - 可控时钟、种子随机、统计分位
 *   - 居民的注册 / 进入 / 发动作（和真实客户端走同一条 WorldService.command 管线）
 *   - 不变量检查器（读数据库做只读断言，不改任何东西）
 *
 * 这些脚本直接 import 引擎源码（和 e2e.ts 一样用相对路径），不需要先 npm run build。
 * 随机一律走注入的 SeededRng；这里不用 Math.random，也不读系统时间做决策。
 */
import { createHash } from 'node:crypto';
import type { Row } from '../packages/engine/src/world/db.js';
import {
  SeededRng,
  WorldError,
  agentPrincipal,
  claimControl,
  createRegistry,
  createWorld,
  enterWorld,
  enterWorldAgent,
  exchangeTicket,
  issueTicket,
  leaveWorld,
  sessionPrincipal,
  townAgentView,
  townHeartbeat,
  townMeView,
  townPublicView,
  type WorldOptions,
  type WorldService,
} from '../packages/engine/src/index.js';
import { BOOKS, PLACES } from '../packages/engine/src/world/content.js';
import { controlDisconnected, renewNavigation, sceneView, whereabouts } from '../packages/engine/src/world/index.js';
import { actorOf, posOf, positionOfResident } from '../packages/engine/src/world/space.js';
import { distance, isWalkable, zoneAt } from '../packages/engine/src/world/spatial/grid.js';
import { arrivalAt, positionAt } from '../packages/engine/src/world/spatial/motion.js';
import type { NavState } from '../packages/engine/src/world/types.js';

export { WorldError, townMeView, townAgentView, townPublicView, controlDisconnected, renewNavigation, sceneView, whereabouts, actorOf, posOf, positionOfResident, positionAt, arrivalAt, distance, isWalkable, zoneAt };
export type { WorldService };

// ───────────────────────── 时钟与随机 ─────────────────────────

/** 可控时钟：逻辑时间由脚本推进，不真等。 */
export class Clock {
  constructor(public t: number) {}
  now = (): number => this.t;
}

/** 2026-11-02 00:00（Asia/Tokyo，周一）。含周末，覆盖三种公共事件。 */
export const TOWN_START = Date.UTC(2026, 10, 1, 15, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** 种子随机的便利封装（唯一的随机来源）。 */
export class Rand {
  private readonly r: SeededRng;
  constructor(readonly seed: string) {
    this.r = new SeededRng(seed);
  }
  int(n: number): number {
    return n <= 1 ? 0 : this.r.int(n);
  }
  float(): number {
    return this.r.int(1 << 30) / (1 << 30);
  }
  chance(p: number): boolean {
    return this.float() < p;
  }
  /** [a, b] 闭区间整数 */
  range(a: number, b: number): number {
    return a + this.int(b - a + 1);
  }
  pick<T>(a: readonly T[]): T {
    return a[this.int(a.length)]!;
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T | undefined {
    const total = items.reduce((s, [, w]) => s + Math.max(0, w), 0);
    if (total <= 0) return undefined;
    let roll = this.float() * total;
    for (const [v, w] of items) {
      roll -= Math.max(0, w);
      if (roll < 0) return v;
    }
    return items[items.length - 1]![0];
  }
  shuffle<T>(a: readonly T[]): T[] {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  fork(label: string): Rand {
    return new Rand(`${this.seed}/${label}`);
  }
}

// ───────────────────────── 统计 ─────────────────────────

export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}

export interface DistSummary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(values: readonly number[]): DistSummary {
  if (values.length === 0) return { n: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { n: s.length, min: s[0]!, p50: percentile(s, 0.5), p95: percentile(s, 0.95), p99: percentile(s, 0.99), max: s[s.length - 1]!, mean: sum / s.length };
}

export const utf8Bytes = (v: unknown): number => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
export const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);
export const fmtMs = (n: number): string => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
}
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 简单的表格输出（等宽对齐，中文按两格宽度算）。 */
export function table(rows: string[][]): string {
  const width = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const cols = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => width(r[i] ?? ''))));
  return rows.map((r) => r.map((c, i) => c + ' '.repeat(Math.max(0, w[i]! - width(c)))).join('  ').trimEnd()).join('\n');
}

// ───────────────────────── 居民与命令 ─────────────────────────

export type Kind = 'human' | 'agent';

export interface Person {
  idx: number;
  name: string;
  kind: Kind;
  principalId: string;
  residentId: string;
}

export type Outcome =
  | { ok: true; out: Record<string, any>; ms: number }
  | { ok: false; code: string; reason?: string; message: string; data?: Record<string, unknown>; ms: number; internal?: unknown };

export const isOk = (o: Outcome): o is Extract<Outcome, { ok: true }> => o.ok;

/** 统一的命令执行：区分「世界的拒绝」（WorldError）和「内部异常」（任何别的异常都是 bug）。 */
export function runCommand(w: WorldService, auth: { principalId: string; clientId: string }, req: Parameters<WorldService['command']>[1]): Outcome {
  const t0 = performance.now();
  try {
    const out = w.command(auth, req) as Record<string, any>;
    return { ok: true, out, ms: performance.now() - t0 };
  } catch (e) {
    const ms = performance.now() - t0;
    if (e instanceof WorldError) return { ok: false, code: e.code, ...(e.reason ? { reason: e.reason } : {}), message: e.message, ...(e.data ? { data: e.data } : {}), ms };
    return { ok: false, code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), ms, internal: e };
  }
}

/** 命令计数：按动作类型和错误码。 */
export class CmdStats {
  total = 0;
  ok = 0;
  replayed = 0;
  readonly err = new Map<string, number>();
  readonly reasons = new Map<string, number>();
  readonly byType = new Map<string, { ok: number; err: number }>();
  readonly lat: number[] = [];
  record(type: string, o: Outcome, keepLatency = false): void {
    this.total++;
    const t = this.byType.get(type) ?? { ok: 0, err: 0 };
    if (o.ok) {
      this.ok++;
      t.ok++;
      if (o.out.replayed) this.replayed++;
    } else {
      t.err++;
      this.err.set(o.code, (this.err.get(o.code) ?? 0) + 1);
      const key = `${o.code}${o.reason ? `/${o.reason}` : ''}`;
      this.reasons.set(key, (this.reasons.get(key) ?? 0) + 1);
    }
    this.byType.set(type, t);
    if (keepLatency) this.lat.push(o.ms);
  }
}

export const NAMES = [
  '阿灯', '小岚', '青禾', '知秋', '拾光', '临溪', '半夏', '听雨', '松烟', '明澈', '远山', '白露', '星野', '晚晴', '归舟', '浮玉', '长风', '素心', '云舒', '苔衣',
  '桑落', '月白', '灯芯', '野渡', '雾棠', '槐序', '海盐', '微澜', '燕尾', '栗子', '鹿鸣', '暮雪', '竹影', '芥末', '榛子', '棠梨', '蒲公英', '茶茶', '阿砚', '朝露',
];
const TRAIT_IDS = ['quiet', 'outgoing', 'meticulous', 'curious', 'gentle', 'playful'];
const INTEREST_IDS = ['books', 'cooking', 'plants', 'games', 'tea', 'letters'];

export function personName(idx: number): string {
  return idx < NAMES.length ? NAMES[idx]! : `${NAMES[idx % NAMES.length]}${Math.floor(idx / NAMES.length) + 1}`;
}

export function randomProfile(rnd: Rand, name: string): { name: string; bio: string; traits: string[]; interests: string[] } {
  return {
    name,
    bio: `我是${name}。`,
    traits: rnd.shuffle(TRAIT_IDS).slice(0, 2),
    interests: rnd.shuffle(INTEREST_IDS).slice(0, 3),
  };
}

/** 登记主体：AI 走 MCP 身份，真人走「可信适配层签发票据 → 兑换会话」。还没有居民，进入时才注册。 */
export function makePrincipal(w: WorldService, idx: number, kind: Kind, name: string): string {
  if (kind === 'agent') return agentPrincipal(w, { id: String(3000 + idx), name }).principal_id;
  const t = issueTicket(w, { provider: 'qq', subject: String(2000 + idx), name });
  const s = exchangeTicket(w, t.ticket);
  const p = sessionPrincipal(w, s.token);
  if (!p) throw new Error('兑换出来的会话认不出主体');
  return p.principal_id;
}

export interface OpenOpts {
  dbPath: string;
  clock?: Clock;
  seed: string;
  /** 每次启动用不同的 bootTag，免得重启后随机序列重复导致编号撞车（真实环境用密码学随机，不会） */
  bootTag?: string;
  params?: Record<string, unknown>;
  log?: (m: string) => void;
  realTime?: boolean;
}

/** 起一个世界。有 clock 就用逻辑时间；realTime 用真实时钟。 */
export function openWorld(o: OpenOpts): WorldService {
  const opts: WorldOptions = {
    dbPath: o.dbPath,
    registry: createRegistry({}),
    rng: new SeededRng(`${o.seed}:world:${o.bootTag ?? '0'}`),
    seed: o.seed,
    params: o.params ?? {},
    ...(o.clock && !o.realTime ? { now: o.clock.now } : {}),
    ...(o.log ? { log: o.log } : {}),
    devLogin: false,
  };
  const w = createWorld(opts);
  w.startSync();
  return w;
}

/** 请求号序号按主体全局递增（换页面 / 重新登录后不会撞上旧回执） */
const REQ_SEQ = new Map<string, number>();

/** 一个居民的一个客户端（标签页 / 运行器）。所有动作都从 command() 进。 */
export class Conn {
  seq = 0;
  /** 最近一次读视图拿到的动作窗口（真实客户端会缓存它；过期前一直有效） */
  window = '';
  constructor(
    public w: WorldService,
    readonly person: Person,
    public clientId: string,
    readonly kindOfClient: 'web' | 'mcp',
  ) {}

  get auth(): { principalId: string; clientId: string } {
    return { principalId: this.person.principalId, clientId: this.clientId };
  }

  nextRequestId(): string {
    const n = (REQ_SEQ.get(this.person.principalId) ?? 0) + 1;
    REQ_SEQ.set(this.person.principalId, n);
    this.seq = n;
    return `rq.${String(this.person.idx).padStart(3, '0')}.${n.toString(36)}`;
  }

  /** 进入（注册或恢复）。agent 走 enterWorldAgent（MCP 路径，返回紧凑视图），真人走 enterWorld。 */
  enter(profile?: Record<string, unknown>): { residentId: string; created: boolean; wasAway: boolean; presenceEpoch: number; viewBytes: number } {
    const auth = this.auth;
    if (this.kindOfClient === 'mcp') {
      const r = enterWorldAgent(this.w, auth, profile as never);
      return { ...r.enter, viewBytes: utf8Bytes(r.view) };
    }
    const r = enterWorld(this.w, auth, { clientKind: 'web', ...(profile ? { profile: profile as never } : {}) });
    return { ...r.enter, viewBytes: utf8Bytes(r.view) };
  }

  heartbeat(epoch?: number) {
    const r = this.w.resident(this.person.residentId);
    return townHeartbeat(this.w, this.auth, epoch ?? r?.presence_epoch ?? 0);
  }

  claim() {
    return claimControl(this.w, this.auth);
  }

  leave() {
    return leaveWorld(this.w, this.person.principalId);
  }

  view() {
    const r = this.w.mustResident(this.person.residentId);
    const v = townMeView(this.w, r, this.clientId);
    this.window = v.actionWindow;
    return v;
  }

  /** 构造和真实客户端一样的请求：expected 取自（刚读过的）居民状态。 */
  build(type: string, fields: Record<string, unknown> = {}, o: { requestId?: string; window?: string; expected?: Record<string, unknown> } = {}) {
    const r = this.w.mustResident(this.person.residentId);
    return {
      requestId: o.requestId ?? this.nextRequestId(),
      actionWindow: o.window ?? this.w.issueActionWindow(this.person.residentId, this.w.now()),
      expected: (o.expected ?? { contextVersion: r.context_version, controlEpoch: r.control_epoch, activityId: r.activity_id }) as never,
      action: { type, ...fields },
    };
  }

  send(type: string, fields: Record<string, unknown> = {}, o: { requestId?: string; window?: string; expected?: Record<string, unknown> } = {}): Outcome {
    return runCommand(this.w, this.auth, this.build(type, fields, o));
  }
}

// ───────────────────────── 导航客户端（续租） ─────────────────────────

/** 客户端手里的一条导航：和真实页面 / 运行器一样，只记回执里给的那几个字段，每 renewEveryMs 续一次租约。 */
export interface NavTrack {
  conn: Conn;
  navigationId: string;
  revision: number;
  arriveAt: number;
  continues: boolean;
  leaseUntil: number;
  renewEveryMs: number;
  /** 下一次该续的时刻（逻辑时间） */
  renewAt: number;
}

interface NavBriefLike {
  navigationId: string;
  revision: number;
  arriveAt: number;
  continues: boolean;
  leaseUntil: number;
  renewEveryMs: number;
}

export function trackNav(conn: Conn, b: NavBriefLike, now: number, jitterMs = 0): NavTrack {
  return { conn, navigationId: b.navigationId, revision: b.revision, arriveAt: b.arriveAt, continues: b.continues, leaseUntil: b.leaseUntil, renewEveryMs: b.renewEveryMs, renewAt: now + Math.max(500, b.renewEveryMs - jitterMs) };
}

/**
 * 续一次租约。返回：ok 续上了；done 这一趟已经结束；lost 没有控制权 / 世界在恢复（导航已作废）。
 * 过了一段（穿过门口接着走）版本号会变：按返回的新版本再续一次，和真实客户端一样。
 */
export function renewTrack(w: WorldService, t: NavTrack, now: number, jitterMs = 0): { result: 'ok' | 'done' | 'lost'; ms: number; adopted: boolean } {
  const t0 = performance.now();
  let adopted = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: ReturnType<typeof renewNavigation>;
    try {
      out = renewNavigation(w, t.conn.auth, { navigationId: t.navigationId, revision: t.revision });
    } catch (e) {
      if (e instanceof WorldError) return { result: 'lost', ms: performance.now() - t0, adopted };
      throw e;
    }
    if (out.ok && out.navigation) {
      Object.assign(t, { revision: out.navigation.revision, arriveAt: out.navigation.arriveAt, continues: out.navigation.continues, leaseUntil: out.navigation.leaseUntil, renewAt: now + Math.max(500, t.renewEveryMs - jitterMs) });
      return { result: 'ok', ms: performance.now() - t0, adopted };
    }
    if (!out.navigation) return { result: 'done', ms: performance.now() - t0, adopted };
    // 版本换了（过了一段）或换成了别的路线：采用现在这条再续一次
    adopted = true;
    Object.assign(t, { navigationId: out.navigation.navigationId, revision: out.navigation.revision, arriveAt: out.navigation.arriveAt, continues: out.navigation.continues, leaseUntil: out.navigation.leaseUntil });
  }
  return { result: 'ok', ms: performance.now() - t0, adopted };
}

// ───────────────────────── 不变量检查 ─────────────────────────

export interface Violation {
  invariant: string;
  message: string;
  detail?: unknown;
  at: number;
  seen: number;
}

export interface InvariantContext {
  now: number;
  /** 脚本自己登记过的居民数（独立计数） */
  expectedResidents?: number;
  /** 脚本自己数的成功购买（独立计数，用来对账物品不凭空多出来） */
  purchases?: { book: number; planter_box: number; stove_kit: number };
  /** 隐私抽查的随机源；不给就不做 */
  rnd?: Rand;
  privacySamples?: number;
}

export class Invariants {
  readonly runs = new Map<string, { checks: number; fails: number }>();
  readonly violations: Violation[] = [];
  totalViolations = 0;
  checkRounds = 0;
  private readonly seenKeys = new Map<string, Violation>();
  private readonly prevLoaned = new Map<string, string>();
  private readonly reportHash = new Map<string, string>();
  private prevBooks = 0;
  /** 各轮检查里「正在走路」的居民人次（覆盖度） */
  navSamples = 0;
  readonly agentViewBytes: number[] = [];
  readonly meViewBytes: number[] = [];
  readonly publicViewBytes: number[] = [];
  readonly gameViewBytes: number[] = [];

  constructor(private readonly echo: (msg: string) => void = (m) => console.error(m)) {}

  private pass(name: string): void {
    const r = this.runs.get(name) ?? { checks: 0, fails: 0 };
    r.checks++;
    this.runs.set(name, r);
  }

  fail(name: string, message: string, detail: unknown, at: number): void {
    const r = this.runs.get(name) ?? { checks: 0, fails: 0 };
    r.fails++;
    this.runs.set(name, r);
    this.totalViolations++;
    const key = `${name}:${message}`;
    const prev = this.seenKeys.get(key);
    if (prev) {
      prev.seen++;
      return;
    }
    const v: Violation = { invariant: name, message, detail, at, seen: 1 };
    this.seenKeys.set(key, v);
    if (this.violations.length < 300) this.violations.push(v);
    this.echo(`\n!! 不变量违例 [${name}] ${message}\n   ${JSON.stringify(detail)?.slice(0, 600)}`);
  }

  /**
   * 面对面动作成功之后核对一次（不信任被测的 canInteractPerson，自己重新量）：
   * 询问、邀请、报价、接受报价成交、当面归还的那一刻，双方在同一个场景实例里、距离不超过 personReach。
   * 模拟里命令和检查用同一个时钟，成功提交后的位置就是判定时的位置。
   */
  checkFaceToFace(w: WorldService, type: string, actorId: string, fields: Record<string, unknown>, now: number): void {
    let otherId: string | undefined;
    if (type === 'offer' || type === 'invite') otherId = String(fields.to ?? '');
    else if (type === 'ask_hobby') otherId = String(fields.target ?? '');
    else if (type === 'accept_offer') otherId = w.db.get('SELECT from_id FROM offers WHERE offer_id = ?', String(fields.offerId ?? ''))?.from_id as string | undefined;
    if (type === 'return_item') {
      // 归还：只有「当面」那一条路要量距离（书屋、归还箱不要求）；方式以这次归还记下的事实为准
      const ev = w.db.get(
        `SELECT e.event_id, e.payload FROM world_events e JOIN event_parties p ON p.event_id = e.event_id AND p.resident_id = ? AND p.role = 'borrower'
          WHERE e.type = 'loan_returned' ORDER BY e.event_id DESC LIMIT 1`,
        actorId,
      );
      if (!ev || (JSON.parse(ev.payload) as { how?: string }).how !== 'in_person') return;
      otherId = w.db.get("SELECT resident_id FROM event_parties WHERE event_id = ? AND role = 'owner'", ev.event_id)?.resident_id as string | undefined;
    }
    if (!otherId) return;
    this.pass('face_to_face_in_reach');
    const a = actorOf(w, actorId);
    const b = actorOf(w, otherId);
    if (!a || !b || a.scene_id !== b.scene_id || a.instance_id !== b.instance_id) {
      this.fail('face_to_face_in_reach', `${type} 成功了，但双方不在同一个场景实例里`, { type, actorId, otherId, a: a && [a.scene_id, a.instance_id], b: b && [b.scene_id, b.instance_id] }, now);
      return;
    }
    const pa = posOf(a, now);
    const pb = posOf(b, now);
    const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    if (d > w.params.personReach + 0.02) this.fail('face_to_face_in_reach', `${type} 成功了，但双方相距 ${d.toFixed(2)} 米，超过 personReach ${w.params.personReach}`, { type, actorId, otherId, d }, now);
  }

  /** 做一轮检查。返回本轮新增的违例条数。 */
  check(w: WorldService, ctx: InvariantContext): number {
    const before = this.totalViolations;
    this.checkRounds++;
    const db = w.db;
    const now = ctx.now;
    const bad = (name: string, rows: readonly unknown[], message: string) => {
      this.pass(name);
      if (rows.length > 0) this.fail(name, message, rows.slice(0, 5), now);
    };
    const placeIds = new Set(PLACES.map((p) => p.id));

    // ── 居民 ──
    bad('single_resident', db.all('SELECT principal_id, COUNT(*) n FROM residents GROUP BY principal_id HAVING n > 1'), '一个主体对应了多个居民');
    const nRes = db.scalar('SELECT COUNT(*) FROM residents');
    if (ctx.expectedResidents !== undefined) {
      this.pass('resident_count');
      if (nRes !== ctx.expectedResidents) this.fail('resident_count', `居民数 ${nRes} 与脚本登记数 ${ctx.expectedResidents} 不一致（重复注册或丢失）`, null, now);
    }
    bad('resident_kind', db.all('SELECT r.resident_id FROM residents r JOIN principals p ON p.principal_id = r.principal_id WHERE p.kind <> r.kind'), '居民类别与主体类别不一致');
    const present = db.scalar('SELECT COUNT(*) FROM residents WHERE present_since IS NOT NULL');
    this.pass('presence_limit');
    if (present > w.params.activeResidentLimit) this.fail('presence_limit', `在场人数 ${present} 超过上限 ${w.params.activeResidentLimit}`, null, now);

    const residents = db.all('SELECT resident_id, location_id, activity_id, present_since FROM residents');
    const homeOk = (spaceId: string) => spaceId.startsWith('home:') && Boolean(db.get('SELECT 1 AS x FROM residents WHERE resident_id = ?', spaceId.slice(5)));
    const spaceOk = (spaceId: string) => placeIds.has(spaceId) || homeOk(spaceId);
    const badLoc: unknown[] = [];
    const badHome: unknown[] = [];
    for (const r of residents) {
      if (!spaceOk(r.location_id)) badLoc.push({ r: r.resident_id, loc: r.location_id });
      if (r.location_id.startsWith('home:') && r.location_id !== `home:${r.resident_id}`) {
        const g = db.get(
          `SELECT grant_id FROM home_access_grants WHERE home_id = ? AND guest_id = ? AND revoked_at IS NULL AND learned_at IS NOT NULL
             AND valid_from <= ? AND expires_at > ? AND (reentry = 1 OR entered_at IS NULL OR (entered_at IS NOT NULL AND exited_at IS NULL))`,
          r.location_id,
          r.resident_id,
          now,
          now,
        );
        if (!g) badHome.push({ r: r.resident_id, home: r.location_id, present: r.present_since !== null });
      }
    }
    bad('location_valid', badLoc, '居民区域标签不合法（空间不存在）');
    bad('home_access', badHome, '居民待在别人家里，却没有当时有效的邀请');

    // 活动 / 小游戏占座一致性
    const actBad: unknown[] = [];
    for (const r of residents) {
      if (r.activity_id) {
        const a = db.get('SELECT status FROM activities WHERE activity_id = ?', r.activity_id);
        const p = db.get('SELECT active, game_seat FROM activity_participants WHERE activity_id = ? AND resident_id = ?', r.activity_id, r.resident_id);
        if (!a || a.status !== 'running' || !p || p.active !== 1 || p.game_seat === null) actBad.push({ r: r.resident_id, activity: r.activity_id, status: a?.status, part: p });
      }
    }
    for (const p of db.all("SELECT p.activity_id, p.resident_id, a.status, a.venue_id, r.activity_id AS ract, r.location_id, r.present_since FROM activity_participants p JOIN activities a ON a.activity_id = p.activity_id JOIN residents r ON r.resident_id = p.resident_id WHERE p.active = 1")) {
      if (p.status === 'running' && p.ract !== p.activity_id) actBad.push({ part: p.resident_id, activity: p.activity_id, residentActivity: p.ract });
      if (p.status === 'forming' && (p.present_since === null || p.location_id !== p.venue_id || p.ract !== null)) actBad.push({ lobby: p.activity_id, r: p.resident_id, loc: p.location_id, present: p.present_since !== null });
      if (p.status !== 'running' && p.status !== 'forming') actBad.push({ part: p.resident_id, activity: p.activity_id, status: p.status, why: '终态的局里还有活跃座位' });
    }
    const running = db.scalar("SELECT COUNT(*) FROM activities WHERE status = 'running'");
    if (running > w.params.concurrentGames) actBad.push({ running, limit: w.params.concurrentGames });
    for (const a of db.all("SELECT a.activity_id, g.status gs FROM activities a LEFT JOIN game_records g ON g.activity_id = a.activity_id WHERE a.status = 'running'")) {
      if (a.gs !== 'running') actBad.push({ activity: a.activity_id, gameStatus: a.gs, why: '进行中的活动，游戏记录却不在 running' });
    }
    bad('activity_consistency', actBad, '小游戏占座 / 上下文不一致');

    // 小游戏按桌入局：一张桌同时只有一局（凑桌中或进行中）；开着的局都挂在自己场所的游戏桌上；
    // 进行中的局里还没回到世界的人，位置此刻（独立重算）仍在桌边——局里不能走路，所以开局时在桌边就一直在
    const tableBad: unknown[] = [];
    // 不依赖 v5 的部分唯一索引（索引在就不可能触发）：按在席参与者和未结束的对局记录各自独立统计每张桌上有几个局
    for (const t of db.all("SELECT a.table_id, COUNT(DISTINCT a.activity_id) n FROM activity_participants p JOIN activities a ON a.activity_id = p.activity_id WHERE p.active = 1 AND a.table_id IS NOT NULL AND a.status IN ('forming','ready','running','settling') GROUP BY a.table_id HAVING n > 1")) tableBad.push({ table: t.table_id, open: t.n, why: '一张桌上有多个局都有在席的人' });
    for (const t of db.all("SELECT a.table_id, COUNT(DISTINCT g.game_id) n FROM game_records g JOIN activities a ON a.activity_id = g.activity_id WHERE g.status = 'running' AND a.table_id IS NOT NULL GROUP BY a.table_id HAVING n > 1")) tableBad.push({ table: t.table_id, running: t.n, why: '一张桌上有多局在进行的对局记录' });
    const townScene = w.map.scenes.get(w.map.spawn.scene)!;
    for (const a of db.all("SELECT activity_id, venue_id, table_id, status FROM activities WHERE status IN ('forming','ready','running','settling')")) {
      const it = a.table_id ? townScene.interactables.get(String(a.table_id)) : undefined;
      if (!it || it.kind !== 'game_table' || !String(a.table_id).startsWith(`${a.venue_id}:`)) {
        tableBad.push({ activity: a.activity_id, venue: a.venue_id, table: a.table_id, why: '开着的局没有挂在本场所的游戏桌上' });
        continue;
      }
      if (a.status !== 'running') continue;
      for (const p of db.all('SELECT resident_id FROM activity_participants WHERE activity_id = ? AND active = 1', a.activity_id)) {
        const pos = positionOfResident(w, String(p.resident_id), now);
        const d = pos ? Math.hypot(pos.x - it.x, pos.z - it.z) : Infinity;
        if (!pos || pos.scene !== townScene.id || d > (it.reach ?? w.map.interactDistance) + 0.011) tableBad.push({ activity: a.activity_id, r: p.resident_id, table: a.table_id, dist: d, why: '进行中的局里的人不在桌边' });
      }
    }
    bad('table_exclusive', tableBad, '游戏桌被重复占用 / 局没有挂在游戏桌上 / 局里的人不在桌边');

    // 离线居民不在任何现场名单、不占开放中的席位
    const offBad: unknown[] = [];
    for (const r of db.all('SELECT resident_id FROM residents WHERE present_since IS NULL')) {
      const id = r.resident_id;
      if (db.get("SELECT 1 AS x FROM interaction_participants p JOIN interactions i ON i.interaction_id = p.interaction_id WHERE p.resident_id = ? AND p.active = 1 AND i.status = 'open'", id)) offBad.push({ r: id, why: '离线却占着开放中的共同活动席位' });
      if (db.get("SELECT 1 AS x FROM activity_participants p JOIN activities a ON a.activity_id = p.activity_id WHERE p.resident_id = ? AND p.active = 1 AND a.status = 'forming'", id)) offBad.push({ r: id, why: '离线却占着凑桌席位' });
      if (db.get("SELECT 1 AS x FROM offers WHERE status = 'open' AND (from_id = ? OR to_id = ?)", id, id)) offBad.push({ r: id, why: '离线却有开着的报价' });
    }
    for (const r of db.all('SELECT resident_id FROM residents WHERE present_since IS NOT NULL')) {
      const lease = db.scalar('SELECT COALESCE(MAX(expires_at), 0) FROM presence_leases WHERE resident_id = ?', r.resident_id);
      if (lease <= now) offBad.push({ r: r.resident_id, why: '在场，但所有在场租约都已过期', lease, now });
    }
    bad('offline_roster', offBad, '离线 / 租约失效的居民仍在现场名单或占着席位');

    // ── 硬币 ──
    bad('ledger_balanced', db.all('SELECT transaction_id, SUM(delta) s FROM ledger_entries GROUP BY transaction_id HAVING s <> 0'), '有不平衡的账本交易');
    bad('ledger_orphan', db.all('SELECT t.transaction_id FROM ledger_transactions t WHERE NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.transaction_id = t.transaction_id)'), '有没有分录的账本交易');
    bad(
      'balance_equals_entries',
      db.all('SELECT a.account_id, a.balance, COALESCE(SUM(e.delta), 0) s FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.account_id GROUP BY a.account_id HAVING a.balance <> s'),
      '账户余额 ≠ 分录之和',
    );
    const mintBal = db.scalar("SELECT balance FROM accounts WHERE account_id = 'sys:mint'");
    const sinkBal = db.scalar("SELECT balance FROM accounts WHERE account_id = 'sys:sink'");
    const holders = db.scalar("SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE kind = 'resident'");
    this.pass('coin_supply');
    if (holders !== -mintBal - sinkBal) this.fail('coin_supply', `全镇硬币 ${holders} ≠ 铸造 ${-mintBal} − 销毁 ${sinkBal}`, { holders, mint: -mintBal, sink: sinkBal }, now);
    this.pass('coin_supply_entries');
    const mintedSum = db.scalar("SELECT COALESCE(SUM(-delta), 0) FROM ledger_entries WHERE account_id = 'sys:mint'");
    const sunkSum = db.scalar("SELECT COALESCE(SUM(delta), 0) FROM ledger_entries WHERE account_id = 'sys:sink'");
    if (holders !== mintedSum - sunkSum) this.fail('coin_supply_entries', `全镇硬币 ${holders} ≠ 分录统计的铸造 ${mintedSum} − 销毁 ${sunkSum}`, null, now);
    bad('no_negative_coin', db.all("SELECT account_id, balance FROM accounts WHERE kind = 'resident' AND balance < 0"), '居民硬币为负');
    bad('reserved_le_balance', db.all("SELECT account_id, balance, reserved FROM accounts WHERE kind = 'resident' AND reserved > balance"), '预留硬币超过持有');
    this.pass('starter_once');
    const starters = db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'starter'");
    if (starters !== nRes) this.fail('starter_once', `开户礼发放 ${starters} 次，居民 ${nRes} 位`, null, now);

    // ── 预留 ──
    bad(
      'reserve_coins_match',
      db.all("SELECT a.resident_id, a.reserved, COALESCE((SELECT SUM(coins) FROM resource_reservations rr WHERE rr.resident_id = a.resident_id), 0) s FROM accounts a WHERE a.kind = 'resident' AND a.reserved <> s"),
      '账户预留 ≠ 预留表合计',
    );
    bad(
      'reserve_items_match',
      db.all('SELECT i.item_id, i.reserved, COALESCE((SELECT SUM(quantity) FROM resource_reservations rr WHERE rr.item_id = i.item_id), 0) s FROM items i WHERE i.reserved <> s'),
      '物品预留数 ≠ 预留表合计',
    );
    bad(
      'reserve_leak',
      db.all(
        `SELECT rr.reservation_id, rr.holder_kind, rr.holder_ref FROM resource_reservations rr WHERE
          (rr.holder_kind = 'offer' AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.offer_id = rr.holder_ref AND o.status = 'open'))
          OR (rr.holder_kind = 'interaction' AND NOT EXISTS (SELECT 1 FROM interactions x WHERE x.interaction_id = rr.holder_ref AND x.status = 'open'))
          OR (rr.holder_kind NOT IN ('offer','interaction'))`,
      ),
      '预留没有对应的开放中的报价 / 活动（泄漏）',
    );
    bad(
      'reserve_unique_item',
      db.all('SELECT rr.item_id, COUNT(DISTINCT rr.holder_ref) n FROM resource_reservations rr JOIN items i ON i.item_id = rr.item_id WHERE i.stack = 0 GROUP BY rr.item_id HAVING n > 1'),
      '同一件独立物品被多份预留占用',
    );

    // ── 物品 ──
    bad('items_sane', db.all('SELECT item_id, type, quantity, stack, reserved, shelved FROM items WHERE quantity < 0 OR (stack = 0 AND quantity <> 1) OR (stack = 1 AND quantity < 1) OR shelved < 0 OR reserved + shelved > quantity'), '物品数量非法（负数 / 唯一物品数量≠1 / 预留+摆放超过持有）');
    bad(
      'loan_matches_items',
      db.all(
        `SELECT i.item_id, i.owner_id, i.holder_id FROM items i WHERE i.holder_id <> i.owner_id AND NOT EXISTS
           (SELECT 1 FROM loans l WHERE l.item_id = i.item_id AND l.status = 'active' AND l.borrower_id = i.holder_id AND l.owner_id = i.owner_id)`,
      ),
      '持有者≠所有者的物品没有对应的在借记录',
    );
    bad(
      'loan_has_item',
      db.all("SELECT l.loan_id, l.item_id FROM loans l JOIN items i ON i.item_id = l.item_id WHERE l.status = 'active' AND (i.holder_id <> l.borrower_id OR i.owner_id <> l.owner_id)"),
      '在借记录与物品的持有者 / 所有者不符',
    );
    bad('loan_returned_home', db.all("SELECT l.loan_id, i.holder_id, i.owner_id FROM loans l JOIN items i ON i.item_id = l.item_id WHERE l.status = 'returned' AND i.holder_id <> i.owner_id AND NOT EXISTS (SELECT 1 FROM loans l2 WHERE l2.item_id = l.item_id AND l2.status = 'active')"), '已归还的物品没有回到所有者手里');
    const loanedNow = new Map<string, string>();
    for (const l of db.all("SELECT item_id, owner_id FROM loans WHERE status = 'active'")) loanedNow.set(l.item_id, l.owner_id);
    this.pass('loan_owner_stable');
    for (const [item, owner] of this.prevLoaned) {
      const it = db.get('SELECT owner_id FROM items WHERE item_id = ?', item);
      if (it && it.owner_id !== owner) this.fail('loan_owner_stable', `借出物 ${item} 的所有者从 ${owner} 变成了 ${it.owner_id}`, { item, was: owner, now: it.owner_id }, now);
    }
    this.prevLoaned.clear();
    for (const [k, v] of loanedNow) this.prevLoaned.set(k, v);
    // 镇上藏书总册数不变（书屋每种两本）
    this.pass('library_count');
    const lib = db.all("SELECT metadata_json FROM items WHERE owner_id = 'town'");
    if (lib.length !== BOOKS.length * 2) this.fail('library_count', `镇上藏书 ${lib.length} 册，应为 ${BOOKS.length * 2}`, null, now);
    const perBook = new Map<string, number>();
    for (const it of lib) {
      const id = (JSON.parse(it.metadata_json) as { bookId?: string }).bookId ?? '?';
      perBook.set(id, (perBook.get(id) ?? 0) + 1);
    }
    for (const b of BOOKS) if ((perBook.get(b.id) ?? 0) !== 2) this.fail('library_count', `《${b.title}》藏书 ${perBook.get(b.id) ?? 0} 册，应为 2`, null, now);
    // 物品来源对账：书和家具只来自 开户物资 / 书屋 / 购买，不会凭空多出来或消失
    if (ctx.purchases) {
      this.pass('item_conservation');
      const books = db.scalar("SELECT COUNT(*) FROM items WHERE type = 'book'");
      const expectBooks = BOOKS.length * 2 + nRes + ctx.purchases.book;
      if (books !== expectBooks) this.fail('item_conservation', `书共 ${books} 本，按来源应为 ${expectBooks}（藏书 ${BOOKS.length * 2} + 开户 ${nRes} + 购买 ${ctx.purchases.book}）`, null, now);
      if (books < this.prevBooks) this.fail('item_conservation', `书的总数减少了：${this.prevBooks} → ${books}`, null, now);
      this.prevBooks = books;
      const planter = db.scalar("SELECT COUNT(*) FROM items WHERE type = 'planter_box'") + db.scalar("SELECT COUNT(*) FROM placed_objects WHERE type = 'planter' AND owner_id IS NOT NULL");
      const stove = db.scalar("SELECT COUNT(*) FROM items WHERE type = 'stove_kit'") + db.scalar("SELECT COUNT(*) FROM placed_objects WHERE type = 'stove' AND owner_id IS NOT NULL");
      if (planter !== ctx.purchases.planter_box) this.fail('item_conservation', `花箱 ${planter} 件，按购买应为 ${ctx.purchases.planter_box}`, null, now);
      if (stove !== ctx.purchases.stove_kit) this.fail('item_conservation', `小灶台 ${stove} 件，按购买应为 ${ctx.purchases.stove_kit}`, null, now);
    }

    // ── 卡死检查 ──
    bad('stuck_jobs', db.all("SELECT job_id, kind, dedupe_key, due_at, attempts, last_error FROM scheduled_jobs WHERE status = 'pending' AND due_at <= ? LIMIT 5", now), '到期的定时任务没有被处理');
    bad('failed_jobs', db.all("SELECT job_id, kind, dedupe_key, attempts, last_error FROM scheduled_jobs WHERE status = 'failed' LIMIT 5"), '定时任务重试耗尽被搁置');
    bad('stuck_offers', db.all("SELECT offer_id, expires_at FROM offers WHERE status = 'open' AND expires_at <= ?", now), '超过时限仍是 open 的报价');
    bad('stuck_interactions', db.all("SELECT interaction_id, status, lobby_expires_at, ends_at FROM interactions WHERE (status = 'open' AND lobby_expires_at <= ?) OR (status = 'running' AND ends_at <= ?)", now, now), '超过时限仍未结束的共同活动');
    bad('stuck_activities', db.all("SELECT activity_id, status, lobby_expires_at, deadline FROM activities WHERE (status = 'forming' AND lobby_expires_at <= ?) OR (status = 'running' AND deadline <= ?)", now, now), '超过时限仍在凑桌 / 进行的小游戏');
    const stuckGames: unknown[] = [];
    for (const g of db.all("SELECT activity_id, record_json FROM game_records WHERE status = 'running'")) {
      const rec = JSON.parse(g.record_json) as { phase?: { deadline: number | null; openedAt: number | null } };
      const d = rec.phase?.deadline;
      if (d !== null && d !== undefined && d <= now) stuckGames.push({ activity: g.activity_id, deadline: d, now });
    }
    bad('stuck_games', stuckGames, '小游戏阶段超过截止时间仍未结算');
    bad('stuck_letters', db.all('SELECT letter_id, deliver_at FROM letters WHERE delivered_at IS NULL AND deliver_at <= ? LIMIT 5', now), '到点没送到的信');
    bad('stuck_events', db.all("SELECT instance_id, status, opens_at, closes_at FROM public_event_instances WHERE (status = 'scheduled' AND opens_at <= ?) OR (status = 'open' AND closes_at <= ?)", now, now), '公共事件没有按时开始 / 结束');

    // ── 结算只发生一次 ──
    bad(
      'settlement_present',
      db.all(
        `SELECT a.activity_id, a.status FROM activities a LEFT JOIN settlements s ON s.activity_id = a.activity_id
         WHERE (a.game_id IS NOT NULL AND a.status IN ('completed','aborted') AND s.activity_id IS NULL)
            OR (a.status IN ('forming','running') AND s.activity_id IS NOT NULL)
            OR (s.activity_id IS NOT NULL AND s.outcome <> a.status)`,
      ),
      '小游戏终态与结算记录不一致（漏结算 / 提前结算 / 结果不符）',
    );
    const rewardsByAct = new Map<string, number>();
    const rewardsPerDay = new Map<string, number>();
    const actInfo = new Map<string, { status: string; type: string }>();
    for (const a of db.all('SELECT activity_id, status, game_type FROM activities')) actInfo.set(a.activity_id, { status: a.status, type: a.game_type });
    this.pass('game_reward_once');
    for (const t of db.all("SELECT cause_key, created_at FROM ledger_transactions WHERE kind = 'game_reward'")) {
      const m = /^game:([^:]+):(.+)$/.exec(t.cause_key);
      if (!m) continue;
      const a = actInfo.get(m[1]!);
      rewardsByAct.set(m[1]!, (rewardsByAct.get(m[1]!) ?? 0) + 1);
      if (!a || a.status !== 'completed') this.fail('game_reward_once', `中止 / 不存在的局 ${m[1]} 发过奖励`, { cause: t.cause_key, status: a?.status }, now);
      else {
        const k = `${m[2]}|${a.type}|${w.today(Number(t.created_at))}`;
        rewardsPerDay.set(k, (rewardsPerDay.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of rewardsPerDay) if (n > w.params.gameRewardsPerDay) this.fail('game_reward_once', `同一居民同一游戏同一天的奖励局数 ${n} 超过 ${w.params.gameRewardsPerDay}`, { k }, now);
    this.pass('game_fact_once');
    const completedSettled = db.scalar("SELECT COUNT(*) FROM settlements WHERE outcome = 'completed'");
    const gameFacts = db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'game_completed'");
    if (gameFacts !== completedSettled) this.fail('game_fact_once', `game_completed 事实 ${gameFacts} 条，完成结算 ${completedSettled} 局`, null, now);
    // 日报至多一份且不再变化；换日公开事件每个世界日至多一条
    this.pass('report_once');
    for (const r of db.all('SELECT scope, business_date, body_json FROM daily_reports')) {
      const k = `${r.scope}|${r.business_date}`;
      const h = sha(r.body_json);
      const old = this.reportHash.get(k);
      if (old && old !== h) this.fail('report_once', `日报 ${k} 生成后又被改写`, null, now);
      this.reportHash.set(k, h);
    }
    const repEvents = new Map<string, number>();
    for (const e of db.all("SELECT projection FROM public_events WHERE type = 'report'")) {
      const d = (JSON.parse(e.projection) as { date?: string }).date ?? '?';
      repEvents.set(d, (repEvents.get(d) ?? 0) + 1);
    }
    for (const [d, n] of repEvents) if (n > 1) this.fail('report_once', `公开日报事件 ${d} 发出 ${n} 次`, null, now);
    // 愿望完成只结算一次
    bad(
      'goal_once',
      db.all(
        `SELECT g.goal_id, g.status, (SELECT COUNT(*) FROM ledger_transactions t WHERE t.cause_key = 'goal:' || g.goal_id) n FROM resident_goals g
         WHERE (g.status = 'completed' AND n <> 1) OR (g.status <> 'completed' AND n <> 0)`,
      ),
      '愿望奖励结算次数 ≠ 1（完成的愿望）或 ≠ 0（未完成的愿望）',
    );
    bad('goal_active_cap', db.all("SELECT resident_id, kind, COUNT(*) n FROM resident_goals WHERE status = 'active' GROUP BY resident_id, kind HAVING (kind = 'long' AND n > ?) OR (kind = 'short' AND n > ?)", w.params.longGoals, w.params.shortGoals), '同时进行的愿望超过规定数量');

    // ── 数值范围 ──
    const needsBad: unknown[] = [];
    for (const r of db.all('SELECT resident_id, state_json FROM residents')) {
      const n = (JSON.parse(r.state_json) as { needs: { energy: number; social: number; interest: number } }).needs;
      for (const k of ['energy', 'social', 'interest'] as const) if (!Number.isFinite(n[k]) || n[k] < 0 || n[k] > 100) needsBad.push({ r: r.resident_id, [k]: n[k] });
    }
    bad('needs_range', needsBad, '需要值不在 0~100');
    bad('relation_range', db.all('SELECT resident_id, other_id, familiarity, closeness FROM relationships WHERE familiarity < 0 OR familiarity > 100 OR closeness < 0 OR closeness > 100 OR resident_id = other_id'), '关系值越界（或自己和自己有关系）');
    bad(
      'relation_symmetric',
      db.all(
        `SELECT a.resident_id, a.other_id FROM relationships a LEFT JOIN relationships b ON b.resident_id = a.other_id AND b.other_id = a.resident_id
         WHERE b.resident_id IS NULL OR a.familiarity <> b.familiarity LIMIT 5`,
      ),
      '关系两边的熟悉度不对称（亲近度按设计可以单向：送礼只加送的人，见 social.ts closenessFor）',
    );
    bad('memory_bound', db.all('SELECT owner_id, other_id, COUNT(*) n FROM memory_refs WHERE other_id IS NOT NULL GROUP BY owner_id, other_id HAVING n > ?', w.params.activeMemoryItems * 3), '共同经历条数超过上限');
    bad('mailbox_cap', db.all('SELECT recipient_id, COUNT(*) n FROM letters WHERE recipient_deleted_at IS NULL GROUP BY recipient_id HAVING n > ?', w.params.mailboxCapacity), '信箱超过容量');
    bad('stock_nonneg', db.all('SELECT shop_id, sku, stock FROM shop_stock WHERE stock < 0'), '库存为负');

    // ── 空间（连续位置、区域标签、导航任务） ──
    this.space(w, now);

    // ── 隐私抽查 + 视图大小 ──
    if (ctx.rnd && (ctx.privacySamples ?? 0) > 0) this.privacy(w, ctx.rnd, ctx.privacySamples!, now);
    return this.totalViolations - before;
  }

  /** 空间这一层：位置、区域标签、导航任务、租约截止。只读。 */
  space(w: WorldService, now: number, scanEvents = true): void {
    const db = w.db;
    const fail = (name: string, message: string, detail: unknown) => this.fail(name, message, detail, now);
    const actors = db.all('SELECT * FROM world_actors WHERE world_id = ?', w.worldId);
    const byResident = new Map<string, Row[]>();
    for (const a of actors) {
      const k = String(a.resident_id ?? a.actor_id);
      byResident.set(k, [...(byResident.get(k) ?? []), a]);
    }
    const pendingNav = new Map<string, number>();
    for (const j of db.all("SELECT dedupe_key FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")) pendingNav.set(String(j.dedupe_key), (pendingNav.get(String(j.dedupe_key)) ?? 0) + 1);
    let navigating = 0;
    // 每位居民恰好一条角色行
    for (const r of db.all('SELECT resident_id, location_id, present_since FROM residents')) {
      const rid = String(r.resident_id);
      this.pass('actor_one_row');
      const rows = byResident.get(rid) ?? [];
      if (rows.length !== 1) fail('actor_one_row', `居民 ${rid} 有 ${rows.length} 条 world_actors`, { rid, rows: rows.length });
      const row = rows[0];
      if (!row) continue;
      const scene = w.map.scenes.get(String(row.scene_id));
      this.pass('actor_walkable');
      if (!scene) {
        fail('actor_walkable', `居民 ${rid} 所在场景 ${row.scene_id} 不存在`, { rid });
        continue;
      }
      if (!isWalkable(scene, Number(row.x), Number(row.z))) fail('actor_walkable', `居民 ${rid} 的锚点 (${row.x}, ${row.z}) 不在 ${row.scene_id} 的可走格子上`, { rid, x: row.x, z: row.z, scene: row.scene_id });
      const a = actorOf(w, rid)!;
      const p = posOf(a, now);
      this.pass('actor_walkable');
      if (!isWalkable(scene, p.x, p.z)) fail('actor_walkable', `居民 ${rid} 此刻的位置 (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) 不在 ${row.scene_id} 的可走格子上`, { rid, x: p.x, z: p.z, scene: row.scene_id, moving: p.moving });
      // 区域标签与脚下的区域一致
      const label = String(r.location_id);
      if (scene.instanced) {
        this.pass('zone_label_home');
        if (label !== `home:${row.instance_id}` || !db.get('SELECT 1 AS x FROM residents WHERE resident_id = ?', row.instance_id)) {
          fail('zone_label_home', `居民 ${rid} 在私宅实例 ${row.instance_id} 里，标签却是 ${label}（或房主不存在）`, { rid, label, instance: row.instance_id });
        }
      } else {
        this.pass('zone_label_public');
        const zone = zoneAt(scene, p.x, p.z).id;
        // 毫秒取整：正好踩在分界线上的前后 1 毫秒内，标签算对
        const near = new Set([zone, zoneAt(scene, posOf(a, now - 1).x, posOf(a, now - 1).z).id, zoneAt(scene, posOf(a, now + 1).x, posOf(a, now + 1).z).id]);
        if (!near.has(label) || row.instance_id !== '') fail('zone_label_public', `居民 ${rid} 脚下是 ${zone}，标签却是 ${label}`, { rid, label, zone, x: p.x, z: p.z, nav: Boolean(a.nav) });
      }
      // 导航任务：有 nav_json 的人恰好一条 pending nav_step，没有的没有；离线的没有导航
      const key = `nav:${rid}`;
      const jobs = pendingNav.get(key) ?? 0;
      this.pass('nav_job_match');
      if (a.nav ? jobs !== 1 : jobs !== 0) fail('nav_job_match', `居民 ${rid} ${a.nav ? '在走路' : '没在走路'}，却有 ${jobs} 条待办 nav_step`, { rid, jobs });
      pendingNav.delete(key);
      this.pass('nav_offline_clean');
      if (a.nav && r.present_since === null) fail('nav_offline_clean', `离线的居民 ${rid} 还有导航`, { rid });
      if (!a.nav) continue;
      navigating++;
      this.checkNav(w, rid, a.nav, now, fail);
    }
    this.pass('nav_job_orphan');
    if (pendingNav.size > 0) fail('nav_job_orphan', `有 ${pendingNav.size} 条待办 nav_step 对不上任何居民`, [...pendingNav.keys()].slice(0, 5));
    this.navSamples += navigating;
    // 旧模型的残留
    this.pass('no_legacy_move');
    const legacy = db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'move_arrive' AND status = 'pending'");
    if (legacy > 0) fail('no_legacy_move', `还有 ${legacy} 条待办 move_arrive`, null);
    const legacyJson = db.scalar('SELECT COUNT(*) FROM residents WHERE move_json IS NOT NULL');
    if (legacyJson > 0) fail('no_legacy_move', `${legacyJson} 位居民的 move_json 不是 NULL`, null);
    // 事件流里没有坐标 / 路线（所有人的私有事件也不带）
    if (!scanEvents) return;
    this.pass('events_no_coords');
    const coordRe = /"x":|"z":|"points"|polyline|navigationId/;
    for (const e of db.all("SELECT resident_id, type, projection FROM recipient_events WHERE type IN ('nav_stopped','you_arrived','left','arrived','notice') ORDER BY cursor DESC LIMIT 1500")) {
      if (coordRe.test(String(e.projection))) fail('events_no_coords', `居民 ${e.resident_id} 的 ${e.type} 事件里有坐标 / 路线`, String(e.projection).slice(0, 200));
    }
  }

  /** 一条导航的租约截止：位置不会越过截止时刻对应的点，也不会因为时间往后拨而前进。 */
  private checkNav(w: WorldService, rid: string, nav: NavState, now: number, fail: (name: string, message: string, detail: unknown) => void): void {
    const motion = { points: nav.points, speed: nav.speed, startedAt: nav.startedAt };
    const cap = positionAt({ ...motion, until: nav.leaseUntil }, nav.leaseUntil);
    this.pass('nav_lease_cap');
    for (const dt of [1, 1000, 60_000, 3_600_000]) {
      const later = positionOfResident(w, rid, Math.max(now, nav.leaseUntil) + dt);
      if (!later || Math.hypot(later.x - cap.x, later.z - cap.z) > 1e-6) fail('nav_lease_cap', `居民 ${rid} 把时钟拨到租约截止之后 ${dt} 毫秒，位置还在前进`, { rid, cap, later });
    }
    // 现在到租约截止之间最多走 速度 × 剩余时间
    const here = positionOfResident(w, rid, now);
    const ahead = positionOfResident(w, rid, now + 120_000);
    this.pass('nav_lease_cap');
    if (here && ahead) {
      const room = (Math.max(0, nav.leaseUntil - now) / 1000) * nav.speed + 1e-6;
      if (distance(here, ahead) > room) fail('nav_lease_cap', `居民 ${rid} 往后拨两分钟，位移 ${distance(here, ahead).toFixed(2)} 米，超过租约剩余时间能走的 ${room.toFixed(2)} 米`, { rid, leaseUntil: nav.leaseUntil, now });
    }
    // 到点没处理的导航（结算任务没跑）
    this.pass('nav_not_stuck');
    const arrive = arrivalAt(motion);
    if (nav.leaseUntil <= now || arrive <= now) fail('nav_not_stuck', `居民 ${rid} 的导航已过${nav.leaseUntil <= now ? '租约截止' : '到达时刻'}，却还没结算`, { rid, leaseUntil: nav.leaseUntil, arrive, now });
  }

  /** 把别人的秘密和 A 能看到的所有出口的 JSON 做不包含检查。 */
  private privacy(w: WorldService, rnd: Rand, samples: number, now: number): void {
    const db = w.db;
    const all = db.all('SELECT resident_id, present_since, kind FROM residents ORDER BY resident_id');
    if (all.length < 2) return;
    const pubView = JSON.stringify(townPublicView(w));
    this.publicViewBytes.push(utf8Bytes(pubView));
    const pubEvents = db.all('SELECT projection FROM public_events ORDER BY cursor DESC LIMIT 3000').map((e) => e.projection as string).join('\n');
    // 公开出口不能出现住宅 / 巷子的具体信息
    this.pass('public_no_home');
    for (const [label, text] of [['公开地图', pubView], ['公开事件流', pubEvents]] as const) {
      const m = /home:|street_east|street_west|东灯巷|西灯巷/.exec(text);
      if (m) this.fail('public_no_home', `${label}里出现了住宅 / 巷子信息：${m[0]}`, null, now);
    }
    this.pass('public_no_coords');
    for (const [label, text] of [['公开地图', pubView], ['公开事件流', pubEvents]] as const) {
      const m = /"x":|"z":|"points"|polyline|navigationId|"nav":|leaseUntil/.exec(text);
      if (m) this.fail('public_no_coords', `${label}里出现了坐标 / 折线：${m[0]}`, text.slice(Math.max(0, m.index - 60), m.index + 80), now);
    }
    for (let s = 0; s < samples; s++) {
      const a = rnd.pick(all);
      const aId = a.resident_id as string;
      const ar = w.mustResident(aId);
      const clientId = ar.controller_client ?? `probe:${aId}`;
      const me = townMeView(w, ar, clientId);
      const meJson = JSON.stringify(me);
      const agentJson = JSON.stringify(townAgentView(w, ar, clientId));
      this.meViewBytes.push(utf8Bytes(meJson));
      this.agentViewBytes.push(utf8Bytes(agentJson));
      if (me.game) this.gameViewBytes.push(utf8Bytes(me.game));
      // 场景视图：只含同一场景实例里在场的人；公共场景的视图里没有任何私宅的信息
      if (ar.present_since !== null) {
        this.pass('scene_view_isolation');
        const mine = actorOf(w, aId);
        if (mine) {
          const sv = sceneView(w, ar, now);
          const want = db
            .all(
              'SELECT a.actor_id FROM world_actors a JOIN residents r ON r.resident_id = a.resident_id WHERE a.world_id = ? AND a.scene_id = ? AND a.instance_id = ? AND (r.present_since IS NOT NULL OR a.actor_id = ?) ORDER BY a.actor_id',
              w.worldId,
              mine.scene_id,
              mine.instance_id,
              aId,
            )
            .map((x) => x.actor_id as string);
          const got = sv.actors.map((x) => x.id).sort();
          if (JSON.stringify(want) !== JSON.stringify(got)) this.fail('scene_view_isolation', '场景视图里的人与同一场景实例里在场的人不一致', { viewer: aId, want, got }, now);
          if (mine.instance_id === '' && JSON.stringify(sv).includes('home:')) this.fail('scene_view_isolation', `公共场景的场景视图里出现了私宅信息（观看者 ${aId}）`, null, now);
          if (mine.instance_id !== '' && sv.actors.some((x) => x.id !== aId && actorOf(w, x.id)?.instance_id !== mine.instance_id)) this.fail('scene_view_isolation', '私宅场景视图里出现了别的实例的人', { viewer: aId }, now);
        }
      }
      const ownRows = db.all('SELECT projection FROM recipient_events WHERE resident_id = ? ORDER BY cursor DESC LIMIT 400', aId).map((e) => e.projection as string);
      // 报价事件只发给当事人，其中的物品编号是正当知情的
      const ownEvents = ownRows.filter((p) => !p.startsWith('{"offer":')).join('\n');
      const surfaces: [string, string][] = [['我的视图', meJson], ['AI 紧凑视图', agentJson], ['公开地图', pubView], ['公开事件流', pubEvents], ['我的私有事件流', ownEvents]];

      // 1) 别人没读过的信：正文暗号不能出现（寄信人自己知道，除外）
      for (const l of db.all('SELECT body, sender_id FROM letters WHERE recipient_id <> ? AND sender_id <> ? AND read_at IS NULL ORDER BY letter_id LIMIT 80', aId, aId)) {
        const token = /暗号(L\d+X)/.exec(l.body as string)?.[1];
        if (!token) continue;
        this.pass('privacy_letters');
        for (const [label, text] of surfaces) if (text.includes(token)) this.fail('privacy_letters', `别人未读的信的暗号 ${token} 出现在 ${label} 里`, { viewer: aId }, now);
      }
      // 2) 别人的背包 / 屋内物件：物品编号、物件编号不能出现（自己持有的、报价里相关的除外）
      const other = rnd.pick(all.filter((x) => x.resident_id !== aId));
      const oId = other.resident_id as string;
      const mine = new Set(db.all('SELECT item_id FROM items WHERE holder_id = ? OR owner_id = ?', aId, aId).map((x) => x.item_id as string));
      for (const it of db.all("SELECT item_id FROM items WHERE holder_id = ? AND owner_id = ? AND reserved = 0 LIMIT 40", oId, oId)) {
        if (mine.has(it.item_id)) continue;
        this.pass('privacy_inventory');
        for (const [label, text] of surfaces) if (text.includes(it.item_id as string)) this.fail('privacy_inventory', `${oId} 的物品编号 ${it.item_id} 出现在 ${aId} 的 ${label} 里`, label === '我的私有事件流' ? db.all('SELECT cursor, projection FROM recipient_events WHERE resident_id = ? AND projection LIKE ? LIMIT 2', aId, `%${it.item_id}%`) : null, now);
      }
      // 曾经被邀请进过那间屋子的人，事件流里留有当时的物件编号（正当）
      const visited = db.scalar('SELECT COUNT(*) FROM home_access_grants WHERE home_id = ? AND guest_id = ? AND entered_at IS NOT NULL', `home:${oId}`, aId) > 0;
      const inHome = ar.location_id === `home:${oId}`;
      if (!inHome) {
        for (const o of db.all('SELECT object_id FROM placed_objects WHERE space_id = ?', `home:${oId}`)) {
          this.pass('privacy_home');
          for (const [label, text] of surfaces) if (!(visited && label === '我的私有事件流') && text.includes(o.object_id as string)) this.fail('privacy_home', `${oId} 家里的物件编号 ${o.object_id} 出现在 ${aId} 的 ${label} 里（A 不在那间屋里）`, null, now);
        }
        // 3) 屋内发言：不在受众里的人看不到
      }
      // 4) 现场名单：我视图里的「身边的人」必须正是此刻同空间、在场、不在小游戏里的人（走在路上的人属于脚下的区域，照样在名单里）
      if (me.here && ar.present_since !== null) {
        this.pass('roster_matches');
        const want = db
          .all("SELECT resident_id FROM residents WHERE location_id = ? AND present_since IS NOT NULL AND activity_id IS NULL AND resident_id <> ? ORDER BY resident_id", ar.location_id, aId)
          .map((x) => x.resident_id as string);
        const got = me.here.residents.map((x) => x.id).sort();
        if (JSON.stringify(want) !== JSON.stringify(got)) this.fail('roster_matches', '视图里的现场名单与数据库里同一空间的在场居民不一致', { viewer: aId, want, got }, now);
        if (me.here.kind === 'home' && ar.location_id !== `home:${aId}`) {
          // 在别人家：公开地图上看不出来（已由 public_no_home 覆盖）
        }
      }
      // 5) 聊天：随机取近期几条发言，不在受众里的居民（视图 / 私有事件流 / AI 视图）不能出现发言编号
      const msgs = db.all('SELECT message_id, body, space_id FROM chat_messages ORDER BY message_id DESC LIMIT 60');
      if (msgs.length > 0) {
        const m = rnd.pick(msgs);
        const token = /编号(C\d+X)/.exec(m.body as string)?.[1];
        if (token) {
          const inAud = db.get('SELECT 1 AS x FROM chat_audience WHERE message_id = ? AND resident_id = ?', m.message_id, aId);
          const sender = db.get('SELECT sender_id FROM chat_messages WHERE message_id = ?', m.message_id)!.sender_id;
          if (!inAud && sender !== aId) {
            this.pass('privacy_chat');
            for (const [label, text] of surfaces) if (text.includes(token)) this.fail('privacy_chat', `现场发言 ${token}（空间 ${m.space_id}）出现在不在受众里的居民 ${aId} 的 ${label} 里`, null, now);
          }
        }
      }
    }
  }

  summary(): { name: string; checks: number; fails: number }[] {
    return [...this.runs].map(([name, r]) => ({ name, ...r })).sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** 一份数据库的逻辑体积（页数 × 页大小）和表行数，内存库也能量。 */
export function dbFootprint(w: WorldService): { bytes: number; free: number; tables: Record<string, number> } {
  const pages = w.db.scalar('PRAGMA page_count');
  const size = w.db.scalar('PRAGMA page_size');
  const freelist = w.db.scalar('PRAGMA freelist_count');
  const tables: Record<string, number> = {};
  for (const t of w.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    tables[t.name as string] = w.db.scalar(`SELECT COUNT(*) FROM "${t.name}"`);
  }
  return { bytes: pages * size, free: freelist * size, tables };
}
