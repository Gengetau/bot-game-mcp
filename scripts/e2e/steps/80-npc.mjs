// C6：NPC 的外观、名牌、点选与服务菜单（话题、买茶叶）。A 桌面 1440x900，B 手机 390x844 触摸。
// 步骤号都是数字（80.1 就是「80 之后的一步」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言都按那里写的做过反向验证（注明「实测」或「推演」）。
import { poll, hitTest, godotFeature, openDock, closeDock, frames } from '../lib/ui.mjs';
import { apiAct, nearbyRows, expectReject } from '../lib/chat.mjs';
import { peopleCard, clickActor, toastTexts, hit } from '../lib/people.mjs';
import { menuState, godotNpc, bank, pageNpcs, serverNpcs, serverMe, bag, npcScreen, clickNpc, menuIs, menuClosed, ackAfter, lastAckN, clickTopic, clickBuy, tapGoodButton, MENU } from '../lib/npc.mjs';

export const meta = { id: 'npc', n: 80, title: 'NPC 外观、名牌与服务菜单' };

const KEEPER = 'npc:teahouse_keeper';
const STROLL = 'npc:plaza_stroller';

export default async function run(h) {
  const { check, note, until, sleep, step, shot, selfActor, dist, serverScene, snap, BASE } = h;
  const { A, B } = await h.pair({ npcs: true }); // 旧步骤的页面默认不显示 NPC（D2）；这个文件的页面要看见它们
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
  /** 点得到之前先把镜头拉远（滚轮），直到这个 NPC 在视口里、最上面是画布（坐在茶桌上时掌柜在画面下沿，被底栏盖住） */
  const zoomToSee = async (p, id) => {
    for (let i = 0; i < 12; i++) {
      const s = await npcScreen(p.page, id);
      const vp = await p.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const ok = s && s.x >= 40 && s.x <= vp.w - 40 && s.y >= 60 && s.y <= vp.h - 140 && (await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y])) === 'canvas';
      if (ok) return s;
      await p.page.mouse.move(vp.w / 2, vp.h / 2);
      await p.page.mouse.wheel(0, 400);
      await sleep(700);
    }
    return clickable(p, id);
  };
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
    const consoleFail = A.w.problems.filter((p) => p.includes('控制台错误：Failed to load resource: net::ERR_FAILED'));
    check(failed.length === 1 && consoleFail.length === 1, `应只有一条（故意断的）请求失败和对应的一行控制台错误：${JSON.stringify([failed, consoleFail])}`);
    A.w.problems = A.w.problems.filter((p) => !p.includes('请求失败：POST /town/api/actions') && !p.includes('控制台错误：Failed to load resource: net::ERR_FAILED'));
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

  // ───────────────────────── 84.1 E 键按使用站位算物件的远近（D1） ─────────────────────────
  await step(84.1, 'E 键选物件按「离它最近的使用站位」算远近：站在书架最东边的站位上、闲逛者站在读书的落脚点（离我比书架中心更近）时按 E，选中的是书架；单测里同样的位置没有站位则选人', async () => {
    await closeMenu(A);
    const SHELF = 'bookshop:shelf';
    const SPOT = { x: 30.25, z: 3.75 }; // 书架的使用站位（最东边那个）
    const READ = { x: 32.25, z: 3.75 }; // 闲逛者读书的落脚点
    const standing = async () => {
      const n = await npcPos(A, STROLL);
      return !!n && !n.nav && Math.hypot(n.x - READ.x, n.z - READ.z) < 0.3;
    };
    const pickRec = async () => (await godotFeature(A.page, '_pick')) ?? null;
    // 一律不接管（hub 不问任何功能）：只看 E 选中了什么；旧行为会开始读书，最后收拾掉
    await A.page.evaluate(() => window.__town.pickStub('-'));
    try {
      await until(async () => ((await godotFeature(A.page, '_stub')) ?? '') === '-', 10_000, '假接管状态变成「-」');
      const r0 = await apiAct(A, { type: 'navigate', to: SPOT });
      check(r0.status === 200, `A 走到书架的站位：${JSON.stringify(r0.body)}`);
      await waitIdle(A);
      let rec = null;
      let gaps = null;
      // 闲逛者在三个落脚点之间轮转，每站停 20 到 40 秒：等它停到读书的落脚点，立刻按 E；按完它还停着才算数（否则这一轮不作数，重来）
      for (let attempt = 0; attempt < 4 && !rec; attempt++) {
        await until(standing, 240_000, '闲逛者走到书架旁读书的落脚点并停下', 700);
        await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
        const me = await sceneOf(A);
        const stroller = await npcPos(A, STROLL);
        const shelf = (await snap(A.page)).objects.find((o) => o.id === SHELF);
        gaps = { toShelfCenter: dist(me, shelf), toStroller: dist(me, stroller), toSpot: dist(me, SPOT) };
        check(gaps.toSpot < 0.8, `A 应站在书架的站位上：${JSON.stringify(gaps)}`);
        check(gaps.toStroller < gaps.toShelfCenter, `前提：闲逛者比书架中心离我更近（只按中心算会选到它）：${JSON.stringify(gaps)}`);
        const n0 = (await pickRec())?.n ?? 0;
        await A.page.keyboard.press('KeyE');
        const r = await until(async () => { const x = await pickRec(); return x && x.n > n0 ? x : null; }, 20_000, 'on_pick 记录出现');
        if (await standing()) rec = r; // 按的时候和按完之后它都还在落脚点上
        else {
          note('这一轮闲逛者在按 E 的过程中走开了，重来');
          await apiAct(A, { type: 'leave_interaction' }).catch(() => {});
        }
      }
      check(rec, '四轮都没等到闲逛者稳稳停在读书的落脚点上');
      note(`D1：${JSON.stringify(gaps)}，选中记录 ${JSON.stringify(rec)}`);
      check(rec.kind === 'obj' && rec.id === SHELF, `站在书架的站位上按 E 应选书架（不是闲逛者）：${JSON.stringify(rec)}`);
      // 收拾：旧行为会开始读书
      await apiAct(A, { type: 'leave_interaction' }).catch(() => {});
    } finally {
      await A.page.evaluate(() => window.__town.pickStub('')).catch(() => {});
    }
  });

  // ───────────────────────── 84.2 调试开关：隐藏 NPC（D2） ─────────────────────────
  await step(84.2, '隐藏 NPC 的调试开关：默认页面（旧步骤用的）看不到 NPC，显示 NPC 的页面同一时刻看得到；运行时切到隐藏，NPC、名牌消失、开着的菜单关掉，切回来又出现；不带 ?debug=1 的页面无视这个全局量', async () => {
    await closeMenu(A);
    // 显示 NPC 的页面（A）：服务器、页面里都有两个
    check((await serverNpcs(A)).length === 2, '服务器场景里应有两个 NPC');
    await until(async () => (await pageNpcs(A.page)).length === 2, 20_000, 'A 的画面里有两个 NPC');
    // 默认页面 D：和旧步骤的页面一样（newPlayer 默认隐藏）
    const D = await h.newPlayer(h.browsers[0], 'N-D 默认隐藏 NPC', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { wsGate: true });
    try {
      await h.login(D, `阿默${h.rnd()}`);
      // 屏障：D 的快照里已经看得到 A（居民和 NPC 在同一份快照里），而服务器此刻有两个 NPC、A 的页面也在显示它们
      await until(async () => (await snap(D.page)).actors.some((x) => x.id === A.id), 30_000, 'D 的画面里看到 A');
      check((await serverNpcs(D)).length === 2 && (await pageNpcs(A.page)).length === 2, '同一时刻：服务器和显示 NPC 的页面里都有两个 NPC');
      await sleep(1500); // 再让几份快照过去
      check((await pageNpcs(D.page)).length === 0, `默认页面里 __town.npcs 应为空：${JSON.stringify((await pageNpcs(D.page)).map((n) => n.id))}`);
      check((await D.page.evaluate(() => document.querySelectorAll('#tags .tag.npc').length)) === 0, '默认页面里不该有 NPC 的名牌');
      check(await D.page.evaluate(() => window.__townHideNpcs === true), '默认页面的全局量应已设为隐藏');
      check((await serverNpcs(D)).length === 2, 'NPC 仍然在服务器上（只是这个页面不画）');
    } finally {
      await h.release(D);
    }
    // 运行时切换：A 站在掌柜身旁，菜单开着
    await goNear(A, KEEPER, 1.4);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    await A.page.keyboard.press('KeyE');
    await menuIs(until, A, KEEPER, 20_000);
    await A.page.evaluate(() => window.__town.hideNpcs(true));
    await until(async () => (await pageNpcs(A.page)).length === 0, 15_000, '切到隐藏后 __town.npcs 变空');
    await menuClosed(until, A, 15_000); // 菜单跟着 NPC 一起没了
    await until(async () => (await A.page.evaluate(() => document.querySelectorAll('#tags .tag.npc').length)) === 0, 15_000, '切到隐藏后 NPC 的名牌消失');
    check((await A.page.evaluate(() => window.__townHideNpcs)) === true, '切换入口应同时写回页面全局量（刷新后还是隐藏）');
    check((await serverNpcs(A)).length === 2, '服务器上的 NPC 一个没少');
    const opensBefore = (await godotNpc(A)).opens;
    await A.page.evaluate(() => window.__town.hideNpcs(false));
    await until(async () => (await pageNpcs(A.page)).length === 2, 15_000, '切回显示后 NPC 又出现');
    // 屏障：NPC 回来之后，等画面又渲染 30 帧（Godot 每帧推状态），再断言菜单没有自己重开；
    // 立刻断言的话，迟一两帧才错误重开就看不到。再用「开菜单的累计次数」佐证：期间没有任何一次开菜单。
    await frames(A.page, 30);
    check(!(await menuState(A.page)).open, '切回显示后菜单不会自己重新打开');
    check((await godotNpc(A)).opens === opensBefore, `切回显示后菜单没有被重开过（开菜单次数 ${opensBefore} -> ${(await godotNpc(A)).opens}）`);
    // 不带 ?debug=1 的页面：全局量设了也无视，NPC 照常显示（没有 __town，只能看名牌）
    const E = await h.newPlayer(h.browsers[0], 'N-E 无调试', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { wsGate: false });
    try {
      await E.page.goto(`${BASE}/town/3d/`);
      await E.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
      await E.page.click('#enterBtn');
      await E.page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 });
      await E.page.fill('#nameInput', `阿明${h.rnd()}`);
      await E.page.click('#loginBtn');
      await E.page.waitForFunction(() => document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
      check(await E.page.evaluate(() => window.__townHideNpcs === true && typeof window.__town === 'undefined'), '前提：全局量设了隐藏，且这个页面没有测试口（没带 ?debug=1）');
      const tagUp = () => E.page.evaluate(() => document.querySelectorAll('#tags .tag.npc').length > 0);
      let seen = await until(tagUp, 20_000, 'E 画面里出现 NPC 的名牌', 500).catch(() => false);
      if (!seen) {
        await goNear(E, KEEPER, 3.5);
        seen = await until(tagUp, 40_000, 'E 走到掌柜旁后画面里出现 NPC 的名牌', 500);
      }
      check(seen, '不带 ?debug=1 的页面应无视隐藏开关，照常显示 NPC 的名牌');
    } finally {
      await h.release(E);
    }
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
    const toastsBefore0 = await toasts(A);
    await zoomToSee(A, KEEPER);
    await clickNpc(A, KEEPER);
    // 屏障：提示条出现一条原来没有的文字。不能比「条数」：提示条最多留 3 条（hud.js 超过就挤掉最早的），已有 3 条时新来一条条数不变
    const fresh = await until(async () => ((await toasts(A)).some((t) => !toastsBefore0.includes(t)) ? true : null), 4000, '点 NPC 之后出现新的「走开」提示', 100).catch(() => false);
    check(fresh, '应有「走开」提示');
    check(!(await menuState(A.page)).open, '活动中点 NPC：菜单不该打开');
    check(actionsOf(A, 'ask_npc').length === nAsk && actionsOf(A, 'navigate').length === nNav, `活动中点 NPC：不该发 ask_npc / navigate：${JSON.stringify(A.w.actions.slice(-3).map((r) => r.type))}`);
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
    // 数量加减和「买」也用真触摸点（命中测试：按钮中心最上面就是这个按钮，折行后没有被相邻元素盖住）
    const qtyOf = async () => (await menuState(B.page)).goods.find((g) => g.sku === 'tea_leaves')?.qty;
    for (const vw of [390, 360]) {
      await B.page.setViewportSize({ width: vw, height: 844 });
      await sleep(500);
      await tapGoodButton(B, 'tea_leaves', 'inc');
      await until(async () => (await qtyOf()) === '2', 5000, `${vw} 宽：点「加」之后数量是 2`);
      await tapGoodButton(B, 'tea_leaves', 'dec');
      await until(async () => (await qtyOf()) === '1', 5000, `${vw} 宽：点「减」之后数量回到 1`);
    }
    await B.page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    const b0 = await bag(B);
    // B 在这个文件里没花过钱（新居民 20 枚，一份茶叶 2 枚）：钱不够说明前面出了别的事，不跳过，直接算失败
    check(b0.coins !== null && b0.coins >= 2, `前提：B 的硬币够买一份茶叶：${JSON.stringify(b0)}`);
    const k1 = await lastAckN(B);
    await tapGoodButton(B, 'tea_leaves', 'buy');
    const bAck = await ackAfter(until, B, 'buy', k1);
    check(bAck.ok, `手机上真触摸点「买」应成功：${JSON.stringify(bAck)}`);
    await until(async () => (await bag(B)).tea === b0.tea + 1, 15_000, 'B 的茶叶多了一份（服务器真值）');
    // 抽屉打开（聊天面板顶上来）：菜单挂在上半屏，下沿不能压到底栏（停下 / 回家 / 地点 / 聊天），底栏每个按钮真的点得到
    await openDock(B.page);
    for (const vw of [390, 360]) {
      await B.page.setViewportSize({ width: vw, height: vw === 390 ? 844 : 740 });
      await sleep(700);
      const r = await B.page.evaluate(() => {
        const q = document.querySelector('#npcMenu');
        const rc = q.getBoundingClientRect().toJSON();
        const bar = document.getElementById('bottombar');
        const bb = bar.getBoundingClientRect().toJSON();
        const btns = [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => {
          const x = b.getBoundingClientRect();
          const top = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
          return { t: b.id || b.textContent.trim().slice(0, 6), covered: !(top === b || b.contains(top)), top: top?.id || top?.className || top?.tagName || '' };
        });
        return { rc, bb, btns, open: document.body.dataset.dockOpen, dock: document.body.dataset.dock };
      });
      check(r.open === '1' && r.dock === 'drawer', `${vw} 宽：前提，抽屉是打开的：${JSON.stringify([r.open, r.dock])}`);
      check(r.btns.length >= 1, `${vw} 宽：抽屉打开时底栏应有可见按钮`);
      check(!hit(r.rc, r.bb), `${vw} 宽抽屉打开时菜单不该压到底栏：菜单 ${JSON.stringify(r.rc)}，底栏 ${JSON.stringify(r.bb)}`);
      check(r.btns.every((b) => !b.covered), `${vw} 宽抽屉打开时底栏按钮都点得到（不被菜单盖住）：${JSON.stringify(r.btns.filter((b) => b.covered))}`);
    }
    await shot(B.page, '80-mobile-menu-drawer');
    await closeDock(B.page);
    await B.page.setViewportSize({ width: 390, height: 844 });
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
    const C = await h.newPlayer(h.browsers[0], 'N-C 傍晚', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, { wsGate: true, npcs: true });
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
// 每条都注明「实测」（临时改坏实现、重新导出、跑本文件，确实看到对应步骤变红，之后还原并核对 git diff 干净）或「推演」（没有做浏览器验证，理由写在后面）。
// 单测一侧的反向验证（client/tests/npc_feature_test.gd、npc_logic_test.gd，都是实测）见 client/docs/C6.md 第 7 节。
//
//  1. main.gd 的 _on_scene 里把 `for n in msg.get("npcs", [])` 改成 `for n in []`（NPC 不并进角色表）：80 红（等不到两个 NPC），其后依赖 NPC 的步骤跟着红。【实测，--until=80】
//  2. npc.gd 的 on_pick 删掉「菜单已开就 return true」，同时 _open 里删掉 `_open_id == pid` 的守卫：83 红（连按两下 E 开了两次）。只删前一处不会红：_open 自己还有一道同样的守卫，两层互相兜底。【实测（两处一起删）】
//  3. npc.gd 的 you_arrived 里把 `tid == mine` 去掉（别处发起的走近也开菜单）：83.1 红（最后一段「不是在这个页面点出来的走近，到了不弹菜单」）。【实测】
//  4. npc.gd 的 tick 里把「走远了收起」(`d > reach + CLOSE_SLACK`) 改成永不成立：83.1 红（A 走远后菜单关不掉，等不到关闭）。【实测】
//  5. npc.gd 的 _buy 里网络失败后不再把请求号记进 _pending：82.1 红（两次 buy 的请求号不同；服务器会多卖一份，钱多扣）。【实测】
//  6. npc.gd 的 _buy 成功分支里把成交文字也弹成 toast：82 红（提示条里出现「买了 2 件茶叶……」）。【实测】
//  7. npc.gd 的 _open 里删掉 ctx.card_claim(id)：84 红（开 NPC 菜单时居民卡没有收起）。【实测】
//  8. chat_util.gd 的 kind_of 去掉对 npc 的识别：本文件的 81 不会红（NPC 的「NPC」标记靠 data-from 前缀的样式，不看 kind），由 npc_logic_test 的 t_chat_kind 守着。【实测：端到端没抓住（已知），单测红】
//  9. main.gd 的 _can_control 里对 NPC 目标跳过 blocks_input：85 红（共同活动中点 NPC 照样开菜单）。【实测】
// 10. npc.gd 限流分支里不再记 _cool_until：81.1 红（等不到菜单进入冷却）。【实测】
// 11. npc.gd 把回执迟到的 `_gen` 对账改成永远当「菜单还在」、`_sess` 对账去掉、`error` 与 `reason` 的判断顺序对调、场景换了不收起、居民卡接管 NPC：本文件没有对应步骤（迟到回执要在毫秒级对上，浏览器里造不稳），由单测的对应断言守着。【单测实测】
// 12. 名牌让位（NPC 牌与居民牌重叠过半就不画）：本文件只检查样式与层级，没有构造「两牌重叠」的画面（站位由服务器出生点决定）；由 npc_logic_test 的 t_tags 守着。【推演：端到端没有造重叠，单测里改坏阈值会红】
// 13. 手机 360 / 390 宽的溢出与点击区：86 红的办法是给 #npcMenu 加固定宽度（如 min-width: 420px）或把 .npc-step 的 min-width 改小到 20px。【推演：没有真的改过 CSS 重跑】
// 14. （D1）main.gd 的 _nearest_pick 把物件的 anchors 传成空数组（只按中心算远近）：84.1 红，选中记录是 (actor, npc:plaza_stroller)，而不是书架。【实测，--only=1,80 --until=84.2】单测（pick_logic_test）同样红 3 项。
// 15. （D2）main.gd 的 _on_scene 里让「隐藏」永远不成立（`[] if false else msg.get("npcs", [])`）：84.2 红，「默认页面里 __town.npcs 应为空」。【实测，同一遍】
// 16. （D2）不带 ?debug=1 就认全局量（debug_flags.gd 的 hide_npcs 改成只看 flag）：单测「debug 关、全局量设了：无视」红；84.2 最后一段（页面 E）本该红，但那一遍没有单独做浏览器验证。【单测实测；浏览器一侧推演】
// 17. （评审）npc.css 里抽屉打开时的 #npcMenu 去掉 max-height 的「减去 --dock-h」那一项（回到固定 44vh）：86 红，「390 宽抽屉打开时菜单不该压到底栏：菜单 150..502，底栏 442..490」。【实测：在修复之前的导出上跑 --only=1,80 看到】
// 18. （评审）步骤 86 的「加 / 减 / 买」真触摸点：tapGoodButton 点之前做命中测试（按钮中心最上面必须就是该按钮）。命中测试那一层没有单独改坏验证（要让 .npc-gact 折行后某个按钮被盖住）。【推演】
// 19. （评审）84.2 切回显示后的屏障（frames 30 帧 + 开菜单累计次数不变）：要让它红得在显示 NPC 的路径里让菜单自动开，没有做。【推演】
// 20. （评审）85 的「走开」提示改成比文字：把 hud.js 提示条上限当成 3 条的情形（已有 3 条时条数不变）下旧写法红，新写法绿；连续两次（修复前的导出、修复后的导出）在 85 红过，改成比文字之后 --only=1,80 全绿。根因（提示条最多留 3 条）是从 hud.js 读出来的，没有在浏览器里单独复现。【间接实测】
// 21. （评审）main.gd 的 _update_scenery 把 NPC 的头放回 heads：茶馆屋顶对所有人永远隐藏。端到端没有断言它（要读 world 节点的网格可见性，没有 debug 口），由 client/tests/scene_logic_test.gd 守着。【单测实测，浏览器侧未验证】
// 22. （评审）npc.gd 的「走过去」：you_arrived 不结束 _walking、没有按距离算的上限：单测 t_walk_arrival_not_close、t_walk_rejected_times_out 红；端到端里造不出「服务器拒绝 navigate」，所以只有单测。【单测实测】
