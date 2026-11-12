/**
 * 身份、登录、在场与控制权。
 *
 * - 主体（principal）：一个可信的账号身份。AI 来自 MCP 鉴权后的身份；真人来自可信平台适配层签发的一次性登录票据。
 *   同一主体在同一世界只有一个居民（数据库唯一约束），改名、换浏览器、重连都不会生成新居民。
 * - 会话：票据兑换出来的登录凭据（只存哈希），可过期、可撤销。会话失效只要求重新登录，不删除居民。
 * - 在场租约：客户端维持的短期租约。显式离开立即失效并递增在场代数；意外断线保留一个宽限期。
 * - 控制权：同一居民同一时刻只有一个客户端能写；接管时递增控制代数，旧客户端迟到的动作被拒绝。
 * 三个期限各管各的：登录还有效不代表还在场，还在场不代表还握着控制权。
 */
import { randomBytes } from 'node:crypto';
import { sanitizeName } from '../core/text.js';
import { ENTRY_PLACE, INTERESTS, STREETS, TRAITS } from './content.js';
import { WorldError, badRequest, precondition } from './errors.js';
import { card, publicSpot } from './project.js';
import { sha256, type Auth, type WorldService } from './service.js';
import { stopNav, touchScene } from './space.js';
import type { Principal, ResidentRow, ResidentState } from './types.js';

export interface ProfileInput {
  name?: unknown;
  bio?: unknown;
  traits?: unknown;
  interests?: unknown;
}

const KNOWN_TRAITS = new Set(TRAITS.map((t) => t.id));
const KNOWN_INTERESTS = new Set(INTERESTS.map((t) => t.id));

/**
 * 居民名字的清洗：在 sanitizeName 之外再去掉「看不见的字符」（零宽空格、方向控制等，Unicode 的 Cf 类），
 * 免得用 `阿灯\u200b` 冒充 `阿灯`、或用方向控制符把名字显示成别的样子。
 */
function cleanName(raw: unknown, max: number): string {
  return sanitizeName(String(raw ?? '').replace(/\p{Cf}/gu, ''), max);
}

/** 判重用的骨架：全角半角、大小写都不算区别（SQLite 的 lower() 只管 ASCII，不够用）。 */
const nameSkeleton = (name: string): string => name.normalize('NFKC').toLowerCase();

function nameTaken(w: WorldService, name: string, exceptResidentId?: string): boolean {
  const key = nameSkeleton(name);
  return w.db.all('SELECT resident_id, name FROM residents WHERE world_id = ?', w.worldId).some((row) => row.resident_id !== exceptResidentId && nameSkeleton(String(row.name)) === key);
}

