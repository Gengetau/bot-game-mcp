// C6：NPC 与服务菜单的端到端小工具。依赖 playwright 的 page / ctx，不依赖 client-e2e.mjs（站点地址取自页面自己的地址）。
// 约定：页面都带 ?debug=1，所以 window.__dock.npc（网页一侧 debug）、window.__town.features.npc（Godot 一侧 debug）、window.__town.npcs（NPC 的屏幕位置）存在。
import { poll, modState, godotFeature } from './ui.mjs';

const originOf = (p) => new URL(p.page.url()).origin;
export const MENU = '#npcMenu';

/** 菜单的现状（网页一侧 debug）：{open, id, name, mark, who, answer, note, noteKind, topics[{id,disabled}], goods[{sku,qty,buyDisabled,stock}], shopOpen, closedText, walkVisible, rect, cool, text}。 */
export const menuState = (page) => modState(page, 'npc');

/** Godot 一侧 npc 功能的 debug。 */
export const godotNpc = (p) => godotFeature(p.page, 'npc');

/** 文字库里的一句（占位符原样返回）。 */
export const bank = (page, key) => page.evaluate((k) => document.querySelector(`#dockOverlays [data-pane="npc"] [data-bank] [data-t="${k}"]`)?.textContent ?? null, key);

/** 页面（__town.npcs）里的 NPC 列表：[{id, name, x, z, moving, nx, ny, pose, role, sitting, outfit}]。 */
export const pageNpcs = (page) => page.evaluate(() => window.__town?.npcs ?? []);

/** 服务端真相：scene.npcs（和居民同一份 /scene）。 */
export async function serverNpcs(p) {
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/scene`);
  return (await r.json()).npcs ?? [];
}

/** 服务端真相：GET /me（用这个页面自己的 clientId）。 */
export async function serverMe(p) {
  const clientId = await p.page.evaluate(() => window.TownHud.clientId());
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/me?clientId=${encodeURIComponent(clientId)}`);
  return r.json();
}

/** 自己的钱和茶叶数量（服务器说了算）。 */
export async function bag(p) {
  const me = await serverMe(p);
  const inv = me.inventory ?? {};
  const tea = (inv.items ?? []).filter((i) => i.type === 'tea_leaves').reduce((s, i) => s + (i.qty ?? 0), 0);
  return { coins: inv.coins?.available ?? null, tea };
}

/** 某个 NPC 在页面上的屏幕位置（1 米高处，和点选盒对得上）；不在画面里返回 null。 */
export const npcScreen = (page, id) =>
  page.evaluate((i) => {
    const a = (window.__town?.npcs ?? []).find((x) => x.id === i);
    return a ? { x: a.nx * window.innerWidth, y: a.ny * window.innerHeight, nx: a.nx, ny: a.ny } : null;
  }, id);

/** 点屏幕上的某个 NPC（桌面鼠标，手机触摸）。点之前检查那一点最上面确实是画布，否则抛错（免得点到面板或按钮上）。 */
export async function clickNpc(p, id, { dbl = false } = {}) {
  const s = await npcScreen(p.page, id);
  if (!s) throw new Error(`${p.label} 的画面里没有 ${id}`);
  const top = await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y]);
  if (top !== 'canvas') throw new Error(`${p.label} 点 ${id} 的位置 (${s.x.toFixed(0)},${s.y.toFixed(0)}) 最上面是 #${top || '(别的元素)'}，不是画布`);
  if (p.touch) await p.page.touchscreen.tap(s.x, s.y);
  else if (dbl) await p.page.mouse.dblclick(s.x, s.y);
  else await p.page.mouse.click(s.x, s.y);
  return s;
}

