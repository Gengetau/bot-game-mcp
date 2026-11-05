# bot-game-mcp-agent-kit（接入端）

给 AI 玩家用的接入工具。引擎本身就是 MCP 服务器，任何 MCP 客户端都能直接连；这个包把常用的工具包成方法，加上「等到轮到我」的辅助函数和给聊天 bot 用的提示词。

尚未发布到 npm。在仓库里 `npm ci && npm run build` 后，从 `packages/agent-kit/dist/` 引用（或 `npm link -w bot-game-mcp-agent-kit`）。需要 Node.js 22 或更高。

接入前先自检（连接、身份、本群对局）：

```bash
bot-game-check --url https://主机/mcp --key bgk_你的密钥 --group 群号   # 或 node packages/agent-kit/dist/check.js
```

外接别人主持的群，整套步骤见 [docs/ONBOARDING.md](../../docs/ONBOARDING.md)。

```ts
import { BotGameClient, waitForTurn } from 'bot-game-mcp-agent-kit';

const client = await BotGameClient.connect({ url: 'http://127.0.0.1:7700/mcp', key: process.env.BOTGAME_KEY });
const { games } = await client.listGames('群号');
await client.joinGame(games[0].game_id, { as: 'player' });
for (;;) {
  const view = await waitForTurn(client, games[0].game_id);   // 长轮询，轮到我或游戏结束才返回
  if (view.game.status !== 'running') break;
  // view.todo.prompt 是要做的事，view.todo.actions[i].example 是调用示例
  await client.act({ action: 'guess', number: 50 }, games[0].game_id);
}
```

- `BotGameClient`：`whoami`、`listGames`、`getRules`、`createGame`、`joinGame`、`leaveGame`、`startGame`、`getMyView`、`speak`、`act`、`getGameLog`，以及任意工具的 `call`。引擎拒绝时抛 `ToolError`，message 是引擎给的原因。
- `waitForTurn(client, gameId, { waitSeconds, maxWaits })`：轮到我或游戏结束才返回。
- `playerPrompt({ toolPrefix, refereeName, sendTool })`：给「只有被 @ 才会醒来」的聊天 bot 用的中文提示词；`prompts/player-zh.md` 是同一段文字，`{p}` 是工具名前缀占位。

示例（`examples/`）：

| 文件 | 内容 |
|---|---|
| `code-agent.ts` | 纯代码玩家：报名、等回合、照示例行动 |
| `claude-agent-sdk.py` | Claude Agent SDK：把引擎挂成 MCP 服务 `game`，用 `can_use_tool` 只放行玩家工具 |
| `openai-agents.py` | OpenAI Agents SDK：`MCPServerStreamableHttp`，注意把会话超时调到大于长轮询秒数 |

更多客户端（Claude Code、Cursor、官方 MCP SDK 等）见仓库 [docs/CLIENTS.md](../../docs/CLIENTS.md)。
