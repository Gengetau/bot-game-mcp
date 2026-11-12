/**
 * 空间权威的数据类型（设计稿 v2.0 第 12、13 章）。
 *
 * 坐标单位是米：x 向东，z 向南，和 Godot 的 x / z 一致；高度 y 只是画面的事，服务器不管。
 * 服务器的位置永远是「场景 + 实例 + x + z」。画面是三维的，判定是平面的。
 *
 * 这个目录里的模块都是纯函数：不读数据库、不取时间、不用随机数，方便单测，也方便以后搬到 worker 里。
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** 轴对齐矩形：(x, z) 是西北角，w 沿 x，d 沿 z。 */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

// ───────────────────────── 地图源（人写的那一份） ─────────────────────────

/** 区域：一片有名字的可行走范围。公共地点沿用旧地点编号（plaza、tea_house …），旧 location_id 现在就是区域编号。 */
export interface ZoneSource {
  id: string;
  name: string;
  rects: Rect[];
  indoor: boolean;
  /** 房间（声学）：同一个 room 才互相听得见。缺省等于 id */
  room?: string;
}

/** 命名点：出生点、地点的落脚点、进出口。必须落在可行走格子上（编译时检查）。 */
export interface AnchorSource {
  id: string;
  x: number;
  z: number;
  /** 站定后的朝向（弧度，0 = 朝北即 -z，顺时针为正）。只给画面用 */
  facing?: number;
}

export type ObstacleKind = 'wall' | 'building' | 'prop' | 'water' | 'fence';

/** 挡路的东西。编译时按角色半径向外扩一圈再栅格化。 */
export interface ObstacleSource extends Rect {
  kind: ObstacleKind;
  /** 画面用的高度（米）；服务器不看 */
  h?: number;
  id?: string;
}

/** 可以互动的物件。位置和「站在哪里用它」都在地图里，服务器按距离判定够不够得着。 */
export interface InteractableSource {
  id: string;
  kind: string;
  name: string;
  x: number;
  z: number;
  /** 占地（会变成障碍）；没有就不挡路 */
  footprint?: Rect;
  /** 站在哪里用它。navigate 到物件时走到离自己最近、走得到的一个。至少一个，必须可行走 */
  useAnchors: Vec2[];
  /** 离物件中心多远算够得着（米）。缺省用地图的 interactDistance */
  reach?: number;
}

/** 进出口：站在 anchor 附近才能去另一个场景（比如公共住宅接入点 → 私宅实例）。权限由业务规则另查。 */
export interface PortalSource {
  id: string;
  /** 本场景里的锚点编号 */
  anchor: string;
  toScene: string;
  /** 目标场景里的锚点编号 */
  toAnchor: string;
}

export interface SceneSource {
  id: string;
  name: string;
  /** 私有实例场景（住宅）：每个实例各有一份人和物，坐标相同不代表在一起 */
  instanced: boolean;
  /** 网格边长（米） */
  cell: number;
  /** 场景范围。四个数都必须是 cell 的整数倍 */
  bounds: Rect;
  /** 可以走的范围（并集）。必须对齐网格、落在 bounds 里 */
  walk: Rect[];
  obstacles: ObstacleSource[];
  zones: ZoneSource[];
  /** 不在任何 zone 里的可行走格子算哪个区域（比如「街上」） */
  defaultZone: { id: string; name: string; indoor: boolean };
  anchors: AnchorSource[];
  interactables: InteractableSource[];
  portals: PortalSource[];
}

export interface MapSource {
  /** 地图版本。发布之后不能原地改：改了可走范围、锚点或物件位置就要换版本号 */
  mapVersion: string;
  /** 角色半径（米）：障碍按它外扩 */
  agentRadius: number;
  /** 行走速度（米 / 秒）。全图统一，用时 = 路程 / 速度 */
  speed: number;
  /** 够得着物件、能当面互动的默认距离（米） */
  interactDistance: number;
  /** 听得见附近说话的距离（米） */
  hearDistance: number;
  scenes: SceneSource[];
  /** 目的地别名：旧地点编号和常用说法 → 场景里的锚点。navigate {to:'tea_house'} 走到这里 */
  aliases: Record<string, { scene: string; anchor: string }>;
  /** 新居民、没有合法位置的人落在哪里 */
  spawn: { scene: string; anchor: string };
}

