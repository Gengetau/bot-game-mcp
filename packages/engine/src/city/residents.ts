/**
 * 城市里的居民：主体、身份映射、进城、在场。
 *
 * 两种居民：
 *  - 外部 bot（origin = external）：用自己的 MCP 身份进城，入口在云港站或棱光街站；第一次进城发一笔启动资金（每个主体只发一次）。
 *    在场靠租约维持（world_wait / 读视图 / 做动作都会续），断线超过租约就算离开；人不在场时不占地点、听不到话。
 *  - 小屋的室友（origin = house）：身份映射在启动时按配置建好（actor_id ↔ resident_id，建立后不改）。
 *    她们只能经「外出访问」从小屋门口进城（visits.ts），QQ 侧那把密钥进不来（ENTRY_VIA_HOME_ONLY）。
 */
import { randomBytes } from 'node:crypto';
import { sanitizeName, sanitizeUserText } from '../core/text.js';
import type { Row } from '../world/db.js';
import { sha256 } from '../world/service.js';
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

export interface CityWebSession {
  tokenHash: string;
  csrfToken: string;
  expiresAtMs: number;
  principal: CityPrincipal;
  resident: CityResident | null;
}

/** 别人能看到的名片：只有编号、名字和公开简介。 */
export function card(r: Pick<CityResident, 'resident_id' | 'name'> & { bio?: string }): { id: string; name: string; bio?: string } {
  return { id: r.resident_id, name: r.name, ...(r.bio ? { bio: r.bio } : {}) };
}

const cleanName = (raw: unknown, max = 16): string => sanitizeName(String(raw ?? '').replace(/\p{Cf}/gu, ''), max).trim();
const cleanBio = (raw: unknown): string => sanitizeUserText(String(raw ?? '')).replace(/\s+/g, ' ').trim().slice(0, 80);
const skeleton = (name: string): string => name.normalize('NFKC').toLowerCase();

const RAW_CLIENT_ID_RE = /^[\w.-]{4,80}$/;

export function normalizeClientId(channel: 'mcp' | 'web', raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const stripped = s.startsWith(`${channel}:`) ? s.slice(channel.length + 1) : s;
  if (!RAW_CLIENT_ID_RE.test(stripped)) {
    throw cityBadRequest('client_id 格式不合法（需要 4~80 位字母、数字或 ._-）。', 'bad_client_id');
  }
  return `${channel}:${stripped}`;
}

function nameTaken(c: CityService, name: string, exceptId?: string): boolean {
  const key = skeleton(name);
  return c.db.all<Row>('SELECT resident_id, name FROM residents').some((row) => row.resident_id !== exceptId && skeleton(String(row.name)) === key);
}

