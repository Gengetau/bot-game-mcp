// 小游戏界面：数字炸弹、密封竞拍、大话骰各有专门的界面，其他游戏用通用兜底渲染（按 todo.actions 生成表单）。
import { avatar, confirmDialog, h, icon, num, openSheet, s, toast } from './dom.js';
import { act, http, serverNow, state } from './store.js';
import { btn, chip, empty, field, row, section } from './ui.js';

/** @typedef {import('./types.js').GameView} GameView */
/** @typedef {import('./types.js').GamePlayer} GamePlayer */
/** @typedef {import('./types.js').ActionSpec} ActionSpec */
/** @typedef {import('./dom.js').Child} Child */

// ───────────────────────── 取值小工具（视图里的 public/you 是未知形状） ─────────────────────────

/** @param {unknown} v @returns {Record<string, unknown>} */
const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {});
/** @param {unknown} v @returns {unknown[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @param {string} [d] */
const str = (v, d = '') => (typeof v === 'string' ? v : v === null || v === undefined ? d : String(v));

/** 输入草稿：按局+阶段保存，界面重建时不丢用户正在填的值。 */
/** @type {Record<string, Record<string, any>>} */
const drafts = {};
/** @param {GameView} v */
function draftOf(v) {
  const key = `${v.game_id}:${v.phase_id}`;
  for (const k of Object.keys(drafts)) if (!k.startsWith(`${v.game_id}:`)) delete drafts[k];
  return (drafts[key] ??= {});
}

/** 最近一次看到的局面（局结束后用来在结果里回顾）。 @type {GameView | null} */
let lastSnap = null;

/** @param {GameView} v @param {number} seat */
function seatName(v, seat) {
  return v.players.find((p) => p.seat === seat)?.name ?? `${seat}号`;
}

/** @param {unknown} label  形如「3号」 */
function seatFromLabel(label) {
  const m = /(\d+)/.exec(str(label));
  return m ? Number(m[1]) : null;
}

// ───────────────────────── 骰子 ─────────────────────────

