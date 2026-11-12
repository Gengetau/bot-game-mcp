import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  cellAt,
  cellCentre,
  compileMap,
  distance,
  isWalkable,
  lineOfSight,
  manifestOf,
  nearestWalkable,
  renderAscii,
  zoneAt,
  type CompiledScene,
  type MapSource,
  type SceneSource,
} from '../../src/world/spatial/index.js';

function sceneSrc(over: Partial<SceneSource> = {}): SceneSource {
  return {
    id: 's',
    name: '场景',
    instanced: false,
    cell: 0.5,
    bounds: { x: 0, z: 0, w: 10, d: 10 },
    walk: [{ x: 0, z: 0, w: 10, d: 10 }],
    obstacles: [],
    zones: [],
    defaultZone: { id: 'street', name: '街上', indoor: false },
    anchors: [{ id: 'a', x: 1.25, z: 1.25 }],
    interactables: [],
    portals: [],
    ...over,
  };
}

function mapSrc(scene: SceneSource | SceneSource[] = sceneSrc(), over: Partial<MapSource> = {}): MapSource {
  const scenes = Array.isArray(scene) ? scene : [scene];
  return {
    mapVersion: 'test-1',
    agentRadius: 0,
    speed: 1.4,
    interactDistance: 1.5,
    hearDistance: 8,
    scenes,
    aliases: {},
    spawn: { scene: scenes[0]!.id, anchor: scenes[0]!.anchors[0]?.id ?? 'a' },
    ...over,
  };
}

function compileScene(s: SceneSource, over: Partial<MapSource> = {}): CompiledScene {
  return compileMap(mapSrc(s, over)).scenes.get(s.id)!;
}

