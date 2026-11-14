/**
 * 栖灯镇：日报、回顾、保留期裁剪、对外公告（outbox）、世界时区的日历计算。
 * 依据设计文档第 6 节「每日事件与日报」、第 11 节「UTC 与现实时间任务」、第 14 节「长期存储与删除」。
 */
import { describe, expect, it } from 'vitest';
import { outboxAck, outboxPending, recap, report } from '../../src/world/reports.js';
import type { WorldService } from '../../src/world/service.js';
import { businessDate, localClock, localParts, localToUtc, nextDate } from '../../src/world/time.js';
import { chatHistory } from '../../src/world/views.js';
import { FakeClock } from '../helpers.js';
import { KEEPER, makeTown, type Actor, type Town } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const count = (w: WorldService, table: string, where = '1=1', ...p: (string | number)[]) => w.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, ...p);

const SECRET = '机密-9527-不得外泄';

/** 阿灯、小岚、小桔：阿灯和小岚在茶馆一起喝过茶（公开事实）；阿灯和小桔之间有私密往来。返回的是第 0 天。 */
function scenario() {
  const t = makeTown();
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  const c = t.join('小桔');
  a.go(KEEPER);
  b.go('tea_house');
  a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 1 });
  const table = a.view().here!.objects.find((o) => o.type === 'tea_table')!;
  a.go(table.id);
  b.go(table.id);
  const ix = a.act('start_interaction', { objectId: table.id });
  b.act('join_interaction', { interactionId: ix.interaction.id });
  a.act('begin_interaction', { interactionId: ix.interaction.id });
  t.advanceAlive(10 * MIN + 1000, [a, b, c]);
  // 合成几条事实：私密的（带机密字符串）、公开事实里夹带机密字段、未知类型的公开事实
  t.w.commit(() => {
    t.w.fact('gift_accepted', [{ id: a.residentId, role: 'giver' }, { id: c.residentId, role: 'receiver' }], { give: `${SECRET}（私密赠礼）` });
    t.w.fact('letter_sent', [{ id: a.residentId, role: 'sender' }, { id: c.residentId, role: 'recipient' }], { note: SECRET });
    t.w.fact('interaction_completed', [{ id: a.residentId, role: 'self' }], { space: 'tea_house', interaction: 'share_tea', name: '一起喝茶', secret: SECRET }, { visibility: 'public' });
    t.w.fact('interaction_completed', [{ id: a.residentId, role: 'self' }], { space: 'tea_house', interaction: 'share_tea', name: SECRET }, { visibility: 'private' });
    t.w.fact('custom_unknown_type', [{ id: b.residentId, role: 'self' }], { text: SECRET }, { visibility: 'public' });
    t.w.fact('game_completed', [{ id: b.residentId, role: 'winner' }], { name: '数字炸弹', secret: SECRET }, { visibility: 'public' });
  });
  const day0 = t.w.today();
  return { t, a, b, c, day0 };
}

/** 保持三人在场推进到第二天的凌晨（让换日任务跑一遍）。 */
function toNextDay(t: Town, day0: string, who: Actor[]): void {
  const target = localToUtc(t.w.params.timezone, nextDate(day0), 0, 10);
  while (t.clock.t < target) t.advanceAlive(Math.min(target - t.clock.t, 20 * MIN), who, 20_000);
  t.w.tick();
}

