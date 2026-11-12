/**
 * 关系、共同经历、愿望和称号。
 *
 * 这些都只读程序记录的结构化事实（一起喝完了茶、还了书、打完了一局），不读聊天文字：
 * 说「我们是好朋友」不会改变任何数值，模型的叙述也不能直接写入长期事实。
 * 防刷：同一对居民每天每类往来只有前几次带来关系变化；互相来回送同一种东西不加分。
 */
import { GOALS, INTERACTIONS, INTERESTS, PLACES, DESTINATIONS, ENTRY_PLACE, SHOPS, EMBEDDED_GAMES, type GoalDef, type GoalPath } from './content.js';
import { type Row, parseJson } from './db.js';
import { badRequest, precondition } from './errors.js';
import { addMood, bumpCounter, counter, pairScope } from './life.js';
import { mint } from './property.js';
import type { FactRecord, WorldService } from './service.js';
import type { ResidentRow } from './types.js';

// ───────────────────────── 关系 ─────────────────────────

interface Gain {
  familiarity: number;
  closeness: number;
  category: string;
  /**
   * 亲近只记在这个角色的人身上（比如送礼：只有送的人对收的人更亲近，不替收礼的人决定她喜不喜欢）。
   * 不写就是双方都加。
   */
  closenessFor?: string;
  /** 给双方各留一条共同经历的摘要（程序模板，不含聊天原文） */
  memory?: string;
}

function bumpRelation(w: WorldService, a: string, b: string, g: Gain, now: number, closeOwner: string | null = null): void {
  for (const [x, y] of [
    [a, b],
    [b, a],
  ] as const) {
    w.db.run(
      `INSERT INTO relationships(resident_id, other_id, familiarity, closeness, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(resident_id, other_id) DO UPDATE SET familiarity = MIN(100, familiarity + excluded.familiarity),
         closeness = MIN(100, closeness + excluded.closeness), updated_at = excluded.updated_at`,
      x,
      y,
      Math.min(100, g.familiarity),
      closeOwner === null || closeOwner === x ? Math.min(100, g.closeness) : 0,
      now,
    );
  }
}

function remember(w: WorldService, ownerId: string, otherId: string | null, f: FactRecord, summary: string): void {
  w.db.run('INSERT INTO memory_refs(owner_id, other_id, event_id, kind, summary, occurred_at) VALUES (?,?,?,?,?,?)', ownerId, otherId, f.eventId, f.type, summary.slice(0, 80), f.occurredAt);
  // 每对居民只留最近的一小段（活跃视图取最近几条，更早的由日报承担）
  const keep = w.params.activeMemoryItems * 3;
  w.db.run(
    `DELETE FROM memory_refs WHERE owner_id = ? AND other_id IS ? AND ref_id NOT IN
       (SELECT ref_id FROM memory_refs WHERE owner_id = ? AND other_id IS ? ORDER BY ref_id DESC LIMIT ?)`,
    ownerId,
    otherId,
    ownerId,
    otherId,
    keep,
  );
}

export function relationLevel(familiarity: number): string {
  if (familiarity >= 40) return '老朋友';
  if (familiarity >= 20) return '朋友';
  if (familiarity >= 8) return '熟人';
  if (familiarity >= 1) return '见过面';
  return '陌生';
}

export interface RelationView {
  id: string;
  name: string;
  familiarity: number;
  closeness: number;
  level: string;
  memories: { text: string; at: number }[];
}

/** 本人眼里的关系（只给本人看）。 */
export function relationsOf(w: WorldService, residentId: string, limit = 30): RelationView[] {
  return w.db
    .all(
      `SELECT rel.*, r.name FROM relationships rel JOIN residents r ON r.resident_id = rel.other_id
       WHERE rel.resident_id = ? ORDER BY rel.familiarity DESC, rel.updated_at DESC LIMIT ?`,
      residentId,
      limit,
    )
    .map((row) => ({
      id: String(row.other_id),
      name: String(row.name),
      familiarity: Number(row.familiarity),
      closeness: Number(row.closeness),
      level: relationLevel(Number(row.familiarity)),
      memories: w.db
        .all('SELECT summary, occurred_at FROM memory_refs WHERE owner_id = ? AND other_id = ? ORDER BY ref_id DESC LIMIT ?', residentId, row.other_id, w.params.activeMemoryItems)
        .map((m) => ({ text: String(m.summary), at: Number(m.occurred_at) })),
    }));
}

