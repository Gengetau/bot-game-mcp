/**
 * 德州扑克 —— 无限注锦标赛。
 *
 * 底牌、牌堆、下注账本全部保存在存档中；视图逐字段投影，绝不返回整个状态。
 * 一次待办只对应一个座位。行动先校验、暂存，advance 再统一执行和结算。
 */
import { z } from 'zod';
import { invalidAction, invalidState } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { shuffle } from '../../core/rng.js';
import { normalizeText, parseIntLoose, sanitizeName, sanitizeUserText } from '../../core/text.js';
import type { ActionInput, ActionMeta, ActionSpec, PendingRequest, Seat } from '../../core/types.js';
import { DECK, compare, evaluate, type HandValue } from './hand.js';

const optionsSchema = z.object({
  ...commonOptionShape,
  start_chips: z.number().int().min(200).max(100_000).default(1000),
  small_blind: z.number().int().min(1).max(100_000).default(10),
  blind_up_hands: z.number().int().min(0).max(1_000_000).default(10),
  max_hands: z.number().int().min(0).max(1_000_000).default(0),
  turn_timeout_s: secondsOption(45),
});

export type HoldemOptions = z.infer<typeof optionsSchema>;
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'settled';

export interface HoldemPlayer {
  chips: number;
  hole: string[];
  /** 当前街下注和本手累计投入；筹码守恒只计算 chips + committed。 */
  bet: number;
  committed: number;
  inHand: boolean;
  folded: boolean;
  allin: boolean;
  acted: boolean;
  /** 上次行动面对的总额；null 表示尚未行动或在无人下注时过牌。 */
  actedAt: number | null;
  starting: number;
  rank: number | null;
}

export interface Pot {
  amount: number;
  cap: number;
  eligible: Seat[];
  /** 下注尚未被匹配；结算前会先退回，不作为边池派奖。 */
  uncalled: boolean;
}

export interface SettledPot extends Pot {
  awards: { seat: Seat; amount: number }[];
}

export interface HoldemState {
  hand: number;
  dealer: Seat;
  smallSeat: Seat;
  bigSeat: Seat;
  smallBlind: number;
  bigBlind: number;
  street: Street;
  current: Seat | null;
  currentBet: number;
  lastRaise: number;
  board: string[];
  deck: string[];
  seats: Record<string, HoldemPlayer>;
  lastHand: { hand: number; board: string[]; showdown: boolean; pots: SettledPot[] } | null;
}

const STREET_NAMES: Record<Street, string> = {
  preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌', settled: '已结算',
};

const RULES = `## 德州扑克（无限注锦标赛）

- 2～9 人，使用标准 52 张牌；每人两张私密底牌，与五张公共牌组成最大的五张牌。
- 首手庄家随机，之后按钮顺时针移至下一位有筹码的玩家。小盲、大盲依次在庄家左侧。
  两人时庄家兼小盲，翻牌前先行动，翻牌后后行动。
- 大盲是小盲的两倍。每打满 blind_up_hands 手，下一手盲注翻倍；0 表示不涨。
- 翻牌前、翻牌、转牌、河牌各下注一轮。加注金额表示**本街加注到的总额**，不是额外投入。
  完整加注的增量不得小于上一次完整加注的增量，且至少一个大盲；不足时只允许全下。
- 不完整全下不会单独重开已行动者的加注权；连续短全下累计达到完整加注增量时重开。
  尚未下注时过牌不丧失面对后续下注的加注权。
- 只剩一人未弃牌，直接收池、不亮牌。没有后续下注可能时，先让仍欠跟注者决定，再自动发完公共牌。
- 未被匹配的下注退回；按累计投入分主池、边池。弃牌者不参与比牌，底牌永不公开。
  平分底池的余数归庄家左侧顺时针第一位赢家。
- 筹码归零出局；同手出局者按该手开始时筹码排名，等额并列。
  只剩一人，或打满 max_hands 时结束；达到手数上限按筹码排名，最高者并列共享胜利。
- 超时：能过牌就过牌，否则弃牌。所有操作、发牌、比牌与派奖均由程序决定。

**真人指令**（群里）：「弃牌」「弃」「过」「过牌」「跟」「跟注」「加注 200」「加到200」「加 200」「全下」「allin」「梭哈」。
**bot 指令**：\`act({"action":"fold"})\`、\`act({"action":"check"})\`、\`act({"action":"call"})\`、
\`act({"action":"raise","number":200})\`、\`act({"action":"allin"})\``;

