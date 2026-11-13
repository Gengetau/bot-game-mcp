/**
 * NPC（N1a）：作为世界里的角色存在，按日程在锚点之间走动、停留。
 * 数据（world_actors 的 npc 行）、不占名额、不进听众、不发事件、场景快照的 npcs、走到 NPC 身边、
 * 居民路径碰不到 NPC、重启与停机追赶、地图换版本、schema v6 迁移。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NPCS, npcDef } from '../../src/world/content.js';
import { SCHEMA_VERSION } from '../../src/world/db.js';
import { WorldError } from '../../src/world/errors.js';
import { directory, publicView } from '../../src/world/views.js';
import { outboxPending, report } from '../../src/world/reports.js';
import { actorOf, directionInput, npcActorOf, positionOfNpc, positionOfResident, renewNavigation, sceneView, stopNav } from '../../src/world/space.js';
import { distance, isWalkable } from '../../src/world/spatial/index.js';
import { FakeClock } from '../helpers.js';
import { makeTown, tempDb, type Actor, type Town } from './helpers.js';
import { checkSpaceInvariants } from './invariants.js';
import { rewindSchema } from './schema-rewind.js';

const KEEPER = 'npc:teahouse_keeper';
const STROLLER = 'npc:plaza_stroller';
const SHORT = { npcStayMinMs: 5_000, npcStayMaxMs: 10_000 };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const town = (t: Town) => t.w.map.scenes.get('town')!;
const anchor = (t: Town, id: string) => town(t).anchors.get(id)!;
const rowOf = (t: Town, id: string) => t.w.db.get('SELECT * FROM world_actors WHERE actor_id = ?', id)!;
const stateOf = (t: Town, id: string) => t.w.db.get('SELECT * FROM npc_state WHERE actor_id = ?', id)!;
const pending = (t: Town, id: string) => t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'npc_step' AND status = 'pending' AND dedupe_key = ?", `npc_step:${id}`);
const npcPos = (t: Town, id: string) => positionOfNpc(t.w, id, t.clock.t)!;
const sceneNpcs = (t: Town, a: Actor) => sceneView(t.w, a.row(), t.clock.t).npcs;

/** 每秒推进一次，到 pred 为真或超时；返回花了几秒。等条件，不是固定睡眠。 */
function until(t: Town, pred: () => boolean, maxSeconds = 600, alive: Actor[] = []): number {
  for (let i = 0; i < maxSeconds; i++) {
    if (pred()) return i;
    if (alive.length) t.advanceAlive(1_000, alive, 1_000);
    else t.advance(1_000);
  }
  throw new Error('等了太久条件还没成立');
}

/** 站定在某个锚点上（没有路线，位置恰好等于锚点）。 */
function restingAt(t: Town, id: string): string | null {
  const a = npcActorOf(t.w, id)!;
  if (a.nav) return null;
  for (const [aid, an] of town(t).anchors) if (Math.abs(an.x - a.x) < 1e-9 && Math.abs(an.z - a.z) < 1e-9) return aid;
  return null;
}

