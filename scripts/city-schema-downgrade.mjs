#!/usr/bin/env node
/**
 * 晴空都城市库受控降级脚本（支持栈顶 S2 v5 -> v4 含归档导出，及栈顶 S1 v4 -> v3）。
 *
 * 约束：
 *  - --to 4（默认）：仅当 PRAGMA user_version === 5 时执行，VACUUM INTO 备份 + 原子 fsync 导出 S2 归档与 SHA-256、保留 trace_reply_high_water、删除 v5 两表并回拨 user_version = 4。
 *  - --to 3：仅当 PRAGMA user_version === 4 时执行，VACUUM INTO 备份、清理 'qingkong' 残留快照/状态、删除 v4 两表并回拨 user_version = 3。
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SUPPORTED_TARGETS = new Map([
  [4, 5],
  [3, 4],
]);

function parseArgs(argv) {
  const out = { db: '', to: 4, backup: '', dryRun: false };
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
  if (!SUPPORTED_TARGETS.has(out.to)) throw new Error(`本脚本仅支持 --to 4 或 --to 3，收到 ${out.to}`);
  return out;
}

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function atomicWriteFsync(targetPath, buf) {
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeSync(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    throw new Error(`数据库不存在：${args.db}`);
  }
  const expectedFrom = SUPPORTED_TARGETS.get(args.to);
  const db = new DatabaseSync(args.db);
  try {
    const curRow = db.prepare('PRAGMA user_version').get();
    const currentVersion = Number(curRow?.user_version ?? 0);
    if (currentVersion !== expectedFrom) {
      throw new Error(`栈顶门禁拒绝执行：仅允许 v${expectedFrom} -> v${args.to} 栈顶降级，当前 PRAGMA user_version = ${currentVersion}`);
    }
    if (args.dryRun) {
      process.stdout.write(JSON.stringify({ ok: true, dry_run: true, from_version: currentVersion, to_version: args.to }) + '\n');
      return;
    }

    const backupPath = args.backup || `${args.db}.pre-v${args.to}-downgrade-${Date.now()}.sqlite`;
    db.exec(`VACUUM INTO ${sqlString(backupPath)}`);

    let extraOut = {};
    db.exec('BEGIN IMMEDIATE');
    try {
      if (args.to === 4) {
        const hwRow = db.prepare("SELECT value FROM meta WHERE key = 'trace_reply_high_water'").get();
        const metaHw = Number(hwRow?.value ?? 0);
        const placeTraces = db
          .prepare(
            'SELECT trace_id, place_id, author_id, author_name, author_origin, body, reply_to, visit_id, business_date, created_at_ms FROM place_traces ORDER BY created_at_ms ASC, trace_id ASC',
          )
          .all();
        const replies = db
          .prepare(
            'SELECT reply_seq, target_actor_id, trace_id, reply_trace_id, place_id, place_name, reply_author_name, reply_origin, excerpt, created_at_ms FROM house_trace_replies ORDER BY reply_seq ASC',
          )
          .all();
        const tableMax = replies.reduce((m, row) => Math.max(m, Number(row.reply_seq ?? 0)), 0);
        const highWater = Math.max(Number.isFinite(metaHw) && metaHw >= 0 ? metaHw : 0, tableMax);

        const ts = Date.now();
        const archiveName = `${basename(args.db)}.s2-archive-${ts}.json`;
        const archivePath = join(dirname(args.db), archiveName);
        const archivePayload = `${JSON.stringify({
          version: 1,
          exported_at_ms: ts,
          high_water: highWater,
          place_traces: placeTraces,
          house_trace_replies: replies,
        })}\n`;
        const archiveBuf = Buffer.from(archivePayload, 'utf8');
        const archiveSha256 = createHash('sha256').update(archiveBuf).digest('hex');
        atomicWriteFsync(archivePath, archiveBuf);

        const upsertMeta = db.prepare(
          'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        );
        upsertMeta.run('trace_reply_high_water', String(highWater));
        upsertMeta.run('s2_pending_restore_file', archiveName);
        upsertMeta.run('s2_pending_restore_sha256', archiveSha256);
        db.exec(`
          DROP TABLE IF EXISTS house_trace_replies;
          DROP TABLE IF EXISTS place_traces;
          PRAGMA user_version = 4;
        `);
        extraOut = {
          archive: archivePath,
          archive_file: archiveName,
          archive_sha256: archiveSha256,
          high_water: highWater,
          place_traces_exported: placeTraces.length,
          replies_exported: replies.length,
        };
      } else {
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
          PRAGMA user_version = 3;
        `);
      }
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
    process.stdout.write(
      JSON.stringify({ ok: true, from_version: expectedFrom, to_version: args.to, backup: backupPath, ...extraOut }) + '\n',
    );
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
