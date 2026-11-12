/**
 * 栖灯镇：长时间逻辑模拟（world:simulate）
 *
 * 用可控时钟把逻辑时间往前推（不真等），固定种子的随机数决定每个居民的作息和行为。
 * 所有动作都走 WorldService.command（和真实的网页 / MCP 客户端同一条管线），
 * 带正确的 requestId / actionWindow / expected；并按一定概率故意重放、发过期上下文、发非法动作，确认被正确拒绝。
 * 期间每隔一段逻辑时间检查一轮不变量（硬币守恒、物品、卡死、结算只一次、隐私……），违例立即打印并以非零码退出。
 *
 *   npx tsx scripts/world-simulate.ts --days 1 --residents 12 --seed 1
 *   npx tsx scripts/world-simulate.ts --days 7 --residents 30 --seed 2 --db /tmp/town-sim.db --json out.json
 *
 * 参数：--days（默认 1，可小数）--residents（默认 12）--seed（默认 1）--db（默认内存库；给路径用文件库并量体积、做停机重启）
 *       --json <path> --verbose  另有 --restarts <n>（文件库默认按天数自动安排）--check-every <分钟>（默认 30）
 *       --privacy-samples <n>（每轮隐私抽查人数，默认 3）--limit <n>（在场人数上限，默认 30）
 * 随机只用注入的 SeededRng；同种子同参数两次运行的动作序列和最终统计一致（见输出的“可复现摘要”）。
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  Clock,
  CmdStats,
  Conn,
  DAY,
  HOUR,
  Invariants,
  MIN,
  Rand,
  TOWN_START,
  WorldError,
  dbFootprint,
  fmtBytes,
  fmtDuration,
  makePrincipal,
  openWorld,
  arrivalAt,
  positionAt,
  renewTrack,
  trackNav,
  personName,
  percentile,
  randomProfile,
  runCommand,
  sha,
  summarize,
  table,
  townAgentView,
  townMeView,
  townPublicView,
  utf8Bytes,
  type Kind,
  type NavTrack,
  type Outcome,
  type Person,
  type WorldService,
} from './world-lib.js';
import { PUBLIC_OBJECTS } from '../packages/engine/src/world/content.js';
import { actorOf } from '../packages/engine/src/world/space.js';
import { exchangeTicket, issueTicket, sessionPrincipal } from '../packages/engine/src/index.js';

type MeView = ReturnType<typeof townMeView>;

// ───────────────────────── 参数 ─────────────────────────

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '1' },
    residents: { type: 'string', default: '12' },
    seed: { type: 'string', default: '1' },
    db: { type: 'string' },
    json: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    restarts: { type: 'string' },
    'check-every': { type: 'string', default: '30' },
    'privacy-samples': { type: 'string', default: '3' },
    limit: { type: 'string', default: '30' },
  },
});
const DAYS = Number(args.days);
const N = Number(args.residents);
const SEED = String(args.seed);
const DB_PATH = args.db ?? ':memory:';
const VERBOSE = Boolean(args.verbose);
const CHECK_EVERY = Number(args['check-every']) * MIN;
const PRIV = Number(args['privacy-samples']);
const LIMIT = Number(args.limit);
if (!(DAYS > 0) || !(N >= 2)) {
  console.error('用法：--days >0，--residents >=2');
  process.exit(2);
}
if (DB_PATH !== ':memory:' && existsSync(DB_PATH)) {
  console.error(`数据库文件 ${DB_PATH} 已存在，请换一个路径（脚本不覆盖已有文件）。`);
  process.exit(2);
}
const FILE_MODE = DB_PATH !== ':memory:';
const RESTARTS = args.restarts !== undefined ? Number(args.restarts) : FILE_MODE ? Math.max(1, Math.round(DAYS * 1.5)) : 0;
if (RESTARTS > 0 && !FILE_MODE) {
  console.error('停机重启需要文件库（--db <路径>）。');
  process.exit(2);
}

const PHRASES = ['今天天气不错', '你好呀', '好久不见', '最近在忙什么', '这里真安静', '想喝点茶', '要不要一起坐坐', '我刚读完一本书', '花开得真好', '晚上有集市吗', '谢谢你', '下次再聊'];
const TRADABLE = ['tea_leaves', 'vegetables', 'seeds', 'soup', 'cookie', 'flower', 'lantern', 'paper_lamp'] as const;
const CONSUMABLE = ['soup', 'cookie'] as const;

// ───────────────────────── 居民状态 ─────────────────────────

interface Cli {
  conn: Conn;
  hbAt: number;
}

interface Ag {
  p: Person;
  rnd: Rand;
  persona: 'regular' | 'daily' | 'sporadic';
  playful: number;
  dual: boolean;
  registered: boolean;
  sessions: [number, number][];
  sessionNo: number;
  online: boolean;
  clients: Cli[];
  ctrl: Conn | null;
  lastClientId: string | null;
  sessionEnd: number;
  endMode: 'leave' | 'drop';
  decideAt: number;
  dropUntil: number;
  reclaimAt: number;
  ring: { conn: Conn; req: ReturnType<Conn['build']>; out: Record<string, any>; at: number }[];
  lastSpeak: number;
  firstSeen: boolean;
  /** 走路时的“性格”：steady 正常续租；stingy 不续租（模拟断线）；fickle 走到一半改道；halter 走到一半停下；ghost 走到一半离线 */
  walk: WalkStyle;
  /** 手里这一趟导航（客户端视角，只靠回执和续租回包） */
  nav: NavTrack | null;
  /** 这一趟导航里还会续几次租约（stingy 用完就不再续），null = 一直续 */
  renewsLeft: number | null;
  /** 这一趟走到一半要做的事 */
  walkPlan: { kind: 'reroute' | 'halt' | 'ghost' | 'chat'; at: number } | null;
  /** 走到物件旁边之后要去用的物件 */
  useObject: string | null;
}

type WalkStyle = 'steady' | 'stingy' | 'fickle' | 'halter' | 'ghost';

interface Anomaly {
  kind: string;
  count: number;
  sample: unknown;
}

// ───────────────────────── 模拟器 ─────────────────────────

class Sim {
  w!: WorldService;
  readonly clock = new Clock(TOWN_START);
  readonly rnd = new Rand(`sim:${SEED}`);
  readonly inv = new Invariants();
  readonly stats = new CmdStats();
  readonly ags: Ag[] = [];
  readonly logs: string[] = [];
  readonly endT = TOWN_START + Math.round(DAYS * DAY);
  nextCheck = TOWN_START + CHECK_EVERY;
  chatSeq = 0;
  letterSeq = 0;
  bootNo = 0;
  restarts: { at: number; downtime: number; clean: boolean; runningGames: number; abortedAfter: number; outageSeen: number; idempotent: boolean }[] = [];
  restartPlan: { at: number; downtime: number; clean: boolean; prefer: boolean; postponed: number }[] = [];
  purchases = { book: 0, planter_box: 0, stove_kit: 0 };
  readonly buyPerDay = new Map<string, number>();
  readonly actionCount = new Map<string, number>();
  readonly internal: { type: string; fields: unknown; error: string; stack: string }[] = [];
  internalCount = 0;
  readonly anomalies = new Map<string, Anomaly>();
  readonly rejectChecks = { run: 0, failed: 0, samples: [] as string[] };
  readonly negCount = new Map<string, number>();
  readonly failBy = new Map<string, number>();
  readonly counters = new Map<string, number>();
  readonly gameStarted = new Map<string, number>();
  readonly sizes = { agent: [] as number[], me: [] as number[] };
  readonly daily: { day: number; bytes: number; free: number; rows: number; tables: Record<string, number>; walBytes: number }[] = [];
  fileBytesByDay: number[] = [];
  nextDayMark = TOWN_START + DAY;
  steps = 0;
  lastTickT = -1;
  startWall = performance.now();
  concurrentGamesMax = 0;
  presentMax = 0;

  bump(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  // ───── 初始化 ─────

  init(): void {
    this.w = openWorld({ dbPath: DB_PATH, clock: this.clock, seed: `sim${SEED}`, bootTag: '0', params: { activeResidentLimit: LIMIT }, log: (m) => this.logs.push(m) });
    for (let i = 0; i < N; i++) {
      const kind: Kind = i % 3 === 1 ? 'human' : 'agent';
      const name = personName(i);
      const rnd = this.rnd.fork(`ag${i}`);
      const persona = i < Math.ceil(N * 0.4) ? 'regular' : i < Math.ceil(N * 0.75) ? 'daily' : 'sporadic';
      const principalId = makePrincipal(this.w, i, kind, name);
      const p: Person = { idx: i, name, kind, principalId, residentId: '' };
      const ag: Ag = {
        p,
        rnd,
        persona,
        playful: rnd.float(),
        dual: rnd.chance(0.35),
        registered: false,
        sessions: [],
        sessionNo: 0,
        online: false,
        clients: [],
        ctrl: null,
        lastClientId: null,
        sessionEnd: 0,
        endMode: 'leave',
        decideAt: Infinity,
        dropUntil: 0,
        reclaimAt: 0,
        ring: [],
        lastSpeak: -1e15,
        firstSeen: true,
        // 固定分配几种“不守规矩”的走路方式，保证小规模模拟里每种路径都会走到
        walk: (['steady', 'steady', 'stingy', 'fickle', 'halter', 'ghost', 'steady'] as const)[i % 7]!,
        nav: null,
        renewsLeft: null,
        walkPlan: null,
        useObject: null,
      };
      this.planSessions(ag);
      this.ags.push(ag);
    }
    this.planRestarts();
  }

  /** 为整个模拟期间一次性排好作息（可复现）。 */
  private planSessions(ag: Ag): void {
    const r = ag.rnd;
    const days = Math.ceil(DAYS) + 1;
    const hourPick = (): number => r.weighted<number>([[r.range(7, 10), 2], [r.range(11, 13), 3], [r.range(19, 21), 4], [r.range(14, 18), 1], [r.range(22, 23), 1]])!;
    const pref = hourPick();
    let prevEnd = TOWN_START - 1;
    const add = (s: number, e: number) => {
      const start = Math.max(s, prevEnd + 5 * MIN);
      if (e - start < 5 * MIN) return;
      ag.sessions.push([start, e]);
      prevEnd = e;
    };
    for (let d = 0; d < days; d++) {
      const base = TOWN_START + d * DAY;
      if (ag.persona === 'regular') {
        const s = base + r.range(7 * 60 + 30, 10 * 60) * MIN;
        const e = base + r.range(21 * 60 + 30, 24 * 60 + 30) * MIN;
        const breaks = r.range(0, 2);
        let cur = s;
        for (let b = 0; b < breaks; b++) {
          const bs = cur + r.range(60, 300) * MIN;
          if (bs > e - 90 * MIN) break;
          const be = bs + r.range(10, 90) * MIN;
          add(cur, bs);
          cur = be;
        }
        add(cur, e);
      } else if (ag.persona === 'daily') {
        if (r.chance(0.92)) {
          const n = r.chance(0.3) ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const h = k === 0 ? pref : hourPick();
            const s = base + (h * 60 + r.range(-40, 40)) * MIN;
            add(s, s + r.range(20, 100) * MIN);
          }
        }
      } else if (r.chance(0.28)) {
        const s = base + (hourPick() * 60 + r.range(0, 59)) * MIN;
        add(s, s + r.range(15, 70) * MIN);
      }
    }
    ag.sessions.sort((a, b) => a[0] - b[0]);
  }

  private planRestarts(): void {
    const r = this.rnd.fork('restarts');
    for (let i = 0; i < RESTARTS; i++) {
      const at = TOWN_START + Math.round((0.08 + (0.84 * (i + r.float())) / RESTARTS) * DAYS * DAY);
      const kind = i % 4;
      // 长短停机都有：短（<120 秒，小游戏顺延继续）、中（几分钟，小游戏中止）、长（几小时）
      const downtime = kind === 0 ? r.range(15, 100) * 1000 : kind === 1 ? r.range(3, 40) * MIN : kind === 2 ? r.range(30, 110) * 1000 : r.range(2, 7) * HOUR;
      this.restartPlan.push({ at, downtime, clean: i % 2 === 0, prefer: i % 2 === 0, postponed: 0 });
    }
    this.restartPlan.sort((a, b) => a.at - b.at);
  }

  // ───── 命令执行 ─────

  private fingerprint(rid: string): string {
    const db = this.w.db;
    const seq = (n: string) => db.scalar('SELECT seq FROM sqlite_sequence WHERE name = ?', n);
    return [
      seq('ledger_transactions'),
      seq('world_events'),
      seq('scheduled_jobs'),
      db.scalar('SELECT revision FROM residents WHERE resident_id = ?', rid),
      db.scalar('SELECT COALESCE(MAX(rowid), 0) FROM items'),
      db.scalar('SELECT COUNT(*) FROM request_receipts WHERE resident_id = ?', rid),
      db.scalar("SELECT high_water FROM stream_heads WHERE stream_key = 'r:' || ?", rid),
      db.scalar("SELECT COALESCE(MAX(high_water), 0) FROM stream_heads WHERE stream_key LIKE 'r:%'"),
      db.scalar("SELECT COALESCE(MAX(high_water), 0) FROM stream_heads WHERE stream_key LIKE 'pub:%'"),
    ].join('/');
  }