/** 等菜单开在某个 NPC 上。 */
export const menuIs = async (until, p, id, ms = 30_000) => {
  try {
    return await until(async () => { const m = await menuState(p.page); return m?.open && m.id === id ? m : null; }, ms, `${p.label} 的服务菜单出现（${id}）`);
  } catch (e) {
    // 等不到时带上 Godot 一侧的状态和两边的位置（到了没开，多半是「到达」和「位置跟上」之间出了岔子）
    const g = await godotNpc(p).catch(() => null);
    const pos = await p.page.evaluate((i) => { const t = window.__town; const me = (t?.actors ?? []).find((x) => x.id === t.self); const n = (t?.npcs ?? []).find((x) => x.id === i); return { me: me && [me.x, me.z, me.moving], npc: n && [n.x, n.z, n.moving] }; }, id).catch(() => null);
    const nav = (p.w?.actions ?? []).filter((r) => r.type === 'navigate').at(-1) ?? null; // 最后一条 navigate：是走向这个 NPC（approach），还是点到了地面
    throw new Error(`${e.message}；Godot：${JSON.stringify(g)}；页面位置：${JSON.stringify(pos)}；最后一条 navigate：${JSON.stringify(nav)}`);
  }
};

/** 等菜单关上。 */
export const menuClosed = (until, p, ms = 10_000) => until(async () => !(await menuState(p.page))?.open, ms, `${p.label} 的服务菜单关闭`);

/** 等一个动作得到回应（lastAck 的 n 超过 n0，且 verb 对得上）。 */
export const ackAfter = async (until, p, verb, n0, ms = 30_000) => {
  try {
    return await until(async () => { const a = (await godotNpc(p))?.lastAck; return a && a.verb === verb && a.n > n0 ? a : null; }, ms, `${p.label} 的 ${verb} 得到回应`);
  } catch (e) {
    // 等不到时把两边的状态带上：Godot 一侧有几条「不发、也不回应」的路径（菜单没开、被拦、冷却中、上一条还在路上）
    const g = await godotNpc(p).catch(() => null);
    const m = await menuState(p.page).catch(() => null);
    throw new Error(`${e.message}；Godot：${JSON.stringify(g)}；菜单：${JSON.stringify(m && { open: m.open, id: m.id, busy: m.busy, cool: m.cool, msg: m.msg, far: m.far, ctl: m.ctl })}`);
  }
};
export const lastAckN = async (p) => (await godotNpc(p))?.lastAck?.n ?? 0;

/** 让菜单上的某个话题按钮被点一下（真点击；手机用触摸）。 */
export async function clickTopic(p, topic) {
  const sel = `${MENU} [data-topic="${topic}"]`;
  if (p.touch) {
    const r = await p.page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, sel);
    if (!r) throw new Error(`没有话题按钮 ${topic}`);
    await p.page.touchscreen.tap(r.left + r.width / 2, r.top + r.height / 2);
  } else await p.page.click(sel);
}

/** 点货架上某件的「买」。 */
export async function clickBuy(p, sku) {
  const sel = `${MENU} .npc-good[data-sku="${sku}"] [data-role="buy"]`;
  if (p.touch) {
    const r = await p.page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, sel);
    if (!r) throw new Error(`没有商品 ${sku} 的买按钮`);
    await p.page.touchscreen.tap(r.left + r.width / 2, r.top + r.height / 2);
  } else await p.page.click(sel);
}

/** 真触摸点货架某件商品上的一个按钮（role: dec / inc / buy）。点之前检查按钮中心最上面确实是这个按钮（不是被相邻元素或别的面板盖住）。 */
export async function tapGoodButton(p, sku, role) {
  const sel = `${MENU} .npc-good[data-sku="${sku}"] [data-role="${role}"]`;
  const info = await p.page.evaluate((s) => {
    const b = document.querySelector(s);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, ok: !!top && (top === b || b.contains(top)), top: top?.id || top?.className || top?.tagName || '', disabled: b.disabled };
  }, sel);
  if (!info) throw new Error(`没有商品 ${sku} 的 ${role} 按钮`);
  if (!info.ok) throw new Error(`${sku} 的 ${role} 按钮中心 (${info.x.toFixed(0)},${info.y.toFixed(0)}) 最上面是 ${info.top}，真手指点不到`);
  await p.page.touchscreen.tap(info.x, info.y);
  return info;
}

/** 画布上的一点最上面的元素 id。 */
export const topAt = (page, x, y) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.id ?? '', [x, y]);

export { poll };
