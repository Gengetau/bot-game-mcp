# 接入指南

这份文档讲两件事：

1. 怎样把各种 agent 或客户端连上引擎；
2. 怎样在 QQ 这一侧收发消息。

各客户端的配置方式更新很快，具体字段请以它们的最新文档为准。下面列出的是要填哪些信息，以及我们验证过的写法。

## 1. 连接方式

| 方式 | 地址或命令 | 适用场景 |
|---|---|---|
| Streamable HTTP（推荐） | `http://主机:7700/mcp` | 大多数新客户端。多个 bot 共享同一个引擎 |
| 旧版 HTTP+SSE | `http://主机:7700/sse`，消息发到 `/messages` | 只支持 SSE 的旧客户端 |
| stdio 桥接 | `bot-game-mcp bridge --url http://主机:7700/mcp --key 密钥` | 只能启动本地命令的客户端（如 Claude Desktop） |
| stdio 独立 | `bot-game-mcp stdio --agent-id QQ号 --agent-name 昵称` | 引擎和客户端在同一进程，只有一个 agent。适合本地调试，或「一个裁判 bot + 全真人」 |

**认证**（keys 模式）有三种写法，任选其一：

- `Authorization: Bearer <密钥>`
- `X-API-Key: <密钥>`
- URL 参数 `?key=<密钥>`，给只能填地址的 SSE 客户端用

open 模式不需要密钥：连上后先调用 `login(qq_id, nickname)`。

**长轮询与超时**：`referee_step` 和 `get_my_view` 的 `wait_seconds`（0~50）会让这次工具调用最多阻塞那么多秒，有新情况会提前返回。请确认客户端的工具调用超时比它长，否则就把 `wait_seconds` 调小（`0` 表示立即返回）。

**没有 npm 包时**：本项目尚未发布到 npm，下面示例里的 `bot-game-mcp` 命令需要先在仓库里 `npm run build && npm link`。也可以写成 `node /绝对路径/bot-game-mcp/dist/cli.js`。

## 2. 常见客户端

### Claude Code

```bash
claude mcp add --transport http bot-game http://127.0.0.1:7700/mcp \
  --header "Authorization: Bearer bgk_你的密钥"
```

也可以把配置写进项目根目录的 `.mcp.json`，参考 [examples/clients/claude-code.mcp.json](../examples/clients/claude-code.mcp.json)。

### Claude Desktop（stdio 桥接）

在 `claude_desktop_config.json` 里加入下面的配置，参考 [examples/clients/claude-desktop-bridge.json](../examples/clients/claude-desktop-bridge.json)：

```json
{
  "mcpServers": {
    "bot-game": {
      "command": "node",
      "args": ["/绝对路径/bot-game-mcp/dist/cli.js", "bridge", "--url", "http://127.0.0.1:7700/mcp", "--key", "bgk_你的密钥"]
    }
  }
}
```

桥接进程会把工具、资源、提示词原样转发到远端引擎。

### Cursor 等支持远程 MCP 的编辑器

在 `.cursor/mcp.json` 或全局配置里写（也可以参考 [examples/clients/cursor.mcp.json](../examples/clients/cursor.mcp.json)）：

```json
{
  "mcpServers": {
    "bot-game": {
      "url": "http://127.0.0.1:7700/mcp",
      "headers": { "Authorization": "Bearer bgk_你的密钥" }
    }
  }
}
```

### Cherry Studio 等图形客户端

新建 MCP 服务器，按下面填写：

- **类型**：选「可流式传输的 HTTP（streamableHttp）」。
- **URL**：`http://127.0.0.1:7700/mcp`。
- **请求头**：`Authorization=Bearer bgk_你的密钥`。

如果客户端只支持 SSE，类型选 SSE，URL 填 `http://127.0.0.1:7700/sse?key=bgk_你的密钥`。

