/**
 * 城市的天气（规格 5）。
 *
 * 引擎是唯一的抓取方：每 30 分钟向 open-meteo 取一次三片的当前天气和逐小时预报，写进快照表（每片一行）。
 * 抓取在事务外面做（等网络），抓到了再用一个事务写快照、生成事件。抓不到时：
 *  - 距最近一次成功不到 3 小时：沿用那次的数值，标 stale；
 *  - 超过 3 小时（或从来没抓到过）：退回合成天气，标 fallback。合成天气只有云量和按月份的常年气温，永远不下雨：
 *    不拿编出来的雨去关河岸、去叫醒人。
 * 小屋内核不自己抓晴空都天气，统一读这里（GET /city/bridge/v1/weather），这样家里窗外和城里是同一片天。
 *
 * 天气驱动的两个事件（每片每天各至多一次）：
 *  - rain_started：从不下雨转成下雨。露天地点里的人收到提示，雨天不开放的地点（浮光川河岸）不能再进。
 *  - riverbank_evening：日和坂傍晚放晴时浮光川河岸的一个公开小事件。
 */
import { createHash, randomBytes } from 'node:crypto';
import { parseJson, type Row } from '../core/sqlite.js';
import { localParts, localToUtc } from '../core/time.js';
import { AREAS, PLACES, area as areaOf, place, type Area, type AreaId } from './catalog.js';
import { cityBadRequest, cityConflict } from './errors.js';
import type { CityService } from './service.js';
import { contextPlace } from './trips.js';
import { openVisitOf, wake } from './visits.js';

export const HOUR_MS = 3_600_000;
export const LEGACY_WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';
export const QINGKONG_WEATHER_ATTRIBUTION = 'Qingkong City Climate Engine (built-in deterministic model)';

export type WeatherBreezeLevel = 'calm' | 'breezy' | 'gusty';
export type WeatherPreset = 'clear' | 'breezy' | 'overcast' | 'sun_shower' | 'rain' | 'afterglow' | 'fog' | 'snow';

export interface WeatherNaturalPoint {
  code: number;
  temp_c: number;
  precip_mm: number;
  rain: boolean;
}

export interface WeatherOverrideView {
  preset: string;
  code: number;
  temp_c: number;
  precip_mm: number;
  rain: boolean;
  breeze_level?: string;
  starts_at_ms: number;
  expires_at_ms: number;
  reason?: string;
}

export interface TomorrowDaytimeForecast {
  date: string;
  summary_text: string;
  rain_hours: number;
  min_temp_c: number;
  max_temp_c: number;
}

export interface HourlyPoint {
  at_ms: number;
  code: number;
  temp_c: number;
  precip_mm: number;
  rain?: boolean;
  natural?: WeatherNaturalPoint;
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
  override?: WeatherOverrideView | null;
  breeze_level?: WeatherBreezeLevel;
  clear_window_at_ms?: number | null;
  tomorrow_daytime?: TomorrowDaytimeForecast;
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

/** 晴空都各月的大致常年平均气温（合成天气用）。 */
const MONTH_TEMP = [5.5, 6.5, 9.5, 14.5, 19, 22, 26, 27.5, 23.5, 18, 12.5, 8];

export function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function isQingkongMode(c: CityService): boolean {
  return c.params.weatherSource === 'qingkong' && c.fetchWeather === undefined;
}

export function weatherAttribution(c: CityService): string {
  return isQingkongMode(c) ? QINGKONG_WEATHER_ATTRIBUTION : LEGACY_WEATHER_ATTRIBUTION;
}

const VALID_PRESETS = new Set<WeatherPreset>(['clear', 'breezy', 'overcast', 'sun_shower', 'rain', 'afterglow', 'fog', 'snow']);

interface PresetSpec {
  code: number;
  precip_mm: number;
  rain: boolean;
  breeze_level: WeatherBreezeLevel;
}

const PRESET_SPECS: Record<WeatherPreset, PresetSpec> = {
  clear: { code: 0, precip_mm: 0, rain: false, breeze_level: 'calm' },
  breezy: { code: 1, precip_mm: 0, rain: false, breeze_level: 'gusty' },
  overcast: { code: 3, precip_mm: 0, rain: false, breeze_level: 'calm' },
  sun_shower: { code: 80, precip_mm: 1.2, rain: true, breeze_level: 'breezy' },
  rain: { code: 61, precip_mm: 2.4, rain: true, breeze_level: 'breezy' },
  afterglow: { code: 0, precip_mm: 0, rain: false, breeze_level: 'calm' },
  fog: { code: 45, precip_mm: 0, rain: false, breeze_level: 'calm' },
  snow: { code: 71, precip_mm: 1.0, rain: false, breeze_level: 'calm' },
};

const AREA_TEMP_OFFSET: Record<AreaId, number> = {
  hiyorizaka: -0.5,
  ryokogai: 0.3,
  kumominato: -0.2,
};

type RawSlotKind = 'clear0' | 'clear1' | 'clear2' | 'overcast' | 'fog' | 'shower' | 'steady_light' | 'steady_mod';

interface SlotProposal {
  kind: RawSlotKind;
  wet: boolean;
}

function hashUnit(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) / 0x1_0000_0000;
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function actorTagOf(adminKey: string): string {
  return `adm:${sha256Hex(adminKey).slice(0, 8)}`;
}

function shiftLocalDate(dateStr: string, deltaDays: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + deltaDays)).toISOString().slice(0, 10);
}

