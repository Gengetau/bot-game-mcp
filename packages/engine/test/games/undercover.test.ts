import { describe, expect, it } from 'vitest';
import type { GameManager } from '../../src/core/manager.js';
import type { GameRecord, Seat } from '../../src/core/types.js';
import { GENERIC_PHRASES, WORD_BANK, undercoverDefinition } from '../../src/games/undercover/index.js';
import type { UndercoverState } from '../../src/games/undercover/index.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

type Rec = GameRecord<UndercoverState>;

const bots = (n: number) => Array.from({ length: n }, (_, i) => bot(i + 1));

function botGame(n: number, options: Record<string, unknown> = {}, seed: string | number = 1) {
  const { manager, clock } = setup(seed);
  const { gameId, rec } = startGame(manager, 'undercover', { players: bots(n), autoReferee: true, options });
  return { manager, clock, gameId, rec: rec as Rec };
}

function humanGame(n: number, options: Record<string, unknown> = {}, seed: string | number = 1) {
  const { manager, clock } = setup(seed);
  const { gameId, rec } = startGame(manager, 'undercover', {
    players: [],
    referee: REF,
    humans: Array.from({ length: n }, (_, i) => human(i + 1)),
    options,
  });
  return { manager, clock, gameId, rec: rec as Rec };
}

async function ready(manager: GameManager, clock: { advance(ms: number): void }, gameId: string) {
  const rec = manager.getRecord(gameId);
  for (let i = 0; i < 30; i++) {
    await manager.refereeStep(REF, gameId);
    if (rec.status !== 'running' || pendingSeats(rec).length > 0) return;
    clock.advance(5000);
  }
}

const say = (m: GameManager, rec: Rec, seat: Seat, text = '这个东西挺常见的') =>
  m.act(identityOf(rec, seat), rec.id, { action: 'speech', text });
const vote = (m: GameManager, rec: Rec, seat: Seat, target: Seat | null) =>
  m.act(identityOf(rec, seat), rec.id, target === null ? { action: 'skip' } : { action: 'vote', target });

/** 让所有人完成当前描述阶段直到进入投票（bot 局）。 */
function describeAll(m: GameManager, rec: Rec) {
  while (rec.status === 'running' && (rec.phase?.key === 'describe' || rec.phase?.key === 'pk_describe')) {
    say(m, rec, pendingSeats(rec)[0]!);
  }
}

/** 所有存活者投 target（target 自己弃票）。 */
function voteOut(m: GameManager, rec: Rec, target: Seat) {
  describeAll(m, rec);
  expect(rec.phase?.key).toBe('vote');
  for (const s of pendingSeats(rec)) vote(m, rec, s, s === target ? null : target);
}

const rolesOf = (rec: Rec, role: string) => rec.players.filter((p) => rec.state.roles[String(p.seat)] === role).map((p) => p.seat);

