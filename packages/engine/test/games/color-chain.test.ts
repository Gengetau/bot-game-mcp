import { describe, expect, it } from 'vitest';
import { SeededRng, type Rng } from '../../src/core/rng.js';
import type { GameRecord, Player } from '../../src/core/types.js';
import {
  ColorChainGame,
  colorChainDefinition,
  type ColorChainAction,
  type ColorChainCard,
  type ColorChainOptions,
  type ColorChainState,
} from '../../src/games/color-chain/index.js';
import { createRegistry } from '../../src/games/index.js';
import { FakeClock, REF, bot, human, playToEnd, setup, startGame } from '../helpers.js';

type Card = ColorChainCard;

/** 独立构造标准牌组，既检查张数，也用于检查整局的牌守恒。 */
function fullDeck(): Card[] {
  const cards: Card[] = [];
  for (const color of ['红', '黄', '蓝', '绿'] as const) {
    cards.push(`${color}0`);
    for (let n = 1; n <= 9; n++) cards.push(`${color}${n}` as Card, `${color}${n}` as Card);
    for (const symbol of ['跳过', '反转', '+2'] as const) cards.push(`${color}${symbol}`, `${color}${symbol}`);
  }
  for (let i = 0; i < 4; i++) cards.push('变色', '变色+4');
  return cards;
}

/** 用合法的 Fisher–Yates 交换序列固定起始牌，不绕过开局发牌逻辑。 */
function openingRng(card: Card, n: number, handSize: number): Rng & { calls: number[] } {
  const work = fullDeck();
  const wanted = [...work];
  const position = 108 - n * handSize - 1;
  const found = wanted.indexOf(card);
  [wanted[position], wanted[found]] = [wanted[found]!, wanted[position]!];
  const script = [n - 1]; // 庄家固定为最后一座，正常从 1 号开始。
  for (let i = work.length - 1; i > 0; i--) {
    const j = work.lastIndexOf(wanted[i]!, i);
    script.push(j);
    [work[i], work[j]] = [work[j]!, work[i]!];
  }
  // +4 放回后，第二次洗牌把未发出的红0换到顶上。
  if (card === '变色+4') script.push(0);
  const calls: number[] = [];
  return {
    calls,
    int(maxExclusive) {
      calls.push(maxExclusive);
      const value = script.shift() ?? maxExclusive - 1;
      if (value < 0 || value >= maxExclusive) throw new Error('测试随机序列越界');
      return value;
    },
  };
}

function unit(opts: {
  n?: number;
  opening?: Card;
  options?: Partial<ColorChainOptions>;
  humans?: number;
  names?: string[];
} = {}) {
  const n = opts.n ?? 3;
  const clock = new FakeClock();
  const options = colorChainDefinition.optionsSchema.parse(opts.options ?? {});
  const rng = openingRng(opts.opening ?? '红5', n, options.hand_size);
  const rec: GameRecord<ColorChainState, ColorChainOptions> = {
    id: 'CC-TEST',
    type: 'color_chain',
    groupId: '9000',
    status: 'running',
    createdAt: clock.now(),
    updatedAt: clock.now(),
    startedAt: clock.now(),
    endedAt: null,
    hostId: '101',
    options,
    lobby: [],
    referee: null,
    standbyReferees: [],
    autoReferee: true,
    players: Array.from({ length: n }, (_, i): Player => ({
      seat: i + 1,
      id: String(101 + i),
      name: opts.names?.[i] ?? `玩家${i + 1}`,
      kind: i >= n - (opts.humans ?? 0) ? 'human' : 'agent',
      alive: true,
      selfPost: false,
    })),
    round: 0,
    phase: null,
    phaseCounter: 0,
    log: [],
    logSeq: 0,
    outbox: [],
    outboxSeq: 0,
    notBeforeFloor: 0,
    result: null,
    state: {} as ColorChainState,
  };
  const game = new ColorChainGame(rec, { now: clock.now, rng });
  game.start();
  const g = { game, rec, clock, rng };
  unlock(g);
  return g;
}

type Fixture = ReturnType<typeof unit>;

/** 单元测试直接模拟消息送达；真实门控另外通过 GameManager 集成测试覆盖。 */
function unlock(g: Pick<Fixture, 'rec' | 'clock'>): void {
  if (g.rec.phase) {
    g.rec.phase.openedAt = g.clock.now();
    g.rec.phase.deadline = g.clock.now() + g.rec.phase.timeoutMs;
  }
}

function step(g: Fixture, input: ColorChainAction, seat = g.rec.state.current): void {
  g.game.onAction(seat, input, { via: 'agent' });
  g.game.advance();
  unlock(g);
}

function play(g: Fixture, card: Card, color?: string): void {
  step(g, { action: 'play', card, ...(color ? { color } : {}), call: true });
}

