/**
 * 日常生活：移动、现场发言、询问爱好、三项软需要、短期情绪。
 *
 * - 移动：提交时算好路径和到达时间，到达由定时任务结算（保留应到达时间）。在途的人不属于任何地点。
 * - 现场发言：受众在提交那一刻固定（同一空间、在场、不在途、不在小游戏里），之后进来的人看不到这句。
 * - 需要是软的：数值低不会禁止任何动作，只影响建议和效果的大小。社交、兴趣按有效在场时间惰性下降，离线不掉。
 */
import { sanitizeUserText } from '../core/text.js';
import { INTERESTS, MOODS, STREETS, homeId, homeOwner, isHome, placeDef, shortestPath } from './content.js';
import { badRequest, precondition, WorldError } from './errors.js';
import { card, publicSpot, zoneOf } from './project.js';
import type { WorldService } from './service.js';
import type { MoveState, NeedsState, ResidentRow } from './types.js';

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));

// ───────────────────────── 需要 ─────────────────────────

export function effectivePresentMs(r: ResidentRow, now: number): number {
  return r.present_ms + (r.present_since !== null ? Math.max(0, now - r.present_since) : 0);
}

/** 惰性结算：只在读写时按有效在场时间补算下降，不改数据库。 */
export function settledNeeds(w: WorldService, r: ResidentRow, now: number): NeedsState {
  const n = r.state.needs;
  const total = effectivePresentMs(r, now);
  const hours = Math.max(0, total - n.asOfPresentMs) / 3600_000;
  return {
    energy: clamp(n.energy),
    social: clamp(n.social - hours * w.params.socialDecayPerHour),
    interest: clamp(n.interest - hours * w.params.interestDecayPerHour),
    asOfPresentMs: total,
  };
}

/** 结算后叠加变化并保存。 */
export function applyNeeds(w: WorldService, r: ResidentRow, delta: { energy?: number; social?: number; interest?: number }, now: number): NeedsState {
  const n = settledNeeds(w, r, now);
  n.energy = clamp(n.energy + (delta.energy ?? 0));
  n.social = clamp(n.social + (delta.social ?? 0));
  n.interest = clamp(n.interest + (delta.interest ?? 0));
  r.state.needs = n;
  w.saveResident(r);
  return n;
}

// ───────────────────────── 情绪 ─────────────────────────

/** 记一条短期情绪：一定有对应的事件来源和结束时间。 */
export function addMood(w: WorldService, residentId: string, mood: string, reason: string, eventId: number | null, now: number): void {
  if (!MOODS[mood]) return;
  w.db.run('DELETE FROM mood_effects WHERE resident_id = ? AND expires_at <= ?', residentId, now);
  w.db.run(
    'INSERT INTO mood_effects(resident_id, mood, reason, source_event_id, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    residentId,
    mood,
    reason.slice(0, 60),
    eventId,
    now,
    now + w.params.moodMaxDurationMs,
  );
}

export interface MoodView {
  id: string;
  name: string;
  /** 给本人看的来由；别人只看到名字 */
  reason?: string;
  until?: number;
  /** 真人自己设的展示 */
  custom?: boolean;
}

/** 当前情绪（最近一条未过期的）。forSelf=false 时遵守隐藏设置，且不带来由。 */
export function currentMood(w: WorldService, r: ResidentRow, now: number, forSelf: boolean): MoodView | null {
  if (!forSelf && !r.state.settings.showMood) return null;
  if (r.state.settings.moodOverride) return { id: 'custom', name: r.state.settings.moodOverride, custom: true };
  const row = w.db.get('SELECT mood, reason, expires_at FROM mood_effects WHERE resident_id = ? AND expires_at > ? ORDER BY mood_id DESC LIMIT 1', r.resident_id, now);
  if (!row) return null;
  const def = MOODS[String(row.mood)];
  if (!def) return null;
  return forSelf ? { id: row.mood, name: def.name, reason: row.reason, until: row.expires_at } : { id: row.mood, name: def.name };
}

// ───────────────────────── 限流 ─────────────────────────

