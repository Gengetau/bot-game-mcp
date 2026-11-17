/**
 * 够得着的判定（requireReach / objectReach / travelSeconds）在「不止一个公共场景」的地图上的行为。
 * 目前没有办法让居民走到另一个公共场景（导航只在出生点所在的场景里走），
 * 所以这里直接用 SQL 改 world_actors 的 scene_id / x / z 把人摆过去——只在测试里这么做。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { compileMap, type InteractableSource, type MapSource, type SceneSource } from '../../src/world/spatial/index.js';
import { objectReach, requireReach, travelSeconds } from '../../src/world/space.js';
import { makeTown, type Actor, type Town } from './helpers.js';

function scene(id: string, anchors: string[], interactables: InteractableSource[], instanced = false): SceneSource {
  return {
    id,
    name: id,
    instanced,
    cell: 0.5,
    bounds: { x: 0, z: 0, w: 10, d: 10 },
    walk: [{ x: 0, z: 0, w: 10, d: 10 }],
    obstacles: [],
    zones: [],
    defaultZone: { id: `zone_${id}`, name: id, indoor: false },
    anchors: anchors.map((a, i) => ({ id: a, x: 1.25 + i * 7, z: 1.25 + i * 7 })),
    interactables,
    portals: [],
  };
}

const obj = (id: string): InteractableSource => ({ id, kind: 'sample', name: id, x: 5, z: 5, useAnchors: [{ x: 5, z: 3.75 }] });

function twoSceneMap(over: Partial<MapSource> = {}, bObj: InteractableSource = obj('obj_b')): MapSource {
  return {
    mapVersion: 'two-scenes-test',
    agentRadius: 0,
    speed: 1.4,
    interactDistance: 1.5,
    hearDistance: 8,
    scenes: [scene('A', ['a0', 'a1'], [obj('obj_a')]), scene('B', ['b0', 'b1'], [bObj]), scene('H', ['centre'], [], true)],
    aliases: {
      a0: { scene: 'A', anchor: 'a0' },
      a1: { scene: 'A', anchor: 'a1' },
      b0: { scene: 'B', anchor: 'b0' },
      b1: { scene: 'B', anchor: 'b1' },
    },
    spawn: { scene: 'A', anchor: 'a0' },
    ...over,
  };
}

/** 测试专用：把居民直接摆到某个场景某处（绕过导航，因为目前没有跨公共场景的走法）。 */
function place(t: Town, who: Actor, sceneId: string, x: number, z: number, instance = ''): void {
  t.w.db.run('UPDATE world_actors SET scene_id = ?, instance_id = ?, x = ?, z = ?, nav_json = NULL WHERE actor_id = ?', sceneId, instance, x, z, who.residentId);
}

const reach = (t: Town, who: Actor, id: string): void => requireReach(t.w, who.row(), id, t.w.now());
/** 取错误的 reason（not_here / too_far） */
const code = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorldError) return e.reason;
    throw e;
  }
  return undefined;
};

