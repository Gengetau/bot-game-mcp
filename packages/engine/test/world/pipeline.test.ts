/**
 * 栖灯镇：命令管线与调度。
 * 依据设计文档第 8、10、11、15 节：到期任务先于新动作；回执优先；候选状态整体回滚；提交后才唤醒；
 * 调度的去重键、优先级、重试、搁置、取消与改期；很久没 tick 之后按各自到期时间结算。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { claimControl } from '../../src/world/identity.js';
import { enterWorld } from '../../src/world/index.js';
import { JOB_PRIORITY, type CommandRequest, type JobRow, type WorldService } from '../../src/world/service.js';
import { Actor, makeTown, type Town } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 手工构造一条命令（绕开 Actor.act，方便伪造各个字段）。 */
function raw(a: Actor, over: Partial<CommandRequest> & { action?: Record<string, unknown> } = {}): CommandRequest {
  const v = a.view();
  return {
    requestId: 'req-pipeline-0001',
    actionWindow: v.actionWindow,
    expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: v.context.activityId },
    action: { type: 'speak', text: '你好' },
    ...over,
  } as CommandRequest;
}

function errorOf(fn: () => unknown): WorldError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorldError) return e;
    throw e;
  }
  throw new Error('本应抛出 WorldError，却成功了');
}

const count = (w: WorldService, table: string, where = '1=1', ...p: (string | number)[]) => w.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, ...p);

/** 两位居民在广场，已读过一次视图。 */
function pair(): { t: Town; a: Actor; b: Actor } {
  const t = makeTown();
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  return { t, a, b };
}

describe('命令管线：到期任务先于新动作', () => {
  it('移动到点的任务在没有 tick 的情况下，由下一条命令先结算再生效', () => {
    const { t, a } = pair();
    const out = a.act('move', { to: 'tea_house' });
    // 只推进时钟，不调用 tick：到达任务已到期但还没结算
    t.clock.advance(out.move.arriveAt - t.clock.t);
    expect(a.row().move).not.toBeNull();
    // 在途时不能说话；如果到期任务没有先结算，这条会失败
    const spoke = a.act('speak', { text: '到茶馆了' });
    expect(spoke.ok).toBe(true);
    expect(a.row().location_id).toBe('tea_house');
    expect(a.row().move).toBeNull();
  });

  it('报价到期先于接受：过期的报价不能再接受', () => {
    const { t, a, b } = pair();
    const offer = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    // 保持心跳，只让报价过期（十分钟），不 tick
    for (let i = 0; i < 31; i++) {
      t.clock.advance(20_000);
      a.heartbeat();
      b.heartbeat();
    }
    expect(t.clock.t).toBeGreaterThan(offer.offer.expiresAt);
    const err = b.fail('accept_offer', { offerId: offer.offer.id });
    expect(err.code).toBe('precondition_failed');
    expect(b.coins()).toBe(20);
    expect(a.coins()).toBe(20);
  });
});

