/**
 * 日常生活：询问爱好、三项软需要、短期情绪。（走路在 space.ts，说话在 chat.ts。）
 *
 * - 需要是软的：数值低不会禁止任何动作，只影响建议和效果的大小。社交、兴趣按有效在场时间惰性下降，离线不掉。
 */
import { INTERESTS, MOODS, homeOwner, isHome, placeDef } from './content.js';
import { badRequest, precondition, WorldError } from './errors.js';
import { card } from './project.js';
import { requirePersonReach } from './reach.js';
import type { WorldService } from './service.js';
import type { NeedsState, ResidentRow } from './types.js';

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

// ───────────────────────── 安装 ─────────────────────────

export function installLife(w: WorldService): void {
  // ── 询问爱好（结构化动作：不靠聊天文字判定） ──
  w.handlers.set('ask_hobby', ({ r, action, now }) => {
    const target = requirePersonReach(w, r, w.resident(String(action.target ?? '')), now);
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
