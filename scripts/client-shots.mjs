#!/usr/bin/env node
/**
 * 栖灯镇三维客户端的「固定镜头对照」：同一个出生位置、同一个窗口尺寸，把渲染设置 × 镜头的每个组合截一张原始 PNG，
 * 旁边记一行数据，汇总进 results.json。用来在真机显卡上比较清晰度和帧率，再决定要不要动地面烘焙分辨率之类的东西。
 *
 *   npm run client:export                 # 先导出（见 client/README.md）
 *   npm run client:shots                  # 起引擎 + 真实 Chrome（有头、有显卡）截 3 种渲染设置 × 4 种镜头 = 12 张
 *   npm run client:shots -- --headless    # 没有显卡的环境冒烟（SwiftShader 软件渲染，results.json 里标明，数据没有性能参考意义）
 *   npm run client:shots -- --url=http://127.0.0.1:7700   # 对着一个已经在跑的服务截图，跳过起引擎（见下面的限制）
 *
 * 选项：
 *   --out=<目录>        输出目录，默认 client/docs/T01/shots/
 *   --width= --height= --dpr=   窗口尺寸与设备像素比，默认 1440 900 1
 *   --settings=scale1,auto,low  只截部分渲染设置；--cameras=default,near,night,indoor 只截部分镜头
 *   --headless          无头（bundled Chromium，软件渲染）
 *   --url=<地址>        已在运行的服务；需要它开着开发登录（devLogin），否则登录那一步过不去，脚本会在 results.json 里记下失败原因，不会假装成功
 *   --keep-engine-log   结束后不删临时目录
 *
 * 矩阵：
 *   渲染设置：scale1（?debug=1&scale=1.0，固定满分辨率）、auto（默认档，动态分辨率）、low（localStorage town3d.quality=low，固定 0.6）
 *   镜头：default（默认视角）、near（?zoom=6.5，最近的缩放）、night（?hour=21）、indoor（走进栖灯茶馆）
 * 每个组合开一个全新的浏览器上下文、用同名规则登录（出生位置相同），进镇后先等 SETTLE_MS 让画面和动态分辨率稳下来，再量 SAMPLE_MS 的帧率，然后截图。
 * 截图时把界面（DOM）藏起来，只留 3D 画布；PNG 不压缩。
 *
 * 引擎的启动、临时配置、开发登录进镇：参照 scripts/client-e2e.mjs（startEngine / login），这里另写一份，没有改动它。
 * Windows 上的进程处理：用 node 直接跑 tsx 的 cli.mjs（不经 .bin 里的 shell 包装），结束时 taskkill /T /F 杀整个进程树；其他系统自成进程组、杀组。
 * Playwright 不在仓库依赖里：和 client-e2e.mjs 一样，用 NODE_PATH 找（npm i -g playwright 或装进 NODE_PATH 指向的目录）。
 *
 * 退出码：全部截成功 0；有组合失败 1；前置条件不满足 2。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLIENT_DIR = join(ROOT, 'client', 'town', 'build', 'web');
const ARGS = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = ARGS.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const HEADLESS = ARGS.includes('--headless');
const KEEP = ARGS.includes('--keep-engine-log');
const URL_GIVEN = opt('url', '');
const OUT = resolve(opt('out', join(ROOT, 'client', 'docs', 'T01', 'shots')));
const WIDTH = Number(opt('width', 1440));
const HEIGHT = Number(opt('height', 900));
const DPR = Number(opt('dpr', 1));
const SETTLE_MS = 8000; // 进镇后等画面（着色器编译、地面烘焙、动态分辨率）稳下来
const SAMPLE_MS = 5000; // 量帧率的时长
const NEAR_ZOOM = 6.5; // rig.gd 的 DIST_MIN：最近的缩放

const SETTINGS = {
  scale1: { query: '&scale=1.0', quality: 'auto', label: '固定满分辨率（scale=1.0）' },
  auto: { query: '', quality: 'auto', label: '自动（动态分辨率）' },
  low: { query: '', quality: 'low', label: '低（固定 0.6）' },
};
const CAMERAS = {
  default: { query: '', label: '默认视角' },
  near: { query: `&zoom=${NEAR_ZOOM}`, label: '最近的缩放' },
  night: { query: '&hour=21', label: '夜里 21 点' },
  indoor: { query: '', label: '室内（茶馆）', indoor: true },
};
const pick = (name, all) => {
  const want = opt(name, '').split(',').filter(Boolean);
  const keys = want.length ? want : Object.keys(all);
  for (const k of keys) if (!all[k]) throw new Error(`--${name}=${k} 不认识，可选：${Object.keys(all).join(',')}`);
  return keys;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(3).toString('hex');

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch {
    console.error('找不到 playwright：npm i -g playwright（再 npx playwright install chromium），并把全局 node_modules 放进 NODE_PATH；用真实 Chrome（channel: chrome）时本机要装有 Chrome。');
    process.exit(2);
  }
}

// ───────────────────────── 引擎子进程（参照 client-e2e.mjs） ─────────────────────────

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const TMP = mkdtempSync(join(tmpdir(), 'town-client-shots-'));
let engine = null;
const engineTail = [];
let BASE = URL_GIVEN.replace(/\/+$/, '');

async function startEngine() {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const cfg = {
    host: '127.0.0.1',
    port,
    stateFile: null,
    seed: 'client-shots',
    auth: { mode: 'keys', adminKeys: [], agents: [] },
    town: { enabled: true, dbFile: join(TMP, 'town.db'), devLogin: true, clientDir: CLIENT_DIR, params: {} },
  };
  const cfgFile = join(TMP, 'engine.json');
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) throw new Error(`没有找到 ${tsxCli}：先 npm ci`);
  engine = spawn(process.execPath, [tsxCli, join(ROOT, 'packages', 'engine', 'src', 'cli.ts'), 'serve'], {
    cwd: ROOT,
    detached: process.platform !== 'win32', // 非 Windows：自成进程组，结束时整组杀掉（tsx 会再起一层 node）
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BOTGAME_CONFIG: cfgFile },
  });
  const onData = (b) => {
    for (const l of b.toString('utf8').split('\n')) if (l.trim()) engineTail.push(l);
    if (engineTail.length > 120) engineTail.splice(0, engineTail.length - 120);
  };
  engine.stdout.on('data', onData);
  engine.stderr.on('data', onData);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (engine.exitCode !== null) throw new Error(`引擎提前退出：\n${engineTail.slice(-15).join('\n')}`);
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`引擎 60 秒内没有就绪：\n${engineTail.slice(-15).join('\n')}`);
    await sleep(150);
  }
}

function killEngineSync() {
  if (!engine?.pid || engine.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(engine.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-engine.pid, 'SIGKILL');
  } catch {
    /* 已经退出 */
  }
}
async function stopEngine() {
  if (!engine?.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-engine.pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
    const t0 = Date.now();
    while (engine.exitCode === null && Date.now() - t0 < 8000) await sleep(100);
  }
  killEngineSync();
  await sleep(500); // 等 SQLite 关库，再删临时目录
}
process.on('exit', killEngineSync);

