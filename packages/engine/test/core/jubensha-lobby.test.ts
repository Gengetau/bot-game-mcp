import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { MemoryStateStore } from '../../src/core/store.js';
import { createRegistry } from '../../src/games/index.js';
import { memoryLibrary } from '../../src/games/jubensha/index.js';
import { REF, bot, human, setup } from '../helpers.js';

const demo = JSON.parse(readFileSync(join(__dirname, '../../examples/jubensha/demo-rainy-bookshop.json'), 'utf8'));
const six = { ...demo, id: 'six', title: '六人测试本', players: 6,
  roles: [...demo.roles, { ...demo.roles[0], key: 'extra1' }, { ...demo.roles[1], key: 'extra2' }] };
const scripts = () => memoryLibrary([six]);

function lobby(autoReferee = true, options: Record<string, unknown> = {}, joinAs: 'player' | 'either' | 'referee' = 'either') {
  const { manager } = setup(1, undefined, { scripts: scripts() });
  const opened = manager.createGame(bot(1), { type: 'jubensha', groupId: '9000', autoReferee, options, joinAs });
  return { manager, opened, id: opened.summary.game_id };
}

describe('jubensha lobby capacity (FB261108-01)', () => {
  it('pins the selected default script when a room is created', () => {
    let selected = 'six';
    const { manager } = setup(1, undefined, { scripts: memoryLibrary([six, demo]), defaultScript: () => selected });
    const { summary } = manager.createGame(bot(1), { type: 'jubensha', groupId: '9000', autoReferee: true });
    selected = demo.id;
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), summary.game_id);
    expect(manager.getRecord(summary.game_id).options.script).toBe('six');
    expect(manager.summary(manager.getRecord(summary.game_id)).max_players).toBe(6);
    manager.startGame(bot(1), summary.game_id);
    expect(manager.getRecord(summary.game_id).state.pack.id).toBe('six');
  });

  it('announces the chosen script count in creation, summary and lobby view', () => {
    const { manager, opened, id } = lobby();
    expect(opened.group_message).toContain('6 名玩家，裁判另计');
    expect(opened.summary).toMatchObject({ min_players: 6, max_players: 6 });
    expect(manager.getView(bot(1), id)).toMatchObject({ min_players: 6, max_players: 6 });
  });

  it('rejects the seventh through tenth default either registrations without changing the lobby', () => {
    const { manager, id } = lobby();
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    const before = JSON.stringify(manager.snapshot());
    for (let n = 7; n <= 10; n++) expect(() => manager.joinGame(bot(n), id)).toThrow(/最多 6 名玩家/);
    expect(() => manager.joinGame(bot(7), id, { as: 'player' })).toThrow(/最多 6 名玩家/);
    expect(JSON.stringify(manager.snapshot())).toBe(before);
    manager.joinGame(bot(1), id); // 重复报名幂等，不占新位
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players).toHaveLength(6);
  });

  it('leaving makes exactly one seat available again', () => {
    const { manager, id } = lobby();
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    manager.leaveGame(bot(6), id);
    manager.joinGame(bot(7), id);
    expect(() => manager.joinGame(bot(8), id)).toThrow(/人数已满/);
  });

  it('allows one extra either when it will actually become referee', () => {
    const { manager, id } = lobby(false);
    for (let n = 2; n <= 7; n++) manager.joinGame(bot(n), id);
    expect(() => manager.joinGame(bot(8), id)).toThrow(/人数已满/);
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players).toHaveLength(6);
    expect(manager.getRecord(id).referee).not.toBeNull();
  });

  it('dedicated referees do not consume seats or allow extra either players', () => {
    const { manager, id } = lobby(false, {}, 'player');
    manager.joinGame(REF, id, { as: 'referee' });
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id, { as: 'player' });
    expect(() => manager.joinGame(bot(7), id)).toThrow(/人数已满/);
    manager.joinGame(bot(8), id, { as: 'referee' });
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players).toHaveLength(6);
  });

  it('does not let existing referees switch to player or either when full', () => {
    const { manager, id } = lobby();
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    manager.joinGame(REF, id, { as: 'referee' });
    const before = JSON.stringify(manager.snapshot());
    for (const as of ['player', 'either'] as const) expect(() => manager.joinGame(REF, id, { as })).toThrow(/人数已满/);
    expect(JSON.stringify(manager.snapshot())).toBe(before);
  });

  it('applies the same cap to humans and allows their duplicate registration', () => {
    const { manager, id } = lobby(true, { stage: 'group' });
    for (let n = 2; n <= 5; n++) manager.joinGame(bot(n), id);
    manager.addHuman(bot(1), id, human(1));
    manager.addHuman(bot(1), id, human(1));
    expect(() => manager.addHuman(bot(1), id, human(2))).toThrow(/人数已满/);
    expect(manager.getRecord(id).lobby).toHaveLength(6);
  });

  it('only reserves an extra DM seat when the named candidate has signed up', () => {
    const { manager, id } = lobby(true, { host: '107' });
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    expect(() => manager.joinGame(bot(8), id)).toThrow(/人数已满/);
    manager.joinGame(bot(7), id);
    expect(manager.summary(manager.getRecord(id))).toMatchObject({ min_players: 6, max_players: 7 });
    expect(() => manager.joinGame(bot(8), id)).toThrow(/人数已满/);
    manager.startGame(bot(1), id);
    const rec = manager.getRecord(id);
    expect(rec.players).toHaveLength(7);
    expect(Object.keys(rec.state.cast)).toHaveLength(6);
    expect(rec.players.find((p) => p.seat === rec.state.host)?.id).toBe('107');
  });

  it('does not draw one of exactly six players away to a hosted referee slot', () => {
    const { manager, id } = lobby(false, {}, 'player');
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id, { as: 'player' });
    manager.offerReferee(bot(1), id, 'offline-host');
    manager.joinGame(REF, id, { as: 'referee' });
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players).toHaveLength(6);
    expect(manager.getRecord(id).referee?.id).toBe(REF.id);
  });

  it('draws from a player when a mixed hosted pool must release one seat', () => {
    const { manager, id } = lobby(false, {}, 'player');
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id, { as: 'player' });
    manager.offerReferee(bot(1), id, 'offline-host');
    manager.joinGame(bot(7), id, { as: 'player' });
    manager.offerReferee(REF, id, 'offline-host');
    manager.startGame(bot(1), id);
    expect(manager.getRecord(id).players).toHaveLength(6);
    expect(manager.getRecord(id).referee?.id).toBe(bot(1).id);
  });

  it('rejects a dedicated referee that would strand seven either players', () => {
    const { manager, id } = lobby(false);
    for (let n = 2; n <= 7; n++) manager.joinGame(bot(n), id);
    expect(() => manager.joinGame(REF, id, { as: 'referee' })).toThrow(/人数已满/);
    expect(() => manager.offerReferee(REF, id, 'offline-host')).toThrow(/人数已满/);
    expect(manager.getRecord(id).lobby).toHaveLength(7);
  });

  it('does not count an account outside the referee allowlist as an extra referee', () => {
    const manager = new GameManager({ registry: createRegistry({ scripts: scripts() }), refereeIds: [REF.id] });
    const { summary } = manager.createGame(bot(1), { type: 'jubensha', groupId: '9000' });
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), summary.game_id);
    expect(() => manager.joinGame(bot(7), summary.game_id)).toThrow(/人数已满/);
  });

  it('enforces the cap after a JSON store round trip', () => {
    const { manager, id } = lobby();
    for (let n = 2; n <= 6; n++) manager.joinGame(bot(n), id);
    const store = new MemoryStateStore();
    store.schedule(() => JSON.parse(JSON.stringify(manager.snapshot())));
    store.flush();
    const restored = setup(1, store, { scripts: scripts() }).manager;
    expect(restored.getView(bot(1), id)).toMatchObject({ min_players: 6, max_players: 6 });
    expect(() => restored.joinGame(bot(7), id)).toThrow(/人数已满/);
    restored.startGame(bot(1), id);
    expect(restored.getRecord(id).players).toHaveLength(6);
  });
});
