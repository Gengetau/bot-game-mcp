# 晴空都城市世界（`city`）身份绑定、事实唯一写者与双层代次规范

- **文档编号**：`docs/city/IDENTITY-AND-FACTS.md`（M0 四份冻结契约之一）
- **状态**：M0 候选定稿（主笔：内核侧 `gemini4-ext`；共编对齐：引擎侧 `gemini3-ext`）
- **锁定基线**：引擎 `Gengetau/bot-game-mcp` + 小屋内核 `world-kernel/life1`（`vocab_version: life1-*`，`mappings_version: 3`，协议 `city-bridge/1`）
- **覆盖周期**：M0–M5 全量演进预留（M1 三类真实玩家闭环、M2 经济与兼职制作、M3 异步社交/个人空间/共建、M4 四层地理内容包、M5 监控与灾难恢复）

---

## 1. 三类玩家与 `principal_id` ↔ `resident_id` ↔ `actor_id` 绑定规则

晴空都持续世界（`world_id = "city"`，独立数据库 `city.db`）同时服务三类真实主体：**小屋六位室友**（`origin = 'house'`）、**独立外部 Bot**（`origin = 'external'`）、**人类网页玩家**（`origin = 'human'`）。所有身份在 `city.db` 内通过 `principals`、`residents`、`house_members` 三张表严格绑定，且遵循**一对一、不可变、跨类别互斥**铁律。

### 1.1 主体命名空间与三层映射总表

| 玩家类别 | `residents.origin` | `principals.provider` | `principals.subject` | `principals.kind` | `house_members.actor_id` | 准入与创建时机 | 首次进城启动资金 |
|---|---|---|---|---|---|---|---|
| **小屋室友**（6 位固定成员） | `'house'` | `'ai-house'` | `<actor_id>`（`nia` / `claire` / `alicia` / `grok` / `xingli` / `whale`） | `'agent'` | 同 `subject`（1:1 永久绑定） | 引擎启动 `ensureHouseMembers()` 按 `city.house[]` 预建；只允许经 `/city/bridge/v1` 从家门口交接进城 | **¥0（永不发放）**；随身日元仅来自每次访问 `commit` 从家庭钱包划入的 `carry_yen` |
| **独立外部 Bot**（密钥鉴权） | `'external'` | `'qq'` | 引擎鉴权配置中的 AI 密钥身份 ID（或已签发 Agent Key 绑定的账号 ID） | `'agent'` | 无（不在 `house_members` 中） | 经 MCP `enter_world { world_id: "city", name }` 首次进城时创建（须通过 `city.allowedAgents` 准入检查） | **¥200,000**（`grant:first-entry:<principal_id>`，永久仅一次） |
| **独立外部 Bot**（仅测试开放模式） | `'external'` | `'open'` | 调用方自报标识（仅 `auth.mode = 'open'` 本地测试可用；生产禁用） | `'agent'` | 无 | 同上，与 `'qq'` 命名空间完全隔离 | **¥200,000**（按 `open` 命名空间 `principal_id` 计） |
| **人类网页玩家**（QQ 裁判签票） | `'human'` | `'qq'` | 代码裁判从真实 OneBot 消息事件核实的发送者真实 QQ 号 | `'human'` | 无 | 裁判调 `city_issue_ticket` 登记 `principal`（`kind = 'human'`）；浏览器凭 `#ticket` 兑换会话后首次起名入城时创建 `resident` | **¥200,000**（`grant:first-entry:<principal_id>`，一 QQ 号唯一对应一主体，杜绝匿名刷钱） |
| **人类本地开发测试**（`devLogin`） | `'human'` | `'dev'` | `sha256(cleanName).slice(0, 24)`（仅 `city.devLogin = true` 本地隔离测试开启；生产必关） | `'human'` | 无 | 调本地开发登录接口创建会话并首次入城 | **¥200,000**（仅隔离测试库生效） |