  /** 发一条动作，登记统计；失败（被拒绝）的命令不允许留下任何副作用。 */
  exec(ag: Ag, conn: Conn, type: string, fields: Record<string, unknown> = {}, o: { requestId?: string; window?: string; expected?: Record<string, unknown>; neg?: string[]; noRecover?: boolean } = {}): Outcome {
    const fp = this.fingerprint(ag.p.residentId);
    let req = conn.build(type, fields, o);
    let out = runCommand(this.w, conn.auth, req);
    // 控制权被别的客户端拿走：真实客户端会提示接管；正常流程里接管后重试一次
    if (!out.ok && out.code === 'control_lost' && !o.neg && !o.noRecover) {
      this.bump('control_lost_then_claim');
      try {
        conn.claim();
        ag.ctrl = conn;
        req = conn.build(type, fields);
        out = runCommand(this.w, conn.auth, req);
      } catch (e) {
        if (!(e instanceof WorldError)) this.recordInternal(type, fields, e);
      }
    }
    this.stats.record(type, out);
    this.actionCount.set(type, (this.actionCount.get(type) ?? 0) + 1);
    if (!out.ok) {
      if (out.code === 'INTERNAL') this.recordInternal(type, fields, out.internal);
      else if (this.fingerprint(ag.p.residentId) !== fp) this.rejectEffect(type, fields, out.code);
      if (!o.neg) this.classify(type, fields, out);
      if (!o.neg && out.code === 'precondition_failed') {
        const k = `${type}/${out.reason ?? ''}`;
        this.failBy.set(k, (this.failBy.get(k) ?? 0) + 1);
      }
    } else if (out.out.replayed && this.fingerprint(ag.p.residentId) !== fp) this.rejectEffect(type, fields, 'replayed');
    if (out.ok && !out.out.replayed && !o.neg) {
      ag.ring.push({ conn, req, out: JSON.parse(JSON.stringify(out.out)), at: this.clock.t });
      if (ag.ring.length > 12) ag.ring.shift();
    }
    return out;
  }

  private rejectEffect(type: string, fields: unknown, code: string): void {
    this.rejectChecks.failed++;
    const msg = `被拒绝（${code}）的命令 ${type} 留下了副作用 ${JSON.stringify(fields).slice(0, 200)}`;
    if (this.rejectChecks.samples.length < 10) this.rejectChecks.samples.push(msg);
    this.inv.fail('reject_no_effect', msg, { type, fields }, this.clock.t);
  }

  private recordInternal(type: string, fields: unknown, e: unknown): void {
    this.internalCount++;
    const err = e instanceof Error ? e : new Error(String(e));
    const key = `${type}:${err.message.slice(0, 100)}`;
    if (!this.internal.some((x) => `${x.type}:${x.error.slice(0, 100)}` === key) && this.internal.length < 30) {
      this.internal.push({ type, fields, error: err.message, stack: (err.stack ?? '').split('\n').slice(0, 6).join('\n') });
      console.error(`\n!! 内部异常 动作=${type} ${JSON.stringify(fields).slice(0, 200)}\n   ${err.stack?.split('\n').slice(0, 6).join('\n   ')}`);
    }
  }

  /** 正常流程里不该出现的拒绝码，记为“驱动期望外”。 */
  private classify(type: string, fields: unknown, o: Extract<Outcome, { ok: false }>): void {
    const soft = new Set(['precondition_failed', 'rate_limited']);
    if (o.code === 'INTERNAL' || soft.has(o.code)) return;
    const key = `${o.code}/${type}`;
    const a = this.anomalies.get(key) ?? { kind: key, count: 0, sample: { fields, message: o.message, data: o.data } };
    a.count++;
    this.anomalies.set(key, a);
  }

  /** 故意发错的请求：必须被拒绝，而且码要对。 */
  private expectReject(ag: Ag, label: string, o: Outcome, codes: string[], extra?: unknown): boolean {
    this.rejectChecks.run++;
    this.negCount.set(label, (this.negCount.get(label) ?? 0) + 1);
    if (!o.ok && codes.includes(o.code)) return true;
    this.rejectChecks.failed++;
    const msg = `${label}：期望被 ${codes.join('/')} 拒绝，实际 ${o.ok ? '被接受了' : o.code + '/' + (o.reason ?? '')}`;
    if (this.rejectChecks.samples.length < 10) this.rejectChecks.samples.push(msg);
    this.inv.fail('reject_expected', msg, { who: ag.p.name, extra, outcome: o.ok ? o.out : { code: o.code, reason: o.reason, message: o.message } }, this.clock.t);
    return false;
  }

  // ───── 会话 ─────

  private startSession(ag: Ag): void {
    const now = this.clock.t;
    const [, end] = ag.sessions.shift()!;
    ag.sessionNo++;
    const reuse = ag.lastClientId !== null && ag.rnd.chance(0.6);
    const kind = ag.p.kind === 'agent' ? 'mcp' : 'web';
    const clientId = reuse ? ag.lastClientId! : `${kind}:${ag.p.idx}-s${ag.sessionNo}`;
    ag.lastClientId = clientId;
    // 真人有时重新登录（可信适配层签发票据 → 兑换会话），主体必须是同一个
    if (ag.p.kind === 'human' && ag.registered && ag.rnd.chance(0.3)) {
      try {
        const t = issueTicket(this.w, { provider: 'qq', subject: String(2000 + ag.p.idx), name: ag.p.name });
        const s = exchangeTicket(this.w, t.ticket);
        const pr = sessionPrincipal(this.w, s.token);
        this.bump('relogin');
        if (pr?.principal_id !== ag.p.principalId) this.inv.fail('single_resident', `重新登录得到了不同的主体 ${pr?.principal_id} ≠ ${ag.p.principalId}`, { who: ag.p.name }, now);
        let reuseErr: unknown = null;
        try {
          exchangeTicket(this.w, t.ticket);
        } catch (e) {
          reuseErr = e;
        }
        this.rejectChecks.run++;
        if (!(reuseErr instanceof WorldError && reuseErr.code === 'unauthenticated')) {
          this.rejectChecks.failed++;
          this.inv.fail('reject_expected', '登录票据被重复兑换成功', { who: ag.p.name }, now);
        }
      } catch (e) {
        this.recordInternal('relogin', {}, e);
      }
    }
    const conn = new Conn(this.w, ag.p, clientId, kind);
    if (!this.doEnter(ag, conn, false)) {
      this.bump('enter_refused');
      return;
    }
    ag.online = true;
    ag.clients = [{ conn, hbAt: now + ag.rnd.range(5, 20) * 1000 }];
    ag.ctrl = conn;
    ag.sessionEnd = end;
    ag.endMode = ag.rnd.chance(0.55) ? 'leave' : 'drop';
    ag.decideAt = now + ag.rnd.range(1, 8) * 1000;
    ag.dropUntil = 0;
    ag.reclaimAt = 0;
    ag.nav = null;
    ag.walkPlan = null;
    this.bump('sessions');
  }

  /** 进入小镇。返回是否成功（world_full 等拒绝算“没进去”）。 */
  private doEnter(ag: Ag, conn: Conn, reconnect: boolean): boolean {
    const profile = ag.registered ? undefined : randomProfile(ag.rnd, ag.p.name);
    try {
      const before = this.w.db.scalar('SELECT COUNT(*) FROM residents');
      const e = conn.enter(profile);
      if (!ag.registered) {
        ag.p.residentId = e.residentId;
        ag.registered = true;
        if (!e.created) this.inv.fail('single_resident', '第一次进入却不是新注册', { who: ag.p.name }, this.clock.t);
      } else {
        if (e.residentId !== ag.p.residentId) this.inv.fail('single_resident', `重复进入得到了另一个居民 ${e.residentId} ≠ ${ag.p.residentId}`, { who: ag.p.name }, this.clock.t);
        if (e.created) this.inv.fail('single_resident', '重复进入又创建了新居民', { who: ag.p.name }, this.clock.t);
        if (this.w.db.scalar('SELECT COUNT(*) FROM residents') !== before) this.inv.fail('single_resident', '重复进入改变了居民总数', { who: ag.p.name }, this.clock.t);
      }
      if (e.viewBytes) (conn.kindOfClient === 'mcp' ? this.sizes.agent : this.sizes.me).push(e.viewBytes);
      this.bump(reconnect ? 'reconnect_enter' : 'enter');
      return true;
    } catch (e) {
      if (e instanceof WorldError && e.reason === 'world_full') {
        this.bump('world_full');
        return false;
      }
      if (e instanceof WorldError) {
        this.bump(`enter_error_${e.code}`);
        if (e.code !== 'recovering') this.anomalies.set(`enter/${e.code}`, { kind: `enter/${e.code}`, count: (this.anomalies.get(`enter/${e.code}`)?.count ?? 0) + 1, sample: e.message });
        return false;
      }
      this.recordInternal('enter', {}, e);
      return false;
    }
  }

  private endSession(ag: Ag): void {
    const now = this.clock.t;
    const conn = ag.ctrl ?? ag.clients[0]?.conn;
    if (conn && ag.endMode === 'leave') {
      // 显式离开之前先把“迟到”的请求备好：离开后它们必须被拒绝，旧页面迟到的心跳也不能让居民重新在场
      const lateReq = conn.build('speak', { text: `迟到的话（编号C${String(++this.chatSeq).padStart(6, '0')}X）` });
      const oldEpoch = this.w.mustResident(ag.p.residentId).presence_epoch;
      try {
        conn.leave();
        this.bump('leave');
      } catch (e) {
        if (e instanceof WorldError) this.bump(`leave_${e.code}`);
        else this.recordInternal('leave', {}, e);
      }
      const fp = this.fingerprint(ag.p.residentId);
      const late = runCommand(this.w, conn.auth, lateReq);
      this.stats.record('late_after_leave', late);
      this.expectReject(ag, '离开后迟到的动作', late, ['precondition_failed', 'control_lost']);
      let hbErr: unknown = null;
      try {
        conn.heartbeat(oldEpoch);
      } catch (e) {
        hbErr = e;
      }
      this.rejectChecks.run++;
      this.negCount.set('离开后迟到的心跳', (this.negCount.get('离开后迟到的心跳') ?? 0) + 1);
      if (!(hbErr instanceof WorldError)) {
        this.rejectChecks.failed++;
        this.inv.fail('reject_expected', '显式离开后，旧页面迟到的心跳被接受了', { who: ag.p.name }, now);
      }
      if (this.w.mustResident(ag.p.residentId).present_since !== null) this.inv.fail('presence_after_leave', '显式离开后，迟到的心跳让居民重新在场了', { who: ag.p.name }, now);
      if (this.fingerprint(ag.p.residentId) !== fp) this.rejectEffect('late_after_leave', {}, 'late');
    } else {
      this.bump('drop');
    }
    ag.online = false;
    ag.clients = [];
    ag.ctrl = null;
    ag.decideAt = Infinity;
    ag.nav = null;
    ag.walkPlan = null;
  }

  private heartbeat(ag: Ag, cli: Cli): void {
    const now = this.clock.t;
    cli.hbAt = now + 20_000 + ag.rnd.range(-2000, 2000);
    try {
      cli.conn.heartbeat();
    } catch (e) {
      if (e instanceof WorldError && e.reason === 'presence_lost') {
        // 掉线太久租约过期：重新进入（走到一半的路线早已被服务器停下）
        ag.nav = null;
        ag.walkPlan = null;
        if (!this.doEnter(ag, cli.conn, true)) {
          ag.clients = ag.clients.filter((c) => c !== cli);
          if (ag.clients.length === 0) {
            ag.online = false;
            ag.ctrl = null;
            ag.decideAt = Infinity;
          }
        }
      } else if (e instanceof WorldError && e.reason === 'world_full') {
        this.bump('world_full');
        ag.clients = ag.clients.filter((c) => c !== cli);
        if (ag.clients.length === 0) {
          ag.online = false;
          ag.ctrl = null;
          ag.decideAt = Infinity;
        }
      } else if (e instanceof WorldError) {
        this.bump(`heartbeat_${e.code}`);
      } else this.recordInternal('heartbeat', {}, e);
    }
  }

  // ───── 事件循环 ─────

  private nextAgentEvent(ag: Ag): number {
    if (!ag.online) return ag.sessions.length > 0 ? ag.sessions[0]![0] : Infinity;
    let t = ag.sessionEnd;
    if (ag.dropUntil > 0) return Math.min(t, ag.dropUntil);
    t = Math.min(t, ag.decideAt);
    for (const c of ag.clients) t = Math.min(t, c.hbAt);
    if (ag.reclaimAt > 0) t = Math.min(t, ag.reclaimAt);
    if (ag.nav) t = Math.min(t, ag.nav.renewAt);
    return t;
  }

