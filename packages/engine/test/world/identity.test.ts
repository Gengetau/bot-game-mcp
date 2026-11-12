/**
 * 栖灯镇：身份与登录。
 * 对照设计文档第 2 节（居民身份）和第 10 节（认证会话与控制）。
 */
import { describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { WorldError } from '../../src/world/errors.js';
import { agentPrincipal, devLoginSession, enter, exchangeTicket, issueTicket, revokeSession, sessionPrincipal } from '../../src/world/identity.js';
import { createWorld, enterWorld } from '../../src/world/index.js';
import { publicView } from '../../src/world/views.js';
import { sha256 } from '../../src/world/service.js';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';

/** 重启并换一个随机种子：固定种子的编号序列在重启后会重复，真实环境用密码学随机不会。 */
function restartFresh(t: Town) {
  (t.opts as { seed?: string }).seed = `after-restart-${t.clock.t}`;
  return t.restart();
}

function catchErr(fn: () => unknown): WorldError {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorldError) return e;
    throw e;
  }
  throw new Error('本应失败，却成功了');
}

/** 为指定账号签票、换会话，拿到主体编号。 */
function humanPrincipal(t: Town, subject: string, name = '路人') {
  const ticket = issueTicket(t.w, { provider: 'qq', subject, name });
  const session = exchangeTicket(t.w, ticket.ticket);
  return { principalId: sessionPrincipal(t.w, session.token)!.principal_id, token: session.token };
}

const residentCount = (t: Town) => t.w.db.scalar('SELECT COUNT(*) FROM residents WHERE world_id = ?', t.w.worldId);

describe('栖灯镇身份：一个主体只有一个居民', () => {
  it('同一主体换客户端重复进入，不会生成第二个居民，物资也不重复发', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const coins = a.coins();
    const tea = a.qty('tea_leaves');
    const again = enterWorld(t.w, { principalId: a.principalId, clientId: 'web:other-tab' }, { clientKind: 'web', profile: { name: '换个名字也没用' } });
    expect(again.enter.created).toBe(false);
    expect(again.enter.residentId).toBe(a.residentId);
    expect(residentCount(t)).toBe(1);
    expect(a.row().name).toBe('阿灯'); // 再进入时带的 profile 不会改已有资料
    expect(a.coins()).toBe(coins);
    expect(a.qty('tea_leaves')).toBe(tea);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM business_keys WHERE key LIKE 'starter:%'")).toBe(1);
  });

  it('同一客户端重放同一次进入（幂等）：仍是同一居民、租约只有一条', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    for (let i = 0; i < 5; i++) a.enter();
    expect(residentCount(t)).toBe(1);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM presence_leases WHERE resident_id = ?', a.residentId)).toBe(1);
    expect(a.coins()).toBe(20);
  });

  it('数据库层面也不允许一个主体有两个居民', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    expect(() =>
      t.w.db.run(
        `INSERT INTO residents(resident_id, world_id, principal_id, name, kind, street_id, house_no, location_id, state_json, created_at, last_seen_at)
         VALUES ('r_dup', ?, ?, '分身', 'human', 'street_east', 99, 'plaza', '{}', 0, 0)`,
        t.w.worldId,
        a.principalId,
      ),
    ).toThrow();
    expect(residentCount(t)).toBe(1);
  });

  it('同一个人拿多张票据、多次登录，都落在同一个居民上', () => {
    const t = makeTown();
    const p1 = humanPrincipal(t, '9001', '小满');
    const p2 = humanPrincipal(t, '9001', '改过的昵称');
    expect(p2.principalId).toBe(p1.principalId);
    const r1 = enterWorld(t.w, { principalId: p1.principalId, clientId: 'web:tab-a' }, { profile: { name: '小满' } });
    const r2 = enterWorld(t.w, { principalId: p2.principalId, clientId: 'web:tab-b' }, {});
    expect(r2.enter.residentId).toBe(r1.enter.residentId);
    expect(r2.enter.created).toBe(false);
    expect(residentCount(t)).toBe(1);
  });

  it('重启之后再进入：还是原来的居民，财产和位置都在，物资不重发', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const a = t.join('阿灯');
      a.act('buy', { shop: 'stall', sku: 'cookie', qty: 1 });
      const coinsBefore = a.coins();
      const tea = a.qty('tea_leaves');
      const home = a.view().me.home;
      t.advance(5_000);
      restartFresh(t);
      // 重启后 principal 仍在；旧租约保留，居民先按离线处理
      expect(a.row().present_since).toBeNull();
      const back = enterWorld(t.w, a.auth, { profile: { name: '换名字' } });
      expect(back.enter.created).toBe(false);
      expect(back.enter.wasAway).toBe(true);
      expect(back.enter.residentId).toBe(a.residentId);
      expect(residentCount(t)).toBe(1);
      expect(a.coins()).toBe(coinsBefore);
      expect(a.qty('tea_leaves')).toBe(tea);
      expect(a.view().me.home).toEqual(home);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM business_keys WHERE key LIKE 'starter:%'")).toBe(1);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('改名不创建新居民，居民编号不变', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('update_profile', { name: '阿灯二号' });
    expect(a.row().name).toBe('阿灯二号');
    expect(a.row().resident_id).toBe(a.residentId);
    expect(residentCount(t)).toBe(1);
    // 旧名字释放了，别人可以用
    const b = t.join('阿灯');
    expect(b.residentId).not.toBe(a.residentId);
  });
});

