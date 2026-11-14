/**
 * 财物：物品、硬币账本、预留、商店、赠送/交换/出借、归还。
 *
 * - 硬币只通过复式账本变动：每笔转移有唯一的原因键，同一原因不会入账两次；系统发放和回收走 sys:mint / sys:sink。
 * - 物品区分所有者和持有者：借出的书所有者不变，只换持有者。可堆叠物品每人每种一行数量。
 * - 发起赠送、交换、出借时先预留发起方的东西；对方接受时在同一事务里完成双向转移。任何一步不满足，整笔不发生。
 * - 报价内容不可修改（要改就撤销重发），所以「接受的是哪一份」没有歧义。
 */
import { BOOKS, RESIDENTIAL_PLACE, SHOPS, STARTER_KIT, bookDef, homeId, itemDef, npcDef, objectTypeName, type ItemDef, type ShopDef } from './content.js';
import { type Row, parseJson } from './db.js';
import { badRequest, notAvailable, precondition } from './errors.js';
import { applyNeeds, takeToken } from './life.js';
import { card } from './project.js';
import { actorOf } from './space.js';
import { keeperSoldLine, onDuty } from './npc-talk.js';
import { npcReach, personReach, requirePersonReach } from './reach.js';
import type { WorldService } from './service.js';
import type { ResidentRow } from './types.js';

/** 镇上公共财物（书屋藏书）的所有者。 */
export const TOWN = 'town';
export const MINT = 'sys:mint';
export const SINK = 'sys:sink';
export const accountOf = (residentId: string): string => `acct:${residentId}`;

// ───────────────────────── 账本 ─────────────────────────

export function wallet(w: WorldService, residentId: string): { balance: number; reserved: number; available: number } {
  const a = w.db.get('SELECT balance, reserved FROM accounts WHERE account_id = ?', accountOf(residentId));
  const balance = Number(a?.balance ?? 0);
  const reserved = Number(a?.reserved ?? 0);
  return { balance, reserved, available: balance - reserved };
}

/**
 * 记一笔账。entries 的合计必须为零。同一个 causeKey 只会入账一次：重复调用返回 false，什么都不改。
 */
export function ledger(w: WorldService, causeKey: string, kind: string, entries: readonly (readonly [account: string, delta: number])[]): boolean {
  if (w.db.get('SELECT 1 AS x FROM ledger_transactions WHERE cause_key = ?', causeKey)) return false;
  const moves = entries.filter(([, d]) => d !== 0);
  if (moves.length === 0) return false;
  if (moves.some(([, d]) => !Number.isSafeInteger(d)) || moves.reduce((s, [, d]) => s + d, 0) !== 0) throw new Error(`账目不平：${causeKey}`);
  for (const [account, delta] of moves) {
    if (delta >= 0 || account.startsWith('sys:')) continue;
    const a = w.db.get('SELECT balance, reserved FROM accounts WHERE account_id = ?', account);
    if (!a || a.balance - a.reserved + delta < 0) throw precondition('硬币不够。', 'insufficient_coins');
  }
  const { lastInsertRowid } = w.db.run('INSERT INTO ledger_transactions(world_id, cause_key, kind, created_at) VALUES (?,?,?,?)', w.worldId, causeKey, kind, w.now());
  for (const [account, delta] of moves) {
    w.db.run('INSERT INTO ledger_entries(transaction_id, account_id, delta) VALUES (?,?,?)', lastInsertRowid, account, delta);
    w.db.run('UPDATE accounts SET balance = balance + ?, revision = revision + 1 WHERE account_id = ?', delta, account);
  }
  return true;
}

/** 系统发放硬币（奖励、新居民物资）。 */
export function mint(w: WorldService, residentId: string, amount: number, causeKey: string, kind: string): boolean {
  if (amount <= 0) return false;
  return ledger(w, causeKey, kind, [
    [MINT, -amount],
    [accountOf(residentId), amount],
  ]);
}

// ───────────────────────── 物品 ─────────────────────────

export function mustItemDef(type: string): ItemDef {
  const def = itemDef(type);
  if (!def) throw badRequest(`没有这种物品：${String(type).slice(0, 30)}`);
  return def;
}

export function itemLabel(row: Row): string {
  const meta = parseJson<{ title?: string }>(row.metadata_json ?? '{}', {});
  return meta.title ?? itemDef(row.type)?.name ?? row.type;
}

function stackRow(w: WorldService, ownerId: string, type: string): Row | undefined {
  return w.db.get('SELECT * FROM items WHERE owner_id = ? AND type = ? AND stack = 1', ownerId, type);
}

/** 某人此刻能动用的数量（扣掉已预留和摆出来展示的）。不可堆叠的物品按件数算。 */
export function availableQty(w: WorldService, residentId: string, type: string): number {
  const def = itemDef(type);
  if (!def) return 0;
  if (def.stackable) {
    const s = stackRow(w, residentId, type);
    return s ? s.quantity - s.reserved - s.shelved : 0;
  }
  return w.db.scalar('SELECT COUNT(*) FROM items WHERE owner_id = ? AND holder_id = ? AND type = ? AND stack = 0 AND reserved = 0 AND shelved = 0', residentId, residentId, type);
}

