// 全镇公屏与头顶气泡的端到端小工具。依赖 playwright 的 page / ctx 与 lib/ui.mjs、lib/chat.mjs，不依赖 client-e2e.mjs。
import { poll, openDock, dockState, modState, godotFeature } from './ui.mjs';
import { apiAct } from './chat.mjs';

export const TOWN = '#dock [data-pane="town"]';
const originOf = (p) => new URL(p.page.url()).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 全镇列表里的消息行：{mid, from, text, mine, cls（classList）, chip（小牌文字）, goPlace（go 按钮的 data-place）, hasGo}。 */
export const townRows = (page) =>
  page.evaluate((root) => {
    const out = [];
    for (const li of document.querySelectorAll(`${root} li[data-mid]`)) {
      const go = li.querySelector('button.go');
      out.push({
        mid: Number(li.dataset.mid),
        from: li.dataset.from,
        text: li.querySelector('[data-role="text"]')?.textContent ?? '',
        mine: li.classList.contains('mine'),
        cls: [...li.classList],
        chip: li.querySelector('.chip')?.textContent ?? '',
        goPlace: go ? go.dataset.place : null,
        hasGo: !!go,
        hasImg: !!li.querySelector('[data-role="text"] *, img, script, iframe, svg'),
      });
    }
    return out;
  }, TOWN);

/** 打开面板并切到「全镇」页签。 */
export async function openTown(page) {
  await openDock(page);
  const sel = await page.getAttribute('#dock [data-tab="town"]', 'aria-selected');
  if (sel !== 'true') {
    // 手机抽屉里 #dockGrip（把手，高 44px、盖住整条页签）会拦截对页签的点击：Playwright 的真实点击会一直等到超时。
    // 这是 C1a 骨架（dock.css）的问题，C1b 不改它；这里在抽屉布局下直接给页签派发 click，并在汇报里单列。
    if ((await dockState(page))?.layout === 'drawer') await page.dispatchEvent('#dock [data-tab="town"]', 'click');
    else await page.click('#dock [data-tab="town"]');
  }
  await poll(async () => (await page.getAttribute('#dock [data-tab="town"]', 'aria-selected')) === 'true' && (await dockState(page))?.tab === 'town', 5000, '「全镇」页签被选中');
}

/** 页签顺序（data-tab）。 */
export const tabOrder = (page) => page.evaluate(() => [...document.querySelectorAll('#dockTabs [data-tab]')].map((e) => e.dataset.tab));

/** 未读：各模块自己的未读、它们的和、启动按钮角标、「全镇」页签的小点。 */
export const townUnread = (page) =>
  page.evaluate(() => {
    const d = window.__dock ?? {};
    const mods = (d._dock?.mods ?? []).filter((id) => typeof d[id]?.unread === 'number');
    const per = Object.fromEntries(mods.map((id) => [id, d[id].unread]));
    const sum = mods.reduce((s, id) => s + d[id].unread, 0);
    const b = document.querySelector('#dockBtn .dock-badge');
    const dot = document.querySelector('#dock [data-tab="town"] .tab-dot');
    return { town: d.town?.unread ?? null, per, sum, badge: b && !b.hidden ? b.textContent : '', badgeHidden: !b || b.hidden, dot: !!dot && !dot.hidden, label: document.getElementById('dockBtn').getAttribute('aria-label') };
  });

/** 启动按钮角标与各模块未读之和一致（和为 0 时隐藏；超过 9 显示的是「9+」之类，只要求可见）。不写死总数：别的页签并入后也成立。 */
export const badgeOk = (u) => (u.sum === 0 ? u.badgeHidden : !u.badgeHidden && (u.badge === String(u.sum) || u.sum > 9));

/** 输入栏现状（全镇页签）。 */
export const townCompose = (page) =>
  page.evaluate((root) => {
    const q = (r) => document.querySelector(`${root} [data-role="${r}"]`);
    const sel = q('placeSel');
    const checked = document.querySelector(`${root} [data-kind][aria-checked="true"]`);
    return {
      value: q('input').value, disabled: q('input').disabled, placeholder: q('input').placeholder, sendDisabled: q('send').disabled, hint: q('hint').textContent, hintClass: q('hint').className,
      count: q('count').textContent, focused: document.activeElement === q('input'), kind: checked?.dataset.kind ?? null, placeHidden: sel.hidden, place: sel.value,
    };
  }, TOWN);

/** 文字库里的一句。 */
export const townBank = (page, key) => page.evaluate(([root, k]) => document.querySelector(`${root} [data-bank] [data-t="${k}"]`)?.textContent ?? null, [TOWN, key]);

/** 范围牌、静音开关、读取状态条的现状。 */
export const townChrome = (page) =>
  page.evaluate((root) => {
    const q = (r) => document.querySelector(`${root} [data-role="${r}"]`);
    const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
    return {
      scope: q('scopeText').textContent, muted: q('mute').getAttribute('aria-pressed') === 'true', muteText: q('muteText').textContent,
      strip: vis(q('strip')), stripText: q('stripText').textContent, older: vis(q('older')), olderDisabled: q('older').disabled, olderText: q('older').textContent,
      rules: vis(q('rules')), kinds: vis(q('kinds')), pick: vis(q('pick')), jump: vis(q('jump')),
    };
  }, TOWN);

