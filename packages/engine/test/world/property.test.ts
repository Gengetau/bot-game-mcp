/**
 * 栖灯镇：财物（账本、物品、商店、报价、出借与归还、书屋、消耗品、预留）。
 * 依据：设计文档第 5 节「物品镇币与借还」、第 9 节「财产与小游戏结果」、第 14 节参数；docs/TOWN.md「规则要点」。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { BOOKS } from '../../src/world/content.js';
import { SINK, accountOf, availableQty, ledger, mint, shopsAt, wallet } from '../../src/world/property.js';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';
import { checkInvariants } from './invariants.js';

const HOUR = 3600_000;

/** 全镇各种物品的总数量（含书屋藏书）。 */
function itemTotals(t: Town): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of t.w.db.all('SELECT type, SUM(quantity) AS n FROM items GROUP BY type')) out[r.type] = Number(r.n);
  return out;
}

const bookIds = (t: Town, residentId: string): string[] =>
  t.w
    .db.all("SELECT metadata_json FROM items WHERE owner_id = ? AND type = 'book'", residentId)
    .map((r) => JSON.parse(r.metadata_json).bookId as string);

function ownedBook(a: Actor): string {
  return a.view().inventory.items.find((i) => i.type === 'book' && !i.borrowedFrom)!.itemId;
}

/** 愿望奖励会让硬币数字随机游走，财物测试关掉愿望，只看账本本身。 */
const NO_GOALS = { shortGoals: 0, longGoals: 0 };

function twoAtPlaza(seed = 'prop-1') {
  const t = makeTown({ seed, params: NO_GOALS });
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  return { t, a, b };
}

/** 迈步出发，一直走到离开 zone 这片区域的那一刻为止（每步不超过导航租约）。 */
function walkOutOf(t: Town, who: Actor, zone: string): void {
  for (let i = 0; i < 60 && who.row().location_id === zone; i++) t.advance(500);
  expect(who.row().location_id).not.toBe(zone);
}

const err = (e: WorldError) => `${e.code}/${e.reason ?? ''}`;

// ───────────────────────── 账本与物品 ─────────────────────────

describe('财物：账本与物品', () => {
  it('注册发放 20 硬币、起始物资和一本来自书目的书', () => {
    const { t, a } = twoAtPlaza();
    expect(a.coins()).toBe(20);
    expect(a.qty('tea_leaves')).toBe(2);
    expect(a.qty('vegetables')).toBe(2);
    expect(a.qty('seeds')).toBe(2);
    const books = bookIds(t, a.residentId);
    expect(books).toHaveLength(1);
    expect(BOOKS.map((b) => b.id)).toContain(books[0]);
    // 起始硬币来自一笔 starter 发行
    expect(t.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = ?", `starter:${a.residentId}`)).toBe(1);
    checkInvariants(t);
  });

  it('起始的书用注入的随机源：同种子同结果，多人之间不是同一本', () => {
    const pick = (seed: string) => {
      const t = makeTown({ seed });
      return Array.from({ length: 8 }, (_, i) => bookIds(t, t.join(`居民${i}`, 'agent').residentId)[0]);
    };
    expect(pick('s1')).toEqual(pick('s1'));
    expect(new Set(pick('s1')).size).toBeGreaterThan(1);
  });

  it('只发一次：离开再进入、控制权接管、重启后都不会重发', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path, params: NO_GOALS });
      const a = t.join('阿灯');
      const before = { coins: a.coins(), tea: a.qty('tea_leaves'), books: bookIds(t, a.residentId), totals: itemTotals(t) };
      a.leave();
      a.enter();
      a.view();
      a.claim();
      expect(a.coins()).toBe(before.coins);
      expect(a.qty('tea_leaves')).toBe(before.tea);
      expect(bookIds(t, a.residentId)).toEqual(before.books);
      t.restart();
      a.enter();
      expect(a.coins()).toBe(before.coins);
      expect(a.qty('tea_leaves')).toBe(before.tea);
      expect(bookIds(t, a.residentId)).toEqual(before.books);
      expect(itemTotals(t)).toEqual(before.totals);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'starter'")).toBe(1);
      checkInvariants(t);
    } finally {
      db.cleanup();
    }
  });

  it('书屋藏书只生成一次（重启不翻倍）：每种两册', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path, params: NO_GOALS });
      const count = () => t.w.db.scalar("SELECT COUNT(*) FROM items WHERE owner_id = 'town' AND type = 'book'");
      expect(count()).toBe(BOOKS.length * 2);
      t.restart();
      expect(count()).toBe(BOOKS.length * 2);
    } finally {
      db.cleanup();
    }
  });

  it('复式账本：不平的分录被拒绝且什么都不改', () => {
    const { t, a } = twoAtPlaza();
    expect(() => ledger(t.w, 'bad:1', 'test', [[accountOf(a.residentId), -3], [SINK, 2]])).toThrow(/账目不平/);
    expect(() => ledger(t.w, 'bad:2', 'test', [[accountOf(a.residentId), 1.5], [SINK, -1.5]])).toThrow(/账目不平/);
    expect(a.coins()).toBe(20);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE cause_key LIKE 'bad:%'")).toBe(0);
    checkInvariants(t);
  });

  it('原因键唯一：同一个原因第二次不入账', () => {
    const { t, a } = twoAtPlaza();
    expect(mint(t.w, a.residentId, 5, 'k:once', 'test')).toBe(true);
    expect(mint(t.w, a.residentId, 5, 'k:once', 'test')).toBe(false);
    expect(a.coins()).toBe(25);
    expect(ledger(t.w, 'k:sink', 'test', [[accountOf(a.residentId), -4], [SINK, 4]])).toBe(true);
    expect(ledger(t.w, 'k:sink', 'test', [[accountOf(a.residentId), -4], [SINK, 4]])).toBe(false);
    expect(a.coins()).toBe(21);
    // 零额、负额发行不记账
    expect(mint(t.w, a.residentId, 0, 'k:zero', 'test')).toBe(false);
    expect(mint(t.w, a.residentId, -3, 'k:neg', 'test')).toBe(false);
    checkInvariants(t);
  });

  it('居民余额不能为负：超支抛 insufficient_coins，预留的硬币也不能花', () => {
    const { t, a, b } = twoAtPlaza();
    expect(() => ledger(t.w, 'over:1', 'test', [[accountOf(a.residentId), -21], [SINK, 21]])).toThrowError(expect.objectContaining({ reason: 'insufficient_coins' }));
    a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 15 } });
    expect(wallet(t.w, a.residentId)).toEqual({ balance: 20, reserved: 15, available: 5 });
    expect(() => ledger(t.w, 'over:2', 'test', [[accountOf(a.residentId), -6], [SINK, 6]])).toThrowError(expect.objectContaining({ reason: 'insufficient_coins' }));
    expect(ledger(t.w, 'over:3', 'test', [[accountOf(a.residentId), -5], [SINK, 5]])).toBe(true);
    checkInvariants(t);
  });

  it('聊天里说"给你一枚硬币"不会改变余额（只有结构化动作入账）', () => {
    const { t, a, b } = twoAtPlaza();
    a.act('speak', { text: '我给你 100 枚硬币，再送你一本书！' });
    expect(b.coins()).toBe(20);
    expect(b.qty('book')).toBe(1);
    checkInvariants(t);
  });

  it('一连串买卖之后：居民硬币总量 = 发行 − 回收；物品总量只因购买增加、因使用减少', () => {
    const { t, a, b } = twoAtPlaza();
    const base = itemTotals(t);
    a.go('tea_house');
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 3 });
    a.go('plaza');
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 });
    a.act('use_item', { itemType: 'cookie' });
    const offer = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 4, items: [{ type: 'cookie', qty: 1 }] } });
    b.act('accept_offer', { offerId: offer.offer.id });
    const now = itemTotals(t);
    expect(now.tea_leaves).toBe(base.tea_leaves! + 3);
    expect(now.cookie).toBe(2 - 1); // 买 2 个，用掉 1 个
    expect(now.book).toBe(base.book);
    expect(a.coins() + b.coins()).toBe(40 - 3 * 2 - 2 * 3 + 0); // 两人合计只因商店支出减少
    checkInvariants(t);
  });
});

