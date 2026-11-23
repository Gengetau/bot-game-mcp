/**
 * 外出访问（规格第 3 节）：小屋的一位室友一次从家门口交给城市、再交回家门口的完整过程。
 *
 * 引擎侧的状态：prepared → active → returning → settled → closed / reconcile；commit 之前可以 aborted。
 * （settling 是协议里的状态名：到达小屋门口、生成结算清单、写 visit_settled 在同一个事务里完成，所以库里不会停在 settling。）
 *
 * 事实归属（规格第 2 节）：访问期间她的位置、随身钱包、带出来的物品由这里写；她的身体、家里的钱、计划由内核写。
 * 引擎不替她算身体：吃了什么、走了多久只写成 body_effect 记录，由内核按自己的规则结算。
 * 引擎不主动调内核：内核需要知道的事都写进 bridge_outbox（带递增 seq），和对应的状态变化同一事务提交。
 */
import { parseJson, type Row } from '../world/db.js';
import { sha256, stableStringify } from '../world/service.js';
import { localParts, localToUtc, nextDate } from '../world/time.js';
import {
  CITY_CATALOG_VERSION,
  HOUSE_ENTRANCE,
  TRANSIT_DEFAULT_HOURS,
  clockMinutes,
  homeward,
  isCarryHome,
  itemName,
  place,
  planRoute,
  publicPlace,
  transitEdgeBetween,
  type TransitHours,
} from './catalog.js';
import { CityError, cityBadRequest, cityConflict, cityPrecondition } from './errors.js';
import { BRIDGE, addCarried, disposeHeldItem, ensurePurse, heldItems, ledger, moveItemToLocker, purseOf, sanitizeItemMeta, spendSummary, trustedAssetIdOf, wallet, type ItemRow } from './ledger.js';
import { MAPPINGS, engineTypeOf, kernelItemOf, walkEffect } from './mappings.js';
import { runReconcile } from './reconcile.js';
import type { CityResident, CityService } from './service.js';
import { routeReturnMissedLastTrain, runningTrip, startReturnTrip, startTrip } from './trips.js';

export const BRIDGE_PROTOCOL = 'city-bridge/1';
/** 桥接请求号：比居民动作的请求号宽一些（visit:<visit_id>:d<n>:a<n>） */
export const BRIDGE_REQUEST_ID_RE = /^[\w.:-]{8,160}$/;
const VISIT_ID_RE = /^[\w.:-]{4,80}$/;

export type VisitState = 'prepared' | 'active' | 'returning' | 'settling' | 'settled' | 'closed' | 'reconcile' | 'aborted';

export interface VisitRow {
  visit_id: string;
  actor_id: string;
  resident_id: string;
  state: VisitState;
  protocol: string;
  vocab_version: string | null;
  city_catalog_version: string;
  mappings_version: number;
  carry_yen: number;
  carry_items_json: string;
  plan_json: string;
  source_hold_ref: string | null;
  transfer_id: string | null;
  domain_epoch: number | null;
  return_by_ms: number;
  return_reason: string | null;
  settlement_id: string | null;
  settlement_json: string | null;
  purse_final_yen: number | null;
  walk_minutes: number;
  record_seq: number;
  wake_chat_pending: number;
  prepared_at: number;
  committed_at: number | null;
  returning_at: number | null;
  settled_at: number | null;
  released_at: number | null;
  aborted_at: number | null;
}

export interface CarryItem {
  /** 内核资源 ID */
  ref: string;
  kernel: { kind: string; item: string };
  qty: number;
  engine_type: string;
  meta?: Record<string, unknown> | null;
}

export interface VisitPlan {
  destination: string;
  start_at_ms: number;
  return_by_ms: number;
}

export function visitById(c: CityService, visitId: string): VisitRow | undefined {
  return c.db.get<VisitRow & Row>('SELECT * FROM visits WHERE visit_id = ?', visitId);
}

/** 这位室友此刻在城里的那次访问（active / returning）。不在城里返回 undefined。 */
export function openVisitOf(c: CityService, residentId: string): VisitRow | undefined {
  return c.db.get<VisitRow & Row>("SELECT * FROM visits WHERE resident_id = ? AND state IN ('active','returning')", residentId);
}

// ───────────────────────── outbox ─────────────────────────

function nextRecordId(c: CityService, visit: VisitRow): string {
  const { record_seq } = c.db.get<{ record_seq: number }>('UPDATE visits SET record_seq = record_seq + 1 WHERE visit_id = ? RETURNING record_seq', visit.visit_id)!;
  return `${visit.visit_id}:e${record_seq}`;
}

/** 写一条桥接 outbox 记录。record_id 唯一；和调用方的状态变化同一事务提交。返回 record_id。 */
function outbox(c: CityService, visit: VisitRow, kind: string, occurredAt: number, payload: Record<string, unknown>, recordId?: string): string {
  const id = recordId ?? nextRecordId(c, visit);
  c.db.run('INSERT INTO bridge_outbox(visit_id, kind, record_id, occurred_at_ms, payload) VALUES (?,?,?,?,?)', visit.visit_id, kind, id, Math.round(occurredAt), JSON.stringify({ actor_id: visit.actor_id, ...payload }));
  c.bumpOutbox();
  return id;
}

/** 给人看的一句位置说明（投影）：「在棱光街·喫茶「灯」」「乘车中，预计 14:20 到棱光街站」。 */
function statusText(c: CityService, phase: string, data: Record<string, unknown>): string {
  const name = (id: unknown): string => {
    const p = typeof id === 'string' ? place(id) : undefined;
    if (!p) return '';
    return p.type === 'station' || p.hidden ? p.name : `${areaName(p.area)}·${p.name}`;
  };
  switch (phase) {
    case 'departed':
      return `出门了，往${name(data.to)}去`;
    case 'left_place':
      return `离开${name(data.place)}，往${name(data.to)}去`;
    case 'boarded':
      return `乘车中（${String(data.line ?? '电车')}），预计 ${c.clock(Number(data.eta_ms))} 到${name(data.to)}`;
    case 'arrived_station':
      return `到了${name(data.place)}`;
    case 'arrived_place':
      return data.place === HOUSE_ENTRANCE ? '到家门口了' : `在${name(data.place)}`;
    case 'stopped':
      return `停在${name(data.place)}`;
    default:
      return '';
  }
}

