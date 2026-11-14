// C3：入座玩小游戏（街机厅数字炸弹）的端到端小工具。依赖 playwright 的 page / ctx，不依赖 client-e2e.mjs。
// 约定：页面都带 ?debug=1，所以 window.__dock.game（网页一侧 debug）和 window.__town.features.game（Godot 一侧 debug）存在。
import { poll, modState, godotFeature } from './ui.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const originOf = (p) => new URL(p.page.url()).origin;

/** 网页一侧面板现状（__dock.game）。 */
export const gameMod = (page) => modState(page, 'game');
/** Godot 一侧 game 功能的现状。 */
export const godotGame = (p) => godotFeature(p.page, 'game');

/** #actions 里的按钮：[{id, label, sub, disabled}]。 */
export const actionButtons = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#actions button')].map((b) => ({ id: b.getAttribute('data-action') ?? '', label: b.querySelector('span')?.textContent ?? '', sub: b.querySelector('small')?.textContent ?? '', disabled: b.disabled })),
  );
export const gameButtons = async (page) => (await actionButtons(page)).filter((b) => b.id.startsWith('f:game:'));

/** 页面上现在的提示条文字。 */
export const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent ?? ''));

/** #tags 里的桌牌（.tag.g）：[{id, text, rect}]。 */
export const tableTags = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#tags .tag.g')].map((e) => ({ id: e.getAttribute('data-id'), text: e.textContent, rect: e.getBoundingClientRect().toJSON() })));

/** 屏幕上某张游戏桌的世界位置投影：window.__town.objects 里有 id 与屏幕坐标（sx, sy）。 */
export const objectScreen = (page, oid) =>
  page.evaluate((i) => {
    const o = (window.__town.objects ?? []).find((x) => x.id === i);
    return o ? { x: o.sx, y: o.sy, nx: o.nx, ny: o.ny } : null;
  }, oid);

/** 点屏幕上的一张桌子（桌面鼠标，手机触摸）。点之前检查那一点最上面确实是画布。 */
export async function clickObject(p, oid) {
  const s = await objectScreen(p.page, oid);
  if (!s) throw new Error(`${p.label} 的画面里没有物件 ${oid}`);
  const top = await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y]);
  if (top !== 'canvas') throw new Error(`${p.label} 点 ${oid} 的位置 (${s.x.toFixed(0)},${s.y.toFixed(0)}) 最上面是 #${top || '(别的元素)'}，不是画布`);
  if (p.touch) await p.page.touchscreen.tap(s.x, s.y);
  else await p.page.mouse.click(s.x, s.y);
  return s;
}

/** 服务端真相：GET /me（用这个页面自己的 clientId）。 */
export async function serverMe(p) {
  const clientId = await p.page.evaluate(() => window.TownHud.clientId());
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/me?clientId=${encodeURIComponent(clientId)}`);
  return r.json();
}

/** 用这个页面自己的身份走 API 发一个动作（和 chat.mjs 的 apiAct 同款）。代发的被拒请求页面监视看不到，不用声明。 */
export async function apiAct(p, action, patch = {}) {
  const base = originOf(p);
  const clientId = await p.page.evaluate(() => window.TownHud.clientId());
  const me = await (await p.ctx.request.get(`${base}/town/api/me?clientId=${encodeURIComponent(clientId)}`)).json();
  const requestId = `e2e-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  const r = await p.ctx.request.post(`${base}/town/api/actions`, {
    data: { clientId, requestId, actionWindow: me.actionWindow, expected: { contextVersion: me.context?.version, controlEpoch: me.control?.epoch, activityId: me.context?.activityId ?? null }, action, ...patch },
  });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

/** 服务端真相：匿名公开投影 GET /public/game/:id。 */
export async function publicGame(p, activityId) {
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/public/game/${encodeURIComponent(activityId)}`);
  return { status: r.status(), body: await r.json().catch(() => null) };
}

/** 服务端真相：GET /history（附近聊天，新的在前）。 */
export async function historyOf(p, limit = 100) {
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/history?limit=${limit}`);
  return (await r.json()).messages ?? [];
}

/** 数字炸弹的中点猜法：范围 [from, to]。 */
export const midOf = (rg) => Math.floor((rg.from + rg.to) / 2);

/**
 * 只走 API 的居民（没有页面）：开发登录、进入、定时心跳、结束时清理。
 * 用一个独立的浏览器上下文（独立的 Cookie），所以是另一个人。长路用「导航 + 续租」走，不让 10 秒租约把人丢在半路。
 */
