/**
 * 诈牌酒馆 —— 背面出牌，质疑验牌，最后的幸存者获胜。
 *
 * 手牌、背面牌、左轮实弹位置只保存在可序列化状态中。
 * 发牌、验牌、开枪与胜负全部由程序处理，裁判只负责转发消息。
 */
import { z } from 'zod';
import { invalidAction, invalidState } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { shuffle } from '../../core/rng.js';
import { normalizeText, sanitizeName, sanitizeUserText, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, ActionSpec, PendingRequest, Seat } from '../../core/types.js';

const optionsSchema = z.object({
  ...commonOptionShape,
  start_cards: z.number().int().min(3).max(5).default(5),
  turn_timeout_s: secondsOption(45),
  chambers: z.number().int().min(2).max(6).default(6),
});

export type BluffTavernOptions = z.infer<typeof optionsSchema>;

const TABLE_CARDS = ['王', '后', '尖'] as const;
type TableCard = (typeof TABLE_CARDS)[number];
export type BluffTavernCard = TableCard | '百搭';
const CARD_ORDER: readonly BluffTavernCard[] = [...TABLE_CARDS, '百搭'];
type TurnKind = 'play' | 'respond';

export interface BluffTavernState {
  /** 各座位手牌；出局者为空数组。 */
  hands: Record<string, BluffTavernCard[]>;
  /** 未发出的牌与更早的背面牌，均不可公开。 */
  stock: BluffTavernCard[];
  discard: BluffTavernCard[];
  /** 上一手单独保管，不与 discard 重复计牌。 */
  lastPlay: { seat: Seat; cards: BluffTavernCard[] } | null;
  tableCard: TableCard;
  current: Seat;
  starter: Seat;
  revolvers: Record<string, {
    /** 从零开始的实弹位置，永不进入视图或消息，也不在小轮之间重置。 */
    bulletPosition: number;
    shots: number;
  }>;
  eliminated: Seat[];
}

const RULES = `## 诈牌酒馆

- 2～6 人，推荐 4 人。共 20 张牌：王、后、尖各 6 张，百搭 2 张。
- 每人一把左轮，默认 6 个弹仓，程序在开局时随机装入 1 发实弹。之后不重装、不重新随机转动。
  每次扣扳机检查下一个弹仓；中弹即出局。已扣扳机次数公开，实弹位置始终保密。
- 每小轮收回全部牌重洗，每位存活者发 \`start_cards\` 张（默认 5）。
  实际发牌数不超过 ⌊20 / 存活人数⌋；程序随机公布本轮桌牌：王、后或尖。
- 第一小轮随机起手；之后由上一小轮开枪者起手，若其出局则由其存活下家起手。
  无人开枪时沿用本轮起手。
- 轮到出牌时，背面出 1～3 张，声称都是桌牌。下一位有手牌的存活玩家选择：
  - **质疑**：翻开上一手。只要有一张既不是桌牌也不是百搭，出牌者开枪；否则质疑者开枪。
  - **放过**：不翻牌，由自己接着出牌。
- 空手者本小轮直接跳过，不参与出牌或判断。
  若除上一手出牌者外，其余存活者均已空手，程序立即自动检验上一手：
  撒谎则出牌者开枪，否则无人开枪。
- 每次检验后结束本小轮，重新发牌、重选桌牌。只剩一名存活者时，其获胜。
- 超时托管：出牌时优先出 1 张桌牌或百搭，否则出 1 张任意牌；
  判断时默认放过，若判断者已无牌可出则改为质疑。

**真人指令**（群里）：\`出 王\`、\`出 王 后 百搭\`、\`出王后\`、\`出 王王百搭\`。
只按牌名出牌，不接受「出 3 张 尖」。
质疑可发「质疑」「开」「骗子」；放过可发「放过」「信」「过」。
**bot 指令**：\`act({"action":"play","card":"王 后 百搭"})\`、
\`act({"action":"challenge"})\`、\`act({"action":"trust"})\`。
card 使用空格或逗号分隔牌名，必须实际持有这些牌。`;

