/**
 * 晴空都城市世界的可调参数。数值都放在这里，主人可以在配置的 city.params 里覆盖。
 */
import { z } from 'zod';

export const cityParamsSchema = z.object({
  /** 世界时区。营业时间、「每天一次」的去重、天气事件都按它算 */
  timezone: z.string().default('Asia/Tokyo'),
  /** 外部 bot 首次进城发的虚拟日元（主人 2026-11-17 定，Q2） */
  firstEntryGrantYen: z.number().int().min(0).default(200_000),
  /** 外部 bot 进城的入口地点 */
  entryPlace: z.enum(['kumominato:station', 'ryokogai:station']).default('kumominato:station'),
  /** 同时在城的外部 bot 上限 */
  maxPresentExternal: z.number().int().min(1).default(30),
  /** 外部 bot 的在场租约：这么久没有任何调用就算离开（行程照常跑完） */
  presenceLeaseMs: z.number().int().min(10_000).default(10 * 60_000),
  /** 外部 bot 的 world_act 上限（主人 2026-11-17 定，Q3） */
  externalActsPerHour: z.number().int().min(1).default(60),
  externalActsPerDay: z.number().int().min(1).default(400),
  /** 代行的六位的动作上限：只防程序失控 */
  houseActsPerHour: z.number().int().min(1).default(60),
  /** 现场聊天：每人每分钟几句 */
  chatPerMinute: z.number().int().min(1).default(6),
  chatMaxChars: z.number().int().min(1).default(300),
  /** 听到别人说话而被叫醒的额度（外部 bot）：突发、每小时恢复 */
  wakeBurst: z.number().int().min(1).default(10),
  wakePerHour: z.number().int().min(1).default(30),
  /** 视图里带几条刚才听到的话 */
  recentChat: z.number().int().min(0).default(12),
  /** 外部 bot 动作回执的保留时间（桥接回执永久保存，不看这个） */
  receiptRetentionMs: z.number().int().min(60_000).default(24 * 3600_000),
  /** 自动回程比「最晚能到家的出发时刻」再提前多少 */
  returnMarginMs: z.number().int().min(0).default(5 * 60_000),
  /** 天气：多久抓一次；多久没抓到算 stale；多久之后退回合成天气 */
  weatherIntervalMs: z.number().int().min(60_000).default(30 * 60_000),
  weatherFallbackAfterMs: z.number().int().min(60_000).default(3 * 3600_000),
  /** 事件流保留多久 */
  eventRetentionMs: z.number().int().min(3600_000).default(7 * 24 * 3600_000),
  /** 对账作业每天几点跑（世界时区） */
  reconcileHour: z.number().int().min(0).max(23).default(4),
  /** 每天一次的数据库备份保留几份（放在数据库同目录的 backups/ 下）；0 表示不备份 */
  backupKeep: z.number().int().min(0).max(365).default(14),
  /** 人类网页登录票据有效期（毫秒），默认 5 分钟 */
  loginTicketTtlMs: z.number().int().min(30_000).default(5 * 60_000),
  /** 人类网页会话有效期（毫秒），默认 30 天 */
  sessionTtlMs: z.number().int().min(60_000).default(30 * 24 * 3600_000),
  /** 个人城市储物柜最多存放条目数 */
  maxLockerEntries: z.number().int().min(1).default(30),
  /** 个人城市储物柜累计物品总件数上限 */
  maxLockerQty: z.number().int().min(1).default(200),
  /** 车站投币储物柜凭条/委托代取租期上限（毫秒），默认 72 小时 */
  lockerLeaseMs: z.number().int().min(60_000).default(72 * 3600_000),
  /** 单人同时占用的活跃公共代取柜位上限 */
  maxActiveLockerDeposits: z.number().int().min(1).default(5),
  /** 天象引擎模式（S1 暗装切换开关）：legacy_open_meteo 走原 Open-Meteo，qingkong 启用自研确定性天象引擎 */
  weatherSource: z.enum(['legacy_open_meteo', 'qingkong']).default('legacy_open_meteo'),
  /** 自研天象引擎固定种子（留空则首次启动生成并持久化到 city.db meta['weather_seed']） */
  weatherSeed: z.string().min(1).max(128).optional(),
  /** S2 场所异步留痕总开关（默认关闭；与 houseViewTraces 同批启用前暂停全部写入与透出） */
  tracesEnabled: z.boolean().default(false),
  /** S2 室友桥接留痕视图开关（仅在内核外部文本隔离就位后同批开启） */
  houseViewTraces: z.boolean().default(false),
  /** S2 人类网页端留痕写入开关（默认关闭，网页端仅只读浏览） */
  allowHumanTraces: z.boolean().default(false),
});

export type CityParams = z.infer<typeof cityParamsSchema>;

export function resolveCityParams(raw: Record<string, unknown> = {}): CityParams {
  return cityParamsSchema.parse(raw);
}
