/**
 * ResidentRunner 的导航续租：navigate 被接受后，运行器用普通程序（不经过模型）按 renewEveryMs 续导航控制租约。
 * 假时钟 + 假端口。
 */
import { describe, expect, it } from 'vitest';
import { ControlLostError, ResidentRunner, TownNetworkError, type ActResult, type Decision, type DecisionContext } from '../src/index.js';
import { FakeClock, FakePort, chat, ev } from './fakes.js';

const nav = (navigationId = 'nav1', revision = 1, extra: Record<string, unknown> = {}) => ({ navigationId, revision, to: { kind: 'place', id: 'tea_house', name: '栖灯茶馆' }, renewEveryMs: 3000, ...extra });

async function rig(decide: (ctx: DecisionContext) => Decision | null) {
  const clock = new FakeClock();
  const port = new FakePort(clock);
  const runner = new ResidentRunner({ clock });
  const calls: DecisionContext[] = [];
  const handle = runner.add({
    town: port,
    profile: { name: '小测' },
    decideOnStart: false,
    decide: (ctx) => {
      calls.push(ctx);
      return decide(ctx);
    },
  });
  await clock.advance(0);
  return { clock, port, runner, handle, calls };
}

/** 第一次决策就 navigate；端口回 accepted。 */
function goTea(r: Awaited<ReturnType<typeof rig>>) {
  r.port.actBehavior = (a) => {
    if (a.action.type === 'stop_navigation') r.port.walking = null;
    if (a.action.type !== 'navigate') return undefined;
    r.port.walking = { to: '栖灯茶馆', navigation_id: 'nav1', revision: 1, arrive_at: r.clock.now() + 13_000, lease_until: r.clock.now() + 10_000 };
    return { ok: true, requestId: a.opts.requestId ?? 'x', status: 'accepted', contextVersion: 1, activityId: null, cursor: 'c1', navigation: nav() } as ActResult;
  };
}

