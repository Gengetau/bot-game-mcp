/**
 * 栖灯镇：在场租约、控制权、移动、现场发言与听见。
 * 对照设计文档第 2、3 节与第 10 节「认证会话与控制」。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { claimControl, heartbeat, leaveWorld } from '../../src/world/identity.js';
import { renewNavigation, whereabouts } from '../../src/world/space.js';
import { chatHistory, publicView } from '../../src/world/views.js';
import { Actor, KEEPER, makeTown, tempDb, type Town } from './helpers.js';
import { checkSpaceInvariants } from './invariants.js';

function catchErr(fn: () => unknown): WorldError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorldError) return e;
    throw e;
  }
  throw new Error('本应失败，却成功了');
}

/** 同一居民的另一个客户端（另一个标签页 / 运行器）。请求号带上客户端编号，免得和主客户端撞号。 */
class Tab extends Actor {
  private n = 0;
  override act(type: string, fields: Record<string, unknown> = {}, opts: Parameters<Actor['act']>[2] = {}) {
    return super.act(type, fields, { ...opts, requestId: opts.requestId ?? `${this.clientId}-${++this.n}` });
  }
}
function otherClient(t: Town, a: Actor, clientId: string): Actor {
  return new Tab(t, a.principalId, a.residentId, clientId, a.name);
}

/** 重启并换随机种子（固定种子的编号序列在重启后会重复，真实环境用密码学随机不会）。 */
function restartFresh(t: Town) {
  (t.opts as { seed?: string }).seed = `after-restart-${t.clock.t}`;
  return t.restart();
}

const isPresent = (a: Actor) => a.row().present_since !== null;
const publicNames = (t: Town) => {
  const v = publicView(t.w);
  return [...v.places.flatMap((p) => p.residents), ...v.residential.residents].map((s) => s.name);
};
const chatTexts = (a: Actor) => chatHistory(a.t.w, a.residentId, null, 100).messages.map((m) => m.text);

describe('栖灯镇在场：租约到期才离线', () => {
  it('60 秒宽限内仍在场，到期那一刻离线，离线时刻 = 租约到期时刻', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const t0 = t.clock.t;
    t.advance(59_999);
    expect(isPresent(a)).toBe(true);
    expect(publicNames(t)).toContain('阿灯');
    t.advance(1);
    // b 没续租也一起到期了；关心的是 a
    expect(isPresent(a)).toBe(false);
    expect(a.row().last_seen_at).toBe(t0 + 60_000);
    expect(isPresent(b)).toBe(false);
    expect(publicNames(t)).not.toContain('阿灯');
  });

  it('一次性跳过很久才被检查：离线时刻仍记在租约到期那一刻，不是「现在」', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const t0 = t.clock.t;
    t.advance(3 * 3600_000);
    expect(isPresent(a)).toBe(false);
    expect(a.row().last_seen_at).toBe(t0 + 60_000);
    // 有效在场时间只算到租约到期
    expect(a.row().present_ms).toBe(60_000);
    expect(isPresent(b)).toBe(false);
    // 公开流里的离线事件，发生时间也是租约到期时刻
    const places = t.w.db.all("SELECT occurred_at, projection FROM public_events WHERE type = 'place' ORDER BY cursor DESC");
    const awayEvent = places.find((p) => JSON.parse(p.projection).resident.id === a.residentId && JSON.parse(p.projection).resident.at === null);
    expect(awayEvent?.occurred_at).toBe(t0 + 60_000);
  });

  it('心跳续租：每 20 秒一次就一直在场', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.advanceAlive(10 * 60_000, [a]);
    expect(isPresent(a)).toBe(true);
    const hb = a.heartbeat();
    expect(hb.nextHeartbeatMs).toBe(20_000);
    expect(hb.presenceEpoch).toBe(a.row().presence_epoch);
    t.advance(59_000);
    expect(isPresent(a)).toBe(true);
    t.advance(1_000);
    expect(isPresent(a)).toBe(false);
  });

  it('多个客户端：全部租约过期才离线，离线时刻是最晚的那条租约到期时刻', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const t0 = t.clock.t;
    t.advance(30_000);
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    // 第一个客户端到期了，第二个还活着 → 仍在场
    t.advance(30_000); // t0+60s：tab1 过期，tab2 剩 30 秒
    expect(isPresent(a)).toBe(true);
    t.advance(29_999);
    expect(isPresent(a)).toBe(true);
    t.advance(1);
    expect(isPresent(a)).toBe(false);
    expect(a.row().last_seen_at).toBe(t0 + 90_000);
  });

  it('一个客户端离线但另一个持续心跳：居民一直在场', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    for (let i = 0; i < 10; i++) {
      t.advance(20_000);
      tab2.heartbeat();
    }
    expect(isPresent(a)).toBe(true);
  });

  it('租约已过期但还没被调度器处理时，心跳不能复活它（presence_lost）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.clock.advance(61_000); // 故意不 tick
    const err = catchErr(() => a.heartbeat());
    expect(err.code).toBe('precondition_failed');
    expect(err.reason).toBe('presence_lost');
    t.w.tick();
    expect(isPresent(a)).toBe(false);
    // 重新进入才行，且是同一居民
    const back = a.enter();
    expect(back.enter.created).toBe(false);
    expect(back.enter.wasAway).toBe(true);
    expect(isPresent(a)).toBe(true);
  });

  it('只读视图、公开地图、公开事件流都不续租：只有心跳（或 enter）才维持在场', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    for (let i = 0; i < 4; i++) {
      t.clock.advance(19_000);
      a.view();
      publicView(t.w);
      t.w.readPublicEvents(t.w.publicCursor());
      a.events();
    }
    t.w.tick();
    expect(isPresent(a)).toBe(false);
  });

  it('心跳必须带对应的 presenceEpoch；没有居民 / 没有租约的心跳被拒绝', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const epoch = a.row().presence_epoch;
    expect(catchErr(() => heartbeat(t.w, a.auth, epoch + 1)).reason).toBe('presence_lost');
    expect(catchErr(() => heartbeat(t.w, a.auth, undefined)).reason).toBe('presence_lost');
    expect(catchErr(() => heartbeat(t.w, a.auth, String(epoch))).reason).toBe('presence_lost');
    // 没登记过租约的客户端不能用别人的 epoch 续租
    expect(catchErr(() => heartbeat(t.w, { principalId: a.principalId, clientId: 'web:never-entered' }, epoch)).reason).toBe('presence_lost');
    expect(catchErr(() => heartbeat(t.w, { principalId: 'p_unknown', clientId: 'web:whatever' }, 0)).code).toBe('unauthenticated');
  });
});

