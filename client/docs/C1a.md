# C1a：面板底座与附近聊天

本段做了两件事：把「功能模块」的骨架搭好（之后 C1b 到 C7 只加自己的文件），以及第一个功能：附近聊天。骨架本身不带任何行为，由旧的 15 步端到端全绿来证明。

## 1. 结构

GDScript 一侧（`client/town/scripts/features/`）：

| 文件 | 作用 |
|---|---|
| `feature.gd`（`TFeature`） | 功能基类，所有钩子都有空实现；助手 `feed`、`feed_state`（相同内容不重复推）、`forget_state` |
| `ctx.gd`（`TCtx`） | 给功能的门面：自己的编号、场景与演员、`act` / `act_once`、`api_get` / `api_post`、`toast`、连接状态、`server_now` 等。功能不要直接伸手进 `main.gd`。文件里给 C1b 到 C7 各留了一块空分区，只在自己那块加访问器 |
| `hub.gd`（`TFeatureHub`） | 把 `main.gd` 的钩子分发给各功能 |
| `manifest.gd`（`TManifest.LIST`） | 功能清单（预载路径）。九个名字已占好：activity bubbles game mail nearby npc people session town |
| `chat_util.gd` | 聊天消息的统一格式（事件和历史两种来源） |
| `nearby.gd` | 附近聊天，本段唯一的真实现 |

钩子：`event_types` `frame_types` `wants_tick` `setup` `on_enter` `on_leave` `on_me` `on_scene` `on_hello(msg, resumed, first)` `on_ws_closed` `on_resync` `on_event` `on_frame` `on_ui(name, arg)` `tick` `actions` `on_action(verb, arg)` `on_pick` `blocks_input` `tags` `debug`。`main.gd` 里的改动只有这些钩子的调用点和新的 `_act_once`（一次性动作：不动 `pending`、不睡眠重试、可复用请求号）。

桥（`bridge.gd` + `hud.js`）：`HUD_PROTOCOL = 2`。页面文件与客户端版本不一致时 `main.gd` 直接提示「请强制刷新」。`hud.js` 只有三处改动（核心状态转交 `TownDock.onCore`、Esc 先关面板（`TownDock.escape()`），并照常发 `esc` 让走路中的角色同时停下、占位的 `feed` / `protocol` 与调试里的 dock 状态）。

网页一侧（`client/town/web/`）：`dock.js` / `dock.css`（底座）、`mod/00-chatkit.{js,css}`（聊天类面板共用的消息列表 + 输入栏，C1b 复用，不改内部）、`mod/nearby.{js,css,html}`。`client/tools/assemble.mjs` 把 `mod/*` 合成 `town-modules.js` / `.css` 并把模板注入 `index.html` 的 `<!--TOWN:TEMPLATES-->`。

## 2. 附近聊天的行为

- 听见的话来自 WebSocket 的 `chat` 事件（只收 `scope == "nearby"`），页面新开 / 重连后用 `GET /history`（新的在前，客户端反转）补读。事件和历史按 `messageId` 去重；历史补读永远不计未读。
- 续传成功的重连（`resumed and not first`）不立刻补读历史，而是延后约 3 秒：先补读会让随后补发的事件被当成「已有」，未读就少算。
- 发话走 `act_once({type:"say_nearby"})`；成功后用回执的 `messageId` 立刻把自己这句放进列表，事件回声到达时按 id 去重。失败时输入保留；限流（429）显示倒计时并禁用发送；超长在本地先拒，不发请求；网络失败保留请求号，重发同一句不会说两遍。
- 「看起来附近没人」只按距离算，是软提示，永远不拦发送；服务端的 `heardBy` 才是准的。
- 键盘：输入框里 WASD 不进游戏；Esc 先失焦，再按一次才关面板；Enter（不在输入框、没有修饰键、焦点不在按钮 / 链接上）全局打开面板并聚焦输入框；输入法组字中的 Enter 不发送；ArrowUp 找回最近 5 句；桌面发送成功后自动失焦。
- 表单 `submit` 一律 `preventDefault`（引擎 CSP 有 `form-action 'none'`）。「说」按钮的 `mousedown` 也 `preventDefault`，点它不抢输入框的焦点（手机上才不会收起软键盘）。
- 面板开着、焦点不在输入框时，一下 Esc 既关面板又停步（键位提示「Esc 停下」成立）；焦点在输入框里的第一下 Esc 只失焦。
- 横屏小高度（侧栏布局）遇到软键盘：侧栏抬到键盘上沿，顶部让到 8px。

## 3. 观感

