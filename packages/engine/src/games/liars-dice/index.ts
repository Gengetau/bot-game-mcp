/**
 * 大话骰（吹牛骰）—— 酒吧规则。
 *
 * 每人若干颗骰子，只有自己知道点数。轮流叫「N个F点」（全场至少有 N 个 F），
 * 后一个人必须加注或者「开」。开牌后全部亮骰，叫错的一方扣一条命，命没了出局，最后一人获胜。
 * 骰子全部由程序摇出，叫牌合法性、开牌结算、胜负均由程序判定。
 */
import { z } from 'zod';
import { invalidAction } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { normalizeText, parseIntLoose, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, PendingRequest, Seat } from '../../core/types.js';

const optionsSchema = z.object({
  ...commonOptionShape,
  dice_per_player: z.number().int().min(1).max(6).default(5),
  lives: z.number().int().min(1).max(5).default(3),
  wild_ones: z.boolean().default(true),
  min_open_quantity: z.number().int().min(0).max(60).default(0),
  turn_timeout_s: secondsOption(45),
});

export type LiarsDiceOptions = z.infer<typeof optionsSchema>;

interface Bid {
  seat: Seat;
  quantity: number;
  face: number;
}

interface BidRecord extends Bid {
  auto: boolean;
}

interface ChallengeResult {
  round: number;
  challenger: Seat;
  bidder: Seat;
  quantity: number;
  face: number;
  count: number;
  wildUsed: boolean;
  loser: Seat;
  eliminated: boolean;
  dice: Record<string, number[]>;
}

export interface LiarsDiceState {
  /** 本轮各座位的骰子（座位 → 点数），出局者为空数组 */
  dice: Record<string, number[]>;
  lives: Record<string, number>;
  bid: Bid | null;
  history: BidRecord[];
  current: Seat;
  starter: Seat;
  eliminated: Seat[];
  results: ChallengeResult[];
}

const RULES = `## 大话骰（酒吧规则）

- 每人有 \`dice_per_player\` 颗骰子（默认 5）和 \`lives\` 条命（默认 3）。每轮由**程序**给所有人摇骰，每个人只会私下收到自己的点数。
- 从起始玩家开始顺时针轮流叫牌：「N 个 F 点」，意思是「全场所有人的骰子里，F 点至少有 N 个」。
- 第一个叫牌的人至少叫「在场人数」个（可用 \`min_open_quantity\` 调整）。
- 后面的人必须**加注**，或者**开牌**：
  - 加注：个数更大；或个数相同但点数更大。点数大小顺序：**2 < 3 < 4 < 5 < 6 < 1**（1 最大）。例：3个6 < 3个1 < 4个2。
  - 开牌：质疑上一家叫得太高。
- 开牌后所有人亮骰，程序数点：
  - 数出叫牌点数的骰子数量；\`wild_ones\`（默认开启）时，1 是百搭，也算作任何点数——**但叫的是 1 点时只数 1**。
  - 实际个数 ≥ 叫的个数：叫牌者没吹牛，**开牌者**失去 1 条命；否则**叫牌者**失去 1 条命。
- 命为 0 的玩家出局，只剩一人时游戏结束。下一轮由输家先叫（输家出局则由其下家先叫）。
- 超时托管：还没人叫牌时程序替你叫最小开局（个数最小的 2 点）；否则程序替你开牌。

**真人指令**（轮到你时在群里或私聊发）：「3个5」「三个五」「叫4个6」「4 6」；开牌发「开」。
**bot 指令**：\`act({"action":"bid","quantity":3,"face":5})\`、\`act({"action":"challenge"})\``;

const FACE_RANK = (f: number): number => (f === 1 ? 7 : f);
const FACE_BY_RANK = [2, 3, 4, 5, 6, 1];

/** a 是否严格大于 b */
function higher(aq: number, af: number, bq: number, bf: number): boolean {
  return aq > bq || (aq === bq && FACE_RANK(af) > FACE_RANK(bf));
}

export class LiarsDiceGame extends BaseGame<LiarsDiceState, LiarsDiceOptions> {
  // ───────────────────────── 工具 ─────────────────────────

