/**
 * 晴空都异步留痕（S2）：店内留言簿 / 寄语牌、独立回响高水位、脉搏视图与降级归档恢复。
 *
 * 三重暗装开关（默认全 false）：
 *  - tracesEnabled: 总开关；false 时全渠道写入返 409 traces_disabled，全视图省略 traces，/pulse & /traces/replies 返回空。
 *  - houseViewTraces: 室友桥接隔离门禁；仅与 tracesEnabled 同时为 true 时对小屋开放读写与回响。
 *  - allowHumanTraces: 人类网页端写入独立门禁；默认 false（仅只读浏览）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Row } from '../world/db.js';
import { area as areaOf, place } from './catalog.js';
import { CityError, cityBadRequest, cityConflict, cityPrecondition } from './errors.js';
import type { CityResident, CityService } from './service.js';
import type { VisitRow } from './visits.js';
import { allWeather, eventsToday } from './weather.js';

export const MAX_HERE_TRACES_BYTES = 600;
export const MAX_PULSE_BYTES = 2048;
export const MAX_TRACE_CHARS = 80;
export const MIN_TRACE_CHARS = 4;
export const MAX_TRACES_PER_PLACE_PER_DAY = 2;
export const MAX_TRACES_PER_DAY = 5;
export const PRUNE_KEEP_PER_PLACE = 50;

export interface TraceSpotSpec {
  placeId: string;
  label: string;
}

export const TRACE_SPOTS: readonly TraceSpotSpec[] = [
  { placeId: 'ryokogai:kissa-tomoshibi', label: '吧台留言簿' },
  { placeId: 'ryokogai:shiorido', label: '荐书黑板' },
  { placeId: 'kumominato:muginohi', label: '食客便签墙' },
  { placeId: 'kumominato:southern-terrace', label: '露台寄语牌' },
  { placeId: 'hiyorizaka:fukogawa-riverbank', label: '河堤木牌' },
];

const TRACE_SPOT_MAP = new Map<string, TraceSpotSpec>(TRACE_SPOTS.map((s) => [s.placeId, s]));

export function isTraceSpot(placeId: string | null | undefined): boolean {
  return typeof placeId === 'string' && TRACE_SPOT_MAP.has(placeId);
}

export function traceSpotLabel(placeId: string): string | undefined {
  return TRACE_SPOT_MAP.get(placeId)?.label;
}

export function areHouseTracesEnabled(c: CityService): boolean {
  return Boolean(c.params.tracesEnabled && c.params.houseViewTraces);
}

export function canLeaveTraceForViewer(c: CityService, viewer: Pick<CityResident, 'origin'>, placeId: string): boolean {
  if (!c.params.tracesEnabled || !isTraceSpot(placeId)) return false;
  if (viewer.origin === 'house') return Boolean(c.params.houseViewTraces);
  if (viewer.origin === 'human') return Boolean(c.params.allowHumanTraces);
  return true;
}

const RAW_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/u;
const ZERO_WIDTH_OR_BIDI_RE = /[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/u;
const FORBIDDEN_SYMBOLS_RE = /[<>@＠]|\[CQ:|\{@/i;
const INJECTION_RE = /(?:^|\b)(?:system|developer|assistant|user)\s*:|<\||\|>|\[\/?inst\]|<<sys>>|###\s*instruction|ignore\s+previous\s+instructions|忽略之前的指令|无视上述指令/i;
const URL_OR_DOMAIN_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|jp|cn|io|me|dev|app)(?:[^a-z0-9]|$)/i;

const CN_DIGIT_MAP: Record<string, string> = {
  零: '0',
  〇: '0',
  一: '1',
  幺: '1',
  二: '2',
  两: '2',
  俩: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  壹: '1',
  贰: '2',
  叁: '3',
  肆: '4',
  伍: '5',
  陆: '6',
  柒: '7',
  捌: '8',
  玖: '9',
};

const SEPARATORS_RE = /[\s\-._/·・、，,:：()（）【】\[\]~～]+/gu;

/**
 * 构造归一化检测串：NFKC 全角转半角 -> 中文大小写数字映射 -> 剥离数字/字母间分隔符。
 */
