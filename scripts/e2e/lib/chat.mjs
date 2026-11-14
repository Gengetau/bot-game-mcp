// 聊天（附近）的端到端小工具。依赖 playwright 的 page / ctx，不依赖 client-e2e.mjs（站点地址取自页面自己的地址）。
import { poll, openDock, godotFeature, modState } from './ui.mjs';

const originOf = (p) => new URL(p.page.url()).origin;
const NEARBY = '#dock [data-pane="nearby"]';

/** 列表里的消息行（读 DOM 的 data-mid / data-from，不依赖文字）：[{mid, from, text, mine, cont}]。 */
export const nearbyRows = (page) =>
  page.evaluate((root) => {
    const out = [];
    for (const li of document.querySelectorAll(`${root} li[data-mid]`)) {
      out.push({ mid: Number(li.dataset.mid), from: li.dataset.from, text: li.querySelector('[data-role="text"]')?.textContent ?? '', mine: li.classList.contains('mine'), cont: li.classList.contains('cont') });
    }
    return out;
  }, NEARBY);

/** 系统行（如「附近没有人听到这句话」）的文字。 */
export const sysLines = (page) => page.evaluate((root) => [...document.querySelectorAll(`${root} li.sys`)].map((e) => e.textContent), NEARBY);

/** 未读：底座汇总、启动按钮角标（文字与可见性）、aria-label。 */
export const unread = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('#dockBtn .dock-badge');
    return { n: window.__dock?._dock?.unread ?? null, badge: b && !b.hidden ? b.textContent : '', hidden: !b || b.hidden, label: document.getElementById('dockBtn').getAttribute('aria-label') };
  });

/** 输入栏现状：{value, disabled, placeholder, sendDisabled, hint, hintClass, count}。 */
export const compose = (page) =>
  page.evaluate((root) => {
    const q = (r) => document.querySelector(`${root} [data-role="${r}"]`);
    return { value: q('input').value, disabled: q('input').disabled, placeholder: q('input').placeholder, sendDisabled: q('send').disabled, hint: q('hint').textContent, hintClass: q('hint').className, count: q('count').textContent, focused: document.activeElement === q('input') };
  }, NEARBY);

/** 文字库里的一句（模板里 [data-t=key] 的文字，{n} 之类占位原样返回）。 */
export const bank = (page, key) => page.evaluate(([root, k]) => document.querySelector(`${root} [data-bank] [data-t="${k}"]`)?.textContent ?? null, [NEARBY, key]);

/** 用界面发一句：打开面板、点进输入框、填字、按 Enter。返回前不等回应（调用方按需等 ack / 列表出现）。 */
export async function sendNearby(p, text) {
  await openDock(p.page);
  await p.page.fill(`${NEARBY} [data-role="input"]`, text);
  await p.page.press(`${NEARBY} [data-role="input"]`, 'Enter');
}

/**
 * 用界面发一句并等到它的回应（Godot 一侧 lastAck.n 对上本次序号）；返回 ack：{n, ok, heardBy?, code?, reason?, retryMs?, maxChars?}。
 * 先等 350 毫秒：聊天组件自己规定两次发送至少间隔 300 毫秒，间隔内的 Enter 会被忽略。
 */
export async function uiSay(p, text, timeoutMs = 20_000) {
  await openDock(p.page);
  await new Promise((r) => setTimeout(r, 350));
  const n = ((await modState(p.page, 'nearby'))?.seq ?? 0) + 1;
  await p.page.fill(`${NEARBY} [data-role="input"]`, text);
  await p.page.press(`${NEARBY} [data-role="input"]`, 'Enter');
  return poll(async () => {
    const f = await godotFeature(p.page, 'nearby');
    return f?.lastAck?.n === n ? f.lastAck : null;
  }, timeoutMs, `${p.label} 发「${text.slice(0, 12)}」得到回应`);
}

/** 等 Godot 一侧附近聊天的上一次回应（debug.lastAck）满足 fn。 */
export const waitAck = (p, fn, what, timeoutMs = 15_000) => poll(async () => {
  const f = await godotFeature(p.page, 'nearby');
  return f?.lastAck && fn(f.lastAck, f) ? f.lastAck : null;
}, timeoutMs, what);

/**
 * 用这个页面自己的身份走 API 发一句（让「对方发言」的一侧不占浏览器的额度和界面）。
 * 必须用该页面自己的 clientId，否则不是控制者会得到 control_lost；先读 /me 取 actionWindow、context.version、control.epoch、context.activityId。
 * API 发言后页面里 Godot 侧的 ctx_version 可能落后，下一次 UI 发送会走 context_stale 刷新重试一次，这是预期行为。
 * 返回 {status, body}（失败也返回，不抛）。
 */
export async function apiSay(p, text) {
  return apiAct(p, { type: 'say_nearby', text });
}

/**
 * 同 apiSay，但遇到限流（429）按服务器给的 retryAfterMs 等一等再试（最多 8 次）。
 * 用 API 代发不经过页面，Playwright 的页面监视看不到这些 4xx，所以不需要 allowFailure 声明。
 * 令牌桶是真实时间补充（每 10 秒 1 条），这里的等待是在等服务器的限流，不是糊弄时序。
 */
export async function apiSayWait(p, text) {
  for (let i = 0; i < 8; i++) {
    const r = await apiSay(p, text);
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, Math.min(12_000, (r.body?.retryAfterMs ?? r.body?.data?.retryAfterMs ?? 1000) + 200)));
  }
  throw new Error(`apiSayWait：连续 8 次限流，仍发不出去：${text.slice(0, 20)}`);
}

/** 同上，任意动作（如 navigate）。 */
export async function apiAct(p, action) {
  const base = originOf(p);
  const clientId = await p.page.evaluate(() => window.TownHud.clientId());
  const me = await (await p.ctx.request.get(`${base}/town/api/me?clientId=${encodeURIComponent(clientId)}`)).json();
  const requestId = `e2e-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  const r = await p.ctx.request.post(`${base}/town/api/actions`, {
    data: { clientId, requestId, actionWindow: me.actionWindow, expected: { contextVersion: me.context?.version, controlEpoch: me.control?.epoch, activityId: me.context?.activityId ?? null }, action },
  });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

/** 服务端真相：这个居民能读到的附近聊天历史（新的在前）。 */
export async function apiHistory(p, limit = 100) {
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/history?limit=${limit}`);
  return (await r.json()).messages ?? [];
}

/**
 * 声明接下来会有 min~max 次「被服务器规则拒绝」的发言请求（429 限流或 400 超长，都是 POST /actions），然后执行 fn，返回 fn 的结果。
 * （Chromium 每个 4xx 在控制台打一行，次数必须等于声明次数，收尾核对。）
 */
export async function expectReject(p, why, fn, { min = 1, max = 1 } = {}) {
  p.w.allow.push({ method: 'POST', path: /\/town\/api\/actions$/, min, max, why, hits: 0 });
  return fn();
}
