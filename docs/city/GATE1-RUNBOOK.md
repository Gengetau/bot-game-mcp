# 灯都第 1 道闸门手册：引擎上灯都 + 栖灯镇封存

看板 #286（笺写，妮娅审）。第 2 版：按妮娅 11-20 00:27 的退回修改（回滚不还原数据、探针、只重建 agent 服务、三项专项核对）。
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
| P7 | 回滚演练（隔离环境）：一级、二级、六人容器只重建了一部分时失败，三条路都证明只回滚已动的代码、配置、服务，数据原样保留 | 未做 |

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
2. **备份**，目录 `bot-game-live/backup-pre-city-<sha>-<日期>/`（权限 700）：
   - 引擎停之前：town.db 在线快照（`VACUUM INTO`），记 SHA-256。
   - 引擎停之后：`town.at-switch/`、`state.at-switch/`、`botgame.config.json`、`referee.argv`。这些只用于事后核对或主人另外批准的数据还原，脚本不会自动拿它们覆盖。
   - 内核 life1.db、world.db 只读快照，记 SHA-256（第 1 闸不碰内核，留作后面几闸的基线）。
   - `official-persona-agent/bridge.py` 和 6 个 `*-cc/compose.override.yaml` 抄到 `mcp/_backups/city-gate1-<日期>/`。
3. **新代码目录**：克隆 main 的部署提交到 `bot-game-mcp.new`，`npm ci`、`npm run build`（含城市前端静态资源），日志写 `logs/build-city.log`。旧目录切换时改名为 `bot-game-mcp.old-05d88b3`（回滚要用，不删）。
4. **bridge 改动**：按第 2 节的决定改 `official-persona-agent/bridge.py`（只动第 439–444 行的 `GAME_TOOLS`），记改后 SHA-256。
5. **配置**（只列键，值不写进任何日志）：先写临时文件，用新引擎的 `loadConfig` 校验通过后整份替换，权限保持 600。
   - `town.enabled=false`，town 块其余不动。
   - 新增 `city`：`enabled=true`、`dbFile=bot-game-live/city/city.db`、`publicUrl=https://oracle-tokyo.tail8c4463.ts.net:10000/city/play/`、`devLogin=false`、`adminOnlyTickets`（按第 2 节）、`weather=true`、`allowedAgents=[]`（或主人给的名单）、`house`（6 位，各自 QQ 号），**不写 bridgeKey**。
   - 核对环境覆盖（只看键名，不输出值）：`config.ts` 会用 `BOTGAME_TOWN*`、`BOTGAME_CITY*`（含 `BOTGAME_CITY_BRIDGE_KEY`）覆盖配置文件。11-20 只读核对时引擎单元文件里没有这些键；执行前在实际生效的单元和 `systemctl --user show-environment` 里再核一遍。
   - `referee.argv` 末尾加 `--city`。
6. **切换**（在 `systemd-run --user --unit=… --collect` 里跑脚本）：
   - 构建完成后、停服务之前，**紧贴着再验一次**：没有新开的公共对局、镇上没有人和小游戏。有就等，不硬切。
   - `systemctl --user stop botgame-referee.service`，再 stop `botgame-engine.service`。
   - 换目录、换配置。
   - `start --no-block botgame-engine.service`，限时等 `/health` 200，再 `start --no-block botgame-referee.service`。
   - 不用 nohup，不按 pid kill。任何一步失败，脚本按第 5 节自动回滚代码、配置和服务，不碰数据。
7. **验证**：
   - `/health` 200（只当存活探针；它没有城市或小镇的开关字段）。
   - 本机和经 Funnel（:10000 整站反代到 18790，网络不用改）：`/town/` 404；`/city/`、`/city/play/` 200；`/city/api/public` 200 且返回城市公开视图（证明城市 API 真起来了，不只是静态页）。
   - `/city/bridge/v1/reconcile` 返回 404（没写桥接密钥时整条桥接路由不挂载；如果是 401，说明挂上了，要停下来查）。
   - town.db 的 SHA-256 与停服务后的快照一致（关镇时引擎不打开 town.db）。
   - `list_games` 正常，公共桌游能建局。
   - 引擎日志没有报错；裁判重新连上 OneBot 和引擎；city.db 已生成。
