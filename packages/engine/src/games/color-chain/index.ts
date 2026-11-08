/**
 * 彩牌接龙 —— 同色、同数或同符号接牌，先清空手牌者获胜。
 *
 * 手牌、牌堆和质疑证据只存在存档中；公开视角逐项构造，不返回原始状态。
 * +4 的违规判定延迟到质疑时执行，避免提前拒绝动作而使质疑规则失去意义。
 */
import { z } from 'zod';
import { invalidAction, invalidState } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { shuffle } from '../../core/rng.js';
import { normalizeText, parseIntLoose, sanitizeName, sanitizeUserText, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, ActionSpec, PendingRequest, Seat } from '../../core/types.js';

const COLORS = ['红', '黄', '蓝', '绿'] as const;
const SYMBOLS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '跳过', '反转', '+2'] as const;

export type ChainColor = (typeof COLORS)[number];
type ChainSymbol = (typeof SYMBOLS)[number];
export type ColorChainCard = `${ChainColor}${ChainSymbol}` | '变色' | '变色+4';

/** 游戏局部扩展，不改变其他游戏的动作参数。 */
export interface ColorChainAction extends ActionInput {
  card?: string;
  color?: string;
  call?: boolean;
}

const optionsSchema = z.object({
  ...commonOptionShape,
  hand_size: z.number().int().min(5).max(10).default(7),
  call_penalty: z.boolean().default(true),
  target_score: z.union([z.literal(0), z.number().int().min(100).max(500)]).default(0),
  turn_timeout_s: secondsOption(45),
});

export type ColorChainOptions = z.infer<typeof optionsSchema>;

interface FourChallenge {
  offender: Seat;
  target: Seat;
  previousColor: ChainColor;
  /** 出牌前的快照：不能用喊牌罚摸之后的手牌判断。 */
  hand: ColorChainCard[];
}

export interface ColorChainState {
  hands: Record<string, ColorChainCard[]>;
  /** 数组末尾为下一张要摸的牌。 */
  deck: ColorChainCard[];
  discard: ColorChainCard[];
  currentColor: ChainColor | null;
  direction: 1 | -1;
  current: Seat;
  dealer: Seat;
  drawn: ColorChainCard | null;
  challenge: FourChallenge | null;
  scores: Record<string, number>;
  results: { round: number; winner: Seat; points: number }[];
}

type TurnKind = 'turn' | 'drawn' | 'color' | 'challenge';

const RULES = `## 彩牌接龙

- 2～10 人，108 张牌。红、黄、蓝、绿每色：0 一张，1～9、跳过、反转、+2 各两张；另有变色、变色+4 各四张。
- 每人发 \`hand_size\` 张（默认 7）。首局庄家随机，之后庄家按座位顺时针轮转。
- 默认从庄家左手边开始。起始牌若为跳过或 +2，第一位被跳过（+2 先摸两张）；反转则从庄家右手边开始。
  起始牌为变色时，第一位先选颜色再正常行动；变色+4 放回未发出的牌堆重洗、重新翻牌。
- 轮到你，可以出同色、同数字或同符号的牌，也可以出变色牌并指定红、黄、蓝、绿之一。
- 可以主动摸一张。摸到的牌能出时，只能立即出这张牌或过；不能出时直接结束回合。不能先摸再出原有的其他牌。
- 跳过：跳过下家；反转：改变方向，双人局等同跳过；+2：下家摸两张并跳过。不能叠加处罚牌。
- 变色+4：不得在持有当前颜色的牌时使用；同数字、同符号但不同颜色的牌，以及其他变色牌不影响资格。
  下家有一个单独的质疑窗口：不质疑则摸四张并跳过；质疑成立则出牌者摸四张、下家正常行动；
  质疑不成立则下家摸六张并跳过。违规出牌不提前公开拦截，由质疑结算；证据仅私发给质疑者。
- 出牌后剩一张时，要同时喊「最后一张」（bot 参数 \`call:true\`），否则自动罚摸两张；\`call_penalty:false\` 可关闭处罚。
- 牌堆用完后，保留弃牌堆顶，其余弃牌重洗。若所有可摸牌都已用完，只摸实际可用的数量，不复制牌。
- 清空手牌后结算一局；最后一张的 +2 或 +4 处罚和质疑先结算，再计分。
  数字牌按面值，跳过、反转、+2 各 20 分，变色、变色+4 各 50 分。
  赢家获得其他人剩余手牌的总分。\`target_score:0\` 一局定胜负，否则重新发牌，累计先达到目标分者获胜。
- 超时：出手中第一张合法牌，变色选自己手中最多的颜色；无合法牌则摸一张后过。
  摸牌后的窗口超时会打出刚摸到的合法牌；选色超时自动选色；质疑窗口超时视为不质疑。托管自动喊最后一张。

**真人指令**：「出 红5」「出 蓝跳过」「出 绿+2」「出 反转」「出 变色 蓝」「出 变色+4 红」
「出 红5 最后一张」「摸」「过」「质疑」「不质疑」。起始牌选色用「选色 蓝」。
支持全角数字及 禁、转向、加2、万能、加4 等写法。

**bot 指令**：
\`act({"action":"play","card":"红5","call":true})\`
\`act({"action":"play","card":"变色","color":"蓝","call":true})\`
\`act({"action":"draw"})\` / \`act({"action":"pass"})\`
\`act({"action":"challenge"})\` / \`act({"action":"accept"})\`
起始牌选色：\`act({"action":"color","color":"蓝"})\``;

