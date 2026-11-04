import { describe, expect, it } from 'vitest';
import { GameError } from '../../src/core/errors.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { MemoryStateStore } from '../../src/core/store.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator } from '../../src/mcp/auth.js';
import { FakeClock, REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

describe('lobby & referee election', () => {
  it('elects the referee volunteer and seats the others', () => {
    const { manager } = setup();
    const { rec, started } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2), bot(3)], referee: REF });
    expect(rec.status).toBe('running');
    expect(rec.referee?.id).toBe(REF.id);
    expect(started.referee?.id).toBe(REF.id);
    expect(rec.players.map((p) => p.seat).sort()).toEqual([1, 2, 3]);
    expect(rec.players.some((p) => p.id === REF.id)).toBe(false);
  });

  it('draws the referee among "either" agents by program', () => {
    const { manager } = setup('either');
    const host = bot(1);
    const { summary } = manager.createGame(host, { type: '数字炸弹', groupId: 'g1', joinAs: 'either' });
    manager.joinGame(bot(2), summary.game_id, { as: 'either' });
    manager.joinGame(bot(3), summary.game_id, { as: 'either' });
    manager.startGame(host, summary.game_id);
    const rec = manager.getRecord(summary.game_id);
    expect(rec.referee).not.toBeNull();
    expect(rec.players).toHaveLength(2);
    expect(rec.players.some((p) => p.id === rec.referee!.id)).toBe(false);
  });

  it('refuses to start without any referee candidate unless auto_referee', () => {
    const { manager } = setup();
    const { summary } = manager.createGame(bot(1), { type: 'number_bomb', groupId: 'g', joinAs: 'player' });
    manager.joinGame(bot(2), summary.game_id, { as: 'player' });
    expect(() => manager.startGame(bot(1), summary.game_id)).toThrow(/裁判/);

    const { summary: s2 } = manager.createGame(bot(5), { type: 'number_bomb', groupId: 'g2', joinAs: 'player', autoReferee: true });
    manager.joinGame(bot(6), s2.game_id, { as: 'player' });
    expect(manager.startGame(bot(5), s2.game_id).referee).toBeNull();
  });

  it('allows only one active game per group and validates player counts', () => {
    const { manager } = setup();
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'same', joinAs: 'referee' });
    expect(() => manager.createGame(bot(1), { type: 'number_bomb', groupId: 'same' })).toThrow(GameError);
    manager.joinGame(bot(1), summary.game_id, { as: 'player' });
    expect(() => manager.startGame(REF, summary.game_id)).toThrow(/2~20/);
  });

  it('only the host may start; humans can be added and removed by lobby agents', () => {
    const { manager } = setup();
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'referee' });
    manager.joinGame(bot(1), summary.game_id, { as: 'player' });
    manager.addHuman(bot(1), summary.game_id, human(1));
    expect(() => manager.addHuman(bot(9), summary.game_id, human(2))).toThrow(/房主或已报名/);
    expect(() => manager.startGame(bot(1), summary.game_id)).toThrow(/房主/);
    const relay = manager.relayHumanMessage(bot(1), summary.game_id, { userId: '20002', nickname: '路人', text: '加入！', channel: 'group' });
    expect(relay.accepted).toBe(true);
    expect(manager.getRecord(summary.game_id).lobby.filter((e) => e.kind === 'human')).toHaveLength(2);
    manager.relayHumanMessage(bot(1), summary.game_id, { userId: '20002', text: '退出', channel: 'group' });
    expect(manager.getRecord(summary.game_id).lobby.filter((e) => e.kind === 'human')).toHaveLength(1);
    expect(() => manager.createGame(bot(1), { type: 'number_bomb', groupId: 'x', options: { min: 5, max: 6 } })).toThrow(/选项无效/);
  });
});