const PIPS = {
  1: [[0, 0]],
  2: [
    [-1, -1],
    [1, 1],
  ],
  3: [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  4: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  5: [
    [-1, -1],
    [1, -1],
    [0, 0],
    [-1, 1],
    [1, 1],
  ],
  6: [
    [-1, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
  ],
};

/**
 * @param {number} face
 * @param {number} [size]
 * @param {string} [cls]
 */
function die(face, size = 44, cls = '') {
  const f = Math.max(1, Math.min(6, Math.round(face)));
  const svg = s('svg', { viewBox: '-20 -20 40 40', width: size, height: size, class: `die ${cls}`.trim(), role: 'img', 'aria-label': `${f} 点` });
  svg.appendChild(s('rect', { x: -17, y: -17, width: 34, height: 34, rx: 8, class: 'die-body' }));
  for (const [px, py] of PIPS[/** @type {1} */ (f)] ?? []) svg.appendChild(s('circle', { cx: (px ?? 0) * 8.5, cy: (py ?? 0) * 8.5, r: 3.1, class: 'die-pip' }));
  return svg;
}

// ───────────────────────── 计时 ─────────────────────────

/**
 * 局内倒计时：由 app 的秒表刷新（data-lu 是本机时间的截止点）。
 * @param {number | null | undefined} secondsLeft  取视图那一刻的剩余秒数
 */
function timer(secondsLeft) {
  if (secondsLeft === null || secondsLeft === undefined) return h('span', { class: 'timer none' }, '不限时');
  const until = state.meFetchedAt + secondsLeft * 1000;
  return h(
    'span',
    { class: 'timer', dataset: { lu: String(until), total: String(Math.max(secondsLeft, 1)) }, role: 'timer', 'aria-label': '本步剩余时间' },
    icon('clock', 15),
    h('b', { class: 'timer-n' }, `${secondsLeft}`),
    '秒',
    h('span', { class: 'timer-bar' }, h('i')),
  );
}

// ───────────────────────── 通用部件 ─────────────────────────

/**
 * @param {GameView} v
 * @param {number | null} turnSeat
 * @param {number | null} mySeat
 */
function playersStrip(v, turnSeat, mySeat) {
  return h(
    'ul',
    { class: 'seats', 'aria-label': '玩家' },
    v.players.map((p) =>
      h(
        'li',
        { class: `seat${p.alive ? '' : ' out'}${p.seat === turnSeat ? ' turn' : ''}${p.seat === mySeat ? ' me' : ''}` },
        avatar(p.name, p.kind, p.seat === mySeat),
        h('span', { class: 'seat-name' }, `${p.seat}号 ${p.name}${p.seat === mySeat ? '（你）' : ''}`),
        p.seat === turnSeat ? h('span', { class: 'seat-flag' }, '轮到') : null,
        !p.alive ? h('span', { class: 'seat-flag dim' }, '出局') : null,
      ),
    ),
  );
}

/** @param {GameView} v */
function logList(v) {
  const items = v.events.slice(-30);
  if (!items.length) return h('p', { class: 'hint' }, '还没有记录。');
  const ol = h('ol', { class: 'glog' });
  for (const e of items) ol.appendChild(h('li', { class: e.private ? 'priv' : '' }, e.private ? h('span', { class: 'tag' }, '只有你看到') : null, e.text));
  requestAnimationFrame(() => {
    const p = ol.parentElement;
    if (p) p.scrollTop = p.scrollHeight;
  });
  return ol;
}

/**
 * 提交局内动作。phaseId 来自视图。
 * @param {GameView} v
 * @param {Record<string, unknown>} input
 */
async function submit(v, input) {
  if (v.phase_id === null) {
    toast('这一步还没开放，稍等。', 'warn');
    return { ok: false };
  }
  const r = await act({ type: 'game_act', gameId: v.game_id, phaseId: v.phase_id, input });
  if (r.ok && r.text) toast(r.text, 'ok', 3000);
  return r;
}

// ───────────────────────── 数字炸弹 ─────────────────────────

/**
 * @param {GameView} v
 * @param {number | null} mySeat
 */
function bombBoard(v, mySeat) {
  const pub = v.public;
  const range = rec(pub.range);
  const from = num(range.from);
  const to = num(range.to);
  const hist = arr(pub.history).map(rec);
  const guesses = hist.map((x) => num(x.guess));
  const lo = Math.min(from, ...guesses);
  const hi = Math.max(to, ...guesses);
  const span = Math.max(1, hi - lo);
  const pct = (/** @type {number} */ n) => `${(((n - lo) / span) * 100).toFixed(2)}%`;
  const turn = seatFromLabel(pub.current_turn);
  const track = h(
    'div',
    { class: 'bomb-track', role: 'img', 'aria-label': `炸弹在 ${from} 到 ${to} 之间` },
    h('div', { class: 'bomb-safe', style: { left: pct(from), width: `${(((to - from) / span) * 100).toFixed(2)}%` } }),
    ...hist.map((x) => h('span', { class: `bomb-tick ${str(x.result).includes('爆') ? 'boom' : str(x.result).includes('更大') ? 'lowside' : 'highside'}`, style: { left: pct(num(x.guess)) }, title: `${seatName(v, num(x.seat))} 猜 ${num(x.guess)}` }, h('i'))),
  );
  return h(
    'div',
    { class: 'board bomb' },
    h('div', { class: 'bomb-range' }, h('span', { class: 'cap' }, '炸弹藏在'), h('div', { class: 'bomb-nums' }, h('b', null, String(from)), h('span', { class: 'bomb-dash' }, icon('lantern', 22)), h('b', null, String(to))), h('span', { class: 'cap' }, str(pub.mode) === 'elimination' ? '淘汰制：踩雷出局，程序重新埋雷' : '一次爆炸定胜负')),
    track,
    h('div', { class: 'bomb-legend' }, h('span', { class: 'lg lowside' }, '猜小了'), h('span', { class: 'lg highside' }, '猜大了'), h('span', { class: 'lg boom' }, '爆炸')),
    playersStrip(v, turn, mySeat),
    hist.length
      ? h(
          'ul',
          { class: 'bomb-hist', 'aria-label': '猜数记录' },
          hist
            .slice()
            .reverse()
            .map((x) => h('li', null, h('b', null, `${seatName(v, num(x.seat))}`), ` 猜 ${num(x.guess)} `, chip(str(x.result), str(x.result).includes('爆') ? 'rose' : ''), x.auto ? chip('超时代猜', 'dim') : null)),
        )
      : h('p', { class: 'hint' }, '还没有人猜。'),
  );
}

/**
 * @param {GameView} v
 */
function bombAction(v) {
  const range = rec(v.public.range);
  const from = num(range.from);
  const to = num(range.to);
  const d = draftOf(v);
  const mid = Math.floor((from + to) / 2);
  if (typeof d.guess !== 'number' || d.guess < from || d.guess > to) d.guess = mid;
  const input = h('input', { type: 'number', inputMode: 'numeric', min: from, max: to, step: 1, value: d.guess, 'aria-label': `猜一个 ${from} 到 ${to} 之间的整数`, class: 'big-input' });
  const slider = h('input', { type: 'range', min: from, max: to, step: 1, value: d.guess, 'aria-label': '用滑块选择', class: 'slider' });
  input.addEventListener('input', () => {
    d.guess = Number(input.value);
    slider.value = input.value;
  });
  slider.addEventListener('input', () => {
    d.guess = Number(slider.value);
    input.value = slider.value;
  });
  const set = (/** @type {number} */ n) => {
    const c = Math.max(from, Math.min(to, n));
    d.guess = c;
    input.value = String(c);
    slider.value = String(c);
  };
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'prompt' }, `轮到你了：在 ${from} 到 ${to} 之间猜一个整数。猜中炸弹就爆炸。`),
    h('div', { class: 'bomb-input' }, btn('−', () => set(num(input.value) - 1), { small: true, aria: '减一' }), input, btn('+', () => set(num(input.value) + 1), { small: true, aria: '加一' })),
    slider,
    h('div', { class: 'row-wrap' }, btn('取中间', () => set(mid), { small: true, variant: 'ghost' }), btn('偏小一点', () => set(Math.round(from + (to - from) * 0.3)), { small: true, variant: 'ghost' }), btn('偏大一点', () => set(Math.round(from + (to - from) * 0.7)), { small: true, variant: 'ghost' })),
    btn('猜这个数', async () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < from || n > to) {
        toast(`只能猜 ${from} 到 ${to} 之间的整数。`, 'warn');
        return;
      }
      await submit(v, { action: 'guess', number: n });
    }, { variant: 'primary', block: true }),
  );
}

