// @ts-check
/**
 * 灯都（/city/play/）人类文字优先单页客户端。
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
 * @param {string} id
 * @returns {SVGSVGElement}
 */
function mustSvg(id) {
  const el = document.getElementById(id);
  if (!el || String(el.tagName || '').toLowerCase() !== 'svg') throw new Error(`Missing SVG #${id}`);
  return /** @type {SVGSVGElement} */ (/** @type {unknown} */ (el));
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @param {string} [text]
 * @returns {SVGElement}
 */
function makeSvg(tag, attrs = {}, text) {
  const el =
    typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : /** @type {SVGElement} */ (/** @type {unknown} */ (document.createElement(tag)));
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  if (text !== undefined) el.textContent = text;
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
function fmtClock(ms, tz = 'JST') {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const zone = tz === 'JST' ? '+09:00' : tz;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms + 9 * 3600_000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
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
  timezone: 'JST',
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
  /** @type {{ collected: number; total: number; stamps: Array<Record<string, any>> } | null} */
  stampBook: null,
  motionPaused: false,
  renderedSilhouetteArea: '',
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
  /** @type {Record<string, any>[] | null} */
  recentAuctions: null,
  venueTodoSignature: '',
  auctionSignature: '',
  knownAuctionIds: '',
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
const lcdBoard = mustEl('lcd-board');
const lcdStampBtn = /** @type {HTMLButtonElement} */ (mustEl('lcd-stamp-btn'));
const sceneStampBtn = /** @type {HTMLButtonElement} */ (mustEl('scene-stamp-btn'));
const toggleMotionBtn = /** @type {HTMLButtonElement} */ (mustEl('toggle-motion-btn'));

// ───────────────────────── 三站铁道拓扑与印章常量 ─────────────────────────

/**
 * @typedef {{
 *   id: string;
 *   placeId: string;
 *   area: string;
 *   code: string;
 *   name: string;
 *   lineKey: string;
 *   lineSummary: string;
 *   stampTitle: string;
 *   x: number;
 *   y: number;
 *   labelDy: number;
 * }} StationMeta
 */

/** @type {readonly StationMeta[]} */
const RAIL_STATIONS = [
  {
    id: 'st:hiwatari',
    placeId: 'hiwatari:station',
    area: 'hiwatari',
    code: 'HW',
    name: '绯渡站',
    lineKey: 'hokkan',
    lineSummary: '灯都铁道 北环快线',
    stampTitle: '绯渡站 · 澪川铁桥与晚霞',
    x: 148,
    y: 64,
    labelDy: 32,
  },
  {
    id: 'st:kagamiike',
    placeId: 'kagamiike:station',
    area: 'kagamiike',
    code: 'KG',
    name: '镜池站',
    lineKey: 'toukan',
    lineSummary: '灯都铁道 灯环线 · 北环快线',
    stampTitle: '镜池站 · 木雕猫头鹰与书灯',
    x: 336,
    y: 138,
    labelDy: 32,
  },
  {
    id: 'st:sentou',
    placeId: 'sentou:station',
    area: 'sentou',
    code: 'ST',
    name: '千灯站',
    lineKey: 'toukan',
    lineSummary: '灯都铁道 灯环线 · 北环快线',
    stampTitle: '千灯站 · 南口跨线露台与钟塔',
    x: 524,
    y: 178,
    labelDy: 32,
  },
];

const RAIL_EDGES = [
  {
    id: 'te:hiwatari-kagamiike',
    fromPlace: 'hiwatari:station',
    toPlace: 'kagamiike:station',
    d: 'M 148 64 L 336 138',
    className: 'rail-hokkan',
    label: '北环快线 · 13分 · ¥200',
    lx: 232,
    ly: 118,
  },
  {
    id: 'te:hiwatari-sentou',
    fromPlace: 'hiwatari:station',
    toPlace: 'sentou:station',
    d: 'M 148 64 Q 368 18 524 178',
    className: 'rail-direct',
    label: '北环快线直达 · 19分 · ¥260',
    lx: 364,
    ly: 52,
  },
  {
    id: 'te:kagamiike-sentou',
    fromPlace: 'kagamiike:station',
    toPlace: 'sentou:station',
    d: 'M 336 138 L 524 178',
    className: 'rail-toukan',
    label: '灯环线 · 10分 · ¥200',
    lx: 424,
    ly: 176,
  },
];

/**
 * @param {string | undefined | null} areaOrPlace
 * @returns {StationMeta}
 */
function stationMetaFor(areaOrPlace) {
  const raw = String(areaOrPlace || '');
  const areaPrefix = raw.includes(':') ? raw.split(':')[0] : raw;
  return RAIL_STATIONS.find((s) => s.area === areaPrefix || s.placeId === raw || s.id === raw) || RAIL_STATIONS[2];
}

/**
 * @param {string | undefined} lineName
 * @param {string | undefined} mode
 * @returns {string}
 */
function lineKeyOf(lineName, mode) {
  if (mode === 'walk') return 'walk';
  const s = String(lineName || '');
  if (s.includes('北环')) return 'hokkan';
  return 'toukan';
}

/**
 * @param {string | undefined} placeId
 * @returns {string}
 */
function friendlyPlaceLabel(placeId) {
  const id = String(placeId || '');
  if (!id) return '未知地点';
  const st = RAIL_STATIONS.find((s) => s.placeId === id);
  if (st) return st.name;
  const areas = Array.isArray(state.publicView?.areas) ? state.publicView.areas : [];
  for (const a of areas) {
    for (const p of Array.isArray(a.places) ? a.places : []) {
      if (p.id === id) return String(p.name || id);
    }
  }
  return id;
}

/**
 * 从 JST local_time（"YYYY-MM-DD HH:MM"）解析小时，决定昼夜天色分段。
 * @param {string | undefined} localTime
 * @returns {{ tod: 'dawn' | 'day' | 'dusk' | 'night'; label: string; hhmm: string }}
 */
function parseTimeOfDay(localTime) {
  const m = /(\d{2}):(\d{2})$/.exec(String(localTime || '').trim());
  const hh = m ? Number(m[1]) : 12;
  const hhmm = m ? `${m[1]}:${m[2]}` : '--:--';
  if (hh >= 5 && hh <= 6) return { tod: 'dawn', label: '朝霞', hhmm };
  if (hh >= 7 && hh <= 15) return { tod: 'day', label: '白昼', hhmm };
  if (hh >= 16 && hh <= 18) return { tod: 'dusk', label: '夕照', hhmm };
  return { tod: 'night', label: '夜色', hhmm };
}

/**
 * 严格按真实天气快照判别晴/阴/真雨：合成回退绝不伪造降雨。
 * @param {Record<string, any> | null | undefined} w
 * @returns {{ sky: 'clear' | 'cloudy' | 'rain'; summary: string }}
 */
function resolveWindowSky(w) {
  if (!w) return { sky: 'clear', summary: '天气同步中' };
  const src = w.source === 'open-meteo' ? 'Open-Meteo' : '合成回退';
  const temp = typeof w.temp_c === 'number' ? ` ${w.temp_c}°C` : '';
  if (w.rain === true && w.source !== 'synthetic') {
    return { sky: 'rain', summary: `${w.text || '降雨'}${temp}（实时真雨 · ${src}）` };
  }
  if (typeof w.code === 'number' && w.code >= 2) {
    return { sky: 'cloudy', summary: `${w.text || '多云'}${temp}（${src}）` };
  }
  return { sky: 'clear', summary: `${w.text || '晴朗'}${temp}（${src}）` };
}

const bagPager = mustEl('bag-pager');
const bagPageStatus = mustEl('bag-page-status');
const bagPrevBtn = /** @type {HTMLButtonElement} */ (mustEl('bag-prev-btn'));
const bagNextBtn = /** @type {HTMLButtonElement} */ (mustEl('bag-next-btn'));

const lockerPager = mustEl('locker-pager');
const lockerPageStatus = mustEl('locker-page-status');
const lockerPrevBtn = /** @type {HTMLButtonElement} */ (mustEl('locker-prev-btn'));
const lockerNextBtn = /** @type {HTMLButtonElement} */ (mustEl('locker-next-btn'));

const sceneVenueCard = mustEl('scene-venue-card');
const sceneVenueBadge = mustEl('scene-venue-badge');
const venueLobbyBox = mustEl('venue-lobby-box');
const venueOpenForm = /** @type {HTMLFormElement} */ (mustEl('venue-open-form'));
const venueOpenSubmitBtn = /** @type {HTMLButtonElement} */ (mustEl('venue-open-submit-btn'));
const venueTablesList = mustEl('venue-tables-list');
const venueActiveBox = mustEl('venue-active-box');
const venueTableSummary = mustEl('venue-table-summary');
const venuePrivateBox = mustEl('venue-private-box');
const venueTodoBox = mustEl('venue-todo-box');
const venueStartBtn = /** @type {HTMLButtonElement} */ (mustEl('venue-start-btn'));
const venueLeaveBtn = /** @type {HTMLButtonElement} */ (mustEl('venue-leave-btn'));

const sceneAuctionCard = mustEl('scene-auction-card');
const auctionRefreshBtn = /** @type {HTMLButtonElement} */ (mustEl('auction-refresh-btn'));
const sceneAuctionsList = mustEl('scene-auctions-list');
const auctionHistoryBox = mustEl('auction-history-box');
const auctionHistoryList = mustEl('auction-history-list');

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
  const errId = errEl.id;
  const updateDescribedBy = (/** @type {boolean} */ show) => {
    if (!errId || !inputEl.dataset?.error) return;
    const ids = (inputEl.getAttribute?.('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errId);
    if (show) ids.push(errId);
    if (ids.length) inputEl.setAttribute('aria-describedby', ids.join(' '));
    else inputEl.removeAttribute('aria-describedby');
  };
  if (!msg) {
    errEl.hidden = true;
    errEl.textContent = '';
    inputEl.setAttribute('aria-invalid', 'false');
    updateDescribedBy(false);
  } else {
    errEl.textContent = msg;
    errEl.hidden = false;
    inputEl.setAttribute('aria-invalid', 'true');
    updateDescribedBy(true);
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
  if (tabId === 'tab-life' && !state.stampBook) void loadStampBook();
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
    if (!state.stampBook || (v.stamp_book && state.stampBook.collected !== v.stamp_book.collected)) {
      void loadStampBook();
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
      if (action.type === 'stamp_station' || !state.stampBook) {
        await loadStampBook();
      }
    } else {
      await refreshMe();
    }
    if (successNote) showNotice(successNote);
    return out;
  } catch (e) {
    if (e instanceof ApiError) {
      showError(e.message);
      if (
        e.reason === 'auction_closed' ||
        e.reason === 'no_such_auction' ||
        e.reason === 'table_not_forming' ||
        e.reason === 'no_such_table'
      ) {
        void refreshMe();
      }
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
    if (state.view?.me?.in_city) {
      renderCommuterDeck();
      renderTravelTopology();
    }
  } catch {
    /* ignore transient overview failure */
  }
}

async function loadStampBook() {
  if (!state.loggedIn || !state.sessionResident?.in_city) return;
  try {
    const res = await apiCall('GET', '/stamps');
    if (Array.isArray(res.stamps)) {
      state.stampBook = {
        collected: Number(res.collected || 0),
        total: Number(res.total || res.stamps.length),
        stamps: res.stamps,
      };
      renderStampBook();
      renderTravelTopology();
    }
  } catch {
    /* ignore transient stamp fetch failure */
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

/**
 * @param {string} gameType
 * @returns {string}
 */
function venueGameLabel(gameType) {
  if (gameType === 'liars_dice') return '大话骰';
  if (gameType === 'color_chain') return '彩牌接龙';
  return String(gameType || '桌游');
}

/**
 * @param {Record<string, any>} v
 * @param {boolean} writable
 */
function renderVenueCard(v, writable) {
  const canList = Array.isArray(v.can) ? v.can : [];
  const vt = v.venue_table && typeof v.venue_table === 'object' ? v.venue_table : null;
  const tables = Array.isArray(v.here?.tables) ? v.here.tables : [];
  const showVenue = Boolean(vt) || canList.includes('open_table') || tables.length > 0;
  sceneVenueCard.hidden = !showVenue;
  if (!showVenue) {
    state.venueTodoSignature = '';
    return;
  }

  if (!vt) {
    state.venueTodoSignature = '';
    venueLobbyBox.hidden = false;
    venueActiveBox.hidden = true;
    sceneVenueBadge.textContent = tables.length > 0 ? `${tables.length} 桌可选` : '可开桌';
    sceneVenueBadge.className = 'badge';
    venueOpenSubmitBtn.disabled = !writable || !canList.includes('open_table');

    venueTablesList.replaceChildren();
    if (tables.length === 0) {
      venueTablesList.appendChild(make('li', { className: 'muted small-note', text: '茶屋里还没有凑桌中的牌桌，可以自己先开一桌。' }));
    } else {
      for (const tbl of tables) {
        const li = make('li', { className: 'entity-item' });
        const meta = make('div', { className: 'entity-meta' });
        const statusTxt = tbl.status === 'forming' ? '等待入座' : '对局进行中';
        meta.appendChild(make('strong', { text: `${venueGameLabel(String(tbl.game))} · ${statusTxt}` }));
        meta.appendChild(make('span', { className: 'muted small-note', text: `桌号 ${tbl.id} · 当前 ${Number(tbl.players || 0)} 人` }));
        li.appendChild(meta);
        const joinBtn = make('button', {
          className: 'btn btn-secondary',
          text: tbl.status === 'forming' ? '入座同玩' : '已开局',
          attrs: { type: 'button' },
        });
        joinBtn.disabled = !writable || tbl.status !== 'forming' || !canList.includes('join_table');
        joinBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'join_table', table_id: tbl.id }, '已入座茶屋牌桌。');
        });
        li.appendChild(joinBtn);
        venueTablesList.appendChild(li);
      }
    }
    return;
  }

  venueLobbyBox.hidden = true;
  venueActiveBox.hidden = false;
  const gameLabel = venueGameLabel(String(vt.game));
  if (vt.status === 'forming') {
    sceneVenueBadge.textContent = `凑桌中（${Number(vt.players || 0)} 人）`;
    sceneVenueBadge.className = 'badge badge-warn';
  } else if (vt.todo) {
    sceneVenueBadge.textContent = '轮到你行动';
    sceneVenueBadge.className = 'badge badge-ok';
  } else {
    sceneVenueBadge.textContent = '等待其他玩家';
    sceneVenueBadge.className = 'badge';
  }

  venueTableSummary.replaceChildren();
  if (vt.status === 'forming') {
    venueTableSummary.appendChild(
      make('p', {
        text: `已入座【${gameLabel}】（桌号 ${vt.id}），当前同桌 ${Number(vt.players || 0)} 人。至少需要 2 位同在茶屋的玩家才可开局。`,
      }),
    );
  } else {
    const pub = vt.public && typeof vt.public === 'object' ? vt.public : {};
    venueTableSummary.appendChild(
      make('p', {
        text: `正在进行【${gameLabel}】第 ${vt.round ?? 1} 轮 · 你的座位：${vt.seat} 号（桌号 ${vt.id}）`,
      }),
    );
    if (vt.game === 'liars_dice') {
      const bidInfo = pub.current_bid
        ? `当前叫牌：${pub.current_bid.seat}号 叫 ${pub.current_bid.quantity} 个 ${pub.current_bid.face} 点`
        : `尚未叫牌（开叫至少 ${pub.min_open_quantity ?? 1} 个）`;
      venueTableSummary.appendChild(
        make('p', {
          className: 'small-note muted',
          text: `场上总骰 ${pub.total_dice ?? 0} 颗 · ${bidInfo} · 点数顺序 2<3<4<5<6<1`,
        }),
      );
      if (Array.isArray(pub.players) && pub.players.length > 0) {
        const seatsTxt = pub.players
          .map((/** @type {any} */ p) => `${p.seat}号 ${p.name}（${p.lives}命/${p.dice_count}骰）`)
          .join(' · ');
        venueTableSummary.appendChild(make('p', { className: 'small-note', text: `座位：${seatsTxt}` }));
      }
    } else if (vt.game === 'color_chain') {
      venueTableSummary.appendChild(
        make('p', {
          className: 'small-note muted',
          text: `顶牌：${pub.top_card ?? '—'} · 当前颜色：${pub.current_color ?? '—'} · 方向：${pub.direction ?? '—'} · 牌堆余 ${pub.draw_pile_count ?? 0} 张`,
        }),
      );
      if (Array.isArray(pub.players) && pub.players.length > 0) {
        const seatsTxt = pub.players
          .map((/** @type {any} */ p) => `${p.seat}号 ${p.name}（${p.hand_count}张）`)
          .join(' · ');
        venueTableSummary.appendChild(make('p', { className: 'small-note', text: `座位：${seatsTxt}` }));
      }
    }
  }

  // 私密手牌 / 私密骰子投影（仅自己可见）
  venuePrivateBox.replaceChildren();
  if (vt.you && typeof vt.you === 'object') {
    venuePrivateBox.hidden = false;
    if (vt.game === 'liars_dice') {
      const diceArr = Array.isArray(vt.you.dice) ? vt.you.dice : [];
      venuePrivateBox.appendChild(
        make('p', {
          text: `你的私密骰子：${diceArr.length ? diceArr.join(' · ') : '（等待摇骰）'}（剩余 ${vt.you.lives ?? 0} 条命，${vt.you.wild_ones ? '1 为百搭' : '1 不百搭'}）`,
        }),
      );
    } else if (vt.game === 'color_chain') {
      const handArr = Array.isArray(vt.you.hand) ? vt.you.hand : [];
      const playableArr = Array.isArray(vt.you.playable) ? vt.you.playable : [];
      venuePrivateBox.appendChild(make('p', { text: `你的私密手牌（${handArr.length} 张）：${handArr.join('、') || '无'}` }));
      if (playableArr.length > 0) {
        venuePrivateBox.appendChild(make('p', { className: 'small-note muted', text: `当前可出合法牌：${playableArr.join('、')}` }));
      }
    }
  } else {
    venuePrivateBox.hidden = true;
  }

  venueStartBtn.hidden = vt.status !== 'forming';
  venueStartBtn.disabled = !writable || Number(vt.players || 0) < 2;
  venueStartBtn.dataset.tableId = String(vt.id);
  venueLeaveBtn.disabled = !writable;

  // 待办行动表单
  const todo = vt.status === 'running' && vt.todo && typeof vt.todo === 'object' ? vt.todo : null;
  if (!todo) {
    state.venueTodoSignature = '';
    venueTodoBox.hidden = true;
    venueTodoBox.replaceChildren();
    return;
  }

  venueTodoBox.hidden = false;
  const actions = Array.isArray(todo.actions) ? todo.actions : [];
  const sig = `${vt.id}|${vt.round}|${vt.phase}|${actions.join(',')}|${writable}|${JSON.stringify(vt.public?.min_next_bid ?? null)}|${JSON.stringify(vt.you?.playable ?? null)}`;
  if (sig === state.venueTodoSignature && venueTodoBox.contains(document.activeElement)) {
    return;
  }
  state.venueTodoSignature = sig;
  venueTodoBox.replaceChildren();

  const secText = typeof todo.seconds_left === 'number' ? `（限时约 ${todo.seconds_left} 秒）` : '';
  venueTodoBox.appendChild(make('p', { className: 'lead-text', text: `${String(todo.prompt || '请行动')}${secText}` }));

  if (vt.game === 'liars_dice') {
    if (actions.includes('bid')) {
      const bidForm = make('form', { className: 'stack-form', attrs: { id: 'venue-dice-bid-form', novalidate: '' } });
      const row = make('div', { className: 'inline-controls' });
      const minBid = vt.public?.min_next_bid;
      const defaultQty = Number(minBid?.quantity ?? vt.public?.min_open_quantity ?? 1);
      const defaultFace = Number(minBid?.face ?? 2);

      const qField = make('div', { className: 'field' });
      qField.appendChild(make('label', { text: '叫牌个数（整数）', attrs: { for: 'dice-qty-input' } }));
      const qInput = /** @type {HTMLInputElement} */ (
        make('input', {
          attrs: {
            id: 'dice-qty-input',
            name: 'quantity',
            type: 'text',
            inputmode: 'numeric',
            enterkeyhint: 'send',
            autocomplete: 'off',
            autocorrect: 'off',
            autocapitalize: 'none',
            spellcheck: 'false',
            required: '',
            'aria-invalid': 'false',
            'data-error': 'dice-bid-error',
          },
        })
      );
      qInput.value = String(defaultQty);
      qField.appendChild(qInput);
      row.appendChild(qField);

      const fField = make('div', { className: 'field' });
      fField.appendChild(make('label', { text: '点数（2<3<4<5<6<1）', attrs: { for: 'dice-face-select' } }));
      const fSelect = /** @type {HTMLSelectElement} */ (make('select', { attrs: { id: 'dice-face-select', name: 'face' } }));
      for (const faceVal of [2, 3, 4, 5, 6, 1]) {
        const opt = make('option', {
          text: faceVal === 1 ? '1 点（最大/百搭）' : `${faceVal} 点`,
          attrs: { value: String(faceVal) },
        });
        if (faceVal === defaultFace) opt.selected = true;
        fSelect.appendChild(opt);
      }
      fField.appendChild(fSelect);
      row.appendChild(fField);
      bidForm.appendChild(row);

      const errEl = make('p', { className: 'field-error', attrs: { id: 'dice-bid-error' } });
      errEl.hidden = true;
      bidForm.appendChild(errEl);

      const actRow = make('div', { className: 'form-actions' });
      const bidBtn = make('button', { className: 'btn btn-primary', text: '提交叫牌', attrs: { type: 'submit', id: 'venue-dice-bid-btn' } });
      bidBtn.disabled = !writable;
      actRow.appendChild(bidBtn);

      if (actions.includes('challenge')) {
        const chalBtn = make('button', {
          className: 'btn btn-secondary',
          text: '开牌质疑',
          attrs: { type: 'button', id: 'venue-dice-challenge-btn' },
        });
        chalBtn.disabled = !writable;
        chalBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'challenge' } }, '已发起开牌质疑。');
        });
        actRow.appendChild(chalBtn);
      }
      bidForm.appendChild(actRow);

      qInput.addEventListener('input', () => setFieldError(errEl, qInput, ''));
      bidForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const qty = Number.parseInt(qInput.value.trim(), 10);
        const face = Number.parseInt(fSelect.value, 10);
        if (!Number.isInteger(qty) || qty < 1) {
          setFieldError(errEl, qInput, '请输入大于 0 的整数个数。');
          qInput.focus();
          return;
        }
        void submitCityAction(
          { type: 'game_act', table_id: vt.id, input: { action: 'bid', quantity: qty, face } },
          `已叫牌 ${qty} 个 ${face} 点。`,
        );
      });
      venueTodoBox.appendChild(bidForm);
    } else if (actions.includes('challenge')) {
      const chalBtn = make('button', {
        className: 'btn btn-primary',
        text: '开牌质疑',
        attrs: { type: 'button', id: 'venue-dice-challenge-btn' },
      });
      chalBtn.disabled = !writable;
      chalBtn.addEventListener('click', () => {
        void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'challenge' } }, '已发起开牌质疑。');
      });
      venueTodoBox.appendChild(chalBtn);
    }
    return;
  }

  if (vt.game === 'color_chain') {
    const colors = Array.isArray(vt.you?.colors) && vt.you.colors.length ? vt.you.colors : ['红', '黄', '蓝', '绿'];
    if (actions.includes('color')) {
      const colorForm = make('form', { className: 'stack-form', attrs: { id: 'venue-cc-color-form', novalidate: '' } });
      const field = make('div', { className: 'field' });
      field.appendChild(make('label', { text: '指定当前颜色', attrs: { for: 'cc-color-select' } }));
      const sel = /** @type {HTMLSelectElement} */ (make('select', { attrs: { id: 'cc-color-select', name: 'color' } }));
      for (const c of colors) sel.appendChild(make('option', { text: String(c), attrs: { value: String(c) } }));
      field.appendChild(sel);
      colorForm.appendChild(field);
      const btn = make('button', { className: 'btn btn-primary', text: '选定颜色', attrs: { type: 'submit' } });
      btn.disabled = !writable;
      colorForm.appendChild(btn);
      colorForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'color', color: sel.value } }, `已选定颜色 ${sel.value}。`);
      });
      venueTodoBox.appendChild(colorForm);
      return;
    }

    if (actions.includes('accept') || actions.includes('challenge')) {
      const row = make('div', { className: 'form-actions' });
      if (actions.includes('accept')) {
        const acceptBtn = make('button', { className: 'btn btn-primary', text: '不质疑（摸 4 张）', attrs: { type: 'button' } });
        acceptBtn.disabled = !writable;
        acceptBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'accept' } }, '已选择不质疑。');
        });
        row.appendChild(acceptBtn);
      }
      if (actions.includes('challenge')) {
        const chalBtn = make('button', { className: 'btn btn-secondary', text: '质疑变色+4', attrs: { type: 'button' } });
        chalBtn.disabled = !writable;
        chalBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'challenge' } }, '已发起质疑。');
        });
        row.appendChild(chalBtn);
      }
      venueTodoBox.appendChild(row);
      return;
    }

    const playable = Array.isArray(vt.you?.playable) ? vt.you.playable : [];
    if (actions.includes('play') && playable.length > 0) {
      const playForm = make('form', { className: 'stack-form', attrs: { id: 'venue-cc-play-form', novalidate: '' } });
      const row = make('div', { className: 'inline-controls' });

      const cardField = make('div', { className: 'field' });
      cardField.appendChild(make('label', { text: '选择要出的牌', attrs: { for: 'cc-card-select' } }));
      const cardSel = /** @type {HTMLSelectElement} */ (make('select', { attrs: { id: 'cc-card-select', name: 'card' } }));
      for (const cardName of playable) cardSel.appendChild(make('option', { text: String(cardName), attrs: { value: String(cardName) } }));
      cardField.appendChild(cardSel);
      row.appendChild(cardField);

      const colorField = make('div', { className: 'field' });
      colorField.appendChild(make('label', { text: '变色目标（仅变色牌）', attrs: { for: 'cc-wild-color-select' } }));
      const wildSel = /** @type {HTMLSelectElement} */ (make('select', { attrs: { id: 'cc-wild-color-select', name: 'color' } }));
      for (const c of colors) wildSel.appendChild(make('option', { text: String(c), attrs: { value: String(c) } }));
      colorField.appendChild(wildSel);
      const syncWild = () => {
        colorField.hidden = !String(cardSel.value).startsWith('变色');
      };
      syncWild();
      cardSel.addEventListener('change', syncWild);
      row.appendChild(colorField);
      playForm.appendChild(row);

      const callLabel = make('label', { className: 'checkbox-row', attrs: { for: 'cc-call-checkbox' } });
      const callBox = /** @type {HTMLInputElement} */ (make('input', { attrs: { id: 'cc-call-checkbox', name: 'call', type: 'checkbox' } }));
      callBox.checked = Array.isArray(vt.you?.hand) && vt.you.hand.length === 2;
      callLabel.appendChild(callBox);
      callLabel.appendChild(make('span', { text: '出牌后只剩 1 张时喊「最后一张」' }));
      playForm.appendChild(callLabel);

      const actRow = make('div', { className: 'form-actions' });
      const playBtn = make('button', { className: 'btn btn-primary', text: '出牌', attrs: { type: 'submit' } });
      playBtn.disabled = !writable;
      actRow.appendChild(playBtn);
      if (actions.includes('draw')) {
        const drawBtn = make('button', { className: 'btn btn-secondary', text: '摸一张', attrs: { type: 'button' } });
        drawBtn.disabled = !writable;
        drawBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'draw' } }, '已摸一张牌。');
        });
        actRow.appendChild(drawBtn);
      }
      if (actions.includes('pass')) {
        const passBtn = make('button', { className: 'btn btn-secondary', text: '过回合', attrs: { type: 'button' } });
        passBtn.disabled = !writable;
        passBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'pass' } }, '已过回合。');
        });
        actRow.appendChild(passBtn);
      }
      playForm.appendChild(actRow);

      playForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const chosen = cardSel.value;
        /** @type {Record<string, unknown>} */
        const input = { action: 'play', card: chosen, call: callBox.checked };
        if (chosen.startsWith('变色')) input.color = wildSel.value;
        void submitCityAction({ type: 'game_act', table_id: vt.id, input }, `已打出 ${chosen}。`);
      });
      venueTodoBox.appendChild(playForm);
    } else {
      const row = make('div', { className: 'form-actions' });
      if (actions.includes('draw')) {
        const drawBtn = make('button', { className: 'btn btn-primary', text: '摸一张', attrs: { type: 'button' } });
        drawBtn.disabled = !writable;
        drawBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'draw' } }, '已摸一张牌。');
        });
        row.appendChild(drawBtn);
      }
      if (actions.includes('pass')) {
        const passBtn = make('button', { className: 'btn btn-secondary', text: '过回合', attrs: { type: 'button' } });
        passBtn.disabled = !writable;
        passBtn.addEventListener('click', () => {
          void submitCityAction({ type: 'game_act', table_id: vt.id, input: { action: 'pass' } }, '已过回合。');
        });
        row.appendChild(passBtn);
      }
      venueTodoBox.appendChild(row);
    }
  }
}