function upsertPrincipal(c: CityService, provider: string, subject: string, kind: 'human' | 'agent', name: string): CityPrincipal {
  const existing = c.db.get<CityPrincipal & Row>('SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE provider = ? AND subject = ?', provider, subject);
  if (existing) {
    if (existing.kind !== kind) {
      throw new CityError(
        'FORBIDDEN',
        existing.kind === 'human' ? '这个账号已经登记为真人居民，不能作为 AI 身份使用。' : '这个账号已经登记为 AI 身份，不能签发真人登录票据。',
        existing.kind === 'human' ? 'human_account' : 'agent_account',
      );
    }
    const cleaned = cleanName(name, 24);
    if (cleaned && cleaned !== existing.display_name) {
      c.db.run('UPDATE principals SET display_name = ? WHERE principal_id = ?', cleaned, existing.principal_id);
      return { ...existing, display_name: cleaned };
    }
    return existing;
  }
  const p: CityPrincipal = { principal_id: c.id('pri'), provider, subject, kind, display_name: cleanName(name, 24) || '旅人' };
  c.db.run('INSERT INTO principals(principal_id, provider, subject, kind, display_name, created_at) VALUES (?,?,?,?,?,?)', p.principal_id, provider, subject, kind, p.display_name, c.now());
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
  return c.commit(() => upsertPrincipal(c, opts.selfClaimed ? 'open' : 'qq', String(identity.id), 'agent', identity.name));
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
    // 名字被城里已有的居民占了（以后才加进配置的室友）：不让服务卡在启动上，先用带编号的名字，主人改配置后下次启动会改回来
    let shown = name;
    if (nameTaken(c, shown)) {
      shown = cleanName(`${name}·${m.actorId}`) || m.actorId;
      for (let n = 2; nameTaken(c, shown); n++) shown = cleanName(`${m.actorId}${n}`);
      c.log(`[city] 室友 ${m.actorId} 的名字「${name}」已经被城里的居民用了，暂时显示为「${shown}」`);
    }
    const principal = upsertPrincipal(c, 'ai-house', m.actorId, 'agent', shown);
    const residentId = c.id('res');
    c.db.run("INSERT INTO residents(resident_id, principal_id, name, bio, origin, in_city, created_at, last_seen_at) VALUES (?,?,?,?,'house',0,?,?)", residentId, principal.principal_id, shown, bio, now, now);
    c.db.run('INSERT INTO house_members(actor_id, resident_id, last_epoch, created_at) VALUES (?,?,0,?)', m.actorId, residentId, now);
    ensurePurse(c, residentId);
  }
}

/** 拼接人类网页端登录票据 URL（票据放在 URL Fragment #ticket= 中，不进服务器访问日志与 Referer）。 */
export function buildPlayTicketUrl(publicUrl: string | null, ticket: string): string | null {
  if (!publicUrl) return null;
  const trimmed = publicUrl.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '');
  const base = trimmed.endsWith('/city/play')
    ? `${trimmed}/`
    : trimmed.endsWith('/city')
      ? `${trimmed}/play/`
      : `${trimmed}/`;
  return `${base}#ticket=${ticket}`;
}

/** 给真人 QQ 账号签发 5 分钟有效的一次性进城票据（库内仅存 SHA-256 哈希）。 */
export function issueCityTicket(
  c: CityService,
  input: { userId: string; name?: string },
): { ok: true; ticket: string; expires_at_ms: number; url: string | null; note: string } {
  const userId = String(input.userId ?? '').trim();
  if (!/^[\w.-]{1,64}$/.test(userId)) throw cityBadRequest('user_id 格式不合法。', 'bad_user_id');
  if (isHouseIdentity(c, userId)) {
    throw new CityError('FORBIDDEN', '小屋室友账号不能签发真人网页登录票据。', 'agent_account');
  }
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    const principal = upsertPrincipal(c, 'qq', userId, 'human', input.name || userId);
    const ticket = randomBytes(24).toString('base64url');
    const ticketHash = sha256(ticket);
    const expiresAt = now + c.params.loginTicketTtlMs;
    c.db.run('DELETE FROM login_tickets WHERE expires_at <= ? AND redeemed_at IS NULL', now - 86_400_000);
    c.db.run(
      'INSERT INTO login_tickets(ticket_hash, principal_id, created_at, expires_at, redeemed_at) VALUES (?,?,?,?,NULL)',
      ticketHash,
      principal.principal_id,
      now,
      expiresAt,
    );
    return {
      ok: true as const,
      ticket,
      expires_at_ms: expiresAt,
      url: buildPlayTicketUrl(c.publicUrl, ticket),
      note: '一次性登录票据（5 分钟内有效），仅限私聊发给本人，切勿发到群聊或写入日志。',
    };
  });
}

