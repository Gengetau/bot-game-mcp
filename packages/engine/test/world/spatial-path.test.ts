import { describe, expect, it } from 'vitest';
import {
  arrivalAt,
  compileMap,
  distance,
  durationMs,
  findPath,
  isWalkable,
  lineOfSight,
  motionLength,
  pathLength,
  positionAt,
  zoneAt,
  zoneCrossings,
  type CompiledScene,
  type Motion,
  type SceneSource,
  type Vec2,
} from '../../src/world/spatial/index.js';

function build(over: Partial<SceneSource> = {}, agentRadius = 0): CompiledScene {
  const scene: SceneSource = {
    id: 's',
    name: '场景',
    instanced: false,
    cell: 0.5,
    bounds: { x: 0, z: 0, w: 20, d: 10 },
    walk: [{ x: 0, z: 0, w: 20, d: 10 }],
    obstacles: [],
    zones: [],
    defaultZone: { id: 'street', name: '街上', indoor: false },
    anchors: [{ id: 'a', x: 0.25, z: 0.25 }],
    interactables: [],
    portals: [],
    ...over,
  };
  return compileMap({
    mapVersion: 'p-1',
    agentRadius,
    speed: 1.4,
    interactDistance: 1.5,
    hearDistance: 8,
    scenes: [scene],
    aliases: {},
    spawn: { scene: 's', anchor: 'a' },
  }).scenes.get('s')!;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function checkPost(sc: CompiledScene, from: Vec2, to: Vec2, r: { points: Vec2[]; length: number }): void {
  const p = r.points;
  expect(p.length).toBeGreaterThanOrEqual(2);
  expect(p[0]).toEqual(from);
  expect(p[p.length - 1]).toEqual(to);
  for (let i = 1; i < p.length; i++) {
    expect(lineOfSight(sc, p[i - 1]!, p[i]!)).toBe(true);
    if (p.length > 2 || from.x !== to.x || from.z !== to.z) {
      expect(p[i]!.x !== p[i - 1]!.x || p[i]!.z !== p[i - 1]!.z).toBe(true);
    }
  }
  expect(r.length).toBeCloseTo(pathLength(p), 9);
}

const WALL_WITH_DOOR: Partial<SceneSource> = {
  // x 9.5–10 一堵墙，z 4–6 留门
  obstacles: [
    { kind: 'wall', x: 9.5, z: 0, w: 0.5, d: 4 },
    { kind: 'wall', x: 9.5, z: 6, w: 0.5, d: 4 },
  ],
};

describe('findPath', () => {
  it('空旷：直线，两点', () => {
    const sc = build();
    const r = findPath(sc, { x: 1, z: 1 }, { x: 18, z: 8 })!;
    expect(r.points).toEqual([{ x: 1, z: 1 }, { x: 18, z: 8 }]);
    expect(r.length).toBeCloseTo(distance({ x: 1, z: 1 }, { x: 18, z: 8 }), 9);
  });

  it('绕墙走门洞，端点精确，每段可见，长度接近最短', () => {
    const sc = build(WALL_WITH_DOOR);
    const from = { x: 2.3, z: 0.6 };
    const to = { x: 17.7, z: 1.6 };
    const r = findPath(sc, from, to)!;
    expect(r).not.toBeNull();
    checkPost(sc, from, to, r);
    expect(lineOfSight(sc, from, to)).toBe(false);
    // 参考：经过门洞中心的折线。真实最短路不会比它长，路径应不超过它的 8%
    const ref = distance(from, { x: 9.75, z: 5 }) + distance({ x: 9.75, z: 5 }, to);
    expect(r.length).toBeLessThanOrEqual(ref * 1.08);
    expect(r.length).toBeGreaterThanOrEqual(distance(from, to));
  });

  it('不可达的孤岛返回 null；端点不可走返回 null', () => {
    const sc = build({
      obstacles: [{ kind: 'wall', x: 9.5, z: 0, w: 0.5, d: 10 }],
    });
    expect(findPath(sc, { x: 2, z: 2 }, { x: 15, z: 2 })).toBeNull();
    expect(findPath(sc, { x: 9.7, z: 2 }, { x: 2, z: 2 })).toBeNull();
    expect(findPath(sc, { x: 2, z: 2 }, { x: 99, z: 2 })).toBeNull();
  });

  it('原地不动：两个重合的点，长度 0', () => {
    const sc = build();
    const r = findPath(sc, { x: 3, z: 3 }, { x: 3, z: 3 })!;
    expect(r.points).toEqual([{ x: 3, z: 3 }, { x: 3, z: 3 }]);
    expect(r.length).toBe(0);
  });

  it('确定性：同样输入逐位相同', () => {
    const sc = build(WALL_WITH_DOOR);
    const a = findPath(sc, { x: 2.3, z: 0.6 }, { x: 17.7, z: 1.6 });
    const b = findPath(sc, { x: 2.3, z: 0.6 }, { x: 17.7, z: 1.6 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('maxExpansions 太小返回 null', () => {
    const sc = build(WALL_WITH_DOOR);
    expect(findPath(sc, { x: 2.3, z: 0.6 }, { x: 17.7, z: 1.6 }, { maxExpansions: 5 })).toBeNull();
    expect(findPath(sc, { x: 2.3, z: 0.6 }, { x: 17.7, z: 1.6 }, { maxExpansions: 20000 })).not.toBeNull();
  });

  it('不穿过只靠对角连着的缝', () => {
    const sc = build({
      cell: 1,
      bounds: { x: 0, z: 0, w: 4, d: 4 },
      walk: [{ x: 0, z: 0, w: 4, d: 4 }],
      obstacles: [
        { kind: 'wall', x: 1, z: 0, w: 1, d: 2 },
        { kind: 'wall', x: 0, z: 1, w: 1, d: 1 },
        { kind: 'wall', x: 2, z: 1, w: 1, d: 1 },
      ],
    });
    // (0.5,0.5) 被围成只剩对角出口
    expect(findPath(sc, { x: 0.5, z: 0.5 }, { x: 3.5, z: 3.5 })).toBeNull();
  });

  it('随机起终点：后置条件全部成立（300 对）', () => {
    const sc = build({
      obstacles: [
        { kind: 'building', x: 3, z: 2, w: 4, d: 3 },
        { kind: 'building', x: 11, z: 5, w: 3, d: 4 },
        { kind: 'wall', x: 8, z: 0, w: 0.5, d: 6 },
        { kind: 'prop', x: 15, z: 1, w: 2, d: 2 },
        { kind: 'water', x: 1, z: 7, w: 5, d: 2 },
      ],
    }, 0.25);
    const rnd = lcg(2024);
    let done = 0;
    let nulls = 0;
    while (done < 300) {
      const from = { x: rnd() * 20, z: rnd() * 10 };
      const to = { x: rnd() * 20, z: rnd() * 10 };
      if (!isWalkable(sc, from.x, from.z) || !isWalkable(sc, to.x, to.z)) continue;
      done++;
      const r = findPath(sc, from, to);
      if (!r) {
        nulls++;
        continue;
      }
      checkPost(sc, from, to, r);
      expect(r.length).toBeGreaterThanOrEqual(distance(from, to) - 1e-9);
      expect(JSON.stringify(findPath(sc, from, to))).toBe(JSON.stringify(r));
    }
    expect(nulls).toBeLessThan(30);
  });

  it('性能：200×200 网格带障碍的 A*', () => {
    const obstacles = [];
    for (let i = 1; i < 10; i++) {
      // 交错开口的竖墙
      const gapTop = i % 2 === 0;
      obstacles.push({ kind: 'wall' as const, x: i * 20, z: gapTop ? 10 : 0, w: 1, d: 190 });
    }
    const sc = build({
      cell: 1,
      bounds: { x: 0, z: 0, w: 200, d: 200 },
      walk: [{ x: 0, z: 0, w: 200, d: 200 }],
      obstacles,
    });
    const t0 = performance.now();
    // 不传上限：默认按格子数封顶，四万格的迷宫里走得到的两点不会被误判成走不到
    const r = findPath(sc, { x: 2.5, z: 100.5 }, { x: 197.5, z: 100.5 });
    const ms = performance.now() - t0;
    console.log(`A* 200x200: ${ms.toFixed(1)} ms, points=${r?.points.length}, length=${r?.length.toFixed(1)}`);
    expect(r).not.toBeNull();
    checkPost(sc, { x: 2.5, z: 100.5 }, { x: 197.5, z: 100.5 }, r!);
  });
});

describe('motion', () => {
  const m: Motion = { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }], speed: 2, startedAt: 1000 };

  it('长度、用时、到达时刻', () => {
    expect(motionLength(m)).toBe(20);
    expect(durationMs(m)).toBe(10000);
    expect(arrivalAt(m)).toBe(11000);
    expect(durationMs({ ...m, speed: 3 })).toBe(Math.ceil((20 / 3) * 1000));
    expect(durationMs({ ...m, points: [{ x: 1, z: 1 }, { x: 1, z: 1 }] })).toBe(0);
  });

  it('起点之前、途中、拐角后、到达', () => {
    const before = positionAt(m, 0);
    expect(before).toMatchObject({ x: 0, z: 0, travelled: 0, arrived: false, halted: false });
    expect(before.heading).toBeCloseTo(Math.PI / 2); // 向东
    const mid = positionAt(m, 3500);
    expect(mid.x).toBeCloseTo(5);
    expect(mid.z).toBe(0);
    expect(mid.travelled).toBeCloseTo(5);
    const turn = positionAt(m, 8000);
    expect(turn.x).toBe(10);
    expect(turn.z).toBeCloseTo(4);
    expect(turn.heading).toBeCloseTo(Math.PI); // 向南
    const end = positionAt(m, 11000);
    expect(end).toMatchObject({ x: 10, z: 10, travelled: 20, arrived: true, halted: false });
    expect(positionAt(m, 99999)).toMatchObject({ x: 10, z: 10, arrived: true });
  });

  it('朝向：北 0，西 -π/2，南恰为 π（不是 -π）', () => {
    const h = (dx: number, dz: number) =>
      positionAt({ points: [{ x: 0, z: 0 }, { x: dx, z: dz }], speed: 1, startedAt: 0 }, 0).heading;
    expect(h(0, -5)).toBe(0);
    expect(h(-5, 0)).toBeCloseTo(-Math.PI / 2);
    expect(h(-0, 5)).toBe(Math.PI);
  });

  it('零长度路径：立即到达，朝向 0', () => {
    const z: Motion = { points: [{ x: 2, z: 2 }, { x: 2, z: 2 }], speed: 1, startedAt: 500 };
    expect(positionAt(z, 400)).toMatchObject({ x: 2, z: 2, heading: 0, arrived: false });
    expect(positionAt(z, 500)).toMatchObject({ x: 2, z: 2, heading: 0, arrived: true, travelled: 0 });
  });

  it('until 早于到达：停住，位置对之后任何 now 都完全相同', () => {
    const cut: Motion = { ...m, until: 4000 };
    const at = positionAt(cut, 4000);
    expect(at).toMatchObject({ x: 6, z: 0, halted: true, arrived: false });
    expect(positionAt(cut, 3999).halted).toBe(false);
    for (const now of [4001, 5000, 10999, 11000, 50000, 1e12]) {
      expect(positionAt(cut, now)).toEqual(at);
    }
  });

  it('until 晚于到达：照常到达', () => {
    const late: Motion = { ...m, until: 20000 };
    expect(positionAt(late, 11000)).toMatchObject({ x: 10, z: 10, arrived: true, halted: false });
    expect(positionAt(late, 5000).halted).toBe(false);
    const exact: Motion = { ...m, until: 11000 };
    expect(positionAt(exact, 12000).arrived).toBe(true);
  });

  it('until 早于起点：原地不动', () => {
    const p = positionAt({ ...m, until: 500 }, 2000);
    expect(p).toMatchObject({ x: 0, z: 0, travelled: 0, halted: true });
  });
});

describe('zoneCrossings', () => {
  const zones: Partial<SceneSource> = {
    zones: [
      { id: 'A', name: 'A', indoor: true, rects: [{ x: 0, z: 0, w: 6, d: 10 }] },
      { id: 'B', name: 'B', indoor: true, rects: [{ x: 14, z: 0, w: 6, d: 10 }] },
    ],
  };

  /** 校验题面要求：采样区域一致，前 1 毫秒是前一个区域，at 严格递增且在 (start, arrival] */
  function verify(sc: CompiledScene, m: Motion): ReturnType<typeof zoneCrossings> {
    const cs = zoneCrossings(sc, m);
    const noUntil: Motion = { points: m.points, speed: m.speed, startedAt: m.startedAt };
    const zoneId = (t: number): string => {
      const s = positionAt(noUntil, t);
      return zoneAt(sc, s.x, s.z).id;
    };
    let prev = zoneId(m.startedAt);
    let last = m.startedAt;
    for (const c of cs) {
      expect(Number.isInteger(c.at)).toBe(true);
      expect(c.at).toBeGreaterThan(last);
      expect(c.at).toBeLessThanOrEqual(arrivalAt(noUntil));
      expect(zoneId(c.at)).toBe(c.zone);
      expect(zoneId(c.at - 1)).toBe(prev);
      const s = positionAt(noUntil, c.at);
      expect(c.x).toBe(s.x);
      expect(c.z).toBe(s.z);
      prev = c.zone;
      last = c.at;
    }
    return cs;
  }

  it('房间 A → 走廊（默认区域）→ 房间 B', () => {
    const sc = build(zones);
    const m: Motion = { points: [{ x: 3, z: 5 }, { x: 17, z: 5 }], speed: 2, startedAt: 10_000 };
    const cs = verify(sc, m);
    expect(cs.map((c) => c.zone)).toEqual(['street', 'B']);
    expect(cs[0]!.at).toBe(10_000 + 1500); // 走 3 米到 x=6
    expect(cs[1]!.at).toBe(10_000 + 5500); // 走 11 米到 x=14
    expect(cs[0]!.x).toBeCloseTo(6);
    // 反向走
    const back = verify(sc, { ...m, points: [...m.points].reverse() });
    expect(back.map((c) => c.zone)).toEqual(['street', 'A']);
  });

  it('始终在同一区域、零长度路径：没有穿越', () => {
    const sc = build(zones);
    expect(zoneCrossings(sc, { points: [{ x: 1, z: 1 }, { x: 5, z: 5 }], speed: 1, startedAt: 0 })).toEqual([]);
    expect(zoneCrossings(sc, { points: [{ x: 1, z: 1 }, { x: 1, z: 1 }], speed: 1, startedAt: 0 })).toEqual([]);
  });

  it('忽略 until', () => {
    const sc = build(zones);
    const m: Motion = { points: [{ x: 3, z: 5 }, { x: 17, z: 5 }], speed: 2, startedAt: 0, until: 100 };
    expect(zoneCrossings(sc, m)).toHaveLength(2);
  });

  it('随机路径（含多折线、速度非整、恰在格线上的折点）满足采样要求', () => {
    const sc = build({
      ...zones,
      obstacles: [
        { kind: 'building', x: 3, z: 2, w: 4, d: 3 },
        { kind: 'wall', x: 10, z: 0, w: 0.5, d: 7 },
      ],
    }, 0.25);
    const rnd = lcg(777);
    let n = 0;
    let withCrossings = 0;
    while (n < 200) {
      const snap = n % 3 === 0;
      const q = (): Vec2 => (snap ? { x: Math.round(rnd() * 40) / 2, z: Math.round(rnd() * 20) / 2 } : { x: rnd() * 20, z: rnd() * 10 });
      const a = q();
      const b = q();
      const path = findPath(sc, a, b);
      if (!path) continue;
      n++;
      const speed = [0.7, 1.4, 3.3, 5][n % 4]!;
      const cs = verify(sc, { points: path.points, speed, startedAt: 1_700_000_000_000 + n * 37 });
      if (cs.length) withCrossings++;
    }
    expect(withCrossings).toBeGreaterThan(20);
  });
});
