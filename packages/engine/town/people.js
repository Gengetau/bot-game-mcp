// 「居民」面板：认识的人、居民名录、日报。
import { avatar, dateTimeOf, h, toast } from './dom.js';
import { openLetterComposer } from './sheets.js';
import { http, spaceLabel, state } from './store.js';
import { btn, chip, empty, progress, row, section, segmented } from './ui.js';

/** @typedef {import('./types.js').Relation} Relation */
/** @typedef {import('./types.js').DirEntry} DirEntry */
/** @typedef {import('./types.js').Report} Report */

const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

/**
 * @param {string} date YYYY-MM-DD
 * @param {number} delta
 */
function shiftDate(date, delta) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function createPeople() {
  const el = h('div', { class: 'panel people' });
  let tab = 'rel';
  /** @type {Relation[] | null} */
  let relations = null;
  /** @type {DirEntry[] | null} */
  let dir = null;
  /** @type {{ personal: Report, public: Report } | null} */
  let reports = null;
  let reportDate = '';
  let error = '';
  /**
   * 每位认识的人的共同经历翻页状态：next 为 undefined 表示还没翻过（首页游标未知），null 表示没有更早的了。
   * @type {Map<string, { next: string | null | undefined, err: string }>}
   */
  const paging = new Map();

  /** @param {Relation} r */
  async function loadOlder(r) {
    const st = paging.get(r.id) ?? { next: undefined, err: '' };
    paging.set(r.id, st);
    st.err = '';
    // 列表接口不带每对的游标：第一次不带 before、按已显示的条数取第一页，把列表换成这一页（等于按已显示的条目去重）
    const first = st.next === undefined;
    const q = first ? `limit=${Math.min(30, r.memories.length + 10)}` : `before=${encodeURIComponent(String(st.next))}&limit=10`;
    const res = await http('GET', `/relations?with=${encodeURIComponent(r.id)}&${q}`).catch(() => null);
    if (res && res.status === 200 && Array.isArray(res.data.memories)) {
      /** @type {import('./types.js').Memory[]} */
      const got = res.data.memories;
      if (first) {
        const seen = new Set(got.map((m) => `${m.at}|${m.text}`));
        r.memories = [...got, ...r.memories.filter((m) => !seen.has(`${m.at}|${m.text}`))];
      } else r.memories = [...r.memories, ...got];
      st.next = res.data.next ?? null;
    } else st.err = res?.data?.message ?? '没能读到更早的往事，稍后再试。';
    render();
  }

  async function loadRel() {
    const r = await http('GET', '/relations').catch(() => null);
    if (r && r.status === 200) {
      relations = r.data.relations;
      paging.clear();
    }
    else error = r?.data?.message ?? '没能读到。';
    render();
  }
  async function loadDir() {
    const r = await http('GET', '/residents').catch(() => null);
    if (r && r.status === 200) dir = r.data.residents;
    else error = r?.data?.message ?? '没能读到。';
    render();
  }
  /** @param {string} [date] */
  async function loadReport(date) {
    const r = await http('GET', `/report${date ? `?date=${date}` : ''}`).catch(() => null);
    if (r && r.status === 200) {
      reports = r.data;
      reportDate = r.data.public.date;
    } else toast(r?.data?.message ?? '没能读到日报。', 'warn');
    render();
  }

  function loadTab() {
    error = '';
    if (tab === 'rel') void loadRel();
    else if (tab === 'dir') void loadDir();
    else void loadReport(reportDate || undefined);
  }

  /** @param {Report} r */
  function reportBlock(r) {
    return r.lines.length ? h('ul', { class: 'bullets report' }, r.lines.map((l) => h('li', null, l))) : h('p', { class: 'hint' }, '这一天没有可记的事。');
  }

  function render() {
    const me = state.me;
    if (!me) return;
    const seg = segmented(
      [
        { id: 'rel', label: '认识的人' },
        { id: 'dir', label: '居民' },
        { id: 'report', label: '日报' },
      ],
      tab,
      (id) => {
        tab = id;
        loadTab();
        render();
      },
      '居民分页',
    );
    /** @type {import('./dom.js').Child} */
    let body;
    if (tab === 'rel') {
      body = !relations
        ? h('p', { class: 'hint pad' }, '正在翻通讯录……')
        : relations.length
          ? h(
              'div',
              { class: 'stack' },
              relations.map((r) =>
                h(
                  'article',
                  { class: 'rel' },
                  h('div', { class: 'rel-top' }, avatar(r.name, 'human'), h('b', null, r.name), chip(r.level, r.level === '老朋友' || r.level === '朋友' ? 'moss' : r.level === '熟人' ? 'amber' : '')),
                  h('div', { class: 'rel-bar' }, h('span', { class: 'hint' }, '熟悉度'), progress(Math.min(r.familiarity, 50), 50, `与${r.name}的熟悉度`), h('b', null, String(r.familiarity))),
                  r.memories.length ? h('ul', { class: 'bullets' }, r.memories.map((m) => h('li', null, m.text, h('small', null, ` · ${dateTimeOf(m.at, tz())}`)))) : h('p', { class: 'hint' }, '还没有共同经历。'),
                  r.memories.length && paging.get(r.id)?.next !== null ? btn('更早的往事', () => loadOlder(r), { small: true, variant: 'ghost', always: true }) : null,
                  paging.get(r.id)?.err ? h('p', { class: 'err' }, paging.get(r.id)?.err) : null,
                ),
              ),
            )
          : empty('还没有认识的人', '和镇上的人说话、一起喝茶、互相送东西，就会慢慢认识。');
    } else if (tab === 'dir') {
      body = !dir
        ? h('p', { class: 'hint pad' }, '正在翻居民名录……')
        : h(
            'div',
            { class: 'stack' },
            dir.map((d) =>
              row({
                lead: avatar(d.name, d.kind, d.id === me.me.id),
                title: h('span', null, d.name, d.id === me.me.id ? chip('我', 'amber') : null, d.kind === 'agent' ? chip('AI', 'teal') : null, d.present ? chip('在镇上', 'moss') : chip('不在线', 'dim')),
                sub: [d.bio || '没有简介', d.titles.length ? `「${d.titles.join('」「')}」` : '', d.present && d.at ? `现在在${spaceLabel(d.at)}` : ''].filter(Boolean).join(' · '),
                aside: d.id === me.me.id ? null : btn('写信', () => openLetterComposer({ id: d.id, name: d.name, kind: /** @type {'human' | 'agent'} */ (d.kind) }), { small: true, variant: 'ghost', always: true, icon: 'mail' }),
              }),
            ),
          );
    } else {
      body = !reports
        ? h('p', { class: 'hint pad' }, '正在取日报……')
        : h(
            'div',
            { class: 'stack' },
            h('div', { class: 'date-nav' }, btn('前一天', () => loadReport(shiftDate(reportDate, -1)), { small: true, variant: 'ghost', always: true }), h('b', null, reportDate), btn('后一天', () => loadReport(shiftDate(reportDate, 1)), { small: true, variant: 'ghost', always: true, disabled: reportDate >= (me.world.date ?? '') })),
            section('我的一天', reportBlock(reports.personal), { hint: reports.personal.final ? undefined : '今天的稿子还没定，明天会更完整。' }),
            section('小镇日报', reportBlock(reports.public), { hint: '公开日报只写聚合的事，不点名私人往来。' }),
          );
    }
    el.replaceChildren(h('header', { class: 'panel-head' }, h('div', null, h('p', { class: 'eyebrow' }, '居民'), h('h2', null, '人与日子'))), h('div', { class: 'seg-wrap' }, seg), h('div', { class: 'panel-body' }, error ? h('p', { class: 'err' }, error) : null, body));
  }

  return {
    el,
    update() {
      if (!el.firstChild) render();
    },
    activate() {
      loadTab();
      render();
    },
  };
}
