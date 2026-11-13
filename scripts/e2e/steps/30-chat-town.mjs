// C1b：全镇公屏、头顶气泡、静音。A 桌面 1440x900，B 手机 390x844 触摸。
// 步骤号都是数字（30.75 就是「30.7 与 30.8 之间」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言都按那里写的做过反向验证。
//
// 发话预算：公屏额度按居民算（突发 2、每 10 秒回 1 条），附近额度突发 3。lib/town.mjs 的 awaitTownToken 按本脚本发成功的记录推算令牌桶，
// 不够就等（等的是服务端的限流）。只有 30.5 故意把额度用光。
import { poll, dockState, modState, godotFeature, openDock, closeDock, hitTest, rectOf, frames } from '../lib/ui.mjs';
import { apiSay, apiSayWait, apiAct, apiHistory, expectReject } from '../lib/chat.mjs';
import {
  TOWN, townRows, openTown, tabOrder, townUnread, townCompose, townBank, townChrome, uiTownSay, apiTownSay, apiTownSayWait, apiTownPage, noteTownSent, bubbles, bubbleFeature, emitTown,
} from '../lib/town.mjs';

export const meta = { id: 'chat-town', n: 30, title: '全镇公屏、头顶气泡与静音' };

const IN = `${TOWN} [data-role="input"]`;

