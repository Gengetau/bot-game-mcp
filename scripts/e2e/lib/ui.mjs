// 面板（dock）的端到端小工具：开关、状态、Enter 打开、命中测试。所有函数只依赖 playwright 的 page，不依赖 client-e2e.mjs。
// 约定：页面都带 ?debug=1，所以 window.__dock 存在（dock.js 惰性读）：{ _dock: {open, tab, layout, kb, unread, ...}, <模块 id>: {...} }。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值；超时抛错。 */
export async function poll(fn, timeoutMs, what, every = 120) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时（${(timeoutMs / 1000).toFixed(0)} 秒）：${what}${last instanceof Error ? `（最后一次出错：${last.message}）` : ''}`);
    await sleep(every);
  }
}

/** 底座状态：{open, tab, layout, kb, unread, mods, core}；还没挂上返回 null。 */
export const dockState = (page) => page.evaluate(() => window.__dock?._dock ?? null);

/** 各模块自己的 debug()（如 __dock.nearby）。 */
export const modState = (page, id) => page.evaluate((i) => window.__dock?.[i] ?? null, id);

/** Godot 一侧该功能的 debug()（window.__town.features.<id>，每 100 毫秒推一次）。 */
export const godotFeature = (page, id) => page.evaluate((i) => window.__town?.features?.[i] ?? null, id);

/** 点 #dockBtn 打开面板并等它真的开了（aria-expanded=true）。已开着就不动。 */
export async function openDock(page) {
  if ((await dockState(page))?.open) return;
  await page.click('#dockBtn');
  await poll(async () => (await dockState(page))?.open && (await page.getAttribute('#dockBtn', 'aria-expanded')) === 'true', 5000, '面板打开');
  await poll(() => page.isVisible('#dock'), 3000, '#dock 可见');
}

/** 点 #dockBtn 关闭面板。已关着就不动。 */
export async function closeDock(page) {
  if (!(await dockState(page))?.open) return;
  await page.click('#dockBtn');
  await poll(async () => !(await dockState(page))?.open, 5000, '面板关闭');
}

/** 不在输入框里按 Enter：应打开面板并把焦点放进当前页签的输入框。 */
export async function pressEnterToChat(page) {
  await page.keyboard.press('Enter');
  await poll(() => page.evaluate(() => document.activeElement?.matches?.('#dock [data-focus]') === true), 5000, 'Enter 之后焦点进了输入框');
}

/** 屏幕坐标 (x,y) 上最上面的是什么：{id, tag, inDock, inCanvas}。 */
export const hitTest = (page, x, y) =>
  page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return null;
      return { id: el.id || '', tag: el.tagName.toLowerCase(), inDock: !!el.closest('#dock'), inCanvas: el.id === 'canvas' };
    },
    [x, y],
  );

/** 元素的外框（CSS 像素）。 */
export const rectOf = (page, sel) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().toJSON() ?? null, sel);

/**
 * 等 Godot 又渲染了 n 帧。__town.serverNow 只在 Godot 的帧里写，所以它「变化 n 次」就是至少走过了 n 帧。
 * 用来当屏障：触摸/按键等输入在帧之前处理，帧过去以后还没有效果，就是没有效果（不靠固定 sleep）。
 */
export async function frames(page, n = 2, timeoutMs = 20_000) {
  let prev = await page.evaluate(() => window.__town?.serverNow);
  let seen = 0;
  const t0 = Date.now();
  while (seen < n) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${n} 帧超时（页面可能卡住）`);
    await sleep(40);
    const cur = await page.evaluate(() => window.__town?.serverNow);
    if (cur !== prev) {
      seen++;
      prev = cur;
    }
  }
}

export const rectsOverlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