// ───────────────────────── 大话骰 ─────────────────────────

const FACE_ORDER = [2, 3, 4, 5, 6, 1];

/**
 * @param {GameView} v
 * @param {number | null} mySeat
 */
function diceBoard(v, mySeat) {
  const pub = v.public;
  const players = arr(pub.players).map(rec);
  const bid = pub.current_bid ? rec(pub.current_bid) : null;
  const turn = seatFromLabel(pub.current_turn);
  const you = rec(v.you);
  const myDice = arr(you.dice).map((x) => num(x));
  const hist = arr(pub.bid_history).map(rec);
  const challenges = arr(pub.last_challenges).map(rec);
  const last = challenges[challenges.length - 1];
  const hearts = (/** @type {number} */ n) => h('span', { class: 'hearts', 'aria-label': `${n} 条命` }, n > 0 ? Array.from({ length: n }, () => h('i', { 'aria-hidden': 'true' }, '♥')) : '—');
  return h(
    'div',
    { class: 'board dice' },
    h(
      'div',
      { class: 'dice-bid' },
      h('span', { class: 'cap' }, bid ? `${seatName(v, num(bid.seat))} 叫的` : '还没有人叫牌'),
      bid ? h('div', { class: 'dice-bid-main' }, h('b', null, `${num(bid.quantity)} 个`), die(num(bid.face), 52)) : h('div', { class: 'dice-bid-main dim' }, '由先手开叫'),
      h('span', { class: 'cap' }, `场上共 ${num(pub.total_dice)} 颗骰子 · ${pub.wild_ones ? '1 是百搭（叫 1 点时只数 1）' : '本局 1 不是百搭'} · 大小 2<3<4<5<6<1`),
    ),
    h(
      'ul',
      { class: 'seats', 'aria-label': '玩家与命数' },
      players.map((p) => {
        const seat = num(p.seat);
        const nm = v.players.find((x) => x.seat === seat);
        return h(
          'li',
          { class: `seat${p.alive ? '' : ' out'}${seat === turn ? ' turn' : ''}${seat === mySeat ? ' me' : ''}` },
          avatar(str(p.name), nm?.kind ?? 'human', seat === mySeat),
          h('span', { class: 'seat-name' }, `${seat}号 ${str(p.name)}${seat === mySeat ? '（你）' : ''}`),
          hearts(num(p.lives)),
          p.alive ? h('span', { class: 'seat-dice' }, `${num(p.dice_count)} 颗`) : h('span', { class: 'seat-flag dim' }, '出局'),
          seat === turn ? h('span', { class: 'seat-flag' }, '轮到') : null,
        );
      }),
    ),
    hist.length
      ? h(
          'div',
          { class: 'dice-hist', 'aria-label': '本轮叫牌记录' },
          hist.map((x) => h('span', { class: 'bid-chip' }, h('em', null, `${num(x.seat)}号`), `${num(x.quantity)}×`, die(num(x.face), 20), x.auto ? h('small', null, '超时') : null)),
        )
      : null,
    last
      ? h(
          'div',
          { class: 'reveal' },
          h('p', { class: 'cap' }, `上一次开牌（第 ${num(last.round)} 轮）：${seatName(v, num(last.challenger))} 开了 ${seatName(v, num(last.bidder))} 的 ${num(rec(last.bid).quantity)} 个 ${num(rec(last.bid).face)} 点，实际有 ${num(last.count)} 个，${seatName(v, num(last.loser))} 扣一条命${last.eliminated ? '并出局' : ''}。`),
          h(
            'div',
            { class: 'reveal-dice' },
            Object.entries(rec(last.revealed_dice)).map(([seat, faces]) => h('div', { class: 'reveal-row' }, h('em', null, `${seat}号`), arr(faces).map((f) => die(num(f), 24)))),
          ),
        )
      : null,
    myDice.length || v.you
      ? h('div', { class: 'my-dice' }, h('span', { class: 'cap' }, '你的骰子（只有你看得到）'), h('div', { class: 'my-dice-row' }, myDice.length ? myDice.map((f) => die(f, 54, 'mine')) : h('span', { class: 'hint' }, '你已经出局了。')))
      : null,
  );
}