function timeout(g: Fixture): void {
  g.clock.advance(g.rec.options.turn_timeout_s * 1000 + 1);
  g.game.onTimeout();
  g.game.advance();
  unlock(g);
}

/** 定向规则测试布置小牌面；完整随机对局另行严格检查 108 张牌守恒。 */
function rig(g: Fixture, table: Partial<Pick<ColorChainState,
  'hands' | 'deck' | 'discard' | 'currentColor' | 'direction' | 'current'
>> = {}): void {
  Object.assign(g.rec.state, {
    hands: Object.fromEntries(g.rec.players.map((p) => [
      String(p.seat), [...(table.hands?.[String(p.seat)] ?? ['蓝1', '绿2', '黄3'])],
    ])),
    deck: [...(table.deck ?? Array.from({ length: 30 }, (): Card => '黄9'))],
    discard: [...(table.discard ?? ['红5'])],
    currentColor: table.currentColor ?? '红',
    current: table.current ?? 1,
    direction: table.direction ?? 1,
    drawn: null,
    challenge: null,
  });
  // 只重新创建待办，出牌、处罚和结算仍全部走正式动作入口。
  (g.game as any).openTurn();
  unlock(g);
}

function physicalCards(g: Pick<Fixture, 'rec'>): Card[] {
  const st = g.rec.state;
  return [...st.deck, ...st.discard, ...Object.values(st.hands).flat()];
}

function resume(g: Fixture): Fixture {
  const rec = JSON.parse(JSON.stringify(g.rec)) as Fixture['rec'];
  return {
    ...g,
    rec,
    game: new ColorChainGame(rec, { now: g.clock.now, rng: new SeededRng('恢复') }),
  };
}

describe('彩牌接龙：注册、选项和开局', () => {
  it('注册机器名、中文别名和选项边界', () => {
    expect(createRegistry().resolve('彩牌接龙')).toBe(colorChainDefinition);
    expect(colorChainDefinition).toMatchObject({ type: 'color_chain', idPrefix: 'CC', minPlayers: 2, maxPlayers: 10 });
    expect(colorChainDefinition.optionsSchema.parse({})).toMatchObject({
      hand_size: 7, call_penalty: true, target_score: 0, turn_timeout_s: 45,
    });
    for (const options of [{ hand_size: 4 }, { hand_size: 11 }, { target_score: 99 }, { target_score: 501 }])
      expect(colorChainDefinition.optionsSchema.safeParse(options).success).toBe(false);
    for (const target_score of [0, 100, 500])
      expect(colorChainDefinition.optionsSchema.safeParse({ target_score }).success).toBe(true);
  });

  it.each([[2, 5], [3, 7], [10, 10]])('%i 人、每人 %i 张，牌组完整且无秘密公告', (n, hand_size) => {
    const g = unit({ n, options: { hand_size }, humans: 1 });
    expect(physicalCards(g).sort()).toEqual(fullDeck().sort());
    for (const hand of Object.values(g.rec.state.hands)) expect(hand).toHaveLength(hand_size);
    expect(g.rec.state.deck).toHaveLength(108 - n * hand_size - 1);
    expect(g.rec.state.discard).toEqual(['红5']);
    expect(g.rec.state.current).toBe(1);
    expect(Object.keys(g.rec.phase!.pending)).toEqual(['1']);
    expect(g.rec.log.filter((l) => l.audience.type === 'public').every((l) => !l.text.includes('你的手牌'))).toBe(true);
    for (const delivery of g.rec.outbox.filter((d) => d.text.includes('你的手牌'))) {
      expect(delivery.target.type).toBe('private');
      if (delivery.target.type === 'private') expect(delivery.target.seat).toBe(n);
    }
  });

  it.each([
    ['红跳过', 2, 1, 7],
    ['黄反转', 2, -1, 7],
    ['蓝+2', 2, 1, 9],
  ] as const)('起始牌 %s 正确影响第一位', (opening, current, direction, firstCount) => {
    const g = unit({ opening });
    expect(g.rec.state.dealer).toBe(3);
    expect(g.rec.state.current).toBe(current);
    expect(g.rec.state.direction).toBe(direction);
    expect(g.rec.state.hands['1']).toHaveLength(firstCount);
    expect(physicalCards(g).sort()).toEqual(fullDeck().sort());
  });

  it('双人起始反转仍从庄家右手边开始', () => {
    const g = unit({ n: 2, opening: '红反转' });
    expect(g.rec.state.dealer).toBe(2);
    expect(g.rec.state.current).toBe(1);
    expect(g.rec.state.direction).toBe(-1);
  });

  it('起始变色先指定颜色，不消耗手牌或出牌机会', () => {
    const g = unit({ opening: '变色' });
    const hand = [...g.rec.state.hands['1']!];
    expect(g.rec.phase!.key).toBe('color');
    expect(g.game.publicView().current_color).toBeNull();
    expect(g.game.privateView(1).needs_color).toBe(true);
    expect(g.game.parseCommand(1, '选色 蓝', 'group')).toEqual({ action: 'color', color: '蓝' });
    expect(() => g.game.onAction(1, { action: 'draw' }, { via: 'agent' })).toThrow();
    step(g, { action: 'color', color: '蓝' });
    expect(g.rec.state.currentColor).toBe('蓝');
    expect(g.rec.state.current).toBe(1);
    expect(g.rec.state.hands['1']).toEqual(hand);
    expect(g.rec.phase!.key).toBe('turn');
  });

  it('起始 +4 放回未发牌堆重洗，不丢牌、不重发手牌', () => {
    const g = unit({ opening: '变色+4' });
    expect(g.rec.state.discard).toEqual(['红0']);
    expect(g.rng.calls).toHaveLength(1 + 107 + (108 - 3 * 7 - 1));
    expect(Object.values(g.rec.state.hands).every((h) => h.length === 7)).toBe(true);
    expect(physicalCards(g).sort()).toEqual(fullDeck().sort());
  });
});

