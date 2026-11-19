/**
 * 城市世界的钱和物品。
 *
 * 钱（虚拟日元，整数）只通过 ledger() 变动：每笔交易的分录合计为零、原因键（cause_key）永久唯一，
 * 同一个原因键第二次调用什么都不做（返回 false）。居民账户不能为负、不能动用被锁住的钱；系统账户可以为负。
 * 物品只通过这里的函数变动；带出门的物品每件资源一行（带着 origin_ref），不和城里得到的同类物品合并。
 */
import { sanitizeUserText } from '../core/text.js';
import type { Row } from '../world/db.js';
import { sha256 } from '../world/service.js';
import { MAX_FLYLEAF_ENTRIES, MAX_FLYLEAF_NOTE_CHARS, isStorable, itemName, itemType } from './catalog.js';
import { CityError, cityBadRequest, cityPrecondition } from './errors.js';
import type { CityService } from './service.js';

/** 外部 bot 首次进城的发放来源 */
export const MINT = 'sys:mint';
/** 车费的去处 */
export const TRANSIT = 'sys:transit';
/** 店铺的收入（第一期所有店铺共用一个账户；没有店主） */
export const SHOPS = 'sys:shops';
/** 密封竞拍的托管账户（出价预占暂存此处，成交转给卖家、流拍或撤回原路退回） */
export const AUCTION_ESCROW = 'sys:auction';
/** 桥接系统账户：随身钱包的钱从这里来、回这里去（规格 3.5、3.8） */
export const BRIDGE = 'bridge:ai-house';

export const SYSTEM_ACCOUNTS = [MINT, TRANSIT, SHOPS, AUCTION_ESCROW, BRIDGE] as const;

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
  state: 'held' | 'returned' | 'locker' | 'disposed' | 'space' | 'shelf' | 'drift' | 'lost_found';
  shelf_place_id?: string | null;
  shelf_price_yen?: number | null;
  created_at: number;
  updated_at: number;
}

export interface FlyleafEntry {
  by_id?: string;
  by_name: string;
  note: string;
  place_id?: string;
  at_ms: number;
  untrusted: true;
}

export interface LockerDepositRow {
  deposit_id: string;
  item_id: string;
  sender_id: string;
  recipient_id: string | null;
  voucher_hash: string | null;
  place_id: string;
  type: string;
  quantity: number;
  status: 'active' | 'claimed' | 'expired_returned' | 'expired_lost_found';
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  claimed_by: string | null;
}

/** 身上可用的物品（数量为零的不算）。带出门的排在前面。 */
export function heldItems(c: CityService, residentId: string): ItemRow[] {
  return c.db.all<ItemRow & Row>(
    "SELECT * FROM items WHERE owner_id = ? AND state = 'held' AND quantity > 0 ORDER BY (origin_ref IS NULL), (instance = 0), created_at, item_id",
    residentId,
  );
}

