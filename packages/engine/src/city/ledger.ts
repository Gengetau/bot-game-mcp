/**
 * 城市世界的钱和物品。
 *
 * 钱（虚拟日元，整数）只通过 ledger() 变动：每笔交易的分录合计为零、原因键（cause_key）永久唯一，
 * 同一个原因键第二次调用什么都不做（返回 false）。居民账户不能为负、不能动用被锁住的钱；系统账户可以为负。
 * 物品只通过这里的函数变动；带出门的物品每件资源一行（带着 origin_ref），不和城里得到的同类物品合并。
 */
import { sanitizeUserText } from '../core/text.js';
import type { Row } from '../world/db.js';
import { isStorable, itemName, itemType } from './catalog.js';
import { cityBadRequest, cityPrecondition } from './errors.js';
import type { CityService } from './service.js';

/** 外部 bot 首次进城的发放来源 */
export const MINT = 'sys:mint';
/** 车费的去处 */
export const TRANSIT = 'sys:transit';
/** 店铺的收入（第一期所有店铺共用一个账户；没有店主） */
export const SHOPS = 'sys:shops';
/** 桥接系统账户：随身钱包的钱从这里来、回这里去（规格 3.5、3.8） */
export const BRIDGE = 'bridge:ai-house';

export const SYSTEM_ACCOUNTS = [MINT, TRANSIT, SHOPS, BRIDGE] as const;

export const purseOf = (residentId: string): string => `acct:${residentId}`;

export function ensureSystemAccounts(c: CityService): void {
  for (const id of SYSTEM_ACCOUNTS) c.db.run("INSERT OR IGNORE INTO accounts(account_id, resident_id, kind, balance) VALUES (?, NULL, 'system', 0)", id);
}

export function ensurePurse(c: CityService, residentId: string): void {
  c.db.run("INSERT OR IGNORE INTO accounts(account_id, resident_id, kind, balance) VALUES (?, ?, 'resident', 0)", purseOf(residentId), residentId);
}

export interface Wallet {
  balance: number;
  /** 被结果未知的交易锁住的钱 */
  held: number;
  /** balance - held：账面上能动的钱（室友还要再减去回程预留，见 trips.ts 的 spendable） */
  available: number;
}

export function wallet(c: CityService, residentId: string): Wallet {
  const row = c.db.get<{ balance: number; held: number }>('SELECT balance, held FROM accounts WHERE account_id = ?', purseOf(residentId));
  const balance = row?.balance ?? 0;
  const held = row?.held ?? 0;
  return { balance, held, available: balance - held };
}

export function accountBalance(c: CityService, accountId: string): number {
  return c.db.get<{ balance: number }>('SELECT balance FROM accounts WHERE account_id = ?', accountId)?.balance ?? 0;
}

/**
 * 记一笔账。entries 合计必须为零；causeKey 永久唯一，重复的原因键不做任何事并返回 false。
 * 居民账户的钱不够（扣完会低于被锁住的额度）时抛 insufficient_funds，整笔不生效。
 */
export function ledger(
  c: CityService,
  causeKey: string,
  kind: string,
  label: string,
  entries: readonly (readonly [account: string, delta: number])[],
  visitId: string | null = null,
): boolean {
  let sum = 0;
  for (const [, delta] of entries) {
    if (!Number.isSafeInteger(delta)) throw new Error(`账目金额必须是整数日元：${causeKey}`);
    sum += delta;
  }
  if (sum !== 0) throw new Error(`账目不平：${causeKey}`);
  if (c.db.get('SELECT 1 AS x FROM ledger_transactions WHERE cause_key = ?', causeKey)) return false;
  // 先把每个账户的净变动算清、查够不够，再写交易头：调用方就算接住了「钱不够」，原因键也不会被一笔没发生的交易占掉
  const net = new Map<string, number>();
  for (const [account, delta] of entries) net.set(account, (net.get(account) ?? 0) + delta);
  for (const [account, delta] of net) {
    if (delta === 0) continue;
    const acct = c.db.get<{ kind: string; balance: number; held: number }>('SELECT kind, balance, held FROM accounts WHERE account_id = ?', account);
    if (!acct) throw new Error(`没有这个账户：${account}`);
    if (acct.kind !== 'system' && acct.balance + delta < acct.held) throw cityPrecondition('钱不够。', 'insufficient_funds');
  }
  const { lastInsertRowid } = c.db.run('INSERT INTO ledger_transactions(cause_key, kind, label, visit_id, created_at) VALUES (?,?,?,?,?)', causeKey, kind, label, visitId, c.now());
  for (const [account, delta] of entries) {
    if (delta === 0) continue;
    c.db.run('UPDATE accounts SET balance = balance + ?, revision = revision + 1 WHERE account_id = ?', delta, account);
    c.db.run('INSERT INTO ledger_entries(transaction_id, account_id, delta) VALUES (?,?,?)', lastInsertRowid, account, delta);
  }
  return true;
}

