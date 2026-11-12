/**
 * 栖灯镇故障注入：随机合法动作 + 随机在提交前/提交后崩溃 + 丢弃实例重开数据库 + 用原 requestId 重试，
 * 每轮之后检查世界不变量。有违例就打印细节并以非零码退出。
 *
 *   npx tsx scripts/world-recovery.ts [--rounds 200] [--seed 1] [--residents 8] [--quiet]
 *
 * 做法：
 *  - 真实文件数据库放在 os.tmpdir() 下的临时目录，结束（含异常退出）时清理。
 *  - 时间是自己推进的假时钟；随机只来自固定种子的 SeededRng，同样的种子得到同样的过程。
 *  - 崩溃有两种：before_commit（事务里抛错，回滚，像进程在提交前被杀）和 after_commit（提交成功但响应丢失）。
 *    崩溃后「进程被杀」：不做正常关闭、不写 last_alive_at，直接关掉数据库句柄，用同一个文件重新创建 WorldService。
 *  - 重试用原来的 requestId：before_commit 的重试必须是全新执行（没有 replayed），
 *    after_commit 的重试必须是 replayed 且不重复结算。
 *  - 世界规则本身的拒绝（钱不够、不在同一处……）是正常的，不算违例。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SeededRng, WorldError, createRegistry, createWorld, enterWorld, agentPrincipal, townHeartbeat, town, type WorldService } from '../packages/engine/src/index.js';

const { values: args } = parseArgs({
  options: {
    rounds: { type: 'string', default: '200' },
    seed: { type: 'string', default: '1' },
    residents: { type: 'string', default: '8' },
    quiet: { type: 'boolean', default: false },
  },
});
const ROUNDS = Math.max(1, Number(args.rounds));
const SEED = String(args.seed);
const RESIDENTS = Math.max(2, Math.min(30, Number(args.residents)));
if (!Number.isFinite(ROUNDS)) throw new Error('--rounds 需要是数字');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ───────────────────────── 环境 ─────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'town-recovery-'));
const dbPath = join(dir, 'town.db');
const cleanup = () => rmSync(dir, { recursive: true, force: true });
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130));

const clock = { t: Date.UTC(2024, 5, 3, 1, 0, 0) };
const rng = new SeededRng(`recovery:${SEED}`);
const pick = <T>(xs: readonly T[]): T => xs[rng.int(xs.length)]!;
const chance = (p: number) => rng.int(1_000_000) < p * 1_000_000;

let opens = 0;
function openWorld(): WorldService {
  const w = createWorld({
    dbPath,
    registry: createRegistry({}),
    now: () => clock.t,
    // 每次重开用不同的编号流（和生产一样不会撞号）；动作选择用上面的 rng，互不影响
    rng: new SeededRng(`ids:${SEED}:${++opens}`),
    seed: `game:${SEED}`,
    log: (m) => {
      if (!args.quiet && /搁置|出错|失败/.test(m)) console.log(`   [世界日志] ${m}`);
    },
    devLogin: true,
  });
  w.startSync();
  return w;
}

let w = openWorld();

interface Who {
  name: string;
  principalId: string;
  clientId: string;
  residentId: string;
}
const who: Who[] = [];

function enterAll(): void {
  for (const x of who) enterWorld(w, { principalId: x.principalId, clientId: x.clientId }, { clientKind: 'mcp' });
}

for (let i = 0; i < RESIDENTS; i++) {
  const name = `居民${i + 1}`;
  const p = agentPrincipal(w, { id: `9${String(i).padStart(3, '0')}`, name });
  const out = enterWorld(w, { principalId: p.principal_id, clientId: `mcp:script-${i}` }, { clientKind: 'mcp', profile: { name } });
  who.push({ name, principalId: p.principal_id, clientId: `mcp:script-${i}`, residentId: out.enter.residentId });
}

// ───────────────────────── 统计与违例 ─────────────────────────

const stats = { rounds: 0, commands: 0, executed: 0, rejected: 0, injected: { before_commit: 0, after_commit: 0 }, replays: 0, reopens: 0, longOutages: 0, checks: 0, retriesRejected: 0 };
const executedByType = new Map<string, number>();
const violations: string[] = [];
const violate = (round: number, msg: string) => {
  violations.push(`第 ${round} 轮：${msg}`);
  if (violations.length <= 30) console.log(`   违例：第 ${round} 轮：${msg}`);
};
const check = (round: number, ok: boolean, msg: string | (() => string)) => {
  stats.checks++;
  if (!ok) violate(round, typeof msg === 'function' ? msg() : msg);
};

// 模型：只靠「已执行（有回执）的命令」推算出来的期望值
const expectedUnits = new Map<string, number>();
let expectedSink = 0;
const buyRequests: { requestId: string; residentId: string; cost: number; round: number }[] = [];
const acceptRequests: { requestId: string; offerId: string; residentId: string; round: number }[] = [];
const bump = (type: string, d: number) => expectedUnits.set(type, (expectedUnits.get(type) ?? 0) + d);

for (const x of who) for (const k of [{ type: 'tea_leaves', qty: 2 }, { type: 'vegetables', qty: 2 }, { type: 'seeds', qty: 2 }, { type: 'book', qty: 1 }]) bump(k.type, k.qty); // 新居民的物资：茶叶、菜、种子各 2，外加一本书

// ───────────────────────── 动作 ─────────────────────────

interface Planned {
  actor: Who;
  requestId: string;
  action: { type: string; [k: string]: unknown };
  /** 执行成功后对模型的影响 */
  onExecuted?: () => void;
}

