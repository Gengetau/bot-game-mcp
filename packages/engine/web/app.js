// @ts-check
/**
 * 灯下剧场：观战页面（只读）。
 * 数据来自 /web/api/games/:id/stream（SSE），只含公开信息；所有文字一律当纯文本渲染，不拼 HTML。
 */

/**
 * @typedef {{ seq: number, at: number, round: number, kind: string, text: string, seat?: number, speech?: string }} Ev
 * @typedef {{ seat: number, name: string, kind: string, alive: boolean }} Seat
 * @typedef {{ key: string, title: string, opened: boolean, deadline: number|null, timeout_ms: number, secret: boolean, total: number|null, waiting: number[], done: number[] }} Phase
 * @typedef {{ at: number, round: number, kind: string, text: string, seat?: number, audience: string | { seats: number[] } }} ReplayEv
 * @typedef {{
 *   game: { id: string, type: string, name: string, status: string, round: number, started_at: number|null, ended_at: number|null },
 *   phase: Phase|null, players: Seat[], lobby?: { name: string, kind: string }[], board: any, events: Ev[], last_seq: number,
 *   result?: { winnerTeam: string, winnerSeats: number[], reason: string, reveal: { seat: number, name: string, identity: string }[] },
 *   aborted?: string, replay?: ReplayEv[], server_time: number,
 *   chat?: Chat[], chat_seq?: number
 * }} View
 * @typedef {{ seq: number, at: number, from: 'web'|'agent', name: string, text: string }} Chat
 */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [cls]
 * @param {string | null} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

const params = new URLSearchParams(location.search);
const gameId = params.get('g') ?? '';
const token = params.get('t') ?? '';

/** @type {{ view: View|null, events: Ev[], offset: number, unread: number, filter: string, god: boolean, rendered: number, chat: Chat[], chatSeen: number, mine: Set<number> }} */
const st = { view: null, events: [], offset: 0, unread: 0, filter: 'all', god: false, rendered: 0, chat: [], chatSeen: 0, mine: new Set() };

const desktop = window.matchMedia('(min-width: 1024px)');

// ───────── 主题 ─────────
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(/** @type {string} */ t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('theme').setAttribute('aria-label', `主题：${t === 'auto' ? '跟随系统' : t === 'light' ? '浅色' : '深色'}（点击切换）`);
}
let theme = 'auto';
try {
  theme = localStorage.getItem('stage-theme') ?? 'auto';
} catch {
  /* 无痕模式等：用默认 */
}
if (!THEMES.includes(theme)) theme = 'auto';
applyTheme(theme);
$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'auto';
  applyTheme(theme);
  try {
    localStorage.setItem('stage-theme', theme);
  } catch {
    /* 忽略 */
  }
});

// ───────── 页签 ─────────
const TABS = ['talk', 'board', 'log', 'chat'];
function selectTab(/** @type {string} */ name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
  if (name === 'chat') {
    $('chat-dot').hidden = true;
    st.chatSeen = st.chat.length ? st.chat[st.chat.length - 1].seq : 0;
  }
  if (name === 'talk') scrollToEnd(true);
  else if (!desktop.matches) {
    // 手机上整页滚动：切到别的页签时回到页签顶部，不停在讨论流的底部
    const top = $('pane-talk').parentElement?.getBoundingClientRect().top ?? 0;
    if (top < 0) window.scrollBy(0, top);
  }
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => selectTab(t));
desktop.addEventListener('change', () => {
  if (desktop.matches && $('tab-board').getAttribute('aria-selected') === 'true') selectTab('talk');
  renderBoard();
});

// ───────── 工具 ─────────
const seatColor = (/** @type {number} */ seat) => `var(--s${((seat - 1) % 13) + 1})`;
const hhmm = (/** @type {number} */ at) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const player = (/** @type {number|undefined} */ seat) => st.view?.players.find((p) => p.seat === seat);
const label = (/** @type {number} */ seat) => {
  const p = player(seat);
  return p ? `${p.seat}号 ${p.name}` : `${seat}号`;
};
/** 角色名（剧本杀的公开角色表里有） */
const roleOf = (/** @type {number} */ seat) => {
  const cast = st.view?.board?.cast;
  return Array.isArray(cast) ? cast.find((c) => c?.seat === seat)?.role ?? null : null;
};

