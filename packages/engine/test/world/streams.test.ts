/**
 * 栖灯镇：可见事件流与游标。
 * 依据设计文档第 10 节「可见事件与 SSE 恢复」：游标不透明并绑定世界/居民/流类型；每位居民的游标连续；
 * 带游标续传不丢不重；事件保留 7 天，之后旧游标要求重同步；无游标从当前位置开始。
 */
import { describe, expect, it } from 'vitest';
import type { WorldService } from '../../src/world/service.js';
import { makeTown, type Actor, type Town } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const count = (w: WorldService, table: string, where = '1=1', ...p: (string | number)[]) => w.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, ...p);

const group = new WeakMap<Town, Actor[]>();

/** 阿灯和小岚在广场，小桔在茶馆。 */
function trio(): { t: Town; a: Actor; b: Actor; c: Actor } {
  const t = makeTown();
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  const c = t.join('小桔');
  c.go('tea_house');
  group.set(t, [a, b, c]);
  return { t, a, b, c };
}

/** 说一句话（先过 11 秒，避开发言限流；期间所有人保持心跳）。 */
function say(t: Town, who: Actor, text: string): Record<string, any> {
  t.advanceAlive(11_000, group.get(t)!.filter((x) => x.row().present_since !== null), 11_000);
  return who.act('speak', { text });
}

describe('游标：不透明并绑定世界、居民、流类型', () => {
  it('别人的游标、公开流的游标拿来当私有游标用：resync_required', () => {
    const { t, a, b } = trio();
    say(t, b, '造点事件');
    say(t, a, '再造点');
    const mine = t.w.cursorOf(a.residentId);
    const theirs = t.w.cursorOf(b.residentId);
    const pub = t.w.publicCursor();
    expect(t.w.readResidentEvents(a.residentId, mine).resync).toBe(false);
    expect(t.w.readResidentEvents(a.residentId, theirs).resync).toBe(true);
    expect(t.w.readResidentEvents(a.residentId, pub).resync).toBe(true);
    // 反过来：私有游标当公开游标用
    expect(t.w.readPublicEvents(pub).resync).toBe(false);
    expect(t.w.readPublicEvents(mine).resync).toBe(true);
  });

  it('伪造、篡改、乱写的游标：resync_required，并给出当前位置的新游标', () => {
    const { t, a, b } = trio();
    say(t, b, '造点事件');
    const good = t.w.cursorOf(a.residentId);
    const [head, mac] = good.split('.') as [string, string];
    const bad = [
      'garbage',
      `${head}.${'x'.repeat(mac.length)}`,
      `${head}.`,
      `.${mac}`,
      `r${(Number.parseInt(head.slice(1), 36) + 1).toString(36)}.${mac}`, // 改了位置没改签名
      `p${head.slice(1)}.${mac}`, // 改了流类型
      'r-1.abc',
      'r9999999999999999999999.abc',
      '   ',
    ];
    for (const c of bad) {
      const read = t.w.readResidentEvents(a.residentId, c);
      expect(read.resync, c).toBe(true);
      expect(read.events).toEqual([]);
      expect(read.cursor).toBe(good);
    }
  });

  it('另一个世界（另一个数据库）签发的游标无效', () => {
    const one = trio();
    const two = trio();
    say(one.t, one.a, '一号世界');
    say(two.t, two.a, '二号世界');
    const foreign = one.t.w.cursorOf(one.a.residentId);
    expect(two.t.w.readResidentEvents(two.a.residentId, foreign).resync).toBe(true);
    expect(two.t.w.readPublicEvents(one.t.w.publicCursor()).resync).toBe(true);
  });

  it('超出水位的游标（客户端拿着不存在的未来位置）：resync_required', () => {
    const { t, a } = trio();
    const head = t.w.streamHead(`r:${a.residentId}`).highWater;
    const future = t.w.encodeCursor('r', a.residentId, head + 5);
    expect(t.w.readResidentEvents(a.residentId, future).resync).toBe(true);
  });

  it('游标是不透明字符串：不含居民编号和原始序号', () => {
    const { t, a } = trio();
    say(t, a, '一条');
    const cur = t.w.cursorOf(a.residentId);
    expect(cur).toMatch(/^r[0-9a-z]+\.[\w-]+$/);
    expect(cur).not.toContain(a.residentId);
    expect(t.w.publicCursor()).toMatch(/^p[0-9a-z]+\.[\w-]+$/);
  });
});

