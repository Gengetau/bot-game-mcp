// @ts-check
/**
 * 东京都（/city/play/）人类文字优先单页客户端。
 *
 * 遵循原则：
 *  - 零外部依赖，离线/内网环境直接可用；
 *  - 所有动态文本严格经 textContent / createElement 渲染，零 innerHTML 拼接；
 *  - 全部写操作经 POST /city/api/act 进入引擎同一条 cityCommand() 规则管线，携带 HttpOnly Cookie + X-City-CSRF；
 *  - 多窗口默认不暗抢控制权（control.mine === false 进入只读旁观态），由用户显式点击接管；
 *  - 聊天输入框遵循 IME 安全回车提交规范（检查 event.isComposing || event.keyCode === 229）。
 */

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function mustEl(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function randomHex(bytes = 8) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** @returns {string} */
function getOrCreateClientId() {
  const key = 'city_client_id';
  try {
    const saved = sessionStorage.getItem(key);
    if (saved && /^[\w.-]{8,60}$/.test(saved)) return saved;
    const fresh = `tab_${randomHex(8)}`;
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `tab_${randomHex(8)}`;
  }
}

/** @returns {string} */
function newRequestId() {
  return `web_${Date.now().toString(36)}_${randomHex(5)}`;
}

/**
 * @param {number | undefined | null} ms
 * @param {string} tz
 * @returns {string}
 */
function fmtClock(ms, tz = 'Asia/Tokyo') {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmtYen(n) {
  return `¥${Number(n || 0).toLocaleString('ja-JP')}`;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {{ className?: string; text?: string; attrs?: Record<string, string> }} [opts]
 * @returns {HTMLElementTagNameMap[K]}
 */
function make(tag, opts = {}) {
  const el = document.createElement(tag);
  if (opts.className) el.className = opts.className;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  }
  return el;
}

const state = {
  clientId: getOrCreateClientId(),
  csrfToken: '',
  timezone: 'Asia/Tokyo',
  heartbeatMs: 60_000,
  chatMaxChars: 300,
  loggedIn: false,
  /** @type {{ display_name: string; kind: string } | null} */
  principal: null,
  /** @type {{ id: string; name: string; in_city: boolean } | null} */
  sessionResident: null,
  /** @type {Record<string, any> | null} */
  view: null,
  /** @type {Record<string, any> | null} */
  publicView: null,
  /** @type {number | null} */
  historyNext: null,
  itemOffset: 0,
  /** @type {number[]} */
  itemPageStack: [],
  lockerOffset: 0,
  /** @type {number[]} */
  lockerPageStack: [],
  /** @type {Map<string, Record<string, any>>} */
  inspectedItems: new Map(),
  /** @type {EventSource | null} */
  stream: null,
  /** @type {number | null} */
  heartbeatTimer: null,
  /** @type {number | null} */
  refreshTimer: null,
};

// ───────────────────────── DOM 引用 ─────────────────────────
const headerClock = mustEl('header-clock');
const headerUserBar = mustEl('header-user-bar');
const headerResidentBadge = mustEl('header-resident-badge');
const headerControlBadge = mustEl('header-control-badge');
const leaveCityBtn = /** @type {HTMLButtonElement} */ (mustEl('leave-city-btn'));
const logoutBtn = /** @type {HTMLButtonElement} */ (mustEl('logout-btn'));

const statusBanner = mustEl('status-banner');
const errorBanner = mustEl('error-banner');
const gateSection = mustEl('gate-section');
const loginCard = mustEl('login-card');
const enterCard = mustEl('enter-card');
const cityWorkspace = mustEl('city-workspace');
const controlBanner = mustEl('control-banner');
const claimControlBtn = /** @type {HTMLButtonElement} */ (mustEl('claim-control-btn'));
const transitBanner = mustEl('transit-banner');

const ticketForm = /** @type {HTMLFormElement} */ (mustEl('ticket-form'));
const ticketInput = /** @type {HTMLInputElement} */ (mustEl('ticket-input'));
const ticketError = mustEl('ticket-error');
const devForm = /** @type {HTMLFormElement} */ (mustEl('dev-form'));
const devNameInput = /** @type {HTMLInputElement} */ (mustEl('dev-name-input'));
const devNameError = mustEl('dev-name-error');

const enterForm = /** @type {HTMLFormElement} */ (mustEl('enter-form'));
const enterWelcomeText = mustEl('enter-welcome-text');
const enterNameField = mustEl('enter-name-field');
const enterNameInput = /** @type {HTMLInputElement} */ (mustEl('enter-name-input'));
const enterNameError = mustEl('enter-name-error');
const enterBioInput = /** @type {HTMLInputElement} */ (mustEl('enter-bio-input'));
const enterStationFieldset = /** @type {HTMLFieldSetElement} */ (mustEl('enter-station-fieldset'));
const enterSubmitBtn = /** @type {HTMLButtonElement} */ (mustEl('enter-submit-btn'));

const chatForm = /** @type {HTMLFormElement} */ (mustEl('chat-form'));
const chatInput = /** @type {HTMLTextAreaElement} */ (mustEl('chat-input'));
const chatError = mustEl('chat-error');
const chatSubmitBtn = /** @type {HTMLButtonElement} */ (mustEl('chat-submit-btn'));

const profileForm = /** @type {HTMLFormElement} */ (mustEl('profile-form'));
const profileNameInput = /** @type {HTMLInputElement} */ (mustEl('profile-name-input'));
const profileBioInput = /** @type {HTMLInputElement} */ (mustEl('profile-bio-input'));
const profileError = mustEl('profile-error');
const profileSubmitBtn = /** @type {HTMLButtonElement} */ (mustEl('profile-submit-btn'));

const refreshHistoryBtn = /** @type {HTMLButtonElement} */ (mustEl('refresh-history-btn'));
const moreHistoryBtn = /** @type {HTMLButtonElement} */ (mustEl('more-history-btn'));

const bagPager = mustEl('bag-pager');
const bagPageStatus = mustEl('bag-page-status');
const bagPrevBtn = /** @type {HTMLButtonElement} */ (mustEl('bag-prev-btn'));
const bagNextBtn = /** @type {HTMLButtonElement} */ (mustEl('bag-next-btn'));

const lockerPager = mustEl('locker-pager');
const lockerPageStatus = mustEl('locker-page-status');
const lockerPrevBtn = /** @type {HTMLButtonElement} */ (mustEl('locker-prev-btn'));
const lockerNextBtn = /** @type {HTMLButtonElement} */ (mustEl('locker-next-btn'));

// ───────────────────────── 通知与错误 ─────────────────────────

/**
 * @param {string} msg
 */
function showNotice(msg) {
  if (!msg) {
    statusBanner.hidden = true;
    statusBanner.textContent = '';
    return;
  }
  statusBanner.textContent = msg;
  statusBanner.hidden = false;
}

/**
 * @param {string} msg
 */
function showError(msg) {
  if (!msg) {
    errorBanner.hidden = true;
    errorBanner.textContent = '';
    return;
  }
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

/**
 * @param {HTMLElement} errEl
 * @param {HTMLInputElement | HTMLTextAreaElement} inputEl
 * @param {string} msg
 */
function setFieldError(errEl, inputEl, msg) {
  if (!msg) {
    errEl.hidden = true;
    errEl.textContent = '';
    inputEl.removeAttribute('aria-invalid');
  } else {
    errEl.textContent = msg;
    errEl.hidden = false;
    inputEl.setAttribute('aria-invalid', 'true');
  }
}

// ───────────────────────── HTTP 客户端 ─────────────────────────

class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {string | undefined} reason
   * @param {Record<string, any>} body
   */
  constructor(status, code, message, reason, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.body = body;
  }
}

/**
 * @param {string} method
 * @param {string} path
 * @param {Record<string, unknown>} [body]
 * @param {boolean} [retriedCsrf]
 * @returns {Promise<Record<string, any>>}
 */
async function apiCall(method, path, body, retriedCsrf = false) {
  /** @type {Record<string, string>} */
  const headers = {
    'X-City-Client': state.clientId,
  };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (state.csrfToken) headers['X-City-CSRF'] = state.csrfToken;
  }
  const res = await fetch(`/city/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  /** @type {Record<string, any>} */
  let data = {};
  try {
    data = /** @type {Record<string, any>} */ (await res.json());
  } catch {
    /* non-JSON fallback */
  }
  if (!res.ok) {
    if (res.status === 403 && data.reason === 'csrf_invalid' && !retriedCsrf) {
      await syncSession();
      return apiCall(method, path, body, true);
    }
    if (res.status === 409 && data.error === 'CONTROL_LOST') {
      if (state.view && data.control) {
        state.view.control = data.control;
        renderWorkspace();
      }
    }
    throw new ApiError(res.status, String(data.error || 'ERROR'), String(data.message || '请求失败'), data.reason, data);
  }
  return data;
}

// ───────────────────────── 标签页无障碍控制 ─────────────────────────

const tabButtons = /** @type {HTMLButtonElement[]} */ (Array.from(document.querySelectorAll('.tablist [role="tab"]')));
const tabPanels = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll('[role="tabpanel"]')));

/**
 * @param {string} tabId
 * @param {boolean} [moveFocus]
 */
function activateTab(tabId, moveFocus = false) {
  for (const btn of tabButtons) {
    const selected = btn.id === tabId;
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    btn.tabIndex = selected ? 0 : -1;
    if (selected && moveFocus) btn.focus();
  }
  for (const panel of tabPanels) {
    const owner = panel.getAttribute('aria-labelledby');
    if (owner === tabId) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', 'until-found');
    }
  }
  if (tabId === 'tab-overview') void loadPublicOverview();
  if (tabId === 'tab-social' && state.historyNext === null) void loadHistory(true);
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => activateTab(btn.id, false));
  btn.addEventListener('keydown', (ev) => {
    const idx = tabButtons.indexOf(btn);
    if (idx < 0) return;
    let nextIdx = -1;
    if (ev.key === 'ArrowRight') nextIdx = (idx + 1) % tabButtons.length;
    else if (ev.key === 'ArrowLeft') nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
    else if (ev.key === 'Home') nextIdx = 0;
    else if (ev.key === 'End') nextIdx = tabButtons.length - 1;
    if (nextIdx >= 0) {
      ev.preventDefault();
      const target = tabButtons[nextIdx];
      if (target) activateTab(target.id, true);
    }
  });
}

for (const panel of tabPanels) {
  panel.addEventListener('beforematch', () => {
    const owner = panel.getAttribute('aria-labelledby');
    if (owner) activateTab(owner, false);
  });
}

// ───────────────────────── 实时流与保活 ─────────────────────────

function stopRealtime() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  if (state.heartbeatTimer !== null) {
    window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.refreshTimer !== null) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function scheduleRefreshMe() {
  if (state.refreshTimer !== null) return;
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    void refreshMe();
  }, 150);
}

function startRealtime() {
  stopRealtime();
  if (!state.view || !state.view.me?.in_city) return;
  const cursor = encodeURIComponent(String(state.view.cursor || ''));
  const client = encodeURIComponent(state.clientId);
  const es = new EventSource(`/city/api/stream?client_id=${client}&cursor=${cursor}`);
  es.addEventListener('private', () => {
    scheduleRefreshMe();
  });
  es.addEventListener('public', () => {
    const overviewTab = document.getElementById('tab-overview');
    if (overviewTab?.getAttribute('aria-selected') === 'true') void loadPublicOverview();
  });
  es.addEventListener('resync', () => {
    scheduleRefreshMe();
  });
  es.addEventListener('revoked', () => {
    stopRealtime();
    state.loggedIn = false;
    state.csrfToken = '';
    state.view = null;
    state.sessionResident = null;
    renderApp();
    showNotice('登录会话已退出或失效，请重新使用票据登录。');
  });
  state.stream = es;

  state.heartbeatTimer = window.setInterval(async () => {
    if (!state.view?.me?.in_city) return;
    try {
      const hb = await apiCall('POST', '/heartbeat', { client_id: state.clientId });
      if (state.view && hb.control) {
        state.view.control = hb.control;
        renderHeaderAndControl();
      }
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'UNAUTHENTICATED' || e.reason === 'not_in_city')) {
        await syncSession();
        renderApp();
      }
    }
  }, state.heartbeatMs);
}

// ───────────────────────── 数据拉取与动作提交 ─────────────────────────

function resetInventoryPaging() {
  state.itemOffset = 0;
  state.itemPageStack = [];
  state.lockerOffset = 0;
  state.lockerPageStack = [];
  state.inspectedItems.clear();
}

/** @returns {string} */
function buildMePath() {
  const params = new URLSearchParams();
  params.set('client_id', state.clientId);
  if (state.itemOffset > 0) params.set('item_offset', String(state.itemOffset));
  if (state.lockerOffset > 0) params.set('locker_offset', String(state.lockerOffset));
  return `/me?${params.toString()}`;
}

/**
 * 当末页最后一件物品被取出/存入/消耗导致当前偏移页为空时，自动回退到有效上一页。
 * @param {Record<string, any>} v
 * @returns {boolean} 是否调整了页偏移需要重新拉取
 */
function reconcilePageOffsets(v) {
  let needsRefetch = false;
  const itemsPage = v.items_page;
  if (!itemsPage) {
    state.itemOffset = 0;
    state.itemPageStack = [];
  } else {
    if (typeof itemsPage.offset === 'number') state.itemOffset = itemsPage.offset;
    if (state.itemOffset > 0 && Array.isArray(v.items) && v.items.length === 0 && Number(itemsPage.total || 0) > 0) {
      state.itemOffset = state.itemPageStack.length > 0 ? (state.itemPageStack.pop() ?? 0) : 0;
      needsRefetch = true;
    }
  }
  const lockerPage = v.locker_page;
  if (!lockerPage) {
    state.lockerOffset = 0;
    state.lockerPageStack = [];
  } else {
    if (typeof lockerPage.offset === 'number') state.lockerOffset = lockerPage.offset;
    if (state.lockerOffset > 0 && Array.isArray(v.locker_items) && v.locker_items.length === 0 && Number(lockerPage.total || 0) > 0) {
      state.lockerOffset = state.lockerPageStack.length > 0 ? (state.lockerPageStack.pop() ?? 0) : 0;
      needsRefetch = true;
    }
  }
  return needsRefetch;
}

async function refreshMe() {
  try {
    let v = await apiCall('GET', buildMePath());
    if (reconcilePageOffsets(v)) {
      v = await apiCall('GET', buildMePath());
    }
    state.view = v;
    if (v.me) {
      state.sessionResident = { id: String(v.me.id), name: String(v.me.name), in_city: Boolean(v.me.in_city) };
    }
    renderApp();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') {
      await syncSession();
      renderApp();
    }
  }
}

/**
 * @param {Record<string, unknown>} action
 * @param {string} [successNote]
 * @returns {Promise<Record<string, any> | null>}
 */
async function submitCityAction(action, successNote) {
  showError('');
  try {
    const out = await apiCall('POST', '/act', {
      client_id: state.clientId,
      request_id: newRequestId(),
      action,
      ...(state.itemOffset > 0 ? { item_offset: state.itemOffset } : {}),
      ...(state.lockerOffset > 0 ? { locker_offset: state.lockerOffset } : {}),
    });
    if (typeof action.item_id === 'string') {
      state.inspectedItems.delete(action.item_id);
    }
    if (out.view) {
      if (reconcilePageOffsets(out.view)) {
        await refreshMe();
      } else {
        state.view = out.view;
        renderApp();
      }
    } else {
      await refreshMe();
    }
    if (successNote) showNotice(successNote);
    return out;
  } catch (e) {
    if (e instanceof ApiError) {
      showError(e.message);
    } else {
      showError('网络请求失败，请稍后重试。');
    }
    return null;
  }
}

async function loadPublicOverview() {
  try {
    state.publicView = await apiCall('GET', '/public');
    renderOverview();
  } catch {
    /* ignore transient overview failure */
  }
}

/**
 * @param {boolean} reset
 */
async function loadHistory(reset) {
  if (!state.loggedIn || !state.sessionResident) return;
  const beforeParam = !reset && state.historyNext ? `&before=${encodeURIComponent(String(state.historyNext))}` : '';
  try {
    const res = await apiCall('GET', `/history?limit=25${beforeParam}`);
    const list = mustEl('history-list');
    if (reset) list.replaceChildren();
    const msgs = Array.isArray(res.messages) ? res.messages : [];
    if (reset && msgs.length === 0) {
      list.appendChild(make('li', { className: 'muted small-note', text: '还没有听过的现场对话记录。' }));
    } else {
      for (const m of msgs) {
        const li = make('li', { className: 'chat-msg' });
        const head = make('div', { className: 'chat-msg-head' });
        head.appendChild(make('strong', { text: String(m.from?.name || '旅人') }));
        head.appendChild(make('span', { text: `${String(m.place || '')} · ${fmtClock(m.at_ms, state.timezone)}` }));
        li.appendChild(head);
        li.appendChild(make('div', { text: String(m.text || '') }));
        list.appendChild(li);
      }
    }
    state.historyNext = typeof res.next === 'number' ? res.next : null;
    moreHistoryBtn.hidden = state.historyNext === null;
  } catch (e) {
    if (e instanceof ApiError) showError(e.message);
  }
}

// ───────────────────────── 界面渲染（纯 DOM 构建） ─────────────────────────

function canControl() {
  return Boolean(state.view?.me?.in_city && state.view?.control?.mine);
}

function renderHeaderAndControl() {
  const v = state.view;
  if (v?.local_time) {
    headerClock.textContent = `东京时间 ${v.local_time}（${state.timezone}）`;
  } else if (state.publicView?.local_time) {
    headerClock.textContent = `东京时间 ${state.publicView.local_time}（${state.timezone}）`;
  } else {
    headerClock.textContent = `东京都持续世界（${state.timezone}）`;
  }

  headerUserBar.hidden = !state.loggedIn;
  if (!state.loggedIn) return;

  if (v?.me) {
    headerResidentBadge.textContent = `${v.me.name} · ${fmtYen(v.wallet?.spendable_yen ?? 0)}`;
    const mine = Boolean(v.control?.mine);
    headerControlBadge.textContent = mine ? `控制权 #${v.control?.epoch ?? 0}` : '只读旁观';
    headerControlBadge.className = `badge ${mine ? 'badge-ok' : 'badge-warn'}`;
    leaveCityBtn.hidden = !v.me.in_city;
    controlBanner.hidden = !v.me.in_city || mine;
  } else if (state.principal) {
    headerResidentBadge.textContent = state.principal.display_name;
    headerControlBadge.textContent = '待进城';
    headerControlBadge.className = 'badge';
    leaveCityBtn.hidden = true;
    controlBanner.hidden = true;
  }
}

function renderGate() {
  loginCard.hidden = state.loggedIn;
  enterCard.hidden = !state.loggedIn;
  if (!state.loggedIn) return;

  if (state.sessionResident) {
    enterWelcomeText.textContent = `欢迎回来，${state.sessionResident.name}。你的随身钱包、背包与车站储物柜都保持上次离开时的状态。`;
    enterNameField.hidden = true;
    enterNameInput.required = false;
    enterStationFieldset.hidden = true;
    enterSubmitBtn.textContent = '回到东京都';
  } else {
    enterWelcomeText.textContent = `你好，${state.principal?.display_name ?? '旅人'}。请起一个城内显示名并选择首次进城车站。`;
    enterNameField.hidden = false;
    enterNameInput.required = true;
    if (!enterNameInput.value && state.principal?.display_name) {
      enterNameInput.value = state.principal.display_name.slice(0, 16);
    }
    enterStationFieldset.hidden = false;
    enterSubmitBtn.textContent = '领取启动日元并进入东京都';
  }
}

function renderScenePanel() {
  const v = state.view;
  if (!v) return;
  const writable = canControl();
  const inTransit = Boolean(v.location?.in_transit && v.location?.trip);
  const here = v.here;

  const titleEl = mustEl('scene-place-title');
  const openBadge = mustEl('scene-open-badge');
  const blurbEl = mustEl('scene-blurb');
  const weatherEl = mustEl('scene-weather');
  const eventsBox = mustEl('scene-events');
  const peopleList = mustEl('scene-people-list');
  const shopCard = mustEl('scene-shop-card');
  const goodsList = mustEl('scene-goods-list');
  const chatList = mustEl('chat-list');

  if (inTransit) {
    const trip = v.location.trip;
    transitBanner.hidden = false;
    transitBanner.textContent = `正在前往 ${trip.to}（预计 ${fmtClock(trip.ends_at_ms, state.timezone)} 到达，共 ${trip.minutes} 分钟，车费 ${fmtYen(trip.fare_yen)}）`;
    titleEl.textContent = '在途中';
    openBadge.textContent = '移动中';
    openBadge.className = 'badge badge-warn';
    blurbEl.textContent = '你正在步行或乘坐电车途中。到站后将自动刷新现场视图。';
    weatherEl.textContent = '移动期间暂不能与地点商品或储物柜交互。';
    eventsBox.hidden = true;
    peopleList.replaceChildren(make('li', { className: 'muted small-note', text: '到站后可见身边同行者。' }));
    shopCard.hidden = true;
    chatList.replaceChildren(make('li', { className: 'muted small-note', text: '移动途中无法现场交谈。' }));
    chatInput.disabled = true;
    chatSubmitBtn.disabled = true;
    return;
  }

  transitBanner.hidden = true;
  if (!here) return;

  const p = here.place || {};
  titleEl.textContent = String(p.name || p.id || '未知地点');
  openBadge.textContent = p.open ? `开放中 · ${p.hours || '全天'}` : `暂停开放（${p.hours || ''}）`;
  openBadge.className = `badge ${p.open ? 'badge-ok' : 'badge-warn'}`;
  blurbEl.textContent = `${p.blurb || ''}${p.rain_notice ? `（${p.rain_notice}）` : ''}`;

  const w = here.weather;
  if (w) {
    weatherEl.textContent = `天气：${w.text} · ${w.temp_c}°C${w.rain ? '（正在下雨）' : ''} · 来源：${w.source === 'open-meteo' ? 'Open-Meteo' : '合成天气'}`;
  } else {
    weatherEl.textContent = '天气快照加载中…';
  }

  const evs = Array.isArray(here.events) ? here.events : [];
  eventsBox.replaceChildren();
  if (evs.length > 0) {
    eventsBox.hidden = false;
    for (const ev of evs) {
      eventsBox.appendChild(make('p', { className: 'small-note', text: `今日街区动态：${ev.title} — ${ev.body}` }));
    }
  } else {
    eventsBox.hidden = true;
  }

  // 同行者列表与赠送操作
  peopleList.replaceChildren();
  const people = Array.isArray(here.people) ? here.people : [];
  const bagItems = Array.isArray(v.items) ? v.items : [];
  if (people.length === 0) {
    peopleList.appendChild(make('li', { className: 'muted small-note', text: '此刻这里只有你一个人。' }));
  } else {
    for (const person of people) {
      const li = make('li', { className: 'entity-item' });
      const meta = make('div', { className: 'entity-meta' });
      meta.appendChild(make('strong', { text: String(person.name || person.id) }));
      if (person.bio) meta.appendChild(make('span', { className: 'muted small-note', text: String(person.bio) }));
      li.appendChild(meta);

      if (writable && bagItems.length > 0) {
        const actRow = make('div', { className: 'entity-actions' });
        const sel = make('select', { attrs: { 'aria-label': `选择送给 ${person.name} 的物品` } });
        for (const it of bagItems) {
          const titleTag = it.meta?.title ? `《${it.meta.title}》` : '';
          const opt = make('option', {
            text: `${it.name}${titleTag}（×${it.qty}${it.instance ? '·具名' : ''}）`,
            attrs: { value: String(it.item_id) },
          });
          sel.appendChild(opt);
        }
        const giveBtn = make('button', { className: 'btn btn-secondary', text: '赠送 1 件', attrs: { type: 'button' } });
        giveBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'give', to: person.id, item_id: sel.value, qty: 1 }, `已将物品送给 ${person.name}。`);
        });
        actRow.appendChild(sel);
        actRow.appendChild(giveBtn);
        if (v.items_page && (v.items_page.offset > 0 || v.items_page.has_more)) {
          if (v.items_page.offset > 0) {
            const prevBag = make('button', {
              className: 'btn btn-ghost btn-compact',
              text: '上一页',
              attrs: { type: 'button', 'aria-label': `赠送物品列表上一页（给 ${person.name}）` },
            });
            prevBag.addEventListener('click', () => stepBagPage(-1));
            actRow.appendChild(prevBag);
          }
          if (v.items_page.has_more) {
            const nextBag = make('button', {
              className: 'btn btn-ghost btn-compact',
              text: '下一页',
              attrs: { type: 'button', 'aria-label': `赠送物品列表下一页（给 ${person.name}）` },
            });
            nextBag.addEventListener('click', () => stepBagPage(1));
            actRow.appendChild(nextBag);
          }
        }
        li.appendChild(actRow);
      }
      peopleList.appendChild(li);
    }
  }

  // 店铺商品
  const goods = Array.isArray(here.goods) ? here.goods : [];
  goodsList.replaceChildren();
  if (goods.length === 0) {
    shopCard.hidden = true;
  } else {
    shopCard.hidden = false;
    for (const g of goods) {
      const li = make('li', { className: 'entity-item' });
      const meta = make('div', { className: 'entity-meta' });
      meta.appendChild(make('strong', { text: `${g.name} · ${fmtYen(g.price_yen)}` }));
      meta.appendChild(make('span', { className: 'muted small-note', text: `编号 ${g.sku}` }));
      li.appendChild(meta);
      const buyBtn = make('button', { className: 'btn btn-primary', text: '购买 1 份', attrs: { type: 'button' } });
      buyBtn.disabled = !writable || !p.open || (v.wallet?.spendable_yen ?? 0) < Number(g.price_yen || 0);
      buyBtn.addEventListener('click', () => {
        void submitCityAction({ type: 'buy', sku: g.sku, qty: 1 }, `已购买 ${g.name}。`);
      });
      li.appendChild(buyBtn);
      goodsList.appendChild(li);
    }
  }

  // 现场对话
  chatList.replaceChildren();
  const chats = Array.isArray(here.recent_chat) ? here.recent_chat : [];
  if (chats.length === 0) {
    chatList.appendChild(make('li', { className: 'muted small-note', text: '附近暂时安静，还没有人说话。' }));
  } else {
    for (const m of chats) {
      const li = make('li', { className: 'chat-msg' });
      const head = make('div', { className: 'chat-msg-head' });
      head.appendChild(make('strong', { text: `${m.from?.name || '旅人'}${m.mine ? '（我）' : ''}` }));
      head.appendChild(make('span', { text: fmtClock(m.at_ms, state.timezone) }));
      li.appendChild(head);
      li.appendChild(make('div', { text: String(m.text || '') }));
      chatList.appendChild(li);
    }
    chatList.scrollTop = chatList.scrollHeight;
  }
  chatInput.disabled = !writable;
  chatSubmitBtn.disabled = !writable;
}