function rawSlotProposal(seed: string, dateStr: string, slot: number, areaId: AreaId): SlotProposal {
  const u = hashUnit(`${seed}:${areaId}:${dateStr}:slot:${slot}:kind`);
  const morning = slot >= 2 && slot <= 4;
  const afternoon = slot >= 6 && slot <= 8;
  const fogShare = morning ? (areaId === 'hiyorizaka' ? 0.11 : 0.07) : 0;
  const showerShare = afternoon ? 0.15 : 0.06;
  const steadyShare = 0.05;
  // ~68% clear, ~18% cloud/fog (45 restricted to 04:00-09:59), ~9% avg shower, ~5% avg steady rain
  const overcastShare = Math.max(0, 0.18 - fogShare);
  const clearCutoff = 1 - fogShare - overcastShare - showerShare - steadyShare;
  if (u < clearCutoff) {
    const sub = u / clearCutoff;
    if (sub < 0.44) return { kind: 'clear0', wet: false };
    if (sub < 0.76) return { kind: 'clear1', wet: false };
    return { kind: 'clear2', wet: false };
  }
  if (u < clearCutoff + fogShare) return { kind: 'fog', wet: false };
  if (u < clearCutoff + fogShare + overcastShare) return { kind: 'overcast', wet: false };
  if (u < clearCutoff + fogShare + overcastShare + showerShare) return { kind: 'shower', wet: true };
  const sub = hashUnit(`${seed}:${areaId}:${dateStr}:slot:${slot}:rain_grade`);
  return { kind: sub < 0.8 ? 'steady_light' : 'steady_mod', wet: true };
}

/** Single calendar day after intra-day dual guardrails (independent of prior days for [3..11]). */
function buildGuardedDayBase(seed: string, dateStr: string, areaId: AreaId): SlotProposal[] {
  const slots: SlotProposal[] = [];
  for (let s = 0; s < 12; s++) slots.push(rawSlotProposal(seed, dateStr, s, areaId));

  // Guardrail 2: cap daytime (10:00-17:59 -> slots 5..8) wet slots at <= 2/day -> >= 6 dry across any 3 days
  const daytimeWet = [5, 6, 7, 8].filter((s) => slots[s]!.wet);
  if (daytimeWet.length > 2) {
    daytimeWet.sort((a, b) => hashUnit(`${seed}:${areaId}:${dateStr}:dt:${a}`) - hashUnit(`${seed}:${areaId}:${dateStr}:dt:${b}`));
    for (let i = 0; i < daytimeWet.length - 2; i++) {
      slots[daytimeWet[i]!] = { kind: 'overcast', wet: false };
    }
  }

  // Guardrail 1 (intra-day): max 3 consecutive wet slots, and '80' shower is strictly single-slot & isolated
  let streak = 0;
  let prevKind: RawSlotKind | null = null;
  for (let s = 0; s < 12; s++) {
    const cur = slots[s]!;
    if (cur.wet) {
      if (prevKind === 'shower' || (cur.kind === 'shower' && streak > 0) || streak >= 3) {
        slots[s] = { kind: 'clear2', wet: false };
        streak = 0;
        prevKind = 'clear2';
        continue;
      }
      streak++;
      prevKind = cur.kind;
    } else {
      streak = 0;
      prevKind = cur.kind;
    }
  }
  return slots;
}

const DAY_SLOTS_CACHE = new Map<string, readonly SlotProposal[]>();
const MAX_DAY_SLOTS_CACHE = 256;

function resolveDaySlots(seed: string, dateStr: string, areaId: AreaId): SlotProposal[] {
  const key = `${seed}|${areaId}|${dateStr}`;
  const hit = DAY_SLOTS_CACHE.get(key);
  if (hit) return hit.map((x) => ({ ...x }));
  const prev = buildGuardedDayBase(seed, shiftLocalDate(dateStr, -1), areaId);
  const cur = buildGuardedDayBase(seed, dateStr, areaId);
  let tailWet = 0;
  for (let s = 11; s >= 9; s--) {
    if (!prev[s]!.wet) break;
    tailWet++;
  }
  if (tailWet > 0) {
    // Cross-midnight seam fix affects only cur[0..2] monotonically (wet -> dry never increases streaks).
    let streak = tailWet;
    let prevWasShower = prev[11]!.kind === 'shower';
    let prevWasWet = true;
    for (let s = 0; s <= 2; s++) {
      const item = cur[s]!;
      if (!item.wet) break;
      if (prevWasShower || (item.kind === 'shower' && prevWasWet) || streak >= 3) {
        cur[s] = { kind: 'clear2', wet: false };
        break;
      }
      streak++;
      prevWasShower = item.kind === 'shower';
      prevWasWet = true;
    }
  }
  if (DAY_SLOTS_CACHE.size >= MAX_DAY_SLOTS_CACHE) {
    const firstKey = DAY_SLOTS_CACHE.keys().next().value;
    if (firstKey !== undefined) DAY_SLOTS_CACHE.delete(firstKey);
  }
  DAY_SLOTS_CACHE.set(key, cur);
  return cur;
}

