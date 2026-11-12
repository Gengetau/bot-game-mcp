/**
 * 聊天：附近聊天和全镇公屏（设计稿 v2.0 第 5、12、13 章）。
 *
 * 两条互相独立的通道，各有自己的发送入口、受众、游标和限额：
 *
 * - 附近聊天（动作 `say_nearby`，旧名 `speak` 是它的别名）：受众在发送的事务里按权威位置固定（hearing.ts），
 *   同场景实例、交谈距离内、同一个房间、有效在场、不在小游戏里。每个受众一条私有 `chat` 事件和一行 chat_audience；
 *   历史只回放「当时我在受众里」的那些。走远、换场景、进屋晚了的人不会收到，也补不回来。
 *   这条通道永远不会因为人走远或换场景变成全镇消息：发全镇必须显式用 `say_town`。
 * - 全镇公屏（动作 `say_town`）：独立的表、独立的连续序号（stream_heads 的 tc:<world>）。已认证的居民可以读保留期内的历史，
 *   不要求在场；只有有效在场且不在小游戏里的居民能发。匿名观众读不到（没有任何公开出口带它）。
 *   不逐条唤醒 AI：只有「明确提到我」或「和我有已有约定的人说的话」才给在场、不在小游戏里、没静音的居民发一条
 *   `town_chat_mention` 事件（带每人的唤醒额度，防止几个 AI 互相提及形成循环）；公共活动和求助消息在下一次读视图时
 *   以少量摘要的形式附带。对局中的居民既不被唤醒，视图里也没有公屏摘要。
 *
 * 游标是不透明字符串，绑定世界、主体和通道（service.ts 的 encodeCursor）：别人的或别的通道的游标无效，
 * 保留期之外的游标得到明确的重同步要求，不会退回成无筛选的全量查询。
 * 所有写入都在命令事务里；订阅者提交之后才被唤醒（`bumpTownChat` / `emitTo`）。
 */
import { sanitizeUserText } from '../core/text.js';
import { DESTINATIONS } from './content.js';
import { badRequest, precondition, WorldError } from './errors.js';
import { nearbyAudience } from './hearing.js';
import { counter, pairScope, takeToken } from './life.js';
import { card, zoneOf } from './project.js';
import type { WorldService } from './service.js';
import type { ResidentRow } from './types.js';

// ───────────────────────── 共用 ─────────────────────────

/**
 * 清洗并校验一条要发的话：先过 sanitizeUserText，空的和超长的都给明确的错误（不悄悄截断）。
 * lenient=true 只给旧动作名 `speak` 用：超长的按旧行为截到上限，保持老客户端不变。
 */
export function cleanChatText(w: WorldService, raw: unknown, lenient = false): string {
  if (typeof raw !== 'string') throw badRequest('需要 text（要说的话）。');
  const text = sanitizeUserText(raw).replace(/\s+/g, ' ').trim();
  if (!text) throw badRequest('说点什么吧。');
  const n = [...text].length;
  if (lenient) return n > w.params.chatMaxChars ? [...text].slice(0, w.params.chatMaxChars).join('') : text;
  if (n > w.params.chatMaxChars) {
    throw new WorldError('bad_request', `这句话太长了（${n} 字），最多 ${w.params.chatMaxChars} 字。`, 'text_too_long', { maxChars: w.params.chatMaxChars, chars: n });
  }
  return text;
}

const clip = (s: string, n: number): string => {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join('')}…`;
};

/** 不抛错的令牌桶（唤醒额度用）：有额度就扣一个并返回 true。 */
function tryToken(w: WorldService, residentId: string, bucket: string, capacity: number, perMinute: number, now: number): boolean {
  const row = w.db.get('SELECT tokens, updated_at FROM rate_buckets WHERE resident_id = ? AND bucket = ?', residentId, bucket);
  let tokens = capacity;
  if (row) tokens = Math.min(capacity, Number(row.tokens) + (Math.max(0, now - Number(row.updated_at)) / 60_000) * perMinute);
  if (tokens < 1) return false;
  w.db.run(
    `INSERT INTO rate_buckets(resident_id, bucket, tokens, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(resident_id, bucket) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
    residentId,
    bucket,
    tokens - 1,
    now,
  );
  return true;
}

