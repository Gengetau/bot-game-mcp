// C6：NPC 的外观、名牌、点选与服务菜单（话题、买茶叶）。A 桌面 1440x900，B 手机 390x844 触摸。
// 步骤号都是数字（80.1 就是「80 之后的一步」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言都按那里写的做过反向验证（注明「实测」或「推演」）。
import { poll, hitTest } from '../lib/ui.mjs';
import { apiAct, nearbyRows, expectReject } from '../lib/chat.mjs';
import { peopleCard, clickActor, toastTexts, hit } from '../lib/people.mjs';
import { menuState, godotNpc, bank, pageNpcs, serverNpcs, serverMe, bag, npcScreen, clickNpc, menuIs, menuClosed, ackAfter, lastAckN, clickTopic, clickBuy, MENU } from '../lib/npc.mjs';

export const meta = { id: 'npc', n: 80, title: 'NPC 外观、名牌与服务菜单' };

const KEEPER = 'npc:teahouse_keeper';
const STROLL = 'npc:plaza_stroller';

export default async function run(h) {
  const { check, note, until, sleep, step, shot, selfActor, dist, serverScene, snap, BASE } = h;
  const { A, B } = await h.pair();
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);
  const sceneOf = async (p) => selfActor(await serverScene(p));
  const waitIdle = (p, ms = 60_000) => until(async () => !(await sceneOf(p)).nav, ms, `${p.label} 走完`, 500);
  const npcPos = async (p, id) => (await serverNpcs(p)).find((n) => n.id === id);
  const gapTo = async (p, id) => {
    const n = await npcPos(p, id);
    return n ? dist(await sceneOf(p), n) : Infinity;
  };
  /** 走到离某个 NPC off 米处（API 代发，短路；不行就换个方向试） */
  const goNear = async (p, id, off = 1.8) => {
    const n = await npcPos(p, id);
    if (!n) throw new Error(`场景里没有 ${id}`);
    const me = await sceneOf(p);
    const vx = me.x - n.x;
    const vz = me.z - n.z;
    const vl = Math.hypot(vx, vz) || 1;
    const dirs = [[vx / vl, vz / vl], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      const r = await apiAct(p, { type: 'navigate', to: { x: n.x + dx * off, z: n.z + dz * off } });
      if (r.status !== 200) continue;
      await waitIdle(p);
      if ((await gapTo(p, id)) < off + 1) return;
    }
    throw new Error(`${p.label} 走不到 ${id} 身边`);
  };
  const toasts = (p) => toastTexts(p.page);
  const hasTag = (p, id) => p.page.evaluate((i) => !!document.querySelector(`#tags .tag.npc[data-id="${i}"]`), id);
  /** 画面里要点得到某个 NPC：在视口里（留边）且最上面是画布；否则等一等（它在走）再看 */
  const clickable = (p, id) =>
    until(async () => {
      const s = await npcScreen(p.page, id);
      if (!s) return null;
      const vp = await p.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      if (!(s.x >= 40 && s.x <= vp.w - 40 && s.y >= 60 && s.y <= vp.h - 140)) return null;
      return (await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y])) === 'canvas' ? s : null;
    }, 20_000, `${p.label} 点得到 ${id}`, 300);
  const closeMenu = async (p) => {
    if ((await menuState(p.page))?.open) {
      await p.page.click(`${MENU} [data-role="close"]`);
      await menuClosed(until, p);
    }
  };
  const lastRec = (p, type) => until(() => { const r = actionsOf(p, type).at(-1); return r && 'reason' in r ? r : null; }, 10_000, `${p.label} 的 ${type} 请求记录读完`, 100);
  const noteOf = (m) => m?.note ?? '';
  let tea0 = { coins: 0, tea: 0 };

  // ───────────────────────── 80 初始 ─────────────────────────
  await step(80, '初始：NPC 并进画面但不进 __town.actors；两个 NPC 的名字、角色、位置与服务器一致；名牌是奶油色小木牌（和居民的深色药丸不同）并带「店」「闲」；#npcMenu 存在且隐藏', async () => {
    for (const p of [A, B]) {
      check((await p.page.evaluate((s) => document.querySelector(s)?.hidden, MENU)) === true, `${p.label} 的 #npcMenu 应存在且隐藏`);
      check(await menuState(p.page), `${p.label} 应有 __dock.npc`);
      check(await godotNpc(p), `${p.label} 应有 __town.features.npc`);
    }
    const srv = await serverNpcs(A);
    const ids = srv.map((n) => n.id).sort();
    check(ids.includes(KEEPER) && ids.includes(STROLL), `服务器场景里应有两个 NPC：${JSON.stringify(ids)}`);
    await until(async () => (await pageNpcs(A.page)).length >= 2, 20_000, 'A 的画面里出现两个 NPC');
    const pn = await pageNpcs(A.page);
    const acts = (await snap(A.page)).actors.map((x) => x.id);
    check(!acts.includes(KEEPER) && !acts.includes(STROLL), `__town.actors 里不该有 NPC：${JSON.stringify(acts)}`);
    for (const s of srv) {
      const q = pn.find((x) => x.id === s.id);
      check(q && q.name === s.name && q.role === s.role, `页面的 ${s.id} 名字 / 角色应与服务器一致：${JSON.stringify(q)} 对 ${JSON.stringify([s.name, s.role])}`);
      check(q && Math.hypot(q.x - s.x, q.z - s.z) < 3.0, `页面的 ${s.id} 位置应接近服务器（容差 3 米，NPC 在走）：${JSON.stringify([q?.x, q?.z])} 对 ${JSON.stringify([s.x, s.z])}`);
    }
    const k = pn.find((x) => x.id === KEEPER);
    const st = pn.find((x) => x.id === STROLL);
    check(k.outfit === 8 && st.outfit === 9, `掌柜 8 号衣服、闲逛者 9 号：${k.outfit} / ${st.outfit}`);
    // 名牌：至少能看到一块 NPC 的牌时核样式（不在画面里的 NPC 没有牌）
    const tag = await until(async () => {
      return A.page.evaluate(() => {
        const t = document.querySelector('#tags .tag.npc');
        if (!t) return null;
        const cs = getComputedStyle(t);
        const after = getComputedStyle(t, '::after').content;
        const self = document.querySelector('#tags .tag.s, #tags .tag.a');
        const scs = self ? getComputedStyle(self) : null;
        return { text: t.textContent, cls: t.className, bg: cs.backgroundColor, border: cs.borderTopColor, after, selfBg: scs?.backgroundColor ?? null, z: t.style.zIndex };
      });
    }, 30_000, 'A 画面里出现 NPC 的名牌');
    note(`NPC 名牌：${JSON.stringify(tag)}`);
    check(/npc-(service|ambient)/.test(tag.cls), `名牌类名应带角色：${tag.cls}`);
    const markBank = (await bank(A.page, 'mark.service')) ?? '?';
    const markBank2 = (await bank(A.page, 'mark.ambient')) ?? '?';
    check(tag.after.includes(markBank) || tag.after.includes(markBank2), `名牌尾巴应是「店」或「闲」（来自文字库）：${tag.after}`);
    check(tag.selfBg && tag.bg !== tag.selfBg, `NPC 的牌底色应和居民的牌不同：${tag.bg} 对 ${tag.selfBg}`);
    check(Number(tag.z) <= 3, `NPC 的牌层级不高于居民牌（居民 s=5、a=4，其余 3）：${tag.z}`);
    tea0 = await bag(A);
    note(`A 的钱 / 茶叶：${JSON.stringify(tea0)}`);
  });

  // ───────────────────────── 80.1 近处点掌柜 ─────────────────────────
  await step(80.1, '近处点掌柜：不发任何动作；菜单立即出现，名字、「店」徽章、三个话题、货架（茶叶、价格 2、库存来自服务器）；菜单不盖住底栏', async () => {
    await goNear(A, KEEPER, 1.8);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    await clickable(A, KEEPER);
    const n0 = A.w.actions.length;
    const o0 = (await godotNpc(A)).opens;
    await clickNpc(A, KEEPER);
    const m = await menuIs(until, A, KEEPER);
    check(A.w.actions.length === n0, `开菜单不该发任何动作：${JSON.stringify(A.w.actions.slice(n0).map((r) => r.type))}`);
    check((await godotNpc(A)).opens === o0 + 1, '菜单只开了一次');
    const srvMe = await serverMe(A);
    const hn = (srvMe.here?.npcs ?? []).find((n) => n.id === KEEPER);
    check(hn, `服务器 /me 的 here.npcs 里应有掌柜：${JSON.stringify(srvMe.here?.npcs)}`);
    const srvName = (await serverNpcs(A)).find((n) => n.id === KEEPER).name;
    check(m.name === srvName, `菜单名字应与服务器一致：${m.name} 对 ${srvName}`);
    check(m.mark === (await bank(A.page, 'mark.service')), `徽章应是「店」：${m.mark}`);
    const tids = m.topics.map((t) => t.id).sort();
    check(JSON.stringify(tids) === JSON.stringify(hn.topics.map((t) => t.id).sort()), `话题应与服务器一致：${JSON.stringify(tids)} 对 ${JSON.stringify(hn.topics)}`);
    const goods = srvMe.here.shops.find((s) => s.id === hn.shop)?.goods ?? [];
    check(m.shopOpen && m.goods.length === goods.length && goods.length > 0, `货架应与服务器 here.shops 一致：${JSON.stringify(m.goods)} 对 ${JSON.stringify(goods)}`);
    const tea = m.goods.find((g) => g.sku === 'tea_leaves');
    check(tea && tea.qty === '1' && !tea.buyDisabled, `茶叶一行：数量 1、买钮可点：${JSON.stringify(tea)}`);
    check(m.text.includes('2'), `菜单里应有价格 2：${m.text}`);
    const bb = await A.page.evaluate(() => document.getElementById('bottombar')?.getBoundingClientRect().toJSON() ?? null);
    check(!hit(m.rect, bb), `菜单不该盖住底栏：${JSON.stringify(m.rect)} 对 ${JSON.stringify(bb)}`);
    check(m.rect.left >= 0 && m.rect.top >= 0 && m.rect.right <= 1440 && m.rect.bottom <= 900, `菜单应在视口内：${JSON.stringify(m.rect)}`);
    await shot(A.page, '80-desktop-keeper-menu');
  });

  // ───────────────────────── 81 话题 ─────────────────────────
  await step(81, '话题：点一个话题恰好一条 ask_npc；回话写进菜单；双击同一个话题仍只发一条；NPC 的话出现在「附近」，带 NPC 标记，不带 AI 标记', async () => {
    const n0 = actionsOf(A, 'ask_npc').length;
    const k0 = await lastAckN(A);
    await clickTopic(A, 'hello');
    const ack = await ackAfter(until, A, 'ask', k0);
    check(ack.ok, `ask 应成功：${JSON.stringify(ack)}`);
    check(actionsOf(A, 'ask_npc').length === n0 + 1, `应恰好多一条 ask_npc：${actionsOf(A, 'ask_npc').length - n0}`);
    const m = await menuState(A.page);
    check(m.answer && m.answer !== (await bank(A.page, 'answer.empty')), `菜单里应有回话：${m.answer}`);
    // 关掉重开再双击话题：只发一次
    const n1 = actionsOf(A, 'ask_npc').length;
    const k1 = await lastAckN(A);
    const r = await A.page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().toJSON(), `${MENU} [data-topic="town"]`);
    await A.page.mouse.dblclick(r.left + r.width / 2, r.top + r.height / 2);
    await ackAfter(until, A, 'ask', k1);
    await sleep(800);
    check(actionsOf(A, 'ask_npc').length === n1 + 1, `双击一个话题应只发一条 ask_npc：${actionsOf(A, 'ask_npc').length - n1}`);
    // 附近聊天里 NPC 的话（chat 事件，from.kind=npc）：行的 data-from 以 npc: 开头，带 NPC 标记，不带 AI 标记
    const rows = await until(async () => { const rs = (await nearbyRows(A.page)).filter((x) => String(x.from).startsWith('npc:')); return rs.length ? rs : null; }, 20_000, '附近聊天里出现 NPC 的话', 300);
    const badge = await A.page.evaluate(() => {
      const li = [...document.querySelectorAll('#dock [data-pane="nearby"] li[data-from^="npc:"]')].at(-1);
      if (!li) return null;
      const q = (r) => li.querySelector(`[data-role="${r}"]`);
      const npc = q('npcmark');
      const ai = q('ai');
      return { npc: npc ? getComputedStyle(npc).display : null, npcText: npc?.textContent ?? '', ai: ai ? getComputedStyle(ai).display : null };
    });
    check(badge && badge.npc !== 'none' && badge.npcText === 'NPC', `NPC 的话应带可见的 NPC 标记：${JSON.stringify(badge)}`);
    check(badge && badge.ai === 'none', `NPC 的话不该带 AI 标记：${JSON.stringify(badge)}`);
    // 别人的话没有 NPC 标记
    const others = await A.page.evaluate(() => [...document.querySelectorAll('#dock [data-pane="nearby"] li[data-mid]:not([data-from^="npc:"]) [data-role="npcmark"]')].filter((e) => getComputedStyle(e).display !== 'none').length);
    check(others === 0, `非 NPC 的话不该显示 NPC 标记：${others}`);
    check(rows.length >= 1, '至少一行 NPC 的话');
  });

  // ───────────────────────── 81.1 限流 ─────────────────────────
  await step(81.1, '限流：额度用完之后在菜单里再问一次，服务器 429 rate_limited；菜单显示带秒数的提示、话题按钮变灰；到点自动恢复', async () => {
    // 用 API 把 npc 桶用光（页面外的请求，不计入页面的失败声明）
    let limited = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const r = await apiAct(A, { type: 'ask_npc', npcId: KEEPER, topic: 'hello' });
      if (r.status === 429 || r.body?.error === 'rate_limited') limited = r;
    }
    check(limited, '连发 ask_npc 应触到限流');
    const n0 = actionsOf(A, 'ask_npc').length;
    const k0 = await lastAckN(A);
    await expectReject(A, '菜单里被限流的一问（429）', async () => {
      await clickTopic(A, 'hello');
      const ack = await ackAfter(until, A, 'ask', k0);
      check(ack.code === 'rate_limited', `回执应是 rate_limited：${JSON.stringify(ack)}`);
    });
    check(actionsOf(A, 'ask_npc').length === n0 + 1, '限流这一问页面只发了一条');
    const m = await until(async () => { const s = await menuState(A.page); return s.cool > 0 ? s : null; }, 5000, '菜单进入冷却', 100);
    check(/\d/.test(m.note), `提示里应有秒数：${m.note}`);
    check(m.topics.every((t) => t.disabled), `冷却中话题按钮应全灰：${JSON.stringify(m.topics)}`);
    // 冷却中点灰按钮（强制点）不发请求
    const n1 = actionsOf(A, 'ask_npc').length;
    await A.page.evaluate((s) => document.querySelector(s)?.click(), `${MENU} [data-topic="hello"]`);
    await sleep(500);
    check(actionsOf(A, 'ask_npc').length === n1, '冷却中不发 ask_npc');
    await until(async () => { const s = await menuState(A.page); return s.cool === 0 && s.topics.every((t) => !t.disabled) ? s : null; }, 30_000, '冷却结束，话题按钮恢复', 500);
  });

  // ───────────────────────── 82 买 ─────────────────────────
  await step(82, '买：数量加一再点「买」，恰好一条 buy；服务器钱少 4、茶叶多 2；菜单显示服务器给的成交文字；库存减 2；成交文字不进附近聊天、气泡、提示条', async () => {
    const before = await bag(A);
    const nb = actionsOf(A, 'buy').length;
    const chatBefore = (await nearbyRows(A.page)).length;
    const toastsBefore = (await toasts(A)).length;
    await A.page.click(`${MENU} .npc-good[data-sku="tea_leaves"] [data-role="inc"]`);
    check((await menuState(A.page)).goods[0].qty === '2', '点「＋」数量变 2');
    const stock0 = (await menuState(A.page)).goods[0].stock;
    const k0 = await lastAckN(A);
    await clickBuy(A, 'tea_leaves');
    const ack = await ackAfter(until, A, 'buy', k0);
    check(ack.ok && ack.qty === 2, `buy 应成功、数量 2：${JSON.stringify(ack)}`);
    check(actionsOf(A, 'buy').length === nb + 1, `应恰好一条 buy：${actionsOf(A, 'buy').length - nb}`);
    const after = await bag(A);
    check(after.coins === before.coins - 4 && after.tea === before.tea + 2, `服务器：钱 -4、茶叶 +2：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const m = await until(async () => { const s = await menuState(A.page); return /\S/.test(noteOf(s)) ? s : null; }, 5000, '菜单里有成交文字', 100);
    check(m.note.includes('2') && m.noteKind.includes('ok'), `成交文字应是服务器的回执（含数量 2）：${m.note}`);
    await until(async () => (await menuState(A.page)).goods[0].stock !== stock0, 10_000, '库存数变了', 200);
    const g = (await menuState(A.page)).goods[0];
    const srvStock = (await serverMe(A)).here.shops[0].goods[0].stock;
    check(String(g.stock).includes(String(srvStock)), `库存应与服务器一致：${g.stock} 对 ${srvStock}`);
    // 成交文字只在买家菜单里：附近聊天没有多出「买了」，提示条没有多出，B 的页面更没有
    const rows = await nearbyRows(A.page);
    check(rows.slice(chatBefore).every((r) => !r.text.includes('买了')), `成交文字不该进附近聊天：${JSON.stringify(rows.slice(chatBefore).map((r) => r.text))}`);
    check((await toasts(A)).slice(toastsBefore).every((t) => !String(t).includes('买了')), `成交文字不该进提示条：${JSON.stringify(await toasts(A))}`);
    tea0 = after;
  });

  // ───────────────────────── 82.1 网络失败重试 ─────────────────────────
  await step(82.1, '买到一半断网：第一条 buy 服务器收到了、回应丢了；页面再点一次沿用同一个请求号；服务器里只多 1 份茶叶、钱只少 2', async () => {
    const before = await bag(A);
    const sent = [];
    let dropped = 0;
    await A.page.route('**/town/api/actions', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.action?.type === 'buy') {
        sent.push(body.requestId);
        if (dropped === 0) {
          dropped++;
          await route.fetch(); // 服务器照常处理
          await route.abort('failed'); // 回应丢了
          return;
        }
      }
      await route.continue();
    });
    // 菜单里数量退回 1
    await A.page.click(`${MENU} .npc-good[data-sku="tea_leaves"] [data-role="dec"]`);
    check((await menuState(A.page)).goods[0].qty === '1', '数量退回 1');
    const k0 = await lastAckN(A);
    await clickBuy(A, 'tea_leaves');
    const a1 = await ackAfter(until, A, 'buy', k0);
    check(!a1.ok && a1.code === 'net', `第一条应是网络失败：${JSON.stringify(a1)}`);
    const m1 = await menuState(A.page);
    check(m1.note.length > 0 && !m1.goods[0].buyDisabled, `菜单应提示重试且「买」可再点：${JSON.stringify([m1.note, m1.goods[0]])}`);
    // 页面把网络失败记成一个「请求失败」问题（故意断的）：核对只有这一条，然后摘掉
    const failed = A.w.problems.filter((p) => p.includes('请求失败：POST /town/api/actions'));
    check(failed.length === 1, `应只有一条（故意断的）请求失败：${JSON.stringify(failed)}`);
    A.w.problems = A.w.problems.filter((p) => !p.includes('请求失败：POST /town/api/actions'));
    await sleep(900);
    await clickBuy(A, 'tea_leaves');
    const a2 = await ackAfter(until, A, 'buy', a1.n);
    check(a2.ok, `重试应成功：${JSON.stringify(a2)}`);
    await A.page.unroute('**/town/api/actions');
    check(sent.length === 2 && sent[0] === sent[1], `两次 buy 应带同一个请求号：${JSON.stringify(sent)}`);
    const after = await bag(A);
    check(after.tea === before.tea + 1 && after.coins === before.coins - 2, `服务器：只多 1 份茶叶、钱只少 2：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });

  // ───────────────────────── 83 E 键 ─────────────────────────
  await step(83, 'E 键：关掉菜单后连按两下 E，只开一次菜单、不发任何 ask_npc；再按 E 菜单仍在', async () => {
    await closeMenu(A);
    await goNear(A, KEEPER, 1.4);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    const o0 = (await godotNpc(A)).opens;
    const nAsk = actionsOf(A, 'ask_npc').length;
    await A.page.keyboard.press('KeyE');
    await A.page.keyboard.press('KeyE');
    await menuIs(until, A, KEEPER, 20_000);
    await sleep(600);
    check((await godotNpc(A)).opens === o0 + 1, `连按两下 E 应只开一次菜单：${(await godotNpc(A)).opens - o0}`);
    check(actionsOf(A, 'ask_npc').length === nAsk, '开菜单不发 ask_npc');
    await A.page.keyboard.press('KeyE');
    await sleep(500);
    check((await menuState(A.page)).open, '菜单开着时再按 E，菜单仍在');
  });

  // ───────────────────────── 83.1 走开收起；远处点选走过去 ─────────────────────────
  await step(83.1, '走开收起、远处点选：A 走远，菜单自动收起；再点画面里的 NPC（远处）：只走路不开菜单，到了才开', async () => {
    const n = await npcPos(A, KEEPER);
    // 往远处走 6 米（选一个画面里仍能点到 NPC 的方向）
    const dirs = [[0, 6], [0, -6], [6, 0], [-6, 0], [5, 5], [-5, 5], [5, -5], [-5, -5]];
    let placed = false;
    for (const [dx, dz] of dirs) {
      const r = await apiAct(A, { type: 'navigate', to: { x: n.x + dx, z: n.z + dz } });
      if (r.status !== 200) continue;
      await waitIdle(A);
      if ((await gapTo(A, KEEPER)) < 4.5) continue;
      const s = await npcScreen(A.page, KEEPER);
      const ok = s && s.x > 60 && s.x < 1380 && s.y > 80 && s.y < 700 && (await A.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y])) === 'canvas';
      if (ok) {
        placed = true;
        break;
      }
    }
    check(placed, '应能走到离掌柜 4.5 米以上、又在画面里点得到他的地方');
    await menuClosed(until, A, 10_000);
    const nNav = actionsOf(A, 'navigate').length;
    const nAsk = actionsOf(A, 'ask_npc').length;
    const arr0 = (await godotNpc(A)).arrivals;
    await clickable(A, KEEPER);
    await clickNpc(A, KEEPER);
    await until(() => actionsOf(A, 'navigate').length > nNav, 10_000, '点远处的 NPC 应发出一条 navigate');
    check(!(await menuState(A.page)).open, '远处点选：走的时候不开菜单');
    await until(async () => (await godotNpc(A)).arrivals > arr0, 90_000, '收到 you_arrived', 500);
    await menuIs(until, A, KEEPER, 20_000);
    check(actionsOf(A, 'ask_npc').length === nAsk, '到了开菜单也不发 ask_npc');
    await closeMenu(A);
    // 走到菜单开着时被别处引走：不再自动开（别处发起的走近）
    const arr1 = (await godotNpc(A)).arrivals;
    await apiAct(A, { type: 'navigate', to: { x: (await sceneOf(A)).x + 4, z: (await sceneOf(A)).z } });
    await waitIdle(A);
    await apiAct(A, { type: 'navigate', approach: KEEPER });
    await until(async () => (await godotNpc(A)).arrivals > arr1, 90_000, '别处发起的走近也收到 you_arrived', 500);
    await sleep(1500);
    check(!(await menuState(A.page)).open, '不是在这个页面点出来的走近：到了不弹菜单');
  });

  // ───────────────────────── 84 浮层卡互斥 ─────────────────────────
  await step(84, '一次只开一张卡：居民卡开着点 NPC，居民卡收起、菜单打开；再点居民，菜单收起、居民卡打开', async () => {
    await goNear(A, KEEPER, 1.6);
    await goNear(B, KEEPER, 2.2);
    await until(async () => (await snap(A.page)).actors.some((x) => x.id === B.id), 20_000, 'A 看到 B');
    const bAt = (await snap(A.page)).actors.find((x) => x.id === B.id);
    check(bAt, 'B 在 A 画面里');
    await clickable(A, KEEPER);
    await clickActor(A, B.id);
    await until(async () => (await peopleCard(A.page))?.cardOpen, 20_000, '居民卡出现');
    await clickable(A, KEEPER);
    await clickNpc(A, KEEPER);
    await menuIs(until, A, KEEPER, 20_000);
    check(!(await peopleCard(A.page))?.cardOpen, '开 NPC 菜单时居民卡应已收起');
    await clickActor(A, B.id);
    await until(async () => (await peopleCard(A.page))?.cardOpen, 20_000, '再点居民：居民卡出现');
    check(!(await menuState(A.page)).open, '开居民卡时 NPC 菜单应已收起');
    check((await godotNpc(A)).open === false, 'Godot 一侧菜单也已关');
    await A.page.click('#peopleCard .people-x');
  });

  // ───────────────────────── 85 活动中被挡 ─────────────────────────
  await step(85, '共同活动中点 NPC：被「走开」确认拦下，不开菜单、不发 ask_npc、不发 navigate；提示条出现', async () => {
    // A 在茶馆里坐到茶桌 1 约人：此后 _mine 非空，点 NPC 属于「会让我走开」的输入
    const T1 = 'tea_house:table1';
    const objPt = await A.page.evaluate((id) => { const o = (window.__town.objects ?? []).find((x) => x.id === id); return o ? { x: o.nx * window.innerWidth, y: o.ny * window.innerHeight } : null; }, T1);
    check(objPt, '茶桌 1 在画面里');
    await A.page.mouse.click(objPt.x, objPt.y);
    await until(async () => { const s = await sceneOf(A); return !s.nav; }, 30_000, 'A 走到茶桌', 500);
    const btn = await until(async () => A.page.evaluate((id) => document.querySelector(`#actions [data-action="f:activity:invite:${id}"]`) ? true : null, T1), 20_000, '出现「约人」', 300);
    check(btn, '约人按钮');
    await A.page.click(`#actions [data-action="f:activity:invite:${T1}"]`);
    await until(async () => (await serverMe(A)).interaction, 15_000, '服务器上出现 A 的活动', 300);
    const nAsk = actionsOf(A, 'ask_npc').length;
    const nNav = actionsOf(A, 'navigate').length;
    const toast0 = (await toasts(A)).length;
    await clickable(A, KEEPER);
    await clickNpc(A, KEEPER);
    await sleep(1500);
    check(!(await menuState(A.page)).open, '活动中点 NPC：菜单不该打开');
    check(actionsOf(A, 'ask_npc').length === nAsk && actionsOf(A, 'navigate').length === nNav, `活动中点 NPC：不该发 ask_npc / navigate：${JSON.stringify(A.w.actions.slice(-3).map((r) => r.type))}`);
    check((await toasts(A)).length > toast0, '应有「走开」提示');
    // E 键同理
    await A.page.keyboard.press('KeyE');
    await sleep(800);
    check(!(await menuState(A.page)).open, '活动中按 E：菜单也不该打开');
  });

  // ───────────────────────── 86 手机 ─────────────────────────
  await step(86, '手机（B，触摸）：点 NPC 出菜单；390 与 360 宽都不横向溢出；按钮点击区不小于 40 像素；菜单不盖住底栏', async () => {
    await goNear(B, KEEPER, 1.8);
    await until(async () => (await snap(B.page)).nearValid === true, 15_000, 'B 的「够得着」状态有效');
    await clickable(B, KEEPER);
    await clickNpc(B, KEEPER);
    const m = await menuIs(until, B, KEEPER, 20_000);
    for (const vw of [390, 360]) {
      await B.page.setViewportSize({ width: vw, height: 844 });
      await sleep(600);
      const r = await B.page.evaluate(() => {
        const q = document.querySelector('#npcMenu');
        const rc = q.getBoundingClientRect().toJSON();
        const small = [...q.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => { const x = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 6), w: Math.round(x.width), h: Math.round(x.height) }; }).filter((x) => x.w < 40 || x.h < 40);
        const bb = document.getElementById('bottombar')?.getBoundingClientRect().toJSON() ?? null;
        return { rc, small, bb, sw: document.documentElement.scrollWidth, iw: window.innerWidth, qsw: q.scrollWidth, qcw: q.clientWidth };
      });
      check(r.sw <= r.iw, `${vw} 宽不应横向溢出：scrollWidth ${r.sw} > ${r.iw}`);
      check(r.qsw <= r.qcw + 1, `${vw} 宽菜单内部不应横向溢出：${r.qsw} > ${r.qcw}`);
      check(r.rc.left >= 0 && r.rc.right <= r.iw, `${vw} 宽菜单应在视口内：${JSON.stringify(r.rc)}`);
      check(r.small.length === 0, `${vw} 宽按钮点击区应不小于 40 像素：${JSON.stringify(r.small)}`);
      check(!hit(r.rc, r.bb), `${vw} 宽菜单不该盖住底栏`);
    }
    await B.page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    await shot(B.page, '80-mobile-keeper-menu');
    // 手机点话题（触摸）
    const k0 = await lastAckN(B);
    await clickTopic(B, 'tea');
    const ack = await ackAfter(until, B, 'ask', k0);
    check(ack.ok, `手机上问话应成功：${JSON.stringify(ack)}`);
    check(m.shopOpen, '手机上也有货架');
    await closeMenu(B);
  });

  // ───────────────────────── 87 隐私 ─────────────────────────
  await step(87, '隐私：A 的买卖文字和钱数不出现在 B 的任何地方（提示条、附近聊天、菜单）；B 的公开视图里没有 A 的背包', async () => {
    const t = await B.page.evaluate(() => document.body.innerText);
    check(!t.includes('买了'), 'B 的页面文字里不该有「买了」');
    const rows = await nearbyRows(B.page);
    check(rows.every((r) => !r.text.includes('买了') && !r.text.includes('硬币')), `B 的附近聊天里不该有买卖文字：${JSON.stringify(rows.map((r) => r.text))}`);
    const pub = await B.ctx.request.get(`${BASE}/town/api/scene`);
    const sc = await pub.json();
    check(!JSON.stringify(sc).includes('tea_leaves'), 'B 能拿到的 scene 里不该有 A 的物品');
  });

  // ───────────────────────── 88 傍晚 ─────────────────────────
  await step(88, '傍晚（&hour=19.5）：第三个页面进入，NPC 的牌在夜色里仍在；白天、傍晚各留一张截图', async () => {
    await shot(A.page, '80-desktop-day');
    const C = await h.newPlayer(h.browsers[0], 'N-C 傍晚', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { wsGate: true });
    await h.login(C, `阿暮${h.rnd()}`, { query: '&hour=19.5' });
    const hour = await C.page.evaluate(() => window.__town.hour);
    check(Math.abs(hour - 19.5) < 0.6, `C 应在傍晚：${hour}`);
    await until(async () => (await pageNpcs(C.page)).length >= 2, 20_000, 'C 的画面里出现 NPC');
    await goNear(C, KEEPER, 3.5);
    await until(async () => (await hasTag(C, KEEPER)) || (await C.page.evaluate(() => !!document.querySelector('#tags .tag.npc'))), 30_000, 'C 画面里有 NPC 的牌', 400);
    await shot(C.page, '80-desktop-evening');
    await h.release(C);
  });

  await h.release(A);
  await h.release(B);
}

// ───────────────────────── 怎么让它失败 ─────────────────────────
// （见 client/docs/C6.md 的「反向验证」一节，逐条注明实测或推演。）
