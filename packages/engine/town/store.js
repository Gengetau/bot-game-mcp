// 全局状态、网络、事件流、心跳、动作提交。界面只读 state，通过这里发动作。
import { toast } from './dom.js';

/** @typedef {import('./types.js').MeView} MeView */
/** @typedef {import('./types.js').PublicView} PublicView */
/** @typedef {import('./types.js').TownConfig} TownConfig */
/** @typedef {import('./types.js').ActResult} ActResult */
/** @typedef {import('./types.js').ChatLine} ChatLine */
/** @typedef {import('./types.js').Card} Card */

/**
 * @typedef {'boot' | 'public' | 'register' | 'town' | 'left'} Phase
 * @typedef {{ loggedIn: boolean, name?: string, kind?: string, resident?: { id: string, name: string, present: boolean } | null }} SessionInfo
 * @typedef {{ type: string, at: number, data: Record<string, any> }} PrivateEvent
 * @typedef {'phase' | 'me' | 'pub' | 'conn' | 'chat' | 'flags' | 'tick'} Topic
 */

export const state = {
  /** @type {Phase} */
  phase: 'boot',
  /** @type {TownConfig | null} */
  config: null,
  /** @type {SessionInfo} */
  session: { loggedIn: false },
  /** @type {PublicView | null} */
  pub: null,
  /** @type {MeView | null} */
  me: null,
  meFetchedAt: 0,
  /** 服务器时间 - 本机时间 */
  clockOffset: 0,
  /** @type {'ok' | 'connecting' | 'offline'} */
  conn: 'connecting',
  recovering: false,
  /** 另一个页面握着控制权（本页只读） */
  readOnly: false,
  /** 控制权曾经是本页的，后来被拿走了 */
  taken: false,
  /** @type {ChatLine[]} */
  chat: [],
  olderChatDone: false,
  /** 最近一局结束的结果（用于结果弹层） */
  /** @type {Record<string, any> | null} */
  lastGameEnd: null,
  /** 进入时的回顾 */
  /** @type {import('./types.js').Recap | null} */
  recap: null,
  /** 登录或进入时的提示文字（显示在入口页） */
  /** @type {string} */
  entryNote: '',
  leftNote: '',
  /** 公开信息读不到（入口页据此显示「正在重试」） */
  pubDown: false,
};

// ───────────────────────── 订阅 ─────────────────────────

/** @type {Set<(topic: Topic) => void>} */
const listeners = new Set();

/** @param {(topic: Topic) => void} fn */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {Topic} topic */
export function emit(topic) {
  for (const fn of listeners) {
    try {
      fn(topic);
    } catch (e) {
      console.error(e);
    }
  }
}

/** 页面里其他模块想订阅「收到私有事件」时用。 @type {Set<(ev: PrivateEvent) => void>} */
const eventListeners = new Set();
/** @param {(ev: PrivateEvent) => void} fn */
export function onEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

// ───────────────────────── 基础 ─────────────────────────

/** 每个标签页一个稳定编号 */
export const clientId = (() => {
  try {
    const old = sessionStorage.getItem('town.clientId');
    if (old && /^[\w.:-]{4,80}$/.test(old)) return old;
  } catch {
    /* 存储不可用就只在内存里 */
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = `tab-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  try {
    sessionStorage.setItem('town.clientId', id);
  } catch {
    /* ignore */
  }
  return id;
})();

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const serverNow = () => Date.now() + state.clockOffset;

export function newRequestId() {
  return `a-${crypto.randomUUID()}`;
}

/** @param {string} key */
function flagGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
/**
 * @param {string} key
 * @param {string | null} v
 */
function flagSet(key, v) {
  try {
    if (v === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/**
 * 发请求。网络层失败会抛出；HTTP 层的失败（4xx/5xx）正常返回 {status, data}。
 * @param {'GET' | 'POST'} method
 * @param {string} path  以 /town/api 为前缀之后的部分
 * @param {unknown} [body]
 * @returns {Promise<{ status: number, data: any }>}
 */
export async function http(method, path, body) {
  const res = await fetch(`/town/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: 'bad_response', message: '服务器返回了看不懂的内容。' };
  }
  return { status: res.status, data };
}

// ───────────────────────── 启动 ─────────────────────────

export async function boot() {
  try {
    await loadConfig();
    await consumeTicket();
  } catch (e) {
    console.error(e);
  }
  window.addEventListener('hashchange', () => void onHashChange());
  await loadSession();
  await afterSession();
}

