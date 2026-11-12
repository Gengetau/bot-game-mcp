/** 审计回归：邀请撤销通知（第 2 条）、信件翻页游标不暴露全局序号（第 21 条）。 */
import { describe, expect, it } from 'vitest';
import { listLetters } from '../../src/world/mail.js';
import { Actor, makeTown } from './helpers.js';

const STEP = 50_000;
const noticeTexts = (a: Actor, cursor: string) => a.events(cursor).events.filter((e) => e.type === 'notice').map((e) => String(e.data.text));

function stay(actors: Actor[], ms: number): void {
  for (const x of actors) x.heartbeat();
  actors[0]!.t.advanceAlive(ms, actors, STEP);
}

function setup() {
  const t = makeTown();
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  const c = t.join('小满');
  return { t, a, b, c, all: [a, b, c] };
}

describe('第 2 条：撤销邀请要告知不在屋里的受邀者', () => {
  it('已读信、人在别处：撤销后收到固定模板通知', () => {
    const { a, b, all } = setup();
    const out = a.act('send_letter', { to: b.residentId, body: '来坐坐', invite: {} });
    stay(all, out.deliverAt - a.t.clock.t + 1000);
    b.act('move', { to: 'home' });
    stay(all, 20_000);
    b.act('read_letter', { letterId: out.letterId });
    b.go('tea_house');
    const cursor = b.view().cursor;
    const grantId = listLetters(a.t.w, b.residentId, 'inbox', null, 5, a.t.clock.t).letters[0]!.invite!.grantId;
    a.act('revoke_invite', { grantId });
    expect(noticeTexts(b, cursor)).toEqual(['阿灯结束了这次邀请。']);
  });

  it('信还没读：撤销不通知，免得泄露邀请', () => {
    const { a, b, all } = setup();
    const out = a.act('send_letter', { to: b.residentId, body: '来坐坐', invite: {} });
    stay(all, out.deliverAt - a.t.clock.t + 1000);
    const cursor = b.view().cursor;
    const grantId = String(a.t.w.db.get('SELECT grant_id FROM home_access_grants WHERE owner_id = ?', a.residentId)!.grant_id);
    a.act('revoke_invite', { grantId });
    expect(noticeTexts(b, cursor)).toEqual([]);
  });

  it('屋里的受邀者仍然只收到一条通知', () => {
    const { a, b, all } = setup();
    a.act('invite', { to: b.residentId });
    b.act('move', { to: `home:${a.residentId}` });
    stay(all, 30_000);
    expect(b.row().location_id).toBe(`home:${a.residentId}`);
    const cursor = b.view().cursor;
    const grantId = String(a.t.w.db.get('SELECT grant_id FROM home_access_grants WHERE owner_id = ?', a.residentId)!.grant_id);
    a.act('revoke_invite', { grantId });
    expect(noticeTexts(b, cursor)).toEqual(['阿灯结束了这次邀请，你回到了门外的巷子里。']);
  });
});

describe('第 21 条：信件翻页游标是自己信箱内的序号', () => {
  it('别人互相寄信不改变 next 序列；翻页不重不漏', () => {
    const { t, a, b, c, all } = setup();
    for (let i = 1; i <= 5; i++) a.act('send_letter', { to: b.residentId, body: `信${i}` });
    // 夹进别人之间的信
    c.act('send_letter', { to: a.residentId, body: '无关' });
    c.act('send_letter', { to: a.residentId, body: '无关2' });
    stay(all, 60_000);
    const p1 = listLetters(t.w, b.residentId, 'inbox', null, 2, t.clock.t);
    expect(p1.next).toBe(4); // 自己的第 4 封之前
    for (let i = 0; i < 3; i++) c.act('send_letter', { to: a.residentId, body: `更多${i}` });
    const q1 = listLetters(t.w, b.residentId, 'inbox', null, 2, t.clock.t);
    expect(q1.next).toBe(4);
    const seen = p1.letters.map((l) => l.id);
    let before = p1.next;
    for (let g = 0; g < 10 && before !== null; g++) {
      const p = listLetters(t.w, b.residentId, 'inbox', before, 2, t.clock.t);
      seen.push(...p.letters.map((l) => l.id));
      before = p.next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('翻页中间删除一封信也不重不漏', () => {
    const { t, a, b, all } = setup();
    for (let i = 1; i <= 5; i++) a.act('send_letter', { to: b.residentId, body: `信${i}` });
    stay(all, 60_000);
    const p1 = listLetters(t.w, b.residentId, 'inbox', null, 2, t.clock.t);
    const p2a = listLetters(t.w, b.residentId, 'inbox', p1.next, 2, t.clock.t);
    b.act('delete_letter', { letterId: p2a.letters[0]!.id });
    const p2 = listLetters(t.w, b.residentId, 'inbox', p1.next, 2, t.clock.t);
    const rest = p2.next === null ? [] : listLetters(t.w, b.residentId, 'inbox', p2.next, 5, t.clock.t).letters;
    const all5 = [...p1.letters, ...p2.letters, ...rest].map((l) => l.id);
    expect(all5).toHaveLength(4);
    expect(new Set(all5).size).toBe(4);
  });

  it('翻页期间物理清理旧信：可能重复但不漏信，按 letterId 去重即可', () => {
    const { t, a, b, all } = setup();
    for (let i = 1; i <= 5; i++) a.act('send_letter', { to: b.residentId, body: `信${i}` });
    stay(all, 60_000);
    const full = listLetters(t.w, b.residentId, 'inbox', null, 50, t.clock.t).letters.map((l) => l.id);
    const p1 = listLetters(t.w, b.residentId, 'inbox', null, 2, t.clock.t);
    // 模拟 prune：最旧一封双方都删过，被物理删除
    const oldest = full[full.length - 1]!;
    b.act('delete_letter', { letterId: oldest });
    a.act('delete_letter', { letterId: oldest });
    t.w.db.run('DELETE FROM letters WHERE sender_deleted_at IS NOT NULL AND recipient_deleted_at IS NOT NULL');
    const seen = p1.letters.map((l) => l.id);
    let before = p1.next;
    for (let g = 0; g < 10 && before !== null; g++) {
      const p = listLetters(t.w, b.residentId, 'inbox', before, 2, t.clock.t);
      seen.push(...p.letters.map((l) => l.id));
      before = p.next;
    }
    // 去重后，剩下的四封一封不少
    expect(new Set(seen)).toEqual(new Set(full.slice(0, 4)));
  });
});
