/**
 * 东京城市世界 · 标准街区内容包接口（对齐 docs/city/CONTENT-PACK-SPEC.md §4.1）。
 *
 * 纯只读数据契约：新增街区只需在 packs/ 下挂载一份符合本接口的标准包，
 * 零修改 ledger.ts / visits.ts / residents.ts 核心状态机。
 */
import type {
  AreaId,
  ItemType,
  Neighborhood,
  Place,
  SourceReference,
  StationComplex,
  TransitEdge,
} from '../catalog.js';

export type OpennessLevel = 'cataloged' | 'transitable' | 'livable';

export type TransportKind = 'rail' | 'subway' | 'monorail' | 'bus' | 'ferry' | 'airport_link';

export interface MunicipalitySpec {
  /** JIS X 0402 东京都 5 位团体码，如 'mun:13101'（千代田区）、'mun:13112'（世田谷区） */
  id: string;
  name: string;
  region: 'ward23' | 'tama' | 'islands';
  source: string;
}

export interface DistrictSpec {
  /** 标准四层街区 ID，如 'dist:jinbocho' */
  id: string;
  /** 兼容引擎 AreaId 的短别名，如 'jinbocho' */
  areaId: AreaId;
  name: string;
  /** 行政归属短名（展示用，如 '千代田区'） */
  ward: string;
  municipalityId: string;
  openness: OpennessLevel;
  hubStationId: string;
  weatherPoint: { lat: number; lon: number };
  blurb: string;
}

export type PackTransitEdge = TransitEdge & {
  operator: string;
  transportKind: TransportKind;
  /** 营业里程（km，精确到 0.1 km） */
  distanceKm?: number;
};

/** 开放车站大厅的一枚确定性纪念站章（駅スタンプ）。 */
export interface StationStampSpec {
  /** 全局唯一站章 ID，如 'stamp:jinbocho' */
  stampId: string;
  /** 绑定车站综合体 ID，如 'st:jinbocho' */
  stationId: string;
  /** 盖章台所在的车站大厅地点 ID，如 'jinbocho:station' */
  placeId: string;
  /** 站章题名 */
  title: string;
  /** 站章纹样意象说明 */
  motif: string;
  /** 印泥色调（CSS 十六进制色，仅用于印章视觉呈现） */
  inkColor: string;
  /** 几何徽记代号（供网页端绘制确定性 SVG 印面纹样） */
  emblem: 'bridge' | 'owl' | 'terrace' | 'books' | 'stage';
}

export interface CityContentPack {
  /** 内容包唯一标识，如 'pack:jinbocho' */
  packId: string;
  /** 内容包语义版本，任何地点/票价/商品价格变动必须递增 */
  version: string;
  /** 遵循的内容包规范版本 */
  specVersion: 1;
  municipality: MunicipalitySpec;
  district: DistrictSpec;
  stations: StationComplex[];
  transitEdges: PackTransitEdge[];
  neighborhoods: Neighborhood[];
  places: Place[];
  itemTypes?: ItemType[];
  stamps?: StationStampSpec[];
  jobs?: Record<string, unknown>[];
  recipes?: Record<string, unknown>[];
  explorations?: Record<string, unknown>[];
  communityProjects?: Record<string, unknown>[];
  sources: SourceReference[];
}

export const PACK_BASE_ACTIONS = ['say', 'travel', 'consume', 'give'] as const;
export const PACK_STATION_ACTIONS = [...PACK_BASE_ACTIONS, 'store_locker', 'take_locker', 'stamp_station'] as const;
