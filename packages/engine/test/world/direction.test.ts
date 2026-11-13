/**
 * 键盘方向输入（space.ts 的 directionInput）：正常行走、松手停步、超时停步、撞边界与贴边滑动、
 * 旧 epoch / 旧序号 / 旧连接被拒、频率限制、不带坐标的事件、与点地导航互相打断、门禁、小游戏。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { actorOf, directionInput, renewNavigation, sceneView } from '../../src/world/space.js';
import { compileMap, isWalkable, sweepDirection, type SceneSource } from '../../src/world/spatial/index.js';
import { FakeClock } from '../helpers.js';
import { makeTown, tempDb, type Actor, type Town } from './helpers.js';

const nav = (a: Actor) => actorOf(a.t.w, a.residentId)?.nav ?? null;
const speed = (t: Town) => t.w.map.speed;
const leaseMs = (t: Town) => t.w.params.dirLeaseMs;

/** 一个模拟的键盘客户端：序号自增、带着当前的控制版本。 */
class Keys {
  seq = 0;
  source = 1;
  constructor(readonly a: Actor) {}
  get epoch(): number {
    return this.a.row().control_epoch;
  }
  press(x: number, z: number, o: { seq?: number; epoch?: number; source?: number } = {}) {
    return directionInput(this.a.t.w, this.a.auth, { seq: o.seq ?? ++this.seq, epoch: o.epoch ?? this.epoch, x, z, source: o.source ?? this.source });
  }
  release() {
    return this.press(0, 0);
  }
  /** 按住 ms 毫秒：每 intervalMs 重发一次 */
  hold(x: number, z: number, ms: number, intervalMs = 175) {
    let left = ms;
    this.press(x, z);
    while (left > 0) {
      const step = Math.min(intervalMs, left);
      this.a.t.advance(step);
      left -= step;
      if (left > 0) this.press(x, z);
    }
  }
}

function failCode(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof WorldError) return e.reason ?? e.code;
    throw e;
  }
  throw new Error('本应失败');
}

