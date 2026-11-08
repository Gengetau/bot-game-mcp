/**
 * 黑盒压测：把已构建的 dist/cli.js 当作独立进程启动，用大量真实 MCP 客户端（每个 bot 一个连接，常驻长轮询）
 * 同时跑多局混合游戏，统计服务进程的 RSS / CPU 与各类 MCP 调用的延迟。
 *
 *   npm run build && npx tsx scripts/load.ts [--levels 10,30,60] [--duration 180] [--seed 1] [--think 200,800] [--json out.json]
 *
 * 做法：
 *  - 每个并发「槽位」有自己的裁判 agent + 最多 8 个 bot agent + 自己的群号；槽位里的对局结束后立刻在同一槽位开下一局，
 *    直到到达时限（所以并发局数稳定在档位附近），到点后停止开新局，给进行中的局一点收尾时间。
 *  - 裁判走真正的 referee_step 循环（先 wait=0 排空，空了再长轮询）；bot 走 get_my_view(wait=20) 长轮询 + act/speak。
 *  - bot 的合法行动全部来自 get_my_view 的 todo/you（不依赖引擎内部）；各局的超时选项调低，作为兜底。
 *  - 没有真人座位（不测 relay_human_message）。
 * 只绑定 127.0.0.1；密钥随机生成；临时目录与服务进程在任何退出路径都会清理。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'packages', 'engine', 'dist', 'cli.js');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();
const CLK_TCK = 100;
let THINK: [number, number] = [200, 800];

// 简易可复现随机（仅用于压测脚本自身选动作）
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────── 度量 ─────────────────────────

class Metrics {
  lat = new Map<string, number[]>();
  errors = new Map<string, number>();
  openPolls = 0;
  peakPolls = 0;
  peakInflight = 0;
  inflight = 0;
  calls = 0;
  fastReturns = 0;
  gamesStarted = 0;
  gamesEnded = 0;
  gamesAborted = 0;
  gamesUnfinished = 0;
  byType = new Map<string, { started: number; ended: number; aborted: number; unfinished: number }>();
  refereeTimeoutNotices = 0;
  record(cat: string, ms: number): void {
    let a = this.lat.get(cat);
    if (!a) this.lat.set(cat, (a = []));
    a.push(ms);
  }
  err(kind: string): void {
    this.errors.set(kind, (this.errors.get(kind) ?? 0) + 1);
  }
  type(t: string) {
    let e = this.byType.get(t);
    if (!e) this.byType.set(t, (e = { started: 0, ended: 0, aborted: 0, unfinished: 0 }));
    return e;
  }
}

function pct(a: number[], p: number): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

// ───────────────────────── 服务进程 ─────────────────────────

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

function readProc(pid: number): { rssKb: number; cpuTicks: number; fds: number; threads: number } | null {
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = Number(st.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0);
    const threads = Number(st.match(/Threads:\s+(\d+)/)?.[1] ?? 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cpuTicks = Number(rest[11]) + Number(rest[12]); // utime + stime
    let fds = 0;
    try {
      fds = readdirSync(`/proc/${pid}/fd`).length;
    } catch {
      /* ignore */
    }
    return { rssKb: rss, cpuTicks, fds, threads };
  } catch {
    return null;
  }
}

// ───────────────────────── MCP 连接 ─────────────────────────

class Bot {
  client: Client | null = null;
  constructor(readonly m: Metrics, readonly mcpUrl: string, readonly key: string, readonly label: string) {}