const areaName = (id: string): string => ({ hiyorizaka: '日和坂', ryokogai: '棱光街', kumominato: '云港' })[id] ?? id;

/** 行程进度（出发、上车、到站、到达地点、离开地点）。内核用它更新投影。 */
export function progress(c: CityService, visit: VisitRow, phase: 'departed' | 'left_place' | 'boarded' | 'arrived_station' | 'arrived_place' | 'stopped', at: number, data: Record<string, unknown>): void {
  outbox(c, visit, 'visit_progress', at, { phase, ...data, text: statusText(c, phase, data) });
}

/** 城里发生了值得她做决定的事。 */
export function wake(c: CityService, visit: VisitRow, reason: string, at: number, data: Record<string, unknown> = {}): void {
  // reason 是固定的几种唤醒原因；调用方带来的细分原因（place_closed、return_fare_reserved……）放在 why 里，不能盖住它
  const { reason: why, ...rest } = data;
  outbox(c, visit, 'decision_wake', at, { reason, ...rest, ...(why !== undefined ? { why } : {}) });
}

/** 随身钱包的一笔支出或收入（只做投影和当天账目展示，不改内核余额）。 */
export function outboxPurchase(c: CityService, visit: VisitRow, at: number, data: { what: string; yen: number; detail?: Record<string, unknown> }): void {
  outbox(c, visit, 'purchase', at, { what: data.what, yen: data.yen, purse_yen: wallet(c, visit.resident_id).balance, ...(data.detail ?? {}) });
}

/** 访问关单后未决订单确认为 failed：钱退回桥接账户，写一条幂等 order_refunded 供内核补回家庭钱包。 */
export function outboxOrderRefunded(
  c: CityService,
  visit: VisitRow,
  at: number,
  data: { order_id: string; yen: number; all_pending_cleared: boolean },
): string {
  return outbox(c, visit, 'order_refunded', at, data, `${visit.visit_id}:refund:${data.order_id}`);
}

/** 身体效果：吃喝、步行、活动。effect_id = <visit_id>:<引擎记录号>，内核按它去重。返回 effect_id。 */
export function bodyEffect(c: CityService, visit: VisitRow, at: number, effect: { engine_kind: 'ate' | 'drank' | 'walked'; engine_type?: string; qty?: number; minutes?: number; kernel_effect: string | null }): string {
  const effectId = nextRecordId(c, visit);
  outbox(c, visit, 'body_effect', at, { effect_id: effectId, ...effect }, effectId);
  return effectId;
}

/** 累计步行时间；每满一个单位（映射表的 min_minutes）写一条 walked。 */
export function addWalk(c: CityService, visit: VisitRow, minutes: number, at: number): void {
  const unit = walkEffect();
  let acc = visit.walk_minutes + minutes;
  if (unit) {
    while (acc >= unit.minutes) {
      bodyEffect(c, visit, at, { engine_kind: 'walked', minutes: unit.minutes, kernel_effect: unit.kernel_effect });
      acc -= unit.minutes;
    }
  }
  c.db.run('UPDATE visits SET walk_minutes = ? WHERE visit_id = ?', acc, visit.visit_id);
}

/** 听到有人说话：同一段安静里只叫一次，她做了下一个动作之后才会再叫。 */
export function wakeForChat(c: CityService, visit: VisitRow, at: number, data: Record<string, unknown>): void {
  if (visit.wake_chat_pending) return;
  c.db.run('UPDATE visits SET wake_chat_pending = 1 WHERE visit_id = ?', visit.visit_id);
  wake(c, visit, 'heard_chat', at, data);
}

export function clearChatWake(c: CityService, visit: VisitRow): void {
  if (visit.wake_chat_pending) c.db.run('UPDATE visits SET wake_chat_pending = 0 WHERE visit_id = ?', visit.visit_id);
}

/**
 * 当面交谈的记录：她和某位居民在同一个地点各说过一句（对方在场时），就是「第一次当面交谈」，每次访问每个人只记一次。
 * 只带对方的显示名和地点，不带对方的任何私有信息。
 */
export function noteSpeech(c: CityService, visit: VisitRow, other: CityResident, who: 'she' | 'other', placeId: string, at: number): void {
  c.db.run('INSERT OR IGNORE INTO visit_encounters(visit_id, other_id) VALUES (?,?)', visit.visit_id, other.resident_id);
  c.db.run(`UPDATE visit_encounters SET ${who === 'she' ? 'she_spoke' : 'other_spoke'} = 1 WHERE visit_id = ? AND other_id = ?`, visit.visit_id, other.resident_id);
  const row = c.db.get<{ she_spoke: number; other_spoke: number; emitted: number }>('SELECT she_spoke, other_spoke, emitted FROM visit_encounters WHERE visit_id = ? AND other_id = ?', visit.visit_id, other.resident_id)!;
  if (row.she_spoke && row.other_spoke && !row.emitted) {
    c.db.run('UPDATE visit_encounters SET emitted = 1 WHERE visit_id = ? AND other_id = ?', visit.visit_id, other.resident_id);
    const p = place(placeId);
    outbox(c, visit, 'encounter', at, { with: { name: other.name }, place: placeId, place_name: p?.name ?? placeId, area: p?.area ?? null });
  }
}

// ───────────────────────── 自动回程 ─────────────────────────

/**
 * 计算参考时刻所在（或刚刚结束）的铁道运营窗口起止 UTC 毫秒时间戳。
 * 跨午夜运营窗（如 05:00–00:20）：
 *  - 05:00..23:59：当日 05:00 开启，次日 00:20 收班；
 *  - 00:00..00:19（跨午夜终电前）：前一日 05:00 开启，当日 00:20 收班；
 *  - 00:20..04:59（夜间停运期）：上一运营窗已于当日 00:20 收班（closeMs <= refMs）。
 */
