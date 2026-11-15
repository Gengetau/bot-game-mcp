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
 *   --kit=<模式>        套件模式（见下）：地址栏带 &props=<模式>，不截清晰度矩阵
 *   --object=<物件编号> 套件模式看哪件物件，默认 kitchen:stove1；--stand=x,z 站在哪（默认 49.9,4.7，左边灶台的右前方，人不挡着它）
 *   --states=idle,busy,done,fault   套件模式要切的状态
 *
 * 套件模式（T02a / T02b 的实机画面）：同一位居民走到 --stand，镜头 default / near / night 各开一次页面，
 * 每次把 --object 依次强行切到各个状态（window.__town.setPropState），等动画走一会儿再截图：一张整幅、一张以物件为中心的裁切。
 * 输出默认在 client/docs/T02/shots/<模式>/，数据进 results.json（每行带 __town.props 里这件物件的读数）。
 *
 * 矩阵：
 *   渲染设置：scale1（?debug=1&scale=1.0，固定满分辨率）、auto（默认档，动态分辨率）、low（localStorage town3d.quality=low，固定 0.6）
 *   镜头：default（默认视角）、near（?zoom=6.5，最近的缩放）、night（?hour=21）、indoor（走进栖灯茶馆）；除了 night 都固定在正午（?hour=12），免得截图时镇上正好是夜里
 * 每个组合开一个全新的浏览器上下文、用同一个名字登录（开发登录同名就是同一位居民）；第一次进镇时记下站的位置，之后每个室外镜头先走回这个位置，所以各张图站位相同，进镇后先等 SETTLE_MS 让画面和动态分辨率稳下来，再量 SAMPLE_MS 的帧率，然后截图。
 * 截图时把界面（DOM）藏起来，只留 3D 画布；PNG 不压缩。
 *
 * 引擎的启动、临时配置、开发登录进镇：参照 scripts/client-e2e.mjs（startEngine / login），这里另写一份，没有改动它。
 * Windows 上的进程处理：用 node 直接跑 tsx 的 cli.mjs（不经 .bin 里的 shell 包装），结束时 taskkill /T /F 杀整个进程树；其他系统自成进程组、杀组。
 * Playwright 不在仓库依赖里：和 client-e2e.mjs 一样，用 NODE_PATH 找（npm i -g playwright 或装进 NODE_PATH 指向的目录）。
 *
 * 对照条：截完之后把图拼成给人看的 strip*.png（进仓库）。清晰度矩阵是每张图正中 480x300 的原始像素（不缩放），一行一个镜头、一列一种渲染设置；
 * 套件模式是各状态的裁切图，白天（default、near）一张、夜里一张。原始整幅 PNG 和每个组合的 JSON 不进仓库（.gitignore），results.json 进。
 *
 * 退出码：全部截成功 0；有组合失败 1；前置条件不满足 2。
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const KIT = opt('kit', '');
const KIT_OBJECT = opt('object', 'kitchen:stove1');
const KIT_STAND = opt('stand', '49.9,4.7').split(',').map(Number);
const KIT_STATES = opt('states', 'idle,busy,done,fault').split(',').filter(Boolean);
const OUT = resolve(opt('out', KIT ? join(ROOT, 'client', 'docs', 'T02', 'shots', KIT) : join(ROOT, 'client', 'docs', 'T01', 'shots')));
const WHO = `拍照${randomBytes(2).toString('hex')}`; // 这一轮从头到尾同一位居民
let HOME = null; // 第一次进镇时站的位置（室外镜头都回到这里）
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
  default: { query: '&hour=12', label: '默认视角（正午）' },
  near: { query: `&hour=12&zoom=${NEAR_ZOOM}`, label: '最近的缩放（正午）' },
  night: { query: '&hour=21', label: '夜里 21 点' },
  indoor: { query: '&hour=12', label: '室内（茶馆，正午）', indoor: true },
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
  // 同一位居民上一个页面刚关：控制权可能还挂在旧页面名下，这个页面是只读的。接管过来再继续（否则走不动）
  await sleep(600);
  if ((await page.evaluate(() => window.__town.mine)) === false) {
    const clientId = await page.evaluate(() => window.TownHud.clientId());
    const r = await page.context().request.post(`${BASE}/town/api/claim`, { data: { clientId } });
    if (!r.ok()) throw new Error(`接管失败：${r.status()}`);
    await page.waitForFunction(() => window.__town.mine === true, null, { timeout: 20_000 });
  }
}

