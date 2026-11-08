import { describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import type { ActionInput, GameRecord, Seat } from '../../src/core/types.js';
import { HoldemGame, holdemDefinition, type HoldemOptions, type HoldemState } from '../../src/games/holdem/index.js';
import { DECK, compare, evaluate } from '../../src/games/holdem/hand.js';
import { createRegistry } from '../../src/games/index.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

const cards = (s: string) => s.split(' ');
const value = (s: string) => evaluate(cards(s));
const BOARD = cards('♣2 ♦3 ♥7 ♠8 ♣9');
const ROYAL = cards('♠10 ♠J ♠Q ♠K ♠A');

async function newGame(opts: { n?: number; humans?: number; seed?: string | number; options?: Record<string, unknown> } = {}) {
  const { manager, clock } = setup(opts.seed ?? 1);
  const n = opts.n ?? 3;
  const { gameId, rec } = startGame(manager, 'holdem', {
    players: Array.from({ length: n - (opts.humans ?? 0) }, (_, i) => bot(i + 1)),
    humans: Array.from({ length: opts.humans ?? 0 }, (_, i) => human(i + 1)),
    referee: REF,
    options: { random_seats: false, max_hands: 1, ...opts.options },
  });
  await manager.refereeStep(REF, gameId);
  return { manager, clock, gameId, rec: rec as GameRecord<HoldemState, HoldemOptions> };
}
type Fixture = Awaited<ReturnType<typeof newGame>>;
const engine = (g: Fixture): HoldemGame => (g.manager as any).inst(g.rec);
const hp = (g: Fixture, s: Seat) => g.rec.state.seats[String(s)]!;
const cur = (g: Fixture) => g.rec.state.current!;
const order = (g: Fixture) => Array.from({ length: g.rec.players.length }, (_, i) => (cur(g) - 1 + i) % g.rec.players.length + 1);
function submit(g: Fixture, input: ActionInput) {
  const p = g.rec.players.find((p) => p.seat === cur(g))!;
  if (p.kind === 'human') g.manager.relayHumanMessage(REF, g.gameId, { userId: p.id, text: '', channel: 'group', action: input });
  else g.manager.act(identityOf(g.rec, p.seat), g.gameId, input);
}
async function step(g: Fixture, action: string, number?: number) {
  submit(g, { action, ...(number === undefined ? {} : { number }) });
  await g.manager.refereeStep(REF, g.gameId);
}
function stacks(g: Fixture, seats: Seat[], amounts: number[]) {
  expect(amounts.reduce((a, b) => a + b, 0)).toBe(g.rec.players.length * g.rec.options.start_chips);
  seats.forEach((s, i) => {
    hp(g, s).starting = amounts[i]!;
    hp(g, s).chips = amounts[i]! - hp(g, s).bet;
    hp(g, s).allin = hp(g, s).chips === 0;
  });
}
/** 只在测试中固定牌堆，含每街烧牌；保证 52 张牌不重复。 */
function deal(g: Fixture, holes: Record<number, string[]>, board = BOARD) {
  const used = new Set([...board, ...Object.values(holes).flat()]);
  const rest = DECK.filter((c) => !used.has(c));
  for (const p of g.rec.players) hp(g, p.seat).hole = holes[p.seat] ?? [rest.shift()!, rest.shift()!];
  g.rec.state.deck = [rest.shift()!, ...board.slice(0, 3), rest.shift()!, board[3]!, rest.shift()!, board[4]!, ...rest];
}
async function passive(g: Fixture) {
  for (let i = 0; g.rec.status === 'running' && i < 100; i++)
    await step(g, Number(engine(g).privateView(cur(g)).to_call) > 0 ? 'call' : 'check');
  expect(g.rec.status).toBe('ended');
}
function conserved(rec: GameRecord<HoldemState, HoldemOptions>) {
  const ps = Object.values(rec.state.seats);
  expect(ps.reduce((sum, p) => sum + p.chips + p.committed, 0)).toBe(rec.players.length * rec.options.start_chips);
  for (const p of ps) {
    expect(Number.isSafeInteger(p.chips) && p.chips >= 0).toBe(true);
    expect(Number.isSafeInteger(p.committed) && p.committed >= p.bet && p.bet >= 0).toBe(true);
  }
}

describe('holdem: 牌型', () => {
  it.each([
    ['♠A ♥J ♦9 ♣6 ♠3', '高牌', 0],
    ['♠A ♥A ♦9 ♣6 ♠3', '一对', 1],
    ['♠A ♥A ♦9 ♣9 ♠3', '两对', 2],
    ['♠A ♥A ♦A ♣6 ♠3', '三条', 3],
    ['♠9 ♥8 ♦7 ♣6 ♠5', '顺子', 4],
    ['♠A ♠J ♠9 ♠6 ♠3', '同花', 5],
    ['♠A ♥A ♦A ♣6 ♠6', '葫芦', 6],
    ['♠A ♥A ♦A ♣A ♠3', '四条', 7],
    ['♠9 ♠8 ♠7 ♠6 ♠5', '同花顺', 8],
    ['♥A ♥K ♥Q ♥J ♥10', '同花顺', 8],
  ])('%s → %s', (hand, name, category) => {
    expect(value(String(hand))).toMatchObject({ name, category });
  });
  it('轮子、皇家同花顺、牌型等级和各种踢脚', () => {
    expect(value('♠A ♥2 ♦3 ♣4 ♠5')).toMatchObject({ name: '顺子', ranks: [5] });
    expect(value('♥A ♥2 ♥3 ♥4 ♥5')).toMatchObject({ name: '同花顺', ranks: [5] });
    const pairs = [
      ['♠6 ♥2 ♦3 ♣4 ♠5', '♠A ♥2 ♦3 ♣4 ♠5'],
      ['♥A ♥K ♥Q ♥J ♥10', '♠K ♠Q ♠J ♠10 ♠9'],
      ['♠2 ♥2 ♦2 ♣2 ♠3', '♠A ♥A ♦A ♣K ♠K'],
      ['♠A ♥A ♦A ♣A ♠K', '♠A ♥A ♦A ♣A ♠Q'],
      ['♠K ♥K ♦K ♣A ♠A', '♠K ♥K ♦K ♣Q ♠Q'],
      ['♠A ♠J ♠9 ♠6 ♠4', '♥A ♥J ♥9 ♥6 ♥3'],
      ['♠7 ♥7 ♦7 ♣A ♠K', '♠7 ♥7 ♦7 ♣A ♠Q'],
      ['♠A ♥A ♦K ♣K ♠Q', '♠A ♥A ♦K ♣K ♠J'],
      ['♠A ♥A ♦K ♣Q ♠9', '♠A ♥A ♦K ♣Q ♠8'],
      ['♠A ♥K ♦Q ♣9 ♠7', '♠A ♥K ♦Q ♣9 ♠6'],
    ];
    for (const [a, b] of pairs) expect(compare(value(a!), value(b!))).toBeGreaterThan(0);
  });
  it('七选五、双三条葫芦、三对取两对，以及同牌型平局', () => {
    expect(value('♠A ♥A ♦A ♠K ♥K ♦K ♣2')).toMatchObject({ name: '葫芦', ranks: [14, 13] });
    expect(value('♠A ♥A ♠K ♥K ♠Q ♥Q ♣2')).toMatchObject({ name: '两对', ranks: [14, 13, 12] });
    expect(value('♠2 ♠3 ♠4 ♠5 ♠6 ♥A ♦A')).toMatchObject({ name: '同花顺', ranks: [6] });
    expect(compare(evaluate([...ROYAL, '♥2', '♦3']), evaluate([...ROYAL, '♣4', '♥5']))).toBe(0);
    expect(compare(value('♠A ♥A ♦K ♣Q ♠9'), value('♦A ♣A ♠K ♥Q ♦9'))).toBe(0);
    expect(() => value('♠A ♠A ♥2 ♦3 ♣4')).toThrow();
    expect(() => value('♠1 ♥2 ♦3 ♣4 ♠5')).toThrow();
    expect(() => value('♠A ♥2')).toThrow();
    expect(DECK).toHaveLength(52);
  });
});

describe('holdem: 开局、下注和加注权', () => {
  it('注册、选项和多人盲注顺序', async () => {
    for (const alias of ['德州扑克', '德州', 'texas', 'holdem'])
      expect(createRegistry().resolve(alias)?.idPrefix).toBe('TH');
    expect(holdemDefinition.optionsSchema.parse({})).toMatchObject({ start_chips: 1000, small_blind: 10, blind_up_hands: 10, max_hands: 0, turn_timeout_s: 45 });
    expect(() => holdemDefinition.optionsSchema.parse({ start_chips: 199 })).toThrow();
    const g = await newGame({ n: 5 });
    const st = g.rec.state;
    expect(st.smallSeat).toBe(st.dealer % 5 + 1);
    expect(st.bigSeat).toBe(st.smallSeat % 5 + 1);
    expect(cur(g)).toBe(st.bigSeat % 5 + 1);
    expect(hp(g, st.smallSeat)).toMatchObject({ chips: 990, bet: 10 });
    expect(hp(g, st.bigSeat)).toMatchObject({ chips: 980, bet: 20 });
    expect(pendingSeats(g.rec)).toEqual([cur(g)]);
    expect(new Set([...st.deck, ...Object.values(st.seats).flatMap((p) => p.hole)]).size).toBe(52);
  });
  it('单挑庄家兼小盲，翻前先动、翻后后动；大盲有过牌权', async () => {
    const g = await newGame({ n: 2 });
    const { dealer, bigSeat } = g.rec.state;
    expect(cur(g)).toBe(dealer);
    expect(g.rec.state.smallSeat).toBe(dealer);
    await step(g, 'call');
    expect(cur(g)).toBe(bigSeat);
    expect(g.rec.state.street).toBe('preflop');
    await step(g, 'check');
    expect(g.rec.state.street).toBe('flop');
    expect(cur(g)).toBe(bigSeat);
    expect(engine(g).privateView(bigSeat).best_hand).not.toBeNull();
  });
  it('整数、最小完整加注和行动座位；非法动作不改账本', async () => {
    const g = await newGame();
    const before = JSON.stringify(g.rec.state);
    for (const input of [{ action: 'check' }, { action: 'raise', number: 39 }, { action: 'raise', number: -5 }, { action: 'raise', number: 1001 }])
      expect(() => submit(g, input)).toThrow();
    expect(() => g.manager.act(identityOf(g.rec, cur(g) % 3 + 1), g.gameId, { action: 'fold' })).toThrow();
    expect(JSON.stringify(g.rec.state)).toBe(before);
    await step(g, 'raise', 100);
    expect(g.rec.state.lastRaise).toBe(80);
    expect(engine(g).privateView(cur(g)).min_raise_to).toBe(180);
    expect(() => submit(g, { action: 'raise', number: 179 })).toThrow();
    await step(g, 'raise', 180);
    conserved(g.rec);
  });
  it('不足最小加注只许全下；短全下不重开已行动者的加注权', async () => {
    const g = await newGame();
    const [a, b, c] = order(g) as [Seat, Seat, Seat];
    stacks(g, [a, b, c], [1000, 150, 1850]);
    await step(g, 'raise', 100);
    expect(() => submit(g, { action: 'raise', number: 149 })).toThrow();
    await step(g, 'raise', 150);
    expect(g.rec.state.lastRaise).toBe(80);
    expect(engine(g).privateView(c).min_raise_to).toBe(230);
    await step(g, 'call');
    expect(cur(g)).toBe(a);
    expect(engine(g).privateView(a)).toMatchObject({ to_call: 50, can_raise: false, min_raise_to: null });
    expect(() => submit(g, { action: 'raise', number: 230 })).toThrow();
    expect(() => submit(g, { action: 'allin' })).toThrow();
    await step(g, 'call');
    expect(g.rec.state.street).toBe('flop');
    expect(cur(g)).toBe(c);
  });
  it.each([false, true])('短全下后的完整加注或累计短加注重开：%s', async (cumulative) => {
    const g = await newGame({ n: 4 });
    const seats = order(g);
    stacks(g, seats, cumulative ? [1000, 140, 180, 2680] : [1000, 150, 1000, 1850]);
    await step(g, 'raise', 100);
    await step(g, 'allin');
    await step(g, cumulative ? 'allin' : 'raise', cumulative ? undefined : 230);
    await step(g, 'call');
    expect(cur(g)).toBe(seats[0]);
    expect(engine(g).privateView(cur(g))).toMatchObject({ can_raise: true, min_raise_to: cumulative ? 260 : 310 });
  });
  it('先过牌者面对不足大盲的首次全下下注仍可加注', async () => {
    const g = await newGame();
    stacks(g, order(g), [1970, 1000, 30]);
    await step(g, 'call'); await step(g, 'call'); await step(g, 'check');
    await step(g, 'check'); await step(g, 'allin'); await step(g, 'call');
    expect(engine(g).privateView(cur(g))).toMatchObject({ to_call: 10, can_raise: true, min_raise_to: 30 });
  });
});

describe('holdem: 边池、摊牌和锦标赛', () => {
  it('三人不同额度全下，退还未匹配下注，各池只在合资格者间比牌', async () => {
    const g = await newGame({ options: { start_chips: 200 } });
    const [a, b, c] = order(g) as [Seat, Seat, Seat];
    stacks(g, [a, b, c], [300, 200, 100]);
    deal(g, { [a]: cards('♥Q ♦Q'), [b]: cards('♥K ♦K'), [c]: cards('♥A ♦A') });
    await step(g, 'allin'); await step(g, 'allin');
    const publicPots = engine(g).publicView().pots as { amount: number }[];
    expect(publicPots.reduce((sum, p) => sum + p.amount, 0)).toBe(engine(g).publicView().pot);
    await step(g, 'allin');
    expect(g.rec.state.board).toEqual(BOARD);
    expect(g.rec.state.lastHand!.pots.map((p) => p.amount)).toEqual([300, 200]);
    expect(g.rec.state.lastHand!.pots.map((p) => p.awards)).toEqual([[{ seat: c, amount: 300 }], [{ seat: b, amount: 200 }]]);
    expect([hp(g, a).chips, hp(g, b).chips, hp(g, c).chips]).toEqual([100, 200, 300]);
    expect(g.rec.log.some((l) => l.kind === 'refund' && l.text.includes('100'))).toBe(true);
    conserved(g.rec);
  });
  it.each([3, 4])('%i 人平分时，全部余数归庄家左侧首位赢家', async (n) => {
    const g = await newGame({ n, options: { start_chips: 200, small_blind: 1 } });
    deal(g, {}, ROYAL);
    await step(g, 'raise', 5);
    for (let i = 1; i < n; i++) await step(g, 'call');
    const folded = cur(g);
    await step(g, 'fold');
    await passive(g);
    const winners = g.rec.players.map((p) => p.seat).filter((s) => s !== folded);
    const first = engine(g).orderFrom(g.rec.state.dealer + 1, winners)[0]!;
    const awards = g.rec.state.lastHand!.pots[0]!.awards;
    const total = n * 5, share = Math.floor(total / winners.length);
    expect(awards[0]).toEqual({ seat: first, amount: share + total % winners.length });
    expect(awards.slice(1).every((a) => a.amount === share)).toBe(true);
    conserved(g.rec);
  });
  it('只剩一人不亮牌直接收池，弃牌者底牌不出现在任何视图和公告', async () => {
    const g = await newGame();
    const hole1 = [...hp(g, cur(g)).hole];
    const first = cur(g);
    await step(g, 'fold');
    const second = cur(g);
    const hole2 = [...hp(g, second).hole];
    await step(g, 'fold');
    expect(g.rec.status).toBe('ended');
    expect(g.rec.log.some((l) => l.kind === 'showdown')).toBe(false);
    const publicText = JSON.stringify([
      engine(g).publicView(),
      g.rec.log.filter((l) => l.audience.type === 'public'),
      g.rec.outbox.filter((d) => d.target.type === 'group'),
      g.rec.result,
    ]);
    for (const c of [...hole1, ...hole2]) expect(publicText).not.toContain(c);
    expect(engine(g).privateView(first).hole).toEqual([]);
    conserved(g.rec);
  });

  it('全下被跟后自动发完公共牌并摊牌，摊牌只亮参与者底牌', async () => {
    const g = await newGame({ n: 3 });
    const [a, b, c] = order(g) as [Seat, Seat, Seat];
    deal(g, { [a]: ['♠A', '♥A'], [b]: ['♠K', '♥K'], [c]: ['♦4', '♦5'] });
    const folderHole = [...hp(g, c).hole];
    await step(g, 'allin');
    await step(g, 'call');
    expect(cur(g)).toBe(c);
    await step(g, 'fold');
    expect(g.rec.status).toBe('ended');
    expect(g.rec.state.lastHand!.board).toEqual(BOARD);
    const show = g.rec.log.find((l) => l.kind === 'showdown')!.text;
    expect(show).toContain('♠A ♥A');
    expect(show).toContain('♠K ♥K');
    for (const card of folderHole) expect(show).not.toContain(card);
    expect(g.rec.result!.winnerSeats).toEqual([a]);
    conserved(g.rec);
  });

  it('筹码归零出局，只剩一人时结束并排名', async () => {
    const g = await newGame({ n: 2, options: { max_hands: 0 } });
    const [a, b] = order(g) as [Seat, Seat];
    deal(g, { [a]: ['♠A', '♥A'], [b]: ['♠K', '♥K'] });
    await step(g, 'allin');
    await step(g, 'call');
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result!.winnerSeats).toEqual([a]);
    expect(g.rec.players.find((p) => p.seat === b)!.alive).toBe(false);
    expect(hp(g, a).rank).toBe(1);
    expect(hp(g, b).rank).toBe(2);
    expect(hp(g, a).chips).toBe(2000);
    conserved(g.rec);
  });

  it('每打满 blind_up_hands 手盲注翻倍，并在达到 max_hands 后按筹码结束', async () => {
    const g = await newGame({ n: 3, options: { blind_up_hands: 2, max_hands: 3 } });
    for (let hand = 1; hand <= 3; hand++) {
      expect(g.rec.state.hand).toBe(hand);
      expect(g.rec.state.smallBlind).toBe(hand === 3 ? 20 : 10);
      expect(g.rec.state.bigBlind).toBe(hand === 3 ? 40 : 20);
      while (g.rec.status === 'running' && g.rec.state.hand === hand) await step(g, 'fold');
    }
    expect(g.rec.status).toBe('ended');
    expect(g.rec.log.some((l) => l.text.includes('盲注上涨'))).toBe(true);
    const best = Math.max(...Object.values(g.rec.state.seats).map((p) => p.chips));
    for (const s of g.rec.result!.winnerSeats) expect(hp(g, s).chips).toBe(best);
    conserved(g.rec);
  });
});