// ───────────────────────── 编译后的地图（程序用的那一份） ─────────────────────────

export interface CompiledZone {
  id: string;
  name: string;
  indoor: boolean;
  room: string;
}

export interface CompiledScene {
  id: string;
  name: string;
  instanced: boolean;
  cell: number;
  /** 网格原点（西北角）和大小 */
  originX: number;
  originZ: number;
  cols: number;
  rows: number;
  /** cols × rows，行优先（index = row * cols + col）。1 = 角色中心可以待在这一格 */
  walkable: Uint8Array;
  /** 每格属于 zones 的第几个；0 号永远是 defaultZone */
  zoneOf: Uint8Array;
  zones: CompiledZone[];
  anchors: ReadonlyMap<string, AnchorSource>;
  interactables: ReadonlyMap<string, InteractableSource>;
  portals: ReadonlyMap<string, PortalSource>;
  source: SceneSource;
}

export interface CompiledMap {
  mapVersion: string;
  /** 地图源规范化 JSON 的 SHA-256（十六进制）。客户端和服务器拿它确认用的是同一份地图 */
  checksum: string;
  agentRadius: number;
  speed: number;
  interactDistance: number;
  hearDistance: number;
  scenes: ReadonlyMap<string, CompiledScene>;
  aliases: Readonly<Record<string, { scene: string; anchor: string }>>;
  spawn: { scene: string; anchor: string };
  source: MapSource;
}

/**
 * 发给客户端的地图清单：地图源 + 每个场景栅格化之后的可行走网格。
 * 客户端不自己栅格化，直接用这份网格画灰盒、做路线预览，所以两边不会对同一堵墙有不同看法。
 */
export interface MapManifest {
  protocol: 1;
  mapVersion: string;
  checksum: string;
  source: MapSource;
  grids: Record<
    string,
    {
      cols: number;
      rows: number;
      /** 每行一个字符串，'.' 可走，'#' 不可走，长度 = cols */
      rows_ascii: string[];
      /** 每行一个字符串，字符是区域下标（0-9a-z），长度 = cols；不可走的格子也有区域 */
      zones_ascii: string[];
      zones: CompiledZone[];
    }
  >;
}

// ───────────────────────── 路径与运动 ─────────────────────────

export interface PathResult {
  /** 折线：第一个点是精确起点，最后一个点是精确终点。至少两个点（原地不动时两个点重合） */
  points: Vec2[];
  /** 折线总长（米） */
  length: number;
}

/**
 * 一段已经被服务器接受的移动。位置不存每帧坐标，永远用 positionAt(motion, 时刻) 现算。
 * 时间都是 UTC 毫秒。
 */
export interface Motion {
  points: Vec2[];
  /** 米 / 秒 */
  speed: number;
  startedAt: number;
  /**
   * 最晚走到什么时刻（导航控制租约的截止时间）。过了这一刻人停在那里不再前进；
   * 就算到期任务晚处理，也不能多走一段。缺省表示不截断。
   */
  until?: number;
}

export interface MotionSample {
  x: number;
  z: number;
  /** 行进方向（弧度，0 = 朝北即 -z，顺时针为正）；原地不动时沿用上一段，最初为 0 */
  heading: number;
  /** 已经走过的路程（米） */
  travelled: number;
  /** 已经走到终点 */
  arrived: boolean;
  /** 被 until 截住了（没到终点，但不再前进） */
  halted: boolean;
}

export interface ZoneCrossing {
  /** 跨进新区域的时刻（UTC 毫秒，向上取整到毫秒） */
  at: number;
  /** 新区域编号 */
  zone: string;
  x: number;
  z: number;
}