// ───────────────────────── 附近聊天 ─────────────────────────

/** 对外的现场发言编号：每位居民自己连续的序号（stream_heads 的 chat:<id>）。内部 message_id 是全世界共用的，不外露。 */
function chatHigh(w: WorldService, residentId: string): number {
  return Number(w.db.scalar('SELECT high_water FROM stream_heads WHERE stream_key = ?', `chat:${residentId}`) ?? 0);
}
function chatSeqOf(w: WorldService, residentId: string, high: number, messageId: number): number {
  return high - Number(w.db.scalar('SELECT COUNT(*) FROM chat_audience WHERE resident_id = ? AND message_id > ?', residentId, messageId));
}

const nearbyScope = (residentId: string): string => `nh:${residentId}`;

export interface NearbyMessage {
  messageId: number;
  space: string;
  spaceName: string;
  from: ReturnType<typeof card>;
  text: string;
  at: number;
}

/**
 * 我听到过的现场发言（附近聊天），新的在前往回翻。只包含当时我在受众里的消息。
 * `before`：上一页返回的 `next`（不透明游标，绑定世界和本人），或旧版的序号数字（只当序号用）。
 * 游标无效（别人的、别的通道的、超出范围的）返回 `resync: true` 和空页：请重新读第一页。
 */
export function nearbyHistory(
  w: WorldService,
  residentId: string,
  before: number | string | null,
  limit: number,
  spaceNameOf: (spaceId: string) => string,
): { messages: NearbyMessage[]; next: string | null; resync?: true } {
  const lim = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 30)));
  const high = chatHigh(w, residentId);
  let beforeSeq: number | null = null;
  if (typeof before === 'string' && before !== '') {
    const n = /^\d{1,12}$/.test(before) ? Number(before) : w.decodeCursor('n', nearbyScope(residentId), before);
    if (n === null || n > high + 1) return { messages: [], next: null, resync: true };
    beforeSeq = n;
  } else if (typeof before === 'number' && Number.isFinite(before)) {
    beforeSeq = Math.floor(before);
  }
  // beforeSeq 是序号：跳过序号 >= beforeSeq 的那些（它们是最新的 high-beforeSeq+1 条）
  const skip = beforeSeq === null ? 0 : Math.max(0, high - beforeSeq + 1);
  const rows = w.db.all(
    `SELECT m.* FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id
     WHERE a.resident_id = ? ORDER BY a.message_id DESC LIMIT ? OFFSET ?`,
    residentId,
    lim + 1,
    skip,
  );
  const page = rows.slice(0, lim);
  const top = page.length ? chatSeqOf(w, residentId, high, Number(page[0]!.message_id)) : 0;
  const messages = page.map((m, i) => ({
    messageId: top - i,
    space: String(m.space_id),
    spaceName: spaceNameOf(String(m.space_id)),
    from: card(w.mustResident(String(m.sender_id))),
    text: String(m.body),
    at: Number(m.sent_at),
  }));
  return { messages, next: rows.length > lim ? w.encodeCursor('n', nearbyScope(residentId), top - (page.length - 1)) : null };
}

/** 视图里「刚才听到的话」：最近 30 分钟内我在受众里、而且是在我现在所在区域里说的消息（走到别处视图里就不再摆着，历史里仍然有）。 */
export function recentHeard(w: WorldService, residentId: string, space: string, now: number): { messageId: number; from: ReturnType<typeof card>; text: string; at: number }[] {
  const cut = now - 30 * 60_000;
  // message_id 随时间递增：给受众表的主键扫描加下界（30 分钟窗口内最早的消息），查询量与历史长度无关
  const rows = w.db.all(
    `SELECT m.message_id, m.sender_id, m.body, m.sent_at FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id
     WHERE a.resident_id = ? AND a.message_id >= (SELECT COALESCE(MIN(message_id), 9223372036854775807) FROM chat_messages WHERE sent_at > ?)
       AND m.space_id = ? AND m.sent_at > ? ORDER BY a.message_id DESC LIMIT 20`,
    residentId,
    cut,
    space,
    cut,
  );
  const high = chatHigh(w, residentId);
  return rows
    .reverse()
    .map((m) => ({ messageId: chatSeqOf(w, residentId, high, Number(m.message_id)), from: card(w.mustResident(String(m.sender_id))), text: String(m.body), at: Number(m.sent_at) }));
}