  private totalDice(): number {
    return this.aliveSeats().length * this.options.dice_per_player;
  }

  private openMin(): number {
    const o = this.options.min_open_quantity;
    const base = o === 0 ? this.aliveSeats().length : o;
    return Math.max(1, Math.min(this.totalDice(), base));
  }

  /** 最小的合法下一叫；无法再加注返回 null。 */
  private minNextBid(): { quantity: number; face: number } | null {
    const b = this.state.bid;
    const total = this.totalDice();
    if (!b) return { quantity: this.openMin(), face: 2 };
    if (b.face === 1) return b.quantity + 1 <= total ? { quantity: b.quantity + 1, face: 2 } : null;
    const nextFace = FACE_BY_RANK[FACE_RANK(b.face) - 1]!; // rank 2→index1(3) …6→index5(1)
    return { quantity: b.quantity, face: nextFace };
  }

  private bidText(quantity: number, face: number): string {
    return `${quantity}个${face}`;
  }

  private diceText(d: number[] | undefined): string {
    return d && d.length ? d.join(' ') : '（无）';
  }

  private wildNote(): string {
    return this.options.wild_ones ? '1 是百搭（叫 1 点时不算百搭）' : '1 不是百搭';
  }

  // ───────────────────────── 开局与回合 ─────────────────────────

  start(): void {
    this.rec.round = 1;
    const alive = this.aliveSeats();
    const lives: Record<string, number> = {};
    for (const s of alive) lives[String(s)] = this.options.lives;
    Object.assign(this.rec.state, {
      dice: {},
      lives,
      bid: null,
      history: [],
      eliminated: [],
      results: [],
      starter: alive[this.rng.int(alive.length)]!,
    } satisfies Partial<LiarsDiceState>);
    this.announce(
      `🎲 大话骰开始！每人 ${this.options.dice_per_player} 颗骰子、${this.options.lives} 条命。\n` +
        `叫「N个F点」或「开」。点数大小：2<3<4<5<6<1，${this.wildNote()}。`,
    );
    this.startRound(this.state.starter);
  }

  private startRound(starter: Seat): void {
    const st = this.state;
    st.bid = null;
    st.history = [];
    st.starter = starter;
    st.current = starter;
    st.dice = {};
    for (const s of this.aliveSeats()) {
      const d: number[] = [];
      for (let i = 0; i < this.options.dice_per_player; i++) d.push(1 + this.rng.int(6));
      d.sort((a, b) => a - b);
      st.dice[String(s)] = d;
    }
    const livesText = this.aliveSeats()
      .map((s) => `${s}号${'❤'.repeat(st.lives[String(s)]!)}`)
      .join(' ');
    this.announce(
      `🔔 第 ${this.rec.round} 轮：骰子已摇好并私发给每位玩家。\n` +
        `场上共 ${this.totalDice()} 颗骰子，开局至少叫 ${this.openMin()} 个。\n` +
        `命数：${livesText}\n由 ${this.at(starter)} 先叫。`,
    );
    for (const s of this.aliveSeats()) {
      this.tell(s, `🎲 你的骰子：${this.diceText(st.dice[String(s)])}`, { kind: 'dice', category: 'role' });
    }
    this.openTurn();
  }

