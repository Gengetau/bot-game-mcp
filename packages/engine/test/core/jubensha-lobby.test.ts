import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStateStore } from '../../src/core/store.js';
import { memoryLibrary } from '../../src/games/jubensha/index.js';
import { REF, bot, human, setup } from '../helpers.js';

const demo = JSON.parse(readFileSync(join(__dirname, '../../examples/jubensha/demo-rainy-bookshop.json'), 'utf8'));
const six = { ...demo, id: 'six', title: '六人测试本', players: 6,
  roles: [...demo.roles, { ...demo.roles[0], key: 'extra1' }, { ...demo.roles[1], key: 'extra2' }] };
const scripts = () => memoryLibrary([six]);

function lobby(options: Record<string, unknown> = {}, autoReferee = true) {
  const { manager } = setup(1, undefined, { scripts: scripts() });
  const { summary } = manager.createGame(bot(1), { type: 'jubensha', groupId: '9000', autoReferee, options });
  return { manager, id: summary.game_id };
}

describe('jubensha lobby hardening on PR31 (FB261108-01)', () => {
  it('pins the default script before the administrator changes it', () => {
    let selected = 'six';
    const { manager } = setup(1, undefined, { scripts: memoryLibrary([six, demo]), defaultScript: () => selected });
    const { summary } = manager.createGame(bot(1), { type: 'jubensha', groupId: '9000', autoReferee: true });
    selected = demo.id;
    expect(manager.getRecord(summary.game_id).options.script).toBe('six');
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), summary.game_id);
    manager.startGame(bot(1), summary.game_id);
    expect(manager.getRecord(summary.game_id).state.pack.id).toBe('six');
  });

  it('persists the unique script selection through a store round trip', () => {
    const { manager, id } = lobby();
    const store = new MemoryStateStore();
    store.schedule(() => JSON.parse(JSON.stringify(manager.snapshot())));
    store.flush();
    const restored = setup(1, store, { scripts: memoryLibrary([six, demo]), defaultScript: () => demo.id }).manager;
    expect(restored.getRecord(id).options.script).toBe('six');
    expect(restored.summary(restored.getRecord(id)).max_players).toBe(6);
  });

  for (const as of ['player', 'either'] as const) {
    it(`rejects an existing referee changing to ${as} when the six seats are full`, () => {
      const { manager, id } = lobby();
      for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
      manager.joinGame(REF, id, { as: 'referee' });
      const before = JSON.stringify(manager.snapshot());
      expect(() => manager.joinGame(REF, id, { as })).toThrow(/人数已满/);
      expect(JSON.stringify(manager.snapshot())).toBe(before);
      manager.joinGame(bot(1), id); // Same identity remains idempotent.
    });
  }

  it('allows a referee to become a player after one player leaves', () => {
    const { manager, id } = lobby();
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    manager.joinGame(REF, id, { as: 'referee' });
    manager.leaveGame(bot(6), id);
    manager.joinGame(REF, id, { as: 'player' });
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players.map(p => p.id)).toContain(REF.id);
  });

  it('reserves the DM seat for the named candidate, then admits six roles plus DM', () => {
    const { manager, id } = lobby({ host: '107' });
    expect(manager.summary(manager.getRecord(id)).max_players).toBe(6);
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    const before = JSON.stringify(manager.snapshot());
    expect(() => manager.joinGame(bot(8), id)).toThrow(/人数已满/);
    expect(JSON.stringify(manager.snapshot())).toBe(before);
    manager.joinGame(bot(7), id);
    expect(manager.summary(manager.getRecord(id)).max_players).toBe(7);
    expect(() => manager.joinGame(bot(8), id)).toThrow(/人数已满/);
    manager.startGame(bot(1), id);
    const rec = manager.getRecord(id);
    expect(rec.players).toHaveLength(7);
    expect(Object.keys(rec.state.cast)).toHaveLength(6);
    expect(rec.players.find(p => p.seat === rec.state.host)?.id).toBe('107');
  });

  it('checks a renamed candidate before admitting an existing referee as DM', () => {
    const { manager, id } = lobby({ host: '主持人' });
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    manager.joinGame(REF, id, { as: 'referee' });
    manager.joinGame({ ...REF, name: '主持人' }, id, { as: 'player' });
    manager.startGame(bot(1), id);
    const rec = manager.getRecord(id);
    expect(rec.players.find(p => p.seat === rec.state.host)?.id).toBe(REF.id);
  });

  it('applies the reserved DM seat to human registrations', () => {
    const { manager, id } = lobby({ host: human(1).userId, stage: 'group' });
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    expect(() => manager.addHuman(bot(1), id, human(2))).toThrow(/人数已满/);
    manager.addHuman(bot(1), id, human(1));
    manager.addHuman(bot(1), id, human(1));
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players).toHaveLength(7);
  });

  it('still draws an independent referee from six roles plus a protected DM', () => {
    const { manager, id } = lobby({ host: '107' }, false);
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    manager.joinGame(bot(7), id);
    manager.joinGame(bot(8), id);
    expect(() => manager.joinGame(bot(9), id)).toThrow(/人数已满/);
    manager.startGame(bot(1), id);
    const rec = manager.getRecord(id);
    expect(rec.players).toHaveLength(7);
    expect(rec.referee?.id).not.toBe('107');
    expect(rec.players.find(p => p.seat === rec.state.host)?.id).toBe('107');
  });

  it('keeps PR31 ordered substitutes for legacy overfull rooms', () => {
    const { manager, id } = lobby();
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    const rec = manager.getRecord(id);
    for (let n = 7; n <= 10; n++) rec.lobby.push({ ...bot(n), kind: 'agent', pref: 'either', selfPost: true, joinedAt: rec.createdAt + n });
    expect(() => manager.joinGame(bot(11), id)).toThrow(/人数已满/);
    manager.startGame(bot(1), id);
    expect(rec.players).toHaveLength(6);
    expect(rec.lobby).toHaveLength(10);
    expect(rec.players.map(p => p.id).sort()).toEqual(Array.from({ length: 6 }, (_, n) => bot(n + 1).id).sort());
  });
});