function renderTravelPanel() {
  const v = state.view;
  if (!v) return;
  const writable = canControl();
  const activeTripCard = mustEl('active-trip-card');
  const activeTripDetail = mustEl('active-trip-detail');
  const exitsList = mustEl('exits-list');

  activeTripDetail.replaceChildren();
  if (v.location?.in_transit && v.location?.trip) {
    const trip = v.location.trip;
    activeTripCard.hidden = false;
    activeTripDetail.appendChild(
      make('p', {
        text: `从 ${trip.from} 前往 ${trip.to} · 总计 ${trip.minutes} 分钟 · 模拟车费 ${fmtYen(trip.fare_yen)} · 预计 ${fmtClock(trip.ends_at_ms, state.timezone)} 到达`,
      }),
    );
    const legUl = make('ul', { className: 'entity-list' });
    for (const leg of Array.isArray(trip.legs) ? trip.legs : []) {
      const current = Number(leg.n) === Number(trip.leg_index);
      const modeLabel = leg.mode === 'train' ? `电车（${leg.line || '幹線'}）` : '步行';
      legUl.appendChild(
        make('li', {
          className: 'entity-item',
          text: `${current ? '▶ 当前段：' : ''}第 ${Number(leg.n) + 1} 段 · ${modeLabel}：${leg.from} → ${leg.to}（${leg.minutes} 分钟，${fmtYen(leg.fare_yen)}）`,
        }),
      );
    }
    activeTripDetail.appendChild(legUl);
  } else {
    activeTripCard.hidden = true;
  }

  exitsList.replaceChildren();
  const exits = Array.isArray(v.here?.exits) ? v.here.exits : [];
  const currentPlace = v.here?.place?.id;
  if (exits.length === 0) {
    exitsList.appendChild(make('li', { className: 'muted small-note', text: '在途期间请等待到达当前目的地后再选择下一站。' }));
    return;
  }

  for (const ex of exits) {
    const li = make('li', { className: 'entity-item' });
    const meta = make('div', { className: 'entity-meta' });
    const statusTxt = ex.open ? '营业/开放' : ex.closed_reason === 'rain' ? '雨天暂闭' : '休息中';
    meta.appendChild(make('strong', { text: `${ex.name}（${ex.area}）` }));
    meta.appendChild(make('span', { className: 'muted small-note', text: `约 ${ex.minutes} 分钟 · 车费 ${fmtYen(ex.fare_yen)} · ${statusTxt}` }));
    li.appendChild(meta);

    const actions = make('div', { className: 'entity-actions' });
    if (currentPlace) {
      const previewBtn = make('button', { className: 'btn btn-ghost', text: '路线分段', attrs: { type: 'button' } });
      previewBtn.addEventListener('click', () => void showRoutePreview(String(currentPlace), String(ex.id)));
      actions.appendChild(previewBtn);
    }
    const goBtn = make('button', { className: 'btn btn-primary', text: '出发前往', attrs: { type: 'button' } });
    goBtn.disabled = !writable || !ex.open || (v.wallet?.spendable_yen ?? 0) < Number(ex.fare_yen || 0);
    goBtn.addEventListener('click', async () => {
      const ok = await submitCityAction({ type: 'travel', to: ex.id }, `已动身前往 ${ex.name}。`);
      if (ok) activateTab('tab-scene', false);
    });
    actions.appendChild(goBtn);
    li.appendChild(actions);
    exitsList.appendChild(li);
  }
}