export function transitWindowAt(
  tz: string,
  hours: TransitHours,
  refMs: number,
): { open: boolean; openMs: number; closeMs: number } {
  const p = localParts(tz, refMs);
  const min = p.hour * 60 + p.minute;
  const f = clockMinutes(hours.first);
  const l = clockMinutes(hours.last);
  const fh = Math.floor(f / 60);
  const fm = f % 60;
  const lh = Math.floor(l / 60);
  const lm = l % 60;
  if (f <= l) {
    const openMs = localToUtc(tz, p.date, fh, fm);
    const closeMs = localToUtc(tz, p.date, lh, lm);
    return { open: min >= f && min < l, openMs, closeMs };
  }
  if (min >= f) {
    return {
      open: true,
      openMs: localToUtc(tz, p.date, fh, fm),
      closeMs: localToUtc(tz, nextDate(p.date, 1), lh, lm),
    };
  }
  if (min < l) {
    return {
      open: true,
      openMs: localToUtc(tz, nextDate(p.date, -1), fh, fm),
      closeMs: localToUtc(tz, p.date, lh, lm),
    };
  }
  return {
    open: false,
    openMs: localToUtc(tz, nextDate(p.date, -1), fh, fm),
    closeMs: localToUtc(tz, p.date, lh, lm),
  };
}

/**
 * 从某个地点回日和坂小屋门口，在当前运营日终电停运前安全踏上归途的最晚动身时刻。
 * 同片区纯步行返家（无需乘车）返回 null；含铁道乘车段时，确保每一段乘车都在末班截止前至少留出安全余量（不少于 1 分钟）。
 */
export function lastTrainSafeDepartMs(
  c: CityService,
  fromPlaceId: string,
  refMs: number = c.now(),
  arrivalAtMs?: number,
): { departByMs: number; closeMs: number } | null {
  if (fromPlaceId === HOUSE_ENTRANCE) return null;
  const r = planRoute(fromPlaceId, HOUSE_ENTRANCE);
  if (!r) return null;
  const marginMs = Math.max(60_000, c.params.returnMarginMs);
  let offsetMin = 0;
  let best: { departByMs: number; closeMs: number } | null = null;
  for (const leg of r.legs) {
    if (leg.mode === 'train') {
      const hours = transitEdgeBetween(leg.from, leg.to)?.hours ?? TRANSIT_DEFAULT_HOURS;
      const winAt = transitWindowAt(c.params.timezone, hours, refMs);
      // 若出发时刻处于夜间停运窗（如 04:50 步行去车站衔接 05:00+ 首班车），按实际抵达时刻所在的新运营窗计算当晚终电
      const win =
        !winAt.open && arrivalAtMs !== undefined && arrivalAtMs > refMs
          ? transitWindowAt(c.params.timezone, hours, arrivalAtMs)
          : winAt;
      const departByMs = win.closeMs - offsetMin * 60_000 - marginMs;
      if (!best || departByMs < best.departByMs) {
        best = { departByMs, closeMs: win.closeMs };
      }
    }
    offsetMin += leg.minutes;
  }
  return best;
}

/** 室友访问的实际自动返程截止时刻：min(原访问到期时刻回推, 当日终电前安全返程最晚动身时刻)。 */
export function effectiveVisitReturnSchedule(
  c: CityService,
  visit: VisitRow,
  contextPlaceId: string,
  refMs: number = c.now(),
): { dueMs: number; reason: 'return_by' | 'last_train'; lastTrainCloseMs: number | null } {
  const normalDue = visit.return_by_ms - homeward(contextPlaceId).minutes * 60_000 - c.params.returnMarginMs;
  const trip = runningTrip(c, visit.resident_id);
  const arrivalAtMs = trip && trip.purpose === 'travel' && trip.to_place === contextPlaceId ? trip.ends_at : undefined;
  const guard = lastTrainSafeDepartMs(c, contextPlaceId, refMs, arrivalAtMs);
  if (guard && guard.departByMs < normalDue) {
    return { dueMs: guard.departByMs, reason: 'last_train', lastTrainCloseMs: guard.closeMs };
  }
  return { dueMs: normalDue, reason: 'return_by', lastTrainCloseMs: guard?.closeMs ?? null };
}

/**
 * 她的位置（或正在去的目的地）变了：重排「到点回家」的作业。
 * 出发时刻取 min(原访问到期回推时刻, 当日终电前安全返程最晚动身时刻)。已经过了就立刻到期。
 */
export function afterMove(c: CityService, visit: VisitRow, contextPlaceId: string): void {
  const fresh = visitById(c, visit.visit_id);
  if (!fresh || fresh.state !== 'active') return;
  const key = `visit:${fresh.visit_id}:return`;
  const existing = c.db.get<{ due_at: number }>("SELECT due_at FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", key);
  if (existing && Number(existing.due_at) <= c.now()) return;
  const sched = effectiveVisitReturnSchedule(c, fresh, contextPlaceId, c.now());
  c.reschedule('visit_return', key, sched.dueMs, { visitId: fresh.visit_id, reason: sched.reason });
}

/** 进入 returning：不再接受新交易和新动作；回程行程开始（在路上的话，这一段走完就改走回程）。 */
export function beginReturn(c: CityService, visit: VisitRow, reason: string, at: number, scheduledAt?: number): boolean {
  const fresh = visitById(c, visit.visit_id);
  if (!fresh || fresh.state !== 'active') return false;
  const r = c.mustResident(fresh.resident_id);
  const departAt = Math.max(at, c.now());
  const fromPlace = r.place_id ?? runningTrip(c, r.resident_id)?.to_place ?? null;
  let effectiveReason = reason;
  if (fromPlace && fromPlace !== HOUSE_ENTRANCE && reason === 'last_train') {
    const route = planRoute(fromPlace, HOUSE_ENTRANCE);
    if (route && routeReturnMissedLastTrain(c, route, departAt, scheduledAt)) {
      effectiveReason = 'missed_last_train';
    }
  }
  const cleanReason = effectiveReason.slice(0, 120);
  c.db.run("UPDATE visits SET state = 'returning', return_reason = ?, returning_at = ? WHERE visit_id = ?", cleanReason, departAt, fresh.visit_id);
  c.cancelJob(`visit:${fresh.visit_id}:return`);
  const returning = visitById(c, fresh.visit_id)!;
  for (const fn of c.hooks.departPlace) fn(r.resident_id, r.place_id, `return:${cleanReason}`, departAt);
  outbox(c, returning, 'return_started', departAt, { reason: cleanReason, from: fromPlace });
  c.emitTo([r.resident_id], 'returning', { reason: cleanReason, return_by_ms: fresh.return_by_ms }, departAt);
  // 站在某个地点：立刻动身。在路上：这一段照常走完，到站作业会改走回程（trips.ts）
  if (r.place_id) startReturnTrip(c, r, returning, departAt, scheduledAt);
  return true;
}