// ───────────────────────── 全镇公屏 ─────────────────────────

const townKey = (w: WorldService): string => `tc:${w.worldId}`;
const townScope = (residentId: string): string => `tc:${residentId}`;
const TOWN_KINDS = ['chat', 'activity', 'help'] as const;
type TownKind = (typeof TOWN_KINDS)[number];

export interface TownChatMessage {
  /** 不透明游标，同时是这条消息的编号：拿它当 before / after。绑定世界和读的人 */
  id: string;
  from: ReturnType<typeof card>;
  kind: TownKind;
  text: string;
  /** 活动 / 求助消息的位置提示：公共地点（区域级），没有坐标。只是提示，不能凭它远程做任何事 */
  place?: { id: string; name: string };
  at: number;
  mine: boolean;
}

export interface TownChatPage {
  /** 旧的在前 */
  messages: TownChatMessage[];
  /** 还有更早的（保留期内）时，用最旧一条的 id 当 before；没有就是 null */
  older: string | null;
  /** 当前最新位置的游标：之后用它当 after 追新消息 */
  cursor: string;
  /** after 查询时：后面还有，用返回的 cursor 接着取 */
  more?: true;
  /** 游标无效或已超出保留期：消息为空，请重新读最近一页（不带游标） */
  resync?: true;
}

function placeOf(id: unknown): { id: string; name: string } | undefined {
  const def = DESTINATIONS.find((p) => p.id === id);
  return def ? { id: def.id, name: def.name } : undefined;
}

function project(w: WorldService, viewerId: string, row: { seq: number; sender_id: string; kind: string; body: string; place: string | null; sent_at: number }): TownChatMessage {
  const place = placeOf(row.place);
  const sender = w.resident(String(row.sender_id));
  return {
    id: w.encodeCursor('c', townScope(viewerId), Number(row.seq)),
    from: sender ? card(sender) : { id: String(row.sender_id), name: '某位居民', kind: 'human' },
    kind: row.kind as TownKind,
    text: String(row.body),
    ...(place ? { place } : {}),
    at: Number(row.sent_at),
    mine: row.sender_id === viewerId,
  };
}

/** 保留期内最早的一条的序号（没有就是水位 + 1）。读的时候现算，不依赖清理任务有没有跑过。 */
function floorSeq(w: WorldService, now: number): number {
  const head = w.streamHead(townKey(w));
  const min = w.db.scalar('SELECT MIN(seq) FROM town_chat_messages WHERE world_id = ? AND sent_at >= ?', w.worldId, now - w.params.townChatRetentionMs);
  return Math.max(head.retainedFrom, min === null || min === undefined ? head.highWater + 1 : Number(min));
}

/**
 * 读公屏。调用方必须已经确认 residentId 是已认证、获准进入这个世界的居民；不要求在场，对局中也能读。
 * 没有游标：最近一页（默认 50 条）。before：比这个游标更早的一页。after：比这个游标更新的（最多一页，用于追新）。
 */