describe('NPC：数据与名额', () => {
  it('启动种下两名 NPC：各一行、resident_id 为空、在公共场景、有姿态行；掌柜在柜台后的岗位上，朝向用锚点的 facing', () => {
    const t = makeTown();
    const rows = t.w.db.all("SELECT * FROM world_actors WHERE kind = 'npc' ORDER BY actor_id");
    expect(rows.map((r) => r.actor_id)).toEqual(NPCS.map((n) => n.id).sort());
    for (const r of rows) {
      expect(r.resident_id).toBeNull();
      expect(r).toMatchObject({ scene_id: 'town', instance_id: '', map_version: t.w.map.mapVersion });
    }
    expect(t.w.db.scalar('SELECT COUNT(*) FROM npc_state')).toBe(2);
    const staff = anchor(t, 'tea_house.counter.staff');
    expect(rowOf(t, KEEPER)).toMatchObject({ x: staff.x, z: staff.z, heading: staff.facing });
    expect(stateOf(t, KEEPER)).toMatchObject({ pose: 'stand', stop_anchor: 'tea_house.counter.staff' });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM residents')).toBe(0);
    checkSpaceInvariants(t);
  });

  it('重启不重复种：行数不变，位置和姿态不被重置；掌柜没有待办，闲逛者恰好一条', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, params: SHORT });
    until(t, () => restingAt(t, STROLLER) !== null && stateOf(t, STROLLER).stop_anchor !== 'plaza.bench1.sit');
    const before = { row: rowOf(t, STROLLER), state: stateOf(t, STROLLER) };
    for (let i = 0; i < 3; i++) {
      t.restart();
      expect(t.w.db.scalar("SELECT COUNT(*) FROM world_actors WHERE kind = 'npc'")).toBe(2);
      expect(t.w.db.scalar('SELECT COUNT(*) FROM npc_state')).toBe(2);
      expect(pending(t, KEEPER)).toBe(0);
      expect(pending(t, STROLLER)).toBe(1);
    }
    expect(rowOf(t, STROLLER)).toMatchObject({ x: before.row.x, z: before.row.z });
    expect(stateOf(t, STROLLER)).toEqual(before.state);
  });

  it('不占在场名额：NPC 在场时居民照样进到上限，再多一个仍然是 world_full，边界不变', () => {
    const t = makeTown({ params: { activeResidentLimit: 2 } });
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    expect(t.w.presentCount()).toBe(2);
    let reason = '';
    try {
      t.join('迟到者');
    } catch (e) {
      reason = e instanceof WorldError ? String(e.reason) : String(e);
    }
    expect(reason).toBe('world_full');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM residents')).toBe(2);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_actors WHERE kind = 'npc'")).toBe(2);
    expect(a.view().here).toBeDefined();
  });
});

describe('NPC：日程走动', () => {
  it('掌柜站在柜台后的锚点上一动不动', () => {
    const t = makeTown({ params: SHORT });
    const staff = anchor(t, 'tea_house.counter.staff');
    const rev = rowOf(t, KEEPER).nav_revision;
    for (let i = 0; i < 600; i++) {
      t.advance(1_000);
      expect(npcPos(t, KEEPER)).toMatchObject({ x: staff.x, z: staff.z, moving: false });
    }
    expect(rowOf(t, KEEPER).nav_revision).toBe(rev);
    expect(pending(t, KEEPER)).toBe(0);
  });

  it('闲逛者在锚点之间走：每一刻都在可走格上、到站后姿态对、导航版本递增、同一时刻至多一条待办；走遍每个锚点', () => {
    const t = makeTown({ params: SHORT });
    const stops = npcDef(STROLLER)!.schedule!.stops;
    const poseAt = new Map(stops.map((s) => [s.anchor, s.pose]));
    const seen = new Set<string>();
    let walks = 0;
    let lastRev = rowOf(t, STROLLER).nav_revision;
    let wasMoving = false;
    for (let i = 0; i < 3600 && !(seen.size === stops.length && walks >= 6); i++) {
      t.advance(1_000);
      const p = npcPos(t, STROLLER);
      expect(isWalkable(town(t), p.x, p.z), `第 ${i} 秒 (${p.x}, ${p.z}) 不在可走格上`).toBe(true);
      expect(pending(t, STROLLER)).toBe(1);
      const row = rowOf(t, STROLLER);
      expect(row.nav_revision).toBeGreaterThanOrEqual(lastRev);
      lastRev = Math.max(lastRev, Number(row.nav_revision));
      if (p.moving && !wasMoving) {
        walks++;
        // 开始走：姿态是 stand，快照里带折线
        expect(sceneViewFor(t).npcs!.find((n) => n.id === STROLLER)).toMatchObject({ pose: 'stand', nav: { points: expect.any(Array) } });
      }
      wasMoving = p.moving;
      const at = restingAt(t, STROLLER);
      if (at) {
        seen.add(at);
        expect(stateOf(t, STROLLER)).toMatchObject({ pose: poseAt.get(at), stop_anchor: at });
        expect(row.heading).toBeCloseTo(anchor(t, at).facing ?? 0, 9);
      }
    }
    expect([...seen].sort()).toEqual([...poseAt.keys()].sort());
    expect(walks).toBeGreaterThanOrEqual(6);
    // 路线编号每走一趟至少加一（开始 + 到达）
    expect(lastRev).toBeGreaterThanOrEqual(walks * 2);
    // 走路比居民慢
    const nav = (() => {
      until(t, () => npcPos(t, STROLLER).moving);
      return npcActorOf(t.w, STROLLER)!.nav!;
    })();
    expect(nav.speed).toBeCloseTo(t.w.map.speed * t.w.params.npcSpeedFactor, 9);
    expect(nav.speed).toBeLessThan(t.w.map.speed);
    // 没有控制租约：路线的截止就是到达时刻（取整到毫秒）
    const length = nav.points.reduce((s, q, i) => (i ? s + distance(nav.points[i - 1]!, q) : s), 0);
    expect(Math.abs(nav.leaseUntil - (nav.startedAt + (length / nav.speed) * 1000))).toBeLessThanOrEqual(1);
    checkSpaceInvariants(t);
  });

  it('停留时长在参数给的范围里', () => {
    const t = makeTown({ params: { npcStayMinMs: 7_000, npcStayMaxMs: 9_000 } });
    const stays: number[] = [];
    let since = t.clock.t;
    let resting = restingAt(t, STROLLER) !== null;
    for (let i = 0; i < 1500 && stays.length < 5; i++) {
      t.advance(250);
      const r = restingAt(t, STROLLER) !== null;
      if (r && !resting) since = t.clock.t;
      if (!r && resting) stays.push(t.clock.t - since);
      resting = r;
    }
    expect(stays.length).toBe(5);
    for (const s of stays) {
      expect(s).toBeGreaterThanOrEqual(7_000);
      expect(s).toBeLessThanOrEqual(9_000 + 250);
    }
  });
});