function naturalBreezeForSlot(seed: string, dateStr: string, slot: number, areaId: AreaId, kind: RawSlotKind): WeatherBreezeLevel | undefined {
  if (areaId !== 'kumominato') return undefined;
  const u = hashUnit(`${seed}:${areaId}:${dateStr}:slot:${slot}:breeze`);
  if (kind === 'steady_mod' || u >= 0.88) return 'gusty';
  if (u >= 0.55) return 'breezy';
  return 'calm';
}

function slotKindAtHour(
  seed: string,
  dateStr: string,
  hour: number,
  slot: number,
  areaId: AreaId,
  proposal: SlotProposal,
): WeatherNaturalPoint & { breeze_level?: WeatherBreezeLevel } {
  const month = Number(dateStr.slice(5, 7));
  const base = MONTH_TEMP[month - 1] ?? 15;
  const dayPerturb = (hashUnit(`${seed}:day_temp:${dateStr}`) * 2 - 1) * 2.0;
  const areaOff = AREA_TEMP_OFFSET[areaId] ?? 0;
  const amp = proposal.wet ? 1.6 : proposal.kind === 'overcast' || proposal.kind === 'fog' ? 2.8 : 4.2;
  const swing = Math.cos(((hour - 14) / 24) * 2 * Math.PI) * amp;
  const temp_c = Math.round((base + dayPerturb + areaOff + swing) * 10) / 10;

  let code: number;
  let precip_mm = 0;
  if (proposal.kind === 'clear0') code = 0;
  else if (proposal.kind === 'clear1') code = 1;
  else if (proposal.kind === 'clear2') code = 2;
  else if (proposal.kind === 'fog') code = 45;
  else if (proposal.kind === 'overcast') code = 3;
  else {
    const winter = month === 12 || month === 1 || month === 2;
    if (winter && temp_c <= 2.5) {
      code = proposal.kind === 'shower' ? 85 : 71;
      precip_mm = proposal.kind === 'shower' ? 0.6 : 1.2;
    } else if (proposal.kind === 'shower') {
      code = 80;
      precip_mm = 1.4;
    } else if (proposal.kind === 'steady_mod') {
      code = 63;
      precip_mm = 3.2;
    } else {
      code = 61;
      precip_mm = 1.6;
    }
  }
  const rain = isRainCode(code, precip_mm);
  const breeze_level = naturalBreezeForSlot(seed, dateStr, slot, areaId, proposal.kind);
  return { code, temp_c, precip_mm, rain, ...(breeze_level ? { breeze_level } : {}) };
}

/** Pure O(1) natural weather evaluation for a 2-hour slot (0..11) on local YYYY-MM-DD. */
export function evalNaturalSlot(
  seed: string,
  localDate: string,
  slot: number,
  areaId: AreaId,
): WeatherNaturalPoint & { breeze_level?: WeatherBreezeLevel } {
  const clampedSlot = Math.max(0, Math.min(11, Math.floor(slot)));
  const day = resolveDaySlots(seed, localDate, areaId);
  return slotKindAtHour(seed, localDate, clampedSlot * 2 + 1, clampedSlot, areaId, day[clampedSlot]!);
}

/** Pure natural weather evaluation at an exact UTC millisecond in the configured city timezone. */
export function evalNaturalAt(
  seed: string,
  timezone: string,
  areaId: AreaId,
  atMs: number,
): WeatherNaturalPoint & { breeze_level?: WeatherBreezeLevel } {
  const p = localParts(timezone, atMs);
  const slot = Math.floor(p.hour / 2);
  const day = resolveDaySlots(seed, p.date, areaId);
  return slotKindAtHour(seed, p.date, p.hour, slot, areaId, day[slot]!);
}

function readWeatherSeed(c: CityService, createIfMissing: boolean): string {
  if (c.params.weatherSeed) {
    if (createIfMissing && c.db.getMeta('weather_seed') !== c.params.weatherSeed) {
      c.db.setMeta('weather_seed', c.params.weatherSeed);
    }
    return c.params.weatherSeed;
  }
  const existing = c.db.getMeta('weather_seed');
  if (existing) return existing;
  const generated = createIfMissing ? randomBytes(16).toString('hex') : 'qingkong-bootstrap-seed';
  if (createIfMissing) c.db.setMeta('weather_seed', generated);
  return generated;
}

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

interface OverrideRow {
  area: string;
  preset: string;
  code: number;
  temp_c: number | null;
  precip_mm: number;
  rain: number;
  breeze_level: string | null;
  reason: string | null;
  actor_tag: string;
  starts_at_ms: number;
  created_at_ms: number;
  expires_at_ms: number;
}

function resolveOverrideTemp(ov: OverrideRow, naturalTemp: number): number {
  if (ov.temp_c !== null && ov.temp_c !== undefined) return Number(ov.temp_c);
  if (ov.preset === 'snow') return Math.round(Math.min(1.5, naturalTemp) * 10) / 10;
  return naturalTemp;
}

