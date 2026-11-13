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
npm run world:simulate -- --days 1 --residents 12 --seed 1    # 栖灯镇：固定种子跑逻辑时间并检查不变量
npm run world:recovery                                         # 栖灯镇：故障注入
npm run client:export && npm run client:e2e                    # 三维客户端：导出并跑浏览器端到端（需要 Godot 4.7，不在 CI 里；导出约 2 分钟，端到端完整一遍约 17 分钟，其中声音那一步约 6 分钟）
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

## 栖灯镇（持续世界）的不变量

小镇在 `packages/engine/src/world/`，说明和接口契约见 `docs/TOWN.md`。改它之前先读那份文档。

- 所有写入只走 `WorldService.command()`（居民动作）或定时任务处理器，并且都在 `w.commit()` 的同一个 SQLite 事务里：状态、账本、事件、回执、定时任务一起提交或一起回滚。处理过程必须同步，不等模型、不等网络。例外只有三类不是「动作」的写入：在场心跳、导航控制租约的续期（`renewNavigation`）和键盘方向输入（`space.ts` 的 `directionInput`，只经 WebSocket），它们同样在 `w.commit()` 里，但没有回执；方向输入不产生任何事件，也不接受客户端坐标，只收方向、序号和控制版本。
- 订阅者（SSE、长轮询、WebSocket）只在提交之后被唤醒。不要在事务里直接往外发东西。
- 硬币只通过 `property.ts` 的 `ledger()` 变动，每笔分录平衡、原因键唯一；物品只通过 `addStack` / `takeStack` / `reserve` / `release` 变动。不要直接改余额或数量。
- 关系、愿望、日报只读 `w.fact()` 记录的结构化事实，不读聊天文字。
- 投影只有一套（`views.ts` / `project.ts`，空间快照是 `space.ts` 的 `sceneView`）：网页、MCP、观战、日报、回顾都用它。公开层面位置只到区域（公共地点、路上、「住宅区」）；别人的信件、背包、需要、愿望、关系、屋内情况不出现在任何别人能拿到的投影和事件里。新增字段先想清楚谁能看。
- 位置只由空间模块（`space.ts`）写：`world_actors`（场景、实例、x、z、导航）和 `residents.location_id`（区域标签）都不能被别的模块直接改。要挪人就发起导航或用 `sendToDoor`；别的模块按区域标签判断「在不在一起」，按 `requireReach` 判断够不够得着公共物件。
- 聊天有两个互相独立的范围（`chat.ts`、`hearing.ts`）：附近聊天的受众在发送事务里按 `posOf` 一次定下（同实例、`hearDistance` 内、同房间、有效在场、不在对局），之后不改；全镇公屏是单独的表、序号和游标，匿名读不到，对局中不能发、AI 不能读，唤醒 AI 只靠明确提及或相关约定，进 AI 上下文的公屏文字要标 `untrusted`。`say_town` 的回执不能带唤醒结果。
- 场景快照里不只有位置：谁在场、名字、是否在一局小游戏里也在里面。改了这些就调 `touchScene`，让同一场景实例里的人拿到新快照；往快照里加字段时，想清楚它变的时候谁来通知。
- 读位置用 `posOf` / `positionOfResident`：位置按折线和时间现算，永远截断在导航控制租约的截止时刻。不要自己插值，不要存每帧坐标。
- 导航的每次变化（开始、改道、停止、穿过门口、结束）都递增 `nav_revision`；`nav_step` 任务必须对上导航编号和版本才生效。
- 键盘方向输入只是一段租约约 500 毫秒（`dirLeaseMs`）的短直线导航（目的地 `dir`），仍走同一套折线、租约截断和 `nav_revision`；它没有进出口，进出私宅只走 `navigate`。它的路线不能用点地的 10 秒续租撑长，零向量只停方向输入自己的路线，到期和松手都不发事件。 点地 / 停下的动作带 `dirFence`（序号栅栏），让发在它之前、晚到的方向帧确定地作废，不用时间窗。
- 坐标只出现在两处：本人视图里自己的位置、`sceneView` 里同一场景实例中在场的人。事件（`w.emitTo` / `w.emitPublic`）、公开投影、日报里不能有坐标、折线、到达时间。私宅实例的快照只给屋里的人。
- 地图（`spatial/town-map.ts`）发布后不原地改：动了可走范围、落脚点或物件位置就换 `mapVersion`。`spatial/` 下的模块是纯函数：不读数据库、不取时间、不用随机数。
- 给居民的私有事件用 `w.emitTo()`，公开事件用 `w.emitPublic()`；固定模板的通知不要拼进别人的私密信息。
- 小游戏是原来的游戏定义，由 `GameRunner`（`src/core/runner.ts`）推进；嵌入的记录在世界数据库的 `game_records` 里，公共 `GameManager` 不持有。只有 `embeddable: true` 且通过接入检查的游戏能在镇上开。
- 时间用 `w.now()`，随机用 `w.rng` / `w.gameRng`，不要用 `Date.now()` 和 `Math.random()`。
- 新的动作类型：在对应模块的 `install*` 里注册 handler，补 `docs/TOWN.md` 的动作表、`mcp/town.ts` 的指南、`agent-kit/prompts/resident-zh.md`，并加测试（`test/world/`，辅助在 `test/world/helpers.ts`）。
- 部署、密钥和服务器配置不在开发范围内。

