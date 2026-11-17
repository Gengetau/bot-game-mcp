// 入口：外壳、导航、顶栏、横幅、秒表。具体面板在各自的模块里。
import { clockOf, closeAllSheets, fill, h, hourMinute, icon, leftText } from './dom.js';
import { createGameScreen, openGameResult } from './game.js';
import { createHere } from './here.js';
import { createLanding, weatherIcon } from './landing.js';
import { createMailbox } from './mailbox.js';
import { createMap } from './map.js';
import { createPeople } from './people.js';
import { createSelf } from './self.js';
import { openPlace, openRecap } from './sheets.js';
import { boot, claim, serverNow, state, subscribe } from './store.js';
import { applyTheme, cycleTheme, getTheme, themeName } from './theme.js';
import { btn, chip, section } from './ui.js';

applyTheme();

const root = /** @type {HTMLElement} */ (document.getElementById('app'));
const wide = window.matchMedia('(min-width: 960px)');
const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

/** 当前标签：map / here / me / mail / people（对局中 here 位置换成对局） */
let tab = 'here';

/** @type {ReturnType<typeof createLanding> | null} */
let landing = null;
/** @type {ReturnType<typeof createShell> | null} */
let shell = null;

// ───────────────────────── 城镇外壳 ─────────────────────────

function createShell() {
  const map = createMap({ onPlace: (id) => openPlace(id) });
  const here = createHere();
  const me = createSelf();
  const mail = createMailbox();
  const people = createPeople();
  const game = createGameScreen();

  const clock = h('b', { class: 'clock' }, '');
  const clockDate = h('span', { class: 'clock-date' }, '');
  const weatherSlot = h('span', { class: 'weather-slot' });
  const coins = h('span', { class: 'coin-chip', title: '可用硬币' });
  const connDot = h('span', { class: 'conn' });
  const stateChip = h('span', { class: 'state-chip', hidden: true });
  const themeBtn = h('button', { type: 'button', class: 'icon-btn', onclick: () => {
    const next = cycleTheme();
    themeBtn.title = `外观：${themeName(next)}`;
    themeBtn.setAttribute('aria-label', `外观：${themeName(next)}（点击切换）`);
  } }, icon('theme', 20));
  themeBtn.title = `外观：${themeName(getTheme())}`;
  themeBtn.setAttribute('aria-label', `外观：${themeName(getTheme())}（点击切换）`);

  const topbar = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand compact' }, h('span', { class: 'brand-mark' }, icon('lantern', 22)), h('h1', null, '栖灯镇')),
    h('div', { class: 'top-info' }, h('span', { class: 'clock-chip', title: '小镇时间' }, icon('clock', 15), clock, clockDate), weatherSlot, coins, stateChip),
    h('div', { class: 'top-r' }, connDot, themeBtn),
  );
  const banners = h('div', { class: 'banners', role: 'status', 'aria-live': 'polite' });

  const tabs = [
    ['map', '小镇', 'map'],
    ['here', '现场', 'chat'],
    ['me', '我', 'user'],
    ['mail', '信箱', 'mail'],
    ['people', '居民', 'people'],
  ];
  const tabBtns = new Map();
  const nav = h('nav', { class: 'tabbar', 'aria-label': '主导航' });
  for (const [id, label, ic] of tabs) {
    const b = h('button', { type: 'button', class: 'tab', dataset: { tab: id }, onclick: () => setTab(/** @type {string} */ (id)) }, h('span', { class: 'tab-ic' }, icon(/** @type {string} */ (ic), 22), h('i', { class: 'tab-badge', hidden: true })), h('span', { class: 'tab-label' }, label));
    tabBtns.set(id, b);
    nav.appendChild(b);
  }

  // 地图栏：地图 + 此刻
  const brief = h('div', { class: 'brief' });
  const mapPane = h('main', { class: 'pane-map', 'aria-label': '小镇地图' }, h('div', { class: 'map-card' }, map.el), brief);

  const panes = { here: here.el, game: game.el, me: me.el, mail: mail.el, people: people.el };
  const mainPane = h('main', { class: 'pane-main', 'aria-label': '内容' }, ...Object.values(panes));
  const el = h('div', { class: 'town-shell' }, topbar, banners, nav, mapPane, mainPane);

  return { el, map, here, me, mail, people, game, clock, clockDate, weatherSlot, coins, connDot, stateChip, banners, tabBtns, brief, panes, mapPane, mainPane };
}