  private runAgent(ag: Ag): void {
    const now = this.clock.t;
    if (!ag.online) {
      if (ag.sessions.length > 0 && ag.sessions[0]![0] <= now) {
        // 上一次“掉线”的租约可能还没过期：新会话照常进入
        this.startSession(ag);
      }
      return;
    }
    if (ag.sessionEnd <= now) {
      this.endSession(ag);
      return;
    }
    if (ag.dropUntil > 0) {
      if (ag.dropUntil <= now) {
        ag.dropUntil = 0;
        this.bump('reconnect');
        for (const c of [...ag.clients]) this.heartbeat(ag, c);
        if (ag.online) ag.decideAt = now + ag.rnd.range(1, 10) * 1000;
      }
      return;
    }
    for (const c of [...ag.clients]) if (c.hbAt <= now) this.heartbeat(ag, c);
    if (!ag.online) return;
    if (ag.reclaimAt > 0 && ag.reclaimAt <= now) {
      ag.reclaimAt = 0;
      const first = ag.clients[0]?.conn;
      if (first && first !== ag.ctrl) {
        try {
          first.claim();
          ag.ctrl = first;
          this.bump('reclaim');
        } catch (e) {
          if (!(e instanceof WorldError)) this.recordInternal('claim', {}, e);
        }
      }
    }
    if (ag.nav && ag.nav.renewAt <= now) this.renewNav(ag);
    if (!ag.online) return;
    if (ag.decideAt <= now) {
      try {
        const delay = this.decide(ag);
        ag.decideAt = now + Math.max(1000, delay);
      } catch (e) {
        this.recordInternal('decide', { who: ag.p.name }, e);
        ag.decideAt = now + 30_000;
      }
    }
  }

  private pendingJobDue(): number {
    const row = this.w.db.get<{ m: number | null }>("SELECT MIN(due_at) AS m FROM scheduled_jobs WHERE status = 'pending'");
    return row?.m ?? Infinity;
  }

  run(): void {
    const w0 = performance.now();
    void w0;
    let lastProgress = performance.now();
    while (this.clock.t < this.endT) {
      let next = Math.min(this.endT, this.nextCheck, this.nextDayMark, this.clock.t + 30_000);
      if (this.restartPlan.length > 0) next = Math.min(next, this.restartPlan[0]!.at);
      const due = this.pendingJobDue();
      if (due > this.clock.t) next = Math.min(next, due);
      for (const ag of this.ags) next = Math.min(next, this.nextAgentEvent(ag));
      if (next <= this.clock.t) next = this.clock.t;
      if (next > this.clock.t) this.clock.t = next;
      this.steps++;
      if (this.clock.t !== this.lastTickT) {
        this.w.tick();
        this.lastTickT = this.clock.t;
      }
      for (const ag of this.ags) if (this.nextAgentEvent(ag) <= this.clock.t) this.runAgent(ag);
      this.sample();
      if (this.restartPlan.length > 0 && this.restartPlan[0]!.at <= this.clock.t) this.maybeRestart();
      if (this.clock.t >= this.nextCheck) {
        this.check();
        this.nextCheck += CHECK_EVERY;
      }
      if (this.clock.t >= this.nextDayMark) {
        this.dayMark();
        this.nextDayMark += DAY;
      }
      if (VERBOSE && performance.now() - lastProgress > 5000) {
        lastProgress = performance.now();
        console.error(`  … 逻辑时间 ${fmtDuration(this.clock.t - TOWN_START)} / ${fmtDuration(this.endT - TOWN_START)}，命令 ${this.stats.total}，违例 ${this.inv.totalViolations}，实际已用 ${fmtDuration(performance.now() - this.startWall)}`);
      }
    }
    // 收尾：时钟停在结束时刻再检查一次
    this.w.tick();
    this.check(true);
    if (this.daily.length < Math.ceil(DAYS)) this.dayMark();
  }

  private sample(): void {
    const n = this.w.db.scalar("SELECT COUNT(*) FROM activities WHERE status = 'running'");
    if (n > this.concurrentGamesMax) this.concurrentGamesMax = n;
    const p = this.w.presentCount();
    if (p > this.presentMax) this.presentMax = p;
  }

  private check(final = false): void {
    // 先让调度器处理完已到期的任务，再检查
    this.w.tick();
    const t0 = performance.now();
    this.inv.check(this.w, { now: this.clock.t, expectedResidents: this.ags.filter((a) => a.registered).length, purchases: this.purchases, rnd: this.rnd.fork(`priv${this.inv.checkRounds}`), privacySamples: PRIV });
    this.bump('check_ms', performance.now() - t0);
    void final;
  }

  private dayMark(): void {
    const fp = dbFootprint(this.w);
    const rows = Object.values(fp.tables).reduce((a, b) => a + b, 0);
    let wal = 0;
    if (FILE_MODE) {
      try {
        wal = existsSync(`${DB_PATH}-wal`) ? statSync(`${DB_PATH}-wal`).size : 0;
      } catch {
        wal = 0;
      }
    }
    this.daily.push({ day: this.daily.length + 1, bytes: fp.bytes, free: fp.free, rows, tables: fp.tables, walBytes: wal });
    if (FILE_MODE) {
      try {
        this.fileBytesByDay.push(statSync(DB_PATH).size);
      } catch {
        this.fileBytesByDay.push(0);
      }
    }
  }

  // ───── 停机重启 ─────

  private runningGames(): number {
    return this.w.db.scalar("SELECT COUNT(*) FROM activities WHERE status = 'running'");
  }

  private digestForRestart(): string {
    const db = this.w.db;
    return sha(
      JSON.stringify([
        db.scalar('SELECT COUNT(*) FROM ledger_transactions'),
        db.scalar("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind='resident'"),
        db.scalar('SELECT COUNT(*) FROM items'),
        db.scalar('SELECT COALESCE(SUM(quantity),0) FROM items'),
        db.scalar('SELECT COUNT(*) FROM settlements'),
        db.scalar('SELECT COUNT(*) FROM world_events'),
        db.scalar('SELECT COUNT(*) FROM letters WHERE delivered_at IS NOT NULL'),
        db.scalar("SELECT COUNT(*) FROM interactions WHERE status IN ('completed','cancelled')"),
        db.scalar("SELECT COUNT(*) FROM resident_goals WHERE status = 'completed'"),
        db.scalar('SELECT COUNT(*) FROM daily_reports'),
        db.scalar("SELECT COUNT(*) FROM public_events WHERE type = 'report'"),
        db.scalar('SELECT COUNT(*) FROM public_event_instances'),
      ]),
    );
  }

  private maybeRestart(): void {
    const plan = this.restartPlan[0]!;
    // 偶数次重启尽量赶在有小游戏进行时（最多顺延两小时），好验证“短停机顺延继续 / 长停机中止”
    if (plan.prefer && this.runningGames() === 0 && plan.postponed < 40) {
      plan.at = this.clock.t + 3 * MIN;
      plan.postponed++;
      return;
    }
    this.restartPlan.shift();
    this.restart(plan);
  }

  private restart(plan: { downtime: number; clean: boolean }): void {
    const before = { games: this.runningGames(), gameIds: this.w.db.all("SELECT activity_id FROM activities WHERE status = 'running'").map((r) => r.activity_id as string) };
    const coinsBefore = this.w.db.scalar("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind='resident'");
    const txBefore = this.w.db.scalar('SELECT COUNT(*) FROM ledger_transactions');
    const rewardsBefore = this.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'game_reward'");
    // 停机前先把调度器跑一遍（已到期的先处理）
    this.w.tick();
    const closedAt = this.clock.t;
    // 记下此刻正在走路的人：重启后他们必须停在最后一个耐久检查点，不能“多走”
    const walkers = this.w.db
      .all('SELECT resident_id FROM residents WHERE present_since IS NOT NULL')
      .map((r) => actorOf(this.w, String(r.resident_id))!)
      .filter((a) => a.nav)
      .map((a) => ({ rid: a.actor_id, scene: a.scene_id, instance: a.instance_id, nav: a.nav! }));
    for (const ag of this.ags) {
      ag.nav = null;
      ag.walkPlan = null;
    }
    if (plan.clean) this.w.close();
    else {
      // 模拟进程被杀：不写最后一次存活时间，也不做关闭时的检查点
      this.w.status = 'closed';
      this.w.db.db.close();
    }
    this.clock.t += plan.downtime;
    this.bootNo++;
    this.w = openWorld({ dbPath: DB_PATH, clock: this.clock, seed: `sim${SEED}`, bootTag: String(this.bootNo), params: { activeResidentLimit: LIMIT }, log: (m) => this.logs.push(m) });
    this.lastTickT = this.clock.t;
    for (const ag of this.ags) for (const c of ag.clients) c.conn.w = this.w;
    for (const ag of this.ags) for (const r of ag.ring) r.conn.w = this.w;
    const now = this.clock.t;
    // 恢复后的检查：重启前在场的人先按离线处理；所有到期任务已追赶完
    const stillPresent = this.w.db.scalar('SELECT COUNT(*) FROM residents WHERE present_since IS NOT NULL');
    this.inv.fail; // (保持引用，避免被摇树)
    if (stillPresent !== 0) this.inv.fail('restart_presence', `重启后仍有 ${stillPresent} 位居民显示在场（应等心跳重新确认）`, null, now);
    const outageSeen = this.w.lastOutageMs;
    if (outageSeen < plan.downtime - 1000 || outageSeen > plan.downtime + 6000) {
      this.inv.fail('restart_outage_estimate', `停机时长估计 ${outageSeen} ms，实际 ${plan.downtime} ms`, { clean: plan.clean }, now);
    }
    // 小游戏：停机不超过 120 秒顺延继续；超过则中止且没有奖励
    let abortedAfter = 0;
    for (const id of before.gameIds) {
      const a = this.w.db.get("SELECT status FROM activities WHERE activity_id = ?", id);
      if (a?.status === 'aborted') abortedAfter++;
      this.rejectChecks.run++;
      if (plan.downtime > this.w.params.shortOutageLimitMs) {
        if (a?.status !== 'aborted' && a?.status !== 'completed') {
          this.rejectChecks.failed++;
          this.inv.fail('restart_games', `停机 ${Math.round(plan.downtime / 1000)} 秒（>${this.w.params.shortOutageLimitMs / 1000} 秒）后，小游戏 ${id} 状态是 ${a?.status}，应已中止`, null, now);
        }
      } else if (a?.status === 'aborted') {
        const reason = this.w.db.get('SELECT result_json FROM activities WHERE activity_id = ?', id)?.result_json;
        // 短停机后仍被中止只允许由“最长时限”等原因导致
        if (!/最长时间/.test(String(reason))) {
          this.rejectChecks.failed++;
          this.inv.fail('restart_games', `停机仅 ${Math.round(plan.downtime / 1000)} 秒，小游戏 ${id} 却被中止：${reason}`, null, now);
        }
      }
    }
    const rewardsAfterAborted = this.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'game_reward'") - rewardsBefore;
    void rewardsAfterAborted;
    // 恢复是幂等的：立刻再“重启”一次（零停机），结算类的数字不能再变
    const d1 = this.digestForRestart();
    this.w.close();
    this.bootNo++;
    this.w = openWorld({ dbPath: DB_PATH, clock: this.clock, seed: `sim${SEED}`, bootTag: String(this.bootNo), params: { activeResidentLimit: LIMIT }, log: (m) => this.logs.push(m) });
    for (const ag of this.ags) for (const c of ag.clients) c.conn.w = this.w;
    for (const ag of this.ags) for (const r of ag.ring) r.conn.w = this.w;
    const d2 = this.digestForRestart();
    this.rejectChecks.run++;
    const idem = d1 === d2;
    if (!idem) {
      this.rejectChecks.failed++;
      this.inv.fail('restart_idempotent', '零停机的二次重启改变了结算类数据（任务被重复执行？）', { d1, d2 }, now);
    }
    const coinsAfter = this.w.db.scalar("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind='resident'");
    void coinsBefore;
    void coinsAfter;
    // 走到一半被停机的人：位置必须是旧路线上 [检查点, 停机时刻] 之间的某一点，没有残留导航
    for (const wk of walkers) {
      const a = actorOf(this.w, wk.rid)!;
      this.rejectChecks.run++;
      this.bump('restart_walkers');
      if (a.nav) {
        this.rejectChecks.failed++;
        this.inv.fail('restart_nav', `重启后居民 ${wk.rid} 还留着导航`, null, now);
        continue;
      }
      if (a.scene_id !== wk.scene || a.instance_id !== wk.instance) {
        this.bump('restart_walkers_scene_changed');
        continue;
      }
      const motion = { points: wk.nav.points, speed: wk.nav.speed, startedAt: wk.nav.startedAt, until: wk.nav.leaseUntil };
      let found = false;
      for (let t = Math.max(wk.nav.startedAt, wk.nav.checkpointAt - 50); t <= closedAt + 50 && !found; t += 25) {
        const p = positionAt(motion, Math.min(t, wk.nav.leaseUntil));
        if (Math.hypot(p.x - a.x, p.z - a.z) < 0.08) found = true;
      }
      if (!found) {
        // 不在旧路线上：只有这一段在停机前已经走完（接着穿过门口、换了路线）才说得过去
        this.bump('restart_walkers_off_leg');
        if (arrivalAt({ points: wk.nav.points, speed: wk.nav.speed, startedAt: wk.nav.startedAt }) > closedAt && wk.nav.leaseUntil > closedAt) {
          this.rejectChecks.failed++;
          this.inv.fail('restart_nav', `重启后居民 ${wk.rid} 的位置 (${a.x.toFixed(2)}, ${a.z.toFixed(2)}) 不在停机前的路线上`, { checkpointAt: wk.nav.checkpointAt, closedAt }, now);
        }
      }
    }
    this.restarts.push({ at: closedAt, downtime: plan.downtime, clean: plan.clean, runningGames: before.games, abortedAfter, outageSeen, idempotent: idem });
    this.check();
    // 所有人的客户端在停机后陆续重连
    for (const ag of this.ags) {
      if (!ag.online) continue;
      for (const c of ag.clients) c.hbAt = now + ag.rnd.range(1, 25) * 1000;
      if (ag.decideAt < now) ag.decideAt = now + ag.rnd.range(2, 30) * 1000;
    }
    if (txBefore > this.w.db.scalar('SELECT COUNT(*) FROM ledger_transactions')) this.inv.fail('restart_ledger_shrank', '重启后账本交易数减少', null, now);
  }