  private openTurn(): void {
    const st = this.state;
    const seat = st.current;
    const min = this.minNextBid();
    const total = this.totalDice();
    const actions = [
      {
        action: 'bid',
        label: '叫牌',
        params: { quantity: `个数，1~${total}`, face: '点数，1~6（大小 2<3<4<5<6<1）' },
        example: `act({"action":"bid","quantity":${min?.quantity ?? total},"face":${min?.face ?? 1}})`,
        command: '如「3个5」「三个五」',
      },
      ...(st.bid
        ? [{ action: 'challenge', label: '开牌', example: 'act({"action":"challenge"})', command: '开' }]
        : []),
    ];
    const prompt = st.bid
      ? `当前是 ${this.label(st.bid.seat)} 叫的 ${this.bidText(st.bid.quantity, st.bid.face)}。你可以叫更大的${
          min ? `（最小 ${this.bidText(min.quantity, min.face)}）` : '（已无法再加，只能开）'
        }，或者开牌。`
      : `你先叫牌，至少 ${this.openMin()} 个（最大 ${total} 个）。`;
    this.openPhase({
      key: 'turn',
      title: `第${this.rec.round}轮·${seat}号叫牌`,
      timeoutMs: this.options.turn_timeout_s * 1000,
      requests: [{ seat, prompt, channel: 'group', actions }],
    });
    this.announce(
      st.bid
        ? `👉 ${this.at(seat)} 请叫牌：当前 ${this.bidText(st.bid.quantity, st.bid.face)}，` +
            `${min ? `最小可叫 ${this.bidText(min.quantity, min.face)}，` : '已无法再加，'}或发「开」（限时 ${this.options.turn_timeout_s} 秒）`
        : `👉 ${this.at(seat)} 请开叫：至少 ${this.openMin()} 个，如「${this.openMin()}个2」（限时 ${this.options.turn_timeout_s} 秒）`,
    );
  }

  // ───────────────────────── 动作 ─────────────────────────

  onAction(seat: Seat, input: ActionInput, _meta: ActionMeta): string {
    this.requireTurn(seat, input.action);
    const data = this.phase!.data;
    if (input.action === 'challenge') {
      data.action = 'challenge';
      data.auto = false;
      this.markDone(seat);
      return '你选择开牌！';
    }
    const q = input.quantity;
    const f = input.face;
    const total = this.totalDice();
    if (q === undefined || f === undefined || !Number.isInteger(q) || !Number.isInteger(f))
      throw invalidAction('叫牌需要整数 quantity（个数）和 face（点数）。');
    if (f < 1 || f > 6) throw invalidAction('点数 face 只能是 1~6。');
    if (q < 1) throw invalidAction('个数至少为 1。');
    if (q > total) throw invalidAction(`场上一共只有 ${total} 颗骰子，最多叫 ${total} 个。`);
    const cur = this.state.bid;
    if (!cur) {
      if (q < this.openMin()) throw invalidAction(`开叫至少要 ${this.openMin()} 个，最小开叫是 ${this.openMin()}个2。`);
    } else if (!higher(q, f, cur.quantity, cur.face)) {
      const min = this.minNextBid();
      throw invalidAction(
        `必须比当前的 ${this.bidText(cur.quantity, cur.face)} 更大（个数更多，或个数相同且点数更大，顺序 2<3<4<5<6<1）。` +
          (min ? `最小可叫 ${this.bidText(min.quantity, min.face)}。` : '已经无法再加，只能开牌。'),
      );
    }
    data.action = 'bid';
    data.quantity = q;
    data.face = f;
    data.auto = false;
    this.markDone(seat);
    return `你叫了 ${this.bidText(q, f)}。`;
  }

  protected override timeoutDefault(_seat: Seat, _req: PendingRequest): void {
    const data = this.phase!.data;
    data.auto = true;
    if (!this.state.bid) {
      data.action = 'bid';
      data.quantity = this.openMin();
      data.face = 2;
    } else {
      data.action = 'challenge';
    }
  }

  advance(): void {
    const st = this.state;
    const seat = st.current;
    const data = this.phase!.data;
    const auto = Boolean(data.auto);
    const autoText = auto ? `（${this.label(seat)} 超时，程序代为操作）` : '';
    if (data.action === 'bid') {
      const q = Number(data.quantity);
      const f = Number(data.face);
      st.bid = { seat, quantity: q, face: f };
      st.history.push({ seat, quantity: q, face: f, auto });
      this.announce(`📢 ${this.label(seat)} 叫：${this.bidText(q, f)}${autoText}`, {
        kind: 'bid',
        data: { seat, quantity: q, face: f, auto },
      });
      st.current = this.nextAlive(seat)!;
      this.openTurn();
      return;
    }
    this.resolveChallenge(seat, autoText);
  }

