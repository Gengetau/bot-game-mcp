# 东京城市世界（`tokyo`）· 四层地理架构与标准街区内容包规范（M0 冻结稿）

- **状态**：M0 冻结候选（2026-11-18，基线 `Gengetau/bot-game-mcp@c8148df`）
- **关联文档**：`IDENTITY-AND-FACTS.md`、`CLIENT-AND-WEB-CONTRACT.md`、`ITEM-AND-LOCKER-SPEC.md`
- **目标**：在 M0 阶段一次性锁死全东京都地理实体命名、三级开放状态与标准内容包格式，确保 M1–M3 所有新增功能绝不写死一期三站结构，支撑 M4 零状态机改动挂载六个生活街区（36–48 个地点）与全东京都站点目录。

---

## 1. 四层地理实体分离与稳定 ID 规范

为彻底消除“新宿区 / 新宿南口街区 / 新宿站 / 具体店铺”同名混用，东京都目录自 M0 起严格划分为四层正交实体：

| 层级 | 实体类型 | ID 命名规范（正则） | 示例 | 职责与可见性 |
|---|---|---|---|---|
| **L1 行政区划** | `Municipality` | `^mun:13\d{3}$`（日本总务省 JIS X 0402 东京都 5 位团体码） | `mun:13117`（北区）<br>`mun:13116`（丰岛区）<br>`mun:13104`（新宿区）<br>`mun:13106`（台东区）<br>`mun:13113`（涩谷区）<br>`mun:13203`（武藏野市）<br>`mun:13361`（大岛町） | 覆盖全东京都 **62 个市区町村**（23 特别区 + 多摩 26 市 3 町 1 村 + 岛屿 2 町 7 村）；提供全城行政归属与天气分区锚点 |
| **L2 交通骨架** | `TransitLine` & `StationComplex` | 线路：`^line:[a-z0-9-]+:[a-z0-9-]+$`<br>车站：`^st:[a-z0-9-]+$`<br>交通边：`^te:[a-z0-9-]+$` | `line:jreast:saikyo`<br>`st:akabane`、`st:shinjuku`、`st:kichijoji`<br>`te:akabane-ikebukuro` | 承载铁道、地铁、单轨、都营巴士、岛屿航路（竹芝栈桥出发）与机场联络线拓扑；车站综合体通过 `placeId` 显式指向站内大厅 `Place`，**严禁通过字符串拼接 `${area}:station` 反推！** |
| **L3 生活街区** | `District` | `^dist:[a-z0-9-]+$`（兼容一期 `AreaId` 别名 `akabane` / `ikebukuro` / `shinjuku`） | `dist:akabane`、`dist:ikebukuro`、`dist:shinjuku`、`dist:asakusa`、`dist:shibuya`、`dist:kichijoji` | 玩家感知的街区单元；绑定所属 `municipalityId`、主枢纽车站 `hubStationId`、天气代表点 `weatherPoint` 与**三级开放状态 `openness`** |
| **L4 具体场所** | `Place` | `^[a-z0-9-]+:[a-z0-9:-]+$` | `akabane:station`<br>`ikebukuro:kissa-tomoshibi`<br>`shinjuku:muginohi`<br>`akabane:ai-house:entrance`（隐藏） | 居民实际驻留、交谈、消费、工作、制作、探索与存取储物柜的最小位置粒度（无帧级坐标） |

### 1.1 向后兼容铁律與 M1 必改解耦点

1. **存量地点 ID 100% 保留**：一期已有的 13 个 `Place.id`（含隐藏节点 `akabane:ai-house:entrance`）与 3 个 `StationComplex.id`（`st:akabane`、`st:ikebukuro`、`st:shinjuku`）永久不变，已落库的访问、账单与测试零迁移冲突。
2. **消除 `${area}:station` 硬编码（M1-D 必改）**：
   - 现行 `packages/engine/src/city/trips.ts` 中的 `PLACE_OF_STATION(p: Place)` 写死了 `` `${p.area}:station` ``。当同一街区存在多个车站或站名与街区前缀不同时（如竹芝栈桥、押上/浅草多站）即会失效。
   - **M1 统一改为**：`station(p.station)?.placeId ?? null`，完全由 `Place.station -> StationComplex.placeId` 引用关系解析。