/** 把钱锁住（结果未知的交易）。锁住的钱不能花。 */
export function hold(c: CityService, residentId: string, yen: number): void {
  const w = wallet(c, residentId);
  if (yen < 0 || w.available < yen) throw cityPrecondition('钱不够。', 'insufficient_funds');
  c.db.run('UPDATE accounts SET held = held + ?, revision = revision + 1 WHERE account_id = ?', yen, purseOf(residentId));
}

export function unhold(c: CityService, residentId: string, yen: number): void {
  c.db.run('UPDATE accounts SET held = MAX(0, held - ?), revision = revision + 1 WHERE account_id = ?', yen, purseOf(residentId));
}

/** 某次访问里随身钱包的收支，按说法归并（结算清单的 spend_summary）。不含出门入账和回家扣回那两笔。 */
export function spendSummary(c: CityService, visitId: string, residentId: string): { what: string; yen: number }[] {
  return c.db
    .all<{ label: string; yen: number } & Row>(
      `SELECT t.label AS label, SUM(e.delta) AS yen FROM ledger_entries e JOIN ledger_transactions t ON t.transaction_id = e.transaction_id
       WHERE t.visit_id = ? AND e.account_id = ? AND t.kind NOT IN ('visit_in','visit_out','order_refund') GROUP BY t.label ORDER BY MIN(e.entry_id)`,
      visitId,
      purseOf(residentId),
    )
    .map((r) => ({ what: String(r.label), yen: Number(r.yen) }));
}

// ───────────────────────── 物品 ─────────────────────────

export interface ItemRow {
  item_id: string;
  owner_id: string;
  type: string;
  quantity: number;
  instance: number;
  origin_ref: string | null;
  origin_json: string | null;
  meta_json: string | null;
  borrowed_from: string | null;
  visit_id: string | null;
  state: 'held' | 'returned' | 'locker' | 'disposed' | 'space';
  created_at: number;
  updated_at: number;
}

/** 身上可用的物品（数量为零的不算）。带出门的排在前面。 */
export function heldItems(c: CityService, residentId: string): ItemRow[] {
  return c.db.all<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND state = 'held' AND quantity > 0 ORDER BY (origin_ref IS NULL), (instance = 0), created_at, item_id",
    residentId,
  );
}

/** 城市储物柜里的物品（数量为零的不算）。 */
export function lockerItems(c: CityService, residentId: string): ItemRow[] {
  return c.db.all<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND state = 'locker' AND quantity > 0 ORDER BY (instance = 0), updated_at DESC, item_id",
    residentId,
  );
}

export type ItemFate =
  | 'acquired'
  | 'received'
  | 'consumed'
  | 'given'
  | 'sold'
  | 'stored'
  | 'retrieved'
  | 'disposed'
  | 'loaned'
  | 'returned_loan'
  | 'crafted'
  | 'placed';