## 代码地图

仓库是 npm 工作区，三个包：

- `packages/engine`（npm 包 `bot-game-mcp`）：引擎。
  - `src/core/manager.ts`：GameManager，包括大厅、抽签、推进（pump）、投递、长轮询、视角、裁判和存档。
  - `src/core/game.ts`：BaseGame 基类。参考实现是 `src/games/number-bomb/index.ts`。
  - `src/mcp/server.ts`：工具、资源、提示词。`src/mcp/guides.ts` 是给 agent 的指南文本。`src/mcp/town.ts` 是小镇的工具和世界上下文路由。
  - `src/core/runner.ts`：GameRunner，从 GameManager 抽出来的「推进一局」，公共对局和小镇的嵌入小游戏共用。
  - `src/world/`：持续世界「栖灯镇」（`service.ts` 命令管线与调度，`db.ts` SQLite，`space.ts` 空间权威，`spatial/` 地图、寻路、运动的纯函数，其余按模块：identity、life、property、mail、interact、social、games、reports、views、http、ws）。旧页面在 `town/`（静态文件，无构建；会被 Godot 网页客户端取代）。配置了 `town.clientDir` 时，引擎在 `/town/3d/` 托管三维客户端的导出产物。
  - `src/server/`：HTTP、SSE、stdio、bridge 传输。
  - 测试：`test/helpers.ts` 提供 FakeClock、`startGame`、`playToEnd`。
- `packages/referee-onebot`（`bot-game-mcp-referee-onebot`，命令 `bot-game-referee`）：代码裁判，OneBot v11 正向 WebSocket。只能通过 MCP 协议和引擎说话。
- `packages/agent-kit`（`bot-game-mcp-agent-kit`）：接入端客户端、`waitForTurn`、提示词 `playerPrompt()`；`prompts/player-zh.md` 必须和代码一致（有测试）；`examples/` 是各 agent 框架的接入示例。
- `client/`：栖灯镇的 Godot 4 网页客户端（不是 npm 工作区）。`client/town/` 是 Godot 工程（`scripts/` GDScript，`web/` 是网页外壳和 DOM 界面，文字全在 HTML 里），`client/tools/export.sh` 导出，`client/ASSETS.md` 是素材许可台账，说明见 `client/README.md`。客户端不做预测：只按服务器给的折线和服务器时间插值。
- `scripts/e2e.ts`：黑盒端到端，跨三个包。`scripts/world-simulate.ts`、`world-load.ts`、`world-recovery.ts`：小镇的长时间模拟、压测、故障注入。

裁判和接入端不得 import 引擎内部代码；它们的测试通过包名 `bot-game-mcp` 使用引擎（vitest 和 tsconfig 已映射到引擎源码）。

## 进度记录

重要进展和测试结果记在 `docs/PROGRESS.md`。上下文被压缩之后，先读它。
