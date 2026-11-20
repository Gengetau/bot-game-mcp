/**
 * 故障用例 F1–F16 里属于引擎的部分（规格 6.2），用假内核客户端跑。
 * F13（下雨没伞不让出门）是内核在 T1 之前拦的，引擎没有对应的测试；F14（天气不可用）在 world.test.ts。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE,
  MAPPINGS,
  SHOPS,
  abortVisit,
  cityPrincipal,
  commitVisit,
  latestReconcile,
  ledger,
  prepareVisit,
  publicCityView,
  releaseVisit,
  requestReturn,
  runReconcile,
  visitAct,
} from '../../src/city/index.js';
import { COOKIE, HOUR, HOUSE_ENTRANCE, KISSA, MIN, makeCity, rejects, type CityTest } from './helpers.js';

const ledgerCount = (t: CityTest, like: string): number => t.c.db.scalar('SELECT COUNT(*) FROM ledger_transactions WHERE cause_key LIKE ?', like);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmpDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'city-test-'));
  dirs.push(d);
  return join(d, 'city.db');
};

describe('F1：每个写请求都重复发送两次', () => {
  it('返回原回执，账和物品不重复', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const purse = `acct:${t.residentOf('nia')}`;

    const prepare = k.prepareBody({ yen: 20_000, items: [COOKIE], to: KISSA });
    const p1 = prepareVisit(t.c, prepare);
    const p2 = prepareVisit(t.c, prepare);
    expect(p2).toEqual({ ...p1, replayed: true });

    const commit = k.commitBody();
    const c1 = commitVisit(t.c, k.visitId, commit);
    const c2 = commitVisit(t.c, k.visitId, commit);
    k.epoch = 1;
    expect(c2).toEqual({ ...c1, replayed: true });
    expect(t.balance(purse)).toBe(20_000);
    expect(ledgerCount(t, `visit:${k.visitId}:in`)).toBe(1);
    expect(t.c.db.scalar('SELECT COUNT(*) FROM items WHERE origin_ref IS NOT NULL')).toBe(1);
    expect(t.c.db.scalar('SELECT COUNT(*) FROM trips')).toBe(1);

    t.run(31 * MIN);
    const buy = { request_id: `${k.visitId}:d1:buy1`, domain_epoch: 1, action: { type: 'buy', sku: 'coffee' } };
    const a1 = visitAct(t.c, k.visitId, buy);
    const a2 = visitAct(t.c, k.visitId, buy);
    expect(a2).toEqual({ ...a1, replayed: true });
    expect(t.balance(purse)).toBe(20_000 - 200 - 450);
    expect(t.c.db.scalar("SELECT SUM(quantity) FROM items WHERE type = 'coffee'")).toBe(1);
    expect(k.records('purchase')).toHaveLength(2); // 电车一条、咖啡一条
    const drink = { request_id: `${k.visitId}:d1:drink1`, domain_epoch: 1, action: { type: 'consume', item: 'coffee' } };
    const d1 = visitAct(t.c, k.visitId, drink);
    expect(visitAct(t.c, k.visitId, drink)).toEqual({ ...d1, replayed: true });
    expect(k.records('body_effect').filter((e) => e.engine_kind === 'drank')).toHaveLength(1);

    const ret = { request_id: `${k.visitId}:d1:ret1`, reason: 'dinner' };
    const r1 = requestReturn(t.c, k.visitId, ret);
    const r2 = requestReturn(t.c, k.visitId, ret);
    expect(r1.state).toBe('returning');
    expect(r2).toEqual({ ...r1, replayed: true });
    expect(k.records('return_started')).toHaveLength(1);
    // 换一个请求号再要求一次：已经在回家路上，什么都不做
    expect(requestReturn(t.c, k.visitId, { request_id: `${k.visitId}:d1:ret2`, reason: 'dinner' }).payload).toEqual({ started: false });
    expect(t.c.db.scalar("SELECT COUNT(*) FROM trips WHERE purpose = 'return'")).toBe(1);

    t.run(31 * MIN);
    k.pull();
    const release = { request_id: `${k.visitId}:release`, settlement_id: k.settlement!.settlement_id, domain_epoch: 2 };
    const x1 = releaseVisit(t.c, k.visitId, release);
    const x2 = releaseVisit(t.c, k.visitId, release);
    expect(x1.state).toBe('closed');
    expect(x2).toEqual({ ...x1, replayed: true });
    expect(ledgerCount(t, `visit:${k.visitId}:out`)).toBe(1);
    expect(t.balance(purse)).toBe(0);
    expect(t.balance(BRIDGE)).toBe(-(200 + 450 + 200));
    expect(runReconcile(t.c, 'test').findings).toEqual([]);
  });

  it('外部 bot 的动作重发也只做一次', () => {
    const t = makeCity();
    const b = t.bot('小B');
    b.go('kumominato:muginohi');
    const first = b.act({ type: 'buy', sku: 'melon_pan' }, 'req-same-0001');
    const again = b.act({ type: 'buy', sku: 'melon_pan' }, 'req-same-0001');
    expect(again).toEqual({ ...first, replayed: true });
    expect(b.view().wallet.yen).toBe(200_000 - 230);
    rejects(() => b.act({ type: 'buy', sku: 'cream_bun' }, 'req-same-0001'), 'CONFLICT', 'request_conflict');
  });
});

describe('F2：同一个 request_id 换内容重发', () => {
  it('409，没有副作用', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const prepare = k.prepareBody({ yen: 20_000, to: KISSA });
    prepareVisit(t.c, prepare);
    rejects(() => prepareVisit(t.c, { ...prepare, carry: { yen: 30_000, items: [] } }), 'CONFLICT', 'request_conflict');
    expect(k.describe().carry_yen).toBe(20_000);

    const commit = k.commitBody();
    commitVisit(t.c, k.visitId, commit);
    k.epoch = 1;
    rejects(() => commitVisit(t.c, k.visitId, { ...commit, domain_epoch: 9 }), 'CONFLICT', 'request_conflict');
    expect(k.describe().domain_epoch).toBe(1);

    t.run(31 * MIN);
    const body = { request_id: `${k.visitId}:d1:x1`, domain_epoch: 1, action: { type: 'buy', sku: 'coffee' } };
    visitAct(t.c, k.visitId, body);
    rejects(() => visitAct(t.c, k.visitId, { ...body, action: { type: 'buy', sku: 'cheesecake' } }), 'CONFLICT', 'request_conflict');
    expect(k.view().items.map((i: any) => i.type)).toEqual(['coffee']);
    // 同一个请求号用在另一种操作上也一样
    rejects(() => requestReturn(t.c, k.visitId, { request_id: body.request_id, reason: 'x' }), 'CONFLICT', 'request_conflict');
    expect(k.describe().state).toBe('active');
  });

  it('payload_hash 和内容对不上直接拒绝', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const prepare = k.prepareBody({ yen: 100, to: KISSA });
    const e = rejects(() => prepareVisit(t.c, { ...prepare, payload_hash: 'deadbeef' }), 'BAD_REQUEST', 'payload_hash_mismatch');
    // 带上正确的哈希就能过
    expect(prepareVisit(t.c, { ...prepare, payload_hash: e.data!.expected }).state).toBe('prepared');
  });
});

describe('F3：prepare 前后内核崩溃', () => {
  it('prepare 之后 abort：城里什么都没有激活；之后的 commit 被拒', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    prepareVisit(t.c, k.prepareBody({ yen: 20_000, items: [COOKIE], to: KISSA }));
    expect(k.abort().state).toBe('aborted');
    expect(t.balance(BRIDGE)).toBe(0);
    expect(t.c.db.scalar('SELECT COUNT(*) FROM items')).toBe(0);
    rejects(() => k.commit(), 'CONFLICT', 'visit_aborted');
    // abort 可以重发
    expect(k.abort().replayed).toBe(true);
    // 取消之后可以重新出门（新的 visit_id）
    expect(k.depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' }).state).toBe('active');
  });

  it('prepare 根本没到引擎就 abort：迟到的 prepare 被拒', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const prepare = k.prepareBody({ yen: 20_000, to: KISSA });
    expect(abortVisit(t.c, k.visitId, { request_id: `${k.visitId}:abort` }).payload).toEqual({ known: false });
    rejects(() => prepareVisit(t.c, prepare), 'CONFLICT', 'visit_aborted');
    expect(k.describe()).toMatchObject({ state: 'aborted', known: false });
  });

  it('已经交接的访问不能 abort', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' });
    rejects(() => k.abort(), 'CONFLICT', 'already_committed');
  });
});

describe('F4：commit 已提交但回包丢了', () => {
  it('内核查询能看到已经 active 和 commit 的回执；重发不会二次入账', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    prepareVisit(t.c, k.prepareBody({ yen: 20_000, to: KISSA }));
    const commit = k.commitBody();
    const lost = commitVisit(t.c, k.visitId, commit); // 回包丢了
    const seen = k.describe();
    expect(seen.state).toBe('active');
    expect(seen.receipts.map((r: any) => r.op)).toEqual(['prepare', 'commit']);
    expect(seen.receipts[1].receipt_id).toBe(lost.receipt_id);
    // 同一个请求号重发
    expect(commitVisit(t.c, k.visitId, commit).receipt_id).toBe(lost.receipt_id);
    // 换了请求号、同一次交接（内核重启后请求号没存住）：指回原回执，不会再入账
    const again = commitVisit(t.c, k.visitId, { ...commit, request_id: `${k.visitId}:commit-again` });
    expect(again.payload.original_receipt_id).toBe(lost.receipt_id);
    expect(t.balance(`acct:${t.residentOf('nia')}`)).toBe(20_000);
    expect(ledgerCount(t, 'visit:%:in')).toBe(1);
    // 同一个 visit 换一个 transfer_id：不是同一次交接
    rejects(() => commitVisit(t.c, k.visitId, { request_id: `${k.visitId}:commit-other`, transfer_id: 'tr-other-0001', domain_epoch: 1 }), 'CONFLICT', 'already_committed');
  });
});

describe('F5 / F7：适配器掉线', () => {
  it('F5：买到东西后掉线，到 return_by 自动回家，结算清单里有这件东西', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 20_000, to: KISSA, returnIn: 3 * HOUR });
    t.run(31 * MIN);
    k.act({ type: 'buy', sku: 'coffee_beans' });
    k.act({ type: 'buy', sku: 'milk_tea' });
    // 之后适配器再没有任何调用
    t.run(3 * HOUR);
    expect(k.describe().state).toBe('settled');
    const started = t.outbox(k.visitId).find((r) => r.kind === 'return_started')!;
    expect(started.payload.reason).toBe('return_by');
    // 动身时刻 = return_by − 回家耗时 31 分钟 − 余量 5 分钟；到家早于 return_by
    expect(started.occurred_at_ms).toBe(k.describe().return_by_ms - 36 * MIN);
    expect(k.describe().times.settled_at_ms).toBeLessThanOrEqual(k.describe().return_by_ms);
    k.pull();
    // 咖啡豆在映射表里（只回家）：回家变成内核的一包咖啡；没喝完的现点奶茶（carry_home: false）按 disposed 清理，访问正常 closed
    expect(k.settlement!.items.map((i) => [i.type, i.qty, i.fate, i.kernel ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ['coffee_beans', 1, 'back', { kind: 'food', item: 'coffee' }],
      ['milk_tea', 1, 'disposed', null],
    ]);
    expect(k.settlement!.purse_final_yen).toBe(20_000 - 200 - 900 - 500 - 200);
    expect(k.release().state).toBe('closed');
    expect(t.c.db.get("SELECT state FROM items WHERE type = 'coffee_beans'")!.state).toBe('returned');
    expect(t.c.db.get("SELECT state FROM items WHERE type = 'milk_tea'")!.state).toBe('disposed');
    expect(k.view().items).toEqual([]);
  });

  it('F7：乘车途中离线，电车照常到站，到站记录留在 outbox 里等着', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const start = t.clock.t;
    k.depart({ yen: 20_000, to: KISSA });
    expect(k.pull().map((r) => r.kind)).toEqual(['visit_progress']);
    t.run(2 * HOUR); // 适配器离线两小时
    const fresh = k.pull();
    expect(fresh.filter((r) => r.kind === 'visit_progress').map((r) => [r.payload.phase, (r.occurred_at_ms - start) / MIN])).toEqual([
      ['arrived_station', 12],
      ['boarded', 12],
      ['arrived_station', 25],
      ['arrived_place', 31],
    ]);
    expect(k.pull()).toEqual([]); // 再拉一次没有重复
    expect(k.view().location).toEqual({ place: KISSA });
  });
});

describe('F6：带出的零食', () => {
  it('在城里吃掉：fate=consumed，身体效果只有一条', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 5000, items: [COOKIE], to: 'hiyorizaka:ekimae-plaza' });
    t.run(14 * MIN);
    const eat = k.act({ type: 'consume', item: 'cookie' });
    rejects(() => k.act({ type: 'consume', item: 'cookie' }), 'PRECONDITION_FAILED', 'not_enough_items');
    k.act({ type: 'go_home' });
    t.run(14 * MIN);
    k.pull();
    expect(k.settlement!.items).toEqual([expect.objectContaining({ origin_ref: 'res:cookie:1', type: 'cookie', qty: 1, fate: 'consumed' })]);
    expect(k.settlement!.consumed).toEqual([{ type: 'cookie', qty: 1, effect_id: eat.payload.effect_id, origin_ref: 'res:cookie:1' }]);
    const ate = k.records('body_effect').filter((e) => e.engine_kind === 'ate');
    expect(ate).toEqual([expect.objectContaining({ effect_id: eat.payload.effect_id, kernel_effect: 'snack', engine_type: 'cookie' })]);
    // 内核重拉一遍 outbox：按 effect_id 去重，只应用一次
    k.cursor = 0;
    k.pull();
    expect(k.bodyApplied.get(eat.payload.effect_id as string)).toBe(1);
    expect(k.release().state).toBe('closed');
  });

  it('送给 B：fate=given，东西到了 B 手上', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const b = t.bot('小B', { entry: 'ryokogai:station' });
    b.go(KISSA);
    k.depart({ yen: 5000, items: [COOKIE], to: KISSA });
    t.run(31 * MIN);
    const give = k.act({ type: 'give', to: b.id, item: 'cookie' });
    expect(give.payload).toMatchObject({ status: 'completed', given: { type: 'cookie', qty: 1 } });
    expect(b.view().items).toEqual([expect.objectContaining({ type: 'cookie', qty: 1 })]);
    expect(b.events().filter((e) => e.type === 'gift_received')).toHaveLength(1);
    k.act({ type: 'go_home' });
    t.run(31 * MIN);
    k.pull();
    expect(k.settlement!.items).toEqual([expect.objectContaining({ origin_ref: 'res:cookie:1', fate: 'given' })]);
    expect(k.settlement!.given).toEqual([{ type: 'cookie', qty: 1, origin_ref: 'res:cookie:1', to: '小B' }]);
    expect(k.records('body_effect').filter((e) => e.engine_kind === 'ate')).toEqual([]);
    expect(k.release().state).toBe('closed');
    expect(runReconcile(t.c, 'test').findings).toEqual([]);
  });

  it('B 送她的东西：映射表里有的能带回家', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const b = t.bot('小B');
    b.go('kumominato:muginohi');
    b.act({ type: 'buy', sku: 'cookie' });
    b.act({ type: 'buy', sku: 'melon_pan' });
    k.depart({ yen: 5000, to: 'kumominato:muginohi' });
    t.run(40 * MIN);
    b.act({ type: 'give', to: t.residentOf('nia'), item: 'cookie' });
    b.act({ type: 'give', to: t.residentOf('nia'), item: 'melon_pan' });
    expect(k.records('decision_wake').filter((w) => w.reason === 'gift_received')).toHaveLength(2);
    k.act({ type: 'go_home' });
    t.run(40 * MIN);
    k.pull();
    expect(k.settlement!.items.map((i) => [i.type, i.fate, i.kernel ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ['cookie', 'back', { kind: 'food', item: 'cookie' }],
      ['melon_pan', 'back', { kind: 'food', item: 'bread' }],
    ]);
  });
});

describe('F8：旧的动作权代次', () => {
  it('旧适配器用旧代次、回家后的旧适配器，都得到 STALE_DOMAIN_EPOCH', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    // 第一次出门回家（代次 1 → 2）
    k.depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' });
    const firstVisit = k.visitId;
    t.run(14 * MIN);
    rejects(() => visitAct(t.c, k.visitId, { request_id: 'old-adapter-0001', domain_epoch: 0, action: { type: 'say', text: '我是旧的' } }), 'STALE_DOMAIN_EPOCH');
    k.act({ type: 'go_home' });
    t.run(14 * MIN);
    // 交回时代次必须是新的
    k.pull();
    rejects(() => releaseVisit(t.c, k.visitId, { request_id: 'rel-stale-0001', settlement_id: k.settlement!.settlement_id, domain_epoch: 1 }), 'STALE_DOMAIN_EPOCH');
    k.release();
    rejects(() => visitAct(t.c, firstVisit, { request_id: 'old-adapter-0002', domain_epoch: 1, action: { type: 'say', text: '我还在城里吗' } }), 'STALE_DOMAIN_EPOCH');
    // 第二次出门：代次必须比见过的都大
    prepareVisit(t.c, k.prepareBody({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' }));
    rejects(() => commitVisit(t.c, k.visitId, { request_id: `${k.visitId}:commit-old`, transfer_id: `tr-${k.visitId}`, domain_epoch: 2 }), 'STALE_DOMAIN_EPOCH');
    expect(k.commit().payload.domain_epoch).toBe(3);
    // 上一次访问的代次在新访问里也不行
    rejects(() => visitAct(t.c, k.visitId, { request_id: 'old-adapter-0003', domain_epoch: 1, action: { type: 'say', text: '旧代次' } }), 'STALE_DOMAIN_EPOCH');
  });
});

describe('F9：一笔购买结果未知时到了回家时间', () => {
  it('她照常回家；钱锁着；访问进 reconcile；对账报告里有', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const purse = `acct:${t.residentOf('nia')}`;
    k.depart({ yen: 20_000, to: KISSA, returnIn: 2 * HOUR });
    t.run(31 * MIN);
    t.c.failpoints.purchaseUnknown = () => true;
    const buy = k.act({ type: 'buy', sku: 'cheesecake' });
    expect(buy.payload).toMatchObject({ status: 'pending', reason: 'outcome_unknown', held_yen: 520 });
    t.c.failpoints = {};
    expect(k.view().wallet).toMatchObject({ yen: 19_800, held_yen: 520, spendable_yen: 19_800 - 520 - 200 });
    expect(k.view().items).toEqual([]);
    t.run(2 * HOUR); // 到点自动回家
    k.pull();
    const s = k.settlement!;
    expect(s.pending).toEqual([{ order_id: buy.payload.order_id, what: '芝士蛋糕', yen: 520, place: KISSA }]);
    // 锁住的钱不带回家
    expect(s.purse_final_yen).toBe(20_000 - 400 - 520);
    expect(k.release().state).toBe('reconcile');
    expect(t.c.db.get('SELECT balance, held FROM accounts WHERE account_id = ?', purse)).toMatchObject({ balance: 520, held: 520 });
    const report = latestReconcile(t.c, 1)[0]!;
    expect(report.trigger).toBe('visit_closed');
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([{ level: 'info', code: 'visit_needs_attention', detail: { visit_id: k.visitId, pending_orders: 1, locker_items: 0 } }]);
    // 她的钱没有多出来：家里少了带出的减带回的，差额里包含锁在城里的那一笔
    expect(k.homeYen + t.balance(purse)).toBe(38_900 - 400);
    // reconcile 状态不挡下一次出门
    expect(k.depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' }).state).toBe('active');
  });
});

describe('F10：active 期间引擎停机，期间过了 return_by', () => {
  it('恢复后立即排回程并正常结算；车费不重复扣', () => {
    const dbPath = tmpDb();
    const t1 = makeCity({ dbPath });
    const k1 = t1.kernel('nia');
    k1.depart({ yen: 20_000, to: KISSA, returnIn: 2 * HOUR });
    const returnBy = k1.describe().return_by_ms;
    t1.run(40 * MIN);
    k1.act({ type: 'buy', sku: 'coffee' });
    k1.act({ type: 'consume', item: 'coffee' });
    t1.c.close();
    // 停机 90 分钟：这期间本该动身回家（T+84 分），return_by（T+120 分）也过了
    t1.clock.advance(90 * MIN);
    expect(t1.clock.t).toBeGreaterThan(returnBy);

    const t2 = makeCity({ dbPath, clock: t1.clock });
    const k2 = t2.kernel('nia');
    k2.visitId = k1.visitId;
    k2.epoch = k1.epoch;
    expect(k2.describe().state).toBe('returning');
    expect(t2.outbox(k2.visitId).find((r) => r.kind === 'return_started')!.occurred_at_ms).toBe(t2.clock.t);
    t2.run(31 * MIN);
    expect(k2.describe().state).toBe('settled');
    k2.pull();
    expect(k2.settlement!.purse_final_yen).toBe(20_000 - 200 - 450 - 200);
    expect(ledgerCount(t2, 'trip:%')).toBe(2);
    expect(k2.release().state).toBe('closed');
    expect(runReconcile(t2.c, 'test').findings).toEqual([]);
    t2.c.close();
  });

  it('停机时在路上的电车：重启后按原定时刻到站，每段只结算一次', () => {
    const dbPath = tmpDb();
    const t1 = makeCity({ dbPath });
    const k1 = t1.kernel('nia');
    const start = t1.clock.t;
    k1.depart({ yen: 20_000, to: KISSA });
    t1.run(5 * MIN);
    t1.c.close();
    t1.clock.advance(60 * MIN);

    const t2 = makeCity({ dbPath, clock: t1.clock });
    const k2 = t2.kernel('nia');
    k2.visitId = k1.visitId;
    k2.epoch = 1;
    expect(k2.view().location).toEqual({ place: KISSA });
    expect(t2.outbox(k2.visitId).filter((r) => r.kind === 'visit_progress').map((r) => (r.occurred_at_ms - start) / MIN)).toEqual([0, 12, 12, 25, 31]);
    expect(ledgerCount(t2, 'trip:%')).toBe(1);
    expect(k2.view().wallet.yen).toBe(19_800);
    // 再重启一次也不会补出第二份
    t2.c.close();
    const t3 = makeCity({ dbPath, clock: t1.clock });
    expect(ledgerCount(t3, 'trip:%')).toBe(1);
    expect(t3.outbox(k1.visitId).filter((r) => r.kind === 'visit_progress')).toHaveLength(5);
    t3.c.close();
  });
});

describe('F11：settled 之后内核重启', () => {
  it('从游标拉到 visit_settled，只应用一次，然后 release', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 3000, to: 'hiyorizaka:ekimae-plaza' });
    t.run(14 * MIN);
    k.act({ type: 'go_home' });
    t.run(14 * MIN);
    // 内核这时停了；重启后从自己存的游标（这里是 0）重新拉
    k.pull();
    k.cursor = 0;
    k.pull();
    expect([...k.applied.values()].filter((r) => r.kind === 'visit_settled')).toHaveLength(1);
    // 结算清单能从访问状态里再取到，内容不变
    expect(k.describe().settlement).toEqual(k.settlement);
    const first = k.release();
    expect(first.state).toBe('closed');
    // release 的回包丢了、内核又重启：同一个请求号重发拿到原回执；换请求号则明确告诉它已经交回过了
    const sid = (first.payload.settlement_id as string) ?? '';
    expect(releaseVisit(t.c, k.visitId, { request_id: `${k.visitId}:release`, settlement_id: sid, domain_epoch: k.epoch }).receipt_id).toBe(first.receipt_id);
    rejects(() => releaseVisit(t.c, k.visitId, { request_id: `${k.visitId}:release-2`, settlement_id: sid, domain_epoch: k.epoch + 1 }), 'CONFLICT', 'already_released');
    expect(ledgerCount(t, 'visit:%:out')).toBe(1);
    expect(k.homeYen).toBe(38_900);
  });

  it('settlement_id 不对、还没到家，release 都被拒', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 3000, to: 'hiyorizaka:ekimae-plaza' });
    rejects(() => releaseVisit(t.c, k.visitId, { request_id: 'rel-early-0001', settlement_id: 'x', domain_epoch: 2 }), 'VISIT_NOT_ACTIVE', 'not_settled');
    t.run(14 * MIN);
    k.act({ type: 'go_home' });
    t.run(14 * MIN);
    rejects(() => releaseVisit(t.c, k.visitId, { request_id: 'rel-wrong-0001', settlement_id: 'set_wrong', domain_epoch: 2 }), 'CONFLICT', 'settlement_mismatch');
    expect(k.describe().state).toBe('settled');
  });
});

describe('F12：随身钱包只剩回程车费', () => {
  it('再消费被拒，原因明确；她仍能回家', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 650, to: KISSA });
    t.run(31 * MIN);
    expect(k.view().wallet).toMatchObject({ yen: 450, spendable_yen: 250, return_reserve_yen: 200 });
    // 账面上够买一杯咖啡，但买了就没有回程车费
    const e = rejects(() => k.act({ type: 'buy', sku: 'coffee' }), 'PRECONDITION_FAILED', 'return_fare_reserved');
    expect(e.data).toMatchObject({ price_yen: 450, return_reserve_yen: 200, spendable_yen: 250 });
    // 去云港要 ¥200，到了那里回家要 ¥260：也不行
    rejects(() => k.act({ type: 'travel', to: 'kumominato:station' }), 'PRECONDITION_FAILED', 'return_fare_reserved');
    // 真的不够就是 insufficient_funds
    rejects(() => k.act({ type: 'buy', sku: 'coffee_beans' }), 'PRECONDITION_FAILED', 'insufficient_funds');
    expect(k.view().wallet.yen).toBe(450);
    k.act({ type: 'go_home' });
    t.run(31 * MIN);
    k.pull();
    expect(k.settlement!.purse_final_yen).toBe(250);
    expect(k.release().state).toBe('closed');
  });

  it('带的钱连来回车费都不够：留在门口，由她自己决定；直接回家立即结算', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const commit = k.depart({ yen: 300, to: KISSA });
    expect(commit.state).toBe('active');
    expect(commit.payload).toMatchObject({ trip: null, plan_blocked: 'return_fare_reserved' });
    expect(k.records('decision_wake')).toEqual([expect.objectContaining({ reason: 'plan_blocked', why: 'return_fare_reserved', destination: KISSA })]);
    expect(k.view().location).toEqual({ place: HOUSE_ENTRANCE });
    // 不花钱的地方还是能去（河岸走得到）
    expect(k.view().here.exits.find((x: any) => x.id === 'hiyorizaka:fukogawa-riverbank')).toMatchObject({ minutes: 9, fare_yen: 0 });
    expect(k.act({ type: 'go_home' }).state).toBe('settled');
    k.pull();
    expect(k.settlement).toMatchObject({ purse_final_yen: 300, items: [] });
    expect(k.release().state).toBe('closed');
  });
});

describe('F15：外部 bot 的动作上限', () => {
  it('每小时第 61 次被限速，带 retryAfterMs；室友不受影响', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const b = t.bot('小B', { entry: 'ryokogai:station' });
    k.depart({ yen: 5000, to: 'ryokogai:station' });
    t.run(25 * MIN);
    for (let i = 0; i < 60; i++) {
      t.clock.advance(11_000); // 聊天另有每分钟 6 句的上限
      b.act({ type: 'say', text: `第 ${i + 1} 句` });
    }
    t.clock.advance(11_000);
    const e = rejects(() => b.act({ type: 'say', text: '第 61 句' }), 'RATE_LIMITED', 'act');
    expect(e.data!.retryAfterMs).toBeGreaterThan(40 * MIN);
    expect(e.data!.retryAfterMs).toBeLessThanOrEqual(HOUR);
    // 她照常能做事
    expect(k.act({ type: 'say', text: '我不受影响' }).payload.status).toBe('completed');
    // 过了窗口 bot 又能动
    t.clock.advance(e.data!.retryAfterMs as number);
    expect(b.act({ type: 'say', text: '又能说了' }).status).toBe('completed');
  });

  it('失败的动作也算一次：不断发做不成的动作同样会被限速', () => {
    const t = makeCity();
    const b = t.bot('小B', { entry: 'ryokogai:station' });
    for (let i = 0; i < 60; i++) rejects(() => b.act({ type: 'buy', sku: 'nothing' }), 'PRECONDITION_FAILED', 'no_such_good');
    rejects(() => b.act({ type: 'buy', sku: 'nothing' }), 'RATE_LIMITED', 'act');
    // 被限速的那一次本身不再累计；重放不算
    expect(t.c.db.scalar("SELECT COUNT(*) FROM rate_log WHERE bucket = 'act'")).toBe(60);
    expect(t.balance(`acct:${b.id}`)).toBe(200_000);
  });

  it('外部 bot 的报错里没有 go_home，也没有「小屋」', () => {
    const t = makeCity();
    const b = t.bot('小B');
    for (const type of ['go_home', 'fly']) {
      const e = rejects(() => b.act({ type }), 'BAD_REQUEST', 'unknown_action');
      expect(e.message.includes('go_home') || e.message.includes('小屋')).toBe(false);
    }
    // 室友那边照常列出 go_home
    const k = t.kernel('nia');
    k.depart({ yen: 3000, to: 'hiyorizaka:ekimae-plaza' });
    expect(rejects(() => k.act({ type: 'fly' }), 'BAD_REQUEST', 'unknown_action').message).toContain('go_home');
  });

  it('聊天每分钟 6 句', () => {
    const t = makeCity();
    const b = t.bot('小B');
    for (let i = 0; i < 6; i++) b.act({ type: 'say', text: `话 ${i}` });
    rejects(() => b.act({ type: 'say', text: '第七句' }), 'RATE_LIMITED', 'chat');
  });

  it('同时在场的外部 bot 上限；首次进城的钱每个主体只发一次', () => {
    const t = makeCity({ params: { maxPresentExternal: 2 } });
    const a = t.bot('甲');
    t.bot('乙');
    rejects(() => t.bot('丙'), 'PRECONDITION_FAILED', 'city_full');
    expect(a.view().wallet.yen).toBe(200_000);
    // 离开再回来：不会再发一次
    a.act({ type: 'travel', to: 'kumominato:southern-terrace' });
    t.run(10 * MIN);
    expect(t.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'grant'")).toBe(2);
    expect(publicCityView(t.c)).toBeTruthy();
  });
});

describe('F16：室友在 QQ 侧的密钥不能直接进城', () => {
  it('ENTRY_VIA_HOME_ONLY，而且什么都没写', () => {
    const t = makeCity();
    const before = t.c.db.scalar('SELECT COUNT(*) FROM principals');
    rejects(() => cityPrincipal(t.c, { id: '3001', name: '妮娅' }, {}), 'ENTRY_VIA_HOME_ONLY');
    // 自己认领同一个号码（open 模式）也一样
    rejects(() => cityPrincipal(t.c, { id: '3001', name: '冒名' }, { selfClaimed: true }), 'ENTRY_VIA_HOME_ONLY');
    expect(t.c.db.scalar('SELECT COUNT(*) FROM principals')).toBe(before);
  });
});

describe('出门前的检查', () => {
  it('协议版本、映射表版本、不认识的室友、映射表外的物品、不存在的目的地', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const base = k.prepareBody({ yen: 1000, to: KISSA });
    rejects(() => prepareVisit(t.c, { ...base, protocol: 'city-bridge/2' }), 'VERSION_MISMATCH', 'protocol');
    rejects(() => prepareVisit(t.c, { ...base, mappings_version: MAPPINGS.version + 1 }), 'VERSION_MISMATCH', 'mappings_version');
    rejects(() => prepareVisit(t.c, { ...base, actor_id: 'nobody' }), 'NOT_FOUND', 'unknown_actor');
    rejects(() => prepareVisit(t.c, { ...base, carry: { yen: 1000, items: [{ ref: 'res:sword:1', kernel: { kind: 'tool', item: 'sword' }, qty: 1 }] } }), 'PRECONDITION_FAILED', 'item_not_mapped');
    rejects(() => prepareVisit(t.c, { ...base, plan: { ...(base.plan as object), destination: 'mars:base' } }), 'PRECONDITION_FAILED', 'no_such_place');
    // 小屋门口不是能去的目的地
    rejects(() => prepareVisit(t.c, { ...base, plan: { ...(base.plan as object), destination: HOUSE_ENTRANCE } }), 'PRECONDITION_FAILED', 'no_such_place');
    rejects(() => prepareVisit(t.c, { ...base, carry: { yen: -5, items: [] } }), 'BAD_REQUEST');
    // 失败的请求不留回执：改对了可以用同一个请求号
    expect(prepareVisit(t.c, base).state).toBe('prepared');
    // 同一位室友同一时刻只有一次访问
    const other = t.kernel('nia');
    rejects(() => prepareVisit(t.c, other.prepareBody({ yen: 1, to: KISSA, visitId: 'v-nia-other' })), 'CONFLICT', 'visit_open');
    // 另一位室友不受影响
    expect(t.kernel('claire').depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' }).state).toBe('active');
  });
});

describe('备份', () => {
  it('每个世界日一份一致备份，放在数据库旁边的 backups/ 下；同一天不重复；backupKeep=0 不备份', () => {
    const dbPath = tmpDb();
    const t = makeCity({ dbPath });
    const k = t.kernel('nia');
    k.depart({ yen: 3000, to: 'hiyorizaka:ekimae-plaza' });
    const dir = join(dirname(dbPath), 'backups');
    t.c.tick();
    expect(readdirSync(dir)).toEqual(['city-2026-11-17.db']);
    t.c.tick();
    expect(readdirSync(dir)).toHaveLength(1);
    t.clock.advance(24 * HOUR);
    t.c.tick();
    expect(readdirSync(dir).sort()).toEqual(['city-2026-11-17.db', 'city-2026-11-18.db']);
    t.c.close();

    const off = makeCity({ dbPath: tmpDb(), params: { backupKeep: 0 } });
    off.c.tick();
    expect(existsSync(join(dirname(off.c.db.path), 'backups'))).toBe(false);
    off.c.close();
  });
});

describe('兜底', () => {
  it('prepare 之后内核再也没来：到最晚回家时刻自动作废，不挡下一次出门；迟到的 commit 得到 409', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const first = k.prepareBody({ yen: 5000, to: KISSA, returnIn: 2 * HOUR });
    prepareVisit(t.c, first);
    const stuck = k.visitId;
    // 还没过期：同一位室友不能再 prepare
    rejects(() => prepareVisit(t.c, k.prepareBody({ yen: 5000, to: KISSA })), 'CONFLICT', 'visit_open');
    t.run(2 * HOUR);
    expect(t.c.db.get('SELECT state, return_reason FROM visits WHERE visit_id = ?', stuck)).toEqual({ state: 'aborted', return_reason: 'expired' });
    rejects(() => commitVisit(t.c, stuck, { request_id: `${stuck}:commit`, transfer_id: `tr-${stuck}`, domain_epoch: 1 }), 'CONFLICT', 'visit_aborted');
    // 钱和物品没动过
    expect(t.balance(BRIDGE)).toBe(0);
    // 下一次出门照常
    expect(k.depart({ yen: 5000, to: 'hiyorizaka:ekimae-plaza' }).state).toBe('active');
    expect(runReconcile(t.c, 'test').findings).toEqual([]);
  });

  it('已经交接的访问不受这个过期作业影响', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 5000, to: 'hiyorizaka:ekimae-plaza', returnIn: 2 * HOUR });
    t.run(3 * HOUR);
    expect(k.describe().state).toBe('settled');
  });

  it('到站、到点回家这两类作业不会被搁置：连续失败之后退避着重试，修好了就接上；对账会报', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 5000, to: 'hiyorizaka:ekimae-plaza' });
    const real = t.c.jobHandlers.get('trip_leg')!;
    t.c.jobHandlers.set('trip_leg', () => {
      throw new Error('模拟的故障');
    });
    t.clock.advance(15 * MIN);
    for (let i = 0; i < 6; i++) t.c.runDue();
    const job = t.c.db.get("SELECT status, attempts, due_at FROM scheduled_jobs WHERE kind = 'trip_leg' AND status = 'pending'")!;
    expect(job).toMatchObject({ status: 'pending', attempts: 5 });
    expect(Number(job.due_at)).toBe(t.clock.t + MIN);
    expect(runReconcile(t.c, 'test').findings.map((f) => f.code)).toContain('stuck_jobs');
    // 别的作业类型照旧搁置
    t.c.commit(() => t.c.schedule('no_such_kind', 'x:1', t.clock.t));
    for (let i = 0; i < 6; i++) t.c.runDue();
    expect(t.c.db.get("SELECT status FROM scheduled_jobs WHERE kind = 'no_such_kind'")).toEqual({ status: 'failed' });
    t.c.db.run("DELETE FROM scheduled_jobs WHERE kind = 'no_such_kind'");
    // 修好之后接上，她到了
    t.c.jobHandlers.set('trip_leg', real);
    t.run(2 * MIN);
    expect(k.view().location).toEqual({ place: 'hiyorizaka:ekimae-plaza' });
    expect(runReconcile(t.c, 'test').findings).toEqual([]);
  });

  it('账本：钱不够的那一笔不占原因键', () => {
    const t = makeCity();
    const b = t.bot('小B');
    const acct = `acct:${b.id}`;
    rejects(() => t.c.commit(() => {
      try {
        ledger(t.c, 'test:once', 'purchase', '买不起', [[acct, -999_999], [SHOPS, 999_999]]);
      } catch (e) {
        expect(t.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = 'test:once'")).toBe(0);
        throw e;
      }
    }), 'PRECONDITION_FAILED', 'insufficient_funds');
    expect(t.c.commit(() => ledger(t.c, 'test:once', 'purchase', '买得起', [[acct, -100], [SHOPS, 100]]))).toBe(true);
    expect(t.balance(acct)).toBe(199_900);
  });
});
