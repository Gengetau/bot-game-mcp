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

桥（`bridge.gd` + `hud.js`）：`HUD_PROTOCOL = 2`。页面文件与客户端版本不一致时 `main.gd` 直接提示「请强制刷新」。`hud.js` 只有三处改动（核心状态转交 `TownDock.onCore`、Esc 先问 `TownDock.escape()`、占位的 `feed` / `protocol` 与调试里的 dock 状态）。

网页一侧（`client/town/web/`）：`dock.js` / `dock.css`（底座）、`mod/00-chatkit.{js,css}`（聊天类面板共用的消息列表 + 输入栏，C1b 复用，不改内部）、`mod/nearby.{js,css,html}`。`client/tools/assemble.mjs` 把 `mod/*` 合成 `town-modules.js` / `.css` 并把模板注入 `index.html` 的 `<!--TOWN:TEMPLATES-->`。

## 2. 附近聊天的行为

- 听见的话来自 WebSocket 的 `chat` 事件（只收 `scope == "nearby"`），页面新开 / 重连后用 `GET /history`（新的在前，客户端反转）补读。事件和历史按 `messageId` 去重；历史补读永远不计未读。
- 续传成功的重连（`resumed and not first`）不立刻补读历史，而是延后约 3 秒：先补读会让随后补发的事件被当成「已有」，未读就少算。
- 发话走 `act_once({type:"say_nearby"})`；成功后用回执的 `messageId` 立刻把自己这句放进列表，事件回声到达时按 id 去重。失败时输入保留；限流（429）显示倒计时并禁用发送；超长在本地先拒，不发请求；网络失败保留请求号，重发同一句不会说两遍。
- 「看起来附近没人」只按距离算，是软提示，永远不拦发送；服务端的 `heardBy` 才是准的。
- 键盘：输入框里 WASD 不进游戏；Esc 先失焦，再按一次才关面板；Enter（不在输入框、没有修饰键、焦点不在按钮 / 链接上）全局打开面板并聚焦输入框；输入法组字中的 Enter 不发送；ArrowUp 找回最近 5 句；桌面发送成功后自动失焦。
- 表单 `submit` 一律 `preventDefault`（引擎 CSP 有 `form-action 'none'`）。

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
6. 四个按钮在 360 宽屏上的实际观感（无头里只验证了不溢出）。

## 6. 已知缺口

- 「对局中不能说话」的真实场景没有端到端覆盖：现在只能用界面状态（`TownDock.feed('nearby','state',…)`）驱动核对禁用与占位。真实对局由 C3 的步骤补一条。
- 公共小镇里的 NPC（C6）若在附近，会让「附近没人」便签不出现（NPC 不是 `busy` 的演员）；便签只是软提示，不影响发送。
- 声学房间（隔墙）只由服务端判断，页面的「附近没人」不知道墙，隔墙时会判「有人」。
- 浏览器对 `document.title` 的未读前缀只在页面不可见时加，未在端到端里覆盖。

## 7. 验证记录

见交付说明与 `client/demo/results.json`。反向验证（临时破坏实现、确认变红、再还原）的清单在 `scripts/e2e/steps/20-chat-nearby.mjs` 末尾。
