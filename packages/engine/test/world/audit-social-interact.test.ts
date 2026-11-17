/** 审计回归：社交（长期愿望耗尽）与互动（停机多日的公共事件实例）。 */
import { afterEach, describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { GOALS } from '../../src/world/content.js';
import { createWorld } from '../../src/world/index.js';
import { refillGoals } from '../../src/world/social.js';
import { nextDate } from '../../src/world/time.js';
import { makeTown, tempDb } from './helpers.js';

const DAY = 24 * 3_600_000;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('审计 13：长期愿望全部达成后仍能补上新的长期愿望', () => {
  it('5 条长期愿望都完成过，refillGoals 仍补出一条新的 active 长期愿望，旧记录保留', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const longs = GOALS.filter((g) => g.kind === 'long');
    // 把所有长期愿望置为已完成
    t.w.db.run("UPDATE resident_goals SET status = 'completed' WHERE resident_id = ? AND kind = 'long'", a.residentId);
    for (const g of longs) {
      const done = t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND def_id = ? AND status = 'completed'", a.residentId, g.id);
      if (done) continue;
      t.w.db.run(
        "INSERT INTO resident_goals(goal_id, resident_id, def_id, def_version, def_json, kind, progress_json, status, created_at) VALUES (?,?,?,?,?,'long','{}','completed',?)",
        t.w.id('g'),
        a.residentId,
        g.id,
        g.version,
        JSON.stringify(g),
        t.clock.t,
      );
    }
    const before = t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND kind = 'long' AND status = 'completed'", a.residentId);
    t.advance(DAY); // 新的一天，补愿望的日限重置
    t.w.commit(() => refillGoals(t.w, t.w.mustResident(a.residentId), t.clock.t));
    expect(t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND kind = 'long' AND status = 'active'", a.residentId)).toBe(1);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND kind = 'long' AND status = 'completed'", a.residentId)).toBe(before);
  });
});

describe('审计 31：多日停机后中间的世界日补记「错过」的公共事件实例', () => {
  it('停机 4 天后重开，中间每个日子里该日应有的事件都有 missed 实例', () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const t = makeTown({ dbPath: db.path });
    t.advance(1000);
    const startDate = t.w.today(t.clock.t);
    t.w.close();
    t.clock.advance(4 * DAY);
    const w = createWorld({ dbPath: db.path, registry: createRegistry({}), now: t.clock.now, rng: new SeededRng('audit31'), seed: 'town-test', params: {}, log: () => {}, devLogin: true });
    w.startSync();
    t.w = w;
    const today = w.today(t.clock.t);
    for (let d = nextDate(startDate); d < today; d = nextDate(d)) {
      const rows = w.db.all('SELECT status FROM public_event_instances WHERE business_date = ?', d);
      expect(rows.length, `日期 ${d}`).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === 'missed')).toBe(true);
    }
  });

  it('停机超过 14 天时，补的是离今天最近的日子（昨天和前天都有 missed 行）', () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const t = makeTown({ dbPath: db.path });
    t.advance(1000);
    t.w.close();
    t.clock.advance(30 * DAY);
    const w = createWorld({ dbPath: db.path, registry: createRegistry({}), now: t.clock.now, rng: new SeededRng('audit31b'), seed: 'town-test', params: {}, log: () => {}, devLogin: true });
    w.startSync();
    t.w = w;
    const today = w.today(t.clock.t);
    for (const d of [nextDate(today, -1), nextDate(today, -2), nextDate(today, -14)]) {
      const rows = w.db.all('SELECT status FROM public_event_instances WHERE business_date = ?', d);
      expect(rows.length, `日期 ${d}`).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === 'missed')).toBe(true);
    }
    // 更早的日子不回补
    expect(w.db.scalar('SELECT COUNT(*) FROM public_event_instances WHERE business_date < ? AND business_date > ?', nextDate(today, -15), nextDate(today, -29))).toBe(0);
  });
});
