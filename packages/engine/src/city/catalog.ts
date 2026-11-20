import { APPAREL_SHOP_PLACES, apparelWindowForPlace, shopApparelBySku } from './apparel-catalog.js';
import {
  MOUNTED_CONTENT_PACKS,
  validateContentPack,
  type CityContentPack,
  type DistrictSpec,
  type OpennessLevel,
  type PackPrototypeSpec,
  type StationStampSpec,
  type TransportKind,
  type WardSpec,
} from './packs/index.js';
/**
 * 晴空都城市世界的目录：片区、车站、线路、街区、地点、商品、来源。
 *
 * 架空都市拓扑与线路骨架 + 明确标注为模拟的耗时和票价。店铺都是虚构的（source: fictional）；
 * 公园、广场、河岸与露台为都市公共空间原型，天气取现实气象代表点坐标。
 *
 * 发布之后不原地改：动了地点、线路、耗时、票价或商品价格就换 CITY_CATALOG_VERSION（票价规则另有 FARE_RULE_VERSION）。
 * 这个模块是纯数据和纯函数：不读数据库、不取时间、不用随机数。
 *
 * 内部 ID 稳定（<片区>:<名字>）。小屋门口是不公开的节点：不进任何公开视图、地图或外部 bot 的视图，
 * 以后小屋做成城里的一栋建筑时，这个 ID 就是它的入口（规格 8.1）。
 */

export const CITY_WORLD_ID = 'city';
export const CITY_WORLD_NAME = '晴空都';
export const CITY_CATALOG_VERSION = 'toto-p2.0';
export const CITY_TEXT_VERSION = 'toto-text-1.1';
export const FARE_RULE_VERSION = 'sim-2026-11';

export const BOOK_SHELF_BUYBACK_YEN = 300;
export const BOOK_SHELF_RESALE_YEN = 350;
export const MAX_FLYLEAF_ENTRIES = 5;
export const MAX_FLYLEAF_NOTE_CHARS = 50;

/** 小屋门口：交接点（规格 3.1）。不公开。 */
export const HOUSE_ENTRANCE = 'hiwatari:ai-house:entrance';

export type { CityContentPack, DistrictSpec, OpennessLevel, PackPrototypeSpec, StationStampSpec, TransportKind, WardSpec };
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
  sourcebook?: readonly string[];
}