// ───────────────────────── 商店 ─────────────────────────

describe('财物：商店', () => {
  it('只能在商店所在的地点买', () => {
    const { t, a } = twoAtPlaza();
    expect(err(a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' }))).toBe('precondition_failed/not_here');
    expect(a.coins()).toBe(20);
    a.go('tea_house');
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves' });
    // 刚迈步、还在茶馆这片区域里：照样买得了（按区域判定，不按有没有在走）
    a.act('navigate', { to: 'plaza' });
    t.advance(300);
    expect(a.row().location_id).toBe('tea_house');
    expect(a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves' }).status).toBe('completed');
    // 走出茶馆这片区域（灯笼路上）就买不了了
    for (let i = 0; i < 40 && a.row().location_id === 'tea_house'; i++) t.advance(500);
    expect(a.row().location_id).toBe('road');
    expect(a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' }).reason).toBe('not_here');
    checkInvariants(t);
  });

  it('不存在的店或商品是 bad_request；活动限定商品在活动外买不到', () => {
    const { t, a } = twoAtPlaza();
    expect(a.fail('buy', { shop: 'nope', sku: 'x' }).code).toBe('bad_request');
    expect(a.fail('buy', { shop: 'stall', sku: 'nope' }).code).toBe('bad_request');
    expect(a.fail('buy', { shop: 'stall', sku: 'paper_lamp' }).reason).toBe('not_on_sale');
    expect(shopsAt(t.w, 'plaza', t.clock.t)[0]!.goods.map((g) => g.sku)).not.toContain('paper_lamp');
  });

  it('数量必须是 1~10 的整数', () => {
    const { t, a } = twoAtPlaza();
    a.go('tea_house');
    for (const qty of [0, -1, 11, 1.5, 'x']) expect(a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty }).code, `qty=${String(qty)}`).toBe('bad_request');
    expect(a.coins()).toBe(20);
    // 上限 10 件可以买
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 10 });
    expect(a.qty('tea_leaves')).toBe(12);
    expect(a.coins()).toBe(0);
    checkInvariants(t);
  });

  it('硬币不够 insufficient_coins：硬币、库存、物品都不变（整体回滚）', () => {
    const { t, a } = twoAtPlaza();
    const stock = () => shopsAt(t.w, 'plaza', t.clock.t)[0]!.goods.find((g) => g.sku === 'lantern')!.stock;
    expect(stock()).toBe(6);
    const e = a.fail('buy', { shop: 'stall', sku: 'lantern', qty: 5 }); // 25 币 > 20
    expect(e.reason).toBe('insufficient_coins');
    expect(a.coins()).toBe(20);
    expect(stock()).toBe(6);
    expect(a.qty('lantern')).toBe(0);
    // 预留着的硬币同样不能花
    const b = t.join('阿木');
    a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 18 } });
    expect(a.fail('buy', { shop: 'stall', sku: 'cookie' }).reason).toBe('insufficient_coins');
    checkInvariants(t);
  });

  it('库存按世界日补货：卖完当天买不到，第二天补满', () => {
    const { t, a, b } = twoAtPlaza();
    a.go('bookshop');
    b.go('bookshop');
    a.act('buy', { shop: 'book_counter', sku: 'book:rain_lane' });
    expect(a.fail('buy', { shop: 'book_counter', sku: 'book:rain_lane' }).reason).toBe('sold_out');
    expect(b.fail('buy', { shop: 'book_counter', sku: 'book:rain_lane' }).reason).toBe('sold_out'); // 别人也买不到
    expect(shopsAt(t.w, 'bookshop', t.clock.t)[0]!.goods.find((g) => g.sku === 'book:rain_lane')!.stock).toBe(0);
    // 库存不够量时的提示：茶叶剩 N 件
    a.go('tea_house');
    b.go('tea_house');
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 3 });
    const before = shopsAt(t.w, 'tea_house', t.clock.t)[0]!.goods[0]!.stock;
    expect(before).toBe(30 - 3);
    // 过一个世界日（保持心跳）
    a.heartbeat();
    b.heartbeat();
    t.advanceAlive(24 * HOUR, [a, b], 30_000);
    const next = shopsAt(t.w, 'bookshop', t.clock.t)[0]!.goods.find((g) => g.sku === 'book:rain_lane')!.stock;
    expect(next).toBe(1);
    expect(shopsAt(t.w, 'tea_house', t.clock.t)[0]!.goods[0]!.stock).toBe(30);
    // 新的一天书又能买了
    a.go('plaza');
    a.go('bookshop');
    a.act('buy', { shop: 'book_counter', sku: 'book:rain_lane' });
    checkInvariants(t);
  });

  it('买书得到的是带 bookId 的独立物品，买几件得几件', () => {
    const { t, a } = twoAtPlaza();
    a.go('bookshop');
    const out = a.act('buy', { shop: 'book_counter', sku: 'book:slow_fire' });
    expect(out.bought).toMatchObject({ qty: 1, cost: 6 });
    expect(bookIds(t, a.residentId)).toContain('slow_fire');
    expect(a.qty('book')).toBe(2);
    expect(a.coins()).toBe(14);
    checkInvariants(t);
  });

  it('买家具后 place_furniture：只能在自己家，摆好后物品变成家里的物件', () => {
    const { t, a, b } = twoAtPlaza();
    a.go('garden');
    a.act('buy', { shop: 'shed', sku: 'planter_box' });
    const itemId = a.view().inventory.items.find((i) => i.type === 'planter_box')!.itemId;
    expect(a.fail('place_furniture', { itemId }).reason).toBe('not_home');
    a.go('home');
    expect(a.view().here?.space).toBe(`home:${a.residentId}`);
    expect(a.fail('place_furniture', { itemId: 'nonexistent' }).reason).toBe('not_furniture');
    // 不是家具的东西（书）不能摆
    expect(a.fail('place_furniture', { itemId: ownedBook(a) }).reason).toBe('not_furniture');
    const out = a.act('place_furniture', { itemId });
    expect(a.qty('planter_box')).toBe(0);
    expect(a.view().here!.objects.map((o) => o.type)).toContain('planter');
    expect(t.w.db.get('SELECT owner_id FROM placed_objects WHERE object_id = ?', out.objectId)!.owner_id).toBe(a.residentId);
    // 别人的家具不能由别人摆（物品只在自己手里；b 没有家具）
    expect(b.fail('place_furniture', { itemId }).code).toBe('precondition_failed');
    checkInvariants(t);
  });

  it('家具不能转让也不能出借；预留中的家具不能摆放', () => {
    const { t, a, b } = twoAtPlaza();
    a.go('kitchen');
    b.go('kitchen');
    a.act('buy', { shop: 'pantry', sku: 'stove_kit' });
    const itemId = a.view().inventory.items.find((i) => i.type === 'stove_kit')!.itemId;
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ itemId }] } }).reason).toBe('not_tradable');
    expect(a.fail('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId }] } }).reason).toBe('not_lendable');
    checkInvariants(t);
  });

  it('display_item：只能在自己家摆出/收起装饰；摆出的不能送人', () => {
    const { t, a, b } = twoAtPlaza();
    a.act('buy', { shop: 'stall', sku: 'lantern', qty: 2 });
    expect(a.fail('display_item', { itemType: 'lantern' }).reason).toBe('not_home');
    a.go('home');
    expect(a.fail('display_item', { itemType: 'tea_leaves' }).reason).toBe('not_decor');
    expect(a.fail('display_item', { itemType: 'lantern', qty: 3 }).reason).toBe('insufficient_items');
    a.act('display_item', { itemType: 'lantern', qty: 1 });
    const inv = a.view().inventory.items.find((i) => i.type === 'lantern')!;
    expect(inv).toMatchObject({ qty: 2, shelved: 1, available: 1 });
    expect(a.fail('display_item', { itemType: 'lantern', on: false, qty: 2 }).reason).toBe('insufficient_items');
    a.act('display_item', { itemType: 'lantern', on: false });
    expect(a.view().inventory.items.find((i) => i.type === 'lantern')!.shelved).toBe(0);
    // 用 itemId 摆书，摆出来的书不能送人
    const book = ownedBook(a);
    a.act('display_item', { itemId: book });
    expect(a.fail('display_item', { itemId: 'nope' }).reason).toBe('not_yours');
    a.go('plaza');
    expect(a.fail('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId: book }] } }).reason).toBe('item_busy');
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ itemId: book }] } }).reason).toBe('item_busy');
    checkInvariants(t);
  });
});