describe('栖灯镇在场：显式离开', () => {
  it('leave 立即离线，撤销全部租约和控制权，两个代数都递增', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    const before = a.row();
    a.leave();
    const r = a.row();
    expect(isPresent(a)).toBe(false);
    expect(r.presence_epoch).toBe(before.presence_epoch + 1);
    expect(r.control_epoch).toBe(before.control_epoch + 1);
    expect(r.controller_client).toBeNull();
    expect(t.w.db.scalar('SELECT COUNT(*) FROM presence_leases WHERE resident_id = ?', a.residentId)).toBe(0);
    expect(publicNames(t)).not.toContain('阿灯');
    // 租约到期任务也被取消，不会再来一次离线
    t.advance(5 * 60_000);
    expect(r.last_seen_at).toBe(t.clock.t - 5 * 60_000);
  });

  it('旧页面在途的心跳不能让居民重新在场：旧代数、新代数（没有租约）都被拒绝', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const oldEpoch = a.row().presence_epoch;
    a.leave();
    expect(catchErr(() => heartbeat(t.w, a.auth, oldEpoch)).reason).toBe('presence_lost');
    expect(catchErr(() => heartbeat(t.w, a.auth, a.row().presence_epoch)).reason).toBe('presence_lost');
    expect(isPresent(a)).toBe(false);
    // 另一个标签页的心跳也一样
    const tab2 = otherClient(t, a, 'web:tab-two');
    expect(catchErr(() => heartbeat(t.w, tab2.auth, oldEpoch)).reason).toBe('presence_lost');
    expect(isPresent(a)).toBe(false);
    // 重新 enter 之后，旧代数仍然无效，新代数有效
    a.enter();
    expect(catchErr(() => heartbeat(t.w, a.auth, oldEpoch)).reason).toBe('presence_lost');
    expect(() => a.heartbeat()).not.toThrow();
  });

  it('leave 之后动作被拒绝（not_present）；leave 通知订阅者关闭连接', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    let revoked = 0;
    const off = t.w.onRevoke(a.residentId, () => revoked++);
    const v = a.view();
    a.leave();
    expect(revoked).toBe(1);
    off();
    const err = a.fail('speak', { text: '还在吗' }, { actionWindow: v.actionWindow, expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null } });
    expect(err.reason).toBe('not_present');
  });

  it('leave 保留最后位置和个人状态；重新进入不重置需要、财产、位置', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.go(KEEPER);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 1 });
    const coins = a.coins();
    a.leave();
    t.advance(2 * 3600_000);
    const back = a.enter();
    expect(back.enter.wasAway).toBe(true);
    expect(a.row().location_id).toBe('tea_house');
    expect(a.coins()).toBe(coins);
  });

  it('已经离线的人再 leave：不出错，代数继续递增，不会重复广播离开', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.leave();
    const cursor = b.view().cursor;
    expect(() => leaveWorld(t.w, a.principalId)).not.toThrow();
    expect(b.events(cursor).events.filter((e) => e.type === 'presence')).toHaveLength(0);
  });
});