export interface RelationMemoriesPage {
  memories: { text: string; at: number }[];
  /** 下一页游标（没有更早的了就是 null）。游标由发生时间和同刻序号组成，不含全局自增号。 */
  next: string | null;
}

/**
 * 与某位居民的共同记忆，新的在前，可翻页。每对最多保留 activeMemoryItems*3 条（更早的由日报承担）。
 * 只查本人的关系：对方必须是 residentId 认识的人。
 */
export function relationMemories(w: WorldService, residentId: string, otherId: string, cursor?: string | null, limit?: number): RelationMemoriesPage {
  if (!w.db.get('SELECT 1 AS x FROM relationships WHERE resident_id = ? AND other_id = ?', residentId, otherId)) throw precondition('你还不认识这位居民。', 'not_known');
  const cap = w.params.activeMemoryItems * 3;
  const size = Math.max(1, Math.min(cap, Math.floor(Number(limit)) || w.params.activeMemoryItems));
  let at = Number.MAX_SAFE_INTEGER;
  let skip = 0;
  if (cursor) {
    const m = /^(\d{1,16})\.(\d{1,4})$/.exec(cursor);
    if (!m) throw badRequest('cursor 不对，请用上一页返回的 next。');
    at = Number(m[1]);
    skip = Number(m[2]);
  }
  const rows = w.db.all(
    'SELECT summary, occurred_at FROM memory_refs WHERE owner_id = ? AND other_id = ? AND occurred_at <= ? ORDER BY occurred_at DESC, ref_id DESC LIMIT ?',
    residentId,
    otherId,
    at,
    size + skip + 1,
  );
  const rest = rows.slice(skip);
  const page = rest.slice(0, size);
  const more = rest.length > size;
  const last = page[page.length - 1];
  let next: string | null = null;
  if (more && last) {
    const lastAt = Number(last.occurred_at);
    const sameBefore = page.filter((m) => Number(m.occurred_at) === lastAt).length + (lastAt === at ? skip : 0);
    next = `${lastAt}.${sameBefore}`;
  }
  return { memories: page.map((m) => ({ text: String(m.summary), at: Number(m.occurred_at) })), next };
}

/** 这条事实对「一对居民」意味着什么。返回 null 表示不涉及关系。 */
function gainFor(f: FactRecord): Gain | null {
  const d = f.data as Record<string, any>;
  switch (f.type) {
    case 'interaction_completed':
      return Number(d.participants) >= 2 ? { familiarity: 2, closeness: 1, category: 'interaction', memory: `一起${String(d.name ?? '做了件事')}` } : null;
    case 'game_completed':
      return { familiarity: 2, closeness: 0, category: 'game', memory: `一起玩了一局${String(d.name ?? '游戏')}` };
    case 'gift_accepted':
      return { familiarity: 1, closeness: 2, closenessFor: 'giver', category: 'gift', memory: `送礼：${String(d.give ?? '')}` };
    case 'trade_completed':
      return { familiarity: 1, closeness: 0, category: 'trade', memory: `交换了东西` };
    case 'loan_returned':
      return { familiarity: 1, closeness: 2, category: 'loan', memory: `借的${String(d.item ?? '东西')}还回去了` };
    case 'loan_started':
      return { familiarity: 1, closeness: 0, category: 'lend', memory: `借出了${String(d.item ?? '东西')}` };
    case 'home_visit':
      return { familiarity: 2, closeness: 2, category: 'visit', memory: '登门拜访' };
    case 'asked_hobby':
      return { familiarity: 2, closeness: 0, category: 'ask', memory: Array.isArray(d.names) && d.names.length ? `聊到爱好：${d.names.join('、')}` : '聊到了爱好' };
    case 'conversation':
      return { familiarity: 1, closeness: 0, category: 'chat' };
    case 'letter_sent':
      return { familiarity: 1, closeness: 0, category: 'letter' };
    default:
      return null;
  }
}

