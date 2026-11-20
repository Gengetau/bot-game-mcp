# 灯都第 1 道闸门手册：引擎上灯都 + 栖灯镇封存

看板 #286（笺写，妮娅审）。第 3 版：按妮娅 11-20 08:04 的复审修改（停机前只暂存、旧文件先备份；按「已动清单」回滚，bridge.py 换过就还原；加城市就绪探针 P8；P7 补两个故障点）。
第 2 版按 00:27 的退回改过：回滚不还原数据、探针、只重建 agent 服务、三项专项核对。
依据：设计稿 v0.3 第 9.2、9.3 节；引擎 main 上的 `docs/city/M1-ROLLOUT-AND-ROLLBACK-PACK.md`；`bot-game-live/DEPLOY-NOTES.md` 里的切换办法。
本手册只是准备，**线上一步都没动**。执行要主人对第 1 闸单独点头。

## 0. 这道闸门做什么、不做什么

- 做：引擎换成 main 的新版本，`/city/` 对外打开，栖灯镇封存（`/town/` 返回 404，town.db 原样保留），裁判加 `--city`，六人 bridge 里的小镇工具在同一闸门内处理。
- 不做：不发内核桥接密钥（`city.bridgeKey` 不写，桥接路由不挂载）、`city.allowedAgents` 先空、内核一行不动（城市开关全 0）、不切 K8 目录、不开 K9 天气接入、不轮换任何密钥。
- 所以第 1 闸过后灯都是空的：能看公开页面，AI 还进不去。六人进城靠第 2 闸（内核桥接）。外来 bot 用它们现有的游戏引擎凭据 + `city.allowedAgents` 名单进城，**不发内核桥接密钥**；名单可随第 1 闸一起写，也可以之后单独改配置重启。

## 1. 上线前必须都成立（不成立就不问主人）

| # | 条件 | 现在 |
|---|---|---|
| P1 | 线上未提交的颜色接龙修复已进引擎 main（#284 / PR #71） | 待独立审，再等主人「合并」 |
| P2 | 引擎 main 构建、全量测试、`test/city` 全过 | #279 联合测试已过；部署那个提交要再跑一次 |
| P3 | 隔离演练（独立端口、临时目录、所有可写路径都是副本，不连 QQ）：用 `VACUUM INTO` 抄线上 town.db，新引擎按本手册的新配置起来，第 4 节每一项都有结果 | 未做 |
| P4 | 六人 bridge.py 的改动（第 3 节第 4 步）在暂存区写好、隔离测试过、妮娅审过 | 未做 |
| P5 | 给外部主人的灯都版说明（#285） | 排在 #263 后 |
| P6 | 切换脚本 `bot-game-runtime/deploy-town/switch-city.sh`：停起照 `switch-b196a29.sh` 用 `systemctl --user`，但**删掉自动还原 `town/`、`state/` 和任何密钥轮换**（见第 5 节）；`DRY=1` 预检通过 | 未做 |
| P7 | 回滚演练（隔离环境，第 4 节末尾列了做法）：①新配置下引擎起不来；②切换后探针失败（含就绪探针 503），还没换 bridge.py、没重建 agent；③bridge.py 已换、重建 0 个时失败；④六人容器只重建了一部分时失败；外加一级、二级。每条都核对：代码目录、配置、`referee.argv`、bridge.py 的 SHA-256 回到备份清单里的值，`/town/` 恢复 200，数据原样保留 | 未做 |
| P8 | 城市就绪探针：引擎加只读接口 `GET /city/api/ready`，城市 `status` 为 `running` 时 200，`recovering`、`degraded`、`closed` 时 503，只返回状态字，不带数据、不要凭据。现在没有任何接口能看出这个状态：`/city/api/public` 只读快照（`city/http.ts:345` 不查状态），启动恢复失败会被 `city/service.ts:609` 吞掉、城市停在 recovering，`server/runtime.ts:107` 的「已就绪」日志照打，签票这类写操作才在 `city/residents.ts:155` 被拒。单独开单实现、妮娅审、主人「合并」 | 未做 |

## 2. 要主人定的（第 1 闸那次一起问）

