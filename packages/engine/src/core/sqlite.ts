/**
 * SQLite 数据库外壳：本机 SQLite、单写入进程、WAL。数据库是真相源，内存里只有可以重建的缓存。
 *
 * 驱动选的是 Node 自带的 node:sqlite（Node 22.13 起不需要启动参数）：同步接口正好对应「候选状态 = 一个打开的写事务」，
 * 不新增任何 npm 依赖，也没有需要编译的原生模块。Node 22 上它还标着 experimental，加载时那条警告在这里消掉。
 *
 * 约定：
 *  - 所有写入都经过 tx()：BEGIN IMMEDIATE … COMMIT，中途抛错就 ROLLBACK，不留下任何半截变化。
 *  - 外键检查开启，synchronous=FULL（提交返回时已经落盘），忙等待有上限。
 *  - schema 版本用 PRAGMA user_version 管理；升级前先做一份一致的备份，迁移失败就不开放写接口（抛错）。
 *  - 备份用 VACUUM INTO 取一致快照，不是复制主文件（WAL 里可能还有没合并的提交）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/** 加载 node:sqlite（消掉 experimental 警告）。老版本 Node 没有它时给出明确的说明。 */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = require('node:sqlite') as SqliteModule;
  } catch (e) {
    throw new Error(`世界数据库需要 Node 22.13 或更高版本（内置 node:sqlite）。当前 ${process.version}：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export type Row = Record<string, any>;
export type Param = SQLInputValue;

/**
 * 一套 schema：迁移脚本按顺序执行，条数就是目标版本。
 */
export interface SchemaSpec {
  /** 报错里用的名字 */
  label: string;
  migrations: readonly string[];
  /** 每日备份的文件名前缀（清理旧备份时按它找） */
  backupPrefix: string;
}

/** 故障注入点（只给恢复测试用）：在事务的指定位置抛错或杀进程。 */
export type Failpoint = (point: 'before_commit' | 'after_commit') => void;

export class SqliteDb {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly stmts = new Map<string, StatementSync>();
  private depth = 0;
  failpoint: Failpoint | null = null;
  /** 最近一次提交花了多久（毫秒），给指标用 */
  lastCommitMs = 0;

  private readonly schema: SchemaSpec;

  constructor(path: string, schema: SchemaSpec) {
    const { DatabaseSync } = loadSqlite();
    this.path = path;
    this.schema = schema;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA busy_timeout = 2000');
      this.db.exec('PRAGMA wal_autocheckpoint = 1000');
      this.migrate();
    } catch (e) {
      // 打开失败（schema 太新、迁移失败）时把句柄关掉：否则文件一直被占着，Windows 上删不掉、也没法换个办法重开
      try {
        this.db.close();
      } catch {
        /* 已经关了 */
      }
      throw e;
    }
  }

  get inMemory(): boolean {
    return this.path === ':memory:';
  }

  userVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  private migrate(): void {
    const current = this.userVersion();
    const target = this.schema.migrations.length;
    const label = this.schema.label;
    if (current > target) {
      throw new Error(`${label}的 schema 版本（${current}）比这个程序认识的（${target}）新，拒绝打开以免写坏数据。`);
    }
    if (current === target) return;
    // 升级已有数据前先留一份可恢复的一致备份
    if (current > 0 && !this.inMemory) this.snapshotTo(`${this.path}.pre-v${current + 1}-${Date.now()}.bak`);
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      for (let v = current; v < target; v++) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(this.schema.migrations[v]!);
          const fkErrors = this.db.prepare('PRAGMA foreign_key_check').all() as Row[];
          if (fkErrors.length > 0) {
            throw new Error(`外键约束检查未通过：${JSON.stringify(fkErrors[0])}`);
          }
          this.db.exec(`PRAGMA user_version = ${v + 1}`);
          this.db.exec('COMMIT');
        } catch (e) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          throw new Error(`${label}迁移到 v${v + 1} 失败，写接口不开放：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  get<T extends Row = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T extends Row = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** 单个数值（COUNT、SUM 之类）。 */
  scalar(sql: string, ...params: Param[]): number {
    const row = this.stmt(sql).get(...params) as Row | undefined;
    if (!row) return 0;
    const v = Object.values(row)[0];
    return v === null || v === undefined ? 0 : Number(v);
  }

  get inTx(): boolean {
    return this.depth > 0;
  }

  /**
   * 写事务。fn 里抛错 → 整个事务回滚，什么都不留下。嵌套调用并入外层事务。
   * 候选状态就是这个打开的事务：fn 里不能等待模型或网络（fn 是同步的）。
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    let result: T;
    try {
      result = fn();
      this.failpoint?.('before_commit');
    } catch (e) {
      this.depth = 0;
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败说明事务已经不在了 */
      }
      throw e;
    }
    this.depth = 0;
    const t0 = performance.now();
    try {
      this.db.exec('COMMIT');
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
    this.lastCommitMs = performance.now() - t0;
    this.failpoint?.('after_commit');
    return result;
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  /** WAL 文件大小（字节）；内存库或没有 WAL 时为 0。 */
  walBytes(): number {
    if (this.inMemory) return 0;
    try {
      return statSync(`${this.path}-wal`).size;
    } catch {
      return 0;
    }
  }

  dbBytes(): number {
    if (this.inMemory) return 0;
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  /** 把 WAL 合并进主文件并截断（检查点不是备份）。 */
  checkpoint(): void {
    if (this.inTx) return;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** 一致快照：VACUUM INTO 在一个读事务里把整库写到新文件，包含 WAL 里已提交的内容。 */
  snapshotTo(dest: string): void {
    if (this.inTx) throw new Error('不能在事务里做备份');
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) rmSync(dest);
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }

  /**
   * 备份并验证：快照 → 以只读方式打开 → integrity_check + 外键检查。返回备份文件大小。
   * keep > 0 时只保留同目录下最近 keep 份同前缀的备份。
   */
  backup(dest: string, keep = 0): { path: string; bytes: number; ms: number } {
    const t0 = performance.now();
    this.snapshotTo(dest);
    verifyBackup(dest);
    if (keep > 0) {
      const dir = dirname(dest);
      const prefix = this.schema.backupPrefix;
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
        .sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f));
    }
    return { path: dest, bytes: statSync(dest).size, ms: performance.now() - t0 };
  }

  close(): void {
    this.stmts.clear();
    try {
      if (!this.inMemory) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* 关闭时检查点失败不影响数据：WAL 里的提交下次打开会重放 */
    }
    this.db.close();
  }
}

/** 验证一份备份真的能恢复：能打开、结构完整、外键没有悬空。有问题就抛错。 */
export function verifyBackup(path: string): void {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').all() as Row[];
    const first = check[0] ? String(Object.values(check[0])[0]) : 'no result';
    if (first !== 'ok') throw new Error(`备份 ${path} 完整性检查失败：${first}`);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0) throw new Error(`备份 ${path} 有 ${fk.length} 处外键悬空`);
    const v = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (v < 1) throw new Error(`备份 ${path} 没有 schema`);
  } finally {
    db.close();
  }
}

/** JSON 列的读取：坏数据抛错而不是悄悄当成空对象。 */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  return JSON.parse(text) as T;
}