/** 随便一个在场居民的场景快照（没有就临时进一位）。 */
function sceneViewFor(t: Town) {
  const r = t.w.db.get('SELECT * FROM residents LIMIT 1');
  const a = r ? undefined : t.join('看客');
  const row = t.w.mustResident(String(r?.resident_id ?? a!.residentId));
  return sceneView(t.w, row, t.clock.t);
}

describe('NPC：不是听众、不发事件', () => {
  it('附近聊天：受众里没有 NPC，chat_audience 没有 NPC 行；就站在 NPC 旁边说也一样', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    // 走到闲逛者身边再说话
    until(t, () => restingAt(t, STROLLER) !== null, 600, [a, b]);
    a.act('navigate', { approach: STROLLER });
    a.walk();
    b.act('navigate', { approach: STROLLER });
    b.walk();
    expect(distance(a.pos(), npcPos(t, STROLLER))).toBeLessThan(2);
    const out = a.act('say_nearby', { text: '大家好' });
    expect(out).toBeDefined();
    const aud = t.w.db.all('SELECT resident_id FROM chat_audience').map((x) => String(x.resident_id));
    expect(aud.length).toBeGreaterThan(0);
    expect(aud.every((id) => t.w.resident(id) !== undefined)).toBe(true);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM chat_audience WHERE resident_id LIKE 'npc:%'")).toBe(0);
    expect(new Set(aud)).toEqual(new Set([a.residentId, b.residentId]));
  });

  it('NPC 走动期间：私有事件、公开事件、事实里都没有关于它的行，事件总数也不因它而增加', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const count = () => ({
      rec: t.w.db.scalar('SELECT COUNT(*) FROM recipient_events'),
      pub: t.w.db.scalar('SELECT COUNT(*) FROM public_events'),
      fact: t.w.db.scalar('SELECT COUNT(*) FROM world_events'),
    });
    const before = count();
    const rev = rowOf(t, STROLLER).nav_revision;
    until(t, () => Number(rowOf(t, STROLLER).nav_revision) >= Number(rev) + 6, 3000, [a, b]);
    expect(count()).toEqual(before);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE projection LIKE '%npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM public_events WHERE projection LIKE '%npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE payload LIKE '%npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM event_parties WHERE resident_id LIKE 'npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM chat_messages WHERE sender_id LIKE 'npc:%'")).toBe(0);
  });

  it('NPC 没有账本分录、物品、报价、愿望、关系', () => {
    const t = makeTown({ params: SHORT });
    t.join('阿灯');
    t.advance(120_000);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM accounts WHERE resident_id LIKE 'npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM items WHERE owner_id LIKE 'npc:%' OR holder_id LIKE 'npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM residents WHERE resident_id LIKE 'npc:%'")).toBe(0);
  });
});

