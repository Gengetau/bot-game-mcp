/**
 * 空间权威：谁在哪、怎么走、够不够得着。位置只在这个模块里写。
 *
 * - 权威位置是「场景 + 实例 + x + z」（world_actors）。走路时不存每帧坐标：导航存折线、速度和出发时刻，
 *   任何时刻的位置用 positionAt 现算，并且截断在导航控制租约的截止时刻。
 * - residents.location_id 是区域标签（公共地点、'road'、'residential'、home:<房主>），只在跨区域的那一刻由这里改写，
 *   同一事务里触发离开 / 到达钩子和现场事件。别的模块按区域判断「在不在一起」，按 requireReach 判断够不够得着物件。
 * - 导航开始、改道、停止、跨场景、结束都是耐久变化：每次变化 navigationRevision 加一，定时任务对不上编号和版本就作废。
 * - 导航控制租约：只在走路时有，由客户端或运行器的普通程序续（不调用模型）。到期没续就停在租约截止那一刻的位置。
 *   离线、控制权被接管、控制连接断开，都立即停步。服务器重启后停在最后一个耐久检查点。
 * - 私宅是独立实例：进出只经过公共住宅接入点的会馆门口；门口再查一次权限。别人只看到有人走到会馆门口。
 */
import { homeId, homeOwner, isHome, npcDef, placeDef, type NpcDef, type NpcPose, type NpcRole } from './content.js';
import { parseJson, type Row } from './db.js';
import { WorldError, precondition } from './errors.js';
import { checkHomeAccess, spaceName, takeToken } from './life.js';
import { card, publicSpot } from './project.js';
import type { ActionHandler, Auth, WorldService } from './service.js';
import { manifestOf } from './spatial/compile.js';
import { distance, nearestWalkable, zoneAt } from './spatial/grid.js';
import { arrivalAt, positionAt, zoneCrossings } from './spatial/motion.js';
import { findPath, pathLength } from './spatial/path.js';
import { sweepDirection } from './spatial/sweep.js';
import type { CompiledScene, MapManifest, Motion, Vec2 } from './spatial/types.js';
import type { ActorRow, NavState, NavStep, NavTarget, ResidentRow } from './types.js';

/** 接近一位居民时停在离对方多远的地方（米）。 */
const APPROACH_GAP = 1.0;
/** 点地时允许点偏多远（米）：点在墙上、桌子上、喷泉上时取最近的可走点。 */
const CLICK_SNAP = 2.5;

/** 停步的原因。lease / control / activity 会通知本人（nav_stopped）；blocked、eject 由各自的流程通知；其余是本人自己的动作或离线，不通知。 */
export type StopReason = 'stop' | 'reroute' | 'lease' | 'offline' | 'control' | 'disconnect' | 'interaction' | 'activity';

// ───────────────────────── 地图布局 ─────────────────────────

interface Layout {
  town: CompiledScene;
  home: CompiledScene | null;
  /** 公共场景里的会馆门口（进出私宅的唯一位置） */
  doorOut: { x: number; z: number; heading: number };
  /** 私宅里进门落脚的位置 */
  doorIn: { x: number; z: number; heading: number };
  manifest: MapManifest;
}
const layouts = new WeakMap<WorldService, Layout>();

function layout(w: WorldService): Layout {
  let l = layouts.get(w);
  if (l) return l;
  const town = w.map.scenes.get(w.map.spawn.scene)!;
  const home = [...w.map.scenes.values()].find((s) => s.instanced) ?? null;
  const spawn = town.anchors.get(w.map.spawn.anchor)!;
  let doorOut = { x: spawn.x, z: spawn.z, heading: spawn.facing ?? 0 };
  let doorIn = { x: 0, z: 0, heading: 0 };
  if (home) {
    const out = [...town.portals.values()].find((p) => p.toScene === home.id);
    const back = [...home.portals.values()].find((p) => p.toScene === town.id);
    const a = out ? town.anchors.get(out.anchor) : undefined;
    const b = back ? home.anchors.get(back.anchor) : out ? home.anchors.get(out.toAnchor) : undefined;
    if (a) doorOut = { x: a.x, z: a.z, heading: a.facing ?? 0 };
    if (b) doorIn = { x: b.x, z: b.z, heading: b.facing ?? 0 };
  }
  l = { town, home, doorOut, doorIn, manifest: manifestOf(w.map) };
  layouts.set(w, l);
  return l;
}

const travelCache = new WeakMap<WorldService, Map<string, number | null>>();

/**
 * 两个地点之间大概要走多少秒（落脚点到落脚点，只是给人看的估计）。
 * 起点可以是任何区域标签：在家里按会馆门口算；在路上没有落脚点，返回 null。
 */
export function travelSeconds(w: WorldService, from: string, to: string): number | null {
  const L = layout(w);
  const a = w.map.aliases[isHome(from) ? 'residential' : from];
  const b = w.map.aliases[isHome(to) ? 'residential' : to];
  if (!a || !b || a.scene !== L.town.id || b.scene !== L.town.id) return null;
  if (a.anchor === b.anchor) return 0;
  let cache = travelCache.get(w);
  if (!cache) travelCache.set(w, (cache = new Map()));
  const key = a.anchor < b.anchor ? `${a.anchor}|${b.anchor}` : `${b.anchor}|${a.anchor}`;
  if (!cache.has(key)) {
    const path = findPath(L.town, L.town.anchors.get(a.anchor)!, L.town.anchors.get(b.anchor)!);
    cache.set(key, path ? Math.ceil(path.length / w.map.speed) : null);
  }
  return cache.get(key) ?? null;
}

/** 发给客户端的地图清单（地图源 + 栅格化后的网格 + 校验值）。 */
export function mapManifest(w: WorldService): MapManifest {
  return layout(w).manifest;
}

const sceneKeyOf = (a: { scene_id: string; instance_id: string }): string => `${a.scene_id}|${a.instance_id}`;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ───────────────────────── 角色行 ─────────────────────────

function hydrate(row: Row): ActorRow {
  return { ...(row as ActorRow), nav: parseJson<NavState | null>(row.nav_json, null) };
}

/** 居民的角色行。只认 kind='resident'：拿 NPC 的编号来问，等于没有这一行（居民路径碰不到 NPC）。 */
export function actorOf(w: WorldService, residentId: string): ActorRow | undefined {
  const row = w.db.get("SELECT * FROM world_actors WHERE actor_id = ? AND world_id = ? AND kind = 'resident'", residentId, w.worldId);
  return row ? hydrate(row) : undefined;
}

/** NPC 的角色行（kind='npc'）。 */
export function npcActorOf(w: WorldService, npcId: string): ActorRow | undefined {
  const row = w.db.get("SELECT * FROM world_actors WHERE actor_id = ? AND world_id = ? AND kind = 'npc'", npcId, w.worldId);
  return row ? hydrate(row) : undefined;
}

function saveActor(w: WorldService, a: ActorRow): void {
  a.pos_version += 1;
  w.db.run(
    'UPDATE world_actors SET scene_id = ?, instance_id = ?, x = ?, z = ?, heading = ?, anchor_at = ?, pos_version = ?, nav_revision = ?, nav_json = ?, map_version = ? WHERE actor_id = ?',
    a.scene_id,
    a.instance_id,
    a.x,
    a.z,
    a.heading,
    a.anchor_at,
    a.pos_version,
    a.nav_revision,
    a.nav ? JSON.stringify(a.nav) : null,
    a.map_version,
    a.actor_id,
  );
}

/** 一个区域标签对应的落脚点。不认识的标签落到出生点，并返回修正后的标签。 */
function spotFor(w: WorldService, label: string): { scene: string; instance: string; x: number; z: number; heading: number; label: string } {
  const L = layout(w);
  if (isHome(label) && L.home && w.resident(homeOwner(label))) {
    return { scene: L.home.id, instance: homeOwner(label), ...L.doorIn, label };
  }
  const alias = w.map.aliases[label] ?? w.map.spawn;
  const scene = w.map.scenes.get(alias.scene)!;
  const anchor = scene.anchors.get(alias.anchor)!;
  return { scene: scene.id, instance: '', x: anchor.x, z: anchor.z, heading: anchor.facing ?? 0, label: zoneAt(scene, anchor.x, anchor.z).id };
}