describe('栖灯镇身份：名字与资料', () => {
  it('名字重复（不分大小写、不分首尾空白）返回 name_taken，且不留下半个居民', () => {
    const t = makeTown();
    t.join('Ada');
    const before = residentCount(t);
    const p = humanPrincipal(t, '9100');
    for (const dup of ['Ada', 'ADA', ' ada ', 'aDa']) {
      const err = catchErr(() => enterWorld(t.w, { principalId: p.principalId, clientId: 'web:dup-client' }, { profile: { name: dup } }));
      expect(err.code).toBe('precondition_failed');
      expect(err.reason).toBe('name_taken');
    }
    expect(residentCount(t)).toBe(before);
    expect(t.w.residentOfPrincipal(p.principalId)).toBeUndefined();
    // 换个名字就能进
    const ok = enterWorld(t.w, { principalId: p.principalId, clientId: 'web:dup-client' }, { profile: { name: 'Ada2' } });
    expect(ok.enter.created).toBe(true);
  });

  it('清洗之后相同的名字也算重复（中间多个空格、换行）', () => {
    const t = makeTown();
    t.join('小  岚');
    // join 时名字已被清洗成「小 岚」
    const p = humanPrincipal(t, '9101');
    const err = catchErr(() => enterWorld(t.w, { principalId: p.principalId, clientId: 'web:dup-2' }, { profile: { name: '小\n岚' } }));
    expect(err.reason).toBe('name_taken');
  });

  it('改名撞了别人的名字 name_taken；改成自己名字的大小写变化可以', () => {
    const t = makeTown();
    const a = t.join('Ada');
    t.join('Bob');
    const e = a.fail('update_profile', { name: 'bob' });
    expect(e.reason).toBe('name_taken');
    a.act('update_profile', { name: 'ADA' });
    expect(a.row().name).toBe('ADA');
  });

  it('第一次进入名字被清洗成空 → profile_required，不会注册', () => {
    const t = makeTown();
    const p = humanPrincipal(t, '9102', '有昵称');
    for (const bad of ['', '   ', '\n\t', '\u0007\u0001']) {
      const err = catchErr(() => enterWorld(t.w, { principalId: p.principalId, clientId: 'web:blank' }, { profile: { name: bad } }));
      expect(err.code).toBe('precondition_failed');
      expect(err.reason).toBe('profile_required');
    }
    expect(t.w.residentOfPrincipal(p.principalId)).toBeUndefined();
  });

  it('名字和简介都经过清洗：控制字符、换行、{@ 、[CQ:、超长', () => {
    const t = makeTown();
    const p = humanPrincipal(t, '9103');
    const out = enterWorld(
      t.w,
      { principalId: p.principalId, clientId: 'web:sanitize' },
      { profile: { name: '阿\n灯\u0007{@all}[CQ:at,qq=1]', bio: '第一行\n第二行\u0000 {@12345} [CQ:image,file=x] ' + '很长'.repeat(200) } },
    );
    const r = t.w.mustResident(out.enter.residentId);
    expect(r.name).not.toMatch(/[\n\r\t\u0000-\u001f\u007f]/);
    expect(r.name).not.toContain('{@');
    expect(r.name.toLowerCase()).not.toContain('[cq:');
    expect([...r.name].length).toBeLessThanOrEqual(16);
    expect(r.state.bio).not.toMatch(/[\n\r\u0000-\u001f\u007f]/);
    expect(r.state.bio).not.toContain('{@');
    expect(r.state.bio.toLowerCase()).not.toContain('[cq:');
    expect([...r.state.bio].length).toBeLessThanOrEqual(80);
    // 公开名录和公开地图里是清洗后的名字
    expect(JSON.stringify(publicView(t.w))).not.toContain('[CQ:');
  });

  it('超长名字按字符截断到 16，表情符号不被拆开', () => {
    const t = makeTown();
    const p = humanPrincipal(t, '9104');
    const out = enterWorld(t.w, { principalId: p.principalId, clientId: 'web:long' }, { profile: { name: '😀'.repeat(40) } });
    const r = t.w.mustResident(out.enter.residentId);
    expect([...r.name]).toHaveLength(16);
    expect(r.name).toBe('😀'.repeat(16));
  });

  it('update_profile 同样清洗名字、简介、情绪展示', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.act('update_profile', { name: '新\n名字{@x}', bio: '简\n介[CQ:face,id=1]', mood: '开心\u0007\n！'.repeat(10) });
    const r = a.row();
    expect(r.name).not.toMatch(/[\n\u0007]/);
    expect(r.name).not.toContain('{@');
    expect(r.state.bio).not.toMatch(/\n/);
    expect(r.state.bio.toLowerCase()).not.toContain('[cq:');
    expect(r.state.settings.moodOverride).not.toMatch(/[\n\u0007]/);
    expect([...(r.state.settings.moodOverride ?? '')].length).toBeLessThanOrEqual(12);
    // 清洗后为空的名字被拒绝
    expect(a.fail('update_profile', { name: '\n\u0007 ' }).code).toBe('bad_request');
  });

  it('个性和兴趣：只认已知选项，数量有上限', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    expect(a.fail('update_profile', { traits: ['不存在的个性'] }).code).toBe('bad_request');
    expect(a.fail('update_profile', { interests: ['a', 'b', 'c', 'd'] }).code).toBe('bad_request');
    expect(a.fail('update_profile', { interests: '不是列表' }).code).toBe('bad_request');
  });

  it('类别（human / agent）确定后不能变', () => {
    const t = makeTown();
    // AI 先登记，再想以真人身份拿票据
    agentPrincipal(t.w, { id: '777', name: '机器人' });
    const e1 = catchErr(() => issueTicket(t.w, { provider: 'qq', subject: '777', name: '冒充' }));
    expect(e1.code).toBe('unauthenticated');
    // 真人先登记，再想以 AI 身份进入
    issueTicket(t.w, { provider: 'qq', subject: '888', name: '真人' });
    const e2 = catchErr(() => agentPrincipal(t.w, { id: '888', name: '冒充' }));
    expect(e2.code).toBe('unauthenticated');
    // 已有居民之后同样不能变
    const a = t.join('小岚', 'agent');
    const subject = t.w.db.get('SELECT subject FROM principals WHERE principal_id = ?', a.principalId)!.subject as string;
    expect(catchErr(() => issueTicket(t.w, { provider: 'qq', subject, name: '小岚' })).code).toBe('unauthenticated');
    expect(a.row().kind).toBe('agent');
  });

  it('AI 入口只会登记 agent；居民的 kind 来自主体', () => {
    const t = makeTown();
    const p = agentPrincipal(t.w, { id: '4242', name: '小岚' });
    expect(p.kind).toBe('agent');
    // 重复登记返回同一个主体
    expect(agentPrincipal(t.w, { id: '4242', name: '另一个昵称' }).principal_id).toBe(p.principal_id);
    const out = enterWorld(t.w, { principalId: p.principal_id, clientId: 'mcp:c1' }, { clientKind: 'mcp', profile: { name: '小岚' } });
    expect(t.w.mustResident(out.enter.residentId).kind).toBe('agent');
  });

  it('账号标识不合法的票据请求被拒绝', () => {
    const t = makeTown();
    for (const subject of ['', ' ', '有空格 的', 'a'.repeat(65), "x'; DROP TABLE residents;--"]) {
      expect(catchErr(() => issueTicket(t.w, { provider: 'qq', subject, name: 'x' })).code).toBe('bad_request');
    }
    expect(t.w.db.scalar('SELECT COUNT(*) FROM principals')).toBe(0);
  });

  it('clientId 格式不对不能进入', () => {
    const t = makeTown();
    const p = humanPrincipal(t, '9105');
    for (const bad of ['', 'abc', 'has space', 'x'.repeat(81)]) {
      expect(catchErr(() => enter(t.w, { principalId: p.principalId, clientId: bad }, { profile: { name: '小满' } })).code).toBe('bad_request');
    }
    expect(t.w.residentOfPrincipal(p.principalId)).toBeUndefined();
  });

  it('没有主体（未登录）不能进入', () => {
    const t = makeTown();
    expect(catchErr(() => enter(t.w, { principalId: 'p_nobody', clientId: 'web:nobody' }, { profile: { name: '无名' } })).code).toBe('unauthenticated');
  });
});

