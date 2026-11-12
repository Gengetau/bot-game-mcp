// 「现场」面板：身边的人、聊天、报价、物件与共同活动、商店、书屋、凑桌、出口。
import { avatar, clockOf, confirmDialog, fill, h, icon, toast } from './dom.js';
import { openSpectate } from './game.js';
import { acceptOffer, moveTo, openPerson } from './sheets.js';
import { act, loadOlderChat, serverNow, state } from './store.js';
import { btn, chip, countdown, empty, row, section, segmented } from './ui.js';

/** @typedef {import('./types.js').Offer} Offer */
/** @typedef {import('./types.js').PlaceObject} PlaceObject */
/** @typedef {import('./types.js').Lobby} Lobby */
/** @typedef {import('./types.js').MeView} MeView */
/** @typedef {import('./types.js').Here} Here */

const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

/** 这一趟导航最初被看到的时间（进度条的起点） */
const navSeen = { id: '', t0: 0 };

/** 当前子页：聊天 / 此处 */
let sub = 'chat';

/**
 * 移动中的进度条（由 app 的秒表刷新）。
 * @param {number} t0
 * @param {number} t1
 */
export function travel(t0, t1) {
  return h('div', { class: 'travel', dataset: { t0: String(t0), t1: String(t1) } }, h('div', { class: 'travel-bar' }, h('i')), h('span', { class: 'travel-text' }, ''));
}

/** @param {Offer} o @param {string} myId */
function offerCard(o, myId) {
  const incoming = o.to.id === myId;
  const kindName = { gift: '礼物', trade: '交换', loan: '出借' }[o.kind];
  return h(
    'div',
    { class: `offer ${incoming ? 'in' : 'out'}` },
    h('div', { class: 'offer-top' }, chip(incoming ? `收到的${kindName}` : `发出的${kindName}`, incoming ? 'amber' : ''), h('span', { class: 'hint' }, countdown(o.expiresAt, '还有 '))),
    h('p', { class: 'offer-text' }, o.text),
    h('div', { class: 'row-wrap' }, incoming ? [btn('接受', () => acceptOffer(o), { variant: 'primary', small: true }), btn('婉拒', () => act({ type: 'decline_offer', offerId: o.id }), { variant: 'ghost', small: true })] : btn('撤回', () => act({ type: 'cancel_offer', offerId: o.id }), { variant: 'ghost', small: true })),
  );
}

/** 本人拥有的书（可以拿来读） @param {MeView} me */
function ownBooks(me) {
  return me.inventory.items.filter((i) => i.type === 'book');
}

/**
 * 物件与共同活动。
 * @param {PlaceObject} o
 * @param {MeView} me
 */
