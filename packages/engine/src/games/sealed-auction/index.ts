/**
 * 密封竞拍 —— 原创玩法。
 *
 * 程序生成拍品的真实价值，每轮向各玩家私下提供独立的鉴定估价。
 * 所有人同时密封出价，全部提交或超时后统一揭晓、结算；裁判只负责转发。
 */
import { z } from 'zod';
import { invalidAction } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { shuffle } from '../../core/rng.js';
import { normalizeText, parseIntLoose, sanitizeName, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, PendingRequest, Seat } from '../../core/types.js';

const optionsSchema = z.object({
  ...commonOptionShape,
  start_coins: z.number().int().min(50).max(1000).default(100),
  rounds: z.number().int().min(3).max(12).default(6),
  price: z.enum(['first', 'second']).default('first'),
  bid_timeout_s: secondsOption(60),
});

export type SealedAuctionOptions = z.infer<typeof optionsSchema>;

/** 原创拍品名（至少和最大轮数一样多，开局不重复抽取） */
const ITEM_NAMES = [
  '旧怀表',
  '蓝釉瓷瓶',
  '船长日志',
  '月纹铜镜',
  '风铃罗盘',
  '琥珀书签',
  '银叶茶罐',
  '星砂沙漏',
  '雾港地图',
  '赤铜烛台',
  '藤纹琴盒',
  '珊瑚墨瓶',
  '羽纹胸针',
  '云纹砚台',
  '夜航望远镜',
  '绿绒首饰匣',
  '雪松烟斗',
  '鲸骨棋子',
  '贝壳八音盒',
  '流萤灯罩',
  '青石镇纸',
  '晨露玻璃杯',
  '旧驿站邮袋',
  '黄铜星盘',
] as const;

interface AuctionItem {
  name: string;
  value: number;
}

interface SealedBid {
  amount: number;
  auto: boolean;
}

/** 本轮秘密只保存在阶段数据中，不进入公开视图。 */
interface BidPhaseData {
  estimates: Record<string, number>;
  bids: Record<string, SealedBid>;
}

interface AuctionResult {
  round: number;
  item: string;
  value: number;
  bids: (SealedBid & { seat: Seat })[];
  winner: Seat | null;
  price: number;
  /** 需要抽签的并列最高价座位；流拍或无并列时为空。 */
  tied: Seat[];
}

export interface SealedAuctionState {
  /** 尚未结算的拍品价值必须保密。 */
  items: AuctionItem[];
  coins: Record<string, number>;
  /** 各座位收藏的总价值，不是件数。 */
  collections: Record<string, number>;
  /** 只收录已经统一揭晓的轮次。 */
  history: AuctionResult[];
}

const RULES = `## 密封竞拍（原创玩法）

- 3～8 人参加，每人初始 100 金币，可用 \`start_coins\` 调整为 50～1000。
- 默认拍卖 6 轮，可用 \`rounds\` 调整为 3～12。程序开局生成全部拍品：名字各不相同，真实价值为 10～60 的整数。
- 每轮开始公开本轮拍品名字。程序私下给每人一份鉴定估价：真实价值加上独立随机误差（-15～+15），最低为 0。估价只供本人参考，不保证准确。
- 所有人同时密封出价，提交 0～自己当前金币的整数，提交后不可修改。默认限时 60 秒，可用 \`bid_timeout_s\` 调整。
- 全员提交或截止后统一结算；未提交者按出价 0 处理。金币为 0 的玩家仍参加出价，且只能出 0。
- 最高价者得标；并列最高时由程序在并列者中随机抽签，并在公告中说明。最高价为 0 时流拍，不抽签。
- 价格模式：
  - \`first\`（默认）：得标人支付自己的出价。
  - \`second\`：得标人支付第二高的出价（按每个人的出价排序，包含并列；不是第二个不同的价格）。只有一人出价大于 0 时支付 0。
- 结算公开所有人的出价、得标人、成交价和拍品真实价值；流拍也揭晓真实价值。只有得标人扣除成交价，并增加相应的收藏价值。
- 全部轮次结束，得分 = 剩余金币 + 收藏总价值，最高分者获胜；并列最高分共同获胜。
- 拍品、估价、抽签、结算及胜负全部由程序决定，裁判只能转发消息。

**真人指令**（仅私聊裁判）：发送「出价20」「20」；发送「过」「放弃」「不出」表示出价 0。不要在群里公开出价。
**bot 指令**：\`act({"action":"bid","number":20})\``;

