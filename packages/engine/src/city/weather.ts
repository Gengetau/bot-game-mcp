/**
 * 城市的天气（规格 5）。
 *
 * 引擎是唯一的抓取方：每 30 分钟向 open-meteo 取一次三片的当前天气和逐小时预报，写进快照表（每片一行）。
 * 抓取在事务外面做（等网络），抓到了再用一个事务写快照、生成事件。抓不到时：
 *  - 距最近一次成功不到 3 小时：沿用那次的数值，标 stale；
 *  - 超过 3 小时（或从来没抓到过）：退回合成天气，标 fallback。合成天气只有云量和按月份的常年气温，永远不下雨：
 *    不拿编出来的雨去关河岸、去叫醒人。
 * 小屋内核不自己抓灯都天气，统一读这里（GET /city/bridge/v1/weather），这样家里窗外和城里是同一片天。
 *
 * 天气驱动的两个事件（每片每天各至多一次）：
 *  - rain_started：从不下雨转成下雨。露天地点里的人收到提示，雨天不开放的地点（澪川河岸）不能再进。
 *  - riverbank_evening：绯渡傍晚放晴时澪川河岸的一个公开小事件。
 */
import { parseJson, type Row } from '../world/db.js';
import { localParts, localToUtc } from '../world/time.js';
import { AREAS, PLACES, area as areaOf, place, type Area, type AreaId } from './catalog.js';
import type { CityService } from './service.js';
import { contextPlace } from './trips.js';
import { openVisitOf, wake } from './visits.js';

export interface HourlyPoint {
  at_ms: number;
  code: number;
  temp_c: number;
  precip_mm: number;
}

export interface WeatherReading {
  area: AreaId;
  observed_at_ms: number;
  code: number;
  temp_c: number;
  precip_mm: number;
  hourly: HourlyPoint[];
}

/** 抓一次天气。抓不到就抛错或返回空数组（两种都按「没抓到」处理）。 */
export type WeatherFetcher = (areas: readonly Area[], signal?: AbortSignal) => Promise<WeatherReading[]>;

export interface WeatherSnapshot {
  area: AreaId;
  observed_at_ms: number;
  fetched_at_ms: number;
  code: number;
  temp_c: number;
  precip_mm: number;
  rain: boolean;
  source: string;
  status: 'ok' | 'stale' | 'fallback';
  /** 给人看的一句话 */
  text: string;
  hourly: HourlyPoint[];
}

/** WMO 天气代码里算「下雨」的：毛毛雨、雨、冻雨、阵雨、雷雨。雪不算。 */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
export const isRainCode = (code: number, precipMm: number): boolean => RAIN_CODES.has(code) || (precipMm >= 0.1 && !(code >= 71 && code <= 77) && code !== 85 && code !== 86);

export function weatherText(code: number): string {
  if (code === 0) return '晴';
  if (code === 1) return '大致晴朗';
  if (code === 2) return '多云间晴';
  if (code === 3) return '阴';
  if (code === 45 || code === 48) return '有雾';
  if (code >= 51 && code <= 57) return '毛毛雨';
  if (code >= 61 && code <= 67) return code >= 65 ? '大雨' : '下雨';
  if (code >= 71 && code <= 77) return '下雪';
  if (code >= 80 && code <= 82) return '阵雨';
  if (code === 85 || code === 86) return '阵雪';
  if (code >= 95) return '雷雨';
  return '多云';
}

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