8. **六人容器**：逐个进 `ai-house-cc`、`claire-cc`、`alicia-cc`、`grok-cc`、`xingli-cc`、`whale-cc`，先核对服务名，只重建 agent：`docker compose up -d --no-deps --force-recreate agent`。`claire-cc` 和 `xingli-cc` 还有独立的 QQ `bridge` 服务，**不能重建**，否则会断开它们的 QQ 连接。每个起来后核对：容器 Up、容器内 bridge.py 的 SHA-256 对得上、没有 Traceback，再做下一个。正在回复或在对局中的先等。
9. **通知外部主人**：由主人发灯都版说明（#285）。说明里不放任何密钥。
10. **记录**：`DEPLOY-NOTES.md` 写一节（上了什么、步骤、验证过的、没验证的、回滚），看板 #286 贴回执，报主人。

## 4. 隔离演练里要有结果的（P3）

- `town.enabled=false` 时 town.db 不被打开、不被写（`server/runtime.ts` 关镇时不开库；演练前后 SHA-256 一致）。
- 不写 bridgeKey 时 `/city/bridge/v1/*` 是 404（`city/http.ts` 没有密钥就不挂载桥接路由）；同时确认没有 `BOTGAME_CITY_BRIDGE_KEY` 之类的环境变量把密钥带进来。
- `/health` 200、`/town/` 404、`/city/api/public` 200，公共桌游能列出、能建局。
- `city.weather=true` 时取不到现实天气也不影响启动。
- 城市账本是空的、对账 ok；旧镇金币不兑换城市日元（设计稿已定）。
- 六人 bridge 改动：8 个世界工具调用被拒，桌游工具照常。

## 5. 回滚（只回滚已经动过的代码、配置、服务，数据不自动还原）

- **脚本自动回滚**：只做三件事：换回代码目录、换回配置和 `referee.argv`、按 systemd 停起服务。不还原 `town/`、`state/`，不轮换、不换回任何密钥。旧模板 `switch-b196a29.sh` 里「新引擎起过就自动换回 town/ 和 state/」的那段要删掉，否则切换后新开的局或新发的记录会被覆盖。
- **一级（城市有问题，引擎本身没事）**：配置改回 `city.enabled=false`、`town.enabled=true`，去掉 `--city`，按第 3 节第 6 步的办法重启。栖灯镇原样回来，city.db 原地保留不删。
- **二级（新代码有问题）**：停裁判、停引擎；`bot-game-mcp` 改名 `bot-game-mcp.failed-<sha>`，`bot-game-mcp.old-05d88b3` 改回 `bot-game-mcp`；从备份目录换回配置和 `referee.argv`；起引擎、等 `/health` 200、起裁判。
- **六人容器（含只重建了一部分时失败）**：从 `mcp/_backups/city-gate1-<日期>/` 换回 bridge.py，对已经重建过的那几个逐个 `docker compose up -d --no-deps --force-recreate agent`，不碰 QQ `bridge` 服务。
- **数据还原**：`town/`、`state/` 只在怀疑新版本写坏数据时才还原，而且先问主人（还原会丢掉切换之后的变化）。
- 回滚不碰内核，因为第 1 闸没动内核。

## 6. 哪一步要主人点头

- 第 2 节五件事：要。
- 第 1 节准备（P1–P7）：不要；P1 合进 main 要主人一句「合并」。
- 第 3 节执行：主人批准第 1 闸后照单执行，中途不再逐步问；遇到手册外的情况就停下来问。
- 第 5 节回滚：脚本自动回滚、一级、二级、六人容器回滚可以直接做（恢复原状），做完报主人；还原数据要先问。