// ───────────────────────── 单个组合 ─────────────────────────

const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
})();

/** 登录进镇（参照 client-e2e.mjs 的 login）；成功返回 undefined，失败抛错 */
async function loginPlay(page, name, query) {
  await page.goto(`${BASE}/town/3d/?debug=1${query}`);
  await page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
  await page.click('#enterBtn');
  await page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('点「进入」之后没有出现名字输入框：这个服务多半没有开发登录（devLogin），脚本做不到登录');
  });
  await page.fill('#nameInput', name);
  await page.click('#loginBtn');
  await page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
}

/** 走进茶馆：navigate 到 tea_house（服务器的地点编号），等走完。参照 e2e/lib/chat.mjs 的 apiAct。 */
async function walkIntoTeahouse(page, ctx) {
  const clientId = await page.evaluate(() => window.TownHud.clientId());
  const me = await (await ctx.request.get(`${BASE}/town/api/me?clientId=${encodeURIComponent(clientId)}`)).json();
  const send = async (to) => {
    const r = await ctx.request.post(`${BASE}/town/api/actions`, {
      data: {
        clientId,
        requestId: `shots-${rnd()}-${Date.now()}`,
        actionWindow: me.actionWindow,
        expected: { contextVersion: me.context?.version, controlEpoch: me.control?.epoch, activityId: me.context?.activityId ?? null },
        action: { type: 'navigate', to },
      },
    });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  let r = await send('tea_house');
  if (r.status !== 200) r = await send({ x: 11, z: 10.25 }); // 地图里 tea_house 的落脚点
  if (r.status !== 200) throw new Error(`navigate 到茶馆失败：${r.status} ${JSON.stringify(r.body)}`);
  // 走完：自己不再 moving，且离落脚点近（路比导航租约长，客户端会自动续租；30 米约 13 秒）
  await page.waitForFunction(
    () => {
      const t = window.__town;
      const me = t.actors.find((a) => a.id === t.self);
      return me && !me.moving && Math.hypot(me.x - 11, me.z - 10.25) < 2.5;
    },
    null,
    { timeout: 90_000, polling: 500 },
  );
}

async function measure(page) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        const gaps = [];
        let last = performance.now();
        const t0 = last;
        const godot = [];
        const tick = (now) => {
          gaps.push(now - last);
          last = now;
          const f = window.__town && window.__town.fps;
          if (typeof f === 'number') godot.push(f);
          if (now - t0 < ms) requestAnimationFrame(tick);
          else {
            const total = now - t0;
            resolve({
              fpsAvg: +((gaps.length / total) * 1000).toFixed(1),
              fpsMin: +(1000 / Math.max(...gaps)).toFixed(1),
              worstFrameMs: +Math.max(...gaps).toFixed(1),
              godotFpsAvg: godot.length ? +(godot.reduce((a, b) => a + b, 0) / godot.length).toFixed(1) : null,
              godotFpsMin: godot.length ? Math.min(...godot) : null,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
    SAMPLE_MS,
  );
}

async function gpuString(page) {
  return page.evaluate(() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)} | ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}` : 'unknown';
    } catch {
      return 'unknown';
    }
  });
}

async function shootOne(browser, browserVersion, sKey, cKey) {
  const S = SETTINGS[sKey];
  const C = CAMERAS[cKey];
  const tag = `${sKey}-${cKey}`;
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  const row = { name: tag, setting: sKey, settingLabel: S.label, camera: cKey, cameraLabel: C.label, file: `${tag}.png`, ok: false };
  try {
    await page.addInitScript((q) => {
      try {
        localStorage.setItem('town3d.quality', q);
      } catch {
        /* 取不到就用默认 */
      }
    }, S.quality);
    await loginPlay(page, `拍照${rnd()}`, S.query + C.query);
    if (C.indoor) {
      await walkIntoTeahouse(page, ctx);
      await sleep(2500); // 屋顶淡出
    }
    await sleep(SETTLE_MS);
    const stat = await measure(page);
    const info = await page.evaluate(() => {
      const t = window.__town;
      const me = t.actors.find((a) => a.id === t.self);
      return {
        renderScale: t.renderScale, renderSize: t.renderSize, canvasSize: t.canvasSize, qualityMode: t.qualityMode, shadows: t.quality,
        drs: t.drs, drsFloor: t.drsFloor, drsCeil: t.drsCeil, scaleCapped: t.scaleCapped, zoom: t.zoom, hour: t.hour,
        scene: t.scene, self: me ? { x: +me.x.toFixed(2), z: +me.z.toFixed(2) } : null,
        devicePixelRatio: window.devicePixelRatio, innerSize: [window.innerWidth, window.innerHeight],
      };
    });
    const gpu = await gpuString(page);
    // 截图：藏起界面，只留 3D 画布
    await page.addStyleTag({ content: '#hud, #dock, #dockBtn, #panel, .toast { visibility: hidden !important; }' });
    await sleep(300);
    await page.screenshot({ path: join(OUT, row.file), type: 'png' });
    Object.assign(row, info, stat, {
      ok: true, gpu, browser: browserVersion, headless: HEADLESS, softwareRendering: HEADLESS || /swiftshader|llvmpipe|software/i.test(gpu),
      commit, window: [WIDTH, HEIGHT], settleMs: SETTLE_MS, sampleMs: SAMPLE_MS,
    });
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  } finally {
    await ctx.close().catch(() => {});
  }
  writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(row, null, 2));
  console.log(`${row.ok ? '✓' : '✗'} ${tag}${row.ok ? `  比例 ${row.renderScale}  内部 ${row.renderSize?.join('x')}  画布 ${row.canvasSize?.join('x')}  ${row.fpsAvg} 帧（最低 ${row.fpsMin}）` : `  ${row.error}`}`);
  return row;
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  if (!URL_GIVEN && (!existsSync(join(CLIENT_DIR, 'index.html')) || !existsSync(join(CLIENT_DIR, 'index.wasm')))) {
    console.error(`没有找到客户端导出目录：${CLIENT_DIR}\n请先运行：npm run client:export（需要 Godot 4.7.x，见 client/README.md）`);
    process.exit(2);
  }
  const settings = pick('settings', SETTINGS);
  const cameras = pick('cameras', CAMERAS);
  const { chromium } = loadPlaywright();
  mkdirSync(OUT, { recursive: true });
  if (!URL_GIVEN) await startEngine();
  console.log(`服务：${BASE}  输出：${OUT}  窗口 ${WIDTH}x${HEIGHT} @${DPR}x  ${HEADLESS ? '无头（软件渲染）' : '有头 Chrome'}  提交 ${commit}`);
  const launchOpts = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
  const browser = HEADLESS ? await chromium.launch({ ...launchOpts, headless: true }) : await chromium.launch({ ...launchOpts, channel: 'chrome', headless: false });
  const rows = [];
  try {
    const version = browser.version();
    for (const s of settings) for (const c of cameras) rows.push(await shootOne(browser, version, s, c));
    writeFileSync(
      join(OUT, 'results.json'),
      JSON.stringify({ when: new Date().toISOString(), commit, base: BASE, headless: HEADLESS, softwareRendering: HEADLESS, window: [WIDTH, HEIGHT], deviceScaleFactor: DPR, browser: version, rows }, null, 2),
    );
  } finally {
    await browser.close().catch(() => {});
  }
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} 张完成，数据在 ${join(OUT, 'results.json')}`);
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(e instanceof Error ? e.stack : e);
} finally {
  await stopEngine();
  if (!KEEP) rmSync(TMP, { recursive: true, force: true });
}
process.exit(code);