/**
 * @param {string} fromId
 * @param {string} toId
 */
async function showRoutePreview(fromId, toId) {
  const card = mustEl('route-preview-card');
  const body = mustEl('route-preview-body');
  try {
    const r = await apiCall('GET', `/route?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`);
    body.replaceChildren();
    body.appendChild(
      make('p', {
        text: `总耗时约 ${r.minutes} 分钟 · 模拟票价 ${fmtYen(r.fare_yen)} · 到达时目的地${r.dest_open ? '正常开放' : '暂不开放'}`,
      }),
    );
    const ul = make('ul', { className: 'entity-list' });
    for (const l of Array.isArray(r.legs) ? r.legs : []) {
      const mode = l.mode === 'train' ? `乘坐 ${l.line || '电车'}` : '步行';
      ul.appendChild(
        make('li', {
          className: 'entity-item',
          text: `${mode}：${l.from_name || l.from} → ${l.to_name || l.to}（${l.minutes} 分钟，${fmtYen(l.fare_yen)}）`,
        }),
      );
    }
    body.appendChild(ul);
    card.hidden = false;
  } catch (e) {
    if (e instanceof ApiError) showError(e.message);
  }
}

/**
 * @param {Record<string, any> | undefined | null} meta
 * @returns {string}
 */
function formatItemSubtitle(meta) {
  if (!meta || typeof meta !== 'object') return '';
  /** @type {string[]} */
  const parts = [];
  if (typeof meta.title === 'string' && meta.title) parts.push(`《${meta.title}》`);
  if (typeof meta.summary === 'string' && meta.summary) parts.push(meta.summary);
  if (typeof meta.flyleaf_count === 'number' && meta.flyleaf_count > 0) {
    parts.push(`扉页批注 ${meta.flyleaf_count} 条`);
  }
  return parts.join(' · ');
}

