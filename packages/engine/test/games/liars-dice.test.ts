import { describe, expect, it } from 'vitest';
import type { GameManager } from '../../src/core/manager.js';
import type { GameRecord, Identity, Seat } from '../../src/core/types.js';
import { FakeClock, REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

async function newGame(opts: { n?: number; options?: Record<string, unknown>; seed?: number | string; humans?: number } = {}) {
  const { manager, clock } = setup(opts.seed ?? 1);
  const n = opts.n ?? 3;
  const players = Array.from({ length: n - (opts.humans ?? 0) }, (_, i) => bot(i + 1));
  const humans = Array.from({ length: opts.humans ?? 0 }, (_, i) => human(i + 1));
  const { gameId, rec } = startGame(manager, 'liars_dice', { players, humans, referee: REF, options: { random_seats: false, ...opts.options } });
  await manager.refereeStep(REF, gameId);
  return { manager, clock, gameId, rec };
}

const cur = (rec: GameRecord): Seat => rec.state.current;
const who = (rec: GameRecord, s: Seat): Identity => identityOf(rec, s);
function setDice(rec: GameRecord, dice: Record<number, number[]>) {
  for (const [s, d] of Object.entries(dice)) rec.state.dice[s] = d;
}
function submit(m: GameManager, id: string, rec: GameRecord, input: { action: string; quantity?: number; face?: number }) {
  const p = rec.players.find((x) => x.seat === cur(rec))!;
  if (p.kind === 'human') m.relayHumanMessage(REF, id, { userId: p.id, text: '', channel: 'group', action: input });
  else m.act(who(rec, p.seat), id, input);
}
async function bid(m: GameManager, id: string, rec: GameRecord, q: number, f: number) {
  submit(m, id, rec, { action: 'bid', quantity: q, face: f });
  await m.refereeStep(REF, id);
}
async function challenge(m: GameManager, id: string, rec: GameRecord) {
  submit(m, id, rec, { action: 'challenge' });
  await m.refereeStep(REF, id);
}
const bidErr = (m: GameManager, id: string, rec: GameRecord, q: number, f: number) =>
  () => m.act(who(rec, cur(rec)), id, { action: 'bid', quantity: q, face: f });

describe('liars dice: bidding', () => {
  it('enforces min open quantity (auto = alive players) and the quantity cap', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 4 });
    expect(bidErr(m, id, rec, 3, 2)).toThrow(/至少要 4/);
    expect(bidErr(m, id, rec, 21, 2)).toThrow(/最多叫 20/);
    expect(bidErr(m, id, rec, 4, 7)).toThrow(/1~6/);
    expect(() => m.act(who(rec, cur(rec)), id, { action: 'challenge' })).toThrow();
    await bid(m, id, rec, 4, 2);
    expect(rec.state.bid).toMatchObject({ quantity: 4, face: 2 });
  });

  it('custom min_open_quantity is capped at total dice', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 2, options: { min_open_quantity: 5, dice_per_player: 2 } });
    expect(bidErr(m, id, rec, 3, 2)).toThrow(/至少要 4/); // capped to 4 total dice
    await bid(m, id, rec, 4, 3);
  });

  it('orders faces 2<3<4<5<6<1 and allows jumping to 1s', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 3 });
    await bid(m, id, rec, 3, 5);
    expect(bidErr(m, id, rec, 3, 5)).toThrow(/最小可叫 3个6/);
    expect(bidErr(m, id, rec, 3, 4)).toThrow(/更大/);
    expect(bidErr(m, id, rec, 2, 1)).toThrow(/更大/);
    await bid(m, id, rec, 3, 1); // jump over 6 straight to 1s
    expect(bidErr(m, id, rec, 3, 6)).toThrow(/最小可叫 4个2/);
    await bid(m, id, rec, 4, 2);
  });

  it('only the current player may act', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 3 });
    const other = [1, 2, 3].find((s) => s !== cur(rec))!;
    expect(() => m.act(who(rec, other), id, { action: 'bid', quantity: 3, face: 2 })).toThrow();
  });

  it('turn passes clockwise', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 3 });
    const a = cur(rec);
    await bid(m, id, rec, 3, 2);
    expect(cur(rec)).toBe((a % 3) + 1);
  });
});