/** @param {string} t */
function setTab(t) {
  tab = t;
  if (t === 'mail') shell?.mail.activate();
  if (t === 'people') shell?.people.activate();
  renderTown();
  // 切页后把焦点交给页面顶部，键盘用户不会迷路
  if (shell) {
    const target = t === 'map' ? shell.mapPane : shell.panes[effectivePane(t)];
    target?.setAttribute('tabindex', '-1');
    /** @type {HTMLElement | null} */ (target)?.focus({ preventScroll: true });
  }
}

/** @param {string} t */
function effectivePane(t) {
  const inGame = Boolean(state.me?.game);
  if (t === 'map') return wide.matches ? (inGame ? 'game' : 'here') : inGame ? 'game' : 'here';
  if (t === 'here') return inGame ? 'game' : 'here';
  return /** @type {'me' | 'mail' | 'people'} */ (t);
}

// ───────────────────────── 渲染 ─────────────────────────

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const phase = state.phase;
  if (phase === 'boot') return;
  if (phase === 'town') {
    landing = null;
    renderTown();
  } else {
    shell?.mail.destroy();
    shell = null;
    renderLanding();
  }
}

function renderLanding() {
  if (!landing) {
    landing = createLanding();
    root.replaceChildren(landing.el);
    root.dataset.mode = 'landing';
    document.title = '栖灯镇';
  }
  landing.update();
}

let wasGame = false;
let recapShown = false;

