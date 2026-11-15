// 带状态的物件（T02a）的端到端小工具：读 window.__town.props、用调试钩子强行切状态。只依赖 playwright 的 page。
// 页面要带 ?debug=1（props 和 setPropState 只在调试模式下有）；占位样件要再带 &props=sample。

/** window.__town.props：[{id, kind, state, states, forced}]（Godot 每 100 毫秒推一次）。 */
export const propsOf = (page) => page.evaluate(() => window.__town?.props ?? []);

/** 某件物件的当前状态名；没有这件物件返回 null。 */
export const propState = async (page, id) => (await propsOf(page)).find((p) => p.id === id)?.state ?? null;

/**
 * 强行切状态；state 传空串解除、回到服务端数据。window.__town.setPropState 由 hud.js 的 debugSet 在 ?debug=1 下挂，
 * 它发 ui 事件 debug_prop_state 给 Godot。这里直接发同一个事件，不依赖 __town 刚好是哪一份。
 */
export const setPropState = (page, id, state) => page.evaluate(([i, s]) => window.TownHost.emit('ui', 'debug_prop_state', JSON.stringify([String(i), String(s ?? '')])), [id, state]);
