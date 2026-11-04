import { describe, expect, it } from 'vitest';
import { GameError } from '../../src/core/errors.js';
import { REF, bot, human, setup } from '../helpers.js';

const HOST = 'nia-server';

describe('代行裁判：referee_offer 与开局抽签', () => {
  it('draws the referee uniformly among offered accounts; a drawn player leaves the seats', () => {
    const picks = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const { manager } = setup(seed);
      const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'none' });
      const id = summary.game_id;
      // 主账号只当嗓子：没报名就登记，自动成为 referee 候选
      const r0 = manager.offerReferee(REF, id, HOST);
      expect(r0.message).toContain('抽签池 1 人');
      for (const n of [1, 2, 3]) manager.joinGame(bot(n), id, { as: 'player' });
      // 两个玩家 bot 也登记代行（本机能替它们说话）
      manager.offerReferee(bot(1), id, HOST);
      manager.offerReferee(bot(2), id, HOST);
      manager.addHuman(REF, id, human(1));
      const lobby = manager.summary(manager.getRecord(id)).lobby!;
      expect(lobby.filter((e) => e.hosted).map((e) => e.id).sort()).toEqual(['101', '102', '999']);
      const r = manager.startGame(REF, id);
      expect(r.referee_draw).toBeTruthy();
      expect(r.referee_draw!.candidates.map((c) => c.id).sort()).toEqual(['101', '102', '999']);
      expect(r.referee!.hosted_by).toBe(HOST);
      const rec = manager.getRecord(id);
      picks.add(rec.referee!.id);
      expect(rec.referee!.hostedBy).toBe(HOST);
      // 抽中的玩家不入座；没抽中的照常入座
      expect(rec.players.some((p) => p.id === rec.referee!.id)).toBe(false);
      expect(rec.players.length).toBe(rec.referee!.id === '999' ? 4 : 3);
      expect(rec.log.some((e) => e.text.includes('位候选里抽签'))).toBe(true);
      if (rec.referee!.id !== '999') expect(rec.standbyReferees.map((s) => s.id)).toEqual(['999']);
    }
    expect(picks.size).toBe(3);
  });

  it('never draws a player when that would leave too few seats', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { manager } = setup(seed);
      const { summary } = manager.createGame(REF, { type: 'undercover', groupId: 'g', joinAs: 'none' });
      const id = summary.game_id;
      manager.offerReferee(REF, id, HOST);
      for (const n of [1, 2, 3, 4]) {
        manager.joinGame(bot(n), id, { as: 'player' });
        manager.offerReferee(bot(n), id, HOST);
      }
      const r = manager.startGame(REF, id); // 卧底最少 4 人：只能抽主账号
      expect(r.referee_draw!.candidates.map((c) => c.id)).toEqual(['999']);
      expect(manager.getRecord(id).players).toHaveLength(4);
    }
  });

  it('falls back to the old election when nobody offered, and offers can be withdrawn', () => {
    const { manager } = setup(3);
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'referee' });
    const id = summary.game_id;
    for (const n of [1, 2]) manager.joinGame(bot(n), id, { as: 'player' });
    manager.offerReferee(bot(1), id, HOST);
    manager.offerReferee(bot(1), id, HOST, true);
    const r = manager.startGame(REF, id);
    expect(r.referee_draw).toBeNull();
    expect(r.referee!.id).toBe('999');
    expect(r.referee!.hosted_by).toBeNull();
    expect(() => manager.offerReferee(bot(2), id, HOST)).toThrow(GameError);
  });

  it('hosted referee: only calls carrying the host_id advance; the account itself gets an empty, harmless result', async () => {
    const { manager, clock } = setup(5);
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'none' });
    const id = summary.game_id;
    manager.offerReferee(REF, id, HOST);
    for (const n of [1, 2]) manager.joinGame(bot(n), id, { as: 'player' });
    manager.addHuman(REF, id, human(1));
    manager.startGame(REF, id);
    const rec = manager.getRecord(id);
    const ref = { id: rec.referee!.id, name: rec.referee!.name };
    const before = rec.referee!.cursor;
    const seenBefore = rec.referee!.lastSeenAt;
    clock.advance(5_000);
    // 裁判账号自己的模型：空结果，游标和在线时间都不动
    const plain = await manager.refereeStep(ref, id);
    expect(plain.hosted).toBe(true);
    expect(plain.deliveries).toHaveLength(0);
    expect(plain.next_call_hint).toContain('休息');
    expect(rec.referee!.cursor).toBe(before);
    expect(rec.referee!.lastSeenAt).toBe(seenBefore);
    const relay = manager.relayHumanMessage(ref, id, { userId: '201', text: '50', channel: 'group' });
    expect(relay.accepted).toBe(false);
    expect(relay.message).toContain('代行');
    const view = manager.getView(ref, id) as any;
    expect(view.you.hosted_by).toBe(HOST);
    expect(view.you.note).toContain('休息');
    // 带 host_id 的调用正常推进
    const hosted = await manager.refereeStep(ref, id, { hostId: HOST });
    expect(hosted.hosted).toBeUndefined();
    expect(hosted.deliveries.length).toBeGreaterThan(0);
    expect(rec.referee!.lastSeenAt).toBeGreaterThan(seenBefore);
    await expect(manager.refereeStep({ id: '101', name: 'Bot1' }, id, { hostId: HOST })).rejects.toThrow(GameError);
    // 候补用自己的 host_id 接管后，代行者随之切换
    clock.advance(10 * 60_000);
    manager.joinGame(bot(9), id, { as: 'referee' });
    manager.refereeTakeover(bot(9), id, 'other-host');
    expect(rec.referee!.hostedBy).toBe('other-host');
    const old = await manager.refereeStep(bot(9), id, { hostId: HOST });
    expect(old.hosted).toBe(true);
  });
});