function renderTown() {
  const me = state.me;
  if (!me) return;
  if (!shell) {
    shell = createShell();
    root.replaceChildren(shell.el);
    root.dataset.mode = 'town';
    tab = 'here';
    wasGame = false;
    recapShown = false;
  }
  const sh = shell;
  const inGame = Boolean(me.game);
  // 进入或离开对局：自动切到对应页
  if (inGame && !wasGame) {
    tab = 'here';
    closeAllSheets();
  }
  if (!inGame && wasGame) {
    tab = 'here';
    if (state.lastGameEnd) {
      const end = state.lastGameEnd;
      state.lastGameEnd = null;
      openGameResult(end);
    }
  }
  wasGame = inGame;
  root.dataset.game = inGame ? '1' : '0';
  root.dataset.tab = tab;
  root.dataset.moving = me.location.navigation ? '1' : '0';

  const hm = hourMinute(serverNow(), tz());
  const pub = state.pub;
  if (pub) sh.map.update({ pub, me, now: serverNow(), hour: hm.h + hm.m / 60 });

  // 顶栏
  sh.clock.textContent = clockOf(serverNow(), tz());
  sh.clockDate.textContent = me.world.date.slice(5).replace('-', '月') + '日';
  const w = pub?.world.weather ?? me.world.weather;
  sh.weatherSlot.replaceChildren(icon(weatherIcon(w.id), 16), h('span', null, w.name));
  sh.weatherSlot.className = 'weather-slot';
  sh.coins.replaceChildren(icon('coin', 15), h('b', null, String(me.inventory.coins.available)), h('span', { class: 'sr' }, ' 枚硬币'));
  sh.connDot.className = `conn ${state.conn}`;
  sh.connDot.title = state.conn === 'ok' ? '已连接' : state.conn === 'connecting' ? '正在重新连接' : '连接断开';
  sh.connDot.setAttribute('role', 'img');
  sh.connDot.setAttribute('aria-label', sh.connDot.title);
  sh.stateChip.hidden = !(me.location.navigation || inGame);
  sh.stateChip.textContent = inGame ? '对局中' : '在路上';
  sh.stateChip.className = `state-chip ${inGame ? 'game' : 'walk'}`;

  // 横幅
  const bk = JSON.stringify([state.readOnly, state.taken, state.recovering, state.conn]);
  if (sh.banners.dataset.memo !== bk) {
    sh.banners.dataset.memo = bk;
    sh.banners.replaceChildren();
    if (state.readOnly) {
      sh.banners.appendChild(
        h(
          'div',
          { class: 'banner warn' },
          icon('lock', 18),
          h('div', { class: 'banner-text' }, h('b', null, state.taken ? '控制权被另一个页面接管了' : '这个页面现在只能看'), h('span', null, '同一位居民同一时刻只有一个页面能操作。接管之后，另一个页面会变成只读。')),
          btn('接管', () => claim(), { variant: 'primary', small: true, always: true }),
        ),
      );
    }
    if (state.recovering) sh.banners.appendChild(h('div', { class: 'banner info' }, icon('refresh', 18), h('div', { class: 'banner-text' }, h('b', null, '小镇正在恢复'), h('span', null, '暂时不能保存变化，动作会自动重试，已经提交的不会重复。'))));
    if (state.conn !== 'ok') sh.banners.appendChild(h('div', { class: 'banner info' }, icon('wifi', 18), h('div', { class: 'banner-text' }, h('b', null, state.conn === 'offline' ? '连接断开了，正在重连' : '正在重新连接'), h('span', null, '重连之后会以服务器最新的状态为准，没有确认的动作不会被自动重发。'))));
  }

  // 标签
  const pane = effectivePane(tab);
  sh.tabBtns.forEach((b, id) => {
    const isGameTab = id === 'here' && inGame;
    const active = wide.matches ? (tab === 'map' ? id === 'here' : id === tab) : id === tab;
    b.classList.toggle('on', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    const label = b.querySelector('.tab-label');
    if (label) label.textContent = id === 'here' ? (inGame ? '对局' : '现场') : ({ map: '小镇', me: '我', mail: '信箱', people: '居民' }[/** @type {'map'} */ (id)] ?? '');
    const ic = b.querySelector('.tab-ic svg');
    if (id === 'here' && ic) b.querySelector('.tab-ic')?.replaceChild(icon(isGameTab ? 'dice' : 'chat', 22), ic);
    const badge = /** @type {HTMLElement | null} */ (b.querySelector('.tab-badge'));
    if (badge) {
      let n = 0;
      if (id === 'mail') n = me.mail.unread;
      if (id === 'here') n = inGame ? (me.game?.todo ? 1 : 0) : me.offers.filter((o) => o.to.id === me.me.id).length;
      badge.hidden = n === 0;
      badge.textContent = n > 9 ? '9+' : n === 1 && id === 'here' && inGame ? '!' : String(n);
    }
  });
  for (const [id, el] of Object.entries(sh.panes)) el.hidden = id !== pane;
  sh.mapPane.hidden = !wide.matches && tab !== 'map';
  // 手机的「小镇」页只有地图和此刻，现场面板不进来
  sh.mainPane.hidden = !wide.matches && tab === 'map';
  sh.mapPane.classList.toggle('dim', false);

  // 面板
  sh.here.update();
  sh.me.update();
  sh.mail.update();
  sh.people.update();
  if (inGame) sh.game.update();

  // 地图栏下方：此刻
  const hk = JSON.stringify([pub?.events, pub?.places.map((p) => [p.id, p.residents.length, p.activities.length]), me.suggestions, me.location.space, me.location.navigation?.to.name, tab]);
  if (sh.brief.dataset.memo !== hk && pub) {
    sh.brief.dataset.memo = hk;
    fill(sh.brief,
      me.location.navigation ? h('div', { class: 'where' }, icon('walk', 16), h('b', null, `正在走向${me.location.navigation.to.name}`), h('span', { class: 'hint' }, `现在在${me.location.name}`)) : h('div', { class: 'where' }, icon('walk', 16), h('b', null, me.location.name), h('span', { class: 'hint' }, '点地图上的地点可以前往')),
      pub.events.length ? section('今天的公共事件', h('div', { class: 'stack' }, pub.events.map((e) => h('div', { class: `ev ${e.status}` }, h('div', { class: 'ev-top' }, h('b', null, e.title), chip(e.status === 'open' ? '进行中' : e.status === 'scheduled' ? '待开始' : e.status === 'missed' ? '错过了' : '已结束', e.status === 'open' ? 'moss' : 'dim')), h('p', { class: 'hint' }, `${pub.places.find((p) => p.id === e.place)?.name ?? ''} · ${clockOf(e.opensAt, tz())}~${clockOf(e.closesAt, tz())}${e.target ? ` · 共同进度 ${e.progress ?? 0}/${e.target}` : ''}`))))) : null,
      me.suggestions.length ? section('小建议', h('ul', { class: 'bullets' }, me.suggestions.map((t) => h('li', null, t)))) : null,
      h('details', { class: 'place-list' }, h('summary', null, '地点一览（也可以用键盘 Tab 在地图上选）'), h('div', { class: 'stack' }, pub.places.filter((p) => !p.through).map((p) => h('button', { type: 'button', class: 'row clickable', onclick: () => openPlace(p.id) }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, p.name), h('div', { class: 'row-sub' }, `${p.residents.length} 人在场${p.activities.length ? ` · ${p.activities.length} 桌游` : ''}`)), h('div', { class: 'row-aside' }, icon('chevron', 16)))), h('button', { type: 'button', class: 'row clickable', onclick: () => openPlace('residential') }, h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, '住宅区'), h('div', { class: 'row-sub' }, `${pub.residential.residents.length} 人在住宅区`)), h('div', { class: 'row-aside' }, icon('chevron', 16))))),
    );
  }

  // 回顾
  if (state.recap && !recapShown) {
    recapShown = true;
    openRecap();
  }
  document.title = `${me.mail.unread ? `(${me.mail.unread}) ` : ''}栖灯镇`;
}