1. **批准第 1 闸**：引擎上灯都，封存栖灯镇。
2. **六人小镇工具怎么处理**（推荐 a）：
   a. 同一闸门里从 `GAME_TOOLS` 摘掉 8 个世界工具：`enter_world`、`leave_world`、`world_query`、`world_act`、`heartbeat`、`town_outbox`、`claim_control`、`world_wait`。桌游工具（`whoami`、`list_games`、`join_game`、`speak`、`act` 等）全部保留。封镇后这 8 个只会报错；六人进城走第 2 闸的内核桥接，第 5 闸（K12）到时只需核对。
   b. 先留着。六人可能用它们以外来身份直接进城，绕过内核的钱包和出门交接，不推荐。
3. **真人进城票**：`city.adminOnlyTickets` 设 true（只有主人能签真人票，推荐内测期用）还是 false（群里说「进城」就私聊发票）。
4. **外来名单**：栖灯镇现在放行 10 个身份（小屋 6 个 + 外来 4 个）。那 4 位外来 bot 是否原样进灯都名单，是否这次就写进去。
5. **回滚范围**：出问题时只回滚代码、配置、服务（第 5 节），数据库不自动还原；要还原数据另外问主人。

## 3. 执行步骤（主人批准后按顺序）

1. **预检**：`DRY=1 switch-city.sh`：没有报名中或进行中的公共对局，镇上没有小游戏、没有人在场。不满足就等，不硬切。
   原则：**停机前只备份和暂存，线上文件一个都不改**；真正替换全在第 6 步脚本里做，每替换一项就记进「已动清单」，回滚按清单逐项还原。
2. **备份**（任何文件改动之前），目录 `bot-game-live/backup-pre-city-<sha>-<日期>/`（权限 700）：
   - 原样复制 `botgame.config.json`、`referee.argv`，`official-persona-agent/bridge.py` 和 6 个 `*-cc/compose.override.yaml` 抄到 `mcp/_backups/city-gate1-<日期>/`。
   - 每个文件的 SHA-256 写进备份目录的 `MANIFEST.sha256`；后面所有「核对原状」都以这份清单为准。
   - town.db 在线快照（`VACUUM INTO`），记 SHA-256。
   - 内核 life1.db、world.db 只读快照，记 SHA-256（第 1 闸不碰内核，留作后面几闸的基线）。
   - 停机后脚本再抄一份 `town.at-switch/`、`state.at-switch/`，只用于事后核对或主人另外批准的数据还原，脚本不会自动拿它们覆盖。
3. **新代码目录**：克隆 main 的部署提交到 `bot-game-mcp.new`，`npm ci`、`npm run build`（含城市前端静态资源），日志写 `logs/build-city.log`。旧目录此时不动，切换时才改名为 `bot-game-mcp.old-05d88b3`（回滚要用，不删）。
4. **暂存 bridge 改动**：按第 2 节的决定写 `official-persona-agent/bridge.py.city`（只动第 439–444 行的 `GAME_TOOLS`），记 SHA-256。线上 `bridge.py` 这一步不动；要到第 8 步、引擎验证全部通过后才换。
5. **暂存配置**（只列键，值不写进任何日志）：写 `botgame.config.json.city` 和 `referee.argv.city`（权限 600），用新引擎的 `loadConfig` 校验通过。线上的 `botgame.config.json`、`referee.argv` 这一步不动。
   - `town.enabled=false`，town 块其余不动。
   - 新增 `city`：`enabled=true`、`dbFile=bot-game-live/city/city.db`、`publicUrl=https://oracle-tokyo.tail8c4463.ts.net:10000/city/play/`、`devLogin=false`、`adminOnlyTickets`（按第 2 节）、`weather=true`、`allowedAgents=[]`（或主人给的名单）、`house`（6 位，各自 QQ 号），**不写 bridgeKey**。
   - 核对环境覆盖（只看键名，不输出值）：`config.ts` 会用 `BOTGAME_TOWN*`、`BOTGAME_CITY*`（含 `BOTGAME_CITY_BRIDGE_KEY`）覆盖配置文件。11-20 只读核对时引擎单元文件里没有这些键；执行前在实际生效的单元和 `systemctl --user show-environment` 里再核一遍。
   - `referee.argv.city` = 原 `referee.argv` 末尾加 `--city`。