/** 个人城市储物柜里的物品（不含已锁定在公共代取寄存柜里的物品）。 */
export function lockerItems(c: CityService, residentId: string): ItemRow[] {
  return c.db.all<ItemRow & Row>(
    `SELECT * FROM items
     WHERE owner_id = ? AND state = 'locker' AND quantity > 0
       AND NOT EXISTS (SELECT 1 FROM locker_deposits d WHERE d.item_id = items.item_id AND d.status = 'active')
     ORDER BY (instance = 0), updated_at DESC, item_id`,
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
  if (Array.isArray(src.flyleaf)) {
    const cleanEntries: FlyleafEntry[] = [];
    for (const item of src.flyleaf.slice(-MAX_FLYLEAF_ENTRIES)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const cleanNote = [...sanitizeUserText(typeof rec.note === 'string' ? rec.note : '').trim()].slice(0, MAX_FLYLEAF_NOTE_CHARS).join('');
      if (!cleanNote) continue;
      const byName = [...sanitizeUserText(typeof rec.by_name === 'string' ? rec.by_name : '').trim()].slice(0, 24).join('') || '匿名旅人';
      cleanEntries.push({
        ...(typeof rec.by_id === 'string' ? { by_id: rec.by_id.slice(0, 64) } : {}),
        by_name: byName,
        note: cleanNote,
        ...(typeof rec.place_id === 'string' ? { place_id: rec.place_id.slice(0, 64) } : {}),
        at_ms: typeof rec.at_ms === 'number' && Number.isSafeInteger(rec.at_ms) ? rec.at_ms : 0,
        untrusted: true,
      });
    }
    if (cleanEntries.length > 0) out.flyleaf = cleanEntries;
  }
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
    `SELECT * FROM items
     WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'locker' AND quantity > 0
       AND NOT EXISTS (SELECT 1 FROM locker_deposits d WHERE d.item_id = items.item_id)
     ORDER BY item_id LIMIT 1`,
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
    `SELECT * FROM items
     WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'locker' AND quantity > 0 AND item_id <> ?
       AND NOT EXISTS (SELECT 1 FROM locker_deposits d WHERE d.item_id = items.item_id)
     ORDER BY item_id LIMIT 1`,
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
  if (!parsed || (parsed.domain !== 'city_shop' && parsed.domain !== 'tokyo_shop') || typeof parsed.asset_id !== 'string') return null;
  return TRUSTED_ASSET_ID_RE.test(parsed.asset_id) ? parsed.asset_id : null;
}

// ───────────────────────── 漂流文库本（扉页流转印记） ─────────────────────────

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function appendFlyleafNote(
  meta: Record<string, unknown>,
  entry: { byId: string; byName: string; note: string; placeId: string; at: number },
): Record<string, unknown> {
  const prev = Array.isArray(meta.flyleaf) ? (meta.flyleaf as FlyleafEntry[]) : [];
  const next: FlyleafEntry[] = [
    ...prev,
    {
      by_id: entry.byId,
      by_name: [...sanitizeUserText(entry.byName).trim()].slice(0, 24).join('') || '旅人',
      note: entry.note,
      place_id: entry.placeId,
      at_ms: entry.at,
      untrusted: true as const,
    },
  ].slice(-MAX_FLYLEAF_ENTRIES);
  return sanitizeItemMeta({ ...meta, summary: entry.note, flyleaf: next, untrusted: true }) ?? { untrusted: true };
}

export function cleanFlyleafInput(rawNote: unknown): string {
  if (rawNote === undefined || rawNote === null) return '';
  if (typeof rawNote !== 'string') throw cityBadRequest('note 必须是字符串。', 'bad_note');
  const cleaned = sanitizeUserText(rawNote).trim();
  if ([...cleaned].length > MAX_FLYLEAF_NOTE_CHARS) {
    throw cityBadRequest(`扉页批注最多 ${MAX_FLYLEAF_NOTE_CHARS} 个字。`, 'text_too_long');
  }
  return cleaned;
}

/** 阅读或批注文库本：instance=0 拆分 1 本升级为 instance=1；已是 instance=1 则原地更新同 item_id，不销毁重建。 */
export function annotatePaperback(
  c: CityService,
  residentId: string,
  what: { itemId?: string; type?: string },
  opts: { title?: string; note?: string; placeId: string; residentName: string; visitId: string | null },
  at: number,
): { item_id: string; type: string; reading_progress: number; flyleaf_count: number; title?: string } {
  const held = heldItems(c, residentId);
  let row: ItemRow | undefined;
  if (what.itemId) {
    row = held.find((i) => i.item_id === what.itemId);
    if (!row) throw cityPrecondition('你身上没有这本书。', 'not_enough_items');
  } else {
    const t = what.type ?? '';
    if (!t || !itemType(t)) throw cityBadRequest('要说清楚是哪本书：item_id 或 item。', 'no_such_item');
    // 传物品类型时优先从未批注的堆叠本中拆开新的一本；若全已拆封再续写已读本
    row = held.find((i) => i.type === t && i.instance === 0) ?? held.find((i) => i.type === t);
    if (!row) throw cityPrecondition('你身上没有文库本。', 'not_enough_items');
  }
  if (row.type !== 'paperback') {
    throw cityPrecondition(`${itemName(row.type)}不支持写读书扉页批注，当前仅支持文库本。`, 'not_readable');
  }
  const cleanNote = cleanFlyleafInput(opts.note);
  let cleanTitle = '';
  if (opts.title !== undefined) {
    cleanTitle = sanitizeUserText(opts.title).trim();
    if ([...cleanTitle].length > 40) throw cityBadRequest('书名最多 40 个字。', 'text_too_long');
  }

  if (row.instance === 0) {
    c.db.run('UPDATE items SET quantity = quantity - 1, updated_at = ? WHERE item_id = ?', at, row.item_id);
    const newId = c.id('it');
    let meta: Record<string, unknown> = {
      ...(cleanTitle ? { title: cleanTitle } : {}),
      reading_progress: 1,
      created_at_ms: at,
      untrusted: true,
    };
    if (cleanNote) {
      meta = appendFlyleafNote(meta, { byId: residentId, byName: opts.residentName, note: cleanNote, placeId: opts.placeId, at });
    } else {
      meta = sanitizeItemMeta(meta) ?? { untrusted: true };
    }
    c.db.run(
      "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, shelf_place_id, shelf_price_yen, created_at, updated_at) VALUES (?,?,?,1,1,NULL,NULL,?,NULL,?,'held',NULL,NULL,?,?)",
      newId,
      residentId,
      row.type,
      JSON.stringify(meta),
      opts.visitId,
      at,
      at,
    );
    const count = Array.isArray(meta.flyleaf) ? meta.flyleaf.length : 0;
    return { item_id: newId, type: row.type, reading_progress: 1, flyleaf_count: count, ...(typeof meta.title === 'string' ? { title: meta.title } : {}) };
  }

  const prev = parseMeta(row.meta_json);
  const nextProgress = (typeof prev.reading_progress === 'number' && Number.isSafeInteger(prev.reading_progress) ? prev.reading_progress : 0) + 1;
  let nextMeta: Record<string, unknown> = {
    ...prev,
    ...(cleanTitle ? { title: cleanTitle } : {}),
    reading_progress: nextProgress,
    untrusted: true,
  };
  if (cleanNote) {
    nextMeta = appendFlyleafNote(nextMeta, { byId: residentId, byName: opts.residentName, note: cleanNote, placeId: opts.placeId, at });
  } else {
    nextMeta = sanitizeItemMeta(nextMeta) ?? { untrusted: true };
  }
  c.db.run('UPDATE items SET meta_json = ?, updated_at = ? WHERE item_id = ?', JSON.stringify(nextMeta), at, row.item_id);
  const count = Array.isArray(nextMeta.flyleaf) ? nextMeta.flyleaf.length : 0;
  return {
    item_id: row.item_id,
    type: row.type,
    reading_progress: nextProgress,
    flyleaf_count: count,
    ...(typeof nextMeta.title === 'string' ? { title: nextMeta.title } : {}),
  };
}

/** 将已读/写过批注的 instance=1 文库本放入古书二手架（shelf）或车站图书漂流角（drift），全程保持同一 item_id。 */
export function driftBookToCorner(
  c: CityService,
  residentId: string,
  what: { itemId?: string; type?: string },
  mode: 'shelf' | 'drift',
  placeId: string,
  residentName: string,
  visitId: string | null,
  at: number,
  note?: string,
  resaleYen?: number,
): { item_id: string; type: string; flyleaf_count: number; title?: string } {
  const held = heldItems(c, residentId);
  const row = what.itemId ? held.find((i) => i.item_id === what.itemId) : held.find((i) => i.type === (what.type ?? ''));
  if (!row) throw cityPrecondition('你身上没有这本书。', 'not_enough_items');
  if (row.type !== 'paperback') throw cityPrecondition('只有文库本可以放上古书二手架或漂流角。', 'not_driftable');
  if (row.instance !== 1) throw cityPrecondition('需要先读过或写过批注（instance = 1）的文库本才能漂流或卖入二手架。', 'not_annotated');
  if (row.origin_ref !== null) throw cityPrecondition('从家里带出来的物品不能放入漂流角。', 'carried_from_home');
  if (row.borrowed_from !== null) throw cityPrecondition('借来的书不能转手或漂流。', 'item_borrowed');

  const cleanNote = cleanFlyleafInput(note);
  let meta = parseMeta(row.meta_json);
  if (cleanNote) {
    meta = appendFlyleafNote(meta, { byId: residentId, byName: residentName, note: cleanNote, placeId, at });
  } else {
    meta = sanitizeItemMeta(meta) ?? { untrusted: true };
  }
  c.db.run(
    'UPDATE items SET state = ?, shelf_place_id = ?, shelf_price_yen = ?, visit_id = NULL, meta_json = ?, updated_at = ? WHERE item_id = ?',
    mode,
    placeId,
    mode === 'shelf' ? (resaleYen ?? 350) : 0,
    JSON.stringify(meta),
    at,
    row.item_id,
  );
  logItem(c, row, visitId, 1, mode === 'shelf' ? 'sold' : 'placed', { counterparty: placeId });
  const count = Array.isArray(meta.flyleaf) ? meta.flyleaf.length : 0;
  return {
    item_id: row.item_id,
    type: row.type,
    flyleaf_count: count,
    ...(typeof meta.title === 'string' ? { title: meta.title } : {}),
  };
}

/** 从当前地点的古书二手架或漂流角淘走同一本 instance=1 文库本（保持同一 item_id）。 */
export function takeBookFromCorner(
  c: CityService,
  residentId: string,
  itemId: string,
  mode: 'shelf' | 'drift',
  placeId: string,
  visitId: string | null,
  at: number,
): { row: ItemRow; priceYen: number } {
  const row = c.db.get<ItemRow & Row>(
    'SELECT * FROM items WHERE item_id = ? AND state = ? AND shelf_place_id = ? AND quantity = 1',
    itemId,
    mode,
    placeId,
  );
  if (!row) throw new CityError('NOT_FOUND', '架上已经没有这本书了。', 'no_such_item');
  const priceYen = mode === 'shelf' ? Number(row.shelf_price_yen ?? 350) : 0;
  c.db.run(
    "UPDATE items SET owner_id = ?, state = 'held', visit_id = ?, shelf_place_id = NULL, shelf_price_yen = NULL, updated_at = ? WHERE item_id = ?",
    residentId,
    visitId,
    at,
    row.item_id,
  );
  logItem(c, { ...row, owner_id: residentId }, visitId, 1, 'acquired', { counterparty: placeId });
  const fresh = c.db.get<ItemRow & Row>('SELECT * FROM items WHERE item_id = ?', row.item_id)!;
  return { row: fresh, priceYen };
}

export function cornerBooksAt(c: CityService, mode: 'shelf' | 'drift', placeId: string, limit = 5): ItemRow[] {
  return c.db.all<ItemRow & Row>(
    'SELECT * FROM items WHERE state = ? AND shelf_place_id = ? AND quantity > 0 ORDER BY updated_at DESC, item_id LIMIT ?',
    mode,
    placeId,
    limit,
  );
}

// ───────────────────────── 投币储物柜凭条代取与超时退回 ─────────────────────────

export function createLockerDeposit(
  c: CityService,
  senderId: string,
  what: { itemId?: string; type?: string },
  qty: number,
  placeId: string,
  opts: { recipientId?: string; issueVoucher?: boolean; visitId: string | null },
  at: number,
): { deposit: LockerDepositRow; voucherCode?: string } {
  if (!Number.isInteger(qty) || qty <= 0 || qty > 99) throw cityBadRequest('qty 要是 1 到 99 的整数。', 'bad_quantity');
  if (opts.recipientId !== undefined) {
    if (!c.resident(opts.recipientId)) throw new CityError('NOT_FOUND', '找不到这位受托居民。', 'no_such_resident');
  }
  const activeCount = c.db.scalar("SELECT COUNT(*) FROM locker_deposits WHERE sender_id = ? AND status = 'active'", senderId);
  if (activeCount >= c.params.maxActiveLockerDeposits) {
    throw cityPrecondition(`你最多只能同时占用 ${c.params.maxActiveLockerDeposits} 个公共代取储物柜位。`, 'locker_deposit_limit');
  }

  const held = heldItems(c, senderId);
  let candidates: ItemRow[];
  let targetType: string;
  if (what.itemId) {
    const exact = held.find((i) => i.item_id === what.itemId);
    if (!exact) throw cityPrecondition('你身上没有这件东西。', 'not_enough_items');
    targetType = exact.type;
    if (!isStorable(targetType)) throw cityPrecondition(`${itemName(targetType)}是现点饮品，不能存进储物柜。`, 'not_storable');
    if (exact.origin_ref !== null) throw cityPrecondition('从家里带出来的随身物品不能存入公共代取储物柜。', 'carried_from_home');
    if (exact.borrowed_from !== null) throw cityPrecondition('借来的东西不能转存给别人领取。', 'item_borrowed');
    candidates = [exact];
  } else {
    const t = what.type ?? '';
    if (!t || !itemType(t)) throw cityBadRequest('要说清楚是哪件东西：item_id 或 item。', 'no_such_item');
    targetType = t;
    if (!isStorable(targetType)) throw cityPrecondition(`${itemName(targetType)}是现点饮品，不能存进储物柜。`, 'not_storable');
    const matching = held.filter((i) => i.type === targetType);
    const storableRows = matching.filter((i) => i.origin_ref === null && i.borrowed_from === null);
    if (storableRows.reduce((n, i) => n + i.quantity, 0) < qty) {
      if (matching.some((i) => i.origin_ref !== null)) {
        throw cityPrecondition('从家里带出来的随身物品不能存入公共代取储物柜。', 'carried_from_home');
      }
      if (matching.some((i) => i.borrowed_from !== null)) {
        throw cityPrecondition('借来的东西不能转存给别人领取。', 'item_borrowed');
      }
      throw cityPrecondition('你身上没有这么多可寄存的物品。', 'not_enough_items');
    }
    candidates = storableRows;
  }
  const avail = candidates.reduce((n, i) => n + i.quantity, 0);
  if (avail < qty) throw cityPrecondition('你身上没有这么多可寄存的物品。', 'not_enough_items');

  // 代取寄存每次锁定单行 item_id（instance=1 原地入柜；instance=0 拆分专用寄存行）
  const plainRows = candidates.filter((i) => i.instance === 0);
  const plainTotal = plainRows.reduce((n, i) => n + i.quantity, 0);
  let lockedItemId: string;
  if (what.itemId && candidates[0]!.instance === 1) {
    const exact = candidates[0]!;
    if (qty !== 1) throw cityBadRequest('具名实例物品一次只能寄存 1 件。', 'bad_quantity');
    lockedItemId = exact.item_id;
    c.db.run("UPDATE items SET state = 'locker', visit_id = ?, updated_at = ? WHERE item_id = ?", opts.visitId, at, lockedItemId);
    logItem(c, exact, opts.visitId, 1, 'stored', opts.recipientId ? { counterparty: opts.recipientId } : {});
  } else if (plainTotal >= qty) {
    let left = qty;
    for (const row of plainRows) {
      if (left <= 0) break;
      const take = Math.min(left, row.quantity);
      c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', take, at, row.item_id);
      left -= take;
    }
    lockedItemId = c.id('it');
    c.db.run(
      "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, shelf_place_id, shelf_price_yen, created_at, updated_at) VALUES (?,?,?,?,0,NULL,NULL,NULL,NULL,?,'locker',NULL,NULL,?,?)",
      lockedItemId,
      senderId,
      targetType,
      qty,
      opts.visitId,
      at,
      at,
    );
    logItem(c, { item_id: lockedItemId, owner_id: senderId, type: targetType, origin_ref: null }, opts.visitId, qty, 'stored', opts.recipientId ? { counterparty: opts.recipientId } : {});
  } else {
    if (qty !== 1) throw cityBadRequest('具名实例物品一次只能寄存 1 件。', 'bad_quantity');
    const inst = candidates.find((i) => i.instance === 1);
    if (!inst) throw cityPrecondition('你身上没有这么多可寄存的物品。', 'not_enough_items');
    lockedItemId = inst.item_id;
    c.db.run("UPDATE items SET state = 'locker', visit_id = ?, updated_at = ? WHERE item_id = ?", opts.visitId, at, lockedItemId);
    logItem(c, inst, opts.visitId, 1, 'stored', opts.recipientId ? { counterparty: opts.recipientId } : {});
  }

  const depositId = c.id('dep');
  const voucherCode = opts.issueVoucher ? c.id('clk') : undefined;
  const voucherHash = voucherCode ? sha256(voucherCode) : null;
  const expiresAt = at + c.params.lockerLeaseMs;
  c.db.run(
    "INSERT INTO locker_deposits(deposit_id, item_id, sender_id, recipient_id, voucher_hash, place_id, type, quantity, status, created_at, expires_at, resolved_at, claimed_by) VALUES (?,?,?,?,?,?,?,?,'active',?,?,NULL,NULL)",
    depositId,
    lockedItemId,
    senderId,
    opts.recipientId ?? null,
    voucherHash,
    placeId,
    targetType,
    qty,
    at,
    expiresAt,
  );
  c.schedule('locker_expire', `locker:${depositId}`, expiresAt, { depositId });
  const deposit = c.db.get<LockerDepositRow & Row>('SELECT * FROM locker_deposits WHERE deposit_id = ?', depositId)!;
  return { deposit, ...(voucherCode ? { voucherCode } : {}) };
}

export function claimLockerDeposit(
  c: CityService,
  claimantId: string,
  placeId: string,
  opts: { depositId?: string; voucher?: string },
  visitId: string | null,
  at: number,
): { deposit: LockerDepositRow; item_id: string; type: string; qty: number } {
  let deposit: LockerDepositRow | undefined;
  if (opts.voucher) {
    deposit = c.db.get<LockerDepositRow & Row>('SELECT * FROM locker_deposits WHERE voucher_hash = ?', sha256(opts.voucher.trim()));
    if (!deposit) throw new CityError('NOT_FOUND', '取件凭条无效或已失效。', 'invalid_voucher');
  } else if (opts.depositId) {
    deposit = c.db.get<LockerDepositRow & Row>('SELECT * FROM locker_deposits WHERE deposit_id = ?', opts.depositId);
    if (!deposit) throw new CityError('NOT_FOUND', '找不到这格代取储物柜。', 'no_such_deposit');
    if (deposit.voucher_hash !== null) {
      throw cityPrecondition('这格储物柜需要出示一次性取件凭条（voucher）才能领取。', 'voucher_required');
    }
  } else {
    throw cityBadRequest('请提供 deposit_id 或 voucher。', 'bad_locker_claim');
  }

  if (deposit.status !== 'active') {
    throw cityPrecondition('这笔储物柜寄存已领取或已超时释放。', deposit.status === 'claimed' ? 'already_claimed' : 'voucher_expired');
  }
  if (deposit.expires_at <= at) {
    throw cityPrecondition('这笔储物柜寄存已超过租期上限。', 'voucher_expired');
  }
  if (deposit.recipient_id !== null && deposit.recipient_id !== claimantId && deposit.sender_id !== claimantId) {
    throw new CityError('FORBIDDEN', '你不是这格储物柜指定的受托领取人。', 'not_recipient');
  }
  if (deposit.place_id !== placeId) {
    throw cityPrecondition(`这件物品寄存在其他车站的储物柜（${deposit.place_id}）。`, 'wrong_station', { place_id: deposit.place_id });
  }

  const claimQty = deposit.quantity;
  const item = c.db.get<ItemRow & Row>('SELECT * FROM items WHERE item_id = ?', deposit.item_id);
  if (!item || item.state !== 'locker' || item.quantity < claimQty) {
    throw cityPrecondition('储物柜里的物品状态异常。', 'not_enough_items');
  }

  c.cancelJob(`locker:${deposit.deposit_id}`);
  c.db.run(
    "UPDATE locker_deposits SET status = 'claimed', resolved_at = ?, claimed_by = ?, voucher_hash = NULL WHERE deposit_id = ?",
    at,
    claimantId,
    deposit.deposit_id,
  );

  let outItemId: string;
  if (item.instance === 1) {
    outItemId = item.item_id;
    c.db.run("UPDATE items SET owner_id = ?, state = 'held', visit_id = ?, updated_at = ? WHERE item_id = ?", claimantId, visitId, at, outItemId);
    logItem(c, { ...item, owner_id: claimantId }, visitId, 1, 'retrieved', { counterparty: deposit.sender_id });
  } else {
    c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', claimQty, at, item.item_id);
    const existingHeld = c.db.get<ItemRow & Row>(
      "SELECT * FROM items WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND instance = 0 AND state = 'held'",
      claimantId,
      item.type,
    );
    if (existingHeld) {
      outItemId = existingHeld.item_id;
      c.db.run('UPDATE items SET quantity = quantity + ?, visit_id = ?, updated_at = ? WHERE item_id = ?', claimQty, visitId, at, outItemId);
    } else {
      outItemId = c.id('it');
      c.db.run(
        "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,0,NULL,NULL,NULL,NULL,?,'held',?,?)",
        outItemId,
        claimantId,
        item.type,
        claimQty,
        visitId,
        at,
        at,
      );
    }
    logItem(c, { item_id: outItemId, owner_id: claimantId, type: item.type, origin_ref: null }, visitId, claimQty, 'retrieved', { counterparty: deposit.sender_id });
  }

  c.emitTo([deposit.sender_id], 'locker_claimed', { deposit_id: deposit.deposit_id, item_id: outItemId, type: item.type, qty: claimQty, claimed_by: claimantId }, at);
  const fresh = c.db.get<LockerDepositRow & Row>('SELECT * FROM locker_deposits WHERE deposit_id = ?', deposit.deposit_id)!;
  return { deposit: fresh, item_id: outItemId, type: item.type, qty: claimQty };
}

/** 租期到期（默认 72h）自动退回原主个人储物柜；若原主柜满则转招领态（lost_found）释放公共柜位。 */
export function expireLockerDeposit(c: CityService, depositId: string, at: number): 'returned' | 'lost_found' | 'noop' {
  const deposit = c.db.get<LockerDepositRow & Row>('SELECT * FROM locker_deposits WHERE deposit_id = ?', depositId);
  if (!deposit || deposit.status !== 'active') return 'noop';
  const item = c.db.get<ItemRow & Row>('SELECT * FROM items WHERE item_id = ?', deposit.item_id);
  if (!item || item.state !== 'locker' || item.quantity <= 0) {
    c.db.run("UPDATE locker_deposits SET status = 'expired_lost_found', resolved_at = ?, voucher_hash = NULL WHERE deposit_id = ?", at, depositId);
    return 'lost_found';
  }

  const returnQty = Math.min(item.quantity, deposit.quantity);
  const personal = lockerItems(c, deposit.sender_id);
  const personalQty = personal.reduce((n, i) => n + i.quantity, 0);
  const hasPlainStack = item.instance === 0 && personal.some((i) => i.type === item.type && i.instance === 0 && i.origin_ref === null);
  const addedEntry = hasPlainStack ? 0 : 1;
  const fits = personal.length + addedEntry <= c.params.maxLockerEntries && personalQty + returnQty <= c.params.maxLockerQty;

  if (fits) {
    c.db.run("UPDATE locker_deposits SET status = 'expired_returned', resolved_at = ?, voucher_hash = NULL WHERE deposit_id = ?", at, depositId);
    let returnedItemId = item.item_id;
    if (item.instance === 0) {
      c.db.run('UPDATE items SET quantity = quantity - ?, updated_at = ? WHERE item_id = ?', returnQty, at, item.item_id);
      const existing = personal.find((i) => i.type === item.type && i.instance === 0 && i.origin_ref === null);
      if (existing) {
        returnedItemId = existing.item_id;
        c.db.run('UPDATE items SET quantity = quantity + ?, updated_at = ? WHERE item_id = ?', returnQty, at, existing.item_id);
      } else {
        returnedItemId = c.id('it');
        c.db.run(
          "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?,?,?,?,0,NULL,NULL,NULL,NULL,?,'locker',?,?)",
          returnedItemId,
          deposit.sender_id,
          item.type,
          returnQty,
          item.visit_id,
          at,
          at,
        );
      }
    } else {
      c.db.run('UPDATE items SET updated_at = ? WHERE item_id = ?', at, item.item_id);
    }
    c.emitTo([deposit.sender_id], 'locker_expired', { deposit_id: depositId, item_id: returnedItemId, type: item.type, qty: returnQty, outcome: 'returned' }, at);
    if (deposit.recipient_id) {
      c.emitTo([deposit.recipient_id], 'locker_expired', { deposit_id: depositId, type: item.type, qty: returnQty, outcome: 'returned' }, at);
    }
    return 'returned';
  }

  c.db.run("UPDATE items SET state = 'lost_found', updated_at = ? WHERE item_id = ?", at, item.item_id);
  c.db.run("UPDATE locker_deposits SET status = 'expired_lost_found', resolved_at = ?, voucher_hash = NULL WHERE deposit_id = ?", at, depositId);
  c.emitTo([deposit.sender_id], 'locker_expired', { deposit_id: depositId, item_id: item.item_id, type: item.type, outcome: 'lost_found' }, at);
  if (deposit.recipient_id) {
    c.emitTo([deposit.recipient_id], 'locker_expired', { deposit_id: depositId, type: item.type, outcome: 'lost_found' }, at);
  }
  return 'lost_found';
}

export function activeLockerDepositsForRecipient(c: CityService, recipientId: string, limit = 5): LockerDepositRow[] {
  return c.db.all<LockerDepositRow & Row>(
    "SELECT * FROM locker_deposits WHERE recipient_id = ? AND status = 'active' ORDER BY expires_at ASC, deposit_id LIMIT ?",
    recipientId,
    limit,
  );
}

export function activeLockerDepositsBySender(c: CityService, senderId: string, limit = 5): LockerDepositRow[] {
  return c.db.all<LockerDepositRow & Row>(
    "SELECT * FROM locker_deposits WHERE sender_id = ? AND status = 'active' ORDER BY expires_at ASC, deposit_id LIMIT ?",
    senderId,
    limit,
  );
}