  // ───── 决策 ─────

  private localMs(): number {
    return (this.clock.t - TOWN_START) % DAY;
  }

  private chatText(ag: Ag): string {
    return `${ag.rnd.pick(PHRASES)}（编号C${String(++this.chatSeq).padStart(6, '0')}X）`;
  }

  private decide(ag: Ag): number {
    const now = this.clock.t;
    const conn = ag.ctrl ?? ag.clients[0]!.conn;
    const r0 = this.w.resident(ag.p.residentId);
    if (!r0 || r0.present_since === null) {
      // 被判离线了（比如租约刚过期）：尽快重新进入
      if (ag.online && ag.dropUntil === 0) {
        const cli = ag.clients[0];
        if (cli) this.heartbeat(ag, cli);
      }
      return 5000;
    }
    const v = conn.view();
    (conn.kindOfClient === 'mcp' ? this.sizes.agent : this.sizes.me).push(0);
    this.sizes.me[this.sizes.me.length - 1] === 0 && this.sizes.me.pop();
    this.sizes.agent[this.sizes.agent.length - 1] === 0 && this.sizes.agent.pop();
    this.recordViewSizes(conn, v);

    // 没有控制权：先接管（正常客户端的做法）
    if (!v.control.mine) {
      this.bump('claim_needed');
      try {
        conn.claim();
        ag.ctrl = conn;
      } catch (e) {
        if (e instanceof WorldError) return 10_000;
        throw e;
      }
    }

    // 掉线（不发心跳）
    if (ag.rnd.chance(0.01)) {
      ag.dropUntil = now + ag.rnd.range(10, 150) * 1000;
      this.bump('drop_mid_session');
      return 1000;
    }
    // 多客户端接管
    if (ag.dual && ag.clients.length === 1 && ag.rnd.chance(0.012)) {
      this.takeover(ag);
      return 5000;
    }
    // 故意发错的请求
    if (ag.rnd.chance(0.04)) this.negativeTest(ag, conn, v);

    // 在小游戏里
    if (v.game) return this.gameTurn(ag, conn, v);
    // 在路上：走路的人属于脚下的区域，可以说话，但多数时候等走完
    const nav = v.location.navigation;
    if (nav) return this.walkingTurn(ag, conn, v, nav);
    ag.nav = null;
    ag.walkPlan = null;
    return this.idleDecision(ag, conn, v);
  }

  private recordViewSizes(conn: Conn, v: MeView): void {
    const bytes = utf8Bytes(v);
    this.sizes.me.push(bytes);
    if (conn.kindOfClient === 'mcp') {
      const r = this.w.mustResident(conn.person.residentId);
      this.sizes.agent.push(utf8Bytes(townAgentView(this.w, r, conn.clientId)));
    }
  }

  private takeover(ag: Ag): void {
    const now = this.clock.t;
    const first = ag.clients[0]!.conn;
    const second = new Conn(this.w, ag.p, `web:${ag.p.idx}-t${++ag.sessionNo}`, 'web');
    try {
      const firstHolds = this.w.mustResident(ag.p.residentId).controller_client === first.clientId;
      const e = second.enter();
      this.bump('second_client');
      if (firstHolds && e.presenceEpoch !== this.w.mustResident(ag.p.residentId).presence_epoch) this.inv.fail('presence_epoch', '第二个客户端进入后在场代数不一致', null, now);
      const v2 = second.view();
      if (firstHolds) {
        this.rejectChecks.run++;
        if (v2.control.mine) {
          this.rejectChecks.failed++;
          this.inv.fail('single_controller', '第一个客户端握着控制权时，第二个客户端进入后也显示握着控制权', { who: ag.p.name }, now);
        }
        const o = this.exec(ag, second, 'speak', { text: this.chatText(ag) }, { neg: ['control_lost'] });
        this.expectReject(ag, '没有控制权的客户端发动作', o, ['control_lost']);
      }
      const epoch0 = this.w.mustResident(ag.p.residentId).control_epoch;
      second.claim();
      const epoch1 = this.w.mustResident(ag.p.residentId).control_epoch;
      this.rejectChecks.run++;
      if (firstHolds && epoch1 !== epoch0 + 1) {
        this.rejectChecks.failed++;
        this.inv.fail('control_epoch', `接管后控制代数 ${epoch0} → ${epoch1}，应 +1`, null, now);
      }
      // 旧客户端迟到的动作（带着旧的 controlEpoch）必须被拒绝
      const oldReq = first.build('speak', { text: this.chatText(ag) }, { expected: { contextVersion: this.w.mustResident(ag.p.residentId).context_version, controlEpoch: epoch0, activityId: this.w.mustResident(ag.p.residentId).activity_id } });
      const fp = this.fingerprint(ag.p.residentId);
      const late = runCommand(this.w, first.auth, oldReq);
      this.stats.record('speak(旧客户端)', late);
      this.expectReject(ag, '被接管的旧客户端迟到动作', late, ['control_lost']);
      if (this.fingerprint(ag.p.residentId) !== fp) this.rejectEffect('speak', {}, 'control_lost');
      ag.clients.push({ conn: second, hbAt: now + 15_000 });
      ag.ctrl = second;
      ag.reclaimAt = now + ag.rnd.range(2, 10) * MIN;
    } catch (e) {
      if (e instanceof WorldError) this.bump(`takeover_${e.code}`);
      else this.recordInternal('takeover', {}, e);
    }
  }

  // ───── 小游戏 ─────

  private gameTurn(ag: Ag, conn: Conn, v: MeView): number {
    const g = v.game!;
    const rnd = ag.rnd;
    if (g.status !== 'running') return 3000;
    if (g.your_turn && g.todo && g.phase_id !== null) {
      if (rnd.chance(0.03)) return rnd.range(5, 15) * 1000; // 走神：让超时托管去处理
      const input = this.pickGameInput(ag, g);
      if (!input) return 3000;
      const o = this.exec(ag, conn, 'game_act', { phaseId: g.phase_id, input });
      void o;
      return rnd.range(2, 9) * 1000;
    }
    if (rnd.chance(0.012)) {
      this.exec(ag, conn, 'quit_game');
      this.bump('quit_game');
      return 5000;
    }
    return rnd.range(4, 10) * 1000;
  }

  private pickGameInput(ag: Ag, g: NonNullable<MeView['game']>): Record<string, unknown> | null {
    const rnd = ag.rnd;
    const specs = g.todo?.actions ?? [];
    if (specs.length === 0) return null;
    const challenge = specs.find((s) => s.action === 'challenge');
    if (challenge && rnd.chance(0.25)) return { action: 'challenge' };
    const spec = rnd.pick(specs.filter((s) => s.action !== 'challenge').length ? specs.filter((s) => s.action !== 'challenge') : specs);
    const m = /act\((\{.*\})\)/.exec(spec.example);
    let input: Record<string, unknown> = { action: spec.action };
    if (m) {
      try {
        input = JSON.parse(m[1]!) as Record<string, unknown>;
      } catch {
        /* 用默认 */
      }
    }
    if (spec.action === 'guess') {
      const range = /(\d+)\s*~\s*(\d+)/.exec(String(spec.params?.number ?? ''));
      if (range) input.number = rnd.range(Number(range[1]), Number(range[2]));
    } else if (spec.action === 'bid' && typeof input.number === 'number') {
      input.number = rnd.range(0, input.number);
    }
    return input;
  }

  // ───── 空闲时的选择 ─────

  private idleDecision(ag: Ag, conn: Conn, v: MeView): number {
    const rnd = ag.rnd;
    const now = this.clock.t;
    const here = v.here;
    const me = v.me.id;
    const inv = v.inventory;
    const avail = (type: string) => inv.items.filter((i) => i.type === type && !i.borrowedFrom).reduce((s, i) => s + i.available, 0);
    const lm = this.localMs();

    // 1) 先答复别人给我的报价；久未回应的自己的报价有时撤销
    for (const o of v.offers) {
      if (o.status !== 'open') continue;
      if (o.to.id === me) {
        if (rnd.chance(0.75)) {
          const accept = rnd.chance(0.7);
          this.exec(ag, conn, accept ? 'accept_offer' : 'decline_offer', { offerId: o.id });
          return rnd.range(2, 8) * 1000;
        }
      } else if (o.from.id === me && rnd.chance(0.08)) {
        this.exec(ag, conn, 'cancel_offer', { offerId: o.id });
        return rnd.range(2, 8) * 1000;
      }
    }

    // 2) 正在做共同活动
    if (v.interaction) {
      const ix = v.interaction;
      if (ix.status === 'open') {
        if (ix.initiator.id === me) {
          if (ix.participants.length >= ix.min && rnd.chance(0.6)) {
            this.exec(ag, conn, 'begin_interaction', { interactionId: ix.id });
            return rnd.range(3, 10) * 1000;
          }
          if (rnd.chance(0.04)) {
            this.exec(ag, conn, 'leave_interaction');
            return 5000;
          }
          return rnd.range(10, 25) * 1000;
        }
        if (rnd.chance(0.04)) {
          this.exec(ag, conn, 'leave_interaction');
          return 5000;
        }
        return rnd.range(10, 25) * 1000;
      }
      if (rnd.chance(0.02)) {
        this.exec(ag, conn, 'leave_interaction');
        return 5000;
      }
      const left = (ix.endsAt ?? now) - now;
      return Math.max(3000, left + rnd.range(0, 5000));
    }

    // 自己凑的桌还在等人：守着，不走开
    if (here?.activities.some((a) => a.status === 'forming' && a.players.some((p) => p.id === me)) && rnd.chance(0.9)) {
      const d = this.gameIntent(ag, conn, v, { space: v.location.space ?? '' });
      if (d !== null) return d;
    }
    const intents: [string, number][] = [];
    const residentsHere = here?.residents ?? [];
    const atHome = v.location.space === `home:${me}`;
    const space = v.location.space ?? '';
    const energy = v.me.needs.energy;
    const openEvent = v.events.find((e) => e.status === 'open');
    const eventSoon = v.events.find((e) => e.status === 'scheduled' && e.opensAt - now < 6 * MIN && e.opensAt > now);
    intents.push(['mail', v.mail.unread > 0 ? (atHome ? 8 : 2) : 0]);
    intents.push(['visit', v.invites.received.length > 0 ? 2.5 : 0]);
    intents.push(['revoke', v.invites.sent.length > 0 ? 0.5 : 0]);
    intents.push(['speak', residentsHere.length > 0 ? 6 : 0.6]);
    intents.push(['ask', residentsHere.length > 0 ? 1.5 : 0]);
    intents.push(['buy', here && here.shops.length > 0 ? 3 : 0]);
    intents.push(['use', energy < 75 && (avail('soup') > 0 || avail('cookie') > 0) ? 2.5 : 0]);
    intents.push(['decor', atHome ? 3 : 0]);
    intents.push(['offer', residentsHere.length > 0 ? 2.5 : 0]);
    intents.push(['book', space === 'bookshop' ? 5 : 0]);
    intents.push(['return', inv.items.some((i) => i.borrowedFrom) ? 2.5 : 0]);
    intents.push(['letter', 1.3]);
    intents.push(['invite', residentsHere.length > 0 ? 1.2 : 0]);
    intents.push(['interact', here && here.objects.length > 0 ? 7 : 0]);
    intents.push(['game', 2 + ag.playful * 8 + (here && here.activities.length > 0 ? 6 : 0)]);
    intents.push(['rest', energy < 45 ? 5 : 0.3]);
    intents.push(['event', openEvent || eventSoon ? 6 : 0]);
    intents.push(['goal', 0.15]);
    intents.push(['profile', 0.1]);
    intents.push(['wander', space === 'plaza' ? 5 : 3]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const intent = rnd.weighted(intents);
      if (!intent) break;
      const delay = this.intent(ag, conn, v, intent, { lm, openEvent: openEvent ?? eventSoon, residentsHere, atHome, space });
      if (delay !== null) return delay;
      const slot = intents.find((x) => x[0] === intent);
      if (slot) slot[1] = 0;
    }
    return rnd.range(15, 60) * 1000;
  }