/**
 * @param {HTMLElement} pagerEl
 * @param {HTMLElement} statusEl
 * @param {HTMLButtonElement} prevBtn
 * @param {HTMLButtonElement} nextBtn
 * @param {Record<string, any> | undefined} pageMeta
 * @param {number} shownLen
 */
function renderPager(pagerEl, statusEl, prevBtn, nextBtn, pageMeta, shownLen) {
  const total = typeof pageMeta?.total === 'number' ? pageMeta.total : shownLen;
  const offset = typeof pageMeta?.offset === 'number' ? pageMeta.offset : 0;
  const hasMore = Boolean(pageMeta?.has_more && typeof pageMeta?.next_offset === 'number');
  if (!pageMeta || (offset === 0 && !hasMore)) {
    pagerEl.hidden = true;
    statusEl.textContent = '';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }
  const start = shownLen > 0 ? offset + 1 : offset;
  const end = offset + shownLen;
  statusEl.textContent = shownLen > 0 ? `第 ${start}–${end} 件 / 共 ${total} 件` : `共 ${total} 件`;
  const prevWasFocused = document.activeElement === prevBtn;
  const nextWasFocused = document.activeElement === nextBtn;
  prevBtn.disabled = offset <= 0;
  nextBtn.disabled = !hasMore;
  pagerEl.hidden = false;
  if (prevWasFocused && prevBtn.disabled && !nextBtn.disabled) nextBtn.focus();
  else if (nextWasFocused && nextBtn.disabled && !prevBtn.disabled) prevBtn.focus();
}