function newDeck(): BluffTavernCard[] {
  const cards: BluffTavernCard[] = [];
  for (const card of TABLE_CARDS) {
    for (let i = 0; i < 6; i++) cards.push(card);
  }
  return [...cards, '百搭', '百搭'];
}

function sortedCards(cards: readonly BluffTavernCard[]): BluffTavernCard[] {
  return [...cards].sort((a, b) => CARD_ORDER.indexOf(a) - CARD_ORDER.indexOf(b));
}

/** 真人允许连写；结构化动作要求用空格或逗号分隔，不接受数量表达式。 */
function readCards(raw: string, compact = false): BluffTavernCard[] | null {
  const text = sanitizeUserText(normalizeText(raw));
  let parts: string[];
  if (compact) {
    if (!/^(?:百搭|王|后|尖)(?:[\s,]*(?:百搭|王|后|尖))*$/u.test(text)) return null;
    parts = text.match(/百搭|王|后|尖/gu)!;
  } else {
    parts = text.split(/[\s,]+/u);
  }
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !CARD_ORDER.some((c) => c === p))) return null;
  return parts as BluffTavernCard[];
}

export class BluffTavernGame extends BaseGame<BluffTavernState, BluffTavernOptions> {
  // ───────────────────────── 开局与小轮 ─────────────────────────

  start(): void {
    for (const p of this.players) p.name = sanitizeName(p.name);
    this.rec.round = 1;
    const alive = this.aliveSeats();
    const starter = alive[this.rng.int(alive.length)]!;
    const revolvers: BluffTavernState['revolvers'] = {};
    for (const seat of alive) {
      revolvers[String(seat)] = { bulletPosition: this.rng.int(this.options.chambers), shots: 0 };
    }
    Object.assign(this.rec.state, {
      hands: {},
      stock: newDeck(),
      discard: [],
      lastPlay: null,
      tableCard: '王',
      current: starter,
      starter,
      revolvers,
      eliminated: [],
    } satisfies BluffTavernState);
    this.announce(
      `🍻 诈牌酒馆开张！每人一把 ${this.options.chambers} 发左轮，程序随机装入 1 发实弹，之后不再重装。\n` +
        '背面出 1～3 张，声称都是桌牌；下家选择「质疑」或「放过」。最后的幸存者获胜！',
    );
    this.startRound(starter);
  }

  private startRound(starter: Seat): void {
    const st = this.state;
    // 收回所有区域的牌，而不是凭空补牌；任何时刻牌组都保持 20 张。
    const deck = shuffle(this.rng, [
      ...st.stock,
      ...st.discard,
      ...Object.values(st.hands).flat(),
      ...(st.lastPlay?.cards ?? []),
    ]);
    st.hands = {};
    for (const seat of this.allSeats()) st.hands[String(seat)] = [];
    st.discard = [];
    st.lastPlay = null;
    st.starter = starter;
    st.current = starter;
    st.tableCard = TABLE_CARDS[this.rng.int(TABLE_CARDS.length)]!;
    const alive = this.aliveSeats();
    const count = Math.min(this.options.start_cards, Math.floor(20 / alive.length));
    for (const seat of alive) st.hands[String(seat)] = sortedCards(deck.splice(0, count));
    st.stock = deck;
    this.announce(
      `🔔 第 ${this.rec.round} 小轮：桌牌是「${st.tableCard}」，百搭也算真牌。\n` +
        `已重新洗牌，每位存活者 ${count} 张。由 ${this.at(starter)} 起手。`,
      { kind: 'round' },
    );
    for (const seat of alive) this.tellHand(seat);
    this.openTurn(starter, 'play');
  }

  private tellHand(seat: Seat, instructions?: string): void {
    const hand = sortedCards(this.state.hands[String(seat)] ?? []);
    this.tell(
      seat,
      `🃏 第 ${this.rec.round} 小轮，桌牌「${this.state.tableCard}」。\n` +
        `你的手牌：${hand.join(' ') || '（无牌）'}` +
        (instructions ? `\n${instructions}` : ''),
      { kind: 'hand', category: instructions ? 'prompt' : 'info' },
    );
  }