describe('liars dice: challenge', () => {
  async function scenario(dice: Record<number, number[]>, q: number, f: number, options: Record<string, unknown> = {}) {
    const g = await newGame({ n: 3, options: { dice_per_player: 3, ...options } });
    setDice(g.rec, dice);
    const bidder = cur(g.rec);
    await bid(g.manager, g.gameId, g.rec, q, f);
    const challenger = cur(g.rec);
    await challenge(g.manager, g.gameId, g.rec);
    return { ...g, bidder, challenger };
  }
  const D = { 1: [1, 2, 3], 2: [1, 5, 5], 3: [4, 4, 6] };

  it('counts wild ones: bid holds, challenger loses a life', async () => {
    // 5s: two 5s + two 1s = 4
    const g = await scenario(D, 4, 5);
    expect(g.rec.state.results.at(-1)).toMatchObject({ count: 4, loser: g.challenger });
    expect(g.rec.state.lives[String(g.challenger)]).toBe(2);
    expect(g.rec.state.lives[String(g.bidder)]).toBe(3);
  });

  it('bid fails when short: bidder loses and starts next round', async () => {
    const g = await scenario(D, 5, 5);
    expect(g.rec.state.results.at(-1)).toMatchObject({ count: 4, loser: g.bidder });
    expect(g.rec.state.lives[String(g.bidder)]).toBe(2);
    expect(g.rec.state.starter).toBe(g.bidder);
    expect(cur(g.rec)).toBe(g.bidder);
    expect(g.rec.round).toBe(2);
  });

  it('ignores wild ones when disabled', async () => {
    const g = await scenario(D, 4, 5, { wild_ones: false });
    expect(g.rec.state.results.at(-1)).toMatchObject({ count: 2, loser: g.bidder });
  });

  it('bidding 1s counts only 1s', async () => {
    const D1 = { 1: [1, 1, 3], 2: [1, 5, 5], 3: [4, 4, 6] };
    const g = await scenario(D1, 3, 1);
    expect(g.rec.state.results.at(-1)).toMatchObject({ count: 3, loser: g.challenger });
    const h = await scenario(D1, 4, 1);
    expect(h.rec.state.results.at(-1)).toMatchObject({ count: 3, loser: h.bidder });
  });

  it('eliminates at 0 lives; next starter is the next alive seat; last survivor wins', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 3, options: { lives: 1, dice_per_player: 2 } });
    setDice(rec, { 1: [2, 2], 2: [3, 3], 3: [4, 4] });
    const bidder = cur(rec);
    await bid(m, id, rec, 6, 6);
    await challenge(m, id, rec);
    expect(rec.players.find((p) => p.seat === bidder)!.alive).toBe(false);
    expect(rec.state.eliminated).toEqual([bidder]);
    expect(cur(rec)).toBe((bidder % 3) + 1);
    expect(rec.status).toBe('running');
    // total dice now 4; min open = 2
    expect(bidErr(m, id, rec, 1, 2)).toThrow(/至少要 2/);
    setDice(rec, Object.fromEntries(rec.players.filter((p) => p.alive).map((p) => [p.seat, [2, 2]])));
    await bid(m, id, rec, 4, 6);
    await challenge(m, id, rec);
    expect(rec.status).toBe('ended');
    expect(rec.result!.winnerSeats).toHaveLength(1);
    expect(rec.result!.reveal.some((r) => r.identity.includes('冠军'))).toBe(true);
  });

  it('challenge reveals all dice publicly', async () => {
    const g = await scenario(D, 5, 5);
    const txt = g.rec.log.filter((l) => l.kind === 'challenge').map((l) => l.text).join('\n');
    expect(txt).toContain('1 2 3');
    expect(txt).toContain('4 4 6');
  });
});

describe('liars dice: timeouts', () => {
  it('auto opens with minimal bid, then auto challenges', async () => {
    const { manager: m, clock, gameId: id, rec } = await newGame({ n: 3, options: { turn_timeout_s: 30 } });
    const first = cur(rec);
    clock.advance(31_000);
    await m.refereeStep(REF, id);
    expect(rec.state.bid).toMatchObject({ seat: first, quantity: 3, face: 2 });
    expect(rec.state.history[0]!.auto).toBe(true);
    await m.refereeStep(REF, id);
    clock.advance(31_000);
    await m.refereeStep(REF, id);
    expect(rec.state.results).toHaveLength(1);
    expect(rec.state.results[0]!.challenger).toBe((first % 3) + 1);
    expect(rec.log.some((l) => l.text.includes('超时，程序代为操作'))).toBe(true);
  });
});

