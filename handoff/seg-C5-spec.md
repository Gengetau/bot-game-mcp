<!-- C5 客户端：信箱。五个一级标题：任务书、完成的标准、检查命令、核实办法、评审角度 -->

# 任务书

## 统筹的更新（写在最前面，和下文有出入时以这里为准）

这份任务书是 11-13 下午写的，之后开发分支又并进了几段。下面几条是现在的实际情况，和后文有出入时以这里为准。

### 一、基线

开发分支 `claude/loving-ride-s01h0g` 现在已经包含：C1a（面板骨架、附近聊天）、N1a（服务端 NPC，客户端还不画）、C1b（「全镇」页签和头顶气泡）、S0（骨架小补丁，见下一条）、C4（居民卡、当面邀请、「人家」页签里的请柬和门牌：`features/people.gd`、`mod/people.*`、60 号步骤、`scripts/e2e/lib/people.mjs`，说明在 `client/docs/C4.md`）。现在有三个真页签（附近、全镇、人家）。共同活动（C2）正在另一个工作树里做，还没并入；和它有关的约定按后文写的来。动手前先读 `client/docs/C1a.md`（尤其是「S0 之后」一节）、`client/docs/C1b.md`、`scripts/e2e/steps/README.md`，再读已经并入的两个功能当样板：`client/town/scripts/features/town.gd` 与 `client/town/web/mod/town.*`、端到端 `scripts/e2e/steps/30-chat-town.mjs`、`scripts/e2e/steps/25-skeleton.mjs`、辅助 `scripts/e2e/lib/`（`ui.mjs`、`chat.mjs`、`town.mjs`）。

### 二、后文说的「统筹的补丁 S1、S2、S3、S4」都已经并入（合成了一段，叫 S0）

后文凡是写「等 S1 / S2 / S3 / S4 合并」「字段存在才断言」「没有它也必须能跑通」的地方，一律按下面的现状来做：

- 原 S1（页签条放得下五六个页签）：已做。`.dock-tab` 左右内边距 9 像素、间距 2 像素；`#dockTabs` 可横向滚动，选中的页签自动滚进可见范围；手机抽屉里页签压在把手之上，真实点按点得到；条高在抽屉里是 44 像素。`dock.css`、`dock.js` 仍然不许各段改。后文「S1 未合并时这条会红」的说法作废：这条现在必须绿。
- 原 S2（服务端字段）：`interaction.startedAt`（共同活动开始时刻，服务器毫秒，没开始是 `null`）和 `/config` 的 `limits.personReach` 都已经有了。后文「没有这个字段时要退化」「字段存在才断言」作废：直接用、直接断言，不要再写退化分支。
- 原 S3（端到端的小镇参数）：`scripts/client-e2e.mjs` 起引擎时已经传 `town.params`：`interactionTimeScale` 0.075（十分钟的活动约 45 秒）、`letterDeliveryDelayMs` 4000、`activityLobbyTtlMs` 25000。步骤里用 `h.townParams` 读，等待一律按参数算、等条件出现，不写死秒数；断言「还没到」之前先算清楚离到期还剩多少。后文为了躲开 60 秒、10 分钟等待而设计的编排（「先寄、再做别的、最后等」之类）可以简化。后文凡是写「要真实等十分钟」「等 60 秒」的步骤，现在按参数只需要等几十秒（十分钟的活动约 45 秒、五分钟的约 23 秒、信件 4 秒、报名最长保留 25 秒）；界面上花费的文字会从「十分钟」变成「约 N 秒」，不要断言「十分钟」这几个字。仍然不要改 `client-e2e.mjs`。
- 原 S4（E 键）：E 键和点击现在都会先问 `features.on_pick(kind, id, src)`（`src` 是 `tap` / `key` / `button`，功能不要按来源分支）。后文「不依赖也不测 E 键」改为：你的 `on_pick` 要保证点击进来和 E 键进来结果一样，并在端到端里各走一次（写法参考 25 号步骤里 `__town.features._pick` 的用法）。手机上的「互动」按钮是 C7 的事，本段不加。注意 E 键这条路在调 `on_pick` 之前可能先等一小会儿（等 `/me` 刷新、等上一个动作回执），等待之后只复查了阶段，没有防重入：连按两下 E 可能让你的 `on_pick` 被连着调两次。所以 `on_pick` 里要自己防重入（已经开着同一个面板、同一个请求还在路上时直接返回 true，不重复发动作），并用端到端测一次「连按两下 E 只生效一次」。

### 三、检查怎么跑

- **不要跑完整的 `npm run client:e2e`**（一遍二十多分钟，几段共用一把锁）。只跑 `flock /tmp/town-heavy.lock npx tsx scripts/client-e2e.mjs --only=1,<自己的步骤> --no-shots`，加上直接受你影响的旧步骤（动了公共文件才需要）。完整一遍由统筹在并入后跑。后文「检查命令」里若写了完整一遍，按这一条执行。要留验收截图时去掉 `--no-shots` 并给 `--shots-dir=` 指到会话临时目录，挑好的再拷进 `client/demo/`。
- 只改了网页层（`client/town/web/`）时用 `npm run client:web` 重建，不必整个导出；动了 GDScript 才 `npm run client:export`。两个都要包在 `flock /tmp/town-heavy.lock` 里。
- 纯逻辑（排版、状态机、去重、倒计时换算）尽量写成不依赖场景树的纯函数，放进 `client/tests/` 的无头单元测试（`npm run client:unit`，样板 `client/tests/town_logic_test.gd`、`bubble_layout_test.gd`）。单元测试几秒钟跑完，比端到端便宜得多。
- 其余快检查照旧：`npm run typecheck`、`npm run client:lint`、`npm test`（动了服务端或文档生成才需要）、`npm run docs`（无差异）。

### 四、做事的规矩

- **勤提交**：每做完一小块就在自己的工作树里提交一次（容器可能重启，没提交的会丢）。提交前确认源码没有停在反向验证「故意改坏」的状态。
- 页签里的按钮样式要带 `#dock [data-pane="<你的页签>"]` 前缀，否则会被 `dock.css` 的 `#dock button` 重置盖掉（C4 踩过：按钮只剩下划线文字）。
- 已并入的真功能会接管点选：居民卡接管 3 米内的人（点击和 E 键都是）。你的端到端里要让人站到一起时注意这一点（对着身边的人按 E 会出居民卡）；需要「没有任何功能接管」的场景时用 debug 口 `__town.pickStub('-')`（一律不接管，用完 `pickStub('')` 撤掉，放在 try/finally 里），写法见 25 号步骤文件。25 号文件自己就是在这个状态下核对旧行为的，所以你的功能接管物件之后不用改它。
- 角标规则：`#dockBtn` 上的数字是各模块未读数之和；你的模块有「未读」概念就按 `mod/town.js` 的做法报给骨架，没有就不报。
- 步骤编号只用自己的号段（见 `scripts/e2e/steps/README.md`），`meta.id` 全局唯一。
- 端到端里走到某处一律 `walkTo`，不要「点几下就算到了」；负向断言要有屏障；阈值留余量；不要断言随机串里不含某个短串。
- 手机抽屉布局下的点按要用真实点击（`locator.click()` / `tap()`），不要用 `dispatchEvent('click')` 绕过命中测试。
- 汇报里如实写：哪些断言做过反向验证（改坏后确实变红）、哪些只是推演。

### 五、11-15 的补充（最新；和前四条、和后文有出入时以这里为准）