describe('栖灯镇控制权：同一时刻只有一个写入客户端', () => {
  it('第二个客户端只读：写入得到 control_lost；claim 之后 epoch 递增，旧客户端被拒', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    const e0 = a.view().control.epoch;
    tab2.enter();
    expect(a.view().control.mine).toBe(true);
    expect(tab2.view().control.mine).toBe(false);
    expect(tab2.view().control.epoch).toBe(e0); // 只读客户端进入不改变控制代数
    const denied = tab2.fail('speak', { text: '我是第二个页面' });
    expect(denied.code).toBe('control_lost');

    const claimed = tab2.claim();
    expect(claimed.control.epoch).toBe(e0 + 1);
    expect(tab2.view().control.mine).toBe(true);
    expect(a.view().control.mine).toBe(false);
    expect(() => tab2.act('speak', { text: '现在我能说话了' })).not.toThrow();
    // 旧客户端用新读到的视图发动作也被拒
    expect(a.fail('speak', { text: '旧页面' }).code).toBe('control_lost');
  });

  it('旧客户端迟到的动作（带着接管之前的 epoch）被拒绝，且没有任何副作用', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    const stale = a.view(); // 旧页面手里的视图
    tab2.claim();
    const beforeMsgs = t.w.db.scalar('SELECT COUNT(*) FROM chat_messages');
    const err = a.fail('speak', { text: '迟到的话' }, { expected: { contextVersion: stale.context.version, controlEpoch: stale.control.epoch, activityId: null }, actionWindow: stale.actionWindow });
    expect(err.code).toBe('control_lost');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages')).toBe(beforeMsgs);
    expect(b.view().here?.chat.map((c) => c.text)).not.toContain('迟到的话');
    // 新控制者带着旧 epoch 也不行
    const err2 = tab2.fail('speak', { text: '旧 epoch' }, { expected: { contextVersion: stale.context.version, controlEpoch: stale.control.epoch, activityId: null } });
    expect(err2.code).toBe('control_lost');
  });

  it('claim 来回切换：每次真正易手才递增；自己 claim 自己不递增', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    const e0 = a.row().control_epoch;
    expect(a.claim().control.epoch).toBe(e0); // 本来就握着
    expect(tab2.claim().control.epoch).toBe(e0 + 1);
    expect(tab2.claim().control.epoch).toBe(e0 + 1);
    expect(a.claim().control.epoch).toBe(e0 + 2);
  });

  it('没有有效租约的客户端不能 claim', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const ghost = otherClient(t, a, 'web:never-entered');
    expect(catchErr(() => ghost.claim()).reason).toBe('presence_lost');
    expect(catchErr(() => claimControl(t.w, { principalId: 'p_unknown', clientId: 'web:whatever' })).code).toBe('unauthenticated');
    // 租约过期的客户端也不行
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    t.advance(30_000);
    a.heartbeat();
    t.clock.advance(31_000); // tab2 的租约过期了（没 tick 也一样）；a 刚续过还没过期
    expect(catchErr(() => tab2.claim()).reason).toBe('presence_lost');
  });

  it('控制者的租约过期后，别的客户端 enter 自动获得控制权（epoch 递增）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    t.advance(30_000);
    tab2.enter(); // 此时 a 仍握着控制权，tab2 只读
    expect(tab2.view().control.mine).toBe(false);
    const e0 = a.row().control_epoch;
    // 每隔 20 秒只有 tab2 续租
    t.advance(20_000);
    tab2.heartbeat();
    t.advance(20_000);
    tab2.heartbeat(); // a 的租约已过期（t0+60s），居民靠 tab2 保持在场
    expect(isPresent(a)).toBe(true);
    // 控制者租约过期：a 的写入被拒，tab2 重新 enter 就接过控制权
    expect(a.fail('speak', { text: '我还在吗' }).code).toBe('control_lost');
    tab2.enter();
    expect(a.row().control_epoch).toBe(e0 + 1);
    expect(a.row().controller_client).toBe(tab2.clientId);
    expect(tab2.view().control.mine).toBe(true);
    expect(() => tab2.act('speak', { text: '我接手了' })).not.toThrow();
    // a 重新 enter 并不能抢回仍然有效的控制权
    a.enter();
    expect(a.row().controller_client).toBe(tab2.clientId);
    expect(a.fail('speak', { text: '抢回来' }).code).toBe('control_lost');
  });

  it('控制权只续在控制者的心跳上：只读客户端的心跳不延长控制权', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    // a 不再心跳，tab2 持续心跳
    t.advance(30_000);
    tab2.heartbeat();
    t.advance(31_000); // a 的控制权已到期
    expect(a.fail('speak', { text: 'x' }).code).toBe('control_lost');
    expect(tab2.fail('speak', { text: 'y' }).code).toBe('control_lost'); // tab2 也没拿到，需要 claim
    tab2.claim();
    expect(() => tab2.act('speak', { text: 'z' })).not.toThrow();
  });

  it('接管控制权的客户端自己掉线后，控制权跟着它的租约一起过期；居民回来时第一个进入的客户端拿到控制权', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    t.advance(40_000);
    tab2.heartbeat(); // tab2 的租约到 t0+100s
    t.advance(15_000);
    tab2.claim(); // t0+55s 接管；之后 tab2 掉线
    expect(tab2.view().control.mine).toBe(true);
    t.advance(46_000); // t0+101s：两个租约都过期了，居民离线
    expect(isPresent(a)).toBe(false);
    // 控制权不应该比握着它的租约活得更久
    expect(a.row().controller_client).toBeNull();
    a.enter();
    expect(a.view().control.mine).toBe(true);
    expect(() => a.act('speak', { text: '回来了' })).not.toThrow();
  });

  it('多开页面不会获得额外的发言额度（限流按居民算）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    a.act('speak', { text: '一' });
    a.act('speak', { text: '二' });
    tab2.claim();
    tab2.act('speak', { text: '三' });
    expect(tab2.fail('speak', { text: '四' }).code).toBe('rate_limited');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM presence_leases WHERE resident_id = ?', a.residentId)).toBe(2);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM residents')).toBe(2);
  });
});

