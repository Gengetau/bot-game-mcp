# 灯都城市世界（`city`）两类物品身份、储物柜流转与跨库结算规范

- **文档编号**：`docs/city/ITEM-AND-LOCKER-SPEC.md`（M0 四份冻结契约之一）
- **状态**：M0 候选定稿（内核侧与跨库结算主笔：`gemini4-ext`；引擎侧 Schema v2 / 动作实现共编：`gemini3-ext`）
- **锁定基线**：引擎 `Gengetau/bot-game-mcp` + 小屋内核 `world-kernel/life1`（`mappings_version: 3`，协议 `city-bridge/1`）
- **配套机器契约**：`docs/city/bridge-v1.schema.json`、`docs/city/mappings.json`

---

## 1. 两类物品身份模型（解决堆叠抹除个体身份隐患）

现行 `c8148df` 对所有 `origin_ref IS NULL` 的持有物品共用单一唯一索引，且 `give` 采用“扣减原行 + 给接收方合并堆叠行”。自 M0/M1（`city.db` Schema v2）起，城市内全部物品严格划分为**标准可堆叠件（`instance = 0`）**与**具名实例件（`instance = 1`）**两类。

### 1.1 两类物品对比与数据库约束（Schema v2）

| 维度 | 标准可堆叠件（`instance = 0`） | 具名实例件（`instance = 1`） |
|---|---|---|
| **适用范围** | 无个体差异的包装食品/饮品（曲奇、饭团、瓶装绿茶、现点咖啡/奶茶、面包、蛋糕）、咖啡豆、全新空白明信片、全新未批注文库本/笔记本、M2 未加工原料 | 1. **所有从小屋带出的物品**（`origin_ref IS NOT NULL`）；<br>2. 写过正文的明信片（`write_postcard`）；<br>3. 带阅读进度/批注的书籍（`read_item`）与写过游记的笔记本（`write_note`）；<br>4. 处于借阅/借用关系（`borrowed_from IS NOT NULL`）的雨伞或书籍；<br>5. M2 手工定制成品与 M3 摆入个人空间展示槽的作品 |
| **`quantity` 约束** | 正整数（消费完归 `0`）；同类同状态合并记数 | **恒为 `1`**（创建后永不与其他行合并） |
| **部分唯一索引** | `items_plain_stack`：`UNIQUE(owner_id, type) WHERE origin_ref IS NULL AND instance = 0 AND state = 'held'`（储物柜内同类堆叠件按 `(owner_id, type, state = 'locker', instance = 0)` 合并或设对应唯一索引） | 不受 `items_plain_stack` 限制，每件独占一行永久 `item_id` |
| **流转操作规则** | `give` / `store_locker` / `take_locker` / M2 `trade` 按 `qty` 扣减源行并合入目标堆叠行 | **严禁销毁重建！**在 `give`、借出/归还、`store_locker` / `take_locker`、M3 个人空间陈设时，**直接在同一 `item_id` 行上原子更新 `owner_id`、`state`、`borrowed_from` 或 `meta_json`**，`item_id` 与 `origin_ref` 终身不变 |
| **堆叠件升级为具名件** | 玩家对堆叠中的 1 件空白明信片/书籍/笔记本执行书写或批注，或将其借出时：原堆叠行 `quantity - 1`，同事务新建一行 `instance = 1, quantity = 1` 的具名实例件 | 已是 `instance = 1` 的物品永不降级回 `instance = 0` |

### 1.2 `items` 表扩展列与 `meta_json` 标准结构（M1–M3 预留）

