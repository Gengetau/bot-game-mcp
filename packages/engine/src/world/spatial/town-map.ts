/**
 * 栖灯镇的地图源（P0 灰盒版）。
 *
 * 一张公共场景 town：六个公共地点、连接它们的路、公共住宅接入点都在同一张网格里；室内就是被墙围起来、留了门洞的一块。
 * 一张私宅场景 home：每户一个实例（实例号 = 房主），所有人家共用这一张图。进出只经过接入点的会馆门口。
 *
 * 这份数据是服务器和客户端共同的依据：服务器把它栅格化成可行走网格，客户端拿编译后的清单画场景。
 * 改了可走范围、锚点或物件位置，就要换 mapVersion（已经发布的版本不原地改）。
 *
 * 写法约定：可走范围只用对齐半米网格的矩形；墙画在两块可走范围之间的空隙里（离两边都超过角色半径），
 * 所以墙只是给画面看的，不会意外吃掉门口的格子。
 */
import type { AnchorSource, InteractableSource, MapSource, ObstacleSource, Rect, SceneSource, ZoneSource } from './types.js';

const WALL_NEAR = 0.35;
const WALL_FAR = 0.65;

interface Door {
  side: 'n' | 's';
  /** 门洞沿 x 的范围 */
  from: number;
  to: number;
}

/** 一栋房子：室内一块矩形、门外一米深的门槛、四面墙（门洞处断开）。 */
function building(id: string, name: string, inner: Rect, door: Door, h = 3.2): { walk: Rect[]; zone: ZoneSource; walls: ObstacleSource[] } {
  const step: Rect = door.side === 's' ? { x: door.from, z: inner.z + inner.d, w: door.to - door.from, d: 1 } : { x: door.from, z: inner.z - 1, w: door.to - door.from, d: 1 };
  const x0 = inner.x - WALL_FAR;
  const x1 = inner.x + inner.w + WALL_FAR;
  const zN0 = inner.z - WALL_FAR;
  const zS0 = inner.z + inner.d + WALL_NEAR;
  const t = WALL_FAR - WALL_NEAR;
  const wall = (suffix: string, r: Rect): ObstacleSource => ({ ...r, kind: 'wall', h, id: `${id}.wall.${suffix}` });
  const walls: ObstacleSource[] = [
    wall('w', { x: x0, z: zN0, w: t, d: inner.d + 2 * WALL_FAR }),
    wall('e', { x: x1 - t, z: zN0, w: t, d: inner.d + 2 * WALL_FAR }),
  ];
  const split = (suffix: string, z: number, hasDoor: boolean) => {
    if (!hasDoor) {
      walls.push(wall(suffix, { x: x0, z, w: x1 - x0, d: t }));
      return;
    }
    walls.push(wall(`${suffix}1`, { x: x0, z, w: door.from - WALL_NEAR - x0, d: t }));
    walls.push(wall(`${suffix}2`, { x: door.to + WALL_NEAR, z, w: x1 - (door.to + WALL_NEAR), d: t }));
  };
  split('n', zN0, door.side === 'n');
  split('s', zS0, door.side === 's');
  return { walk: [inner, step], zone: { id, name, rects: [inner, step], indoor: true }, walls };
}

/** 一件占地一米见方的物件，四面都能站人。 */
function boxObject(id: string, kind: string, name: string, x: number, z: number, sides: ('n' | 's' | 'e' | 'w')[]): InteractableSource {
  const off = 1.25;
  const at = { n: { x, z: z - off }, s: { x, z: z + off }, e: { x: x + off, z }, w: { x: x - off, z } };
  return { id, kind, name, x, z, footprint: { x: x - 0.5, z: z - 0.5, w: 1, d: 1 }, useAnchors: sides.map((s) => at[s]) };
}

const teaHouse = building('tea_house', '栖灯茶馆', { x: 4, z: 2, w: 14, d: 10 }, { side: 's', from: 10, to: 12 });
const bookshop = building('bookshop', '檐下书屋', { x: 22, z: 2, w: 12, d: 10 }, { side: 's', from: 27, to: 29 });
const kitchen = building('kitchen', '公共厨房', { x: 44, z: 2, w: 14, d: 10 }, { side: 's', from: 50, to: 52 });
const arcade = building('arcade', '游戏馆', { x: 24, z: 41, w: 16, d: 6 }, { side: 'n', from: 31, to: 33 });

const PLAZA: Rect = { x: 20, z: 18, w: 24, d: 16 };
const GARDEN: Rect = { x: 48, z: 20, w: 14, d: 14 };
const RESIDENTIAL: Rect = { x: 2, z: 20, w: 14, d: 12 };