---

## 2. 三级开放状态（`openness`）行为规范

每个 `District` 与 `StationComplex` 显式标记以下三种开放级别之一，界面与路由严格按级别执行：

| 开放状态 | 界面展示标签 | 东京总览 / 目录可见 | 电车换乘经过 | `travel` 驻留与街区生活 | 典型代表 |
|---|---|---|---|---|---|
| `cataloged` | **已收录** | 可见（行政归属、站名、线路归属、数据来源） | 不可作为换乘段 | **拒绝**（`422 PRECONDITION_FAILED / area_not_open`） | 多摩远郊及岛屿未开放站点、其余特别区骨架站 |
| `transitable` | **可经过** | 可见 | **允许**作为多段行程的途经站或换乘站，可停靠站内大厅 | 仅车站大厅可达，无街区内部店铺/活动 | 东京站、上野站、品川站、御茶之水站、竹芝栈桥等关键换乘节点 |
| `livable` | **可生活** | 可见（含天气、营业、在场人数、街区事件） | **允许** | **完整开放**（6–8 处场所：商店、餐饮、工坊、公园、委托、活动与共建） | v1 六大重点街区：**赤羽、池袋、新宿、浅草、涩谷、吉祥寺** |

---

## 3. 可解释交通模型与上下文瘦身规范

### 3.1 行程分段与换乘计费模型（M1 兼容 → M4 扩展）

- **分段模型（`Leg`）**：
  - `mode`：M1 为 `'walk' | 'train'`；M4 扩充 `transport_kind: 'rail' | 'subway' | 'monorail' | 'bus' | 'ferry' | 'airport_link'` 与站内换乘步行段 `'transfer_walk'`。
  - 每段行程固定记录 `depart_at_ms`、`arrive_at_ms`、`minutes`、`fare_yen`、`operator`、`line`、`rule_version`、`source: 'simulated'`。
- **多段换乘计费规则（M4 落地，M0 预留字段）**：
  - `TransitEdge` 预留 `operator: string`（如 `'jreast'`、`'tokyometro'`、`'toei'`、`'keio'`、`'tokai-kisen'`）与 `distanceKm?: number`（营业里程，精确到 0.1 km）。
  - **同运营商连续乘车**：合并累计 `distanceKm` 后按该运营商运价档查一次通算票价（例如赤羽 → 新宿 → 吉祥寺均属 JR 东日本干线网，按累计里程通算，不重复起算初乘费）。
  - **跨运营商换乘**：在换乘站切分计费段，按各运营商区间分别计费相加。
  - **扣费幂等键**：保持 `trip:<trip_id>:leg:<n>` 永久唯一，任何进程重启补跑绝不二次扣费。

### 3.2 `selfView.here.exits` 上下文瘦身铁律

为防止全东京都数百站点载入后撑爆 AI 上下文 Token：
1. `selfView.here.exits` **只包含两类去处**（总数硬上限 `<= 24`）：
   - 当前所在街区（`p.area` / `p.districtId`）内步行可达的全部公开地点；
   - 其他 `openness === 'livable'` 街区的代表车站直达摘要（如赤羽站、池袋站、新宿站、浅草站、涩谷站、吉祥寺站）。
2. 前往其他街区内部具体店铺，既可直接提交 `travel { to: "<目标 PlaceId>" }`（服务端 `planRoute` 全图寻路支持任意公开可达 `PlaceId`，不受 `exits` 摘要截断影响），也可先调 `world_query({ what: "route", from, to })` 或 `GET /city/api/route` 预览分段耗时与车费。
3. 验收门禁：全东京都目录与六大生活街区全量挂载后，单次 `get_my_view` JSON 响应体积保持在 **4 KB 量级以内**。

---

## 4. 标准街区内容包（Content Pack）数据格式与溯源规范

### 4.1 内容包模块结构

