# 新步骤文件（栖灯镇三维客户端端到端）

旧的 1 到 15 步和最后的全程检查（99）都在 `scripts/client-e2e.mjs` 里，原样不动。新功能的步骤各写一个文件放在这里，由 `client-e2e.mjs` 在步骤 15 之后、全程检查之前依次运行。

## 号段

| 号段 | 归属 |
|---|---|
| 1 到 15 | 旧步骤（client-e2e.mjs） |
| 20 到 29 | C1a 面板底座与附近聊天 |
| 30 到 39 | C1b 全镇公屏与头顶气泡 |
| 40 到 49 | C2 共同活动 |
| 50 到 59 | C3 入座玩小游戏 |
| 60 到 69 | C4 点人、居民卡、邀请、入户 |
| 70 到 79 | C5 信箱 |
| 80 到 89 | C6 NPC 与服务菜单 |
| 90 到 98 | C7 手机互动按钮、连接提示、离开小镇、整条试玩 |
| 99 | 全程检查（旧） |

`meta.id` 和 `meta.n` 全局唯一，重复会在启动时直接抛错。

## 文件形状

```js
export const meta = { id: 'chat-nearby', n: 20, title: '附近聊天面板' };
export default async function run(h) {
  const { A, B } = await h.pair();      // 桌面 1440x900（A）+ 手机 390x844 触摸（B），都带 wsGate，名字随机，已登录并互相看见
  await h.step(20, '……', async () => { ... });
  await h.step(20.1, '……', async () => { ... });
  await h.release(A);                   // 离开小镇并关页面；它的监视记录仍进最后的全程检查
  await h.release(B);
}
```

`h` 是 `client-e2e.mjs` 转发出来的工具集：`step until sleep check note shot allowFailure newPlayer login serverScene snap clickWorld walkTo rnd browsers selfActor dist project viewport seen clearSpot assertClock polyAt normPts BASE NO_SHOTS townParams pair release`。

`h.townParams` 是端到端起引擎时传给 `town.params` 的开服参数（冻结对象，表和理由在 `client-e2e.mjs` 的 `TOWN_PARAMS` 上面）：`interactionTimeScale`（共同活动时长缩放，0.075：十分钟的活动约 45 秒、五分钟的约 23 秒）、`letterDeliveryDelayMs`（信件送达延迟 4 秒）、`activityLobbyTtlMs`（报名阶段最长保留 25 秒）。步骤按它算等待：例如共同活动结束前最多等 `600 * 1000 * h.townParams.interactionTimeScale` 毫秒再加余量；「到时自动散」最多等 `h.townParams.activityLobbyTtlMs` 加余量；断言「还没到」时要先算好离到期还剩多少、别写死秒数。凑桌类步骤必须在 `activityLobbyTtlMs` 内完成「开桌 + 加入」。

- 公共小工具在 `scripts/e2e/lib/`：`ui.mjs`（面板开关与状态、Enter 打开、命中测试）、`chat.mjs`（发话、读列表、未读、用 API 代发、声明被拒绝的请求）。新增的通用小工具放这里，不要塞进 `client-e2e.mjs`。
- `login(p, name, { query })` 可以在地址后追加参数，例如 `&hour=19.5` 固定傍晚。
- `clickWorld(p, x, z, { avoidDock: true })` 在面板开着时避开面板盖住的区域；`walkTo(p, x, z, tol, opts)` 同样接受。

## 运行

```bash
npx tsx scripts/client-e2e.mjs --list                                  # 列出全部新步骤
npx tsx scripts/client-e2e.mjs --only=chat-nearby --no-shots           # 按 id 单跑一个文件（不先跑前面十几步）
npx tsx scripts/client-e2e.mjs --only=20 --no-shots                    # 按号段单跑（命中 n 到 n+10）
```

命中后整个文件的所有子步骤都运行（文件内的子步骤互相依赖，不支持单跑 `20.3`）。带 `--only` 不会写 `client/demo/`。用 `flock /tmp/town-heavy.lock` 包起来，机器上同一时间只能跑一份软件渲染的 e2e。

## 写法约定

1. 「等什么」一律 `until` 轮询，不用固定 sleep。位置断言沿用旧容差（`T_POS`、`T_CLOCK_MS`）。
2. 负向断言（没有收到、没有走动）要有屏障：先等一个之后才会出现的可观察事件，再断言「没有」。例如：A 听不到 B 说的 X，就让 B 再说一句 Y、等 Y 出现，再断言没有 X；同时用 `GET /history` 的服务端真相佐证。
3. 故意触发服务器规则拒绝（限流 429、超长 400）之前，先 `allowFailure` 声明次数范围；未声明的 4xx 会让全程检查失败。
4. 聊天额度按居民计：突发 3 条，之后每 10 秒回 1 条。「对方发言」那一侧走 `apiSay`，只在测界面发送时才用浏览器；一个子步骤内不要连发超过 3 条，除非就是在测限流。
5. 按住方向键期间不要发聊天、开关面板或做大量 DOM 操作（软件渲染下一次大于 300 毫秒的卡顿就会让角色停一下）。
6. 全量跑时旧步骤留下的居民（步骤 15 的页面、AI 居民）会和新页面同出生点；`runStepFiles` 开头已清场，但仍要用 `until` 等场景里只剩自己人再做「一个人」之类的断言。
7. 截图名以号段打头：`20-desktop-chat-side`。截图是 JPEG（`h.shot` 已处理）。
8. 每个文件末尾写一段「怎么让它失败」的注释：说明临时改动哪里、应当看到哪个子步骤变红。每条新断言都应当做过这样的反向验证。
9. 不要往 `client-e2e.mjs` 里加东西。需要新能力先在 `lib/` 里写；确实有缺口才改 `client-e2e.mjs`，并在说明里写明。