  /**
   * 发 navigate 并接管后面的续租。to 可以是地点 / 物件 / 居民编号 / 地图点；approach 走到某个居民身边。
   * 返回下次决策前等多久；失败返回 null（调用方换别的事做）。
   */
  private moveTo(ag: Ag, conn: Conn, to: string | { x: number; z: number }, mode: 'to' | 'approach' = 'to'): number | null {
    const now = this.clock.t;
    // 旧名字 move 偶尔也用一下（它就是 navigate 的别名）
    const type = ag.rnd.chance(0.1) ? 'move' : 'navigate';
    const o = this.exec(ag, conn, type, mode === 'approach' ? { approach: to } : { to });
    if (!o.ok) return null;
    const out = o.out as { status?: string; navigation?: Parameters<typeof trackNav>[1] };
    if (out.status !== 'accepted' || !out.navigation) {
      // completed：已经在旁边 / 当场走完（站在门口时穿过门）
      this.bump(`nav_${out.status ?? 'unknown'}`);
      ag.nav = null;
      ag.walkPlan = null;
      return ag.rnd.range(2, 8) * 1000;
    }
    this.bump('nav_accepted');
    ag.nav = trackNav(conn, out.navigation, now, ag.rnd.range(0, 400));
    ag.renewsLeft = null;
    ag.walkPlan = null;
    const remaining = Math.max(1000, out.navigation.arriveAt - now);
    const r = ag.rnd;
    // 这一趟的“性格”：什么时候不续租、走到一半做什么
    if (ag.walk === 'stingy' && r.chance(0.7)) ag.renewsLeft = r.range(0, 2);
    const half = now + Math.round(remaining / 2) + r.range(0, 500);
    if (ag.walk === 'fickle' && r.chance(0.6)) ag.walkPlan = { kind: 'reroute', at: half };
    else if (ag.walk === 'halter' && r.chance(0.6)) ag.walkPlan = { kind: 'halt', at: half };
    else if (ag.walk === 'ghost' && r.chance(0.5)) ag.walkPlan = { kind: 'ghost', at: half };
    else if (ag.walk === 'steady' && r.chance(0.12)) ag.walkPlan = { kind: r.chance(0.7) ? 'chat' : 'reroute', at: half };
    if (ag.walkPlan) return Math.max(1000, ag.walkPlan.at - now);
    return Math.max(1000, remaining + r.range(0, 3000));
  }

  /** 到了续租的时间：像真实客户端一样发一次续租（不走回执管线）。 */
  private renewNav(ag: Ag): void {
    const nav = ag.nav!;
    const now = this.clock.t;
    if (ag.renewsLeft !== null && ag.renewsLeft <= 0) {
      // 不守规矩的客户端：不再续租，让服务器按租约把人停在截止那一刻的位置
      nav.renewAt = Infinity;
      this.bump('renew_abandoned');
      return;
    }
    if (ag.renewsLeft !== null) ag.renewsLeft--;
    const t0 = this.clock.t;
    const fp = this.fingerprint(ag.p.residentId);
    const res = renewTrack(this.w, nav, now, ag.rnd.range(0, 400));
    void t0;
    void fp;
    this.bump(`renew_${res.result}`);
    if (res.adopted) this.bump('renew_adopted');
    if (res.result !== 'ok') {
      ag.nav = null;
      ag.walkPlan = null;
    }
  }

  /** 走在路上的决策：到了计划里的时刻做点出格的事；否则等到走完。 */
  private walkingTurn(ag: Ag, conn: Conn, v: MeView, nav: NonNullable<MeView['location']['navigation']>): number {
    const now = this.clock.t;
    const rnd = ag.rnd;
    // 页面重新读了视图：手里没有这条导航就接过来（不守规矩的客户端除外：它是故意不续的）
    if (!ag.nav && ag.renewsLeft === null) ag.nav = trackNav(conn, nav, now, rnd.range(0, 400));
    const plan = ag.walkPlan;
    if (plan && plan.at <= now) {
      ag.walkPlan = null;
      switch (plan.kind) {
        case 'reroute': {
          this.bump('walk_reroute');
          const d = this.moveTo(ag, conn, this.wanderTarget(ag, v), 'to');
          return d ?? 2000;
        }
        case 'halt': {
          this.bump('walk_halt');
          const o = this.exec(ag, conn, 'stop_navigation');
          ag.nav = null;
          if (o.ok) {
            const at = (o.out as { at?: { space: string } }).at;
            this.rejectChecks.run++;
            if (!at || at.space !== this.w.mustResident(ag.p.residentId).location_id) {
              this.rejectChecks.failed++;
              this.inv.fail('stop_nav_receipt', 'stop_navigation 回执里的区域与居民当前区域不符', { at }, now);
            }
          }
          return rnd.range(2, 6) * 1000;
        }
        case 'ghost': {
          this.bump('walk_ghost');
          ag.sessionEnd = now;
          ag.endMode = rnd.chance(0.5) ? 'leave' : 'drop';
          return 1000;
        }
        case 'chat': {
          this.bump('walk_chat');
          if (now - ag.lastSpeak >= 12_000) {
            ag.lastSpeak = now;
            this.exec(ag, conn, 'speak', { text: this.chatText(ag) });
          }
          break;
        }
      }
    }
    return Math.max(1000, nav.arriveAt - now + rnd.range(0, 3000));
  }

  /** 随便走去哪：地点 / 物件旁边 / 地图上的一个点 / 某个人身边 / 回家。 */
  private wanderTarget(ag: Ag, v: MeView): string | { x: number; z: number } {
    const rnd = ag.rnd;
    const space = v.location.space ?? '';
    const atHome = space === `home:${v.me.id}`;
    const kind = rnd.weighted<'place' | 'object' | 'point' | 'person'>([['place', 6], ['object', 3], ['point', 1.5], ['person', 1]])!;
    if (kind === 'object') return rnd.pick(PUBLIC_OBJECTS).id;
    if (kind === 'point') {
      const town = this.w.map.scenes.get(this.w.map.spawn.scene)!;
      return { x: town.originX + rnd.float() * town.cols * town.cell, z: town.originZ + rnd.float() * town.rows * town.cell };
    }
    if (kind === 'person') {
      const others = this.w.db.all("SELECT resident_id FROM residents WHERE present_since IS NOT NULL AND resident_id <> ? AND location_id = ?", v.me.id, space);
      if (others.length > 0) return String(rnd.pick(others).resident_id);
    }
    return rnd.pick(['plaza', 'tea_house', 'bookshop', 'kitchen', 'garden', 'arcade', 'residential', 'home'].filter((d) => d !== space && !(d === 'home' && atHome)));
  }

  private intent(ag: Ag, conn: Conn, v: MeView, intent: string, c: { lm: number; openEvent: MeView['events'][number] | undefined; residentsHere: NonNullable<MeView['here']>['residents']; atHome: boolean; space: string }): number | null {
    const rnd = ag.rnd;
    const now = this.clock.t;
    const here = v.here;
    const me = v.me.id;
    const inv = v.inventory;
    const avail = (type: string) => inv.items.filter((i) => i.type === type && !i.borrowedFrom).reduce((s, i) => s + i.available, 0);
    const short = () => rnd.range(8, 40) * 1000;
    switch (intent) {
      case 'mail': {
        if (!c.atHome) return this.moveTo(ag, conn, 'home');
        const ids = this.w.db.all('SELECT letter_id FROM letters WHERE recipient_id = ? AND delivered_at IS NOT NULL AND read_at IS NULL AND recipient_deleted_at IS NULL ORDER BY deliver_at LIMIT 3', me);
        if (ids.length === 0) return null;
        for (const l of ids) this.exec(ag, conn, 'read_letter', { letterId: l.letter_id });
        // 偶尔重读已读的信（在哪都行）、删信
        const old = this.w.db.get('SELECT letter_id FROM letters WHERE recipient_id = ? AND read_at IS NOT NULL AND recipient_deleted_at IS NULL ORDER BY RANDOM() LIMIT 1', me);
        if (old && rnd.chance(0.3)) this.exec(ag, conn, rnd.chance(0.5) ? 'delete_letter' : 'read_letter', { letterId: old.letter_id });
        return short();
      }
      case 'visit': {
        const inv0 = rnd.pick(v.invites.received);
        return this.moveTo(ag, conn, inv0.home);
      }
      case 'revoke': {
        const g = rnd.pick(v.invites.sent);
        this.exec(ag, conn, 'revoke_invite', { grantId: g.grantId });
        return short();
      }
      case 'speak': {
        if (now - ag.lastSpeak < 12_000) return null;
        ag.lastSpeak = now;
        this.exec(ag, conn, 'speak', { text: this.chatText(ag) });
        return short();
      }
      case 'ask': {
        const t = rnd.pick(c.residentsHere);
        this.exec(ag, conn, 'ask_hobby', { target: t.id });
        return short();
      }
      case 'buy': {
        const goods: { shop: string; sku: string; price: number; stock: number }[] = [];
        for (const s of here!.shops) for (const g of s.goods) if (g.stock > 0 && g.price <= inv.coins.available) goods.push({ shop: s.id, sku: g.sku, price: g.price, stock: g.stock });
        if (goods.length === 0) return null;
        // 偏好便宜的消耗品；书和家具偶尔买
        const g = rnd.weighted(goods.map((x) => [x, x.price >= 6 ? 0.6 : 2] as const))!;
        const qty = rnd.chance(0.8) ? 1 : rnd.range(2, 3);
        const day = this.w.today(now);
        const o = this.exec(ag, conn, 'buy', { shop: g.shop, sku: g.sku, qty });
        if (o.ok) {
          if (g.sku.startsWith('book:')) this.purchases.book += qty;
          else if (g.sku === 'planter_box') this.purchases.planter_box += qty;
          else if (g.sku === 'stove_kit') this.purchases.stove_kit += qty;
          const key = `${g.shop}|${g.sku}|${day}`;
          const total = (this.buyPerDay.get(key) ?? 0) + qty;
          this.buyPerDay.set(key, total);
          const cap = DAILY_STOCK[g.sku];
          if (cap !== undefined && total > cap) this.inv.fail('stock_cap', `${g.sku} 当天售出 ${total} 件，超过日库存 ${cap}`, { day }, now);
        }
        return short();
      }
      case 'use': {
        const type = avail('soup') > 0 ? 'soup' : 'cookie';
        this.exec(ag, conn, 'use_item', { itemType: type });
        return short();
      }
      case 'decor': {
        const furn = inv.items.find((i) => (i.type === 'planter_box' || i.type === 'stove_kit') && i.available > 0 && !i.borrowedFrom);
        if (furn && rnd.chance(0.7)) {
          this.exec(ag, conn, 'place_furniture', { itemId: furn.itemId });
          return short();
        }
        const decor = inv.items.find((i) => i.category === 'decor' && i.available > 0);
        if (decor && rnd.chance(0.7)) {
          this.exec(ag, conn, 'display_item', { itemType: decor.type, qty: 1, on: true });
          return short();
        }
        const shelved = inv.items.find((i) => i.shelved > 0);
        if (shelved && rnd.chance(0.4)) {
          this.exec(ag, conn, 'display_item', shelved.category === 'decor' ? { itemType: shelved.type, qty: 1, on: false } : { itemId: shelved.itemId, on: false });
          return short();
        }
        const book = inv.items.find((i) => i.type === 'book' && !i.borrowedFrom && i.available > 0);
        if (book && rnd.chance(0.3)) {
          this.exec(ag, conn, 'display_item', { itemId: book.itemId, on: rnd.chance(0.6) });
          return short();
        }
        return null;
      }
      case 'offer': {
        const target = rnd.pick(c.residentsHere);
        const kind = rnd.weighted<'gift' | 'trade' | 'loan'>([['gift', 5], ['trade', 3], ['loan', 2]])!;
        const mine = inv.items.filter((i) => TRADABLE.includes(i.type as never) && i.available > 0 && !i.borrowedFrom);
        if (kind === 'loan') {
          const book = inv.items.find((i) => i.type === 'book' && !i.borrowedFrom && i.available > 0);
          if (!book) return null;
          this.exec(ag, conn, 'offer', { kind, to: target.id, give: { items: [{ itemId: book.itemId }] } });
        } else if (kind === 'gift') {
          if (rnd.chance(0.25) && inv.coins.available > 3) this.exec(ag, conn, 'offer', { kind, to: target.id, give: { coins: rnd.range(1, 3) } });
          else if (mine.length > 0) this.exec(ag, conn, 'offer', { kind, to: target.id, give: { items: [{ type: rnd.pick(mine).type, qty: 1 }] } });
          else return null;
        } else {
          if (mine.length === 0) return null;
          const give = rnd.pick(mine).type;
          const want = rnd.pick(TRADABLE.filter((t) => t !== give));
          this.exec(ag, conn, 'offer', { kind, to: target.id, give: { items: [{ type: give, qty: 1 }] }, want: rnd.chance(0.2) ? { coins: 1 } : { items: [{ type: want, qty: 1 }] } });
        }
        return short();
      }
      case 'book': {
        const lib = here?.library?.filter((b) => b.available > 0) ?? [];
        if (lib.length > 0 && rnd.chance(0.7)) {
          this.exec(ag, conn, 'borrow_book', { bookId: rnd.pick(lib).bookId });
          return short();
        }
        return null;
      }
      case 'return': {
        const borrowed = inv.items.filter((i) => i.borrowedFrom);
        const item = rnd.pick(borrowed);
        const loan = this.w.db.get("SELECT owner_id FROM loans WHERE item_id = ? AND status = 'active'", item.itemId);
        if (!loan) return null;
        if (loan.owner_id === 'town') {
          if (c.space === 'bookshop') {
            this.exec(ag, conn, 'return_item', { itemId: item.itemId });
            return short();
          }
          return this.moveTo(ag, conn, 'bookshop');
        }
        const owner = this.w.resident(loan.owner_id);
        if (!owner) return null;
        if (c.residentsHere.some((x) => x.id === owner.resident_id) || c.space === 'residential') {
          this.exec(ag, conn, 'return_item', { itemId: item.itemId });
          return short();
        }
        // 去主人所在的地方（走到他身边），或者会馆门口的归还箱
        if (!owner.location_id.startsWith('home:') && owner.location_id === c.space) return this.moveTo(ag, conn, owner.resident_id, 'approach');
        return this.moveTo(ag, conn, rnd.chance(0.5) || owner.location_id.startsWith('home:') ? 'residential' : owner.location_id);
      }
      case 'letter': {
        const others = this.ags.filter((a) => a.registered && a.p.idx !== ag.p.idx);
        if (others.length === 0) return null;
        const to = rnd.pick(others).p.residentId;
        const body = `${rnd.pick(PHRASES)}。暗号L${String(++this.letterSeq).padStart(6, '0')}X`;
        this.exec(ag, conn, 'send_letter', { to, body, ...(rnd.chance(0.3) ? { invite: { reentry: rnd.chance(0.5) } } : {}) });
        return short();
      }
      case 'invite': {
        const t = rnd.pick(c.residentsHere);
        this.exec(ag, conn, 'invite', { to: t.id, reentry: rnd.chance(0.5) });
        return short();
      }
      case 'interact': return this.interact(ag, conn, v, c);
      case 'game': return this.gameIntent(ag, conn, v, c);
      case 'rest': {
        if (!c.atHome) return this.moveTo(ag, conn, 'home');
        return this.interact(ag, conn, v, c, 'rest');
      }
      case 'event': {
        const ev = c.openEvent!;
        if (c.space !== ev.place) return this.moveTo(ag, conn, ev.place);
        return this.interact(ag, conn, v, c);
      }
      case 'goal': {
        const g = v.goals.find((x) => x.kind === 'short');
        if (!g) return null;
        this.exec(ag, conn, 'replace_goal', { goalId: g.id });
        return short();
      }
      case 'profile': {
        this.exec(ag, conn, 'update_profile', { bio: `我是${ag.p.name}，第${ag.sessionNo}次来。`, showMood: rnd.chance(0.8), allowAskHobby: rnd.chance(0.9), ...(ag.p.kind === 'human' && rnd.chance(0.3) ? { mood: rnd.pick(['悠闲', '期待', null]) } : {}) });
        return short();
      }
      case 'wander': {
        const to = this.wanderTarget(ag, v);
        return this.moveTo(ag, conn, to, 'to');
      }
    }
    void me;
    void inv;
    void here;
    void avail;
    return null;
  }