/** @param {GameView} v */
function diceAction(v) {
  const pub = v.public;
  const total = Math.max(1, num(pub.total_dice));
  const minNext = pub.min_next_bid ? rec(pub.min_next_bid) : null;
  const minOpen = Math.max(1, num(pub.min_open_quantity, 1));
  const canChallenge = Boolean(pub.can_challenge);
  const d = draftOf(v);
  if (typeof d.q !== 'number') d.q = minNext ? num(minNext.quantity) : minOpen;
  if (typeof d.f !== 'number') d.f = minNext ? num(minNext.face) : 2;
  const qLabel = h('b', { class: 'q-n' }, String(d.q));
  /** @type {HTMLButtonElement[]} */
  const faceBtns = [];
  const refresh = () => {
    qLabel.textContent = String(d.q);
    for (const b of faceBtns) b.setAttribute('aria-pressed', b.dataset.f === String(d.f) ? 'true' : 'false');
  };
  const faces = h(
    'div',
    { class: 'face-pick', role: 'group', 'aria-label': '选点数（大小 2<3<4<5<6<1）' },
    FACE_ORDER.map((f) => {
      const b = h('button', { type: 'button', class: 'face-btn', dataset: { f: String(f) }, 'aria-label': `${f} 点`, 'aria-pressed': d.f === f ? 'true' : 'false', onclick: () => ((d.f = f), refresh()) }, die(f, 38));
      faceBtns.push(b);
      return b;
    }),
  );
  const bidBtn = btn(
    '叫牌',
    async () => {
      await submit(v, { action: 'bid', quantity: d.q, face: d.f });
    },
    { variant: 'primary' },
  );
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'prompt' }, v.todo?.prompt ?? ''),
    minNext ? h('p', { class: 'hint' }, `最小可叫：${num(minNext.quantity)} 个 ${num(minNext.face)} 点`) : null,
    h('div', { class: 'qty-pick' }, btn('−', () => ((d.q = Math.max(1, d.q - 1)), refresh()), { small: true, aria: '少一个' }), h('div', { class: 'q-box' }, qLabel, h('span', null, '个')), btn('+', () => ((d.q = Math.min(total, d.q + 1)), refresh()), { small: true, aria: '多一个' })),
    faces,
    h('div', { class: 'row-wrap' }, bidBtn, canChallenge ? btn('开牌', async () => {
      const ok = await confirmDialog({ title: '开牌', text: '开牌后全场亮骰，叫错的一方扣一条命。确定要开吗？', ok: '开！', danger: true });
      if (ok) await submit(v, { action: 'challenge' });
    }, { variant: 'danger' }) : null),
  );
}

