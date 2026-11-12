# 栖灯镇三维网页客户端（P0 灰盒）

Godot 4.7.2（GDScript，Compatibility 渲染，单线程网页导出）。Godot 只画三维世界，所有文字界面是叠在画布上的普通 DOM。
服务端协议见 `docs/TOWN.md`（「空间与导航」「HTTP 接口」「空间同步（WebSocket）」），客户端不改服务端规则。

## 需要的工具

- Godot 4.7.2 稳定版，装好网页导出模板（本机 `/opt/godot/godot`；别处用环境变量 `GODOT=/path/to/godot`）。
- Node 22（跑引擎和导出脚本里的预压缩）。
- 不需要 Blender：角色和音频素材已经在 `client/town/assets/`（再生成见 `client/ASSETS.md`）。
- 在别的机器上导出（比如 aarch64 的服务器，实测可用）：官方有 `linux.arm64` 的编辑器包；网页导出只用到模板包里的 `web_nothreads_release.zip` 和 `version.txt`，放进 `<数据目录>/godot/export_templates/4.7.2.stable/` 就行，不用把 1.3 GB 的模板包全解开。`HOME` 不是真正的主目录时（比如经远程执行工具跑命令），用 `XDG_DATA_HOME` 指定数据目录，否则 Godot 找不到模板。

## 导出

```bash
npm run client:export          # = bash client/tools/export.sh
SKIP_COMPRESS=1 npm run client:export   # 开发时跳过 .br/.gz（完整导出（含 brotli 11）约 1.8 分钟（实测 108 秒））
```

脚本：导入资源 -> `--export-release "Web"` -> 把 `client/town/web/` 下除 `shell.html` 外的文件拷进去 -> 对 `.wasm/.pck/.js/.css`
生成 `.br`/`.gz` -> 打印大小 -> 换到位。产物在 `client/town/build/web/`（不进版本库）。
先导到 `client/town/build/.web-new/`，全部成功后才换掉 `build/web/`：导出中途失败时，正在运行的站点还用着旧产物。
**`SKIP_COMPRESS=1` 的产物没有 `.br`，过不了端到端步骤 1（它断言 `index.pck` 发 `br`）**；跑 `client:e2e` 前要先做一次完整导出。

## 本机启动

```bash
# 在仓库根目录。BOTGAME_TOWN_CLIENT_DIR 必须是绝对路径：npm 的 -w 会先切到 packages/engine 再跑，
# 写成相对路径会指到 packages/engine/client/...，页面就是「三维客户端还没有部署」的 404。
BOTGAME_TOWN=1 BOTGAME_TOWN_DEV_LOGIN=1 BOTGAME_TOWN_DB=/tmp/town.db \
BOTGAME_TOWN_CLIENT_DIR="$PWD/client/town/build/web" \
npm run dev -w bot-game-mcp -- serve
# 打开 http://127.0.0.1:7700/town/3d/      调试钩子：加 ?debug=1
```

没有导出目录、或路径不对时，`/town/3d/` 返回 404 和一句中文说明（「三维客户端还没有部署」），先查路径。

客户端必须挂在 `/town/` 下（会话 Cookie 的 Path 是 `/town`），引擎按 `/town/3d/` 托管，CSP 见 `docs/TOWN.md`。
不开开发登录时，从旧页面 `/town/` 用登录票据进入，Cookie 共享。

## 端到端演示与验收

```bash
npm run client:export   # 先导出
npm run client:e2e      # 约 4.3 分钟，不进 CI；需要完整导出（含 .br）。修完后连续两遍 271、265 秒，导出脚本修掉资源包问题后又跑了一遍 257 秒，记录取最后这一遍
```