// ───────────────────────── 结算 ─────────────────────────

export interface Settlement {
  settlement_id: string;
  visit_id: string;
  actor_id: string;
  /** 这次访问在 visit_settled 之前的最后一条 outbox 记录的 seq */
  cutoff_seq: number;
  carry_yen: number;
  purse_final_yen: number;
  items: {
    engine_item_id: string;
    origin_ref: string | null;
    type: string;
    qty: number;
    fate: 'back' | 'consumed' | 'given' | 'sold' | 'locker' | 'disposed';
    kernel?: { kind: string; item: string };
    instance?: boolean;
    meta?: Record<string, unknown> | null;
  }[];
  consumed: { type: string; qty: number; effect_id: string | null; origin_ref: string | null }[];
  given: { type: string; qty: number; origin_ref: string | null; to: string }[];
  pending: { order_id: string; what: string; yen: number; place: string }[];
  spend_summary: { what: string; yen: number }[];
  notes?: string[];
  settled_at_ms: number;
}

/**
 * 到达小屋门口：在一个事务里生成结算清单、写 visit_settled、状态变成 settled。之后她在城里不能再做任何动作，等内核确认。
 * 结算清单一旦写入不再改。
 */
export function settle(c: CityService, visit: VisitRow, at: number, opts?: { extraNotes?: readonly string[] }): Settlement {
  const fresh = visitById(c, visit.visit_id)!;
  if (fresh.state !== 'returning' && fresh.state !== 'active') throw new Error(`访问 ${fresh.visit_id} 不在可结算的状态：${fresh.state}`);
  const w = wallet(c, fresh.resident_id);
  const items: Settlement['items'] = [];
  const notes: string[] = [...(opts?.extraNotes ?? [])];
  for (const it of heldItems(c, fresh.resident_id)) {
    const meta = it.instance === 1 ? parseJson<Record<string, unknown> | null>(it.meta_json, null) : null;
    if (!isCarryHome(it.type)) {
      // carry_home: false 的现点杯装热饮：返家前清理，绝不代喝写 body_effect，也不进储物柜
      notes.push(`未饮完的${itemName(it.type)}（${it.quantity} 份）已在返家前处理，未带回或寄存。`);
      items.push({
        engine_item_id: it.item_id,
        origin_ref: it.origin_ref,
        type: it.type,
        qty: it.quantity,
        fate: 'disposed',
        ...(meta ? { instance: true, meta } : {}),
      });
      continue;
    }
    const rawKernel = kernelItemOf(it.type);
    let resolvedKernel = rawKernel;
    if (it.origin_ref === null && rawKernel?.kind === 'wardrobe_asset') {
      const aid = trustedAssetIdOf(it);
      resolvedKernel = aid ? { kind: 'wardrobe_asset', item: aid } : null;
    }
    // 带出来的物品原样回家；城里得到的要映射表里有（且具名服饰具备可信 asset_id）才能回家，否则留在城市储物柜
    const fate = it.origin_ref !== null || resolvedKernel ? 'back' : 'locker';
    items.push({
      engine_item_id: it.item_id,
      origin_ref: it.origin_ref,
      type: it.type,
      qty: it.quantity,
      fate,
      ...(resolvedKernel && it.origin_ref === null ? { kernel: resolvedKernel } : {}),
      ...(meta ? { instance: true, meta } : {}),
    });
  }
  // 本次访问期间她在车站主动存入储物柜且仍留在柜中的物品，也记入结算摘要（fate = 'locker'）
  const manualStored = c.db.all<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND visit_id = ? AND state = 'locker' AND quantity > 0 ORDER BY item_id",
    fresh.resident_id,
    fresh.visit_id,
  );
  for (const it of manualStored) {
    const meta = it.instance === 1 ? parseJson<Record<string, unknown> | null>(it.meta_json, null) : null;
    items.push({
      engine_item_id: it.item_id,
      origin_ref: null,
      type: it.type,
      qty: it.quantity,
      fate: 'locker',
      ...(meta ? { instance: true, meta } : {}),
    });
  }
  const moves = c.db.all<Row>("SELECT item_id, type, origin_ref, quantity, fate, effect_id, counterparty FROM item_events WHERE visit_id = ? AND resident_id = ? AND fate IN ('consumed','given','sold') ORDER BY event_id", fresh.visit_id, fresh.resident_id);
  const consumed: Settlement['consumed'] = [];
  const given: Settlement['given'] = [];
  for (const m of moves) {
    items.push({ engine_item_id: String(m.item_id), origin_ref: m.origin_ref as string | null, type: String(m.type), qty: Number(m.quantity), fate: m.fate as 'consumed' | 'given' | 'sold' });
    if (m.fate === 'consumed') consumed.push({ type: String(m.type), qty: Number(m.quantity), effect_id: (m.effect_id as string | null) ?? null, origin_ref: m.origin_ref as string | null });
    if (m.fate === 'given') given.push({ type: String(m.type), qty: Number(m.quantity), origin_ref: m.origin_ref as string | null, to: c.resident(String(m.counterparty))?.name ?? '' });
  }
  const pending = c.db
    .all<Row>("SELECT order_id, sku, type, quantity, yen, place_id FROM orders WHERE visit_id = ? AND status = 'pending' ORDER BY created_at, order_id", fresh.visit_id)
    .map((o) => ({ order_id: String(o.order_id), what: itemName(String(o.type)), yen: Number(o.yen), place: String(o.place_id) }));
  const settlement: Settlement = {
    settlement_id: c.id('set'),
    visit_id: fresh.visit_id,
    actor_id: fresh.actor_id,
    cutoff_seq: c.db.scalar('SELECT COALESCE(MAX(seq), 0) FROM bridge_outbox WHERE visit_id = ?', fresh.visit_id),
    carry_yen: fresh.carry_yen,
    // 能带回家的钱：被结果未知的交易锁住的那部分留在城里等对账
    purse_final_yen: w.available,
    items,
    consumed,
    given,
    pending,
    spend_summary: spendSummary(c, fresh.visit_id, fresh.resident_id),
    ...(notes.length > 0 ? { notes } : {}),
    settled_at_ms: at,
  };
  c.db.run(
    "UPDATE visits SET state = 'settled', settlement_id = ?, settlement_json = ?, purse_final_yen = ?, settled_at = ?, returning_at = COALESCE(returning_at, ?) WHERE visit_id = ?",
    settlement.settlement_id,
    JSON.stringify(settlement),
    settlement.purse_final_yen,
    at,
    at,
    fresh.visit_id,
  );
  c.db.run('UPDATE residents SET in_city = 0, revision = revision + 1 WHERE resident_id = ?', fresh.resident_id);
  c.cancelJob(`visit:${fresh.visit_id}:return`);
  outbox(c, visitById(c, fresh.visit_id)!, 'visit_settled', at, { ...settlement }, `${fresh.visit_id}:settled`);
  c.emitTo([fresh.resident_id], 'visit_settled', { visit_id: fresh.visit_id }, at);
  return settlement;
}