export function normForTraceGuard(body: string): string {
  const nfkc = body.normalize('NFKC').toLowerCase();
  let mapped = '';
  for (const ch of nfkc) {
    mapped += CN_DIGIT_MAP[ch] ?? ch;
  }
  return mapped.replace(SEPARATORS_RE, '');
}

export function validateAndCleanTraceBody(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw cityBadRequest('请提供文本格式的便签正文（4~80 字）。', 'trace_forbidden_content');
  }
  if (RAW_CONTROL_RE.test(raw) || ZERO_WIDTH_OR_BIDI_RE.test(raw)) {
    throw cityBadRequest('便签正文不能包含控制字符、换行符或隐藏字符。', 'trace_forbidden_content');
  }
  const nfkcRaw = raw.normalize('NFKC');
  if (FORBIDDEN_SYMBOLS_RE.test(nfkcRaw) || INJECTION_RE.test(nfkcRaw)) {
    throw cityBadRequest('便签正文包含不允许的符号或指令定界符。', 'trace_forbidden_content');
  }
  const cleaned = raw.replace(/\s+/gu, ' ').trim();
  const len = [...cleaned].length;
  if (len < MIN_TRACE_CHARS || len > MAX_TRACE_CHARS) {
    throw cityBadRequest('便签正文长度须在 4 到 80 个字符之间。', 'trace_forbidden_content');
  }
  const compactUrlProbe = cleaned.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  if (URL_OR_DOMAIN_RE.test(cleaned.normalize('NFKC')) || URL_OR_DOMAIN_RE.test(compactUrlProbe)) {
    throw cityBadRequest('便签正文不能包含网址或域名。', 'trace_forbidden_content');
  }
  const guarded = normForTraceGuard(cleaned);
  if (/\d{6,}/.test(guarded) || URL_OR_DOMAIN_RE.test(guarded)) {
    throw cityBadRequest('便签正文不能包含长数字串或联系方式。', 'trace_forbidden_content');
  }
  return cleaned;
}