function msg(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('compileMap 校验', () => {
  it('所有问题一次报完，带地图版本前缀', () => {
    const m = msg(() =>
      compileMap(
        mapSrc(sceneSrc({ anchors: [{ id: 'a', x: 1.25, z: 1.25 }, { id: 'a', x: 99, z: 1 }] }), {
          speed: 0,
          aliases: { x: { scene: 's', anchor: 'nope' } },
        }),
      ),
    );
    expect(m.startsWith('地图 test-1 无效：')).toBe(true);
    expect(m).toContain('speed 必须 > 0');
    expect(m).toContain('锚点编号重复：a');
    expect(m).toContain('别名 x');
    expect(m).toContain('不在可行走格子上');
  });

  it('bounds 未对齐', () => {
    expect(msg(() => compileMap(mapSrc(sceneSrc({ bounds: { x: 0, z: 0, w: 10.2, d: 10 } }))))).toContain('bounds 未对齐网格');
  });

  it('walk 未对齐或超出 bounds', () => {
    expect(msg(() => compileMap(mapSrc(sceneSrc({ walk: [{ x: 0.1, z: 0, w: 5, d: 5 }] }))))).toContain('walk[0] 未对齐网格');
    expect(msg(() => compileMap(mapSrc(sceneSrc({ walk: [{ x: 0, z: 0, w: 11, d: 5 }] }))))).toContain('walk[0] 超出 bounds');
  });

  it('锚点在墙里', () => {
    const s = sceneSrc({
      obstacles: [{ kind: 'wall', x: 4, z: 0, w: 1, d: 10 }],
      anchors: [{ id: 'a', x: 1.25, z: 1.25 }, { id: 'inwall', x: 4.25, z: 2.25 }],
    });
    expect(msg(() => compileMap(mapSrc(s)))).toContain('锚点 inwall 不在可行走格子上');
  });

  it('锚点不连通（按编号报告）', () => {
    const s = sceneSrc({
      obstacles: [{ kind: 'wall', x: 4, z: 0, w: 1, d: 10 }],
      anchors: [{ id: 'a', x: 1.25, z: 1.25 }, { id: 'island', x: 7.25, z: 2.25 }],
    });
    expect(msg(() => compileMap(mapSrc(s)))).toContain('锚点 island 与 a 不连通');
  });

  it('物件使用位不连通 / 为空', () => {
    const wall = { kind: 'wall' as const, x: 4, z: 0, w: 1, d: 10 };
    const it = (useAnchors: { x: number; z: number }[]) => ({ id: 'bench', kind: 'seat', name: '长椅', x: 7, z: 2, useAnchors });
    expect(msg(() => compileMap(mapSrc(sceneSrc({ obstacles: [wall], interactables: [it([{ x: 7.25, z: 2.25 }])] }))))).toContain(
      '物件 bench 的使用位 #0 与 a 不连通',
    );
    expect(msg(() => compileMap(mapSrc(sceneSrc({ interactables: [it([])] }))))).toContain('物件 bench 至少需要一个使用位');
  });

  it('对角两格被堵时不算连通', () => {
    // 只靠一个对角缝隙连着的两块地：不允许切角
    const s = sceneSrc({
      bounds: { x: 0, z: 0, w: 2, d: 2 },
      walk: [{ x: 0, z: 0, w: 2, d: 2 }],
      cell: 1,
      obstacles: [
        { kind: 'wall', x: 1, z: 0, w: 1, d: 1 },
        { kind: 'wall', x: 0, z: 1, w: 1, d: 1 },
      ],
      anchors: [{ id: 'a', x: 0.5, z: 0.5 }, { id: 'b', x: 1.5, z: 1.5 }],
    });
    expect(msg(() => compileMap(mapSrc(s)))).toContain('锚点 b 与 a 不连通');
  });

  it('别名、出生点、出入口引用不存在的东西', () => {
    const m = msg(() =>
      compileMap(
        mapSrc(sceneSrc({ portals: [{ id: 'p', anchor: 'zz', toScene: 'nope', toAnchor: 'q' }] }), {
          aliases: { bad: { scene: 'nope', anchor: 'a' } },
          spawn: { scene: 's', anchor: 'missing' },
        }),
      ),
    );
    expect(m).toContain('别名 bad 的场景 nope 不存在');
    expect(m).toContain('出生点的锚点 s/missing 不存在');
    expect(m).toContain('出入口 p 的锚点 zz 不存在');
    expect(m).toContain('出入口 p 的目标场景 nope 不存在');
  });

  it('区域太多 / 区域编号重复 / 与默认区域重复', () => {
    const zones = Array.from({ length: 36 }, (_, i) => ({
      id: `z${i}`,
      name: `z${i}`,
      indoor: false,
      rects: [{ x: 0, z: 0, w: 1, d: 1 }],
    }));
    expect(msg(() => compileMap(mapSrc(sceneSrc({ zones }))))).toContain('区域超过 35 个');
    const z = { id: 'x', name: 'x', indoor: false, rects: [] };
    expect(msg(() => compileMap(mapSrc(sceneSrc({ zones: [z, z] }))))).toContain('区域编号重复：x');
    expect(msg(() => compileMap(mapSrc(sceneSrc({ zones: [{ ...z, id: 'street' }] }))))).toContain('区域编号与默认区域重复');
  });

  it('非有限数、网格过大、场景编号重复', () => {
    expect(msg(() => compileMap(mapSrc(sceneSrc(), { hearDistance: NaN })))).toContain('不是有限数');
    expect(
      msg(() => compileMap(mapSrc(sceneSrc({ cell: 1, bounds: { x: 0, z: 0, w: 2000, d: 10 }, walk: [{ x: 0, z: 0, w: 5, d: 5 }] })))),
    ).toContain('网格超过 1024×1024');
    expect(msg(() => compileMap(mapSrc([sceneSrc(), sceneSrc()])))).toContain('场景编号重复：s');
  });
});

describe('栅格化', () => {
  it('障碍按 agentRadius 外扩：1 米走廊在半径 0.3 时被封死', () => {
    const s = sceneSrc({
      bounds: { x: 0, z: 0, w: 5, d: 4 },
      walk: [{ x: 0, z: 0, w: 5, d: 4 }],
      obstacles: [
        { kind: 'wall', x: 0, z: 0, w: 5, d: 1.5 },
        { kind: 'wall', x: 0, z: 2.5, w: 5, d: 1.5 },
      ],
      anchors: [{ id: 'a', x: 0.25, z: 1.75 }],
    });
    // 走廊内 1 米宽、半径 0.3：任何格子外扩后都碰墙
    const closed = (): void => {
      compileMap(mapSrc(s, { agentRadius: 0.3 }));
    };
    expect(msg(closed)).toContain('锚点 a 不在可行走格子上');
    // 半径 0 时走廊两行（z 1.5–2.5）可走
    const sc = compileScene(s, { agentRadius: 0 });
    for (let c = 0; c < sc.cols; c++) {
      expect([2, 3, 4, 5].map((r) => sc.walkable[r * sc.cols + c])).toEqual([0, 1, 1, 0]);
    }
  });

  it('1.6 米走廊半径 0.3：留下正确的格子，贴边不算相交', () => {
    const s = sceneSrc({
      bounds: { x: 0, z: 0, w: 5, d: 4 },
      walk: [{ x: 0, z: 0, w: 5, d: 4 }],
      obstacles: [
        { kind: 'wall', x: 0, z: 0, w: 5, d: 1.2 },
        { kind: 'wall', x: 0, z: 2.8, w: 5, d: 1.2 },
      ],
      anchors: [{ id: 'a', x: 0.25, z: 1.75 }],
    });
    const sc = compileScene(s, { agentRadius: 0.3 });
    // 外扩后墙边在 1.5 / 2.5；行 3、4（z 1.5–2.5）刚好贴边，保留
    const col = (r: number) => sc.walkable[r * sc.cols + 4];
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(col)).toEqual([0, 0, 0, 1, 1, 0, 0, 0]);
  });

  it('物件 footprint 也挡路；只有 walk 范围内的格子可走', () => {
    const sc = compileScene(
      sceneSrc({
        walk: [{ x: 0, z: 0, w: 5, d: 10 }],
        interactables: [
          { id: 't', kind: 'table', name: '桌', x: 2.5, z: 2.5, footprint: { x: 2, z: 2, w: 1, d: 1 }, useAnchors: [{ x: 1.25, z: 2.25 }] },
        ],
      }),
    );
    expect(isWalkable(sc, 2.25, 2.25)).toBe(false);
    expect(isWalkable(sc, 1.25, 2.25)).toBe(true);
    expect(isWalkable(sc, 7.25, 2.25)).toBe(false);
  });

  it('区域：先到先得，半开区间，不可走格子也有区域', () => {
    const sc = compileScene(
      sceneSrc({
        zones: [
          { id: 'A', name: 'A', indoor: true, rects: [{ x: 0, z: 0, w: 4, d: 4 }] },
          { id: 'B', name: 'B', indoor: true, room: 'shared', rects: [{ x: 2, z: 0, w: 4, d: 4 }] },
        ],
        obstacles: [{ kind: 'wall', x: 0, z: 0, w: 1, d: 1 }],
      }),
    );
    expect(zoneAt(sc, 3.75, 1).id).toBe('A');
    expect(zoneAt(sc, 4.25, 1).id).toBe('B');
    expect(zoneAt(sc, 4.25, 1).room).toBe('shared');
    expect(zoneAt(sc, 0.25, 0.25).id).toBe('A'); // 墙里
    expect(zoneAt(sc, 8, 8).id).toBe('street');
    expect(zoneAt(sc, -5, 8).id).toBe('street');
    expect(sc.zones[0]!.room).toBe('street');
  });
});