export function addStack(w: WorldService, residentId: string, type: string, qty: number): void {
  if (qty <= 0) return;
  const s = stackRow(w, residentId, type);
  if (s) w.db.run('UPDATE items SET quantity = quantity + ? WHERE item_id = ?', qty, s.item_id);
  else w.db.run('INSERT INTO items(item_id, world_id, owner_id, holder_id, type, stack, quantity, created_at) VALUES (?,?,?,?,?,1,?,?)', w.id('i'), w.worldId, residentId, residentId, type, qty, w.now());
}

export function takeStack(w: WorldService, residentId: string, type: string, qty: number): void {
  if (qty <= 0) return;
  const s = stackRow(w, residentId, type);
  if (!s || s.quantity - s.reserved - s.shelved < qty) throw precondition(`${itemDef(type)?.name ?? type}不够。`, 'insufficient_items');
  if (s.quantity === qty) w.db.run('DELETE FROM items WHERE item_id = ?', s.item_id);
  else w.db.run('UPDATE items SET quantity = quantity - ? WHERE item_id = ?', qty, s.item_id);
}

export function createUnique(w: WorldService, ownerId: string, type: string, metadata: Record<string, unknown> = {}): string {
  const id = w.id('i');
  w.db.run(
    'INSERT INTO items(item_id, world_id, owner_id, holder_id, type, stack, quantity, metadata_json, created_at) VALUES (?,?,?,?,?,0,1,?,?)',
    id,
    w.worldId,
    ownerId,
    ownerId,
    type,
    JSON.stringify(metadata),
    w.now(),
  );
  return id;
}

/** 发一件（或几件）物品给居民，并记一条「获得」事实。 */
export function grantItem(w: WorldService, residentId: string, type: string, qty: number, via: string, metadata?: Record<string, unknown>, fact = true): void {
  const def = mustItemDef(type);
  if (def.stackable) addStack(w, residentId, type, qty);
  else for (let i = 0; i < qty; i++) createUnique(w, residentId, type, metadata ?? {});
  if (fact) w.fact('item_acquired', [{ id: residentId, role: 'self' }], { itemType: type, qty, via });
}

// ───────────────────────── 预留 ─────────────────────────

/** 预留一份资源（硬币、堆叠物品的数量或一件独立物品）。预留期间不能花、不能送、不能再预留。 */
export function reserve(w: WorldService, holderKind: string, holderRef: string, residentId: string, what: { coins?: number; type?: string; qty?: number; itemId?: string }): void {
  if (what.coins && what.coins > 0) {
    if (wallet(w, residentId).available < what.coins) throw precondition('硬币不够。', 'insufficient_coins');
    w.db.run('UPDATE accounts SET reserved = reserved + ? WHERE account_id = ?', what.coins, accountOf(residentId));
    w.db.run('INSERT INTO resource_reservations(holder_kind, holder_ref, resident_id, coins) VALUES (?,?,?,?)', holderKind, holderRef, residentId, what.coins);
  }
  if (what.itemId) {
    const it = w.db.get('SELECT * FROM items WHERE item_id = ?', what.itemId);
    if (!it || it.stack !== 0 || it.owner_id !== residentId || it.holder_id !== residentId) throw precondition('这件东西现在不在你手里，或者不是你的。', 'not_yours');
    if (it.reserved > 0 || it.shelved > 0) throw precondition(`${itemLabel(it)}正摆着或者已经答应给别人了。`, 'item_busy');
    w.db.run('UPDATE items SET reserved = 1 WHERE item_id = ?', it.item_id);
    w.db.run('INSERT INTO resource_reservations(holder_kind, holder_ref, resident_id, item_id, quantity) VALUES (?,?,?,?,1)', holderKind, holderRef, residentId, it.item_id);
  } else if (what.type && what.qty && what.qty > 0) {
    const s = stackRow(w, residentId, what.type);
    if (!s || s.quantity - s.reserved - s.shelved < what.qty) throw precondition(`${itemDef(what.type)?.name ?? what.type}不够。`, 'insufficient_items');
    w.db.run('UPDATE items SET reserved = reserved + ? WHERE item_id = ?', what.qty, s.item_id);
    w.db.run('INSERT INTO resource_reservations(holder_kind, holder_ref, resident_id, item_id, quantity) VALUES (?,?,?,?,?)', holderKind, holderRef, residentId, s.item_id, what.qty);
  }
}

/** 释放某个持有者名下的全部预留（东西回到可用状态）。之后要转移或消耗的，由调用方接着做。 */
export function release(w: WorldService, holderKind: string, holderRef: string): void {
  for (const row of w.db.all('SELECT * FROM resource_reservations WHERE holder_kind = ? AND holder_ref = ?', holderKind, holderRef)) {
    if (row.coins > 0) w.db.run('UPDATE accounts SET reserved = MAX(0, reserved - ?) WHERE account_id = ?', row.coins, accountOf(row.resident_id));
    if (row.item_id) w.db.run('UPDATE items SET reserved = MAX(0, reserved - ?) WHERE item_id = ?', row.quantity, row.item_id);
  }
  w.db.run('DELETE FROM resource_reservations WHERE holder_kind = ? AND holder_ref = ?', holderKind, holderRef);
}

// ───────────────────────── 一揽子资源（报价的一边） ─────────────────────────

export interface Bundle {
  coins: number;
  items: { type: string; qty: number; itemId?: string; label?: string }[];
}