function objectCard(o, me) {
  const a = o.action;
  const active = o.active;
  const inIt = Boolean(active?.participants.some((p) => p.id === me.me.id));
  const iHost = active?.initiator.id === me.me.id;
  const busy = Boolean(me.interaction);
  /** @type {import('./dom.js').Child[]} */
  const btns = [];
  /** @type {HTMLSelectElement | null} */
  let bookSel = null;
  if (!o.near && (a || active)) {
    // 公共物件按距离算：要先走到旁边
    btns.push(btn('先走过去', () => moveTo(o.id, o.label), { variant: 'primary', small: true, icon: 'walk', disabled: Boolean(me.game) }));
  } else if (a && !active) {
    if (a.def === 'read' && ownBooks(me).length) {
      bookSel = h('select', { class: 'text-input sm', 'aria-label': '读哪本书' }, h('option', { value: '' }, '读书架上的书'), ownBooks(me).map((b) => h('option', { value: b.itemId }, b.name)));
      btns.push(bookSel);
    }
    const sel = bookSel;
    const why = busy ? '你手上还有一件事没做完。' : undefined;
    const base = () => ({ type: 'start_interaction', objectId: o.id, ...(sel?.value ? { itemId: sel.value } : {}) });
    if (a.min <= 1) {
      btns.push(btn(a.def === 'rest' ? '休息一会儿' : '开始', () => act(base()), { variant: 'primary', small: true, disabled: busy, why }));
      if (a.max > 1) btns.push(btn('等人一起', () => act({ ...base(), wait: true }), { variant: 'ghost', small: true, disabled: busy, why }));
    } else btns.push(btn('发起并等人', () => act(base()), { variant: 'primary', small: true, disabled: busy, why }));
  } else if (active) {
    if (active.status === 'open') {
      if (!inIt) btns.push(btn('加入', () => act({ type: 'join_interaction', interactionId: active.id }), { variant: 'primary', small: true, disabled: busy || active.participants.length >= active.max, why: busy ? '你手上还有一件事没做完。' : '人已经满了。' }));
      if (iHost) btns.push(btn('开始', () => act({ type: 'begin_interaction', interactionId: active.id }), { variant: 'primary', small: true, disabled: active.participants.length < active.min, why: `至少要 ${active.min} 个人，现在 ${active.participants.length} 个。` }));
      if (inIt) btns.push(btn(iHost ? '取消（投入退回）' : '退出', () => act({ type: 'leave_interaction' }), { variant: 'ghost', small: true }));
    } else if (inIt) {
      btns.push(
        btn(
          '中途退出',
          async () => {
            const ok = await confirmDialog({ title: '中途退出？', text: '开始之后退出，这一次不会有收获，投入的东西也不退。', ok: '退出', danger: true });
            if (ok) await act({ type: 'leave_interaction' });
          },
          { variant: 'ghost', small: true },
        ),
      );
    }
  }
  return h(
    'div',
    { class: `obj${active ? ' live' : ''}` },
    h('div', { class: 'obj-head' }, h('b', null, o.label), a ? chip(a.name, 'amber') : chip('摆设')),
    a ? h('p', { class: 'hint' }, o.near ? a.cost : `${a.cost} · 离得有点远，先走到旁边`) : null,
    active
      ? h(
          'p',
          { class: 'obj-state' },
          `${active.name} · ${active.status === 'open' ? `等人中（${active.participants.length}/${active.min}~${active.max}）` : '进行中'}：${active.participants.map((p) => p.name).join('、')}`,
          active.endsAt ? h('span', null, ' · ', countdown(active.endsAt, '还有 ')) : active.status === 'open' ? h('span', null, ' · ', countdown(active.lobbyExpiresAt, '等到 ')) : null,
        )
      : null,
    btns.length ? h('div', { class: 'row-wrap' }, btns) : null,
  );
}

/**
 * 凑桌。
 * @param {Lobby} l
 * @param {MeView} me
 */
function lobbyCard(l, me) {
  const inIt = l.players.some((p) => p.id === me.me.id);
  const host = l.host.id === me.me.id;
  const inAny = Boolean(me.here?.activities.some((x) => x.status === 'forming' && x.players.some((p) => p.id === me.me.id)));
  // 凑桌 / 加入 / 开局都要站在那张游戏桌旁边：太远就先走过去
  const table = me.here?.tables?.find((t) => t.id === l.tableId);
  const far = Boolean(table && !table.near);
  /** @type {import('./dom.js').Child[]} */
  const btns = [];
  if (l.status === 'forming' && far && table && (inIt || !inAny)) btns.push(btn('先走到桌边', () => moveTo(table.id, table.name), { variant: 'primary', small: true, icon: 'walk', disabled: Boolean(me.game) }));
  if (l.status === 'running') btns.push(btn('观战', () => openSpectate(l.id, l.name), { small: true, icon: 'eye', always: true }));
  else if (inIt) {
    if (host && !far) btns.push(btn('开局', () => act({ type: 'start_game', activityId: l.id }), { variant: 'primary', small: true, disabled: l.players.length < l.min, why: `${l.name}至少要 ${l.min} 个人，现在 ${l.players.length} 个。` }));
    btns.push(btn(host ? '解散这桌' : '退出', () => act({ type: 'leave_game_lobby' }), { variant: 'ghost', small: true }));
  } else btns.push(btn('加入', () => act({ type: 'join_game', activityId: l.id, ...(l.tableId ? { objectId: l.tableId } : {}) }), { variant: 'primary', small: true, disabled: far || inAny || l.players.length >= l.max, why: inAny ? '你已经在一桌里了。' : '这一桌满了。' }));
  return h(
    'div',
    { class: `obj${l.status === 'running' ? ' live' : ''}` },
    h('div', { class: 'obj-head' }, h('b', null, l.name), chip(l.status === 'running' ? '进行中' : '凑人中', l.status === 'running' ? 'moss' : 'amber')),
    h('p', { class: 'obj-state' }, `发起人 ${l.host.name} · ${l.players.length}/${l.min}~${l.max} 人：${l.players.map((p) => p.name).join('、')}`, l.status === 'forming' ? h('span', null, ' · ', countdown(l.lobbyExpiresAt, '等到 ')) : null),
    h('div', { class: 'row-wrap' }, btns),
  );
}

