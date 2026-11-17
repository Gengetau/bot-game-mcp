// 通用界面部件：按钮、分段控件、进度条、表单字段等。
import { h, icon, fill } from './dom.js';
import { state } from './store.js';

/** @typedef {import('./dom.js').Child} Child */

/**
 * @typedef {{
 *   variant?: 'primary' | 'ghost' | 'danger' | 'soft',
 *   small?: boolean,
 *   icon?: string,
 *   disabled?: boolean,
 *   why?: string,
 *   aria?: string,
 *   always?: boolean,
 *   block?: boolean,
 * }} BtnOpts
 */

/**
 * 按钮：点击期间自动禁用并标记 aria-busy；页面处于只读（没有控制权）时自动禁用，除非 always。
 * @param {string} label
 * @param {(e: MouseEvent) => unknown} onClick
 * @param {BtnOpts} [o]
 */
export function btn(label, onClick, o = {}) {
  const readonly = !o.always && state.readOnly;
  const disabled = Boolean(o.disabled) || readonly;
  const why = readonly && !o.disabled ? '这个页面现在是只读的：另一个页面握着控制权。' : o.why;
  const b = h(
    'button',
    {
      type: 'button',
      class: `btn ${o.variant ?? ''}${o.small ? ' sm' : ''}${o.block ? ' block' : ''}`.trim(),
      disabled,
      title: why,
      'aria-label': o.aria,
    },
    o.icon ? icon(o.icon, o.small ? 15 : 17) : null,
    h('span', null, label),
  );
  if (why && disabled) b.setAttribute('aria-description', why);
  b.addEventListener('click', async (e) => {
    if (b.disabled) return;
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
    try {
      await onClick(e);
    } finally {
      b.disabled = disabled;
      b.removeAttribute('aria-busy');
    }
  });
  return b;
}

/**
 * 小的信息标签。
 * @param {Child} text
 * @param {string} [tone]
 */
export function chip(text, tone = '') {
  return h('span', { class: `chip ${tone}`.trim() }, text);
}

/**
 * 区块：标题 + 内容。
 * @param {string} title
 * @param {Child} body
 * @param {{ aside?: Child, hint?: string, id?: string }} [o]
 */
export function section(title, body, o = {}) {
  return h('section', { class: 'sec', id: o.id }, h('div', { class: 'sec-head' }, h('h3', null, title), o.aside ?? null), o.hint ? h('p', { class: 'hint' }, o.hint) : null, body);
}

/**
 * 空状态。
 * @param {string} title
 * @param {string} [text]
 */
export function empty(title, text) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-art', 'aria-hidden': 'true' }, icon('lantern', 30)), h('p', { class: 'empty-title' }, title), text ? h('p', { class: 'hint' }, text) : null);
}

/**
 * 分段控件（带 aria）。
 * @param {{ id: string, label: string, badge?: number | string }[]} items
 * @param {string} current
 * @param {(id: string) => void} onPick
 * @param {string} aria
 */
export function segmented(items, current, onPick, aria) {
  const row = h('div', { class: 'seg', role: 'tablist', 'aria-label': aria });
  for (const it of items) {
    const b = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        class: `seg-item${it.id === current ? ' on' : ''}`,
        'aria-selected': it.id === current ? 'true' : 'false',
        tabindex: it.id === current ? '0' : '-1',
        onclick: () => onPick(it.id),
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const idx = items.findIndex((x) => x.id === it.id);
          const nxt = items[(idx + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
          if (nxt) {
            onPick(nxt.id);
            requestAnimationFrame(() => /** @type {HTMLElement | null} */ (row.querySelector('[aria-selected="true"]'))?.focus());
          }
        },
      },
      it.label,
      it.badge ? h('span', { class: 'badge' }, String(it.badge)) : null,
    );
    row.appendChild(b);
  }
  return row;
}

/**
 * 需要条。
 * @param {string} label
 * @param {number} value 0~100
 * @param {string} tone
 */
export function meter(label, value, tone) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return h(
    'div',
    { class: `meter ${tone}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(v), 'aria-label': label },
    h('div', { class: 'meter-top' }, h('span', null, label), h('span', { class: 'meter-v' }, String(v))),
    h('div', { class: 'meter-bar' }, h('div', { class: 'meter-fill', style: { width: `${v}%` } })),
    v < 30 ? h('div', { class: 'meter-low' }, '有点低了') : null,
  );
}

/**
 * 进度条。
 * @param {number} value
 * @param {number} max
 * @param {string} label
 */
export function progress(value, max, label) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value), 'aria-label': label }, h('div', { class: 'progress-fill', style: { width: `${pct}%` } }));
}

/**
 * 倒计时文字：由 app 的秒表统一刷新。
 * @param {number} untilMs 服务器时间的截止点
 * @param {string} [prefix]
 */
export function countdown(untilMs, prefix = '') {
  return h('span', { class: 'cd', dataset: { until: String(untilMs), prefix } }, '');
}

/**
 * 表单字段。
 * @param {string} label
 * @param {HTMLElement} control
 * @param {string} [hint]
 */
export function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

/**
 * 开关。
 * @param {string} label
 * @param {boolean} on
 * @param {(v: boolean) => void} onChange
 * @param {string} [hint]
 */
export function toggle(label, on, onChange, hint) {
  const input = h('input', { type: 'checkbox', checked: on, role: 'switch', onchange: () => onChange(input.checked) });
  return h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-track', 'aria-hidden': 'true' }), h('span', { class: 'toggle-text' }, label, hint ? h('small', null, hint) : null));
}

/**
 * 一行名片：头像 + 主文本 + 副文本 + 右侧操作。
 * @param {{ lead?: Child, title: Child, sub?: Child, aside?: Child, onClick?: () => void, aria?: string, cls?: string }} o
 */
export function row(o) {
  const inner = [o.lead ? h('div', { class: 'row-lead' }, o.lead) : null, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, o.title), o.sub ? h('div', { class: 'row-sub' }, o.sub) : null), o.aside ? h('div', { class: 'row-aside' }, o.aside) : null];
  if (o.onClick) {
    const handler = o.onClick;
    return h('button', { type: 'button', class: `row clickable ${o.cls ?? ''}`.trim(), 'aria-label': o.aria, onclick: () => handler() }, inner);
  }
  return h('div', { class: `row ${o.cls ?? ''}`.trim() }, inner);
}

/**
 * 把容器内容整体替换。
 * @param {HTMLElement} el
 * @param {Child} content
 */
export function show(el, content) {
  fill(el, content);
}

/**
 * 安全的多行文字（保留换行）。
 * @param {string} text
 */
export function para(text) {
  return h('p', { class: 'para' }, text);
}
