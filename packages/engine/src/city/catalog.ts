import { APPAREL_SHOP_PLACES, apparelWindowForPlace, shopApparelBySku } from './apparel-catalog.js';
import {
  MOUNTED_CONTENT_PACKS,
  validateContentPack,
  type CityContentPack,
  type DistrictSpec,
  type MunicipalitySpec,
  type OpennessLevel,
  type StationStampSpec,
  type TransportKind,
} from './packs/index.js';
/**
 * 东京城市世界的目录（第一期）：片区、车站、线路、街区、地点、商品、来源。
 *
 * 真实地理与线路骨架 + 明确标注为模拟的耗时和票价（规格 3.10）。店铺都是虚构的（source: fictional）；
 * 公园、广场、河岸是真实存在的公共空间，只用到「那里有这么个地方」这一层。
 *
 * 发布之后不原地改：动了地点、线路、耗时、票价或商品价格就换 CITY_CATALOG_VERSION（票价规则另有 FARE_RULE_VERSION）。
 * 这个模块是纯数据和纯函数：不读数据库、不取时间、不用随机数。
 *
 * 内部 ID 稳定（<片区>:<名字>）。小屋门口是不公开的节点：不进任何公开视图、地图或外部 bot 的视图，
 * 以后小屋做成城里的一栋建筑时，这个 ID 就是它的入口（规格 8.1）。
 */

export const CITY_WORLD_ID = 'tokyo';
export const CITY_WORLD_NAME = '东京';
export const CITY_CATALOG_VERSION = 'tokyo-p1.2';
export const FARE_RULE_VERSION = 'sim-2026-11';

/** 小屋门口：交接点（规格 3.1）。不公开。 */
export const HOUSE_ENTRANCE = 'akabane:ai-house:entrance';

export type { CityContentPack, DistrictSpec, MunicipalitySpec, OpennessLevel, StationStampSpec, TransportKind };
export { MOUNTED_CONTENT_PACKS };

export interface SourceReference {
  id: string;
  kind: 'operator' | 'public_space' | 'open_data' | 'fictional' | 'simulated';
  title: string;
  note: string;
  url?: string;
  /** 取值或核对的日期（YYYY-MM-DD） */
  retrieved?: string;
  /** 许可或使用条件（真实数据才有） */
  license?: string;
  /**
   * 对应《虚拟东京都建城资料源》表（Tokyo World Sourcebook，2026-11-17 版，不在仓库里）里的编号。
   * 只表示「这一项和那条资料源有关」，不表示已经导入了那份数据。
   */
  sourcebook?: readonly string[];
}

const BASE_SOURCES: readonly SourceReference[] = [
  {
    id: 'jreast-network',
    kind: 'operator',
    title: 'JR 东日本的线路（埼京线、湘南新宿线、山手线）',
    note: '赤羽、池袋、新宿三站之间有直达列车是公开的线路事实。这里只用「哪两站之间有车」，不用真实时刻表：JR 东日本在 ODPT 上的时刻资料是竞赛限定许可（到 2027-03-12），不作长期依赖；以后要铺开全网，站和线路的地理底座用国土数值信息 N02（CC BY 4.0）。第一期没有导入这两份数据。',
    url: 'https://www.jreast.co.jp/',
    retrieved: '2026-11-17',
    sourcebook: ['T01', 'T04'],
  },
  {
    id: 'sim-fares',
    kind: 'simulated',
    title: '模拟票价（按 JR 东日本 2026-03-14 运价改定后的幹線纸质车票运价档）',
    note: '改定后山手线内、电车特定区间并入幹線，营业里程不足 1 km 进位：4–6 km 档 ¥200，11–15 km 档 ¥260（2026-11-17 对照过运价表）。赤羽—池袋 5.5 km、池袋—新宿 4.8 km 在 4–6 km 档，赤羽—新宿 10.3 km 按 11 km 算在 11–15 km 档。数值和纸质车票的运价一致，但没有 IC 运价、换乘和折扣，也不随真实运价变动，所以仍然标注为 simulated。JR 东日本的官方网站这边读不到（拒绝访问），对照用的是 JR 集团运价表的转载页；公开的开放数据目录里没有 JR 东日本的独立票价集。',
    url: 'https://jr-group.jp/higashinihon-fare/',
    retrieved: '2026-11-17',
    sourcebook: ['T04'],
  },
  {
    id: 'sim-times',
    kind: 'simulated',
    title: '模拟耗时',
    note: '乘车耗时参考白天时段的大致行驶时间，再加几分钟候车；步行耗时是估计。不是真实时刻表，标注为 simulated。',
    retrieved: '2026-11-17',
  },
  {
    id: 'public-spaces',
    kind: 'public_space',
    title: '真实存在的公共空间',
    note: '赤羽站东口站前广场、荒川河岸（北区一侧的河川敷）、南池袋公园、新宿南口的露台步道。只借用地点本身，里面发生的事都是虚构的。',
    retrieved: '2026-11-17',
  },
  { id: 'fictional', kind: 'fictional', title: '虚构店铺', note: '店名、商品、价格、营业时间都是虚构的，不对应任何真实商家。' },
  {
    id: 'open-meteo',
    kind: 'open_data',
    title: 'Open-Meteo 天气数据',
    note: '当前和逐小时天气来自 Open-Meteo 的预报模型，不是街区实测。城市统一抓取（每 30 分钟一次请求，三个坐标），所有居民共用同一份快照。抓不到时先用最近一次快照，超过 3 小时退回合成天气并标注。',
    url: 'https://open-meteo.com/',
    license: '数据 CC BY 4.0；免费托管的接口只限非商业用途（每天少于 10,000 次调用），带订阅或广告的服务要用付费接口',
    sourcebook: ['L02'],
  },
];

function mergeUniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const it of items) {
    const k = keyOf(it);
    if (!seen.has(k)) seen.set(k, it);
  }
  return [...seen.values()];
}

export const SOURCES: readonly SourceReference[] = mergeUniqueBy(
  [...BASE_SOURCES, ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.sources)],
  (s) => s.id,
);

export type AreaId = 'akabane' | 'ikebukuro' | 'shinjuku' | 'jinbocho' | 'shimokitazawa';

export interface Area {
  id: AreaId;
  name: string;
  ward: string;
  blurb: string;
  /** 取天气用的代表点 */
  weatherPoint: { lat: number; lon: number };
  /** 四层地理标准字段（CONTENT-PACK-SPEC） */
  districtId?: string;
  municipalityId?: string;
  openness?: OpennessLevel;
  hubStationId?: string;
}

const BASE_MUNICIPALITIES: readonly MunicipalitySpec[] = [
  { id: 'mun:13117', name: '北区', region: 'ward23', source: 'public-spaces' },
  { id: 'mun:13116', name: '丰岛区', region: 'ward23', source: 'public-spaces' },
  { id: 'mun:13104', name: '新宿区', region: 'ward23', source: 'public-spaces' },
];

export const MUNICIPALITIES: readonly MunicipalitySpec[] = mergeUniqueBy(
  [...BASE_MUNICIPALITIES, ...MOUNTED_CONTENT_PACKS.map((p) => p.municipality)],
  (m) => m.id,
);

const BASE_AREAS: readonly Area[] = [
  {
    id: 'akabane',
    name: '赤羽',
    ward: '北区',
    blurb: '北区的老街区：站前热闹，往北走到荒川就开阔了。',
    weatherPoint: { lat: 35.7776, lon: 139.7209 },
    districtId: 'dist:akabane',
    municipalityId: 'mun:13117',
    openness: 'livable',
    hubStationId: 'st:akabane',
  },
  {
    id: 'ikebukuro',
    name: '池袋',
    ward: '丰岛区',
    blurb: '大车站、书店和喫茶店，巷子里还有一小片草坪。',
    weatherPoint: { lat: 35.7295, lon: 139.7109 },
    districtId: 'dist:ikebukuro',
    municipalityId: 'mun:13116',
    openness: 'livable',
    hubStationId: 'st:ikebukuro',
  },
  {
    id: 'shinjuku',
    name: '新宿',
    ward: '新宿区',
    blurb: '全东京人最多的车站，南口出去是一条能吹到风的露台步道。',
    weatherPoint: { lat: 35.6896, lon: 139.7006 },
    districtId: 'dist:shinjuku',
    municipalityId: 'mun:13104',
    openness: 'livable',
    hubStationId: 'st:shinjuku',
  },
];

export const AREAS: readonly Area[] = [
  ...BASE_AREAS,
  ...MOUNTED_CONTENT_PACKS.map((p) => ({
    id: p.district.areaId,
    name: p.district.name,
    ward: p.district.ward,
    blurb: p.district.blurb,
    weatherPoint: p.district.weatherPoint,
    districtId: p.district.id,
    municipalityId: p.district.municipalityId,
    openness: p.district.openness,
    hubStationId: p.district.hubStationId,
  })),
];

export interface StationStop {
  id: string;
  line: string;
  operator: string;
}

export interface StationComplex {
  id: string;
  name: string;
  area: AreaId;
  /** 车站本身也是一个地点（站内大厅） */
  placeId: string;
  stops: StationStop[];
}

const BASE_STATIONS: readonly StationComplex[] = [
  {
    id: 'st:akabane',
    name: '赤羽站',
    area: 'akabane',
    placeId: 'akabane:station',
    stops: [
      { id: 'st:akabane:saikyo', line: '埼京线', operator: 'JR 东日本' },
      { id: 'st:akabane:shonan-shinjuku', line: '湘南新宿线', operator: 'JR 东日本' },
    ],
  },
  {
    id: 'st:ikebukuro',
    name: '池袋站',
    area: 'ikebukuro',
    placeId: 'ikebukuro:station',
    stops: [
      { id: 'st:ikebukuro:saikyo', line: '埼京线', operator: 'JR 东日本' },
      { id: 'st:ikebukuro:yamanote', line: '山手线', operator: 'JR 东日本' },
    ],
  },
  {
    id: 'st:shinjuku',
    name: '新宿站',
    area: 'shinjuku',
    placeId: 'shinjuku:station',
    stops: [
      { id: 'st:shinjuku:saikyo', line: '埼京线', operator: 'JR 东日本' },
      { id: 'st:shinjuku:yamanote', line: '山手线', operator: 'JR 东日本' },
    ],
  },
];