- **Schema v2 `items` 表列定义**：
  - `instance INTEGER NOT NULL DEFAULT 0 CHECK (instance IN (0, 1))`
  - `meta_json TEXT`（`instance = 0` 时为 `NULL`；`instance = 1` 时为结构化 JSON 字符串）
  - `borrowed_from TEXT REFERENCES residents(resident_id)`（借用来源居民 ID，非借用物为 `NULL`；借用中的物品禁止转赠第三人或出售，仅允许 `return_item` 归还原主）
  - `state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'returned', 'locker', 'disposed', 'space'))`（M1 使用 `'held' | 'returned' | 'locker' | 'disposed'`；预留 M3 `'space'` 表示陈设在个人空间/公共展示槽）
  - `updated_at INTEGER NOT NULL`、`CHECK (instance = 0 OR quantity <= 1)`
- **`item_events.fate` 枚举扩充（Schema v2）**：
  - `'acquired' | 'received' | 'consumed' | 'given' | 'sold' | 'stored' | 'retrieved' | 'disposed' | 'loaned' | 'returned_loan' | 'crafted' | 'placed'`
- **`meta_json` 规范字段（所有用户生成文本入库前必须经 `sanitizeUserText` 清洗，出库进 AI 视图时标 `untrusted: true`）**：
  ```json
  {
    "title": "可选标题（最多 40 字，untrusted）",
    "summary": "正文摘要/批注/明信片留言（最多 300 字，untrusted）",
    "author_id": "res_...",
    "author_name": "创作者显示名",
    "created_at_ms": 1794930000000,
    "reading_progress": 1,
    "location_ref": "space:res_...:slot_1",
    "untrusted": true
  }
  ```

### 1.3 Schema v2 完整 SQL 建表参考与多份携带物拆分规则（引擎侧 M1-D 落地基准）

- **多份带出物兼容规则**：协议允许 `carry.items[].qty` 取 `1..99`。当 `qty === 1` 时直接建 `instance = 1`；当 `qty > 1` 时建 `instance = 0, origin_ref = ref`，若整行全额赠送则原地更新 `owner_id` 保留原 `item_id` 与 `origin_ref`，若部分赠送（如 3 送 1）则原行减 `1`、拆出的受赠新行完整继承 `origin_ref` 与 `origin_json`，绝不退化为无来源普通堆叠件。
- **Schema v2 目标 DDL 参考（SQLite 重建表迁移保留全部存量数据）**：
  ```sql
  CREATE TABLE residents (
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

  CREATE TABLE items (
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
  CREATE UNIQUE INDEX items_plain_stack
    ON items(owner_id, type)
    WHERE origin_ref IS NULL AND instance = 0 AND state = 'held';
  ```

---

## 2. 映射表 `mappings_version: 2` 与现点热饮 `carry_home: false` 规则

### 2.1 首发 13 类城市物品全属性与跨界规则表