// ───────────────────────── 密封竞拍 ─────────────────────────

/**
 * @param {GameView} v
 * @param {number | null} mySeat
 */
function auctionBoard(v, mySeat) {
  const pub = v.public;
  const players = arr(pub.players).map(rec);
  const hist = arr(pub.history).map(rec);
  const item = pub.current_item ? rec(pub.current_item) : null;
  const you = rec(v.you);
  return h(
    'div',
    { class: 'board auction' },
    h(
      'div',
      { class: 'lot' },
      h('span', { class: 'cap' }, `第 ${num(pub.round)} / ${num(pub.total_rounds)} 轮 · ${str(pub.price) === 'second' ? '第二价格' : '第一价格（付自己的出价）'}`),
      h('div', { class: 'lot-name' }, h('span', { class: 'lot-icon', 'aria-hidden': 'true' }, icon('gift', 30)), h('b', null, item ? `「${str(item.name)}」` : '拍卖结束')),
      v.you && you.estimate !== null && you.estimate !== undefined ? h('div', { class: 'estimate' }, h('span', { class: 'cap' }, '你的鉴定估价（含 −15~+15 的随机误差，只有你看到）'), h('b', null, String(num(you.estimate)))) : null,
    ),
    h(
      'table',
      { class: 'tbl' },
      h('caption', null, '收藏家排名（金币 + 收藏价值）'),
      h('thead', null, h('tr', null, h('th', null, '玩家'), h('th', null, '金币'), h('th', null, '收藏'), h('th', null, '合计'))),
      h(
        'tbody',
        null,
        players
          .slice()
          .sort((a, b) => num(b.score) - num(a.score))
          .map((p) => h('tr', { class: num(p.seat) === mySeat ? 'me' : '' }, h('th', { scope: 'row' }, `${num(p.seat)}号 ${str(p.name)}${num(p.seat) === mySeat ? '（你）' : ''}`), h('td', null, String(num(p.coins))), h('td', null, String(num(p.collection_value))), h('td', null, h('b', null, String(num(p.score)))))),
      ),
    ),
    hist.length
      ? h(
          'div',
          { class: 'auction-hist' },
          h('h4', null, '已揭晓的各轮'),
          hist
            .slice()
            .reverse()
            .map((x) =>
              h(
                'div',
                { class: 'lot-row' },
                h('b', null, `第 ${num(x.round)} 轮「${str(x.item)}」`),
                h('span', null, `真实价值 ${num(x.value)} · ${x.winner === null ? '流拍' : `${seatName(v, num(x.winner))} 以 ${num(x.price)} 得标`}${arr(x.tied).length ? '（并列抽签）' : ''}`),
                h('small', null, arr(x.bids).map((b) => `${num(rec(b).seat)}号 ${num(rec(b).amount)}${rec(b).auto ? '(超时)' : ''}`).join(' · ')),
              ),
            ),
        )
      : null,
  );
}