function compact(raw: string): string {
  // 先统一全角字符，再清洗，防止全角占位符在归一化后恢复效力。
  return stripTrailing(sanitizeUserText(normalizeText(raw))).replace(/\s+/g, '');
}

function parseColor(raw: unknown): ChainColor | null {
  if (typeof raw !== 'string') return null;
  const t = compact(raw);
  return COLORS.find((c) => t === c || t === `${c}色`) ?? null;
}

function cardColor(card: ColorChainCard): ChainColor | null {
  return card.startsWith('变色') ? null : (card[0] as ChainColor);
}

function cardSymbol(card: ColorChainCard): string {
  return cardColor(card) === null ? card : card.slice(1);
}

function parseCard(raw: unknown, currentColor: ChainColor | null): ColorChainCard | null {
  if (typeof raw !== 'string') return null;
  const t = compact(raw);
  if (/^(变色|万能)$/u.test(t)) return '变色';
  if (/^((变色|万能)(\+4|加4)|\+4|加4)$/u.test(t)) return '变色+4';
  const explicit = COLORS.find((c) => t.startsWith(c));
  const color = explicit ?? currentColor;
  if (!color) return null;
  const body = explicit ? t.slice(1).replace(/^色/u, '') : t;
  let symbol: ChainSymbol;
  if (/^(跳过|禁)$/u.test(body)) symbol = '跳过';
  else if (/^(反转|转向)$/u.test(body)) symbol = '反转';
  else if (/^(\+2|加2)$/u.test(body)) symbol = '+2';
  else {
    const n = parseIntLoose(body);
    if (n === null || n < 0 || n > 9) return null;
    symbol = String(n) as ChainSymbol;
  }
  return `${color}${symbol}`;
}

function newDeck(): ColorChainCard[] {
  const cards: ColorChainCard[] = [];
  for (const color of COLORS) {
    for (const symbol of SYMBOLS) {
      cards.push(`${color}${symbol}`);
      if (symbol !== '0') cards.push(`${color}${symbol}`);
    }
  }
  for (let i = 0; i < 4; i++) cards.push('变色', '变色+4');
  return cards;
}

function cardRank(card: ColorChainCard): number {
  const color = cardColor(card);
  if (color === null) return card === '变色' ? 100 : 101;
  return COLORS.indexOf(color) * 25 + SYMBOLS.indexOf(cardSymbol(card) as ChainSymbol);
}

function sorted(cards: readonly ColorChainCard[]): ColorChainCard[] {
  return [...cards].sort((a, b) => cardRank(a) - cardRank(b));
}

function points(card: ColorChainCard): number {
  if (cardColor(card) === null) return 50;
  const symbol = cardSymbol(card);
  // 注意「+2」也能被 Number 解析成 2，必须只认单个数字。
  return /^\d$/u.test(symbol) ? Number(symbol) : 20;
}

export class ColorChainGame extends BaseGame<ColorChainState, ColorChainOptions> {
  private hand(seat: Seat): ColorChainCard[] {
    return this.state.hands[String(seat)] ?? [];
  }