describe('栖灯镇在场：重启后重新确认', () => {
  it('重启后居民先按离线处理；租约还有效的客户端一次心跳就恢复在场', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const a = t.join('阿灯');
      const b = t.join('小岚', 'agent');
      t.advance(10_000);
      a.heartbeat();
      b.heartbeat();
      t.advance(5_000);
      restartFresh(t);
      expect(isPresent(a)).toBe(false);
      // 重启后的现场：没有人能听到 a 说话（a 还没有被重新确认）
      expect(b.fail('speak', { text: '有人吗' }).reason).toBe('not_present');
      a.heartbeat();
      expect(isPresent(a)).toBe(true);
      // 控制权不需要重新抢：租约和控制者记录都还在
      expect(() => a.act('speak', { text: '我回来了' })).not.toThrow();
      expect(isPresent(b)).toBe(false);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('重启后租约已经过期：心跳 presence_lost，必须重新 enter', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const a = t.join('阿灯');
      t.advance(10_000);
      t.w.close();
      t.clock.advance(10 * 60_000);
      restartFresh(t);
      expect(catchErr(() => a.heartbeat()).reason).toBe('presence_lost');
      expect(isPresent(a)).toBe(false);
      a.enter();
      expect(isPresent(a)).toBe(true);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('重启把重启前在场的人记为「停机那一刻」离线，有效在场时间不多算', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const a = t.join('阿灯');
      const t0 = t.clock.t;
      t.advance(10_000);
      t.w.close(); // close 会写下最后存活时间
      t.clock.advance(3600_000);
      restartFresh(t);
      expect(a.row().last_seen_at).toBe(t0 + 10_000);
      expect(a.row().present_ms).toBe(10_000);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });
});

describe('栖灯镇：离线的居民不在现场', () => {
  function setup() {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    return { t, a, b };
  }

  it('显式离开的人：不在现场名单、听不到发言、历史里没有这句话', () => {
    const { a, b } = setup();
    b.leave();
    expect(a.view().here?.residents.map((r) => r.name)).toEqual([]);
    const out = a.act('speak', { text: '有人在吗' });
    expect(out.heardBy).toBe(0);
    expect(b.events().events).toEqual([]);
    b.enter();
    expect(chatTexts(b)).toEqual([]);
    expect(b.view().here?.chat).toEqual([]); // 重连也不补听
  });

  it('租约到期的离线与显式离开一样', () => {
    const { t, a, b } = setup();
    a.heartbeat();
    t.advance(30_000);
    a.heartbeat();
    t.advance(31_000); // b 到期，a 还在
    expect(isPresent(b)).toBe(false);
    expect(a.view().here?.residents).toEqual([]);
    a.act('speak', { text: '小岚走了吗' });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_audience WHERE resident_id = ?', b.residentId)).toBe(0);
  });

  it('不能当面赠送、邀请、询问爱好离线的人，回应与「不在身边」一致', () => {
    const { a, b } = setup();
    b.leave();
    for (const [type, fields] of [
      ['offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } }],
      ['invite', { to: b.residentId }],
      ['ask_hobby', { target: b.residentId }],
    ] as const) {
      const err = a.fail(type, fields);
      expect(err.code).toBe('precondition_failed');
      expect(err.reason).toBe('not_here');
    }
    // 对不存在的人给出同样的回应，不能用来探测
    const ghost = a.fail('invite', { to: 'r_nobody' });
    expect(ghost.reason).toBe('not_here');
    expect(a.coins()).toBe(20); // 没有预留
  });

  it('宽限期内（租约未过期）仍听得到现场发言', () => {
    const { t, a, b } = setup();
    t.advance(40_000); // b 沉默 40 秒，仍在宽限内
    a.heartbeat();
    a.act('speak', { text: '还在宽限期里' });
    expect(isPresent(b)).toBe(true);
    expect(b.events().events.length).toBe(0); // 无游标时不回放
    expect(chatTexts(b)).toEqual(['还在宽限期里']);
  });

  it('离线不掉社交 / 兴趣需要，在场按小时下降', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const n0 = a.view().me.needs;
    t.advanceAlive(3600_000, [a]);
    const n1 = a.view().me.needs;
    expect(n1.social).toBeCloseTo(n0.social - 5, 1);
    expect(n1.interest).toBeCloseTo(n0.interest - 3, 1);
    expect(n1.energy).toBe(n0.energy);
    // 不再续租：60 秒后离线，之后十个小时不掉
    t.advance(10 * 3600_000);
    expect(isPresent(a)).toBe(false);
    const n2 = a.view().me.needs;
    const graceHours = 60 / 3600;
    expect(n2.social).toBeCloseTo(n0.social - 5 * (1 + graceHours), 1);
    expect(n2.interest).toBeCloseTo(n0.interest - 3 * (1 + graceHours), 1);
    // 回来之后继续按在场时间下降
    a.enter();
    t.advanceAlive(3600_000, [a]);
    const n3 = a.view().me.needs;
    expect(n3.social).toBeCloseTo(n2.social - 5, 1);
    expect(n3.interest).toBeCloseTo(n2.interest - 3, 1);
  });

  it('显式离开期间也不掉需要', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const n0 = a.view().me.needs;
    a.leave();
    t.advance(48 * 3600_000);
    expect(a.view().me.needs.social).toBe(n0.social);
    expect(a.view().me.needs.interest).toBe(n0.interest);
  });

  it('需要是软的：降到 0 也不禁止任何动作', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    t.advanceAlive(30 * 3600_000, [a], 60_000 / 3);
    expect(a.view().me.needs.social).toBe(0);
    expect(() => a.act('speak', { text: '还是能说话' })).not.toThrow();
    expect(() => a.go('tea_house')).not.toThrow();
  });
});

