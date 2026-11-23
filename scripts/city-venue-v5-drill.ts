#!/usr/bin/env node
/**
 * 晴空都城市库 v4 -> v5（桌游茶屋 + 旧物密封竞拍会）离线演练脚本。
 *
 * 只对「一份拷贝」操作，绝不接受线上路径之外的写：先把 --src 复制到 --work 目录，之后所有读写都在副本上。
 * 步骤：
 *   1. 记录副本升级前的版本、表清单、账本差额；
 *   2. 用本分支引擎打开副本（自动 v4 -> v5，并留 .pre-v5 备份）；
 *   3. 跑探针：茶屋开桌 / 入座 / 中途离开退座 / 散局；密封竞拍成交与流拍，账本 Σ=0、对账通过；
 *   4. 用旧引擎（--old-engine 指向基线 checkout）打开 v5 副本，应被明确拒绝；
 *   5. v5 -> v4 降级（scripts/city-schema-downgrade-v5.mjs），旧引擎重新打开成功；
 *   6. 把「升级前的副本」当作上线前备份还原，旧引擎打开成功且与升级前表清单一致。
 * 结果以 JSON 写到 --out。
 *
 * 用法：tsx scripts/city-venue-v5-drill.ts --src <city.db 的只读拷贝> --work <空目录> --old-engine <基线仓库根目录> --out <结果.json>
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import {
  AUCTION_ESCROW,
  AUCTION_HOUSE_RESIDENT,
  BOARDGAME_CHAYA_ID,
  CITY_SCHEMA_VERSION,
  accountBalance,
  createVenueAuction,
  ledgerImbalance,
  runReconcile,
} from '../packages/engine/src/city/index.js';
import { HOUSE, MIN, makeCity } from '../packages/engine/test/city/helpers.js';
import { FakeClock } from '../packages/engine/test/helpers.js';

const { values } = parseArgs({
  options: {
    src: { type: 'string' },
    work: { type: 'string' },
    'old-engine': { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.src || !values.work || !values['old-engine'] || !values.out) {
  console.error('用法：--src <city.db 拷贝> --work <空目录> --old-engine <基线仓库根> --out <结果.json>');
  process.exit(2);
}
const SRC = resolve(values.src);
const WORK = resolve(values.work);
const OLD_ENGINE = resolve(values['old-engine']);
const OUT = resolve(values.out);
const DOWNGRADE = resolve(new URL('./city-schema-downgrade-v5.mjs', import.meta.url).pathname);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`演练断言失败：${msg}`);
}

/** 把一个（可能带 -wal / -shm 的）库复制成单文件：先复制三件套再用 VACUUM INTO 落成干净的单文件。 */
function materialize(srcDb: string, dstDb: string): void {
  const tmp = `${dstDb}.stage`;
  for (const sfx of ['', '-wal', '-shm']) {
    if (existsSync(srcDb + sfx)) copyFileSync(srcDb + sfx, tmp + sfx);
  }
  const d = new DatabaseSync(tmp);
  d.exec(`VACUUM INTO '${dstDb.replace(/'/g, "''")}'`);
  d.close();
}

function snapshot(dbPath: string): { user_version: number; tables: string[]; counts: Record<string, number>; integrity: string } {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const user_version = Number((d.prepare('PRAGMA user_version').get() as any).user_version);
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[]).map((r) => String(r.name));
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any).n);
    const integrity = String((d.prepare('PRAGMA integrity_check').get() as any).integrity_check);
    return { user_version, tables, counts, integrity };
  } finally {
    d.close();
  }
}