  private nextSeat(from: Seat, steps = 1, direction: 1 | -1 = this.state.direction): Seat {
    const seats = this.allSeats().sort((a, b) => a - b);
    const index = seats.indexOf(from);
    return seats[((index + steps * direction) % seats.length + seats.length) % seats.length]!;
  }

  private matches(card: ColorChainCard): boolean {
    if (cardColor(card) === null) return true;
    const top = this.state.discard.at(-1);
    return cardColor(card) === this.state.currentColor || (top !== undefined && cardSymbol(card) === cardSymbol(top));
  }

  /** 合法推荐及托管不能主动违规；提交的 +4 则保留证据交给质疑窗口裁定。 */
  private legalCard(seat: Seat, card: ColorChainCard): boolean {
    return this.matches(card) &&
      (card !== '变色+4' || !this.hand(seat).some((c) => cardColor(c) === this.state.currentColor));
  }

  private availableCards(seat: Seat): ColorChainCard[] {
    if (!this.pendingOf(seat) || (this.phase?.key !== 'turn' && this.phase?.key !== 'drawn')) return [];
    return this.hand(seat).filter(
      (c) => this.legalCard(seat, c) && (this.phase!.key !== 'drawn' || c === this.state.drawn),
    );
  }

  private majorityColor(seat: Seat): ChainColor {
    let best: ChainColor = '红';
    let count = -1;
    for (const color of COLORS) {
      const n = this.hand(seat).filter((c) => cardColor(c) === color).length;
      if (n > count) {
        count = n;
        best = color;
      }
    }
    return best;
  }

  private tellHand(seat: Seat, withPlayable = false): void {
    const hand = sorted(this.hand(seat));
    const playable = sorted([...new Set(this.availableCards(seat))]);
    this.tell(
      seat,
      `🎴 你的手牌（${hand.length}张）：${hand.join('、') || '（无）'}` +
        (withPlayable
          ? `\n可出的牌：${playable.join('、') || '（无；请按当前待办行动）'}。\n变色牌须指定颜色；出后剩一张请同时喊「最后一张」。`
          : ''),
      { kind: 'hand' },
    );
  }

  /** 统一处理主动摸牌及处罚；公开消息绝不带摸到的牌名。 */
  private drawCards(seat: Seat, count: number, reason: string): ColorChainCard[] {
    const st = this.state;
    const drawn: ColorChainCard[] = [];
    for (let i = 0; i < count; i++) {
      if (st.deck.length === 0 && st.discard.length > 1) {
        const top = st.discard.pop()!;
        st.deck = shuffle(this.rng, st.discard);
        st.discard = [top];
        this.announce(`🔄 牌堆用完，保留顶牌，其余 ${st.deck.length} 张弃牌已重新洗匀。`);
      }
      const card = st.deck.pop();
      if (card === undefined) break;
      this.hand(seat).push(card);
      drawn.push(card);
    }
    this.announce(
      `🎴 ${this.label(seat)} ${reason}，摸了 ${drawn.length} 张。` +
        (drawn.length < count ? `（应摸 ${count} 张，可摸的牌已用完。）` : ''),
      { kind: 'draw', data: { seat, count: drawn.length } },
    );
    if (drawn.length > 0) this.tellHand(seat);
    return drawn;
  }

  // ───────────────────────── 开局与待办 ─────────────────────────

  start(): void {
    for (const p of this.players) {
      p.name = sanitizeName(p.name);
      p.alive = true;
    }
    const seats = this.allSeats();
    this.rec.round = 1;
    Object.assign(this.state, {
      hands: {},
      deck: [],
      discard: [],
      currentColor: null,
      direction: 1,
      current: seats[0]!,
      dealer: seats[this.rng.int(seats.length)]!,
      drawn: null,
      challenge: null,
      scores: Object.fromEntries(seats.map((s) => [String(s), 0])),
      results: [],
    } satisfies ColorChainState);
    this.announce(
      `🌈 彩牌接龙开始！每人 ${this.options.hand_size} 张，同色、同数或同符号接牌。\n` +
        (this.options.target_score === 0 ? '一局定胜负。' : `累计先达到 ${this.options.target_score} 分者获胜。`) +
        '出后剩一张时，请同时喊「最后一张」！',
    );
    this.startRound();
  }

