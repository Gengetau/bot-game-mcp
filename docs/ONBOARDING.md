# 外接 bot 接入指南

这页写给**想把自己的 bot 接进别人主持的桌游群**的人（或 agent）。引擎跑在主机那边，你只需要让自己的 bot 连上它。照着做完每一节的「检查」，就能上桌。

一句话版本：主机给你一个地址和一把密钥；你的 bot 用 MCP（Streamable HTTP）连上去，被裁判在群里 @ 时调用 `join_game`、`get_my_view`、`speak`、`act`；想当裁判候选就另外跑一个 `bot-game-referee --follower`。

## 0. 先向主机要这几样

| 要什么 | 样子 | 用在哪 |
|---|---|---|
| 引擎的 MCP 地址 | `https://xxx.ts.net/mcp`（Tailscale Funnel）或 `http://主机:7700/mcp` | 所有连接 |
| 你的密钥 | `bgk_` 开头的一串 | HTTP 头 `Authorization: Bearer <密钥>` |
| 群号 | 例如 `1127334885` | `list_games(group_id)` |
| 裁判账号的 QQ 号和昵称 | 例如 妮娅 | 识别「是裁判在 @ 我」 |

密钥有两种拿法：

- **主机开了自助发放**（裁判进程带 `--key-issuer`）：先把你的 bot 拉进群，然后用你自己的 QQ **私聊负责发密钥的那个 bot 账号**（群里发「/桌游 帮助」会告诉你是谁），发「申请密钥 <bot的QQ号> <bot的昵称>」。它会私聊回你密钥、引擎地址和自检命令。申请人和 bot 都得在群里；再发一次会作废旧密钥，「撤销密钥 <QQ号>」作废；每人最多几把由主机定。发过密钥的 bot 自动进裁判的 `--bots`。
- **主机手工登记**：把**自己 bot 的 QQ 号和昵称**告诉主机，主机在引擎配置的 `auth.agents` 里给你登记一行（或用管理员密钥调用 `issue_key`），并把你的 QQ 号加进裁判的 `--bots` 列表。

进了 `--bots` 之后开房时裁判会 @ 你报名，你的群消息也不会被当成真人指令转交。

你的 bot **必须在那个 QQ 群里**，并且有自己的 QQ 框架（NapCat / LLOneBot / Lagrange / NoneBot / Koishi / AstrBot 等）能收群消息、发群消息。引擎不直接连 QQ。

主机侧要注意：对外开放的引擎必须是 keys 模式（配置里有 `auth.agents`），不要用 open 模式；经隧道暴露时把 `publicApi` 设为 `false`，没有特殊需要就别设 `allowedHosts`。想让别人自助拿密钥，裁判进程加 `--key-issuer <发放账号的QQ号> --issuer-key-file <引擎管理员密钥文件> --public-url <隧道地址>`，引擎会把发出去的密钥存在 `auth.issuedKeysFile`（默认 `./data/botgame-keys.json`）里，重启不丢。

## 1. 安装（Node.js 22 或更高）

三个包**尚未发布到 npm**，从仓库构建：

```bash
git clone https://github.com/Gengetau/bot-game-mcp.git
cd bot-game-mcp
npm ci
npm run build
```

构建完你会用到的命令（都在仓库里，不需要全局安装）：

| 用途 | 命令 |
|---|---|
| 连通性自检 | `node packages/agent-kit/dist/check.js` |
| 裁判进程（可选，想进裁判抽签池才需要） | `node packages/referee-onebot/dist/cli.js` |
| stdio 桥接（只能启动本地命令的客户端用） | `node packages/engine/dist/cli.js bridge` |
| TypeScript 客户端库 | `import … from '<仓库>/packages/agent-kit/dist/index.js'` |

想要短命令就 `npm link -w bot-game-mcp -w bot-game-mcp-referee-onebot -w bot-game-mcp-agent-kit`，之后 `bot-game-check`、`bot-game-referee`、`bot-game-mcp` 都能直接用。下文用短命令。

裁判进程和接入库都只依赖 MCP SDK，不依赖引擎包；引擎在主机那边跑，你这边不用启动它。

## 2. 先自检，再接框架

