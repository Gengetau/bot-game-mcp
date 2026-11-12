/**
 * 信件与登门邀请。
 *
 * - 信件是异步的私密消息：寄出后过一小段时间才投递；在外面只能知道「有新信」，第一次读要回到自己家。
 *   读过的信之后可以在任何地方重读。信的内容只有寄信人和收信人能取到。
 * - 住宅默认只有主人能进。邀请是一条有期限的进门许可：当面发的立刻生效，随信发的要等对方读了信才算知道。
 *   过期或被撤销时，还在屋里的客人（包括离线的）会被送到门口，只收到固定模板的通知。
 */
import { sanitizeUserText } from '../core/text.js';
import { homeId, homeOwner, isHome, placeDef } from './content.js';
import { type Row } from './db.js';
import { badRequest, precondition } from './errors.js';
import { bumpCounter, counter, placeAt, setHomeAccessCheck, spaceName, takeToken } from './life.js';
import { card } from './project.js';
import type { WorldService } from './service.js';
import type { ResidentRow } from './types.js';

// ───────────────────────── 邀请 ─────────────────────────

function validGrant(w: WorldService, guestId: string, home: string, now: number): Row | undefined {
  return w.db.get(
    `SELECT * FROM home_access_grants WHERE home_id = ? AND guest_id = ? AND revoked_at IS NULL AND learned_at IS NOT NULL
       AND valid_from <= ? AND expires_at > ? AND (reentry = 1 OR entered_at IS NULL OR (entered_at IS NOT NULL AND exited_at IS NULL))
     ORDER BY expires_at DESC LIMIT 1`,
    home,
    guestId,
    now,
    now,
  );
}

export interface InviteView {
  grantId: string;
  home: string;
  host: ReturnType<typeof card>;
  guest: ReturnType<typeof card>;
  expiresAt: number;
  reentry: boolean;
  via: string;
}

function inviteView(w: WorldService, g: Row): InviteView {
  return {
    grantId: String(g.grant_id),
    home: String(g.home_id),
    host: card(w.mustResident(g.owner_id)),
    guest: card(w.mustResident(g.guest_id)),
    expiresAt: Number(g.expires_at),
    reentry: g.reentry === 1,
    via: String(g.via),
  };
}

/** 我现在能用的邀请（已经得知、没过期、没撤销）和我发出去还有效的邀请。 */
export function invitesOf(w: WorldService, residentId: string, now: number): { received: InviteView[]; sent: InviteView[] } {
  const received = w.db
    .all(
      `SELECT * FROM home_access_grants WHERE guest_id = ? AND revoked_at IS NULL AND learned_at IS NOT NULL AND expires_at > ?
         AND (reentry = 1 OR exited_at IS NULL) ORDER BY expires_at`,
      residentId,
      now,
    )
    .map((g) => inviteView(w, g));
  const sent = w.db.all('SELECT * FROM home_access_grants WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at', residentId, now).map((g) => inviteView(w, g));
  return { received, sent };
}

function createGrant(w: WorldService, owner: ResidentRow, guest: ResidentRow, via: 'in_person' | 'letter', reentry: boolean, validFrom: number, now: number): string {
  const grantId = w.id('h');
  const expires = validFrom + w.params.homeInvitationTtlMs;
  w.db.run(
    'INSERT INTO home_access_grants(grant_id, home_id, owner_id, guest_id, via, reentry, created_at, valid_from, expires_at, learned_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    grantId,
    homeId(owner.resident_id),
    owner.resident_id,
    guest.resident_id,
    via,
    reentry ? 1 : 0,
    now,
    validFrom,
    expires,
    via === 'in_person' ? now : null,
  );
  w.schedule('grant_expire', `grant:${grantId}`, expires, { grantId });
  return grantId;
}

/** 把一位客人请到门口（邀请到期或被撤销）。离线的客人也会被挪到门外，回来时就在巷子里。 */
function eject(w: WorldService, guestId: string, home: string, at: number, text: string): boolean {
  const guest = w.resident(guestId);
  if (!guest) return false;
  const owner = w.resident(homeOwner(home));
  const street = owner?.street_id ?? guest.street_id;
  if (guest.move) {
    // 还在路上：到门口时会再查一次权限，这里不用动
    return false;
  }
  if (guest.location_id !== home) return false;
  for (const h of w.hooks.leaveSpace) h(guest, home, at);
  const fresh = w.mustResident(guestId);
  const others = w.audienceIn(home).filter((x) => x.resident_id !== guestId);
  w.emitTo(others.map((x) => x.resident_id), 'left', { resident: card(fresh), space: home }, at);
  placeAt(w, fresh, street, at);
  // 固定模板：不透露屋里之后发生了什么
  w.emitTo([guestId], 'notice', { text }, at);
  return true;
}