function activeOverrideFor(c: CityService, areaId: AreaId, now: number): { view: WeatherOverrideView | null; hasExpiredRow: boolean } {
  if (!isQingkongMode(c)) return { view: null, hasExpiredRow: false };
  const row = c.db.get<OverrideRow>('SELECT * FROM weather_overrides WHERE area = ?', areaId);
  if (!row) return { view: null, hasExpiredRow: false };
  const starts = Number(row.starts_at_ms);
  const expires = Number(row.expires_at_ms);
  if (expires <= now) return { view: null, hasExpiredRow: true };
  if (starts > now) return { view: null, hasExpiredRow: false };
  const seed = readWeatherSeed(c, false);
  const nat = evalNaturalAt(seed, c.params.timezone, areaId, now);
  return {
    hasExpiredRow: false,
    view: {
      preset: row.preset,
      code: Number(row.code),
      temp_c: resolveOverrideTemp(row, nat.temp_c),
      precip_mm: Number(row.precip_mm),
      rain: Number(row.rain) === 1,
      ...(row.breeze_level ? { breeze_level: String(row.breeze_level) } : {}),
      starts_at_ms: starts,
      expires_at_ms: expires,
      ...(row.reason ? { reason: String(row.reason) } : {}),
    },
  };
}

function computeClearWindowMs(
  seed: string,
  timezone: string,
  areaId: AreaId,
  now: number,
  currentlyRain: boolean,
  ov: OverrideRow | null,
): number | null {
  if (!currentlyRain) return null;
  const activeOv = ov && Number(ov.starts_at_ms) <= now && now < Number(ov.expires_at_ms) ? ov : null;
  if (activeOv) {
    const exp = Number(activeOv.expires_at_ms);
    if (!evalNaturalAt(seed, timezone, areaId, exp).rain) return exp;
    const firstHourAfterExp = floorHour(exp) + HOUR_MS;
    for (let k = 0; k < 72; k++) {
      const t = firstHourAfterExp + k * HOUR_MS;
      if (!evalNaturalAt(seed, timezone, areaId, t).rain) return t;
    }
    return null;
  }
  const firstHour = floorHour(now) + HOUR_MS;
  for (let k = 0; k < 72; k++) {
    const t = firstHour + k * HOUR_MS;
    if (!evalNaturalAt(seed, timezone, areaId, t).rain) return t;
  }
  return null;
}

function computeTomorrowDaytime(
  seed: string,
  timezone: string,
  areaId: AreaId,
  now: number,
  ov: OverrideRow | null,
): TomorrowDaytimeForecast {
  const todayDate = localParts(timezone, now).date;
  const tomorrowDate = shiftLocalDate(todayDate, 1);
  let minTemp = Infinity;
  let maxTemp = -Infinity;
  let rainHours = 0;
  let snowHours = 0;
  let overcastHours = 0;
  for (let h = 9; h <= 17; h++) {
    const atMs = localToUtc(timezone, tomorrowDate, h, 0);
    const nat = evalNaturalAt(seed, timezone, areaId, atMs);
    let temp = nat.temp_c;
    let rain = nat.rain;
    let code = nat.code;
    if (ov && Number(ov.starts_at_ms) <= atMs && atMs < Number(ov.expires_at_ms)) {
      temp = resolveOverrideTemp(ov, nat.temp_c);
      rain = Number(ov.rain) === 1;
      code = Number(ov.code);
    }
    if (temp < minTemp) minTemp = temp;
    if (temp > maxTemp) maxTemp = temp;
    if (rain) rainHours++;
    else if (code === 71 || code === 85) snowHours++;
    else if (code >= 3) overcastHours++;
  }
  let summary_text = '晴朗舒适';
  if (rainHours >= 5) summary_text = '多阴雨';
  else if (rainHours > 0) summary_text = '局地短阵雨';
  else if (snowHours > 0) summary_text = '冬日有雪';
  else if (overcastHours >= 5) summary_text = '多云微凉';
  return { date: tomorrowDate, summary_text, rain_hours: rainHours, min_temp_c: minTemp, max_temp_c: maxTemp };
}