export function townChatPage(w: WorldService, residentId: string, q: { before?: string | null; after?: string | null; limit?: number } = {}, now: number = w.now()): TownChatPage {
  const head = w.streamHead(townKey(w));
  const headCursor = w.encodeCursor('c', townScope(residentId), head.highWater);
  const resync: TownChatPage = { messages: [], older: null, cursor: headCursor, resync: true };
  const size = Math.max(1, Math.min(w.params.townChatPageMax, Math.floor(Number(q.limit)) || w.params.townChatPageSize));
  const cut = now - w.params.townChatRetentionMs;
  const floor = floorSeq(w, now);
  const read = (sql: string, ...params: (string | number)[]) =>
    w.db.all<{ seq: number; sender_id: string; kind: string; body: string; place: string | null; sent_at: number }>(sql, ...params);

  if (q.before && q.after) throw badRequest('before 和 after 只能给一个。');
  if (q.after) {
    const n = w.decodeCursor('c', townScope(residentId), q.after);
    // 超出水位、无效、或者中间的消息已经过了保留期：重同步
    if (n === null || n > head.highWater || n < floor - 1) return resync;
    const rows = read('SELECT * FROM town_chat_messages WHERE world_id = ? AND seq > ? AND sent_at >= ? ORDER BY seq LIMIT ?', w.worldId, n, cut, size + 1);
    const page = rows.slice(0, size);
    const more = rows.length > size;
    const last = page[page.length - 1];
    return {
      messages: page.map((m) => project(w, residentId, m)),
      older: null,
      cursor: last ? w.encodeCursor('c', townScope(residentId), Number(last.seq)) : w.encodeCursor('c', townScope(residentId), n),
      ...(more ? { more: true as const } : {}),
    };
  }
  let beforeSeq = head.highWater + 1;
  if (q.before) {
    const n = w.decodeCursor('c', townScope(residentId), q.before);
    if (n === null || n > head.highWater + 1) return resync;
    beforeSeq = n;
  }
  const rows = read('SELECT * FROM town_chat_messages WHERE world_id = ? AND seq < ? AND sent_at >= ? ORDER BY seq DESC LIMIT ?', w.worldId, beforeSeq, cut, size + 1);
  const page = rows.slice(0, size).reverse();
  const oldest = page[0];
  return {
    messages: page.map((m) => project(w, residentId, m)),
    older: rows.length > size && oldest ? w.encodeCursor('c', townScope(residentId), Number(oldest.seq)) : null,
    cursor: headCursor,
  };
}

