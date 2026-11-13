// C1a：面板底座（dock）+ 附近聊天。A 桌面 1440x900，B 手机 390x844 触摸。
// 步骤号都是数字（20.45 就是「20.4 之后的一步」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言都按那里写的做过反向验证。
import { poll, dockState, modState, godotFeature, openDock, closeDock, pressEnterToChat, hitTest, rectOf, rectsOverlap, frames } from '../lib/ui.mjs';
import { nearbyRows, sysLines, unread, compose, bank, uiSay, waitAck, apiSay, apiSayWait, apiAct, apiHistory } from '../lib/chat.mjs';

export const meta = { id: 'chat-nearby', n: 20, title: '面板底座与附近聊天' };

const IN = '#dock [data-role="input"]';
const HEAR = 9; // 服务器 hearDistance

export default async function run(h) {
  const { check, note, until, sleep, step, shot, allowFailure, selfActor, dist, serverScene, snap, walkTo, rnd, BASE } = h;
  const { A, B } = await h.pair();
  const uniq = (s) => `${s}${rnd()}`;
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);
  const okSays = (p) => actionsOf(p, 'say_nearby').filter((r) => r.status === 200).length;
  const rowsWith = async (p, text) => (await nearbyRows(p.page)).filter((r) => r.text === text);
  const waitRow = (p, text, ms = 20_000) => until(async () => (await rowsWith(p, text))[0] ?? null, ms, `${p.label} 的列表里出现「${text}」`);
  const events = async (p) => (await godotFeature(p.page, 'nearby'))?.events ?? 0;
  const sceneOf = async (p) => selfActor(await serverScene(p));
  // 服务器对同一个 IP 每分钟只放 240 个请求（所有页面和脚本共用）：轮询要省着用，一次 GET /scene 同时给出 A、B 的位置和是否在走
  const pair = async () => {
    const sc = await serverScene(A);
    const a = selfActor(sc);
    const b = sc.actors.find((x) => x.id === B.id) ?? null;
    return { a, b, gap: b ? dist(a, b) : Infinity, movingA: !!a.nav, movingB: b ? !!b.nav : false };
  };
  const gap = async () => (await pair()).gap;
  const aloneVisible = (p) => p.page.evaluate(() => !document.querySelector('#dock [data-pane="nearby"] [data-role="alone"]').hidden);
  const navIdle = async (p) => !(await sceneOf(p)).nav;
  const waitIdle = (p, ms = 40_000) => until(() => navIdle(p), ms, `${p.label} 走完`, 700);
  /** B 走到 A 身边（服务器的 approach），等距离 < 近 */
  const come = async (p, to, near = 4) => {
    await apiAct(p, { type: 'navigate', approach: to.id });
    await until(async () => {
      const q = await pair();
      return q.gap < near && !q.movingA && !q.movingB;
    }, 60_000, `${p.label} 走到 ${to.label} 身边`, 700);
  };
  const uniqueMids = async (p) => {
    const m = (await nearbyRows(p.page)).map((r) => r.mid);
    return new Set(m).size === m.length;
  };

  // ───────────────────────── 20 初始 ─────────────────────────
  await step(20, '初始：两边都有「聊天」按钮、面板关着、角标隐藏；附近页签存在，打开后有输入框', async () => {
    for (const p of [A, B]) {
      check(await p.page.isVisible('#dockBtn'), `${p.label} 应有可见的 #dockBtn`);
      const d = await dockState(p.page);
      check(d && d.open === false, `${p.label} 面板默认应关闭：${JSON.stringify(d)}`);
      const u = await unread(p.page);
      check(u.hidden && u.n === 0, `${p.label} 初始角标应隐藏：${JSON.stringify(u)}`);
      check(await modState(p.page, 'nearby'), `${p.label} 应有 __dock.nearby`);
      check(!(await p.page.isVisible('#dock')), `${p.label} 面板关着时不应可见`);
    }
    note(`布局：A ${(await dockState(A.page)).layout}，B ${(await dockState(B.page)).layout}`);
    check((await dockState(A.page)).layout === 'side' && (await dockState(B.page)).layout === 'drawer', '桌面应为侧栏、手机应为抽屉');
    await openDock(A.page);
    check(await A.page.isVisible(IN), 'A 打开面板后应有输入框');
    await until(async () => !(await compose(A.page)).disabled, 20_000, 'A 的输入框可用（Godot 推来了 canSend）');
    await until(async () => !(await compose(B.page)).disabled, 20_000, 'B 的输入框可用');
    const c = await compose(A.page);
    note(`输入框占位「${c.placeholder}」`);
  });

  // ───────────────────────── 20.1 收发 ─────────────────────────
  await step(20.1, '收发：A 说话，A 的列表一行（data-mid / data-from）；B 关着面板角标 1，打开清零、同一行恰好一条；B 回话 A 收到', async () => {
    const t1 = uniq('你好');
    await openDock(A.page);
    const ack = await uiSay(A, t1);
    check(ack.ok && typeof ack.heardBy === 'number', `A 的回应应成功：${JSON.stringify(ack)}`);
    const rowA = await waitRow(A, t1);
    check(rowA.from === A.id && Number.isFinite(rowA.mid) && rowA.mine, `A 的行 data-from 应是 A（${A.id}），实际 ${JSON.stringify(rowA)}`);
    // B 的面板关着：角标 1
    await until(async () => {
      const u = await unread(B.page);
      return u.n === 1 && u.badge === '1' && !u.hidden && u.label.includes('1');
    }, 20_000, 'B 的启动按钮出现角标 1');
    const uB = await unread(B.page);
    note(`B 角标「${uB.badge}」，aria-label「${uB.label}」`);
    await openDock(B.page);
    await until(async () => (await unread(B.page)).n === 0 && (await unread(B.page)).hidden, 10_000, 'B 打开后角标清零');
    const rowsB = await rowsWith(B, t1);
    check(rowsB.length === 1 && rowsB[0].mid === rowA.mid && rowsB[0].from === A.id && !rowsB[0].mine, `B 应恰好有同一行：${JSON.stringify(rowsB)}`);
    // A 自己这条（回执立刻放进去 + 事件回声）也只有一条
    await sleep(0);
    await until(async () => (await events(A)) >= 1, 15_000, 'A 收到了自己的回声事件'); // 回声到了才能说「去重成功」
    check((await rowsWith(A, t1)).length === 1, 'A 自己的话回执加回声也应恰好一条');
    // B 回话
    const t2 = uniq('收到');
    const ack2 = await uiSay(B, t2);
    check(ack2.ok && ack2.heardBy >= 1, `B 的回应应成功且有人听到：${JSON.stringify(ack2)}`);
    const rowA2 = await waitRow(A, t2);
    check(rowA2.from === B.id && !rowA2.mine, `A 应收到 B 的话：${JSON.stringify(rowA2)}`);
    const uA = await unread(A.page);
    check(uA.n === 0, `A 面板开着，不计未读：${JSON.stringify(uA)}`);
    check((await rowsWith(B, t2)).length === 1 && (await uniqueMids(B)) && (await uniqueMids(A)), '两边每个 data-mid 都只出现一次');
    note(`A 的行 mid ${rowA.mid}，B 回话 mid ${rowA2.mid}（每个接收者自己的收件序号）`);
  });

  // ───────────────────────── 20.2 键盘 ─────────────────────────
  await step(20.2, '键盘：输入框里 WASD 不进游戏；Esc 先失焦再关面板；Enter 打开并聚焦；按钮上的 Enter 不被劫持；输入法组字中的 Enter 不发送；空输入 Enter 失焦；桌面发送后失焦；无 CSP 违规', async () => {
    await openDock(A.page);
    await A.page.click(IN);
    check((await compose(A.page)).focused, '点击后输入框应聚焦');
    await A.page.keyboard.type('dw');
    check((await compose(A.page)).value === 'dw', '输入框里应出现 dw');
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const me = await sceneOf(A);
      check(!me.nav, 'WASD 不应进游戏：服务器里 A 在走');
      await sleep(250);
    }
    await A.page.fill(IN, '');
    // Esc：先失焦（面板仍开），再按才关闭
    await A.page.keyboard.press('Escape');
    check(!(await compose(A.page)).focused && (await dockState(A.page)).open, '第一次 Esc 只失焦，面板应仍开着');
    await A.page.keyboard.press('Escape');
    await until(async () => !(await dockState(A.page)).open, 5000, '第二次 Esc 关闭面板');
    // Enter 打开并聚焦
    await pressEnterToChat(A.page);
    check((await dockState(A.page)).open, 'Enter 应打开面板');
    // 焦点在 #dockBtn 上按 Enter：按钮正常切换，不被全局 Enter 劫持
    await A.page.keyboard.press('Escape'); // 失焦
    await A.page.focus('#dockBtn');
    await A.page.keyboard.press('Enter');
    await until(async () => !(await dockState(A.page)).open, 5000, '焦点在按钮上按 Enter：面板应关闭（按钮自己的激活）');
    check(!(await compose(A.page)).focused, '按钮上的 Enter 不应把焦点劫持进输入框');
    await A.page.keyboard.press('Enter');
    await until(async () => (await dockState(A.page)).open, 5000, '再按一次：面板应打开');
    // 输入法组字中的 Enter：不发送。屏障是后面真实发送的计数：整段只多出一次成功的 say_nearby
    const base = okSays(A);
    await A.page.fill(IN, '输入法一句');
    const sent0 = (await godotFeature(A.page, 'nearby')).sent;
    const sync = await A.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      return { sending: window.__dock.nearby.sending, value: el.value };
    }, IN);
    check(sync.sending === false && sync.value === '输入法一句', `组字中的 Enter 不应发送：${JSON.stringify(sync)}`);
    const t3 = uniq('键盘');
    await A.page.fill(IN, t3);
    const ack = await uiSay(A, t3);
    check(ack.ok, `真实发送应成功：${JSON.stringify(ack)}`);
    check((await godotFeature(A.page, 'nearby')).sent === sent0 + 1 && okSays(A) === base + 1, `组字中的 Enter 不应多发一次：sent ${sent0} -> ${(await godotFeature(A.page, 'nearby')).sent}，成功请求 ${base} -> ${okSays(A)}`);
    // 桌面发送成功后输入框失焦
    check(!(await compose(A.page)).focused, '桌面发送成功后输入框应失焦（WASD 马上可用）');
    // 空输入 Enter：失焦
    await A.page.click(IN);
    await A.page.keyboard.press('Enter');
    check(!(await compose(A.page)).focused, '空输入按 Enter 应失焦');
    const csp = await A.page.evaluate(() => window.__csp ?? []);
    check(csp.length === 0, `提交表单不应产生 CSP 违规：${csp.join('; ')}`);
  });

  // ───────────────────────── 20.3 限流与保留输入、超长 ─────────────────────────
  await step(20.3, '超长与限流：121 个码点（表情算一个）禁用发送、不发请求；突发 3 条后被限流，输入保留、出现倒计时、被拒的那条 B 没收到；恢复后能再发；服务器对超长回 400', async () => {
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 2, why: '20.3：突发 3 条之后被限流（429）' });
    await openDock(A.page);
    const base = okSays(A);
    // 超长：前端禁用；强发时 Godot 一侧本地拒绝（不发请求）；整段的请求计数由后面的真实发送做屏障
    const long = '😀'.repeat(60) + 'a'.repeat(61);
    check([...long].length === 121, '构造的文字应是 121 个码点');
    await A.page.fill(IN, long);
    let c = await compose(A.page);
    check(c.sendDisabled && c.count === '121/120' && c.hint.includes('120'), `超长应禁用发送并提示最多 120 字：${JSON.stringify(c)}`);
    await A.page.press(IN, 'Enter');
    await A.page.evaluate((t) => window.TownDock.test.forceSend(t), long);
    const tl = await waitAck(A, (a) => a.code === 'text_too_long', '强发超长得到 text_too_long');
    check(tl.maxChars === 120, `回应应带上限 120：${JSON.stringify(tl)}`);
    c = await compose(A.page);
    check(c.value === long && c.hint.includes('120'), `超长被拒后输入应保留并有提示：${c.hint}`);
    // 服务器的 400：直接用 API 说同一句
    // 服务器自己也拒绝超长（走 API，不经页面，所以页面监视看不到这个 400，不需要声明）
    const r400 = await apiSay(A, long);
    check(r400.status === 400 && r400.body?.error === 'bad_request' && r400.body?.reason === 'text_too_long' && r400.body?.maxChars === 120, `服务器应对 121 码点回 400 text_too_long：${JSON.stringify(r400)}`);
    await A.page.fill(IN, '');
    // 限流：连发直到被拒
    const sent = [];
    let rej = null;
    for (let i = 0; i < 8 && !rej; i++) {
      const t = uniq(`连发${i}-`);
      const ack = await uiSay(A, t);
      if (ack.ok) sent.push(t);
      else rej = { t, ack };
    }
    check(rej && rej.ack.code === 'rate_limited', `连发应在突发之后被限流：${JSON.stringify(rej)}`);
    check(rej.ack.retryMs > 0, `限流回应应带 retryMs：${JSON.stringify(rej.ack)}`);
    c = await compose(A.page);
    const kit = await modState(A.page, 'nearby');
    check(c.value === rej.t, `被拒后输入应保留：${c.value}`);
    check(c.sendDisabled && kit.cool > 0 && c.hintClass.includes('cool') && /\d/.test(c.hint), `应出现倒计时并禁用发送：${JSON.stringify({ c, cool: kit.cool })}`);
    note(`连发 ${sent.length} 条成功后第 ${sent.length + 1} 条被限流，retryMs ${rej.ack.retryMs}，提示「${c.hint}」`);
    // 恢复后能再发（换一句，好和被拒的那句区分）
    await until(async () => (await modState(A.page, 'nearby')).cool <= 0 && !(await compose(A.page)).sendDisabled, 30_000, '倒计时结束、发送钮恢复');
    const again = uniq('恢复');
    const ack3 = await uiSay(A, again);
    check(ack3.ok, `恢复后应能发送：${JSON.stringify(ack3)}`);
    sent.push(again);
    await waitRow(B, again);
    // 恢复后的那句已经在 B 的列表里（事件有序），所以「被拒的那句没来」可以下结论
    check((await rowsWith(B, rej.t)).length === 0, 'B 不应有被拒绝的那句');
    check((await rowsWith(A, rej.t)).length === 0, '被拒的那句不应出现在 A 的列表里');
    const histB = await apiHistory(B);
    check(!histB.some((m) => m.text === rej.t), 'B 的服务端历史里也不应有被拒的那句');
    for (const t of sent) check((await rowsWith(B, t)).length === 1, `成功的「${t}」B 应恰好一条`);
    // 屏障：每一次成功的 ack 对应一次 200 的请求，超长那几次没有产生任何请求
    check(okSays(A) - base === sent.length, `成功的请求数应等于成功发送数（超长不发请求）：${okSays(A) - base} vs ${sent.length}`);
    check(actionsOf(A, 'say_nearby').filter((r) => r.status === 429).length >= 1, '应记到至少一次 429');
  });

  // ───────────────────────── 20.4 走远收不到 ─────────────────────────
  await step(20.4, '走远收不到：B 走到 9 米以外，A 说 X；B 自己说 Y（回声到了做屏障）；B 的列表和服务端历史都没有 X；走回后 A 说 Z，B 收到', async () => {
    await openDock(B.page);
    await walkTo(B, 42, 21, 1.5, { avoidDock: true });
    const g = await gap();
    check(g > HEAR + 0.5, `B 应在 ${HEAR} 米以外，实际相距 ${g.toFixed(1)} 米`);
    const X = uniq('远处的话');
    const rx = await apiSayWait(A, X);
    check(rx.status === 200, `A 说 X 应成功：${JSON.stringify(rx)}`);
    await waitRow(A, X);
    const e0 = await events(B);
    const Y = uniq('我在远处');
    const ry = await apiSayWait(B, Y);
    check(ry.status === 200, `B 说 Y 应成功：${JSON.stringify(ry)}`);
    await until(async () => (await events(B)) > e0, 20_000, 'B 收到了自己那句的回声事件（同一居民的事件有序，X 若会到一定先到）');
    await waitRow(B, Y);
    check((await rowsWith(B, X)).length === 0, 'B 走远了，列表里不应有 X');
    check(!(await apiHistory(B)).some((m) => m.text === X), 'B 的服务端历史里也不应有 X');
    check((await apiHistory(A)).some((m) => m.text === X), '服务端确实记下了 A 说的 X（正面证据）');
    note(`相距 ${g.toFixed(1)} 米：X 没到 B，B 自己的 Y 到了（B 的 events ${e0} -> ${await events(B)}）`);
    // 走回
    await apiAct(B, { type: 'navigate', to: { x: 34, z: 27.5 } }); // 抽屉开着时屏幕下半部点不到，回程走 API
    await waitIdle(B);
    check((await gap()) < HEAR - 1, `B 走回后应在 ${HEAR} 米以内`);
    const Z = uniq('回来了');
    await apiSayWait(A, Z);
    const rz = await waitRow(B, Z);
    check(rz.from === A.id, 'B 应收到 A 的 Z');
  });

  // ───────────────────────── 20.45 一起移动仍可听见 ─────────────────────────
  await step(20.45, '一起移动仍可听见：A、B 同时走向花园，路上 A 说话，B 收到，heardBy >= 1', async () => {
    const [ga, gb] = [await apiAct(A, { type: 'navigate', to: { x: 58, z: 28 } }), await apiAct(B, { type: 'navigate', to: { x: 57, z: 30 } })];
    check(ga.status === 200 && gb.status === 200, `两人的 navigate 应成功：${JSON.stringify([ga.body?.error, gb.body?.error])}`);
    await until(async () => {
      const q = await pair();
      return q.movingA && q.movingB;
    }, 10_000, '两人都在走', 500);
    const g1 = await gap();
    const M = uniq('路上说');
    const r = await apiSayWait(A, M);
    const q2 = await pair();
    const g2 = q2.gap;
    const stillMoving = q2.movingA && q2.movingB;
    check(stillMoving, '说话的时候两人应都还在走（路程不够长就要改目的地）');
    check(g1 < HEAR && g2 < HEAR, `移动中两人应在 ${HEAR} 米以内：${g1.toFixed(1)} / ${g2.toFixed(1)}`);
    check(r.status === 200 && r.body.heardBy >= 1, `heardBy 应 >= 1：${JSON.stringify(r.body)}`);
    const row = await waitRow(B, M);
    check(row.from === A.id, 'B 应收到路上说的话');
    await Promise.all([waitIdle(A), waitIdle(B)]);
    note(`移动中相距 ${g1.toFixed(1)} / ${g2.toFixed(1)} 米，heardBy ${r.body.heardBy}`);
  });

  // ───────────────────────── 20.46 隔离房间收不到 ─────────────────────────
  await step(20.46, '隔离房间收不到：B 回家（私宅实例），A 在原处说话，B 的列表和服务端历史都没有；面板「地点」变成住宅；B 出来后 A 再说，B 收到', async () => {
    const place0 = await B.page.evaluate(() => document.querySelector('#dock [data-role="place"]').textContent);
    await B.page.click('#homeBtn');
    await until(async () => (await snap(B.page)).scene === 'home', 120_000, 'B 进到自己家');
    const T1 = uniq('门外的话');
    const r1 = await apiSayWait(A, T1);
    check(r1.status === 200, 'A 在原处说话应成功');
    await waitRow(A, T1);
    const e0 = await events(B);
    const U = uniq('屋里的话');
    await apiSayWait(B, U);
    await until(async () => (await events(B)) > e0, 20_000, 'B 屋里自己那句的回声到了（屏障）');
    await waitRow(B, U);
    check((await rowsWith(B, T1)).length === 0, 'B 在私宅里，不应听到门外的话');
    check(!(await apiHistory(B)).some((m) => m.text === T1), 'B 的服务端历史里也不应有门外的话');
    const place1 = await until(async () => {
      const p = await B.page.evaluate(() => document.querySelector('#dock [data-role="place"]').textContent);
      return p && p !== place0 ? p : null;
    }, 10_000, '面板「地点」变成住宅');
    check(place1 === (await snap(B.page)).spaceName, `地点应等于页面的空间名：「${place1}」`);
    note(`地点：「${place0}」 -> 「${place1}」`);
    // 出来
    await B.page.click('#homeBtn');
    await until(async () => (await snap(B.page)).scene !== 'home', 120_000, 'B 出门');
    await come(B, A);
    const T2 = uniq('出来了');
    await apiSayWait(A, T2);
    await waitRow(B, T2);
  });

  // ───────────────────────── 20.5 一个人 ─────────────────────────
  await step(20.5, '一个人：B 走远后 A 的便签出现，走回后消失；无人时发话 heardBy 为 0 并出现「没有人听到」系统行', async () => {
    await until(async () => (await serverScene(A)).actors.length === 2, 100_000, '镇上只剩 A 和 B（旧步骤的居民已离开）', 1000);
    await openDock(A.page);
    check(!(await aloneVisible(A)), 'B 在身边时不应显示「附近没人」便签');
    await apiAct(B, { type: 'navigate', to: { x: 34, z: 30 } });
    await waitIdle(B);
    check((await gap()) > HEAR + 0.5, 'B 应已走远');
    await until(() => aloneVisible(A), 15_000, 'A 出现「看起来附近没人」便签');
    const Q = uniq('没人听');
    const ack = await uiSay(A, Q);
    check(ack.ok && ack.heardBy === 0, `无人时 heardBy 应为 0：${JSON.stringify(ack)}`);
    const nobody = await bank(A.page, 'sys.nobody');
    await until(async () => (await sysLines(A.page)).includes(nobody), 8000, `出现系统行「${nobody}」`, 100);
    check((await rowsWith(A, Q)).length === 1, '自己说的那句仍在列表里');
    await come(B, A);
    await until(async () => !(await aloneVisible(A)), 15_000, 'B 走回后便签消失');
  });

  // ───────────────────────── 20.6 断线补 ─────────────────────────
  await step(20.6, '断线补：B 断线期间 A 说 M1、M2；重连后各出现且仅出现一次、顺序对、未读只计这两条；刷新后由历史重建、不重复、不计未读', async () => {
    await closeDock(B.page);
    const hist = [];
    const onResp = (r) => {
      if (/\/town\/api\/history/.test(r.url())) hist.push(r.status());
    };
    B.page.on('response', onResp);
    B.gate.block = true;
    for (const ws of B.gate.sockets) ws.close();
    B.gate.sockets.length = 0;
    await until(async () => (await snap(B.page)).conn !== 'ok', 15_000, 'B 显示断线');
    const M1 = uniq('断线一');
    const M2 = uniq('断线二');
    await apiSayWait(A, M1);
    await apiSayWait(A, M2);
    const h0 = hist.length;
    B.gate.block = false;
    await until(async () => (await snap(B.page)).conn === 'ok', 40_000, 'B 重连成功');
    await until(async () => (await unread(B.page)).n === 2, 30_000, 'B 的未读恰为 2');
    // 屏障：重连后续传的补读（hello 之后约 3 秒的 /history）返回，再过几帧，才能说「没有多出来」
    await until(() => hist.slice(h0).includes(200), 30_000, `重连后的 /history 补读返回（见到的状态码 ${JSON.stringify(hist.slice(h0))}）`);
    await frames(B.page, 3);
    B.page.off('response', onResp);
    const rows = await nearbyRows(B.page);
    const i1 = rows.findIndex((r) => r.text === M1);
    const i2 = rows.findIndex((r) => r.text === M2);
    check(rows.filter((r) => r.text === M1).length === 1 && rows.filter((r) => r.text === M2).length === 1, `M1、M2 各应恰好一条：${JSON.stringify(rows.map((r) => r.text))}`);
    check(i1 >= 0 && i2 > i1 && rows[i1].mid < rows[i2].mid, '顺序应是 M1 在 M2 之前');
    const u = await unread(B.page);
    check(u.n === 2 && u.badge === '2', `未读只计这两条：${JSON.stringify(u)}`);
    check(await uniqueMids(B), '没有重复的 data-mid');
    // 刷新：由 /history 重建
    B.w.closing = true;
    await B.page.reload();
    await B.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    B.w.closing = false;
    await B.page.click('#enterBtn');
    await B.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    await until(async () => (await rowsWith(B, M1)).length === 1 && (await rowsWith(B, M2)).length === 1, 30_000, '刷新后列表由历史重建出 M1、M2');
    await frames(B.page, 3);
    const u2 = await unread(B.page);
    check(u2.n === 0 && u2.hidden, `刷新后补读的历史不计未读：${JSON.stringify(u2)}`);
    check(await uniqueMids(B), '刷新后没有重复的 data-mid');
    await until(async () => !(await compose(B.page)).disabled, 20_000, '刷新后输入框可用');
  });

  // ───────────────────────── 20.7 只读与对局中 ─────────────────────────
  await step(20.7, '只读与对局中：另一处接管后 A 的输入框禁用、占位是只读提示、草稿保留；接管回来恢复；对局中用界面状态驱动核对禁用与占位', async () => {
    await openDock(A.page);
    const draft = uniq('草稿');
    await A.page.fill(IN, draft);
    const cid = await A.page.evaluate(() => window.TownHud.clientId());
    const other = `e2e-other-${rnd()}`;
    // 另一处 = 同一身份、另一个 clientId：先登记在场，再接管（和第二个标签页的做法一样，只是不开页面）
    const re = await A.ctx.request.post(`${BASE}/town/api/enter`, { data: { clientId: other } });
    check(re.ok(), `另一处登记在场应成功：${re.status()}`);
    const rc = await A.ctx.request.post(`${BASE}/town/api/claim`, { data: { clientId: other } });
    check(rc.ok(), `另一处接管应成功：${rc.status()}`);
    await until(async () => (await snap(A.page)).mine === false, 15_000, 'A 页面变成只读');
    await until(async () => (await compose(A.page)).disabled, 10_000, '只读时输入框禁用');
    const ro = await bank(A.page, 'ph.readonly');
    let c = await compose(A.page);
    check(c.placeholder === ro && c.value === draft, `只读时占位应是只读提示、草稿保留：${JSON.stringify(c)}`);
    // 强发：Godot 一侧本地拒绝，不发请求
    const base = actionsOf(A, 'say_nearby').length;
    await A.page.evaluate((t) => window.TownDock.test.forceSend(t), draft);
    const ra = await waitAck(A, (a) => a.code === 'readonly', '只读时强发得到 readonly');
    check(ra.ok === false && actionsOf(A, 'say_nearby').length === base, '只读时不应发出请求');
    c = await compose(A.page);
    check(c.hint === (await bank(A.page, 'err.readonly')) && c.value === draft, `只读被拒后应有提示、草稿保留：${c.hint}`);
    // 接管回来
    await A.page.click('#claimBtn');
    await until(async () => (await snap(A.page)).mine === true, 15_000, 'A 接管回来');
    await until(async () => !(await compose(A.page)).disabled, 10_000, '接管回来后输入框恢复');
    check((await compose(A.page)).value === draft, '接管回来后草稿仍在');
    void cid;
    // 对局中（界面状态驱动；真实对局由 C3 的步骤补，见 client/docs/C1a.md 的已知缺口）
    const st = { canSend: false, reason: 'game', max: 120, alone: false, place: '', hear: HEAR };
    await A.page.evaluate((s) => window.TownDock.feed('nearby', 'state', s), JSON.stringify(st));
    await until(async () => (await compose(A.page)).disabled, 5000, '对局中输入框禁用');
    c = await compose(A.page);
    check(c.placeholder === (await bank(A.page, 'ph.game')) && c.value === draft && c.sendDisabled, `对局中占位应是对局提示、草稿保留、发送钮禁用：${JSON.stringify(c)}`);
    await A.page.evaluate((s) => window.TownDock.feed('nearby', 'state', s), JSON.stringify({ ...st, canSend: true, reason: '' }));
    await until(async () => !(await compose(A.page)).disabled, 5000, '恢复后输入框可用');
    await A.page.fill(IN, '');
  });

  // ───────────────────────── 20.8 XSS ─────────────────────────
  await step(20.8, 'XSS：B 说带标签的文字，A 的列表里没有 img/script 元素，文字与 B 的服务端历史逐字相同', async () => {
    await come(B, A);
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>&amp;"'`;
    const ack = await uiSay(B, payload);
    check(ack.ok, `B 发送应成功：${JSON.stringify(ack)}`);
    const hist = await apiHistory(B);
    const srv = hist.find((m) => m.messageId === ack.messageId) ?? hist.find((m) => /onerror/.test(m.text ?? ''));
    check(srv, 'B 的服务端历史里应有这句');
    const row = await until(async () => (await nearbyRows(A.page)).find((r) => r.text === srv.text) ?? null, 20_000, 'A 的列表里出现这句（文字与服务端历史逐字相同）');
    check(row.from === B.id, '这句应来自 B');
    const bad = await A.page.evaluate(() => ({ nodes: document.querySelectorAll('#dock img, #dock script, #dock iframe').length, xss: window.__xss ?? null }));
    check(bad.nodes === 0 && bad.xss === null, `不应有注入的元素或脚本执行：${JSON.stringify(bad)}`);
    check((await B.page.evaluate(() => window.__xss ?? null)) === null, 'B 页面也不应执行脚本');
    note(`服务端存的文字：${JSON.stringify(srv.text)}`);
  });

  // ───────────────────────── 20.85 手机与布局 ─────────────────────────
  await step(20.85, '手机与布局：抽屉不挡「停下」且角色可见；软键盘（模拟 visualViewport）上移并收成紧凑；面板里触摸拖动/双指不走路不缩放；命中测试；横屏/1100/1000/360 宽', async () => {
    await openDock(B.page);
    const vpB = await h.viewport(B.page);
    check(vpB.w === 390, `B 应是 390 宽：${vpB.w}`);
    const dr = await rectOf(B.page, '#dock');
    const sr = await rectOf(B.page, '#stopBtn');
    check(dr && sr && !rectsOverlap(dr, sr), `「停下」与抽屉不应相交：${JSON.stringify({ dr, sr })}`);
    const hs = await hitTest(B.page, sr.x + sr.width / 2, sr.y + sr.height / 2);
    check(hs?.id === 'stopBtn', `「停下」中心点应命中按钮自己：${JSON.stringify(hs)}`);
    const hd = await hitTest(B.page, dr.x + dr.width / 2, dr.y + dr.height / 2);
    check(hd?.inDock, `面板中心点应属于面板：${JSON.stringify(hd)}`);
    const hc = await hitTest(B.page, vpB.w / 2, 250);
    check(hc?.inCanvas, `画布上方的点应属于画布：${JSON.stringify(hc)}`);
    // 角色（屏幕投影）不被抽屉盖住
    const me = await sceneOf(B);
    const pj = await h.project(B.page, me.x, me.z);
    check(pj.y < dr.top - 8, `角色的屏幕位置（y=${pj.y.toFixed(0)}）应在抽屉上沿（${dr.top.toFixed(0)}）之上`);
    note(`抽屉 ${dr.width.toFixed(0)}x${dr.height.toFixed(0)}，上沿 ${dr.top.toFixed(0)}；角色投影 y=${pj.y.toFixed(0)}；「停下」下沿 ${sr.bottom.toFixed(0)}`);

    // 触摸：列表上拖动、双指，不应走路、不应缩放；屏障是之后的帧数；正面对照是画布上同样的双指会缩放
    const cdp = await B.ctx.newCDPSession(B.page);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
    const lr = await rectOf(B.page, '#dock [data-pane="nearby"] [data-role="list"]');
    const cx = lr.x + lr.width / 2;
    const cy = lr.y + lr.height / 2;
    const z0 = (await snap(B.page)).zoom;
    const nav0 = actionsOf(B, 'navigate').length;
    await touch('touchStart', [{ x: cx, y: cy + 30 }]);
    for (let k = 1; k <= 5; k++) await touch('touchMove', [{ x: cx, y: cy + 30 - k * 12 }]);
    await touch('touchEnd', []);
    await touch('touchStart', [{ x: cx - 60, y: cy }, { x: cx + 60, y: cy }]);
    for (let k = 1; k <= 5; k++) await touch('touchMove', [{ x: cx - 60 + k * 10, y: cy }, { x: cx + 60 - k * 10, y: cy }]);
    await touch('touchEnd', []);
    await frames(B.page, 3);
    check((await snap(B.page)).zoom === z0, `面板里的双指不应缩放镜头：${z0} -> ${(await snap(B.page)).zoom}`);
    check(actionsOf(B, 'navigate').length === nav0, '面板里的触摸不应发出 navigate');
    // 对照：画布上方同样的双指应缩放（证明上面的“没有变化”不是手势根本没被处理）
    const yc = 220;
    await touch('touchStart', [{ x: vpB.w / 2 - 70, y: yc }, { x: vpB.w / 2 + 70, y: yc }]);
    for (let k = 1; k <= 6; k++) await touch('touchMove', [{ x: vpB.w / 2 - 70 + k * 10, y: yc }, { x: vpB.w / 2 + 70 - k * 10, y: yc }]);
    await touch('touchEnd', []);
    await until(async () => (await snap(B.page)).zoom !== z0, 10_000, '对照：画布上的双指会缩放镜头');

    // 软键盘（无头浏览器没有软键盘：模拟 visualViewport 并派发 resize，真实键盘行为见真机待办）
    await B.page.click(IN);
    await B.page.evaluate(() => {
      const real = window.visualViewport;
      window.__vvDesc = Object.getOwnPropertyDescriptor(window, 'visualViewport');
      const fake = { height: window.innerHeight - 300, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 };
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
      real.dispatchEvent(new Event('resize'));
    });
    await until(async () => (await dockState(B.page)).kb >= 250, 5000, '模拟键盘后 kb 约 300');
    const kbs = await B.page.evaluate(() => ({ kb: getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(), flag: document.body.dataset.kb, ih: window.innerHeight }));
    const dk = await rectOf(B.page, '#dock');
    check(kbs.flag === '1' && Math.abs(dk.bottom - (kbs.ih - 300)) < 4, `抽屉底边应上移到键盘上沿：${JSON.stringify({ kbs, bottom: dk.bottom })}`);
    check(!(await B.page.isVisible('#actions')) && !(await B.page.isVisible('#dockBtn')), '紧凑模式下 #actions 与 #dockBtn 应隐藏');
    check(await B.page.isVisible('#stopBtn'), '紧凑模式仍留「停下」');
    note(`模拟键盘 300px：--kb=${kbs.kb}，抽屉高 ${dk.height.toFixed(0)}，底边 ${dk.bottom.toFixed(0)}`);
    await B.page.evaluate(() => {
      const real = window.visualViewport;
      Object.defineProperty(window, 'visualViewport', window.__vvDesc);
      (window.visualViewport ?? real).dispatchEvent(new Event('resize'));
      document.activeElement?.blur();
    });
    await until(async () => (await dockState(B.page)).kb === 0 && (await B.page.isVisible('#dockBtn')), 5000, '键盘收起后恢复');

    // 横屏：切成侧栏
    await B.page.setViewportSize({ width: 844, height: 390 });
    await until(async () => (await dockState(B.page)).layout === 'side', 5000, '横屏 844x390 切成侧栏');
    const dl = await rectOf(B.page, '#dock');
    check(dl.right > 844 / 2 && dl.width <= 844 * 0.45, `横屏侧栏应靠右、不超过四成宽：${JSON.stringify(dl)}`);
    await B.page.setViewportSize({ width: 390, height: 844 });
    await until(async () => (await dockState(B.page)).layout === 'drawer', 5000, '竖屏回到抽屉');

    // 360 宽：控制按钮不溢出
    await B.page.setViewportSize({ width: 360, height: 740 });
    await frames(B.page, 2);
    const ov = await B.page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#controls > *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) out.push({ id: el.id, l: Math.round(r.left), r: Math.round(r.right) });
      }
      return { out, sw: document.documentElement.scrollWidth, iw: window.innerWidth };
    });
    check(ov.out.every((o) => o.l >= 0 && o.r <= 360) && ov.sw <= 360, `360 宽下控制按钮不应溢出：${JSON.stringify(ov)}`);
    note(`360 宽：${ov.out.map((o) => `${o.id}[${o.l},${o.r}]`).join(' ')}`);
    await B.page.setViewportSize({ width: 390, height: 844 });
    await until(async () => (await dockState(B.page)).layout === 'drawer', 5000, '回到 390 宽');

    // 桌面断点：1100 为侧栏，1000 为抽屉；面板都不与底部控制条相交
    for (const [w, want] of [[1100, 'side'], [1000, 'drawer']]) {
      await A.page.setViewportSize({ width: w, height: 720 });
      await until(async () => (await dockState(A.page)).layout === want, 5000, `A 宽 ${w} 应是 ${want}`);
      await frames(A.page, 2);
      const d = await rectOf(A.page, '#dock');
      for (const sel of ['#controls', '#actions']) {
        const r = await rectOf(A.page, sel);
        if (r && r.width > 0 && r.height > 0) check(!rectsOverlap(d, r), `宽 ${w}：面板与 ${sel} 不应相交：${JSON.stringify({ d, r })}`);
      }
      note(`A 宽 ${w}：${want}，面板 [${d.left.toFixed(0)},${d.right.toFixed(0)}]x[${d.top.toFixed(0)},${d.bottom.toFixed(0)}]`);
    }
    await A.page.setViewportSize({ width: 1440, height: 900 });
    await until(async () => (await dockState(A.page)).layout === 'side', 5000, 'A 回到 1440 宽侧栏');
  });

  // ───────────────────────── 20.9 截图（白天 / 傍晚 / 手机竖屏）─────────────────────────
  await step(20.9, '截图：桌面白天与傍晚、手机竖屏；面板不挡行走中的角色', async () => {
    // 画面的钟点只在页面加载时从地址栏读（?debug=1&hour=），所以每个钟点重新进入一次（会话 Cookie 还在，直接进）
    const reenter = async (p, hr) => {
      p.w.closing = true;
      await p.page.goto(`${BASE}/town/3d/?debug=1&hour=${hr}`);
      await p.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
      p.w.closing = false;
      await p.page.click('#enterBtn');
      await p.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
      await until(async () => Math.abs((await p.page.evaluate(() => window.__town.hour)) - hr) < 0.4, 15_000, `${p.label} 钟点到 ${hr}`);
      await openDock(p.page);
    };
    for (const [hr, tag] of [[11.5, ''], [19.5, '-evening']]) {
      await reenter(A, hr);
      await reenter(B, hr);
      await until(async () => (await nearbyRows(A.page)).length >= 3, 20_000, 'A 的列表由历史重建出若干条');
      const hereA = await sceneOf(A);
      await apiAct(A, { type: 'navigate', to: { x: hereA.x > 54 ? 50 : 58, z: 27 } });
      await until(async () => !(await navIdle(A)), 10_000, 'A 在走', 500);
      const dr = await rectOf(A.page, '#dock');
      const me = await sceneOf(A);
      const pj = await h.project(A.page, me.x, me.z);
      check(pj.x < dr.left - 8, `桌面：角色的屏幕位置（x=${pj.x.toFixed(0)}）应在侧栏左缘（${dr.left.toFixed(0)}）之外`);
      await shot(A.page, `20-desktop-chat-side${tag}`);
      await shot(B.page, `20-mobile-chat-drawer${tag}`);
      note(`${hr} 点：角色行走中，投影 x=${pj.x.toFixed(0)}，侧栏左缘 ${dr.left.toFixed(0)}`);
      await waitIdle(A);
    }
  });

  // ───────────────────────── 20.95 离开与换人 ─────────────────────────
  await step(20.95, '离开与换人：B 离开小镇后列表、草稿、未读被清空（on_leave）；换另一个名字重新进入后列表为空，看不到上一位听到的话', async () => {
    allowFailure(B.w, 'POST', /\/town\/api\/heartbeat$/, { min: 0, max: 1, why: '20.95：离开瞬间在途的心跳可能 presence_lost' });
    await openDock(B.page);
    await B.page.fill(IN, uniq('没发出去的草稿'));
    check((await nearbyRows(B.page)).length > 0, '离开前 B 的列表应有内容');
    const cid = await B.page.evaluate(() => window.TownHud.clientId());
    const lr = await B.ctx.request.post(`${BASE}/town/api/leave`, { data: { clientId: cid } });
    check(lr.ok(), `POST /leave 返回 ${lr.status()}`);
    await until(() => B.page.evaluate(() => document.body.dataset.phase === 'ready'), 20_000, 'B 页面回到「已离开」');
    const k = await modState(B.page, 'nearby');
    check(k.count === 0 && k.rows === 0 && k.unread === 0, `离开后列表应清空：${JSON.stringify(k)}`);
    check((await compose(B.page)).value === '', '离开后草稿应清空');
    // 换人：清掉登录 Cookie，再进入时要求重新取名
    await B.ctx.clearCookies();
    const oldId = B.id;
    await B.page.click('#enterBtn');
    await B.page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 });
    const hist = [];
    B.page.on('response', (r) => {
      if (/\/town\/api\/history/.test(r.url())) hist.push(r.status());
    });
    const nm = `阿换${rnd()}`;
    await B.page.fill('#nameInput', nm);
    await B.page.click('#loginBtn');
    await B.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    B.id = (await snap(B.page)).self;
    check(B.id !== oldId, '换名重进应是另一位居民');
    await until(() => hist.includes(200), 30_000, '新居民的 /history 补读返回（屏障）');
    await frames(B.page, 3);
    const k2 = await modState(B.page, 'nearby');
    check(k2.count === 0 && k2.rows === 0, `新居民不应看到上一位听到的话：${JSON.stringify(k2)}`);
    check((await unread(B.page)).n === 0, '新居民的未读应为 0');
    // Godot 一侧也要清：_seen 里留着上一位的消息编号，新居民的收件序号会撞上它们（debug().seen 是 _seen 的大小；
    // 离开期间 Godot 不推调试数据，所以在新居民进入、调试数据刷新之后看）。新居民刚进来，历史是空的，已见编号应为 0
    await until(async () => ((await godotFeature(B.page, 'nearby'))?.seen ?? -1) === 0, 10_000, '新居民的 Godot 一侧已见编号为 0（nearby.gd 的 on_leave 清了 _seen）');
    note(`换人：${oldId} -> ${B.id}，列表为空`);
  });

  await h.release(A);
  await h.release(B);
}

