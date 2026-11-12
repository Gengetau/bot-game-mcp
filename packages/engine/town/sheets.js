// 弹层：居民资料、报价、地点、写信、读信、改资料、回顾。
import { avatar, confirmDialog, dateTimeOf, h, icon, openSheet, relTime, toast } from './dom.js';
import { openSpectate } from './game.js';
import { act, http, refreshMe, serverNow, spaceLabel, state } from './store.js';
import { btn, chip, empty, field, row, section, toggle } from './ui.js';

/** @typedef {import('./types.js').Card} Card */
/** @typedef {import('./types.js').Neighbor} Neighbor */
/** @typedef {import('./types.js').Offer} Offer */
/** @typedef {import('./types.js').Letter} Letter */
/** @typedef {import('./types.js').InvItem} InvItem */
/** @typedef {import('./dom.js').Child} Child */

const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

/** 可以放进「想要什么」的物品种类（对应 content.ts 里 tradable 为真的那些）。 */
const WANT_TYPES = [
  ['tea_leaves', '茶叶'],
  ['vegetables', '蔬菜'],
  ['seeds', '花种'],
  ['soup', '热汤'],
  ['cookie', '小饼干'],
  ['book', '书'],
  ['flower', '鲜花'],
  ['lantern', '小灯笼'],
  ['paper_lamp', '集市纸灯'],
];

/**
 * 出发去某处。
 * @param {string} to
 * @param {string} [name]
 */
export async function moveTo(to, name) {
  const r = await act({ type: 'move', to });
  if (r.ok) {
    const mv = /** @type {{ toName?: string, arriveAt?: number } | undefined} */ (r.move);
    const sec = mv?.arriveAt ? Math.max(1, Math.round((mv.arriveAt - serverNow()) / 1000)) : null;
    toast(`出发去${mv?.toName ?? name ?? '目的地'}${sec ? `，大约 ${sec} 秒` : ''}。`, 'ok', 2800);
  }
  return r;
}

// ───────────────────────── 居民资料 ─────────────────────────

/**
 * 点开身边的人。
 * @param {Neighbor} p
 */
export function openPerson(p) {
  const inv = state.me?.inventory;
  const lendable = inv?.items.some((i) => i.type === 'book' && i.available > 0 && !i.borrowedFrom) ?? false;
  const out = h('div', { class: 'ask-out', role: 'status', 'aria-live': 'polite' });
  const body = h(
    'div',
    { class: 'stack' },
    h('div', { class: 'person-head' }, avatar(p.name, p.kind), h('div', null, h('h3', null, p.name), h('div', { class: 'chips' }, chip(p.kind === 'agent' ? 'AI 居民' : '真人居民', p.kind === 'agent' ? 'teal' : 'amber'), p.mood ? chip(`心情：${p.mood}`) : null, ...p.titles.map((t) => chip(`「${t}」`, 'moss'))))),
    p.bio ? h('p', { class: 'para' }, p.bio) : h('p', { class: 'hint' }, 'TA 还没有写简介。'),
    p.traits.length ? h('div', { class: 'chips' }, p.traits.map((t) => chip(t))) : null,
    out,
    section(
      '和 TA 互动',
      h(
        'div',
        { class: 'action-grid' },
        btn(
          '当面问爱好',
          async () => {
            const r = await act({ type: 'ask_hobby', target: p.id });
            if (r.ok) out.textContent = String(r.text ?? '');
          },
          { icon: 'chat', variant: 'soft' },
        ),
        btn('送礼', () => ((sh.close(), openOfferComposer('gift', p))), { icon: 'gift', variant: 'soft' }),
        btn('交换', () => ((sh.close(), openOfferComposer('trade', p))), { icon: 'refresh', variant: 'soft' }),
        btn('出借一本书', () => ((sh.close(), openOfferComposer('loan', p))), { icon: 'book', variant: 'soft', disabled: !lendable, why: lendable ? undefined : '你手上没有可以出借的自己的书。' }),
        btn(
          '邀请来家里',
          async () => {
            const ok = await confirmDialog({ title: `邀请${p.name}来家里`, text: `${p.name}会收到一份 24 小时有效的邀请，可以进你家。你随时可以撤销。`, ok: '发出邀请' });
            if (ok) {
              const r = await act({ type: 'invite', to: p.id });
              if (r.ok) toast(`已邀请${p.name}。`, 'ok');
            }
          },
          { icon: 'home', variant: 'soft' },
        ),
        btn('写信', () => ((sh.close(), openLetterComposer({ id: p.id, name: p.name, kind: p.kind }))), { icon: 'mail', variant: 'soft', always: true }),
      ),
      { hint: '送礼、交换、出借会先预留你的东西，对方接受后才转移。' },
    ),
  );
  const sh = openSheet({ title: p.name, body });
  return sh;
}