describe('undercover: setup', () => {
  it('registers with expected metadata', () => {
    expect(undercoverDefinition.type).toBe('undercover');
    expect(undercoverDefinition.name).toBe('谁是卧底');
    expect(undercoverDefinition.idPrefix).toBe('UC');
    expect(undercoverDefinition.minPlayers).toBe(4);
    expect(undercoverDefinition.maxPlayers).toBe(12);
    for (const a of ['谁是卧底', '卧底', 'undercover', 'spy']) expect(undercoverDefinition.aliases).toContain(a);
  });

  it('word bank is large, unique and well formed', () => {
    const all = Object.values(WORD_BANK).flat();
    expect(all.length).toBeGreaterThanOrEqual(150);
    expect(Object.keys(WORD_BANK).length).toBeGreaterThanOrEqual(8);
    const seen = new Set<string>();
    for (const [a, b] of all) {
      expect(a).not.toBe(b);
      const k = [a, b].sort().join('|');
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    const words = all.flat();
    for (const p of GENERIC_PHRASES) for (const w of words) expect(p.includes(w)).toBe(false);
  });

  it('assigns the right number of undercovers by player count', () => {
    for (let n = 4; n <= 12; n++) {
      const { rec } = botGame(n, {}, `n${n}`);
      const expected = n <= 6 ? 1 : n <= 10 ? 2 : 3;
      expect(rolesOf(rec, 'undercover')).toHaveLength(expected);
      expect(rolesOf(rec, 'blank')).toHaveLength(0);
      expect(rolesOf(rec, 'civilian')).toHaveLength(n - expected);
      expect(rec.status).toBe('running');
      expect(rec.phase?.key).toBe('describe');
    }
  });

  it('honours explicit undercover_count and rejects impossible ones', () => {
    const { rec } = botGame(9, { undercover_count: 3 });
    expect(rolesOf(rec, 'undercover')).toHaveLength(3);
    const { rec: r2 } = botGame(8, { undercover_count: '2' });
    expect(rolesOf(r2, 'undercover')).toHaveLength(2);
    expect(() => botGame(6, { undercover_count: 3 })).toThrow(/平民/);
    expect(() => botGame(4, { undercover_count: 2 })).toThrow(/平民/);
    expect(() => botGame(6, { blank_count: 1, undercover_count: 2 })).toThrow(/平民/);
  });

  it('blank only appears with 6+ players', () => {
    expect(rolesOf(botGame(5, { blank_count: 1 }).rec, 'blank')).toHaveLength(0);
    const { rec } = botGame(6, { blank_count: 1 });
    const blank = rolesOf(rec, 'blank');
    expect(blank).toHaveLength(1);
    expect(rec.state.words[String(blank[0])]).toBeNull();
  });

  it('uses custom word_pairs and randomly swaps sides', () => {
    const pairs = [['甲壳', '乙壳'], ['丙盒', '丁盒']];
    const seenCiv = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { rec } = botGame(5, { word_pairs: pairs }, `wp${i}`);
      const civ = rec.state.pair[0];
      const und = rec.state.pair[1];
      expect(pairs.some((p) => (p[0] === civ && p[1] === und) || (p[1] === civ && p[0] === und))).toBe(true);
      for (const p of rec.players) {
        const role = rec.state.roles[String(p.seat)];
        expect(rec.state.words[String(p.seat)]).toBe(role === 'civilian' ? civ : und);
      }
      seenCiv.add(civ);
    }
    expect(seenCiv.size).toBeGreaterThan(2);
  });

  it('respects category', () => {
    for (let i = 0; i < 15; i++) {
      const { rec } = botGame(4, { category: '动物' }, `cat${i}`);
      const words = new Set(WORD_BANK['动物']!.flat());
      expect(words.has(rec.state.pair[0])).toBe(true);
      expect(words.has(rec.state.pair[1])).toBe(true);
    }
    expect(() => botGame(4, { category: '不存在' })).toThrow();
  });
});

describe('undercover: secrecy', () => {
  it('private views never carry an identity label', () => {
    const { manager, rec } = botGame(7, { blank_count: 1 });
    for (const p of rec.players) {
      const you = JSON.stringify((manager.getView(identityOf(rec, p.seat), rec.id) as any).you);
      for (const label of ['卧底', '平民', 'undercover', 'civilian', 'role', '身份']) {
        expect(you.includes(label)).toBe(false);
      }
      const v = manager.getView(identityOf(rec, p.seat), rec.id) as any;
      const w = rec.state.words[String(p.seat)];
      if (w === null) {
        expect(v.you.blank).toBe(true);
        expect(v.you.word).toBeNull();
      } else expect(v.you.word).toBe(w);
    }
  });

  it('words never reach public log, group deliveries or other humans before the end', async () => {
    const { manager, clock } = setup('secret');
    const { gameId, rec } = startGame(manager, 'undercover', {
      players: [bot(1), bot(2), bot(3), bot(4)],
      humans: [human(1), human(2), human(3)],
      referee: REF,
      options: { blank_count: 1 },
    });
    const r = rec as Rec;
    const [wa, wb] = r.state.pair;
    const bad = (text: string) => text.includes(wa) || text.includes(wb);
    await playToEnd(manager, gameId, {
      referee: REF,
      clock,
      onStep: (g) => {
        if (g.status !== 'running') return;
        for (const e of g.log) if (e.audience.type !== 'seats') expect(bad(e.text)).toBe(false);
        for (const d of g.outbox) {
          if (d.target.type === 'group') expect(bad(d.text)).toBe(false);
          else {
            const seat = d.target.seat!;
            const mine = r.state.words[String(seat)];
            const other = [wa, wb].filter((w) => w !== mine);
            for (const o of other) expect(d.text.includes(o)).toBe(false);
          }
        }
      },
    });
    expect(rec.status).toBe('ended');
    const over = rec.log.find((e) => e.kind === 'game_over')!;
    expect(over.text).toContain(wa);
    expect(over.text).toContain(wb);
  });
});

