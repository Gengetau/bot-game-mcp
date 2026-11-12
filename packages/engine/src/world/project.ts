/**
 * 投影用的小工具：公开层面能说到哪一步。
 *
 * 公开投影只表达到「住宅区」这一层：进了谁家、屋里有几个人，都不出现在公开数据里。公开层面只有区域，没有坐标。
 * 所有出口（HTTP、MCP、SSE、日报）都从这里取公开位置，不各写一套。
 */
import { isHome, placeDef } from './content.js';
import type { ResidentRow } from './types.js';

export const RESIDENTIAL = 'residential';

/** 空间在公开层面属于哪个区域：公共地点和路上是它自己，会馆门前和所有住宅内部统一是「住宅区」。 */
export function zoneOf(spaceId: string): string {
  if (isHome(spaceId)) return RESIDENTIAL;
  const def = placeDef(spaceId);
  return def && def.kind === 'public' ? def.id : RESIDENTIAL;
}

export interface PublicSpot {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  /** 公共区域编号（地点、'road' 路上）、'residential'，或 null（不在场）。坐标不在公开层面出现 */
  at: string | null;
  /** 正在公共场所的一局小游戏里 */
  playing?: boolean;
}

/** 一位居民的公开位置。不在场的居民没有位置（at=null）。 */
export function publicSpot(r: ResidentRow): PublicSpot {
  const base = { id: r.resident_id, name: r.name, kind: r.kind };
  if (r.present_since === null) return { ...base, at: null };
  return { ...base, at: zoneOf(r.location_id), ...(r.activity_id ? { playing: true } : {}) };
}

/** 给同一空间里的人看的名片（公开资料）。 */
export function card(r: ResidentRow): { id: string; name: string; kind: 'human' | 'agent' } {
  return { id: r.resident_id, name: r.name, kind: r.kind };
}