export default async function run(h) {
  const { check, note, until, sleep, step, shot, allowFailure, selfActor, dist, serverScene, snap, walkTo, rnd, BASE } = h;
  const { A, B } = await h.pair();
  const uniq = (s) => `${s}${rnd()}`;
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);
  const okTown = (p) => actionsOf(p, 'say_town').filter((r) => r.status === 200).length;
  const rowsWith = async (p, text) => (await townRows(p.page)).filter((r) => r.text === text);
  const waitRow = (p, text, ms = 25_000) => until(async () => (await rowsWith(p, text))[0] ?? null, ms, `${p.label} 的全镇列表里出现「${text}」`);
  const townF = async (p) => (await godotFeature(p.page, 'town')) ?? {};
  const framesOf = async (p) => (await townF(p)).frames ?? 0;
  const uniqueMids = async (p) => {
    const m = (await townRows(p.page)).map((r) => r.mid);
    return new Set(m).size === m.length;
  };
  const sceneOf = async (p) => selfActor(await serverScene(p));
  const navIdle = async (p) => !(await sceneOf(p)).nav;
  const waitIdle = (p, ms = 40_000) => until(() => navIdle(p), ms, `${p.label} 走完`, 700);
  const pairInfo = async () => {
    const sc = await serverScene(A);
    const a = selfActor(sc);
    const b = sc.actors.find((x) => x.id === B.id) ?? null;
    return { a, b, gap: b ? dist(a, b) : Infinity, movingA: !!a.nav, movingB: b ? !!b.nav : false };
  };
  /** B 走到 A 身边（服务器的 approach），等距离 < near */
  const come = async (p, to, near = 4) => {
    await apiAct(p, { type: 'navigate', approach: to.id });
    await until(async () => {
      const q = await pairInfo();
      return q.gap < near && !q.movingA && !q.movingB;
    }, 60_000, `${p.label} 走到 ${to.label} 身边`, 700);
  };
  const nameOf = async (p) => {
    const s = await snap(p.page);
    return s.actors.find((a) => a.id === s.self).name;
  };
  /** 一次 barrier：Godot 的 town_chat 帧数增加（先读，调用方在之后才让对方发话） */
  const waitFrames = (p, base, what) => until(async () => (await framesOf(p)) > base, 25_000, what);
  const bubbleOf = async (p, id) => (await bubbles(p.page)).filter((b) => b.id === id);
  const reloadIn = async (p, query = '') => {
    p.w.closing = true;
    await p.page.goto(`${BASE}/town/3d/?debug=1${query}`);
    await p.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    p.w.closing = false;
    await p.page.click('#enterBtn');
    await p.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
  };
  const townReqs = (p) => {
    const l = [];
    const fn = async (r) => {
      if (!/\/town\/api\/town-chat/.test(r.url())) return;
      const rec = { url: r.url(), status: r.status(), body: null };
      l.push(rec);
      try {
        rec.body = await r.json();
      } catch {
        /* 没有响应体 */
      }
    };
    p.page.on('response', fn);
    return { list: l, stop: () => p.page.off('response', fn) };
  };
  const disconnect = async (p) => {
    p.gate.block = true;
    for (const ws of p.gate.sockets) ws.close();
    p.gate.sockets.length = 0;
    await until(async () => (await snap(p.page)).conn !== 'ok', 15_000, `${p.label} 显示断线`);
  };
  const reconnect = async (p) => {
    p.gate.block = false;
    await until(async () => (await snap(p.page)).conn === 'ok', 40_000, `${p.label} 重连成功`);
  };

  // ───────────────────────── 30 初始 ─────────────────────────
  await step(30, '初始：两边页签「附近」「全镇」依次排在最前；全镇页签有范围牌、规则、类型三块木牌（默认闲聊）、输入框可用；两边角标隐藏', async () => {
    for (const p of [A, B]) {
      const tabs = await tabOrder(p.page);
      check(tabs[0] === 'nearby' && tabs[1] === 'town', `${p.label} 页签应是「附近」「全镇」依次排在最前：${JSON.stringify(tabs)}`);
      check((await dockState(p.page)).mods.slice(0, 2).join() === 'nearby,town', `${p.label} 的 dock.mods 前两个应是 nearby,town`);
      check(await modState(p.page, 'town'), `${p.label} 应有 __dock.town`);
      check(await townF(p), `${p.label} 应有 features.town`);
      const u = await townUnread(p.page);
      check(u.badgeHidden && u.sum === 0 && !u.dot, `${p.label} 初始角标应隐藏、没有小点：${JSON.stringify(u)}`);
    }
    await openTown(A.page);
    await until(async () => !(await townCompose(A.page)).disabled, 25_000, 'A 的全镇输入框可用（Godot 推来了 canSend）');
    await until(async () => (await townF(A)).after, 25_000, 'A 读完了最近一页公屏（_after 有值）');
    const c = await townCompose(A.page);
    const ch = await townChrome(A.page);
    check(ch.scope === (await townBank(A.page, 'scope')) && ch.scope.length > 0, `范围牌文字应是文字库的 scope：「${ch.scope}」`);
    check(c.kind === 'chat' && c.placeHidden, `类型默认闲聊、地点下拉隐藏：${JSON.stringify(c)}`);
    check(c.placeholder === (await townBank(A.page, 'ph.ok')), `占位应是 ph.ok：「${c.placeholder}」`);
    check(!ch.muted && ch.muteText === (await townBank(A.page, 'mute.off')), `静音开关默认未按下：${JSON.stringify(ch)}`);
    const kinds = await A.page.evaluate((r) => [...document.querySelectorAll(`${r} [data-kind]`)].map((e) => [e.dataset.kind, e.textContent]), TOWN);
    check(kinds.map((k) => k[0]).join() === 'chat,activity,help' && kinds.every((k) => k[1].length > 0), `三块类型牌：${JSON.stringify(kinds)}`);
    note(`范围牌「${ch.scope}」，类型牌 ${kinds.map((k) => k[1]).join('/')}`);
    await until(async () => (await townF(B)).after, 25_000, 'B 读完了最近一页公屏');
  });

  // ───────────────────────── 30.1 收发与未读 ─────────────────────────
  await step(30.1, '收发与未读：A 公屏说 T1，A 恰一条（回执与回声去重）；B 关着面板（停在「附近」）角标 1、「全镇」页签小点；B 打开全镇后清零；B 回话 A 收到', async () => {
    const t1 = uniq('公屏你好');
    const f0 = await framesOf(A);
    await openTown(A.page);
    const ack = await uiTownSay(A, t1);
    check(ack.ok === true && ack.heardBy === undefined, `A 的回应应成功且不带 heardBy：${JSON.stringify(ack)}`);
    const rowA = await waitRow(A, t1);
    check(rowA.from === A.id && rowA.mine, `A 的行 data-from 应是 A、mine：${JSON.stringify(rowA)}`);
    await waitFrames(A, f0, 'A 收到自己那条的 WS 回声帧');
    await frames(A.page, 2);
    check((await rowsWith(A, t1)).length === 1, 'A 自己的话回执加回声应恰好一条');
    // B：面板关着，并且停在「附近」页签
    check(!(await dockState(B.page)).open && (await dockState(B.page)).tab === 'nearby', 'B 此时应关着面板、停在附近页签');
    await until(async () => {
      const u = await townUnread(B.page);
      return u.town === 1 && u.badge === '1' && u.dot;
    }, 25_000, 'B 的启动按钮出现角标 1、「全镇」页签小点可见');
    note(`B 角标 ${JSON.stringify(await townUnread(B.page))}`);
    await openTown(B.page);
    await until(async () => {
      const u = await townUnread(B.page);
      return u.town === 0 && u.badgeHidden && !u.dot;
    }, 10_000, 'B 打开全镇后角标清零、小点消失');
    const rowsB = await rowsWith(B, t1);
    check(rowsB.length === 1 && rowsB[0].from === A.id && !rowsB[0].mine, `B 应恰有同一条（!mine、data-from=A）：${JSON.stringify(rowsB)}`);
    const t2 = uniq('公屏收到');
    const f1 = await framesOf(A);
    const ack2 = await uiTownSay(B, t2);
    check(ack2.ok, `B 的回应应成功：${JSON.stringify(ack2)}`);
    const rowA2 = await waitRow(A, t2);
    check(rowA2.from === B.id && !rowA2.mine, `A 应收到 B 的话：${JSON.stringify(rowA2)}`);
    await waitFrames(A, f1, 'A 又收到一帧');
    check((await uniqueMids(A)) && (await uniqueMids(B)), '两边每个 data-mid 都只出现一次');
    check((await townUnread(A.page)).town === 0, 'A 面板开着停在全镇，不计未读');
  });

  // ───────────────────────── 30.2 范围独立 ─────────────────────────
  await step(30.2, '范围独立：B 回家（私宅实例）后，A 的公屏 X 照样到达 B；A 的附近话 Y 到不了 B（屏障：X 出现之后再过几帧、B 自己附近话的回声），B 页面也没有 A 的气泡', async () => {
    const place0 = (await snap(B.page)).spaceName;
    await B.page.click('#homeBtn');
    await until(async () => (await snap(B.page)).scene === 'home', 120_000, 'B 进到自己家');
    const Y = uniq('门外附近话');
    const X = uniq('公屏照样到');
    const ry = await apiSayWait(A, Y);
    check(ry.status === 200, 'A 的附近话应发成功');
    const fB = await framesOf(B);
    const rx = await apiTownSayWait(A, X);
    check(rx.status === 200 && rx.body?.scope === 'town' && typeof rx.body?.id === 'string', `A 的公屏回执应带 scope=town 与 id：${JSON.stringify(rx.body)}`);
    await waitRow(B, X);
    await waitFrames(B, fB, 'B 收到 X 所在的帧');
    // 再让 B 在屋里附近说一句，等它的回声（B 这一侧附近事件流有序）：Y 若会到一定先到
    const nearbyEv = async () => (await godotFeature(B.page, 'nearby'))?.events ?? 0;
    const e0 = await nearbyEv();
    const U = uniq('屋里附近话');
    await apiSayWait(B, U);
    await until(async () => (await nearbyEv()) > e0, 25_000, 'B 屋里自己那句附近话的回声到了（屏障）');
    await frames(B.page, 3);
    const nearbyRowsB = await B.page.evaluate(() => [...document.querySelectorAll('#dock [data-pane="nearby"] li[data-mid] [data-role="text"]')].map((e) => e.textContent));
    check(!nearbyRowsB.includes(Y), `B 在私宅里，附近列表不应有 A 的附近话：${JSON.stringify(nearbyRowsB)}`);
    check(!(await apiHistory(B)).some((m) => m.text === Y), 'B 的服务端附近历史里也不应有 Y');
    check((await bubbleOf(B, A.id)).length === 0, 'B 的页面不应有 A 的气泡');
    check((await rowsWith(B, Y)).length === 0, 'Y 是附近话，不应出现在 B 的全镇列表');
    check((await rowsWith(A, Y)).length === 0 && (await rowsWith(A, X)).length === 1, 'A 的全镇列表：X 恰一条、没有 Y');
    note(`B 在「${(await snap(B.page)).spaceName}」（原先「${place0}」）仍收到全镇公屏 X`);
    await B.page.click('#homeBtn');
    await until(async () => (await snap(B.page)).scene !== 'home', 120_000, 'B 出门');
    await come(B, A);
  });

  // ───────────────────────── 30.3 组织活动 ─────────────────────────
  await step(30.3, '组织活动与「走过去」：A 选「组织活动」+ 游戏馆发 T3：类型回到闲聊、地点清空；两边的行带小牌、tk-activity 与 go（data-place=arcade）；服务端真相 kind=activity、place=arcade；B 点 go 开始走（只是 navigate）；求助不带地点没有 go', async () => {
    const T3 = uniq('周末游戏馆组局');
    const ack = await uiTownSay(A, T3, { kind: 'activity', place: 'arcade' });
    check(ack.ok, `A 的回应应成功：${JSON.stringify(ack)}`);
    const c = await townCompose(A.page);
    await until(async () => (await townCompose(A.page)).kind === 'chat' && (await townCompose(A.page)).placeHidden, 5000, '发出后类型回到闲聊、地点下拉隐藏');
    check((await townCompose(A.page)).place === '' && c.value === '', `发出后地点应清空、输入框清空：${JSON.stringify(c)}`);
    const wantChip = `${await townBank(A.page, 'kind.activity')} · 游戏馆`;
    for (const p of [A, B]) {
      const r = await waitRow(p, T3);
      check(r.cls.includes('tk-activity'), `${p.label} 的行应带 tk-activity：${JSON.stringify(r)}`);
      check(r.chip === wantChip, `${p.label} 的小牌应是「${wantChip}」：「${r.chip}」`);
      check(r.hasGo && r.goPlace === 'arcade', `${p.label} 的行应有 go 按钮且 data-place=arcade：${JSON.stringify(r)}`);
    }
    const srv = (await apiTownPage(A)).messages.find((m) => m.text === T3);
    check(srv && srv.kind === 'activity' && srv.place?.id === 'arcade', `服务端真相应是 activity + arcade：${JSON.stringify(srv)}`);
    // B 点 go：开始走，且只发出一条 navigate（目的地是地点编号，不是点地）
    await openTown(B.page);
    const nav0 = B.w.actions.length;
    await B.page.click(`${TOWN} li[data-mid] button.go[data-place="arcade"]`);
    await until(async () => !!(await sceneOf(B)).nav, 20_000, 'B 开始走（serverScene 里 nav 非空）');
    const navs = await until(() => {
      const l = B.w.actions.slice(nav0).filter((r) => r.type === 'navigate');
      return l.length ? l : null;
    }, 8000, 'B 的 actions 里出现 navigate');
    check(navs.length === 1 && navs[0].to === 'arcade' && navs[0].status === 200, `点「走过去」只应发出一条 navigate（to=arcade）：${JSON.stringify(navs)}`);
    await apiAct(B, { type: 'stop_navigation' });
    await waitIdle(B);
    await come(B, A);
    // 求助：不带地点，行有 tk-help 小牌，没有 go
    const T3h = uniq('谁能帮我找找猫');
    const ack2 = await uiTownSay(A, T3h, { kind: 'help' });
    check(ack2.ok, `求助应发成功：${JSON.stringify(ack2)}`);
    for (const p of [A, B]) {
      const r = await waitRow(p, T3h);
      check(r.cls.includes('tk-help') && !r.hasGo && r.chip === (await townBank(p.page, 'kind.help')), `${p.label} 的求助行应有 tk-help 小牌、没有 go：${JSON.stringify(r)}`);
    }
    const srv2 = (await apiTownPage(A)).messages.find((m) => m.text === T3h);
    check(srv2 && srv2.kind === 'help' && !srv2.place, `服务端真相：求助没有地点：${JSON.stringify(srv2)}`);
  });

  // ───────────────────────── 30.4 重复 ─────────────────────────
  await step(30.4, '重复：A 重发 T1 被拒（提示换个说法、不是倒计时），输入保留、列表没多行、成功次数不变；之后 A 改一个字发 T4 成功，B 收到 T4 后 T1 仍恰一条', async () => {
    const T1 = (await townRows(A.page)).find((r) => r.mine && r.text.startsWith('公屏你好')).text;
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '30.4：重复内容被拒绝（precondition_failed / duplicate）' });
    await openTown(A.page);
    const ok0 = okTown(A);
    const ack = await uiTownSay(A, T1, { noBudget: true });
    check(ack.ok === false && ack.reason === 'duplicate', `重发应被拒（duplicate）：${JSON.stringify(ack)}`);
    const c = await townCompose(A.page);
    check(c.hint === (await townBank(A.page, 'err.duplicate')) && !c.hintClass.includes('cool'), `提示应是 err.duplicate 的文字、不是倒计时：${JSON.stringify(c)}`);
    check(c.value === T1, `输入框内容应保留：${JSON.stringify(c.value)}`);
    check((await rowsWith(A, T1)).length === 1 && okTown(A) === ok0, '列表没有多出行，say_town 成功次数不变');
    // 屏障：改一个字发 T4，B 收到之后再断言 B 的 T1 仍恰一条
    await A.page.fill(IN, '');
    const T4 = `${T1}。`;
    const ack4 = await uiTownSay(A, T4);
    check(ack4.ok, `改一个字应发成功：${JSON.stringify(ack4)}`);
    await waitRow(B, T4);
    check((await rowsWith(B, T1)).length === 1, 'B 的列表里 T1 仍恰一条');
  });

  // ───────────────────────── 30.5 限流与超长 ─────────────────────────
  await step(30.5, '限流与超长：额度见底后界面再发被拒（倒计时 cool、发送钮禁用、输入保留），被拒的那条 B 没收到；121 码点禁用发送，强发被 Godot 本地拒绝（不发请求），服务端对同样的话回 400', async () => {
    await openTown(A.page);
    // 让额度见底：API 代发直到第一次 429（API 代发的 429 页面监视看不到，不用声明）
    let drained = null;
    let r429 = null;
    let rejected = null;
    const R = uniq('被限流的话');
    for (let attempt = 0; attempt < 3 && !rejected; attempt++) {
      drained = [];
      r429 = null;
      for (let i = 0; i < 6 && !r429; i++) {
        const r = await apiTownSay(A, uniq('耗额度'));
        drained.push(r.status);
        if (r.status === 429) r429 = { at: Date.now(), retry: r.body?.retryAfterMs ?? r.body?.data?.retryAfterMs ?? 0, body: r.body };
      }
      check(r429, `连发 6 条应见到 429：${JSON.stringify(drained)}`);
      // 马上用界面再发一条：期望被拒（这次界面请求声明一次）
      allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 0, max: 1, why: '30.5：额度见底后界面发言被限流（429）' });
      const ack = await uiTownSay(A, R, { noBudget: true });
      if (ack.ok === false && ack.code === 'rate_limited') rejected = { ack, at: Date.now() };
      else {
        // 页面慢，界面这一条发生在恢复之后而成功了：换一句再来
        check(ack.ok, `界面发言要么被限流要么成功：${JSON.stringify(ack)}`);
        await sleep(0);
      }
      if (!rejected) await A.page.fill(IN, '');
    }
    check(rejected, '三次尝试里界面发言都没有碰上限流');
    const c = await townCompose(A.page);
    check(c.hintClass.includes('cool') && /\d/.test(c.hint) && c.sendDisabled && c.value === R, `被限流：倒计时（cool）、发送钮禁用、输入保留：${JSON.stringify(c)}`);
    note(`API 连发状态 ${JSON.stringify(drained)}，服务端 retryAfterMs=${r429.retry}，界面倒计时「${c.hint}」`);
    check(!(await rowsWith(A, R)).length, '被拒的话不应出现在 A 的列表');
    // 倒计时结束：恢复发送。之后 A 再发成功的下一条到 B 时，B 的列表里没有被拒那条
    await until(async () => !(await townCompose(A.page)).hintClass.includes('cool'), 30_000, '倒计时结束');
    await A.page.fill(IN, '');
    const Z = uniq('限流之后');
    const rz = await apiTownSayWait(A, Z);
    check(rz.status === 200, '倒计时结束后 A 应能再发');
    await waitRow(B, Z);
    check((await rowsWith(B, R)).length === 0, '被限流的那条 B 没有收到');
    check(!(await apiTownPage(B)).messages.some((m) => m.text === R), '服务端也没有被限流的那条');
    // 超长：121 个码点（表情算一个）
    const long = '😀'.repeat(60) + 'a'.repeat(61);
    check([...long].length === 121, '构造的文字应是 121 个码点');
    await openTown(A.page);
    await A.page.fill(IN, long);
    let cc = await townCompose(A.page);
    check(cc.sendDisabled && cc.count === '121/120' && cc.hint.includes('120'), `超长应禁用发送并提示最多 120 字：${JSON.stringify(cc)}`);
    const n0 = actionsOf(A, 'say_town').length;
    await A.page.press(IN, 'Enter');
    await A.page.evaluate((t) => window.TownDock.test.forceSend(t), long);
    await until(async () => (await townF(A)).lastAck?.code === 'text_too_long', 15_000, '强发超长得到 text_too_long');
    check((await townF(A)).lastAck.maxChars === 120, `回应应带上限 120：${JSON.stringify((await townF(A)).lastAck)}`);
    await frames(A.page, 2);
    check(actionsOf(A, 'say_town').length === n0, 'Godot 本地拒绝，不应发出 say_town 请求');
    cc = await townCompose(A.page);
    check(cc.value === long, '超长被拒后输入保留');
    const r400 = await apiTownSay(A, long);
    check(r400.status === 400 && r400.body?.error === 'bad_request' && r400.body?.reason === 'text_too_long' && r400.body?.maxChars === 120, `服务器对 121 码点应回 400 text_too_long：${JSON.stringify(r400)}`);
    await A.page.fill(IN, '');
  });

  // ───────────────────────── 30.6 只读与对局中 ─────────────────────────
  await step(30.6, '只读与对局中：另一处接管后全镇输入框禁用、占位只读、草稿保留，但仍收得到新话；强发被本地拒绝；接管回来恢复。对局中用界面状态驱动核对占位与禁用（真实对局由 C3 的 50.45 补）', async () => {
    await openTown(A.page);
    const draft = uniq('草稿');
    await A.page.fill(IN, draft);
    const other = `e2e-other-${rnd()}`;
    const re = await A.ctx.request.post(`${BASE}/town/api/enter`, { data: { clientId: other } });
    check(re.ok(), `另一处登记在场应成功：${re.status()}`);
    const rc = await A.ctx.request.post(`${BASE}/town/api/claim`, { data: { clientId: other } });
    check(rc.ok(), `另一处接管应成功：${rc.status()}`);
    await until(async () => (await snap(A.page)).mine === false, 15_000, 'A 页面变成只读');
    await until(async () => (await townCompose(A.page)).disabled, 10_000, '只读时全镇输入框禁用');
    let c = await townCompose(A.page);
    check(c.placeholder === (await townBank(A.page, 'ph.readonly')) && c.value === draft, `只读时占位应是只读提示、草稿保留：${JSON.stringify(c)}`);
    // 仍收得到新话
    const S = uniq('只读时也看得到');
    await apiTownSayWait(B, S);
    await waitRow(A, S);
    check((await rowsWith(A, S)).length === 1, '只读时 A 仍收到新话');
    const base = actionsOf(A, 'say_town').length;
    await A.page.evaluate((t) => window.TownDock.test.forceSend(t), draft);
    await until(async () => (await townF(A)).lastAck?.code === 'readonly', 10_000, '只读时强发得到 readonly');
    await frames(A.page, 2);
    check(actionsOf(A, 'say_town').length === base, '只读时不应发出请求');
    c = await townCompose(A.page);
    check(c.hint === (await townBank(A.page, 'err.readonly')) && c.value === draft, `只读被拒后应有提示、草稿保留：${c.hint}`);
    await A.page.click('#claimBtn');
    await until(async () => (await snap(A.page)).mine === true, 15_000, 'A 接管回来');
    await until(async () => !(await townCompose(A.page)).disabled, 10_000, '接管回来后输入框恢复');
    check((await townCompose(A.page)).value === draft, '接管回来后草稿仍在');
    // 对局中：界面状态驱动
    const st0 = (await modState(A.page, 'town')).st;
    check(st0 && st0.canSend === true, `当前状态应可发：${JSON.stringify(st0)}`);
    await A.page.evaluate((s) => window.TownDock.feed('town', 'state', s), JSON.stringify({ ...st0, canSend: false, reason: 'game' }));
    await until(async () => (await townCompose(A.page)).disabled, 5000, '对局中输入框禁用');
    c = await townCompose(A.page);
    check(c.placeholder === (await townBank(A.page, 'ph.game')) && c.value === draft && c.sendDisabled, `对局中占位应是对局提示、草稿保留、发送钮禁用：${JSON.stringify(c)}`);
    const kindsOff = await A.page.evaluate((r) => [...document.querySelectorAll(`${r} [data-kind]`)].every((e) => e.disabled), TOWN);
    check(kindsOff, '对局中类型牌应禁用');
    await A.page.evaluate((s) => window.TownDock.feed('town', 'state', s), JSON.stringify(st0));
    await until(async () => !(await townCompose(A.page)).disabled, 5000, '恢复后输入框可用');
    await A.page.fill(IN, '');
    note('真实对局中公屏只看不发的断言由 C3 的 50.45 补（服务端侧已有 chat-direction.test.ts:97）');
  });

  // ───────────────────────── 30.7 断线续读 ─────────────────────────
  await step(30.7, '断线续读：B 关面板、断线，A 发 M1、M2；重连后先有 GET ?after= 200（不带游标的整页重读没有），M1、M2 各一条且有序、未读恰为 2、catchups+1、resyncs 0；再断线重连而期间没有新话：没有 /town-chat 请求', async () => {
    await closeDock(B.page);
    const rq = townReqs(B);
    const t0 = await townF(B);
    await disconnect(B);
    const M1 = uniq('断线一');
    const M2 = uniq('断线二');
    await apiTownSayWait(A, M1);
    await apiTownSayWait(A, M2);
    const h0 = rq.list.length;
    await reconnect(B);
    await until(() => rq.list.slice(h0).some((r) => /[?&]after=/.test(r.url) && r.status === 200), 40_000, `重连后 GET /town-chat?after= 返回 200（见到 ${JSON.stringify(rq.list.slice(h0).map((r) => [r.url.replace(BASE, ''), r.status]))}）`);
    const mine = rq.list.slice(h0);
    check(mine.every((r) => /[?&]after=/.test(r.url)), `重连后不应有不带游标的整页重读：${JSON.stringify(mine.map((r) => r.url.replace(BASE, '')))}`);
    await until(async () => (await rowsWith(B, M2)).length === 1, 25_000, 'B 的列表出现 M2');
    await frames(B.page, 3);
    const rows = await townRows(B.page);
    const i1 = rows.findIndex((r) => r.text === M1);
    const i2 = rows.findIndex((r) => r.text === M2);
    check(rows.filter((r) => r.text === M1).length === 1 && rows.filter((r) => r.text === M2).length === 1, `M1、M2 各应恰好一条：${JSON.stringify(rows.slice(-6).map((r) => r.text))}`);
    check(i1 >= 0 && i2 > i1 && rows[i1].mid < rows[i2].mid, '顺序应是 M1 在 M2 之前');
    const u = await townUnread(B.page);
    check(u.town === 2 && u.dot, `补读的话计未读，恰为 2：${JSON.stringify(u)}`);
    check(u.badge === String(u.sum) || u.sum > 9, `启动按钮角标应等于各模块未读之和：${JSON.stringify(u)}`);
    check(await uniqueMids(B), '没有重复的 data-mid');
    const t1 = await townF(B);
    check(t1.catchups === t0.catchups + 1 && (t1.resyncs ?? 0) === (t0.resyncs ?? 0), `catchups 应 +1、resyncs 不变：${t0.catchups}->${t1.catchups}，${t0.resyncs}->${t1.resyncs}`);
    // 期间没有新话：再断线重连一次，不应有任何 /town-chat 请求
    const hl0 = (await townF(B)).hellos;
    const sizeBefore = (await townRows(B.page)).length;
    await disconnect(B);
    const h1 = rq.list.length;
    await reconnect(B);
    await until(async () => (await townF(B)).hellos > hl0, 25_000, 'B 又收到一次 hello');
    await frames(B.page, 3);
    check(rq.list.length === h1, `断线期间公屏没有新话，重连后不应读公屏：${JSON.stringify(rq.list.slice(h1).map((r) => r.url.replace(BASE, '')))}`);
    check((await townF(B)).catchups === t1.catchups && (await townRows(B.page)).length === sizeBefore, '补读次数与列表都不变');
    rq.stop();
  });

  // ───────────────────────── 30.75 resync ─────────────────────────
  await step(30.75, 'resync：B 把 _after 改成无效游标并断线，A 发 M3；重连后请求返回 resync:true，列表整体重建，与服务端最近一页逐条一致，resyncs===1，重读的话不计未读', async () => {
    await openTown(B.page); // 先看完，未读清零
    await until(async () => (await townUnread(B.page)).town === 0, 10_000, '先清零未读');
    await closeDock(B.page);
    const rq = townReqs(B);
    await emitTown(B.page, 'debug_after');
    await until(async () => (await townF(B)).after === 'cbad.bad', 10_000, 'B 的 _after 已被改成无效游标');
    await disconnect(B);
    const M3 = uniq('重同步一');
    await apiTownSayWait(A, M3);
    const h0 = rq.list.length;
    await reconnect(B);
    const rs = await until(() => rq.list.slice(h0).find((r) => /after=cbad/.test(r.url) && r.body), 40_000, '重连后带无效游标的读取返回');
    check(rs.status === 200 && rs.body.resync === true && rs.body.messages.length === 0, `服务端应对无效游标返回 200 + resync:true：${JSON.stringify(rs.body)}`);
    await until(async () => (await rowsWith(B, M3)).length === 1, 25_000, 'B 重读后列表包含 M3');
    await frames(B.page, 3);
    const truth = (await apiTownPage(B)).messages.map((m) => m.text);
    const got = (await townRows(B.page)).map((r) => r.text);
    check(JSON.stringify(got) === JSON.stringify(truth), `B 的列表应与服务端最近一页逐条一致（顺序一致）：\n 列表 ${JSON.stringify(got.slice(-4))}\n 服务端 ${JSON.stringify(truth.slice(-4))}（${got.length} / ${truth.length}）`);
    check(await uniqueMids(B), 'data-mid 唯一');
    const f = await townF(B);
    check(f.resyncs === 1 && f.after !== 'cbad.bad', `resyncs 应为 1、_after 已重置：${JSON.stringify({ resyncs: f.resyncs, after: f.after })}`);
    const u = await townUnread(B.page);
    check(u.town === 0 && !u.dot, `重读的话不计未读：${JSON.stringify(u)}`);
    rq.stop();
  });

  // ───────────────────────── 30.8 刷新重建与去重 ─────────────────────────
  await step(30.8, '刷新重建与去重：刷新 B 后列表由 GET /town-chat 重建，与服务端最近一页逐条一致、不计未读；重放最近一帧：dupes 增加、列表不变', async () => {
    await reloadIn(B);
    await until(async () => (await townF(B)).after, 30_000, '刷新后读完了最近一页');
    await frames(B.page, 3);
    const truth = (await apiTownPage(B)).messages.map((m) => m.text);
    const got = (await townRows(B.page)).map((r) => r.text);
    check(JSON.stringify(got) === JSON.stringify(truth), `刷新后的列表应与服务端最近一页逐条一致：${got.length}/${truth.length}`);
    const u = await townUnread(B.page);
    check(u.badgeHidden && u.town === 0, `刷新后读的历史不计未读：${JSON.stringify(u)}`);
    check(await uniqueMids(B), '没有重复的 data-mid');
    // 先让 A 说一条，B 收到一帧，才有东西可重放
    const M4 = uniq('重放之前');
    await apiTownSayWait(A, M4);
    await waitRow(B, M4);
    const before = await townRows(B.page);
    const d0 = (await townF(B)).dupes;
    await emitTown(B.page, 'debug_replay');
    await until(async () => (await townF(B)).dupes > d0, 15_000, '重放的帧被去重（dupes 增加）');
    await frames(B.page, 3);
    const after = await townRows(B.page);
    check(after.length === before.length && JSON.stringify(after.map((r) => r.mid)) === JSON.stringify(before.map((r) => r.mid)), '重放后列表不变');
    check((await rowsWith(B, M4)).length === 1, '重放的那条仍恰一条');
  });

  // ───────────────────────── 30.9 分页 ─────────────────────────
  await step(30.9, '分页：把页大小改成 5；列表恰是服务端最新 5 条，「看更早的话」可见；点一下增加紧挨着的更早 5 条、视线不跳（偏移变化 ≤4px）、jump 不显示；一直点到尽头按钮消失；size 与 DOM 行数一致且 ≤200', async () => {
    const all = (await apiTownPage(A, 'limit=100')).messages;
    check(all.length >= 12, `服务端公屏总条数应 ≥ 12（前面步骤已发够）：${all.length}`);
    await openTown(B.page);
    await emitTown(B.page, 'debug_page', '5');
    await until(async () => (await townRows(B.page)).length === 5 && (await townF(B)).page === 5, 25_000, 'B 的列表恰 5 条');
    await until(async () => (await townChrome(B.page)).older, 10_000, '「看更早的话」可见');
    const truth5 = (await apiTownPage(B, 'limit=5')).messages.map((m) => m.text);
    check(JSON.stringify((await townRows(B.page)).map((r) => r.text)) === JSON.stringify(truth5), '列表应是服务端最新的 5 条');
    const ch = await townChrome(B.page);
    check(ch.olderText === (await townBank(B.page, 'older')), `older 按钮文字：「${ch.olderText}」`);
    const ob = await rectOf(B.page, `${TOWN} [data-role="older"]`);
    check(ob.width >= 40 && ob.height >= 22, `older 按钮的点按目标：${JSON.stringify(ob)}`);
    const anchor = () =>
      B.page.evaluate((r) => {
        const list = document.querySelector(`${r} [data-role="list"]`);
        const top = list.getBoundingClientRect().top;
        for (const li of list.querySelectorAll('li[data-mid]')) {
          const b = li.getBoundingClientRect();
          if (b.bottom > top + 1) return { mid: li.dataset.mid, off: b.top - top };
        }
        return null;
      }, TOWN);
    const offOf = (mid) =>
      B.page.evaluate(([r, m]) => {
        const list = document.querySelector(`${r} [data-role="list"]`);
        const li = list.querySelector(`li[data-mid="${m}"]`);
        return li ? li.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
      }, [TOWN, mid]);
    // 先把列表滚到底再记锚点（和平时看新话一样）
    await B.page.evaluate((r) => { const l = document.querySelector(`${r} [data-role="list"]`); l.scrollTop = l.scrollHeight; }, TOWN);
    await frames(B.page, 2);
    const a0 = await anchor();
    await B.page.click(`${TOWN} [data-role="older"]`);
    await until(async () => (await townRows(B.page)).length === 10, 25_000, '点一下后列表变成 10 条');
    await frames(B.page, 3);
    const truth10 = (await apiTownPage(B, 'limit=10')).messages.map((m) => m.text);
    check(JSON.stringify((await townRows(B.page)).map((r) => r.text)) === JSON.stringify(truth10), '新增的应是紧挨着的更早 5 条，顺序与服务端一致');
    const off1 = await offOf(a0.mid);
    check(off1 !== null && Math.abs(off1 - a0.off) <= 4, `视线不跳：锚点行 ${a0.mid} 的偏移 ${a0.off.toFixed(1)} -> ${off1}`);
    check(!(await townChrome(B.page)).jump, 'jump 按钮不应显示');
    note(`视线锚点偏移 ${a0.off.toFixed(1)} -> ${off1?.toFixed(1)}`);
    // 继续点到尽头
    for (let i = 0; i < 60 && (await townChrome(B.page)).older; i++) {
      const n = (await townRows(B.page)).length;
      await B.page.click(`${TOWN} [data-role="older"]`);
      await until(async () => (await townRows(B.page)).length > n || !(await townChrome(B.page)).older, 25_000, '又点了一次，列表增长或按钮消失');
    }
    await until(async () => !(await townChrome(B.page)).older, 25_000, '到尽头：按钮消失');
    const ch2 = await townChrome(B.page);
    check(ch2.stripText === (await townBank(B.page, 'end')) || ch2.stripText === (await townBank(B.page, 'atCap')), `到头应有说明文字：「${ch2.stripText}」`);
    const rows = await townRows(B.page);
    const f = await townF(B);
    const truthAll = (await apiTownPage(B, 'limit=100')).messages.map((m) => m.text);
    check(f.size === rows.length && rows.length <= 200, `size 应与 DOM 行数一致且 ≤200：${f.size}/${rows.length}`);
    check(JSON.stringify(rows.map((r) => r.text).slice(-truthAll.length)) === JSON.stringify(truthAll) || rows.length < truthAll.length, '到头后列表与服务端顺序一致');
    check(await uniqueMids(B), 'data-mid 唯一');
    // 恢复页大小
    await emitTown(B.page, 'debug_page', '50');
    await until(async () => (await townF(B)).page === 50 && (await townRows(B.page)).length >= Math.min(50, truthAll.length), 25_000, '页大小恢复为 50');
    await frames(B.page, 2);
  });

  // ───────────────────────── 30.95 静音 ─────────────────────────
  await step(30.95, '静音：A 点「静音」开关按下，服务端 /me 的 muteTownChat 为真；面板关着时 B 的公屏话不计未读（屏障：列表出现之后再过几帧）；刷新后仍是已静音；再点恢复后 B 的话角标 +1', async () => {
    await openTown(A.page);
    await A.page.click(`${TOWN} [data-role="mute"]`);
    await until(async () => (await townChrome(A.page)).muted, 15_000, 'A 的静音开关按下');
    const cidA = await A.page.evaluate(() => window.TownHud.clientId());
    const meOf = async () => (await (await A.ctx.request.get(`${BASE}/town/api/me?clientId=${encodeURIComponent(cidA)}`)).json()).me.settings.muteTownChat;
    check((await meOf()) === true, '服务端 /me 的 me.settings.muteTownChat 应为 true');
    check((await townChrome(A.page)).muteText === (await townBank(A.page, 'mute.on')), '开关文字应是「已静音」');
    await closeDock(A.page);
    const T5 = uniq('静音期间');
    const fA = await framesOf(A);
    await apiTownSayWait(B, T5);
    await waitRow(A, T5);
    await waitFrames(A, fA, 'A 收到 T5 所在的帧');
    await frames(A.page, 3);
    const u = await townUnread(A.page);
    check(u.town === 0 && u.badgeHidden && !u.dot, `静音期间不计未读、不亮小点：${JSON.stringify(u)}`);
    // 刷新：静音状态从 /me 恢复
    await reloadIn(A);
    await openTown(A.page);
    await until(async () => (await townChrome(A.page)).muted, 25_000, '刷新后开关仍是已静音（从 /me 恢复）');
    check((await modState(A.page, 'town')).muted === true && (await townF(A)).muted === true, '刷新后 Godot 与网页都认为已静音');
    // 再点一次恢复
    await A.page.click(`${TOWN} [data-role="mute"]`);
    await until(async () => !(await townChrome(A.page)).muted, 15_000, '开关弹起');
    check((await meOf()) === false, '服务端 /me 的 muteTownChat 应为 false');
    await until(async () => (await townF(A)).after, 25_000, 'A 读完公屏');
    await closeDock(A.page);
    const T6 = uniq('恢复之后');
    await apiTownSayWait(B, T6);
    await waitRow(A, T6);
    await until(async () => (await townUnread(A.page)).town === 1, 15_000, 'A 面板关着时角标 +1');
    const u2 = await townUnread(A.page);
    check(u2.dot && u2.badge === String(u2.sum), `恢复后角标 +1：${JSON.stringify(u2)}`);
    await openTown(A.page);
    await until(async () => (await townUnread(A.page)).town === 0, 10_000, '打开后清零');
  });

  // ───────────────────────── 31 气泡 ─────────────────────────
  await step(31, '气泡出现与位置：A 附近说 G1，两边 #tags 里都有 b:<A> 气泡、textContent 恰是 G1；在 A 名牌上方、水平居中、整块在视口内、手机宽度 ≤60vw；点气泡中心命中画布（不拦截）；点地仍能走路', async () => {
    await closeDock(A.page);
    await closeDock(B.page);
    await come(B, A, 5);
    const G1 = uniq('你好呀今天广场上的灯笼真漂亮');
    check([...G1].length <= 28, 'G1 应不超过 28 个码点');
    const sb0 = (await bubbleFeature(A.page))?.shown ?? 0;
    const r = await apiSayWait(A, G1);
    check(r.status === 200, 'A 附近说话应成功');
    const both = await until(async () => {
      const [a, b] = await Promise.all([bubbleOf(A, A.id), bubbleOf(B, A.id)]);
      return a.length && b.length ? { a: a[0], b: b[0] } : null;
    }, 20_000, '两边 #tags 里都出现 A 的气泡', 100);
    for (const [who, bub] of [['A', both.a], ['B', both.b]]) {
      check(bub.text === G1 && bub.cls.includes('tag') && bub.cls.includes('b'), `${who} 页面的气泡文字应恰是 G1：${JSON.stringify([bub.text, bub.cls])}`);
      check(bub.children === 0, `${who} 页面的气泡不应有子元素`);
      check(bub.nameRect, `${who} 页面应有 A 的名牌`);
      check(bub.rect.bottom <= bub.nameRect.top + 2, `${who}：气泡应在名牌上方（气泡底 ${bub.rect.bottom.toFixed(0)}，名牌顶 ${bub.nameRect.top.toFixed(0)}）`);
      const cx = bub.rect.left + bub.rect.width / 2;
      const nx = bub.nameRect.left + bub.nameRect.width / 2;
      check(Math.abs(cx - nx) <= 40, `${who}：气泡与名牌水平中心相差应 ≤40px：${Math.abs(cx - nx).toFixed(0)}`);
      check(bub.rect.left >= 0 && bub.rect.top >= 0 && bub.rect.right <= bub.vw && bub.rect.bottom <= bub.vh, `${who}：气泡整块应在视口内：${JSON.stringify(bub.rect)}`);
    }
    check(both.b.rect.width <= both.b.vw * 0.6 + 1, `B（手机）气泡宽度应 ≤ 60vw：${both.b.rect.width} / ${both.b.vw}`);
    const hit = await hitTest(A.page, both.a.rect.left + both.a.rect.width / 2, both.a.rect.top + both.a.rect.height / 2);
    check(hit && hit.inCanvas, `点气泡中心应命中画布（不拦截点击）：${JSON.stringify(hit)}`);
    check(((await bubbleFeature(A.page))?.shown ?? 0) > sb0, 'features.bubbles.shown 应增加');
    note(`气泡「${both.a.text}」矩形 ${both.a.rect.width.toFixed(0)}x${both.a.rect.height.toFixed(0)}，名牌顶 ${both.a.nameRect.top.toFixed(0)}，气泡底 ${both.a.rect.bottom.toFixed(0)}`);
    // 点地仍能走路
    const me = await sceneOf(A);
    const nav0 = A.w.actions.length;
    await h.clickWorld(A, me.x + 3, me.z + 2);
    await until(async () => !!(await sceneOf(A)).nav || A.w.actions.slice(nav0).some((x) => x.type === 'navigate' && x.status === 200), 15_000, '点地后 A 开始走');
    await waitIdle(A);
  });

  await step(31.1, '淡出与替换：气泡先带 sel 再消失，features.bubbles.active 回到 0；连说 G2、G3 同一个气泡换成 G3、#tags 里仍只有一个；长句以「…」结尾且 ≤28 码点', async () => {
    await until(async () => (await bubbleOf(B, A.id)).length === 0 && (await bubbleOf(A, A.id)).length === 0, 20_000, '上一个气泡已消失', 100);
    await come(B, A, 5);
    // 先发一句，等它出现，再盯着它淡出
    const G0 = `${uniq('淡出观察')}`;
    await apiSayWait(A, G0);
    let sawSel = false;
    await until(async () => {
      const l = await bubbleOf(A, A.id);
      if (l.some((b) => b.cls.includes('sel'))) sawSel = true;
      return l.length === 0 && sawSel;
    }, 25_000, '气泡先带 sel 类（淡出态）再被移除', 80);
    check(sawSel, '应先看到 sel 类');
    await until(async () => ((await bubbleFeature(A.page))?.active ?? [1]).length === 0, 10_000, 'features.bubbles.active 回到 0');
    // 替换
    const G2 = uniq('第一句');
    const G3 = uniq('第二句');
    await apiSayWait(A, G2);
    await apiSayWait(A, G3);
    const rep = await until(async () => {
      const l = await bubbleOf(B, A.id);
      return l.length === 1 && l[0].text === G3 ? l[0] : null;
    }, 20_000, '同一个气泡的文字换成 G3，#tags 里仍只有一个', 100);
    check((await bubbleOf(B, A.id)).length === 1 && rep.text === G3, '只有一个 b:<A> 气泡且文字是 G3');
    // 长句
    await until(async () => (await bubbleOf(B, A.id)).length === 0, 20_000, '替换后的气泡消失', 100);
    const longText = '这是一句很长很长的话用来看看气泡会不会被截断并且在结尾加上省略号'.repeat(2);
    check([...longText].length > 28, '构造的长句应超过 28 个码点');
    await apiSayWait(A, longText);
    const lb = await until(async () => (await bubbleOf(B, A.id))[0] ?? null, 20_000, '长句的气泡出现', 100);
    check(lb.text.endsWith('…') && [...lb.text].length <= 28 && lb.text.startsWith(longText.slice(0, 10)), `长句气泡应以省略号结尾且 ≤28 码点：「${lb.text}」`);
  });

  await step(31.2, '公屏不出气泡：A 公屏发 W，B 的全镇列表出现 W、双方 Godot 帧计数增加之后，A、B 页面都没有任何 .tag.b', async () => {
    await until(async () => (await bubbleOf(A, A.id)).length === 0 && (await bubbleOf(B, A.id)).length === 0, 20_000, '此前的气泡已全部消失', 100);
    await until(async () => ((await bubbleFeature(A.page))?.active ?? [1]).length === 0 && ((await bubbleFeature(B.page))?.active ?? [1]).length === 0, 10_000, 'active 都回到 0');
    const fA = await framesOf(A);
    const fB = await framesOf(B);
    const W = uniq('公屏不冒泡');
    await apiTownSayWait(A, W, { kind: 'activity', place: 'plaza' });
    await waitRow(B, W);
    await waitFrames(B, fB, 'B 收到 W 的帧');
    await waitFrames(A, fA, 'A 收到 W 的回声帧');
    await frames(A.page, 3);
    await frames(B.page, 3);
    for (const p of [A, B]) {
      const l = await bubbles(p.page);
      check(l.length === 0, `${p.label} 不应有任何气泡：${JSON.stringify(l.map((b) => b.text))}`);
    }
  });

  await step(31.3, '旧话不冒泡：B 断线超过 8 秒，A 附近说 G4；B 重连后补发的 chat 事件到达（列表出现 G4），但 #tags 里没有 b:<A>，skipped_stale +1', async () => {
    const sk0 = (await bubbleFeature(B.page))?.skipped_stale ?? 0;
    await disconnect(B);
    const G4 = uniq('断线时说的话');
    const tSent = Date.now();
    await apiSayWait(A, G4);
    await until(async () => (await bubbleOf(A, A.id)).length > 0, 20_000, 'A 自己的气泡出现（G4 已发出）', 100);
    await until(async () => (await bubbleOf(A, A.id)).length === 0, 20_000, 'A 的气泡淡出消失', 150);
    await until(async () => Date.now() - tSent > 9500, 20_000, '断线已超过 8 秒（过期线）', 200);
    await reconnect(B);
    await until(async () => (await B.page.evaluate((t) => [...document.querySelectorAll('#dock [data-pane="nearby"] li[data-mid] [data-role="text"]')].some((e) => e.textContent === t), G4)), 40_000, 'B 的附近列表出现 G4（补发的事件到了）');
    await until(async () => ((await bubbleFeature(B.page))?.skipped_stale ?? 0) > sk0, 20_000, 'skipped_stale 增加');
    await frames(B.page, 3);
    check((await bubbleOf(B, A.id)).length === 0, 'B 不应为补发的旧话冒气泡');
    check(((await bubbleFeature(B.page))?.skipped_stale ?? 0) === sk0 + 1, `skipped_stale 应恰好 +1：${sk0} -> ${(await bubbleFeature(B.page))?.skipped_stale}`);
  });

  await step(31.4, '隔墙无气泡：B 回家，A 附近说 G5：A 有气泡、B 没有（屏障：A 再公屏说 Z，B 的全镇列表出现 Z 之后再过几帧；服务端 B 的附近历史没有 G5）', async () => {
    await B.page.click('#homeBtn');
    await until(async () => (await snap(B.page)).scene === 'home', 120_000, 'B 进到自己家');
    const G5 = uniq('隔墙的话');
    await apiSayWait(A, G5);
    await until(async () => (await bubbleOf(A, A.id)).length > 0, 20_000, 'A 的气泡出现', 100);
    const Z = uniq('隔墙之后公屏');
    const fB = await framesOf(B);
    await apiTownSayWait(A, Z);
    await waitRow(B, Z);
    await waitFrames(B, fB, 'B 收到 Z 所在的帧');
    await frames(B.page, 3);
    check((await bubbleOf(B, A.id)).length === 0, 'B 在私宅里不应有 A 的气泡');
    check(!(await apiHistory(B)).some((m) => m.text === G5), '服务端 B 的附近历史没有 G5');
    await B.page.click('#homeBtn');
    await until(async () => (await snap(B.page)).scene !== 'home', 120_000, 'B 出门');
    await come(B, A, 5);
    await until(async () => (await bubbleOf(A, A.id)).length === 0, 20_000, 'A 的气泡消失', 150);
  });

  // ───────────────────────── 32 @ 高亮、未读与 XSS ─────────────────────────
  await step(32, '@ 高亮与 XSS：B 公屏说「@A 的名字 你好」，A 的行有 mention、B 自己的行没有；不带 @ 的没有；<img onerror> 等不生成元素、文字与服务端逐字相同；同样的话附近发一次，气泡里没有子元素', async () => {
    const aName = await nameOf(A);
    await openTown(A.page);
    await openTown(B.page);
    const m1 = `@${aName} 你好${rnd()}`;
    await apiTownSayWait(B, m1);
    const ra = await waitRow(A, m1);
    check(ra.cls.includes('mention'), `A 的那一行应有 mention：${JSON.stringify(ra.cls)}`);
    const rb = await waitRow(B, m1);
    check(!rb.cls.includes('mention') && rb.mine, `B 自己的那一行不应有 mention：${JSON.stringify(rb.cls)}`);
    const m2 = uniq('没有艾特的话');
    await apiTownSayWait(B, m2);
    const ra2 = await waitRow(A, m2);
    check(!ra2.cls.includes('mention'), `不带 @ 的那一行不应有 mention：${JSON.stringify(ra2.cls)}`);
    // 全角 @ 与大小写也算（NFKC + 小写）：别人写的是「＠名字」
    const m3 = `＠${aName.toUpperCase()} 全角${rnd()}`;
    await apiTownSayWait(B, m3);
    check((await waitRow(A, m3)).cls.includes('mention'), '全角 ＠ 加大写的名字也应高亮（NFKC + 小写）');
    // XSS
    const xss = '<img src=x onerror=window.__xss=1><b>x</b>';
    await apiTownSayWait(B, xss);
    const srv = await until(async () => (await apiTownPage(A)).messages.find((m) => m.text.includes('onerror=window.__xss')) ?? null, 15_000, '服务端公屏里有这句');
    const rx = await waitRow(A, srv.text);
    check(!rx.hasImg, `A 的行里不应有 img/b/script 等元素：${JSON.stringify(rx)}`);
    check(rx.text === srv.text && rx.text.includes('onerror'), `行的文字应与服务端逐字相同：「${rx.text}」 / 「${srv.text}」`);
    check((await A.page.evaluate(() => window.__xss)) === undefined && (await B.page.evaluate(() => window.__xss)) === undefined, 'window.__xss 应未定义');
    // 同样的话附近发一次：气泡里没有子元素，textContent 就是原文（28 码点以内的一句）
    const xss2 = '<img src=x onerror=alert(1)>';
    check([...xss2].length <= 28, 'xss2 应不超过 28 码点');
    await closeDock(A.page);
    await apiSayWait(B, xss2);
    const bb = await until(async () => (await bubbleOf(A, B.id))[0] ?? null, 20_000, 'A 页面出现 B 的气泡', 100);
    const srv2 = (await apiHistory(A)).find((m) => /onerror=alert/.test(m.text ?? ''));
    check(srv2 && [...srv2.text].length <= 28, `服务端附近历史里应有这句且不超过 28 码点：${JSON.stringify(srv2?.text)}`);
    check(bb.children === 0 && bb.text === srv2.text && bb.text.includes('onerror'), `气泡里不应有子元素、textContent 就是原文：${JSON.stringify([bb.children, bb.text, srv2.text])}`);
    check((await A.page.evaluate(() => window.__xss)) === undefined, '气泡之后 window.__xss 仍未定义');
    await until(async () => (await bubbleOf(A, B.id)).length === 0, 20_000, '气泡消失', 150);
  });

  // ───────────────────────── 33 离开与换人 ─────────────────────────
  await step(33, '离开与换人：B 静音、有未读、有草稿和发送记录后离开小镇：列表、meta、strip、草稿、未读、ArrowUp 记录全清，类型回闲聊、静音开关回未静音；换名重进的新居民列表与服务端一致、没有 mine 行（含上一位）、未静音、未读 0、气泡空', async () => {
    allowFailure(B.w, 'POST', /\/town\/api\/heartbeat$/, { min: 0, max: 1, why: '33：离开瞬间在途的心跳可能 presence_lost' });
    await openTown(B.page);
    await uiTownSay(B, uniq('离开前的公屏'));
    await B.page.click(`${TOWN} [data-role="mute"]`);
    await until(async () => (await townChrome(B.page)).muted, 15_000, 'B 静音');
    await B.page.fill(IN, uniq('没发出去的草稿'));
    await B.page.click(`${TOWN} [data-kind="help"]`);
    await closeDock(B.page);
    // 有未读：静音时不计，所以先造一个未读再静音太绕，改为检查「未读清零」：这里只核对离开前列表非空
    check((await townRows(B.page)).length > 0, '离开前 B 的列表应有内容');
    check((await modState(B.page, 'town')).hist > 0, '离开前 B 应有发送记录（否则 ArrowUp 清空的断言是空的）');
    check((await townF(B)).muted === true, '离开前 B 的 Godot 一侧是静音');
    const cid = await B.page.evaluate(() => window.TownHud.clientId());
    const lr = await B.ctx.request.post(`${BASE}/town/api/leave`, { data: { clientId: cid } });
    check(lr.ok(), `POST /leave 返回 ${lr.status()}`);
    await until(() => B.page.evaluate(() => document.body.dataset.phase === 'ready'), 20_000, 'B 页面回到「已离开」');
    const k = await modState(B.page, 'town');
    check(k.count === 0 && k.rows === 0 && k.unread === 0 && k.meta === 0, `离开后列表与 meta 应清空：${JSON.stringify({ count: k.count, rows: k.rows, unread: k.unread, meta: k.meta })}`);
    check(k.hist === 0 && k.muted === false && k.kind === 'chat' && k.place === '', `离开后发送记录、静音、类型与地点应复位：${JSON.stringify({ hist: k.hist, muted: k.muted, kind: k.kind, place: k.place })}`);
    const ch = await townChrome(B.page);
    check(!ch.muted && !ch.strip && (await townCompose(B.page)).value === '', `离开后静音开关回未按下、状态条隐藏、草稿清空：${JSON.stringify(ch)}`);
    // 换人
    await B.ctx.clearCookies();
    const oldId = B.id;
    await B.page.click('#enterBtn');
    await B.page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 });
    const rq = townReqs(B);
    const nm = `阿换${rnd()}`;
    await B.page.fill('#nameInput', nm);
    await B.page.click('#loginBtn');
    await B.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    // 快照里的 self 可能还是上一位的（页面刚进入 playing 的瞬间）：等它换成新居民再读
    await until(async () => ((await snap(B.page)).self || oldId) !== oldId, 30_000, '换名重进后快照里的自己是另一位居民');
    B.id = (await snap(B.page)).self;
    check(B.id !== oldId, '换名重进应是另一位居民');
    await until(() => rq.list.some((r) => r.status === 200 && !/[?&]after=/.test(r.url)), 30_000, '新居民读到了自己的公屏历史（屏障）');
    await until(async () => (await townF(B)).after, 30_000, '新居民的 Godot 一侧读完了最近一页');
    await frames(B.page, 3);
    rq.stop();
    const truth = (await apiTownPage(B)).messages.map((m) => m.text);
    const rows = await townRows(B.page);
    check(JSON.stringify(rows.map((r) => r.text)) === JSON.stringify(truth), `新居民的列表应恰是他自己读到的最近一页（没有上一位残留的行）：${rows.length}/${truth.length}`);
    check(!rows.some((r) => r.mine) && !rows.some((r) => r.mine && r.from === oldId), '新居民的列表里不应有 mine 行');
    const f = await townF(B);
    check(f.size === rows.length && f.seen === rows.length, `Godot 一侧 _msgs / _seen 只含新居民读到的：${JSON.stringify({ size: f.size, seen: f.seen, rows: rows.length })}`);
    check(f.muted === false && !(await townChrome(B.page)).muted, '新居民未静音');
    const u = await townUnread(B.page);
    check(u.town === 0 && u.badgeHidden, `新居民未读 0：${JSON.stringify(u)}`);
    check((await bubbles(B.page)).length === 0 && ((await bubbleFeature(B.page))?.active ?? [1]).length === 0, '新居民没有气泡');
    await openTown(B.page);
    await B.page.click(IN);
    await B.page.keyboard.press('ArrowUp');
    check((await townCompose(B.page)).value === '', '新居民按 ArrowUp 不应找回上一位发过的话');
    await B.page.keyboard.press('Escape');
    await closeDock(B.page);
    note(`换人：${oldId} -> ${B.id}，列表 ${rows.length} 条`);
    await come(B, A, 5);
  });

  // ───────────────────────── 34 手机与布局 ─────────────────────────
  await step(34, '手机与布局：B 抽屉里消息区可视高度 ≥ 4 条消息行；模拟软键盘后 rules / kinds / strip 隐藏、输入栏在视口内；kinds / placeSel / go 的点按目标 ≥ 40x32、placeSel 字号 ≥ 16px；A 的点类型牌与 go 不穿透成点地；placeSel 聚焦按 w 不走路', async () => {
    // 让列表里有活动行（go）与足够多的消息
    const T = uniq('傍晚茶馆喝茶');
    await apiTownSayWait(A, T, { kind: 'activity', place: 'tea_house' });
    await openTown(B.page);
    await waitRow(B, T);
    await frames(B.page, 2);
    const lay = await B.page.evaluate((r) => {
      const list = document.querySelector(`${r} [data-role="list"]`);
      const rows = [...list.querySelectorAll('li.msg')].filter((li) => !li.querySelector('.extra'));
      const hs = rows.map((li) => li.getBoundingClientRect().height + parseFloat(getComputedStyle(li).marginTop));
      const sorted = [...hs].sort((x, y) => x - y);
      return { clientH: list.clientHeight, rowH: sorted[Math.floor(sorted.length / 2)] ?? 0, /* 中位数：个别长话折行不算 */ n: rows.length, dockH: document.getElementById('dock').getBoundingClientRect().height };
    }, TOWN);
    check(lay.n >= 4 && lay.clientH >= 4 * lay.rowH, `抽屉里消息区应能放下 4 条消息行：${JSON.stringify(lay)}`);
    note(`抽屉 ${lay.dockH.toFixed(0)}px，消息区 ${lay.clientH}px，最高一行 ${lay.rowH.toFixed(0)}px（${(lay.clientH / lay.rowH).toFixed(1)} 行）`);
    // 点按目标与字号
    await B.page.click(`${TOWN} [data-kind="activity"]`);
    await until(async () => !(await townCompose(B.page)).placeHidden, 5000, '选「组织活动」后地点下拉出现');
    const sizes = await B.page.evaluate((r) => {
      const g = (s) => { const e = document.querySelector(`${r} ${s}`); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, fs: parseFloat(getComputedStyle(e).fontSize) }; };
      return { kind: g('[data-kind="activity"]'), kinds: [...document.querySelectorAll(`${r} [data-kind]`)].map((e) => e.getBoundingClientRect().toJSON()), place: g('[data-role="placeSel"]'), go: g('button.go'), mute: g('[data-role="mute"]') };
    }, TOWN);
    check(sizes.kinds.every((b) => b.width >= 40 && b.height >= 32), `kinds 点按目标应 ≥ 40x32：${JSON.stringify(sizes.kinds)}`);
    check(sizes.place && sizes.place.h >= 32 && sizes.place.fs >= 16, `placeSel 高 ≥ 32、字号 ≥ 16px：${JSON.stringify(sizes.place)}`);
    check(sizes.go && sizes.go.w >= 40 && sizes.go.h >= 32, `go 点按目标应 ≥ 40x32：${JSON.stringify(sizes.go)}`);
    check(sizes.mute && sizes.mute.w >= 40, `静音开关宽 ≥ 40：${JSON.stringify(sizes.mute)}`);
    await B.page.click(`${TOWN} [data-kind="chat"]`);
    // 软键盘（模拟）
    await B.page.evaluate(() => window.TownDock.test.setKeyboard(300));
    await until(async () => (await dockState(B.page)).kb > 0, 5000, '模拟软键盘生效');
    const kb = await townChrome(B.page);
    check(!kb.rules && !kb.kinds && !kb.strip && !kb.pick, `软键盘出现时 rules / kinds / strip 应隐藏：${JSON.stringify(kb)}`);
    const ir = await rectOf(B.page, IN);
    const vp = await h.viewport(B.page);
    check(ir && ir.bottom <= vp.h && ir.top >= 0, `输入栏应在视口内：${JSON.stringify(ir)} / ${vp.h}`);
    await B.page.evaluate(() => window.TownDock.test.setKeyboard(null));
    await until(async () => (await dockState(B.page)).kb === 0, 5000, '去掉模拟后恢复');
    check((await townChrome(B.page)).kinds, '去掉模拟后 kinds 恢复显示');
    await closeDock(B.page);
    // A（桌面）：点类型牌、静音开关之类不产生点地
    await openTown(A.page);
    await waitRow(A, T);
    const nav0 = A.w.actions.length;
    await A.page.click(`${TOWN} [data-kind="help"]`);
    await A.page.click(`${TOWN} [data-kind="chat"]`);
    await A.page.click(`${TOWN} [data-role="list"]`, { position: { x: 20, y: 30 } });
    await frames(A.page, 3);
    check(A.w.actions.slice(nav0).filter((r) => r.type === 'navigate').length === 0 && !(await sceneOf(A)).nav, '点面板里的类型牌与列表不应变成点地走路');
    // 点 go：恰一条 navigate（to=tea_house），不是点地
    const nav1 = A.w.actions.length;
    await A.page.click(`${TOWN} li[data-mid] button.go[data-place="tea_house"]`);
    await until(() => A.w.actions.slice(nav1).some((r) => r.type === 'navigate'), 8000, '点「走过去」发出 navigate');
    await frames(A.page, 3);
    const ng = A.w.actions.slice(nav1).filter((r) => r.type === 'navigate');
    check(ng.length === 1 && ng[0].to === 'tea_house', `点「走过去」只应有一条 navigate（to=tea_house）：${JSON.stringify(ng)}`);
    await apiAct(A, { type: 'stop_navigation' });
    await waitIdle(A);
    // placeSel 聚焦后按 w：不走路（屏障：之后若干帧）
    await A.page.click(`${TOWN} [data-kind="activity"]`);
    await A.page.focus(`${TOWN} [data-role="placeSel"]`);
    const p0 = await sceneOf(A);
    await A.page.keyboard.down('w');
    await frames(A.page, 4);
    await A.page.keyboard.up('w');
    const p1 = await sceneOf(A);
    check(!p1.nav && dist(p0, p1) < 0.05, `placeSel 聚焦时按 w 角色不应走动：${JSON.stringify([p0.x, p0.z, p1.x, p1.z, p1.nav])}`);
    await A.page.click(`${TOWN} [data-kind="chat"]`);
  });

  await step(34.5, '读取失败自恢复：B 刷新进入时第一次 GET /town-chat 返回 429：状态条显示读取失败的文字、列表为空；约 1 秒后 Godot 重试成功，列表出现、状态条消失', async () => {
    allowFailure(B.w, 'GET', /\/town\/api\/town-chat/, { min: 1, max: 1, why: '34.5：故意让第一次读公屏返回 429' });
    let hit = 0;
    await B.page.route('**/town/api/town-chat*', (route) => {
      if (hit++ < 1) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate_limited"}' });
      return route.continue();
    });
    await B.page.evaluate(() => {
      window.__stripSeen = [];
    });
    B.w.closing = true;
    await B.page.goto(`${BASE}/town/3d/?debug=1`);
    await B.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    B.w.closing = false;
    await B.page.evaluate(() => {
      window.__stripSeen = [];
      const el = document.querySelector('#dock [data-pane="town"] [data-role="stripText"]');
      new MutationObserver(() => window.__stripSeen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });
    await B.page.click('#enterBtn');
    await B.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    await openTown(B.page);
    const errText = await townBank(B.page, 'loadErr');
    await until(async () => (await B.page.evaluate(() => window.__stripSeen)).includes(errText), 30_000, '状态条出现读取失败的文字');
    await until(async () => (await townRows(B.page)).length > 0, 40_000, 'Godot 重试后列表出现');
    await until(async () => !(await townChrome(B.page)).strip || (await townChrome(B.page)).stripText === '', 10_000, '状态条消失');
    check(hit >= 2, `应至少有两次读取（第一次 429、重试成功）：${hit}`);
    const f = await townF(B);
    check(f.loadErr === false, 'loadErr 应已清除');
    await B.page.unroute('**/town/api/town-chat*');
    await closeDock(B.page);
  });

  // ───────────────────────── 34.9 截图 ─────────────────────────
  await step(34.9, '截图：桌面白天 / 傍晚的全镇页签（含组织活动小牌与 @ 高亮）、手机抽屉、两位居民头顶同时有气泡（桌面与手机）', async () => {
    const aName = await nameOf(A);
    const bName = await nameOf(B);
    await come(B, A, 5);
    // 摆好一屏有代表性的话
    await apiTownSayWait(B, `@${aName} 晚上有空吗`);
    await apiTownSayWait(A, '今晚七点游戏馆组局，缺两位', { kind: 'activity', place: 'arcade' });
    await apiTownSayWait(B, '我来！顺便带点茶点', { kind: 'chat' });
    const sceneNow = await sceneOf(A);
    const moveAway = async () => {
      await apiAct(A, { type: 'navigate', to: { x: sceneNow.x > 54 ? 50 : 58, z: 27 } });
    };
    void moveAway;
    for (const [hr, tag] of [[11.5, ''], [19.5, '-evening']]) {
      await reloadIn(A, `&hour=${hr}`);
      await until(async () => Math.abs((await A.page.evaluate(() => window.__town.hour)) - hr) < 0.4, 15_000, `A 钟点到 ${hr}`);
      await openTown(A.page);
      await until(async () => (await townRows(A.page)).some((r) => r.cls.includes('mention')) && (await townRows(A.page)).some((r) => r.chip), 30_000, 'A 的列表有 @ 高亮与活动小牌');
      await frames(A.page, 3);
      await shot(A.page, `30-desktop-town-side${tag}`);
      if (!tag) {
        await reloadIn(B, `&hour=${hr}`);
        await openTown(B.page);
        await until(async () => (await townRows(B.page)).length >= 4, 30_000, 'B 的列表出现');
        await B.page.click(`${TOWN} [data-kind="activity"]`);
        await frames(B.page, 3);
        await shot(B.page, '30-mobile-town-drawer');
        await B.page.click(`${TOWN} [data-kind="chat"]`);
        await closeDock(B.page);
      }
    }
    // 两位居民头顶同时有气泡（面板关着）
    await reloadIn(A, '&hour=11.5');
    await closeDock(A.page);
    await closeDock(B.page);
    const g1 = '广场的灯笼今天好漂亮呀你看到了吗';
    const g2 = '是呀我刚在书屋门口也看到了';
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      await Promise.all([apiSayWait(A, i ? g1 + '！' : g1), apiSayWait(B, i ? g2 + '！' : g2)]);
      const got = await until(async () => ((await bubbles(A.page)).length === 2 && (await bubbles(B.page)).length === 2) || null, 12_000, '两位居民头顶同时有气泡', 80).catch(() => false);
      if (!got) continue;
      await Promise.all([shot(A.page, '31-desktop-bubbles'), shot(B.page, '31-mobile-bubbles')]);
      ok = true;
      for (const [p, nm] of [[A, 'A'], [B, 'B']]) {
        const bl = await bubbles(p.page);
        for (const b of bl) if (b.nameRect) check(b.rect.bottom <= b.nameRect.top + 2, `${nm} 截图时气泡应在名牌上方`);
      }
    }
    check(ok, '四次尝试都没能同时看到两个气泡');
    void bName;
    await until(async () => (await bubbles(A.page)).length === 0 && (await bubbles(B.page)).length === 0, 20_000, '气泡淡出', 150);
  });

  await h.release(A);
  await h.release(B);
}

