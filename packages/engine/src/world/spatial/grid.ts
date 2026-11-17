/**
 * 网格查询：格子定位、可行走、区域、视线。纯函数。
 *
 * 约定：格子 (col,row) 覆盖 [originX + col*cell, originX + (col+1)*cell) × [originZ + row*cell, …)，
 * 恰好落在格线上的点属于编号更大的那一格；场景东、南边界上的点算在场景外。
 */

import type { CompiledScene, CompiledZone, Vec2 } from './types.js';

/** 沿线段经过的格子：t 是进入该格的线段参数（0..1）；touch = 只在一个格点上擦过，没有真正穿过 */
export type CellVisitor = (col: number, row: number, t: number, touch: boolean) => boolean | void;

export function cellAt(scene: CompiledScene, x: number, z: number): { col: number; row: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const col = Math.floor((x - scene.originX) / scene.cell);
  const row = Math.floor((z - scene.originZ) / scene.cell);
  if (col < 0 || row < 0 || col >= scene.cols || row >= scene.rows) return null;
  return { col, row };
}

export function cellCentre(scene: CompiledScene, col: number, row: number): Vec2 {
  return { x: scene.originX + (col + 0.5) * scene.cell, z: scene.originZ + (row + 0.5) * scene.cell };
}

/** 格子是否可行走；越界算不可走 */
export function cellWalkable(scene: CompiledScene, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= scene.cols || row >= scene.rows) return false;
  return scene.walkable[row * scene.cols + col] === 1;
}

export function isWalkable(scene: CompiledScene, x: number, z: number): boolean {
  const c = cellAt(scene, x, z);
  return c !== null && scene.walkable[c.row * scene.cols + c.col] === 1;
}

export function zoneAt(scene: CompiledScene, x: number, z: number): CompiledZone {
  const c = cellAt(scene, x, z);
  const idx = c ? (scene.zoneOf[c.row * scene.cols + c.col] ?? 0) : 0;
  return scene.zones[idx] ?? scene.zones[0]!;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 精确的网格遍历（Amanatides–Woo）。按顺序访问线段经过的格子；
 * 线段恰好穿过格点时，两个正交相邻格以 touch=true 访问（先于对角格），再走对角格。
 * visitor 返回 false 立即停止。不检查越界，由调用方处理。
 */
export function walkCells(scene: CompiledScene, a: Vec2, b: Vec2, visit: CellVisitor): void {
  const cell = scene.cell;
  const u0 = (a.x - scene.originX) / cell;
  const v0 = (a.z - scene.originZ) / cell;
  const u1 = (b.x - scene.originX) / cell;
  const v1 = (b.z - scene.originZ) / cell;
  if (![u0, v0, u1, v1].every(Number.isFinite)) return;
  const du = u1 - u0;
  const dv = v1 - v0;
  let col = Math.floor(u0);
  let row = Math.floor(v0);
  const endCol = Math.floor(u1);
  const endRow = Math.floor(v1);
  if (visit(col, row, 0, false) === false) return;
  const sx = du > 0 ? 1 : -1;
  const sz = dv > 0 ? 1 : -1;
  const len = Math.hypot(du, dv);
  const maxSteps = Math.abs(endCol - col) + Math.abs(endRow - row) + 2;
  for (let step = 0; step < maxSteps && (col !== endCol || row !== endRow); step++) {
    const tX = du === 0 ? Infinity : (du > 0 ? col + 1 - u0 : col - u0) / du;
    const tZ = dv === 0 ? Infinity : (dv > 0 ? row + 1 - v0 : row - v0) / dv;
    const t = Math.min(tX, tZ);
    if (!(t < Infinity)) return;
    const tt = Math.min(Math.max(t, 0), 1);
    const vertex = tX !== Infinity && tZ !== Infinity && Math.abs(tX - tZ) * len <= 1e-9;
    if (vertex) {
      if (visit(col + sx, row, tt, true) === false) return;
      if (visit(col, row + sz, tt, true) === false) return;
      col += sx;
      row += sz;
    } else if (tX < tZ) {
      col += sx;
    } else {
      row += sz;
    }
    if (visit(col, row, tt, false) === false) return;
  }
}

/** 两点之间的线段是否完全在可行走格子里；穿过格点时不许切角。对称。 */
export function lineOfSight(scene: CompiledScene, a: Vec2, b: Vec2): boolean {
  if (!isWalkable(scene, a.x, a.z) || !isWalkable(scene, b.x, b.z)) return false;
  // 统一方向，保证 a→b 与 b→a 走同一条遍历，结果逐位相同
  const swap = a.x > b.x || (a.x === b.x && a.z > b.z);
  const p = swap ? b : a;
  const q = swap ? a : b;
  let ok = true;
  walkCells(scene, p, q, (col, row) => {
    if (!cellWalkable(scene, col, row)) {
      ok = false;
      return false;
    }
    return undefined;
  });
  return ok;
}

/** p 本身可走就原样返回；否则取最近的可走格中心（平手取行小、再取列小），超出 maxDistance 返回 null。 */
export function nearestWalkable(scene: CompiledScene, p: Vec2, maxDistance: number): Vec2 | null {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !(maxDistance >= 0)) return null;
  if (isWalkable(scene, p.x, p.z)) return { x: p.x, z: p.z };
  const cell = scene.cell;
  const c0 = Math.max(0, Math.floor((p.x - maxDistance - scene.originX) / cell) - 1);
  const c1 = Math.min(scene.cols - 1, Math.ceil((p.x + maxDistance - scene.originX) / cell) + 1);
  const r0 = Math.max(0, Math.floor((p.z - maxDistance - scene.originZ) / cell) - 1);
  const r1 = Math.min(scene.rows - 1, Math.ceil((p.z + maxDistance - scene.originZ) / cell) + 1);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (scene.walkable[row * scene.cols + col] !== 1) continue;
      const c = cellCentre(scene, col, row);
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return best && bestD <= maxDistance ? best : null;
}
