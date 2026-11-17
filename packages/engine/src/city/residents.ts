/**
 * 城市里的居民：主体、身份映射、进城、在场。
 *
 * 两种居民：
 *  - 外部 bot（origin = external）：用自己的 MCP 身份进城，入口在新宿站或池袋站；第一次进城发一笔启动资金（每个主体只发一次）。
 *    在场靠租约维持（world_wait / 读视图 / 做动作都会续），断线超过租约就算离开；人不在场时不占地点、听不到话。
 *  - 小屋的室友（origin = house）：身份映射在启动时按配置建好（actor_id ↔ resident_id，建立后不改）。
 *    她们只能经「外出访问」从小屋门口进城（visits.ts），QQ 侧那把密钥进不来（ENTRY_VIA_HOME_ONLY）。
 */
import { sanitizeName, sanitizeUserText } from '../core/text.js';
import type { Row } from '../world/db.js';
import { publicPlace } from './catalog.js';
import { CityError, cityBadRequest, cityPrecondition } from './errors.js';
import { MINT, ensurePurse, ledger, purseOf } from './ledger.js';
import type { CityResident, CityService } from './service.js';

export interface CityPrincipal {
  principal_id: string;
  provider: string;
  subject: string;
  kind: 'human' | 'agent';
  display_name: string;
}

/** 别人能看到的名片：只有编号、名字和公开简介。 */
export function card(r: Pick<CityResident, 'resident_id' | 'name'> & { bio?: string }): { id: string; name: string; bio?: string } {
  return { id: r.resident_id, name: r.name, ...(r.bio ? { bio: r.bio } : {}) };
}

