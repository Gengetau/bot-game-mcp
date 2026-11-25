# 晴空都城市世界（M1）生产变更备包待批单

> **状态**：已归档：M1 历史备包，仅供查阅，不是现行预案（栖灯镇已于 2026-11 删除，`town.db` 只读归档）。
> **覆盖候选**：
> - `Gengetau/bot-game-mcp`：PR #53（`d07bcf6`）+ PR #54（`6380250`）+ PR #55（`7acd618`）+ PR #57（`2dbccf6`）+ M1 集成与 E2E 分支
> - `Gengetau/ai-house-world`：PR #168（`23acbeb`，`world-kernel` M1-A `life1` 生产桥接适配器）

---

## 一、配置变更模板（脱敏占位符）

### 1. 引擎服务配置增量（栖灯镇封存 + 晴空都开启）

> 已归档：栖灯镇已于 2026-11 删除，本节仅作历史记录

```json
{
  "town": {
    "enabled": false,
    "dbFile": "./data/town.db"
  },
  "city": {
    "enabled": true,
    "dbFile": "./data/city.db",
    "bridgeKey": "<32B_RANDOM_HEX_OR_BASE64URL_BRIDGE_SECRET>",
    "publicUrl": "https://<PUBLIC_HOST>/city/play/",
    "devLogin": false,
    "adminOnlyTickets": false,
    "weather": true,
    "allowedAgents": ["<APPROVED_EXTERNAL_BOT_QQ_IDS>"],
    "house": [
      { "actorId": "nia", "name": "妮娅", "qqIds": ["<NIA_QQ_ID>"] },
      { "actorId": "claire", "name": "克蕾雅", "qqIds": ["<CLAIRE_QQ_ID>"] },
      { "actorId": "alicia", "name": "艾莉希娅", "qqIds": ["<ALICIA_QQ_ID>"] },
      { "actorId": "grok", "name": "格萝可", "qqIds": ["<GROK_QQ_ID>"] },
      { "actorId": "xingli", "name": "星璃", "qqIds": ["<XINGLI_QQ_ID>"] },
      { "actorId": "whale", "name": "岚汐", "qqIds": ["<WHALE_QQ_ID>"] }
    ]
  }
}
```

### 2. 裁判进程启动参数增量

> 已归档：栖灯镇已于 2026-11 删除，本节仅作历史记录

- 在 `referee-onebot` 启动参数中追加 `--city`（识别群内「晴空都 / 进城」，仅按真实发送者身份向本人私聊下发一次性 `#ticket=` 链接；有人输入旧词「小镇 / 栖灯镇」时礼貌提示已迁往晴空都）。

### 3. 小屋内核（`world-kernel`）特性开关（分两档灰度）

- 默认值保持关闭（`WORLD_KERNEL_CITY_WEATHER=0`、`WORLD_KERNEL_CITY_BRIDGE=0`），合入主干本身不改变线上行为。
- **灰度第 1 档（单角色试点）**：开启 `WORLD_KERNEL_CITY_WEATHER=1`、`WORLD_KERNEL_CITY_BRIDGE=1`、`WORLD_KERNEL_CITY_ALLOWED=nia`，注入桥接基址与桥接密钥。
- **灰度第 2 档（六人全开）**：单角色连续 24 小时对账 `reconcile_ok=true` 后，切为 `WORLD_KERNEL_CITY_ALLOWED=all`。

---

## 二、批准后标准上线操作单（按序执行）

> 已归档：栖灯镇已于 2026-11 删除，本节仅作历史记录

1. **前置封存备份**：
   - 对线上 `town.db` 执行 SQLite 在线一致性快照备份并记录 SHA-256 校验值；确认 `town.db` 置为只读封存，旧镇金币不兑换城市日元。
   - 对线上 `life1.db` 与 `world.db` 执行上线前快照备份。
2. **合并与构建**：
   - 合并 `Gengetau/bot-game-mcp` M0/M1 分支至 `main` 并构建生产产物（含 `packages/engine/city/` 前端静态资源）。
   - 合并 `Gengetau/ai-house-world` PR #168 至 `main`（此时桥接开关默认仍为 `0`）。
3. **先启引擎与裁判，验只读探针**：
   - 写入引擎生产配置（`town.enabled=false`、`city.enabled=true`），平滑重启引擎与 `referee-onebot --city`。
   - 验证：`GET /health` 返回 `town_enabled:false, city_enabled:true`；`GET /town/` 返回 `404`；`GET /city/` 与 `GET /city/play/` 返回 `200`；`GET /city/bridge/v1/reconcile` 返回 `ok:true`；公共桌游对局正常。
4. **开启内核桥接试点（`nia`）**：
   - 打开 `world-kernel` 桥接开关（仅放行 `nia`），观察一次完整出门 -> 在城 -> 返家 `T3` 结算。
   - 校验引擎 `ledgerImbalance === 0`、`reconcile.ok === true`，以及内核 `adapter.reconcile()["ok"] === True`。
5. **放开其余五位室友与外部准入名单**：
   - 试点无误后将 `WORLD_KERNEL_CITY_ALLOWED` 扩至六位室友，按主人核准名单开放外部 Bot 与真人签票。

---

## 三、一键紧急回滚预案

> 已归档：M1 历史备包，仅供查阅，不是现行预案。栖灯镇已于 2026-11 删除、`town.db` 已只读归档，本节中恢复旧镇的步骤已不适用。

1. **一级软回滚（仅停外出桥接，不动引擎与桌游）**：
   - 将 `world-kernel` 环境变量 `WORLD_KERNEL_CITY_BRIDGE=0` 重启内核：新外出计划立即停派；若有在城室友，待其 `return_by_ms` 自动返家或由管理端触发 `return-request` 完成 `T3` 平账收口。
2. **二级完整回滚（退回上线前状态）**：
   - 在全部在城访问 `state='closed'`（且无 `reconcile` 未决订单）后，将引擎配置 `city.enabled` 设回 `false`（如需恢复旧镇则切回备份前配置与镜像），移除裁判 `--city` 参数并重启；`city.db` 原地保留备查，不删库。