describe('holdem: 托管、指令、视图和恢复', () => {
  it('超时能过牌就过牌，否则弃牌', async () => {
    const g = await newGame({ n: 3 });
    const first = cur(g);
    g.clock.advance(46_000);
    await g.manager.refereeStep(REF, g.gameId);
    await g.manager.refereeStep(REF, g.gameId);
    expect(hp(g, first).folded).toBe(true);
    // 翻牌前大盲面对跟注为 0 时托管过牌。
    await step(g, 'call');
    const bb = g.rec.state.bigSeat;
    expect(cur(g)).toBe(bb);
    g.clock.advance(46_000);
    await g.manager.refereeStep(REF, g.gameId);
    await g.manager.refereeStep(REF, g.gameId);
    expect(hp(g, bb).folded).toBe(false);
    expect(g.rec.state.street).toBe('flop');
    conserved(g.rec);
  });

  it('解析中文指令和全角数字，非当前座位或私聊返回 null', async () => {
    const g = await newGame();
    const game = engine(g);
    const p = (t: string) => game.parseCommand(cur(g), t, 'group');
    expect(p('弃牌')).toEqual({ action: 'fold' });
    expect(p('弃')).toEqual({ action: 'fold' });
    expect(p('过')).toEqual({ action: 'check' });
    expect(p('过牌')).toEqual({ action: 'check' });
    expect(p('跟')).toEqual({ action: 'call' });
    expect(p('跟注！')).toEqual({ action: 'call' });
    expect(p('全下')).toEqual({ action: 'allin' });
    expect(p('ALLIN')).toEqual({ action: 'allin' });
    expect(p('梭哈')).toEqual({ action: 'allin' });
    expect(p('加注 200')).toEqual({ action: 'raise', number: 200 });
    expect(p('加到２００')).toEqual({ action: 'raise', number: 200 });
    expect(p('加 60')).toEqual({ action: 'raise', number: 60 });
    expect(p('加油')).toBeNull();
    expect(p('今天手气不错')).toBeNull();
    const other = g.rec.players.find((x) => x.seat !== cur(g))!.seat;
    expect(game.parseCommand(other, '跟', 'group')).toBeNull();
    expect(game.parseCommand(cur(g), '跟', 'private')).toBeNull();
  });

  it('视图只给本人底牌；牌堆和别人的底牌不出现在 publicView 和别人的 privateView', async () => {
    const g = await newGame({ n: 4, humans: 1 });
    const game = engine(g);
    const pub = JSON.stringify(game.publicView());
    for (const c of g.rec.state.deck) expect(pub).not.toContain(c);
    for (const p of g.rec.players) {
      const mine = hp(g, p.seat).hole;
      expect(game.privateView(p.seat).hole).toEqual(mine);
      for (const c of mine) expect(pub).not.toContain(c);
      for (const q of g.rec.players) {
        if (q.seat === p.seat) continue;
        const view = JSON.stringify(game.privateView(q.seat));
        for (const c of mine) expect(view).not.toContain(c);
      }
    }
    const humanSeat = g.rec.players.find((p) => p.kind === 'human')!;
    const dm = g.rec.outbox.filter((d) => d.target.type === 'private' && d.text.includes('底牌'));
    expect(dm.length).toBeGreaterThan(0);
    for (const d of dm) {
      const t = d.target;
      if (t.type === 'private') expect(t.userId).toBe(humanSeat.id);
    }
    for (const d of g.rec.outbox.filter((x) => x.target.type === 'group'))
      for (const c of hp(g, humanSeat.seat).hole) expect(d.text).not.toContain(c);
  });

  it('JSON 往返后新实例可以继续下注', async () => {
    const g = await newGame({ n: 3 });
    const rec = JSON.parse(JSON.stringify(g.rec)) as GameRecord<HoldemState, HoldemOptions>;
    const game = new HoldemGame(rec, { now: g.clock.now, rng: new SeededRng('恢复') });
    const seat = rec.state.current!;
    rec.phase!.openedAt = g.clock.now();
    game.onAction(seat, { action: 'call' }, { via: 'agent' });
    game.advance();
    expect(rec.state.seats[String(seat)]!.bet).toBe(rec.state.bigBlind);
    expect(rec.state.current).not.toBe(seat);
    conserved(rec);
  });

  it('2～9 人随机完整对局都能结束，全程筹码守恒', async () => {
    for (let i = 0; i < 32; i++) {
      const n = 2 + (i % 8);
      const { manager, clock } = setup(`th-${i}`);
      const { gameId, rec } = startGame(manager, 'holdem', {
        players: Array.from({ length: n - (i % 7 === 0 ? 1 : 0) }, (_, k) => bot(k + 1)),
        humans: i % 7 === 0 ? [human(1)] : [],
        referee: REF,
        options: { start_chips: 200 + (i % 4) * 300, blind_up_hands: 1 + (i % 5), max_hands: i % 2 === 0 ? 0 : 30 },
      });
      const steps = await playToEnd(manager, gameId, {
        referee: REF, clock, maxSteps: 20000,
        onStep: (r) => conserved(r as GameRecord<HoldemState, HoldemOptions>),
      });
      expect(steps).toBeLessThan(20000);
      expect(rec.status).toBe('ended');
      const r = rec as GameRecord<HoldemState, HoldemOptions>;
      conserved(r);
      expect(r.result!.winnerSeats.length).toBeGreaterThan(0);
      if ((r.options as HoldemOptions).max_hands === 0) {
        expect(r.players.filter((p) => p.alive)).toHaveLength(1);
        expect(r.result!.winnerSeats).toEqual([r.players.find((p) => p.alive)!.seat]);
      }
    }
  }, 120_000);
});