describe('方向输入：走路与停步', () => {
  it('按下就走：一段短的直线导航，租约约 500 毫秒，长度上限 = 速度 × 租约；回执里没有坐标', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const start = a.pos();
    const out = k.press(1, 0);
    expect(out).toMatchObject({ ok: true, moving: true });
    const n = nav(a)!;
    expect(n.target.kind).toBe('dir');
    expect(n.leaseUntil).toBe(t.clock.t + leaseMs(t));
    const len = Math.hypot(n.points[1]!.x - n.points[0]!.x, n.points[1]!.z - n.points[0]!.z);
    expect(len).toBeLessThanOrEqual((speed(t) * leaseMs(t)) / 1000 + 1e-9);
    expect(JSON.stringify(out)).not.toMatch(/"(x|z|points)"/);
    t.advance(250);
    const p = a.pos();
    expect(p.x - start.x).toBeCloseTo(speed(t) * 0.25, 2);
    expect(p.z).toBeCloseTo(start.z, 6);
    expect(p.moving).toBe(true);
  });

  it('按住：每 175 毫秒重发一次就一直走，速度就是地图速度；每次重发导航版本递增', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const start = a.pos();
    k.press(0, -1);
    const rev0 = nav(a)!.revision;
    t.advance(175);
    k.press(0, -1);
    expect(nav(a)!.revision).toBeGreaterThan(rev0);
    k.hold(0, -1, 1400);
    const p = a.pos();
    expect(start.z - p.z).toBeCloseTo(speed(t) * 1.575, 1);
    expect(p.moving).toBe(true);
    expect(p.x).toBeCloseTo(start.x, 6);
  });

  it('松手发零向量：当场停在这一刻的位置，之后不再动', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    k.hold(1, 0, 700);
    const at = a.pos();
    expect(k.release()).toMatchObject({ ok: true, moving: false });
    expect(nav(a)).toBeNull();
    t.advance(3000);
    expect(a.pos()).toMatchObject({ x: at.x, z: at.z, moving: false });
  });

  it('什么都不发（断网、页面卡死）：最迟 500 毫秒停在租约截止的位置，哪怕到期任务晚了很久才处理', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const start = a.pos();
    k.press(1, 0);
    t.clock.t += 5000; // 不调 tick：到期任务还没处理
    expect(a.pos().x - start.x).toBeCloseTo((speed(t) * leaseMs(t)) / 1000, 2);
    expect(a.pos().moving).toBe(false);
    t.w.tick();
    expect(nav(a)).toBeNull();
    expect(a.pos().x - start.x).toBeCloseTo((speed(t) * leaseMs(t)) / 1000, 2);
  });

  it('正常松手、超时停步都不产生事件；不影响别人的事件流和公开流', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const ca = a.events().cursor;
    const cb = b.events().cursor;
    const pub = t.w.db.scalar('SELECT COUNT(*) FROM world_events') as number;
    const k = new Keys(a);
    k.hold(1, 1, 1200);
    k.release();
    k.press(-1, 0);
    t.advance(2000);
    expect(a.events(ca).events).toEqual([]);
    expect(b.events(cb).events).toEqual([]);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM world_events')).toBe(pub);
  });

  it('零向量不取消点地路线，只停方向输入；没在走时零向量什么也不做', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    expect(k.release()).toMatchObject({ ok: true, moving: false });
    a.act('navigate', { to: 'tea_house' });
    const before = nav(a)!;
    expect(k.release()).toMatchObject({ ok: true, moving: true });
    expect(nav(a)).toMatchObject({ navigationId: before.navigationId, revision: before.revision });
    t.advance(1000);
    expect(a.pos().moving).toBe(true);
  });

  it('斜向：向量被归一化，速度不会因为按了两个键而变快；过大或非数字的向量被拒', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const start = a.pos();
    k.press(3, 3);
    t.advance(300);
    const p = a.pos();
    expect(Math.hypot(p.x - start.x, p.z - start.z)).toBeCloseTo(speed(t) * 0.3, 2);
    expect(failCode(() => k.press(100, 0))).toBe('bad_request');
    expect(failCode(() => k.press(Number.NaN, 0))).toBe('bad_request');
    expect(failCode(() => directionInput(t.w, a.auth, { seq: 99, epoch: k.epoch, x: '1' as never, z: 0 }))).toBe('bad_request');
    expect(failCode(() => directionInput(t.w, a.auth, { seq: 1.5, epoch: k.epoch, x: 1, z: 0 }))).toBe('bad_request');
  });
});

