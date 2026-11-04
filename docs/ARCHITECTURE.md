# 架构

本文写给想读懂代码、排查问题或新增游戏的人。各模块的职责、核心不变量和数据流如下。

## 分层

仓库是一个 npm 工作区：引擎在 `packages/engine`（下文的 `src/` 都指它的 `src/`），代码裁判在 `packages/referee-onebot`，接入端在 `packages/agent-kit`。后两者只通过 MCP 协议和只读 HTTP 接口使用引擎，不 import 引擎内部代码。

```text
各个 bot 的 agent（MCP 客户端）
   │  Streamable HTTP / 旧版 SSE / stdio / bridge
   ▼
src/server/   传输层：HTTP 会话与密钥绑定、SSE、stdio、bridge、只读观战 API、定时器
src/mcp/      MCP 层：17 个工具、资源、提示词；认证（keys/open/admin）；消息渲染（text/CQ/OneBot）
src/core/     引擎：GameManager（大厅、抽签、推进、投递、长轮询、视角、裁判、存档）与 BaseGame 基类
src/games/    具体游戏：werewolf、undercover、liars-dice、number-bomb
```

MCP 层只做两件事：参数校验，把调用转给 `GameManager`。所有规则和状态都在 `src/core` 与 `src/games` 里。所以引擎也能脱离 MCP 当作库使用（见 `src/index.ts`），测试大多直接调用 `GameManager`。

## 四个不变量

1. **程序决定一切**：身份、座位、顺序、结算、胜负，都由游戏实例里的确定性逻辑加随机数（生产环境用 `crypto.randomInt`）决定。裁判没有任何能影响结果的接口。
2. **裁判只是消息总线**：游戏要发往 QQ 的每一条消息都写进 `rec.outbox`，裁判通过 `referee_step` 按顺序取走并发出。真人的话由裁判原文转交，程序自己解析。
3. **阶段门控**：一个阶段要等裁判取走它开启之前产生的全部消息，才真正开放（开始计时、接受动作）。所以真人一定是先在 QQ 里看到提示，然后才开始计时。
4. **状态可序列化**：游戏实例不在自身上保存状态，所有状态都在 `GameRecord`（`rec.state`、`rec.phase.data`）里。可以随时落盘，重启后惰性重建实例继续玩。

## 数据模型

`GameRecord`（`src/core/types.ts`）是一局游戏的全部状态：

| 字段 | 说明 |
|---|---|
| `status` | `lobby` → `running` → `ended`（正常结束）或 `aborted`（中止） |
| `lobby` | 报名名单。AI 的报名方式是 `player`、`referee` 或 `either`；真人一律是 `player` |
| `players` | 开局后的座位表：座位号、QQ 号、昵称、`agent`/`human`、存活、是否自己发言（`selfPost`） |
| `referee` / `standbyReferees` | 当前裁判（含投递游标 `cursor`、最后活跃时间、代行进程 `hostedBy`）和候补裁判 |
| `phase` | 当前阶段：`pending`（每个座位的待办、可选动作、真人回应渠道）、`timeoutMs`、`secret`、`minDurationMs`、`gateSeq`、`openedAt`、`deadline`、`data` |
| `log` | 事件日志。可见范围（audience）分三种：`public`、`seats`（指定座位）、`referee` |
| `outbox` | 待发往 QQ 的消息：`seq`、`notBefore`、目标（群/私聊）、消息段（文本/@）、类别 |
| `state` | 游戏自己的状态，例如狼人杀的身份、药水和议程 |
| `result` | 胜负、获胜座位、原因、全员身份揭晓 |

## 推进循环（pump）

每次有人调用 `act`、`relay_human_message` 或 `referee_step`，以及后台每秒一次的 `tick`，`GameManager.pump()` 都会循环执行：

1. 阶段刚开启时 `gateSeq = -1`，把它定为当前的 `outboxSeq`，表示在这之前的消息都必须先发出去。
2. 阶段还没开放时，如果裁判游标已经不小于 `gateSeq`（`auto_referee` 局直接放行），就开放阶段：`openedAt = now`，`deadline = now + timeoutMs`。
3. 所有待办都完成后，如果已经过了 `minDurationMs`，就调用 `inst.advance()`，由游戏结算并开启下一阶段，或者结束游戏。
4. 过了截止时间（只在裁判推进或 `tick` 时处理），就调用 `inst.onTimeout()`，按游戏的 `timeoutDefault` 给未行动的座位托管。