// ───────────────────────── 回执 ─────────────────────────

export interface BridgeReceipt {
  receipt_id: string;
  request_id: string;
  visit_id: string;
  state: string;
  accepted_at_ms: number;
  payload: Record<string, unknown>;
  replayed?: true;
}

/** 规范化 JSON 的 SHA-256：请求体去掉 request_id 和 payload_hash 之后，键按字典序、无空白。 */
export function bridgePayloadHash(body: Record<string, unknown>): string {
  const { request_id: _r, payload_hash: _h, ...rest } = body;
  return sha256(stableStringify(rest));
}

/**
 * 桥接写请求的统一外壳：校验请求号和内容哈希 → 查永久回执（同号同内容返回原回执，同号不同内容 409）→ 执行 → 写回执。
 * 执行和回执在同一个事务里。执行抛错时不留回执：调用方修正后可以用同一个请求号再试。
 */
export function withReceipt(c: CityService, op: string, visitId: string, body: Record<string, unknown>, run: () => { state: string; payload: Record<string, unknown> }): BridgeReceipt {
  const requestId = typeof body.request_id === 'string' ? body.request_id : '';
  if (!BRIDGE_REQUEST_ID_RE.test(requestId)) throw cityBadRequest('需要 request_id（8~160 个字母、数字或 -_.:）。重试用同一个。');
  if (!VISIT_ID_RE.test(visitId)) throw cityBadRequest('visit_id 不合法。');
  const hash = bridgePayloadHash(body);
  if (body.payload_hash !== undefined && body.payload_hash !== hash) {
    throw new CityError('BAD_REQUEST', 'payload_hash 和请求内容对不上。', 'payload_hash_mismatch', { expected: hash });
  }
  c.metrics.bridgeRequests++;
  return c.commit(() => {
    const existing = c.db.get<Row>('SELECT * FROM bridge_receipts WHERE request_id = ?', requestId);
    if (existing) {
      if (existing.payload_hash !== hash || existing.op !== op || existing.visit_id !== visitId) {
        throw cityConflict('这个请求号已经用于另一个不同的请求。', 'request_conflict');
      }
      c.metrics.replays++;
      return { ...parseJson<BridgeReceipt>(existing.response as string, {} as BridgeReceipt), replayed: true as const };
    }
    c.assertRunning();
    const out = run();
    const receipt: BridgeReceipt = { receipt_id: c.id('rcpt'), request_id: requestId, visit_id: visitId, state: out.state, accepted_at_ms: c.now(), payload: out.payload };
    c.db.run('INSERT INTO bridge_receipts(request_id, receipt_id, op, visit_id, payload_hash, state, accepted_at_ms, response) VALUES (?,?,?,?,?,?,?,?)', requestId, receipt.receipt_id, op, visitId, hash, out.state, receipt.accepted_at_ms, JSON.stringify(receipt));
    return receipt;
  });
}

// ───────────────────────── 桥接操作 ─────────────────────────

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function memberOf(c: CityService, actorId: unknown): { actor_id: string; resident_id: string; last_epoch: number } {
  const row = typeof actorId === 'string' ? c.db.get<{ actor_id: string; resident_id: string; last_epoch: number }>('SELECT * FROM house_members WHERE actor_id = ?', actorId) : undefined;
  if (!row) throw new CityError('NOT_FOUND', '没有这位室友的身份映射。', 'unknown_actor');
  return row;
}