### 1.2 核心身份不变量（Schema v2 强制约束）

1. **`(provider, subject)` 唯一且 `kind` 永久不可翻转**
   - `principals` 表设 `UNIQUE (provider, subject)` 且 `kind CHECK (kind IN ('human', 'agent'))`。
   - 外部 Bot 密钥身份与人类 QQ 票据**共用 `provider = 'qq'` 命名空间**：同一个真实 QQ 号在 `city.db` 中要么是 `agent`，要么是 `human`，一旦落库终身不可互转：
     - 若某 `user_id` 已在引擎 AI 密钥表（`hasKeyFor(user_id)`）登记、属于 `city.house[].qqIds`、或已在 `principals('qq', user_id)` 登记为 `'agent'`，`city_issue_ticket` 必须拒绝签票（`403 FORBIDDEN` / `ENTRY_VIA_HOME_ONLY`）；
     - 若某 `user_id` 已通过票据登记为 `'human'`，后续任何试图用该号码走 AI 入口的请求一律拒绝（`401 UNAUTHENTICATED` / `403 FORBIDDEN`）；
     - `open` 测试命名空间与 `qq` 命名空间隔离，防止开放测试下抢注真人 QQ 号。
2. **`principal_id` ↔ `resident_id` 全局一对一**
   - `residents.principal_id` 带 `UNIQUE NOT NULL REFERENCES principals(principal_id)`；`residents.origin` 在 Schema v2 扩展为 `CHECK (origin IN ('external', 'house', 'human'))`。
   - 显示名 `name`（1–16 字符，经 `sanitizeName` 去除控制/格式字符）在全城范围内按 `NFKC + toLowerCase()` 唯一（`422 PRECONDITION_FAILED / name_taken`），三类居民共享同一重名空间。
3. **`actor_id` ↔ `resident_id` 永久绑定与配置变更语义**
   - 小屋六位室友仅限 `nia`、`claire`、`alicia`、`grok`、`xingli`、`whale`（小屋内核里的 `owner` 不是模拟室友，主人本人进城走 `origin = 'human'` 的 QQ 签票网页端）。
   - `house_members(actor_id PRIMARY KEY, resident_id UNIQUE)` 一旦在 `city.db` 建立永不更改映射关系：修改配置仅同步 `name` 与 `bio`（若后加入室友的名字已被城内现有居民占用，启动不阻塞，暂用 `<name>·<actor_id>` 并记录日志）；从配置移除某室友不删除其库内记录与账本历史。
   - 小屋内核侧在只读配置/元数据中校验 `actor_id` 白名单，且在 `city_body_effects` / `city_visits` 处理桥接回包时**始终以本地 `visit_id -> actor_id` 绑定为准**，绝不盲信外部载荷声称的 `actor_id`。
4. **小屋室友 QQ 侧密钥硬拦截（`F16` / `R10` / `Q1`）**
   - 六位室友在 QQ 群聊侧持有的 MCP 密钥（配置在服务器私有 `city.house[].qqIds`，严禁入仓）对晴空都世界调用 `enter_world`、`get_my_view`、`speak`、`world_act`、`world_wait`、`claim_control`、`heartbeat` 时，必须在写库之前直接拒绝并返回 **`403 ENTRY_VIA_HOME_ONLY`**（不创建 `principal`，不写任何副作用）；`open` 模式下自报同号同样拦截。
   - 唯一允许保留的只读入口：`world_query { world_id: "city", what: "public" }`。
   - 反向防越权：任何外部 MCP 会话或人类网页会话若试图对 `origin = 'house'` 的 `resident_id` 调用 `cityCommand()` / `enterCity()`，一律拒绝为 `ENTRY_VIA_HOME_ONLY`；桥接密钥（`Authorization: Bearer <city.bridgeKey>`）只能代行 `house_members` 中的六位室友，无权代操作 `external` 或 `human` 居民。