| `engine_type` | 中文名 | 目录 `kind` | 默认 `instance` | `carry_home` | 可存 `locker` | `mappings.json`（`v2`）方向与内核对应资源 | 室友未消费留存至返家的结算 `fate` |
|---|---|---|---|---|---|---|---|
| `cookie` | 曲奇 | `food` | `0`（单件带出物为 `1`） | `true` | `true`（仅城内获得件；家带出物禁存） | **双向** ↔ `food/cookie` | `'back'`（回到家庭库存） |
| `onigiri` | 饭团 | `food` | `0`（单件带出物为 `1`） | `true` | `true`（仅城内获得件；家带出物禁存） | **双向** ↔ `food/onigiri` | `'back'` |
| `green_tea` | 瓶装绿茶 | `drink` | `0`（单件带出物为 `1`） | `true` | `true`（仅城内获得件；家带出物禁存） | **双向** ↔ `food/bottled_tea` | `'back'` |
| `coffee_beans` | 咖啡豆 | `thing` | `0` | `true` | `true` | **只回家（`direction: "home"`）** → `food/coffee` | `'back'`（转为内核一包咖啡） |
| `melon_pan` | 菠萝包 | `food` | `0` | `true` | `true` | **只回家（`direction: "home"`）** → `food/bread` | `'back'` |
| `cream_bun` | 奶油面包 | `food` | `0` | `true` | `true` | **只回家（`direction: "home"`）** → `food/bread` | `'back'` |
| `cheesecake` | 芝士蛋糕 | `food` | `0` | `true` | `true` | **只回家（`direction: "home"`）** → `food/dessert` | `'back'` |
| `coffee` | 混合咖啡（现点杯装） | `drink` | `0` | **`false`** | **`false`** | 不映射（堂食/随身即饮，非内核袋装咖啡粉） | **`'disposed'`**（返家前清理，不进储物柜、不写身体效果） |
| `milk_tea` | 皇家奶茶（现点杯装） | `drink` | `0` | **`false`** | **`false`** | 不映射（堂食/随身即饮） | **`'disposed'`**（返家前清理，不进储物柜、不写身体效果） |
| `umbrella` | 透明雨伞 | `thing` | `0`（借出时 `1`） | `true`（城内可携；无 `life1` 映射） | **`true`** | 不映射（内核雨伞属衣橱 `garments` 而非食物资源） | **`'locker'`**（存入城市储物柜，访问正常 `closed`） |
| `paperback` | 文库本 | `thing` | `0`（批注/借出 `1`） | `true`（城内可携；无 `life1` 映射） | **`true`** | 不映射 | **`'locker'`**（存入城市储物柜，访问正常 `closed`） |
| `postcard` | 明信片 | `thing` | `0`（书写后 `1`） | `true`（城内可携；无 `life1` 映射） | **`true`** | 不映射 | **`'locker'`**（存入城市储物柜，访问正常 `closed`） |
| `notebook` | 笔记本 | `thing` | `0`（书写后 `1`） | `true`（城内可携；无 `life1` 映射） | **`true`** | 不映射 | **`'locker'`**（存入城市储物柜，访问正常 `closed`） |

> **M2 扩展准则**：M2 扩充至 30–50 类物品时，凡现点现做堂食热饮/汤品均在目录元数据声明 `carry_home: false`；凡包装食材/点心如需带回小屋，须同步递增 `mappings_version` 并补齐 `life1` 对应映射；其余城市专属书籍、手作、收藏品默认落入城市储物柜或 M3 个人空间。

### 2.2 现点杯装热饮（`carry_home: false`）完整行为规则

1. **目录与视图标识**：
   - `catalog.ts` 的 `ITEM_TYPES` 为 `coffee` 与 `milk_tea` 显式标记 `carry_home: false`（其余物品默认 `carry_home: true`），并通过 `GET /city/bridge/v1/catalog` 的 `item_types[]` 暴露给内核与前端。
   - `selfView.items[]` 对 `carry_home === false` 的条目输出 `carry_home: false`（对室友同时 `can_go_home: false`），让 AI 与真人直观获知“现点饮品需在城内饮用或送人，不能寄存或带回家”。
2. **禁止存入储物柜**：
   - 三类玩家对 `carry_home === false` 的物品调用 `store_locker` 时，一律返回 `422 PRECONDITION_FAILED`（`reason: "not_storable"`）。
3. **返家结算（`settle()`）处理铁律**：
   - 当室友到达 `hiwatari:ai-house:entrance` 生成 `Settlement` 时，若身上仍有未喝完的 `carry_home === false` 饮品：
     - `Settlement.items[]` 记录该条目 `fate: "disposed"`（并在可选 `Settlement.notes[]` 附一句说明，如 `"未饮完的混合咖啡已在返家前处理，未带回或寄存"`）；
     - **绝不生成 `body_effect`、绝不计入 `Settlement.consumed[]`**（严格遵守产品铁律 1.2：未主动 `consume` 绝不代喝）；
     - 物品库存清零（扣减 `quantity` 或在 `releaseVisit` 时置 `state = 'disposed'`），**不写入 `state = 'locker'`**，访问在无 `pending` 订单时正常关闭为 `closed`。

---

## 3. 城市储物柜（`locker`）正常化与未决异常订单（`pending`）解耦