describe('命令管线：回执与幂等', () => {
  it('同请求号同内容重放：返回原结果并带 replayed，只做一次', () => {
    const { t, a, b } = pair();
    const first = a.act('speak', { text: '只说一次' }, { requestId: 'req-once-0001' });
    expect(first.replayed).toBeUndefined();
    const again = a.act('speak', { text: '只说一次' }, { requestId: 'req-once-0001' });
    expect(again.replayed).toBe(true);
    expect(again.cursor).toBe(first.cursor);
    expect(again.requestId).toBe('req-once-0001');
    expect(b.events().events.filter((e) => e.type === 'chat').length).toBe(0); // 从当前位置读不到历史
    expect(count(t.w, 'chat_messages')).toBe(1);
    expect(count(t.w, 'request_receipts', 'resident_id = ?', a.residentId)).toBe(1);
    expect(t.w.metrics.replays).toBe(1);
  });

  it('重放不受后续状态影响：控制权已变、窗口已过期、已经不在场，回执仍优先', () => {
    const { t, a } = pair();
    const req = raw(a, { requestId: 'req-replay-0001', action: { type: 'speak', text: '回执优先' } });
    const first = t.w.command(a.auth, req);
    // 1. 控制权被第二个标签页接管：新请求 control_lost，旧请求重放仍返回原结果
    const other = { principalId: a.principalId, clientId: 'web:second-tab' };
    enterWorld(t.w, other, { clientKind: 'web' });
    claimControl(t.w, other);
    expect(errorOf(() => t.w.command(a.auth, raw(a, { requestId: 'req-replay-0002' }))).code).toBe('control_lost');
    const r1 = t.w.command(a.auth, req);
    expect(r1.replayed).toBe(true);
    expect(r1.cursor).toBe(first.cursor);
    // 2. 窗口过期、期望值全错，也照样返回回执
    const old = t.w.issueActionWindow(a.residentId, t.clock.t - 3 * DAY);
    const r2 = t.w.command(a.auth, { ...req, actionWindow: old, expected: { contextVersion: 99, controlEpoch: 99 } });
    expect(r2.replayed).toBe(true);
    // 3. 离开小镇之后
    a.leave();
    const r3 = t.w.command(a.auth, req);
    expect(r3.replayed).toBe(true);
    expect(count(t.w, 'chat_messages')).toBe(1);
  });

  it('同请求号换了内容：request_conflict，且不执行', () => {
    const { t, a } = pair();
    a.act('speak', { text: '甲' }, { requestId: 'req-conflict-1' });
    const err = a.fail('speak', { text: '乙' }, { requestId: 'req-conflict-1' });
    expect(err.code).toBe('request_conflict');
    expect(count(t.w, 'chat_messages')).toBe(1);
    // 字段顺序不同但内容相同 = 同一个请求
    a.act('update_profile', { bio: '喜欢茶', showMood: true }, { requestId: 'req-conflict-2' });
    const same = a.act('update_profile', { showMood: true, bio: '喜欢茶' }, { requestId: 'req-conflict-2' });
    expect(same.replayed).toBe(true);
  });

  it('请求号相同但属于不同居民：互不干扰', () => {
    const { a, b } = pair();
    const x = a.act('speak', { text: '甲' }, { requestId: 'req-shared-0001' });
    const y = b.act('speak', { text: '甲' }, { requestId: 'req-shared-0001' });
    expect(x.replayed).toBeUndefined();
    expect(y.replayed).toBeUndefined();
  });

  it('requestId 长度和字符边界', () => {
    const { a } = pair();
    const ok = (id: string) => a.act('update_profile', { bio: id.slice(0, 5) }, { requestId: id });
    expect(a.fail('speak', { text: 'x' }, { requestId: 'a'.repeat(7) }).code).toBe('bad_request');
    expect(ok('a'.repeat(8)).ok).toBe(true);
    expect(ok('b'.repeat(80)).ok).toBe(true);
    expect(a.fail('speak', { text: 'x' }, { requestId: 'c'.repeat(81) }).code).toBe('bad_request');
    expect(a.fail('speak', { text: 'x' }, { requestId: 'has space 001' }).code).toBe('bad_request');
    expect(a.fail('speak', { text: 'x' }, { requestId: '中文请求号请求号请求号' }).code).toBe('bad_request');
    expect(a.fail('speak', { text: 'x' }, { requestId: '' }).code).toBe('bad_request');
  });

  it('未知动作类型和缺少 action：bad_request', () => {
    const { t, a } = pair();
    expect(errorOf(() => t.w.command(a.auth, raw(a, { action: { type: 'fly_to_moon' } }))).code).toBe('bad_request');
    expect(errorOf(() => t.w.command(a.auth, raw(a, { action: undefined as never }))).code).toBe('bad_request');
    expect(errorOf(() => t.w.command(a.auth, raw(a, { action: { type: 42 } as never }))).code).toBe('bad_request');
    expect(count(t.w, 'request_receipts')).toBe(0);
  });

  it('没有居民身份：unauthenticated', () => {
    const { t, a } = pair();
    const err = errorOf(() => t.w.command({ principalId: 'p_nobody', clientId: 'web:x-1234' }, raw(a)));
    expect(err.code).toBe('unauthenticated');
  });

  it('回执保留 7 天后在换日清理时裁剪', () => {
    const { t, a } = pair();
    const first = a.act('speak', { text: '留个回执' }, { requestId: 'req-prune-0001' });
    expect(first.ok).toBe(true);
    const receipts = () => count(t.w, 'request_receipts', 'request_id = ?', 'req-prune-0001');
    expect(receipts()).toBe(1);
    // 6 天后还在（换日任务每次只追一次，清理时回执还没到期）
    t.advance(6 * DAY);
    expect(receipts()).toBe(1);
    // 超过 7 天再过一次换日：回执被裁剪
    t.advance(2 * DAY);
    expect(receipts()).toBe(0);
  });
});

