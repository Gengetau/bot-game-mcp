/**
 * 黑盒端到端测试：把已构建的 dist/cli.js 当作独立进程启动，只通过 MCP 工具和公开 HTTP 接口与它交互，
 * 像真实的 QQ bot 一样玩完四款游戏，并检查泄密、投递合规、重启恢复、裁判接管等行为。
 *
 *   npm run build && npm run e2e [-- --seed 42] [-- --json out.json]
 *
 * 约束：只绑定 127.0.0.1；密钥运行时随机生成且不打印；临时目录（配置、存档）退出时一定删除；
 * 所有子进程在成功、失败、SIGINT、未捕获错误时都会被杀掉。不依赖引擎内部（GameManager 等）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { SeededRng, type Rng } from '../src/core/rng.js';

// ════════════════════════════════════════════════════════════════════════════
// 基础工具
// ════════════════════════════════════════════════════════════════════════════

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI = join(ROOT, 'dist', 'cli.js');
const T0 = Date.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 所有需要从输出里抹掉的密钥 */
const SECRETS: string[] = [];
const redact = (s: string): string => SECRETS.reduce((acc, k) => (k ? acc.split(k).join('***') : acc), s);
const errMsg = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

function log(tag: string, msg: string): void {
  console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${tag.padEnd(4)} ${redact(msg)}`);
}

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[rng.int(arr.length)]!;
const chance = (rng: Rng, p: number): boolean => rng.int(10_000) < p * 10_000;
const intBetween = (rng: Rng, lo: number, hi: number): number => lo + rng.int(hi - lo + 1);

/** 终端显示宽度（中日韩字符占两格） */
function dw(s: string): number {
  let n = 0;
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u.test(ch) ? 2 : 1;
  return n;
}
const padEnd = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - dw(s)));

class TransportError extends Error {}
class ToolError extends Error {}
class ProtocolError extends Error {}

// ════════════════════════════════════════════════════════════════════════════
// 环境：临时目录、端口、被测服务进程
// ════════════════════════════════════════════════════════════════════════════

interface AgentCfg {
  key: string;
  id: string;
  name: string;
}

interface Env {
  seed: string;
  tmp: string;
  port: number;
  base: string;
  mcpUrl: string;
  ref: AgentCfg;
  ais: AgentCfg[];
  adminKey: string;
  server: ServerProc;
  childPids: Set<number>;
  /** 服务进程退出时，通知所有进行中的调用（模拟「连接被重置」） */
  downWaiters: Set<(e: Error) => void>;
}

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

class ServerProc {
  child: ChildProcess | null = null;
  tail: string[] = [];
  starts = 0;
  private exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;

  constructor(private readonly env: () => Env, private readonly args: string[]) {}

  async start(): Promise<void> {
    const child = spawn(process.execPath, [CLI, 'serve', ...this.args], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
    this.child = child;
    this.starts++;
    if (child.pid) this.env().childPids.add(child.pid);
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim()) this.tail.push(redact(line));
      }
      if (this.tail.length > 200) this.tail.splice(0, this.tail.length - 200);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    this.exited = new Promise((res) => {
      child.once('exit', (code, signal) => {
        if (child.pid) this.env().childPids.delete(child.pid);
        // 连接被重置：让所有进行中的调用立刻失败
        for (const w of [...this.env().downWaiters]) w(new Error('server exited'));
        res({ code, signal });
      });
    });
    // 等 /health
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`服务进程提前退出（code=${child.exitCode}）：\n${this.tail.slice(-15).join('\n')}`);
      try {
        const r = await fetch(`${this.env().base}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return;
      } catch {
        // 还没起来
      }
      if (Date.now() > deadline) throw new Error(`服务 20 秒内没有就绪：\n${this.tail.slice(-15).join('\n')}`);
      await sleep(100);
    }
  }

  /** SIGTERM 并等它退出；超时则 SIGKILL。返回退出码与耗时。 */
  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number; killed: boolean }> {
    const child = this.child;
    if (!child || child.exitCode !== null || !this.exited) return { code: child?.exitCode ?? null, signal: null, ms: 0, killed: false };
    const t = Date.now();
    child.kill('SIGTERM');
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, 15_000);
    const r = await this.exited;
    clearTimeout(timer);
    return { ...r, ms: Date.now() - t, killed };
  }

  killNow(): void {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MCP 连接（可断线重连，三种传输）
// ════════════════════════════════════════════════════════════════════════════

type Kind = 'http' | 'sse' | 'bridge';

class Conn {
  client: Client | null = null;
  calls = 0;
  transportErrors = 0;
  connects = 0;

  constructor(
    private readonly env: Env,
    readonly label: string,
    readonly key: string,
    readonly kind: Kind = 'http',
    private readonly header: 'bearer' | 'x-api-key' = 'bearer',
  ) {}

  private makeTransport(): Transport {
    const { env, key } = this;
    if (this.kind === 'sse') {
      const u = new URL(`${env.base}/sse`);
      u.searchParams.set('key', key);
      return new SSEClientTransport(u);
    }
    if (this.kind === 'bridge') {
      const t = new StdioClientTransport({ command: process.execPath, args: [CLI, 'bridge', '--url', env.mcpUrl, '--key', key], stderr: 'pipe' });
      t.stderr?.on('data', () => undefined);
      return t;
    }
    const headers: Record<string, string> = this.header === 'x-api-key' ? { 'X-API-Key': key } : { Authorization: `Bearer ${key}` };
    return new StreamableHTTPClientTransport(new URL(env.mcpUrl), { requestInit: { headers } });
  }

  async ensureConnected(giveUp: number): Promise<void> {
    while (!this.client) {
      const client = new Client({ name: `e2e-${this.label}`, version: '1.0.0' });
      const transport = this.makeTransport();
      try {
        await Promise.race([
          client.connect(transport),
          sleep(10_000).then(() => {
            throw new Error('connect timeout');
          }),
        ]);
        this.client = client;
        this.connects++;
        const pid = (transport as StdioClientTransport).pid;
        if (this.kind === 'bridge' && typeof pid === 'number') this.env.childPids.add(pid);
        return;
      } catch (e) {
        await Promise.race([client.close().catch(() => undefined), sleep(1500)]);
        if (Date.now() > giveUp) throw new TransportError(`连接失败（${this.label}）：${errMsg(e)}`);
        await sleep(250);
      }
    }
  }

  private dropClient(): void {
    const c = this.client;
    this.client = null;
    if (c) void Promise.race([c.close().catch(() => undefined), sleep(1500)]);
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    const pid = (c.transport as StdioClientTransport | undefined)?.pid;
    await Promise.race([c.close().catch(() => undefined), sleep(2000)]);
    if (typeof pid === 'number') {
      this.env.childPids.delete(pid);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }
  }

  /**
   * 调用工具并解析 JSON 文本块。
   * - 工具错误（isError）抛 ToolError；
   * - 传输错误（断线、会话失效、超时）：retry=true 时重连重试，否则抛 TransportError（调用方自己决定怎么办）。
   */
  async call(name: string, args: Record<string, unknown> = {}, o: { retry?: boolean; timeoutMs?: number; deadlineMs?: number } = {}): Promise<any> {
    const retry = o.retry ?? true;
    const timeout = o.timeoutMs ?? 60_000;
    const giveUp = Date.now() + (o.deadlineMs ?? 60_000);
    for (;;) {
      await this.ensureConnected(giveUp);
      const client = this.client!;
      const ac = new AbortController();
      let waiter: ((e: Error) => void) | null = null;
      let res: any;
      try {
        this.calls++;
        const p = client.callTool({ name, arguments: args }, undefined, { timeout, signal: ac.signal });
        p.catch(() => undefined);
        const down = new Promise<never>((_, rej) => {
          waiter = rej;
          this.env.downWaiters.add(rej);
        });
        down.catch(() => undefined);
        res = await Promise.race([p, down]);
      } catch (e) {
        ac.abort();
        if (e instanceof McpError && e.code !== ErrorCode.ConnectionClosed && e.code !== ErrorCode.RequestTimeout) {
          throw new ProtocolError(`${name}: ${errMsg(e)}`);
        }
        this.transportErrors++;
        this.dropClient();
        if (!retry || Date.now() > giveUp) throw new TransportError(`${name}: ${errMsg(e)}`);
        await sleep(300);
        continue;
      } finally {
        if (waiter) this.env.downWaiters.delete(waiter);
      }
      const text: string = res?.content?.[0]?.text ?? '';
      if (res?.isError) throw new ToolError(text);
      try {
        return JSON.parse(text);
      } catch {
        throw new ToolError(`返回的不是 JSON：${text.slice(0, 200)}`);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 场景记录、检查、发现
// ════════════════════════════════════════════════════════════════════════════

interface Finding {
  kind: 'engine' | 'ux' | 'harness';
  title: string;
  evidence: string;
}
const FINDINGS = new Map<string, Finding>();

class Scenario {
  id = '';
  winner = '-';
  rounds = 0;
  transports = new Set<string>();
  deliveries = { group: 0, private: 0 };
  relays = { accepted: 0, rejected: 0, ignored: 0, transportFail: 0 };
  timeouts = 0;
  aiCount = 0;
  humanCount = 0;
  startedAt = Date.now();
  durationMs = 0;
  checks: { name: string; ok: boolean; detail: string }[] = [];
  notes: string[] = [];
  rejections: { phase: string; text: string; recognized: boolean; msg: string }[] = [];
  violations: string[] = [];
  conns: Conn[] = [];
  stopped = false;

  constructor(readonly tag: string, readonly title: string, readonly game: string) {}

  check(name: string, ok: boolean, detail = ''): boolean {
    this.checks.push({ name, ok, detail: redact(detail) });
    if (!ok) log(this.tag, `检查失败：${name}${detail ? ` —— ${detail}` : ''}`);
    return ok;
  }
  note(s: string): void {
    this.notes.push(redact(s));
  }
  finding(kind: Finding['kind'], key: string, title: string, evidence: string): void {
    const k = `${this.tag}:${key}`;
    if (!FINDINGS.has(k)) FINDINGS.set(k, { kind, title: `[${this.tag}] ${title}`, evidence: redact(evidence) });
  }
  conn(env: Env, label: string, key: string, kind: Kind = 'http', header: 'bearer' | 'x-api-key' = 'bearer'): Conn {
    const c = new Conn(env, `${this.tag}-${label}`, key, kind, header);
    this.conns.push(c);
    this.transports.add(kind === 'http' ? 'streamable-http' : kind === 'sse' ? 'legacy-sse' : 'stdio-bridge');
    return c;
  }
  async closeAll(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.conns.map((c) => c.close()));
  }
  get passed(): number {
    return this.checks.filter((c) => c.ok).length;
  }
  get failed(): number {
    return this.checks.filter((c) => !c.ok).length;
  }
}

async function httpJson(env: Env, path: string): Promise<any> {
  const r = await fetch(`${env.base}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return JSON.parse(await r.text());
}

// ════════════════════════════════════════════════════════════════════════════
// 假 QQ：群聊记录、真人私聊收件箱、投递合规检查
// ════════════════════════════════════════════════════════════════════════════

interface GroupLine {
  from: string;
  text: string;
  seq?: number;
}

class FakeQQ {
  group: GroupLine[] = [];
  inbox = new Map<string, { seq: number; category: string; text: string }[]>();
  /** 每个真人收件箱里已被 Human 处理过的位置 */
  playerIds = new Set<string>();
  humanIds = new Set<string>();

  constructor(private readonly sc: Scenario, readonly groupId: string) {}

  deliver(d: any): void {
    const segs: any[] | null = Array.isArray(d.message) ? d.message : null;
    if (!segs) {
      this.sc.violations.push(`seq=${d.seq} 的 onebot message 不是数组`);
      return;
    }
    let text = '';
    let plain = '';
    for (const s of segs) {
      if (s?.type === 'text') {
        text += String(s.data?.text ?? '');
        plain += String(s.data?.text ?? '');
      } else if (s?.type === 'at') {
        const qq = String(s.data?.qq ?? '');
        text += `[@${qq}]`;
        if (qq === 'all' || !this.playerIds.has(qq)) this.sc.violations.push(`seq=${d.seq} 出现不属于本局玩家的 @：qq=${qq}`);
      } else {
        this.sc.violations.push(`seq=${d.seq} 出现未知消息段 ${JSON.stringify(s).slice(0, 80)}`);
      }
    }
    if (/\[CQ:/i.test(plain)) this.sc.violations.push(`seq=${d.seq} 文本段里含可被解析的 CQ 码：${plain.slice(0, 120)}`);
    if (/\{@/.test(plain)) this.sc.violations.push(`seq=${d.seq} 文本里残留 {@ 占位符：${plain.slice(0, 120)}`);
    if (d.to === 'group') {
      if (String(d.group_id) !== this.groupId) this.sc.violations.push(`seq=${d.seq} 群消息发往了别的群 ${d.group_id}`);
      this.group.push({ from: '裁判', text, seq: d.seq });
      this.sc.deliveries.group++;
      if (/超时|托管|代猜|代为操作/.test(text)) this.sc.timeouts++;
    } else if (d.to === 'private') {
      const uid = String(d.user_id);
      if (!this.humanIds.has(uid)) this.sc.violations.push(`seq=${d.seq} 私聊发给了非真人 ${uid}`);
      const box = this.inbox.get(uid) ?? [];
      box.push({ seq: d.seq, category: String(d.category), text });
      this.inbox.set(uid, box);
      this.sc.deliveries.private++;
    } else {
      this.sc.violations.push(`seq=${d.seq} 未知投递目标 ${String(d.to)}`);
    }
  }

  post(from: string, text: string): void {
    this.group.push({ from, text });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 裁判循环（代码驱动，按 docs/CLIENTS.md §4.1）
// ════════════════════════════════════════════════════════════════════════════

interface RefHooks {
  /** 每处理完一批投递后调用（真人在这里行动） */
  afterStep?: (r: any, loop: RefereeLoop) => Promise<void>;
  onDelivery?: (d: any, text: string) => void;
}

class RefereeLoop {
  lastSeq = 0;
  steps = 0;
  received: number[] = [];
  transportFails = 0;
  gaps: string[] = [];
  finished = false;
  paused = false;
  private pauseReq = false;
  private pausedFn: (() => void) | null = null;
  private resumeFn: (() => void) | null = null;
  lastStepAt = 0;

  constructor(
    readonly sc: Scenario,
    public conn: Conn,
    readonly gameId: string,
    readonly qq: FakeQQ,
    readonly hooks: RefHooks = {},
    readonly stepWait = 20,
  ) {}

  /** 暂停轮询（模拟裁判失联）。resolve 时当前这一步已经结束。 */
  pause(): Promise<void> {
    this.pauseReq = true;
    return new Promise((res) => {
      if (this.paused) res();
      else this.pausedFn = res;
    });
  }
  resume(conn?: Conn): void {
    if (conn) this.conn = conn;
    this.pauseReq = false;
    this.paused = false;
    this.resumeFn?.();
    this.resumeFn = null;
  }

  private accept(r: any): void {
    const ds: any[] = r.deliveries ?? [];
    for (const d of ds) {
      if (d.seq <= this.lastSeq) {
        this.sc.violations.push(`裁判重复收到 seq=${d.seq}（已收到 ${this.lastSeq}）`);
        continue;
      }
      if (d.seq !== this.lastSeq + 1) this.sc.violations.push(`裁判收到的 seq 不连续：${this.lastSeq} 之后直接是 ${d.seq}`);
      this.lastSeq = d.seq;
      this.received.push(d.seq);
      this.qq.deliver(d);
      this.hooks.onDelivery?.(d, '');
    }
  }

  async run(): Promise<void> {
    let recovering = false;
    while (!this.sc.stopped) {
      if (this.pauseReq) {
        this.paused = true;
        this.pausedFn?.();
        this.pausedFn = null;
        await new Promise<void>((res) => (this.resumeFn = res));
        recovering = true;
      }
      const args: Record<string, unknown> = { game_id: this.gameId, wait_seconds: recovering ? 0 : this.stepWait, format: 'onebot' };
      let r: any;
      try {
        r = await this.conn.call('referee_step', args, { retry: false, timeoutMs: (this.stepWait + 40) * 1000 });
      } catch (e) {
        if (e instanceof TransportError) {
          this.transportFails++;
          recovering = true;
          await sleep(300);
          continue;
        }
        throw e;
      }
      this.steps++;
      this.lastStepAt = Date.now();
      if (recovering) {
        recovering = false;
        // 传输失败后第一次（不带 since_seq 的）调用：检查有没有丢消息
        const ds: any[] = r.deliveries ?? [];
        const first: number | undefined = ds[0]?.seq;
        const lostByCursor = ds.length === 0 && typeof r.last_seq === 'number' && r.last_seq > this.lastSeq;
        if ((ds.length > 0 && first !== this.lastSeq + 1) || lostByCursor) {
          const hi = ds.length > 0 ? first! - 1 : r.last_seq;
          const msg = `传输失败后，引擎的裁判游标已越过 seq ${this.lastSeq + 1}~${hi}，但这些消息没有交到裁判手里（响应在途中丢失）；用 since_seq=${this.lastSeq} 重发后恢复`;
          this.gaps.push(msg);
          r = await this.conn.call('referee_step', { game_id: this.gameId, wait_seconds: 0, format: 'onebot', since_seq: this.lastSeq }, { timeoutMs: 30_000 });
        }
      }
      this.accept(r);
      if (this.hooks.afterStep) await this.hooks.afterStep(r, this);
      if (r.finished) {
        this.finished = true;
        return;
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 真人模拟：只用裁判转发的自然语言，信息只来自私聊收件箱、群消息、阶段信息、waiting_for 与公开接口
// ════════════════════════════════════════════════════════════════════════════

interface HumanSpec {
  id: string;
  nick: string;
}

interface H extends HumanSpec {
  seat: number | null;
  role: string | null;
  roleMsg: string;
  lastPrompt: string;
  mates: number[];
  checks: Map<number, boolean>;
  witchVictim: number | null;
  word: string | null;
  inboxPos: number;
  attempts: Map<string, number>;
  chatted: Set<string>;
  spoke: Set<string>;
  chatter: number;
}

const INTENT: Record<string, RegExp> = {
  kill: /^[刀杀]\s*\d/,
  skipKill: /^空刀/,
  check: /^[验查]\s*\d/,
  guard: /^守\s*\d/,
  skipGuard: /^空守/,
  save: /^救$/,
  poison: /^毒\s*\d/,
  skipWitch: /^(不用|不救)/,
  shoot: /^开枪\s*\d/,
  noShoot: /^不开枪/,
  vote: /^投\s*\d/,
  abstain: /^弃票/,
  endSpeech: /^过$/,
};
/** 提示里找不到时才用的兜底说法（并记为体验问题） */
const FALLBACK: Record<string, (t?: number) => string> = {
  kill: (t) => `刀${t}`,
  skipKill: () => '空刀',
  check: (t) => `验${t}`,
  guard: (t) => `守${t}`,
  skipGuard: () => '空守',
  save: () => '救',
  poison: (t) => `毒${t}`,
  skipWitch: () => '不用',
  shoot: (t) => `开枪${t}`,
  noShoot: () => '不开枪',
  vote: (t) => `投${t}号`,
  abstain: () => '弃票',
  endSpeech: () => '过',
};

const SPEECH_LINES = [
  '我觉得前面几位的发言都比较平，先听听后面的人怎么说。',
  '昨晚的信息不多，我这边没有特别可疑的人。',
  '我先说一下我的想法，大家别急着站队。',
  '感觉有人在划水，希望后面发言的人说得具体一点。',
  '我是好人，这点我可以保证。',
];
const DESCRIBE_LINES = ['这个东西平时挺常见的', '大部分人应该都接触过', '我个人还算比较喜欢', '说不上特别但也不陌生', '一般在生活里会碰到'];
const AI_PHRASES = ['我先观察一下局势，暂时没有强烈的倾向。', '信息还不够，我先划水，请大家多给点线索。', '前面的发言有些地方值得再推敲。', '我倾向于相信大多数人的说法。'];
const AI_DESCRIBE = ['平时偶尔会碰到的东西', '很多人都熟悉它', '说不上特别喜欢也不讨厌', '日常生活里不算少见'];

class Humans {
  list: H[] = [];
  bySeat = new Map<number, H>();
  seatsMapped = false;
  getRef: () => RefereeLoop;
  aliveCache: { at: number; seats: number[] } = { at: 0, seats: [] };
  /** 公开接口快照（用于泄密检查）：[状态, 原始 JSON] */
  snapshots: { status: string; json: string }[] = [];
  lastGroupSeen = 0;

  constructor(
    private readonly env: Env,
    private readonly sc: Scenario,
    private readonly qq: FakeQQ,
    private readonly rng: Rng,
    specs: HumanSpec[],
    private readonly gameId: string,
    private readonly refQQ: string,
    private readonly refName: string,
    getRef: () => RefereeLoop,
  ) {
    this.getRef = getRef;
    this.list = specs.map((s) => ({
      ...s,
      seat: null,
      role: null,
      roleMsg: '',
      lastPrompt: '',
      mates: [],
      checks: new Map(),
      witchVictim: null,
      word: null,
      inboxPos: 0,
      attempts: new Map(),
      chatted: new Set(),
      spoke: new Set(),
      chatter: 0,
    }));
  }

  // ───── 从收到的消息里学习（真人只能看到自己的私聊和群消息） ─────
  observe(): void {
    if (!this.seatsMapped) {
      for (const line of this.qq.group) {
        if (!line.text.includes('座位表')) continue;
        for (const m of line.text.matchAll(/(\d+)号 \[@(\d+)\]/g)) {
          const h = this.list.find((x) => x.id === m[2]);
          if (h) h.seat = Number(m[1]);
        }
        this.seatsMapped = this.list.every((h) => h.seat !== null);
        this.bySeat = new Map(this.list.filter((h) => h.seat !== null).map((h) => [h.seat!, h]));
        break;
      }
    }
    for (const h of this.list) {
      const box = this.qq.inbox.get(h.id) ?? [];
      for (; h.inboxPos < box.length; h.inboxPos++) {
        const m = box[h.inboxPos]!;
        const role = m.text.match(/你的身份是【(.+?)】/);
        if (role) {
          h.role = role[1]!;
          h.roleMsg = m.text;
        }
        const mates = m.text.match(/你的狼队友：(.+?)。/);
        if (mates) h.mates = [...mates[1]!.matchAll(/(\d+)号/g)].map((x) => Number(x[1]));
        const chk = m.text.match(/查验结果：(\d+)号 是【(.+?)】/);
        if (chk) h.checks.set(Number(chk[1]), chk[2] === '狼人');
        const word = m.text.match(/你的词是：「(.+?)」/);
        if (word) h.word = word[1]!;
        if (m.category === 'prompt') {
          h.lastPrompt = m.text;
          const v = m.text.match(/今晚 (\d+)号 被狼人袭击/);
          h.witchVictim = v ? Number(v[1]) : null;
        }
      }
    }
  }

  private recentGroup(n: number): string[] {
    return this.qq.group
      .filter((l) => l.from === '裁判')
      .slice(-n)
      .map((l) => l.text)
      .reverse();
  }

  private async alive(): Promise<number[]> {
    if (Date.now() - this.aliveCache.at < 150) return this.aliveCache.seats;
    const j = await httpJson(this.env, `/api/games/${this.gameId}`);
    this.snapshots.push({ status: String(j?.summary?.status), json: JSON.stringify(j) });
    const seats = (j.players as any[]).filter((p) => p.alive).map((p) => p.seat as number);
    this.aliveCache = { at: Date.now(), seats };
    return seats;
  }

  /** 从提示里找「…」模板；找不到才用兜底，并记录体验问题。 */
  private cmd(h: H, intent: string, target: number | undefined, sources: string[], ctx: string): string {
    const re = INTENT[intent]!;
    for (const src of sources) {
      for (const m of src.matchAll(/「([^」]+)」/g)) {
        const t = m[1]!.trim();
        if (re.test(t)) return target !== undefined ? t.replace(/\d+/, String(target)) : t;
      }
    }
    this.sc.finding('ux', `nocmd:${ctx}:${intent}`, `${ctx}：提示里没有告诉真人（${h.role ?? '玩家'}）该发什么指令（期望出现类似「${FALLBACK[intent]!(3)}」的写法）`, `来源文本：${sources[0]?.replace(/\n/g, ' ⏎ ').slice(0, 300) ?? '(无)'}`);
    return FALLBACK[intent]!(target);
  }

  /** 真实 QQ 噪声：开头的回复引用和 @裁判 */
  private noise(text: string): string {
    const reply = '[CQ:reply,id=12345]';
    const at = `[CQ:at,qq=${this.refQQ}]`;
    switch (this.rng.int(6)) {
      case 0:
        return `${reply}${text}`;
      case 1:
        return `${at} ${text}`;
      case 2:
        return `${reply}${at} ${text}`;
      case 3:
        return `@${this.refName} ${text}`;
      default:
        return text;
    }
  }

  private async relay(h: H, text: string, channel: 'group' | 'private', phase: string, kind: 'cmd' | 'chatter' = 'cmd'): Promise<{ accepted: boolean; recognized: boolean } | null> {
    const full = this.noise(text);
    let res: any;
    try {
      res = await this.getRef().conn.call('relay_human_message', { game_id: this.gameId, qq_id: h.id, nickname: h.nick, text: full, channel }, { retry: false, timeoutMs: 30_000 });
    } catch (e) {
      if (e instanceof TransportError) {
        this.sc.relays.transportFail++;
        return null;
      }
      if (e instanceof ToolError) {
        this.sc.relays.rejected++;
        this.sc.rejections.push({ phase, text: full, recognized: false, msg: `ToolError: ${e.message}` });
        return { accepted: false, recognized: false };
      }
      throw e;
    }
    if (channel === 'group') this.qq.post(`真人${h.nick}`, full);
    const msg = String(res.message ?? '');
    if (/\[CQ:/i.test(msg) || /\{@/.test(msg)) this.sc.violations.push(`relay 返回给裁判的文字里含可被解析的 CQ 码或 {@：${msg.slice(0, 120)}`);
    if (res.accepted) this.sc.relays.accepted++;
    else if (kind === 'chatter' && !res.recognized) this.sc.relays.ignored++;
    else {
      this.sc.relays.rejected++;
      this.sc.rejections.push({ phase, text: full, recognized: Boolean(res.recognized), msg });
      if (!res.recognized) {
        this.sc.finding('ux', `unparsed:${phase}:${text}`, `阶段「${phase}」里真人按提示发的「${text}」没有被识别为指令`, `发送：${full}；引擎回复：${msg}`);
      }
    }
    return { accepted: Boolean(res.accepted), recognized: Boolean(res.recognized) };
  }

  /** 依次尝试候选目标，被拒就换一个，最后退回 skip。 */
  private async tryTargets(h: H, phase: string, channel: 'group' | 'private', cands: number[], mk: (t: number) => string, skipText: string | null): Promise<boolean> {
    const left = [...cands];
    for (let i = 0; i < 4 && left.length > 0; i++) {
      const t = left.splice(this.rng.int(left.length), 1)[0]!;
      const r = await this.relay(h, mk(t), channel, phase);
      if (!r) return false;
      if (r.accepted) return true;
    }
    if (skipText) {
      const r = await this.relay(h, skipText, channel, phase);
      return Boolean(r?.accepted);
    }
    return false;
  }

  // ───── 每次裁判拿到消息后，轮到谁就替谁行动 ─────
  async afterStep(r: any, gameKind: 'werewolf' | 'undercover' | 'number_bomb'): Promise<void> {
    this.observe();
    if (!this.seatsMapped) return;
    const phase = r.phase;
    const pend: { seat: number; channel: 'group' | 'private' }[] = (r.waiting_for as string[])
      .filter((s) => s.includes('真人'))
      .map((s) => ({ seat: Number(s.match(/^(\d+)号/)?.[1] ?? 0), channel: /需在私聊/.test(s) ? ('private' as const) : ('group' as const) }));
    const waitingSeats = new Set(pend.map((p) => p.seat));
    if (phase && phase.open) {
      for (const p of pend) {
        const h = this.bySeat.get(p.seat);
        if (!h) {
          this.sc.note(`waiting_for 里出现未知真人座位 ${p.seat}`);
          continue;
        }
        const k = `${phase.title}`;
        const n = (h.attempts.get(k) ?? 0) + 1;
        h.attempts.set(k, n);
        if (n > 8) {
          if (n === 9) this.sc.check(`真人 ${h.nick} 在「${k}」没有卡住`, false, `连续 ${n - 1} 次尝试后引擎仍在等他`);
          continue;
        }
        if (gameKind === 'werewolf') await this.actWerewolf(h, phase, p.channel);
        else if (gameKind === 'undercover') await this.actUndercover(h, phase, p.channel);
        else await this.actNumberBomb(h, phase, p.channel);
      }
    }
    // 偶尔在群里闲聊（不该被当成指令）
    for (const h of this.list) {
      if (waitingSeats.has(h.seat ?? -1) || h.chatter >= 3 || !chance(this.rng, 0.04)) continue;
      h.chatter++;
      const res = await this.relay(h, pick(this.rng, ['哈哈哈这局有意思', '笑死我了', '大家加油']), 'group', '闲聊', 'chatter');
      if (res?.accepted) this.sc.finding('engine', 'chatter-accepted', '真人在不该说话的时候闲聊被当成了指令', `${h.nick} 发「闲聊」被 accepted=true，阶段 ${phase?.title ?? '?'}`);
    }
  }

  // ───── 狼人杀 ─────
  private async actWerewolf(h: H, phase: any, channel: 'group' | 'private'): Promise<void> {
    const key: string = phase.key;
    const title: string = phase.title;
    const seat = h.seat!;
    const alive = await this.alive();
    const others = alive.filter((s) => s !== seat);
    const groupSrc = this.recentGroup(8);
    const sources = [h.lastPrompt, ...groupSrc, h.roleMsg];
    if (key === 'night') {
      if (h.role === '狼人') {
        if (!h.chatted.has(title) && chance(this.rng, 0.5)) {
          h.chatted.add(title);
          await this.relay(h, '今晚刀谁比较好？', channel, title);
        }
        const cands = others.filter((s) => !h.mates.includes(s));
        const skip = this.cmd(h, 'skipKill', undefined, sources, title);
        if (chance(this.rng, 0.9) && cands.length > 0) await this.tryTargets(h, title, channel, cands, (t) => this.cmd(h, 'kill', t, sources, title), skip);
        else await this.relay(h, skip, channel, title);
      } else if (h.role === '预言家') {
        const fresh = others.filter((s) => !h.checks.has(s));
        await this.tryTargets(h, title, channel, fresh.length ? fresh : others, (t) => this.cmd(h, 'check', t, sources, title), null);
      } else if (h.role === '守卫') {
        await this.tryTargets(h, title, channel, alive, (t) => this.cmd(h, 'guard', t, sources, title), this.cmd(h, 'skipGuard', undefined, sources, title));
      } else {
        this.sc.note(`${h.nick}（${h.role}）在夜晚被引擎等待，不符合其身份`);
      }
    } else if (key === 'witch') {
      const canSave = /「救」/.test(h.lastPrompt);
      const canPoison = /「毒\d/.test(h.lastPrompt);
      const roll = this.rng.int(100);
      if (canSave && roll < 45) await this.relay(h, this.cmd(h, 'save', undefined, sources, title), channel, title);
      else if (canPoison && roll >= 45 && roll < 70 && others.length > 0) await this.tryTargets(h, title, channel, others, (t) => this.cmd(h, 'poison', t, sources, title), this.cmd(h, 'skipWitch', undefined, sources, title));
      else await this.relay(h, this.cmd(h, 'skipWitch', undefined, sources, title), channel, title);
    } else if (key === 'hunter') {
      if (chance(this.rng, 0.8) && others.length > 0) await this.tryTargets(h, title, channel, others, (t) => this.cmd(h, 'shoot', t, sources, title), this.cmd(h, 'noShoot', undefined, sources, title));
      else await this.relay(h, this.cmd(h, 'noShoot', undefined, sources, title), channel, title);
    } else if (key === 'vote' || key === 'pk_vote') {
      let cands = others;
      const tied = groupSrc.find((t) => /投给[\d号、\s]+之一/.test(t))?.match(/投给([\d号、\s]+)之一/)?.[1];
      if (key === 'pk_vote' && tied) cands = [...tied.matchAll(/(\d+)号/g)].map((m) => Number(m[1])).filter((s) => s !== seat && alive.includes(s));
      if (chance(this.rng, 0.1) || cands.length === 0) await this.relay(h, this.cmd(h, 'abstain', undefined, sources, title), channel, title);
      else {
        // 偶尔私聊投票（提示里说了可以）
        const ch = chance(this.rng, 0.3) ? 'private' : channel;
        await this.tryTargets(h, title, ch, cands, (t) => this.cmd(h, 'vote', t, sources, title), this.cmd(h, 'abstain', undefined, sources, title));
      }
    } else if (key === 'speech' || key === 'last_words' || key === 'pk_speech') {
      if (!h.spoke.has(title)) {
        h.spoke.add(title);
        await this.relay(h, pick(this.rng, SPEECH_LINES), channel, title);
      }
      await this.relay(h, this.cmd(h, 'endSpeech', undefined, sources, title), channel, title);
    } else {
      this.sc.note(`未处理的阶段 ${key}（${title}）正在等真人 ${h.nick}`);
    }
  }

  // ───── 谁是卧底 ─────
  private async actUndercover(h: H, phase: any, channel: 'group' | 'private'): Promise<void> {
    const key: string = phase.key;
    const title: string = phase.title;
    const alive = await this.alive();
    const others = alive.filter((s) => s !== h.seat);
    const sources = [h.lastPrompt, ...this.recentGroup(8)];
    if (key === 'describe' || key === 'pk_describe') {
      await this.relay(h, pick(this.rng, DESCRIBE_LINES), 'group', title);
    } else if (key === 'vote' || key === 'pk_vote') {
      if (chance(this.rng, 0.1)) await this.relay(h, this.cmd(h, 'abstain', undefined, sources, title), channel, title);
      else await this.tryTargets(h, title, channel, others, (t) => this.cmd(h, 'vote', t, sources, title), this.cmd(h, 'abstain', undefined, sources, title));
    } else this.sc.note(`未处理的阶段 ${key}（${title}）正在等真人 ${h.nick}`);
  }

  // ───── 数字炸弹 ─────
  private async actNumberBomb(h: H, phase: any, channel: 'group' | 'private'): Promise<void> {
    const title: string = phase.title;
    let lo = 1;
    let hi = 100;
    for (const t of this.recentGroup(6)) {
      const m = t.match(/范围\s*(\d+)\s*~\s*(\d+)/);
      if (m) {
        lo = Number(m[1]);
        hi = Number(m[2]);
        break;
      }
    }
    const n = intBetween(this.rng, lo, hi);
    const style = this.rng.int(3);
    const text = style === 0 ? String(n) : style === 1 ? `猜${n}` : `我猜${n}`;
    await this.relay(h, text, channel, title);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// AI 玩家（各自一个 MCP 客户端，只根据 get_my_view 的 todo 行动）
// ════════════════════════════════════════════════════════════════════════════

interface AiOpts {
  selfPost: boolean;
  label: string;
}

class AiPlayer {
  finalView: any = null;
  errors = 0;
  acted = 0;
  speeches: string[] = [];
  word: string | null = null;
  viewSnaps: string[] = [];
  teamChatted = new Set<string>();
  triedForbidden = false;

  constructor(
    readonly sc: Scenario,
    readonly conn: Conn,
    readonly gameId: string,
    readonly qq: FakeQQ,
    readonly rng: Rng,
    readonly cfg: AgentCfg,
    readonly o: AiOpts,
    readonly game: 'werewolf' | 'undercover' | 'liars_dice' | 'number_bomb',
    readonly tryForbiddenWord = false,
  ) {}

  async run(): Promise<void> {
    let fails = 0;
    while (!this.sc.stopped) {
      let v: any;
      try {
        v = await this.conn.call('get_my_view', { game_id: this.gameId, wait_seconds: 20 }, { timeoutMs: 60_000, deadlineMs: 90_000 });
      } catch (e) {
        if (e instanceof ToolError && fails++ < 20) {
          await sleep(300);
          continue;
        }
        throw e;
      }
      if (v.game?.status !== 'running') {
        this.finalView = v;
        return;
      }
      if (this.game === 'undercover' && v.you && 'word' in v.you) {
        this.word = v.you.word ?? null;
        this.viewSnaps.push(JSON.stringify({ game: v.game, players: v.players, public: v.public, events: v.new_events }));
      }
      if (!v.your_turn || !v.todo) continue;
      try {
        await this.turn(v);
        fails = 0;
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        this.errors++;
        if (++fails > 12) throw new Error(`${this.o.label} 连续行动失败：${e.message}`);
        await sleep(150);
      }
    }
  }

  private async turn(v: any): Promise<void> {
    const todo = v.todo;
    const gid = this.gameId;
    if (todo.kind === 'speech') {
      let text = pick(this.rng, this.game === 'undercover' ? AI_DESCRIBE : AI_PHRASES);
      if (this.tryForbiddenWord && this.word && !this.triedForbidden) {
        // 故意说出自己的词：引擎应拒绝（forbid_word），且这句话不能出现在群里
        this.triedForbidden = true;
        try {
          await this.conn.call('speak', { game_id: gid, text: `其实就是${this.word}啊` }, { retry: false });
          this.sc.check('AI 说出自己的词应被引擎拒绝', false, '说出自己的词的发言被接受了');
        } catch (e) {
          this.sc.check('AI 说出自己的词应被引擎拒绝', e instanceof ToolError, errMsg(e));
        }
      }
      if (this.game === 'werewolf') text = `${text}（${v.you?.seat}号）`;
      const res = await this.conn.call('speak', { game_id: gid, text }, { retry: false });
      this.speeches.push(text);
      this.acted++;
      if (this.o.selfPost) {
        if (!res.post_to_group) this.sc.check(`self_post=true 的 ${this.o.label} 发言后应得到 post_to_group 提示`, false, JSON.stringify(res).slice(0, 200));
        else this.qq.post(`${v.you.seat}号 ${this.cfg.name}`, text);
      } else if (res.post_to_group) {
        this.sc.check(`self_post=false 的 ${this.o.label} 发言后不应有 post_to_group 提示`, false, JSON.stringify(res).slice(0, 200));
      }
      return;
    }
    const actions: any[] = todo.actions ?? [];
    if (this.game === 'liars_dice') return void (await this.liarsDice(v));
    if (this.game === 'number_bomb') {
      const range = String(actions[0]?.params?.number ?? '').match(/(\d+)\s*~\s*(\d+)/);
      const lo = range ? Number(range[1]) : 1;
      const hi = range ? Number(range[2]) : 100;
      await this.conn.call('act', { game_id: gid, action: 'guess', number: intBetween(this.rng, lo, hi) }, { retry: false });
      this.acted++;
      return;
    }
    // 狼人杀 / 卧底：优先真正的动作，随机目标
    const real = actions.filter((a) => !['skip', 'team_chat', 'speech', 'end_speech'].includes(a.action));
    const skip = actions.find((a) => a.action === 'skip');
    const team = actions.find((a) => a.action === 'team_chat');
    const title = String(v.game?.phase?.title ?? '');
    if (team && !this.teamChatted.has(title) && chance(this.rng, 0.4)) {
      this.teamChatted.add(title);
      await this.conn.call('speak', { game_id: gid, text: '今晚刀谁？', channel: 'team' }, { retry: false });
    }
    const choice = real.length > 0 ? pick(this.rng, real) : skip;
    if (!choice) return;
    const body: Record<string, unknown> = { game_id: gid, action: choice.action };
    if (Array.isArray(choice.targets) && choice.targets.length > 0) body.target = pick(this.rng, choice.targets);
    await this.conn.call('act', body, { retry: false });
    this.acted++;
  }

  private async liarsDice(v: any): Promise<void> {
    const pub = v.public ?? {};
    const cur = pub.current_bid;
    const min = pub.min_next_bid;
    let body: Record<string, unknown>;
    if (!cur) {
      body = { action: 'bid', quantity: pub.min_open_quantity ?? 1, face: intBetween(this.rng, 1, 6) };
    } else if (!min || chance(this.rng, 0.45)) {
      body = { action: 'challenge' };
    } else {
      body = { action: 'bid', quantity: min.quantity, face: min.face };
    }
    await this.conn.call('act', { game_id: this.gameId, ...body }, { retry: false });
    this.acted++;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 通用：开房、报名、开局
// ════════════════════════════════════════════════════════════════════════════

async function lobby(
  env: Env,
  sc: Scenario,
  refConn: Conn,
  type: string,
  groupId: string,
  options: Record<string, unknown>,
  ais: { conn: Conn; selfPost: boolean }[],
  humans: HumanSpec[],
): Promise<string> {
  const created = await refConn.call('create_game', { game_type: type, group_id: groupId, join_as: 'referee', options });
  const gameId: string = created.summary.game_id;
  sc.id = gameId;
  sc.check('create_game 返回招呼群友的 group_message', typeof created.group_message === 'string' && created.group_message.includes('加入'), String(created.group_message).slice(0, 80));
  for (const a of ais) await a.conn.call('join_game', { game_id: gameId, join_as: 'player', self_post: a.selfPost });
  // 同一个群不能同时开第二局
  try {
    await refConn.call('create_game', { game_type: type, group_id: groupId, join_as: 'referee' }, { retry: false });
    sc.check('同一个群不能同时开第二局', false, '第二次 create_game 竟然成功了');
  } catch (e) {
    sc.check('同一个群不能同时开第二局', e instanceof ToolError, errMsg(e));
  }
  // 报名阶段：群里闲聊不应被当成指令
  const idle = await refConn.call('relay_human_message', { game_id: gameId, qq_id: humans[0]?.id ?? '29999', nickname: humans[0]?.nick ?? 'x', text: '今天天气不错', channel: 'group' });
  sc.check('报名阶段的闲聊被忽略', idle.accepted === false && idle.recognized === false, JSON.stringify(idle).slice(0, 120));
  for (const [i, h] of humans.entries()) {
    const text = i === 0 ? `[CQ:reply,id=777][CQ:at,qq=${env.ref.id}] 加入` : '加入';
    const r = await refConn.call('relay_human_message', { game_id: gameId, qq_id: h.id, nickname: h.nick, text, channel: 'group' });
    sc.check(`真人 ${i + 1} 报名「加入」被接受`, r.accepted === true, JSON.stringify(r).slice(0, 160));
    if (/\[CQ:/i.test(String(r.message))) sc.violations.push(`报名回执里含可解析的 CQ 码：${String(r.message).slice(0, 120)}`);
  }
  // 重复报名应幂等
  if (humans[1]) {
    const again = await refConn.call('relay_human_message', { game_id: gameId, qq_id: humans[1].id, nickname: humans[1].nick, text: '加入', channel: 'group' });
    sc.check('重复报名是幂等的', again.accepted === true, JSON.stringify(again).slice(0, 120));
  }
  const view = await refConn.call('get_my_view', { game_id: gameId });
  const lobbyNames: string[] = (view.lobby ?? []).map((e: any) => e.name);
  sc.check('大厅名单包含所有真人和 AI', lobbyNames.length === ais.length + humans.length + 1, `大厅 ${lobbyNames.length} 人，期望 ${ais.length + humans.length + 1}（含裁判）`);
  const started = await refConn.call('start_game', { game_id: gameId });
  sc.check('抽签后裁判就是报名的裁判 bot', started.referee?.id === env.ref.id, JSON.stringify(started.referee));
  return gameId;
}

function prepareQQ(sc: Scenario, groupId: string, env: Env, ais: AgentCfg[], humans: HumanSpec[]): FakeQQ {
  const qq = new FakeQQ(sc, groupId);
  for (const a of ais) qq.playerIds.add(a.id);
  for (const h of humans) {
    qq.playerIds.add(h.id);
    qq.humanIds.add(h.id);
  }
  void env;
  return qq;
}

async function finishInfo(sc: Scenario, refConn: Conn, gameId: string): Promise<any> {
  const v = await refConn.call('get_my_view', { game_id: gameId });
  sc.rounds = v.game?.round ?? 0;
  sc.winner = v.result?.winnerTeam ?? (v.game?.status === 'aborted' ? '(中止)' : '-');
  sc.check('对局正常结束并产生胜负', v.game?.status === 'ended' && Boolean(v.result?.winnerTeam), `status=${v.game?.status} winner=${v.result?.winnerTeam}`);
  return v;
}

function commonChecks(sc: Scenario, loop: RefereeLoop, opts: { expectTimeouts?: number } = {}): void {
  sc.check('投递合规（只 @ 本局玩家、无 qq=all、无可解析 CQ 码、私聊只发给真人、不串群）', sc.violations.length === 0, sc.violations.slice(0, 3).join('；'));
  sc.check(`超时/托管公告 ${opts.expectTimeouts ?? 0} 次`, sc.timeouts === (opts.expectTimeouts ?? 0), `实际 ${sc.timeouts} 次`);
  const seqs = loop.received;
  const contiguous = seqs.every((s, i) => s === i + 1);
  sc.check('裁判收到每个 outbox seq 恰好一次且连续', contiguous && new Set(seqs).size === seqs.length, `共 ${seqs.length} 条，末尾 seq=${seqs[seqs.length - 1] ?? 0}`);
  if (sc.rejections.length > 0) {
    sc.check('真人按提示发的指令都被接受（无拒绝）', false, sc.rejections.slice(0, 3).map((r) => `[${r.phase}] ${r.text} → ${r.msg}`).join('；'));
  } else sc.check('真人按提示发的指令都被接受（无拒绝）', true);
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 1：启动与认证
// ════════════════════════════════════════════════════════════════════════════

async function scenarioStartup(env: Env): Promise<Scenario> {
  const sc = new Scenario('S1', '启动与认证', '-');
  const h = await httpJson(env, '/health');
  sc.check('/health 正常且 auth_mode=keys', h.ok === true && h.auth_mode === 'keys', JSON.stringify(h));
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  const post = async (headers: Record<string, string>) =>
    fetch(env.mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: init, signal: AbortSignal.timeout(8000) });
  sc.check('不带密钥 initialize 被拒（401）', (await post({})).status === 401);
  sc.check('错误密钥 initialize 被拒（401）', (await post({ Authorization: 'Bearer wrong-key-0123456789' })).status === 401);
  sc.check('错误密钥走 X-API-Key 也被拒', (await post({ 'X-API-Key': 'wrong-key-0123456789' })).status === 401);
  sc.check('旧版 SSE 不带密钥被拒（401）', (await fetch(`${env.base}/sse`, { signal: AbortSignal.timeout(8000) })).status === 401);
  sc.check('旧版 SSE 错误密钥被拒（401）', (await fetch(`${env.base}/sse?key=wrong-key-0123456789`, { signal: AbortSignal.timeout(8000) })).status === 401);
  // SDK 客户端同样应该连不上
  const bad = new Conn(env, 'bad', 'wrong-key-0123456789');
  let rejected = false;
  try {
    await bad.ensureConnected(Date.now() + 500);
  } catch {
    rejected = true;
  }
  sc.check('SDK 客户端用错误密钥连不上', rejected);
  await bad.close();

  const ref = sc.conn(env, 'ref', env.ref.key);
  const who = await ref.call('whoami');
  sc.check('keys 模式下密钥绑定身份（裁判 bot）', who.identity?.id === env.ref.id && who.auth_mode === 'keys', JSON.stringify(who.identity));
  const tools = await ref.client!.listTools();
  sc.check('暴露 17 个工具', tools.tools.length === 17, `实际 ${tools.tools.length}`);
  let loginRefused = false;
  try {
    await ref.call('login', { qq_id: '1', nickname: 'x' }, { retry: false });
  } catch (e) {
    loginRefused = e instanceof ToolError;
  }
  sc.check('keys 模式下 login 被拒绝', loginRefused);
  const admin = sc.conn(env, 'admin', env.adminKey);
  const aw = await admin.call('whoami');
  sc.check('管理员密钥得到管理员身份', aw.identity?.admin === true, JSON.stringify(aw.identity));
  const pub = await httpJson(env, '/api/games');
  sc.check('公开接口 /api/games 不需要密钥', Array.isArray(pub.games));
  await sc.closeAll();
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 2：狼人杀 9 人（7 AI + 2 真人）+ 中途重启
// ════════════════════════════════════════════════════════════════════════════

async function scenarioWerewolf(env: Env, rng: Rng): Promise<Scenario> {
  const sc = new Scenario('S2', '狼人杀', 'werewolf');
  const groupId = '100001';
  const humanSpecs: HumanSpec[] = [
    { id: '20001', nick: '坏人{@1}[CQ:at,qq=all]' },
    { id: '20002', nick: '阿福' },
  ];
  const aiCfgs = env.ais.slice(0, 7);
  sc.aiCount = 7;
  sc.humanCount = 2;
  const qq = prepareQQ(sc, groupId, env, aiCfgs, humanSpecs);
  for (const h of humanSpecs) qq.humanIds.add(h.id);

  const refConn = sc.conn(env, 'ref', env.ref.key);
  const ais = aiCfgs.map((cfg, i) => ({ cfg, selfPost: i % 2 === 0, conn: sc.conn(env, `ai${i + 1}`, cfg.key, 'http', i % 3 === 2 ? 'x-api-key' : 'bearer') }));
  const options = { night_min_s: 0, speech_gap_ms: 200, night_timeout_s: 40, witch_timeout_s: 30, speech_timeout_s: 30, vote_timeout_s: 30, last_words_timeout_s: 30, hunter_timeout_s: 20, pk_speech_timeout_s: 30 };
  const gameId = await lobby(env, sc, refConn, 'werewolf', groupId, options, ais.map((a) => ({ conn: a.conn, selfPost: a.selfPost })), humanSpecs);
  log('S2', `狼人杀 ${gameId} 开局：9 人（7 AI + 2 真人）`);

  // 重启控制
  let restartPromise: Promise<void> | null = null;
  let restartInfo = '';
  let dayReached = false;
  const doRestart = async () => {
    await sleep(250);
    log('S2', '第 2 天（或步数到达）：SIGTERM 服务并在同一端口重启');
    const r = await env.server.stop();
    sc.check('SIGTERM 后服务干净退出（exit 0，15 秒内）', r.code === 0 && !r.killed, `code=${r.code} signal=${r.signal} killed=${r.killed} ms=${r.ms}`);
    await env.server.start();
    restartInfo = `停机 ${r.ms}ms，重启后 /health 恢复`;
    log('S2', '服务已在同一端口恢复，客户端重连中');
  };

  let loop!: RefereeLoop;
  const humans = new Humans(env, sc, qq, new SeededRng(`${env.seed}:humans`), humanSpecs, gameId, env.ref.id, env.ref.name, () => loop);
  loop = new RefereeLoop(sc, refConn, gameId, qq, {
    onDelivery: (d) => {
      const t = qq.group[qq.group.length - 1]?.text ?? '';
      if (d.to === 'group' && /第2天/.test(t)) dayReached = true;
    },
    afterStep: async (r) => {
      await humans.afterStep(r, 'werewolf');
      if (!restartPromise && (dayReached || loop.steps >= 45)) restartPromise = doRestart();
    },
  });

  const players = ais.map((a, i) => new AiPlayer(sc, a.conn, gameId, qq, new SeededRng(`${env.seed}:ww-ai${i}`), a.cfg, { selfPost: a.selfPost, label: `AI${i + 1}` }, 'werewolf'));
  await Promise.all([loop.run(), ...players.map((p) => p.run())]);
  if (restartPromise) await restartPromise;

  // ───── 检查 ─────
  sc.check('中途重启确实发生', Boolean(restartPromise), restartInfo || '没有触发重启');
  if (loop.gaps.length > 0) {
    sc.finding('engine', 'restart-gap', '重启（连接中断）后裁判游标越过了未送达的消息', loop.gaps.join(' | '));
    sc.note(`重启期间发生过消息丢失并经 since_seq 恢复：${loop.gaps[0]}`);
  } else sc.note('重启期间没有丢消息（裁判在途请求没有造成游标前移）');
  commonChecks(sc, loop);
  const v = await finishInfo(sc, refConn, gameId);
  sc.check('两名真人都收到了身份私聊', humans.list.every((h) => h.role !== null), humans.list.map((h) => `${h.nick}:${h.role}`).join(','));
  // 恶意昵称：群消息里不能出现可解析的 CQ 码，且不会 @ 到 qq=all
  const hostileLine = qq.group.find((l) => l.text.includes('坏人'));
  sc.check('恶意昵称出现在群消息里时已被清洗', Boolean(hostileLine) && !/\[CQ:/i.test(hostileLine!.text), hostileLine?.text.slice(0, 100) ?? '群消息里没有出现该昵称');
  if (hostileLine) sc.note(`恶意昵称在群里显示为：${hostileLine.text.split('\n').find((x) => x.includes('坏人'))?.slice(0, 80)}`);
  // 公开接口里不能有人类玩家的身份牌
  const leaked = humans.snapshots.filter((s) => s.status === 'running').some((s) => humans.list.some((h) => h.roleMsg && s.json.includes(h.roleMsg.split('\n')[0]!)));
  sc.check('对局进行中公开接口不含真人身份牌', !leaked);
  const roleLeakGroup = qq.group.slice(0, qq.group.findIndex((l) => l.text.includes('游戏结束')) >>> 0).some((l) => /你的身份是/.test(l.text));
  sc.check('身份牌从未出现在群消息里', !roleLeakGroup);
  const aiErrors = players.reduce((n, p) => n + p.errors, 0);
  sc.note(`AI 行动被引擎拒绝 ${aiErrors} 次；重连次数 ${[...sc.conns].reduce((n, c) => n + Math.max(0, c.connects - 1), 0)}；裁判传输失败 ${loop.transportFails} 次；真人中转传输失败 ${sc.relays.transportFail} 次`);
  if (aiErrors > 0) sc.check('AI 的每个动作都被接受', false, `${aiErrors} 次被拒`);
  void v;
  await sc.closeAll();
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 3：谁是卧底 6 人（5 AI + 1 真人，含 SSE 和 bridge）
// ════════════════════════════════════════════════════════════════════════════

async function scenarioUndercover(env: Env, rng: Rng): Promise<Scenario> {
  const sc = new Scenario('S3', '谁是卧底', 'undercover');
  const groupId = '100002';
  const humanSpecs: HumanSpec[] = [{ id: '20003', nick: '小明' }];
  const aiCfgs = env.ais.slice(0, 5);
  sc.aiCount = 5;
  sc.humanCount = 1;
  const qq = prepareQQ(sc, groupId, env, aiCfgs, humanSpecs);
  const refConn = sc.conn(env, 'ref', env.ref.key);
  const kinds: Kind[] = ['bridge', 'sse', 'http', 'http', 'http'];
  const ais = aiCfgs.map((cfg, i) => ({ cfg, selfPost: i % 2 === 1, conn: sc.conn(env, `ai${i + 1}`, cfg.key, kinds[i]!) }));
  const gameId = await lobby(env, sc, refConn, 'undercover', groupId, { speech_gap_ms: 200, describe_timeout_s: 30, vote_timeout_s: 30, pk_timeout_s: 30 }, ais.map((a) => ({ conn: a.conn, selfPost: a.selfPost })), humanSpecs);
  log('S3', `谁是卧底 ${gameId} 开局：6 人（5 AI + 1 真人），传输 ${[...sc.transports].join('/')}`);

  let loop!: RefereeLoop;
  const humans = new Humans(env, sc, qq, new SeededRng(`${env.seed}:uc-humans`), humanSpecs, gameId, env.ref.id, env.ref.name, () => loop);
  loop = new RefereeLoop(sc, refConn, gameId, qq, { afterStep: (r) => humans.afterStep(r, 'undercover') });
  const players = ais.map((a, i) => new AiPlayer(sc, a.conn, gameId, qq, new SeededRng(`${env.seed}:uc-ai${i}`), a.cfg, { selfPost: a.selfPost, label: `AI${i + 1}(${kinds[i]})` }, 'undercover', i === 2));
  await Promise.all([loop.run(), ...players.map((p) => p.run())]);

  commonChecks(sc, loop);
  const v = await finishInfo(sc, refConn, gameId);
  // 泄密检查
  const words = new Set<string>();
  for (const p of players) if (p.word) words.add(p.word);
  for (const h of humans.list) if (h.word) words.add(h.word);
  sc.check('收集到两个不同的词（平民词与卧底词）', words.size === 2, [...words].join('/'));
  const endIdx = qq.group.findIndex((l) => l.text.includes('游戏结束') || l.text.includes('平民词'));
  const before = endIdx >= 0 ? qq.group.slice(0, endIdx) : qq.group;
  const leakGroup = before.filter((l) => [...words].some((w) => l.text.includes(w)));
  sc.check('游戏结束前，任何群投递和群发言都不含两个词', leakGroup.length === 0, leakGroup.slice(0, 2).map((l) => `${l.from}: ${l.text.slice(0, 80)}`).join(' | '));
  const aiSpeech = players.flatMap((p) => p.speeches).filter((t) => [...words].some((w) => t.includes(w)));
  sc.check('AI 自己的发言不含两个词', aiSpeech.length === 0);
  const leakApi = humans.snapshots.filter((s) => s.status === 'running' && [...words].some((w) => s.json.includes(w)));
  sc.check(`游戏进行中 /api/games/:id（${humans.snapshots.filter((s) => s.status === 'running').length} 次快照）不含两个词`, leakApi.length === 0);
  // 每个 AI 视角里不应出现自己没有的那个词
  const [w1, w2] = [...words];
  if (w1 && w2 && !w1.includes(w2) && !w2.includes(w1)) {
    const viewLeaks = players.filter((p) => p.word && p.viewSnaps.some((s) => s.includes(p.word === w1 ? w2 : w1)));
    sc.check('进行中每个 AI 的视角里不含另一个词', viewLeaks.length === 0, viewLeaks.map((p) => p.o.label).join(','));
  }
  // 结束后揭晓
  const final = await httpJson(env, `/api/games/${gameId}`);
  const blob = JSON.stringify(final.result) + JSON.stringify(v.result ?? {}) + qq.group.map((l) => l.text).join('\n');
  sc.check('结束后结果里揭晓了两个词', [...words].every((w) => blob.includes(w)), `词：${[...words].join('/')}`);
  sc.check('经 stdio bridge 与旧版 SSE 的 AI 全程可玩', players[0]!.acted > 0 && players[1]!.acted > 0, `bridge 行动 ${players[0]!.acted} 次，sse 行动 ${players[1]!.acted} 次`);
  void rng;
  await sc.closeAll();
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 4a：大话骰 4 AI
// ════════════════════════════════════════════════════════════════════════════

async function scenarioLiarsDice(env: Env, rng: Rng): Promise<Scenario> {
  const sc = new Scenario('S4a', '大话骰', 'liars_dice');
  const groupId = '100003';
  const aiCfgs = env.ais.slice(5, 9);
  sc.aiCount = 4;
  const qq = prepareQQ(sc, groupId, env, aiCfgs, []);
  const refConn = sc.conn(env, 'ref', env.ref.key);
  const ais = aiCfgs.map((cfg, i) => ({ cfg, selfPost: i % 2 === 0, conn: sc.conn(env, `ai${i + 1}`, cfg.key) }));
  const gameId = await lobby(env, sc, refConn, 'liars_dice', groupId, { dice_per_player: 3, lives: 2, turn_timeout_s: 30 }, ais.map((a) => ({ conn: a.conn, selfPost: a.selfPost })), []);
  log('S4a', `大话骰 ${gameId} 开局：4 AI`);
  const loop = new RefereeLoop(sc, refConn, gameId, qq);
  const players = ais.map((a, i) => new AiPlayer(sc, a.conn, gameId, qq, new SeededRng(`${env.seed}:ld-ai${i}`), a.cfg, { selfPost: a.selfPost, label: `AI${i + 1}` }, 'liars_dice'));
  await Promise.all([loop.run(), ...players.map((p) => p.run())]);
  commonChecks(sc, loop);
  await finishInfo(sc, refConn, gameId);
  // 骰子秘密：进行中群消息里不应出现他人的骰子，这里只检查结算时才亮骰
  const early = qq.group.filter((l) => /亮骰/.test(l.text));
  sc.check('只有开牌结算时才公开骰子', early.length > 0 || sc.rounds <= 1, `亮骰公告 ${early.length} 条`);
  void rng;
  await sc.closeAll();
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 4b：数字炸弹（3 AI + 2 真人）+ 裁判接管
// ════════════════════════════════════════════════════════════════════════════

async function scenarioNumberBomb(env: Env, rng: Rng): Promise<Scenario> {
  const sc = new Scenario('S4b', '数字炸弹', 'number_bomb');
  const groupId = '100004';
  const humanSpecs: HumanSpec[] = [
    { id: '20004', nick: '大锤' },
    { id: '20005', nick: '小美' },
  ];
  const aiCfgs = [env.ais[0]!, env.ais[1]!, env.ais[2]!];
  const standbyCfg = env.ais[3]!;
  const intruderCfg = env.ais[9]!;
  sc.aiCount = 3;
  sc.humanCount = 2;
  const qq = prepareQQ(sc, groupId, env, aiCfgs, humanSpecs);
  const refConn = sc.conn(env, 'ref', env.ref.key);
  const ais = aiCfgs.map((cfg, i) => ({ cfg, selfPost: false, conn: sc.conn(env, `ai${i + 1}`, cfg.key) }));
  const gameId = await lobby(env, sc, refConn, 'number_bomb', groupId, { min: 1, max: 40, turn_timeout_s: 30, speech_gap_ms: 200 }, ais.map((a) => ({ conn: a.conn, selfPost: a.selfPost })), humanSpecs);
  log('S4b', `数字炸弹 ${gameId} 开局：3 AI + 2 真人`);

  const standby = sc.conn(env, 'standby', standbyCfg.key);
  const intruder = sc.conn(env, 'intruder', intruderCfg.key);
  const refuses = async (c: Conn, what: string, why?: RegExp): Promise<boolean> => {
    try {
      await c.call('referee_takeover', { game_id: gameId }, { retry: false });
      sc.check(what, false, '接管竟然成功了');
      return false;
    } catch (e) {
      const ok = e instanceof ToolError && (!why || why.test(e.message));
      sc.check(what, ok, errMsg(e).slice(0, 140));
      return ok;
    }
  };

  let loop!: RefereeLoop;
  const humans = new Humans(env, sc, qq, new SeededRng(`${env.seed}:nb-humans`), humanSpecs, gameId, env.ref.id, env.ref.name, () => loop);
  loop = new RefereeLoop(sc, refConn, gameId, qq, { afterStep: (r) => humans.afterStep(r, 'number_bomb') });
  const players = ais.map((a, i) => new AiPlayer(sc, a.conn, gameId, qq, new SeededRng(`${env.seed}:nb-ai${i}`), a.cfg, { selfPost: false, label: `AI${i + 1}` }, 'number_bomb'));

  // 第一步（开局公告 + 第一个猜数提示）之后，原裁判「失联」
  const firstStep = new Promise<void>((res) => {
    const orig = loop.hooks.afterStep!;
    (loop.hooks as RefHooks).afterStep = async (r, l) => {
      await orig(r, l);
      if (l.steps === 1) {
        await l.pause();
        res();
      }
    };
  });
  const failover = (async () => {
    await firstStep;
    // 候补裁判登记（开局后以 referee 报名）
    const reg = await standby.call('join_game', { game_id: gameId, join_as: 'referee' });
    sc.check('开局后 join_game(referee) 登记为候补裁判', /候补/.test(String(reg.message)), String(reg.message).slice(0, 80));
    await refuses(intruder, '非候补裁判（路人 bot）接管被拒绝', /候补/);
    await refuses(standby, '裁判仍在线时候补裁判也不能接管', /仍在线/);
    await refuses(players[0]!.conn, '玩家不能接管裁判', /玩家|候补/);
    const lostAt = loop.lastStepAt;
    log('S4b', `原裁判停止轮询（已收到 seq=${loop.lastSeq}），等待超过 refereeStaleSeconds=10 ...`);
    await sleep(Math.max(0, lostAt + 11_500 - Date.now()));
    await refuses(intruder, '失联后路人 bot 仍不能接管', /候补/);
    let took: any = null;
    for (let i = 0; i < 8 && !took; i++) {
      try {
        took = await standby.call('referee_takeover', { game_id: gameId }, { retry: false });
      } catch (e) {
        if (i === 7) sc.check('候补裁判在裁判失联后接管成功', false, errMsg(e));
        await sleep(1000);
      }
    }
    if (!took) throw new Error('候补裁判接管失败');
    sc.check('候补裁判在裁判失联后接管成功', true, String(took.message).slice(0, 100));
    const cursorMatch = String(took.message).match(/seq=(\d+)/);
    sc.check('接管消息里的游标等于原裁判已收到的最后 seq', Number(cursorMatch?.[1]) === loop.lastSeq, `接管提示 ${cursorMatch?.[1]}，原裁判实际 ${loop.lastSeq}`);
    loop.resume(standby);
  })();

  const watch = (async () => {
    await Promise.all([loop.run(), ...players.map((p) => p.run()), failover]);
  })();
  await watch;

  // 原裁判在接管后不能再推进
  try {
    await refConn.call('referee_step', { game_id: gameId }, { retry: false });
    sc.check('被接管的原裁判不能再调用 referee_step', false, '仍然成功');
  } catch (e) {
    sc.check('被接管的原裁判不能再调用 referee_step', e instanceof ToolError, errMsg(e).slice(0, 120));
  }
  const takeoverLine = qq.group.find((l) => l.text.includes('接管'));
  sc.check('群里公告了裁判接管', Boolean(takeoverLine), takeoverLine?.text.slice(0, 60) ?? '');
  commonChecks(sc, loop);
  await finishInfo(sc, standby, gameId);
  await sc.closeAll();
  void rng;
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 5：管理员中止
// ════════════════════════════════════════════════════════════════════════════

async function scenarioAdmin(env: Env): Promise<Scenario> {
  const sc = new Scenario('S5', '管理员中止', 'number_bomb');
  const admin = sc.conn(env, 'admin', env.adminKey);
  const ai = sc.conn(env, 'ai', env.ais[4]!.key);
  const created = await admin.call('create_game', { game_type: 'number_bomb', group_id: '100005', join_as: 'none' });
  const gid: string = created.summary.game_id;
  sc.id = gid;
  await ai.call('join_game', { game_id: gid, join_as: 'player' });
  try {
    await ai.call('abort_game', { game_id: gid }, { retry: false });
    sc.check('非房主/裁判/管理员不能中止对局', false, '被允许了');
  } catch (e) {
    sc.check('非房主/裁判/管理员不能中止对局', e instanceof ToolError, errMsg(e).slice(0, 100));
  }
  const ab = await admin.call('abort_game', { game_id: gid, reason: 'e2e 管理员中止' });
  sc.check('管理员可以中止对局', /中止/.test(String(ab.message)), String(ab.message).slice(0, 80));
  const pub = await httpJson(env, `/api/games/${gid}`);
  sc.check('公开接口显示状态 aborted', pub.summary?.status === 'aborted', String(pub.summary?.status));
  try {
    await admin.call('abort_game', { game_id: gid }, { retry: false });
    sc.check('已中止的对局不能再次中止', false, '被允许了');
  } catch (e) {
    sc.check('已中止的对局不能再次中止', e instanceof ToolError);
  }
  // 群被释放，可以重新开一局
  const again = await admin.call('create_game', { game_type: 'number_bomb', group_id: '100005', join_as: 'none' });
  sc.check('中止后同一个群可以重新开局', Boolean(again.summary?.game_id));
  await admin.call('abort_game', { game_id: again.summary.game_id, reason: '清理' });
  sc.winner = '(中止)';
  sc.aiCount = 1;
  await sc.closeAll();
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 场景 6：汇总检查
// ════════════════════════════════════════════════════════════════════════════

async function scenarioFinal(env: Env, done: Scenario[]): Promise<Scenario> {
  const sc = new Scenario('S6', '最终核对', '-');
  const all = await httpJson(env, '/api/games?all=1');
  const games: any[] = all.games ?? [];
  const byId = new Map(games.map((g) => [g.game_id, g]));
  for (const s of done.filter((d) => d.id)) {
    const g = byId.get(s.id);
    const want = s.game === 'number_bomb' && s.tag === 'S5' ? 'aborted' : 'ended';
    sc.check(`/api/games?all=1 列出 ${s.tag} 的 ${s.id}，状态 ${want}`, g?.status === want, `实际 ${g?.status ?? '未列出'}`);
  }
  const running = await httpJson(env, '/api/games');
  sc.check('默认列表不含已结束/已中止的对局', (running.games ?? []).length === 0, `${(running.games ?? []).length} 条`);
  const ai = sc.conn(env, 'ai', env.ais[0]!.key);
  for (const s of done.filter((d) => d.id && d.tag !== 'S5')) {
    const log = await ai.call('get_game_log', { game_id: s.id, limit: 1000 });
    sc.check(`get_game_log(${s.id}) complete_replay=true 且有结果`, log.complete_replay === true && Boolean(log.result?.winnerTeam), `complete_replay=${log.complete_replay} events=${log.events?.length}`);
  }
  const s5 = done.find((d) => d.tag === 'S5');
  if (s5?.id) {
    const log = await ai.call('get_game_log', { game_id: s5.id });
    sc.check('已中止对局的日志不是完整复盘（防中止后偷看）', log.complete_replay === false, `complete_replay=${log.complete_replay}`);
  }
  const health = await httpJson(env, '/health');
  sc.check('结束时服务仍健康', health.ok === true, `sessions=${health.sessions}`);
  await sc.closeAll();
  return sc;
}

// ════════════════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════════════════

function printReport(seed: string, scenarios: Scenario[], totalMs: number): void {
  const rows = scenarios.map((s) => [
    s.tag,
    s.title,
    s.aiCount || s.humanCount ? `${s.aiCount}/${s.humanCount}` : '-',
    s.transports.size ? [...s.transports].join('+') : '-',
    s.rounds ? String(s.rounds) : '-',
    s.deliveries.group + s.deliveries.private ? `${s.deliveries.group}/${s.deliveries.private}` : '-',
    s.relays.accepted + s.relays.rejected + s.relays.ignored ? `${s.relays.accepted}/${s.relays.rejected}` : '-',
    s.game === '-' || s.tag === 'S5' ? '-' : String(s.timeouts),
    s.winner,
    `${(s.durationMs / 1000).toFixed(1)}s`,
    `${s.passed}/${s.failed}`,
  ]);
  const head = ['场景', '游戏', 'AI/真人', '传输', '轮数', '投递 群/私', '真人中转 通过/拒绝', '超时', '胜方', '耗时', '检查 通过/失败'];
  const widths = head.map((h, i) => Math.max(dw(h), ...rows.map((r) => dw(r[i]!))));
  const line = (cols: string[]) => cols.map((c, i) => padEnd(c, widths[i]!)).join('  ');
  console.log('\n' + line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log(`\n种子 ${seed}，总耗时 ${(totalMs / 1000).toFixed(1)}s`);
  for (const s of scenarios) {
    for (const n of s.notes) console.log(`  备注 [${s.tag}] ${n}`);
  }
  const failed = scenarios.flatMap((s) => s.checks.filter((c) => !c.ok).map((c) => ({ s, c })));
  if (failed.length > 0) {
    console.log('\n失败的检查：');
    for (const { s, c } of failed) console.log(`  ✘ [${s.tag}] ${c.name}${c.detail ? ` —— ${c.detail}` : ''}`);
  }
  if (FINDINGS.size > 0) {
    console.log('\n发现（疑似引擎问题 / 体验问题，未修改任何源码）：');
    for (const f of FINDINGS.values()) console.log(`  • (${f.kind}) ${f.title}\n      证据：${f.evidence}`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { seed: { type: 'string' }, json: { type: 'string' }, 'server-seed': { type: 'boolean' }, timeout: { type: 'string' }, only: { type: 'string' } }, strict: false });
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const seed = str('seed') ?? String(randomInt(1_000_000_000));
  const only = str('only')?.split(',').map((s) => s.trim().toUpperCase());
  const want = (tag: string) => !only || only.includes(tag);

  if (!existsSync(CLI)) {
    console.error(`❌ 找不到 ${CLI}。请先运行 npm run build。`);
    return 2;
  }
  try {
    const distM = statSync(CLI).mtimeMs;
    const newest = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => statSync(join(e.parentPath, e.name)).mtimeMs)
      .reduce((a, b) => Math.max(a, b), 0);
    if (newest > distM + 1000) console.warn('⚠️  src/ 比 dist/ 新，dist 可能不是最新构建（先 npm run build）。');
  } catch {
    // 只是提示，忽略
  }

  console.log(`bot-game-mcp 端到端测试，种子 ${seed}（可用 --seed ${seed} 复现harness的选择；引擎自身用密码学随机）`);

  // 临时目录与配置
  const tmp = mkdtempSync(join(tmpdir(), 'botgame-e2e-'));
  const childPids = new Set<number>();
  let env!: Env;
  let cleaned = false;
  const killAll = () => {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }
    env?.server?.killNow();
  };
  const cleanupSync = () => {
    if (cleaned) return;
    cleaned = true;
    killAll();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  process.on('exit', cleanupSync);
  const onSignal = (sig: NodeJS.Signals) => {
    console.error(`\n收到 ${sig}，清理后退出`);
    cleanupSync();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', (e) => {
    console.error(`❌ 未捕获的错误：${errMsg(e)}`);
    cleanupSync();
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    console.error(`❌ 未处理的 Promise 拒绝：${errMsg(e)}`);
    cleanupSync();
    process.exit(1);
  });
  const hardLimit = Number(str('timeout') ?? 300) * 1000;
  const watchdog = setTimeout(() => {
    console.error(`❌ 超过总时限 ${hardLimit / 1000}s，强制退出`);
    cleanupSync();
    process.exit(1);
  }, hardLimit);
  watchdog.unref();

  const key = () => `bgk_${randomBytes(18).toString('base64url')}`;
  const ref: AgentCfg = { key: key(), id: '90001', name: '裁判' };
  const ais: AgentCfg[] = Array.from({ length: 10 }, (_, i) => ({ key: key(), id: String(10001 + i), name: `AI-${String(i + 1).padStart(2, '0')}` }));
  const adminKey = key();
  SECRETS.push(ref.key, adminKey, ...ais.map((a) => a.key));
  const port = await freePort();
  const cfgPath = join(tmp, 'config.json');
  const statePath = join(tmp, 'state.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      legacySse: true,
      publicApi: true,
      stateFile: statePath,
      refereeStaleSeconds: 10,
      ...(values['server-seed'] ? { seed } : {}),
      auth: { mode: 'keys', adminKeys: [adminKey], agents: [ref, ...ais] },
    }),
    { mode: 0o600 },
  );
  env = {
    seed,
    tmp,
    port,
    base: `http://127.0.0.1:${port}`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    ref,
    ais,
    adminKey,
    childPids,
    downWaiters: new Set(),
    server: new ServerProc(() => env, ['--host', '127.0.0.1', '--port', String(port), '--config', cfgPath, '--state', statePath]),
  };

  const done: Scenario[] = [];
  const rng = new SeededRng(`${seed}:harness`);
  let exception: string | null = null;
  const run = async (tag: string, fn: () => Promise<Scenario>): Promise<void> => {
    const t = Date.now();
    log(tag, '开始');
    let sc: Scenario | null = null;
    try {
      sc = await fn();
    } catch (e) {
      exception = `${tag} 异常：${errMsg(e)}`;
      log(tag, exception);
      sc = new Scenario(tag, '(异常)', '-');
      sc.check(`${tag} 无异常`, false, errMsg(e));
    }
    sc.durationMs = Date.now() - t;
    await sc.closeAll().catch(() => undefined);
    done.push(sc);
    log(tag, `结束：通过 ${sc.passed}，失败 ${sc.failed}，用时 ${(sc.durationMs / 1000).toFixed(1)}s`);
  };

  try {
    log('S1', `启动 dist/cli.js serve（127.0.0.1:${port}，临时目录 ${tmp}）`);
    await env.server.start();
    await run('S1', () => scenarioStartup(env));
    if (done[0]!.failed > 0) throw new Error('启动与认证检查失败，后续场景无意义');

    if (want('S2')) await run('S2', () => scenarioWerewolf(env, new SeededRng(`${seed}:s2`)));
    // 第二阶段：卧底、大话骰、数字炸弹并发（同一个裁判 bot 同时主持三个群）
    const phaseB: Promise<void>[] = [];
    if (want('S3')) phaseB.push(run('S3', () => scenarioUndercover(env, new SeededRng(`${seed}:s3`))));
    if (want('S4')) {
      phaseB.push(run('S4a', () => scenarioLiarsDice(env, new SeededRng(`${seed}:s4a`))));
      phaseB.push(run('S4b', () => scenarioNumberBomb(env, new SeededRng(`${seed}:s4b`))));
    }
    if (want('S5')) phaseB.push(run('S5', () => scenarioAdmin(env)));
    await Promise.all(phaseB);
    await run('S6', () => scenarioFinal(env, done));

    // 服务端日志里不应有未捕获错误
    const bad = env.server.tail.filter((l) => /uncaught|unhandled|TypeError|ReferenceError|请求处理出错|\[tick\]/i.test(l));
    const s6 = done[done.length - 1]!;
    s6.check('服务端日志里没有未捕获错误/请求处理出错', bad.length === 0, bad.slice(0, 2).join(' | ').slice(0, 300));
  } catch (e) {
    exception = errMsg(e);
    console.error(`❌ ${exception}`);
    if (env.server.tail.length > 0) console.error('服务端日志末尾：\n  ' + env.server.tail.slice(-12).join('\n  '));
  } finally {
    await Promise.all(done.map((s) => s.closeAll().catch(() => undefined)));
    const stop = await env.server.stop().catch(() => null);
    if (stop && stop.code !== 0 && !exception) exception = `服务最终停止时退出码 ${stop.code}`;
  }

  done.sort((a, b) => a.tag.localeCompare(b.tag));
  const totalMs = Date.now() - T0;
  printReport(seed, done, totalMs);
  const failedChecks = done.reduce((n, s) => n + s.failed, 0);
  const ok = failedChecks === 0 && !exception && done.length > 0;
  const jsonPath = str('json');
  if (jsonPath) {
    const summary = {
      seed,
      ok,
      exception,
      durationMs: totalMs,
      scenarios: done.map((s) => ({
        tag: s.tag,
        title: s.title,
        game: s.game,
        gameId: s.id,
        players: { ai: s.aiCount, human: s.humanCount },
        transports: [...s.transports],
        rounds: s.rounds,
        deliveries: s.deliveries,
        humanRelays: s.relays,
        timeouts: s.timeouts,
        winner: s.winner,
        durationMs: s.durationMs,
        checks: { passed: s.passed, failed: s.failed, items: s.checks },
        notes: s.notes,
      })),
      findings: [...FINDINGS.values()],
    };
    writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`摘要已写入 ${jsonPath}`);
  }
  console.log(ok ? '\n✅ 端到端测试全部通过' : `\n❌ 端到端测试未通过（失败 ${failedChecks} 项${exception ? `，异常：${exception}` : ''}）`);
  clearTimeout(watchdog);
  cleanupSync();
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`❌ ${errMsg(e)}`);
    process.exit(1);
  },
);
