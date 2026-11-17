/**
 * 城市里的行程（规格 3.10）。
 *
 * 地点之间的移动一律是「行程」：步行到车站 → 乘车 → 步行到目的地。没有坐标、没有导航租约。
 * 行程一旦出发就是服务器的持久作业（scheduled_jobs 的 trip_leg）：每一段的出发和到达时刻在出发时就定下，
 * 没有人在线也照常到站；引擎重启后按 due_at 补跑，每一段的事件时间仍是原定的到达时刻。
 * 票价在上车时从随身钱包扣，原因键 trip:<trip_id>:leg:<n> 永久唯一，补跑不会重复扣费。
 *
 * 位置只由这个模块写（residents.place_id / trip_id）；进城、出城那两处在 residents.ts 和 visits.ts 里，也只调这里的函数。
 */
import { parseJson, type Row } from '../world/db.js';
import { FARE_RULE_VERSION, HOUSE_ENTRANCE, homeward, openAt, place, planRoute, type Place } from './catalog.js';
import { CityError, cityPrecondition } from './errors.js';
import { TRANSIT, ledger, purseOf, wallet } from './ledger.js';
import { card } from './residents.js';
import type { CityResident, CityService } from './service.js';
import { addWalk, afterMove, openVisitOf, outboxPurchase, progress, settle, visitById, wake, type VisitRow } from './visits.js';
import { isRaining } from './weather.js';

export interface Leg {
  n: number;
  mode: 'walk' | 'train';
  from: string;
  to: string;
  line?: string;
  minutes: number;
  fare_yen: number;
  depart_at_ms: number;
  arrive_at_ms: number;
  rule_version: string;
  /** 耗时和票价都是模拟值，不是真实时刻表和实时运价 */
  source: 'simulated';
}

export interface TripRow {
  trip_id: string;
  resident_id: string;
  visit_id: string | null;
  purpose: 'travel' | 'return';
  from_place: string;
  to_place: string;
  legs_json: string;
  leg_index: number;
  status: 'running' | 'arrived' | 'stopped' | 'cancelled' | 'diverted';
  stop_reason: string | null;
  started_at: number;
  ends_at: number;
  finished_at: number | null;
  rule_version: string;
  source: string;
}

export const legsOf = (t: TripRow): Leg[] => parseJson<Leg[]>(t.legs_json, []);

export function runningTrip(c: CityService, residentId: string): TripRow | undefined {
  return c.db.get<TripRow & Row>("SELECT * FROM trips WHERE resident_id = ? AND status = 'running'", residentId);
}

/** 回程预留按哪个地点算：站着就是脚下，在路上就是这趟行程的目的地（这一路的车费已经算进行程了）。 */
export function contextPlace(c: CityService, r: CityResident): string {
  if (r.place_id) return r.place_id;
  return runningTrip(c, r.resident_id)?.to_place ?? HOUSE_ENTRANCE;
}

/** 这位居民现在能花多少钱。室友在访问期间要留出回小屋门口的车费（规格 3.5、3.6）。 */
export function spendable(c: CityService, r: CityResident): { yen: number; returnReserveYen: number } {
  const w = wallet(c, r.resident_id);
  if (r.origin === 'house' && openVisitOf(c, r.resident_id)) {
    const reserve = homeward(contextPlace(c, r)).fareYen;
    return { yen: Math.max(0, w.available - reserve), returnReserveYen: reserve };
  }
  return { yen: Math.max(0, w.available), returnReserveYen: 0 };
}

/** 这个地点这一刻开不开（营业时间 + 雨天策略）。 */
export function placeOpen(c: CityService, p: Place, at: number): { open: boolean; why?: 'closed_hours' | 'closed_rain' } {
  if (!openAt(p, c.minuteOfDay(at))) return { open: false, why: 'closed_hours' };
  if (p.rain === 'closed' && isRaining(c, p.area)) return { open: false, why: 'closed_rain' };
  return { open: true };
}