describe('彩牌接龙：匹配和功能牌', () => {
  it.each([
    ['红1', '红5', true],
    ['蓝5', '红5', true],
    ['绿跳过', '红跳过', true],
    ['蓝反转', '红反转', true],
    ['黄+2', '红+2', true],
    ['变色', '红5', true],
    ['变色+4', '红5', true],
    ['蓝3', '红5', false],
    ['蓝反转', '红跳过', false],
  ] as const)('牌 %s 对顶牌 %s 的匹配结果为 %s', (card, top, allowed) => {
    const g = unit();
    rig(g, { hands: { 1: [card, '黄8', '绿9'] }, discard: [top] });
    const action = () => play(g, card, '蓝');
    if (allowed) {
      action();
      expect(g.rec.state.discard.at(-1)).toBe(card);
    } else expect(action).toThrow(/不匹配/);
  });

  it('只允许当前座位行动，错误参数不改变状态，普通牌不能伪造当前颜色', () => {
    const g = unit();
    rig(g, { hands: { 1: ['红1', '绿9', '变色'] } });
    const before = JSON.stringify(g.rec.state);
    for (const input of [
      { action: 'pass' },
      { action: 'accept' },
      { action: 'play', card: '紫5' },
      { action: 'play', card: '蓝9' },
      { action: 'play', card: '变色' },
      { action: 'play', card: '变色', color: '紫' },
      { action: 'play', card: '红1', call: 'true' as unknown as boolean },
    ]) expect(() => g.game.onAction(1, input, { via: 'agent' })).toThrow();
    expect(() => g.game.onAction(2, { action: 'draw' }, { via: 'agent' })).toThrow();
    expect(JSON.stringify(g.rec.state)).toBe(before);
    play(g, '红1', '蓝');
    expect(g.rec.state.currentColor).toBe('红');
  });

  it.each([
    [3, '红跳过', 3, 1],
    [2, '红跳过', 1, 1],
    [3, '红反转', 3, -1],
    [2, '红反转', 1, -1],
    [3, '红+2', 3, 1],
    [2, '红+2', 1, 1],
  ] as const)('%i 人局出 %s 后轮到 %i 号', (n, card, current, direction) => {
    const g = unit({ n });
    rig(g, { hands: { 1: [card, '绿8', '黄7'] } });
    const before = g.rec.state.hands['2']!.length;
    play(g, card);
    expect(g.rec.state.current).toBe(current);
    expect(g.rec.state.direction).toBe(direction);
    expect(Object.keys(g.rec.phase!.pending)).toEqual([String(current)]);
    expect(g.rec.state.hands['2']).toHaveLength(before + (card === '红+2' ? 2 : 0));
    expect(() => g.game.onAction(2, { action: 'play', card: '黄+2' }, { via: 'agent' })).toThrow();
  });

  it('逆时针继续跳过和转向，变色不消耗下家回合', () => {
    const g = unit({ n: 4 });
    rig(g, { direction: -1, hands: { 1: ['红跳过', '蓝8', '绿7'] } });
    play(g, '红跳过');
    expect(g.rec.state.current).toBe(3);
    rig(g, { direction: -1, hands: { 1: ['红反转', '蓝8', '绿7'] } });
    play(g, '红反转');
    expect(g.rec.state.current).toBe(2);
    expect(g.rec.state.direction).toBe(1);
    rig(g, { hands: { 1: ['变色', '蓝8', '绿7'] } });
    play(g, '变色', '绿');
    expect(g.rec.state.current).toBe(2);
    expect(g.rec.state.currentColor).toBe('绿');
    expect(g.rec.state.hands['2']).toHaveLength(3);
  });
});

