import { describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import type { ActionInput, GameRecord, Seat } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import {
  BluffTavernGame, bluffTavernDefinition,
  type BluffTavernCard as Card, type BluffTavernOptions, type BluffTavernState,
} from '../../src/games/bluff-tavern/index.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

type Rec = GameRecord<BluffTavernState, BluffTavernOptions>;
const ORDER: Card[] = ['王', '后', '尖', '百搭'];
const sorted = (cards: Card[]) => [...cards].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
const fullDeck = (): Card[] => [
  ...Array<Card>(6).fill('王'), ...Array<Card>(6).fill('后'), ...Array<Card>(6).fill('尖'), '百搭', '百搭',
];
const cur = (rec: Rec): Seat => rec.state.current;
const next = (seat: Seat, n: number): Seat => seat % n + 1;

async function newGame(opts: { n?: number; humans?: number; seed?: string | number; options?: Record<string, unknown> } = {}) {
  const { manager, clock } = setup(opts.seed ?? 1);
  const players = Array.from({ length: (opts.n ?? 3) - (opts.humans ?? 0) }, (_, i) => bot(i + 1));
  const humans = Array.from({ length: opts.humans ?? 0 }, (_, i) => human(i + 1));
  const { gameId, rec } = startGame(manager, 'bluff_tavern', {
    players, humans, referee: REF, options: { random_seats: false, ...opts.options },
  });
  await manager.refereeStep(REF, gameId);
  return { manager, clock, gameId, rec: rec as Rec };
}
type TestGame = Awaited<ReturnType<typeof newGame>>;
const instance = (g: TestGame) => new BluffTavernGame(g.rec, { now: g.clock.now, rng: new SeededRng(13) });

function conserved(rec: Rec): void {
  const st = rec.state;
  const cards = [...st.stock, ...st.discard, ...Object.values(st.hands).flat(), ...(st.lastPlay?.cards ?? [])];
  expect(cards).toHaveLength(20);
  expect(cards.sort()).toEqual(fullDeck().sort());
}

/** 测试布牌也从完整牌组扣除，避免凭空造牌掩盖守恒错误。 */
function rig(g: TestGame, hands: Record<number, Card[]>): void {
  const st = g.rec.state;
  const deck = fullDeck();
  st.hands = {};
  for (const p of g.rec.players) {
    st.hands[String(p.seat)] = [...(hands[p.seat] ?? [])];
    for (const card of st.hands[String(p.seat)]!) {
      const index = deck.indexOf(card);
      expect(index).toBeGreaterThanOrEqual(0);
      deck.splice(index, 1);
    }
  }
  Object.assign(st, { stock: deck, discard: [], lastPlay: null, tableCard: '王' });
  conserved(g.rec);
}
function arrange(g: TestGame, hand: Card[]): void {
  const hands: Record<number, Card[]> = {};
  for (const p of g.rec.players) hands[p.seat] = p.alive ? ['尖'] : [];
  hands[cur(g.rec)] = hand;
  rig(g, hands);
}
async function act(g: TestGame, input: ActionInput): Promise<void> {
  const p = g.rec.players.find((p) => p.seat === cur(g.rec))!;
  if (p.kind === 'human') g.manager.relayHumanMessage(REF, g.gameId, { userId: p.id, text: '', channel: 'group', action: input });
  else g.manager.act(identityOf(g.rec, p.seat), g.gameId, input);
  await g.manager.refereeStep(REF, g.gameId);
}
const play = (g: TestGame, card: string) => act(g, { action: 'play', card });
async function expire(g: TestGame): Promise<void> {
  g.clock.advance(46_000);
  await g.manager.refereeStep(REF, g.gameId);
  await g.manager.refereeStep(REF, g.gameId);
}
const reveal = (g: TestGame) => g.rec.log.filter((l) => l.kind === 'reveal').at(-1)!.data!;
function noBulletLeaks(g: TestGame): void {
  const game = instance(g);
  const visible = { public: game.publicView(), private: g.rec.players.map((p) => game.privateView(p.seat)),
    log: g.rec.log, outbox: g.rec.outbox, result: g.rec.result };
  expect(JSON.stringify(visible)).not.toMatch(/bulletPosition|revolvers|实弹位置|子弹位置|弹仓位置/u);
}

describe('诈牌酒馆：开局与出牌', () => {
  it('注册别名、默认选项与边界', () => {
    for (const name of ['bluff_tavern', '诈牌酒馆', '酒馆', 'bluff-tavern'])
      expect(createRegistry().resolve(name)).toBe(bluffTavernDefinition);
    expect(bluffTavernDefinition.idPrefix).toBe('BT');
    const schema = bluffTavernDefinition.optionsSchema;
    expect(schema.parse({})).toMatchObject({ start_cards: 5, chambers: 6, turn_timeout_s: 45 });
    for (const options of [{ start_cards: 2 }, { start_cards: 6 }, { chambers: 1 }, { chambers: 7 }])
      expect(schema.safeParse(options).success).toBe(false);
  });

  it.each([2, 3, 4, 5, 6])('%i 人正确发牌、随机桌牌且只有当前玩家有待办', async (n) => {
    const g = await newGame({ n });
    const game = instance(g);
    expect(['王', '后', '尖']).toContain(g.rec.state.tableCard);
    expect(pendingSeats(g.rec)).toEqual([cur(g.rec)]);
    expect(g.rec.phase!.timeoutMs).toBe(45_000);
    for (const p of g.rec.players) {
      const hand = g.rec.state.hands[String(p.seat)]!;
      expect(hand).toHaveLength(Math.min(5, Math.floor(20 / n)));
      expect(game.privateView(p.seat).hand).toEqual(sorted(hand));
      const gun = g.rec.state.revolvers[String(p.seat)]!;
      expect(gun.shots).toBe(0);
      expect(gun.bulletPosition).toBeGreaterThanOrEqual(0);
      expect(gun.bulletPosition).toBeLessThan(6);
      if (p.seat !== cur(g.rec)) {
        expect(game.privateView(p.seat).available_actions).toEqual([]);
        expect(game.randomAction(p.seat)).toBeNull();
      }
    }
    conserved(g.rec);
    noBulletLeaks(g);
  });

  it.each(['王', '王 后', '王,后,百搭'])('允许按牌名出 1～3 张：%s', async (card) => {
    const g = await newGame();
    arrange(g, ['王', '后', '百搭']);
    const seat = cur(g.rec);
    await play(g, card);
    const cards = card.split(/[ ,]/u);
    expect(g.rec.state.lastPlay).toEqual({ seat, cards });
    expect(g.rec.state.hands[String(seat)]).toHaveLength(3 - cards.length);
    expect(instance(g).publicView().last_play).toEqual({ seat, count: cards.length });
    expect(cur(g.rec)).toBe(next(seat, 3));
    expect(g.rec.phase!.key).toBe('respond');
    conserved(g.rec);
  });

  it('拒绝非法张数、数量表达式、不在手里、重复超量与越权动作，失败不改状态', async () => {
    const g = await newGame();
    arrange(g, ['王', '尖']);
    const before = JSON.stringify(g.rec.state);
    const who = identityOf(g.rec, cur(g.rec));
    for (const card of [undefined, '', '王 王 王 王', '后', '王 王', '王后', '3 张 尖', '王,假牌']) {
      expect(() => g.manager.act(who, g.gameId, { action: 'play', card })).toThrow();
      expect(JSON.stringify(g.rec.state)).toBe(before);
      expect(g.rec.phase!.data).toEqual({});
    }
    for (const action of ['trust', 'challenge'])
      expect(() => g.manager.act(who, g.gameId, { action })).toThrow();
    expect(() => g.manager.act(identityOf(g.rec, next(cur(g.rec), 3)), g.gameId, { action: 'play', card: '尖' })).toThrow();
  });

  it('放过后由判断者出牌，旧牌进入背面弃牌区', async () => {
    const g = await newGame();
    arrange(g, ['后', '王']);
    await play(g, '后');
    const responder = cur(g.rec);
    await act(g, { action: 'trust' });
    expect(cur(g.rec)).toBe(responder);
    expect(g.rec.phase!.key).toBe('play');
    await play(g, '尖');
    expect(g.rec.state.discard).toEqual(['后']);
    expect(g.rec.round).toBe(1);
    expect(g.rec.log.some((l) => l.kind === 'trust' && l.text.includes('放过'))).toBe(true);
    conserved(g.rec);
  });
});

describe('诈牌酒馆：验牌与轮转', () => {
  it.each([
    { cards: ['后'], liar: true }, { cards: ['王'], liar: false },
    { cards: ['百搭'], liar: false }, { cards: ['王', '百搭'], liar: false },
    { cards: ['王', '百搭', '后'], liar: true },
  ] satisfies { cards: Card[]; liar: boolean }[])('检验 $cards，撒谎=$liar', async ({ cards, liar }) => {
    const g = await newGame();
    arrange(g, cards);
    for (const gun of Object.values(g.rec.state.revolvers)) gun.bulletPosition = 5;
    const player = cur(g.rec);
    await play(g, cards.join(' '));
    const challenger = cur(g.rec);
    await act(g, { action: 'challenge' });
    const shooter = liar ? player : challenger;
    expect(reveal(g)).toMatchObject({ seat: player, challenger, cards, liar, shooter });
    expect(g.rec.state.revolvers[String(shooter)]!.shots).toBe(1);
    expect(g.rec.state.revolvers[String(liar ? challenger : player)]!.shots).toBe(0);
    expect(g.rec.state.starter).toBe(shooter);
    expect(cur(g.rec)).toBe(shooter);
    expect(g.rec.round).toBe(2);
    expect(g.rec.log.some((l) => l.kind === 'reveal' && l.text.includes(cards.join(' ')))).toBe(true);
    conserved(g.rec);
  });

  it('空手者连判断也跳过；最后一手出完时仍自动检验', async () => {
    const g = await newGame({ n: 4 });
    const a = cur(g.rec), b = next(a, 4), c = next(b, 4);
    rig(g, { [a]: ['后'], [c]: ['王'] });
    await play(g, '后');
    expect(cur(g.rec)).toBe(c);
    expect(pendingSeats(g.rec)).toEqual([c]);
    await act(g, { action: 'trust' });
    await play(g, '王');
    expect(reveal(g)).toMatchObject({ challenger: null, seat: c, liar: false, shooter: null });
    expect(g.rec.round).toBe(2);
    expect(g.rec.state.starter).toBe(a);
    expect(Object.values(g.rec.state.revolvers).every((gun) => gun.shots === 0)).toBe(true);
    conserved(g.rec);
  });

  it.each(['王', '后'] as const)('仅出牌者还有牌时立即自动检验：%s', async (card) => {
    const g = await newGame();
    const seat = cur(g.rec);
    rig(g, { [seat]: ['王', '后'] });
    g.rec.state.revolvers[String(seat)]!.bulletPosition = 5;
    await play(g, card);
    expect(reveal(g)).toMatchObject({ challenger: null, liar: card === '后', shooter: card === '后' ? seat : null });
    expect(g.rec.state.revolvers[String(seat)]!.shots).toBe(card === '后' ? 1 : 0);
    expect(g.rec.round).toBe(2);
    expect(g.rec.state.starter).toBe(seat);
    conserved(g.rec);
  });

  it('实弹位置固定：先空枪再中弹，出局由下家起手，最后一人获胜且不泄露位置', async () => {
    const g = await newGame({ options: { chambers: 2 } });
    for (const gun of Object.values(g.rec.state.revolvers)) gun.bulletPosition = 1;
    const a = cur(g.rec);
    for (let shot = 1; shot <= 2; shot++) {
      arrange(g, ['后', '王']);
      await play(g, '后');
      await act(g, { action: 'challenge' });
      expect(g.rec.state.revolvers[String(a)]).toEqual({ bulletPosition: 1, shots: shot });
      expect(g.rec.log.filter((l) => l.kind === 'shot').at(-1)!.data).toEqual({ seat: a, shot, hit: shot === 2 });
      conserved(g.rec);
      noBulletLeaks(g);
    }
    expect(g.rec.state.eliminated).toEqual([a]);
    expect(g.rec.state.hands[String(a)]).toEqual([]);
    expect(cur(g.rec)).toBe(next(a, 3));
    const b = cur(g.rec);
    g.rec.state.revolvers[String(b)]!.bulletPosition = 0;
    arrange(g, ['后', '王']);
    await play(g, '后');
    await act(g, { action: 'challenge' });
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result!.winnerSeats).toEqual([next(b, 3)]);
    expect(instance(g).publicView().current_turn).toBeNull();
    expect(g.rec.players.filter((p) => p.alive)).toHaveLength(1);
    conserved(g.rec);
    noBulletLeaks(g);
  });

  it('第一小轮起手和装弹使用注入的 rng', async () => {
    const g = await newGame({ n: 4 });
    for (const last of [false, true]) {
      const rec = JSON.parse(JSON.stringify(g.rec)) as Rec;
      new BluffTavernGame(rec, { now: g.clock.now, rng: { int: (max) => last ? max - 1 : 0 } }).start();
      expect(rec.state.starter).toBe(last ? 4 : 1);
      expect(Object.values(rec.state.revolvers).map((gun) => gun.bulletPosition)).toEqual(Array(4).fill(last ? 5 : 0));
      conserved(rec);
    }
  });
});

