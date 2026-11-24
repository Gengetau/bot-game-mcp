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
import {
  FARE_RULE_VERSION,
  HOUSE_ENTRANCE,
  TRANSIT_DEFAULT_HOURS,
  homeward,
  openAt,
  place,
  planRoute,
  station,
  transitEdgeBetween,
  transitEdgeOpenAt,
  type LegPlan,
  type Place,
  type RoutePlan,
  type TransitHours,
} from './catalog.js';
import { CityError, cityPrecondition } from './errors.js';
import { TRANSIT, ledger, purseOf, wallet } from './ledger.js';
import { card } from './residents.js';
import type { CityResident, CityService } from './service.js';
import { addWalk, afterMove, lastTrainSafeDepartMs, openVisitOf, outboxPurchase, progress, settle, transitWindowAt, visitById, wake, type VisitRow } from './visits.js';
import { isRaining } from './weather.js';

const MISSED_LAST_TRAIN_NOTE = '错过终电（铁道夜间停运），已按夜间无列车兜底归家，未搭乘停运列车、未扣回程车费。';

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
  /** 当前正处于铁道乘车段时：同线路同方向重叠时间窗内的匿名同行乘客数（不含自己） */
  same_car_travellers?: number;
  /** 当前正处于铁道乘车段时：克制的匿名车厢环境切片 */
  car_ambiance?: string;
  source: 'simulated';
  rule_version: string;
}

/** 检查一条路线在 departAtMs 出发时，其所有铁道乘车段上车时刻是否均处于模拟运营时间窗内。 */
export function routeTransitCheck(
  c: CityService,
  route: RoutePlan,
  departAtMs: number,
): { ok: true } | { ok: false; leg: LegPlan; boardAtMs: number; hours: TransitHours; line: string | null } {
  let curMs = departAtMs;
  for (const leg of route.legs) {
    if (leg.mode === 'train') {
      const check = transitEdgeOpenAt(leg.from, leg.to, c.minuteOfDay(curMs));
      if (!check.open) {
        return {
          ok: false,
          leg,
          boardAtMs: curMs,
          hours: check.hours,
          line: leg.line ?? check.edge?.line ?? null,
        };
      }
    }
    curMs += leg.minutes * 60_000;
  }
  return { ok: true };
}

/**
 * 校验一段尚未持久化上车的铁道乘车段此刻是否仍可实际登车：
 *  1. 计划上车时刻本身须在模拟运营窗内（plannedWin.open）；
 *  2. 实际处理时刻（effectiveNow = max(depart_at_ms, c.now())）须在运营窗内；
 *  3. 实际处理时刻不得跨过该计划班次所属运营日的终电收班线（effectiveNow < plannedWin.closeMs），
 *     防止在步行去车站途中停机、跨过终电后恢复时补记未曾发车的终电并误扣模拟票价。
 */
function canBoardTrainLegNow(
  c: CityService,
  leg: { from: string; to: string; depart_at_ms: number },
  actualNow: number = c.now(),
): boolean {
  const hours = transitEdgeBetween(leg.from, leg.to)?.hours ?? TRANSIT_DEFAULT_HOURS;
  const plannedWin = transitWindowAt(c.params.timezone, hours, leg.depart_at_ms);
  if (!plannedWin.open) return false;
  const effectiveNow = Math.max(leg.depart_at_ms, actualNow);
  if (!transitEdgeOpenAt(leg.from, leg.to, c.minuteOfDay(effectiveNow)).open) return false;
  if (effectiveNow >= plannedWin.closeMs) return false;
  return true;
}

/**
 * 判断一条回程路线在有效动身时刻 effectiveAt 是否已错过终电（或当前处于停运期）：
 * 纯步行回程恒返回 false；含铁道段时，若当前在停运窗、或相较原排程时刻 scheduledAt 已跨过当晚终电收班线，返回 true。
 */
export function routeReturnMissedLastTrain(
  c: CityService,
  route: RoutePlan,
  effectiveAt: number,
  scheduledAt?: number,
): boolean {
  if (!route.legs.some((l) => l.mode === 'train')) return false;
  if (!routeTransitCheck(c, route, effectiveAt).ok) return true;
  if (scheduledAt !== undefined && scheduledAt < effectiveAt) {
    let curSched = scheduledAt;
    for (const leg of route.legs) {
      if (leg.mode === 'train') {
        const hours = transitEdgeBetween(leg.from, leg.to)?.hours ?? TRANSIT_DEFAULT_HOURS;
        const win = transitWindowAt(c.params.timezone, hours, curSched);
        if (!win.open || effectiveAt >= win.closeMs) return true;
      }
      curSched += leg.minutes * 60_000;
    }
  }
  return false;
}