function applyRelations(w: WorldService, f: FactRecord): void {
  const g = gainFor(f);
  if (!g) return;
  const ids = [...new Set(f.parties.map((p) => p.id))].filter((id) => w.resident(id));
  if (ids.length < 2) return;
  const date = w.today(f.occurredAt);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      const scope = pairScope(a, b);
      // 来回送同一种东西不加分：今天对方已经送过我同一种，这次只记事实
      if (f.type === 'gift_accepted') {
        const giver = f.parties.find((p) => p.role === 'giver')?.id ?? a;
        const receiver = giver === a ? b : a;
        const types = (f.data.giveTypes as string[] | undefined) ?? [];
        const coins = Number(f.data.coins ?? 0) > 0 ? ['coins'] : [];
        const all = [...types, ...coins];
        const roundTrip = all.length > 0 && all.every((t) => counter(w, `gift:${receiver}:${giver}`, t, date) > 0);
        for (const t of all) bumpCounter(w, `gift:${giver}:${receiver}`, t, date);
        if (roundTrip) continue;
      }
      // 每对居民每天每类往来只有前几次带来主要收益
      if (bumpCounter(w, scope, g.category, date) >= w.params.relationshipRewardEvents) continue;
      const closeOwner = g.closenessFor ? (f.parties.find((p) => p.role === g.closenessFor)?.id ?? null) : null;
      bumpRelation(w, a, b, g, f.occurredAt, closeOwner);
      if (g.memory) {
        remember(w, a, b, f, g.memory);
        remember(w, b, a, f, g.memory);
      }
    }
  }
}

// ───────────────────────── 愿望 ─────────────────────────

interface StoredGoalDef extends GoalDef {
  /** visit_place 这类愿望在创建时选定的参数 */
  place?: string;
}

interface GoalProgress {
  count: number;
  partners: string[];
}

export interface GoalView {
  id: string;
  kind: 'long' | 'short';
  title: string;
  description: string;
  progress: number;
  target: number;
  status: string;
  reward: number;
  completedAt?: number;
}

function goalView(w: WorldService, row: Row): GoalView {
  const def = parseJson<StoredGoalDef>(row.def_json, {} as StoredGoalDef);
  const p = parseJson<GoalProgress>(row.progress_json, { count: 0, partners: [] });
  return {
    id: String(row.goal_id),
    kind: row.kind,
    title: def.title,
    description: def.description,
    progress: Math.min(def.count, def.measure === 'partner' ? p.partners.length : p.count),
    target: def.count,
    status: String(row.status),
    reward: row.kind === 'long' ? w.params.longGoalReward : w.params.shortGoalReward,
    ...(row.completed_at ? { completedAt: Number(row.completed_at) } : {}),
  };
}

/**
 * 候选长期愿望：复用 resident_goals，status='replaced' 且 progress_json 带 offered 标记（不用迁移）。
 * 长期愿望完成后生成一小组，本人用 choose_goal 选一个；到下一个世界日仍没选，就删掉候选、按原来的随机逻辑补。
 */
const OFFER_SIZE = 3;
const OFFER_FILTER = "status = 'replaced' AND completed_at IS NULL AND kind = 'long' AND progress_json LIKE '%\"offered\":true%'";

function offerRows(w: WorldService, residentId: string): Row[] {
  return w.db.all(`SELECT * FROM resident_goals WHERE resident_id = ? AND ${OFFER_FILTER} ORDER BY created_at, goal_id`, residentId);
}

export function goalsOf(w: WorldService, residentId: string): GoalView[] {
  const active = w.db.all("SELECT * FROM resident_goals WHERE resident_id = ? AND status = 'active' ORDER BY kind, created_at", residentId).map((row) => goalView(w, row));
  // 候选只给本人（goalsOf 只用于本人视图）；status='offered'，用 choose_goal 的 goalId 选
  const offers = offerRows(w, residentId).map((row) => ({ ...goalView(w, row), status: 'offered' }));
  return [...active, ...offers];
}

export function titlesOf(w: WorldService, residentId: string, publicOnly: boolean): string[] {
  return w.db
    .all(`SELECT title FROM titles WHERE resident_id = ? ${publicOnly ? "AND visibility = 'public'" : ''} ORDER BY awarded_at`, residentId)
    .map((t) => String(t.title));
}

/** 这种愿望现在有没有完成路径（没有来源就不生成）。 */
function available(def: GoalDef): boolean {
  const req = def.requires;
  if (!req) return true;
  if (req.shopSku && !SHOPS.some((s) => s.goods.some((g) => g.sku === req.shopSku))) return false;
  if (req.embeddedGames && EMBEDDED_GAMES.length === 0) return false;
  if (req.interaction && !INTERACTIONS.some((i) => i.id === req.interaction)) return false;
  return true;
}