describe('彩牌接龙：摸牌和重洗', () => {
  it('允许不想出时摸牌；摸后只能出那张牌，不能再次摸或换出旧牌', () => {
    const g = unit();
    rig(g, { hands: { 1: ['红1', '蓝3'] }, deck: ['黄9', '红7'] });
    step(g, { action: 'draw' });
    expect(g.rec.phase!.key).toBe('drawn');
    expect(g.rec.state.current).toBe(1);
    expect(g.game.privateView(1)).toMatchObject({ playable: ['红7'], drawn_card: '红7' });
    expect(g.game.privateView(2).drawn_card).toBeNull();
    expect(() => g.game.onAction(1, { action: 'play', card: '红1' }, { via: 'agent' })).toThrow(/刚摸到/);
    expect(() => g.game.onAction(1, { action: 'draw' }, { via: 'agent' })).toThrow();
    play(g, '红7');
    expect(g.rec.state.hands['1']).toEqual(['红1', '蓝3']);
    expect(g.rec.state.current).toBe(2);
  });

  it('摸后可以过；摸到不匹配的牌直接结束回合', () => {
    const g = unit();
    rig(g, { hands: { 1: ['黄1'] }, deck: ['红7'] });
    step(g, { action: 'draw' });
    step(g, { action: 'pass' });
    expect(g.rec.state.hands['1']).toEqual(['黄1', '红7']);
    expect(g.rec.state.current).toBe(2);
    rig(g, { hands: { 1: ['黄1'] }, deck: ['蓝9'] });
    step(g, { action: 'draw' });
    expect(g.rec.phase!.key).toBe('turn');
    expect(g.rec.state.current).toBe(2);
    expect(g.rec.state.drawn).toBeNull();
  });

  it('摸到合法变色牌可立即出；有当前颜色时摸到 +4 不获得合法出牌机会', () => {
    const g = unit();
    rig(g, { hands: { 1: ['蓝1', '黄2'] }, deck: ['变色'] });
    step(g, { action: 'draw' });
    expect(g.game.privateView(1).needs_color).toBe(true);
    play(g, '变色', '黄');
    expect(g.rec.state.currentColor).toBe('黄');
    rig(g, { hands: { 1: ['红1'] }, deck: ['变色+4'] });
    step(g, { action: 'draw' });
    expect(g.rec.state.current).toBe(2);
  });

  it('仅重洗顶牌以外的弃牌，摸牌公告不公开牌名', () => {
    const g = unit();
    rig(g, {
      hands: { 1: ['黄9'] },
      deck: [],
      discard: ['蓝0', '绿1', '红5'],
    });
    const before = physicalCards(g).sort();
    const seq = g.rec.logSeq;
    step(g, { action: 'draw' });
    expect(g.rec.state.discard).toEqual(['红5']);
    expect(g.rec.state.deck).toHaveLength(1);
    expect(g.rec.state.hands['1']).toHaveLength(2);
    expect(physicalCards(g).sort()).toEqual(before);
    const publicText = g.rec.log.filter((l) => l.seq > seq && l.audience.type === 'public').map((l) => l.text).join('\n');
    expect(publicText).toContain('重新洗匀');
    expect(publicText).not.toContain('蓝0');
    expect(publicText).not.toContain('绿1');
  });

  it('可摸牌不足时不会复制顶牌或死循环', () => {
    const g = unit();
    rig(g, { deck: [], discard: ['红5'] });
    const before = physicalCards(g).sort();
    step(g, { action: 'draw' });
    expect(g.rec.state.current).toBe(2);
    expect(physicalCards(g).sort()).toEqual(before);
    expect(g.rec.log.some((l) => l.kind === 'draw' && l.text.includes('摸了 0 张'))).toBe(true);
  });
});