自 M4 起，目录数据由编译管线 `scripts/city-data/` 生成只读内容包（存放在 `packages/engine/src/city/packs/`），新增一个普通生活街区只需挂载一份符合下述接口的标准包，**零修改 `ledger.ts`、`visits.ts`、`residents.ts` 核心状态机**：

```ts
export interface CityContentPack {
  /** 内容包唯一标识，如 'pack:kichijoji' */
  packId: string;
  /** 内容包语义版本，任何地点/票价/商品价格变动必须递增 */
  version: string;
  /** 遵循的内容包规范版本 */
  specVersion: 1;
  municipality: {
    id: string;          // 如 'mun:13203'
    name: string;        // 如 '武藏野市'
    region: 'ward23' | 'tama' | 'islands';
    source: string;
  };
  district: {
    id: string;          // 如 'dist:kichijoji'（兼容别名 'kichijoji'）
    name: string;        // 如 '吉祥寺'
    municipalityId: string;
    openness: 'cataloged' | 'transitable' | 'livable';
    hubStationId: string;
    weatherPoint: { lat: number; lon: number };
    blurb: string;
  };
  stations: StationComplex[];
  transitEdges: (TransitEdge & {
    operator: string;
    transportKind: 'rail' | 'subway' | 'monorail' | 'bus' | 'ferry' | 'airport_link';
    distanceKm?: number;
  })[];
  neighborhoods: Neighborhood[];
  places: Place[];
  itemTypes?: ItemType[];
  /** M2 扩展：兼职委托、制作配方、街区探索点；M3 扩展：街区共建项目模板 */
  jobs?: Record<string, unknown>[];
  recipes?: Record<string, unknown>[];
  explorations?: Record<string, unknown>[];
  communityProjects?: Record<string, unknown>[];
  sources: SourceReference[];
}
```

### 4.2 数据溯源、合规许可与虚构隔离铁律

1. **真实地理骨架溯源必填**：
   - 行政区划、铁道线路与车站骨架以《虚拟东京都建城资料源》（如国土数值信息 N02 CC BY 4.0 等长期合规开放数据）为底座；每条 `SourceReference` 必须记录 `id`、`kind`、`title`、`license`、`retrieved`（`YYYY-MM-DD`）。
   - **严禁将竞赛限定或短期受限许可（如 ODPT 部分限时时刻表）作为长期运行依赖**。
2. **虚构商业与模拟数值显式标注**：
   - 城内所有具体店铺、商品价格、营业时间、兼职委托与制作配方一律为虚构设定，必须显式标记 `fictional: true`、`source: 'fictional'`；
   - 所有耗时与车费一律标记 `source: 'simulated'` 与 `FARE_RULE_VERSION`；
   - 赤羽 AI 小屋保持为虚构旧洋房，交接节点 `akabane:ai-house:entrance` 标记 `hidden: true`，不对应真实门牌地址。
3. **目录不可变与历史账单可解释（Schema v5 `catalog_versions`）**：
   - 内容包改动任何票价、耗时或商品价格时，必须升级 `CITY_CATALOG_VERSION`（及 `FARE_RULE_VERSION`）；
   - 引擎启动时将当前生效的目录版本摘要写入 `catalog_versions(catalog_version, fare_rule_version, summary_json, activated_at)`，使历史 `visits`、`trips` 与 `orders` 引用的旧版本号始终可查、可一键回退上一版目录包。

### 4.3 启动自检守门（`validateCatalog`）

任何内容包合入总目录时，启动前纯函数 `validateCatalog()` 强制校验：
- 所有 `municipality`、`district`、`station`、`place`、`transitEdge`、`itemType`、`sku` 全局无重复且外键引用闭合；
- 每个 `StationComplex.placeId` 对应的 `Place` 存在且 `type === 'station'`、`walkMinutes === 0`；
- 所有 `openness === 'livable'` 的公开地点均可通过 `planRoute(place.id, HOUSE_ENTRANCE)` 连通回小屋门口（保证室友在全城任何开放生活街区均能计算出确定性回程预留车费与返家路线！）；
- `HOUSE_ENTRANCE` 必须保持 `hidden === true`。
