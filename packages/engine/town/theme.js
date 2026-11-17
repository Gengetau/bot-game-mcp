// 主题：跟随系统（默认），或手动固定浅色 / 深色。
/** @typedef {'auto' | 'light' | 'dark'} ThemeMode */

/** @returns {ThemeMode} */
export function getTheme() {
  try {
    const v = localStorage.getItem('town.theme');
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* 存储不可用就用系统 */
  }
  return 'auto';
}

/** @param {ThemeMode} mode */
export function setTheme(mode) {
  try {
    if (mode === 'auto') localStorage.removeItem('town.theme');
    else localStorage.setItem('town.theme', mode);
  } catch {
    /* ignore */
  }
  applyTheme();
}

export function applyTheme() {
  const mode = getTheme();
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1b1722' : '#f6efe0');
}

/** 依次切换：跟随系统 → 浅色 → 深色 */
export function cycleTheme() {
  const next = /** @type {Record<ThemeMode, ThemeMode>} */ ({ auto: 'light', light: 'dark', dark: 'auto' })[getTheme()];
  setTheme(next);
  return next;
}

/** @param {ThemeMode} m */
export const themeName = (m) => ({ auto: '跟随系统', light: '浅色', dark: '深色' })[m];

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