// ───────────────────────── 报价 ─────────────────────────

/**
 * 发起送礼 / 交换 / 出借。
 * @param {'gift' | 'trade' | 'loan'} kind
 * @param {Card} target
 */
export function openOfferComposer(kind, target) {
  const inv = state.me?.inventory;
  if (!inv) return;
  const verb = { gift: '送给', trade: '交换给', loan: '借给' }[kind];
  const coinsIn = h('input', { type: 'number', min: 0, max: inv.coins.available, value: 0, inputMode: 'numeric', class: 'text-input narrow' });
  const mine = inv.items.filter((i) => i.available > 0 && !i.borrowedFrom && i.category !== 'furniture' && (kind !== 'loan' || i.type === 'book'));
  /** @type {{ item: InvItem, check: HTMLInputElement, qty: HTMLInputElement }[]} */
  const picks = mine.map((item) => {
    const unique = item.category === 'usable';
    const check = h('input', { type: 'checkbox', 'aria-label': `选 ${item.name}`, class: kind === 'loan' ? 'single' : '' });
    const qty = h('input', { type: 'number', min: 1, max: item.available, value: 1, class: 'text-input narrow', 'aria-label': `${item.name} 数量`, disabled: unique });
    return { item, check, qty };
  });
  const wantType = h('select', { class: 'text-input', 'aria-label': '想换的东西' }, h('option', { value: '' }, '（不要东西）'), WANT_TYPES.map(([id, nm]) => h('option', { value: id }, nm)));
  const wantQty = h('input', { type: 'number', min: 1, max: 20, value: 1, class: 'text-input narrow', 'aria-label': '想换的数量' });
  const wantCoins = h('input', { type: 'number', min: 0, max: 1000, value: 0, class: 'text-input narrow', 'aria-label': '想要的硬币' });
  const summary = h('div', { class: 'summary', role: 'status', 'aria-live': 'polite' });
  const err = h('p', { class: 'err', role: 'alert' });

  /** 从表单读出 give / want 的结构 */
  function collect() {
    /** @type {{ coins?: number, items?: Record<string, unknown>[] }} */
    const give = {};
    const c = Math.floor(Number(coinsIn.value) || 0);
    if (kind !== 'loan' && c > 0) give.coins = c;
    /** @type {string[]} */
    const parts = [];
    if (give.coins) parts.push(`${give.coins} 枚硬币`);
    for (const p of picks) {
      if (!p.check.checked) continue;
      const unique = p.item.category === 'usable';
      const q = unique ? 1 : Math.max(1, Math.min(p.item.available, Math.floor(Number(p.qty.value) || 1)));
      (give.items ??= []).push(unique ? { itemId: p.item.itemId } : { type: p.item.type, qty: q });
      parts.push(unique ? p.item.name : `${q} 份${p.item.name}`);
    }
    /** @type {{ coins?: number, items?: Record<string, unknown>[] }} */
    const want = {};
    /** @type {string[]} */
    const wparts = [];
    if (kind === 'trade') {
      const wc = Math.floor(Number(wantCoins.value) || 0);
      if (wc > 0) {
        want.coins = wc;
        wparts.push(`${wc} 枚硬币`);
      }
      if (wantType.value) {
        const q = Math.max(1, Math.floor(Number(wantQty.value) || 1));
        want.items = [{ type: wantType.value, qty: q }];
        wparts.push(`${q} 份${WANT_TYPES.find((x) => x[0] === wantType.value)?.[1] ?? ''}`);
      }
    }
    return { give, want, parts, wparts };
  }

  function refresh() {
    const { parts, wparts } = collect();
    summary.replaceChildren(
      h('p', null, h('b', null, '你将交出：'), parts.length ? parts.join('、') : '（还没选）'),
      kind === 'trade' ? h('p', null, h('b', null, `换回${target.name}的：`), wparts.length ? wparts.join('、') : '（还没选）') : null,
      h('p', { class: 'hint' }, kind === 'loan' ? `书借出后所有权不变，3 天内要还；${target.name}接受时才会真的转到 TA 手上。` : `发出时会先预留你要交出的东西，${target.name}接受后才转移。`),
      h('p', { class: 'hint' }, '对方 10 分钟内没回应、任何一方离开或进入小游戏，报价自动撤销，预留退回。'),
    );
  }

  const form = h(
    'form',
    {
      class: 'stack',
      oninput: refresh,
      onchange: refresh,
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const { give, want, parts, wparts } = collect();
        err.textContent = '';
        if (!parts.length) {
          err.textContent = '先选一点要交出的东西。';
          return;
        }
        if (kind === 'trade' && !wparts.length) {
          err.textContent = '交换要写清楚想换什么；白送请用「送礼」。';
          return;
        }
        if (kind === 'loan' && (give.items?.length ?? 0) !== 1) {
          err.textContent = '一次只能借出一件。';
          return;
        }
        const r = await act({ type: 'offer', kind, to: target.id, give, ...(kind === 'trade' ? { want } : {}) });
        if (r.ok) {
          toast(`报价已发给${target.name}，等 TA 回应。`, 'ok');
          sh.close();
        } else err.textContent = r.message ?? '没能发出。';
      },
    },
    h('p', { class: 'hint' }, `当面${verb}${target.name}。对方要在你身边才能收到。`),
    kind !== 'loan' ? h('div', { class: 'field inline' }, h('label', null, '硬币'), coinsIn, h('span', { class: 'hint' }, `可用 ${inv.coins.available} 枚（已预留 ${inv.coins.reserved}）`)) : null,
    mine.length
      ? h('fieldset', { class: 'pick-list' }, h('legend', null, kind === 'loan' ? '借出哪本书（选一本）' : '物品'), picks.map((p) => h('label', { class: 'pick' }, p.check, h('span', null, p.item.name, h('small', null, p.item.category === 'usable' ? '' : ` 有 ${p.item.available} 份`)), p.qty)))
      : h('p', { class: 'hint' }, kind === 'loan' ? '你手上没有可以出借的书。' : '你的背包里没有可以交出的东西（摆出来的装饰先收起来，借来的东西要先还）。'),
    kind === 'trade' ? h('fieldset', { class: 'pick-list' }, h('legend', null, `想换${target.name}的什么`), h('div', { class: 'field inline' }, wantType, wantQty), h('div', { class: 'field inline' }, h('label', null, '或硬币'), wantCoins)) : null,
    summary,
    err,
    h('div', { class: 'row-end' }, btn('取消', () => sh.close(), { variant: 'ghost', always: true }), h('button', { class: 'btn primary', type: 'submit', disabled: state.readOnly }, '发出报价')),
  );
  if (kind === 'loan') {
    // 出借一次一件：勾一个，其余取消
    for (const p of picks) p.check.addEventListener('change', () => p.check.checked && picks.forEach((o) => o !== p && (o.check.checked = false)));
  }
  refresh();
  const sh = openSheet({ title: `${{ gift: '送礼', trade: '交换', loan: '出借' }[kind]}给${target.name}`, body: form });
}

