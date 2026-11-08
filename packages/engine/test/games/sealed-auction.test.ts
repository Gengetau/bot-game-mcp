import { describe, expect, it, vi } from 'vitest';
import type { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { GameRecord, Seat } from '../../src/core/types.js';
import {
  SealedAuctionGame,
  sealedAuctionDefinition,
  type SealedAuctionOptions,
  type SealedAuctionState,
} from '../../src/games/sealed-auction/index.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame, type FakeClock } from '../helpers.js';

interface TestGame {
  manager: GameManager;
  clock: FakeClock;
  gameId: string;
  rec: GameRecord<SealedAuctionState, SealedAuctionOptions>;
}

async function newGame(
  opts: { n?: number; options?: Record<string, unknown>; seed?: number | string; humans?: number } = {},
): Promise<TestGame> {
  const { manager, clock } = setup(opts.seed ?? 1);
  const n = opts.n ?? 3;
  const players = Array.from({ length: n - (opts.humans ?? 0) }, (_, i) => bot(i + 1));
  const humans = Array.from({ length: opts.humans ?? 0 }, (_, i) => human(i + 1));
  const { gameId, rec } = startGame(manager, 'sealed_auction', {
    players,
    humans,
    referee: REF,
    options: { random_seats: false, ...opts.options },
  });
  await manager.refereeStep(REF, gameId);
  return { manager, clock, gameId, rec: rec as GameRecord<SealedAuctionState, SealedAuctionOptions> };
}

/** 视图、解析和单元测试使用新实例，避免依赖管理器的私有方法。 */
function gameOf(g: TestGame): SealedAuctionGame {
  return new SealedAuctionGame(g.rec, { now: g.clock.now, rng: new SeededRng('auction-test') });
}

function submit(g: TestGame, seat: Seat, amount: number): void {
  const p = g.rec.players.find((x) => x.seat === seat)!;
  const input = { action: 'bid', number: amount };
  if (p.kind === 'human') {
    g.manager.relayHumanMessage(REF, g.gameId, { userId: p.id, text: '', channel: 'private', action: input });
  } else {
    g.manager.act(identityOf(g.rec, seat), g.gameId, input);
  }
}

async function bidRound(g: TestGame, bids: readonly number[]): Promise<void> {
  for (const [i, p] of g.rec.players.entries()) submit(g, p.seat, bids[i]!);
  await g.manager.refereeStep(REF, g.gameId);
}

describe('sealed auction: setup', () => {
  it('提供默认选项、人数范围与原创规则，并拒绝越界选项', () => {
    expect(sealedAuctionDefinition.optionsSchema.parse({})).toMatchObject({
      start_coins: 100,
      rounds: 6,
      price: 'first',
      bid_timeout_s: 60,
    });
    expect(sealedAuctionDefinition.minPlayers).toBe(3);
    expect(sealedAuctionDefinition.maxPlayers).toBe(8);
    expect(sealedAuctionDefinition.rules).toContain('原创玩法');
    for (const options of [
      { start_coins: 49 },
      { start_coins: 1001 },
      { start_coins: 100.5 },
      { rounds: 2 },
      { rounds: 13 },
      { price: 'third' },
    ]) {
      expect(sealedAuctionDefinition.optionsSchema.safeParse(options).success).toBe(false);
    }
  });

  it('开局生成全部拍品（名字不重复），每人有独立估价和同时出价待办', async () => {
    const g = await newGame({ n: 8, options: { rounds: 12, start_coins: 50 } });
    expect(g.rec.state.items).toHaveLength(12);
    expect(new Set(g.rec.state.items.map((i) => i.name)).size).toBe(12);
    for (const item of g.rec.state.items) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(item.value)).toBe(true);
      expect(item.value).toBeGreaterThanOrEqual(10);
      expect(item.value).toBeLessThanOrEqual(60);
    }
    const value = g.rec.state.items[0]!.value;
    const game = gameOf(g);
    for (const p of g.rec.players) {
      const estimate = game.privateView(p.seat).estimate as number;
      expect(Number.isInteger(estimate)).toBe(true);
      expect(estimate).toBeGreaterThanOrEqual(Math.max(0, value - 15));
      expect(estimate).toBeLessThanOrEqual(value + 15);
      expect(g.rec.state.coins[String(p.seat)]).toBe(50);
      expect(g.rec.phase!.pending[String(p.seat)]!.channel).toBe('private');
    }
    expect(pendingSeats(g.rec)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(g.rec.phase).toMatchObject({ key: 'bid', secret: true, timeoutMs: 60_000 });
  });
});