function excerptOf(text: string, maxChars = 40): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function doLeaveTrace(
  c: CityService,
  r: CityResident,
  a: Record<string, unknown>,
  at: number,
  visit: VisitRow | null,
): Record<string, unknown> {
  if (!c.params.tracesEnabled) {
    throw cityConflict('全城留言簿与寄语牌暂未开放。', 'traces_disabled');
  }
  if (r.origin === 'house' && !c.params.houseViewTraces) {
    throw cityConflict('室友城内留痕通道暂未开放。', 'house_traces_disabled');
  }
  if (r.origin === 'human' && !c.params.allowHumanTraces) {
    throw new CityError('FORBIDDEN', '网页端当前仅开放只读浏览，暂未开放留痕写入。', 'human_trace_disabled');
  }
  if (!r.in_city || r.trip_id !== null || !r.place_id || !isTraceSpot(r.place_id)) {
    throw cityPrecondition('需要停在设有多处留言簿或寄语牌的指定地点才能写便签。', 'not_at_trace_spot');
  }

  const body = validateAndCleanTraceBody(a.text);
  let replyTo: string | null = null;
  let replyTarget: Row | undefined;
  if (a.reply_to !== undefined && a.reply_to !== null) {
    if (typeof a.reply_to !== 'string' || !a.reply_to.trim()) {
      throw cityBadRequest('reply_to 必须是非空字符串。', 'trace_forbidden_content');
    }
    replyTo = a.reply_to.trim();
    const cut = at - c.params.eventRetentionMs;
    replyTarget = c.db.get<Row>(
      'SELECT * FROM place_traces WHERE trace_id = ? AND place_id = ? AND created_at_ms > ?',
      replyTo,
      r.place_id,
      cut,
    );
    if (!replyTarget) {
      throw cityBadRequest('找不到本处仍保留的原便签，无法回复。', 'trace_forbidden_content');
    }
  }

  const businessDate = c.today(at);
  const placeToday = c.db.scalar(
    'SELECT COUNT(*) FROM place_traces WHERE author_id = ? AND place_id = ? AND business_date = ?',
    r.resident_id,
    r.place_id,
    businessDate,
  );
  if (placeToday >= MAX_TRACES_PER_PLACE_PER_DAY) {
    throw new CityError(
      'RATE_LIMITED',
      `今天在「${place(r.place_id)?.name ?? r.place_id}」写的便签已达上限（每处每日最多 ${MAX_TRACES_PER_PLACE_PER_DAY} 条）。`,
      'trace_quota_exceeded',
    );
  }
  const cityToday = c.db.scalar(
    'SELECT COUNT(*) FROM place_traces WHERE author_id = ? AND business_date = ?',
    r.resident_id,
    businessDate,
  );
  if (cityToday >= MAX_TRACES_PER_DAY) {
    throw new CityError(
      'RATE_LIMITED',
      `今天在城里写下的便签已达上限（全城每日最多 ${MAX_TRACES_PER_DAY} 条）。`,
      'trace_quota_exceeded',
    );
  }

  const traceId = c.id('trc');
  c.db.run(
    `INSERT INTO place_traces(trace_id, place_id, author_id, author_name, author_origin, body, reply_to, visit_id, business_date, created_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    traceId,
    r.place_id,
    r.resident_id,
    r.name,
    r.origin,
    body,
    replyTo,
    visit?.visit_id ?? null,
    businessDate,
    at,
  );

  // 跨时间回复室友便签时，仅写入独立收件表 house_trace_replies（绝不写入 bridge_outbox）
  if (replyTarget && String(replyTarget.author_origin) === 'house' && String(replyTarget.author_id) !== r.resident_id) {
    const targetMember = c.db.get<{ actor_id: string }>(
      'SELECT actor_id FROM house_members WHERE resident_id = ?',
      String(replyTarget.author_id),
    );
    if (targetMember) {
      const metaHwRaw = Number(c.db.getMeta('trace_reply_high_water') ?? 0);
      const metaHw = Number.isFinite(metaHwRaw) && metaHwRaw >= 0 ? metaHwRaw : 0;
      const tableMax = c.db.scalar('SELECT COALESCE(MAX(reply_seq), 0) FROM house_trace_replies');
      const nextSeq = Math.max(metaHw, tableMax) + 1;
      const placeName = place(r.place_id)?.name ?? r.place_id;
      c.db.run(
        `INSERT INTO house_trace_replies(
          reply_seq, target_actor_id, trace_id, reply_trace_id, place_id, place_name,
          reply_author_name, reply_origin, excerpt, created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        nextSeq,
        targetMember.actor_id,
        String(replyTarget.trace_id),
        traceId,
        r.place_id,
        placeName,
        r.name,
        r.origin,
        excerptOf(body, 40),
        at,
      );
      c.db.setMeta('trace_reply_high_water', String(nextSeq));
    }
  }

  c.emitPublic(
    'place_trace_left',
    {
      trace_id: traceId,
      place: r.place_id,
      author_id: r.resident_id,
      author_name: r.name,
      author_origin: r.origin,
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    at,
  );

  return {
    status: 'completed',
    trace: {
      trace_id: traceId,
      place_id: r.place_id,
      author_name: r.name,
      author_origin: r.origin,
      body,
      ...(replyTo ? { reply_to: replyTo } : {}),
      created_at_ms: at,
    },
  };
}

export interface PlaceTraceViewItem {
  trace_id: string;
  author_name: string;
  author_origin: string;
  body: string;
  reply_to?: string;
  created_at_ms: number;
  untrusted: true;
}