  /** 动作说明不使用真实手牌，避免通过待办示例泄密。 */
  private actionsFor(kind: TurnKind): ActionSpec[] {
    if (kind === 'play') {
      return [{
        action: 'play',
        label: '背面出牌',
        params: { card: '本人持有的 1~3 张牌名，用空格或逗号分隔：王、后、尖、百搭' },
        example: 'act({"action":"play","card":"王 后 百搭"})',
        command: '出 王 后 百搭',
      }];
    }
    return [
      { action: 'challenge', label: '质疑', example: 'act({"action":"challenge"})', command: '质疑' },
      { action: 'trust', label: '放过', example: 'act({"action":"trust"})', command: '放过' },
    ];
  }

  private openTurn(seat: Seat, kind: TurnKind): void {
    this.state.current = seat;
    const last = this.state.lastPlay;
    const prompt = kind === 'play'
      ? `桌牌「${this.state.tableCard}」，请背面出 1～3 张，声称都是桌牌。`
      : `${this.label(last!.seat)} 上一手出了 ${last!.cards.length} 张。请选择「质疑」，或「放过」后接着出牌。`;
    this.openPhase({
      key: kind,
      title: `第${this.rec.round}小轮·${seat}号${kind === 'play' ? '出牌' : '判断'}`,
      timeoutMs: this.options.turn_timeout_s * 1000,
      requests: [{ seat, prompt, channel: 'group', actions: this.actionsFor(kind) }],
    });
    this.announce(`👉 ${this.at(seat)} ${prompt}（限时 ${this.options.turn_timeout_s} 秒）`);
    if (this.player(seat).kind === 'human') {
      this.tellHand(
        seat,
        kind === 'play'
          ? '请在群里发送：出 + 1～3 张牌名，如「出 王」「出王后」「出 王 后 百搭」。'
          : '请在群里发送：「质疑」「开」「骗子」，或「放过」「信」「过」。',
      );
    }
  }

  /** 顺时针寻找有牌的其他存活者，空手者连判断窗口也跳过。 */
  private nextWithCards(from: Seat): Seat | null {
    return this.orderFrom(from).find((seat) => seat !== from && (this.state.hands[String(seat)]?.length ?? 0) > 0) ?? null;
  }

  // ───────────────────────── 动作与托管 ─────────────────────────