function createWebSession(c: CityService, principal: CityPrincipal, now: number) {
  const sessionToken = randomBytes(24).toString('base64url');
  const tokenHash = sha256(sessionToken);
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAtMs = now + c.params.sessionTtlMs;
  c.db.run(
    'INSERT INTO web_sessions(token_hash, principal_id, csrf_token, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,NULL)',
    tokenHash,
    principal.principal_id,
    csrfToken,
    now,
    expiresAtMs,
  );
  const r = c.residentOfPrincipal(principal.principal_id);
  return {
    sessionToken,
    tokenHash,
    csrfToken,
    expiresAtMs,
    principal: { principal_id: principal.principal_id, display_name: principal.display_name, kind: principal.kind },
    resident: r ? { id: r.resident_id, name: r.name, in_city: r.in_city === 1 } : null,
  };
}

/** 浏览器端用一次性票据原子兑换网页会话。无效、过期或重复使用统一返回 401 invalid_ticket。 */
export function exchangeCityTicket(c: CityService, rawTicket: unknown) {
  let token = typeof rawTicket === 'string' ? rawTicket.trim() : '';
  if (token.startsWith('#ticket=')) token = token.slice('#ticket='.length);
  else if (token.startsWith('ticket=')) token = token.slice('ticket='.length);
  if (!token || token.length > 200) {
    throw new CityError('UNAUTHENTICATED', '登录票据无效、已过期或已经用过，请在群里重新发送「晴空都」获取新链接。', 'invalid_ticket');
  }
  const ticketHash = sha256(token);
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    const row = c.db.get<{ principal_id: string; expires_at: number; redeemed_at: number | null }>(
      'SELECT principal_id, expires_at, redeemed_at FROM login_tickets WHERE ticket_hash = ?',
      ticketHash,
    );
    if (!row || row.redeemed_at !== null || Number(row.expires_at) <= now) {
      throw new CityError('UNAUTHENTICATED', '登录票据无效、已过期或已经用过，请在群里重新发送「晴空都」获取新链接。', 'invalid_ticket');
    }
    const updated = c.db.run(
      'UPDATE login_tickets SET redeemed_at = ? WHERE ticket_hash = ? AND redeemed_at IS NULL AND expires_at > ?',
      now,
      ticketHash,
      now,
    );
    if (updated.changes === 0) {
      throw new CityError('UNAUTHENTICATED', '登录票据无效、已过期或已经用过，请在群里重新发送「晴空都」获取新链接。', 'invalid_ticket');
    }
    const principal = c.db.get<CityPrincipal & Row>(
      'SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE principal_id = ?',
      row.principal_id,
    );
    if (!principal || principal.kind !== 'human') {
      throw new CityError('UNAUTHENTICATED', '主体状态异常。', 'invalid_ticket');
    }
    return createWebSession(c, principal, now);
  });
}

/** 本机隔离测试登录（仅 city.devLogin = true 时可用）。 */
export function devLoginCitySession(c: CityService, rawName: unknown) {
  if (!c.devLogin) throw new CityError('UNAUTHENTICATED', '未开启本机试玩登录。', 'dev_login_disabled');
  const name = cleanName(rawName, 16);
  if (name.length < 1) throw cityBadRequest('请输入显示名（1~16 个字）。', 'name_required');
  const subject = sha256(skeleton(name)).slice(0, 24);
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    const principal = upsertPrincipal(c, 'dev', subject, 'human', name);
    return createWebSession(c, principal, now);
  });
}

