// V1 观感收尾（95 到 97 号步骤文件）的公共小工具。只依赖 playwright 的 page，不依赖 client-e2e.mjs。
// 约定：页面都带 ?debug=1，所以 window.__town（Godot 每 100 毫秒写一次，含 view、layout、vp）和 window.__dock 存在。
import { poll } from './ui.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hit = (a, b, m = 0) => !!a && !!b && a.left < b.right + m && b.left < a.right + m && a.top < b.bottom + m && b.top < a.bottom + m;
export const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
export const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/** 镜头一侧的状态：{ view: {msgs, tx, ty, gx, gy, settled}, layout: {sent, passes, rect, hintMode}, vp, rect(画布), W, H }。 */
export const viewState = (page) =>
  page.evaluate(() => {
    const t = window.__town;
    if (!t) return null;
    return { view: t.view ?? null, layout: t.layout ?? null, vp: t.vp ?? null, self: t.self, W: window.innerWidth, H: window.innerHeight, serverNow: t.serverNow };
  });

/** 自己脚下（地面）在页面里的投影点和归一化位置。 */
export const selfScreen = (page) =>
  page.evaluate(() => {
    const t = window.__town;
    const me = t.actors.find((a) => a.id === t.self);
    const q = t.project(me.x, 0, me.z);
    return { x: q.x, y: q.y, nx: q.x / window.innerWidth, ny: q.y / window.innerHeight, wx: me.x, wz: me.z, W: window.innerWidth, H: window.innerHeight, moving: !!me.moving };
  });

/**
 * 不依赖 layout.js、直接从 DOM 现量的「没被界面盖住的那块」：整个视口去掉顶栏、面板（抽屉或侧栏）、底部按钮行（#actions、#controls）、软键盘。
 * 和实现是两份独立的算法（测试里的这份只用 getBoundingClientRect），两边对不上就是有人算错了。
 */
export const domFree = (page) =>
  page.evaluate(() => {
    const W = document.getElementById('hud').clientWidth;
    const H = document.getElementById('hud').clientHeight;
    const vis = (e) => e && !e.hidden && e.offsetWidth > 0 && e.offsetHeight > 0;
    const dockOpen = document.body.getAttribute('data-dock-open') === '1' && vis(document.getElementById('dock'));
    const lay = document.body.getAttribute('data-dock');
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb')) || 0;
    let t = document.getElementById('topbar').getBoundingClientRect().bottom;
    for (const id of ['readonly', 'statusRow']) {
      const e = document.getElementById(id);
      if (vis(e)) t = Math.max(t, e.getBoundingClientRect().bottom);
    }
    let b = H - kb;
    let r = W;
    for (const id of ['actions', 'controls']) {
      const e = document.getElementById(id);
      if (vis(e)) b = Math.min(b, e.getBoundingClientRect().top);
    }
    if (dockOpen) {
      const d = document.getElementById('dock');
      // 面板的布局位置（不含进场动画的 transform）
      if (lay === 'side') r = Math.min(r, d.offsetLeft);
      else b = Math.min(b, d.offsetTop);
    }
    return { l: 0, t, r, b, W, H, layout: lay, dockOpen, kb };
  });

/**
 * 等版式和镜头都稳了：目标点缓动完（view.settled）、网页层的版式量过了（layout.passes 连续 stableMs 没变）、目标点没再动。
 * 返回稳定后的 viewState。
 */
export async function settleView(page, { timeout = 15_000, stableMs = 500, what = '版式与镜头稳定' } = {}) {
  let last = null;
  let since = 0;
  return poll(
    async () => {
      const s = await viewState(page);
      if (!s?.view || !s.layout) return false;
      const key = `${s.layout.passes}|${s.view.gx.toFixed(4)}|${s.view.gy.toFixed(4)}|${s.layout.sent}`;
      if (key !== last) {
        last = key;
        since = Date.now();
        return false;
      }
      if (!s.view.settled || Date.now() - since < stableMs) return false;
      return s;
    },
    timeout,
    what,
    100,
  );
}

/** 4x4 投影矩阵（Godot 给的列主序 vp）下，屏幕像素 q 对应的地面（y=0）上的世界点 {x,z}。 */
export function unprojectGround(vp, W, H, q) {
  const xn = (q.x / W) * 2 - 1;
  const yn = 1 - (q.y / H) * 2;
  const m = vp;
  // clip.x = m0 x + m8 z + m12；clip.y = m1 x + m9 z + m13；clip.w = m3 x + m11 z + m15（y=0）
  const a1 = m[0] - xn * m[3];
  const b1 = m[8] - xn * m[11];
  const c1 = xn * m[15] - m[12];
  const a2 = m[1] - yn * m[3];
  const b2 = m[9] - yn * m[11];
  const c2 = yn * m[15] - m[13];
  const det = a1 * b2 - a2 * b1;
  return { x: (c1 * b2 - c2 * b1) / det, z: (a1 * c2 - a2 * c1) / det };
}

/** 点到线段的距离。 */
export function distToSeg(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}

/**
 * #tags 里的牌：[{id, cls, kind, text, off（避让淡出）, rect}]。kind 是第一个类名之后的那个（s a npc c g o p z b）。
 * 只含真正画着的：没被避让藏起来（.off）、没 display:none、有尺寸。
 */
export const tagList = (page, { includeHidden = false } = {}) =>
  page.evaluate((inc) => {
    const out = [];
    for (const e of document.querySelectorAll('#tags .tag')) {
      const cs = getComputedStyle(e);
      const off = e.classList.contains('off') || cs.display === 'none';
      if (off && !inc) continue;
      const r = e.getBoundingClientRect();
      if (!(r.width > 0)) continue;
      out.push({ id: e.getAttribute('data-id'), cls: e.className, kind: e.classList[1] ?? '', text: e.textContent, off, rect: r.toJSON() });
    }
    return out;
  }, includeHidden);

/**
 * 一组元素里文字对底的对比度（WCAG）。底按祖先链上的 background-color 叠起来（半透明的往下叠，最后叠在 backdrop 上）；
 * 元素自己的 opacity 也算进去（文字和底都按 opacity 变淡，等于整个元素叠在 backdrop 上）。backdrop 默认白（最亮的地砖），可传别的。
 * sels：选择器列表；返回 [{sel, text, ratio, fg, bg}]。
 */
export const contrastOf = (page, sels, backdrop = { r: 255, g: 255, b: 255 }) =>
  page.evaluate(
    ([list, bd]) => {
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
      const out = [];
      for (const sel of list) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
          const chain = [];
          let op = 1;
          for (let e = el; e; e = e.parentElement) {
            const cs = getComputedStyle(e);
            op *= Number(cs.opacity);
            const c = parse(cs.backgroundColor);
            if (c && c.a > 0) chain.push(c);
            if (c && c.a >= 1) break;
          }
          let acc = { ...bd, a: 1 };
          for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
          const cs0 = getComputedStyle(el);
          const fgRaw = parse(cs0.color) ?? { r: 0, g: 0, b: 0, a: 1 };
          const bg = over({ ...acc, a: op }, { ...bd, a: 1 });
          const fg = over({ ...over(fgRaw, acc), a: op }, { ...bd, a: 1 });
          const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          out.push({ sel, text: (el.textContent ?? '').trim().slice(0, 12), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, fg: `${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)}`, bg: `${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}` });
        }
      }
      return out;
    },
    [sels, backdrop],
  );