  private interact(ag: Ag, conn: Conn, v: MeView, c: { space: string; atHome: boolean }, only?: string): number | null {
    const rnd = ag.rnd;
    const now = this.clock.t;
    const here = v.here;
    if (!here || v.interaction) return null;
    const inv = v.inventory;
    const qty = (type: string) => inv.items.filter((i) => i.type === type && !i.borrowedFrom).reduce((s, i) => s + i.available, 0);
    // 先看有没有开放中、能加入的
    for (const o of here.objects) {
      if (o.active && o.active.status === 'open' && o.active.initiator.id !== v.me.id && o.active.participants.length < o.active.max && (!only || o.action?.def === only) && rnd.chance(0.7)) {
        // 公共物件要先走到旁边（够不着会 too_far）
        if (!o.near) {
          ag.useObject = null;
          this.bump('walk_to_join');
          return this.moveTo(ag, conn, o.id);
        }
        this.exec(ag, conn, 'join_interaction', { interactionId: o.active.id });
        return rnd.range(8, 25) * 1000;
      }
    }
    const free = here.objects.filter((o) => o.action && !o.active && (!only || o.action.def === only));
    const ok = free.filter((o) => {
      switch (o.action!.def) {
        case 'share_tea': return qty('tea_leaves') >= 1 || (c.space === 'tea_house' && v.events.some((e) => e.def === 'tea_party' && e.status === 'open'));
        case 'cook_soup': return qty('vegetables') >= 2;
        case 'tend_plants': return qty('seeds') >= 1;
        case 'rest': return c.atHome;
        case 'read': return true;
        default: return false;
      }
    });
    if (ok.length === 0) return null;
    // 走到旁边之后接着用刚才选好的那件
    const wanted = ag.useObject ? ok.find((x) => x.id === ag.useObject) : undefined;
    ag.useObject = null;
    const o = wanted ?? rnd.pick(ok);
    if (!o.near) {
      ag.useObject = o.id;
      this.bump('walk_to_use');
      return this.moveTo(ag, conn, o.id);
    }
    const fields: Record<string, unknown> = { objectId: o.id };
    if (o.action!.min > 1 || rnd.chance(0.3)) fields.wait = true;
    if (o.action!.def === 'read' && rnd.chance(0.5)) {
      const book = inv.items.find((i) => i.type === 'book');
      if (book) fields.itemId = book.itemId;
    }
    const out = this.exec(ag, conn, 'start_interaction', fields);
    if (!out.ok) return null;
    const ix = out.out.interaction as { status: string; endsAt: number | null };
    if (ix.status === 'running') return Math.max(3000, (ix.endsAt ?? now) - now + rnd.range(0, 5000));
    return rnd.range(8, 20) * 1000;
  }

  private gameIntent(ag: Ag, conn: Conn, v: MeView, c: { space: string }): number | null {
    const rnd = ag.rnd;
    const now = this.clock.t;
    const here = v.here;
    const me = v.me.id;
    const venues: Record<string, string[]> = { arcade: ['number_bomb', 'sealed_auction', 'liars_dice'], plaza: ['number_bomb'], tea_house: ['liars_dice'] };
    if (!here || here.games.length === 0) {
      const dest = rnd.weighted<string>([['arcade', 7], ['plaza', 1], ['tea_house', 1]])!;
      if (dest === c.space) return null;
      return this.moveTo(ag, conn, dest);
    }
    void venues;
    const mine = here.activities.find((a) => a.players.some((p) => p.id === me));
    if (mine) {
      if (mine.status === 'forming' && mine.host.id === me) {
        const created = mine.lobbyExpiresAt - this.w.params.activityLobbyTtlMs;
        const full = mine.players.length >= mine.max;
        if (mine.players.length >= mine.min && (full || now - created > rnd.range(40, 150) * 1000 || rnd.chance(0.2))) {
          this.exec(ag, conn, 'start_game', { activityId: mine.id });
          return rnd.range(3, 8) * 1000;
        }
        return rnd.range(8, 20) * 1000;
      }
      if (mine.status === 'forming' && rnd.chance(0.04)) {
        this.exec(ag, conn, 'leave_game_lobby');
        return 5000;
      }
      return rnd.range(8, 20) * 1000;
    }
    const open = here.activities.filter((a) => a.status === 'forming' && a.players.length < a.max);
    if (open.length > 0 && rnd.chance(0.8)) {
      this.exec(ag, conn, 'join_game', { activityId: rnd.pick(open).id });
      return rnd.range(5, 15) * 1000;
    }
    // 自己凑一桌：优先玩得最少的那种（三种都要打到）
    const offered = here.games.filter((g) => g.type !== 'sealed_auction' || here.residents.length + 1 >= g.min);
    if (offered.length === 0) return null;
    offered.sort((a, b) => (this.gameStarted.get(a.type) ?? 0) - (this.gameStarted.get(b.type) ?? 0));
    const least = offered.filter((g) => (this.gameStarted.get(g.type) ?? 0) === (this.gameStarted.get(offered[0]!.type) ?? 0));
    const g = rnd.pick(least);
    const out = this.exec(ag, conn, 'propose_game', { game: g.type });
    if (out.ok) this.bump(`propose_${g.type}`);
    return rnd.range(8, 20) * 1000;
  }

  // ───── 故意发错的请求 ─────

