// C2：共同活动（一起喝茶、读书）。A 桌面 1440x900，B 手机 390x844 触摸，C 桌面 1000x700（旁观者，同时是读书的发起人）。
// 步骤号都是数字（40.95 是「40.9 之后的一步」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言按那里写的做过反向验证（没做出红灯的如实记录）。
//
// 时间：端到端起引擎时把共同活动缩短了（client-e2e.mjs 的 TOWN_PARAMS）：十分钟的喝茶约 45 秒、报名最长保留 25 秒。
// 所以「开桌 + 加入」要在 25 秒内完成，走开前的提示、取消、开始之后的各项检查要在 45 秒内做完：每个子步骤都先做最要紧的断言，
// 截图放在不赶时间的地方（第二桌凑齐之后、开始之前再截，开始之后只截一张傍晚的）。
import { dockState, godotFeature, closeDock, rectOf, rectsOverlap } from '../lib/ui.mjs';
import { T1, T2, SHELF, T1_SEATS, T2_SEATS, SHELF_SEATS, nearestSeat, dist2, meView, objOf, forceAct, actionButtons, hasAction, findAction, tagTexts, toastTexts, act, pane, openActivity, clickObject, settle, goPlace } from '../lib/activity.mjs';

export const meta = { id: 'activity', n: 40, title: '共同活动' };