/** 令牌桶（状态在数据库里，和动作同一事务）。不够时抛 rate_limited。 */
export function takeToken(w: WorldService, residentId: string, bucket: string, capacity: number, perMinute: number, now: number, what: string): void {
  const row = w.db.get('SELECT tokens, updated_at FROM rate_buckets WHERE resident_id = ? AND bucket = ?', residentId, bucket);
  let tokens = capacity;
  if (row) tokens = Math.min(capacity, Number(row.tokens) + (Math.max(0, now - Number(row.updated_at)) / 60_000) * perMinute);
  if (tokens < 1) {
    const waitMs = Math.ceil(((1 - tokens) / perMinute) * 60_000);
    throw new WorldError('rate_limited', `${what}太频繁了，歇 ${Math.ceil(waitMs / 1000)} 秒再试。`, bucket, { retryAfterMs: waitMs });
  }
  w.db.run(
    `INSERT INTO rate_buckets(resident_id, bucket, tokens, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(resident_id, bucket) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at`,
    residentId,
    bucket,
    tokens - 1,
    now,
  );
}

/** 每个世界日的计数器。返回递增前的值。 */
export function counter(w: WorldService, scope: string, category: string, date: string): number {
  return w.db.scalar('SELECT count FROM interaction_counters WHERE scope = ? AND category = ? AND business_date = ?', scope, category, date);
}

export function bumpCounter(w: WorldService, scope: string, category: string, date: string, by = 1): number {
  const before = counter(w, scope, category, date);
  w.db.run(
    `INSERT INTO interaction_counters(scope, category, business_date, count) VALUES (?,?,?,?)
     ON CONFLICT(scope, category, business_date) DO UPDATE SET count = count + excluded.count`,
    scope,
    category,
    date,
    by,
  );
  return before;
}

// ───────────────────────── 空间 ─────────────────────────

export function spaceName(w: WorldService, spaceId: string, viewerId?: string): string {
  if (isHome(spaceId)) {
    const owner = homeOwner(spaceId);
    if (owner === viewerId) return '你的家';
    return `${w.resident(owner)?.name ?? '某位居民'}的家`;
  }
  return placeDef(spaceId)?.name ?? spaceId;
}

/** 住宅门口在哪条街。 */
export function streetOfHome(w: WorldService, homeSpace: string): string {
  return w.resident(homeOwner(homeSpace))?.street_id ?? STREETS[0]!;
}

/** 两个空间之间的路径（含起点终点）。住宅挂在主人所在的那条街上。 */
export function routeBetween(w: WorldService, from: string, to: string): string[] | null {
  const fromNode = isHome(from) ? streetOfHome(w, from) : from;
  const toNode = isHome(to) ? streetOfHome(w, to) : to;
  const mid = shortestPath(fromNode, toNode);
  if (!mid) return null;
  return [...(isHome(from) ? [from] : []), ...mid, ...(isHome(to) ? [to] : [])];
}

export function routeDurationMs(w: WorldService, path: string[]): number {
  let ms = 0;
  for (let i = 1; i < path.length; i++) ms += isHome(path[i]!) || isHome(path[i - 1]!) ? w.params.doorDurationMs : w.params.moveDurationMs;
  return ms;
}

/** 进门权限检查由信件模块注册（主人永远可以；客人要有当前有效、已经得知的邀请）。 */
export type HomeAccessCheck = (r: ResidentRow, homeSpace: string, now: number) => { ok: true; grantId?: string } | { ok: false; why: string };
const homeAccess = new WeakMap<WorldService, HomeAccessCheck>();
export function setHomeAccessCheck(w: WorldService, fn: HomeAccessCheck): void {
  homeAccess.set(w, fn);
}
export function checkHomeAccess(w: WorldService, r: ResidentRow, homeSpace: string, now: number): ReturnType<HomeAccessCheck> {
  const fn = homeAccess.get(w);
  if (fn) return fn(r, homeSpace, now);
  return homeOwner(homeSpace) === r.resident_id ? { ok: true } : { ok: false, why: '没有受邀。' };
}

/** 两位居民之间的计数范围（不分方向）。 */
export function pairScope(a: string, b: string): string {
  return a < b ? `pair:${a}:${b}` : `pair:${b}:${a}`;
}