const PLACES = ['plaza', 'tea_house', 'bookshop', 'kitchen', 'garden', 'arcade', 'street_east', 'street_west'];
const SHOPS = town.townContent.SHOPS;
let reqSeq = 0;
const newRequestId = (round: number) => `rec-${SEED}-${round}-${++reqSeq}`;

function planAction(round: number): Planned {
  // 转账类动作要多测：有开着的报价时，大概率让收件人当场处理（接受为主）
  const open = w.db.all("SELECT offer_id, to_id FROM offers WHERE status = 'open'");
  const forced = open.length && chance(0.7) ? pick(open) : null;
  const actor = forced ? who.find((x) => x.residentId === forced.to_id)! : pick(who);
  const r = w.mustResident(actor.residentId);
  const requestId = newRequestId(round);
  const kind = forced ? pick(['accept', 'accept', 'accept', 'decline']) : pick(['speak', 'speak', 'move', 'move', 'buy', 'buy', 'offer', 'offer', 'accept', 'accept', 'decline', 'cancel', 'letter', 'use', 'profile', 'invite']);
  const here = r.move ? null : r.location_id;
  const others = who.filter((o) => o !== actor);
  switch (kind) {
    case 'speak':
      return { actor, requestId, action: { type: 'speak', text: `第 ${round} 轮的一句话` } };
    case 'move':
      return { actor, requestId, action: { type: 'move', to: pick(PLACES) } };
    case 'buy': {
      const shops = SHOPS.filter((s) => s.place === here);
      const shop = shops.length ? pick(shops) : pick(SHOPS);
      const good = pick(shop.goods.filter((g) => !g.onlyDuringEvent));
      const qty = 1 + rng.int(2);
      return {
        actor,
        requestId,
        action: { type: 'buy', shop: shop.id, sku: good.sku, qty },
        onExecuted: () => {
          bump(good.type, qty);
          expectedSink += good.price * qty;
          buyRequests.push({ requestId, residentId: actor.residentId, cost: good.price * qty, round });
        },
      };
    }
    case 'offer': {
      // 优先找同一处的人，找不到也发（会被规则拒绝）
      const near = others.filter((o) => w.mustResident(o.residentId).location_id === here);
      const to = near.length ? pick(near) : pick(others);
      const items = w.db.all('SELECT type, quantity - reserved - shelved AS free FROM items WHERE owner_id = ? AND stack = 1 AND quantity - reserved - shelved > 0', actor.residentId);
      const give: Record<string, unknown> = {};
      if (items.length && chance(0.6)) give.items = [{ type: String(pick(items).type), qty: 1 }];
      if (!give.items || chance(0.4)) give.coins = 1 + rng.int(4);
      const trade = chance(0.35);
      return {
        actor,
        requestId,
        action: { type: 'offer', kind: trade ? 'trade' : 'gift', to: to.residentId, give, ...(trade ? { want: { items: [{ type: pick(['tea_leaves', 'vegetables', 'seeds']), qty: 1 }] } } : {}) },
      };
    }
    case 'accept':
    case 'decline':
    case 'cancel': {
      const rows = forced && kind !== 'cancel' ? [{ offer_id: forced.offer_id }] : w.db.all(
        kind === 'cancel' ? "SELECT offer_id FROM offers WHERE status = 'open' AND from_id = ?" : "SELECT offer_id FROM offers WHERE status = 'open' AND to_id = ?",
        actor.residentId,
      );
      const offerId = rows.length ? String(pick(rows).offer_id) : 'o_nonexistent';
      return {
        actor,
        requestId,
        action: { type: kind === 'accept' ? 'accept_offer' : kind === 'decline' ? 'decline_offer' : 'cancel_offer', offerId },
        ...(kind === 'accept' ? { onExecuted: () => acceptRequests.push({ requestId, offerId, residentId: actor.residentId, round }) } : {}),
      };
    }
    case 'letter':
      return { actor, requestId, action: { type: 'send_letter', to: pick(others).residentId, body: `第 ${round} 轮的信`, ...(chance(0.3) ? { invite: {} } : {}) } };
    case 'use': {
      const usable = w.db.all("SELECT type FROM items WHERE owner_id = ? AND stack = 1 AND type IN ('cookie','soup') AND quantity - reserved - shelved > 0", actor.residentId);
      const type = usable.length ? String(pick(usable).type) : 'cookie';
      return { actor, requestId, action: { type: 'use_item', itemType: type, item: type }, onExecuted: () => bump(type, -1) };
    }
    case 'profile':
      return { actor, requestId, action: { type: 'update_profile', bio: `简介 ${round}`, showMood: chance(0.5) } };
    default:
      return { actor, requestId, action: { type: 'invite', to: pick(others).residentId } };
  }
}

