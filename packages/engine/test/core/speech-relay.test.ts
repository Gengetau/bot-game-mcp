import { describe, expect, it } from 'vitest';
import { cqToSpeech, splitTrailingEnd } from '../../src/core/text.js';
import { REF, bot, human, identityOf, pendingSeats, setup, startGame } from '../helpers.js';

describe('human speech cleanup', () => {
  it('splits a trailing 过 only when it stands apart', () => {
    expect(splitTrailingEnd('为什么女巫没药都不告诉我谁死了啊 过')).toEqual({ body: '为什么女巫没药都不告诉我谁死了啊', end: true });
    expect(splitTrailingEnd('我先听听，过。')).toEqual({ body: '我先听听', end: true });
    expect(splitTrailingEnd('就这么过')).toEqual({ body: '就这么过', end: false });
    expect(splitTrailingEnd('过')).toEqual({ body: '过', end: false });
    expect(splitTrailingEnd('我说完了')).toEqual({ body: '我说完了', end: false });
  });

  it('turns QQ @ into @nickname and drops outsiders, replies and images', () => {
    const players = [{ id: '101', name: '克蕾雅' }];
    expect(cqToSpeech('[CQ:reply,id=5][CQ:at,qq=101] 你怎么看[CQ:image,file=x]', players)).toBe('@克蕾雅 你怎么看');
    expect(cqToSpeech('[CQ:at,qq=862105390] 诶，是这样吗', players)).toBe('诶，是这样吗');
  });
});

describe('relayed human speech', () => {
  it('records the speech without the trailing 过 or CQ codes, and ends the turn', async () => {
    const { manager } = setup('relay');
    const players = [bot(1), bot(2), bot(3), bot(4), bot(5)];
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players,
      humans: [human(1)],
      referee: REF,
      options: { roles: { werewolf: 2, seer: 1, villager: 3 }, claim_phase: false, sheriff: false, win_mode: 'side', night_min_s: 0, random_seats: false },
    });
    const hs = rec.players.find((p) => p.kind === 'human')!;
    const other = rec.players.find((p) => p.kind === 'agent')!;
    for (let i = 0; i < 60; i++) {
      await manager.refereeStep(REF, gameId);
      const k = rec.phase?.key;
      const seats = pendingSeats(rec);
      if (k === 'speech' && seats.includes(hs.seat)) break;
      for (const s of seats) {
        const p = rec.players.find((x) => x.seat === s)!;
        if (p.kind === 'human') manager.relayHumanMessage(REF, gameId, { userId: p.id, text: k === 'speech' ? '过' : '不用', channel: 'private' });
        else {
          const view = manager.getView(identityOf(rec, s), gameId) as any;
          const acts = view.todo?.actions?.map((a: any) => a.action) ?? [];
          manager.act(identityOf(rec, s), gameId, acts.includes('speech') ? { action: 'end_speech' } : { action: 'skip' });
        }
      }
    }
    expect(pendingSeats(rec)).toEqual([hs.seat]);
    const r = manager.relayHumanMessage(REF, gameId, {
      userId: hs.id,
      text: `[CQ:at,qq=${other.id}] [CQ:at,qq=862105390] 你怎么看 过`,
      channel: 'group',
    });
    expect(r.accepted).toBe(true);
    const speech = rec.log.filter((e) => e.kind === 'speech').pop()!;
    expect(speech.text).toBe(`${hs.seat}号 ${hs.name}：@${other.name} 你怎么看`);
    expect(pendingSeats(rec)).not.toContain(hs.seat);
  });
});

describe('self-posting bots', () => {
  it('the next group message waits for the bot speech to show up in the group', async () => {
    const { manager, clock } = setup('post');
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players: [bot(1), bot(2), bot(3), bot(4), bot(5), bot(6)],
      referee: REF,
      selfPost: true,
      options: { roles: { werewolf: 2, seer: 1, villager: 3 }, claim_phase: false, sheriff: false, win_mode: 'side', night_min_s: 0, random_seats: false },
    });
    for (let i = 0; i < 40 && rec.phase?.key !== 'speech'; i++) {
      await manager.refereeStep(REF, gameId);
      for (const s of pendingSeats(rec)) manager.act(identityOf(rec, s), gameId, { action: 'skip' });
    }
    for (let i = 0; i < 10 && pendingSeats(rec).length === 0; i++) {
      clock.advance(5000);
      await manager.refereeStep(REF, gameId);
    }
    const speaker = pendingSeats(rec)[0]!;
    const before = rec.outboxSeq;
    manager.act(identityOf(rec, speaker), gameId, { action: 'speech', text: '我是好人。' });
    const next = rec.outbox.find((d) => d.seq > before && d.target.type === 'group')!;
    expect(next.waitForPost).toEqual({ qq: identityOf(rec, speaker).id, since: expect.any(Number) });
    expect(rec.outbox.filter((d) => d.seq > before && d.waitForPost)).toHaveLength(1);
  });
});
