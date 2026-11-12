/**
 * 栖灯镇：真实时间负载测试（world:load）
 *
 * 真实时钟、真实文件库（WAL + synchronous=FULL，每次提交真 fsync）、单进程。
 * 一批居民按“负载模型”持续发动作：AI 居民每 2~6 秒一步，真人居民每 1~4 秒一步，每 20 秒一次心跳；
 * 居民持续 navigate（地点、物件旁、地图点、某个人身边，走路时偶尔改道），走路期间每个续租间隔续一次导航租约，边走边说话；
 * 同时始终维持 --games 局小游戏在进行（凑桌 → 开局 → 各人按 todo 出手 → 结算 → 下一桌）。
 * 导航指标：每秒 navigate / 续租数、nav_step 任务延迟（实际处理时刻 − 应处理时刻）、sceneView 生成耗时。
 * 测量每条命令的耗时（p50/p95/p99/max）与吞吐，对照 WorldService.metricsSnapshot() 的提交耗时，
 * 并测 townMeView / townAgentView / townPublicView 的生成耗时与字节数，以及事件循环延迟。
 *
 *   npx tsx scripts/world-load.ts                                  # 30 居民、3 局、20 秒
 *   npx tsx scripts/world-load.ts --residents 60 --games 6 --seconds 30   # 压力档
 *
 * 参数：--residents(30) --games(3) --seconds(20) --seed(1) --db <路径>（默认临时目录里的文件库，结束后删除）
 *       --json <path>  --http（本脚本不实现，见输出说明）
 * 说明：这是开发容器里的测试，不代表生产服务器；单进程同步命令，所以“并发”体现为排队。
 */
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  Conn,
  Rand,
  WorldError,
  renewTrack,
  sceneView,
  trackNav,
  fmtBytes,
  fmtMs,
  makePrincipal,
  openWorld,
  personName,
  randomProfile,
  runCommand,
  summarize,
  table,
  townAgentView,
  townMeView,
  townPublicView,
  utf8Bytes,
  type Kind,
  type Outcome,
  type Person,
  type DistSummary,
  type NavTrack,
} from './world-lib.js';
import { PUBLIC_OBJECTS } from '../packages/engine/src/world/content.js';

const { values: args } = parseArgs({
  options: {
    residents: { type: 'string', default: '30' },
    games: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '20' },
    seed: { type: 'string', default: '1' },
    db: { type: 'string' },
    json: { type: 'string' },
    http: { type: 'boolean', default: false },
  },
});
const N = Number(args.residents);
const GAMES = Number(args.games);
const SECONDS = Number(args.seconds);
const SEED = String(args.seed);
const GATE_MS = 50;

if (args.http) console.log('提示：--http（真实 HTTP + SSE 端到端）本脚本未实现，已跳过；下面的数字只含服务内部命令管线（不含网络栈、JSON 编解码和限流中间件）。\n');

const tmp = args.db ? null : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'town-load-'));
const DB = args.db ?? join(tmp!, 'town.db');
if (args.db && existsSync(args.db)) {
  console.error(`数据库文件 ${args.db} 已存在，请换一个路径。`);
  process.exit(2);
}

const w = openWorld({
  dbPath: DB,
  seed: `load${SEED}`,
  realTime: true,
  // 容量上限随居民数放开（压力档 > 30）；走路用真实速度（2.4 米/秒），续租按引擎参数
  params: { activeResidentLimit: Math.max(30, N), concurrentGames: GAMES },
});
// 真实运行时由 mountTown 每秒调一次 tick
const ticker = setInterval(() => w.tick(), 1000);

// ───────────────────────── 居民 ─────────────────────────

interface R {
  p: Person;
  c: Conn;
  rnd: Rand;
  nextAt: number;
  hbAt: number;
  table: Table | null;
  gameAt: number;
  /** 手里这一趟导航（客户端视角） */
  nav: NavTrack | null;
}
interface Table {
  id: number;
  game: 'number_bomb' | 'liars_dice' | 'sealed_auction';
  members: R[];
  stage: 'gather' | 'forming' | 'running' | 'done';
  activityId: string | null;
  since: number;
}