describe('undercover: describing', () => {
  it('rejects a bot description containing its own word (case-insensitive) then accepts a rephrase', () => {
    const { manager, rec } = botGame(5, { word_pairs: [['Apple', 'Pear']] });
    const seat = pendingSeats(rec)[0]!;
    const word = rec.state.words[String(seat)]!;
    expect(() => say(manager, rec, seat, `我爱吃${word.toUpperCase()}真的`)).toThrow(/不能包含/);
    expect(() => say(manager, rec, seat, `${word.toLowerCase()}`)).toThrow(/不能包含/);
    expect(() => say(manager, rec, seat, '   ')).toThrow(/不能为空/);
    expect(pendingSeats(rec)).toEqual([seat]);
    say(manager, rec, seat, '很好吃的水果');
    expect(rec.state.rounds[0]!.descriptions).toHaveLength(1);
    expect(pendingSeats(rec)[0]).not.toBe(seat);
    const v = manager.getView(identityOf(rec, seat), rec.id) as any;
    expect(v.you.my_descriptions).toEqual(['很好吃的水果']);
  });

  it('allows own word when forbid_word is off', () => {
    const { manager, rec } = botGame(4, { forbid_word: false });
    const seat = pendingSeats(rec)[0]!;
    say(manager, rec, seat, `我的词是${rec.state.words[String(seat)]}`);
    expect(rec.state.rounds[0]!.descriptions).toHaveLength(1);
  });

  it('blank can say anything and goes through describing', () => {
    const { manager, rec } = botGame(6, { blank_count: 1 });
    const blank = rolesOf(rec, 'blank')[0]!;
    while (pendingSeats(rec)[0] !== blank) say(manager, rec, pendingSeats(rec)[0]!);
    say(manager, rec, blank, '嗯，大家都懂的');
    expect(rec.state.rounds[0]!.descriptions.at(-1)!.seat).toBe(blank);
  });

  it('speaking order starts at a random seat and goes clockwise', () => {
    const { manager, rec } = botGame(6, {}, 'order');
    const order: Seat[] = [];
    while (rec.phase?.key === 'describe') {
      order.push(pendingSeats(rec)[0]!);
      say(manager, rec, order.at(-1)!);
    }
    expect(order).toHaveLength(6);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBe(order[i - 1]! % 6 + 1);
  });

  it('timeout records a placeholder and moves on; missed votes count as abstain', () => {
    const { manager, clock, rec } = botGame(4);
    clock.advance(61_000);
    manager.tick();
    expect(rec.state.rounds[0]!.descriptions[0]).toMatchObject({ text: '（超时未发言）', auto: true });
    for (let i = 0; i < 3; i++) {
      clock.advance(61_000);
      manager.tick();
    }
    expect(rec.phase?.key).toBe('vote');
    clock.advance(46_000);
    manager.tick();
    expect(rec.round).toBe(2);
    expect(rec.state.rounds[0]!.result).toContain('全员弃票');
    expect(rec.players.every((p) => p.alive)).toBe(true);
  });

  it('next round starts after the eliminated seat', () => {
    const { manager, rec } = botGame(7, {}, 'next');
    const civ = rolesOf(rec, 'civilian')[0]!;
    voteOut(manager, rec, civ);
    expect(rec.round).toBe(2);
    const expectedFirst = rec.players.filter((p) => p.alive).map((p) => p.seat).find((s) => s > civ) ?? 1;
    expect(pendingSeats(rec)).toEqual([expectedFirst]);
  });
});

