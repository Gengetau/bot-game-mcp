/** 地图编译：校验地图源，把它栅格化成可行走网格和区域网格。纯函数。 */

import { createHash } from 'node:crypto';
import { cellAt, cellWalkable, isWalkable } from './grid.js';
import type {
  AnchorSource,
  CompiledMap,
  CompiledScene,
  CompiledZone,
  InteractableSource,
  MapManifest,
  MapSource,
  PortalSource,
  Rect,
  SceneSource,
} from './types.js';

const EPS = 1e-6;
const MAX_GRID = 1024;
const MAX_ZONES = 35;
const ZONE_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 键递归排序、无空白的 JSON；数组保持顺序 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

function collectNonFinite(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} 不是有限数`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectNonFinite(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectNonFinite(v, `${path}.${k}`, out);
  }
}

function aligned(v: number, cell: number): boolean {
  return Math.abs(v - Math.round(v / cell) * cell) <= EPS;
}

function dupes(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/** 对 rect（外扩 pad）可能碰到的格子逐个回调；范围多取一圈，由回调做精确判断 */
function forCandidateCells(
  s: { originX: number; originZ: number; cell: number; cols: number; rows: number },
  r: Rect,
  pad: number,
  fn: (col: number, row: number) => void,
): void {
  const c0 = Math.max(0, Math.floor((r.x - pad - s.originX) / s.cell) - 1);
  const c1 = Math.min(s.cols - 1, Math.ceil((r.x + r.w + pad - s.originX) / s.cell) + 1);
  const r0 = Math.max(0, Math.floor((r.z - pad - s.originZ) / s.cell) - 1);
  const r1 = Math.min(s.rows - 1, Math.ceil((r.z + r.d + pad - s.originZ) / s.cell) + 1);
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) fn(col, row);
}

function contains(r: Rect, x: number, z: number): boolean {
  return x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d;
}

function rasterize(src: SceneSource, agentRadius: number): CompiledScene {
  const cell = src.cell;
  const cols = Math.round(src.bounds.w / cell);
  const rows = Math.round(src.bounds.d / cell);
  const originX = src.bounds.x;
  const originZ = src.bounds.z;
  const geo = { originX, originZ, cell, cols, rows };
  const walkable = new Uint8Array(cols * rows);
  for (const w of src.walk) {
    forCandidateCells(geo, w, 0, (col, row) => {
      if (contains(w, originX + (col + 0.5) * cell, originZ + (row + 0.5) * cell)) walkable[row * cols + col] = 1;
    });
  }
  // 单元格外扩 agentRadius 后与障碍正面积相交 ⇔ 单元格与外扩了 agentRadius 的障碍相交
  const block = (r: Rect): void => {
    const ex0 = r.x - agentRadius;
    const ex1 = r.x + r.w + agentRadius;
    const ez0 = r.z - agentRadius;
    const ez1 = r.z + r.d + agentRadius;
    forCandidateCells(geo, r, agentRadius, (col, row) => {
      const x0 = originX + col * cell;
      const z0 = originZ + row * cell;
      if (x0 < ex1 - 1e-9 && ex0 < x0 + cell - 1e-9 && z0 < ez1 - 1e-9 && ez0 < z0 + cell - 1e-9) {
        walkable[row * cols + col] = 0;
      }
    });
  };
  for (const o of src.obstacles) block(o);
  for (const it of src.interactables) if (it.footprint) block(it.footprint);

  const zones: CompiledZone[] = [
    { id: src.defaultZone.id, name: src.defaultZone.name, indoor: src.defaultZone.indoor, room: src.defaultZone.id },
    ...src.zones.map((z) => ({ id: z.id, name: z.name, indoor: z.indoor, room: z.room ?? z.id })),
  ];
  const zoneOf = new Uint8Array(cols * rows);
  src.zones.forEach((z, zi) => {
    for (const r of z.rects) {
      forCandidateCells(geo, r, 0, (col, row) => {
        const i = row * cols + col;
        if (zoneOf[i] === 0 && contains(r, originX + (col + 0.5) * cell, originZ + (row + 0.5) * cell)) {
          zoneOf[i] = zi + 1;
        }
      });
    }
  });
  // 「第一个包含该格中心的区域」：上面按区域顺序填，已填过的不覆盖，所以先到先得

  return {
    id: src.id,
    name: src.name,
    instanced: src.instanced,
    cell,
    originX,
    originZ,
    cols,
    rows,
    walkable,
    zoneOf,
    zones,
    anchors: new Map<string, AnchorSource>(src.anchors.map((a) => [a.id, a])),
    interactables: new Map<string, InteractableSource>(src.interactables.map((i) => [i.id, i])),
    portals: new Map<string, PortalSource>(src.portals.map((p) => [p.id, p])),
    source: src,
  };
}

/** 8 邻域连通分量（斜走要求两个正交邻格都可走），返回从 start 出发能到的格子 */
function reach(scene: CompiledScene, startCol: number, startRow: number): Uint8Array {
  const { cols } = scene;
  const seen = new Uint8Array(scene.cols * scene.rows);
  const stack = [startRow * cols + startCol];
  seen[stack[0]!] = 1;
  while (stack.length) {
    const cur = stack.pop()!;
    const c = cur % cols;
    const r = (cur - c) / cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;
        if (!cellWalkable(scene, c + dc, r + dr)) continue;
        if (dc !== 0 && dr !== 0 && (!cellWalkable(scene, c + dc, r) || !cellWalkable(scene, c, r + dr))) continue;
        const ni = (r + dr) * cols + c + dc;
        if (seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  return seen;
}

export function compileMap(source: MapSource): CompiledMap {
  const problems: string[] = [];
  collectNonFinite(source, '地图', problems);

  if (!(source.agentRadius >= 0)) problems.push('agentRadius 必须 >= 0');
  if (!(source.speed > 0)) problems.push('speed 必须 > 0');
  if (!(source.interactDistance > 0)) problems.push('interactDistance 必须 > 0');
  if (!(source.hearDistance > 0)) problems.push('hearDistance 必须 > 0');
  for (const id of dupes(source.scenes.map((s) => s.id))) problems.push(`场景编号重复：${id}`);

  const sceneById = new Map(source.scenes.map((s) => [s.id, s]));
  const rasterOk = new Set<string>();

  for (const s of source.scenes) {
    const p = (msg: string): number => problems.push(`场景 ${s.id}：${msg}`);
    let geoOk = true;
    if (!(s.cell > 0)) {
      p('cell 必须 > 0');
      geoOk = false;
    } else {
      const b = s.bounds;
      if (!(b.w > 0 && b.d > 0)) {
        p('bounds 尺寸必须为正');
        geoOk = false;
      }
      if (![b.x, b.z, b.w, b.d].every((v) => aligned(v, s.cell))) {
        p('bounds 未对齐网格（四个数都必须是 cell 的整数倍）');
        geoOk = false;
      }
      if (geoOk && (b.w / s.cell > MAX_GRID || b.d / s.cell > MAX_GRID)) {
        p(`网格超过 ${MAX_GRID}×${MAX_GRID}`);
        geoOk = false;
      }
      s.walk.forEach((w, i) => {
        if (!(w.w > 0 && w.d > 0)) {
          p(`walk[${i}] 尺寸必须为正`);
          geoOk = false;
        }
        if (![w.x, w.z, w.w, w.d].every((v) => aligned(v, s.cell))) {
          p(`walk[${i}] 未对齐网格`);
          geoOk = false;
        }
        if (
          w.x < b.x - EPS ||
          w.z < b.z - EPS ||
          w.x + w.w > b.x + b.w + EPS ||
          w.z + w.d > b.z + b.d + EPS
        ) {
          p(`walk[${i}] 超出 bounds`);
          geoOk = false;
        }
      });
    }
    if (!Number.isFinite(s.bounds.x + s.bounds.z + s.bounds.w + s.bounds.d)) geoOk = false;

    const zoneIds = s.zones.map((z) => z.id);
    for (const id of dupes(zoneIds)) p(`区域编号重复：${id}`);
    if (zoneIds.includes(s.defaultZone.id)) p(`区域编号与默认区域重复：${s.defaultZone.id}`);
    if (s.zones.length > MAX_ZONES) p(`区域超过 ${MAX_ZONES} 个（当前 ${s.zones.length}）`);
    for (const id of dupes(s.anchors.map((a) => a.id))) p(`锚点编号重复：${id}`);
    for (const id of dupes(s.interactables.map((i) => i.id))) p(`物件编号重复：${id}`);
    for (const id of dupes(s.portals.map((x) => x.id))) p(`出入口编号重复：${id}`);
    for (const it of s.interactables) {
      if (it.useAnchors.length < 1) p(`物件 ${it.id} 至少需要一个使用位`);
    }
    const anchorIds = new Set(s.anchors.map((a) => a.id));
    for (const pt of s.portals) {
      if (!anchorIds.has(pt.anchor)) p(`出入口 ${pt.id} 的锚点 ${pt.anchor} 不存在`);
      const target = sceneById.get(pt.toScene);
      if (!target) p(`出入口 ${pt.id} 的目标场景 ${pt.toScene} 不存在`);
      else if (!target.anchors.some((a) => a.id === pt.toAnchor)) {
        p(`出入口 ${pt.id} 的目标锚点 ${pt.toScene}/${pt.toAnchor} 不存在`);
      }
    }
    if (geoOk) rasterOk.add(s.id);
  }

  for (const [name, ref] of Object.entries(source.aliases)) {
    const t = sceneById.get(ref.scene);
    if (!t) problems.push(`别名 ${name} 的场景 ${ref.scene} 不存在`);
    else if (!t.anchors.some((a) => a.id === ref.anchor)) {
      problems.push(`别名 ${name} 的锚点 ${ref.scene}/${ref.anchor} 不存在`);
    }
  }
  {
    const t = sceneById.get(source.spawn.scene);
    if (!t) problems.push(`出生点的场景 ${source.spawn.scene} 不存在`);
    else if (!t.anchors.some((a) => a.id === source.spawn.anchor)) {
      problems.push(`出生点的锚点 ${source.spawn.scene}/${source.spawn.anchor} 不存在`);
    }
  }

  // 栅格化之后才能查的：锚点落点、物件使用位、连通性
  const scenes = new Map<string, CompiledScene>();
  for (const s of source.scenes) {
    if (!rasterOk.has(s.id) || scenes.has(s.id)) continue;
    const cs = rasterize(s, source.agentRadius);
    scenes.set(s.id, cs);
    const p = (msg: string): number => problems.push(`场景 ${s.id}：${msg}`);
    const okAnchors = new Set<AnchorSource>();
    for (const a of s.anchors) {
      if (isWalkable(cs, a.x, a.z)) okAnchors.add(a);
      else p(`锚点 ${a.id} 不在可行走格子上`);
    }
    const okUse: [string, number, { x: number; z: number }][] = [];
    for (const it of s.interactables) {
      it.useAnchors.forEach((u, i) => {
        if (isWalkable(cs, u.x, u.z)) okUse.push([it.id, i, u]);
        else p(`物件 ${it.id} 的使用位 #${i} 不在可行走格子上`);
      });
    }
    const first = s.anchors[0];
    const fc = first && isWalkable(cs, first.x, first.z) ? cellAt(cs, first.x, first.z) : null;
    if (fc) {
      const seen = reach(cs, fc.col, fc.row);
      const inComp = (x: number, z: number): boolean => {
        const c = cellAt(cs, x, z)!;
        return seen[c.row * cs.cols + c.col] === 1;
      };
      for (const a of s.anchors) {
        if (okAnchors.has(a) && !inComp(a.x, a.z)) p(`锚点 ${a.id} 与 ${first!.id} 不连通`);
      }
      for (const [id, i, u] of okUse) {
        if (!inComp(u.x, u.z)) p(`物件 ${id} 的使用位 #${i} 与 ${first!.id} 不连通`);
      }
    }
  }

  if (problems.length) throw new Error(`地图 ${source.mapVersion} 无效：` + problems.join('；'));

  return {
    mapVersion: source.mapVersion,
    checksum: createHash('sha256').update(canonicalJson(source)).digest('hex'),
    agentRadius: source.agentRadius,
    speed: source.speed,
    interactDistance: source.interactDistance,
    hearDistance: source.hearDistance,
    scenes,
    aliases: source.aliases,
    spawn: source.spawn,
    source,
  };
}