function logItem(c: CityService, item: Pick<ItemRow, 'item_id' | 'owner_id' | 'type' | 'origin_ref'>, visitId: string | null, qty: number, fate: ItemFate, extra: { effectId?: string; counterparty?: string } = {}): void {
  c.db.run(
    'INSERT INTO item_events(visit_id, resident_id, item_id, type, origin_ref, quantity, fate, effect_id, counterparty, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    visitId,
    item.owner_id,
    item.item_id,
    item.type,
    item.origin_ref,
    qty,
    fate,
    extra.effectId ?? null,
    extra.counterparty ?? null,
    c.now(),
  );
}

export function sanitizeItemMeta(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { untrusted: true };
  if (typeof src.title === 'string') out.title = sanitizeUserText(src.title).trim().slice(0, 40);
  if (typeof src.summary === 'string') out.summary = sanitizeUserText(src.summary).trim().slice(0, 300);
  if (typeof src.author_id === 'string') out.author_id = src.author_id.slice(0, 64);
  if (typeof src.author_name === 'string') out.author_name = sanitizeUserText(src.author_name).trim().slice(0, 24);
  if (typeof src.created_at_ms === 'number' && Number.isSafeInteger(src.created_at_ms)) out.created_at_ms = src.created_at_ms;
  if (typeof src.reading_progress === 'number' && Number.isSafeInteger(src.reading_progress) && src.reading_progress >= 0) {
    out.reading_progress = src.reading_progress;
  }
  if (typeof src.location_ref === 'string') out.location_ref = src.location_ref.slice(0, 80);
  return out;
}

/** 城里得到的物品（买的、别人送的）：并进身上那一堆。返回物品行编号。 */
export function addPlain(c: CityService, residentId: string, type: string, qty: number, visitId: string | null, fate: 'acquired' | 'received', counterparty?: string): string {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('物品数量必须是正整数');
  const now = c.now();
  const existing = c.db.get<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'held'",
    residentId,
    type,
  );
  let itemId: string;
  if (existing) {
    itemId = existing.item_id;
    c.db.run('UPDATE items SET quantity = quantity + ?, visit_id = ?, updated_at = ? WHERE item_id = ?', qty, visitId, now, itemId);
  } else {
    itemId = c.id('it');
    c.db.run(
      "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,0,NULL,NULL,NULL,NULL,?,'held',?,?)",
      itemId,
      residentId,
      type,
      qty,
      visitId,
      now,
      now,
    );
  }
  logItem(c, { item_id: itemId, owner_id: residentId, type, origin_ref: null }, visitId, qty, fate, counterparty ? { counterparty } : {});
  return itemId;
}

/** 直接把普通堆叠物品发进个人城市储物柜（用于室友返家后未决订单确认为已成交）。 */
export function addPlainToLocker(c: CityService, residentId: string, type: string, qty: number, visitId: string | null): string {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('物品数量必须是正整数');
  const now = c.now();
  const existing = c.db.get<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'locker' ORDER BY item_id LIMIT 1",
    residentId,
    type,
  );
  let itemId: string;
  if (existing) {
    itemId = existing.item_id;
    c.db.run('UPDATE items SET quantity = quantity + ?, visit_id = ?, updated_at = ? WHERE item_id = ?', qty, visitId, now, itemId);
  } else {
    itemId = c.id('it');
    c.db.run(
      "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,0,NULL,NULL,NULL,NULL,?,'locker',?,?)",
      itemId,
      residentId,
      type,
      qty,
      visitId,
      now,
      now,
    );
  }
  logItem(c, { item_id: itemId, owner_id: residentId, type, origin_ref: null }, visitId, qty, 'stored');
  return itemId;
}

/** 直接记一笔返家后已清理的现点热饮（carry_home: false 的关单后成交订单）。 */
export function addDisposed(c: CityService, residentId: string, type: string, qty: number, visitId: string | null): string {
  const now = c.now();
  const itemId = c.id('it');
  c.db.run(
    "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,0,0,NULL,NULL,NULL,NULL,?,'disposed',?,?)",
    itemId,
    residentId,
    type,
    visitId,
    now,
    now,
  );
  logItem(c, { item_id: itemId, owner_id: residentId, type, origin_ref: null }, visitId, qty, 'disposed');
  return itemId;
}