function interestWeight(def: GoalDef, r: ResidentRow): number {
  const tags = new Set(r.state.interests);
  const hit = (tag: string) => (tags.has(tag) ? 3 : 1);
  for (const p of def.paths) {
    const ix = p.where?.interaction ? INTERACTIONS.find((i) => i.id === p.where!.interaction) : undefined;
    if (ix) return hit(ix.tag);
    if (p.where?.itemType === 'book') return hit('books');
    if (p.fact === 'game_completed') return hit('games');
    if (p.fact === 'letter_sent') return hit('letters');
  }
  return 2;
}

function createGoal(w: WorldService, r: ResidentRow, kind: 'long' | 'short', now: number, exclude: Set<string>, offered = false): boolean {
  const active = new Set(w.db.all("SELECT def_id FROM resident_goals WHERE resident_id = ? AND status = 'active'", r.resident_id).map((x) => String(x.def_id)));
  const doneLong = new Set(w.db.all("SELECT def_id FROM resident_goals WHERE resident_id = ? AND status = 'completed' AND kind = 'long'", r.resident_id).map((x) => String(x.def_id)));
  let pool = GOALS.filter((g) => g.kind === kind && available(g) && !active.has(g.id) && !exclude.has(g.id) && !(kind === 'long' && doneLong.has(g.id)));
  // 长期愿望全部达成过：允许重新选已达成的方向（新实例，旧记录与称号保留）
  if (pool.length === 0 && kind === 'long') pool = GOALS.filter((g) => g.kind === 'long' && available(g) && !active.has(g.id) && !exclude.has(g.id));
  if (pool.length === 0) return false;
  const weights = pool.map((g) => interestWeight(g, r));
  let roll = w.rng.int(weights.reduce((s, x) => s + x, 0));
  let def: StoredGoalDef = pool[0]!;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) {
      def = pool[i]!;
      break;
    }
  }
  // 保存创建时的定义副本：以后内容更新不会悄悄提高这条愿望的要求
  let stored: StoredGoalDef = JSON.parse(JSON.stringify(def)) as StoredGoalDef;
  if (JSON.stringify(def).includes('$place')) {
    const prefer = r.state.interests.map((id) => INTERESTS.find((i) => i.id === id)?.place).filter((p): p is string => Boolean(p) && p !== r.location_id);
    const others = DESTINATIONS.filter((p) => p.kind === 'public' && p.id !== r.location_id && p.id !== ENTRY_PLACE).map((p) => p.id);
    const candidates = prefer.length ? prefer : others;
    const place = candidates[w.rng.int(candidates.length)]!;
    const name = PLACES.find((p) => p.id === place)!.name;
    stored = JSON.parse(JSON.stringify(def).replaceAll('$placeName', name).replaceAll('$place', place)) as StoredGoalDef;
    stored.place = place;
  }
  const progress: GoalProgress & { offered?: boolean } = { count: 0, partners: [] };
  if (offered) progress.offered = true;
  else if (stored.measure === 'owned') progress.count = ownedCount(w, r.resident_id, stored);
  w.db.run(
    `INSERT INTO resident_goals(goal_id, resident_id, def_id, def_version, def_json, kind, progress_json, status, created_at) VALUES (?,?,?,?,?,?,?,'${offered ? 'replaced' : 'active'}',?)`,
    w.id('g'),
    r.resident_id,
    def.id,
    def.version,
    JSON.stringify(stored),
    kind,
    JSON.stringify(progress),
    now,
  );
  return true;
}

function ownedCount(w: WorldService, residentId: string, def: GoalDef): number {
  const type = def.paths.find((p) => p.where?.itemType)?.where?.itemType;
  return type ? w.db.scalar('SELECT COALESCE(SUM(quantity), 0) FROM items WHERE owner_id = ? AND type = ?', residentId, type) : 0;
}

/** 把愿望补到规定数量（一个长期、两个短期）。每个世界日新建的短期愿望有上限，完成后不会立刻无限续上。 */
export function refillGoals(w: WorldService, r: ResidentRow, now: number): void {
  const count = (kind: string) => w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = ?", r.resident_id, kind);
  const date = w.today(now);
  const offers = offerRows(w, r.resident_id);
  if (offers.length > 0) {
    // 候选还在选择窗口里（同一个世界日）：先不补长期愿望；过了一天没选，作废候选，按原逻辑随机补
    if (offers.every((o) => w.today(Number(o.created_at)) === date)) {
      refillShort(w, r, now, date);
      return;
    }
    w.db.run(`DELETE FROM resident_goals WHERE resident_id = ? AND ${OFFER_FILTER}`, r.resident_id);
  }
  for (let n = count('long'); n < w.params.longGoals; n++) {
    if (counter(w, `goals:${r.resident_id}`, 'long', date) >= w.params.longGoals) break;
    if (!createGoal(w, r, 'long', now, new Set())) break;
    bumpCounter(w, `goals:${r.resident_id}`, 'long', date);
  }
  refillShort(w, r, now, date);
}