脚本 `scripts/client-e2e.mjs` 自己起引擎（子进程、开发登录、keys 认证里放一个测试 AI 密钥、临时库、随机端口），
开桌面 1440x900 和手机 390x844（触摸）两个 Chromium 上下文加一个由 agent-kit 的 `ResidentRunner` 驱动的 AI 居民（决策函数写死、不调用模型），走完 14 步并检查控制台、CSP、失败请求和所有未声明的 4xx/5xx，
全部通过才把截图和结果换进 `client/demo/`（失败的运行写 `results.failed.json`，已 gitignore，不动已提交的验收记录），验收记录见 `client/demo/README.md`。需要 Playwright 和 Chromium
（`require('playwright')` 能解析即可）。导出目录不存在时脚本提示先导出并以退出码 2 退出。

## 目录

```
client/town/
  project.godot, export_presets.cfg, main.tscn, icon.svg
  scripts/   clock.gd（服务器时间估计） bridge.gd（fetch、界面桥） net.gd（WebSocket）
             actor.gd（居民：折线插值、动画） world.gd（从 /map 生成灰盒） rig.gd（镜头）
             audio.gd（音效） main.gd（启动流程、协议、输入、续租、重连）
  web/       shell.html（导出外壳，无内联脚本） boot.js（启动引擎、fetch 通道、AudioContext 拦截）
             hud.js / hud.css（DOM 界面：面板、姓名牌、按钮、提示条、声音开关）
  assets/    素材（素材同事的范围，只读）；*.import 入库，.godot/ 不入库
client/tools/export.sh
client/art_source/, client/ASSETS.md   素材来源与台账
```

## 协议要点（实现位置都在 main.gd）

- 启动：点「进入小镇」（用户手势：恢复 AudioContext、播确认音）-> `GET /session`、`/config` -> 未登录且开放开发登录则显示名字框
  `POST /auth/dev`，否则提示去旧页面 -> `POST /enter` -> `GET /map`（生成灰盒）-> `POST /ws-ticket` -> 连 `/town/ws` -> hello -> scene。
- 网络：`fetch` 经 `boot.js` 的 `TownHost.fetchJson`（同源 Cookie），结果回调进 Godot；WebSocket 用 `WebSocketPeer`，每帧 poll。
  **不使用 `JavaScriptBridge.eval`**（这条路径的 CSP 没有 `unsafe-eval`）。
- 位置：只按 scene 里的折线 + `speed` + `startedAt` + `until` 和服务器时间现算（`hello.serverTime` + ping/pong 取最小往返的样本）。
  没有预测；被纠正时把「显示 - 真值」当偏差指数衰减。
- 输入：点地面 -> `navigate {to:{x,z}}`；点物件 -> `navigate {to:物件编号}`，够得着（`/me` 的 `here.objects[].near`）才出动作按钮；
  点人 -> `navigate {approach}`；停下 -> `stop_navigation`；走路中再点就是改道；点在 DOM 控件上不会走路；失败显示服务器的中文 `message`。
  等待确认时顶部有「正在确认…」，地面标记先灰后黄。触摸和鼠标分开处理（关掉了互相模拟），双指缩放、滚轮缩放。
- 续租：走路时每 `renewEveryMs` 发 WS `renew`，回答不是现在这段就照新的续；WS 断着时用 `POST /nav/renew`。
- 在场与控制权：`/enter`、按 `nextHeartbeatMs` 心跳；没有控制权时只读并给「接管」（`POST /claim`）。`clientId` 存 `sessionStorage`（每个标签页一个），用 Web Locks 判断复制出来的标签页并给它换新 id。
- 断线：WS 关闭后退避重连（1 -> 15 秒，每次重新取票据），断着时每 1.5 秒 `GET /scene`；回到前台（或主循环停过超过 3 秒）立即对时、心跳、取快照，并发一次探测，3 秒内没有任何回应就按死连接重连；前台使用时 12 秒没收到任何消息也按死连接重连；后台期间停掉的时间不算静默。
  `hello.map.checksum` 和手里清单不一致时重新取 `/map` 并重建场景。
