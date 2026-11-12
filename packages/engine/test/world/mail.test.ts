/**
 * 栖灯镇：住宅访问（邀请）与信件。
 * 对照设计文档第 3 节「住宅」、第 5 节「信件邀请与住宅访问」、第 10 节「信息可见范围」。
 */
import { describe, expect, it } from 'vitest';
import { listLetters } from '../../src/world/mail.js';
import { chatHistory, publicView } from '../../src/world/views.js';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const STEP = 50_000; // 保持心跳的步长（小于 60 秒宽限）

const homeOf = (a: Actor) => `home:${a.residentId}`;
const loc = (a: Actor) => a.row().location_id;
const inbox = (a: Actor, limit = 50, before: number | null = null) => listLetters(a.t.w, a.residentId, 'inbox', before, limit, a.t.clock.t);
const sentBox = (a: Actor, limit = 50, before: number | null = null) => listLetters(a.t.w, a.residentId, 'sent', before, limit, a.t.clock.t);
const grantRow = (t: Town, grantId: string) => t.w.db.get('SELECT * FROM home_access_grants WHERE grant_id = ?', grantId)!;
const publicCount = (t: Town) => t.w.db.scalar('SELECT COUNT(*) FROM public_events');
const noticeTexts = (a: Actor, cursor: string) => a.events(cursor).events.filter((e) => e.type === 'notice').map((e) => String(e.data.text));
const present = (a: Actor) => a.row().present_since !== null;

/** 重启并换随机种子（固定种子的编号序列在重启后会重复，真实环境用密码学随机不会）。 */
function restartFresh(t: Town) {
  (t.opts as { seed?: string }).seed = `after-restart-${t.clock.t}`;
  return t.restart();
}

/** 让时间前进 ms，期间名单上的人一直保持心跳（先续一次租，免得之前已经过去的时间让租约到期）。 */
function stay(t: Town, ms: number, actors: Actor[]): void {
  for (const x of actors) x.heartbeat();
  t.advanceAlive(ms, actors, STEP);
}

const roster = new WeakMap<Town, Actor[]>();

/** 阿灯和小满住东灯巷，小岚住西灯巷；都在广场。 */
function town3() {
  const t = makeTown();
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  const c = t.join('小满');
  roster.set(t, [a, b, c]);
  return { t, a, b, c };
}

/** a 当面邀请 b，返回 grantId。 */
function invitePersonally(a: Actor, b: Actor, extra: Record<string, unknown> = {}): string {
  return a.act('invite', { to: b.residentId, ...extra }).invite.grantId;
}

/** a 给 b 寄信并等它送到。 */
function sendAndDeliver(a: Actor, b: Actor, body: string, extra: Record<string, unknown> = {}): { letterId: string; deliverAt: number } {
  const out = a.act('send_letter', { to: b.residentId, body, ...extra });
  stay(a.t, out.deliverAt - a.t.clock.t, roster.get(a.t) ?? [a, b]);
  return { letterId: out.letterId, deliverAt: out.deliverAt };
}