describe('undercover: voting', () => {
  it('eliminates the plurality target and reveals identity (not words)', () => {
    const { manager, rec } = botGame(6, {}, 'v1');
    const civ = rolesOf(rec, 'civilian')[0]!;
    voteOut(manager, rec, civ);
    expect(rec.players.find((p) => p.seat === civ)!.alive).toBe(false);
    const death = rec.log.find((e) => e.kind === 'death')!;
    expect(death.text).toContain('平民');
    expect(death.text).not.toContain(rec.state.pair[0]);
    expect(rec.state.rounds[0]!.votes).toHaveLength(6);
    const pub = manager.getView(bot(1), rec.id) as any;
    expect(pub.public.eliminated[0]).toMatchObject({ seat: civ, identity: '平民' });
    expect(pub.public.rounds[0].votes).toHaveLength(6);
  });

  it('can hide identities with reveal_on_elimination=false', () => {
    const { manager, rec } = botGame(6, { reveal_on_elimination: false });
    voteOut(manager, rec, rolesOf(rec, 'civilian')[0]!);
    const death = rec.log.find((e) => e.kind === 'death')!;
    expect(death.text).not.toMatch(/平民|卧底|白板/);
    expect((rec.state.eliminated[0] as any).identity).toBeUndefined();
  });

  it('validates vote targets', () => {
    const { manager, rec } = botGame(5);
    describeAll(manager, rec);
    const s = pendingSeats(rec)[0]!;
    expect(() => vote(manager, rec, s, s)).toThrow(/不能选择/);
    expect(() => vote(manager, rec, s, 99)).toThrow();
    expect(() => say(manager, rec, s)).toThrow();
  });

  it('all abstain => nobody out', () => {
    const { manager, rec } = botGame(5);
    describeAll(manager, rec);
    for (const s of pendingSeats(rec)) vote(manager, rec, s, null);
    expect(rec.round).toBe(2);
    expect(rec.players.every((p) => p.alive)).toBe(true);
  });

  it('tie => PK describe by tied players, PK vote only by others', () => {
    const { manager, rec } = botGame(6, {}, 'pk');
    describeAll(manager, rec);
    // 1 and 2 tied 2-2; 3..6 vote
    vote(manager, rec, 1, null);
    vote(manager, rec, 2, null);
    vote(manager, rec, 3, 1);
    vote(manager, rec, 4, 1);
    vote(manager, rec, 5, 2);
    vote(manager, rec, 6, 2);
    expect(rec.phase?.key).toBe('pk_describe');
    expect(pendingSeats(rec)).toEqual([1]);
    say(manager, rec, 1);
    expect(pendingSeats(rec)).toEqual([2]);
    say(manager, rec, 2);
    expect(rec.phase?.key).toBe('pk_vote');
    expect(pendingSeats(rec).sort()).toEqual([3, 4, 5, 6]);
    expect(() => vote(manager, rec, 3, 4)).toThrow(/不能选择/);
    vote(manager, rec, 3, 1);
    vote(manager, rec, 4, 1);
    vote(manager, rec, 5, 2);
    vote(manager, rec, 6, 2);
    // tie again => nobody out, next round
    expect(rec.round).toBe(2);
    expect(rec.players.every((p) => p.alive)).toBe(true);
    expect(rec.state.rounds[0]!.result).toContain('无人出局');
  });

  it('PK vote can eliminate one of the tied', () => {
    const { manager, rec } = botGame(6, {}, 'pk2');
    describeAll(manager, rec);
    vote(manager, rec, 1, null);
    vote(manager, rec, 2, null);
    vote(manager, rec, 3, 1);
    vote(manager, rec, 4, 1);
    vote(manager, rec, 5, 2);
    vote(manager, rec, 6, 2);
    say(manager, rec, 1);
    say(manager, rec, 2);
    vote(manager, rec, 3, 1);
    vote(manager, rec, 4, 1);
    vote(manager, rec, 5, 1);
    vote(manager, rec, 6, 2);
    if (rec.status === 'running') expect(rec.state.eliminated[0]!.seat).toBe(1);
    else expect(rec.state.eliminated.map((e) => e.seat)).toContain(1);
  });
});