describe('sealed auction: secrecy', () => {
  it('其他座位的视图和公开视图不包含我的出价、估价或未揭晓拍品', async () => {
    const g = await newGame({ options: { start_coins: 1000 } });
    const game = gameOf(g);
    // 使用合法且不与其他公开数字重合的值，避免字符串检查误报。
    g.rec.state.items[0]!.value = 60;
    g.rec.state.items[1]!.name = '尚未公布的测试拍品';
    g.rec.phase!.data.estimates = { '1': 73, '2': 47, '3': 58 };
    const phase = g.rec.phase!;
    const before = JSON.stringify(game.publicView());
    const otherBefore = JSON.stringify(game.privateView(2));
    submit(g, 1, 937);

    expect(g.rec.phase).toBe(phase);
    expect(g.rec.phase).toMatchObject({ secret: true, title: '第1轮·密封出价', timeoutMs: 60_000 });
    expect(g.rec.state.history).toHaveLength(0);
    expect(g.rec.state.coins['1']).toBe(1000);
    expect(game.privateView(1)).toMatchObject({ estimate: 73, bid: 937 });
    expect(JSON.stringify(game.publicView())).toBe(before);
    expect(JSON.stringify(game.privateView(2))).toBe(otherBefore);
    for (const seat of [2, 3]) {
      const view = JSON.stringify({ public: game.publicView(), private: game.privateView(seat) });
      expect(view).not.toContain('937');
      expect(view).not.toContain('73');
      expect(view).not.toContain('尚未公布的测试拍品');
    }
    expect(before).not.toContain('"value":');
    expect(before).not.toContain('937');
    expect(before).not.toContain('73');

    // 不按座位顺序提交也合法；最后一人提交前不能结算。
    submit(g, 3, 2);
    expect(g.rec.state.history).toHaveLength(0);
    submit(g, 2, 1);
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.rec.state.history[0]!.winner).toBe(1);
    expect(JSON.stringify(game.publicView())).toContain('937');
  });

  it('估价只写本人私密日志，真人估价只投递到本人的私聊', async () => {
    const g = await newGame({ humans: 1 });
    const appraisals = g.rec.log.filter((l) => l.kind === 'appraisal');
    expect(appraisals).toHaveLength(3);
    for (const log of appraisals) {
      expect(log.audience.type).toBe('seats');
      if (log.audience.type !== 'seats') throw new Error('估价不应公开');
      expect(log.audience.seats).toHaveLength(1);
      const seat = log.audience.seats[0]!;
      expect(log.text).toContain(`你的鉴定估价：${g.rec.phase!.data.estimates[String(seat)]}`);
    }
    const dms = g.rec.outbox.filter((d) => d.target.type === 'private' && d.text.includes('你的鉴定估价：'));
    expect(dms).toHaveLength(1);
    const owner = g.rec.players.find((p) => p.kind === 'human')!;
    expect(dms[0]!.target).toMatchObject({ type: 'private', userId: owner.id, seat: owner.seat });
    submit(g, owner.seat, 17);
    expect(
      g.rec.outbox.some(
        (d) => d.target.type === 'private' && d.target.userId === owner.id && d.text.includes('你的出价已密封：17'),
      ),
    ).toBe(true);
    for (const log of g.rec.log.filter((l) => l.audience.type === 'public')) {
      expect(log.text).not.toContain('你的鉴定估价：');
      expect(log.text).not.toContain('你的出价已密封：');
    }
    for (const delivery of g.rec.outbox.filter((d) => d.target.type === 'group')) {
      expect(delivery.text).not.toContain('你的鉴定估价：');
      expect(delivery.text).not.toContain('你的出价已密封：');
    }
  });
});

