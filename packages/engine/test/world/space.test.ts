/**
 * 空间权威（space.ts）：导航、停步、改道、导航控制租约、区域变化、进出私宅、够得着判定、重启冻结。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { actorOf, controlDisconnected, mapManifest, renewNavigation, sceneView, whereabouts } from '../../src/world/space.js';
import { zoneAt } from '../../src/world/spatial/grid.js';
import { FakeClock } from '../helpers.js';
import { makeTown, tempDb, type Actor, type Town } from './helpers.js';

const loc = (a: Actor) => a.row().location_id;
const nav = (a: Actor) => actorOf(a.t.w, a.residentId)?.nav ?? null;
const types = (a: Actor, cursor: string) => a.events(cursor).events.map((e) => e.type);
const eventsOf = (a: Actor, cursor: string, type: string) => a.events(cursor).events.filter((e) => e.type === type).map((e) => e.data as Record<string, any>);
const town = (t: Town) => t.w.map.scenes.get('town')!;
const arrivedFacts = (t: Town) => t.w.db.all("SELECT payload FROM world_events WHERE type = 'arrived' ORDER BY event_id").map((f) => JSON.parse(String(f.payload)).place);
const zoneUnder = (a: Actor) => zoneAt(town(a.t), a.pos().x, a.pos().z).id;

function renew(a: Actor) {
  const n = nav(a)!;
  return renewNavigation(a.t.w, a.auth, { navigationId: n.navigationId, revision: n.revision });
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('导航：出发、沿路的区域变化、到达', () => {
  it('新居民站在广场的落脚点上，有一条空间角色记录', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const p = a.pos();
    expect(p.scene).toBe('town');
    expect(p.instance).toBe('');
    expect(p.moving).toBe(false);
    expect(zoneUnder(a)).toBe('plaza');
    expect(loc(a)).toBe('plaza');
    expect(a.view().location).toMatchObject({ space: 'plaza', scene: 'town', navigation: null });
  });

  it('navigate 返回一条导航（编号、版本、预计到达、租约），回执里没有路径', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const out = a.act('navigate', { to: 'tea_house' });
    expect(out.status).toBe('accepted');
    expect(out.navigation).toMatchObject({ to: { kind: 'place', id: 'tea_house', name: '栖灯茶馆' }, continues: false, renewEveryMs: t.w.params.navRenewEveryMs });
    expect(out.navigation.leaseUntil).toBe(t.clock.t + t.w.params.navLeaseMs);
    expect(out.navigation.arriveAt).toBeGreaterThan(t.clock.t + 5_000);
    expect(JSON.stringify(out)).not.toContain('points');
    expect(a.view().location.navigation?.navigationId).toBe(out.navigation.navigationId);
    t.advance(1000);
    expect(a.pos().moving).toBe(true);
  });

  it('位置按时间沿折线前进，速度就是地图的速度；区域标签跟着脚下的区域变', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const start = a.pos();
    a.act('navigate', { to: 'tea_house' });
    const seen = new Set<string>();
    let prev = start;
    for (let i = 0; i < 40 && nav(a); i++) {
      t.advance(500);
      if (nav(a)) renew(a);
      const p = a.pos();
      const step = Math.hypot(p.x - prev.x, p.z - prev.z);
      expect(step).toBeLessThanOrEqual(t.w.map.speed * 0.5 + 1e-6);
      prev = p;
      expect(loc(a)).toBe(zoneUnder(a));
      seen.add(loc(a));
    }
    expect([...seen]).toEqual(['plaza', 'road', 'tea_house']);
    expect(nav(a)).toBeNull();
    const anchor = town(t).anchors.get('tea_house')!;
    expect(a.pos()).toMatchObject({ x: anchor.x, z: anchor.z, moving: false });
  });

  it('走出去和走进来的那一刻，两边在场的人各收到一条 left / arrived；本人到了收到 you_arrived', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const c = t.join('阿树');
    c.go('tea_house');
    const cb = b.events().cursor;
    const cc = c.events().cursor;
    const ca = a.events().cursor;
    a.go('tea_house');
    expect(eventsOf(b, cb, 'left')).toEqual([{ resident: { id: a.residentId, name: '阿灯', kind: 'human' }, space: 'plaza' }]);
    expect(eventsOf(b, cb, 'arrived')).toEqual([]);
    expect(eventsOf(c, cc, 'arrived')).toEqual([{ resident: { id: a.residentId, name: '阿灯', kind: 'human' }, space: 'tea_house' }]);
    const arrived = eventsOf(a, ca, 'you_arrived');
    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({ space: 'tea_house', name: '栖灯茶馆' });
    // 事件里没有坐标
    expect(JSON.stringify(b.events(cb).events) + JSON.stringify(c.events(cc).events)).not.toMatch(/"x":|"z":/);
  });

  it('公开流只在公开区域变化时出一条 place，不带坐标和路线', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const cur = t.w.publicCursor();
    a.go('tea_house');
    const places = t.w.readPublicEvents(cur).events.filter((e) => e.type === 'place').map((e) => (e.data as any).resident.at);
    expect(places).toEqual(['road', 'tea_house']);
    expect(JSON.stringify(t.w.readPublicEvents(cur).events)).not.toMatch(/"x":|points|arriveAt/);
  });

  it('到了一个新的地点记一条「到过某处」；路过的路上不记，原地打转不记', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const facts = () => arrivedFacts(t);
    a.go('tea_house');
    expect(facts()).toEqual(['tea_house']);
    const here = a.pos();
    a.go({ x: here.x + 2, z: here.z - 2 });
    expect(facts()).toEqual(['tea_house']);
    // 走到路上停下：不算到过哪里
    a.act('navigate', { to: 'plaza' });
    t.advance(2500);
    expect(loc(a)).toBe('road');
    a.act('stop_navigation');
    expect(facts()).toEqual(['tea_house']);
  });

  it('已经在目的地：already_here；不认识的地方：no_such_place；旧的 move 仍然可用', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    expect(a.fail('navigate', { to: 'plaza' }).reason).toBe('already_here');
    expect(a.fail('navigate', { to: 'moon' }).reason).toBe('no_such_place');
    expect(a.fail('navigate', {}).reason).toBe('no_such_place');
    expect(a.fail('navigate', { to: { x: 'a', z: 1 } }).reason).toBe('no_such_place');
    const out = a.act('move', { to: 'bookshop' });
    expect(out.navigation.to.id).toBe('bookshop');
    a.walk();
    expect(loc(a)).toBe('bookshop');
    // 旧的住宅街编号是住宅接入点的别名
    a.go('street_east');
    expect(loc(a)).toBe('residential');
    expect(a.fail('navigate', { to: 'street_west' }).reason).toBe('already_here');
  });

  it('点地图上的一个点：点偏了取最近的可走点；点得太离谱就 unreachable', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const fountain = town(t).source.obstacles.find((o) => o.id === 'plaza.fountain')!;
    const centre = { x: fountain.x + fountain.w / 2, z: fountain.z + fountain.d / 2 };
    const out = a.go(centre);
    expect(out.navigation.to.kind).toBe('point');
    const p = a.pos();
    expect(Math.hypot(p.x - centre.x, p.z - centre.z)).toBeLessThan(2.5);
    expect(loc(a)).toBe('plaza');
    expect(a.fail('navigate', { to: { x: 30, z: 0.2 } }).reason).toBe('unreachable');
    expect(a.fail('navigate', { to: { x: -50, z: 999 } }).reason).toBe('unreachable');
  });

  it('走向一位居民：停在一米开外；对方不在同一个场景里就 not_here', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    b.go('garden');
    const out = a.go(b.residentId);
    expect(out.navigation.to).toMatchObject({ kind: 'resident', id: b.residentId, name: '小岚' });
    const d = Math.hypot(a.pos().x - b.pos().x, a.pos().z - b.pos().z);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThan(1.3);
    expect(loc(a)).toBe('garden');
    // 已经在身边：不用走
    expect(a.act('navigate', { approach: b.residentId })).toMatchObject({ status: 'completed', already: 'near' });
    b.go('home');
    expect(a.fail('navigate', { to: b.residentId }).reason).toBe('not_here');
    b.leave();
    expect(a.fail('navigate', { to: b.residentId }).reason).toBe('not_here');
  });

  it('改路线有频率上限', () => {
    const t = makeTown({ params: { navBurst: 3, navPerMinute: 6 } });
    const a = t.join('阿灯');
    a.act('navigate', { to: 'tea_house' });
    a.act('navigate', { to: 'garden' });
    a.act('navigate', { to: 'bookshop' });
    const err = a.fail('navigate', { to: 'kitchen' });
    expect(err.code).toBe('rate_limited');
    expect(nav(a)!.target.id).toBe('bookshop');
  });
});

describe('停步与改道', () => {
  it('stop_navigation：停在这一刻的位置，之后不再动；旧的到达任务不会再挪动角色', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const out = a.act('navigate', { to: 'tea_house' });
    t.advance(4000);
    const before = a.pos();
    const stopped = a.act('stop_navigation');
    expect(stopped).toMatchObject({ status: 'completed', stopped: true });
    expect(stopped.at.x).toBeCloseTo(before.x, 2);
    expect(nav(a)).toBeNull();
    expect(loc(a)).toBe(zoneUnder(a));
    t.advanceAlive(60_000, [a], 5000);
    expect(t.clock.t).toBeGreaterThan(out.navigation.arriveAt);
    expect(a.pos()).toMatchObject({ x: before.x, z: before.z, moving: false });
    expect(loc(a)).not.toBe('tea_house');
    // 没在走的时候再停一次：不出错
    expect(a.act('stop_navigation')).toMatchObject({ status: 'completed', stopped: false });
  });

  it('改道：从这一刻的位置出发，版本号递增，旧路线的任务作废', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const first = a.act('navigate', { to: 'tea_house' });
    t.advance(3000);
    const mid = a.pos();
    const second = a.act('navigate', { to: 'garden' });
    expect(second.navigation.navigationId).not.toBe(first.navigation.navigationId);
    expect(second.navigation.revision).toBeGreaterThan(first.navigation.revision);
    const n = nav(a)!;
    expect(n.points[0]).toEqual({ x: mid.x, z: mid.z });
    // 续旧路线：续不上，也不影响新路线
    const stale = renewNavigation(t.w, a.auth, { navigationId: first.navigation.navigationId, revision: first.navigation.revision });
    expect(stale.ok).toBe(false);
    expect(stale.navigation?.navigationId).toBe(second.navigation.navigationId);
    a.walk();
    expect(loc(a)).toBe('garden');
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
  });

  it('正往外走的人说要回脚下这片区域：是改主意要回来，照常走回落脚点；站着不动的才是 already_here', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const first = a.act('navigate', { to: 'tea_house' });
    t.advance(1500);
    expect(zoneUnder(a)).toBe('plaza');
    expect(loc(a)).toBe('plaza');
    const away = a.pos();
    const back = a.act('navigate', { to: 'plaza' });
    expect(back).toMatchObject({ status: 'accepted', navigation: { to: { kind: 'place', id: 'plaza' } } });
    expect(back.navigation.navigationId).not.toBe(first.navigation.navigationId);
    expect(back.navigation.revision).toBeGreaterThan(first.navigation.revision);
    expect(nav(a)!.points[0]).toEqual({ x: away.x, z: away.z });
    a.walk();
    const plaza = town(t).anchors.get('plaza')!;
    expect(a.pos()).toMatchObject({ x: plaza.x, z: plaza.z, moving: false });
    expect(loc(a)).toBe('plaza');
    expect(nav(a)).toBeNull();
    // 没去成别处：不记「到过某处」
    expect(arrivedFacts(t)).toEqual([]);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
    // 站定之后再说去这里：已经在这里
    expect(a.fail('navigate', { to: 'plaza' }).reason).toBe('already_here');
  });

  it('刚迈步就改主意（还站在落脚点上）：不出错，原地到达', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('navigate', { to: 'tea_house' });
    const back = a.act('navigate', { to: 'plaza' });
    expect(['accepted', 'completed']).toContain(back.status);
    a.walk();
    expect(nav(a)).toBeNull();
    expect(loc(a)).toBe('plaza');
    expect(a.pos().moving).toBe(false);
  });

  it('在家里正往门口走、改主意要留下：走回屋里，不出门；站着不动时说回家仍是 already_here', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('home');
    const home = `home:${a.residentId}`;
    expect(a.fail('navigate', { to: 'home' }).reason).toBe('already_here');
    a.go({ x: 5.25, z: 3.75 });
    const out = a.act('navigate', { to: 'tea_house' });
    expect(out.navigation.continues).toBe(true);
    t.advance(400);
    expect(a.pos()).toMatchObject({ scene: 'home', instance: a.residentId, moving: true });
    const stay = a.act('navigate', { to: 'home' });
    expect(stay).toMatchObject({ status: 'accepted', navigation: { to: { kind: 'home', id: home } } });
    expect(stay.navigation.continues ?? false).toBe(false);
    a.walk();
    expect(loc(a)).toBe(home);
    expect(a.pos()).toMatchObject({ scene: 'home', instance: a.residentId, x: 5.25, z: 3.75, moving: false });
    expect(nav(a)).toBeNull();
    expect(a.fail('navigate', { to: 'home' }).reason).toBe('already_here');
  });

  it('快走到时改成去找身边的人：已经在旁边，原来那一趟到此为止，照样记一次「到过某处」', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    b.go('tea_house');
    expect(arrivedFacts(t)).toEqual(['tea_house']);
    a.act('navigate', { to: 'tea_house' });
    const gap = () => Math.hypot(a.pos().x - b.pos().x, a.pos().z - b.pos().z);
    for (let i = 0; i < 400 && nav(a) && gap() > 1.2; i++) {
      t.advance(100);
      if (i % 20 === 19 && nav(a)) {
        a.heartbeat();
        b.heartbeat();
        renew(a);
      }
    }
    // 还差最后一米：人在茶馆里，路还没走完，也还没记过「到过」
    expect(nav(a)).not.toBeNull();
    expect(loc(a)).toBe('tea_house');
    expect(arrivedFacts(t)).toEqual(['tea_house']);
    const cur = a.events().cursor;
    const out = a.act('navigate', { approach: b.residentId });
    expect(out).toMatchObject({ status: 'completed', already: 'near' });
    expect(nav(a)).toBeNull();
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
    expect(arrivedFacts(t)).toEqual(['tea_house', 'tea_house']);
    // 是她自己改的主意：不另发「被截住」
    expect(types(a, cur)).not.toContain('nav_stopped');
  });

  it('改道失败（走不到、没权限）时原来的路线照旧', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const first = a.act('navigate', { to: 'tea_house' });
    t.advance(1000);
    expect(a.fail('navigate', { to: `home:${b.residentId}` }).reason).toBe('no_access');
    expect(nav(a)!.navigationId).toBe(first.navigation.navigationId);
    expect(nav(a)!.revision).toBe(first.navigation.revision);
    a.walk();
    expect(loc(a)).toBe('tea_house');
  });

  it('同一个请求号重放：返回同一份回执，不会再走一遍', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const v = a.view();
    const opts = { requestId: 'nav-replay-0001', actionWindow: v.actionWindow, expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null } };
    const first = a.act('navigate', { to: 'tea_house' }, opts);
    t.advance(2000);
    const again = a.act('navigate', { to: 'tea_house' }, opts);
    expect(again.replayed).toBe(true);
    expect(again.navigation).toEqual(first.navigation);
    expect(nav(a)!.revision).toBe(first.navigation.revision);
  });
});

describe('导航控制租约', () => {
  it('没人续：停在租约到期那一刻的位置，哪怕到期任务晚了很久才处理', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    const from = a.pos();
    const out = a.act('navigate', { to: 'garden' });
    const lease = out.navigation.leaseUntil;
    expect(out.navigation.arriveAt).toBeGreaterThan(lease + 5000);
    const cur = a.events().cursor;
    // 调度器晚了 30 秒才有机会检查
    t.clock.advance(30_000);
    a.heartbeat();
    t.w.tick();
    expect(nav(a)).toBeNull();
    const row = actorOf(t.w, a.residentId)!;
    expect(row.anchor_at).toBe(lease);
    const travelled = Math.hypot(row.x - from.x, row.z - from.z);
    expect(travelled).toBeLessThanOrEqual((t.w.map.speed * t.w.params.navLeaseMs) / 1000 + 1e-6);
    expect(travelled).toBeGreaterThan(5);
    expect(loc(a)).toBe(zoneUnder(a));
    expect(eventsOf(a, cur, 'nav_stopped')).toMatchObject([{ reason: 'lease' }]);
    expect(types(a, cur)).not.toContain('you_arrived');
  });

  it('读位置的人不会看到角色越过租约：到期任务还没处理时，位置也停在到期那一刻', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go('tea_house');
    const out = a.act('navigate', { to: 'garden' });
    t.clock.t = out.navigation.leaseUntil + 5000; // 不 tick
    const row = actorOf(t.w, a.residentId)!;
    expect(row.nav).not.toBeNull();
    const p = a.pos();
    expect(p.moving).toBe(false);
    t.clock.t += 5000;
    expect(a.pos()).toEqual(p);
    // 别人的快照里她也不再前进；本人的视图里这一趟还挂着，直到结算任务把它收掉
    expect(sceneView(t.w, b.row(), t.clock.t).actors.find((x) => x.id === a.residentId)!.nav).toBeUndefined();
    expect(whereabouts(t.w, a.row(), t.clock.t).navigation?.leaseUntil).toBe(out.navigation.leaseUntil);
    t.w.tick();
    expect(whereabouts(t.w, a.row(), t.clock.t).navigation).toBeNull();
    expect(a.pos()).toMatchObject({ x: p.x, z: p.z });
  });

  it('续租：只有握着控制权的客户端能续；过期的路线续不回来', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    const out = a.act('navigate', { to: 'garden' });
    t.advance(3000);
    const ok = renew(a);
    expect(ok).toMatchObject({ ok: true, leaseUntil: t.clock.t + t.w.params.navLeaseMs });
    expect(() => renewNavigation(t.w, { principalId: a.principalId, clientId: 'web:other-tab' }, { navigationId: out.navigation.navigationId, revision: out.navigation.revision })).toThrowError(WorldError);
    t.advance(t.w.params.navLeaseMs + 1);
    expect(nav(a)).toBeNull();
    expect(renewNavigation(t.w, a.auth, { navigationId: out.navigation.navigationId, revision: out.navigation.revision })).toEqual({ ok: false, navigation: null, space: loc(a) });
  });

  it('续租必须说清是哪一条的哪一段：不带版本号、版本号不对、编号不对都续不上，并拿到现在这条', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    const out = a.act('navigate', { to: 'garden' });
    const { navigationId, revision } = out.navigation;
    const lease = nav(a)!.leaseUntil;
    t.advance(3000);
    for (const body of [{ navigationId }, { navigationId, revision: revision - 1 }, { navigationId, revision: 'abc' }, { navigationId: 'nav_other', revision }, {}]) {
      const r = renewNavigation(t.w, a.auth, body);
      expect(r).toMatchObject({ ok: false, navigation: { navigationId, revision } });
      expect(r.leaseUntil).toBeUndefined();
    }
    expect(nav(a)!.leaseUntil).toBe(lease);
    expect(renew(a)).toMatchObject({ ok: true });
  });

  it('续租的回答里带着脚下的区域：走路的人自己跨区域没有事件，靠它知道现场换了', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    a.act('navigate', { to: 'garden' });
    const seen: string[] = [];
    for (let i = 0; i < 20 && nav(a); i++) {
      t.advance(t.w.params.navRenewEveryMs);
      a.heartbeat();
      if (!nav(a)) break;
      const r = renew(a);
      expect(r.space).toBe(loc(a));
      if (seen[seen.length - 1] !== r.space) seen.push(r.space);
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toContain('road');
    // 整趟路上她自己没有收到任何「你进了某片区域」的事件
    expect(loc(a)).toBe('garden');
  });

  it('续租只在折线的截止时刻变了的时候才通知同场景的人：剩下的路已经在租约之内就不打扰', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    a.act('navigate', { to: 'garden' }); // 二十秒上下的路，比租约长
    const keys: string[][] = [];
    t.w.onSpace((k) => keys.push(k));
    t.advance(3000);
    renew(a); // 截止时刻从租约到期往后推了：通知
    expect(keys).toHaveLength(1);
    const until = (viewer: Actor) => sceneView(t.w, viewer.row(), t.clock.t).actors.find((x) => x.id === a.residentId)!.nav!.until;
    expect(until(a)).toBe(nav(a)!.leaseUntil);
    // 走到只剩最后几秒：到达时刻已经在租约之内，再续租也不改变快照
    while (nav(a) && nav(a)!.leaseUntil < a.t.w.now() + 1 + (whereabouts(t.w, a.row(), t.clock.t).navigation!.arriveAt - t.clock.t)) {
      t.advance(3000);
      a.heartbeat();
      renew(a);
    }
    const arriveAt = whereabouts(t.w, a.row(), t.clock.t).navigation!.arriveAt;
    expect(until(a)).toBe(arriveAt);
    const n = keys.length;
    t.advance(500);
    expect(renew(a)).toMatchObject({ ok: true });
    expect(keys).toHaveLength(n);
    expect(until(a)).toBe(arriveAt);
  });

  it('控制连接断开：握着控制权的客户端断开就立即停步，别的页面断开不影响', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('navigate', { to: 'garden' });
    t.advance(2000);
    controlDisconnected(t.w, { principalId: a.principalId, clientId: 'web:other-tab' });
    expect(nav(a)).not.toBeNull();
    const before = a.pos();
    controlDisconnected(t.w, a.auth);
    expect(nav(a)).toBeNull();
    expect(a.pos()).toMatchObject({ x: before.x, z: before.z });
  });

  it('另一个客户端接管控制权：原来的路线立即站住', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('navigate', { to: 'garden' });
    t.advance(2000);
    const other = { principalId: a.principalId, clientId: 'web:phone' };
    a.clientId = other.clientId;
    a.enter();
    expect(nav(a)).not.toBeNull(); // 只是多了一个在场的页面，控制权没换
    const cur = a.events().cursor;
    a.claim();
    expect(nav(a)).toBeNull();
    expect(eventsOf(a, cur, 'nav_stopped')).toMatchObject([{ reason: 'control' }]);
  });

  it('主动离开小镇：立即停步，不会替她把路走完', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const out = a.act('navigate', { to: 'tea_house' });
    t.advance(4000);
    const before = a.pos();
    a.leave();
    expect(nav(a)).toBeNull();
    t.advanceTo(out.navigation.arriveAt + 5000);
    expect(a.pos()).toMatchObject({ x: before.x, z: before.z });
    expect(loc(a)).not.toBe('tea_house');
  });

  it('本人在路上做了别的动作：这一刻成为检查点', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('navigate', { to: 'garden' });
    t.advance(2500);
    a.act('speak', { text: '边走边说' });
    expect(nav(a)!.checkpointAt).toBe(t.clock.t);
  });
});

describe('进出私宅', () => {
  it('回家：走到会馆门口，进到自己的私宅实例里；公开层面一直只是「住宅区」', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    b.go('residential');
    const cb = b.events().cursor;
    const cur = t.w.publicCursor();
    const out = a.act('navigate', { to: 'home' });
    expect(out.navigation).toMatchObject({ to: { kind: 'home', name: '你的家' }, continues: true });
    a.walk();
    expect(loc(a)).toBe(`home:${a.residentId}`);
    expect(a.pos()).toMatchObject({ scene: 'home', instance: a.residentId, moving: false });
    // 会馆门前的人：看到她走过来，又看到她离开了这片地方；没有任何事件说她进了哪一家
    expect(eventsOf(b, cb, 'arrived')).toMatchObject([{ space: 'residential' }]);
    expect(eventsOf(b, cb, 'left')).toMatchObject([{ space: 'residential' }]);
    expect(JSON.stringify(b.events(cb).events)).not.toContain('home:');
    const pub = t.w.readPublicEvents(cur).events.filter((e) => e.type === 'place').map((e) => (e.data as any).resident.at);
    expect(pub).toEqual(['road', 'residential']);
    expect(JSON.stringify(t.w.readPublicEvents(cur).events)).not.toContain('home:');
  });

  it('从家里去公共地点：先出门到会馆门口，再接着走；整趟是同一条导航', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('home');
    a.go({ x: 5.25, z: 3.75 });
    expect(loc(a)).toBe(`home:${a.residentId}`);
    const cur = a.events().cursor;
    const out = a.act('navigate', { to: 'tea_house' });
    expect(out.navigation).toMatchObject({ to: { kind: 'place', id: 'tea_house' }, continues: true });
    a.walk();
    expect(loc(a)).toBe('tea_house');
    expect(a.pos().scene).toBe('town');
    expect(eventsOf(a, cur, 'you_arrived')).toMatchObject([{ space: 'tea_house' }]);
    const facts = arrivedFacts(t);
    expect(facts).toEqual(['tea_house']);
  });

  it('人就站在门口：出门那一步当场完成，接着走的是街上的那一段', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('home');
    const out = a.act('navigate', { to: 'plaza' });
    expect(out.status).toBe('accepted');
    expect(out.navigation.continues).toBe(false);
    expect(a.pos().scene).toBe('town');
    expect(loc(a)).toBe('residential');
    a.walk();
    expect(loc(a)).toBe('plaza');
  });

  it('没有邀请进不了别人家：出发时就被拒', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    expect(b.fail('navigate', { to: `home:${a.residentId}` }).reason).toBe('no_access');
    expect(b.fail('navigate', { to: 'home:nobody' }).reason).toBe('no_such_place');
    expect(nav(b)).toBeNull();
  });

  it('路上邀请被撤销：走到门口进不去，停在会馆门前，只收到固定的提示', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.act('invite', { to: b.residentId });
    const grant = t.w.db.get('SELECT grant_id FROM home_access_grants')!;
    b.act('navigate', { to: `home:${a.residentId}` });
    t.advance(2000);
    renew(b);
    a.act('revoke_invite', { grantId: grant.grant_id });
    const cur = b.events().cursor;
    b.walk();
    expect(loc(b)).toBe('residential');
    expect(b.pos().scene).toBe('town');
    expect(eventsOf(b, cur, 'notice').map((n) => n.text).join()).toContain('没能进去');
    expect(eventsOf(b, cur, 'nav_stopped')).toMatchObject([{ reason: 'blocked' }]);
    expect(types(b, cur)).not.toContain('you_arrived');
  });

  it('受邀进门后被撤销邀请：客人被送到会馆门口，屋里屋外各自只看到该看的', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.act('invite', { to: b.residentId });
    const grant = t.w.db.get('SELECT grant_id FROM home_access_grants')!;
    a.go('home');
    b.go(`home:${a.residentId}`);
    expect(loc(b)).toBe(`home:${a.residentId}`);
    expect(b.pos()).toMatchObject({ scene: 'home', instance: a.residentId });
    a.act('revoke_invite', { grantId: grant.grant_id });
    expect(loc(b)).toBe('residential');
    const door = town(t).anchors.get('residential.door')!;
    expect(b.pos()).toMatchObject({ scene: 'town', instance: '', x: door.x, z: door.z });
  });

  it('客人正在屋里走动时被请出门：停下、落在会馆门口，本人收到 nav_stopped（eject）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.act('invite', { to: b.residentId });
    const grant = t.w.db.get('SELECT grant_id FROM home_access_grants')!;
    b.go(`home:${a.residentId}`);
    b.act('navigate', { to: { x: 2, z: 2 } });
    t.advance(500);
    const cur = b.events().cursor;
    a.act('revoke_invite', { grantId: grant.grant_id });
    expect(nav(b)).toBeNull();
    expect(loc(b)).toBe('residential');
    expect(b.pos().scene).toBe('town');
    expect(eventsOf(b, cur, 'nav_stopped')).toMatchObject([{ reason: 'eject', space: 'residential' }]);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
  });

  it('场景快照：公共场景里看不到任何私宅里的人；私宅里只看得到同一户里的人', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const c = t.join('阿树');
    a.act('invite', { to: b.residentId });
    a.go('home');
    b.go(`home:${a.residentId}`);
    c.go('home');
    const d = t.join('小朵');
    const inA = sceneView(t.w, a.row(), t.clock.t);
    expect(inA.scene).toBe('home');
    expect(inA.space).toBe(`home:${a.residentId}`);
    expect(inA.actors.map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    const inC = sceneView(t.w, c.row(), t.clock.t);
    expect(inC.actors.map((x) => x.id)).toEqual([c.residentId]);
    const outside = sceneView(t.w, d.row(), t.clock.t);
    expect(outside.scene).toBe('town');
    expect(outside.actors.map((x) => x.id)).toEqual([d.residentId]);
    // 快照里不出现实例编号（别人家是谁家）
    expect(JSON.stringify(inC)).not.toContain(a.residentId);
    expect(JSON.stringify(outside)).not.toContain('instance');
  });
});

describe('场景快照', () => {
  it('同一个场景里的两个人互相看得见；正在走的人带着折线、速度和出发时刻', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('navigate', { to: 'tea_house' });
    t.advance(1500);
    const view = sceneView(t.w, b.row(), t.clock.t);
    expect(view).toMatchObject({ protocol: 1, mapVersion: t.w.map.mapVersion, checksum: t.w.map.checksum, scene: 'town', self: b.residentId, serverTime: t.clock.t });
    const seenA = view.actors.find((x) => x.id === a.residentId)!;
    const self = view.actors.find((x) => x.id === b.residentId)!;
    expect(self.nav).toBeUndefined();
    expect(self.kind).toBe('agent');
    expect(seenA.nav).toMatchObject({ speed: t.w.map.speed, startedAt: t.clock.t - 1500 });
    expect(seenA.nav!.points.length).toBeGreaterThanOrEqual(2);
    expect(seenA.nav!.until).toBeLessThanOrEqual(nav(a)!.leaseUntil);
    // 两个客户端按同一条折线和服务器时间插值，得到的就是服务器的位置
    expect(seenA.x).toBeCloseTo(a.pos().x, 3);
    expect(seenA.z).toBeCloseTo(a.pos().z, 3);
  });

  it('离线的人不在快照里；地图清单带着版本和校验值', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    b.leave();
    expect(sceneView(t.w, a.row(), t.clock.t).actors.map((x) => x.id)).toEqual([a.residentId]);
    const m = mapManifest(t.w);
    expect(m).toMatchObject({ protocol: 1, mapVersion: t.w.map.mapVersion, checksum: t.w.map.checksum });
    expect(Object.keys(m.grids).sort()).toEqual(['home', 'town']);
  });

  it('不在场的人看不到现场：离线之后的快照里只有她自己停在哪里，没有别人的位置和路线', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    b.act('navigate', { to: 'tea_house' });
    expect(sceneView(t.w, a.row(), t.clock.t).actors.map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    a.leave();
    const v = sceneView(t.w, a.row(), t.clock.t);
    expect(v.actors.map((x) => x.id)).toEqual([a.residentId]);
    expect(JSON.stringify(v)).not.toContain(b.residentId);
    // 在场租约到期（没有明确离开）也一样
    const c = t.join('阿树');
    for (let i = 0; i < 8; i++) {
      t.advance(20_000);
      b.heartbeat();
    }
    expect(c.row().present_since).toBeNull();
    expect(sceneView(t.w, c.row(), t.clock.t).actors.map((x) => x.id)).toEqual([c.residentId]);
  });

  it('客人在别人家里离线：再读快照只有自己，看不到屋里的人', () => {
    const t = makeTown();
    const host = t.join('阿灯');
    const guest = t.join('小岚');
    host.act('invite', { to: guest.residentId });
    host.go('home');
    guest.go(`home:${host.residentId}`);
    expect(sceneView(t.w, guest.row(), t.clock.t).actors).toHaveLength(2);
    guest.leave();
    expect(loc(guest)).toBe(`home:${host.residentId}`);
    expect(sceneView(t.w, guest.row(), t.clock.t).actors.map((x) => x.id)).toEqual([guest.residentId]);
  });

  it('快照里不只有位置：有人上线、离线、在场租约到期、改名、进出小游戏，同一场景实例的订阅者都会被通知', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const keys: string[][] = [];
    t.w.onSpace((k) => keys.push(k));
    const seen = () => keys.splice(0).flat();
    // 上线：新来的人出现在别人的快照里
    const b = t.join('小岚');
    expect(seen()).toContain('town|');
    expect(sceneView(t.w, a.row(), t.clock.t).actors.map((x) => x.id)).toContain(b.residentId);
    // 改名
    b.act('update_profile', { name: '小岚岚' });
    expect(seen()).toContain('town|');
    expect(sceneView(t.w, a.row(), t.clock.t).actors.find((x) => x.id === b.residentId)!.name).toBe('小岚岚');
    // 明确离开：站着不动的人离线，也要通知
    b.leave();
    expect(seen()).toContain('town|');
    expect(sceneView(t.w, a.row(), t.clock.t).actors.map((x) => x.id)).toEqual([a.residentId]);
    // 再进来
    b.enter();
    expect(seen()).toContain('town|');
    // 在场租约到期（没有明确离开）
    for (let i = 0; i < 8; i++) {
      t.advance(20_000);
      a.heartbeat();
    }
    expect(b.row().present_since).toBeNull();
    expect(seen()).toContain('town|');
    expect(sceneView(t.w, a.row(), t.clock.t).actors.map((x) => x.id)).toEqual([a.residentId]);
  });

  it('进出小游戏（快照里的 busy）会通知场景；在私宅里上线、离线通知的是那一户的实例', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const c = t.join('阿树');
    for (const x of [a, b]) x.go('arcade:table1');
    const keys: string[][] = [];
    t.w.onSpace((k) => keys.push(k));
    const seen = () => keys.splice(0).flat();
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    b.act('join_game', { activityId: p.activity.id });
    seen();
    a.act('start_game', { activityId: p.activity.id });
    expect(seen()).toContain('town|');
    expect(sceneView(t.w, c.row(), t.clock.t).actors.filter((x) => x.busy === 'game').map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    a.act('quit_game');
    expect(seen()).toContain('town|');
    expect(sceneView(t.w, c.row(), t.clock.t).actors.find((x) => x.id === a.residentId)!.busy).toBeUndefined();
    // 私宅实例
    c.go('home');
    seen();
    c.leave();
    expect(seen()).toEqual([`home|${c.residentId}`]);
    c.enter();
    expect(seen()).toEqual([`home|${c.residentId}`]);
  });

  it('位置变化在提交之后才通知场景的订阅者；回滚的命令不通知', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const keys: string[][] = [];
    t.w.onSpace((k) => keys.push(k));
    a.act('navigate', { to: 'tea_house' });
    expect(keys).toEqual([['town|']]);
    a.fail('navigate', { to: 'moon' });
    expect(keys).toHaveLength(1);
    a.act('stop_navigation');
    expect(keys).toHaveLength(2);
  });
});

describe('够得着', () => {
  it('公共物件要走到旁边才能用：离得远是 too_far，并告诉可以 navigate 到哪里', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    const far = a.view().here!.objects.find((o) => o.id === 'tea_house:table1')!;
    expect(far.near).toBe(false);
    const err = a.fail('start_interaction', { objectId: 'tea_house:table1' });
    expect(err.reason).toBe('too_far');
    expect(err.data).toMatchObject({ navigateTo: 'tea_house:table1' });
    const out = a.go('tea_house:table1');
    expect(out.navigation.to).toMatchObject({ kind: 'object', id: 'tea_house:table1' });
    expect(a.view().here!.objects.find((o) => o.id === 'tea_house:table1')!.near).toBe(true);
    expect(a.act('start_interaction', { objectId: 'tea_house:table1' }).status).toBe('accepted');
    // 已经在旁边：不用再走
    expect(a.act('navigate', { to: 'tea_house:table1' })).toMatchObject({ status: 'completed', already: 'near' });
  });

  it('不在那片区域里：同样是 too_far', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    expect(a.fail('start_interaction', { objectId: 'tea_house:table1' }).reason).toBe('too_far');
  });

  it('坐下之后迈步走开：就算没走出这片区域，也退出了这件事', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house:table1');
    a.act('start_interaction', { objectId: 'tea_house:table1', wait: true });
    expect(a.view().interaction).not.toBeNull();
    a.act('navigate', { to: 'tea_house:table2' });
    expect(a.view().interaction).toBeNull();
    expect(loc(a)).toBe('tea_house');
  });

  it('路过物件旁边时发起：够得着，就在这里站住', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('tea_house');
    const table = town(t).interactables.get('tea_house:table2')!;
    a.act('navigate', { to: { x: table.x + 2.5, z: table.z - 0.5 } });
    let started = false;
    for (let i = 0; i < 60 && nav(a) && !started; i++) {
      t.advance(250);
      if (Math.hypot(a.pos().x - table.x, a.pos().z - table.z) <= t.w.map.interactDistance) {
        a.act('start_interaction', { objectId: 'tea_house:table2', wait: true });
        started = true;
      }
    }
    expect(started).toBe(true);
    expect(nav(a)).toBeNull();
    expect(a.view().interaction).not.toBeNull();
  });
});

describe('重启与迁移', () => {
  it('服务器重启：走到一半的人停在最后一个耐久检查点，旧的导航任务不再挪动她', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    a.go('tea_house');
    const out = a.act('navigate', { to: 'garden' });
    t.advance(3000);
    renew(a);
    const checkpoint = t.clock.t;
    const at3s = a.pos();
    // 进程又活了 2 秒（没来得及写检查点）就被杀了；停机 5 分钟
    t.clock.advance(2000);
    t.clock.advance(5 * 60_000);
    t.restart({ crash: true });
    const row = actorOf(t.w, a.residentId)!;
    expect(row.nav).toBeNull();
    expect(row.nav_revision).toBeGreaterThan(out.navigation.revision);
    expect(row.anchor_at).toBeGreaterThanOrEqual(checkpoint);
    expect(row.anchor_at).toBeLessThanOrEqual(checkpoint + 2000);
    expect(Math.hypot(row.x - at3s.x, row.z - at3s.z)).toBeLessThanOrEqual(t.w.map.speed * 2 + 1e-6);
    expect(a.row().location_id).toBe(zoneAt(town(t), row.x, row.z).id);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
    // 回来之后从停下的地方重新出发
    a.enter();
    a.go('garden');
    expect(loc(a)).toBe('garden');
  });

  it('从 schema v2 的库升级：建出空间角色表，旧街道编号迁到住宅接入点，旧的到达任务作废，之后能正常走', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.act('speak', { text: '旧版里说的话' });
    const now = t.clock.t;
    // 把库改回 v2 的样子
    const raw = t.w.db.db;
    raw.exec('DROP TABLE world_actors');
    raw.exec('PRAGMA user_version = 2');
    raw.prepare("UPDATE residents SET location_id = 'street_east' WHERE resident_id = ?").run(a.residentId);
    raw.prepare("UPDATE chat_messages SET space_id = 'street_west'").run();
    raw.prepare("INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at) VALUES ('move:legacy:1', ?, 1, 'move_arrive', '{}', 'pending', ?)").run(now + 5000, now);
    t.clock.advance(10_000);
    t.restart();
    expect(t.w.db.userVersion()).toBe(3);
    expect(t.logs.join('\n')).not.toContain('迁移');
    expect(a.row().location_id).toBe('residential');
    expect(b.row().location_id).toBe('plaza');
    for (const x of [a, b]) {
      const row = actorOf(t.w, x.residentId)!;
      expect(row.map_version).toBe(t.w.map.mapVersion);
      expect(zoneAt(town(t), row.x, row.z).id).toBe(x.row().location_id);
    }
    expect(t.w.db.all('SELECT DISTINCT space_id FROM chat_messages').map((m) => m.space_id)).toEqual(['residential']);
    expect(t.w.db.get("SELECT status FROM scheduled_jobs WHERE dedupe_key = 'move:legacy:1'")!.status).toBe('cancelled');
    a.enter();
    a.go('plaza');
    expect(loc(a)).toBe('plaza');
    a.go('home');
    expect(loc(a)).toBe(`home:${a.residentId}`);
  });

  it('地图换了版本：位置在新地图上不合法的人挪到所在区域的落脚点，合法的不动', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    b.go('tea_house');
    const before = b.pos();
    const raw = t.w.db.db;
    // 假装这两条记录是旧地图留下的：a 站在如今是喷泉的地方，b 的位置在新地图上仍然合法
    const fountain = town(t).source.obstacles.find((o) => o.id === 'plaza.fountain')!;
    raw.prepare("UPDATE world_actors SET map_version = 'old', x = ?, z = ? WHERE actor_id = ?").run(fountain.x + fountain.w / 2, fountain.z + fountain.d / 2, a.residentId);
    raw.prepare("UPDATE world_actors SET map_version = 'old' WHERE actor_id = ?").run(b.residentId);
    t.restart();
    const plaza = town(t).anchors.get('plaza')!;
    expect(actorOf(t.w, a.residentId)).toMatchObject({ x: plaza.x, z: plaza.z, map_version: t.w.map.mapVersion });
    expect(actorOf(t.w, b.residentId)).toMatchObject({ x: before.x, z: before.z, map_version: t.w.map.mapVersion });
    expect(a.row().location_id).toBe('plaza');
    expect(b.row().location_id).toBe('tea_house');
  });

  it('地图换了版本时有人正走在路上：重启不拿新地图去结算旧路线，路线作废，人留在这一段的起点，之后能正常走', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const start = a.pos();
    const out = a.act('navigate', { to: 'garden' });
    t.advance(3000);
    renew(a);
    // 假装这条路线是旧地图上规划的：在旧地图上它从广场出发，折线的坐标落在如今是茶馆的地方
    const tea = town(t).anchors.get('tea_house')!;
    const stale = nav(a)!;
    const old = { ...stale, points: [{ x: tea.x, z: tea.z }, { x: tea.x + 0.25, z: tea.z }] };
    t.w.db.db.prepare("UPDATE world_actors SET map_version = 'old', nav_json = ? WHERE actor_id = ?").run(JSON.stringify(old), a.residentId);
    const cb = b.events().cursor;
    t.clock.advance(60_000);
    t.restart({ crash: true });
    const row = actorOf(t.w, a.residentId)!;
    expect(row.nav).toBeNull();
    expect(row.nav_revision).toBeGreaterThan(out.navigation.revision);
    expect(row.map_version).toBe(t.w.map.mapVersion);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
    // 没有按旧折线「走到茶馆」：位置还是这一段的起点，区域标签是脚下的广场，也没有记「到过某处」
    expect(row).toMatchObject({ x: start.x, z: start.z });
    expect(a.row().location_id).toBe('plaza');
    expect(arrivedFacts(t)).toEqual([]);
    expect(eventsOf(b, cb, 'arrived').filter((e) => e.space === 'tea_house')).toEqual([]);
    a.enter();
    a.go('garden');
    expect(loc(a)).toBe('garden');
  });

  it('地图换了版本、区域的划分变了：位置还合法的人，区域标签跟着脚下走', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    a.go('tea_house');
    const plaza = town(t).anchors.get('plaza')!;
    // 假装旧地图上这个点属于茶馆：位置合法，但新地图上它在广场
    t.w.db.db.prepare("UPDATE world_actors SET map_version = 'old', x = ?, z = ? WHERE actor_id = ?").run(plaza.x, plaza.z, a.residentId);
    expect(a.row().location_id).toBe('tea_house');
    t.restart();
    expect(actorOf(t.w, a.residentId)).toMatchObject({ x: plaza.x, z: plaza.z, map_version: t.w.map.mapVersion });
    expect(a.row().location_id).toBe('plaza');
  });

  it('旧版留下的在途移动：截止前该到的按旧规则到达，没到的留在出发地；之后每个人都有合法位置', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const c = t.join('阿树');
    const now = t.clock.t;
    // 把库改回旧版的样子：没有空间角色，位置只有地点编号，路上的人带着 move_json
    t.w.db.db.exec('DELETE FROM world_actors');
    const set = (x: Actor, location: string, move: Record<string, unknown> | null) =>
      t.w.db.db.prepare('UPDATE residents SET location_id = ?, move_json = ? WHERE resident_id = ?').run(location, move ? JSON.stringify(move) : null, x.residentId);
    set(a, 'plaza', { from: 'plaza', to: 'tea_house', path: ['plaza', 'tea_house'], startedAt: now - 5000, arriveAt: now + 3000 });
    set(b, 'plaza', { from: 'plaza', to: 'garden', path: ['plaza', 'garden'], startedAt: now, arriveAt: now + 10 * 60_000 });
    set(c, 'plaza', { from: 'plaza', to: `home:${a.residentId}`, path: [], startedAt: now, arriveAt: now + 1000 });
    t.clock.advance(60_000);
    t.restart();
    expect(a.row().location_id).toBe('tea_house');
    expect(b.row().location_id).toBe('plaza');
    // 没有邀请：到了门口进不去，留在住宅接入点
    expect(c.row().location_id).toBe('residential');
    for (const x of [a, b, c]) {
      const row = actorOf(t.w, x.residentId)!;
      expect(row.scene_id).toBe('town');
      expect(zoneAt(town(t), row.x, row.z).id).toBe(x.row().location_id);
      expect(t.w.db.get('SELECT move_json FROM residents WHERE resident_id = ?', x.residentId)!.move_json).toBeNull();
    }
    // 旧规则：进不去的人算走到了门外那个地方
    expect(arrivedFacts(t)).toEqual(['tea_house', 'residential']);
  });
});