### 3.1 储物柜存取动作契约（`store_locker` / `take_locker`）

三类玩家（室友、外部 Bot、人类网页玩家）共用同一套储物柜规则：

- **可用地点**：各车站大厅（`place.type === 'station'`，如 `hiwatari:station`、`kagamiike:station`、`sentou:station`，以及后续内容包新增车站）与 M3 个人空间（`personal_spaces`）。在非车站/非个人空间地点调用返回 `422 PRECONDITION_FAILED`（`reason: "not_at_locker"`）；乘车途中返回 `422 PRECONDITION_FAILED / in_transit`；室友在 `returning` 阶段不可存取（`409 VISIT_NOT_ACTIVE / returning`）。
- **本人视图新增字段 `selfView.locker_items`**：
  - 始终返回当前居民名下 `state = 'locker' AND quantity > 0` 的物品列表（无论本人此刻是否站在车站，均可查看自己柜中有什么；但只有站在车站/个人空间时 `selfView.can` 才包含 `'store_locker'` / `'take_locker'`）：
    ```json
    [
      {
        "item_id": "it_...",
        "type": "paperback",
        "name": "文库本",
        "qty": 1,
        "instance": true,
        "meta": { "title": "雪国", "reading_progress": 1, "untrusted": true }
      }
    ]
    ```
- **动作参数与语义**：
  1. `{"type": "store_locker", "item_id"?: string, "item"?: string, "qty"?: 1..99}`：
     - 校验非 `carry_home: false` / `storable: false`（否则 `422 PRECONDITION_FAILED / not_storable`）；
     - **带出物禁存规则**：小屋室友从家里带出的随身物品（`origin_ref !== null`）禁止手动存入公共车站储物柜（返回 `422 PRECONDITION_FAILED / carried_from_home`），确保家域冻结资源在当次访问结束时必有明确终态（`back` 解冻或 `consumed`/`given` 核销），永不跨访问悬空；
     - 容量上限校验（默认 `maxLockerEntries = 30`、`maxLockerQty = 200`，超限返回 `422 PRECONDITION_FAILED / locker_full`）；
     - 若目标为 `instance = 1`：原地 `UPDATE items SET state = 'locker', updated_at = now WHERE item_id = ?`，记 `item_events(fate = 'stored')`；
     - 若目标为 `instance = 0`：扣减随身堆叠行 `qty`，合并入 `(owner_id, type, state = 'locker', instance = 0)` 储物柜堆叠行，记 `item_events(fate = 'stored')`。
  2. `{"type": "take_locker", "item_id"?: string, "item"?: string, "qty"?: 1..99}`：
     - 从本人 `state = 'locker'` 中取出指定 `item_id` 或 `type`；
     - 若为 `instance = 1`：原地 `UPDATE items SET state = 'held', visit_id = <当前活跃 visit_id 或 NULL> WHERE item_id = ?`，记 `item_events(fate = 'retrieved')`；
     - 若为 `instance = 0`：扣减柜内堆叠行并合入随身 `state = 'held'` 堆叠行（`visit_id` 更新为当前活跃 `visit_id` 或 `NULL`），记 `item_events(fate = 'retrieved')`。

### 3.2 `locker` 与异常态 `reconcile` 彻底解耦

| 返家结算情形 | `Settlement` 表现 | `releaseVisit()` 后的 `visits.state` | 对账报告 `runReconcile()` |
|---|---|---|---|
| 无 `locker` 物品、无 `pending` 订单 | `items[].fate` 仅含 `back / consumed / given / sold / disposed`，`pending = []` | **`'closed'`** | `ok: true`，无异常提示 |
| **有 `fate = 'locker'` 物品，但 `pending = []`**（例如买了文库本/雨伞/明信片带不回 `life1`） | 未映射物品 `fate = 'locker'`，物品转入本人城市储物柜（`items.state = 'locker'`） | **`'closed'`（正常完结！）** | `ok: true`，**不再报 `visit_needs_attention`** |
| **存在 `pending.length > 0` 未决异常订单**（`accounts.held > 0`） | `pending` 列出未知订单，`purse_final_yen = balance - held` | **`'reconcile'`（异常待对账）** | `info: visit_needs_attention`（仅统计未决 `pending_orders`） |