/** POST /visits/prepare：建待接收记录。随身钱包和物品此时还没有激活。 */
export function prepareVisit(c: CityService, body: Record<string, unknown>): BridgeReceipt {
  const visitId = typeof body.visit_id === 'string' ? body.visit_id : '';
  return withReceipt(c, 'prepare', visitId, body, () => {
    const now = c.now();
    if (c.db.get('SELECT 1 AS x FROM business_keys WHERE key = ?', `visit-aborted:${visitId}`)) throw cityConflict('这次访问已经取消了。', 'visit_aborted');
    if (visitById(c, visitId)) throw cityConflict('这个 visit_id 已经用过了。', 'visit_exists');
    if (body.protocol !== BRIDGE_PROTOCOL) throw new CityError('VERSION_MISMATCH', `协议版本不对，这里是 ${BRIDGE_PROTOCOL}。`, 'protocol', { protocol: BRIDGE_PROTOCOL });
    if (body.mappings_version !== MAPPINGS.version) {
      throw new CityError('VERSION_MISMATCH', '物品与效果映射表的版本不一致。', 'mappings_version', { mappings_version: MAPPINGS.version, city_catalog_version: CITY_CATALOG_VERSION });
    }
    const member = memberOf(c, body.actor_id);
    const carry = (body.carry ?? {}) as { yen?: unknown; items?: unknown };
    if (!isInt(carry.yen) || carry.yen < 0 || carry.yen > 10_000_000) throw cityBadRequest('carry.yen 要是 0 到一千万之间的整数日元。');
    const rawItems = carry.items ?? [];
    if (!Array.isArray(rawItems) || rawItems.length > 20) throw cityBadRequest('carry.items 要是一个列表，最多 20 项。');
    const items: CarryItem[] = [];
    const refs = new Set<string>();
    for (const raw of rawItems as Record<string, unknown>[]) {
      const ref = typeof raw?.ref === 'string' ? raw.ref : '';
      const kernel = (raw?.kernel ?? {}) as { kind?: unknown; item?: unknown };
      if (!/^[^\s]{1,160}$/.test(ref) || refs.has(ref)) throw cityBadRequest('carry.items[].ref 要是不重复的内核资源 ID。');
      if (!isInt(raw.qty) || raw.qty < 1 || raw.qty > 99) throw cityBadRequest('carry.items[].qty 要是 1 到 99 的整数。');
      const engineType = engineTypeOf(kernel);
      // 映射表里没有的类型出门不能带（规格 3.5.1）。内核出门前就该拦下，这里再拦一次
      if (!engineType) throw cityPrecondition('这件东西不在映射表里，不能带进城。', 'item_not_mapped', { ref });
      refs.add(ref);
      const meta = raw.meta !== undefined ? sanitizeItemMeta(raw.meta) : null;
      items.push({ ref, kernel: { kind: String(kernel.kind), item: String(kernel.item) }, qty: raw.qty, engine_type: engineType, ...(meta ? { meta } : {}) });
    }
    const plan = (body.plan ?? {}) as Record<string, unknown>;
    const dest = typeof plan.destination === 'string' ? publicPlace(plan.destination) : undefined;
    if (!dest) throw cityPrecondition('计划里的目的地不存在。', 'no_such_place');
    if (!isInt(plan.start_at_ms) || !isInt(plan.return_by_ms) || plan.return_by_ms <= plan.start_at_ms || plan.return_by_ms <= now) {
      throw cityBadRequest('plan.start_at_ms / plan.return_by_ms 要是 UTC 毫秒整数，return_by 要晚于出发时间和现在。');
    }
    const open = c.db.get<{ visit_id: string }>("SELECT visit_id FROM visits WHERE actor_id = ? AND state IN ('prepared','active','returning','settling','settled')", member.actor_id);
    if (open) throw cityConflict('这位室友还有一次没结束的访问。', 'visit_open', { visit_id: open.visit_id });
    const storedPlan: VisitPlan = { destination: dest.id, start_at_ms: plan.start_at_ms, return_by_ms: plan.return_by_ms };
    c.db.run(
      `INSERT INTO visits(visit_id, actor_id, resident_id, state, protocol, vocab_version, city_catalog_version, mappings_version, carry_yen, carry_items_json, plan_json, source_hold_ref, return_by_ms, prepared_at)
       VALUES (?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?)`,
      visitId,
      member.actor_id,
      member.resident_id,
      BRIDGE_PROTOCOL,
      typeof body.vocab_version === 'string' ? body.vocab_version.slice(0, 80) : null,
      CITY_CATALOG_VERSION,
      MAPPINGS.version,
      carry.yen,
      JSON.stringify(items),
      JSON.stringify(storedPlan),
      typeof body.source_hold_ref === 'string' ? body.source_hold_ref.slice(0, 160) : null,
      plan.return_by_ms,
      now,
    );
    // 兜底：内核 prepare 之后再也没来（既不 commit 也不 abort），到最晚回家时刻这条记录自动作废，不挡她下一次出门
    c.schedule('visit_prepared_expire', `prep:${visitId}`, plan.return_by_ms, { visitId });
    return { state: 'prepared', payload: { city_catalog_version: CITY_CATALOG_VERSION, mappings_version: MAPPINGS.version, carry_yen: carry.yen, items: items.map((i) => ({ ref: i.ref, engine_type: i.engine_type, qty: i.qty })), plan: storedPlan } };
  });
}

