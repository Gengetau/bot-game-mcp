/**
 * 纯函数牌型评估：五至七张牌枚举五张组合，按牌型和踢脚逐项比较。
 * 皇家同花顺是 A 高同花顺，不单独设一个牌型等级。
 */
const SUITS = ['♠', '♥', '♦', '♣'] as const;
const FACES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'] as const;

export const DECK: readonly string[] = Object.freeze(SUITS.flatMap((s) => FACES.map((f) => `${s}${f}`)));

export interface HandValue {
  /** 0 高牌至 8 同花顺。 */
  category: number;
  name: string;
  /** 同牌型时按顺序比较的点数；A 为 14，轮子顺子的最高点为 5。 */
  ranks: number[];
  cards: string[];
}

interface ParsedCard {
  card: string;
  suit: string;
  rank: number;
}

/** 正数表示 a 胜，负数表示 b 胜，0 表示平局；花色不参与比较。 */
export function compare(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.ranks.length, b.ranks.length); i++) {
    const delta = (a.ranks[i] ?? 0) - (b.ranks[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function five(cards: readonly ParsedCard[]): HandValue {
  const sorted = cards.map((c) => c.rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const rank of sorted) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const grouped = groups.map(([rank]) => rank);
  const flush = cards.every((c) => c.suit === cards[0]!.suit);
  const straight = counts.size !== 5 ? 0
    : sorted[0]! - sorted[4]! === 4 ? sorted[0]!
    : sorted.join(',') === '14,5,4,3,2' ? 5 : 0;
  let category = 0;
  let ranks = sorted;
  if (flush && straight) {
    category = 8;
    ranks = [straight];
  } else if (groups[0]![1] === 4) {
    category = 7;
    ranks = grouped;
  } else if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    category = 6;
    ranks = grouped;
  } else if (flush) {
    category = 5;
  } else if (straight) {
    category = 4;
    ranks = [straight];
  } else if (groups[0]![1] === 3) {
    category = 3;
    ranks = grouped;
  } else if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    category = 2;
    ranks = grouped;
  } else if (groups[0]![1] === 2) {
    category = 1;
    ranks = grouped;
  }
  return { category, name: NAMES[category]!, ranks, cards: cards.map((c) => c.card) };
}

export function evaluate(cards: readonly string[]): HandValue {
  if (cards.length < 5 || cards.length > 7) throw new RangeError('比牌需要五至七张牌。');
  if (new Set(cards).size !== cards.length) throw new RangeError('不能出现重复的牌。');
  const parsed: ParsedCard[] = cards.map((card) => {
    if (!DECK.includes(card)) throw new RangeError('存在无效的扑克牌。');
    return { card, suit: card.slice(0, 1), rank: FACES.findIndex((f) => f === card.slice(1)) + 2 };
  });
  let best: HandValue | null = null;
  for (let a = 0; a < parsed.length - 4; a++)
    for (let b = a + 1; b < parsed.length - 3; b++)
      for (let c = b + 1; c < parsed.length - 2; c++)
        for (let d = c + 1; d < parsed.length - 1; d++)
          for (let e = d + 1; e < parsed.length; e++) {
            const value = five([parsed[a]!, parsed[b]!, parsed[c]!, parsed[d]!, parsed[e]!]);
            if (!best || compare(value, best) > 0) best = value;
          }
  return best!;
}
