/**
 * 审计回归：身份与服务地基（第 4、7、23、24、29 条）。
 */
import { describe, expect, it } from 'vitest';
import { enterWorld, exchangeTicket, agentPrincipal, issueTicket, sessionPrincipal } from '../../src/world/index.js';
import { makeTown, type Actor, type Town } from './helpers.js';

const NAMES = ['甲', '乙'];

describe('第 7 条：玩家输入不能把世界打成 degraded', () => {
  it('game_act 的数字里带 SQLITE_FULL：世界仍是 running，别人照常发言', () => {
    const t = makeTown();
    const a = t.join('甲');
    const b = t.join('乙');
    for (const x of [a, b]) x.enter();
    a.act('move', { to: 'arcade' });
    b.act('move', { to: 'arcade' });
    t.advanceAlive(40_000, [a, b]);
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    const who = [a, b].find((x) => x.view().game?.your_turn)!;
    const err = who.fail('game_act', { phaseId: who.lastView.game!.phase_id, input: { action: 'guess', number: 'SQLITE_FULL disk is full' } });
    expect(err.message).toContain('无法识别的数字');
    expect(t.w.status).toBe('running');
    const other = who === a ? b : a;
    expect(other.fail('speak', { text: '还好吗' }).code).not.toBe('recovering');
  });

  it('真正的数据库错误（带 code）仍然进入 degraded', () => {
    const t = makeTown();
    const a = t.join('甲');
    t.w.db.failpoint = (p) => {
      if (p === 'before_commit') throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    };
    a.fail('speak', { text: '写不进去' });
    expect(t.w.status).toBe('degraded');
  });
});

describe('第 23 条：昵称清洗为空时不泄露账号号码', () => {
  it('零宽字符昵称：display_name 不含号码；不给名字进不了，给了名字就用它', () => {
    const t = makeTown();
    const ticket = issueTicket(t.w, { provider: 'qq', subject: '123456789', name: '​​' });
    const s = exchangeTicket(t.w, ticket.ticket);
    const p = sessionPrincipal(t.w, s.token)!;
    expect(p.display_name).not.toContain('123456789');
    expect(() => enterWorld(t.w, { principalId: p.principal_id, clientId: 'web:c1' }, { clientKind: 'web', profile: {} })).toThrow(/起个名字/);
    const out = enterWorld(t.w, { principalId: p.principal_id, clientId: 'web:c1' }, { clientKind: 'web', profile: { name: '阿灯' } });
    expect(JSON.stringify(out.view)).not.toContain('123456789');
  });
});

describe('第 24 条：已离线的居民离开小镇也退出进行中的小游戏', () => {
  it('租约过期后 leaveWorld：quit_at 落下、activity_id 清空', () => {
    const t = makeTown();
    const [a, b] = NAMES.map((n) => t.join(n)) as [Actor, Actor];
    a.act('move', { to: 'arcade' });
    b.act('move', { to: 'arcade' });
    t.advanceAlive(40_000, [a, b]);
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    t.advanceAlive(61_000, [a]); // 乙不再心跳：租约过期（甲保持在线）
    expect(b.row().present_since).toBeNull();
    expect(b.row().activity_id).toBe(p.activity.id);
    b.leave();
    expect(b.row().activity_id).toBeNull();
    const q = t.w.db.get('SELECT quit_at FROM activity_participants WHERE activity_id = ? AND resident_id = ?', p.activity.id, b.residentId)!;
    expect(q.quit_at).not.toBeNull();
  });
});

describe('第 29 条：启动恢复失败后 tick 会重试', () => {
  it('newDay 钩子第一次抛错：保持 recovering，之后 tick 重试成功转 running', async () => {
    const t: Town = makeTown({ start: false });
    let boom = true;
    t.w.hooks.newDay.push(() => {
      if (boom) throw new Error('临时故障');
    });
    t.w.startSync();
    expect(t.w.status).toBe('recovering');
    boom = false;
    t.advance(6000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(t.w.status).toBe('running');
  });

  it('复核：恢复第一段提交后收尾失败，重试不再重跑 recover 钩子（各局截止时间只顺延一次）', async () => {
    const t: Town = makeTown({ start: false });
    const calls: number[] = [];
    t.w.hooks.recover.push((downtime) => calls.push(downtime));
    let boom = true;
    t.w.hooks.newDay.push(() => {
      if (boom) throw new Error('临时故障');
    });
    t.advance(30_000);
    t.w.startSync();
    expect(t.w.status).toBe('recovering');
    expect(calls).toHaveLength(1);
    const outage = t.w.lastOutageMs;
    expect(outage).toBeGreaterThanOrEqual(30_000);
    boom = false;
    t.advance(6000);
    await new Promise((r) => setImmediate(r));
    t.w.tick();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(t.w.status).toBe('running');
    expect(calls).toHaveLength(1); // 没有用更大的停机时长再跑一遍
    expect(t.w.lastOutageMs).toBe(outage);
  });
});
