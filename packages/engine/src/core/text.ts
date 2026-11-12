/**
 * 真人指令解析工具：中文数字、座位号、@提及、全角字符等。
 * 真人在 QQ 里说「投三号」「验 @小明」「刀５」，裁判原样转发，由这里的程序统一解析，
 * 避免裁判自由裁量。
 */
import type { Player, Seat } from './types.js';

const FULLWIDTH_OFFSET = 0xfee0;

/** 全角转半角、去首尾空白、压缩空白。 */
export function normalizeText(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - FULLWIDTH_OFFSET);
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 去掉句末标点与语气词，便于整句匹配。 */
export function stripTrailing(input: string): string {
  return input.replace(/[\s。．.!！?？~～,，、;；…]+$/u, '').replace(/[吧啊呀哦哈嘛啦了]+$/u, '');
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  幺: 1,
  二: 2,
  两: 2,
  俩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_NUMBER_RE = /^[零〇一幺二两俩三四五六七八九十百千]+$/u;

/** 解析阿拉伯数字或中文数字（0~9999）。无法解析返回 null。 */
export function parseIntLoose(raw: string): number | null {
  const s = normalizeText(raw);
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  if (!CN_NUMBER_RE.test(s)) return null;
  const hasUnit = [...s].some((ch) => ch in CN_UNITS);
  if (!hasUnit) {
    // 「一二」这类逐位读法
    let v = 0;
    for (const ch of s) v = v * 10 + CN_DIGITS[ch]!;
    return v;
  }
  let total = 0;
  let current = 0;
  let digitSeen = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]!;
      digitSeen = true;
    } else {
      const unit = CN_UNITS[ch]!;
      total += (digitSeen ? current : 1) * unit;
      current = 0;
      digitSeen = false;
    }
  }
  return total + current;
}

/** 从文本中找第一个阿拉伯数字。 */
export function firstArabicInt(text: string): number | null {
  const m = normalizeText(text).match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

/** 提取所有 CQ at 码中的 QQ 号。 */
export function extractCqAts(text: string): string[] {
  const ids: string[] = [];
  const re = /\[CQ:at,qq=(\d+)[^\]]*\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) ids.push(m[1]!);
  return ids;
}

/**
 * 把一段「目标描述」解析成座位号：
 *  1. CQ 码 [CQ:at,qq=123]
 *  2. 「@昵称」
 *  3. 「3号」「三号」「3号玩家」
 *  4. 纯数字 / 纯中文数字
 *  5. 精确昵称
 * 目标必须出现在开头（后面可以跟理由，如「3号，他踩了预言家」），
 * 避免把闲聊（如「投资有风险，我觉得3号可疑」）误判为指令。无法确定返回 null。
 */
export function resolveSeat(rawTarget: string, players: readonly Player[]): Seat | null {
  const bySeat = (n: number | null): Seat | null =>
    n !== null && players.some((p) => p.seat === n) ? n : null;

  const raw = rawTarget.trim();
  const leadingAt = raw.match(/^\[CQ:at,[^\]]*\]/);
  if (leadingAt) {
    const id = extractCqAts(leadingAt[0])[0];
    const p = players.find((pl) => pl.id === id);
    return p ? p.seat : null;
  }
  const text = stripTrailing(normalizeText(raw.replace(/\[CQ:[^\]]*\]/g, ' ')));
  if (!text) return null;

  const atMatch = text.match(/^@\s*(.+)$/u);
  if (atMatch) {
    const name = atMatch[1]!.trim();
    const p =
      players.find((pl) => pl.name === name) ??
      players.find((pl) => name.startsWith(pl.name)) ??
      players.find((pl) => pl.name.startsWith(name) && name.length >= 2);
    if (p) return p.seat;
    const n = parseIntLoose(name.replace(/号.*$/u, ''));
    return bySeat(n);
  }

  const hao = text.match(/^(\d+|[零〇一幺二两俩三四五六七八九十百千]+)\s*号/u);
  if (hao) return bySeat(parseIntLoose(hao[1]!));

  const cleaned = text.replace(/(号位|号玩家|玩家|号|位)$/u, '').trim();
  const direct = parseIntLoose(cleaned);
  if (direct !== null) return bySeat(direct);

  // 「3，他踩了预言家」「3 我觉得他是狼」
  const lead = text.match(/^(\d{1,3})(?=[\s,，、。.!！?？;；:：])/u);
  if (lead) return bySeat(Number.parseInt(lead[1]!, 10));

  const exact = players.find((pl) => pl.name === text);
  if (exact) return exact.seat;

  if (/^\d+$/.test(cleaned) === false) {
    const arabic = cleaned.match(/^\D{0,2}(\d+)\D{0,2}$/);
    if (arabic) return bySeat(Number.parseInt(arabic[1]!, 10));
  }
  return null;
}