describe('公开日报：只含公开事实的聚合句子', () => {
  it('不出现私密事实、不出现事实里夹带的机密字符串；有聚合句子', () => {
    const { t, a, b, c, day0 } = scenario();
    toNextDay(t, day0, [a, b, c]);
    const pub = report(t.w, 'public', day0, t.clock.t);
    expect(pub.final).toBe(true);
    expect(pub.scope).toBe('public');
    const text = pub.lines.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('机密');
    // 聚合：真实的一次 + 合成的一次公开喝茶 = 2 次；私密的那次（在家里）不计
    expect(text).toContain('栖灯茶馆里有 2 次一起喝茶。');
    expect(text).toContain('镇上打完了 1 局小游戏。');
    expect(text).toMatch(/新来了 3 位居民/);
    // 句子里不写人名对人名的关系（公开日报只写聚合）
    expect(text).not.toMatch(/和.*一起/);
  });

  it('走来走去（路过灯笼路、进出私宅）不进日报：没有路、坐标、路线，也没有谁家', () => {
    const { t, a, b, c, day0 } = scenario();
    // 走一圈：茶馆 -> 花园 -> 回家 -> 会馆；路过灯笼路，进出私宅
    a.go('garden');
    a.go('home');
    a.go('residential');
    b.go('bookshop');
    for (const x of [a, b, c]) x.enter(); // 走动期间别人的在场租约可能过期，重新登记
    toNextDay(t, day0, [a, b, c]);
    for (const scope of ['public', { residentId: a.residentId }, { residentId: b.residentId }] as const) {
      const text = report(t.w, scope, day0, t.clock.t).lines.join('\n');
      expect(text).not.toContain('灯笼路');
      expect(text).not.toMatch(/road|home:|坐标|路线|\d+\.\d+/);
      expect(text).not.toContain(a.residentId);
    }
    const day0Start = t.clock.t - 3 * DAY;
    const recapText = JSON.stringify(recap(t.w, a.residentId, day0Start, t.clock.t));
    expect(recapText).not.toContain('灯笼路');
    expect(recapText).not.toMatch(/"(x|z)":/);
  });

  it('个人日报只来自本人是当事人的事实', () => {
    const { t, a, b, c, day0 } = scenario();
    toNextDay(t, day0, [a, b, c]);
    const rc = report(t.w, { residentId: c.residentId }, day0, t.clock.t).lines.join('\n');
    const ra = report(t.w, { residentId: a.residentId }, day0, t.clock.t).lines.join('\n');
    const rb = report(t.w, { residentId: b.residentId }, day0, t.clock.t).lines.join('\n');
    // 小桔只是赠礼的收件方和信的收件人：看得到赠礼，看不到阿灯和小岚喝茶
    expect(rc).toContain('收到阿灯送的');
    expect(rc).not.toContain('喝茶');
    expect(rc).not.toContain('小岚');
    // 阿灯的个人日报有喝茶和送礼
    expect(ra).toContain('和小岚一起喝茶');
    expect(ra).toContain('送给小桔');
    // 小岚看不到阿灯和小桔之间的事
    expect(rb).not.toContain('小桔');
    expect(rb).not.toContain(SECRET);
    // 小桔的日报不含任何别人的信件细节
    expect(rc).not.toContain('寄了信');
  });

  it('没有任何事时给一句安静的话', () => {
    const t = makeTown();
    t.join('阿灯');
    t.advance(2 * DAY);
    const lines = report(t.w, 'public', nextDate(t.w.today(), -1), t.clock.t).lines;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // 一次跳过多天时，中间的日子补记了「错过」的事件，日报写「没有举行」而不是安静的话（审计 31）
    expect(lines.some((l) => l.includes('安安静静') || l.includes('这天没有举行'))).toBe(true);
  });
});