/** 路和各处之间的连接（都算「路上」）。 */
const ROADS: Rect[] = [
  { x: 2, z: 13, w: 60, d: 5 }, // 北边的主路
  { x: 2, z: 36, w: 60, d: 4 }, // 南边的路
  { x: 7, z: 18, w: 4, d: 2 }, // 住宅接入点 ↔ 北路
  { x: 7, z: 32, w: 4, d: 4 }, // 住宅接入点 ↔ 南路
  { x: 16, z: 24, w: 4, d: 3 }, // 住宅接入点 ↔ 广场
  { x: 44, z: 25, w: 4, d: 3 }, // 广场 ↔ 花园
  { x: 53, z: 18, w: 4, d: 2 }, // 花园 ↔ 北路
  { x: 53, z: 34, w: 4, d: 2 }, // 花园 ↔ 南路
  { x: 30, z: 34, w: 4, d: 2 }, // 广场 ↔ 南路
];

const prop = (id: string, r: Rect, h: number, kind: ObstacleSource['kind'] = 'prop'): ObstacleSource => ({ ...r, kind, h, id });

const TOWN_ANCHORS: AnchorSource[] = [
  { id: 'plaza', x: 32, z: 30.25, facing: 0 },
  { id: 'tea_house', x: 11, z: 10.25, facing: 0 },
  { id: 'bookshop', x: 28, z: 10.25, facing: 0 },
  { id: 'kitchen', x: 51, z: 10.25, facing: 0 },
  { id: 'garden', x: 55, z: 24.25, facing: Math.PI },
  { id: 'arcade', x: 32, z: 42.25, facing: Math.PI },
  { id: 'residential', x: 9, z: 26.25, facing: -Math.PI / 2 },
  // 会馆门口：进出私宅实例只经过这里
  { id: 'residential.door', x: 3.25, z: 26.25, facing: -Math.PI / 2 },
];

const TOWN: SceneSource = {
  id: 'town',
  name: '栖灯镇',
  instanced: false,
  cell: 0.5,
  bounds: { x: 0, z: 0, w: 64, d: 48 },
  walk: [...teaHouse.walk, ...bookshop.walk, ...kitchen.walk, ...arcade.walk, PLAZA, GARDEN, RESIDENTIAL, ...ROADS],
  obstacles: [
    ...teaHouse.walls,
    ...bookshop.walls,
    ...kitchen.walls,
    ...arcade.walls,
    // 广场
    prop('plaza.fountain', { x: 30.5, z: 22.5, w: 3, d: 3 }, 1.2),
    prop('plaza.stall', { x: 38, z: 19.5, w: 3, d: 1.5 }, 2.2),
    prop('plaza.bench1', { x: 24, z: 31.5, w: 2, d: 0.5 }, 0.5),
    prop('plaza.bench2', { x: 38, z: 31.5, w: 2, d: 0.5 }, 0.5),
    // 茶馆、书屋、厨房、花园、游戏馆里的柜台和桌子
    prop('tea_house.counter', { x: 14.5, z: 9.5, w: 3, d: 1 }, 1.1),
    prop('bookshop.counter', { x: 30.5, z: 9.5, w: 3, d: 1 }, 1.1),
    prop('kitchen.pantry', { x: 44.5, z: 9, w: 1.5, d: 2.5 }, 1.8),
    prop('garden.shed', { x: 48.5, z: 30.5, w: 2.5, d: 3 }, 2.4),
    prop('arcade.table1', { x: 26.5, z: 43.5, w: 2, d: 2 }, 0.8),
    prop('arcade.table2', { x: 35.5, z: 43.5, w: 2, d: 2 }, 0.8),
    // 会馆（只是外观：私宅不在这张图上）
    prop('residential.hall', { x: 0.2, z: 21, w: 1.4, d: 10 }, 4.5, 'building'),
    // 路灯
    prop('lamp.1', { x: 19.5, z: 18.5, w: 0.5, d: 0.5 }, 3),
    prop('lamp.2', { x: 44, z: 18.5, w: 0.5, d: 0.5 }, 3),
    prop('lamp.3', { x: 19.5, z: 35, w: 0.5, d: 0.5 }, 3),
    prop('lamp.4', { x: 44, z: 35, w: 0.5, d: 0.5 }, 3),
  ],
  zones: [teaHouse.zone, bookshop.zone, kitchen.zone, arcade.zone, { id: 'plaza', name: '灯下广场', rects: [PLAZA], indoor: false }, { id: 'garden', name: '后巷花园', rects: [GARDEN], indoor: false }, { id: 'residential', name: '灯巷会馆', rects: [RESIDENTIAL], indoor: false }],
  defaultZone: { id: 'road', name: '灯笼路', indoor: false },
  anchors: TOWN_ANCHORS,
  interactables: [
    boxObject('tea_house:table1', 'tea_table', '靠窗的茶桌', 7, 5, ['n', 's', 'e', 'w']),
    boxObject('tea_house:table2', 'tea_table', '里间的茶桌', 14, 5, ['n', 's', 'e', 'w']),
    { id: 'bookshop:shelf', kind: 'bookshelf', name: '镇上的藏书架', x: 28, z: 2.5, footprint: { x: 25, z: 2, w: 6, d: 1 }, useAnchors: [{ x: 26.25, z: 3.75 }, { x: 28.25, z: 3.75 }, { x: 30.25, z: 3.75 }], reach: 3.6 },
    { id: 'kitchen:stove1', kind: 'stove', name: '左边的灶台', x: 48, z: 2.75, footprint: { x: 47, z: 2, w: 2, d: 1.5 }, useAnchors: [{ x: 47.75, z: 4.25 }, { x: 48.75, z: 4.25 }] },
    { id: 'kitchen:stove2', kind: 'stove', name: '右边的灶台', x: 54, z: 2.75, footprint: { x: 53, z: 2, w: 2, d: 1.5 }, useAnchors: [{ x: 53.75, z: 4.25 }, { x: 54.75, z: 4.25 }] },
    boxObject('garden:planter1', 'planter', '门边的花箱', 52, 22, ['s', 'e', 'w']),
    boxObject('garden:planter2', 'planter', '墙角的花箱', 60, 32, ['n', 'w']),
    boxObject('garden:planter3', 'planter', '向阳的花箱', 56, 28, ['n', 's', 'e', 'w']),
  ],
  portals: [{ id: 'home', anchor: 'residential.door', toScene: 'home', toAnchor: 'door' }],
};

