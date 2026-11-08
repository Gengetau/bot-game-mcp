// @ts-check
/**
 * 桌游管理页（只在内网开放）。数据来自 /api/overview；写操作一律 JSON + X-Admin-Request: 1。
 * 所有文字当纯文本渲染，不拼 HTML。
 */

/**
 * @typedef {{ id: string, title: string, players: number, summary: string, roles: number, acts: number, images: number, clues: number, questions: number, is_default: boolean }} Script
 * @typedef {{ id: string, name: string, type: string, group_id: string, status: string, stage?: string, players: number, phase: string|null, round: number, referee: string|null, created_at: string, ended_at: string|null, watch_url: string|null }} Game
 * @typedef {{ id: string, name: string, owner: string|null, issued_at: string|null }} Key
 * @typedef {{
 *   server: { version: string, uptime_s: number, web_url: string|null, scripts_dir: boolean },
 *   scripts: Script[], script_errors: Record<string,string>, default_script: string|null, default_needed: boolean,
 *   games: { active: Game[], recent: Game[] }, keys: Key[]
 * }} Overview
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
  if (text != null) n.textContent = text;
  return n;
}

/** @param {string} text @param {boolean} [bad] */
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => (t.hidden = true), bad ? 6000 : 2500));
}

/** @param {string|null} iso */
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** @param {number} s */
function uptime(s) {
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
}

const STATUS = /** @type {Record<string,string>} */ ({ lobby: '报名中', running: '进行中', ended: '已结束', aborted: '已中止' });

