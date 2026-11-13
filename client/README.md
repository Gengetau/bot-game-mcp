# 栖灯镇三维网页客户端（街景与居民美术）

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
npm run client:e2e      # 完整一遍约 12 分钟（其中步骤 15「声音」约 7 分钟），不进 CI；需要完整导出（含 .br）。开发中用 --only=<步骤号> 跑子集
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
             actor.gd（居民：折线插值、动画） world.gd（从 /map 生成街景） rig.gd（镜头）
             audio.gd（音乐、环境声、音效） main.gd（启动流程、协议、输入、续租、重连）
  web/       shell.html（导出外壳，无内联脚本） boot.js（启动引擎、fetch 通道、AudioContext 拦截）
             hud.js / hud.css（DOM 界面：面板、姓名牌、按钮、提示条、声音开关、音量面板）
  stream/    music/{day,night}.ogg：不进 pck，导出时拷到 build/web/music/
  assets/    素材（素材同事的范围，只读）；*.import 入库，.godot/ 不入库
client/tools/export.sh
client/art_source/, client/ASSETS.md   素材来源与台账（audio/ 是音频再生成脚本）
```

## 协议要点（实现位置都在 main.gd）

- 启动：点「进入小镇」（用户手势：恢复 AudioContext、播确认音）-> `GET /session`、`/config` -> 未登录且开放开发登录则显示名字框
  `POST /auth/dev`，否则提示去旧页面 -> `POST /enter` -> `GET /map`（生成街景）-> `POST /ws-ticket` -> 连 `/town/ws` -> hello -> scene。
- 网络：`fetch` 经 `boot.js` 的 `TownHost.fetchJson`（同源 Cookie），结果回调进 Godot；WebSocket 用 `WebSocketPeer`，每帧 poll。
  **不使用 `JavaScriptBridge.eval`**（这条路径的 CSP 没有 `unsafe-eval`）。
- 位置：只按 scene 里的折线 + `speed` + `startedAt` + `until` 和服务器时间现算（`hello.serverTime` + ping/pong 取最小往返的样本）。
  没有预测；被纠正时把「显示 - 真值」当偏差指数衰减。
- 输入：点地面 -> `navigate {to:{x,z}}`；点物件 -> `navigate {to:物件编号}`，够得着（`/me` 的 `here.objects[].near`）才出动作按钮；
  点人 -> `navigate {approach}`；停下 -> `stop_navigation`；走路中再点就是改道；点在 DOM 控件上不会走路；失败显示服务器的中文 `message`。
  等待确认时顶部有「正在确认…」，地面标记先灰后黄。触摸和鼠标分开处理（关掉了互相模拟），双指缩放、滚轮缩放。
- 键盘（桌面）：WASD / 方向键走，`E` 与最近的可互动物件或人互动（8 米内最近的一个，复用点击的入口：够得着的物件直接开始动作，远的先走过去，人就走到身边），`Esc` 先关地点菜单、没有菜单就停步。键位由网页层 `hud.js` 盯着（输入框、文本域、下拉框里一律不响应；Ctrl / Alt / Meta 组合键不响应；窗口失焦、切后台、焦点进输入框都当成全部松开），只把「现在按着哪几个方向」（`keys` 事件）和 `E`（`interact`）报给 Godot。`main.gd` 把屏幕方向换成世界方向（镜头固定朝北俯视：上 = -z，右 = +x，斜向归一化）后，经 WebSocket 发 `{t:"dir", seq, epoch, x, z}`——只有方向、递增序号和控制版本，没有坐标；按住时每 175 毫秒重发（方向变了最快 60 毫秒发一次），松手、`Esc`、失焦发零向量。服务器把它变成一段约 500 毫秒租约的短直线，所以画面依旧只按服务器给的折线插值，没有预测。点地、点物件、点「停下」时方向输入让位：按着键点地不会被下一次重发盖掉，要全部松开后再按才重新起步。方向输入的路线不走 10 秒续租。键位提示（`#keyHint`）只在有鼠标和物理键盘的设备上显示（`hover: hover` 且 `pointer: fine`），触摸设备不显示。协议细节见 `docs/TOWN.md` 的「键盘方向输入」。 点地和「停下」的动作带 `dirFence`（hello 里的 `dirConn` + 已发出的最大方向序号），让在途的旧方向帧确定作废；点地后要再按下一个新的方向键才会重新起步，Esc 只在确实在走时才发停止。
- 续租：走路时每 `renewEveryMs` 发 WS `renew`，回答不是现在这段就照新的续；WS 断着时用 `POST /nav/renew`。
- 在场与控制权：`/enter`、按 `nextHeartbeatMs` 心跳；没有控制权时只读并给「接管」（`POST /claim`）。`clientId` 存 `sessionStorage`（每个标签页一个），用 Web Locks 判断复制出来的标签页并给它换新 id。
- 断线：WS 关闭后退避重连（1 -> 15 秒，每次重新取票据），断着时每 1.5 秒 `GET /scene`；回到前台（或主循环停过超过 3 秒）立即对时、心跳、取快照，并发一次探测，3 秒内没有任何回应就按死连接重连；前台使用时 12 秒没收到任何消息也按死连接重连；后台期间停掉的时间不算静默。
  `hello.map.checksum` 和手里清单不一致时重新取 `/map` 并重建场景。
