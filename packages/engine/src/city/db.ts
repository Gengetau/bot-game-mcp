/**
 * 晴空都城市世界的数据库 schema。
 *
 * 用和栖灯镇同一个数据库外壳（world/db.ts 的 TownDb：单写入进程、WAL、写事务、迁移前备份），
 * 但是**独立的文件**、独立的迁移：冻结的栖灯镇库（town.db，schema v6）一个字节都不动，
 * 居民、账户、物品完全分开，旧镇币进不来（规格 4.1）。
 *
 * 钱只通过 ledger.ts 的 ledger() 变动（每笔分录平衡、原因键唯一），物品只通过 ledger.ts 的物品函数变动。
 * 桥接回执（bridge_receipts）和桥接 outbox（bridge_outbox）永久保存，不清理。
 */
import { TownDb, type SchemaSpec } from '../world/db.js';

const MIGRATIONS: readonly string[] = [
  // ───── v1 ─────
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;

  -- 主体：外部 bot 是 provider 'qq' / 'open'；小屋六位是 provider 'ai-house'、subject 为 actor_id
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
    principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id),
    name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    -- external：外部 bot（自己进城）；house：小屋的室友（只能经外出访问进城）
    origin TEXT NOT NULL CHECK (origin IN ('external','house')),
    -- 在某个地点时非空；在路上（trip_id 非空）或还没进过城时为空
    place_id TEXT,
    trip_id TEXT,
    -- 此刻是否在城里（在场）。外部 bot 由在场租约维持；室友由访问状态决定
    in_city INTEGER NOT NULL DEFAULT 0 CHECK (in_city IN (0,1)),
    present_until INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX residents_place ON residents(place_id) WHERE place_id IS NOT NULL;

  -- 身份映射：actor_id ↔ resident_id（规格 2.1）。一旦建立不改
  CREATE TABLE house_members (
    actor_id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL UNIQUE REFERENCES residents(resident_id),
    -- 见过的最大 domain_epoch：比它旧的代次一律拒绝
    last_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE accounts (
    account_id TEXT PRIMARY KEY,
    resident_id TEXT UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('resident','system')),
    -- 整数日元
    balance INTEGER NOT NULL,
    -- 被结果未知的交易锁住的钱（不能花，也带不回家）
    held INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
    revision INTEGER NOT NULL DEFAULT 0,
    CHECK (kind = 'system' OR (balance >= 0 AND held <= balance))
  ) STRICT;

  CREATE TABLE ledger_transactions (
    transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cause_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    -- 给人看的说法（「电车」「咖啡」），结算清单的花销汇总按它归并
    label TEXT NOT NULL,
    visit_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ledger_tx_visit ON ledger_transactions(visit_id) WHERE visit_id IS NOT NULL;
  CREATE TABLE ledger_entries (
    entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL REFERENCES ledger_transactions(transaction_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    delta INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX ledger_entries_account ON ledger_entries(account_id, entry_id);
  CREATE INDEX ledger_entries_tx ON ledger_entries(transaction_id);

  CREATE TABLE items (
    item_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES residents(resident_id),
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    -- 从小屋带出来的物品：内核资源 ID。城里得到的为空
    origin_ref TEXT,
    origin_json TEXT,
    -- 哪一次访问带来 / 得到的（外部 bot 的物品为空）
    visit_id TEXT,
    -- held：在身上可用；returned：已随结算回家；locker：留在寄存包裹，不可用
    state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held','returned','locker')),
    created_at INTEGER NOT NULL
  ) STRICT;
  -- 城里得到的同类物品在身上只有一堆；带出来的物品每件资源一行，不和别的合并
  CREATE UNIQUE INDEX items_plain_stack ON items(owner_id, type) WHERE origin_ref IS NULL AND state = 'held';
  CREATE INDEX items_owner ON items(owner_id, state);
  CREATE INDEX items_visit ON items(visit_id) WHERE visit_id IS NOT NULL;

  -- 物品的去向流水（结算清单从这里和 items 的余量算出来）
  CREATE TABLE item_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id TEXT,
    resident_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    origin_ref TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    fate TEXT NOT NULL CHECK (fate IN ('acquired','received','consumed','given','sold')),
    effect_id TEXT,
    counterparty TEXT,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX item_events_visit ON item_events(visit_id, event_id) WHERE visit_id IS NOT NULL;

  -- 买东西的订单。正常情况下建单和完成在同一个事务里；pending 是结果未知的交易（钱锁着，等对账）
  CREATE TABLE orders (
    order_id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL,
    visit_id TEXT,
    place_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    yen INTEGER NOT NULL CHECK (yen >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  ) STRICT;
  CREATE INDEX orders_pending ON orders(status, resident_id) WHERE status = 'pending';
  CREATE INDEX orders_visit ON orders(visit_id) WHERE visit_id IS NOT NULL;

  CREATE TABLE trips (
    trip_id TEXT PRIMARY KEY,
    resident_id TEXT NOT NULL REFERENCES residents(resident_id),
    visit_id TEXT,
    purpose TEXT NOT NULL CHECK (purpose IN ('travel','return')),
    from_place TEXT NOT NULL,
    to_place TEXT NOT NULL,
    legs_json TEXT NOT NULL,
    leg_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('running','arrived','stopped','cancelled','diverted')),
    stop_reason TEXT,
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    finished_at INTEGER,
    rule_version TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'simulated'
  ) STRICT;
  CREATE UNIQUE INDEX trips_one_running ON trips(resident_id) WHERE status = 'running';

  -- 外出访问（规格 3.3）。settlement_json 一旦写入不再改
  CREATE TABLE visits (
    visit_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    resident_id TEXT NOT NULL REFERENCES residents(resident_id),
    state TEXT NOT NULL CHECK (state IN ('prepared','active','returning','settling','settled','closed','reconcile','aborted')),
    protocol TEXT NOT NULL,
    vocab_version TEXT,
    city_catalog_version TEXT NOT NULL,
    mappings_version INTEGER NOT NULL,
    carry_yen INTEGER NOT NULL CHECK (carry_yen >= 0),
    carry_items_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    source_hold_ref TEXT,
    transfer_id TEXT UNIQUE,
    domain_epoch INTEGER,
    return_by_ms INTEGER NOT NULL,
    return_reason TEXT,
    settlement_id TEXT UNIQUE,
    settlement_json TEXT,
    purse_final_yen INTEGER,
    -- 还没折成 body_effect 的累计步行分钟
    walk_minutes INTEGER NOT NULL DEFAULT 0,
    -- effect_id / 进度记录的序号
    record_seq INTEGER NOT NULL DEFAULT 0,
    -- 有一条「听到有人说话」的 decision_wake 还没被她的下一个动作消化
    wake_chat_pending INTEGER NOT NULL DEFAULT 0,
    prepared_at INTEGER NOT NULL,
    committed_at INTEGER,
    returning_at INTEGER,
    settled_at INTEGER,
    released_at INTEGER,
    aborted_at INTEGER
  ) STRICT;
  -- 一位室友同一时刻最多一次没结束的访问
  CREATE UNIQUE INDEX visits_open_actor ON visits(actor_id) WHERE state IN ('prepared','active','returning','settling','settled');
  CREATE INDEX visits_state ON visits(state);

  CREATE TABLE visit_encounters (
    visit_id TEXT NOT NULL,
    other_id TEXT NOT NULL,
    she_spoke INTEGER NOT NULL DEFAULT 0,
    other_spoke INTEGER NOT NULL DEFAULT 0,
    emitted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (visit_id, other_id)
  ) STRICT, WITHOUT ROWID;

  -- 桥接请求的回执：永久保存（规格 3.2）。同请求号同内容返回原回执，同请求号不同内容 409
  CREATE TABLE bridge_receipts (
    request_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL UNIQUE,
    op TEXT NOT NULL,
    visit_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    response TEXT NOT NULL
  ) STRICT;
  CREATE INDEX bridge_receipts_visit ON bridge_receipts(visit_id, accepted_at_ms);

  -- 桥接 outbox：内核按 seq 游标拉取。永久保存
  CREATE TABLE bridge_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL UNIQUE,
    occurred_at_ms INTEGER NOT NULL,
    payload TEXT NOT NULL
  ) STRICT;
  CREATE INDEX bridge_outbox_visit ON bridge_outbox(visit_id, seq);

  -- 外部 bot 的动作回执（会过期，只管重试）
  CREATE TABLE request_receipts (
    resident_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
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

  -- 令牌桶（听到说话被叫醒的额度、聊天频率）
  CREATE TABLE rate_buckets (
    subject TEXT NOT NULL,
    bucket TEXT NOT NULL,
    tokens REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (subject, bucket)
  ) STRICT, WITHOUT ROWID;
  -- 滑动窗口计数（每小时 / 每天几次动作）：一次动作一行，过了最长的窗口就清掉
  CREATE TABLE rate_log (
    subject TEXT NOT NULL,
    bucket TEXT NOT NULL,
    at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX rate_log_idx ON rate_log(subject, bucket, at);

  CREATE TABLE resident_events (
    resident_id TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    type TEXT NOT NULL,
    projection TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resident_id, cursor)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX resident_events_created ON resident_events(created_at);
  CREATE TABLE public_events (
    cursor INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    projection TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX public_events_created ON public_events(created_at);
  CREATE TABLE stream_heads (
    stream_key TEXT PRIMARY KEY,
    high_water INTEGER NOT NULL,
    retained_from INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE chat_messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id TEXT NOT NULL,
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

  -- 天气快照：每片一行（规格 5.1）
  CREATE TABLE weather_snapshots (
    area TEXT PRIMARY KEY,
    observed_at_ms INTEGER NOT NULL,
    fetched_at_ms INTEGER NOT NULL,
    -- 最近一次真的抓到的时刻（判断 stale / fallback 用）
    last_ok_at_ms INTEGER,
    code INTEGER NOT NULL,
    temp_c REAL NOT NULL,
    precip_mm REAL NOT NULL,
    rain INTEGER NOT NULL CHECK (rain IN (0,1)),
    source TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','stale','fallback')),
    hourly_json TEXT NOT NULL DEFAULT '[]'
  ) STRICT, WITHOUT ROWID;

  -- 当日公开事件（天气转变、晴天的小事件）：每片每天每种一条
  CREATE TABLE city_events (
    event_id TEXT PRIMARY KEY,
    def_id TEXT NOT NULL,
    area TEXT NOT NULL,
    place_id TEXT,
    business_date TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (def_id, area, business_date)
  ) STRICT;
  CREATE INDEX city_events_date ON city_events(business_date);

  CREATE TABLE reconcile_reports (
    report_id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    ok INTEGER NOT NULL CHECK (ok IN (0,1)),
    findings_json TEXT NOT NULL
  ) STRICT;
  `,
  // ───── v2 ─────
  // M1：三类主体（external / house / human）与客户端控制代次（control_epoch / controller_id）、
  // 人类一次性登录票据与网页会话、两类物品身份（instance / meta_json / borrowed_from / disposed / space）与储物柜去向流水。
  `
  CREATE TABLE residents_v2 (
    resident_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE REFERENCES principals(principal_id),
    name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL CHECK (origin IN ('external','house','human')),
    place_id TEXT,
    trip_id TEXT,
    in_city INTEGER NOT NULL DEFAULT 0 CHECK (in_city IN (0,1)),
    present_until INTEGER NOT NULL DEFAULT 0,
    control_epoch INTEGER NOT NULL DEFAULT 0,
    controller_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO residents_v2(resident_id, principal_id, name, bio, origin, place_id, trip_id, in_city, present_until, control_epoch, controller_id, revision, created_at, last_seen_at)
    SELECT resident_id, principal_id, name, bio, origin, place_id, trip_id, in_city, present_until, 0, NULL, revision, created_at, last_seen_at
    FROM residents;
  DROP TABLE residents;
  ALTER TABLE residents_v2 RENAME TO residents;
  CREATE INDEX residents_place ON residents(place_id) WHERE place_id IS NOT NULL;

  CREATE TABLE login_tickets (
    ticket_hash TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES principals(principal_id),
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX web_sessions_principal ON web_sessions(principal_id);

  CREATE TABLE items_v2 (
    item_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES residents(resident_id),
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    instance INTEGER NOT NULL DEFAULT 0 CHECK (instance IN (0,1)),
    origin_ref TEXT,
    origin_json TEXT,
    meta_json TEXT,
    borrowed_from TEXT REFERENCES residents(resident_id),
    visit_id TEXT,
    state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held','returned','locker','disposed','space')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (instance = 0 OR quantity <= 1)
  ) STRICT;
  INSERT INTO items_v2(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at)
    SELECT item_id, owner_id, type, quantity,
           CASE WHEN origin_ref IS NOT NULL AND quantity <= 1 THEN 1 ELSE 0 END,
           origin_ref, origin_json, NULL, NULL, visit_id, state, created_at, created_at
    FROM items;
  DROP TABLE items;
  ALTER TABLE items_v2 RENAME TO items;
  CREATE UNIQUE INDEX items_plain_stack ON items(owner_id, type) WHERE origin_ref IS NULL AND instance = 0 AND state = 'held';
  CREATE INDEX items_owner ON items(owner_id, state);
  CREATE INDEX items_visit ON items(visit_id) WHERE visit_id IS NOT NULL;

  CREATE TABLE item_events_v2 (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    visit_id TEXT,
    resident_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    origin_ref TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    fate TEXT NOT NULL CHECK (fate IN ('acquired','received','consumed','given','sold','stored','retrieved','disposed','loaned','returned_loan','crafted','placed')),
    effect_id TEXT,
    counterparty TEXT,
    at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO item_events_v2(event_id, visit_id, resident_id, item_id, type, origin_ref, quantity, fate, effect_id, counterparty, at)
    SELECT event_id, visit_id, resident_id, item_id, type, origin_ref, quantity, fate, effect_id, counterparty, at
    FROM item_events;
  DROP TABLE item_events;
  ALTER TABLE item_events_v2 RENAME TO item_events;
  CREATE INDEX item_events_visit ON item_events(visit_id, event_id) WHERE visit_id IS NOT NULL;
  `,
  // ───── v3 ─────
  // M3-C + M3-D：漂流文库本（shelf / drift 态）、招领态（lost_found）、储物柜凭条寄存（locker_deposits）、个人车站印章帐（resident_stamps）与激活目录版本历史表（catalog_versions）
  `
  CREATE TABLE items_v3 (
    item_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES residents(resident_id),
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    instance INTEGER NOT NULL DEFAULT 0 CHECK (instance IN (0,1)),
    origin_ref TEXT,
    origin_json TEXT,
    meta_json TEXT,
    borrowed_from TEXT REFERENCES residents(resident_id),
    visit_id TEXT,
    state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held','returned','locker','disposed','space','shelf','drift','lost_found')),
    shelf_place_id TEXT,
    shelf_price_yen INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (instance = 0 OR quantity <= 1)
  ) STRICT;
  INSERT INTO items_v3(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, shelf_place_id, shelf_price_yen, created_at, updated_at)
    SELECT item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, NULL, NULL, created_at, updated_at
    FROM items;
  DROP TABLE items;
  ALTER TABLE items_v3 RENAME TO items;
  CREATE UNIQUE INDEX items_plain_stack ON items(owner_id, type) WHERE origin_ref IS NULL AND instance = 0 AND state = 'held';
  CREATE INDEX items_owner ON items(owner_id, state);
  CREATE INDEX items_visit ON items(visit_id) WHERE visit_id IS NOT NULL;
  CREATE INDEX items_shelf ON items(state, shelf_place_id) WHERE state IN ('shelf','drift');

  CREATE TABLE locker_deposits (
    deposit_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(item_id),
    sender_id TEXT NOT NULL REFERENCES residents(resident_id),
    recipient_id TEXT REFERENCES residents(resident_id),
    voucher_hash TEXT,
    place_id TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL CHECK (status IN ('active','claimed','expired_returned','expired_lost_found')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    resolved_at INTEGER,
    claimed_by TEXT REFERENCES residents(resident_id)
  ) STRICT;
  CREATE INDEX locker_deposits_sender ON locker_deposits(sender_id, status);
  CREATE INDEX locker_deposits_recipient ON locker_deposits(recipient_id, status) WHERE recipient_id IS NOT NULL;
  CREATE INDEX locker_deposits_expiry ON locker_deposits(status, expires_at) WHERE status = 'active';
  CREATE UNIQUE INDEX locker_deposits_voucher ON locker_deposits(voucher_hash) WHERE voucher_hash IS NOT NULL;

  CREATE TABLE resident_stamps (
    resident_id TEXT NOT NULL REFERENCES residents(resident_id),
    station_id TEXT NOT NULL,
    stamp_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    stamped_at INTEGER NOT NULL,
    visit_id TEXT,
    PRIMARY KEY (resident_id, station_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX resident_stamps_time ON resident_stamps(resident_id, stamped_at);

  CREATE TABLE catalog_versions (
    catalog_version TEXT PRIMARY KEY,
    fare_rule_version TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    activated_at INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
  `,
  // v4：S1 自研天象拨盘（当前覆盖行与幂等回执审计，不写 scheduled_jobs）
  `
  CREATE TABLE weather_overrides (
    area TEXT PRIMARY KEY,
    preset TEXT NOT NULL,
    code INTEGER NOT NULL,
    temp_c REAL,
    precip_mm REAL NOT NULL,
    rain INTEGER NOT NULL CHECK (rain IN (0, 1)),
    breeze_level TEXT,
    reason TEXT,
    actor_tag TEXT NOT NULL,
    starts_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE weather_override_receipts (
    request_id TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    actor_tag TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
  `,
  // v5：M3-B 桌游茶屋牌桌与旧物密封竞拍会（venue_* 四张表）
  `
  CREATE TABLE venue_tables (
    table_id TEXT PRIMARY KEY,
    place_id TEXT NOT NULL,
    game_type TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('forming','running','completed','aborted')),
    host_id TEXT NOT NULL REFERENCES residents(resident_id),
    game_id TEXT,
    record_json TEXT,
    rng_state TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    abort_reason TEXT
  ) STRICT;
  CREATE INDEX venue_tables_place ON venue_tables(place_id, status);

  CREATE TABLE venue_table_seats (
    table_id TEXT NOT NULL REFERENCES venue_tables(table_id),
    resident_id TEXT NOT NULL REFERENCES residents(resident_id),
    game_seat INTEGER,
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    leave_reason TEXT,
    PRIMARY KEY (table_id, resident_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX venue_table_seats_resident ON venue_table_seats(resident_id, left_at);

  CREATE TABLE venue_auctions (
    auction_id TEXT PRIMARY KEY,
    place_id TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(item_id),
    item_name TEXT NOT NULL,
    item_type TEXT NOT NULL,
    reserve_yen INTEGER NOT NULL DEFAULT 100 CHECK (reserve_yen >= 0),
    price_mode TEXT NOT NULL DEFAULT 'first' CHECK (price_mode IN ('first','second')),
    status TEXT NOT NULL CHECK (status IN ('open','settled','unsold','cancelled')),
    opens_at INTEGER NOT NULL,
    closes_at INTEGER NOT NULL,
    settled_at INTEGER,
    winner_id TEXT,
    winning_price INTEGER,
    tie_broken INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX venue_auctions_place ON venue_auctions(place_id, status);

  CREATE TABLE venue_auction_bids (
    auction_id TEXT NOT NULL REFERENCES venue_auctions(auction_id),
    resident_id TEXT NOT NULL REFERENCES residents(resident_id),
    bid_yen INTEGER NOT NULL CHECK (bid_yen > 0),
    held_yen INTEGER NOT NULL CHECK (held_yen >= 0),
    visit_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','withdrawn','won','lost','refunded')),
    placed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (auction_id, resident_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX venue_auction_bids_resident ON venue_auction_bids(resident_id, status);
  `,
  // v6：S2 场所异步留痕（place_traces）、独立日用量计数（place_trace_daily_usage）与室友便签回响收件表（house_trace_replies，高水位存于 meta['trace_reply_high_water']）
  `
  CREATE TABLE place_traces (
    trace_id TEXT PRIMARY KEY,
    place_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_origin TEXT NOT NULL CHECK (author_origin IN ('house', 'external', 'human')),
    body TEXT NOT NULL,
    reply_to TEXT,
    visit_id TEXT,
    business_date TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX place_traces_place_time ON place_traces(place_id, created_at_ms DESC);
  CREATE INDEX place_traces_author_day ON place_traces(author_id, business_date);

  CREATE TABLE place_trace_daily_usage (
    author_id TEXT NOT NULL,
    business_date TEXT NOT NULL,
    place_id TEXT NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    PRIMARY KEY (author_id, business_date, place_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX place_trace_daily_usage_date ON place_trace_daily_usage(business_date);

  CREATE TABLE house_trace_replies (
    reply_seq INTEGER PRIMARY KEY,
    target_actor_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    reply_trace_id TEXT NOT NULL UNIQUE,
    place_id TEXT NOT NULL,
    place_name TEXT NOT NULL,
    reply_author_name TEXT NOT NULL,
    reply_origin TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX house_trace_replies_actor ON house_trace_replies(target_actor_id, reply_seq);
  `,
];

export const CITY_SCHEMA: SchemaSpec = { label: '城市世界数据库', migrations: MIGRATIONS, backupPrefix: 'city-' };
export const CITY_SCHEMA_VERSION = MIGRATIONS.length;

export function openCityDb(path: string): TownDb {
  return new TownDb(path, CITY_SCHEMA);
}