/** 走到一个点，等走完。参照 e2e/lib/chat.mjs 的 apiAct。已经在 0.3 米内就不动。 */
async function walkTo(page, ctx, to) {
  const here = await page.evaluate(() => {
    const t = window.__town;
    const me = t.actors.find((a) => a.id === t.self);
    return me ? { x: me.x, z: me.z } : null;
  });
  if (here && Math.hypot(here.x - to.x, here.z - to.z) < 0.3) return;
  const clientId = await page.evaluate(() => window.TownHud.clientId());
  const me = await (await ctx.request.get(`${BASE}/town/api/me?clientId=${encodeURIComponent(clientId)}`)).json();
  const r = await ctx.request.post(`${BASE}/town/api/actions`, {
    data: {
      clientId,
      requestId: `shots-${rnd()}-${Date.now()}`,
      actionWindow: me.actionWindow,
      expected: { contextVersion: me.context?.version, controlEpoch: me.control?.epoch, activityId: me.context?.activityId ?? null },
      action: { type: 'navigate', to: { x: to.x, z: to.z } },
    },
  });
  if (r.status() !== 200) throw new Error(`navigate 到 ${JSON.stringify(to)} 失败：${r.status()} ${JSON.stringify(await r.json().catch(() => null))}`);
  await page.waitForFunction(
    ([x, z]) => {
      const t = window.__town;
      const a = t.actors.find((q) => q.id === t.self);
      return a && !a.moving && Math.hypot(a.x - x, a.z - z) < 1.2;
    },
    [to.x, to.z],
    { timeout: 120_000, polling: 500 },
  );
}

/** 走进茶馆：navigate 到 tea_house（服务器的地点编号），等走完。 */
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
    await loginPlay(page, WHO, S.query + C.query);
    if (!HOME) {
      HOME = await page.evaluate(() => {
        const t = window.__town;
        const me = t.actors.find((a) => a.id === t.self);
        return { x: me.x, z: me.z };
      });
    }
    if (C.indoor) {
      await walkIntoTeahouse(page, ctx);
      await sleep(2500); // 屋顶淡出
    } else {
      await walkTo(page, ctx, HOME); // 上一个组合可能把人留在了茶馆里
      await sleep(1500);
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

// ───────────────────────── 套件模式 ─────────────────────────

const KIT_CAMERAS = { default: CAMERAS.default, near: CAMERAS.near, night: CAMERAS.night };

async function shootKit(browser, browserVersion, cKey) {
  const C = KIT_CAMERAS[cKey];
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  const rows = [];
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  try {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('town3d.quality', 'high');
      } catch {
        /* 取不到就用默认 */
      }
    });
    await loginPlay(page, WHO, `&props=${encodeURIComponent(KIT)}&scale=1.0${C.query}`);
    await walkTo(page, ctx, { x: KIT_STAND[0], z: KIT_STAND[1] });
    await sleep(SETTLE_MS);
    const gpu = await gpuString(page);
    await page.addStyleTag({ content: '#hud, #dock, #dockBtn, #panel, .toast, #tags, #actions { visibility: hidden !important; }' });
    for (const st of KIT_STATES) {
      const tag = `kit-${cKey}-${st}`;
      const row = { name: tag, kit: KIT, object: KIT_OBJECT, camera: cKey, cameraLabel: C.label, state: st, file: `${tag}.png`, crop: `${tag}-crop.png`, ok: false };
      try {
        if ((await page.evaluate(() => typeof window.__town.setPropState)) !== 'function') throw new Error('window.__town.setPropState 不是函数');
        await page.evaluate(([i, s]) => window.__town.setPropState(i, s), [KIT_OBJECT, st]);
        await page.waitForFunction(([i, s]) => (window.__town.props || []).some((p) => p.id === i && p.state === s), [KIT_OBJECT, st], { timeout: 10_000, polling: 200 }).catch(() => {
          throw new Error(`${KIT_OBJECT} 没有切到 ${st}（props 里没有这件物件，或它没有这个状态）`);
        });
        await sleep(1200); // 让循环动画走一会儿
        const info = await page.evaluate((i) => {
          const t = window.__town;
          const me = t.actors.find((a) => a.id === t.self);
          const o = (t.objects || []).find((q) => q.id === i);
          return {
            prop: (t.props || []).find((p) => p.id === i) ?? null, renderScale: t.renderScale, renderSize: t.renderSize, canvasSize: t.canvasSize,
            zoom: t.zoom, hour: t.hour, fps: t.fps, self: me ? { x: +me.x.toFixed(2), z: +me.z.toFixed(2) } : null, screen: o ? { x: o.sx, y: o.sy } : null,
          };
        }, KIT_OBJECT);
        await page.screenshot({ path: join(OUT, row.file), type: 'png' });
        if (info.screen && Number.isFinite(info.screen.x)) {
          const w = Math.min(560, WIDTH);
          const h = Math.min(420, HEIGHT);
          const x = Math.max(0, Math.min(WIDTH - w, Math.round(info.screen.x - w / 2)));
          const y = Math.max(0, Math.min(HEIGHT - h, Math.round(info.screen.y - h * 0.62)));
          await page.screenshot({ path: join(OUT, row.crop), type: 'png', clip: { x, y, width: w, height: h } });
        } else row.crop = null;
        Object.assign(row, info, { ok: true, gpu, browser: browserVersion, headless: HEADLESS, softwareRendering: HEADLESS || /swiftshader|llvmpipe|software/i.test(gpu), commit, window: [WIDTH, HEIGHT] });
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      console.log(`${row.ok ? '✓' : '✗'} ${tag}${row.ok ? `  状态 ${row.prop?.state}  ${row.fps} 帧` : `  ${row.error}`}`);
      rows.push(row);
    }
    await page.evaluate((i) => window.__town.setPropState && window.__town.setPropState(i, ''), KIT_OBJECT).catch(() => {});
  } catch (e) {
    rows.push({ name: `kit-${cKey}`, camera: cKey, ok: false, error: e instanceof Error ? e.message : String(e) });
    console.log(`✗ kit-${cKey}  ${rows.at(-1).error}`);
  } finally {
    await ctx.close().catch(() => {});
  }
  if (errors.length) rows.push({ name: `kit-${cKey}-console`, camera: cKey, ok: false, error: `页面有 ${errors.length} 条错误：${errors.slice(0, 5).join(' | ')}` });
  return rows;
}