/**
 * 解析「3 他说天气，太宽泛」这类带理由的投票目标：先按第一个分隔符切开，前半能解析成座位就把后半当理由；
 * 否则整体当目标（没有理由）。理由未经清洗，调用方负责 cleanSpeech/截断。
 */
export function splitVoteReason(rawTarget: string, players: readonly Player[]): { target: Seat; reason?: string } | null {
  const t = rawTarget.trim();
  const m = t.match(/^(\S+?)[\s,，、。:：;；]+(.+)$/u);
  if (m) {
    const seat = resolveSeat(m[1]!, players);
    if (seat !== null) return { target: seat, reason: m[2]!.trim() };
  }
  const seat = resolveSeat(t, players);
  return seat === null ? null : { target: seat };
}

/** 常见的「结束发言」说法。 */
export function isEndSpeech(text: string): boolean {
  const t = stripTrailing(normalizeText(text)).toLowerCase();
  return /^(过|我过|pass|跳过|结束|结束发言|发言完毕|发言结束|完毕|说完|我说完|没了|没有了|over|end)$/u.test(t);
}

/** 文本是否表示「放弃 / 不行动」。 */
export function isSkipWord(text: string): boolean {
  const t = stripTrailing(normalizeText(text)).toLowerCase();
  return /^(过|跳过|不|不用|不使用|不用药|放弃|弃权|弃票|空|空刀|空守|不开枪|skip|pass|none|无)$/u.test(t);
}

/** 「3号 小明」 */
export function seatLabel(p: Pick<Player, 'seat' | 'name'>): string {
  return `${p.seat}号 ${p.name}`;
}

export function seatsLabel(seats: readonly Seat[]): string {
  return seats.length === 0 ? '无' : seats.map((s) => `${s}号`).join('、');
}

/** 去掉文本里的 CQ 码，限制长度，用于记录发言。 */
/**
 * 真人发言里的 CQ 码 → 可读文字：@ 本局玩家变成「@昵称」，@ 局外的人和其他 CQ 码（回复、图片、表情）去掉。
 * 必须在 sanitizeUserText 之前做（之后 CQ 码已被转义）。
 */
export function cqToSpeech(text: string, players: readonly Pick<Player, 'id' | 'name'>[]): string {
  return text
    .replace(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/g, (_, id: string) => {
      const p = players.find((x) => x.id === id);
      return p ? `@${p.name} ` : '';
    })
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 发言末尾单独带了结束词（「……我说完了，过」「…啊 过」）：拆成发言正文和「结束发言」。
 * 结束词前必须有空格或标点，避免把「就这么过」之类的句子误判。
 */
export function splitTrailingEnd(text: string): { body: string; end: boolean } {
  const m = text.match(/^([\s\S]*?\S)[\s,，。.!！~～;；、…]+(过|我过|说完了|我说完了|发言完毕|发言结束|完毕|pass|over)[\s。.!！~～]*$/iu);
  if (!m) return { body: text, end: false };
  return { body: m[1]!.trim(), end: true };
}

export function cleanSpeech(text: string, maxLen = 600): string {
  const t = sanitizeUserText(text.replace(/\[CQ:at,qq=(\d+)[^\]]*\]/g, '@$1').replace(/\[CQ:[^\]]*\]/g, '')).trim();
  return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

/**
 * 清洗玩家提供的文字（发言、密谈等），之后它会被拼进程序生成的消息里：
 * 去掉控制字符，并让引擎的 @ 占位符「{@N}」和 CQ 码失效，防止借发言 @ 别人或注入 CQ 码。
 */
export function sanitizeUserText(input: string): string {
  return String(input ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // 双向文字的嵌入、覆盖和隔离控制符：能让后面的文字倒着显示，用来伪造名字或打乱程序拼出的消息
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\{@/g, '{＠')
    .replace(/\[CQ:/gi, '［CQ:');
}

/** 清洗昵称：在 sanitizeUserText 的基础上去掉换行、压缩空白并限制长度。 */
export function sanitizeName(input: string, maxLen = 24): string {
  const s = sanitizeUserText(input).replace(/\s+/g, ' ').trim();
  return [...s].slice(0, maxLen).join('');
}

/** 秒数的中文展示。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}分钟` : `${m}分${r}秒`;
}

/** 网页舞台往群里镜像公告时只取第一行（太长截断），后面还有内容就注明「详见网页」。 */
export function mirrorLine(text: string, max = 80): string {
  const t = String(text ?? '').trim();
  const nl = t.indexOf('\n');
  let line = (nl < 0 ? t : t.slice(0, nl)).trim();
  let more = nl >= 0 && t.slice(nl + 1).trim().length > 0;
  if ([...line].length > max) {
    line = [...line].slice(0, max).join('').trimEnd() + '…';
    more = true;
  }
  return more ? `${line}（详见网页）` : line;
}