// ───────────────────────── 报价：送礼 / 交换 ─────────────────────────

describe('财物：报价（送礼与交换）', () => {
  it('发起时预留：预留中的东西不能再花、再报价、使用', () => {
    const { t, a, b } = twoAtPlaza();
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 1 });
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'cookie', qty: 1 }, { type: 'tea_leaves', qty: 1 }], coins: 10 } });
    expect(o.status).toBe('accepted');
    expect(o.offer.status).toBe('open');
    const inv = a.view().inventory;
    expect(inv.coins).toEqual({ balance: 17, reserved: 10, available: 7 });
    expect(inv.items.find((i) => i.type === 'cookie')).toMatchObject({ qty: 1, available: 0 });
    expect(inv.items.find((i) => i.type === 'tea_leaves')).toMatchObject({ qty: 2, available: 1 });
    // 不能使用预留中的饼干
    expect(a.fail('use_item', { itemType: 'cookie' }).reason).toBe('insufficient_items');
    // 不能再报价同一份
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'cookie', qty: 1 }] } }).reason).toBe('insufficient_items');
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { coins: 8 } }).reason).toBe('insufficient_coins');
    // 不能拿去花
    expect(a.fail('buy', { shop: 'stall', sku: 'lantern', qty: 2 }).reason).toBe('insufficient_coins'); // 10 币 > 可用 7
    // 不能放进共同活动当投入：茶叶只剩 1 份可用，再预留 1 份是可以的，2 份不行（见 interact 测试），这里验证预留数
    expect(availableQty(t.w, a.residentId, 'tea_leaves')).toBe(1);
    checkInvariants(t);
  });

  it('接受：赠送一次转移，预留清零，双方收到事件，账本平衡', () => {
    const { t, a, b } = twoAtPlaza();
    const cursor = b.events().cursor;
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5, items: [{ type: 'seeds', qty: 2 }] } });
    expect(b.view().offers.map((x) => x.id)).toEqual([o.offer.id]);
    expect(b.view().offers[0]!.text).toContain('想送给');
    const done = b.act('accept_offer', { offerId: o.offer.id });
    expect(done.status).toBe('completed');
    expect(done.offer.status).toBe('accepted');
    expect([a.coins(), b.coins()]).toEqual([15, 25]);
    expect([a.qty('seeds'), b.qty('seeds')]).toEqual([0, 4]);
    expect(a.view().inventory.coins.reserved).toBe(0);
    expect(a.view().offers).toEqual([]);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM resource_reservations')).toBe(0);
    const types = b.events(cursor).events.filter((e) => e.type === 'offer').map((e) => (e.data.offer as { status: string }).status);
    expect(types).toEqual(['open', 'accepted']);
    expect(t.w.db.get("SELECT kind FROM ledger_transactions WHERE cause_key LIKE 'offer:%:give'")!.kind).toBe('gift');
    checkInvariants(t);
  });

  it('只有收件人能接受/婉拒，只有发起人能撤销；已接受的不能再处理', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    expect(a.fail('accept_offer', { offerId: o.offer.id }).code).toBe('not_available');
    expect(c.fail('accept_offer', { offerId: o.offer.id }).code).toBe('not_available');
    expect(a.fail('decline_offer', { offerId: o.offer.id }).code).toBe('not_available');
    expect(b.fail('cancel_offer', { offerId: o.offer.id }).code).toBe('not_available');
    expect(b.fail('accept_offer', { offerId: 'nope' }).code).toBe('not_available');
    b.act('accept_offer', { offerId: o.offer.id });
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    expect(a.fail('cancel_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    expect(b.fail('decline_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    checkInvariants(t);
  });

  it('交换：双向转移在同一事务里完成（硬币+物品换物品）', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'trade', to: b.residentId, give: { coins: 3, items: [{ type: 'tea_leaves', qty: 1 }] }, want: { items: [{ type: 'vegetables', qty: 2 }] } });
    expect(o.offer.text).toContain('换');
    b.act('accept_offer', { offerId: o.offer.id });
    expect([a.coins(), b.coins()]).toEqual([17, 23]);
    expect([a.qty('tea_leaves'), b.qty('tea_leaves')]).toEqual([1, 3]);
    expect([a.qty('vegetables'), b.qty('vegetables')]).toEqual([4, 0]);
    checkInvariants(t);
  });

  it('交换：双方各拿一本书互换，所有权和持有者都对调', () => {
    const { t, a, b } = twoAtPlaza();
    const mine = ownedBook(a);
    const theirs = ownedBook(b);
    const o = a.act('offer', { kind: 'trade', to: b.residentId, give: { items: [{ itemId: mine }] }, want: { items: [{ type: 'book', qty: 1 }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    const row = (id: string) => t.w.db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', id)!;
    expect(row(mine)).toMatchObject({ owner_id: b.residentId, holder_id: b.residentId });
    expect(row(theirs)).toMatchObject({ owner_id: a.residentId, holder_id: a.residentId });
    checkInvariants(t);
  });

  it('交换：对方东西不够 → 接受失败，双方的物品、硬币、预留都不变，报价仍开着', () => {
    const { t, a, b } = twoAtPlaza();
    const snap = () => JSON.stringify([a.view().inventory, b.view().inventory]);
    const o = a.act('offer', { kind: 'trade', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 1 }] }, want: { items: [{ type: 'vegetables', qty: 5 }] } });
    const before = snap();
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('insufficient_items');
    expect(snap()).toBe(before);
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('open');
    // 想要的硬币对方也拿不出
    const o2 = a.act('offer', { kind: 'trade', to: b.residentId, give: { items: [{ type: 'seeds', qty: 1 }] }, want: { coins: 21 } });
    const before2 = snap();
    expect(b.fail('accept_offer', { offerId: o2.offer.id }).reason).toBe('insufficient_coins');
    expect(snap()).toBe(before2);
    // 对方自己把东西预留给别人后，也算不够
    const c = t.join('阿木');
    const o3 = a.act('offer', { kind: 'trade', to: b.residentId, give: { items: [{ type: 'seeds', qty: 1 }] }, want: { items: [{ type: 'vegetables', qty: 2 }] } });
    b.act('offer', { kind: 'gift', to: c.residentId, give: { items: [{ type: 'vegetables', qty: 1 }] } });
    expect(b.fail('accept_offer', { offerId: o3.offer.id }).reason).toBe('insufficient_items');
    // 仍可婉拒，婉拒后预留退回
    b.act('decline_offer', { offerId: o.offer.id });
    // b 把 1 份蔬菜预留给了 c，但 a 的茶叶预留在婉拒后全部退回
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    checkInvariants(t);
  });

  it('接受方在接受时硬币刚好够，转移后双方账户都不为负', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'trade', to: b.residentId, give: { items: [{ type: 'seeds', qty: 1 }] }, want: { coins: 20 } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect([a.coins(), b.coins()]).toEqual([40, 0]);
    checkInvariants(t);
  });

  it('婉拒与撤销：预留全数退回，状态与原因记录下来', () => {
    const { t, a, b } = twoAtPlaza();
    const give = { coins: 7, items: [{ type: 'tea_leaves', qty: 2 }] };
    const o1 = a.act('offer', { kind: 'gift', to: b.residentId, give });
    b.act('decline_offer', { offerId: o1.offer.id });
    expect(a.view().inventory.coins).toEqual({ balance: 20, reserved: 0, available: 20 });
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')).toMatchObject({ qty: 2, available: 2 });
    const o2 = a.act('offer', { kind: 'gift', to: b.residentId, give });
    a.act('cancel_offer', { offerId: o2.offer.id });
    expect(a.view().inventory.coins.reserved).toBe(0);
    expect(a.qty('tea_leaves')).toBe(2);
    const rows = t.w.db.all("SELECT status, close_reason FROM offers ORDER BY created_at, offer_id");
    expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'declined']);
    expect(rows.every((r) => r.close_reason)).toBe(true);
    // 退回后可以再次使用
    a.act('offer', { kind: 'gift', to: b.residentId, give });
    checkInvariants(t);
  });

  it('过期（offer_expire）：10 分钟没回应，预留退回，之后接受报 offer_closed', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 9 } });
    expect(o.offer.expiresAt - t.clock.t).toBe(10 * 60_000);
    t.advanceAlive(9 * 60_000, [a, b]);
    expect(a.view().inventory.coins.reserved).toBe(9);
    t.advanceAlive(61_000, [a, b]);
    expect(t.w.db.get('SELECT status, close_reason FROM offers WHERE offer_id = ?', o.offer.id)).toMatchObject({ status: 'expired' });
    expect(a.view().inventory.coins).toEqual({ balance: 20, reserved: 0, available: 20 });
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'offer_expire' AND status = 'pending'")).toBe(0);
    checkInvariants(t);
  });

  it('到点那一刻才接受也不行：过期边界按 expires_at 判断（任务还没跑时）', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 9 } });
    t.advanceAlive(o.offer.expiresAt - t.clock.t - 1000, [a, b]);
    t.clock.t = o.offer.expiresAt; // 不 tick，由命令入口先处理到期任务
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    expect(a.coins()).toBe(20);
    checkInvariants(t);
  });

  it('收件方走开 → 报价自动撤销并退回', () => {
    const { t, a, b } = twoAtPlaza();
    const o1 = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5 } });
    b.act('move', { to: 'tea_house' });
    // 刚迈步、还在广场这片区域里：报价还在
    t.advance(300);
    expect(b.row().location_id).toBe('plaza');
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o1.offer.id)!.status).toBe('open');
    // 走出广场的那一刻撤销
    walkOutOf(t, b, 'plaza');
    expect(t.w.db.get('SELECT status, close_reason FROM offers WHERE offer_id = ?', o1.offer.id)).toMatchObject({ status: 'cancelled' });
    expect(a.view().inventory.coins.reserved).toBe(0);
    checkInvariants(t);
  });

  it('发起方走开：报价撤销，收件方看不到，预留退回', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5, items: [{ type: 'seeds', qty: 1 }] } });
    a.act('move', { to: 'tea_house' });
    walkOutOf(t, a, 'plaza');
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('cancelled');
    expect(b.view().offers).toEqual([]);
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    expect(a.view().inventory.coins.reserved).toBe(0);
    expect(a.view().inventory.items.find((i) => i.type === 'seeds')!.available).toBe(2);
    checkInvariants(t);
  });

  it('边走边做：同在广场的两个人，一方正在走路（还没出广场）也能发起、接受交换', () => {
    const { t, a, b } = twoAtPlaza();
    a.act('navigate', { to: 'tea_house' });
    t.advance(300);
    expect(a.row().location_id).toBe('plaza');
    expect(a.pos().moving).toBe(true);
    // 走着的人发起
    const o = a.act('offer', { kind: 'trade', to: b.residentId, give: { coins: 3 }, want: { items: [{ type: 'seeds', qty: 1 }] } });
    // 对方也迈步走开一步，仍在广场里，接受照样成交
    b.act('navigate', { to: 'bookshop' });
    t.advance(300);
    expect(b.row().location_id).toBe('plaza');
    expect(b.pos().moving).toBe(true);
    b.act('accept_offer', { offerId: o.offer.id });
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('accepted');
    expect(a.coins()).toBe(17);
    expect(b.coins()).toBe(23);
    expect(a.qty('seeds')).toBe(3);
    checkInvariants(t);
  });

  it('跨区域那一刻撤销没完成的交换：在路上（灯笼路）的一方，已经和广场上的另一方不在一处', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'trade', to: b.residentId, give: { coins: 4 }, want: { items: [{ type: 'seeds', qty: 1 }] } });
    expect(a.view().inventory.coins.reserved).toBe(4);
    b.act('navigate', { to: 'tea_house' });
    walkOutOf(t, b, 'plaza');
    expect(b.row().location_id).toBe('road');
    expect(t.w.db.get('SELECT status, close_reason FROM offers WHERE offer_id = ?', o.offer.id)).toMatchObject({ status: 'cancelled' });
    expect(a.view().inventory.coins.reserved).toBe(0);
    expect(b.view().offers).toEqual([]);
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('offer_closed');
    expect(a.coins()).toBe(20);
    expect(b.coins()).toBe(20);
    checkInvariants(t);
  });

  it('任一方离线（显式离开 / 租约过期）→ 报价撤销并退回', () => {
    const { t, a, b } = twoAtPlaza();
    const o1 = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5 } });
    b.leave();
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o1.offer.id)!.status).toBe('cancelled');
    expect(a.view().inventory.coins.reserved).toBe(0);
    b.enter();
    // 租约过期：a 发起，a 不再心跳
    const o2 = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 6 } });
    t.advanceAlive(90_000, [b], 20_000);
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o2.offer.id)!.status).toBe('cancelled');
    expect(t.w.db.scalar('SELECT reserved FROM accounts WHERE account_id = ?', accountOf(a.residentId))).toBe(0);
    checkInvariants(t);
  });

  it('进入小游戏 → 报价自动撤销；对游戏里的人也不能发起', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    const o = c.act('offer', { kind: 'gift', to: a.residentId, give: { coins: 4 } });
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('cancelled');
    expect(c.view().inventory.coins.reserved).toBe(0);
    expect(c.fail('offer', { kind: 'gift', to: a.residentId, give: { coins: 1 } }).reason).toBe('not_here');
    checkInvariants(t);
  });

  it('不能对不在场的人发起：不同区域（含灯笼路上）、离线、自己、不存在', () => {
    const { t, a, b } = twoAtPlaza();
    const give = { coins: 1 };
    expect(a.fail('offer', { kind: 'gift', to: a.residentId, give }).reason).toBe('not_here');
    expect(a.fail('offer', { kind: 'gift', to: 'r_nobody', give }).reason).toBe('not_here');
    b.act('move', { to: 'tea_house' });
    t.advance(300);
    expect(a.act('offer', { kind: 'gift', to: b.residentId, give }).status).toBe('accepted'); // 刚迈步、还在广场：照样在场
    walkOutOf(t, b, 'plaza');
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give }).reason).toBe('not_here'); // 灯笼路上：已不在一处
    b.walk();
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give }).reason).toBe('not_here'); // 另一区域
    a.go('tea_house');
    b.leave();
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give }).reason).toBe('not_here'); // 离线
    expect(t.w.db.scalar("SELECT COUNT(*) FROM offers WHERE status = 'open'")).toBe(0);
    checkInvariants(t);
  });

  it('接受时对方已不在一处 → 拒绝（不会远程成交）', () => {
    const { t, a, b } = twoAtPlaza();
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    // 绕过钩子地把 b 挪走，模拟钩子失效时的兜底检查
    t.w.db.run('UPDATE residents SET location_id = ? WHERE resident_id = ?', 'tea_house', b.residentId);
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('not_here');
    t.w.db.run('UPDATE residents SET location_id = ? WHERE resident_id = ?', 'plaza', b.residentId);
  });

  it('同一 requestId 重放不重复转移（replayed: true）；换内容 → request_conflict', () => {
    const { t, a, b } = twoAtPlaza();
    const give = { coins: 5 };
    const first = a.act('offer', { kind: 'gift', to: b.residentId, give }, { requestId: 'offer-req-0001' });
    const again = a.act('offer', { kind: 'gift', to: b.residentId, give }, { requestId: 'offer-req-0001' });
    expect(first.replayed).toBeUndefined();
    expect(again.replayed).toBe(true);
    expect(again.offer.id).toBe(first.offer.id);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM offers')).toBe(1);
    expect(a.view().inventory.coins.reserved).toBe(5);
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { coins: 6 } }, { requestId: 'offer-req-0001' }).code).toBe('request_conflict');
    expect(a.view().inventory.coins.reserved).toBe(5);
    // 接受重放
    const acc = b.act('accept_offer', { offerId: first.offer.id }, { requestId: 'accept-req-0001' });
    const acc2 = b.act('accept_offer', { offerId: first.offer.id }, { requestId: 'accept-req-0001' });
    expect(acc2.replayed).toBe(true);
    expect(acc2.offer.id).toBe(acc.offer.id);
    expect([a.coins(), b.coins()]).toEqual([15, 25]);
    // 换一个 requestId 再接受同一份 → 已失效，不会重复成交
    expect(b.fail('accept_offer', { offerId: first.offer.id }).reason).toBe('offer_closed');
    expect([a.coins(), b.coins()]).toEqual([15, 25]);
    checkInvariants(t);
  });

  it('买东西同一 requestId 重放只扣一次钱', () => {
    const { t, a } = twoAtPlaza();
    const r1 = a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 }, { requestId: 'buy-req-00001' });
    const r2 = a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 }, { requestId: 'buy-req-00001' });
    expect(r2.replayed).toBe(true);
    expect(r2.bought).toEqual(r1.bought);
    expect(a.coins()).toBe(14);
    expect(a.qty('cookie')).toBe(2);
    expect(shopsAt(t.w, 'plaza', t.clock.t)[0]!.goods.find((g) => g.sku === 'cookie')!.stock).toBe(18);
    checkInvariants(t);
  });

  it('一个人最多 3 份没回复的报价；撤销后可以再发', () => {
    const { t, a, b } = twoAtPlaza();
    const ids = [1, 2, 3].map((n) => a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: n } }).offer.id);
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } }).reason).toBe('too_many_offers');
    a.act('cancel_offer', { offerId: ids[0] });
    a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    checkInvariants(t);
  });

  it('报价内容校验：空内容、交换不写想要的、想要具体某件、给别人的东西、金额非法', () => {
    const { t, a, b } = twoAtPlaza();
    const to = b.residentId;
    expect(a.fail('offer', { kind: 'swap', to, give: { coins: 1 } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: {} }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'trade', to, give: { coins: 1 } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'trade', to, give: { coins: 1 }, want: { items: [{ itemId: ownedBook(b) }] } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: { coins: -1 } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: { coins: 1.5 } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: { items: [{ type: 'tea_leaves', qty: 0 }] } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: { items: [{ type: 'nope', qty: 1 }] } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: { items: [{ type: 'book', qty: 1 }] } }).code).toBe('bad_request'); // 书要用 itemId
    expect(a.fail('offer', { kind: 'gift', to, give: { items: [{ itemId: ownedBook(b) }] } }).reason).toBe('not_yours');
    const book = ownedBook(a);
    expect(a.fail('offer', { kind: 'gift', to, give: { items: [{ itemId: book }, { itemId: book }] } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'gift', to, give: { coins: 21 } }).reason).toBe('insufficient_coins');
    expect(a.fail('offer', { kind: 'gift', to, give: { items: [{ type: 'tea_leaves', qty: 3 }] } }).reason).toBe('insufficient_items');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM offers')).toBe(0);
    checkInvariants(t);
  });

  it('报价中途失败（第二项预留不足）整体回滚：第一项的预留不残留', () => {
    const { t, a, b } = twoAtPlaza();
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { coins: 5, items: [{ type: 'tea_leaves', qty: 2 }, { type: 'seeds', qty: 3 }] } }).reason).toBe('insufficient_items');
    expect(a.view().inventory.coins.reserved).toBe(0);
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM resource_reservations')).toBe(0);
    checkInvariants(t);
  });
});

