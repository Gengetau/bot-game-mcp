// DOM 小工具：所有文字都走 textContent / 文本节点，不拼 innerHTML。
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @typedef {string | number | boolean | null | undefined | Node | unknown[]} Child
 */

/**
 * @param {Node} parent
 * @param {Child} kid
 */
function append(parent, kid) {
  if (kid === null || kid === undefined || kid === false || kid === true) return;
  if (Array.isArray(kid)) {
    for (const k of kid) append(parent, /** @type {Child} */ (k));
    return;
  }
  parent.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
}

/**
 * 创建 HTML 元素。props 里 onXxx 是事件，class/style/dataset 特殊处理，其余优先当属性。
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [props]
 * @param {...Child} kids
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  applyProps(el, props);
  for (const k of kids) append(el, k);
  return el;
}

/**
 * 创建 SVG 元素。
 * @template {keyof SVGElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...Child} kids
 * @returns {SVGElementTagNameMap[K]}
 */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.setAttribute('class', String(v));
      else el.setAttribute(k, String(v));
    }
  }
  for (const k of kids) append(el, k);
  return el;
}

/**
 * @param {HTMLElement} el
 * @param {Record<string, any> | null | undefined} props
 */
function applyProps(el, props) {
  if (!props) return;
  const anyEl = /** @type {Record<string, any>} */ (/** @type {unknown} */ (el));
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith('aria-') || k === 'role' || k === 'tabindex' || k === 'for') el.setAttribute(k, v === true ? 'true' : String(v));
    else if (k in el) anyEl[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

/**
 * 清空并填入新内容。
 * @param {Element} el
 * @param {...Child} kids
 */
export function fill(el, ...kids) {
  el.replaceChildren();
  for (const k of kids) append(el, k);
}

/**
 * 只有 key 变了才重建容器内容（避免事件刷新时打断点击或闪烁）。
 * @param {HTMLElement} el
 * @param {string} key
 * @param {() => Child} build
 */
export function memo(el, key, build) {
  if (el.dataset.memo === key) return;
  el.dataset.memo = key;
  fill(el, build());
}

// ───────────────────────── 图标 ─────────────────────────

/** @type {Record<string, string[]>} */
const ICONS = {
  map: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'],
  chat: ['M4 5h16v11H9l-5 4z'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c0-4.2 3.6-7 8-7s8 2.8 8 7'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 7 9-7'],
  people: ['M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11z', 'M2.5 20c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6', 'M16 5a3 3 0 0 1 0 6', 'M18 14.6c2.2.6 3.5 2.4 3.5 5.4'],
  coin: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9 12h6', 'M12 8v8'],
  bag: ['M5 8h14l-1 12H6z', 'M9 8V6a3 3 0 0 1 6 0v2'],
  lantern: ['M9 3h6', 'M12 3v2', 'M8 5h8l2 4v6l-2 3H8l-2-3V9z', 'M12 19v2', 'M9 9h6'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z'],
  cloud: ['M7 18a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 9.5 4.3 4.3 0 0 1 17 18z'],
  rain: ['M7 15a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 6.5 4.3 4.3 0 0 1 17 15z', 'M8 18l-1 3', 'M12 18l-1 3', 'M16 18l-1 3'],
  breeze: ['M3 9h10a2.5 2.5 0 1 0-2.5-2.5', 'M3 14h14a2.5 2.5 0 1 1-2.5 2.5', 'M3 19h6'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  send: ['M4 12 20 4l-4 16-4-6z', 'M12 14 20 4'],
  leave: ['M10 4H5v16h5', 'M15 8l4 4-4 4', 'M19 12H9'],
  theme: ['M12 3a9 9 0 1 0 0 18z'],
  home: ['M4 11 12 4l8 7', 'M6 10v10h12V10', 'M10 20v-5h4v5'],
  walk: ['M13 4a1.6 1.6 0 1 0 0 .01', 'M12 8l-3 3 2 3-1 6', 'M12 8l3 2 2 3', 'M12 14l3 2v4'],
  gift: ['M4 9h16v4H4z', 'M5 13v7h14v-7', 'M12 9v11', 'M12 9c-3 0-4-4-1.5-4 1.5 0 1.5 2 1.5 4z', 'M12 9c3 0 4-4 1.5-4-1.5 0-1.5 2-1.5 4z'],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'],
  dice: ['M5 5h14v14H5z', 'M9 9h.01', 'M15 9h.01', 'M12 12h.01', 'M9 15h.01', 'M15 15h.01'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  chevron: ['M9 6l6 6-6 6'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  wifi: ['M2 9a15 15 0 0 1 20 0', 'M5.5 12.5a10 10 0 0 1 13 0', 'M9 16a5 5 0 0 1 6 0', 'M12 19.5h.01'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  eye: ['M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
};

/**
 * 线条风格图标（装饰性，aria-hidden）。
 * @param {string} name
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function icon(name, size = 20) {
  const svg = s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
  for (const d of ICONS[name] ?? []) svg.appendChild(s('path', { d }));
  return svg;
}

// ───────────────────────── 时间格式 ─────────────────────────

/** @type {Map<string, Intl.DateTimeFormat>} */
const fmtCache = new Map();

/**
 * 世界时区里的 HH:MM。
 * @param {number} ms
 * @param {string} tz
 */
export function clockOf(ms, tz) {
  const parts = hourMinute(ms, tz);
  return `${String(parts.h).padStart(2, '0')}:${String(parts.m).padStart(2, '0')}`;
}

/**
 * @param {number} ms
 * @param {string} tz
 * @returns {{ h: number, m: number }}
 */
export function hourMinute(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    }
    fmtCache.set(tz, f);
  }
  let h24 = 0;
  let m = 0;
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === 'hour') h24 = Number(p.value);
    if (p.type === 'minute') m = Number(p.value);
  }
  return { h: h24, m };
}

/**
 * 「3 分钟前」「刚刚」这样的相对时间。
 * @param {number} ms
 * @param {number} now
 */
export function relTime(ms, now) {
  const d = Math.max(0, now - ms);
  if (d < 45_000) return '刚刚';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

/**
 * 剩余时间：「2 分 05 秒」。
 * @param {number} ms
 */
export function leftText(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  if (sec >= 60) return `${Math.floor(sec / 60)} 分 ${String(sec % 60).padStart(2, '0')} 秒`;
  return `${sec} 秒`;
}

/**
 * 月日 时:分（世界时区）。
 * @param {number} ms
 * @param {string} tz
 */
export function dateTimeOf(ms, tz) {
  let text = '';
  try {
    text = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'numeric', day: 'numeric' }).format(new Date(ms));
  } catch {
    text = new Date(ms).toLocaleDateString('zh-CN');
  }
  return `${text} ${clockOf(ms, tz)}`;
}

// ───────────────────────── toast ─────────────────────────

/**
 * 不打断的提示。
 * @param {string} text
 * @param {'info' | 'ok' | 'warn' | 'error'} [kind]
 * @param {number} [ms]
 * @param {{ label: string, onclick: () => void }} [action] 可选的一个按钮（例如「走过去」）
 */
export function toast(text, kind = 'info', ms = 4200, action) {
  const box = document.getElementById('toasts');
  if (!box) return;
  for (const old of [...box.children]) if (old.textContent === text) old.remove();
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  if (action) {
    el.append(' ', h('button', { class: 'toast-action', type: 'button', onclick: () => ((el.remove()), action.onclick()) }, action.label));
  }
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, ms);
}

// ───────────────────────── 弹层 ─────────────────────────

/** @type {{ el: HTMLElement, close: () => void }[]} */
const sheets = [];

/**
 * 打开一个弹层（手机上是底部抽屉，桌面上是居中的卡片）。
 * @param {{ title: string, body: Node, wide?: boolean, onClose?: () => void, label?: string }} opts
 * @returns {{ el: HTMLElement, close: () => void, body: HTMLElement }}
 */
export function openSheet(opts) {
  const prevFocus = document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : null;
  const bodyBox = h('div', { class: 'sheet-body' }, opts.body);
  const titleId = `sheet-t-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => api.close() }, icon('close', 20));
  const panel = h('div', { class: `sheet${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), h('header', { class: 'sheet-head' }, h('h2', { id: titleId }, opts.title), closeBtn), bodyBox);
  const backdrop = h('div', { class: 'backdrop', onclick: () => api.close() });
  const root = h('div', { class: 'sheet-root' }, backdrop, panel);
  let closed = false;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let onTab = null;
  const api = {
    el: root,
    body: bodyBox,
    close() {
      if (closed) return;
      closed = true;
      const i = sheets.findIndex((x) => x.el === root);
      if (i >= 0) sheets.splice(i, 1);
      if (onTab) document.removeEventListener('keydown', onTab);
      root.classList.add('out');
      setTimeout(() => root.remove(), 180);
      prevFocus?.focus?.({ preventScroll: true });
      opts.onClose?.();
    },
  };
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      api.close();
    }
  });
  // Tab 圈定挂在 document 上：焦点跑到弹层外时，root 上的监听收不到。只管最上面那一层。
  onTab = (e) => {
    if (e.key === 'Tab' && sheets[sheets.length - 1]?.el === root) {
      const focusables = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]).filter((x) => !x.hasAttribute('disabled') && x.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first && last) {
        const cur = document.activeElement;
        const inside = cur instanceof Node && panel.contains(cur) && cur !== panel;
        if (!inside) {
          // 焦点在面板本身，或已经跑到弹层外：拉回弹层内
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && cur === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && cur === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  };
  document.addEventListener('keydown', onTab);
  document.body.appendChild(root);
  sheets.push({ el: root, close: api.close });
  const firstField = /** @type {HTMLElement | null} */ (panel.querySelector('input, textarea, select'));
  (firstField ?? panel).focus({ preventScroll: true });
  return api;
}