function endGrant(w: WorldService, g: Row, at: number, revoked: boolean): void {
  if (revoked) w.db.run('UPDATE home_access_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', at, g.grant_id);
  w.db.run('UPDATE home_access_grants SET exited_at = COALESCE(exited_at, ?) WHERE grant_id = ? AND entered_at IS NOT NULL', at, g.grant_id);
  const owner = w.resident(g.owner_id);
  const ownerName = owner?.name ?? '主人';
  let ejected = false;
  // 还有别的有效邀请就不用出门
  if (!validGrant(w, g.guest_id, g.home_id, at)) {
    ejected = eject(w, g.guest_id, g.home_id, at, revoked ? `${ownerName}结束了这次邀请，你回到了门外的巷子里。` : `在${ownerName}家做客的时间到了，你回到了门外的巷子里。`);
  }
  // 撤销要明确告知已得知邀请的人；不在屋里时 eject 不发通知，这里补一条固定模板。
  // 还没读信（learned_at 为空）的人不通知，免得借通知泄露信里的邀请。
  if (revoked && !ejected && g.learned_at !== null && g.learned_at !== undefined) {
    w.emitTo([g.guest_id], 'notice', { text: `${ownerName}结束了这次邀请。` }, at);
  }
}

// ───────────────────────── 信件 ─────────────────────────

export interface LetterView {
  id: string;
  box: 'inbox' | 'sent';
  from: ReturnType<typeof card>;
  to: ReturnType<typeof card>;
  sentAt: number;
  deliveredAt: number | null;
  read: boolean;
  /** 没读过的来信不带正文（第一次读要回到自己家） */
  body?: string;
  invite?: { grantId: string; expiresAt: number; active: boolean };
}

function letterView(w: WorldService, row: Row, viewerId: string, now: number): LetterView {
  const inbox = row.recipient_id === viewerId;
  const readable = !inbox || row.read_at !== null;
  const g = row.invite_grant_id && readable ? w.db.get('SELECT * FROM home_access_grants WHERE grant_id = ?', row.invite_grant_id) : undefined;
  return {
    id: String(row.letter_id),
    box: inbox ? 'inbox' : 'sent',
    from: card(w.mustResident(row.sender_id)),
    to: card(w.mustResident(row.recipient_id)),
    sentAt: Number(row.sent_at),
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    read: row.read_at !== null,
    ...(readable ? { body: String(row.body) } : {}),
    ...(g ? { invite: { grantId: String(g.grant_id), expiresAt: Number(g.expires_at), active: g.revoked_at === null && g.expires_at > now } } : {}),
  };
}

export function mailboxSummary(w: WorldService, residentId: string): { unread: number; total: number } {
  return {
    unread: w.db.scalar('SELECT COUNT(*) FROM letters WHERE recipient_id = ? AND delivered_at IS NOT NULL AND read_at IS NULL AND recipient_deleted_at IS NULL', residentId),
    total: w.db.scalar('SELECT COUNT(*) FROM letters WHERE recipient_id = ? AND delivered_at IS NOT NULL AND recipient_deleted_at IS NULL', residentId),
  };
}

/**
 * 分页列出信件，从新到旧。inbox 只含已经投递到的；没读过的不带正文。
 * 翻页游标 next 是该居民自己信箱里的序号（由 rowid 换算，不暴露全局序号）：时间戳可能相同（同一毫秒寄出的几封信），用它翻页会漏信。
 * 信件的投递延迟是统一的，插入顺序和投递顺序一致。
 * next 只在翻页期间有效：软删除不移位，但日终清理（reports.ts prune）会物理删除双方都删过的信，
 * 若发生在两次翻页请求之间，序号会前移，下一页可能重复出现上一页的信（不会漏信、不会泄露）。客户端按 letterId 去重。
 */
