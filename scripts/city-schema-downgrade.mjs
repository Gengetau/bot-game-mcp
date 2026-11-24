#!/usr/bin/env node
/**
 * 晴空都城市库受控降级脚本（支持栈顶 S2 v6 -> v5 含归档导出、v5 -> v4 委托降级、及栈顶 S1 v4 -> v3）。
 *
 * 约束：
 *  - --to 5（默认）：仅当 PRAGMA user_version === 6 时执行，VACUUM INTO 备份 + 事务内删表回拨并校验外键与完整性 +
 *    原子 fsync 导出 S2 归档与 SHA-256、保留 trace_reply_high_water、删除 v6 三表（place_traces、place_trace_daily_usage、
 *    house_trace_replies）并回拨 user_version = 5（v5 茶屋 / 密封竞拍表与账本数据原样保留）；
 *    若已存在未消费的 s2_pending_restore_file / sha256 键且 v6 表为空，重复降级保留原归档指针不覆盖（损坏或空值指针一律拒绝）；
 *    任一失败均完整回滚并清理本次生成的归档与临时文件（保留预降级备份与既有待恢复归档）。
 *  - --to 4：委托 scripts/city-schema-downgrade-v5.mjs 执行栈顶 v5 -> v4（保留原有茶屋疏散、押金/托管余额门禁与删表行为不变）。
 *  - --to 3：仅当 PRAGMA user_version === 4 时执行，VACUUM INTO 备份、清理 'qingkong' 残留快照/状态、删除 v4 两表、事务内校验外键与完整性并回拨 user_version = 3。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SUPPORTED_TARGETS = new Map([
  [5, 6],
  [4, 5],
  [3, 4],
]);

const V5_DOWNGRADE_SCRIPT = fileURLToPath(new URL('./city-schema-downgrade-v5.mjs', import.meta.url));

function parseArgs(argv) {
  const out = { db: '', to: 5, backup: '', dryRun: false };
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
  if (!SUPPORTED_TARGETS.has(out.to)) throw new Error(`本脚本仅支持 --to 5、--to 4 或 --to 3，收到 ${out.to}`);
  return out;
}

function sqlString(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function removeIfExists(filePath) {
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      /* best-effort cleanup */
    }
  }
}

function chooseArchivePath(dbPath, ts) {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  let name = `${base}.s2-archive-${ts}.json`;
  let fullPath = join(dir, name);
  let seq = 1;
  while (existsSync(fullPath)) {
    name = `${base}.s2-archive-${ts}-${seq++}.json`;
    fullPath = join(dir, name);
  }
  return { archiveName: name, archivePath: fullPath };
}