describe('栖灯镇导航：用时由路程决定，路上属于脚下的区域', () => {
  /** 往前走 ms：每秒推进一次，途中像真客户端那样心跳并续导航租约。 */
  const stepWalk = (t: Town, ms: number, people: Actor[]) => {
    for (let left = ms; left > 0; left -= 1_000) {
      t.advance(Math.min(1_000, left));
      for (const x of people) {
        x.heartbeat();
        const nav = whereabouts(t.w, x.row(), t.clock.t).navigation;
        if (nav) renewNavigation(t.w, x.auth, { navigationId: nav.navigationId, revision: nav.revision });
      }
    }
  };
  /** 一直走到脚下的区域标签变成 zone 为止（在这之前每一步都在路上）。 */
  const walkInto = (t: Town, zone: string, people: Actor[], who: Actor) => {
    for (let i = 0; i < 400; i++) {
      if (who.row().location_id === zone) return;
      stepWalk(t, 500, people);
    }
    throw new Error(`没有走进 ${zone}`);
  };
  const eventTypes = (a: Actor, cursor: string) => a.events(cursor).events.map((e) => e.type);

  it('回执：accepted，没有路线；一路走过去，每到一处区域标签就对', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const out = a.act('navigate', { to: 'tea_house' });
    expect(out.status).toBe('accepted');
    expect(out.navigation.to).toMatchObject({ kind: 'place', id: 'tea_house' });
    expect(out.navigation.arriveAt).toBeGreaterThan(t.clock.t);
    expect(JSON.stringify(out)).not.toMatch(/points|path/);
    a.walk();
    expect(a.row().location_id).toBe('tea_house');
    // 旧名 move 仍然认；一站一站走下去
    for (const to of ['bookshop', 'kitchen', 'garden', 'arcade', 'plaza']) {
      const r = a.act('move', { to });
      expect(r.status).toBe('accepted');
      a.walk();
      expect(a.row().location_id).toBe(to);
    }
  });

  it('进出住宅：回家要先走到会馆门口再进门；出门落在会馆门口', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const home = `home:${a.residentId}`;
    const out = a.go('home');
    expect(out.status).toBe('accepted');
    expect(out.navigation.continues).toBe(true);
    expect(a.row().location_id).toBe(home);
    expect(a.pos().scene).toBe('home');
    expect(a.pos().instance).toBe(a.residentId);
    // 出门：落在会馆门口，再往广场走
    const back = a.go('plaza');
    expect(back.status).toBe('accepted');
    expect(a.row().location_id).toBe('plaza');
    // 就在会馆门口时进自己家：很快就到
    a.go('residential');
    expect(a.row().location_id).toBe('residential');
    const near = a.act('navigate', { to: 'home' });
    expect(near.status === 'completed' || near.status === 'accepted').toBe(true);
    a.walk();
    expect(a.row().location_id).toBe(home);
  });

  it('到点才到达：提前 1 毫秒仍在走，到达事件的时间 = 应到达时刻（即使很晚才被处理）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const out = a.act('navigate', { to: 'tea_house' });
    const arriveAt = out.navigation.arriveAt;
    stepWalk(t, 5_000, [a]);
    t.clock.advance(arriveAt - 1 - t.clock.t);
    a.heartbeat();
    t.w.tick();
    expect(a.view().location.navigation).not.toBeNull();
    // 过了很久才有人来处理（期间没人续租，但到达发生在租约截止之前）：到达时间仍是 arriveAt
    t.clock.advance(40_000);
    t.w.tick();
    const rows = t.w.db.all("SELECT occurred_at FROM recipient_events WHERE resident_id = ? AND type = 'you_arrived'", a.residentId);
    expect(rows.map((r) => r.occurred_at)).toContain(arriveAt);
    expect(a.row().location_id).toBe('tea_house');
    expect(a.view().location.navigation).toBeNull();
  });

  it('路上的人属于脚下的区域：能说话、能做事、能再次改道；公开地图把他放在「路上」', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('navigate', { to: 'tea_house' });
    // 刚出发：还在广场，身边的人看得见，也听得见
    expect(a.view().here?.space).toBe('plaza');
    expect(a.view().here?.residents.map((r) => r.name)).toEqual(['小岚']);
    expect(a.act('speak', { text: '边走边说' }).ok).toBe(true);
    expect(chatTexts(b)).toEqual(['边走边说']);
    // 走到路上：属于路上这片区域，有自己的现场（不是空的，也不是「不在任何地点」）
    walkInto(t, 'road', [a, b], a);
    expect(a.view().location.space).toBe('road');
    expect(a.view().here).not.toBeNull();
    expect(a.view().here?.space).toBe('road');
    expect(a.act('speak', { text: '路上说话' }).ok).toBe(true);
    const pub = publicView(t.w);
    expect(pub.places.find((p) => p.id === 'road')).toMatchObject({ through: true });
    expect(pub.places.find((p) => p.id === 'road')!.residents.map((r) => r.name)).toEqual(['阿灯']);
    expect(pub.places.find((p) => p.id === 'plaza')!.residents.map((r) => r.name)).toEqual(['小岚']);
    // 在路上改道不需要先停下
    const again = a.act('navigate', { to: 'bookshop' });
    expect(again.status).toBe('accepted');
    a.walk();
    expect(a.row().location_id).toBe('bookshop');
  });

  it('走过一片区域时听得到身边的话，走远之后听不到；说话的受众是那一刻交谈距离内的在场的人', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满');
    a.go('tea_house');
    c.go('garden');
    // 小岚站在广场西侧的入口附近；阿灯从茶馆走向花园，途中路过广场
    b.go({ x: 23, z: 26 });
    a.act('navigate', { to: 'garden' });
    expect(a.row().location_id).toBe('tea_house');
    walkInto(t, 'plaza', [a, b, c], a);
    b.act('speak', { text: '广场上的话' });
    a.act('speak', { text: '路过广场' });
    expect(chatTexts(a)).toContain('广场上的话'); // 走过这里时听得到
    expect(chatTexts(b)).toContain('路过广场');
    expect(chatTexts(c)).toEqual([]); // 花园里的人听不到
    // 走出广场之后：这里的话听不到了
    walkInto(t, 'road', [a, b, c], a);
    const heardBefore = chatTexts(a).length;
    b.act('speak', { text: '你走远了' });
    expect(chatTexts(a).length).toBe(heardBefore);
    expect(chatTexts(a)).not.toContain('你走远了');
    // 到了花园：听得到花园里的话，补不到之前别处的话
    walkInto(t, 'garden', [a, b, c], a);
    c.act('speak', { text: '花园里的话' });
    expect(chatTexts(a)).toContain('花园里的话');
    expect(chatTexts(c)).not.toContain('路过广场');
    expect(chatTexts(c)).not.toContain('广场上的话');
  });

  it('跨区域时：出发地的人收到 left，目的地的人收到 arrived，本人收到 you_arrived；事件里没有坐标', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满');
    c.go('tea_house');
    const cb = b.view().cursor;
    const cc = c.view().cursor;
    const ca = a.view().cursor;
    a.go('tea_house');
    expect(eventTypes(b, cb)).toEqual(['left']);
    expect(eventTypes(c, cc)).toEqual(['arrived']);
    const mine = a.events(ca).events.map((e) => e.type);
    expect(mine).toContain('you_arrived');
    for (const who of [b, c, a]) {
      const cur = who === b ? cb : who === c ? cc : ca;
      expect(JSON.stringify(who.events(cur).events)).not.toMatch(/"(x|z|points|arriveAt|leaseUntil)"/);
    }
  });

  it('不存在的地方、已经在这里、别人的家（没邀请）都不能去；失败后没有在走', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    expect(a.fail('navigate', { to: 'moon_base' }).reason).toBe('no_such_place');
    expect(a.fail('navigate', { to: 'plaza' }).reason).toBe('already_here');
    expect(a.fail('navigate', { to: `home:${b.residentId}` }).reason).toBe('no_access');
    expect(a.fail('navigate', { to: 'home:r_nobody' }).reason).toBe('no_such_place');
    expect(a.fail('navigate', {}).reason).toBe('no_such_place');
    expect(a.view().location.navigation).toBeNull();
  });

  it('导航请求用同一个请求号重放，只走一次', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const first = a.act('navigate', { to: 'tea_house' }, { requestId: 'move-req-0001' });
    stepWalk(t, 2_000, [a]);
    const again = a.act('navigate', { to: 'tea_house' }, { requestId: 'move-req-0001' });
    expect(again.replayed).toBe(true);
    expect(again.navigation.navigationId).toBe(first.navigation.navigationId);
    expect(again.navigation.revision).toBe(first.navigation.revision);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(1);
    a.walk();
    expect(a.row().location_id).toBe('tea_house');
  });

  it('离线立即停步：停在离线那一刻的位置，不再有到达任务；回来时人就在停下的地方', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('navigate', { to: 'tea_house' });
    stepWalk(t, 3_000, [a, b]);
    const cb = b.view().cursor;
    const stoppedAt = t.clock.t;
    a.leave();
    expect(isPresent(a)).toBe(false);
    const where = a.pos();
    expect(where.moving).toBe(false);
    expect(a.view().location.navigation).toBeNull();
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'")).toBe(0);
    // 离线的人不在公开地图上；同一区域的人收到的是 presence，不是 left（人没有离开这片区域）
    expect(publicNames(t)).not.toContain('阿灯');
    expect(eventTypes(b, cb)).toEqual(['presence']);
    // 过了再久，也不会自己走到茶馆
    stepWalk(t, 120_000, [b]);
    expect(a.row().location_id).toBe('plaza');
    expect(a.pos()).toMatchObject({ x: where.x, z: where.z });
    // 有效在场时间只算到离线那一刻
    expect(a.row().last_seen_at).toBe(stoppedAt);
    // 回来：位置还是停下的地方，从那里重新出发
    a.enter();
    expect(a.row().location_id).toBe('plaza');
    expect(a.pos()).toMatchObject({ x: where.x, z: where.z });
    expect(publicNames(t)).toContain('阿灯');
    a.go('tea_house');
    expect(a.row().location_id).toBe('tea_house');
    checkSpaceInvariants(t);
  });

  it('离开时已经走出了广场、但区域变化还没被结算：先结算再离线，广场上的人看到的是 left，不是 presence', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const out = a.act('navigate', { to: 'tea_house' });
    const cb = b.view().cursor;
    const pubCur = t.w.publicCursor();
    t.clock.advance(8_000); // 不 tick：广场 → 路上的区域变化已到期但还没处理
    expect(a.row().location_id).toBe('plaza');
    a.leave();
    expect(a.row().location_id).toBe('road');
    expect(eventTypes(b, cb)).toEqual(['left']);
    checkSpaceInvariants(t);
    // 公开层面：先出现「路上」，再离线
    const spots = t.w.readPublicEvents(pubCur).events.filter((e) => e.type === 'place').map((e) => (e.data as { resident: { id: string; at: string | null } }).resident).filter((r) => r.id === a.residentId);
    expect(spots.slice(-2).map((r) => r.at)).toEqual(['road', null]);
    void out;
  });

  it('走在半路（已经出了广场）离线：停在路上，回来时人在路上，再走完', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('navigate', { to: 'tea_house' });
    walkInto(t, 'road', [a], a);
    a.leave();
    stepWalk(t, 90_000, []);
    expect(a.row().location_id).toBe('road');
    a.enter();
    expect(a.row().location_id).toBe('road');
    expect(a.view().here?.space).toBe('road');
    expect(publicView(t.w).places.find((p) => p.id === 'road')!.residents.map((r) => r.name)).toEqual(['阿灯']);
    a.go('tea_house');
    expect(a.row().location_id).toBe('tea_house');
  });

  it('谁都不再续租：先因导航租约停在半路，再因在场租约到期离线；离线时的区域标签就是停下的地方', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const c = t.join('小满');
    c.go('tea_house');
    const cc = c.view().cursor;
    const ca = a.view().cursor;
    a.act('navigate', { to: 'tea_house' });
    t.advance(2_000);
    t.advanceAlive(100_000, [c]);
    expect(isPresent(a)).toBe(false);
    expect(a.view().location.navigation).toBeNull();
    const stopped = a.row().location_id;
    expect(stopped).not.toBe('tea_house');
    expect(a.events(ca).events.find((e) => e.type === 'nav_stopped')?.data).toMatchObject({ reason: 'lease' });
    // 茶馆里的人从头到尾没有看到他
    expect(eventTypes(c, cc)).toEqual([]);
    // 回来时还停在那里
    a.enter();
    expect(a.row().location_id).toBe(stopped);
    checkSpaceInvariants(t);
  });

  it('控制权被接管：正在走的路立即停步，本人收到 nav_stopped（control）；不丢位置', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const tab2 = otherClient(t, a, 'web:tab-two');
    tab2.enter();
    const cur = a.view().cursor;
    a.act('navigate', { to: 'tea_house' });
    stepWalk(t, 2_000, [a]);
    tab2.claim();
    expect(a.view().location.navigation).toBeNull();
    expect(a.pos().moving).toBe(false);
    const ev = a.events(cur).events.find((e) => e.type === 'nav_stopped');
    expect(ev?.data).toMatchObject({ reason: 'control' });
    // 旧的页面没法再续这条路
    stepWalk(t, 20_000, [tab2]);
    expect(a.row().location_id).not.toBe('tea_house');
  });
});