/** @param {GameView} v */
function auctionAction(v) {
  const you = rec(v.you);
  const coins = num(you.coins);
  const est = you.estimate === null || you.estimate === undefined ? null : num(you.estimate);
  const d = draftOf(v);
  if (typeof d.bid !== 'number' || d.bid > coins) d.bid = Math.min(coins, est !== null ? Math.max(0, est - 10) : 0);
  const input = h('input', { type: 'number', inputMode: 'numeric', min: 0, max: coins, step: 1, value: d.bid, class: 'big-input', 'aria-label': `出价，0 到 ${coins} 金币` });
  const slider = h('input', { type: 'range', min: 0, max: coins, step: 1, value: d.bid, class: 'slider', 'aria-label': '用滑块出价' });
  const set = (/** @type {number} */ n) => {
    const c = Math.max(0, Math.min(coins, Math.round(n)));
    d.bid = c;
    input.value = String(c);
    slider.value = String(c);
  };
  input.addEventListener('input', () => set(Number(input.value)));
  slider.addEventListener('input', () => set(Number(slider.value)));
  if (you.bid !== null && you.bid !== undefined) {
    return h('div', { class: 'stack' }, h('p', { class: 'prompt' }, `你的出价 ${num(you.bid)} 金币已经密封，不可修改。等其他人提交或到时间后统一揭晓。`));
  }
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'prompt' }, v.todo?.prompt ?? ''),
    h('div', { class: 'bomb-input' }, btn('−5', () => set(num(input.value) - 5), { small: true }), input, btn('+5', () => set(num(input.value) + 5), { small: true })),
    slider,
    h('div', { class: 'row-wrap' }, btn('过（出价 0）', () => set(0), { small: true, variant: 'ghost' }), est !== null ? btn(`按估价 ${est}`, () => set(est), { small: true, variant: 'ghost' }) : null, btn('全部 ' + coins, () => set(coins), { small: true, variant: 'ghost' })),
    btn('密封出价', async () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < 0 || n > coins) {
        toast(`只能出 0 到 ${coins} 之间的整数。`, 'warn');
        return;
      }
      const ok = await confirmDialog({ title: '确认出价', text: `密封出价 ${n} 金币。提交后不可修改，揭晓前别人看不到。`, ok: '密封提交' });
      if (ok) await submit(v, { action: 'bid', number: n });
    }, { variant: 'primary', block: true }),
  );
}

// ───────────────────────── 通用兜底 ─────────────────────────

/**
 * 把任意值渲染成键值列表（全是文本节点）。
 * @param {unknown} val
 * @param {number} [depth]
 * @returns {Child}
 */
function generic(val, depth = 0) {
  if (val === null || val === undefined) return h('span', { class: 'dim' }, '—');
  if (typeof val !== 'object') return String(val);
  if (Array.isArray(val)) {
    if (depth > 3) return `（${val.length} 项）`;
    if (val.every((x) => typeof x !== 'object' || x === null)) return val.map((x) => String(x)).join('、') || '（空）';
    return h('ol', { class: 'gen-list' }, val.slice(-30).map((x) => h('li', null, generic(x, depth + 1))));
  }
  if (depth > 3) return '…';
  return h('dl', { class: 'gen-kv' }, Object.entries(val).map(([k, x]) => [h('dt', null, k), h('dd', null, generic(x, depth + 1))]));
}

/** @param {ActionSpec} spec @param {GameView} v */
function genericForm(spec, v) {
  const d = draftOf(v);
  const key = `g:${spec.action}`;
  const store = (d[key] ??= {});
  const params = Object.entries(spec.params ?? {});
  const inputs = params.map(([name, desc]) => {
    const numeric = /整数|个数|点数|数字|金币|number/i.test(desc);
    const el = h('input', { type: numeric ? 'number' : 'text', value: store[name] ?? '', placeholder: desc, class: 'text-input', oninput: () => (store[name] = numeric ? Number(el.value) : el.value) });
    return field(`${name}（${desc}）`, el);
  });
  return h(
    'form',
    {
      class: 'stack gen-form',
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        /** @type {Record<string, unknown>} */
        const input = { action: spec.action };
        for (const [name] of params) if (store[name] !== undefined && store[name] !== '') input[name] = store[name];
        await submit(v, input);
      },
    },
    h('strong', null, spec.label ?? spec.action),
    inputs,
    spec.example ? h('p', { class: 'hint' }, `示例：${spec.example}`) : null,
    h('button', { class: 'btn primary', type: 'submit', disabled: state.readOnly }, spec.label ?? '提交'),
  );
}

// ───────────────────────── 整个游戏界面 ─────────────────────────

/**
 * 游戏棋盘（公开局面）。观战和座位视图共用。
 * @param {GameView} v
 * @param {number | null} mySeat
 */
export function boardFor(v, mySeat) {
  switch (v.type) {
    case 'number_bomb':
      return bombBoard(v, mySeat);
    case 'liars_dice':
      return diceBoard(v, mySeat);
    case 'sealed_auction':
      return auctionBoard(v, mySeat);
    default:
      return h('div', { class: 'board generic' }, playersStrip(v, null, mySeat), h('h4', null, '公开局面'), generic(v.public));
  }
}

