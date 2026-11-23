#!/usr/bin/env node
/**
 * 晴空都城市库受控降级脚本（仅允许栈顶 v5 -> v4：去掉桌游茶屋 / 密封竞拍的 venue_* 四张表）。
 *
 * 约束：
 *  - 仅当 PRAGMA user_version === 5 时执行；其它版本一律报错退出且不改库。
 *  - 进行中的竞拍（venue_auctions.status = 'open'）里只要还有未结的出价押金（active 出价且 held_yen > 0）就拒绝：
 *    押金还在竞拍托管账户里，直接删表会让这笔钱失去对应出价记录。先等竞拍结算（或流拍退款）再降级。
 *    没有任何押金的进行中竞拍（例如每日自动开的、还没人出价的）不影响账本，可以随表一起丢。
 *    押金检查（含托管账户 sys:auction 余额必须为 0）在拿到写锁之后会再做一遍；仍应先停服务再执行。
 *  - 同一事务里把待办的 venue_table_tick / venue_auction_settle 作业标为 cancelled：旧引擎没有处理器，留着会变 failed。
 *  - 先 VACUUM INTO 落盘独立备份，再单事务删表并回拨 user_version = 4，最后做外键与完整性检查。
 *  - --dry-run 只报告会丢什么，不动库。
 *
 * 会丢：venue_tables / venue_table_seats（牌桌与座位、对局记录）、venue_auctions / venue_auction_bids（竞拍与出价记录）。
 * 不丢也不回滚：账本流水、物品归属与物品事件（已成交的旧物仍在得主手里，钱已按成交结算）；
 *   竞拍行的主体与居民记录（旧物竞拍行）、流拍物品留在原处。这些行旧引擎看得到，但不会再被引用。
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const EXPECTED_FROM = 5;
const EXPECTED_TO = 4;
const VENUE_TABLES = ['venue_auction_bids', 'venue_auctions', 'venue_table_seats', 'venue_tables'];
const VENUE_JOB_KINDS = ['venue_table_tick', 'venue_auction_settle'];
const ESCROW_ACCOUNT = 'sys:auction';

function parseArgs(argv) {
  const out = { db: '', to: EXPECTED_TO, backup: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = String(argv[++i] ?? '');
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a === '--backup') out.backup = String(argv[++i] ?? '');
    else if (a === '--dry-run') out.dryRun = true;
    else if (!a.startsWith('-') && !out.db) out.db = a;
    else throw new Error(`未知参数：${a}`);
  }
  if (!out.db) throw new Error('必须指定 --db <city.db 路径>');
  if (out.to !== EXPECTED_TO) throw new Error(`本脚本仅支持 --to ${EXPECTED_TO}，收到 ${out.to}`);
  return out;
}

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function countOf(db, table, where = '1=1') {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    throw new Error(`数据库不存在：${args.db}`);
  }
  const db = new DatabaseSync(args.db);
  try {
    const currentVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (currentVersion !== EXPECTED_FROM) {
      throw new Error(`栈顶门禁拒绝执行：仅允许 v${EXPECTED_FROM} -> v${EXPECTED_TO} 栈顶降级，当前 PRAGMA user_version = ${currentVersion}`);
    }
    const assertNoHeldDeposits = () => {
      const heldAuctions = Number(
        db
          .prepare(
            `SELECT COUNT(DISTINCT a.auction_id) AS n
             FROM venue_auctions a JOIN venue_auction_bids b ON b.auction_id = a.auction_id
             WHERE a.status = 'open' AND b.status = 'active' AND b.held_yen > 0`,
          )
          .get().n,
      );
      if (heldAuctions > 0) {
        throw new Error(`拒绝降级：仍有 ${heldAuctions} 场进行中的竞拍带着出价押金（在托管账户里）；请等竞拍结算或流拍退款后再降级`);
      }
      const escrow = Number(db.prepare('SELECT COALESCE((SELECT balance FROM accounts WHERE account_id = ?), 0) AS b').get(ESCROW_ACCOUNT).b);
      if (escrow !== 0) {
        throw new Error(`拒绝降级：竞拍托管账户 ${ESCROW_ACCOUNT} 余额为 ${escrow}，不是 0；押金没有退清，先结算或退款再降级`);
      }
    };
    assertNoHeldDeposits();
    const openNoHold = countOf(db, 'venue_auctions', "status = 'open'");
    const pendingJobs = countOf(db, 'scheduled_jobs', `status = 'pending' AND kind IN (${VENUE_JOB_KINDS.map(sqlString).join(',')})`);
    const lost = Object.fromEntries(VENUE_TABLES.map((t) => [t, countOf(db, t)]));
    lost.open_auctions_without_held_bids = openNoHold;
    lost.pending_venue_jobs_cancelled = pendingJobs;

    if (args.dryRun) {
      process.stdout.write(JSON.stringify({ ok: true, dry_run: true, from_version: currentVersion, to_version: EXPECTED_TO, would_drop_rows: lost }) + '\n');
      return;
    }

    const backupPath = args.backup || `${args.db}.pre-v${EXPECTED_TO}-downgrade-${Date.now()}.sqlite`;
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);

    db.exec('BEGIN IMMEDIATE');
    try {
      // 写锁到手后再查一遍：避免检查和删表之间有人出价
      assertNoHeldDeposits();
      db.exec(
        `${VENUE_TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n')}\n` +
          // 待办的茶屋作业旧引擎没有处理器，留着会被重试后标成 failed，让每日对账一直报错；这里作废
          `UPDATE scheduled_jobs SET status = 'cancelled', processed_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE status = 'pending' AND kind IN (${VENUE_JOB_KINDS.map(sqlString).join(',')});\n` +
          `PRAGMA user_version = ${EXPECTED_TO};`,
      );
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViolations.length > 0) {
      throw new Error(`降级后外键检查失败：${JSON.stringify(fkViolations)}`);
    }
    const ic = db.prepare('PRAGMA integrity_check').get();
    if (ic?.integrity_check !== 'ok') {
      throw new Error(`降级后完整性检查失败：${JSON.stringify(ic)}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, from_version: EXPECTED_FROM, to_version: EXPECTED_TO, backup: backupPath, dropped_rows: lost }) + '\n');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