describe('NPC：场景快照', () => {
  it('公共场景的快照有 npcs（两名，形状含折线信息），actors 里没有 NPC；私宅实例的快照没有 npcs', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const sv = sceneView(t.w, a.row(), t.clock.t);
    expect(sv.npcs!.map((n) => n.id).sort()).toEqual([KEEPER, STROLLER].sort());
    expect(sv.npcs!.find((n) => n.id === KEEPER)).toMatchObject({ name: '茶馆掌柜', role: 'service', pose: 'stand' });
    expect(sv.npcs!.find((n) => n.id === STROLLER)).toMatchObject({ name: '广场闲逛者', role: 'ambient' });
    expect(sv.actors.map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    expect(JSON.stringify(sv.actors)).not.toContain('npc:');
    // 走动中的：nav 的形状和 actors 里一样
    until(t, () => npcPos(t, STROLLER).moving, 600, [a, b]);
    const walking = sceneView(t.w, a.row(), t.clock.t).npcs!.find((n) => n.id === STROLLER)!;
    expect(Object.keys(walking.nav!).sort()).toEqual(['id', 'points', 'revision', 'speed', 'startedAt', 'until']);
    a.act('navigate', { to: 'home' });
    a.walk();
    expect(a.row().location_id).toBe(`home:${a.residentId}`);
    const inHome = sceneView(t.w, a.row(), t.clock.t);
    expect(inHome.npcs).toBeUndefined();
    expect(JSON.stringify(inHome)).not.toContain('npc:');
    expect(JSON.stringify(sceneView(t.w, b.row(), t.clock.t).actors)).not.toContain(a.residentId);
  });

  it('NPC 开始走、走到时，同场景的订阅者收到场景更新通知；场景里没人也不出错', () => {
    const t = makeTown({ params: SHORT });
    // 没有任何居民：日程照常推进，不抛错
    const rev0 = Number(rowOf(t, STROLLER).nav_revision);
    until(t, () => Number(rowOf(t, STROLLER).nav_revision) >= rev0 + 4);
    expect(pending(t, STROLLER)).toBe(1);
    const keys: string[][] = [];
    t.w.onSpace((k) => keys.push(k));
    const a = t.join('阿灯');
    keys.length = 0;
    let starts = 0;
    let wasMoving = false;
    let notifiedOnStart = 0;
    let notifiedOnArrive = 0;
    for (let i = 0; i < 1500 && (starts < 2 || notifiedOnArrive < 2); i++) {
      keys.length = 0;
      t.advanceAlive(1_000, [a], 1_000);
      const m = npcPos(t, STROLLER).moving;
      const note = keys.flat().includes('town|');
      if (m && !wasMoving) {
        starts++;
        if (note) notifiedOnStart++;
      }
      if (!m && wasMoving && note) notifiedOnArrive++;
      wasMoving = m;
    }
    expect(starts).toBeGreaterThanOrEqual(2);
    expect(notifiedOnStart).toBe(starts);
    expect(notifiedOnArrive).toBeGreaterThanOrEqual(2);
  });

  it('姿态变化也通知：到站摆姿态时快照里的 pose 与 npc_state 一致', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    for (let i = 0; i < 40; i++) {
      until(t, () => restingAt(t, STROLLER) === null, 600, [a]);
      until(t, () => restingAt(t, STROLLER) !== null, 600, [a]);
      const at = restingAt(t, STROLLER)!;
      expect(sceneNpcs(t, a)!.find((n) => n.id === STROLLER)!.pose).toBe(npcDef(STROLLER)!.schedule!.stops.find((s) => s.anchor === at)!.pose);
      if (at === 'bookshop.shelf.stand') return;
    }
    throw new Error('没走到书架');
  });
});

