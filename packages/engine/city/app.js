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
 * @param {string} id
 * @returns {SVGSVGElement}
 */
function mustSvg(id) {
  const el = document.getElementById(id);
  if (!el || !(el instanceof SVGSVGElement)) throw new Error(`Missing SVG #${id}`);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @param {string} [text]
 * @returns {SVGElement}
 */
function makeSvg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
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
  /** @type {{ collected: number; total: number; stamps: Array<Record<string, any>> } | null} */
  stampBook: null,
  motionPaused: false,
  renderedSilhouetteArea: '',
  /** @type {number | null} */
  historyNext: null,
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

// ───────────────────────── 五站铁道拓扑与印章常量 ─────────────────────────

/**
 * @typedef {{
 *   id: string;
 *   placeId: string;
 *   area: string;
 *   code: string;
 *   name: string;
 *   ward: string;
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
    id: 'st:akabane',
    placeId: 'akabane:station',
    area: 'akabane',
    code: 'AK',
    name: '赤羽站',
    ward: '北区',
    lineKey: 'saikyo',
    lineSummary: 'JR 埼京线',
    stampTitle: '赤羽站 · 荒川铁桥与一番街',
    x: 118,
    y: 54,
    labelDy: 31,
  },
  {
    id: 'st:ikebukuro',
    placeId: 'ikebukuro:station',
    area: 'ikebukuro',
    code: 'IK',
    name: '池袋站',
    ward: '丰岛区',
    lineKey: 'yamanote',
    lineSummary: 'JR 山手线 · 埼京线',
    stampTitle: '池袋站 · 猫头鹰与书影',
    x: 266,
    y: 116,
    labelDy: 32,
  },
  {
    id: 'st:shinjuku',
    placeId: 'shinjuku:station',
    area: 'shinjuku',
    code: 'SJ',
    name: '新宿站',
    ward: '新宿区',
    lineKey: 'yamanote',
    lineSummary: 'JR 山手线 · 都营新宿线 · 小田急线',
    stampTitle: '新宿站 · 南口跨线露台与西口高楼',
    x: 392,
    y: 146,
    labelDy: 32,
  },
  {
    id: 'st:jinbocho',
    placeId: 'jinbocho:station',
    area: 'jinbocho',
    code: 'JB',
    name: '神保町站',
    ward: '千代田区',
    lineKey: 'shinjuku',
    lineSummary: '都营新宿线（距新宿 4.8km · ¥220）',
    stampTitle: '神保町站 · 靖国通古书街与钢笔尖',
    x: 566,
    y: 112,
    labelDy: 32,
  },
  {
    id: 'st:shimokitazawa',
    placeId: 'shimokitazawa:station',
    area: 'shimokitazawa',
    code: 'SK',
    name: '下北泽站',
    ward: '世田谷区',
    lineKey: 'odakyu',
    lineSummary: '小田急小田原线（距新宿 4.9km · ¥170）',
    stampTitle: '下北泽站 · 路地小剧场与绿道木叶',
    x: 252,
    y: 214,
    labelDy: 30,
  },
];

const RAIL_EDGES = [
  {
    id: 'te:akabane-ikebukuro',
    fromPlace: 'akabane:station',
    toPlace: 'ikebukuro:station',
    d: 'M 118 54 L 266 116',
    className: 'rail-saikyo',
    label: '埼京线 · 13分 · ¥200',
    lx: 176,
    ly: 100,
  },
  {
    id: 'te:akabane-shinjuku',
    fromPlace: 'akabane:station',
    toPlace: 'shinjuku:station',
    d: 'M 118 54 Q 282 14 392 146',
    className: 'rail-direct',
    label: '埼京线直达 · 19分 · ¥260',
    lx: 284,
    ly: 42,
  },
  {
    id: 'te:ikebukuro-shinjuku',
    fromPlace: 'ikebukuro:station',
    toPlace: 'shinjuku:station',
    d: 'M 266 116 L 392 146',
    className: 'rail-yamanote',
    label: '山手线 · 10分 · ¥200',
    lx: 324,
    ly: 150,
  },
  {
    id: 'te:shinjuku-jinbocho',
    fromPlace: 'shinjuku:station',
    toPlace: 'jinbocho:station',
    d: 'M 392 146 L 566 112',
    className: 'rail-shinjuku',
    label: '都营新宿线 · 11分 · ¥220',
    lx: 486,
    ly: 116,
  },
  {
    id: 'te:shinjuku-shimokitazawa',
    fromPlace: 'shinjuku:station',
    toPlace: 'shimokitazawa:station',
    d: 'M 392 146 L 252 214',
    className: 'rail-odakyu',
    label: '小田急线 · 9分 · ¥170',
    lx: 344,
    ly: 202,
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
  if (s.includes('都营新宿')) return 'shinjuku';
  if (s.includes('小田急')) return 'odakyu';
  if (s.includes('埼京')) return 'saikyo';
  return 'yamanote';
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

async function refreshMe() {
  try {
    const v = await apiCall('GET', `/me?client_id=${encodeURIComponent(state.clientId)}`);
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
    });
    if (out.view) {
      state.view = out.view;
      if (action.type === 'stamp_station' || !state.stampBook) {
        await loadStampBook();
      }
      renderApp();
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

  if (areaKey === 'jinbocho') {
    // 神保町：靖国通连排旧书店书脊招牌与暖色橱窗
    g.appendChild(makeSvg('rect', { x: 18, y: 54, width: 46, height: 42 }));
    g.appendChild(makeSvg('rect', { x: 68, y: 46, width: 52, height: 50 }));
    g.appendChild(makeSvg('rect', { x: 126, y: 58, width: 44, height: 38 }));
    g.appendChild(makeSvg('rect', { x: 176, y: 42, width: 56, height: 54 }));
    g.appendChild(makeSvg('rect', { x: 236, y: 62, width: 30, height: 34 }));
    g.appendChild(makeSvg('rect', { x: 26, y: 74, width: 12, height: 14, class: 'win-lamp' }));
    g.appendChild(makeSvg('rect', { x: 80, y: 72, width: 16, height: 16, class: 'win-lamp' }));
    g.appendChild(makeSvg('rect', { x: 190, y: 68, width: 18, height: 18, class: 'win-lamp' }));
  } else if (areaKey === 'shimokitazawa') {
    // 下北泽：低层三角坡顶小剧场、街角路灯与绿道树冠
    g.appendChild(makeSvg('polygon', { points: '24,96 24,66 56,48 88,66 88,96' }));
    g.appendChild(makeSvg('rect', { x: 98, y: 64, width: 48, height: 32 }));
    g.appendChild(makeSvg('circle', { cx: 178, cy: 76, r: 16 }));
    g.appendChild(makeSvg('circle', { cx: 204, cy: 72, r: 19 }));
    g.appendChild(makeSvg('rect', { x: 228, y: 58, width: 38, height: 38 }));
    g.appendChild(makeSvg('rect', { x: 48, y: 74, width: 14, height: 16, class: 'win-lamp' }));
    g.appendChild(makeSvg('circle', { cx: 154, cy: 66, r: 3.5, class: 'win-lamp' }));
    g.appendChild(makeSvg('rect', { x: 238, y: 72, width: 14, height: 12, class: 'win-lamp' }));
  } else if (areaKey === 'akabane') {
    // 赤羽：荒川铁桥桁架与商店街屋檐
    g.appendChild(makeSvg('path', { d: 'M8 96 L36 62 L68 96 L100 62 L132 96 L164 62 L196 96 Z' }));
    g.appendChild(makeSvg('rect', { x: 204, y: 60, width: 58, height: 36 }));
    g.appendChild(makeSvg('rect', { x: 216, y: 74, width: 14, height: 12, class: 'win-lamp' }));
  } else if (areaKey === 'ikebukuro') {
    // 池袋：南池袋公园树影与中层楼宇、喫茶灯窗
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
    // 新宿：西口高楼天际线与南口跨线露台
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
    lcdBoard.dataset.line = lineKeyOf(curLeg.line, curLeg.mode);
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
    winFrame.dataset.tod = tod;
    winFrame.dataset.sky = sky;
    winFrame.dataset.area = 'transit';
    renderWindowSilhouette('transit');
    winCaption.textContent = `车窗掠影（往 ${destMeta.name}） · ${todLabel} · ${summary}`;
    return;
  }

  stopsTrack.hidden = true;
  stopsTrack.replaceChildren();
  const p = v.here?.place || {};
  const stMeta = stationMetaFor(p.area || p.id);
  lcdBoard.dataset.line = stMeta.lineKey;
  codeEl.textContent = stMeta.code;
  kickerEl.textContent = p.type === 'station' ? `ただいま停車中 · ${stMeta.ward}车站大厅` : `${stMeta.name}圈 · ${stMeta.ward}`;
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
  winFrame.dataset.tod = tod;
  winFrame.dataset.sky = sky;
  winFrame.dataset.area = areaKey;
  renderWindowSilhouette(areaKey);
  winCaption.textContent = `${stMeta.name.replace(/站$/, '')}窗景 · ${todLabel} · ${summary}`;
}

/**
 * 绘制二维五站铁道拓扑 SVG（仅高亮当前居民本人所在站或在途电车段，附本人已集站章朱印点）。
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
      makeSvg('text', { y: st.labelDy, 'text-anchor': 'middle', class: 'station-title' }, `${st.name}（${st.ward}）`),
    );
    svgEl.appendChild(g);
  }
}

function renderTravelTopology() {
  renderRailTopologyInto(mustSvg('rail-topology-svg'));
  const overviewSvg = document.getElementById('overview-rail-svg');
  if (overviewSvg instanceof SVGSVGElement) {
    renderRailTopologyInto(overviewSvg);
  }
  const statusEl = mustEl('travel-topology-status');
  const v = state.view;
  if (v?.location?.in_transit && v?.location?.trip) {
    statusEl.textContent = `运行区间高亮：前往 ${friendlyPlaceLabel(v.location.trip.to)}（仅显示本人状态）`;
  } else if (v?.here?.place) {
    const st = stationMetaFor(v.here.place.area);
    statusEl.textContent = `当前呼吸高亮：${st.name}（${st.ward}）· 已集站章 ${v.stamp_book?.collected ?? 0}/${v.stamp_book?.total ?? 5}`;
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
    // 神保町：摊开的书页与钢笔尖
    svg.appendChild(makeSvg('path', { d: 'M13 30 L24 27 L35 30 L35 18 L24 15 L13 18 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('line', { x1: 24, y1: 15, x2: 24, y2: 33, stroke: 'currentColor', 'stroke-width': 2 }));
  } else if (emblem === 'stage' || emblem === 'theatre-mask') {
    // 下北泽：小剧场拱门与星芒
    svg.appendChild(makeSvg('path', { d: 'M15 32 L15 20 A9 9 0 0 1 33 20 L33 32 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('circle', { cx: 24, cy: 23, r: 3, fill: 'currentColor' }));
  } else if (emblem === 'bridge' || emblem === 'torii-gate') {
    // 赤羽：铁桥桁架
    svg.appendChild(makeSvg('path', { d: 'M12 30 L18 18 L24 30 L30 18 L36 30', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('line', { x1: 11, y1: 31, x2: 37, y2: 31, stroke: 'currentColor', 'stroke-width': 2 }));
  } else if (emblem === 'owl' || emblem === 'owl-lamp') {
    // 池袋：猫头鹰双眸
    svg.appendChild(makeSvg('circle', { cx: 19, cy: 23, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('circle', { cx: 29, cy: 23, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
    svg.appendChild(makeSvg('polygon', { points: '24,26 21,31 27,31', fill: 'currentColor' }));
  } else {
    // 新宿：双塔与跨线桥
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
        motif: `${st.ward}纪念站章`,
        emblem: st.area === 'jinbocho' ? 'books' : st.area === 'shimokitazawa' ? 'stage' : st.area === 'akabane' ? 'bridge' : st.area === 'ikebukuro' ? 'owl' : 'terrace',
        collected: false,
        stamped_at_ms: null,
      }));

  for (const s of entries) {
    const collected = Boolean(s.collected);
    const li = make('li', { className: collected ? 'stamp-slot stamp-slot-collected' : 'stamp-slot' });
    li.appendChild(buildStampEmblemSvg(String(s.emblem || ''), String(s.area || 'shinjuku'), collected));
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
      ? `已收录进个人车站印章帐（进度 ${v.stamp_book?.collected ?? 1}/${v.stamp_book?.total ?? 5}，重复加盖幂等且不占背包）`
      : `站在${stMeta.name}大厅可免费加盖本站纪念章（进度 ${v.stamp_book?.collected ?? 0}/${v.stamp_book?.total ?? 5}）`;
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
          const opt = make('option', {
            text: `${it.name}（×${it.qty}${it.instance ? '·具名' : ''}）`,
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
      if (it.meta?.title || it.meta?.summary) {
        meta.appendChild(make('span', { className: 'muted small-note', text: `${it.meta.title || ''} ${it.meta.summary || ''}`.trim() }));
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
      bagList.appendChild(li);
    }
  }

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
      li.appendChild(meta);

      const takeBtn = make('button', { className: 'btn btn-secondary', text: '取出 1 件', attrs: { type: 'button' } });
      takeBtn.disabled = !writable || !atLocker;
      takeBtn.addEventListener('click', () => {
        void submitCityAction({ type: 'take_locker', item_id: lk.item_id, qty: 1 }, `已从储物柜取出 ${lk.name}。`);
      });
      li.appendChild(takeBtn);
      lockerList.appendChild(li);
    }
  }

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
  if (overviewSvg instanceof SVGSVGElement) {
    renderRailTopologyInto(overviewSvg);
  }
  const areaList = Array.isArray(pub.areas) ? pub.areas : [];
  mustEl('overview-summary').textContent = `目录版本 ${pub.city_catalog_version} · 开放街区 ${areaList.length} 片 · 票价规则 ${pub.transit?.rule_version ?? ''}（模拟运价）`;

  const writable = canControl();
  const currentPlace = state.view?.here?.place?.id ? String(state.view.here.place.id) : '';

  const areasBox = mustEl('overview-areas');
  areasBox.replaceChildren();
  for (const a of areaList) {
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
    const out = await apiCall('POST', '/claim', { client_id: state.clientId });
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
  if (state.motionPaused) {
    document.documentElement.dataset.motion = 'paused';
    toggleMotionBtn.textContent = '恢复动效';
  } else {
    delete document.documentElement.dataset.motion;
    toggleMotionBtn.textContent = '暂停动效';
  }
});

refreshHistoryBtn.addEventListener('click', () => void loadHistory(true));
moreHistoryBtn.addEventListener('click', () => void loadHistory(false));

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
