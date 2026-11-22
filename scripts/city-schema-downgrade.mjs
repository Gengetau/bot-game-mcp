#!/usr/bin/env node
/**
 * 晴空都城市库受控降级脚本（仅允许栈顶 S1 v4 -> v3）。
 *
 * 约束：
 *  - 仅当 PRAGMA user_version === 4（S1 仍居迁移账本栈顶）时执行；若已被后续迁移推进至 >= 5，立即报错退出且不改动库。
 *  - 先以 VACUUM INTO 落盘独立备份，再在单事务内清理 'qingkong' 残留快照/状态、删除 v4 新增两张表并回拨 user_version = 3。
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const EXPECTED_FROM = 4;
const EXPECTED_TO = 3;

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    throw new Error(`数据库不存在：${args.db}`);
  }
  const db = new DatabaseSync(args.db);
  try {
    const curRow = db.prepare('PRAGMA user_version').get();
    const currentVersion = Number(curRow?.user_version ?? 0);
    if (currentVersion !== EXPECTED_FROM) {
      throw new Error(`栈顶门禁拒绝执行：仅允许 v${EXPECTED_FROM} -> v${EXPECTED_TO} 栈顶降级，当前 PRAGMA user_version = ${currentVersion}`);
    }
    if (args.dryRun) {
      process.stdout.write(JSON.stringify({ ok: true, dry_run: true, from_version: currentVersion, to_version: EXPECTED_TO }) + '\n');
      return;
    }

    const backupPath = args.backup || `${args.db}.pre-v${EXPECTED_TO}-downgrade-${Date.now()}.sqlite`;
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        UPDATE weather_snapshots
           SET precip_mm = 0,
               rain = 0,
               source = 'synthetic',
               status = 'fallback',
               hourly_json = '[]'
         WHERE source = 'qingkong';
        INSERT INTO meta(key, value) VALUES ('weather_last_attempt', '0')
          ON CONFLICT(key) DO UPDATE SET value = '0';
        INSERT INTO meta(key, value) VALUES ('weather_source_mode', 'legacy_open_meteo')
          ON CONFLICT(key) DO UPDATE SET value = 'legacy_open_meteo';
        DROP TABLE IF EXISTS weather_override_receipts;
        DROP TABLE IF EXISTS weather_overrides;
        PRAGMA user_version = ${EXPECTED_TO};
      `);
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
    process.stdout.write(JSON.stringify({ ok: true, from_version: EXPECTED_FROM, to_version: EXPECTED_TO, backup: backupPath }) + '\n');
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