export function manifestOf(map: CompiledMap): MapManifest {
  const grids: MapManifest['grids'] = {};
  for (const [id, s] of map.scenes) {
    const rows_ascii: string[] = [];
    const zones_ascii: string[] = [];
    for (let r = 0; r < s.rows; r++) {
      let a = '';
      let z = '';
      for (let c = 0; c < s.cols; c++) {
        a += s.walkable[r * s.cols + c] === 1 ? '.' : '#';
        z += ZONE_CHARS[s.zoneOf[r * s.cols + c]!] ?? '0';
      }
      rows_ascii.push(a);
      zones_ascii.push(z);
    }
    grids[id] = { cols: s.cols, rows: s.rows, rows_ascii, zones_ascii, zones: s.zones };
  }
  return {
    protocol: 1,
    mapVersion: map.mapVersion,
    checksum: map.checksum,
    source: map.source,
    grids,
  };
}

/** 调试用：一行一格行；# 不可走，可走格用区域下标字符，marks 覆盖 */
export function renderAscii(scene: CompiledScene, marks: { x: number; z: number; ch: string }[] = []): string {
  const lines: string[][] = [];
  for (let r = 0; r < scene.rows; r++) {
    const line: string[] = [];
    for (let c = 0; c < scene.cols; c++) {
      line.push(scene.walkable[r * scene.cols + c] === 1 ? (ZONE_CHARS[scene.zoneOf[r * scene.cols + c]!] ?? '0') : '#');
    }
    lines.push(line);
  }
  for (const m of marks) {
    const c = cellAt(scene, m.x, m.z);
    if (c) lines[c.row]![c.col] = m.ch.slice(0, 1) || '?';
  }
  return lines.map((l) => l.join('')).join('\n');
}