```bash
bot-game-check --url https://xxx.ts.net/mcp --key bgk_你的密钥 --group 群号
```

正常输出三行 ✅：已连接、身份是你的昵称和 QQ 号、本群现在没有对局（或列出对局）。

| 看到 | 原因 |
|---|---|
| 连不上 / 超时 | 地址不对（要以 `/mcp` 结尾）、主机没开隧道、你的网络不通 |
| 401 / 403 | 密钥不对，或主机还没把你登记进 `auth.agents` |
| 身份是别人 | 主机给错了密钥 |

自检通过后，把**同一个地址和密钥**填进你的 agent 框架。

## 3. 把引擎挂进你的 agent

引擎是标准的 MCP 服务器（Streamable HTTP）。任何支持远程 MCP 的框架都能直接加，填这三样：

- 地址：`https://xxx.ts.net/mcp`
- 请求头：`Authorization: Bearer bgk_你的密钥`（只能填地址的客户端可以用 `?key=bgk_…`，但密钥会进日志，能不用就不用）
- 工具调用超时：**大于 55 秒**（`get_my_view` 的 `wait_seconds` 最长 50 秒；聊天 bot 不用长轮询，可以不管）

各框架的具体写法见 [CLIENTS.md](CLIENTS.md)：Claude Code、Claude Desktop（stdio 桥接）、Cursor、Cherry Studio、OpenAI Agents SDK、官方 MCP SDK（TypeScript / Python）。`packages/agent-kit/examples/` 里有 Claude Agent SDK、OpenAI Agents SDK 和纯代码玩家三个完整示例。

给大模型的系统提示词：把 [`packages/agent-kit/prompts/player-zh.md`](../packages/agent-kit/prompts/player-zh.md) 贴进去，把其中的 `{p}` 换成你框架里的工具名前缀（Claude Agent SDK 挂成 `game` 服务时是 `mcp__game__`，没有前缀就删掉）。也可以直接用引擎提供的 MCP prompt `player` 或资源 `botgame://guide/player`。

只放行这些工具给玩家模型：`list_games`、`get_rules`、`join_game`、`leave_game`、`get_my_view`、`speak`、`act`、`get_game_log`、`whoami`。`referee_*`、`relay_human_message`、`create_game`、`start_game`、`abort_game`、`issue_key`、`revoke_key`、`list_keys` 玩家用不到，不给更稳（后三个本来也只有管理员密钥能调）。

## 4. 一局里你的 bot 会经历什么

你的 bot 有两种工作方式，选一种：

- **被 @ 唤醒**（群聊 bot 的常态）：主机开房时带 `nudge_ai: true`，裁判会在需要你行动时 @ 你。被 @ 后调用一次 `get_my_view(wait_seconds=0)`，有 `todo` 就做，没有就什么都不做也不回话。
- **自己循环**（代码写的玩家）：开局后反复 `get_my_view(wait_seconds=50)`，轮到自己才返回；见 [`packages/agent-kit/README.md`](../packages/agent-kit/README.md) 的 `waitForTurn`。

群里会出现的消息（文字都是程序生成的，裁判账号原样发出）：

| 阶段 | 群里的消息 | 你要做的 |
|---|---|---|
| 开房 | `🎮【狼人杀】房间 WW-ABCD 已开启（6~12 人）！…` 紧接着一条 `@你 @其他bot AI 玩家请调用 join_game(game_id="WW-ABCD", join_as="player") 报名。` | `join_game({game_id:"WW-ABCD", join_as:"player"})`，成功后在群里简短说一句 |
| 开局 | `🎲【狼人杀】对局 WW-ABCD 开始！本局裁判：…座位表…` | 不用回应 |
| 阶段开始（秘密阶段 / 多人同时行动） | `@你 @… 【第 1 夜】请调用 get_my_view 查看自己的行动面板：有待办就在 2 分 30 秒内完成，没有就不用回应。` | `get_my_view()`；有 `todo` 照 `todo.actions[i].example` 调 `act`，或 `speak` |
| 轮到你发言 / 猜数 / 叫牌 | `👉 … 请 @你 …（限时 …）` | `speak({text})`；返回里有 `post_to_group` 就把同一段话发到群里 |
| 限时过半还没行动 | `⏰ @你 【…】还剩 1 分 10 秒，请尽快行动…` | 同上，别拖 |
| 结束 | `🏁 … 获胜 …` 和身份揭晓 | 不用回应 |

