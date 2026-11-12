# bot-game-mcp-referee-onebot（代码裁判）

用一个或多个 OneBot v11 账号（正向 WebSocket，NapCat / LLOneBot / Lagrange / SnowLuma 等都可以）主持 QQ 群桌游：把引擎的消息按顺序发到群里和私聊里，把真人的群聊和私聊原文转交给引擎（私聊发给非好友被拒时，自动带上群号改走群临时会话；对方还没发起过临时会话时，在群里 @ 他私聊一句，收到后补发），响应「/桌游」指令开房、开局、中止。带多个账号时，报名的 bot 里能替其说话的都进裁判抽签池，抽中谁就用谁的账号主持，并发一张转盘图；抽中账号自己的模型拿不到任何该发的话。它只用裁判能用的那几个工具，没有任何能影响结果的接口。

只依赖 `@modelcontextprotocol/sdk`，不依赖引擎包；引擎可以跑在另一台机器上。

尚未发布到 npm：在仓库里 `npm ci && npm run build`，命令是 `node packages/referee-onebot/dist/cli.js`（`npm link -w bot-game-mcp-referee-onebot` 后可直接用 `bot-game-referee`）。需要 Node.js 22 或更高。

```bash
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
| `--bot-commands` | 允许 `--bots` 里的账号发「/桌游 <游戏>」开房、「/桌游 开局」开局；它们的其余群消息照旧忽略，「中止」仍只有管理员能用 |
| `--options` | 每局默认的 `create_game` 选项（JSON），常用 `nudge_ai`（阶段开始时 @ AI 玩家）和各阶段超时 |
| `--auto-start` | 报名够最少人数后，多少秒没有新人加入就自动开局（默认 60；`0` 关闭，只认「/桌游 开局」）。开房时写了人数（`/桌游 狼人杀 7`）则凑满就开 |
| `--lobby-timeout` | 人数还不够最少人数时，多少秒没有新人报名就取消房间（默认 600，即 10 分钟；`0` 关闭）。bot 自己开的房没人玩也不会一直挂着 |
| `--voices` | 额外账号的 JSON 文件：`[{"keyFile": "claire.key", "onebot": "ws://127.0.0.1:3011/", "onebotTokenFile": "claire.token"}, …]`，路径相对该文件。报名了的这些账号进裁判抽签池 |
| `--host-id` | 本进程的标识（默认主机名）。引擎用它区分代行进程和账号自己的模型，重启后要保持一致 |
| `--no-self-in-pool` / `--no-wheel` | 主账号不进抽签池 / 不发转盘图 |
| `--main-plays` | 主账号也参赛：开房时不自动当裁判候选，由它自己的模型 `join_game` 报名当玩家，报名了就进抽签池（抽中由本进程代行裁判，没抽中就上场玩）。抽不出别的裁判时开局前把它改回裁判，这局坐庄。它的模型没报名时和原来一样当裁判 |
| `--wheel-font` | GNU Unifont 的 `.hex` 或 `.hex.gz`，转盘图上写中文名用；没有则中文画成方块 |
| `--follower` | 跟随模式，给外接 bot 用：不开房、不响应指令、不当候补，只在自己的账号报名后登记进抽签池，抽中了就用自己的账号主持。见 [docs/ONBOARDING.md](../../docs/ONBOARDING.md) |
| `--key-issuer` | 负责发密钥的账号（主账号或 `--voices` 里某个账号的 QQ 号）。群成员私聊它「申请密钥 <bot的QQ号> <bot的昵称>」就通过引擎的 `issue_key` 发一把密钥并私聊回去（附引擎地址和自检命令）；「撤销密钥 <QQ号>」作废；管理员可发「密钥列表」。申请人和 bot 都必须在群里（管理员不限），每人最多 `--max-keys` 把（默认 3）；发过密钥的 QQ 号自动算进 `--bots`（启动时和每次开房前都会从引擎重新读，所以别处发的密钥也能认出来） |
| `--issuer-key-file` / `--public-url` | 发密钥用的引擎管理员密钥文件（不给则发放账号自己的密钥得是管理员），管理员「/桌游 中止」也用它，这样 bot 自己开的房、程序自动主持的局也能中止；告诉申请人的引擎地址（经隧道暴露的那个，默认和 `--url` 一样） |
| `--prefix` / `--wait` | 指令前缀（默认 `/桌游`）与长轮询秒数（默认 25） |
| `--town` | 接入栖灯镇（见下一节）；默认不开，不开时裁判的行为和以前完全一样 |

群里的指令：`/桌游 狼人杀 [人数] [选项]`、`/桌游 开局`（提前开）、`/桌游 中止`、`/桌游 状态`、`/桌游 规则 狼人杀`、`/桌游 帮助`；报名发「加入」。

## 栖灯镇：登录链接与公告（可选）

栖灯镇是引擎里一直运行的持续世界（见 [docs/TOWN.md](../../docs/TOWN.md)）。真人通过裁判拿一次性登录链接进入；裁判只做搬运，登录票据由引擎的 `town_issue_ticket` 签发。前提：引擎开了 `town.enabled`，并且裁判账号在引擎的 `refereeIds` 里。

```bash
bot-game-referee … --town                       # 真人发「小镇」「进小镇」「栖灯镇」领登录链接
bot-game-referee … --town --town-outbox         # 再加上：把小镇的稀疏公告转发到群里
```

领取登录链接：

- 真人在群里或私聊裁判账号发关键词（整条消息就是关键词才算，可以带 `/桌游` 前缀、前导斜杠和句尾标点；「小镇好玩吗」「小镇 12345」不触发）。
- 裁判用**消息事件里的发送者 QQ 号**和群名片 / 昵称调 `town_issue_ticket`，把链接**只私聊**发给本人，群里只回一句「登录链接已私聊给你」。号码从不读消息文字，在消息里 @ 或写别人的号码也不会给别人签票。
- 私聊发不出去（不是好友、没有临时会话）时，群里提示「先加好友 / 点头像发起临时会话再发一次」，不在群里贴链接，也不存起来补发（票据几分钟就过期）。
- 同一个人默认 60 秒只能领一次（`--town-cooldown`）；冷却内只提示一次「刚发过」。
- 私聊领取默认要求对方在本群里（管理员不限；`--town-open-private` 关掉这个要求），免得陌生人私聊机器人就能拿到链接。bot 账号（`--bots`）和裁判自己的账号不会被签票。
- 引擎没开小镇（没有 `town_issue_ticket` 工具）：群里回「小镇没开」，`--town-silent` 则不响应。
- 登录票据和链接是凭证：不写日志，不进群。

公告转发（`--town-outbox`，默认关）：每隔 `--town-outbox-interval` 秒（默认 300）调 `town_outbox` 取待发公告（公共活动开场、每日小报），按顺序发到 `--town-outbox-group`（默认 `--group`）；**发送成功才向引擎确认**。群消息发送失败就不确认，也不再发后面的，下个周期从这条重发（至少一次）；确认调用失败则下个周期先重试确认，不重发。

| 参数 | 说明 |
|---|---|
| `--town-keywords 小镇,进小镇` | 自定义关键词（逗号分隔，也可用 `BOTGAME_TOWN_KEYWORDS`）。默认「小镇」「进小镇」「栖灯镇」 |
| `--town-cooldown N` | 同一人两次领取的最短间隔秒数，默认 60 |
| `--town-silent` | 引擎没开小镇时不回话（默认回「小镇没开」） |
| `--town-open-private` | 私聊领取不要求对方在群里 |
| `--town-outbox-group / -interval / -limit` | 公告目标群、取公告的间隔秒数（默认 300）、每次最多几条（默认 5） |

环境变量 `BOTGAME_REFEREE_TOWN=1`、`BOTGAME_REFEREE_TOWN_OUTBOX=1` 等同 `--town`、`--town-outbox`。库用法是 `runReferee({ …, town: { keywords, ticketCooldownSeconds, whenOff, requireGroupMember, outbox: { intervalSeconds, limit, groupId } } })`。

库用法：`import { runReferee } from 'bot-game-mcp-referee-onebot'`，参数同上，传 `signal` 可以停止。详见仓库 [docs/CLIENTS.md](../../docs/CLIENTS.md) 的「QQ 这一侧」。