/** POST /visits/{id}/commit：激活随身钱包和物品，动作权交给城市。 */
export function commitVisit(c: CityService, visitId: string, body: Record<string, unknown>): BridgeReceipt {
  return withReceipt(c, 'commit', visitId, body, () => {
    const now = c.now();
    const visit = visitById(c, visitId);
    if (!visit) throw new CityError('NOT_FOUND', '没有这次访问。请先 prepare。', 'no_such_visit');
    const transferId = typeof body.transfer_id === 'string' ? body.transfer_id : '';
    if (!BRIDGE_REQUEST_ID_RE.test(transferId)) throw cityBadRequest('需要 transfer_id。');
    if (!isInt(body.domain_epoch) || body.domain_epoch < 1) throw cityBadRequest('需要 domain_epoch（正整数）。');
    if (visit.state !== 'prepared') {
      if (visit.state === 'aborted') throw cityConflict('这次访问已经取消了。', 'visit_aborted');
      // 换了请求号重发同一次交接：返回当时的回执，不会二次入账
      if (visit.transfer_id === transferId && visit.domain_epoch === body.domain_epoch) {
        const original = c.db.get<Row>("SELECT response FROM bridge_receipts WHERE visit_id = ? AND op = 'commit' ORDER BY rowid LIMIT 1", visitId);
        if (original) {
          const rec = parseJson<BridgeReceipt>(original.response as string, {} as BridgeReceipt);
          return { state: rec.state, payload: { ...rec.payload, original_receipt_id: rec.receipt_id, original_request_id: rec.request_id } };
        }
      }
      throw cityConflict('这次访问已经交接过了，内容和这次请求不一样。', 'already_committed', { state: visit.state });
    }
    if (c.db.get('SELECT 1 AS x FROM visits WHERE transfer_id = ?', transferId)) throw cityConflict('这个 transfer_id 已经用于另一次访问。', 'transfer_conflict');
    const member = memberOf(c, visit.actor_id);
    if (body.domain_epoch <= member.last_epoch) {
      throw new CityError('STALE_DOMAIN_EPOCH', '动作权代次是旧的。', undefined, { last_epoch: member.last_epoch });
    }
    const r = c.mustResident(visit.resident_id);
    ensurePurse(c, r.resident_id);
    // 钱：桥接系统账户减、随身钱包加。原因键永久唯一，重发不会二次入账
    ledger(c, `visit:${visitId}:in`, 'visit_in', '出门', [[BRIDGE, -visit.carry_yen], [purseOf(r.resident_id), visit.carry_yen]], visitId);
    // 物品：每件带出来的资源一行，记着它在内核里的来历
    const carried = parseJson<CarryItem[]>(visit.carry_items_json, []).map((it) => ({
      ref: it.ref,
      engine_type: it.engine_type,
      qty: it.qty,
      engine_item_id: addCarried(c, r.resident_id, it.engine_type, it.qty, it.ref, { domain: 'ai-house', ref: it.ref, transfer_id: transferId }, visitId, it.meta),
    }));
    c.db.run('UPDATE house_members SET last_epoch = ? WHERE actor_id = ?', body.domain_epoch, member.actor_id);
    c.db.run("UPDATE visits SET state = 'active', transfer_id = ?, domain_epoch = ?, committed_at = ? WHERE visit_id = ?", transferId, body.domain_epoch, now, visitId);
    c.db.run('UPDATE residents SET in_city = 1, place_id = ?, trip_id = NULL, last_seen_at = ?, revision = revision + 1 WHERE resident_id = ?', HOUSE_ENTRANCE, now, r.resident_id);
    const active = visitById(c, visitId)!;
    afterMove(c, active, HOUSE_ENTRANCE);
    // 按计划自动排一段到目的地的行程。排不了（目的地关门、满了）不算交接失败：她留在门口，由她自己改主意
    const plan = parseJson<VisitPlan>(visit.plan_json, {} as VisitPlan);
    let trip: Record<string, unknown> | null = null;
    let planBlocked: string | null = null;
    try {
      const t = startTrip(c, c.mustResident(r.resident_id), plan.destination, 'travel', now, active);
      trip = { trip_id: t.trip_id, to: t.to_place, ends_at_ms: t.ends_at };
    } catch (e) {
      if (!(e instanceof CityError)) throw e;
      planBlocked = e.reason ?? e.code;
      wake(c, active, 'plan_blocked', now, { destination: plan.destination, reason: planBlocked, message: e.message });
    }
    return {
      state: 'active',
      payload: {
        transfer_id: transferId,
        domain_epoch: body.domain_epoch,
        purse_yen: visit.carry_yen,
        return_reserve_yen: homeward(trip ? plan.destination : HOUSE_ENTRANCE).fareYen,
        items: carried,
        trip,
        ...(planBlocked ? { plan_blocked: planBlocked } : {}),
      },
    };
  });
}

/** POST /visits/{id}/abort：只在 commit 之前有效。没见过的 visit_id 也记下来，之后迟到的 prepare 会被拒绝。 */
export function abortVisit(c: CityService, visitId: string, body: Record<string, unknown>): BridgeReceipt {
  return withReceipt(c, 'abort', visitId, body, () => {
    const visit = visitById(c, visitId);
    if (!visit) {
      c.once(`visit-aborted:${visitId}`);
      return { state: 'aborted', payload: { known: false } };
    }
    if (visit.state === 'aborted') return { state: 'aborted', payload: { known: true } };
    if (visit.state !== 'prepared') throw cityConflict('已经交接过的访问不能取消，只能让她回家。', 'already_committed', { state: visit.state });
    c.db.run("UPDATE visits SET state = 'aborted', aborted_at = ?, return_reason = ? WHERE visit_id = ?", c.now(), typeof body.reason === 'string' ? body.reason.slice(0, 120) : null, visitId);
    return { state: 'aborted', payload: { known: true } };
  });
}

/** POST /visits/{id}/return-request：内核要求她回家。已经在回家路上或已经到家就什么都不做。 */
export function requestReturn(c: CityService, visitId: string, body: Record<string, unknown>): BridgeReceipt {
  return withReceipt(c, 'return-request', visitId, body, () => {
    const visit = visitById(c, visitId);
    if (!visit) throw new CityError('NOT_FOUND', '没有这次访问。', 'no_such_visit');
    if (visit.state === 'prepared' || visit.state === 'aborted') throw cityConflict('这次访问没有交接过。', 'not_committed', { state: visit.state });
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'requested';
    const started = visit.state === 'active' ? beginReturn(c, visit, `kernel:${reason}`, c.now()) : false;
    return { state: visitById(c, visitId)!.state, payload: { started } };
  });
}

