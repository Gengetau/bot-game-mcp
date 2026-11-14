/**
 * 听得见谁（设计稿 v2.0 第 12 章：可见、可听、可交互分别判定）。
 *
 * 这里只回答「听」：一个人说的话，另一个人此刻听不听得到。只读权威位置（`posOf`）和编译后的地图，不写任何东西。
 * 看得见（场景快照）、够得着（`requireReach`）是另外两个判定，不能互相替代。
 *
 * 规则（首版，不做声学传播模拟）：
 *  1. 同一个场景实例。私宅是场景 home 的私有实例：别人家的实例里，哪怕坐标重合也互相听不见。
 *  2. 平面距离不超过地图的 `hearDistance`（米）。
 *  3. 同一个「房间」。室内区域（茶馆、书屋、厨房、游戏馆、住宅）各是自己的房间，墙和门洞都当作隔音：
 *     隔着墙站着的两个人，平面距离再近也互相听不见；同一场景里所有室外区域（广场、花园、会馆前、灯笼路）算同一个房间，
 *     所以在室外边走边聊可以跨过区域边界。地图可以在区域上写 `room` 把几个室内区域并成一个房间（缺省等于区域编号）。
 *  4. 听者必须此刻有效在场（在场租约没有失效、没有明确离开）且不在小游戏里。离线时保存着的位置不构成听见资格。
 *
 * 受众在发送的那个事务里按这一刻的位置固定：之后走近、进屋的人听不到这一句，走远的人也不会把已经听到的收回。
 */
import type { WorldService } from './service.js';
import { actorOf, ensureActor, posOf, type Pos } from './space.js';
import { distance, zoneAt } from './spatial/grid.js';
import type { ResidentRow } from './types.js';

/** 一个位置所在的声学房间。 */
export function roomOf(w: WorldService, p: Pick<Pos, 'scene' | 'x' | 'z'>): string {
  const scene = w.map.scenes.get(p.scene);
  if (!scene) return `${p.scene}:?`;
  const zone = zoneAt(scene, p.x, p.z);
  return zone.indoor ? `${p.scene}:${zone.room}` : `${p.scene}:outdoors`;
}

/** 两个位置之间，说话的能不能被听到（只管空间，不管在场和对局）。 */
type Spot = Pick<Pos, 'scene' | 'instance' | 'x' | 'z'>;
export function canHear(w: WorldService, speaker: Spot, listener: Spot): boolean {
  if (speaker.scene !== listener.scene || speaker.instance !== listener.instance) return false;
  if (distance(speaker, listener) > w.map.hearDistance) return false;
  return roomOf(w, speaker) === roomOf(w, listener);
}

/**
 * 一个居民此刻「有效在场」时的权威位置：在场（w.interactive：在场租约有效、不在小游戏里）且有位置，否则 null。
 * 听（nearbyAudience）和够得着（reach.ts）共用这一个定义；位置按折线和时间现算。
 */
export function interactivePos(w: WorldService, r: ResidentRow, now: number): Pos | null {
  if (!w.interactive(r)) return null;
  const actor = actorOf(w, r.resident_id);
  return actor ? posOf(actor, now) : null;
}

/**
 * 此刻说这句话的受众：包含说话的人自己。按权威位置现算，调用方在发送事务里使用。
 * 说话的人必须是有效在场的（命令管线已经检查过）；听者要在场、不在小游戏里。NPC（world_actors 里没有居民编号的行）不是听众。
 */
export function nearbyAudience(w: WorldService, speaker: ResidentRow, now: number): ResidentRow[] {
  const me = ensureActor(w, speaker, now);
  const here = posOf(me, now);
  const rows = w.db.all(
    `SELECT resident_id FROM world_actors WHERE world_id = ? AND scene_id = ? AND instance_id = ? AND kind = 'resident' AND resident_id IS NOT NULL ORDER BY resident_id`,
    w.worldId,
    here.scene,
    here.instance,
  );
  const out: ResidentRow[] = [];
  for (const row of rows) {
    const id = String(row.resident_id);
    if (id === speaker.resident_id) {
      out.push(speaker);
      continue;
    }
    const r = w.resident(id);
    if (!r) continue;
    const there = interactivePos(w, r, now);
    if (there && canHear(w, here, there)) out.push(r);
  }
  return out;
}

/**
 * NPC 开口时的受众：规则和居民说话完全一样（同实例、交谈距离内、同一个声学房间、有效在场、不在对局），只是说话人是 NPC。
 * NPC 自己不是听众：这里只列居民行。调用方在发送事务里使用，位置按 `at` 这一刻现算。
 */
export function npcAudience(w: WorldService, spot: Pick<Pos, 'scene' | 'instance' | 'x' | 'z'>, now: number): ResidentRow[] {
  const rows = w.db.all(
    `SELECT resident_id FROM world_actors WHERE world_id = ? AND scene_id = ? AND instance_id = ? AND kind = 'resident' AND resident_id IS NOT NULL ORDER BY resident_id`,
    w.worldId,
    spot.scene,
    spot.instance,
  );
  const out: ResidentRow[] = [];
  for (const row of rows) {
    const r = w.resident(String(row.resident_id));
    if (!r) continue;
    const there = interactivePos(w, r, now);
    if (there && canHear(w, spot, there)) out.push(r);
  }
  return out;
}