function parseBundle(w: WorldService, raw: unknown, side: 'give' | 'want', ownerId: string): Bundle {
  const out: Bundle = { coins: 0, items: [] };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object') throw badRequest(`${side} 应该是 {coins, items}。`);
  const o = raw as { coins?: unknown; items?: unknown };
  if (o.coins !== undefined) {
    const c = Number(o.coins);
    if (!Number.isInteger(c) || c < 0 || c > 10_000) throw badRequest('硬币数量无效。');
    out.coins = c;
  }
  if (o.items !== undefined) {
    if (!Array.isArray(o.items) || o.items.length > 5) throw badRequest('物品最多写 5 项。');
    for (const it of o.items as Record<string, unknown>[]) {
      if (it && typeof it.itemId === 'string') {
        if (side === 'want') throw badRequest('想要的东西按种类写（type、qty），不能指定对方的某一件。');
        const row = w.db.get('SELECT * FROM items WHERE item_id = ? AND owner_id = ?', it.itemId, ownerId);
        if (!row || row.stack !== 0) throw precondition('这件东西不是你的。', 'not_yours');
        if (out.items.some((x) => x.itemId === row.item_id)) throw badRequest('同一件东西写了两次。');
        out.items.push({ type: row.type, qty: 1, itemId: row.item_id, label: itemLabel(row) });
        continue;
      }
      const def = mustItemDef(String(it?.type ?? ''));
      const qty = Number(it?.qty ?? 1);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw badRequest('数量无效。');
      if (side === 'give' && !def.stackable) throw badRequest(`${def.name}要用 itemId 指定是哪一件。`);
      const same = out.items.find((x) => x.type === def.type && !x.itemId);
      if (same) same.qty += qty;
      else out.items.push({ type: def.type, qty });
    }
  }
  return out;
}

export function describeBundle(b: Bundle): string {
  const parts = b.items.map((i) => (i.itemId ? (i.label ?? itemDef(i.type)?.name ?? i.type) : `${i.qty} 份${itemDef(i.type)?.name ?? i.type}`));
  if (b.coins > 0) parts.push(`${b.coins} 枚硬币`);
  return parts.join('、') || '（没有）';
}

const bundleEmpty = (b: Bundle) => b.coins === 0 && b.items.length === 0;

/** 把一边的东西从 from 转给 to（预留已经释放）。想要的一边里不可堆叠的种类，自动挑对方最早得到的那几件。 */
function moveBundle(w: WorldService, b: Bundle, from: string, to: string, causeKey: string, kind: string): void {
  if (b.coins > 0) {
    ledger(w, causeKey, kind, [
      [accountOf(from), -b.coins],
      [accountOf(to), b.coins],
    ]);
  }
  for (const it of b.items) {
    const def = mustItemDef(it.type);
    if (def.stackable) {
      takeStack(w, from, it.type, it.qty);
      addStack(w, to, it.type, it.qty);
      continue;
    }
    const ids = it.itemId
      ? [it.itemId]
      : w.db
          .all('SELECT item_id FROM items WHERE owner_id = ? AND holder_id = ? AND type = ? AND stack = 0 AND reserved = 0 AND shelved = 0 ORDER BY created_at, item_id LIMIT ?', from, from, it.type, it.qty)
          .map((x) => String(x.item_id));
    if (ids.length < it.qty) throw precondition(`${def.name}不够。`, 'insufficient_items');
    for (const id of ids) {
      const changed = w.db.run('UPDATE items SET owner_id = ?, holder_id = ? WHERE item_id = ? AND owner_id = ? AND holder_id = ? AND reserved = 0', to, to, id, from, from).changes;
      if (changed !== 1) throw precondition(`${def.name}现在不能转手。`, 'item_busy');
    }
  }
}

// ───────────────────────── 报价 ─────────────────────────

export interface OfferView {
  id: string;
  kind: 'gift' | 'trade' | 'loan';
  from: ReturnType<typeof card>;
  to: ReturnType<typeof card>;
  give: Bundle;
  want: Bundle;
  text: string;
  status: string;
  expiresAt: number;
  reason?: string;
}

export function offerView(w: WorldService, row: Row): OfferView {
  const give = parseJson<Bundle>(row.give_json, { coins: 0, items: [] });
  const want = parseJson<Bundle>(row.want_json, { coins: 0, items: [] });
  const from = w.mustResident(row.from_id);
  const to = w.mustResident(row.to_id);
  const text =
    row.kind === 'gift'
      ? `${from.name}想送给${to.name}：${describeBundle(give)}`
      : row.kind === 'loan'
        ? `${from.name}想把${describeBundle(give)}借给${to.name}`
        : `${from.name}想用 ${describeBundle(give)} 换${to.name}的 ${describeBundle(want)}`;
  return { id: row.offer_id, kind: row.kind, from: card(from), to: card(to), give, want, text, status: row.status, expiresAt: row.expires_at, ...(row.close_reason ? { reason: row.close_reason } : {}) };
}

/** 一位居民名下还开着的报价（自己发的和收到的）。 */
export function openOffers(w: WorldService, residentId: string): OfferView[] {
  return w.db.all("SELECT * FROM offers WHERE status = 'open' AND (from_id = ? OR to_id = ?) ORDER BY created_at", residentId, residentId).map((row) => offerView(w, row));
}

function closeOffer(w: WorldService, row: Row, status: 'declined' | 'cancelled' | 'expired', reason: string, at: number): void {
  const changed = w.db.run("UPDATE offers SET status = ?, closed_at = ?, close_reason = ? WHERE offer_id = ? AND status = 'open'", status, at, reason, row.offer_id).changes;
  if (changed !== 1) return;
  release(w, 'offer', row.offer_id);
  w.cancelJob(`offer:${row.offer_id}`);
  w.emitTo([row.from_id, row.to_id], 'offer', { offer: offerView(w, { ...row, status, close_reason: reason }) }, at);
}

