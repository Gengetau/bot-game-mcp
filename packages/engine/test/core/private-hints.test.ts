import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { createRegistry } from '../../src/games/index.js';
import { SeededRng } from '../../src/core/rng.js';
import { FakeClock, REF, human, setup, startGame } from '../helpers.js';

const ROLES = { roles: { werewolf: 2, seer: 1, villager: 3 }, claim_phase: false, sheriff: false, win_mode: 'side', night_min_s: 0, random_seats: false };

function seerGame() {
  const { manager, clock } = setup('hints');
  const humans = [1, 2, 3, 4, 5, 6].map((n) => human(n, `玩家${n}`));
  const { gameId, rec } = startGame(manager, 'werewolf', { players: [], humans, referee: REF, options: ROLES });
  const roles = (rec.state as any).roles as Record<string, string>;
  const seat = Number(Object.keys(roles).find((s) => roles[s] === 'seer'));
  const seer = rec.players.find((p) => p.seat === seat)!;
  const toSeer = () => rec.log.filter((e) => e.audience.type === 'seats' && e.audience.seats.includes(seat));
  return { manager, clock, gameId, rec, seat, seer, toSeer };
}

describe('private prompts for humans', () => {
  it('list the choices with seat number and name', async () => {
    const g = seerGame();
    await g.manager.refereeStep(REF, g.gameId);
    const prompt = g.toSeer().find((e) => e.kind === 'prompt')!;
    const other = g.rec.players.find((p) => p.seat !== g.seat)!;
    expect(prompt.text).toContain(`${other.seat}号 ${other.name}`);
    expect(prompt.text).not.toContain(`${g.seat}号 ${g.seer.name}`); // 不能验自己
  });

  it('a check result names the player', async () => {
    const g = seerGame();
    await g.manager.refereeStep(REF, g.gameId);
    const target = g.rec.players.find((p) => p.seat !== g.seat)!;
    const r = g.manager.relayHumanMessage(REF, g.gameId, { userId: g.seer.id, text: `验${target.name}`, channel: 'private' });
    expect(r.accepted).toBe(true);
    expect(g.toSeer().some((e) => e.text.includes(`查验结果：${target.seat}号 ${target.name} 是`))).toBe(true);
  });

  it('an unreadable private command gets the how-to again instead of silence', async () => {
    const g = seerGame();
    await g.manager.refereeStep(REF, g.gameId);
    const r = g.manager.relayHumanMessage(REF, g.gameId, { userId: g.seer.id, text: '帮我看看那个人', channel: 'private' });
    expect(r.recognized).toBe(true);
    expect(r.accepted).toBe(false);
    const last = g.toSeer().pop()!;
    expect(last.text).toContain('没看懂这条指令');
    expect(last.text).toContain('请私聊回复');
  });

  it('a command after the phase is over is answered, small talk is not', async () => {
    const g = seerGame();
    await g.manager.refereeStep(REF, g.gameId);
    g.manager.relayHumanMessage(REF, g.gameId, { userId: g.seer.id, text: '过', channel: 'private' });
    const target = g.rec.players.find((p) => p.seat !== g.seat)!;
    const before = g.toSeer().length;
    const r = g.manager.relayHumanMessage(REF, g.gameId, { userId: g.seer.id, text: `验${target.seat}`, channel: 'private' });
    expect(r.accepted).toBe(false);
    const after = g.toSeer();
    expect(after.length).toBe(before + 1);
    expect(after.pop()!.text).toContain('现在不是你的私聊行动时间');
    const chat = g.manager.relayHumanMessage(REF, g.gameId, { userId: g.seer.id, text: '今天天气不错啊', channel: 'private' });
    expect(chat.recognized).toBe(false);
    expect(g.toSeer().length).toBe(before + 1);
  });
});

describe('server default options', () => {
  it('apply to rooms opened straight through create_game; options passed in still win', () => {
    const clock = new FakeClock();
    const manager = new GameManager({
      registry: createRegistry(),
      now: clock.now,
      rng: new SeededRng(1),
      defaultOptions: { night_timeout_s: 150, witch_sees_victim: 'always', target: 9 },
    });
    const a = manager.createGame({ id: '101', name: 'Bot1' }, { type: 'werewolf', groupId: '1' });
    const ra = manager.getRecord(a.summary.game_id) as any;
    expect(ra.options.night_timeout_s).toBe(150);
    expect(ra.options.witch_sees_victim).toBe('always');
    expect(ra.options.target).toBeUndefined(); // 狼人杀不认识的键被忽略
    const b = manager.createGame({ id: '102', name: 'Bot2' }, { type: 'werewolf', groupId: '2', options: { night_timeout_s: 90 } });
    expect((manager.getRecord(b.summary.game_id) as any).options.night_timeout_s).toBe(90);
  });
});
