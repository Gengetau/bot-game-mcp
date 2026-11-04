# bot-game-mcp-referee-onebot（代码裁判）

用一个 OneBot v11 账号（正向 WebSocket，NapCat / LLOneBot / Lagrange / SnowLuma 等都可以）主持 QQ 群桌游：把引擎的消息按顺序发到群里和私聊里，把真人的群聊和私聊原文转交给引擎，响应「/桌游」指令开房、开局、中止。它只用裁判能用的那几个工具，没有任何能影响结果的接口。

只依赖 `@modelcontextprotocol/sdk`，不依赖引擎包；引擎可以跑在另一台机器上。

```bash
npm i bot-game-mcp-referee-onebot
bot-game-referee --url http://127.0.0.1:7700/mcp --key-file 裁判密钥文件 \
  --onebot ws://127.0.0.1:3001/ --onebot-token-file onebot密钥文件 --group 群号 \
  --admins 主人QQ号 --bots 玩家bot的QQ号,… --options '{"nudge_ai":true,"speech_gap_ms":15000}'
```

| 参数 | 说明 |
|---|---|
| `--url` / `--key` / `--key-file` | 引擎地址与这个裁判账号的密钥（也可用环境变量 `BOTGAME_URL`、`BOTGAME_KEY`） |
| `--onebot` / `--onebot-token-file` | OneBot 正向 WebSocket 地址与 access token（`BOTGAME_ONEBOT_URL`、`BOTGAME_ONEBOT_TOKEN`） |
| `--group` | 只服务这个群 |
| `--admins` | 能开房、开局、中止的 QQ 号；不填则人人可用 |
| `--bots` | 玩家 bot 的 QQ 号：开房时 @ 它们报名，它们的群消息不当作真人指令 |
| `--options` | 每局默认的 `create_game` 选项（JSON），常用 `nudge_ai`（阶段开始时 @ AI 玩家）和各阶段超时 |
| `--auto-start` | 报名够最少人数后，多少秒没有新人加入就自动开局（默认 60；`0` 关闭，只认「/桌游 开局」）。开房时写了人数（`/桌游 狼人杀 7`）则凑满就开 |
| `--prefix` / `--wait` | 指令前缀（默认 `/桌游`）与长轮询秒数（默认 25） |

群里的指令：`/桌游 狼人杀 [人数] [选项]`、`/桌游 开局`（提前开）、`/桌游 中止`、`/桌游 状态`、`/桌游 规则 狼人杀`、`/桌游 帮助`；报名发「加入」。

库用法：`import { runReferee } from 'bot-game-mcp-referee-onebot'`，参数同上，传 `signal` 可以停止。详见仓库 [docs/CLIENTS.md](../../docs/CLIENTS.md) 的「QQ 这一侧」。