/** 撤销一位居民名下所有没完成的报价（离开现场、离线、进入小游戏时）。预留全数退回。 */
export function cancelOffersOf(w: WorldService, residentId: string, reason: string, at: number): void {
  for (const row of w.db.all("SELECT * FROM offers WHERE status = 'open' AND (from_id = ? OR to_id = ?)", residentId, residentId)) closeOffer(w, row, 'cancelled', reason, at);
}

// ───────────────────────── 商店 ─────────────────────────

function eventOpen(w: WorldService, defId: string): boolean {
  return Boolean(w.db.get("SELECT 1 AS x FROM public_event_instances WHERE def_id = ? AND status = 'open'", defId));
}

function stockOf(w: WorldService, shop: ShopDef, sku: string, dailyStock: number, today: string): number {
  const row = w.db.get('SELECT stock, stock_date FROM shop_stock WHERE shop_id = ? AND sku = ?', shop.id, sku);
  // 惰性补货：到了新的世界日第一次有人看或买时补满
  return row && row.stock_date === today ? Number(row.stock) : dailyStock;
}

export function shopsAt(w: WorldService, placeId: string, now: number): { id: string; name: string; goods: { sku: string; name: string; price: number; stock: number; note?: string }[] }[] {
  const today = w.today(now);
  return SHOPS.filter((s) => s.place === placeId).map((s) => ({
    id: s.id,
    name: s.name,
    goods: s.goods
      .filter((g) => !g.onlyDuringEvent || eventOpen(w, g.onlyDuringEvent))
      .map((g) => ({
        sku: g.sku,
        name: g.bookId ? (bookDef(g.bookId)?.title ?? '书') : (itemDef(g.type)?.name ?? g.type),
        price: g.price,
        stock: stockOf(w, s, g.sku, g.dailyStock, today),
        ...(g.onlyDuringEvent ? { note: '活动期间限定' } : {}),
      })),
  }));
}

// ───────────────────────── 背包视图 ─────────────────────────

export interface InventoryView {
  coins: { balance: number; reserved: number; available: number };
  items: { itemId: string; type: string; name: string; qty: number; stackable: boolean; available: number; shelved: number; category: string; use: string; borrowedFrom?: string; dueAt?: number }[];
  lent: { itemId: string; name: string; to: string; dueAt: number }[];
}

export function inventoryOf(w: WorldService, residentId: string): InventoryView {
  const items = w.db.all('SELECT * FROM items WHERE holder_id = ? ORDER BY type, created_at, item_id', residentId).map((it) => {
    const def = itemDef(it.type);
    const loan = it.owner_id !== residentId ? w.db.get("SELECT due_at FROM loans WHERE item_id = ? AND status = 'active'", it.item_id) : undefined;
    return {
      itemId: String(it.item_id),
      type: String(it.type),
      name: itemLabel(it),
      qty: Number(it.quantity),
      stackable: def?.stackable ?? it.stack === 1,
      available: it.owner_id === residentId ? Number(it.quantity - it.reserved - it.shelved) : 0,
      shelved: Number(it.shelved),
      category: def?.category ?? 'usable',
      use: def?.use ?? '',
      ...(it.owner_id !== residentId ? { borrowedFrom: it.owner_id === TOWN ? '檐下书屋' : (w.resident(it.owner_id)?.name ?? '别人'), dueAt: Number(loan?.due_at ?? 0) } : {}),
    };
  });
  const lent = w.db
    .all("SELECT i.*, l.borrower_id, l.due_at FROM items i JOIN loans l ON l.item_id = i.item_id AND l.status = 'active' WHERE i.owner_id = ? AND i.holder_id <> ?", residentId, residentId)
    .map((it) => ({ itemId: String(it.item_id), name: itemLabel(it), to: w.resident(it.borrower_id)?.name ?? '别人', dueAt: Number(it.due_at) }));
  return { coins: wallet(w, residentId), items, lent };
}

// ───────────────────────── 安装 ─────────────────────────