export class HoldemGame extends BaseGame<HoldemState, HoldemOptions> {
  private hp(seat: Seat): HoldemPlayer {
    return this.state.seats[String(seat)]!;
  }

  private contenders(): Seat[] {
    return this.allSeats().filter((s) => this.hp(s).inHand && !this.hp(s).folded);
  }

  private actors(): Seat[] {
    return this.contenders().filter((s) => this.hp(s).chips > 0);
  }

  private potTotal(): number {
    return this.allSeats().reduce((sum, s) => sum + this.hp(s).committed, 0);
  }

  /** 大盲不足额时，多人仍以完整大盲开局；仅剩一个可行动者时只需匹配实际下注。 */
  private toCall(seat: Seat): number {
    const p = this.hp(seat);
    const others = this.contenders().filter((s) => s !== seat);
    const target = others.some((s) => this.hp(s).chips > 0)
      ? this.state.currentBet
      : Math.min(this.state.currentBet, Math.max(0, ...others.map((s) => this.hp(s).bet)));
    return Math.max(0, target - p.bet);
  }

  private bounds(seat: Seat) {
    const st = this.state;
    const p = this.hp(seat);
    const max = p.bet + p.chips;
    const fullMin = st.currentBet + st.lastRaise;
    const reopened = p.actedAt === null || st.currentBet - p.actedAt >= st.lastRaise;
    const canRaise = p.inHand && !p.folded && p.chips > 0 && max > st.currentBet && reopened &&
      this.actors().some((s) => s !== seat);
    return {
      to_call: this.toCall(seat),
      can_raise: canRaise,
      full_min_raise_to: fullMin,
      // 筹码不足完整加注时，唯一允许的加注总额就是全下总额。
      min_raise_to: canRaise ? Math.min(fullMin, max) : null,
      max_raise_to: canRaise ? max : null,
    };
  }

  private actionsFor(seat: Seat): ActionSpec[] {
    const p = this.hp(seat);
    const b = this.bounds(seat);
    const actions: ActionSpec[] = [];
    const add = (action: string, label: string, command: string) =>
      actions.push({ action, label, example: `act({"action":"${action}"})`, command });
    add('fold', '弃牌', '弃牌');
    if (b.to_call === 0) add('check', '过牌', '过牌');
    else add('call', '跟注', '跟注');
    if (b.can_raise) {
      actions.push({
        action: 'raise',
        label: '加注到',
        params: { number: `本街总额，整数 ${b.min_raise_to}~${b.max_raise_to}；完整加注至少到 ${b.full_min_raise_to}` },
        example: `act({"action":"raise","number":${b.min_raise_to}})`,
        command: `加注 ${b.min_raise_to}`,
      });
    }
    if (p.chips > 0 && (p.chips <= b.to_call || b.can_raise)) add('allin', '全下', '全下');
    return actions;
  }

  /** 按累计投入的各个台阶切池，弃牌筹码入池但没有获奖资格。 */
  private pots(): Pot[] {
    const seats = this.allSeats();
    const levels = [...new Set(seats.map((s) => this.hp(s).committed).filter((n) => n > 0))].sort((a, b) => a - b);
    let previous = 0;
    return levels.map((cap) => {
      const contributors = seats.filter((s) => this.hp(s).committed >= cap);
      const pot: Pot = {
        cap,
        amount: (cap - previous) * contributors.length,
        eligible: contributors.filter((s) => this.hp(s).inHand && !this.hp(s).folded),
        uncalled: contributors.length === 1,
      };
      previous = cap;
      return pot;
    });
  }