const rnd = new Rand(`load:${SEED}`);
const people: R[] = [];
for (let i = 0; i < N; i++) {
  const kind: Kind = i % 3 === 1 ? 'human' : 'agent';
  const name = personName(i);
  const principalId = makePrincipal(w, i, kind, name);
  const p: Person = { idx: i, name, kind, principalId, residentId: '' };
  const c = new Conn(w, p, `${kind === 'agent' ? 'mcp' : 'web'}:load-${i}`, kind === 'agent' ? 'mcp' : 'web');
  people.push({ p, c, rnd: rnd.fork(`r${i}`), nextAt: 0, hbAt: 0, table: null, gameAt: 0, nav: null });
}

// ───────────────────────── 测量 ─────────────────────────

const lat = new Map<string, number[]>();
const allLat: number[] = [];
const errCodes = new Map<string, number>();
let okCount = 0;
let internalErrors = 0;
const internalSamples: string[] = [];
const viewMs = { me: [] as number[], agent: [] as number[], pub: [] as number[] };
const viewBytes = { me: [] as number[], agent: [] as number[], pub: [] as number[] };
const lagMs: number[] = [];
const navM = {
  navigate: 0,
  accepted: 0,
  completed: 0,
  renewOk: 0,
  renewDone: 0,
  renewLost: 0,
  renewAdopted: 0,
  renewMs: [] as number[],
  navMs: [] as number[],
  lagMs: [] as number[],
  steps: 0,
  sceneMs: [] as number[],
  sceneBytes: [] as number[],
  sceneActors: [] as number[],
  walkingSamples: 0,
};
let gamesStarted = 0;
let gamesDone = 0;
let gamesAborted = 0;

function record(type: string, o: Outcome): void {
  const a = lat.get(type) ?? [];
  a.push(o.ms);
  lat.set(type, a);
  allLat.push(o.ms);
  if (o.ok) okCount++;
  else {
    errCodes.set(`${o.code}${o.reason ? '/' + o.reason : ''}`, (errCodes.get(`${o.code}${o.reason ? '/' + o.reason : ''}`) ?? 0) + 1);
    if (o.code === 'INTERNAL') {
      internalErrors++;
      if (internalSamples.length < 5) internalSamples.push(`${type}: ${o.message}\n${(o.internal as Error)?.stack?.split('\n').slice(0, 5).join('\n')}`);
    }
  }
}

function act(r: R, type: string, fields: Record<string, unknown> = {}): Outcome {
  let o = runCommand(w, r.c.auth, r.c.build(type, fields));
  record(type, o);
  if (!o.ok && o.code === 'control_lost') {
    try {
      r.c.claim();
    } catch {
      return o;
    }
    o = runCommand(w, r.c.auth, r.c.build(type, fields));
    record(type, o);
  }
  return o;
}

/** 发 navigate 并接管续租；返回是否在走。to 可以是地点 / 物件旁 / 地图点 / 居民编号（approach）。 */
function navigate(r: R, to: unknown, mode: 'to' | 'approach' = 'to'): boolean {
  navM.navigate++;
  const o = act(r, 'navigate', mode === 'approach' ? { approach: to } : { to });
  if (o.ok) navM.navMs.push(o.ms);
  if (!o.ok) return false;
  if (o.out.status !== 'accepted') {
    navM.completed++;
    r.nav = null;
    return false;
  }
  navM.accepted++;
  r.nav = trackNav(r.c, o.out.navigation, Date.now(), r.rnd.range(0, 300));
  return true;
}

function renewDue(r: R): void {
  if (!r.nav || r.nav.renewAt > Date.now()) return;
  const res = renewTrack(w, r.nav, Date.now(), r.rnd.range(0, 300));
  navM.renewMs.push(res.ms);
  if (res.adopted) navM.renewAdopted++;
  if (res.result === 'ok') navM.renewOk++;
  else {
    if (res.result === 'done') navM.renewDone++;
    else navM.renewLost++;
    r.nav = null;
  }
}