export const STATIONS: readonly StationComplex[] = [
  ...BASE_STATIONS,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.stations),
];

/** 两站之间的一段车（无向）。minutes 含候车；fareYen 是这一段的票价。 */
export interface TransitEdge {
  id: string;
  a: string;
  b: string;
  line: string;
  minutes: number;
  fareYen: number;
  sources: string[];
  operator?: string;
  transportKind?: TransportKind;
  distanceKm?: number;
}

const BASE_TRANSIT_EDGES: readonly TransitEdge[] = [
  { id: 'te:akabane-ikebukuro', a: 'st:akabane', b: 'st:ikebukuro', line: '埼京线', operator: 'jreast', transportKind: 'rail', distanceKm: 5.5, minutes: 13, fareYen: 200, sources: ['jreast-network', 'sim-fares', 'sim-times'] },
  { id: 'te:akabane-shinjuku', a: 'st:akabane', b: 'st:shinjuku', line: '埼京线', operator: 'jreast', transportKind: 'rail', distanceKm: 10.3, minutes: 19, fareYen: 260, sources: ['jreast-network', 'sim-fares', 'sim-times'] },
  { id: 'te:ikebukuro-shinjuku', a: 'st:ikebukuro', b: 'st:shinjuku', line: '山手线', operator: 'jreast', transportKind: 'rail', distanceKm: 4.8, minutes: 10, fareYen: 200, sources: ['jreast-network', 'sim-fares', 'sim-times'] },
];

export const TRANSIT_EDGES: readonly TransitEdge[] = [
  ...BASE_TRANSIT_EDGES,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.transitEdges),
];

export interface Neighborhood {
  id: string;
  area: AreaId;
  name: string;
}

const BASE_NEIGHBORHOODS: readonly Neighborhood[] = [
  { id: 'akabane:ekimae', area: 'akabane', name: '赤羽站前' },
  { id: 'akabane:arakawa', area: 'akabane', name: '荒川河岸' },
  { id: 'akabane:residential', area: 'akabane', name: '赤羽一带的住宅区' },
  { id: 'ikebukuro:east', area: 'ikebukuro', name: '池袋东口' },
  { id: 'shinjuku:south', area: 'shinjuku', name: '新宿南口' },
];

export const NEIGHBORHOODS: readonly Neighborhood[] = [
  ...BASE_NEIGHBORHOODS,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.neighborhoods),
];

export type ItemKind = 'food' | 'drink' | 'thing';

export interface ItemType {
  type: string;
  name: string;
  kind: ItemKind;
  /** 是否可带回家或存入储物柜；未设默认 true，现点杯装热饮为 false */
  carry_home?: boolean;
}

const BASE_ITEM_TYPES: readonly ItemType[] = [
  { type: 'cookie', name: '曲奇', kind: 'food' },
  { type: 'onigiri', name: '饭团', kind: 'food' },
  { type: 'melon_pan', name: '菠萝包', kind: 'food' },
  { type: 'cream_bun', name: '奶油面包', kind: 'food' },
  { type: 'cheesecake', name: '芝士蛋糕', kind: 'food' },
  { type: 'coffee', name: '咖啡', kind: 'drink', carry_home: false },
  { type: 'milk_tea', name: '奶茶', kind: 'drink', carry_home: false },
  { type: 'green_tea', name: '瓶装绿茶', kind: 'drink' },
  { type: 'coffee_beans', name: '咖啡豆', kind: 'thing' },
  { type: 'umbrella', name: '透明雨伞', kind: 'thing' },
  { type: 'paperback', name: '文库本', kind: 'thing' },
  { type: 'postcard', name: '明信片', kind: 'thing' },
  { type: 'notebook', name: '笔记本', kind: 'thing' },
  { type: 'apparel_bundle', name: '服饰礼盒', kind: 'thing' },
];

export const ITEM_TYPES: readonly ItemType[] = [
  ...BASE_ITEM_TYPES,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.itemTypes ?? []),
];

const ITEM_BY_TYPE = new Map(ITEM_TYPES.map((i) => [i.type, i]));
export const itemType = (type: string): ItemType | undefined => ITEM_BY_TYPE.get(type);
export const itemName = (type: string): string => ITEM_BY_TYPE.get(type)?.name ?? type;
export const isCarryHome = (type: string): boolean => ITEM_BY_TYPE.get(type)?.carry_home !== false;
export const isStorable = (type: string): boolean => isCarryHome(type);

export interface Good {
  sku: string;
  /** 买到的物品类型 */
  type: string;
  name: string;
  priceYen: number;
  /** 服饰礼盒绑定的可信图鉴资产 ID（仅服务端目录持有） */
  assetId?: string;
  contentTier?: 'sfw' | 'intimate';
}

