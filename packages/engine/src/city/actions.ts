/**
 * 城市里的动作（第一期）：travel / say / buy / consume / give / go_home。
 *
 * 两个入口，同一套处理器：
 *  - 外部 bot：cityCommand()，经 MCP 的 world_act 进来。回执会过期（只管网络重试），每个主体每小时 / 每天有动作上限。
 *  - 小屋的室友：visitAct()，由内核的适配器经桥接接口代行。必须带访问号和当前的 domain_epoch，回执永久保存。
 * 处理过程同步，全部在一个事务里：状态、账本、物品、事件、回执、outbox 一起提交或一起回滚。
 */
import { sanitizeUserText } from '../core/text.js';
import { parseJson, type Row } from '../world/db.js';
import { REQUEST_ID_RE, sha256, stableStringify } from '../world/service.js';
import { BOOK_SHELF_BUYBACK_YEN, BOOK_SHELF_RESALE_YEN, findGoodAtPlace, isCarryHome, itemName, itemType, place, publicPlace } from './catalog.js';
import { CityError, cityBadRequest, cityConflict, cityControlLost, cityPrecondition } from './errors.js';
import {
  BRIDGE,
  SHOPS,
  addDisposed,
  addPlain,
  addPlainToLocker,
  addPurchasedInstances,
  annotatePaperback,
  claimLockerDeposit,
  createLockerDeposit,
  driftBookToCorner,
  expireLockerDeposit,
  heldItems,
  hold,
  ledger,
  lockerItems,
  purseOf,
  sanitizeItemMeta,
  storeToLocker,
  takeBookFromCorner,
  takeFromLocker,
  takeItems,
  transferItems,
  unhold,
  wallet,
  type ItemRow,
  type LockerDepositRow,
} from './ledger.js';
import { kernelEffectOf } from './mappings.js';
import { runReconcile } from './reconcile.js';
import { card, updateResidentProfile } from './residents.js';
import type { CityResident, CityService } from './service.js';
import { placeOpen, spendable, startTrip, tripView } from './trips.js';
import { beginReturn, bodyEffect, clearChatWake, noteSpeech, openVisitOf, outboxOrderRefunded, outboxPurchase, visitById, wake, wakeForChat, withReceipt, type BridgeReceipt, type VisitRow } from './visits.js';

export const CITY_ACTIONS = [
  'travel',
  'say',
  'buy',
  'consume',
  'give',
  'read_item',
  'inspect_item',
  'drift_book',
  'take_book',
  'store_locker',
  'take_locker',
  'update_profile',
  'go_home',
] as const;

// ───────────────────────── 限速 ─────────────────────────

/** 滑动窗口：窗口里已经有 limit 次就拒绝，并告诉对方多久之后再来。 */
function rateCheck(c: CityService, subject: string, bucket: string, limit: number, windowMs: number, at: number): void {
  const rows = c.db.all<{ at: number }>('SELECT at FROM rate_log WHERE subject = ? AND bucket = ? AND at > ? ORDER BY at', subject, bucket, at - windowMs);
  if (rows.length >= limit) {
    const retryAfterMs = Math.max(1000, rows[rows.length - limit]!.at + windowMs - at);
    throw new CityError('RATE_LIMITED', '动作太密了，歇一会儿再来。', bucket, { retryAfterMs });
  }
}

function rateNote(c: CityService, subject: string, bucket: string, at: number): void {
  c.db.run('INSERT INTO rate_log(subject, bucket, at) VALUES (?,?,?)', subject, bucket, at);
}

/** 令牌桶：有令牌就用掉一个并返回 true。 */
function takeToken(c: CityService, subject: string, bucket: string, burst: number, perHour: number, at: number): boolean {
  const row = c.db.get<{ tokens: number; updated_at: number }>('SELECT tokens, updated_at FROM rate_buckets WHERE subject = ? AND bucket = ?', subject, bucket);
  const tokens = Math.min(burst, (row?.tokens ?? burst) + ((at - (row?.updated_at ?? at)) / 3600_000) * perHour);
  const ok = tokens >= 1;
  c.db.run('INSERT INTO rate_buckets(subject, bucket, tokens, updated_at) VALUES (?,?,?,?) ON CONFLICT(subject, bucket) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at', subject, bucket, ok ? tokens - 1 : tokens, at);
  return ok;
}

// ───────────────────────── 处理器 ─────────────────────────