### OpenAI Agents SDK（Python）

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async with MCPServerStreamableHttp(
    name="bot-game",
    params={
        "url": "http://127.0.0.1:7700/mcp",
        "headers": {"Authorization": "Bearer bgk_你的密钥"},
        "timeout": 30,
        "sse_read_timeout": 300,
    },
    client_session_timeout_seconds=70,   # 默认只有 5 秒，必须改成比 wait_seconds 长
) as server:
    agent = Agent(name="狼人杀玩家", instructions="……", mcp_servers=[server])
    result = await Runner.run(agent, "调用 get_my_view 看看轮到你没有")
```

`client_session_timeout_seconds` 不改的话，`referee_step(wait_seconds=25)` 会在 5 秒后报 `Request 'tools/call' timed out`（openai-agents 0.24.0 实测）。

### 官方 MCP SDK（TypeScript）

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-qq-bot', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7700/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer bgk_你的密钥' } },
  }),
);
const res = await client.callTool(
  { name: 'referee_step', arguments: { wait_seconds: 25, format: 'onebot' } },
  undefined,
  { timeout: 60_000 },
);
const data = JSON.parse((res.content as { text: string }[])[0]!.text);
```

所有工具都返回一个 JSON 文本块。出错时 `isError: true`，文本里有中文原因和建议。

### 官方 MCP SDK（Python）

`pip install mcp` 现在装到的是 2.x，连接函数和 1.x 不同，请按版本选用。两种写法都在服务器上实测过（mcp 2.3.0 与 1.30.0）。

mcp 2.x：请求头和超时都通过自己创建的 `httpx2.AsyncClient` 传入。**一定要设置 `read` 超时**，否则默认只有 5 秒，`referee_step(wait_seconds=25)` 会报 `SSE stream ended without a response`。

```python
import json
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async with httpx2.AsyncClient(
    headers={"Authorization": "Bearer bgk_你的密钥"},
    timeout=httpx2.Timeout(30, read=120),   # read 要比 wait_seconds 长
) as http:
    async with streamable_http_client("http://127.0.0.1:7700/mcp", http_client=http) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            r = await session.call_tool("referee_step", {"wait_seconds": 25, "format": "onebot"})
            data = json.loads(r.content[0].text)   # 出错时 r.is_error 为 True
```

mcp 1.x：默认的 `sse_read_timeout` 是 300 秒，长轮询不用额外设置。

```python
import json
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
    "http://127.0.0.1:7700/mcp", headers={"Authorization": "Bearer bgk_你的密钥"}
) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        r = await session.call_tool("referee_step", {"wait_seconds": 25, "format": "onebot"})
        data = json.loads(r.content[0].text)   # 出错时 r.isError 为 True
```

## 3. 给 agent 的提示词

引擎自带两段系统提示词，通过 MCP prompt 或 resource 获取：

| 用途 | prompt | resource |
|---|---|---|
| 裁判 | `referee` | `botgame://guide/referee` |
| 玩家 | `player`（可带 `game_type` 参数，附上该游戏的策略提示） | `botgame://guide/player` |
| 总览 | — | `botgame://guide/overview` |

如果客户端不支持 MCP prompt，可以把资源内容贴进 agent 的系统提示词。

## 4. QQ 这一侧

引擎不直接连接 QQ。每个 bot 用自己的 QQ 框架收发消息，比如：

- **OneBot v11 实现**：NapCat、LLOneBot、Lagrange.OneBot 等；
- **bot 框架**：NoneBot2、Koishi、AstrBot 等。

如果框架内置了 MCP 客户端，按它的文档添加一个 Streamable HTTP 服务器即可，bot 的大模型就能直接调用工具。否则，用上面的官方 SDK 写几十行胶水代码。

### 4.1 裁判要做什么

裁判的工作完全是机械的：取消息、发消息、转交真人消息。所以有两种做法：

- **大模型驱动**：给裁判 agent 配上 `referee` 提示词，让它自己循环调用工具。实现最简单，但每一步都要经过大模型，速度慢、消耗 token。
- **代码驱动（推荐）**：在 bot 框架里用代码实现下面的循环。这个 bot 在引擎看来仍然是一个以 `referee` 身份报名的 agent，由程序抽签选中，只是它的「思考」是固定代码。可靠、零 token、延迟低。

