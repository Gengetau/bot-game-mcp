# 灯都第 1 道闸门手册：引擎上灯都 + 栖灯镇封存

看板 #286（笺写，妮娅审）。依据：设计稿 v0.3 第 9.2、9.3 节；引擎 main 上的 `docs/city/M1-ROLLOUT-AND-ROLLBACK-PACK.md`；`bot-game-live/DEPLOY-NOTES.md` 里的切换办法。
本手册只是准备，**线上一步都没动**。执行要主人对第 1 闸单独点头。

## 0. 这道闸门做什么、不做什么

- 做：引擎换成 main 的新版本，`/city/` 对外打开，栖灯镇封存（`/town/` 返回 404，town.db 原样保留），裁判加 `--city`，六人 bridge 里的小镇工具在同一闸门内处理。
- 不做：不发桥接密钥（`city.bridgeKey` 不写）、`city.allowedAgents` 先空、内核一行不动（城市开关全 0）、不切 K8 目录、不开 K9 天气接入。
- 所以第 1 闸过后灯都是空的：能看公开页面，AI 还进不去。六人进城靠第 2 闸（内核桥接），外来 bot 进城靠把名单写进 `city.allowedAgents`（可随第 1 闸一起，也可以之后单独改配置重启）。

## 1. 上线前必须都成立（不成立就不问主人）

| # | 条件 | 现在 |
|---|---|---|
| P1 | 线上未提交的颜色接龙修复已进引擎 main | #284 进行中 |
| P2 | 引擎 main 构建、全量测试、`test/city` 全过 | #279 联合测试已过；部署那个提交要再跑一次 |
| P3 | 迁移演练：用 `VACUUM INTO` 抄线上 town.db，新引擎在独立端口、临时目录按本手册的新配置起来：`/health`、`/city/` 200，`/town/` 404，city.db 新建，公共桌游能列出、能建局；确认**不写 bridgeKey 时**引擎能起来、桥接接口拒绝访问 | 未做 |
| P4 | 六人 bridge.py 的改动（见第 3 节第 4 步）在暂存区写好、隔离测试过、妮娅审过 | 未做 |
| P5 | 给外部主人的通知稿（#285 的灯都版说明） | #285 排在 #263 后 |
| P6 | 切换脚本 `bot-game-runtime/deploy-town/switch-city.sh`，从 `switch-b196a29.sh` 复制（停起用 `systemctl --user`，带自动回滚），`DRY=1` 预检通过 | 未做 |

## 2. 要主人定的（第 1 闸那次一起问）

1. **批准第 1 闸**：引擎上灯都，封存栖灯镇。
2. **六人小镇工具怎么处理**（推荐 a）：
   a. 同一闸门里从 `GAME_TOOLS` 摘掉 8 个世界工具：`enter_world`、`leave_world`、`world_query`、`world_act`、`heartbeat`、`town_outbox`、`claim_control`、`world_wait`。封镇后这些工具只会报错；六人进城走第 2 闸的内核桥接，第 5 闸（K12）到时只需核对。
   b. 先留着。六人可能用它们以外来身份直接进城，绕过内核的钱包和出门交接，不推荐。
3. **真人进城票**：`city.adminOnlyTickets` 设 true（只有主人能签真人票，推荐内测期用）还是 false（群里说「进城」就私聊发票）。
4. **外来名单**：栖灯镇现在放行 10 个身份（小屋 6 个 + 外来 4 个）。那 4 位外来 bot 是否原样进灯都名单，是否这次就写进去。

## 3. 执行步骤（主人批准后按顺序）

1. **预检**：`DRY=1 switch-city.sh`：没有报名中或进行中的公共对局，镇上没有小游戏、没有人在场。不满足就等，不硬切。
2. **备份**，目录 `bot-game-live/backup-pre-city-<sha>-<日期>/`（权限 700）：
   - 引擎停之前：town.db 在线快照（`VACUUM INTO`），记 SHA-256。
   - 引擎停之后：`town.at-switch/`、`state.at-switch/`、`botgame.config.json`、`referee.argv`。
   - 内核 life1.db、world.db 只读快照，记 SHA-256（第 1 闸不碰内核，留作后面几闸的基线）。
   - `official-persona-agent/bridge.py` 和 6 个 `*-cc/compose.override.yaml` 抄到 `mcp/_backups/city-gate1-<日期>/`。