function randomTarget(r: R, space: string): { to: unknown; mode: 'to' | 'approach' } {
  const kind = r.rnd.weighted<'place' | 'object' | 'point' | 'person'>([['place', 5], ['object', 3], ['point', 2], ['person', 1.5]])!;
  if (kind === 'object') return { to: r.rnd.pick(PUBLIC_OBJECTS).id, mode: 'to' };
  if (kind === 'point') {
    const town = w.map.scenes.get(w.map.spawn.scene)!;
    return { to: { x: town.originX + r.rnd.float() * town.cols * town.cell, z: town.originZ + r.rnd.float() * town.rows * town.cell }, mode: 'to' };
  }
  if (kind === 'person') {
    const t = r.rnd.pick(people.filter((x) => x !== r && x.p.residentId && w.mustResident(x.p.residentId).location_id === space));
    if (t) return { to: t.p.residentId, mode: 'approach' };
  }
  return { to: r.rnd.pick(DESTS.filter((d) => d !== space)), mode: 'to' };
}

function timedView(r: R): ReturnType<typeof townMeView> {
  const res = w.mustResident(r.p.residentId);
  if (r.c.kindOfClient === 'mcp') {
    const t0 = performance.now();
    const av = townAgentView(w, res, r.c.clientId);
    viewMs.agent.push(performance.now() - t0);
    viewBytes.agent.push(utf8Bytes(av));
  }
  const t0 = performance.now();
  const v = townMeView(w, res, r.c.clientId);
  viewMs.me.push(performance.now() - t0);
  viewBytes.me.push(utf8Bytes(v));
  r.c.window = v.actionWindow;
  return v;
}

// ───────────────────────── 居民行为 ─────────────────────────

const PHRASES = ['你好呀', '今天天气不错', '想喝点茶', '这里真安静', '晚上见'];
const DESTS = ['plaza', 'tea_house', 'bookshop', 'kitchen', 'garden', 'home'];

function step(r: R, now: number): void {
  const think = r.p.kind === 'agent' ? r.rnd.range(2000, 6000) : r.rnd.range(1000, 4000);
  r.nextAt = now + think;
  if (r.table && r.table.stage !== 'done') return; // 在桌上的人由牌桌流程驱动
  const v = timedView(r);
  if (v.game) return;
  const here = v.here;
  const space = v.location.space ?? '';
  if (v.location.navigation) {
    // 走在路上：多数时候继续走，偶尔边走边说，偶尔改道
    const roll = r.rnd.float();
    if (roll < 0.25) act(r, 'speak', { text: r.rnd.pick(PHRASES) });
    else if (roll < 0.40) {
      const t = randomTarget(r, space);
      navigate(r, t.to, t.mode);
    }
    return;
  }
  const choices: [string, number][] = [
    ['speak', here && here.residents.length > 0 ? 30 : 3],
    ['move', 40],
    ['interact', here && here.objects.length > 0 ? 12 : 0],
    ['buy', here && here.shops.length > 0 ? 8 : 0],
    ['letter', 5],
    ['read', v.mail.unread > 0 ? 6 : 0],
    ['ask', here && here.residents.length > 0 ? 4 : 0],
    ['profile', 2],
    ['public', 3],
  ];
  const pick = r.rnd.weighted(choices);
  switch (pick) {
    case 'speak': act(r, 'speak', { text: r.rnd.pick(PHRASES) }); break;
    case 'move': {
      const t = randomTarget(r, space);
      navigate(r, t.to, t.mode);
      break;
    }
    case 'interact': {
      const o = r.rnd.pick(here!.objects.filter((x) => x.action && !x.active));
      if (o && !o.near) navigate(r, o.id); // 公共物件要先走到旁边
      else if (o) act(r, 'start_interaction', { objectId: o.id });
      break;
    }
    case 'buy': {
      const s = here!.shops[0];
      const g = s?.goods.find((x) => x.stock > 0 && x.price <= v.inventory.coins.available);
      if (s && g) act(r, 'buy', { shop: s.id, sku: g.sku, qty: 1 });
      break;
    }
    case 'letter': {
      const t = r.rnd.pick(people.filter((x) => x !== r && x.p.residentId));
      if (t) act(r, 'send_letter', { to: t.p.residentId, body: '路过，问好。' });
      break;
    }
    case 'read': {
      const l = w.db.get('SELECT letter_id FROM letters WHERE recipient_id = ? AND delivered_at IS NOT NULL AND read_at IS NULL LIMIT 1', r.p.residentId);
      if (l) {
        if (v.location.space !== `home:${v.me.id}`) navigate(r, 'home');
        else act(r, 'read_letter', { letterId: l.letter_id });
      }
      break;
    }
    case 'ask': {
      const t = r.rnd.pick(here!.residents);
      if (t) act(r, 'ask_hobby', { target: t.id });
      break;
    }
    case 'profile': act(r, 'update_profile', { bio: `负载测试 ${r.rnd.int(1000)}` }); break;
    case 'public': {
      const t0 = performance.now();
      const pv = townPublicView(w);
      viewMs.pub.push(performance.now() - t0);
      viewBytes.pub.push(utf8Bytes(pv));
      break;
    }
  }
}