- **基线又往前走了。** 开发分支现在还包含：C2（共同活动：`features/activity.gd`、`activity_logic.gd`、`web/mod/together.*`，页签叫「一起」，40 号步骤，`scripts/e2e/lib/activity.mjs`，说明 `client/docs/C2.md`）、C3（游戏桌入座玩数字炸弹：`features/game.gd`、`web/mod/game.*`，是盖在画面上的面板不是页签，50 号步骤，`lib/game.mjs`，说明 `client/docs/C3.md`）、C2b（见下一条，说明 `client/docs/C2b.md`）、N1b（服务端 NPC 台词与茶馆掌柜卖茶）、S1（多人同时进镇时出生点错开）。C6（NPC 的外观、名牌和服务菜单：`features/npc.gd`、`npc_logic.gd`、`web/mod/npc.*`，菜单是盖在画面上的浮层卡不是页签，80 号步骤，`scripts/e2e/lib/npc.mjs`，说明 `client/docs/C6.md`。和你有关的三点：一，NPC 和居民在客户端合在同一张角色表里，按 `kind == "npc"` 区分，要当「居民」用的地方都得筛掉 NPC（收信人、寄信对象只能是居民）；二，居民卡、NPC 菜单这类浮层卡同一时刻只留一张，经 `ctx.card_claim` / `ctx.card_release` 和功能的 `on_card_yield()` 互让，信箱是页签，用不着，但你要是加了浮层卡就得走这一套；三，端到端的 `newPlayer` / `h.pair()` 默认不画 NPC（只在 `?debug=1` 下生效的调试开关），信箱的步骤不需要 NPC，保持默认）。前面「共同活动（C2）正在另一个工作树里做，还没并入」的说法作废。现在的真页签是四个：附近（顺序 10）、全镇（20）、一起（30）、人家（40）；信箱是第五个，顺序取 50。`features/mail.gd` 现在是一个只有 `id = "mail"` 的空桩，`manifest.gd` 里已经有它那一行，不要再加注册行。
- **会话代号（C2b）。** `main.gd` 每次进入小镇、进入「已离开」、重新登录都会换一个会话代号（`sess_gen`），`main` 自己的请求在 `await` 之后都对代号，迟到的回应不再套用。对你的影响有两条：一，`ctx.act` / `ctx.act_once` 在换了会话之后回来的结果是一个不带提示的失败（`error` 为 `stale_session`，`message` 为空串），照「失败且没有话可说」处理，不要弹提示、不要重试；二，**`ctx.api_get` / `ctx.api_post` 没有这层保护**，回来的就是服务器的原始回答，所以后文要求的「功能自己的 `_gen`，离开和换人时加一，`await` 之后先比 `_gen`」一条都不能少（`town.gd`、`game.gd`、`people.gd` 都是这样做的，照它们写）。信是私密内容，这一条是本段最要紧的保密点。
- **`pick_stays` 钩子（C2b）。** `feature.gd` 多了 `pick_stays(kind, pick_id)`：返回 true 表示「这一下选中的东西不会让我离开本功能管着的事」，`main` 这一下就不问本功能的 `blocks_input`。信箱没有拦截走动的需要，两个钩子都不用覆盖；知道有它就行，不要改 `hub.gd` 和 `feature.gd`。
- **换人的端到端怎么写。** 20.95、20.96、20.97（`scripts/e2e/steps/20-chat-nearby.mjs`）是现成样板：同一个页面先 `POST /leave`，等页面回到「已离开」，清 Cookie，换名字重新进入。70.95 照它写。要扣住一份在途请求再放回去时注意三件事：页面自己的请求 15 秒超时（`boot.js` 的 `fetchJson`），扣住的请求必须在这之前答复，否则会变成一条「请求失败」记进全程检查；`page.route` 的扣住要放在 try/finally 里收拾；换人之后 Cookie 已经是新居民的，扣住的请求不能直接放行（拿回来的会是新居民的数据），要用事先取好的上一位的回应原文 `route.fulfill`。
- **反向验证的教训（20.97 第一版）。** 那一步第一版断言的是「页面里的自己」和自己的名牌，把被守护的那行代码删掉也是绿的：场景快照每次都会把页面里的「自己」改回来，被套错的状态在页面上只闪一下。后来改成看留得住的东西（功能模块记的 `_me_id`，经 `window.__town.features.<id>` 的 debug 口读）才红得住。所以：**每条新断言都要真的改坏实现跑一次，看到它变红**；断言要落在「错了以后留得住、没有别的东西会把它改回来」的状态上，观察期间把会覆盖它的请求先扣着。只推演不实测的，在汇报里明说是推演。
- **完整一遍的时间。** 现在完整的 `npm run client:e2e` 约 53 分钟，本段不跑（第三条照旧）。信件投递在端到端里是 4 秒（`letterDeliveryDelayMs`），后文「核实办法」里「信的投递要等约 60 秒」作废。服务器对每个 IP 每分钟限 240 个请求，轮询不要太密。

## 原任务书