  private negativeTest(ag: Ag, conn: Conn, v: MeView): void {
    const rnd = ag.rnd;
    const now = this.clock.t;
    const r = this.w.mustResident(ag.p.residentId);
    const kinds = ['replay', 'conflict', 'stale_ctx', 'expired_window', 'bad_window', 'unknown_action', 'bad_request_id', 'illegal_params', 'wrong_epoch', 'burst'];
    if (v.game) kinds.push('phase_stale', 'non_game_in_game');
    else kinds.push('game_act_outside');
    const kind = rnd.pick(kinds);
    const nf = { neg: ['x'] };
    switch (kind) {
      case 'replay': {
        const e = ag.ring.length ? rnd.pick(ag.ring) : null;
        if (!e) return;
        const age = now - e.at;
        if (age > 7 * DAY - HOUR) return;
        const fp = this.fingerprint(ag.p.residentId);
        const o = runCommand(this.w, e.conn.auth, e.req);
        this.stats.record('replay', o);
        this.rejectChecks.run++;
        this.negCount.set('重放同一请求', (this.negCount.get('重放同一请求') ?? 0) + 1);
        const same = o.ok && o.out.replayed === true && JSON.stringify({ ...o.out, replayed: undefined }) === JSON.stringify(e.out);
        if (!same) {
          this.rejectChecks.failed++;
          const msg = `重放：期望原样返回回执（replayed）；实际 ${o.ok ? JSON.stringify(o.out).slice(0, 150) : o.code + '/' + o.reason}`;
          if (this.rejectChecks.samples.length < 10) this.rejectChecks.samples.push(msg);
          this.inv.fail('replay_same_receipt', msg, { type: e.req.action.type }, now);
        }
        if (this.fingerprint(ag.p.residentId) !== fp) this.rejectEffect('replay', e.req.action, 'replayed');
        return;
      }
      case 'conflict': {
        const e = ag.ring.length ? rnd.pick(ag.ring) : null;
        if (!e || now - e.at > 6 * DAY) return;
        const o = this.exec(ag, e.conn, 'speak', { text: 'x' + this.chatText(ag) }, { requestId: e.req.requestId, ...nf });
        this.expectReject(ag, '同一请求号换内容', o, ['request_conflict']);
        return;
      }
      case 'stale_ctx': {
        const o = this.exec(ag, conn, 'speak', { text: this.chatText(ag) }, { expected: { contextVersion: r.context_version - 1, controlEpoch: r.control_epoch, activityId: r.activity_id }, ...nf });
        this.expectReject(ag, '过期的上下文版本', o, ['context_stale']);
        return;
      }
      case 'expired_window': {
        const old = this.w.issueActionWindow(ag.p.residentId, now - 25 * HOUR);
        const o = this.exec(ag, conn, 'speak', { text: this.chatText(ag) }, { window: old, ...nf });
        this.expectReject(ag, '超过 24 小时的动作窗口', o, ['request_expired']);
        // 窗口在 24 小时内（哪怕很旧）仍然有效
        const okW = this.w.issueActionWindow(ag.p.residentId, now - 23 * HOUR);
        const ok = this.exec(ag, conn, 'update_profile', { bio: `旧窗口${ag.sessionNo}` }, { window: okW });
        this.rejectChecks.run++;
        if (!ok.ok && ok.code === 'request_expired') {
          this.rejectChecks.failed++;
          this.inv.fail('window_valid_23h', '23 小时前签发的动作窗口被当成过期', null, now);
        }
        return;
      }
      case 'bad_window': {
        const forged = rnd.pick(['aw.zz.zz', 'garbage', '', this.w.issueActionWindow(rnd.pick(this.ags).p.residentId || 'nobody', now)]);
        const other = forged.startsWith('aw.') && forged !== 'aw.zz.zz';
        const o = this.exec(ag, conn, 'speak', { text: this.chatText(ag) }, { window: forged, ...nf });
        // 别人的有效窗口只有在恰好是自己的时才算有效（极小概率）
        if (other && forged === this.w.issueActionWindow(ag.p.residentId, now)) return;
        this.expectReject(ag, '伪造 / 别人的动作窗口', o, ['request_expired']);
        return;
      }
      case 'unknown_action': {
        const o = this.exec(ag, conn, rnd.pick(['teleport', 'mint_coins', 'set_balance', '']), { amount: 999 }, nf);
        this.expectReject(ag, '不认识的动作类型', o, ['bad_request']);
        return;
      }
      case 'bad_request_id': {
        const o = this.exec(ag, conn, 'speak', { text: 'hi' }, { requestId: rnd.pick(['x', 'short', 'has space in it', 'a'.repeat(100)]), ...nf });
        this.expectReject(ag, '格式不对的请求号', o, ['bad_request']);
        return;
      }
      case 'illegal_params': {
        const others = this.w.db.get("SELECT offer_id FROM offers WHERE to_id <> ? AND from_id <> ? AND status = 'open' LIMIT 1", ag.p.residentId, ag.p.residentId);
        const cases: [string, Record<string, unknown>, string[]][] = [
          ['navigate', { to: 'the_moon' }, ['precondition_failed']],
          ['move', { to: 'home:nobody' }, ['precondition_failed']],
          ['navigate', { to: { x: 'a', z: 1 } }, ['precondition_failed']],
          ['navigate', { to: { x: 1e9, z: 1e9 } }, ['precondition_failed']],
          ['navigate', { approach: 'r_nobody' }, ['precondition_failed']],
          ['buy', { shop: 'stall', sku: 'cookie', qty: 99 }, ['bad_request', 'precondition_failed']],
          ['buy', { shop: 'nowhere', sku: 'x' }, ['bad_request', 'precondition_failed']],
          ['accept_offer', { offerId: 'f_nonexistent' }, ['not_available']],
          ['read_letter', { letterId: 'm_nonexistent' }, ['precondition_failed']],
          ['revoke_invite', { grantId: 'h_nonexistent' }, ['precondition_failed']],
          ['return_item', { itemId: 'i_nonexistent' }, ['precondition_failed']],
          ['offer', { kind: 'gift', to: ag.p.residentId, give: { coins: 1 } }, ['precondition_failed']],
          ['offer', { kind: 'steal', to: 'x', give: {} }, ['bad_request']],
          ['use_item', { itemType: 'book' }, ['precondition_failed', 'bad_request']],
          ['send_letter', { to: ag.p.residentId, body: 'self' }, ['precondition_failed']],
          ['send_letter', { to: 'r_nobody', body: 'x' }, ['precondition_failed']],
          ['start_game', { activityId: 'a_nonexistent' }, ['precondition_failed', 'context_stale']],
          ['speak', { text: '' }, ['bad_request', 'precondition_failed']],
          ['place_furniture', { itemId: 'i_nonexistent' }, ['precondition_failed']],
          ['replace_goal', { goalId: 'g_nonexistent' }, ['precondition_failed']],
        ];
        if (others) cases.push(['accept_offer', { offerId: others.offer_id }, ['not_available']], ['cancel_offer', { offerId: others.offer_id }, ['not_available']], ['decline_offer', { offerId: others.offer_id }, ['not_available']]);
        const [type, fields, codes] = rnd.pick(cases);
        const inGame = Boolean(v.game);
        const o = this.exec(ag, conn, type, fields, nf);
        this.expectReject(ag, `非法参数（${type}）`, o, inGame ? [...codes, 'precondition_failed'] : codes, fields);
        return;
      }
      case 'wrong_epoch': {
        const o = this.exec(ag, conn, 'speak', { text: this.chatText(ag) }, { expected: { contextVersion: r.context_version, controlEpoch: r.control_epoch + 1, activityId: r.activity_id }, ...nf });
        this.expectReject(ag, '错误的控制代数', o, ['control_lost']);
        return;
      }
      case 'burst': {
        if (v.game || v.location.navigation) return;
        const outs: Outcome[] = [];
        for (let i = 0; i < 8; i++) outs.push(this.exec(ag, conn, 'speak', { text: this.chatText(ag) }, { neg: ['x'] }));
        ag.lastSpeak = now;
        this.rejectChecks.run++;
        this.negCount.set('聊天突发限流', (this.negCount.get('聊天突发限流') ?? 0) + 1);
        const limited = outs.filter((o) => !o.ok && o.code === 'rate_limited');
        const okN = outs.filter((o) => o.ok).length;
        if (limited.length === 0 || okN > this.w.params.chatBurst + 1) {
          this.rejectChecks.failed++;
          this.inv.fail('rate_limit', `连发 8 条聊天：成功 ${okN} 条、限流 ${limited.length} 条，令牌桶没起作用（突发上限 ${this.w.params.chatBurst}）`, null, now);
        } else if (limited.some((o) => !(o as { data?: { retryAfterMs?: number } }).data?.retryAfterMs)) {
          this.rejectChecks.failed++;
          this.inv.fail('rate_limit', '限流错误没带 retryAfterMs', null, now);
        }
        return;
      }
      case 'phase_stale': {
        const g = v.game!;
        const o = this.exec(ag, conn, 'game_act', { phaseId: (g.phase_id ?? 0) + 100, input: { action: 'guess', number: 1 } }, nf);
        this.expectReject(ag, '上一阶段迟到的小游戏动作', o, ['phase_stale', 'context_stale']);
        return;
      }
      case 'non_game_in_game': {
        const o = this.exec(ag, conn, rnd.pick(['navigate', 'move', 'speak', 'buy']), { to: 'plaza', text: 'hi', shop: 'stall', sku: 'cookie' }, nf);
        this.expectReject(ag, '在小游戏里做世界动作', o, ['precondition_failed']);
        return;
      }
      case 'game_act_outside': {
        const o = this.exec(ag, conn, 'game_act', { phaseId: 1, input: { action: 'guess', number: 1 } }, nf);
        this.expectReject(ag, '不在小游戏里发局内动作', o, ['context_stale']);
        return;
      }
    }
  }
}

/** 商店日库存（和 content.ts 对账用）。 */
const DAILY_STOCK: Record<string, number> = { cookie: 20, lantern: 6, paper_lamp: 10, tea_leaves: 30, vegetables: 30, stove_kit: 3, seeds: 30, planter_box: 3 };
for (const b of ['rain_lane', 'bread_stars', 'gardener_notes', 'polite_dice', 'slow_fire', 'twelve_letters']) DAILY_STOCK[`book:${b}`] = 1;

// ───────────────────────── 前置场景 ─────────────────────────

/** 几个不依赖作息的小场景：在场上限、重复注册、票据一次性。 */
function scenarioChecks(inv: Invariants): { name: string; ok: boolean; note: string }[] {
  const out: { name: string; ok: boolean; note: string }[] = [];
  const clock = new Clock(TOWN_START);
  const w = openWorld({ dbPath: ':memory:', clock, seed: `scn${SEED}`, params: { activeResidentLimit: 3 } });
  const people: { p: Person; c: Conn }[] = [];
  for (let i = 0; i < 5; i++) {
    const kind: Kind = i % 2 ? 'human' : 'agent';
    const p: Person = { idx: i, name: personName(i), kind, principalId: makePrincipal(w, i, kind, personName(i)), residentId: '' };
    people.push({ p, c: new Conn(w, p, `${kind === 'agent' ? 'mcp' : 'web'}:scn-${i}`, kind === 'agent' ? 'mcp' : 'web') });
  }
  const rnd = new Rand(`scn:${SEED}`);
  for (let i = 0; i < 3; i++) people[i]!.p.residentId = people[i]!.c.enter(randomProfile(rnd, people[i]!.p.name)).residentId;
  let full = '';
  try {
    people[3]!.c.enter(randomProfile(rnd, people[3]!.p.name));
    full = '第 4 位竟然进去了';
  } catch (e) {
    full = e instanceof WorldError && e.reason === 'world_full' ? '' : `错误码不对：${String(e)}`;
  }
  const countAfterFull = w.db.scalar('SELECT COUNT(*) FROM residents');
  out.push({ name: '在场人数上限（world_full）', ok: full === '' && countAfterFull === 3, note: full || `被拒绝，没有留下半个居民（居民数 ${countAfterFull}）` });
  const pub = townPublicView(w);
  out.push({ name: '满员时公开地图照常可看', ok: pub.counts.present === 3 && pub.counts.capacity === 3, note: `在场 ${pub.counts.present}/${pub.counts.capacity}` });
  people[0]!.c.leave();
  let again = '';
  try {
    people[3]!.p.residentId = people[3]!.c.enter(randomProfile(rnd, people[3]!.p.name)).residentId;
  } catch (e) {
    again = String(e);
  }
  out.push({ name: '有人离开后可以进入', ok: again === '', note: again || '第 4 位进入成功' });
  const e0 = people[1]!.c.enter();
  const c2 = new Conn(w, people[1]!.p, 'web:scn-1-b', 'web');
  const e1 = c2.enter();
  out.push({ name: '重复进入返回同一居民', ok: e0.residentId === e1.residentId && !e1.created && w.db.scalar('SELECT COUNT(*) FROM residents') === 4, note: `${e0.residentId}` });
  let dup = '';
  try {
    const p5 = { idx: 9, name: people[1]!.p.name, kind: 'agent' as Kind, principalId: makePrincipal(w, 9, 'agent', 'dup'), residentId: '' };
    new Conn(w, p5, 'mcp:scn-9', 'mcp').enter({ name: people[1]!.p.name });
    dup = '重名居然通过了';
  } catch (e) {
    dup = e instanceof WorldError && e.reason === 'name_taken' ? '' : String(e);
  }
  out.push({ name: '重名被拒绝（name_taken）', ok: dup === '', note: dup || '已拒绝' });
  const t = issueTicket(w, { provider: 'qq', subject: '77777', name: '票据测试' });
  exchangeTicket(w, t.ticket);
  let reuse = '';
  try {
    exchangeTicket(w, t.ticket);
    reuse = '票据被重复兑换';
  } catch (e) {
    reuse = e instanceof WorldError && e.code === 'unauthenticated' ? '' : String(e);
  }
  out.push({ name: '登录票据只能兑换一次', ok: reuse === '', note: reuse || '第二次兑换被拒绝' });
  clock.t += 6 * MIN;
  w.tick();
  let expired = '';
  try {
    const t2 = issueTicket(w, { provider: 'qq', subject: '77778', name: '过期测试' });
    clock.t += 6 * MIN;
    exchangeTicket(w, t2.ticket);
    expired = '过期票据被兑换';
  } catch (e) {
    expired = e instanceof WorldError ? '' : String(e);
  }
  out.push({ name: '登录票据过期后不可兑换', ok: expired === '', note: expired || '已拒绝' });
  w.tick();
  inv.check(w, { now: clock.t, expectedResidents: 4 });
  w.close();
  return out;
}

// ───────────────────────── 主流程 ─────────────────────────

const sim = new Sim();
const scenarios = scenarioChecks(sim.inv);
sim.init();
console.log(`栖灯镇逻辑模拟：${DAYS} 天、${N} 位居民、种子 ${SEED}、${FILE_MODE ? `文件库 ${DB_PATH}` : '内存库'}、停机重启 ${RESTARTS} 次、不变量每 ${CHECK_EVERY / MIN} 分钟一轮`);
const wall0 = performance.now();
try {
  sim.run();
} catch (e) {
  console.error('\n模拟中断：', e);
  sim.inv.fail('sim_crash', `模拟器自身抛出未捕获异常：${e instanceof Error ? e.message : String(e)}`, e instanceof Error ? e.stack : String(e), sim.clock.t);
}
const wallMs = performance.now() - wall0;

// ───────────────────────── 汇总 ─────────────────────────

const w = sim.w;
const db = w.db;
const logical = sim.clock.t - TOWN_START;
const tableCounts = (sql: string) => Object.fromEntries(db.all(sql).map((r) => [String(Object.values(r)[0]), Number(Object.values(r)[1])]));
const interactions = db.all('SELECT def_id, status, COUNT(*) n FROM interactions GROUP BY def_id, status');
const interDone: Record<string, number> = {};
const interCancel: Record<string, number> = {};
for (const r of interactions) (r.status === 'completed' ? interDone : r.status === 'cancelled' ? interCancel : {})[r.def_id as string] = Number(r.n);
const games = db.all('SELECT game_type, status, COUNT(*) n FROM activities WHERE game_id IS NOT NULL GROUP BY game_type, status');
const gameByType: Record<string, Record<string, number>> = {};
for (const r of games) (gameByType[r.game_type] ??= {})[r.status] = Number(r.n);
const lobbies = tableCounts("SELECT status, COUNT(*) FROM activities WHERE game_id IS NULL GROUP BY status");
const offers = tableCounts('SELECT status, COUNT(*) FROM offers GROUP BY status');
const letters = db.get('SELECT COUNT(*) total, SUM(read_at IS NOT NULL) read FROM letters')!;
const goals = tableCounts('SELECT status, COUNT(*) FROM resident_goals GROUP BY status');
const loans = tableCounts('SELECT status, COUNT(*) FROM loans GROUP BY status');
const grants = db.get('SELECT COUNT(*) total, SUM(revoked_at IS NOT NULL) revoked FROM home_access_grants')!;
const jobsByStatus = tableCounts('SELECT status, COUNT(*) FROM scheduled_jobs GROUP BY status');
const events = tableCounts('SELECT status, COUNT(*) FROM public_event_instances GROUP BY status');
const m = w.metricsSnapshot();
const agentSz = summarize(sim.sizes.agent.concat(sim.inv.agentViewBytes));
const meSz = summarize(sim.sizes.me.concat(sim.inv.meViewBytes));
const pubSz = summarize(sim.inv.publicViewBytes);
const gameSz = summarize(sim.inv.gameViewBytes);
const lastDb = sim.daily[sim.daily.length - 1];
const fileBytes = FILE_MODE ? statSync(DB_PATH).size : 0;