describe('诈牌酒馆：托管、指令与保密', () => {
  it.each([
    { hand: ['后', '王'], expected: '王' }, { hand: ['后', '百搭'], expected: '百搭' },
    { hand: ['后', '尖'], expected: '后' },
  ] satisfies { hand: Card[]; expected: Card }[])('出牌超时选 $expected，判断超时放过', async ({ hand, expected }) => {
    const g = await newGame();
    arrange(g, hand);
    await expire(g);
    expect(g.rec.state.lastPlay!.cards).toEqual([expected]);
    const responder = cur(g.rec);
    await expire(g);
    expect(g.rec.phase!.key).toBe('play');
    expect(cur(g.rec)).toBe(responder);
    expect(g.rec.log.filter((l) => l.kind === 'trust').at(-1)!.data).toMatchObject({ auto: true });
    conserved(g.rec);
  });

  it('判断窗口托管防御性处理：判断者已无牌则质疑', async () => {
    const g = await newGame();
    arrange(g, ['王']);
    for (const gun of Object.values(g.rec.state.revolvers)) gun.bulletPosition = 5;
    await play(g, '王');
    const seat = cur(g.rec);
    g.rec.state.discard.push(...g.rec.state.hands[String(seat)]!);
    g.rec.state.hands[String(seat)] = [];
    await expire(g);
    expect(reveal(g)).toMatchObject({ challenger: seat, shooter: seat, auto: true });
    conserved(g.rec);
  });

  it('解析中文连写、全角空格和逗号、质疑及放过别名，拒绝数量和闲聊', async () => {
    const g = await newGame();
    const game = instance(g), seat = cur(g.rec);
    const p = (text: string) => game.parseCommand(seat, text, 'group');
    for (const text of ['出 王 后 百搭', '出王后百搭', '出　王，后，百搭！'])
      expect(p(text)).toEqual({ action: 'play', card: '王 后 百搭' });
    expect(p('出 王王百搭')).toEqual({ action: 'play', card: '王 王 百搭' });
    expect(p('出王后')).toEqual({ action: 'play', card: '王 后' });
    expect(p('出 王')).toEqual({ action: 'play', card: '王' });
    for (const text of ['出 3 张 尖', '出３张尖', '出', '出王王王王', '出百 搭', '聊天', '出王 {@2}', '出王[CQ:at,qq=3]'])
      expect(p(text)).toBeNull();
    expect(game.parseCommand(next(seat, 3), '出王', 'group')).toBeNull();
    expect(game.parseCommand(seat, '出王', 'private')).toBeNull();
    arrange(g, ['王']);
    await play(g, '王');
    for (const text of ['质疑', '开！', '骗子']) expect(game.parseCommand(cur(g.rec), text, 'group')).toEqual({ action: 'challenge' });
    for (const text of ['放过', '信', '过']) expect(game.parseCommand(cur(g.rec), text, 'group')).toEqual({ action: 'trust' });
    expect(game.parseCommand(cur(g.rec), '出王', 'group')).toBeNull();
  });

  it('真人手牌只私发本人，轮到时私发完整手牌和指令，出牌后更新', async () => {
    const g = await newGame({ humans: 3 });
    const seat = cur(g.rec);
    for (const d of g.rec.outbox) {
      const t = d.target;
      if (t.type === 'group') expect(d.text).not.toContain('你的手牌');
      else if (d.text.includes('你的手牌')) {
        const owner = g.rec.players.find((p) => p.id === t.userId)!;
        expect(t.seat).toBe(owner.seat);
        expect(d.text).toContain(sorted(g.rec.state.hands[String(owner.seat)]!).join(' '));
      }
    }
    expect(g.rec.outbox.some((d) => d.target.type === 'private' && d.target.seat === seat && d.text.includes('请在群里发送'))).toBe(true);
    arrange(g, ['后', '王']);
    await play(g, '后');
    expect(g.rec.outbox.some((d) => d.target.type === 'private' && d.target.seat === seat && d.text.includes('你的手牌：王'))).toBe(true);
    expect(instance(g).privateView(seat).hand).toEqual(['王']);
    expect(g.rec.log.filter((l) => l.kind === 'hand').every((l) => l.audience.type === 'seats' && l.audience.seats.length === 1)).toBe(true);
    expect(g.rec.log.filter((l) => l.kind === 'play').at(-1)!.data).toEqual({ seat, count: 1, auto: false });
    expect(g.rec.log.some((l) => l.kind === 'reveal')).toBe(false);
    noBulletLeaks(g);
  });

  it('改变秘密不影响公开视图、本人视图或 randomAction；视图不返回状态引用', async () => {
    const g = await newGame();
    for (const respond of [false, true]) {
      if (respond) await play(g, g.rec.state.hands[String(cur(g.rec))]![0]!);
      const game = instance(g), seat = cur(g.rec);
      const copy = JSON.parse(JSON.stringify(g.rec)) as Rec;
      const other = new BluffTavernGame(copy, { now: g.clock.now, rng: new SeededRng(13) });
      for (const gun of Object.values(copy.state.revolvers)) gun.bulletPosition = (gun.bulletPosition + 1) % 6;
      for (const p of g.rec.players) expect(other.privateView(p.seat)).toEqual(game.privateView(p.seat));
      for (const [s, hand] of Object.entries(copy.state.hands)) if (Number(s) !== seat) copy.state.hands[s] = hand.map(() => '百搭');
      if (copy.state.lastPlay) copy.state.lastPlay.cards = copy.state.lastPlay.cards.map(() => '百搭');
      copy.state.stock = copy.state.stock.map(() => '百搭');
      copy.state.discard = copy.state.discard.map(() => '百搭');
      expect(other.publicView()).toEqual(game.publicView());
      expect(other.privateView(seat)).toEqual(game.privateView(seat));
      expect(other.randomAction(seat)).toEqual(game.randomAction(seat));
      const hand = game.privateView(seat).hand as Card[];
      hand.length = 0;
      expect(g.rec.state.hands[String(seat)]!.length).toBeGreaterThan(0);
    }
  });

  it('昵称和错误消息不允许注入引擎 @ 或 CQ 码', async () => {
    const g = await newGame();
    g.rec.players[0]!.name = '坏\n{@2}[CQ:at,qq=9]\u0001';
    instance(g).start();
    expect(g.rec.players[0]!.name).not.toMatch(/\n|\{@|\[CQ:|\u0001/u);
    g.rec.phase!.openedAt = g.clock.now();
    let message = '';
    try { instance(g).onAction(cur(g.rec), { action: '{@2}[CQ:at,qq=9]' }, { via: 'agent' }); }
    catch (error) { message = (error as Error).message; }
    expect(message).not.toBe('');
    expect(message).not.toMatch(/\{@|\[CQ:/u);
  });
});

describe('诈牌酒馆：恢复与完整对局', () => {
  it('已提交但未结算的动作经过 JSON 往返、新实例恢复后继续', async () => {
    const g = await newGame();
    arrange(g, ['王', '百搭']);
    for (const gun of Object.values(g.rec.state.revolvers)) gun.bulletPosition = 5;
    instance(g).onAction(cur(g.rec), { action: 'play', card: '王 百搭' }, { via: 'agent' });
    const rec = JSON.parse(JSON.stringify(g.rec)) as Rec;
    const restored = new BluffTavernGame(rec, { now: g.clock.now, rng: new SeededRng(31) });
    restored.advance();
    expect(rec.phase!.key).toBe('respond');
    expect(rec.state.lastPlay!.cards).toEqual(['王', '百搭']);
    const challenger = cur(rec);
    rec.phase!.openedAt = g.clock.now();
    restored.onAction(challenger, { action: 'challenge' }, { via: 'agent' });
    restored.advance();
    expect(rec.round).toBe(2);
    expect(rec.state.revolvers[String(challenger)]!.shots).toBe(1);
    expect(cur(rec)).toBe(challenger);
    conserved(rec);
  });

  it('2～6 人、不同发牌数及弹仓数的 75 局随机游戏均结束，全程 20 张牌守恒', async () => {
    for (let i = 0; i < 75; i++) {
      const g = await newGame({ n: 2 + i % 5, humans: i % 9 === 0 ? 1 : 0, seed: `bt-${i}`,
        options: { chambers: 2 + Math.floor(i / 5) % 5, start_cards: 3 + Math.floor(i / 25) } });
      const positions = Object.values(g.rec.state.revolvers).map((gun) => gun.bulletPosition);
      const steps = await playToEnd(g.manager, g.gameId, { referee: REF, clock: g.clock, maxSteps: 20000,
        onStep: (rec) => {
          conserved(rec as Rec);
          expect(Object.keys(rec.phase?.pending ?? {}).length).toBeLessThanOrEqual(1);
          expect(Object.values(g.rec.state.revolvers).map((gun) => gun.bulletPosition)).toEqual(positions);
        },
      });
      expect(steps).toBeLessThan(20000);
      expect(g.rec.status).toBe('ended');
      expect(g.rec.result!.winnerSeats).toHaveLength(1);
      expect(g.rec.players.filter((p) => p.alive).map((p) => p.seat)).toEqual(g.rec.result!.winnerSeats);
      conserved(g.rec);
      noBulletLeaks(g);
    }
  }, 120_000);
});