/**
 * @param {GameView} v
 */
function actionPanel(v) {
  const todo = v.todo;
  if (v.status !== 'running') return h('p', { class: 'hint' }, '这局已经结束。');
  if (!todo) {
    const waiting = v.phase?.waiting_for ?? '';
    return h('div', { class: 'wait' }, h('span', { class: 'wait-dot', 'aria-hidden': 'true' }), h('div', null, h('b', null, '等待其他玩家'), h('p', { class: 'hint' }, waiting && waiting !== '无' ? `现在在等：${waiting}` : '这一步由其他人行动，或者正在结算。')));
  }
  if (state.readOnly) return h('p', { class: 'hint' }, '这个页面现在是只读的，不能出手。接管控制权后才能操作。');
  switch (v.type) {
    case 'number_bomb':
      return bombAction(v);
    case 'liars_dice':
      return diceAction(v);
    case 'sealed_auction':
      return auctionAction(v);
    default:
      return h('div', { class: 'stack' }, h('p', { class: 'prompt' }, todo.prompt), todo.actions.map((a) => genericForm(a, v)));
  }
}

/** 我的私密信息（只给本座位）。 @param {GameView} v */
function privatePanel(v) {
  if (!v.you) return null;
  const you = { ...v.you };
  delete you.seat;
  delete you.name;
  delete you.alive;
  if (v.type === 'liars_dice') return null;
  if (v.type === 'sealed_auction') {
    return section('我的信息', h('div', { class: 'kv' }, h('div', null, h('span', null, '金币'), h('b', null, String(num(you.coins)))), h('div', null, h('span', null, '收藏价值'), h('b', null, String(num(you.collection_value)))), you.note ? h('p', { class: 'hint' }, str(you.note)) : null));
  }
  if (v.type === 'number_bomb') return section('我的信息', h('p', { class: 'hint' }, str(you.note, '数字炸弹没有私密信息：没有任何人知道炸弹数字。')));
  return section('我的信息（只有你看到）', generic(you));
}

export function createGameScreen() {
  const el = h('div', { class: 'game-screen' });
  let lastKey = '';
  let lastRO = false;

  /**
   * 退出这一局。
   * @param {GameView} v
   */
  async function quit(v) {
    const ok = await confirmDialog({
      title: `退出这局${v.name}？`,
      text: h('div', { class: 'stack' }, h('p', null, '退出后你会回到原来的场所，可以继续小镇生活。'), h('ul', { class: 'bullets' }, h('li', null, '你的座位留在局里，之后按超时规则自动处理。'), h('li', null, '这一局不会有你的记录，也没有参与奖励。'), h('li', null, '关闭页面或掉线不算退出，座位会托管，回来还能接着玩。'))),
      ok: '退出这一局',
      danger: true,
    });
    if (!ok) return;
    const r = await act({ type: 'quit_game' });
    if (r.ok) toast('你离开了这一局，回到了场所里。', 'info');
  }

  function update() {
    const me = state.me;
    const v = me?.game;
    if (!me || !v) return;
    lastSnap = v;
    const key = JSON.stringify(v) + (state.readOnly ? 'ro' : '');
    if (key === lastKey && lastRO === state.readOnly) return;
    lastKey = key;
    lastRO = state.readOnly;
    const mySeat = v.players.find((p) => p.name === me.me.name)?.seat ?? num(rec(v.you).seat, 0);
    const seat = v.you ? num(rec(v.you).seat, mySeat) : null;
    const timerSecs = v.todo?.seconds_left ?? v.phase?.seconds_left ?? null;
    const head = h(
      'header',
      { class: 'game-head' },
      h('div', { class: 'game-title' }, h('span', { class: 'game-icon', 'aria-hidden': 'true' }, icon(v.type === 'sealed_auction' ? 'gift' : 'dice', 22)), h('div', null, h('h2', null, v.name), h('p', { class: 'hint' }, `${v.phase?.title ?? ''}${v.phase && !v.phase.open ? '（准备中）' : ''}`))),
      h('div', { class: 'game-head-r' }, v.status === 'running' && v.phase?.open ? timer(timerSecs) : null, btn('退出这局', () => quit(v), { variant: 'ghost', small: true, icon: 'leave' })),
    );
    const youTurn = Boolean(v.todo);
    const main = h(
      'div',
      { class: 'game-main' },
      h('div', { class: `turn-banner${youTurn ? ' mine' : ''}`, role: 'status' }, youTurn ? '轮到你了' : v.status === 'running' ? `等待：${v.phase?.waiting_for ?? ''}` : '已结束'),
      boardFor(v, seat),
      h('section', { class: 'act-panel' }, h('h3', null, '你的操作'), actionPanel(v)),
    );
    const side = h('aside', { class: 'game-side' }, privatePanel(v), section('记录', h('div', { class: 'glog-wrap' }, logList(v))), h('p', { class: 'hint' }, '你仍在这局里。看小镇不等于退赛：只有点「退出这局」才会离开。'));
    el.replaceChildren(head, h('div', { class: 'game-grid' }, main, side));
  }

  return { el, update };
}