/** 能不能进这个地点：开着、没满。车站和小屋门口总能进。 */
function canEnter(c: CityService, p: Place, at: number): { ok: true } | { ok: false; reason: string; message: string } {
  const o = placeOpen(c, p, at);
  if (!o.open) return o.why === 'closed_rain' ? { ok: false, reason: 'place_closed_rain', message: `下雨了，${p.name}暂时不开放。` } : { ok: false, reason: 'place_closed', message: `${p.name}那个时候不营业。` };
  if (c.headcount(p.id) >= p.capacity) return { ok: false, reason: 'place_full', message: `${p.name}现在满了。` };
  return { ok: true };
}

export interface TripView {
  trip_id: string;
  purpose: 'travel' | 'return';
  from: string;
  to: string;
  status: TripRow['status'];
  started_at_ms: number;
  ends_at_ms: number;
  fare_yen: number;
  minutes: number;
  leg_index: number;
  legs: Leg[];
  source: 'simulated';
  rule_version: string;
}

export function tripView(t: TripRow): TripView {
  const legs = legsOf(t);
  return {
    trip_id: t.trip_id,
    purpose: t.purpose,
    from: t.from_place,
    to: t.to_place,
    status: t.status,
    started_at_ms: t.started_at,
    ends_at_ms: t.ends_at,
    fare_yen: legs.reduce((n, l) => n + l.fare_yen, 0),
    minutes: legs.reduce((n, l) => n + l.minutes, 0),
    leg_index: t.leg_index,
    legs,
    source: 'simulated',
    rule_version: t.rule_version,
  };
}

/**
 * 出发。调用方保证居民站在某个地点、没有进行中的行程。
 * purpose=travel 时检查目的地（到达时刻营业、现在没满）和车费（室友还要留得出回程车费）；purpose=return 是回小屋门口，不检查。
 */
export function startTrip(c: CityService, r: CityResident, toId: string, purpose: 'travel' | 'return', at: number, visit: VisitRow | null): TripRow {
  const fromId = r.place_id;
  if (!fromId || r.trip_id) throw cityPrecondition('你还在路上，到了再说。', 'in_transit');
  if (fromId === toId) throw cityPrecondition('你已经在这里了。', 'already_here');
  const route = planRoute(fromId, toId);
  const dest = place(toId);
  if (!route || !dest) throw new CityError('NOT_FOUND', '没有这个地方，或者现在去不了。');
  if (purpose === 'travel') {
    const eta = at + route.minutes * 60_000;
    const enter = canEnter(c, dest, eta);
    if (!enter.ok) throw cityPrecondition(enter.message, enter.reason, { place: toId });
    const w = wallet(c, r.resident_id);
    const reserve = visit ? homeward(toId).fareYen : 0;
    if (w.available < route.fareYen) throw cityPrecondition(`车费不够：去${dest.name}要 ¥${route.fareYen}，你手上能动的只有 ¥${w.available}。`, 'insufficient_funds', { fare_yen: route.fareYen });
    if (w.available - route.fareYen < reserve) {
      throw cityPrecondition(`去了就回不了家：去${dest.name}要 ¥${route.fareYen}，从那里回家还要留 ¥${reserve}。`, 'return_fare_reserved', { fare_yen: route.fareYen, return_reserve_yen: reserve });
    }
  }
  let t = at;
  const legs: Leg[] = route.legs.map((l, n) => {
    const depart = t;
    t += l.minutes * 60_000;
    return { n, mode: l.mode, from: l.from, to: l.to, ...(l.line ? { line: l.line } : {}), minutes: l.minutes, fare_yen: l.fareYen, depart_at_ms: depart, arrive_at_ms: t, rule_version: FARE_RULE_VERSION, source: 'simulated' as const };
  });
  const tripId = c.id('trip');
  c.db.run(
    "INSERT INTO trips(trip_id, resident_id, visit_id, purpose, from_place, to_place, legs_json, leg_index, status, started_at, ends_at, rule_version, source) VALUES (?,?,?,?,?,?,?,0,'running',?,?,?,'simulated')",
    tripId,
    r.resident_id,
    visit?.visit_id ?? null,
    purpose,
    fromId,
    toId,
    JSON.stringify(legs),
    at,
    t,
    FARE_RULE_VERSION,
  );
  c.db.run('UPDATE residents SET place_id = NULL, trip_id = ?, revision = revision + 1 WHERE resident_id = ?', tripId, r.resident_id);
  // 别人只知道「走了」，不知道去哪儿（目的地可能是不公开的节点）
  if (!place(fromId)?.hidden && r.in_city) {
    const others = c.presentAt(fromId).filter((x) => x.resident_id !== r.resident_id);
    c.emitTo(others.map((x) => x.resident_id), 'left', { who: card(r), place: fromId }, at);
  }
  const trip = c.db.get<TripRow & Row>('SELECT * FROM trips WHERE trip_id = ?', tripId)!;
  if (visit) {
    progress(c, visit, fromId === HOUSE_ENTRANCE ? 'departed' : 'left_place', at, { place: fromId, to: toId, eta_ms: t, purpose });
    afterMove(c, visit, toId);
  }
  c.emitTo([r.resident_id], 'trip_started', { trip: tripView(trip) }, at);
  beginLeg(c, trip, legs, 0, visit);
  return c.db.get<TripRow & Row>('SELECT * FROM trips WHERE trip_id = ?', tripId)!;
}