  private potName(index: number): string {
    return index === 0 ? '主池' : `边池${index}`;
  }

  start(): void {
    const seats: Record<string, HoldemPlayer> = {};
    for (const p of this.players) {
      p.name = sanitizeName(p.name);
      p.alive = true;
      seats[String(p.seat)] = {
        chips: this.options.start_chips, hole: [], bet: 0, committed: 0,
        inHand: false, folded: false, allin: false, acted: false, actedAt: null,
        starting: this.options.start_chips, rank: null,
      };
    }
    const all = this.allSeats();
    const dealer = all[this.rng.int(all.length)]!;
    Object.assign(this.rec.state, {
      hand: 0, dealer, smallSeat: dealer, bigSeat: dealer,
      smallBlind: this.options.small_blind, bigBlind: this.options.small_blind * 2,
      street: 'preflop', current: null, currentBet: 0, lastRaise: 0,
      board: [], deck: [], seats, lastHand: null,
    } satisfies HoldemState);
    this.announce(`🃏 德州扑克开始！每人 ${this.options.start_chips} 筹码，底牌仅本人可见；加注金额均指本街总额。`);
    this.beginHand();
    this.run(this.state.bigSeat);
  }

  private pay(seat: Seat, amount: number): void {
    const p = this.hp(seat);
    p.chips -= amount;
    p.bet += amount;
    p.committed += amount;
    p.allin = p.chips === 0;
  }

  private beginHand(): void {
    const st = this.state;
    const seats = this.allSeats().filter((s) => this.hp(s).chips > 0);
    if (st.hand > 0) st.dealer = this.orderFrom(st.dealer + 1, seats)[0]!;
    st.hand++;
    this.rec.round = st.hand;
    this.rec.phase = null;
    const interval = this.options.blind_up_hands;
    if (interval > 0 && st.hand > 1 && (st.hand - 1) % interval === 0) {
      // 极端长局的数值护栏；此上限远高于全桌最多 900000 筹码。
      const limit = Math.floor(Number.MAX_SAFE_INTEGER / 4);
      st.smallBlind = Math.min(limit, st.smallBlind * 2);
      st.bigBlind = st.smallBlind * 2;
      this.announce(`⬆️ 盲注上涨：小盲 ${st.smallBlind}，大盲 ${st.bigBlind}。`);
    }
    for (const s of this.allSeats()) {
      const p = this.hp(s);
      p.hole = [];
      p.bet = p.committed = 0;
      p.inHand = p.chips > 0;
      p.folded = p.allin = p.acted = false;
      p.actedAt = null;
      p.starting = p.chips;
    }
    st.board = [];
    st.deck = shuffle(this.rng, DECK);
    st.street = 'preflop';
    st.current = null;
    st.currentBet = st.bigBlind;
    st.lastRaise = st.bigBlind;
    st.smallSeat = seats.length === 2 ? st.dealer : this.orderFrom(st.dealer + 1, seats)[0]!;
    st.bigSeat = this.orderFrom(st.smallSeat + 1, seats)[0]!;
    this.pay(st.smallSeat, Math.min(st.smallBlind, this.hp(st.smallSeat).chips));
    this.pay(st.bigSeat, Math.min(st.bigBlind, this.hp(st.bigSeat).chips));
    const dealOrder = this.orderFrom(st.dealer + 1, seats);
    for (let i = 0; i < 2; i++) {
      for (const s of dealOrder) this.hp(s).hole.push(st.deck.shift()!);
    }
    this.announce(
      `🔔 第 ${st.hand} 手：庄家 ${this.label(st.dealer)}。\n` +
      `小盲 ${this.label(st.smallSeat)}：${st.smallBlind}（实收 ${this.hp(st.smallSeat).bet}）；` +
      `大盲 ${this.label(st.bigSeat)}：${st.bigBlind}（实收 ${this.hp(st.bigSeat).bet}）。`,
    );
    for (const s of seats) this.tell(s, `🃏 第 ${st.hand} 手，你的底牌：${this.hp(s).hole.join(' ')}`, { category: 'role' });
  }

