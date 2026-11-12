/**
 * 投影用的小工具：公开层面能说到哪一步。
 *
 * 公开投影只表达到「住宅区」这一层：在哪条巷子、进了谁家、屋里有几个人，都不出现在公开数据里。
 * 所有出口（HTTP、MCP、SSE、日报）都从这里取公开位置，不各写一套。
 */
import { isHome, placeDef } from './content.js';
import type { ResidentRow } from './types.js';

export const RESIDENTIAL = 'residential';

/** 空间在公开层面属于哪个区域：公共地点是它自己，住宅街和所有住宅内部统一是「住宅区」。 */
export function zoneOf(spaceId: string): string {
  if (isHome(spaceId)) return RESIDENTIAL;
  const def = placeDef(spaceId);
  return def && def.kind === 'public' ? def.id : RESIDENTIAL;
}

export interface PublicSpot {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  /** 公共地点编号、'residential'，或 null（不在场） */
  at: string | null;
  /** 在两个公共地点之间移动时才有；住宅区内部的走动、进出住宅区的路程都不出现 */
  moving?: { from: string; to: string; path: string[]; startedAt: number; arriveAt: number };
  /** 正在公共场所的一局小游戏里 */
  playing?: boolean;
}

/** 一位居民的公开位置。不在场的居民没有位置（at=null）。 */
export function publicSpot(r: ResidentRow): PublicSpot {
  const base = { id: r.resident_id, name: r.name, kind: r.kind };
  if (r.present_since === null) return { ...base, at: null };
  if (r.move) {
    const from = zoneOf(r.move.from);
    const to = zoneOf(r.move.to);
    if (from === to) return { ...base, at: from };
    // 进出住宅区的路上，公开层面一直算「在住宅区」：路程长短会暴露是哪条巷子、进没进门，
    // 所以不给出发和到达时间。出发去住宅区的那一刻就算到了；从住宅区出来的，到了目的地才现身。
    if (from === RESIDENTIAL || to === RESIDENTIAL) return { ...base, at: RESIDENTIAL };
    const path: string[] = [];
    for (const node of r.move.path) {
      const z = zoneOf(node);
      if (path[path.length - 1] !== z) path.push(z);
    }
    return { ...base, at: null, moving: { from, to, path, startedAt: r.move.startedAt, arriveAt: r.move.arriveAt } };
  }
  return { ...base, at: zoneOf(r.location_id), ...(r.activity_id ? { playing: true } : {}) };
}

/** 给同一空间里的人看的名片（公开资料）。 */
export function card(r: ResidentRow): { id: string; name: string; kind: 'human' | 'agent' } {
  return { id: r.resident_id, name: r.name, kind: r.kind };
}