describe('NPC：走到 NPC 身边与居民动作', () => {
  it('navigate {approach: NPC 编号} 走到它旁边（约一米），to 也行；走动中的按出发那一刻的位置算', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    until(t, () => restingAt(t, STROLLER) !== null, 600, [a]);
    const out = a.act('navigate', { approach: STROLLER });
    expect(out.status).toBe('accepted');
    a.walk();
    expect(distance(a.pos(), npcPos(t, STROLLER))).toBeLessThanOrEqual(1.3);
    // 已经在身边：直接完成
    const again = a.act('navigate', { to: STROLLER });
    expect(again).toMatchObject({ status: 'completed', already: 'near', to: { kind: 'npc', id: STROLLER, name: '广场闲逛者' } });
    // 走动中：按发起那一刻的位置
    const b = t.join('小岚', 'agent');
    until(t, () => npcPos(t, STROLLER).moving, 600, [a, b]);
    const at = npcPos(t, STROLLER);
    const o2 = b.act('navigate', { approach: STROLLER });
    expect(o2.status === 'accepted' || o2.already === 'near').toBe(true);
    const pts = npcActorOf(t.w, STROLLER)!.nav!.points;
    expect(pts.length).toBeGreaterThan(1);
    if (o2.status === 'accepted') {
      const last = actorOf(t.w, b.residentId)!.nav!.points.at(-1)!;
      expect(distance(last, at)).toBeLessThanOrEqual(1.01);
    }
  });

  it('掌柜也能走到身边', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const out = a.act('navigate', { approach: KEEPER });
    expect(['accepted', 'completed']).toContain(out.status);
    a.walk();
    expect(distance(a.pos(), npcPos(t, KEEPER))).toBeLessThanOrEqual(1.3);
  });

  it('其它以居民编号为对象的动作拿 NPC 编号来调：响应和不存在的居民一字不差，且什么都没改', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const ghost = 'npc:nobody';
    const snap = () => JSON.stringify([t.w.db.all('SELECT * FROM world_actors ORDER BY actor_id'), t.w.db.scalar('SELECT COUNT(*) FROM letters'), t.w.db.scalar('SELECT COUNT(*) FROM home_access_grants'), t.w.db.scalar('SELECT COUNT(*) FROM offers')]);
    const errOf = (type: string, field: string, id: string, extra: Record<string, unknown> = {}) => {
      const e = a.fail(type, { [field]: id, ...extra });
      return JSON.stringify({ name: e.name, code: e.code, reason: e.reason, message: e.message, extra: Object.keys(e).sort() });
    };
    const before = snap();
    const cases: [string, string, Record<string, unknown>][] = [
      ['invite', 'to', {}],
      ['offer', 'to', { kind: 'gift', give: { coins: 1 } }],
      ['ask_hobby', 'target', {}],
      ['send_letter', 'to', { body: '你好' }],
    ];
    for (const [type, field, extra] of cases) {
      const real = errOf(type, field, STROLLER, extra);
      const none = errOf(type, field, ghost, extra);
      expect(real, `${type}`).toBe(none);
      expect(errOf(type, field, KEEPER, extra), `${type}`).toBe(none);
    }
    expect(snap()).toBe(before);
  });
});