- 私宅：scene 里 `scene` 变成 `home` 时切到 home 场景；出门切回。
- 一件可交互物件：藏书架的「读书」（一个人就能开始、不用先买东西）。远处点它 -> 走近 -> 出现「读书」按钮 -> `start_interaction`
  -> 服务器确认 -> 提示条和「正在：读书」。远的时候直接发会得到 `too_far`，界面提示「离……太远了」（`?debug=1` 下 `__town.act({...})` 可直接发任意动作）。
- 调试钩子：`?debug=1` 时每 100 毫秒写 `window.__town`：`{self, scene, space, serverTimeOffset, connection, actors:[{id,name,x,z,moving,sx,sy}], objects, mine, pending, ...}`，
  另有 `project(x,y,z)`（世界坐标 -> 页面像素）和 `act(action)`。`window.__town` 只在 `?debug=1` 下存在；`window.TownHost.audioState()` 一直存在，只返回各 AudioContext 的状态字符串。

## 音频

代码在 `scripts/audio.gd`（`TAudio`），素材台账在 `client/ASSETS.md`「音频台账」，再生成脚本在 `client/art_source/audio/`。

- **构成**：两首循环音乐（白天 / 夜晚）、四条环境声（白天、夜晚、室内、喷泉定点）、10 个操作音效（确认、脚步、点地、失败、互动开始、收到消息、开关面板、硬币、进门）。全部是 CC0 的 Ogg Vorbis。
  体积：音乐 1.41 MB、环境声 0.52 MB、音效 58 KB，合计约 1.99 MB。
- **总线**：Godot 里建三条总线 `Music` / `Ambience` / `SFX`，都送到 `Master`。音量变化、总静音、后台静音一律经过平滑（时间常数约 0.12 秒），不会突响。
- **音乐放在 pck 之外**：`client/town/stream/music/{day,night}.ogg`（目录里有 `.gdignore`，Godot 不导入，不进 pck）。`client/tools/export.sh` 把 `client/town/stream/` 下的子目录原样拷到产物里
  （`build/web/music/`），引擎照常托管（`/town/3d/music/day.ogg`，`Cache-Control: no-cache` + ETag）。客户端在用户点「进入小镇」之后才用 `HTTPRequest` 取（先取当前时段的那一首），
  取到后 `AudioStreamOggVorbis.load_from_buffer`，所以不占首屏的下载量，也不拖慢「进入」按钮出现；每个请求 30 秒超时，两首各自独立取、各自重试（一首卡住不拖另一首）；取不到会隔 20 秒重试，共 3 轮，之后就没有音乐，环境声和音效不受影响。
  环境声和音效很小（0.58 MB），留在 pck 里。音乐放在 pck 之外，所以 pck 里只多了这 0.58 MB；`index.pck` 现在约 1.79 MB（br 约 1.63 MB，其中还有街景与居民的模型、贴图），见下面「包体与耗时」。
- **昼夜**：取自服务器世界时间，不看设备时区。`clock.server_now()`（对时后的服务器毫秒）经 `boot.js` 的 `TownHost.worldHour(时区, 毫秒)` 换成世界时区的钟点
  （时区来自 `GET /config` 的 `world.timezone`），18:00 到次日 06:00 放夜晚曲 + 虫鸣，其余放白天曲 + 鸟风。每 2 秒重算一次，换时段时两首音乐 6 秒交叉淡入淡出，环境声 3 秒；
  两首都一直保持播放位置（淡出到 0 时暂停，不销毁），所以不会「重新从头放」。**光照（`daynight.gd`）用同一个钟点来源**：同样经 `TownHost.worldHour` 取钟点（Intl，认夏令时、任意 IANA 时区；Godot 里没有时区偏移表），至多每秒向 JS 要一次，服务器时间没对上（`clock.has_sync` 为假）之前不更新光照；不在网页环境（没有 `bridge.web`）时退路是东京时间（UTC+9），与音频的退路一致。`__town.hour` 是光照当前用的钟点。调试：`?debug=1&hour=21` 强制钟点；**光照读 `hour` 参数的方式是页面加载时读一次**（`bridge.gd`），音频一侧经 `boot.js` 每次现读所以改地址栏也生效，但想让光照也固定在某个钟点，要带着 `?debug=1&hour=` 重新加载页面。