describe('栖灯镇发言：受众在提交时固定', () => {
  it('之后到的人看不到这句话，历史查询也只返回当时在受众里的', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const out = a.act('speak', { text: '早先说的话' });
    expect(out.heardBy).toBe(1);
    const late = t.join('小满');
    expect(late.view().here?.chat).toEqual([]);
    expect(chatTexts(late)).toEqual([]);
    expect(chatTexts(b)).toEqual(['早先说的话']);
    expect(chatTexts(a)).toEqual(['早先说的话']);
    // 后到的人说话，早先的人也听得到；早先的话仍然只有当时的人有
    late.act('speak', { text: '后来说的话' });
    expect(chatTexts(late)).toEqual(['后来说的话']);
    expect(chatTexts(b).sort()).toEqual(['后来说的话', '早先说的话'].sort());
  });

  it('当时在场的人事后离开，历史里仍有；离线者重新进入也补不到', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '给小岚听的' });
    b.go('tea_house');
    expect(chatTexts(b)).toEqual(['给小岚听的']);
    // （现场视图只按受众表和时间窗，不再按当前区域标签：b 当时听到了，走到茶馆后仍列着）
    expect(b.view().here?.chat.map((m) => m.text)).toEqual(['给小岚听的']);
    const off = t.join('小满');
    off.leave();
    a.act('speak', { text: '小满不在' });
    off.enter();
    expect(chatTexts(off)).toEqual([]);
  });

  it('读历史 / 读事件不会「消费」掉别人的那份：可重复读，互不影响', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const ca = a.view().cursor;
    const cb = b.view().cursor;
    a.act('speak', { text: '一句话' });
    const first = chatTexts(b);
    const second = chatTexts(b);
    expect(first).toEqual(second);
    expect(b.events(cb).events.map((e) => e.type)).toEqual(['chat']);
    expect(b.events(cb).events.map((e) => e.type)).toEqual(['chat']); // 同一游标重读还在
    expect(a.events(ca).events.map((e) => e.type)).toEqual(['chat']); // 发言人也收到自己的那条
    // b 的另一个客户端从旧游标读也能读到
    const tab2 = otherClient(t, b, 'mcp:tab-two');
    expect(tab2.events(cb).events).toHaveLength(1);
  });

  it('历史分页：before / limit，next 游标', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    for (let i = 1; i <= 5; i++) {
      a.act('speak', { text: `第${i}句` });
      t.advance(10_000);
    }
    const page1 = chatHistory(t.w, a.residentId, null, 2);
    expect(page1.messages.map((m) => m.text)).toEqual(['第5句', '第4句']);
    expect(page1.next).not.toBeNull();
    const page2 = chatHistory(t.w, a.residentId, page1.next, 2);
    expect(page2.messages.map((m) => m.text)).toEqual(['第3句', '第2句']);
    const page3 = chatHistory(t.w, a.residentId, page2.next, 2);
    expect(page3.messages.map((m) => m.text)).toEqual(['第1句']);
    expect(page3.next).toBeNull();
  });

  it('不同空间的话互不相通', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    b.go('tea_house');
    a.act('speak', { text: '广场上的话' });
    expect(chatTexts(b)).toEqual([]);
  });

  it('发言长度上限 120 个字符（按 Unicode 字符计，不拆开表情符号）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '灯'.repeat(300) });
    t.advance(20_000);
    a.act('speak', { text: '😀'.repeat(200) });
    const texts = chatTexts(b);
    expect(texts).toHaveLength(2);
    // 历史按新到旧排列
    expect(texts[0]).toBe('😀'.repeat(120));
    expect([...texts[1]!]).toHaveLength(120);
    // 参数可调
    const t2 = makeTown({ params: { chatMaxChars: 10 } });
    const x = t2.join('阿灯');
    x.act('speak', { text: '一二三四五六七八九十十一十二' });
    expect(chatTexts(x)[0]).toBe('一二三四五六七八九十');
  });

  it('发言经过清洗：控制字符、换行、{@、[CQ:；空内容被拒绝', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '你好\n\n世界\u0007 {@all} [CQ:at,qq=1]' });
    const text = chatTexts(b)[0]!;
    expect(text).not.toMatch(/[\n\u0007]/);
    expect(text).not.toContain('{@');
    expect(text.toLowerCase()).not.toContain('[cq:');
    expect(text.startsWith('你好 世界')).toBe(true);
    for (const empty of ['', '   ', '\n\n', '\u0007', undefined, 42]) {
      expect(a.fail('speak', { text: empty }).code).toBe('bad_request');
    }
  });

  it('限流：突发 3 条，之后 rate_limited 并带 retryAfterMs；等够时间同一个请求号可重试', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    for (let i = 0; i < 3; i++) a.act('speak', { text: `第${i}句` });
    const err = a.fail('speak', { text: '第四句' }, { requestId: 'speak-retry-0001' });
    expect(err.code).toBe('rate_limited');
    expect(err.data?.retryAfterMs).toBe(10_000); // 每分钟 6 条 → 每 10 秒回一枚令牌
    expect(err.toJSON().retryAfterMs).toBe(10_000);
    // 被拒绝的尝试不消耗额度，也不留下回执
    t.advance(9_999);
    expect(a.fail('speak', { text: '第四句' }, { requestId: 'speak-retry-0002' }).code).toBe('rate_limited');
    t.advance(1);
    const ok = a.act('speak', { text: '第四句' }, { requestId: 'speak-retry-0001' });
    expect(ok.replayed).toBeUndefined();
    expect(ok.status).toBe('completed');
    // 额度又空了
    expect(a.fail('speak', { text: '第五句' }).code).toBe('rate_limited');
  });

  it('限流是持续的：每分钟 6 条的平均速率，一小时内不能刷出更多', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    let sent = 0;
    for (let sec = 0; sec < 600; sec += 2) {
      try {
        a.act('speak', { text: 'x' });
        sent++;
      } catch (e) {
        if (!(e instanceof WorldError) || e.code !== 'rate_limited') throw e;
      }
      t.advanceAlive(2_000, [a], 2_000);
    }
    // 10 分钟：突发 3 + 每分钟 6 条 × 10 分钟
    expect(sent).toBeLessThanOrEqual(3 + 60);
    expect(sent).toBeGreaterThanOrEqual(55);
  });

  it('同一请求号重放发言：只发一次', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '只说一次' }, { requestId: 'speak-req-0001' });
    const again = a.act('speak', { text: '只说一次' }, { requestId: 'speak-req-0001' });
    expect(again.replayed).toBe(true);
    expect(chatTexts(b)).toEqual(['只说一次']);
    // 同一个请求号换内容 → 冲突
    expect(a.fail('speak', { text: '换了内容' }, { requestId: 'speak-req-0001' }).code).toBe('request_conflict');
  });
});