- 私宅：scene 里 `scene` 变成 `home` 时切到 home 灰盒；出门切回。
- 一件可交互物件：藏书架的「读书」（一个人就能开始、不用先买东西）。远处点它 -> 走近 -> 出现「读书」按钮 -> `start_interaction`
  -> 服务器确认 -> 提示条和「正在：读书」。远的时候直接发会得到 `too_far`，界面提示「离……太远了」（`?debug=1` 下 `__town.act({...})` 可直接发任意动作）。
- 调试钩子：`?debug=1` 时每 100 毫秒写 `window.__town`：`{self, scene, space, serverTimeOffset, connection, actors:[{id,name,x,z,moving,sx,sy}], objects, mine, pending, ...}`，
  另有 `project(x,y,z)`（世界坐标 -> 页面像素）和 `act(action)`。`window.__town` 只在 `?debug=1` 下存在；`window.TownHost.audioState()` 一直存在，只返回各 AudioContext 的状态字符串。

## 已知限制

- 只有灰盒和一个居民模型；角色外观、动画、昼夜都是占位。墙画成半高（斜俯视免得挡住室内）。
- 无头 Chromium 用 SwiftShader 渲染，帧率约 3 到 8，没有性能参考意义。画面像素超过 250 万时会自动降 3D 分辨率。桌面 deviceScaleFactor 2（520 万像素）时只剩 1 到 2 帧，页面的时钟估计会被拖到往返 1.5 秒、位置偏差到 0.7 到 1 米，所以验收里桌面用 dsf 1（见 `client/demo/README.md`）。
- 服务器规则失败（422 等）时 Chromium 控制台会有一行「Failed to load resource」，这是 fetch 对非 2xx 的固有输出，不是脚本错误；端到端要求这类行数等于步骤里声明过的预期失败次数。
- 软件渲染（3 到 8 帧每秒）下页面的服务器时间估计比真实服务器慢约 110 到 290 毫秒（端到端步骤 2、8 的对时数据；推断原因是 pong 要等下一帧才被读到），折成位置是整体滞后 0.3 到 0.7 米；真机待测。
- 标签页在后台时浏览器暂停渲染循环，心跳和续租也暂停（在场租约 60 秒），回前台会重新进入并取快照，同时发探测、3 秒内无回应就重连（见「协议要点」的断线一条；后台停掉的时间不算静默）。
- WebSocket 正好断着的时候在别处离开小镇（比如另一个标签页点了「离开」），本页收不到撤销通知；心跳发现不在场（`presence_lost`）后约 2 秒会自动重新进入。服务端目前不告诉客户端「为什么不在场」，区分「在别处主动离开」和「服务器重启」需要服务端给出原因，记为 P1 事项。
- 声音：没有在真机上听过；被浏览器阻止时静音继续。没有在 Godot 里测过音量。
- 不做：聊天、背包、信箱、小游戏界面、NPC、摇杆；这些仍在旧页面 `/town/`。
- 引擎不支持 Range 请求、缓存策略是 `no-cache` + ETag（见 `docs/TOWN.md`）。

## 包体与耗时（本机，无头 Chromium，仅供参考）

| 文件 | 原始 | gzip | brotli |
|---|---|---|---|
| index.wasm | 39,514,754 | 10,153,810 | 6,902,599 |
| index.pck | 113,072 | 107,364 | 105,610 |
| index.js | 279,815 | 68,917 | 59,854 |

对账：同一个 Godot 版本下，`index.wasm` 和 `index.js` 在不同机器上导出是逐字节相同的（x86_64 和 aarch64 实测一致）。`index.pck` 大小相同，但每次重新导入资源哈希都会变（导入时的随机编号），不能拿它的哈希对账。

线上（经 Tailscale Funnel）：br 的 wasm 下载一次用了 22 秒，gzip 的一次用了 8 秒。入口带宽有限而且不稳定，首次打开要等十几到二十几秒，之后走缓存（ETag / 304）。