/** 校验浏览器 city_session Cookie。 */
export function citySessionAuth(c: CityService, rawSessionToken: string | undefined | null): CityWebSession | null {
  if (!rawSessionToken) return null;
  const tokenHash = sha256(rawSessionToken);
  const now = c.now();
  const row = c.db.get<Row>(
    `SELECT s.csrf_token, s.expires_at, p.principal_id, p.provider, p.subject, p.kind, p.display_name
     FROM web_sessions s JOIN principals p ON p.principal_id = s.principal_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    tokenHash,
    now,
  );
  if (!row) return null;
  const principal: CityPrincipal = {
    principal_id: String(row.principal_id),
    provider: String(row.provider),
    subject: String(row.subject),
    kind: row.kind as 'human' | 'agent',
    display_name: String(row.display_name),
  };
  return {
    tokenHash,
    csrfToken: String(row.csrf_token),
    expiresAtMs: Number(row.expires_at),
    principal,
    resident: c.residentOfPrincipal(principal.principal_id) ?? null,
  };
}

/** 撤销网页会话并立即通知活跃的私有 SSE 连接关闭。 */
export function revokeCitySession(c: CityService, rawSessionToken: string | undefined | null): void {
  if (!rawSessionToken) return;
  const tokenHash = sha256(rawSessionToken);
  const now = c.now();
  c.commit(() => {
    c.db.run('UPDATE web_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', now, tokenHash);
  });
  c.notifySessionRevoked(tokenHash);
}

export interface EnterInput {
  name?: unknown;
  bio?: unknown;
  /** 第一次进城的入口：kumominato:station 或 ryokogai:station */
  entry?: unknown;
  /** 归一化后的客户端标识（mcp:<id> 或 web:<id>） */
  clientId?: string;
  /** 是否显式接管控制权（默认 false：已有其他活跃客户端持权时只读进入） */
  claim?: boolean;
}

export const ENTRY_PLACES = ['kumominato:station', 'ryokogai:station'] as const;

/** 外部 bot 或真人玩家进城（或回到城里）。幂等：已经在场只续租约；默认不暗抢活跃控制权。 */
export function enterCity(
  c: CityService,
  principal: CityPrincipal,
  input: EnterInput = {},
): { resident: CityResident; created: boolean; granted_yen: number; control: { epoch: number; mine: boolean } } {
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    const expectedOrigin: 'external' | 'human' = principal.kind === 'human' ? 'human' : 'external';
    let r = c.residentOfPrincipal(principal.principal_id);
    let created = false;
    if (r && r.origin === 'house') throw new CityError('ENTRY_VIA_HOME_ONLY', '小屋的室友只能从家里出门进城。');
    if (r && r.origin !== expectedOrigin) throw new CityError('FORBIDDEN', '身份类别不匹配。', 'origin_mismatch');
    if (!r) {
      const rawName = principal.kind === 'human' && principal.provider !== 'dev' ? input.name : (input.name ?? principal.display_name);
      const name = cleanName(rawName);
      if (name.length < 1) throw cityBadRequest('第一次进城需要 name（1~16 个字的显示名）。', 'name_required');
      if (nameTaken(c, name)) throw cityPrecondition('这个名字已经有人用了，换一个。', 'name_taken');
      const id = c.id('res');
      c.db.run(
        'INSERT INTO residents(resident_id, principal_id, name, bio, origin, in_city, created_at, last_seen_at) VALUES (?,?,?,?,?,0,?,?)',
        id,
        principal.principal_id,
        name,
        cleanBio(input.bio),
        expectedOrigin,
        now,
        now,
      );
      ensurePurse(c, id);
      r = c.mustResident(id);
      created = true;
    } else if (input.bio !== undefined && cleanBio(input.bio) !== r.bio) {
      c.db.run('UPDATE residents SET bio = ?, revision = revision + 1 WHERE resident_id = ?', cleanBio(input.bio), r.resident_id);
    }
    // 启动资金：每个主体只发一次（原因键永久唯一），之后没有任何持续收入
    const granted = ledger(c, `grant:first-entry:${principal.principal_id}`, 'grant', '进城启动资金', [[MINT, -c.params.firstEntryGrantYen], [purseOf(r.resident_id), c.params.firstEntryGrantYen]]);
    const wasPresent = r.in_city === 1;
    const wasActive = r.in_city === 1 && r.present_until > now;
    if (!wasPresent && expectedOrigin === 'external') {
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
    let controlEpoch = r.control_epoch;
    let controllerId = r.controller_id;
    let notifyControl = false;
    if (input.clientId) {
      const getsControl = r.controller_id === null || !wasActive || r.controller_id === input.clientId || Boolean(input.claim);
      if (getsControl && r.controller_id !== input.clientId) {
        controlEpoch = r.control_epoch + 1;
        controllerId = input.clientId;
        notifyControl = wasActive && r.controller_id !== null;
      }
    }
    c.db.run(
      'UPDATE residents SET in_city = 1, place_id = ?, present_until = ?, control_epoch = ?, controller_id = ?, last_seen_at = ?, revision = revision + 1 WHERE resident_id = ?',
      placeId,
      until,
      controlEpoch,
      controllerId,
      now,
      r.resident_id,
    );
    c.reschedule('presence_expire', `pres:${r.resident_id}`, until, { residentId: r.resident_id });
    const fresh = c.mustResident(r.resident_id);
    if (notifyControl) {
      c.emitTo([fresh.resident_id], 'control', { epoch: controlEpoch }, now);
    }
    if (!wasPresent && placeId) {
      c.emitTo(c.presentAt(placeId).filter((x) => x.resident_id !== fresh.resident_id).map((x) => x.resident_id), 'arrived', { who: card(fresh), place: placeId }, now);
    }
    return {
      resident: fresh,
      created,
      granted_yen: granted ? c.params.firstEntryGrantYen : 0,
      control: { epoch: fresh.control_epoch, mine: input.clientId ? fresh.controller_id === input.clientId : true },
    };
  });
}

/** 续在场租约（等待、读视图、做动作都算「还在」）。不在场就什么都不做。 */
export function touchPresence(c: CityService, residentId: string): void {
  const r = c.resident(residentId);
  if (!r || r.origin === 'house' || !r.in_city) return;
  const now = c.now();
  // 租约还剩一大半就不写库：等待循环里每次都写没有意义
  if (r.present_until - now > c.params.presenceLeaseMs * 0.6) return;
  c.commit(() => {
    const until = now + c.params.presenceLeaseMs;
    c.db.run('UPDATE residents SET present_until = ?, last_seen_at = ? WHERE resident_id = ?', until, now, residentId);
    c.reschedule('presence_expire', `pres:${residentId}`, until, { residentId });
  });
}

/** 显式保活（heartbeat）：若已不在城（in_city = 0 或租约过期）直接返回 422 not_in_city，绝不静默把人拉回在线。 */
export function cityHeartbeat(c: CityService, residentId: string, clientId?: string) {
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    const r = c.mustResident(residentId);
    if (r.origin === 'house') throw new CityError('ENTRY_VIA_HOME_ONLY', '小屋室友由外出访问维持状态。');
    if (!r.in_city || (r.present_until > 0 && r.present_until <= now)) {
      if (r.in_city) depart(c, r, now, false);
      throw cityPrecondition('你现在不在城里，请先进入城市。', 'not_in_city');
    }
    const until = now + c.params.presenceLeaseMs;
    c.db.run('UPDATE residents SET present_until = ?, last_seen_at = ? WHERE resident_id = ?', until, now, r.resident_id);
    c.reschedule('presence_expire', `pres:${r.resident_id}`, until, { residentId: r.resident_id });
    return {
      ok: true as const,
      present: true as const,
      present_until_ms: until,
      control: { epoch: r.control_epoch, mine: clientId ? r.controller_id === clientId : false },
      server_time_ms: now,
      next_heartbeat_ms: Math.max(10_000, Math.floor(c.params.presenceLeaseMs / 3)),
    };
  });
}

/** 显式接管当前居民的控制权（claim_control）。 */
export function claimCityControl(c: CityService, residentId: string, clientId: string): { ok: true; control: { epoch: number; mine: true } } {
  return c.commit(() => {
    c.assertRunning();
    const now = c.now();
    const r = c.mustResident(residentId);
    if (r.origin === 'house') throw new CityError('ENTRY_VIA_HOME_ONLY', '小屋室友由外出访问代次控制。');
    if (!r.in_city) throw cityPrecondition('你现在不在城里，请先进入城市。', 'not_in_city');
    const until = now + c.params.presenceLeaseMs;
    let epoch = r.control_epoch;
    if (r.controller_id !== clientId) {
      epoch = r.control_epoch + 1;
      c.db.run(
        'UPDATE residents SET control_epoch = ?, controller_id = ?, present_until = ?, last_seen_at = ?, revision = revision + 1 WHERE resident_id = ?',
        epoch,
        clientId,
        until,
        now,
        r.resident_id,
      );
      c.emitTo([r.resident_id], 'control', { epoch }, now);
    } else {
      c.db.run('UPDATE residents SET present_until = ?, last_seen_at = ? WHERE resident_id = ?', until, now, r.resident_id);
    }
    c.reschedule('presence_expire', `pres:${r.resident_id}`, until, { residentId: r.resident_id });
    return { ok: true as const, control: { epoch, mine: true as const } };
  });
}

/** 修改外部 Bot 或真人居民的城内显示名与一句话简介。 */
export function updateResidentProfile(c: CityService, r: CityResident, input: { name?: unknown; bio?: unknown }): { id: string; name: string; bio: string } {
  if (r.origin === 'house') throw cityPrecondition('小屋室友的显示名和简介由家里同步，不在城里修改。', 'house_profile_managed');
  if (input.name === undefined && input.bio === undefined) {
    throw cityBadRequest('至少要提供 name 或 bio 之一。', 'empty_profile_update');
  }
  let nextName = r.name;
  if (input.name !== undefined) {
    nextName = cleanName(input.name, 16);
    if (nextName.length < 1) throw cityBadRequest('显示名需要 1~16 个字。', 'name_required');
    if (nameTaken(c, nextName, r.resident_id)) throw cityPrecondition('这个名字已经有人用了，换一个。', 'name_taken');
  }
  const nextBio = input.bio !== undefined ? cleanBio(input.bio) : r.bio;
  c.db.run('UPDATE residents SET name = ?, bio = ?, revision = revision + 1 WHERE resident_id = ?', nextName, nextBio, r.resident_id);
  return { id: r.resident_id, name: nextName, bio: nextBio };
}

function depart(c: CityService, r: CityResident, at: number, bumpEpoch = false): void {
  const nextEpoch = bumpEpoch ? r.control_epoch + 1 : r.control_epoch;
  c.db.run(
    'UPDATE residents SET in_city = 0, present_until = 0, controller_id = NULL, control_epoch = ?, last_seen_at = ?, revision = revision + 1 WHERE resident_id = ?',
    nextEpoch,
    at,
    r.resident_id,
  );
  c.cancelJob(`pres:${r.resident_id}`);
  if (r.place_id && publicPlace(r.place_id)) {
    c.emitTo(c.presentAt(r.place_id).filter((x) => x.resident_id !== r.resident_id).map((x) => x.resident_id), 'left', { who: card(r), place: r.place_id }, at);
  }
}

/** 外部 bot 或真人玩家主动离开。钱和东西都留着；在路上的行程照常到站，只是人不在场。 */
export function leaveCity(c: CityService, residentId: string): { ok: true } {
  return c.commit(() => {
    const r = c.resident(residentId);
    if (r && r.origin !== 'house' && r.in_city) depart(c, r, c.now(), true);
    return { ok: true as const };
  });
}

export function installResidents(c: CityService): void {
  c.jobHandlers.set('presence_expire', (payload, _job, now) => {
    const r = c.resident(String(payload.residentId));
    if (!r || r.origin === 'house' || !r.in_city) return;
    if (r.present_until > now) {
      c.reschedule('presence_expire', `pres:${r.resident_id}`, r.present_until, { residentId: r.resident_id });
      return;
    }
    depart(c, r, now, false);
  });
}