// ───────────────────────── 对照条 ─────────────────────────

/** 把一格格图拼成一张：grid 是二维数组，每格 {file, label, crop}；crop 为真时取图正中 w x h 的原始像素，否则整张缩到 w x h。 */
async function makeStrip(browser, grid, w, h, outFile) {
  const cells = grid.map((row) => row.filter((c) => c && existsSync(join(OUT, c.file)))).filter((row) => row.length);
  if (!cells.length) return;
  const cols = Math.max(...cells.map((r) => r.length));
  const page = await browser.newPage({ viewport: { width: cols * (w + 4) + 4, height: cells.length * (h + 4) + 4 }, deviceScaleFactor: 1 });
  const cell = (c) => {
    const src = `data:image/png;base64,${readFileSync(join(OUT, c.file)).toString('base64')}`;
    const bg = c.crop ? `background:url(${src}) center center no-repeat` : `background:url(${src}) center / 100% 100% no-repeat`;
    return `<div style="position:relative;width:${w}px;height:${h}px;${bg}"><span style="position:absolute;left:6px;top:4px;background:rgba(0,0,0,.65);padding:2px 6px">${c.label}</span></div>`;
  };
  await page.setContent(`<body style="margin:4px;background:#222;font:14px sans-serif;color:#eee">${cells.map((r) => `<div style="display:flex;gap:4px;margin-bottom:4px">${r.map(cell).join('')}</div>`).join('')}</body>`);
  await page.screenshot({ path: join(OUT, outFile), type: 'png' });
  await page.close();
}

// ───────────────────────── 主流程 ─────────────────────────

async function main() {
  if (!URL_GIVEN && (!existsSync(join(CLIENT_DIR, 'index.html')) || !existsSync(join(CLIENT_DIR, 'index.wasm')))) {
    console.error(`没有找到客户端导出目录：${CLIENT_DIR}\n请先运行：npm run client:export（需要 Godot 4.7.x，见 client/README.md）`);
    process.exit(2);
  }
  const settings = pick('settings', SETTINGS);
  const cameras = KIT ? [] : pick('cameras', CAMERAS);
  const { chromium } = loadPlaywright();
  mkdirSync(OUT, { recursive: true });
  if (!URL_GIVEN) await startEngine();
  console.log(`服务：${BASE}  输出：${OUT}  窗口 ${WIDTH}x${HEIGHT} @${DPR}x  ${HEADLESS ? '无头（软件渲染）' : '有头 Chrome'}  提交 ${commit}`);
  const launchOpts = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
  const browser = HEADLESS ? await chromium.launch({ ...launchOpts, headless: true }) : await chromium.launch({ ...launchOpts, channel: 'chrome', headless: false });
  const rows = [];
  try {
    const version = browser.version();
    if (KIT) for (const c of pick('cameras', KIT_CAMERAS)) rows.push(...(await shootKit(browser, version, c)));
    else for (const s of settings) for (const c of cameras) rows.push(await shootOne(browser, version, s, c));
    const okRow = (name) => rows.find((r) => r.name === name && r.ok);
    if (KIT) {
      const strip = (cams) => cams.map((c) => KIT_STATES.map((s) => (okRow(`kit-${c}-${s}`)?.crop ? { file: `kit-${c}-${s}-crop.png`, label: `${KIT_CAMERAS[c].label} / ${s}` } : null)));
      await makeStrip(browser, strip(['default', 'near']), 560, 420, 'strip-day.png');
      await makeStrip(browser, strip(['night']), 560, 420, 'strip-night.png');
    } else {
      const grid = cameras.map((c) => settings.map((s) => (okRow(`${s}-${c}`) ? { file: `${s}-${c}.png`, label: `${CAMERAS[c].label} / ${SETTINGS[s].label} / 比例 ${okRow(`${s}-${c}`).renderScale}`, crop: true } : null)));
      await makeStrip(browser, grid, 480, 300, 'strip.png');
    }
    writeFileSync(
      join(OUT, 'results.json'),
      JSON.stringify({ when: new Date().toISOString(), commit, base: BASE, headless: HEADLESS, softwareRendering: HEADLESS, window: [WIDTH, HEIGHT], deviceScaleFactor: DPR, browser: version, kit: KIT || null, rows }, null, 2),
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