/** 结算确认（releaseVisit）时把身上未映射的物品转入储物柜；若在城期间已手动存入则不动。 */
export function moveItemToLocker(c: CityService, itemId: string, at: number = c.now()): void {
  const row = c.db.get<ItemRow & Row>("SELECT * FROM items WHERE item_id = ? AND state = 'held'", itemId);
  if (!row || row.quantity <= 0) return;
  if (row.instance === 1 || row.origin_ref !== null) {
    c.db.run("UPDATE items SET state = 'locker', updated_at = ? WHERE item_id = ?", at, row.item_id);
    logItem(c, row, row.visit_id, row.quantity, 'stored');
    return;
  }
  const existing = c.db.get<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'locker' AND item_id <> ? ORDER BY item_id LIMIT 1",
    row.owner_id,
    row.type,
    row.item_id,
  );
  if (existing) {
    c.db.run('UPDATE items SET quantity = quantity + ?, updated_at = ? WHERE item_id = ?', row.quantity, at, existing.item_id);
    c.db.run("UPDATE items SET quantity = 0, state = 'locker', updated_at = ? WHERE item_id = ?", at, row.item_id);
    logItem(c, existing, row.visit_id, row.quantity, 'stored');
  } else {
    c.db.run("UPDATE items SET state = 'locker', updated_at = ? WHERE item_id = ?", at, row.item_id);
    logItem(c, row, row.visit_id, row.quantity, 'stored');
  }
}

/** 结算确认（releaseVisit）时清理未喝完的 carry_home: false 现点饮品。 */
export function disposeHeldItem(c: CityService, itemId: string, at: number = c.now()): void {
  const row = c.db.get<ItemRow & Row>("SELECT * FROM items WHERE item_id = ? AND state = 'held'", itemId);
  if (!row) return;
  c.db.run("UPDATE items SET quantity = 0, state = 'disposed', updated_at = ? WHERE item_id = ?", at, row.item_id);
  if (row.quantity > 0) logItem(c, row, row.visit_id, row.quantity, 'disposed');
}

/** 从小屋带出来的物品：每件资源一行，记着它在内核里的来历。 */
export function addCarried(
  c: CityService,
  residentId: string,
  type: string,
  qty: number,
  originRef: string,
  origin: Record<string, unknown>,
  visitId: string,
  meta?: unknown,
): string {
  const now = c.now();
  const itemId = c.id('it');
  const instance = qty === 1 ? 1 : 0;
  const cleanMeta = instance === 1 ? sanitizeItemMeta(meta) : null;
  c.db.run(
    "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?,'held',?,?)",
    itemId,
    residentId,
    type,
    qty,
    instance,
    originRef,
    JSON.stringify(origin),
    cleanMeta ? JSON.stringify(cleanMeta) : null,
    visitId,
    now,
    now,
  );
  return itemId;
}

/**
 * 从身上拿走若干件（吃掉、送人）。可以点名物品行（itemId），也可以只说类型：按类型时先用带出门的，再用城里得到的。
 * 数量不够整笔不生效。返回实际动了哪些行、各多少（记去向流水用）。
 */
export function takeItems(
  c: CityService,
  residentId: string,
  what: { itemId?: string; type?: string },
  qty: number,
  visitId: string | null,
  fate: 'consumed' | 'given' | 'sold',
  extra: { effectId?: string; counterparty?: string } = {},
): { type: string; taken: { itemId: string; originRef: string | null; qty: number }[] } {
  if (!Number.isInteger(qty) || qty <= 0 || qty > 99) throw cityPrecondition('数量不对。', 'bad_quantity');
  const rows = heldItems(c, residentId).filter((i) => (what.itemId ? i.item_id === what.itemId : i.type === what.type));
  const total = rows.reduce((n, i) => n + i.quantity, 0);
  if (rows.length === 0 || total < qty) throw cityPrecondition('你身上没有这么多。', 'not_enough_items');
  const now = c.now();
  let left = qty;
  const taken: { itemId: string; originRef: string | null; qty: number }[] = [];
  for (const row of rows) {
    if (left <= 0) break;
    if ((fate === 'given' || fate === 'sold') && row.borrowed_from !== null) {
      throw cityPrecondition('借来的东西不能转送或出售。', 'item_borrowed');
    }
    const n = Math.min(left, row.quantity);
    c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', n, now, row.item_id);
    logItem(c, row, visitId, n, fate, extra);
    taken.push({ itemId: row.item_id, originRef: row.origin_ref, qty: n });
    left -= n;
  }
  return { type: rows[0]!.type, taken };
}