export type PlaceType = 'station' | 'cafe' | 'shop' | 'park' | 'plaza' | 'riverside' | 'promenade' | 'theatre' | 'entrance';
/** 雨天策略：none 不受影响；notice 照常开放但提示；closed 下雨时关闭（已经在里面的人不赶，只是不能再进） */
export type RainPolicy = 'none' | 'notice' | 'closed';

export interface Place {
  id: string;
  area: AreaId;
  neighborhood: string;
  name: string;
  type: PlaceType;
  indoor: boolean;
  /** 营业时间（世界时区的 HH:MM）；null = 全天。close 小于 open 表示跨过午夜 */
  hours: { open: string; close: string } | null;
  capacity: number;
  /** 最近的车站，和从车站走过来要几分钟（车站自己是 0） */
  station: string;
  walkMinutes: number;
  rain: RainPolicy;
  goods: Good[];
  /** 这里能做的动作（给视图看的提示；真正的判定在动作处理器里） */
  actions: string[];
  blurb: string;
  source: string;
  fictional: boolean;
  /** 不公开的节点：不进公开视图、现场视图的去处、外部 bot 的任何视图；外部 bot 走不到 */
  hidden?: boolean;
}

const BASE_ACTIONS = ['say', 'travel', 'consume', 'give'];
const STATION_ACTIONS = [...BASE_ACTIONS, 'store_locker', 'take_locker', 'stamp_station'];