/** @param {string} path @param {unknown} [body] @returns {Promise<Overview>} */
async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败（${res.status}）`);
  return data;
}

/** @param {string} path @param {unknown} body @param {string} okText */
async function act(path, body, okText) {
  try {
    render(await api(path, body));
    toast(okText);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
  }
}

/** @param {Overview} o */
function renderScripts(o) {
  const box = $('scripts');
  box.replaceChildren();
  const hint = $('scripts-hint');
  if (!o.server.scripts_dir) hint.textContent = '没有配置剧本库目录（scriptsDir），剧本杀用不了。';
  else if (!o.scripts.length) hint.textContent = '剧本库是空的。把剧本 JSON 放进剧本库目录，刷新就能看到。';
  else if (!o.default_needed) hint.textContent = '剧本库里只有一个剧本，开房时自动用它。';
  else if (o.default_script) hint.textContent = '群里开剧本杀没写 script= 时，用下面标着「默认」的剧本。';
  else hint.textContent = '还没设默认剧本：群里开剧本杀必须写 script=编号。设一个默认，以后直接「/桌游 剧本杀」就行。';

  for (const s of o.scripts) {
    const card = el('article', s.is_default ? 'card default' : 'card');
    card.append(el('h3', '', s.title), el('div', 'id', s.id));
    const chips = el('div', 'chips');
    if (s.is_default) chips.append(el('span', 'chip on', '默认'));
    chips.append(el('span', 'chip', `${s.players} 人`), el('span', 'chip', `${s.acts} 幕`), el('span', 'chip', `${s.clues} 条线索`));
    if (s.images) chips.append(el('span', 'chip', `${s.images} 张图`));
    if (s.questions) chips.append(el('span', 'chip', `${s.questions} 道问卷`));
    card.append(chips);
    if (s.summary) card.append(el('p', 'sum', s.summary));
    const actions = el('div', 'actions');
    if (s.is_default) {
      const b = el('button', 'btn', '取消默认');
      b.onclick = () => act('/api/default-script', { id: null }, '已取消默认剧本');
      actions.append(b);
    } else {
      const b = el('button', 'btn primary', '设为默认');
      b.onclick = () => act('/api/default-script', { id: s.id }, `默认剧本：${s.title}`);
      actions.append(b);
    }
    card.append(actions);
    box.append(card);
  }

  const errs = $('script-errors');
  errs.replaceChildren();
  const entries = Object.entries(o.script_errors);
  if (entries.length) {
    const div = el('div', 'errors');
    div.append(el('p', '', `有 ${entries.length} 个剧本文件读不出来：`));
    for (const [file, msg] of entries) div.append(el('p', '', `${file}：${msg}`));
    errs.append(div);
  }
}

/** @param {Game} g @param {boolean} active */
function gameRow(g, active) {
  const row = el('div', active ? 'row' : 'row compact');
  const main = el('div', 'main');
  main.append(el('div', 'title', `${g.name} · ${STATUS[g.status] ?? g.status}`));
  const bits = [g.id, `群 ${g.group_id}`, `${g.players} 人`];
  if (g.stage === 'web') bits.push('网页');
  if (active && g.phase) bits.push(g.round > 0 ? `第 ${g.round} 轮 · ${g.phase}` : g.phase);
  bits.push(active ? `开于 ${when(g.created_at)}` : `结束于 ${when(g.ended_at)}`);
  main.append(el('div', 'sub', bits.join(' · ')));
  row.append(main);
  if (g.watch_url) {
    const a = el('a', 'btn', '观战');
    a.href = g.watch_url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    row.append(a);
  }
  if (active) {
    const b = el('button', 'btn danger', '中止');
    b.onclick = () => {
      const msg = g.status === 'running'
        ? `中止「${g.name}」（${g.id}）？游戏会立刻结束，群里会收到通知。`
        : `取消「${g.name}」（${g.id}）的报名？`;
      if (confirm(msg)) act(`/api/games/${encodeURIComponent(g.id)}/abort`, {}, `已中止 ${g.id}`);
    };
    row.append(b);
  }
  return row;
}

/** @param {Overview} o */
function renderGames(o) {
  const a = $('games-active');
  a.replaceChildren(...o.games.active.map((g) => gameRow(g, true)));
  if (!o.games.active.length) a.append(el('div', 'empty', '现在没有对局。'));
  const r = $('games-recent');
  r.replaceChildren(...o.games.recent.map((g) => gameRow(g, false)));
  if (!o.games.recent.length) r.append(el('div', 'empty', '还没有结束的对局。'));
  $('tab-games').textContent = o.games.active.length ? `对局（${o.games.active.length}）` : '对局';
}

/** @param {Overview} o */
function renderKeys(o) {
  const box = $('keys');
  box.replaceChildren();
  if (!o.keys.length) box.append(el('div', 'empty', '没有运行时发出的密钥。'));
  for (const k of o.keys) {
    const row = el('div', 'row');
    const main = el('div', 'main');
    main.append(el('div', 'title', k.name), el('div', 'sub', [k.id, k.owner ? `申请人 ${k.owner}` : '', k.issued_at ? `发于 ${when(k.issued_at)}` : ''].filter(Boolean).join(' · ')));
    const b = el('button', 'btn danger', '作废');
    b.onclick = () => {
      if (confirm(`作废「${k.name}」的密钥？它要重新申请才能接入。`)) act(`/api/keys/${encodeURIComponent(k.id)}/revoke`, {}, `已作废 ${k.name}`);
    };
    row.append(main, b);
    box.append(row);
  }
}

/** @param {Overview} o */
function render(o) {
  $('meta').textContent = `引擎 ${o.server.version} · 已运行 ${uptime(o.server.uptime_s)} · ${o.scripts.length} 个剧本 · ${o.games.active.length} 局进行中`;
  renderScripts(o);
  renderGames(o);
  renderKeys(o);
}

async function refresh() {
  try {
    render(await api('/api/overview'));
  } catch (e) {
    $('meta').textContent = `连不上引擎：${e instanceof Error ? e.message : String(e)}`;
  }
}

// 标签页
const TABS = ['scripts', 'games', 'keys'];
/** @param {string} name */
function show(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
  try { localStorage.setItem('admin-tab', name); } catch { /* 不重要 */ }
}
for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => show(t));
try {
  const saved = localStorage.getItem('admin-tab');
  if (saved && TABS.includes(saved)) show(saved);
} catch { /* 不重要 */ }

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
