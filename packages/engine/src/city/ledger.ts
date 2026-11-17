/**
 * 城市世界的钱和物品。
 *
 * 钱（虚拟日元，整数）只通过 ledger() 变动：每笔交易的分录合计为零、原因键（cause_key）永久唯一，
 * 同一个原因键第二次调用什么都不做（返回 false）。居民账户不能为负、不能动用被锁住的钱；系统账户可以为负。
 * 物品只通过这里的函数变动；带出门的物品每件资源一行（带着 origin_ref），不和城里得到的同类物品合并。
 */
import type { Row } from '../world/db.js';
import { cityPrecondition } from './errors.js';
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
       WHERE t.visit_id = ? AND e.account_id = ? AND t.kind NOT IN ('visit_in','visit_out') GROUP BY t.label ORDER BY MIN(e.entry_id)`,
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
  origin_ref: string | null;
  origin_json: string | null;
  visit_id: string | null;
  state: 'held' | 'returned' | 'locker';
  created_at: number;
}

/** 身上可用的物品（数量为零的不算）。带出门的排在前面。 */
export function heldItems(c: CityService, residentId: string): ItemRow[] {
  return c.db.all<ItemRow & Row>("SELECT * FROM items WHERE owner_id = ? AND state = 'held' AND quantity > 0 ORDER BY (origin_ref IS NULL), created_at, item_id", residentId);
}

export type ItemFate = 'acquired' | 'received' | 'consumed' | 'given' | 'sold';

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

/** 城里得到的物品（买的、别人送的）：并进身上那一堆。返回物品行编号。 */
export function addPlain(c: CityService, residentId: string, type: string, qty: number, visitId: string | null, fate: 'acquired' | 'received', counterparty?: string): string {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('物品数量必须是正整数');
  const existing = c.db.get<ItemRow & Row>("SELECT * FROM items WHERE owner_id = ? AND type = ? AND origin_ref IS NULL AND state = 'held'", residentId, type);
  let itemId: string;
  if (existing) {
    itemId = existing.item_id;
    c.db.run('UPDATE items SET quantity = quantity + ?, visit_id = ? WHERE item_id = ?', qty, visitId, itemId);
  } else {
    itemId = c.id('it');
    c.db.run("INSERT INTO items(item_id, owner_id, type, quantity, origin_ref, origin_json, visit_id, state, created_at) VALUES (?,?,?,?,NULL,NULL,?,'held',?)", itemId, residentId, type, qty, visitId, c.now());
  }
  logItem(c, { item_id: itemId, owner_id: residentId, type, origin_ref: null }, visitId, qty, fate, counterparty ? { counterparty } : {});
  return itemId;
}

/** 从小屋带出来的物品：每件资源一行，记着它在内核里的来历。 */
export function addCarried(c: CityService, residentId: string, type: string, qty: number, originRef: string, origin: Record<string, unknown>, visitId: string): string {
  const itemId = c.id('it');
  c.db.run("INSERT INTO items(item_id, owner_id, type, quantity, origin_ref, origin_json, visit_id, state, created_at) VALUES (?,?,?,?,?,?,?,'held',?)", itemId, residentId, type, qty, originRef, JSON.stringify(origin), visitId, c.now());
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
  let left = qty;
  const taken: { itemId: string; originRef: string | null; qty: number }[] = [];
  for (const row of rows) {
    if (left <= 0) break;
    const n = Math.min(left, row.quantity);
    c.db.run('UPDATE items SET quantity = quantity - ? WHERE item_id = ?', n, row.item_id);
    logItem(c, row, visitId, n, fate, extra);
    taken.push({ itemId: row.item_id, originRef: row.origin_ref, qty: n });
    left -= n;
  }
  return { type: rows[0]!.type, taken };
}

/** 全部账户余额之和（复式记账下恒为零）。对账用。 */
export function ledgerImbalance(c: CityService): number {
  return c.db.scalar('SELECT COALESCE(SUM(balance), 0) FROM accounts');
}