/**
 * 赠送物品流转：具名实例件（instance = 1）与整行携带物原地更新 owner_id 与 visit_id，永久保留 item_id 和 origin_ref；
 * 多份携带物部分赠送时拆分继承 origin_ref；普通堆叠件扣减源行并合入接收方堆叠行。
 */
export function transferItems(
  c: CityService,
  fromResidentId: string,
  toResidentId: string,
  what: { itemId?: string; type?: string },
  qty: number,
  fromVisitId: string | null,
  toVisitId: string | null,
): { type: string; instanceItemId?: string } {
  if (!Number.isInteger(qty) || qty <= 0 || qty > 99) throw cityPrecondition('数量不对。', 'bad_quantity');
  const rows = heldItems(c, fromResidentId).filter((i) => (what.itemId ? i.item_id === what.itemId : i.type === what.type));
  const total = rows.reduce((n, i) => n + i.quantity, 0);
  if (rows.length === 0 || total < qty) throw cityPrecondition('你身上没有这么多。', 'not_enough_items');
  const now = c.now();
  let left = qty;
  let instanceItemId: string | undefined;
  for (const row of rows) {
    if (left <= 0) break;
    if (row.borrowed_from !== null) {
      throw cityPrecondition('借来的东西不能转送给别人。', 'item_borrowed');
    }
    const n = Math.min(left, row.quantity);
    if (row.instance === 1 || (row.origin_ref !== null && n === row.quantity)) {
      c.db.run('UPDATE items SET owner_id = ?, visit_id = ?, updated_at = ? WHERE item_id = ?', toResidentId, toVisitId, now, row.item_id);
      logItem(c, row, fromVisitId, n, 'given', { counterparty: toResidentId });
      logItem(c, { ...row, owner_id: toResidentId }, toVisitId, n, 'received', { counterparty: fromResidentId });
      if (qty === 1 && row.instance === 1) instanceItemId = row.item_id;
    } else if (row.origin_ref !== null) {
      c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', n, now, row.item_id);
      logItem(c, row, fromVisitId, n, 'given', { counterparty: toResidentId });
      const splitId = c.id('it');
      const splitInstance = n === 1 ? 1 : 0;
      c.db.run(
        "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,'held',?,?)",
        splitId,
        toResidentId,
        row.type,
        n,
        splitInstance,
        row.origin_ref,
        row.origin_json,
        toVisitId,
        now,
        now,
      );
      logItem(c, { item_id: splitId, owner_id: toResidentId, type: row.type, origin_ref: row.origin_ref }, toVisitId, n, 'received', { counterparty: fromResidentId });
      if (qty === 1 && splitInstance === 1) instanceItemId = splitId;
    } else {
      c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', n, now, row.item_id);
      logItem(c, row, fromVisitId, n, 'given', { counterparty: toResidentId });
      addPlain(c, toResidentId, row.type, n, toVisitId, 'received', fromResidentId);
    }
    left -= n;
  }
  return { type: rows[0]!.type, ...(instanceItemId ? { instanceItemId } : {}) };
}

