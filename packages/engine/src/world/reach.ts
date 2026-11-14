/**
 * 人和人当面互动的够得着判定：只读，按权威位置现算距离。
 *
 * 「面对面」动作（询问爱好、当面邀请、报价与成交、当面还东西）共用它：
 * 同一个场景实例、双方都有效在场、都不在小游戏里、这一刻的距离不超过 personReach。
 * 不写 world_actors；位置只由 space.ts 写。判定里不出现区域标签：隔着区域边界但很近也算够得着。
 */
import { precondition } from './errors.js';
import type { WorldService } from './service.js';
import { interactivePos } from './hearing.js';
import { positionOfNpc } from './space.js';
import { distance } from './spatial/grid.js';
import type { ResidentRow } from './types.js';

export type PersonReach = { ok: true; distance: number } | { ok: false; why: 'not_here' | 'too_far' };

/** 距离容差：和物件的判定一致，免得毫秒取整把刚好够得着的人挡在外面。 */
const EPS = 0.01;

export function personReach(w: WorldService, a: ResidentRow, b: ResidentRow, now: number = w.now()): PersonReach {
  if (a.resident_id === b.resident_id) return { ok: false, why: 'not_here' };
  // 「有效在场、不在对局、现算位置」和附近聊天共用 hearing.ts 的 interactivePos
  const pa = interactivePos(w, a, now);
  const pb = interactivePos(w, b, now);
  if (!pa || !pb || pa.scene !== pb.scene || pa.instance !== pb.instance) return { ok: false, why: 'not_here' };
  const d = distance(pa, pb);
  return d <= w.params.personReach + EPS ? { ok: true, distance: d } : { ok: false, why: 'too_far' };
}

export function canInteractPerson(w: WorldService, a: ResidentRow, b: ResidentRow, now: number = w.now()): boolean {
  return personReach(w, a, b, now).ok;
}

/**
 * 够不着就抛错。同一实例但太远：too_far，带 navigateTo（对方的居民编号，可直接 navigate {approach}）；
 * 其余（不在同一实例、不在场、在小游戏里、没有这个人）：一律 not_here，不带任何位置信息，
 * 「在别人家里」「不在镇上」「在别处」从响应上分不出来。
 */
export function requirePersonReach(w: WorldService, a: ResidentRow, b: ResidentRow | undefined, now: number, notHereMessage = '对方不在你身边。'): ResidentRow {
  if (!b) throw precondition(notHereMessage, 'not_here');
  const res = personReach(w, a, b, now);
  if (res.ok) return b;
  if (res.why === 'too_far') throw precondition(`离${b.name}太远了，先走到ta身边。`, 'too_far', { navigateTo: b.resident_id });
  throw precondition(notHereMessage, 'not_here');
}

export type NpcReach = { ok: true; distance: number } | { ok: false; why: 'not_found' | 'not_here' | 'too_far' };

/**
 * 居民够不够得着一名 NPC：同一个公共场景实例、我有效在场且不在对局（interactivePos）、此刻距离不超过 personReach。
 * 双方的位置都按折线和时间现算（NPC 正在走时也是）。NPC 的位置是公开的，所以这里可以把「太远」和「不在这里」分开说。
 * not_found：没有这名 NPC。
 */
export function npcReach(w: WorldService, a: ResidentRow, npcId: string, now: number = w.now()): NpcReach {
  const pn = positionOfNpc(w, npcId, now);
  if (!pn) return { ok: false, why: 'not_found' };
  const pa = interactivePos(w, a, now);
  if (!pa || pa.scene !== pn.scene || pa.instance !== pn.instance) return { ok: false, why: 'not_here' };
  const d = distance(pa, pn);
  return d <= w.params.personReach + EPS ? { ok: true, distance: d } : { ok: false, why: 'too_far' };
}