function avatar(/** @type {number} */ seat, small = false) {
  const p = player(seat);
  const a = el('span', `avatar${small ? ' small' : ''}`, p ? Array.from(p.name)[0] ?? '?' : String(seat));
  a.style.setProperty('--c', seatColor(seat));
  a.setAttribute('aria-hidden', 'true');
  return a;
}

/** 把「3号」「@克蕾雅」高亮成对应的座位色（文字节点拼接，不用 innerHTML） */
function withRefs(/** @type {string} */ raw) {
  // 程序公告里常见「3号 @克蕾雅」：号码已经高亮了，名字前的 @ 去掉
  const text = raw.replace(/(\d{1,2}号 )@/g, '$1');
  const frag = document.createDocumentFragment();
  const players = st.view?.players ?? [];
  const names = players.map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\d{1,2})号${names.length ? `|@(${names.map(esc).join('|')})` : ''}`, 'g');
  let last = 0;
  for (const m of text.matchAll(re)) {
    const seat = m[1] ? Number(m[1]) : players.find((p) => p.name === m[2])?.seat;
    if (!seat || !player(seat)) continue;
    if ((m.index ?? 0) > last) frag.append(text.slice(last, m.index));
    const span = el('span', 'ref', m[0]);
    span.style.setProperty('--c', seatColor(seat));
    frag.append(span);
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** 长内容默认折叠：box 是被截断的那块，fold 上挂 folded 类 */
function foldable(/** @type {HTMLElement} */ box, /** @type {HTMLElement} */ fold) {
  requestAnimationFrame(() => {
    const hidden = box.clientHeight === 0; // 在没打开的页签里：量不出高度，按字数估计
    const overflow = hidden ? (box.textContent ?? '').length > 220 : box.scrollHeight > box.clientHeight + 2;
    if (!overflow) {
      fold.classList.remove('folded');
      return;
    }
    const more = el('button', 'more', '展开全部');
    more.type = 'button';
    more.addEventListener('click', () => {
      const folded = fold.classList.toggle('folded');
      more.textContent = folded ? '展开全部' : '收起';
    });
    box.after(more);
  });
}

// ───────── 讨论流 ─────────
const SPEECH_TITLE = /^\d+号 .+?（(.+?)）：/;

/** @returns {HTMLElement} */
function renderEvent(/** @type {Ev} */ e) {
  if (e.seat !== undefined && typeof e.speech === 'string') {
    const row = el('article', 'msg');
    row.style.setProperty('--c', seatColor(e.seat));
    row.append(avatar(e.seat, true));
    const body = el('div', 'body');
    const who = el('div', 'who');
    who.append(el('strong', '', label(e.seat)));
    const title = SPEECH_TITLE.exec(e.text)?.[1] ?? roleOf(e.seat);
    if (title) who.append(el('span', 'role', title));
    who.append(el('span', 't', hhmm(e.at)));
    const bubble = el('div', 'bubble folded');
    bubble.append(withRefs(e.speech));
    body.append(who, bubble);
    row.append(body);
    foldable(bubble, bubble);
    return row;
  }
  if (e.kind === 'search_log') return el('div', 'tiny', e.text);
  if (e.kind === 'act') return el('div', 'note act', e.text);
  const long = e.kind === 'narration' || e.text.length > 160 || e.text.split('\n').length > 5;
  const card = el('div', `note${long ? ' long folded' : ''}`);
  const txt = el('div', 'txt');
  txt.append(withRefs(e.text));
  card.append(txt);
  if (long) foldable(txt, card);
  return card;
}

function scroller() {
  return desktop.matches ? $('pane-talk') : /** @type {HTMLElement} */ (document.scrollingElement ?? document.documentElement);
}
function nearEnd() {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}
function scrollToEnd(force = false) {
  if (!force && !nearEnd()) return;
  const s = scroller();
  s.scrollTop = s.scrollHeight;
  st.unread = 0;
  $('jump').hidden = true;
}
$('jump').addEventListener('click', () => scrollToEnd(true));
window.addEventListener(
  'scroll',
  () => {
    if (!desktop.matches && nearEnd()) {
      st.unread = 0;
      $('jump').hidden = true;
    }
  },
  { passive: true },
);
$('pane-talk').addEventListener(
  'scroll',
  () => {
    if (desktop.matches && nearEnd()) {
      st.unread = 0;
      $('jump').hidden = true;
    }
  },
  { passive: true },
);

function renderFeed() {
  const feed = $('feed');
  if (st.rendered === 0) feed.replaceChildren();
  const stick = nearEnd();
  feed.querySelector('.typing')?.remove();
  const fresh = st.events.slice(st.rendered);
  for (const e of fresh) feed.append(renderEvent(e));
  st.rendered = st.events.length;
  if (st.events.length === 0) feed.replaceChildren(el('p', 'empty', '还没有公开的内容。'));
  const v = st.view;
  const ph = v?.phase;
  // 只有一个人在等时显示「正在思考」：秘密阶段不显示（谁在行动是秘密）
  if (ph && ph.opened && !ph.secret && ph.waiting.length === 1) {
    const seat = /** @type {number} */ (ph.waiting[0]);
    const row = el('div', 'msg typing');
    row.style.setProperty('--c', seatColor(seat));
    const body = el('div', 'body');
    const who = el('div', 'who');
    who.append(el('strong', '', label(seat)), el('span', 'role', '正在思考…'));
    const b = el('div', 'bubble');
    b.append(el('span', 'dot'), el('span', 'dot'), el('span', 'dot'));
    body.append(who, b);
    row.append(avatar(seat, true), body);
    feed.append(row);
  }
  if (fresh.length === 0) return;
  if (stick) requestAnimationFrame(() => scrollToEnd(true));
  else {
    st.unread += fresh.length;
    const jump = $('jump');
    jump.textContent = `有 ${st.unread} 条新消息`;
    jump.hidden = false;
  }
}

// ───────── 座位 ─────────
function renderSeats() {
  const v = st.view;
  const ul = $('seats');
  ul.replaceChildren();
  if (!v) return;
  if (v.game.status === 'lobby') {
    for (const e of v.lobby ?? []) {
      const li = el('li', 'seat');
      const b = el('button');
      const a = el('span', 'avatar', Array.from(e.name)[0] ?? '?');
      b.append(a, el('span', 'nm', e.name));
      li.append(b);
      ul.append(li);
    }
    return;
  }
  const ph = v.phase;
  const waiting = new Set(ph?.waiting ?? []);
  const done = new Set(ph?.done ?? []);
  for (const p of v.players) {
    const li = el('li', 'seat');
    if (!p.alive) li.classList.add('dead');
    if (waiting.size === 1 && waiting.has(p.seat)) li.classList.add('speaking');
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-label', `${p.seat}号 ${p.name}${p.alive ? '' : '（出局）'}，查看公开信息`);
    const a = avatar(p.seat);
    if (!p.alive) a.append(el('span', 'badge out', '×'));
    else if (done.has(p.seat)) a.append(el('span', 'badge', '✓'));
    const names = el('span', 'names');
    names.append(el('span', 'no', `${p.seat}号`), el('span', 'nm', p.name));
    b.append(a, names);
    b.addEventListener('click', () => openSeat(p.seat));
    li.append(b);
    ul.append(li);
  }
}

function openSeat(/** @type {number} */ seat) {
  const p = player(seat);
  if (!p) return;
  const dlg = /** @type {HTMLDialogElement} */ ($('seat-dlg'));
  const h = $('seat-dlg-title');
  h.replaceChildren(avatar(seat, true), `${p.seat}号 ${p.name}`);
  const body = $('seat-dlg-body');
  body.replaceChildren();
  const dl = el('dl', 'kv');
  const cast = Array.isArray(st.view?.board?.cast) ? st.view?.board.cast.find((/** @type {any} */ c) => c?.seat === seat) : null;
  const rows = /** @type {[string,string][]} */ ([
    ['类型', p.kind === 'human' ? '真人' : 'AI'],
    ['状态', p.alive ? '在场' : '出局'],
    ...(cast?.role ? /** @type {[string,string][]} */ ([['角色', String(cast.role)]]) : []),
    ...(cast?.public ? /** @type {[string,string][]} */ ([['介绍', String(cast.public)]]) : []),
    ['发言', `${st.events.filter((e) => e.seat === seat && typeof e.speech === 'string').length} 次`],
  ]);
  for (const [k, val] of rows) dl.append(el('dt', '', k), el('dd', '', val));
  const shared = st.view?.board?.search?.shared;
  const mine = Array.isArray(shared) ? shared.filter((c) => c?.by === seat) : [];
  body.append(dl);
  if (mine.length) {
    body.append(el('p', 'sub', `公开的线索：${mine.map((c) => `「${c.title}」`).join('')}`));
  }
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

// ───────── 面板 ─────────
function panel(/** @type {string} */ title, /** @type {string} */ sub = '') {
  const p = el('section', 'panel');
  p.append(el('h3', '', title));
  if (sub) p.append(el('p', 'sub', sub));
  return p;
}

function boardNodes() {
  const v = st.view;
  /** @type {HTMLElement[]} */
  const out = [];
  if (!v) return out;
  if (v.result) {
    const p = panel('结局');
    p.classList.add('result');
    p.append(el('p', '', v.result.reason));
    if (v.result.reveal?.length) {
      const dl = el('dl', 'kv');
      for (const r of v.result.reveal) dl.append(el('dt', '', `${r.seat}号 ${r.name}`), el('dd', '', r.identity));
      p.append(dl);
    }
    out.push(p);
  }
  if (v.aborted) {
    const p = panel('对局已中止');
    p.append(el('p', '', String(v.aborted)));
    out.push(p);
  }
  const b = v.board;
  if (!b) {
    if (v.game.status === 'lobby') out.push(el('p', 'empty', `报名中：${v.lobby?.length ?? 0} 人`));
    return out;
  }
  if (b.script) {
    const p = panel(`《${b.script.title}》`, `共 ${b.script.acts} 幕${b.dm ? ` · DM ${b.dm.name}` : ''}`);
    const dl = el('dl', 'kv');
    const over = v.game.status === 'ended' || v.game.status === 'aborted';
    dl.append(el('dt', '', '当前'), el('dd', '', over ? '已落幕' : b.act ? b.act.title : '序幕'));
    if (b.stage) dl.append(el('dt', '', '环节'), el('dd', '', String(b.stage)));
    p.append(dl);
    out.push(p);
  }
  if (Array.isArray(b.cast) && b.cast.length) {
    const p = panel('角色');
    const ul = el('ul', 'cast');
    for (const c of b.cast) {
      const li = el('li');
      const txt = el('div');
      txt.append(el('div', 'rn', `${c.role}`), el('div', 'pub', `${c.seat}号 ${c.name}${c.public ? ` · ${c.public}` : ''}`));
      li.append(avatar(c.seat, true), txt);
      ul.append(li);
    }
    p.append(ul);
    out.push(p);
  }
  const sx = b.search;
  if (sx) {
    if (Array.isArray(sx.places) && sx.places.length) {
      const p = panel('搜证地点');
      const grid = el('div', 'places');
      for (const pl of sx.places) {
        const c = el('div', 'place');
        c.append(el('div', 'pn', pl.name), el('div', 'pl', `剩 ${pl.left} 张`));
        grid.append(c);
      }
      p.append(grid);
      out.push(p);
    }
    const p = panel('公开的线索');
    if (Array.isArray(sx.shared) && sx.shared.length) {
      for (const c of sx.shared) {
        const d = el('div', 'clue');
        d.append(el('div', 'ct', c.title), el('div', 'cb', `${label(c.by)} 公开`));
        if (c.text) d.append(el('div', 'cx', c.text));
        p.append(d);
      }
    } else p.append(el('p', 'empty', '还没有人公开线索。'));
    out.push(p);
  }
  if (b.votes && typeof b.votes === 'object') {
    const p = panel('投票');
    const dl = el('dl', 'kv');
    for (const [seat, to] of Object.entries(b.votes)) dl.append(el('dt', '', label(Number(seat))), el('dd', '', typeof to === 'number' ? `投 ${label(to)}` : String(to)));
    p.append(dl);
    out.push(p);
  }
  if (b.quiz?.scores) {
    const p = panel('问卷得分', b.quiz.mvp?.length ? `MVP：${b.quiz.mvp.map((/** @type {number} */ s) => label(s)).join('、')}` : '');
    const dl = el('dl', 'kv');
    for (const [seat, sc] of Object.entries(b.quiz.scores)) dl.append(el('dt', '', label(Number(seat))), el('dd', '', `${sc} 分`));
    p.append(dl);
    out.push(p);
  }
  if (out.length === 0) out.push(el('p', 'empty', '这个游戏还没有网页面板。'));
  return out;
}

function renderBoard() {
  const nodes = boardNodes();
  // 桌面三栏时面板固定在右栏，手机上在「面板」页签里
  const target = desktop.matches ? $('board-col') : $('pane-board');
  const other = desktop.matches ? $('pane-board') : $('board-col');
  other.replaceChildren();
  target.replaceChildren(...nodes);
}

// ───────── 记录 ─────────
const FILTERS = /** @type {[string,string,(e: Ev) => boolean][]} */ ([
  ['all', '全部', () => true],
  ['speech', '发言', (e) => typeof e.speech === 'string'],
  ['story', '旁白', (e) => typeof e.speech !== 'string' && e.kind !== 'search_log' && e.kind !== 'vote'],
  ['search', '搜证', (e) => e.kind.startsWith('search') || e.kind === 'clue'],
  ['vote', '投票', (e) => e.kind === 'vote' || /投票|票/.test(e.text.slice(0, 12))],
]);

function renderFilters() {
  const box = $('filters');
  box.replaceChildren();
  for (const [key, name] of FILTERS) {
    const c = el('button', 'chip', name);
    c.type = 'button';
    c.setAttribute('aria-pressed', String(!st.god && st.filter === key));
    c.addEventListener('click', () => {
      st.filter = key;
      st.god = false;
      renderFilters();
      renderLog();
    });
    box.append(c);
  }
  if (st.view?.replay) {
    const g = el('button', 'chip god', '上帝视角（复盘）');
    g.type = 'button';
    g.setAttribute('aria-pressed', String(st.god));
    g.title = '对局已结束：显示所有人的私密信息和行动';
    g.addEventListener('click', () => {
      st.god = !st.god;
      renderFilters();
      renderLog();
    });
    box.append(g);
  }
}

function renderLog() {
  const ol = $('timeline');
  ol.replaceChildren();
  if (st.god && st.view?.replay) {
    for (const e of st.view.replay) {
      const li = el('li');
      const tx = el('div', 'tx');
      if (e.audience !== 'public') {
        const who = typeof e.audience === 'object' ? `私密 · ${e.audience.seats.map((s) => `${s}号`).join('、')}` : '裁判';
        tx.append(el('span', 'aud', who));
      }
      tx.append(e.text);
      li.append(el('span', 'tt', hhmm(e.at)), tx);
      ol.append(li);
    }
    return;
  }
  const f = FILTERS.find((x) => x[0] === st.filter)?.[2] ?? (() => true);
  const list = st.events.filter(f);
  if (list.length === 0) ol.append(el('li', 'empty', '没有符合条件的记录。'));
  for (const e of list) {
    const li = el('li');
    const tx = el('div', 'tx');
    tx.append(withRefs(e.text));
    li.append(el('span', 'tt', hhmm(e.at)), tx);
    ol.append(li);
  }
}

// ───────── 顶栏、倒计时、提示条 ─────────
function renderHeader() {
  const v = st.view;
  if (!v) return;
  const b = v.board;
  const title = b?.script?.title ?? v.game.name;
  $('title').textContent = title;
  const parts = [];
  // 阶段标题里通常已经带着幕名（「第二幕·灯熄之后·搜证」）
  if (v.phase) parts.push(...v.phase.title.split('·'));
  else if (b?.act) parts.push(b.act.title);
  if (v.game.status === 'lobby') parts.push('报名中');
  else if (v.game.status === 'ended') parts.push('终幕');
  else if (v.game.status === 'aborted') parts.push('已中止');
  $('subtitle').textContent = parts.join(' · ') || v.game.name;
  document.title = `${title} · 灯下剧场`;
}

const RING = 2 * Math.PI * 19;
function tickClock() {
  const ph = st.view?.phase;
  const clock = $('clock');
  if (!ph || !ph.opened || ph.deadline === null) {
    clock.hidden = true;
    $('status-clock').hidden = true;
    return;
  }
  clock.hidden = false;
  const now = Date.now() + st.offset;
  const left = Math.max(0, ph.deadline - now);
  const s = Math.ceil(left / 1000);
  $('clock-text').textContent = s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}h` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const frac = ph.timeout_ms > 0 ? Math.min(1, left / ph.timeout_ms) : 0;
  $('ring').style.strokeDashoffset = String(RING * (1 - frac));
  clock.classList.toggle('urgent', s <= 30);
  const mini = $('status-clock');
  mini.hidden = false;
  mini.textContent = $('clock-text').textContent;
  mini.classList.toggle('urgent', s <= 30);
  clock.setAttribute('aria-label', `本环节剩余 ${s} 秒`);
}
setInterval(tickClock, 1000);