describe('栖灯镇住宅：没有邀请进不了别人的家', () => {
  it('出发时检查：没有邀请直接被拒，位置不变，不留下移动任务', () => {
    const { t, a, b } = town3();
    const err = b.fail('move', { to: homeOf(a) });
    expect(err.code).toBe('precondition_failed');
    expect(err.reason).toBe('no_access');
    expect(b.row().move).toBeNull();
    expect(loc(b)).toBe('plaza');
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'move_arrive'")).toBe(0);
    // 站在巷子里也一样
    b.go('street_east');
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('当面邀请立刻生效：受邀者出发（广场到东灯巷 10 秒 + 进门 3 秒）、到达，邀请本身不移动任何人', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b);
    const out = b.act('move', { to: homeOf(a) });
    expect(out.move.arriveAt - t.clock.t).toBe(13_000);
    t.advanceTo(out.move.arriveAt);
    expect(loc(b)).toBe(homeOf(a));
    expect(Number(grantRow(t, grantId).entered_at)).toBe(out.move.arriveAt);
    expect(loc(a)).toBe('plaza');
  });

  it('邀请只对被邀请的人有效；第三者进不去', () => {
    const { a, b, c } = town3();
    invitePersonally(a, b);
    expect(c.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('邀请只授权邀请人自己的住宅：客人不能替房主再邀请别人', () => {
    const { t, a } = town3();
    const b2 = t.join('小朵');
    const c2 = t.join('小林');
    b2.act('invite', { to: c2.residentId });
    for (const g of t.w.db.all('SELECT home_id, owner_id FROM home_access_grants')) expect(g.home_id).toBe(`home:${g.owner_id}`);
    expect(c2.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
    expect(c2.act('move', { to: homeOf(b2) }).status).toBe('accepted');
  });

  it('当面邀请要求对方在身边（同地点、在场）', () => {
    const { a, b } = town3();
    b.go('tea_house');
    expect(a.fail('invite', { to: b.residentId }).reason).toBe('not_here');
    expect(a.fail('invite', { to: a.residentId }).reason).toBe('not_here');
  });

  it('邀请 24 小时有效；恰好到期那一刻起出发被拒，邀请列表里也没有了', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b);
    const expiresAt = Number(grantRow(t, grantId).expires_at);
    expect(expiresAt - t.clock.t).toBe(DAY);
    expect(b.view().invites.received.map((i) => i.grantId)).toEqual([grantId]);
    stay(t, DAY - 1, [a, b]);
    expect(t.clock.t).toBe(expiresAt - 1);
    expect(b.view().invites.received).toHaveLength(1);
    stay(t, 1, [a, b]);
    expect(b.view().invites.received).toEqual([]);
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('到达时才过期（恰好同一时刻）：停在门外的巷子里，只收到固定说明', () => {
    const { t, a, b } = town3();
    invitePersonally(a, b);
    stay(t, DAY - 13_000, [a, b]);
    const cursor = b.view().cursor;
    const out = b.act('move', { to: homeOf(a) }); // 出发时仍有效
    expect(out.status).toBe('accepted');
    stay(t, 13_000, [a, b]);
    expect(loc(b)).toBe('street_east');
    expect(noticeTexts(b, cursor)).toEqual(['你走到了阿灯的家门口，但没能进去：需要主人当前有效的邀请。']);
  });

  it('到达前 1 毫秒还有效：进了屋，随后在到期那一刻被送到门外', () => {
    const { t, a, b } = town3();
    invitePersonally(a, b);
    stay(t, DAY - 13_001, [a, b]);
    const out = b.act('move', { to: homeOf(a) });
    const cursor = b.view().cursor;
    t.advanceTo(out.move.arriveAt); // 到期前 1 毫秒到达：在屋里
    expect(t.clock.t).toBe(Number(grantRow(t, a.view().invites.sent[0]!.grantId).expires_at) - 1);
    expect(loc(b)).toBe(homeOf(a));
    stay(t, 1, [a, b]); // 到期那一刻被送到门外
    expect(loc(b)).toBe('street_east');
    expect(noticeTexts(b, cursor)).toEqual(['在阿灯家做客的时间到了，你回到了门外的巷子里。']);
  });

  it('邀请在路上被撤销：出发时合法，到门口时挡住（停在巷子里）', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b);
    const cursor = b.view().cursor;
    b.act('move', { to: homeOf(a) });
    stay(t, 5_000, [a, b]);
    a.act('revoke_invite', { grantId });
    stay(t, 8_000, [a, b]);
    expect(loc(b)).toBe('street_east');
    expect(b.row().move).toBeNull();
    expect(noticeTexts(b, cursor)).toHaveLength(1);
    expect(grantRow(t, grantId).entered_at).toBeNull();
  });

  it('房主离线不取消已经生效的邀请：客人仍可进屋', () => {
    const { t, a, b } = town3();
    invitePersonally(a, b);
    a.leave();
    b.go(homeOf(a));
    expect(loc(b)).toBe(homeOf(a));
    // 屋里看不到离线的房主，但房主标识仍是这户人家
    expect(b.view().here?.residents).toEqual([]);
    expect(b.view().here?.home?.owner.id).toBe(a.residentId);
    void t;
  });

  it('主人自己随时可以回家，不需要任何邀请；用 home 或 home:<id> 都行', () => {
    const { a, c } = town3();
    expect(c.act('move', { to: 'home' }).status).toBe('accepted');
    a.go(homeOf(a));
    expect(loc(a)).toBe(homeOf(a));
    a.go('plaza');
    a.go('home');
    expect(loc(a)).toBe(homeOf(a));
  });

  it('邀请的撤销权只属于房主，撤销过的 / 不存在的 / 过期的邀请不能再撤', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b);
    expect(b.fail('revoke_invite', { grantId }).reason).toBe('no_such_invite');
    expect(a.fail('revoke_invite', { grantId: 'h_nothing' }).reason).toBe('no_such_invite');
    a.act('revoke_invite', { grantId });
    expect(a.fail('revoke_invite', { grantId }).reason).toBe('invite_closed');
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
    // 过期的邀请
    const g2 = invitePersonally(a, b);
    stay(t, DAY, [a, b]);
    expect(a.fail('revoke_invite', { grantId: g2 }).reason).toBe('invite_closed');
  });

  it('当面邀请的提示是固定模板，只带双方名片', () => {
    const { a, b } = town3();
    const cursor = b.view().cursor;
    invitePersonally(a, b);
    const ev = b.events(cursor).events.find((e) => e.type === 'invite')!;
    expect(ev.data.text).toBe('阿灯邀请你去家里坐坐。');
    expect(Object.keys(ev.data).sort()).toEqual(['invite', 'text']);
    expect(Object.keys(ev.data.invite as object).sort()).toEqual(['expiresAt', 'grantId', 'guest', 'home', 'host', 'reentry', 'via']);
  });
});