describe('日报只生成一次', () => {
  it('换日任务生成昨天的公开日报和有记录者的个人日报，各一份', () => {
    const { t, a, b, c, day0 } = scenario();
    toNextDay(t, day0, [a, b, c]);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", day0)).toBe(1);
    expect(count(t.w, 'daily_reports', "scope = ? AND business_date = ?", `r:${a.residentId}`, day0)).toBe(1);
    expect(count(t.w, 'daily_reports', "scope = ? AND business_date = ?", `r:${c.residentId}`, day0)).toBe(1);
    expect(count(t.w, 'public_events', "type = 'report'")).toBe(1);
    expect(count(t.w, 'notification_outbox', 'dedupe_key = ?', `report:${day0}`)).toBe(1);
  });

  it('重复换日（重复触发钩子、重复跑任务处理器）不重复生成', () => {
    const { t, a, b, c, day0 } = scenario();
    toNextDay(t, day0, [a, b, c]);
    const snapshot = () => [count(t.w, 'daily_reports'), count(t.w, 'public_events', "type = 'report'"), count(t.w, 'notification_outbox'), count(t.w, 'business_keys', "key LIKE 'newday:%'")];
    const before = snapshot();
    for (let i = 0; i < 3; i++) {
      t.w.commit(() => {
        for (const h of t.w.hooks.newDay) h(t.w.today(), t.clock.t);
      });
      t.w.commit(() => t.w.jobHandlers.get('daily_rollover')!({}, { job_id: 0, dedupe_key: 'x', due_at: t.clock.t, kind: 'daily_rollover', payload: '{}', attempts: 0 }, t.clock.t));
    }
    expect(snapshot()).toEqual(before);
  });

  it('final 标记：过完的世界日是 final 且内容固定；今天是「到目前为止」，不入库', () => {
    const { t, a, b, c, day0 } = scenario();
    const today0 = report(t.w, 'public', day0, t.clock.t);
    expect(today0.final).toBe(false);
    expect(count(t.w, 'daily_reports')).toBe(0);
    toNextDay(t, day0, [a, b, c]);
    const first = report(t.w, 'public', day0, t.clock.t);
    expect(first.final).toBe(true);
    // 事后补进来一条属于那一天的公开事实，也不会改变已经定稿的日报
    t.w.commit(() => {
      t.w.fact('game_completed', [{ id: a.residentId, role: 'winner' }], { name: '数字炸弹' }, { visibility: 'public', occurredAt: t.clock.t - 20 * HOUR });
    });
    const second = report(t.w, 'public', day0, t.clock.t);
    expect(second.lines).toEqual(first.lines);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", day0)).toBe(1);
    // 新的一天没有结束，不是 final
    const today = report(t.w, 'public', t.w.today(), t.clock.t);
    expect(today.final).toBe(false);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", t.w.today())).toBe(0);
  });

  it('按需生成过去某天的日报：生成一次后复用', () => {
    const { t } = scenario();
    t.advance(5 * DAY);
    const old = nextDate(t.w.today(), -3);
    const x = report(t.w, 'public', old, t.clock.t);
    const y = report(t.w, 'public', old, t.clock.t);
    expect(x.final).toBe(true);
    expect(y.lines).toEqual(x.lines);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", old)).toBe(1);
  });

  it('公开日报里的公共事件：missed / closed 分别用固定句式', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const day0 = t.w.today();
    // 花园整理 12:30–13:00：在场推进过去，没人参加 → 安静结束
    const open = t.w.db.get("SELECT opens_at, closes_at FROM public_event_instances WHERE def_id = 'garden_care' AND business_date = ?", day0)!;
    t.advanceAlive(Number(open.closes_at) + MIN - t.clock.t, [a]);
    toNextDay(t, day0, [a]);
    const lines = report(t.w, 'public', day0, t.clock.t).lines.join('\n');
    expect(lines).toContain('「花园整理」：午间的花园整理安静地过去了。');
  });
});

describe('回顾 recap', () => {
  it('只含发给本人的通知、信箱提示和昨天的公开日报；不含别人的私密内容', () => {
    const { t, a, b, c, day0 } = scenario();
    const since = t.clock.t;
    // 小桔离开；阿灯给小桔写信；小桔收不到别人的通知
    c.leave();
    t.advanceAlive(30_000, [a, b]);
    a.act('send_letter', { to: c.residentId, body: `信里有${SECRET}` });
    t.w.commit(() => {
      t.w.emitTo([c.residentId], 'notice', { text: '给小桔的提示' });
      t.w.emitTo([b.residentId], 'notice', { text: '只给小岚的提示' });
      t.w.emitTo([c.residentId], 'goal', { goal: { title: '半截愿望' }, completed: false });
      t.w.emitTo([c.residentId], 'goal', { goal: { title: '做成的愿望' }, completed: true });
    });
    t.advanceAlive(2 * MIN, [a, b]);
    const r = recap(t.w, c.residentId, since, t.clock.t);
    const text = r.lines.join('\n');
    expect(text).toContain('信箱里有 1 封没读的信。');
    expect(text).toContain('给小桔的提示');
    expect(text).toContain('完成了愿望「做成的愿望」');
    expect(text).not.toContain('半截愿望');
    expect(text).not.toContain('只给小岚的提示');
    expect(text).not.toContain(SECRET);
    expect(r.since).toBe(since);
    void day0;
    void a;
  });

  it('跨了世界日：附上昨天的公开日报；最多 20 行；去重', () => {
    const { t, a, b, c, day0 } = scenario();
    const since = t.clock.t;
    toNextDay(t, day0, [a, b, c]);
    t.w.commit(() => {
      for (let i = 0; i < 30; i++) t.w.emitTo([a.residentId], 'notice', { text: `提示 ${i}` }, t.clock.t);
      t.w.emitTo([a.residentId], 'notice', { text: '提示 29' }, t.clock.t);
    });
    const r = recap(t.w, a.residentId, since, t.clock.t);
    expect(r.lines.length).toBeLessThanOrEqual(20);
    expect(r.lines.filter((l) => l === '提示 29').length).toBe(1);
    expect(r.lines.some((l) => l.startsWith('昨天：'))).toBe(true);
    expect(r.lines.join('\n')).not.toContain(SECRET);
  });

  it('同一天里没有「昨天」行', () => {
    const { t, a } = scenario();
    const r = recap(t.w, a.residentId, t.clock.t - HOUR, t.clock.t);
    expect(r.lines.some((l) => l.startsWith('昨天：'))).toBe(false);
  });
});

