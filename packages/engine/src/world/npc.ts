/**
 * NPC 的日程（栖灯镇的程序角色）。N1a：只让 NPC 作为世界里的角色存在，并按日程在锚点之间走动、停留。
 *
 * - NPC 是 world_actors 里 kind='npc'、resident_id 为空的行（content.ts 的 NPCS 定义），不借用 residents，不占在场名额。
 * - 位置只由 space.ts 写；这里只决定「去哪一站、停多久」，然后调 space.ts 的 placeNpc / navigateNpc。
 * - 走动、停留、换姿态不发任何事件、不叫醒任何 AI、不记任何事实。别人只通过场景快照的 npcs 看到它（space.ts 在位置或姿态变化时通知）。
 * - 日程任务 npc_step：每名会走动的 NPC 同一时刻至多一条待办（去重键 npcJobKey）。时间用 w.now()，随机见 npcRng（生产环境就是 w.rng）。
 *   停机恢复按 due_at 追赶，但一次只处理一步，直接落到合法状态（在某个锚点上，或一条新路线的起点），不把错过的每一步重放一遍。
 * - 处理过程同步、不抛错：寻路失败就原地停留，稍后再试。
 */
import { SeededRng, type Rng } from '../core/rng.js';
import { NPCS, npcDef, type NpcDef, type NpcStop } from './content.js';
import type { WorldService } from './service.js';
import { anchorSpot, navigateNpc, npcActorOf, npcJobKey, npcStateOf, placeNpc, seedNpc, setNpcState } from './space.js';

type Payload = { npcId: string; phase: 'stay' | 'walk'; navigationId?: string; revision?: number };

/**
 * NPC 的随机源。生产环境（没有种子）就是 w.rng；带种子的模拟 / 测试里，每个决定从「种子 + NPC + 导航版本 + 用途」派生一个小随机流：
 * 可复现、重启后同一个决定得到同一个结果，而且 NPC 的走动不会消耗 w.rng——居民和小游戏的随机序列不因 NPC 是否走了一步而改变。
 */
function npcRng(w: WorldService, def: NpcDef, purpose: string): Rng {
  if (w.seed === null) return w.rng;
  const revision = npcActorOf(w, def.id)?.nav_revision ?? 0;
  return new SeededRng(`${w.seed}:${w.worldId}:npc:${def.id}:${revision}:${purpose}`);
}

/** 这次停留多久：在参数给定的范围里选。 */
function stayMs(w: WorldService, def: NpcDef): number {
  const lo = w.params.npcStayMinMs;
  const hi = Math.max(lo, w.params.npcStayMaxMs);
  return lo + npcRng(w, def, 'stay').int(hi - lo + 1);
}

const stopOf = (def: NpcDef, anchor: string): NpcStop => def.schedule?.stops.find((s) => s.anchor === anchor) ?? def.post;

function armStay(w: WorldService, def: NpcDef, dueAt: number): void {
  w.reschedule('npc_step', npcJobKey(def.id), dueAt, { npcId: def.id, phase: 'stay' } satisfies Payload);
}

/** 到站：精确放在锚点上（朝向用锚点的 facing），摆好姿态，开始一次停留。 */
function arrive(w: WorldService, def: NpcDef, stop: NpcStop, now: number): void {
  placeNpc(w, def.id, anchorSpot(w, stop.anchor), now);
  setNpcState(w, def.id, stop.pose, stop.anchor);
  armStay(w, def, now + stayMs(w, def));
}

/** 选下一站并出发。没有路就原地停留，稍后再试。 */
function startWalk(w: WorldService, def: NpcDef, now: number): void {
  const stops = def.schedule?.stops ?? [];
  const here = npcStateOf(w, def.id)?.stopAnchor;
  const others = stops.filter((s) => s.anchor !== here);
  const pool = others.length > 0 ? others : stops;
  if (pool.length === 0) return;
  const next = pool[npcRng(w, def, `next:${now}`).int(pool.length)]!;
  const res = navigateNpc(w, def.id, anchorSpot(w, next.anchor), now, { kind: 'point', name: next.anchor });
  if (!res) {
    armStay(w, def, now + w.params.npcRetryMs);
    return;
  }
  if (res.navigationId === '') {
    arrive(w, def, next, now);
    return;
  }
  setNpcState(w, def.id, 'stand', next.anchor);
  w.reschedule('npc_step', npcJobKey(def.id), res.arriveAt, { npcId: def.id, phase: 'walk', navigationId: res.navigationId, revision: res.revision } satisfies Payload);
}

/** 按 NPC 此刻的状态重新安排它的下一次任务（不管有没有待办）。 */
function rearm(w: WorldService, def: NpcDef, now: number): void {
  const a = npcActorOf(w, def.id);
  if (!a) return;
  if (a.nav) {
    w.reschedule('npc_step', npcJobKey(def.id), a.nav.leaseUntil, { npcId: def.id, phase: 'walk', navigationId: a.nav.navigationId, revision: a.nav.revision } satisfies Payload);
  } else {
    armStay(w, def, now + stayMs(w, def));
  }
}

/** 保证：种下所有 NPC 的行；会走动的 NPC 恰好有一条待办，不走动的没有。幂等。 */
function sync(w: WorldService, now: number): void {
  for (const def of NPCS) {
    seedNpc(w, def, now);
    if (!def.schedule) {
      w.cancelJob(npcJobKey(def.id));
      continue;
    }
    if (!w.db.get("SELECT 1 AS x FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", npcJobKey(def.id))) rearm(w, def, now);
  }
}

export function installNpc(w: WorldService): void {
  w.commit(() => sync(w, w.now()));
  // 启动恢复（在 space.ts 的地图校正之后）：补行、补任务。过期的任务随后由追赶循环各处理一次
  w.hooks.recover.push((_downtime, now) => sync(w, now));

  w.jobHandlers.set('npc_step', (payload, _job, now) => {
    const def = npcDef(String(payload.npcId));
    if (!def?.schedule) return;
    const a = npcActorOf(w, def.id);
    const st = npcStateOf(w, def.id);
    if (!a || !st) return;
    if (a.nav) {
      // 必须对上导航编号和版本：对不上的是旧任务，不能结算别人的路线（按现在这条重新安排）
      if (payload.phase !== 'walk' || a.nav.navigationId !== payload.navigationId || a.nav.revision !== payload.revision) {
        rearm(w, def, now);
        return;
      }
      if (a.nav.leaseUntil > now) {
        w.reschedule('npc_step', npcJobKey(def.id), a.nav.leaseUntil, payload);
        return;
      }
      arrive(w, def, stopOf(def, st.stopAnchor), now);
      return;
    }
    // 停留结束，或者路线已经作废（换了地图版本）：从现在的位置出发去下一站
    startWalk(w, def, now);
  });
}