function buildQingkongSnapshotData(c: CityService, areaId: AreaId, at: number, ov: OverrideRow | null): WeatherSnapshot {
  const seed = readWeatherSeed(c, false);
  const tz = c.params.timezone;
  const baseHour = floorHour(at);
  const natNow = evalNaturalAt(seed, tz, areaId, at);
  const activeOv = ov && Number(ov.starts_at_ms) <= at && at < Number(ov.expires_at_ms) ? ov : null;

  const code = activeOv ? Number(activeOv.code) : natNow.code;
  const temp_c = activeOv ? resolveOverrideTemp(activeOv, natNow.temp_c) : natNow.temp_c;
  const precip_mm = activeOv ? Number(activeOv.precip_mm) : natNow.precip_mm;
  const rain = activeOv ? Number(activeOv.rain) === 1 : natNow.rain;
  const breeze_level = ((activeOv?.breeze_level as WeatherBreezeLevel | undefined) ?? natNow.breeze_level) as WeatherBreezeLevel | undefined;

  const hourly: HourlyPoint[] = [];
  for (let k = 0; k < 25; k++) {
    const slotStart = baseHour + k * HOUR_MS;
    const slotEnd = slotStart + HOUR_MS;
    const natSlot = evalNaturalAt(seed, tz, areaId, slotStart);
    const natural: WeatherNaturalPoint = { code: natSlot.code, temp_c: natSlot.temp_c, precip_mm: natSlot.precip_mm, rain: natSlot.rain };
    const ovCovers =
      ov !== null &&
      Number(ov.expires_at_ms) > at &&
      Number(ov.starts_at_ms) < slotEnd &&
      Math.max(at, slotStart) < Number(ov.expires_at_ms);
    if (ovCovers) {
      hourly.push({
        at_ms: slotStart,
        code: Number(ov!.code),
        temp_c: resolveOverrideTemp(ov!, natSlot.temp_c),
        precip_mm: Number(ov!.precip_mm),
        rain: Number(ov!.rain) === 1,
        natural,
      });
    } else {
      hourly.push({
        at_ms: slotStart,
        code: natural.code,
        temp_c: natural.temp_c,
        precip_mm: natural.precip_mm,
        rain: natural.rain,
        natural,
      });
    }
  }

  const overrideView: WeatherOverrideView | null = activeOv
    ? {
        preset: activeOv.preset,
        code: Number(activeOv.code),
        temp_c: resolveOverrideTemp(activeOv, natNow.temp_c),
        precip_mm: Number(activeOv.precip_mm),
        rain: Number(activeOv.rain) === 1,
        ...(activeOv.breeze_level ? { breeze_level: String(activeOv.breeze_level) } : {}),
        starts_at_ms: Number(activeOv.starts_at_ms),
        expires_at_ms: Number(activeOv.expires_at_ms),
        ...(activeOv.reason ? { reason: String(activeOv.reason) } : {}),
      }
    : null;

  const clear_window_at_ms = computeClearWindowMs(seed, tz, areaId, at, rain, activeOv);
  const tomorrow_daytime = computeTomorrowDaytime(seed, tz, areaId, at, ov && Number(ov.expires_at_ms) > at ? ov : null);

  return {
    area: areaId,
    observed_at_ms: at,
    fetched_at_ms: at,
    code,
    temp_c,
    precip_mm,
    rain,
    source: 'qingkong',
    status: 'ok',
    text: weatherText(code),
    hourly,
    override: overrideView,
    ...(breeze_level ? { breeze_level } : {}),
    clear_window_at_ms,
    tomorrow_daytime,
  };
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
  const area = areaOf(a);
  const row = c.db.get<Row>('SELECT * FROM weather_snapshots WHERE area = ?', a);
  if (!isQingkongMode(c)) {
    if (!row) return undefined;
    if (String(row.source) === 'qingkong' && area) {
      const now = c.now();
      const s = synthetic(c, area.id, now);
      return {
        area: area.id,
        observed_at_ms: Math.round(s.observed_at_ms),
        fetched_at_ms: now,
        code: Math.round(s.code),
        temp_c: s.temp_c,
        precip_mm: 0,
        rain: false,
        source: 'synthetic',
        status: 'fallback',
        text: weatherText(s.code),
        hourly: [],
      };
    }
    return rowToSnapshot(row);
  }
  if (!area) return undefined;
  const now = c.now();
  const { view, hasExpiredRow } = activeOverrideFor(c, area.id, now);
  if (!row || String(row.source) !== 'qingkong' || hasExpiredRow || floorHour(now) > floorHour(Number(row.observed_at_ms))) {
    return buildQingkongSnapshotData(c, area.id, now, hasExpiredRow ? null : c.db.get<OverrideRow>('SELECT * FROM weather_overrides WHERE area = ?', area.id) ?? null);
  }
  const ovRow = c.db.get<OverrideRow>('SELECT * FROM weather_overrides WHERE area = ? AND expires_at_ms > ?', area.id, now) ?? null;
  const snap = rowToSnapshot(row);
  const built = buildQingkongSnapshotData(c, area.id, Number(row.observed_at_ms), ovRow);
  return {
    ...snap,
    override: view,
    ...(built.breeze_level ? { breeze_level: built.breeze_level } : {}),
    clear_window_at_ms: built.clear_window_at_ms ?? null,
    ...(built.tomorrow_daytime ? { tomorrow_daytime: built.tomorrow_daytime } : {}),
  };
}

export function allWeather(c: CityService): WeatherSnapshot[] {
  return AREAS.map((a) => weatherOf(c, a.id)).filter((s): s is WeatherSnapshot => Boolean(s));
}