/**
 * @param {-1 | 1} dir
 */
function stepBagPage(dir) {
  if (dir < 0) {
    if (state.itemOffset <= 0) return;
    state.itemOffset = state.itemPageStack.length > 0 ? (state.itemPageStack.pop() ?? 0) : 0;
    void refreshMe();
    return;
  }
  const next = state.view?.items_page?.next_offset;
  if (typeof next !== 'number') return;
  state.itemPageStack.push(state.itemOffset);
  state.itemOffset = next;
  void refreshMe();
}

/**
 * @param {-1 | 1} dir
 */
function stepLockerPage(dir) {
  if (dir < 0) {
    if (state.lockerOffset <= 0) return;
    state.lockerOffset = state.lockerPageStack.length > 0 ? (state.lockerPageStack.pop() ?? 0) : 0;
    void refreshMe();
    return;
  }
  const next = state.view?.locker_page?.next_offset;
  if (typeof next !== 'number') return;
  state.lockerPageStack.push(state.lockerOffset);
  state.lockerOffset = next;
  void refreshMe();
}

/**
 * @param {string} itemId
 */
async function toggleInspectItem(itemId) {
  if (state.inspectedItems.has(itemId)) {
    state.inspectedItems.delete(itemId);
    renderLifePanel();
    return;
  }
  try {
    const out = await apiCall('GET', `/items/${encodeURIComponent(itemId)}`);
    if (out.item && typeof out.item === 'object') {
      state.inspectedItems.set(itemId, out.item);
      renderLifePanel();
    }
  } catch (e) {
    if (e instanceof ApiError) showError(e.message);
  }
}