function refillShort(w: WorldService, r: ResidentRow, now: number, date: string): void {
  const count = (kind: string) => w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = ?", r.resident_id, kind);
  for (let n = count('short'); n < w.params.shortGoals; n++) {
    if (counter(w, `goals:${r.resident_id}`, 'short', date) >= w.params.shortGoals) break;
    if (!createGoal(w, r, 'short', now, new Set())) break;
    bumpCounter(w, `goals:${r.resident_id}`, 'short', date);
  }
}

function pathMatches(path: GoalPath, f: FactRecord, role: string): boolean {
  if (path.fact !== f.type) return false;
  const wh = path.where;
  if (!wh) return true;
  const d = f.data as Record<string, any>;
  if (wh.interaction && d.interaction !== wh.interaction) return false;
  if (wh.minParticipants && Number(d.participants ?? f.parties.length) < wh.minParticipants) return false;
  if (wh.place && d.place !== wh.place) return false;
  if (wh.role && role !== wh.role) return false;
  if (wh.itemType && d.itemType !== wh.itemType) return false;
  return true;
}

/** 长期愿望完成：生成一小组候选（占用当天的一个长期愿望名额，和原来的补位一样受每日上限约束）。 */
function offerLongGoals(w: WorldService, residentId: string, now: number): void {
  const r = w.mustResident(residentId);
  const date = w.today(now);
  const active = w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = 'long'", residentId);
  if (active >= w.params.longGoals || offerRows(w, residentId).length > 0) return;
  if (counter(w, `goals:${residentId}`, 'long', date) >= w.params.longGoals) return;
  const exclude = new Set<string>();
  let made = 0;
  for (let i = 0; i < OFFER_SIZE; i++) {
    const before = w.db.all(`SELECT def_id FROM resident_goals WHERE resident_id = ? AND ${OFFER_FILTER}`, residentId).map((x) => String(x.def_id));
    for (const id of before) exclude.add(id);
    if (!createGoal(w, r, 'long', now, exclude, true)) break;
    made++;
  }
  if (made > 0) bumpCounter(w, `goals:${residentId}`, 'long', date);
}

function applyGoals(w: WorldService, f: FactRecord): void {
  const seen = new Set<string>();
  for (const party of f.parties) {
    if (seen.has(party.id)) continue;
    seen.add(party.id);
    const goals = w.db.all("SELECT * FROM resident_goals WHERE resident_id = ? AND status = 'active'", party.id);
    for (const row of goals) {
      const def = parseJson<StoredGoalDef>(row.def_json, {} as StoredGoalDef);
      if (!def.paths?.some((p) => pathMatches(p, f, party.role))) continue;
      const p = parseJson<GoalProgress>(row.progress_json, { count: 0, partners: [] });
      if (def.measure === 'owned') p.count = ownedCount(w, party.id, def);
      else if (def.measure === 'partner') {
        for (const other of f.parties) if (other.id !== party.id && !p.partners.includes(other.id)) p.partners.push(other.id);
      } else p.count += 1;
      const value = def.measure === 'partner' ? p.partners.length : p.count;
      if (value < def.count) {
        w.db.run('UPDATE resident_goals SET progress_json = ? WHERE goal_id = ?', JSON.stringify(p), row.goal_id);
        w.emitTo([party.id], 'goal', { goal: goalView(w, { ...row, progress_json: JSON.stringify(p) }) }, f.occurredAt);
        continue;
      }
      // 完成：状态、奖励、称号在同一事务里，只结算一次（账本原因键兜底）
      const done = w.db.run("UPDATE resident_goals SET status = 'completed', progress_json = ?, completed_at = ?, completion_event_id = ? WHERE goal_id = ? AND status = 'active'", JSON.stringify(p), f.occurredAt, f.eventId, row.goal_id).changes;
      if (done !== 1) continue;
      const reward = row.kind === 'long' ? w.params.longGoalReward : w.params.shortGoalReward;
      mint(w, party.id, reward, `goal:${row.goal_id}`, 'goal_reward');
      if (def.title_award) {
        w.db.run("INSERT OR IGNORE INTO titles(resident_id, title, visibility, source, awarded_at) VALUES (?,?,'public',?,?)", party.id, def.title_award, `goal:${def.id}`, f.occurredAt);
      }
      if (row.kind === 'long') offerLongGoals(w, party.id, f.occurredAt);
      addMood(w, party.id, row.kind === 'long' ? 'happy' : 'content', `完成了愿望「${def.title}」`, f.eventId, f.occurredAt);
      w.emitTo([party.id], 'goal', { goal: goalView(w, { ...row, status: 'completed', progress_json: JSON.stringify(p), completed_at: f.occurredAt }), completed: true, reward, ...(def.title_award ? { title: def.title_award } : {}) }, f.occurredAt);
    }
  }
}