// ───────────────────────── 额度（全镇公屏：突发 2，每 10 秒回 1 条） ─────────────────────────
// 额度按居民算，网页和 API 共用一份。这里记下本脚本发成功的每一条，按令牌桶推算现在有没有额度；
// 等的是服务端的限流，不是糊弄时序。断言被限流的那一步（30.5）不走这里。
const BURST = 2;
const REFILL_MS = 10_000;
const sent = new Map(); // 居民编号 -> 成功发出的时刻

export function noteTownSent(p) {
  const l = sent.get(p.id) ?? [];
  l.push(Date.now());
  sent.set(p.id, l);
}
export function townTokens(p, now = Date.now()) {
  const l = sent.get(p.id) ?? [];
  if (!l.length) return BURST;
  let tokens = BURST;
  let last = l[0];
  for (const ts of l) {
    tokens = Math.min(BURST, tokens + (ts - last) / REFILL_MS);
    tokens -= 1;
    last = ts;
  }
  return Math.min(BURST, tokens + (now - last) / REFILL_MS);
}
export async function awaitTownToken(p) {
  for (;;) {
    const t = townTokens(p);
    if (t >= 1.05) return;
    await sleep(Math.min(2000, Math.ceil((1.05 - t) * REFILL_MS) + 50));
  }
}

/**
 * 用界面发一条公屏：（等额度）、打开「全镇」、选类型与地点、填字、按 Enter，等 Godot 一侧 lastAck.n 对上；返回 ack。
 * 先等 350 毫秒：聊天组件规定两次发送至少间隔 300 毫秒。noBudget=true 时不等额度（测被拒绝的情形）。
 */
export async function uiTownSay(p, text, { kind = 'chat', place = '', noBudget = false, timeoutMs = 25_000 } = {}) {
  if (!noBudget) await awaitTownToken(p);
  await openTown(p.page);
  await sleep(350);
  const n = ((await modState(p.page, 'town'))?.seq ?? 0) + 1;
  if (kind !== 'chat') {
    await p.page.click(`${TOWN} [data-kind="${kind}"]`);
    if (place) await p.page.selectOption(`${TOWN} [data-role="placeSel"]`, place);
  }
  await p.page.fill(`${TOWN} [data-role="input"]`, text);
  await p.page.press(`${TOWN} [data-role="input"]`, 'Enter');
  const ack = await poll(async () => {
    const f = await godotFeature(p.page, 'town');
    return f?.lastAck?.n === n ? f.lastAck : null;
  }, timeoutMs, `${p.label} 公屏发「${text.slice(0, 12)}」得到回应`);
  if (ack.ok) noteTownSent(p);
  return ack;
}

/** 走 API 发一条公屏（用该页面自己的身份）。返回 {status, body}。 */
export async function apiTownSay(p, text, { kind, place } = {}) {
  const action = { type: 'say_town', text };
  if (kind) action.kind = kind;
  if (place) action.place = place;
  const r = await apiAct(p, action);
  if (r.status === 200) noteTownSent(p);
  return r;
}

/** 同上，遇到 429 按 retryAfterMs 等一等再试（最多 8 次）；先按推算的额度等。API 代发的 4xx 页面监视看不到，不用声明。 */
export async function apiTownSayWait(p, text, opts = {}) {
  await awaitTownToken(p);
  for (let i = 0; i < 8; i++) {
    const r = await apiTownSay(p, text, opts);
    if (r.status !== 429) return r;
    await sleep(Math.min(12_000, (r.body?.retryAfterMs ?? r.body?.data?.retryAfterMs ?? 1000) + 200));
  }
  throw new Error(`apiTownSayWait：连续 8 次限流，仍发不出去：${text.slice(0, 20)}`);
}

/** 服务端真相：GET /town/api/town-chat?{qs}（用该页面的身份）。返回响应体（messages 旧的在前）。 */
export async function apiTownPage(p, qs = '') {
  const r = await p.ctx.request.get(`${originOf(p)}/town/api/town-chat${qs ? `?${qs}` : ''}`);
  return { status: r.status(), ...(await r.json().catch(() => ({}))) };
}

/** 气泡：#tags 里的 .tag.b（id 去掉 b: 前缀）与同 id 的名牌（.tag[data-id=<id>]）的外框。 */
export const bubbles = (page) =>
  page.evaluate(() => {
    const out = [];
    const rect = (e) => (e ? e.getBoundingClientRect().toJSON() : null);
    for (const el of document.querySelectorAll('#tags .tag.b')) {
      const raw = el.getAttribute('data-id') || '';
      const id = raw.replace(/^b:/, '');
      const nameEl = [...document.querySelectorAll('#tags .tag')].find((e) => e.getAttribute('data-id') === id);
      out.push({ id, text: el.textContent, cls: [...el.classList], children: el.children.length, rect: rect(el), nameRect: rect(nameEl), vw: window.innerWidth, vh: window.innerHeight });
    }
    return out;
  });

/** Godot 一侧气泡的现状（features.bubbles）。 */
export const bubbleFeature = (page) => godotFeature(page, 'bubbles');

/** 给 Godot 的 town 功能发一个 ui 事件（debug 口、静音等），和 host.emit 同一条路。 */
export const emitTown = (page, name, arg = '') => page.evaluate(([n, a]) => window.TownHost.emit('ui', `town.${n}`, a), [name, arg]);
