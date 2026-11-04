import { describe, expect, it } from 'vitest';
import { REF, bot, playToEnd, setup, startGame } from '../helpers.js';

interface Ev {
  seq: number;
}
const seqs = (v: unknown): number[] => ((v as { new_events: Ev[] }).new_events ?? []).map((e) => e.seq);
const contiguous = (xs: number[]) => xs.every((x, i) => x === i + 1);

describe('视角内的事件编号', () => {
  it('每个视角的 seq 都连续，不能从空档数量推断别人的私密事件', async () => {
    const { manager, clock } = setup(7);
    const players = Array.from({ length: 9 }, (_, i) => bot(i + 1));
    const { gameId, rec } = startGame(manager, 'werewolf', { players, referee: REF });
    await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 14 });
    expect(rec.status).toBe('running');
    expect(rec.log.some((e) => e.audience.type !== 'public')).toBe(true);

    const counts = new Set<number>();
    for (const p of players) {
      const s = seqs(manager.getView(p, gameId, { fullLog: true }));
      expect(contiguous(s)).toBe(true);
      counts.add(s.length);
    }
    // 狼人、预言家等看到的事件比村民多，但各自的编号都是 1..n
    expect(counts.size).toBeGreaterThan(1);

    const spy = seqs(manager.getView({ id: '555', name: 'Spy' }, gameId, { fullLog: true }));
    expect(contiguous(spy)).toBe(true);
    expect(spy.length).toBeLessThan(rec.log.length);

    // get_game_log 的 since_seq 也按视角内编号
    const p1 = players[0]!;
    const before = seqs(manager.getView(p1, gameId, { fullLog: true })).length;
    const log = manager.getLog(p1, gameId, { sinceSeq: 3 });
    expect(log.events[0]?.seq).toBe(4);
    expect(log.events.length).toBe(before - 3);

    // 增量视图：只返回新事件，编号接着上次
    await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 6 });
    expect(rec.status).toBe('running');
    const inc = seqs(manager.getView(p1, gameId));
    expect(inc.length).toBeGreaterThan(0);
    expect(inc[0]).toBe(before + 1);

    // 正常结束后公开完整复盘：所有人看到全部事件，编号仍连续
    await playToEnd(manager, gameId, { referee: REF, clock });
    expect(rec.status).toBe('ended');
    const full = seqs(manager.getView(p1, gameId, { fullLog: true }));
    expect(full.length).toBe(rec.log.length);
    expect(contiguous(full)).toBe(true);
  });
});