/**
 * @param {HTMLElement} li
 * @param {HTMLElement} actionsEl
 * @param {Record<string, any>} entry
 */
function mountInstanceDetailControls(li, actionsEl, entry) {
  if (!entry.instance) return;
  const itemId = String(entry.item_id || '');
  if (!itemId) return;
  const expanded = state.inspectedItems.has(itemId);
  const labelTarget = entry.meta?.title ? `${entry.name}《${entry.meta.title}》` : String(entry.name || itemId);
  const btnText = expanded ? '收起详情' : '查看详情';
  const btn = make('button', {
    className: 'btn btn-ghost btn-compact',
    text: btnText,
    attrs: {
      type: 'button',
      'aria-expanded': expanded ? 'true' : 'false',
      'aria-label': `${btnText}：${labelTarget}`,
    },
  });
  btn.addEventListener('click', () => {
    void toggleInspectItem(itemId);
  });
  actionsEl.appendChild(btn);

  const detail = state.inspectedItems.get(itemId);
  if (!detail) return;
  const box = make('div', { className: 'item-detail-box' });
  const dMeta = detail.meta && typeof detail.meta === 'object' ? detail.meta : null;
  if (dMeta?.title) {
    box.appendChild(make('strong', { text: `书名/铭牌：${String(dMeta.title)}` }));
  }
  const flyleaf = Array.isArray(dMeta?.flyleaf) ? dMeta.flyleaf : [];
  if (flyleaf.length > 0) {
    const ul = make('ul', { className: 'item-detail-list' });
    for (const noteEntry of flyleaf) {
      const who = String(noteEntry.by_name || '旅人');
      const note = String(noteEntry.note || '');
      ul.appendChild(make('li', { text: `${who}：${note}` }));
    }
    box.appendChild(ul);
  } else if (!dMeta?.title) {
    box.appendChild(make('span', { className: 'muted small-note', text: `物品编号 ${itemId}` }));
  }
  li.appendChild(box);
}

function renderLifePanel() {
  const v = state.view;
  if (!v) return;
  const writable = canControl();
  const canList = Array.isArray(v.can) ? v.can : [];
  const atLocker = canList.includes('store_locker');

  // 钱包
  const walletStats = mustEl('wallet-stats');
  walletStats.replaceChildren();
  const addStat = (/** @type {string} */ label, /** @type {string} */ val) => {
    const box = make('div', { className: 'stat-box' });
    box.appendChild(make('dt', { text: label }));
    box.appendChild(make('dd', { text: val }));
    walletStats.appendChild(box);
  };
  addStat('可支配日元', fmtYen(v.wallet?.spendable_yen ?? 0));
  addStat('账面总余额', fmtYen(v.wallet?.yen ?? 0));
  addStat('待确认冻结额', fmtYen(v.wallet?.held_yen ?? 0));

  const pendingBox = mustEl('pending-orders-box');
  pendingBox.replaceChildren();
  const pendings = Array.isArray(v.pending_orders) ? v.pending_orders : [];
  if (pendings.length > 0) {
    pendingBox.hidden = false;
    pendingBox.appendChild(make('p', { className: 'muted small-note', text: `有 ${pendings.length} 笔结果待确认的订单正在等待对账处理。` }));
  } else {
    pendingBox.hidden = true;
  }

  // 随身背包
  mustEl('bag-station-hint').textContent = atLocker ? '当前位于车站大厅，可将可存物品放入储物柜' : '前往任意车站大厅可存入储物柜';
  const bagList = mustEl('bag-list');
  bagList.replaceChildren();
  const items = Array.isArray(v.items) ? v.items : [];
  if (items.length === 0) {
    bagList.appendChild(make('li', { className: 'muted small-note', text: '随身背包空空如也。去街区店铺逛逛吧。' }));
  } else {
    for (const it of items) {
      const li = make('li', { className: 'entity-item' });
      const meta = make('div', { className: 'entity-meta' });
      const tags = [];
      if (it.instance) tags.push('具名实例');
      if (it.carry_home === false) tags.push('现点饮品·不可寄存');
      meta.appendChild(make('strong', { text: `${it.name} × ${it.qty}${tags.length ? `（${tags.join('，')}）` : ''}` }));
      const subtitle = formatItemSubtitle(it.meta);
      if (subtitle) {
        meta.appendChild(make('span', { className: 'muted small-note', text: subtitle }));
      }
      li.appendChild(meta);

      const actions = make('div', { className: 'entity-actions' });
      if (it.edible) {
        const eatBtn = make('button', { className: 'btn btn-secondary', text: '享用 1 份', attrs: { type: 'button' } });
        eatBtn.disabled = !writable || !canList.includes('consume');
        eatBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'consume', item_id: it.item_id, qty: 1 }, `已享用 ${it.name}。`);
        });
        actions.appendChild(eatBtn);
      }
      if (it.storable) {
        const storeBtn = make('button', { className: 'btn btn-ghost', text: '存入储物柜', attrs: { type: 'button' } });
        storeBtn.disabled = !writable || !atLocker;
        storeBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'store_locker', item_id: it.item_id, qty: 1 }, `已将 ${it.name} 存入车站储物柜。`);
        });
        actions.appendChild(storeBtn);
      }
      li.appendChild(actions);
      mountInstanceDetailControls(li, actions, it);
      bagList.appendChild(li);
    }
  }
  renderPager(bagPager, bagPageStatus, bagPrevBtn, bagNextBtn, v.items_page, items.length);

  // 储物柜
  const lockerBadge = mustEl('locker-status-badge');
  lockerBadge.textContent = atLocker ? '站在车站·可存取' : '仅浏览（去车站可取）';
  lockerBadge.className = `badge ${atLocker ? 'badge-ok' : ''}`;
  const lockerList = mustEl('locker-list');
  lockerList.replaceChildren();
  const lockers = Array.isArray(v.locker_items) ? v.locker_items : [];
  if (lockers.length === 0) {
    lockerList.appendChild(make('li', { className: 'muted small-note', text: '你的城市储物柜里还没有寄存任何物品。' }));
  } else {
    for (const lk of lockers) {
      const li = make('li', { className: 'entity-item' });
      const meta = make('div', { className: 'entity-meta' });
      meta.appendChild(make('strong', { text: `${lk.name} × ${lk.qty}${lk.instance ? '（具名实例）' : ''}` }));
      const lkSubtitle = formatItemSubtitle(lk.meta);
      if (lkSubtitle) {
        meta.appendChild(make('span', { className: 'muted small-note', text: lkSubtitle }));
      }
      li.appendChild(meta);

      const lkActions = make('div', { className: 'entity-actions' });
      const takeBtn = make('button', { className: 'btn btn-secondary', text: '取出 1 件', attrs: { type: 'button' } });
      takeBtn.disabled = !writable || !atLocker;
      takeBtn.addEventListener('click', () => {
        void submitCityAction({ type: 'take_locker', item_id: lk.item_id, qty: 1 }, `已从储物柜取出 ${lk.name}。`);
      });
      lkActions.appendChild(takeBtn);
      li.appendChild(lkActions);
      mountInstanceDetailControls(li, lkActions, lk);
      lockerList.appendChild(li);
    }
  }
  renderPager(lockerPager, lockerPageStatus, lockerPrevBtn, lockerNextBtn, v.locker_page, lockers.length);

  // 个人名片表单（不打断正在输入的焦点）
  if (document.activeElement !== profileNameInput) profileNameInput.value = String(v.me?.name || '');
  if (document.activeElement !== profileBioInput) profileBioInput.value = String(v.me?.bio || '');
  profileNameInput.disabled = !writable;
  profileBioInput.disabled = !writable;
  profileSubmitBtn.disabled = !writable;
}