/** 这一片此刻是不是在下雨（按快照）。合成天气永远不下雨。 */
export function isRaining(c: CityService, a: string): boolean {
  return weatherOf(c, a)?.rain === true;
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

function emitWeatherEvents(c: CityService, a: Area, prev: Row | undefined, next: { code: number; rain: boolean; status: string; breeze_level?: WeatherBreezeLevel }, at: number): CityEvent[] {
  const events: CityEvent[] = [];
  if (next.status !== 'ok') return events;

  // ① 转雨：之前有快照而且不在下雨，现在下雨了
  if (next.rain && prev && Number(prev.rain) === 0 && String(prev.status) !== 'fallback') {
    const shelterHint = a.id === 'ryokogai' && next.code === 80 ? '棱光街一带正落阵雨，沿街骑楼和书屋屋檐下可以避雨。' : `${a.name}一带开始下雨。露天的地方会淋到；浮光川河岸这样雨天不开放的地点暂时不能再进。`;
    const ev = addEvent(c, 'rain_started', a.id, null, `${a.name}下雨了`, shelterHint, at, at + 60 * 60_000);
    if (ev) {
      events.push(ev);
      c.emitTo(residentsInArea(c, a.id, true), 'weather', { kind: 'rain_started', area: a.id, text: ev.title }, at);
      for (const m of c.db.all<{ resident_id: string }>("SELECT resident_id FROM residents WHERE origin = 'house' AND in_city = 1")) {
        const r = c.mustResident(m.resident_id);
        const visit = openVisitOf(c, r.resident_id);
        if (visit && visit.state === 'active' && place(contextPlace(c, r))?.area === a.id) wake(c, visit, 'rain', at, { area: a.id });
      }
    }
  }
  // ② 日和坂傍晚放晴：浮光川河岸的小事件（雨后放晴 16:00-18:30 亦可衔接）
  if (a.id === 'hiyorizaka' && !next.rain && next.code <= 2) {
    const minute = c.minuteOfDay(at);
    const ends = localToUtc(c.params.timezone, c.today(at), 18, 30);
    const afterShower = isQingkongMode(c) && prev && Number(prev.rain) === 1 && minute >= 16 * 60 && at < ends;
    if ((minute >= 16 * 60 && minute < 18 * 60) || afterShower) {
      const ev = addEvent(c, 'riverbank_evening', a.id, 'hiyorizaka:fukogawa-riverbank', '浮光川河岸的傍晚', '今天傍晚天晴，浮光川的河堤上能看到很远的桥和晚霞。到 18:30 天黑之前，河岸上会有人散步、坐着看河。', at, ends);
      if (ev) events.push(ev);
    }
  }
  // ③ 云港微气候海风微事件（自研天象模式）
  if (isQingkongMode(c) && a.id === 'kumominato' && !next.rain && next.breeze_level === 'gusty') {
    const harborPlace = PLACES.find((p) => p.area === 'kumominato' && !p.indoor)?.id ?? null;
    const ev = addEvent(c, 'harbor_breeze', 'kumominato', harborPlace, '云港的海风', '云港码头今天吹起清爽的海风，港口上空开阔晴朗，沿堤散步很舒服。', at, at + 120 * 60_000);
    if (ev) events.push(ev);
  }
  return events;
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
    } else if (prev && String(prev.source) === 'open-meteo' && prev.last_ok_at_ms !== null && at - Number(prev.last_ok_at_ms) <= c.params.weatherFallbackAfterMs) {
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
    events.push(...emitWeatherEvents(c, a, prev, next, at));
  }
  return events;
}

/** 在事务内计算并落盘自研晴空都天象快照（含过期覆盖清理）。 */
export function applyQingkongWeather(c: CityService, at: number): CityEvent[] {
  ensureWeatherSeedForTx(c);
  c.db.run('DELETE FROM weather_overrides WHERE expires_at_ms <= ?', at);
  const events: CityEvent[] = [];
  for (const a of AREAS) {
    const prev = c.db.get<Row>('SELECT * FROM weather_snapshots WHERE area = ?', a.id);
    const ov = c.db.get<OverrideRow>('SELECT * FROM weather_overrides WHERE area = ?', a.id) ?? null;
    const snap = buildQingkongSnapshotData(c, a.id, at, ov);
    c.db.run(
      `INSERT INTO weather_snapshots(area, observed_at_ms, fetched_at_ms, last_ok_at_ms, code, temp_c, precip_mm, rain, source, status, hourly_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(area) DO UPDATE SET observed_at_ms = excluded.observed_at_ms, fetched_at_ms = excluded.fetched_at_ms, last_ok_at_ms = excluded.last_ok_at_ms, code = excluded.code,
         temp_c = excluded.temp_c, precip_mm = excluded.precip_mm, rain = excluded.rain, source = excluded.source, status = excluded.status, hourly_json = excluded.hourly_json`,
      a.id,
      Math.round(snap.observed_at_ms),
      at,
      at,
      Math.round(snap.code),
      snap.temp_c,
      snap.precip_mm,
      snap.rain ? 1 : 0,
      snap.source,
      snap.status,
      JSON.stringify(snap.hourly),
    );
    events.push(...emitWeatherEvents(c, a, prev, { code: snap.code, rain: snap.rain, status: snap.status, ...(snap.breeze_level ? { breeze_level: snap.breeze_level } : {}) }, at));
  }
  c.db.setMeta('weather_last_attempt', String(at));
  return events;
}

function ensureWeatherSeedForTx(c: CityService): string {
  return readWeatherSeed(c, true);
}