describe('命令管线：动作窗口', () => {
  it('伪造、缺失、别人的窗口：request_expired', () => {
    const { t, a, b } = pair();
    const fakes = ['aw.abc.def', 'garbage', undefined, b.view().actionWindow];
    for (const [i, w] of fakes.entries()) {
      expect(errorOf(() => t.w.command(a.auth, raw(a, { requestId: `req-window-000${i}`, actionWindow: w as string }))).code).toBe('request_expired');
    }
    expect(count(t.w, 'request_receipts')).toBe(0);
  });

  it('超过 24 小时的窗口过期，刚好 24 小时仍有效；来自未来超过一分钟的无效', () => {
    const { t, a } = pair();
    const at = (ms: number) => t.w.issueActionWindow(a.residentId, t.clock.t + ms);
    expect(errorOf(() => t.w.command(a.auth, raw(a, { requestId: 'req-window-old1', actionWindow: at(-DAY - 1) }))).code).toBe('request_expired');
    expect(t.w.command(a.auth, raw(a, { requestId: 'req-window-old2', actionWindow: at(-DAY) })).ok).toBe(true);
    expect(errorOf(() => t.w.command(a.auth, raw(a, { requestId: 'req-window-fut1', actionWindow: at(61_000) }))).code).toBe('request_expired');
    expect(t.w.command(a.auth, raw(a, { requestId: 'req-window-fut2', actionWindow: at(60_000) })).ok).toBe(true);
  });
});

