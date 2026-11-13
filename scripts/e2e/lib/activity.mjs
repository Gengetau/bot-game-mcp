// 共同活动的端到端小工具。依赖 playwright 的 page / ctx 与 lib/ui.mjs，不依赖 client-e2e.mjs。
import { poll, openDock, closeDock, dockState, modState, godotFeature } from './ui.mjs';

const originOf = (p) => new URL(p.page.url()).origin;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 服务器常量（出处：packages/engine/src/world/spatial/town-map.ts 的 boxObject，地图 town-p1.0）
export const T1 = 'tea_house:table1';
export const T2 = 'tea_house:table2';
export const SHELF = 'bookshop:shelf';
/** 茶桌 1 在 (7, 5)，使用位在东南西北各 1.25 米 */
export const T1_SEATS = [
  { x: 7, z: 3.75 },
  { x: 7, z: 6.25 },
  { x: 8.25, z: 5 },
  { x: 5.75, z: 5 },
];
export const T2_SEATS = [
  { x: 14, z: 3.75 },
  { x: 14, z: 6.25 },
  { x: 15.25, z: 5 },
  { x: 12.75, z: 5 },
];
export const SHELF_SEATS = [
  { x: 26.25, z: 3.75 },
  { x: 28.25, z: 3.75 },
  { x: 30.25, z: 3.75 },
];
export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const nearestSeat = (pos, seats) => seats.map((s) => ({ s, d: dist2(pos, s) })).sort((x, y) => x.d - y.d)[0];

/** 服务器真相：GET /town/api/me（带这个页面自己的 clientId）。 */
export async function meView(p) {
  const cid = await p.page.evaluate(() => window.TownHud.clientId());
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/me?clientId=${encodeURIComponent(cid)}`);
  return r.json();
}
/** /me 里 here.objects 的某件物件。 */
export const objOf = (me, oid) => (me.here?.objects ?? []).find((o) => o.id === oid) ?? null;

/** 用 hud 的 act 事件触发一个按钮（和点按钮同一条路，但不要求按钮此刻存在）。 */
export const forceAct = (p, id) => p.page.evaluate((i) => window.TownHost.emit('ui', 'act', i), id);

/** #actions 里的按钮：[{id, cls, text, sub, disabled}]。 */
export const actionButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#actions button')].map((b) => ({ id: b.dataset.action, cls: b.className, text: b.querySelector('span')?.textContent ?? '', sub: b.querySelector('small')?.textContent ?? '', disabled: b.disabled })),
  );
export const hasAction = async (page, prefix) => (await actionButtons(page)).some((b) => b.id.startsWith(prefix));
export const findAction = async (page, prefix) => (await actionButtons(page)).find((b) => b.id.startsWith(prefix)) ?? null;

/** 街景上的桌牌（#tags 里的 .tag.c）：[{id, text}]。 */
export const tagTexts = (page) => page.evaluate(() => [...document.querySelectorAll('#tags .tag.c')].map((e) => ({ id: e.getAttribute('data-id'), text: e.textContent })));

/** 页面里现在的提示（toast）文字。 */
export const toastTexts = (page) => page.evaluate(() => (window.__town?.toasts ?? []).slice());

/** Godot 一侧 activity 功能的 debug()。 */
export const act = (p) => godotFeature(p.page, 'activity');
/** 网页一侧「一起」页签的 debug()。 */
export const pane = (p) => modState(p.page, 'activity');

/** 打开面板并切到「一起」页签。 */
export async function openActivity(page) {
  await openDock(page);
  if ((await page.getAttribute('#dock [data-tab="activity"]', 'aria-selected')) !== 'true') await page.click('#dock [data-tab="activity"]');
  await poll(async () => (await page.getAttribute('#dock [data-tab="activity"]', 'aria-selected')) === 'true' && (await dockState(page))?.tab === 'activity', 5000, '「一起」页签被选中');
}

/** 点某件物件（鼠标或触摸），按它在页面里的投影位置；位置被面板盖住时先关面板。 */
export async function clickObject(p, oid) {
  const read = () => p.page.evaluate((id) => window.__town.objects.find((o) => o.id === id) ?? null, oid);
  let o = await read();
  if (!o) throw new Error(`页面里没有物件 ${oid}`);
  const fr = await p.page.evaluate(() => (window.TownDock?.freeRect ? window.TownDock.freeRect() : null));
  if (fr && (o.sx > fr.r - 24 || o.sy > fr.b - 24)) {
    await closeDock(p.page);
    o = await read();
  }
  if (p.touch) await p.page.touchscreen.tap(o.sx, o.sy);
  else await p.page.mouse.click(o.sx, o.sy);
  return o;
}

/** 等自己（按服务器）停下，并返回位置。 */
export async function settle(h, p, ms = 60_000) {
  return h.until(async () => {
    const me = h.selfActor(await h.serverScene(p));
    return me && !me.nav ? me : null;
  }, ms, `${p.label} 走完`, 500);
}

/** 用地点菜单走进某个地点（桌面点击、手机轻点），等进了那片区域并停下。 */
export async function goPlace(h, p, dest, ms = 90_000) {
  if (p.touch) {
    await p.page.tap('#destBtn');
    await p.page.tap(`[data-dest=${dest}]`);
  } else {
    await p.page.click('#destBtn');
    await p.page.click(`[data-dest=${dest}]`);
  }
  await h.until(async () => {
    const s = await h.snap(p.page);
    const a = s.actors.find((x) => x.id === s.self);
    return s.space === dest && a && !a.moving;
  }, ms, `${p.label} 走进 ${dest} 并停下`, 400);
}