循环最多执行 `MAX_PUMP` 次。如果 `advance()` 返回后阶段没有变化，又仍然是「已完成」状态，就直接抛错，防止死循环。

## 消息投递

- 消息有序号 `seq` 和最早发送时间 `notBefore`。`notBefore` 单调不减，靠 `notBeforeFloor` 保证。AI 玩家自己发言（`self_post`）后，程序会把后续消息推迟 `speech_gap_ms`，免得裁判的下一条提示抢在它的发言前面。
- `referee_step` 返回游标之后、已经到期的消息，遇到第一条还没到期的就停下，然后推进游标。`since_seq` 只能用来重发游标之前的消息。
- 同一条消息可以渲染成三种格式：`text`（纯文本加 mentions 列表）、`cq`（CQ 码，已转义）、`onebot`（OneBot v11 消息段）。@ 在内部用占位符 `{@座位}` 表示。玩家提供的文字和昵称在写入前都会经过 `sanitizeUserText`/`sanitizeName`，使占位符和 CQ 码失效。

## 谁能看到什么

| 视角 | 能看到 |
|---|---|
| AI 玩家（`get_my_view`） | 公开日志，加上发给自己座位的日志；`you` 里有自己的私密信息 |
| 真人玩家 | 只通过裁判的私聊拿到私密信息。**任何 MCP 会话都读不到真人座位的私密视角**，即使用真人的 QQ 号连接也不行 |
| 裁判 | 公开日志、裁判专用日志、流程信息。秘密阶段里只列出需要私聊回应的真人。裁判看不到 AI 玩家的身份 |
| 旁观者、观战 API | 只有公开日志 |
| 游戏正常结束后 | 所有人都能看完整复盘；中止的对局不公开私密记录 |

防止「侧信道」泄露的措施：

- 秘密阶段不公布还有谁没行动。
- `minDurationMs` 让夜晚至少持续一段时间（狼人杀默认 20 秒），避免从「结束得多快」推断神职死活。
- 狼人杀的女巫阶段只要板子里有女巫就每晚都开，避免阶段的出现与否暴露女巫存活。
- 超时托管只使用该座位自己能看到的信息。
- 视图里的事件 `seq` 按该视角可见的事件重新编号。全局序号的空档会暴露别人的私密事件数量，例如预言家是否还在查验。

## 裁判选举与接管

开局时（`startGame`）：

0. 如果有账号登记了代行（`referee_offer`，`LobbyEntry.hostedBy`），程序在这些账号里均匀抽一位当裁判；报名为玩家的账号被抽中就不入座（只有抽走一人后人数仍够时，玩家账号才进池子）。抽签记录写进 `refereeDraw`，裁判的 `hostedBy` 记下代行进程的 `host_id`，之后 `referee_step` / `relay_human_message` 只接受带同一 `host_id` 的调用，其它会话得到空结果。
1. 否则，如果有 AI 报名为 `referee`，程序从中随机抽一位当裁判，其余的成为候补裁判。
2. 否则，从报名为 `either` 的 AI 里随机抽一位，其余的 `either` 当玩家。
3. 都没有就拒绝开局，除非开了 `auto_referee`。

裁判超过 `refereeStaleSeconds` 没有调用 `referee_step`，候补裁判可以 `referee_takeover`。开局后用 `join_game(join_as="referee")` 登记的非玩家 AI 也算候补。管理员不受这些限制。接管后从上一任的游标继续发消息。被接管的裁判记入 `formerReferees`：真人习惯 @ 原裁判发指令，转交时这些 @ 也会被剥离。

## 长轮询

`waitUntil()` 结合两样东西实现长轮询：

- 每局一个 `EventEmitter` 事件（`bump:<gameId>`），状态一变就唤醒等待者；
- 一个按真实时间计算的上限。

裁判等待时还会在下一个截止时间或 `notBefore` 到来时醒来，处理超时。时钟可以注入，测试里用 `FakeClock`。

长轮询被取消时（客户端超时或断开、服务关闭，SDK 都会触发 abort 信号），`referee_step` 不推进裁判游标，`get_my_view` 不推进事件游标，而是直接报错。否则响应没人收到，这批消息就丢了。

## 认证

- **keys**：每个 bot 一把密钥，身份由密钥决定。HTTP 会话和建立会话时的密钥绑定，中途换密钥会被拒绝。
- **open**：`login` 认领 QQ 号。首次认领返回一个 secret，存档里只保存它的 sha256。正在以真人身份参赛的 QQ 号不能被认领。
- **admin**：管理员密钥可以中止任意对局、强制接管裁判。

