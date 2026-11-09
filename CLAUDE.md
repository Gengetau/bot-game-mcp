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

## 代码地图

仓库是 npm 工作区，三个包：

- `packages/engine`（npm 包 `bot-game-mcp`）：引擎。
  - `src/core/manager.ts`：GameManager，包括大厅、抽签、推进（pump）、投递、长轮询、视角、裁判和存档。
  - `src/core/game.ts`：BaseGame 基类。参考实现是 `src/games/number-bomb/index.ts`。
  - `src/mcp/server.ts`：工具、资源、提示词。`src/mcp/guides.ts` 是给 agent 的指南文本。
  - `src/server/`：HTTP、SSE、stdio、bridge 传输。
  - 测试：`test/helpers.ts` 提供 FakeClock、`startGame`、`playToEnd`。
- `packages/referee-onebot`（`bot-game-mcp-referee-onebot`，命令 `bot-game-referee`）：代码裁判，OneBot v11 正向 WebSocket。只能通过 MCP 协议和引擎说话。
- `packages/agent-kit`（`bot-game-mcp-agent-kit`）：接入端客户端、`waitForTurn`、提示词 `playerPrompt()`；`prompts/player-zh.md` 必须和代码一致（有测试）；`examples/` 是各 agent 框架的接入示例。
- `scripts/e2e.ts`：黑盒端到端，跨三个包。

裁判和接入端不得 import 引擎内部代码；它们的测试通过包名 `bot-game-mcp` 使用引擎（vitest 和 tsconfig 已映射到引擎源码）。

## 进度记录

重要进展和测试结果记在 `docs/PROGRESS.md`。上下文被压缩之后，先读它。