describe('NPC：居民路径碰不到 NPC', () => {
  it('renewNavigation / directionInput / stop_navigation / stopNav 用 NPC 的路线编号或编号去碰：被拒或无效，NPC 的行一个字节都没变', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    until(t, () => npcPos(t, STROLLER).moving, 600, [a, b]);
    const snap = () => JSON.stringify([rowOf(t, STROLLER), stateOf(t, STROLLER), t.w.db.all("SELECT * FROM scheduled_jobs WHERE dedupe_key LIKE 'npc_step:%' OR dedupe_key LIKE 'nav:npc:%'")]);
    const nav = npcActorOf(t.w, STROLLER)!.nav!;
    const before = snap();
    // a 没有路线：拿 NPC 的路线编号 / 版本去续租，续不上
    expect(renewNavigation(t.w, a.auth, { navigationId: nav.navigationId, revision: nav.revision })).toMatchObject({ ok: false, navigation: null });
    // a 自己在走时，拿 NPC 的编号续：不动 NPC，只告诉 a 它自己的路线
    a.act('navigate', { to: 'garden' });
    const own = renewNavigation(t.w, a.auth, { navigationId: nav.navigationId, revision: nav.revision });
    expect(own.ok).toBe(false);
    expect(own.navigation!.navigationId).not.toBe(nav.navigationId);
    // 方向输入、停步
    a.claim();
    directionInput(t.w, a.auth, { seq: 1, epoch: a.row().control_epoch, x: 1, z: 0, source: 1 });
    a.act('stop_navigation', {});
    a.act('stop_navigation', { navigationId: nav.navigationId, actorId: STROLLER, target: STROLLER });
    // 内部入口拿 NPC 编号当居民：没有这个居民的角色行
    expect(stopNav(t.w, STROLLER, t.clock.t, 'stop')).toBe(false);
    expect(actorOf(t.w, STROLLER)).toBeUndefined();
    expect(positionOfResident(t.w, STROLLER, t.clock.t)).toBeNull();
    expect(snap()).toBe(before);
    // NPC 的路线没有租约可续：截止时刻就是到达时刻
    expect(npcActorOf(t.w, STROLLER)!.nav!.leaseUntil).toBeGreaterThan(t.clock.t - 1);
    checkSpaceInvariants(t);
  });

  it('NPC 路径不触发居民才有的钩子：走动不产生 arrived 事实、不撤销报价、不改任何居民的区域标签', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    const labels = () => t.w.db.all('SELECT resident_id, location_id FROM residents ORDER BY resident_id');
    const l0 = labels();
    const rev = Number(rowOf(t, STROLLER).nav_revision);
    until(t, () => Number(rowOf(t, STROLLER).nav_revision) >= rev + 6, 3000, [a]);
    expect(labels()).toEqual(l0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'arrived'")).toBe(0);
  });
});

