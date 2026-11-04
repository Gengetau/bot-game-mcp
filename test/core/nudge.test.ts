import { describe, expect, it } from 'vitest';
import type { Delivery, GameRecord } from '../../src/core/types.js';
import { REF, bot, human, pendingSeats, setup, startGame } from '../helpers.js';

const nudges = (rec: GameRecord): Delivery[] => rec.outbox.filter((d) => d.text.includes('查看自己的行动面板'));
const agentIds = (rec: GameRecord) => rec.players.filter((p) => p.kind === 'agent' && p.alive).map((p) => p.id).sort();

describe('nudge_ai option', () => {
  it('is off by default', async () => {
    const { manager } = setup(1);
    const { gameId, rec } = startGame(manager, 'werewolf', { players: [1, 2, 3, 4, 5, 6].map((n) => bot(n)), referee: REF });
    await manager.refereeStep(REF, gameId);
    expect(nudges(rec)).toHaveLength(0);
  });

  it('secret phases @ every living AI player regardless of roles, never humans', async () => {
    const { manager, clock } = setup(7);
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players: [1, 2, 3, 4, 5].map((n) => bot(n)),
      humans: [human(1), human(2)],
      referee: REF,
      options: { nudge_ai: true },
    });
    const first = nudges(rec);
    expect(first.length).toBeGreaterThanOrEqual(1);
    const d = first[0]!;
    expect(d.target).toEqual({ type: 'group', groupId: '9000' });
    expect(d.category).toBe('prompt');
    expect(d.mentions.map((m) => m.id).sort()).toEqual(agentIds(rec));
    expect(d.mentions.some((m) => m.id.startsWith('20'))).toBe(false);
    expect(rec.phase?.secret).toBe(true);
    // 提示只进 outbox，不进日志
    expect(rec.log.some((e) => e.text.includes('行动面板'))).toBe(false);
    // 走完第一夜的几个秘密阶段：每个阶段的名单都一样（与谁拿到什么身份无关）
    await manager.refereeStep(REF, gameId);
    let guard = 0;
    while (rec.phase?.secret && guard++ < 10) {
      for (const seat of pendingSeats(rec)) {
        const p = rec.players.find((pl) => pl.seat === seat)!;
        const input = manager.randomActionFor(gameId, seat);
        if (!input) continue;
        if (p.kind === 'agent') manager.act({ id: p.id, name: p.name }, gameId, input);
        else manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '', channel: 'private', action: input });
      }
      clock.advance(25_000); // 夜晚阶段有最短时长
      await manager.refereeStep(REF, gameId);
    }
    const night = nudges(rec).filter((n) => n.seq <= rec.outboxSeq);
    expect(night.length).toBeGreaterThanOrEqual(2);
    for (const n of night) expect(n.mentions.map((m) => m.id).sort()).toEqual(agentIds(rec));
  });

  it('public multi-seat phases @ only the AI seats with a todo; single-seat phases get no nudge', async () => {
    const { manager } = setup(3);
    const { gameId, rec } = startGame(manager, 'undercover', {
      players: [1, 2, 3, 4].map((n) => bot(n)),
      humans: [human(1)],
      referee: REF,
      options: { nudge_ai: true },
    });
    await manager.refereeStep(REF, gameId);
    // 发言阶段：一次一个人，不提示
    expect(pendingSeats(rec)).toHaveLength(1);
    expect(nudges(rec)).toHaveLength(0);
    let guard = 0;
    while (pendingSeats(rec).length === 1 && guard++ < 10) {
      const seat = pendingSeats(rec)[0]!;
      const p = rec.players.find((pl) => pl.seat === seat)!;
      const input = manager.randomActionFor(gameId, seat)!;
      if (p.kind === 'agent') manager.act({ id: p.id, name: p.name }, gameId, input);
      else manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '', channel: 'group', action: input });
      await manager.refereeStep(REF, gameId);
    }
    // 投票阶段：所有存活玩家同时行动，只 @ 其中的 AI
    const seats = pendingSeats(rec);
    expect(seats.length).toBeGreaterThanOrEqual(2);
    const want = seats
      .map((s) => rec.players.find((p) => p.seat === s)!)
      .filter((p) => p.kind === 'agent')
      .map((p) => p.id)
      .sort();
    const n = nudges(rec);
    expect(n).toHaveLength(1);
    expect(n[0]!.mentions.map((m) => m.id).sort()).toEqual(want);
  });

  it('number bomb never nudges (one seat at a time)', async () => {
    const { manager } = setup(2);
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [1, 2, 3].map((n) => bot(n)), referee: REF, options: { nudge_ai: true } });
    await manager.refereeStep(REF, gameId);
    expect(nudges(rec)).toHaveLength(0);
  });
});