/**
 * @param {Record<string, any>} v
 * @param {boolean} writable
 */
function renderAuctionCard(v, writable) {
  const canList = Array.isArray(v.can) ? v.can : [];
  const auctions = Array.isArray(v.here?.auctions) ? v.here.auctions : [];
  const showAuction = canList.includes('auction_bid') || auctions.length > 0;
  sceneAuctionCard.hidden = !showAuction;
  if (!showAuction) {
    state.auctionSignature = '';
    state.knownAuctionIds = '';
    state.recentAuctions = null;
    return;
  }
  auctionRefreshBtn.disabled = !writable || !canList.includes('auction_view');

  const idsKey = auctions.map((/** @type {any} */ x) => String(x.id)).join(',');
  const rolledOver = Boolean(state.knownAuctionIds && idsKey && state.knownAuctionIds !== idsKey);
  state.knownAuctionIds = idsKey;
  if (rolledOver) {
    state.recentAuctions = null;
    showNotice('旧物密封竞拍会已切换至新场次，可对新拍品密封出价。');
  }

  for (const auc of auctions) {
    const countNode = sceneAuctionsList.querySelector(`[data-auc-count="${CSS.escape(String(auc.id))}"]`);
    if (countNode) countNode.textContent = `当前密封出价：${Number(auc.bid_count || 0)} 份`;
  }

  const sig = JSON.stringify({
    w: writable,
    a: auctions.map((/** @type {any} */ x) => [x.id, x.my_bid_yen ?? null, x.reserve_yen, x.closes_at_ms]),
  });
  const focusWasInside = sceneAuctionsList.contains(document.activeElement);
  if (sig !== state.auctionSignature || !focusWasInside) {
    state.auctionSignature = sig;
    sceneAuctionsList.replaceChildren();
    if (auctions.length === 0) {
      sceneAuctionsList.appendChild(make('li', { className: 'muted small-note', text: '当前场次准备中，请稍候或点击「查看场次记录」。' }));
    } else {
      for (const auc of auctions) {
        const li = make('li', { className: 'entity-item' });
        const meta = make('div', { className: 'entity-meta' });
        meta.appendChild(make('strong', { text: String(auc.item_name || auc.id) }));
        meta.appendChild(
          make('span', {
            className: 'muted small-note',
            text: `起拍价 ${fmtYen(auc.reserve_yen)} · 截标 ${fmtClock(auc.closes_at_ms, state.timezone)}`,
          }),
        );
        meta.appendChild(
          make('span', {
            className: 'muted small-note',
            text: `当前密封出价：${Number(auc.bid_count || 0)} 份`,
            attrs: { 'data-auc-count': String(auc.id) },
          }),
        );
        li.appendChild(meta);

        if (typeof auc.my_bid_yen === 'number') {
          li.appendChild(
            make('span', {
              className: 'badge badge-ok',
              text: `已密封出价 ${fmtYen(auc.my_bid_yen)}`,
            }),
          );
        } else {
          const bidForm = make('form', { className: 'stack-form', attrs: { novalidate: '', 'data-auction-form': String(auc.id) } });
          const inputId = `auction-bid-input-${String(auc.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const errId = `auction-bid-error-${String(auc.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const field = make('div', { className: 'field' });
          field.appendChild(
            make('label', {
              text: `密封出价（至少 ${fmtYen(auc.reserve_yen)} 整数）`,
              attrs: { for: inputId },
            }),
          );
          const bidInput = /** @type {HTMLInputElement} */ (
            make('input', {
              attrs: {
                id: inputId,
                name: 'yen',
                type: 'text',
                inputmode: 'numeric',
                enterkeyhint: 'send',
                autocomplete: 'off',
                autocorrect: 'off',
                autocapitalize: 'none',
                spellcheck: 'false',
                required: '',
                placeholder: String(auc.reserve_yen),
                'aria-invalid': 'false',
                'data-error': errId,
              },
            })
          );
          const errEl = make('p', { className: 'field-error', attrs: { id: errId } });
          errEl.hidden = true;
          field.appendChild(bidInput);
          field.appendChild(errEl);
          bidForm.appendChild(field);

          const bidBtn = make('button', {
            className: 'btn btn-primary',
            text: '提交密封出价',
            attrs: { type: 'submit' },
          });
          bidBtn.disabled = !writable || !canList.includes('auction_bid');
          bidForm.appendChild(bidBtn);

          bidInput.addEventListener('input', () => setFieldError(errEl, bidInput, ''));
          bidForm.addEventListener('submit', (ev) => {
            ev.preventDefault();
            const raw = bidInput.value.trim();
            if (!/^\d+$/.test(raw)) {
              setFieldError(errEl, bidInput, `请输入不少于 ${auc.reserve_yen} 的正整数日元。`);
              bidInput.focus();
              return;
            }
            const yen = Number.parseInt(raw, 10);
            if (!Number.isSafeInteger(yen) || yen < Number(auc.reserve_yen || 1) || yen <= 0) {
              setFieldError(errEl, bidInput, `出价不得低于起拍价 ${fmtYen(auc.reserve_yen)}。`);
              bidInput.focus();
              return;
            }
            void submitCityAction(
              { type: 'auction_bid', auction_id: auc.id, yen },
              `已提交密封出价 ${fmtYen(yen)}，资金已冻结托管至开标。`,
            );
          });
          li.appendChild(bidForm);
        }
        sceneAuctionsList.appendChild(li);
      }
      if (rolledOver && focusWasInside) {
        const nextInput = /** @type {HTMLElement | null} */ (sceneAuctionsList.querySelector('input, button'));
        if (nextInput) nextInput.focus();
      }
    }
  }

  if (Array.isArray(state.recentAuctions) && state.recentAuctions.length > 0) {
    auctionHistoryBox.hidden = false;
    auctionHistoryList.replaceChildren();
    for (const h of state.recentAuctions) {
      const li = make('li', { className: 'entity-item' });
      const statusMap = { open: '竞拍中', settled: '已成交', unsold: '流拍', cancelled: '已取消' };
      const stLabel = statusMap[/** @type {keyof typeof statusMap} */ (h.status)] || String(h.status);
      const mineTxt = h.my_bid ? ` · 我的出价 ${fmtYen(h.my_bid.yen)}（${h.my_bid.status}）` : '';
      const winTxt = h.status === 'settled' ? ` · 成交价 ${fmtYen(h.winning_price ?? 0)}` : '';
      li.appendChild(
        make('span', {
          className: 'small-note',
          text: `${h.item_name} · ${stLabel}${winTxt} · 共 ${Number(h.bid_count || 0)} 份出价${mineTxt}`,
        }),
      );
      auctionHistoryList.appendChild(li);
    }
  } else {
    auctionHistoryBox.hidden = true;
  }
}

function renderHeaderAndControl() {
  const v = state.view;
  if (v?.local_time) {
    headerClock.textContent = `灯都时间 ${v.local_time}（${state.timezone}）`;
  } else if (state.publicView?.local_time) {
    headerClock.textContent = `灯都时间 ${state.publicView.local_time}（${state.timezone}）`;
  } else {
    headerClock.textContent = `灯都持续世界（${state.timezone}）`;
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

/**
 * 绘制街区专属微缩建筑剪影（纯 SVG DOM，零外部资源与零内联 style）。
 * @param {string} areaKey
 */
function renderWindowSilhouette(areaKey) {
  if (state.renderedSilhouetteArea === areaKey) return;
  state.renderedSilhouetteArea = areaKey;
  const g = document.getElementById('window-silhouette');
  if (!g) return;
  g.replaceChildren();
  // 地面基底
  g.appendChild(makeSvg('rect', { x: 0, y: 96, width: 280, height: 32 }));

  if (areaKey === 'hiwatari') {
    // 绯渡：澪川铁桥桁架与商店街屋檐
    g.appendChild(makeSvg('path', { d: 'M8 96 L36 62 L68 96 L100 62 L132 96 L164 62 L196 96 Z' }));
    g.appendChild(makeSvg('rect', { x: 204, y: 60, width: 58, height: 36 }));
    g.appendChild(makeSvg('rect', { x: 216, y: 74, width: 14, height: 12, class: 'win-lamp' }));
  } else if (areaKey === 'kagamiike') {
    // 镜池：南镜池公园树影与中层楼宇、喫茶灯窗
    g.appendChild(makeSvg('rect', { x: 22, y: 44, width: 44, height: 52 }));
    g.appendChild(makeSvg('circle', { cx: 96, cy: 76, r: 16 }));
    g.appendChild(makeSvg('circle', { cx: 122, cy: 74, r: 18 }));
    g.appendChild(makeSvg('rect', { x: 152, y: 50, width: 50, height: 46 }));
    g.appendChild(makeSvg('rect', { x: 210, y: 60, width: 48, height: 36 }));
    g.appendChild(makeSvg('rect', { x: 166, y: 72, width: 16, height: 14, class: 'win-lamp' }));
  } else if (areaKey === 'transit') {
    // 行车途中：架线柱与远景屋脊掠影
    g.appendChild(makeSvg('rect', { x: 52, y: 34, width: 4, height: 62 }));
    g.appendChild(makeSvg('rect', { x: 46, y: 42, width: 22, height: 3 }));
    g.appendChild(makeSvg('rect', { x: 196, y: 34, width: 4, height: 62 }));
    g.appendChild(makeSvg('rect', { x: 190, y: 42, width: 22, height: 3 }));
    g.appendChild(makeSvg('rect', { x: 92, y: 68, width: 42, height: 28 }));
    g.appendChild(makeSvg('rect', { x: 140, y: 58, width: 38, height: 38 }));
    g.appendChild(makeSvg('rect', { x: 150, y: 72, width: 10, height: 10, class: 'win-lamp' }));
  } else {
    // 千灯：西口钟塔天际线与南口跨线露台
    g.appendChild(makeSvg('rect', { x: 20, y: 36, width: 34, height: 60 }));
    g.appendChild(makeSvg('rect', { x: 60, y: 28, width: 38, height: 68 }));
    g.appendChild(makeSvg('rect', { x: 106, y: 46, width: 34, height: 50 }));
    g.appendChild(makeSvg('rect', { x: 146, y: 76, width: 118, height: 6 }));
    g.appendChild(makeSvg('rect', { x: 214, y: 44, width: 44, height: 52 }));
    g.appendChild(makeSvg('rect', { x: 70, y: 44, width: 10, height: 10, class: 'win-lamp' }));
    g.appendChild(makeSvg('rect', { x: 226, y: 60, width: 12, height: 12, class: 'win-lamp' }));
  }
}

/**
 * 渲染车门上方克制液晶到站牌 + 实时天气×昼夜微缩窗景。
 */
function renderCommuterDeck() {
  const v = state.view;
  if (!v) return;
  const writable = canControl();
  const canList = Array.isArray(v.can) ? v.can : [];
  const inTransit = Boolean(v.location?.in_transit && v.location?.trip);
  const { tod, label: todLabel, hhmm } = parseTimeOfDay(v.local_time);

  const codeEl = mustEl('lcd-station-code');
  const kickerEl = mustEl('lcd-state-kicker');
  const titleEl = mustEl('lcd-main-title');
  const clockEl = mustEl('lcd-clock');
  const etaEl = mustEl('lcd-eta');
  const lineLabelEl = mustEl('lcd-line-label');
  const stampPill = mustEl('lcd-stamp-pill');
  const stopsTrack = mustEl('lcd-stops-track');
  const winFrame = mustEl('window-frame');
  const winCaption = mustEl('window-cutout-caption');

  clockEl.textContent = `JST ${hhmm}`;

  if (inTransit) {
    const trip = v.location.trip;
    const legs = Array.isArray(trip.legs) ? trip.legs : [];
    const curLeg = legs.find((/** @type {any} */ l) => Number(l.n) === Number(trip.leg_index)) || legs[0] || {};
    const destMeta = stationMetaFor(curLeg.to || trip.to);
    lcdBoard.setAttribute('data-line', lineKeyOf(curLeg.line, curLeg.mode));
    codeEl.textContent = destMeta.code;
    kickerEl.textContent = `次駅・運行中 · 第 ${Number(curLeg.n ?? 0) + 1}/${Math.max(1, legs.length)} 段`;
    titleEl.textContent = `前往 ${friendlyPlaceLabel(curLeg.to || trip.to)}`;
    etaEl.textContent = `预计 ${fmtClock(trip.ends_at_ms, state.timezone)} 到 · ${fmtYen(trip.fare_yen)}`;
    lineLabelEl.textContent = `${curLeg.mode === 'train' ? curLeg.line || '铁道运行' : '站间步行连络'} · 全程终点：${friendlyPlaceLabel(trip.to)}`;
    stampPill.hidden = true;
    lcdStampBtn.hidden = true;

    stopsTrack.replaceChildren();
    for (const leg of legs) {
      const active = Number(leg.n) === Number(trip.leg_index);
      const seg = `${friendlyPlaceLabel(leg.from)} → ${friendlyPlaceLabel(leg.to)}`;
      stopsTrack.appendChild(
        make('li', {
          className: active ? 'lcd-stop-item lcd-stop-active' : 'lcd-stop-item',
          text: active ? `▶ ${seg}（${leg.minutes}分）` : seg,
        }),
      );
    }
    stopsTrack.hidden = legs.length === 0;

    const pubArea = Array.isArray(state.publicView?.areas)
      ? state.publicView.areas.find((/** @type {any} */ a) => a.id === destMeta.area)
      : null;
    const { sky, summary } = resolveWindowSky(pubArea?.weather);
    winFrame.setAttribute('data-tod', tod);
    winFrame.setAttribute('data-sky', sky);
    winFrame.setAttribute('data-area', 'transit');
    renderWindowSilhouette('transit');
    winCaption.textContent = `车窗掠影（往 ${destMeta.name}） · ${todLabel} · ${summary}`;
    return;
  }

  stopsTrack.hidden = true;
  stopsTrack.replaceChildren();
  const p = v.here?.place || {};
  const stMeta = stationMetaFor(p.area || p.id);
  lcdBoard.setAttribute('data-line', stMeta.lineKey);
  codeEl.textContent = stMeta.code;
  kickerEl.textContent = p.type === 'station' ? `ただいま停車中 · ${stMeta.name}大厅` : `${stMeta.name}圈 · 街区漫步`;
  titleEl.textContent = String(p.name || p.id || '未知地点');
  const sb = v.stamp_book;
  etaEl.textContent = sb ? `站章 ${sb.collected}/${sb.total}` : '';
  lineLabelEl.textContent = `${stMeta.lineSummary} · ${p.open ? `开放中（${p.hours || '全天'}）` : `休息中（${p.hours || ''}）`}`;

  const canStamp = canList.includes('stamp_station');
  if (canStamp) {
    const stamped = Boolean(sb?.here_stamped);
    stampPill.hidden = false;
    stampPill.textContent = stamped ? '本站已盖章 ✓' : '站章台开放';
    lcdStampBtn.hidden = false;
    lcdStampBtn.textContent = stamped ? '重盖留念' : '盖本站纪念章';
    lcdStampBtn.disabled = !writable;
  } else {
    stampPill.hidden = true;
    lcdStampBtn.hidden = true;
  }

  const { sky, summary } = resolveWindowSky(v.here?.weather);
  const areaKey = String(p.area || stMeta.area);
  winFrame.setAttribute('data-tod', tod);
  winFrame.setAttribute('data-sky', sky);
  winFrame.setAttribute('data-area', areaKey);
  renderWindowSilhouette(areaKey);
  winCaption.textContent = `${stMeta.name.replace(/站$/, '')}窗景 · ${todLabel} · ${summary}`;
}

/**
 * 绘制二维三站铁道拓扑 SVG（仅高亮当前居民本人所在站或在途电车段，附本人已集站章朱印点）。
 * @param {SVGSVGElement} svgEl
 */
function renderRailTopologyInto(svgEl) {
  svgEl.replaceChildren();
  const v = state.view;
  const inTransit = Boolean(v?.location?.in_transit && v?.location?.trip);
  const trip = inTransit ? v?.location?.trip : null;
  const legs = Array.isArray(trip?.legs) ? trip.legs : [];
  const curLeg = trip ? legs.find((/** @type {any} */ l) => Number(l.n) === Number(trip.leg_index)) : null;
  const currentArea = !inTransit && v?.here?.place?.area ? String(v.here.place.area) : null;
  const activeTargetPlace = curLeg ? String(curLeg.to || '') : null;

  const stampedStationIds = new Set(
    (state.stampBook?.stamps || [])
      .filter((s) => Boolean(s.collected))
      .map((s) => String(s.station_id)),
  );
  if (v?.stamp_book?.here_stamped && currentArea) {
    stampedStationIds.add(stationMetaFor(currentArea).id);
  }

  for (const edge of RAIL_EDGES) {
    const isActiveEdge =
      Boolean(curLeg && curLeg.mode === 'train') &&
      ((edge.fromPlace === curLeg.from && edge.toPlace === curLeg.to) ||
        (edge.fromPlace === curLeg.to && edge.toPlace === curLeg.from));
    const edgeClass = inTransit && curLeg?.mode === 'train'
      ? isActiveEdge
        ? `${edge.className} rail-edge-active`
        : `${edge.className} rail-edge-dim`
      : edge.className;
    svgEl.appendChild(makeSvg('path', { d: edge.d, class: edgeClass }));
    svgEl.appendChild(makeSvg('text', { x: edge.lx, y: edge.ly, 'text-anchor': 'middle', class: 'rail-label' }, edge.label));
  }

  for (const st of RAIL_STATIONS) {
    const isHere = st.area === currentArea || st.placeId === activeTargetPlace;
    const g = makeSvg('g', { transform: `translate(${st.x},${st.y})` });
    if (isHere) {
      g.appendChild(makeSvg('circle', { r: 20, class: 'rail-breathe-ring' }));
    }
    g.appendChild(makeSvg('circle', { r: 14, class: isHere ? 'station-node station-node-active' : 'station-node' }));
    g.appendChild(makeSvg('text', { y: 4, 'text-anchor': 'middle', class: 'rail-label' }, st.code));
    if (stampedStationIds.has(st.id)) {
      g.appendChild(makeSvg('circle', { cx: 12, cy: -11, r: 4.5, class: 'station-stamp-dot' }));
    }
    g.appendChild(
      makeSvg('text', { y: st.labelDy, 'text-anchor': 'middle', class: 'station-title' }, st.name),
    );
    svgEl.appendChild(g);
  }
}

function renderTravelTopology() {
  renderRailTopologyInto(mustSvg('rail-topology-svg'));
  const overviewSvg = document.getElementById('overview-rail-svg');
  if (overviewSvg && String(overviewSvg.tagName || '').toLowerCase() === 'svg') {
    renderRailTopologyInto(/** @type {SVGSVGElement} */ (/** @type {unknown} */ (overviewSvg)));
  }
  const statusEl = mustEl('travel-topology-status');
  const v = state.view;
  if (v?.location?.in_transit && v?.location?.trip) {
    statusEl.textContent = `运行区间高亮：前往 ${friendlyPlaceLabel(v.location.trip.to)}（仅显示本人状态）`;
  } else if (v?.here?.place) {
    const st = stationMetaFor(v.here.place.area);
    statusEl.textContent = `当前呼吸高亮：${st.name} · 已集站章 ${v.stamp_book?.collected ?? 0}/${v.stamp_book?.total ?? RAIL_STATIONS.length}`;
  }

  const quickBar = mustEl('station-quick-bar');
  quickBar.replaceChildren();
  const currentPlace = v?.here?.place?.id ? String(v.here.place.id) : '';
  if (!currentPlace) return;
  for (const st of RAIL_STATIONS) {
    if (st.placeId === currentPlace) continue;
    const btn = make('button', {
      className: 'btn btn-ghost btn-compact',
      text: `试算 → ${st.name}`,
      attrs: { type: 'button' },
    });
    btn.addEventListener('click', () => void showRoutePreview(currentPlace, st.placeId));
    quickBar.appendChild(btn);
  }
}

/**
 * 绘制站章几何纹章 SVG（纯确定性矢量，色彩走 CSS class，严格兼容 CSP style-src 'self'）。
 * @param {string} emblem
 * @param {string} areaId
 * @param {boolean} collected
 * @returns {SVGSVGElement}
 */
function buildStampEmblemSvg(emblem, areaId, collected) {
  const inkClass = collected ? `stamp-seal-svg stamp-ink-${areaId}` : 'stamp-seal-svg stamp-ink-empty';
  const svg = /** @type {SVGSVGElement} */ (
    makeSvg('svg', { viewBox: '0 0 48 48', class: inkClass, 'aria-hidden': 'true' })
  );
  svg.appendChild(
    makeSvg('circle', {
      cx: 24,
      cy: 24,
      r: 21,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': collected ? 2.5 : 1.5,
      ...(collected ? {} : { 'stroke-dasharray': '3 3' }),
    }),
  );
  if (!collected) {
    svg.appendChild(makeSvg('circle', { cx: 24, cy: 24, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }));
    return svg;
  }
  svg.appendChild(makeSvg('circle', { cx: 24, cy: 24, r: 17.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
  if (emblem === 'book-nib') {
    /* legacy alias */
  }
  if (emblem === 'books' || emblem === 'book-nib') {
    // 摊开的书页与钢笔尖
    svg.appendChild(makeSvg('path', { d: 'M13 30 L24 27 L35 30 L35 18 L24 15 L13 18 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('line', { x1: 24, y1: 15, x2: 24, y2: 33, stroke: 'currentColor', 'stroke-width': 2 }));
  } else if (emblem === 'stage' || emblem === 'theatre-mask') {
    // 小剧场拱门与星芒
    svg.appendChild(makeSvg('path', { d: 'M15 32 L15 20 A9 9 0 0 1 33 20 L33 32 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('circle', { cx: 24, cy: 23, r: 3, fill: 'currentColor' }));
  } else if (emblem === 'bridge' || emblem === 'torii-gate') {
    // 绯渡：澪川铁桥桁架
    svg.appendChild(makeSvg('path', { d: 'M12 30 L18 18 L24 30 L30 18 L36 30', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('line', { x1: 11, y1: 31, x2: 37, y2: 31, stroke: 'currentColor', 'stroke-width': 2 }));
  } else if (emblem === 'owl' || emblem === 'owl-lamp') {
    // 镜池：猫头鹰双眸
    svg.appendChild(makeSvg('circle', { cx: 19, cy: 23, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('circle', { cx: 29, cy: 23, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('polygon', { points: '24,26 21,31 27,31', fill: 'currentColor' }));
  } else {
    // 千灯：双塔与跨线桥
    svg.appendChild(makeSvg('rect', { x: 15, y: 15, width: 7, height: 17, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('rect', { x: 26, y: 13, width: 7, height: 19, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
  }
  return svg;
}

function renderStampBook() {
  const badge = mustEl('stamp-book-badge');
  const list = mustEl('stamp-book-list');
  const summary = state.stampBook || state.view?.stamp_book;
  badge.textContent = `${summary?.collected ?? 0} / ${summary?.total ?? RAIL_STATIONS.length} 枚`;
  badge.className = summary && summary.collected > 0 ? 'badge badge-ok' : 'badge';

  list.replaceChildren();
  const entries = Array.isArray(state.stampBook?.stamps)
    ? state.stampBook.stamps
    : RAIL_STATIONS.map((st) => ({
        station_id: st.id,
        station_name: st.name,
        area: st.area,
        title: st.stampTitle,
        motif: `${st.name}纪念站章`,
        emblem: st.area === 'hiwatari' ? 'bridge' : st.area === 'kagamiike' ? 'owl' : 'terrace',
        collected: false,
        stamped_at_ms: null,
      }));

  for (const s of entries) {
    const collected = Boolean(s.collected);
    const li = make('li', { className: collected ? 'stamp-slot stamp-slot-collected' : 'stamp-slot' });
    li.appendChild(buildStampEmblemSvg(String(s.emblem || ''), String(s.area || 'sentou'), collected));
    const meta = make('div', { className: 'entity-meta' });
    meta.appendChild(make('strong', { text: String(s.title || s.station_name) }));
    meta.appendChild(
      make('span', {
        className: 'muted small-note',
        text: collected
          ? `已盖章 · ${fmtClock(s.stamped_at_ms, state.timezone)} · ${s.motif || ''}`
          : `${s.station_name}大厅可盖章`,
      }),
    );
    li.appendChild(meta);
    list.appendChild(li);
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
    enterSubmitBtn.textContent = '回到灯都';
  } else {
    enterWelcomeText.textContent = `你好，${state.principal?.display_name ?? '旅人'}。请起一个城内显示名并选择首次进城车站。`;
    enterNameField.hidden = false;
    enterNameInput.required = true;
    if (!enterNameInput.value && state.principal?.display_name) {
      enterNameInput.value = state.principal.display_name.slice(0, 16);
    }
    enterStationFieldset.hidden = false;
    enterSubmitBtn.textContent = '领取启动日元并进入灯都';
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
  const stampBar = mustEl('scene-stamp-bar');
  const stampTitle = mustEl('scene-stamp-title');
  const stampDesc = mustEl('scene-stamp-desc');
  const eventsBox = mustEl('scene-events');
  const peopleList = mustEl('scene-people-list');
  const shopCard = mustEl('scene-shop-card');
  const goodsList = mustEl('scene-goods-list');
  const chatList = mustEl('chat-list');

  if (inTransit) {
    const trip = v.location.trip;
    transitBanner.hidden = false;
    transitBanner.textContent = `正在前往 ${friendlyPlaceLabel(trip.to)}（预计 ${fmtClock(trip.ends_at_ms, state.timezone)} 到达，共 ${trip.minutes} 分钟，车费 ${fmtYen(trip.fare_yen)}）`;
    titleEl.textContent = '在途中';
    openBadge.textContent = '移动中';
    openBadge.className = 'badge badge-warn';
    blurbEl.textContent = '你正在步行或乘坐电车途中。到站后将自动刷新现场视图。';
    weatherEl.textContent = '移动期间暂不能与地点商品或储物柜交互。';
    stampBar.hidden = true;
    eventsBox.hidden = true;
    peopleList.replaceChildren(make('li', { className: 'muted small-note', text: '到站后可见身边同行者。' }));
    shopCard.hidden = true;
    sceneVenueCard.hidden = true;
    sceneAuctionCard.hidden = true;
    state.venueTodoSignature = '';
    state.auctionSignature = '';
    state.knownAuctionIds = '';
    state.recentAuctions = null;
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

  const canList = Array.isArray(v.can) ? v.can : [];
  if (canList.includes('stamp_station')) {
    const stMeta = stationMetaFor(p.area || p.id);
    const hereStamped = Boolean(v.stamp_book?.here_stamped);
    stampBar.hidden = false;
    stampTitle.textContent = stMeta.stampTitle;
    stampDesc.textContent = hereStamped
      ? `已收录进个人车站印章帐（进度 ${v.stamp_book?.collected ?? 1}/${v.stamp_book?.total ?? RAIL_STATIONS.length}，重复加盖幂等且不占背包）`
      : `站在${stMeta.name}大厅可免费加盖本站纪念章（进度 ${v.stamp_book?.collected ?? 0}/${v.stamp_book?.total ?? RAIL_STATIONS.length}）`;
    sceneStampBtn.textContent = hereStamped ? '再次加盖留念' : '盖下本站纪念章';
    sceneStampBtn.disabled = !writable;
  } else {
    stampBar.hidden = true;
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

  renderVenueCard(v, writable);
  renderAuctionCard(v, writable);

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
  renderTravelTopology();
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

  renderStampBook();
}

function renderOverview() {
  const pub = state.publicView;
  if (!pub) return;
  const overviewSvg = document.getElementById('overview-rail-svg');
  if (overviewSvg && String(overviewSvg.tagName || '').toLowerCase() === 'svg') {
    renderRailTopologyInto(/** @type {SVGSVGElement} */ (/** @type {unknown} */ (overviewSvg)));
  }
  const areaList = Array.isArray(pub.areas) ? pub.areas : [];
  mustEl('overview-summary').textContent = `目录版本 ${pub.city_catalog_version} · 开放街区 ${areaList.length} 片 · 票价规则 ${pub.transit?.rule_version ?? ''}（模拟运价）`;

  const writable = canControl();
  const currentPlace = state.view?.here?.place?.id ? String(state.view.here.place.id) : '';

  const areasBox = mustEl('overview-areas');
  areasBox.replaceChildren();
  for (const a of areaList) {
    const card = make('article', { className: 'card' });
    card.appendChild(make('h3', { text: a.ward ? `${a.name}（${a.ward}）` : String(a.name || a.id) }));
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
      // 严格信息对等：仅展示公开场所属性、营业时段与虚构标识，绝不渲染非本人所在地的其他居民姓名
      const li = make('li', { className: 'entity-item' });
      const meta = make('div', { className: 'entity-meta' });
      const kindTag = p.fictional ? '虚构店铺' : '公共空间';
      meta.appendChild(make('strong', { text: `${p.name}（${p.open ? '开放' : '关闭'} · ${p.hours}）` }));
      meta.appendChild(
        make('span', {
          className: 'muted small-note',
          text: `${kindTag}${p.blurb ? ` · ${p.blurb}` : ''}`,
        }),
      );
      li.appendChild(meta);
      if (currentPlace && p.id && p.id !== currentPlace) {
        const actions = make('div', { className: 'entity-actions' });
        const routeBtn = make('button', { className: 'btn btn-ghost btn-compact', text: '路线试算', attrs: { type: 'button' } });
        routeBtn.addEventListener('click', () => {
          activateTab('tab-travel', false);
          void showRoutePreview(currentPlace, String(p.id));
        });
        actions.appendChild(routeBtn);
        if (p.open) {
          const goBtn = make('button', { className: 'btn btn-secondary btn-compact', text: '前往', attrs: { type: 'button' } });
          goBtn.disabled = !writable;
          goBtn.addEventListener('click', async () => {
            const ok = await submitCityAction({ type: 'travel', to: p.id }, `已动身前往 ${p.name}。`);
            if (ok) activateTab('tab-scene', false);
          });
          actions.appendChild(goBtn);
        }
        li.appendChild(actions);
      }
      ul.appendChild(li);
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
  renderCommuterDeck();
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
    state.stampBook = null;
    stopRealtime();
    return;
  }
  state.csrfToken = String(sess.csrf_token || '');
  state.principal = sess.principal || null;
  state.sessionResident = sess.resident || null;
  if (state.sessionResident?.in_city) {
    await refreshMe();
    void loadStampBook();
    startRealtime();
  } else {
    state.view = null;
    state.stampBook = null;
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
      showNotice(`欢迎回到灯都，${state.sessionResident.name}。`);
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
      setFieldError(enterNameError, enterNameInput, '第一次进入灯都请填写 1～16 字的显示名。');
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
    void loadStampBook();
    startRealtime();
    if (out.granted_yen) {
      showNotice(`欢迎来到灯都！已发放一次性启动资金 ${fmtYen(out.granted_yen)}。`);
    } else {
      showNotice('已进入灯都。');
    }
  } catch (e) {
    if (e instanceof ApiError && (e.reason === 'name_required' || e.reason === 'name_taken')) {
      setFieldError(enterNameError, enterNameInput, e.message);
      enterNameInput.focus();
    } else {
      showError(e instanceof ApiError ? e.message : '进入灯都失败');
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
    showNotice('已暂离灯都休息。随身日元、物品与储物柜均已保留。');
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
  state.stampBook = null;
  renderApp();
  showNotice('已安全退出登录。');
});

async function handleStampStation() {
  await submitCityAction({ type: 'stamp_station' }, '已在车站印章帐盖下本站纪念章。');
}

lcdStampBtn.addEventListener('click', () => void handleStampStation());
sceneStampBtn.addEventListener('click', () => void handleStampStation());

// WCAG 2.2.2 动效暂停控制（文案切换为「恢复动效 / 暂停动效」，不设按压态布尔属性以避免读屏双重播报冲突）
toggleMotionBtn.addEventListener('click', () => {
  state.motionPaused = !state.motionPaused;
  const docRoot = document.documentElement;
  if (state.motionPaused) {
    if (docRoot) docRoot.setAttribute('data-motion', 'paused');
    toggleMotionBtn.textContent = '恢复动效';
  } else {
    if (docRoot) docRoot.removeAttribute('data-motion');
    toggleMotionBtn.textContent = '暂停动效';
  }
});

refreshHistoryBtn.addEventListener('click', () => void loadHistory(true));
moreHistoryBtn.addEventListener('click', () => void loadHistory(false));
bagPrevBtn.addEventListener('click', () => stepBagPage(-1));
bagNextBtn.addEventListener('click', () => stepBagPage(1));
lockerPrevBtn.addEventListener('click', () => stepLockerPage(-1));
lockerNextBtn.addEventListener('click', () => stepLockerPage(1));

venueOpenForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const checked = /** @type {HTMLInputElement | null} */ (venueOpenForm.querySelector('input[name="venue_game"]:checked'));
  const game = checked ? checked.value : 'liars_dice';
  await submitCityAction({ type: 'open_table', game }, `已开出【${venueGameLabel(game)}】牌桌。`);
});

venueStartBtn.addEventListener('click', () => {
  const tableId = venueStartBtn.dataset.tableId || '';
  void submitCityAction({ type: 'start_table', ...(tableId ? { table_id: tableId } : {}) }, '牌局已开始。');
});

venueLeaveBtn.addEventListener('click', () => {
  void submitCityAction({ type: 'leave_table' }, '已离开当前牌桌。');
});

auctionRefreshBtn.addEventListener('click', async () => {
  const out = await submitCityAction({ type: 'auction_view' });
  if (out && Array.isArray(out.auctions)) {
    state.recentAuctions = out.auctions;
    if (state.view) renderAuctionCard(state.view, canControl());
  }
});

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
    state.timezone = String(cfg.world?.timezone || 'JST');
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
