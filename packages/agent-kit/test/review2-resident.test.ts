import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { InMemoryJournal, ResidentRunner, type JournalState } from '../src/index.js';
import { FakeClock, FakePort } from './fakes.js';

describe('review2 resident', () => {
  it('#4 决策结束后不残留 abort 监听器', async () => {
    const clock = new FakeClock();
    const port = new FakePort(clock);
    const runner = new ResidentRunner({ clock });
    let n = 0;
    runner.add({ town: port, profile: { name: '小测' }, decideOnStart: true, minIntervalMs: 0, idleTickMs: 1000, budgetPerHour: 1000, decide: () => { n++; return null; } });
    await clock.advance(500);
    const res = [...(runner as unknown as { residents: Set<{ ac: AbortController }> }).residents][0]!;
    const base = getEventListeners(res.ac.signal, 'abort').length;
    for (let i = 0; i < 6; i++) await clock.advance(5_000);
    expect(n).toBeGreaterThan(2);
    expect(getEventListeners(res.ac.signal, 'abort').length).toBe(base);
    await runner.stop();
  });

  const crashed = (clock: FakeClock, createdAt: number) => {
    const journal = new InMemoryJournal();
    const state: JournalState = {
      cursor: 'c1', seen: [], calls: [], claims: [],
      pending: { decisionId: 'dold', actions: [{ type: 'speak', text: 'a' }, { type: 'speak', text: 'b' }], done: 1, contextVersion: 1, createdAt },
    };
    journal.save(state);
    return journal;
  };

  it('#7 隔很久再启动：不重放陈旧动作，清日志并计入 discarded', async () => {
    const clock = new FakeClock();
    const journal = crashed(clock, clock.now() - 3_600_000);
    const port = new FakePort(clock);
    const runner = new ResidentRunner({ clock });
    const h = runner.add({ town: port, profile: { name: '小测' }, journal, decideOnStart: false, decide: () => null });
    await clock.advance(500);
    expect(port.acts).toHaveLength(0);
    expect(journal.state?.pending).toBeNull();
    expect(h.stats.discarded).toBe(1);
    await runner.stop();
  });

  it('#7 很快重启：仍然续做；阈值可配置', async () => {
    const clock = new FakeClock();
    const journal = crashed(clock, clock.now() - 60_000);
    const port = new FakePort(clock);
    const runner = new ResidentRunner({ clock });
    runner.add({ town: port, profile: { name: '小测' }, journal, decideOnStart: false, decide: () => null });
    await clock.advance(500);
    expect(port.acts.map((a) => a.opts.requestId)).toEqual(['dold-1']);
    await runner.stop();

    const clock2 = new FakeClock();
    const j2 = crashed(clock2, clock2.now() - 60_000);
    const port2 = new FakePort(clock2);
    const r2 = new ResidentRunner({ clock: clock2 });
    r2.add({ town: port2, profile: { name: '小测' }, journal: j2, decideOnStart: false, maxResumeAgeMs: 1000, decide: () => null });
    await clock2.advance(500);
    expect(port2.acts).toHaveLength(0);
    await r2.stop();
  });
});