/** WebSocket 推送用：序号 afterSeq 之后的新消息（最多 limit 条）。afterSeq 由连接自己记，不外露。 */
export function townChatSince(w: WorldService, residentId: string, afterSeq: number, limit = 50, now: number = w.now()): { messages: TownChatMessage[]; seq: number; more: boolean } {
  const rows = w.db.all<{ seq: number; sender_id: string; kind: string; body: string; place: string | null; sent_at: number }>(
    'SELECT * FROM town_chat_messages WHERE world_id = ? AND seq > ? AND sent_at >= ? ORDER BY seq LIMIT ?',
    w.worldId,
    afterSeq,
    now - w.params.townChatRetentionMs,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { messages: page.map((m) => project(w, residentId, m)), seq: last ? Number(last.seq) : afterSeq, more: rows.length > limit };
}

/** 公屏当前的水位序号（连接记它当起点，不回放历史）。 */
export function townChatHead(w: WorldService): number {
  return w.streamHead(townKey(w)).highWater;
}

// ───────────────────────── 相关性（唤醒与摘要） ─────────────────────────

/** 和这位居民有「已有约定」的人：对方发给我的或我发给他的未决报价、同一桌还没开的小游戏、同一件还没结束的共同活动。 */
function commitmentPartners(w: WorldService, residentId: string): Set<string> {
  const out = new Set<string>();
  for (const row of w.db.all("SELECT from_id, to_id FROM offers WHERE status = 'open' AND (from_id = ? OR to_id = ?)", residentId, residentId)) {
    out.add(String(row.from_id === residentId ? row.to_id : row.from_id));
  }
  for (const row of w.db.all(
    `SELECT b.resident_id FROM activity_participants a JOIN activity_participants b ON b.activity_id = a.activity_id AND b.active = 1
     JOIN activities x ON x.activity_id = a.activity_id
     WHERE a.resident_id = ? AND a.active = 1 AND x.status IN ('forming','ready')`,
    residentId,
  )) {
    out.add(String(row.resident_id));
  }
  for (const row of w.db.all(
    `SELECT b.resident_id FROM interaction_participants a JOIN interaction_participants b ON b.interaction_id = a.interaction_id AND b.active = 1
     JOIN interactions x ON x.interaction_id = a.interaction_id
     WHERE a.resident_id = ? AND a.active = 1 AND x.status IN ('open','running')`,
    residentId,
  )) {
    out.add(String(row.resident_id));
  }
  out.delete(residentId);
  return out;
}

/** 明确提到：文字里有 @名字 或完整的名字（名字至少两个字，免得单字名字匹配一切）。 */
function mentions(text: string, name: string): boolean {
  const n = name.trim();
  if ([...n].length < 2) return false;
  return text.includes(`@${n}`) || text.includes(n);
}

function muted(r: ResidentRow): boolean {
  return r.state.settings.muteTownChat === true;
}

/**
 * 发一条公屏消息之后：给该唤醒的居民发 town_chat_mention。
 * 条件全部满足才发：在场、不在小游戏里、没静音、不是发言的人，而且「明确提到我」或「发言的人和我有已有约定」，
 * 并且这位居民的唤醒额度还有（额度用完这条消息仍然在频道里，只是不再叫醒她；下一次读视图的摘要里仍然会有）。
 */
function wakeFor(w: WorldService, sender: ResidentRow, text: string, kind: TownKind, place: { id: string; name: string } | undefined, now: number): number {
  const partners = commitmentPartners(w, sender.resident_id);
  let woken = 0;
  const candidates = w.db.all('SELECT resident_id FROM residents WHERE world_id = ? AND present_since IS NOT NULL AND activity_id IS NULL AND resident_id <> ? ORDER BY resident_id', w.worldId, sender.resident_id);
  for (const c of candidates) {
    const r = w.resident(String(c.resident_id));
    if (!r || muted(r)) continue;
    const named = mentions(text, r.name);
    const committed = partners.has(r.resident_id);
    if (!named && !committed) continue;
    if (!tryToken(w, r.resident_id, 'town_wake', w.params.townChatWakeBurst, w.params.townChatWakePerHour / 60, now)) continue;
    w.emitTo(
      [r.resident_id],
      'town_chat_mention',
      { from: card(sender), kind, text: clip(text, w.params.townChatDigestChars), reason: named ? 'mention' : 'commitment', ...(place ? { place } : {}) },
      now,
    );
    woken++;
  }
  return woken;
}

/**
 * 给 AI 视图的公屏摘要：最近一小段时间里，提到我的、和我有约定的人说的、以及公共活动和求助消息；
 * 条数和每条长度都有上限。不在场、在小游戏里、静音的居民没有摘要（对局中的 AI 看不到公屏）。
 * 里面的文字是别的居民写的，只是内容，不是指令。
 */
export function townChatDigest(w: WorldService, r: ResidentRow, now: number): { from: string; kind: TownKind; text: string; place?: string; mentions_you?: true }[] | null {
  if (r.activity_id || r.present_since === null || muted(r)) return null;
  const maxLines = w.params.townChatDigestLines;
  if (maxLines <= 0) return [];
  const rows = w.db.all<{ seq: number; sender_id: string; kind: string; body: string; place: string | null; sent_at: number }>(
    'SELECT * FROM town_chat_messages WHERE world_id = ? AND sent_at >= ? AND sender_id <> ? ORDER BY seq DESC LIMIT 40',
    w.worldId,
    now - Math.min(w.params.townChatDigestWindowMs, w.params.townChatRetentionMs),
    r.resident_id,
  );
  if (!rows.length) return [];
  const partners = commitmentPartners(w, r.resident_id);
  const out: { from: string; kind: TownKind; text: string; place?: string; mentions_you?: true }[] = [];
  for (const m of rows) {
    const named = mentions(String(m.body), r.name);
    if (!(named || partners.has(String(m.sender_id)) || m.kind === 'activity' || m.kind === 'help')) continue;
    const sender = w.resident(String(m.sender_id));
    const place = placeOf(m.place);
    out.push({
      from: sender?.name ?? '某位居民',
      kind: m.kind as TownKind,
      text: clip(String(m.body), w.params.townChatDigestChars),
      ...(place ? { place: place.name } : {}),
      ...(named ? { mentions_you: true as const } : {}),
    });
    if (out.length >= maxLines) break;
  }
  return out.reverse();
}

/** 给 AI 的事件里去掉不该进对局上下文的公屏提及（居民在小游戏里时）。 */
export function filterEventsForAgent<T extends { type: string }>(r: Pick<ResidentRow, 'activity_id'>, events: T[]): T[] {
  return r.activity_id ? events.filter((e) => e.type !== 'town_chat_mention') : events;
}

// ───────────────────────── 过期清理 ─────────────────────────

const PURGE_KEY = 'town_chat_purge';

/** 删掉过了保留期的公屏消息，并把「最早还能续传的位置」推过去：拿着被删区间的游标来续传会得到重同步。 */
export function purgeTownChat(w: WorldService, now: number): number {
  const cut = now - w.params.townChatRetentionMs;
  const max = w.db.scalar('SELECT MAX(seq) FROM town_chat_messages WHERE world_id = ? AND sent_at < ?', w.worldId, cut);
  if (max === null || max === undefined) return 0;
  const n = w.db.run('DELETE FROM town_chat_messages WHERE world_id = ? AND sent_at < ?', w.worldId, cut).changes;
  w.db.run('UPDATE stream_heads SET retained_from = MAX(retained_from, ?) WHERE stream_key = ?', Number(max) + 1, townKey(w));
  w.metrics.pruned += n;
  return n;
}

// ───────────────────────── 安装 ─────────────────────────

export function installChat(w: WorldService): void {
  // ── 附近聊天 ──
  const sayNearby = (lenient: boolean): Parameters<typeof w.handlers.set>[1] => ({ r, action, now }) => {
    const text = cleanChatText(w, action.text, lenient);
    takeToken(w, r.resident_id, 'chat', w.params.chatBurst, w.params.chatPerMinute, now, '说话');
    const space = w.spaceOf(r);
    // 受众在提交这一刻按权威位置固定
    const audience = nearbyAudience(w, r, now);
    const { lastInsertRowid: messageId } = w.db.run('INSERT INTO chat_messages(world_id, space_id, sender_id, body, sent_at) VALUES (?,?,?,?,?)', w.worldId, space, r.resident_id, text, now);
    // 对外编号是每位居民自己连续的序号，不是全局 message_id（空档会暴露别处的发言量）
    const seqOf = new Map<string, number>();
    for (const a of audience) {
      w.db.run('INSERT INTO chat_audience(resident_id, message_id) VALUES (?,?)', a.resident_id, messageId);
      const key = `chat:${a.resident_id}`;
      const seq = Number(w.db.scalar('SELECT high_water FROM stream_heads WHERE stream_key = ?', key) ?? 0) + 1;
      w.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1) ON CONFLICT(stream_key) DO UPDATE SET high_water = excluded.high_water', key, seq);
      seqOf.set(a.resident_id, seq);
      w.emitTo([a.resident_id], 'chat', { scope: 'nearby', space, from: card(r), text, messageId: seq }, now);
    }
    // 有来有往才算一次交谈：对方在我上一句之后（五分钟内）说过话，而且我当时听到了。
    // 自己连着说几句、对方没有新话，后面的不算。
    const myPrev = Number(w.db.scalar('SELECT MAX(message_id) FROM chat_messages WHERE sender_id = ? AND message_id < ?', r.resident_id, messageId) ?? 0);
    for (const other of audience) {
      if (other.resident_id === r.resident_id) continue;
      const replied = w.db.get(
        `SELECT m.message_id FROM chat_messages m JOIN chat_audience a ON a.message_id = m.message_id AND a.resident_id = ?
         WHERE m.sender_id = ? AND m.sent_at > ? AND m.message_id > ? LIMIT 1`,
        r.resident_id,
        other.resident_id,
        now - 5 * 60_000,
        myPrev,
      );
      // 每对居民每天只有前几次交谈形成事实（也就只有这几次带来熟悉度），刷屏不会堆出记录
      if (replied && counter(w, pairScope(r.resident_id, other.resident_id), 'chat', w.today(now)) < w.params.relationshipRewardEvents) {
        w.fact('conversation', [{ id: r.resident_id, role: 'speaker' }, { id: other.resident_id, role: 'speaker' }], { space: zoneOf(space) });
      }
    }
    return { status: 'completed', scope: 'nearby', messageId: seqOf.get(r.resident_id) ?? 0, heardBy: audience.length - 1 };
  };
  w.handlers.set('say_nearby', sayNearby(false));
  // 旧名：永远只是附近聊天，不会因为走远或换场景变成全镇消息；超长按旧行为截断（新动作名一律明确报错）
  w.handlers.set('speak', sayNearby(true));

  // ── 全镇公屏 ──
  w.handlers.set('say_town', ({ r, action, now }) => {
    if (r.present_since === null) throw precondition('你现在不在小镇里，不能在公屏发言。', 'not_present');
    if (r.activity_id) throw precondition('你正在一局游戏里，公屏现在只能看、不能发。', 'in_activity');
    const text = cleanChatText(w, action.text);
    const kind: TownKind = action.kind === undefined ? 'chat' : (TOWN_KINDS as readonly unknown[]).includes(action.kind) ? (action.kind as TownKind) : (() => {
      throw badRequest('kind 只能是 chat（闲聊）、activity（组织活动）或 help（求助）。');
    })();
    let place: { id: string; name: string } | undefined;
    if (action.place !== undefined && action.place !== null) {
      place = placeOf(action.place);
      if (!place) throw badRequest('place 只能是公共地点的编号（plaza、tea_house、bookshop、kitchen、garden、arcade、residential）。位置提示不能指向某户人家或具体坐标。');
    }
    // 重复内容：同一个人在窗口内说了一模一样的话
    const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const recent = w.db.all('SELECT body FROM town_chat_messages WHERE world_id = ? AND sender_id = ? AND sent_at >= ? ORDER BY seq DESC LIMIT 10', w.worldId, r.resident_id, now - w.params.townChatDuplicateWindowMs);
    if (recent.some((m) => norm(String(m.body)) === norm(text))) {
      throw precondition('刚刚已经发过一模一样的话了，换个说法或者稍后再发。', 'duplicate');
    }
    // 公屏自己的额度：与附近聊天、物件使用的额度互相独立；网页和 MCP 走同一条动作，所以共享这一份
    takeToken(w, r.resident_id, 'town_chat', w.params.townChatBurst, w.params.townChatPerMinute, now, '发公屏');
    const head = w.streamHead(townKey(w));
    const seq = head.highWater + 1;
    w.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1) ON CONFLICT(stream_key) DO UPDATE SET high_water = excluded.high_water', townKey(w), seq);
    w.db.run('INSERT INTO town_chat_messages(world_id, seq, sender_id, kind, body, place, sent_at) VALUES (?,?,?,?,?,?,?)', w.worldId, seq, r.resident_id, kind, text, place?.id ?? null, now);
    const woken = wakeFor(w, r, text, kind, place, now);
    w.bumpTownChat();
    return { status: 'completed', scope: 'town', id: w.encodeCursor('c', townScope(r.resident_id), seq), woken };
  });

  // ── 过期清理（定时任务） ──
  w.jobHandlers.set(PURGE_KEY, (_payload, _job, now) => {
    purgeTownChat(w, now);
    w.reschedule(PURGE_KEY, PURGE_KEY, now + w.params.townChatPurgeEveryMs, {});
  });
  w.hooks.recover.push((_downtime, now) => {
    w.reschedule(PURGE_KEY, PURGE_KEY, now + w.params.townChatPurgeEveryMs, {});
  });
}