/** 存入个人城市储物柜（store_locker）。 */
export function storeToLocker(
  c: CityService,
  residentId: string,
  what: { itemId?: string; type?: string },
  qty: number,
  visitId: string | null,
): { item_id: string; type: string; qty: number } {
  if (!Number.isInteger(qty) || qty <= 0 || qty > 99) throw cityBadRequest('qty 要是 1 到 99 的整数。', 'bad_quantity');
  const held = heldItems(c, residentId);
  let candidates: ItemRow[];
  let targetType: string;
  if (what.itemId) {
    const exact = held.find((i) => i.item_id === what.itemId);
    if (!exact) throw cityPrecondition('你身上没有这件东西。', 'not_enough_items');
    targetType = exact.type;
    if (!isStorable(targetType)) throw cityPrecondition(`${itemName(targetType)}是现点饮品，不能存进储物柜。`, 'not_storable');
    if (exact.origin_ref !== null) throw cityPrecondition('从家里带出来的随身物品不能存进公共车站储物柜。', 'carried_from_home');
    candidates = [exact];
  } else {
    const t = what.type ?? '';
    if (!t || !itemType(t)) throw cityBadRequest('要说清楚是哪件东西：item_id 或 item（物品类型）。', 'no_such_item');
    targetType = t;
    if (!isStorable(targetType)) throw cityPrecondition(`${itemName(targetType)}是现点饮品，不能存进储物柜。`, 'not_storable');
    const matching = held.filter((i) => i.type === targetType);
    const storableRows = matching.filter((i) => i.origin_ref === null);
    const storableTotal = storableRows.reduce((n, i) => n + i.quantity, 0);
    const allTotal = matching.reduce((n, i) => n + i.quantity, 0);
    if (storableTotal < qty && allTotal >= qty) {
      throw cityPrecondition('从家里带出来的随身物品不能存进公共车站储物柜。', 'carried_from_home');
    }
    candidates = storableRows;
  }
  const avail = candidates.reduce((n, i) => n + i.quantity, 0);
  if (avail < qty) throw cityPrecondition('你身上没有这么多可寄存的物品。', 'not_enough_items');

  const currentLocker = lockerItems(c, residentId);
  const currentQty = currentLocker.reduce((n, i) => n + i.quantity, 0);
  if (currentQty + qty > c.params.maxLockerQty) {
    throw cityPrecondition(`储物柜最多存放 ${c.params.maxLockerQty} 件物品。`, 'locker_full');
  }
  let checkLeft = qty;
  let addedEntries = 0;
  let touchesPlain = false;
  for (const row of candidates) {
    if (checkLeft <= 0) break;
    const n = Math.min(checkLeft, row.quantity);
    if (row.instance === 1) addedEntries += 1;
    else touchesPlain = true;
    checkLeft -= n;
  }
  if (touchesPlain && !currentLocker.some((i) => i.type === targetType && i.instance === 0 && i.origin_ref === null)) {
    addedEntries += 1;
  }
  if (currentLocker.length + addedEntries > c.params.maxLockerEntries) {
    throw cityPrecondition(`储物柜最多保留 ${c.params.maxLockerEntries} 格物品。`, 'locker_full');
  }

  const now = c.now();
  let left = qty;
  let lastId = '';
  for (const row of candidates) {
    if (left <= 0) break;
    const n = Math.min(left, row.quantity);
    if (row.instance === 1) {
      c.db.run("UPDATE items SET state = 'locker', visit_id = ?, updated_at = ? WHERE item_id = ?", visitId, now, row.item_id);
      logItem(c, row, visitId, 1, 'stored');
      lastId = row.item_id;
    } else {
      c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', n, now, row.item_id);
      lastId = addPlainToLocker(c, residentId, row.type, n, visitId);
    }
    left -= n;
  }
  return { item_id: lastId, type: targetType, qty };
}