/** 缺省的抓取函数：open-meteo，一次请求取三片。 */
export const openMeteoFetcher: WeatherFetcher = async (areas, signal) => {
  const qs = new URLSearchParams({
    latitude: areas.map((a) => a.weatherPoint.lat).join(','),
    longitude: areas.map((a) => a.weatherPoint.lon).join(','),
    current: 'temperature_2m,precipitation,rain,weather_code',
    hourly: 'temperature_2m,precipitation,weather_code',
    forecast_hours: '12',
    timeformat: 'unixtime',
    timezone: 'Asia/Tokyo',
  });
  const res = await fetch(`${OPEN_METEO_URL}?${qs.toString()}`, { signal: signal ?? AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`open-meteo 返回 ${res.status}`);
  return parseOpenMeteo(areas, await res.json());
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 解析 open-meteo 的返回（多个坐标时是数组，一个坐标时是对象）。字段不对的那一片跳过。 */
export function parseOpenMeteo(areas: readonly Area[], body: unknown): WeatherReading[] {
  const list = Array.isArray(body) ? body : [body];
  const out: WeatherReading[] = [];
  areas.forEach((a, i) => {
    const row = list[i] as { current?: Record<string, unknown>; hourly?: Record<string, unknown> } | undefined;
    const cur = row?.current;
    const time = num(cur?.time);
    const code = num(cur?.weather_code);
    const temp = num(cur?.temperature_2m);
    if (!cur || time === null || code === null || temp === null) return;
    const hourly: HourlyPoint[] = [];
    const h = row?.hourly;
    const times = Array.isArray(h?.time) ? (h.time as unknown[]) : [];
    for (let k = 0; k < times.length && k < 24; k++) {
      const t = num(times[k]);
      const c = num((h?.weather_code as unknown[] | undefined)?.[k]);
      const tc = num((h?.temperature_2m as unknown[] | undefined)?.[k]);
      if (t === null || c === null || tc === null) continue;
      hourly.push({ at_ms: t * 1000, code: c, temp_c: tc, precip_mm: num((h?.precipitation as unknown[] | undefined)?.[k]) ?? 0 });
    }
    out.push({ area: a.id, observed_at_ms: time * 1000, code, temp_c: temp, precip_mm: Math.max(num(cur.precipitation) ?? 0, num(cur.rain) ?? 0), hourly });
  });
  return out;
}

/** 灯都各月的大致常年平均气温（合成天气用）。 */
const MONTH_TEMP = [5.5, 6.5, 9.5, 14.5, 19, 22, 26, 27.5, 23.5, 18, 12.5, 8];

/** 合成天气：不下雨，云量按日期轮换，气温按月份和钟点。确定性的（同一时刻同一片算出来一样）。 */
function synthetic(c: CityService, a: AreaId, at: number): Omit<WeatherReading, 'area'> {
  const p = localParts(c.params.timezone, at);
  const month = Number(p.date.slice(5, 7));
  const day = Number(p.date.slice(8, 10));
  const base = MONTH_TEMP[month - 1] ?? 15;
  const swing = Math.cos(((p.hour - 14) / 24) * 2 * Math.PI) * 3.5;
  const code = [1, 2, 3, 2][(day + AREAS.findIndex((x) => x.id === a)) % 4]!;
  return { observed_at_ms: at, code, temp_c: Math.round((base + swing) * 10) / 10, precip_mm: 0, hourly: [] };
}

function rowToSnapshot(row: Row): WeatherSnapshot {
  return {
    area: row.area as AreaId,
    observed_at_ms: Number(row.observed_at_ms),
    fetched_at_ms: Number(row.fetched_at_ms),
    code: Number(row.code),
    temp_c: Number(row.temp_c),
    precip_mm: Number(row.precip_mm),
    rain: Number(row.rain) === 1,
    source: String(row.source),
    status: row.status as WeatherSnapshot['status'],
    text: weatherText(Number(row.code)),
    hourly: parseJson<HourlyPoint[]>(row.hourly_json as string, []),
  };
}

export function weatherOf(c: CityService, a: string): WeatherSnapshot | undefined {
  const row = c.db.get<Row>('SELECT * FROM weather_snapshots WHERE area = ?', a);
  return row ? rowToSnapshot(row) : undefined;
}

export function allWeather(c: CityService): WeatherSnapshot[] {
  return AREAS.map((a) => weatherOf(c, a.id)).filter((s): s is WeatherSnapshot => Boolean(s));
}

/** 这一片此刻是不是在下雨（按快照）。合成天气永远不下雨。 */
export function isRaining(c: CityService, a: string): boolean {
  return c.db.get<{ rain: number }>('SELECT rain FROM weather_snapshots WHERE area = ?', a)?.rain === 1;
}

export interface CityEvent {
  event_id: string;
  kind: string;
  area: string;
  place: string | null;
  title: string;
  body: string;
  starts_at_ms: number;
  ends_at_ms: number;
}

/** 今天的公开事件（还没结束的排前面）。 */
export function eventsToday(c: CityService, at: number = c.now()): CityEvent[] {
  return c.db
    .all<Row>('SELECT * FROM city_events WHERE business_date = ? ORDER BY starts_at, event_id', c.today(at))
    .map((e) => ({ event_id: String(e.event_id), kind: String(e.def_id), area: String(e.area), place: (e.place_id as string | null) ?? null, title: String(e.title), body: String(e.body), starts_at_ms: Number(e.starts_at), ends_at_ms: Number(e.ends_at) }));
}

function addEvent(c: CityService, def: string, a: AreaId, placeId: string | null, title: string, body: string, startsAt: number, endsAt: number): CityEvent | null {
  const id = c.id('ev');
  const ins = c.db.run('INSERT OR IGNORE INTO city_events(event_id, def_id, area, place_id, business_date, title, body, starts_at, ends_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, def, a, placeId, c.today(startsAt), title, body, startsAt, endsAt, c.now());
  if (ins.changes === 0) return null; // 这一片今天已经有过这个事件了
  const ev: CityEvent = { event_id: id, kind: def, area: a, place: placeId, title, body, starts_at_ms: startsAt, ends_at_ms: endsAt };
  c.emitPublic('city_event', { ...ev });
  return ev;
}

/** 这一片里此刻在场的人（站在这一片的某个公开地点）。 */
function residentsInArea(c: CityService, a: AreaId, outdoorOnly: boolean): string[] {
  const ids: string[] = [];
  for (const p of PLACES) {
    if (p.area !== a || p.hidden || (outdoorOnly && p.indoor)) continue;
    for (const r of c.presentAt(p.id)) ids.push(r.resident_id);
  }
  return ids;
}

/**
 * 把一次抓取的结果写成快照（readings 为 null 或缺了某一片 = 那一片没抓到）。必须在事务里调用。
 * 返回这次新生成的事件。
 */
export function applyWeather(c: CityService, readings: readonly WeatherReading[] | null, at: number): CityEvent[] {
  const events: CityEvent[] = [];
  for (const a of AREAS) {
    const prev = c.db.get<Row>('SELECT * FROM weather_snapshots WHERE area = ?', a.id);
    const got = readings?.find((r) => r.area === a.id) ?? null;
    let next: { observed: number; code: number; temp: number; precip: number; rain: boolean; source: string; status: WeatherSnapshot['status']; lastOk: number | null; hourly: HourlyPoint[] };
    if (got) {
      next = { observed: got.observed_at_ms, code: got.code, temp: got.temp_c, precip: got.precip_mm, rain: isRainCode(got.code, got.precip_mm), source: 'open-meteo', status: 'ok', lastOk: at, hourly: got.hourly };
    } else if (prev && prev.last_ok_at_ms !== null && at - Number(prev.last_ok_at_ms) <= c.params.weatherFallbackAfterMs) {
      next = { observed: Number(prev.observed_at_ms), code: Number(prev.code), temp: Number(prev.temp_c), precip: Number(prev.precip_mm), rain: Number(prev.rain) === 1, source: String(prev.source), status: 'stale', lastOk: Number(prev.last_ok_at_ms), hourly: parseJson<HourlyPoint[]>(prev.hourly_json as string, []) };
    } else {
      const s = synthetic(c, a.id, at);
      next = { observed: s.observed_at_ms, code: s.code, temp: s.temp_c, precip: 0, rain: false, source: 'synthetic', status: 'fallback', lastOk: prev?.last_ok_at_ms === null || prev === undefined ? null : Number(prev.last_ok_at_ms), hourly: [] };
    }
    c.db.run(
      `INSERT INTO weather_snapshots(area, observed_at_ms, fetched_at_ms, last_ok_at_ms, code, temp_c, precip_mm, rain, source, status, hourly_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(area) DO UPDATE SET observed_at_ms = excluded.observed_at_ms, fetched_at_ms = excluded.fetched_at_ms, last_ok_at_ms = excluded.last_ok_at_ms, code = excluded.code,
         temp_c = excluded.temp_c, precip_mm = excluded.precip_mm, rain = excluded.rain, source = excluded.source, status = excluded.status, hourly_json = excluded.hourly_json`,
      a.id,
      Math.round(next.observed),
      at,
      next.lastOk,
      Math.round(next.code),
      next.temp,
      next.precip,
      next.rain ? 1 : 0,
      next.source,
      next.status,
      JSON.stringify(next.hourly),
    );
    if (next.status !== 'ok') continue; // 事件只由真的抓到的天气驱动

    // ① 转雨：之前有快照而且不在下雨，现在下雨了
    // 「开始下雨」要有前后两份实况作比较：上一份是合成天气（不下雨）时，雨可能早就在下了，不算刚开始
    if (next.rain && prev && Number(prev.rain) === 0 && String(prev.status) !== 'fallback') {
      const ev = addEvent(c, 'rain_started', a.id, null, `${a.name}下雨了`, `${a.name}一带开始下雨。露天的地方会淋到；澪川河岸这样雨天不开放的地点暂时不能再进。`, at, at + 60 * 60_000);
      if (ev) {
        events.push(ev);
        c.emitTo(residentsInArea(c, a.id, true), 'weather', { kind: 'rain_started', area: a.id, text: ev.title }, at);
        // 在这一片（或正往这一片去）的室友：值得她自己决定要不要躲雨、买伞、回家
        for (const m of c.db.all<{ resident_id: string }>("SELECT resident_id FROM residents WHERE origin = 'house' AND in_city = 1")) {
          const r = c.mustResident(m.resident_id);
          const visit = openVisitOf(c, r.resident_id);
          if (visit && visit.state === 'active' && place(contextPlace(c, r))?.area === a.id) wake(c, visit, 'rain', at, { area: a.id });
        }
      }
    }
    // ② 绯渡傍晚放晴：澪川河岸的小事件
    if (a.id === 'hiwatari' && !next.rain && next.code <= 2) {
      const minute = c.minuteOfDay(at);
      if (minute >= 16 * 60 && minute < 18 * 60) {
        const ends = localToUtc(c.params.timezone, c.today(at), 18, 30);
        const ev = addEvent(c, 'riverbank_evening', a.id, 'hiwatari:mio-riverbank', '澪川河岸的傍晚', '今天傍晚天晴，澪川的河堤上能看到很远的桥和晚霞。到 18:30 天黑之前，河岸上会有人散步、坐着看河。', at, ends);
        if (ev) events.push(ev);
      }
    }
  }
  return events;
}

/** 抓一次并写入。抓取在事务外，写入是一个事务。永远不抛错。 */
export async function refreshWeather(c: CityService): Promise<void> {
  let readings: WeatherReading[] | null = null;
  if (c.fetchWeather) {
    try {
      const got = await c.fetchWeather(AREAS);
      readings = got.length > 0 ? got : null;
    } catch (e) {
      c.log(`[city] 天气没抓到：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (c.status === 'closed') return;
  try {
    c.commit(() => {
      applyWeather(c, readings, c.now());
      c.db.setMeta('weather_last_attempt', String(c.now()));
    });
  } catch (e) {
    c.log(`[city] 天气快照没写进去：${e instanceof Error ? e.message : String(e)}`);
  }
}

export function installWeather(c: CityService): void {
  // 启动时保证每一片都有快照；太旧的降级
  c.hooks.recover.push((now) => {
    const missing = AREAS.some((a) => !c.db.get('SELECT 1 AS x FROM weather_snapshots WHERE area = ?', a.id));
    const last = Number(c.db.getMeta('weather_last_attempt') ?? 0);
    if (missing || now - last > c.params.weatherFallbackAfterMs) applyWeather(c, null, now);
  });
  let inflight = false;
  let lastAttempt: number | null = null;
  c.hooks.tick.push((now) => {
    if (inflight) return;
    // 没有配置抓取函数（fetchWeather: null）也照常按间隔跑：负责把过期的快照降级
    lastAttempt ??= Number(c.db.getMeta('weather_last_attempt') ?? 0);
    if (now - lastAttempt < c.params.weatherIntervalMs) return;
    lastAttempt = now;
    inflight = true;
    void refreshWeather(c).finally(() => {
      inflight = false;
    });
  });
}

/** 给视图用的一小段：这一片的天气 + 来源和时间。 */
export function weatherBrief(c: CityService, a: string): Record<string, unknown> | null {
  const s = weatherOf(c, a);
  if (!s) return null;
  const soon = s.hourly.filter((h) => h.at_ms > c.now() && h.at_ms <= c.now() + 3 * 3600_000 && isRainCode(h.code, h.precip_mm));
  return {
    area: s.area,
    area_name: areaOf(s.area)?.name ?? s.area,
    text: s.text,
    temp_c: s.temp_c,
    rain: s.rain,
    ...(soon.length > 0 && !s.rain ? { rain_expected_at_ms: soon[0]!.at_ms } : {}),
    observed_at_ms: s.observed_at_ms,
    source: s.source,
    status: s.status,
  };
}