// ───────────────────────── 安装 ─────────────────────────

export function installSocial(w: WorldService): void {
  w.hooks.fact.push((f) => {
    applyRelations(w, f);
    applyGoals(w, f);
  });
  w.hooks.registered.push((r, now) => refillGoals(w, r, now));
  // 新的一天：给最近来过的居民补上空缺的愿望（很久没来的人，等回来那天再补）
  w.hooks.newDay.push((_date, now) => {
    const key = `newday:goals:${w.today(now)}`;
    if (w.db.get('SELECT 1 AS x FROM business_keys WHERE key = ?', key)) return;
    w.db.run('INSERT INTO business_keys(key, created_at) VALUES (?,?)', key, now);
    for (const row of w.db.all('SELECT resident_id FROM residents WHERE world_id = ? AND (present_since IS NOT NULL OR last_seen_at > ?)', w.worldId, now - 3 * 86400_000)) {
      refillGoals(w, w.mustResident(String(row.resident_id)), now);
    }
  });

  // 换掉一个短期愿望：每天一次，不能挑着换到满意为止
  w.handlers.set('replace_goal', ({ r, action, now }) => {
    const row = w.db.get("SELECT * FROM resident_goals WHERE goal_id = ? AND resident_id = ? AND status = 'active'", String(action.goalId ?? ''), r.resident_id);
    if (!row) throw precondition('没有这个愿望。', 'no_such_goal');
    if (row.kind !== 'short') throw precondition('长期愿望不能更换。', 'not_replaceable');
    const date = w.today(now);
    if (counter(w, `goals:${r.resident_id}`, 'swap', date) >= 1) throw precondition('今天已经换过一个愿望了，明天再换。', 'daily_limit');
    w.db.run("UPDATE resident_goals SET status = 'replaced', completed_at = ? WHERE goal_id = ?", now, row.goal_id);
    if (!createGoal(w, r, 'short', now, new Set([String(row.def_id)]))) throw precondition('暂时没有别的愿望可换。', 'none_available');
    bumpCounter(w, `goals:${r.resident_id}`, 'swap', date);
    return { status: 'completed', goals: goalsOf(w, r.resident_id) };
  });

  // 长期愿望完成后，从候选里自选新方向；其余候选作废
  w.handlers.set('choose_goal', ({ r, action }) => {
    const id = String(action.goalId ?? '');
    const row = offerRows(w, r.resident_id).find((o) => String(o.goal_id) === id);
    if (!row) throw precondition('没有这个候选愿望（可能已经选过或过期了）。', 'no_such_offer');
    if (w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = 'long'", r.resident_id) >= w.params.longGoals) {
      throw precondition('长期愿望已经满了。', 'goals_full');
    }
    const def = parseJson<StoredGoalDef>(row.def_json, {} as StoredGoalDef);
    const progress: GoalProgress = { count: 0, partners: [] };
    if (def.measure === 'owned') progress.count = ownedCount(w, r.resident_id, def);
    w.db.run("UPDATE resident_goals SET status = 'active', progress_json = ? WHERE goal_id = ?", JSON.stringify(progress), row.goal_id);
    w.db.run(`DELETE FROM resident_goals WHERE resident_id = ? AND ${OFFER_FILTER}`, r.resident_id);
    return { status: 'completed', goals: goalsOf(w, r.resident_id) };
  });
  void badRequest;
}

/** 回到小镇时补愿望（离开了几天的人）。 */
export function onReturn(w: WorldService, residentId: string, now: number): void {
  w.commit(() => refillGoals(w, w.mustResident(residentId), now));
}