// 可复现摘要：与随机 id 无关的统计 + 数据库聚合
const accounts = db.all("SELECT balance FROM accounts WHERE kind = 'resident' ORDER BY resident_id").map((r) => Number(r.balance));
const digestSrc = JSON.stringify({
  seed: SEED,
  cmds: [...sim.stats.byType].sort(([a], [b]) => a.localeCompare(b)),
  errs: [...sim.stats.reasons].sort(([a], [b]) => a.localeCompare(b)),
  counters: [...sim.counters].filter(([k]) => k !== 'check_ms').sort(([a], [b]) => a.localeCompare(b)),
  tables: lastDb?.tables,
  interDone,
  gameByType,
  coins: accounts,
  mint: db.scalar("SELECT balance FROM accounts WHERE account_id='sys:mint'"),
  sink: db.scalar("SELECT balance FROM accounts WHERE account_id='sys:sink'"),
  logical,
});
const digest = sha(digestSrc).slice(0, 16);

console.log('\n================ 栖灯镇逻辑模拟报告 ================');
console.log(`逻辑时长：${fmtDuration(logical)}（${(logical / DAY).toFixed(2)} 天）；实际耗时 ${fmtDuration(wallMs)}（加速 ${(logical / wallMs).toFixed(0)}×）；模拟循环 ${sim.steps} 步`);
console.log(`居民：${N}（会话 ${sim.counters.get('sessions') ?? 0} 次；峰值同时在场 ${sim.presentMax}；上限 ${LIMIT}；world_full 拒绝 ${sim.counters.get('world_full') ?? 0} 次）`);

console.log('\n── 前置场景 ──');
for (const s of scenarios) console.log(`${s.ok ? '通过' : '失败'}  ${s.name}：${s.note}`);

console.log('\n── 命令 ──');
console.log(`总数 ${sim.stats.total}：成功 ${sim.stats.ok}（其中重放 ${sim.stats.replayed}），被拒绝 ${sim.stats.total - sim.stats.ok}；内部异常 ${sim.internalCount}`);
const errRows = [...sim.stats.err].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]);
console.log(table([['错误码', '次数'], ...errRows]));
const reasonRows = [...sim.stats.reasons].filter(([k]) => k.startsWith('precondition_failed/')).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, String(v)]);
console.log('\n拒绝原因 Top（precondition_failed 细分）：');
console.log(table([['原因', '次数'], ...reasonRows]));
const typeRows = [...sim.stats.byType].sort((a, b) => b[1].ok + b[1].err - (a[1].ok + a[1].err)).map(([k, v]) => [k, String(v.ok), String(v.err)]);
console.log('\n正常流程里被拒绝的动作 × 原因（Top 16，非故意发错）：');
console.log(table([['动作/原因', '次数'], ...[...sim.failBy].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => [k, String(v)])]));
console.log('\n各类动作（成功 / 被拒绝）：');
console.log(table([['动作', '成功', '被拒绝'], ...typeRows]));
if (sim.anomalies.size > 0) {
  console.log('\n驱动期望外的拒绝（正常流程里不该出现，需要逐条看是驱动问题还是引擎问题）：');
  for (const a of sim.anomalies.values()) console.log(`  ${a.kind} × ${a.count}  样例 ${JSON.stringify(a.sample).slice(0, 240)}`);
}

console.log('\n── 事件 ──');
console.log(`共同活动完成 ${JSON.stringify(interDone)}；取消 ${JSON.stringify(interCancel)}`);
console.log(
  `小游戏（已开局）：${Object.entries(gameByType).map(([t, s]) => `${t} 完成 ${s.completed ?? 0} / 中止 ${s.aborted ?? 0} / 进行中 ${s.running ?? 0}`).join('；') || '（无）'}；最高并发 ${sim.concurrentGamesMax}；凑桌结局 ${JSON.stringify(lobbies)}`,
);
console.log(`报价 ${JSON.stringify(offers)}；借还 ${JSON.stringify(loans)}；信件 ${letters.total}（已读 ${letters.read ?? 0}）；邀请 ${grants.total}（撤销 ${grants.revoked ?? 0}）；愿望 ${JSON.stringify(goals)}`);
console.log(`公共事件 ${JSON.stringify(events)}；定时任务 ${JSON.stringify(jobsByStatus)}；重试 ${m.job_retries}，搁置 ${m.job_failures}`);
console.log(`行为计数：${JSON.stringify(Object.fromEntries([...sim.counters].filter(([k]) => k !== 'check_ms')))}`);

console.log('\n── 停机重启 ──');
if (sim.restarts.length === 0) console.log('（本次没有重启）');
for (const r of sim.restarts) {
  console.log(`  逻辑时间 +${fmtDuration(r.at - TOWN_START)}：${r.clean ? '正常关闭' : '模拟被杀'}，停机 ${fmtDuration(r.downtime)}，当时进行中的小游戏 ${r.runningGames} 局，重启后中止 ${r.abortedAfter} 局，估计停机 ${Math.round(r.outageSeen / 1000)} 秒，零停机二次重启 ${r.idempotent ? '结算数据不变' : '结算数据改变！'}`);
}

console.log('\n── 拒绝与幂等检查 ──');
console.log(`故意发错 / 重放等检查 ${sim.rejectChecks.run} 次，未按预期 ${sim.rejectChecks.failed} 次：${[...sim.negCount].map(([k, v]) => `${k} ${v}`).join('；')}`);
for (const s of sim.rejectChecks.samples) console.log(`  × ${s}`);

console.log('\n── 不变量 ──');
console.log(`检查 ${sim.inv.checkRounds} 轮（检查本身累计 ${fmtDuration(sim.counters.get('check_ms') ?? 0)}），违例 ${sim.inv.totalViolations} 条`);
console.log(table([['不变量', '检查次数', '违例'], ...sim.inv.summary().map((s) => [s.name, String(s.checks), String(s.fails)])]));
for (const v of sim.inv.violations.slice(0, 20)) console.log(`  × [${v.invariant}] ${v.message}（出现 ${v.seen} 次，逻辑时间 +${fmtDuration(v.at - TOWN_START)}）  ${JSON.stringify(v.detail)?.slice(0, 300)}`);
if (sim.internalCount > 0) {
  console.log('\n内部异常（任何非 WorldError 的异常都是 bug）：');
  for (const e of sim.internal) console.log(`  动作 ${e.type} ${JSON.stringify(e.fields)?.slice(0, 160)}\n    ${e.error}\n${e.stack.split('\n').slice(1).join('\n')}`);
}

console.log('\n── 视图大小（UTF-8 字节，门槛：AI 视图 < 16 KiB，网页快照 < 64 KiB）──');
console.log(
  table([
    ['视图', '样本', 'p50', 'p99', '最大', '门槛'],
    ['townAgentView（AI 紧凑视图）', String(agentSz.n), fmtBytes(agentSz.p50), fmtBytes(agentSz.p99), fmtBytes(agentSz.max), agentSz.max < 16384 ? '通过 (<16 KiB)' : '未通过'],
    ['townMeView（网页本人快照）', String(meSz.n), fmtBytes(meSz.p50), fmtBytes(meSz.p99), fmtBytes(meSz.max), meSz.max < 65536 ? '通过 (<64 KiB)' : '未通过'],
    ['townPublicView（公开地图）', String(pubSz.n), fmtBytes(pubSz.p50), fmtBytes(pubSz.p99), fmtBytes(pubSz.max), '—'],
    ['小游戏座位视图', String(gameSz.n), fmtBytes(gameSz.p50), fmtBytes(gameSz.p99), fmtBytes(gameSz.max), gameSz.max < 65536 ? '通过 (<64 KiB)' : '未通过'],
  ]),
);

console.log('\n── 数据库 ──');
const perDay = sim.daily.map((d, i) => `第 ${i + 1} 天末 ${fmtBytes(d.bytes)}（行数 ${d.rows}${FILE_MODE ? `，主文件 ${fmtBytes(sim.fileBytesByDay[i] ?? 0)}，WAL ${fmtBytes(d.walBytes)}` : ''}）`);
console.log(perDay.join('\n'));
if (sim.daily.length >= 2) {
  const days = Math.max(1, logical / DAY);
  const first = sim.daily[0]!;
  const last = sim.daily[sim.daily.length - 1]!;
  console.log(`整体增长：${fmtBytes(last.bytes)}，约 ${fmtBytes(last.bytes / days)} / 天（含初始建库；${N} 位居民；逻辑 ${days.toFixed(2)} 天）；逐日增量 ${sim.daily.slice(1).map((d, i) => fmtBytes(d.bytes - sim.daily[i]!.bytes)).join(' / ')}（第 1 天末 ${fmtBytes(first.bytes)}）`);
}
if (lastDb) {
  const rows = Object.entries(lastDb.tables).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const prev = sim.daily.length >= 2 ? sim.daily[sim.daily.length - 2]!.tables : {};
  console.log('行数最多的表（末日 / 较前一天增量）：' + rows.map(([k, n]) => `${k} ${n}(+${n - (prev[k] ?? 0)})`).join('，'));
}
console.log(`指标快照：命令 ${m.commands}，提交耗时 p50/p99 ${(m.commit_ms as { p50: number }).p50}/${(m.commit_ms as { p99: number }).p99} ms，事件 私有 ${m.events_private} / 公开 ${m.events_public}，裁剪行 ${m.pruned_rows}，db ${fmtBytes(Number(m.db_bytes))}，wal ${fmtBytes(Number(m.wal_bytes))}`);
const backupLogs = sim.logs.filter((l) => /备份/.test(l));
if (backupLogs.length) console.log(`备份：${backupLogs.length} 次，最近一次：${backupLogs[backupLogs.length - 1]}`);
const warnLogs = sim.logs.filter((l) => /出错|失败|搁置|不可写/.test(l));
if (warnLogs.length) {
  console.log(`\n引擎日志里的警告 / 错误（${warnLogs.length} 条，前 10）：`);
  for (const l of warnLogs.slice(0, 10)) console.log(`  ${l}`);
}
console.log(`\n可复现摘要（同种子同参数应一致）：${digest}`);

const failed = sim.inv.totalViolations > 0 || sim.internalCount > 0 || sim.rejectChecks.failed > 0 || scenarios.some((s) => !s.ok);
console.log(`\n结论：${failed ? '未通过（见上面的违例 / 异常）' : '通过：未发现不变量违例、内部异常或拒绝检查失败'}`);

if (args.json) {
  writeFileSync(
    args.json,
    JSON.stringify(
      {
        args: { days: DAYS, residents: N, seed: SEED, db: FILE_MODE ? DB_PATH : null, restarts: RESTARTS, checkEveryMin: CHECK_EVERY / MIN },
        digest,
        logicalMs: logical,
        wallMs,
        commands: { total: sim.stats.total, ok: sim.stats.ok, replayed: sim.stats.replayed, errors: Object.fromEntries(sim.stats.err), reasons: Object.fromEntries(sim.stats.reasons), byType: Object.fromEntries(sim.stats.byType) },
        anomalies: [...sim.anomalies.values()],
        internal: sim.internal,
        rejectChecks: sim.rejectChecks,
        negCount: Object.fromEntries(sim.negCount),
        counters: Object.fromEntries(sim.counters),
        invariants: { rounds: sim.inv.checkRounds, total: sim.inv.totalViolations, summary: sim.inv.summary(), violations: sim.inv.violations },
        interactions: { done: interDone, cancelled: interCancel },
        games: gameByType,
        restarts: sim.restarts,
        scenarios,
        sizes: { agent: agentSz, me: meSz, public: pubSz, game: gameSz },
        daily: sim.daily.map((d, i) => ({ day: d.day, logicalBytes: d.bytes, rows: d.rows, fileBytes: sim.fileBytesByDay[i] ?? null, walBytes: d.walBytes })),
        finalTables: lastDb?.tables,
        fileBytes,
        metrics: m,
        passed: !failed,
      },
      null,
      2,
    ),
  );
  console.log(`机器可读结果已写入 ${args.json}`);
}
try {
  w.close();
} catch {
  /* 已经关闭 */
}
process.exit(failed ? 1 : 0);
void percentile;
void townPublicView;
void townAgentView;