/** 开始第 n 段：乘车的那一段在上车时扣票价，然后排到站作业。 */
function beginLeg(c: CityService, trip: TripRow, legs: Leg[], n: number, visit: VisitRow | null): void {
  const leg = legs[n]!;
  const r = c.mustResident(trip.resident_id);
  if (leg.mode === 'train' && leg.fare_yen > 0) {
    const w = wallet(c, r.resident_id);
    let pay = leg.fare_yen;
    if (trip.purpose === 'return') {
      // 回程用预留的车费。预留额由规则保证够；万一不够（不该发生），有多少付多少，人照样回家，差额记进日志等对账
      if (w.available < pay) {
        c.log(`[city] 回程车费不足：${trip.trip_id} 第 ${n} 段要 ¥${pay}，只有 ¥${w.available}`);
        pay = Math.max(0, w.available);
      }
    } else if (w.available < pay || (visit && w.available - pay < homeward(leg.to).fareYen)) {
      // 上车前再确认一次（出发时已经查过，这里只是兜底）：钱不够就不能上车，停在这一站
      stopTrip(c, trip, leg.from, leg.depart_at_ms, 'insufficient_fare', visit);
      return;
    }
    const posted = pay > 0 && ledger(c, `trip:${trip.trip_id}:leg:${n}`, 'fare', '电车', [[purseOf(r.resident_id), -pay], [TRANSIT, pay]], visit?.visit_id ?? null);
    if (visit && posted) outboxPurchase(c, visit, leg.depart_at_ms, { what: '电车', yen: -pay, detail: { line: leg.line ?? null, from: leg.from, to: leg.to, rule_version: leg.rule_version, source: 'simulated' } });
    if (visit) progress(c, visit, 'boarded', leg.depart_at_ms, { line: leg.line ?? null, from: leg.from, to: leg.to, eta_ms: leg.arrive_at_ms, fare_yen: pay });
  }
  c.db.run('UPDATE trips SET leg_index = ? WHERE trip_id = ?', n, trip.trip_id);
  c.schedule('trip_leg', `trip:${trip.trip_id}:leg:${n}`, leg.arrive_at_ms, { tripId: trip.trip_id, n });
}

function finishTrip(c: CityService, trip: TripRow, status: TripRow['status'], at: number, placeId: string, reason: string | null): CityResident {
  c.db.run('UPDATE trips SET status = ?, stop_reason = ?, finished_at = ? WHERE trip_id = ?', status, reason, at, trip.trip_id);
  c.db.run('UPDATE residents SET place_id = ?, trip_id = NULL, revision = revision + 1 WHERE resident_id = ?', placeId, trip.resident_id);
  return c.mustResident(trip.resident_id);
}

function announceArrival(c: CityService, r: CityResident, placeId: string, at: number): void {
  if (place(placeId)?.hidden || !r.in_city) return;
  const others = c.presentAt(placeId).filter((x) => x.resident_id !== r.resident_id);
  c.emitTo(others.map((x) => x.resident_id), 'arrived', { who: card(r), place: placeId }, at);
}