/**
 * 接受前确认：说清楚代价。
 * @param {Offer} o
 */
export async function acceptOffer(o) {
  const ok = await confirmDialog({ title: '接受这份报价？', text: h('div', { class: 'stack' }, h('p', null, o.text), o.kind === 'trade' ? h('p', { class: 'hint' }, '接受后，双方的东西会同时转移，不能反悔。') : o.kind === 'loan' ? h('p', { class: 'hint' }, '这是借用：用完要按时还给主人（3 天内）。') : h('p', { class: 'hint' }, '这是对方送你的礼物。')), ok: '接受' });
  if (!ok) return;
  const r = await act({ type: 'accept_offer', offerId: o.id });
  if (r.ok) toast('成交了。', 'ok');
}

// ───────────────────────── 地点 ─────────────────────────

/**
 * 点地图上的地点。
 * @param {string} id
 */
export function openPlace(id) {
  const pub = state.pub;
  const me = state.me;
  const place = pub?.places.find((p) => p.id === id);
  const isRes = id === 'residential';
  const name = isRes ? '住宅区' : (place?.name ?? spaceLabel(id));
  const residents = isRes ? (pub?.residential.residents ?? []) : (place?.residents ?? []);
  const here = me ? (isRes ? Boolean(me.location.space && (me.location.space.startsWith('home:') || me.location.space.startsWith('street_'))) : me.location.space === id) : false;
  const events = (pub?.events ?? []).filter((e) => e.place === id);
  const acts = place?.activities ?? [];
  const body = h(
    'div',
    { class: 'stack' },
    h('p', { class: 'para' }, isRes ? '大家住的地方。公开层面只知道有多少人在住宅区，不分哪条巷子、哪一家。' : (place?.blurb ?? '')),
    residents.length ? section(`在场（${residents.length}）`, h('div', { class: 'chips' }, residents.map((r) => h('span', { class: 'chip person' }, avatar(r.name, r.kind), r.name)))) : h('p', { class: 'hint' }, isRes ? '住宅区里现在没有登记在场的居民。' : '现在这里没有人。'),
    events.length ? section('今天的公共事件', h('div', { class: 'stack' }, events.map((e) => h('div', { class: 'ev' }, h('b', null, e.title), h('span', { class: 'hint' }, ` ${e.status === 'open' ? '进行中' : e.status === 'scheduled' ? `${dateTimeOf(e.opensAt, tz())} 开始` : e.status === 'missed' ? '错过了' : '已结束'}`), h('p', { class: 'hint' }, e.text))))) : null,
    acts.length
      ? section(
          '这里的桌游',
          h(
            'div',
            { class: 'stack' },
            acts.map((a) => row({ lead: icon('dice', 20), title: a.name, sub: `${a.status === 'running' ? '进行中' : '在凑人'} · ${a.players} 人`, aside: a.status === 'running' ? btn('观战', () => openSpectate(a.id, a.name), { small: true, always: true, icon: 'eye' }) : null })),
          ),
        )
      : null,
  );
  /** @type {Child[]} */
  const actions = [];
  if (me && !me.game) {
    if (isRes) {
      actions.push(btn('回家', async () => (sh.close(), moveTo('home', '家')), { variant: 'primary', icon: 'home' }));
      actions.push(btn('去东灯巷', async () => (sh.close(), moveTo('street_east', '东灯巷')), { variant: 'ghost' }));
      actions.push(btn('去西灯巷', async () => (sh.close(), moveTo('street_west', '西灯巷')), { variant: 'ghost' }));
      for (const inv of me.invites.received) actions.push(btn(`去${inv.host.name}家`, async () => (sh.close(), moveTo(inv.home, `${inv.host.name}家`)), { variant: 'soft', icon: 'home' }));
    } else if (here) actions.push(h('p', { class: 'hint' }, '你就在这里。'));
    else if (me.location.moving) actions.push(h('p', { class: 'hint' }, '你正在路上，到了再决定下一步。'));
    else actions.push(btn(`前往${name}`, async () => (sh.close(), moveTo(id, name)), { variant: 'primary', icon: 'walk' }));
  } else if (me?.game) actions.push(h('p', { class: 'hint' }, '你正在一局游戏里，先打完或退出这局才能走动。'));
  else actions.push(h('p', { class: 'hint' }, '进入小镇之后，点这里可以前往。'));
  body.appendChild(h('div', { class: 'action-grid' }, actions));
  const sh = openSheet({ title: name, body });
}

