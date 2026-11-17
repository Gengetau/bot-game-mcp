/** 寻路：网格 A*（8 邻域，不切角）+ 视线拉直。纯函数、完全确定。 */

import { cellAt, cellCentre, cellWalkable, distance, lineOfSight } from './grid.js';
import type { CompiledScene, PathResult, Vec2 } from './types.js';

export function pathLength(points: Vec2[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distance(points[i - 1]!, points[i]!);
  return sum;
}

const SQRT2 = Math.SQRT2;

/** 二叉小根堆：按 (f, h, 格子下标) 排序，保证平手时结果确定 */
class Heap {
  private f: number[] = [];
  private h: number[] = [];
  private id: number[] = [];
  get size(): number {
    return this.id.length;
  }
  private less(i: number, j: number): boolean {
    if (this.f[i] !== this.f[j]) return this.f[i]! < this.f[j]!;
    if (this.h[i] !== this.h[j]) return this.h[i]! < this.h[j]!;
    return this.id[i]! < this.id[j]!;
  }
  private swap(i: number, j: number): void {
    [this.f[i], this.f[j]] = [this.f[j]!, this.f[i]!];
    [this.h[i], this.h[j]] = [this.h[j]!, this.h[i]!];
    [this.id[i], this.id[j]] = [this.id[j]!, this.id[i]!];
  }
  push(f: number, h: number, id: number): void {
    this.f.push(f);
    this.h.push(h);
    this.id.push(id);
    let i = this.id.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** 弹出最小项的格子下标 */
  pop(): number {
    const top = this.id[0]!;
    const last = this.id.length - 1;
    this.swap(0, last);
    this.f.pop();
    this.h.pop();
    this.id.pop();
    let i = 0;
    const n = this.id.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

export function findPath(
  scene: CompiledScene,
  from: Vec2,
  to: Vec2,
  opts: { maxExpansions?: number } = {},
): PathResult | null {
  // 每个格子至多展开一次，所以默认上限取格子数：永远不会把走得到的两点误判成走不到。
  // 单次寻路的开销由地图大小封顶（编译地图时限制了格子总数）；调用方想更省可以传更小的上限。
  const maxExpansions = opts.maxExpansions ?? scene.cols * scene.rows;
  const sc = cellAt(scene, from.x, from.z);
  const gc = cellAt(scene, to.x, to.z);
  if (!sc || !gc) return null;
  if (!cellWalkable(scene, sc.col, sc.row) || !cellWalkable(scene, gc.col, gc.row)) return null;
  const a: Vec2 = { x: from.x, z: from.z };
  const b: Vec2 = { x: to.x, z: to.z };
  if (lineOfSight(scene, a, b)) return { points: [a, b], length: distance(a, b) };

  const { cols, rows, cell } = scene;
  const n = cols * rows;
  const startIdx = sc.row * cols + sc.col;
  const goalIdx = gc.row * cols + gc.col;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const hOf = (idx: number): number => {
    const dx = Math.abs((idx % cols) - gc.col);
    const dz = Math.abs(Math.floor(idx / cols) - gc.row);
    return cell * (dx + dz) + (SQRT2 - 2) * cell * Math.min(dx, dz);
  };

  const heap = new Heap();
  g[startIdx] = 0;
  heap.push(hOf(startIdx), hOf(startIdx), startIdx);
  let expansions = 0;
  let found = false;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goalIdx) {
      found = true;
      break;
    }
    if (++expansions > maxExpansions) return null;
    const cc = cur % cols;
    const cr = (cur - cc) / cols;
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (!cellWalkable(scene, nc, nr)) continue;
      const diag = dc !== 0 && dr !== 0;
      if (diag && (!cellWalkable(scene, cc + dc, cr) || !cellWalkable(scene, cc, cr + dr))) continue;
      const ni = nr * cols + nc;
      if (closed[ni]) continue;
      const ng = g[cur]! + (diag ? cell * SQRT2 : cell);
      if (ng < g[ni]!) {
        g[ni] = ng;
        parent[ni] = cur;
        const h = hOf(ni);
        heap.push(ng + h, h, ni);
      }
    }
  }
  if (!found) return null;

  // 回溯格子中心，前后接上精确起终点，去掉相邻重复点
  const cells: number[] = [];
  for (let i = goalIdx; i !== -1; i = parent[i]!) cells.push(i);
  cells.reverse();
  const way: Vec2[] = [a];
  const push = (p: Vec2): void => {
    const last = way[way.length - 1]!;
    if (last.x !== p.x || last.z !== p.z) way.push(p);
  };
  for (const i of cells) push(cellCentre(scene, i % cols, Math.floor(i / cols)));
  push(b);
  // 终点必须是精确的 b（若最后一点恰与 b 相同，push 已跳过，值相等）

  // 贪心拉直：从当前点挑最远的、看得见的后续点
  const out: Vec2[] = [way[0]!];
  let cur = 0;
  const last = way.length - 1;
  while (cur < last) {
    let next = cur + 1;
    for (let j = last; j > cur + 1; j--) {
      if (lineOfSight(scene, way[cur]!, way[j]!)) {
        next = j;
        break;
      }
    }
    out.push(way[next]!);
    cur = next;
  }
  return { points: out, length: pathLength(out) };
}