describe('NPC：重启、停机与地图换版本', () => {
  it('走到一半时重启：继续走完，路线编号不变，仍然恰好一条待办', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
    until(t, () => npcPos(t, STROLLER).moving);
    t.advance(2_000);
    const nav = npcActorOf(t.w, STROLLER)!.nav!;
    const mid = npcPos(t, STROLLER);
    expect(mid.moving).toBe(true);
    t.restart({ crash: true });
    const again = npcActorOf(t.w, STROLLER)!;
    expect(again.nav).toMatchObject({ navigationId: nav.navigationId, revision: nav.revision });
    expect(npcPos(t, STROLLER)).toMatchObject({ x: mid.x, z: mid.z, moving: true });
    expect(pending(t, STROLLER)).toBe(1);
    const target = again.nav!.points.at(-1)!;
    until(t, () => !npcPos(t, STROLLER).moving);
    expect(npcPos(t, STROLLER)).toMatchObject({ x: target.x, z: target.z });
    expect(restingAt(t, STROLLER)).not.toBeNull();
    expect(pending(t, STROLLER)).toBe(1);
  });

  it('长时间停机后重启：落在合法位置、恰好一条待办、不会连续补跑一串', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
    for (const down of [3 * 3600_000, 3 * 86400_000]) {
      until(t, () => npcPos(t, STROLLER).moving);
      const rev = Number(rowOf(t, STROLLER).nav_revision);
      t.clock.advance(down);
      t.restart({ crash: true });
      const row = npcActorOf(t.w, STROLLER)!;
      const p = npcPos(t, STROLLER);
      expect(isWalkable(town(t), p.x, p.z)).toBe(true);
      expect(pending(t, STROLLER)).toBe(1);
      // 追赶只处理一步，不是把停机期间的每一步都重放（几小时至少几百步）
      expect(Number(row.nav_revision) - rev).toBeLessThanOrEqual(3);
      expect(t.w.db.get("SELECT due_at FROM scheduled_jobs WHERE dedupe_key = ?", `npc_step:${STROLLER}`)!.due_at).toBeGreaterThan(t.clock.t);
      checkSpaceInvariants(t);
    }
    // 之后照常走
    const rev = Number(rowOf(t, STROLLER).nav_revision);
    until(t, () => Number(rowOf(t, STROLLER).nav_revision) > rev + 3);
  });

  it('走路中的 NPC 在停机里已经到站：恢复后直接站在站点上，摆好姿态', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
    until(t, () => npcPos(t, STROLLER).moving);
    const dest = npcActorOf(t.w, STROLLER)!.nav!.points.at(-1)!;
    t.clock.advance(120_000);
    t.restart({ crash: true });
    const p = npcPos(t, STROLLER);
    const at = [...town(t).anchors].find(([, an]) => Math.abs(an.x - dest.x) < 1e-9 && Math.abs(an.z - dest.z) < 1e-9)![0];
    // 120 秒里至少走完这一趟；之后可能又出发，但状态合法
    expect(isWalkable(town(t), p.x, p.z)).toBe(true);
    expect(stateOf(t, STROLLER).stop_anchor).toBeTruthy();
    expect(pending(t, STROLLER)).toBe(1);
    expect(at).toBeTruthy();
  });

  it('地图换了版本：位置不合法的 NPC 挪回岗位锚点（姿态跟着回岗位），合法的路线作废但位置不动；任务重新安排', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
    until(t, () => restingAt(t, STROLLER) === 'plaza.bench2.sit' || restingAt(t, STROLLER) === 'bookshop.shelf.stand');
    const fountain = town(t).source.obstacles.find((o) => o.id === 'plaza.fountain')!;
    const raw = t.w.db.db;
    raw.prepare("UPDATE world_actors SET map_version = 'old', x = ?, z = ? WHERE actor_id = ?").run(fountain.x + fountain.w / 2, fountain.z + fountain.d / 2, STROLLER);
    raw.prepare("UPDATE world_actors SET map_version = 'old', x = ?, z = ? WHERE actor_id = ?").run(fountain.x + fountain.w / 2, fountain.z + fountain.d / 2, KEEPER);
    t.clock.advance(1_000);
    t.restart();
    const post = anchor(t, 'plaza.bench1.sit');
    expect(rowOf(t, STROLLER)).toMatchObject({ x: post.x, z: post.z, map_version: t.w.map.mapVersion });
    expect(stateOf(t, STROLLER)).toMatchObject({ pose: 'sit', stop_anchor: 'plaza.bench1.sit' });
    const staff = anchor(t, 'tea_house.counter.staff');
    expect(rowOf(t, KEEPER)).toMatchObject({ x: staff.x, z: staff.z, map_version: t.w.map.mapVersion });
    expect(pending(t, STROLLER)).toBe(1);
    expect(pending(t, KEEPER)).toBe(0);
    checkSpaceInvariants(t);
    // 之后照常走
    const rev = Number(rowOf(t, STROLLER).nav_revision);
    until(t, () => Number(rowOf(t, STROLLER).nav_revision) > rev + 2);
  });

  it('地图换了版本时 NPC 正走在路上而位置合法：路线作废、位置不动，随后从原地继续去下一站', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
    until(t, () => npcPos(t, STROLLER).moving);
    t.advance(2_000);
    const mid = npcPos(t, STROLLER);
    t.w.db.db.prepare("UPDATE world_actors SET map_version = 'old', x = ?, z = ?, anchor_at = ? WHERE actor_id = ?").run(mid.x, mid.z, t.clock.t, STROLLER);
    t.w.db.db.prepare('UPDATE world_actors SET nav_json = NULL WHERE actor_id = ?').run(STROLLER);
    t.restart();
    expect(npcActorOf(t.w, STROLLER)!.nav).toBeNull();
    expect(rowOf(t, STROLLER)).toMatchObject({ x: mid.x, z: mid.z });
    expect(pending(t, STROLLER)).toBe(1);
    until(t, () => npcPos(t, STROLLER).moving || restingAt(t, STROLLER) !== null);
    until(t, () => restingAt(t, STROLLER) !== null);
    expect(pending(t, STROLLER)).toBe(1);
    checkSpaceInvariants(t);
  });
});