/** 保证这位居民有空间角色行（新居民、从旧版迁移过来的居民）。没有就按区域标签落到对应的落脚点。 */
export function ensureActor(w: WorldService, r: ResidentRow, at: number): ActorRow {
  const existing = actorOf(w, r.resident_id);
  if (existing) return existing;
  const spot = spotFor(w, r.location_id);
  w.db.run(
    `INSERT INTO world_actors(actor_id, world_id, kind, resident_id, scene_id, instance_id, x, z, heading, anchor_at, map_version)
     VALUES (?,?,'resident',?,?,?,?,?,?,?,?)`,
    r.resident_id,
    w.worldId,
    r.resident_id,
    spot.scene,
    spot.instance,
    spot.x,
    spot.z,
    spot.heading,
    at,
    w.map.mapVersion,
  );
  if (spot.label !== r.location_id) {
    const fresh = w.mustResident(r.resident_id);
    fresh.location_id = spot.label;
    w.saveResident(fresh);
    r.location_id = spot.label;
  }
  return actorOf(w, r.resident_id)!;
}

// ───────────────────────── 位置 ─────────────────────────

const motionOf = (nav: NavState): Motion => ({ points: nav.points, speed: nav.speed, startedAt: nav.startedAt, until: nav.leaseUntil });
const legArrival = (nav: NavState): number => arrivalAt({ points: nav.points, speed: nav.speed, startedAt: nav.startedAt });

export interface Pos {
  scene: string;
  instance: string;
  x: number;
  z: number;
  heading: number;
  moving: boolean;
}

/** 这一刻的权威位置。走路时按折线现算，截断在租约截止时刻。 */
export function posOf(a: ActorRow, now: number): Pos {
  if (!a.nav) return { scene: a.scene_id, instance: a.instance_id, x: a.x, z: a.z, heading: a.heading, moving: false };
  const s = positionAt(motionOf(a.nav), now);
  return { scene: a.scene_id, instance: a.instance_id, x: s.x, z: s.z, heading: s.heading, moving: !s.arrived && !s.halted };
}

/** 一位居民这一刻的位置；还没有角色行的（刚迁移）返回 null。只读，不写库。 */
export function positionOfResident(w: WorldService, residentId: string, now: number): Pos | null {
  const a = actorOf(w, residentId);
  return a ? posOf(a, now) : null;
}

/** 两位居民之间的距离（米）。不在同一个场景实例里返回 null。 */
export function distanceBetween(w: WorldService, aId: string, bId: string, now: number): number | null {
  const a = positionOfResident(w, aId, now);
  const b = positionOfResident(w, bId, now);
  if (!a || !b || a.scene !== b.scene || a.instance !== b.instance) return null;
  return distance(a, b);
}

// ───────────────────────── 区域变化 ─────────────────────────

/**
 * 区域标签变了：先让各模块收尾（撤销没完成的交换、退出报名），通知两边在场的人，更新公开位置，再触发到达钩子。
 * 位置本身由调用方先写好。不在场的居民只改标签，不产生任何现场或公开事件。
 */
function changeSpace(w: WorldService, residentId: string, to: string, at: number): void {
  let r = w.mustResident(residentId);
  const from = r.location_id;
  if (from === to) return;
  for (const h of w.hooks.leaveSpace) h(r, from, at);
  r = w.mustResident(residentId);
  const visible = r.present_since !== null && !r.activity_id;
  if (visible) {
    const others = w.audienceIn(from).filter((x) => x.resident_id !== residentId);
    w.emitTo(others.map((x) => x.resident_id), 'left', { resident: card(r), space: from }, at);
  }
  const before = publicSpot(r);
  r.location_id = to;
  w.saveResident(r);
  if (visible) {
    const others = w.audienceIn(to).filter((x) => x.resident_id !== residentId);
    w.emitTo(others.map((x) => x.resident_id), 'arrived', { resident: card(r), space: to }, at);
  }
  // 公开层面只到「住宅区」：在住宅区内部进出家门，公开位置不变，也就不进公开流
  const after = publicSpot(r);
  if (r.present_since !== null && before.at !== after.at) w.emitPublic('place', { resident: after }, at);
  for (const h of w.hooks.arrive) h(w.mustResident(residentId), to, at);
}

/** 站定之后核对一次：区域标签必须等于脚下的区域（防止毫秒取整让标签和坐标差一格）。 */
function reconcileLabel(w: WorldService, a: ActorRow, at: number): void {
  const scene = w.map.scenes.get(a.scene_id);
  if (!scene || scene.instanced || a.kind === 'npc' || !a.resident_id) return;
  const zone = zoneAt(scene, a.x, a.z).id;
  if (zone !== w.mustResident(a.resident_id).location_id) changeSpace(w, a.resident_id, zone, at);
}

/**
 * 把一位居民直接安置到某处（穿过进出口、被请出门）。正在走的先在原地停下（不发通知），
 * 返回被打断的那一趟，由调用方决定怎么告诉本人。
 */
function relocate(w: WorldService, residentId: string, dest: { scene: string; instance: string; x: number; z: number; heading: number }, label: string, at: number): { actor: ActorRow; interrupted: NavState | null } {
  let a = actorOf(w, residentId) ?? ensureActor(w, w.mustResident(residentId), at);
  let interrupted: NavState | null = null;
  if (a.nav) {
    a = settle(w, a, at);
    if (a.nav) {
      interrupted = a.nav;
      a = halt(w, a, at, 'reroute');
    }
  }
  w.bumpSpace(sceneKeyOf(a));
  a.scene_id = dest.scene;
  a.instance_id = dest.instance;
  a.x = dest.x;
  a.z = dest.z;
  a.heading = dest.heading;
  a.anchor_at = at;
  a.nav = null;
  saveActor(w, a);
  w.bumpSpace(sceneKeyOf(a));
  changeSpace(w, residentId, label, at);
  return { actor: actorOf(w, residentId)!, interrupted };
}

/** 把一位居民请到会馆门口（邀请到期或被撤销时，把还在屋里的客人送出来）。 */
export function sendToDoor(w: WorldService, residentId: string, at: number): void {
  const L = layout(w);
  const { interrupted } = relocate(w, residentId, { scene: L.town.id, instance: '', ...L.doorOut }, zoneAt(L.town, L.doorOut.x, L.doorOut.z).id, at);
  const r = w.mustResident(residentId);
  if (interrupted && r.present_since !== null) w.emitTo([residentId], 'nav_stopped', { reason: 'eject', target: interrupted.target, space: r.location_id }, at);
}

// ───────────────────────── 导航的结算 ─────────────────────────

const jobKey = (actorId: string): string => `nav:${actorId}`;

function scheduleStep(w: WorldService, a: ActorRow): void {
  const nav = a.nav;
  if (!nav) return;
  const next = Math.min(nav.crossings[0]?.at ?? Infinity, legArrival(nav), nav.leaseUntil);
  w.reschedule('nav_step', jobKey(a.actor_id), next, { actorId: a.actor_id, navigationId: nav.navigationId, revision: nav.revision });
}

function sameNav(a: ActorRow | undefined, nav: NavState): a is ActorRow & { nav: NavState } {
  return Boolean(a?.nav && a.nav.navigationId === nav.navigationId && a.nav.revision === nav.revision);
}

/** 这一趟结束了（到了、停了、被截住了）：换了地方就记一条「到过某处」。路过不算，路上不算，住宅不算。 */
function noteArrival(w: WorldService, residentId: string, fromSpace: string, at: number): void {
  const r = w.mustResident(residentId);
  const here = r.location_id;
  if (here === fromSpace || isHome(here) || placeDef(here)?.through) return;
  w.fact('arrived', [{ id: residentId, role: 'self' }], { place: here }, { occurredAt: at });
}

/**
 * 把导航停在 at 这一刻的位置（不会超过租约截止）。调用前应先 settle 到 at。
 * reroute 不记「到过某处」、不发通知：紧接着就会装上新的路线。
 */
function halt(w: WorldService, a: ActorRow, at: number, reason: StopReason): ActorRow {
  if (a.kind === 'npc') return haltNpc(w, a, at);
  const nav = a.nav;
  if (!nav) return a;
  const s = positionAt(motionOf(nav), at);
  a.x = s.x;
  a.z = s.z;
  a.heading = s.heading;
  a.anchor_at = Math.min(at, nav.leaseUntil);
  a.nav = null;
  a.nav_revision += 1;
  saveActor(w, a);
  w.cancelJob(jobKey(a.actor_id));
  w.bumpSpace(sceneKeyOf(a));
  reconcileLabel(w, a, a.anchor_at);
  if (reason === 'reroute') return a;
  const rid = a.resident_id!;
  noteArrival(w, rid, nav.fromSpace, a.anchor_at);
  // 方向输入靠一次次续输入走路，松手后到期停步是常态，不通知
  if (reason === 'control' || reason === 'activity' || (reason === 'lease' && nav.target.kind !== 'dir')) {
    const r = w.mustResident(rid);
    if (r.present_since !== null) w.emitTo([rid], 'nav_stopped', { reason, target: nav.target, space: r.location_id }, a.anchor_at);
  }
  return actorOf(w, rid)!;
}