5. **人类一次性票据与网页会话安全边界（定案 1）**
   - `city_issue_ticket` 仅限可信裁判/管理员身份调用（开启 `city.adminOnlyTickets` 时仅限管理员）；`user_id` 必须取自 OneBot 事件发送者真实 QQ 号，严禁从消息正文/@文本解析。
   - 原始票据（24 字节随机串 base64url）仅通过私聊发送 `https://<publicUrl>/city/play/#ticket=<token>`（URL Fragment 不进 HTTP 请求行、服务器访问日志与 Referer），群内仅回提示，裁判与引擎日志严禁打印明文票据。
   - `login_tickets` 仅存 `ticket_hash = sha256(ticket)`，有效期默认 5 分钟，单事务原子标记 `redeemed_at` 兑换为 `web_sessions(token_hash, principal_id, csrf_token, created_at, expires_at, revoked_at)`；浏览器写接口强制同时校验 `HttpOnly; SameSite=Lax`（HTTPS 下 `Secure`）会话 Cookie 与 `X-City-CSRF` 请求头。

---

## 2. 跨系统事实唯一写者归属表（Single-Writer Ownership）

**总铁律：任何会改变世界状态的事实在全系统中有且仅有一个权威写入方；另一侧只能读取或缓存只读投影，任何投影严禁反向写回覆盖权威事实。**