const BASE_SOURCES: readonly SourceReference[] = [
  {
    id: 'prototype-network',
    kind: 'operator',
    title: '晴空都铁道干线骨架（北环快线、晴环线）',
    note: '日和坂、棱光街、云港三站之间的干线直达连接采用现实大都市铁道拓扑原型映射，仅刻画站间连通关系，不依赖外部实时时刻表。',
    retrieved: '2026-11-17',
    sourcebook: ['T01', 'T04'],
  },
  {
    id: 'sim-fares',
    kind: 'simulated',
    title: '模拟票价（按晴空都铁道干线营业里程分段运价档）',
    note: '按干线营业里程不足 1 km 进位模拟计价：4–6 km 档 ¥200，11–15 km 档 ¥260。日和坂—棱光街 5.5 km、棱光街—云港 4.8 km 计入 4–6 km 档（¥200），日和坂—云港 10.3 km 进位按 11 km 计入 11–15 km 档（¥260）。不设 IC 运价、换乘优惠或浮动调价，标注为 simulated。',
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
    id: 'sim-hours',
    kind: 'simulated',
    title: '模拟铁道首末班运营时间窗',
    note: '统一采用纯确定性的模拟首末班运营时间窗（首班 05:00、末班 00:20 JST），按每段铁道的计划上车时刻（board_at_ms）判定是否在运营窗内（如 04:56 先步行到站、05:00 准点上车获准通行；00:19 出发但 00:23 才到站上车前置拦截），不依赖有许可期限的 ODPT 实时时刻表，标注为 simulated。',
    retrieved: '2026-11-18',
  },
  {
    id: 'prototype-spaces',
    kind: 'public_space',
    title: '都市公共空间原型',
    note: '日和坂站东口站前广场、浮光川河岸、南棱光公园、云港南口露台步道等都市公共空间原型；空间内发生的事件与互动均为架空模拟。',
    retrieved: '2026-11-17',
  },
  { id: 'fictional', kind: 'fictional', title: '虚构店铺', note: '店名、商品、价格、营业时间都是虚构的，不对应任何真实商家。' },
  {
    id: 'open-meteo',
    kind: 'open_data',
    title: 'Open-Meteo 天气数据',
    note: '当前和逐小时天气来自 Open-Meteo 的预报模型，不是街区实测。晴空都统一按各片区代表坐标抓取（每 30 分钟一次请求），全城各片区共用同一份天气快照。抓不到时先沿用最近一次快照，超过 3 小时退回合成天气并标注。',
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

export type AreaId = 'hiwatari' | 'kagamiike' | 'sentou';

export interface Area {
  id: AreaId;
  name: string;
  ward?: string;
  blurb: string;
  /** 取天气用的代表点 */
  weatherPoint: { lat: number; lon: number };
  /** 四层地理标准字段（CONTENT-PACK-SPEC） */
  districtId?: string;
  wardId?: string;
  openness?: OpennessLevel;
  hubStationId?: string;
}

export const WARDS: readonly WardSpec[] = mergeUniqueBy(
  MOUNTED_CONTENT_PACKS.flatMap((p) => (p.ward ? [p.ward] : [])),
  (w) => w.id,
);

const BASE_AREAS: readonly Area[] = [
  {
    id: 'hiwatari',
    name: '日和坂',
    blurb: '靠北的坡道住宅区：坡两边是住家、小店和澡堂，站前热闹，往北走到浮光川就开阔了。',
    weatherPoint: { lat: 35.7776, lon: 139.7209 },
    districtId: 'dist:hiwatari',
    openness: 'livable',
    hubStationId: 'st:hiwatari',
  },
  {
    id: 'kagamiike',
    name: '棱光街',
    blurb: '商场外墙会随天色变色，逛街的人最多；大车站、书店和喫茶店，巷子里还有一小片草坪。',
    weatherPoint: { lat: 35.7295, lon: 139.7109 },
    districtId: 'dist:kagamiike',
    openness: 'livable',
    hubStationId: 'st:kagamiike',
  },
  {
    id: 'sentou',
    name: '云港',
    blurb: '城市的空中港口，高楼顶上停着飞艇，入夜最热闹；全晴空都人最多的车站，南口出去是一条能吹到风的露台步道。',
    weatherPoint: { lat: 35.6896, lon: 139.7006 },
    districtId: 'dist:sentou',
    openness: 'livable',
    hubStationId: 'st:sentou',
  },
];

export const AREAS: readonly Area[] = [
  ...BASE_AREAS,
  ...MOUNTED_CONTENT_PACKS.map((p) => ({
    id: p.district.areaId,
    name: p.district.name,
    ...(p.district.ward ? { ward: p.district.ward } : {}),
    blurb: p.district.blurb,
    weatherPoint: p.district.weatherPoint,
    districtId: p.district.id,
    ...(p.district.wardId ? { wardId: p.district.wardId } : {}),
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
    id: 'st:hiwatari',
    name: '日和坂站',
    area: 'hiwatari',
    placeId: 'hiwatari:station',
    stops: [
      { id: 'st:hiwatari:hokkan', line: '北环快线', operator: '晴空都铁道' },
    ],
  },
  {
    id: 'st:kagamiike',
    name: '棱光街站',
    area: 'kagamiike',
    placeId: 'kagamiike:station',
    stops: [
      { id: 'st:kagamiike:hokkan', line: '北环快线', operator: '晴空都铁道' },
      { id: 'st:kagamiike:toukan', line: '晴环线', operator: '晴空都铁道' },
    ],
  },
  {
    id: 'st:sentou',
    name: '云港站',
    area: 'sentou',
    placeId: 'sentou:station',
    stops: [
      { id: 'st:sentou:hokkan', line: '北环快线', operator: '晴空都铁道' },
      { id: 'st:sentou:toukan', line: '晴环线', operator: '晴空都铁道' },
    ],
  },
];

export const STATIONS: readonly StationComplex[] = [
  ...BASE_STATIONS,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.stations),
];

/** 两站之间的一段车（无向）。minutes 含候车；fareYen 是这一段的票价。 */
export interface TransitHours {
  /** 首班发车时刻（世界时区 HH:MM，含） */
  first: string;
  /** 末班截止时刻（世界时区 HH:MM，不含；last < first 表示跨午夜） */
  last: string;
}

export const TRANSIT_DEFAULT_HOURS: TransitHours = { first: '05:00', last: '00:20' };

export interface TransitEdge {
  id: string;
  a: string;
  b: string;
  line: string;
  minutes: number;
  fareYen: number;
  hours: TransitHours;
  sources: string[];
  operator?: string;
  transportKind?: TransportKind;
  distanceKm?: number;
}

const BASE_TRANSIT_EDGES: readonly TransitEdge[] = [
  { id: 'te:hiwatari-kagamiike', a: 'st:hiwatari', b: 'st:kagamiike', line: '北环快线', operator: 'toto-rail', transportKind: 'rail', distanceKm: 5.5, minutes: 13, fareYen: 200, hours: TRANSIT_DEFAULT_HOURS, sources: ['prototype-network', 'sim-fares', 'sim-times', 'sim-hours'] },
  { id: 'te:hiwatari-sentou', a: 'st:hiwatari', b: 'st:sentou', line: '北环快线', operator: 'toto-rail', transportKind: 'rail', distanceKm: 10.3, minutes: 19, fareYen: 260, hours: TRANSIT_DEFAULT_HOURS, sources: ['prototype-network', 'sim-fares', 'sim-times', 'sim-hours'] },
  { id: 'te:kagamiike-sentou', a: 'st:kagamiike', b: 'st:sentou', line: '晴环线', operator: 'toto-rail', transportKind: 'rail', distanceKm: 4.8, minutes: 10, fareYen: 200, hours: TRANSIT_DEFAULT_HOURS, sources: ['prototype-network', 'sim-fares', 'sim-times', 'sim-hours'] },
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
  { id: 'hiwatari:ekimae', area: 'hiwatari', name: '日和坂站前' },
  { id: 'hiwatari:mio', area: 'hiwatari', name: '浮光川河岸' },
  { id: 'hiwatari:residential', area: 'hiwatari', name: '日和坂一带的住宅区' },
  { id: 'kagamiike:east', area: 'kagamiike', name: '棱光街东口' },
  { id: 'sentou:south', area: 'sentou', name: '云港南口' },
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
  { type: 'egg_sandwich', name: '厚烧鸡蛋三明治', kind: 'food' },
  { type: 'oden_cup', name: '热关东煮', kind: 'food' },
  { type: 'melon_pan', name: '菠萝包', kind: 'food' },
  { type: 'cream_bun', name: '奶油面包', kind: 'food' },
  { type: 'cheesecake', name: '芝士蛋糕', kind: 'food' },
  { type: 'coffee', name: '咖啡', kind: 'drink', carry_home: false },
  { type: 'milk_tea', name: '奶茶', kind: 'drink', carry_home: false },
  { type: 'green_tea', name: '瓶装绿茶', kind: 'drink' },
  { type: 'roasted_tea', name: '焙茶', kind: 'drink' },
  { type: 'hot_corn_soup', name: '热玉米浓汤', kind: 'drink' },
  { type: 'hot_red_bean_soup', name: '热红豆汤', kind: 'drink' },
  { type: 'salted_lychee', name: '盐味荔枝饮', kind: 'drink' },
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
  /** 折扣前原价（如「麦之灯」19:30 后余量八折） */
  originalPriceYen?: number;
  /** 折扣标签 */
  discountLabel?: string;
  /** 服饰礼盒绑定的可信图鉴资产 ID（仅服务端目录持有） */
  assetId?: string;
  contentTier?: 'sfw' | 'intimate';
}

export interface CatalogTimeContext {
  /** 世界业务日期 YYYY-MM-DD */
  dateStr?: string;
  /** 世界时区月份 1..12 */
  jstMonth?: number;
  /** 当天第几分钟 0..1439 */
  minuteOfDay?: number;
}

const CONBINI_GOODS: Good[] = [
  { sku: 'umbrella', type: 'umbrella', name: '透明雨伞', priceYen: 550 },
  { sku: 'onigiri', type: 'onigiri', name: '饭团', priceYen: 160 },
  { sku: 'egg_sandwich', type: 'egg_sandwich', name: '厚烧鸡蛋三明治', priceYen: 290 },
  { sku: 'oden_cup', type: 'oden_cup', name: '热关东煮', priceYen: 360 },
  { sku: 'green_tea', type: 'green_tea', name: '瓶装绿茶', priceYen: 150 },
  { sku: 'cookie', type: 'cookie', name: '小袋曲奇', priceYen: 220 },
];

const VENDING_WINTER_GOODS: readonly Good[] = [
  { sku: 'hot_corn_soup', type: 'hot_corn_soup', name: '热玉米浓汤', priceYen: 160 },
  { sku: 'hot_red_bean_soup', type: 'hot_red_bean_soup', name: '热红豆汤', priceYen: 160 },
  { sku: 'green_tea', type: 'green_tea', name: '瓶装绿茶', priceYen: 150 },
];

const VENDING_SUMMER_GOODS: readonly Good[] = [
  { sku: 'salted_lychee', type: 'salted_lychee', name: '盐味荔枝饮', priceYen: 160 },
  { sku: 'green_tea', type: 'green_tea', name: '瓶装绿茶', priceYen: 150 },
];

const VENDING_MILD_GOODS: readonly Good[] = [
  { sku: 'green_tea', type: 'green_tea', name: '瓶装绿茶', priceYen: 150 },
  { sku: 'roasted_tea', type: 'roasted_tea', name: '焙茶', priceYen: 150 },
];

const ALL_VENDING_GOODS: readonly Good[] = [
  ...VENDING_WINTER_GOODS,
  ...VENDING_SUMMER_GOODS,
  ...VENDING_MILD_GOODS,
];

/** 24h 自动售货机纯函数冬夏轮换：冬季（11–3 月）热玉米浓汤/红豆汤，夏季（6–9 月）盐味荔枝饮，其余春秋常驻茶饮。 */
export function vendingGoodsForMonth(jstMonth: number): readonly Good[] {
  if (jstMonth >= 11 || jstMonth <= 3) return VENDING_WINTER_GOODS;
  if (jstMonth >= 6 && jstMonth <= 9) return VENDING_SUMMER_GOODS;
  return VENDING_MILD_GOODS;
}

/** 19:30 后「麦之灯」晚间余量八折判断（纯函数）。 */
export function isMuginohiEveningDiscount(minuteOfDay?: number): boolean {
  return minuteOfDay !== undefined && minuteOfDay >= 19 * 60 + 30;
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

const BASE_ACTIONS = ['say', 'travel', 'consume', 'give', 'read_item', 'inspect_item'];
const STATION_ACTIONS = [...BASE_ACTIONS, 'buy', 'store_locker', 'take_locker', 'drift_book', 'take_book', 'stamp_station'];

const BASE_PLACES: readonly Place[] = [
  // ── 日和坂 ──
  {
    id: 'hiwatari:station',
    area: 'hiwatari',
    neighborhood: 'hiwatari:ekimae',
    name: '日和坂站',
    type: 'station',
    indoor: true,
    hours: null,
    capacity: 400,
    station: 'st:hiwatari',
    walkMinutes: 0,
    rain: 'none',
    goods: [],
    actions: STATION_ACTIONS,
    blurb: '检票口外的大厅，人来人往，角落摆着 24 小时自动售货机、投币储物柜和漂流书角。',
    source: 'prototype-network',
    fictional: false,
  },
  {
    id: 'hiwatari:ekimae-plaza',
    area: 'hiwatari',
    neighborhood: 'hiwatari:ekimae',
    name: '日和坂站东口站前广场',
    type: 'plaza',
    indoor: false,
    hours: null,
    capacity: 80,
    station: 'st:hiwatari',
    walkMinutes: 2,
    rain: 'notice',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '等人的地方。长椅不多，傍晚最热闹。',
    source: 'prototype-spaces',
    fictional: false,
  },
  {
    id: 'hiwatari:ekimae-conbini',
    area: 'hiwatari',
    neighborhood: 'hiwatari:ekimae',
    name: '便利店「灯笼屋·日和坂站前」',
    type: 'shop',
    indoor: true,
    hours: null,
    capacity: 20,
    station: 'st:hiwatari',
    walkMinutes: 3,
    rain: 'none',
    goods: CONBINI_GOODS,
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '二十四小时开着，提供透明雨伞与夜间歇脚简餐。下雨天门口的伞架会空得很快。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'hiwatari:mio-riverbank',
    area: 'hiwatari',
    neighborhood: 'hiwatari:mio',
    name: '浮光川河岸',
    type: 'riverside',
    indoor: false,
    hours: null,
    capacity: 120,
    station: 'st:hiwatari',
    walkMinutes: 18,
    rain: 'closed',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '河堤上的步道，天晴的傍晚能看到很远的桥。下雨时堤上很滑，不开放。',
    source: 'prototype-spaces',
    fictional: false,
  },
  {
    id: HOUSE_ENTRANCE,
    area: 'hiwatari',
    neighborhood: 'hiwatari:residential',
    name: '小屋门口',
    type: 'entrance',
    indoor: false,
    hours: null,
    capacity: 12,
    station: 'st:hiwatari',
    walkMinutes: 12,
    rain: 'none',
    goods: [],
    actions: [],
    blurb: '',
    source: 'fictional',
    fictional: true,
    hidden: true,
  },
  // ── 棱光街 ──
  {
    id: 'kagamiike:station',
    area: 'kagamiike',
    neighborhood: 'kagamiike:east',
    name: '棱光街站',
    type: 'station',
    indoor: true,
    hours: null,
    capacity: 500,
    station: 'st:kagamiike',
    walkMinutes: 0,
    rain: 'none',
    goods: [],
    actions: STATION_ACTIONS,
    blurb: '东口的检票口外，头顶是百货店的连廊，角落设 24 小时自动售货机、投币储物柜与漂流书角。',
    source: 'prototype-network',
    fictional: false,
  },
  {
    id: 'kagamiike:kissa-tomoshibi',
    area: 'kagamiike',
    neighborhood: 'kagamiike:east',
    name: '喫茶「灯」',
    type: 'cafe',
    indoor: true,
    hours: { open: '08:00', close: '21:00' },
    capacity: 16,
    station: 'st:kagamiike',
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
    id: 'kagamiike:shiorido',
    area: 'kagamiike',
    neighborhood: 'kagamiike:east',
    name: '书店「栞堂」',
    type: 'shop',
    indoor: true,
    hours: { open: '10:00', close: '21:00' },
    capacity: 30,
    station: 'st:kagamiike',
    walkMinutes: 5,
    rain: 'none',
    goods: [
      { sku: 'paperback', type: 'paperback', name: '文库本', priceYen: 800 },
      { sku: 'postcard', type: 'postcard', name: '明信片', priceYen: 150 },
    ],
    actions: [...BASE_ACTIONS, 'buy', 'drift_book', 'take_book'],
    blurb: '两层的小书店，楼梯转角摆着店员手写的推荐卡，一角还设着古书二手架。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'kagamiike:ekimae-conbini',
    area: 'kagamiike',
    neighborhood: 'kagamiike:east',
    name: '便利店「灯笼屋·棱光街东口」',
    type: 'shop',
    indoor: true,
    hours: null,
    capacity: 20,
    station: 'st:kagamiike',
    walkMinutes: 3,
    rain: 'none',
    goods: CONBINI_GOODS,
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '二十四小时亮着灯的街角便利店，深夜也能买到透明雨伞与热简餐。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'kagamiike:suzuran-closet',
    area: 'kagamiike',
    neighborhood: 'kagamiike:east',
    name: '服饰店「铃兰衣橱」',
    type: 'shop',
    indoor: true,
    hours: { open: '10:00', close: '21:00' },
    capacity: 24,
    station: 'st:kagamiike',
    walkMinutes: 5,
    rain: 'none',
    goods: apparelWindowForPlace('kagamiike:suzuran-closet', '2026-11-18').map((e) => ({
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
    id: 'kagamiike:minami-park',
    area: 'kagamiike',
    neighborhood: 'kagamiike:east',
    name: '南棱光公园',
    type: 'park',
    indoor: false,
    hours: null,
    capacity: 100,
    station: 'st:kagamiike',
    walkMinutes: 7,
    rain: 'notice',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '楼群中间的一片草坪，天好的时候坐满了人。',
    source: 'prototype-spaces',
    fictional: false,
  },
  // ── 云港 ──
  {
    id: 'sentou:station',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '云港站',
    type: 'station',
    indoor: true,
    hours: null,
    capacity: 600,
    station: 'st:sentou',
    walkMinutes: 0,
    rain: 'none',
    goods: [],
    actions: STATION_ACTIONS,
    blurb: '南口的检票口外，立着 24 小时自动售货机、投币储物柜与漂流书角。',
    source: 'prototype-network',
    fictional: false,
  },
  {
    id: 'sentou:south-conbini',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '便利店「灯笼屋·云港南口」',
    type: 'shop',
    indoor: true,
    hours: null,
    capacity: 20,
    station: 'st:sentou',
    walkMinutes: 3,
    rain: 'none',
    goods: CONBINI_GOODS,
    actions: [...BASE_ACTIONS, 'buy'],
    blurb: '二十四小时开着，备有 ¥550 透明雨伞与晚归歇脚简餐。',
    source: 'fictional',
    fictional: true,
  },
  {
    id: 'sentou:southern-terrace',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '云港南口露台步道',
    type: 'promenade',
    indoor: false,
    hours: null,
    capacity: 120,
    station: 'st:sentou',
    walkMinutes: 4,
    rain: 'notice',
    goods: [],
    actions: BASE_ACTIONS,
    blurb: '架在铁轨上方的步道，能看见电车一列一列地进站。',
    source: 'prototype-spaces',
    fictional: false,
  },
  {
    id: 'sentou:muginohi',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '面包店「麦之灯」',
    type: 'shop',
    indoor: true,
    hours: { open: '08:00', close: '20:00' },
    capacity: 18,
    station: 'st:sentou',
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
    id: 'sentou:kamitsuki',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '文具店「纸月」',
    type: 'shop',
    indoor: true,
    hours: { open: '10:00', close: '20:00' },
    capacity: 20,
    station: 'st:sentou',
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
    id: 'sentou:lumiere-atelier',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '买手店「光廊成衣」',
    type: 'shop',
    indoor: true,
    hours: { open: '11:00', close: '21:00' },
    capacity: 22,
    station: 'st:sentou',
    walkMinutes: 6,
    rain: 'none',
    goods: apparelWindowForPlace('sentou:lumiere-atelier', '2026-11-18').map((e) => ({
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
    id: 'sentou:velours-intime',
    area: 'sentou',
    neighborhood: 'sentou:south',
    name: '私密精品店「丝绒私语」',
    type: 'shop',
    indoor: true,
    hours: { open: '12:00', close: '22:00' },
    capacity: 14,
    station: 'st:sentou',
    walkMinutes: 7,
    rain: 'none',
    goods: apparelWindowForPlace('sentou:velours-intime', '2026-11-18').map((e) => ({
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
    stampId: 'stamp:hiwatari',
    stationId: 'st:hiwatari',
    placeId: 'hiwatari:station',
    title: '日和坂站 · 浮光川铁桥与晚霞',
    motif: '跨越浮光川河堤的桁架铁桥与归巢水鸟',
    inkColor: '#b91c1c',
    emblem: 'bridge',
  },
  {
    stampId: 'stamp:kagamiike',
    stationId: 'st:kagamiike',
    placeId: 'kagamiike:station',
    title: '棱光街站 · 木雕猫头鹰与书灯',
    motif: '东口相聚的猫头鹰像与喫茶煤油灯',
    inkColor: '#1d4ed8',
    emblem: 'owl',
  },
  {
    stampId: 'stamp:sentou',
    stationId: 'st:sentou',
    placeId: 'sentou:station',
    title: '云港站 · 南口跨线露台与钟塔',
    motif: '并列进站的轨道线群与南口步道灯柱',
    inkColor: '#15803d',
    emblem: 'terrace',
  },
];

export const STATION_STAMPS: readonly StationStampSpec[] = [
  ...BASE_STAMPS,
  ...MOUNTED_CONTENT_PACKS.flatMap((p) => p.stamps ?? []),
];

/** 不经过车站的步行近路（无向）。小屋在日和坂站和浮光川之间，去河岸不用绕回站前。 */
export const WALK_SHORTCUTS: readonly { a: string; b: string; minutes: number }[] = [{ a: HOUSE_ENTRANCE, b: 'hiwatari:mio-riverbank', minutes: 9 }];

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
export function clockMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export function openAt(p: Place, minuteOfDay: number): boolean {
  if (!p.hours) return true;
  const o = clockMinutes(p.hours.open);
  const c = clockMinutes(p.hours.close);
  return o <= c ? minuteOfDay >= o && minuteOfDay < c : minuteOfDay >= o || minuteOfDay < c;
}

/** 铁道运营时间窗判断：first <= last 为日内区间 [first, last)，first > last 为跨午夜区间 [first, 24:00) ∪ [00:00, last)。 */
export function transitHoursOpenAt(hours: TransitHours, minuteOfDay: number): boolean {
  const f = clockMinutes(hours.first);
  const l = clockMinutes(hours.last);
  return f <= l ? minuteOfDay >= f && minuteOfDay < l : minuteOfDay >= f || minuteOfDay < l;
}

/** 按两端的车站编号或车站地点编号查找直连铁道边。 */
export function transitEdgeBetween(fromPlaceOrStation: string, toPlaceOrStation: string): TransitEdge | undefined {
  const sa = STATION_BY_ID.get(fromPlaceOrStation)?.id ?? PLACE_BY_ID.get(fromPlaceOrStation)?.station;
  const sb = STATION_BY_ID.get(toPlaceOrStation)?.id ?? PLACE_BY_ID.get(toPlaceOrStation)?.station;
  if (!sa || !sb || sa === sb) return undefined;
  return TRANSIT_EDGES.find((e) => (e.a === sa && e.b === sb) || (e.a === sb && e.b === sa));
}

/** 判断一段铁道在某个本地分钟是否处于运营时间窗内。 */
export function transitEdgeOpenAt(
  fromPlaceOrStation: string,
  toPlaceOrStation: string,
  minuteOfDay: number,
): { open: boolean; edge?: TransitEdge; hours: TransitHours } {
  const edge = transitEdgeBetween(fromPlaceOrStation, toPlaceOrStation);
  const hours = edge?.hours ?? TRANSIT_DEFAULT_HOURS;
  return { open: transitHoursOpenAt(hours, minuteOfDay), ...(edge ? { edge } : {}), hours };
}

function validClock(hhmm: string): boolean {
  if (!/^\d\d:\d\d$/.test(hhmm)) return false;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));
  return h >= 0 && h < 24 && m >= 0 && m < 60;
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
  const wardIds = new Set(WARDS.map((w) => w.id));
  for (const w of WARDS) {
    if (!sourceIds.has(w.source)) problems.push(`架空区 ${w.id} 的来源 ${w.source} 不存在`);
  }
  for (const a of AREAS) {
    if (a.wardId && !wardIds.has(a.wardId)) problems.push(`片区 ${a.id} 的架空区 ${a.wardId} 不存在`);
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
    if (!e.hours || !validClock(e.hours.first) || !validClock(e.hours.last) || e.hours.first === e.hours.last) {
      problems.push(`线路段 ${e.id} 的首末班时间格式不对`);
    }
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
  for (const g of ALL_VENDING_GOODS) {
    if (!ITEM_BY_TYPE.has(g.type)) problems.push(`售货机商品 ${g.sku} 的物品类型不存在`);
    if (!Number.isInteger(g.priceYen) || g.priceYen <= 0) problems.push(`售货机商品 ${g.sku} 价格不是正整数日元`);
  }
  if (!PLACE_BY_ID.get(HOUSE_ENTRANCE)?.hidden) problems.push('小屋门口必须是不公开的节点');
  return problems;
}

function normalizeCatalogTime(ctx?: string | CatalogTimeContext): Required<CatalogTimeContext> {
  if (typeof ctx === 'string') {
    const m = Number(ctx.slice(5, 7));
    return { dateStr: ctx, jstMonth: Number.isInteger(m) && m >= 1 && m <= 12 ? m : 11, minuteOfDay: 10 * 60 };
  }
  const dateStr = ctx?.dateStr ?? '2026-11-18';
  const parsedMonth = Number(dateStr.slice(5, 7));
  const jstMonth = ctx?.jstMonth ?? (Number.isInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : 11);
  const minuteOfDay = ctx?.minuteOfDay ?? 10 * 60;
  return { dateStr, jstMonth, minuteOfDay };
}

/** 按晴空都世界日与时段返回地点当前陈列商品（纯函数，无随机与外部状态）。 */
export function goodsForPlace(p: Place, ctx?: string | CatalogTimeContext): readonly Good[] {
  const t = normalizeCatalogTime(ctx);
  if (p.id in APPAREL_SHOP_PLACES) {
    return apparelWindowForPlace(p.id, t.dateStr).map((e) => ({
      sku: e.sku,
      type: 'apparel_bundle',
      name: e.name,
      priceYen: e.priceYen,
      assetId: e.assetId,
      contentTier: e.tier,
    }));
  }
  if (p.type === 'station') {
    return vendingGoodsForMonth(t.jstMonth);
  }
  if (p.id === 'sentou:muginohi' && isMuginohiEveningDiscount(t.minuteOfDay)) {
    return p.goods.map((g) => ({
      ...g,
      priceYen: Math.floor((g.priceYen * 8) / 10),
      originalPriceYen: g.priceYen,
      discountLabel: '晚间八折',
    }));
  }
  return p.goods;
}

/** 查找地点可售或历史已下单商品（allowOffWindow=true 供跨日未决订单结算查找全池）。 */
export function findGoodAtPlace(placeId: string, sku: string, ctx?: string | CatalogTimeContext, allowOffWindow = false): Good | undefined {
  const p = place(placeId);
  if (!p) return undefined;
  const active = goodsForPlace(p, ctx).find((g) => g.sku === sku);
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
  if (allowOffWindow && p.type === 'station') {
    return ALL_VENDING_GOODS.find((g) => g.sku === sku);
  }
  if (allowOffWindow) {
    return p.goods.find((g) => g.sku === sku);
  }
  return undefined;
}