// ───────────────────────── 秒表 ─────────────────────────

/** 一秒一次：时钟、倒计时、行程条、局内计时。 */
function tickSecond() {
  const now = serverNow();
  if (shell && state.me) {
    shell.clock.textContent = clockOf(now, tz());
  }
  for (const e of document.querySelectorAll('.cd')) {
    const until = Number(/** @type {HTMLElement} */ (e).dataset.until);
    const prefix = /** @type {HTMLElement} */ (e).dataset.prefix ?? '';
    e.textContent = until - now <= 0 ? '已到时' : `${prefix}${leftText(until - now)}`;
  }
  for (const e of document.querySelectorAll('.travel')) {
    const t0 = Number(/** @type {HTMLElement} */ (e).dataset.t0);
    const t1 = Number(/** @type {HTMLElement} */ (e).dataset.t1);
    const p = Math.max(0, Math.min(1, (now - t0) / Math.max(1, t1 - t0)));
    const bar = /** @type {HTMLElement | null} */ (e.querySelector('.travel-bar i'));
    if (bar) bar.style.width = `${(p * 100).toFixed(1)}%`;
    const txt = e.querySelector('.travel-text');
    if (txt) txt.textContent = t1 - now > 0 ? `还有约 ${Math.max(1, Math.ceil((t1 - now) / 1000))} 秒到达` : '就要到了……';
  }
  for (const e of document.querySelectorAll('.timer[data-lu]')) {
    const el = /** @type {HTMLElement} */ (e);
    const left = Math.max(0, Math.ceil((Number(el.dataset.lu) - Date.now()) / 1000));
    const n = el.querySelector('.timer-n');
    if (n) n.textContent = String(left);
    const total = Number(el.dataset.total) || 1;
    const bar = /** @type {HTMLElement | null} */ (el.querySelector('.timer-bar i'));
    if (bar) bar.style.width = `${Math.min(100, (left / total) * 100).toFixed(1)}%`;
    el.classList.toggle('low', left <= 10);
    if (left === 0 && !el.dataset.fired) {
      el.dataset.fired = '1';
      setTimeout(() => import('./store.js').then((m) => m.scheduleRefreshMe(0)), 1500);
    }
  }
  if (state.phase === 'town' && state.me && Date.now() % 30 < 2) scheduleRender();
}

setInterval(tickSecond, 1000);
setInterval(() => {
  const m = shell?.map ?? landing?.map;
  if (m && m.hasMovers()) m.tick(serverNow());
}, 400);
setInterval(() => {
  // 昼夜色调随世界时间缓慢变化
  if (state.phase !== 'boot') scheduleRender();
}, 30000);

wide.addEventListener('change', scheduleRender);

subscribe((topic) => {
  if (topic === 'tick') return;
  if (topic === 'chat') {
    shell?.here.update();
    return;
  }
  scheduleRender();
});

window.addEventListener('keydown', (e) => {
  // 数字键 1~5 切换标签（不在输入框里时）
  if (state.phase !== 'town' || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.matches('input, textarea, select, [contenteditable]') || document.querySelector('.sheet-root')) return;
  const idx = Number(e.key) - 1;
  const ids = ['map', 'here', 'me', 'mail', 'people'];
  if (idx >= 0 && idx < 5) setTab(/** @type {string} */ (ids[idx]));
});

root.replaceChildren(h('div', { class: 'splash' }, h('span', { class: 'brand-mark big' }, icon('lantern', 40)), h('p', null, '正在点灯……')));
boot().catch(console.error).then(scheduleRender);