const cleanName = (raw: unknown, max = 16): string => sanitizeName(String(raw ?? '').replace(/\p{Cf}/gu, ''), max).trim();
const cleanBio = (raw: unknown): string => sanitizeUserText(String(raw ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80);
const skeleton = (name: string): string => name.normalize('NFKC').toLowerCase();

function nameTaken(c: CityService, name: string, exceptId?: string): boolean {
  const key = skeleton(name);
  return c.db.all<Row>('SELECT resident_id, name FROM residents').some((row) => row.resident_id !== exceptId && skeleton(String(row.name)) === key);
}

function upsertPrincipal(c: CityService, provider: string, subject: string, name: string): CityPrincipal {
  const existing = c.db.get<CityPrincipal & Row>('SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE provider = ? AND subject = ?', provider, subject);
  if (existing) return existing;
  const p: CityPrincipal = { principal_id: c.id('pri'), provider, subject, kind: 'agent', display_name: cleanName(name, 24) || '旅人' };
  c.db.run('INSERT INTO principals(principal_id, provider, subject, kind, display_name, created_at) VALUES (?,?,?,?,?,?)', p.principal_id, provider, subject, 'agent', p.display_name, c.now());
  return p;
}

/** 这个 MCP 身份是不是小屋某位室友在 QQ 侧的那把密钥。 */
export function isHouseIdentity(c: CityService, identityId: string): boolean {
  return c.house.some((m) => (m.qqIds ?? []).includes(String(identityId)));
}

/**
 * MCP 鉴权后的身份 → 城市里的主体。密钥绑定的身份登记在 'qq' 命名空间，自己认领的登记在 'open'（和栖灯镇同一套规矩）。
 * 小屋室友的 QQ 侧密钥在这里就拦下：不登记主体，不写任何东西。
 */
export function cityPrincipal(c: CityService, identity: { id: string; name: string }, opts: { selfClaimed?: boolean } = {}): CityPrincipal {
  if (isHouseIdentity(c, identity.id)) {
    throw new CityError('ENTRY_VIA_HOME_ONLY', '这位是小屋的室友：她要进城只能从家里出门（由小屋那边安排外出），这把密钥在城里只能看。');
  }
  return c.commit(() => upsertPrincipal(c, opts.selfClaimed ? 'open' : 'qq', String(identity.id), identity.name));
}

/** 只读查找（不登记）。 */
export function findPrincipal(c: CityService, identity: { id: string }, opts: { selfClaimed?: boolean } = {}): CityPrincipal | undefined {
  return c.db.get<CityPrincipal & Row>('SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE provider = ? AND subject = ?', opts.selfClaimed ? 'open' : 'qq', String(identity.id));
}

/** 启动时按配置建好小屋室友的身份映射。已有的映射不动，只同步显示名和简介。 */
export function ensureHouseMembers(c: CityService): void {
  const now = c.now();
  for (const m of c.house) {
    const name = cleanName(m.name) || m.actorId;
    const bio = cleanBio(m.bio ?? '');
    const row = c.db.get<{ resident_id: string }>('SELECT resident_id FROM house_members WHERE actor_id = ?', m.actorId);
    if (row) {
      const r = c.mustResident(row.resident_id);
      if ((r.name !== name && !nameTaken(c, name, r.resident_id)) || r.bio !== bio) {
        c.db.run('UPDATE residents SET name = ?, bio = ?, revision = revision + 1 WHERE resident_id = ?', nameTaken(c, name, r.resident_id) ? r.name : name, bio, r.resident_id);
      }
      continue;
    }
    if (nameTaken(c, name)) throw new Error(`小屋室友的名字和城里已有的居民重名：${name}`);
    const principal = upsertPrincipal(c, 'ai-house', m.actorId, name);
    const residentId = c.id('res');
    c.db.run("INSERT INTO residents(resident_id, principal_id, name, bio, origin, in_city, created_at, last_seen_at) VALUES (?,?,?,?,'house',0,?,?)", residentId, principal.principal_id, name, bio, now, now);
    c.db.run('INSERT INTO house_members(actor_id, resident_id, last_epoch, created_at) VALUES (?,?,0,?)', m.actorId, residentId, now);
    ensurePurse(c, residentId);
  }
}

export interface EnterInput {
  name?: unknown;
  bio?: unknown;
  /** 第一次进城的入口：shinjuku:station 或 ikebukuro:station */
  entry?: unknown;
}

export const ENTRY_PLACES = ['shinjuku:station', 'ikebukuro:station'] as const;

/** 外部 bot 进城（或回到城里）。幂等：已经在场只续租约。 */
export function enterCity(c: CityService, principal: CityPrincipal, input: EnterInput = {}): { resident: CityResident; created: boolean; granted_yen: number } {
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    let r = c.residentOfPrincipal(principal.principal_id);
    let created = false;
    if (r && r.origin !== 'external') throw new CityError('ENTRY_VIA_HOME_ONLY', '小屋的室友只能从家里出门进城。');
    if (!r) {
      const name = cleanName(input.name ?? principal.display_name);
      if (name.length < 1) throw cityBadRequest('第一次进城需要 name（1~16 个字的显示名）。', 'name_required');
      if (nameTaken(c, name)) throw cityPrecondition('这个名字已经有人用了，换一个。', 'name_taken');
      const id = c.id('res');
      c.db.run("INSERT INTO residents(resident_id, principal_id, name, bio, origin, in_city, created_at, last_seen_at) VALUES (?,?,?,?,'external',0,?,?)", id, principal.principal_id, name, cleanBio(input.bio), now, now);
      ensurePurse(c, id);
      r = c.mustResident(id);
      created = true;
    } else if (input.bio !== undefined && cleanBio(input.bio) !== r.bio) {
      c.db.run('UPDATE residents SET bio = ?, revision = revision + 1 WHERE resident_id = ?', cleanBio(input.bio), r.resident_id);
    }
    // 启动资金：每个主体只发一次（原因键永久唯一），之后没有任何持续收入
    const granted = ledger(c, `grant:first-entry:${principal.principal_id}`, 'grant', '进城启动资金', [[MINT, -c.params.firstEntryGrantYen], [purseOf(r.resident_id), c.params.firstEntryGrantYen]]);
    const wasPresent = r.in_city === 1;
    if (!wasPresent) {
      const others = c.db.scalar("SELECT COUNT(*) FROM residents WHERE origin = 'external' AND in_city = 1 AND resident_id <> ?", r.resident_id);
      if (others >= c.params.maxPresentExternal) throw cityPrecondition('城里现在人满了，过一会儿再来。', 'city_full', { retryAfterMs: 60_000 });
    }
    // 第一次进城落在入口车站；之后回来还在上次离开的地方（在路上的行程照常到站）
    let placeId = r.place_id;
    if (!placeId && !r.trip_id) {
      const entry = input.entry === undefined || input.entry === null ? c.params.entryPlace : String(input.entry);
      if (!(ENTRY_PLACES as readonly string[]).includes(entry) || !publicPlace(entry)) throw cityBadRequest(`入口只能是 ${ENTRY_PLACES.join(' 或 ')}。`, 'bad_entry');
      placeId = entry;
    }
    const until = now + c.params.presenceLeaseMs;
    c.db.run('UPDATE residents SET in_city = 1, place_id = ?, present_until = ?, last_seen_at = ?, revision = revision + 1 WHERE resident_id = ?', placeId, until, now, r.resident_id);
    c.reschedule('presence_expire', `pres:${r.resident_id}`, until, { residentId: r.resident_id });
    const fresh = c.mustResident(r.resident_id);
    if (!wasPresent && placeId) {
      c.emitTo(c.presentAt(placeId).filter((x) => x.resident_id !== fresh.resident_id).map((x) => x.resident_id), 'arrived', { who: card(fresh), place: placeId }, now);
    }
    return { resident: fresh, created, granted_yen: granted ? c.params.firstEntryGrantYen : 0 };
  });
}