describe('undercover: winning', () => {
  it('civilians win when all undercovers are out; full reveal', () => {
    const { manager, rec } = botGame(5, {}, 'w1');
    const uc = rolesOf(rec, 'undercover')[0]!;
    voteOut(manager, rec, uc);
    expect(rec.status).toBe('ended');
    expect(rec.result!.winnerTeam).toBe('平民');
    expect(rec.result!.winnerSeats.sort()).toEqual(rolesOf(rec, 'civilian').sort());
    expect(rec.result!.reveal).toHaveLength(5);
    const over = rec.log.find((e) => e.kind === 'game_over')!;
    expect(over.text).toContain(rec.state.pair[0]);
    expect(over.text).toContain(rec.state.pair[1]);
  });

  it('undercover side wins when parity is reached', () => {
    const { manager, rec } = botGame(5, { undercover_count: 2, final_count: 2 }, 'w2');
    voteOut(manager, rec, rolesOf(rec, 'civilian')[0]!);
    expect(rec.status).toBe('ended');
    expect(rec.result!.winnerTeam).toBe('卧底阵营');
    expect(rec.result!.reason).toContain('不少于');
    expect(rec.result!.winnerSeats.sort()).toEqual(rolesOf(rec, 'undercover').sort());
  });

  it('undercover side wins when alive <= final_count', () => {
    const { manager, rec } = botGame(6, {}, 'w3');
    for (let i = 0; i < 2; i++) {
      voteOut(manager, rec, rolesOf(rec, 'civilian').find((s) => rec.players[s - 1]!.alive)!);
      expect(rec.status).toBe('running');
    }
    voteOut(manager, rec, rolesOf(rec, 'civilian').find((s) => rec.players[s - 1]!.alive)!);
    expect(rec.status).toBe('ended');
    expect(rec.result!.winnerTeam).toBe('卧底阵营');
    expect(rec.result!.reason).toContain('只剩 3 人');
  });

  it('final_count can be lowered so the game continues', () => {
    const { manager, rec } = botGame(6, { final_count: 2 }, 'w4');
    for (let i = 0; i < 3; i++) voteOut(manager, rec, rolesOf(rec, 'civilian').find((s) => rec.players[s - 1]!.alive)!);
    expect(rec.status).toBe('running');
    expect(rec.players.filter((p) => p.alive)).toHaveLength(3);
  });

  it('blank counts as undercover side: civilians must remove both', () => {
    const { manager, rec } = botGame(6, { blank_count: 1 }, 'w5');
    voteOut(manager, rec, rolesOf(rec, 'undercover')[0]!);
    expect(rec.status).toBe('running');
    voteOut(manager, rec, rolesOf(rec, 'blank')[0]!);
    expect(rec.status).toBe('ended');
    expect(rec.result!.winnerTeam).toBe('平民');
    const blankRevealed = rec.result!.reveal.find((r) => r.seat === rolesOf(rec, 'blank')[0])!;
    expect(blankRevealed.identity).toContain('白板');
  });

  it('blank and undercover together reach parity', () => {
    const { manager, rec } = botGame(6, { blank_count: 1, final_count: 2 }, 'w6');
    voteOut(manager, rec, rolesOf(rec, 'civilian')[0]!);
    voteOut(manager, rec, rolesOf(rec, 'civilian').find((s) => rec.players[s - 1]!.alive)!);
    expect(rec.status).toBe('ended');
    expect(rec.result!.winnerTeam).toBe('卧底阵营');
  });
});