describe('两个公共场景：requireReach / objectReach', () => {
  it('人在 A：走近后够得着 a；对 b 是 not_here（不放行、不是 too_far）；objectReach 对 b 不近', () => {
    const t = makeTown({ map: twoSceneMap() });
    const u = t.join('阿灯');
    expect(code(() => reach(t, u, 'obj_a'))).toBe('too_far');
    u.go('obj_a');
    expect(code(() => reach(t, u, 'obj_a'))).toBeUndefined();
    expect(objectReach(t.w, u.residentId, 'obj_a', t.w.now())?.near).toBe(true);
    expect(code(() => reach(t, u, 'obj_b'))).toBe('not_here');
    try {
      reach(t, u, 'obj_b');
    } catch (e) {
      expect((e as WorldError).data?.navigateTo).toBeUndefined(); // 不带 navigateTo
    }
    const r = objectReach(t.w, u.residentId, 'obj_b', t.w.now());
    expect(r).toEqual({ near: false, distance: Infinity });
  });

  it('人在 B：反过来，物件 b 够得着，a 是 not_here', () => {
    const t = makeTown({ map: twoSceneMap() });
    const u = t.join('阿灯');
    place(t, u, 'B', 5, 3.75);
    expect(code(() => reach(t, u, 'obj_b'))).toBeUndefined();
    expect(objectReach(t.w, u.residentId, 'obj_b', t.w.now())?.near).toBe(true);
    expect(code(() => reach(t, u, 'obj_a'))).toBe('not_here');
    expect(objectReach(t.w, u.residentId, 'obj_a', t.w.now())).toEqual({ near: false, distance: Infinity });
    // 同场景但站得远：仍是 too_far
    place(t, u, 'B', 1, 1);
    expect(code(() => reach(t, u, 'obj_b'))).toBe('too_far');
  });

  it('伪造的物件编号：not_here；objectReach 仍是 null', () => {
    const t = makeTown({ map: twoSceneMap() });
    const u = t.join('阿灯');
    expect(code(() => reach(t, u, 'obj_fake'))).toBe('not_here');
    expect(objectReach(t.w, u.residentId, 'obj_fake', t.w.now())).toBeNull();
  });

  it('地图上没有位置的公共地点物件：区域标签要等于它所在的地点', () => {
    const t = makeTown({ map: twoSceneMap() });
    const u = t.join('阿灯');
    const here = u.row().location_id;
    const ins = (id: string, space: string) =>
      t.w.db.run('INSERT INTO placed_objects(object_id, world_id, space_id, type, label, owner_id, config_version, created_at) VALUES (?,?,?,?,?,NULL,1,0)', id, t.w.worldId, space, 'sample', id);
    ins('pub_here', here);
    ins('pub_away', 'somewhere_else');
    expect(code(() => reach(t, u, 'pub_here'))).toBeUndefined();
    expect(code(() => reach(t, u, 'pub_away'))).toBe('not_here');
    expect(objectReach(t.w, u.residentId, 'pub_here', t.w.now())).toBeNull();
  });

  it('私宅里的物件：只有就在那一户私宅实例里的人才够得着', () => {
    const t = makeTown({ map: twoSceneMap() });
    const owner = t.join('房主');
    const guest = t.join('访客');
    t.w.db.run('INSERT INTO placed_objects(object_id, world_id, space_id, type, label, owner_id, config_version, created_at) VALUES (?,?,?,?,?,?,1,0)', 'sofa', t.w.worldId, `home:${owner.residentId}`, 'sample', 'sofa', owner.residentId);
    // 在屋外（公共场景）
    expect(code(() => reach(t, owner, 'sofa'))).toBe('not_here');
    expect(code(() => reach(t, guest, 'sofa'))).toBe('not_here');
    // 房主在自己家里：可以
    place(t, owner, 'H', 5, 5, owner.residentId);
    expect(code(() => reach(t, owner, 'sofa'))).toBeUndefined();
    // 访客站在别人（自己）家的实例里：不行；站在房主家里：可以
    place(t, guest, 'H', 5, 5, guest.residentId);
    expect(code(() => reach(t, guest, 'sofa'))).toBe('not_here');
    place(t, guest, 'H', 5, 5, owner.residentId);
    expect(code(() => reach(t, guest, 'sofa'))).toBeUndefined();
  });
});

describe('travelSeconds', () => {
  it('同一场景内有数值；跨场景是 null；第二个公共场景内也能估算', () => {
    const t = makeTown({ map: twoSceneMap() });
    t.join('阿灯');
    const ab = travelSeconds(t.w, 'a0', 'a1');
    expect(ab).toBeGreaterThan(0);
    expect(travelSeconds(t.w, 'a1', 'a0')).toBe(ab);
    expect(travelSeconds(t.w, 'a0', 'a0')).toBe(0);
    expect(travelSeconds(t.w, 'a0', 'b0')).toBeNull();
    const bb = travelSeconds(t.w, 'b0', 'b1');
    expect(bb).toBeGreaterThan(0);
    // 缓存键带场景编号：A、B 里同名锚点不会串
    expect(travelSeconds(t.w, 'b1', 'b0')).toBe(bb);
    expect(travelSeconds(t.w, 'a0', 'nowhere')).toBeNull();
  });
});

describe('compileMap：物件编号跨场景唯一', () => {
  it('两个场景里有同一个物件编号就报错', () => {
    expect(() => compileMap(twoSceneMap({}, obj('obj_a')))).toThrow(/物件编号跨场景重复：obj_a/);
  });
  it('不同编号正常编译', () => {
    expect(() => compileMap(twoSceneMap())).not.toThrow();
  });
});