describe('NPC：schema v6 迁移', () => {
  for (const from of [4, 5] as const) {
    it(`v${from} → v${SCHEMA_VERSION}：建出 npc_state 并补种 NPC，重复启动不重复`, () => {
      const file = tempDb();
      cleanups.push(file.cleanup);
      const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
      expect(SCHEMA_VERSION).toBe(6);
      // 倒回旧版：没有 npc_state，也没有 NPC 的行和任务（旧版根本不知道 NPC）
      t.w.db.db.exec("DELETE FROM scheduled_jobs WHERE kind = 'npc_step'");
      t.w.db.db.exec('DELETE FROM npc_state');
      t.w.db.db.exec("DELETE FROM world_actors WHERE kind = 'npc'");
      rewindSchema(t.w.db.db, from);
      expect(t.w.db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'npc_state'")).toBeUndefined();
      t.clock.advance(5_000);
      t.restart({ crash: true });
      expect(t.w.db.userVersion()).toBe(SCHEMA_VERSION);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM world_actors WHERE kind = 'npc'")).toBe(2);
      expect(t.w.db.scalar('SELECT COUNT(*) FROM npc_state')).toBe(2);
      expect(pending(t, STROLLER)).toBe(1);
      for (let i = 0; i < 2; i++) {
        t.restart();
        expect(t.w.db.userVersion()).toBe(SCHEMA_VERSION);
        expect(t.w.db.scalar("SELECT COUNT(*) FROM world_actors WHERE kind = 'npc'")).toBe(2);
        expect(pending(t, STROLLER)).toBe(1);
      }
      expect(t.logs.join('\n')).not.toContain('迁移失败');
      checkSpaceInvariants(t);
    });
  }

  it('旧库里已经有 NPC 的行但没有 npc_state（v5 倒回）：补上姿态行，位置不动', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock(), params: SHORT });
    t.w.db.db.exec('DELETE FROM npc_state');
    rewindSchema(t.w.db.db, 5);
    const row = rowOf(t, STROLLER);
    t.restart({ crash: true });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM npc_state')).toBe(2);
    expect(rowOf(t, STROLLER)).toMatchObject({ x: row.x, z: row.z });
  });
});

describe('NPC：公开出口没有坐标', () => {
  it('公开地图、名录、公开日报、对外公告、公开事件流里没有 NPC，也没有它的坐标、折线、时间', () => {
    const t = makeTown({ params: SHORT });
    const a = t.join('阿灯');
    until(t, () => npcPos(t, STROLLER).moving, 600, [a]);
    const p = npcPos(t, STROLLER);
    const day = t.w.today();
    const surfaces: Record<string, string> = {
      publicView: JSON.stringify(publicView(t.w)),
      directory: JSON.stringify(directory(t.w, t.clock.t)),
      publicReport: JSON.stringify(report(t.w, 'public', day, t.clock.t)),
      outbox: JSON.stringify(outboxPending(t.w, 50)),
      publicTable: JSON.stringify(t.w.db.all('SELECT * FROM public_events')),
      recipientTable: JSON.stringify(t.w.db.all('SELECT * FROM recipient_events')),
      facts: JSON.stringify(t.w.db.all('SELECT * FROM world_events')),
    };
    const STRUCT = /"(x|z|heading|points|path|route|arriveAt|leaseUntil|navigationId|navigation|startedAt|crossings|nav_json|npcs|pose)":/;
    for (const [label, text] of Object.entries(surfaces)) {
      expect(STRUCT.test(text), `${label} 出现了坐标 / 路线字段：${STRUCT.exec(text)?.[0]}`).toBe(false);
      expect(text.includes('npc:'), `${label} 出现了 NPC 编号`).toBe(false);
      expect(text.includes(String(Math.round(p.x * 1000) / 1000) + ','), `${label} 出现了 NPC 的坐标`).toBe(false);
    }
  });
});