/** 构造请求：窗口和期望值取自居民当前的状态。 */
function buildRequest(p: Planned) {
  const r = w.mustResident(p.actor.residentId);
  return {
    requestId: p.requestId,
    actionWindow: w.issueActionWindow(r.resident_id),
    expected: { contextVersion: r.context_version, controlEpoch: r.control_epoch, activityId: r.activity_id },
    action: p.action,
  };
}

// ───────────────────────── 崩溃与重开 ─────────────────────────

/** 进程被杀：不正常关闭、不写 last_alive_at，只关掉数据库句柄；然后（隔一段时间后）重新起来。 */
function crashAndReopen(downMs: number): void {
  w.db.failpoint = null;
  try {
    w.db.db.close();
  } catch {
    /* 已经关了 */
  }
  clock.t += downMs;
  w = openWorld();
  stats.reopens++;
  if (downMs > 2 * MIN) stats.longOutages++;
  enterAll();
}

function gracefulReopen(downMs: number): void {
  w.close();
  clock.t += downMs;
  w = openWorld();
  stats.reopens++;
  enterAll();
}

function hasReceipt(residentId: string, requestId: string): boolean {
  return Boolean(w.db.get('SELECT 1 AS x FROM request_receipts WHERE resident_id = ? AND request_id = ?', residentId, requestId));
}

// ───────────────────────── 不变量 ─────────────────────────