| 事实域 | 唯一权威写入方 | 权威存储位置 | 跨系统传播通道 | 另一侧可见投影与隐私红线 | 阶段覆盖 |
|---|---|---|---|---|---|
| **室友家庭身份、画像、私人长记忆、衣着** | 小屋内核 + 记忆服务 | `life1.db` / `memory.db` | 不传城内（仅可带简短公开 `bio`） | 城市仅存 `actor_id ↔ resident_id`、显示名与一句话公开简介；衣着在 M1 不作为城市物品流转 | M0–M5 |
| **室友身体状态**（`hunger`、`energy` 等 `life1` 生理值） | **小屋内核（`life1`）全程唯一** | `life1.db` `actors.body` + `effects` + `city_body_effects` | 城市写入 `bridge_outbox` 的 `body_effect`（带唯一 `effect_id`）；内核按 `effect_id` 去重后按 `life1` 规则结算 | 引擎不为室友计算 `energy/social/interest`，也不直接写身体数值；内核自身基础时间漂移（`_integrate`）在城期间照常连续运行 | M0–M5 |
| **室友家中位置（各房间 / `away`）与家庭日程** | 小屋内核（`life1`） | `life1.db` `actors.location`、`actions`、`plans` | 出门 T1：`living → away` 后 `prepare → commit`；返家 T3：`settled` 应用后 `release` + `away → living` | 室友在城期间（`preparing` 之后至 `closed/reconcile/aborted` 之前）`actors.location` 恒为 `'away'`，家庭认知/做饭/日程不为她排新动作（`ACTOR_OUT_IN_CITY`） | M0–M5 |
| **室友在城实时位置与在途行程** | **`CityService`（城市引擎）** | `city.db` `residents.place_id` / `trips` | `bridge_outbox` 的 `visit_progress`、`return_started`；故障恢复读 `GET /visits/:id` | 内核 `city_visit_projections` / `world.db` / 状态卡只读展示「外出中 · 在棱光街·喫茶「灯」」「乘车中，预计 HH:MM 到…」「外出中，状态待确认」；**`hiwatari:ai-house:entrance` 与虚构洋房门牌在一切公开页、外部 Bot 视图与内核对外卡片中一律遮蔽（最多写「日和坂一带」）** | M0–M5 |
| **室友留在家中的现金与家庭库存** | 小屋内核（`life1`） | `life1.db` `wallets` / `wallet_holds` / `resources` / `reservations` | T1 冻结 `carry.yen` 与 `carry.items`；T3 按 `Settlement` 净额记账并解冻/扣减/入库 | 引擎对室友家中总余额与未带出库存零可见、零权限 | M0–M5 |
| **室友本次带出的随身日元与携带物** | 访问 `active/returning` 期间：**`CityService` 托管账本** | `city.db` `accounts(acct:<res>)`、`items`、`orders` | `commit`（`visit:<id>:in`）入账激活并动态锁定回程车费 `return_reserve_yen`；`visit_settled` + `release`（`visit:<id>:out`）清算 | 内核在访问期间将现金保持 `wallet_holds(state='held')`、带出物保持“随身在外”托管态不可在家使用；`purchase` 记录仅作投影展示，绝不直接改 `life1.db` 余额 | M0–M5 |
| **城市目录、四层地理、交通、店铺、公开事件** | **`CityService`（版本化内容包 + `city.db`）** | `catalog` / 内容包 + `city.db` `city_events`、`catalog_versions` | `GET /city/bridge/v1/catalog`、公开视图、MCP `world_query` | 三类玩家共享同一份 `city_catalog_version`、`fare_rule_version` 与实时营业/雨天开闭判定 | M0–M5 |
| **晴空都天气快照** | **`CityService` 天气抓取器（唯一抓取者）** | `city.db` `weather_snapshots` | `GET /city/bridge/v1/weather` | 小屋内核通过 `Life(weather=...)` 读同一份快照保持家窗外与城内同天；3h 内抓取失败标 `stale` 沿用上次，超 3h 退回 `fallback`（合成晴/多云，`rain=false`，不谎报下雨关河岸） | M0–M5 |
| **独立 Bot 与人类玩家的城市资产、储物柜、个人空间、交易、共建、邀约、离线信箱** | **`CityService`** | `city.db`（Schema v2–v4：`items`、`work_logs`、`trade_offers`、`appointments`、`resident_messages`、`personal_spaces`、`community_projects`） | MCP 工具 + `/city/api/*` REST & SSE（室友在城期间若参与共建/收寄明信片/存柜，城内事实仍归 `city.db`） | 完全独立于小屋内核运行；所有玩家输入文本必须经 `sanitizeUserText` 清洗并在 AI 上下文中标注 `untrusted: true` | M1–M5 |
| **主观意愿、对话措辞与主动决策** | **各玩家自身代理系统 / 真人** | 小屋适配器 / 外部 Agent 进程 / 人类浏览器 | 提交结构化 `world_act` 或桥接 `/visits/:id/act` | **核心产品铁律（1.2）**：离线或预算耗尽期间，引擎仅推进已确认的电车到站、已开始的制作、到期返程与邀约过期，**绝不伪造玩家意愿代聊、代消费、代接受邀约或代改行程** | M0–M5 |

---

## 3. 双层控制权正交模型（`domain_epoch` vs `control_epoch`）

为彻底消除“家城双脑并发写同一室友”与“同一外部 Bot / 真人多开终端互踩状态”两类竞争，系统定义两套**作用域完全正交、互不混用**的单调递增代次：

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 层 A：家城主权代次 domain_epoch（仅限 origin = 'house' 小屋六位室友）        │
│   小屋内核 actor_domains.domain_epoch  ◄─── 交接点：小屋门口 ───►  city.db  │
│   home(2k) ──commit(2k+1)──► city(2k+1) ──release(2k+2)──► home(2k+2)      │
│   违规错误码：409 STALE_DOMAIN_EPOCH（桥接 REST 专用）                     │
├────────────────────────────────────────────────────────────────────────────┤
│ 层 B：客户端控制代次 control_epoch（仅限 origin IN ('external','human')）  │
│   同一居民多个 MCP 会话 / 浏览器标签页 / CityRunner 实例                    │
│   enter(空闲自动持权或只读旁观) ──claim_control──► control_epoch + 1       │
│   违规错误码：409 CONTROL_LOST（MCP / 人类网页 REST 专用）                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 层 A：家城主权代次（`visits.domain_epoch` + `house_members.last_epoch`）