describe('彩牌接龙：+4 质疑', () => {
  it('合规：同数字异色和其他变色牌不影响资格，质疑者摸六张并跳过', () => {
    const g = unit({ humans: 2 });
    rig(g, {
      hands: { 1: ['变色+4', '蓝5', '变色'], 2: ['绿7', '变色+4'], 3: ['黄8'] },
    });
    expect(g.game.privateView(1).playable).toContain('变色+4');
    play(g, '变色+4', '绿');
    expect(g.rec.phase!.key).toBe('challenge');
    expect(Object.keys(g.rec.phase!.pending)).toEqual(['2']);
    expect(g.rec.state.hands['2']).toHaveLength(2);
    expect(() => g.game.onAction(2, { action: 'play', card: '变色+4', color: '红' }, { via: 'agent' })).toThrow();
    expect(() => g.game.onAction(3, { action: 'challenge' }, { via: 'agent' })).toThrow();
    step(g, { action: 'challenge' });
    expect(g.rec.state.hands['2']).toHaveLength(8);
    expect(g.rec.state.hands['1']).toEqual(['蓝5', '变色']);
    expect(g.rec.state.current).toBe(3);
    expect(g.rec.state.currentColor).toBe('绿');
    const evidence = g.rec.log.filter((l) => l.kind === 'challenge_hand');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.audience).toEqual({ type: 'seats', seats: [2] });
    expect(evidence[0]!.text).toContain('蓝5');
    const evidenceDeliveries = g.rec.outbox.filter((d) => d.text.includes('出变色+4前的手牌'));
    expect(evidenceDeliveries).toHaveLength(1);
    expect(evidenceDeliveries[0]!.target).toMatchObject({ type: 'private', seat: 2 });
    expect(JSON.stringify(g.game.publicView())).not.toContain('蓝5');
    expect(JSON.stringify(g.game.privateView(3))).not.toContain('蓝5');
    expect(g.rec.log.filter((l) => l.kind === 'challenge').map((l) => l.text)).toEqual(['🔍 质疑不成立。']);
  });

  it('违规：持有当前颜色的功能牌也算违规，出牌者摸四张，下家正常行动', () => {
    const g = unit();
    rig(g, { hands: { 1: ['变色+4', '红跳过', '蓝8'] } });
    expect(g.game.privateView(1).playable).not.toContain('变色+4');
    // 允许提交有争议的动作，证据由程序保留，不提前泄露违规与否。
    play(g, '变色+4', '蓝');
    const targetCount = g.rec.state.hands['2']!.length;
    expect(JSON.stringify(g.game.publicView())).not.toContain('红跳过');
    step(g, { action: 'challenge' });
    expect(g.rec.state.hands['1']).toHaveLength(6);
    expect(g.rec.state.hands['2']).toHaveLength(targetCount);
    expect(g.rec.state.current).toBe(2);
    expect(g.rec.state.currentColor).toBe('蓝');
    expect(g.rec.state.challenge).toBeNull();
    expect(g.rec.log.filter((l) => l.kind === 'challenge').map((l) => l.text)).toEqual(['🔍 质疑成立。']);
  });

  it('不质疑时只摸四张并跳过，不向任何人展示证据', () => {
    const g = unit();
    rig(g, { hands: { 1: ['变色+4', '红1', '黄8'] } });
    play(g, '变色+4', '黄');
    const count = g.rec.state.hands['2']!.length;
    step(g, { action: 'accept' });
    expect(g.rec.state.hands['2']).toHaveLength(count + 4);
    expect(g.rec.state.current).toBe(3);
    expect(g.rec.log.some((l) => l.kind === 'challenge_hand')).toBe(false);
  });

  it('资格使用出牌前快照，不被忘喊后的罚摸污染', () => {
    const g = unit();
    rig(g, {
      hands: { 1: ['变色+4', '蓝1'] },
      deck: [...Array.from({ length: 8 }, (): Card => '黄9'), '红2', '红3'],
    });
    step(g, { action: 'play', card: '变色+4', color: '绿' });
    expect(g.rec.state.hands['1']).toEqual(['蓝1', '红3', '红2']);
    step(g, { action: 'challenge' });
    expect(g.rec.state.hands['1']).toHaveLength(3);
    expect(g.rec.state.hands['2']).toHaveLength(9);
    expect(g.rec.log.find((l) => l.kind === 'challenge_hand')!.text).not.toContain('红3');
    expect(g.rec.log.find((l) => l.kind === 'challenge')!.text).toContain('不成立');
  });

  it.each(['accept', 'challenge'])('最后一张 +4 等待 %s 和处罚后才结束计分', (action) => {
    const g = unit({ n: 2 });
    rig(g, { hands: { 1: ['变色+4'], 2: ['蓝1'] } });
    play(g, '变色+4', '绿');
    expect(g.rec.status).toBe('running');
    expect(g.rec.result).toBeNull();
    step(g, { action });
    const penalty = action === 'accept' ? 4 : 6;
    expect(g.rec.status).toBe('ended');
    expect(g.rec.state.hands['2']).toHaveLength(1 + penalty);
    expect(g.rec.state.results[0]!.points).toBe(1 + penalty * 9);
    expect(g.rec.result!.winnerSeats).toEqual([1]);
  });
});