describe('栖灯镇：询问爱好（ask_hobby）', () => {
  it('当面问：返回对方的兴趣，对方收到 asked_hobby 事件', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    b.act('update_profile', { interests: ['tea', 'books'] });
    const cb = b.view().cursor;
    const out = a.act('ask_hobby', { target: b.residentId });
    expect(out.interests.map((i: { id: string }) => i.id).sort()).toEqual(['books', 'tea']);
    expect(out.text).toContain('茶');
    const ev = b.events(cb).events;
    expect(ev.map((e) => e.type)).toEqual(['asked_hobby']);
    expect((ev[0]!.data.from as { id: string }).id).toBe(a.residentId);
  });

  it('allowAskHobby 关掉：被拒绝，且不泄露兴趣；打开后恢复', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    b.act('update_profile', { interests: ['games'], allowAskHobby: false });
    const err = a.fail('ask_hobby', { target: b.residentId });
    expect(err.reason).toBe('declined');
    expect(JSON.stringify(err.toJSON())).not.toContain('桌游');
    expect(b.events().events).toEqual([]);
    t.advanceAlive(60_000, [a, b]);
    b.act('update_profile', { allowAskHobby: true });
    expect(a.act('ask_hobby', { target: b.residentId }).interests).toHaveLength(1);
  });

  it('对方不在身边（别处、自己、不存在）一律 not_here；被问的人什么都不知道', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (const target of [a.residentId, 'r_nobody', '']) {
      const e = a.fail('ask_hobby', { target });
      expect([e.reason, e.data]).toEqual(['not_here', undefined]);
    }
    // 在别人家里：和不存在的人分不出来
    b.go(`home:${b.residentId}`);
    const home = a.fail('ask_hobby', { target: b.residentId });
    expect([home.reason, home.message, home.data]).toEqual(['not_here', a.fail('ask_hobby', { target: 'r_nobody' }).message, undefined]);
  });

  it('ask_hobby 按距离：同一区域但远 → too_far（navigateTo 是对方）；走过去就成功；隔着区域边界但很近也成功', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    b.go({ x: 21, z: 19 });
    const e = a.fail('ask_hobby', { target: b.residentId });
    expect([e.reason, e.data]).toEqual(['too_far', { navigateTo: b.residentId }]);
    a.go(b.residentId);
    expect(a.act('ask_hobby', { target: b.residentId }).status).toBe('completed');
    a.go({ x: 43.5, z: 26.5 });
    b.go({ x: 44.8, z: 26.5 });
    expect([a.row().location_id, b.row().location_id]).toEqual(['plaza', 'road']);
    expect(a.act('ask_hobby', { target: b.residentId }).status).toBe('completed');
  });

  it('限流：突发 2 次之后 rate_limited', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('ask_hobby', { target: b.residentId });
    a.act('ask_hobby', { target: b.residentId });
    const err = a.fail('ask_hobby', { target: b.residentId });
    expect(err.code).toBe('rate_limited');
    expect(err.data?.retryAfterMs).toBe(30_000);
  });

  it('没有设置过兴趣的人：给出固定说法，不编造', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const out = a.act('ask_hobby', { target: b.residentId });
    expect(out.interests).toEqual([]);
    expect(out.text).toContain('还没说过');
  });
});