describe('ResidentRunner：导航续租', () => {
  it('navigate 被接受后每 3 秒续一次，不调用模型；you_arrived 之后停下，没有悬挂的定时器', async () => {
    const r = await rig((ctx) => (ctx.triggers.includes('chat') ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : null));
    goTea(r);
    r.port.push(chat('r_x', '去茶馆吧'));
    await r.clock.advance(3100);
    expect(r.calls).toHaveLength(1);
    expect(r.port.acts.map((a) => a.action.type)).toEqual(['navigate']);
    const t0 = r.clock.now();
    await r.clock.advance(9_100);
    expect(r.port.renews.length).toBe(3);
    expect(r.port.renews.every((x) => x.navigationId === 'nav1' && x.revision === 1)).toBe(true);
    expect(r.port.renews.map((x) => x.at - t0)).toEqual([3000, 6000, 9000].map((x) => x - 100));
    expect(r.calls).toHaveLength(1); // 续租没有调用模型
    // 到了
    r.port.walking = null;
    r.port.push(ev('you_arrived', { space: 'tea_house', name: '栖灯茶馆' }));
    await r.clock.advance(100);
    const n = r.port.renews.length;
    await r.clock.advance(10_000);
    expect(r.port.renews.length).toBe(n);
    await r.runner.stop();
    expect(r.clock.pendingTimers).toBe(0);
  });

  it('nav_stopped、续租返回 navigation:null、自己 stop_navigation 都会停掉续租', async () => {
    for (const how of ['nav_stopped', 'null', 'stop'] as const) {
      let step = 0;
      const r = await rig(() => (step++ === 0 ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : how === 'stop' ? { actions: [{ type: 'stop_navigation' }] } : null));
      goTea(r);
      r.port.push(chat('r_x', '走'));
      await r.clock.advance(3100);
      await r.clock.advance(3000);
      const before = r.port.renews.length;
      expect(before).toBeGreaterThanOrEqual(1);
      if (how === 'nav_stopped') {
        r.port.walking = null;
        r.port.push(ev('nav_stopped', { reason: 'blocked' }));
      }
      else if (how === 'null') r.port.renewBehavior = () => ({ ok: false, navigation: null });
      else r.port.push(chat('r_x', '等等'));
      await r.clock.advance(10_000);
      const after = r.port.renews.length;
      await r.clock.advance(20_000);
      expect(r.port.renews.length, how).toBe(after);
      await r.runner.stop();
      expect(r.clock.pendingTimers).toBe(0);
    }
  });

  it('改道：续租返回新的一条（编号 + 版本），之后续的是新的那一条', async () => {
    const r = await rig((ctx) => (ctx.triggers.includes('chat') ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : null));
    goTea(r);
    r.port.push(chat('r_x', '走'));
    await r.clock.advance(3100);
    r.port.renewBehavior = (n) => (n.navigationId === 'nav1' ? { ok: false, navigation: nav('nav2', 2) } : { ok: true, leaseUntil: 1, navigation: nav('nav2', 2) });
    await r.clock.advance(3000);
    await r.clock.advance(3000);
    const ids = r.port.renews.map((x) => `${x.navigationId}/${x.revision}`);
    expect(ids[0]).toBe('nav1/1');
    expect(ids.slice(1).every((x) => x === 'nav2/2')).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await r.runner.stop();
    expect(r.clock.pendingTimers).toBe(0);
  });

  it('续租出错（网络抖动）不让运行器崩，下个周期再试；control_lost 则停手', async () => {
    const r = await rig((ctx) => (ctx.triggers.includes('chat') ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : null));
    goTea(r);
    r.port.push(chat('r_x', '走'));
    await r.clock.advance(3100);
    let fail = 2;
    r.port.renewBehavior = async (n) => {
      if (fail-- > 0) throw new TownNetworkError('network', '断线', { tool: 'heartbeat' });
      return { ok: true, leaseUntil: 1, navigation: nav(n.navigationId, n.revision ?? 1) };
    };
    await r.clock.advance(12_000);
    expect(r.port.renews.length).toBeGreaterThanOrEqual(4); // 失败两次后继续
    expect(r.handle.status).toBe('running');
    const lost = r.port.renews.length;
    r.port.renewBehavior = async () => {
      throw new ControlLostError('control_lost', '没有控制权', { tool: 'heartbeat' });
    };
    await r.clock.advance(3100);
    const afterLost = r.port.renews.length;
    expect(afterLost).toBe(lost + 1);
    await r.clock.advance(20_000);
    expect(r.port.renews.length).toBe(afterLost);
    await r.runner.stop();
    expect(r.clock.pendingTimers).toBe(0);
  });

  it('视图里出现 location.walking（比如运行器重启）也会开始续租', async () => {
    const clock = new FakeClock();
    const port = new FakePort(clock);
    port.walking = { to: '栖灯茶馆', navigation_id: 'navX', revision: 4, arrive_at: clock.now() + 9000, lease_until: clock.now() + 5000 };
    const runner = new ResidentRunner({ clock });
    runner.add({ town: port, profile: { name: '小测' }, decide: () => null });
    await clock.advance(7000);
    expect(port.renews.length).toBeGreaterThanOrEqual(2);
    expect(port.renews[0]).toMatchObject({ navigationId: 'navX', revision: 4 });
    await runner.stop();
    expect(clock.pendingTimers).toBe(0);
  });

  it('正常退出时还在走：先 stop_navigation（stop({leave:true}) 则 leave）', async () => {
    const r = await rig((ctx) => (ctx.triggers.includes('chat') ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : null));
    goTea(r);
    r.port.push(chat('r_x', '走'));
    await r.clock.advance(3100);
    await r.runner.stop();
    expect(r.port.stops).toBe(1);
    expect(r.clock.pendingTimers).toBe(0);

    const r2 = await rig((ctx) => (ctx.triggers.includes('chat') ? { actions: [{ type: 'navigate', to: 'tea_house' }] } : null));
    goTea(r2);
    r2.port.push(chat('r_x', '走'));
    await r2.clock.advance(3100);
    await r2.runner.stop({ leave: true });
    expect(r2.port.leaves).toBe(1);
    expect(r2.port.stops).toBe(0);
    expect(r2.clock.pendingTimers).toBe(0);
  });
});