describe('保留期裁剪', () => {
  it('聊天正文 30 天：29 天还在，超过后连受众记录一起删除', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '三十天后就看不到了' });
    expect(chatHistory(t.w, b.residentId, null, 10).messages.length).toBe(1);
    t.advance(29 * DAY);
    expect(count(t.w, 'chat_messages')).toBe(1);
    t.advance(2 * DAY);
    expect(count(t.w, 'chat_messages')).toBe(0);
    expect(count(t.w, 'chat_audience')).toBe(0);
    expect(chatHistory(t.w, b.residentId, null, 10).messages).toEqual([]);
  });

  it('结构化事实 35 天；已经生成的日报不受影响', () => {
    const { t, a, b, c, day0 } = scenario();
    toNextDay(t, day0, [a, b, c]);
    const first = report(t.w, { residentId: a.residentId }, day0, t.clock.t);
    expect(count(t.w, 'world_events')).toBeGreaterThan(0);
    t.advance(30 * DAY);
    expect(count(t.w, 'world_events')).toBeGreaterThan(0);
    t.advance(6 * DAY);
    expect(count(t.w, 'world_events')).toBe(0);
    expect(count(t.w, 'event_parties')).toBe(0);
    const again = report(t.w, { residentId: a.residentId }, day0, t.clock.t);
    expect(again.lines).toEqual(first.lines);
    expect(again.final).toBe(true);
  });

  it('裁剪不重置水位：事件游标和公开游标继续往后数', () => {
    const { t, a, b, c } = scenario();
    const privHigh = t.w.streamHead(`r:${a.residentId}`).highWater;
    const pubHigh = t.w.streamHead(`pub:${t.w.worldId}`).highWater;
    expect(privHigh).toBeGreaterThan(0);
    t.advance(10 * DAY);
    const h1 = t.w.streamHead(`r:${a.residentId}`);
    const h2 = t.w.streamHead(`pub:${t.w.worldId}`);
    expect(h1.highWater).toBeGreaterThanOrEqual(privHigh);
    expect(h1.retainedFrom).toBeGreaterThan(1);
    expect(h2.highWater).toBeGreaterThanOrEqual(pubHigh);
    a.enter();
    b.enter();
    c.enter();
    const next = t.w.streamHead(`r:${a.residentId}`).highWater;
    expect(next).toBeGreaterThan(h1.highWater);
    expect(t.w.metrics.pruned).toBeGreaterThan(0);
  });

  it('过期的会话、票据、完成很久的任务、过期情绪被清理', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const sessions = count(t.w, 'sessions');
    const tickets = count(t.w, 'login_tickets');
    expect(sessions).toBe(1);
    expect(tickets).toBe(1);
    t.advance(40 * DAY);
    a.enter();
    expect(count(t.w, 'sessions')).toBe(0);
    expect(count(t.w, 'login_tickets')).toBe(0);
    expect(count(t.w, 'scheduled_jobs', "status = 'done' AND processed_at < ?", t.clock.t - 7 * DAY)).toBe(0);
  });

  it('日报只在换日时清理一次，不会每个 tick 都清理', () => {
    const t = makeTown();
    t.join('阿灯');
    t.advance(2 * DAY);
    const pruned = t.w.metrics.pruned;
    for (let i = 0; i < 5; i++) t.advance(1000);
    expect(t.w.metrics.pruned).toBe(pruned);
  });
});