export default async function run(h) {
  const { check, note, until, sleep, step, shot, allowFailure, selfActor, serverScene, snap, clickWorld, walkTo, rnd, BASE, townParams } = h;
  const LOBBY_MS = townParams.activityLobbyTtlMs;
  // 喝茶时长 600 秒（content.ts 的 INTERACTIONS）乘开服参数 interactionTimeScale（interact.ts 的 actualDurationSeconds：四舍五入、至少 1 秒）
  const TEA_MS = Math.max(1, Math.round(600 * townParams.interactionTimeScale)) * 1000;
  const { A, B } = await h.pair();
  let C = null;
  let nameCServer = '';
  const nameC = `阿读<i>x</i>${rnd().slice(0, 3)}`;
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);
  const posOf = async (p) => selfActor(await serverScene(p));
  const nameOf = (p) => p.name;
  const tag = (p, oid = T1) => tagTexts(p.page).then((l) => l.find((x) => x.id === `c:${oid}`) ?? null);
  const godotTags = async (p) => (await act(p))?.tags ?? [];
  const sitting = async (p) => (await act(p))?.sitting ?? [];
  const toastHas = async (p, re) => (await toastTexts(p.page)).some((t) => re.test(t));
  const waitToast = (p, re, what, ms = 15_000) => until(async () => ((await toastHas(p, re)) ? true : null), ms, `${p.label} 的提示里出现 ${what}`, 120);
  const left = (me) => (me.interaction?.lobbyExpiresAt ?? 0) - Date.now();
  const reloadIn = async (p, query = '') => {
    p.w.closing = true;
    await p.page.goto(`${BASE}/town/3d/?debug=1${query}`);
    await p.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    p.w.closing = false;
    await p.page.click('#enterBtn');
    await p.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    await until(async () => (await snap(p.page)).self === p.id, 20_000, `${p.label} 重新进入后还是原来的居民`, 200);
  };
  const lsKeys = (p) => p.page.evaluate(() => Object.keys(localStorage));
  let keys0 = [];
  const iid = async (p) => objOf(await meView(p), T1)?.active?.id ?? null;
  const pickRec = async (p) => (await godotFeature(p.page, '_pick')) ?? null;

  // ───────────────────────── 40 进茶馆、初始 ─────────────────────────
  await step(40, '进茶馆、初始：「一起」页签在；两张茶桌空着；#actions 里没有共同活动按钮，没有桌牌', async () => {
    await reloadIn(A, '&hour=12'); // 白天（截图用）：钟点只在页面加载时从地址栏读
    await reloadIn(B, '&hour=12');
    keys0 = [...(await lsKeys(A)), ...(await lsKeys(B))];
    await Promise.all([goPlace(h, A, 'tea_house'), goPlace(h, B, 'tea_house')]);
    for (const p of [A, B]) {
      const d = await dockState(p.page);
      check(d?.mods?.includes('activity'), `${p.label} 的 __dock.mods 里应有 activity：${JSON.stringify(d?.mods)}`);
      check(await p.page.isVisible('#dock [data-tab="activity"]').catch(() => false) || (await p.page.$('#dock [data-tab="activity"]')) !== null, `${p.label} 应有「一起」页签`);
    }
    await openActivity(A.page);
    for (const p of [A, B]) {
      // 场景里同出生点的旧居民清场之后仍用 until 等：两张桌都空着才往下
      await until(async () => {
        const me = await meView(p);
        return objOf(me, T1) && objOf(me, T2) && !objOf(me, T1).active && !objOf(me, T2).active ? me : null;
      }, 20_000, `${p.label} 的服务器视图里两张茶桌都空着`, 300);
    }
    const pa = await until(async () => {
      const d = await pane(A);
      return d && d.tables.length === 2 ? d : null;
    }, 15_000, 'A 的「一起」页签列出两张茶桌');
    check(pa.tables.every((t) => t.status === 'free'), `两张茶桌都应是空着：${JSON.stringify(pa.tables)}`);
    check(pa.tables.some((t) => t.obj === T1) && pa.tables.some((t) => t.obj === T2), `应是 ${T1} 与 ${T2}：${JSON.stringify(pa.tables)}`);
    check(!pa.mine && pa.last === null, `没有活动时不应有「我的这一桌」和「刚才」：${JSON.stringify(pa)}`);
    for (const p of [A, B]) {
      check(!(await actionButtons(p.page)).some((b) => b.id.startsWith('f:activity:')), `${p.label} 离桌子远时 #actions 里不应有共同活动按钮：${JSON.stringify(await actionButtons(p.page))}`);
      check((await tagTexts(p.page)).length === 0, `${p.label} 不应有桌牌：${JSON.stringify(await tagTexts(p.page))}`);
    }
    await closeDock(A.page);
    // 为 40.1 的 E 键让路：E 选的是 8 米内最近的物件或居民，两个人叠在门口时最近的是对方。A 走到柜台前（离茶桌 2 约 6.4 米，离茶桌 1 与 B 都超过 8 米），B 走到西侧
    await Promise.all([walkTo(A, 15.5, 11.2, 0.8, { avoidDock: true }), walkTo(B, 5, 10, 0.8, { avoidDock: true })]);
  });

  // ───────────────────────── 40.1 E 键与点击选座 ─────────────────────────
  await step(40.1, '选座：A 连按两下 E 只发一次导航并走到茶桌 2 的座位上；再点茶桌 1 走到没人站的座位；还没有活动，不坐，出现「约人」按钮', async () => {
    const p0 = await posOf(A);
    check(dist2(p0, { x: 15.5, z: 11.2 }) < 1.5, `A 应在柜台前：${JSON.stringify(p0)}`);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    const n0 = actionsOf(A, 'navigate').length;
    const k0 = (await pickRec(A))?.n ?? 0;
    // 连按两下 E：on_pick 要防重入，只发一次导航（A 在 (15.5,11.2)：茶桌 2 在 (14,5) 约 6.4 米，茶桌 1 与 B 都超过 8 米，所以 E 选中的是茶桌 2）
    await A.page.keyboard.press('KeyE');
    await A.page.keyboard.press('KeyE');
    const rec = await until(async () => {
      const r = await pickRec(A);
      return r && r.n >= k0 + 2 ? r : null;
    }, 20_000, 'on_pick 被问了两次（两下 E）');
    check(rec.kind === 'obj' && rec.id === T2 && rec.src === 'key' && rec.taken === true, `E 键应被「一起」接管：${JSON.stringify(rec)}`);
    await settle(h, A);
    const nav = actionsOf(A, 'navigate').slice(n0);
    check(nav.length === 1 && nav[0].to && typeof nav[0].to === 'object', `连按两下 E 应只发一条走到地图点的 navigate：${JSON.stringify(nav)}`);
    const p1 = await posOf(A);
    const s1 = nearestSeat(p1, T2_SEATS);
    check(s1.d <= 0.5, `E 键之后 A 应站在茶桌 2 的某个座位上（离最近的座位 ${s1.d.toFixed(2)} 米）：${JSON.stringify(p1)}`);
    // 点击：同一条路。茶桌 1 的座位里挑没人站的、离自己最近的
    const k1 = (await pickRec(A)).n;
    await clickObject(A, T1);
    const rec2 = await until(async () => {
      const r = await pickRec(A);
      return r && r.n > k1 ? r : null;
    }, 20_000, '点击茶桌 1 时 on_pick 被问');
    check(rec2.kind === 'obj' && rec2.id === T1 && rec2.src === 'tap' && rec2.taken === true, `点击应被「一起」接管：${JSON.stringify(rec2)}`);
    await settle(h, A);
    const p2 = await posOf(A);
    const s2 = nearestSeat(p2, T1_SEATS);
    check(s2.d <= 0.5, `A 应站在茶桌 1 的某个座位上（离最近的座位 ${s2.d.toFixed(2)} 米）：${JSON.stringify(p2)}`);
    await until(async () => (await findAction(A.page, `f:activity:invite:${T1}`)) ?? null, 15_000, '#actions 里出现「约人」按钮');
    const b = await findAction(A.page, `f:activity:invite:${T1}`);
    check(b.text.includes('约人') && !b.disabled && b.cls.includes('do'), `「约人」按钮应可点：${JSON.stringify(b)}`);
    check(!(await sitting(A)).includes(A.id), `还没有活动，A 不应坐下：${JSON.stringify(await sitting(A))}`);
    const me = await meView(A);
    check(!objOf(me, T1).active && me.interaction === null, '服务器里还没有活动');
  });

  // ───────────────────────── 40.2 约人 ─────────────────────────
  await step(40.2, '约人（A）：服务器 open（2 到 4 人，只有 A）；按钮变灰「等人中 · 还差 1 人」；桌牌「等人 1/2」；A 坐下；页签有「我的这一桌」', async () => {
    const b0 = await findAction(A.page, `f:activity:invite:${T1}`);
    await A.page.click(`#actions [data-action="${b0.id}"]`);
    const me = await until(async () => {
      const m = await meView(A);
      return m.interaction ? m : null;
    }, 10_000, '服务器上出现 A 的活动');
    const it = me.interaction;
    check(it.status === 'open' && it.min === 2 && it.max === 4 && it.objectId === T1, `应是 open、2 到 4 人、茶桌 1：${JSON.stringify(it)}`);
    check(it.participants.length === 1 && it.participants[0].id === A.id, `参与者应只有 A：${JSON.stringify(it.participants)}`);
    note(`报名截止还剩 ${(left(me) / 1000).toFixed(1)} 秒（总 ${(LOBBY_MS / 1000).toFixed(0)} 秒）`);
    const wait = await until(async () => {
      const w = await findAction(A.page, `f:activity:wait:${T1}`);
      return w ?? null;
    }, 10_000, 'A 的按钮变成「等人中」');
    check(wait.disabled && wait.cls.includes('busy') && wait.text.includes('等人中') && wait.sub.includes('还差 1 人'), `按钮应灰着、写「等人中 · 还差 1 人」：${JSON.stringify(wait)}`);
    check(!(await hasAction(A.page, 'f:activity:invite')), '约人按钮应已消失');
    await until(async () => (await A.page.$eval('#activityChip', (e) => !e.hidden)), 8000, '#activityChip 出现');
    const t = await until(async () => (await tag(A)) ?? null, 8000, '桌牌出现');
    check(t.text.includes('等人 1/2'), `桌牌应写「等人 1/2」：${t.text}`);
    await until(async () => (await sitting(A)).includes(A.id), 8000, 'A 坐下');
    const pa = await until(async () => {
      const d = await pane(A);
      return d?.mine ? d : null;
    }, 8000, '页签里出现「我的这一桌」');
    check(pa.status === 'open' && pa.people.length === 1 && pa.people[0] === nameOf(A), `页签应只有 A 一人（名字与服务器逐字相同）：${JSON.stringify(pa.people)} 对 ${nameOf(A)}`);
    check(/\d\d:\d\d/.test(pa.remain), `剩余时间应是 mm:ss：${pa.remain}`);
    const me2 = await meView(A);
    check(Math.abs(pa.remainMs - left(me2)) < 3000, `页签的剩余时间应与服务器的报名截止相差不到 3 秒：页签 ${pa.remainMs} 服务器 ${left(me2)}`);
    await openActivity(A.page);
    check(await A.page.isVisible('#dock [data-pane="activity"] [data-role="mine"]'), '「我的这一桌」应可见');
  });

  // ───────────────────────── 40.3 B 看到但够不着 ─────────────────────────
  await step(40.3, 'B 看到但够不着：页签里这桌「等人 1/2」，没有「加入」按钮，写着「走到桌边才能加入」；桌牌可见；服务器说 near 为假', async () => {
    await openActivity(B.page);
    const row = await until(async () => {
      const d = await pane(B);
      const r = d?.tables.find((x) => x.obj === T1);
      return r && r.text.includes('等人 1/2') ? r : null;
    }, 15_000, 'B 的页签里这张桌「等人 1/2」（屏障：状态已到 B）');
    check(row.status === 'open', `状态应是 open：${JSON.stringify(row)}`);
    check(row.hint.includes('走到桌边'), `应写「走到桌边才能加入」：${JSON.stringify(row)}`);
    check(row.who.includes(nameOf(A)), `应写出座上的人 ${nameOf(A)}：${JSON.stringify(row)}`);
    check(!(await hasAction(B.page, 'f:activity:join')), `B 够不着时不应有「加入」按钮：${JSON.stringify(await actionButtons(B.page))}`);
    check((await godotTags(B)).some((x) => x.includes('等人 1/2')), `B 的桌牌应在：${JSON.stringify(await godotTags(B))}`);
    const t = await until(async () => (await tag(B)) ?? null, 8000, 'B 页面上的桌牌（.tag.c）可见');
    check(t.text.includes('等人 1/2'), `B 的桌牌文字：${t.text}`);
    const me = await meView(B);
    const o = objOf(me, T1);
    check(o.near === false && o.active?.status === 'open', `服务器里 B 离茶桌 1 应够不着：${JSON.stringify(o)}`);
  });

  // ───────────────────────── 40.4 B 选座并加入 ─────────────────────────
  await step(40.4, 'B 选座并加入：走到与 A 不同的座位；出现「加入」；点它；服务器两人；A 收到「加入了」；桌牌「可开始 2/4」；A 有「开始」，B 没有；B 坐下', async () => {
    await clickObject(B, T1);
    await settle(h, B);
    const [pa, pb] = [await posOf(A), await posOf(B)];
    const sa = nearestSeat(pa, T1_SEATS);
    const sb = nearestSeat(pb, T1_SEATS);
    check(sb.d <= 0.5, `B 应站在茶桌 1 的某个座位上（离最近的座位 ${sb.d.toFixed(2)} 米）`);
    check(dist2(pa, pb) >= 1.0 && sa.s !== sb.s, `A 和 B 应站在不同的座位上（相距 ${dist2(pa, pb).toFixed(2)} 米）`);
    const join = await until(async () => (await findAction(B.page, 'f:activity:join:')) ?? null, 15_000, 'B 的 #actions 里出现「加入」');
    const id = await iid(B);
    check(join.id === `f:activity:join:${id}` && join.text.includes('加入'), `加入按钮的编号应取自服务器：${join.id} 对 ${id}`);
    await shot(B.page, '40-mobile-join-button');
    await B.page.tap(`#actions [data-action="${join.id}"]`);
    const me = await until(async () => {
      const m = await meView(A);
      return m.interaction?.participants.length === 2 ? m : null;
    }, 10_000, '服务器上参与者变成两人');
    const ids = me.interaction.participants.map((x) => x.id).sort();
    check(JSON.stringify(ids) === JSON.stringify([A.id, B.id].sort()), `参与者应是 A、B：${JSON.stringify(me.interaction.participants)}`);
    note(`加入完成时报名截止还剩 ${(left(me) / 1000).toFixed(1)} 秒`);
    await waitToast(A, new RegExp(`${nameOf(B)}\\s*加入了`), `「${nameOf(B)} 加入了」`);
    await until(async () => (await godotTags(A)).some((x) => x.includes('可开始 2/4')) && (await godotTags(B)).some((x) => x.includes('可开始 2/4')), 10_000, '两边桌牌都变成「可开始 2/4」');
    for (const p of [A, B]) check(!(await godotTags(p)).some((x) => x.includes('等人')), `${p.label} 的桌牌不应再写「等人」：${JSON.stringify(await godotTags(p))}`);
    const begin = await until(async () => (await findAction(A.page, 'f:activity:begin:')) ?? null, 10_000, 'A 出现「开始」');
    check(!begin.disabled && begin.cls.includes('do') && begin.text.includes('开始'), `A 的「开始」应可点：${JSON.stringify(begin)}`);
    check(!(await hasAction(B.page, 'f:activity:begin')), 'B 不应有「开始」按钮');
    const pb2 = await until(async () => {
      const d = await pane(B);
      return d?.mine && d.people.length === 2 ? d : null;
    }, 10_000, 'B 的页签显示两个人');
    check(pb2.need.includes(nameOf(A)), `B 的页签应写「等 ${nameOf(A)} 开始」：${pb2.need}`);
    await until(async () => (await sitting(B)).includes(B.id), 8000, 'B 坐下');
    check((await sitting(A)).includes(A.id), 'A 仍坐着');
    // 离开前把时钟快的这一桌留着，立刻进入 40.5（报名最长保留 LOBBY_MS）
  });

  // ───────────────────────── 40.5 发起人等人时走开（拦截 + 取消） ─────────────────────────
  await step(40.5, '发起人等人时走开：第一次点地被拦下并提示，没有 navigate；隔一会儿再点才走，整桌取消，B 收到「这一桌散了」并站起', async () => {
    const pos0 = await posOf(A);
    const gx = 11;
    const gz = 8.5;
    const w0 = (await act(A)).warned;
    const p0 = (await act(A)).passed;
    const n0 = A.w.actions.length;
    const ev0 = (await act(A)).events;
    await clickWorld(A, gx, gz, { avoidDock: true });
    await waitToast(A, /再试一次就走/, '「再试一次就走」');
    const tFirst = Date.now();
    const a1 = await act(A);
    check(a1.warned === w0 + 1, `被拦截的次数应加一：${w0} -> ${a1.warned}`);
    check(A.w.actions.slice(n0).filter((r) => r.type === 'navigate').length === 0, '第一次点地不应发出 navigate');
    const m1 = await meView(A);
    check(m1.interaction?.status === 'open', `A 仍应在活动里：${JSON.stringify(m1.interaction)}`);
    const pos1 = await posOf(A);
    check(dist2(pos0, pos1) < 0.05, `A 的位置不应变：${JSON.stringify(pos0)} -> ${JSON.stringify(pos1)}`);
    check(/取消/.test((await toastTexts(A.page)).join('|')), '发起人等人时的提示应说明走开就取消了');
    // 隔开一个新的操作（大于 300 毫秒）再点一次
    while (Date.now() - tFirst < 500) await sleep(50);
    await clickWorld(A, gx, gz, { avoidDock: true });
    await until(() => A.w.actions.slice(n0).find((r) => r.type === 'navigate' && r.status === 200), 10_000, '第二次点地发出了 navigate');
    const m2 = await until(async () => {
      const m = await meView(A);
      return m.interaction === null ? m : null;
    }, 10_000, '服务器上 A 的活动没了');
    check(objOf(m2, T1).active === null, '取消后茶桌 1 应没有活动');
    await waitToast(B, /这一桌散了/, '「这一桌散了」');
    check(await toastHas(B, /这一桌散了：发起人走开了/), `B 的提示应带服务器的原因原文：${JSON.stringify(await toastTexts(B.page))}`);
    await until(async () => (await act(A)).events > ev0, 10_000, 'A 也收到了取消事件（屏障）');
    check(!(await toastHas(A, /这一桌散了/)), `发起人自己走开引起的取消不应再对他自己说一遍：${JSON.stringify(await toastTexts(A.page))}`);
    await until(async () => {
      const d = await pane(B);
      return d && !d.mine && d.people.length === 0 ? d : null;
    }, 10_000, 'B 的页签清空');
    await until(async () => (await tagTexts(B.page)).length === 0 && (await godotTags(B)).length === 0, 10_000, 'B 的桌牌消失');
    await until(async () => !(await sitting(B)).includes(B.id), 10_000, 'B 站起');
    check((await act(A)).passed === p0 + 1, `放行次数应加一：${p0} -> ${(await act(A)).passed}`);
    check((await act(A)).armed === false, '活动没了之后拦截状态应清空');
    await settle(h, A);
  });

  // ───────────────────────── 40.6 角色互换，完整开始 ─────────────────────────
  await step(40.6, '角色互换，完整开始：C 先坐到桌边旁观；B 约人、A 加入、B 开始；服务器 running；桌牌「喝茶 · 2 人」；倒计时在走；C 看到「已开始」', async () => {
    C = await h.newPlayer(h.browsers[0], 'C2-C 桌面', { viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 }, { wsGate: true });
    await h.login(C, nameC, { query: '&hour=19.5' });
    C.id = (await snap(C.page)).self;
    await goPlace(h, C, 'tea_house');
    await clickObject(C, T1);
    await settle(h, C);
    // A 走回桌边：挑没人站的座位（B、C 站着的不选）
    await clickObject(A, T1);
    await settle(h, A);
    const [pa, pb, pc] = [await posOf(A), await posOf(B), await posOf(C)];
    const seats = [pa, pb, pc].map((q) => nearestSeat(q, T1_SEATS));
    check(seats.every((s) => s.d <= 0.5) && new Set(seats.map((s) => `${s.s.x},${s.s.z}`)).size === 3, `A、B、C 应坐在三个不同的座位上：${JSON.stringify(seats.map((s) => [s.s, +s.d.toFixed(2)]))}`);
    // B 约人（报名从这里算起）
    const inv = await until(async () => (await findAction(B.page, `f:activity:invite:${T1}`)) ?? null, 15_000, 'B 出现「约人」');
    await B.page.tap(`#actions [data-action="${inv.id}"]`);
    const join = await until(async () => (await findAction(A.page, 'f:activity:join:')) ?? null, 15_000, 'A 出现「加入」');
    check(join.sub.includes(nameOf(B)), `「加入」的副标题应写发起人 ${nameOf(B)}：${join.sub}`);
    await until(async () => (await findAction(C.page, 'f:activity:join:')) ?? null, 15_000, 'C 旁观时也看到「加入」');
    await A.page.click(`#actions [data-action="${join.id}"]`);
    await until(async () => (await meView(B)).interaction?.participants.length === 2, 10_000, '服务器上两人');
    await waitToast(B, new RegExp(`${nameOf(A)}\\s*加入了`), `「${nameOf(A)} 加入了」`);
    // 凑齐之后、开始之前：白天的两张截图（桌面 A 的「一起」页签、手机 B 的抽屉）
    await openActivity(A.page);
    await openActivity(B.page);
    await until(async () => (await sitting(A)).includes(A.id) && (await sitting(B)).includes(B.id), 8000, 'A、B 都坐着');
    await shot(A.page, '40-desktop-tea-lobby');
    await shot(B.page, '40-mobile-tea-lobby');
    const bBtn = await until(async () => (await findAction(B.page, 'f:activity:begin:')) ?? null, 10_000, 'B 出现「开始」');
    await B.page.tap(`#actions [data-action="${bBtn.id}"]`);
    const me = await until(async () => {
      const m = await meView(B);
      return m.interaction?.status === 'running' ? m : null;
    }, 10_000, '服务器上状态变成 running');
    const it = me.interaction;
    check(typeof it.startedAt === 'number' && Math.abs(it.endsAt - it.startedAt - TEA_MS) <= 5000, `喝茶时长应约 ${TEA_MS} 毫秒：startedAt ${it.startedAt} endsAt ${it.endsAt}`);
    await until(async () => (await godotTags(A)).some((x) => /2 人/.test(x)) && (await godotTags(B)).some((x) => /2 人/.test(x)), 10_000, '两边桌牌都是「喝茶 · 2 人」');
    const tA = await tag(A);
    check(tA && /喝茶 · 2 人/.test(tA.text), `A 的桌牌：${JSON.stringify(tA)}`);
    check(!(await hasAction(A.page, 'f:activity:begin')), 'A 的「开始」按钮应已消失');
    // 傍晚的截图：旁观的 C（固定 19.5 点）看到两个人坐着、桌牌「喝茶 · 2 人」
    await until(async () => (await findAction(C.page, 'f:activity:running:')) ?? null, 15_000, 'C 看到「已开始」');
    check(!(await hasAction(C.page, 'f:activity:join')), 'C 不应再有「加入」');
    await shot(C.page, '40-desktop-tea-running-evening');
    // 页签：状态与倒计时（与服务器的 endsAt 相差不到 3 秒，且在变小）
    const pA = await until(async () => {
      const d = await pane(A);
      return d?.mine && d.status === 'running' ? d : null;
    }, 10_000, 'A 的页签变成进行中');
    const pB = await pane(B);
    check(pB.status === 'running' && pB.need.length > 0, `B 的页签：${JSON.stringify(pB)}`);
    const ends = it.endsAt;
    check(Math.abs(pA.remainMs - (ends - Date.now())) < 3000, `A 的剩余时间应与服务器相差不到 3 秒：${pA.remainMs} 对 ${ends - Date.now()}`);
    check(/\d\d:\d\d/.test(pA.remain), `剩余文字应是 mm:ss：${pA.remain}`);
    check(typeof pA.bar === 'string' && pA.bar.endsWith('%'), `有 startedAt 时应画进度条：${JSON.stringify(pA.bar)}`);
    const r0 = (await pane(A)).remainMs;
    await until(async () => (await pane(A)).remainMs < r0 - 1000, 8000, '倒计时在变小（页签开着，定时器在走）');
    const chip = await B.page.$eval('#activityChip', (e) => ({ hidden: e.hidden, text: e.textContent }));
    check(!chip.hidden && chip.text.length > 0, `B 的活动条应在：${JSON.stringify(chip)}`);
    // 手机布局：抽屉里的按钮区与面板不相交、页签内容不横向滚动
    const ctrl = await rectOf(B.page, '#actions');
    const dock = await rectOf(B.page, '#dock');
    if (ctrl && ctrl.width > 0) check(!rectsOverlap(ctrl, dock), `手机抽屉打开时 #actions 与 #dock 不应相交：${JSON.stringify([ctrl, dock])}`);
    const ctl2 = await rectOf(B.page, '#controls');
    if (ctl2 && ctl2.width > 0) check(!rectsOverlap(ctl2, dock), `#controls 与 #dock 不应相交：${JSON.stringify([ctl2, dock])}`);
    const sw = await B.page.evaluate(() => {
      const e = document.querySelector('#dock [data-pane="activity"] .act-scroll');
      return { sw: e.scrollWidth, cw: e.clientWidth };
    });
    check(sw.sw <= sw.cw, `页签内容不应横向滚动：${JSON.stringify(sw)}`);
    // 失败映射：A 已在活动里，再发起同一张桌 -> 服务器 busy，提示用服务器的原文，参与者没变
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '40.6：A 在活动里再发起同一张茶桌，服务器回 busy（桌子正有人在用）' });
    const na = A.w.actions.length;
    await forceAct(A, `f:activity:invite:${T1}`);
    const rec = await until(() => A.w.actions.slice(na).find((r) => r.type === 'start_interaction' && r.code), 10_000, '被拒的 start_interaction 有回应');
    check(rec.reason === 'busy' && rec.message, `应回 busy：${JSON.stringify(rec)}`);
    await waitToast(A, new RegExp(rec.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '服务器的原文');
    const mm = await meView(B);
    check(mm.interaction.participants.length === 2 && mm.interaction.status === 'running', '被拒之后参与者与状态不应变');
  });

  // ───────────────────────── 40.7 中途走开用键盘 ─────────────────────────
  await step(40.7, '中途走开用键盘（A）：按住 S 第一次被拦（提示「没有这次的收获」，方向帧不增加）；松开再按才走，A 退出，活动照常继续，B 看到「走开了」', async () => {
    const f0 = A.gate.dirFrames.length;
    const w0 = (await act(A)).warned;
    const p0 = (await act(A)).passed;
    const ends0 = (await meView(B)).interaction.endsAt;
    await A.page.keyboard.down('s');
    await waitToast(A, /没有这次的收获/, '「没有这次的收获」');
    const tFirst = Date.now();
    check(A.gate.dirFrames.length === f0, `第一次按 S 被拦下，方向帧不应增加：${f0} -> ${A.gate.dirFrames.length}`);
    check((await meView(A)).interaction?.status === 'running', 'A 仍应在活动里');
    check((await act(A)).warned === w0 + 1, `被拦截的次数应加一（按着不放只算一次）：${w0} -> ${(await act(A)).warned}`);
    await A.page.keyboard.up('s');
    while (Date.now() - tFirst < 500) await sleep(50);
    await A.page.keyboard.down('s');
    await until(() => A.gate.dirFrames.length > f0, 8000, '第二次按 S 发出了方向帧');
    await A.page.keyboard.up('s');
    const me = await until(async () => {
      const m = await meView(B);
      return m.interaction?.participants.length === 1 ? m : null;
    }, 10_000, '服务器上参与者只剩 B');
    check(me.interaction.status === 'running' && me.interaction.endsAt === ends0 && me.interaction.participants[0].id === B.id, `活动应照常继续、endsAt 不变：${JSON.stringify(me.interaction)}`);
    check((await act(A)).passed === p0 + 1, `放行次数应加一：${p0} -> ${(await act(A)).passed}`);
    await waitToast(B, new RegExp(`${nameOf(A)}\\s*走开了`), `「${nameOf(A)} 走开了」`);
    await until(async () => (await godotTags(B)).some((x) => /喝茶 · 1 人/.test(x)), 10_000, 'B 的桌牌变成「喝茶 · 1 人」');
    await settle(h, A);
    await until(async () => !(await sitting(A)).includes(A.id), 8000, 'A 站起');
    const a2 = await act(A);
    check(a2.armed === false && a2.confirmedLeft === 0 && a2.mine === null, `A 的拦截状态应清空：${JSON.stringify(a2)}`);
    // 活动没了之后 A 再按方向键立即能走，不再提示
    const f1 = A.gate.dirFrames.length;
    const wA = a2.warned;
    await A.page.keyboard.down('s');
    await until(() => A.gate.dirFrames.length > f1, 8000, '再按 S 立即发出方向帧');
    await A.page.keyboard.up('s');
    check((await act(A)).warned === wA, '不应再提示');
    await settle(h, A);
  });

  // ───────────────────────── 40.8 一起读书 ─────────────────────────
  await step(40.8, '一起读书（A + C）：C 看到「读书」与「约人读书」且没有「使用中」；A 看到「加入」；C 开始；两边都不坐；名字带 HTML 时页签只有文字；没有新增浏览器存储', async () => {
    await Promise.all([goPlace(h, A, 'bookshop'), goPlace(h, C, 'bookshop')]);
    await clickObject(C, SHELF);
    await settle(h, C);
    const cb = await until(async () => {
      const l = await actionButtons(C.page);
      return l.some((b) => b.id === `do:${SHELF}`) && l.some((b) => b.id === `f:activity:invite:${SHELF}`) ? l : null;
    }, 15_000, 'C 的 #actions 里有「读书」和「约人读书」');
    check(!cb.some((b) => b.id.startsWith('busy:')), `没有活动时不应有「使用中」：${JSON.stringify(cb)}`);
    const inv = cb.find((b) => b.id === `f:activity:invite:${SHELF}`);
    check(inv.text.includes('约人'), `按钮文字：${inv.text}`);
    await C.page.click(`#actions [data-action="${inv.id}"]`);
    const m1 = await until(async () => {
      const m = await meView(C);
      return m.interaction ? m : null;
    }, 10_000, '服务器上出现 C 的读书活动');
    check(m1.interaction.status === 'open' && m1.interaction.min === 1 && m1.interaction.max === 4 && m1.interaction.objectId === SHELF, `应是 open、1 到 4 人、藏书架：${JSON.stringify(m1.interaction)}`);
    nameCServer = m1.me?.name ?? nameC;
    // 去重（反向验证项）：C 这边 main 追加的「使用中」要被换掉
    await until(async () => (await findAction(C.page, 'f:activity:begin:')) ?? null, 10_000, 'C 出现「开始」（一人就够）');
    check(!(await hasAction(C.page, 'busy:')), `C 的按钮里不应有「使用中」：${JSON.stringify(await actionButtons(C.page))}`);
    await clickObject(A, SHELF);
    await settle(h, A);
    const [pa, pc] = [await posOf(A), await posOf(C)];
    check(nearestSeat(pa, SHELF_SEATS).d <= 0.5 && dist2(pa, pc) >= 1.0, `A 应站在藏书架另一个使用位上：相距 ${dist2(pa, pc).toFixed(2)} 米`);
    const join = await until(async () => (await findAction(A.page, 'f:activity:join:')) ?? null, 15_000, 'A 出现「加入」');
    check(!(await hasAction(A.page, 'busy:')), `A 的按钮里不应有「使用中」：${JSON.stringify(await actionButtons(A.page))}`);
    await A.page.click(`#actions [data-action="${join.id}"]`);
    await until(async () => (await meView(C)).interaction?.participants.length === 2, 10_000, '服务器上两人');
    const cBegin = await until(async () => (await findAction(C.page, 'f:activity:begin:')) ?? null, 10_000, 'C 的「开始」仍可点');
    check(!cBegin.disabled, 'C 的「开始」应可点');
    await C.page.click(`#actions [data-action="${cBegin.id}"]`);
    const m2 = await until(async () => {
      const m = await meView(A);
      return m.interaction?.status === 'running' ? m : null;
    }, 10_000, '服务器上读书开始了');
    await openActivity(A.page);
    const pA = await until(async () => {
      const d = await pane(A);
      return d?.mine && d.status === 'running' ? d : null;
    }, 10_000, 'A 的页签进行中');
    const serverNames = m2.interaction.participants.map((x) => x.name);
    check(JSON.stringify([...pA.people].sort()) === JSON.stringify([...serverNames].sort()), `页签里的名字应与服务器逐字相同：${JSON.stringify(pA.people)} 对 ${JSON.stringify(serverNames)}`);
    check(serverNames.some((s) => s.includes('<i>')), `服务器给的名字应保留尖括号（测的就是它们只当文字）：${JSON.stringify(serverNames)}`);
    const kids = await A.page.evaluate(() => [...document.querySelectorAll('#dock [data-pane="activity"] [data-role="people"] *')].map((e) => e.tagName.toLowerCase()));
    check(kids.length > 0 && kids.every((t) => t === 'li' || t === 'span'), `人名单里只应有骨架里的 li 与 span：${JSON.stringify(kids)}`);
    const anyImg = await A.page.evaluate(() => document.querySelectorAll('#dock [data-pane="activity"] i, #dock [data-pane="activity"] img, #dock [data-pane="activity"] script, #dock [data-pane="activity"] b').length);
    check(anyImg === 0, '页签里不应出现 i、img、script、b 元素');
    await until(async () => (await godotTags(A)).some((x) => /2 人/.test(x)) && (await godotTags(C)).some((x) => /2 人/.test(x)), 10_000, '两边桌牌「… · 2 人」');
    check(!(await sitting(A)).includes(A.id) && !(await sitting(C)).includes(C.id), '读书不坐下');
    // 浏览器存储：键集合没有新增（只允许底座已有的面板偏好），值里没有任何参与者名字
    const allowed = new Set([...keys0, 'town3d.dock', 'town3d.dockTab', 'town3d.sound']);
    for (const p of [A, C]) {
      const dump = await p.page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
      const extra = Object.keys(dump).filter((k) => !allowed.has(k) && !/^town3d\./.test(k));
      check(extra.length === 0, `${p.label} 不应新增浏览器存储键：${JSON.stringify(extra)}`);
      const names = [nameOf(A), nameOf(B), nameC, nameCServer];
      for (const [k, v] of Object.entries(dump)) check(!names.some((n) => n && String(v).includes(n)), `${p.label} 的存储 ${k} 里不应含参与者名字`);
    }
    // 读书不用等到结束：离线后已开始的活动照常完成
    await h.release(A);
    await h.release(C);
    C = null;
  });

  // ───────────────────────── 40.9 结束 ─────────────────────────
  await step(40.9, '结束（B 一个人的茶到点）：收到收获文字；页签「刚才」小卡；桌牌没了；B 站起；活动条隐藏；服务器里没有活动；走开不再被拦', async () => {
    const seen = new Set();
    const done = await until(async () => {
      for (const t of await toastTexts(B.page).catch(() => [])) seen.add(t);
      const d = (await act(B))?.lastDone;
      return d ?? null;
    }, TEA_MS + 90_000, 'B 的喝茶结束（lastDone 出现）', 100);
    check(/完成了/.test(done.text) && done.id, `收获文字：${JSON.stringify(done)}`);
    check([...seen].some((t) => t.includes(done.text)), `main 弹出的提示应含这段收获文字：${JSON.stringify([...seen])}`);
    await openActivity(B.page);
    const p = await until(async () => {
      const d = await pane(B);
      return d && !d.mine && d.last ? d : null;
    }, 10_000, 'B 的页签：我的这一桌收起、「刚才」小卡出现');
    check(p.last === done.text, `小卡应写收获文字：${p.last} 对 ${done.text}`);
    await until(async () => (await tagTexts(B.page)).length === 0, 10_000, '桌牌消失');
    await until(async () => !(await sitting(B)).includes(B.id), 10_000, 'B 站起');
    await until(async () => B.page.$eval('#activityChip', (e) => e.hidden), 10_000, '#activityChip 隐藏');
    const me = await meView(B);
    check(me.interaction === null && objOf(me, T1).active === null, '服务器里没有活动了');
    const a = await act(B);
    check(a.armed === false && a.confirmedLeft === 0 && a.mine === null, `拦截状态应为空：${JSON.stringify(a)}`);
    // 随即点地立刻能走，没有提示：先点一次并等到 navigate 请求出现（屏障），再断言没有多一次拦截
    const n0 = B.w.actions.length;
    const w0 = a.warned;
    await closeDock(B.page);
    await clickWorld(B, 11, 9);
    await until(() => B.w.actions.slice(n0).find((r) => r.type === 'navigate'), 10_000, '点地发出了 navigate');
    check((await act(B)).warned === w0, `结束之后点地不应再被拦：${w0} -> ${(await act(B)).warned}`);
    await settle(h, B);
  });

  // ───────────────────────── 40.95 换人与离开 ─────────────────────────
  await step(40.95, '离开与换人：B 离开后页签清空；换名重新进入后没有上一位的「刚才」、桌牌、计数；页签只列服务器当前的桌子', async () => {
    allowFailure(B.w, 'POST', /\/town\/api\/heartbeat$/, { min: 0, max: 1, why: '40.95：离开瞬间在途的心跳可能 presence_lost' });
    const cid = await B.page.evaluate(() => window.TownHud.clientId());
    const lr = await B.ctx.request.post(`${BASE}/town/api/leave`, { data: { clientId: cid } });
    check(lr.ok(), `POST /leave 返回 ${lr.status()}`);
    await until(() => B.page.evaluate(() => document.body.dataset.phase === 'ready'), 20_000, 'B 页面回到「已离开」');
    const k = await pane(B);
    check(!k.mine && k.last === null && k.tables.length === 0 && k.people.length === 0, `离开后页签应清空：${JSON.stringify(k)}`);
    await B.ctx.clearCookies();
    const oldId = B.id;
    await B.page.click('#enterBtn');
    await B.page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 });
    const nm = `阿换${rnd()}`;
    await B.page.fill('#nameInput', nm);
    await B.page.click('#loginBtn');
    await B.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    await until(async () => ((await snap(B.page)).self || oldId) !== oldId, 30_000, '换名重进后快照里的自己是另一位居民', 300);
    B.id = (await snap(B.page)).self;
    check(B.id !== oldId, '换名重进应是另一位居民');
    const me = await meView(B);
    const want = (me.here?.objects ?? []).filter((o) => o.action && o.action.max >= 2).map((o) => o.id).sort();
    await until(async () => JSON.stringify(((await pane(B))?.tables ?? []).map((x) => x.obj).sort()) === JSON.stringify(want), 15_000, '页签只列服务器当前的桌子');
    const p = await pane(B);
    check(!p.mine && p.last === null, `新居民的页签不应有上一位的活动或「刚才」：${JSON.stringify(p)}`);
    const a = await act(B);
    check(a.mine === null && a.lastDone === null && a.warned === 0 && a.confirmedLeft === 0 && a.sitting.length >= 0, `Godot 一侧应已重置：${JSON.stringify(a)}`);
    check((await tagTexts(B.page)).length === 0, '不应有上一位的桌牌');
    // 声明过的 4xx 次数（与实际一致，收尾由全程检查核对）：40.6 一次（A 的 busy）
  });

  await h.release(B);
  if (C) await h.release(C);
}

/*
 * 怎么让它失败（反向验证清单；每条改动后只跑 --only=activity，改回来再跑一遍确认恢复）：
 *  见 client/docs/C2.md 的「反向验证记录」，每一条都写了改坏什么、哪一步红、实际结果。
 */
