/**
 * S0 小补丁：共同活动视图的 startedAt、interactionTimeScale（开服参数，只缩短）。
 * personReach 在 /config 里的断言在 http.test.ts；小游戏等人时限早就是参数 activityLobbyTtlMs（games.test.ts 里有到点自动散的用例）。
 */
import { describe, expect, it } from 'vitest';
import { resolveParams } from '../../src/world/params.js';
import { publicView } from '../../src/world/views.js';
import { makeTown, type Actor, type Town } from './helpers.js';

const TABLE1 = 'tea_house:table1';
const SEC = 1000;

function pair(params: Record<string, unknown> = {}): { t: Town; a: Actor; b: Actor } {
  const t = makeTown({ seed: 's0', params: { shortGoals: 0, longGoals: 0, socialDecayPerHour: 0, interestDecayPerHour: 0, ...params } });
  const a = t.join('阿灯', 'human');
  const b = t.join('小岚', 'agent');
  a.go(TABLE1);
  b.go(TABLE1);
  a.heartbeat();
  b.heartbeat();
  return { t, a, b };
}

describe('InteractionView.startedAt', () => {
  it('等人时为 null，开始后等于开始那一刻，和 endsAt 同一口径；here 与本人视图一致', () => {
    const { t, a, b } = pair();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    expect(ix.startedAt).toBeNull();
    expect(ix.endsAt).toBeNull();
    b.act('join_interaction', { interactionId: ix.id });
    t.advance(7 * SEC);
    a.heartbeat();
    b.heartbeat();
    const beginAt = t.clock.t;
    a.act('begin_interaction', { interactionId: ix.id });
    const mine = a.view().interaction!;
    expect(mine.startedAt).toBe(beginAt);
    expect(mine.endsAt! - mine.startedAt!).toBe(600 * SEC);
    // 同处一地的人在 here.objects 里看到的是同一场活动，开始时刻和我看到的一样
    const seen = b.view().here!.objects.find((o) => o.id === TABLE1)!.active!;
    expect(seen.startedAt).toBe(beginAt);
    expect(seen.endsAt).toBe(mine.endsAt);
  });

  it('同一个镇里不在桌边的人（留在广场）：开桌、开始之后，视图、事件、公开视图里都没有这场活动，也没有 startedAt', () => {
    const { t, a, b } = pair();
    const c = t.join('阿木', 'agent');
    c.heartbeat();
    const cur0 = c.view().cursor;
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    t.advance(7 * SEC);
    a.heartbeat();
    b.heartbeat();
    a.act('begin_interaction', { interactionId: ix.id });
    // 正面对照：参与者的视图里确实有这个字段，下面的「没有」不会因改名而空过
    expect(JSON.stringify(a.view())).toContain('startedAt');
    expect(a.view().interaction!.startedAt).not.toBeNull();
    c.heartbeat();
    const mine = JSON.stringify(c.view());
    expect(mine).not.toContain('startedAt');
    expect(c.view().interaction).toBeNull();
    expect(JSON.stringify(c.events(cur0))).not.toContain('startedAt');
    expect(JSON.stringify(publicView(t.w))).not.toContain('startedAt');
  });
});

describe('interactionTimeScale', () => {
  it('默认 1：十分钟照旧，文字不变', () => {
    const { t, a, b } = pair();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    expect(ix.cost).toContain('十分钟');
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    expect(a.view().interaction!.endsAt! - t.clock.t).toBe(600 * SEC);
  });

  it('0.1：结束时刻、定时任务、文字都按 60 秒', () => {
    const { t, a, b } = pair({ interactionTimeScale: 0.1 });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    expect(ix.cost).not.toContain('十分钟');
    expect(ix.cost).toContain('约 60 秒');
    expect(a.view().here!.objects.find((o) => o.id === TABLE1)!.action!.cost).toContain('约 60 秒');
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    const started = t.clock.t;
    expect(a.view().interaction!.endsAt).toBe(started + 60 * SEC);
    const job = t.w.db.get('SELECT due_at FROM scheduled_jobs WHERE dedupe_key = ?', `ix:${ix.id}`);
    expect(Number(job?.due_at)).toBe(started + 60 * SEC);
    t.advanceAlive(50 * SEC, [a, b], 10 * SEC);
    expect(a.view().interaction).not.toBeNull();
    t.advanceAlive(12 * SEC, [a, b], 2 * SEC);
    expect(a.view().interaction).toBeNull();
  });

  it('非法值在加载配置时被拒：0、负数、大于 1', () => {
    for (const bad of [0, -1, 1.5, 100]) expect(() => resolveParams({ interactionTimeScale: bad }), String(bad)).toThrow(/interactionTimeScale/);
    expect(resolveParams({}).interactionTimeScale).toBe(1);
    expect(resolveParams({ interactionTimeScale: 0.01 }).interactionTimeScale).toBe(0.01);
  });
});

describe('报名时限 activityLobbyTtlMs 是开服参数', () => {
  it('设成 30 秒：开了桌没人来，30 秒后自动散（默认 10 分钟）', () => {
    expect(resolveParams({}).activityLobbyTtlMs).toBe(10 * 60 * SEC);
    const { t, a } = pair({ activityLobbyTtlMs: 30 * SEC });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    expect(ix.lobbyExpiresAt - t.clock.t).toBe(30 * SEC);
    t.advanceAlive(25 * SEC, [a], 5 * SEC);
    expect(a.view().interaction).not.toBeNull();
    t.advanceAlive(10 * SEC, [a], 5 * SEC);
    expect(a.view().interaction).toBeNull();
  });
});