## 持久化

`FileStateStore` 有防抖（250ms），先写临时文件，再 `rename` 原子替换，内容包括所有对局和 open 模式的认领记录。重启时 `GameManager` 读回存档，游戏实例在第一次访问时重建。已结束的对局默认保留最近 100 局。

## 代码裁判（`packages/referee-onebot`）

`bot-game-referee` 是裁判角色的参考实现：一个 OneBot v11 正向 WebSocket 客户端加一个 MCP 客户端。主循环 `referee_step(wait_seconds=25, format="onebot")` → 按顺序 `send_group_msg` / `send_private_msg`；收到的群消息、私聊按先后顺序 `relay_human_message`；「/桌游」指令对应 `create_game` / `start_game` / `abort_game`。传输失败后的第一次调用会比较 `seq`，发现引擎游标越过了没送到的消息就用 `since_seq` 补发。它只用裁判能用的那几个工具，没有任何能影响结果的接口。

`nudge_ai` 选项在 `BaseGame.openPhase` 里实现：阶段建立时往 outbox 推一条 @ AI 玩家的提示（不写日志），所以它和公告一样受阶段门控约束，总是在阶段开放计时之前发出。公开阶段限时过半仍有人没行动时，`BaseGame.remindPending` 再推一条 @ 未行动者（真人和 AI 都 @）的提醒，每阶段最多一次，限时不足 60 秒不提醒；秘密阶段不提醒，因为谁还没行动本身是秘密。提醒时刻计入裁判长轮询的唤醒时间（`refereeNextWake`），所以代码裁判会准时发出。

## 新增一款游戏

以 `src/games/number-bomb/index.ts` 为参考（约 240 行），步骤如下。

1. **定义选项**：用 zod 定义选项 schema，展开 `...commonOptionShape` 合并通用选项（`random_seats`、`speech_gap_ms`），时长类选项可以用 `secondsOption()`。
2. **继承 `BaseGame<State, Options>`**，实现下面几个方法：
   - `start()`：分配身份（用 `this.rng`）。真人的身份用 `this.tell(seat, …)` 发，会自动变成裁判私聊；AI 玩家的身份放进 `privateView`。最后用 `this.openPhase(...)` 开启第一个阶段。
   - `onAction(seat, input, meta)`：先 `this.requireTurn(seat, action)` 校验，再修改 `this.state`，然后 `this.markDone(seat)`，返回给调用者的一句话。非法动作抛 `GameError`。
   - `advance()`：当前阶段全部完成时调用。负责结算，然后开启下一阶段，或者 `this.finish(result)`。
   - `privateView(seat)` / `publicView()`：**不能泄露别人的私密信息**，`publicView` 里不能有任何秘密。
3. **按需覆盖可选方法**：
   - `timeoutDefault(seat, req)`：超时托管时执行什么动作。
   - `parseCommand(seat, text, channel)`：把真人的 QQ 文字解析成 `ActionInput`，不是指令就返回 `null`。
   - `randomAction(seat)`：给模拟器和测试生成随机的合法动作。
4. **写好每个阶段的提示**：`openPhase` 的每个待办都要写清 `prompt` 和 `actions`。每个动作带上 `example`（给 AI 看的调用示例）和 `command`（给真人看的指令示例）。`channel: 'private'` 的待办会自动私聊提示真人。
5. **用基类提供的工具**：
   - 消息：`announce`（群公告）、`tell`/`tellMany`（私密消息）、`recordSpeech`（发言）。
   - 文本：`at(seat)`（@ 占位）、`label(seat)`（「3号 小明」）。
   - 座位：`orderFrom`/`nextAlive`（发言顺序）。
   - 动作规格：`specTarget`/`specSkip`/`specSpeech`。
6. **注册**：在 `src/games/index.ts` 里注册 `GameDefinition`，包括类型名、中文名、别名、ID 前缀、人数范围、简介、规则文本、`optionsHelp`、`create`。
7. **补测试**：在 `test/games/` 里覆盖正常流程、非法动作、超时托管、真人文字解析、视角不泄露，以及用 `playToEnd` 随机打到结束。最后运行 `npm run docs` 重新生成规则文档。

几条容易踩的坑：

- 不要在实例字段上保存状态，实例随时可能被重建。
- 所有随机都要走 `this.rng`，不要用 `Math.random()`，这样测试才能用种子复现。
- 需要保密的阶段设置 `secret: true`，必要时再加 `minDurationMs`。
- 不要把 `rec.state` 整个放进任何视图里返回。