  onAction(seat: Seat, input: ActionInput, _meta: ActionMeta): string {
    const action = sanitizeUserText(input.action);
    this.requireTurn(seat, action);
    const data = this.phase!.data;
    if (action === 'play') {
      const cards = typeof input.card === 'string' ? readCards(input.card) : null;
      if (!cards) throw invalidAction('每次只能按牌名出 1~3 张，card 用空格或逗号分隔。');
      // 用副本检查重数，所有校验通过之前不改变手牌或待办。
      const remaining = [...(this.state.hands[String(seat)] ?? [])];
      for (const card of cards) {
        const index = remaining.indexOf(card);
        if (index < 0) throw invalidAction('你手里没有足够的这些牌。');
        remaining.splice(index, 1);
      }
      data.cards = cards;
    } else if (action === 'trust' && !this.state.hands[String(seat)]?.length) {
      throw invalidAction('没有手牌时不能放过后出牌，请质疑。');
    }
    data.action = action;
    data.auto = false;
    this.markDone(seat);
    return action === 'play'
      ? `已提交背面出牌，共 ${data.cards.length} 张。`
      : action === 'challenge' ? '你选择质疑！' : '你选择放过，接下来请出牌。';
  }

  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    const data = this.phase!.data;
    const hand = this.state.hands[String(seat)] ?? [];
    data.auto = true;
    if (this.phase!.key === 'play') {
      const card = hand.find((c) => c === this.state.tableCard || c === '百搭') ?? hand[0];
      if (!card) throw invalidState('出牌阶段的行动者没有手牌。');
      data.action = 'play';
      data.cards = [card];
    } else {
      data.action = hand.length > 0 ? 'trust' : 'challenge';
    }
  }

  advance(): void {
    if (this.rec.status !== 'running' || !this.phase || !this.isPhaseComplete()) return;
    const st = this.state;
    const seat = st.current;
    const data = this.phase.data;
    const auto = Boolean(data.auto);
    const autoText = auto ? '（超时，程序代为操作）' : '';
    if (data.action === 'play') {
      const cards = data.cards as BluffTavernCard[];
      const hand = st.hands[String(seat)]!;
      if (st.lastPlay) st.discard.push(...st.lastPlay.cards);
      for (const card of cards) hand.splice(hand.indexOf(card), 1);
      st.lastPlay = { seat, cards: [...cards] };
      this.announce(
        `🃏 ${this.label(seat)} 背面出了 ${cards.length} 张，声称均为「${st.tableCard}」${autoText}。`,
        { kind: 'play', data: { seat, count: cards.length, auto } },
      );
      this.tellHand(seat);
      const next = this.nextWithCards(seat);
      if (next === null) this.resolveLast(null);
      else this.openTurn(next, 'respond');
      return;
    }
    if (data.action === 'trust') {
      this.announce(`🤝 ${this.label(seat)} 选择放过${autoText}，现在由其出牌。`, {
        kind: 'trust', data: { seat, auto },
      });
      this.openTurn(seat, 'play');
      return;
    }
    if (data.action === 'challenge') {
      this.resolveLast(seat, auto);
      return;
    }
    throw invalidState('当前阶段缺少可结算的动作。');
  }

  // ───────────────────────── 验牌与开枪 ─────────────────────────

  private resolveLast(challenger: Seat | null, auto = false): void {
    const st = this.state;
    const last = st.lastPlay!;
    const liar = last.cards.some((card) => card !== st.tableCard && card !== '百搭');
    const shooter = liar ? last.seat : challenger;
    const opening = challenger === null
      ? '其余存活玩家均已空手，程序自动检验上一手。'
      : `${this.label(challenger)} 质疑${auto ? '（超时，程序代为操作）' : ''}！`;
    this.announce(
      `🔍 ${opening}\n${this.label(last.seat)} 翻牌：${last.cards.join(' ')}。\n` +
        `桌牌「${st.tableCard}」，百搭算真牌。` +
        (liar ? '存在不符的牌，出牌者撒谎！' : '全部符合，出牌者没有撒谎。'),
      {
        kind: 'reveal',
        data: { challenger, seat: last.seat, cards: [...last.cards], liar, shooter, auto },
      },
    );
    if (shooter !== null) this.fire(shooter);
    else this.announce('🕊️ 本轮无人开枪，下一小轮沿用本轮起手。');

    const alive = this.aliveSeats();
    if (alive.length === 1) {
      const winner = alive[0]!;
      this.finish({
        winnerTeam: sanitizeName(this.player(winner).name),
        winnerSeats: [winner],
        reason: `${this.label(winner)} 是最后的幸存者`,
        reveal: this.players.map((p) => ({
          seat: p.seat,
          name: sanitizeName(p.name),
          identity: p.alive
            ? `🏆 冠军（已扣扳机 ${st.revolvers[String(p.seat)]!.shots} 次）`
            : `第${this.players.length - st.eliminated.indexOf(p.seat)}名（中弹出局）`,
        })),
      });
      return;
    }
    const starter = shooter === null ? st.starter : this.isAlive(shooter) ? shooter : this.nextAlive(shooter)!;
    this.rec.round += 1;
    this.startRound(starter);
  }

  private fire(seat: Seat): void {
    const st = this.state;
    const revolver = st.revolvers[String(seat)]!;
    const shot = ++revolver.shots;
    // 第一枪检查位置 0；实弹出现即出局，因此存活者不会走完一圈。
    const hit = shot - 1 === revolver.bulletPosition;
    this.announce(
      `🔫 ${this.at(seat)} 扣下第 ${shot} 枪：${hit ? '中弹！' : '空枪，安全。'}`,
      { kind: 'shot', data: { seat, shot, hit } },
    );
    if (!hit) return;
    this.player(seat).alive = false;
    st.eliminated.push(seat);
    st.discard.push(...st.hands[String(seat)]!);
    st.hands[String(seat)] = [];
    this.tellHand(seat);
    this.announce(`💥 ${this.label(seat)} 中弹出局！`, { kind: 'death', data: { seat } });
  }

  // ───────────────────────── 视角与指令 ─────────────────────────

  privateView(seat: Seat): Record<string, unknown> {
    return {
      hand: sortedCards(this.state.hands[String(seat)] ?? []),
      table_card: this.state.tableCard,
      available_actions: this.pendingOf(seat)
        ? this.actionsFor(this.phase!.key === 'play' ? 'play' : 'respond')
        : [],
    };
  }

  publicView(): Record<string, unknown> {
    const st = this.state;
    const running = this.rec.status === 'running';
    return {
      round: this.rec.round,
      table_card: st.tableCard,
      starter: st.starter,
      current_turn: running ? st.current : null,
      turn_kind: running ? this.phase?.key ?? null : null,
      players: this.players.map((p) => ({
        seat: p.seat,
        name: sanitizeName(p.name),
        alive: p.alive,
        hand_count: p.alive ? st.hands[String(p.seat)]?.length ?? 0 : 0,
        shots: st.revolvers[String(p.seat)]?.shots ?? 0,
        chambers: this.options.chambers,
      })),
      last_play: st.lastPlay ? { seat: st.lastPlay.seat, count: st.lastPlay.cards.length } : null,
      eliminated: [...st.eliminated],
    };
  }

  override parseCommand(seat: Seat, text: string, channel: 'group' | 'private'): ActionInput | null {
    if (channel !== 'group' || !this.pendingOf(seat)) return null;
    const t = stripTrailing(sanitizeUserText(normalizeText(text)));
    if (this.phase?.key === 'respond') {
      if (/^(质疑|开|骗子)$/u.test(t)) return { action: 'challenge' };
      if (/^(放过|信|过)$/u.test(t)) return { action: 'trust' };
      return null;
    }
    if (this.phase?.key !== 'play' || !t.startsWith('出')) return null;
    const cards = readCards(t.slice(1), true);
    return cards ? { action: 'play', card: cards.join(' ') } : null;
  }

  override randomAction(seat: Seat): ActionInput | null {
    if (!this.pendingOf(seat)) return null;
    // 只看本人的手牌与公开阶段，不读取上一手牌面、他人手牌或任何实弹位置。
    const hand = this.state.hands[String(seat)] ?? [];
    if (this.phase?.key === 'respond') {
      return { action: hand.length === 0 || this.rng.int(2) === 0 ? 'challenge' : 'trust' };
    }
    if (this.phase?.key !== 'play' || hand.length === 0) return null;
    const count = 1 + this.rng.int(Math.min(3, hand.length));
    return { action: 'play', card: shuffle(this.rng, hand).slice(0, count).join(' ') };
  }
}

export const bluffTavernDefinition: GameDefinition<BluffTavernOptions> = {
  type: 'bluff_tavern',
  name: '诈牌酒馆',
  aliases: ['诈牌酒馆', '酒馆', 'bluff-tavern'],
  idPrefix: 'BT',
  minPlayers: 2,
  maxPlayers: 6,
  summary: '背面出牌，声称都是桌牌；质疑验真伪，输家扣扳机，最后的幸存者获胜。',
  rules: RULES,
  playerTips:
    '- 百搭检验时总是真牌；出多张更快清空手牌，也更容易被质疑。\n' +
    '- 空手者会被跳过；放过之后必须由自己出牌。\n' +
    '- 左轮不会重新装填，已扣扳机次数是公开信息，但没有人能查看实弹位置。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    start_cards: '每小轮每人发牌数（3~5，默认 5）；实际不超过 ⌊20 / 存活人数⌋',
    turn_timeout_s: '每次出牌或判断限时（秒，默认 45）',
    chambers: '左轮弹仓数（2~6，默认 6），每人开局随机装 1 发实弹，小轮之间不重置',
  },
  create: (rec, env) => new BluffTavernGame(rec, env),
};