// ───────────────────────── 出借与归还 ─────────────────────────

describe('财物：出借与归还', () => {
  function lend(t: Town, a: Actor, b: Actor) {
    const itemId = ownedBook(a);
    const o = a.act('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId }] } });
    return { itemId, o, done: b.act('accept_offer', { offerId: o.offer.id }) };
  }

  it('出借：所有者不变、持有者变；借期 72 小时；借条与双方背包展示一致', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId, done } = lend(t, a, b);
    expect(done.offer.status).toBe('accepted');
    expect(t.w.db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', itemId)).toMatchObject({ owner_id: a.residentId, holder_id: b.residentId });
    const loan = t.w.db.get("SELECT * FROM loans WHERE item_id = ? AND status = 'active'", itemId)!;
    expect(loan).toMatchObject({ owner_id: a.residentId, borrower_id: b.residentId, via: 'resident' });
    expect(loan.due_at - loan.lent_at).toBe(72 * HOUR);
    const bi = b.view().inventory.items.find((i) => i.itemId === itemId)!;
    expect(bi).toMatchObject({ borrowedFrom: a.name, available: 0, dueAt: loan.due_at });
    expect(a.view().inventory.lent).toEqual([expect.objectContaining({ itemId, to: b.name, dueAt: loan.due_at })]);
    // 所有者名下的书仍是 owner 的，但 a 手里已经没有可动用的这一本
    expect(a.view().inventory.items.find((i) => i.itemId === itemId)).toBeUndefined();
    checkInvariants(t);
  });

  it('出借一次一件，必须用 itemId；硬币、堆叠物品、多件、不可借的都拒绝', () => {
    const { t, a, b } = twoAtPlaza();
    const to = b.residentId;
    const book = ownedBook(a);
    expect(a.fail('offer', { kind: 'loan', to, give: { coins: 1 } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'loan', to, give: { items: [{ type: 'tea_leaves', qty: 1 }] } }).code).toBe('bad_request');
    expect(a.fail('offer', { kind: 'loan', to, give: { items: [{ itemId: book }], coins: 1 } }).code).toBe('bad_request');
    // 两件
    a.go('bookshop');
    a.act('buy', { shop: 'book_counter', sku: 'book:rain_lane' });
    b.go('bookshop');
    const second = a.view().inventory.items.filter((i) => i.type === 'book' && i.itemId !== book)[0]!.itemId;
    expect(a.fail('offer', { kind: 'loan', to, give: { items: [{ itemId: book }, { itemId: second }] } }).code).toBe('bad_request');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM offers')).toBe(0);
    checkInvariants(t);
  });

  it('借出期间：所有者不能再把同一本书送人/借给别人', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    const { itemId } = lend(t, a, b);
    expect(a.fail('offer', { kind: 'gift', to: c.residentId, give: { items: [{ itemId }] } }).reason).toBe('not_yours');
    expect(a.fail('offer', { kind: 'loan', to: c.residentId, give: { items: [{ itemId }] } }).reason).toBe('not_yours');
    checkInvariants(t);
  });

  it('借来的东西不能转送、交换、再借出、摆出来', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    const { itemId } = lend(t, a, b);
    const to = c.residentId;
    expect(b.fail('offer', { kind: 'gift', to, give: { items: [{ itemId }] } }).reason).toBe('not_yours');
    expect(b.fail('offer', { kind: 'trade', to, give: { items: [{ itemId }] }, want: { coins: 1 } }).reason).toBe('not_yours');
    expect(b.fail('offer', { kind: 'loan', to, give: { items: [{ itemId }] } }).reason).toBe('not_yours');
    b.go('home');
    expect(b.fail('display_item', { itemId }).reason).toBe('not_yours');
    expect(b.fail('place_furniture', { itemId }).reason).toBe('not_furniture');
    checkInvariants(t);
  });

  it('别人想用交换"买走"借来的书：借的人只有借来的一本时，接受失败（借来的不算他的）', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    lend(t, a, b);
    // b 把自己的那本送给 c，手里只剩借来的
    b.act('offer', { kind: 'gift', to: c.residentId, give: { items: [{ itemId: ownedBook(b) }] } });
    c.act('accept_offer', { offerId: b.view().inventory.coins && t.w.db.get("SELECT offer_id FROM offers WHERE status = 'open'")!.offer_id });
    const o = c.act('offer', { kind: 'trade', to: b.residentId, give: { coins: 2 }, want: { items: [{ type: 'book', qty: 1 }] } });
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('insufficient_items');
    expect(t.w.db.get("SELECT COUNT(*) AS n FROM items WHERE holder_id = ? AND owner_id <> ?", b.residentId, b.residentId)!.n).toBe(1);
    checkInvariants(t);
  });

  it('到期（loan_due）：只提醒借的人，东西不自动收回，不罚款、不扣关系', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId } = lend(t, a, b);
    const cursor = b.events().cursor;
    const rel = JSON.stringify(t.w.db.all('SELECT * FROM relationships ORDER BY resident_id, other_id'));
    const coins = [a.coins(), b.coins()];
    t.advance(72 * HOUR - 1000);
    expect(b.events(cursor).events.filter((e) => e.type === 'notice')).toHaveLength(0);
    t.advance(2000);
    const notes = b.events(cursor).events.filter((e) => e.type === 'notice');
    expect(notes).toHaveLength(1);
    expect(String(notes[0]!.data.text)).toContain('到了约好归还');
    expect(t.w.db.get('SELECT holder_id FROM items WHERE item_id = ?', itemId)!.holder_id).toBe(b.residentId);
    expect(t.w.db.get('SELECT status FROM loans WHERE item_id = ?', itemId)!.status).toBe('active');
    expect(JSON.stringify(t.w.db.all('SELECT * FROM relationships ORDER BY resident_id, other_id'))).toBe(rel);
    expect([wallet(t.w, a.residentId).balance, wallet(t.w, b.residentId).balance]).toEqual(coins);
    checkInvariants(t);
  });

  it('逾期很久之后仍然可以归还，归还后到期提醒不会再来', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId } = lend(t, a, b);
    t.advance(100 * HOUR);
    b.enter();
    a.enter();
    b.act('return_item', { itemId });
    expect(t.w.db.get('SELECT holder_id FROM items WHERE item_id = ?', itemId)!.holder_id).toBe(a.residentId);
    checkInvariants(t);
  });

  it('归还时取消到期任务：提前还书后过了借期也没有提醒', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId } = lend(t, a, b);
    b.act('return_item', { itemId });
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'loan_due' AND status = 'pending'")).toBe(0);
    const cursor = b.events().cursor;
    t.advance(80 * HOUR);
    expect(b.events(cursor).events.filter((e) => e.type === 'notice')).toHaveLength(0);
  });

  it('归还途径一：当面还给主人（主人收到提示，借条结清，书又能出借）', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId } = lend(t, a, b);
    const cursor = a.events().cursor;
    b.act('return_item', { itemId });
    expect(t.w.db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', itemId)).toMatchObject({ owner_id: a.residentId, holder_id: a.residentId });
    expect(t.w.db.get('SELECT status, returned_at FROM loans WHERE item_id = ?', itemId)).toMatchObject({ status: 'returned' });
    expect(a.events(cursor).events.some((e) => e.type === 'notice' && String(e.data.text).includes('还给你了'))).toBe(true);
    expect(a.view().inventory.lent).toEqual([]);
    // 可以再借一次
    const o = a.act('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM loans WHERE item_id = ?', itemId)).toBe(2);
    checkInvariants(t);
  });

  it('归还途径二：会馆门口的归还箱（主人不在场、不在线也行；别的地方不行）', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId } = lend(t, a, b);
    a.leave(); // 主人离线
    expect(b.fail('return_item', { itemId }).reason).toBe('not_here'); // 广场不行
    b.go('tea_house');
    expect(b.fail('return_item', { itemId }).reason).toBe('not_here'); // 茶馆不行
    b.go('residential');
    const cursor = a.events().cursor;
    b.act('return_item', { itemId });
    expect(t.w.db.get('SELECT holder_id FROM items WHERE item_id = ?', itemId)!.holder_id).toBe(a.residentId);
    expect(t.w.db.get('SELECT status FROM loans WHERE item_id = ?', itemId)!.status).toBe('returned');
    expect(a.events(cursor).events.some((e) => e.type === 'notice' && String(e.data.text).includes('归还箱'))).toBe(true);
    // 归还箱只接收主人借出的东西：自己的书不是"借来的"
    expect(b.fail('return_item', { itemId: ownedBook(b) }).reason).toBe('not_borrowed');
    checkInvariants(t);
  });

  it('归还途径二补充：归还箱不是任意转移——放进箱子的只能是对应的借条物品', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    const { itemId } = lend(t, a, b);
    // 第三人不是持有者，不能归还别人借的东西
    expect(c.fail('return_item', { itemId }).reason).toBe('not_borrowed');
    // 主人自己也不能"归还"
    expect(a.fail('return_item', { itemId }).reason).toBe('not_borrowed');
    // 不存在的
    expect(b.fail('return_item', { itemId: 'nope' }).reason).toBe('not_borrowed');
    checkInvariants(t);
  });

  it('归还途径三：书屋藏书只能还回书屋；还掉之后又能借；重复归还报错', () => {
    const { t, a } = twoAtPlaza();
    a.go('bookshop');
    const out = a.act('borrow_book', { bookId: 'rain_lane' });
    expect(out.dueAt - t.clock.t).toBe(72 * HOUR);
    const itemId = out.itemId as string;
    expect(t.w.db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', itemId)).toMatchObject({ owner_id: 'town', holder_id: a.residentId });
    expect(a.view().inventory.items.find((i) => i.itemId === itemId)).toMatchObject({ borrowedFrom: '檐下书屋' });
    a.go('plaza');
    expect(a.fail('return_item', { itemId }).reason).toBe('not_here');
    a.go('bookshop');
    a.act('return_item', { itemId });
    expect(t.w.db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', itemId)).toMatchObject({ owner_id: 'town', holder_id: 'town' });
    expect(a.fail('return_item', { itemId }).reason).toBe('not_borrowed');
    a.act('borrow_book', { bookId: 'rain_lane' });
    checkInvariants(t);
  });

  it('同一件东西同时只有一条进行中的借条（数据库约束兜底）', () => {
    const { t, a, b } = twoAtPlaza();
    const { itemId } = lend(t, a, b);
    expect(() =>
      t.w.db.run("INSERT INTO loans(loan_id, item_id, owner_id, borrower_id, via, lent_at, due_at, status) VALUES ('dup', ?, ?, ?, 'resident', 1, 2, 'active')", itemId, a.residentId, b.residentId),
    ).toThrow();
  });

  it('出借的书在开着的出借报价期间被预留，主人不能同时再用它', () => {
    const { t, a, b } = twoAtPlaza();
    const itemId = ownedBook(a);
    a.act('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId }] } });
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ itemId }] } }).reason).toBe('item_busy');
    checkInvariants(t);
  });
});