【跨段约定（统筹在五份任务书里放了同一份；与本书其他文字冲突时以这里为准）】
0. 基线：C1a 的分支（worktree-wf_1c7d0c40-620-1）目前不含开发分支上 P1（一）(#42) 的服务端（没有 reach.ts，games.ts 没有 table_busy 和 /me 的 here.tables），而本书引用的服务端契约都以开发分支当前代码为准。开工前先核对你的基线：`ls packages/engine/src/world/reach.ts` 要存在，`grep -c table_busy packages/engine/src/world/games.ts` 要大于 0。不满足就停下来报告统筹（要先把开发分支并入 C1a 的分支，由统筹做），不要自己合并，也不要自己改服务端去补。
1. 页签与未读角标：页签顺序（data-order）固定为 附近 10（C1a）、全镇 20（C1b）、一起 30（C2）、人家 40（C4）、信箱 60（C5）；游戏面板（C3）是 overlay，不占页签。全部并入后有 5 个页签，而每个页签约 56 像素宽，页签条可用宽度在 340 像素侧栏里约 280、300 像素侧栏里约 240、360 宽手机里约 284，放不下 5 个（第 5 个会被右上角的关闭钮盖住，连小圆点也看不见），所以需要统筹的骨架补丁 S1（dock.css：.dock-tab 的左右内边距 14 改 9 像素、#dockTabs 的间距 4 改 2 像素，实测为准），最迟在 C5 并入时合并；各段不要自己改 dock.css。#dockBtn 的角标 = 所有模块 host.setUnread 数值之和（dock.js 的 totalUnread）。各模块的贡献口径：附近（C1a）未读新话；全镇（C1b）未读新话，静音时不计；人家（C4）未处理的新请柬数（freshCount；信里附的邀请在读信之后出现，同样算）；信箱（C5）服务器口径的 mail.unread（人不在家时一直挂着，直到回家拆信）；C2、C3 不调 setUnread。凡调 host.setUnread 的模块，debug() 里必须有 unread 数字。端到端凡断言「角标是几」的地方，不要写死总数：先读 __dock 里各模块 debug().unread 相加得到期望值（或先断言其它模块此刻都是 0），再与 #dockBtn 的角标比较；拿不准其它模块是否为 0 时，只断言本模块的 debug().unread 和自己页签的小圆点。
2. 钩子的先后与归属（hub 按 manifest.gd 的字母序遍历：activity、bubbles、game、mail、nearby、npc、people、session、town）：
 · on_pick：先返回 true 的接管。C2（activity）只认 kind=="obj"，且该物件在 /me 的 here.objects 里、action.max>=2（茶桌、藏书架、灶台、花箱）；C3（game）只认 kind=="obj"，且该物件在 /me 的 here.tables 里（游戏桌不在 here.objects 里，所以 C2 永远碰不到它）；C4（people）只认 kind=="actor"。三者按数据区分、不依赖遍历先后，对「不是我的」一律返回 false，不吞掉。已经站在自己那张桌的座位上时，C2 与 C3 都返回 true 并什么都不做（吞掉，免得 main 再发一次 navigate、还把桌子记成 selected_obj 弹出「走过去」按钮）。注意 main._on_tap 在调 on_pick 之前已经调过 _can_control()（里面会问 blocks_input），被拦下时 on_pick 根本不会被调。E 键（main._do_interact）对人、对游戏桌、对已经有活动的物件都不经过 on_pick，这是现状（统筹的可选补丁 S4），各段都不依赖它，「认识一下」和各种按钮就是键盘与手机的入口。
 · blocks_input：第一个非空的赢。C2 只在「我在一个共同活动里、且不在小游戏里」时可能非空；C3 只在「在小游戏里」时非空；其余段不实现这个钩子。两者互斥，各自在对方的状态下必须返回空串。C2 的走开确认会拦下一切经 _can_control 的操作（点地、点人、点物件、地点、回家、E），也就是说玩家在共同活动里时，C1b 的「走过去」、C4 的点人出卡、C5 的「回家」第一下都会先被拦一次并提示——这是 C2 的设计，别的段不要绕过，它们的端到端里玩家本来就不在活动里，也不要把这当成故障。
 · actions(out)：每段只追加自己 f:<id>: 打头的按钮。C2 可以从 out 里删掉 main 追加的 busy:<oid>（使用中）和 go:<oid>（走过去）这两种条目，只限它自己的物件；C3 可以删掉游戏桌的 go:<tableId>；其余段不得改别人的条目。在小游戏里时，C2、C4 一个按钮都不出。
 · tags(cam,size,out)：条目 id 前缀各用各的：气泡 b:<居民>（C1b）、桌牌 c:<物件>（C2）、游戏桌牌 g:<桌>（C3）。hud.js 的 setTags 用行内样式给每块牌设 z-index（自己 5、别人的名牌 4，其余 3），样式表里的 z-index 压不过它，所以层级不要靠 CSS z-index，靠位置错开：气泡用 margin-top 抬到名牌上方，桌牌放在物件上方。整体层级是 画布 < #tags < #dock 与 #dockOverlays（C3 的面板、C4 的卡片在牌子之上，可以盖住牌子，但不得盖住正在互动的人）。
 · 事件：每种事件只归一段订阅：chat 归 C1a、town_chat 帧归 C1b、interaction 与 interaction_done 归 C2、activity 与 game_* 归 C3、invite、asked_hobby、notice、you_arrived 归 C4、mail 归 C5。on_event(ev) 收到的载荷在 ev.data 里，不是顶层。
 · ctx.gd：每段只在自己的分区加访问器，函数名全局不重复。导航类的薄转发（C1b navigate_to_place、C2 walk_to、C3 game_walk_to、C4 c4_go 与 c4_approach、C5 go_home）都只是对 main._do_navigate 的几行转发，有意各留一份、互不引用（避免段间依赖和合并顺序）；C7 收尾时可以合并成一个公共版。导航必须走 main._do_navigate（它管续租、序号栅栏、落点标记），绝不用 ctx.act 发 navigate。
 · 动作遇到 too_far：一律不自动重发动作。要不要自己走过去由动作所属的段定：人（问爱好、邀请）归 C4，按顶层 navigateTo 走；游戏桌归 C3；公共物件（C2）的按钮只在够得着时才出现，不自动走；公屏的「走过去」只是走到某个地点（C1b）。「走到物件旁挑一个没人站的座位」的规则 C2 与 C3 各写一份（茶桌座位 / 游戏桌落脚点），算法相同：在没被别的演员占着（距离小于 0.6 米）的点里取离自己最近的，全占了就取最近的。
3. 网页层：模块的 CSS 选择器必须挂在自己的 [data-pane="<id>"]、#dock[...] 之下，或用本段独有的类名前缀；hud.css、dock.css、00-chatkit.css 里已有 .chip .card .note .hint .sel .go .tag 之类通用类名（#activityChip 就是 .chip），裸写会全局串味，影响别的段。host.open() 会把「面板想开着」存进 town3d.dock，只许在玩家自己点了某个按钮之后调用，不得由事件或定时器自动调用。不新增任何浏览器存储键（localStorage、sessionStorage、IndexedDB、cookie、URL 都不行）。
4. 端到端：声明（allowFailure / expectReject）只对「这个页面自己发出」的被拒请求有意义；apiAct 等用 p.ctx.request 代发的请求不经过页面监视，被拒了也不用声明，声明了反而会因为次数没命中被全程检查判红。API 代发的 navigate 没有页面续租，导航租约只有 10 秒（navLeaseMs），人走 2.4 米/秒，所以超过约 20 米的长路必须走页面（地点菜单 [data-dest=…]、回家 / 出门按钮、点人或点地），API 只用来走短路。小工具（读 /me、forceAct 之类）各段在自己的 lib/*.mjs 里各写一份，不跨段 import（避免合并顺序依赖）；C7 收尾可以合并。截图只提交自己号段的 jpg；client/demo/results.json 与 docs/PROGRESS.md 不由各段提交（各段在合并前各自覆盖 results.json 必然冲突），由统筹在全部并入后重跑完整一遍再提交。看图用 `npx tsx scripts/client-e2e.mjs --only=<id> --shots-dir=<临时目录>`（不写 client/demo/）。完整端到端是单机串行的（flock 同一把锁），所以别无谓多跑。
5. 服务端：本段不改 packages/。统筹单独安排一个服务端小补丁段 S2（给 InteractionView 加 startedAt，给 /config 的 limits 加 personReach，各带测试）。S2 合并之前这两个字段不存在：客户端对「没有」要正常退化，对「有」要用上，相关断言写成字段存在才断言。

目标：在三维客户端（client/）的面板底座里做出「信箱」：收件、已发、读信、写信（可附带登门邀请）、未读数汇入启动按钮的角标、新信到达的提示。只在自己的文件里干活：填 client/town/scripts/features/mail.gd，加 client/town/web/mod/mail.{html,js,css}，加 scripts/e2e/steps/70-mail.mjs（号段 70 到 79），可选的小工具放 scripts/e2e/lib/mail.mjs，文档写 client/docs/C5.md。不许改 main.gd、hud.js、shell.html、hud.css、export.sh、client-e2e.mjs、feature.gd、hub.gd、manifest.gd、dock.js、dock.css、00-chatkit.js/css；ctx.gd 只能在自己的「C5 分区」里加访问器。先读 client/docs/C1a.md 全文（尤其第 7 节）、feature.gd、ctx.gd、hub.gd、nearby.gd、web/dock.js、web/mod/nearby.*、web/mod/00-chatkit.*、scripts/e2e/steps/README.md、20-chat-nearby.mjs、scripts/e2e/lib/*。规格和代码不一致时以代码为准。

一、玩家看到的流程（一步一步）
1. 启动按钮「聊天」（#dockBtn）是整个面板的入口，信箱是面板里的一个页签「信箱」（两个字，页签条很挤，不要加长）。没有新信时角标不受信箱影响。
2. 新信送到（寄信后默认约 60 秒，服务器定时任务投递）：收件人若在线，WebSocket 收到 mail 事件，sfx 由 audio.gd 已经响了（不要再加音效）；信箱模块把「未读数」汇入 #dockBtn 角标和信箱页签上的小圆点；面板没开或不在信箱页时弹一条短提示（走 host.toast，文字在 HTML 文字库里）：「信箱里来了一封新信」，人不在家时再加「回家就能读」。提示只在未读数比上一次增加时弹，不看事件本身，所以断线重连后补发的旧 mail 事件不会重复弹。刚登录时的第一份未读数只作基线，不弹（角标已经能看见）。
3. 打开面板，点「信箱」页签。进入信箱后默认在「收件」：新的在前，每封一行：寄信人名字（AI 居民带 AI 小牌）、时间、没读过的有「新」字样和一枚暖橙色火漆点；没读过且人不在家的信，行上写「回家才能拆开」，**没有正文、没有预览**。读过的信行上显示正文头两行预览。页签旁（列表顶部）并排有「收件 | 已发」切换和「写信」按钮。
4. 点一封读过的信：直接进入读信视图（正文来自列表，不再发读信动作），上面是信纸样式的正文（保留换行），底部「回信」「返回」。
5. 点一封没读过的信：
   a. 人在自己家：视图里显示「拆开」按钮，点了发 read_letter，成功后显示正文，未读数减一，角标随之变；若信里附了邀请，下面出现「信里附了一份邀请：可以去 某某 家做客，某时某刻前有效」（只显示，不带「去」按钮，入户是 C4 的事）。
   b. 人不在家：显示一张便签「新来的信要回到自己家才能拆开读」和一个「回家」按钮，**不发 read_letter 请求**；「回家」调用 ctx 的 go_home()（见下），走路期间面板保持打开，到家后（on_me 刷新出 atHome=true）「拆开」自动变成可点。
6. 「已发」：自己寄出的信，新的在前，每封一行：收信人、时间、状态「在路上」或「已送到」，**绝不显示对方读没读**（服务器的已发箱不返回 read，读信要在家，等于暴露行踪）。点开可读自己写的正文和附带的邀请（有效期限）。「在路上」的信，面板在信箱页开着时每 10 秒重读一次已发箱（寄信人不会收到送达事件）；一旦全部送达就停止重读。
7. 「写信」：进入写信视图。a. 收信人：一个搜索框加名单（来自 GET /residents，去掉自己，在场的排前面，名字按输入过滤，AI 带小牌），点一个名字后收信人变成一枚「寄给 某某」的小牌，可点叉换人；回信、或 C4 调用 compose_to 时收信人已选好。b. 正文：多行文本框，字数计数「已写 n / 上限」，上限取 /config 的 limits.letterMaxChars（Godot 一侧 ctx.cfg_limit('letterMaxChars', 1000)，随 state 推给网页），按码点计数（[...s].length，和服务器一致，不要用 textarea 的 maxlength，它按 UTF-16 单位）；超限时计数变红、「寄出」禁用，**绝不静默截断**（服务器会悄悄截断超长正文，见服务端缺口）。c. 一个勾选「附上登门邀请：请对方来我家坐坐」（默认不勾；勾了发 invite:{reentry:true}）。邀请的有效期从信送到时算起，期限长度 /config 没有给，所以界面不写具体时长。d. 「寄出」：成功后回到「已发」并提示「信寄出了，大约 n 秒后送到 某某的信箱」（n 由 Godot 用回执的 deliverAt 减 server_now 算出，向上取整，至少 1）；草稿和收信人清空。失败时草稿、收信人、勾选全部保留，下方显示错误提示（见错误表）。
8. 离开小镇或换人登录：信箱所有内容（收件、已发、正在读的信、草稿、收信人、居民名单缓存）清空，回到收件列表。

二、用到的服务端接口（全部已核对代码；路径都不带 /town/api 前缀，经 ctx.api_get / api_post / act_once）
1. GET /letters?box=inbox|sent&limit=20&before=<next>（http.ts 路由 /town/api/letters → mail.ts listLetters）。要会话，不需要 clientId。响应是 { letters: LetterView[], next: number|null }（没有 ok 字段）。limit 上限 50；next 只在连续翻页时有效，极少数情况下一页会重复上一页的信，**按 letter.id 去重**。LetterView：id、box('inbox'|'sent')、from{id,name,kind:'human'|'agent'}、to{同上}、sentAt、deliveredAt(未投递是 null，只可能出现在已发箱)、read(只有收件箱有)、body(没读过的来信**没有**这个字段；已发信和读过的来信有)、invite{grantId,expiresAt,active}(只有「可读」的信才带，所以没读过的来信看不到邀请)。注意收件箱里没读过的信能看到寄信人和时间（TOWN.md 第 522 行写明是设计），只有正文和邀请要回家才看得到。
2. GET /residents（http.ts → views.ts directory）：{ residents:[{id,name,kind,bio,titles,present,at}] }，最多 500 条，含自己；只用 id、name、kind、present，不要显示 bio 和 at。
3. GET /me 的 mail 与 invites 字段（views.ts meView）：mail:{unread,total}（unread = 已送到且没读过且没删除的来信数；total = 已送到的来信数）。这份数字由 main.gd 的 on_me(view) 钩子送到 mail.gd，是未读数的唯一来源（事件里的数字不可靠，重连补发时是旧的）。view.me.home.id 是自己家的空间编号，view.location.space 是现在所在的空间编号；**atHome = (location.space == me.home.id)**，和服务器 read_letter 的判断完全一致（mail.ts：w.spaceOf(r) !== homeId(r.resident_id) 就拒绝 not_home）。
4. POST /actions（经 ctx.act_once，一次性，不动 pending，不睡眠重试，可复用请求号；见 main.gd _act_once）三个动作（mail.ts installMail）：
   - send_letter {to: 居民编号, body, invite?: {reentry?: bool}}：成功回执 {ok:true, status:'accepted', letterId, deliverAt, text, contextVersion, ...}。服务器会 sanitizeUserText、trim、按码点截到 letterMaxChars（超出部分被**静默丢弃**）、空正文返回 400 bad_request（没有 reason）；每天 lettersPerDay（默认 20）封；对方信箱满 mailboxCapacity（默认 1000）当场拒绝；不能寄给自己或不存在的人。
   - read_letter {letterId}：成功回执带 letter（完整 LetterView，含 body 和 invite）和 mail:{unread,total}。第一次读要在自己家，否则 422 precondition_failed + reason 'not_home'。读过的信在哪都能重读（但重读不需要发动作，列表里就有正文）。
   - delete_letter：**本段不做**（见「明确不做」）。
   动作在一局小游戏里一律被拒（service.ts command：activity_id 非空且不是游戏内动作 → 422 reason 'in_activity'），所以对局中写信和拆信都要禁用；已读信的重读不受影响（不走动作）。
5. WebSocket 事件（ws.ts 的 events 帧，hub 按 event_types 分发）：mail {unread,total,text}（text 是固定模板「信箱里有一封新信，回家就能读。」，不含寄信人和内容）。invite 事件（当面邀请）是 C4 的，本段不收。

三、错误表（reason 取 act_once 返回的 error / reason；界面文字放 HTML 文字库）
发信 send_letter：
- 网络失败（net_fail）：「网络不通，稍后再试，信还在」；保留请求号，用户原样再点寄出时带回同一个请求号（服务器按请求号回放回执，不会寄两封），正文变了就换新号（照 nearby.gd 的 _pending_rid 做法）。
- 422 reason no_such_resident：「找不到这位收信人」（也包括寄给自己）。界面选人时已排除自己，这条是兜底。
- 422 reason daily_limit：「今天寄的信到上限了，明天再写吧」（不写数字，/config 没给 lettersPerDay）。
- 422 reason mailbox_full：「对方的信箱满了，过些时候再寄」。
- 422 reason in_activity：「对局中不能写信」。422 reason not_present：「你现在不在小镇里」。
- 400 bad_request 且本地正文 trim 后为空：「信里要写点什么」（本地先拦，不发请求）；其它 400（如 413「请求体太大了」）：「这封信寄不出去，请缩短内容再试」。
- 409 control_lost：「另一处握着你的居民，这里只能看」，并且 act_once 已把 control_mine 置假。
- 409 context_stale / 410 request_expired：act_once 已自动刷新重试一次；仍失败：「刚才状态变了，请再点一次寄出」。
- 503 recovering：「小镇正在恢复，稍后再试，信还在」（保留请求号）。
- 429 rate_limited（IP 限流）：「请求太频繁，稍后再试」。
- 401：act_once 里 _relogin 处理，界面不额外提示。
拆信 read_letter：not_home →「新来的信要回到自己家才能拆开读」并显示「回家」按钮，同时 ctx.refresh_me()（本地的 atHome 可能过时）；no_such_letter →「信箱里没有这封信了」并重读列表；in_activity →「对局中不能拆信」；control_lost 同上；net_fail →「网络不通，稍后再试」。
读列表 GET 失败（非 200、断网、429）：列表区显示「读不到信箱，稍后再试」加一个「重试」按钮，不清空已有列表。
本地先拦的（不发请求）：未选收信人、正文为空、超长、没有控制权（只读）、对局中、离线（ctx.conn()==='offline'）、另一次发送在途。

四、mail.gd（GDScript）怎么用骨架钩子（签名以 feature.gd 为准）
- _init：id = 'mail'（桩里已有）。event_types() 返回 ['mail']。不需要 tick（不要 wants_tick）。
- setup()：无事。on_enter()：_gen += 1 之外不做耗时事；若 ctx.playing() 则 ctx.refresh_me()。必须幂等。
- on_leave()：_gen += 1；清 _inbox、_sent、_residents、_pending_rid/_pending_text、_owner、_home、_at_home、_unread、_total、_loading 标志；feed('reset')；forget_state()。**在途的 GET 和动作回来时用 _gen 对比，不一致就丢弃**（换人登录时上一个人的信绝不能被塞给新人；nearby.gd 是范本）。
- on_me(view)：取 view.me.id、view.me.home.id、view.location.space、view.mail；如果 _owner 非空且不等于 view.me.id，先做和 on_leave 一样的清理（on_me 可能在 on_enter 前、或在上一个人还没清掉时被调到）；记下 _owner；然后 feed_state({unread,total,atHome,max,canAct,reason,selfId})。canAct/reason：'readonly'（not ctx.control_mine()）、'game'（ctx.in_game()）、'offline'（ctx.conn()=='offline'），否则 ''。feed_state 自带去重，相同不重复推。
- on_event(ev)：type=='mail' 时（hub 已按 event_types 过滤）合并成一次：ctx.refresh_me()（刷新未读数），如果收件箱已经加载过，延后约 300 毫秒重读收件箱第一页（用一个标志去抖，别每个事件一次）。不要用事件里的数字当未读数。
- on_hello(msg, resumed, first) 和 on_resync()：重连后 ctx.refresh_me()，已加载过的箱各重读第一页（按 id 去重合并）。on_ws_closed 不做事。
- on_ui(name, arg)（hub 去掉了 'mail.' 前缀；arg 是 JSON 字符串，有 await 也行，hub 不 await）：
   'load' {box, before?, seq}：GET /letters?box=&limit=20[&before=]；响应回来（先比 _gen）后 feed('list', {box, seq, ok, letters, next, append})。只保留需要的字段（id, box, from, to, sentAt, deliveredAt, read, body, invite），不要整个转存别的。内存里每个箱最多 200 封，超出丢最旧的。同一个箱同时只允许一个在途请求。
   'residents'：GET /residents，feed('residents', {ok, list:[{id,name,kind,present}]})（不含自己；不转 bio 和 at）。
   'read' {id, n}：本地检查（只读、对局中、离线、没有在家）→ ctx.act_once({type:'read_letter', letterId}) → 成功就用回执里的 letter 更新内存里的那一封，并 feed('read', {n, ok:true, letter}); ctx.refresh_me(); 失败 feed('read', {n, ok:false, code, reason, message})。
   'send' {n, to, body, invite}：本地检查（见错误表），长度用 body.length（GDScript 的 String 按码点计数）与 ctx.cfg_limit('letterMaxChars', 1000) 比；rid 复用规则同 nearby.gd；成功后 feed('ack', {n, ok:true, letterId, deliverInMs, to})，同时把已发箱标记为需要重读；失败 feed('ack', {n, ok:false, code, reason, retryMs, maxChars})。
   'gohome'：await ctx.go_home()。
- compose_to(rid: String, name: String) 公共方法（留给将来的居民卡「写信」按钮；统筹已定 C4 在 P1 不做这个按钮，由 C7 评估接线，所以本段里它只被「回信」使用——回信必须走同一条 feed('compose') 路径，由 70.6 覆盖；契约写进 C5.md）：feed('compose', {id: rid, name: name})；网页收到后 host.open({focus:true}) 切到信箱页签并打开写信视图、预选收信人。
- debug()：返回计数而**不含任何信的文字**：{unread,total,atHome,owner是否非空(bool),inbox:条数,sent:条数,reads,sends,lastAck(不含正文),events,gen}。端到端用它当 Godot 一侧的屏障。
- ctx.gd 的 C5 分区只加一个访问器：func go_home() -> void: await m._do_navigate({'to': 'home'}, '')（main.gd 的 _on_action('home') 也是这样调；必须经 main 的 _do_navigate，否则导航续租、标记和 nav_generation 都不会登记，路线 10 秒后就断了）。若 main 里 _do_navigate 的签名与此不符，以代码为准。

五、网页模块（mod/mail.html、mail.js、mail.css）
- 模板：<template id='tpl-dock-mail' data-mod='mail' data-tab-label='信箱' data-order='60' data-layout='tab'>。data-order 取 60 只是为了排在 C1b、C2 的页签之后；页签条在 340 像素宽下装不下太多页签，由 C7 评估。**用 data-layout='tab' 而不是 C1a.md 第 7 节写的 'full'**：dock.js 只有 layout==='tab' 才会在 host.open() 时切页签（dock.js 的 host.open），而深链（compose_to、新信提示）需要它；除此之外 dock.js 对 'full' 没有任何特殊处理，C1a 也没给 full 写样式。尺寸放大由自己的 css 负责（见下）。C1a.md 第 7 节表里写的 data-layout="full" 并不存在（dock.js 只认 tab 与 overlay），以本书为准，C7 汇总文档时更正。
- 文字全放模板的 [data-bank] 里（host.t(key, vars)），mail.js 里没有汉字字面量（npm run client:lint 检查）；不用 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function，不碰 localStorage / sessionStorage / indexedDB。信件行、读信视图、收信人名单的骨架是**独立的顶层 <template>**（不要嵌套 template）：tpl-mail-row、tpl-mail-person。
- 结构：一个 section.dock-pane，里面三个互斥的视图（用 hidden 切换）：list（工具条：收件/已发切换（用 button + aria-pressed，不要再起 role='tablist'，避免和 #dockTabs 混淆）、写信按钮；列表 ol；「载入更多」；空状态便签；错误便签）、detail（返回、信头、信纸正文、邀请便签、拆开/回家/回信按钮）、compose（返回、收信人区、textarea、字数、勾选、寄出、提示行）。选择器约定见下面 domIds。
- 玩家文字（正文、名字）一律 textContent；正文容器 white-space: pre-wrap; overflow-wrap: anywhere; unicode-bidi: plaintext。时间用 Date 格式化成数字（当天 HH:mm，其它 M/D HH:mm），不写汉字字面量。
- 与底座对接：mount(host) 里返回 {onFeed(kind,data), onCore(core,changed), onShow(), onHide(), forceSend(text), debug()}。onFeed 的 kind：'state'（整份替换）、'list'、'residents'、'read'、'ack'、'compose'、'reset'。state 一到就调 host.setUnread(state.unread)（角标和页签小圆点由底座汇总）。onShow：若当前箱没加载过或超过 30 秒，emit('load')；开着写信视图时恢复焦点。onHide 不丢草稿。debug() 返回 {view, box, rows:{inbox,sent}, selected(信编号或空), to(收信人编号或空), draftLen(草稿字数，不含内容), atHome, canAct, reason, unread, requests}，**不含任何信的文字**。
- 键盘：本段不新增任何全局键（Enter、E、WASD、Esc 已被底座和 hud.js 占用）。写信的 textarea 里 Enter 是换行（所以不要用 host.wireInput，它把 Enter 当发送）；Ctrl+Enter 或 Cmd+Enter 寄出（组字中不触发：e.isComposing / keyCode 229 / 紧随 compositionend 30 毫秒内忽略，抄 dock.js wireInput）；Esc 在 textarea 或搜索框里只失焦（preventDefault + blur，不关面板，WASD 马上恢复），再按一次才由 hud.js 关面板并停步。信箱页签激活时 data-focus 只打在当前视图的主输入上（写信视图的 textarea，或收信人未选时的搜索框；列表和读信视图没有 data-focus），让底座的 Enter 打开面板能落到正确位置；视图切换时用 JS 移动 data-focus。所有 button 都是真 <button type='button'>，有可见的 :focus-visible 轮廓；表单 submit 一律 preventDefault（CSP 有 form-action 'none'）。
- 手机：textarea 字号 16px（防 iOS 聚焦放大），enterkeyhint='enter'；「寄出」按钮 mousedown preventDefault（点它不抢走 textarea 焦点，抄 dock.js）；点击热区不小于 44px；列表 overscroll-behavior: contain。软键盘弹起时（body[data-kb='1']，dock.css 把抽屉压成 170px）信箱页签要给写信视图足够高度，见下一条。
- 放大面板（C1a 没给 full 写样式，在 mail.css 里自己写，选择器必须压过 dock.css）：mail.js 的 onShow 里给 #dock 设 data-full='mail'，onHide 里移除（dock.js 在切页签、关闭、离开小镇时都会调 onHide；这是对共享 DOM 唯一允许的写入，且只用属性，不写 style）。css：body[data-dock='drawer'] #dock[data-full='mail'] 把抽屉高度拉到约 72 到 80% 视觉视口高度（用 var(--vvh, 100dvh)），但**必须保证**：390x844 和 360x640 下「停下 / 回家 / 地点 / 聊天」仍完整可见、可点，且不与 #topbar 相交（dock.js 会把 #bottombar 抬到抽屉上沿之上，抽屉太高就会撞到顶栏）；body[data-dock='drawer'][data-kb='1'] #dock[data-full='mail'] 的高度取 calc(var(--vvh) - 16px) 一类，让 textarea、字数和「寄出」同时可见（dock.css 的键盘规则特异性与它相同，town-modules.css 在 dock.css 之后加载所以后者胜，但要写测试断言）；桌面侧栏宽度可放到 clamp(340px, 30vw, 420px)，不得与 #controls 或 #topbar 相交（20.85 的相交断言仍要过）。

六、观感（主人定的美术方向）
《牧场物语：重聚矿石镇》的生活感加《塞尔达传说：织梦岛》重制版的微缩场景感；米白、木棕、灰蓝、柔和绿、少量暖橙。信箱要像镇上的信箱和信纸，不是后台管理界面：列表里每封信是一张叠在纸面上的小信笺或信封（奶油纸、木色细边），未读的有暖橙色火漆点和稍深的纸色，已读的变浅；读信视图是一张带淡横线的信纸，寄信人名字像署名，信尾一枚小火漆（暖橙，只作装饰）；邀请便签用已有的 --d-note 便签黄加胶带角（抄 .chat-pane .note 的做法，写在 mail.css 里）；收信人小牌用木色牌（--d-wood）；错误用 --d-err 但不刺眼；「寄出」钮用 --d-ember 暖橙，其余按钮木色。变量都在 dock.css 的 :root（--d-paper、--d-paper-2、--d-ink、--d-ink-soft、--d-wood、--d-wood-dark、--d-slate、--d-leaf、--d-leaf-bg、--d-ember、--d-note、--d-err、--d-serif）。只用 transform 和 opacity 做动画，尊重 prefers-reduced-motion；不用 backdrop-filter、大半径阴影、循环动画。字号：正文 14px 以上、辅助 12px 以上（11px 以下的信息不能单靠它表达）。文字对比度要够，面板盖在街景上要协调，且不挡住正在走路的角色。
截图（通过 h.shot，JPEG，带 70- 号段，存 client/demo/）：70-desktop-inbox（桌面收件列表，含未读与已读各一封）、70-desktop-letter（桌面读信视图，带邀请便签）、70-desktop-compose（桌面写信）、70-desktop-inbox-evening（登录地址加 &hour=19.5 固定傍晚）、70-mobile-inbox（手机竖屏）、70-mobile-compose-kb（手机写信，TownDock.test.setKeyboard(300) 模拟键盘）。自查后在汇报里给路径。

七、隐私与安全（硬性）
- 信是别人拿不到的私密内容。信件正文、名字、草稿只放内存（Godot 的数组、网页模块的闭包变量和 DOM 文本节点）。**不写** localStorage、sessionStorage、IndexedDB、cookie、URL（hash 和 query 也不要）、console 输出、window.__town / __dock 的 debug 对象（debug 只给计数、编号、布尔）。底座自己已有的界面偏好（面板开关、最后页签）不算，但本段不得新增任何存储键。
- 玩家文字一律 textContent / createTextNode，不拼 HTML 字符串；名字、正文、AI 居民写的信同样当作不可信文字。
- 换人登录、离开小镇（on_leave）、重新进入（on_enter 的兜底）都要清空：Godot 缓存、网页列表、读信视图、草稿 textarea 的 value、收信人、居民名单缓存、搜索框、勾选；feed('reset') 之后 DOM 里不得再留任何上一个人的信的文字。在途的请求回来时必须丢弃（_gen）。
- 没读过的信在没回家前，**正文不得出现在网页 DOM 里**（服务器本来就不给；客户端也不要用别的来源拼）；已发箱不显示、不推断「对方是否已读」。
- 公共场合的泄露：toast 和角标里不放寄信人名字和内容（只有「来了一封新信」；与服务器 mail 事件固定模板同一原则）。
- 只读（另一处握着居民）时仍可读已加载的信，但不能拆信、不能寄信。

八、端到端：scripts/e2e/steps/70-mail.mjs（meta = { id: 'mail', n: 70, title: '信箱' }；写法见 steps/README.md；用 h.pair() 取桌面 A 和手机 B；用 until 轮询，不用固定 sleep；公共小工具写在 scripts/e2e/lib/mail.mjs，仿 lib/chat.mjs；新页面选择器都限定在 '#dock [data-pane=mail]' 里）。信的默认投递延迟是 60 秒（params.letterDeliveryDelayMs），client-e2e.mjs 的 startEngine 不能设 town.params，所以步骤编排成「先寄、再做别的、最后等」，把 60 秒等待重叠掉；不要为此改 client-e2e.mjs（统筹的可选补丁 S3 也许会让它支持传 town.params；没有它也必须能跑通）。每个步骤都要写清楚断言什么：
- 70 初始：A、B 的 #dockTabs 里有 [data-tab='mail']，__dock.mail 存在；点开信箱，收件和已发都是空状态（有空状态便签，行数 0）；#dockBtn 角标隐藏且 _dock.unread===0；Godot 一侧 __town.features.mail 里 unread 0、atHome false（出生在会馆外）；写信按钮可点。
- 70.1 写信与校验：A 点写信 → 居民名单出现且不含自己（对照 GET /residents 的 id）；搜索框输入 B 的名字尾巴（随机后缀）后名单只剩 B；选中后出现收信人小牌；空正文时寄出禁用；输入超过上限（letterMaxChars）的字时计数变红、寄出禁用、没有向 /actions 发 send_letter（A.w.actions 里 send_letter 数量不变，屏障：先用 TownDock.test.forceSend 强发一条超长，等 Godot 一侧 lastAck.code==='text_too_long' 的回应到了，再断言服务器那边的 sent 箱仍为空）；草稿期间扫描 localStorage / sessionStorage / indexedDB.databases() / document.cookie / location.href，都不含草稿里的唯一串。再写一封正常的信 L1（唯一串正文，带换行）→ 点寄出 → Godot lastAck.ok 且有 letterId，界面回到已发并提示「大约 n 秒后送到」，草稿、收信人、勾选已清空；服务器 GET /letters?box=sent 里恰好一封（对照 letterId），正文与所写完全一致（换行保留）。
- 70.2 附邀请与第三封：A 再写信 L2（勾选附邀请）→ 寄出；再寄 L3（正文是 70.8 要用的 XSS 串，见 70.8）；服务器的 A 的已发箱里 L2 的 invite 存在；断言此时 B 的 /me.invites.received 为空（邀请要等对方读信才算得知——服务端规则，用 API 取真相）。B 的 mail.unread 仍是 0 且尚未送到（仅当 ack 里 deliverAt - 当前服务器时间 > 5 秒才断言，否则 note 跳过，防止机器卡顿误报）。已发箱里 L1、L2、L3 状态都是「在路上」。
- 70.3 到达：等 B 的 Godot unread 变 3（until，上限 120 秒）；B 的 #dockBtn 角标显示 3、aria-label 含 3、信箱页签有小圆点（先断言 __dock 里其它模块的 unread 此刻都是 0，再比角标，见跨段约定第 1 条）；B 面板关着时出现了提示（#toasts 里的 .toast 文字等于文字库的「来了一封新信」，用 until 捕捉）；打开信箱：收件三行，都标「新」与「回家才能拆开」，行上有寄信人名字（A 的名字，textContent 精确匹配）；**整个 B 页面 DOM 的文字里不含 L1、L2、L3 的唯一串**，服务器 GET /letters?box=inbox 返回的这三封没有 body 字段、也没有 invite 字段（负向断言屏障：先等两行都渲染出来，并等 B 的 Godot 一侧 inbox 条数为 3，再断言）。同时 A 的已发箱重读后 L1、L2、L3 变「已送到」（A 端的 10 秒重读；等它出现），且 A 页面里没有任何「已读」字样、服务器的已发箱每封没有 read 字段。
- 70.4 在外不能拆：B 点开 L1：显示「新来的信要回到自己家才能拆开读」和「回家」按钮，「拆开」不存在或禁用；B.w.actions 里 read_letter 数量为 0（屏障：点开后等 2 帧，再断言）；为证明这条规则是服务器的、不是客户端臆造的：B 用 apiAct 直接发 read_letter 到服务器，必须得到 422 reason 'not_home'（apiAct 代发的请求不经过页面监视，不用也不能声明 allowFailure：声明了次数没命中，全程检查会判红）；之后 B 的 DOM 仍无正文。
- 70.5 回家拆信：B 点界面上的「回家」（走 go_home），等 B 到家（scene==='home' 或 Godot atHome true，上限 120 秒）；信箱里「拆开」可点；点它：B 页面出现 L1 的完整正文（textContent 精确等于所写，换行保留），Godot lastAck ok；信箱未读 3→2（__dock.mail.unread），角标 = 各模块 unread 之和（此时为 2）；关闭面板再看 #dockBtn 仍是 2；再拆 L2：正文出现，邀请便签出现（文字库里的「信里附了一份邀请」+ 对方名字 + 期限），信箱未读 1、信箱页签小圆点仍在；总角标按「各模块 unread 之和」断言，不要写死：C4 并入后，信里的邀请被读到之后会让「人家」模块多出 1 条新请柬，总角标会是 2，在还没有 C4 的基线上则是 1；服务器 B 的 /me.invites.received 现在有一项，host.id 是 A；B 的 read_letter 动作数恰为 2（L3 留到 70.8 再拆）。
- 70.6 重读与回信：B 出门（#homeBtn 在家里是「出门」），到外面；回到信箱点 L1：直接显示正文，B.w.actions 里 read_letter 数量不增加（仍 2）；点「回信」：切到写信视图且收信人小牌是 A；写回信 R（唯一串）寄出，A 的服务器收件箱在投递前为空（不等投递）；B 的已发箱出现 R「在路上」。
- 70.7 状态禁用：用 TownDock.feed('mail','state',{...}) 注入 canAct:false + reason:'game'（仿 nearby 的 20.7，局限写进文档：真实对局由 C3 的步骤补）和 'readonly'：写信的寄出禁用、占位/提示文字等于文字库对应句、拆信按钮禁用；恢复后可用。再做一条真实只读：用另一个 clientId 调 POST /claim 接管 B 的居民，等 B 页面进入只读（Godot control_mine 假），断言寄出禁用且没有向 /actions 发 send_letter；已读信仍能点开重读。收尾让 B 重新接管。
- 70.8 XSS 与长文字：A 给 B 寄一封正文为 '<img src=x onerror=window.__xss=1><b>粗体</b>' 加 1000 字长串且无空格的信（即 70.2 寄出的 L3，已随前面的等待送到）；B 回家读它（B 需要仍在家里：70.6 出门前先拆完 L3，或 70.8 再回家一次）：拆开后信箱未读 0、信箱页签小圆点消失；总角标按各模块 unread 之和断言（C4 并入后若还有未处理的新请柬，总角标不会隐藏，这是正常的；只在其它模块都为 0 时才断言角标隐藏）；DOM 里没有 img、b 元素（读信视图内 querySelectorAll('img,b,script,iframe') 长度 0），window.__xss 未定义，正文 textContent 精确等于所写；读信视图没有横向滚动（scrollWidth <= clientWidth）。此外收信人名单里的名字、列表里的名字同样 textContent（可用 forceSend 之外的手段构造：把 A 改名为含 '<' 的名字不可行时，只验证正文）。
- 70.85 手机与布局：B（390x844）打开信箱：#dock 高度大于默认抽屉（340px），#dock 的 top 不小于 #topbar 的下沿；「停下 / 回家 / 地点 / 聊天」四个按钮全部在视口内、不与 #dock 相交、不与 #topbar 相交（rectsOverlap）；进入写信视图并 TownDock.test.setKeyboard(300)：textarea、字数、「寄出」三个元素的 rect 都完整落在 visualViewport 内（bottom <= innerHeight - 300 之上）；关键盘后复原。桌面 A（1440x900）：信箱页签激活时 #dock 与 #controls、#topbar 不相交；切回「附近」页签后 #dock 尺寸回到原值（data-full 已移除）。页签条：__dock._dock.mods 里每个页签按钮的矩形都完整落在 #dockTabs 内，且不与 #dockClose 相交（A 的侧栏与 B 的抽屉各查一次；本段单独跑时页签少，天然通过；全部并入后 5 个页签要靠统筹的骨架补丁 S1 才放得下，S1 未合并时这条会红——红了就在汇报里报告，不要放宽）。
- 70.9 截图：见上，h.shot；NO_SHOTS 时跳过但仍断言。
- 70.95 离开与换人：B 先写一半草稿（唯一串）并停在读信视图；B 点 release 前先 POST /leave 再用新名字重新登录（照 20.95 的做法：同一个页面换名重进）；新居民：信箱收件、已发行数 0，textarea.value 为空，收信人小牌不存在，名单缓存清空，DOM 全文不含上一位的任何唯一串，Godot 一侧 __town.features.mail 的 inbox、sent 为 0 且 owner 已换（用 until 等新居民的 /letters 响应返回作屏障，再断言空）；#dockBtn 角标隐藏；全程扫描存储里没有任何信的唯一串。最后 h.release(A)、h.release(B)。
文件末尾写「怎么让它失败」清单（见 done）。页面自己发出的被拒请求才要先 allowFailure 声明；本段预计页面自己发出的 4xx 为 0（70.4 的 422 是 apiAct 代发的，不声明；70.7 里页面在本地就拦下了寄出，没有请求）。未声明的页面 4xx 会让全程检查失败。注意 HTTP 限流是每个 IP 每分钟 240 次，轮询要省着用，优先读 __dock / __town.features，不要高频打服务器。

九、明确不做
- 不做 delete_letter（删信）、批量操作、搜索信件、草稿存档、定时寄信。
- 不做「去某某家」或入户按钮（信里的邀请只显示；入户走 C4），不显示 me.invites 列表（C4），不收 invite 事件。
- 不加全局快捷键，不改 hud.js 的 Esc 逻辑（Esc 在信箱里不能「先返回上一级视图」，只能先失焦、再关面板；草稿在内存里保留）。
- 不在 controls 行加按钮（390 宽放不下），不改启动按钮的文字「聊天」和它的 aria-label。
- 不给 NPC 写信（NPC 不是居民，GET /residents 里没有）；不做信件音效（audio.gd 已响）。
- 不改 packages/（见下）。

十、服务端缺口与处理
原则上不动 packages/。A1 同事正在改 mail.ts、life.ts、property.ts、chat.ts、reach.ts，A2 改 games.ts、spatial/town-map.ts、db.ts：这些文件一律不碰。发现的缺口：
1. mail.ts send_letter 对超长正文静默截断（[...body].slice(0, letterMaxChars)），不报错。客户端本地先拦，不依赖服务器；不挡路，写进汇报交统筹，不修。
2. /config 的 limits（http.ts 约 468 行）只有 letterMaxChars，没有 lettersPerDay、mailboxCapacity、letterDeliveryDelayMs、homeInvitationTtlMs，界面因此不写「今天还能寄几封」「邀请有效多久」。不挡路，不修；如统筹要这些数字，最小补法是在 limits 里加这四个字段并在 test/world 加一条配置读取测试。
3. 寄信人不会收到「送达」事件，所以已发箱的「在路上」靠打开面板时和每 10 秒重读来更新。不挡路。
4. express.json 限制 16kb，若运营把 letterMaxChars 调到 4000 以上，纯中文正文会撞上 413；默认 1000 字不会。不挡路。
5. client-e2e.mjs 的 startEngine 没法设 town.params，信的投递延迟固定 60 秒（见可选补丁）。
如果实现中发现别的挡路的服务端问题：做最小修复并配 test/world 里的测试，在汇报里单列。

十一、交付物
mail.gd；ctx.gd 的 C5 分区加 go_home()；mod/mail.{html,js,css}；steps/70-mail.mjs；lib/mail.mjs（可选）；client/docs/C5.md（行为、选择器与 debug 字段、compose_to 契约、与 C1a.md 的差异（tab 而不是 full 及理由）、真机待办、已知缺口）；client/demo/ 下的截图与最后一遍完整通过后的 results.json。

# 完成的标准

- 第八节列的每个端到端步骤都已写出并通过，每条断言写清楚在测什么；做不到的逐条写进 notDone 并说明原因，不要悄悄跳过。
- 新增的每个端到端断言都做一次反向验证（临时把实现改坏，确认那一步会红，再改回来），清单写在 70-mail.mjs 末尾的「怎么让它失败」里。至少覆盖：mail.gd 的 on_leave 不清缓存或不递增 _gen（70.95 红）；mail.js 的 reset 不清 textarea 或收信人（70.95 红）；把 atHome 判断改成永远为真（70.4 红：出现了 read_letter 请求）；把未读数改成用 mail 事件里的数字而不是 on_me 的（70.3 或 70.5 红）；让已发箱显示 read 状态（70.3 红）；把正文渲染临时改成非 textContent 的写法（用 el['inner'+'HTML'] 绕开 lint，70.8 红，改回后 lint 与 70.8 都绿）；去掉超长的本地拦截（70.1 红）；不去重 letter.id（翻页或重读后行数重复，70.3 或 70.5 红）；去掉 data-full 设置（70.85 红）；写信期间把草稿写进 sessionStorage（70.1 的存储扫描红）。做不出红灯的如实记录。
- 负向断言（没有 read_letter 请求、没有 send_letter 请求、DOM 里没有正文、已发箱没有 read 字段、换人后没有上一位的信）必须有屏障：先等一个在它之后才会出现的可观察事件（对应的 Godot lastAck、某一行渲染出来、新居民 /letters 响应返回、渲染帧数），再断言「没有」，并在可能时用服务器的真相佐证。
- 旧的端到端步骤（1 到 15、20 到 29 以及将并入的其它号段、全程检查 99）一个断言都不能放宽、删除或跳过；本段不改 main.gd、hud.js、shell.html、hud.css、export.sh、client-e2e.mjs、feature.gd、hub.gd、manifest.gd、dock.js、dock.css、00-chatkit.*，ctx.gd 只动 C5 分区（用 git diff --stat 在汇报里列出本段改动的文件，逐个说明）。
- 隐私清单自查并在汇报里逐条回答：没有 innerHTML 等；没有任何存储读写；换人清空；debug 对象不含信的文字；toast 与角标不含寄信人和内容；全程检查零控制台错误、零 CSP 违规，声明过的 4xx 与控制台行数相等。
- 观感：按第六节自查截图（桌面白天、桌面傍晚、手机竖屏、手机键盘弹起各一张），面板和街景放在一起要协调，文字清楚，不挡住走路的角色；给出路径。手机四个按钮在 390 宽和 360 宽下都不溢出、不被盖住（360 宽用一次临时的 viewport 检查，不入库）。
- 结束前这些都要通过（都用 flock 包着跑）：${CHECKS}。有不通过的，查到根因修掉；确实不是你这段引起的，要拿出证据（在 baseCommit 上同样失败）。
- client/docs/C5.md 写完；真机待办（iOS Safari 与 Android Chrome 的 textarea 与软键盘、输入法组字中的 Ctrl+Enter、微信 X5 内核对 data-full 与 vvh 的表现、长信滚动与选中复制）如实列出，不能凭无头 e2e 声称通过。
- 在工作树分支上本地提交（可以多次提交）。验收截图（70-*.jpg）只在最后一遍完整通过后提交一次；不提交 client/demo/results.json 和 docs/PROGRESS.md（跨段约定第 4 条）。
- 跨段约定（brief 开头那一节）逐条遵守，汇报里逐条回答：基线核对结果、页签 / 钩子 / 访问器 / 角标口径是否与约定一致、有没有为了绕开约定而做的变通。

# 检查命令

`flock /tmp/town-heavy.lock npm run typecheck`、`flock /tmp/town-heavy.lock npm test`（本段不该影响它们，各跑一次确认；若改了 packages/ 则必须跑）、`flock /tmp/town-heavy.lock npm run docs`（之后 git status 无多余差异）、`flock /tmp/town-heavy.lock npm run client:lint`、`flock /tmp/town-heavy.lock npm run client:export`（改了 GDScript 必须完整导出；只改了 web/mod 下的网页文件时开发中可用 `bash client/tools/web-only.sh` 快速重装，但最后一遍必须完整导出）、`flock /tmp/town-heavy.lock npx tsx scripts/client-e2e.mjs --only=mail --no-shots`（开发中跑本段子集；也可 --only=70）、`flock /tmp/town-heavy.lock npm run client:e2e`（完整一遍，约 12 到 15 分钟，最多跑两三遍，最后一遍写 client/demo/）

# 核实办法

在工作树里验证：导出产物已经在 client/town/build/web 里，除非要验证的正是导出，否则不要重新导出；只改了网页层时用 `bash client/tools/web-only.sh` 重装。浏览器端到端子集：`flock /tmp/town-heavy.lock npx tsx scripts/client-e2e.mjs --only=mail --no-shots`（信的投递要等约 60 秒，整个文件约 3 到 5 分钟）。静态检查：`npm run client:lint`。纯逻辑问题（未读数来源、atHome 判断、_gen 丢弃在途响应、请求号复用、错误表）读 mail.gd 与 mail.js 给出确定的推导也算证据，并对照 packages/engine/src/world/mail.ts、http.ts、service.ts command。需要自己跑浏览器时，写一个临时 Playwright 脚本放在工作树 scripts/ 下、文件名以 _tmp_verify_ 开头，同样用 flock 跑，跑完必须删掉，不要提交。反向验证抽查两三处：按 70-mail.mjs 末尾的清单临时破坏实现，确认指定子步骤变红，再还原。

# 评审角度

## 评审角度 privacy-lifecycle：私密内容、生命周期与重入

信是别人拿不到的私密内容，找真泄露和残留。逐项查并给出具体操作步骤与错误结果：1) 搜 mail.js、mail.gd、mail.html 里的 innerHTML、outerHTML、insertAdjacentHTML、document.write、eval、new Function、模板字符串拼 HTML，以及 localStorage、sessionStorage、indexedDB、document.cookie、location.hash、history.pushState、console.log，信的正文、名字、草稿有没有走到这些地方；window.__dock.mail 和 window.__town.features.mail 的 debug 对象里有没有信的文字。2) 换人登录与离开小镇：A 用户的信箱打开着、读信视图里有正文、写信视图里有草稿和已选收信人、/letters 请求在途（或 read_letter、send_letter 在途），此时 _relogin 或离开，新用户登录后 DOM、textarea.value、收信人小牌、居民名单缓存、Godot 数组里还剩什么；在途响应回来时是否被 _gen 丢弃（尤其 on_me 在 on_enter 之前、被调到的还是上一个人时，_owner 对比是否真的清了）；共用设备上 dock 记住的最后页签是信箱时，新用户一登录会不会闪出上一个人的内容。3) 重入：Godot 调 JS 是同步的，feed('list')、feed('read') 在 JS 里又 emit 回 Godot 的路径有没有同步递归；一次 mail 事件风暴（连续 5 封信）会不会触发 5 次重读；
on_hello、on_resync、on_event 同时触发重读时，翻页的 next 游标和去重是否会丢信或重复信；断线重连后未读数是否仍来自 on_me。4) 没读过的信在没回家前正文有没有任何渠道出现在网页里；已发箱有没有任何地方显示、暗示或可推断「对方已读」（含 aria 文字、class 名、debug 字段）；toast 和角标有没有带寄信人或内容。5) 请求号复用：net_fail 后用户改了正文再点寄出，是否错误地带了旧请求号（服务器会返回 request_conflict）；原样重发是否真的不会寄两封；多次点寄出的重复点击。

## 评审角度 rules-flow：规则一致性、状态与错误提示

对照 packages/engine/src/world/mail.ts、http.ts、service.ts command 和 views.ts，找客户端行为与服务器规则不一致、或状态走错的真问题，给出具体步骤与错误结果：1) atHome 判断：是否严格等于 location.space == me.home.id；在别人家做客、在自家门口（会馆）、刚到家 on_me 还没刷新、被邀请期满送出门口这几种情形下，拆信按钮的可用性对不对，服务器返回 not_home 后界面是否恢复（不卡在「拆开中」）并 refresh_me。2) 未读数来源与时机：角标是否只来自 on_me 的 mail.unread；读信后立即减一是用回执的 mail 还是等 on_me，会不会出现闪回旧值；toast 的「未读数增加」判定在登录基线、换人、重连补发、同时一封读一封到这些情况下会不会误弹或漏弹；打开面板不清零这一点是否与 C1a 的聊天未读（打开即清零）在角标里混算得合理，aria-label「n 条未读」是否仍成立。3) 对局中（ctx.in_game）、只读（control_mine 假）、离线时的禁用：寄出、拆信、回家各自对不对；已读信重读是否仍然可用；服务器的 in_activity、control_lost 回来时的提示是否与错误表一致。4) 长度：按码点计数含表情、含换行、含全角字符；本地上限与服务器 sanitize 后的长度是否可能出现「本地放行、服务器静默截断」（比如正文里有被 sanitize 去掉或改写的字符，或首尾空白）；字数恰好等于上限、上限加一的两种边界。5) 分页：next 游标、「载入更多」、重复信去重、新信到达时在翻页中间会不会漏或重；
已发箱 10 秒重读在面板关着或切到别的页签时是否停止，不会空耗 HTTP 限流（每 IP 每分钟 240）。6) 回信与 compose_to：收信人预选后用户又点叉换人、名单还没加载完时点寄出、收信人在 compose_to 之后已不在名单里，各会怎样；寄给 AI 居民的提示。7) 邀请：勾选与不勾选分别发出什么 action（invite 字段形状），读信后便签显示的 active/过期是否随时间变化而更新或至少不误导。

## 评审角度 mobile-visual-e2e：手机、布局、观感与端到端质量

1) 手机与布局：看实现者给的截图并自己按需起一遍；信箱页签激活时的放大面板在 390x844、360x640、横屏 844x390 下：#bottombar（停下、回家、地点、聊天）会不会被抬到撞上 #topbar 或被盖住；写信时软键盘弹起（真机的 visualViewport 行为用 TownDock.test.setKeyboard 模拟，注意模拟不等于真机）textarea、字数、寄出是否都可见；data-full 属性在切页签、关面板、离开小镇、phase 变化、visibilitychange 时是否可能残留，导致「附近」页签也变成放大尺寸；mail.css 的选择器特异性与加载顺序是否真的压过 dock.css 的抽屉与键盘规则；页签条在多个页签（附近、公屏、活动、信箱）下 340 像素宽是否装得下「信箱」；iOS 上 textarea 是否 16px、是否能选中复制、长信滚动是否被画布吃掉触摸；点列表、点按钮会不会穿透成点地走路。2) 键盘：textarea 里 WASD、方向键、E 不得进游戏；Enter 换行，Ctrl/Cmd+Enter 寄出，输入法组字中不触发；Esc 先失焦再关面板；底座的全局 Enter 打开面板时焦点落到信箱页签的哪里（列表视图没有输入框时不能出错，也不能把焦点丢进被隐藏的元素）。3) 观感：是否符合美术方向（纸、木牌、信封、火漆，米白木棕灰蓝柔和绿少量暖橙），像镇上的东西而不是后台列表；未读与已读区分是否清楚且不只靠颜色；文字对比度、最小字号；与街景（白天、傍晚）并排是否协调、是否挡住走路的角色。
4) 端到端质量：70-mail.mjs 是不是真的在测（有没有只断言「不报错」）、负向断言有没有屏障、有没有固定 sleep 或依赖随机编号、60 秒投递等待在全量跑与单跑时是否稳定（机器负载大时「尚未送到」的前置断言会不会误报）、全量跑时前面步骤留下的居民会不会污染收信人名单搜索、allowFailure 次数与实际 4xx 是否相等、release 清场是否可靠、旧步骤有没有被改弱；设计文档第 17 章试玩里与信件有关的部分是否有真实断言；抽两三处实现者说做过反向验证的断言自己再验一次。5) 文档：client/docs/C5.md 与代码一致（选择器、debug 字段、compose_to、与 C1a.md 的 tab/full 差异）。 另外对照 brief 开头的「跨段约定」逐条核对本段有没有越界或与别段打架：页签与角标口径、on_pick / blocks_input / actions / tags 的归属、ctx.gd 分区与函数名、CSS 选择器作用域、API 代发请求的声明方式、results.json 与 PROGRESS.md 不提交。