// ───────────────────────── 写信与读信 ─────────────────────────

/**
 * 写信。
 * @param {Card | null} [to]
 */
export async function openLetterComposer(to = null) {
  const r = await http('GET', '/residents').catch(() => null);
  /** @type {import('./types.js').DirEntry[]} */
  const all = r && r.status === 200 ? r.data.residents : [];
  const others = all.filter((x) => x.id !== state.me?.me.id);
  const max = state.config?.limits.letterMaxChars ?? 1000;
  const select = h('select', { class: 'text-input', required: true }, h('option', { value: '' }, '选一位收信人'), others.map((o) => h('option', { value: o.id, selected: to?.id === o.id }, `${o.name}${o.kind === 'agent' ? '（AI）' : ''}${o.present ? '' : ' · 不在线'}`)));
  const text = h('textarea', { rows: 7, maxLength: max, class: 'text-input', placeholder: '写点什么吧……', required: true });
  const count = h('span', { class: 'hint' }, `0 / ${max}`);
  text.addEventListener('input', () => (count.textContent = `${[...text.value].length} / ${max}`));
  const invite = h('input', { type: 'checkbox' });
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        err.textContent = '';
        if (!select.value) {
          err.textContent = '请选收信人。';
          return;
        }
        const res = await act({ type: 'send_letter', to: select.value, body: text.value, ...(invite.checked ? { invite: { reentry: true } } : {}) });
        if (res.ok) {
          toast(String(res.text ?? '信寄出了。'), 'ok');
          sh.close();
          window.dispatchEvent(new CustomEvent('town:letters-changed'));
        } else err.textContent = res.message ?? '没能寄出。';
      },
    },
    field('收信人', select, others.length ? undefined : '镇上还没有别的居民。'),
    field('信的内容', text),
    h('div', { class: 'row-between' }, count, h('span', { class: 'hint' }, '约 1 分钟后送到')),
    h('label', { class: 'check' }, invite, h('span', null, '随信附一份登门邀请（对方读到信之后，可以来你家做客，24 小时有效）')),
    err,
    h('div', { class: 'row-end' }, btn('取消', () => sh.close(), { variant: 'ghost', always: true }), h('button', { class: 'btn primary', type: 'submit', disabled: state.readOnly }, '寄出')),
  );
  const sh = openSheet({ title: '写信', body: form });
}