describe('方向输入：边界与贴边滑动', () => {
  function inHome(t: Town) {
    const a = t.join('阿灯');
    a.go('home');
    return a;
  }

  it('朝墙走：停在墙边，不穿墙；脸贴着墙再按就是原地不动（blocked）', () => {
    const t = makeTown();
    const a = inHome(t);
    const k = new Keys(a);
    expect(a.pos().scene).toBe('home');
    k.hold(0, 1, 2000);
    k.release();
    const p = a.pos();
    expect(p.z).toBeGreaterThan(6.2);
    expect(p.z).toBeLessThanOrEqual(7);
    expect(isWalkable(t.w.map.scenes.get('home')!, p.x, p.z)).toBe(true);
    t.advance(1000);
    expect(k.press(0, 1)).toMatchObject({ ok: true, moving: false, blocked: true });
    expect(nav(a)).toBeNull();
  });

  it('斜着撞墙：沿墙滑动，朝墙的分量被吃掉', () => {
    const t = makeTown();
    const a = inHome(t);
    const k = new Keys(a);
    k.hold(0, 1, 1500);
    k.release();
    const wall = a.pos();
    const x0 = wall.x;
    k.hold(1, 1, 1000);
    k.release();
    const p = a.pos();
    expect(p.x).toBeGreaterThan(x0 + 1);
    expect(p.z).toBeCloseTo(wall.z, 1);
    expect(isWalkable(t.w.map.scenes.get('home')!, p.x, p.z)).toBe(true);
  });

  it('怎么按都出不了可走范围（八个方向、长时间）', () => {
    const t = makeTown();
    const a = inHome(t);
    const k = new Keys(a);
    const home = t.w.map.scenes.get('home')!;
    for (const [x, z] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const) {
      k.hold(x, z, 3000);
      expect(isWalkable(home, a.pos().x, a.pos().z), `${x},${z}`).toBe(true);
    }
  });

  it('公共场景：绕着喷泉、摊位走也穿不过障碍，位置始终可走', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const town = t.w.map.scenes.get('town')!;
    for (const [x, z] of [[1, 0], [0, 1], [-1, -1], [1, -1], [-1, 0], [0, -1], [1, 1]] as const) {
      for (let i = 0; i < 12; i++) {
        k.hold(x, z, 400);
        const p = a.pos();
        expect(isWalkable(town, p.x, p.z)).toBe(true);
      }
      a.heartbeat();
    }
  });

  it('sweepDirection（纯函数）：自由行走满长；撞墙停在边缘；斜撞贴边；起点不可走返回只有起点', () => {
    const src: SceneSource = {
      id: 's',
      name: 's',
      instanced: false,
      cell: 0.5,
      bounds: { x: 0, z: 0, w: 10, d: 10 },
      walk: [{ x: 0, z: 0, w: 10, d: 10 }],
      obstacles: [{ x: 6, z: 0, w: 1, d: 10, kind: 'wall' }],
      zones: [],
      defaultZone: { id: 'street', name: '街上', indoor: false },
      anchors: [{ id: 'a', x: 0.25, z: 0.25 }],
      interactables: [],
      portals: [],
    };
    const scene = compileMap({ mapVersion: 'p-1', agentRadius: 0, speed: 2, interactDistance: 1.5, hearDistance: 8, scenes: [src], aliases: {}, spawn: { scene: 's', anchor: 'a' } }).scenes.get('s')!;
    const free = sweepDirection(scene, { x: 2, z: 2 }, { x: 0, z: 1 }, 1.2);
    expect(free).toHaveLength(2);
    expect(free[1]!.z).toBeCloseTo(3.2, 9);
    const hit = sweepDirection(scene, { x: 5.5, z: 2 }, { x: 1, z: 0 }, 1.2);
    expect(hit[hit.length - 1]!.x).toBeGreaterThan(5.9);
    expect(hit[hit.length - 1]!.x).toBeLessThan(6);
    expect(hit).toHaveLength(2);
    const slide = sweepDirection(scene, { x: 5.9, z: 2 }, { x: Math.SQRT1_2, z: Math.SQRT1_2 }, 1.2);
    const end = slide[slide.length - 1]!;
    expect(end.x).toBeLessThan(6);
    expect(end.z).toBeGreaterThan(2.5);
    expect(sweepDirection(scene, { x: 6.5, z: 2 }, { x: 1, z: 0 }, 1.2)).toEqual([{ x: 6.5, z: 2 }]);
    expect(sweepDirection(scene, { x: 5.99, z: 2 }, { x: 1, z: 0 }, 1.2)).toHaveLength(1);
  });
});