const BASE_PLACES: readonly Place[] = [
  // ── 赤羽 ──
  {
    id: 'akabane:station',
    area: 'akabane',
    neighborhood: 'akabane:ekimae',
    name: '赤羽站',
    type: 'station',
    indoor: true,
    hours: null,
    capacity: 400,
    station: 'st:akabane',
    walkMinutes: 0,
    rain: 'none',
    goods: [],
    actions: STATION_ACTIONS,
    blurb: '检票口外的大厅，人来人往。',
    source: 'jreast-network',
    fictional: false,
  },
  {
    id: 'akabane:ekimae-plaza',
    area: 'akabane',
    neighborhood: 'akabane:ekimae',
    name: '赤羽站东口站前广场',
    type: 'plaza',
    indoor: false,
    hours: null,
    capacity: 80,
    station: 'st:akabane',
    walkMinutes: 2,
    rain: 'notice',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '等人的地方。长椅不多，傍晚最热闹。',
    source: 'public-spaces',
    fictional: false,
  },
  {
    id: 'akabane:ekimae-conbini',
    area: 'akabane',
    neighborhood: 'akabane:ekimae',
    name: '便利店「灯笼屋·赤羽站前」',
    type: 'shop',
    indoor: true,
    hours: null,
    capacity: 20,
    station: 'st:akabane',
    walkMinutes: 3,
    rain: 'none',
    goods: [
      { sku: 'umbrella', type: 'umbrella', name: '透明雨伞', priceYen: 550 },
      { sku: 'onigiri', type: 'onigiri', name: '饭团', priceYen: 160 },
      { sku: 'green_tea', type: 'green_tea', name: '瓶装绿茶', priceYen: 150 },
      { sku: 'cookie', type: 'cookie', name: '小袋曲奇', priceYen: 220 },
    ],
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '二十四小时开着。下雨天门口的伞架会空得很快。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'akabane:arakawa-riverbank',
    area: 'akabane',
    neighborhood: 'akabane:arakawa',
    name: '荒川河岸',
    type: 'riverside',
    indoor: false,
    hours: null,
    capacity: 120,
    station: 'st:akabane',
    walkMinutes: 18,
    rain: 'closed',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '河堤上的步道，天晴的傍晚能看到很远的桥。下雨时堤上很滑，不开放。',
    source: 'public-spaces',
    fictional: false,
  },
  {
    id: HOUSE_ENTRANCE,
    area: 'akabane',
    neighborhood: 'akabane:residential',
    name: '小屋门口',
    type: 'entrance',
    indoor: false,
    hours: null,
    capacity: 12,
    station: 'st:akabane',
    walkMinutes: 12,
    rain: 'none',
    goods: [],
    actions: [],
    blurb: '',
    source: 'fictional',
    fictional: true,
    hidden: true,
  },
  // ── 池袋 ──
  {
    id: 'ikebukuro:station',
    area: 'ikebukuro',
    neighborhood: 'ikebukuro:east',
    name: '池袋站',
    type: 'station',
    indoor: true,
    hours: null,
    capacity: 500,
    station: 'st:ikebukuro',
    walkMinutes: 0,
    rain: 'none',
    goods: [],
    actions: STATION_ACTIONS,
    blurb: '东口的检票口外，头顶是百货店的连廊。',
    source: 'jreast-network',
    fictional: false,
  },
  {
    id: 'ikebukuro:kissa-tomoshibi',
    area: 'ikebukuro',
    neighborhood: 'ikebukuro:east',
    name: '喫茶「灯」',
    type: 'cafe',
    indoor: true,
    hours: { open: '08:00', close: '21:00' },
    capacity: 16,
    station: 'st:ikebukuro',
    walkMinutes: 6,
    rain: 'none',
    goods: [
      { sku: 'coffee', type: 'coffee', name: '混合咖啡', priceYen: 450 },
      { sku: 'milk_tea', type: 'milk_tea', name: '皇家奶茶', priceYen: 500 },
      { sku: 'cheesecake', type: 'cheesecake', name: '烤芝士蛋糕', priceYen: 520 },
      { sku: 'coffee_beans', type: 'coffee_beans', name: '店里的咖啡豆（100 克）', priceYen: 900 },
    ],
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '一楼只有吧台和四张小桌，墙上挂着一盏老煤油灯。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'ikebukuro:shiorido',
    area: 'ikebukuro',
    neighborhood: 'ikebukuro:east',
    name: '书店「栞堂」',
    type: 'shop',
    indoor: true,
    hours: { open: '10:00', close: '21:00' },
    capacity: 30,
    station: 'st:ikebukuro',
    walkMinutes: 5,
    rain: 'none',
    goods: [
      { sku: 'paperback', type: 'paperback', name: '文库本', priceYen: 800 },
      { sku: 'postcard', type: 'postcard', name: '明信片', priceYen: 150 },
    ],
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '两层的小书店，楼梯转角摆着店员手写的推荐卡。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'ikebukuro:suzuran-closet',
    area: 'ikebukuro',
    neighborhood: 'ikebukuro:east',
    name: '服饰店「铃兰衣橱」',
    type: 'shop',
    indoor: true,
    hours: { open: '10:00', close: '21:00' },
    capacity: 24,
    station: 'st:ikebukuro',
    walkMinutes: 5,
    rain: 'none',
    goods: apparelWindowForPlace('ikebukuro:suzuran-closet', '2026-11-18').map((e) => ({
      sku: e.sku,
      type: 'apparel_bundle',
      name: e.name,
      priceYen: e.priceYen,
      assetId: e.assetId,
      contentTier: e.tier,
    })),
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '挂满当季针织衫、百褶裙与通勤外套的街角衣橱，木衣架按色系排得很整齐。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'ikebukuro:minami-park',
    area: 'ikebukuro',
    neighborhood: 'ikebukuro:east',
    name: '南池袋公园',
    type: 'park',
    indoor: false,
    hours: null,
    capacity: 100,
    station: 'st:ikebukuro',
    walkMinutes: 7,
    rain: 'notice',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '楼群中间的一片草坪，天好的时候坐满了人。',
    source: 'public-spaces',
    fictional: false,
  },
  // ── 新宿 ──
  {
    id: 'shinjuku:station',
    area: 'shinjuku',
    neighborhood: 'shinjuku:south',
    name: '新宿站',
    type: 'station',
    indoor: true,
    hours: null,
    capacity: 600,
    station: 'st:shinjuku',
    walkMinutes: 0,
    rain: 'none',
    goods: [],
    actions: STATION_ACTIONS,
    blurb: '南口的检票口外。第一次来的人多半要在这里找一会儿方向。',
    source: 'jreast-network',
    fictional: false,
  },
  {
    id: 'shinjuku:southern-terrace',
    area: 'shinjuku',
    neighborhood: 'shinjuku:south',
    name: '新宿南口露台步道',
    type: 'promenade',
    indoor: false,
    hours: null,
    capacity: 120,
    station: 'st:shinjuku',
    walkMinutes: 4,
    rain: 'notice',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '架在铁轨上方的步道，能看见电车一列一列地进站。',
    source: 'public-spaces',
    fictional: false,
  },
  {
    id: 'shinjuku:muginohi',
    area: 'shinjuku',
    neighborhood: 'shinjuku:south',
    name: '面包店「麦之灯」',
    type: 'shop',
    indoor: true,
    hours: { open: '08:00', close: '20:00' },
    capacity: 18,
    station: 'st:shinjuku',
    walkMinutes: 5,
    rain: 'none',
    goods: [
      { sku: 'melon_pan', type: 'melon_pan', name: '菠萝包', priceYen: 230 },
      { sku: 'cream_bun', type: 'cream_bun', name: '奶油面包', priceYen: 260 },
      { sku: 'cookie', type: 'cookie', name: '手工曲奇', priceYen: 280 },
    ],
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '出炉的时间写在门口的小黑板上。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'shinjuku:kamitsuki',
    area: 'shinjuku',
    neighborhood: 'shinjuku:south',
    name: '文具店「纸月」',
    type: 'shop',
    indoor: true,
    hours: { open: '10:00', close: '20:00' },
    capacity: 20,
    station: 'st:shinjuku',
    walkMinutes: 6,
    rain: 'none',
    goods: [
      { sku: 'notebook', type: 'notebook', name: '线装笔记本', priceYen: 600 },
      { sku: 'postcard', type: 'postcard', name: '明信片', priceYen: 150 },
    ],
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '试写台上放着几十种墨水，纸是随便用的。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'shinjuku:lumiere-atelier',
    area: 'shinjuku',
    neighborhood: 'shinjuku:south',
    name: '买手店「光廊成衣」',
    type: 'shop',
    indoor: true,
    hours: { open: '11:00', close: '21:00' },
    capacity: 22,
    station: 'st:shinjuku',
    walkMinutes: 6,
    rain: 'none',
    goods: apparelWindowForPlace('shinjuku:lumiere-atelier', '2026-11-18').map((e) => ({
      sku: e.sku,
      type: 'apparel_bundle',
      name: e.name,
      priceYen: e.priceYen,
      assetId: e.assetId,
      contentTier: e.tier,
    })),
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '落地玻璃橱窗里陈列着都会连衣裙、派对礼服与度假泳装，试衣镜旁点着暖光灯。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'shinjuku:velours-intime',
    area: 'shinjuku',
    neighborhood: 'shinjuku:south',
    name: '私密精品店「丝绒私语」',
    type: 'shop',
    indoor: true,
    hours: { open: '12:00', close: '22:00' },
    capacity: 14,
    station: 'st:shinjuku',
    walkMinutes: 7,
    rain: 'none',
    goods: apparelWindowForPlace('shinjuku:velours-intime', '2026-11-18').map((e) => ({
      sku: e.sku,
      type: 'apparel_bundle',
      name: e.name,
      priceYen: e.priceYen,
      assetId: e.assetId,
      contentTier: e.tier,
    })),
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '深色丝绒帘幕后的安静买手店，所有贴身内衣与私密礼服都装在无字缎带礼盒里交付。',
    source: 'fictional',
    fictional: true,
  },
];