```ts
// 开局后：裁判循环
for (;;) {
  const r = await call('referee_step', { game_id, wait_seconds: 25, format: 'onebot' });
  for (const d of r.deliveries) {
    if (d.to === 'group') await onebot('send_group_msg', { group_id: Number(d.group_id), message: d.message });
    else await onebot('send_private_msg', { user_id: Number(d.user_id), message: d.message });
  }
  if (r.finished) break;
}

// 收到 QQ 消息时（群聊和私聊都要处理）
async function onMessage(ev) {
  if (ev.user_id === ev.self_id) return;                                  // 忽略自己
  if (ev.message_type === 'group' && String(ev.group_id) !== group_id) return;  // 只管本局所在的群
  await call('relay_human_message', {
    game_id,
    qq_id: String(ev.user_id),
    nickname: ev.sender?.card || ev.sender?.nickname,
    text: ev.raw_message,       // 直接给 CQ 码原文，程序认得 [CQ:at,…]，也会去掉开头的「回复」和 @裁判
    channel: ev.message_type === 'private' ? 'private' : 'group',
  });
}
```

要点：

- **按顺序发**：`deliveries` 已经排好序，并且考虑了发言间隔，按返回顺序逐条发出即可。程序会等裁判取走前一阶段的公告之后，才开放下一阶段、开始计时，所以真人不会在看到提示之前就被计时。
- **不用自己筛选消息**：本局群里的真人消息、真人发给裁判的私聊，一律转交。不是指令的会被忽略。AI 玩家和非玩家的消息，程序也会自动忽略。
- **报名阶段**：真人在群里说「加入」「退出」，同样用 `relay_human_message` 转交（要带 `nickname`）。这一步任何已报名本局的 AI 都能做，不一定是裁判。
- **发送失败**：例如对方没加好友，私聊发不出去。记下失败的 `seq`，问题解决后用 `referee_step(since_seq=失败的seq-1)` 重发。`since_seq` 只能用于重发，不会跳过还没发出的消息。
- **私聊限制**：QQ 只能给好友发私聊。部分 OneBot 实现支持带 `group_id` 走群临时会话（`referee_step` 的结果里有 `group_id`）。开局前最好提醒真人先加裁判 bot 为好友。
- **掉线接管**：裁判超过 `refereeStaleSeconds`（默认 120 秒）没有调用 `referee_step`，候补裁判就可以 `referee_takeover`。候补裁判是开局时没抽中的裁判候选，或者开局后用 `join_game(join_as="referee")` 登记的非玩家 AI。接管后从上一任交付到的位置继续发。

### 4.2 AI 玩家要做什么

```text
get_my_view(wait_seconds=50)        # 等到轮到自己才返回；you 里是自己的身份/词语/骰子
  ├─ todo.kind == "speech" → speak(text)；如果结果里有 post_to_group，就把这段发言发到群里
  └─ 其他 → act({action, target/quantity/face/number})，可用的动作在 todo.actions 里
重复，直到 game.status 不再是 running
```

- AI 玩家的私密信息只出现在自己的 `get_my_view` 里，**不会**通过私聊下发。
- `self_post=true`（默认）时，AI 玩家自己把发言发到群里。程序会在它之后的消息前留出发言间隔（默认 3 秒，可用 `speech_gap_ms` 调整）。`self_post=false` 时由裁判代发。
- 狼人夜间密谈用 `speak(text, channel="team")`。真人狼人会通过裁判私聊收到队友的发言。

### 4.3 纯 MCP 对战（不连 QQ）

开房时加上 `auto_referee: true`，程序会自己推进对局，不需要 AI 裁判，也不会往 QQ 发任何消息。适合 agent 之间对战、做评测，或者调试自己的玩家策略。

你也可以先用模拟器离线观察整局流程：`bot-game-mcp simulate werewolf --players 9 --humans 2`。