  private resolveChallenge(challenger: Seat, autoText: string): void {
    const st = this.state;
    const bid = st.bid!;
    const alive = this.aliveSeats();
    const wild = this.options.wild_ones && bid.face !== 1;
    let exact = 0;
    let ones = 0;
    for (const s of alive) {
      for (const d of st.dice[String(s)] ?? []) {
        if (d === bid.face) exact++;
        else if (wild && d === 1) ones++;
      }
    }
    const count = exact + ones;
    const bidderRight = count >= bid.quantity;
    const loser = bidderRight ? challenger : bid.seat;
    const revealed: Record<string, number[]> = {};
    for (const s of alive) revealed[String(s)] = [...(st.dice[String(s)] ?? [])];
    const lines = this.orderFrom(st.starter, alive).map((s) => `${this.label(s)}：${this.diceText(revealed[String(s)])}`);

    st.lives[String(loser)]! -= 1;
    const left = st.lives[String(loser)]!;
    const out = left <= 0;
    const text =
      `🔍 ${this.label(challenger)} 开牌${autoText}！开的是 ${this.label(bid.seat)} 的 ${this.bidText(bid.quantity, bid.face)}。\n` +
      `亮骰：\n${lines.join('\n')}\n` +
      `点数 ${bid.face} 共 ${count} 个` +
      (wild ? `（其中百搭 1 有 ${ones} 个）` : '') +
      `，${bidderRight ? `≥ ${bid.quantity}，叫牌成立` : `不足 ${bid.quantity}，叫牌失败`}。\n` +
      `💔 ${this.at(loser)} 输了，` +
      (out ? '命数耗尽，出局！' : `失去 1 条命，还剩 ${left} 条。`);
    st.results.push({
      round: this.rec.round,
      challenger,
      bidder: bid.seat,
      quantity: bid.quantity,
      face: bid.face,
      count,
      wildUsed: wild && ones > 0,
      loser,
      eliminated: out,
      dice: revealed,
    });
    if (st.results.length > 5) st.results.shift();
    if (out) {
      this.player(loser).alive = false;
      st.eliminated.push(loser);
      st.dice[String(loser)] = [];
    }
    this.announce(text, { kind: 'challenge', data: { challenger, bidder: bid.seat, count, loser } });

    const remaining = this.aliveSeats();
    if (remaining.length <= 1) {
      const winner = remaining[0]!;
      const total = this.players.length;
      this.finish({
        winnerTeam: this.player(winner).name,
        winnerSeats: [winner],
        reason: `${this.label(winner)} 是最后的幸存者`,
        reveal: this.players.map((p) => ({
          seat: p.seat,
          name: p.name,
          identity:
            p.seat === winner
              ? `🏆 冠军（剩 ${st.lives[String(p.seat)]} 条命）`
              : `第${total - st.eliminated.indexOf(p.seat)}名（第${st.eliminated.indexOf(p.seat) + 1}个出局）`,
        })),
      });
      return;
    }
    this.rec.round += 1;
    this.startRound(out ? this.nextAlive(loser)! : loser);
  }

  // ───────────────────────── 视角 ─────────────────────────

  /** 命数归零的人不再参与叫牌和开牌（轮转只走存活座位）。 */
  override seatFinished(seat: Seat): boolean {
    return !this.isAlive(seat);
  }

  privateView(seat: Seat): Record<string, unknown> {
    return {
      dice: this.state.dice[String(seat)] ?? [],
      lives: this.state.lives[String(seat)] ?? 0,
      wild_ones: this.options.wild_ones,
      note: this.options.wild_ones ? '1 是百搭（叫 1 点时只数 1）' : '本局 1 不是百搭',
    };
  }