// ───────────────────────── 牌桌 ─────────────────────────

const tables: Table[] = [];
let tableSeq = 0;
const GAME_ROT: Table['game'][] = ['number_bomb', 'liars_dice', 'number_bomb', 'liars_dice', 'sealed_auction'];

function freeResident(): R[] {
  return people.filter((r) => !r.table && w.mustResident(r.p.residentId).present_since !== null && !w.mustResident(r.p.residentId).activity_id);
}

function manageTables(now: number): void {
  for (const t of tables) {
    if (t.stage === 'done') continue;
    if (t.stage === 'gather') {
      const ready = t.members.every((m) => {
        const r = w.mustResident(m.p.residentId);
        return r.location_id === 'arcade';
      });
      if (ready) {
        const host = t.members[0]!;
        const o = act(host, 'propose_game', { game: t.game });
        if (o.ok) {
          t.activityId = (w.db.get("SELECT activity_id FROM activities WHERE host_id = ? AND status = 'forming' ORDER BY created_at DESC LIMIT 1", host.p.residentId)?.activity_id as string) ?? null;
          for (const m of t.members.slice(1)) act(m, 'join_game', { activityId: t.activityId });
          const o2 = act(host, 'start_game', { activityId: t.activityId });
          if (o2.ok) {
            t.stage = 'running';
            gamesStarted++;
          } else abandon(t);
        } else abandon(t);
      } else if (now - t.since > 20_000) abandon(t);
    } else if (t.stage === 'running') {
      const act0 = t.activityId ? w.db.get('SELECT status FROM activities WHERE activity_id = ?', t.activityId) : null;
      const inGame = t.members.filter((m) => w.mustResident(m.p.residentId).activity_id);
      if ((act0 && act0.status !== 'running') || inGame.length === 0) {
        if (act0?.status === 'completed') gamesDone++;
        else gamesAborted++;
        finish(t);
        continue;
      }
      for (const m of inGame) {
        if (m.gameAt > now) continue;
        m.gameAt = now + m.rnd.range(300, 1500);
        if (m.nextAt > now + 20_000) m.nextAt = now;
        const v = timedView(m);
        const g = v.game;
        if (g && g.status === 'running' && g.your_turn && g.todo && g.phase_id !== null) {
          const input = pickInput(m, g);
          if (input) act(m, 'game_act', { phaseId: g.phase_id, input });
        }
      }
    }
  }
}