export class SealedAuctionGame extends BaseGame<SealedAuctionState, SealedAuctionOptions> {
  start(): void {
    this.rec.round = 1;
    const names = shuffle(this.rng, ITEM_NAMES);
    Object.assign(this.rec.state, {
      items: Array.from({ length: this.options.rounds }, (_, i) => ({
        name: names[i]!,
        value: 10 + this.rng.int(51),
      })),
      coins: Object.fromEntries(this.allSeats().map((s) => [String(s), this.options.start_coins])),
      collections: Object.fromEntries(this.allSeats().map((s) => [String(s), 0])),
      history: [],
    } satisfies SealedAuctionState);
    this.announce(
      `🔨 密封竞拍开始！这是一款原创玩法，每人持有 ${this.options.start_coins} 金币，共拍卖 ${this.options.rounds} 轮。\n` +
        `价格模式：${this.options.price === 'first' ? '第一价格，支付自己的出价' : '第二价格，支付第二高出价'}。最终以剩余金币 + 收藏总价值决胜，同分共同获胜。`,
    );
    this.openBidding();
  }

  private openBidding(): void {
    const item = this.state.items[this.rec.round - 1]!;
    const estimates: Record<string, number> = {};
    this.announce(
      `🏺 第 ${this.rec.round}/${this.options.rounds} 轮拍品：「${item.name}」。\n` +
        `请所有玩家私下出价，限时 ${this.options.bid_timeout_s} 秒；全员提交或截止后统一揭晓，超时视为 0。`,
    );
    for (const seat of this.allSeats()) {
      const estimate = Math.max(0, item.value + this.rng.int(31) - 15);
      estimates[String(seat)] = estimate;
      this.tell(
        seat,
        `🔎 第 ${this.rec.round} 轮「${item.name}」：你的鉴定估价：${estimate}。\n` +
          `估价含 -15～+15 的独立随机误差，最低为 0；你当前有 ${this.state.coins[String(seat)]!} 金币。请勿公开估价和出价。`,
        { kind: 'appraisal' },
      );
    }
    // 每轮固定开启同一个秘密阶段，全员同时有待办，包括金币为 0 的玩家。
    this.openPhase({
      key: 'bid',
      title: `第${this.rec.round}轮·密封出价`,
      timeoutMs: this.options.bid_timeout_s * 1000,
      secret: true,
      data: { estimates, bids: {} } satisfies BidPhaseData,
      requests: this.allSeats().map((seat) => {
        const coins = this.state.coins[String(seat)]!;
        const example = Math.min(20, coins);
        return {
          seat,
          prompt: `请私下提交 0~${coins} 金币的整数出价，提交后不可修改；超时按 0 处理。`,
          channel: 'private',
          actions: [
            {
              action: 'bid',
              label: '密封出价',
              params: { number: `0~${coins} 之间的整数` },
              example: `act({"action":"bid","number":${example}})`,
              command: `出价${example}（或「过」出价 0）`,
            },
          ],
        };
      }),
    });
  }

  onAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
    // 不把玩家传来的任意 action 字符串拼进错误消息。
    if (input.action !== 'bid') throw invalidAction('当前只能执行 bid（密封出价）。');
    this.requireTurn(seat, input.action);
    if (meta.via === 'relay' && meta.channel !== 'private') {
      throw invalidAction('请私聊裁判出价，不要在群里公开。');
    }
    const n = input.number;
    const coins = this.state.coins[String(seat)]!;
    if (n === undefined || !Number.isInteger(n)) throw invalidAction('需要提供整数 number。');
    if (n < 0 || n > coins) throw invalidAction(`只能出价 0~${coins} 金币。`);
    const data = this.phase!.data as BidPhaseData;
    data.bids[String(seat)] = { amount: n, auto: false };
    this.markDone(seat);
    this.tell(seat, `✉️ 你的出价已密封：${n} 金币，提交后不可修改。`, { kind: 'bid', category: 'feedback' });
    return '出价已密封提交，请等待统一结算。';
  }

  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    const data = this.phase!.data as BidPhaseData;
    data.bids[String(seat)] = { amount: 0, auto: true };
  }

  advance(): void {
    if (this.phase?.key !== 'bid' || !this.isPhaseComplete()) return;
    const data = this.phase.data as BidPhaseData;
    const item = this.state.items[this.rec.round - 1]!;
    const bids = this.allSeats().map((seat) => {
      const { amount, auto } = data.bids[String(seat)]!;
      return { seat, amount, auto };
    });
    const amounts = bids.map((b) => b.amount).sort((a, b) => b - a);
    const highest = amounts[0]!;
    const leaders = bids.filter((b) => b.amount === highest).map((b) => b.seat);
    const tied = highest > 0 && leaders.length > 1 ? leaders : [];
    let winner: Seat | null = null;
    let price = 0;
    if (highest > 0) {
      winner = leaders.length === 1 ? leaders[0]! : leaders[this.rng.int(leaders.length)]!;
      price = this.options.price === 'first' ? highest : (amounts[1] ?? 0);
      const key = String(winner);
      this.state.coins[key] = this.state.coins[key]! - price;
      this.state.collections[key] = this.state.collections[key]! + item.value;
    }
    this.state.history.push({
      round: this.rec.round,
      item: item.name,
      value: item.value,
      bids,
      winner,
      price,
      tied,
    });
    const bidText = bids
      .map((b) => `${this.label(b.seat)}：${b.amount} 金币${b.auto ? '（超时视为 0）' : ''}`)
      .join('\n');
    const resultText =
      winner === null
        ? '无人出正价，本轮流拍。'
        : `${tied.length > 1 ? `最高价并列（${tied.map((s) => this.label(s)).join('、')}），程序随机抽签；` : ''}` +
          `${this.label(winner)} 得标，成交价 ${price} 金币。`;
    this.announce(
      `🔨 第 ${this.rec.round} 轮结算：「${item.name}」\n` +
        `—— 全员出价 ——\n${bidText}\n${resultText}\n真实价值揭晓：${item.value}。`,
      { kind: 'auction_result', data: { round: this.rec.round, winner, price, value: item.value, tied } },
    );
    if (this.rec.round >= this.options.rounds) {
      this.finishAuction();
      return;
    }
    this.rec.round += 1;
    this.openBidding();
  }

  private finishAuction(): void {
    const scores = this.players.map((p) => {
      const coins = this.state.coins[String(p.seat)]!;
      const collection = this.state.collections[String(p.seat)]!;
      return { seat: p.seat, name: sanitizeName(p.name), coins, collection, score: coins + collection };
    });
    const best = Math.max(...scores.map((s) => s.score));
    this.finish({
      winnerTeam: '最佳收藏家',
      winnerSeats: scores.filter((s) => s.score === best).map((s) => s.seat),
      reason: `${this.options.rounds} 轮拍卖结束，剩余金币 + 收藏总价值最高为 ${best} 分，同分共同获胜。`,
      reveal: scores.map((s) => ({
        seat: s.seat,
        name: s.name,
        identity: `${s.score === best ? '🏆 冠军' : '收藏家'}；金币 ${s.coins}，收藏 ${s.collection}，总分 ${s.score}`,
      })),
    });
  }

  privateView(seat: Seat): Record<string, unknown> {
    this.player(seat);
    const key = String(seat);
    const data = this.phase?.key === 'bid' ? (this.phase.data as BidPhaseData) : null;
    return {
      identity: '收藏家',
      coins: this.state.coins[key]!,
      collection_value: this.state.collections[key]!,
      estimate: data?.estimates[key] ?? null,
      bid: data?.bids[key]?.amount ?? null,
      note: '鉴定估价含随机误差；出价提交后不可修改，结算前仅自己可见。',
    };
  }

  publicView(): Record<string, unknown> {
    return {
      price: this.options.price,
      round: this.rec.round,
      total_rounds: this.options.rounds,
      current_item: this.rec.status === 'running' ? { name: this.state.items[this.rec.round - 1]!.name } : null,
      players: this.players.map((p) => {
        const coins = this.state.coins[String(p.seat)]!;
        const collection = this.state.collections[String(p.seat)]!;
        return { seat: p.seat, name: sanitizeName(p.name), coins, collection_value: collection, score: coins + collection };
      }),
      // 只投影已经揭晓的历史；不返回待拍品、估价或当前阶段的出价。
      history: this.state.history.map((h) => ({
        round: h.round,
        item: h.item,
        value: h.value,
        bids: h.bids.map((b) => ({ seat: b.seat, amount: b.amount, auto: b.auto })),
        winner: h.winner,
        price: h.price,
        tied: [...h.tied],
      })),
    };
  }

  override parseCommand(seat: Seat, text: string, channel: 'group' | 'private'): ActionInput | null {
    if (channel !== 'private' || this.phase?.key !== 'bid' || !this.pendingOf(seat)) return null;
    const t = stripTrailing(normalizeText(text));
    if (/^(过|放弃|不出)$/u.test(t)) return { action: 'bid', number: 0 };
    const n = parseIntLoose(t.replace(/^(我出价|出价|我出|出)\s*/u, ''));
    return n === null ? null : { action: 'bid', number: n };
  }

  override randomAction(seat: Seat): ActionInput | null {
    if (this.phase?.key !== 'bid' || !this.pendingOf(seat)) return null;
    const data = this.phase.data as BidPhaseData;
    const coins = this.state.coins[String(seat)]!;
    const estimate = data.estimates[String(seat)]!;
    const remaining = this.options.rounds - this.rec.round + 1;
    // 只参考本人的估价与公开预算，不读取真实价值或其他人的秘密。
    const hi = Math.min(60, coins, estimate, Math.ceil((coins / remaining) * 2));
    const lo = Math.floor(hi / 2);
    return { action: 'bid', number: lo + this.rng.int(hi - lo + 1) };
  }
}

export const sealedAuctionDefinition: GameDefinition<SealedAuctionOptions> = {
  type: 'sealed_auction',
  name: '密封竞拍',
  aliases: ['密封竞拍', '密封拍卖', 'sealed-auction', 'sealedauction'],
  idPrefix: 'SA',
  minPlayers: 3,
  maxPlayers: 8,
  summary: '原创密封拍卖：依据私密估价同时出价，用剩余金币与收藏价值争夺冠军。',
  rules: RULES,
  playerTips: '- 估价不是实价，要考虑误差和剩余轮次，避免过早耗尽金币。\n- 第二价格模式包含并列出价；高价抢拍仍可能付出高价。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    start_coins: '每人初始金币（50～1000，默认 100）',
    rounds: '拍卖轮数（3～12，默认 6）',
    price: 'first=支付自己的出价（默认）；second=支付第二高出价，只有一人出正价时付 0',
    bid_timeout_s: '每轮同时出价限时（秒，默认 60）；超时出价为 0',
  },
  embeddable: true,
  create: (rec, env) => new SealedAuctionGame(rec, env),
};