  private startRound(): void {
    const st = this.state;
    st.direction = 1;
    st.current = this.nextSeat(st.dealer);
    st.currentColor = null;
    st.challenge = null;
    st.drawn = null;
    st.discard = [];
    st.deck = shuffle(this.rng, newDeck());
    st.hands = Object.fromEntries(this.allSeats().map((s) => [String(s), []]));
    const order = this.orderFrom(st.current, this.allSeats());
    for (let i = 0; i < this.options.hand_size; i++) {
      for (const seat of order) this.hand(seat).push(st.deck.pop()!);
    }
    let top = st.deck.pop()!;
    while (top === '变色+4') {
      st.deck.push(top);
      st.deck = shuffle(this.rng, st.deck);
      top = st.deck.pop()!;
    }
    st.discard = [top];
    st.currentColor = cardColor(top);
    this.announce(
      `🔔 第 ${this.rec.round} 局，庄家为 ${this.label(st.dealer)}。已发牌，起始牌是「${top}」。`,
    );
    for (const seat of this.allSeats()) this.tellHand(seat);
    const symbol = cardSymbol(top);
    if (symbol === '反转') {
      st.direction = -1;
      st.current = this.nextSeat(st.dealer);
      this.announce('↩️ 起始牌反转：方向改为逆时针，从庄家右手边开始。');
    } else if (symbol === '跳过' || symbol === '+2') {
      const skipped = st.current;
      if (symbol === '+2') this.drawCards(skipped, 2, '受到起始牌 +2 处罚');
      st.current = this.nextSeat(skipped);
      this.announce(`⏭️ ${this.label(skipped)} 被起始牌跳过。`);
    }
    this.openTurn(top === '变色' ? 'color' : 'turn');
  }

  private openTurn(kind: TurnKind = 'turn'): void {
    const seat = this.state.current;
    const playSpec: ActionSpec = {
      action: 'play',
      label: '出牌',
      params: {
        card: '牌名，如红5、蓝跳过、变色、变色+4',
        color: '变色牌必须指定：红、黄、蓝、绿',
        call: '出后剩一张时设为 true，表示同时喊最后一张',
      },
      example: 'act({"action":"play","card":"变色","color":"蓝","call":true})',
      command: '出 红5 最后一张 / 出 变色 蓝',
    };
    let actions: ActionSpec[];
    let prompt: string;
    if (kind === 'challenge') {
      actions = [
        { action: 'challenge', label: '质疑 +4', example: 'act({"action":"challenge"})', command: '质疑' },
        { action: 'accept', label: '接受 +4', example: 'act({"action":"accept"})', command: '不质疑' },
      ];
      prompt = '你受到变色+4：请选择「质疑」或「不质疑」，不能叠加出牌。';
    } else if (kind === 'color') {
      actions = [{
        action: 'color',
        label: '指定起始颜色',
        params: { color: '红、黄、蓝、绿之一' },
        example: 'act({"action":"color","color":"蓝"})',
        command: '选色 蓝',
      }];
      prompt = '起始牌是变色，请先指定颜色（选色 红/黄/蓝/绿），之后仍由你正常出牌。';
    } else {
      actions = [
        playSpec,
        kind === 'drawn'
          ? { action: 'pass', label: '保留摸到的牌', example: 'act({"action":"pass"})', command: '过' }
          : { action: 'draw', label: '摸一张', example: 'act({"action":"draw"})', command: '摸' },
      ];
      prompt = kind === 'drawn'
        ? '只能出刚摸到的那张牌，或发送「过」保留它。'
        : `顶牌「${this.state.discard.at(-1)}」，当前颜色${this.state.currentColor}；请出牌或发送「摸」。`;
    }
    this.openPhase({
      key: kind,
      title: `第${this.rec.round}局·${seat}号${kind === 'challenge' ? '质疑窗口' : '行动'}`,
      timeoutMs: this.options.turn_timeout_s * 1000,
      requests: [{ seat, prompt, channel: 'group', actions }],
    });
    this.announce(`👉 ${this.at(seat)} ${prompt}（限时 ${this.options.turn_timeout_s} 秒）`);
    this.tellHand(seat, true);
  }

  // ───────────────────────── 动作与结算 ─────────────────────────