describe('checksum 与清单', () => {
  it('键顺序不影响，任何值变化都会改变', () => {
    const a = mapSrc();
    const reordered = JSON.parse(JSON.stringify(a), (_k, v) =>
      v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
    ) as MapSource;
    expect(canonicalJson(a)).toBe(canonicalJson(reordered));
    expect(compileMap(a).checksum).toBe(compileMap(reordered).checksum);
    expect(compileMap(a).checksum).toMatch(/^[0-9a-f]{64}$/);
    const b = mapSrc(sceneSrc({ anchors: [{ id: 'a', x: 1.25, z: 1.75 }] }));
    expect(compileMap(b).checksum).not.toBe(compileMap(a).checksum);
    expect(compileMap(mapSrc(sceneSrc(), { speed: 1.5 })).checksum).not.toBe(compileMap(a).checksum);
  });

  it('canonicalJson：递归排序、数组保序、无空白', () => {
    expect(canonicalJson({ b: [3, { y: 1, x: 2 }], a: 'x', c: undefined })).toBe('{"a":"x","b":[3,{"x":2,"y":1}]}');
  });

  it('清单往返：rows_ascii 与 walkable 一致，zones_ascii 与 zoneOf 一致', () => {
    const map = compileMap(
      mapSrc(
        sceneSrc({
          obstacles: [{ kind: 'wall', x: 3, z: 3, w: 2, d: 1 }],
          zones: [{ id: 'A', name: 'A', indoor: true, rects: [{ x: 0, z: 0, w: 3, d: 3 }] }],
        }),
        { agentRadius: 0.25 },
      ),
    );
    const man = manifestOf(map);
    const sc = map.scenes.get('s')!;
    const g = man.grids.s!;
    expect(man.protocol).toBe(1);
    expect(man.checksum).toBe(map.checksum);
    expect(g.rows_ascii).toHaveLength(sc.rows);
    for (let r = 0; r < sc.rows; r++) {
      expect(g.rows_ascii[r]).toHaveLength(sc.cols);
      for (let c = 0; c < sc.cols; c++) {
        expect(g.rows_ascii[r]![c] === '.').toBe(sc.walkable[r * sc.cols + c] === 1);
        expect(g.zones_ascii[r]![c]).toBe(String(sc.zoneOf[r * sc.cols + c]));
      }
    }
    expect(g.zones.map((z) => z.id)).toEqual(['street', 'A']);
    expect(renderAscii(sc).split('\n')).toHaveLength(sc.rows);
    expect(renderAscii(sc, [{ x: 0.25, z: 0.25, ch: '@' }]).startsWith('@')).toBe(true);
  });
});