describe('undercover: humans', () => {
  it('first relayed message is the description; chatter from others is ignored', async () => {
    const { manager, clock, gameId, rec } = humanGame(5);
    await ready(manager, clock, gameId);
    const cur = pendingSeats(rec)[0]!;
    const other = rec.players.find((p) => p.seat !== cur)!;
    const ignored = manager.relayHumanMessage(REF, gameId, { userId: other.id, text: '我先说一句', channel: 'group' });
    expect(ignored.recognized).toBe(false);
    const p = rec.players.find((x) => x.seat === cur)!;
    const res = manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '一种很常见的东西', channel: 'group' });
    expect(res.accepted).toBe(true);
    expect(res.action).toEqual({ action: 'speech', text: '一种很常见的东西' });
    expect(rec.state.rounds[0]!.descriptions[0]).toMatchObject({ seat: cur, text: '一种很常见的东西' });
    // private description is not accepted
    await ready(manager, clock, gameId);
    const cur2 = pendingSeats(rec)[0]!;
    const p2 = rec.players.find((x) => x.seat === cur2)!;
    expect(manager.relayHumanMessage(REF, gameId, { userId: p2.id, text: '私聊描述', channel: 'private' }).recognized).toBe(false);
  });

  it('human description containing own word => eliminated, round continues', async () => {
    const { manager, clock, gameId, rec } = humanGame(6, {}, 'hv');
    await ready(manager, clock, gameId);
    const cur = pendingSeats(rec)[0]!;
    const p = rec.players.find((x) => x.seat === cur)!;
    const word = rec.state.words[String(cur)]!;
    const res = manager.relayHumanMessage(REF, gameId, { userId: p.id, text: `就是${word}啊`, channel: 'group' });
    expect(res.accepted).toBe(true);
    await ready(manager, clock, gameId);
    expect(p.alive).toBe(false);
    expect(rec.state.eliminated[0]).toMatchObject({ seat: cur, reason: 'violation' });
    const msgs = rec.outbox.map((d) => d.text).join('\n');
    expect(msgs).toContain('违规');
    if (rec.status === 'running') {
      expect(rec.round).toBe(1);
      expect(rec.phase?.key).toBe('describe');
      expect(pendingSeats(rec)[0]).not.toBe(cur);
    }
  });

  it('parses vote syntaxes and abstain', async () => {
    const { manager, clock, gameId, rec } = humanGame(7, { undercover_count: 1 }, 'hp');
    await ready(manager, clock, gameId);
    for (let i = 0; i < 7; i++) {
      const s = pendingSeats(rec)[0]!;
      const p = rec.players.find((x) => x.seat === s)!;
      manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '挺常见的', channel: 'group' });
      await ready(manager, clock, gameId);
    }
    expect(rec.phase?.key).toBe('vote');
    const target = rolesOf(rec, 'civilian')[0]!;
    const targetName = rec.players[target - 1]!.name;
    const voters = rec.players.filter((p) => p.seat !== target);
    const texts = [`投${target}`, `投票 ${['零', '一', '二', '三', '四', '五', '六', '七'][target]}号`, `票@${targetName}`, `我投${target}号`, `投 ${target}`, `票[CQ:at,qq=${rec.players[target - 1]!.id}]`];
    voters.forEach((p, i) => {
      const r = manager.relayHumanMessage(REF, gameId, { userId: p.id, text: texts[i]!, channel: i % 2 ? 'private' : 'group' });
      expect(r.action).toEqual({ action: 'vote', target });
      expect(r.accepted).toBe(true);
    });
    const self = rec.players[target - 1]!;
    expect(manager.relayHumanMessage(REF, gameId, { userId: self.id, text: `投${target}`, channel: 'group' }).accepted).toBe(false);
    expect(manager.relayHumanMessage(REF, gameId, { userId: self.id, text: '弃票', channel: 'group' }).action).toEqual({ action: 'skip' });
    expect(rec.state.eliminated[0]!.seat).toBe(target);
  });
});

