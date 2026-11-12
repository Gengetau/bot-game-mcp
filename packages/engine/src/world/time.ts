/**
 * 世界时区的日历计算。所有持久时间都是 UTC 毫秒时间戳，这里只负责「这一刻在世界时区是哪一天、几点」。
 * 用 Intl 计算，夏令时、时区偏移变化都由它处理；不依赖进程自己的本地时区。
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  /** YYYY-MM-DD（业务日期） */
  date: string;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(tz: string, at: number): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(at))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? 'Sun'),
  };
}

/** 世界业务日期（YYYY-MM-DD）。 */
export function businessDate(tz: string, at: number): string {
  return localParts(tz, at).date;
}

/**
 * 世界时区里某个日期、某个钟点对应的 UTC 时间戳。
 * 夏令时跳过的钟点落到跳过之后；重复的那一小时取第一次出现的那一刻（这样同一个业务日期的任务只有一个时刻）。
 */
export function localToUtc(tz: string, date: string, hour = 0, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d, hour, minute, 0);
  // 时区偏移不超过一天：从「把目标当 UTC」出发迭代修正
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(tz, guess);
    const [py, pm, pd] = p.date.split('-').map(Number) as [number, number, number];
    const seen = Date.UTC(py, pm - 1, pd, p.hour, p.minute, p.second);
    const diff = target - seen;
    if (diff === 0) break;
    guess += diff;
  }
  // 重复的小时：看看一小时前是不是同一个本地时刻
  const earlier = guess - 3600_000;
  const pe = localParts(tz, earlier);
  if (pe.date === date && pe.hour === hour && pe.minute === minute) return earlier;
  return guess;
}

/** 下一个业务日期。 */
export function nextDate(date: string, days = 1): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 世界时区的 HH:MM。 */
export function localClock(tz: string, at: number): string {
  const p = localParts(tz, at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