/**
 * 商店一行商品。
 * @param {string} shopId
 * @param {{ sku: string, name: string, price: number, stock: number, note?: string }} g
 * @param {MeView} me
 */
function goodRow(shopId, g, me) {
  const qty = h('input', { type: 'number', min: 1, max: Math.max(1, Math.min(10, g.stock)), value: 1, class: 'text-input narrow', 'aria-label': `${g.name} 购买数量`, inputMode: 'numeric' });
  const q = () => Math.max(1, Math.min(10, Math.floor(Number(qty.value) || 1)));
  const sold = g.stock <= 0;
  return h(
    'div',
    { class: 'good' },
    h('div', { class: 'good-main' }, h('b', null, g.name), g.note ? chip(g.note, 'amber') : null, h('span', { class: 'hint' }, sold ? '今天卖完了' : `余 ${g.stock}`)),
    h('div', { class: 'good-buy' }, h('span', { class: 'price' }, icon('coin', 14), String(g.price)), qty, btn('买', async () => {
      const n = q();
      const cost = n * g.price;
      if (cost > me.inventory.coins.available) {
        toast(`硬币不够：要 ${cost} 枚，你可用 ${me.inventory.coins.available} 枚。`, 'warn');
        return;
      }
      const r = await act({ type: 'buy', shop: shopId, sku: g.sku, qty: n });
      if (r.ok) toast(String(r.text ?? '买好了。'), 'ok', 2800);
    }, { small: true, variant: 'soft', disabled: sold, why: sold ? '今天卖完了，明天再来。' : undefined })),
  );
}

// ───────────────────────── 面板 ─────────────────────────

