#!/usr/bin/env node
/**
 * 栖灯镇三维网页客户端的端到端演示与验收（不进 CI：CI 里没有 Godot）。
 *
 *   npm run client:export   # 先导出（见 client/README.md）
 *   npm run client:e2e      # 起引擎（子进程、开发登录、临时库、随机端口）+ 两个浏览器上下文 + 一个 AI 居民
 *
 * 选项：--no-shots 不写截图；--only=3,4 只跑指定步骤（步骤之间有先后依赖，只用于调试）；--keep-engine-log 失败时不删临时目录。
 * 反向验证：E2E_AI_NO_RENEW=1 npx tsx scripts/client-e2e.mjs --only=1,8 --no-shots（步骤 8 里让 AI 的端口没有续租方法，运行器不续租，这一步应当失败）。
 * 退出码：全部通过为 0；任何步骤失败、控制台错误、页面错误、CSP 违规、请求失败都算失败（非零）。
 * 结果写到 client/demo/results.json，截图写到 client/demo/NN-说明.jpg（手机 deviceScaleFactor 2，桌面 1）。
 * 只有全部通过（退出码 0）且没有 --only 时才覆盖这两样；失败的运行把结果写到 client/demo/results.failed.json（已 gitignore），
 * 截图先写到临时目录，通过后才搬过去，不会把已提交的验收记录换成失败记录。
 *
 * 分辨率说明：手机上下文是 390x844、deviceScaleFactor 2；桌面上下文是 1440x900、deviceScaleFactor 1。桌面如果也用 2，
 * 画布有 520 万像素，SwiftShader 只剩 1~2 帧每秒，页面的时钟估计被拖慢到往返 1.5 秒，位置精度断言会被渲染饥饿而不是客户端本身搞坏（实测）。
 *
 * 时间容差说明：无头 Chromium 用 SwiftShader 软件渲染，渲染循环只有 3 到 7 帧每秒，页面里的「显示位置」
 * 是按帧更新的，所以对比「页面里的位置」和「按服务器折线 + 服务器时间现算的位置」时留了 0.6 米
 * （走路速度 2.4 米每秒，约 250 毫秒）的容差。这不是靠加长等待糊过去：每个断言都是定时轮询到条件成立为止。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT_DIR = join(ROOT, 'client', 'town', 'build', 'web');
const DEMO_DIR = join(ROOT, 'client', 'demo');
const ARGS = process.argv.slice(2);
const NO_SHOTS = ARGS.includes('--no-shots');
const KEEP = ARGS.includes('--keep-engine-log');
const AI_NO_RENEW = process.env.E2E_AI_NO_RENEW === '1'; // 反向验证用：步骤 8 里让端口没有 renewNavigation，运行器就不续租，这一步应当失败
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number);
const T_POS = 0.6; // 页面里的位置 与 服务器折线现算位置 的容差（米）
// 页面的服务器时间估计与服务器真实时间的容差（毫秒）。页面的 serverNow 一秒内只在 Godot 帧里写进 __town（软件渲染约 3~7 帧每秒，
// 最旧约 300 毫秒），脚本用「值变化的那一刻」去对齐，剩下的是时钟估计本身的误差；走路速度 2.4 米每秒，400 毫秒约 1 米。
const T_CLOCK_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(3).toString('hex');

// ───────────────────────── 前置检查 ─────────────────────────

if (!existsSync(join(CLIENT_DIR, 'index.html')) || !existsSync(join(CLIENT_DIR, 'index.wasm'))) {
  console.error(`没有找到客户端导出目录：${CLIENT_DIR}\n请先运行：npm run client:export（需要 Godot 4.7.x，见 client/README.md）`);
  process.exit(2);
}

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const p of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try {
      return req(p);
    } catch {
      /* 试下一个 */
    }
  }
  console.error('找不到 playwright：npm i -D playwright 并 npx playwright install chromium，或把它装进 NODE_PATH。');
  process.exit(2);
}
const { chromium } = loadPlaywright();

// ───────────────────────── 引擎子进程 ─────────────────────────

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const browsers = [];
const TMP = mkdtempSync(join(tmpdir(), 'town-client-e2e-'));
const SHOT_TMP = join(TMP, 'shots'); // 截图先写这里，全部通过后才搬进 client/demo/
const AI_KEY = `bgk_e2e_${rnd()}${rnd()}${rnd()}`;
let engine = null;
const engineTail = [];
let BASE = '';
let PORT = 0;

async function startEngine() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const cfg = {
    host: '127.0.0.1',
    port: PORT,
    stateFile: null,
    seed: 'client-e2e',
    auth: { mode: 'keys', adminKeys: [], agents: [{ key: AI_KEY, id: '9001', name: '灯灯' }] },
    town: { enabled: true, dbFile: join(TMP, 'town.db'), devLogin: true, clientDir: CLIENT_DIR },
  };
  const cfgFile = join(TMP, 'engine.json');
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
  engine = spawn(tsx, [join(ROOT, 'packages', 'engine', 'src', 'cli.ts'), 'serve'], {
    cwd: ROOT,
    detached: true, // 自成进程组，结束时整组杀掉（tsx 会再起一层 node）
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOTGAME_CONFIG: cfgFile },
  });
  const onData = (b) => {
    for (const l of b.toString('utf8').split('\n')) if (l.trim()) engineTail.push(l);
    if (engineTail.length > 120) engineTail.splice(0, engineTail.length - 120);
  };
  engine.stdout.on('data', onData);
  engine.stderr.on('data', onData);
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (engine.exitCode !== null) throw new Error(`引擎提前退出：\n${engineTail.slice(-15).join('\n')}`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`引擎 40 秒内没有就绪：\n${engineTail.slice(-15).join('\n')}`);
    await sleep(150);
  }
}