describe('sealed auction: settlement', () => {
  it.each([
    { price: 'first', bids: [40, 25, 10], paid: 40 },
    { price: 'second', bids: [40, 25, 10], paid: 25 },
    { price: 'first', bids: [40, 0, 0], paid: 40 },
    { price: 'second', bids: [40, 0, 0], paid: 0 },
  ])('$price 模式对 $bids 收取 $paid 金币', async ({ price, bids, paid }) => {
    const g = await newGame({ options: { price } });
    g.rec.state.items[0]!.value = 42;
    await bidRound(g, bids);
    expect(g.rec.state.history[0]).toMatchObject({ winner: 1, price: paid, value: 42, tied: [] });
    expect(g.rec.state.coins).toEqual({ '1': 100 - paid, '2': 100, '3': 100 });
    expect(g.rec.state.collections).toEqual({ '1': 42, '2': 0, '3': 0 });
    const text = g.rec.log.find((l) => l.kind === 'auction_result')!.text;
    for (const [i, p] of g.rec.players.entries()) expect(text).toContain(`${p.seat}号 ${p.name}：${bids[i]} 金币`);
    expect(text).toContain(`成交价 ${paid} 金币`);
    expect(text).toContain('真实价值揭晓：42');
  });

  it.each([0, 1])('并列时使用 RNG 抽签，第 %i 个候选人可以得标，公告说明抽签', async (index) => {
    const g = await newGame({ options: { price: 'second' } });
    const game = gameOf(g);
    for (const [seat, amount] of [
      [1, 30],
      [2, 30],
      [3, 5],
    ] as const) {
      game.onAction(seat, { action: 'bid', number: amount }, { via: 'agent' });
    }
    // 精确控制本次抽签，不用概率断言；后续估价仍使用真实的种子 RNG。
    const draw = vi.spyOn(game.rng, 'int').mockReturnValueOnce(index);
    try {
      game.advance();
      expect(draw).toHaveBeenNthCalledWith(1, 2);
      expect(g.rec.state.history[0]).toMatchObject({ winner: index + 1, tied: [1, 2], price: 30 });
      const text = g.rec.log.find((l) => l.kind === 'auction_result')!.text;
      expect(text).toContain('最高价并列');
      expect(text).toContain('程序随机抽签');
      expect(text).toContain(`${index + 1}号 Bot${index + 1} 得标`);
    } finally {
      draw.mockRestore();
    }
  });

  it('全部出价为 0 时流拍，不扣金币、不增加收藏，仍揭晓真实价值', async () => {
    const g = await newGame();
    g.rec.state.items[0]!.value = 35;
    await bidRound(g, [0, 0, 0]);
    expect(g.rec.state.history[0]).toMatchObject({ winner: null, price: 0, value: 35, tied: [] });
    expect(g.rec.state.coins).toEqual({ '1': 100, '2': 100, '3': 100 });
    expect(g.rec.state.collections).toEqual({ '1': 0, '2': 0, '3': 0 });
    const text = g.rec.log.find((l) => l.kind === 'auction_result')!.text;
    expect(text).toContain('流拍');
    expect(text).toContain('真实价值揭晓：35');
    expect(text).not.toContain('抽签');
    expect(g.rec.round).toBe(2);
  });
});