6. **切换**（在 `systemd-run --user --unit=… --collect` 里跑脚本；脚本把「已动清单」写进备份目录的 `switch-state.json`，每做一项先记再做）：
   - 构建完成后、停服务之前，**紧贴着再验一次**：没有新开的公共对局、镇上没有人和小游戏。有就等，不硬切。
   - `systemctl --user stop botgame-referee.service`，再 stop `botgame-engine.service`；抄 `town.at-switch/`、`state.at-switch/`。
   - 依次：记 `code` 后换目录；记 `config` 后用 `.city` 暂存件替换配置；记 `argv` 后替换 `referee.argv`。
   - `start --no-block botgame-engine.service`，限时 60 秒等 `/health` 200；再限时 120 秒每 2 秒问一次 `/city/api/ready`（每次 `--max-time 3`），要拿到 200 且状态是 `running`，之后 30 秒内再连问 3 次都还是 `running` 才算就绪；然后 `start --no-block botgame-referee.service`，跑第 7 步的探针。
   - 不用 nohup，不按 pid kill。任何一步失败，脚本按第 5 节「切换阶段自动回滚」按清单还原，不碰数据。这一阶段 bridge.py 和六人容器一律不动。
7. **验证**：
   - `/health` 200（只当存活探针；它没有城市或小镇的开关字段）。
   - `/city/api/ready` 200 且 `running`（P8；这是城市就绪的唯一判据）。`/city/api/public` 200 只说明快照可读，单独不算通过。
   - 本机和经 Funnel（:10000 整站反代到 18790，网络不用改）：`/town/` 404；`/city/`、`/city/play/` 200；`/city/api/public` 200。
   - `/city/bridge/v1/reconcile` 返回 404（没写桥接密钥时整条桥接路由不挂载；如果是 401，说明挂上了，要停下来查）。
   - town.db 的 SHA-256 与停服务后的快照一致（关镇时引擎不打开 town.db）。
   - `list_games` 正常，公共桌游能建局。
   - 引擎日志没有报错；裁判重新连上 OneBot 和引擎；city.db 已生成。
8. **换 bridge.py 和六人容器**（第 7 步全部通过后才做）：
   - 记 `bridge` 后用改名把 `bridge.py.city` 换成 `official-persona-agent/bridge.py`（`mv`，会换 inode），核 SHA-256。六个容器都是单文件挂载这份文件（`/srv/bridge.py:ro`），按 inode 绑定：没重建的容器里看到的仍是原文件，已在跑的 agent 进程里也还是旧代码；但它们下次重启或重建就会读到新文件，所以从这一刻起，回滚必须还原 bridge.py，哪怕一个都还没重建。
   - 逐个进 `ai-house-cc`、`claire-cc`、`alicia-cc`、`grok-cc`、`xingli-cc`、`whale-cc`，先核对服务名，只重建 agent：`docker compose up -d --no-deps --force-recreate agent`。`claire-cc` 和 `xingli-cc` 还有独立的 QQ `bridge` 服务，**不能重建**，否则会断开它们的 QQ 连接。每重建一个，先把它的名字记进清单的 `rebuilt`，再重建；起来后核对：容器 Up、容器内 bridge.py 的 SHA-256 等于新文件、没有 Traceback，再做下一个。正在回复或在对局中的先等。任何一个失败，按第 5 节「bridge 阶段回滚」处理。
9. **通知外部主人**：由主人发灯都版说明（#285）。说明里不放任何密钥。
10. **记录**：`DEPLOY-NOTES.md` 写一节（上了什么、步骤、验证过的、没验证的、回滚），看板 #286 贴回执，报主人。

## 4. 隔离演练里要有结果的（P3）