export function listLetters(w: WorldService, residentId: string, box: 'inbox' | 'sent', before: number | null, limit: number, now: number): { letters: LetterView[]; next: number | null } {
  const lim = Math.max(1, Math.min(50, Math.floor(Number.isFinite(limit) ? limit : 20)));
  const col = box === 'inbox' ? 'recipient_id' : 'sender_id';
  // 对外的 next 是「该居民自己这个信箱里的序号」（含已删除、未投递的，按 rowid 升序从 1 数），
  // 不是全局 rowid，免得翻页游标的间隔暴露别人寄了多少信。翻页时再还原成 rowid。
  let cursor = Number.MAX_SAFE_INTEGER;
  if (before != null) {
    const n = Math.floor(before);
    if (!(n >= 1)) return { letters: [], next: null };
    const r = w.db.all(`SELECT rowid AS seq FROM letters WHERE ${col} = ? ORDER BY rowid ASC LIMIT 1 OFFSET ?`, residentId, n - 1)[0];
    cursor = r ? Number(r.seq) : 0;
  }
  const visible = box === 'inbox' ? 'delivered_at IS NOT NULL AND recipient_deleted_at IS NULL' : 'sender_deleted_at IS NULL';
  const rows = w.db.all(`SELECT rowid AS seq, * FROM letters WHERE ${col} = ? AND ${visible} AND rowid < ? ORDER BY rowid DESC LIMIT ?`, residentId, cursor, lim + 1);
  const page = rows.slice(0, lim);
  const last = page[page.length - 1];
  let next: number | null = null;
  if (rows.length > lim && last) next = Number(w.db.scalar(`SELECT COUNT(*) FROM letters WHERE ${col} = ? AND rowid <= ?`, residentId, Number(last.seq)));
  return { letters: page.map((row) => letterView(w, row, residentId, now)), next };
}

// ───────────────────────── 安装 ─────────────────────────