function carAmbiance(minuteOfDay: number, count: number): string {
  const lateNight = minuteOfDay >= 23 * 60 + 30 || minuteOfDay < 20;
  if (lateNight) {
    if (count === 0) return '终电前的车厢很安静，窗外只有掠过的街灯。';
    if (count <= 2) return '深夜的车厢里零星坐着几位同路乘客，各自安静看窗外。';
    return '赶末班车的乘客陆续上车，车厢里只有低低的轨道声。';
  }
  if (minuteOfDay >= 300 && minuteOfDay < 7 * 60) {
    return count === 0 ? '清晨的首班车厢空荡安静，晨光刚漫过窗沿。' : '早班电车上有几位早起的同路乘客，彼此安静擦肩。';
  }
  if (count === 0) return '这节车厢此刻很空，只有电车摇晃的节拍。';
  if (count <= 2) return '同一节车厢里有几位同向乘客，短暂同行、互不打扰。';
  return '车厢里有不少同向出行的乘客，随着报站声安静流动。';
}

/** 计算当前乘车段的只读匿名同车厢切片（仅在同一线路、同一有向区段、重叠时间窗且在城 running 时计数）。 */
function sameCarSlice(c: CityService, t: TripRow, legs: Leg[], at: number): { count: number; ambiance: string } | null {
  if (t.status !== 'running') return null;
  const cur = legs[t.leg_index];
  if (!cur || cur.mode !== 'train' || at < cur.depart_at_ms || at >= cur.arrive_at_ms) return null;
  const rows = c.db.all<{ resident_id: string; leg_index: number; legs_json: string } & Row>(
    `SELECT t.resident_id AS resident_id, t.leg_index AS leg_index, t.legs_json AS legs_json
     FROM trips t
     JOIN residents r ON r.resident_id = t.resident_id
     WHERE t.status = 'running' AND r.in_city = 1 AND t.resident_id <> ?`,
    t.resident_id,
  );
  const peers = new Set<string>();
  for (const row of rows) {
    const ol = parseJson<Leg[]>(row.legs_json, [])[row.leg_index];
    if (!ol || ol.mode !== 'train') continue;
    if ((ol.line ?? '') !== (cur.line ?? '') || ol.from !== cur.from || ol.to !== cur.to) continue;
    if (at < ol.depart_at_ms || at >= ol.arrive_at_ms) continue;
    if (ol.depart_at_ms < cur.arrive_at_ms && ol.arrive_at_ms > cur.depart_at_ms) {
      peers.add(row.resident_id);
    }
  }
  return { count: peers.size, ambiance: carAmbiance(c.minuteOfDay(at), peers.size) };
}

export function tripView(t: TripRow, c?: CityService, at?: number): TripView {
  const legs = legsOf(t);
  const slice = c ? sameCarSlice(c, t, legs, at ?? c.now()) : null;
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
    ...(slice ? { same_car_travellers: slice.count, car_ambiance: slice.ambiance } : {}),
    source: 'simulated',
    rule_version: t.rule_version,
  };
}

/**
 * 出发。调用方保证居民站在某个地点、没有进行中的行程。
 * 铁道运营时间窗按每段乘车的计划上车时刻（board_at_ms）对 travel 与 return 一致生效，停运时段绝不新发列车；
 * purpose=travel 时额外检查目的地（到达时刻营业、现在没满）、室友终电安全返家余量及回程车费预留。
 */