function checkInvariants(round: number): void {
  const db = w.db;
  // 1. 居民不重复
  const dup = db.get("SELECT COUNT(*) AS n, COUNT(DISTINCT principal_id) AS p, COUNT(DISTINCT street_id || ':' || house_no) AS h FROM residents")!;
  check(round, dup.n === RESIDENTS && dup.p === RESIDENTS && dup.h === RESIDENTS, () => `居民数 ${dup.n} / 主体 ${dup.p} / 门牌 ${dup.h}，应各为 ${RESIDENTS}`);
  check(round, db.scalar('SELECT COUNT(*) FROM principals') === RESIDENTS, '主体数不对');

  // 2. 硬币守恒：账本平衡；每个账户余额 = 分录合计；合计为零；预留不超过余额
  check(round, db.scalar('SELECT COALESCE(SUM(delta),0) FROM ledger_entries') === 0, '全部分录合计不为零');
  check(round, db.scalar('SELECT COALESCE(SUM(balance),0) FROM accounts') === 0, '全部账户余额合计不为零');
  const bad = db.all(
    `SELECT a.account_id, a.balance, COALESCE((SELECT SUM(delta) FROM ledger_entries e WHERE e.account_id = a.account_id),0) AS s FROM accounts a WHERE a.balance <> COALESCE((SELECT SUM(delta) FROM ledger_entries e WHERE e.account_id = a.account_id),0)`,
  );
  check(round, bad.length === 0, () => `账户余额与分录不符：${JSON.stringify(bad.slice(0, 3))}`);
  check(round, db.scalar("SELECT COUNT(*) FROM accounts WHERE kind = 'resident' AND (balance < 0 OR reserved > balance)") === 0, '有账户余额为负或预留超过余额');
  const tx = db.all('SELECT t.transaction_id FROM ledger_transactions t WHERE (SELECT COALESCE(SUM(delta),0) FROM ledger_entries e WHERE e.transaction_id = t.transaction_id) <> 0');
  check(round, tx.length === 0, '有不平的账目');
  // 回收只来自已执行的购买
  const sink = db.scalar("SELECT balance FROM accounts WHERE account_id = 'sys:sink'");
  check(round, sink === expectedSink, () => `回收账户 ${sink} ≠ 已执行购买的总价 ${expectedSink}`);

  // 3. 物品不复制不丢失：每种物品的总数 = 初始物资 + 已执行购买 − 已执行使用
  const have = new Map<string, number>();
  for (const row of db.all('SELECT type, SUM(quantity) AS n FROM items WHERE owner_id <> ? GROUP BY type', 'town')) have.set(String(row.type), Number(row.n));
  for (const type of new Set([...have.keys(), ...expectedUnits.keys()])) {
    check(round, (have.get(type) ?? 0) === (expectedUnits.get(type) ?? 0), () => `${type}：库里 ${have.get(type) ?? 0}，模型 ${expectedUnits.get(type) ?? 0}`);
  }
  // 预留与明细对得上
  const resItems = db.all(
    `SELECT i.item_id, i.reserved, COALESCE((SELECT SUM(quantity) FROM resource_reservations r WHERE r.item_id = i.item_id),0) AS s FROM items i WHERE i.reserved <> COALESCE((SELECT SUM(quantity) FROM resource_reservations r WHERE r.item_id = i.item_id),0)`,
  );
  check(round, resItems.length === 0, () => `物品预留与明细不符：${JSON.stringify(resItems.slice(0, 3))}`);
  const resCoins = db.all(
    `SELECT a.account_id FROM accounts a WHERE a.kind = 'resident' AND a.reserved <> COALESCE((SELECT SUM(coins) FROM resource_reservations r WHERE r.resident_id = a.resident_id),0)`,
  );
  check(round, resCoins.length === 0, () => `硬币预留与明细不符：${JSON.stringify(resCoins.slice(0, 3))}`);
  const orphan = db.scalar("SELECT COUNT(*) FROM resource_reservations r WHERE r.holder_kind = 'offer' AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.offer_id = r.holder_ref AND o.status = 'open')");
  check(round, orphan === 0, '有预留挂在已经不开着的报价上');

  // 4. 每个去重键的任务只结算一次：键唯一（库约束），没有失败/重试过的任务，没有该处理却还挂着的到期任务
  check(round, db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'failed' OR attempts > 0") === 0, () => `有任务失败或重试过：${JSON.stringify(db.all("SELECT dedupe_key, status, attempts, last_error FROM scheduled_jobs WHERE status = 'failed' OR attempts > 0 LIMIT 3"))}`);
  check(round, db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'pending' AND due_at <= ?", clock.t) === 0, '有到期却没有结算的任务');
  const dupKeys = db.scalar('SELECT COUNT(*) FROM (SELECT dedupe_key FROM scheduled_jobs GROUP BY dedupe_key HAVING COUNT(*) > 1)');
  check(round, dupKeys === 0, '去重键重复');
  // 信件：每封送达的信恰好一条「有新信」事件，送达时间等于应送达时间
  const delivered = db.scalar('SELECT COUNT(*) FROM letters WHERE delivered_at IS NOT NULL');
  const mailEvents = db.scalar("SELECT COUNT(*) FROM recipient_events WHERE type = 'mail'");
  check(round, delivered === mailEvents, () => `送达的信 ${delivered} 封，「有新信」事件 ${mailEvents} 条`);
  check(round, db.scalar('SELECT COUNT(*) FROM letters WHERE delivered_at IS NOT NULL AND delivered_at <> deliver_at') === 0, '有信件的送达时间不是应送达时间');
  check(round, db.scalar('SELECT COUNT(*) FROM letters WHERE delivered_at IS NULL AND deliver_at <= ?', clock.t) === 0, '有已经到时间却没送达的信');
  // 移动：不会有人在途但已过到达时间
  check(round, db.scalar("SELECT COUNT(*) FROM residents WHERE move_json IS NOT NULL AND CAST(json_extract(move_json, '$.arriveAt') AS INTEGER) <= ?", clock.t) === 0, '有人在途却已过到达时间');

  // 5. 回执与状态一致
  const badReceipts = db.all('SELECT request_id, response FROM request_receipts').filter((row) => {
    try {
      const resp = JSON.parse(String(row.response));
      return resp.ok !== true || resp.requestId !== row.request_id;
    } catch {
      return true;
    }
  });
  check(round, badReceipts.length === 0, () => `回执内容不对：${JSON.stringify(badReceipts.slice(0, 2))}`);
  // 购买账目的原因键是 buy:<居民>:<每次购买唯一的编号>（不含请求号），所以按居民对数：
  // 「购买账目笔数」必须等于「回执里带 bought 的条数」——多一笔账 = 提交了一半，少一笔 = 发了货没扣钱。
  for (const b of buyRequests.filter((x) => x.round === round)) {
    const receipt = db.get('SELECT response FROM request_receipts WHERE resident_id = ? AND request_id = ?', b.residentId, b.requestId);
    const cost = receipt ? (JSON.parse(String(receipt.response)) as { bought?: { cost?: number } }).bought?.cost : undefined;
    check(round, cost === b.cost, () => `购买 ${b.requestId} 的回执花费是 ${cost}，应为 ${b.cost}`);
  }
  const buyMismatch = db.all(
    `SELECT r.resident_id,
            (SELECT COUNT(*) FROM ledger_transactions t WHERE t.kind = 'purchase' AND t.cause_key LIKE 'buy:' || r.resident_id || ':%') AS paid,
            (SELECT COUNT(*) FROM request_receipts q WHERE q.resident_id = r.resident_id AND json_extract(q.response, '$.bought.cost') IS NOT NULL) AS receipts
       FROM residents r`,
  ).filter((row) => row.paid !== row.receipts);
  check(round, buyMismatch.length === 0, () => `购买账目和回执对不上：${JSON.stringify(buyMismatch.slice(0, 2))}`);
  const purchaseTotal = Number(db.scalar("SELECT COALESCE(SUM(e.delta), 0) FROM ledger_entries e JOIN ledger_transactions t ON t.transaction_id = e.transaction_id WHERE t.kind = 'purchase' AND e.delta > 0"));
  const expectedPurchases = buyRequests.reduce((sum, x) => sum + x.cost, 0);
  check(round, purchaseTotal === expectedPurchases, () => `购买账目合计 ${purchaseTotal}，按成功的购买应为 ${expectedPurchases}`);
  for (const a of acceptRequests.filter((x) => x.round === round)) {
    const st = db.get('SELECT status FROM offers WHERE offer_id = ?', a.offerId)?.status;
    check(round, st === 'accepted', () => `接受 ${a.requestId} 有回执，报价却是 ${st}`);
  }
  // 已接受的报价都对应一条接受回执
  const accepted = db.scalar("SELECT COUNT(*) FROM offers WHERE status = 'accepted'");
  const acceptedTotal = acceptRequests.length;
  check(round, accepted === acceptedTotal, () => `已接受的报价 ${accepted} 个，已执行的接受命令 ${acceptedTotal} 条`);

  // 6. 事件游标连续（每位居民 1..n，水位 = n），公开流同理
  for (const x of who) {
    const row = db.get('SELECT COUNT(*) AS n, COALESCE(MAX(cursor),0) AS m, COALESCE(MIN(cursor),1) AS lo FROM recipient_events WHERE resident_id = ?', x.residentId)!;
    const head = w.streamHead(`r:${x.residentId}`);
    check(round, row.n === row.m && head.highWater === row.m, () => `${x.name} 的事件游标不连续：共 ${row.n} 条，最大 ${row.m}，水位 ${head.highWater}`);
  }
  const pub = db.get('SELECT COUNT(*) AS n, COALESCE(MAX(cursor),0) AS m FROM public_events')!;
  check(round, pub.n === pub.m && w.streamHead(`pub:${w.worldId}`).highWater === pub.m, '公开事件游标不连续');
  // 7. 在场与租约：在场的人一定有未过期的租约（重开后已经重新进入）
  check(round, db.scalar('SELECT COUNT(*) FROM residents WHERE present_since IS NOT NULL AND NOT EXISTS (SELECT 1 FROM presence_leases l WHERE l.resident_id = residents.resident_id AND l.expires_at > ?)', clock.t) === 0, '有人在场却没有有效租约');
  check(round, w.status === 'running', () => `世界状态是 ${w.status}`);
}

// ───────────────────────── 主循环 ─────────────────────────

const started = performance.now();
console.log(`栖灯镇故障注入：${ROUNDS} 轮，种子 ${SEED}，${RESIDENTS} 位居民，数据库 ${dbPath}`);

try {
  for (let round = 1; round <= ROUNDS; round++) {
    stats.rounds++;
    // 时间流逝：所有人保持心跳，调度器按期处理
    const step = 1 + rng.int(45);
    for (let left = step; left > 0; left -= 20) {
      clock.t += Math.min(20, left) * SEC;
      for (const x of who) {
        try {
          townHeartbeat(w, { principalId: x.principalId, clientId: x.clientId }, w.mustResident(x.residentId).presence_epoch);
        } catch {
          enterWorld(w, { principalId: x.principalId, clientId: x.clientId }, { clientKind: 'mcp' });
        }
      }
      w.tick();
    }
    // 偶尔来一次正常重启（计划内）
    if (round % 53 === 0) gracefulReopen(rng.int(20) * SEC);

    const plan = planAction(round);
    const req = buildRequest(plan);
    const auth = { principalId: plan.actor.principalId, clientId: plan.actor.clientId };
    stats.commands++;

    // 先把已经到期的任务处理完，使注入点落在这条命令自己的事务上
    w.runDue();
    const inject = chance(0.35) ? (chance(0.5) ? 'before_commit' : 'after_commit') : null;
    let fired = false;
    if (inject) {
      w.db.failpoint = (point) => {
        if (!fired && point === inject) {
          fired = true;
          throw new Error(`注入的崩溃：${point}`);
        }
      };
    }
    let outcome: 'ok' | 'rejected' = 'rejected';
    let replayed = false;
    let firstError: unknown = null;
    try {
      const out = w.command(auth, req);
      outcome = 'ok';
      replayed = out.replayed === true;
    } catch (e) {
      firstError = e;
    } finally {
      w.db.failpoint = null;
    }

    if (fired) {
      stats.injected[inject!]++;
      // 崩溃：丢弃实例，隔一会儿（偶尔很久）再用同一个文件起来，然后用原来的 requestId 重试
      const down = chance(0.03) ? 2 * HOUR + rng.int(28 * HOUR) : chance(0.15) ? 2 * MIN + rng.int(10 * MIN) : rng.int(30 * SEC);
      crashAndReopen(down);
      const committed = hasReceipt(plan.actor.residentId, plan.requestId);
      check(round, inject === 'after_commit' ? committed : !committed, () => `${inject} 崩溃后回执${committed ? '存在' : '不存在'}（${plan.requestId}）`);
      try {
        const out = w.command(auth, { ...req, actionWindow: w.issueActionWindow(plan.actor.residentId) });
        outcome = 'ok';
        replayed = out.replayed === true;
        check(round, inject === 'after_commit' ? replayed : !replayed, () => `${inject} 崩溃后重试${replayed ? '是重放' : '是全新执行'}，与预期相反（${plan.requestId}）`);
      } catch (e) {
        if (!(e instanceof WorldError)) throw e;
        // before_commit 之后世界状态变了（重启使大家离线、报价撤销……），规则拒绝是正常的；after_commit 的重试绝不能被拒绝
        check(round, inject === 'before_commit', () => `after_commit 崩溃后用原请求号重试被拒绝：${e.code} ${e.message}（${plan.requestId}）`);
        outcome = 'rejected';
        stats.retriesRejected++;
      }
    } else if (firstError) {
      if (!(firstError instanceof WorldError)) {
        violate(round, `命令抛出了非世界错误：${firstError instanceof Error ? firstError.stack : String(firstError)}`);
      } else {
        check(round, firstError.code !== 'recovering', () => `运行中返回 recovering：${firstError.message}`);
      }
    }

    // 回执 ⇔ 已执行
    const receipt = hasReceipt(plan.actor.residentId, plan.requestId);
    check(round, receipt === (outcome === 'ok'), () => `命令 ${plan.action.type} ${plan.requestId}：结果 ${outcome}，回执${receipt ? '存在' : '不存在'}`);
    if (outcome === 'ok') {
      stats.executed++;
      executedByType.set(plan.action.type, (executedByType.get(plan.action.type) ?? 0) + 1);
      if (replayed) stats.replays++;
      plan.onExecuted?.();
    } else {
      stats.rejected++;
    }
    // 不管成败，同一个请求再来一次：已执行的一定是重放，且结果不变
    if (outcome === 'ok') {
      const again = w.command(auth, { ...req, actionWindow: w.issueActionWindow(plan.actor.residentId) });
      stats.replays++;
      check(round, again.replayed === true, '成功命令的第二次重放不是 replayed');
    }

    // 偶尔在两个命令之间崩一次（没有任何命令在飞）：重启之后一切应当原样
    if (chance(0.04)) {
      const before = JSON.stringify(w.db.all('SELECT account_id, balance FROM accounts ORDER BY account_id'));
      crashAndReopen(rng.int(20 * SEC));
      check(round, before === JSON.stringify(w.db.all('SELECT account_id, balance FROM accounts ORDER BY account_id')), '空闲时崩溃重启后账户余额变了');
    }

    checkInvariants(round);
    if (!args.quiet && round % 50 === 0) console.log(`   … 第 ${round} 轮：已执行 ${stats.executed}，注入 ${stats.injected.before_commit + stats.injected.after_commit}，违例 ${violations.length}`);
  }
} finally {
  try {
    w.close();
  } catch {
    /* 已关闭 */
  }
}

const secs = ((performance.now() - started) / 1000).toFixed(1);
console.log('');
console.log('── 栖灯镇故障注入结果 ──');
console.log(`轮数：${stats.rounds}（种子 ${SEED}，居民 ${RESIDENTS} 位）`);
console.log(`命令：${stats.commands} 条，已执行 ${stats.executed}，被规则拒绝 ${stats.rejected}（其中崩溃后重试被拒 ${stats.retriesRejected}）`);
console.log(`已执行的动作：${[...executedByType].sort().map(([k, n]) => `${k} ${n}`).join('，')}`);
console.log(`注入崩溃：${stats.injected.before_commit + stats.injected.after_commit} 次（提交前 ${stats.injected.before_commit}，提交后 ${stats.injected.after_commit}）`);
console.log(`数据库重开：${stats.reopens} 次（其中停机超过 2 分钟 ${stats.longOutages} 次）`);
console.log(`重放（replayed）：${stats.replays} 次`);
console.log(`不变量检查：${stats.checks} 次`);
console.log(`耗时：${secs} 秒`);
if (violations.length) {
  console.log(`\n发现 ${violations.length} 处违例：`);
  for (const v of violations.slice(0, 50)) console.log(`  - ${v}`);
  process.exit(1);
}
console.log('全部不变量成立。');