### 3.3 未决订单（`orders.status = 'pending'`）跨关单结算流程

在 `c8148df` 中，`resolvePendingOrder` 在访问已进入 `reconcile / closed` 后会抛 `visit_closed` 拒绝处理。M1-D 按以下平衡账本规则补齐跨关单结算能力（并挂载受保护运维入口）：

1. **若裁定为 `'completed'`（店家实际已成交）**：
   - `unhold(resident_id, order.yen)`；
   - 记平衡账 `cause_key = 'order:<order_id>'`：`acct:<resident_id> (-yen)` → `sys:shops (+yen)`；
   - 发放商品：若该居民此刻在城（`in_city = 1`），物品入 `state = 'held'`；若该室友已返家不在城（访问已 `reconcile / closed`），若商品 `carry_home === false` 则直接记 `disposed`，否则直接入该居民城市储物柜（`state = 'locker'`，下次进城可取），绝不凭空丢物；
   - 更新 `orders.status = 'completed'`。
2. **若裁定为 `'failed'`（店家未成交，解锁退款）**：
   - `unhold(resident_id, order.yen)`，更新 `orders.status = 'failed'`；
   - 对外部 Bot / 人类居民：解锁后日元直接回到其 `acct:<resident_id>` 可用余额；
   - 对**访问已关单（`reconcile / closed`）的小屋室友**（注：`settled` 且尚未 `release` 的短暂窗口返回 `409 CONFLICT / awaiting_release`，待内核按固化 `settlement_json` 完成 `release` 后再调）：为满足对账不变量 `purse_not_empty_at_home`，同事务记一笔退款回桥接池分录 `cause_key = 'order:<order_id>:refund_bridge'`（`acct:<resident_id> -yen` → `bridge:ai-house +yen`），并写入一条 `bridge_outbox` **`order_refunded`**（`record_id = '<visit_id>:refund:<order_id>'`，载荷 `{ actor_id, order_id, yen, all_pending_cleared }`）供内核按 `record_id` 幂等入账 `wallet_entries(entry_key = 'visit:<visit_id>:pending_refund:<order_id>', delta = +yen)`；当 `all_pending_cleared === true` 时，引擎与内核两侧同步将该访问从 `'reconcile'` 收口为 `'closed'`。

---

## 4. 小屋内核（`world-kernel/life1`）物品托管与返家结算规范（内核侧核心契约）

### 4.1 出门前检查、雨天 F13 与家庭资产冻结（事务 `T1`）

1. **出门前置拉取与版本校验（避免 T1 冻结后再遇版本不兼容）**：
   - 出发前先只读请求 `GET /city/bridge/v1/catalog` 与 `GET /city/bridge/v1/weather`：
     - 校验 `catalog.protocol === 'city-bridge/1'` 且 `catalog.mappings.version === 2`（不匹配则在冻结前直接拒绝出门并记审计 `VERSION_MISMATCH`，零状态变更）；
     - **执行 F13 雨天规则**：查询目的地所属片区（`place.area`）在 `/weather` 快照中的 `rain` 布尔值（以及目的地 `rain === 'closed'` 策略）。若目的地片区正在下雨且 `Outings.rain_ready(actor)` 为 `False`（身上未打伞且衣橱无自有雨伞，注意阳伞 `parasol` 不算雨具），**在冻结任何现金与物品之前直接取消本次外出计划**（原因 `'rain_requires_owned_umbrella'`）。