describe('liars dice: command parsing', () => {
  it('parses bids and challenges, ignores chatter', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 3 });
    const game = (m as any).inst(rec);
    const s = cur(rec);
    const p = (t: string) => game.parseCommand(s, t, 'group');
    expect(p('3个5')).toEqual({ action: 'bid', quantity: 3, face: 5 });
    expect(p('三个五')).toEqual({ action: 'bid', quantity: 3, face: 5 });
    expect(p('叫4个6')).toEqual({ action: 'bid', quantity: 4, face: 6 });
    // 较长前缀不能被较短前缀抢先匹配（叫到 / 加到 / 跟到）
    expect(p('叫到3个5')).toEqual({ action: 'bid', quantity: 3, face: 5 });
    expect(p('我叫到三个五')).toEqual({ action: 'bid', quantity: 3, face: 5 });
    expect(p('加到4个6')).toEqual({ action: 'bid', quantity: 4, face: 6 });
    expect(p('跟到4个6')).toEqual({ action: 'bid', quantity: 4, face: 6 });
    expect(p('5 个 1')).toEqual({ action: 'bid', quantity: 5, face: 1 });
    expect(p('3个五点')).toEqual({ action: 'bid', quantity: 3, face: 5 });
    expect(p('4 6')).toEqual({ action: 'bid', quantity: 4, face: 6 });
    expect(p('十个两点')).toEqual({ action: 'bid', quantity: 10, face: 2 });
    expect(p('两个幺')).toEqual({ action: 'bid', quantity: 2, face: 1 });
    expect(p('３个６')).toEqual({ action: 'bid', quantity: 3, face: 6 });
    for (const t of ['开', '开！', '劈', '不信', '我开']) expect(p(t)).toEqual({ action: 'challenge' });
    for (const t of ['哈哈哈', '这把好难', '你们太强了', '3', '']) expect(p(t)).toBeNull();
    const other = [1, 2, 3].find((x) => x !== s)!;
    expect(game.parseCommand(other, '3个5', 'group')).toBeNull();
    void id;
  });
});

describe('liars dice: secrecy', () => {
  it('dice never leak into public log or group deliveries before reveal; DMs go only to their owner', async () => {
    const { manager: m, gameId: id, rec } = await newGame({ n: 4, humans: 2, seed: 5 });
    const check = () => {
      const diceByRound = rec.state.dice as Record<string, number[]>;
      for (const l of rec.log) {
        if (l.audience.type === 'public') expect(l.text).not.toContain('你的骰子');
      }
      for (const d of rec.outbox) {
        if (d.target.type === 'group') expect(d.text).not.toContain('你的骰子');
        if (d.target.type === 'private') {
          const t = d.target as { userId: string; seat: number };
          const owner = rec.players.find((p) => p.id === t.userId)!;
          expect(owner.seat).toBe(t.seat);
          if (d.text.includes('你的骰子') && d.seq > 0 && rec.state.results.length === 0)
            expect(d.text).toContain(diceByRound[String(owner.seat)]!.join(' '));
        }
      }
      const view = JSON.stringify((m as any).inst(rec).publicView());
      // before any reveal there must be no dice in the public view
      if (rec.state.results.length === 0) expect(view).not.toContain('revealed_dice":{"');
    };
    check();
    await bid(m, id, rec, 4, 3);
    check();
    const dmsBefore = rec.outbox.filter((d) => d.target.type === 'private' && d.text.includes('你的骰子')).length;
    expect(dmsBefore).toBe(2); // two humans
    // the group announcement of a round never includes dice values of players
    const groupTexts = rec.outbox.filter((d) => d.target.type === 'group').map((d) => d.text).join('\n');
    expect(groupTexts).not.toContain('亮骰');
    await challenge(m, id, rec);
    check();
    expect(rec.log.some((l) => l.kind === 'challenge' && l.text.includes('亮骰'))).toBe(true);
    const priv = (m as any).inst(rec).privateView(1);
    expect(priv.dice).toEqual(rec.state.dice['1']);
  });
});

describe('liars dice: random full games', () => {
  it('250 random games end with exactly one winner', async () => {
    for (let i = 0; i < 250; i++) {
      const n = 2 + (i % 7);
      const nh = i % 3 === 0 ? Math.min(n, 1 + (i % 2)) : 0;
      const { manager, clock } = setup(`ld-${i}`);
      const players = Array.from({ length: n - nh }, (_, k) => bot(k + 1));
      const humans = Array.from({ length: nh }, (_, k) => human(k + 1));
      const options = i % 5 === 0 ? { lives: 2, dice_per_player: 2 + (i % 4), wild_ones: i % 2 === 0 } : { lives: 1 + (i % 3) };
      const { gameId, rec } = startGame(manager, 'liars_dice', { players, humans, referee: REF, options });
      const steps = await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 20000 });
      expect(steps).toBeLessThan(20000);
      expect(rec.status).toBe('ended');
      expect(rec.result!.winnerSeats).toHaveLength(1);
      expect(rec.players.filter((p) => p.alive)).toHaveLength(1);
      expect(rec.players.filter((p) => p.alive)[0]!.seat).toBe(rec.result!.winnerSeats[0]);
    }
  }, 120_000);
});
void FakeClock;
void pendingSeats;