describe('栖灯镇身份：世界满员', () => {
  it('在场人数满了：新进入得到 world_full，不留下居民；公开地图照常可读', () => {
    const t = makeTown({ params: { activeResidentLimit: 2 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const p = humanPrincipal(t, '9200');
    const err = catchErr(() => enterWorld(t.w, { principalId: p.principalId, clientId: 'web:late' }, { profile: { name: '迟到者' } }));
    expect(err.code).toBe('precondition_failed');
    expect(err.reason).toBe('world_full');
    // 整个事务回滚：没有半注册的居民，也没有多发的物资
    expect(t.w.residentOfPrincipal(p.principalId)).toBeUndefined();
    expect(residentCount(t)).toBe(2);
    // 公开地图仍然可读，容量写明
    const pub = publicView(t.w);
    expect(pub.counts.present).toBe(2);
    expect(pub.counts.capacity).toBe(2);
    expect(pub.places.length).toBeGreaterThan(0);
    // 已在场的居民多开一个页面不受限制
    const tab2 = new Actor(t, a.principalId, a.residentId, 'web:second-tab', a.name);
    expect(() => tab2.enter()).not.toThrow();
    // 有人离开之后就能进了
    b.leave();
    const ok = enterWorld(t.w, { principalId: p.principalId, clientId: 'web:late' }, { profile: { name: '迟到者' } });
    expect(ok.enter.created).toBe(true);
  });

  it('离线的老居民满员时回不来，直到有空位', () => {
    const t = makeTown({ params: { activeResidentLimit: 2 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.leave();
    const c = t.join('小满'); // 占了空位
    expect(c.row().present_since).not.toBeNull();
    const err = catchErr(() => a.enter());
    expect(err.reason).toBe('world_full');
    expect(a.row().present_since).toBeNull();
    b.leave();
    expect(() => a.enter()).not.toThrow();
    expect(a.row().present_since).not.toBeNull();
  });

  it('重启后第一次心跳遇到满员：返回 world_full，不抢占名额', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path, params: { activeResidentLimit: 1 } });
      const a = t.join('阿灯');
      const epoch = a.row().presence_epoch;
      restartFresh(t);
      expect(a.row().present_since).toBeNull();
      const b = t.join('小岚', 'agent'); // 重启后别人先占了位置
      expect(b.row().present_since).not.toBeNull();
      const err = catchErr(() => a.heartbeat());
      expect(err.reason).toBe('world_full');
      expect(a.row().present_since).toBeNull();
      expect(a.row().presence_epoch).toBe(epoch);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });
});

describe('栖灯镇身份：登录票据与会话', () => {
  it('票据只能兑换一次；第二次与无效票据同一种说法', () => {
    const t = makeTown();
    const ticket = issueTicket(t.w, { provider: 'qq', subject: '9300', name: '小满' });
    const s = exchangeTicket(t.w, ticket.ticket);
    expect(sessionPrincipal(t.w, s.token)).not.toBeNull();
    const reuse = catchErr(() => exchangeTicket(t.w, ticket.ticket));
    const unknown = catchErr(() => exchangeTicket(t.w, 'not-a-ticket'));
    expect(reuse.code).toBe('unauthenticated');
    expect(unknown.code).toBe('unauthenticated');
    expect(reuse.message).toBe(unknown.message);
    // 兑换失败不会多出会话
    expect(t.w.db.scalar('SELECT COUNT(*) FROM sessions')).toBe(1);
  });

  it('票据 5 分钟过期；边界上恰好到期即失效', () => {
    const t = makeTown();
    const a = issueTicket(t.w, { provider: 'qq', subject: '9301', name: '甲' });
    const b = issueTicket(t.w, { provider: 'qq', subject: '9302', name: '乙' });
    expect(a.expires_at - t.clock.t).toBe(5 * 60_000);
    t.advance(5 * 60_000 - 1);
    expect(() => exchangeTicket(t.w, a.ticket)).not.toThrow();
    t.advance(1);
    expect(catchErr(() => exchangeTicket(t.w, b.ticket)).code).toBe('unauthenticated');
    // 过期的票据没有被标记成已兑换，也没有会话
    expect(t.w.db.scalar('SELECT COUNT(*) FROM sessions')).toBe(1);
  });

  it('非字符串、空票据一律无效', () => {
    const t = makeTown();
    for (const bad of [undefined, null, '', 123, { ticket: 'x' }, ['a']]) {
      expect(catchErr(() => exchangeTicket(t.w, bad)).code).toBe('unauthenticated');
    }
  });

  it('票据和会话令牌在数据库里只存哈希', () => {
    const t = makeTown();
    const ticket = issueTicket(t.w, { provider: 'qq', subject: '9303', name: '小满' });
    const s = exchangeTicket(t.w, ticket.ticket);
    const dump = JSON.stringify([t.w.db.all('SELECT * FROM login_tickets'), t.w.db.all('SELECT * FROM sessions')]);
    expect(dump).not.toContain(ticket.ticket);
    expect(dump).not.toContain(s.token);
    expect(dump).toContain(sha256(ticket.ticket));
    expect(dump).toContain(sha256(s.token));
    // 票据和令牌足够长且互不相同
    expect(ticket.ticket.length).toBeGreaterThanOrEqual(30);
    expect(s.token.length).toBeGreaterThanOrEqual(40);
    expect(ticket.ticket).not.toBe(s.token);
  });

  it('配了公网地址时登录链接把票据放在 # 片段里', () => {
    const w = createWorld({ dbPath: ':memory:', registry: createRegistry({}), publicUrl: 'https://example.com/town', rng: new SeededRng('x') });
    w.startSync();
    const t = issueTicket(w, { provider: 'qq', subject: '9304', name: '小满' });
    expect(t.url).toBe(`https://example.com/town/#ticket=${t.ticket}`);
    const url = new URL(t.url!);
    expect(url.search).toBe('');
    expect(url.pathname).not.toContain(t.ticket);
    w.close();
    const bare = makeTown();
    expect(issueTicket(bare.w, { provider: 'qq', subject: '9305', name: '小满' }).url).toBeNull();
  });

  it('会话撤销后失效，居民和财产保留，重新登录回到同一居民', () => {
    const t = makeTown();
    const ticket = issueTicket(t.w, { provider: 'qq', subject: '9400', name: '小满' });
    const s = exchangeTicket(t.w, ticket.ticket);
    const principalId = sessionPrincipal(t.w, s.token)!.principal_id;
    const out = enterWorld(t.w, { principalId, clientId: 'web:s1' }, { profile: { name: '小满' } });
    const a = new Actor(t, principalId, out.enter.residentId, 'web:s1', '小满');
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 1 });
    const coins = a.coins();

    revokeSession(t.w, s.token);
    expect(sessionPrincipal(t.w, s.token)).toBeNull();
    revokeSession(t.w, s.token); // 重复撤销无害
    revokeSession(t.w, 'never-issued'); // 撤销不存在的令牌无害
    expect(residentCount(t)).toBe(1);

    const s2 = exchangeTicket(t.w, issueTicket(t.w, { provider: 'qq', subject: '9400', name: '小满' }).ticket);
    expect(sessionPrincipal(t.w, s2.token)!.principal_id).toBe(principalId);
    expect(t.w.residentOfPrincipal(principalId)!.resident_id).toBe(a.residentId);
    expect(a.coins()).toBe(coins);
    // 撤销一个会话不影响同一人的另一个会话
    expect(sessionPrincipal(t.w, s.token)).toBeNull();
    expect(sessionPrincipal(t.w, s2.token)).not.toBeNull();
  });

  it('会话 30 天过期，过期不删居民；空令牌无效', () => {
    const t = makeTown();
    const s = exchangeTicket(t.w, issueTicket(t.w, { provider: 'qq', subject: '9401', name: '小满' }).ticket);
    const principalId = sessionPrincipal(t.w, s.token)!.principal_id;
    enterWorld(t.w, { principalId, clientId: 'web:s1' }, { profile: { name: '小满' } });
    t.clock.advance(30 * 24 * 3600_000 - 1);
    expect(sessionPrincipal(t.w, s.token)).not.toBeNull();
    t.clock.advance(1);
    expect(sessionPrincipal(t.w, s.token)).toBeNull();
    expect(t.w.residentOfPrincipal(principalId)).toBeDefined();
    expect(sessionPrincipal(t.w, '')).toBeNull();
    expect(sessionPrincipal(t.w, undefined)).toBeNull();
    expect(sessionPrincipal(t.w, null)).toBeNull();
  });

  it('重启之后票据和会话的状态保持（用过的票据仍然不能再用）', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const ticket = issueTicket(t.w, { provider: 'qq', subject: '9402', name: '小满' });
      const s = exchangeTicket(t.w, ticket.ticket);
      const fresh = issueTicket(t.w, { provider: 'qq', subject: '9403', name: '小乙' });
      t.advance(1000);
      restartFresh(t);
      expect(sessionPrincipal(t.w, s.token)).not.toBeNull();
      expect(catchErr(() => exchangeTicket(t.w, ticket.ticket)).code).toBe('unauthenticated');
      expect(() => exchangeTicket(t.w, fresh.ticket)).not.toThrow();
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('devLogin 关闭时 devLoginSession 被拒绝，也不会写入任何数据', () => {
    const w = createWorld({ dbPath: ':memory:', registry: createRegistry({}), devLogin: false, rng: new SeededRng('x') });
    w.startSync();
    const err = catchErr(() => devLoginSession(w, '阿灯'));
    expect(err.code).toBe('unauthenticated');
    expect(w.db.scalar('SELECT COUNT(*) FROM principals')).toBe(0);
    expect(w.db.scalar('SELECT COUNT(*) FROM sessions')).toBe(0);
    w.close();
  });

  it('devLogin 打开时：同名登录是同一主体；名字被清洗；空名字被拒绝', () => {
    const t = makeTown(); // helpers 里 devLogin: true
    const s1 = devLoginSession(t.w, '阿灯');
    const s2 = devLoginSession(t.w, '  阿灯 ');
    expect(s1.principal.principal_id).toBe(s2.principal.principal_id);
    expect(s1.principal.kind).toBe('human');
    expect(devLoginSession(t.w, '阿\n灯{@all}').principal.display_name).not.toMatch(/[\n]|\{@/);
    for (const bad of ['', '   ', undefined, null, '\u0007']) {
      expect(catchErr(() => devLoginSession(t.w, bad)).code).toBe('bad_request');
    }
  });

  it('devLogin 的会话进入后得到真人居民，不能借此注册成 AI', () => {
    const t = makeTown();
    const s = devLoginSession(t.w, '阿灯');
    const out = enterWorld(t.w, { principalId: s.principal.principal_id, clientId: 'web:dev1' }, { profile: { name: '阿灯' } });
    expect(t.w.mustResident(out.enter.residentId).kind).toBe('human');
  });
});