describe('彩牌接龙：喊牌和计分', () => {
  it.each([
    [true, true, 1],
    [false, true, 3],
    [false, false, 1],
    [true, false, 1],
  ] as const)('call=%s，call_penalty=%s，出后剩 %i 张', (call, call_penalty, count) => {
    const g = unit({ options: { call_penalty } });
    rig(g, { hands: { 1: ['红1', '蓝7'] } });
    step(g, { action: 'play', card: '红1', call });
    expect(g.rec.state.hands['1']).toHaveLength(count);
    expect(g.rec.log.some((l) => l.text.includes('喊出「最后一张」'))).toBe(call);
    expect(g.rec.log.some((l) => l.text.includes('自动罚摸 2 张'))).toBe(!call && call_penalty);
    expect(g.rec.log.filter((l) => l.kind === 'hand' && l.audience.type === 'seats' && l.audience.seats.includes(1)).at(-1)!.text)
      .toContain(`（${count}张）`);
  });

  it('一局制按数字、三类功能牌、两类变色牌的分值结算，不公开剩余手牌', () => {
    const g = unit({ n: 2 });
    rig(g, {
      hands: { 1: ['红1'], 2: ['蓝9', '黄跳过', '绿反转', '红+2', '变色', '变色+4'] },
    });
    play(g, '红1');
    expect(g.rec.status).toBe('ended');
    expect(g.rec.state.results).toEqual([{ round: 1, winner: 1, points: 169 }]);
    expect(g.rec.result!.winnerSeats).toEqual([1]);
    expect(g.game.publicView().current_turn).toBeNull();
    expect(JSON.stringify(g.game.publicView())).not.toContain('绿反转');
    expect(JSON.stringify(g.rec.result)).not.toContain('绿反转');
  });

  it('最后一张 +2 先处罚下家，再计算其剩余牌分', () => {
    const g = unit({ n: 2 });
    rig(g, { hands: { 1: ['红+2'], 2: ['蓝1'] }, deck: ['黄9', '黄8'] });
    play(g, '红+2');
    expect(g.rec.status).toBe('ended');
    expect(g.rec.state.results[0]!.points).toBe(18);
  });

  it('多局保留累计分，重新发牌并顺时针轮庄，达到目标后结束', () => {
    const g = unit({ n: 2, options: { target_score: 100 } });
    rig(g, { direction: -1, hands: { 1: ['红1'], 2: ['蓝9', '绿跳过'] } });
    play(g, '红1');
    expect(g.rec.status).toBe('running');
    expect(g.rec.round).toBe(2);
    expect(g.rec.state.dealer).toBe(1);
    expect(g.rec.state.scores).toEqual({ 1: 29, 2: 0 });
    expect(g.game.publicView().scores).toEqual({ 1: 29, 2: 0 });
    expect(Object.values(g.rec.state.hands).every((h) => h.length >= 7)).toBe(true);
    expect(physicalCards(g).sort()).toEqual(fullDeck().sort());
    rig(g, { hands: { 1: ['红1'], 2: ['变色', '变色+4'] } });
    play(g, '红1');
    expect(g.rec.status).toBe('ended');
    expect(g.rec.state.scores['1']).toBe(129);
    expect(g.rec.state.results.map((r) => r.points)).toEqual([29, 100]);
    expect(g.rec.result!.winnerSeats).toEqual([1]);
  });
});

describe('彩牌接龙：保密和输入清洗', () => {
  it('视图、普通待办和公开消息不包含其他手牌、牌堆顺序或质疑快照', () => {
    const g = unit({ humans: 2 });
    const logStart = g.rec.logSeq;
    rig(g, {
      hands: { 1: ['红3', '红1', '变色'], 2: ['绿7'], 3: ['黄8'] },
      deck: ['蓝9', '蓝8'],
    });
    expect(g.game.privateView(1).hand).toEqual(['红1', '红3', '变色']);
    expect(g.game.privateView(1).playable).toEqual(['红1', '红3', '变色']);
    expect(g.game.privateView(1).needs_color).toBe(true);
    for (const seat of [1, 2, 3]) {
      const view = JSON.stringify(g.game.privateView(seat));
      expect(view).not.toContain('蓝9');
      if (seat !== 2) expect(view).not.toContain('绿7');
      if (seat !== 3) expect(view).not.toContain('黄8');
    }
    const publicView = g.game.publicView();
    expect(publicView).toMatchObject({
      top_card: '红5', current_color: '红', direction: '顺时针', current_turn: 1, draw_pile_count: 2,
    });
    for (const secret of ['绿7', '黄8', '蓝9', '"hands"', '"deck"', '"discard"', '"hand"'])
      expect(JSON.stringify(publicView)).not.toContain(secret);
    expect(JSON.stringify(g.rec.phase!.pending)).not.toContain('绿7');
    const publicLogs = g.rec.log.filter((l) => l.seq > logStart && l.audience.type === 'public');
    expect(JSON.stringify(publicLogs)).not.toContain('绿7');
    const returned = g.game.privateView(1).hand as Card[];
    returned.pop();
    expect(g.rec.state.hands['1']).toHaveLength(3);
    for (const d of g.rec.outbox) {
      const t = d.target;
      if (t.type === 'group') expect(d.text).not.toContain('你的手牌');
      else expect(g.rec.players.find((p) => p.id === t.userId)?.seat).toBe(t.seat);
    }
  });

  it('昵称和指令中的占位符、CQ 码不能产生注入', () => {
    const g = unit({ names: ['坏{@2}[CQ:at,qq=999]\n名字'] });
    expect(g.rec.players[0]!.name).not.toContain('{@');
    expect(g.rec.players[0]!.name).not.toContain('[CQ:');
    expect(g.rec.players[0]!.name).not.toContain('\n');
    expect(g.rec.outbox.flatMap((d) => d.mentions).some((m) => m.id === '999')).toBe(false);
    expect(g.game.parseCommand(1, '出 红5{@2}', 'group')).toBeNull();
    expect(g.game.parseCommand(1, '出 ［ＣＱ：at,qq=999］红5', 'group')).toBeNull();
    expect(() => g.game.onAction(1, { action: '{@2}[CQ:at,qq=999]' }, { via: 'agent' })).toThrow();
  });
});