export const PLACES: readonly Place[] = [
  ...BASE_PLACES,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.places),
];

const BASE_STAMPS: readonly StationStampSpec[] = [
  {
    stampId: 'stamp:akabane',
    stationId: 'st:akabane',
    placeId: 'akabane:station',
    title: '赤羽站 · 荒川铁桥与晚霞',
    motif: '跨越荒川河堤的桁架铁桥与归巢水鸟',
    inkColor: '#b91c1c',
    emblem: 'bridge',
  },
  {
    stampId: 'stamp:ikebukuro',
    stationId: 'st:ikebukuro',
    placeId: 'ikebukuro:station',
    title: '池袋站 · 木雕猫头鹰与书灯',
    motif: '东口相聚的猫头鹰像与喫茶煤油灯',
    inkColor: '#1d4ed8',
    emblem: 'owl',
  },
  {
    stampId: 'stamp:shinjuku',
    stationId: 'st:shinjuku',
    placeId: 'shinjuku:station',
    title: '新宿站 · 南口跨线露台与钟塔',
    motif: '并列进站的轨道线群与南口步道灯柱',
    inkColor: '#15803d',
    emblem: 'terrace',
  },
];

export const STATION_STAMPS: readonly StationStampSpec[] = [
  ...BASE_STAMPS,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.stamps ?? []),
];

/** 不经过车站的步行近路（无向）。小屋在赤羽站和荒川之间，去河岸不用绕回站前。 */
export const WALK_SHORTCUTS: readonly { a: string; b: string; minutes: number }[] = [{ a: HOUSE_ENTRANCE, b: 'akabane:arakawa-riverbank', minutes: 9 }];

const PLACE_BY_ID = new Map(PLACES.map((p) => [p.id, p]));
const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));
const AREA_BY_ID = new Map(AREAS.map((a) => [a.id, a]));
const STAMP_BY_STATION = new Map(STATION_STAMPS.map((s) => [s.stationId, s]));
const STAMP_BY_PLACE = new Map(STATION_STAMPS.map((s) => [s.placeId, s]));

export const place = (id: string): Place | undefined => PLACE_BY_ID.get(id);
export const station = (id: string): StationComplex | undefined => STATION_BY_ID.get(id);
export const area = (id: string): Area | undefined => AREA_BY_ID.get(id as AreaId);
export const stationStamp = (stationId: string): StationStampSpec | undefined => STAMP_BY_STATION.get(stationId);
export const stationStampAtPlace = (placeId: string): StationStampSpec | undefined => STAMP_BY_PLACE.get(placeId);
/** 公开的地点（外部 bot 能去、能看到的）。 */
export const publicPlace = (id: string): Place | undefined => {
  const p = PLACE_BY_ID.get(id);
  return p && !p.hidden ? p : undefined;
};
export const publicPlaces = (): Place[] => PLACES.filter((p) => !p.hidden);

// ───────────────────────── 行程规划（纯函数） ─────────────────────────

export interface LegPlan {
  mode: 'walk' | 'train';
  /** 这一段从哪个地点到哪个地点（车站用它的地点 ID） */
  from: string;
  to: string;
  line?: string;
  minutes: number;
  fareYen: number;
}

export interface RoutePlan {
  from: string;
  to: string;
  legs: LegPlan[];
  minutes: number;
  fareYen: number;
}

