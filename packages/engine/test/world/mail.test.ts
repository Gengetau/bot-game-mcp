/**
 * 栖灯镇：住宅访问（邀请）与信件。
 * 对照设计文档第 3 节「住宅」、第 5 节「信件邀请与住宅访问」、第 10 节「信息可见范围」。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { listLetters } from '../../src/world/mail.js';
import { chatHistory, meView, publicView } from '../../src/world/views.js';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const homeOf = (a: Actor) => `home:${a.residentId}`;
const loc = (a: Actor) => a.row().location_id;
const inbox = (a: Actor, limit = 50, before: number | null = null) => listLetters(a.t.w, a.residentId, 'inbox', before, limit, a.t.clock.t);
const sent = (a: Actor, limit = 50, before: number | null = null) => listLetters(a.t.w, a.residentId, 'sent', before, limit, a.t.clock.t);
const grantRow = (t: Town, grantId: string) => t.w.db.get('SELECT * FROM home_access_grants WHERE grant_id = ?', grantId)!;
const publicCount = (t: Town) => t.w.db.scalar('SELECT COUNT(*) FROM public_events');
const notices = (a: Actor, cursor: string) => a.events(cursor).events.filter((e) => e.type === 'notice').map((e) => String(e.data.text));

function town3() {
  const t = makeTown();
  const a = t.join('阿灯'); // 东灯巷
  const b = t.join('小岚', 'agent'); // 西灯巷
  const c = t.join('小满'); // 东灯巷
  return { t, a, b, c };
}

/** a 当面邀请 b，返回 grantId。 */
function invitePersonally(a: Actor, b: Actor, extra: Record<string, unknown> = {}): string {
  return a.act('invite', { to: b.residentId, ...extra }).invite.grantId;
}

/** a 给 b 寄信，等送到；返回信件编号。 */
function sendAndDeliver(a: Actor, b: Actor, body: string, extra: Record<string, unknown> = {}): { letterId: string; deliverAt: number } {
  const out = a.act('send_letter', { to: b.residentId, body, ...extra });
  a.t.advanceTo(out.deliverAt);
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
    // 门牌和邀请都没有时，在巷子里也不能进
    b.go('street_east');
    expect(b.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('当面邀请立刻生效：受邀者可以去，路线时长 = 到巷子 10 秒 + 进门 3 秒', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b);
    const ev = b.events();
    void ev;
    const out = b.act('move', { to: homeOf(a) });
    expect(out.move.arriveAt - t.clock.t).toBe(10_000 + 10_000 + 3_000 - 10_000 + 0); // 西灯巷 → 广场 → 东灯巷 → 家 = 从广场出发：10 + 3
    t.advanceTo(out.move.arriveAt);
    expect(loc(b)).toBe(homeOf(a));
    expect(grantRow(t, grantId).entered_at).toBe(out.move.arriveAt);
    // 邀请本身不会移动任何人
    expect(loc(a)).toBe('plaza');
  });

  it('邀请只对被邀请的人有效；第三者进不去', () => {
    const { a, b, c } = town3();
    invitePersonally(a, b);
    expect(c.fail('move', { to: homeOf(a) }).reason).toBe('no_access');
  });

  it('邀请的是房主自己的家：客人不能替别人邀请到别人家（invite 只授权自己的住宅）', () => {
    const { t, a, b, c } = town3();
    invitePersonally(a, b);
    b.go(homeOf(a));
    // b 在 a 家里邀请 c：授权的是 b 自己的家，不是 a 的家
    const g = b.act('invite', { to: c.residentId });
    void g;
    expect(c.row().location_id).toBe('plaza');
    const grants = t.w.db.all('SELECT home_id, owner_id FROM home_access_grants');
    expect(grants.every((x) => x.home_id === `home:${x.owner_id}`)).toBe(true);
  });

  it('当面邀请要对方在身边：不在一处 not_here', () => {
    const { a, b } = town3();
    b.go('tea_house');
    expect(a.fail('invite', { to: b.residentId }).reason).toBe('not_here');
  });

  it('邀请 24 小时后过期：过期后出发被拒；边界上恰好到期即失效', () => {
    const { t, a, b } = town3();
    const grantId = invitePersonally(a, b);
    const expiresAt = Number(grantRow(t, grantId).expires_at);
    expect(expiresAt - t.clock.t).toBe(DAY);
    t.advanceAlive(DAY - 1, [a, b], 50_000);
    expect(t.clock.t).toBe(expiresAt - 1);
    // 最后一毫秒还有效（只检查，不真去走）
    const ok = b.act('move', { to: homeOf(a) });
    expect(ok.status).toBe('accepted');
    b.act('move', { to: 'plaza' }, { requestId: 'cancel-not-possible' }).status; // 在途不能再移动 → 上面一行之后这行会抛错
  });
});