2. **可携带物品筛选与托管冻结（`carry.items`）**：
   - 仅允许携带 `mappings.json`（`version = 2`）中**双向映射**（无 `direction: "home"`）的家庭可用食物资源：`food/cookie`、`food/onigiri`、`food/bottled_tea`（单角色试点 Q5 默认：妮娅 `nia` 带 `¥20,000` 与 `1` 件可用零食）。
   - 选定家庭 `resources` 行（须满足 `free_qty = qty - held >= carry_qty` 且未被其他动作占用）后，在单库事务 `T1` 内原子完成：
     - **现金冻结**：`Wallet.hold(f'visit:{visit_id}', actor_id, carry_yen)`（要求 `carry_yen >= 往返车费 + 安全余量` 且不超过个人可用余额）；
     - **物品托管锁**：在 `reservations` 表写入 `reservation_id = f'city:{visit_id}:{ref}'`、`action_id = f'visit:{visit_id}'`、`resource_id = <家庭资源ID>`、`qty = carry_qty`、`consume = 0`、`state = 'held'`（同时记入 `city_item_custody` 明细表绑定 `visit_id`、`ref`、`resource_id`、`qty`、`status = 'in_city'`）。**不直接扣减 `resources.qty`**，但因 `held` 增加，家庭做饭、进食、主人赠送与库存修改均自动感知 `in_use` 不可动用；
     - **状态与移动**：创建 `city_visits(state = 'preparing')`，触发 `living → away` 移动。
   - **单件实例对齐建议**：为严格对齐引擎侧 `instance = 1`（`quantity = 1`），内核每次带出默认按单件粒度构造 `carry.items[]`（若同一 `resource_id` 需带多件，使用 `<resource_id>#1`、`<resource_id>#2` 作为桥接 `ref`，并在 `city_item_custody` 映射回同一 `resource_id`）。
3. **交接失败补偿（`abort`）**：
   - 若 `prepare` 返回 `422 / 400` 业务拒绝，或内核重启恢复扫描 `preparing / prepared` 决定取消：内核先调 `POST /visits/:id/abort` 拿到确认回执（`state = 'aborted'`），再在本地事务内释放 `Wallet.release(f'visit:{visit_id}')`、将 `reservations` 置为 `'released'`、`city_item_custody` 置为 `'aborted'`，把室友从 `away` 移回 `living`，家庭余额与库存与出门前逐字节一致（`F3`）。

### 4.2 返家结算事务 `T3`（消费 `visit_settled`）逐分支落账规则

收到 `bridge_outbox` 的 `visit_settled`（或恢复时从 `GET /visits/:id` 读到 `state === 'settled'` 的 `settlement`）后，内核按 `settlement_id` 幂等执行单库事务 `T3`：

1. **现金净额结算**：
   - 释放原冻结 `Wallet.release(f'visit:{visit_id}')`；
   - 计算净变动 `net_delta = settlement.purse_final_yen - settlement.carry_yen`；
   - 发射内核事实事件 `city_visit_settled`，写入幂等账本分录 `wallet_entries(entry_key = f'visit:{visit_id}:net', account = actor_id, delta = net_delta)` 并同步更新 `wallets.balance = balance + net_delta`（校验更新后 `balance >= 0`）。
2. **带出物（`item.origin_ref != null`）去向结算**：
   - `fate === 'back'`：将对应 `reservations` 置为 `'released'`、`city_item_custody` 置为 `'returned'`，`resources.qty` 保持不变，物品立即可在家中再次使用；
   - `fate IN ('consumed', 'given', 'sold')`：将对应 `reservations` 置为 `'used'`（`consume = 1`）、`city_item_custody` 置为对应终态，**扣减家庭 `resources.qty = qty - item.qty`**，并发射 `city_item_consumed` / `city_item_given` 事实事件（`F6`：绝不恢复已吃掉或送人的物品；注意 `consumed` 仅扣库存，不重复改身体数值，身体数值已由 `body_effect` 独立去重结算）。（因 `store_locker` 禁止存入 `origin_ref !== null` 带出物，带出物不会进入 `locker` 悬空态；若防御性遇到异常 `locker` 带出物则保持家庭侧 `held` 并记审计告警。）