/** 两站之间最省时间的换乘（Dijkstra；第一期三站两两直达，结果就是一段）。到不了返回 null。 */
function trainPath(fromStation: string, toStation: string): TransitEdge[] | null {
  if (fromStation === toStation) return [];
  const dist = new Map<string, number>([[fromStation, 0]]);
  const prev = new Map<string, { edge: TransitEdge; from: string }>();
  const done = new Set<string>();
  for (;;) {
    let cur: string | null = null;
    for (const [id, d] of dist) if (!done.has(id) && (cur === null || d < dist.get(cur)!)) cur = id;
    if (cur === null) return null;
    if (cur === toStation) break;
    done.add(cur);
    for (const e of TRANSIT_EDGES) {
      const next = e.a === cur ? e.b : e.b === cur ? e.a : null;
      if (next === null || done.has(next)) continue;
      const d = dist.get(cur)! + e.minutes;
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d);
        prev.set(next, { edge: e, from: cur });
      }
    }
  }
  const out: TransitEdge[] = [];
  for (let at = toStation; at !== fromStation; ) {
    const p = prev.get(at)!;
    out.unshift(p.edge);
    at = p.from;
  }
  return out;
}

/**
 * 从一个地点到另一个地点怎么走：步行到车站 → 乘车 → 步行到目的地。同一个车站周边的两个地点直接步行。
 * 这里不判断营业、容量、公开与否（那是调用方的事），只算路。到不了或地点不存在返回 null。
 */
export function planRoute(fromId: string, toId: string): RoutePlan | null {
  const from = PLACE_BY_ID.get(fromId);
  const to = PLACE_BY_ID.get(toId);
  if (!from || !to || fromId === toId) return null;
  const legs: LegPlan[] = [];
  const shortcut = WALK_SHORTCUTS.find((s) => (s.a === fromId && s.b === toId) || (s.b === fromId && s.a === toId));
  if (shortcut) {
    legs.push({ mode: 'walk', from: fromId, to: toId, minutes: shortcut.minutes, fareYen: 0 });
  } else if (from.station === to.station) {
    legs.push({ mode: 'walk', from: fromId, to: toId, minutes: Math.max(1, from.walkMinutes + to.walkMinutes), fareYen: 0 });
  } else {
    const sa = STATION_BY_ID.get(from.station)!;
    const sb = STATION_BY_ID.get(to.station)!;
    const edges = trainPath(sa.id, sb.id);
    if (!edges) return null;
    if (from.walkMinutes > 0) legs.push({ mode: 'walk', from: fromId, to: sa.placeId, minutes: from.walkMinutes, fareYen: 0 });
    let at = sa.id;
    for (const e of edges) {
      const next = e.a === at ? e.b : e.a;
      legs.push({ mode: 'train', from: STATION_BY_ID.get(at)!.placeId, to: STATION_BY_ID.get(next)!.placeId, line: e.line, minutes: e.minutes, fareYen: e.fareYen });
      at = next;
    }
    if (to.walkMinutes > 0) legs.push({ mode: 'walk', from: sb.placeId, to: toId, minutes: to.walkMinutes, fareYen: 0 });
  }
  return { from: fromId, to: toId, legs, minutes: legs.reduce((n, l) => n + l.minutes, 0), fareYen: legs.reduce((n, l) => n + l.fareYen, 0) };
}

/** 从某个地点回小屋门口要多少车费（回程预留额）和多久。已经在门口是 0。 */
export function homeward(fromId: string): { fareYen: number; minutes: number } {
  if (fromId === HOUSE_ENTRANCE) return { fareYen: 0, minutes: 0 };
  const r = planRoute(fromId, HOUSE_ENTRANCE);
  return r ? { fareYen: r.fareYen, minutes: r.minutes } : { fareYen: 0, minutes: 0 };
}

/** 营业时间判断：minuteOfDay 是世界时区里这一刻是当天第几分钟。 */
export function openAt(p: Place, minuteOfDay: number): boolean {
  if (!p.hours) return true;
  const toMin = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const o = toMin(p.hours.open);
  const c = toMin(p.hours.close);
  return o <= c ? minuteOfDay >= o && minuteOfDay < c : minuteOfDay >= o || minuteOfDay < c;
}