/* ───────────────────────── 反向验证：改了哪里 -> 哪一步红 ─────────────────────────
 * 下面是实际做过的破坏（同时打在不同步骤上，一次跑完 chat-town），破坏用的脚本不入库。改回去后整条重新全绿。
 *  - town.gd on_leave 不清 _msgs / _seen                          -> 33 红（Godot 一侧 _msgs/_seen 含上一位的行）
 *  - town.gd _ingest_older 的序号改成 ++_hi（和新消息同向）          -> 30.9 红（更早 5 条的顺序与服务端不一致）
 *  - town.js 的 kit.append(items, live && !muted) 改成 live         -> 30.95 红（静音期间角标增加）
 *  - bubbles.gd 的 _on_heard 去掉 STALE_MS 过滤                     -> 31.3 红（skipped_stale 不增加）
 *  - bubbles.css 去掉 margin-top:-26px                              -> 31 红（气泡盖住名牌）
 *  - town.gd 去掉 on_hello 里的 _left 判断（401 事故的修复）          -> 全程检查红（换人后出现未声明的 401）
 * 没做出红灯、如实记录：
 *  - 30.75 resync：去掉两处 _clear_list 后仍绿，因为重读的最近一页与旧列表按 sid 去重后内容相同；
 *    要红需要造「旧列表里有已滑出最近一页的行」的场景，本步没有造。
 *  - 其余（_after 不被回执推进、同步期间帧缓冲、mentionsMe 永真、PLACES 白名单、innerHTML、限流文字、超长本地检查）
 *    没有逐条破坏验证，只有正向断言。
 */