/** 行程中途停下（钱不够上车）：人留在这一段的起点。 */
function stopTrip(c: CityService, trip: TripRow, placeId: string, at: number, reason: string, visit: VisitRow | null): void {
  const r = finishTrip(c, trip, 'stopped', at, placeId, reason);
  announceArrival(c, r, placeId, at);
  c.emitTo([r.resident_id], 'trip_stopped', { trip_id: trip.trip_id, place: placeId, reason }, at);
  if (visit) {
    progress(c, visit, 'stopped', at, { place: placeId, reason });
    wake(c, visit, 'trip_stopped', at, { place: placeId, reason });
    afterMove(c, visit, placeId);
  }
}

export function installTrips(c: CityService): void {
  c.jobHandlers.set('trip_leg', (payload) => {
    const trip = c.db.get<TripRow & Row>('SELECT * FROM trips WHERE trip_id = ?', String(payload.tripId));
    const n = Number(payload.n);
    if (!trip || trip.status !== 'running' || trip.leg_index !== n) return;
    const legs = legsOf(trip);
    const leg = legs[n];
    if (!leg) return;
    // 事件时间是原定的到达时刻：停机后补跑也一样（已出发的电车照常到站）
    const at = leg.arrive_at_ms;
    let visit = trip.visit_id ? (visitById(c, trip.visit_id) ?? null) : null;
    if (visit && leg.mode === 'walk') {
      addWalk(c, visit, leg.minutes, at);
      visit = visitById(c, visit.visit_id)!;
    }
    const last = n === legs.length - 1;

    // 路上被叫回家（到点、内核要求、她自己决定）：这一段照常走完，到了就改走回程
    if (visit && visit.state === 'returning' && trip.purpose !== 'return') {
      const r = finishTrip(c, trip, 'cancelled', at, leg.to, 'returning');
      progress(c, visit, last ? 'arrived_place' : 'arrived_station', at, { place: leg.to });
      startReturnTrip(c, r, visit, Math.max(at, visit.returning_at ?? at));
      return;
    }

    if (!last) {
      if (visit) progress(c, visit, 'arrived_station', at, { place: leg.to });
      c.emitTo([trip.resident_id], 'trip_progress', { trip_id: trip.trip_id, at_place: leg.to, next: legs[n + 1] }, at);
      beginLeg(c, trip, legs, n + 1, visit);
      return;
    }

    // 最后一段：到了
    const dest = place(trip.to_place)!;
    let arriveAt = dest.id;
    let status: TripRow['status'] = 'arrived';
    let diverted: string | null = null;
    if (trip.purpose === 'travel' && dest.type !== 'station') {
      const enter = canEnter(c, dest, at);
      if (!enter.ok) {
        // 到了才发现进不去（关门了、满了、下雨不开放）：留在最近的车站
        const sp = place(leg.to === dest.id ? leg.from : leg.to);
        arriveAt = sp && sp.type === 'station' ? sp.id : (PLACE_OF_STATION(dest) ?? dest.id);
        status = 'diverted';
        diverted = enter.reason;
      }
    }
    const r = finishTrip(c, trip, status, at, arriveAt, diverted);
    announceArrival(c, r, arriveAt, at);
    c.emitTo([r.resident_id], 'you_arrived', { trip_id: trip.trip_id, place: arriveAt, ...(diverted ? { diverted_from: dest.id, reason: diverted } : {}) }, at);
    if (!visit) return;
    progress(c, visit, 'arrived_place', at, { place: arriveAt, ...(diverted ? { diverted_from: dest.id, reason: diverted } : {}) });
    if (trip.purpose === 'return') {
      if (arriveAt === HOUSE_ENTRANCE) settle(c, visit, at);
      return;
    }
    wake(c, visit, diverted ? 'diverted' : 'arrived', at, { place: arriveAt, ...(diverted ? { reason: diverted } : {}) });
    afterMove(c, visit, arriveAt);
  });
}

/** 一个地点最近的车站对应的地点编号。 */
function PLACE_OF_STATION(p: Place): string | null {
  const id = `${p.area}:station`;
  return place(id) ? id : null;
}

/** 走回小屋门口。已经在门口就直接结算。 */
export function startReturnTrip(c: CityService, r: CityResident, visit: VisitRow, at: number): void {
  if (r.place_id === HOUSE_ENTRANCE) {
    settle(c, visit, at);
    return;
  }
  startTrip(c, r, HOUSE_ENTRANCE, 'return', at, visit);
}