export function installProperty(w: WorldService): void {
  // 书屋藏书：每种两本，只生成一次
  w.commit(() => {
    const key = `seed:library:${w.worldId}`;
    if (w.db.get('SELECT 1 AS x FROM business_keys WHERE key = ?', key)) return;
    w.db.run('INSERT INTO business_keys(key, created_at) VALUES (?,?)', key, w.now());
    for (const b of BOOKS) {
      for (let i = 0; i < 2; i++) createUnique(w, TOWN, 'book', { bookId: b.id, title: b.title, library: true });
    }
  });

  // 新居民物资：账户、硬币、几样小东西、随机一本书。居民注册受唯一约束保护，物资随注册事务一次发完
  w.hooks.registered.push((r) => {
    w.db.run("INSERT INTO accounts(account_id, world_id, resident_id, kind, balance) VALUES (?,?,?,'resident',0)", accountOf(r.resident_id), w.worldId, r.resident_id);
    mint(w, r.resident_id, w.params.initialCoins, `starter:${r.resident_id}`, 'starter');
    for (const k of STARTER_KIT) addStack(w, r.resident_id, k.type, k.qty);
    const book = BOOKS[w.rng.int(BOOKS.length)]!;
    createUnique(w, r.resident_id, 'book', { bookId: book.id, title: book.title });
  });

  // 报价只按「同一个场景实例 + 距离」成立：跨区域边界不撤销。撤销的时机：任一方进出私宅（换了场景实例）、
  // 离线或失去在场资格、进入小游戏
  w.hooks.arrive.push((r, _space, at) => {
    for (const row of w.db.all("SELECT * FROM offers WHERE status = 'open' AND (from_id = ? OR to_id = ?)", r.resident_id, r.resident_id)) {
      const fa = actorOf(w, String(row.from_id));
      const ta = actorOf(w, String(row.to_id));
      if (!fa || !ta || fa.scene_id !== ta.scene_id || fa.instance_id !== ta.instance_id) closeOffer(w, row, 'cancelled', '有一方离开了', at);
    }
  });
  w.hooks.leaveSpace.push((r, _space, at) => {
    // 开局时 games.ts 对每个入局的人调用它（此时这一局已是 running）：进入对局撤销报价
    if (w.db.get("SELECT 1 AS x FROM activity_participants p JOIN activities a ON a.activity_id = p.activity_id WHERE p.resident_id = ? AND p.active = 1 AND a.status = 'running'", r.resident_id)) {
      cancelOffersOf(w, r.resident_id, '有一方进了小游戏', at);
    }
  });
  w.hooks.offline.push((r, at) => cancelOffersOf(w, r.resident_id, '有一方离线了', at));

  // ── 买东西 ──
  w.handlers.set('buy', ({ r, action, now }) => {
    const shop = SHOPS.find((s) => s.id === action.shop);
    if (!shop) throw badRequest('没有这家店。');
    const keeper = shop.keeper ? npcDef(shop.keeper) : undefined;
    if (shop.keeper) {
      // 有掌柜的店：买东西要走到掌柜身边（够得着掌柜，现算位置），不再只看人在不在这片区域。NPC 不持有账户和物品，钱货仍走下面的老路径
      if (!keeper || !onDuty(w, keeper, now)) throw precondition(`${shop.name}现在没人照看，晚些再来。`, 'closed');
      const reach = npcReach(w, r, keeper.id, now);
      if (!reach.ok) {
        if (reach.why === 'too_far') throw precondition(`离${keeper.name}太远了，先走到${keeper.name}身边。`, 'too_far', { navigateTo: keeper.id });
        throw precondition(`要到${shop.name}所在的地方才能买。`, 'not_here');
      }
    } else if (w.spaceOf(r) !== shop.place) throw precondition(`要到${shop.name}所在的地方才能买。`, 'not_here');
    const good = shop.goods.find((g) => g.sku === action.sku);
    if (!good) throw badRequest('这家店不卖这个。');
    if (good.onlyDuringEvent && !eventOpen(w, good.onlyDuringEvent)) throw precondition('这件只在活动期间出售。', 'not_on_sale');
    const qty = Number(action.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw badRequest('一次买 1~10 件。');
    const today = w.today(now);
    const stock = stockOf(w, shop, good.sku, good.dailyStock, today);
    if (stock < qty) throw precondition(stock === 0 ? '今天卖完了，明天再来。' : `今天只剩 ${stock} 件。`, 'sold_out');
    w.db.run(
      `INSERT INTO shop_stock(shop_id, sku, stock, stock_date) VALUES (?,?,?,?)
       ON CONFLICT(shop_id, sku) DO UPDATE SET stock = excluded.stock, stock_date = excluded.stock_date`,
      shop.id,
      good.sku,
      stock - qty,
      today,
    );
    const cost = good.price * qty;
    // 原因键每次购买唯一：requestId 由客户端提供，回执 7 天后被清理而账本永久保留，
    // 用 requestId 当键会让过期后复用同一请求号的购买「不扣钱却发货」。重试幂等由请求回执保证。
    const paid = ledger(w, `buy:${r.resident_id}:${w.id('p')}`, 'purchase', [
      [accountOf(r.resident_id), -cost],
      [SINK, cost],
    ]);
    if (!paid) throw new Error(`购买记账失败：${r.resident_id}`); // 抛错使整笔事务回滚，库存不减、物品不发
    const book = good.bookId ? bookDef(good.bookId) : undefined;
    grantItem(w, r.resident_id, good.type, qty, 'shop', book ? { bookId: book.id, title: book.title } : undefined);
    const name = book?.title ?? itemDef(good.type)?.name ?? good.type;
    // 掌柜说一句固定的成交台词（受最小间隔限制；说不说都不影响成交，和成交在同一个事务里）
    if (keeper) keeperSoldLine(w, keeper, now);
    return { status: 'completed', bought: { name, qty, cost }, coins: wallet(w, r.resident_id).balance, text: `买了 ${qty} 件${name}，花了 ${cost} 枚硬币。` };
  });

  // ── 用掉一件消耗品 ──
  // 物品种类的字段叫 itemType：action.type 已经是动作类型本身（type: 'use_item'），不能再拿来放物品种类
  const itemTypeOf = (action: Record<string, unknown>): string => String(action.itemType ?? action.item ?? '');
  w.handlers.set('use_item', ({ r, action, now }) => {
    const def = mustItemDef(itemTypeOf(action));
    if (!def.consume) throw precondition(`${def.name}不是拿来直接用的。${def.use}`, 'not_usable');
    takeStack(w, r.resident_id, def.type, 1);
    const needs = applyNeeds(w, r, { energy: def.consume.energy ?? 0 }, now);
    return { status: 'completed', text: `用掉了 1 份${def.name}，精力 +${def.consume.energy ?? 0}。`, energy: needs.energy };
  });

  // ── 把装饰摆出来 / 收起来（只在自己家） ──
  w.handlers.set('display_item', ({ r, action }) => {
    if (w.spaceOf(r) !== homeId(r.resident_id)) throw precondition('回到自己家才能布置。', 'not_home');
    const on = action.on !== false;
    if (typeof action.itemId === 'string') {
      const it = w.db.get('SELECT * FROM items WHERE item_id = ? AND owner_id = ? AND holder_id = ? AND stack = 0', action.itemId, r.resident_id, r.resident_id);
      if (!it) throw precondition('这件东西现在不在你手里。', 'not_yours');
      if (it.reserved > 0) throw precondition('这件东西已经答应给别人了。', 'item_busy');
      w.db.run('UPDATE items SET shelved = ? WHERE item_id = ?', on ? 1 : 0, it.item_id);
      return { status: 'completed', text: `${on ? '摆出了' : '收起了'}${itemLabel(it)}。` };
    }
    const def = mustItemDef(itemTypeOf(action));
    if (def.category !== 'decor') throw precondition(`${def.name}不是摆设。`, 'not_decor');
    const qty = Number(action.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw badRequest('数量无效。');
    const s = stackRow(w, r.resident_id, def.type);
    if (!s) throw precondition(`你没有${def.name}。`, 'insufficient_items');
    const next = on ? s.shelved + qty : s.shelved - qty;
    if (next < 0 || next > s.quantity - s.reserved) throw precondition(on ? `能摆的${def.name}不够。` : `没有摆出那么多${def.name}。`, 'insufficient_items');
    w.db.run('UPDATE items SET shelved = ? WHERE item_id = ?', next, s.item_id);
    return { status: 'completed', text: `${on ? '摆出了' : '收起了'} ${qty} 份${def.name}。` };
  });

  // ── 摆放家具：变成自己家里可以互动的物件 ──
  w.handlers.set('place_furniture', ({ r, action, now }) => {
    const home = homeId(r.resident_id);
    if (w.spaceOf(r) !== home) throw precondition('回到自己家才能摆家具。', 'not_home');
    const it = w.db.get('SELECT * FROM items WHERE item_id = ? AND owner_id = ? AND holder_id = ? AND stack = 0 AND reserved = 0', String(action.itemId ?? ''), r.resident_id, r.resident_id);
    const def = it ? itemDef(it.type) : undefined;
    if (!it || !def?.places) throw precondition('这不是一件能摆放的家具。', 'not_furniture');
    if (w.db.scalar('SELECT COUNT(*) FROM placed_objects WHERE space_id = ?', home) >= 8) throw precondition('家里已经摆满了。', 'home_full');
    const objectId = w.id('o');
    w.db.run('INSERT INTO placed_objects(object_id, world_id, space_id, type, label, owner_id, config_version, created_at) VALUES (?,?,?,?,?,?,1,?)', objectId, w.worldId, home, def.places, objectTypeName(def.places), r.resident_id, now);
    w.db.run('DELETE FROM items WHERE item_id = ?', it.item_id);
    return { status: 'completed', objectId, text: `把${def.name}摆进了家里。` };
  });

  // ── 赠送 / 交换 / 出借 ──
  w.handlers.set('offer', ({ r, action, now }) => {
    const kind = String(action.kind ?? '');
    if (kind !== 'gift' && kind !== 'trade' && kind !== 'loan') throw badRequest('kind 应该是 gift、trade 或 loan。');
    const space = w.spaceOf(r);
    const to = requirePersonReach(w, r, w.resident(String(action.to ?? '')), now);
    const give = parseBundle(w, action.give, 'give', r.resident_id);
    const want = kind === 'trade' ? parseBundle(w, action.want, 'want', to.resident_id) : { coins: 0, items: [] };
    if (bundleEmpty(give)) throw badRequest('要给出点什么。');
    if (kind === 'trade' && bundleEmpty(want)) throw badRequest('交换要写清楚想换什么；白送请用 gift。');
    if (kind === 'loan') {
      if (give.coins > 0 || give.items.length !== 1 || !give.items[0]!.itemId) throw badRequest('一次借出一件东西（用 itemId 指定）。');
      if (!mustItemDef(give.items[0]!.type).lendable) throw precondition('这种东西不能出借。', 'not_lendable');
    } else {
      for (const it of [...give.items, ...want.items]) {
        if (!mustItemDef(it.type).tradable) throw precondition(`${itemDef(it.type)!.name}不能转让。`, 'not_tradable');
      }
    }
    if (w.db.scalar("SELECT COUNT(*) FROM offers WHERE from_id = ? AND status = 'open'", r.resident_id) >= 3) throw precondition('你已经有 3 份没回复的报价了，等对方回应或先撤销。', 'too_many_offers');
    takeToken(w, r.resident_id, 'offer', 4, 4, now, '发起交换');
    const offerId = w.id('f');
    if (give.coins > 0) reserve(w, 'offer', offerId, r.resident_id, { coins: give.coins });
    for (const it of give.items) reserve(w, 'offer', offerId, r.resident_id, it.itemId ? { itemId: it.itemId } : { type: it.type, qty: it.qty });
    const expires = now + w.params.tradeOfferTtlMs;
    w.db.run(
      "INSERT INTO offers(offer_id, world_id, kind, from_id, to_id, space_id, give_json, want_json, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?)",
      offerId,
      w.worldId,
      kind,
      r.resident_id,
      to.resident_id,
      space,
      JSON.stringify(give),
      JSON.stringify(want),
      now,
      expires,
    );
    w.schedule('offer_expire', `offer:${offerId}`, expires, { offerId });
    const view = offerView(w, w.db.get('SELECT * FROM offers WHERE offer_id = ?', offerId)!);
    w.emitTo([r.resident_id, to.resident_id], 'offer', { offer: view }, now);
    return { status: 'accepted', offer: view };
  });

  // 不存在和「与你无关」统一报 not_available，不让陌生人探测报价编号
  const loadOffer = (id: unknown, residentId: string, side: 'to_id' | 'from_id'): Row => {
    const row = w.db.get('SELECT * FROM offers WHERE offer_id = ?', String(id ?? ''));
    if (!row || row[side] !== residentId) throw notAvailable('没有这份报价，或者它与你无关。');
    return row;
  };

  w.handlers.set('accept_offer', ({ r, action, now }) => {
    const row = loadOffer(action.offerId, r.resident_id, 'to_id');
    if (row.status !== 'open' || row.expires_at <= now) throw precondition('这份报价已经失效了。', 'offer_closed');
    const from = w.mustResident(row.from_id);
    // 成交时再量一次：走远了就拒绝，报价留着（预留不动），走近再点；离开实例、离线、进对局才会自动撤销
    requirePersonReach(w, r, from, now, '你们已经不在一处了。');
    const give = parseJson<Bundle>(row.give_json, { coins: 0, items: [] });
    const want = parseJson<Bundle>(row.want_json, { coins: 0, items: [] });
    const changed = w.db.run("UPDATE offers SET status = 'accepted', closed_at = ? WHERE offer_id = ? AND status = 'open'", now, row.offer_id).changes;
    if (changed !== 1) throw precondition('这份报价已经失效了。', 'offer_closed');
    release(w, 'offer', row.offer_id);
    w.cancelJob(`offer:${row.offer_id}`);
    const parties = [
      { id: from.resident_id, role: row.kind === 'loan' ? 'owner' : 'giver' },
      { id: r.resident_id, role: row.kind === 'loan' ? 'borrower' : 'receiver' },
    ];
    if (row.kind === 'loan') {
      const itemId = give.items[0]!.itemId!;
      const ok = w.db.run('UPDATE items SET holder_id = ? WHERE item_id = ? AND owner_id = ? AND holder_id = ? AND reserved = 0', r.resident_id, itemId, from.resident_id, from.resident_id).changes;
      if (ok !== 1) throw precondition('这件东西现在借不出去。', 'item_busy');
      const loanId = w.id('l');
      const due = now + w.params.loanDueAfterMs;
      w.db.run("INSERT INTO loans(loan_id, item_id, owner_id, borrower_id, via, lent_at, due_at, status) VALUES (?,?,?,?,'resident',?,?,'active')", loanId, itemId, from.resident_id, r.resident_id, now, due);
      w.schedule('loan_due', `loan:${loanId}`, due, { loanId });
      w.fact('loan_started', parties, { item: give.items[0]!.label ?? '东西', loanId });
    } else {
      // 先确认接受方拿得出对方想要的，再做双向转移；任何一步抛错整笔回滚
      if (want.coins > 0 && wallet(w, r.resident_id).available < want.coins) throw precondition('你的硬币不够换这份。', 'insufficient_coins');
      for (const it of want.items) {
        if (availableQty(w, r.resident_id, it.type) < it.qty) throw precondition(`你的${itemDef(it.type)?.name ?? it.type}不够换这份。`, 'insufficient_items');
      }
      // 先转"想要"的一边：它按种类自动挑接受方手里最早得到的几件，如果先把对方给的东西转进来，
      // 刚到手的东西也会被挑中又转回去，互换书之类的交易就等于什么都没发生
      moveBundle(w, want, r.resident_id, from.resident_id, `offer:${row.offer_id}:want`, row.kind);
      moveBundle(w, give, from.resident_id, r.resident_id, `offer:${row.offer_id}:give`, row.kind);
      const types = (b: Bundle) => [...new Set(b.items.map((i) => i.type))];
      w.fact(row.kind === 'gift' ? 'gift_accepted' : 'trade_completed', parties, { give: describeBundle(give), want: describeBundle(want), giveTypes: types(give), coins: give.coins });
      for (const t of types(give)) w.fact('item_acquired', [{ id: r.resident_id, role: 'self' }], { itemType: t, via: row.kind });
      for (const t of types(want)) w.fact('item_acquired', [{ id: from.resident_id, role: 'self' }], { itemType: t, via: row.kind });
    }
    const view = offerView(w, { ...row, status: 'accepted' });
    w.emitTo([from.resident_id, r.resident_id], 'offer', { offer: view }, now);
    return { status: 'completed', offer: view };
  });

  w.handlers.set('decline_offer', ({ r, action, now }) => {
    const row = loadOffer(action.offerId, r.resident_id, 'to_id');
    if (row.status !== 'open') throw precondition('这份报价已经失效了。', 'offer_closed');
    closeOffer(w, row, 'declined', '对方婉拒了', now);
    return { status: 'completed' };
  });

  w.handlers.set('cancel_offer', ({ r, action, now }) => {
    const row = loadOffer(action.offerId, r.resident_id, 'from_id');
    if (row.status !== 'open') throw precondition('这份报价已经失效了。', 'offer_closed');
    closeOffer(w, row, 'cancelled', '发起人撤销了', now);
    return { status: 'completed' };
  });

  w.jobHandlers.set('offer_expire', (payload, _job, now) => {
    const row = w.db.get("SELECT * FROM offers WHERE offer_id = ? AND status = 'open'", String(payload.offerId));
    if (row) closeOffer(w, row, 'expired', '太久没有回应', Math.min(now, row.expires_at));
  });

  // ── 书屋借书 ──
  w.handlers.set('borrow_book', ({ r, action, now }) => {
    if (w.spaceOf(r) !== 'bookshop') throw precondition('要到檐下书屋才能借书。', 'not_here');
    const book = bookDef(String(action.bookId ?? ''));
    if (!book) throw badRequest('书屋没有这本书。');
    const mine = w.db.scalar("SELECT COUNT(*) FROM loans WHERE borrower_id = ? AND via = 'library' AND status = 'active'", r.resident_id);
    if (mine >= w.params.libraryLoanLimit) throw precondition(`书屋的书一次最多借 ${w.params.libraryLoanLimit} 本，先还一本吧。`, 'loan_limit');
    const copy = w.db
      .all("SELECT item_id, metadata_json FROM items WHERE owner_id = ? AND holder_id = ? AND type = 'book' ORDER BY item_id", TOWN, TOWN)
      .find((it) => parseJson<{ bookId?: string }>(it.metadata_json, {}).bookId === book.id);
    if (!copy) throw precondition(`${book.title}都被借走了。`, 'unavailable');
    w.db.run('UPDATE items SET holder_id = ? WHERE item_id = ?', r.resident_id, copy.item_id);
    const loanId = w.id('l');
    const due = now + w.params.loanDueAfterMs;
    w.db.run("INSERT INTO loans(loan_id, item_id, owner_id, borrower_id, via, lent_at, due_at, status) VALUES (?,?,?,?,'library',?,?,'active')", loanId, copy.item_id, TOWN, r.resident_id, now, due);
    w.schedule('loan_due', `loan:${loanId}`, due, { loanId });
    w.fact('loan_started', [{ id: r.resident_id, role: 'borrower' }], { item: book.title, loanId, library: true });
    return { status: 'completed', itemId: copy.item_id, dueAt: due, text: `借到了${book.title}。看完还回书屋就好。` };
  });

  // ── 归还 ──
  w.handlers.set('return_item', ({ r, action, now }) => {
    const it = w.db.get('SELECT * FROM items WHERE item_id = ? AND holder_id = ?', String(action.itemId ?? ''), r.resident_id);
    const loan = it ? w.db.get("SELECT * FROM loans WHERE item_id = ? AND status = 'active'", it.item_id) : undefined;
    if (!it || !loan || it.owner_id === r.resident_id) throw precondition('这不是一件借来的东西。', 'not_borrowed');
    const space = w.spaceOf(r);
    let how: 'library' | 'in_person' | 'return_box';
    if (it.owner_id === TOWN) {
      if (space !== 'bookshop') throw precondition('书屋的书要还回檐下书屋。', 'not_here');
      how = 'library';
    } else {
      const owner = w.mustResident(it.owner_id);
      const reach = personReach(w, r, owner, now);
      if (reach.ok) how = 'in_person';
      else if (space === RESIDENTIAL_PLACE) how = 'return_box';
      else if (reach.why === 'too_far') throw precondition(`离${owner.name}太远了，先走到ta身边，或者放进灯巷会馆门前${owner.name}家的归还箱。`, 'too_far', { navigateTo: owner.resident_id });
      else throw precondition(`要当面还给${owner.name}，或者放进灯巷会馆门前${owner.name}家的归还箱。`, 'not_here');
    }
    w.db.run('UPDATE items SET holder_id = owner_id WHERE item_id = ?', it.item_id);
    w.db.run("UPDATE loans SET status = 'returned', returned_at = ? WHERE loan_id = ?", now, loan.loan_id);
    w.cancelJob(`loan:${loan.loan_id}`);
    const parties = [{ id: r.resident_id, role: 'borrower' }];
    if (it.owner_id !== TOWN) parties.push({ id: it.owner_id, role: 'owner' });
    w.fact('loan_returned', parties, { item: itemLabel(it), how });
    if (it.owner_id !== TOWN) w.emitTo([it.owner_id], 'notice', { text: how === 'in_person' ? `${r.name}把${itemLabel(it)}还给你了。` : `${itemLabel(it)}被放回了你家门口的归还箱。` }, now);
    return { status: 'completed', text: `还掉了${itemLabel(it)}。` };
  });

  // 到期只提醒，不自动收回：东西还在借的人手里
  w.jobHandlers.set('loan_due', (payload, _job, now) => {
    const loan = w.db.get("SELECT * FROM loans WHERE loan_id = ? AND status = 'active'", String(payload.loanId));
    if (!loan) return;
    const it = w.db.get('SELECT * FROM items WHERE item_id = ?', loan.item_id);
    if (!it) return;
    w.emitTo([loan.borrower_id], 'notice', { text: `你借的${itemLabel(it)}到了约好归还的时候。` }, Math.min(now, loan.due_at));
  });
}