/** 目录自检：启动时跑一次，写错了直接拒绝启动（比运行中走到坏数据再报错好查）。返回问题列表。 */
export function validateCatalog(): string[] {
  const problems: string[] = [];
  for (const pack of MOUNTED_CONTENT_PACKS) {
    problems.push(...validateContentPack(pack));
  }
  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${what}编号重复：${id}`);
      seen.add(id);
    }
  };
  dup(AREAS.map((a) => a.id), '片区');
  dup(AREAS.map((a) => a.districtId ?? a.id), '四层街区');
  dup(MOUNTED_CONTENT_PACKS.map((p) => p.packId), '内容包');
  dup(STATIONS.map((s) => s.id), '车站');
  dup(PLACES.map((p) => p.id), '地点');
  dup(TRANSIT_EDGES.map((e) => e.id), '线路段');
  dup(ITEM_TYPES.map((i) => i.type), '物品类型');
  dup(STATION_STAMPS.map((s) => s.stampId), '车站印章');
  dup(STATION_STAMPS.map((s) => s.stationId), '车站印章所属车站');
  dup(STATION_STAMPS.map((s) => s.placeId), '车站印章所属地点');
  const sourceIds = new Set(SOURCES.map((s) => s.id));
  const munIds = new Set(MUNICIPALITIES.map((m) => m.id));
  for (const m of MUNICIPALITIES) {
    if (!sourceIds.has(m.source)) problems.push(`自治体 ${m.id} 的来源 ${m.source} 不存在`);
  }
  for (const a of AREAS) {
    if (a.municipalityId && !munIds.has(a.municipalityId)) problems.push(`片区 ${a.id} 的自治体 ${a.municipalityId} 不存在`);
    if (a.hubStationId && !STATION_BY_ID.has(a.hubStationId)) problems.push(`片区 ${a.id} 的主车站 ${a.hubStationId} 不存在`);
  }
  for (const s of STATIONS) {
    if (!AREA_BY_ID.has(s.area)) problems.push(`车站 ${s.id} 的片区不存在`);
    const p = PLACE_BY_ID.get(s.placeId);
    if (!p || p.type !== 'station' || p.station !== s.id || p.walkMinutes !== 0) problems.push(`车站 ${s.id} 的地点 ${s.placeId} 不对`);
    const a = AREA_BY_ID.get(s.area);
    if (a?.openness !== 'cataloged' && !STAMP_BY_STATION.has(s.id)) {
      problems.push(`开放车站 ${s.id} 缺少唯一站章配置`);
    }
  }
  for (const st of STATION_STAMPS) {
    const s = STATION_BY_ID.get(st.stationId);
    if (!s || s.placeId !== st.placeId) problems.push(`站章 ${st.stampId} 绑定的车站/地点不匹配`);
  }
  for (const e of TRANSIT_EDGES) {
    if (!STATION_BY_ID.has(e.a) || !STATION_BY_ID.has(e.b)) problems.push(`线路段 ${e.id} 的车站不存在`);
    if (!Number.isInteger(e.fareYen) || e.fareYen < 0 || !Number.isInteger(e.minutes) || e.minutes <= 0) problems.push(`线路段 ${e.id} 的耗时或票价不对`);
    for (const s of e.sources) if (!sourceIds.has(s)) problems.push(`线路段 ${e.id} 的来源 ${s} 不存在`);
  }
  for (const p of PLACES) {
    if (!AREA_BY_ID.has(p.area)) problems.push(`地点 ${p.id} 的片区不存在`);
    if (!NEIGHBORHOODS.some((n) => n.id === p.neighborhood && n.area === p.area)) problems.push(`地点 ${p.id} 的街区不存在`);
    if (!STATION_BY_ID.has(p.station)) problems.push(`地点 ${p.id} 的车站不存在`);
    if (!sourceIds.has(p.source)) problems.push(`地点 ${p.id} 的来源不存在`);
    if (p.hours && !(/^\d\d:\d\d$/.test(p.hours.open) && /^\d\d:\d\d$/.test(p.hours.close))) problems.push(`地点 ${p.id} 的营业时间格式不对`);
    dup(p.goods.map((g) => g.sku), `地点 ${p.id} 的商品`);
    for (const g of p.goods) {
      if (!ITEM_BY_TYPE.has(g.type)) problems.push(`地点 ${p.id} 的商品 ${g.sku} 的物品类型不存在`);
      if (!Number.isInteger(g.priceYen) || g.priceYen <= 0) problems.push(`地点 ${p.id} 的商品 ${g.sku} 价格不是正整数日元`);
    }
    if (p.id !== HOUSE_ENTRANCE && !planRoute(p.id, HOUSE_ENTRANCE)) problems.push(`地点 ${p.id} 回不了小屋门口`);
  }
  if (!PLACE_BY_ID.get(HOUSE_ENTRANCE)?.hidden) problems.push('小屋门口必须是不公开的节点');
  return problems;
}


/** 按东京世界日返回地点当前陈列商品（服饰买手店按日确定性轮换 6 款橱窗）。 */
export function goodsForPlace(p: Place, dateStr?: string): readonly Good[] {
  if (p.id in APPAREL_SHOP_PLACES) {
    return apparelWindowForPlace(p.id, dateStr ?? '2026-11-18').map((e) => ({
      sku: e.sku,
      type: 'apparel_bundle',
      name: e.name,
      priceYen: e.priceYen,
      assetId: e.assetId,
      contentTier: e.tier,
    }));
  }
  return p.goods;
}

/** 查找地点可售或历史已下单商品（allowOffWindow=true 供跨日未决订单结算查找全池）。 */
export function findGoodAtPlace(placeId: string, sku: string, dateStr?: string, allowOffWindow = false): Good | undefined {
  const p = place(placeId);
  if (!p) return undefined;
  const active = goodsForPlace(p, dateStr).find((g) => g.sku === sku);
  if (active) return active;
  if (allowOffWindow && placeId in APPAREL_SHOP_PLACES) {
    const hit = shopApparelBySku(placeId, sku);
    if (hit) {
      return {
        sku: hit.sku,
        type: 'apparel_bundle',
        name: hit.name,
        priceYen: hit.priceYen,
        assetId: hit.assetId,
        contentTier: hit.tier,
      };
    }
  }
  return undefined;
}