export function installMail(w: WorldService): void {
  setHomeAccessCheck(w, (r, home, now) => {
    if (homeOwner(home) === r.resident_id) return { ok: true };
    const g = validGrant(w, r.resident_id, home, now);
    return g ? { ok: true, grantId: String(g.grant_id) } : { ok: false, why: '需要主人当前有效的邀请。' };
  });

  // 进门：记下这次进入；主人在家才算一次登门拜访
  w.hooks.arrive.push((r, space, at) => {
    if (!isHome(space) || homeOwner(space) === r.resident_id) return;
    const g = validGrant(w, r.resident_id, space, at);
    if (g) w.db.run('UPDATE home_access_grants SET entered_at = COALESCE(entered_at, ?), exited_at = NULL WHERE grant_id = ?', at, g.grant_id);
    const owner = w.resident(homeOwner(space));
    if (owner && w.interactive(owner) && w.spaceOf(owner) === space) {
      w.fact(
        'home_visit',
        [
          { id: owner.resident_id, role: 'host' },
          { id: r.resident_id, role: 'guest' },
        ],
        {},
        { occurredAt: at },
      );
    }
  });
  w.hooks.leaveSpace.push((r, space, at) => {
    if (!isHome(space) || homeOwner(space) === r.resident_id) return;
    w.db.run('UPDATE home_access_grants SET exited_at = ? WHERE home_id = ? AND guest_id = ? AND entered_at IS NOT NULL AND exited_at IS NULL', at, space, r.resident_id);
  });

  // ── 当面邀请 ──
  w.handlers.set('invite', ({ r, action, now }) => {
    const space = w.spaceOf(r);
    const guest = w.resident(String(action.to ?? ''));
    if (!space || !guest || guest.resident_id === r.resident_id || !w.interactive(guest) || w.spaceOf(guest) !== space) {
      throw precondition('对方不在你身边。不在一处的话，可以写信邀请。', 'not_here');
    }
    takeToken(w, r.resident_id, 'invite', 4, 2, now, '发邀请');
    const grantId = createGrant(w, r, guest, 'in_person', action.reentry !== false, now, now);
    const view = inviteView(w, w.db.get('SELECT * FROM home_access_grants WHERE grant_id = ?', grantId)!);
    w.emitTo([guest.resident_id], 'invite', { invite: view, text: `${r.name}邀请你去家里坐坐。` }, now);
    return { status: 'completed', invite: view };
  });

  // ── 撤销邀请（只有主人能撤） ──
  w.handlers.set('revoke_invite', ({ r, action, now }) => {
    const g = w.db.get('SELECT * FROM home_access_grants WHERE grant_id = ? AND owner_id = ?', String(action.grantId ?? ''), r.resident_id);
    if (!g) throw precondition('没有这份邀请。', 'no_such_invite');
    if (g.revoked_at !== null || g.expires_at <= now) throw precondition('这份邀请已经失效了。', 'invite_closed');
    endGrant(w, g, now, true);
    w.cancelJob(`grant:${g.grant_id}`);
    return { status: 'completed' };
  });

  w.jobHandlers.set('grant_expire', (payload, _job, now) => {
    const g = w.db.get('SELECT * FROM home_access_grants WHERE grant_id = ?', String(payload.grantId));
    if (!g || g.revoked_at !== null) return;
    endGrant(w, g, Math.min(now, Number(g.expires_at)), false);
  });

  // ── 寄信 ──
  w.handlers.set('send_letter', ({ r, action, now }) => {
    const to = w.resident(String(action.to ?? ''));
    if (!to || to.resident_id === r.resident_id) throw precondition('没有这位收信人。', 'no_such_resident');
    const raw = typeof action.body === 'string' ? action.body : '';
    const body = [...sanitizeUserText(raw).trim()].slice(0, w.params.letterMaxChars).join('');
    if (!body) throw badRequest('信里要写点什么。');
    const date = w.today(now);
    if (counter(w, `letters:${r.resident_id}`, 'sent', date) >= w.params.lettersPerDay) throw precondition(`今天已经寄了 ${w.params.lettersPerDay} 封信，明天再写吧。`, 'daily_limit');
    // 寄出时就占住对方信箱的位置：满了当场告诉寄信人，不会寄到一半丢掉
    const held = w.db.scalar('SELECT COUNT(*) FROM letters WHERE recipient_id = ? AND recipient_deleted_at IS NULL', to.resident_id);
    if (held >= w.params.mailboxCapacity) throw precondition(`${to.name}的信箱满了，过些时候再寄。`, 'mailbox_full');
    bumpCounter(w, `letters:${r.resident_id}`, 'sent', date);
    const letterId = w.id('m');
    const deliverAt = now + w.params.letterDeliveryDelayMs;
    const grantId = action.invite ? createGrant(w, r, to, 'letter', (action.invite as { reentry?: unknown }).reentry !== false, deliverAt, now) : null;
    w.db.run('INSERT INTO letters(letter_id, world_id, sender_id, recipient_id, body, invite_grant_id, sent_at, deliver_at) VALUES (?,?,?,?,?,?,?,?)', letterId, w.worldId, r.resident_id, to.resident_id, body, grantId, now, deliverAt);
    w.schedule('letter_deliver', `letter:${letterId}`, deliverAt, { letterId });
    w.fact(
      'letter_sent',
      [
        { id: r.resident_id, role: 'sender' },
        { id: to.resident_id, role: 'recipient' },
      ],
      { invite: Boolean(grantId) },
    );
    return { status: 'accepted', letterId, deliverAt, text: `信寄出了，大约 ${Math.round(w.params.letterDeliveryDelayMs / 1000)} 秒后送到${to.name}的信箱。` };
  });

  w.jobHandlers.set('letter_deliver', (payload) => {
    const row = w.db.get('SELECT * FROM letters WHERE letter_id = ? AND delivered_at IS NULL', String(payload.letterId));
    if (!row) return;
    // 投递时间记应该送到的那一刻（停机追赶时不是「现在」）
    w.db.run('UPDATE letters SET delivered_at = ? WHERE letter_id = ?', row.deliver_at, row.letter_id);
    if (row.recipient_deleted_at !== null) return;
    // 在外面只知道「有新信」，不知道是谁寄的、写了什么
    w.emitTo([row.recipient_id], 'mail', { ...mailboxSummary(w, row.recipient_id), text: '信箱里有一封新信，回家就能读。' }, Number(row.deliver_at));
  });

  // ── 读信：第一次读要在自己家 ──
  w.handlers.set('read_letter', ({ r, action, now }) => {
    const row = w.db.get('SELECT * FROM letters WHERE letter_id = ? AND recipient_id = ? AND delivered_at IS NOT NULL AND recipient_deleted_at IS NULL', String(action.letterId ?? ''), r.resident_id);
    if (!row) throw precondition('信箱里没有这封信。', 'no_such_letter');
    if (row.read_at === null) {
      if (w.spaceOf(r) !== homeId(r.resident_id)) throw precondition('新来的信要回到自己家才能拆开读。', 'not_home');
      w.db.run('UPDATE letters SET read_at = ? WHERE letter_id = ?', now, row.letter_id);
      row.read_at = now;
      if (row.invite_grant_id) {
        // 读到信才算得知这份邀请
        w.db.run('UPDATE home_access_grants SET learned_at = COALESCE(learned_at, ?) WHERE grant_id = ?', now, row.invite_grant_id);
      }
    }
    return { status: 'completed', letter: letterView(w, row, r.resident_id, now), mail: mailboxSummary(w, r.resident_id) };
  });

  w.handlers.set('delete_letter', ({ r, action, now }) => {
    const id = String(action.letterId ?? '');
    const a = w.db.run('UPDATE letters SET recipient_deleted_at = ? WHERE letter_id = ? AND recipient_id = ? AND delivered_at IS NOT NULL AND recipient_deleted_at IS NULL', now, id, r.resident_id).changes;
    const b = w.db.run('UPDATE letters SET sender_deleted_at = ? WHERE letter_id = ? AND sender_id = ? AND sender_deleted_at IS NULL', now, id, r.resident_id).changes;
    if (a + b === 0) throw precondition('没有这封信。', 'no_such_letter');
    return { status: 'completed', mail: mailboxSummary(w, r.resident_id) };
  });
  void placeDef;
  void spaceName;
}