describe('gating, actions and timeouts', () => {
  it('opens a phase only after the referee fetched its announcements', async () => {
    const { manager } = setup(7);
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    expect(rec.phase?.openedAt).toBeNull();
    const current = rec.state.current as number;
    const who = identityOf(rec, current);
    expect(() => manager.act(who, gameId, { action: 'guess', number: 50 })).toThrow(/尚未开放/);

    const step = await manager.refereeStep(REF, gameId);
    expect(step.deliveries.length).toBeGreaterThanOrEqual(2);
    expect(step.deliveries[0]!.target).toEqual({ type: 'group', groupId: '9000' });
    expect(step.deliveries.some((d) => d.mentions.some((m) => m.id === who.id))).toBe(true);
    expect(rec.phase?.openedAt).not.toBeNull();

    const view = manager.getView(who, gameId) as any;
    expect(view.your_turn).toBe(true);
    expect(view.todo.actions[0].action).toBe('guess');

    expect(() => manager.act(who, gameId, { action: 'guess', number: 0 })).toThrow(/之间/);
    const other = identityOf(rec, current === 1 ? 2 : 1);
    expect(() => manager.act(other, gameId, { action: 'guess', number: 30 })).toThrow(/不是你行动/);
  });

  it('applies the program default on timeout when the referee steps', async () => {
    const { manager, clock } = setup(3);
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2), bot(3)], referee: REF });
    await manager.refereeStep(REF, gameId);
    const firstPhase = rec.phase!.id;
    clock.advance(61_000);
    const step = await manager.refereeStep(REF, gameId);
    expect(rec.phase === null || rec.phase.id !== firstPhase).toBe(true);
    expect(step.deliveries.map((d) => d.text).join('\n')).toMatch(/超时，程序代猜/);
  });

  it('parses relayed human text and confirms privately', async () => {
    const { manager } = setup(11);
    const { gameId, rec } = startGame(manager, 'number_bomb', {
      players: [bot(1)],
      humans: [human(1, '阿强')],
      referee: REF,
      options: { random_seats: false },
    });
    await manager.refereeStep(REF, gameId);
    // 让真人先手：若轮到 bot，先让 bot 猜一个安全的数
    if (rec.players.find((p) => p.seat === rec.state.current)!.kind === 'agent') {
      const safe = rec.state.bomb > 50 ? 2 : 99;
      manager.act(identityOf(rec, rec.state.current), gameId, { action: 'guess', number: safe });
      await manager.refereeStep(REF, gameId);
    }
    expect(rec.players.find((p) => p.seat === rec.state.current)!.kind).toBe('human');
    const hid = human(1).userId;
    const chit = manager.relayHumanMessage(REF, gameId, { userId: hid, text: '哈哈好紧张', channel: 'group' });
    expect(chit.recognized).toBe(false);
    const lo = rec.state.lo as number;
    const guessText = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const target = lo + 1;
    const text = target < 10 ? `猜${guessText[target]}` : String(target);
    const res = manager.relayHumanMessage(REF, gameId, { userId: hid, text, channel: 'group' });
    expect(res.accepted).toBe(true);
    expect(res.action).toEqual({ action: 'guess', number: target });

    const notPlayer = manager.relayHumanMessage(REF, gameId, { userId: '123', text: '50', channel: 'group' });
    expect(notPlayer.recognized).toBe(false);
  });

  it('structured relay is reported to the human privately', async () => {
    const { manager } = setup(5);
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [], humans: [human(1), human(2)], referee: REF });
    await manager.refereeStep(REF, gameId);
    const p = rec.players.find((pl) => pl.seat === rec.state.current)!;
    const num = rec.state.bomb === rec.state.lo + 1 ? rec.state.lo + 2 : rec.state.lo + 1;
    const res = manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '我选这个', channel: 'group', action: { action: 'guess', number: num } });
    expect(res.accepted).toBe(true);
    const step = await manager.refereeStep(REF, gameId);
    const dm = step.deliveries.find((d) => d.target.type === 'private' && d.target.userId === p.id);
    expect(dm?.text).toMatch(/裁判已代你提交/);
  });

  it('only the referee can step and relay', async () => {
    const { manager } = setup();
    const { gameId } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    await expect(manager.refereeStep(bot(1), gameId)).rejects.toThrow(/不是对局/);
    expect(() => manager.relayHumanMessage(bot(1), gameId, { userId: '1', text: 'x', channel: 'group' })).toThrow(/不是对局/);
  });

  it('plays to the end with random moves and reveals everything afterwards', async () => {
    const { manager, clock } = setup('full');
    const { gameId, rec } = startGame(manager, 'number_bomb', {
      players: [bot(1), bot(2), bot(3)],
      humans: [human(1)],
      referee: REF,
      options: { mode: 'elimination', min: 1, max: 20 },
    });
    await playToEnd(manager, gameId, { referee: REF, clock });
    expect(rec.status).toBe('ended');
    expect(rec.result?.winnerSeats).toHaveLength(1);
    const final = await manager.refereeStep(REF, gameId);
    expect(final.finished).toBe(true);
    const log = manager.getLog(bot(1), gameId);
    expect(log.complete_replay).toBe(true);
  });
});