3. **城内新获物品（`item.origin_ref === null`）入库规则**：
   - `fate === 'back'` 且带合法 `kernel: { kind: 'food', item: <life1_item> }`：
     - 校验 `<life1_item>` 存在于 `vocab_life1.CATALOG['items']`；
     - 幂等创建家庭库存行 `resource_id = f'city:{visit_id}:{item.engine_item_id}'`（`kind = 'food'`，`item = <life1_item>`，`location = 'kitchen'`，`holder = None` 或本人，`qty = item.qty`，`source = 'city_bridge:' + dumps({...})`），发射 `brought_home` 事实事件；
   - `fate === 'locker'`：物品留在引擎 `city.db` 储物柜，内核不创建 `resources` 行，仅在访问结算摘要中记录 `locker` 投影供回忆/状态展示；
   - `fate === 'disposed'`（未喝完的 `carry_home: false` 热饮）：内核不创建 `resources` 行、不改身体数值，仅保留结算日志。
4. **主权归还与 `release`**：
   - 本地 `actor_domains` 升代次切回 `home`（`E_home = E_city + 1`），本地访问置为 `'closed'`（仅当 `settlement.pending` 非空时置为 `'reconcile'`），排程 `away → living` 归家移动；
   - 随后带固定 `request_id = f'visit:{visit_id}:release'` 与 `domain_epoch = E_home` 调 `POST /visits/:id/release`（若遇到网络超时或 `503 RECOVERING`，后台持久重试直至收到回执）。

---

## 5. M1 实施必防的两处跨表联动陷阱（源码审查固定项）

为确保 M1-D（引擎）与 M1-A（内核）一次联调跑通且 `reconcile_ok === true`，两端必须同步落实以下两项修正：

1. **带 `origin_ref` 具名件赠予他人后的对账查询适配（`reconcile.ts` + `actions.ts`）**：
   - 现状隐患：`c8148df` 的 `reconcile.ts` 将任何 `origin_ref IS NOT NULL AND state = 'held'` 但原 `visit_id` 已 `closed` 的物品判为错误 `carried_item_outside_visit`。当 M1 改为具名实例原地改 `owner_id` 后，室友把带出的曲奇送给外部 Bot B 并回家关闭访问时，B 手里持有的这包曲奇仍带原 `origin_ref`，若沿用旧 SQL 会误触发 `carried_item_outside_visit` 导致对账失败！
   - **冻结修法**：
     - `doGive` 在原地更新具名件 `owner_id = to.resident_id` 时，同步更新 `visit_id = (to.origin === 'house' ? openVisitOf(c, to.resident_id)?.visit_id ?? null : null)`；
     - `reconcile.ts` 的 `carried_item_outside_visit` 检查改为：**仅当持有者是小屋室友（`r.origin = 'house'`）且 `i.state = 'held' AND i.quantity > 0` 时，要求 `i.visit_id` 非空且对应访问处于 `('active', 'returning', 'settled')` 且 `v.resident_id = i.owner_id`**。一旦赠予 `external / human` 居民，原访问已以 `fate = 'given'` 在内核扣减库存，城内持有完全合法。
2. **带出物禁入公共车站储物柜与 `take_locker` 取出物追踪（`actions.ts` + `visits.ts`）**：
   - `store_locker` 拒绝 `origin_ref !== null` 的家庭携带物（`422 PRECONDITION_FAILED / carried_from_home`），从源头杜绝家庭 `reservations` 跨访问悬空；
   - 若室友在本次访问中通过 `take_locker` 取出了以前留在储物柜的城市物品（`origin_ref === null`），`take_locker` 须将其 `visit_id` 更新为当前活跃 `visit_id`；若返家前未用完且仍不可映射，`settle()` 再次按 `fate: 'locker'` 放回储物柜，访问照常 `closed`。