function pickList(raw: unknown, known: Set<string>, max: number, what: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest(`${what}应该是一个列表。`);
  const out: string[] = [];
  for (const v of raw) {
    const id = String(v);
    if (!known.has(id)) throw badRequest(`不认识的${what}：${id.slice(0, 20)}`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > max) throw badRequest(`${what}最多选 ${max} 个。`);
  return out;
}

// ───────────────────────── 主体 ─────────────────────────

function principalRow(w: WorldService, provider: string, subject: string): Principal | undefined {
  return w.db.get<Principal & Record<string, any>>('SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE provider = ? AND subject = ?', provider, subject);
}

export function principalById(w: WorldService, principalId: string): Principal | undefined {
  return w.db.get<Principal & Record<string, any>>('SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE principal_id = ?', principalId);
}

/** 没有可用昵称时的占位前缀。register 把它当作「没起名」，要求本人另外给名字。 */
const PLACEHOLDER_NAME = '新居民';

/** 幂等地登记一个主体。同一个 provider+subject 的类别一旦确定就不能变（AI 不能事后变成真人，反之亦然）。 */
function upsertPrincipal(w: WorldService, provider: string, subject: string, kind: 'human' | 'agent', name: string): Principal {
  const existing = principalRow(w, provider, subject);
  if (existing) {
    if (existing.kind !== kind) {
      throw new WorldError('unauthenticated', kind === 'human' ? '这个账号已经登记为 AI 居民，不能再以真人身份进入。' : '这个账号已经登记为真人居民，不能再以 AI 身份进入。');
    }
    return existing;
  }
  const principalId = w.id('p');
  // 昵称清洗后为空时用中性占位名，绝不回退成原始账号号码（它会进入居民名、公开事件和会话回包）
  const display = cleanName(String(name), 24) || `${PLACEHOLDER_NAME}${principalId.slice(-4)}`;
  const principal: Principal = { principal_id: principalId, provider, subject, kind, display_name: display };
  w.db.run(
    'INSERT INTO principals(principal_id, provider, subject, kind, display_name, created_at) VALUES (?,?,?,?,?,?)',
    principal.principal_id,
    provider,
    subject,
    kind,
    principal.display_name,
    w.now(),
  );
  return principal;
}

/**
 * MCP 鉴权后的 AI 身份 → 主体。只会登记成 agent，不能借此注册真人。
 *
 * 密钥绑定的身份（keys 模式、stdio）号码是服务器配置的，和真人票据共用 'qq' 这个命名空间：
 * 同一个号码要么是 AI 要么是真人。open 模式下号码是自己认领的、没人核实过，登记在单独的
 * 'open' 命名空间里：否则谁都能抢先认领一个真人的号码，让那位真人再也登录不了小镇。
 */
export function agentPrincipal(w: WorldService, identity: { id: string; name: string }, opts: { selfClaimed?: boolean } = {}): Principal {
  return w.commit(() => upsertPrincipal(w, opts.selfClaimed ? 'open' : 'qq', String(identity.id), 'agent', identity.name));
}

// ───────────────────────── 登录票据与会话 ─────────────────────────

export interface TicketResult {
  ticket: string;
  expires_at: number;
  /** 配了网页公网地址时给出完整链接（票据在片段里，不会进服务器日志和 Referer） */
  url: string | null;
}

/**
 * 给一位真人签发一次性登录票据。调用方必须是可信的平台适配层（代码裁判、管理员）：
 * 号码来自它核实过的真实消息，不是谁自报的。票据只存哈希，5 分钟内有效，只能兑换一次。
 */
export function issueTicket(w: WorldService, who: { provider: string; subject: string; name: string }): TicketResult {
  const subject = String(who.subject ?? '').trim();
  if (!/^[\w.:-]{1,64}$/u.test(subject)) throw badRequest('账号标识无效。');
  return w.commit(() => {
    const principal = upsertPrincipal(w, who.provider, subject, 'human', who.name);
    const ticket = randomBytes(24).toString('base64url');
    const now = w.now();
    const expires = now + w.params.loginTicketTtlMs;
    w.db.run('INSERT INTO login_tickets(ticket_hash, principal_id, world_id, created_at, expires_at) VALUES (?,?,?,?,?)', sha256(ticket), principal.principal_id, w.worldId, now, expires);
    return { ticket, expires_at: expires, url: w.publicUrl ? `${w.publicUrl.replace(/\/?$/, '/')}#ticket=${ticket}` : null };
  });
}

export interface SessionResult {
  token: string;
  expires_at: number;
  principal: Principal;
}

function createSession(w: WorldService, principal: Principal): SessionResult {
  const token = randomBytes(32).toString('base64url');
  const now = w.now();
  const expires = now + w.params.sessionTtlMs;
  w.db.run('INSERT INTO sessions(token_hash, principal_id, active_world_id, created_at, expires_at) VALUES (?,?,?,?,?)', sha256(token), principal.principal_id, w.worldId, now, expires);
  return { token, expires_at: expires, principal };
}

/** 兑换票据：标记已兑换和创建会话在同一事务里。无效、过期、用过的票据对外是同一种说法。 */
export function exchangeTicket(w: WorldService, ticket: unknown): SessionResult {
  const t = typeof ticket === 'string' ? ticket : '';
  return w.commit(() => {
    const now = w.now();
    const row = t ? w.db.get('SELECT * FROM login_tickets WHERE ticket_hash = ?', sha256(t)) : undefined;
    if (!row || row.redeemed_at !== null || row.expires_at <= now || row.world_id !== w.worldId) {
      throw new WorldError('unauthenticated', '登录链接无效或已过期，请重新获取。');
    }
    const changed = w.db.run('UPDATE login_tickets SET redeemed_at = ? WHERE ticket_hash = ? AND redeemed_at IS NULL', now, row.ticket_hash).changes;
    if (changed !== 1) throw new WorldError('unauthenticated', '登录链接无效或已过期，请重新获取。');
    const principal = principalById(w, row.principal_id);
    if (!principal) throw new WorldError('unauthenticated', '登录链接无效或已过期，请重新获取。');
    return createSession(w, principal);
  });
}

/** 本地开发登录：不经平台核实，只在 devLogin 打开时可用。 */
export function devLoginSession(w: WorldService, name: unknown): SessionResult {
  if (!w.devLogin) throw new WorldError('unauthenticated', '这台服务器没有开放开发登录。');
  const clean = sanitizeName(String(name ?? ''), 16);
  if (!clean) throw badRequest('需要一个名字。');
  return w.commit(() => createSession(w, upsertPrincipal(w, 'dev', sha256(clean).slice(0, 24), 'human', clean)));
}

/** 会话令牌 → 主体。过期、撤销或不存在返回 null。 */
export function sessionPrincipal(w: WorldService, token: string | undefined | null): Principal | null {
  if (!token) return null;
  const row = w.db.get('SELECT principal_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?', sha256(token));
  if (!row || row.revoked_at !== null || row.expires_at <= w.now()) return null;
  return principalById(w, row.principal_id) ?? null;
}

export function revokeSession(w: WorldService, token: string): void {
  w.commit(() => w.db.run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', w.now(), sha256(token)));
}

// ───────────────────────── 注册 ─────────────────────────

function register(w: WorldService, principal: Principal, profile: ProfileInput, now: number): ResidentRow {
  const fallback = principal.display_name?.startsWith(PLACEHOLDER_NAME) ? '' : principal.display_name;
  const name = cleanName(profile.name ?? fallback ?? '', 16);
  if (!name) throw precondition('第一次进入需要给居民起个名字。', 'profile_required');
  if (nameTaken(w, name)) {
    throw precondition(`已经有一位居民叫「${name}」了，换个名字吧。`, 'name_taken');
  }
  const state: ResidentState = {
    bio: sanitizeName(String(profile.bio ?? ''), 80),
    traits: pickList(profile.traits, KNOWN_TRAITS, w.params.traitCount, '个性倾向'),
    interests: pickList(profile.interests, KNOWN_INTERESTS, w.params.interestCount, '兴趣'),
    needs: { energy: 80, social: 60, interest: 60, asOfPresentMs: 0 },
    settings: { showMood: true, allowAskHobby: true, moodOverride: null },
  };
  // 住宅：分到人少的那条巷子，门牌顺序排下去
  const counts = STREETS.map((s) => ({ s, n: w.db.scalar('SELECT COUNT(*) FROM residents WHERE world_id = ? AND street_id = ?', w.worldId, s) }));
  counts.sort((a, b) => a.n - b.n || a.s.localeCompare(b.s));
  const street = counts[0]!.s;
  const houseNo = w.db.scalar('SELECT COALESCE(MAX(house_no), 0) FROM residents WHERE world_id = ? AND street_id = ?', w.worldId, street) + 1;
  const rid = w.id('r');
  w.db.run(
    `INSERT INTO residents(resident_id, world_id, principal_id, name, kind, street_id, house_no, location_id, state_json, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    rid,
    w.worldId,
    principal.principal_id,
    name,
    principal.kind,
    street,
    houseNo,
    ENTRY_PLACE,
    JSON.stringify(state),
    now,
    now,
  );
  // 新居民物资只发一次：居民本身受 (world, principal) 唯一约束保护，这里再留一个长期业务凭据
  w.db.run('INSERT INTO business_keys(key, created_at) VALUES (?,?)', `starter:${w.worldId}:${principal.principal_id}`, now);
  const r = w.mustResident(rid);
  for (const h of w.hooks.registered) h(r, now);
  w.emitPublic('resident_joined', { resident: card(r) }, now);
  return w.mustResident(rid);
}

// ───────────────────────── 进入、心跳、离开、控制权 ─────────────────────────

export interface EnterResult {
  residentId: string;
  created: boolean;
  /** 这次进入之前是不是离线的（回访时附带回顾） */
  wasAway: boolean;
  awaySince: number | null;
  presenceEpoch: number;
  control: { epoch: number; mine: boolean };
  contextVersion: number;
}

function presenceJobKey(residentId: string): string {
  return `presence:${residentId}`;
}

function comeOnline(w: WorldService, r: ResidentRow, now: number): void {
  if (r.present_since !== null) return;
  r.present_since = now;
  w.saveResident(r);
  // 同一场景实例里的人要在快照里看到她出现（她自己的快照也从「只有自己」变成整个现场）
  touchScene(w, r.resident_id);
  const space = w.spaceOf(r);
  if (space) {
    const others = w.audienceIn(space).filter((x) => x.resident_id !== r.resident_id);
    w.emitTo(others.map((x) => x.resident_id), 'presence', { resident: card(r), present: true, space }, now);
  }
  w.emitPublic('place', { resident: publicSpot(r) }, now);
}

/**
 * 进入世界：幂等地注册或恢复居民，并登记这个客户端的在场租约。
 * 第一次进入需要 profile.name；之后再带 profile 也不会改已有资料（改资料用 update_profile 动作）。
 * 多开页面仍是同一居民：只有一个客户端握着控制权，其余只能看。
 */
export function enter(w: WorldService, auth: Auth, input: { clientKind?: 'web' | 'mcp'; profile?: ProfileInput } = {}): EnterResult {
  if (w.status !== 'running') throw new WorldError('recovering', '小镇正在恢复，请稍后再进入。');
  if (!/^[\w.:-]{4,80}$/.test(auth.clientId)) throw badRequest('需要 clientId（这个设备或标签页的稳定编号）。');
  w.runDue();
  return w.commit(() => {
    const now = w.now();
    const principal = principalById(w, auth.principalId);
    if (!principal) throw new WorldError('unauthenticated', '请先登录。');
    let r = w.residentOfPrincipal(principal.principal_id);
    let created = false;
    if (!r) {
      r = register(w, principal, input.profile ?? {}, now);
      created = true;
    }
    const wasAway = r.present_since === null;
    const awaySince = wasAway && !created ? r.last_seen_at : null;
    if (wasAway && w.presentCount() >= w.params.activeResidentLimit) {
      throw precondition(`小镇里现在已经有 ${w.params.activeResidentLimit} 位居民在场，暂时进不去。可以先看看公开的小镇地图，稍后再试。`, 'world_full');
    }
    const expires = now + w.params.presenceGraceMs;
    w.db.run(
      `INSERT INTO presence_leases(resident_id, client_id, epoch, kind, expires_at, boot_id) VALUES (?,?,?,?,?,?)
       ON CONFLICT(resident_id, client_id) DO UPDATE SET epoch = excluded.epoch, kind = excluded.kind, expires_at = excluded.expires_at, boot_id = excluded.boot_id`,
      r.resident_id,
      auth.clientId,
      r.presence_epoch,
      input.clientKind ?? 'web',
      expires,
      w.bootId,
    );
    // 控制权：没人握着、握着的人租约过期、或者本来就是这个客户端 → 归这个客户端
    let tookOver = false;
    if (!r.controller_client || r.controller_until <= now || r.controller_client === auth.clientId) {
      if (r.controller_client !== auth.clientId) {
        r.control_epoch += 1;
        tookOver = true;
      }
      r.controller_client = auth.clientId;
      r.controller_until = expires;
    }
    w.saveResident(r);
    // 控制权换了手：原来那个客户端安排的路线不再有人续，立即站住
    if (tookOver && stopNav(w, r.resident_id, now, 'control')) r = w.mustResident(r.resident_id);
    comeOnline(w, r, now);
    w.reschedule('presence_expire', presenceJobKey(r.resident_id), maxLeaseExpiry(w, r), { residentId: r.resident_id });
    return {
      residentId: r.resident_id,
      created,
      wasAway,
      awaySince,
      presenceEpoch: r.presence_epoch,
      control: { epoch: r.control_epoch, mine: r.controller_client === auth.clientId },
      contextVersion: r.context_version,
    };
  });
}

function maxLeaseExpiry(w: WorldService, r: ResidentRow): number {
  return w.db.scalar('SELECT COALESCE(MAX(expires_at), 0) FROM presence_leases WHERE resident_id = ? AND epoch = ?', r.resident_id, r.presence_epoch);
}

export interface HeartbeatResult {
  presenceEpoch: number;
  control: { epoch: number; mine: boolean };
  contextVersion: number;
  activityId: string | null;
  serverTime: number;
  nextHeartbeatMs: number;
}

/**
 * 心跳：只能续期已登记的在场租约，必须带对应的在场代数。
 * 显式离开之后，旧页面或旧运行器在途的心跳不能让居民重新在场（要重新 enter）。
 * 心跳不产生任何需要调用模型的事件。
 */
export function heartbeat(w: WorldService, auth: Auth, presenceEpoch: unknown): HeartbeatResult {
  if (w.status !== 'running') throw new WorldError('recovering', '小镇正在恢复，请稍后再试。');
  return w.commit(() => {
    const now = w.now();
    const r = w.residentOfPrincipal(auth.principalId);
    if (!r) throw new WorldError('unauthenticated', '还没有居民身份，请先进入小镇。', 'no_resident');
    const lease = w.db.get('SELECT epoch, expires_at, boot_id FROM presence_leases WHERE resident_id = ? AND client_id = ?', r.resident_id, auth.clientId);
    if (!lease || lease.epoch !== r.presence_epoch || presenceEpoch !== r.presence_epoch || lease.expires_at <= now) {
      throw precondition('在场状态已经失效，请重新进入小镇。', 'presence_lost');
    }
    const expires = now + w.params.presenceGraceMs;
    w.db.run('UPDATE presence_leases SET expires_at = ?, boot_id = ? WHERE resident_id = ? AND client_id = ?', expires, w.bootId, r.resident_id, auth.clientId);
    if (r.controller_client === auth.clientId) {
      r.controller_until = expires;
      w.saveResident(r);
    }
    // 服务重启后的第一次心跳：重新确认在场
    if (r.present_since === null) {
      if (w.presentCount() >= w.params.activeResidentLimit) throw precondition('小镇里在场的居民满了，请稍后重新进入。', 'world_full');
      comeOnline(w, r, now);
    }
    w.reschedule('presence_expire', presenceJobKey(r.resident_id), maxLeaseExpiry(w, r), { residentId: r.resident_id });
    return {
      presenceEpoch: r.presence_epoch,
      control: { epoch: r.control_epoch, mine: r.controller_client === auth.clientId },
      contextVersion: r.context_version,
      activityId: r.activity_id,
      serverTime: now,
      nextHeartbeatMs: w.params.heartbeatIntervalMs,
    };
  });
}

/**
 * 主动离开小镇：立即失去在场资格，撤销这位居民的全部在场租约和控制权，两个代数都递增。
 * 正在走的路立即停步（停在离开那一刻的位置，回来时人就在那里）；已经提交的制作照常完成；之后不会替她发起任何新动作。
 */
export function leaveWorld(w: WorldService, principalId: string): { ok: true; presenceEpoch: number } {
  const out = w.commit(() => {
    const now = w.now();
    const found = w.residentOfPrincipal(principalId);
    if (!found) throw new WorldError('unauthenticated', '还没有居民身份。', 'no_resident');
    // 先结算走过的区域并停步：离开通知要发在人此刻所在的区域，而不是出发时的区域
    if (found.present_since !== null) stopNav(w, found.resident_id, now, 'offline');
    const r = w.mustResident(found.resident_id);
    r.presence_epoch += 1;
    r.control_epoch += 1;
    r.controller_client = null;
    r.controller_until = 0;
    w.saveResident(r);
    w.db.run('DELETE FROM presence_leases WHERE resident_id = ?', r.resident_id);
    w.cancelJob(presenceJobKey(r.resident_id));
    announceAway(w, r, now);
    w.goOffline(r, now, 'leave');
    return { ok: true as const, presenceEpoch: r.presence_epoch, residentId: r.resident_id };
  });
  w.revokeStreams(out.residentId);
  return { ok: true, presenceEpoch: out.presenceEpoch };
}

function announceAway(w: WorldService, r: ResidentRow, at: number): void {
  if (r.present_since === null) return;
  const space = w.spaceOf(r);
  if (space) {
    const others = w.audienceIn(space).filter((x) => x.resident_id !== r.resident_id);
    w.emitTo(others.map((x) => x.resident_id), 'presence', { resident: card(r), present: false, space }, at);
  }
  w.emitPublic('place', { resident: { ...card(r), at: null } }, at);
}

/** 申请接管控制权：需要这个客户端自己有有效的在场租约。接管后控制代数递增，原来的客户端迟到的动作会被拒绝。 */
export function claimControl(w: WorldService, auth: Auth): { control: { epoch: number; mine: true } } {
  return w.commit(() => {
    const now = w.now();
    const r = w.residentOfPrincipal(auth.principalId);
    if (!r) throw new WorldError('unauthenticated', '还没有居民身份，请先进入小镇。', 'no_resident');
    const lease = w.db.get('SELECT epoch, expires_at FROM presence_leases WHERE resident_id = ? AND client_id = ?', r.resident_id, auth.clientId);
    if (!lease || lease.epoch !== r.presence_epoch || lease.expires_at <= now) throw precondition('在场状态已经失效，请重新进入小镇。', 'presence_lost');
    const tookOver = r.controller_client !== auth.clientId;
    if (tookOver) {
      r.control_epoch += 1;
      r.controller_client = auth.clientId;
    }
    // 控制权不比握着它的这条租约活得更久：这个客户端掉线，控制权就跟着过期
    r.controller_until = Number(lease.expires_at);
    w.saveResident(r);
    // 接管：原来那个客户端安排的路线立即站住，新的控制者自己决定往哪走
    if (tookOver) stopNav(w, r.resident_id, now, 'control');
    w.emitTo([r.resident_id], 'control', { epoch: r.control_epoch }, now);
    return { control: { epoch: r.control_epoch, mine: true as const } };
  });
}

export function installIdentity(w: WorldService): void {
  // 在场租约到期：没有任何有效租约了才转为离线，离线时刻记为租约到期的那一刻
  w.jobHandlers.set('presence_expire', (payload, job, now) => {
    let r = w.resident(String(payload.residentId));
    if (!r) return;
    const latest = maxLeaseExpiry(w, r);
    if (latest > now) {
      w.reschedule('presence_expire', job.dedupe_key, latest, payload);
      return;
    }
    w.db.run('DELETE FROM presence_leases WHERE resident_id = ? AND expires_at <= ?', r.resident_id, now);
    if (r.present_since !== null) {
      const at = Math.max(r.present_since, latest || job.due_at);
      // 还在走的路先结算到离线那一刻并停步，离线通知发在人当时所在的区域
      stopNav(w, r.resident_id, at, 'offline');
      r = w.mustResident(r.resident_id);
      announceAway(w, r, at);
      w.goOffline(r, at, 'lease_expired');
    }
    // 所有租约都过期了：没有任何客户端还能握着控制权
    if (r.controller_client) {
      const fresh = w.mustResident(r.resident_id);
      fresh.controller_client = null;
      fresh.control_epoch += 1;
      w.saveResident(fresh);
    }
  });

  // 修改资料：公开资料（名字、简介、个性）、可询问的兴趣、展示设置
  w.handlers.set('update_profile', ({ r, action }) => {
    if (action.name !== undefined) {
      const name = cleanName(action.name, 16);
      if (!name) throw badRequest('名字不能为空。');
      if (nameTaken(w, name, r.resident_id)) {
        throw precondition(`已经有一位居民叫「${name}」了。`, 'name_taken');
      }
      r.name = name;
      touchScene(w, r.resident_id);
    }
    if (action.bio !== undefined) r.state.bio = sanitizeName(String(action.bio), 80);
    if (action.traits !== undefined) r.state.traits = pickList(action.traits, KNOWN_TRAITS, w.params.traitCount, '个性倾向');
    if (action.interests !== undefined) r.state.interests = pickList(action.interests, KNOWN_INTERESTS, w.params.interestCount, '兴趣');
    if (action.showMood !== undefined) r.state.settings.showMood = Boolean(action.showMood);
    if (action.allowAskHobby !== undefined) r.state.settings.allowAskHobby = Boolean(action.allowAskHobby);
    if (action.muteTownChat !== undefined) r.state.settings.muteTownChat = Boolean(action.muteTownChat);
    if (action.mood !== undefined) {
      // 真人可以自己设情绪展示；null = 交回给程序的建议状态
      r.state.settings.moodOverride = action.mood === null ? null : sanitizeName(String(action.mood), 12) || null;
    }
    w.saveResident(r);
    return { status: 'completed' };
  });
}
