/**
 * 世界数据库：本机 SQLite、单写入进程、WAL。数据库是真相源，内存里只有可以重建的缓存。
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
    throw new Error(`栖灯镇需要 Node 22.13 或更高版本（内置 node:sqlite）。当前 ${process.version}：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export type Row = Record<string, any>;
export type Param = SQLInputValue;

export const SCHEMA_VERSION = 2;

const MIGRATIONS: readonly string[] = [
  // ───── v1 ─────
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;

  CREATE TABLE worlds (
    world_id TEXT PRIMARY KEY,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    content_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_alive_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE principals (
    principal_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, subject)
  ) STRICT;

  CREATE TABLE residents (
    resident_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(world_id),
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
    street_id TEXT NOT NULL,
    house_no INTEGER NOT NULL,
    location_id TEXT NOT NULL,
    move_json TEXT,
    activity_id TEXT,
    context_version INTEGER NOT NULL DEFAULT 1,
    control_epoch INTEGER NOT NULL DEFAULT 0,
    controller_client TEXT,
    controller_until INTEGER NOT NULL DEFAULT 0,
    presence_epoch INTEGER NOT NULL DEFAULT 0,
    present_since INTEGER,
    present_ms INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    state_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE (world_id, principal_id),
    UNIQUE (world_id, street_id, house_no)
  ) STRICT;
  CREATE INDEX residents_location ON residents(world_id, location_id);
  CREATE INDEX residents_present ON residents(world_id, present_since) WHERE present_since IS NOT NULL;

  CREATE TABLE login_tickets (
    ticket_hash TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    world_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    active_world_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX sessions_principal ON sessions(principal_id);

  CREATE TABLE presence_leases (
    resident_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    boot_id TEXT NOT NULL,
    PRIMARY KEY (resident_id, client_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE rate_buckets (
    resident_id TEXT NOT NULL,
    bucket TEXT NOT NULL,
    tokens REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (resident_id, bucket)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE items (
    item_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    type TEXT NOT NULL,
    stack INTEGER NOT NULL CHECK (stack IN (0,1)),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= quantity),
    shelved INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    CHECK (stack = 1 OR quantity <= 1),
    CHECK (stack = 0 OR owner_id = holder_id)
  ) STRICT;
  CREATE UNIQUE INDEX items_stack ON items(owner_id, type) WHERE stack = 1;
  CREATE INDEX items_holder ON items(holder_id, type);
  CREATE INDEX items_owner ON items(owner_id, type);

  CREATE TABLE accounts (
    account_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    resident_id TEXT UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('resident','system')),
    balance INTEGER NOT NULL,
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    revision INTEGER NOT NULL DEFAULT 0,
    CHECK (kind = 'system' OR (balance >= 0 AND reserved <= balance))
  ) STRICT;

  CREATE TABLE ledger_transactions (
    transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL,
    cause_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE ledger_entries (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES ledger_transactions(transaction_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    delta INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ledger_entries_account ON ledger_entries(account_id, entry_id);

  CREATE TABLE resource_reservations (
    reservation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    holder_kind TEXT NOT NULL,
    holder_ref TEXT NOT NULL,
    resident_id TEXT NOT NULL,
    item_id TEXT,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0)
  ) STRICT;
  CREATE INDEX reservations_holder ON resource_reservations(holder_kind, holder_ref);
  CREATE INDEX reservations_resident ON resource_reservations(resident_id);

  CREATE TABLE shop_stock (
    shop_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    stock INTEGER NOT NULL CHECK (stock >= 0),
    stock_date TEXT NOT NULL,
    PRIMARY KEY (shop_id, sku)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE offers (
    offer_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('gift','trade','loan')),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    give_json TEXT NOT NULL,
    want_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','accepted','declined','cancelled','expired')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    close_reason TEXT
  ) STRICT;
  CREATE INDEX offers_to ON offers(to_id, status);
  CREATE INDEX offers_from ON offers(from_id, status);

  CREATE TABLE loans (
    loan_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(item_id),
    owner_id TEXT NOT NULL,
    borrower_id TEXT NOT NULL,
    via TEXT NOT NULL,
    lent_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    returned_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active','returned'))
  ) STRICT;
  CREATE UNIQUE INDEX loans_active_item ON loans(item_id) WHERE status = 'active';
  CREATE INDEX loans_borrower ON loans(borrower_id, status);
  CREATE INDEX loans_owner ON loans(owner_id, status);

  CREATE TABLE letters (
    letter_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    body TEXT NOT NULL,
    invite_grant_id TEXT,
    sent_at INTEGER NOT NULL,
    deliver_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    sender_deleted_at INTEGER,
    recipient_deleted_at INTEGER
  ) STRICT;
  CREATE INDEX letters_recipient ON letters(recipient_id, deliver_at);
  CREATE INDEX letters_sender ON letters(sender_id, sent_at);

  CREATE TABLE home_access_grants (
    grant_id TEXT PRIMARY KEY,
    home_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    guest_id TEXT NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('in_person','letter')),
    reentry INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    valid_from INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    learned_at INTEGER,
    entered_at INTEGER,
    exited_at INTEGER,
    revoked_at INTEGER
  ) STRICT;
  CREATE INDEX grants_guest ON home_access_grants(guest_id, expires_at);
  CREATE INDEX grants_home ON home_access_grants(home_id, expires_at);

  CREATE TABLE placed_objects (
    object_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    owner_id TEXT,
    config_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX placed_objects_space ON placed_objects(space_id);

  CREATE TABLE interactions (
    interaction_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    def_id TEXT NOT NULL,
    def_version INTEGER NOT NULL,
    def_json TEXT NOT NULL,
    object_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    initiator_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open','running','completed','cancelled')),
    free_inputs INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    lobby_expires_at INTEGER NOT NULL,
    started_at INTEGER,
    ends_at INTEGER,
    closed_at INTEGER,
    close_reason TEXT
  ) STRICT;
  CREATE UNIQUE INDEX interactions_object_active ON interactions(object_id) WHERE status IN ('open','running');
  CREATE INDEX interactions_space ON interactions(space_id, status);
  CREATE TABLE interaction_participants (
    interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id),
    resident_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    PRIMARY KEY (interaction_id, resident_id)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX interaction_one_active ON interaction_participants(resident_id) WHERE active = 1;

  CREATE TABLE relationships (
    resident_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    familiarity INTEGER NOT NULL DEFAULT 0,
    closeness INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (resident_id, other_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE interaction_counters (
    scope TEXT NOT NULL,
    category TEXT NOT NULL,
    business_date TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (scope, category, business_date)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE memory_refs (
    ref_id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    other_id TEXT,
    event_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX memory_owner_other ON memory_refs(owner_id, other_id, ref_id);
  CREATE INDEX memory_owner ON memory_refs(owner_id, ref_id);

  CREATE TABLE resident_goals (
    goal_id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL,
    def_id TEXT NOT NULL,
    def_version INTEGER NOT NULL,
    def_json TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('long','short')),
    progress_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','completed','replaced')),
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    completion_event_id INTEGER
  ) STRICT;
  CREATE INDEX goals_resident ON resident_goals(resident_id, status);

  CREATE TABLE mood_effects (
    mood_id INTEGER PRIMARY KEY AUTOINCREMENT,
    resident_id TEXT NOT NULL,
    mood TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_event_id INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX mood_resident ON mood_effects(resident_id, expires_at);

  CREATE TABLE titles (
    resident_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('public','personal')),
    source TEXT NOT NULL,
    awarded_at INTEGER NOT NULL,
    PRIMARY KEY (resident_id, title)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE world_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL,
    type TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
    occurred_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE INDEX world_events_time ON world_events(occurred_at);
  CREATE INDEX world_events_type ON world_events(type, occurred_at);
  CREATE TABLE event_parties (
    event_id INTEGER NOT NULL,
    resident_id TEXT NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (resident_id, event_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE recipient_events (
    resident_id TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    type TEXT NOT NULL,
    projection TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resident_id, cursor)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX recipient_events_created ON recipient_events(created_at);
  CREATE TABLE public_events (
    world_id TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    type TEXT NOT NULL,
    projection TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (world_id, cursor)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX public_events_created ON public_events(created_at);
  CREATE TABLE stream_heads (
    stream_key TEXT PRIMARY KEY,
    high_water INTEGER NOT NULL,
    retained_from INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE chat_messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    body TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX chat_messages_time ON chat_messages(sent_at);
  CREATE TABLE chat_audience (
    resident_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (resident_id, message_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE scheduled_jobs (
    job_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    due_at INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','done','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER
  ) STRICT;
  CREATE INDEX jobs_due ON scheduled_jobs(status, due_at, priority, job_id);

  CREATE TABLE activities (
    activity_id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    game_type TEXT NOT NULL,
    game_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('forming','ready','running','settling','completed','aborted')),
    host_id TEXT NOT NULL,
    options_json TEXT NOT NULL,
    origin_request_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    lobby_expires_at INTEGER NOT NULL,
    started_at INTEGER,
    deadline INTEGER,
    ended_at INTEGER,
    result_json TEXT,
    UNIQUE (host_id, origin_request_id)
  ) STRICT;
  CREATE INDEX activities_status ON activities(status);
  CREATE TABLE activity_participants (
    activity_id TEXT NOT NULL REFERENCES activities(activity_id),
    resident_id TEXT NOT NULL,
    game_seat INTEGER,
    confirmed INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    joined_at INTEGER NOT NULL,
    quit_at INTEGER,
    returned_at INTEGER,
    PRIMARY KEY (activity_id, resident_id)
  ) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX activity_one_active ON activity_participants(resident_id) WHERE active = 1;

  CREATE TABLE game_records (
    game_id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL UNIQUE REFERENCES activities(activity_id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    rng_state TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE settlements (
    activity_id TEXT PRIMARY KEY REFERENCES activities(activity_id),
    result_hash TEXT NOT NULL,
    outcome TEXT NOT NULL,
    settled_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE request_receipts (
    resident_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    context_version INTEGER NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (resident_id, request_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX receipts_expiry ON request_receipts(expires_at);

  CREATE TABLE business_keys (
    key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE notification_outbox (
    notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    destination TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX outbox_pending ON notification_outbox(sent_at, notification_id);

  CREATE TABLE public_event_instances (
    instance_id TEXT PRIMARY KEY,
    def_id TEXT NOT NULL,
    def_json TEXT NOT NULL,
    business_date TEXT NOT NULL,
    opens_at INTEGER NOT NULL,
    closes_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled','open','closed','missed')),
    progress INTEGER NOT NULL DEFAULT 0,
    target INTEGER NOT NULL DEFAULT 0,
    reached_at INTEGER,
    UNIQUE (def_id, business_date)
  ) STRICT;
  CREATE INDEX public_event_status ON public_event_instances(status, opens_at);
  CREATE TABLE event_participation (
    instance_id TEXT NOT NULL,
    resident_id TEXT NOT NULL,
    contributions INTEGER NOT NULL DEFAULT 0,
    rewarded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, resident_id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE daily_reports (
    scope TEXT NOT NULL,
    business_date TEXT NOT NULL,
    source_water INTEGER NOT NULL,
    version INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, business_date)
  ) STRICT, WITHOUT ROWID;
  `,
  // ───── v2 ─────
  // 按 event_id 反查当事人（个人日报、换日钩子、清理）；已有的 v1 库也要补上
  `
  CREATE INDEX IF NOT EXISTS event_parties_event ON event_parties(event_id, resident_id);
  `,
];

/** 故障注入点（只给恢复测试用）：在事务的指定位置抛错或杀进程。 */
export type Failpoint = (point: 'before_commit' | 'after_commit') => void;

export class TownDb {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly stmts = new Map<string, StatementSync>();
  private depth = 0;
  failpoint: Failpoint | null = null;
  /** 最近一次提交花了多久（毫秒），给指标用 */
  lastCommitMs = 0;

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 2000');
    this.db.exec('PRAGMA wal_autocheckpoint = 1000');
    this.migrate();
  }

  get inMemory(): boolean {
    return this.path === ':memory:';
  }

  userVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
  }

  private migrate(): void {
    const current = this.userVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(`世界数据库的 schema 版本（${current}）比这个程序认识的（${SCHEMA_VERSION}）新，拒绝打开以免写坏数据。`);
    }
    if (current === SCHEMA_VERSION) return;
    // 升级已有数据前先留一份可恢复的一致备份
    if (current > 0 && !this.inMemory) this.snapshotTo(`${this.path}.pre-v${current + 1}-${Date.now()}.bak`);
    for (let v = current; v < SCHEMA_VERSION; v++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw new Error(`世界数据库迁移到 v${v + 1} 失败，写接口不开放：${e instanceof Error ? e.message : String(e)}`);
      }
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
      const prefix = 'town-';
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