/** 走完一段：穿过进出口、接着走下一段，或者真的到了。 */
function finishLeg(w: WorldService, a: ActorRow, at: number): ActorRow {
  if (a.kind === 'npc') return finishNpcNav(w, a, at);
  const nav = a.nav!;
  const rid = a.resident_id!;
  const L = layout(w);
  const end = nav.points[nav.points.length - 1]!;
  a.heading = positionAt(motionOf(nav), at).heading;
  a.x = end.x;
  a.z = end.z;
  a.anchor_at = at;
  a.nav = null;
  a.nav_revision += 1;
  saveActor(w, a);
  w.cancelJob(jobKey(a.actor_id));
  w.bumpSpace(sceneKeyOf(a));
  reconcileLabel(w, a, at);
  const steps = [...nav.after];
  while (steps.length > 0) {
    const step = steps.shift()!;
    const r = w.mustResident(rid);
    if (step.op === 'exit') {
      a = relocate(w, rid, { scene: L.town.id, instance: '', ...L.doorOut }, zoneAt(L.town, L.doorOut.x, L.doorOut.z).id, at).actor;
      continue;
    }
    if (step.op === 'enter') {
      // 到门口时再查一次：路上邀请过期或被撤销，就停在门外
      const access = L.home && w.resident(homeOwner(step.home)) ? checkHomeAccess(w, r, step.home, at) : { ok: false as const, why: '没有这户人家。' };
      if (!access.ok) {
        if (r.present_since !== null) {
          w.emitTo([rid], 'notice', { text: `你走到了${spaceName(w, step.home, rid)}门口，但没能进去：${access.why}` }, at);
          w.emitTo([rid], 'nav_stopped', { reason: 'blocked', target: nav.target, space: r.location_id }, at);
        }
        noteArrival(w, rid, nav.fromSpace, at);
        return actorOf(w, rid)!;
      }
      a = relocate(w, rid, { scene: L.home!.id, instance: homeOwner(step.home), ...L.doorIn }, step.home, at).actor;
      continue;
    }
    // 在新场景里接着走
    let next: Plan;
    try {
      next = plan(w, r, a, step.to, at);
    } catch (e) {
      if (e instanceof WorldError && e.reason === 'already_here') break;
      if (!(e instanceof WorldError)) throw e;
      if (r.present_since !== null) w.emitTo([rid], 'nav_stopped', { reason: 'blocked', target: nav.target, space: r.location_id }, at);
      noteArrival(w, rid, nav.fromSpace, at);
      return actorOf(w, rid)!;
    }
    if (next.already) break;
    return install(w, a, next.points, { navigationId: nav.navigationId, target: nav.target, after: [...next.after, ...steps], fromSpace: nav.fromSpace, startedAt: at, leaseUntil: nav.leaseUntil, checkpointAt: Math.max(at, nav.checkpointAt) });
  }
  const r = w.mustResident(rid);
  if (r.present_since !== null && nav.target.kind !== 'dir') w.emitTo([rid], 'you_arrived', { space: r.location_id, name: spaceName(w, r.location_id, rid), target: nav.target }, at);
  noteArrival(w, rid, nav.fromSpace, at);
  return actorOf(w, rid)!;
}

/**
 * 把导航推进到 upTo：按时间顺序结算沿路的区域变化、到达、租约到期。返回时导航可能已经结束。
 * 结算用的是事件各自应该发生的时刻（保留应到达时间），不是处理的时刻。
 */
function settle(w: WorldService, a: ActorRow, upTo: number): ActorRow {
  if (a.kind === 'npc') return settleNpc(w, a, upTo);
  for (let guard = 0; a.nav && guard < 64; guard++) {
    const nav = a.nav;
    const limit = Math.min(upTo, nav.leaseUntil);
    const arrive = legArrival(nav);
    const crossing = nav.crossings[0];
    if (crossing && crossing.at <= limit && crossing.at <= arrive) {
      nav.crossings.shift();
      // 区域变化已经被业务用过：重启后不能退回到这之前
      nav.checkpointAt = Math.max(nav.checkpointAt, crossing.at);
      saveActor(w, a);
      changeSpace(w, a.resident_id!, crossing.zone, crossing.at);
      const fresh = actorOf(w, a.actor_id);
      // 钩子里有人动了这位居民的路线（比如被请出门）：以数据库里的为准
      if (!sameNav(fresh, nav)) return fresh ?? a;
      a = fresh;
      continue;
    }
    if (arrive <= limit) {
      a = finishLeg(w, a, arrive);
      continue;
    }
    if (upTo >= nav.leaseUntil) a = halt(w, a, nav.leaseUntil, 'lease');
    break;
  }
  if (a.nav) scheduleStep(w, a);
  return a;
}

/** 让一位居民停步。没在走返回 false。 */
export function stopNav(w: WorldService, residentId: string, at: number, reason: StopReason): boolean {
  let a = actorOf(w, residentId);
  if (!a?.nav) return false;
  a = settle(w, a, at);
  if (!a.nav) return true;
  halt(w, a, at, reason);
  return true;
}

// ───────────────────────── NPC 的放置与走动 ─────────────────────────
//
// NPC 是 world_actors 里 kind='npc'、resident_id 为空的行。位置仍然只在这里写，但它和居民是两条路径：
// 没有导航控制租约（路线的截止时刻就是到达时刻）、没有区域标签、不进私宅、不触发任何离开 / 到达钩子、不发任何事件。
// 日程（去哪儿、停多久、什么姿态）在 npc.ts；这里只管放置、装路线、结算到达，以及让同场景的订阅者拿到新快照。

/** NPC 日程任务的去重键（每名会走动的 NPC 同一时刻至多一条待办）。 */
export const npcJobKey = (npcId: string): string => `npc_step:${npcId}`;

/** 一个地图锚点在公共场景里的落脚点；锚点不存在（地图没有它）就落到出生点。 */
export function anchorSpot(w: WorldService, anchorId: string): { x: number; z: number; heading: number } {
  const town = layout(w).town;
  const a = town.anchors.get(anchorId) ?? town.anchors.get(w.map.spawn.anchor)!;
  return { x: a.x, z: a.z, heading: a.facing ?? 0 };
}

/** 幂等地种下一名 NPC：角色行（公共场景、站在岗位上）和姿态行。已有的不动。 */
export function seedNpc(w: WorldService, def: NpcDef, at: number): void {
  if (!npcActorOf(w, def.id)) {
    const spot = anchorSpot(w, def.post.anchor);
    w.db.run(
      `INSERT INTO world_actors(actor_id, world_id, kind, resident_id, scene_id, instance_id, x, z, heading, anchor_at, map_version)
       VALUES (?,?,'npc',NULL,?,'',?,?,?,?,?)`,
      def.id,
      w.worldId,
      layout(w).town.id,
      spot.x,
      spot.z,
      spot.heading,
      at,
      w.map.mapVersion,
    );
  }
  w.db.run('INSERT OR IGNORE INTO npc_state(actor_id, pose, stop_anchor) VALUES (?,?,?)', def.id, def.post.pose, def.post.anchor);
}

export function npcStateOf(w: WorldService, npcId: string): { pose: NpcPose; stopAnchor: string } | undefined {
  const row = w.db.get('SELECT pose, stop_anchor FROM npc_state WHERE actor_id = ?', npcId);
  return row ? { pose: row.pose as NpcPose, stopAnchor: String(row.stop_anchor) } : undefined;
}

/** 改姿态和当前（或正在前往的）站点；姿态变了通知同场景的人。 */
export function setNpcState(w: WorldService, npcId: string, pose: NpcPose, stopAnchor: string): void {
  const before = npcStateOf(w, npcId);
  w.db.run('UPDATE npc_state SET pose = ?, stop_anchor = ? WHERE actor_id = ?', pose, stopAnchor, npcId);
  const a = npcActorOf(w, npcId);
  if (a && before?.pose !== pose) w.bumpSpace(sceneKeyOf(a));
}

