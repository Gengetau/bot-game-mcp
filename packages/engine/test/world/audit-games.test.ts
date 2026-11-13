/** 审计回归：小游戏缓存只留进行中的局（第 11/25/27 条）、停机恢复时绝对截止已过则中止（第 16/26/28 条）。 */
import { describe, expect, it } from 'vitest';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';

function openTable(t: Town, actors: Actor[]): string {
  for (const a of actors) a.enter();
  for (const a of actors) a.go('arcade:table1');
  t.advanceAlive(40_000, actors);
  const p = actors[0]!.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
  const id = p.activity.id as string;
  for (const g of actors.slice(1)) g.act('join_game', { activityId: id });
  actors[0]!.act('start_game', { activityId: id });
  return id;
}
const status = (t: Town, id: string) => String(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', id)!.status);

describe('第 11/25/27 条：gameCache 不留已结束的局', () => {
  it('局被中止后缓存里没有它，再读（观战）也不会重新装入', () => {
    const t = makeTown({ params: { gameMaxDurationMs: 60_000 } });
    const ps = [t.join('甲'), t.join('乙', 'agent')];
    const id = openTable(t, ps);
    expect(t.w.gameCache.has(id)).toBe(true);
    t.advanceAlive(70_000, ps);
    expect(status(t, id)).toBe('aborted');
    expect(t.w.gameCache.has(id)).toBe(false);
    ps[0]!.view();
    expect(t.w.gameCache.has(id)).toBe(false);
  });
});

describe('第 16/26/28 条：停机跨过绝对截止则中止', () => {
  it('停机 50 秒（短于上限），截止在停机期间已过：重启后为 aborted', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path, params: { gameMaxDurationMs: 60_000 } });
      const ps = [t.join('甲'), t.join('乙', 'agent')];
      const id = openTable(t, ps);
      const deadline = Number(t.w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', id)!.deadline);
      t.w.close();
      t.clock.advance(deadline - t.clock.t + 10_000);
      t.restart();
      expect(status(t, id)).toBe('aborted');
      expect(t.w.gameCache.has(id)).toBe(false);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });
});
