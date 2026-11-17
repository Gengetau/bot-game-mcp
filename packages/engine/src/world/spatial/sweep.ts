/**
 * 方向输入的短途直行：从 from 出发沿 dir 走最多 maxLen 米，撞到不可走的格子就停；
 * 斜着撞墙时沿墙贴边滑一小段（只取一个轴向，速度按分量折算，所以贴墙比自由行走慢）。纯函数、完全确定。
 */

import { isWalkable, walkCells } from './grid.js';
import type { CompiledScene, Vec2 } from './types.js';

/** 停在障碍边缘之前留的余量（米），保证停下的点还在可走格子里 */
const EDGE = 0.001;
/** 滑动方向的最小分量：再小的斜度不值得滑 */
const MIN_COMPONENT = 0.05;
/** 短于这个长度的位移当作没动（米） */
const MIN_STEP = 0.01;

/** 沿单位向量 d 从 p 直走 len 米，返回在撞到不可走格子（含擦角）之前能走多远。 */
function runStraight(scene: CompiledScene, p: Vec2, d: Vec2, len: number): number {
  if (!(len > 0)) return 0;
  const end = { x: p.x + d.x * len, z: p.z + d.z * len };
  let free = len;
  walkCells(scene, p, end, (col, row, t) => {
    if (col < 0 || row < 0 || col >= scene.cols || row >= scene.rows || scene.walkable[row * scene.cols + col] !== 1) {
      free = Math.max(0, t * len - EDGE);
      return false;
    }
    return undefined;
  });
  return free;
}

/**
 * 返回折线（第一个点是 from）。dir 必须是单位向量。起点不在可走格子里或一步也走不了，返回只有起点的折线。
 */
export function sweepDirection(scene: CompiledScene, from: Vec2, dir: Vec2, maxLen: number): Vec2[] {
  const out: Vec2[] = [{ x: from.x, z: from.z }];
  if (!isWalkable(scene, from.x, from.z) || !(maxLen > 0)) return out;
  const straight = runStraight(scene, from, dir, maxLen);
  let cur: Vec2 = { x: from.x + dir.x * straight, z: from.z + dir.z * straight };
  if (straight >= MIN_STEP) out.push(cur);
  else cur = out[0]!;
  const left = maxLen - straight;
  if (left < MIN_STEP) return out;

  // 被挡住了：在两个轴向里挑能多走一点的那个贴边滑动
  let best: { d: Vec2; len: number } | null = null;
  for (const [axis, comp] of [
    [{ x: Math.sign(dir.x), z: 0 }, Math.abs(dir.x)],
    [{ x: 0, z: Math.sign(dir.z) }, Math.abs(dir.z)],
  ] as [Vec2, number][]) {
    if (comp < MIN_COMPONENT) continue;
    const len = runStraight(scene, cur, axis, left * comp);
    if (len >= MIN_STEP && (!best || len > best.len)) best = { d: axis, len };
  }
  if (best) {
    const last = out[out.length - 1]!;
    out.push({ x: last.x + best.d.x * best.len, z: last.z + best.d.z * best.len });
  }
  return out;
}