describe('方向输入：序号、控制版本、频率', () => {
  it('旧序号、重复序号：丢弃，不改变任何状态；新序号照常', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    expect(k.press(1, 0, { seq: 5 })).toMatchObject({ ok: true });
    const before = nav(a)!;
    t.advance(100);
    expect(k.press(0, 1, { seq: 5 })).toEqual({ ok: false, reason: 'stale' });
    expect(k.press(0, 1, { seq: 4 })).toEqual({ ok: false, reason: 'stale' });
    expect(k.press(0, 0, { seq: 3 })).toEqual({ ok: false, reason: 'stale' }); // 迟到的"松手"也不能停下新的路线
    expect(nav(a)).toMatchObject({ navigationId: before.navigationId, revision: before.revision });
    expect(k.press(0, 1, { seq: 6 })).toMatchObject({ ok: true, moving: true });
  });

  it('旧连接迟到的输入被丢弃：重连后新连接（序号更大）盖过旧连接', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    k.press(1, 0, { source: 1, seq: 50 });
    t.advance(50);
    k.press(0, 1, { source: 2, seq: 1 }); // 新连接，序号从头开始
    const mine = nav(a)!;
    expect(k.press(-1, 0, { source: 1, seq: 51 })).toEqual({ ok: false, reason: 'stale' });
    expect(nav(a)!.revision).toBe(mine.revision);
  });

  it('旧 epoch（被接管过）：control_lost，不动路线；新页面接管后序号重新开始', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const oldEpoch = k.epoch;
    k.press(1, 0);
    expect(failCode(() => k.press(0, 1, { epoch: oldEpoch + 1 }))).toBe('control_lost');
    expect(failCode(() => k.press(0, 1, { epoch: oldEpoch - 1 }))).toBe('control_lost');
    // 另一个页面接管
    const oldClient = a.clientId;
    a.clientId = 'web:other-tab';
    a.enter();
    a.claim();
    expect(nav(a)).toBeNull(); // 接管：立即站住
    const stale = { principalId: a.principalId, clientId: oldClient };
    expect(failCode(() => directionInput(t.w, stale, { seq: 99, epoch: a.row().control_epoch, x: 1, z: 0 }))).toBe('control_lost'); // 旧页面没有控制权
    expect(failCode(() => directionInput(t.w, a.auth, { seq: 99, epoch: oldEpoch, x: 1, z: 0 }))).toBe('control_lost'); // 新页面用了旧的 epoch
    const claimer = a;
    const k2 = new Keys(claimer);
    expect(k2.press(1, 0, { seq: 1 })).toMatchObject({ ok: true, moving: true });
  });

  it('没有控制权的客户端、不在场的人：被拒', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const stranger = { principalId: a.principalId, clientId: 'web:not-me' };
    expect(failCode(() => directionInput(t.w, stranger, { seq: 1, epoch: a.row().control_epoch, x: 1, z: 0 }))).toBe('control_lost');
    a.leave();
    expect(failCode(() => new Keys(a).press(1, 0))).toBe('not_present');
  });

  it('频率限制：突发用完后被拒（rate_limited），随时间补回；松手不受限制', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const burst = t.w.params.dirBurst;
    const results = Array.from({ length: burst + 5 }, () => k.press(1, 0));
    expect(results.filter((r) => r.ok)).toHaveLength(burst);
    expect(results.slice(burst).every((r) => !r.ok && r.reason === 'rate_limited')).toBe(true);
    expect(k.release()).toMatchObject({ ok: true, moving: false }); // 停止不受限
    t.advance(1000);
    expect(k.press(1, 0)).toMatchObject({ ok: true });
    // 正常按住（每 175 毫秒一次）永远不会被限
    const t2 = makeTown();
    const b = t2.join('小岚');
    const kb = new Keys(b);
    for (let i = 0; i < 60; i++) {
      expect(kb.press(i % 2 ? 1 : -1, 0)).toMatchObject({ ok: true });
      t2.advance(175);
      if (i % 10 === 9) b.heartbeat();
    }
  });
});