describe('每位居民的游标连续', () => {
  it('别人的私密事件不造成本人的空档，也不改变本人的游标', () => {
    const { t, a, b, c } = trio();
    say(t, a, '广场上说话');
    const bBefore = t.w.cursorOf(b.residentId);
    const headBefore = t.w.streamHead(`r:${b.residentId}`).highWater;
    // 小桔在茶馆里的各种私密事件，小岚都听不到、收不到
    say(t, c, '茶馆里的悄悄话');
    c.act('update_profile', { bio: '我的简介' });
    c.act('send_letter', { to: a.residentId, body: '只有阿灯能收到的信' });
    expect(t.w.cursorOf(b.residentId)).toBe(bBefore);
    expect(t.w.streamHead(`r:${b.residentId}`).highWater).toBe(headBefore);
    // 本人的游标序号在库里是 1..n 连续的
    for (const x of [a, b, c]) {
      const rows = t.w.db.all('SELECT cursor FROM recipient_events WHERE resident_id = ? ORDER BY cursor', x.residentId).map((r) => Number(r.cursor));
      expect(rows).toEqual(rows.map((_, i) => i + 1));
      expect(t.w.streamHead(`r:${x.residentId}`).highWater).toBe(rows.length);
    }
  });

  it('同一居民读到的事件游标逐个加一', () => {
    const { t, a, b } = trio();
    const start = b.view().cursor;
    for (let i = 0; i < 6; i++) say(t, a, `第 ${i} 句`);
    const read = t.w.readResidentEvents(b.residentId, start);
    const nums = read.events.map((e) => Number.parseInt(e.id.slice(1, e.id.indexOf('.')), 36));
    expect(nums.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1]! + 1);
  });
});