  private openTurn(): void {
    const seat = this.state.current!;
    const p = this.hp(seat);
    const b = this.bounds(seat);
    const actions = this.actionsFor(seat);
    const raiseText = b.can_raise
      ? `最小加注到 ${b.min_raise_to}（完整加注至少到 ${b.full_min_raise_to}），最大到 ${b.max_raise_to}`
      : '当前不可加注';
    const prompt = `底池 ${this.potTotal()}，需跟注 ${b.to_call}，${raiseText}；你剩余 ${p.chips} 筹码。`;
    this.openPhase({
      key: 'turn',
      title: `第${this.state.hand}手·${STREET_NAMES[this.state.street]}·${seat}号行动`,
      timeoutMs: this.options.turn_timeout_s * 1000,
      requests: [{ seat, prompt, actions, channel: 'group' }],
    });
    this.announce(`👉 ${this.at(seat)} 请行动：${prompt}（限时 ${this.options.turn_timeout_s} 秒）`);
    this.tell(
      seat,
      `🃏 你的底牌：${p.hole.join(' ')}\n公共牌：${this.state.board.join(' ') || '尚未翻开'}\n` +
      `${prompt}\n请在群里发送：${actions.map((a) => `「${a.command}」`).join(' / ')}。跟注不足时自动全下。`,
      { category: 'prompt' },
    );
  }