/** 直接把 NPC 放到公共场景的某点（站定，没有路线）。导航编号照样加一，让旧路线对不上。 */
export function placeNpc(w: WorldService, npcId: string, spot: { x: number; z: number; heading: number }, at: number): ActorRow | undefined {
  const a = npcActorOf(w, npcId);
  if (!a) return undefined;
  a.scene_id = layout(w).town.id;
  a.instance_id = '';
  a.x = spot.x;
  a.z = spot.z;
  a.heading = spot.heading;
  a.anchor_at = at;
  a.nav = null;
  a.nav_revision += 1;
  saveActor(w, a);
  w.bumpSpace(sceneKeyOf(a));
  return npcActorOf(w, npcId);
}

/**
 * 让 NPC 从现在的位置走向公共场景里的一点。路线的截止（leaseUntil）就是到达时刻，没有人需要也没有人能续。
 * 走不到（没有路）返回 null；已经在那里返回 { arriveAt: at }（调用方当作到了）。
 */
export function navigateNpc(w: WorldService, npcId: string, goal: { x: number; z: number }, at: number, target: NavTarget): { arriveAt: number; navigationId: string; revision: number } | null {
  const a = npcActorOf(w, npcId);
  if (!a || a.nav) return null;
  const town = layout(w).town;
  if (a.scene_id !== town.id) return null;
  const path = findPath(town, { x: a.x, z: a.z }, goal);
  if (!path) return null;
  if (path.length <= 0.01 || path.points.length < 2) return { arriveAt: at, navigationId: '', revision: a.nav_revision };
  const speed = w.map.speed * w.params.npcSpeedFactor;
  const arriveAt = Math.ceil(arrivalAt({ points: path.points, speed, startedAt: at }));
  a.nav_revision += 1;
  a.anchor_at = at;
  a.nav = {
    // 编号由 NPC 编号和导航版本决定：不碰 w.rng（居民的随机序列不受 NPC 走动影响）
    navigationId: `nav_${a.actor_id.replace(/^npc:/, '')}_${a.nav_revision}`,
    revision: a.nav_revision,
    points: path.points,
    speed,
    startedAt: at,
    leaseUntil: arriveAt,
    checkpointAt: at,
    crossings: [],
    target,
    fromSpace: '',
    after: [],
  };
  saveActor(w, a);
  w.bumpSpace(sceneKeyOf(a));
  return { arriveAt, navigationId: a.nav.navigationId, revision: a.nav.revision };
}

/** 走完了：停在折线的终点。 */
function finishNpcNav(w: WorldService, a: ActorRow, at: number): ActorRow {
  const nav = a.nav;
  if (!nav) return a;
  const end = nav.points[nav.points.length - 1]!;
  a.heading = positionAt(motionOf(nav), at).heading;
  a.x = end.x;
  a.z = end.z;
  a.anchor_at = Math.min(at, nav.leaseUntil);
  a.nav = null;
  a.nav_revision += 1;
  saveActor(w, a);
  w.bumpSpace(sceneKeyOf(a));
  return npcActorOf(w, a.actor_id)!;
}

/** 在 at 这一刻停下（站在折线上的当前点）。 */
function haltNpc(w: WorldService, a: ActorRow, at: number): ActorRow {
  const nav = a.nav;
  if (!nav) return a;
  const s = positionAt(motionOf(nav), at);
  a.x = s.x;
  a.z = s.z;
  a.heading = s.heading;
  a.anchor_at = Math.min(at, nav.leaseUntil);
  a.nav = null;
  a.nav_revision += 1;
  saveActor(w, a);
  w.bumpSpace(sceneKeyOf(a));
  return npcActorOf(w, a.actor_id)!;
}

/** NPC 没有区域变化可结算：只看到没到达。 */
function settleNpc(w: WorldService, a: ActorRow, upTo: number): ActorRow {
  if (a.nav && legArrival(a.nav) <= upTo) return finishNpcNav(w, a, legArrival(a.nav));
  return a;
}

/** NPC 的此刻位置（按折线和时间现算）；没有这名 NPC 返回 null。 */
export function positionOfNpc(w: WorldService, npcId: string, now: number): Pos | null {
  const a = npcActorOf(w, npcId);
  return a ? posOf(a, now) : null;
}

// ───────────────────────── 规划路线 ─────────────────────────

interface Plan {
  points: Vec2[];
  target: NavTarget;
  after: NavStep[];
  /** 不用走：已经在旁边了 */
  already?: 'near';
}

function install(
  w: WorldService,
  a: ActorRow,
  points: Vec2[],
  o: { navigationId?: string; target: NavTarget; after: NavStep[]; fromSpace: string; startedAt: number; leaseUntil: number; checkpointAt?: number },
): ActorRow {
  const scene = w.map.scenes.get(a.scene_id)!;
  a.nav_revision += 1;
  a.x = points[0]!.x;
  a.z = points[0]!.z;
  a.anchor_at = o.startedAt;
  const motion: Motion = { points, speed: w.map.speed, startedAt: o.startedAt };
  a.nav = {
    navigationId: o.navigationId ?? w.id('nav'),
    revision: a.nav_revision,
    points,
    speed: w.map.speed,
    startedAt: o.startedAt,
    leaseUntil: o.leaseUntil,
    checkpointAt: o.checkpointAt ?? o.startedAt,
    crossings: scene.instanced ? [] : zoneCrossings(scene, motion).map((c) => ({ at: c.at, zone: c.zone })),
    target: o.target,
    fromSpace: o.fromSpace,
    after: o.after,
  };
  saveActor(w, a);
  scheduleStep(w, a);
  w.bumpSpace(sceneKeyOf(a));
  return a;
}

/** 折线从末尾往回收 gap 米（接近一个人时不踩到对方身上）。 */
function trimEnd(points: Vec2[], gap: number): Vec2[] {
  let left = Math.max(0, pathLength(points) - gap);
  const out: Vec2[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = distance(a, b);
    if (seg >= left) {
      const t = seg === 0 ? 0 : left / seg;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      return out;
    }
    out.push(b);
    left -= seg;
  }
  return out;
}

function pathOrThrow(scene: CompiledScene, from: Vec2, to: Vec2): Vec2[] {
  const path = findPath(scene, from, to);
  if (!path) throw precondition('走不到那里。', 'no_route');
  return path.points;
}

/**
 * 把一个目标变成第一段路线和之后的步骤。目标可以是：
 *   - 地图点 {x, z}（当前场景里，点偏了取最近的可走点）
 *   - 'home' / home:<居民编号>（要有进门的权限）
 *   - 地点编号（plaza、tea_house …，旧版的地点编号都还认）
 *   - 公共物件编号（走到离自己最近、走得到的使用位置）
 *   - 居民编号（走到对方身边；对方得在同一个场景里看得见）
 */