function pickInput(m: R, g: NonNullable<ReturnType<typeof townMeView>['game']>): Record<string, unknown> | null {
  const specs = g.todo?.actions ?? [];
  if (specs.length === 0) return null;
  const nonCh = specs.filter((s) => s.action !== 'challenge');
  const spec = m.rnd.pick(nonCh.length ? nonCh : specs);
  const mm = /act\((\{.*\})\)/.exec(spec.example);
  let input: Record<string, unknown> = { action: spec.action };
  if (mm) {
    try {
      input = JSON.parse(mm[1]!) as Record<string, unknown>;
    } catch {
      /* 用默认 */
    }
  }
  if (spec.action === 'guess') {
    const range = /(\d+)\s*~\s*(\d+)/.exec(String(spec.params?.number ?? ''));
    if (range) input.number = m.rnd.range(Number(range[1]), Number(range[2]));
  } else if (spec.action === 'bid' && typeof input.number === 'number') input.number = m.rnd.range(0, input.number);
  return input;
}

function abandon(t: Table): void {
  for (const m of t.members) if (w.mustResident(m.p.residentId).activity_id) act(m, 'quit_game');
  for (const m of t.members) {
    const r = w.mustResident(m.p.residentId);
    if (!r.activity_id) {
      /* 空闲 */
    }
  }
  const forming = t.activityId && w.db.get("SELECT status FROM activities WHERE activity_id = ?", t.activityId)?.status === 'forming';
  if (forming) for (const m of t.members) act(m, 'leave_game_lobby');
  finish(t);
}

function finish(t: Table): void {
  t.stage = 'done';
  for (const m of t.members) m.table = null;
}

function ensureTables(now: number): void {
  const active = tables.filter((t) => t.stage !== 'done').length;
  for (let i = active; i < GAMES; i++) {
    const game = GAME_ROT[tableSeq % GAME_ROT.length]!;
    const free = freeResident();
    const size = game === 'sealed_auction' ? 3 : 3;
    if (free.length < size) return;
    const members: R[] = [];
    while (members.length < size) members.push(free.splice(rnd.int(free.length), 1)[0]!);
    const t: Table = { id: ++tableSeq, game, members, stage: 'gather', activityId: null, since: now };
    tables.push(t);
    for (const m of members) {
      m.table = t;
      const v = timedView(m);
      if (v.location.space !== 'arcade') navigate(m, 'arcade');
    }
  }
}

// ───────────────────────── 主循环 ─────────────────────────

async function main(): Promise<void> {
  console.log(`栖灯镇负载测试：${N} 位居民、${GAMES} 局小游戏常驻、${SECONDS} 秒、文件库 ${DB}（WAL，synchronous=FULL）`);
  // 进入
  const enterMs: number[] = [];
  for (const r of people) {
    const t0 = performance.now();
    try {
      const e = r.c.enter(randomProfile(r.rnd, r.p.name));
      r.p.residentId = e.residentId;
    } catch (e) {
      console.error(`进入失败 ${r.p.name}：${e instanceof WorldError ? `${e.code}/${e.reason ?? ''}` : String(e)}`);
      process.exit(1);
    }
    enterMs.push(performance.now() - t0);
  }
  const t0 = performance.now();
  for (const r of people) {
    r.nextAt = t0 + r.rnd.range(0, 3000);
    r.hbAt = t0 + r.rnd.range(0, 20_000);
  }
  // 事件循环延迟采样
  let lagLast = performance.now();
  const lagTimer = setInterval(() => {
    const n = performance.now();
    lagMs.push(Math.max(0, n - lagLast - 20));
    lagLast = n;
  }, 20);
  let manageAt = t0;
  let sceneAt = t0;
  let sceneIdx = 0;
  const origStep = w.jobHandlers.get('nav_step')!;
  w.jobHandlers.set('nav_step', (payload, job, nowMs) => {
    navM.lagMs.push(Math.max(0, nowMs - job.due_at));
    navM.steps++;
    origStep(payload, job, nowMs);
  });
  const end = t0 + SECONDS * 1000;
  const m0 = w.metricsSnapshot();
  let checkpoint = t0 + 1000;
  while (performance.now() < end) {
    const now = performance.now();
    if (now >= manageAt) {
      ensureTables(now);
      manageTables(now);
      manageAt = now + 250;
    }
    let did = false;
    for (const r of people) {
      if (r.hbAt <= now) {
        r.hbAt = now + 20_000;
        const h0 = performance.now();
        try {
          r.c.heartbeat();
          const ms = performance.now() - h0;
          record('heartbeat', { ok: true, out: {}, ms });
        } catch (e) {
          record('heartbeat', { ok: false, code: e instanceof WorldError ? e.code : 'INTERNAL', message: String(e), ms: performance.now() - h0 });
        }
        did = true;
      }
      if (r.nav) {
        navM.walkingSamples++;
        renewDue(r);
      }
      if (r.nextAt <= now) {
        try {
          step(r, now);
        } catch (e) {
          internalErrors++;
          if (internalSamples.length < 5) internalSamples.push(`step: ${e instanceof Error ? e.stack : String(e)}`);
          r.nextAt = now + 3000;
        }
        did = true;
      }
    }
    if (now >= sceneAt) {
      sceneAt = now + 40;
      const r = people[sceneIdx++ % people.length]!;
      const res = w.mustResident(r.p.residentId);
      const t0 = performance.now();
      const sv = sceneView(w, res, w.now());
      navM.sceneMs.push(performance.now() - t0);
      navM.sceneBytes.push(utf8Bytes(sv));
      navM.sceneActors.push(sv.actors.length);
    }
    if (now >= checkpoint) {
      checkpoint = now + 5000;
      if (process.stdout.isTTY) process.stdout.write(`\r  已运行 ${Math.round((now - t0) / 1000)} / ${SECONDS} 秒，命令 ${allLat.length}  `);
    }
    // 让出事件循环（定时器、tick、延迟采样）
    await new Promise<void>((res) => (did ? setImmediate(res) : setTimeout(res, 2)));
  }
  clearInterval(lagTimer);
  const wallMs = performance.now() - t0;
  for (const r of people) if (r.table) finish(r.table);
  w.tick();
  const m1 = w.metricsSnapshot();
  report(wallMs, enterMs, m0, m1);
}