  onAction(seat: Seat, input: ActionInput, _meta: ActionMeta): string {
    const action = sanitizeUserText(input.action);
    const req = this.requireTurn(seat, action);
    if (action === 'raise') {
      const n = input.number;
      const b = this.bounds(seat);
      if (n === undefined || !Number.isSafeInteger(n)) throw invalidAction('加注需要整数 number，表示本街下注总额。');
      if (!b.can_raise || n <= this.state.currentBet || n > b.max_raise_to!)
        throw invalidAction('当前不能加注到这个金额，或加注权尚未重新开放。');
      if (n < b.full_min_raise_to && n !== b.max_raise_to)
        throw invalidAction(`最小完整加注到 ${b.full_min_raise_to}；不足时只能全下到 ${b.max_raise_to}。`);
    }
    this.phase!.data = { action, ...(action === 'raise' ? { number: input.number! } : {}), auto: false };
    this.markDone(seat);
    return `已选择${req.actions.find((a) => a.action === action)!.label}${action === 'raise' ? ` ${input.number}` : ''}。`;
  }

  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    this.phase!.data = { action: this.toCall(seat) === 0 ? 'check' : 'fold', auto: true };
  }

  advance(): void {
    if (this.rec.status !== 'running' || !this.phase || !this.isPhaseComplete()) return;
    const seat = this.state.current!;
    const { action, number, auto } = this.phase.data;
    const p = this.hp(seat);
    let amount = 0;
    let text: string;
    switch (action) {
      case 'fold':
        p.folded = true;
        // 连本人的后续视图也不保留弃牌；此前发给本人的私信仍保持私密。
        p.hole = [];
        text = '弃牌';
        break;
      case 'check':
        text = '过牌';
        break;
      case 'call':
        amount = Math.min(p.chips, this.toCall(seat));
        this.pay(seat, amount);
        text = `跟注 ${amount}${p.allin ? '（全下）' : ''}`;
        break;
      case 'raise':
      case 'allin':
        amount = action === 'allin' ? p.chips : Number(number) - p.bet;
        this.pay(seat, amount);
        text = action === 'allin'
          ? `全下 ${amount}，本街总额 ${p.bet}`
          : `加注到 ${p.bet}（投入 ${amount}${p.allin ? '，全下' : ''}）`;
        break;
      default:
        throw invalidState('德州扑克阶段缺少有效行动。');
    }
    if (p.bet > this.state.currentBet) {
      const increment = p.bet - this.state.currentBet;
      if (increment >= this.state.lastRaise) this.state.lastRaise = increment;
      this.state.currentBet = p.bet;
    }
    p.acted = true;
    p.actedAt = action === 'check' && this.state.currentBet === 0 ? null : this.state.currentBet;
    this.announce(`📢 ${this.label(seat)} ${text}${auto ? '（超时，程序托管）' : ''}。`, {
      kind: 'action', data: { seat, action, amount, bet: p.bet, auto: Boolean(auto) },
    });
    this.run(seat);
  }

  /** 迭代推进，避免连续全下盲注、连续平局时递归增长调用栈。 */
  private run(after: Seat): void {
    for (;;) {
      const remaining = this.contenders();
      const actors = this.actors();
      if (remaining.length === 1) {
        this.settleHand(false);
      } else if (actors.length === 0 || (actors.length === 1 && this.toCall(actors[0]!) === 0)) {
        this.refundUncalled();
        while (this.state.street !== 'river') this.nextStreet();
        this.settleHand(true);
      } else {
        const next = this.orderFrom(after + 1, actors)
          .find((s) => !this.hp(s).acted || this.toCall(s) > 0);
        if (next !== undefined) {
          this.state.current = next;
          this.openTurn();
          return;
        }
        this.refundUncalled();
        if (this.state.street !== 'river') {
          this.nextStreet();
          after = this.state.dealer;
          continue;
        }
        this.settleHand(true);
      }
      if (this.rec.status === 'ended') return;
      this.beginHand();
      after = this.state.bigSeat;
    }
  }

  private refundUncalled(): void {
    const ordered = this.allSeats().sort((a, b) => this.hp(b).bet - this.hp(a).bet);
    const seat = ordered[0]!;
    const p = this.hp(seat);
    const amount = p.bet - (ordered[1] === undefined ? 0 : this.hp(ordered[1]).bet);
    if (amount <= 0) return;
    p.bet -= amount;
    p.committed -= amount;
    p.chips += amount;
    p.allin = false;
    this.announce(`↩️ ${this.label(seat)} 未被匹配的下注 ${amount} 已退回。`, { kind: 'refund' });
  }

  private nextStreet(): void {
    const st = this.state;
    const next = st.street === 'preflop' ? 'flop' : st.street === 'flop' ? 'turn' : 'river';
    const count = next === 'flop' ? 3 : 1;
    if (st.deck.length < count + 1) throw invalidState('德州扑克牌堆不足。');
    st.deck.shift(); // 每街先烧一张；烧牌永不进入任何视图。
    st.board.push(...st.deck.splice(0, count));
    st.street = next;
    st.current = null;
    st.currentBet = 0;
    st.lastRaise = st.bigBlind;
    for (const s of this.allSeats()) {
      const p = this.hp(s);
      p.bet = 0;
      p.acted = false;
      p.actedAt = null;
    }
    this.announce(`🃏 ${STREET_NAMES[next]}公共牌：${st.board.join(' ')}`, { kind: 'board' });
  }

  private settleHand(showdown: boolean): void {
    const st = this.state;
    this.refundUncalled();
    const remaining = this.contenders();
    const values = new Map<Seat, HandValue>();
    st.current = null;
    st.street = showdown ? 'showdown' : 'settled';
    this.rec.phase = null;
    if (showdown) {
      for (const s of remaining) values.set(s, evaluate([...this.hp(s).hole, ...st.board]));
      this.announce(
        `🔍 摊牌！公共牌：${st.board.join(' ')}\n` +
        this.orderFrom(st.dealer + 1, remaining)
          .map((s) => `${this.label(s)}：${this.hp(s).hole.join(' ')}（${values.get(s)!.name}）`).join('\n'),
        { kind: 'showdown' },
      );
    } else {
      this.announce(`🏆 只剩 ${this.label(remaining[0]!)} 未弃牌，直接赢池，不亮底牌。`);
    }
    const settled: SettledPot[] = [];
    for (const [index, pot] of this.pots().entries()) {
      const eligible = showdown ? pot.eligible : remaining;
      if (eligible.length === 0) throw invalidState('底池没有符合资格的玩家。');
      let winners = [...eligible];
      if (showdown) {
        let best = values.get(eligible[0]!)!;
        for (const s of eligible) if (compare(values.get(s)!, best) > 0) best = values.get(s)!;
        winners = eligible.filter((s) => compare(values.get(s)!, best) === 0);
      }
      winners = this.orderFrom(st.dealer + 1, winners);
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount % winners.length;
      const awards = winners.map((seat, i) => ({ seat, amount: share + (i === 0 ? remainder : 0) }));
      for (const award of awards) this.hp(award.seat).chips += award.amount;
      settled.push({ ...pot, eligible: [...pot.eligible], awards });
      this.announce(
        `💰 ${this.potName(index)} ${pot.amount}：${awards.map((a) => `${this.label(a.seat)} 赢得 ${a.amount}`).join('；')}。`,
        { kind: 'pot', data: { index, amount: pot.amount, awards } },
      );
    }
    st.lastHand = { hand: st.hand, board: [...st.board], showdown, pots: settled };
    for (const s of this.allSeats()) {
      const p = this.hp(s);
      p.bet = p.committed = 0;
      p.allin = p.inHand && !p.folded && p.chips === 0;
    }
    const busted = this.players.filter((p) => p.alive && this.hp(p.seat).chips === 0);
    const survivors = this.players.filter((p) => this.hp(p.seat).chips > 0);
    for (const p of busted) {
      const h = this.hp(p.seat);
      h.rank = survivors.length + 1 + busted.filter((q) => this.hp(q.seat).starting > h.starting).length;
      p.alive = false;
      this.announce(`💥 ${this.label(p.seat)} 筹码归零，出局！第${h.rank}名。`, { kind: 'death' });
    }
    const capped = this.options.max_hands > 0 && st.hand >= this.options.max_hands;
    if (survivors.length !== 1 && !capped) return;
    const richest = Math.max(...survivors.map((p) => this.hp(p.seat).chips));
    const winners = survivors.filter((p) => this.hp(p.seat).chips === richest).map((p) => p.seat);
    for (const p of survivors) {
      this.hp(p.seat).rank = 1 + survivors.filter((q) => this.hp(q.seat).chips > this.hp(p.seat).chips).length;
    }
    this.finish({
      winnerTeam: winners.map((s) => sanitizeName(this.player(s).name)).join('、'),
      winnerSeats: winners,
      reason: survivors.length === 1 ? '只剩一位玩家拥有筹码' : `已打满 ${st.hand} 手，按最终筹码排名（并列共享胜利）`,
      reveal: [...this.players]
        .sort((a, b) => this.hp(a.seat).rank! - this.hp(b.seat).rank! || a.seat - b.seat)
        .map((p) => ({
          seat: p.seat,
          name: sanitizeName(p.name),
          identity: `第${this.hp(p.seat).rank}名${winners.includes(p.seat) ? ' 🏆 冠军' : ''}，最终筹码 ${this.hp(p.seat).chips}`,
        })),
    });
  }

  privateView(seat: Seat): Record<string, unknown> {
    this.player(seat);
    const p = this.hp(seat);
    const hole = p.inHand && !p.folded ? [...p.hole] : [];
    const best = hole.length === 2 && this.state.board.length >= 3 ? evaluate([...hole, ...this.state.board]) : null;
    return {
      hole,
      chips: p.chips,
      best_hand: best ? { name: best.name, category: best.category, ranks: [...best.ranks] } : null,
      ...(this.pendingOf(seat) ? this.bounds(seat) : {}),
    };
  }

  publicView(): Record<string, unknown> {
    const st = this.state;
    const last = st.lastHand;
    return {
      hand: st.hand,
      dealer: st.dealer,
      small_blind: st.smallBlind,
      big_blind: st.bigBlind,
      small_blind_seat: st.smallSeat,
      big_blind_seat: st.bigSeat,
      street: st.street,
      board: [...st.board],
      pot: this.potTotal(),
      pots: this.pots().map((p, i) => ({ ...p, name: this.potName(i), eligible: [...p.eligible] })),
      current_bet: st.currentBet,
      last_raise: st.lastRaise,
      current_turn: st.current !== null && this.rec.status === 'running' && this.pendingOf(st.current) ? st.current : null,
      players: this.players.map((p) => ({
        seat: p.seat, name: sanitizeName(p.name), alive: p.alive, eliminated: !p.alive,
        chips: this.hp(p.seat).chips, bet: this.hp(p.seat).bet, committed: this.hp(p.seat).committed,
        in_hand: this.hp(p.seat).inHand, folded: this.hp(p.seat).folded,
        allin: this.hp(p.seat).allin, rank: this.hp(p.seat).rank,
      })),
      // 摊牌底牌仅进入摊牌公告；公开视图连历史结果也不携带任何底牌。
      last_hand: last ? {
        hand: last.hand, board: [...last.board], showdown: last.showdown,
        pots: last.pots.map((p, i) => ({
          name: this.potName(i), amount: p.amount, cap: p.cap, eligible: [...p.eligible],
          awards: p.awards.map((a) => ({ seat: a.seat, amount: a.amount })),
        })),
      } : null,
    };
  }

  override parseCommand(seat: Seat, text: string, channel: 'group' | 'private'): ActionInput | null {
    if (channel !== 'group' || this.phase?.key !== 'turn' || !this.pendingOf(seat)) return null;
    // 不使用 stripTrailing：它会把「梭哈」末尾的「哈」当语气词去掉。
    const t = sanitizeUserText(normalizeText(text)).toLowerCase().replace(/[\s。.!！?？,，;；~～…]+$/u, '');
    if (/^(弃牌|弃)$/u.test(t)) return { action: 'fold' };
    if (/^(过|过牌)$/u.test(t)) return { action: 'check' };
    if (/^(跟|跟注)$/u.test(t)) return { action: 'call' };
    if (/^(全下|allin|梭哈)$/u.test(t)) return { action: 'allin' };
    const m = t.match(/^(?:加注|加到|加)\s*(.+)$/u);
    const n = m ? parseIntLoose(m[1]!) : null;
    return n !== null && Number.isSafeInteger(n) ? { action: 'raise', number: n } : null;
  }

  override randomAction(seat: Seat): ActionInput | null {
    if (!this.pendingOf(seat)) return null;
    // 只依赖公开下注信息；不读取其他人的底牌、牌堆或未来公共牌。
    const actions = this.actionsFor(seat);
    const action = actions[this.rng.int(actions.length)]!.action;
    if (action !== 'raise') return { action };
    const b = this.bounds(seat);
    return { action, number: b.min_raise_to! + this.rng.int(b.max_raise_to! - b.min_raise_to! + 1) };
  }
}

export const holdemDefinition: GameDefinition<HoldemOptions> = {
  type: 'holdem',
  name: '德州扑克',
  aliases: ['德州扑克', '德州', 'texas', 'holdem'],
  idPrefix: 'TH',
  minPlayers: 2,
  maxPlayers: 9,
  summary: '私密底牌、无限注与边池，程序发牌比牌，争夺全部锦标赛筹码。',
  rules: RULES,
  playerTips: '- 加注 number 是本街总额，不是额外投入。\n- 只依据自己的底牌、公共牌和公开下注判断；注意全下后的边池资格与加注权。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    start_chips: '每人初始筹码（200~100000，默认 1000）',
    small_blind: '初始小盲（1~100000，默认 10）；大盲为两倍',
    blind_up_hands: '每打满多少手盲注翻倍（默认 10，0=不涨；极端长局在安全整数上限饱和）',
    max_hands: '手数上限（默认 0=不限）；达到后按筹码排名，并列共享胜利',
    turn_timeout_s: '每次行动限时（秒，默认 45）；超时能过则过，否则弃牌',
  },
  create: (rec, env) => new HoldemGame(rec, env),
};
