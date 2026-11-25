# bot-game-mcp：给编码 agent 的项目说明

这是一个遵循 MCP 协议的 QQ 群桌游引擎，用 TypeScript ESM 编写（NodeNext、strict），需要 Node 22 或更高版本。面向用户的说明见 README.md。

## 常用命令（在仓库根目录）

```bash
npm run typecheck   # 类型检查（含测试代码）
npm test            # vitest，必须全绿
npm run build && npm run e2e   # 黑盒端到端（独立进程、多客户端、中途重启、裁判接管），约 25 秒
npm run build       # 编译三个包到各自的 dist/
npm run docs        # 改了规则、选项或工具描述后，重新生成 docs/GAMES.md、docs/TOOLS.md（CI 会检查）
npm run simulate -- werewolf --players 9 --humans 2 --seed 1   # 离线跑一局
```

## 必须遵守的不变量

- 程序决定一切。裁判只能取消息（`referee_step`）和转交真人消息（`relay_human_message`），不能有任何影响结果的接口。
- 游戏实例不在自身上保存状态，所有状态都放在 `rec.state` 或 `rec.phase.data` 里，必须可以序列化。
- 随机一律走 `this.rng` 或注入的 `Rng`，不要用 `Math.random()`。
- 视图不能泄露别人的秘密：
  - `publicView` 里不能有秘密；
  - 不要把 `rec.state` 整个返回；
  - 真人座位的私密信息只通过 `tell` 发出（变成裁判私聊）；另外只在该真人自己的座位网页（座位令牌，开局私聊发出、结束作废）上显示。MCP 视图只认 AI 座位。
- 玩家提供的文字和昵称，必须先经过 `sanitizeUserText`/`sanitizeName` 才能拼进消息。
- 需要保密的阶段设置 `secret: true`，必要时加 `minDurationMs`。阶段出现与否、标题、时长都不能随秘密状态变化（参考狼人杀的女巫阶段）。

## 晴空都（持续城市世界）的不变量

> 栖灯镇 2026-11 已删除，世界改为晴空都。

城市在 `packages/engine/src/city/`，说明和接口契约见 `docs/CITY.md`，桥接协议的机器可读版本在 `docs/city/bridge-v1.schema.json`。改它之前先读那份文档。

- 城市使用独立的 SQLite 文件（`city.db`），复用 `src/core/sqlite.ts`（`SqliteDb`）、`src/core/time.ts` 和 `src/core/ids.ts`。
- 所有写入都在 `c.commit()` 的同一个事务里：状态、账本、事件、outbox、回执、定时任务一起提交或一起回滚。处理过程同步，不等模型、不等网络（天气是在事务外抓好，再进事务写）。订阅者只在提交之后被唤醒。
- 单写者：一位室友任何时刻只有小屋内核或城市一边接受她的动作。代行的动作、视图、等待都要带 `visit_id` 和当前的 `domain_epoch`；访问结束后旧代次一律 `STALE_DOMAIN_EPOCH`。室友在 QQ 侧的密钥不能直接进城（`ENTRY_VIA_HOME_ONLY`，在写入任何东西之前拒绝）。
- 小屋门口（`HOUSE_ENTRANCE`）不公开：不出现在公开视图、目录页、地点列表、外部 bot 的视图和事件里，只在桥接接口里出现。新增视图字段先想清楚外部 bot 能不能看到。
- 日元只通过 `ledger.ts` 的 `ledger()` 变动，每笔分录平衡、原因键唯一，所有账户余额之和恒为 0；物品的增减只通过 `addPlain` / `addCarried` / `takeItems`；交回时物品的去向（带回、寄存）只由 `releaseVisit` 按结算清单写。
- 桥接回执永久保存，只记成功的结果：同一个请求号同样内容返回原回执，换内容 409。改了桥接的请求、回执或 outbox 记录的字段，同步改 `docs/city/bridge-v1.schema.json`（有测试校验）；改了映射表同步改 `docs/city/mappings.json` 并升版本。
- outbox 只追加，序号单调；发给内核的记录里，别的居民只出现显示名和地点。
- 目录（`catalog.ts`）发布后改了地点、票价、时间就换 `CITY_CATALOG_VERSION` / `FARE_RULE_VERSION`。真实世界的数据带来源标注，店铺是虚构的并标明。
- 天气事件只由状态为 `ok` 的实时数据触发；合成天气不下雨。
- 时间用 `c.now()`，随机用 `c.rng`；玩家提供的文字和名字先经过 `sanitizeUserText` / `sanitizeName`，进 AI 上下文的聊天文字标 `untrusted`。
- 部署、桥接密钥和服务器配置不在开发范围内；上线的每一步先问主人。

## 代码地图

仓库是 npm 工作区，三个包：

- `packages/engine`（npm 包 `bot-game-mcp`）：引擎。
  - `src/core/manager.ts`：GameManager，包括大厅、抽签、推进（pump）、投递、长轮询、视角、裁判和存档。
  - `src/core/game.ts`：BaseGame 基类。参考实现是 `src/games/number-bomb/index.ts`。
  - `src/mcp/server.ts`：工具、资源、提示词。`src/mcp/guides.ts` 是给 agent 的指南文本。`src/mcp/city.ts` 是晴空都城市世界的 MCP 工具和上下文路由。
  - `src/core/runner.ts`：GameRunner，从 GameManager 抽出来的「推进一局」，公共对局和桌游茶屋的嵌入小游戏共用。`src/core/sqlite.ts`、`src/core/time.ts`、`src/core/ids.ts` 是城市共用的 SQLite 外壳、时区与哈希工具。
  - `src/city/`：持续城市世界「晴空都」（`service.ts` 提交与调度，`db.ts` 表结构，`catalog.ts` 地点与票价，`ledger.ts` 账本，`trips.ts` 行程，`visits.ts` 和小屋内核的桥接协议，`residents.ts` 身份与在场，`actions.ts` 动作与限流，`venue-games.ts` 桌游茶屋牌桌与竞拍，`views.ts` 投影，`weather.ts`、`reconcile.ts`、`http.ts`、`connect.ts`）。网页端在 `city/`。测试在 `test/city/`，`helpers.ts` 里有假内核客户端。
  - `src/server/`：HTTP、SSE、stdio、bridge 传输。
  - 测试：`test/helpers.ts` 提供 FakeClock、`startGame`、`playToEnd`。
- `packages/referee-onebot`（`bot-game-mcp-referee-onebot`，命令 `bot-game-referee`）：代码裁判，OneBot v11 正向 WebSocket。只能通过 MCP 协议和引擎说话。
- `packages/agent-kit`（`bot-game-mcp-agent-kit`）：接入端客户端（`BotGameClient`、`CityClient`、`CityRunner`）、`waitForTurn`、提示词 `playerPrompt()` / `cityResidentPrompt()`；`prompts/player-zh.md` 与 `prompts/city-resident-zh.md` 必须和代码一致（有测试）；`examples/` 是各 agent 框架的接入示例。
- `scripts/e2e.ts`：黑盒端到端，跨三个包。

裁判和接入端不得 import 引擎内部代码；它们的测试通过包名 `bot-game-mcp` 使用引擎（vitest 和 tsconfig 已映射到引擎源码）。

## 进度记录

重要进展和测试结果记在 `docs/PROGRESS.md`。上下文被压缩之后，先读它。