describe('方向输入：与点地导航互相打断、门禁、游戏', () => {
  it('方向输入打断点地路线：从当前位置起步，旧路线的任务作废；点地再打断方向输入', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    a.act('navigate', { to: 'tea_house' });
    const click = nav(a)!;
    t.advance(1000);
    const mid = a.pos();
    k.press(0, 1);
    const dir = nav(a)!;
    expect(dir.target.kind).toBe('dir');
    expect(dir.navigationId).not.toBe(click.navigationId);
    expect(dir.revision).toBeGreaterThan(click.revision);
    expect(dir.points[0]).toMatchObject({ x: mid.x, z: mid.z });
    // 旧路线的到达任务不会再把人拉去茶馆
    t.advanceAlive(60_000, [a]);
    expect(a.pos().moving).toBe(false);
    expect(Math.hypot(a.pos().x - mid.x, a.pos().z - mid.z)).toBeLessThan(2);
    // 点地打断方向输入
    k.press(1, 0);
    a.act('navigate', { to: 'plaza' });
    expect(nav(a)!.target.kind).toBe('place');
    t.advance(300);
    expect(a.pos().moving).toBe(true);
    // 方向输入的租约不会把点地路线截短：点地路线仍按 10 秒租约走
    expect(nav(a)!.leaseUntil).toBe(t.clock.t - 300 + t.w.params.navLeaseMs);
  });

  it('点地路线进行中收到旧的方向输入（旧序号）：不打断', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    k.press(1, 0, { seq: 10 });
    a.act('navigate', { to: 'tea_house' });
    const click = nav(a)!;
    expect(k.press(0, 1, { seq: 9 })).toEqual({ ok: false, reason: 'stale' });
    expect(nav(a)!.navigationId).toBe(click.navigationId);
  });

  it('方向输入的路线不能用点地的 10 秒续租撑长', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    new Keys(a).press(1, 0);
    const n = nav(a)!;
    const r = renewNavigation(t.w, a.auth, { navigationId: n.navigationId, revision: n.revision });
    expect(r.ok).toBe(false);
    expect(nav(a)!.leaseUntil).toBe(n.leaseUntil);
  });

  it('不能绕过门禁：方向输入走到会馆门口也不会进私宅，出不了私宅；进出仍只走 navigate', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    a.go('residential');
    const door = a.pos();
    for (let i = 0; i < 20; i++) {
      k.hold(-1, 0, 400);
      expect(a.pos().scene).toBe('town');
      expect(a.row().location_id).not.toMatch(/^home:/);
    }
    expect(a.pos().x).toBeLessThanOrEqual(door.x);
    // 在家里朝出口方向一直按：出不去
    a.go('home');
    expect(a.pos().scene).toBe('home');
    const inst = a.pos().instance;
    for (const dir of [[0, 1], [0, 1], [1, 1], [-1, 1]] as const) {
      k.hold(dir[0], dir[1], 2500);
      expect(a.pos()).toMatchObject({ scene: 'home', instance: inst });
      expect(a.row().location_id).toBe(`home:${a.residentId}`);
    }
  });

  it('小游戏中：被拒（in_activity），已经在走的在开局时站住', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go('arcade:table1');
    b.go('arcade:table1');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    const kb = new Keys(b);
    kb.press(0, 1);
    a.act('start_game', { activityId: id });
    expect(nav(b)).toBeNull();
    expect(failCode(() => kb.press(1, 0))).toBe('in_activity');
    expect(b.pos().moving).toBe(false);
  });

  it('坐着做的事：方向输入迈步也算走开', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('bookshop:shelf');
    const out = a.act('start_interaction', { objectId: 'bookshop:shelf' });
    expect(out.status).toBe('accepted');
    expect(a.view().interaction ?? a.view().context).toBeTruthy();
    const before = t.w.db.scalar("SELECT COUNT(*) FROM interaction_participants WHERE resident_id = ? AND active = 1", a.residentId);
    expect(before).toBe(1);
    new Keys(a).press(1, 0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM interaction_participants WHERE resident_id = ? AND active = 1", a.residentId)).toBe(0);
  });
});

describe('方向输入：不变量', () => {
  it('事件和公开流里没有坐标、折线；快照里只给同一场景实例的人，且 nav 只有折线、速度、时间', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const c = t.join('阿树');
    c.go('home');
    const k = new Keys(a);
    for (let i = 0; i < 20; i++) {
      k.hold(i % 2 ? 1 : -1, i % 3 === 0 ? 1 : 0, 600);
      if (i % 5 === 4) {
        a.heartbeat();
        b.heartbeat();
        c.heartbeat();
      }
    }
    k.release();
    const text = JSON.stringify([a.events().events, b.events().events, c.events().events, t.w.db.all('SELECT payload FROM world_events').map((r) => r.payload)]);
    expect(text).not.toMatch(/"(x|z|points|polyline|leaseUntil|startedAt)"/);
    const inHome = sceneView(t.w, c.row(), t.clock.t);
    expect(inHome.actors.map((x) => x.id)).toEqual([c.residentId]);
    const outside = sceneView(t.w, b.row(), t.clock.t);
    expect(outside.actors.find((x) => x.id === c.residentId)).toBeUndefined();
  });

  it('每次变化都递增 nav_revision；旧版本的 nav_step 任务不能挪动角色', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const revs: number[] = [];
    for (let i = 0; i < 6; i++) {
      k.press(1, 0);
      revs.push(actorOf(t.w, a.residentId)!.nav_revision);
      t.advance(120);
    }
    expect(new Set(revs).size).toBe(revs.length);
    k.release();
    const row = actorOf(t.w, a.residentId)!;
    expect(row.nav_revision).toBeGreaterThan(revs[revs.length - 1]!);
    const at = a.pos();
    t.advance(5000);
    expect(a.pos()).toMatchObject({ x: at.x, z: at.z });
    const jobs = t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'");
    expect(jobs).toBe(0);
  });

  it('区域标签跟着脚下走；走进别的区域时同场景的人收到 arrived，本人没有事件', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const cb = b.events().cursor;
    const ca = a.events().cursor;
    const k = new Keys(a);
    k.hold(0, 1, 4000);
    k.release();
    expect(a.row().location_id).not.toBe('plaza');
    expect(a.events(ca).events.filter((e) => e.type === 'arrived' || e.type === 'you_arrived' || e.type === 'nav_stopped')).toEqual([]);
    expect(b.events(cb).events.some((e) => e.type === 'left')).toBe(true);
  });

  it('服务器重启：方向输入走到一半，人停在最后一个耐久位置，不会越过租约，旧任务不再挪动她', () => {
    const file = tempDb();
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    try {
      const a = t.join('阿灯');
      const k = new Keys(a);
      const start = a.pos();
      k.press(1, 0);
      t.advance(300);
      const at = a.pos();
      expect(at.x).toBeGreaterThan(start.x);
      t.restart({ crash: true });
      const row = actorOf(t.w, a.residentId)!;
      expect(row.nav).toBeNull();
      expect(row.x - start.x).toBeLessThanOrEqual((speed(t) * leaseMs(t)) / 1000 + 1e-9);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
      a.enter();
      const k2 = new Keys(a);
      expect(k2.press(1, 0, { seq: 1 })).toMatchObject({ ok: true, moving: true });
    } finally {
      file.cleanup();
    }
  });
});