纸与木牌：奶油纸面、木色边框与页签、灰蓝（别人的话）、柔绿（自己的话）、少量暖橙（未读角标、发送钮、倒计时）。桌面是右侧栏（宽 `clamp(300px, 24vw, 340px)`），手机是底部抽屉（高 `min(44% 视觉视口, 340px)`，「停下 / 回家 / 地点 / 聊天」整体顶到抽屉上沿之上）。默认关闭；`#keyHint` 里有「Enter 聊天」，启动按钮有未读角标。截图见 `client/demo/`：`20-desktop-chat-side`、`20-desktop-chat-side-evening`、`20-mobile-chat-drawer`、`20-mobile-chat-drawer-evening`。

## 4. 对规格的取舍与修正

- 规格里的 `docs/progress/C1a.md` 与对 `docs/PROGRESS.md` 的改动不做（任务另行规定）：待办与缺口都写在本文件。
- 步骤号都是数字：规格里的 20.4b、20.4c 在 `20-chat-nearby.mjs` 里是 20.45、20.46；规格里的 20.7 之后依次是 20.7（只读与对局中）、20.8（XSS）、20.85（手机与布局）、20.9（截图）、20.95（离开与换人）。
- 规格 20.3 里「强发超长，服务器返回 400」：强发会先经过 Godot 一侧的本地字数检查，所以不会到服务器。服务器的 400 `bad_request` + `text_too_long` + `maxChars: 120` 改用 API 直接验证。
- 「自己说的话何时出现」：回执一到就放进列表，早于事件回声。所以负向断言的屏障不能是「自己的话出现在列表里」，而是 Godot 一侧的 `events` 计数（自己那句的回声事件到了，同一居民的事件流有序，之前发的话若会到一定先到）。
- 限流的 `retryAfterMs` 取整用向上取整（向下取整会在倒计时刚结束时再被拒一次）。

## 5. 真机待办（无头浏览器验证不了，不能凭 e2e 声称通过）

1. iOS Safari、Android Chrome：软键盘弹出时抽屉是否贴在键盘上沿、`--kb` 公式（`innerHeight - visualViewport.height - offsetTop`）在两个平台上是否一致；地址栏伸缩是否抖动（小于 80px 视为抖动被忽略）。
2. 输入法：中文拼音 / 手写组字中的 Enter、选词；Safari 的 compositionend 后紧跟的 Enter（代码里忽略 30 毫秒内的 Enter，来自资料而非实测）。
3. 老 Android 浏览器、三星浏览器、微信 X5 内核：软键盘会缩布局视口，Godot 画布随之缩放，镜头画幅可能跳。交 C7 评估。
4. 手机上输入框 16px 防聚焦放大、`enterkeyhint="send"` 的键盘按钮、列表长按复制文字。
5. 触摸：真实手指在面板里的拖动与双指是否会穿透到画布（无头里用 CDP 触摸验证过，真机再看一次）。
6. Android Chrome：点「说」之后输入框是否仍聚焦、软键盘不收、抽屉不弹回（靠 `mousedown` 的 `preventDefault`，无头里用 `page.tap` 验证了焦点，软键盘本身没验证）。
7. 横屏手机弹软键盘：侧栏是否确实停在键盘之上（无头里用 `TownDock.test.setKeyboard` 模拟；真机浏览器是否平移视口没验证）。
8. 列表整体重建（断线补缺）时滚动位置按距底距离还原：Chromium 里不加还原也不会跳到最顶（同步重建，布局没被强制），所以这一条没有红灯，是对 Safari / Firefox 的防御；真机待看。
6. 四个按钮在 360 宽屏上的实际观感（无头里只验证了不溢出）。

## 6. 已知缺口

- 「对局中不能说话」的真实场景没有端到端覆盖：现在只能用界面状态（`TownDock.feed('nearby','state',…)`）驱动核对禁用与占位。真实对局由 C3 的步骤补一条。
- 公共小镇里的 NPC（C6）若在附近，会让「附近没人」便签不出现（NPC 不是 `busy` 的演员）；便签只是软提示，不影响发送。
- 声学房间（隔墙）只由服务端判断，页面的「附近没人」不知道墙，隔墙时会判「有人」。
- 浏览器对 `document.title` 的未读前缀只在页面不可见时加，未在端到端里覆盖。

## 7. 之后各段怎么接

通用规则：只加自己的新文件；`feature.gd`、`ctx.gd` 的公共部分、`hub.gd`、`manifest.gd`、`dock.js`、`dock.css`、`mod/00-chatkit.*` 由 C1a 拥有并冻结；`main.gd`、`hud.js`、`shell.html`、`export.sh`、`client-e2e.mjs` 不再为新功能改动（S0 补丁之外，见下面「S0 之后」）。缺钩子时先单独提只加钩子的小补丁并合并（C7 开工前审一遍钩子）。