- `town.enabled=false` 时 town.db 不被打开、不被写（`server/runtime.ts` 关镇时不开库；演练前后 SHA-256 一致）。
- 不写 bridgeKey 时 `/city/bridge/v1/*` 是 404（`city/http.ts` 没有密钥就不挂载桥接路由）；同时确认没有 `BOTGAME_CITY_BRIDGE_KEY` 之类的环境变量把密钥带进来。
- `/health` 200、`/city/api/ready` 200 且 `running`、`/town/` 404、`/city/api/public` 200，公共桌游能列出、能建局。
- **只读 200 不算通过**：演练里让城市写不进去（演练目录里的 city.db 副本设成只读，或让启动恢复事务抛错），确认此时 `/city/api/public` 仍是 200，而 `/city/api/ready` 在限时内一直是 503（`recovering` 或 `degraded`），切换脚本判为失败并走自动回滚。全程不签票、不开桥接。
- `city.weather=true` 时取不到现实天气也不影响启动。
- 城市账本是空的、对账 ok；旧镇金币不兑换城市日元（设计稿已定）。
- 六人 bridge 改动：8 个世界工具调用被拒，桌游工具照常。
- 回滚演练（P7），每条结束都核：代码目录、配置、`referee.argv`、bridge.py 的 SHA-256 等于 `MANIFEST.sha256`；`/town/` 200、镇能进；town.db、state 没被回滚覆盖：
  ①在暂存配置里放一个让新引擎起不来的值 → 切换阶段自动回滚，bridge.py 未动；
  ②城市就绪探针 503（同上，只读 city.db 副本）→ 切换阶段自动回滚，bridge.py 未动、没有容器被重建；
  ③bridge.py 已换、重建 0 个时中止 → bridge.py 还原，容器内仍是原文件，不重建任何容器；
  ④重建到第 2 个时失败 → bridge.py 还原，只重建清单里那 2 个，容器内 SHA-256 回到原值，其余 4 个不动；
  另跑一级、二级。演练用的容器是隔离副本，不连 QQ。

## 5. 回滚（只回滚已经动过的代码、配置、服务，数据不自动还原）

- **按「已动清单」回滚**：`switch-state.json` 里记了哪几项真的换过，就只还原那几项，按相反顺序；没记的不碰。每项还原后核 SHA-256 等于 `MANIFEST.sha256`。不还原 `town/`、`state/`，不轮换、不换回任何密钥。旧模板 `switch-b196a29.sh` 里「新引擎起过就自动换回 town/ 和 state/」的那段要删掉，否则切换后新开的局或新发的记录会被覆盖。
- **切换阶段自动回滚**（第 6、7 步失败）：停裁判、停引擎；清单里有 `argv` 就换回 `referee.argv`，有 `config` 就换回配置，有 `code` 就把新目录改名 `bot-game-mcp.failed-<sha>`、旧目录改回；起引擎、等 `/health` 200、确认 `/town/` 200、起裁判。这一阶段 bridge.py 没换过，核一下它的 SHA-256 仍是原值。
- **bridge 阶段回滚**（第 8 步失败，含重建 0 个）：清单里有 `bridge` 就换回 bridge.py，核 SHA-256；只对 `rebuilt` 里的容器逐个 `docker compose up -d --no-deps --force-recreate agent`，核容器内 SHA-256 回到原值；没重建过的不动（核一下它们容器内仍是原值）。引擎留在灯都，8 个小镇工具报错但无害；要不要再做一级或二级回滚，报主人。
- **一级（城市有问题，引擎本身没事）**：配置和 `referee.argv` 从备份换回（等于 `town.enabled=true`、没有 city 块、没有 `--city`），按第 3 节第 6 步的办法重启。栖灯镇原样回来，city.db 原地保留不删。清单里有 `bridge` 的，同时按上一条还原 bridge.py 和已重建的容器，让六人的小镇工具回来。
- **二级（新代码有问题）**：停裁判、停引擎；`bot-game-mcp` 改名 `bot-game-mcp.failed-<sha>`，`bot-game-mcp.old-05d88b3` 改回 `bot-game-mcp`；从备份目录换回配置和 `referee.argv`；起引擎、等 `/health` 200、起裁判。bridge.py 同一级。
- 六人容器回滚一律只碰 `agent` 服务，不碰 claire-cc、xingli-cc 的 QQ `bridge` 服务。
- **数据还原**：`town/`、`state/` 只在怀疑新版本写坏数据时才还原，而且先问主人（还原会丢掉切换之后的变化）。
- 回滚不碰内核，因为第 1 闸没动内核。

## 6. 哪一步要主人点头

- 第 2 节五件事：要。
- 第 1 节准备（P1–P8）：不要；P1 和 P8 合进 main 要主人一句「合并」。
- 第 3 节执行：主人批准第 1 闸后照单执行，中途不再逐步问；遇到手册外的情况就停下来问。
- 第 5 节回滚：切换阶段自动回滚、bridge 阶段回滚、一级、二级可以直接做（恢复原状），做完报主人；还原数据要先问。
