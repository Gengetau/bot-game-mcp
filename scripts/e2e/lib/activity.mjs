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
export async function clickObject(p, oid, { dy = 0 } = {}) {
  const read = () => p.page.evaluate((id) => window.__town.objects.find((o) => o.id === id) ?? null, oid);
  let o = await read();
  if (!o) throw new Error(`页面里没有物件 ${oid}`);
  const fr = await p.page.evaluate(() => (window.TownDock?.freeRect ? window.TownDock.freeRect() : null));
  if (fr && (o.sx > fr.r - 24 || o.sy > fr.b - 24)) {
    await closeDock(p.page);
    o = await read();
  }
  if (p.touch) await p.page.touchscreen.tap(o.sx, o.sy + dy);
  else await p.page.mouse.click(o.sx, o.sy + dy);
  return o;
}

/** 等自己（按服务器）停下，并返回位置。点击之后导航要过一会儿才出现在服务器视图里，所以先等一下，且要连续两次都看到停着才算。 */
export async function settle(h, p, ms = 60_000) {
  await sleep(900);
  let still = 0;
  return h.until(async () => {
    const me = h.selfActor(await h.serverScene(p));
    still = me && !me.nav ? still + 1 : 0;
    return still >= 2 ? me : null;
  }, ms, `${p.label} 走完`, 400);
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

/**
 * 「一起」页签里可见文字的对比度（WCAG：正文要求 4.5:1）。逐个有直接文字的可见元素，取它的文字颜色和最近的不透明背景（半透明的往下叠）。
 * 返回 [{text, ratio, px, bg, fg}]，只含低于 min 的。页签没打开 / 面板收起时（元素不可见）返回空。
 */
export const lowContrast = (page, min = 4.5) =>
  page.evaluate((limit) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = (c) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const bgOf = (el) => {
      const chain = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) chain.push(c);
        if (c && c.a >= 1) break;
      }
      let acc = { r: 255, g: 255, b: 255, a: 1 };
      for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
      return acc;
    };
    const out = [];
    for (const el of document.querySelectorAll('#dock [data-pane="activity"] *')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join('');
      if (!own || !el.offsetParent) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const fg = over(parse(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 }, bgOf(el));
      const bg = bgOf(el);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < limit) out.push({ text: own.slice(0, 24), ratio: Math.round(ratio * 100) / 100, px: cs.fontSize, role: el.getAttribute('data-role') ?? el.className });
    }
    return out;
  }, min);

/** 浏览器里能存东西的几个地方：localStorage、sessionStorage、IndexedDB 的库名、cookie 的名字、地址栏（不含主机）。 */
export const storageState = (page) =>
  page.evaluate(async () => {
    const dump = (s) => Object.fromEntries(Object.keys(s).map((k) => [k, String(s.getItem(k))]));
    let idb = [];
    try {
      idb = (await indexedDB.databases()).map((d) => d.name).sort();
    } catch {
      idb = ['(不可读)'];
    }
    return { local: dump(localStorage), session: dump(sessionStorage), idb, cookies: document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).sort(), url: location.pathname + location.search + location.hash };
  });

/** 被拒后留在 #actions 里的某类按钮的出现记录：先 watchActions 挂观察器，再 actionsLog 取。每次 #actions 变化记一条 {t, ids:[{id, disabled}]}。 */
export const watchActions = (page) =>
  page.evaluate(() => {
    window.__actLog = [];
    const box = document.getElementById('actions');
    const snap = () => window.__actLog.push({ t: performance.now(), ids: [...box.querySelectorAll('button')].map((b) => ({ id: b.dataset.action, disabled: b.disabled })) });
    snap();
    window.__actObs?.disconnect();
    window.__actObs = new MutationObserver(snap);
    window.__actObs.observe(box, { childList: true, subtree: true, attributes: true, characterData: true });
  });
export const actionsLog = (page) => page.evaluate(() => window.__actLog ?? []);
/** 点击之后某类按钮「先消失或变灰、后来又可点地出现」的次数（空窗里按钮闪回）。 */
export function reappeared(log, prefix) {
  let gone = false;
  let n = 0;
  for (const s of log) {
    const live = s.ids.some((b) => b.id.startsWith(prefix) && !b.disabled);
    if (!live) gone = true;
    else if (gone) n += 1;
  }
  return n;
}