/** 从个人城市储物柜取出（take_locker）。 */
export function takeFromLocker(
  c: CityService,
  residentId: string,
  what: { itemId?: string; type?: string },
  qty: number,
  visitId: string | null,
): { item_id: string; type: string; qty: number } {
  if (!Number.isInteger(qty) || qty <= 0 || qty > 99) throw cityBadRequest('qty 要是 1 到 99 的整数。', 'bad_quantity');
  const locker = lockerItems(c, residentId);
  let candidates: ItemRow[];
  let targetType: string;
  if (what.itemId) {
    const exact = locker.find((i) => i.item_id === what.itemId);
    if (!exact) throw cityPrecondition('你的储物柜里没有这件东西。', 'not_enough_items');
    targetType = exact.type;
    candidates = [exact];
  } else {
    const t = what.type ?? '';
    if (!t || !itemType(t)) throw cityBadRequest('要说清楚是哪件东西：item_id 或 item（物品类型）。', 'no_such_item');
    targetType = t;
    candidates = locker.filter((i) => i.type === targetType);
  }
  const avail = candidates.reduce((n, i) => n + i.quantity, 0);
  if (avail < qty) throw cityPrecondition('储物柜里没有这么多。', 'not_enough_items');

  const now = c.now();
  let left = qty;
  let lastId = '';
  for (const row of candidates) {
    if (left <= 0) break;
    const n = Math.min(left, row.quantity);
    if (row.instance === 1) {
      c.db.run("UPDATE items SET state = 'held', visit_id = ?, updated_at = ? WHERE item_id = ?", visitId, now, row.item_id);
      logItem(c, row, visitId, 1, 'retrieved');
      lastId = row.item_id;
    } else {
      c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', n, now, row.item_id);
      const existingHeld = c.db.get<ItemRow & Row>(
        "SELECT * FROM items WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'held'",
        residentId,
        row.type,
      );
      if (existingHeld) {
        lastId = existingHeld.item_id;
        c.db.run('UPDATE items SET quantity = quantity + ?, visit_id = ?, updated_at = ? WHERE item_id = ?', n, visitId, now, lastId);
      } else {
        lastId = c.id('it');
        c.db.run(
          "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,0,NULL,NULL,NULL,NULL,?,'held',?,?)",
          lastId,
          residentId,
          row.type,
          n,
          visitId,
          now,
          now,
        );
      }
      logItem(c, { item_id: lastId, owner_id: residentId, type: row.type, origin_ref: null }, visitId, n, 'retrieved');
    }
    left -= n;
  }
  return { item_id: lastId, type: targetType, qty };
}

/** 全部账户余额之和（复式记账下恒为零）。对账用。 */
export function ledgerImbalance(c: CityService): number {
  return c.db.scalar('SELECT COALESCE(SUM(balance), 0) FROM accounts');
}


const TRUSTED_ASSET_ID_RE = /^pa_[a-z0-9_]{3,64}$/;

/** 创建城内商店购买的具名实例物品（如服饰礼盒 instance=1，asset_id 仅存服务端可信 origin_json，防玩家 meta_json 伪造）。 */
export function addPurchasedInstances(
  c: CityService,
  residentId: string,
  type: string,
  qty: number,
  originData: Record<string, unknown>,
  metaData: Record<string, unknown> | null,
  visitId: string | null,
  state: 'held' | 'locker' = 'held',
): string[] {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('物品数量必须是正整数');
  const now = c.now();
  const originJson = JSON.stringify(originData);
  const cleanMeta = metaData ? sanitizeItemMeta(metaData) : null;
  const metaJson = cleanMeta ? JSON.stringify(cleanMeta) : null;
  const ids: string[] = [];
  for (let i = 0; i < qty; i++) {
    const itemId = c.id('it');
    c.db.run(
      'INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,1,1,NULL,?,?,NULL,?,?,?,?)',
      itemId,
      residentId,
      type,
      originJson,
      metaJson,
      visitId,
      state,
      now,
      now,
    );
    logItem(c, { item_id: itemId, owner_id: residentId, type, origin_ref: null }, visitId, 1, state === 'locker' ? 'stored' : 'acquired');
    ids.push(itemId);
  }
  return ids;
}

/** 从服务端可信 origin_json 提取服饰资产 ID；绝不信任玩家可改的 meta_json。 */
export function trustedAssetIdOf(row: Pick<ItemRow, 'type' | 'origin_json'>): string | null {
  if (row.type !== 'apparel_bundle' || !row.origin_json) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(row.origin_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || parsed.domain !== 'tokyo_shop' || typeof parsed.asset_id !== 'string') return null;
  return TRUSTED_ASSET_ID_RE.test(parsed.asset_id) ? parsed.asset_id : null;
}
