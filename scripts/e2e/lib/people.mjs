// C4：居民卡、邀请、门牌的端到端小工具。依赖 playwright 的 page / ctx，不依赖 client-e2e.mjs（站点地址取自页面自己的地址）。
// 约定：页面都带 ?debug=1，所以 window.__dock.people（网页一侧 debug）和 window.__town.features.people（Godot 一侧 debug）存在。
import { poll, modState, godotFeature, rectOf } from './ui.mjs';

const originOf = (p) => new URL(p.page.url()).origin;
const PANE = '#dock [data-pane="people"]';

/** 居民卡的现状（网页一侧 debug）：{cardOpen, cardId, kind, kindText, name, hint, hintKind, note, askDisabled, inviteDisabled, inviteText, invleft, hobby, text, rect, doors, invites, houseOpen, houseMine, houseTitle, houseTag, houseDecor, unread}。 */
export const peopleCard = (page) => modState(page, 'people');

/** 门牌行：[{home, can, mine, enterDisabled, enterText}]。 */
export const doorRows = async (page) => (await peopleCard(page))?.doors ?? [];

/** 请柬行：[{grantId, home, fresh, skip}]。 */
export const inviteRows = async (page) => (await peopleCard(page))?.invites ?? [];

/** 「屋里」一栏。 */
export const houseInfo = async (page) => {
  const d = await peopleCard(page);
  return d ? { open: d.houseOpen, mine: d.houseMine, title: d.houseTitle, tag: d.houseTag, decor: d.houseDecor } : null;
};

/** Godot 一侧 people 的 debug。 */
export const godotPeople = (p) => godotFeature(p.page, 'people');

/** 文字库里的一句（占位符原样返回）。 */
export const bank = (page, key) => page.evaluate(([root, k]) => document.querySelector(`${root} [data-bank] [data-t="${k}"]`)?.textContent ?? null, [PANE, key]);

/** 服务端真相：GET /me（用这个页面自己的 clientId）。 */
export async function serverMe(p) {
  const clientId = await p.page.evaluate(() => window.TownHud.clientId());
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/me?clientId=${encodeURIComponent(clientId)}`);
  return r.json();
}

/** 页面里（按居民编号）某人的屏幕位置（像素）与视口。 */
export const screenOf = (page, id) =>
  page.evaluate((i) => {
    const a = window.__town.actors.find((x) => x.id === i);
    return a ? { x: a.nx * window.innerWidth, y: a.ny * window.innerHeight, nx: a.nx, ny: a.ny } : null;
  }, id);

/** 点屏幕上的某位居民（桌面鼠标，手机触摸）。点之前检查那一点最上面确实是画布，否则抛错（免得点到了面板或按钮上）。 */
export async function clickActor(p, id) {
  const s = await screenOf(p.page, id);
  if (!s) throw new Error(`${p.label} 的画面里没有 ${id}`);
  const top = await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y]);
  if (top !== 'canvas') throw new Error(`${p.label} 点 ${id} 的位置 (${s.x.toFixed(0)},${s.y.toFixed(0)}) 最上面是 #${top || '(别的元素)'}，不是画布`);
  if (p.touch) await p.page.touchscreen.tap(s.x, s.y);
  else await p.page.mouse.click(s.x, s.y);
  return s;
}

/** #actions 里的按钮：[{id, label, sub}]。 */
export const actionButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#actions button')].map((b) => ({ id: b.getAttribute('data-action') ?? '', label: b.querySelector('span')?.textContent ?? '', sub: b.querySelector('small')?.textContent ?? '', disabled: b.disabled })),
  );

/** 页面上现在的提示条文字。 */
export const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent ?? ''));

/** 底座汇总角标与各模块自己的未读（调用方按需比较）。 */
export const badge = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('#dockBtn .dock-badge');
    const d = window.__dock ?? {};
    let sum = 0;
    for (const k of Object.keys(d)) if (k !== '_dock' && typeof d[k]?.unread === 'number') sum += d[k].unread;
    return { text: b && !b.hidden ? b.textContent : '', hidden: !b || b.hidden, total: d._dock?.unread ?? null, sum, people: d.people?.unread ?? null };
  });

/** 页签「人家」上的小圆点是否可见。 */
export const peopleDot = (page) => page.evaluate(() => { const d = document.querySelector('#dockTabs [data-tab="people"] .tab-dot'); return !!d && !d.hidden; });

/** 打开面板并切到「人家」页签（点页签）。 */
export async function openPeopleTab(page) {
  const open = await page.evaluate(() => !!window.__dock?._dock?.open);
  if (!open) {
    await page.click('#dockBtn');
    await poll(() => page.evaluate(() => !!window.__dock?._dock?.open), 5000, '面板打开');
  }
  // 真实的点击路径：页签中心最上面必须是页签本身（手机抽屉里曾被 #dockGrip 盖住，真手指点不到），触屏页面用真触摸点
  const hitInfo = await page.evaluate(() => {
    const t = document.querySelector('#dockTabs [data-tab="people"]');
    const r = t.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, ok: !!top && !!top.closest('[data-tab="people"]'), top: top?.id || top?.className || top?.tagName || '', coarse: matchMedia('(pointer: coarse)').matches };
  });
  if (!hitInfo.ok) throw new Error(`「人家」页签中心 (${hitInfo.x.toFixed(0)},${hitInfo.y.toFixed(0)}) 最上面是 ${hitInfo.top}，真手指点不到页签`);
  if (hitInfo.coarse) await page.touchscreen.tap(hitInfo.x, hitInfo.y);
  else await page.click('#dockTabs [data-tab="people"]');
  await poll(() => page.evaluate(() => window.__dock?._dock?.tab === 'people'), 5000, '切到人家页签');
}

/** 关掉面板（已关着就不动）。 */
export async function closePanel(page) {
  const open = await page.evaluate(() => !!window.__dock?._dock?.open);
  if (!open) return;
  await page.click('#dockBtn');
  await poll(() => page.evaluate(() => !window.__dock?._dock?.open), 5000, '面板关闭');
}

/** 点门牌里某户的按钮（data-home 对上）。 */
export async function clickDoor(page, home) {
  await page.click(`${PANE} [data-role="doorList"] > li[data-home="${home}"] [data-role="enter"]`);
}

/** 画布上的元素外框，没有就 null。 */
export const rectOfSel = rectOf;

/** 两个矩形（{left,right,top,bottom}）是否相交。 */
export const hit = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** 点（像素）是否在矩形里（留 pad 像素的边）。 */
export const inside = (r, pt, pad = 0) => !!r && !!pt && pt.x >= r.left - pad && pt.x <= r.right + pad && pt.y >= r.top - pad && pt.y <= r.bottom + pad;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