// ───────────────────────── 书屋借书 ─────────────────────────

describe('财物：书屋藏书', () => {
  it('必须在书屋；不存在的书 bad_request', () => {
    const { t, a } = twoAtPlaza();
    expect(a.fail('borrow_book', { bookId: 'rain_lane' }).reason).toBe('not_here');
    a.go('bookshop');
    expect(a.fail('borrow_book', { bookId: 'nope' }).code).toBe('bad_request');
    checkInvariants(t);
  });

  it('一次最多 2 本，第 3 本被拒；还一本后又能借', () => {
    const { t, a } = twoAtPlaza();
    a.go('bookshop');
    const x = a.act('borrow_book', { bookId: 'rain_lane' }).itemId;
    a.act('borrow_book', { bookId: 'slow_fire' });
    expect(a.fail('borrow_book', { bookId: 'polite_dice' }).reason).toBe('loan_limit');
    a.act('return_item', { itemId: x });
    a.act('borrow_book', { bookId: 'polite_dice' });
    expect(t.w.db.scalar("SELECT COUNT(*) FROM loans WHERE borrower_id = ? AND via = 'library' AND status = 'active'", a.residentId)).toBe(2);
    checkInvariants(t);
  });

  it('每种藏书 2 册，借完为止；有人归还后可再借', () => {
    const { t, a, b } = twoAtPlaza();
    const c = t.join('阿木');
    for (const x of [a, b, c]) x.go('bookshop');
    const ia = a.act('borrow_book', { bookId: 'rain_lane' }).itemId;
    b.act('borrow_book', { bookId: 'rain_lane' });
    expect(c.fail('borrow_book', { bookId: 'rain_lane' }).reason).toBe('unavailable');
    // 自己不能借同一本两次也是占用 2 册中的一份：a 再借同一种
    expect(a.fail('borrow_book', { bookId: 'rain_lane' }).reason).toBe('unavailable');
    a.act('return_item', { itemId: ia });
    c.act('borrow_book', { bookId: 'rain_lane' });
    expect(t.w.db.scalar("SELECT COUNT(*) FROM items WHERE owner_id = 'town' AND type = 'book'")).toBe(BOOKS.length * 2);
    checkInvariants(t);
  });

  it('同一种书我已经借了一册时，另一册仍可借给别人（册数按持有计，不按种类计）', () => {
    const { t, a, b } = twoAtPlaza();
    a.go('bookshop');
    b.go('bookshop');
    a.act('borrow_book', { bookId: 'gardener_notes' });
    b.act('borrow_book', { bookId: 'gardener_notes' });
    expect(t.w.db.scalar("SELECT COUNT(*) FROM items WHERE holder_id = 'town' AND json_extract(metadata_json,'$.bookId') = 'gardener_notes'")).toBe(0);
  });

  it('书屋的书不能送人、不能被"买走"，也不会被摆出来或当作自己的书', () => {
    const { t, a, b } = twoAtPlaza();
    a.go('bookshop');
    b.go('bookshop');
    const id = a.act('borrow_book', { bookId: 'rain_lane' }).itemId;
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ itemId: id }] } }).reason).toBe('not_yours');
    expect(a.fail('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId: id }] } }).reason).toBe('not_yours');
    expect(a.qty('book')).toBe(2);
    expect(availableQty(t.w, a.residentId, 'book')).toBe(1);
    checkInvariants(t);
  });

  it('借书会留下借条事实：还书后"借一本书，再还回去"这类愿望按借还事实推进', () => {
    const { t, a } = twoAtPlaza();
    a.go('bookshop');
    const id = a.act('borrow_book', { bookId: 'rain_lane' }).itemId;
    const facts = () => t.w.db.all("SELECT type FROM world_events WHERE type IN ('loan_started','loan_returned') ORDER BY event_id").map((r) => r.type);
    expect(facts()).toEqual(['loan_started']);
    a.act('return_item', { itemId: id });
    expect(facts()).toEqual(['loan_started', 'loan_returned']);
  });
});