describe('栖灯镇住宅：reentry（离开后能否再进）', () => {
  it('reentry 默认允许：有效期内进出多次', () => {
    const { a, b } = town3();
    invitePersonally(a, b);
    b.go(homeOf(a));
    b.go('street_east');
    b.go(homeOf(a));
    expect(loc(b)).toBe(homeOf(a));
  });

  it('reentry=false：待在屋里一直有效，出了门就不能再进，邀请列表里也消失', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b, { reentry: false });
    expect(grantRow(t, grantId).reentry).toBe(0);
    b.go(homeOf(a));
    expect(b.view().invites.received).toHaveLength(1);
    stay(t, HOUR, [a, b]); // 在屋里待多久都行
    expect(loc(b)).toBe(homeOf(a));
    b.go('street_east');
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
    expect(b.view().invites.received).toEqual([]);
    expect(grantRow(t, grantId).revoked_at).toBeNull(); // 没有撤销，只是用掉了
  });

  it('reentry=false 但还没进过门：可以进一次', () => {
    const { a, b } = town3();
    invitePersonally(a, b, { reentry: false });
    b.go(homeOf(a));
    expect(loc(b)).toBe(homeOf(a));
  });
});

describe('栖灯镇住宅：撤销 / 过期时屋里的客人被送到门口', () => {
  /** a、b 都在 a 家里（b 是客人）。 */
  function inHome() {
    const s = town3();
    const grantId = invitePersonally(s.a, s.b);
    s.a.go('home');
    s.b.go(homeOf(s.a));
    return { ...s, grantId };
  }

  it('撤销：客人被送到房主那条巷子的门口，只收到固定模板通知；公开层面没有任何变化', () => {
    const { t, a, b, grantId } = inHome();
    expect(a.view().here?.residents.map((r) => r.name)).toEqual(['小岚']);
    b.act('speak', { text: '屋里说的话' });
    const cursor = b.view().cursor;
    const pubBefore = publicCount(t);
    const where = publicView(t.w).residential.residents.map((r) => r.id).sort();

    a.act('revoke_invite', { grantId });

    expect(loc(b)).toBe('street_east');
    expect(b.row().move).toBeNull();
    expect(noticeTexts(b, cursor)).toEqual(['阿灯结束了这次邀请，你回到了门外的巷子里。']);
    // 客人只收到：自己到了巷子 + 固定通知，没有别的
    expect(b.events(cursor).events.map((e) => e.type)).toEqual(['you_arrived', 'notice']);
    // 公开事件流没有「谁被请出了家门」；住宅区的人没变
    expect(publicCount(t)).toBe(pubBefore);
    expect(publicView(t.w).residential.residents.map((r) => r.id).sort()).toEqual(where);
    // 不能再回去
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('被请出之后听不到屋里的新话，但此前合法听到的话仍在本人历史里', () => {
    const { a, b, grantId } = inHome();
    b.act('speak', { text: '请出之前说的' });
    a.act('speak', { text: '请出之前主人说的' });
    a.act('revoke_invite', { grantId });
    const out = a.act('speak', { text: '请出之后的话' });
    expect(out.heardBy).toBe(0);
    const heard = chatHistory(b.t.w, b.residentId, null, 50).messages.map((m) => m.text);
    expect(heard.sort()).toEqual(['请出之前主人说的', '请出之前说的'].sort());
  });

  it('离线的客人（显式离开）也被送到门口；回来时就在巷子里，并能看到固定通知', () => {
    const { t, a, b, grantId } = inHome();
    b.leave();
    const cursor = b.view().cursor;
    a.act('revoke_invite', { grantId });
    expect(loc(b)).toBe('street_east');
    expect(present(b)).toBe(false);
    b.enter();
    expect(b.view().here?.space).toBe('street_east');
    expect(noticeTexts(b, cursor)).toEqual(['阿灯结束了这次邀请，你回到了门外的巷子里。']);
    void t;
  });

  it('离线的客人（租约到期）在邀请过期时也被送到门口，不能借断线保留访问权', () => {
    const { t, a, b, grantId } = inHome();
    const expiresAt = Number(grantRow(t, grantId).expires_at);
    const cursor = b.view().cursor;
    // 只有房主保持心跳，b 60 秒后离线
    stay(t, expiresAt - t.clock.t - 1, [a]);
    expect(present(b)).toBe(false);
    expect(loc(b)).toBe(homeOf(a)); // 还没到期，仍在屋里
    stay(t, 1, [a]);
    expect(loc(b)).toBe('street_east');
    b.enter();
    expect(b.view().here?.space).toBe('street_east');
    expect(noticeTexts(b, cursor)).toEqual(['在阿灯家做客的时间到了，你回到了门外的巷子里。']);
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('在线的客人在邀请过期时被送到门口', () => {
    const { t, a, b, grantId } = inHome();
    const expiresAt = Number(grantRow(t, grantId).expires_at);
    stay(t, expiresAt - t.clock.t, [a, b]);
    expect(loc(b)).toBe('street_east');
    expect(present(b)).toBe(true);
  });

  it('客人还有另一份有效邀请时不用出门；两份都没了才被请出', () => {
    const { t, a, b, grantId } = inHome();
    const g2 = invitePersonally(a, b); // a 在家里，b 在身边
    a.act('revoke_invite', { grantId });
    expect(loc(b)).toBe(homeOf(a));
    a.act('revoke_invite', { grantId: g2 });
    expect(loc(b)).toBe('street_east');
    void t;
  });

  it('主人自己不会被自己的撤销请出家门', () => {
    const { a, grantId } = inHome();
    a.act('revoke_invite', { grantId });
    expect(loc(a)).toBe(homeOf(a));
  });

  it('客人在路上要离开（正在走出屋）时撤销：不会被拽回，也不会重复通知', () => {
    const { t, a, b, grantId } = inHome();
    const cursor = b.view().cursor;
    b.act('move', { to: 'plaza' });
    a.act('revoke_invite', { grantId });
    stay(t, 30_000, [a, b]);
    expect(loc(b)).toBe('plaza');
    expect(noticeTexts(b, cursor)).toEqual([]);
  });
});

describe('栖灯镇信件：延迟送达与外出提示', () => {
  it('默认 60 秒后送到；之前信箱里没有，之后有', () => {
    const { t, a, b } = town3();
    const out = a.act('send_letter', { to: b.residentId, body: '你好' });
    expect(out.status).toBe('accepted');
    expect(out.deliverAt - t.clock.t).toBe(60_000);
    expect(b.view().mail).toEqual({ unread: 0, total: 0 });
    stay(t, 59_999, [a, b]);
    expect(b.view().mail).toEqual({ unread: 0, total: 0 });
    expect(inbox(b).letters).toEqual([]);
    stay(t, 1, [a, b]);
    expect(b.view().mail).toEqual({ unread: 1, total: 1 });
    expect(inbox(b).letters).toHaveLength(1);
  });

  it('送达时间可配置', () => {
    const t = makeTown({ params: { letterDeliveryDelayMs: 5_000 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const out = a.act('send_letter', { to: b.residentId, body: '快信' });
    expect(out.deliverAt - t.clock.t).toBe(5_000);
    t.advance(5_000);
    expect(b.view().mail.unread).toBe(1);
  });

  it('在外面只知道「有新信」：事件只有数量和固定提示，没有寄信人、正文、信件编号', () => {
    const { t, a, b } = town3();
    b.go('tea_house');
    const cursor = b.view().cursor;
    const { letterId } = sendAndDeliver(a, b, '机密正文Q7X');
    const mails = b.events(cursor).events.filter((e) => e.type === 'mail');
    expect(mails).toHaveLength(1);
    expect(Object.keys(mails[0]!.data).sort()).toEqual(['text', 'total', 'unread']);
    expect(mails[0]!.data).toMatchObject({ unread: 1, total: 1 });
    const dump = JSON.stringify(b.events(cursor).events);
    for (const secret of ['机密正文Q7X', '阿灯', a.residentId, letterId]) expect(dump).not.toContain(secret);
    // 寄信人自己不会因为「送达」收到任何事件
    expect(a.events().events).toEqual([]);
    void t;
  });

  it('连续几封信：未读数累加', () => {
    const { t, a, b, c } = town3();
    const cursor = b.view().cursor;
    sendAndDeliver(a, b, '一');
    sendAndDeliver(c, b, '二');
    const mails = b.events(cursor).events.filter((e) => e.type === 'mail');
    expect(mails.map((m) => [m.data.unread, m.data.total])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    void t;
  });

  it('收件人离线照常送达，回来能看到；送达时间记应该送到的那一刻', () => {
    const { t, a, b } = town3();
    b.leave();
    const out = a.act('send_letter', { to: b.residentId, body: '你不在家的时候寄的' });
    t.clock.advance(10 * 60_000); // 没人处理，隔了很久才检查
    t.w.tick();
    const row = t.w.db.get('SELECT delivered_at FROM letters WHERE letter_id = ?', out.letterId)!;
    expect(Number(row.delivered_at)).toBe(out.deliverAt);
    b.enter();
    expect(b.view().mail).toEqual({ unread: 1, total: 1 });
    expect(b.view().suggestions.join()).toContain('新信');
  });

  it('未读信件列表不带正文；寄信人自己的已发副本带正文', () => {
    const { t, a, b } = town3();
    sendAndDeliver(a, b, '机密正文Q7X');
    const l = inbox(b).letters[0]!;
    expect(l.read).toBe(false);
    expect(l.body).toBeUndefined();
    expect(l.invite).toBeUndefined();
    expect(JSON.stringify(inbox(b))).not.toContain('机密正文Q7X');
    expect(JSON.stringify(b.view())).not.toContain('机密正文Q7X');
    const mine = sentBox(a).letters[0]!;
    expect(mine.box).toBe('sent');
    expect(mine.body).toBe('机密正文Q7X');
    void t;
  });

  it('寄给不存在的人 / 自己：被拒绝，不占每日额度，不留下邀请', () => {
    const { t, a } = town3();
    for (const to of ['r_nobody', a.residentId, '']) {
      expect(a.fail('send_letter', { to, body: '寄不出去', invite: {} }).reason).toBe('no_such_resident');
    }
    expect(t.w.db.scalar('SELECT COUNT(*) FROM letters')).toBe(0);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM home_access_grants')).toBe(0);
    expect(t.w.db.scalar("SELECT COALESCE(SUM(count),0) FROM interaction_counters WHERE category = 'sent'")).toBe(0);
  });

  it('同一个请求号重放只寄一封', () => {
    const { t, a, b } = town3();
    const first = a.act('send_letter', { to: b.residentId, body: '只寄一次' }, { requestId: 'letter-req-0001' });
    const again = a.act('send_letter', { to: b.residentId, body: '只寄一次' }, { requestId: 'letter-req-0001' });
    expect(again.replayed).toBe(true);
    expect(again.letterId).toBe(first.letterId);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM letters')).toBe(1);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'letter_deliver'")).toBe(1);
  });

  it('寄出后重启：到点照常送达，只送一次，只提示一次', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const a = t.join('阿灯');
      const b = t.join('小岚', 'agent');
      const out = a.act('send_letter', { to: b.residentId, body: '跨过重启的信' });
      t.advance(5_000);
      t.w.close();
      t.clock.advance(5 * 60_000); // 停机很久
      restartFresh(t);
      const row = t.w.db.get('SELECT delivered_at FROM letters WHERE letter_id = ?', out.letterId)!;
      expect(Number(row.delivered_at)).toBe(out.deliverAt);
      t.advance(10 * 60_000);
      expect(t.w.db.scalar('SELECT COUNT(*) FROM letters WHERE delivered_at IS NOT NULL')).toBe(1);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE resident_id = ? AND type = 'mail'", b.residentId)).toBe(1);
      expect(b.view().mail).toEqual({ unread: 1, total: 1 });
      t.w.close();
    } finally {
      db.cleanup();
    }
  });
});

describe('栖灯镇信件：首次阅读要回自己家', () => {
  it('不在家（广场、路上）读不了，信仍然未读；在家读到正文；之后在哪都能重读', () => {
    const { t, a, b } = town3();
    const { letterId } = sendAndDeliver(a, b, '机密正文Q7X\n第二行');
    expect(b.fail('read_letter', { letterId }).reason).toBe('not_home');
    b.act('move', { to: 'home' });
    expect(b.fail('read_letter', { letterId }).reason).toBe('not_home'); // 在路上
    stay(t, 13_000, [a, b]);
    expect(b.view().mail.unread).toBe(1);

    const first = b.act('read_letter', { letterId });
    expect(first.letter.body).toBe('机密正文Q7X\n第二行');
    expect(first.letter.read).toBe(true);
    expect(first.mail).toEqual({ unread: 0, total: 1 });
    const readAt = Number(t.w.db.get('SELECT read_at FROM letters WHERE letter_id = ?', letterId)!.read_at);

    stay(t, 30_000, [a, b]);
    b.go('tea_house');
    const again = b.act('read_letter', { letterId });
    expect(again.letter.body).toBe('机密正文Q7X\n第二行');
    expect(Number(t.w.db.get('SELECT read_at FROM letters WHERE letter_id = ?', letterId)!.read_at)).toBe(readAt); // 重读不改首次阅读时间
    // 已读的信在列表里带正文，在哪都能看到
    expect(inbox(b).letters[0]!.body).toBe('机密正文Q7X\n第二行');
  });

  it('别人读不到这封信：收信人以外的人（包括寄信人）得到「没有这封信」', () => {
    const { a, b, c } = town3();
    const { letterId } = sendAndDeliver(a, b, '机密正文Q7X');
    c.go('home');
    a.go('home');
    for (const who of [a, c]) {
      expect(who.fail('read_letter', { letterId }).reason).toBe('no_such_letter');
    }
    expect(a.fail('read_letter', { letterId: 'm_nothing' }).reason).toBe('no_such_letter'); // 与不存在一致
    // 别人的信箱列表里也没有
    expect(JSON.stringify(inbox(c))).not.toContain('机密正文Q7X');
    expect(JSON.stringify(sentBox(c))).not.toContain('机密正文Q7X');
  });

  it('还没送到的信读不了（收信人拿到编号也不行）', () => {
    const { a, b } = town3();
    const out = a.act('send_letter', { to: b.residentId, body: '还在路上' });
    b.go('home');
    expect(b.fail('read_letter', { letterId: out.letterId }).reason).toBe('no_such_letter');
  });

  it('读信不会触发任何别的动作：不移动、不接受邀请之外的提议', () => {
    const { t, a, b } = town3();
    const { letterId } = sendAndDeliver(a, b, '请你来喝茶，也送你一块饼干', {});
    b.go('home');
    const here = loc(b);
    b.act('read_letter', { letterId });
    expect(loc(b)).toBe(here);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM offers')).toBe(0);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM home_access_grants')).toBe(0);
  });
});

describe('栖灯镇信件：额度、长度、清洗、删除', () => {
  it('每天最多 20 封（按寄信人）：第 21 封 daily_limit，被拒的不占额度；换一个世界日重新计', () => {
    const { t, a, b } = town3();
    for (let i = 0; i < 20; i++) a.act('send_letter', { to: b.residentId, body: `第${i + 1}封` });
    const err = a.fail('send_letter', { to: b.residentId, body: '第21封' });
    expect(err.reason).toBe('daily_limit');
    // 对别的收信人也一样；别的寄信人不受影响
    expect(a.fail('send_letter', { to: b.residentId, body: '再来' }).reason).toBe('daily_limit');
    expect(() => b.act('send_letter', { to: a.residentId, body: '我还能寄' })).not.toThrow();
    expect(t.w.db.scalar('SELECT COUNT(*) FROM letters WHERE sender_id = ?', a.residentId)).toBe(20);
    // 世界日翻过去
    const today = t.w.today();
    while (t.w.today() === today) t.advance(HOUR);
    a.enter();
    expect(() => a.act('send_letter', { to: b.residentId, body: '新的一天' })).not.toThrow();
  });

  it('每日额度可配置', () => {
    const t = makeTown({ params: { lettersPerDay: 2 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('send_letter', { to: b.residentId, body: '1' });
    a.act('send_letter', { to: b.residentId, body: '2' });
    expect(a.fail('send_letter', { to: b.residentId, body: '3' }).reason).toBe('daily_limit');
  });

  it('信箱满了：寄的时候当场告诉寄信人，不占寄信人的额度', () => {
    const t = makeTown({ params: { mailboxCapacity: 2 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('send_letter', { to: b.residentId, body: '1' });
    a.act('send_letter', { to: b.residentId, body: '2' });
    expect(a.fail('send_letter', { to: b.residentId, body: '3' }).reason).toBe('mailbox_full');
    expect(t.w.db.scalar("SELECT count FROM interaction_counters WHERE category = 'sent'")).toBe(2);
  });

  it('1000 字符上限（按 Unicode 字符计，不拆开表情符号）', () => {
    const { t, a, b } = town3();
    a.act('send_letter', { to: b.residentId, body: '灯'.repeat(1500) });
    a.act('send_letter', { to: b.residentId, body: '😀'.repeat(1200) });
    a.act('send_letter', { to: b.residentId, body: '字'.repeat(1000) });
    const bodies = sentBox(a).letters.map((l) => l.body!);
    expect(bodies.map((x) => [...x].length).sort()).toEqual([1000, 1000, 1000]);
    expect(bodies).toContain('😀'.repeat(1000));
    void t;
  });

  it('信件内容经过清洗：控制字符、{@ 、[CQ: ；空信被拒绝；换行保留', () => {
    const { a, b } = town3();
    a.act('send_letter', { to: b.residentId, body: '第一行\n第二行\u0007 {@all} [CQ:at,qq=1]' });
    const body = sentBox(a).letters[0]!.body!;
    expect(body).not.toMatch(/\u0007/);
    expect(body).not.toContain('{@');
    expect(body.toLowerCase()).not.toContain('[cq:');
    expect(body.startsWith('第一行\n第二行')).toBe(true);
    for (const empty of ['', '   \n ', '\u0007', undefined, 7]) {
      expect(a.fail('send_letter', { to: b.residentId, body: empty }).code).toBe('bad_request');
    }
  });

  it('收信人删除：从信箱和未读数里消失，寄信人的已发副本还在；寄信人删除不影响收信人', () => {
    const { t, a, b, c } = town3();
    const l1 = sendAndDeliver(a, b, '甲');
    const l2 = sendAndDeliver(a, b, '乙');
    expect(b.view().mail).toEqual({ unread: 2, total: 2 });
    b.act('delete_letter', { letterId: l1.letterId });
    expect(b.view().mail).toEqual({ unread: 1, total: 1 });
    expect(inbox(b).letters.map((l) => l.id)).toEqual([l2.letterId]);
    expect(sentBox(a).letters.map((l) => l.body).sort()).toEqual(['乙', '甲']);
    a.act('delete_letter', { letterId: l2.letterId });
    expect(sentBox(a).letters.map((l) => l.body)).toEqual(['甲']);
    expect(inbox(b).letters.map((l) => l.id)).toEqual([l2.letterId]); // 对方的副本不受影响
    // 无关的人不能删；重复删、没送到的信不能由收信人删
    expect(c.fail('delete_letter', { letterId: l2.letterId }).reason).toBe('no_such_letter');
    expect(b.fail('delete_letter', { letterId: l1.letterId }).reason).toBe('no_such_letter');
    const pending = a.act('send_letter', { to: b.residentId, body: '还在路上' });
    expect(b.fail('delete_letter', { letterId: pending.letterId }).reason).toBe('no_such_letter');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM letters')).toBe(3);
  });

  it('删除之后不会再被「读」出来', () => {
    const { a, b } = town3();
    const { letterId } = sendAndDeliver(a, b, '甲');
    b.act('delete_letter', { letterId });
    b.go('home');
    expect(b.fail('read_letter', { letterId }).reason).toBe('no_such_letter');
  });

  it('分页：同一时刻寄出的多封信翻页不丢不重（已发 / 收件箱）', () => {
    const { t, a, b } = town3();
    for (let i = 1; i <= 5; i++) a.act('send_letter', { to: b.residentId, body: `信${i}` });
    stay(t, 60_000, [a, b]);
    for (const [who, box] of [
      [a, 'sent'],
      [b, 'inbox'],
    ] as const) {
      const seen: string[] = [];
      let before: number | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page: ReturnType<typeof inbox> = listLetters(t.w, who.residentId, box, before, 2, t.clock.t);
        seen.push(...page.letters.map((l) => l.id));
        if (page.next === null) break;
        before = page.next;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    }
  });

  it('分页：不同时刻寄出的信，从新到旧翻页', () => {
    const { t, a, b } = town3();
    for (let i = 1; i <= 5; i++) {
      a.act('send_letter', { to: b.residentId, body: `信${i}` });
      stay(t, 1_000, [a, b]);
    }
    stay(t, 60_000, [a, b]);
    const p1 = sentBox(a, 2);
    expect(p1.letters.map((l) => l.body)).toEqual(['信5', '信4']);
    const p2 = sentBox(a, 2, p1.next);
    expect(p2.letters.map((l) => l.body)).toEqual(['信3', '信2']);
    const p3 = sentBox(a, 2, p2.next);
    expect(p3.letters.map((l) => l.body)).toEqual(['信1']);
    expect(p3.next).toBeNull();
  });
});

describe('栖灯镇信件：随信邀请在读信后才生效', () => {
  /** a 寄信给 b，附一份邀请；返回信和邀请编号。 */
  function letterWithInvite(extra: Record<string, unknown> = {}) {
    const s = town3();
    const out = s.a.act('send_letter', { to: s.b.residentId, body: '来家里坐坐吧', invite: { reentry: true, ...extra } });
    const grantId = s.a.view().invites.sent[0]!.grantId;
    return { ...s, letterId: out.letterId as string, deliverAt: out.deliverAt as number, grantId };
  }

  it('授权从送达时刻起算 24 小时（不是从阅读起算）；还没读时是「未得知」', () => {
    const { t, deliverAt, grantId } = letterWithInvite();
    const g = grantRow(t, grantId);
    expect(g.via).toBe('letter');
    expect(Number(g.valid_from)).toBe(deliverAt);
    expect(Number(g.expires_at)).toBe(deliverAt + DAY);
    expect(g.learned_at).toBeNull();
  });

  it('送达之前、送达之后读信之前：进不了门，邀请列表是空的，提示里没有邀请', () => {
    const { t, a, b, letterId } = letterWithInvite();
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
    stay(t, 60_000, [a, b]);
    const cursor = b.view().cursor;
    expect(b.view().mail.unread).toBe(1);
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
    expect(b.view().invites.received).toEqual([]);
    expect(inbox(b).letters[0]!.invite).toBeUndefined();
    expect(JSON.stringify(b.view())).not.toContain('来家里坐坐吧');
    void cursor;
    void letterId;
    // 寄信人自己看得到这份发出去的邀请（含 grantId），收信人看不到
    expect(a.view().invites.sent).toHaveLength(1);
  });

  it('送达时的事件不泄露邀请：只有数量和固定提示', () => {
    const { t, a, b, c, grantId } = letterWithInvite();
    const cursor = b.view().cursor;
    stay(t, 60_000, [a, b, c]);
    const dump = JSON.stringify(b.events(cursor).events);
    expect(b.events(cursor).events.map((e) => e.type)).toEqual(['mail']);
    for (const leak of [grantId, '邀请', '阿灯', homeOf(a)]) expect(dump).not.toContain(leak);
  });

  it('在自己家第一次读信之后：邀请生效、出现在邀请列表，可以赴约', () => {
    const { t, a, b, letterId, grantId } = letterWithInvite();
    stay(t, 60_000, [a, b]);
    b.go('home');
    const read = b.act('read_letter', { letterId });
    expect(read.letter.invite).toMatchObject({ grantId, active: true });
    expect(grantRow(t, grantId).learned_at).not.toBeNull();
    expect(b.view().invites.received.map((i) => i.grantId)).toEqual([grantId]);
    b.go(homeOf(a));
    expect(loc(b)).toBe(homeOf(a));
    // 邀请本身没有让任何人自动移动：读信时 b 还在自己家
  });

  it('重读不改变得知时间', () => {
    const { t, a, b, letterId, grantId } = letterWithInvite();
    stay(t, 60_000, [a, b]);
    b.go('home');
    b.act('read_letter', { letterId });
    const learned = grantRow(t, grantId).learned_at;
    stay(t, 100_000, [a, b]);
    b.act('read_letter', { letterId });
    expect(grantRow(t, grantId).learned_at).toBe(learned);
  });

  it('邀请在读信前已经过期：读了也进不去，信里标注已失效', () => {
    const { t, a, b, letterId } = letterWithInvite();
    stay(t, DAY + 61_000, [a, b]);
    b.go('home');
    const read = b.act('read_letter', { letterId });
    expect(read.letter.invite.active).toBe(false);
    expect(b.view().invites.received).toEqual([]);
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('读信前被房主撤销：读了也进不去，信里标注已失效', () => {
    const { t, a, b, letterId, grantId } = letterWithInvite();
    stay(t, 60_000, [a, b]);
    a.act('revoke_invite', { grantId });
    b.go('home');
    expect(b.act('read_letter', { letterId }).letter.invite.active).toBe(false);
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('删掉没读过的邀请信，邀请就永远不会生效', () => {
    const { t, a, b, letterId } = letterWithInvite();
    stay(t, 60_000, [a, b]);
    b.act('delete_letter', { letterId });
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
    expect(b.view().invites.received).toEqual([]);
  });

  it('只有房主才能随信附邀请，授权的是房主自己的家；reentry 选项被保存', () => {
    const { t, grantId } = letterWithInvite({ reentry: false });
    const g = grantRow(t, grantId);
    expect(g.home_id).toBe(`home:${g.owner_id}`);
    expect(g.reentry).toBe(0);
  });
});