describe('带游标续传与分页', () => {
  it('分页读取不丢不重，more 标记正确', () => {
    const { t, a, b } = trio();
    const start = t.w.cursorOf(b.residentId);
    for (let i = 0; i < 17; i++) {
      say(t, a, `第 ${i} 句`);
    }
    const all = t.w.readResidentEvents(b.residentId, start, 1000).events;
    expect(all.length).toBeGreaterThanOrEqual(17);
    const paged: string[] = [];
    let cursor = start;
    let pages = 0;
    for (;;) {
      const page = t.w.readResidentEvents(b.residentId, cursor, 5);
      pages++;
      expect(page.events.length).toBeLessThanOrEqual(5);
      paged.push(...page.events.map((e) => e.id));
      cursor = page.cursor;
      if (!page.more) break;
      expect(page.events.length).toBe(5);
    }
    expect(paged).toEqual(all.map((e) => e.id));
    expect(new Set(paged).size).toBe(paged.length);
    expect(pages).toBe(Math.ceil(all.length / 5));
    // 读到头再读：空，游标不变
    const tail = t.w.readResidentEvents(b.residentId, cursor, 5);
    expect(tail.events).toEqual([]);
    expect(tail.more).toBe(false);
    expect(tail.cursor).toBe(cursor);
    // 之后新事件只看到新的
    say(t, a, '新的一句');
    const fresh = t.w.readResidentEvents(b.residentId, cursor);
    expect(fresh.events.map((e) => e.type)).toEqual(['chat']);
  });

  it('limit 刚好等于事件数时 more 为 false', () => {
    const { t, a, b } = trio();
    const start = t.w.cursorOf(b.residentId);
    say(t, a, '一');
    const total = t.w.readResidentEvents(b.residentId, start, 100).events.length;
    expect(t.w.readResidentEvents(b.residentId, start, total).more).toBe(false);
    expect(t.w.readResidentEvents(b.residentId, start, total - 1).more).toBe(true);
  });

  it('公开流同样可以分页续传', () => {
    const { t, a, c } = trio();
    const start = t.w.publicCursor();
    for (let i = 0; i < 4; i++) a.go(i % 2 === 0 ? 'bookshop' : 'plaza');
    c.go('plaza');
    const all = t.w.readPublicEvents(start, 1000);
    expect(all.resync).toBe(false);
    expect(all.events.length).toBeGreaterThanOrEqual(4);
    const ids: string[] = [];
    let cursor = start;
    for (;;) {
      const page = t.w.readPublicEvents(cursor, 3);
      ids.push(...page.events.map((e) => e.id));
      cursor = page.cursor;
      if (!page.more) break;
    }
    expect(ids).toEqual(all.events.map((e) => e.id));
    expect(all.events.every((e) => ['place', 'resident_joined', 'public_event', 'activity', 'report'].includes(e.type))).toBe(true);
  });

  it('无游标 = 从当前位置开始：不回放历史', () => {
    const { t, a, b } = trio();
    say(t, a, '以前的话');
    for (const cursor of [undefined, null, '']) {
      const r = t.w.readResidentEvents(b.residentId, cursor);
      expect(r.events).toEqual([]);
      expect(r.resync).toBe(false);
      expect(r.more).toBe(false);
      expect(r.cursor).toBe(t.w.cursorOf(b.residentId));
      const p = t.w.readPublicEvents(cursor);
      expect(p.events).toEqual([]);
      expect(p.resync).toBe(false);
      expect(p.cursor).toBe(t.w.publicCursor());
    }
    // 用返回的游标接着读，能收到之后的事件
    const first = t.w.readResidentEvents(b.residentId, undefined);
    say(t, a, '之后的话');
    expect(t.w.readResidentEvents(b.residentId, first.cursor).events.map((e) => e.data.text)).toEqual(['之后的话']);
  });

  it('事件内容：只有本人能收到自己的私有事件', () => {
    const { t, a, b, c } = trio();
    const cb = t.w.cursorOf(b.residentId);
    const cc = t.w.cursorOf(c.residentId);
    a.act('send_letter', { to: b.residentId, body: '私密的信：金库密码 ~9527~' });
    t.advance(2 * MIN);
    t.advanceAlive(0, []);
    const mine = t.w.readResidentEvents(b.residentId, cb).events;
    const others = t.w.readResidentEvents(c.residentId, cc).events;
    expect(mine.some((e) => e.type === 'mail')).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('~9527~');
    expect(JSON.stringify(others)).not.toContain('~9527~');
    expect(others.some((e) => e.type === 'mail')).toBe(false);
    expect(JSON.stringify(t.w.readPublicEvents(undefined, 100))).not.toContain('~9527~');
  });
});