export function projectPlaceTraces(
  c: CityService,
  viewer: Pick<CityResident, 'origin'>,
  placeId: string,
  at: number,
  tracesCap = 3,
  includeTraces?: boolean,
): PlaceTraceViewItem[] | undefined {
  if (!c.params.tracesEnabled || includeTraces === false || !isTraceSpot(placeId)) return undefined;
  if (viewer.origin === 'house' && !c.params.houseViewTraces) return undefined;
  const cap = Math.max(0, Math.floor(tracesCap));
  if (cap === 0) return [];
  const cut = at - c.params.eventRetentionMs;
  const rows = c.db.all<Row>(
    `SELECT trace_id, author_name, author_origin, body, reply_to, created_at_ms
     FROM place_traces
     WHERE place_id = ? AND created_at_ms > ?
     ORDER BY created_at_ms DESC, rowid DESC
     LIMIT ?`,
    placeId,
    cut,
    cap,
  );
  const picked: PlaceTraceViewItem[] = [];
  for (const row of rows) {
    const item: PlaceTraceViewItem = {
      trace_id: String(row.trace_id),
      author_name: String(row.author_name),
      author_origin: String(row.author_origin),
      body: String(row.body),
      ...(row.reply_to ? { reply_to: String(row.reply_to) } : {}),
      created_at_ms: Number(row.created_at_ms),
      untrusted: true,
    };
    const next = [...picked, item];
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_HERE_TRACES_BYTES) break;
    picked.push(item);
  }
  return picked;
}

export interface WakeTraceSummaryItem {
  trace_id: string;
  author_name: string;
  author_origin: string;
  excerpt: string;
  created_at_ms: number;
  untrusted: true;
}

