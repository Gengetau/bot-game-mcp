import { z } from 'zod';

/** 所有游戏共有的选项（各游戏 schema 用 ...commonOptionShape 展开）。 */
export const commonOptionShape = {
  random_seats: z.boolean().default(true),
  speech_gap_ms: z.number().int().min(0).max(30_000).default(3000),
};

export const commonOptionsHelp: Record<string, string> = {
  random_seats: '是否由程序随机分配座位（默认 true；false 则按报名顺序）',
  speech_gap_ms: 'bot 自己往群里发言后，裁判下一条消息至少延后多少毫秒（默认 3000），保证群里消息顺序',
};

/** 秒 → 毫秒的超时选项。 */
export const secondsOption = (def: number, min = 10, max = 900) => z.number().int().min(min).max(max).default(def);
