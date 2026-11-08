import { describe, expect, it } from 'vitest';
import { GameError } from '../../src/core/errors.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { FakeClock, REF, bot, human, setup } from '../helpers.js';

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
      // 群里的开局提示不能点名让被抽中的账号去调 referee_step（它的模型会以为要自己主持）
      expect(r.group_message).not.toMatch(/referee_step/);
      expect(r.group_message).not.toContain(r.referee!.name);
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
    expect(r.group_message).toMatch(/referee_step/);
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

describe('refereeIds：裁判只从指定账号里抽', () => {
  const mk = (seed: number) =>
    new GameManager({ registry: createRegistry(), now: new FakeClock().now, rng: new SeededRng(seed), refereeIds: ['999', '101'] });

  it('keeps outsiders out of every referee path, but lets them play', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const manager = mk(seed);
      const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'none' });
      const id = summary.game_id;
      manager.offerReferee(REF, id, HOST);
      manager.joinGame(bot(1), id, { as: 'player' });
      manager.offerReferee(bot(1), id, HOST);
      // 外来 bot：要当裁判被拒；「都行」按玩家；代行登记被拒
      expect(() => manager.joinGame(bot(7), id, { as: 'referee' })).toThrow(/不能当裁判/);
      const j = manager.joinGame(bot(7), id, { as: 'either' });
      expect(j.message).toContain('玩家');
      expect(() => manager.offerReferee(bot(7), id, 'outsider-host')).toThrow(/抽签池/);
      manager.joinGame(bot(8), id); // 默认 either
      const r = manager.startGame(REF, id);
      expect(r.referee_draw!.candidates.map((c) => c.id).sort()).toEqual(['101', '999']);
      const rec = manager.getRecord(id);
      expect(['101', '999']).toContain(rec.referee!.id);
      expect(rec.players.map((p) => p.id)).toEqual(expect.arrayContaining(['107', '108']));
      // 进行中：外来 bot 不能登记候补，也不能接管
      expect(() => manager.joinGame(bot(9), id, { as: 'referee' })).toThrow(/不能当裁判/);
      expect(() => manager.refereeTakeover(bot(9), id)).toThrow(/不能接管/);
    }
  });

  it('an outsider who creates a room joins as a player; no listed account means no referee', () => {
    const manager = mk(1);
    const { summary } = manager.createGame(bot(7), { type: 'number_bomb', groupId: 'g' });
    const id = summary.game_id;
    expect(manager.summary(manager.getRecord(id)).lobby![0]!.join_as).toBe('player');
    expect(() => manager.createGame(bot(8), { type: 'undercover', groupId: 'g2', joinAs: 'referee' })).toThrow(/不能当裁判/);
    manager.joinGame(bot(8), id);
    expect(() => manager.startGame(bot(7), id)).toThrow(/没有可担任裁判/);
  });
});

describe('持有密钥的 AI 不能以真人身份报名', () => {
  it('relay「加入」 and add_human refuse keyed ids and point them to join_game', () => {
    const { manager } = setup(1);
    manager.isKeyedAgent = (id) => id === '777';
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'referee' });
    const id = summary.game_id;
    const r = manager.relayHumanMessage(REF, id, { userId: '777', nickname: '刺猬', text: '加入', channel: 'group' });
    expect(r).toMatchObject({ recognized: true, accepted: false });
    expect(r.message).toContain(`join_game(game_id="${id}"`);
    expect(() => manager.addHuman(REF, id, { userId: '777', name: '刺猬' })).toThrow(GameError);
    expect(manager.getRecord(id).lobby.some((e) => e.id === '777')).toBe(false);
    // 普通真人照常报名
    expect(manager.relayHumanMessage(REF, id, { userId: '555', nickname: '路人', text: '加入', channel: 'group' }).accepted).toBe(true);
  });
});