describe('彩牌接龙：超时和随机动作', () => {
  it('托管按手牌原顺序出第一张合法牌，并自动喊最后一张', () => {
    const g = unit();
    rig(g, { hands: { 1: ['红9', '红1'] } });
    timeout(g);
    expect(g.rec.state.discard.at(-1)).toBe('红9');
    expect(g.rec.state.hands['1']).toEqual(['红1']);
    expect(g.rec.log.some((l) => l.text.includes('喊出「最后一张」'))).toBe(true);
  });

  it('托管变色选本人最多的颜色，不主动打违规 +4', () => {
    const g = unit();
    rig(g, { hands: { 1: ['变色', '蓝1', '蓝2', '黄7'] } });
    timeout(g);
    expect(g.rec.state.currentColor).toBe('蓝');
    rig(g, { hands: { 1: ['变色+4', '红2', '蓝3'] } });
    timeout(g);
    expect(g.rec.state.discard.at(-1)).toBe('红2');
  });

  it('无牌可出时摸后直接过，即使摸到可出牌；摸后窗口超时则出刚摸到的牌', () => {
    const g = unit();
    rig(g, { hands: { 1: ['蓝1'] }, deck: ['红7'] });
    timeout(g);
    expect(g.rec.state.hands['1']).toEqual(['蓝1', '红7']);
    expect(g.rec.state.current).toBe(2);
    rig(g, { hands: { 1: ['蓝1', '黄2'] }, deck: ['红7'] });
    step(g, { action: 'draw' });
    expect(g.rec.phase!.key).toBe('drawn');
    timeout(g);
    expect(g.rec.state.discard.at(-1)).toBe('红7');
    expect(g.rec.state.current).toBe(2);
  });

  it('质疑窗口超时视为不质疑；随机动作只给当前座位', () => {
    const g = unit();
    rig(g, { hands: { 1: ['变色+4', '蓝1'], 2: ['蓝2', '黄3'] }, deck: Array.from({ length: 10 }, (): Card => '黄9') });
    play(g, '变色+4', '蓝');
    expect(g.rec.phase!.key).toBe('challenge');
    expect(g.game.randomAction(1)).toBeNull();
    expect(['challenge', 'accept']).toContain(g.game.randomAction(2)!.action);
    timeout(g);
    expect(g.rec.state.hands['2']).toHaveLength(6);
    expect(g.rec.state.current).toBe(3);
  });
});

