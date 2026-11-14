// C3：走到游戏桌入座，玩一局数字炸弹。A 桌面 1440x900（键盘），B 手机 390x844 触摸（屏幕数字键），C 是只走 API 的居民（凑人数、当对手）。
// 步骤号都是数字（50.15 就是「50.1 之后的一步」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言都按那里写的做过反向验证（或明说只是推理）。
import { frames, rectOf, godotFeature, closeDock, openDock, dockState, modState } from '../lib/ui.mjs';
import { apiSay, apiHistory } from '../lib/chat.mjs';
import { openTown, townRows, townCompose, apiTownSay, apiTownSayWait } from '../lib/town.mjs';
import { gameMod, godotGame, gameButtons, toastTexts, tableTags, clickObject, serverMe, apiAct, publicGame, midOf, apiResident, sleep as nap } from '../lib/game.mjs';

export const meta = { id: 'game-table', n: 50, title: '走到游戏桌入座，玩一局数字炸弹' };

const T1 = 'arcade:table1';
const T2 = 'arcade:table2';
const BLOCK = '对局中，先打完这一局（或点「离开这局」）。';
const DROPPED = '开局的时候你不在桌边，没有加入这一局。';

export default async function run(h) {
  const { check, note, until, sleep, step, shot, allowFailure, selfActor, dist, serverScene, snap, clickWorld, BASE } = h;
  const { A, B } = await h.pair();
  let C = null;
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);
  const count = (p, type) => actionsOf(p, type).length;
  const sceneOf = async (p) => selfActor(await serverScene(p));
  const waitIdle = (p, ms = 60_000) => until(async () => !(await sceneOf(p)).nav, ms, `${p.label} 走完`, 500);
  const gg = async (p) => (await godotGame(p)) ?? {};
  const objOf = async (p, oid) => (await snap(p.page)).objects.find((o) => o.id === oid) ?? null;
  const btn = async (p, prefix) => (await gameButtons(p.page)).find((b) => b.id.startsWith(prefix)) ?? null;
  /** 等待失败时把现场写进错误信息：Godot 一侧 game 状态、桌牌、按钮、提示条。 */
  const withScene = async (p, fn) => {
    try {
      return await fn();
    } catch (e) {
      const dbg = { game: await gg(p).catch(() => null), tags: await tableTags(p.page).catch(() => null), buttons: await gameButtons(p.page).catch(() => null), toasts: await toastTexts(p.page).catch(() => null) };
      e.message += ` 现场：${JSON.stringify(dbg)}`;
      throw e;
    }
  };
  const waitBtn = async (p, prefix, ms = 25_000) => {
    try {
      return await until(() => btn(p, prefix), ms, `${p.label} 出现按钮 ${prefix}`, 200);
    } catch (e) {
      // 失败时把现场写进错误信息：Godot 一侧的 game 状态、服务器的 here.tables、按钮清单
      const dbg = { game: await gg(p).catch(() => null), tables: (await serverMe(p).catch(() => ({}))).here?.tables, buttons: await gameButtons(p.page).catch(() => null), nearValid: (await snap(p.page).catch(() => ({}))).nearValid };
      e.message += ` 现场：${JSON.stringify(dbg)}`;
      throw e;
    }
  };
  const click = (p, id) => p.page.click(`#actions [data-action="${id}"]`);
  const toastHas = (p, frag, ms = 20_000) => until(async () => (await toastTexts(p.page)).find((t) => t.includes(frag)) ?? null, ms, `${p.label} 出现提示「${frag}」`, 200);
  const nameOf = async (viewer, id) => (await snap(viewer.page)).actors.find((x) => x.id === id)?.name ?? '';
  const seatDist = async (p, oid) => {
    const o = await objOf(p, oid);
    const me = await sceneOf(p);
    return dist(me, o);
  };
  const goArcade = async (p) => {
    await p.page.click('#destBtn');
    await p.page.click('[data-dest="arcade"]');
    await until(async () => { const s = await sceneOf(p); return !s.nav && s.x > 20 && s.z > 38 && s.z < 48 ? s : null; }, 120_000, `${p.label} 到了游戏馆`, 700);
  };
  /** 手机（触屏）接了实体键盘：数字键拼出数字、Enter 提交。轮到自己时输入框应已自动聚焦；返回猜的数，回合变了没猜成返回 null。 */
  const takeTurnKeys = async (p) => {
    const d0 = await gameMod(p.page);
    if (!d0.yourTurn || d0.busy) return null;
    const num = midOf(d0.range);
    const n0 = (await godotGame(p))?.sent?.guess ?? 0;
    // 自动聚焦本身在 50.05 里用假局面核对过；这里这一轮可能早就开始、中间被前面「点面板」之类的操作点掉了焦点（点非交互区域会让输入框失焦），所以只是兜底聚焦
    if (!d0.focused) await p.page.focus('#gamePanel [data-role="input"]');
    try {
      await p.page.click('#gamePanel [data-key="clear"]', { timeout: 5000 });
      for (const ch of String(num)) await p.page.keyboard.press(`Digit${ch}`);
      check((await gameMod(p.page)).input === String(num), `${p.label} 实体键盘应拼出 ${num}：${(await gameMod(p.page)).input}`);
      await p.page.keyboard.press('Enter');
    } catch (e) {
      const d1 = await gameMod(p.page);
      if (!d1.yourTurn || d1.mode !== 'game') return null;
      throw e;
    }
    await until(async () => (((await godotGame(p))?.sent?.guess ?? 0) > n0) || (await gameMod(p.page)).mode === 'result', 15_000, `${p.label} 的猜数发出去了（实体键盘）`, 150);
    return num;
  };
  const lobbyId = async (p) => (await gg(p)).lobby || '';
  /** 桌只保留 activityLobbyTtlMs（端到端里 25 秒）：软件渲染慢、桌被散掉时重新开一桌（A 开、B 加入），保证后面的步骤站在「A、B 都在桌里」的起点。 */
  const ensureTable = async (withB) => {
    if (!(await lobbyId(A))) {
      note('桌被保留时间散掉了，重新开一桌');
      await click(A, (await waitBtn(A, `f:game:propose:${T1}`)).id);
      await until(async () => (await lobbyId(A)) !== '', 20_000, 'A 重新开了桌');
    }
    if (withB && !(await lobbyId(B))) {
      await click(B, (await waitBtn(B, 'f:game:join:')).id);
      await until(async () => (await lobbyId(B)) !== '', 20_000, 'B 重新加入');
    }
  };
  /** 局内某一边的猜数：桌面用键盘（填数字 + Enter），手机用屏幕数字键 + 「猜」。返回猜的数。 */
  const takeTurn = async (p, number) => {
    const d0 = await gameMod(p.page);
    if (!d0.yourTurn || d0.busy) return null; // 读的当口回合已经变了（比如刚猜完、视图还在路上）：这一轮不猜
    const num = number ?? midOf(d0.range);
    const n0 = (await godotGame(p))?.sent?.guess ?? 0;
    try {
      if (p.touch) {
        check(d0.inputReadonly, `${p.label} 手机上输入框应是只读（用屏幕数字键）`);
        await p.page.click('#gamePanel [data-key="clear"]', { timeout: 5000 });
        for (const ch of String(num)) await p.page.click(`#gamePanel [data-key="${ch}"]`, { timeout: 5000 });
        check((await gameMod(p.page)).input === String(num), `${p.label} 屏幕数字键应拼出 ${num}：${(await gameMod(p.page)).input}`);
        await p.page.click('#gamePanel [data-role="submit"]', { timeout: 5000 });
      } else {
        await p.page.fill('#gamePanel [data-role="input"]', String(num), { timeout: 5000 });
        await p.page.press('#gamePanel [data-role="input"]', 'Enter', { timeout: 5000 });
      }
    } catch (e) {
      // 操作的当口回合变了（对手超时代猜、局已结束）：这一轮不猜；回合还是自己的就是真故障
      const d1 = await gameMod(p.page);
      if (!d1.yourTurn || d1.mode !== 'game') return null;
      throw e;
    }
    await until(async () => (((await godotGame(p))?.sent?.guess ?? 0) > n0) || (await gameMod(p.page)).mode === 'result', 15_000, `${p.label} 的猜数发出去了`, 150);
    return num;
  };

  // ───────────────────────── 50 初始与到游戏馆 ─────────────────────────
  await step(50, '初始：两边都有 game 模块（面板在 #dockOverlays 里隐藏）、Godot 一侧 game；离桌远时 #actions 里没有 f:game 按钮、没有桌牌；两人去游戏馆；按一下 E 和点击一样走到桌边（同一个入口 on_pick），连按两下 E 只走一次', async () => {
    for (const p of [A, B]) {
      check(await gameMod(p.page), `${p.label} 应有 __dock.game`);
      check(await godotGame(p), `${p.label} 应有 __town.features.game`);
      const m = await gameMod(p.page);
      check(m.mode === 'none' && !m.shown && m.bodyFlag === null, `${p.label} 局外面板应隐藏、body 上没有 data-game：${JSON.stringify({ mode: m.mode, shown: m.shown, flag: m.bodyFlag })}`);
      check((await gameButtons(p.page)).length === 0, `${p.label} 离桌远时不应有 f:game 按钮`);
      check((await tableTags(p.page)).length === 0, `${p.label} 离桌远时不应有桌牌`);
      const hosted = await p.page.evaluate(() => document.querySelector('#dockOverlays #gamePanel') !== null);
      check(hosted, `${p.label} 的 #gamePanel 应在 #dockOverlays 里`);
    }
    // 先只有 A 在游戏馆：E 键选「8 米内最近的物件或居民」，B 站在旁边会被选成人，测不到桌子
    await goArcade(A);
    await until(async () => (await snap(A.page)).nearValid === true, 20_000, 'A 的够得着状态有效');
    const tabs = await until(async () => (await gg(A)).tables?.length === 2 ? (await gg(A)).tables : null, 20_000, 'A 看到两张游戏桌');
    check(tabs.every((x) => /^arcade:table[12]$/.test(x.id)), `游戏桌编号应是 arcade:table1/2：${JSON.stringify(tabs)}`);
    // E 键：与点击同一个入口。两张桌同样远，选哪张不论，但必须：on_pick 记录是 (obj, 桌, key, 接管)、只发一次导航、连按第二下不再发
    const nav0 = count(A, 'navigate');
    const pick0 = (await A.page.evaluate(() => window.__town.features._pick))?.n ?? 0;
    const w0 = (await gg(A)).walks;
    await A.page.keyboard.press('KeyE');
    const rec = await until(async () => { const r = await A.page.evaluate(() => window.__town.features._pick); return r && r.n > pick0 ? r : null; }, 20_000, '按 E 之后 on_pick 记录出现');
    check(rec.kind === 'obj' && /^arcade:table[12]$/.test(rec.id) && rec.src === 'key' && rec.taken === true, `记录应是 (obj, 游戏桌, key, 接管)：${JSON.stringify(rec)}`);
    await A.page.keyboard.press('KeyE');
    const rec2 = await until(async () => { const r = await A.page.evaluate(() => window.__town.features._pick); return r && r.n > rec.n ? r : null; }, 20_000, '第二下 E 的记录出现');
    check(rec2.id === rec.id && rec2.taken === true, `第二下 E 也应被接管：${JSON.stringify(rec2)}`);
    await frames(A.page, 5); // 屏障：旧逻辑会在 on_pick 的同一帧发 navigate
    await until(async () => (await gg(A)).walks > w0, 10_000, '开始走向桌边（walks 加一）');
    await waitIdle(A);
    check((await gg(A)).walks === w0 + 1, `连按两下 E 只走一次：walks ${w0} -> ${(await gg(A)).walks}`);
    check(count(A, 'navigate') === nav0 + 1, `连按两下 E 只发一次 navigate：${nav0} -> ${count(A, 'navigate')}`);
    check((await seatDist(A, rec.id)) <= 2.0, `走到后离桌心应不超过 2 米：${await seatDist(A, rec.id)}`);
    note(`E 键选了 ${rec.id}，A 站在离桌心 ${(await seatDist(A, rec.id)).toFixed(2)} 米处`);
    await goArcade(B);
    await until(async () => (await snap(B.page)).nearValid === true && (await gg(B)).tables?.length === 2, 20_000, 'B 的够得着状态有效、看到两张桌');
  });

  // ───────────────────────── 50.05 面板版式与输入（喂假局面，不开局）─────────────────────────
  await step(50.05, '面板版式与输入（给面板喂一份假局面，不开局）：确认条开着时局结束，下一局的「离开这局」回来；焦点在画布上时轮到自己仍自动聚焦；触屏接实体键盘能输入；横屏矮屏、开着右侧栏、8 个玩家时面板不盖侧栏和顶栏；手机抽屉打开、软键盘出现时输入区都看得见', async () => {
    const fake = (n, over = {}) => ({
      mode: 'game', name: '数字炸弹', gameId: 'fake-game', mySeat: 1, loading: false, round: 3, title: '猜数', open: true, secondsLeft: 40, phaseId: 7, yourTurn: true, curSeat: 1,
      range: { from: 20, to: 80 }, bombMode: 'single', over: false,
      players: Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `名字挺长的玩家${i + 1}号`, kind: i % 2 ? 'agent' : 'human', alive: true, turn: i === 0, me: i === 0 })),
      history: Array.from({ length: 12 }, (_, i) => ({ round: i + 1, seat: (i % n) + 1, name: `名字挺长的玩家${(i % n) + 1}号`, guess: 20 + i, result: '炸弹更大', auto: false })),
      ...over,
    });
    const feed = (p, kind, d) => p.page.evaluate(([k, j]) => window.TownHud.feed('game', k, j), [kind, JSON.stringify(d)]);
    const reset = async (p) => { await feed(p, 'reset', null); await until(async () => (await gameMod(p.page)).mode === 'none' && (await gameMod(p.page)).bodyFlag === null, 5000, `${p.label} 面板收起`, 50); };
    /* 横屏矮屏里右侧栏的输入框会盖住 #dockBtn（点不到），所以用接口收起 */
    const shutDock = async (p) => { await p.page.evaluate(() => window.TownDock.close()); await until(async () => !(await dockState(p.page))?.open, 5000, `${p.label} 面板收起`, 50); };
    const hit = (r1, r2) => !!r1 && !!r2 && r1.width > 0 && r2.width > 0 && r1.left < r2.right - 0.5 && r2.left < r1.right - 0.5 && r1.top < r2.bottom - 0.5 && r2.top < r1.bottom - 0.5;
    try {
      // 一、确认条开着时局被动结束（lifecycle#0）：结果卡之后开下一局，「离开这局」按钮必须在
      await feed(A, 'state', fake(2, { yourTurn: false }));
      await until(async () => (await gameMod(A.page)).mode === 'game', 5000, 'A 面板出现', 50);
      await feed(A, 'confirm', null);
      await until(async () => (await gameMod(A.page)).confirmOpen, 5000, '确认条出现', 50);
      check(await A.page.evaluate(() => document.querySelector('#gamePanel [data-role="leave"]').hidden), '确认条开着时「离开这局」按钮收起');
      await feed(A, 'state', { mode: 'result', kind: 'lost', name: '数字炸弹', reason: '对手退出，这一局中止', reward: 0, players: [] });
      await until(async () => (await gameMod(A.page)).mode === 'result', 5000, '结果卡出现', 50);
      await feed(A, 'state', fake(2, { gameId: 'fake-game-2', yourTurn: false }));
      await until(async () => (await gameMod(A.page)).mode === 'game', 5000, '下一局面板出现', 50);
      const lv = await A.page.evaluate(() => { const e = document.querySelector('#gamePanel [data-role="leave"]'); const r = e.getBoundingClientRect(); return { hidden: e.hidden, w: r.width, h: r.height, confirm: !document.querySelector('#gamePanel [data-role="confirm"]').hidden }; });
      check(!lv.hidden && lv.w > 0 && lv.h >= 30 && !lv.confirm, `确认条开着时局结束之后，下一局的「离开这局」按钮应回来、确认条应收起：${JSON.stringify(lv)}`);
      await reset(A);

      // 二、桌面：焦点停在画布上时轮到自己，输入框仍自动聚焦（focus#2）
      await A.page.evaluate(() => document.getElementById('canvas').focus());
      check(await A.page.evaluate(() => document.activeElement?.id === 'canvas'), '先把焦点放在画布上');
      await feed(A, 'state', fake(2, { yourTurn: true, gameId: 'fake-game-3' }));
      await until(async () => (await gameMod(A.page)).focused, 5000, '焦点在画布上时轮到自己：输入框应自动聚焦', 50);
      // 点过按钮（焦点留在按钮上）之后下一轮同样聚焦
      await feed(A, 'state', fake(2, { yourTurn: false, gameId: 'fake-game-3', phaseId: 8 }));
      await A.page.evaluate(() => document.querySelector('#gamePanel [data-role="mid"]').focus());
      await feed(A, 'state', fake(2, { yourTurn: true, gameId: 'fake-game-3', phaseId: 9 }));
      await until(async () => (await gameMod(A.page)).focused, 5000, '焦点在按钮上时下一轮轮到自己：输入框应自动聚焦', 50);
      await reset(A);

      // 三、触屏接了实体键盘：数字、退格能输入（输入框只读、不弹系统键盘）；Enter 在 51 里随真实的一局测
      await feed(B, 'state', fake(2, { yourTurn: true, gameId: 'fake-game-4' }));
      await until(async () => (await gameMod(B.page)).mode === 'game' && (await gameMod(B.page)).yourTurn, 5000, 'B 面板出现且轮到自己', 50);
      const mb = await gameMod(B.page);
      check(mb.coarse === true && mb.inputReadonly === true && mb.focused === true, `触屏：输入框只读且已聚焦（焦点在输入框上，全局 Enter 才不会去开聊天）：${JSON.stringify({ c: mb.coarse, r: mb.inputReadonly, f: mb.focused })}`);
      await B.page.keyboard.press('Digit4');
      await B.page.keyboard.press('Digit2');
      await until(async () => (await gameMod(B.page)).input === '42', 5000, '实体键盘的数字进了输入框', 50);
      await B.page.keyboard.press('Backspace');
      await until(async () => (await gameMod(B.page)).input === '4', 5000, '退格删掉一位', 50);
      check(!(await dockState(B.page))?.open, '触屏局中敲数字不应打开聊天面板');
      await reset(B);

      // 四、横屏矮屏、右侧栏打开、8 个玩家 + 满格历史：面板不盖侧栏，不盖顶栏，整个在视口里
      const orig = B.page.viewportSize();
      for (const [vw, vh] of [[667, 375], [844, 390]]) {
        await B.page.setViewportSize({ width: vw, height: vh });
        await frames(B.page, 3);
        await openDock(B.page);
        await feed(B, 'state', fake(8, { yourTurn: true, gameId: `fake-game-5-${vw}` }));
        await until(async () => (await gameMod(B.page)).mode === 'game', 5000, `${vw}x${vh} 面板出现`, 50);
        await frames(B.page, 3);
        const lay = await B.page.evaluate(() => document.body.getAttribute('data-dock'));
        const pr = (await gameMod(B.page)).rect;
        const dr = await rectOf(B.page, '#dock');
        const tr = await rectOf(B.page, '#topbar');
        const what = `横屏矮屏 ${vw}x${vh}（布局 ${lay}）`;
        check(lay === 'side', `${what}：应是右侧栏布局`);
        check(!hit(pr, dr), `${what}：面板不应盖住右侧栏：${JSON.stringify({ panel: pr, dock: dr })}`);
        check(!hit(pr, tr), `${what}：面板不应盖住顶栏：${JSON.stringify({ panel: pr, top: tr })}`);
        check(pr.left >= -1 && pr.right <= vw + 1 && pr.top >= -1 && pr.bottom <= vh + 1, `${what}：面板整个在视口里：${JSON.stringify(pr)}`);
        const ib = await rectOf(B.page, '#gamePanel [data-role="input"]');
        check(ib && ib.top >= pr.top - 1 && ib.bottom <= pr.bottom + 1 && ib.bottom <= vh + 1, `${what}：输入框可见：${JSON.stringify({ ib, pr })}`);
        const ks = await B.page.evaluate(() => [...document.querySelectorAll('#gamePanel [data-key]')].map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }));
        const pnl = await B.page.evaluate(() => { const r = document.querySelector('#gamePanel').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
        const badK = ks.filter((k) => !(k.width >= 44 && k.height >= 44 && k.top >= pnl.top - 1 && k.bottom <= pnl.bottom + 1));
        check(ks.length === 12 && badK.length === 0, `${what}：12 个数字键都应在面板里（不被挤到折叠线下）且不小于 44 像素：不合格 ${JSON.stringify(badK)}，面板 ${JSON.stringify(pnl)}`);
        await reset(B);
        await shutDock(B);
      }

      // 五、手机竖屏：抽屉打开时面板让到抽屉之上；软键盘出现时输入区在键盘之上
      await B.page.setViewportSize(orig);
      await frames(B.page, 3);
      await openDock(B.page);
      await feed(B, 'state', fake(4, { yourTurn: true, gameId: 'fake-game-6' }));
      await until(async () => (await gameMod(B.page)).mode === 'game', 5000, '手机面板出现', 50);
      await frames(B.page, 3);
      const pr2 = (await gameMod(B.page)).rect;
      const dr2 = await rectOf(B.page, '#dock');
      check(dr2 && dr2.height > 0 && pr2.bottom <= dr2.top + 1, `手机抽屉打开时面板下沿不应低于抽屉上沿：${JSON.stringify({ panel: pr2, dock: dr2 })}`);
      await shutDock(B);
      await B.page.evaluate(() => window.TownDock.test.setKeyboard(300));
      await until(async () => (await B.page.evaluate(() => document.body.getAttribute('data-kb'))) === '1', 5000, '软键盘状态生效', 50);
      await frames(B.page, 3);
      const ib2 = await rectOf(B.page, '#gamePanel [data-role="input"]');
      const vh2 = orig.height;
      check(ib2 && ib2.bottom <= vh2 - 300 + 1 && ib2.top >= 0, `软键盘（300 像素）出现时输入框应在键盘之上、视口之内：${JSON.stringify({ ib2, vh2 })}`);
      await B.page.evaluate(() => window.TownDock.test.setKeyboard(null));
      await until(async () => (await B.page.evaluate(() => document.body.getAttribute('data-kb'))) !== '1', 5000, '软键盘状态撤掉', 50);
      await reset(B);
    } finally {
      for (const p of [A, B]) await feed(p, 'reset', null).catch(() => {});
      await B.page.evaluate(() => window.TownDock.test.setKeyboard(null)).catch(() => {});
      await shutDock(B).catch(() => {});
      if (B.page.viewportSize().width !== 390) await B.page.setViewportSize({ width: 390, height: 844 }).catch(() => {});
    }
  });

  // ───────────────────────── 50.1 点桌子走到不同的落脚点 ─────────────────────────
  await step(50.1, '点桌子：A 用鼠标点桌一、B 用手指点桌一，各走到自己的落脚点（都在桌心 2 米内），两人落脚点相距 1 米以上；走到后出现开一局按钮、还没人开桌所以没有桌牌', async () => {
    // 50 步里 A 用 E 键走到了某一张桌边（两张同样远，选哪张不论）。
    // 若正好是桌一：A 已站在落脚点上，点桌子应被 on_pick 吞掉、什么都不发（带屏障：等同一时刻 B 的点击发出导航之后再核）；
    // 若是桌二：A 点桌一应发出导航走过来。
    const ncA = count(A, 'navigate');
    const seated = (await seatDist(A, T1)) <= 2.0;
    const w0A = (await gg(A)).walks;
    await clickObject(A, T1);
    if (seated) {
      await frames(A.page, 8); // 屏障：旧逻辑会在点击的同一帧发 navigate
      check(count(A, 'navigate') === ncA && (await gg(A)).walks === w0A, `A 已站在桌一边，点桌一不应再走：navigate ${ncA} -> ${count(A, 'navigate')}`);
    } else {
      await until(async () => count(A, 'navigate') > ncA, 15_000, 'A 的点击发出导航');
      await waitIdle(A);
    }
    const sa = await sceneOf(A);
    check((await seatDist(A, T1)) <= 2.0, `A 离桌一桌心应不超过 2 米：${await seatDist(A, T1)}`);
    await clickObject(B, T1);
    await waitIdle(B);
    const sb = await sceneOf(B);
    check((await seatDist(B, T1)) <= 2.0, `B 离桌一桌心应不超过 2 米：${await seatDist(B, T1)}`);
    const gap = dist(sa, sb);
    check(gap > 1.0, `A、B 的落脚点应相距 1 米以上：${gap.toFixed(2)}`);
    for (const p of [A, B]) {
      await until(async () => (await snap(p.page)).nearValid === true, 20_000, `${p.label} 够得着状态有效`);
      await waitBtn(p, `f:game:propose:${T1}`);
      // 桌牌只在有人凑桌之后才有（50.2 检查「等人 1/2」）；还没有人开桌时桌上没有牌
      check((await tableTags(p.page)).length === 0, `${p.label} 还没人开桌时不应有桌牌：${JSON.stringify(await tableTags(p.page))}`);
    }
    const bb = await btn(A, `f:game:propose:${T1}`);
    check(bb.label === '开一局：数字炸弹', `按钮文字：${bb.label}`);
    note(`A 站 (${sa.x.toFixed(2)},${sa.z.toFixed(2)})，B 站 (${sb.x.toFixed(2)},${sb.z.toFixed(2)})，相距 ${gap.toFixed(2)} 米；A 的落脚点记录 ${JSON.stringify((await gg(A)).lastSeat)}`);
    await shot(A.page, '50-desktop-table');
    // C（只走 API）先走到桌一边上等着：之后开桌有保留时间，不能到时候才走
    C = await apiResident(h.browsers[0], BASE, `阿丙${h.rnd()}`);
    await C.walk('arcade');
    await C.walk(T1);
    check(dist(C.selfOf(await C.scene()), await objOf(A, T1)) <= 2.0, 'C 站在桌一边上');
  });

  // ───────────────────────── 50.15 离桌太远 ─────────────────────────
  await step(50.15, '离桌太远：A 直接对桌二发开一局 -> 服务器 too_far，页面只自动走过去、不重发动作、没有开出桌；回来站到桌一', async () => {
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '50.15：离桌二很远时 propose_game 必定 too_far（422）' });
    const prop0 = count(A, 'propose_game');
    const walks0 = (await gg(A)).walks;
    const nav0 = count(A, 'navigate');
    await A.page.evaluate((id) => window.TownHost.emit('ui', 'act', id), `f:game:propose:${T2}`);
    await until(async () => count(A, 'propose_game') > prop0, 15_000, '发出了 propose_game');
    const rec = await until(() => { const r = actionsOf(A, 'propose_game').at(-1); return r && 'reason' in r ? r : null; }, 10_000, '读完回应', 100);
    check(rec.reason === 'too_far', `应是 too_far：${JSON.stringify(rec)}`);
    await until(async () => count(A, 'navigate') > nav0, 15_000, '页面自己走向桌二');
    await waitIdle(A);
    check(count(A, 'propose_game') === prop0 + 1, `不重发 propose_game：${prop0} -> ${count(A, 'propose_game')}`);
    const me = await serverMe(A);
    check(!(me.here?.activities ?? []).length, `没有开出任何桌：${JSON.stringify(me.here?.activities)}`);
    check((await gg(A)).walks > walks0, 'walks 加一');
    // 回到桌一
    const w1 = (await gg(A)).walks;
    await clickObject(A, T1);
    await until(async () => (await gg(A)).walks > w1, 10_000, '点桌一后开始走（walks 加一）');
    await until(async () => (await sceneOf(A)).nav, 10_000, 'A 在服务器上开始走', 150).catch(() => null);
    await waitIdle(A);
    check((await seatDist(A, T1)) <= 2.0, `A 回到桌一：${await seatDist(A, T1)}`);
    await until(async () => (await snap(A.page)).nearValid === true && (await btn(A, `f:game:propose:${T1}`)), 25_000, 'A 回到桌一后又有开一局按钮', 200);
  });

  // ───────────────────────── 50.2 开一局 ─────────────────────────
  await step(50.2, '开一局：A 点「开一局」成功；桌牌变成「等人 1/8（至少 2 人）」（数字炸弹最多 8 人）（两边都看到）；B 面前是「加入」；B 对同一张桌用接口开局被拒 table_busy', async () => {
    const nameA = await nameOf(A, A.id);
    await click(A, `f:game:propose:${T1}`);
    await until(async () => (await lobbyId(A)) !== '', 20_000, 'A 在桌里');
    for (const p of [A, B]) {
      await withScene(p, () => until(async () => (await tableTags(p.page)).find((t) => t.id === `g:${T1}` && /等人 1\/\d+/.test(t.text)) ?? null, 20_000, `${p.label} 桌牌「等人 1/N」`, 200));
    }
    const jb = await waitBtn(B, 'f:game:join:');
    check(jb.label === '加入' && /1\/\d+/.test(jb.sub), `B 的按钮：${JSON.stringify(jb)}`);
    check(!(await btn(A, 'f:game:propose:')) && (await btn(A, 'f:game:start:')) && (await btn(A, 'f:game:leave')), `A 应有「开始」「散桌」、没有开一局：${JSON.stringify(await gameButtons(A.page))}`);
    const r = await apiAct(B, { type: 'propose_game', game: 'number_bomb', objectId: T1 });
    check(r.status === 422 && (r.body?.reason === 'table_busy' || r.body?.reason === 'already_in_activity'), `B 在占着的桌上开局应被拒：${r.status} ${JSON.stringify(r.body)}`);
    note(`A=${nameA} 开了桌；B 对同桌 propose_game：${r.status} ${r.body?.reason}`);
  });

  // ───────────────────────── 50.3 加入、离开、再加入 ─────────────────────────
  await step(50.3, '加入与离开：B 点「加入」，A 看到「X 加入了这一桌」提示、桌牌 2 人；B 点「离开这桌」，A 看到离开提示、桌牌回到 1 人；B 再加入', async () => {
    const nameB = await nameOf(A, B.id);
    await ensureTable(false);
    await click(B, (await waitBtn(B, 'f:game:join:')).id);
    await withScene(A, () => toastHas(A, `${nameB} 加入了这一桌`));
    await until(async () => (await tableTags(A.page)).find((t) => t.id === `g:${T1}` && /等人 2\/\d+/.test(t.text)) ?? null, 15_000, 'A 桌牌 2/2', 200);
    check(!!(await btn(B, 'f:game:leave')) && !(await btn(B, 'f:game:start:')), `B 应有「离开这桌」、没有「开始」：${JSON.stringify(await gameButtons(B.page))}`);
    await click(B, 'f:game:leave');
    await toastHas(A, `${nameB} 离开了这一桌`);
    await until(async () => (await tableTags(A.page)).find((t) => t.id === `g:${T1}` && /等人 1\/\d+/.test(t.text)) ?? null, 15_000, 'A 桌牌回到 1/2', 200);
    await click(B, (await waitBtn(B, 'f:game:join:')).id);
    await until(async () => (await tableTags(A.page)).find((t) => t.id === `g:${T1}` && /等人 2\/\d+/.test(t.text)) ?? null, 15_000, 'A 桌牌又 2/2', 200);
    await shot(A.page, '50-desktop-lobby');
  });

  // ───────────────────────── 50.4 人没到齐、桌边的人才入局 ─────────────────────────
  await step(50.4, '开始：B 走开后 A 点「开始」被拒 not_enough（名册不变）；C 走来加入后再开始成功，B 因为不在桌边被丢出（提示「开局的时候你不在桌边」），A 和 C 入局，面板出现、body 上有 data-game', async () => {
    // 桌从开桌起固定计时（activityLobbyTtlMs，端到端里 25 秒，加入不续期），而这一步要走路、等事件、点两次开始，软件渲染下可能超过剩余的时间：
    // 每一轮先保证桌里有 A、B 且离散桌还有足够久（不够就散掉重开），关键点击之前再看一眼剩余；中途散掉就整轮重来（最多 3 轮）。
    const leftMs = async () => {
      const a = ((await serverMe(A)).here?.activities ?? []).find((x) => x.status === 'forming');
      return a ? a.lobbyExpiresAt - Date.now() : -1;
    };
    const freshTable = async (need) => {
      if ((await lobbyId(A)) && (await lobbyId(B)) && (await leftMs()) >= need && (await seatDist(B, T1)) <= 2.0) return;
      note('桌的剩余保留时间不够（或已散掉），重开一桌');
      await apiAct(A, { type: 'leave_game_lobby' }); // 发起人离开：整桌取消（API 代发，不声明）
      await C.act({ type: 'leave_game_lobby' }); // C 若在桌里也随之离开（不在桌里得 not_in_lobby，不用管）
      await until(async () => !(await lobbyId(A)) && !(await lobbyId(B)), 20_000, 'A、B 都不在桌里了', 200);
      if ((await seatDist(B, T1)) > 2.0) {
        check((await apiAct(B, { type: 'navigate', to: T1 })).status === 200, 'B 走回桌一');
        await waitIdle(B);
      }
      for (const p of [A, B]) await until(async () => (await snap(p.page)).nearValid === true && (await btn(p, `f:game:propose:${T1}`)), 25_000, `${p.label} 回到桌边、有开一局按钮`, 200);
      await click(A, `f:game:propose:${T1}`);
      await until(async () => (await lobbyId(A)) !== '', 20_000, 'A 重新开了桌');
      await click(B, (await waitBtn(B, 'f:game:join:')).id);
      await until(async () => (await lobbyId(B)) !== '', 20_000, 'B 重新加入');
    };
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 3, why: '50.4：只有一个人在桌边时 start_game 必定 not_enough（422）；桌中途散掉要整轮重来时最多再多两次' });
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt++) {
      await freshTable(attempt === 0 ? 18_000 : 20_000);
      const aid = await lobbyId(A);
      // B 走开
      const rb = await apiAct(B, { type: 'navigate', to: T2 });
      check(rb.status === 200, `B 走向桌二：${rb.status}`);
      await waitIdle(B);
      check((await seatDist(B, T1)) > 3, `B 应已离桌一很远：${await seatDist(B, T1)}`);
      await until(async () => (await btn(A, 'f:game:start:'))?.sub?.includes('在桌边 1') ?? false, 20_000, 'A 的「开始」写着在桌边 1', 200);
      if ((await leftMs()) < 3000) { note('走开之后桌快散了，整轮重来'); continue; }
      const s0 = count(A, 'start_game');
      await click(A, (await btn(A, 'f:game:start:')).id);
      await until(() => { const r = actionsOf(A, 'start_game').at(-1); return actionsOf(A, 'start_game').length > s0 && r && 'reason' in r ? r : null; }, 15_000, 'start_game 回应读完', 100).then((r) => check(r.reason === 'not_enough' || r.reason === 'not_open', `应是 not_enough（桌恰好散掉才会是 not_open）：${JSON.stringify(r)}`));
      if (actionsOf(A, 'start_game').at(-1).reason === 'not_open') { note('点开始的当口桌散了，整轮重来'); continue; }
      check((await lobbyId(A)) === aid && !(await gg(A)).inGame, '名册不变、没有开局');
      // C 加入后开始
      const jr = await C.act({ type: 'join_game', activityId: aid });
      if (jr.status !== 200 && (await lobbyId(A)) === '') { note('C 加入的当口桌散了，整轮重来'); continue; }
      check(jr.status === 200, `C 加入：${jr.status} ${JSON.stringify(jr.body)}`);
      // B 在桌里但不在桌边：开始时被丢出（B 是 2 人以上里不在桌边的）
      await until(async () => (await btn(A, 'f:game:start:'))?.sub?.includes('在桌边 2') ?? false, 20_000, 'A 的「开始」写着在桌边 2', 200);
      if ((await leftMs()) < 3000) { note('C 加入之后桌快散了，整轮重来'); continue; }
      await click(A, (await btn(A, 'f:game:start:')).id);
      started = true;
    }
    check(started, '三轮都没能在桌的保留时间内开出局');
    const nameB = await nameOf(A, B.id);
    await until(async () => (await gg(A)).inGame, 30_000, 'A 入局');
    await until(async () => (await gameMod(A.page)).mode === 'game' && (await gameMod(A.page)).bodyFlag === '1', 30_000, 'A 的面板出现、body[data-game]=1');
    await until(async () => (await gg(B)).droppedToasts >= 1, 20_000, 'B 收到被丢出的提示');
    await toastHas(B, DROPPED);
    check(!(await gg(B)).inGame && !(await gameMod(B.page)).shown, 'B 没有入局、没有面板');
    const me = await serverMe(A);
    check(me.game && me.game.public?.mode === 'single', `服务器：A 在局里：${JSON.stringify(me.game?.public?.mode)}`);
    const d = await gameMod(A.page);
    check(d.players.length === 2, `面板上应有 2 个玩家：${JSON.stringify(d.players)}`);
    note(`B=${nameB} 被丢出；A 面板：轮到「${d.turnText}」，范围 ${JSON.stringify(d.range)}`);
  });

  // ───────────────────────── 50.45 局中封锁 ─────────────────────────
  await step(50.45, '局中封锁：点地没有导航、出提示；按 WASD 没有方向帧；附近聊天不能发（reason=game，接口发言被拒）；底部动作条、停下、回家、目的地按钮藏起来', async () => {
    check((await gg(A)).blocks === BLOCK, `blocks 文字：${(await gg(A)).blocks}`);
    const nav0 = count(A, 'navigate');
    const s0 = await sceneOf(A);
    await clickWorld(A, s0.x + 3, s0.z - 2, { avoidDock: false }).catch(() => {});
    await toastHas(A, '对局中');
    await frames(A.page, 5);
    check(count(A, 'navigate') === nav0, `局中点地不应发 navigate：${nav0} -> ${count(A, 'navigate')}`);
    // 注意：main._tick_dir 在「在共同活动 / 小游戏里」时先于 blocks_input 就返回（ctx_activity 非空），所以这一条验证的是「局中不发方向帧」这个结果，
    // 靠的是 ctx_activity 而不是 game.gd 的 blocks_input；blocks_input 的反向验证只对上面「点地」那条有效。按键之前先让输入框失焦，免得按键被输入框接走而没测到。
    await A.page.evaluate(() => document.activeElement?.blur?.());
    const f0 = A.gate.dirFrames.length;
    await A.page.keyboard.down('KeyD');
    await sleep(800);
    await A.page.keyboard.up('KeyD');
    await frames(A.page, 5);
    check(A.gate.dirFrames.length === f0, `局中按 WASD 不应发方向帧：${f0} -> ${A.gate.dirFrames.length}`);
    await until(async () => (await godotFeature(A.page, 'nearby'))?.reason === 'game', 15_000, '附近聊天的原因是 game', 200);
    const sr = await apiSay(A, '局中不该说得出去');
    check(sr.status === 422, `局中接口发言应被拒：${sr.status} ${JSON.stringify(sr.body)}`);
    for (const id of ['actions', 'stopBtn', 'homeBtn', 'destBtn']) {
      const vis = await A.page.evaluate((i) => { const e = document.getElementById(i); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0; }, id);
      check(!vis, `局中 #${id} 应藏起来`);
    }
    const s1 = await sceneOf(A);
    check(dist(s0, s1) < 0.3, `局中 A 没有动：${dist(s0, s1).toFixed(2)}`);
    // 全镇公屏：局中只看不发（C1b 把这条留给本段）。服务端 chat.ts：正在一局里 -> 422 precondition in_activity；页面一侧 town.gd 的 reason 是 game
    await openTown(A.page);
    const ts = await until(async () => { const t = await modState(A.page, 'town'); return t?.st && t.st.reason === 'game' ? t : null; }, 15_000, '全镇页签的状态变成「对局中不能发」', 200);
    check(ts.st.canSend === false, `局中全镇页签 canSend 应为 false：${JSON.stringify(ts.st)}`);
    const tc = await townCompose(A.page);
    check(tc.disabled === true && tc.sendDisabled === true, `局中全镇页签的输入框和发送键应禁用：${JSON.stringify(tc)}`);
    const tr = await apiTownSay(A, '局中公屏不该发得出去');
    check(tr.status === 422 && tr.body?.reason === 'in_activity', `局中接口发公屏应被拒（422 in_activity）：${tr.status} ${JSON.stringify(tr.body)}`);
    // 公屏仍可读：B 被丢出了、不在局里，B 说一句，局中的 A 的全镇页签应看到（等到它出现就是屏障，先加后续）
    const readMark = `场外的话${h.rnd()}`;
    const rb = await apiTownSayWait(B, readMark);
    check(rb.status === 200, `B（不在局里）发公屏：${rb.status} ${JSON.stringify(rb.body)}`);
    await until(async () => (await townRows(A.page)).some((r) => r.text === readMark), 25_000, '局中的 A 在全镇页签里读到 B 的话', 300);
    await closeDock(A.page);
  });

  // ───────────────────────── 50.5 局中输入规则 ─────────────────────────
  await step(50.5, '局中输入：越界与非数字被本地拒绝（不发 game_act）；强发非自己回合 -> 422 game_not_your_turn；强发旧阶段 -> 409 phase_stale 且面板刷新；通过确认框退出 -> 不弹结果卡；C 退出后局中止', async () => {
    const forced = (p, number, phaseId) => p.page.evaluate(([n, ph]) => window.TownDock.test.game.forceGuess(n, ph), [number, phaseId]);
    const ackN = async (p) => (await gg(p)).lastAck?.n ?? 0;
    // 先让轮到 A（C 的回合由 C 猜中点）
    const wait = async () => {
      for (let i = 0; i < 12; i++) {
        const m = await C.me();
        if (m?.game?.your_turn) {
          const rg = m.game.public.range;
          // 猜范围的最小值而不是中点：炸弹在范围里均匀随机，每一手踩中的概率都是 1/范围，但中点会让范围迅速收窄、之后几手越来越容易踩中，这一步要连打好几手
          await C.act({ type: 'game_act', gameId: m.game.game_id, phaseId: m.game.phase_id, input: { action: 'guess', number: rg.from } });
        }
        const d = await gameMod(A.page);
        if (d.yourTurn) return d;
        await sleep(500);
      }
      throw new Error('一直没轮到 A');
    };
    const d0 = await wait();
    const g0 = count(A, 'game_act');
    // 本地拒绝：非数字、越界
    // 桌面输入框会把非数字字符滤掉（'12ab' 会变成 '12'），所以「非数字」只剩空：提交空框要被拒
    await A.page.fill('#gamePanel [data-role="input"]', '');
    await A.page.press('#gamePanel [data-role="input"]', 'Enter');
    await until(async () => (await gameMod(A.page)).hintKind === 'err', 5_000, '非数字的提示', 100);
    await A.page.fill('#gamePanel [data-role="input"]', String(d0.range.to + 50));
    await A.page.press('#gamePanel [data-role="input"]', 'Enter');
    await until(async () => (await gameMod(A.page)).hintKind === 'err' && (await gameMod(A.page)).hint.includes('只能猜'), 5_000, '越界的提示', 100);
    // 越界强发：Godot 一侧也拦
    const n1 = await ackN(A);
    await forced(A, d0.range.to + 50, undefined);
    await until(async () => (await ackN(A)) > n1, 10_000, '强发越界得到回应');
    check((await gg(A)).lastAck.code === 'range', `强发越界应在 Godot 一侧被拒：${JSON.stringify((await gg(A)).lastAck)}`);
    await frames(A.page, 5);
    check(count(A, 'game_act') === g0, `本地拒绝的猜数不发 game_act：${g0} -> ${count(A, 'game_act')}`);
    // 旧阶段号：409 phase_stale
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '50.5：旧阶段号的猜数必定 phase_stale（409）' });
    const n2 = await ackN(A);
    const sv = (await serverMe(A)).game;
    await forced(A, midOf(d0.range), sv.phase_id - 1);
    await until(async () => (await ackN(A)) > n2, 15_000, '旧阶段号得到回应');
    check((await gg(A)).lastAck.code === 'phase_stale', `应是 phase_stale：${JSON.stringify((await gg(A)).lastAck)}`);
    await until(async () => (await gg(A)).pulls >= 1, 10_000, '刷新了 /game', 200);
    // 非自己回合：让 C 先猜一次，轮到 C 时 A 强发 -> 422 game_not_your_turn
    await takeTurn(A, (await gameMod(A.page)).range.from); // 范围最小值：不容易踩中炸弹
    await until(async () => !(await gameMod(A.page)).yourTurn, 15_000, '猜完后不再轮到 A', 150);
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '50.5：不是自己的回合强发猜数必定 game_not_your_turn（422）' });
    const n3 = await ackN(A);
    await forced(A, midOf((await gameMod(A.page)).range), undefined);
    await until(async () => (await ackN(A)) > n3, 15_000, '非自己回合得到回应');
    check((await gg(A)).lastAck.code === 'game_not_your_turn' || (await gg(A)).lastAck.reason === 'game_not_your_turn', `应是 game_not_your_turn：${JSON.stringify((await gg(A)).lastAck)}`);
    // 退出的当口若有一次 GET /game 在路上，局一结束它就是 409 context_stale（正常的竞态，次数不定）
    allowFailure(A.w, 'GET', /\/town\/api\/game(\?.*)?$/, { min: 0, max: 3, why: '50.5：退出时在途的 /game 读取可能得到 409 context_stale' });
    // 通过确认框退出：不弹结果卡
    await A.page.click('#gamePanel [data-role="leave"]');
    await until(async () => (await gameMod(A.page)).confirmOpen, 5_000, '确认框出现', 100);
    await A.page.click('#gamePanel [data-role="leaveYes"]');
    await until(async () => !(await gg(A)).inGame, 20_000, 'A 离开了局');
    await until(async () => (await gameMod(A.page)).mode === 'none' && !(await gameMod(A.page)).shown, 10_000, 'A 的面板收起');
    // C 也退出 -> 局中止；A 不弹结果卡
    await C.act({ type: 'quit_game' });
    await until(async () => !(await C.me())?.game, 20_000, 'C 不在局里');
    await sleep(2500);
    check((await gameMod(A.page)).mode === 'none' && !(await gameMod(A.page)).shown && (await gameMod(A.page)).bodyFlag === null, 'A 已主动退出：局结束后不应弹结果卡');
    check((await gg(A)).resultKind === '', `A 的结果记录应为空：${(await gg(A)).resultKind}`);
  });

  // ───────────────────────── 51 一整局 ─────────────────────────
  await step(51, '一整局（桌二）：A 键盘 vs B 手机屏幕数字键；两边范围与历史一致；结果卡有且只有一个踩中的人，原因与 /public/game 对得上；关卡后恢复底部条、WASD 能走、附近聊天可发；手机版式达标', async () => {
    // 桌二在 9 米外、不在画面里：两人用接口走到桌二（点桌子的入口在 50.1 测过）
    for (const p of [A, B]) {
      check((await apiAct(p, { type: 'navigate', to: T2 })).status === 200, `${p.label} 走向桌二`);
      await waitIdle(p);
    }
    for (const p of [A, B]) await until(async () => (await snap(p.page)).nearValid === true && (await btn(p, `f:game:propose:${T2}`)), 25_000, `${p.label} 在桌二边有开一局按钮`, 200);
    // C 走到桌二边（不入局），局中说一句附近的话：局中的 A 听不到；局后 C 再说一句，A 听到它就是屏障
    await C.walk(T2);
    // 最后一手之后：「game」事件触发的 /game 读取可能和局结束撞上，得到 409 context_stale（正常的竞态，次数不定）；最多重打 3 局
    for (const p of [A, B]) allowFailure(p.w, 'GET', /\/town\/api\/game(\?.*)?$/, { min: 0, max: 9, why: '51：局结束与在途的 /game 读取撞上' });
    let aid51, heardMark, turns;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) await waitBtn(A, `f:game:propose:${T2}`);
      await click(A, `f:game:propose:${T2}`);
      await until(async () => (await lobbyId(A)) !== '', 20_000, 'A 开了桌二');
      await click(B, (await waitBtn(B, 'f:game:join:')).id);
      await until(async () => (await btn(A, 'f:game:start:'))?.sub?.includes('在桌边 2') ?? false, 20_000, '两人都在桌边', 200);
      await click(A, (await btn(A, 'f:game:start:')).id);
      for (const p of [A, B]) await until(async () => (await gameMod(p.page)).mode === 'game' && (await gameMod(p.page)).bodyFlag === '1', 30_000, `${p.label} 面板出现`);
      if (attempt === 0) await shot(B.page, '51-mobile-game');
      aid51 = (await gg(A)).activityId;
      check(!!aid51, '局中应有活动号');
      if (attempt === 0) {
        // 手机版式
        const mb = await gameMod(B.page);
        check(mb.rect.top >= 480, `手机上面板上沿应在 480 以下（不盖满屏）：${mb.rect.top}`);
        const dockBtn = await rectOf(B.page, '#dockBtn');
        if (dockBtn && dockBtn.width > 0) check(!(mb.rect.left < dockBtn.right && dockBtn.left < mb.rect.right && mb.rect.top < dockBtn.bottom && dockBtn.top < mb.rect.bottom), `面板不盖「面板」按钮：${JSON.stringify({ r: mb.rect, d: dockBtn })}`);
        const keys = await B.page.evaluate(() => [...document.querySelectorAll('#gamePanel [data-key]')].map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; }));
        check(keys.length === 12 && keys.every((k) => k.w >= 44 && k.h >= 44), `数字键应有 12 个、都不小于 44 像素：${JSON.stringify(keys.slice(0, 3))}`);
        check(await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '手机没有横向溢出');
        check((await gameMod(B.page)).coarse === true && (await gameMod(B.page)).inputReadonly === true, '手机输入框只读（屏幕数字键）');
        await shot(A.page, '50-desktop-game');
        heardMark = `局中的话${h.rnd()}`;
        const cs = await C.act({ type: 'say_nearby', text: heardMark });
        check(cs.status === 200, `C（不在局里）说话：${cs.status} ${JSON.stringify(cs.body)}`);
        // 中途刷新 A：由 /me.game 恢复面板
        A.w.closing = true;
        await A.page.goto(`${BASE}/town/3d/?debug=1`);
        await A.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
        A.w.closing = false;
        await A.page.click('#enterBtn');
        await A.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
        await until(async () => (await gameMod(A.page)).mode === 'game' && (await gameMod(A.page)).bodyFlag === '1', 30_000, 'A 刷新后面板恢复、body[data-game]=1');
        await until(async () => (await gg(A)).blocks === BLOCK, 10_000, 'A 刷新后局中封锁恢复', 200);
        check((await gameMod(A.page)).players.length === 2, 'A 刷新后面板上有 2 个玩家');
        await until(async () => JSON.stringify((await gameMod(A.page)).range) === JSON.stringify((await gameMod(B.page)).range), 20_000, 'A 刷新后范围与 B 一致', 300);
        // 手机补充版式：360 宽、横屏矮屏（面板在视口里、输入区可见、没有横向溢出），看完恢复 390x844
        const fits = (r, vw, vh) => !!r && r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1;
        for (const [vw, vh, what] of [[360, 740, '360 宽'], [844, 390, '横屏矮屏']]) {
          await B.page.setViewportSize({ width: vw, height: vh });
          await frames(B.page, 4);
          const mm = await gameMod(B.page);
          check(fits(mm.rect, vw, vh), `${what}：面板应整个在视口里：${JSON.stringify(mm.rect)}`);
          check(await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what}：没有横向溢出`);
          const ib = await rectOf(B.page, '#gamePanel [data-role="input"]');
          check(fits(ib, vw, vh), `${what}：输入框应在视口里：${JSON.stringify(ib)}`);
          // 12 个键逐个看：都在视口里、都不小于 44 像素（只看中间一个键的话，最后一排被挤出视口也发现不了）
          const pks = await B.page.evaluate(() => [...document.querySelectorAll('#gamePanel [data-key]')].map((e) => { const r = e.getBoundingClientRect(); return { key: e.dataset.key, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }));
          const badKeys = pks.filter((k) => !fits(k, vw, vh) || k.width < 44 || k.height < 44);
          check(pks.length === 12 && badKeys.length === 0, `${what}：12 个数字键都应在视口里且不小于 44 像素：共 ${pks.length} 个，不合格的 ${JSON.stringify(badKeys.slice(0, 3))}`);
        }
        await B.page.setViewportSize({ width: 390, height: 844 });
        await frames(B.page, 4);
        // 点面板不发导航
        const nb = count(B, 'navigate');
        await B.page.click('#gamePanel [data-role="range"]').catch(() => {});
        await frames(B.page, 3);
        check(count(B, 'navigate') === nb, '点面板不发导航');
        // 最后一手之后：「game」事件触发的 /game 读取可能和局结束撞上，得到 409 context_stale（正常的竞态，次数不定）
      }
      // 打到结束
      const t0 = Date.now();
      turns = { A: 0, B: 0 };
      const stateOf = async (p) => { const d = await gameMod(p.page); return JSON.stringify({ r: d.range, h: d.history.map((x) => [x.seat, x.guess, x.res]) }); };
      let dbl = false;
      let cut = false;
      let kbB = false;
      for (;;) {
        if (Date.now() - t0 > 240_000) throw new Error('一局 4 分钟还没打完');
        const [ra, rb] = await Promise.all([gameMod(A.page), gameMod(B.page)]);
        if (ra.mode === 'result' && rb.mode === 'result') break;
        for (const [p, d, k] of [[A, ra, 'A'], [B, rb, 'B']]) {
          if (d.mode === 'game' && d.yourTurn && !d.busy) {
            if (k === 'A' && !dbl) {
              // 双击提交（连按两下 Enter）只发一次 game_act
              dbl = true;
              const g0 = count(A, 'game_act');
              const n0 = (await godotGame(A))?.sent?.guess ?? 0;
              const num = midOf(d.range);
              await A.page.fill('#gamePanel [data-role="input"]', String(num), { timeout: 5000 });
              await Promise.all([A.page.press('#gamePanel [data-role="input"]', 'Enter'), A.page.press('#gamePanel [data-role="input"]', 'Enter')]);
              await until(async () => ((await godotGame(A))?.sent?.guess ?? 0) > n0, 15_000, 'A 双击后发出了猜数', 150);
              await frames(A.page, 6);
              check(count(A, 'game_act') === g0 + 1 && ((await godotGame(A))?.sent?.guess ?? 0) === n0 + 1, `连按两下 Enter 只发一次 game_act：${g0} -> ${count(A, 'game_act')}`);
              turns.A++;
              // 两端范围与历史一致（等视图追上）
              await until(async () => (await stateOf(A)) === (await stateOf(B)), 20_000, 'A、B 面板的范围与猜数历史一致', 300);
            } else if (k === 'B' && !cut && turns.A + turns.B >= 1 && !(await gameMod(A.page)).yourTurn) {
              // 对手（A）回合里 B 断线：A 猜完之后 B 重连，应追上
              cut = true;
              B.gate.block = true;
              for (const ws of B.gate.sockets) ws.close();
              B.gate.sockets.length = 0;
              await until(async () => (await snap(B.page)).conn !== 'ok', 15_000, 'B 显示断线');
              await until(async () => (await gameMod(A.page)).yourTurn || (await gameMod(A.page)).mode === 'result', 60_000, '轮到 A', 300);
              if ((await gameMod(A.page)).mode === 'game') await takeTurn(A);
              B.gate.block = false;
              await until(async () => (await snap(B.page)).conn === 'ok', 40_000, 'B 重连成功');
              await until(async () => (await stateOf(A)) === (await stateOf(B)) || (await gameMod(A.page)).mode === 'result', 40_000, 'B 重连后追上 A 的范围与猜数历史', 300);
            } else if (k === 'B' && !kbB) {
              // 触屏设备接了实体键盘：用实体键盘的数字键和 Enter 猜一手（输入框只读、已自动聚焦）；这一手没猜成（回合变了）就留到下一轮
              kbB = true;
              if ((await takeTurnKeys(B)) !== null) turns.B++;
              else kbB = false;
            } else if ((await takeTurn(p)) !== null) turns[k]++;
          }
        }
        await sleep(250);
      }
      // 双击提交、断线追上这两段只在条件凑巧时才会走到（一局太短、或没轮到那一边）：没走到就不算数，重打一局（最多 3 局）
      if (dbl && cut && kbB) break;
      check(attempt < 2, `三局都太短，双击提交（${dbl}）、断线追上（${cut}）、手机实体键盘（${kbB}）没有都执行到`);
      note(`这一局太短，双击提交 ${dbl}、断线追上 ${cut}、手机实体键盘 ${kbB} 没都执行到，重打一局`);
      await A.page.click('#gamePanel [data-role="dismiss"]');
      await B.page.keyboard.press('Escape');
      for (const p of [A, B]) await until(async () => !(await gameMod(p.page)).shown && (await gameMod(p.page)).bodyFlag === null, 10_000, `${p.label} 结果卡收起`);
    }
    note(`A 猜 ${turns.A} 次，B 猜 ${turns.B} 次`);
    const [ra, rb] = [await gameMod(A.page), await gameMod(B.page)];
    check(ra.resultKind !== '' && rb.resultKind !== '', `两边都有结果：${ra.resultKind}/${rb.resultKind}`);
    const kinds = [ra.resultKind, rb.resultKind].sort().join(',');
    check(kinds === 'lost,won', `两边一个赢一个踩中：${kinds}`);
    check(ra.resultReason !== '' && rb.resultReason !== '', '都有原因');
    const rows = await B.page.evaluate(() => [...document.querySelectorAll('#gamePanel [data-role="resultPlayers"] li')].map((e) => e.textContent));
    check(rows.length === 2, `结果卡应列出两人：${JSON.stringify(rows)}`);
    const pg = await publicGame(A, aid51);
    check(pg.status === 200, `/public/game/${aid51} 应是 200：${pg.status} ${JSON.stringify(pg.body)?.slice(0, 200)}`);
    check(pg.body?.result?.reason === ra.resultReason && ra.resultReason === rb.resultReason, `结果卡原因应与公开投影一致：A「${ra.resultReason}」B「${rb.resultReason}」公开「${pg.body?.result?.reason}」`);
    const loser = (pg.body?.players ?? []).find((x) => (pg.body?.result?.winnerSeats ?? []).indexOf(x.seat) < 0);
    check(!!loser && ra.resultReason.includes(loser.name), `原因里应有踩中炸弹的人的名字：${loser?.name} / ${ra.resultReason}`);
    note(`结果：A ${ra.resultKind} / B ${rb.resultKind}；原因「${ra.resultReason}」；/public/game 状态 ${pg.status}`);
    await shot(B.page, '51-mobile-result');
    await shot(A.page, '51-desktop-result');
    // 关卡
    await A.page.click('#gamePanel [data-role="dismiss"]');
    await B.page.keyboard.press('Escape'); // 结果卡 Esc 也能关
    for (const p of [A, B]) await until(async () => !(await gameMod(p.page)).shown && (await gameMod(p.page)).bodyFlag === null, 10_000, `${p.label} 结果卡收起、body 标记去掉`);
    for (const id of ['destBtn']) check(await A.page.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== 'none', id), `关卡后 #${id} 回来`);
    check((await gg(A)).blocks === '', 'blocks 清空');
    await sleep(500);
    const f0 = A.gate.dirFrames.length;
    await A.page.keyboard.down('KeyS');
    await sleep(700);
    await A.page.keyboard.up('KeyS');
    await until(async () => A.gate.dirFrames.length > f0, 10_000, '关卡后 WASD 发方向帧');
    const sr = await apiSay(A, '打完了');
    check(sr.status === 200, `关卡后附近聊天可发：${sr.status} ${JSON.stringify(sr.body)}`);
    // C 在局中说的话 A 听不到：局后 C 再说一句，A 听到它就是屏障，然后查 /history 里没有局中那句
    const afterMark = `局后的话${h.rnd()}`;
    check((await C.act({ type: 'say_nearby', text: afterMark })).status === 200, 'C 局后说话');
    await until(async () => (await apiHistory(A)).some((m) => (m.text ?? m.body ?? '').includes(afterMark)), 25_000, 'A 听到 C 局后的话', 400);
    const hist = (await apiHistory(A)).map((m) => m.text ?? m.body ?? '');
    check(!hist.some((t) => t.includes(heardMark)), `A 的附近聊天历史里不应有局中那句「${heardMark}」`);
  });

  // ───────────────────────── 52 防注入与隐私 ─────────────────────────
  await step(52, '防注入与存储：恶意名字的 C 进桌、开局，面板与提示条里的名字和服务端一致、没有注入出节点、没有执行脚本；页面没有 game 相关的浏览器存储；面板文字里没有坐标', async () => {
    allowFailure(A.w, 'GET', /\/town\/api\/game(\?.*)?$/, { min: 0, max: 3, why: '52：A 退出时在途的 /game 读取可能得到 409 context_stale' });
    const evil = `<img src=x onerror="window.__xss=1">丁${h.rnd()}`;
    const D = await apiResident(h.browsers[0], BASE, evil);
    try {
      const dname = D.name; // 服务端清洗之后的名字
      note(`恶意名字「${evil}」登录后服务端存的名字是「${dname}」`);
      await D.walk('arcade');
      await D.walk(T2);
      // 51 的收尾里 A 按过 S（核对局后 WASD 能走），已经离开桌边：先走回桌二，再等桌边的按钮
      check((await apiAct(A, { type: 'navigate', to: T2 })).status === 200, 'A 走回桌二');
      await waitIdle(A);
      for (const p of [A, B]) await until(async () => (await snap(p.page)).nearValid === true && ((await btn(p, `f:game:propose:${T2}`)) || (await btn(p, 'f:game:join:'))), 25_000, `${p.label} 在桌二边`, 200);
      await click(A, `f:game:propose:${T2}`);
      await until(async () => (await lobbyId(A)) !== '', 20_000, 'A 开了桌二');
      const aid = await lobbyId(A);
      const jr = await D.act({ type: 'join_game', activityId: aid });
      check(jr.status === 200, `D 加入：${jr.status} ${JSON.stringify(jr.body)}`);
      await toastHas(A, `${dname} 加入了这一桌`);
      await until(async () => (await btn(A, 'f:game:start:'))?.sub?.includes('在桌边 2') ?? false, 20_000, 'A 的「开始」写着在桌边 2', 200);
      await click(A, (await btn(A, 'f:game:start:')).id);
      await until(async () => (await gameMod(A.page)).mode === 'game' && (await gameMod(A.page)).players.length >= 2, 30_000, 'A 入局、面板有玩家');
      const sv = (await serverMe(A)).game;
      const names = (sv.players ?? []).map((x) => x.name);
      check(names.includes(dname), `服务端的玩家名里应有清洗后的名字：${JSON.stringify(names)}`);
      const dom = (await gameMod(A.page)).players.map((x) => x.text);
      check(dom.some((t) => t.includes(dname)), `面板上的名字应与服务端一致：${JSON.stringify(dom)} / ${dname}`);
      const bad = await A.page.evaluate(() => ({
        nodes: document.querySelectorAll('#gamePanel img, #gamePanel script, #gamePanel iframe, #gamePanel svg image, #toasts img, #tags img').length,
        onerror: document.querySelectorAll('[onerror], [onload]').length,
        xss: window.__xss ?? null,
      }));
      check(bad.nodes === 0 && bad.onerror === 0 && bad.xss === null, `面板、提示条、桌牌里不应有注入的节点或执行过的脚本：${JSON.stringify(bad)}`);
    } finally {
      // 收尾：A 退出（界面确认框），D 退出
      if ((await gg(A)).inGame) {
        await A.page.click('#gamePanel [data-role="leave"]');
        await A.page.click('#gamePanel [data-role="leaveYes"]');
        await until(async () => !(await gg(A)).inGame, 20_000, 'A 离开了局');
      }
      await D.close().catch(() => {});
    }
    for (const p of [A, B]) {
      const keys = await p.page.evaluate(() => { try { return [...Object.keys(localStorage), ...Object.keys(sessionStorage)]; } catch { return []; } });
      check(!keys.some((k) => /game|bomb|seat|guess/i.test(k)), `${p.label} 不应在浏览器存储里留 game 数据：${JSON.stringify(keys)}`);
      const imgs = await p.page.evaluate(() => document.querySelectorAll('#gamePanel img, #gamePanel script, #gamePanel iframe').length);
      check(imgs === 0, `${p.label} 面板里没有 img / script / iframe`);
      const txt = (await gameMod(p.page)).text;
      check(!/\d+\.\d{2}\s*[,，]\s*\d+\.\d{2}/.test(txt), `面板文字里没有坐标：${txt.slice(0, 80)}`);
    }
    for (const t of await tableTags(A.page)) check(!/\d+\.\d{2}/.test(t.text), `桌牌里没有坐标：${t.text}`);
  });

  // ───────────────────────── 52.9 收尾 ─────────────────────────
  await step(52.9, '收尾：没有留下的桌和局，API 居民离开', async () => {
    for (const p of [A, B]) {
      const m = await serverMe(p);
      if (m.game) await apiAct(p, { type: 'quit_game' });
      else if ((m.here?.activities ?? []).some((a) => a.status === 'forming')) await apiAct(p, { type: 'leave_game_lobby' });
    }
    await nap(300);
  });
  try {
    await C?.close();
  } catch {
    /* 收尾 */
  }
  await h.release(A);
  await h.release(B);
}