export function wakeTracesSummary(c: CityService, placeId: string, at: number): WakeTraceSummaryItem[] | undefined {
  if (!areHouseTracesEnabled(c) || !isTraceSpot(placeId)) return undefined;
  const cut = at - c.params.eventRetentionMs;
  const rows = c.db.all<Row>(
    `SELECT trace_id, author_name, author_origin, body, created_at_ms
     FROM place_traces
     WHERE place_id = ? AND created_at_ms > ?
     ORDER BY created_at_ms DESC, rowid DESC
     LIMIT 2`,
    placeId,
    cut,
  );
  if (rows.length === 0) return undefined;
  const out: WakeTraceSummaryItem[] = [];
  for (const row of rows) {
    const item: WakeTraceSummaryItem = {
      trace_id: String(row.trace_id),
      author_name: String(row.author_name),
      author_origin: String(row.author_origin),
      excerpt: excerptOf(String(row.body), 40),
      created_at_ms: Number(row.created_at_ms),
      untrusted: true,
    };
    if (Buffer.byteLength(JSON.stringify([...out, item]), 'utf8') > 360) break;
    out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

export interface TraceReplyItem {
  reply_seq: number;
  target_actor_id: string;
  trace_id: string;
  reply_trace_id: string;
  place_id: string;
  place_name: string;
  reply_author_name: string;
  reply_origin: string;
  excerpt: string;
  created_at_ms: number;
  untrusted: true;
}

export function readTraceReplies(
  c: CityService,
  afterSeq: number,
  limit = 50,
): { replies: TraceReplyItem[]; next_after_seq: number } {
  if (!areHouseTracesEnabled(c)) {
    return { replies: [], next_after_seq: afterSeq };
  }
  const rows = c.db.all<Row>(
    `SELECT reply_seq, target_actor_id, trace_id, reply_trace_id, place_id, place_name,
            reply_author_name, reply_origin, excerpt, created_at_ms
     FROM house_trace_replies
     WHERE reply_seq > ?
     ORDER BY reply_seq ASC
     LIMIT ?`,
    afterSeq,
    limit,
  );
  const replies: TraceReplyItem[] = rows.map((row) => ({
    reply_seq: Number(row.reply_seq),
    target_actor_id: String(row.target_actor_id),
    trace_id: String(row.trace_id),
    reply_trace_id: String(row.reply_trace_id),
    place_id: String(row.place_id),
    place_name: String(row.place_name),
    reply_author_name: String(row.reply_author_name),
    reply_origin: String(row.reply_origin),
    excerpt: String(row.excerpt),
    created_at_ms: Number(row.created_at_ms),
    untrusted: true,
  }));
  const nextAfter = replies.length > 0 ? replies[replies.length - 1]!.reply_seq : afterSeq;
  return { replies, next_after_seq: nextAfter };
}

export interface CityPulseTraceItem {
  trace_id: string;
  place_id: string;
  place_name: string;
  author_name: string;
  author_origin: string;
  excerpt: string;
  created_at_ms: number;
  untrusted: true;
}

export interface CityPulseResponse {
  at_ms: number;
  weather_summary: string;
  highlights: string[];
  recent_traces: CityPulseTraceItem[];
  recent_external_names: string[];
}

export function cityPulseView(c: CityService): CityPulseResponse {
  const at = c.now();
  const snaps = allWeather(c);
  const weather_summary =
    snaps.length > 0
      ? snaps
          .map((s) => `${areaOf(s.area)?.name ?? s.area} ${s.text} ${s.temp_c}°C`)
          .join('；')
      : '晴空都气象同步中';
  const highlights = eventsToday(c, at)
    .filter((ev) => ev.ends_at_ms > at)
    .slice(0, 3)
    .map((ev) => excerptOf(`${areaOf(ev.area as any)?.name ?? ev.area}·${ev.title}`, 48));

  const houseTracesOpen = areHouseTracesEnabled(c);
  const recent_traces: CityPulseTraceItem[] = houseTracesOpen
    ? c.db
        .all<Row>(
          `SELECT trace_id, place_id, author_name, author_origin, body, created_at_ms
           FROM place_traces
           WHERE created_at_ms > ?
           ORDER BY created_at_ms DESC, rowid DESC
           LIMIT 5`,
          at - 24 * 3600_000,
        )
        .map((row) => {
          const pid = String(row.place_id);
          return {
            trace_id: String(row.trace_id),
            place_id: pid,
            place_name: place(pid)?.name ?? pid,
            author_name: String(row.author_name),
            author_origin: String(row.author_origin),
            excerpt: excerptOf(String(row.body), 40),
            created_at_ms: Number(row.created_at_ms),
            untrusted: true as const,
          };
        })
    : [];

  const recent_external_names: string[] = houseTracesOpen
    ? c.db
        .all<Row>(
          `SELECT author_name, MAX(created_at_ms) AS latest_at
           FROM place_traces
           WHERE author_origin = 'external' AND created_at_ms > ?
           GROUP BY author_name
           ORDER BY latest_at DESC
           LIMIT 6`,
          at - 12 * 3600_000,
        )
        .map((row) => String(row.author_name))
    : [];

  const out: CityPulseResponse = {
    at_ms: at,
    weather_summary,
    highlights,
    recent_traces,
    recent_external_names,
  };
  while (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_PULSE_BYTES) {
    if (out.recent_traces.length > 0) out.recent_traces.pop();
    else if (out.recent_external_names.length > 0) out.recent_external_names.pop();
    else if (out.highlights.length > 0) out.highlights.pop();
    else {
      out.weather_summary = excerptOf(out.weather_summary, 40);
      break;
    }
  }
  return out;
}

export function pruneTraces(c: CityService, now: number): void {
  const cut = now - c.params.eventRetentionMs;
  c.db.run('DELETE FROM place_traces WHERE created_at_ms <= ?', cut);
  for (const spot of TRACE_SPOTS) {
    c.db.run(
      `DELETE FROM place_traces
       WHERE place_id = ?
         AND trace_id NOT IN (
           SELECT trace_id FROM place_traces
           WHERE place_id = ?
           ORDER BY created_at_ms DESC, rowid DESC
           LIMIT ?
         )`,
      spot.placeId,
      spot.placeId,
      PRUNE_KEEP_PER_PLACE,
    );
  }
  c.db.run('DELETE FROM house_trace_replies WHERE created_at_ms <= ?', cut);
}

interface S2RestoreArchive {
  version: number;
  high_water?: number;
  place_traces: Row[];
  house_trace_replies: Row[];
}

export function installTraces(c: CityService): void {
  c.hooks.recover.push((now) => {
    const pendingFile = c.db.getMeta('s2_pending_restore_file');
    const expectedSha = c.db.getMeta('s2_pending_restore_sha256');
    if (!pendingFile && !expectedSha) return;

    if (!pendingFile || !expectedSha || c.db.inMemory || basename(pendingFile) !== pendingFile) {
      throw new Error(`S2 降级归档元数据异常（file=${pendingFile ?? ''}），拒绝以空表启动。`);
    }
    const archivePath = join(dirname(c.db.path), pendingFile);
    if (!existsSync(archivePath)) {
      throw new Error(`S2 降级归档缺失：${pendingFile}，拒绝以空表启动。`);
    }
    const rawBytes = readFileSync(archivePath);
    const actualSha = createHash('sha256').update(rawBytes).digest('hex');
    if (actualSha !== expectedSha) {
      throw new Error(`S2 降级归档校验失败（SHA-256 不匹配）：${pendingFile}，拒绝以空表启动。`);
    }

    let parsed: S2RestoreArchive;
    try {
      parsed = JSON.parse(rawBytes.toString('utf8')) as S2RestoreArchive;
    } catch (e) {
      throw new Error(`S2 降级归档解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (
      !parsed ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.place_traces) ||
      !Array.isArray(parsed.house_trace_replies)
    ) {
      throw new Error('S2 降级归档格式无效，拒绝以空表启动。');
    }

    const cut = now - c.params.eventRetentionMs;
    for (const row of parsed.place_traces) {
      if (Number(row.created_at_ms) <= cut) continue;
      c.db.run(
        `INSERT OR IGNORE INTO place_traces(
          trace_id, place_id, author_id, author_name, author_origin, body, reply_to, visit_id, business_date, created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        String(row.trace_id),
        String(row.place_id),
        String(row.author_id),
        String(row.author_name),
        String(row.author_origin),
        String(row.body),
        row.reply_to != null ? String(row.reply_to) : null,
        row.visit_id != null ? String(row.visit_id) : null,
        String(row.business_date),
        Number(row.created_at_ms),
      );
    }
    for (const row of parsed.house_trace_replies) {
      if (Number(row.created_at_ms) <= cut) continue;
      c.db.run(
        `INSERT OR IGNORE INTO house_trace_replies(
          reply_seq, target_actor_id, trace_id, reply_trace_id, place_id, place_name,
          reply_author_name, reply_origin, excerpt, created_at_ms
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        Number(row.reply_seq),
        String(row.target_actor_id),
        String(row.trace_id),
        String(row.reply_trace_id),
        String(row.place_id),
        String(row.place_name),
        String(row.reply_author_name),
        String(row.reply_origin),
        String(row.excerpt),
        Number(row.created_at_ms),
      );
    }

    const curHwRaw = Number(c.db.getMeta('trace_reply_high_water') ?? 0);
    const curHw = Number.isFinite(curHwRaw) && curHwRaw >= 0 ? curHwRaw : 0;
    const archHwRaw = Number(parsed.high_water ?? 0);
    const archHw = Number.isFinite(archHwRaw) && archHwRaw >= 0 ? archHwRaw : 0;
    const dbMax = c.db.scalar('SELECT COALESCE(MAX(reply_seq), 0) FROM house_trace_replies');
    const nextHw = Math.max(curHw, archHw, dbMax);
    if (nextHw > 0) c.db.setMeta('trace_reply_high_water', String(nextHw));

    c.db.run("DELETE FROM meta WHERE key IN ('s2_pending_restore_file', 's2_pending_restore_sha256')");
    c.db.setMeta('s2_last_restored_at_ms', String(now));
  });
}