- **适用对象**：仅 `origin = 'house'` 的六位室友。`residents.control_epoch` 对她们恒为 `0`、`controller_id` 恒为 `NULL`。
- **单调递增与奇偶交接约定**：
  1. 初始态：内核 `actor_domains(domain = 'home', domain_epoch = 0, visit_id = NULL)`，引擎 `house_members.last_epoch = 0`。
  2. **出门交接（`commitVisit`）**：内核分配新代次 `E_city = current_epoch + 1` 随 `POST /visits/:id/commit` 发送。引擎校验 `E_city > house_members.last_epoch`，通过后同事务更新 `house_members.last_epoch = E_city`、`visits.domain_epoch = E_city`、`visits.state = 'active'`；不通过则返 `409 STALE_DOMAIN_EPOCH`（附 `{ last_epoch }`）。内核收到回执（或故障恢复经 `GET /visits/:id` 确认已 `active`）后，在事务 T2 将本地 `actor_domains` 置为 `domain = 'city', domain_epoch = E_city, visit_id = <id>`。
  3. **在城代行（`act` / `view` / `wait`）**：内核城市适配器每次请求必须携带 `domain_epoch = E_city`。
     - 若访问已处于 `closed / reconcile / aborted`：一律返 `409 STALE_DOMAIN_EPOCH`；
     - 若访问仍为 `prepared`：返 `409 VISIT_NOT_ACTIVE / not_committed`；
     - 若 `domain_epoch !== visits.domain_epoch`：一律返 `409 STALE_DOMAIN_EPOCH`（附 `{ domain_epoch: visits.domain_epoch }`）。
  4. **返家收口（`releaseVisit`）**：引擎到达 `hiwatari:ai-house:entrance` 并写入不可变 `Settlement` 后，访问进入 `settled`（只读态，拒绝一切城内新 `act`）。内核消费 `visit_settled` 在单事务 T3 内完成钱包解冻净额入账、物品结算、将本地 `actor_domains` 升为 `domain = 'home', domain_epoch = E_home`（`E_home = E_city + 1`），随后调 `POST /visits/:id/release` 传入 `domain_epoch = E_home`。引擎校验 `E_home > visits.domain_epoch`，更新 `house_members.last_epoch = MAX(last_epoch, E_home)` 并结清随身钱包。
  5. **取消出门（`abortVisit`）**：仅在 `commit` 前有效，动作权从未离开 `home`，不消耗城域代次（或本地安全归回 `home`），引擎永久记录 `visit-aborted:<visit_id>` 阻断迟到的幽灵 `prepare`。

### 3.2 层 B：城内客户端控制代次（`residents.control_epoch` + `residents.controller_id`）

- **适用对象**：仅 `origin IN ('external', 'human')` 的居民。
- **客户端标识 `client_id`**：
  - MCP 端：`enter_world` 支持传入稳定 `client_id`（`^[\w.-]{4,60}$`，如 `CityClient.clientId`）；未传时由服务端按当前 MCP 会话绑定默认标识。
  - 网页端：从 `X-City-Client` 头（合法格式）或当前 `web_sessions` 令牌摘要派生稳定 `client_id`。
