/**
 * 出生点错开：新居民第一次进入时不叠在同一个坐标上。
 * 候选点生成是 spatial/spawn.ts 的纯函数；「此刻有没有人」由 space.ts 的 spreadSpot 现算（居民、NPC、正在走路的人都算）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import { actorOf, ensureActor, placeNpc, spreadSpot } from '../../src/world/space.js';
import { compileMap, type MapSource } from '../../src/world/spatial/index.js';
import { isWalkable, zoneAt } from '../../src/world/spatial/grid.js';
import { pickSpawn, spawnCandidates, spawnRingPoints } from '../../src/world/spatial/spawn.js';
import { FakeClock } from '../helpers.js';
import { KEEPER, makeTown, tempDb, type Actor, type Town } from './helpers.js';

const town = (t: Town) => t.w.map.scenes.get('town')!;
const anchor = (t: Town) => town(t).anchors.get('plaza')!;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const xz = (a: Actor) => ({ x: a.pos().x, z: a.pos().z });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('候选点生成（纯函数）', () => {
  const c = { x: 10, z: 20 };

  it('中心在前；第 k 圈半径 k、均匀 6k 个点；总数 1+6+12+18…', () => {
    const pts = spawnRingPoints(c, { rings: 3 });
    expect(pts).toHaveLength(1 + 6 + 12 + 18);
    expect(pts[0]).toEqual(c);
    let at = 1;
    for (let k = 1; k <= 3; k++) {
      const ring = pts.slice(at, at + 6 * k);
      at += 6 * k;
      for (const p of ring) expect(dist(p, c)).toBeCloseTo(k, 9);
      // 同一圈相邻两点间距相等（均匀）
      const gaps = ring.map((p, i) => dist(p, ring[(i + 1) % ring.length]!));
      for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 9);
    }
  });

  it('每一圈相对中心对称：偶数个点里第 i 个和第 i + n/2 个的中点就是中心', () => {
    const pts = spawnRingPoints(c, { rings: 2 });
    const ring2 = pts.slice(7);
    for (let i = 0; i < 6; i++) {
      const a = ring2[i]!;
      const b = ring2[i + 6]!;
      expect((a.x + b.x) / 2).toBeCloseTo(c.x, 9);
      expect((a.z + b.z) / 2).toBeCloseTo(c.z, 9);
    }
  });

  it('只看参数：重复调用逐字节一样，ringStep 缩放半径', () => {
    expect(spawnRingPoints(c)).toEqual(spawnRingPoints(c));
    const wide = spawnRingPoints(c, { ringStep: 2, rings: 1 });
    for (const p of wide.slice(1)) expect(dist(p, c)).toBeCloseTo(2, 9);
  });

  it('场景里的候选：第一个是中心，都可走、与中心同区域、可以重复得到同一个序列', () => {
    const t = makeTown();
    const sc = town(t);
    const a = anchor(t);
    const list = spawnCandidates(sc, a);
    expect(list[0]).toEqual({ x: a.x, z: a.z });
    expect(list.length).toBeGreaterThan(20);
    for (const p of list) {
      expect(isWalkable(sc, p.x, p.z)).toBe(true);
      expect(zoneAt(sc, p.x, p.z).id).toBe(zoneAt(sc, a.x, a.z).id);
    }
    expect(spawnCandidates(sc, a)).toEqual(list);
  });

  it('中心贴着障碍时：不可走的候选被丢掉，留下的都可走', () => {
    const t = makeTown();
    const sc = town(t);
    const fountain = sc.source.obstacles.find((o) => o.id === 'plaza.fountain')!;
    const centre = { x: fountain.x + fountain.w / 2, z: fountain.z + fountain.d + 0.75 }; // 喷泉南沿外一点
    expect(isWalkable(sc, centre.x, centre.z)).toBe(true);
    const ideal = spawnRingPoints(centre);
    const list = spawnCandidates(sc, centre);
    expect(ideal.some((p) => !isWalkable(sc, p.x, p.z))).toBe(true); // 这个中心附近确实有不可走的理想点
    expect(list.length).toBeLessThan(ideal.length);
    for (const p of list) expect(isWalkable(sc, p.x, p.z)).toBe(true);
  });

  it('中心旁边隔着一堵墙：墙另一侧同样可走的点不在候选里（只有视线检查能挡住）', () => {
    const src: MapSource = {
      mapVersion: 'wall-1',
      agentRadius: 0,
      speed: 1.4,
      interactDistance: 1.5,
      hearDistance: 8,
      scenes: [
        {
          id: 's',
          name: '场景',
          instanced: false,
          cell: 0.5,
          bounds: { x: 0, z: 0, w: 12, d: 12 },
          walk: [{ x: 0, z: 0, w: 12, d: 12 }],
          obstacles: [{ id: 'wall', kind: 'wall', x: 5, z: 0, w: 0.5, d: 12 }], // 把场景从 x=5 到 5.5 整条隔开
          zones: [],
          defaultZone: { id: 'street', name: '街上', indoor: false },
          anchors: [{ id: 'a', x: 4.25, z: 6.25 }],
          interactables: [],
          portals: [],
        },
      ],
      aliases: {},
      spawn: { scene: 's', anchor: 'a' },
    };
    const sc = compileMap(src).scenes.get('s')!;
    const centre = { x: 4.25, z: 6.25 };
    const ideal = spawnRingPoints(centre);
    const behind = ideal.filter((p) => p.x > 5.5 && isWalkable(sc, p.x, p.z));
    expect(behind.length).toBeGreaterThan(0); // 墙后确实有可走、同区域的理想点
    expect(behind.every((p) => zoneAt(sc, p.x, p.z).id === zoneAt(sc, centre.x, centre.z).id)).toBe(true);
    const list = spawnCandidates(sc, centre);
    expect(list.length).toBeGreaterThan(5);
    for (const p of list) expect(p.x).toBeLessThan(5);
  });

  it('pickSpawn：跳过被占的点（半径内算占），全占了退回第一个（中心）', () => {
    const cands = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    expect(pickSpawn(cands, [], 0.8)).toEqual(cands[0]);
    expect(pickSpawn(cands, [{ x: 0.5, z: 0 }], 0.8)).toEqual(cands[2]);
    expect(pickSpawn(cands, [{ x: 0, z: 0 }], 0.8)).toEqual(cands[1]);
    expect(pickSpawn(cands, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], 0.8)).toEqual(cands[0]);
  });
});

describe('先后进入的居民', () => {
  it('一个人进来落在锚点中心，朝向沿用锚点', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const an = anchor(t);
    expect(actorOf(t.w, a.residentId)).toMatchObject({ x: an.x, z: an.z, heading: an.facing ?? 0 });
    expect(a.row().location_id).toBe('plaza');
  });

  it.each([8, 20])('依次进来 %i 个人：两两间距不小于 0.8 米，都在可走范围里、都在广场，朝向相同', (n) => {
    const t = makeTown();
    const people = Array.from({ length: n }, (_, i) => t.join(`居民${i}`));
    const an = anchor(t);
    for (const p of people) {
      expect(isWalkable(town(t), p.pos().x, p.pos().z)).toBe(true);
      expect(p.row().location_id).toBe('plaza');
      expect(actorOf(t.w, p.residentId)!.heading).toBe(an.facing ?? 0);
    }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(dist(xz(people[i]!), xz(people[j]!))).toBeGreaterThanOrEqual(0.8);
    // 前七个人两两相距不超过 2 米，仍在当面互动的 3 米之内
    for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) expect(dist(xz(people[i]!), xz(people[j]!))).toBeLessThanOrEqual(2 + 1e-9);
    expect(xz(people[0]!)).toEqual({ x: an.x, z: an.z });
  });

  it('同样的进入顺序得到同样的落点（不用随机数）', () => {
    const run = (seed: string) => {
      const t = makeTown({ seed });
      return Array.from({ length: 12 }, (_, i) => xz(t.join(`居民${i}`)));
    };
    expect(run('s-one')).toEqual(run('s-two'));
  });

  it('不碰 w.rng：在已有人占着中心的广场上放一个新角色行，随机数流的状态一点没动', () => {
    const t = makeTown({ seed: 'rng-check' });
    const a = t.join('阿灯');
    t.join('小岚'); // 中心和第一圈第一个点已被占，新来的要在候选里挑
    const c = t.join('阿树');
    // 只重做「放人」这一步：删掉阿树的角色行再补行，期间不经过编号生成
    t.w.db.run('DELETE FROM world_actors WHERE actor_id = ?', c.residentId);
    const rng = t.w.rng as SeededRng;
    const before = rng.saveState();
    ensureActor(t.w, t.w.resident(c.residentId)!, t.w.now());
    expect(rng.saveState()).toBe(before);
    expect(dist(xz(c), xz(a))).toBeGreaterThanOrEqual(0.8); // 确实走过了「挑候选点」的路
  });

  it('站着的人占着候选点：新来的跳过它', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const cands = spawnCandidates(town(t), anchor(t));
    expect(xz(b)).toEqual(cands[1]);
    // 阿灯走开，中心空出来；小岚还站在第一圈的第一个点
    a.go('tea_house');
    const c = t.join('阿树');
    const d = t.join('阿松');
    expect(xz(c)).toEqual(cands[0]);
    expect(xz(d)).toEqual(cands[2]);
  });

  it('正在走路的人按现算位置占位：刚迈出一步，中心仍被占着', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const cands = spawnCandidates(town(t), anchor(t));
    a.act('navigate', { to: 'tea_house' });
    t.advance(Math.round((0.3 / t.w.map.speed) * 1000)); // 约 0.3 米
    expect(a.pos().moving).toBe(true);
    expect(dist(a.pos(), cands[0]!)).toBeLessThan(0.8);
    const b = t.join('小岚');
    expect(xz(b)).not.toEqual(cands[0]);
    expect(dist(xz(b), a.pos())).toBeGreaterThanOrEqual(0.8);
  });

  it('占位用现算位置：走远了的人不再占着出发点（存下的坐标是出发点，不能拿来用）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const cands = spawnCandidates(town(t), anchor(t));
    a.act('navigate', { to: 'tea_house' });
    t.advance(4000);
    expect(a.pos().moving).toBe(true);
    expect(dist(a.pos(), cands[0]!)).toBeGreaterThan(2); // 已经离出发点很远
    const b = t.join('小岚');
    expect(xz(b)).toEqual(cands[0]);
  });

  it('selfId：自己的行不算占位（换图重新安置时自己的旧位置不能把自己挤到下一个点）', () => {
    const t = makeTown();
    const a = t.join('阿灯'); // 站在中心
    const an = anchor(t);
    const spot = { scene: 'town', instance: '', x: an.x, z: an.z };
    const cands = spawnCandidates(town(t), an);
    const now = t.w.now();
    expect(spreadSpot(t.w, spot, now)).toMatchObject(cands[1]!); // 别人来：中心被阿灯占着
    expect(spreadSpot(t.w, spot, now, a.residentId)).toMatchObject(cands[0]!); // 阿灯自己重新安置：中心不算被占
  });

  it('NPC 站在候选点上也算占位', () => {
    const t = makeTown();
    const an = anchor(t);
    const cands = spawnCandidates(town(t), an);
    placeNpc(t.w, KEEPER, { x: cands[0]!.x, z: cands[0]!.z, heading: 0 }, t.clock.t);
    const a = t.join('阿灯');
    expect(xz(a)).toEqual(cands[1]);
    expect(dist(xz(a), cands[0]!)).toBeGreaterThanOrEqual(0.8);
  });

  it('候选全满：退回中心，不报错', () => {
    const t = makeTown({ params: { activeResidentLimit: 500 } }); // 候选点比默认的在场名额还多
    const n = spawnCandidates(town(t), anchor(t)).length;
    const people = Array.from({ length: n }, (_, i) => t.join(`居民${i}`));
    const extra = t.join('晚到的');
    const an = anchor(t);
    expect(xz(extra)).toEqual({ x: an.x, z: an.z });
    expect(actorOf(t.w, extra.residentId)).toBeTruthy();
    expect(new Set(people.map((p) => `${p.pos().x},${p.pos().z}`)).size).toBe(n);
  });

  it('老居民离线再回来：位置不变；回来的人不挪别人', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const beforeA = xz(a);
    const beforeB = xz(b);
    a.leave();
    t.advance(1000);
    a.enter();
    expect(xz(a)).toEqual(beforeA);
    expect(xz(b)).toEqual(beforeB);
  });

  it('错开不改公开事件和公开投影：世界事件、公开事件、每位居民的私有事件和回执里都没有坐标', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.act('navigate', { to: 'tea_house' }); // 走起来之后各表里都有些内容
    const receipt = b.act('say_nearby', { text: '你好' });
    expect(JSON.stringify(receipt)).not.toMatch(/"(x|z)":/);
    const tables = [
      ['world_events', 'payload'],
      ['public_events', 'projection'],
      ['recipient_events', 'projection'],
    ] as const;
    const seen: Record<string, number> = {};
    for (const [table, col] of tables) {
      const rows = t.w.db.all(`SELECT ${col} AS p FROM ${table}`).map((r) => String(r.p));
      seen[table] = rows.length;
      for (const p of rows) expect(p, table).not.toMatch(/"(x|z)":/);
    }
    expect(Object.values(seen).reduce((a, b) => a + b, 0), '表里要有内容，否则这条断言是空的').toBeGreaterThan(0);
  });
});

describe('地图换版本后的重新安置', () => {
  it('不合法的人重新落到出生锚点时同样错开，不叠在一起，也不叠在没动的人身上', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const t = makeTown({ dbPath: file.path, clock: new FakeClock() });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const c = t.join('阿树');
    const keep = xz(c);
    const fountain = town(t).source.obstacles.find((o) => o.id === 'plaza.fountain')!;
    const inside = { x: fountain.x + fountain.w / 2, z: fountain.z + fountain.d / 2 };
    const raw = t.w.db.db;
    // 假装 a、b 是旧地图留下的，站在如今是喷泉的地方；c 的位置仍然合法
    for (const x of [a, b]) raw.prepare("UPDATE world_actors SET map_version = 'old', x = ?, z = ? WHERE actor_id = ?").run(inside.x, inside.z, x.residentId);
    raw.prepare("UPDATE world_actors SET map_version = 'old' WHERE actor_id = ?").run(c.residentId);
    t.restart();
    expect(xz(c)).toEqual(keep);
    const spots = [a, b, c].map(xz);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(dist(spots[i]!, spots[j]!)).toBeGreaterThanOrEqual(0.8);
    for (const x of [a, b]) {
      expect(isWalkable(town(t), x.pos().x, x.pos().z)).toBe(true);
      expect(x.row().location_id).toBe('plaza');
    }
  });
});