function renderStatus() {
  const v = st.view;
  const bar = $('status');
  const text = $('status-text');
  if (!v) return;
  let msg = '';
  const ph = v.phase;
  if (v.game.status === 'lobby') msg = `报名中，已有 ${v.lobby?.length ?? 0} 人。开局后这里会实时直播。`;
  else if (v.game.status === 'ended') msg = v.result ? `对局结束：${v.result.reason}` : '对局结束。';
  else if (v.game.status === 'aborted') msg = `对局已中止：${v.aborted ?? ''}`;
  else if (!ph) msg = '幕间准备中…';
  else if (!ph.opened) msg = `「${ph.title}」即将开始…`;
  else if (ph.secret) msg = `「${ph.title}」进行中：大家在私下行动。`;
  else if (ph.waiting.length === 1) msg = `等待 ${label(/** @type {number} */ (ph.waiting[0]))}`;
  else if (ph.waiting.length > 1) msg = `等待 ${ph.waiting.length} 人${ph.total ? `（共 ${ph.total} 人）` : ''}：${ph.waiting.map((s) => `${s}号`).join('、')}`;
  else msg = `「${ph.title}」结算中…`;
  text.textContent = msg;
  bar.classList.toggle('live', v.game.status === 'running');
}

function banner(/** @type {string|null} */ msg, error = false) {
  const b = $('banner');
  if (!msg) {
    b.hidden = true;
    return;
  }
  b.textContent = msg;
  b.classList.toggle('error', error);
  b.hidden = false;
}