- **控制权获取、旁观与显式接管状态机**：
  1. **进入时自动持权或安全旁观（不暗抢）**：调用 `enter_world { world_id: "city", client_id }` 或网页进入接口时：
     - 若当前无控制者（`controller_id IS NULL`）、居民当前不在场（`in_city = 0` 或租约已过期）、或 `controller_id === client_id`：该客户端持有控制权；若 `controller_id !== client_id`，则 `control_epoch += 1` 且 `controller_id = client_id`。
     - 若居民当前在场（`in_city = 1` 且租约有效）且 `controller_id !== client_id`：**不自动抢夺控制权**，新客户端以只读旁观态成功返回本人视图，其中 `selfView.control = { epoch: r.control_epoch, mine: false }`。
  2. **显式接管（`claim_control`）**：当新客户端（如重启后换了 `client_id` 的 Bot 或新开的浏览器窗口）确认要接管时，显式调用 MCP `claim_control` 或 `POST /city/api/claim-control`：
     - 服务端原子执行 `control_epoch += 1`、`controller_id = client_id`，续期在场租约，向该居民事件流推送 `{ type: "control", epoch: r.control_epoch }`，返回 `{ ok: true, control: { epoch: r.control_epoch, mine: true } }`。
  3. **写操作校验与 `CONTROL_LOST` 停写铁律**：
     - 每次 `cityCommand()`（来自 MCP `world_act`/`speak` 或网页 `POST /city/api/act`）在事务内校验 `r.controller_id === client_id`（若请求附带可选 `expected_control_epoch`，同时校验等于 `r.control_epoch`）。
     - 不匹配时立即抛出 **`CityError('CONTROL_LOST', ...)`（HTTP 409）**，附 `{ control: { epoch: r.control_epoch, mine: false } }`。
     - **`CityRunner` 行为约束**：一旦在 `selfView` 观察到 `control.mine === false` 或 `act()` 捕获 `ControlLostError`（`CONTROL_LOST`），必须**立即停止决策与写入循环**，绝不允许自动循环调用 `claim_control` 互抢。
     - **与确定性行程的关系**：控制权换手**不会中断**已在运行中的电车/步行 `trips` 或 M2 制作定时作业，仅切换后续新动作的提交权。
  4. **主动离开（`leave_world` / `POST /city/api/leave`）**：
     - 原子置 `in_city = 0, present_until = 0, controller_id = NULL, control_epoch = control_epoch + 1`，取消 `pres:<resident_id>` 定时任务（M5 记录离线原因为 `left_voluntarily`，与 `presence_expire` 的 `lease_expired` 区分）。

### 3.3 `selfView` 控制权字段契约

| 居民 `origin` | `selfView.control` 返回值 | 说明 |
|---|---|---|
| `'external'` / `'human'` | `{ epoch: number, mine: boolean }` | `epoch` 为 `residents.control_epoch`；`mine` 表示当前调用方 `client_id === residents.controller_id` 且在场有效 |
| `'house'`（经 `/visits/:id/view`） | `{ epoch: number, mine: true }`（`epoch` 对齐 `visit.domain_epoch`，保留桥接 `visit` 块） | 桥接代行已由 `requireActingVisit(visit_id, domain_epoch)` 强校验，适配器始终视为当前唯一控制者 |

---

## 4. 栖灯镇（`town`）平稳关停封存与旧镇金币不兑换规程（定案 2）

### 4.1 资产与数据完全隔离铁律

1. **物理分库**：东京都使用独立 SQLite 库 `city.db`（Schema 演进 `CITY_SCHEMA` v1→v5，备份前缀 `city-`）；栖灯镇原库 `town.db`（Schema v6）保持物理独立。
2. **旧镇硬币绝不兑换东京日元**：
   - 栖灯镇货币为个位数镇币（`coins`，新居民发 20）；东京都货币为整数虚拟日元（`yen`，外部 Bot 与人类首次进城统一由 `sys:mint` 发放 `¥200,000`，室友由小屋家庭日元钱包划转）。
   - **不存在任何 `town.db` → `city.db` 的余额迁移、汇率折算、物品导入或居民表复制接口**。任何试图引入跨世界资产兑换的逻辑均违反定案 2。

### 4.2 线上关停封存标准步骤（生产门禁「备包待批」规范）

> **纪律红线**：研发阶段仅在隔离测试环境（`botgame.city-test.json` + `city-test.db`）演练 `town.enabled: false, city.enabled: true`；线上实际执行关停、改配置、重启服务须整理为完整待批操作包，经统筹汇总报主人批准后方可执行。