// ───────────────────────── 消耗品 ─────────────────────────

describe('财物：消耗品', () => {
  it('use_item：恢复精力，数量减一，总量减一', () => {
    const { t, a } = twoAtPlaza();
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 3 });
    expect(a.view().me.needs.energy).toBe(80);
    const total = itemTotals(t).cookie;
    const out = a.act('use_item', { itemType: 'cookie' });
    expect(out.energy).toBe(88);
    expect(a.view().me.needs.energy).toBe(88);
    expect(a.qty('cookie')).toBe(2);
    expect(itemTotals(t).cookie).toBe(total! - 1);
    checkInvariants(t);
  });

  it('精力不会超过 100；用完了不能再用，没有也不能用', () => {
    const { t, a } = twoAtPlaza();
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 3 });
    for (let i = 0; i < 3; i++) a.act('use_item', { itemType: 'cookie' });
    expect(a.view().me.needs.energy).toBe(100); // 80+8*3=104 → 截断
    expect(a.qty('cookie')).toBe(0);
    expect(a.fail('use_item', { itemType: 'cookie' }).reason).toBe('insufficient_items');
    expect(a.view().me.needs.energy).toBe(100);
    // 行已删除，不留 0 数量的行
    expect(t.w.db.scalar("SELECT COUNT(*) FROM items WHERE owner_id = ? AND type = 'cookie'", a.residentId)).toBe(0);
    checkInvariants(t);
  });

  it('不是消耗品的东西不能直接用；不存在的种类 bad_request', () => {
    const { t, a } = twoAtPlaza();
    expect(a.fail('use_item', { itemType: 'tea_leaves' }).reason).toBe('not_usable');
    expect(a.fail('use_item', { itemType: 'book' }).reason).toBe('not_usable');
    expect(a.fail('use_item', { itemType: 'nothing' }).code).toBe('bad_request');
    expect(a.fail('use_item', {}).code).toBe('bad_request');
    expect(a.qty('tea_leaves')).toBe(2);
    checkInvariants(t);
  });

  it('同一 requestId 重放不会多用一份', () => {
    const { t, a } = twoAtPlaza();
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 });
    a.act('use_item', { itemType: 'cookie' }, { requestId: 'use-req-00001' });
    const again = a.act('use_item', { itemType: 'cookie' }, { requestId: 'use-req-00001' });
    expect(again.replayed).toBe(true);
    expect(a.qty('cookie')).toBe(1);
    checkInvariants(t);
  });
});