function plan(w: WorldService, r: ResidentRow, a: ActorRow, to: unknown, now: number, walking = false): Plan {
  const L = layout(w);
  const here = w.map.scenes.get(a.scene_id)!;
  const inHome = here.instanced;
  const from: Vec2 = { x: a.x, z: a.z };

  if (to && typeof to === 'object') {
    const p = to as { x?: unknown; z?: unknown };
    if (typeof p.x !== 'number' || typeof p.z !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.z)) throw precondition('没有这个地方。', 'no_such_place');
    const spot = nearestWalkable(here, { x: p.x, z: p.z }, CLICK_SNAP);
    if (!spot) throw precondition('那里走不过去。', 'unreachable');
    return { points: pathOrThrow(here, from, spot), target: { kind: 'point', name: '那边' }, after: [] };
  }

  let id = typeof to === 'string' ? to : '';
  if (id === 'home') id = homeId(r.resident_id);

  if (isHome(id)) {
    if (!L.home || !w.resident(homeOwner(id))) throw precondition('没有这户人家。', 'no_such_place');
    if (inHome && a.instance_id === homeOwner(id)) {
      // 正往门口走的人改主意要留在这一户：走回屋里；本来就站着的才是「已经在这里」
      const centre = here.anchors.get('centre');
      if (!walking || !centre) throw precondition('你已经在这里了。', 'already_here');
      return { points: pathOrThrow(here, from, { x: centre.x, z: centre.z }), target: { kind: 'home', id, name: spaceName(w, id, r.resident_id) }, after: [] };
    }
    const access = checkHomeAccess(w, r, id, now);
    if (!access.ok) throw precondition(`进不去：${access.why}`, 'no_access');
    const target: NavTarget = { kind: 'home', id, name: spaceName(w, id, r.resident_id) };
    if (inHome) return { points: pathOrThrow(here, from, L.doorIn), target, after: [{ op: 'exit' }, { op: 'enter', home: id }] };
    return { points: pathOrThrow(here, from, L.doorOut), target, after: [{ op: 'enter', home: id }] };
  }

  // 公共场景里的目标。人在家里的话：先走到门口出门，出了门再按同一个目标接着走
  const start: Vec2 = inHome ? L.doorOut : from;
  let goal: Vec2;
  let target: NavTarget;
  let already = false;
  const alias = w.map.aliases[id];
  const object = L.town.interactables.get(id);
  const other = id && id !== r.resident_id ? w.resident(id) : undefined;
  const npc = id && !alias && !object && !other && npcDef(id) ? npcActorOf(w, id) : undefined;
  if (alias && alias.scene === L.town.id) {
    const anchor = L.town.anchors.get(alias.anchor)!;
    const zone = zoneAt(L.town, anchor.x, anchor.z).id;
    // 站在这片区域里才是「已经在这里」。正在往外走的人说要去脚下这片区域，是改主意要回来：照常走回落脚点
    if (!inHome && r.location_id === zone && !walking) throw precondition('你已经在这里了。', 'already_here');
    goal = { x: anchor.x, z: anchor.z };
    target = { kind: 'place', id: zone, name: placeDef(zone)?.name ?? zone };
  } else if (object) {
    const spots = [...object.useAnchors].sort((p, q) => distance(start, p) - distance(start, q));
    const reachable = spots.find((p) => findPath(L.town, start, p));
    if (!reachable) throw precondition('走不到那里。', 'no_route');
    goal = reachable;
    target = { kind: 'object', id, name: object.name };
    already = !inHome && distance(from, object) <= (object.reach ?? w.map.interactDistance);
  } else if (npc) {
    // NPC 编号是公开的：走到它此刻位置旁边（走动中的按出发这一刻算），和走到居民身边同一套停靠距离
    if (npc.scene_id !== a.scene_id || npc.instance_id !== a.instance_id) throw precondition('这个人不在你看得见的地方。', 'not_here');
    const p = posOf(npc, now);
    target = { kind: 'npc', id: npc.actor_id, name: npcDef(npc.actor_id)!.name };
    if (distance(from, p) <= APPROACH_GAP + 0.25) return { points: [from, from], target, after: [], already: 'near' };
    return { points: trimEnd(pathOrThrow(here, from, { x: p.x, z: p.z }), APPROACH_GAP), target, after: [] };
  } else if (other) {
    const oa = actorOf(w, other.resident_id);
    if (!oa || other.present_since === null || oa.scene_id !== a.scene_id || oa.instance_id !== a.instance_id) throw precondition('这个人不在你看得见的地方。', 'not_here');
    const p = posOf(oa, now);
    target = { kind: 'resident', id: other.resident_id, name: other.name };
    if (distance(from, p) <= APPROACH_GAP + 0.25) return { points: [from, from], target, after: [], already: 'near' };
    return { points: trimEnd(pathOrThrow(here, from, { x: p.x, z: p.z }), APPROACH_GAP), target, after: [] };
  } else {
    throw precondition('没有这个地方。', 'no_such_place');
  }
  if (inHome) return { points: pathOrThrow(here, from, L.doorIn), target, after: [{ op: 'exit' }, { op: 'walk', to: id }] };
  if (already) return { points: [from, from], target, after: [], already: 'near' };
  return { points: pathOrThrow(L.town, from, goal), target, after: [] };
}

// ───────────────────────── 给别的模块用的判定 ─────────────────────────

/**
 * 够不够得着一件公共物件：按这一刻的权威位置量距离。够不着返回 too_far（附带可以 navigate 的目标）。
 * 够得着而且正在走，就先在这里站住——坐下来做的事需要人不动。地图上没有位置的物件（家里的）不按距离算。
 */
export function requireReach(w: WorldService, r: ResidentRow, objectId: string, now: number): void {
  const L = layout(w);
  const it = L.town.interactables.get(objectId);
  if (!it) {
    // 家里的物件不按距离，但开始互动就该站住（和公共物件一致），否则边走边「保持」
    const mine = actorOf(w, r.resident_id);
    if (mine?.nav) stopNav(w, r.resident_id, now, 'interaction');
    return;
  }
  const a = ensureActor(w, r, now);
  const p = posOf(a, now);
  if (a.scene_id !== L.town.id || distance(p, it) > (it.reach ?? w.map.interactDistance) + 0.01) {
    throw precondition(`离${it.name}太远了，先走到它旁边。`, 'too_far', { navigateTo: objectId });
  }
  if (a.nav) stopNav(w, r.resident_id, now, 'interaction');
}

/** 物件在地图上的位置（没有就是 null）；视图用它告诉居民够不够得着。 */
export function objectReach(w: WorldService, residentId: string, objectId: string, now: number): { near: boolean; distance: number } | null {
  const L = layout(w);
  const it = L.town.interactables.get(objectId);
  if (!it) return null;
  const p = positionOfResident(w, residentId, now);
  if (!p || p.scene !== L.town.id) return { near: false, distance: Infinity };
  const d = distance(p, it);
  return { near: d <= (it.reach ?? w.map.interactDistance) + 0.01, distance: d };
}

// ───────────────────────── 视图 ─────────────────────────

export interface NavBrief {
  navigationId: string;
  revision: number;
  to: NavTarget;
  /** 这一段预计走完的时刻；continues 为 true 时之后还要穿过门口接着走 */
  arriveAt: number;
  continues: boolean;
  leaseUntil: number;
  /** 多久续一次租约（毫秒） */
  renewEveryMs: number;
}

function navBrief(w: WorldService, nav: NavState): NavBrief {
  return {
    navigationId: nav.navigationId,
    revision: nav.revision,
    to: nav.target,
    arriveAt: legArrival(nav),
    continues: nav.after.length > 0,
    leaseUntil: nav.leaseUntil,
    renewEveryMs: w.params.navRenewEveryMs,
  };
}

export interface Whereabouts {
  /** 区域标签（和 location_id 一样） */
  space: string;
  scene: string;
  x: number;
  z: number;
  navigation: NavBrief | null;
}

/** 本人此刻在哪、有没有在走。只读。 */
export function whereabouts(w: WorldService, r: ResidentRow, now: number): Whereabouts {
  const a = actorOf(w, r.resident_id);
  if (!a) {
    const spot = spotFor(w, r.location_id);
    return { space: r.location_id, scene: spot.scene, x: spot.x, z: spot.z, navigation: null };
  }
  const p = posOf(a, now);
  // navigation 跟着耐久状态走：走到了、或者租约到期了，但结算任务还没处理的那一小会儿，它还在（位置已经不动了）
  return { space: r.location_id, scene: a.scene_id, x: round3(p.x), z: round3(p.z), navigation: a.nav ? navBrief(w, a.nav) : null };
}

export interface ActorView {
  id: string;
  name: string;
  kind: 'human' | 'agent' | 'npc';
  x: number;
  z: number;
  heading: number;
  /** 正在一局小游戏里（人在，但不参与现场互动） */
  busy?: 'game';
  /** 正在走：客户端按这条折线和服务器时间插值，走到 until 为止 */
  nav?: { id: string; revision: number; points: Vec2[]; speed: number; startedAt: number; until: number };
}

export interface NpcView {
  id: string;
  name: string;
  role: NpcRole;
  /** 站着、坐着、站着看书；走路时是 stand */
  pose: NpcPose;
  x: number;
  z: number;
  heading: number;
  /** 正在走：形状和 ActorView.nav 一样，客户端按它插值；NPC 没有控制租约，until 就是到达时刻 */
  nav?: { id: string; revision: number; points: Vec2[]; speed: number; startedAt: number; until: number };
}

export interface SceneView {
  protocol: 1;
  mapVersion: string;
  checksum: string;
  scene: string;
  /** 所在的区域标签；在私宅里是 home:<房主> */
  space: string;
  serverTime: number;
  self: string;
  actors: ActorView[];
  /** 公共场景里的 NPC（单独一个数组，不混进 actors）。私宅实例的快照没有这个字段。 */
  npcs?: NpcView[];
}

/**
 * 一位居民此刻看得见的场景：同一个场景实例里在场的人（含自己）。
 * 私宅实例里的人和坐标只给屋里的人；公共场景的人看不到任何私宅里的角色。
 */