/** 把一位居民安置到某个空间（到达、被请出门都走这里）：通知现场的人、更新公开位置、触发到达钩子。 */
export function placeAt(w: WorldService, r: ResidentRow, spaceId: string, at: number, opts: { silent?: boolean } = {}): void {
  const beforeZone = publicSpot(r);
  r.location_id = spaceId;
  r.move = null;
  w.saveResident(r);
  if (r.present_since !== null && !opts.silent) {
    const others = w.audienceIn(spaceId).filter((x) => x.resident_id !== r.resident_id);
    w.emitTo(others.map((x) => x.resident_id), 'arrived', { resident: card(r), space: spaceId }, at);
    w.emitTo([r.resident_id], 'you_arrived', { space: spaceId, name: spaceName(w, spaceId, r.resident_id) }, at);
  }
  const after = publicSpot(r);
  if (r.present_since !== null && (beforeZone.at !== after.at || beforeZone.moving)) w.emitPublic('place', { resident: after }, at);
  for (const h of w.hooks.arrive) h(w.mustResident(r.resident_id), spaceId, at);
}

// ───────────────────────── 安装 ─────────────────────────

export function installLife(w: WorldService): void {
  // ── 移动 ──
  w.handlers.set('move', ({ r, action, now }) => {
    if (r.move) throw precondition('你正在路上，到了再说。', 'moving');
    let to = String(action.to ?? '');
    if (to === 'home') to = homeId(r.resident_id);
    if (isHome(to)) {
      if (!w.resident(homeOwner(to))) throw precondition('没有这户人家。', 'no_such_place');
      const access = checkHomeAccess(w, r, to, now);
      if (!access.ok) throw precondition(`进不去：${access.why}`, 'no_access');
    } else if (!placeDef(to)) {
      throw precondition('没有这个地方。', 'no_such_place');
    }
    if (to === r.location_id) throw precondition('你已经在这里了。', 'already_here');
    const path = routeBetween(w, r.location_id, to);
    if (!path) throw precondition('走不到那里。', 'no_route');
    const from = r.location_id;
    const move: MoveState = { from, to, path, startedAt: now, arriveAt: now + routeDurationMs(w, path) };
    // 离开原地：先让各模块收尾（撤销没完成的交换、退出共同活动），再通知现场的人
    for (const h of w.hooks.leaveSpace) h(r, from, now);
    const fresh = w.mustResident(r.resident_id);
    const others = w.audienceIn(from).filter((x) => x.resident_id !== r.resident_id);
    const spotBefore = JSON.stringify(publicSpot(fresh));
    fresh.move = move;
    w.saveResident(fresh);
    w.emitTo(others.map((x) => x.resident_id), 'left', { resident: card(fresh), space: from }, now);
    // 公开位置真的变了才进公开流：住宅区内部的走动、从住宅区出发的那一刻都不出现
    // （公开层面只到「住宅区」，出发和到达的时间差会暴露巷子和门）
    const spotAfter = publicSpot(fresh);
    if (JSON.stringify(spotAfter) !== spotBefore) w.emitPublic('place', { resident: spotAfter }, now);
    w.schedule('move_arrive', `move:${r.resident_id}:${now}`, move.arriveAt, { residentId: r.resident_id, startedAt: now });
    return { status: 'accepted', move: { to, path, arriveAt: move.arriveAt, toName: spaceName(w, to, r.resident_id) } };
  });

  w.jobHandlers.set('move_arrive', (payload) => {
    const r = w.resident(String(payload.residentId));
    if (!r || !r.move || r.move.startedAt !== payload.startedAt) return;
    const at = r.move.arriveAt;
    let dest = r.move.to;
    let blocked: string | null = null;
    if (isHome(dest)) {
      // 到门口时再查一次：路上邀请过期或被撤销，就停在门外
      const access = checkHomeAccess(w, r, dest, at);
      if (!access.ok) {
        blocked = access.why;
        dest = streetOfHome(w, dest);
      }
    }
    const target = r.move.to;
    placeAt(w, r, dest, at);
    if (blocked) w.emitTo([r.resident_id], 'notice', { text: `你走到了${spaceName(w, target, r.resident_id)}门口，但没能进去：${blocked}` }, at);
    if (!isHome(dest)) w.fact('arrived', [{ id: r.resident_id, role: 'self' }], { place: dest }, { occurredAt: at });
  });

  // ── 现场发言 ──
  w.handlers.set('speak', ({ r, action, now }) => {
    const space = w.spaceOf(r);
    if (!space) throw precondition('你正在路上，到了地方再说话。', 'moving');
    const raw = typeof action.text === 'string' ? action.text : '';
    const text = [...sanitizeUserText(raw).replace(/\s+/g, ' ').trim()].slice(0, w.params.chatMaxChars).join('');
    if (!text) throw badRequest('说点什么吧。');
    takeToken(w, r.resident_id, 'chat', w.params.chatBurst, w.params.chatPerMinute, now, '说话');
    // 受众在提交这一刻固定
    const audience = w.audienceIn(space);
    const { lastInsertRowid: messageId } = w.db.run('INSERT INTO chat_messages(world_id, space_id, sender_id, body, sent_at) VALUES (?,?,?,?,?)', w.worldId, space, r.resident_id, text, now);
    // 对外编号是每位居民自己连续的序号，不是全局 message_id（空档会暴露别处的发言量）
    const seqOf = new Map<string, number>();
    for (const a of audience) {
      w.db.run('INSERT INTO chat_audience(resident_id, message_id) VALUES (?,?)', a.resident_id, messageId);
      const key = `chat:${a.resident_id}`;
      const seq = Number(w.db.scalar('SELECT high_water FROM stream_heads WHERE stream_key = ?', key) ?? 0) + 1;
      w.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1) ON CONFLICT(stream_key) DO UPDATE SET high_water = excluded.high_water', key, seq);
      seqOf.set(a.resident_id, seq);
      w.emitTo([a.resident_id], 'chat', { space, from: card(r), text, messageId: seq }, now);
    }
    // 有来有往才算一次交谈：对方在我上一句之后（五分钟内）在同一空间说过话，而且我当时听到了。
    // 自己连着说几句、对方没有新话，后面的不算。
    const myPrev = Number(w.db.scalar('SELECT MAX(message_id) FROM chat_messages WHERE sender_id = ? AND space_id = ? AND message_id < ?', r.resident_id, space, messageId) ?? 0);
    for (const other of audience) {
      if (other.resident_id === r.resident_id) continue;
      const replied = w.db.get(
        `SELECT m.message_id FROM chat_messages m JOIN chat_audience a ON a.message_id = m.message_id AND a.resident_id = ?
         WHERE m.sender_id = ? AND m.space_id = ? AND m.sent_at > ? AND m.message_id > ? LIMIT 1`,
        r.resident_id,
        other.resident_id,
        space,
        now - 5 * 60_000,
        myPrev,
      );
      // 每对居民每天只有前几次交谈形成事实（也就只有这几次带来熟悉度），刷屏不会堆出记录
      if (replied && counter(w, pairScope(r.resident_id, other.resident_id), 'chat', w.today(now)) < w.params.relationshipRewardEvents) w.fact('conversation', [{ id: r.resident_id, role: 'speaker' }, { id: other.resident_id, role: 'speaker' }], { space: zoneOf(space) });
    }
    return { status: 'completed', messageId: seqOf.get(r.resident_id) ?? 0, heardBy: audience.length - 1 };
  });

  // ── 询问爱好（结构化动作：不靠聊天文字判定） ──
  w.handlers.set('ask_hobby', ({ r, action, now }) => {
    const space = w.spaceOf(r);
    const target = w.resident(String(action.target ?? ''));
    if (!space || !target || target.resident_id === r.resident_id || !w.interactive(target) || w.spaceOf(target) !== space) {
      throw precondition('对方不在你身边。', 'not_here');
    }
    if (!target.state.settings.allowAskHobby) throw precondition(`${target.name}现在不太想聊这个。`, 'declined');
    takeToken(w, r.resident_id, 'ask', 2, 2, now, '询问');
    const interests = target.state.interests.map((id) => INTERESTS.find((i) => i.id === id)).filter((x): x is (typeof INTERESTS)[number] => Boolean(x));
    const names = interests.map((i) => i.name);
    w.fact(
      'asked_hobby',
      [
        { id: r.resident_id, role: 'asker' },
        { id: target.resident_id, role: 'asked' },
      ],
      { interests: interests.map((i) => i.id), names },
    );
    w.emitTo([target.resident_id], 'asked_hobby', { from: card(r) }, now);
    return { status: 'completed', target: card(target), interests: interests.map((i) => ({ id: i.id, name: i.name })), text: names.length ? `${target.name}喜欢${names.join('、')}。` : `${target.name}还没说过自己喜欢什么。` };
  });
}