本机回环、brotli：到出现「进入小镇」按钮约 1.9 秒（桌面 1938 毫秒、手机 2028 毫秒）；点进入、输入名字到可操作（含网络往返）约 3.9 秒（桌面 3891 毫秒、手机 3971 毫秒）（两个浏览器同时软件渲染，见 `client/demo/results.json`）。真实网络下主要看 wasm 的 6.9 MB。

## 目标浏览器记录

### 已知的硬性要求（有依据的，不是推测）

| 要求 | 依据 | 说明 |
|---|---|---|
| WebGL 2 | Godot 4 的 Compatibility 渲染器基于 WebGL 2 | 缺失时 `boot.js` 用 `Engine.getMissingFeatures({ threads: false })` 检查并在面板上给出中文提示，不进入游戏 |
| WebAssembly | 引擎是 `index.wasm`（约 39.5 MB，brotli 约 6.9 MB） | 同上 |
| CSP 允许 `'wasm-unsafe-eval'` | `docs/TOWN.md` 的 CSP：`script-src 'self' 'wasm-unsafe-eval'`，没有 `'unsafe-eval'` | 浏览器必须认 `'wasm-unsafe-eval'` 才能编译 wasm；整页没有内联脚本，客户端也不用 `JavaScriptBridge.eval` |
| `connect-src` 对同源 WebSocket 的匹配 | `docs/TOWN.md`「WebSocket 与 Safari」：CSP3 规定 `'self'` 也匹配同源 `ws:`/`wss:`，旧版 Safari（约 15.4 之前）只当成 http(s)，会拦同源 WebSocket | 引擎在 `connect-src` 里额外显式写了 `ws(s)://host`，所以按文档不依赖这一点；没有在真机 Safari 上验证过 |
| 单线程导出 | 导出预设不开线程 | 不需要 `SharedArrayBuffer`，也就不需要 COOP/COEP 头 |

没有写任何「最低版本号」：文档里除了「约 15.4 之前的 Safari 的同源 ws 行为」之外没有依据，真机测过再填。

### 目标环境与记录（真机数据没有，一律「待真机」）

| 环境 | 机型 | 系统版本 | 浏览器版本 | 分辨率 | 首屏到可操作 | 帧时间 | 发现的问题 |
|---|---|---|---|---|---|---|---|
| 无头 Chromium（Playwright，SwiftShader，桌面 1440x900 与手机模拟 390x844 触摸 dsf 2） | 容器 4 核，无 GPU | Linux 6.18 | Chromium 见 `client/demo/results.json` 的 `versions` | 1440x900 dsf 1；390x844 dsf 2 | 见 `client/demo/README.md` 步骤 1（回环） | 软件渲染约 3 到 8 帧每秒，无参考意义 | `npm run client:e2e` 全部步骤通过，无 CSP 违规；细节见 `client/demo/README.md` |
| 安卓 Chrome | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |
| iOS Safari（含 `connect-src` 同源 ws、音频手势、安全区、软键盘） | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |
| Windows Chrome / Edge | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 | 待真机 |

### 真机记录模板（每台设备复制一份）

```
机型：            系统版本：            浏览器（含版本）：
屏幕分辨率与 devicePixelRatio：            网络：（Wi-Fi / 4G，大致带宽）
首屏到可操作：    打开页面 -> 出现「进入小镇」按钮 ___ 秒；点进入 -> 可以点地走路 ___ 秒
帧时间：          ?debug=1 下读 window.__town.fps，走路时 5 秒内的平均 ___ / 最低 ___（毫秒 = 1000 / fps）
点按：            点地走路是否稳定（手指稍有抖动是否仍响应）、双指缩放、点按钮会不会误触发走路
声音：            点进入后有无确认音；切后台再回来是否恢复
软键盘：          名字输入框弹出键盘时，「进入」按钮是否仍可见可点
断线：            开飞行模式 10 秒再关，界面是否显示「重连中」并恢复
发现的问题：
```