1. **停运前只读三项归零预检**：
   - 栖灯镇当前在线居民数 `active = 0`；
   - 栖灯镇内嵌桌游活跃对局数 `TG-* = 0`；
   - 栖灯镇裁判待投递公告队列 `town_outbox pending = 0`。
2. **一致性快照与零字节改动封存**：
   - 执行 `sqlite3 town.db ".backup 'backups/town-final-freeze-YYYYMMDD.db'"`；
   - 对原库与冻结备份分别执行 `PRAGMA integrity_check;`，确认均返回 `ok` 且记录 SHA-256 校验值；
   - `town.db` 与冻结备份留在原目录只读封存归档（不删库、不清理表、不改任何字节）。
3. **引擎与裁判配置切换**：
   - 引擎配置：`town.enabled: false`（彻底不实例化 `WorldService`，释放内存与全部小镇定时器），`city.enabled: true`；
   - 代码裁判：关闭 `--town` / `--town-outbox`（`BOTGAME_REFEREE_TOWN=0`），开启 `--city`（`BOTGAME_REFEREE_CITY=1`，识别「东京 / 进城」私聊签票；收到旧词「小镇」仅温和提示“栖灯镇已停运封存，发送「东京」可获取东京都登录链接”）；
   - 公共群聊桌游（狼人杀、剧本杀、大话骰、彩牌接龙等）保持 100% 原样运行，不受 `town.enabled: false` 影响。

---

## 5. 跨库账本守恒、身体效果对齐与共享预算契约

### 5.1 复式账本与跨库守恒四等式

1. **引擎内部零和不变量（`ledgerImbalance === 0`）**：
   - 所有日元变动必须经 `ledger()` 写入 `ledger_transactions`（永久唯一 `cause_key`）与平衡分录 `ledger_entries`（同事务 `SUM(delta) === 0`）。
   - 系统账户集合：
     - M1：`sys:mint`（外部 Bot / 人类首次进城发放）、`sys:transit`（交通票款）、`sys:shops`（商店销售收入）、`bridge:ai-house`（小屋室友进出城资金桥接池）；
     - M2 预留：`sys:jobs`（确定性兼职 `work` 与制作委托 `deliver_order` 报酬池）。
   - 全库恒等式：$\sum_{a \in \text{accounts}} \text{balance}(a) \equiv 0$。
2. **家城跨库对账四等式（每日对账 + 每次 `release` 对账，只报告不自动篡改）**：
   - **在途冻结守恒**：小屋 `life1.db` 中所有处于 `held` 状态的 `visit:<visit_id>` 钱包冻结总额 $=$ 引擎 `city.db` 中所有已 `commit` 未 `release` 访问的 `carry_yen` 之和（处于 `preparing/prepared` 尚未 `commit` 的短暂窗口按 `visit_id` 状态单独核销）；
   - **单次结算净额一致**：每个已关闭访问在 `life1.db` 的 `wallet_entries(entry_key = 'visit:<id>:net')` 分录金额 $=$ `purse_final_yen - carry_yen` $=$ 引擎侧 `visit:<id>:out` 与 `visit:<id>:in` 对 `bridge:ai-house` 的分录和之相反数；
   - **桥接池余额恒等式**：`balance('bridge:ai-house')` $= \sum_{\text{released}} (\text{purse\_final\_yen} - \text{carry\_yen}) - \sum_{\text{committed \& !released}} \text{carry\_yen}$；
   - **未决订单锁额一致**：每位居民 `accounts.held` $=$ 其名下 `orders.status = 'pending'` 的 `yen` 之和。

### 5.2 城市身体效果名与 `life1` 词表精确对齐（`mappings_version: 2`）

引擎只记录客观行为事实并按 `docs/city/mappings.json`（`version = 2`）映射为四个标准 `kernel_effect` 名称写入 `bridge_outbox`（`kind = 'body_effect'`，`record_id = effect_id = '<visit_id>:e<n>'`）；小屋内核 `CityBodyEffects` 按原始 `effect_id` 在 `effects` 与 `city_body_effects` 表双表事务去重结算：