- **环境声切换**：按所在区域的 `indoor` 标记（来自 `/map` 清单的区域表）判断室内外。进室内：室内环境声（壁炉 + 房间底声）淡入，室外环境声降到 12%；出来切回。
  室内外变化时响一声门（刚进入、刚重连时的第一次判断不响）。喷泉：取地图里 id 以 `fountain` 结尾的障碍的中心，按自己到它的距离衰减（4 米内满，22 米外无，之间平方衰减），室内听不到。
- **音量设置**：顶栏「声音：开 / 关」是总静音（原有），旁边新增「音量」按钮，展开 `#soundPanel`：音乐、环境声、音效三条滑块和「切到后台时静音」勾选。
  记在 `localStorage`（键 `town3d.audio`，JSON；总静音仍是 `town3d.sound`），读写都包了 `try/catch`，读不到就用默认值（音乐 60、环境声 70、音效 80、后台静音开）。
  界面文字全在 `shell.html`；`hud.js` 管存取并发 `vol` / `bgmute` / `sound` 事件给 Godot，进入小镇时全量发一遍。
- **浏览器限制**：沿用原做法：`boot.js` 记录 Godot 建出来的 `AudioContext`，用户点「进入小镇」（手势）时 `resume()`，之后任何 `pointerdown`/`touchend` 都会再试一次；被阻止时静音继续，不报错。
  音频在手势之前不初始化（`init_after_gesture()`）。
- **后台**：页面切到后台时，若勾着「切到后台时静音」（默认），`boot.js` 把所有 `AudioContext` `suspend()`，Godot 一侧主总线也淡到 0；回到前台 `resume()`，不新建上下文，不叠播。
  没勾时后台继续放（但后台标签页没有渲染循环，淡入淡出和昼夜切换会停在原地，回前台继续）。
- **提示音**：服务器事件（`mail`、`chat`、`invite`、`offer`、`asked_hobby` 响收信音；`interaction_done` 和带「硬币」的 `notice` 响硬币声）按事件编号去重，
  比服务器时间旧 15 秒以上的不补播，所以断线重连补发的事件不会连响。点地确认、够不着 / 失败（所有红色提示条）、互动开始、开关地点菜单和音量面板各有各的声音。
- **缺资源**：任何一个音频文件缺失 / 加载失败，只是少一层声音：音乐取不到就没有音乐，`load()` 不到的音效 / 环境声在播放时直接跳过，页面和游戏流程不受影响（端到端步骤 15 用 404 掉整个 `music/` 验证）。
- **调试**：`window.__town.snd` 有音频状态（总线分贝、各层增益 / 是否在放 / 播放位置、世界钟点、各音效播放次数），`window.__town.audioPrefs` 是网页层的偏好。
- **没做**：没有在真机上听过；不按天气换环境声（服务器没有天气）；打开小游戏时没有降低背景音乐；没有「房间混响」类处理；音乐没有按建筑区分。

## 已知限制