/** 续在场租约（等待、读视图、做动作都算「还在」）。不在场就什么都不做。 */
export function touchPresence(c: CityService, residentId: string): void {
  const r = c.resident(residentId);
  if (!r || r.origin !== 'external' || !r.in_city) return;
  const now = c.now();
  // 租约还剩一大半就不写库：等待循环里每次都写没有意义
  if (r.present_until - now > c.params.presenceLeaseMs * 0.6) return;
  c.commit(() => {
    const until = now + c.params.presenceLeaseMs;
    c.db.run('UPDATE residents SET present_until = ?, last_seen_at = ? WHERE resident_id = ?', until, now, residentId);
    c.reschedule('presence_expire', `pres:${residentId}`, until, { residentId });
  });
}

function depart(c: CityService, r: CityResident, at: number): void {
  c.db.run('UPDATE residents SET in_city = 0, present_until = 0, last_seen_at = ?, revision = revision + 1 WHERE resident_id = ?', at, r.resident_id);
  c.cancelJob(`pres:${r.resident_id}`);
  if (r.place_id && publicPlace(r.place_id)) {
    c.emitTo(c.presentAt(r.place_id).filter((x) => x.resident_id !== r.resident_id).map((x) => x.resident_id), 'left', { who: card(r), place: r.place_id }, at);
  }
}

/** 外部 bot 主动离开。钱和东西都留着；在路上的行程照常到站，只是人不在场。 */
export function leaveCity(c: CityService, residentId: string): { ok: true } {
  return c.commit(() => {
    const r = c.resident(residentId);
    if (r && r.origin === 'external' && r.in_city) depart(c, r, c.now());
    return { ok: true as const };
  });
}

export function installResidents(c: CityService): void {
  c.jobHandlers.set('presence_expire', (payload, _job, now) => {
    const r = c.resident(String(payload.residentId));
    if (!r || r.origin !== 'external' || !r.in_city) return;
    if (r.present_until > now) {
      c.reschedule('presence_expire', `pres:${r.resident_id}`, r.present_until, { residentId: r.resident_id });
      return;
    }
    depart(c, r, now);
  });
}