function ms3(s: DistSummary): string[] {
  return [String(s.n), fmtMs(s.p50), fmtMs(s.p95), fmtMs(s.p99), fmtMs(s.max)];
}

function report(wallMs: number, enterMs: number[], m0: Record<string, unknown>, m1: Record<string, unknown>): void {
  const all = summarize(allLat);
  const cmdTotal = allLat.length;
  const secs = wallMs / 1000;
  console.log('\n================ 栖灯镇负载测试报告 ================');
  console.log(`机器：${platform()} ${release()} ${arch()}，${cpus().length} 核 ${cpus()[0]?.model ?? ''}，内存 ${(totalmem() / 1024 ** 3).toFixed(1)} GiB，Node ${process.version}`);
  console.log('说明：开发容器内的单进程测试，不是生产服务器；命令耗时只含服务内部管线（不含 HTTP / JSON 编解码）。');
  console.log(`负载：${N} 位居民（${people.filter((p) => p.p.kind === 'agent').length} AI + ${people.filter((p) => p.p.kind === 'human').length} 真人），常驻 ${GAMES} 局小游戏，持续 ${secs.toFixed(1)} 秒；AI 每 2~6 秒一步、真人每 1~4 秒一步、每 20 秒一次心跳；走路用真实速度并按租约续租`);
  console.log(`吞吐：${cmdTotal} 条命令（含心跳），成功 ${okCount}，被拒绝 ${cmdTotal - okCount}，内部异常 ${internalErrors}；${(cmdTotal / secs).toFixed(1)} 条/秒`);
  console.log(`小游戏：开局 ${gamesStarted}，完成 ${gamesDone}，中止/放弃 ${gamesAborted}；凑桌尝试 ${tables.length} 次`);
  console.log(`进入世界（注册）：${N} 次，p50 ${fmtMs(summarize(enterMs).p50)} ms，max ${fmtMs(summarize(enterMs).max)} ms`);

  const rows: string[][] = [['动作', '次数', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms']];
  rows.push(['全部命令', ...ms3(all)]);
  for (const [k, v] of [...lat].sort((a, b) => b[1].length - a[1].length)) rows.push([k, ...ms3(summarize(v))]);
  console.log('\n每条命令耗时（含 fsync 提交；runCommand 包住 WorldService.command 的墙钟时间）：');
  console.log(table(rows));

  const commit = m1.commit_ms as Record<string, number>;
  const domain = m1.domain_ms as Record<string, number>;
  const total = m1.total_ms as Record<string, number>;
  console.log('\n与服务自带指标对照（WorldService.metricsSnapshot，毫秒）：');
  console.log(
    table([
      ['指标', 'p50', 'p95', 'p99', 'max'],
      ['域逻辑（domain_ms）', ...['p50', 'p95', 'p99', 'max'].map((k) => fmtMs(Number(domain[k] ?? 0)))],
      ['提交 / fsync（commit_ms）', ...['p50', 'p95', 'p99', 'max'].map((k) => fmtMs(Number(commit[k] ?? 0)))],
      ['服务端总计（total_ms）', ...['p50', 'p95', 'p99', 'max'].map((k) => fmtMs(Number(total[k] ?? 0)))],
      ['脚本测得（全部命令）', fmtMs(all.p50), fmtMs(all.p95), fmtMs(all.p99), fmtMs(all.max)],
    ]),
  );
  console.log(`服务计数：命令 ${m1.commands}，拒绝 ${m1.rejected}，重放 ${m1.replays}，任务 ${m1.jobs}，重试 ${m1.job_retries}，搁置 ${m1.job_failures}，私有事件 ${m1.events_private}，公开事件 ${m1.events_public}，db ${fmtBytes(Number(m1.db_bytes))}，wal ${fmtBytes(Number(m1.wal_bytes))}（压测前 ${fmtBytes(Number(m0.db_bytes))}）`);

  const vm = summarize(viewMs.me);
  const va = summarize(viewMs.agent);
  const vp = summarize(viewMs.pub);
  const bm = summarize(viewBytes.me);
  const ba = summarize(viewBytes.agent);
  const bp = summarize(viewBytes.pub);
  console.log('\n视图生成（耗时 ms / 字节）：');
  console.log(
    table([
      ['视图', '次数', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'p50 字节', 'max 字节', '门槛'],
      ['townMeView', String(vm.n), fmtMs(vm.p50), fmtMs(vm.p95), fmtMs(vm.p99), fmtMs(vm.max), fmtBytes(bm.p50), fmtBytes(bm.max), bm.max < 65536 ? '<64 KiB 通过' : '未通过'],
      ['townAgentView', String(va.n), fmtMs(va.p50), fmtMs(va.p95), fmtMs(va.p99), fmtMs(va.max), fmtBytes(ba.p50), fmtBytes(ba.max), ba.max < 16384 ? '<16 KiB 通过' : '未通过'],
      ['townPublicView', String(vp.n), fmtMs(vp.p50), fmtMs(vp.p95), fmtMs(vp.p99), fmtMs(vp.max), fmtBytes(bp.p50), fmtBytes(bp.max), '—'],
    ]),
  );
  const rn = summarize(navM.renewMs);
  const nv = summarize(navM.navMs);
  const nl = summarize(navM.lagMs);
  const sm = summarize(navM.sceneMs);
  const sb = summarize(navM.sceneBytes);
  const sa = summarize(navM.sceneActors);
  console.log('\n导航：');
  console.log(
    table([
      ['指标', '数值'],
      ['navigate 调用（含被拒绝 / 当场走完）', `${navM.navigate} 次，${(navM.navigate / secs).toFixed(1)} 次/秒；接受 ${navM.accepted}，当场走完 ${navM.completed}`],
      ['续租 renewNavigation', `${navM.renewOk + navM.renewDone + navM.renewLost} 次，${((navM.renewOk + navM.renewDone + navM.renewLost) / secs).toFixed(1)} 次/秒；续上 ${navM.renewOk}，已结束 ${navM.renewDone}，失去控制权 ${navM.renewLost}，途中换版本重续 ${navM.renewAdopted}`],
      ['续租耗时 ms（p50 / p95 / p99 / max）', `${fmtMs(rn.p50)} / ${fmtMs(rn.p95)} / ${fmtMs(rn.p99)} / ${fmtMs(rn.max)}`],
      ['navigate 耗时 ms（p50 / p95 / p99 / max）', `${fmtMs(nv.p50)} / ${fmtMs(nv.p95)} / ${fmtMs(nv.p99)} / ${fmtMs(nv.max)}`],
      ['nav_step 任务', `${navM.steps} 次，${(navM.steps / secs).toFixed(1)} 次/秒`],
      ['nav_step 延迟 ms（实际处理 − 应处理；p50 / p95 / p99 / max）', `${fmtMs(nl.p50)} / ${fmtMs(nl.p95)} / ${fmtMs(nl.p99)} / ${fmtMs(nl.max)}`],
      ['sceneView 生成耗时 ms（p50 / p95 / p99 / max）', `${fmtMs(sm.p50)} / ${fmtMs(sm.p95)} / ${fmtMs(sm.p99)} / ${fmtMs(sm.max)}（${sm.n} 次）`],
      ['sceneView 字节 / 人数（p50 / max）', `${fmtBytes(sb.p50)} / ${fmtBytes(sb.max)}；场景里 ${sa.p50} / ${sa.max} 人`],
    ]),
  );
  const lag = summarize(lagMs);
  console.log(`\n事件循环延迟（20ms 定时器的超时量）：p50 ${fmtMs(lag.p50)} ms，p99 ${fmtMs(lag.p99)} ms，max ${fmtMs(lag.max)} ms`);

  const errRows = [...errCodes].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (errRows.length) console.log(`被拒绝的命令（Top）：${errRows.map(([k, v]) => `${k} ${v}`).join('，')}`);
  for (const s of internalSamples) console.log(`内部异常样例：${s}`);

  const present = w.presentCount();
  const pass = all.p99 < GATE_MS && rn.p99 < GATE_MS && internalErrors === 0 && bm.max < 65536 && ba.max < 16384;
  console.log(`\n门槛：命令 p99 < ${GATE_MS} ms（实测 ${fmtMs(all.p99)} ms，max ${fmtMs(all.max)} ms）；续租 p99 < ${GATE_MS} ms（实测 ${fmtMs(rn.p99)} ms）；内部异常 0（实测 ${internalErrors}）；视图大小在门槛内；结束时在场 ${present} 人`);
  console.log(`结论：${pass ? '通过' : '未通过'}（${N} 居民 / ${GAMES} 局；单进程、开发容器）`);

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          args: { residents: N, games: GAMES, seconds: SECONDS, seed: SEED },
          machine: { os: `${platform()} ${release()}`, cpus: cpus().length, model: cpus()[0]?.model, memGiB: totalmem() / 1024 ** 3, node: process.version },
          wallMs,
          commands: cmdTotal,
          ok: okCount,
          internalErrors,
          throughputPerSec: cmdTotal / secs,
          latency: all,
          byType: Object.fromEntries([...lat].map(([k, v]) => [k, summarize(v)])),
          metrics: m1,
          views: { meMs: vm, agentMs: va, pubMs: vp, meBytes: bm, agentBytes: ba, pubBytes: bp },
          eventLoopLag: lag,
          navigation: { ...navM, renewMs: rn, navMs: nv, lagMs: nl, sceneMs: sm, sceneBytes: sb, sceneActors: sa, navigatePerSec: navM.navigate / secs, renewPerSec: (navM.renewOk + navM.renewDone + navM.renewLost) / secs },
          games: { started: gamesStarted, done: gamesDone, aborted: gamesAborted },
          errors: Object.fromEntries(errCodes),
          pass,
        },
        null,
        2,
      ),
    );
    console.log(`机器可读结果已写入 ${args.json}`);
  }
  clearInterval(ticker);
  const dbBytes = existsSync(DB) ? statSync(DB).size : 0;
  void dbBytes;
  try {
    w.close();
  } catch {
    /* 已关闭 */
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('负载测试异常中断：', e);
  clearInterval(ticker);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