- 房屋是剖开式：屋顶、山墙和上半墙在角色进屋或挡住视线时淡出，不画成半高墙。居民 8 套服装、站走坐挥手互动动画；昼夜跟服务器世界时间。美术是第一版，之后可以换模型（见下节）。
- 无头 Chromium 用 SwiftShader 渲染，帧率约 3 到 8，没有性能参考意义。画面像素超过 250 万时会自动降 3D 分辨率。桌面 deviceScaleFactor 2（520 万像素）时只剩 1 到 2 帧，页面的时钟估计会被拖到往返 1.5 秒、位置偏差到 0.7 到 1 米，所以验收里桌面用 dsf 1（见 `client/demo/README.md`）。
- 服务器规则失败（422 等）时 Chromium 控制台会有一行「Failed to load resource」，这是 fetch 对非 2xx 的固有输出，不是脚本错误；端到端要求这类行数等于步骤里声明过的预期失败次数。
- 卡顿诊断与预热：`?debug=1` 下 `window.__town.frameMaxMs` 是 Godot 自上次推送以来最长的一帧间隔（用墙钟量，引擎传给 `_process` 的 dt 会被截断，看不出长卡顿），`window.__frameMaxMs` 是网页层累计值，`__town.slow` 记最近超过 400 毫秒的帧（时刻、间隔、动态分辨率、自己的位置）。端到端每一步结束时把这一步里两个页面的最长帧间隔和浏览器报告的主线程长任务写进备注。兼容渲染器在某个东西第一次进入画面时才编译着色器、上传缓冲，软件渲染下一次可达 0.6 秒，而方向输入的租约只有 0.5 秒，走到那里的人就会停一下；所以 `world.gd` 在第一次显示每个场景时用一个 48x48 的离屏视口、正交俯视把整个场景画一遍（`_warm_up`），把这些一次性开销付在进入小镇的那一刻。
- 软件渲染（3 到 8 帧每秒）下页面的服务器时间估计比真实服务器慢约 110 到 290 毫秒（端到端步骤 2、8 的对时数据；推断原因是 pong 要等下一帧才被读到），折成位置是整体滞后 0.3 到 0.7 米；真机待测。
- 标签页在后台时浏览器暂停渲染循环，心跳和续租也暂停（在场租约 60 秒），回前台会重新进入并取快照，同时发探测、3 秒内无回应就重连（见「协议要点」的断线一条；后台停掉的时间不算静默）。
- WebSocket 正好断着的时候在别处离开小镇（比如另一个标签页点了「离开」），本页收不到撤销通知；心跳发现不在场（`presence_lost`）后约 2 秒会自动重新进入。服务端目前不告诉客户端「为什么不在场」，区分「在别处主动离开」和「服务器重启」需要服务端给出原因，记为 P1 事项。
- 声音：没有在真机上听过，音乐和音效好不好听、混音平衡、循环接缝听着顺不顺都只有工具测量，没有人耳确认；无头 Chromium 允许自动播放，「浏览器真的阻止自动播放」的场景没有实测（只保证代码路径不报错）。
- 键盘方向输入只走 WebSocket：WS 断着时按键不起作用（点地仍可用）；贴墙时是沿一个轴向滑动，速度按分量折算；没有手柄 / 摇杆。窗口失焦发零向量靠 `blur` 事件，浏览器在极端情况下（系统级抢焦点）可能不触发，那时服务器 500 毫秒租约兜底。
- 不做：聊天、背包、信箱、小游戏界面、NPC、摇杆；这些仍在旧页面 `/town/`。
- 引擎不支持 Range 请求、缓存策略是 `no-cache` + ETag（见 `docs/TOWN.md`）。

## 包体与耗时（本机，无头 Chromium，仅供参考）

| 文件 | 原始 | gzip | brotli |
|---|---|---|---|
| index.wasm | 39,514,754 | 10,153,810 | 6,902,599 |
| index.pck | 1,786,832 | 1,684,894 | 1,628,588 |
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


## 美术层与可替换素材

- `town/assets/art_table.json`：物件种类（kind）到模型的对应表。每条可写 `model`（glb 路径）或 `proc`（`town_art.gd` 里程序生成的函数名）、`scale`、`yaw`、`offset`、`palette`、`fade`（挡镜头时淡出）、`glow`（夜里发光点，偏移用最终摆放空间）。
- `town/scripts/art.gd`（`TArt`）读这张表；`town/scripts/town_layout.gd` 摆放非可走地面上的装饰（树、路灯、围栏、摊位、长椅……），`world.gd` 的 `put()` 会拿服务器地图校验脚印，压到可走格的装饰被拒绝，不会挡路。
- **私有覆盖目录** `town/art_private/`（已在 `.gitignore`，不进仓库）：放 `art_table.json` 和模型文件，同名 kind 覆盖仓库里的条目，路径用 `res://art_private/...`。不是 CC0 的素材（例如 YumeForge）只能放这里。没有这个目录时用仓库里的 CC0 默认素材，导出照常成功。
- 居民外观：`actor.gd` 的 `appearance_for(id)`，按编号 hash 选 8 套服装之一；要换规则只改这个函数。
- 画质：HUD 的「画质」按钮切高 / 低（localStorage `town3d.quality`）。高 = 平行光阴影；低 = 脚底圆影，手机和软件渲染默认低。3D 分辨率会在帧率长期过低时自动下调（动态分辨率）。
- 调试：`?debug=1&hour=19` 固定世界钟点（昼夜截图用）。