type Action = Record<string, unknown> & { type?: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function qtyOf(v: unknown, max: number): number {
  if (v === undefined || v === null) return 1;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw cityBadRequest(`qty 要是 1 到 ${max} 的整数。`, 'bad_quantity');
  return v;
}

function mustBeAtPlace(r: CityResident): string {
  if (!r.place_id || r.trip_id) throw cityPrecondition('你还在路上，到了再说。', 'in_transit');
  return r.place_id;
}

function doTravel(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  mustBeAtPlace(r);
  // 不公开的节点对谁都「不存在」：回家用 go_home
  const dest = publicPlace(str(a.to));
  if (!dest) throw new CityError('NOT_FOUND', '没有这个地方。看视图里 here.exits 列出的地点编号。', 'no_such_place');
  const trip = startTrip(c, r, dest.id, 'travel', at, visit);
  return { status: 'accepted', trip: tripView(trip) };
}

function doSay(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null, subject: string): Record<string, unknown> {
  const placeId = mustBeAtPlace(r);
  const text = sanitizeUserText(str(a.text)).trim();
  if (!text) throw cityBadRequest('要说的话不能是空的。', 'text_empty');
  if ([...text].length > c.params.chatMaxChars) throw cityBadRequest(`一句话最多 ${c.params.chatMaxChars} 个字。`, 'text_too_long');
  rateCheck(c, subject, 'chat', c.params.chatPerMinute, 60_000, at);
  rateNote(c, subject, 'chat', at);
  // 听众在说话的这一刻定下：同一个地点里在场的人。之后来的人听不到
  const audience = c.presentAt(placeId).filter((x) => x.resident_id !== r.resident_id);
  const { lastInsertRowid } = c.db.run('INSERT INTO chat_messages(place_id, sender_id, body, sent_at) VALUES (?,?,?,?)', placeId, r.resident_id, text, at);
  const messageId = Number(lastInsertRowid);
  for (const id of [r.resident_id, ...audience.map((x) => x.resident_id)]) c.db.run('INSERT INTO chat_audience(resident_id, message_id) VALUES (?,?)', id, messageId);
  const projection = { from: card(r), place: placeId, text, untrusted: true, message_id: messageId };
  for (const o of audience) {
    // 叫醒额度：说得密的时候不是每一句都叫醒对方，没叫醒的话在视图的 here.recent_chat 里
    if (takeToken(c, o.resident_id, 'wake', c.params.wakeBurst, c.params.wakePerHour, at)) c.emitTo([o.resident_id], 'chat', projection, at);
    if (visit) noteSpeech(c, visit, o, 'she', placeId, at);
    if (o.origin === 'house') {
      const theirs = openVisitOf(c, o.resident_id);
      if (theirs && theirs.state === 'active') {
        noteSpeech(c, theirs, r, 'other', placeId, at);
        wakeForChat(c, visitById(c, theirs.visit_id)!, at, { from: { name: r.name }, place: placeId });
      } else if (theirs) {
        noteSpeech(c, theirs, r, 'other', placeId, at);
      }
    }
  }
  return { status: 'completed', message_id: messageId, heard_by: audience.length };
}

function doBuy(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtPlace(r);
  const p = place(placeId)!;
  const good = findGoodAtPlace(placeId, str(a.sku), c.catalogTime(at), false);
  if (!good) throw cityPrecondition('这里不卖这个。看视图里 here.goods。', 'no_such_good');
  if (!placeOpen(c, p, at).open) throw cityPrecondition(`${p.name}现在不营业。`, 'place_closed');
  const qty = qtyOf(a.qty, 9);
  const total = good.priceYen * qty;
  const can = spendable(c, r);
  if (can.yen < total) {
    // 钱是够的，只是动了回程车费就回不了家（规格 F12）
    if (wallet(c, r.resident_id).available >= total) {
      throw cityPrecondition(`买了就回不了家：这要 ¥${total}，你得留 ¥${can.returnReserveYen} 的回程车费。`, 'return_fare_reserved', { price_yen: total, return_reserve_yen: can.returnReserveYen, spendable_yen: can.yen });
    }
    throw cityPrecondition(`钱不够：这要 ¥${total}，你能花的只有 ¥${can.yen}。`, 'insufficient_funds', { price_yen: total, spendable_yen: can.yen });
  }
  const orderId = c.id('ord');
  const insert = (status: 'pending' | 'completed') =>
    c.db.run('INSERT INTO orders(order_id, resident_id, visit_id, place_id, sku, type, quantity, yen, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', orderId, r.resident_id, visit?.visit_id ?? null, placeId, good.sku, good.type, qty, total, status, at, status === 'completed' ? at : null);
  if (c.failpoints.purchaseUnknown?.({ residentId: r.resident_id, sku: good.sku })) {
    // 店家那边的结果不知道：钱先锁住，不花也不退，订单留着等对账（规格 F9）
    hold(c, r.resident_id, total);
    insert('pending');
    c.emitTo([r.resident_id], 'order_pending', { order_id: orderId, what: good.name, yen: total }, at);
    return { status: 'pending', reason: 'outcome_unknown', order_id: orderId, held_yen: total, purse_yen: wallet(c, r.resident_id).balance };
  }
  insert('completed');
  ledger(c, `order:${orderId}`, 'purchase', good.assetId ? good.name : itemName(good.type), [[purseOf(r.resident_id), -total], [SHOPS, total]], visit?.visit_id ?? null);
  let itemId: string;
  if (good.assetId) {
    const ids = addPurchasedInstances(
      c,
      r.resident_id,
      good.type,
      qty,
      { domain: 'tokyo_shop', sku: good.sku, asset_id: good.assetId, place_id: placeId },
      { title: good.name, created_at_ms: at },
      visit?.visit_id ?? null,
      'held',
    );
    itemId = ids[0]!;
  } else {
    itemId = addPlain(c, r.resident_id, good.type, qty, visit?.visit_id ?? null, 'acquired');
  }
  if (visit) outboxPurchase(c, visit, at, { what: good.name, yen: -total, detail: { order_id: orderId, place: placeId, sku: good.sku, type: good.type, qty } });
  return {
    status: 'completed',
    order_id: orderId,
    item: { item_id: itemId, type: good.type, name: good.assetId ? good.name : itemName(good.type), qty, ...(good.assetId ? { instance: true } : {}) },
    paid_yen: total,
    purse_yen: wallet(c, r.resident_id).balance,
  };
}

/** 动作里指的是哪种物品：点名物品行（item_id）或只说类型（item）。 */
function resolveItem(c: CityService, r: CityResident, a: Action): { what: { itemId?: string; type?: string }; type: string } {
  const itemId = str(a.item_id);
  if (itemId) {
    const row = heldItems(c, r.resident_id).find((i) => i.item_id === itemId);
    if (!row) throw cityPrecondition('你身上没有这件东西。', 'not_enough_items');
    return { what: { itemId }, type: row.type };
  }
  // 动作自己的 type 已经占用，物品类型的字段叫 item
  const type = str(a.item);
  if (!type || !itemType(type)) throw cityBadRequest('要说清楚是哪件东西：item_id（视图 items 里的编号）或 item（物品类型，例如 "cookie"）。', 'no_such_item');
  return { what: { type }, type };
}

function doConsume(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  const { what, type } = resolveItem(c, r, a);
  const kind = itemType(type)?.kind;
  if (kind !== 'food' && kind !== 'drink') throw cityPrecondition(`${itemName(type)}不是吃的喝的。`, 'not_edible');
  const qty = qtyOf(a.qty, 9);
  // 引擎不替她算身体：只记下「吃了什么」，由内核按自己的规则结算（规格 3.7）
  const engineKind = kind === 'drink' ? 'drank' : 'ate';
  const effectId = visit ? bodyEffect(c, visit, at, { engine_kind: engineKind, engine_type: type, qty, kernel_effect: kernelEffectOf(engineKind, type) }) : undefined;
  takeItems(c, r.resident_id, what, qty, visit?.visit_id ?? null, 'consumed', effectId ? { effectId } : {});
  return { status: 'completed', consumed: { type, name: itemName(type), qty }, ...(effectId ? { effect_id: effectId } : {}) };
}

function doGive(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtPlace(r);
  const to = c.presentAt(placeId).find((x) => x.resident_id === str(a.to) && x.resident_id !== r.resident_id);
  // 对方不在这个地点：不说在哪儿、是不是离线
  if (!to) throw cityPrecondition('对方不在这里。', 'not_here');
  const { what, type } = resolveItem(c, r, a);
  const qty = qtyOf(a.qty, 9);
  const theirs = to.origin === 'house' ? (openVisitOf(c, to.resident_id) ?? null) : null;
  const moved = transferItems(c, r.resident_id, to.resident_id, what, qty, visit?.visit_id ?? null, theirs?.visit_id ?? null);
  const gift = { type, name: itemName(type), qty, ...(moved.instanceItemId ? { item_id: moved.instanceItemId, instance: true } : {}) };
  c.emitTo([to.resident_id], 'gift_received', { from: card(r), item: gift, place: placeId }, at);
  if (theirs && theirs.state === 'active') wake(c, theirs, 'gift_received', at, { from: { name: r.name }, item: gift, place: placeId });
  return { status: 'completed', given: gift, to: card(to) };
}

function mustBeAtLocker(r: CityResident): string {
  const placeId = mustBeAtPlace(r);
  const p = place(placeId);
  if (!p || p.type !== 'station') {
    throw cityPrecondition('这里没有公共储物柜，请先去车站大厅。', 'not_at_locker');
  }
  return placeId;
}

function resolveSelector(a: Action): { itemId?: string; type?: string } {
  const itemId = str(a.item_id);
  if (itemId) return { itemId };
  const type = str(a.item);
  if (type) return { type };
  throw cityBadRequest('要说清楚是哪件东西：item_id 或 item（物品类型）。', 'no_such_item');
}

function doStoreLocker(c: CityService, r: CityResident, a: Action, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtLocker(r);
  const what = resolveSelector(a);
  const qty = qtyOf(a.qty, 99);
  const recipientId = a.recipient_id === undefined || a.recipient_id === null ? undefined : typeof a.recipient_id === 'string' ? a.recipient_id.trim() : null;
  if (recipientId === null) throw cityBadRequest('recipient_id 必须是居民 ID 字符串。', 'bad_recipient');
  if (a.voucher !== undefined && typeof a.voucher !== 'boolean') throw cityBadRequest('voucher 必须是布尔值。', 'bad_voucher');
  const issueVoucher = a.voucher === true;
  if ((recipientId && recipientId.length > 0) || issueVoucher) {
    const at = c.now();
    const created = createLockerDeposit(
      c,
      r.resident_id,
      what,
      qty,
      placeId,
      { ...(recipientId ? { recipientId } : {}), issueVoucher, visitId: visit?.visit_id ?? null },
      at,
    );
    return {
      status: 'completed',
      deposit: {
        deposit_id: created.deposit.deposit_id,
        item_id: created.deposit.item_id,
        type: created.deposit.type,
        name: itemName(created.deposit.type),
        qty: created.deposit.quantity,
        place_id: created.deposit.place_id,
        expires_at_ms: created.deposit.expires_at,
        ...(created.deposit.recipient_id ? { recipient_id: created.deposit.recipient_id } : {}),
        ...(created.voucherCode ? { voucher_code: created.voucherCode } : {}),
      },
    };
  }
  const stored = storeToLocker(c, r.resident_id, what, qty, visit?.visit_id ?? null);
  return { status: 'completed', stored: { ...stored, name: itemName(stored.type) } };
}

function doTakeLocker(c: CityService, r: CityResident, a: Action, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtLocker(r);
  const voucher = typeof a.voucher === 'string' ? a.voucher.trim() : '';
  const depositId = typeof a.deposit_id === 'string' ? a.deposit_id.trim() : '';
  if (voucher || depositId) {
    const claimed = claimLockerDeposit(
      c,
      r.resident_id,
      placeId,
      { ...(depositId ? { depositId } : {}), ...(voucher ? { voucher } : {}) },
      visit?.visit_id ?? null,
      c.now(),
    );
    return {
      status: 'completed',
      retrieved: {
        item_id: claimed.item_id,
        type: claimed.type,
        name: itemName(claimed.type),
        qty: claimed.qty,
        deposit_id: claimed.deposit.deposit_id,
        from_resident_id: claimed.deposit.sender_id,
      },
    };
  }
  const what = resolveSelector(a);
  // 若传 item_id 但柜中没有，先做友好检查
  if (what.itemId && !lockerItems(c, r.resident_id).some((i) => i.item_id === what.itemId)) {
    throw cityPrecondition('你的储物柜里没有这件东西。', 'not_enough_items');
  }
  const qty = qtyOf(a.qty, 99);
  const retrieved = takeFromLocker(c, r.resident_id, what, qty, visit?.visit_id ?? null);
  return { status: 'completed', retrieved: { ...retrieved, name: itemName(retrieved.type) } };
}

function doReadItem(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtPlace(r);
  const what = resolveSelector(a);
  if (a.title !== undefined && typeof a.title !== 'string') throw cityBadRequest('title 必须是字符串。', 'bad_title');
  const annotated = annotatePaperback(
    c,
    r.resident_id,
    what,
    {
      ...(typeof a.title === 'string' ? { title: a.title } : {}),
      ...(a.note !== undefined ? { note: a.note as string } : {}),
      placeId,
      residentName: r.name,
      visitId: visit?.visit_id ?? null,
    },
    at,
  );
  return { status: 'completed', item: { ...annotated, name: itemName(annotated.type), instance: true } };
}

function doInspectItem(c: CityService, r: CityResident, a: Action): Record<string, unknown> {
  const itemId = str(a.item_id).trim();
  if (!itemId) throw cityBadRequest('inspect_item 需要传 item_id。', 'no_such_item');
  const row = c.db.get<ItemRow & Row>('SELECT * FROM items WHERE item_id = ? AND quantity > 0', itemId);
  if (!row) throw new CityError('NOT_FOUND', '找不到这件物品，或你无权查看详情。', 'no_such_item');

  const isMine = row.owner_id === r.resident_id && (row.state === 'held' || row.state === 'locker');
  const atHereCorner =
    Boolean(r.place_id && !r.trip_id) &&
    (row.state === 'shelf' || row.state === 'drift') &&
    row.shelf_place_id === r.place_id;
  const forMyPickup =
    Boolean(r.place_id && !r.trip_id && row.state === 'locker') &&
    Boolean(
      c.db.get<LockerDepositRow & Row>(
        "SELECT deposit_id FROM locker_deposits WHERE item_id = ? AND status = 'active' AND place_id = ? AND recipient_id = ?",
        itemId,
        r.place_id,
        r.resident_id,
      ),
    );

  if (!isMine && !atHereCorner && !forMyPickup) {
    throw new CityError('NOT_FOUND', '找不到这件物品，或你无权查看详情。', 'no_such_item');
  }
  const rawMeta = row.instance === 1 ? parseJson<Record<string, unknown> | null>(row.meta_json, null) : null;
  const meta = rawMeta ? sanitizeItemMeta(rawMeta) : null;
  return {
    status: 'completed',
    item: {
      item_id: row.item_id,
      type: row.type,
      name: itemName(row.type),
      qty: row.quantity,
      instance: row.instance === 1,
      state: row.state,
      ...(row.state === 'shelf' ? { price_yen: Number(row.shelf_price_yen ?? BOOK_SHELF_RESALE_YEN) } : {}),
      ...(row.shelf_place_id ? { place_id: row.shelf_place_id } : {}),
      ...(meta ? { meta } : {}),
    },
  };
}

function doDriftBook(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtPlace(r);
  const p = place(placeId)!;
  const what = resolveSelector(a);
  if (placeId === 'ikebukuro:shiorido') {
    if (!placeOpen(c, p, at).open) throw cityPrecondition(`${p.name}现在不营业。`, 'place_closed');
    const res = driftBookToCorner(
      c,
      r.resident_id,
      what,
      'shelf',
      placeId,
      r.name,
      visit?.visit_id ?? null,
      at,
      typeof a.note === 'string' ? a.note : a.note === undefined ? undefined : (a.note as string),
      BOOK_SHELF_RESALE_YEN,
    );
    ledger(
      c,
      `shelf_sell:${res.item_id}:${c.id('tx')}`,
      'shelf_sell',
      '古书寄售',
      [
        [SHOPS, -BOOK_SHELF_BUYBACK_YEN],
        [purseOf(r.resident_id), BOOK_SHELF_BUYBACK_YEN],
      ],
      visit?.visit_id ?? null,
    );
    if (visit) outboxPurchase(c, visit, at, { what: '古书寄售', yen: BOOK_SHELF_BUYBACK_YEN, detail: { place: placeId, item_id: res.item_id } });
    return {
      status: 'completed',
      mode: 'shelf',
      item: { ...res, name: itemName(res.type), instance: true, resale_yen: BOOK_SHELF_RESALE_YEN },
      received_yen: BOOK_SHELF_BUYBACK_YEN,
      purse_yen: wallet(c, r.resident_id).balance,
    };
  }
  if (p.type === 'station') {
    const res = driftBookToCorner(
      c,
      r.resident_id,
      what,
      'drift',
      placeId,
      r.name,
      visit?.visit_id ?? null,
      at,
      typeof a.note === 'string' ? a.note : a.note === undefined ? undefined : (a.note as string),
    );
    return { status: 'completed', mode: 'drift', item: { ...res, name: itemName(res.type), instance: true } };
  }
  throw cityPrecondition('只有书店「栞堂」的古书二手架或车站大厅的图书漂流角可以放入文库本。', 'not_at_book_corner');
}

function doTakeBook(c: CityService, r: CityResident, a: Action, at: number, visit: VisitRow | null): Record<string, unknown> {
  const placeId = mustBeAtPlace(r);
  const p = place(placeId)!;
  const itemId = str(a.item_id).trim();
  if (!itemId) throw cityBadRequest('take_book 需要传 item_id。', 'no_such_item');
  if (placeId === 'ikebukuro:shiorido') {
    if (!placeOpen(c, p, at).open) throw cityPrecondition(`${p.name}现在不营业。`, 'place_closed');
    const row = c.db.get<ItemRow & Row>(
      "SELECT * FROM items WHERE item_id = ? AND state = 'shelf' AND shelf_place_id = ? AND quantity = 1",
      itemId,
      placeId,
    );
    if (!row) throw new CityError('NOT_FOUND', '二手架上已经没有这本书了。', 'no_such_item');
    const price = Number(row.shelf_price_yen ?? BOOK_SHELF_RESALE_YEN);
    const can = spendable(c, r);
    if (can.yen < price) {
      if (wallet(c, r.resident_id).available >= price) {
        throw cityPrecondition(`买了就回不了家：这要 ¥${price}，你得留 ¥${can.returnReserveYen} 的回程车费。`, 'return_fare_reserved', {
          price_yen: price,
          return_reserve_yen: can.returnReserveYen,
          spendable_yen: can.yen,
        });
      }
      throw cityPrecondition(`钱不够：这要 ¥${price}，你能花的只有 ¥${can.yen}。`, 'insufficient_funds', { price_yen: price, spendable_yen: can.yen });
    }
    const taken = takeBookFromCorner(c, r.resident_id, itemId, 'shelf', placeId, visit?.visit_id ?? null, at);
    const txKey = `shelf_buy:${itemId}:${c.id('tx')}`;
    ledger(c, txKey, 'purchase', '古书二手架', [[purseOf(r.resident_id), -price], [SHOPS, price]], visit?.visit_id ?? null);
    if (visit) outboxPurchase(c, visit, at, { what: '古书二手架', yen: -price, detail: { place: placeId, item_id: itemId } });
    return {
      status: 'completed',
      mode: 'shelf',
      item: { item_id: taken.row.item_id, type: taken.row.type, name: itemName(taken.row.type), instance: true },
      paid_yen: price,
      purse_yen: wallet(c, r.resident_id).balance,
    };
  }
  if (p.type === 'station') {
    const taken = takeBookFromCorner(c, r.resident_id, itemId, 'drift', placeId, visit?.visit_id ?? null, at);
    return {
      status: 'completed',
      mode: 'drift',
      item: { item_id: taken.row.item_id, type: taken.row.type, name: itemName(taken.row.type), instance: true },
    };
  }
  throw cityPrecondition('只有书店「栞堂」的古书二手架或车站大厅的图书漂流角可以淘取漂流文库本。', 'not_at_book_corner');
}

function doUpdateProfile(c: CityService, r: CityResident, a: Action, visit: VisitRow | null): Record<string, unknown> {
  if (visit) throw cityPrecondition('小屋室友的显示名和简介由家里同步，不在城里修改。', 'house_profile_managed');
  const profile = updateResidentProfile(c, r, { name: a.name, bio: a.bio });
  return { status: 'completed', profile };
}

/** 做一件事。调用方已经确认过身份、在场和限速。 */
function perform(c: CityService, r: CityResident, action: unknown, at: number, visit: VisitRow | null, subject: string): Record<string, unknown> {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw cityBadRequest('action 要是一个对象，例如 {"type":"travel","to":"ikebukuro:kissa-tomoshibi"}。');
  const a = action as Action;
  switch (a.type) {
    case 'travel':
      return doTravel(c, r, a, at, visit);
    case 'say':
      return doSay(c, r, a, at, visit, subject);
    case 'buy':
      return doBuy(c, r, a, at, visit);
    case 'consume':
      return doConsume(c, r, a, at, visit);
    case 'give':
      return doGive(c, r, a, at, visit);
    case 'read_item':
      return doReadItem(c, r, a, at, visit);
    case 'inspect_item':
      return doInspectItem(c, r, a);
    case 'drift_book':
      return doDriftBook(c, r, a, at, visit);
    case 'take_book':
      return doTakeBook(c, r, a, at, visit);
    case 'store_locker':
      return doStoreLocker(c, r, a, visit);
    case 'take_locker':
      return doTakeLocker(c, r, a, visit);
    case 'update_profile':
      return doUpdateProfile(c, r, a, visit);
    case 'go_home':
      // 外部 bot 没有这个动作，也不该从报错里知道有它
      if (!visit) throw unknownAction(false);
      return { status: 'accepted', returning: beginReturn(c, visit, 'self', at) || visitById(c, visit.visit_id)?.state === 'returning' };
    default:
      throw unknownAction(visit !== null);
  }
}

const unknownAction = (house: boolean): CityError =>
  cityBadRequest(`不认识的动作。能做的有：${CITY_ACTIONS.filter((x) => (house ? x !== 'update_profile' : x !== 'go_home')).join(' / ')}。`, 'unknown_action');

// ───────────────────────── 外部 bot 的入口 ─────────────────────────

export interface CityCommandOptions {
  /** 归一化客户端标识（mcp:<id> 或 web:<id>）；提供时校验与 residents.controller_id 一致 */
  clientId?: string;
  /** 可选的控制权代次校验 */
  expectedControlEpoch?: number;
}

/** 外部 bot 或真人网页提交一条动作。同一个 request_id 重试返回原来的结果，不会做两遍。 */
export function cityCommand(
  c: CityService,
  residentId: string,
  requestId: unknown,
  action: unknown,
  opts: CityCommandOptions = {},
): Record<string, unknown> {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw cityBadRequest('需要 request_id（8~80 个字符，只能是字母、数字、下划线和 . : -）。每个新动作一个新的，重试用同一个。');
  const hash = sha256(stableStringify(action ?? null));
  c.metrics.commands++;
  // 过了限流检查、真的去试了的动作，失败也算一次（整笔回滚之后单独记）：不然不断发失败的动作就不受上限约束
  let attempted: string | null = null;
  try {
    return c.commit(() => {
      const now = c.now();
      const existing = c.db.get<Row>('SELECT payload_hash, response FROM request_receipts WHERE resident_id = ? AND request_id = ? AND expires_at > ?', residentId, requestId, now);
      if (existing) {
        if (existing.payload_hash !== hash) throw cityConflict('这个 request_id 已经用于另一个不同的动作。', 'request_conflict');
        c.metrics.replays++;
        return { ...parseJson<Record<string, unknown>>(existing.response as string, {}), replayed: true };
      }
      c.assertRunning();
      const r = c.mustResident(residentId);
      if (r.origin === 'house') throw new CityError('ENTRY_VIA_HOME_ONLY', '小屋的室友在城里的动作只能由小屋那边代行。');
      if (!r.in_city) throw cityPrecondition('你现在不在城里。先 enter_world。', 'not_in_city');
      if (opts.clientId !== undefined || r.controller_id !== null) {
        if (!opts.clientId || r.controller_id !== opts.clientId) {
          throw cityControlLost(r.control_epoch);
        }
        if (opts.expectedControlEpoch !== undefined && opts.expectedControlEpoch !== r.control_epoch) {
          throw cityControlLost(r.control_epoch);
        }
      }
      const subject = r.principal_id;
      rateCheck(c, subject, 'act', c.params.externalActsPerHour, 3600_000, now);
      rateCheck(c, subject, 'act', c.params.externalActsPerDay, 86_400_000, now);
      attempted = subject;
      const result = perform(c, r, action, now, null, subject);
      rateNote(c, subject, 'act', now);
      const until = now + c.params.presenceLeaseMs;
      c.db.run('UPDATE residents SET present_until = ?, last_seen_at = ? WHERE resident_id = ?', until, now, residentId);
      c.reschedule('presence_expire', `pres:${residentId}`, until, { residentId });
      const response = { ok: true, request_id: requestId, at_ms: now, ...result };
      c.db.run('INSERT OR REPLACE INTO request_receipts(resident_id, request_id, payload_hash, response, created_at, expires_at) VALUES (?,?,?,?,?,?)', residentId, requestId, hash, JSON.stringify(response), now, now + c.params.receiptRetentionMs);
      return response;
    });
  } catch (e) {
    if (e instanceof CityError) {
      c.metrics.rejected++;
      const subject: string | null = attempted;
      if (subject !== null) {
        try {
          c.commit(() => rateNote(c, subject, 'act', c.now()));
        } catch {
          /* 记不上就算了：数据库不可写时本来也做不了动作 */
        }
      }
    }
    throw e;
  }
}

// ───────────────────────── 室友的入口（桥接代行） ─────────────────────────

/** 确认这次代行是这次访问、当前代次的。访问结束后旧代次的请求一律 STALE_DOMAIN_EPOCH。 */
export function requireActingVisit(c: CityService, visitId: string, epoch: unknown): VisitRow {
  const visit = visitById(c, visitId);
  if (!visit) throw new CityError('NOT_FOUND', '没有这次访问。', 'no_such_visit');
  if (visit.state === 'closed' || visit.state === 'reconcile' || visit.state === 'aborted') {
    throw new CityError('STALE_DOMAIN_EPOCH', '这次访问已经结束，动作权已经回到家里。', undefined, { state: visit.state });
  }
  if (visit.state === 'prepared') throw new CityError('VISIT_NOT_ACTIVE', '这次访问还没有交接。', 'not_committed', { state: visit.state });
  if (typeof epoch !== 'number' || epoch !== visit.domain_epoch) throw new CityError('STALE_DOMAIN_EPOCH', '动作权代次对不上。', undefined, { domain_epoch: visit.domain_epoch });
  return visit;
}

/** POST /visits/{id}/act：内核的适配器替她做一件事。 */
export function visitAct(c: CityService, visitId: string, body: Record<string, unknown>): BridgeReceipt {
  c.metrics.commands++;
  try {
    return withReceipt(c, 'act', visitId, body, () => {
      const now = c.now();
      const visit = requireActingVisit(c, visitId, body.domain_epoch);
      const type = (body.action as Action | undefined)?.type;
      if (visit.state === 'settling' || visit.state === 'settled') throw new CityError('VISIT_NOT_ACTIVE', '她已经到家门口了，城里的事到此为止。', 'settled', { state: visit.state });
      // 回家路上不再接受新交易和新去处，只能说话
      if (visit.state === 'returning' && type !== 'say' && type !== 'go_home') throw new CityError('VISIT_NOT_ACTIVE', '她在回家的路上，不能再做别的。', 'returning', { state: visit.state });
      const r = c.mustResident(visit.resident_id);
      const subject = `house:${visit.actor_id}`;
      rateCheck(c, subject, 'act', c.params.houseActsPerHour, 3600_000, now);
      clearChatWake(c, visit);
      const result = perform(c, r, body.action, now, visitById(c, visitId)!, subject);
      rateNote(c, subject, 'act', now);
      c.db.run('UPDATE residents SET last_seen_at = ? WHERE resident_id = ?', now, r.resident_id);
      return { state: visitById(c, visitId)!.state, payload: result };
    });
  } catch (e) {
    if (e instanceof CityError) c.metrics.rejected++;
    throw e;
  }
}

// ───────────────────────── 结果未知的订单 ─────────────────────────

/**
 * 人工确认一笔结果未知的订单（对账之后由管理端调用，不自动）。
 * 支持在城期间与室友返家关单（reconcile / closed）后的跨关单平衡结算；settled 且尚未 release 的窗口返回 409 awaiting_release。
 */
export function resolvePendingOrder(
  c: CityService,
  orderId: string,
  outcome: 'completed' | 'failed',
): { order_id: string; status: string; visit_state?: string; reconcile_ok: boolean } {
  if (outcome !== 'completed' && outcome !== 'failed') {
    throw cityBadRequest('outcome 只能是 completed 或 failed。', 'bad_outcome');
  }
  return c.commit(() => {
    c.assertRunning();
    const o = c.db.get<Row>("SELECT * FROM orders WHERE order_id = ? AND status = 'pending'", orderId);
    if (!o) throw new CityError('NOT_FOUND', '没有这笔待确认的订单。');
    const r = c.mustResident(String(o.resident_id));
    const visit = o.visit_id ? visitById(c, String(o.visit_id)) : null;
    if (visit && (visit.state === 'settled' || visit.state === 'settling')) {
      throw cityConflict('这次访问正在等待内核完成返家确认（release），请稍后再处理这笔订单。', 'awaiting_release', {
        visit_id: visit.visit_id,
        state: visit.state,
      });
    }
    const visitClosed = Boolean(visit && (visit.state === 'reconcile' || visit.state === 'closed'));
    const now = c.now();
    const yen = Number(o.yen);
    const qty = Number(o.quantity);
    const itemTyp = String(o.type);
    unhold(c, r.resident_id, yen);
    c.db.run('UPDATE orders SET status = ?, resolved_at = ? WHERE order_id = ?', outcome, now, orderId);
    if (outcome === 'completed') {
      const resolvedGood = findGoodAtPlace(String(o.place_id), String(o.sku), c.catalogTime(now), true);
      const goodLabel = resolvedGood?.name ?? itemName(itemTyp);
      ledger(c, `order:${orderId}`, 'purchase', goodLabel, [[purseOf(r.resident_id), -yen], [SHOPS, yen]], visit?.visit_id ?? null);
      if (resolvedGood?.assetId) {
        addPurchasedInstances(
          c,
          r.resident_id,
          itemTyp,
          qty,
          { domain: 'tokyo_shop', sku: resolvedGood.sku, asset_id: resolvedGood.assetId, place_id: String(o.place_id) },
          { title: resolvedGood.name, created_at_ms: now },
          visit?.visit_id ?? null,
          visitClosed ? 'locker' : 'held',
        );
      } else if (visitClosed) {
        if (!isCarryHome(itemTyp)) addDisposed(c, r.resident_id, itemTyp, qty, visit!.visit_id);
        else addPlainToLocker(c, r.resident_id, itemTyp, qty, visit!.visit_id);
      } else {
        addPlain(c, r.resident_id, itemTyp, qty, visit?.visit_id ?? null, 'acquired');
      }
      if (visit && !visitClosed) {
        outboxPurchase(c, visit, now, {
          what: goodLabel,
          yen: -yen,
          detail: { order_id: orderId, place: String(o.place_id), sku: String(o.sku), type: itemTyp, qty, resolved: true },
        });
      }
    } else if (visitClosed) {
      // 室友已回家关单：解锁的钱从随身钱包划回桥接池，使随身钱包归零，并写 order_refunded 通知内核补回家庭钱包
      ledger(c, `order:${orderId}:refund_bridge`, 'order_refund', '未决订单退款', [[purseOf(r.resident_id), -yen], [BRIDGE, yen]], visit!.visit_id);
      const leftPending = c.db.scalar("SELECT COUNT(*) FROM orders WHERE visit_id = ? AND status = 'pending'", visit!.visit_id);
      outboxOrderRefunded(c, visit!, now, { order_id: orderId, yen, all_pending_cleared: leftPending === 0 });
    }
    if (visitClosed) {
      const leftPending = c.db.scalar("SELECT COUNT(*) FROM orders WHERE visit_id = ? AND status = 'pending'", visit!.visit_id);
      if (leftPending === 0 && visit!.state === 'reconcile') {
        c.db.run("UPDATE visits SET state = 'closed' WHERE visit_id = ?", visit!.visit_id);
      }
    }
    c.emitTo([r.resident_id], 'order_resolved', { order_id: orderId, status: outcome }, now);
    const report = runReconcile(c, 'order_resolved');
    const freshVisit = visit ? visitById(c, visit.visit_id) : undefined;
    return {
      order_id: orderId,
      status: outcome,
      ...(freshVisit ? { visit_state: freshVisit.state } : {}),
      reconcile_ok: report.ok,
    };
  });
}

export function installActions(c: CityService): void {
  c.jobHandlers.set('locker_expire', (payload, _job, now) => {
    expireLockerDeposit(c, String(payload.depositId ?? ''), now);
  });
  c.hooks.recover.push(() => {
    for (const d of c.db.all<{ deposit_id: string; expires_at: number }>("SELECT deposit_id, expires_at FROM locker_deposits WHERE status = 'active'")) {
      c.schedule('locker_expire', `locker:${d.deposit_id}`, d.expires_at, { depositId: d.deposit_id });
    }
  });
  // 清理：过期的回执、限速流水、旧事件、旧聊天。桥接回执和 outbox 永久保存，不在这里
  c.jobHandlers.set('prune', (_payload, _job, now) => {
    c.db.run('DELETE FROM request_receipts WHERE expires_at <= ?', now);
    c.db.run('DELETE FROM rate_log WHERE at <= ?', now - 86_400_000);
    c.db.run('DELETE FROM login_tickets WHERE expires_at <= ?', now - 7 * 86_400_000);
    c.db.run('DELETE FROM web_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)', now - 7 * 86_400_000, now - 7 * 86_400_000);
    const cut = now - c.params.eventRetentionMs;
    for (const row of c.db.all<{ resident_id: string; cut: number }>('SELECT resident_id, MAX(cursor) AS cut FROM resident_events WHERE created_at <= ? GROUP BY resident_id', cut)) {
      c.db.run('DELETE FROM resident_events WHERE resident_id = ? AND cursor <= ?', row.resident_id, row.cut);
      c.db.run('UPDATE stream_heads SET retained_from = ? WHERE stream_key = ?', row.cut + 1, `r:${row.resident_id}`);
    }
    const pub = c.db.scalar('SELECT COALESCE(MAX(cursor), 0) FROM public_events WHERE created_at <= ?', cut);
    if (pub > 0) {
      c.db.run('DELETE FROM public_events WHERE cursor <= ?', pub);
      c.db.run("UPDATE stream_heads SET retained_from = ? WHERE stream_key = 'pub'", pub + 1);
    }
    c.db.run('DELETE FROM chat_audience WHERE message_id IN (SELECT message_id FROM chat_messages WHERE sent_at <= ?)', cut);
    c.db.run('DELETE FROM chat_messages WHERE sent_at <= ?', cut);
    c.schedule('prune', `prune:${Math.floor(now / 3600_000) + 1}`, (Math.floor(now / 3600_000) + 1) * 3600_000);
  });
  c.hooks.recover.push((now) => c.schedule('prune', `prune:${Math.floor(now / 3600_000) + 1}`, (Math.floor(now / 3600_000) + 1) * 3600_000));
}

