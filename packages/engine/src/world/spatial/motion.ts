/** 运动：位置永远由 (折线, 速度, 起始时刻, 截止时刻, 现在) 现算，不存每帧坐标。时间是 UTC 毫秒。 */

import { cellAt, walkCells, zoneAt } from './grid.js';
import { pathLength } from './path.js';
import type { CompiledScene, Motion, MotionSample, Vec2, ZoneCrossing } from './types.js';

export function motionLength(m: Motion): number {
  return pathLength(m.points);
}

export function durationMs(m: Motion): number {
  const len = motionLength(m);
  if (len === 0) return 0;
  return Math.ceil((len / m.speed) * 1000);
}

export function arrivalAt(m: Motion): number {
  return m.startedAt + durationMs(m);
}

/** 朝向：0 = 朝北（-z），顺时针为正，范围 (-π, π] */
function headingOf(dx: number, dz: number): number {
  const h = Math.atan2(dx + 0, -dz);
  return h === -Math.PI ? Math.PI : h;
}

export function positionAt(m: Motion, now: number): MotionSample {
  const pts = m.points;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const length = motionLength(m);
  const arrive = m.startedAt + durationMs(m);
  const arrived = now >= arrive && (m.until === undefined || m.until >= arrive);
  const halted = !arrived && m.until !== undefined && now >= m.until;

  // 最后一段有长度的方向（沿用上一段）
  let lastHeading = 0;
  let firstHeading: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]!.x - pts[i - 1]!.x;
    const dz = pts[i]!.z - pts[i - 1]!.z;
    if (dx === 0 && dz === 0) continue;
    lastHeading = headingOf(dx, dz);
    firstHeading ??= lastHeading;
  }

  if (arrived) return { x: last.x, z: last.z, heading: lastHeading, travelled: length, arrived, halted };

  const hi = Math.min(m.until ?? Infinity, arrive);
  const t = Math.max(m.startedAt, Math.min(now, hi));
  const travelled = Math.min(length, ((t - m.startedAt) / 1000) * m.speed);
  if (travelled <= 0) {
    return { x: first.x, z: first.z, heading: firstHeading ?? 0, travelled: 0, arrived, halted };
  }
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    const seg = Math.hypot(q.x - p.x, q.z - p.z);
    if (seg === 0) continue;
    if (travelled < acc + seg) {
      const f = (travelled - acc) / seg;
      return {
        x: p.x + (q.x - p.x) * f,
        z: p.z + (q.z - p.z) * f,
        heading: headingOf(q.x - p.x, q.z - p.z),
        travelled,
        arrived,
        halted,
      };
    }
    acc += seg;
  }
  return { x: last.x, z: last.z, heading: lastHeading, travelled, arrived, halted };
}

/** 沿整条路径（忽略 until）每一次换区域；at 严格递增，且按 positionAt 采样与区域一致。 */
export function zoneCrossings(scene: CompiledScene, m: Motion): ZoneCrossing[] {
  const full: Motion = { points: m.points, speed: m.speed, startedAt: m.startedAt };
  const pts = m.points;
  const total = motionLength(full);
  if (pts.length < 2 || total === 0 || !(m.speed > 0)) return [];
  const arrive = arrivalAt(full);
  const zoneIdOf = (at: number): string => {
    const s = positionAt(full, at);
    return zoneAt(scene, s.x, s.z).id;
  };

  // 1. 几何候选：沿路径依次经过的格子 → 区域编号 → 去重 → 换算毫秒
  const cands: { at: number; zone: string }[] = [];
  let prevIdx = zoneIndex(scene, pts[0]!);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    const seg = Math.hypot(q.x - p.x, q.z - p.z);
    if (seg === 0) continue;
    walkCells(scene, p, q, (col, row, t, touch) => {
      if (touch || t === 0) return undefined;
      if (col < 0 || row < 0 || col >= scene.cols || row >= scene.rows) return undefined;
      const idx = scene.zoneOf[row * scene.cols + col] ?? 0;
      if (idx === prevIdx) return undefined;
      prevIdx = idx;
      const d = acc + t * seg;
      cands.push({ at: m.startedAt + Math.ceil((d / m.speed) * 1000), zone: scene.zones[idx]!.id });
      return undefined;
    });
    acc += seg;
  }

  // 2. 用采样校正：at 向后推到采样区域一致；与前一个采样区域对不上则丢弃
  const out: ZoneCrossing[] = [];
  let curZone = zoneIdOf(m.startedAt);
  let lastAt = m.startedAt;
  for (const c of cands) {
    let at = Math.min(Math.max(c.at, lastAt + 1), arrive);
    let tries = 0;
    while (at < arrive && zoneIdOf(at) !== c.zone && tries++ < 64) at++;
    if (zoneIdOf(at) !== c.zone) continue;
    // 浮点让它早了一毫秒以上时往回收
    while (at - 1 > lastAt && zoneIdOf(at - 1) === c.zone) at--;
    if (c.zone === curZone || at <= lastAt || zoneIdOf(at - 1) !== curZone) continue;
    const s = positionAt(full, at);
    out.push({ at, zone: c.zone, x: s.x, z: s.z });
    curZone = c.zone;
    lastAt = at;
  }
  return out;
}

function zoneIndex(scene: CompiledScene, p: Vec2): number {
  const c = cellAt(scene, p.x, p.z);
  return c ? (scene.zoneOf[c.row * scene.cols + c.col] ?? 0) : 0;
}