describe('sealed auction: validation and commands', () => {
  it('拒绝负数、超预算、非整数及缺失出价，且不消耗待办', async () => {
    const g = await newGame();
    for (const amount of [-1, 101, NaN, Infinity]) expect(() => submit(g, 1, amount)).toThrow();
    // 引擎入口会把小数取整后再交给游戏；直接调用游戏时非整数仍然拒绝
    expect(() => gameOf(g).onAction(1, { action: 'bid', number: 1.5 }, { via: 'agent' })).toThrow(/整数/);
    expect(() => g.manager.act(identityOf(g.rec, 1), g.gameId, { action: 'bid' })).toThrow();
    expect(g.rec.phase!.data.bids).toEqual({});
    expect(pendingSeats(g.rec)).toEqual([1, 2, 3]);
    submit(g, 1, 10);
    expect(() => submit(g, 1, 20)).toThrow();
    expect(g.rec.phase!.data.bids['1']).toEqual({ amount: 10, auto: false });
    expect(g.rec.state.coins['1']).toBe(100);
  });

  it('按当前余额限制后续出价，金币为 0 时仍有待办且随机动作只能出 0', async () => {
    const g = await newGame();
    await bidRound(g, [100, 0, 0]);
    expect(g.rec.state.coins['1']).toBe(0);
    expect(pendingSeats(g.rec)).toEqual([1, 2, 3]);
    expect(g.rec.phase).toMatchObject({ key: 'bid', secret: true, timeoutMs: 60_000 });
    expect(gameOf(g).randomAction(1)).toEqual({ action: 'bid', number: 0 });
    expect(() => submit(g, 1, 1)).toThrow();
    submit(g, 1, 0);
    expect(gameOf(g).randomAction(1)).toBeNull();
  });

  it('只解析私聊出价，也拒绝通过群消息结构化转发来绕过限制', async () => {
    const g = await newGame({ humans: 1 });
    const game = gameOf(g);
    const owner = g.rec.players.find((p) => p.kind === 'human')!;
    const parse = (text: string) => game.parseCommand(owner.seat, text, 'private');
    expect(parse('出价二十')).toEqual({ action: 'bid', number: 20 });
    expect(parse('３５')).toEqual({ action: 'bid', number: 35 });
    for (const text of ['过', '放弃', '不出']) expect(parse(text)).toEqual({ action: 'bid', number: 0 });
    expect(parse('这件拍品真好看')).toBeNull();
    expect(game.parseCommand(owner.seat, '出价20', 'group')).toBeNull();
    expect(() => game.onAction(owner.seat, { action: 'bid', number: 20 }, { via: 'relay', channel: 'group' })).toThrow(
      /私聊/,
    );
    expect(g.rec.phase!.data.bids).toEqual({});
    g.manager.relayHumanMessage(REF, g.gameId, { userId: owner.id, text: '出价二十', channel: 'private' });
    expect(g.rec.phase!.data.bids[String(owner.seat)]).toEqual({ amount: 20, auto: false });
    expect(parse('出价30')).toBeNull();
  });
});

describe('sealed auction: timeouts and persistence', () => {
  it('截止前不提前结算，截止后只把未提交者的出价补为 0', async () => {
    const g = await newGame({ options: { bid_timeout_s: 30 } });
    submit(g, 1, 12);
    const phase = g.rec.phase;
    g.clock.advance(29_000);
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.rec.phase).toBe(phase);
    expect(g.rec.state.history).toHaveLength(0);
    g.clock.advance(2_000);
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.rec.state.history[0]).toMatchObject({
      winner: 1,
      price: 12,
      bids: [
        { seat: 1, amount: 12, auto: false },
        { seat: 2, amount: 0, auto: true },
        { seat: 3, amount: 0, auto: true },
      ],
    });
    expect(g.rec.log.some((l) => l.kind === 'auction_result' && l.text.includes('超时视为 0'))).toBe(true);
  });

  it('全员一直超时也能结束，所有轮次流拍且全员共同获胜', async () => {
    const g = await newGame({ options: { rounds: 3, bid_timeout_s: 30 } });
    for (let round = 0; round < 3; round++) {
      await g.manager.refereeStep(REF, g.gameId);
      g.clock.advance(31_000);
      await g.manager.refereeStep(REF, g.gameId);
    }
    expect(g.rec.status).toBe('ended');
    expect(g.rec.state.history).toHaveLength(3);
    for (const result of g.rec.state.history) {
      expect(result.winner).toBeNull();
      expect(result.bids.every((b) => b.amount === 0 && b.auto)).toBe(true);
    }
    expect(g.rec.result!.winnerSeats).toEqual([1, 2, 3]);
  });

  it('JSON 往返后，新实例能继续完成已经部分提交的拍卖', async () => {
    const g = await newGame();
    submit(g, 1, 7);
    const rec = JSON.parse(JSON.stringify(g.rec)) as GameRecord<SealedAuctionState, SealedAuctionOptions>;
    const restored = new SealedAuctionGame(rec, { now: g.clock.now, rng: new SeededRng('restore') });
    expect(restored.privateView(1)).toEqual(gameOf(g).privateView(1));
    restored.advance();
    expect(rec.state.history).toHaveLength(0);
    restored.onAction(2, { action: 'bid', number: 0 }, { via: 'agent' });
    restored.onAction(3, { action: 'bid', number: 0 }, { via: 'agent' });
    restored.advance();
    expect(rec.state.history[0]).toMatchObject({ winner: 1, price: 7 });
    expect(rec.state.coins['1']).toBe(93);
    expect(rec.round).toBe(2);
    expect(g.rec.state.history).toHaveLength(0);
  });
});