function renderOverview() {
  const pub = state.publicView;
  if (!pub) return;
  mustEl('overview-summary').textContent = `目录版本 ${pub.city_catalog_version} · 票价规则 ${pub.transit?.rule_version ?? ''} · 此刻在途总人数：${pub.in_transit ?? 0} 人`;

  const areasBox = mustEl('overview-areas');
  areasBox.replaceChildren();
  for (const a of Array.isArray(pub.areas) ? pub.areas : []) {
    const card = make('article', { className: 'card' });
    card.appendChild(make('h3', { text: `${a.name}（${a.ward}）` }));
    card.appendChild(make('p', { className: 'muted small-note', text: String(a.blurb || '') }));
    if (a.weather) {
      card.appendChild(
        make('p', {
          className: 'weather-pill',
          text: `${a.weather.text} · ${a.weather.temp_c}°C${a.weather.rain ? ' · 下雨' : ''}`,
        }),
      );
    }
    const ul = make('ul', { className: 'entity-list' });
    for (const p of Array.isArray(a.places) ? a.places : []) {
      const who = Array.isArray(p.here) && p.here.length > 0 ? ` · 在场：${p.here.map((/** @type {any} */ r) => r.name).join('、')}` : '';
      ul.appendChild(
        make('li', {
          className: 'entity-item',
          text: `${p.name}（${p.open ? '开放' : '关闭'}，${p.hours}）${who}`,
        }),
      );
    }
    card.appendChild(ul);
    areasBox.appendChild(card);
  }

  const srcList = mustEl('overview-sources');
  srcList.replaceChildren();
  for (const s of Array.isArray(pub.sources) ? pub.sources : []) {
    const li = make('li', { className: 'entity-item' });
    const meta = make('div', { className: 'entity-meta' });
    meta.appendChild(make('strong', { text: String(s.title || s.id) }));
    meta.appendChild(make('span', { className: 'muted small-note', text: `${s.note || ''}${s.license ? `（许可：${s.license}）` : ''}` }));
    li.appendChild(meta);
    srcList.appendChild(li);
  }
}

function renderWorkspace() {
  renderHeaderAndControl();
  renderScenePanel();
  renderTravelPanel();
  renderLifePanel();
}

function renderApp() {
  const inCity = Boolean(state.loggedIn && state.view?.me?.in_city);
  gateSection.hidden = inCity;
  cityWorkspace.hidden = !inCity;
  renderHeaderAndControl();
  if (inCity) {
    renderWorkspace();
  } else {
    renderGate();
  }
}

// ───────────────────────── 会话同步与事件绑定 ─────────────────────────

async function syncSession() {
  const sess = await apiCall('GET', '/session');
  state.loggedIn = Boolean(sess.logged_in);
  if (!state.loggedIn) {
    state.csrfToken = '';
    state.principal = null;
    state.sessionResident = null;
    state.view = null;
    resetInventoryPaging();
    stopRealtime();
    return;
  }
  state.csrfToken = String(sess.csrf_token || '');
  state.principal = sess.principal || null;
  state.sessionResident = sess.resident || null;
  if (state.sessionResident?.in_city) {
    await refreshMe();
    startRealtime();
  } else {
    state.view = null;
    stopRealtime();
  }
}

/**
 * @param {string} rawTicket
 */
async function redeemTicket(rawTicket) {
  setFieldError(ticketError, ticketInput, '');
  showError('');
  try {
    const out = await apiCall('POST', '/auth/exchange', { ticket: rawTicket });
    state.loggedIn = true;
    state.csrfToken = String(out.csrf_token || '');
    state.principal = out.principal || null;
    state.sessionResident = out.resident || null;
    ticketInput.value = '';
    if (state.sessionResident?.in_city) {
      await refreshMe();
      startRealtime();
      showNotice(`欢迎回到东京都，${state.sessionResident.name}。`);
    } else {
      renderApp();
      showNotice('票据验证成功，请确认入城信息。');
    }
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : '票据兑换失败，请检查网络连接。';
    setFieldError(ticketError, ticketInput, msg);
  }
}

// 表单与按钮监听
ticketInput.addEventListener('input', () => setFieldError(ticketError, ticketInput, ''));
ticketForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const val = ticketInput.value.trim();
  if (!val) {
    setFieldError(ticketError, ticketInput, '请输入一次性登录票据。');
    ticketInput.focus();
    return;
  }
  void redeemTicket(val);
});