describe('栖灯镇：「有来有往」的交谈事实', () => {
  const conversations = (t: Town) => t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'conversation'");

  it('只有一个人自说自话不算交谈；对方五分钟内回话才算', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '你好' });
    t.advance(10_000);
    a.act('speak', { text: '在吗' });
    t.advance(10_000);
    a.act('speak', { text: '喂' });
    expect(conversations(t)).toBe(0);
    t.advance(10_000);
    b.act('speak', { text: '我在' });
    expect(conversations(t)).toBeGreaterThanOrEqual(1);
  });

  it('对方的话过了五分钟才回，不算来回', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '你好' });
    t.advanceAlive(5 * 60_000 + 1_000, [a, b]);
    b.act('speak', { text: '才看到' });
    expect(conversations(t)).toBe(0);
  });

  it('对方当时没听到（离线 / 不在同一空间 / 后来才到），回话不算来回', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满');
    c.go('tea_house'); // c 先去了别处
    b.leave();
    a.act('speak', { text: 'b 不在的时候说的' });
    t.advanceAlive(5_000, [a, c]);
    b.enter();
    b.act('speak', { text: '我回来了' });
    expect(conversations(t)).toBe(0);
    // c 回到广场，没听过 a 的话，回话不算
    c.go('plaza');
    t.advanceAlive(10_000, [a, b, c]);
    c.act('speak', { text: '我也来了' });
    expect(conversations(t)).toBe(0);
  });

  it('当事双方都是发言人，每对居民每天的交谈事实有上限，刷屏堆不出记录', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let i = 0; i < 20; i++) {
      a.act('speak', { text: `问${i}` });
      b.act('speak', { text: `答${i}` });
      t.advanceAlive(60_000, [a, b], 20_000);
    }
    const n = conversations(t);
    expect(n).toBeGreaterThan(0);
    // 事实可以有，但带来变化的只有前几次：relationshipRewardEvents = 3
    const rel = t.w.db.scalar("SELECT COALESCE(SUM(count), 0) FROM interaction_counters WHERE category = 'chat'");
    expect(rel).toBeLessThanOrEqual(t.w.params.relationshipRewardEvents);
  });
});