describe('grid 查询', () => {
  const sc = compileScene(sceneSrc({ obstacles: [{ kind: 'wall', x: 5, z: 0, w: 0.5, d: 6 }] }));

  it('cellAt / cellCentre：格线属于编号大的格，边界外为 null', () => {
    expect(cellAt(sc, 0, 0)).toEqual({ col: 0, row: 0 });
    expect(cellAt(sc, 0.5, 0.5)).toEqual({ col: 1, row: 1 });
    expect(cellAt(sc, 0.4999999, 0)).toEqual({ col: 0, row: 0 });
    expect(cellAt(sc, 10, 5)).toBeNull();
    expect(cellAt(sc, -0.001, 5)).toBeNull();
    expect(cellAt(sc, NaN, 5)).toBeNull();
    expect(cellCentre(sc, 2, 3)).toEqual({ x: 1.25, z: 1.75 });
    expect(isWalkable(sc, NaN, 1)).toBe(false);
    expect(isWalkable(sc, 5.25, 1)).toBe(false);
    expect(isWalkable(sc, 4.9, 1)).toBe(true);
    expect(distance({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
  });

  it('lineOfSight：被墙挡、绕过墙端、对称', () => {
    expect(lineOfSight(sc, { x: 2, z: 2 }, { x: 8, z: 2 })).toBe(false);
    expect(lineOfSight(sc, { x: 8, z: 2 }, { x: 2, z: 2 })).toBe(false);
    expect(lineOfSight(sc, { x: 2, z: 8 }, { x: 8, z: 8 })).toBe(true);
    expect(lineOfSight(sc, { x: 5.25, z: 2 }, { x: 8, z: 8 })).toBe(false); // 起点在墙里
    expect(lineOfSight(sc, { x: -1, z: 2 }, { x: 2, z: 2 })).toBe(false);
  });

  it('lineOfSight：两个正交格都被堵的对角线不通；擦过墙角的格点也不通', () => {
    const s2 = compileScene(
      sceneSrc({
        cell: 1,
        bounds: { x: 0, z: 0, w: 4, d: 4 },
        walk: [{ x: 0, z: 0, w: 4, d: 4 }],
        obstacles: [
          { kind: 'wall', x: 1, z: 0, w: 1, d: 1 },
          { kind: 'wall', x: 0, z: 1, w: 1, d: 1 },
        ],
        anchors: [{ id: 'a', x: 3.5, z: 3.5 }],
      }),
    );
    // (0.5,0.5)→(1.5,1.5) 恰好穿过格点 (1,1)，而 (1,0) 与 (0,1) 都是墙
    expect(lineOfSight(s2, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 })).toBe(false);
  });

  it('lineOfSight：穿过格点时只有一侧是墙也不许切角', () => {
    const s2 = compileScene(
      sceneSrc({
        cell: 1,
        bounds: { x: 0, z: 0, w: 4, d: 4 },
        walk: [{ x: 0, z: 0, w: 4, d: 4 }],
        obstacles: [{ kind: 'wall', x: 1, z: 0, w: 1, d: 1 }],
        anchors: [{ id: 'a', x: 3.5, z: 3.5 }],
      }),
    );
    // 起点 (0.5,0.5) → (1.5,1.5)：穿过格点 (1,1)，(1,0) 是墙 → 不通
    expect(lineOfSight(s2, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 })).toBe(false);
    expect(lineOfSight(s2, { x: 1.5, z: 1.5 }, { x: 0.5, z: 0.5 })).toBe(false);
    // 稍微偏离格点就不再擦角：(0.5,0.6)→(1.5,1.5) 不经过格子 (1,0)... 经过 (0,0)->(0,1)? 都可走
    expect(lineOfSight(s2, { x: 0.5, z: 0.6 }, { x: 1.5, z: 1.5 })).toBe(true);
    // 水平擦着墙下沿（z = 1，正好在格线上，属于下面一行）可通
    expect(lineOfSight(s2, { x: 0.5, z: 1.0 }, { x: 3.5, z: 1.0 })).toBe(true);
  });

  it('lineOfSight：随机端点对称', () => {
    let seed = 12345;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const walls = compileScene(
      sceneSrc({ obstacles: [{ kind: 'wall', x: 3, z: 3, w: 2, d: 2 }, { kind: 'wall', x: 6, z: 1, w: 0.5, d: 6 }] }),
    );
    for (let i = 0; i < 500; i++) {
      // 一半取格点坐标，容易制造擦顶点的情形
      const q = (): number => (i % 2 ? Math.round(rnd() * 20) / 2 : rnd() * 10);
      const a = { x: q(), z: q() };
      const b = { x: q(), z: q() };
      expect(lineOfSight(walls, a, b)).toBe(lineOfSight(walls, b, a));
    }
  });

  it('nearestWalkable', () => {
    expect(nearestWalkable(sc, { x: 1.1, z: 1.1 }, 0)).toEqual({ x: 1.1, z: 1.1 });
    // 墙里（x 5–5.5, z 0–6）：(5.1, 3.1) 离左右格中心 4.75 / 5.75 较近的是 4.75
    expect(nearestWalkable(sc, { x: 5.1, z: 3.1 }, 2)).toEqual({ x: 4.75, z: 3.25 });
    expect(nearestWalkable(sc, { x: 5.25, z: 3.25 }, 0.3)).toBeNull();
    // 平手：墙格正中 (5.25, 3.25) 到 (4.75,3.25) 与 (5.75,3.25) 等距 → 列小的先
    expect(nearestWalkable(sc, { x: 5.25, z: 3.25 }, 1)).toEqual({ x: 4.75, z: 3.25 });
    expect(nearestWalkable(sc, { x: 50, z: 3 }, 1)).toBeNull();
    expect(nearestWalkable(sc, { x: NaN, z: 3 }, 1)).toBeNull();
  });
});