describe('事件保留 7 天', () => {
  it('过期事件被裁剪：旧游标 resync_required，新游标正常，水位不重置', () => {
    const { t, a, b, c } = trio();
    // 第 0 天：造一批事件
    const beforeAll = t.w.cursorOf(b.residentId);
    const pubBefore = t.w.publicCursor();
    for (let i = 0; i < 4; i++) say(t, a, `旧事件 ${i}`);
    c.go('plaza'); // 公开流里也要有旧事件
    const afterBatch = t.w.cursorOf(b.residentId);
    const high0 = t.w.streamHead(`r:${b.residentId}`).highWater;
    // 过 5 天：再来一批（还在保留期内）
    t.advance(5 * DAY);
    b.enter();
    a.enter();
    say(t, a, '中间事件');
    const midCursor = t.w.cursorOf(b.residentId);
    // 再过 3 天（共 8 天）：第一批超过 7 天被裁剪
    t.advance(3 * DAY);
    const head = t.w.streamHead(`r:${b.residentId}`);
    expect(head.retainedFrom).toBeGreaterThan(1);
    expect(head.highWater).toBeGreaterThanOrEqual(high0);
    expect(count(t.w, 'recipient_events', "resident_id = ? AND created_at < ?", b.residentId, t.clock.t - 7 * DAY)).toBe(0);
    // 旧游标：被裁剪的区间有空档 → 重同步，给一个新的位置
    const stale = t.w.readResidentEvents(b.residentId, beforeAll);
    expect(stale.resync).toBe(true);
    expect(stale.events).toEqual([]);
    expect(t.w.readPublicEvents(pubBefore).resync).toBe(true);
    // 已经看到被裁剪区间末尾的游标没有丢事件，仍然有效
    expect(t.w.readResidentEvents(b.residentId, afterBatch).resync).toBe(false);
    // 中间那批没被裁掉：游标没有空档，正常续传
    const ok = t.w.readResidentEvents(b.residentId, midCursor);
    expect(ok.resync).toBe(false);
    // 用重同步给的新游标：正常
    const fresh = stale.cursor;
    expect(t.w.readResidentEvents(b.residentId, fresh).resync).toBe(false);
    b.enter();
    a.enter();
    say(t, a, '裁剪之后的新事件');
    const after = t.w.readResidentEvents(b.residentId, fresh);
    expect(after.resync).toBe(false);
    expect(after.events.some((e) => e.data.text === '裁剪之后的新事件')).toBe(true);
    // 水位不重置：新事件的序号接着旧的往下数
    const lastNum = Number.parseInt(after.events.at(-1)!.id.slice(1, after.events.at(-1)!.id.indexOf('.')), 36);
    expect(lastNum).toBe(t.w.streamHead(`r:${b.residentId}`).highWater);
    expect(lastNum).toBeGreaterThan(high0);
  });

  it('刚好看完被裁剪区间最后一条事件的游标仍然有效（没有空档），再早一条就要重同步', () => {
    const { t, a, b } = trio();
    for (let i = 0; i < 3; i++) say(t, a, `甲 ${i}`);
    t.advance(6 * DAY);
    b.enter();
    a.enter();
    say(t, a, '乙');
    t.advance(2 * DAY);
    const { retainedFrom, highWater } = t.w.streamHead(`r:${b.residentId}`);
    expect(retainedFrom).toBeGreaterThan(2);
    const at = (n: number) => t.w.encodeCursor('r', b.residentId, n);
    expect(t.w.readResidentEvents(b.residentId, at(retainedFrom - 1)).resync).toBe(false);
    expect(t.w.readResidentEvents(b.residentId, at(retainedFrom - 2)).resync).toBe(true);
    expect(t.w.readResidentEvents(b.residentId, at(0)).resync).toBe(true);
    expect(t.w.readResidentEvents(b.residentId, at(highWater)).resync).toBe(false);
  });

  it('全部事件都被裁剪后：持有最新游标的客户端仍然正常', () => {
    const { t, a, b } = trio();
    say(t, a, '唯一的一批');
    t.advance(1000);
    const cursor = t.w.cursorOf(b.residentId);
    t.advance(10 * DAY);
    expect(count(t.w, 'recipient_events', 'resident_id = ?', b.residentId)).toBeGreaterThanOrEqual(0);
    const head = t.w.streamHead(`r:${b.residentId}`);
    const read = t.w.readResidentEvents(b.residentId, t.w.encodeCursor('r', b.residentId, head.highWater));
    expect(read.resync).toBe(false);
    expect(typeof cursor).toBe('string');
  });
});