/**
 * 读一封信。
 * @param {Letter} l
 */
export function openLetter(l) {
  const me = state.me;
  const mine = l.box === 'sent';
  const other = mine ? l.to : l.from;
  const grant = l.invite && me ? me.invites.received.find((i) => i.grantId === l.invite?.grantId) : null;
  const body = h(
    'div',
    { class: 'stack letter' },
    h('p', { class: 'hint' }, `${mine ? '寄给' : '来自'} ${other.name} · ${dateTimeOf(l.sentAt, tz())}`),
    l.body !== undefined ? h('p', { class: 'para letter-body' }, l.body) : h('p', { class: 'hint' }, '新来的信要回到自己家才能拆开读。'),
    l.invite ? h('div', { class: 'note' }, icon('home', 16), l.invite.active ? ` 随信附有登门邀请，有效到 ${dateTimeOf(l.invite.expiresAt, tz())}。` : ' 随信附的登门邀请已经失效。') : null,
    h(
      'div',
      { class: 'action-grid' },
      grant ? btn(`去${grant.host.name}家`, async () => (sh.close(), moveTo(grant.home, `${grant.host.name}家`)), { variant: 'primary', icon: 'walk' }) : null,
      !mine ? btn('回信', () => (sh.close(), openLetterComposer(other)), { icon: 'mail', variant: 'soft', always: true }) : null,
      btn(
        '删除',
        async () => {
          const ok = await confirmDialog({ title: '删除这封信？', text: '删除后你的信箱里就没有它了。', ok: '删除', danger: true });
          if (!ok) return;
          const r = await act({ type: 'delete_letter', letterId: l.id });
          if (r.ok) {
            sh.close();
            window.dispatchEvent(new CustomEvent('town:letters-changed'));
          }
        },
        { variant: 'ghost' },
      ),
    ),
  );
  const sh = openSheet({ title: mine ? `给 ${other.name} 的信` : `${other.name} 的来信`, body });
}