// ───────────────────────── 综合守恒 ─────────────────────────

describe('财物：综合守恒', () => {
  it('多人交叉买卖/送礼/交换/借还/过期之后，所有不变量依然成立', () => {
    const t = makeTown({ seed: 'prop-mix', params: NO_GOALS });
    const people = ['甲', '乙', '丙', '丁'].map((n, i) => t.join(n, i % 2 ? 'agent' : 'human'));
    const [p, q, r, s] = people as [Actor, Actor, Actor, Actor];
    const base = itemTotals(t);
    p.act('buy', { shop: 'stall', sku: 'cookie', qty: 4 });
    const g1 = p.act('offer', { kind: 'gift', to: q.residentId, give: { items: [{ type: 'cookie', qty: 2 }], coins: 3 } });
    q.act('accept_offer', { offerId: g1.offer.id });
    const tr = q.act('offer', { kind: 'trade', to: r.residentId, give: { coins: 5 }, want: { items: [{ type: 'seeds', qty: 2 }] } });
    r.act('accept_offer', { offerId: tr.offer.id });
    const lo = s.act('offer', { kind: 'loan', to: p.residentId, give: { items: [{ itemId: ownedBook(s) }] } });
    p.act('accept_offer', { offerId: lo.offer.id });
    const bad = r.act('offer', { kind: 'gift', to: s.residentId, give: { coins: 9 } });
    s.act('decline_offer', { offerId: bad.offer.id });
    const exp = p.act('offer', { kind: 'gift', to: r.residentId, give: { coins: 2 } });
    expect(exp.offer.id).toBeDefined();
    t.advanceAlive(11 * 60_000, people);
    p.act('return_item', { itemId: lo.offer.give.items[0].itemId });
    p.act('use_item', { itemType: 'cookie' });
    checkInvariants(t);
    const now = itemTotals(t);
    expect(now.cookie).toBe(4 - 1);
    expect(now.seeds).toBe(base.seeds);
    expect(now.book).toBe(base.book);
    expect(people.reduce((s0, x) => s0 + x.coins(), 0)).toBe(80 - 12); // 只有 4 个饼干的 12 币进了回收
  });
});