describe('waitResident', () => {
  it('有事件：返回 event，醒来时事件已可读', async () => {
    const { t, a, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    const p = t.w.waitResident(b.residentId, cur, undefined, 5000);
    say(t, a, '有人说话');
    expect(await p).toBe('event');
    expect(t.w.readResidentEvents(b.residentId, cur).events.some((e) => e.type === 'chat')).toBe(true);
  });

  it('游标之前已有事件：立即返回 event（先登记监听再复查，不漏）', async () => {
    const { t, a, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    say(t, a, '先发生');
    expect(await t.w.waitResident(b.residentId, cur, undefined, 5000)).toBe('event');
  });

  it('游标已经是最新、没有变化：超时返回 timeout；maxMs 为 0 立即 timeout', async () => {
    const { t, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    const t0 = Date.now();
    expect(await t.w.waitResident(b.residentId, cur, undefined, 40)).toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(await t.w.waitResident(b.residentId, cur, undefined, 0)).toBe('timeout');
    expect(await t.w.waitResident(b.residentId, cur, undefined, -5)).toBe('timeout');
  });

  it('心跳不产生事件，不会唤醒等待者', async () => {
    const { t, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    const p = t.w.waitResident(b.residentId, cur, undefined, 60);
    b.heartbeat();
    expect(await p).toBe('timeout');
  });

  it('上下文变化：返回 context（立即不符、等待中变化、居民不存在）', async () => {
    const { t, a, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    const v = b.row().context_version;
    expect(await t.w.waitResident(b.residentId, cur, v + 1, 5000)).toBe('context');
    expect(await t.w.waitResident('r_nobody', cur, undefined, 5000)).toBe('context');
    // 等待中上下文版本变化（进入一局游戏会这样）：同一个事务里递增版本并给本人一条事件
    const p = t.w.waitResident(b.residentId, cur, v, 5000);
    t.w.commit(() => {
      const r = t.w.mustResident(b.residentId);
      r.context_version += 1;
      t.w.saveResident(r);
      t.w.emitTo([b.residentId], 'notice', { text: '上下文变了' });
    });
    expect(await p).toBe('context');
    void a;
  });

  it('abort：返回 timeout 且清掉监听；已经 abort 的信号立即返回', async () => {
    const { t, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    const ac = new AbortController();
    const p = t.w.waitResident(b.residentId, cur, undefined, 10_000, ac.signal);
    ac.abort();
    expect(await p).toBe('timeout');
    // 已经 abort 的信号：不等到 maxMs
    const done = await Promise.race([t.w.waitResident(b.residentId, cur, undefined, 10_000, ac.signal), new Promise((r) => setTimeout(() => r('hung'), 300))]);
    expect(done).toBe('timeout');
    // 监听器没有泄漏
    expect(t.w['emitter' as keyof typeof t.w]).toBeDefined();
    const emitter = (t.w as unknown as { emitter: { listenerCount(n: string): number } }).emitter;
    expect(emitter.listenerCount(`r:${b.residentId}`)).toBe(0);
  });

  it('不带游标：从调用这一刻开始等，新事件会唤醒', async () => {
    const { t, a, b } = trio();
    say(t, a, '调用之前的事件');
    const p = t.w.waitResident(b.residentId, undefined, undefined, 5000);
    say(t, a, '调用之后的事件');
    expect(await p).toBe('event');
    expect(await t.w.waitResident(b.residentId, undefined, undefined, 30)).toBe('timeout');
  });

  it('无效游标：立即 event（调用方随后读到 resync）', async () => {
    const { t, b } = trio();
    expect(await t.w.waitResident(b.residentId, 'garbage', undefined, 5000)).toBe('event');
    expect(t.w.readResidentEvents(b.residentId, 'garbage').resync).toBe(true);
  });

  it('等待者拿别人的游标不会被别人的事件唤醒', async () => {
    const { t, a, b } = trio();
    const cur = t.w.cursorOf(b.residentId);
    const p = t.w.waitResident(b.residentId, cur, undefined, 60);
    t.w.emitTo([a.residentId], 'notice', { text: '只给阿灯' }); // 事务外直接写：不会 flush，也不属于小岚
    expect(await p).toBe('timeout');
  });
});

describe('订阅者', () => {
  it('取消订阅后不再收到唤醒；公开流订阅者只在公开事件时被唤醒', () => {
    const { t, a, b } = trio();
    let r = 0;
    let p = 0;
    const offR = t.w.onResident(b.residentId, () => r++);
    const offP = t.w.onPublic(() => p++);
    say(t, a, '一');
    expect(r).toBe(1);
    expect(p).toBe(0); // 现场发言不进公开流
    a.go('bookshop');
    expect(p).toBeGreaterThanOrEqual(1);
    const rAfterMove = r;
    const pAfterMove = p;
    offR();
    offP();
    a.go('plaza');
    say(t, b, '二');
    expect(r).toBe(rAfterMove);
    expect(p).toBe(pAfterMove);
  });

  it('revokeStreams 通知该居民的撤销订阅者；显式离开会触发', () => {
    const { t, a } = trio();
    let revoked = 0;
    t.w.onRevoke(a.residentId, () => revoked++);
    a.leave();
    expect(revoked).toBe(1);
  });
});