describe('sealed auction: final scores and full games', () => {
  it('终局按金币加收藏计分，公告列出每人的明细，并列最高分共同获胜', async () => {
    const g = await newGame({ options: { rounds: 3, price: 'first' } });
    for (const [i, value] of [30, 40, 50].entries()) g.rec.state.items[i]!.value = value;
    await bidRound(g, [20, 10, 0]);
    await bidRound(g, [0, 15, 5]);
    await bidRound(g, [5, 0, 25]);
    expect(g.rec.status).toBe('ended');
    expect(g.rec.phase).toBeNull();
    expect(g.rec.state.coins).toEqual({ '1': 80, '2': 85, '3': 75 });
    expect(g.rec.state.collections).toEqual({ '1': 30, '2': 40, '3': 50 });
    expect(g.rec.result!.winnerSeats).toEqual([2, 3]);
    expect(gameOf(g).publicView()).toMatchObject({
      current_item: null,
      players: [
        { seat: 1, coins: 80, collection_value: 30, score: 110 },
        { seat: 2, coins: 85, collection_value: 40, score: 125 },
        { seat: 3, coins: 75, collection_value: 50, score: 125 },
      ],
    });
    const text = g.rec.log.find((l) => l.kind === 'game_over')!.text;
    for (const line of ['金币 80，收藏 30，总分 110', '金币 85，收藏 40，总分 125', '金币 75，收藏 50，总分 125']) {
      expect(text).toContain(line);
    }
    expect(gameOf(g).randomAction(1)).toBeNull();
  });

  it('不同人数、预算、轮数和价格模式的随机完整对局都有正确赢家', async () => {
    for (let i = 0; i < 24; i++) {
      const { manager, clock } = setup(`sa-${i}`);
      const n = 3 + (i % 6);
      const nh = i % 4 === 0 ? 1 : 0;
      const rounds = 3 + (i % 10);
      const { gameId, rec } = startGame(manager, 'sealed_auction', {
        players: Array.from({ length: n - nh }, (_, k) => bot(k + 1)),
        humans: Array.from({ length: nh }, (_, k) => human(k + 1)),
        referee: REF,
        options: { rounds, start_coins: 50 + i * 35, price: i % 2 === 0 ? 'first' : 'second' },
      });
      const steps = await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 1000 });
      expect(steps).toBeLessThan(1000);
      expect(rec.status).toBe('ended');
      const state = rec.state as SealedAuctionState;
      expect(state.history).toHaveLength(rounds);
      const scores = rec.players.map((p) => ({
        seat: p.seat,
        score: state.coins[String(p.seat)]! + state.collections[String(p.seat)]!,
      }));
      const best = Math.max(...scores.map((s) => s.score));
      expect(rec.result!.winnerSeats.length).toBeGreaterThan(0);
      expect(rec.result!.winnerSeats).toEqual(scores.filter((s) => s.score === best).map((s) => s.seat));
      for (const coins of Object.values(state.coins)) {
        expect(Number.isInteger(coins)).toBe(true);
        expect(coins).toBeGreaterThanOrEqual(0);
      }
    }
  }, 60_000);
});