export function sceneView(w: WorldService, viewer: ResidentRow, now: number): SceneView {
  const me = actorOf(w, viewer.resident_id);
  const spot = me ?? { ...spotFor(w, viewer.location_id), scene_id: '', instance_id: '' };
  const sceneId = me ? me.scene_id : (spot as { scene: string }).scene;
  const instanceId = me ? me.instance_id : (spot as { instance: string }).instance;
  // 不在场的人不在「现场」：只看得到自己停在哪里，看不到别人（否则离线的人能远程盯着整个场景）
  const rows = w.db.all(
    `SELECT a.*, r.name AS r_name, r.kind AS r_kind, r.activity_id AS r_activity FROM world_actors a JOIN residents r ON r.resident_id = a.resident_id
     WHERE a.world_id = ? AND a.scene_id = ? AND a.instance_id = ? AND ((? = 1 AND r.present_since IS NOT NULL) OR a.actor_id = ?) ORDER BY a.actor_id`,
    w.worldId,
    sceneId,
    instanceId,
    viewer.present_since !== null ? 1 : 0,
    viewer.resident_id,
  );
  const actors: ActorView[] = rows.map((row) => {
    const a = hydrate(row);
    const p = posOf(a, now);
    const view: ActorView = { id: a.actor_id, name: String(row.r_name), kind: row.r_kind as 'human' | 'agent', x: round3(p.x), z: round3(p.z), heading: round3(p.heading) };
    if (row.r_activity) view.busy = 'game';
    if (a.nav && p.moving) view.nav = navShape(a.nav);
    return view;
  });
  const view: SceneView = { protocol: 1, mapVersion: w.map.mapVersion, checksum: w.map.checksum, scene: sceneId, space: viewer.location_id, serverTime: now, self: viewer.resident_id, actors };
  if (instanceId === '' && !w.map.scenes.get(sceneId)?.instanced) view.npcs = npcViews(w, sceneId, now);
  return view;
}

function navShape(nav: NavState): NonNullable<ActorView['nav']> {
  return { id: nav.navigationId, revision: nav.revision, points: nav.points.map((q) => ({ x: round3(q.x), z: round3(q.z) })), speed: nav.speed, startedAt: nav.startedAt, until: Math.min(nav.leaseUntil, legArrival(nav)) };
}

/** 公共场景里的 NPC。NPC 的存在和位置是公开的（和公共地点一样），不依赖看的人在不在场。 */
function npcViews(w: WorldService, sceneId: string, now: number): NpcView[] {
  const rows = w.db.all(
    `SELECT a.*, s.pose AS s_pose FROM world_actors a JOIN npc_state s ON s.actor_id = a.actor_id
     WHERE a.world_id = ? AND a.kind = 'npc' AND a.scene_id = ? AND a.instance_id = '' ORDER BY a.actor_id`,
    w.worldId,
    sceneId,
  );
  const out: NpcView[] = [];
  for (const row of rows) {
    const def = npcDef(String(row.actor_id));
    if (!def) continue;
    const a = hydrate(row);
    const p = posOf(a, now);
    const v: NpcView = { id: def.id, name: def.name, role: def.role, pose: p.moving ? 'stand' : (row.s_pose as NpcPose), x: round3(p.x), z: round3(p.z), heading: round3(p.heading) };
    if (a.nav && p.moving) v.nav = navShape(a.nav);
    out.push(v);
  }
  return out;
}

/**
 * 场景快照里除了位置还有别的东西：谁在场、名字、是不是在一局小游戏里。
 * 这些变了（上线、离线、进出小游戏、改名）也要让同一场景实例里的人拿到新快照——调这个。
 * 只是通知（提交之后才发出去），不写任何位置。
 */
export function touchScene(w: WorldService, residentId: string): void {
  const a = actorOf(w, residentId);
  if (a) w.bumpSpace(sceneKeyOf(a));
}

/** 这位居民所在的场景实例的订阅键（和 w.onSpace 收到的键对应）。 */
export function sceneKeyOfResident(w: WorldService, residentId: string): string | null {
  const a = actorOf(w, residentId);
  return a ? sceneKeyOf(a) : null;
}

// ───────────────────────── 续租与断开 ─────────────────────────

/**
 * 续导航控制租约。只有握着控制权的客户端能续，而且只能续当前这一条（编号和版本都对得上）。
 * 不走回执管线：这是普通程序每几秒发一次的心跳，不是居民的动作。过期的路线续不回来。
 */
export function renewNavigation(
  w: WorldService,
  auth: Auth,
  body: { navigationId?: unknown; revision?: unknown },
): { ok: boolean; leaseUntil?: number; navigation: NavBrief | null; space: string } {
  if (w.status !== 'running') throw new WorldError('recovering', '小镇正在恢复，请稍后再试。');
  w.runDue();
  return w.commit(() => {
    const now = w.now();
    const r = w.residentOfPrincipal(auth.principalId);
    if (!r) throw new WorldError('unauthenticated', '还没有居民身份，请先进入小镇。', 'no_resident');
    if (r.present_since === null || r.controller_client !== auth.clientId || r.controller_until <= now) {
      throw new WorldError('control_lost', '这个页面（或运行器）现在没有这位居民的控制权。');
    }
    // space：脚下的区域。走路的人自己跨区域时没有事件，客户端靠它知道该重读现场了
    const space = (): string => w.mustResident(r.resident_id).location_id;
    let a = actorOf(w, r.resident_id);
    if (!a?.nav) return { ok: false, navigation: null, space: space() };
    if (a.nav.navigationId !== String(body.navigationId ?? '') || a.nav.revision !== Number(body.revision ?? NaN)) {
      // 续的是一条已经换掉的路线（或者没说是哪一段）：不动现在这条，把现在这条告诉对方
      return { ok: false, navigation: navBrief(w, a.nav), space: space() };
    }
    // 方向输入的短租约只由方向输入自己续，不能用 10 秒的点地租约把它撑长
    if (a.nav.target.kind === 'dir') return { ok: false, navigation: navBrief(w, a.nav), space: space() };
    a = settle(w, a, now);
    if (!a.nav) return { ok: false, navigation: null, space: space() };
    const until = Math.min(a.nav.leaseUntil, legArrival(a.nav));
    a.nav.leaseUntil = now + w.params.navLeaseMs;
    a.nav.checkpointAt = now;
    saveActor(w, a);
    scheduleStep(w, a);
    // 场景快照里的折线只走到 until：它没变（剩下的路本来就在租约之内）就不用打扰同场景的人
    if (Math.min(a.nav.leaseUntil, legArrival(a.nav)) !== until) w.bumpSpace(sceneKeyOf(a));
    return { ok: true, leaseUntil: a.nav.leaseUntil, navigation: navBrief(w, a.nav), space: space() };
  });
}

/** 控制连接明确断开（页面关了、运行器退出）：握着控制权的那个客户端断开，立即停步。别的页面断开不影响。 */
export function controlDisconnected(w: WorldService, auth: Auth): void {
  if (w.status !== 'running') return;
  w.commit(() => {
    const r = w.residentOfPrincipal(auth.principalId);
    if (!r || r.controller_client !== auth.clientId) return;
    stopNav(w, r.resident_id, w.now(), 'disconnect');
  });
}

/**
 * 要装一条新路线之前：正在走的先算出这一刻的合法位置，旧路线作废（改道）。
 * fromSpace 是这一趟（可能由好几次改道接成）出发时的区域标签，停下时拿它判断「到过某处」。
 */
function interruptForNewRoute(w: WorldService, r: ResidentRow, a: ActorRow, now: number): { a: ActorRow; fromSpace: string; rerouted: boolean } {
  let fromSpace = r.location_id;
  let rerouted = false;
  if (a.nav) {
    fromSpace = a.nav.fromSpace;
    a = settle(w, a, now);
    if (a.nav) {
      a = halt(w, a, now, 'reroute');
      rerouted = true;
    } else fromSpace = w.mustResident(r.resident_id).location_id;
  }
  return { a, fromSpace, rerouted };
}

// ───────────────────────── 方向输入 ─────────────────────────

/** 每位居民的方向输入状态（进程内存，不落库）：谁在控制、最后收到的序号、令牌桶。重启后清空，对安全没有影响。 */
interface DirState {
  clientId: string;
  epoch: number;
  source: number;
  seq: number;
  tokens: number;
  at: number;
}
const dirStates = new WeakMap<WorldService, Map<string, DirState>>();