describe('命令管线：在场、控制权、上下文', () => {
  it('不在场：precondition_failed / not_present', () => {
    const { a } = pair();
    const v = a.view();
    a.leave();
    const err = errorOf(() =>
      a.t.w.command(a.auth, { requestId: 'req-absent-0001', actionWindow: v.actionWindow, expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null }, action: { type: 'speak', text: 'x' } }),
    );
    expect(err.code).toBe('precondition_failed');
    expect(err.reason).toBe('not_present');
  });

  it('控制权：别的客户端、旧的控制代数、没有控制权的客户端都是 control_lost', () => {
    const { t, a } = pair();
    const v = a.view();
    // 同一居民的第二个标签页：进入后控制权仍在第一个
    const tab2 = { principalId: a.principalId, clientId: 'web:second-tab' };
    enterWorld(t.w, tab2, { clientKind: 'web' });
    const asTab2 = errorOf(() => t.w.command(tab2, raw(a)));
    expect(asTab2.code).toBe('control_lost');
    // 旧的控制代数
    const stale = errorOf(() => t.w.command(a.auth, raw(a, { requestId: 'req-control-0002', expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch - 1, activityId: null } })));
    expect(stale.code).toBe('control_lost');
    // 没有 expected
    const none = errorOf(() => t.w.command(a.auth, raw(a, { requestId: 'req-control-0003', expected: undefined })));
    expect(none.code).toBe('control_lost');
    // 控制权租约过期（controller_until 到期）
    t.clock.advance(61_000);
    const expired = errorOf(() => t.w.command(a.auth, raw(a, { requestId: 'req-control-0004' })));
    expect(['control_lost', 'precondition_failed']).toContain(expired.code);
    expect(count(t.w, 'request_receipts')).toBe(0);
  });

  it('接管后旧客户端迟到的动作被拒绝，新客户端成功', () => {
    const { t, a } = pair();
    const tab2 = { principalId: a.principalId, clientId: 'web:second-tab' };
    enterWorld(t.w, tab2, { clientKind: 'web' });
    const before = a.view().control.epoch;
    claimControl(t.w, tab2);
    const v = a.view();
    expect(v.control.epoch).toBe(before + 1);
    expect(errorOf(() => t.w.command(a.auth, raw(a, { expected: { contextVersion: v.context.version, controlEpoch: before, activityId: null } }))).code).toBe('control_lost');
    const ok = t.w.command(tab2, { ...raw(a), expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null } });
    expect(ok.ok).toBe(true);
  });

  it('context_stale：contextVersion 不符', () => {
    const { a } = pair();
    const v = a.view();
    const err = a.fail('speak', { text: 'x' }, { expected: { contextVersion: v.context.version + 1, controlEpoch: v.control.epoch, activityId: null } });
    expect(err.code).toBe('context_stale');
    expect(err.data).toMatchObject({ contextVersion: v.context.version, activityId: null });
    const missing = a.fail('speak', { text: 'x' }, { expected: { controlEpoch: v.control.epoch, activityId: null } });
    expect(missing.code).toBe('context_stale');
  });

  it('context_stale：activityId 不符（以为在一局里，其实不在）', () => {
    const { a } = pair();
    const v = a.view();
    const err = a.fail('speak', { text: 'x' }, { expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: 'act_nonexistent' } });
    expect(err.code).toBe('context_stale');
  });

  it('局内动作用在不在局里的居民身上：context_stale；局外动作用在局里：in_activity', () => {
    const { t, a, b } = pair();
    a.go('arcade');
    b.go('arcade');
    const err = a.fail('game_act', { phaseId: 'x', input: {} });
    expect(err.code).toBe('context_stale');
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    const err2 = a.fail('speak', { text: '局里说话' });
    expect(err2.code).toBe('precondition_failed');
    expect(err2.reason).toBe('in_activity');
    expect(t.w.resident(a.residentId)!.activity_id).toBe(p.activity.id);
  });
});

describe('命令管线：整体回滚', () => {
  /** 注册一个先写一堆东西再抛错的动作。 */
  function installBoom(t: Town, mode: { fail: boolean }) {
    t.w.handlers.set('boom_test', ({ w, r, now }) => {
      r.name = '回滚前的新名字';
      w.saveResident(r);
      w.emitTo([r.resident_id], 'notice', { text: '不该出现' });
      w.emitPublic('place', { resident: { id: r.resident_id } });
      w.schedule('prune', `boom:${r.resident_id}`, now + 1000, {});
      w.fact('boom_fact', [{ id: r.resident_id, role: 'self' }], { x: 1 });
      w.db.run('INSERT INTO business_keys(key, created_at) VALUES (?,?)', `boom:${r.resident_id}`, now);
      if (mode.fail) throw new Error('处理器中途出错');
      return { status: 'completed' };
    });
  }

  it('handler 抛错：状态、事件、任务、事实、回执都不留', () => {
    const { t, a } = pair();
    const mode = { fail: true };
    installBoom(t, mode);
    const name = a.row().name;
    const cursor = t.w.cursorOf(a.residentId);
    const pubCursor = t.w.publicCursor();
    const jobs = count(t.w, 'scheduled_jobs');
    const facts = count(t.w, 'world_events');
    const bumps: string[] = [];
    t.w.onResident(a.residentId, () => bumps.push('r'));
    t.w.onPublic(() => bumps.push('p'));
    expect(() => a.act('boom_test', {}, { requestId: 'req-boom-0001' })).toThrow('处理器中途出错');
    expect(a.row().name).toBe(name);
    expect(t.w.cursorOf(a.residentId)).toBe(cursor);
    expect(t.w.publicCursor()).toBe(pubCursor);
    expect(count(t.w, 'scheduled_jobs')).toBe(jobs);
    expect(count(t.w, 'world_events')).toBe(facts);
    expect(count(t.w, 'business_keys', 'key LIKE ?', 'boom:%')).toBe(0);
    expect(count(t.w, 'request_receipts', 'request_id = ?', 'req-boom-0001')).toBe(0);
    expect(bumps).toEqual([]); // 回滚的事务不唤醒任何人
    // 同一个请求号可以重试，这次成功，且只做一次
    mode.fail = false;
    const ok = a.act('boom_test', {}, { requestId: 'req-boom-0001' });
    expect(ok.ok).toBe(true);
    expect(ok.replayed).toBeUndefined();
    expect(a.row().name).toBe('回滚前的新名字');
    expect(bumps.sort()).toEqual(['p', 'r']);
  });

  it('WorldError 的回滚同样干净（规则拒绝）', () => {
    const { t, a } = pair();
    t.w.handlers.set('reject_test', ({ w, r }) => {
      w.emitTo([r.resident_id], 'notice', { text: '不该出现' });
      throw new WorldError('precondition_failed', '不行', 'nope');
    });
    const cursor = t.w.cursorOf(a.residentId);
    const err = a.fail('reject_test', {}, { requestId: 'req-reject-0001' });
    expect(err.reason).toBe('nope');
    expect(t.w.cursorOf(a.residentId)).toBe(cursor);
    expect(count(t.w, 'request_receipts', 'request_id = ?', 'req-reject-0001')).toBe(0);
  });

  it('被拒绝的请求不占用请求号：之后同号换内容可以成功', () => {
    const { t, a } = pair();
    expect(a.fail('speak', { text: '   ' }, { requestId: 'req-retry-0001' }).code).toBe('bad_request');
    expect(a.act('speak', { text: '这次有内容' }, { requestId: 'req-retry-0001' }).ok).toBe(true);
    expect(count(t.w, 'chat_messages')).toBe(1);
  });
});