describe('彩牌接龙：中文指令', () => {
  it('解析颜色、符号、全角写法、变色指定和最后一张', () => {
    const g = unit();
    rig(g, { hands: { 1: ['红5', '蓝跳过', '绿+2', '红反转', '变色', '变色+4'] } });
    const p = (t: string) => g.game.parseCommand(1, t, 'group');
    expect(p('出 红5')).toEqual({ action: 'play', card: '红5' });
    expect(p('出 红５')).toEqual({ action: 'play', card: '红5' });
    expect(p('出 蓝禁')).toEqual({ action: 'play', card: '蓝跳过' });
    expect(p('出 绿加2')).toEqual({ action: 'play', card: '绿+2' });
    expect(p('出 反转')).toEqual({ action: 'play', card: '红反转' });
    expect(p('出 转向')).toEqual({ action: 'play', card: '红反转' });
    expect(p('出 变色 蓝')).toEqual({ action: 'play', card: '变色', color: '蓝' });
    expect(p('出 万能 绿色')).toEqual({ action: 'play', card: '变色', color: '绿' });
    expect(p('出 变色+4 红')).toEqual({ action: 'play', card: '变色+4', color: '红' });
    expect(p('出 加4 黄')).toEqual({ action: 'play', card: '变色+4', color: '黄' });
    expect(p('出 红5 最后一张')).toEqual({ action: 'play', card: '红5', call: true });
    expect(p('摸')).toEqual({ action: 'draw' });
    expect(p('过')).toEqual({ action: 'pass' });
    expect(p('质疑')).toEqual({ action: 'challenge' });
    expect(p('不质疑')).toEqual({ action: 'accept' });
    expect(p('出 紫5')).toBeNull();
    expect(p('今天天气不错')).toBeNull();
    expect(g.game.parseCommand(2, '摸', 'group')).toBeNull();
  });

  it('起始变色时「选色 蓝」解析为选色', () => {
    const g = unit({ opening: '变色' });
    expect(g.rec.phase!.key).toBe('color');
    const seat = g.rec.state.current;
    expect(g.game.parseCommand(seat, '选色 蓝', 'group')).toEqual({ action: 'color', color: '蓝' });
    expect(g.game.parseCommand(seat, '紫', 'group')).toBeNull();
  });
});

describe('彩牌接龙：存档恢复', () => {
  it('JSON 往返后继续同一回合，摸后窗口和质疑窗口都能恢复', () => {
    const g = unit();
    rig(g, { hands: { 1: ['蓝1', '黄2'], 2: ['蓝2', '黄3'] }, deck: ['变色+4', '红7'] });
    step(g, { action: 'draw' });
    const r = resume(g);
    expect(r.rec.phase!.key).toBe('drawn');
    expect(r.rec.state.drawn).toBe('红7');
    step(r, { action: 'play', card: '红7', call: true });
    expect(r.rec.state.current).toBe(2);
    step(r, { action: 'draw' });
    const r2 = resume(r);
    expect(r2.rec.phase!.key).toBe('drawn');
    step(r2, { action: 'play', card: '变色+4', color: '黄' });
    const r3 = resume(r2);
    expect(r3.rec.phase!.key).toBe('challenge');
    step(r3, { action: 'challenge' });
    expect(r3.rec.state.challenge).toBeNull();
  });
});

describe('彩牌接龙：通过管理器', () => {
  it('act 的 card、color、call 参数能透传到游戏', async () => {
    const { manager, clock } = setup('cc-act');
    const { gameId, rec } = startGame(manager, 'color_chain', {
      players: [bot(1), bot(2), bot(3)],
      referee: REF,
      options: { random_seats: false },
    });
    await manager.refereeStep(REF, gameId);
    const st = rec.state as ColorChainState;
    const seat = st.current;
    const me = rec.players.find((p) => p.seat === seat)!;
    st.hands[String(seat)] = ['变色', '红1'];
    manager.act({ id: me.id, name: me.name }, gameId, { action: 'play', card: '变色', color: '绿', call: true });
    await manager.refereeStep(REF, gameId);
    expect(st.discard.at(-1)).toBe('变色');
    expect(st.currentColor).toBe('绿');
    expect(rec.log.some((l) => l.text.includes('喊出「最后一张」'))).toBe(true);
    expect(() => manager.act({ id: me.id, name: me.name }, gameId, { action: 'draw', call: 'yes' as unknown as boolean })).toThrow(/call/);
    void clock;
  });

  it('不同人数、手牌数和计分模式的随机完整对局都能结束，牌数守恒', async () => {
    for (let i = 0; i < 18; i++) {
      const { manager, clock } = setup(`cc-${i}`);
      const n = 2 + (i % 9);
      const nh = i % 5 === 0 ? 1 : 0;
      const { gameId, rec } = startGame(manager, 'color_chain', {
        players: Array.from({ length: n - nh }, (_, k) => bot(k + 1)),
        humans: Array.from({ length: nh }, (_, k) => human(k + 1)),
        referee: REF,
        options: {
          hand_size: 5 + (i % 6),
          target_score: i % 3 === 0 ? 100 : 0,
          call_penalty: i % 2 === 0,
        },
      });
      const steps = await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 20000 });
      expect(steps).toBeLessThan(20000);
      expect(rec.status).toBe('ended');
      const st = rec.state as ColorChainState;
      expect(sortCards(physicalCards({ rec } as never))).toEqual(sortCards(fullDeck()));
      expect(rec.result!.winnerSeats).toHaveLength(1);
      if ((rec.options as ColorChainOptions).target_score > 0) {
        expect(st.scores[String(rec.result!.winnerSeats[0])]).toBeGreaterThanOrEqual(100);
      } else {
        expect(st.hands[String(rec.result!.winnerSeats[0])]).toHaveLength(0);
      }
    }
  }, 60000);
});

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort();
}