export function closeAllSheets() {
  for (const sh of [...sheets]) sh.close();
}

/**
 * 确认对话框。
 * @param {{ title: string, text: string | Node, ok: string, cancel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (/** @type {boolean} */ v) => {
      if (answered) return;
      answered = true;
      sh.close();
      resolve(v);
    };
    const body = h(
      'div',
      { class: 'stack' },
      h('div', { class: 'confirm-text' }, opts.text),
      h('div', { class: 'row-end' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => done(false) }, opts.cancel ?? '再想想'), h('button', { type: 'button', class: `btn ${opts.danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, opts.ok)),
    );
    const sh = openSheet({ title: opts.title, body, onClose: () => done(false) });
  });
}

/**
 * 用初始字母做头像。
 * @param {string} name
 * @param {'human' | 'agent' | string} kind
 * @param {boolean} [mine]
 */
export function avatar(name, kind, mine = false) {
  const ch = [...name.trim()][0] ?? '?';
  return h('span', { class: `avatar ${kind === 'agent' ? 'agent' : 'human'}${mine ? ' mine' : ''}`, 'aria-hidden': 'true' }, ch);
}

/**
 * 简单的数字格式（千分位不需要，这里只是保护 NaN）。
 * @param {unknown} v
 * @param {number} [fb]
 */
export function num(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