  async connect(): Promise<void> {
    const client = new Client({ name: `load-${this.label}`, version: '1.0.0' });
    const t = new StreamableHTTPClientTransport(new URL(this.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${this.key}` } } });
    await Promise.race([client.connect(t), sleep(30_000).then(() => Promise.reject(new Error('connect timeout')))]);
    this.client = client;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await Promise.race([c.close().catch(() => undefined), sleep(1500)]);
  }

  /** 调用并计时。category 为统计分类；long 表示长轮询（单独计数）。出错抛 CallErr。 */
  async call(cat: string, name: string, args: Record<string, unknown>, long = false, timeoutMs = 60_000): Promise<any> {
    const m = this.m;
    if (!this.client) throw new CallErr('transport', 'not connected');
    m.calls++;
    m.inflight++;
    if (m.inflight > m.peakInflight) m.peakInflight = m.inflight;
    if (long) {
      m.openPolls++;
      if (m.openPolls > m.peakPolls) m.peakPolls = m.openPolls;
    }
    const t0 = now();
    try {
      const res: any = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      m.record(cat, now() - t0);
      const text: string = res?.content?.[0]?.text ?? '';
      if (res?.isError) {
        const code = text.match(/code: (\w+)/)?.[1] ?? 'tool_error';
        m.err(`${name}:${code}`);
        throw new CallErr('tool', text.slice(0, 200), code);
      }
      return JSON.parse(text);
    } catch (e) {
      if (e instanceof CallErr) throw e;
      m.record(`${cat}!fail`, now() - t0);
      const msg = e instanceof Error ? e.message : String(e);
      const kind = /timed out|timeout/i.test(msg) ? 'timeout' : 'transport';
      m.err(`${name}:${kind}`);
      throw new CallErr(kind, msg.slice(0, 200));
    } finally {
      m.inflight--;
      if (long) m.openPolls--;
    }
  }
}

class CallErr extends Error {
  constructor(readonly kind: 'tool' | 'timeout' | 'transport', msg: string, readonly code = '') {
    super(msg);
  }
}

// ───────────────────────── 游戏配置 ─────────────────────────

const TYPES = ['werewolf', 'undercover', 'liars_dice', 'number_bomb', 'sealed_auction', 'color_chain', 'bluff_tavern'] as const;
type GType = (typeof TYPES)[number];

/** 压缩节奏用的选项：限时调低（兜底），发言间隔调小，夜晚不强制等满 */
const OPTIONS: Record<GType, Record<string, unknown>> = {
  werewolf: { speech_gap_ms: 200, night_min_s: 0, night_timeout_s: 12, witch_timeout_s: 12, speech_timeout_s: 12, vote_timeout_s: 12, last_words_timeout_s: 10, hunter_timeout_s: 10, pk_speech_timeout_s: 10, sheriff_signup_timeout_s: 10, sheriff_order_timeout_s: 10, badge_timeout_s: 10, claim_timeout_s: 10 },
  undercover: { speech_gap_ms: 200, describe_timeout_s: 12, vote_timeout_s: 12, pk_timeout_s: 12, discuss_timeout_s: 12 },
  liars_dice: { speech_gap_ms: 200, turn_timeout_s: 10 },
  number_bomb: { speech_gap_ms: 200, turn_timeout_s: 10, mode: 'elimination' },
  sealed_auction: { speech_gap_ms: 200, bid_timeout_s: 10 },
  color_chain: { speech_gap_ms: 200, turn_timeout_s: 10 },
  bluff_tavern: { speech_gap_ms: 200, turn_timeout_s: 10 },
};

const PHRASES = ['我先观察一下局势，暂时没有强烈的倾向。', '信息还不够，先听听大家怎么说。', '前面的发言有些地方值得再推敲。', '平时偶尔会碰到的东西', '很多人都熟悉它'];

// ───────────────────────── 槽位：一个裁判 + 若干 bot + 一个群 ─────────────────────────

interface AgentCfg {
  key: string;
  id: string;
  name: string;
}

class Slot {
  referee!: Bot;
  bots: Bot[] = [];
  gameNo = 0;
  constructor(readonly idx: number, readonly refCfg: AgentCfg, readonly botCfgs: AgentCfg[], readonly groupId: string) {}
}

interface Ctx {
  m: Metrics;
  mcpUrl: string;
  rnd: () => number;
  ranges: Map<string, [number, number]>;
  /** 到点后不再开新局 */
  thinkLo: number;
  thinkHi: number;
  stopNew: boolean;
  /** 强制收尾 */
  abort: boolean;
}

const pickOf = <T>(rnd: () => number, a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
const intBetween = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

async function botTurn(ctx: Ctx, bot: Bot, gameId: string, type: GType, v: any): Promise<void> {
  const todo = v.todo;
  const rnd = ctx.rnd;
  if (todo.kind === 'speech') {
    await bot.call('speak', 'speak', { game_id: gameId, text: pickOf(rnd, PHRASES) });
    return;
  }
  const actions: any[] = todo.actions ?? [];
  const has = (n: string) => actions.find((a) => a.action === n);
  const pub = v.public ?? {};
  const you = v.you ?? {};
  let body: Record<string, unknown> | null = null;
  switch (type) {
    case 'number_bomb': {
      const range = String(actions[0]?.params?.number ?? '').match(/(\d+)\s*~\s*(\d+)/);
      body = { action: 'guess', number: intBetween(rnd, range ? Number(range[1]) : 1, range ? Number(range[2]) : 100) };
      break;
    }
    case 'liars_dice': {
      const cur = pub.current_bid;
      const min = pub.min_next_bid;
      if (!cur) body = { action: 'bid', quantity: pub.min_open_quantity ?? 1, face: intBetween(rnd, 1, 6) };
      else if (!min || rnd() < 0.45) body = { action: 'challenge' };
      else body = { action: 'bid', quantity: min.quantity, face: min.face };
      break;
    }
    case 'sealed_auction': {
      const r = String(actions[0]?.params?.number ?? '').match(/(\d+)\s*~\s*(\d+)/);
      const hi = Math.min(r ? Number(r[2]) : 30, 40);
      body = { action: 'bid', number: intBetween(rnd, 0, hi) };
      break;
    }
    case 'color_chain': {
      const colors: string[] = you.colors ?? ['红', '黄', '蓝', '绿'];
      if (has('color')) body = { action: 'color', color: pickOf(rnd, colors) };
      else if (has('challenge') && has('accept')) body = { action: rnd() < 0.3 ? 'challenge' : 'accept' };
      else {
        const playable: string[] = you.playable ?? [];
        if (has('play') && playable.length > 0) {
          const card = pickOf(rnd, playable);
          body = { action: 'play', card, call: true, ...(/变色/.test(card) ? { color: pickOf(rnd, colors) } : {}) };
        } else body = { action: has('pass') ? 'pass' : 'draw' };
      }
      break;
    }
    case 'bluff_tavern': {
      if (has('play')) {
        const hand: string[] = you.hand ?? [];
        const n = Math.min(hand.length, intBetween(rnd, 1, 3));
        const left = [...hand];
        const cards: string[] = [];
        for (let i = 0; i < n; i++) cards.push(left.splice(Math.floor(rnd() * left.length), 1)[0]!);
        body = { action: 'play', card: cards.join(' ') };
      } else body = { action: rnd() < 0.35 ? 'challenge' : 'trust' };
      break;
    }
    default: {
      // 狼人杀 / 卧底：优先真正的动作，随机目标
      const real = actions.filter((a) => !['skip', 'team_chat', 'speech', 'end_speech'].includes(a.action));
      const skip = actions.find((a) => a.action === 'skip');
      const choice = real.length > 0 ? pickOf(rnd, real) : skip ?? actions[0];
      if (!choice) return;
      body = { action: choice.action };
      if (Array.isArray(choice.targets) && choice.targets.length > 0) body.target = pickOf(rnd, choice.targets);
    }
  }
  if (!body) return;
  await bot.call('act', 'act', { game_id: gameId, ...body });
  // 真实 agent 行动后会马上看一眼结果：非等待的 get_my_view
  await bot.call('get_my_view_w0', 'get_my_view', { game_id: gameId, wait_seconds: 0 });
}

async function botLoop(ctx: Ctx, bot: Bot, gameId: string, type: GType): Promise<'ended' | 'aborted' | 'cut'> {
  let fails = 0;
  while (!ctx.abort) {
    let v: any;
    const t0 = now();
    try {
      v = await bot.call('get_my_view_long', 'get_my_view', { game_id: gameId, wait_seconds: 20 }, true, 70_000);
      fails = 0;
    } catch (e) {
      if (ctx.abort) break;
      if (++fails > 15) return 'cut';
      await sleep(400);
      continue;
    }
    const st = v.game?.status;
    if (st === 'ended') return 'ended';
    if (st === 'aborted') return 'aborted';
    if (!v.your_turn || !v.todo) {
      if (now() - t0 < 100) {
        ctx.m.fastReturns++;
        await sleep(500);
      }
      continue;
    }
    await sleep(intBetween(ctx.rnd, ctx.thinkLo, ctx.thinkHi)); // 思考时间
    try {
      await botTurn(ctx, bot, gameId, type, v);
      fails = 0;
    } catch (e) {
      if (++fails > 15) return 'cut';
      await sleep(300);
    }
  }
  return 'cut';
}

async function refereeLoop(ctx: Ctx, ref: Bot, gameId: string): Promise<'finished' | 'cut'> {
  let fails = 0;
  let drain = true;
  while (!ctx.abort) {
    try {
      const r = drain
        ? await ref.call('referee_step_w0', 'referee_step', { game_id: gameId, wait_seconds: 0, format: 'onebot' })
        : await ref.call('referee_step_long', 'referee_step', { game_id: gameId, wait_seconds: 10, format: 'onebot' }, true, 60_000);
      fails = 0;
      const ds: any[] = r.deliveries ?? [];
      for (const d of ds) {
        const txt = (d.message ?? []).map((s: any) => s?.data?.text ?? '').join('');
        if (/超时|托管|代猜|代为操作/.test(txt)) ctx.m.refereeTimeoutNotices++;
      }
      if (r.finished) return 'finished';
      drain = ds.length > 0; // 有消息就立刻再取，没有再长轮询
    } catch {
      if (ctx.abort) break;
      if (++fails > 15) return 'cut';
      await sleep(400);
    }
  }
  return 'cut';
}

async function runGame(ctx: Ctx, slot: Slot, type: GType): Promise<void> {
  const m = ctx.m;
  const [lo, hi] = ctx.ranges.get(type) ?? [3, 6];
  const nPlayers = intBetween(ctx.rnd, Math.max(lo, 3), Math.min(hi, 8, slot.bots.length));
  const bots = slot.bots.slice(0, nPlayers);
  const created = await slot.referee.call('create_game', 'create_game', { game_type: type, group_id: slot.groupId, join_as: 'referee', self_post: false, options: OPTIONS[type] });
  const gameId: string = created.summary.game_id;
  await Promise.all(bots.map((b) => b.call('join_game', 'join_game', { game_id: gameId, join_as: 'player', self_post: false })));
  await slot.referee.call('start_game', 'start_game', { game_id: gameId });
  m.gamesStarted++;
  m.type(type).started++;
  const refP = refereeLoop(ctx, slot.referee, gameId);
  const results = await Promise.all(bots.map((b) => botLoop(ctx, b, gameId, type)));
  const refRes = await Promise.race([refP, sleep(15_000).then(() => 'cut' as const)]);
  const te = m.type(type);
  if (results.every((r) => r === 'ended') && refRes === 'finished') {
    m.gamesEnded++;
    te.ended++;
  } else if (results.some((r) => r === 'aborted')) {
    m.gamesAborted++;
    te.aborted++;
  } else {
    m.gamesUnfinished++;
    te.unfinished++;
    // 强制中止的局要让群号可再用：交给槽位循环结束，不再开新局
  }
}

async function slotLoop(ctx: Ctx, slot: Slot): Promise<void> {
  while (!ctx.stopNew && !ctx.abort) {
    const type = TYPES[(slot.idx + slot.gameNo++) % TYPES.length]!;
    try {
      await runGame(ctx, slot, type);
    } catch (e) {
      if (ctx.abort) return;
      ctx.m.err(`slot:${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
      await sleep(1000);
    }
  }
}

// ───────────────────────── 一个档位 ─────────────────────────

interface LevelResult {
  level: number;
  wallS: number;
  bots: number;
  peakRssMb: number;
  startRssMb: number;
  endRssMb: number;
  cpuAvgPct: number;
  cpuPeak5sPct: number;
  peakFds: number;
  peakThreads: number;
  harnessCpuPct: number;
  harnessRssMb: number;
  lagP99Ms: number;
  m: Metrics;
}

async function runLevel(level: number, durationS: number, seed: number, state: { child: ChildProcess | null; tmp: string | null }): Promise<LevelResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'botgame-load-'));
  state.tmp = tmp;
  const key = () => `bgk_${randomBytes(18).toString('base64url')}`;
  const adminKey = key();
  const slots: Slot[] = [];
  const agents: AgentCfg[] = [];
  const BOTS_PER_SLOT = 8;
  for (let i = 0; i < level; i++) {
    const ref: AgentCfg = { key: key(), id: String(500000 + i * 20), name: `REF${i}` };
    const bs: AgentCfg[] = Array.from({ length: BOTS_PER_SLOT }, (_, j) => ({ key: key(), id: String(500000 + i * 20 + 1 + j), name: `B${i}-${j}` }));
    agents.push(ref, ...bs);
    slots.push(new Slot(i, ref, bs, String(700000 + i)));
  }
  const port = await freePort();
  const cfgPath = join(tmp, 'config.json');
  const statePath = join(tmp, 'state.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      legacySse: false,
      publicApi: true,
      stateFile: statePath,
      maxActiveGames: 0,
      allowedGroups: [],
      auth: { mode: 'keys', adminKeys: [adminKey], agents },
    }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [CLI, 'serve', '--host', '127.0.0.1', '--port', String(port), '--config', cfgPath, '--state', statePath], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  state.child = child;
  const tail: string[] = [];
  const onData = (b: Buffer) => {
    for (const l of b.toString().split('\n')) if (l.trim()) tail.push(l.slice(0, 300));
    if (tail.length > 100) tail.splice(0, tail.length - 100);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const base = `http://127.0.0.1:${port}`;
  const dl = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${tail.slice(-10).join('\n')}`);
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > dl) throw new Error('服务 20 秒内没有就绪');
    await sleep(100);
  }
  const pid = child.pid!;
  const m = new Metrics();
  const rnd = mulberry(seed * 1000 + level);
  const ctx: Ctx = { m, mcpUrl: `${base}/mcp`, rnd, ranges: new Map(), thinkLo: THINK[0], thinkHi: THINK[1], stopNew: false, abort: false };

  // 采样器：服务进程 RSS/CPU/fd，加上本进程（压测端）自身 CPU 与事件循环延迟
  const startProc = readProc(pid)!;
  let peakRss = startProc.rssKb;
  let peakFds = 0;
  let peakThreads = 0;
  const cpuSeries: { t: number; ticks: number }[] = [{ t: now(), ticks: startProc.cpuTicks }];
  const lags: number[] = [];
  const selfStart = process.cpuUsage();
  const selfT0 = now();
  let lastTick = now();
  const lagTimer = setInterval(() => {
    const t = now();
    lags.push(Math.max(0, t - lastTick - 100));
    lastTick = t;
  }, 100);
  const sampler = setInterval(() => {
    const p = readProc(pid);
    if (!p) return;
    if (p.rssKb > peakRss) peakRss = p.rssKb;
    if (p.fds > peakFds) peakFds = p.fds;
    if (p.threads > peakThreads) peakThreads = p.threads;
    cpuSeries.push({ t: now(), ticks: p.cpuTicks });
  }, 1000);

  const tStart = now();
  try {
    // 连接所有 agent（限并发），并取各游戏的人数范围
    const all: Bot[] = [];
    for (const s of slots) {
      s.referee = new Bot(m, ctx.mcpUrl, s.refCfg.key, `ref${s.idx}`);
      s.bots = s.botCfgs.map((c, j) => new Bot(m, ctx.mcpUrl, c.key, `b${s.idx}-${j}`));
      all.push(s.referee, ...s.bots);
    }
    let next = 0;
    let connectFail = 0;
    await Promise.all(
      Array.from({ length: 24 }, async () => {
        while (next < all.length) {
          const b = all[next++]!;
          const t0 = now();
          try {
            await b.connect();
            m.record('connect', now() - t0);
          } catch (e) {
            connectFail++;
            m.err('connect:fail');
          }
        }
      }),
    );
    if (connectFail > 0) console.log(`  [warn] ${connectFail}/${all.length} 个连接失败`);
    const lg = await slots[0]!.referee.call('list_games', 'list_games', {});
    for (const g of lg.game_types as any[]) {
      const [a, b] = String(g.players).split('~').map(Number);
      ctx.ranges.set(g.type, [a!, b!]);
    }

    // 到点停止开新局；再给 45s 收尾，最后强制中止
    const stopTimer = setTimeout(() => {
      ctx.stopNew = true;
    }, durationS * 1000);
    const abortTimer = setTimeout(() => {
      ctx.abort = true;
    }, (durationS + 45) * 1000);
    const progress = setInterval(() => {
      const p = readProc(pid);
      console.log(`  [L${level} ${((now() - tStart) / 1000).toFixed(0).padStart(3)}s] 局 开始${m.gamesStarted} 结束${m.gamesEnded} 中止${m.gamesAborted} 长轮询${m.openPolls} 调用${m.calls} 错误${[...m.errors.values()].reduce((a, b) => a + b, 0)} RSS=${p ? (p.rssKb / 1024).toFixed(0) : '?'}MB`);
    }, 30_000);
    await Promise.all(slots.map((s) => slotLoop(ctx, s)));
    clearTimeout(stopTimer);
    clearTimeout(abortTimer);
    clearInterval(progress);
    // 没跑完就被强制中止的局，runGame 里已经计入 unfinished；这里补上「到点时仍在进行」的统计由 unfinished 体现
  } finally {
    ctx.abort = true;
    clearInterval(sampler);
    clearInterval(lagTimer);
  }
  const wallS = (now() - tStart) / 1000;
  const endProc = readProc(pid) ?? startProc;
  const first = cpuSeries[0]!;
  const last = cpuSeries[cpuSeries.length - 1]!;
  const cpuAvg = ((last.ticks - first.ticks) / CLK_TCK / ((last.t - first.t) / 1000)) * 100;
  let cpuPeak = 0;
  for (let i = 5; i < cpuSeries.length; i++) {
    const a = cpuSeries[i - 5]!;
    const b = cpuSeries[i]!;
    cpuPeak = Math.max(cpuPeak, ((b.ticks - a.ticks) / CLK_TCK / ((b.t - a.t) / 1000)) * 100);
  }
  const su = process.cpuUsage(selfStart);
  const harnessCpu = ((su.user + su.system) / 1e6 / ((now() - selfT0) / 1000)) * 100;
  const res: LevelResult = {
    level,
    wallS,
    bots: slots.length * (BOTS_PER_SLOT + 1),
    peakRssMb: peakRss / 1024,
    startRssMb: startProc.rssKb / 1024,
    endRssMb: endProc.rssKb / 1024,
    cpuAvgPct: cpuAvg,
    cpuPeak5sPct: cpuPeak,
    peakFds,
    peakThreads,
    harnessCpuPct: harnessCpu,
    harnessRssMb: process.memoryUsage().rss / 1048576,
    lagP99Ms: pct(lags, 99),
    m,
  };
  // 清理：关闭客户端、杀服务、删临时目录
  await Promise.all(slots.flatMap((s) => [s.referee?.close(), ...s.bots.map((b) => b.close())]).filter(Boolean) as Promise<void>[]);
  await stopServer(child);
  state.child = null;
  rmSync(tmp, { recursive: true, force: true });
  state.tmp = null;
  return res;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), 8000);
  await exited;
  clearTimeout(t);
}

// ───────────────────────── 报告 ─────────────────────────

const f = (x: number, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-');

function printLevel(r: LevelResult): void {
  const m = r.m;
  console.log(`\n══ 档位 ${r.level} 局并发（${r.bots} 个 MCP 连接，运行 ${f(r.wallS)}s）══`);
  console.log(`服务进程：RSS 起始 ${f(r.startRssMb)}MB → 峰值 ${f(r.peakRssMb)}MB（结束 ${f(r.endRssMb)}MB）；CPU 平均 ${f(r.cpuAvgPct)}% / 5s 窗口峰值 ${f(r.cpuPeak5sPct)}%（单核）；fd 峰值 ${r.peakFds}；线程峰值 ${r.peakThreads}`);
  console.log(`压测端自身：CPU ${f(r.harnessCpuPct)}%，RSS ${f(r.harnessRssMb)}MB，事件循环延迟 p99 ${f(r.lagP99Ms)}ms（越大说明压测端本身成了瓶颈）`);
  console.log(`并发长轮询峰值 ${m.peakPolls}；同时在途调用峰值 ${m.peakInflight}；总调用 ${m.calls}；长轮询秒回(<100ms 且没轮到)${m.fastReturns} 次`);
  console.log(`对局：开始 ${m.gamesStarted}，正常结束 ${m.gamesEnded}，中止 ${m.gamesAborted}，未完成(被强制收尾) ${m.gamesUnfinished}；裁判见到的超时/托管公告 ${m.refereeTimeoutNotices} 条`);
  console.log('延迟（ms）：');
  console.log('  类别                     次数    p50     p95     p99     max');
  const cats = ['act', 'speak', 'get_my_view_w0', 'referee_step_w0', 'create_game', 'join_game', 'start_game', 'connect'];
  for (const c of cats) {
    const a = m.lat.get(c) ?? [];
    if (a.length === 0) continue;
    console.log(`  ${c.padEnd(22)} ${String(a.length).padStart(6)} ${f(pct(a, 50), 1).padStart(7)} ${f(pct(a, 95), 1).padStart(7)} ${f(pct(a, 99), 1).padStart(7)} ${f(Math.max(...a), 1).padStart(7)}`);
  }
  for (const c of ['get_my_view_long', 'referee_step_long']) {
    const a = m.lat.get(c) ?? [];
    if (a.length === 0) continue;
    console.log(`  ${(c + '(含等待)').padEnd(22)} ${String(a.length).padStart(6)} ${f(pct(a, 50), 0).padStart(7)} ${f(pct(a, 95), 0).padStart(7)} ${f(pct(a, 99), 0).padStart(7)} ${f(Math.max(...a), 0).padStart(7)}`);
  }
  const failed = [...m.lat.keys()].filter((k) => k.endsWith('!fail'));
  for (const k of failed) console.log(`  ${k}: ${m.lat.get(k)!.length} 次传输层失败`);
  console.log(`错误：${m.errors.size === 0 ? '无' : [...m.errors].map(([k, v]) => `${k}×${v}`).join('，')}`);
  console.log('按游戏：' + [...m.byType].map(([t, e]) => `${t} 开${e.started}/完${e.ended}/止${e.aborted}/未完${e.unfinished}`).join('；'));
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { levels: { type: 'string' }, duration: { type: 'string' }, seed: { type: 'string' }, json: { type: 'string' }, think: { type: 'string' } } });
  if (values.think) THINK = values.think.split(',').map(Number) as [number, number];
  const levels = (values.levels ?? '10,30,60').split(',').map(Number);
  const duration = Number(values.duration ?? 180);
  const seed = Number(values.seed ?? 1);
  const state: { child: ChildProcess | null; tmp: string | null } = { child: null, tmp: null };
  const cleanup = () => {
    try {
      state.child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    if (state.tmp) rmSync(state.tmp, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => process.exit(130));
  process.on('uncaughtException', (e) => {
    console.error('未捕获错误：', e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => console.error('未处理的 Promise 拒绝：', e instanceof Error ? e.message : e));

  console.log(`压测：档位 ${levels.join('/')}，每档 ${duration}s 开新局 + 最多 45s 收尾，seed=${seed}，CPU 核数见 nproc`);
  const results: LevelResult[] = [];
  for (const lv of levels) {
    console.log(`\n>>> 开始档位 ${lv}`);
    const r = await runLevel(lv, duration, seed, state);
    printLevel(r);
    results.push(r);
    await sleep(2000);
  }
  console.log('\n══ 汇总 ══');
  console.log('档位 连接 结束/开始 峰值RSS(MB) CPU均/峰(%) act(p50/p95/p99) get_my_view_w0(p50/p95/p99) referee_step_w0(p50/p95/p99) 长轮询峰值 错误数');
  const tri = (m: Metrics, c: string) => {
    const a = m.lat.get(c) ?? [];
    return `${f(pct(a, 50), 1)}/${f(pct(a, 95), 1)}/${f(pct(a, 99), 1)}`;
  };
  for (const r of results) {
    const errs = [...r.m.errors.values()].reduce((a, b) => a + b, 0);
    console.log(`${String(r.level).padStart(3)} ${String(r.bots).padStart(5)} ${r.m.gamesEnded}/${r.m.gamesStarted} ${f(r.peakRssMb).padStart(6)} ${f(r.cpuAvgPct)}/${f(r.cpuPeak5sPct)} ${tri(r.m, 'act')} ${tri(r.m, 'get_my_view_w0')} ${tri(r.m, 'referee_step_w0')} ${r.m.peakPolls} ${errs}`);
  }
  if (values.json) {
    writeFileSync(
      values.json,
      JSON.stringify(
        results.map((r) => ({ ...r, m: { ...r.m, lat: Object.fromEntries([...r.m.lat].map(([k, a]) => [k, { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: Math.max(...a) }])), errors: Object.fromEntries(r.m.errors), byType: Object.fromEntries(r.m.byType) } })),
        null,
        2,
      ),
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