/* ───────────────────────── 怎么让它失败（反向验证）─────────────────────────
 * 以下每条临时改动后，指定的子步骤变红（括号里是实际看到的第一个红断言）；改回去再跑变绿。破坏清单和脚本不入库，下面逐条写明改哪里。
 *  - dock.js wireInput 去掉 `e.isComposing || keyCode === 229 || 30ms` 判断：20.2（组字中的 Enter 不应发送）。
 *  - 00-chatkit.js 的 updateSend 里去掉 `|| n > maxChars()`（发送钮不因超长而禁用）：20.3（超长应禁用发送并提示最多 120 字）。
 *    同时去掉 canSend() 里的 `len() <= maxChars()`：Enter 会把超长发到 Godot，Godot 本地拒绝（text_too_long），页面一侧没有可观察的差别，所以前端这道检查是纵深防御，单独破坏它不会变红（已知）。
 *  - nearby.gd 的 `_send` 里去掉 `text.length() > mx`：20.3（强发超长得不到 text_too_long 的回应）。
 *  - 00-chatkit.js 的 setState 里让「附近没人」便签永远隐藏：20.5。
 *  - 00-chatkit.js 的 setState 里占位符固定用 ph.ok：20.7（只读时占位应是只读提示）。
 *  - dock.css 去掉手机抽屉打开时对 #bottombar 的抬高：20.85（「停下」与抽屉相交）。
 *  - dock.css 把侧栏宽度改成 70vw：20.85（宽 1100 时面板与 #controls 相交）。
 *  - 00-chatkit.js 的 reset() 里不清列表：20.95（离开后列表应清空）。
 *  - nearby.gd 的 `_ingest` 不按 id 去重 + 00-chatkit.js 不按 id 去重（?debug=1 下 TownDock.test.noDedupe 是同样效果的运行时开关）：20.1（回执加回声应恰好一条）、20.6。
 *  - nearby.gd 的 `on_leave` 里不清 `_seen` / `_msgs`：20.95（新居民的 Godot 一侧已见编号应为 0）。
 *  - nearby.gd 的 `_alone` 判定改成永远「有人」：20.5（便签不出现）。
 *  - dock.js 全局 Enter 处理里去掉对 button 的排除：20.2（按钮上的 Enter 不应被劫持）。
 *  - dock.js 的 applyKb 里 kb 永远 0：20.85（模拟键盘后 kb 约 300）。
 *  - 00-chatkit.js 的 startCooldown 之后不再禁用发送钮（去掉 updateSend 里的 `cool > 0`）：20.3（应出现倒计时并禁用发送）。
 *  - 00-chatkit.js 的 onAck 里去掉 heardBy === 0 时的系统行：20.5（出现「没有人听到」系统行）。
 *  - 00-chatkit.js 的 flush 里历史补读（live=false）也计未读（`else if (p.live) fresh++` 改成 `else fresh++`）：20.6（刷新后补读的历史不计未读）。
 *  - 00-chatkit.js 的 onShow 里不清未读：20.1（B 打开后角标清零）。
 *  - dock.js wireInput 里 Esc 不失焦：20.2（第一次 Esc 只失焦）；done() 里不失焦：20.2（桌面发送成功后应失焦）；空输入 Enter 不失焦：20.2（空输入按 Enter 应失焦）。
 *  - 本文件自己的前置条件：B 不走远（20.4：B 应在 9 米以外）、两人目的地改成相距很近（20.45：说话时两人应都还在走）、B 不进私宅（20.46：B 在私宅里不应听到门外的话）。
 *  - 把构建产物里的 textContent 改成 innerHTML（只改产物）：20.8（A 的列表里出现这句的文字与服务端不同 / 注入的元素）。
 * 没有做出红灯的两条（如实记录）：
 *  - nearby.gd 的 on_hello 里 `resumed and not first` 改成立即补读：20.6 仍绿，只有全程检查因为一个未声明的 401（离开后的 /history）变红。它防的是「历史抢在补发的事件前面到，补发的事件被当成已有、未读少算」，
 *    本机里事件续传总是先于 /history 的一次往返，这个时序造不出来；要造得先能延迟 WebSocket 帧，wsGate 现在只能整体阻断。
 *  - nearby.gd 的 on_event 里不按 scope == "nearby" 过滤：服务端现在只有 scope 为 nearby 的 chat 事件，造不出别的 scope，这条没验证。
 */