async function oldEngineOpen(dbPath: string): Promise<{ ok: boolean; error?: string; user_version?: number }> {
  const mod = (await import(pathToFileURL(join(OLD_ENGINE, 'packages/engine/src/city/db.ts')).href)) as { openCityDb: (p: string) => any };
  try {
    const db = mod.openCityDb(dbPath);
    const v = Number(db.get('PRAGMA user_version')?.user_version);
    db.close();
    return { ok: true, user_version: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  assert(readdirSync(WORK).length === 0, '--work 必须是空目录');
  const report: Record<string, unknown> = { schema_version_target: CITY_SCHEMA_VERSION };

  // 0) 复制 -> 单文件基线（这就是「上线前备份」）
  const pre = join(WORK, 'city.pre-upgrade.db');
  materialize(SRC, pre);
  const live = join(WORK, 'city.db');
  copyFileSync(pre, live);
  const before = snapshot(live);
  report.before = before;
  assert(before.user_version === 4, `源库应为 v4，实际 v${before.user_version}`);
  assert(before.integrity === 'ok', '源库 integrity_check 应为 ok');
  assert(!before.tables.some((t) => t.startsWith('venue_')), '源库不应已有 venue_* 表');

  // 1) 升级 + 探针（本分支引擎；时钟定在拷贝之后的一个时刻）
  const clock = new FakeClock();
  clock.t = Date.UTC(2026, 10, 23, 10, 0, 0); // 2026-11-23 19:00 JST
  const t = makeCity({ dbPath: live, clock, house: HOUSE });
  const probes: Record<string, unknown> = {};
  const imbalanceBefore = ledgerImbalance(t.c);
  probes.ledger_imbalance_after_upgrade = imbalanceBefore;
  assert(imbalanceBefore === 0, '升级后账本差额应为 0');

  const a = t.bot('演练甲', { entry: 'ryokogai:station', stay: true });
  const b = t.bot('演练乙', { entry: 'ryokogai:station', stay: true });
  const c = t.bot('演练丙', { entry: 'ryokogai:station', stay: true });
  for (const x of [a, b, c]) x.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
  t.run(10 * MIN);

  const status = (id: string) => t.c.db.get<{ status: string; abort_reason: string | null }>('SELECT status, abort_reason FROM venue_tables WHERE table_id = ?', id)!;
  const seats = (id: string) => t.c.db.all<{ resident_id: string; left_at: number | null; leave_reason: string | null }>('SELECT resident_id, left_at, leave_reason FROM venue_table_seats WHERE table_id = ? ORDER BY joined_at, resident_id', id);

  // 牌桌 1：开桌 -> 入座 -> 开局 -> 乙中途离开（退座）-> 甲丙继续 -> 散局
  const tbl1 = a.act({ type: 'open_table', game: 'liars_dice', options: { lives: 1, dice_per_player: 2, random_seats: false } });
  b.act({ type: 'join_table', table_id: tbl1.table_id });
  c.act({ type: 'join_table', table_id: tbl1.table_id });
  a.act({ type: 'start_table', table_id: tbl1.table_id });
  assert(status(tbl1.table_id).status === 'running', '牌桌 1 应在进行中');
  b.act({ type: 'leave_table' });
  const seatsAfterLeave = seats(tbl1.table_id);
  assert(seatsAfterLeave.some((s) => s.left_at !== null), '乙离开后应有退座记录');
  probes.table1_after_mid_leave = { status: status(tbl1.table_id).status, seats: seatsAfterLeave.map((s) => ({ left: s.left_at !== null, reason: s.leave_reason })) };
  // 其余两人也离开，牌桌 1 收尾，下面的牌桌 2、3 才能再入座
  c.act({ type: 'leave_table' });
  a.act({ type: 'leave_table' });
  probes.table1_all_left = status(tbl1.table_id);

  // 牌桌 2：开桌后全员离开 -> 自动散局（aborted）
  const tbl2 = b.act({ type: 'open_table', game: 'liars_dice', options: { lives: 1, dice_per_player: 2, random_seats: false } });
  b.act({ type: 'leave_table' });
  const s2 = status(tbl2.table_id);
  probes.table2_host_leaves_forming = s2;
  assert(s2.status === 'aborted', '开桌方离开且无人在座时应散局（aborted）');

  // 牌桌 3：两人打完一局（正常散局）
  const tbl3 = b.act({ type: 'open_table', game: 'liars_dice', options: { lives: 1, dice_per_player: 2, random_seats: false } });
  c.act({ type: 'join_table', table_id: tbl3.table_id });
  b.act({ type: 'start_table', table_id: tbl3.table_id });
  const first = (b.view() as any).venue_table?.todo ? b : c;
  const second = first === b ? c : b;
  first.act({ type: 'game_act', input: { action: 'bid', quantity: 2, face: 6 } });
  const fin = second.act({ type: 'game_act', input: { action: 'challenge' } });
  assert(fin.game_status === 'ended', '牌桌 3 应打完');
  probes.table3_finished = status(tbl3.table_id);
  assert(status(tbl3.table_id).status === 'completed', '牌桌 3 应为 completed');

  // 竞拍：成交（两人出价，次价/首价按默认）与流拍（出价后离开 -> 撤回 -> 无人有效）
  const auc1 = t.c.commit(() =>
    createVenueAuction(t.c, { auctionId: 'auc:drill:sold', itemId: 'curio:drill-book', itemType: 'paperback', itemName: '演练用旧书', reserveYen: 300, priceMode: 'first', closesAt: t.clock.now() + 30 * MIN }),
  );
  a.act({ type: 'auction_bid', auction_id: auc1.auction_id, yen: 550 });
  c.act({ type: 'auction_bid', auction_id: auc1.auction_id, yen: 500 });
  probes.escrow_while_open = accountBalance(t.c, AUCTION_ESCROW);
  assert(accountBalance(t.c, AUCTION_ESCROW) === 1050, '开标前托管应为 1050');
  assert(ledgerImbalance(t.c) === 0, '出价后账本差额应为 0');
  t.run(35 * MIN);
  const sold = t.c.db.get<{ status: string; winner_id: string | null; winning_price: number | null }>('SELECT status, winner_id, winning_price FROM venue_auctions WHERE auction_id = ?', auc1.auction_id)!;
  probes.auction_sold = sold;
  assert(sold.status === 'settled', '竞拍应成交');
  assert(accountBalance(t.c, AUCTION_ESCROW) === 0, '成交后托管应清零');
  assert(t.c.db.get<{ owner_id: string }>('SELECT owner_id FROM items WHERE item_id = ?', 'curio:drill-book')!.owner_id === a.id, '旧物应归得主甲');

  const auc2 = t.c.commit(() =>
    createVenueAuction(t.c, { auctionId: 'auc:drill:unsold', itemId: 'curio:drill-lamp', itemType: 'antique_curio', itemName: '演练用旧台灯', reserveYen: 400, closesAt: t.clock.now() + 20 * MIN }),
  );
  c.act({ type: 'auction_bid', auction_id: auc2.auction_id, yen: 600 });
  c.act({ type: 'travel', to: 'ryokogai:station' });
  assert(accountBalance(t.c, AUCTION_ESCROW) === 0, '出价人离开后押金应解冻');
  t.run(25 * MIN);
  const unsold = t.c.db.get<{ status: string }>('SELECT status FROM venue_auctions WHERE auction_id = ?', auc2.auction_id)!;
  probes.auction_unsold = unsold;
  assert(unsold.status === 'unsold', '竞拍应流拍');
  assert(t.c.db.get<{ owner_id: string }>('SELECT owner_id FROM items WHERE item_id = ?', 'curio:drill-lamp')!.owner_id === AUCTION_HOUSE_RESIDENT, '流拍物应留在竞拍行');

  const finalImbalance = ledgerImbalance(t.c);

  // 竞拍 3：出价中（押金在托管）时取一份副本，降级脚本必须拒绝；随后出价人离开撤回，竞拍仍开着但没有押金
  const auc3 = t.c.commit(() =>
    createVenueAuction(t.c, { auctionId: 'auc:drill:held', itemId: 'curio:drill-vase', itemType: 'antique_curio', itemName: '演练用旧花瓶', reserveYen: 200, closesAt: t.clock.now() + 60 * MIN }),
  );
  a.act({ type: 'auction_bid', auction_id: auc3.auction_id, yen: 350 });
  const heldCopy = join(WORK, 'city.held-auction-copy.db');
  {
    const src = new DatabaseSync(live);
    src.exec(`VACUUM INTO '${heldCopy.replace(/'/g, "''")}'`);
    src.close();
  }
  let refusal = '';
  try {
    execFileSync(process.execPath, [DOWNGRADE, '--db', heldCopy, '--dry-run'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e: any) {
    refusal = String(e.stderr ?? e.message).trim();
  }
  probes.downgrade_refused_while_bid_held = refusal;
  assert(refusal.includes('拒绝降级'), '有出价押金的竞拍进行中，降级必须被拒绝');
  a.act({ type: 'travel', to: 'ryokogai:station' });
  assert(accountBalance(t.c, AUCTION_ESCROW) === 0, '出价人离开后托管应清零');
  const reconcile = runReconcile(t.c, 'drill-v5');
  probes.ledger_imbalance_final = finalImbalance;
  probes.reconcile_ok = reconcile.ok;
  assert(finalImbalance === 0, '最终账本差额应为 0（Σ=0）');
  assert(reconcile.ok, '对账应通过');
  t.c.close();
  report.probes = probes;

  const afterUp = snapshot(live);
  report.after_upgrade = afterUp;
  assert(afterUp.user_version === 5, `升级后应为 v5，实际 v${afterUp.user_version}`);
  assert(['venue_tables', 'venue_table_seats', 'venue_auctions', 'venue_auction_bids'].every((n) => afterUp.tables.includes(n)), 'venue_* 四表应都在');
  report.upgrade_backups = readdirSync(WORK).filter((f) => f.includes('.pre-v5-'));
  assert((report.upgrade_backups as string[]).length >= 1, '升级应自动留下 .pre-v5 备份');

  // 2) 旧引擎打不开 v5
  const oldOnV5 = await oldEngineOpen(live);
  report.old_engine_on_v5 = oldOnV5;
  assert(!oldOnV5.ok, '旧引擎不应能打开 v5 库');

  // 3) v5 -> v4 降级（先 dry-run，再真降），旧引擎重开
  const dry = JSON.parse(execFileSync(process.execPath, [DOWNGRADE, '--db', live, '--dry-run'], { encoding: 'utf8' }));
  report.downgrade_dry_run = dry;
  const down = JSON.parse(execFileSync(process.execPath, [DOWNGRADE, '--db', live, '--backup', join(WORK, 'city.pre-downgrade.sqlite')], { encoding: 'utf8' }));
  report.downgrade = down;
  const afterDown = snapshot(live);
  report.after_downgrade = afterDown;
  assert(afterDown.user_version === 4, '降级后应为 v4');
  assert(!afterDown.tables.some((n) => n.startsWith('venue_')), '降级后不应再有 venue_* 表');
  const oldOnV4 = await oldEngineOpen(live);
  report.old_engine_on_downgraded = oldOnV4;
  assert(oldOnV4.ok && oldOnV4.user_version === 4, '旧引擎应能打开降级后的 v4 库');

  // 旧引擎不只是「能打开」：在降级后的库上真跑两天的作业循环，再对账，不能出现失败作业
  const oldHelpers = (await import(pathToFileURL(join(OLD_ENGINE, 'packages/engine/test/city/helpers.ts')).href)) as { makeCity: (o: any) => any; HOUSE: unknown; MIN: number };
  const oldTestHelpers = (await import(pathToFileURL(join(OLD_ENGINE, 'packages/engine/test/helpers.ts')).href)) as { FakeClock: new () => { t: number } };
  const oldCityIdx = (await import(pathToFileURL(join(OLD_ENGINE, 'packages/engine/src/city/index.ts')).href)) as { runReconcile: (c: any, tag: string) => { ok: boolean } };
  const oldClock = new oldTestHelpers.FakeClock();
  oldClock.t = Date.UTC(2026, 10, 25, 10, 0, 0); // 降级之后两天
  const oldT = oldHelpers.makeCity({ dbPath: live, clock: oldClock, house: oldHelpers.HOUSE });
  oldT.run(48 * 60 * oldHelpers.MIN);
  const failedJobs = oldT.c.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'failed'");
  const stuckJobs = oldT.c.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'pending' AND attempts >= 5");
  const oldRec = oldCityIdx.runReconcile(oldT.c, 'drill-v5-old-engine');
  oldT.c.close();
  report.old_engine_runs_after_downgrade = { failed_jobs: failedJobs, stuck_jobs: stuckJobs, reconcile_ok: oldRec.ok };
  assert(failedJobs === 0 && stuckJobs === 0, '旧引擎在降级库上跑两天后不应有失败/卡住的作业');
  assert(oldRec.ok, '旧引擎在降级库上对账应通过');

  // 4) 整库还原：用升级前的单文件备份顶替，旧引擎应能打开且表清单与升级前一致
  const restored = join(WORK, 'city.restored.db');
  copyFileSync(pre, restored);
  const afterRestore = snapshot(restored);
  report.after_restore = afterRestore;
  assert(afterRestore.user_version === 4 && JSON.stringify(afterRestore.tables) === JSON.stringify(before.tables) && JSON.stringify(afterRestore.counts) === JSON.stringify(before.counts), '还原后版本、表清单与行数应与升级前完全一致');
  const oldOnRestore = await oldEngineOpen(restored);
  report.old_engine_on_restored = oldOnRestore;
  assert(oldOnRestore.ok, '旧引擎应能打开还原后的库');

  report.ok = true;
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, out: OUT }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