export async function apiResident(browser, base, name, { query } = {}) {
  void query;
  const ctx = await browser.newContext();
  const req = ctx.request;
  const clientId = `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const st = { presenceEpoch: 0, hb: null, closed: false, id: null, name: null, rejected: [] };
  const post = async (path, data) => {
    const r = await req.post(`${base}/town/api${path}`, { data });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  const get = async (path) => {
    const r = await req.get(`${base}/town/api${path}`);
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  const login = await post('/auth/dev', { name });
  if (login.status !== 200) throw new Error(`API 居民登录失败：${login.status} ${JSON.stringify(login.body)}`);
  const enter = await post('/enter', { clientId, profile: { name } });
  if (enter.status !== 200 || !enter.body?.ok) throw new Error(`API 居民进入失败：${enter.status} ${JSON.stringify(enter.body)}`);
  st.presenceEpoch = enter.body.presenceEpoch ?? 0;
  st.id = enter.body.view?.me?.id ?? null;
  st.name = enter.body.view?.me?.name ?? name;
  const beat = async () => {
    if (st.closed) return;
    const r = await post('/heartbeat', { clientId, presenceEpoch: st.presenceEpoch }).catch(() => null);
    if (r?.body?.nextHeartbeatMs) st.next = r.body.nextHeartbeatMs;
  };
  st.hb = setInterval(beat, 8000);
  const me = async () => (await get(`/me?clientId=${encodeURIComponent(clientId)}`)).body;
  const act = async (action) => {
    const m = await me();
    const requestId = `c-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
    const r = await post('/actions', { clientId, requestId, actionWindow: m.actionWindow, expected: { contextVersion: m.context?.version, controlEpoch: m.control?.epoch, activityId: m.context?.activityId ?? null }, action });
    if (r.status >= 400) st.rejected.push({ type: action.type, status: r.status, reason: r.body?.reason ?? null });
    return r;
  };
  const scene = async () => (await get('/scene')).body;
  const selfOf = (sc) => sc?.actors?.find((a) => a.id === sc.self);
  /** 走到某个地点或点（API 导航 + 续租，直到停下）。 */
  const walk = async (to, timeoutMs = 90_000) => {
    const r = await act({ type: 'navigate', to });
    if (r.status !== 200) throw new Error(`API 居民 ${st.name} 导航失败：${r.status} ${JSON.stringify(r.body)}`);
    const t0 = Date.now();
    for (;;) {
      const s = selfOf(await scene());
      if (!s?.nav) return s;
      if (Date.now() - t0 > timeoutMs) throw new Error(`API 居民 ${st.name} 走了 ${timeoutMs / 1000} 秒还没到`);
      await post('/nav/renew', { clientId, navigationId: s.nav.id, revision: s.nav.revision });
      await sleep(1200);
    }
  };
  /** 退出对局、离开大厅、离开小镇、关上下文。出错也不抛（收尾用）。 */
  const close = async () => {
    if (st.closed) return;
    try {
      const m = await me();
      if (m?.game) await act({ type: 'quit_game' });
      else await act({ type: 'leave_game_lobby' });
    } catch {
      /* 收尾 */
    }
    st.closed = true;
    clearInterval(st.hb);
    try {
      await post('/leave', { clientId });
    } catch {
      /* 收尾 */
    }
    await ctx.close().catch(() => {});
  };
  return { ctx, clientId, st, get id() { return st.id; }, get name() { return st.name; }, post, get, me, act, scene, selfOf, walk, close };
}

/** 一个 API 居民在对局里自动猜（取中点），直到不再在局里或被叫停。stop() 返回一个等它结束的 promise。 */
export function autoPlay(c, { delayMs = 300 } = {}) {
  const run = { stop: false, guesses: 0, errors: [] };
  run.done = (async () => {
    while (!run.stop) {
      try {
        const m = await c.me();
        const g = m?.game;
        if (!g) break;
        if (g.your_turn && g.phase_id !== null) {
          const rg = g.public?.range;
          const number = Math.floor((rg.from + rg.to) / 2);
          const r = await c.act({ type: 'game_act', gameId: g.game_id, phaseId: g.phase_id, input: { action: 'guess', number } });
          if (r.status === 200) run.guesses++;
          else run.errors.push({ status: r.status, reason: r.body?.reason ?? r.body?.error ?? null });
        }
      } catch (e) {
        run.errors.push({ exception: String(e) });
      }
      await sleep(delayMs);
    }
  })();
  return run;
}

export { poll };
