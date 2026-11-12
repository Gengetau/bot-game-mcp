/**
 * 栖灯镇的可调参数（设计稿 14 章的默认值）。
 *
 * 这些是实施起点，放在带版本的配置里；产品边界（现实时间 1:1、历史受众固定、服务端判定结果）不在这里，也关不掉。
 * 运行中的交易、邀请、借期和小游戏沿用创建时保存的截止时间：改这里的值只影响之后新建的事项。
 */
import { z } from 'zod';

const ms = (def: number, min = 0, max = 400 * 24 * 3600_000) => z.number().int().min(min).max(max).default(def);
const int = (def: number, min = 0, max = 1_000_000) => z.number().int().min(min).max(max).default(def);

export const townParamsSchema = z.object({
  /** 参数版本：改了默认值就加一，写进日报和压测报告里 */
  version: int(1, 1),
  /** 世界时区（IANA）。开服时确定；已有每日任务后再改需要迁移计划 */
  timezone: z.string().default('Asia/Tokyo'),
  /** 同时在场的居民上限（容量目标，不是注册人数上限） */
  activeResidentLimit: int(30, 1, 500),
  /** 同时进行的小游戏局数上限 */
  concurrentGames: int(3, 0, 50),
  /** 点地导航的控制租约：最后一次续租之后还能走多久。到期没续就停在原地（和在场宽限是两回事） */
  navLeaseMs: ms(10_000, 1000),
  /** 导航续租间隔（告诉客户端和运行器的建议值）。续租由普通程序发，不调用模型 */
  navRenewEveryMs: ms(3_000, 500),
  /** 键盘方向输入的控制租约：最后一次有效方向输入之后还能走多久（设计稿约 500 毫秒）。只用于方向输入，不影响点地路线的 10 秒租约 */
  dirLeaseMs: ms(500, 100, 5000),
  /** 方向输入的频率上限（每位居民）：突发几条、每秒几条。客户端按住时约每 150~200 毫秒重发一次 */
  dirBurst: int(10, 1, 100),
  dirPerSecond: int(10, 1, 100),
  /** 改路线的频率上限：每分钟几次、突发几次 */
  navPerMinute: int(120, 1, 6000),
  navBurst: int(8, 1, 600),
  /** 信件从寄出到进信箱 */
  letterDeliveryDelayMs: ms(60_000),
  /** 住宅邀请有效期 */
  homeInvitationTtlMs: ms(24 * 3600_000),
  /** 送礼、交换、借出提议的有效期 */
  tradeOfferTtlMs: ms(10 * 60_000),
  /** 借期 */
  loanDueAfterMs: ms(72 * 3600_000),
  /** 活动（小游戏、共同活动）报名阶段最长保留 */
  activityLobbyTtlMs: ms(10 * 60_000),
  /** 登录票据有效期 */
  loginTicketTtlMs: ms(5 * 60_000),
  /** 登录会话有效期 */
  sessionTtlMs: ms(30 * 24 * 3600_000),
  /** 心跳间隔（告诉客户端的建议值） */
  heartbeatIntervalMs: ms(20_000),
  /** 在场租约：最后一次心跳之后保留多久 */
  presenceGraceMs: ms(60_000),
  /** 服务中断超过这个时长，受影响的小游戏中止（不发奖） */
  shortOutageLimitMs: ms(120_000),
  /** 请求可重试窗口（动作窗口的有效期） */
  commandRetryWindowMs: ms(24 * 3600_000),
  /** 请求回执保留 */
  receiptRetentionMs: ms(7 * 24 * 3600_000),
  /** 事件流保留（超期用授权快照恢复） */
  eventReplayRetentionMs: ms(7 * 24 * 3600_000),
  /** 聊天原文保留 */
  chatBodyRetentionMs: ms(30 * 24 * 3600_000),
  /** 新居民的镇币 */
  initialCoins: int(20, 0, 10_000),
  traitCount: int(2, 0, 6),
  interestCount: int(3, 0, 8),
  longGoals: int(1, 0, 3),
  shortGoals: int(2, 0, 5),
  /** 情绪最长保留 */
  moodMaxDurationMs: ms(60 * 60_000),
  /** 每有效在场小时的下降点数 */
  socialDecayPerHour: int(5, 0, 100),
  interestDecayPerHour: int(3, 0, 100),
  /** 每对居民每类事件每日前几次产生主要关系收益 */
  relationshipRewardEvents: int(3, 0, 100),
  /** 主动视图里每对居民给最近几条共同经历 */
  activeMemoryItems: int(10, 1, 50),
  /** 聊天：每分钟几条、突发几条、每条最多几个字符 */
  chatPerMinute: int(6, 1, 600),
  chatBurst: int(3, 1, 100),
  chatMaxChars: int(120, 1, 1000),
  /** 信件：每个世界日最多几封、每封最多几个字符、每人信箱最多几封 */
  lettersPerDay: int(20, 1, 1000),
  letterMaxChars: int(1000, 1, 10_000),
  mailboxCapacity: int(1000, 1, 100_000),
  /** 同一种共同活动每人每天前几次给完整效果，之后减半 */
  interactionFullEffectPerDay: int(3, 1, 100),
  /** 小游戏奖励：完成参与、获胜额外；每人每款游戏每天前几局有奖 */
  gameParticipationReward: int(2, 0, 100),
  gameWinBonus: int(2, 0, 100),
  gameRewardsPerDay: int(3, 0, 100),
  /** 小游戏报名人数之外的总时限（到点没打完就中止） */
  gameMaxDurationMs: ms(20 * 60_000, 60_000),
  /** 同时借着的镇图书馆藏书上限 */
  libraryLoanLimit: int(2, 0, 20),
  /** 愿望奖励 */
  shortGoalReward: int(2, 0, 100),
  longGoalReward: int(8, 0, 1000),
  /** 公共事件每人每次的参与奖励 */
  publicEventReward: int(3, 0, 100),
  /** 日报生成时间：世界时区的 0 点过后几分钟 */
  dailyReportDelayMs: ms(5 * 60_000),
  /** 每个世界日做一次数据库一致性备份，保留几份（0 = 不自动备份） */
  backupKeep: int(7, 0, 365),
  /** 单条 SSE 连接的发送缓冲上限（字节），超过就断开让它按游标恢复 */
  streamBufferLimit: int(256 * 1024, 4096),
  /** 居民流、旁观流各自的连接上限 */
  maxResidentStreams: int(120, 1, 10_000),
  maxPublicStreams: int(60, 0, 10_000),
});

export type TownParams = z.infer<typeof townParamsSchema>;

export function resolveParams(overrides: Record<string, unknown> = {}): TownParams {
  const parsed = townParamsSchema.safeParse(overrides);
  if (!parsed.success) {
    throw new Error(`小镇参数无效：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`);
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: parsed.data.timezone });
  } catch {
    throw new Error(`小镇参数无效：不认识的时区 ${parsed.data.timezone}`);
  }
  return parsed.data;
}