function atomicWriteFsync(targetPath, buf) {
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    removeIfExists(tmpPath);
    throw err;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.to === 4) {
    const forwarded = ['--db', args.db, '--to', '4'];
    if (args.backup) forwarded.push('--backup', args.backup);
    if (args.dryRun) forwarded.push('--dry-run');
    const res = spawnSync(process.execPath, [V5_DOWNGRADE_SCRIPT, ...forwarded], { stdio: 'inherit' });
    if (res.error) throw res.error;
    if (res.status !== 0) process.exit(res.status ?? 1);
    return;
  }

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
    let pendingArchiveWrite = null;
    let createdArchivePath = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (args.to === 5) {
        const hwRow = db.prepare("SELECT value FROM meta WHERE key = 'trace_reply_high_water'").get();
        const metaHw = Number(hwRow?.value ?? 0);
        const pendingFileRow = db.prepare("SELECT value FROM meta WHERE key = 's2_pending_restore_file'").get();
        const pendingShaRow = db.prepare("SELECT value FROM meta WHERE key = 's2_pending_restore_sha256'").get();
        const hasPendingPointer = pendingFileRow !== undefined || pendingShaRow !== undefined;
        const rawPendingFile = pendingFileRow?.value;
        const rawPendingSha = pendingShaRow?.value;
        const existingPendingFile = typeof rawPendingFile === 'string' ? rawPendingFile.trim() : '';
        const existingPendingSha = typeof rawPendingSha === 'string' ? rawPendingSha.trim() : '';
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
        const dailyUsage = db
          .prepare(
            'SELECT author_id, business_date, place_id, count FROM place_trace_daily_usage ORDER BY business_date ASC, author_id ASC, place_id ASC',
          )
          .all();
        const tableMax = replies.reduce((m, row) => Math.max(m, Number(row.reply_seq ?? 0)), 0);

        const upsertMeta = db.prepare(
          'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        );
        if (hasPendingPointer) {
          if (
            pendingFileRow === undefined ||
            pendingShaRow === undefined ||
            !existingPendingFile ||
            !existingPendingSha ||
            existingPendingFile !== rawPendingFile ||
            existingPendingSha !== rawPendingSha ||
            existingPendingFile === '.' ||
            existingPendingFile === '..' ||
            basename(existingPendingFile) !== existingPendingFile
          ) {
            throw new Error(`检测到损坏的 s2_pending_restore 元数据（file=${rawPendingFile ?? ''}），拒绝覆盖归档指针`);
          }
          const existingArchivePath = join(dirname(args.db), existingPendingFile);
          if (!existsSync(existingArchivePath)) {
            throw new Error(`检测到未消费的 S2 归档缺失（${existingPendingFile}），拒绝覆盖归档指针`);
          }
          const existingBuf = readFileSync(existingArchivePath);
          const actualSha = createHash('sha256').update(existingBuf).digest('hex');
          if (actualSha !== existingPendingSha) {
            throw new Error(`检测到未消费的 S2 归档 SHA-256 不匹配（${existingPendingFile}），拒绝覆盖归档指针`);
          }
          let existingDoc;
          try {
            existingDoc = JSON.parse(existingBuf.toString('utf8'));
          } catch (e) {
            throw new Error(`未消费的 S2 归档 JSON 解析失败（${existingPendingFile}）：${e instanceof Error ? e.message : String(e)}`);
          }
          if (
            !existingDoc ||
            existingDoc.version !== 1 ||
            !Array.isArray(existingDoc.place_traces) ||
            !Array.isArray(existingDoc.house_trace_replies) ||
            (existingDoc.place_trace_daily_usage !== undefined && !Array.isArray(existingDoc.place_trace_daily_usage))
          ) {
            throw new Error(`未消费的 S2 归档格式无效（${existingPendingFile}），拒绝覆盖归档指针`);
          }
          if (placeTraces.length > 0 || replies.length > 0 || dailyUsage.length > 0) {
            throw new Error('检测到未消费的 s2_pending_restore_file 同时 v6 表含新记录，拒绝覆盖原归档；请先完成恢复');
          }
          const archivedHw = Number(existingDoc.high_water ?? 0);
          const highWater = Math.max(
            Number.isFinite(metaHw) && metaHw >= 0 ? metaHw : 0,
            Number.isFinite(archivedHw) && archivedHw >= 0 ? archivedHw : 0,
          );
          upsertMeta.run('trace_reply_high_water', String(highWater));
          db.exec(`
            DROP TABLE IF EXISTS place_trace_daily_usage;
            DROP TABLE IF EXISTS house_trace_replies;
            DROP TABLE IF EXISTS place_traces;
            PRAGMA user_version = 5;
          `);
          extraOut = {
            archive: existingArchivePath,
            archive_file: existingPendingFile,
            archive_sha256: existingPendingSha,
            preserved_pending_archive: true,
            high_water: highWater,
            place_traces_exported: 0,
            replies_exported: 0,
            daily_usage_exported: 0,
          };
        } else {
          const highWater = Math.max(Number.isFinite(metaHw) && metaHw >= 0 ? metaHw : 0, tableMax);
          const ts = Date.now();
          const { archiveName, archivePath } = chooseArchivePath(args.db, ts);
          const archivePayload = `${JSON.stringify({
            version: 1,
            exported_at_ms: ts,
            high_water: highWater,
            place_traces: placeTraces,
            house_trace_replies: replies,
            place_trace_daily_usage: dailyUsage,
          })}\n`;
          const archiveBuf = Buffer.from(archivePayload, 'utf8');
          const archiveSha256 = createHash('sha256').update(archiveBuf).digest('hex');

          upsertMeta.run('trace_reply_high_water', String(highWater));
          upsertMeta.run('s2_pending_restore_file', archiveName);
          upsertMeta.run('s2_pending_restore_sha256', archiveSha256);
          db.exec(`
            DROP TABLE IF EXISTS place_trace_daily_usage;
            DROP TABLE IF EXISTS house_trace_replies;
            DROP TABLE IF EXISTS place_traces;
            PRAGMA user_version = 5;
          `);
          pendingArchiveWrite = { archivePath, archiveBuf };
          extraOut = {
            archive: archivePath,
            archive_file: archiveName,
            archive_sha256: archiveSha256,
            preserved_pending_archive: false,
            high_water: highWater,
            place_traces_exported: placeTraces.length,
            replies_exported: replies.length,
            daily_usage_exported: dailyUsage.length,
          };
        }
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

      const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
      if (fkViolations.length > 0) {
        throw new Error(`降级前外键检查失败：${JSON.stringify(fkViolations)}`);
      }
      const icRows = db.prepare('PRAGMA integrity_check').all();
      if (icRows.length !== 1 || icRows[0]?.integrity_check !== 'ok') {
        throw new Error(`降级前完整性检查失败：${JSON.stringify(icRows)}`);
      }

      if (pendingArchiveWrite) {
        atomicWriteFsync(pendingArchiveWrite.archivePath, pendingArchiveWrite.archiveBuf);
        createdArchivePath = pendingArchiveWrite.archivePath;
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      if (createdArchivePath) {
        removeIfExists(createdArchivePath);
      }
      throw e;
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
