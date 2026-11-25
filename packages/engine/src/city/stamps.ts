/**
 * 车站印章帐（駅スタンプ帳）：
 *  - 每个开放车站大厅配置一枚确定性唯一站章（catalog.ts 的 STATION_STAMPS）；
 *  - 居民站在车站大厅时执行 stamp_station 记入个人站章帐（resident_stamps 表），
 *    同站重复盖章幂等（保留首次盖章时间、不报错、绝不重复占随身背包或储物柜物品上限）；
 *  - selfView 仅附带精炼已集章数摘要（collected / total / here_stamped），
 *    完整印章帐明细通过 world_query(what="stamps") 或 GET /city/api/stamps 按需查询。
 */
import type { Row } from '../core/sqlite.js';
import {
  CITY_CATALOG_VERSION,
  FARE_RULE_VERSION,
  MOUNTED_CONTENT_PACKS,
  PLACES,
  STATIONS,
  STATION_STAMPS,
  area,
  station,
  stationStampAtPlace,
  type StationStampSpec,
} from './catalog.js';
import { cityPrecondition } from './errors.js';
import type { CityResident, CityService } from './service.js';

export interface StampSummary {
  collected: number;
  total: number;
  here_stamped?: boolean;
}

export interface StampBookEntry {
  stamp_id: string;
  station_id: string;
  station_name: string;
  place_id: string;
  area: string;
  area_name: string;
  title: string;
  motif: string;
  ink_color: string;
  emblem: StationStampSpec['emblem'];
  collected: boolean;
  stamped_at_ms: number | null;
}

export interface StampBookView {
  collected: number;
  total: number;
  stamps: StampBookEntry[];
}

/** 启动恢复时记录当前生效的目录版本摘要（CONTENT-PACK-SPEC §4.2.3）。 */
export function recordCatalogActivation(c: CityService, at: number): void {
  const summary = {
    packs: MOUNTED_CONTENT_PACKS.map((p) => ({ pack_id: p.packId, version: p.version, district_id: p.district.id })),
    stations: STATIONS.length,
    places: PLACES.filter((p) => !p.hidden).length,
    stamps: STATION_STAMPS.length,
  };
  c.db.run(
    `INSERT INTO catalog_versions(catalog_version, fare_rule_version, summary_json, activated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(catalog_version) DO NOTHING`,
    CITY_CATALOG_VERSION,
    FARE_RULE_VERSION,
    JSON.stringify(summary),
    at,
  );
}

/** 给 selfView 用的超精炼摘要（约 45~65 字节，严守 <= 4 KB 预算）。 */
export function stampSummary(c: CityService, residentId: string, currentPlaceId: string | null): StampSummary {
  const collected = c.db.scalar('SELECT COUNT(*) FROM resident_stamps WHERE resident_id = ?', residentId);
  const hereSpec = currentPlaceId ? stationStampAtPlace(currentPlaceId) : undefined;
  if (!hereSpec) {
    return { collected, total: STATION_STAMPS.length };
  }
  const hit = c.db.get('SELECT 1 AS x FROM resident_stamps WHERE resident_id = ? AND station_id = ?', residentId, hereSpec.stationId);
  return {
    collected,
    total: STATION_STAMPS.length,
    here_stamped: Boolean(hit),
  };
}

/** 按需读取这位居民的完整站章帐明细（仅含本人盖章记录与公开站章目录，零他人信息）。 */
export function stampBookView(c: CityService, residentId: string): StampBookView {
  const rows = c.db.all<Row>(
    'SELECT station_id, stamped_at FROM resident_stamps WHERE resident_id = ?',
    residentId,
  );
  const byStation = new Map<string, number>();
  for (const row of rows) {
    byStation.set(String(row.station_id), Number(row.stamped_at));
  }
  const stamps: StampBookEntry[] = STATION_STAMPS.map((spec) => {
    const st = station(spec.stationId);
    const a = st ? area(st.area) : undefined;
    const stampedAt = byStation.get(spec.stationId) ?? null;
    return {
      stamp_id: spec.stampId,
      station_id: spec.stationId,
      station_name: st?.name ?? spec.stationId,
      place_id: spec.placeId,
      area: st?.area ?? '',
      area_name: a?.name ?? st?.area ?? '',
      title: spec.title,
      motif: spec.motif,
      ink_color: spec.inkColor,
      emblem: spec.emblem,
      collected: stampedAt !== null,
      stamped_at_ms: stampedAt,
    };
  });
  return {
    collected: stamps.filter((s) => s.collected).length,
    total: stamps.length,
    stamps,
  };
}

/** 在当前车站大厅加盖纪念章（同站重复调用幂等，不重复入库、不占背包）。必须在事务内调用。 */
export function stampAtStation(
  c: CityService,
  r: CityResident,
  placeId: string,
  at: number,
  visitId: string | null,
): Record<string, unknown> {
  const spec = stationStampAtPlace(placeId);
  if (!spec) {
    throw cityPrecondition('这里没有车站印章台，请先前往开放车站的大厅。', 'not_at_stamp_desk');
  }
  const st = station(spec.stationId);
  const existing = c.db.get<{ stamped_at: number }>(
    'SELECT stamped_at FROM resident_stamps WHERE resident_id = ? AND station_id = ?',
    r.resident_id,
    spec.stationId,
  );
  let newlyStamped = false;
  let stampedAt = existing ? Number(existing.stamped_at) : at;
  if (!existing) {
    c.db.run(
      'INSERT INTO resident_stamps(resident_id, station_id, stamp_id, place_id, stamped_at, visit_id) VALUES (?,?,?,?,?,?)',
      r.resident_id,
      spec.stationId,
      spec.stampId,
      placeId,
      at,
      visitId,
    );
    newlyStamped = true;
    stampedAt = at;
    c.emitTo(
      [r.resident_id],
      'station_stamped',
      {
        stamp_id: spec.stampId,
        station_id: spec.stationId,
        station_name: st?.name ?? spec.stationId,
        title: spec.title,
      },
      at,
    );
  }
  const summary = stampSummary(c, r.resident_id, placeId);
  return {
    status: 'completed',
    newly_stamped: newlyStamped,
    stamp: {
      stamp_id: spec.stampId,
      station_id: spec.stationId,
      station_name: st?.name ?? spec.stationId,
      place_id: spec.placeId,
      title: spec.title,
      motif: spec.motif,
      ink_color: spec.inkColor,
      emblem: spec.emblem,
      stamped_at_ms: stampedAt,
    },
    stamp_book: summary,
  };
}