几个要点：

- `join_game` 的 `self_post` 默认 `true`：发言由你自己发到群里（所以 bot 要在群里、能发消息）。你的框架发不了群消息就报名时传 `self_post: false`，裁判会以「【3号 你的昵称】……」代发。
- 投票、夜里的动作只用 `act` 提交，不要在群里发「投3」；秘密阶段提交完什么都别说。
- 不轮到你别插话。你的群消息对引擎没有任何效果（裁判不转交 bot 账号的消息），只会刷屏。
- 没在限时内行动，程序按弃票 / 跳过 / 随机托管，不会等你。
- 你的身份只出现在你自己的 `get_my_view` 里，不经过任何人。

## 5. 可选：让你的账号也能当裁判

裁判由程序在「登记过代行的账号」里抽签。要让你的 bot 进抽签池，在你这边再跑一个进程（它只是消息总线，没有任何能影响结果的接口）：

```bash
bot-game-referee --url https://xxx.ts.net/mcp --key-file 你的密钥文件 \
  --onebot ws://127.0.0.1:3001/ --onebot-token-file 你的OneBot密钥文件 \
  --group 群号 --host-id 任意固定字符串 --follower
```

- `--onebot` 是**你自己** QQ 框架的 OneBot v11 正向 WebSocket（Universal 角色）。token 留在你机器上，引擎和主机都不会看到。
- `--follower`（跟随模式）：不开房、不响应 `/桌游` 指令、不当候补。它只在你的 bot 报名后向引擎登记「抽中我就由我代行」，抽中了就用你的账号发公告、私聊真人、转交真人消息。群里的开房开局仍由主机的裁判负责，两边不会抢话。
- `--host-id`：这个进程的名字，随便起但**重启后要一样**。引擎靠它区分「代行进程」和「你的大模型」：抽中你当裁判时，你的大模型调 `referee_step` 只会得到 `hosted: true` 的空结果，`get_my_view` 会告诉它这局休息。所以不要把这个值给大模型用。
- 只有一个账号就不需要 `--voices`；主参数里的那个账号就是会进池子的账号。
- 真人要收到你账号发的私聊（身份牌、夜间结果），得先加你的 bot 为好友，或者你的 QQ 框架支持群临时会话。
- 你的 bot 被抽中当裁判时，它那局不是玩家。这由引擎保证：它的 `get_my_view` 里 `you.role` 是 `referee`，`todo` 永远为空。
- 人数不够时程序不会把玩家抽去当裁判（比如狼人杀最少 6 人，正好 6 人报名时只会抽没报名的裁判账号），这是正常的。

跟随进程的日志里看到 `已登记 … 进裁判抽签池` 表示登记成功，`本局裁判 … 由本进程代行` 表示这局轮到你主持。

## 6. 常见问题

- **裁判 @ 了我，但我的 bot 没动**：确认框架的 MCP 配置里带了 `Authorization` 头；用 `bot-game-check` 再测一次；看 `get_my_view` 有没有被调用（返回里 `todo` 为空就是真的不用动）。
- **`join_game` 说对局已开始 / 不存在**：报名窗口已经关了，等下一局；`game_id` 以裁判 @ 你那条消息里的为准。
- **`speak` / `act` 被拒绝**：返回里有原因，常见是没轮到你、动作不在 `todo.actions` 里、目标已出局。改参数再试一次即可。
- **想自己开房**：主机开了 `--bot-commands` 的话，你的 bot 在群里发「/桌游 谁是卧底」就能开房、发「/桌游 开局」开局（中止只有管理员能发）。开了房没凑够人，默认 10 分钟没有新人报名会自动取消，不用你收拾。没开的话只有管理员能开房（`--admins`），整台服务器也可能一次只开一局（`maxActiveGames`）。本地想随便玩，自己起一个引擎：`node packages/engine/dist/cli.js serve`，然后 `node packages/engine/dist/cli.js simulate werewolf --players 9 --humans 0`。
- **工具列表看不到 `referee_offer`**：那是裁判进程用的，你的大模型不需要。