describe('auto referee, long-poll, takeover, persistence', () => {
  it('auto referee games advance through tick without any AI referee', () => {
    const { manager, clock } = setup(9);
    const { rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], autoReferee: true });
    expect(rec.phase?.openedAt).not.toBeNull();
    for (let i = 0; i < 200 && rec.status === 'running'; i++) {
      clock.advance(61_000);
      manager.tick();
    }
    expect(rec.status).toBe('ended');
  });

  it('long-poll wakes up when it becomes your turn', async () => {
    const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng(2) });
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    const who = identityOf(rec, rec.state.current);
    const waiting = manager.waitView(who, gameId, 3000);
    setTimeout(() => void manager.refereeStep(REF, gameId), 50);
    const t0 = Date.now();
    const view = (await waiting) as any;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(view.your_turn).toBe(true);
  });

  it('referee long-poll returns when a player acts', async () => {
    const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng(4) });
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    await manager.refereeStep(REF, gameId);
    const who = identityOf(rec, rec.state.current);
    const safe = rec.state.bomb === 2 ? 3 : 2;
    const waiting = manager.refereeStep(REF, gameId, { waitMs: 3000 });
    setTimeout(() => manager.act(who, gameId, { action: 'guess', number: safe }), 50);
    const t0 = Date.now();
    const step = await waiting;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(step.deliveries.length).toBeGreaterThan(0);
  });

  it('a standby referee can take over a stale referee', async () => {
    const { manager, clock } = setup();
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    await manager.refereeStep(REF, gameId);
    const sub = bot(8, 'Sub');
    expect(() => manager.refereeTakeover(sub, gameId)).toThrow(/候补裁判/);
    manager.joinGame(sub, gameId, { as: 'referee' });
    expect(() => manager.refereeTakeover(sub, gameId)).toThrow(/仍在线/);
    expect(() => manager.refereeTakeover(bot(1), gameId)).toThrow(/玩家不能/);
    clock.advance(121_000);
    expect(() => manager.refereeTakeover(bot(9), gameId)).toThrow(/候补裁判/);
    manager.refereeTakeover(sub, gameId);
    expect(rec.referee?.id).toBe(sub.id);
    const step = await manager.refereeStep(sub, gameId);
    expect(step.deliveries.some((d) => d.text.includes('接管'))).toBe(true);
  });

  it('restores games from a snapshot and continues', async () => {
    const store = new MemoryStateStore();
    const clock = new FakeClock();
    const m1 = new GameManager({ registry: createRegistry(), now: clock.now, rng: new SeededRng(1), store });
    const { gameId } = startGame(m1, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    await m1.refereeStep(REF, gameId);
    store.flush();

    const m2 = new GameManager({ registry: createRegistry(), now: clock.now, rng: new SeededRng(2), store });
    const rec2 = m2.getRecord(gameId);
    expect(rec2.status).toBe('running');
    expect(pendingSeats(rec2)).toHaveLength(1);
    await playToEnd(m2, gameId, { referee: REF, clock });
    expect(rec2.status).toBe('ended');
  });

  it('views hide private information from spectators and expose referee hints', async () => {
    const { manager } = setup();
    const { gameId } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    const spectator = manager.getView(bot(7), gameId) as any;
    expect(spectator.you.role).toBe('spectator');
    expect(JSON.stringify(spectator)).not.toMatch(/"bomb"/);
    const refView = manager.getView(REF, gameId) as any;
    expect(refView.you.role).toBe('referee');
    expect(refView.hint).toMatch(/referee_step/);
  });

  it('host/referee can abort; players cannot', () => {
    const { manager } = setup();
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    expect(() => manager.abortGame(bot(2), gameId)).toThrow(/中止/);
    manager.abortGame(REF, gameId, '测试');
    expect(rec.status).toBe('aborted');
  });
});