/** 事务外的只读检查：在场、控制权、epoch。 */
function checkDirControl(w: WorldService, auth: Auth, epoch: number, now: number): ResidentRow {
  const r = w.residentOfPrincipal(auth.principalId);
  if (!r) throw new WorldError('unauthenticated', '还没有居民身份，请先进入小镇。', 'no_resident');
  if (r.present_since === null) throw precondition('你现在不在小镇里，请先进入。', 'not_present');
  if (r.controller_client !== auth.clientId || r.controller_until <= now || epoch !== r.control_epoch) {
    throw new WorldError('control_lost', '这个页面（或运行器）现在没有这位居民的控制权。');
  }
  return r;
}

function dirStateOf(w: WorldService, r: ResidentRow, clientId: string, epoch: number, source: number): DirState {
  let states = dirStates.get(w);
  if (!states) dirStates.set(w, (states = new Map()));
  let st = states.get(r.resident_id);
  if (!st || st.clientId !== clientId || st.epoch !== epoch) {
    // 换了控制者（接管、换页面）：旧的序号作废，重新开始
    st = { clientId, epoch, source, seq: -1, tokens: w.params.dirBurst, at: w.now() };
    states.set(r.resident_id, st);
  }
  return st;
}

/**
 * 点地 / 停下带来的序号栅栏 dirFence {conn, seq}：页面在发出这条动作时已经发出的最大方向序号（conn 是 hello 里的连接序号 dirConn）。
 * 点地走 HTTP、方向帧走 WebSocket，两条通道到达顺序不定；栅栏让「发在点地之前的方向帧」确定地作废，之后更大序号的新按键照常接手。
 * 只推进 (连接序号, seq) 的高水位，和乱序判断是同一把尺；没带或格式不对就忽略（AI / MCP 入口不带）。
 */
function applyDirFence(w: WorldService, r: ResidentRow, fence: unknown): void {
  if (!fence || typeof fence !== 'object') return;
  const { conn, seq } = fence as { conn?: unknown; seq?: unknown };
  if (typeof conn !== 'number' || typeof seq !== 'number' || !Number.isSafeInteger(conn) || !Number.isSafeInteger(seq) || seq < 0 || conn < 0) return;
  if (!r.controller_client) return;
  const st = dirStateOf(w, r, r.controller_client, r.control_epoch, conn);
  if (conn > st.source) {
    st.source = conn;
    st.seq = seq;
  } else if (conn === st.source) st.seq = Math.max(st.seq, seq);
}

export type DirInputResult =
  | { ok: true; moving: boolean; blocked?: boolean; navigation: NavBrief | null; space: string }
  | { ok: false; reason: 'stale' | 'rate_limited' };

/**
 * 键盘方向输入：把「朝这个方向走」变成一段短的直线导航。
 *
 * 客户端只发方向 (x, z)（x 向东，z 向南，长度不限，服务器只取方向）、递增的输入序号 seq、控制版本 epoch，不发坐标。
 * 服务器从这一刻的权威位置出发，沿方向走到可走范围的边缘（斜着撞墙就贴边滑一小段），长度上限 = 速度 × 方向租约；
 * 租约只有 dirLeaseMs（约 500 毫秒），所以客户端要在按住时每 150~200 毫秒重发一次，松手发零向量就地停下，什么都不发则最迟 500 毫秒后停。
 *
 * 和点地导航的关系：方向输入会打断正在走的路线（含点地路线）；点地、navigate 同样打断方向输入。零向量只停方向输入，不取消点地路线。
 * 方向输入只在当前场景里直走，没有进出口：进出私宅仍然只走 navigate（门口权限在那里查）。
 * 它不是居民动作：没有回执、不占 navigate 的令牌桶，写入在 w.commit() 的同一个事务里，不产生任何公开或私有事件。
 * 序号按 (连接序号 source, seq) 比较：同一条连接里序号必须递增；更新的连接（重连）的输入盖过旧连接的，旧连接迟到的输入丢弃。
 */
export function directionInput(
  w: WorldService,
  auth: Auth,
  body: { seq?: unknown; epoch?: unknown; x?: unknown; z?: unknown; source?: number },
): DirInputResult {
  if (w.status !== 'running') throw new WorldError('recovering', '小镇正在恢复，请稍后再试。');
  const { seq, epoch, x, z } = body;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new WorldError('bad_request', '需要整数的输入序号 seq。');
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch)) throw new WorldError('bad_request', '需要整数的控制版本 epoch。');
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > 4 || Math.abs(z) > 4) {
    throw new WorldError('bad_request', '方向需要两个有限的数字 x、z（绝对值不超过 4）。');
  }
  // 先在事务外做只读检查和内存里的序号、令牌桶：乱序 / 限频的帧，以及没有方向路线时的零向量，不进事务、不跑到期任务、不写库
  const now0 = w.now();
  const r0 = checkDirControl(w, auth, epoch, now0);
  const source = body.source ?? 0;
  const st = dirStateOf(w, r0, auth.clientId, epoch, source);
  if (source < st.source || (source === st.source && seq <= st.seq)) return { ok: false as const, reason: 'stale' as const };
  st.source = source;
  st.seq = seq;
  const len = Math.hypot(x, z);
  const stopping = len < 0.01;
  if (stopping) {
    const a0 = actorOf(w, r0.resident_id);
    if (!a0?.nav || a0.nav.target.kind !== 'dir') {
      return { ok: true as const, moving: Boolean(a0?.nav), navigation: a0?.nav ? navBrief(w, a0.nav) : null, space: r0.location_id };
    }
  } else {
    st.tokens = Math.min(w.params.dirBurst, st.tokens + ((now0 - st.at) / 1000) * w.params.dirPerSecond);
    st.at = now0;
    if (st.tokens < 1) return { ok: false as const, reason: 'rate_limited' as const };
    st.tokens -= 1;
  }
  w.runDue();
  return w.commit(() => {
    const now = w.now();
    const r = checkDirControl(w, auth, epoch, now);
    let a = ensureActor(w, r, now);
    const dirNav = a.nav?.target.kind === 'dir';
    const space = (): string => w.mustResident(r.resident_id).location_id;

    if (stopping) {
      // 零向量只停方向输入自己的路线；点地路线要按它自己的规则停
      if (!dirNav) return { ok: true as const, moving: Boolean(a.nav), navigation: a.nav ? navBrief(w, a.nav) : null, space: space() };
      stopNav(w, r.resident_id, now, 'stop');
      return { ok: true as const, moving: false, navigation: null, space: space() };
    }

    if (r.activity_id) throw precondition('你正在一局游戏里，这个动作要等游戏结束或退出后才能做。', 'in_activity');
    const first = interruptForNewRoute(w, r, a, now);
    a = first.a;
    for (const h of w.hooks.walk) h(w.mustResident(r.resident_id), now); // 离开是幂等的：每条非零方向帧都跑，家里的互动也会被站起来
    const scene = w.map.scenes.get(a.scene_id)!;
    const points = sweepDirection(scene, { x: a.x, z: a.z }, { x: x / len, z: z / len }, (w.map.speed * w.params.dirLeaseMs) / 1000);
    if (points.length < 2) {
      // 脸朝墙一步也走不了：原来那一趟（如果有）到此为止
      if (first.rerouted) noteArrival(w, r.resident_id, first.fromSpace, now);
      return { ok: true as const, moving: false, blocked: true, navigation: null, space: space() };
    }
    a = install(w, actorOf(w, r.resident_id)!, points, { target: { kind: 'dir', name: '方向' }, after: [], fromSpace: first.fromSpace, startedAt: now, leaseUntil: now + w.params.dirLeaseMs });
    return { ok: true as const, moving: true, navigation: navBrief(w, a.nav!), space: space() };
  });
}

// ───────────────────────── 安装 ─────────────────────────