// ───────────────────────── 怎么让它失败（反向验证清单）─────────────────────────
// 每条：改哪里 → 哪一条断言变红。做完要恢复，且改动期间不提交。
// 1. game.gd on_pick 里去掉「_walk_table == pick_id and _clock < _walk_until」那一行 -> 50 的「连按两下 E 只发一次 navigate」。
// 2. game.gd pick_seat 里把 taken 判断去掉 -> 50.1 的「落脚点相距 1 米以上」。
// 3. game.gd blocks_input 恒返回空 -> 50.45 的「局中点地不应发 navigate」。
// 4. game.gd _guess 去掉本地范围核对（并把 game.js 的范围校验也去掉）-> 50.5 的「本地拒绝的猜数不发 game_act」。
// 5. game.gd _quit 里去掉 _ignored[aid] = true -> 50.5 的「A 已主动退出：局结束后不应弹结果卡」。
// 6. game.gd _on_started 里不丢出不在桌边的人（或去掉被丢出的提示）-> 50.4 的「B 收到被丢出的提示」。
// 7. game.css 去掉 body[data-game] 对 #actions 等的隐藏 -> 50.45 的「局中 #actions 应藏起来」。
// 8. game.html 的数字键换成 40 像素 -> 51 的「数字键都不小于 44 像素」。