// ───────────────────────── 结果弹层 ─────────────────────────

/**
 * 一局结束后的结果。
 * @param {Record<string, any>} end  game_ended 事件
 */
export function openGameResult(end) {
  const snap = lastSnap;
  const won = Boolean(end.won);
  const aborted = end.outcome === 'aborted';
  const body = h(
    'div',
    { class: 'stack result' },
    h('div', { class: `result-banner ${aborted ? 'dim' : won ? 'win' : ''}` }, aborted ? '这局中止了' : won ? '你赢了' : '这局结束了'),
    h('p', null, String(end.reason ?? '')),
    end.reward ? h('p', { class: 'reward' }, icon('coin', 18), ` 得到 ${end.reward} 枚硬币`) : aborted ? h('p', { class: 'hint' }, '中止的局没有胜负和奖励。') : h('p', { class: 'hint' }, '今天这种游戏的奖励次数用完了，或者你中途退出过。'),
    snap && snap.game_id === end.gameId && snap.events.length ? section('最后的记录', h('ol', { class: 'glog' }, snap.events.slice(-6).map((e) => h('li', { class: e.private ? 'priv' : '' }, e.text)))) : null,
    h('p', { class: 'hint' }, '别人的私密记录不会公开。你已经回到小镇，可以继续生活。'),
  );
  const sh = openSheet({ title: `${String(end.name ?? '小游戏')}结果`, body });
  body.appendChild(h('div', { class: 'row-end' }, btn('回到小镇', () => sh.close(), { variant: 'primary', always: true })));
}

// ───────────────────────── 观战（公开投影） ─────────────────────────

/**
 * 观战一局（只有公开信息）。
 * @param {string} activityId
 * @param {string} [title]
 */
export function openSpectate(activityId, title) {
  const box = h('div', { class: 'stack' }, empty('正在入座观战……'));
  let alive = true;
  /** @type {number} */
  let timerId = 0;
  const sh = openSheet({
    title: title ? `观战：${title}` : '观战',
    body: box,
    wide: true,
    onClose: () => {
      alive = false;
      clearTimeout(timerId);
    },
  });
  async function load() {
    if (!alive) return;
    try {
      const r = await http('GET', `/public/game/${encodeURIComponent(activityId)}`);
      if (!alive) return;
      if (r.status === 200) {
        /** @type {GameView} */
        const v = r.data;
        box.replaceChildren(
          h('p', { class: 'hint' }, h('span', null, icon('eye', 15)), ' 观战只能看到公开信息，看不到任何人的私密信息。'),
          h('div', { class: 'spec-head' }, h('b', null, v.name), v.phase ? chip(v.phase.title) : null, chip(v.status === 'running' ? '进行中' : v.status === 'ended' ? '已结束' : '已中止', v.status === 'running' ? 'moss' : 'dim')),
          boardFor(v, null),
          section('记录', h('div', { class: 'glog-wrap' }, logList(v))),
        );
        if (v.status !== 'running') return;
      } else {
        box.replaceChildren(empty('这一局看不到了', r.data?.message ?? '可能已经散了。'));
        return;
      }
    } catch {
      /* 网络问题：下一轮再试 */
    }
    timerId = window.setTimeout(load, 4000);
  }
  void load();
  return sh;
}

export { row as _row, serverNow as _serverNow };