新功能的步骤：
1. GDScript：填 `scripts/features/<id>.gd`（桩文件已在 `manifest.gd` 里占好，**不用加注册行**）。要从 main 读新东西，只在 `ctx.gd` 自己那段预留分区里加访问器；转发协程的包装函数必须 `return await …`。
2. 网页：`web/mod/<id>.{js,css,html}`。`html` 里一个 `<template id="tpl-dock-<id>" data-mod="<id>" data-tab-label="…" data-order="…" data-layout="tab|full|overlay">`；`js` 里 `TownDock.register({id, api: 1, mount(host){…}})`。文字全放模板的 `[data-bank]` 里，`mod/*.js` 不写汉字字面量，不用 `innerHTML` 等（`npm run client:lint` 和导出都会检查）。
3. 端到端：`scripts/e2e/steps/<号段>-<名字>.mjs`，写法见该目录 README；不碰 `client-e2e.mjs`。
4. 文档：`client/docs/<段>.md`。

| 段 | 填哪些 | 用到的钩子 / 注意 |
|---|---|---|
| C1b 公屏 + 头顶气泡 | `town.gd`、`bubbles.gd`；`mod/town.*`（复用 `TownChatKit`，要改行为先加 options，不改内部）、`bubbles.css` | `frame_types = ["town_chat"]`（hello 里有 `townChat.cursor`，历史走 `GET /town-chat`，**旧的在前**，和 `GET /history` 相反）；气泡用 `tags` 钩子追加 `k:'b'` 条目（hud.js 的 `setTags` 只渲染一段纯文字，类名 `tag b`，`.tag` 默认 nowrap / 深色药丸，需在 `bubbles.css` 覆盖）；订阅 `ctx.feature("nearby").heard`（只在 live 消息时发，历史补读不发） |
| C2 共同活动 | `activity.gd`、`mod/activity.*` | `actions(out)` 追加按钮，id 必须以 `f:activity:` 开头，`on_action(verb, arg)` 收到去掉前缀的部分；按钮的 `mode` 只能用已有样式 do / go / busy，或在自己的 css 里加类 |
| C3 入座玩小游戏 | `game.gd`、`mod/game.*`（`data-layout="overlay"`，挂到 `#dockOverlays`） | `blocks_input()` 返回非空原因就屏蔽点地和方向键（方向键提示 3 秒节流）；`on_pick(kind, id)` 返回 true 接管点选（点击和 E 键都先问它，S0 之后）；**补 nearby 的真实「对局中不能说话」断言**（见已知缺口） |
| C4 点人 / 居民卡 / 邀请 / 入户 | `people.gd`、`mod/people.*` | `on_pick`（点击和 E 键都会先问；E 键选的是最近的人或物件，8 米内）、`tags`（门牌，同样受 `setTags` 字段限制） |
| C5 信箱 | `mail.gd`、`mod/mail.*`（`data-layout="full"`，入口在 dock 内，不占 controls；`limits.letterMaxChars`） | 未读用 `host.setUnread`，汇入 `#dockBtn` 角标 |
| C6 NPC | `npc.gd`、`mod/npc.*`；改 `actor.gd`（只有 C6 改） | NPC 的 `from.kind` 若不是 human / agent，`TChatUtil.kind_of` 当 human，要特别处理就通过 chatkit 的 options；注意 NPC 会让 nearby 的「附近没人」便签不出现（见已知缺口） |
| C7 收尾 | `session.gd`、`mod/session.*`（`data-slot="controls"` 只能占 1 个：390 宽的 `#controls` 只容得下约 5 个按钮，现有 4 个） | 「离开小镇」要调 main 私有的 `_enter_left_state`，经 `ctx.gd` 的 C7 分区加访问器；评估镜头留白（rig inset）、老 Android 画布缩放、首次进入提示（默认关闭的面板新玩家可能发现不了，现在靠角标和 `#keyHint` 的 Enter 提示）；汇总各段文档 |

`mod/*` 的合并顺序是文件名排序（`00-chatkit` 先）；模板里不要嵌套 `<template>`（嵌套克隆行为没有在本仓库验证过，消息行骨架是独立的顶层模板）。聊天内容、草稿、ArrowUp 历史只放内存，不写 localStorage / sessionStorage / IndexedDB（只允许界面偏好：面板开关、最后页签）。

### S0 之后（骨架小补丁）