describe('方向输入：审查补充', () => {
  const dbChanges = (t: Town) => Number(t.w.db.scalar('SELECT total_changes()'));

  it('家里的家具互动：开始互动就停下当前的方向路线；之后再按方向键会走开（站起来）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go('home');
    const k = new Keys(a);
    const nook = a.view().here!.objects.find((o) => o.type === 'rest_nook')!;
    k.press(1, 0);
    t.advance(100);
    expect(nav(a)?.target.kind).toBe('dir');
    const out = a.act('start_interaction', { objectId: nook.id });
    expect(out.status).toBe('accepted');
    expect(nav(a)).toBeNull();
    const at = a.pos();
    t.advance(700);
    expect(a.pos().x).toBeCloseTo(at.x, 6);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM interaction_participants WHERE resident_id = ? AND active = 1', a.residentId)).toBe(1);
    // 站着不动时再按：每条非零方向帧都跑走开钩子，互动结束
    k.press(1, 0);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM interaction_participants WHERE resident_id = ? AND active = 1', a.residentId)).toBe(0);
  });

  it('序号栅栏：点地先到、发在点地之前的方向帧后到 → 丢弃，点地路线保留；之后更大序号的新按键接手', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    k.press(1, 0); // seq 1
    t.advance(150);
    k.press(1, 0); // seq 2
    t.advance(50);
    // 页面此刻已发出 seq 3（在途），随后点地，栅栏 = 3
    const out = a.act('navigate', { to: 'tea_house', dirFence: { conn: k.source, seq: 3 } });
    expect(out.status).toBe('accepted');
    const clickNav = nav(a)!;
    expect(clickNav.target.kind).not.toBe('dir');
    // 迟到的 seq 3：丢弃
    expect(k.press(1, 0, { seq: 3 })).toEqual({ ok: false, reason: 'stale' });
    expect(nav(a)!.navigationId).toBe(clickNav.navigationId);
    expect(nav(a)!.revision).toBe(clickNav.revision);
    // 新的按下沿用更大的序号：接手
    t.advance(100);
    expect(k.press(1, 0, { seq: 4 })).toMatchObject({ ok: true, moving: true });
    expect(nav(a)!.target.kind).toBe('dir');
  });

  it('序号栅栏：停下（stop_navigation）同样带栅栏；新连接、新 epoch 不受旧栅栏影响；没带或坏格式的栅栏被忽略', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    k.press(1, 0);
    a.act('stop_navigation', { dirFence: { conn: k.source, seq: 50 } });
    expect(k.press(1, 0, { seq: 50 })).toEqual({ ok: false, reason: 'stale' });
    expect(k.press(1, 0, { seq: 51 })).toMatchObject({ ok: true, moving: true });
    // 新连接（连接序号更大）从 1 开始，不受旧连接栅栏影响
    a.act('stop_navigation', { dirFence: { conn: 1, seq: 500 } });
    expect(k.press(1, 0, { seq: 1, source: 2 })).toMatchObject({ ok: true });
    // 栅栏里是更旧的连接：不动高水位
    a.act('navigate', { to: 'tea_house', dirFence: { conn: 1, seq: 9999 } });
    expect(k.press(1, 0, { seq: 2, source: 2 })).toMatchObject({ ok: true });
    // 坏格式：忽略，不报错
    for (const bad of ['x', 7, { conn: 'a', seq: 1 }, { conn: 2, seq: -1 }, { conn: 2 }, null]) {
      a.act('stop_navigation', { dirFence: bad });
    }
    expect(k.press(1, 0, { seq: 3, source: 2 })).toMatchObject({ ok: true });
    // 新 epoch（接管）：状态重建，栅栏作废
    a.act('stop_navigation', { dirFence: { conn: 2, seq: 800 } });
    const b = new Keys(a);
    b.source = 3;
    expect(b.press(1, 0, { seq: 1 })).toMatchObject({ ok: true });
  });

  it('stale、rate_limited 和「没有方向路线时的零向量」不进事务：数据库没有任何写入', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    k.press(1, 0, { seq: 10 });
    t.advance(60);
    let before = dbChanges(t);
    expect(k.press(1, 0, { seq: 10 })).toEqual({ ok: false, reason: 'stale' });
    expect(k.press(1, 0, { seq: 9 })).toEqual({ ok: false, reason: 'stale' });
    expect(dbChanges(t)).toBe(before);
    // 耗尽令牌后的限频帧也不写
    let seq = 11;
    while ((k.press(1, 0, { seq: seq++ }) as any).ok) t.advance(1);
    before = dbChanges(t);
    expect(k.press(1, 0, { seq })).toEqual({ ok: false, reason: 'rate_limited' });
    expect(dbChanges(t)).toBe(before);
    // 没有方向路线时的零向量
    t.advance(2000);
    k.press(0, 0, { seq: 1000 });
    before = dbChanges(t);
    expect(k.press(0, 0, { seq: 1001 })).toMatchObject({ ok: true, moving: false });
    expect(dbChanges(t)).toBe(before);
    // 点地路线在走时的零向量也不写、不取消
    a.act('navigate', { to: 'tea_house' });
    before = dbChanges(t);
    expect(k.press(0, 0, { seq: 1002 })).toMatchObject({ ok: true, moving: true });
    expect(dbChanges(t)).toBe(before);
  });

  it('令牌桶持续速率：每 50 毫秒一帧持续 3 秒，成功数 ≈ 突发 + 3 秒 × 每秒补充', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const r = k.press(i % 2 ? 0.5 : 1, 0.2);
      if (r.ok) ok++;
      else if (r.reason === 'rate_limited') limited++;
      t.advance(50);
    }
    const p = t.w.params;
    const expected = p.dirBurst + 3 * p.dirPerSecond;
    expect(ok).toBeGreaterThanOrEqual(expected - 2);
    expect(ok).toBeLessThanOrEqual(expected + 1);
    expect(ok + limited).toBe(60);
  });

  it('租约边界：499 毫秒时还在走，501 毫秒时已经停在租约截止点', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    const x0 = a.pos().x;
    const v = speed(t);
    k.press(1, 0);
    t.advance(499);
    expect(a.pos().moving).toBe(true);
    expect(a.pos().x - x0).toBeCloseTo((v * 499) / 1000, 3);
    t.advance(2);
    expect(a.pos().moving).toBe(false);
    expect(a.pos().x - x0).toBeCloseTo((v * leaseMs(t)) / 1000, 3);
    expect(nav(a)).toBeNull();
    t.advance(1000);
    expect(a.pos().x - x0).toBeCloseTo((v * leaseMs(t)) / 1000, 3);
  });

  it('每条非零方向帧都跑走开钩子（包括已经有方向路线时）；零向量不跑', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const k = new Keys(a);
    let n = 0;
    t.w.hooks.walk.push(() => void n++);
    k.press(1, 0);
    t.advance(100);
    k.press(1, 0);
    t.advance(100);
    k.press(0, 1);
    expect(n).toBe(3);
    k.release();
    expect(n).toBe(3);
  });
});