// ───────── 观众席 ─────────
const chatOpen = () => $('tab-chat').getAttribute('aria-selected') === 'true';

function mergeChat(/** @type {Chat[]} */ list) {
  const last = st.chat.length ? st.chat[st.chat.length - 1].seq : 0;
  const fresh = list.filter((c) => c.seq > last);
  if (fresh.length) {
    st.chat.push(...fresh);
    if (st.chat.length > 500) st.chat.splice(0, st.chat.length - 500);
    if (chatOpen()) st.chatSeen = st.chat[st.chat.length - 1].seq;
    else if (fresh.some((c) => !st.mine.has(c.seq))) $('chat-dot').hidden = false;
  }
  renderChat();
}

function renderChat() {
  const box = $('chat-list');
  const atEnd = !desktop.matches || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.replaceChildren();
  if (!st.chat.length) box.append(el('li', 'empty', '还没有人说话。来当第一个吧～'));
  for (const c of st.chat) {
    const li = el('li', st.mine.has(c.seq) ? 'chat-msg mine' : 'chat-msg');
    const who = el('div', 'who');
    who.append(el('b', '', c.name), el('span', 'tag', c.from === 'agent' ? 'AI 观众' : '观众'), el('span', '', hhmm(c.at)));
    li.append(who, el('p', 'tx', c.text));
    box.append(li);
  }
  if (atEnd && chatOpen()) box.lastElementChild?.scrollIntoView({ block: 'nearest' });
  // 开局前观众席不开放
  const started = Boolean(st.view && st.view.game.started_at);
  for (const id of ['chat-name', 'chat-text', 'chat-send']) /** @type {HTMLInputElement} */ ($(id)).disabled = !started;
  /** @type {HTMLInputElement} */ ($('chat-text')).placeholder = started ? '说点什么…' : '开局后才能说话';
}