export function installSpace(w: WorldService): void {
  layout(w);

  w.hooks.registered.push((r, now) => {
    ensureActor(w, r, now);
  });

  const navigate: ActionHandler = ({ r, action, now }) => {
    applyDirFence(w, r, action.dirFence);
    takeToken(w, r.resident_id, 'nav', w.params.navBurst, w.params.navPerMinute, now, '改路线');
    const first = interruptForNewRoute(w, r, ensureActor(w, r, now), now);
    let a = first.a;
    const { fromSpace, rerouted } = first;
    const me = w.mustResident(r.resident_id);
    const to = action.approach !== undefined ? String(action.approach) : (action.to ?? action.target);
    const p = plan(w, me, a, to, now, rerouted);
    if (p.already) {
      // 要去的地方就在身边：原来那一趟到此为止（已经停下了），照常记一次「到过某处」
      if (rerouted) noteArrival(w, r.resident_id, fromSpace, now);
      return { status: 'completed', already: p.already, to: p.target };
    }
    for (const h of w.hooks.walk) h(w.mustResident(r.resident_id), now);
    a = install(w, actorOf(w, r.resident_id)!, p.points, { target: p.target, after: p.after, fromSpace, startedAt: now, leaseUntil: now + w.params.navLeaseMs });
    // 人就站在门口时第一段路是零长度：当场穿过门口，接上下一段
    a = settle(w, a, now);
    if (!a.nav) return { status: 'completed', to: p.target, space: w.mustResident(r.resident_id).location_id };
    return { status: 'accepted', navigation: navBrief(w, a.nav) };
  };
  w.handlers.set('navigate', navigate);
  // 旧名字：move {to} 就是 navigate {to}
  w.handlers.set('move', navigate);

  w.handlers.set('stop_navigation', ({ r, action, now }) => {
    applyDirFence(w, r, action.dirFence);
    const stopped = stopNav(w, r.resident_id, now, 'stop');
    const here = whereabouts(w, w.mustResident(r.resident_id), now);
    return { status: 'completed', stopped, at: { space: here.space, x: here.x, z: here.z } };
  });

  w.jobHandlers.set('nav_step', (payload, job) => {
    const a = actorOf(w, String(payload.actorId));
    // 必须对上导航编号和版本：改道、停止之后，旧任务不能再挪动角色
    if (!a?.nav || a.nav.navigationId !== payload.navigationId || a.nav.revision !== payload.revision) return;
    settle(w, a, job.due_at);
  });
  // 旧版的到达任务：迁移时已经全部作废，留一个空处理器，免得漏网的旧任务反复报错
  w.jobHandlers.set('move_arrive', () => undefined);

  // 本人提交了别的动作：这一刻的位置已经被业务用过，记成耐久检查点（重启后不会退回到这之前）
  w.hooks.afterCommand.push((r, at) => {
    const a = actorOf(w, r.resident_id);
    if (!a?.nav || a.nav.checkpointAt >= at) return;
    a.nav.checkpointAt = at;
    w.db.run('UPDATE world_actors SET nav_json = ? WHERE actor_id = ?', JSON.stringify(a.nav), a.actor_id);
  });

  // 离线（明确离开、在场租约到期、服务器重启）：立即停步。重启时停在最后一个耐久检查点
  w.hooks.offline.push((r, at, reason) => {
    const a = actorOf(w, r.resident_id);
    // 离线的人从别人的场景快照里消失（她自己的快照也只剩自己）：不管当时在不在走，都要通知这个场景
    if (a) w.bumpSpace(sceneKeyOf(a));
    if (!a?.nav) return;
    if (a.map_version !== w.map.mapVersion) {
      // 这条路线是按旧地图规划的（换了地图版本之后的那次重启）：不拿新地图去结算旧折线，
      // 直接作废，人留在这一段的起点；位置和区域标签随后由 revalidatePositions 按新地图校正
      a.nav = null;
      a.nav_revision += 1;
      saveActor(w, a);
      w.cancelJob(jobKey(a.actor_id));
      return;
    }
    stopNav(w, r.resident_id, reason === 'restart' ? Math.max(at, a.nav.checkpointAt) : at, 'offline');
  });

  w.hooks.recover.push((_downtime, now) => {
    settleLegacyMoves(w, now);
    for (const row of w.db.all('SELECT r.resident_id FROM residents r LEFT JOIN world_actors a ON a.actor_id = r.resident_id WHERE r.world_id = ? AND a.actor_id IS NULL', w.worldId)) {
      ensureActor(w, w.mustResident(String(row.resident_id)), now);
    }
    revalidatePositions(w, now);
  });
}

/**
 * 从旧版（地点节点 + 固定用时）迁移过来的在途移动，按截止时刻结清一次：
 * 截止前已经该到的，按旧规则到达（进门前再查权限，进不去就留在会馆门口）；还没到的，停在出发的地方。
 * 新系统不根据旧地图的绘图坐标猜人走到了哪里。旧的到达任务在 schema 迁移时已经全部作废。
 */
function settleLegacyMoves(w: WorldService, cutoff: number): void {
  const rows = w.db.all('SELECT resident_id, move_json FROM residents WHERE world_id = ? AND move_json IS NOT NULL', w.worldId);
  for (const row of rows) {
    const move = parseJson<{ to?: string; arriveAt?: number } | null>(row.move_json, null);
    const rid = String(row.resident_id);
    w.db.run('UPDATE residents SET move_json = NULL WHERE resident_id = ?', rid);
    if (!move || typeof move.to !== 'string' || typeof move.arriveAt !== 'number' || move.arriveAt > cutoff) continue;
    const r = w.mustResident(rid);
    let dest = move.to;
    if (isHome(dest)) {
      const ok = w.resident(homeOwner(dest)) ? checkHomeAccess(w, r, dest, move.arriveAt).ok : false;
      if (!ok) dest = 'residential';
    } else {
      dest = spotFor(w, dest).label;
    }
    if (dest === r.location_id) continue;
    r.location_id = dest;
    w.saveResident(r);
    for (const h of w.hooks.arrive) h(w.mustResident(rid), dest, move.arriveAt);
    if (!isHome(dest) && !placeDef(dest)?.through) w.fact('arrived', [{ id: rid, role: 'self' }], { place: dest }, { occurredAt: move.arriveAt });
  }
}

/** 地图换了版本之后的 NPC：路线作废；位置在新地图上不合法（或不在公共场景）就挪回岗位锚点，姿态跟着回到岗位。 */
function revalidateNpc(w: WorldService, a: ActorRow, now: number): void {
  const def = npcDef(a.actor_id);
  const town = layout(w).town;
  const spot = a.scene_id === town.id && a.instance_id === '' ? nearestWalkable(town, { x: a.x, z: a.z }, 0) : null;
  a.nav = null;
  a.nav_revision += 1;
  a.map_version = w.map.mapVersion;
  if (!spot && def) {
    const post = anchorSpot(w, def.post.anchor);
    a.scene_id = town.id;
    a.instance_id = '';
    a.x = post.x;
    a.z = post.z;
    a.heading = post.heading;
    a.anchor_at = now;
    w.db.run('UPDATE npc_state SET pose = ?, stop_anchor = ? WHERE actor_id = ?', def.post.pose, def.post.anchor, a.actor_id);
    // 日程任务作废：npc.ts 的恢复钩子随后按岗位重新安排
    w.cancelJob(npcJobKey(a.actor_id));
  }
  saveActor(w, a);
  w.bumpSpace(sceneKeyOf(a));
}

/** 地图换了版本：位置在新地图上不合法的人，挪到所在区域的落脚点；区域划分变了的，标签跟着脚下走。不拿新地图去猜旧路线。 */
function revalidatePositions(w: WorldService, now: number): void {
  const stale = w.db.all('SELECT * FROM world_actors WHERE world_id = ? AND map_version <> ?', w.worldId, w.map.mapVersion).map(hydrate);
  for (const a of stale) {
    const scene = w.map.scenes.get(a.scene_id);
    const r = a.resident_id ? w.resident(a.resident_id) : undefined;
    if (a.kind === 'npc') {
      revalidateNpc(w, a, now);
      continue;
    }
    const ownerOk = !scene?.instanced || Boolean(w.resident(a.instance_id));
    const spot = scene && ownerOk ? nearestWalkable(scene, { x: a.x, z: a.z }, 0) : null;
    a.nav = null;
    a.nav_revision += 1;
    a.map_version = w.map.mapVersion;
    if (!spot && r) {
      const safe = spotFor(w, r.location_id);
      a.scene_id = safe.scene;
      a.instance_id = safe.instance;
      a.x = safe.x;
      a.z = safe.z;
      a.heading = safe.heading;
      a.anchor_at = now;
      if (safe.label !== r.location_id) {
        r.location_id = safe.label;
        w.saveResident(r);
      }
    }
    saveActor(w, a);
    w.cancelJob(jobKey(a.actor_id));
    // 位置还合法，但新地图上这里可能已经划给了别的区域：标签以脚下为准
    if (r) reconcileLabel(w, a, now);
  }
}
