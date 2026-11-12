# 栖灯镇三维网页客户端（P0 灰盒）

Godot 4.7.2（GDScript，Compatibility 渲染，单线程网页导出）。Godot 只画三维世界，所有文字界面是叠在画布上的普通 DOM。
服务端协议见 `docs/TOWN.md`（「空间与导航」「HTTP 接口」「空间同步（WebSocket）」），客户端不改服务端规则。

## 需要的工具

- Godot 4.7.2 稳定版，装好网页导出模板（本机 `/opt/godot/godot`；别处用环境变量 `GODOT=/path/to/godot`）。
- Node 22（跑引擎和导出脚本里的预压缩）。
- 不需要 Blender：角色和音频素材已经在 `client/town/assets/`（再生成见 `client/ASSETS.md`）。

## 导出

```bash
npm run client:export          # = bash client/tools/export.sh
SKIP_COMPRESS=1 npm run client:export   # 开发时跳过 .br/.gz（brotli 11 约 1 分钟）
```

脚本：导入资源 -> `--export-release "Web"` -> 把 `client/town/web/` 下除 `shell.html` 外的文件拷进去 -> 对 `.wasm/.pck/.js/.css`
生成 `.br`/`.gz` -> 打印大小。产物在 `client/town/build/web/`（不进版本库）。

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
npm run client:e2e      # 约 3.5 分钟，不进 CI
```

脚本 `scripts/client-e2e.mjs` 自己起引擎（子进程、开发登录、keys 认证里放一个测试 AI 密钥、临时库、随机端口），
开桌面 1440x900 和手机 390x844（触摸）两个 Chromium 上下文加一个 agent-kit 的 AI 居民，走完 11 步并检查控制台、CSP 和失败请求，
截图写到 `client/demo/`，结果写到 `client/demo/results.json`，验收记录见 `client/demo/README.md`。需要 Playwright 和 Chromium
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
- 在场与控制权：`/enter`、按 `nextHeartbeatMs` 心跳；没有控制权时只读并给「接管」（`POST /claim`）。`clientId` 存 `sessionStorage`（每个标签页一个）。
- 断线：WS 关闭后退避重连（1 -> 15 秒，每次重新取票据），断着时每 1.5 秒 `GET /scene`；回到前台立即对时、心跳、取快照。
  `hello.map.checksum` 和手里清单不一致时重新取 `/map` 并重建场景。
- 私宅：scene 里 `scene` 变成 `home` 时切到 home 灰盒；出门切回。
- 一件可交互物件：藏书架的「读书」（一个人就能开始、不用先买东西）。远处点它 -> 走近 -> 出现「读书」按钮 -> `start_interaction`
  -> 服务器确认 -> 提示条和「正在：读书」。远的时候直接发会得到 `too_far`，界面提示「离……太远了」（`?debug=1` 下 `__town.act({...})` 可直接发任意动作）。
- 调试钩子：`?debug=1` 时每 100 毫秒写 `window.__town`：`{self, scene, space, serverTimeOffset, connection, actors:[{id,name,x,z,moving,sx,sy}], objects, mine, pending, ...}`，
  另有 `project(x,y,z)`（世界坐标 -> 页面像素）和 `act(action)`。

## 已知限制

- 只有灰盒和一个居民模型；角色外观、动画、昼夜都是占位。墙画成半高（斜俯视免得挡住室内）。
- 无头 Chromium 用 SwiftShader 渲染，帧率约 3 到 8，没有性能参考意义。画面像素超过 250 万时会自动降 3D 分辨率。桌面 deviceScaleFactor 2（520 万像素）时只剩 1 到 2 帧，页面的时钟估计会被拖到往返 1.5 秒、位置偏差到 0.7 到 1 米，所以验收里桌面用 dsf 1（见 `client/demo/README.md`）。
- 服务器规则失败（422 等）时 Chromium 控制台会有一行「Failed to load resource」，这是 fetch 对非 2xx 的固有输出，不是脚本错误。
- 标签页在后台时浏览器暂停渲染循环，心跳和续租也暂停（在场租约 60 秒），回前台会重新进入并取快照。
- 声音：没有在真机上听过；被浏览器阻止时静音继续。没有在 Godot 里测过音量。
- 不做：聊天、背包、信箱、小游戏界面、NPC、摇杆；这些仍在旧页面 `/town/`。
- 引擎不支持 Range 请求、缓存策略是 `no-cache` + ETag（见 `docs/TOWN.md`）。

## 包体与耗时（本机，无头 Chromium，仅供参考）

| 文件 | 原始 | gzip | brotli |
|---|---|---|---|
| index.wasm | 39,514,754 | 10,153,810 | 6,902,599 |
| index.pck | 109,568 | 103,792 | 102,090 |
| index.js | 279,815 | 68,917 | 59,854 |

本机回环、brotli：到出现「进入小镇」按钮约 1.5 秒；点进入、输入名字到可操作（含网络往返）约 2.5 秒。真实网络下主要看 wasm 的 6.9 MB。

## 目标浏览器记录

| 环境 | 状态 |
|---|---|
| 无头 Chromium（Playwright，SwiftShader，桌面 1440x900 与手机模拟 390x844 触摸） | 已验证：`npm run client:e2e` 的 11 步全过（含 AI 居民、断线重连、两个标签页控制权），无 CSP 违规；细节见 `client/demo/README.md` |
| 安卓 Chrome | 待真机验证 |
| iOS Safari（含 `connect-src` 同源 ws、音频手势、安全区） | 待真机验证 |
| Windows Chrome / Edge | 待真机验证 |