  onAction(seat: Seat, input: ColorChainAction, _meta: ActionMeta): string {
    if (typeof input.action !== 'string') throw invalidAction('需要提供 action。');
    const action = sanitizeUserText(input.action);
    this.requireTurn(seat, action);
    let intent: ColorChainAction = { action };
    if (action === 'color') {
      const color = parseColor(input.color);
      if (!color) throw invalidAction('请用 color 指定红、黄、蓝、绿之一。');
      intent = { action, color };
    } else if (action === 'play') {
      const card = parseCard(input.card, this.state.currentColor);
      if (!card || !this.hand(seat).includes(card)) throw invalidAction('请提供自己手中存在的牌 card。');
      if (this.phase!.key === 'drawn' && card !== this.state.drawn)
        throw invalidAction('摸牌后只能立即出刚摸到的那张牌，或选择过。');
      if (!this.matches(card)) throw invalidAction('这张牌与当前颜色、数字或符号都不匹配。');
      if (input.call !== undefined && typeof input.call !== 'boolean')
        throw invalidAction('call 必须是布尔值。');
      const color = cardColor(card) === null ? parseColor(input.color) : cardColor(card);
      if (!color) throw invalidAction('变色牌必须用 color 指定红、黄、蓝、绿之一。');
      intent = { action, card, color, call: input.call === true };
    }
    this.phase!.data.input = intent;
    this.phase!.data.auto = false;
    this.markDone(seat);
    return '已提交本次行动。';
  }

  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    this.phase!.data.input = this.chooseAction(seat, false);
    this.phase!.data.auto = true;
  }

  advance(): void {
    if (!this.phase || !this.isPhaseComplete()) return;
    const input = this.phase.data.input as ColorChainAction | undefined;
    if (!input) throw invalidState('当前阶段缺少已提交的动作。');
    const auto = Boolean(this.phase.data.auto);
    const seat = this.state.current;
    if (auto) this.announce(`⏰ ${this.label(seat)} 超时，程序代为操作。`);
    switch (input.action) {
      case 'color':
        this.state.currentColor = input.color as ChainColor;
        this.announce(`🎨 ${this.label(seat)} 指定当前颜色为${this.state.currentColor}，仍由本人出牌。`);
        this.openTurn();
        return;
      case 'play':
        this.playCard(seat, input);
        return;
      case 'draw': {
        const drawn = this.drawCards(seat, 1, '主动摸牌');
        this.state.drawn = drawn[0] ?? null;
        if (!auto && this.state.drawn && this.legalCard(seat, this.state.drawn)) {
          this.openTurn('drawn');
          return;
        }
        this.endTurn(seat);
        return;
      }
      case 'pass':
        this.announce(`⏭️ ${this.label(seat)} 保留摸到的牌，结束回合。`);
        this.endTurn(seat);
        return;
      case 'challenge':
      case 'accept':
        this.resolveFour(input.action === 'challenge');
        return;
      default:
        throw invalidState('无法结算当前动作。');
    }
  }

  private endTurn(seat: Seat): void {
    this.state.drawn = null;
    this.state.current = this.nextSeat(seat);
    this.openTurn();
  }

  private playCard(seat: Seat, input: ColorChainAction): void {
    const st = this.state;
    const card = input.card as ColorChainCard;
    const hand = this.hand(seat);
    const before = [...hand];
    const previousColor = st.currentColor!;
    hand.splice(hand.indexOf(card), 1);
    st.discard.push(card);
    st.currentColor = input.color as ChainColor;
    st.drawn = null;
    const target = this.nextSeat(seat);
    const symbol = cardSymbol(card);
    let next = target;
    if (symbol === '反转') {
      st.direction = st.direction === 1 ? -1 : 1;
      next = this.players.length === 2 ? seat : this.nextSeat(seat);
    } else if (symbol === '跳过' || symbol === '+2') {
      next = this.nextSeat(seat, 2);
    } else if (card === '变色+4') {
      st.challenge = { offender: seat, target, previousColor, hand: before };
    }
    st.current = next;
    this.announce(
      `🃏 ${this.label(seat)} 出了「${card}」，当前颜色：${st.currentColor}。` +
        `下一位：${hand.length === 0 && !st.challenge ? '无（本局结算）' : this.at(next)}` +
        (st.challenge ? '（先决定是否质疑）' : '') + '。',
      { kind: 'play', data: { seat, card, color: st.currentColor } },
    );
    this.tellHand(seat);
    if (hand.length === 1) {
      if (input.call) {
        this.announce(`📣 ${this.label(seat)} 喊出「最后一张」！`);
      } else if (this.options.call_penalty) {
        this.announce(`⚠️ ${this.label(seat)} 忘喊「最后一张」，自动罚摸 2 张。`);
        this.drawCards(seat, 2, '忘喊最后一张');
      }
    }
    if (symbol === '+2') this.drawCards(target, 2, '受到 +2 处罚并跳过');
    if (st.challenge) {
      this.openTurn('challenge');
      return;
    }
    if (hand.length === 0) this.finishRound(seat);
    else this.openTurn();
  }

  private resolveFour(challenge: boolean): void {
    const st = this.state;
    const evidence = st.challenge;
    if (!evidence) throw invalidState('当前没有可结算的 +4。');
    let upheld = false;
    if (challenge) {
      this.tell(
        evidence.target,
        `🔍 仅你可见：${this.label(evidence.offender)} 出变色+4前的手牌：${sorted(evidence.hand).join('、')}。` +
          `当时颜色：${evidence.previousColor}。`,
        { kind: 'challenge_hand' },
      );
      upheld = evidence.hand.some((c) => cardColor(c) === evidence.previousColor);
      this.announce(`🔍 质疑${upheld ? '成立' : '不成立'}。`, {
        kind: 'challenge',
        data: { challenger: evidence.target, offender: evidence.offender, upheld },
      });
      if (upheld) this.drawCards(evidence.offender, 4, '质疑成立，受到处罚');
      else this.drawCards(evidence.target, 6, '质疑不成立，受到处罚并跳过');
    } else {
      this.announce(`✅ ${this.label(evidence.target)} 选择不质疑。`);
      this.drawCards(evidence.target, 4, '接受 +4 处罚并跳过');
    }
    st.challenge = null;
    st.current = upheld ? evidence.target : this.nextSeat(evidence.target);
    if (this.hand(evidence.offender).length === 0) this.finishRound(evidence.offender);
    else this.openTurn();
  }

  private finishRound(winner: Seat): void {
    const st = this.state;
    const score = this.allSeats()
      .filter((s) => s !== winner)
      .reduce((sum, s) => sum + this.hand(s).reduce((n, c) => n + points(c), 0), 0);
    st.scores[String(winner)]! += score;
    st.results.push({ round: this.rec.round, winner, points: score });
    this.announce(
      `🏆 第 ${this.rec.round} 局结算：${this.label(winner)} 清空手牌，获得 ${score} 分！` +
        (this.options.target_score > 0
          ? `\n累计：${this.allSeats().map((s) => `${s}号 ${st.scores[String(s)]}分`).join('、')}。目标 ${this.options.target_score} 分。`
          : ''),
      { kind: 'round_result', data: { winner, points: score } },
    );
    if (this.options.target_score === 0 || st.scores[String(winner)]! >= this.options.target_score) {
      this.finish({
        winnerTeam: sanitizeName(this.player(winner).name),
        winnerSeats: [winner],
        reason: this.options.target_score === 0
          ? `${this.label(winner)} 率先清空手牌`
          : `${this.label(winner)} 累计 ${st.scores[String(winner)]} 分，达到目标`,
        reveal: this.players.map((p) => ({
          seat: p.seat,
          name: sanitizeName(p.name),
          identity:
            `${p.seat === winner ? '🏆 获胜' : '参与者'}` +
            (this.options.target_score > 0 ? `，累计 ${st.scores[String(p.seat)]} 分` : `，剩 ${this.hand(p.seat).length} 张`),
        })),
      });
      return;
    }
    st.dealer = this.nextSeat(st.dealer, 1, 1);
    this.rec.round += 1;
    this.startRound();
  }

  // ───────────────────────── 视角与托管 ─────────────────────────

  privateView(seat: Seat): Record<string, unknown> {
    const playable = sorted([...new Set(this.availableCards(seat))]);
    return {
      hand: sorted(this.hand(seat)),
      playable,
      needs_color: Boolean(this.pendingOf(seat)) &&
        (this.phase?.key === 'color' || playable.some((c) => cardColor(c) === null)),
      colors: [...COLORS],
      drawn_card: this.pendingOf(seat) && this.phase?.key === 'drawn' ? this.state.drawn : null,
    };
  }

  publicView(): Record<string, unknown> {
    const st = this.state;
    return {
      round: this.rec.round,
      dealer: st.dealer,
      top_card: st.discard.at(-1) ?? null,
      current_color: st.currentColor,
      direction: st.direction === 1 ? '顺时针' : '逆时针',
      players: this.players.map((p) => ({
        seat: p.seat,
        name: sanitizeName(p.name),
        hand_count: this.hand(p.seat).length,
      })),
      current_turn: this.rec.status === 'running' ? st.current : null,
      phase: this.phase?.key ?? null,
      draw_pile_count: st.deck.length,
      target_score: this.options.target_score,
      ...(this.options.target_score > 0 ? { scores: { ...st.scores } } : {}),
      challenge: st.challenge ? { offender: st.challenge.offender, target: st.challenge.target } : null,
      last_rounds: st.results.slice(-5).map((r) => ({ ...r })),
    };
  }

  override parseCommand(seat: Seat, text: string, _channel: 'group' | 'private'): ColorChainAction | null {
    if (!this.pendingOf(seat)) return null;
    const t = compact(text);
    if (/^(摸|摸牌)$/u.test(t)) return { action: 'draw' };
    if (t === '过') return { action: 'pass' };
    if (t === '质疑') return { action: 'challenge' };
    if (t === '不质疑') return { action: 'accept' };
    if (this.phase?.key === 'color') {
      const color = parseColor(t.replace(/^(选色|颜色|选)/u, ''));
      return color ? { action: 'color', color } : null;
    }
    const match = t.match(/^(?:出牌|出)(.+)$/u);
    if (!match) return null;
    let body = match[1]!;
    const call = body.endsWith('最后一张');
    if (call) body = body.slice(0, -4);
    let color: ChainColor | null = null;
    if (/^(变色|万能|\+4|加4)/u.test(body)) {
      const suffix = body.match(/([红黄蓝绿])色?$/u);
      if (suffix) {
        color = suffix[1] as ChainColor;
        body = body.slice(0, -suffix[0].length);
      }
    }
    const card = parseCard(body, this.state.currentColor);
    return card ? { action: 'play', card, ...(color ? { color } : {}), ...(call ? { call: true } : {}) } : null;
  }

  /** 这里只读本人手牌、公开牌面和本人待办，不查看牌堆或质疑证据。 */
  private chooseAction(seat: Seat, random: boolean): ColorChainAction | null {
    if (!this.pendingOf(seat)) return null;
    if (this.phase?.key === 'color') return { action: 'color', color: this.majorityColor(seat) };
    if (this.phase?.key === 'challenge')
      return { action: random && this.rng.int(2) === 0 ? 'challenge' : 'accept' };
    const playable = this.availableCards(seat);
    if (playable.length > 0) {
      const card = playable[random ? this.rng.int(playable.length) : 0]!;
      return {
        action: 'play',
        card,
        ...(cardColor(card) === null ? { color: this.majorityColor(seat) } : {}),
        call: true,
      };
    }
    return { action: this.phase?.key === 'drawn' ? 'pass' : 'draw' };
  }

  override randomAction(seat: Seat): ColorChainAction | null {
    return this.chooseAction(seat, true);
  }
}

export const colorChainDefinition: GameDefinition<ColorChainOptions> = {
  type: 'color_chain',
  name: '彩牌接龙',
  aliases: ['彩牌接龙', '彩牌', 'color-chain', 'colorchain'],
  idPrefix: 'CC',
  minPlayers: 2,
  maxPlayers: 10,
  summary: '同色同数接牌，巧用跳过、反转和变色，喊出最后一张并率先清空手牌。',
  rules: RULES,
  playerTips:
    '- privateView 的 playable 是当前合法推荐；摸牌后只能出刚摸到的牌。\n' +
    '- 变色优先选自己手里较多的颜色；变色+4 的资格只看当前颜色，不看相同数字或符号。\n' +
    '- 出后剩一张时带 call:true；质疑只能在自己的质疑待办中提交。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    hand_size: '每局初始手牌数（5~10，默认 7）',
    call_penalty: '忘喊最后一张是否自动罚摸两张（默认 true）',
    target_score: '0=一局定胜负（默认）；100~500=累计达到目标分获胜',
    turn_timeout_s: '每次行动、摸后选择或质疑窗口的限时（秒，默认 45）',
  },
  create: (rec, env) => new ColorChainGame(rec, env),
};