let cfgTimer = 0;
let cfgTry = 0;
/**
 * 读小镇设置；失败按退避自动重试，成功后通知界面重绘。
 * @param {boolean} [now] 立即重试（手动点「重试」）
 * @returns {Promise<boolean>}
 */
export async function loadConfig(now = false) {
  if (state.config) return true;
  if (now) clearTimeout(cfgTimer);
  const r = await http('GET', '/config').catch(() => null);
  if (r && r.status === 200) {
    state.config = r.data;
    cfgTry = 0;
    emit('pub');
    return true;
  }
  cfgTry = Math.min(cfgTry + 1, 4);
  clearTimeout(cfgTimer);
  cfgTimer = window.setTimeout(() => void loadConfig(), Math.min(15000, 2000 * 2 ** (cfgTry - 1)));
  return false;
}

let ticketBusy = false;
/**
 * 登录票据在 URL 片段里：读到就先把片段清掉，再兑换。畸形的票据只给提示，不抛错。
 * @returns {Promise<boolean>} 有没有处理过票据
 */
async function consumeTicket() {
  const m = /(?:^|[#&])ticket=([^&]*)/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search);
  state.entryNote = '';
  let ticket = '';
  try {
    ticket = decodeURIComponent(m[1] ?? '').trim();
  } catch {
    /* 链接被截断或转义错了 */
  }
  if (!ticket) {
    state.entryNote = '登录链接无效或已过期，请重新向裁判索取。';
    return true;
  }
  const r = await http('POST', '/auth/exchange', { ticket }).catch(() => null);
  if (!r || !r.data.ok) state.entryNote = r?.data?.message ?? (r ? '登录链接无效或已过期，请重新向裁判索取。' : '网络不通，没能用登录链接登录。');
  return true;
}

/** 页面已经打开时又粘贴了带票据的链接 */
async function onHashChange() {
  if (ticketBusy || state.phase === 'boot' || !/(?:^|[#&])ticket=/.test(location.hash)) return;
  ticketBusy = true;
  try {
    if (await consumeTicket()) {
      await loadSession();
      await afterSession();
    }
  } catch (e) {
    console.error(e);
  } finally {
    ticketBusy = false;
  }
}

export async function loadSession() {
  const r = await http('GET', '/session').catch(() => null);
  state.session = r && r.status === 200 ? r.data : { loggedIn: false };
}

export async function afterSession() {
  if (state.session.loggedIn && state.session.resident) {
    if (flagGet('town.left') === '1') {
      state.leftNote = flagGet('town.leftNote') ?? '';
      await goPublic('left');
      return;
    }
    const ok = await enter();
    if (ok === true) return;
    if (typeof ok === 'string' && ok) state.entryNote = ok;
    // 失败了：别停在启动画面，回到带提示和重试入口的页面
    if (state.phase === 'boot') {
      await goPublic('left');
      return;
    }
    if (state.phase !== 'public') return;
  } else if (state.session.loggedIn) {
    await goPublic('register');
    return;
  }
  await goPublic('public');
}

/** @param {Phase} phase */
async function goPublic(phase) {
  stopRuntime();
  lastCursor = '';
  state.me = null;
  state.phase = phase;
  emit('phase');
  await refreshPub();
  startPublicStream();
  startPubTimer();
}

// ───────────────────────── 登录 ─────────────────────────

/** @param {string} name */
export async function devLogin(name) {
  const r = await http('POST', '/auth/dev', { name }).catch(() => null);
  if (!r) return { ok: false, message: '网络不通，稍后再试。' };
  if (!r.data.ok) return { ok: false, message: r.data.message ?? '登录失败。' };
  flagSet('town.left', null);
  state.entryNote = '';
  await loadSession();
  await afterSession();
  if (state.phase === 'town' || state.phase === 'register') return { ok: true, message: '' };
  return { ok: false, message: state.entryNote || '没能进入小镇，稍后再试。' };
}

export async function logout() {
  await http('POST', '/auth/logout', {}).catch(() => null);
  flagSet('town.left', null);
  stopRuntime();
  state.session = { loggedIn: false };
  state.me = null;
  lastCursor = '';
  lastPcursor = '';
  state.chat = [];
  state.entryNote = '';
  await goPublic('public');
}

// ───────────────────────── 进入、离开、接管 ─────────────────────────

/**
 * 进入（或恢复）居民。第一次需要 profile。
 * @param {{ name: string, bio: string, traits: string[], interests: string[] }} [profile]
 * @returns {Promise<boolean | string>} 成功 true；失败返回提示文字（或 false 表示要回入口）
 */
export async function enter(profile) {
  const r = await http('POST', '/enter', { clientId, ...(profile ? { profile } : {}) }).catch(() => null);
  if (!r) {
    state.conn = 'offline';
    emit('conn');
    return '网络不通，稍后再试。';
  }
  const d = r.data;
  if (!d.ok) {
    if (d.error === 'precondition_failed' && d.reason === 'profile_required') {
      await goPublic('register');
      return true;
    }
    if (d.error === 'unauthenticated') {
      state.session = { loggedIn: false };
      await goPublic('public');
      return d.message ?? '请重新登录。';
    }
    if (d.reason === 'world_full' || d.error === 'recovering') {
      state.entryNote = d.message ?? '暂时进不去。';
      if (state.phase === 'boot') await goPublic('left');
      return d.message ?? '暂时进不去。';
    }
    return d.message ?? '进入失败。';
  }
  flagSet('town.left', null);
  state.phase = 'town';
  state.chat = [];
  state.olderChatDone = false;
  state.lastGameEnd = null;
  state.recap = d.view?.recap ?? null;
  applyMe(/** @type {MeView} */ (d.view));
  // 事件游标以刚读到的视图为准：离开期间的事件已经在回顾里，不再重放
  lastCursor = state.me?.cursor ?? '';
  lastPcursor = '';
  presenceEpoch = d.presenceEpoch ?? state.me?.control.presenceEpoch ?? 0;
  state.taken = false;
  state.readOnly = !state.me?.control.mine;
  stopPublicStream();
  emit('phase');
  startRuntime();
  refreshPub();
  return true;
}

export async function leaveTown() {
  const r = await http('POST', '/leave', {}).catch(() => null);
  if (!r || !r.data.ok) {
    toast(r?.data?.message ?? '网络不通，没能离开。', 'error');
    return false;
  }
  flagSet('town.left', '1');
  flagSet('town.leftNote', '你离开了小镇。你的家、背包和朋友都留着，随时可以回来。');
  state.leftNote = '你离开了小镇。你的家、背包和朋友都留着，随时可以回来。';
  state.me = null;
  lastCursor = '';
  lastPcursor = '';
  await goPublic('left');
  return true;
}

export async function claim() {
  const r = await http('POST', '/claim', { clientId }).catch(() => null);
  if (!r || !r.data.ok) {
    toast(r?.data?.message ?? '没能接管，稍后再试。', 'error');
    return false;
  }
  state.taken = false;
  await refreshMe(true);
  toast('已接管：现在由这个页面操作。', 'ok');
  return true;
}

// ───────────────────────── 视图刷新 ─────────────────────────

/** @param {MeView} v */
function applyMe(v) {
  const prev = state.me;
  state.me = v;
  state.meFetchedAt = Date.now();
  state.clockOffset = v.world.time - Date.now();
  const wasMine = prev ? prev.control.mine : v.control.mine;
  state.readOnly = !v.control.mine;
  if (wasMine && !v.control.mine && prev) state.taken = true;
  if (v.control.mine) state.taken = false;
  if (v.here) mergeChat(v.here.chat.map((c) => ({ messageId: c.messageId, space: v.here?.space ?? '', spaceName: v.here?.name ?? '', from: c.from, text: c.text, at: c.at })));
  presenceEpoch = v.control.presenceEpoch;
  syncNavLease();
  emit('me');
  emit('flags');
}

// ───────────────────────── 导航控制租约 ─────────────────────────

let navTimer = 0;
/** 正在续的那一趟（navigationId:revision） */
let navKey = '';

function stopNavLease() {
  clearTimeout(navTimer);
  navTimer = 0;
  navKey = '';
}

/**
 * 走路期间每 renewEveryMs 续一次租约（普通请求，不走动作管线）。
 * 页面在后台时浏览器会降频定时器，续不上租约人就会停在半路——这是预期行为。
 */
function syncNavLease() {
  const nav = state.me?.location.navigation;
  if (!nav || !running || state.readOnly || state.phase !== 'town') {
    stopNavLease();
    return;
  }
  const key = `${nav.navigationId}:${nav.revision}`;
  if (navTimer && navKey === key) return;
  clearTimeout(navTimer);
  navKey = key;
  scheduleNavRenew(nav.renewEveryMs || 3000);
}

/** @param {number} ms */
function scheduleNavRenew(ms) {
  clearTimeout(navTimer);
  navTimer = window.setTimeout(() => void renewNavOnce(), ms);
}

async function renewNavOnce() {
  const nav = state.me?.location.navigation;
  if (!nav || !running || state.phase !== 'town') {
    stopNavLease();
    return;
  }
  const every = nav.renewEveryMs || 3000;
  try {
    const r = await http('POST', '/nav/renew', { clientId, navigationId: nav.navigationId, revision: nav.revision });
    const d = r.data;
    const cur = state.me?.location.navigation;
    if (!cur || cur.navigationId !== nav.navigationId) return; // 视图已经换了，由新的同步接手
    if (d?.ok && d.navigation) {
      cur.revision = d.navigation.revision;
      cur.leaseUntil = d.navigation.leaseUntil ?? d.leaseUntil ?? cur.leaseUntil;
      cur.arriveAt = d.navigation.arriveAt ?? cur.arriveAt;
      navKey = `${cur.navigationId}:${cur.revision}`;
      scheduleNavRenew(cur.renewEveryMs || every);
      // 走路的人自己跨区域时没有事件：续租的回答里带着脚下的区域，变了就重读现场
      if (typeof d.space === 'string' && d.space !== state.me?.location.space) scheduleRefreshMe(0);
      return;
    }
    // 已经停了或到了：停掉定时器，重读视图
    stopNavLease();
    scheduleRefreshMe(0);
  } catch {
    // 网络抖动：租约还没过期就再试一次
    if (navTimer || state.me?.location.navigation) scheduleNavRenew(1000);
  }
}

let meInflight = /** @type {Promise<void> | null} */ (null);
let meTimer = 0;
let meDirty = false;

/**
 * 重读本人视图。
 * @param {boolean} [now] 立即读（不合并等待）
 */
export function refreshMe(now = false) {
  if (state.phase !== 'town') return Promise.resolve();
  if (meInflight) {
    meDirty = true;
    return meInflight;
  }
  meInflight = (async () => {
    try {
      const r = await http('GET', `/me?clientId=${encodeURIComponent(clientId)}`);
      if (r.status === 200) {
        setConn('ok');
        state.recovering = false;
        applyMe(r.data);
      } else if (r.status === 401) {
        await sessionLost(r.data?.reason === 'no_resident' ? '' : (r.data?.message ?? '登录已失效，请重新进入。'));
      } else if (r.status === 503) {
        state.recovering = true;
        emit('flags');
      }
    } catch {
      setConn('offline');
    } finally {
      meInflight = null;
      if (meDirty) {
        meDirty = false;
        scheduleRefreshMe(120);
      }
    }
  })();
  return meInflight;
}

/** @param {number} [delay] */
export function scheduleRefreshMe(delay = 180) {
  clearTimeout(meTimer);
  meTimer = window.setTimeout(() => void refreshMe(), delay);
}

/** @param {string} note */
async function sessionLost(note) {
  stopRuntime();
  state.session = { loggedIn: false };
  state.me = null;
  lastCursor = '';
  lastPcursor = '';
  state.entryNote = note;
  await goPublic('public');
}

let pubInflight = false;
let pubRetry = 0;
let pubRetryTimer = 0;
export async function refreshPub() {
  if (pubInflight) return;
  pubInflight = true;
  clearTimeout(pubRetryTimer);
  let ok = false;
  try {
    const r = await http('GET', '/public');
    if (r.status === 200) {
      ok = true;
      pubRetry = 0;
      state.pubDown = false;
      state.pub = r.data;
      if (state.phase !== 'town') state.clockOffset = r.data.world.time - Date.now();
      emit('pub');
    }
  } catch {
    /* 下面按失败处理 */
  } finally {
    pubInflight = false;
  }
  if (!ok && state.phase !== 'town') {
    setConn('offline');
    state.pubDown = true;
    emit('pub');
    // 入口页读不到公开信息：按退避自己重试，不等 30 秒的轮询
    pubRetry = Math.min(pubRetry + 1, 4);
    pubRetryTimer = window.setTimeout(() => void refreshPub(), Math.min(15000, 2000 * 2 ** (pubRetry - 1)));
  }
}
let pubTimer = 0;
function schedulePub() {
  clearTimeout(pubTimer);
  pubTimer = window.setTimeout(() => void refreshPub(), 700);
}

/** @param {'ok' | 'connecting' | 'offline'} c */
function setConn(c) {
  if (state.conn === c) return;
  state.conn = c;
  emit('conn');
}

// ───────────────────────── 聊天记录 ─────────────────────────

let sysSeq = 0;

/** @param {ChatLine[]} lines */
export function mergeChat(lines) {
  let changed = false;
  for (const line of lines) {
    if (state.chat.some((c) => c.messageId === line.messageId)) continue;
    // 按时间插入（同时刻按编号）
    let i = state.chat.length;
    while (i > 0) {
      const prev = state.chat[i - 1];
      if (!prev || prev.at < line.at || (prev.at === line.at && prev.messageId < line.messageId)) break;
      i--;
    }
    state.chat.splice(i, 0, line);
    changed = true;
  }
  if (state.chat.length > 400) state.chat.splice(0, state.chat.length - 400);
  if (changed) emit('chat');
}

/**
 * 加一行系统提示（有人来了、走了）。
 * @param {string} text
 * @param {number} at
 */
function sysLine(text, at) {
  const space = state.me?.location.space ?? '';
  state.chat.push({ messageId: -(++sysSeq), space, spaceName: state.me?.here?.name ?? '', from: { id: '', name: '', kind: 'human' }, text, at, sys: true });
  emit('chat');
}

/** 往上翻更早的聊天记录。 */
export async function loadOlderChat() {
  const real = state.chat.filter((c) => !c.sys && c.messageId > 0);
  const before = real.length ? Math.min(...real.map((c) => c.messageId)) : undefined;
  const r = await http('GET', `/history?limit=30${before ? `&before=${before}` : ''}`).catch(() => null);
  if (!r || r.status !== 200) {
    toast('没能读到更早的发言。', 'warn');
    return 0;
  }
  /** @type {import('./types.js').HistoryMsg[]} */
  const msgs = r.data.messages;
  if (r.data.next === null) state.olderChatDone = true;
  mergeChat(msgs);
  emit('chat');
  return msgs.length;
}

// ───────────────────────── 动作 ─────────────────────────

/**
 * 提交一个动作。会按错误码处理：
 * 只有网络失败、rate_limited、recovering 才用同一个 requestId 自动重试；
 * context_stale / phase_stale / request_expired / resync_required 重读视图并交还给调用者，不自动重发。
 * @param {Record<string, unknown>} action
 * @param {{ quiet?: boolean }} [opts]
 * @returns {Promise<ActResult>}
 */
export async function act(action, opts = {}) {
  const me = state.me;
  if (!me || state.phase !== 'town') return { ok: false, error: 'unauthenticated', message: '还没有进入小镇。' };
  if (state.readOnly) {
    toast('这个页面现在是只读的：另一个页面握着控制权。点上方的「接管」。', 'warn');
    return { ok: false, error: 'control_lost', message: '只读' };
  }
  const requestId = newRequestId();
  const body = {
    clientId,
    requestId,
    actionWindow: me.actionWindow,
    expected: { contextVersion: me.context.version, controlEpoch: me.control.epoch, activityId: me.context.activityId },
    action,
  };
  for (let attempt = 0; ; attempt++) {
    /** @type {{ status: number, data: any }} */
    let res;
    try {
      res = await http('POST', '/actions', body);
    } catch {
      setConn('offline');
      if (attempt < 3) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      toast('网络不通，动作不确定有没有成功。恢复后会自动同步，请先看看现在的状态再决定要不要重做。', 'error', 6500);
      return { ok: false, error: 'network', message: '网络不通' };
    }
    const d = /** @type {ActResult} */ (res.data);
    if (d.ok) {
      setConn('ok');
      state.recovering = false;
      scheduleRefreshMe(60);
      return d;
    }
    switch (d.error) {
      case 'rate_limited':
      case 'recovering':
        if (d.error === 'recovering') {
          state.recovering = true;
          emit('flags');
        }
        if (attempt < 4) {
          if (!opts.quiet && attempt === 0) toast(d.error === 'recovering' ? '小镇正在恢复，稍等一下自动重试……' : '动作太频繁，稍等一下自动重试……', 'warn');
          await sleep(Math.min(8000, d.retryAfterMs ?? 1500 + attempt * 1000));
          continue;
        }
        toast(d.message ?? '稍后再试。', 'warn');
        return d;
      case 'control_lost':
        state.readOnly = true;
        state.taken = true;
        emit('flags');
        toast('控制权在别的页面上，这条动作没有执行。', 'warn');
        scheduleRefreshMe(0);
        return d;
      case 'context_stale':
      case 'phase_stale':
      case 'request_expired':
      case 'resync_required':
        toast(d.error === 'phase_stale' ? '这一步已经过去了，已刷新局面，请按新的局面再操作。' : '情况有变化，已刷新，请再试一次。', 'warn');
        scheduleRefreshMe(0);
        return d;
      case 'unauthenticated':
        if (d.reason !== 'no_resident') void sessionLost(d.message ?? '登录已失效，请重新进入。');
        else void goPublic('register');
        return d;
      case 'precondition_failed':
        if (d.reason === 'not_present' || d.reason === 'presence_lost') {
          toast('在场状态失效了，正在重新进入……', 'warn');
          void reenter();
          return d;
        }
        if (!opts.quiet) toast(d.message ?? '现在做不了这件事。', 'warn');
        scheduleRefreshMe(250);
        return d;
      default:
        if (!opts.quiet) toast(d.message ?? '出错了。', 'error');
        return d;
    }
  }
}

// ───────────────────────── 心跳与运行期 ─────────────────────────

let presenceEpoch = 0;
let hbTimer = 0;
let running = false;
let hbBackoff = 0;

/** @returns {Promise<boolean>} */
async function reenter() {
  const r = await enter();
  if (r !== true) toast(typeof r === 'string' ? r : '没能重新进入。', 'error');
  return r === true;
}

function startRuntime() {
  stopRuntime();
  running = true;
  hbBackoff = 0;
  scheduleHeartbeat(state.config?.heartbeatMs ?? 20000);
  connectPrivateStream();
}

export function stopRuntime() {
  running = false;
  clearTimeout(hbTimer);
  stopNavLease();
  clearTimeout(meTimer);
  clearTimeout(pubTimer);
  clearTimeout(pubPoll);
  clearTimeout(pubRetryTimer);
  closeStream();
  stopPublicStream();
}

/** @param {number} ms */
function scheduleHeartbeat(ms) {
  clearTimeout(hbTimer);
  if (!running) return;
  hbTimer = window.setTimeout(() => void heartbeatOnce(), ms);
}

async function heartbeatOnce() {
  if (!running) return;
  let next = state.config?.heartbeatMs ?? 20000;
  try {
    const r = await http('POST', '/heartbeat', { clientId, presenceEpoch });
    const d = r.data;
    if (d.ok) {
      hbBackoff = 0;
      setConn(streamOpen ? 'ok' : state.conn === 'offline' ? 'connecting' : state.conn);
      state.recovering = false;
      next = Math.max(5000, d.nextHeartbeatMs ?? next);
      const me = state.me;
      if (me) {
        const mine = Boolean(d.control?.mine);
        if (mine === state.readOnly) {
          state.readOnly = !mine;
          state.taken = !mine;
          emit('flags');
          scheduleRefreshMe(0);
        }
        // 服务重启后心跳会让服务端恢复在场，但这三个值不变：本地还显示不在场就重读
        if (!me.me.present) scheduleRefreshMe(0);
        if (d.contextVersion !== me.context.version || (d.activityId ?? null) !== me.context.activityId || d.control?.epoch !== me.control.epoch) scheduleRefreshMe(0);
      }
      if (!streamOpen) connectPrivateStream();
    } else if (r.status === 503) {
      state.recovering = true;
      emit('flags');
    } else if (r.status === 401) {
      await sessionLost(d.message ?? '登录已失效，请重新进入。');
      return;
    } else if (d.reason === 'presence_lost') {
      // 成功时 enter 已经重排心跳；失败也要继续按退避排下一次，别让心跳循环停掉
      if (await reenter()) return;
      hbBackoff = Math.min(hbBackoff + 1, 4);
      next = Math.min(15000, 2000 * 2 ** hbBackoff);
    }
  } catch {
    setConn('offline');
    hbBackoff = Math.min(hbBackoff + 1, 4);
    next = Math.min(15000, 2000 * 2 ** hbBackoff);
  }
  scheduleHeartbeat(next);
}

// ───────────────────────── 事件流（SSE） ─────────────────────────

/** @type {EventSource | null} */
let es = null;
let streamOpen = false;
let esRetry = 0;
let esTimer = 0;
let lastCursor = '';
let lastPcursor = '';

function closeStream() {
  clearTimeout(esTimer);
  if (es) {
    es.close();
    es = null;
  }
  streamOpen = false;
}

function connectPrivateStream() {
  if (!running) return;
  closeStream();
  const cur = lastCursor || state.me?.cursor || '';
  const p = lastPcursor || state.pub?.cursor || '';
  const qs = new URLSearchParams({ clientId });
  if (cur) qs.set('cursor', cur);
  if (p) qs.set('pcursor', p);
  const src = new EventSource(`/town/api/events?${qs.toString()}`);
  es = src;
  src.addEventListener('hello', (e) => {
    streamOpen = true;
    esRetry = 0;
    setConn('ok');
    try {
      const d = JSON.parse(/** @type {MessageEvent} */ (e).data);
      if (d.cursor) lastCursor = d.cursor;
      if (d.pcursor) lastPcursor = d.pcursor;
    } catch {
      /* ignore */
    }
    // 重连之后以最新授权状态校正画面
    scheduleRefreshMe(0);
  });
  src.addEventListener('private', (e) => {
    const me = /** @type {MessageEvent} */ (e);
    if (me.lastEventId) lastCursor = me.lastEventId;
    try {
      onPrivate(JSON.parse(me.data));
    } catch (err) {
      console.error(err);
    }
  });
  src.addEventListener('public', (e) => {
    try {
      const d = JSON.parse(/** @type {MessageEvent} */ (e).data);
      if (d.pcursor) lastPcursor = d.pcursor;
    } catch {
      /* ignore */
    }
    schedulePub();
  });
  src.addEventListener('resync', (e) => {
    try {
      const d = JSON.parse(/** @type {MessageEvent} */ (e).data);
      if (d.scope === 'private' && d.cursor) lastCursor = d.cursor;
      if (d.scope === 'public' && d.pcursor) lastPcursor = d.pcursor;
    } catch {
      /* ignore */
    }
    scheduleRefreshMe(0);
    schedulePub();
  });
  src.addEventListener('revoked', () => {
    closeStream();
    running = false;
    flagSet('town.left', '1');
    flagSet('town.leftNote', '你已经离开了小镇（可能是在别的页面上离开的）。');
    state.leftNote = '你已经离开了小镇（可能是在别的页面上离开的）。';
    void goPublic('left');
  });
  src.onerror = () => {
    streamOpen = false;
    if (!running) return;
    src.close();
    if (es === src) es = null;
    setConn('connecting');
    esRetry = Math.min(esRetry + 1, 5);
    clearTimeout(esTimer);
    esTimer = window.setTimeout(connectPrivateStream, Math.min(15000, 1000 * 2 ** esRetry));
  };
}

/** @param {PrivateEvent} ev */
function onPrivate(ev) {
  const d = ev.data ?? {};
  for (const fn of eventListeners) fn(ev);
  let refresh = true;
  switch (ev.type) {
    case 'chat': {
      refresh = false;
      mergeChat([{ messageId: d.messageId, space: d.space, spaceName: spaceLabel(d.space), from: d.from, text: d.text, at: ev.at }]);
      break;
    }
    case 'you_arrived':
      toast(`到了${d.name ?? '目的地'}。`, 'ok', 2800);
      break;
    case 'nav_stopped':
      toast(d.reason === 'lease' ? '没能及时续上行程，停在了半路。' : d.reason === 'blocked' ? '没能进去，停在了门口。' : d.reason === 'activity' ? '开始做别的事，停下了脚步。' : d.reason === 'control' ? '另一个页面接管了行程。' : '停下了脚步。', d.reason === 'lease' ? 'warn' : 'info', 3500);
      break;
    case 'arrived':
      sysLine(`${d.resident?.name ?? '有人'}${d.fromGame ? '回到了这里' : '来了'}。`, ev.at);
      break;
    case 'left':
      sysLine(`${d.resident?.name ?? '有人'}离开了。`, ev.at);
      break;
    case 'presence':
      sysLine(`${d.resident?.name ?? '有人'}${d.present ? '回到了小镇' : '暂时离开了小镇'}。`, ev.at);
      break;
    case 'notice':
      toast(String(d.text ?? ''), 'info', 6000);
      break;
    case 'asked_hobby':
      toast(`${d.from?.name ?? '有人'}问了你的爱好。`, 'info');
      break;
    case 'offer':
      offerToast(d.offer);
      break;
    case 'mail':
      toast(String(d.text ?? '有新信。'), 'info', 6000);
      break;
    case 'invite':
      toast(String(d.text ?? '收到一份邀请。'), 'info', 6000);
      break;
    case 'interaction_done':
      toast(String(d.text ?? '完成了。'), 'ok', 6000);
      break;
    case 'goal':
      if (d.completed) toast(`完成愿望「${d.goal?.title ?? ''}」${d.reward ? `，得到 ${d.reward} 枚硬币` : ''}${d.title ? `，获得称号「${d.title}」` : ''}。`, 'ok', 7000);
      break;
    case 'game_started':
      toast(`${d.name ?? '小游戏'}开局了，你坐在 ${d.seat} 号位。`, 'ok');
      break;
    case 'game_out':
      toast(String(d.text ?? '你出局了。'), 'info', 6000);
      break;
    case 'game_ended':
      state.lastGameEnd = d;
      break;
    case 'control':
      break;
    default:
      break;
  }
  if (refresh) scheduleRefreshMe(ev.type === 'game' ? 80 : 200);
  if (ev.type === 'game_ended') emit('me');
}

/** @param {import('./types.js').Offer} o */
function offerToast(o) {
  const myId = state.me?.me.id;
  if (!o || !myId) return;
  if (o.status === 'open') {
    if (o.to.id === myId) toast(o.text, 'info', 7000);
    return;
  }
  const mine = o.from.id === myId;
  /** @type {Record<string, string>} */
  const texts = mine
    ? { accepted: '你发起的报价被接受了。', declined: '你发起的报价被婉拒了。', cancelled: '你撤销了这份报价。', expired: `你发起的报价过期了${o.reason ? `（${o.reason}）` : ''}。` }
    : { accepted: '你接受了这份报价。', declined: '你婉拒了这份报价。', cancelled: '对方撤销了给你的报价。', expired: `给你的报价过期了${o.reason ? `（${o.reason}）` : ''}。` };
  toast(texts[o.status] ?? `报价${o.status}。`, o.status === 'accepted' ? 'ok' : 'info', 5500);
}

/** 地点 id → 名字 */
/** @param {string} space */
export function spaceLabel(space) {
  if (space === 'residential') return '住宅区';
  const place = state.pub?.places.find((p) => p.id === space);
  if (place) return place.name;
  if (state.me && space === state.me.location.space) return state.me.location.name;
  if (space.startsWith('home:')) return state.me && space === state.me.me.home.id ? '自己的家' : '别人家';
  return space;
}

// ───────────────────────── 公开事件流（未登录时） ─────────────────────────

/** @type {EventSource | null} */
let pes = null;
let pesRetry = 0;
let pesTimer = 0;
let pubPoll = 0;

function stopPublicStream() {
  clearTimeout(pesTimer);
  if (pes) {
    pes.close();
    pes = null;
  }
}

function startPublicStream() {
  stopPublicStream();
  if (state.phase === 'town') return;
  const qs = lastPcursor || state.pub?.cursor ? `?cursor=${encodeURIComponent(lastPcursor || state.pub?.cursor || '')}` : '';
  const src = new EventSource(`/town/api/public/events${qs}`);
  pes = src;
  src.addEventListener('hello', () => {
    pesRetry = 0;
    setConn('ok');
  });
  src.addEventListener('public', (e) => {
    const me = /** @type {MessageEvent} */ (e);
    if (me.lastEventId) lastPcursor = me.lastEventId;
    schedulePub();
  });
  src.addEventListener('resync', () => schedulePub());
  src.onerror = () => {
    src.close();
    if (pes === src) pes = null;
    setConn('connecting');
    pesRetry = Math.min(pesRetry + 1, 5);
    pesTimer = window.setTimeout(startPublicStream, Math.min(15000, 1000 * 2 ** pesRetry));
  };
}

function startPubTimer() {
  clearTimeout(pubPoll);
  const loop = () => {
    if (state.phase === 'town') return;
    void refreshPub();
    pubPoll = window.setTimeout(loop, 30000);
  };
  pubPoll = window.setTimeout(loop, 30000);
}

// ───────────────────────── 页面可见性 ─────────────────────────

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.phase === 'town' && running) {
    clearTimeout(hbTimer);
    void heartbeatOnce();
    scheduleRefreshMe(0);
    schedulePub();
    if (!streamOpen) connectPrivateStream();
  } else if (state.phase !== 'boot') {
    void refreshPub();
    if (!pes) startPublicStream();
  }
});

window.addEventListener('online', () => {
  if (state.phase === 'town' && running) {
    clearTimeout(hbTimer);
    void heartbeatOnce();
    if (!streamOpen) connectPrivateStream();
  } else {
    void refreshPub();
  }
});
window.addEventListener('offline', () => setConn('offline'));

/** 测试和调试用：不在页面逻辑里使用。 */
Object.defineProperty(window, '__town', { value: { state }, enumerable: false });