const HOME_INNER: Rect = { x: 1, z: 1, w: 8, d: 6 };
const t = WALL_FAR - WALL_NEAR;
const HOME: SceneSource = {
  id: 'home',
  name: '家',
  instanced: true,
  cell: 0.5,
  bounds: { x: 0, z: 0, w: 10, d: 8 },
  walk: [HOME_INNER],
  obstacles: [
    { x: 1 - WALL_FAR, z: 1 - WALL_FAR, w: 8 + 2 * WALL_FAR, d: t, kind: 'wall', h: 3, id: 'home.wall.n' },
    { x: 1 - WALL_FAR, z: 7 + WALL_NEAR, w: 8 + 2 * WALL_FAR, d: t, kind: 'wall', h: 3, id: 'home.wall.s' },
    { x: 1 - WALL_FAR, z: 1 - WALL_FAR, w: t, d: 6 + 2 * WALL_FAR, kind: 'wall', h: 3, id: 'home.wall.w' },
    { x: 9 + WALL_NEAR, z: 1 - WALL_FAR, w: t, d: 6 + 2 * WALL_FAR, kind: 'wall', h: 3, id: 'home.wall.e' },
  ],
  zones: [],
  defaultZone: { id: 'home', name: '家', indoor: true },
  anchors: [
    { id: 'door', x: 5.25, z: 6.25, facing: 0 },
    { id: 'centre', x: 5.25, z: 3.75, facing: Math.PI },
  ],
  interactables: [],
  portals: [{ id: 'exit', anchor: 'door', toScene: 'town', toAnchor: 'residential.door' }],
};

export const TOWN_MAP_SOURCE: MapSource = {
  mapVersion: 'town-p0.1',
  agentRadius: 0.3,
  speed: 2.4,
  interactDistance: 1.8,
  hearDistance: 9,
  scenes: [TOWN, HOME],
  aliases: {
    plaza: { scene: 'town', anchor: 'plaza' },
    tea_house: { scene: 'town', anchor: 'tea_house' },
    bookshop: { scene: 'town', anchor: 'bookshop' },
    kitchen: { scene: 'town', anchor: 'kitchen' },
    garden: { scene: 'town', anchor: 'garden' },
    arcade: { scene: 'town', anchor: 'arcade' },
    residential: { scene: 'town', anchor: 'residential' },
    // 旧版的两条住宅巷现在都是这一个公共住宅接入点
    street_east: { scene: 'town', anchor: 'residential' },
    street_west: { scene: 'town', anchor: 'residential' },
  },
  spawn: { scene: 'town', anchor: 'plaza' },
};

/** 场景和进出口的固定编号（业务代码引用它们，不到处写字符串）。 */
export const TOWN_SCENE = 'town';
export const HOME_SCENE = 'home';
export const HOME_PORTAL = 'home';
export const HOME_EXIT_PORTAL = 'exit';