- **E 键和 `on_pick`**：`_do_interact(src)` 选出最近的目标（8 米内的物件或居民）之后、走旧逻辑之前，先调 `features.on_pick(kind, id, src)`；返回 true 就结束（不发 navigate、不记 selected、不弹提示）。等待（`me_busy`、`/me` 刷新）仍在选目标之前，`_can_control()` 仍在最前。所以 C4「点人出居民卡」、C3「点桌子入座」、C2「点茶桌一起喝茶」用键盘也进得去；没有功能接管时行为和以前一样。`on_pick` 的第三个参数（来源：`tap` / `key` / `button`）只给 hub 记录用，功能的 `on_pick(kind, id)` 签名不变。
- **给 C7 的「互动」按钮留的入口**：网页层 `emit('interact', 'button')`（键盘 E 是 `emit('interact')`，来源记为 `key`）就进同一个 `_do_interact`；C7 只要加按钮、发这个事件，不用改 main.gd。这一段没有加按钮。
- **调试记录和测试口（只在 `?debug=1`）**：`__town.features._pick` 是最近一次 `on_pick` 的记录 `{kind, id, src, taken, n}`；`__town.pickStub(id)` 装一个「对这个编号返回 true」的假接管（空串撤掉；`main.gd` 只在 `bridge.debug` 下认 `debug_pick_stub`）；`TownDock.test.unregister(id)` 卸掉一个模块（端到端用它卸假页签）、`TownDock.test.select(id)` 选中页签。正式页面上这些都不存在（25.1 在不带 debug 的页面上核对）。
- **页签条的容量**：`.dock-tab` 左右内边距 14 改 9 像素、页签间距 4 改 2 像素；`#dockTabs` 横向可滚动（隐藏滚动条）、右边留 44 像素给关闭钮，选中的页签自动滚进可见范围（`revealTab`）；关闭钮画木色底，滚动时不透出下面的字。抽屉里的条高 40 改 44 像素，保证触摸点按区不小于 44 像素。样式前缀 `#dock`：以前 `.dock-tab` 的背景、字体、颜色、内边距被 `#dock button` 的重置盖掉了（特异性更低），页签的「木牌」样式一直没生效，现在生效了；只有一个页签时用 `#dock #dockTabs[data-count="1"] .dock-tab` 还原成之前的样子（不可点的标题）。
- **端到端的小镇参数**：`scripts/client-e2e.mjs` 起引擎时传 `town.params`（`interactionTimeScale` 0.075、`letterDeliveryDelayMs` 4000、`activityLobbyTtlMs` 25000，理由在那个常量上面的注释），步骤文件用 `h.townParams` 读，按参数算等待。服务端的 `interactionTimeScale` 是只给测试用的开服参数（只能缩短，没有运行时入口），见 `docs/TOWN.md`。
- **`scripts/e2e/steps/25-skeleton.mjs`** 验证：四种视口（1440x900 和 1100x800 的侧栏、390x844 和 360x740 的抽屉）下五个、六个页签都点得到、关闭钮不盖页签、最后一个可滚到可见并点中、选中的自动滚进可见、抽屉里点按区不小于 44 像素、只剩一个页签时仍是标题；测试口只在 debug 下；E 键对物件和居民的记录与旧行为，假接管下旧行为不发生。假页签和假接管测完卸掉。

## 8. 验证记录

- `npm run typecheck`、`npm test`（74 个文件 1516 个测试）、`npm run docs`（之后 git 无多余差异）、`npm run client:lint`、`npm run client:export` 都通过；`npm run client:e2e` 完整一遍全过（本段分支上是 31 项；并入开发分支后是 33 项：旧步骤 16 项（含 4.5）、新步骤 20 到 20.95 共 16 项、全程检查 1 项，约 17 分钟；全程检查零控制台错误、零 CSP 违规，声明过的 4xx 与控制台行数相等），结果在 `client/demo/results.json`。
- 骨架零行为：由旧 15 步和全程检查在带骨架的构建上全绿证明（上面最后一遍）；前一位同事在只有骨架、没有功能时跑的那遍里，只有步骤 15 以下面说的薄断言失败，其余旧步骤全绿；钩子错误隔离用一个故意出错的临时功能验证过：它的钩子报错后，后面功能的钩子仍被调用、`main.gd` 仍在跑。
- 反向验证：每条新断言都临时改坏实现、确认对应步骤变红再还原，清单和结果写在 `scripts/e2e/steps/20-chat-nearby.mjs` 末尾。有两条没做出红灯，如实记录在那里（`on_hello` 的延迟补读：本机时序造不出「历史抢先」；`scope` 过滤：服务端造不出别的 scope）。
- 旧步骤 15 的「走远后听不到喷泉」是个很薄的断言（要求离喷泉 > 22 米，历次记录里走到 22.1 到 23.1 米）：同一份代码上第一遍完整端到端它以 22.0 米失败（那一遍里 C 页面还有一次约 15 秒的主线程停顿），在开发分支提交 3a9d2ce 的干净导出上和本分支的再跑一遍都通过。本段没有改它。**并入开发分支之后这一步已经按根因重写**（开发分支一侧的修复）：不再固定点四下，而是用 `walkTo` 按路点走到 (59, 25)、按服务器位置确认到了离喷泉约 27 米处，门槛是 25 米；上面「22 米」的说法只适用于并入之前。
- 服务端：本段没有改 `packages/`，没有发现挡路的服务端问题。