export function createHere() {
  const head = h('header', { class: 'panel-head' });
  const offersBox = h('div', { class: 'offers-box' });
  const status = h('div', { class: 'here-status' });
  const people = h('div', { class: 'people-strip' });
  const segBox = h('div', { class: 'seg-wrap' });
  const chatLog = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': '现场聊天' });
  const input = h('input', { type: 'text', class: 'chat-input', autocomplete: 'off', 'aria-label': '说点什么', enterKeyHint: 'send' });
  const counter = h('span', { class: 'chat-count' });
  const sendBtn = h('button', { type: 'submit', class: 'btn primary send', 'aria-label': '发送' }, icon('send', 18));
  const composer = h(
    'form',
    {
      class: 'composer',
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        sendBtn.disabled = true;
        const r = await act({ type: 'speak', text });
        sendBtn.disabled = false;
        if (r.ok) {
          input.value = '';
          counter.textContent = '';
          if (r.heardBy === 0) toast('这里没有别人，没有人听到。', 'info', 2500);
          scrollDown(true);
        }
        input.focus();
      },
    },
    input,
    counter,
    sendBtn,
  );
  const chatPane = h('div', { class: 'chat-pane' }, chatLog, composer);
  const aroundPane = h('div', { class: 'around-pane' });
  const body = h('div', { class: 'here-body' }, chatPane, aroundPane);
  const el = h('div', { class: 'panel here' }, head, offersBox, status, people, segBox, body);

  input.addEventListener('input', () => {
    const max = state.config?.limits.chatMaxChars ?? 120;
    const n = [...input.value].length;
    counter.textContent = n > max * 0.7 ? `${n}/${max}` : '';
  });

  let stick = true;
  chatLog.addEventListener('scroll', () => {
    stick = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60;
  });
  /** @param {boolean} [force] */
  function scrollDown(force = false) {
    if (force || stick) requestAnimationFrame(() => (chatLog.scrollTop = chatLog.scrollHeight));
  }

  function renderChat() {
    const me = state.me;
    const lines = state.chat;
    const key = `${lines.length}:${lines[lines.length - 1]?.messageId ?? 0}:${lines[0]?.messageId ?? 0}:${state.olderChatDone}:${lines.filter((c) => !c.sys && c.messageId > 0).reduce((m, c) => Math.min(m, c.messageId), Infinity)}`;
    if (chatLog.dataset.memo === key) return;
    chatLog.dataset.memo = key;
    const top = chatLog.scrollHeight;
    chatLog.replaceChildren();
    // messageId 是每位居民自己的连续序号，从 1 开始：已经显示到 1 就不会再有更早的
    const real = lines.filter((c) => !c.sys && c.messageId > 0);
    const reachedStart = real.length > 0 && Math.min(...real.map((c) => c.messageId)) <= 1;
    chatLog.appendChild(
      state.olderChatDone || reachedStart
        ? h('p', { class: 'chat-note' }, '更早的话没有了。')
        : h('div', { class: 'chat-more' }, btn('看更早的发言', async () => {
            const n = await loadOlderChat();
            if (n === 0) toast('没有更早的发言了。', 'info', 2000);
          }, { variant: 'ghost', small: true, always: true })),
    );
    let lastSpace = '';
    for (const c of lines) {
      // 系统提示也带地点：换了地点就先插分隔线（路上没有地点的提示不插）
      if (c.space !== lastSpace && !(c.sys && !c.space)) {
        lastSpace = c.space;
        chatLog.appendChild(h('p', { class: 'place-line' }, h('span', null, c.spaceName || '')));
      }
      if (c.sys) {
        chatLog.appendChild(h('p', { class: 'sys-line' }, c.text));
        continue;
      }
      const mine = c.from.id === me?.me.id;
      chatLog.appendChild(h('div', { class: `msg ${mine ? 'mine' : 'other'}` }, mine ? null : avatar(c.from.name, c.from.kind), h('div', { class: 'bubble' }, mine ? null : h('div', { class: 'who' }, c.from.name, c.from.kind === 'agent' ? h('small', null, ' AI') : null), h('p', null, c.text), h('time', null, clockOf(c.at, tz())))));
    }
    if (!lines.length) chatLog.appendChild(h('p', { class: 'chat-empty' }, '这里还很安静。说点什么，同一处的人都能听到。'));
    if (chatLog.dataset.first === undefined) {
      chatLog.dataset.first = '1';
      scrollDown(true);
    } else if (stick) scrollDown(true);
    else chatLog.scrollTop += chatLog.scrollHeight - top;
  }

  function renderAround() {
    const me = state.me;
    const here = me?.here;
    aroundPane.replaceChildren();
    if (!me || !here) {
      aroundPane.appendChild(empty('这里没有现场', ''));
      return;
    }
    /** @type {import('./dom.js').Child[]} */
    /** @type {HTMLElement[]} */
    const blocks = [];
    if (me.interaction) {
      const it = me.interaction;
      blocks.push(
        section(
          '我正在做的事',
          h(
            'div',
            { class: 'obj live' },
            h('div', { class: 'obj-head' }, h('b', null, it.name), chip(it.status === 'open' ? '等人中' : '进行中', it.status === 'open' ? 'amber' : 'moss')),
            h('p', { class: 'obj-state' }, `参与：${it.participants.map((p) => p.name).join('、')}`, it.endsAt ? h('span', null, ' · ', countdown(it.endsAt, '还有 ')) : null),
            h('p', { class: 'hint' }, it.cost),
          ),
        ),
      );
    }
    if (here.objects.length) blocks.push(section('物件与共同活动', h('div', { class: 'stack' }, here.objects.map((o) => objectCard(o, me))), { hint: here.kind === 'home' ? '家里的东西，只有屋里的人能用。' : undefined }));
    if (here.activities.length || here.games.length) {
      const inLobby = here.activities.some((x) => x.status === 'forming' && x.players.some((p) => p.id === me.me.id));
      blocks.push(
        section(
          '桌游',
          h(
            'div',
            { class: 'stack' },
            here.activities.map((l) => lobbyCard(l, me)),
            here.games.map((g) => {
              const nearFree = here.tables.find((t) => t.near && !t.activityId);
              const free = here.tables.find((t) => !t.activityId);
              return row({
                lead: icon('dice', 20),
                title: g.name,
                sub: `${g.min}~${g.max} 人 · ${g.summary}`,
                aside: nearFree
                  ? btn('凑一桌', () => act({ type: 'propose_game', game: g.type, objectId: nearFree.id }), { small: true, variant: 'soft', disabled: inLobby, why: '你已经在一桌里了。' })
                  : free
                    ? btn('先走到桌边', () => moveTo(free.id, free.name), { small: true, variant: 'soft', icon: 'walk', disabled: inLobby || Boolean(me.game), why: '你已经在一桌里了。' })
                    : btn('桌子都有人了', () => {}, { small: true, variant: 'ghost', disabled: true, why: '游戏桌都被占着，等一桌打完。' }),
              });
            }),
          ),
          { hint: '人齐了由发起人开局。开局后你会进入游戏界面；游戏里不能做别的事，可以随时退出这局。' },
        ),
      );
    }
    for (const shop of here.shops) blocks.push(section(shop.name, h('div', { class: 'stack' }, shop.goods.map((g) => goodRow(shop.id, g, me))), { aside: h('span', { class: 'price big' }, icon('coin', 15), `${me.inventory.coins.available}`), hint: '库存每个世界日补满。' }));
    if (here.library) {
      const mineLoans = me.inventory.items.filter((i) => i.borrowedFrom === '檐下书屋');
      blocks.push(
        section(
          '书屋藏书（借阅）',
          h(
            'div',
            { class: 'stack' },
            here.library.map((b) => row({ lead: icon('book', 20), title: b.title, sub: b.available > 0 ? `在架 ${b.available} 本` : '都被借走了', aside: btn('借', async () => {
              const r = await act({ type: 'borrow_book', bookId: b.bookId });
              if (r.ok) toast(String(r.text ?? '借到了。'), 'ok');
            }, { small: true, variant: 'soft', disabled: b.available <= 0, why: '都被借走了。' }) })),
            mineLoans.map((b) => row({ lead: icon('book', 20), title: `${b.name}（我借的）`, sub: b.dueAt ? `约定归还时间 ${new Date(b.dueAt).toLocaleDateString('zh-CN')}` : '', aside: btn('归还', () => act({ type: 'return_item', itemId: b.itemId }), { small: true, variant: 'ghost' }) })),
          ),
          { hint: '一次最多借 2 本，看完还回书屋。' },
        ),
      );
    }
    if (here.doors) {
      blocks.push(
        section(
          '各家门牌',
          h(
            'div',
            { class: 'stack' },
            here.doors.map((d) =>
              row({
                lead: h('span', { class: 'door-no' }, String(d.no)),
                title: d.owner.id === me.me.id ? `${d.owner.name}（我家）` : `${d.owner.name} 家`,
                sub: `${d.lane}${d.owner.id === me.me.id ? ' · 自己的家' : d.canEnter ? ' · 有邀请，可以进' : ' · 没有邀请，不能进'}`,
                aside: btn('进去', () => moveTo(d.home, `${d.owner.name}家`), { small: true, variant: 'soft', disabled: !d.canEnter, why: '需要主人的邀请才能进别人家。' }),
              }),
            ),
          ),
          { hint: '各家门口有信箱和归还箱：借来的东西可以放进主人家门口的归还箱。' },
        ),
      );
    }
    if (here.home) {
      blocks.push(section(here.home.mine ? '我的家' : `${here.home.owner.name}的家`, here.home.decor.length ? h('div', { class: 'chips' }, here.home.decor.map((d) => chip(d, 'amber'))) : h('p', { class: 'hint' }, here.home.mine ? '还没有摆出装饰。在「我」的背包里可以摆放。' : '没有摆出什么装饰。')));
    }
    blocks.push(
      section(
        '去别处',
        h(
          'div',
          { class: 'action-grid' },
          here.exits.map((x) => btn(x.seconds ? `${x.name} · 约 ${x.seconds} 秒` : x.name, () => moveTo(x.id, x.name), { icon: 'walk', variant: 'soft', disabled: Boolean(me.game) })),
          here.kind !== 'home' || !here.home?.mine ? btn('回家', () => moveTo('home', '家'), { icon: 'home', variant: 'ghost' }) : null,
        ),
        { hint: '走在路上也可以说话、做事；用桌子、书架这类公共物件要先走到它旁边。' },
      ),
    );
    aroundPane.append(...blocks.map((b) => b));
  }

  function update() {
    const me = state.me;
    if (!me) return;
    const here = me.here;
    const nav = me.location.navigation;
    const ro = state.readOnly ? 'ro' : '';
    // 头部
    const hk = JSON.stringify([me.location.name, here?.blurb, here?.residents.length, ro]);
    if (head.dataset.memo !== hk) {
      head.dataset.memo = hk;
      fill(head,
        h('div', null, h('p', { class: 'eyebrow' }, here?.kind === 'home' ? (here.home?.mine ? '我的家' : '做客') : here?.kind === 'residential' ? '住宅区' : '公共场所'), h('h2', null, here?.name ?? me.location.name), h('p', { class: 'hint' }, here?.blurb ?? '')),
        here ? h('div', { class: 'head-count' }, icon('people', 16), `${here.residents.length + 1} 人`) : null,
      );
    }
    // 在途
    const sk = JSON.stringify([nav, me.interaction?.id]);
    if (status.dataset.memo !== sk) {
      status.dataset.memo = sk;
      status.replaceChildren();
      if (nav) {
        if (navSeen.id !== nav.navigationId) {
          navSeen.id = nav.navigationId;
          navSeen.t0 = serverNow();
        }
        status.appendChild(
          h(
            'div',
            { class: 'moving-card' },
            h('div', { class: 'moving-top' }, icon('walk', 20), h('b', null, `正在走向${nav.to.name}`), btn('停下', () => act({ type: 'stop_navigation' }), { small: true, variant: 'ghost', always: true })),
            travel(navSeen.t0, nav.arriveAt),
            h('p', { class: 'hint' }, '走路时可以照常说话、做事；到达时间由程序决定。'),
          ),
        );
      }
    }
    // 报价
    const ok = JSON.stringify([me.offers, ro]);
    if (offersBox.dataset.memo !== ok) {
      offersBox.dataset.memo = ok;
      offersBox.replaceChildren(...me.offers.map((o) => offerCard(o, me.me.id)));
    }
    // 身边的人
    const pk = JSON.stringify([here?.residents, ro]);
    if (people.dataset.memo !== pk) {
      people.dataset.memo = pk;
      people.replaceChildren();
      people.hidden = !here;
      if (here) {
        if (!here.residents.length) people.appendChild(h('p', { class: 'hint alone' }, here.kind === 'home' ? '屋里只有你。' : '这里只有你。去茶馆或广场看看，那里人多些。'));
        for (const p of here.residents) {
          people.appendChild(
            h(
              'button',
              { type: 'button', class: 'person', 'aria-label': `${p.name}，${p.kind === 'agent' ? 'AI 居民' : '真人'}，点开看资料和互动`, onclick: () => openPerson(p) },
              avatar(p.name, p.kind),
              h('span', { class: 'person-name' }, p.name),
              h('span', { class: 'person-sub' }, p.mood ?? (p.kind === 'agent' ? 'AI' : '真人')),
            ),
          );
        }
      }
    }
    // 分页
    const badge = (here?.objects.filter((o) => o.active).length ?? 0) + (here?.activities.length ?? 0) + (me.interaction ? 1 : 0);
    const sg = JSON.stringify([sub, badge]);
    if (segBox.dataset.memo !== sg) {
      segBox.dataset.memo = sg;
      segBox.replaceChildren(
        segmented(
          [
            { id: 'chat', label: '聊天' },
            { id: 'around', label: '此处', badge: badge || undefined },
          ],
          sub,
          (id) => {
            sub = id;
            segBox.dataset.memo = '';
            el.dataset.sub = sub;
            update();
            if (id === 'chat') scrollDown(true);
          },
          '现场分页',
        ),
      );
    }
    el.dataset.sub = sub;
    renderChat();
    // 此处
    const ak = JSON.stringify([here, me.interaction, me.inventory.coins.available, me.inventory.items.length, ro, Boolean(me.game)]);
    if (aroundPane.dataset.memo !== ak) {
      aroundPane.dataset.memo = ak;
      renderAround();
    }
    // 输入框状态
    const canSpeak = Boolean(here) && !state.readOnly;
    input.disabled = !canSpeak;
    sendBtn.disabled = !canSpeak;
    input.placeholder = !me.me.present ? '正在重新进入小镇……' : state.readOnly ? '只读：另一个页面握着控制权' : here && !here.residents.length ? '这里没有别人，说的话没人听到……' : '说点什么……';
    input.maxLength = state.config?.limits.chatMaxChars ?? 120;
  }

  return { el, update, focusChat: () => (sub = 'chat') };
}