// ───────────────────────── 改资料 ─────────────────────────

export function openProfileEditor() {
  const me = state.me;
  const cfg = state.config;
  if (!me || !cfg) return;
  const name = h('input', { type: 'text', value: me.me.name, maxLength: 16, class: 'text-input', required: true });
  const bio = h('textarea', { rows: 3, maxLength: 80, class: 'text-input' }, me.me.bio);
  const traitSet = new Set(me.me.traits.map((t) => t.id));
  const intSet = new Set(me.me.interests.map((t) => t.id));
  const err = h('p', { class: 'err', role: 'alert' });
  const pick = (/** @type {{ id: string, name: string, hint?: string }[]} */ list, /** @type {Set<string>} */ set, /** @type {number} */ limit, /** @type {string} */ label) => {
    const wrap = h('fieldset', { class: 'chips-pick' }, h('legend', null, `${label}（最多 ${limit} 个）`));
    for (const t of list) {
      const input = h('input', { type: 'checkbox', checked: set.has(t.id), onchange: () => {
        if (input.checked) {
          if (set.size >= limit) {
            input.checked = false;
            toast(`${label}最多选 ${limit} 个。`, 'warn');
            return;
          }
          set.add(t.id);
        } else set.delete(t.id);
      } });
      wrap.appendChild(h('label', { class: 'pill' }, input, h('span', null, t.name, t.hint ? h('small', null, t.hint) : null)));
    }
    return wrap;
  };
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        err.textContent = '';
        const r = await act({ type: 'update_profile', name: name.value, bio: bio.value, traits: [...traitSet], interests: [...intSet] });
        if (r.ok) {
          toast('资料已更新。', 'ok');
          sh.close();
        } else err.textContent = r.message ?? '没能保存。';
      },
    },
    field('名字', name, '最多 16 个字，镇上不能重名。'),
    field('简介', bio, '最多 80 字，同一处的人点开你就能看到。'),
    pick(cfg.traits, traitSet, cfg.limits.traits, '个性倾向'),
    pick(cfg.interests, intSet, cfg.limits.interests, '兴趣'),
    err,
    h('div', { class: 'row-end' }, btn('取消', () => sh.close(), { variant: 'ghost', always: true }), h('button', { class: 'btn primary', type: 'submit', disabled: state.readOnly }, '保存')),
  );
  const sh = openSheet({ title: '改资料', body: form });
}

/** 展示与隐私设置里的情绪文字。 */
export function openMoodEditor() {
  const me = state.me;
  if (!me) return;
  const input = h('input', { type: 'text', maxLength: 12, class: 'text-input', value: me.me.settings.moodOverride ?? '', placeholder: '比如：有点困' });
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const r = await act({ type: 'update_profile', mood: input.value.trim() || null });
        if (r.ok) sh.close();
      },
    },
    field('我的情绪（别人看到的）', input, '留空就交回给程序，由你做的事情决定。'),
    h('div', { class: 'row-end' }, btn('取消', () => sh.close(), { variant: 'ghost', always: true }), h('button', { class: 'btn primary', type: 'submit', disabled: state.readOnly }, '保存')),
  );
  const sh = openSheet({ title: '设置情绪', body: form });
}

// ───────────────────────── 回顾 ─────────────────────────

/** 离开超过十分钟再回来时的回顾。 */
export function openRecap() {
  const rc = state.recap;
  if (!rc) return;
  state.recap = null;
  const body = h(
    'div',
    { class: 'stack' },
    h('p', { class: 'hint' }, `你上次在镇上是 ${relTime(rc.since, serverNow())}。这是你有权知道的变化：`),
    rc.lines.length ? h('ul', { class: 'recap-list' }, rc.lines.map((l) => h('li', null, l))) : empty('没有什么大事', '小镇一切照常。'),
    h('div', { class: 'row-end' }, btn('进入小镇', () => sh.close(), { variant: 'primary', always: true })),
  );
  const sh = openSheet({ title: '欢迎回来', body });
}

/** 刷新一下（供外部在弹层关闭后使用）。 */
export const reload = () => refreshMe(true);