  publicView(): Record<string, unknown> {
    const st = this.state;
    const running = this.rec.status === 'running';
    const min = running ? this.minNextBid() : null;
    return {
      round: this.rec.round,
      wild_ones: this.options.wild_ones,
      face_order: '2<3<4<5<6<1',
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        alive: p.alive,
        lives: st.lives[String(p.seat)] ?? 0,
        dice_count: p.alive ? this.options.dice_per_player : 0,
      })),
      total_dice: this.totalDice(),
      min_open_quantity: running ? this.openMin() : null,
      current_turn: running ? `${st.current}号` : null,
      current_bid: st.bid ? { seat: st.bid.seat, quantity: st.bid.quantity, face: st.bid.face } : null,
      bid_history: st.history.map((h) => ({ seat: h.seat, quantity: h.quantity, face: h.face, ...(h.auto ? { auto: true } : {}) })),
      min_next_bid: min,
      can_challenge: Boolean(st.bid),
      last_challenges: st.results.slice(-3).map((r) => ({
        round: r.round,
        challenger: r.challenger,
        bidder: r.bidder,
        bid: { quantity: r.quantity, face: r.face },
        count: r.count,
        loser: r.loser,
        eliminated: r.eliminated,
        revealed_dice: r.dice,
      })),
      eliminated_order: st.eliminated,
    };
  }

  // ───────────────────────── 指令解析 ─────────────────────────

  override parseCommand(seat: Seat, text: string, _channel: 'group' | 'private'): ActionInput | null {
    if (this.phase?.key !== 'turn' || !this.pendingOf(seat)) return null;
    const t = stripTrailing(normalizeText(text)).replace(/[，,]/g, ' ').trim();
    if (/^(我|直接|那我|给你)?\s*(开|开牌|开了|开他|开你|开它|劈|劈你|劈他|不信|我不信|challenge|open)$/iu.test(t))
      return { action: 'challenge' };
    const body = t.replace(/^(我|那我|那|就|我就)?\s*(叫到|叫|喊|报|加到|加|跟到|跟|来|是)?\s*/u, '');
    const N = '[0-9零〇一二两俩三四五六七八九十]+';
    const F = '[1-6一二两俩三四五六幺]';
    const m =
      body.match(new RegExp(`^(${N})\\s*[个只颗粒]\\s*(${F})\\s*[点个]?$`, 'u')) ??
      body.match(new RegExp(`^(${N})\\s+(${F})\\s*[点个]?$`, 'u'));
    if (!m) return null;
    const q = parseIntLoose(m[1]!);
    const f = m[2] === '幺' ? 1 : parseIntLoose(m[2]!);
    if (q === null || f === null) return null;
    return { action: 'bid', quantity: q, face: f };
  }

  override randomAction(seat: Seat): ActionInput | null {
    if (!this.pendingOf(seat)) return null;
    const st = this.state;
    if (!st.bid) {
      const q = Math.min(this.totalDice(), this.openMin() + this.rng.int(3));
      return { action: 'bid', quantity: q, face: 1 + this.rng.int(6) };
    }
    const min = this.minNextBid();
    if (!min || this.rng.int(2) === 0) return { action: 'challenge' };
    return { action: 'bid', quantity: min.quantity, face: min.face };
  }
}

export const liarsDiceDefinition: GameDefinition<LiarsDiceOptions> = {
  type: 'liars_dice',
  name: '大话骰',
  aliases: ['大话骰', '吹牛', '骰子', 'liars_dice', 'liar-dice', 'liars-dice', 'dice'],
  idPrefix: 'LD',
  minPlayers: 2,
  maxPlayers: 8,
  summary: '每人摇骰藏牌，轮流叫「N个F点」，不信就开。叫错的人扣命，最后活下来的获胜。',
  rules: RULES,
  playerTips:
    '- 你自己的骰子是最可靠的信息：估计其他人平均每颗骰子有 1/3（含百搭 1）的概率是你叫的点数。\n' +
    '- 前面的人叫得越离谱越值得开；自己手里一个也没有的点数别乱跟。\n' +
    '- 叫 1 点不能用百搭，但 1 也是最大的点数，能一口气顶高。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    dice_per_player: '每人骰子数（1~6，默认 5）',
    lives: '每人命数（1~5，默认 3）',
    wild_ones: '1 是否为百搭（默认 true；叫 1 点时只数 1）',
    min_open_quantity: '第一个叫牌至少叫几个（0=自动，等于存活人数；默认 0）',
    turn_timeout_s: '每次叫牌/开牌限时（秒，默认 45）',
  },
  embeddable: true,
  create: (rec, env) => new LiarsDiceGame(rec, env),
};