3. **新代码目录**：克隆 main 的部署提交到 `bot-game-mcp.new`，`npm ci`、`npm run build`（含城市前端静态资源），日志写 `logs/build-city.log`。旧目录切换时改名为 `bot-game-mcp.old-05d88b3`（里面有那处未提交修复，回滚要用，不删）。
4. **bridge 改动**：按第 2 节的决定改 `official-persona-agent/bridge.py`（只动 `GAME_TOOLS`），记改后 SHA-256。
5. **配置**（只列键，值不写进任何日志）：先写临时文件，用新引擎的 `loadConfig` 校验通过后整份替换，权限保持 600。
   - `town.enabled=false`，town 块其余不动。
   - 新增 `city`：`enabled=true`、`dbFile=bot-game-live/city/city.db`、`publicUrl=https://oracle-tokyo.tail8c4463.ts.net:10000/city/play/`、`devLogin=false`、`adminOnlyTickets`（按第 2 节）、`weather=true`、`allowedAgents=[]`（或主人给的名单）、`house`（6 位，各自 QQ 号），**不写 bridgeKey**。
   - `referee.argv` 末尾加 `--city`。
6. **切换**（在 `systemd-run --user --unit=… --collect` 里跑脚本）：
   - `systemctl --user stop botgame-referee.service`，再 stop `botgame-engine.service`。
   - 换目录、换配置。
   - `start --no-block botgame-engine.service`，限时等 `/health` 200，再 `start --no-block botgame-referee.service`。
   - 不用 nohup，不按 pid kill。任何一步失败，脚本自动按第 5 节回滚。
7. **验证**：
   - `/health` 显示 `town_enabled:false`、`city_enabled:true`。
   - 本机和经 Funnel（:10000 整站反代到 18790，网络不用改）：`/town/` 404，`/city/`、`/city/play/` 200。
   - 桥接接口在没有密钥时拒绝访问。
   - `list_games` 正常，公共桌游能建局。
   - 引擎日志没有报错；裁判重新连上 OneBot 和引擎；city.db 已生成。
   - 有人在群里说「小镇 / 栖灯镇」时，裁判提示已迁往灯都（能顺便看到就记一笔，不专门发消息测）。
8. **六人容器**：在 `ai-house-cc`、`claire-cc`、`alicia-cc`、`grok-cc`、`xingli-cc`、`whale-cc` 里逐个执行 `docker compose up -d --force-recreate`。每个起来后核对：容器 Up、容器内 bridge.py 的 SHA-256 对得上、没有 Traceback，再做下一个。正在回复或在对局中的先等。
9. **通知外部主人**：由主人发灯都版说明（#285）。说明里不放任何密钥。
10. **记录**：`DEPLOY-NOTES.md` 写一节（上了什么、步骤、验证过的、没验证的、回滚），看板 #286 贴回执，报主人。

## 4. 不确定、要在演练里先弄清的

- 新引擎在 `town.enabled=false` 时会不会改动 town.db（预期不会；演练前后对比 SHA-256）。
- 不写 bridgeKey 时，`/city/bridge/v1/*` 返回什么（预期拒绝，不能是放行）。
- `city.weather=true` 会让引擎去取现实天气，确认取不到时不影响启动。
- 旧镇金币不兑换城市日元（设计稿已定），演练里确认城市账本是空的、对账 ok。

## 5. 回滚

- **一级（城市有问题，引擎本身没事）**：配置改回 `city.enabled=false`、`town.enabled=true`，去掉 `--city`，按第 3 步第 6 项的办法重启。栖灯镇原样回来，city.db 原地保留不删。
- **二级（新代码有问题）**：停裁判、停引擎；`bot-game-mcp` 改名 `bot-game-mcp.failed-<sha>`，`bot-game-mcp.old-05d88b3` 改回 `bot-game-mcp`；从备份目录换回配置和 `referee.argv`；起引擎、等 `/health` 200、起裁判。`town/`、`state/` 只在怀疑新版本写坏数据时才还原，而且先问主人（还原会丢掉切换之后的变化）。
- **bridge**：从 `mcp/_backups/city-gate1-<日期>/` 换回 bridge.py，6 个容器逐个 `docker compose up -d --force-recreate`。
- 回滚不碰内核，因为第 1 闸没动内核。

## 6. 哪一步要主人点头

- 第 2 节四件事：要。
- 第 1 节准备（P1–P6）：不要；P1 合进 main 要主人一句「合并」。
- 第 3 节执行：主人批准第 1 闸后照单执行，中途不再逐步问；遇到手册外的情况就停下来问。
- 第 5 节回滚：一级、二级、bridge 回滚可以直接做（恢复原状），做完报主人；还原数据要先问。