/** 抓一次并写入。抓取在事务外，写入是一个事务。永远不抛错。 */
export async function refreshWeather(c: CityService): Promise<void> {
  if (isQingkongMode(c)) {
    if (c.status === 'closed') return;
    try {
      c.commit(() => {
        applyQingkongWeather(c, c.now());
      });
    } catch (e) {
      c.log(`[city] 自研天象快照没写进去：${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
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
  let needsLegacyFlushRefresh = false;
  // 启动时保证每一片都有快照；按 weatherSource 执行防串源清理或即时生成
  c.hooks.recover.push((now) => {
    c.db.run('DELETE FROM weather_overrides WHERE expires_at_ms <= ?', now);
    if (isQingkongMode(c)) {
      c.db.setMeta('weather_source_mode', 'qingkong');
      applyQingkongWeather(c, now);
      return;
    }
    const hadQingkong = Boolean(
      c.db.get("SELECT 1 AS x FROM weather_snapshots WHERE source = 'qingkong'") ||
        c.db.get('SELECT 1 AS x FROM weather_overrides') ||
        c.db.getMeta('weather_source_mode') === 'qingkong',
    );
    if (hadQingkong) {
      c.db.run('DELETE FROM weather_overrides');
      c.db.setMeta('weather_last_attempt', '0');
      c.db.setMeta('weather_source_mode', c.params.weatherSource);
      applyWeather(c, null, now);
      c.db.setMeta('weather_last_attempt', '0');
      if (c.fetchWeather) needsLegacyFlushRefresh = true;
      return;
    }
    const missing = AREAS.some((a) => !c.db.get('SELECT 1 AS x FROM weather_snapshots WHERE area = ?', a.id));
    const last = Number(c.db.getMeta('weather_last_attempt') ?? 0);
    if (missing || now - last > c.params.weatherFallbackAfterMs) applyWeather(c, null, now);
  });
  c.hooks.recoverAsync.push(async () => {
    if (!needsLegacyFlushRefresh) return;
    needsLegacyFlushRefresh = false;
    await refreshWeather(c);
  });
  let inflight = false;
  let lastAttempt: number | null = null;
  c.hooks.tick.push((now) => {
    if (inflight) return;
    if (isQingkongMode(c)) {
      const lastApplied = Number(c.db.getMeta('weather_last_attempt') ?? 0);
      const hasExpiredOv = Boolean(c.db.get('SELECT 1 AS x FROM weather_overrides WHERE expires_at_ms <= ?', now));
      const hourCrossed = lastApplied <= 0 || floorHour(now) > floorHour(lastApplied);
      const intervalDue = now - lastApplied >= c.params.weatherIntervalMs;
      if (hasExpiredOv || hourCrossed || intervalDue) {
        try {
          c.commit(() => {
            applyQingkongWeather(c, now);
          });
        } catch (e) {
          c.log(`[city] 自研天象刷新失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
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
    ...(s.breeze_level ? { breeze_level: s.breeze_level } : {}),
    ...(s.override ? { override: s.override } : {}),
    ...(s.clear_window_at_ms !== undefined ? { clear_window_at_ms: s.clear_window_at_ms } : {}),
    ...(s.tomorrow_daytime ? { tomorrow_daytime: s.tomorrow_daytime } : {}),
  };
}

// ═══════════════════════════ 管理员天象拨盘（HTTP Bearer API 服务函数） ═══════════════════════════

function requireRequestId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.trim())) {
    throw cityBadRequest('request_id 必须是 1..128 位的字母、数字或 _ . : - 字符。', 'bad_request_id');
  }
  return raw.trim();
}