describe('undercover: random full games', () => {
  it('plays 220 random games (bots and humans, 4-12 players) to a valid result', async () => {
    for (let g = 0; g < 220; g++) {
      const n = 4 + (g % 9);
      const humans = g % 3 === 0 ? 0 : (g % 5) % (n - 1);
      const { manager, clock } = setup(`rg${g}`);
      const options: Record<string, unknown> = {
        final_count: Math.min([2, 3, 3, 4][g % 4]!, n - 1),
        blank_count: n >= 6 && g % 2 ? 1 : 0,
        reveal_on_elimination: g % 7 !== 0,
        forbid_word: g % 11 !== 0,
        ...(g % 6 === 0 ? { category: '食物' } : {}),
      };
      const players = bots(n - humans);
      const { gameId, rec } = startGame(manager, 'undercover', {
        players,
        humans: Array.from({ length: humans }, (_, i) => human(i + 1)),
        referee: REF,
        options,
      });
      const steps = await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 4000 });
      const r = rec as Rec;
      expect(steps).toBeGreaterThan(n);
      expect(rec.status, `game ${g} n=${n} steps=${steps}`).toBe('ended');
      const res = rec.result!;
      expect(['平民', '卧底阵营']).toContain(res.winnerTeam);
      expect(res.winnerSeats.length).toBeGreaterThan(0);
      expect(res.reveal).toHaveLength(n);
      const alive = rec.players.filter((p) => p.alive).map((p) => p.seat);
      const spy = alive.filter((s) => r.state.roles[String(s)] !== 'civilian').length;
      const civ = alive.length - spy;
      if (res.winnerTeam === '平民') expect(spy).toBe(0);
      else {
        expect(spy).toBeGreaterThan(0);
        expect(spy >= civ || alive.length <= (options.final_count as number)).toBe(true);
      }
    }
  }, 120_000);
});

describe('undercover: vote reasons, seat numbers, discussion', () => {
  it('vote announcement lists seat numbers next to names', () => {
    const { manager, rec } = botGame(6);
    describeAll(manager, rec);
    const ann = rec.log.filter((e) => e.text.includes('进入投票')).pop()!;
    expect(ann.text).toMatch(/1号@?/);
    expect(ann.text).toContain(`可投：1号 ${rec.players[0]!.name}`);
  });

  it('bots and humans can attach a public reason to a vote', () => {
    const { manager, rec } = botGame(6);
    describeAll(manager, rec);
    manager.act(identityOf(rec, 1), rec.id, { action: 'vote', target: 2, text: '他说得太宽泛了' });
    for (const s of pendingSeats(rec)) vote(manager, rec, s, s === 2 ? 1 : 2);
    const res = rec.log.filter((e) => e.kind === 'vote').pop()!;
    expect(res.text).toContain(`→ 2号 ${rec.players[1]!.name}：「他说得太宽泛了」`);
    expect(rec.state.rounds[0]!.votes.find((v) => v.voter === 1)?.reason).toBe('他说得太宽泛了');

    // 真人投票指令里的理由：另开一局停在投票阶段
    const g = botGame(6, {}, 2);
    describeAll(g.manager, g.rec);
    const q = (t: string) => (g.manager as any).inst(g.rec).parseCommand(3, t, 'group');
    expect(q('投2')).toEqual({ action: 'vote', target: 2 });
    expect(q('投2 他说天气，太宽泛')).toEqual({ action: 'vote', target: 2, text: '他说天气,太宽泛' });
    expect(q('投票 2号，像在凑')).toEqual({ action: 'vote', target: 2, text: '像在凑' });
    expect(q('弃票')).toEqual({ action: 'skip' });
  });

  it('discussion: everyone says one line after describing, then the vote', () => {
    const { manager, rec } = botGame(6, { discussion: true });
    describeAll(manager, rec);
    expect(rec.phase?.key).toBe('discuss');
    for (let i = 0; i < 6; i++) say(manager, rec, pendingSeats(rec)[0]!, '我怀疑 3 号');
    expect(rec.phase?.key).toBe('vote');
    const r = rec.state.rounds[0]!;
    expect(r.descriptions.filter((d) => d.stage === 'discuss').length).toBe(6);
    // 讨论内容不算作描述
    expect(Object.values(rec.state.speeches).every((l) => l.length === 1)).toBe(true);
  });
});
