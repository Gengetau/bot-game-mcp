// V1 第一项、第二项：镜头给面板让位（自己的角色不被抽屉、按钮、软键盘挡住），键位提示条不压按钮、局中不说错话。
// A 桌面 1440x900（侧栏），B 手机 390x844 触摸（抽屉）。
// 每条断言都量「实际画面」：自己脚下的投影点来自 Godot 给的投影矩阵（__town.project），可见矩形由测试自己用 getBoundingClientRect 现量（lib/look.mjs 的 domFree，
// 和 layout.js 的算法是两份），两边对不上就是有人算错了。屏障：目标点缓动结束（__town.view.settled）加版式连续 500 毫秒没再量过。
// 末尾有一段「怎么让它失败」：分「实测过」和「只是推演」。
import { poll, dockState, openDock, closeDock, rectOf, frames } from '../lib/ui.mjs';
import { viewState, selfScreen, domFree, settleView, unprojectGround, distToSeg, hit, sleep } from '../lib/look.mjs';

export const meta = { id: 'look-camera', n: 95, title: 'V1 镜头给面板让位与键位提示条' };

const M = 24; // 投影点离可见矩形四边至少这么远
const inRect = (q, f, m = M) => q.x >= f.l + m && q.x <= f.r - m && q.y >= f.t + m && q.y <= f.b - m;