describe('提交后才唤醒', () => {
  it('onResident / onPublic 回调触发时事件已经落库且不在事务里', () => {
    const { t, a, b } = pair();
    const seen: { inTx: boolean; events: number; pub: number }[] = [];
    const cur = b.view().cursor;
    t.w.onResident(b.residentId, () => seen.push({ inTx: t.w.db.inTx, events: t.w.readResidentEvents(b.residentId, cur).events.length, pub: 0 }));
    const pubCur = t.w.publicCursor();
    t.w.onPublic(() => seen.push({ inTx: t.w.db.inTx, events: 0, pub: t.w.readPublicEvents(pubCur).events.length }));
    a.act('speak', { text: '给你听' });
    a.act('move', { to: 'tea_house' });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => !s.inTx)).toBe(true);
    expect(seen.filter((s) => s.events > 0).length).toBeGreaterThanOrEqual(1);
    expect(seen.filter((s) => s.pub > 0).length).toBeGreaterThanOrEqual(1);
  });

  it('waitResident 在事务提交之后才返回 event；回滚的事务不唤醒', async () => {
    const { t, a, b } = pair();
    const cur = b.view().cursor;
    t.w.handlers.set('noisy_fail', ({ w, r }) => {
      w.emitTo([b.residentId], 'notice', { text: '不该看到' });
      void r;
      throw new Error('失败');
    });
    const pending = t.w.waitResident(b.residentId, cur, undefined, 80);
    expect(() => a.act('noisy_fail', {})).toThrow('失败');
    expect(await pending).toBe('timeout');
    // 成功的动作才唤醒，且醒来时能读到事件
    const waiting = t.w.waitResident(b.residentId, cur, undefined, 2000);
    a.act('speak', { text: '醒醒' });
    expect(await waiting).toBe('event');
    expect(t.w.readResidentEvents(b.residentId, cur).events.map((e) => e.type)).toContain('chat');
  });
});

describe('订阅者出错', () => {
  it('订阅回调抛错不影响已提交的命令结果，也不影响其他订阅者', () => {
    const { t, a, b } = pair();
    const got: string[] = [];
    t.w.onResident(b.residentId, () => {
      throw new Error('订阅者坏了');
    });
    t.w.onResident(b.residentId, () => got.push('ok'));
    const out = a.act('speak', { text: '给坏订阅者听' });
    expect(out.ok).toBe(true);
    expect(got).toEqual(['ok']);
    expect(count(t.w, 'request_receipts')).toBe(1);
    expect(t.logs.some((l) => l.includes('订阅者出错'))).toBe(true);
  });
});

