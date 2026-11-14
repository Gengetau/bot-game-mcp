/**
 * 出生落脚点的候选序列：纯函数（不读库、不取时间、不用随机数）。
 *
 * 新居民第一次进入时落在出生锚点；几个人先后进来又都没走动，不能叠在同一个坐标上。
 * 候选点是放人时的算法，不是地图数据：不进 GET /map，不影响 mapVersion。
 * 顺序固定：中心；然后第 k 圈（k = 1, 2, …）半径 k * ringStep、均匀 6k 个点，从 +x 方向起按角度递增。
 * 只留下可走、与中心在同一个区域、并且从中心看得见（不隔墙）的点。
 */
import { isWalkable, lineOfSight, zoneAt } from './grid.js';
import type { CompiledScene, Vec2 } from './types.js';

export interface SpawnOptions {
  /** 相邻两圈的半径差（米）。默认 1.0。 */
  ringStep?: number;
  /** 圈数（不含中心）。默认 5，共 1 + 6 + 12 + 18 + 24 + 30 = 91 个候选。 */
  rings?: number;
}

/** 不考虑地图时的理想候选点（中心在前，按圈、按角度）。 */
export function spawnRingPoints(centre: Vec2, opts: SpawnOptions = {}): Vec2[] {
  const step = opts.ringStep ?? 1;
  const rings = opts.rings ?? 5;
  const out: Vec2[] = [{ x: centre.x, z: centre.z }];
  for (let k = 1; k <= rings; k++) {
    const n = 6 * k;
    for (let i = 0; i < n; i++) {
      const ang = (2 * Math.PI * i) / n;
      out.push({ x: centre.x + k * step * Math.cos(ang), z: centre.z + k * step * Math.sin(ang) });
    }
  }
  return out;
}

/** 在场景里站得住的候选点：中心一定在第一个（调用方保证锚点合法）。 */
export function spawnCandidates(scene: CompiledScene, centre: Vec2, opts: SpawnOptions = {}): Vec2[] {
  const zone = zoneAt(scene, centre.x, centre.z).id;
  const all = spawnRingPoints(centre, opts);
  const out: Vec2[] = [all[0]!];
  for (let i = 1; i < all.length; i++) {
    const p = all[i]!;
    if (!isWalkable(scene, p.x, p.z)) continue;
    if (zoneAt(scene, p.x, p.z).id !== zone) continue;
    if (!lineOfSight(scene, centre, p)) continue;
    out.push(p);
  }
  return out;
}

/** 第一个离所有已占位置都不小于 clearance 的候选；都占了退回中心（候选第一个）。 */
export function pickSpawn(candidates: readonly Vec2[], occupied: readonly Vec2[], clearance: number): Vec2 {
  for (const c of candidates) {
    if (occupied.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= clearance)) return c;
  }
  return candidates[0]!;
}