devNameInput.addEventListener('input', () => setFieldError(devNameError, devNameInput, ''));
devForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = devNameInput.value.trim();
  if (!name) {
    setFieldError(devNameError, devNameInput, '请输入 1～16 字的测试角色名。');
    devNameInput.focus();
    return;
  }
  try {
    const out = await apiCall('POST', '/auth/dev', { name });
    state.loggedIn = true;
    state.csrfToken = String(out.csrf_token || '');
    state.principal = out.principal || null;
    state.sessionResident = out.resident || null;
    renderApp();
  } catch (e) {
    setFieldError(devNameError, devNameInput, e instanceof ApiError ? e.message : '本机登录失败');
  }
});

enterNameInput.addEventListener('input', () => setFieldError(enterNameError, enterNameInput, ''));
enterForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setFieldError(enterNameError, enterNameInput, '');
  showError('');
  /** @type {Record<string, unknown>} */
  const payload = {
    client_id: state.clientId,
    claim: false,
  };
  if (!state.sessionResident) {
    const name = enterNameInput.value.trim();
    if (!name) {
      setFieldError(enterNameError, enterNameInput, '第一次进入东京都请填写 1～16 字的显示名。');
      enterNameInput.focus();
      return;
    }
    payload.name = name;
    const checkedStation = /** @type {HTMLInputElement | null} */ (enterForm.querySelector('input[name="entry"]:checked'));
    if (checkedStation) payload.entry = checkedStation.value;
  }
  const bio = enterBioInput.value.trim();
  if (bio) payload.bio = bio;
  try {
    const out = await apiCall('POST', '/enter', payload);
    resetInventoryPaging();
    state.view = out.view;
    state.sessionResident = {
      id: String(out.resident_id),
      name: String(out.view?.me?.name || ''),
      in_city: true,
    };
    renderApp();
    startRealtime();
    if (out.granted_yen) {
      showNotice(`欢迎来到东京都！已发放一次性启动资金 ${fmtYen(out.granted_yen)}。`);
    } else {
      showNotice('已进入东京都。');
    }
  } catch (e) {
    if (e instanceof ApiError && (e.reason === 'name_required' || e.reason === 'name_taken')) {
      setFieldError(enterNameError, enterNameInput, e.message);
      enterNameInput.focus();
    } else {
      showError(e instanceof ApiError ? e.message : '进入东京都失败');
    }
  }
});

// IME 安全的聊天回车提交（规避中文输入法选词回车误发送，含 Safari WebKit keyCode 229 回退）
chatInput.addEventListener('input', () => setFieldError(chatError, chatInput, ''));
chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  if (event.isComposing || event.keyCode === 229) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

chatForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = chatInput.value.trim();
  if (!text) {
    setFieldError(chatError, chatInput, '要说的话不能为空。');
    return;
  }
  if (Array.from(text).length > state.chatMaxChars) {
    setFieldError(chatError, chatInput, `单条发言最多 ${state.chatMaxChars} 个字。`);
    return;
  }
  chatSubmitBtn.disabled = true;
  const ok = await submitCityAction({ type: 'say', text });
  chatSubmitBtn.disabled = !canControl();
  if (ok) {
    chatInput.value = '';
    setFieldError(chatError, chatInput, '');
  }
});

profileNameInput.addEventListener('input', () => setFieldError(profileError, profileNameInput, ''));
profileForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = profileNameInput.value.trim();
  const bio = profileBioInput.value.trim();
  if (!name) {
    setFieldError(profileError, profileNameInput, '显示名不能为空（1～16 字）。');
    profileNameInput.focus();
    return;
  }
  const ok = await submitCityAction({ type: 'update_profile', name, bio }, '个人名片已更新。');
  if (ok) setFieldError(profileError, profileNameInput, '');
});

claimControlBtn.addEventListener('click', async () => {
  showError('');
  try {
    const out = await apiCall('POST', '/claim', {
      client_id: state.clientId,
      ...(state.itemOffset > 0 ? { item_offset: state.itemOffset } : {}),
      ...(state.lockerOffset > 0 ? { locker_offset: state.lockerOffset } : {}),
    });
    if (out.view) state.view = out.view;
    renderApp();
    showNotice('已接管本窗口的居民控制权。');
  } catch (e) {
    showError(e instanceof ApiError ? e.message : '接管控制权失败');
  }
});

leaveCityBtn.addEventListener('click', async () => {
  showError('');
  try {
    await apiCall('POST', '/leave', { client_id: state.clientId });
    stopRealtime();
    await syncSession();
    renderApp();
    showNotice('已暂离东京都休息。随身日元、物品与储物柜均已保留。');
  } catch (e) {
    showError(e instanceof ApiError ? e.message : '暂离失败');
  }
});

logoutBtn.addEventListener('click', async () => {
  showError('');
  try {
    await apiCall('POST', '/auth/logout', {});
  } catch {
    /* ignore if already expired */
  }
  stopRealtime();
  state.loggedIn = false;
  state.csrfToken = '';
  state.principal = null;
  state.sessionResident = null;
  state.view = null;
  resetInventoryPaging();
  renderApp();
  showNotice('已安全退出登录。');
});

refreshHistoryBtn.addEventListener('click', () => void loadHistory(true));
moreHistoryBtn.addEventListener('click', () => void loadHistory(false));
bagPrevBtn.addEventListener('click', () => stepBagPage(-1));
bagNextBtn.addEventListener('click', () => stepBagPage(1));
lockerPrevBtn.addEventListener('click', () => stepLockerPage(-1));
lockerNextBtn.addEventListener('click', () => stepLockerPage(1));

// ───────────────────────── 启动入口 ─────────────────────────

function extractTicketFromHash() {
  const raw = window.location.hash || '';
  if (!raw) return '';
  const params = new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw);
  const t = (params.get('ticket') || '').trim();
  if (t) {
    // 立即抹除地址栏里的 #ticket=，防止浏览器历史记录或截屏泄露
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return t;
}

async function boot() {
  const hashTicket = extractTicketFromHash();
  try {
    const cfg = await apiCall('GET', '/config');
    state.timezone = String(cfg.world?.timezone || 'Asia/Tokyo');
    state.heartbeatMs = Number(cfg.heartbeat_ms || 60_000);
    state.chatMaxChars = Number(cfg.limits?.chat_max_chars || 300);
    chatInput.maxLength = state.chatMaxChars;
    devForm.hidden = !cfg.dev_login;
  } catch {
    /* config probe failed; keep safe defaults */
  }

  void loadPublicOverview();

  if (hashTicket) {
    await redeemTicket(hashTicket);
    return;
  }

  try {
    await syncSession();
  } catch {
    state.loggedIn = false;
  }
  renderApp();
}

void boot();