describe('调度器', () => {
  /** 把几个任务类型的处理器换成记录器。 */
  function recorder(t: Town, kinds: string[], fail?: (tag: string, n: number) => boolean) {
    const log: { kind: string; tag: string; dueAt: number; now: number }[] = [];
    const calls = new Map<string, number>();
    for (const kind of kinds) {
      t.w.jobHandlers.set(kind, (payload, job: JobRow, now) => {
        const n = (calls.get(job.dedupe_key) ?? 0) + 1;
        calls.set(job.dedupe_key, n);
        if (fail?.(String(payload.tag), n)) throw new Error(`故意失败 ${payload.tag}#${n}`);
        log.push({ kind, tag: String(payload.tag), dueAt: job.due_at, now });
      });
    }
    return { log, calls };
  }
  const job = (w: WorldService, key: string) => w.db.get('SELECT * FROM scheduled_jobs WHERE dedupe_key = ?', key)!;

  it('去重键：同一个键只存在一条，重复安排不产生第二条也不改到期时间', () => {
    const { t } = pair();
    const { log } = recorder(t, ['letter_deliver']);
    const now = t.clock.t;
    t.w.schedule('letter_deliver', 'dup:key', now + 1000, { tag: 'first' });
    t.w.schedule('letter_deliver', 'dup:key', now + 5000, { tag: 'second' });
    expect(count(t.w, 'scheduled_jobs', 'dedupe_key = ?', 'dup:key')).toBe(1);
    expect(job(t.w, 'dup:key').due_at).toBe(now + 1000);
    t.advance(10_000);
    expect(log.map((l) => l.tag)).toEqual(['first']);
    // 已完成的键再安排，也不会再跑一次
    t.w.schedule('letter_deliver', 'dup:key', t.clock.t + 1000, { tag: 'third' });
    t.advance(10_000);
    expect(log.map((l) => l.tag)).toEqual(['first']);
  });

  it('优先级：同一时刻到达、失效先于别的；更早到期的先于优先级更高但更晚的', () => {
    const { t } = pair();
    const kinds = ['daily_rollover', 'letter_deliver', 'grant_expire', 'move_arrive', 'prune'];
    const { log } = recorder(t, kinds);
    const at = t.clock.t + 30_000;
    // 故意按反优先级顺序安排
    for (const kind of ['daily_rollover', 'prune', 'letter_deliver', 'grant_expire', 'move_arrive']) t.w.schedule(kind, `prio:${kind}`, at, { tag: kind });
    t.w.schedule('daily_rollover', 'prio:early', at - 10_000, { tag: 'early_low_priority' });
    t.advance(60_000);
    expect(log.map((l) => l.tag)).toEqual(['early_low_priority', 'move_arrive', 'grant_expire', 'letter_deliver', 'daily_rollover', 'prune']);
    expect(JOB_PRIORITY.move_arrive).toBeLessThan(JOB_PRIORITY.letter_deliver!);
    expect(JOB_PRIORITY.grant_expire).toBeLessThan(JOB_PRIORITY.interaction_finish!);
    expect(JOB_PRIORITY.offer_expire).toBeLessThan(JOB_PRIORITY.letter_deliver!);
  });

  it('同一时刻同优先级按编号（先安排的先跑）', () => {
    const { t } = pair();
    const { log } = recorder(t, ['letter_deliver']);
    const at = t.clock.t + 1000;
    for (const tag of ['a', 'b', 'c']) t.w.schedule('letter_deliver', `fifo:${tag}`, at, { tag });
    t.advance(2000);
    expect(log.map((l) => l.tag)).toEqual(['a', 'b', 'c']);
  });

  it('失败保留原键重试，成功后只算一次；失败的尝试不留副作用', () => {
    const { t } = pair();
    const { log, calls } = recorder(t, ['letter_deliver'], (_tag, n) => n < 3);
    t.w.jobHandlers.set('letter_deliver', ((inner) => (payload: Record<string, any>, j: JobRow, now: number) => {
      t.w.db.run('INSERT OR IGNORE INTO business_keys(key, created_at) VALUES (?,?)', `side:${j.attempts}`, now);
      inner(payload, j, now);
    })(t.w.jobHandlers.get('letter_deliver')!));
    t.w.schedule('letter_deliver', 'retry:key', t.clock.t + 1000, { tag: 'x' });
    t.advance(2000);
    expect(calls.get('retry:key')).toBe(1);
    expect(job(t.w, 'retry:key')).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job(t.w, 'retry:key').last_error).toContain('故意失败');
    expect(count(t.w, 'business_keys', 'key LIKE ?', 'side:%')).toBe(0); // 第一次失败的写入已回滚
    t.w.tick();
    expect(job(t.w, 'retry:key')).toMatchObject({ status: 'pending', attempts: 2 });
    t.w.tick();
    expect(job(t.w, 'retry:key').status).toBe('done');
    expect(log.map((l) => l.tag)).toEqual(['x']);
    t.w.tick();
    expect(calls.get('retry:key')).toBe(3);
    expect(t.w.metrics.jobRetries).toBe(2);
    expect(count(t.w, 'scheduled_jobs', 'dedupe_key = ?', 'retry:key')).toBe(1);
  });

  it('一个任务失败不阻塞同一轮里后面的任务', () => {
    const { t } = pair();
    const { log } = recorder(t, ['letter_deliver'], (tag) => tag === 'bad');
    const at = t.clock.t + 1000;
    t.w.schedule('letter_deliver', 'k:bad', at, { tag: 'bad' });
    t.w.schedule('letter_deliver', 'k:good', at + 1, { tag: 'good' });
    t.advance(5000);
    expect(log.map((l) => l.tag)).toEqual(['good']);
    expect(job(t.w, 'k:bad').status).toBe('pending');
  });

  it('失败 5 次后搁置：记日志、不再重试、计入指标', () => {
    const { t } = pair();
    const { calls } = recorder(t, ['letter_deliver'], () => true);
    t.w.schedule('letter_deliver', 'shelve:key', t.clock.t + 1000, { tag: 'x' });
    t.clock.advance(2000);
    for (let i = 0; i < 8; i++) t.w.tick();
    expect(calls.get('shelve:key')).toBe(5);
    expect(job(t.w, 'shelve:key')).toMatchObject({ status: 'failed', attempts: 5 });
    expect(t.logs.some((l) => l.includes('已搁置'))).toBe(true);
    expect(t.w.metrics.jobFailures).toBe(1);
    expect(t.w.metrics.jobRetries).toBe(5);
    // 搁置的任务不再算作「到期待办」
    expect(t.w.pendingJobs()).toBe(0);
  });

  it('没有处理器的任务类型按失败处理，同样 5 次后搁置', () => {
    const { t } = pair();
    t.w.schedule('nonexistent_kind', 'orphan:key', t.clock.t + 10, {});
    t.clock.advance(100);
    for (let i = 0; i < 6; i++) t.w.tick();
    expect(job(t.w, 'orphan:key')).toMatchObject({ status: 'failed', attempts: 5 });
    expect(String(job(t.w, 'orphan:key').last_error)).toContain('没有处理器');
  });

  it('取消：不再执行；已完成的任务取消无效；改期：换到期时间并清零重试', () => {
    const { t } = pair();
    const { log } = recorder(t, ['letter_deliver']);
    const now = t.clock.t;
    t.w.schedule('letter_deliver', 'cancel:me', now + 1000, { tag: 'cancelled' });
    t.w.schedule('letter_deliver', 'move:me', now + 1000, { tag: 'moved' });
    t.w.schedule('letter_deliver', 'done:me', now + 500, { tag: 'done' });
    t.w.cancelJob('cancel:me');
    t.w.reschedule('letter_deliver', 'move:me', now + 90_000, { tag: 'moved2' });
    t.advance(2000);
    expect(log.map((l) => l.tag)).toEqual(['done']);
    t.w.cancelJob('done:me');
    expect(job(t.w, 'done:me').status).toBe('done');
    expect(job(t.w, 'cancel:me').status).toBe('cancelled');
    t.advance(100_000);
    expect(log.map((l) => l.tag)).toEqual(['done', 'moved2']);
    expect(count(t.w, 'scheduled_jobs', 'dedupe_key = ?', 'move:me')).toBe(1);
  });

  it('改期会清零失败次数', () => {
    const { t } = pair();
    recorder(t, ['letter_deliver'], () => true);
    t.w.schedule('letter_deliver', 'rs:key', t.clock.t + 10, { tag: 'x' });
    t.clock.advance(100);
    t.w.tick();
    t.w.tick();
    expect(job(t.w, 'rs:key').attempts).toBe(2);
    t.w.reschedule('letter_deliver', 'rs:key', t.clock.t + 10_000, { tag: 'x' });
    expect(job(t.w, 'rs:key')).toMatchObject({ attempts: 0, status: 'pending', last_error: null });
  });

  it('tick 很久没跑（一次推进 6 小时）：按各自到期时间结算、顺序正确、每条一次', () => {
    const { t } = pair();
    const { log, calls } = recorder(t, ['move_arrive', 'letter_deliver', 'grant_expire', 'prune']);
    const t0 = t.clock.t;
    const plan: [string, string, number][] = [
      ['prune', 'p3', 5 * HOUR],
      ['letter_deliver', 'l1', HOUR],
      ['move_arrive', 'm0', 30 * MIN],
      ['grant_expire', 'g1', HOUR],
      ['move_arrive', 'm2', 2 * HOUR],
      ['letter_deliver', 'l7', 7 * HOUR], // 还没到期
    ];
    for (const [kind, tag, due] of plan) t.w.schedule(kind, `six:${tag}`, t0 + due, { tag });
    t.advance(6 * HOUR);
    // 同一时刻（1 小时）：grant_expire(2) 先于 letter_deliver(4)
    expect(log.map((l) => l.tag)).toEqual(['m0', 'g1', 'l1', 'm2', 'p3']);
    for (const l of log) {
      expect(l.now).toBe(t0 + 6 * HOUR);
      expect(l.dueAt).toBeLessThanOrEqual(l.now);
    }
    expect(log.map((l) => l.dueAt)).toEqual([t0 + 30 * MIN, t0 + HOUR, t0 + HOUR, t0 + 2 * HOUR, t0 + 5 * HOUR]);
    t.w.tick();
    t.w.tick();
    for (const [, tag] of plan.filter((p) => p[1] !== 'l7')) expect(calls.get(`six:${tag}`)).toBe(1);
    expect(calls.has('six:l7')).toBe(false);
  });

  it('6 小时没跑 tick：信件按应送达时间记录，事件时间不是「现在」', () => {
    const { t, a, b } = pair();
    const sent = a.act('send_letter', { to: b.residentId, body: '很久以前的信' });
    const cursor = b.view().cursor;
    t.advance(6 * HOUR);
    const mail = b.events(cursor).events.find((e) => e.type === 'mail')!;
    expect(mail.at).toBe(sent.deliverAt);
    expect(t.w.db.get('SELECT delivered_at FROM letters WHERE letter_id = ?', sent.letterId)!.delivered_at).toBe(sent.deliverAt);
    expect(count(t.w, 'recipient_events', "resident_id = ? AND type = 'mail'", b.residentId)).toBe(1);
  });

  it('runDue 的 limit 与重入保护：事务里调用不处理任何任务', () => {
    const { t } = pair();
    const { log } = recorder(t, ['letter_deliver']);
    const now = t.clock.t;
    for (let i = 0; i < 5; i++) t.w.schedule('letter_deliver', `lim:${i}`, now + 10 + i, { tag: String(i) });
    t.clock.advance(1000);
    expect(t.w.runDue(2)).toBe(2);
    expect(log.length).toBe(2);
    t.w.db.tx(() => expect(t.w.runDue()).toBe(0));
    expect(t.w.runDue()).toBe(3);
    expect(log.length).toBe(5);
  });
});