describe('outbox：对外公告', () => {
  it('至少一次投递：没确认的公告每次都会再出现，确认后不再出现', () => {
    const { t, a, b, c, day0 } = scenario();
    toNextDay(t, day0, [a, b, c]);
    const first = outboxPending(t.w);
    const daily = first.find((n) => n.payload.kind === 'daily_report')!;
    expect(daily).toBeDefined();
    expect(daily.kind).toBe('announce');
    expect(String(daily.payload.text)).not.toContain(SECRET);
    expect(String(daily.payload.title)).toContain(day0);
    // 没有确认：再取一次还在
    expect(outboxPending(t.w).map((n) => n.id)).toEqual(first.map((n) => n.id));
    // 确认
    expect(outboxAck(t.w, [daily.id])).toBe(1);
    expect(outboxPending(t.w).some((n) => n.id === daily.id)).toBe(false);
    // 重复确认、确认不存在的编号：不出错，计数为 0
    expect(outboxAck(t.w, [daily.id, 999999])).toBe(0);
    expect(outboxAck(t.w, [])).toBe(0);
  });

  it('取数量有上下界（至少 1，至多 50），按编号先进先出', () => {
    const t = makeTown();
    t.w.commit(() => {
      for (let i = 0; i < 60; i++) t.w.db.run('INSERT INTO notification_outbox(dedupe_key, destination, payload, created_at) VALUES (?,?,?,?)', `k${i}`, 'announce', JSON.stringify({ n: i }), t.clock.t);
    });
    expect(outboxPending(t.w, 0).length).toBe(1);
    expect(outboxPending(t.w, -3).length).toBe(1);
    expect(outboxPending(t.w, 1000).length).toBe(50);
    const ids = outboxPending(t.w, 10).map((n) => n.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(outboxPending(t.w, 10).map((n) => n.payload.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('公共事件开场产生一条公告，同一事件不重复', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const day0 = t.w.today();
    const open = Number(t.w.db.get("SELECT opens_at FROM public_event_instances WHERE def_id = 'garden_care' AND business_date = ?", day0)!.opens_at);
    t.advanceAlive(open + MIN - t.clock.t, [a]);
    const events = outboxPending(t.w).filter((n) => n.payload.kind === 'public_event');
    expect(events.length).toBe(1);
    expect(events[0]!.payload.title).toBe('花园整理');
    t.w.tick();
    t.advance(MIN);
    expect(outboxPending(t.w).filter((n) => n.payload.kind === 'public_event').length).toBe(1);
  });

  it('确认过的公告 7 天后清理；没人取走的公告 2 天后清理', () => {
    const t = makeTown();
    t.join('阿灯');
    t.w.commit(() => {
      t.w.db.run('INSERT INTO notification_outbox(dedupe_key, destination, payload, created_at, sent_at) VALUES (?,?,?,?,?)', 'sent-old', 'announce', '{}', t.clock.t, t.clock.t);
      t.w.db.run('INSERT INTO notification_outbox(dedupe_key, destination, payload, created_at) VALUES (?,?,?,?)', 'unsent-old', 'announce', '{}', t.clock.t);
    });
    t.advance(3 * DAY);
    expect(count(t.w, 'notification_outbox', "dedupe_key = 'unsent-old'")).toBe(0);
    expect(count(t.w, 'notification_outbox', "dedupe_key = 'sent-old'")).toBe(1);
    t.advance(5 * DAY);
    expect(count(t.w, 'notification_outbox', "dedupe_key = 'sent-old'")).toBe(0);
  });
});

describe('时间与时区', () => {
  it('localParts / businessDate / localClock：东京与 UTC 的日历差异', () => {
    const at = Date.UTC(2024, 0, 31, 16, 30, 15); // 东京 2024-02-01 01:30:15（周四）
    expect(businessDate('UTC', at)).toBe('2024-01-31');
    expect(businessDate('Asia/Tokyo', at)).toBe('2024-02-01');
    expect(localClock('Asia/Tokyo', at)).toBe('01:30');
    expect(localParts('Asia/Tokyo', at)).toMatchObject({ date: '2024-02-01', hour: 1, minute: 30, second: 15, weekday: 4 });
    // 午夜是 00 点而不是 24 点
    expect(localParts('Asia/Tokyo', Date.UTC(2024, 0, 31, 15, 0, 0)).hour).toBe(0);
  });

  it('nextDate：跨月、跨年、闰年、向前', () => {
    expect(nextDate('2024-01-31')).toBe('2024-02-01');
    expect(nextDate('2023-12-31')).toBe('2024-01-01');
    expect(nextDate('2024-02-28')).toBe('2024-02-29');
    expect(nextDate('2023-02-28')).toBe('2023-03-01');
    expect(nextDate('2024-03-01', -1)).toBe('2024-02-29');
    expect(nextDate('2024-03-01', -30)).toBe('2024-01-31');
  });

  it('localToUtc：固定偏移的时区', () => {
    expect(localToUtc('Asia/Tokyo', '2024-02-01', 0, 0)).toBe(Date.UTC(2024, 0, 31, 15, 0, 0));
    expect(localToUtc('Asia/Tokyo', '2024-02-01', 12, 30)).toBe(Date.UTC(2024, 1, 1, 3, 30, 0));
    expect(localToUtc('UTC', '2024-02-01', 7, 5)).toBe(Date.UTC(2024, 1, 1, 7, 5, 0));
    // 往返
    for (const tz of ['Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
      const t = localToUtc(tz, '2024-06-15', 9, 45);
      expect(localParts(tz, t)).toMatchObject({ date: '2024-06-15', hour: 9, minute: 45 });
    }
  });

  it('夏令时：跳过的钟点落到跳过之后；重复的钟点取第一次', () => {
    // 纽约 2024-03-10 02:00 跳到 03:00（UTC-5 → UTC-4）
    const skipped = localToUtc('America/New_York', '2024-03-10', 2, 30);
    expect(localParts('America/New_York', skipped)).toMatchObject({ date: '2024-03-10', hour: 3 });
    // 纽约 2024-11-03 01:30 出现两次，取第一次（UTC-4，即 05:30Z）
    expect(localToUtc('America/New_York', '2024-11-03', 1, 30)).toBe(Date.UTC(2024, 10, 3, 5, 30, 0));
    // 一天的长度：夏令时开始那天 23 小时，结束那天 25 小时
    expect(localToUtc('America/New_York', '2024-03-11', 0, 0) - localToUtc('America/New_York', '2024-03-10', 0, 0)).toBe(23 * HOUR);
    expect(localToUtc('America/New_York', '2024-11-04', 0, 0) - localToUtc('America/New_York', '2024-11-03', 0, 0)).toBe(25 * HOUR);
  });

  it('世界时区是纽约：换日任务落在当地午夜之后，夏令时当天各结算一次', () => {
    const clock = new FakeClock();
    clock.t = Date.UTC(2024, 2, 9, 12, 0, 0); // 纽约 2024-03-09 07:00
    const t = makeTown({ clock, params: { timezone: 'America/New_York' } });
    t.join('阿灯');
    expect(t.w.today()).toBe('2024-03-09');
    const delay = t.w.params.dailyReportDelayMs;
    const pending = () => t.w.db.all("SELECT dedupe_key, due_at FROM scheduled_jobs WHERE kind = 'daily_rollover' AND status = 'pending'");
    expect(pending().map((j) => [j.dedupe_key, j.due_at])).toEqual([['rollover:2024-03-10', localToUtc('America/New_York', '2024-03-10', 0, 0) + delay]]);
    // 推进到夏令时开始那天的中午：恰好换过一次日
    t.advance(30 * HOUR);
    expect(t.w.today()).toBe('2024-03-10');
    expect(count(t.w, 'scheduled_jobs', "kind = 'daily_rollover' AND status = 'done'")).toBe(1);
    expect(pending().map((j) => j.dedupe_key)).toEqual(['rollover:2024-03-11']);
    expect(pending()[0]!.due_at).toBe(localToUtc('America/New_York', '2024-03-11', 0, 0) + delay);
    // 23 小时的那一天结束后再换一次日
    t.advance(DAY);
    expect(t.w.today()).toBe('2024-03-11');
    expect(count(t.w, 'scheduled_jobs', "kind = 'daily_rollover' AND status = 'done'")).toBe(2);
  });

  it('所有持久时间都是 UTC 毫秒：时间戳不随世界时区变化', () => {
    const tokyo = makeTown({ params: { timezone: 'Asia/Tokyo' } });
    const ny = makeTown({ params: { timezone: 'America/New_York' } });
    const a = tokyo.join('阿灯');
    const b = ny.join('阿灯');
    expect(a.row().created_at).toBe(b.row().created_at);
    expect(tokyo.w.today()).not.toBe(ny.w.today());
  });
});