function chatError(/** @type {string|null} */ msg) {
  const e = $('chat-err');
  e.textContent = msg ?? '';
  e.hidden = !msg;
}

{
  const name = /** @type {HTMLInputElement} */ ($('chat-name'));
  try {
    name.value = localStorage.getItem('stage-nick') ?? '';
  } catch {
    /* 忽略 */
  }
  $('chat-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = /** @type {HTMLInputElement} */ ($('chat-text'));
    const send = /** @type {HTMLButtonElement} */ ($('chat-send'));
    if (!text.value.trim() || send.disabled) return;
    send.disabled = true;
    chatError(null);
    try {
      const r = await fetch(`api/games/${encodeURIComponent(gameId)}/chat?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), text: text.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || `发送失败（${r.status}）`);
      st.mine.add(Number(data.seq));
      text.value = '';
      try {
        localStorage.setItem('stage-nick', name.value.trim());
      } catch {
        /* 忽略 */
      }
      // 结束的局不再推送：自己拉一次
      if (st.view && st.view.game.status !== 'running') {
        const v = await fetchOnce();
        mergeChat(v.chat ?? []);
      }
    } catch (e) {
      chatError(e instanceof Error ? e.message : String(e));
    } finally {
      send.disabled = false;
      text.focus();
    }
  });
}

// ───────── 数据 ─────────
function apply(/** @type {View} */ v) {
  const first = st.view === null;
  st.offset = v.server_time - Date.now();
  const last = st.events.length ? /** @type {Ev} */ (st.events[st.events.length - 1]).seq : 0;
  for (const e of v.events) if (e.seq > last) st.events.push(e);
  // 复盘只在首包里带：增量包里没有时保留上一次的
  if (!v.replay && st.view?.replay) v.replay = st.view.replay;
  st.view = v;
  $('app').removeAttribute('aria-busy');
  renderHeader();
  renderSeats();
  renderFeed();
  renderBoard();
  if (first || v.replay) renderFilters();
  renderLog();
  renderStatus();
  tickClock();
  mergeChat(v.chat ?? []);
  if (v.game.status === 'aborted') banner(`对局已中止：${v.aborted ?? ''}。下面是已经发生的公开内容。`);
}

async function fetchOnce() {
  const r = await fetch(`api/games/${encodeURIComponent(gameId)}?t=${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (r.status === 404) throw new Error('notfound');
  if (!r.ok) throw new Error(`http ${r.status}`);
  return /** @type {Promise<View>} */ (r.json());
}

function connect() {
  const url = `api/games/${encodeURIComponent(gameId)}/stream?t=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  es.addEventListener('view', (ev) => {
    banner(null);
    apply(JSON.parse(/** @type {MessageEvent} */ (ev).data));
    if (st.view && (st.view.game.status === 'ended' || st.view.game.status === 'aborted')) es.close();
  });
  es.addEventListener('error', async () => {
    if (es.readyState === EventSource.CONNECTING) {
      banner('连接中断，正在重连…');
      return;
    }
    // 连接被拒（链接无效、连接太多）：查一下原因，过一会儿再试
    es.close();
    try {
      const v = await fetchOnce();
      apply(v);
      if (v.game.status === 'running' || v.game.status === 'lobby') setTimeout(connect, 5000);
    } catch (e) {
      if (e instanceof Error && e.message === 'notfound') fatal('链接无效或对局不存在。请回到群里，点最新的观战链接。');
      else {
        banner('连不上服务器，5 秒后重试…', true);
        setTimeout(connect, 5000);
      }
    }
  });
}

function fatal(/** @type {string} */ msg) {
  $('app').removeAttribute('aria-busy');
  $('title').textContent = '灯下剧场';
  $('subtitle').textContent = '';
  $('seats').replaceChildren();
  $('feed').replaceChildren(el('p', 'empty', msg));
  $('status-text').textContent = msg;
  banner(msg, true);
}

if (!gameId || !token) fatal('链接不完整：请从群里的观战链接进入。');
else connect();