describe('security hardening', () => {
  it('nobody can read a human seat through MCP, even with the human QQ id', async () => {
    const { manager } = setup(3);
    const { gameId, rec } = startGame(manager, 'undercover', {
      players: [bot(1), bot(2), bot(3)],
      humans: [human(1, '阿强')],
      referee: REF,
    });
    await manager.refereeStep(REF, gameId);
    const impostor = { id: human(1).userId, name: '冒充者' };
    const view = manager.getView(impostor, gameId) as any;
    expect(view.you.role).toBe('spectator');
    expect(view.hint).toMatch(/真人玩家/);
    const words = (rec.state as { pair: [string, string] }).pair;
    const dump = JSON.stringify(view) + JSON.stringify(manager.getLog(impostor, gameId));
    for (const w of words) expect(dump).not.toContain(w);
    expect(() => manager.act(impostor, gameId, { action: 'skip' })).toThrow(/真人/);
    // AI 玩家仍能看到自己的词
    const ai = rec.players.find((p) => p.kind === 'agent')!;
    expect(JSON.stringify(manager.getView({ id: ai.id, name: ai.name }, gameId))).toMatch(new RegExp(words.join('|')));
  });

  it('open-mode login refuses QQ ids that are playing as humans', () => {
    const { manager } = setup();
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g', joinAs: 'referee' });
    manager.addHuman(REF, summary.game_id, human(1));
    const auth = new Authenticator({ mode: 'open', adminKeys: [], agents: [] }, manager);
    const ctx = { identity: null, fixed: false, transport: 'memory' as const };
    expect(() => auth.login(ctx, { id: human(1).userId, name: 'x' })).toThrow(/真人玩家/);
    expect(auth.login(ctx, { id: '777', name: '小克[CQ:at,qq=all]\n{@1}' }).identity.name).toBe('小克［CQ:at,qq=all] {＠1}');
  });

  it('takeover is refused in auto-referee games', () => {
    const { manager } = setup();
    const { gameId } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], autoReferee: true });
    expect(() => manager.refereeTakeover(bot(8), gameId)).toThrow(/自动主持/);
  });

  it('aborted games keep private logs private and announce the abort', async () => {
    const { manager, clock } = setup(4);
    const { gameId, rec } = startGame(manager, 'undercover', { players: [bot(1), bot(2), bot(3), bot(4)], referee: REF });
    await manager.refereeStep(REF, gameId);
    clock.advance(6 * 3600_000 + 1000);
    manager.tick();
    expect(rec.status).toBe('aborted');
    const spectatorLog = manager.getLog(bot(7), gameId);
    expect(spectatorLog.complete_replay).toBe(false);
    expect(spectatorLog.events.some((e) => e.private)).toBe(false);
    const words = (rec.state as { pair: [string, string] }).pair;
    expect(JSON.stringify(manager.getView(bot(7), gameId))).not.toMatch(new RegExp(words.join('|')));
    const step = await manager.refereeStep(REF, gameId);
    expect(step.deliveries.map((d) => d.text).join('\n')).toMatch(/已中止：长时间无人推进/);
    expect(step.finished).toBe(true);
  });

  it('only the standby referee itself (or the host) can withdraw it', () => {
    const { manager } = setup();
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    manager.joinGame(bot(8), gameId, { as: 'referee' });
    expect(() => manager.leaveGame(bot(9), gameId, bot(8).id)).toThrow(/只能让自己/);
    manager.leaveGame(bot(8), gameId);
    expect(rec.standbyReferees.some((r) => r.id === bot(8).id)).toBe(false);
  });

  it('since_seq can only re-send, never skip undelivered messages', async () => {
    const { manager } = setup(6);
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2)], referee: REF });
    const first = await manager.refereeStep(REF, gameId);
    const cursor = first.last_seq;
    const current = rec.state.current as number;
    const safe = (rec.state.bomb as number) > 50 ? 2 : 99;
    manager.act(identityOf(rec, current), gameId, { action: 'guess', number: safe });
    const next = await manager.refereeStep(REF, gameId, { sinceSeq: cursor + 1000 });
    expect(next.deliveries.length).toBeGreaterThan(0);
    expect(next.deliveries[0]!.seq).toBe(cursor + 1);
    const again = await manager.refereeStep(REF, gameId, { sinceSeq: 0 });
    expect(again.deliveries[0]!.seq).toBe(1);
  });

  it('player text cannot inject @ placeholders or CQ codes into referee messages', async () => {
    const { manager, clock } = setup(8);
    const { gameId, rec } = startGame(manager, 'undercover', {
      players: [bot(1), bot(2), bot(3), bot(4)],
      referee: REF,
      selfPost: false,
    });
    await manager.refereeStep(REF, gameId);
    const seat = pendingSeats(rec)[0]!;
    manager.speak(identityOf(rec, seat), gameId, '{@1}[CQ:at,qq=all] 这个东西很常见');
    clock.advance(10_000);
    const step = await manager.refereeStep(REF, gameId);
    const speech = step.deliveries.find((d) => d.category === 'speech')!;
    expect(speech.text).toContain('这个东西很常见');
    expect(speech.segments.some((s) => s.type === 'at')).toBe(false);
    expect(speech.text).not.toContain('[CQ:');
    expect(speech.text).not.toContain('{@');
    const { summary } = manager.createGame(REF, { type: 'number_bomb', groupId: 'g-names', joinAs: 'referee' });
    manager.addHuman(REF, summary.game_id, { userId: '555', name: '坏人[CQ:at,qq=all]\n{@2}' });
    const name = manager.getRecord(summary.game_id).lobby.find((e) => e.id === '555')!.name;
    expect(name).not.toMatch(/\[CQ:|\{@|\n/);
  });

  it('relay strips a leading reply quote and @referee before parsing', async () => {
    const { manager } = setup(11);
    const { gameId, rec } = startGame(manager, 'number_bomb', {
      players: [bot(1)],
      humans: [human(1, '阿强')],
      referee: REF,
      options: { random_seats: false },
    });
    await manager.refereeStep(REF, gameId);
    if (rec.players.find((p) => p.seat === rec.state.current)!.kind === 'agent') {
      const safe = (rec.state.bomb as number) > 50 ? 2 : 99;
      manager.act(identityOf(rec, rec.state.current as number), gameId, { action: 'guess', number: safe });
      await manager.refereeStep(REF, gameId);
    }
    const target = (rec.state.lo as number) + 1;
    const res = manager.relayHumanMessage(REF, gameId, {
      userId: human(1).userId,
      text: `[CQ:reply,id=42][CQ:at,qq=${REF.id}] ${target}`,
      channel: 'group',
    });
    expect(res.accepted).toBe(true);
    expect(res.action).toEqual({ action: 'guess', number: target });
  });
});