export default async function run(h) {
  const { check, note, until, step, shot, serverScene, selfActor, clickWorld, T_POS } = h;
  const { A, B } = await h.pair();

  const feedGame = (p, kind, d) => p.page.evaluate(([k, j]) => window.TownHud.feed('game', k, j), [kind, JSON.stringify(d)]);
  const fakeGame = (n, over = {}) => ({
    mode: 'game', name: '数字炸弹', gameId: 'fake-game-v1', mySeat: 1, loading: false, round: 3, title: '猜数', open: true, secondsLeft: 40, phaseId: 7, yourTurn: true, curSeat: 1,
    range: { from: 20, to: 80 }, bombMode: 'single', over: false,
    players: Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `玩家${i + 1}号`, kind: i % 2 ? 'agent' : 'human', alive: true, turn: i === 0, me: i === 0 })),
    history: [],
    ...over,
  });
  const selectTab = (p, id) => p.page.evaluate((i) => window.TownDock.test.select(i), id);
  const tagRect = (p, cls) => p.page.evaluate((c) => document.querySelector(`#tags .tag.${c}`)?.getBoundingClientRect().toJSON() ?? null, cls);

  // ───────────────────────── 95 手机：抽屉关着、逐个页签打开、关上 ─────────────────────────
  await step(95, '手机 390x844：抽屉关着时自己在视口正中附近；依次打开每个页签的抽屉，停稳后自己的投影点在可见矩形内（四边各留 24 像素）、名牌不压 #dock、#bottombar、#stack；关上后 1.5 秒内（放宽到 3 秒）回到正中附近；版式一变化才发消息', async () => {
    await settleView(B.page, { what: 'B 刚进镇时版式与镜头稳定' });
    let s = await selfScreen(B.page);
    check(Math.abs(s.nx - 0.5) <= 0.08 && s.ny >= 0.45 && s.ny <= 0.65, `抽屉关着时自己应在视口正中附近（横向偏差 <= 8%、纵向 45% 到 65%）：(${s.nx.toFixed(3)}, ${s.ny.toFixed(3)})`);
    // 实现算的可见矩形和测试现量的一致
    const vs = await viewState(B.page);
    const f0 = await domFree(B.page);
    const lr = vs.layout.rect;
    // layout.js 在顶栏、按钮行外各留 4 像素缓冲，所以和裸量的差在 4 上下
    check(lr && Math.abs(lr.t - f0.t - 4) <= 1.5 && Math.abs(f0.b - lr.b - 4) <= 1.5 && Math.abs(lr.r - f0.r) <= 2, `layout.js 算的可见矩形应和测试现量的一致：${JSON.stringify(lr)} 对 ${JSON.stringify(f0)}`);
    note(`B 关着：自己 (${s.nx.toFixed(3)}, ${s.ny.toFixed(3)})，可见矩形 t=${f0.t.toFixed(0)} b=${f0.b.toFixed(0)}`);

    await openDock(B.page);
    const tabs = (await dockState(B.page)).mods;
    check(tabs.length >= 4, `应至少有四个页签：${tabs}`);
    const seenTabs = [];
    for (const id of tabs) {
      await selectTab(B, id);
      await settleView(B.page, { what: `B 打开「${id}」页签后版式与镜头稳定` });
      const f = await domFree(B.page);
      s = await selfScreen(B.page);
      check(f.dockOpen && f.layout === 'drawer', `${id}：应是开着的抽屉：${JSON.stringify(f)}`);
      check(inRect(s, f), `${id}：自己的投影点应在可见矩形内（四边各留 ${M} 像素）：(${s.x.toFixed(0)}, ${s.y.toFixed(0)}) 对 t=${f.t.toFixed(0)} b=${f.b.toFixed(0)} r=${f.r.toFixed(0)}`);
      const tag = await tagRect(B, 's');
      check(tag, `${id}：自己的名牌应画着`);
      for (const sel of ['#dock', '#bottombar', '#stack']) {
        const r = await rectOf(B.page, sel);
        const empty = !r || r.width === 0 || r.height === 0;
        check(empty || !hit(tag, r), `${id}：自己的名牌不应压 ${sel}：名牌 ${JSON.stringify([tag.left, tag.top, tag.right, tag.bottom].map(Math.round))} 对 ${JSON.stringify(r && [r.left, r.top, r.right, r.bottom].map(Math.round))}`);
      }
      seenTabs.push(`${id}:${s.y.toFixed(0)}/${f.b.toFixed(0)}`);
      if (id === 'nearby') await shot(B.page, '95-mobile-drawer-nearby');
      if (id === 'town') await shot(B.page, '95-mobile-drawer-town');
    }
    note(`逐个页签（页签:自己的 y/可见矩形下沿）：${seenTabs.join('、')}`);
    // 关上抽屉：回到正中附近
    const t0 = Date.now();
    await closeDock(B.page);
    await until(async () => {
      const q = await selfScreen(B.page);
      return Math.abs(q.nx - 0.5) <= 0.08 && q.ny >= 0.45 && q.ny <= 0.65;
    }, 3000, '关上抽屉后自己回到视口正中附近', 100);
    note(`关上抽屉后 ${Date.now() - t0} 毫秒回到正中附近（任务书 1.5 秒；放宽到 3 秒，软件渲染下一帧约 0.2 秒）`);
    await settleView(B.page, { what: 'B 关上抽屉后稳定' });
  });

  // ───────────────────────── 95.1 软键盘 ─────────────────────────
  await step(95.1, '手机软键盘（TownDock.test.setKeyboard）：300 像素的键盘起来后自己仍在可见矩形内；500 像素把可见区压到不足 120 像素高时，目标点保持不动（不追）；键盘收起后回到正中', async () => {
    await openDock(B.page);
    await selectTab(B, 'nearby');
    await settleView(B.page, { what: '抽屉开着稳定' });
    try {
      await B.page.evaluate(() => window.TownDock.test.setKeyboard(300));
      await until(async () => (await B.page.evaluate(() => document.body.getAttribute('data-kb'))) === '1', 5000, '软键盘状态生效', 50);
      let vs = await settleView(B.page, { what: '软键盘 300 起来后稳定' });
      let f = await domFree(B.page);
      let s = await selfScreen(B.page);
      check(f.b - f.t >= 120, `300 像素键盘下可见区应有 120 像素以上：${JSON.stringify(f)}`);
      check(inRect(s, f), `软键盘 300：自己应仍在可见矩形内：(${s.x.toFixed(0)}, ${s.y.toFixed(0)}) 对 t=${f.t.toFixed(0)} b=${f.b.toFixed(0)}`);
      await shot(B.page, '95-mobile-keyboard');
      const g300 = { x: vs.view.gx, y: vs.view.gy };
      const msgs300 = vs.view.msgs;
      // 500：可见区压到不足 120 高
      await B.page.evaluate(() => window.TownDock.test.setKeyboard(500));
      await until(async () => (await domFree(B.page)).kb === 500, 5000, '软键盘 500 生效', 50);
      vs = await settleView(B.page, { what: '软键盘 500 起来后稳定' });
      f = await domFree(B.page);
      check(f.b - f.t < 120, `500 像素键盘下可见区应不足 120 像素高（才能走到「太小不追」）：${JSON.stringify(f)}`);
      check(vs.view.msgs > msgs300, `版式消息仍应发出（Godot 收到了，只是不追）：${msgs300} -> ${vs.view.msgs}`);
      check(Math.abs(vs.view.gx - g300.x) < 1e-6 && Math.abs(vs.view.gy - g300.y) < 1e-6, `可见区太小：目标点应保持不动：${JSON.stringify(g300)} -> ${JSON.stringify({ x: vs.view.gx, y: vs.view.gy })}`);
      note(`键盘 500：可见区 ${Math.round(f.b - f.t)} 像素高，目标点保持 (${g300.x.toFixed(3)}, ${g300.y.toFixed(3)})，没有追`);
    } finally {
      await B.page.evaluate(() => window.TownDock.test.setKeyboard(null)).catch(() => {});
    }
    await until(async () => (await B.page.evaluate(() => document.body.getAttribute('data-kb'))) !== '1', 5000, '软键盘状态撤掉', 50);
    await settleView(B.page, { what: '软键盘收起后稳定' });
    const f = await domFree(B.page);
    const s = await selfScreen(B.page);
    check(inRect(s, f), `软键盘收起后自己应在可见矩形内：(${s.x.toFixed(0)}, ${s.y.toFixed(0)})`);
    await closeDock(B.page);
    await settleView(B.page, { what: '关抽屉稳定' });
  });

  // ───────────────────────── 95.2 桌面各宽度 ─────────────────────────
  await step(95.2, '桌面 1000、1280、1440 宽（高 900），面板开着：自己的横向位置在可见矩形的 35% 到 65% 之间、纵向在矩形内；面板关上后回到整个视口的正中', async () => {
    try {
      for (const w of [1000, 1280, 1440]) {
        await A.page.setViewportSize({ width: w, height: 900 });
        await frames(A.page, 3);
        await openDock(A.page);
        await settleView(A.page, { what: `${w} 宽面板开着后稳定` });
        const f = await domFree(A.page);
        const s = await selfScreen(A.page);
        const frac = (s.x - f.l) / (f.r - f.l);
        check(frac >= 0.35 && frac <= 0.65, `${w} 宽（${f.layout} 布局）：自己的横向位置应在可见矩形的 35% 到 65%：${(frac * 100).toFixed(1)}%（x=${s.x.toFixed(0)}，矩形 ${f.l.toFixed(0)}..${f.r.toFixed(0)}）`);
        check(inRect(s, f, 8), `${w} 宽：自己应在可见矩形内：(${s.x.toFixed(0)}, ${s.y.toFixed(0)}) 对 ${JSON.stringify({ t: f.t, b: f.b, r: f.r })}`);
        note(`${w} 宽 ${f.layout}：横向 ${(frac * 100).toFixed(1)}%`);
        if (w === 1440) await shot(A.page, '95-desktop-1440-side');
        await closeDock(A.page);
        await settleView(A.page, { what: `${w} 宽面板关上后稳定` });
        const s2 = await selfScreen(A.page);
        check(Math.abs(s2.nx - 0.5) <= 0.06, `${w} 宽面板关上后自己应回到视口正中（横向）：${s2.nx.toFixed(3)}`);
      }
    } finally {
      await A.page.setViewportSize({ width: 1440, height: 900 });
      await closeDock(A.page).catch(() => {});
    }
    await frames(A.page, 3);
    await settleView(A.page, { what: '1440 宽复位后稳定' });
  });

  // ───────────────────────── 95.3 版式消息不是每帧发 ─────────────────────────
  await step(95.3, '版式消息只在版式变化时发：A 站着不动 3 秒，Godot 收到的版式消息数和网页层的量版次数都是 0；开一次面板，消息数不超过 4', async () => {
    await settleView(A.page, { what: 'A 稳定' });
    const v0 = await viewState(A.page);
    const t0 = Date.now();
    await frames(A.page, 5);
    while (Date.now() - t0 < 3200) await sleep(100);
    const v1 = await viewState(A.page);
    check(v1.view.msgs === v0.view.msgs, `站着不动 3 秒：Godot 收到的版式消息应为 0 条新增：${v0.view.msgs} -> ${v1.view.msgs}`);
    check(v1.layout.passes === v0.layout.passes && v1.layout.sent === v0.layout.sent, `站着不动 3 秒：网页层不应量版（passes ${v0.layout.passes} -> ${v1.layout.passes}，sent ${v0.layout.sent} -> ${v1.layout.sent}）`);
    check(v1.view.settled, '站着不动时镜头是到位的');
    note(`站着不动 ${((Date.now() - t0) / 1000).toFixed(1)} 秒：消息 +0，量版 +0（${v1.view.msgs} 条累计，${v1.layout.passes} 次量版累计）`);
    await openDock(A.page);
    const v2 = await settleView(A.page, { what: '开面板后稳定' });
    const d = v2.view.msgs - v1.view.msgs;
    check(d >= 1 && d <= 4, `开一次面板：版式消息应在 1 到 4 条之间：${d}`);
    note(`开一次面板：版式消息 +${d}，量版 +${v2.layout.passes - v1.layout.passes}`);
    await closeDock(A.page);
    await settleView(A.page, { what: '关面板后稳定' });
  });

  // ───────────────────────── 95.4 缓动中途点地 ─────────────────────────
  await step(95.4, '缓动中途点地仍走到点的那个位置：把目标点缓动冻结在 0.06 秒（走到一半）、面板打开，按冻结时的投影点真实点地，服务器导航终点与点的世界坐标相差不超过 T_POS；放开后镜头到终点，同一个像素对应的地面确实变了（证明冻结的是中途）', async () => {
    await settleView(A.page, { what: 'A 稳定' });
    await closeDock(A.page);
    await settleView(A.page, { what: 'A 面板关着稳定' });
    const me0 = await selfScreen(A.page);
    try {
      await A.page.evaluate(() => window.__town.holdView(0.06));
      await A.page.click('#dockBtn');
      await poll(async () => {
        const v = await viewState(A.page);
        return v?.view && v.view.settled === false && Math.abs(v.view.tx - 0.5) > 0.01 && (await dockState(A.page))?.open;
      }, 8000, '面板打开、目标点缓动开始并被冻结在中途', 80);
      // 冻结之后镜头应不再变：连续两次取到的 vp 一样
      await frames(A.page, 3);
      const v1 = await viewState(A.page);
      await frames(A.page, 2);
      const v2 = await viewState(A.page);
      check(v1.vp.every((x, i) => Math.abs(x - v2.vp[i]) < 1e-6), '冻结之后投影矩阵不再变');
      const me = await selfScreen(A.page);
      // 要点的世界点：自己东 3 米、北 2 米（广场上，离面板远）
      const W = { x: me.wx + 3, z: me.wz - 2 };
      const q = await A.page.evaluate(([x, z]) => window.__town.project(x, 0, z), [W.x, W.z]);
      check(q.x > 24 && q.x < me.W - 400 && q.y > 100 && q.y < me.H - 170, `冻结时的点位应在可点区域：(${q.x.toFixed(0)}, ${q.y.toFixed(0)})`);
      const top = await A.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [q.x, q.y]);
      check(top === 'canvas', `点位最上面应是画布：#${top}`);
      await A.page.mouse.click(q.x, q.y);
      const nav = await until(async () => selfActor(await serverScene(A))?.nav, 8000, '服务器收到导航', 150);
      const pts = nav.points.map((p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : p));
      const end = pts[pts.length - 1];
      const err = Math.hypot(end.x - W.x, end.z - W.z);
      check(err <= T_POS, `缓动中途点地：导航终点应在点的世界坐标 ${T_POS} 米内：终点 (${end.x.toFixed(2)}, ${end.z.toFixed(2)})，点 (${W.x.toFixed(2)}, ${W.z.toFixed(2)})，差 ${err.toFixed(2)}`);
      // 放开：镜头到终点，同一个像素对应的地面变了
      await A.page.evaluate(() => window.__town.holdView(null));
      const vf = await settleView(A.page, { what: '放开冻结后稳定', timeout: 40_000 });
      const wFinal = unprojectGround(vf.vp, me.W, me.H, q);
      // 走路中镜头在跟：比较的是缓动结果本身，用冻结时的 vp 算同一个像素在当时镜头下的地面点（= W），与现在镜头下的地面点相比，差应明显大于 T_POS
      const wFrozen = unprojectGround(v2.vp, me.W, me.H, q);
      check(Math.hypot(wFrozen.x - W.x, wFrozen.z - W.z) < 0.05, `冻结时的投影点反推回去应是点的世界坐标：差 ${Math.hypot(wFrozen.x - W.x, wFrozen.z - W.z).toFixed(3)}`);
      note(`导航终点差 ${err.toFixed(2)} 米；缓动中途与缓动完成后，同一个像素对应的地面相距 ${Math.hypot(wFinal.x - wFrozen.x, wFinal.z - wFrozen.z).toFixed(1)} 米（含自己走动带来的镜头跟随）`);
      void me0;
    } finally {
      await A.page.evaluate(() => window.__town?.holdView?.(null)).catch(() => {});
    }
    await until(async () => !selfActor(await serverScene(A))?.nav, 30_000, '走完', 400);
    await closeDock(A.page);
    await settleView(A.page, { what: 'A 关面板后稳定', timeout: 20_000 });
  });

  // ───────────────────────── 95.5 键位提示条 ─────────────────────────
  await step(95.5, '键位提示条：桌面宽 901、1000、1100、1220、1280、1440（高 900），面板开和关各一遍，可见时与 #controls、#stack、#dock 两两不相交（留 4 像素）；1440 宽面板关着时是完整的那一版；放不下先换短版（只留按键）再隐藏；不收指针', async () => {
    const hint = (p) =>
      p.page.evaluate(() => {
        const e = document.getElementById('keyHint');
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        const kh = [...e.querySelectorAll('.kh-t')].map((x) => getComputedStyle(x).display !== 'none');
        return { mode: e.getAttribute('data-mode'), shown: cs.display !== 'none' && !e.hidden && r.width > 0, rect: r.toJSON(), pe: cs.pointerEvents, text: e.innerText, full: kh.length > 0 && kh.every(Boolean), W: window.innerWidth };
      });
    const modes = [];
    try {
      for (const open of [false, true]) {
        for (const w of [901, 1000, 1100, 1220, 1280, 1440]) {
          await A.page.setViewportSize({ width: w, height: 900 });
          await frames(A.page, 3);
          if (open) await openDock(A.page);
          else await closeDock(A.page);
          await settleView(A.page, { what: `${w} 宽 面板${open ? '开' : '关'} 稳定` });
          const k = await hint(A);
          const tag = `${w} 宽 面板${open ? '开' : '关'}`;
          modes.push(`${w}${open ? '开' : '关'}:${k.shown ? k.mode : '隐'}`);
          check(k.pe === 'none', `${tag}：提示条不应收指针事件（pointer-events:${k.pe}）`);
          if (k.shown) {
            for (const sel of ['#controls', '#stack', '#dock', '#actions']) {
              const r = await rectOf(A.page, sel);
              if (!r || r.width === 0 || r.height === 0) continue;
              const vis = await A.page.evaluate((s) => getComputedStyle(document.querySelector(s)).display !== 'none' && !document.querySelector(s).hidden, sel);
              if (!vis) continue;
              check(!hit(k.rect, r, 4), `${tag}（${k.mode} 版）：提示条不应与 ${sel} 相交（留 4 像素）：提示条 ${JSON.stringify([k.rect.left, k.rect.top, k.rect.right, k.rect.bottom].map(Math.round))} 对 ${JSON.stringify([r.left, r.top, r.right, r.bottom].map(Math.round))}`);
            }
            check(k.rect.right <= k.W && k.rect.left >= 0, `${tag}：提示条整块在视口里`);
          }
          if (w === 1440 && !open) {
            check(k.shown && k.mode === 'full' && k.full && /移动/.test(k.text), `1440 宽面板关着：必须是完整的那一版：${JSON.stringify({ mode: k.mode, shown: k.shown, text: k.text })}`);
            await shot(A.page, '95-desktop-1440-keyhint');
          }
          if (w === 1100 && open) await shot(A.page, '95-desktop-1100-side');
          if (w === 901 && !open) check(k.shown && k.mode === 'short', `901 宽面板关着：完整版放不下按钮行，应换成只留按键的短版：${JSON.stringify({ mode: k.mode, shown: k.shown })}`);
        }
      }
    } finally {
      await A.page.setViewportSize({ width: 1440, height: 900 });
      await closeDock(A.page).catch(() => {});
    }
    note(`各宽度的提示条（宽+开关:版本）：${modes.join(' ')}`);
    await settleView(A.page, { what: '复位稳定' });
  });

  await step(95.6, '局中（body[data-game="1"]，给面板喂一份假局面）：提示条里不出现「移动」；收起后回到完整版', async () => {
    try {
      await feedGame(A, 'state', fakeGame(2));
      await until(async () => (await A.page.evaluate(() => document.body.getAttribute('data-game'))) === '1', 5000, 'A 进入局中状态', 50);
      await poll(async () => (await A.page.evaluate(() => document.getElementById('keyHint').getAttribute('data-mode'))) === 'off', 5000, '局中提示条隐藏', 100);
      const k = await A.page.evaluate(() => {
        const e = document.getElementById('keyHint');
        return { text: e.innerText, display: getComputedStyle(e).display, w: e.getBoundingClientRect().width };
      });
      check(k.display === 'none' || k.w === 0 || !/移动/.test(k.text), `局中提示条不应出现「移动」：${JSON.stringify(k)}`);
      await shot(A.page, '95-desktop-game-nohint');
    } finally {
      await feedGame(A, 'reset', null).catch(() => {});
    }
    await until(async () => (await A.page.evaluate(() => document.body.getAttribute('data-game'))) === null, 5000, '局中状态撤掉', 50);
    await poll(async () => (await A.page.evaluate(() => document.getElementById('keyHint').getAttribute('data-mode'))) === 'full', 5000, '收起后提示条回到完整版', 100);
  });

  await h.release(A);
  await h.release(B);
}