/** 引擎进程组里还有没有活着的进程（tsx 会再起一层 node，组长退出了孙子可能还在关库）。 */
function groupAlive() {
  if (!engine?.pid) return false;
  try {
    process.kill(-engine.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 停引擎并等进程组真正退出；超时改发 SIGKILL。删临时目录必须在这之后，否则引擎还在关 SQLite 时目录就没了。 */
async function stopEngine() {
  if (!engine?.pid || !groupAlive()) return;
  try {
    process.kill(-engine.pid, 'SIGTERM');
  } catch {
    /* 已经退出 */
  }
  const t0 = Date.now();
  while (groupAlive() && Date.now() - t0 < 8000) await sleep(100);
  if (groupAlive()) {
    try {
      process.kill(-engine.pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
    while (groupAlive() && Date.now() - t0 < 12_000) await sleep(100);
  }
}

// 脚本被 Ctrl-C / 超时杀掉时，引擎自成进程组收不到终端的信号，必须自己停；同步的 exit 钩子兜底（崩溃路径）
let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n收到 ${sig}，停止引擎并清理…`);
    for (const b of browsers) await b.close().catch(() => {});
    await stopEngine();
    if (!KEEP) rmSync(TMP, { recursive: true, force: true });
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}
process.on('exit', () => {
  if (engine?.pid && groupAlive()) {
    try {
      process.kill(-engine.pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
});

// ───────────────────────── 步骤记录 ─────────────────────────

const results = [];
let current = null;
const notes = [];
function note(msg) {
  notes.push(msg);
  console.log(`      · ${msg}`);
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
const livePages = () => [A, B, A2, A3, ...extra].filter(Boolean);
async function resetFrameStats() {
  for (const p of livePages()) await p.page.evaluate(() => { window.__frameMaxMs = 0; if (window.__long) window.__long = { max: 0, n: 0, over500: 0 }; }).catch(() => {});
}
/** 这一步里每个页面最长的 Godot 帧间隔和浏览器长任务；一眼分清是「机器忙（到处都慢）」还是「某处卡了一下主线程」。 */
async function noteFrameStats() {
  const rows = [];
  for (const p of livePages()) {
    const r = await p.page.evaluate(() => ({ f: window.__frameMaxMs ?? null, l: window.__long ?? null })).catch(() => null);
    if (r && r.f !== null) rows.push(`${p.label} ${Math.round(r.f)} ms` + (r.l ? `（长任务 ${r.l.n} 个，最长 ${Math.round(r.l.max)} ms，超 500 ms ${r.l.over500} 个）` : ''));
  }
  for (const p of livePages()) {
    const r = await p.page.evaluate(() => (window.__frameMaxMs >= 500 ? window.__town?.slow ?? [] : [])).catch(() => []);
    if (r.length) note(`${p.label} 慢帧记录（[时刻 种类 毫秒 ...]）：${r.slice(-6).join(' | ')}`);
  }
  if (rows.length) note(`最长帧间隔：${rows.join('；')}`);
}
async function step(n, title, fn) {
  if (ONLY.length && !ONLY.includes(n)) return;
  current = { n, title, ok: false, ms: 0, notes: [] };
  notes.length = 0;
  const t0 = Date.now();
  console.log(`\n步骤 ${n}  ${title}`);
  await resetFrameStats();
  try {
    await fn();
    settleAllowed();
    current.ok = true;
    console.log(`  ✓ 步骤 ${n} 通过（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  } catch (e) {
    for (const p of [A, B, A2, A3, ...extra].filter(Boolean)) p.w.allow = [];
    current.error = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ 步骤 ${n} 失败：${current.error}`);
  }
  current.ms = Date.now() - t0;
  await noteFrameStats();
  current.notes = [...notes];
  results.push(current);
}

/** 步骤结束时核对声明过的失败请求次数，然后清空声明（下一步重新声明）。 */
function settleAllowed() {
  const ws = [A, B, A2, A3, ...extra].filter(Boolean).map((p) => p.w);
  const bad = [];
  for (const w of ws) {
    for (const a of w.allow) if (a.hits < a.min || a.hits > a.max) bad.push(`[${w.label}] ${a.why}：声明 ${a.min}~${a.max} 次，实际 ${a.hits} 次`);
    w.allow = [];
  }
  if (bad.length) throw new Error(`被拒绝的请求次数与声明不符：${bad.join('；')}`);
}

// ───────────────────────── 浏览器侧工具 ─────────────────────────

const shots = [];
async function shot(page, name) {
  if (NO_SHOTS) return;
  mkdirSync(SHOT_TMP, { recursive: true });
  const file = join(SHOT_TMP, `${name}.jpg`);
  // JPEG：街景画面细节多，PNG 一张四五百 KB，每刷新一次验收记录仓库就涨 6 MB 多；JPEG 质量 82 肉眼看不出差别，约为五分之一
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  shots.push({ name, size: statSync(file).size });
}

/** 一个被监视的页面：收集控制台错误、页面错误、CSP 违规、失败请求，以及 /actions 的回应。 */
function watch(page, label) {
  // allow：本步骤声明过「会被服务器规则拒绝」的请求（method + 路径）；凡是 >=400 的响应没有对上声明的，一律记为问题。
  // consoleFail：Chromium 为每个非 2xx 的 fetch 固定打一行 Failed to load resource；它的条数必须等于被声明消耗掉的失败次数。
  const w = { label, problems: [], allow: [], allowedHits: 0, consoleFail: 0, actions: [], csp: 0 };
  page.on('console', (m) => {
    const text = m.text();
    if (/GPU stall|ReadPixels/.test(text)) return; // 软件渲染的驱动提示，不是错误
    if (/Content Security Policy|violates the following/i.test(text)) {
      w.csp++;
      w.problems.push(`CSP：${text.slice(0, 200)}`);
      return;
    }
    if (m.type() !== 'error') return;
    // 服务器规则失败（4xx）时 Chromium 固定会打一行这个；只计数，收尾时必须等于 allowedHits
    if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(text)) {
      w.consoleFail++;
      return;
    }
    w.problems.push(`控制台错误：${text.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => w.problems.push(`pageerror：${e.message.slice(0, 300)}`));
  page.on('requestfailed', (r) => {
    if (w.closing) return;
    const u = r.url();
    // 故意被我们拦下断开的 WebSocket 不经过这里；其余失败一律算问题
    w.problems.push(`请求失败：${r.method()} ${u.replace(BASE, '')} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    const st = r.status();
    if (st >= 400) {
      const m = r.request().method();
      const path = u.replace(BASE, '');
      const hit = w.allow.find((a) => a.method === m && a.path.test(path) && a.hits < a.max);
      if (hit) {
        hit.hits++;
        w.allowedHits++;
      } else w.problems.push(`未声明的 HTTP ${st}：${m} ${path}`);
    }
    if (!/\/town\/api\/actions$/.test(u) || r.request().method() !== 'POST') return;
    const rec = { status: st, type: null, code: null, message: null, t: Date.now() };
    try {
      const body = JSON.parse(r.request().postData() ?? '{}');
      rec.type = body.action?.type ?? null;
      rec.to = body.action?.to ?? null;
      rec.fence = body.action?.dirFence ?? null;
    } catch {
      /* 忽略 */
    }
    w.actions.push(rec);
    r.json()
      .then((j) => {
        rec.code = j?.error ?? null;
        rec.reason = j?.reason ?? j?.data?.reason ?? null;
        rec.message = j?.message ?? null;
      })
      .catch(() => {});
  });
  return w;
}

/** 声明接下来会有 min~max 次「被服务器规则拒绝」的请求（必须在触发之前调用）；收尾时核对实际次数。 */
function allowFailure(w, method, path, { min = 1, max = 1, why }) {
  w.allow.push({ method, path, min, max, why, hits: 0 });
}

async function newPlayer(browser, label, ctxOpts, { wsGate = false } = {}) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const w = watch(page, label);
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    // 主线程长任务（浏览器自己量的，和 Godot 的帧间隔互相印证）：每步开头清零、结尾读取
    window.__long = { max: 0, n: 0, over500: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__long.n++;
          window.__long.max = Math.max(window.__long.max, e.duration);
          if (e.duration >= 500) window.__long.over500++;
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* 浏览器不支持就没有这一项 */
    }
  });
  let gate = null;
  if (wsGate) {
    // 让测试能在需要的时候把 WebSocket 断掉并拦住重连
    gate = { block: false, silent: false, sockets: [], dirFrames: [] };
    await page.routeWebSocket(/\/town\/ws/, (ws) => {
      if (gate.block) {
        ws.close();
        return;
      }
      const server = ws.connectToServer();
      // 记下页面发给服务器的方向输入帧（核对不带坐标、序号递增）；其余原样转发
      ws.onMessage((m) => {
        if (typeof m === 'string' && m.includes('"t":"dir"')) gate.dirFrames.push(m);
        server.send(m);
      });
      // 显式转发，才能在 silent 时把服务器发来的消息吞掉（页面那头看起来就是连接还开着、但什么都收不到：半开连接）
      server.onMessage((m) => {
        if (!gate.silent) ws.send(m);
      });
      gate.sockets.push(ws);
    });
  }
  return { ctx, page, w, label, touch: !!ctxOpts.hasTouch, gate, name: null };
}

async function login(p, name, { shotEnter } = {}) {
  const t0 = Date.now();
  await p.page.goto(`${BASE}/town/3d/?debug=1`);
  await p.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
  const tButton = Date.now() - t0;
  if (shotEnter) await shot(p.page, shotEnter);
  // 点「进入小镇」之前：Godot 建出来的 AudioContext 的状态（TownHost.audioState 只返回状态字符串，不暴露对象）
  const audioBefore = await p.page.evaluate(() => window.TownHost.audioState());
  // 进入面板底部要有可见的「开源许可」链接：新窗口打开 licenses.txt
  const licLink = await p.page.evaluate(() => {
    const a = document.getElementById('licLink');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { text: a.textContent, href: a.getAttribute('href'), target: a.target, visible: r.width > 0 && r.height > 0 && getComputedStyle(a).visibility !== 'hidden' };
  });
  const t1 = Date.now();
  await p.page.click('#enterBtn');
  await p.page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 });
  await p.page.fill('#nameInput', name);
  await p.page.click('#loginBtn');
  await p.page.waitForFunction(
    () => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing',
    null,
    { timeout: 60_000 },
  );
  p.name = name;
  const toPlayingMs = Date.now() - t1;
  // 点进入是真实的用户手势（Playwright 发的是受信任输入），之后至少有一个 AudioContext 应处于 running（最多等 5 秒，等 resume 的 Promise 落定）
  let audioAfter = await p.page.evaluate(() => window.TownHost.audioState());
  const ta = Date.now();
  while (!audioAfter.includes('running') && Date.now() - ta < 5000) {
    await sleep(200);
    audioAfter = await p.page.evaluate(() => window.TownHost.audioState());
  }
  return { toButtonMs: tButton, toPlayingMs, audioBefore, audioAfter, licLink };
}

const snap = (page) =>
  page.evaluate(() => {
    const t = window.__town;
    return {
      self: t.self, scene: t.scene, space: t.space, spaceName: t.spaceName, conn: t.connection, mine: t.mine,
      pending: t.pending, selected: t.selected, nearValid: t.nearValid, zoom: t.zoom, vp: t.vp,
      serverNow: t.serverNow, off: t.serverTimeOffset, rtt: t.rttMs, fps: t.fps, lastError: t.lastError, toasts: t.toasts,
      actors: t.actors.map((a) => ({ id: a.id, name: a.name, x: a.x, z: a.z, moving: a.moving })),
      objects: t.objects,
    };
  });

const viewport = (page) => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
const project = (page, x, z) => page.evaluate(([x, z]) => window.__town.project(x, 0, z), [x, z]);

/** 点在页面里的世界坐标上（鼠标或触摸）。目标不在可点区域内就沿着自己到目标的连线往回缩，直到点得到。 */
async function clickWorld(p, x, z) {
  const s = await snap(p.page);
  const me = s.actors.find((a) => a.id === s.self);
  const vp = await viewport(p.page);
  const ok = (q) => q.x > 24 && q.x < vp.w - 24 && q.y > 100 && q.y < vp.h - 170;
  let k = 1;
  let q = await project(p.page, x, z);
  while (!ok(q) && k > 0.05) {
    k -= 0.05;
    q = await project(p.page, me.x + (x - me.x) * k, me.z + (z - me.z) * k);
  }
  if (!ok(q)) {
    // 连自己脚边都点不到：把镜头和投影的现状写进报错里，否则只能猜
    const mq = await project(p.page, me.x, me.z);
    const cam = await p.page.evaluate(() => ({ zoom: window.__town.zoom ?? null, rect: window.__town.canvasRect, phase: window.__town.phase ?? null }));
    check(false, `世界点 (${x},${z}) 投影不到可点区域：自己在 (${me.x.toFixed(2)},${me.z.toFixed(2)}) 投影 (${mq.x.toFixed(0)},${mq.y.toFixed(0)})，视口 ${vp.w}×${vp.h}，${JSON.stringify(cam)}`);
  }
  if (p.touch) await p.page.touchscreen.tap(q.x, q.y);
  else await p.page.mouse.click(q.x, q.y);
  return { x: me.x + (x - me.x) * k, z: me.z + (z - me.z) * k, px: q };
}

/** 轮询直到 fn 返回真值；超时抛出带说明的错误。fn 可以是同步或异步。 */
async function until(fn, timeoutMs, what, every = 150) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${(timeoutMs / 1000).toFixed(0)} 秒）：${what}`);
    await sleep(every);
  }
}

// ───────────────────────── 服务器侧（用各自的 Cookie 读 /scene） ─────────────────────────

async function serverScene(p) {
  const r = await p.ctx.request.get(`${BASE}/town/api/scene`);
  check(r.ok(), `GET /scene 返回 ${r.status()}`);
  return r.json();
}
const selfActor = (sc) => sc.actors.find((a) => a.id === sc.self);
const normPts = (pts) => pts.map((q) => (Array.isArray(q) ? { x: q[0], z: q[1] } : q));

/**
 * 页面的服务器时间估计与服务器真实时间之差（毫秒，正数 = 页面快）。
 * 位置断言用页面自己的 serverNow 现算折线位置，只能证明公式一致；时钟对时对不对，要拿服务器那边的时间来比：
 *  1) 服务器时间对到本机：GET /scene 前后各取一次 Date.now，取中点（扣掉往返的一半），得到 服务器 - 本机 的偏移（同一台机器上应接近 0，一并记下）；
 *  2) 页面的 __town.serverNow 只在 Godot 帧里写（软件渲染最旧约 300 毫秒），所以快速轮询到它「变化」的那一刻，用前后两次读取的中点作为写入时刻；
 *  3) 差 = 页面 serverNow - (写入时刻 + 偏移)。
 */
async function clockSkew(p) {
  const t0 = Date.now();
  const sc = await serverScene(p);
  const t1 = Date.now();
  const srvOff = sc.serverTime - (t0 + t1) / 2;
  const read = () => p.page.evaluate(() => window.__town.serverNow);
  let prev = await read();
  let tPrev = Date.now();
  for (;;) {
    const n = await read();
    const tNow = Date.now();
    if (n !== prev) {
      const tw = (tPrev + tNow) / 2;
      return { diff: n - (tw + srvOff), rtt: t1 - t0, srvOff, bracket: tNow - tPrev };
    }
    if (tNow - tPrev > 3000) throw new Error('页面的 serverNow 3 秒内没有更新');
    prev = n;
    tPrev = tNow;
  }
}

/** 连采 3 次；每一次都要在 T_CLOCK_MS 之内。 */
async function assertClock(p, tag) {
  const xs = [];
  for (let i = 0; i < 3; i++) {
    xs.push(await clockSkew(p));
    await sleep(150);
  }
  note(`${tag}：页面时钟 - 服务器时间 = ${xs.map((x) => x.diff.toFixed(0)).join(' / ')} ms（容差 ±${T_CLOCK_MS}；本机-服务器偏移 ${xs.map((x) => x.srvOff.toFixed(0)).join('/')} ms，/scene 往返 ${xs.map((x) => x.rtt).join('/')} ms，读取括号宽 ${xs.map((x) => x.bracket).join('/')} ms）`);
  for (const x of xs) check(Math.abs(x.diff) < T_CLOCK_MS, `${tag}：页面的服务器时间估计偏离真实服务器时间 ${x.diff.toFixed(0)} ms，超过 ±${T_CLOCK_MS} ms`);
  return xs;
}

/** 按服务器折线 + 速度 + 出发时刻，在服务器时间 t（毫秒）的位置；截断在租约截止 until。 */
function polyAt(nav, t) {
  const pts = normPts(nav.points);
  const tt = Math.min(t, nav.until ?? t);
  let d = Math.max(0, (nav.speed * (tt - nav.startedAt)) / 1000);
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (d <= seg) {
      const f = seg === 0 ? 0 : d / seg;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f };
    }
    d -= seg;
  }
  return pts[pts.length - 1];
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** 分几段走到 (x,z)：每一段点视野内能点到的点（clickWorld 会缩回），等服务器里走完再点下一段。 */
async function walkTo(p, x, z, tol = 0.8) {
  for (let hop = 0; hop < 10; hop++) {
    const me = selfActor(await serverScene(p));
    if (dist(me, { x, z }) < tol) return me;
    await clickWorld(p, x, z);
    // 点的地方离得太近时服务器当场就算走完，没有导航：回头重新量距离
    const started = await until(async () => selfActor(await serverScene(p))?.nav, 5000, '开始走', 250).catch(() => null);
    if (!started) continue;
    await until(async () => !selfActor(await serverScene(p))?.nav, 40_000, '这一段走完', 500);
  }
  const me = selfActor(await serverScene(p));
  check(dist(me, { x, z }) < tol, `走不到 (${x},${z})，停在 (${me.x.toFixed(1)},${me.z.toFixed(1)})`);
  return me;
}

/**
 * 从候选落点里挑第一个「点得到地面」的：镜头从南边斜着往北看，别的居民的点选盒（1 × 1.9 × 1 米）
 * 会挡住自己身后（北侧）约 2.3 米的地面，点在那里是「走到 ta 身边」而不是「走到这个点」。
 */
async function clearSpot(p, cands) {
  const sc = await serverScene(p);
  const others = sc.actors.filter((a) => a.id !== sc.self);
  const blocked = (c) => others.some((a) => Math.abs(c.x - a.x) < 1.2 && c.z - a.z > -3.2 && c.z - a.z < 1.2);
  const hit = cands.find((c) => !blocked(c));
  check(hit, `候选落点都被别的居民挡住：${JSON.stringify(others.map((a) => [a.x.toFixed(1), a.z.toFixed(1)]))}`);
  return hit;
}

/** 某个页面里（按居民编号）看到的某人。 */
const seen = async (page, id) => (await snap(page)).actors.find((a) => a.id === id) ?? null;

// ───────────────────────── 主流程 ─────────────────────────

let A, B, A2, A3;
const extra = []; // 步骤 15 的两个独立页面（声音测试），并入全程检查
let aiClient = null;
let runner = null;
let aiId = null;
const metrics = { versions: {}, bundle: [], load: {} };

async function main() {
  console.log(`栖灯镇客户端端到端：临时目录 ${TMP}`);
  await startEngine();
  console.log(`引擎已就绪：${BASE}（开发登录、keys 认证、临时库）`);

  const chromiumBrowserA = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); // 信号交给本脚本自己的处理函数（Playwright 默认处理会抢先 process.exit，临时目录就删不掉）
  const chromiumBrowserB = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }); // 信号交给本脚本自己的处理函数（Playwright 默认处理会抢先 process.exit，临时目录就删不掉）
  browsers.push(chromiumBrowserA, chromiumBrowserB);
  metrics.versions.chromium = chromiumBrowserA.version();
  metrics.versions.node = process.version;
  try {
    metrics.versions.godot = execFileSync(process.env.GODOT || '/opt/godot/godot', ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    metrics.versions.godot = '（本机没有 Godot 可执行文件，未取到版本）';
  }
  for (const f of ['index.wasm', 'index.pck', 'index.js']) {
    const raw = statSync(join(CLIENT_DIR, f)).size;
    const gz = existsSync(join(CLIENT_DIR, `${f}.gz`)) ? statSync(join(CLIENT_DIR, `${f}.gz`)).size : null;
    const br = existsSync(join(CLIENT_DIR, `${f}.br`)) ? statSync(join(CLIENT_DIR, `${f}.br`)).size : null;
    metrics.bundle.push({ file: f, raw, gzip: gz, brotli: br });
  }

  A = await newPlayer(chromiumBrowserA, 'A 桌面', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { wsGate: true });
  B = await newPlayer(chromiumBrowserB, 'B 手机', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const nameA = `阿桌${rnd()}`;
  const nameB = `阿机${rnd()}`;

  // ── 1 ──
  await step(1, '两个页面登录进入，各自看见对方', async () => {
    const [la, lb] = await Promise.all([login(A, nameA, { shotEnter: '01-desktop-enter' }), login(B, nameB)]);
    metrics.load.desktop = la;
    metrics.load.mobile = lb;
    metrics.audio = { desktop: { before: la.audioBefore, after: la.audioAfter }, mobile: { before: lb.audioBefore, after: lb.audioAfter } };
    note(`音频：点「进入小镇」之前 AudioContext 状态 桌面 [${la.audioBefore}]，手机 [${lb.audioBefore}]；点之后 桌面 [${la.audioAfter}]，手机 [${lb.audioAfter}]`);
    check(la.audioAfter.includes('running'), `点「进入小镇」之后桌面页至少应有一个 AudioContext 处于 running，实际 [${la.audioAfter}]`);
    check(lb.audioAfter.includes('running'), `点「进入小镇」之后手机页至少应有一个 AudioContext 处于 running，实际 [${lb.audioAfter}]`);
    note(`桌面：到「进入」按钮 ${la.toButtonMs} ms，点进入到可操作 ${la.toPlayingMs} ms；手机：${lb.toButtonMs} ms / ${lb.toPlayingMs} ms（两个浏览器同时在软件渲染，仅供参考）`);
    const sa = await snap(A.page);
    const sb = await snap(B.page);
    check(sa.self && sb.self && sa.self !== sb.self, '两个页面应是两个不同的居民');
    A.id = sa.self;
    B.id = sb.self;
    await until(async () => (await snap(A.page)).actors.some((a) => a.id === B.id) && (await snap(B.page)).actors.some((a) => a.id === A.id), 15_000, '两个页面互相看到对方');
    check((await snap(A.page)).actors.length >= 2 && (await snap(B.page)).actors.length >= 2, '__town.actors 里应有两个人');
    note(`A=${A.id}（${nameA}），B=${B.id}（${nameB}），都在 ${sa.space}（${sa.spaceName}）`);
    // 开源许可入口：进入面板上有可见的链接（新窗口打开），文件取得到、Content-Type 是文本、内容里有 Godot 的 MIT 许可文字和素材致谢
    for (const [tag, l] of [['桌面', la], ['手机', lb]]) {
      check(l.licLink && l.licLink.visible && l.licLink.text === '开源许可' && l.licLink.href === 'licenses.txt' && l.licLink.target === '_blank', `${tag}页进入面板应有可见的「开源许可」链接（新窗口打开 licenses.txt），实际 ${JSON.stringify(l.licLink)}`);
    }
    {
      const lr = await A.ctx.request.get(`${BASE}/town/3d/licenses.txt`);
      const lt = await lr.text();
      check(lr.status() === 200, `licenses.txt 应能取到，实际 ${lr.status()}`);
      check(/^text\/plain/.test(lr.headers()['content-type'] ?? ''), `licenses.txt 的 Content-Type 应是 text/plain，实际 ${lr.headers()['content-type']}`);
      check(lt.includes('Permission is hereby granted, free of charge') && lt.includes('Godot Engine contributors') && lt.includes('CC0'), 'licenses.txt 里应有 Godot 的 MIT 许可文字、版权行和素材致谢');
      note(`开源许可文本 ${lt.length} 字符，Content-Type ${lr.headers()['content-type']}`);
    }
    // 引擎对 /town/3d/ 的包体：确认预压缩确实被选用（br）
    const r = await A.ctx.request.get(`${BASE}/town/3d/index.pck`, { headers: { 'Accept-Encoding': 'br' } });
    check(r.headers()['content-encoding'] === 'br', `index.pck 应发 br 预压缩，实际 content-encoding=${r.headers()['content-encoding']}`);
    await sleep(800);
    await shot(A.page, '02-desktop-two-residents');
    {
      // 记下两个页面这时的帧率和 3D 渲染分辨率（软件渲染下会被动态分辨率压低）：每 2 秒一次，共 5 次
      const rows = [];
      for (let i = 0; i < 5; i++) {
        await sleep(2000);
        const ra = await A.page.evaluate(() => [window.__town.fps, window.__town.drs, window.__town.quality].join('/'));
        const rb = await B.page.evaluate(() => [window.__town.fps, window.__town.drs, window.__town.quality].join('/'));
        rows.push(`${ra} | ${rb}`);
      }
      note(`帧率/3D分辨率/画质（软件渲染，桌面 | 手机）：${rows.join('；')}`);
    }
  });

  // ── 2 ──
  await step(2, 'A 点地走路：服务器里在走；B 页面里 A 的位置与服务器现算位置相差 < 0.6 米', async () => {
    // 位置对比用的是页面自己的服务器时间，所以先单独核对页面的时钟确实对准了服务器（A、B 两个页面都查；放在走路之前，免得占用走路的时间）
    await assertClock(B, '步骤 2 B 页');
    await assertClock(A, '步骤 2 A 页');
    await clickWorld(A, 42, 21);
    const sc0 = await until(async () => {
      const a = selfActor(await serverScene(A));
      return a?.nav ? a : null;
    }, 8000, '服务器 /scene 里 A 带 nav（在走）');
    note(`服务器：nav ${sc0.nav.id} rev ${sc0.nav.revision}，${normPts(sc0.nav.points).length} 个折点，速度 ${sc0.nav.speed} 米/秒`);
    await until(async () => (await seen(B.page, A.id))?.moving, 8000, 'B 页面里 A 在走（moving）');
    // 若干个时刻：B 页面的 A 显示位置 vs 服务器折线在「B 页面的服务器时间」的位置
    const errs = [];
    for (let i = 0; i < 14; i++) {
      // 同时取：B 页面的快照（含它自己的服务器时间）和服务器场景，减少两次读取之间的时间差
      const [sb, sc] = await Promise.all([snap(B.page), serverScene(A)]);
      const ab = sb.actors.find((a) => a.id === A.id);
      const na = selfActor(sc);
      if (!na?.nav) break; // 已走到
      if (ab && na.nav.points) errs.push(dist(ab, polyAt(na.nav, sb.serverNow)));
      await sleep(250);
    }
    check(errs.length >= 3, `有效采样太少（${errs.length}）`);
    const max = Math.max(...errs);
    note(`${errs.length} 个采样，B 页面里 A 的位置与服务器折线现算位置相差：${errs.map((e) => e.toFixed(2)).join(' ')} 米，最大 ${max.toFixed(2)}`);
    check(max < T_POS, `最大偏差 ${max.toFixed(2)} 米，超过 ${T_POS} 米`);
    // 走完后 A 页面、B 页面、服务器三者一致
    await until(async () => !selfActor(await serverScene(A))?.nav, 30_000, 'A 走到目的地');
    await sleep(1200);
    const fin = selfActor(await serverScene(A));
    const fa = await seen(A.page, A.id);
    const fb = await seen(B.page, A.id);
    check(dist(fin, fa) < 0.3 && dist(fin, fb) < 0.3, `停下后位置不一致：服务器 ${fin.x.toFixed(2)},${fin.z.toFixed(2)} A页 ${fa.x.toFixed(2)},${fa.z.toFixed(2)} B页 ${fb.x.toFixed(2)},${fb.z.toFixed(2)}`);
    note(`到达后：服务器 (${fin.x.toFixed(2)}, ${fin.z.toFixed(2)})，A 页 ${dist(fin, fa).toFixed(2)} 米，B 页 ${dist(fin, fb).toFixed(2)} 米`);
  });

  // ── 3 ──
  await step(3, 'A 走路中点「停下」：服务器 nav 为空；B 页面里 A 停住并与服务器一致', async () => {
    await clickWorld(A, 24, 21);
    await until(async () => selfActor(await serverScene(A))?.nav, 8000, 'A 开始走');
    await sleep(1200);
    await shot(A.page, '04-desktop-walking');
    check(await A.page.$eval('#stopBtn', (e) => !e.disabled), '走路中「停下」应可点');
    await A.page.click('#stopBtn');
    await until(async () => !selfActor(await serverScene(A))?.nav, 8000, '服务器里 A 的 nav 清空');
    const srv = selfActor(await serverScene(A));
    await until(async () => (await seen(B.page, A.id))?.moving === false, 8000, 'B 页面里 A 停住');
    await sleep(1500); // 让显示位置收敛（指数衰减），不是等条件
    const fb = await seen(B.page, A.id);
    const fa = await seen(A.page, A.id);
    const srv2 = selfActor(await serverScene(A));
    check(srv2.x === srv.x && srv2.z === srv.z, '停下之后服务器位置不应再变');
    check(dist(srv2, fb) < 0.3 && dist(srv2, fa) < 0.3, `停住后偏差：B页 ${dist(srv2, fb).toFixed(2)} 米，A页 ${dist(srv2, fa).toFixed(2)} 米`);
    const traveled = dist(srv2, { x: 42, z: 21 });
    note(`停在 (${srv2.x.toFixed(2)}, ${srv2.z.toFixed(2)})，离出发点 ${traveled.toFixed(1)} 米；B 页偏差 ${dist(srv2, fb).toFixed(2)}，A 页偏差 ${dist(srv2, fa).toFixed(2)}`);
    check(srv2.x > 25, '应当是在去西边的半路上被停下的');
  });

  // ── 4 ──
  await step(4, 'A 走路中再点别处（改道）：导航编号变了，最终到达新目标', async () => {
    await clickWorld(A, 44, 21); // 从步骤 3 停下的位置往东走一段长路
    const n1 = await until(async () => selfActor(await serverScene(A))?.nav, 8000, 'A 开始走');
    await sleep(1200);
    const target = { x: 38, z: 26 };
    const clicked = await clickWorld(A, target.x, target.z);
    note(`改道点击后动作记录：${JSON.stringify(A.w.actions.slice(-3).map((r) => [r.type, r.status, r.code]))}`);
    const n2 = await until(async () => {
      const nv = selfActor(await serverScene(A))?.nav;
      return nv && (nv.id !== n1.id || nv.revision !== n1.revision) ? nv : null;
    }, 8000, '导航编号或版本变化').catch(async (e) => {
      const sc = selfActor(await serverScene(A));
      throw new Error(`${e.message}；n1=${JSON.stringify({ id: n1.id, r: n1.revision, pts: n1.points })} 现在=${JSON.stringify(sc)} 动作=${JSON.stringify(A.w.actions.slice(-4))} 点击=${JSON.stringify(clicked)}`);
    });
    note(`旧 ${n1.id}#${n1.revision} → 新 ${n2.id}#${n2.revision}`);
    await until(async () => !selfActor(await serverScene(A))?.nav, 40_000, 'A 走到新目标');
    const fin = selfActor(await serverScene(A));
    // 以客户端实际发给服务器的目标点为准（走路中镜头还在跟随，鼠标落点和 project 算出的点会差一小截；超出视野时 clickWorld 也会缩回来）
    const sent = [...A.w.actions].reverse().find((r) => r.type === 'navigate' && r.to && typeof r.to === 'object');
    check(sent, '没有记录到 navigate 的目标点');
    const goal = { x: sent.to.x, z: sent.to.z };
    note(`改道点击的世界点 (${clicked.x.toFixed(1)}, ${clicked.z.toFixed(1)})，客户端实际发出的目标 (${goal.x.toFixed(2)}, ${goal.z.toFixed(2)})`);
    check(dist(fin, goal) < 1.0, `最终位置 (${fin.x.toFixed(2)},${fin.z.toFixed(2)}) 离新目标 (${goal.x.toFixed(2)},${goal.z.toFixed(2)}) ${dist(fin, goal).toFixed(2)} 米`);
    await sleep(1200);
    const fb = await seen(B.page, A.id);
    check(dist(fin, fb) < 0.4, `B 页面里 A 离服务器位置 ${dist(fin, fb).toFixed(2)} 米`);
    note(`到达 (${fin.x.toFixed(2)}, ${fin.z.toFixed(2)})，离新目标 ${dist(fin, goal).toFixed(2)} 米`);
  });

  // ── 4.5 ──
  await step(4.5, 'A 用键盘走路（WASD / 方向键）：按住就走、松开约 0.5 秒内停下；Esc、窗口失焦都会停；点地能打断；页面只发方向、序号、控制版本，不发坐标', async () => {
    await until(async () => !selfActor(await serverScene(A))?.nav, 20_000, 'A 空闲');
    await sleep(600);
    const T_STOP = 1000; // 松开到服务器里停下：服务器端租约 500 毫秒，加上帧间隔和往返
    const navNow = async () => selfActor(await serverScene(A))?.nav ?? null;
    // 起步等待超时时把位置和页面状态带进错误信息，分得清是「没发出方向帧」还是「服务器没接受」
    const startedWalking = (ms, what) =>
      until(navNow, ms, what).catch(async (e) => {
        const me = selfActor(await serverScene(A));
        const d = await A.page.evaluate(() => ({ dir: window.__town.dir, mine: window.__town.mine, conn: window.__town.connection, last: window.__town.lastError }));
        throw new Error(`${e.message}；A 在 (${me?.x?.toFixed(2)}, ${me?.z?.toFixed(2)})，页面 ${JSON.stringify(d)}，已发方向帧 ${A.gate.dirFrames.length} 条，最后一条 ${A.gate.dirFrames.at(-1) ?? '无'}`);
      });
    const stoppedWithin = async (ms, what) => {
      const t0 = Date.now();
      await until(async () => !(await navNow()), ms, what, 100);
      return Date.now() - t0;
    };
    // 起点固定在广场东口的路中间（z≈26.5 这一条向东一直通到 x=62）：不依赖前面的步骤把 A 留在哪里。
    // 只用 --only 跑这一步时 A 可能停在别处（比如步骤 2 的终点离 x=44 的障碍只有 2 米，按住 D 两秒就贴上去了）。
    const start = await clearSpot(A, [{ x: 36, z: 26.5 }, { x: 34, z: 26.5 }, { x: 38, z: 26.5 }, { x: 32, z: 26.5 }]);
    await walkTo(A, start.x, start.z);
    await until(async () => !selfActor(await serverScene(A))?.nav, 20_000, 'A 走到起点后空闲');
    await sleep(300);
    A.gate.dirFrames.length = 0;
    const p0 = selfActor(await serverScene(A));

    // 1. 按住 D（向东）：服务器里是一段短路线，租约约 500 毫秒；B 页面看到的位置与服务器折线一致
    await A.page.keyboard.down('d');
    const n1 = await startedWalking(8000, '按下 D 后服务器里 A 在走');
    check(n1.until - n1.startedAt <= 600, `方向输入的路线租约应约 500 毫秒，实际 ${n1.until - n1.startedAt} 毫秒`);
    check(normPts(n1.points).length === 2 && normPts(n1.points)[1].x > normPts(n1.points)[0].x, '按 D 应是朝东的一段直线');
    const errs = [];
    for (let i = 0; i < 8; i++) {
      const [sb, sc] = await Promise.all([snap(B.page), serverScene(A)]);
      const na = selfActor(sc);
      const ab = sb.actors.find((a) => a.id === A.id);
      if (na?.nav && ab) errs.push(dist(ab, polyAt(na.nav, sb.serverNow)));
      await sleep(250);
    }
    const p1 = selfActor(await serverScene(A));
    check(await navNow(), '按住 D 2 秒后仍应在走（页面在定时重发）');
    note(`按住 D 约 2.2 秒：服务器里 x 从 ${p0.x.toFixed(2)} 到 ${p1.x.toFixed(2)}（向东 ${(p1.x - p0.x).toFixed(2)} 米，z 变化 ${Math.abs(p1.z - p0.z).toFixed(3)}），B 页面与折线现算位置相差最大 ${Math.max(0, ...errs).toFixed(2)} 米（${errs.length} 个采样）`);
    check(p1.x - p0.x > 2.0 && Math.abs(p1.z - p0.z) < 0.05, '应一直朝东走');
    // 方向输入的路线每段只有约 500 毫秒租约：慢的观察者（软件渲染 3~8 帧）在下一份快照到达前会停在上一段的截止点，最多差一个租约长（1.2 米）
    const T_POS_DIR = T_POS + (n1.speed * (n1.until - n1.startedAt)) / 1000;
    check(errs.length >= 3 && Math.max(...errs) < T_POS_DIR, `B 页面与服务器折线相差过大（容差 ${T_POS_DIR.toFixed(2)} 米）：${errs.map((e) => e.toFixed(2)).join(' ')}`);
    await shot(A.page, '15-desktop-keyboard-walk');

    // 2. 松开：服务器里很快停下，之后位置不再变
    await A.page.keyboard.up('d');
    const tStop = await stoppedWithin(T_STOP + 2000, '松开 D 后服务器里 A 停下');
    // 慢机器上松手前最后一条重发可能在「第一次看到没在走」之后才到，随即被零向量盖掉：多等一会儿再取停下的位置
    let stopAt = selfActor(await serverScene(A));
    for (let i = 0; i < 12; i++) {
      await sleep(300); // 位置连续两次相同才算停稳
      const again = selfActor(await serverScene(A));
      const moved = dist(stopAt, again) > 0.0005;
      stopAt = again;
      if (!moved) break;
    }
    const trace = [];
    for (let i = 0; i < 9; i++) {
      await sleep(100);
      const t = selfActor(await serverScene(A));
      trace.push(`${t.x.toFixed(3)}${t.nav ? '*' : ''}`);
    }
    const later = selfActor(await serverScene(A));
    note(`松开 D 到服务器里停下：${tStop} 毫秒（含轮询）；停下后 0.9 秒位置变化 ${dist(stopAt, later).toFixed(3)} 米`);
    check(tStop <= T_STOP + 600, `松开后 ${tStop} 毫秒才停`);
    // 机器很忙时最后一条重发和零向量会一起迟到、前后相差几毫秒落地（走了不到 0.06 米），所以容差取 0.06 米；空闲时实测为 0.000
    check(dist(stopAt, later) < 0.06, `停下后位置不应再变：停下时 x=${stopAt.x.toFixed(3)}，之后 ${trace.join(' ')}；最后几条帧 ${A.gate.dirFrames.slice(-3).join(' ')}`);
    const fa = await seen(A.page, A.id);
    check(dist(fa, later) < 0.4, `A 页面里的自己离服务器位置 ${dist(fa, later).toFixed(2)} 米`);
    await until(async () => (await seen(B.page, A.id))?.moving === false, 8000, 'B 页面里 A 停住');
    await sleep(1500);
    const fb = await seen(B.page, A.id);
    check(dist(fb, later) < 0.4, `停下后 B 页面里的 A 离服务器位置 ${dist(fb, later).toFixed(2)} 米`);

    // 3. 方向键 + 斜向：向上和向左同时按 = 朝西北
    const q0 = selfActor(await serverScene(A));
    await A.page.keyboard.down('ArrowUp');
    await A.page.keyboard.down('ArrowLeft');
    const n3 = await until(navNow, 8000, '按下 ↑← 后服务器里 A 在走');
    const pts3 = normPts(n3.points);
    const dx3 = pts3[1].x - pts3[0].x;
    const dz3 = pts3[1].z - pts3[0].z;
    check(dx3 < 0 && dz3 < 0 && Math.abs(Math.abs(dx3) - Math.abs(dz3)) < 0.02, `↑← 应是朝西北的 45 度斜线，实际 (${dx3.toFixed(2)}, ${dz3.toFixed(2)})`);
    await sleep(800);
    await A.page.keyboard.up('ArrowUp');
    await A.page.keyboard.up('ArrowLeft');
    await stoppedWithin(T_STOP + 2000, '松开方向键后停下');
    const q1 = selfActor(await serverScene(A));
    note(`↑← 斜向走了 ${dist(q0, q1).toFixed(2)} 米（西北）`);
    check(q1.x < q0.x && q1.z < q0.z, '应走到西北方向');

    // 4. Esc 停步：键还按着也不会再走，松开键之后才能再次起步
    // 前面几段一路向东，走得快时会贴到东边的障碍（x≈44）上，那时再按 D 服务器没有路可走，nav 为空：先回到开阔处
    await walkTo(A, p0.x, p0.z, 1.5);
    await A.page.keyboard.down('d');
    await startedWalking(8000, '再次按下 D 后在走');
    await sleep(500);
    await A.page.keyboard.press('Escape');
    const tEsc = await stoppedWithin(T_STOP + 2000, 'Esc 后服务器里 A 停下');
    let e0 = selfActor(await serverScene(A));
    for (let i = 0; i < 12; i++) {
      await sleep(300); // 同上：位置连续两次相同才算停稳
      const again = selfActor(await serverScene(A));
      const moved = dist(e0, again) > 0.0005;
      e0 = again;
      if (!moved) break;
    }
    await sleep(900);
    const e1 = selfActor(await serverScene(A));
    note(`Esc 到停下 ${tEsc} 毫秒；键仍按着时 0.9 秒后位置变化 ${dist(e0, e1).toFixed(3)} 米（应为 0）`);
    check(dist(e0, e1) < 0.06 && !(await navNow()), 'Esc 之后键还按着，不应继续走');
    await A.page.keyboard.up('d');

    // 5. 窗口失焦：当作全部松开（同上，先回到开阔处，免得上一段向东走到障碍边）
    await walkTo(A, p0.x, p0.z, 1.5);
    await A.page.keyboard.down('d');
    await startedWalking(8000, '第三次按下 D 后在走');
    await sleep(400);
    await A.page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const tBlur = await stoppedWithin(T_STOP + 2000, '窗口失焦后服务器里 A 停下');
    note(`窗口失焦到停下 ${tBlur} 毫秒`);
    await A.page.keyboard.up('d');

    // 6. 方向输入走路时点地：点地路线接手（按着键也不会被方向输入盖掉），走的是长路线
    // 连续做三遍：点地与方向帧走两条通道，到达顺序不定，靠页面带的序号栅栏保证点地路线不被在途的旧方向帧盖掉
    for (let round = 1; round <= 3; round++) {
      const act0 = A.w.actions.length;
      // 先回到开阔处（前面几段一路向东，已经贴近东边界，那里去西边的路要先绕一下）
      await walkTo(A, p0.x, p0.z, 1.5);
      await A.page.keyboard.down('d');
      await until(navNow, 8000, '第四次按下 D 后在走');
      await sleep(300);
      const c0 = selfActor(await serverScene(A));
      const fr0 = A.gate.dirFrames.length;
      const clicked = await clickWorld(A, c0.x - 12, c0.z + 4);
      const longNav = await until(async () => {
        const nv = await navNow();
        return nv && nv.until - nv.startedAt > 3000 ? nv : null;
      }, 8000, '点地后换成长路线（租约 10 秒）');
      await sleep(1500);
      const c1 = selfActor(await serverScene(A));
      note(`按着 D 时点地向西：点击世界点 (${clicked.x.toFixed(1)}, ${clicked.z.toFixed(1)})，1.5 秒后 x ${c0.x.toFixed(1)} → ${c1.x.toFixed(1)}，导航租约 ${(longNav.until - longNav.startedAt) / 1000} 秒`);
      // 去目标的路可能先绕一下（东边靠近边界处），所以不比方向，只比：这条长路线还在、终点是点的地方、人在沿它走
      const lp = normPts(longNav.points);
      const lastP = lp[lp.length - 1];
      const stillLong = await navNow();
      check(dist(lastP, clicked) < 3 && dist(lp[0], c1) > 1.0 && (!stillLong || stillLong.id === longNav.id), `点地之后应沿点地路线走，不能被还按着的 D 盖回去：终点 (${lastP.x.toFixed(1)}, ${lastP.z.toFixed(1)})，走了 ${dist(c0, c1).toFixed(2)} 米，折线 ${JSON.stringify(lp)}，起点 (${c0.x.toFixed(1)}, ${c0.z.toFixed(1)}) 现在 (${c1.x.toFixed(1)}, ${c1.z.toFixed(1)})`);
      await A.page.keyboard.up('d');
      await sleep(500);
      check(await navNow(), `松开 D 不应取消点地路线；点地后页面又发了方向帧：${A.gate.dirFrames.slice(fr0).join(' ')}；动作 ${JSON.stringify(A.w.actions.slice(-3))}`);
      await A.page.click('#stopBtn');
      await stoppedWithin(8000, '点「停下」后停下');
      const navActs = A.w.actions.slice(act0).filter((r) => r.type === 'navigate');
      check(navActs.length >= 1 && navActs.every((r) => r.fence && Number.isInteger(r.fence.conn) && Number.isInteger(r.fence.seq) && r.fence.seq > 0), `第 ${round} 遍：点地动作应带序号栅栏：${JSON.stringify(navActs)}`);
      // 点地之后再按一个新的方向键（新的按下沿）：方向输入接手。某个方向正好贴着墙（原地不动）就换一个方向
      let takeover = null;
      for (const key of ['s', 'a', 'd', 'w']) {
        await A.page.keyboard.down(key);
        takeover = await until(async () => {
          const nv = await navNow();
          return nv && nv.until - nv.startedAt <= 600 ? nv : null;
        }, 2500, `第 ${round} 遍：点地之后新按下的方向键应接手`).catch(() => null);
        await A.page.keyboard.up(key);
        await stoppedWithin(T_STOP + 2000, '松开后停下');
        if (takeover) break;
      }
      check(takeover, `第 ${round} 遍：点地之后新按下的方向键（s/a/d/w 都试过）没有接手`);
      note(`第 ${round} 遍：点地路线保住，新按键接手（租约 ${takeover.until - takeover.startedAt} 毫秒）`);
    }

    // 7. 页面发出的帧：只有方向、序号、控制版本，没有坐标；序号严格递增
    const frames = A.gate.dirFrames.map((m) => JSON.parse(m));
    const keysOk = frames.every((f) => Object.keys(f).sort().join() === 'epoch,seq,t,x,z' && Math.abs(f.x) <= 1 && Math.abs(f.z) <= 1 && Number.isInteger(f.seq) && Number.isInteger(f.epoch));
    const seqOk = frames.every((f, i) => i === 0 || f.seq > frames[i - 1].seq);
    const zeros = frames.filter((f) => f.x === 0 && f.z === 0).length;
    note(`页面共发出 ${frames.length} 条方向输入（其中 ${zeros} 条零向量），字段只有 t/seq/epoch/x/z，序号严格递增`);
    check(frames.length >= 10 && keysOk && seqOk, `方向输入帧不合格：${JSON.stringify(frames.slice(0, 3))}`);
    check(zeros >= 4, `松手、Esc、失焦、点地都应发零向量，实际零向量 ${zeros} 条`);
    // 方向输入没有产生任何失败请求或错误提示
    const s = await snap(A.page);
    check(!JSON.stringify(s.toasts ?? []).includes('控制权'), `不应出现控制权提示：${JSON.stringify(s.toasts)}`);
    // 把 A 点地走回起点：后面的步骤要求喷泉在视野里
    await walkTo(A, p0.x, p0.z, 1.5);
  });

  // ── 5 ──
  await step(5, '点不可走的地方：有失败提示，角色不动；点障碍内部：按服务器规则', async () => {
    // 先点障碍内部（喷泉正中，从广场里点得到）。服务器规则是「2.5 米内取最近可走点」：要么拒绝要么走到喷泉边上
    const m0 = A.w.actions.length;
    // 声明：下面空地那一下必定被拒绝（1 次）；喷泉正中的 navigate 是否被拒取决于「最近可走点」规则（再多 0~1 次）
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 2, why: '步骤 5：点空地必定 unreachable；喷泉正中可能被拒' });
    // 新镜头更近（俯角低、距离短），喷泉要离角色 ~10 米以内才在可点区域里：先走到广场南侧
    // 落点不能选在别的居民身后：广场落脚点 (32, 30.25) 上常站着人，点 (32, 29) 会点到 ta 身上
    const south = await clearSpot(A, [{ x: 32, z: 29 }, { x: 29, z: 29 }, { x: 35, z: 29 }, { x: 29, z: 27.5 }, { x: 35, z: 27.5 }]);
    note(`先走到广场南侧 (${south.x}, ${south.z})`);
    await walkTo(A, south.x, south.z);
    const spot = { x: 32, z: 24 }; // 喷泉正中，喷泉脚印 (30.5..33.5, 22.5..25.5)
    const q = await project(A.page, spot.x, spot.z);
    const vp = await viewport(A.page);
    if (q.x > 24 && q.x < vp.w - 24 && q.y > 100 && q.y < vp.h - 170) {
      await A.page.mouse.click(q.x, q.y);
      const r2 = await until(() => A.w.actions.slice(m0).find((r) => r.type === 'navigate'), 8000, '喷泉中心的 navigate 有回应');
      if (r2.status >= 400) {
        note(`喷泉正中：服务器拒绝 ${r2.code}`);
      } else {
        await until(async () => !selfActor(await serverScene(A))?.nav, 40_000, '走到喷泉边');
        const f = selfActor(await serverScene(A));
        const inside = f.x > 30.5 && f.x < 33.5 && f.z > 22.5 && f.z < 25.5;
        note(`喷泉正中：服务器接受，走到最近可走点 (${f.x.toFixed(2)}, ${f.z.toFixed(2)})`);
        check(!inside, '角色不应停在喷泉脚印里');
      }
    } else {
      throw new Error('喷泉不在当前视野内，没法点它');
    }
    await walkTo(A, 14, 39.5); // 走到南边路的下沿，正南 4 米处的空地离最近可走点 > 2.5 米，又在视野里
    const before = selfActor(await serverScene(A));
    const n0 = A.w.actions.length;
    // 路（z 36~40）以南、游戏馆（x≥24）以西的空地 (14,43.5)，离最近可走点约 3.8 米 > 2.5 米；不缩回视野，直接点这个点
    const void_ = await project(A.page, 14, 43.5);
    const vp0 = await viewport(A.page);
    check(void_.x > 24 && void_.x < vp0.w - 24 && void_.y > 100 && void_.y < vp0.h - 170, `空地投影 (${void_.x.toFixed(0)},${void_.y.toFixed(0)}) 不在视野内`);
    await A.page.mouse.click(void_.x, void_.y);
    const rec = await until(() => A.w.actions.slice(n0).find((r) => r.type === 'navigate' && r.status >= 400 && r.code), 8000, '服务器拒绝这次 navigate');
    note(`服务器拒绝：HTTP ${rec.status} ${rec.code}/${rec.reason}「${rec.message}」`);
    check([rec.code, rec.reason].some((c) => ['unreachable', 'no_route'].includes(c)), `期望 unreachable 或 no_route，实际 ${rec.code}/${rec.reason}`);
    const shown = await until(async () => {
      const s = await snap(A.page);
      const hit = rec.message && JSON.stringify(s.toasts ?? []).includes(rec.message);
      return hit ? { toasts: s.toasts, lastError: s.lastError } : null;
    }, 5000, '界面上出现失败提示');
    note(`界面提示：${JSON.stringify(shown.toasts)} lastError=${JSON.stringify(shown.lastError)}`);
    await shot(A.page, '05-desktop-unreachable');
    await sleep(600);
    const after = selfActor(await serverScene(A));
    check(!after.nav && after.x === before.x && after.z === before.z, '被拒绝后角色不应移动');
    await until(async () => !(await snap(A.page)).pending, 6000, '界面不再处于等待确认');
  });

  // ── 6 ──
  await step(6, '走近公共物件做动作：远处直接做 → too_far；走近后成功', async () => {
    const n0 = A.w.actions.length;
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '步骤 6：远处直接 start_interaction 必定 too_far' });
    await A.page.evaluate(() => window.__town.act({ type: 'start_interaction', objectId: 'bookshop:shelf' }));
    const rec = await until(() => A.w.actions.slice(n0).find((r) => r.type === 'start_interaction' && r.code), 8000, 'too_far 回应');
    check(rec.reason === 'too_far' || rec.code === 'too_far', `期望 too_far，实际 ${rec.code}/${rec.reason}（${rec.message}）`);
    const msg = await until(async () => {
      const s = await snap(A.page);
      const all = JSON.stringify(s.toasts ?? []) + JSON.stringify(s.lastError ?? '');
      return /太远/.test(all) ? all : null;
    }, 5000, '界面提示里有「太远」');
    note(`远处直接做：${rec.code}/${rec.reason}「${rec.message}」；界面 ${msg.slice(0, 80)}`);
    await shot(A.page, '06-desktop-too-far');
    await A.page.click('#destBtn');
    await A.page.click('[data-dest=bookshop]');
    await until(async () => {
      const s = await snap(A.page);
      const a = s.actors.find((x) => x.id === s.self);
      return s.space === 'bookshop' && a && !a.moving;
    }, 90_000, 'A 走进檐下书屋并停下');
    await until(async () => (await snap(A.page)).nearValid === true, 10_000, '近处状态有效');
    await sleep(500);
    const shelf = (await snap(A.page)).objects.find((o) => o.id === 'bookshop:shelf');
    check(shelf, '__town.objects 里应有藏书架');
    const sp = await A.page.evaluate(() => window.__town.objects.find((o) => o.id === 'bookshop:shelf'));
    await A.page.mouse.click(sp.sx, sp.sy);
    await A.page.waitForSelector('#actions button.do', { timeout: 60_000 });
    const label = await A.page.$eval('#actions button.do', (e) => e.textContent.trim());
    const m0 = A.w.actions.length;
    await A.page.click('#actions button.do');
    const ok = await until(() => A.w.actions.slice(m0).find((r) => r.type === 'start_interaction'), 8000, '读书的 start_interaction 有回应');
    check(ok.status === 200, `走近后做动作应成功，实际 ${ok.status} ${ok.code}`);
    await until(async () => /读书|正在/.test(await A.page.$eval('#activityChip', (e) => (e.hidden ? '' : e.textContent))), 8000, '界面出现「正在：读书」');
    await sleep(600);
    note(`走近后点「${label}」：HTTP ${ok.status}`);
    await shot(A.page, '07-desktop-reading');
    if (await A.page.$eval('#leaveActBtn', (e) => !e.disabled && !e.hidden).catch(() => false)) {
      await A.page.click('#leaveActBtn');
      await sleep(600);
    }
  });

  // ── 7 ──
  await step(7, 'B（手机）触摸点地走、双指缩放不触发行走、点界面按钮不触发行走', async () => {
    await until(async () => !selfActor(await serverScene(B))?.nav, 5000, 'B 空闲');
    await clickWorld(B, 38, 27);
    await until(async () => selfActor(await serverScene(B))?.nav, 8000, '触摸点地后服务器里 B 在走');
    await until(async () => (await seen(A.page, B.id))?.moving, 8000, 'A 页面里 B 在走');
    await sleep(700);
    await shot(B.page, '03-mobile-walking');
    // 手机竖屏（390 宽）顶栏：地点胶囊完整显示地点名（不被省略号截断），顶栏不超出屏幕。平时的状态，再加一次最长情形（五个汉字的地点名 + 重连中文字）
    {
      const topbar = () =>
        B.page.evaluate(() => {
          const sp = document.getElementById('space');
          const where = document.getElementById('where');
          const bar = document.getElementById('topbar');
          const kids = [...bar.children].filter((e) => getComputedStyle(e).display !== 'none' && !e.classList.contains('spacer'));
          return {
            vw: window.innerWidth,
            space: sp.textContent,
            spaceScroll: sp.scrollWidth,
            spaceClient: sp.clientWidth,
            whereScroll: where.scrollWidth,
            whereClient: where.clientWidth,
            barScroll: bar.scrollWidth,
            barClient: bar.clientWidth,
            maxRight: Math.max(...kids.map((e) => e.getBoundingClientRect().right)),
            minLeft: Math.min(...kids.map((e) => e.getBoundingClientRect().left)),
            docScroll: document.documentElement.scrollWidth,
            rows: new Set(kids.map((e) => Math.round(e.getBoundingClientRect().top))).size,
          };
        });
      const okTop = (t, tag) => {
        check(t.spaceScroll <= t.spaceClient, `${tag}：地点胶囊的文字被截断了（scrollWidth ${t.spaceScroll} > clientWidth ${t.spaceClient}，「${t.space}」）`);
        check(t.whereScroll <= t.whereClient, `${tag}：地点胶囊内容溢出（${t.whereScroll} > ${t.whereClient}）`);
        check(t.barScroll <= t.barClient && t.maxRight <= t.vw && t.minLeft >= 0 && t.docScroll <= t.vw, `${tag}：顶栏超出屏幕宽度 ${JSON.stringify(t)}`);
        check(t.rows === 1, `${tag}：顶栏应保持一行，实际 ${t.rows} 行`);
      };
      const t0 = await topbar();
      okTop(t0, '手机顶栏');
      const stress = await B.page.evaluate(() => {
        const sp = document.getElementById('space');
        const ct = document.getElementById('connText');
        const old = [sp.textContent, ct.textContent, ct.hidden];
        sp.textContent = '栖灯茶馆会';
        ct.textContent = '重连中…';
        ct.hidden = false;
        return old;
      });
      const t1 = await topbar();
      await B.page.evaluate((old) => {
        document.getElementById('space').textContent = old[0];
        document.getElementById('connText').textContent = old[1];
        document.getElementById('connText').hidden = old[2];
      }, stress);
      okTop(t1, '手机顶栏（五字地点名 + 重连中文字）');
      note(`手机顶栏 ${t0.vw} 宽：地点「${t0.space}」${t0.spaceScroll}/${t0.spaceClient}，最右 ${Math.round(t0.maxRight)}；最长情形最右 ${Math.round(t1.maxRight)}，${t1.rows} 行`);
    }
    await until(async () => !selfActor(await serverScene(B))?.nav, 30_000, 'B 走到');
    const start = selfActor(await serverScene(B));
    const nAct = B.w.actions.length;
    // 双指缩放（CDP 触摸事件）
    const cdp = await B.ctx.newCDPSession(B.page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
    const z0 = (await snap(B.page)).zoom;
    await touch('touchStart', [[150, 380], [240, 380]]);
    for (let k = 1; k <= 7; k++) {
      await touch('touchMove', [[150 - k * 12, 380], [240 + k * 12, 380]]);
      await sleep(70);
    }
    await shot(B.page, '08-mobile-pinch-zoom');
    await touch('touchEnd', []);
    await sleep(500);
    const z1 = (await snap(B.page)).zoom;
    note(`双指张开：镜头距离 ${z0.toFixed(2)} → ${z1.toFixed(2)}`);
    check(Math.abs(z1 - z0) > 0.05, '双指缩放应改变镜头距离');
    await sleep(800);
    const noNav = B.w.actions.slice(nAct).filter((r) => r.type === 'navigate');
    check(noNav.length === 0, `双指缩放不应发出 navigate，实际发出 ${noNav.length} 条`);
    check(!selfActor(await serverScene(B)).nav, '双指缩放之后服务器里 B 不应在走');
    // 点界面按钮：声音开关、地点按钮（点开菜单再点一次关上），都不应触发行走
    await B.page.touchscreen.tap(...(await B.page.$eval('#soundBtn', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
    await sleep(500);
    await B.page.touchscreen.tap(...(await B.page.$eval('#destBtn', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
    await sleep(500);
    const menuOpen = await B.page.$eval('#destMenu', (e) => !e.hidden && getComputedStyle(e).display !== 'none').catch(() => false);
    check(menuOpen, '触摸点「地点」按钮应展开菜单（说明点到了按钮）');
    note('点「声音」「地点」按钮：按钮起作用（地点菜单展开），没有发出 navigate');
    await B.page.touchscreen.tap(...(await B.page.$eval('#destBtn', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
    await sleep(800);
    const navs = B.w.actions.slice(nAct).filter((r) => r.type === 'navigate');
    check(navs.length === 0, `点界面按钮不应发出 navigate，实际 ${navs.length} 条`);
    const end = selfActor(await serverScene(B));
    check(!end.nav && end.x === start.x && end.z === start.z, '点界面按钮后 B 不应移动');

    // 点按判定的阈值按 CSS 像素算（tap-threshold-dpr-1）：dsf 2 的手机上，手指抖 8 个 CSS 像素（16 物理像素，旧阈值 14 物理像素会吞掉）仍是点按；
    // 单指拖 30 个 CSS 像素（60 物理像素）不是点按。坐标是 CDP 的 CSS 像素。
    const dpr = await B.page.evaluate(() => window.devicePixelRatio);
    check(dpr === 2, `手机上下文的 devicePixelRatio 应为 2，实际 ${dpr}`);
    const pickGround = async () => {
      const s0 = await snap(B.page);
      const me = s0.actors.find((a) => a.id === s0.self);
      const vp = await viewport(B.page);
      for (const [dx, dz] of [[3, 2], [-3, 2], [3, -3], [-3, -3], [5, 0], [-5, 0]]) {
        const q = await project(B.page, me.x + dx, me.z + dz);
        // 左右各留 40 像素给拖动，顶部避开顶栏，底部避开底栏
        if (q.x > 60 && q.x < vp.w - 60 && q.y > 130 && q.y < vp.h - 200) return q;
      }
      throw new Error('找不到可以点的空地');
    };
    const q1 = await pickGround();
    const nTap = B.w.actions.length;
    // 渲染饥饿时每条 CDP 触摸命令要等渲染进程应答（实测一条约 0.4~0.5 秒），逐条 await 会把「按下到抬起」拖过客户端 700 毫秒的点按时限，
    // 测的就成了时限而不是位移阈值。所以整段手势一次性发出（命令在同一个会话里按顺序执行），再一起等应答。
    const tt0 = Date.now();
    await Promise.all([
      touch('touchStart', [[q1.x, q1.y]]),
      touch('touchMove', [[q1.x + 4, q1.y]]),
      touch('touchMove', [[q1.x + 8, q1.y]]),
      touch('touchEnd', []),
    ]);
    note(`抖动点按整段手势发出并应答耗时 ${Date.now() - tt0} ms`);
    const tapRec = await until(() => B.w.actions.slice(nTap).find((r) => r.type === 'navigate'), 8000, '手指抖 8 个 CSS 像素的点按仍触发 navigate');
    check(tapRec.status === 200, `抖动点按的 navigate 应成功，实际 ${tapRec.status} ${tapRec.code}`);
    await until(async () => selfActor(await serverScene(B))?.nav, 8000, '抖动点按之后服务器里 B 在走');
    note(`dsf ${dpr}：触摸按下后挪 8 个 CSS 像素再抬起，仍发出 navigate（HTTP ${tapRec.status}）`);
    await until(async () => !selfActor(await serverScene(B))?.nav, 30_000, 'B 走完');
    await sleep(500);
    const q2 = await pickGround();
    const nDrag = B.w.actions.length;
    const before = selfActor(await serverScene(B));
    await Promise.all([
      touch('touchStart', [[q2.x - 15, q2.y]]),
      ...[1, 2, 3, 4, 5, 6].map((k) => touch('touchMove', [[q2.x - 15 + k * 5, q2.y]])), // 一共拖 30 个 CSS 像素
      touch('touchEnd', []),
    ]);
    await sleep(1500);
    const dragNav = B.w.actions.slice(nDrag).filter((r) => r.type === 'navigate');
    check(dragNav.length === 0, `单指拖 30 个 CSS 像素不应发出 navigate，实际 ${dragNav.length} 条`);
    const after = selfActor(await serverScene(B));
    check(!after.nav && after.x === before.x && after.z === before.z, '拖动之后 B 不应在走');
    note('单指拖动 30 个 CSS 像素：没有 navigate，B 没动');
  });

  // ── 8 ──
  await step(8, 'AI 居民（agent-kit 的 ResidentRunner，决策函数写死）navigate 到茶馆：路比导航租约长，续租由运行器自动做，两个页面都看见它走过去', async () => {
    const { TownClient, ResidentRunner } = await import(new URL('../packages/agent-kit/src/index.ts', import.meta.url).href);
    aiClient = await TownClient.connect({ url: `${BASE}/mcp`, key: AI_KEY, clientId: `e2e-ai-${rnd()}` });
    // 在端口上只做计数（不改行为）：脚本自己从不调用 renewNavigation，renews 里记下的全是运行器的调用
    const renews = [];
    const acts = [];
    if (AI_NO_RENEW) {
      // 反向验证：让端口没有 renewNavigation，运行器就不续租（见文件头）。这一步应当失败：AI 走到约一个租约（10 秒）处就停下
      aiClient.renewNavigation = undefined;
    } else {
      const origRenew = aiClient.renewNavigation.bind(aiClient);
      aiClient.renewNavigation = async (n, o) => {
        renews.push(Date.now());
        return origRenew(n, o);
      };
    }
    const origAct = aiClient.act.bind(aiClient);
    aiClient.act = async (action, o) => {
      acts.push({ type: action.type, at: Date.now() });
      return origAct(action, o);
    };
    // 决策函数不调用任何模型：第一次被问到时（等脚本放行）返回一条 navigate，之后一律什么都不做
    const decisions = [];
    let openGate;
    const gate = new Promise((r) => (openGate = r));
    let sent = false;
    const decide = async (ctx) => {
      decisions.push({ at: Date.now(), triggers: [...ctx.triggers] });
      if (sent) return null;
      sent = true;
      await gate;
      return { actions: [{ type: 'navigate', to: 'tea_house' }] };
    };
    const runnerLog = [];
    runner = new ResidentRunner({ log: (l) => runnerLog.push(l) });
    const handle = runner.add({ label: '灯灯', town: aiClient, profile: { name: '灯灯' }, decide });
    await until(async () => aiClient.state.residentId, 20_000, '运行器让 AI 进镇');
    aiId = aiClient.state.residentId;
    check(aiId, '拿不到 AI 居民编号');
    await until(async () => (await seen(A.page, aiId)) && (await seen(B.page, aiId)), 15_000, '两个页面都看见 AI 进镇');
    const start = await seen(B.page, aiId);
    note(`AI ${aiId} 由运行器带进镇，起点 (${start.x.toFixed(1)}, ${start.z.toFixed(1)})，两个页面都看见`);
    // AI 走路期间两个页面的位置也是按页面自己的服务器时间现算的：先核对时钟对准了服务器
    await assertClock(A, '步骤 8 A 页');
    await assertClock(B, '步骤 8 B 页');
    await until(async () => decisions.length >= 1, 10_000, '运行器第一次问决策函数（start）');
    openGate();
    const anchor = { x: 11, z: 10.25 }; // 地图里 tea_house 的落脚点；从广场出发，折线约 30.8 米，按 2.4 米每秒要走 12.8 秒，比 10 秒的导航租约长
    const first = await until(async () => (await serverScene(A)).actors.find((a) => a.id === aiId)?.nav, 15_000, '服务器里 AI 开始走');
    const submitAt = Date.now();
    const ptsLen = (() => {
      const pts = normPts(first.points);
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += dist(pts[i], pts[i - 1]);
      return L;
    })();
    const walkMs = (ptsLen / first.speed) * 1000;
    const leaseMs = first.until - first.startedAt;
    note(`第一条导航：折线 ${ptsLen.toFixed(1)} 米，速度 ${first.speed} 米每秒，走完要 ${(walkMs / 1000).toFixed(1)} 秒；第一次租约 ${(leaseMs / 1000).toFixed(1)} 秒`);
    check(ptsLen >= 30, `目的地要够远：折线应 >= 30 米，实际 ${ptsLen.toFixed(1)} 米`);
    check(walkMs > leaseMs + 1500, `走完的时间 ${walkMs.toFixed(0)} ms 应比第一次租约 ${leaseMs} ms 至少长 1.5 秒，否则证明不了续租`);
    let sawA = false;
    let sawB = false;
    let maxDiff = 0;
    let movingPastLease = 0;
    const untils = new Set([first.until]);
    const diag = [];
    const t0 = Date.now();
    // 脚本这里只观察，不续租
    for (;;) {
      if (Date.now() - t0 > 90_000) throw new Error('AI 90 秒内没走到');
      const [sa, sb, sc] = await Promise.all([snap(A.page), snap(B.page), serverScene(A)]);
      const pa = sa.actors.find((a) => a.id === aiId);
      const pb = sb.actors.find((a) => a.id === aiId);
      const ai = sc.actors.find((a) => a.id === aiId);
      if (!ai?.nav) break; // 服务器里没有在走的路了：到了（或者租约到期被停下）
      untils.add(ai.nav.until);
      if (pa?.moving) sawA = true;
      if (pb?.moving) sawB = true;
      // 服务器时间已经过了第一次租约的截止时刻，AI 还在走（服务器里有导航，页面里也在动）
      if (sc.serverTime > first.until + 500 && pa?.moving && pb?.moving) movingPastLease++;
      if (pa && pb) {
        const ea = dist(pa, polyAt(ai.nav, sa.serverNow));
        const eb = dist(pb, polyAt(ai.nav, sb.serverNow));
        if (Math.max(ea, eb) > 0.5) diag.push(`A ${ea.toFixed(2)} (fps ${sa.fps?.toFixed?.(1)}, rtt ${sa.rtt}) B ${eb.toFixed(2)} (fps ${sb.fps?.toFixed?.(1)}, rtt ${sb.rtt}) rev ${ai.nav.revision} 服务器此刻-A页时间 ${sc.serverTime - sa.serverNow} ms`);
        maxDiff = Math.max(maxDiff, ea, eb);
      }
      await sleep(400);
    }
    const endAt = Date.now();
    for (const d of diag) note(`偏差较大的采样：${d}`);
    check(sawA && sawB, `两个页面都应看见 AI 在走：A ${sawA}，B ${sawB}`);
    // 续租是运行器的普通程序做的，模型（决策函数）没有参与沿路控制
    check(movingPastLease >= 2, `过了第一次租约的截止时刻（${leaseMs} ms）AI 应还在走（采样到 ${movingPastLease} 次），没有续上`);
    check(untils.size >= 2, `导航租约截止时刻应被续过，只看到 ${untils.size} 个不同的值`);
    check(renews.length >= 2, `运行器应自动续租至少 2 次，实际 ${renews.length} 次`);
    const navActs = acts.filter((x) => x.type === 'navigate');
    check(navActs.length === 1, `整段路只应提交 1 条 navigate，实际 ${navActs.length} 条（${acts.map((x) => x.type)}）`);
    const walkingCalls = decisions.filter((d) => d.at > submitAt && d.at < endAt);
    check(walkingCalls.length === 0, `走路期间决策函数不应被再次调用，实际 ${walkingCalls.length} 次（触发：${walkingCalls.map((d) => d.triggers)}）`);
    note(`运行器自动续租 ${renews.length} 次（间隔 ${renews.slice(1).map((t, i) => ((t - renews[i]) / 1000).toFixed(1)).join('/')} 秒），租约截止时刻前进了 ${untils.size} 个值；走路期间（${((endAt - submitAt) / 1000).toFixed(1)} 秒）决策函数调用 0 次，navigate 只提交 1 条；过了第一次租约截止时刻后又采样到 ${movingPastLease} 次两个页面里都在走`);
    const sc = await serverScene(A);
    await until(async () => {
      const pa = await seen(A.page, aiId);
      const pb = await seen(B.page, aiId);
      return pa && pb && !pa.moving && !pb.moving;
    }, 10_000, '两个页面里 AI 都停下');
    await sleep(1200);
    const sa = sc.actors.find((a) => a.id === aiId);
    const pa = await seen(A.page, aiId);
    const pb = await seen(B.page, aiId);
    check(sa, '服务器场景里应有 AI');
    note(`AI 停在 (${sa.x.toFixed(2)}, ${sa.z.toFixed(2)})，离茶馆落脚点 ${dist(sa, anchor).toFixed(2)} 米；A 页偏差 ${dist(sa, pa).toFixed(2)}，B 页偏差 ${dist(sa, pb).toFixed(2)}；走路时两个页面与服务器折线现算位置最多相差 ${maxDiff.toFixed(2)} 米`);
    check(dist(sa, anchor) < 2.0, `AI 应走到茶馆落脚点旁边，实际离 ${dist(sa, anchor).toFixed(2)} 米`);
    check(dist(sa, pa) < 0.4 && dist(sa, pb) < 0.4, 'AI 停下后两个页面与服务器应一致');
    check(maxDiff < T_POS, `AI 走路时页面位置与服务器折线现算位置最多相差 ${maxDiff.toFixed(2)} 米，超过 ${T_POS}`);
    check(handle.stats.actions === 1, `运行器统计的成功动作数应为 1，实际 ${handle.stats.actions}`);
    note(`运行器统计：决策调用 ${handle.stats.decisions} 次、动作 ${handle.stats.actions} 个、什么都不做 ${handle.stats.noops} 次`);
    metrics.aiRunner = { pathMeters: Number(ptsLen.toFixed(1)), walkSeconds: Number((walkMs / 1000).toFixed(1)), leaseSeconds: leaseMs / 1000, renews: renews.length, navigateActs: navActs.length, decisionCallsWhileWalking: walkingCalls.length };
  });

  // ── 9 ──
  await step(9, 'A 进自己家：A 页面切到 home；B 页面里 A 消失；出门后 B 又看见 A 在会馆门前', async () => {
    check(await A.page.$eval('#homeBtn', (e) => !e.disabled), '「回家」按钮应可点');
    await A.page.click('#homeBtn');
    await until(async () => (await snap(A.page)).scene === 'home' && (await seen(A.page, A.id)), 120_000, 'A 页面切到 home 场景');
    await sleep(1200);
    const sa = await snap(A.page);
    note(`A 页面：scene=${sa.scene}，space=${sa.space}（${sa.spaceName}）`);
    await shot(A.page, '10-desktop-home');
    await until(async () => !(await seen(B.page, A.id)), 10_000, 'B 页面里 A 消失');
    const sb = await serverScene(B);
    check(!sb.actors.some((a) => a.id === A.id) && !JSON.stringify(sb).includes(A.id), 'B 的服务器场景里不应有 A（连编号都不该出现）');
    note('B 看不到 A（客户端与服务器场景快照都没有 A；不含私宅坐标）');
    // A 出门
    await A.page.click('#homeBtn'); // 家里变「出门」
    await until(async () => (await snap(A.page)).scene === 'town', 60_000, 'A 页面切回 town');
    const door = { x: 3.25, z: 26.25 }; // residential.door
    await until(async () => seen(B.page, A.id), 20_000, 'B 页面里 A 重新出现');
    await sleep(1000);
    const srv = selfActor(await serverScene(A));
    const fb2 = await seen(B.page, A.id);
    note(`出门后 B 看到 A 在 (${fb2.x.toFixed(2)}, ${fb2.z.toFixed(2)})，离会馆门口 ${dist(fb2, door).toFixed(2)} 米；服务器 (${srv.x.toFixed(2)}, ${srv.z.toFixed(2)})`);
    check(dist(fb2, door) < 6 && dist(fb2, srv) < 0.6, 'A 应出现在会馆门口一带，且与服务器一致');
  });

  // ── 10 ──
  await step(10, '断线：A 的 WebSocket 断开，界面显示重连中，恢复后位置与服务器一致', async () => {
    await until(async () => !selfActor(await serverScene(A))?.nav, 20_000, 'A 空闲');
    await clickWorld(A, 24, 28);
    // 点的远点会被缩到视野内，所以走一段后再点一次更远的，保证断线期间还在路上
    await until(async () => selfActor(await serverScene(A))?.nav, 8000, 'A 开始走');
    await sleep(1500);
    await clickWorld(A, 58, 28);
    await sleep(800);
    A.gate.block = true;
    for (const ws of A.gate.sockets) ws.close();
    A.gate.sockets.length = 0;
    const down = await until(async () => {
      const s = await snap(A.page);
      return s.conn !== 'ok' ? s.conn : null;
    }, 15_000, '界面显示断线');
    note(`断开后界面连接状态：${down}`);
    await sleep(1500);
    const banner = await A.page.$eval('#connText', (e) => (e.hidden ? '' : e.textContent));
    check(/重连|离线/.test(banner), `断线时界面应显示文字提示，实际「${banner}」`);
    note(`界面文字提示：「${banner}」`);
    await shot(A.page, '11-desktop-reconnecting');
    await sleep(2500); // 断着的这几秒，A 走路的续租走 POST /nav/renew
    A.gate.block = false;
    await until(async () => (await snap(A.page)).conn === 'ok', 40_000, '重连成功');
    await until(async () => !selfActor(await serverScene(A))?.nav, 60_000, 'A 走完');
    await sleep(1500);
    const srv = selfActor(await serverScene(A));
    const fa = await seen(A.page, A.id);
    check(dist(srv, fa) < 0.4, `重连后 A 页面与服务器相差 ${dist(srv, fa).toFixed(2)} 米`);
    note(`重连后 A 页面 (${fa.x.toFixed(2)}, ${fa.z.toFixed(2)})，服务器 (${srv.x.toFixed(2)}, ${srv.z.toFixed(2)})，相差 ${dist(srv, fa).toFixed(2)} 米`);
  });

  // ── 11 ──
  await step(11, '同一身份开第二个标签页：只读 + 接管按钮；接管后原来那个变只读', async () => {
    const page2 = await A.ctx.newPage();
    A2 = { ctx: A.ctx, page: page2, w: watch(page2, 'A2 第二标签页'), label: 'A2', touch: false };
    await page2.addInitScript(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page2.setViewportSize({ width: 1440, height: 900 });
    await page2.goto(`${BASE}/town/3d/?debug=1`);
    await page2.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    await page2.click('#enterBtn');
    // 已有会话：不再要名字，直接进入
    await page2.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    await until(async () => page2.$eval('#readonly', (e) => !e.hidden && getComputedStyle(e).display !== 'none').catch(() => false), 10_000, '第二个标签页显示只读横幅');
    check(await page2.$eval('#claimBtn', (e) => !e.hidden && getComputedStyle(e).display !== 'none'), '应有接管按钮');
    check((await snap(page2)).mine === false, '第二个标签页不应握着控制权');
    // 只读：点地不发 navigate
    const m0 = A2.w.actions.length;
    const s2 = await snap(page2);
    const me = s2.actors.find((a) => a.id === s2.self);
    const q = await project(page2, me.x + 4, me.z - 3);
    await page2.mouse.click(q.x, q.y);
    await sleep(900);
    check(A2.w.actions.slice(m0).filter((r) => r.type === 'navigate').length === 0, '只读标签页点地不应发 navigate');
    await shot(page2, '12-desktop-readonly-tab');
    await page2.click('#claimBtn');
    await until(async () => (await snap(page2)).mine === true, 10_000, '第二个标签页接管成功');
    await until(async () => A.page.$eval('#readonly', (e) => !e.hidden && getComputedStyle(e).display !== 'none').catch(() => false), 15_000, '原来的标签页变只读');
    check((await snap(A.page)).mine === false, '原标签页 mine 应为 false');
    note('接管后：新标签页可操作，原标签页只读');
    // 新标签页可以走路
    const n1 = A2.w.actions.length;
    await clickWorld({ page: page2, touch: false }, me.x + 4, me.z - 3);
    await until(() => A2.w.actions.slice(n1).find((r) => r.type === 'navigate' && r.status === 200), 8000, '接管后新标签页 navigate 成功');
    await sleep(500);
    await shot(A.page, '13-desktop-old-tab-readonly');
  });

  // ── 12 ──
  await step(12, '复制标签页（window.open 复制 sessionStorage）：新页面换一个 clientId，原页面不变', async () => {
    const cidOf = (pg) => pg.evaluate(() => (window.TownHud ? window.TownHud.clientId() : null));
    const c0 = await cidOf(A2.page);
    check(c0, '第二个标签页应有 clientId');
    const [pop] = await Promise.all([A.ctx.waitForEvent('page'), A2.page.evaluate(() => void window.open(location.href))]);
    A3 = { ctx: A.ctx, page: pop, w: watch(pop, 'A3 复制的标签页'), label: 'A3', touch: false };
    await pop.waitForFunction(() => window.TownHud && window.TownHud.ready, null, { timeout: 120_000 });
    await pop.evaluate(() => window.TownHud.ready); // 等 Web Locks 抢占完（占用时会换新 id 写回 sessionStorage）
    const c1 = await cidOf(pop);
    const stored = await pop.evaluate(() => sessionStorage.getItem('town3d.clientId'));
    const c0b = await cidOf(A2.page);
    note(`原页面 ${c0}，复制的页面 ${c1}（sessionStorage 里是 ${stored}）`);
    check(c1 && c1 !== c0, `复制的标签页应换新的 clientId，实际相同：${c1}`);
    check(stored === c1, '新 id 应写回复制页面自己的 sessionStorage');
    check(c0b === c0, '原页面的 clientId 不应变');
    A3.w.closing = true;
    await pop.close();
  });

  // ── 13 ──
  await step(13, '死连接检测：服务器消息静默约 12 秒，界面转为「重连中」，放行后恢复', async () => {
    check((await snap(A.page)).conn === 'ok', '开始前 A 页的连接应是 ok');
    A.gate.silent = true; // 连接还开着，但页面什么都收不到（半开连接）
    const t0 = Date.now();
    const down = await until(async () => {
      const sn = await snap(A.page);
      return sn.conn !== 'ok' ? sn.conn : null;
    }, 30_000, '静默之后界面转为断线');
    const dt = Date.now() - t0;
    note(`服务器静默 ${(dt / 1000).toFixed(1)} 秒后界面连接状态变为 ${down}（客户端的静默阈值 12 秒，最后一条消息可能在静默开始前 0~5 秒就收到了）`);
    check(dt >= 6000, `不应在静默不足 6 秒时就判死（实际 ${dt} ms）`);
    await sleep(800);
    const banner = await A.page.$eval('#connText', (e) => (e.hidden ? '' : e.textContent));
    check(/重连|离线/.test(banner), `静默判死后界面应显示文字提示，实际「${banner}」`);
    A.gate.silent = false;
    await until(async () => (await snap(A.page)).conn === 'ok', 40_000, '放行后重连成功');
    note(`放行后恢复为 ok；断线提示「${banner}」`);
  });

  // ── 14 ──
  await step(14, '主动离开小镇后：界面停在「已离开」面板，不自动重新进入', async () => {
    // 离开的瞬间如果恰有一次心跳在路上，它会得到 422 presence_lost，这是正常的（客户端随后必须仍然停在「已离开」，下面核对）；两个页面各 0~1 次
    for (const p of [A, A2]) allowFailure(p.w, 'POST', /\/town\/api\/heartbeat$/, { min: 0, max: 1, why: '步骤 14：离开瞬间在途的心跳可能 presence_lost' });
    const r = await A2.ctx.request.post(`${BASE}/town/api/leave`, { data: {} });
    check(r.ok(), `POST /leave 返回 ${r.status()}`);
    for (const [pg, tag] of [[A2.page, 'A2'], [A.page, 'A']]) {
      await until(() => pg.evaluate(() => document.body.dataset.phase === 'ready' && /离开了小镇/.test(document.getElementById('panel')?.textContent ?? '')), 20_000, `${tag} 页面出现「你已经离开了小镇」面板`);
    }
    await sleep(6000); // 比心跳、重连退避、离线轮询的周期都长；若有自动重进，这段时间里一定发生
    for (const [pg, tag] of [[A2.page, 'A2'], [A.page, 'A']]) {
      check(await pg.evaluate(() => document.body.dataset.phase === 'ready'), `${tag} 页面不应自动重新进入`);
    }
    const sess = await (await A2.ctx.request.get(`${BASE}/town/api/session`)).json();
    check(sess.resident && sess.resident.present === false, `服务器上居民应一直是不在场，实际 ${JSON.stringify(sess.resident)}`);
    await shot(A2.page, '14-desktop-left-town');
    note('两个页面都停在「你已经离开了小镇」面板，6 秒内没有自动重新进入，服务器上居民不在场');
  });

  // ── 15 ──
  await step(15, '声音：手势后 AudioContext 为 running；昼夜按服务器世界时间；三个音量与总静音生效并在刷新后保持；后台挂起/回前台不叠播；断线重连不重新起播；进屋切环境声；音乐文件取不到时照常运行', async () => {
    const snd = (p) => p.page.evaluate(() => (window.__town ? window.__town.snd : null));
    const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
    const dbOf = (v) => (v <= 0.0001 ? -80 : 20 * Math.log10(v));
    const setRange = (p, id, v) =>
      p.page.$eval(
        `#${id}`,
        (el, val) => {
          el.value = String(val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        },
        v,
      );
    // 复选框用页面内 click()：Playwright 的 page.click 对这个复选框偶发报「element is not visible」，而此时 elementFromPoint 命中它、
    // 各级祖先都可见（排查记录见 docs/PROGRESS.md）；真人点击不受影响，这里只验证设置本身的行为
    const clickEl = (p, sel) => p.page.$eval(sel, (el) => el.click());
    const audioStates = (p) => p.page.evaluate(() => window.TownHost.audioState());
    const goHidden = (p) =>
      p.page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    const goVisible = (p) =>
      p.page.evaluate(() => {
        delete document.visibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      });

    const C = await newPlayer(chromiumBrowserA, 'C 声音', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, { wsGate: true });
    extra.push(C);
    const lc = await login(C, `阿声${rnd()}`);
    check(lc.audioAfter.includes('running'), `手势之后至少应有一个 AudioContext 处于 running，实际 [${lc.audioAfter}]`);
    const ctxCount = lc.audioAfter.length;
    note(`手势前 AudioContext [${lc.audioBefore}]，手势后 [${lc.audioAfter}]`);

    // 默认值与初始化
    let s = await until(async () => {
      const x = await snd(C);
      return x && x.inited ? x : null;
    }, 20_000, '音频初始化');
    check(s.sfxLoaded.length === 10, `10 个音效应全部载入，实际 ${s.sfxLoaded.length}：${s.sfxLoaded}`);
    const prefs0 = await C.page.evaluate(() => window.__town.audioPrefs);
    check(prefs0.music === 60 && prefs0.amb === 70 && prefs0.sfx === 80 && prefs0.bg === true, `默认音量应是 60/70/80、后台静音开，实际 ${JSON.stringify(prefs0)}`);

    // 昼夜取自服务器世界时间：同一时刻在不同时区钟点不同（与设备时区无关）
    const tz = (await (await C.ctx.request.get(`${BASE}/town/api/config`)).json()).world.timezone;
    const hours = await C.page.evaluate(() => {
      const u = Date.UTC(2026, 10, 13, 12, 0, 0);
      const H = window.TownHost;
      return { tokyo: H.worldHour('Asia/Tokyo', u), ny: H.worldHour('America/New_York', u), edgeNight: H.worldHour('Asia/Tokyo', Date.UTC(2026, 10, 13, 9, 0, 0)), edgeDawn: H.worldHour('Asia/Tokyo', Date.UTC(2026, 10, 12, 21, 0, 0)), bad: H.worldHour('Not/AZone', u) };
    });
    check(hours.tokyo === 21 && hours.ny === 7 && hours.edgeNight === 18 && hours.edgeDawn === 6 && hours.bad === -1, `worldHour 按时区换算不对：${JSON.stringify(hours)}`);
    const hnow = await C.page.evaluate((z) => window.TownHost.worldHour(z, window.__town.serverNow), tz);
    s = await snd(C);
    const dh = Math.min(Math.abs(s.hour - hnow), 24 - Math.abs(s.hour - hnow));
    check(dh < 0.1, `音频用的世界钟点 ${s.hour} 与按服务器时间 ${tz} 现算的 ${hnow} 不一致`);
    check(s.night === (s.hour >= 18 || s.hour < 6), `night=${s.night} 与钟点 ${s.hour} 不符`);
    // 光照用的钟点（__town.hour）与音频同源：不带 ?hour= 时，等于「服务器时间按世界时区换算的钟点」，且昼夜判定与音频一致
    {
      const lh = (await C.page.evaluate(() => window.__town.hour));
      const dl = Math.min(Math.abs(lh - hnow), 24 - Math.abs(lh - hnow));
      check(lh >= 0 && dl < 0.1, `光照用的钟点 ${lh} 与按服务器时间 ${tz} 现算的 ${hnow} 不一致（差 ${dl.toFixed(3)} 小时）`);
      const edge = (h) => Math.min(Math.abs(h - 6), Math.abs(h - 18)) < 0.12;
      check(edge(lh) || (lh >= 18 || lh < 6) === s.night, `光照钟点 ${lh} 的昼夜与音频 night=${s.night} 不一致`);
      note(`光照钟点 ${lh.toFixed(2)}，音频钟点 ${s.hour.toFixed(2)}，现算 ${hnow.toFixed(2)}（${tz}）`);
    }
    note(`世界时区 ${tz}，当前钟点 ${s.hour.toFixed(2)}，放${s.night ? '夜晚' : '白天'}曲；同一时刻东京 ${hours.tokyo} 点、纽约 ${hours.ny} 点（与设备时区无关）`);

    // 音乐从 /town/3d/music/ 流式取到并淡入；环境声和音效在包里
    const want = s.night ? 'night' : 'day';
    const other = want === 'day' ? 'night' : 'day';
    s = await until(async () => {
      const x = await snd(C);
      const l = x.layers[`music_${want}`];
      return l.loaded && l.playing && l.gain > 0.99 ? x : null;
    }, 90_000, '当前时段的音乐载入并淡入完成');
    check(!s.layers[`music_${other}`].playing, '另一时段的音乐不应同时在放（不叠播）');
    check(s.layers[`amb_${want}`].playing && s.layers[`amb_${want}`].gain > 0.99, `室外应放${want}环境声`);
    check(!s.layers.amb_indoor.playing, '室外不应放室内环境声');
    await until(async () => (await snd(C)).layers[`music_${other}`].loaded, 60_000, '另一首音乐也取到了');
    note(`音乐 ${want} 在播（增益 ${s.layers[`music_${want}`].gain}），环境声 ${want} 在播；总线(dB) ${JSON.stringify(s.busDb)}`);

    // 昼夜切换：把世界钟点改到另一个时段（?debug=1&hour=，页面运行中改地址栏参数即可），两首音乐交叉淡入淡出，中途两首同时在放，结束后只剩一首；再改回来
    {
      const farHour = want === 'night' ? 12 : 21;
      await C.page.evaluate((h) => history.replaceState(null, '', `${location.pathname}?debug=1&hour=${h}`), farHour);
      let overlap = false;
      s = await until(async () => {
        const x = await snd(C);
        const a = x.layers[`music_${want}`];
        const b = x.layers[`music_${other}`];
        if (a.playing && b.playing && a.gain > 0.05 && b.gain > 0.05) overlap = true;
        return b.gain > 0.99 && a.gain < 0.01 && !a.playing && x.night === (want === 'day') ? x : null;
      }, 90_000, '改钟点后音乐交叉淡入到另一首', 100);
      check(overlap, '交叉淡化的过程中应有两首同时在放（渐变，不是硬切）');
      check(s.layers[`amb_${other}`].gain > 0.99 && s.layers[`amb_${want}`].gain < 0.01, '环境声也应跟着切到另一时段');
      note(`世界钟点改到 ${farHour} 点：音乐 ${want} -> ${other} 交叉淡化（中途两首同时在放），环境声同步切换`);
      await C.page.evaluate(() => history.replaceState(null, '', `${location.pathname}?debug=1`));
      await until(async () => {
        const x = await snd(C);
        return x.layers[`music_${want}`].gain > 0.99 && x.layers[`music_${other}`].gain < 0.01 && x.night === (want === 'night') ? x : null;
      }, 90_000, '钟点改回后切回原来的曲子', 100);
    }

    // 点地：点地确认音计数 +1
    const before = (await snd(C)).plays.tap ?? 0;
    await clickWorld(C, 20, 24);
    await until(async () => ((await snd(C)).plays.tap ?? 0) > before, 15_000, '点地后响了点地确认音');
    await until(async () => !selfActor(await serverScene(C))?.nav, 60_000, 'C 走完').catch(() => {});

    // 喷泉定点声按距离衰减：离喷泉近的地方听得到，远处听不到
    await until(async () => (await snd(C)).fountainDist >= 0, 10_000, '拿到离喷泉的距离').catch(async (e) => {
      const x = await snd(C);
      throw new Error(`${e.message} ${JSON.stringify({ scene: x.scene, fountains: x.fountains, indoor: x.indoor, d: x.fountainDist })}`);
    });
    s = await until(async () => {
      const x = await snd(C);
      return x.layers.amb_fountain.playing === (x.layers.amb_fountain.gain > 0.002) ? x : null;
    }, 20_000, '喷泉声增益稳定');
    const fNear = { d: s.fountainDist, g: s.layers.amb_fountain.gain };
    // 镜头跟着人走，一次点不到 26 米外：分两跳
    for (const [hx, hz] of [[40, 27], [47, 27], [54, 28], [58, 28]]) {
      await clickWorld(C, hx, hz);
      await sleep(1500);
      await until(async () => !selfActor(await serverScene(C))?.nav, 90_000, 'C 走到远处');
    }
    s = await until(async () => {
      const x = await snd(C);
      return x.fountainDist > 22 && x.layers.amb_fountain.gain < 0.01 ? x : null;
    }, 30_000, '走远后听不到喷泉').catch(async (e) => {
      const x = await snd(C);
      throw new Error(`${e.message} ${JSON.stringify({ d: x.fountainDist, g: x.layers.amb_fountain.gain, indoor: x.indoor, scene: x.scene })}`);
    });
    check(fNear.d < 22 ? fNear.g > 0.05 : true, `离喷泉 ${fNear.d} 米时应听得到，增益 ${fNear.g}`);
    note(`喷泉声：离喷泉 ${fNear.d} 米增益 ${fNear.g}，走到 ${s.fountainDist} 米外增益 ${s.layers.amb_fountain.gain}（按距离衰减）`);

    // 设置面板：三个独立音量 + 后台静音，真正作用到三条总线
    await C.page.click('#soundSetBtn');
    check(await C.page.$eval('#soundPanel', (e) => !e.hidden), '点「音量」应展开设置面板');
    await shot(C.page, '16-desktop-sound-panel');
    await setRange(C, 'volMusic', 30);
    await setRange(C, 'volAmb', 40);
    await setRange(C, 'volSfx', 50);
    await clickEl(C, '#bgMute'); // 取消勾选
    s = await until(async () => {
      const x = await snd(C);
      return near(x.busDb.music, dbOf(0.3), 0.6) && near(x.busDb.amb, dbOf(0.4), 0.6) && near(x.busDb.sfx, dbOf(0.5), 0.6) && x.bgMute === false ? x : null;
    }, 15_000, '三个音量和后台静音设置作用到总线');
    note(`音乐 30% -> ${s.busDb.music.toFixed(1)} dB，环境声 40% -> ${s.busDb.amb.toFixed(1)} dB，音效 50% -> ${s.busDb.sfx.toFixed(1)} dB`);
    await setRange(C, 'volMusic', 0);
    s = await until(async () => {
      const x = await snd(C);
      return x.busDb.music <= -60 ? x : null;
    }, 10_000, '音乐音量拖到 0 后总线静音');
    check(near(s.busDb.amb, dbOf(0.4), 0.6) && near(s.busDb.sfx, dbOf(0.5), 0.6), `只动音乐音量时环境声、音效不应变：${JSON.stringify(s.busDb)}`);
    await setRange(C, 'volMusic', 30);
    await C.page.click('#soundBtn'); // 总静音
    check((await C.page.$eval('#soundBtn', (e) => e.textContent)) === '声音：关', '总静音后按钮应显示「声音：关」');
    await until(async () => {
      const x = await snd(C);
      return x.enabled === false && x.busDb.master <= -60 ? x : null;
    }, 10_000, '总静音后主总线静音');

    // 刷新后保持：音量在 localStorage，总静音也是
    C.w.closing = true;
    await C.page.reload();
    await C.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    C.w.closing = false;
    const afterReload = await C.page.evaluate(() => ({
      m: document.getElementById('volMusic').value,
      a: document.getElementById('volAmb').value,
      s: document.getElementById('volSfx').value,
      bg: document.getElementById('bgMute').checked,
      snd: document.getElementById('soundBtn').textContent,
    }));
    check(afterReload.m === '30' && afterReload.a === '40' && afterReload.s === '50' && afterReload.bg === false && afterReload.snd === '声音：关', `刷新后设置应保持，实际 ${JSON.stringify(afterReload)}`);
    await C.page.click('#enterBtn');
    await C.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    const sEnter = await until(async () => {
      const x = await snd(C);
      return x && x.inited && near(x.vol.music, 0.3, 0.001) && near(x.vol.amb, 0.4, 0.001) && near(x.vol.sfx, 0.5, 0.001) && x.enabled === false && x.bgMute === false && near(x.busDb.music, dbOf(0.3), 0.6) && x.busDb.master <= -60 ? x : null;
    }, 30_000, '刷新后进入：音量、总静音、后台静音设置都已作用');
    note('刷新后：音量 30/40/50、总静音、后台静音（关）都保持，并在进入后作用到总线');
    // 进入时的第一声（确认音）播放的那一刻，已保存的总静音就已经作用在总线上（不是等下一帧才衰减下去）
    check(sEnter.firstPlay && sEnter.firstPlay.name === 'confirm' && sEnter.firstPlay.masterDb <= -60, `静音状态下进入：第一声确认音播放时主总线应已是静音，实际 ${JSON.stringify(sEnter.firstPlay)}`);
    await C.page.click('#soundBtn');
    await until(async () => {
      const x = await snd(C);
      return x.enabled && near(x.busDb.master, 0, 0.5) ? x : null;
    }, 10_000, '取消总静音后主总线恢复');
    await until(async () => {
      const l = (await snd(C)).layers[`music_${want}`];
      return l.loaded && l.playing && l.gain > 0.99;
    }, 90_000, '刷新后音乐重新淡入');

    // 切后台：「切到后台时静音」关着时不挂起；勾上后 AudioContext 挂起，回来恢复，不新建上下文、不叠播
    await goHidden(C);
    await sleep(800);
    check(!(await audioStates(C)).includes('suspended'), '「切到后台时静音」关着时不应挂起 AudioContext');
    await goVisible(C);
    await clickEl(C, '#bgMute'); // 勾上
    await goHidden(C);
    await until(async () => (await audioStates(C)).every((x) => x === 'suspended'), 8000, '切到后台后 AudioContext 全部挂起');
    await until(async () => {
      const x = await snd(C);
      return x.hidden && x.busDb.master <= -60 ? x : null;
    }, 8000, '切到后台后主总线静音');
    await goVisible(C);
    await until(async () => (await audioStates(C)).includes('running'), 10_000, '回到前台后 AudioContext 恢复 running');
    s = await until(async () => {
      const x = await snd(C);
      return !x.hidden && near(x.busDb.master, 0, 0.5) ? x : null;
    }, 8000, '回到前台后主总线恢复');
    const playingNow = Object.entries(s.layers).filter(([k, v]) => k.startsWith('music_') && v.playing && v.gain > 0.5).map(([k]) => k);
    check(playingNow.length === 1 && playingNow[0] === `music_${want}`, `回前台后应只有一首音乐在放，实际 ${playingNow}`);
    check((await audioStates(C)).length === ctxCount, 'AudioContext 数量不应增加');
    note('关着「切到后台时静音」时切后台不挂起；勾上后切后台全部 suspended、主总线静音，回前台恢复 running、仍只有一首音乐，AudioContext 数量不变');

    // 断线重连：音乐不重新起播（播放位置继续往前，不重新取文件），上下文数量不变
    const pos0 = (await snd(C)).layers[`music_${want}`].pos;
    const tried0 = (await snd(C)).musicTried;
    C.gate.block = true;
    for (const ws of C.gate.sockets) ws.close();
    C.gate.sockets.length = 0;
    await until(async () => (await snap(C.page)).conn !== 'ok', 15_000, 'C 页面显示断线');
    await sleep(3000);
    C.gate.block = false;
    await until(async () => (await snap(C.page)).conn === 'ok', 40_000, 'C 重连成功');
    await sleep(2000);
    s = await snd(C);
    const pos1 = s.layers[`music_${want}`].pos;
    check(s.layers[`music_${want}`].playing && (pos1 >= pos0 - 0.5 || pos0 > 60), `重连后音乐应接着播，位置 ${pos0} -> ${pos1}`);
    check(s.musicTried === tried0, `重连不应重新取音乐文件（musicTried ${tried0} -> ${s.musicTried}）`);
    check((await audioStates(C)).length === ctxCount, '重连后 AudioContext 数量不应增加');
    note(`断线重连：音乐位置 ${pos0}s -> ${pos1}s（没有从头），未重新取文件，上下文数量不变`);

    // 进屋：环境声切到室内，室外环境声只留一点；出门切回
    await C.page.click('#homeBtn');
    await until(async () => (await snap(C.page)).scene === 'home', 120_000, 'C 进到自己家');
    s = await until(async () => {
      const x = await snd(C);
      return x.indoor && x.layers.amb_indoor.playing && x.layers.amb_indoor.gain > 0.99 && x.layers[`amb_${want}`].gain < 0.2 ? x : null;
    }, 30_000, '进屋后室内环境声起来、室外环境声降下去').catch(async (e) => {
      throw new Error(`${e.message}；当时 ${JSON.stringify({ ...(await snd(C)), sfxLoaded: undefined })}`);
    });
    check((s.plays.door ?? 0) >= 1, '进门应响一声门');
    check(s.layers.amb_fountain.gain < 0.01, '在屋里听不到喷泉');
    await C.page.click('#homeBtn');
    await until(async () => (await snap(C.page)).scene === 'town', 60_000, 'C 出门');
    s = await until(async () => {
      const x = await snd(C);
      return !x.indoor && x.layers[`amb_${want}`].gain > 0.99 && x.layers.amb_indoor.gain < 0.01 ? x : null;
    }, 30_000, '出门后环境声切回室外');
    note(`进屋：室内环境声增益 1、室外降到 ≤0.2，门声 ${s.plays.door} 次；出门后切回`);

    // 窄屏：顶栏多了「音量」按钮，手机上不能溢出、面板在屏幕内
    await B.page.click('#soundSetBtn');
    const geo = await B.page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect().toJSON();
      const top = ['where', 'soundBtn', 'soundSetBtn', 'oldLink'].map((id) => ({ id, ...r(id) }));
      return { vw: window.innerWidth, sw: document.documentElement.scrollWidth, top, panel: r('soundPanel') };
    });
    await shot(B.page, '17-mobile-sound-panel');
    await B.page.click('#soundSetBtn');
    check(geo.sw <= geo.vw, `手机上页面不应横向溢出：scrollWidth ${geo.sw} > ${geo.vw}`);
    check(geo.top.every((t) => t.left >= -0.5 && t.right <= geo.vw + 0.5), `手机顶栏按钮应都在屏幕内：${JSON.stringify(geo.top.map((t) => [t.id, Math.round(t.left), Math.round(t.right)]))}`);
    check(geo.panel.left >= 0 && geo.panel.right <= geo.vw, `手机上设置面板应在屏幕内：${Math.round(geo.panel.left)}..${Math.round(geo.panel.right)} / ${geo.vw}`);
    C.w.closing = true;
    await C.ctx.close();

    // 缺资源：音乐文件取不到（404）时客户端照常运行，其余声音正常
    const D = await newPlayer(chromiumBrowserB, 'D 缺音乐', { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 });
    extra.push(D);
    await D.page.route(/\/town\/3d\/music\//, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' }));
    allowFailure(D.w, 'GET', /^\/town\/3d\/music\/(day|night)\.ogg$/, { min: 2, max: 6, why: '步骤 15：音乐文件被故意 404（缺资源）' });
    await login(D, `阿缺${rnd()}`);
    s = await until(async () => {
      const x = await snd(D);
      return x && x.inited && x.musicTried >= 1 ? x : null;
    }, 30_000, 'D 尝试过取音乐');
    check(!s.layers.music_day.loaded && !s.layers.music_night.loaded, '音乐取不到时不应有任何音乐载入');
    const dw = s.night ? 'night' : 'day';
    await until(async () => (await snd(D)).layers[`amb_${dw}`].playing, 30_000, '缺音乐时环境声照常播放');
    check((await D.page.evaluate(() => document.body.dataset.phase)) === 'playing', '缺音乐时客户端应照常运行');
    note('音乐被 404：客户端照常进入并运行，环境声和音效正常，没有页面错误');
    D.w.closing = true;
    await D.ctx.close();
  });
}

// ───────────────────────── 收尾 ─────────────────────────

function allWatches() {
  return [A, B, A2, A3, ...extra].filter(Boolean).map((p) => p.w);
}

async function collectCsp() {
  for (const p of [A, B, A2, A3, ...extra].filter(Boolean)) {
    try {
      const v = await p.page.evaluate(() => window.__csp ?? []);
      if (v.length) p.w.problems.push(`CSP 违规事件：${v.join('; ')}`);
      p.w.csp += v.length;
    } catch {
      /* 页面已关 */
    }
  }
}

let exitCode = 0;
try {
  await main();
  await collectCsp();
  // 页面级问题汇总成一个「步骤」
  await sleep(500); // 让最后的控制台消息到齐
  const probs = allWatches().flatMap((w) => w.problems.map((m) => `[${w.label}] ${m}`));
  // 控制台里「Failed to load resource … 4xx」的行数必须等于被声明过的预期失败次数：多出来的是没声明的资源/接口失败，少了说明声明没有对上实际请求
  for (const w of allWatches()) {
    if (w.consoleFail !== w.allowedHits) probs.push(`[${w.label}] 控制台里 4xx 的「Failed to load resource」${w.consoleFail} 行，与声明过的预期失败 ${w.allowedHits} 次不符`);
  }
  const expected = allWatches().reduce((n, w) => n + w.allowedHits, 0);
  console.log('\n全程检查');
  if (probs.length === 0) console.log(`  ✓ 控制台错误 / pageerror / CSP 违规 / 失败请求 / 未声明的 4xx、5xx：0 条（另有 ${expected} 次是步骤里声明过的服务器规则拒绝，控制台行数与之相等）`);
  else {
    console.log(`  ✗ 发现 ${probs.length} 条问题：`);
    for (const m of probs) console.log(`      - ${m}`);
  }
  results.push({ n: 99, title: '全程没有控制台错误、页面错误、CSP 违规、失败请求', ok: probs.length === 0, ms: 0, notes: probs.length ? probs : [`0 条；步骤里声明过的服务器规则拒绝 ${expected} 次，控制台 4xx 行数与之相等（逐页：${allWatches().map((w) => `${w.label} ${w.consoleFail}/${w.allowedHits}`).join('，')}）`], error: probs.length ? `${probs.length} 条问题` : undefined });
} catch (e) {
  console.error('\n脚本出错：', e);
  results.push({ n: 0, title: '脚本自身', ok: false, ms: 0, error: String(e?.stack ?? e), notes: [] });
} finally {
  // 被信号打断：清理由信号处理函数负责（它会 process.exit），这里不能抢先退出，否则临时目录删不掉
  if (interrupted) await new Promise(() => {});
  for (const p of [A, B, A2, A3, ...extra].filter(Boolean)) p.w.closing = true;
  try {
    await runner?.stop();
    await aiClient?.close();
  } catch {
    /* 忽略 */
  }
  for (const b of browsers) await b.close().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log('\n汇总');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.n === 99 ? '全程' : `步骤 ${r.n}`}  ${r.title}${r.ok ? '' : `\n      ${r.error}`}`);
  if (failed.length) {
    console.log(`\n失败 ${failed.length} 项。引擎最近日志：`);
    for (const l of engineTail.slice(-12)) console.log(`  | ${l}`);
    exitCode = 1;
  } else if (!results.length) {
    exitCode = 1;
  } else console.log(`\n全部 ${results.length} 项通过。`);
  const report = { date: new Date().toISOString().slice(0, 10), versions: metrics.versions, bundle: metrics.bundle, load: metrics.load, audio: metrics.audio, aiRunner: metrics.aiRunner, steps: results, shots };
  try {
    // 只有完整的一遍（没有 --only、没有 --no-shots）才算验收记录：否则 results.json 会和已提交的截图对不上
    if (!ONLY.length && !NO_SHOTS && !interrupted) {
      mkdirSync(DEMO_DIR, { recursive: true });
      if (exitCode === 0) {
        // 全部通过：截图和 results.json 一起换成这一遍的（截图是先写在临时目录里的）
        for (const sh of shots) copyFileSync(join(SHOT_TMP, `${sh.name}.jpg`), join(DEMO_DIR, `${sh.name}.jpg`));
        writeFileSync(join(DEMO_DIR, 'results.json'), JSON.stringify(report, null, 2));
        rmSync(join(DEMO_DIR, 'results.failed.json'), { force: true });
      } else {
        // 失败的运行不动已提交的 results.json 和截图
        writeFileSync(join(DEMO_DIR, 'results.failed.json'), JSON.stringify(report, null, 2));
        console.log(`失败的结果写在 ${join(DEMO_DIR, 'results.failed.json')}；已提交的 results.json 和截图没有动。`);
      }
    }
  } catch (e) {
    console.error('写结果失败：', e);
    exitCode = 1;
  }
  // 引擎真正退出之后才删临时目录
  await stopEngine();
  if (KEEP && exitCode) console.log(`临时目录保留在 ${TMP}`);
  else rmSync(TMP, { recursive: true, force: true });
  process.exit(exitCode);
}