/** POST /visits/{id}/release：内核已应用结算。扣回随身钱包，动作权记为家域，访问关闭。 */
export function releaseVisit(c: CityService, visitId: string, body: Record<string, unknown>): BridgeReceipt {
  return withReceipt(c, 'release', visitId, body, () => {
    const now = c.now();
    const visit = visitById(c, visitId);
    if (!visit) throw new CityError('NOT_FOUND', '没有这次访问。', 'no_such_visit');
    if (visit.state !== 'settled') {
      if (visit.state === 'closed' || visit.state === 'reconcile') throw cityConflict('这次访问已经关闭了。', 'already_released', { state: visit.state });
      throw new CityError('VISIT_NOT_ACTIVE', '她还没有到家，不能结束这次访问。', 'not_settled', { state: visit.state });
    }
    if (body.settlement_id !== visit.settlement_id) throw cityConflict('settlement_id 对不上。', 'settlement_mismatch');
    if (!isInt(body.domain_epoch) || body.domain_epoch <= (visit.domain_epoch ?? 0)) {
      throw new CityError('STALE_DOMAIN_EPOCH', '动作权代次是旧的：交回时要用新的代次。', undefined, { domain_epoch: visit.domain_epoch });
    }
    const settlement = parseJson<Settlement>(visit.settlement_json, {} as Settlement);
    const final = visit.purse_final_yen ?? 0;
    ledger(c, `visit:${visitId}:out`, 'visit_out', '回家', [[purseOf(visit.resident_id), -final], [BRIDGE, final]], visitId);
    for (const it of settlement.items) {
      if (it.fate === 'back') c.db.run("UPDATE items SET state = 'returned', updated_at = ? WHERE item_id = ? AND state = 'held'", now, it.engine_item_id);
      else if (it.fate === 'locker') moveItemToLocker(c, it.engine_item_id, now);
      else if (it.fate === 'disposed') disposeHeldItem(c, it.engine_item_id, now);
    }
    // 储物柜寄存属正常流转；仅存在结果未知的 pending 订单时访问进入异常态 reconcile
    const needsReconcile = settlement.pending.length > 0;
    const state: VisitState = needsReconcile ? 'reconcile' : 'closed';
    c.db.run('UPDATE visits SET state = ?, released_at = ? WHERE visit_id = ?', state, now, visitId);
    c.db.run('UPDATE house_members SET last_epoch = MAX(last_epoch, ?) WHERE actor_id = ?', body.domain_epoch, visit.actor_id);
    const report = runReconcile(c, 'visit_closed');
    return { state, payload: { settlement_id: visit.settlement_id, purse_final_yen: final, home_epoch: body.domain_epoch, reconcile_ok: report.ok } };
  });
}

/** GET /visits/{id}：状态和全部回执（故障恢复用）。 */
export function describeVisit(c: CityService, visitId: string): Record<string, unknown> {
  const visit = visitById(c, visitId);
  if (!visit) {
    if (c.db.get('SELECT 1 AS x FROM business_keys WHERE key = ?', `visit-aborted:${visitId}`)) return { visit_id: visitId, state: 'aborted', known: false, receipts: receiptsOf(c, visitId) };
    throw new CityError('NOT_FOUND', '没有这次访问。', 'no_such_visit');
  }
  const r = c.mustResident(visit.resident_id);
  const trip = runningTrip(c, r.resident_id);
  const inCity = visit.state === 'active' || visit.state === 'returning';
  return {
    visit_id: visit.visit_id,
    actor_id: visit.actor_id,
    state: visit.state,
    protocol: visit.protocol,
    city_catalog_version: visit.city_catalog_version,
    mappings_version: visit.mappings_version,
    vocab_version: visit.vocab_version,
    transfer_id: visit.transfer_id,
    domain_epoch: visit.domain_epoch,
    carry_yen: visit.carry_yen,
    plan: parseJson(visit.plan_json, {}),
    return_by_ms: visit.return_by_ms,
    return_reason: visit.return_reason,
    ...(inCity ? { location: trip ? { in_transit: true, to: trip.to_place, eta_ms: trip.ends_at } : { place: r.place_id }, purse_yen: wallet(c, r.resident_id).balance } : {}),
    settlement: parseJson(visit.settlement_json, null),
    times: { prepared_at_ms: visit.prepared_at, committed_at_ms: visit.committed_at, returning_at_ms: visit.returning_at, settled_at_ms: visit.settled_at, released_at_ms: visit.released_at, aborted_at_ms: visit.aborted_at },
    receipts: receiptsOf(c, visitId),
  };
}

function receiptsOf(c: CityService, visitId: string): unknown[] {
  // 代行动作的回执量大，这里只列交接类的；单条动作的回执用同一个 request_id 重发就能取回
  return c.db
    .all<Row>("SELECT op, response FROM bridge_receipts WHERE visit_id = ? AND op <> 'act' ORDER BY rowid", visitId)
    .map((row) => ({ op: row.op, ...parseJson<Record<string, unknown>>(row.response as string, {}) }));
}

/** GET /outbox?after=<seq>&limit=<n> */
export function readOutbox(c: CityService, after: number, limit: number): { records: Record<string, unknown>[]; next_after: number; more: boolean } {
  const rows = c.db.all<Row>('SELECT seq, visit_id, kind, record_id, occurred_at_ms, payload FROM bridge_outbox WHERE seq > ? ORDER BY seq LIMIT ?', after, limit + 1);
  const more = rows.length > limit;
  const records = rows.slice(0, limit).map((row) => ({
    seq: Number(row.seq),
    visit_id: String(row.visit_id),
    kind: String(row.kind),
    record_id: String(row.record_id),
    occurred_at_ms: Number(row.occurred_at_ms),
    payload: parseJson<Record<string, unknown>>(row.payload as string, {}),
  }));
  return { records, next_after: records.length ? Number(records[records.length - 1]!.seq) : after, more };
}

export function installVisits(c: CityService): void {
  // 到点回家：还在城里就开始回程（适配器掉线也一样）
  c.jobHandlers.set('visit_return', (payload, job, now) => {
    const visit = visitById(c, String(payload.visitId));
    const reason = payload.reason === 'last_train' ? 'last_train' : 'return_by';
    if (visit && visit.state === 'active') beginReturn(c, visit, reason, now, job.due_at);
  });
  // prepare 之后一直没有交接：到最晚回家时刻自动作废。迟到的 commit 会得到 409 visit_aborted，内核按取消处理（释放冻结）
  c.jobHandlers.set('visit_prepared_expire', (payload, _job, now) => {
    const visit = visitById(c, String(payload.visitId));
    if (!visit || visit.state !== 'prepared') return;
    c.db.run("UPDATE visits SET state = 'aborted', aborted_at = ?, return_reason = 'expired' WHERE visit_id = ?", now, visit.visit_id);
    c.log(`[city] 访问 ${visit.visit_id}（${visit.actor_id}）prepare 之后一直没有交接，已自动作废`);
  });
}