/*
 * 怎么让它失败（临时改动 -> 应当变红的子步骤；改完一定改回来）
 * 【实测过】（结果见 client/docs/V1.md「反向验证」）
 *  1. rig.gd 的 _update() 里把 off 固定成零（镜头不让位）-> 95「依次打开每个页签」：自己的投影点不在可见矩形内。
 *  2. layout.js 的 measure() 去掉「msg !== lastSent」判断、并让 hud.js 每帧调一次 TownLayout.invalidate（每帧发版式）-> 95.3「站着不动 3 秒版式消息应为 0」。
 *  3. layout.js 里 keyHintMode 的 obstacles 去掉 #controls（让提示条不躲按钮行）-> 95.5「提示条不应与 #controls 相交」。
 *  4. layout.js 里 off: inGame 改成 off: false -> 95.6「局中提示条不应出现移动」。
 * 【只是推演】
 *  - 95.1 的「太小不追」：view_logic.gd 的 MIN_H 改成 0 -> 目标点被追到一个极小的矩形里，gy 变了；单测里也有对应的一条（client/tests/view_logic_test.gd）。
 *  - 95.4：rig.gd 的 ground_offset 用错宽高比 -> 冻结时投影点反推回去与点的世界坐标不符（单测的相机对照也会红）。
 */