| `kernel_effect` | 引擎触发来源（`engine_kind` / `engine_type`） | Outbox 载荷单位字段 | 内核 `CityBodyEffects.apply` 换算规则 | 对齐的 `life1` 词表规则与数值变化 |
|---|---|---|---|---|
| `'snack'` | `ate`：`cookie` / `onigiri` / `melon_pan` / `cream_bun` / `cheesecake` | `qty`（正整数份数，1..9） | `quantity = payload.qty` | `ACTIONS['eat'].effects.once × quantity` → **`hunger: -60 × quantity`** |
| `'drink_coffee'` | `drank`：`coffee`（现点混合咖啡） | `qty`（正整数杯数，1..9） | `quantity = payload.qty` | `ACTIONS['eat'].effects.once × quantity` → **`hunger: -60 × quantity`**（与 `life1` 现有 `coffee` 食用规则一致） |
| `'drink_tea'` | `drank`：`milk_tea`（皇家奶茶）/ `green_tea`（瓶装绿茶） | `qty`（正整数杯/瓶数，1..9） | `quantity = payload.qty` | `ACTIONS['eat'].effects.once × quantity` → **`hunger: -60 × quantity`**（参照 `life1` `bottled_tea` 食用规则） |
| `'walk_15m'` | `walked`：行程步行段每累计满 `min_minutes = 15` 分钟触发一条 | `minutes`（整数分钟，标准值 `15`） | **`quantity = payload.minutes // 15`**（`minutes = 15` 时传 `quantity = 1`，**严禁直接传 `15` 导致乘二次 15**） | `ACTIVITIES['stroll'].effects.rate × (15 × quantity)` → **`energy: -0.75 × quantity`**（不重复叠加 `BASE_DRIFT`） |

- **未知效果保护**：若 `kernel_effect === null`（如食用未登记效果的物品）或出现未知效果名，内核不修改 `actors.body`、不占用 `effects` 键，写入可审计拒绝记录 `city_body_effect_rejected` 后推进 outbox 游标，绝不阻塞后续 `visit_settled` 消费。
- **M2 预留**：M2 自愿兼职（`work`）若需反馈轻量劳作消耗，必须升级 `mappings_version`（`>= 3`）并在两端同步新增效果名与单测，严禁在 `mappings_version: 2` 下私自塞入未定义字符串。

### 5.3 模型预算池衔接与耗尽优雅降级（计划书 §七）

1. **小屋共享预算池统一核算**：
   - 室友在城期间由 `decision_wake` 触发的模型决策，统一接入内核既有 `world-kernel/life1` 共享预算池（**全屋共享每小时 40 次、滚动 24 小时 300 次**，`purpose = 'city'`，`reserved / settled / unknown` 均计入），并受单次访问子上限（默认 **12 次**）约束。
   - 无 `decision_wake` 时零模型轮询：普通 `visit_progress`、`purchase`、`body_effect`、`encounter` 仅做确定性本地投影与落账，不唤醒模型。
2. **预算耗尽优雅降级铁律**：
   - 当共享池、单角色日目标或单次访问子上限耗尽时，适配器标记 `budget_exhausted` 并跳过非紧急自主模型调用，但**绝不阻塞城内与返家确定性状态机**：
     - 已出发的电车/步行 `trips` 照常按 `scheduled_jobs` 到站；
     - M2 已开始的制作作业照常完成；
     - 到达 `leave_by_ms`（`return_by_ms - homeward.minutes - returnMarginMs`）时引擎自动排回程送达 `hiwatari:ai-house:entrance` 产出 `visit_settled`；
     - 内核 outbox 消费器（零模型依赖）照常执行事务 T3 解冻结算并调 `release` 让室友平安返家。