function parseAreaTarget(raw: unknown): AreaId[] {
  if (raw === 'all') return AREAS.map((a) => a.id);
  if (typeof raw === 'string') {
    const found = areaOf(raw);
    if (found) return [found.id];
  }
  throw cityBadRequest('area 必须是 all、hiyorizaka、ryokogai 或 kumominato。', 'bad_area');
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function readReceipt(
  c: CityService,
  requestId: string,
  payloadHash: string,
): Record<string, unknown> | null {
  const row = c.db.get<{ payload_hash: string; response_json: string }>('SELECT payload_hash, response_json FROM weather_override_receipts WHERE request_id = ?', requestId);
  if (!row) return null;
  if (row.payload_hash !== payloadHash) {
    throw cityConflict('同一个 request_id 提交了不同的天象拨盘参数。', 'request_id_conflict');
  }
  return JSON.parse(row.response_json) as Record<string, unknown>;
}

export function adminGetWeather(c: CityService): Record<string, unknown> {
  const now = c.now();
  const overrides = isQingkongMode(c)
    ? c.db.all<OverrideRow>('SELECT * FROM weather_overrides WHERE expires_at_ms > ? ORDER BY area', now).map((r) => ({
        area: r.area,
        preset: r.preset,
        code: Number(r.code),
        temp_c: r.temp_c === null ? null : Number(r.temp_c),
        precip_mm: Number(r.precip_mm),
        rain: Number(r.rain) === 1,
        breeze_level: r.breeze_level,
        reason: r.reason,
        actor_tag: r.actor_tag,
        starts_at_ms: Number(r.starts_at_ms),
        created_at_ms: Number(r.created_at_ms),
        expires_at_ms: Number(r.expires_at_ms),
      }))
    : [];
  const receipts = c.db
    .all<{ request_id: string; actor_tag: string; created_at_ms: number; response_json: string }>(
      'SELECT request_id, actor_tag, created_at_ms, response_json FROM weather_override_receipts ORDER BY created_at_ms DESC, request_id DESC LIMIT 20',
    )
    .map((r) => ({
      request_id: r.request_id,
      actor_tag: r.actor_tag,
      created_at_ms: Number(r.created_at_ms),
      response: parseJson<Record<string, unknown>>(r.response_json, {}),
    }));
  return {
    ok: true,
    weather_source: c.params.weatherSource,
    attribution: weatherAttribution(c),
    at_ms: now,
    areas: allWeather(c),
    overrides,
    receipts,
  };
}

export function adminSetWeatherOverride(c: CityService, body: Record<string, unknown>, adminKey: string): Record<string, unknown> {
  if (c.params.weatherSource !== 'qingkong') {
    throw cityConflict('当前未切换至自研天象引擎，天象拨盘尚未启用。', 'weather_cutover_inactive');
  }
  const requestId = requireRequestId(body.request_id);
  const targets = parseAreaTarget(body.area);
  if (typeof body.preset !== 'string' || !VALID_PRESETS.has(body.preset as WeatherPreset)) {
    throw cityBadRequest('preset 无效。', 'bad_preset');
  }
  const preset = body.preset as WeatherPreset;
  const duration = Number(body.duration_minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 720) {
    throw cityBadRequest('duration_minutes 必须是 15 到 720 之间的整数。', 'bad_duration');
  }
  let tempC: number | null = null;
  if (body.temp_c !== undefined && body.temp_c !== null) {
    const t = Number(body.temp_c);
    if (!Number.isFinite(t) || t < -15 || t > 42) {
      throw cityBadRequest('temp_c 必须在 -15 到 42 之间。', 'bad_temp');
    }
    tempC = Math.round(t * 10) / 10;
  }
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.trim().length > 120) {
      throw cityBadRequest('reason 不能超过 120 个字符。', 'bad_reason');
    }
    const trimmed = body.reason.trim();
    if (trimmed) reason = trimmed;
  }

  const payloadHash = sha256Hex(canonicalJson({ action: 'override', area: body.area, preset, duration_minutes: duration, temp_c: tempC, reason }));
  const replay = readReceipt(c, requestId, payloadHash);
  if (replay) return replay;

  const spec = PRESET_SPECS[preset];
  const actorTag = actorTagOf(adminKey);
  const out = c.commit(() => {
    const existing = readReceipt(c, requestId, payloadHash);
    if (existing) return existing;
    const now = c.now();
    const startsAt = now;
    const expiresAt = now + duration * 60_000;
    for (const areaId of targets) {
      c.db.run(
        `INSERT INTO weather_overrides(area, preset, code, temp_c, precip_mm, rain, breeze_level, reason, actor_tag, starts_at_ms, created_at_ms, expires_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(area) DO UPDATE SET preset = excluded.preset, code = excluded.code, temp_c = excluded.temp_c, precip_mm = excluded.precip_mm,
           rain = excluded.rain, breeze_level = excluded.breeze_level, reason = excluded.reason, actor_tag = excluded.actor_tag,
           starts_at_ms = excluded.starts_at_ms, created_at_ms = excluded.created_at_ms, expires_at_ms = excluded.expires_at_ms`,
        areaId,
        preset,
        spec.code,
        tempC,
        spec.precip_mm,
        spec.rain ? 1 : 0,
        spec.breeze_level,
        reason,
        actorTag,
        startsAt,
        now,
        expiresAt,
      );
    }
    if (isQingkongMode(c)) applyQingkongWeather(c, now);
    const resp: Record<string, unknown> = {
      ok: true,
      request_id: requestId,
      areas: targets,
      preset,
      starts_at_ms: startsAt,
      expires_at_ms: expiresAt,
      actor_tag: actorTag,
    };
    c.db.run(
      'INSERT INTO weather_override_receipts(request_id, payload_hash, response_json, actor_tag, created_at_ms) VALUES (?,?,?,?,?)',
      requestId,
      payloadHash,
      JSON.stringify(resp),
      actorTag,
      now,
    );
    return resp;
  });
  return out;
}

export function adminClearWeatherOverride(c: CityService, body: Record<string, unknown>, adminKey: string): Record<string, unknown> {
  const requestId = requireRequestId(body.request_id);
  const targets = parseAreaTarget(body.area);
  const payloadHash = sha256Hex(canonicalJson({ action: 'clear', area: body.area }));
  const replay = readReceipt(c, requestId, payloadHash);
  if (replay) return replay;

  const actorTag = actorTagOf(adminKey);
  const out = c.commit(() => {
    const existing = readReceipt(c, requestId, payloadHash);
    if (existing) return existing;
    const now = c.now();
    for (const areaId of targets) {
      c.db.run('DELETE FROM weather_overrides WHERE area = ?', areaId);
    }
    if (isQingkongMode(c)) {
      applyQingkongWeather(c, now);
    } else if (c.db.get("SELECT 1 AS x FROM weather_snapshots WHERE source = 'qingkong'")) {
      applyWeather(c, null, now);
    }
    const resp: Record<string, unknown> = {
      ok: true,
      request_id: requestId,
      cleared_areas: targets,
      weather_source: c.params.weatherSource,
      actor_tag: actorTag,
    };
    c.db.run(
      'INSERT INTO weather_override_receipts(request_id, payload_hash, response_json, actor_tag, created_at_ms) VALUES (?,?,?,?,?)',
      requestId,
      payloadHash,
      JSON.stringify(resp),
      actorTag,
      now,
    );
    return resp;
  });
  return out;
}