export function startTrip(c: CityService, r: CityResident, toId: string, purpose: 'travel' | 'return', at: number, visit: VisitRow | null): TripRow {
  const fromId = r.place_id;
  if (!fromId || r.trip_id) throw cityPrecondition('你还在路上，到了再说。', 'in_transit');
  if (fromId === toId) throw cityPrecondition('你已经在这里了。', 'already_here');
  const route = planRoute(fromId, toId);
  const dest = place(toId);
  if (!route || !dest) throw new CityError('NOT_FOUND', '没有这个地方，或者现在去不了。');
  const transitCheck = routeTransitCheck(c, route, at);
  if (!transitCheck.ok) {
    throw cityPrecondition(
      `现在电车已经停运了（首班 ${transitCheck.hours.first}，末班 ${transitCheck.hours.last}）。同片区步行和全天开放的地方照常能去。`,
      'transit_closed_night',
      {
        line: transitCheck.line,
        from: transitCheck.leg.from,
        to: transitCheck.leg.to,
        board_at_ms: transitCheck.boardAtMs,
        hours: transitCheck.hours,
        source: 'simulated',
      },
    );
  }
  if (purpose === 'travel') {
    const eta = at + route.minutes * 60_000;
    const enter = canEnter(c, dest, eta);
    if (!enter.ok) throw cityPrecondition(enter.message, enter.reason, { place: toId });
    if (visit) {
      const guard = lastTrainSafeDepartMs(c, toId, at, eta);
      if (guard && eta > guard.departByMs) {
        throw cityPrecondition(
          '太晚了，过去之后就赶不上回日和坂的末班电车了。',
          'last_train_cutoff',
          {
            destination: toId,
            eta_ms: eta,
            safe_depart_by_ms: guard.departByMs,
            last_train_close_ms: guard.closeMs,
            source: 'simulated',
          },
        );
      }
    }
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
  for (const fn of c.hooks.departPlace) fn(r.resident_id, fromId, purpose === 'return' ? 'trip_return' : 'trip_depart', at);
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
  c.emitTo([r.resident_id], 'trip_started', { trip: tripView(trip, c, at) }, at);
  beginLeg(c, trip, legs, 0, visit);
  return c.db.get<TripRow & Row>('SELECT * FROM trips WHERE trip_id = ?', tripId)!;
}

/** 开始第 n 段：乘车的那一段在上车时扣票价，然后排到站作业。 */
function beginLeg(c: CityService, trip: TripRow, legs: Leg[], n: number, visit: VisitRow | null): void {
  const leg = legs[n]!;
  const r = c.mustResident(trip.resident_id);
  if (leg.mode === 'train' && !canBoardTrainLegNow(c, leg, c.now())) {
    const actualAt = Math.max(leg.depart_at_ms, c.now());
    if (trip.purpose === 'return' || (visit && visit.state === 'returning')) {
      const stoppedRes = finishTrip(c, trip, 'stopped', actualAt, leg.from, 'missed_last_train');
      c.emitTo([trip.resident_id], 'trip_stopped', { trip_id: trip.trip_id, place: leg.from, reason: 'missed_last_train' }, actualAt);
      if (visit) {
        progress(c, visit, 'stopped', actualAt, { place: leg.from, reason: 'missed_last_train' });
        completeMissedLastTrainReturn(c, stoppedRes, visit, leg.from, actualAt, {
          emitLeftFromPlace: false,
          recordLeftPlace: false,
        });
      }
      return;
    }
    stopTrip(c, trip, leg.from, actualAt, 'transit_closed_night', visit);
    return;
  }
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
      const plannedTurnaround = Math.max(at, visit.returning_at ?? at);
      startReturnTrip(c, r, visit, Math.max(plannedTurnaround, c.now()), plannedTurnaround);
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
    for (const fn of c.hooks.arrivePlace) fn(r.resident_id, arriveAt, at);
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
  const st = station(p.station);
  return st && place(st.placeId) ? st.placeId : null;
}

function completeMissedLastTrainReturn(
  c: CityService,
  r: CityResident,
  visit: VisitRow,
  fromPlaceId: string,
  at: number,
  opts: { emitLeftFromPlace: boolean; recordLeftPlace: boolean },
): void {
  if (opts.emitLeftFromPlace && !place(fromPlaceId)?.hidden && r.in_city) {
    const others = c.presentAt(fromPlaceId).filter((x) => x.resident_id !== r.resident_id);
    c.emitTo(others.map((x) => x.resident_id), 'left', { who: card(r), place: fromPlaceId }, at);
  }
  c.db.run(
    'UPDATE residents SET place_id = ?, trip_id = NULL, revision = revision + 1 WHERE resident_id = ?',
    HOUSE_ENTRANCE,
    r.resident_id,
  );
  if (visit.return_reason === 'last_train') {
    c.db.run("UPDATE visits SET return_reason = 'missed_last_train' WHERE visit_id = ?", visit.visit_id);
  }
  const freshVisit = visitById(c, visit.visit_id)!;
  if (opts.recordLeftPlace) {
    progress(c, freshVisit, 'left_place', at, {
      place: fromPlaceId,
      to: HOUSE_ENTRANCE,
      eta_ms: at,
      purpose: 'return',
    });
  }
  progress(c, freshVisit, 'arrived_place', at, {
    place: HOUSE_ENTRANCE,
    reason: 'missed_last_train',
  });
  settle(c, freshVisit, at, {
    extraNotes: [MISSED_LAST_TRAIN_NOTE],
  });
}

/**
 * 走回小屋门口。已经在门口就直接结算；
 * 若因引擎停机或夜间召回导致出发时铁道已停运（错过终电），走无列车零扣费归家兜底：
 * 绝不凭空新发停运列车或误扣回程电车票价，同时将室友安全接回小屋门口结算，避免滞留外区。
 */
export function startReturnTrip(c: CityService, r: CityResident, visit: VisitRow, at: number, scheduledAt?: number): void {
  const effectiveAt = Math.max(at, c.now());
  const fromId = r.place_id;
  if (!fromId || fromId === HOUSE_ENTRANCE) {
    settle(c, visit, effectiveAt);
    return;
  }
  const route = planRoute(fromId, HOUSE_ENTRANCE);
  if (route && routeReturnMissedLastTrain(c, route, effectiveAt, scheduledAt)) {
    completeMissedLastTrainReturn(c, r, visit, fromId, effectiveAt, {
      emitLeftFromPlace: true,
      recordLeftPlace: true,
    });
    return;
  }
  startTrip(c, r, HOUSE_ENTRANCE, 'return', effectiveAt, visit);
}
