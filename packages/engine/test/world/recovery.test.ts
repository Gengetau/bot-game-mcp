/**
 * 栖灯镇：启动恢复、崩溃一致性、degraded、备份与 schema。
 * 依据设计文档第 8、9、11、14、15 节。用临时目录里的真实文件数据库。
 */
import { existsSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SeededRng } from '../../src/core/rng.js';
import { TownDb, verifyBackup, SCHEMA_VERSION } from '../../src/world/db.js';
import { createRegistry } from '../../src/games/index.js';
import { WorldError } from '../../src/world/errors.js';
import { heartbeat } from '../../src/world/identity.js';
import { createWorld, enterWorld } from '../../src/world/index.js';
import { report } from '../../src/world/reports.js';
import type { WorldService } from '../../src/world/service.js';
import { localToUtc, nextDate } from '../../src/world/time.js';
import { Actor, KEEPER, makeTown, tempDb, type Town } from './helpers.js';
import { checkSpaceInvariants } from './invariants.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** 文件数据库的小镇。 */
function fileTown(extra: { params?: Record<string, unknown> } = {}): { t: Town; dir: string; path: string } {
  const db = tempDb();
  cleanups.push(db.cleanup);
  const t = makeTown({ dbPath: db.path, ...extra });
  return { t, dir: db.dir, path: db.path };
}

let reopenSeq = 0;
/**
 * 重开数据库。crash=true：进程被杀，不写 last_alive_at、不做检查点；否则是正常关闭。down：停机多久后再起来。
 * 每次重开用不同的随机种子：编号流不重复（生产用密码学随机，不会撞）。
 */
function reopen(t: Town, opts: { crash?: boolean; down?: number; params?: Record<string, unknown> } = {}): WorldService {
  t.w.db.failpoint = null;
  if (opts.crash) t.w.db.db.close();
  else t.w.close();
  if (opts.down) t.clock.advance(opts.down); // 停机期间时间照常流逝
  const w = createWorld({
    dbPath: t.opts.dbPath!,
    registry: createRegistry({}),
    now: t.clock.now,
    rng: new SeededRng(`reopen-${++reopenSeq}`),
    seed: t.opts.seed ?? 'town-test',
    params: opts.params ?? t.opts.params ?? {},
    log: (m) => t.logs.push(m),
    devLogin: true,
  });
  w.startSync();
  t.w = w;
  return w;
}

const count = (w: WorldService, table: string, where = '1=1', ...p: (string | number)[]) => w.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, ...p);

/** 账本不变量：每个账户余额等于分录合计，全部分录合计为零。 */
function ledgerProblems(w: WorldService): string[] {
  const bad: string[] = [];
  for (const a of w.db.all('SELECT account_id, balance FROM accounts')) {
    const sum = w.db.scalar('SELECT COALESCE(SUM(delta),0) FROM ledger_entries WHERE account_id = ?', a.account_id);
    if (sum !== Number(a.balance)) bad.push(`${a.account_id}: 余额 ${a.balance} ≠ 分录 ${sum}`);
  }
  if (w.db.scalar('SELECT COALESCE(SUM(delta),0) FROM ledger_entries') !== 0) bad.push('分录合计不为零');
  if (w.db.scalar('SELECT COALESCE(SUM(balance),0) FROM accounts') !== 0) bad.push('余额合计不为零');
  return bad;
}

const totalOf = (w: WorldService, type: string) => w.db.scalar('SELECT COALESCE(SUM(quantity),0) FROM items WHERE type = ? AND stack = 1', type);

/** 时间前进并保持心跳，但不 tick、不处理到期任务（心跳本身不会跑调度）。 */
function quietAdvance(t: Town, ms: number, actors: Actor[]): void {
  for (let left = ms; left > 0; left -= 20_000) {
    t.clock.advance(Math.min(20_000, left));
    for (const x of actors) x.heartbeat();
  }
}

/** 重启后让居民重新在场（租约还在的话一次心跳就够）。 */
function comeBack(a: Actor): void {
  a.heartbeat();
}

describe('启动恢复：停机期间到期的事务各结算一次，保留应发生的时间', () => {
  it('导航、信件、邀请过期、在场租约：各只结算一次，时间是应发生的那一刻；没走完的路停在检查点', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const letter = a.act('send_letter', { to: b.residentId, body: '停机前寄的信', invite: {} });
    const mv = a.act('navigate', { to: 'tea_house' });
    expect(mv.status).toBe('accepted');
    const grant = t.w.db.get('SELECT grant_id, expires_at FROM home_access_grants')!;
    expect(grant.expires_at).toBe(letter.deliverAt + DAY);
    t.advance(1000);
    reopen(t, { down: 26 * HOUR });
    const w = t.w;
    expect(w.lastOutageMs).toBe(26 * HOUR);
    // 导航：重启就是离线，立即停步，停在最后一个耐久检查点；不会在停机期间「走到」茶馆，也没有到达事实
    const row = w.mustResident(a.residentId);
    expect(row.location_id).toBe('plaza');
    expect(row.present_since).toBeNull();
    expect(w.db.get('SELECT nav_json FROM world_actors WHERE actor_id = ?', a.residentId)!.nav_json).toBeNull();
    expect(w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind IN ('nav_step','move_arrive') AND status = 'pending'")).toBe(0);
    expect(w.db.all("SELECT type FROM world_events WHERE type = 'arrived'").length).toBe(0);
    // 信件：送达时间 = 应送达时间；收信人只有一条「有新信」
    expect(w.db.get('SELECT delivered_at FROM letters')!.delivered_at).toBe(letter.deliverAt);
    const mails = w.db.all("SELECT occurred_at FROM recipient_events WHERE resident_id = ? AND type = 'mail'", b.residentId);
    expect(mails.map((r) => r.occurred_at)).toEqual([letter.deliverAt]);
    // 每条到期任务只结算一次，没有留下到期待办
    for (const key of [`grant:${grant.grant_id}`, `letter:${letter.letterId}`]) {
      expect(w.db.get('SELECT status FROM scheduled_jobs WHERE dedupe_key = ?', key)?.status, key).toBe('done');
    }
    expect(w.pendingJobs()).toBe(0);
    expect(w.status).toBe('running');
    // 回来之后从停下的地方重新走
    a.enter();
    expect(a.row().location_id).toBe('plaza');
    a.go('tea_house');
    expect(a.row().location_id).toBe('tea_house');
    checkSpaceInvariants(t);
  });

  it('登门邀请在停机期间过期：屋里的客人被送到门口，只收到一条固定模板通知', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const inv = a.act('invite', { to: b.residentId });
    const expires = inv.invite.expiresAt;
    b.go(`home:${a.residentId}`);
    expect(b.row().location_id).toBe(`home:${a.residentId}`);
    reopen(t, { down: 30 * HOUR });
    const row = t.w.mustResident(b.residentId);
    expect(row.location_id).toBe('residential');
    const spot = t.w.db.get('SELECT scene_id, instance_id FROM world_actors WHERE actor_id = ?', b.residentId)!;
    expect(spot).toMatchObject({ scene_id: 'town', instance_id: '' });
    expect(t.w.db.get('SELECT status FROM scheduled_jobs WHERE dedupe_key = ?', `grant:${inv.invite.grantId}`)!.status).toBe('done');
    const notices = t.w.db.all("SELECT projection, occurred_at FROM recipient_events WHERE resident_id = ? AND type = 'notice'", b.residentId);
    expect(notices.length).toBe(1);
    expect(notices[0]!.occurred_at).toBe(expires);
    expect(JSON.parse(notices[0]!.projection).text).toContain('做客的时间到了');
    expect(t.w.pendingJobs()).toBe(0);
  });

  it('报价：重启前开着的报价按停机时刻撤销，预留退回，双方各一条通知', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const offer = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5 } });
    expect(t.w.db.get('SELECT reserved FROM accounts WHERE resident_id = ?', a.residentId)!.reserved).toBe(5);
    const stopAt = t.clock.t;
    reopen(t, { down: HOUR });
    const w = t.w;
    const row = w.db.get('SELECT status, closed_at FROM offers WHERE offer_id = ?', offer.offer.id)!;
    expect(row.status).toBe('cancelled');
    expect(row.closed_at).toBe(stopAt);
    expect(w.db.get('SELECT reserved, balance FROM accounts WHERE resident_id = ?', a.residentId)).toMatchObject({ reserved: 0, balance: 20 });
    expect(w.db.scalar("SELECT COUNT(*) FROM resource_reservations WHERE holder_ref = ?", offer.offer.id)).toBe(0);
    for (const id of [a.residentId, b.residentId]) {
      const evs = w.db.all("SELECT projection FROM recipient_events WHERE resident_id = ? AND type = 'offer' ORDER BY cursor", id).map((r) => JSON.parse(r.projection).offer.status);
      expect(evs).toEqual(['open', 'cancelled']);
    }
    expect(ledgerProblems(w)).toEqual([]);
  });

  it('已经开始的共同活动在停机期间到点：结算一次，结束时间是应结束的那一刻', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go(KEEPER);
    b.go(KEEPER);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 1 });
    const table = a.view().here!.objects.find((o) => o.type === 'tea_table')!;
    a.go(table.id);
    b.go(table.id);
    const ix = a.act('start_interaction', { objectId: table.id });
    b.act('join_interaction', { interactionId: ix.interaction.id });
    a.act('begin_interaction', { interactionId: ix.interaction.id });
    const ends = t.w.db.get('SELECT ends_at FROM interactions')!.ends_at;
    reopen(t, { down: 2 * HOUR });
    const row = t.w.db.get('SELECT status, closed_at FROM interactions')!;
    expect(row.status).toBe('completed');
    expect(row.closed_at).toBe(ends);
    // 收获只给一次
    expect(count(t.w, 'recipient_events', "resident_id = ? AND type = 'interaction_done'", a.residentId)).toBe(1);
    expect(count(t.w, 'world_events', "type = 'interaction_completed'")).toBe(1);
    // 再重启一次，不会重复结算
    reopen(t);
    expect(count(t.w, 'recipient_events', "resident_id = ? AND type = 'interaction_done'", a.residentId)).toBe(1);
    expect(count(t.w, 'world_events', "type = 'interaction_completed'")).toBe(1);
    expect(ledgerProblems(t.w)).toEqual([]);
  });

  it('凑桌报名阶段：重启时人离线、桌子散掉；一局进行中停机很短则顺延，太久则中止且没有奖励', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go('arcade:table1');
    b.go('arcade:table1');
    const lobby = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    reopen(t, { down: HOUR });
    expect(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', lobby.activity.id)!.status).not.toBe('forming');
    expect(count(t.w, 'activity_participants', 'active = 1')).toBe(0);

    // 一局进行中：短停机顺延
    comeBackAll([a, b]);
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    const deadline = t.w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', p.activity.id)!.deadline;
    t.advance(1000);
    reopen(t, { crash: true });
    reopen(t, { down: 30_000 });
    expect(t.w.db.get('SELECT status, deadline FROM activities WHERE activity_id = ?', p.activity.id)).toMatchObject({ status: 'running' });
    expect(t.w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', p.activity.id)!.deadline).toBeGreaterThan(deadline);

    // 长停机：中止，不发奖
    const coins = t.w.db.scalar('SELECT SUM(balance) FROM accounts WHERE resident_id IS NOT NULL');
    reopen(t, { down: 10 * MIN });
    expect(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', p.activity.id)!.status).toBe('aborted');
    expect(t.w.db.scalar('SELECT SUM(balance) FROM accounts WHERE resident_id IS NOT NULL')).toBe(coins);
    expect(ledgerProblems(t.w)).toEqual([]);
  });

  function comeBackAll(list: Actor[]): void {
    for (const x of list) x.enter();
  }

  it('重启前在场的人按停机时刻离线；租约未过期的一次心跳恢复在场', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    t.advanceAlive(40_000, [a]);
    const closedAt = t.clock.t;
    a.heartbeat();
    reopen(t, { down: 20_000 });
    expect(t.w.status).toBe('running');
    const r = a.row();
    expect(r.present_since).toBeNull();
    expect(r.last_seen_at).toBe(closedAt);
    expect(t.w.presentCount()).toBe(0);
    const out = heartbeat(t.w, a.auth, r.presence_epoch);
    expect(out.presenceEpoch).toBe(r.presence_epoch);
    expect(a.row().present_since).toBe(t.clock.t);
    expect(t.w.presentCount()).toBe(1);
  });

  it('租约已过期的客户端：心跳失败（presence_lost），重新进入后 wasAway', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    reopen(t, { down: 5 * MIN });
    let err: unknown;
    try {
      a.heartbeat();
    } catch (e) {
      err = e;
    }
    expect((err as WorldError).reason).toBe('presence_lost');
    const out = enterWorld(t.w, a.auth, {});
    expect(out.enter.wasAway).toBe(true);
    expect(a.row().present_since).not.toBeNull();
  });

  it('崩溃（没有正常关闭）后：按最近一次 last_alive_at 估算停机时长并离线', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    for (let i = 0; i < 6; i++) t.advanceAlive(5000, [a], 5000);
    const lastWrite = t.w.db.get('SELECT last_alive_at FROM worlds')!.last_alive_at as number;
    expect(lastWrite).toBeGreaterThanOrEqual(t.clock.t - 5000);
    expect(lastWrite).toBeLessThanOrEqual(t.clock.t);
    const crashAt = t.clock.t;
    t.clock.advance(90_000);
    reopen(t, { crash: true });
    expect(t.w.lastOutageMs).toBe(crashAt + 90_000 - lastWrite);
    expect(a.row().last_seen_at).toBe(Math.max(a.row().last_seen_at, lastWrite));
    expect(a.row().present_since).toBeNull();
    // 恢复完成后检查点已经更新
    expect(t.w.db.get('SELECT last_alive_at FROM worlds')!.last_alive_at).toBe(t.clock.t);
  });

  it('last_alive_at：每 5 秒才写一次', () => {
    const { t } = fileTown();
    t.join('阿灯');
    const read = () => t.w.db.get('SELECT last_alive_at FROM worlds')!.last_alive_at as number;
    const start = read();
    t.advance(4000);
    expect(read()).toBe(start);
    t.advance(1000);
    expect(read()).toBe(t.clock.t);
  });

  it('恢复完成前写命令返回 recovering；恢复后正常', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const t = makeTown({ dbPath: db.path, start: false });
    expect(t.w.status).toBe('recovering');
    expect(() => t.w.command({ principalId: 'p', clientId: 'web:x-1234' }, { requestId: 'req-recover-01', action: { type: 'speak', text: 'x' } })).toThrow(/正在恢复/);
    // 异步启动：追赶期间让出事件循环，此时仍是 recovering
    for (let i = 0; i < 250; i++) t.w.schedule('prune', `bulk:${i}`, t.clock.t - 1000 - i, {});
    t.w.jobHandlers.set('prune', () => undefined);
    const started = t.w.start();
    expect(t.w.status).toBe('recovering');
    let code = '';
    try {
      t.w.command({ principalId: 'p', clientId: 'web:x-1234' }, { requestId: 'req-recover-02', action: { type: 'speak', text: 'x' } });
    } catch (e) {
      code = (e as WorldError).code;
    }
    expect(code).toBe('recovering');
    await started;
    expect(t.w.status).toBe('running');
    expect(count(t.w, 'scheduled_jobs', "dedupe_key LIKE 'bulk:%' AND status = 'done'")).toBe(250);
    t.w.close();
  });

  it('恢复期间 tick 什么都不做', () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const t = makeTown({ dbPath: db.path, start: false });
    t.w.schedule('prune', 'rec:tick', t.clock.t - 1, {});
    t.w.tick();
    expect(t.w.db.get('SELECT status FROM scheduled_jobs WHERE dedupe_key = ?', 'rec:tick')!.status).toBe('pending');
  });
});

describe('启动恢复：跨世界日边界的停机', () => {
  it('停机 30 小时：换日任务、愿望补满、商店补货、日报各只做一次', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go(KEEPER);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 3 });
    const day0 = t.w.today();
    // 愿望缺一个：把一个短期愿望标成已更换
    const goal = t.w.db.get("SELECT goal_id FROM resident_goals WHERE resident_id = ? AND kind = 'short' AND status = 'active'", a.residentId)!;
    t.w.db.run("UPDATE resident_goals SET status = 'replaced' WHERE goal_id = ?", goal.goal_id);
    expect(count(t.w, 'resident_goals', "resident_id = ? AND status = 'active'", a.residentId)).toBe(2);
    const stockBefore = a.view().here!.shops[0]!.goods.find((g) => g.sku === 'tea_leaves')!.stock;
    reopen(t, { down: 30 * HOUR });
    const w = t.w;
    const today = w.today();
    expect(today).not.toBe(day0);
    // 换日任务各结算一次：旧的 rollover 任务 done，只留下一条待办（明天）
    expect(count(w, 'scheduled_jobs', "kind = 'daily_rollover' AND status = 'pending'")).toBe(1);
    expect(w.db.get("SELECT dedupe_key FROM scheduled_jobs WHERE kind = 'daily_rollover' AND status = 'pending'")!.dedupe_key).toBe(`rollover:${nextDate(today)}`);
    // 愿望补满：每个世界日只补一次
    expect(count(w, 'business_keys', 'key = ?', `newday:goals:${today}`)).toBe(1);
    expect(count(w, 'resident_goals', "resident_id = ? AND status = 'active'", a.residentId)).toBe(3);
    // 商店补货：新的一天库存回到每日库存
    a.enter();
    expect(a.view().here!.shops[0]!.goods.find((g) => g.sku === 'tea_leaves')!.stock).toBeGreaterThan(stockBefore);
    // 日报：昨天的公开日报只有一份，公告和公开事件各一条
    const yesterday = nextDate(today, -1);
    expect(count(w, 'daily_reports', "scope = 'public' AND business_date = ?", yesterday)).toBe(1);
    expect(count(w, 'notification_outbox', 'dedupe_key = ?', `report:${yesterday}`)).toBe(1);
    expect(count(w, 'public_events', "type = 'report' AND projection LIKE ?", `%${yesterday}%`)).toBe(1);
    // 再重启一次（同一天）：什么都不重复
    reopen(t);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", yesterday)).toBe(1);
    expect(count(t.w, 'notification_outbox', 'dedupe_key = ?', `report:${yesterday}`)).toBe(1);
    expect(count(t.w, 'public_events', "type = 'report' AND projection LIKE ?", `%${yesterday}%`)).toBe(1);
    expect(count(t.w, 'business_keys', 'key = ?', `newday:goals:${today}`)).toBe(1);
    expect(b.row().revision).toBeGreaterThan(0);
  });

  it('停机多天：只在回来那天生成昨天的日报，中间的日子按需生成且只生成一次', () => {
    const { t } = fileTown();
    t.join('阿灯');
    reopen(t, { down: 4 * DAY });
    const today = t.w.today();
    const yesterday = nextDate(today, -1);
    const dayBefore = nextDate(today, -2);
    expect(count(t.w, 'daily_reports', "scope = 'public'")).toBe(1);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", yesterday)).toBe(1);
    const first = report(t.w, 'public', dayBefore, t.clock.t);
    const second = report(t.w, 'public', dayBefore, t.clock.t);
    expect(first.final).toBe(true);
    expect(second.lines).toEqual(first.lines);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", dayBefore)).toBe(1);
  });

  it('公共事件的时间窗整个在停机里过去：记为错过，不补造参与者', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    reopen(t, { down: 3 * DAY });
    expect(count(t.w, 'event_participation')).toBe(0);
    // 回来当天已经过去的事件窗是 missed，没过去的是 scheduled
    const today = t.w.today();
    const rows = t.w.db.all('SELECT status, closes_at FROM public_event_instances WHERE business_date = ?', today);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.status).toBe(r.closes_at <= t.clock.t ? 'missed' : 'scheduled');
    expect(a.row().revision).toBeGreaterThan(0);
  });
});

describe('崩溃一致性：提交边界（failpoint）', () => {
  /** 在下一个事务的指定位置抛错一次。 */
  function crashOnce(t: Town, point: 'before_commit' | 'after_commit'): void {
    let armed = true;
    t.w.db.failpoint = (p) => {
      if (armed && p === point) {
        armed = false;
        throw new Error(`注入的崩溃：${p}`);
      }
    };
  }

  function setup() {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go(KEEPER);
    b.go(KEEPER);
    return { t, a, b };
  }

  it('before_commit 崩溃：重开后命令完全没发生；同一 requestId 重试成功且只做一次（买东西）', () => {
    const { t, a } = setup();
    const coins = a.coins();
    const tea = a.qty('tea_leaves');
    const v = a.view();
    const req = {
      requestId: 'req-buy-crash-01',
      actionWindow: v.actionWindow,
      expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null },
      action: { type: 'buy', shop: 'tea_counter', sku: 'tea_leaves', qty: 1 },
    };
    crashOnce(t, 'before_commit');
    expect(() => t.w.command(a.auth, req)).toThrow('注入的崩溃');
    reopen(t, { crash: true });
    comeBack(a);
    expect(a.coins()).toBe(coins);
    expect(a.qty('tea_leaves')).toBe(tea);
    expect(count(t.w, 'request_receipts', 'request_id = ?', req.requestId)).toBe(0);
    expect(count(t.w, 'ledger_transactions', "cause_key LIKE 'buy:%'")).toBe(0);
    const ok = t.w.command(a.auth, req);
    expect(ok.replayed).toBeUndefined();
    expect(a.coins()).toBe(coins - 2);
    expect(a.qty('tea_leaves')).toBe(tea + 1);
    // 再来一次只会重放
    expect(t.w.command(a.auth, req).replayed).toBe(true);
    expect(a.coins()).toBe(coins - 2);
    expect(count(t.w, 'ledger_transactions', "cause_key LIKE 'buy:%'")).toBe(1);
    expect(ledgerProblems(t.w)).toEqual([]);
  });

  it('after_commit 崩溃（提交成功但响应丢失）：重开后状态已变；同一 requestId 重试得到 replayed，不重复结算', () => {
    const { t, a } = setup();
    const coins = a.coins();
    const tea = a.qty('tea_leaves');
    const v = a.view();
    const req = {
      requestId: 'req-buy-crash-02',
      actionWindow: v.actionWindow,
      expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null },
      action: { type: 'buy', shop: 'tea_counter', sku: 'tea_leaves', qty: 1 },
    };
    crashOnce(t, 'after_commit');
    expect(() => t.w.command(a.auth, req)).toThrow('注入的崩溃');
    reopen(t, { crash: true });
    comeBack(a);
    expect(a.coins()).toBe(coins - 2); // 已经提交
    expect(a.qty('tea_leaves')).toBe(tea + 1);
    const again = t.w.command(a.auth, req);
    expect(again.replayed).toBe(true);
    expect(again.ok).toBe(true);
    expect(a.coins()).toBe(coins - 2);
    expect(a.qty('tea_leaves')).toBe(tea + 1);
    expect(count(t.w, 'ledger_transactions', "cause_key LIKE 'buy:%'")).toBe(1);
    expect(ledgerProblems(t.w)).toEqual([]);
  });

  it('接受赠送：两种崩溃点下物品都不复制不丢失', () => {
    for (const point of ['before_commit', 'after_commit'] as const) {
      const { t, a, b } = setup();
      const offer = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 1 }] } });
      const total = totalOf(t.w, 'tea_leaves');
      const v = b.view();
      const req = {
        requestId: `req-accept-${point}`.slice(0, 40),
        actionWindow: v.actionWindow,
        expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null },
        action: { type: 'accept_offer', offerId: offer.offer.id },
      };
      crashOnce(t, point);
      expect(() => t.w.command(b.auth, req)).toThrow('注入的崩溃');
      reopen(t, { crash: true });
      // 重启使双方离线：报价被撤销（预留退回）——这就是「没有发生」的状态，不会半截转移
      expect(totalOf(t.w, 'tea_leaves')).toBe(total);
      if (point === 'before_commit') {
        expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', offer.offer.id)!.status).toBe('cancelled');
        expect(a.qty('tea_leaves')).toBe(2);
        expect(b.qty('tea_leaves')).toBe(2);
      } else {
        // 提交已经落盘：接受先于重启发生
        expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', offer.offer.id)!.status).toBe('accepted');
        expect(a.qty('tea_leaves')).toBe(1);
        expect(b.qty('tea_leaves')).toBe(3);
        comeBack(b);
        expect(t.w.command(b.auth, req).replayed).toBe(true);
        expect(b.qty('tea_leaves')).toBe(3);
      }
      expect(totalOf(t.w, 'tea_leaves')).toBe(total);
      expect(ledgerProblems(t.w)).toEqual([]);
      t.w.close();
    }
  });

  it('交换（硬币换物品）：前后崩溃后守恒；after_commit 下重试只重放', () => {
    for (const point of ['before_commit', 'after_commit'] as const) {
      const { t, a, b } = setup();
      const coinsTotal = a.coins() + b.coins();
      const teaTotal = totalOf(t.w, 'tea_leaves');
      const offer = a.act('offer', { kind: 'trade', to: b.residentId, give: { coins: 3 }, want: { items: [{ type: 'tea_leaves', qty: 1 }] } });
      const v = b.view();
      const req = {
        requestId: `req-trade-${point}`.slice(0, 40),
        actionWindow: v.actionWindow,
        expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null },
        action: { type: 'accept_offer', offerId: offer.offer.id },
      };
      crashOnce(t, point);
      expect(() => t.w.command(b.auth, req)).toThrow('注入的崩溃');
      reopen(t, { crash: true });
      expect(a.coins() + b.coins()).toBe(coinsTotal);
      expect(totalOf(t.w, 'tea_leaves')).toBe(teaTotal);
      if (point === 'after_commit') {
        expect(a.coins()).toBe(17);
        expect(b.coins()).toBe(23);
        comeBack(b);
        expect(t.w.command(b.auth, req).replayed).toBe(true);
        expect(a.coins() + b.coins()).toBe(coinsTotal);
        expect(count(t.w, 'ledger_transactions', "kind = 'trade' OR cause_key LIKE 'offer:%'")).toBeLessThanOrEqual(1);
      } else {
        expect(a.coins()).toBe(20);
        expect(b.coins()).toBe(20);
      }
      expect(ledgerProblems(t.w)).toEqual([]);
      t.w.close();
    }
  });

  it('定时任务提交后崩溃：任务已 done，不会被当成失败而重新执行', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const sent = a.act('send_letter', { to: b.residentId, body: '崩溃测试' });
    quietAdvance(t, 61_000, [a, b]);
    crashOnce(t, 'after_commit');
    t.w.runDue(); // 这条任务的事务已提交，随后注入的错误被当作处理异常
    const job = t.w.db.get('SELECT status, attempts FROM scheduled_jobs WHERE dedupe_key = ?', `letter:${sent.letterId}`)!;
    expect(job.status).toBe('done');
    t.w.runDue();
    expect(count(t.w, 'recipient_events', "resident_id = ? AND type = 'mail'", b.residentId)).toBe(1);
  });

  it('一个事务里的所有变化一起落盘或一起消失（before_commit 崩溃后没有半截事件）', () => {
    const { t, a, b } = setup();
    const facts = count(t.w, 'world_events');
    const v = a.view();
    crashOnce(t, 'before_commit');
    expect(() =>
      t.w.command(a.auth, {
        requestId: 'req-half-0001',
        actionWindow: v.actionWindow,
        expected: { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: null },
        action: { type: 'offer', kind: 'gift', to: b.residentId, give: { coins: 4 } },
      }),
    ).toThrow('注入的崩溃');
    reopen(t, { crash: true });
    expect(count(t.w, 'recipient_events', "type = 'offer'")).toBe(0);
    expect(count(t.w, 'offers')).toBe(0);
    expect(count(t.w, 'resource_reservations')).toBe(0);
    expect(count(t.w, 'world_events')).toBe(facts);
    expect(count(t.w, 'scheduled_jobs', "dedupe_key LIKE 'offer:%'")).toBe(0);
  });
});

describe('degraded：数据库不可写', () => {
  it('SQLITE_FULL 类错误：命令返回 recovering、进入 degraded；恢复可写后继续，同一请求号重试成功', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    let broken = true;
    t.w.db.failpoint = (p) => {
      if (broken && p === 'before_commit') throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 });
    };
    const err = a.fail('speak', { text: '写不进去' }, { requestId: 'req-degraded-01' });
    expect(err.code).toBe('recovering');
    expect(t.w.status).toBe('degraded');
    // 之后的写命令直接 recovering，不碰数据库
    expect(a.fail('speak', { text: '还是不行' }, { requestId: 'req-degraded-02' }).code).toBe('recovering');
    // 仍不可写：tick 保持 degraded
    t.advance(1000);
    expect(t.w.status).toBe('degraded');
    // 恢复可写
    broken = false;
    t.advance(1000);
    expect(t.w.status).toBe('running');
    expect(t.logs.some((l) => l.includes('数据库恢复可写'))).toBe(true);
    const ok = a.act('speak', { text: '写进去了' }, { requestId: 'req-degraded-01' });
    expect(ok.replayed).toBeUndefined();
    expect(count(t.w, 'chat_messages')).toBe(1);
    expect(count(t.w, 'request_receipts', 'request_id = ?', 'req-degraded-01')).toBe(1);
  });

  it('真实的只读数据库（query_only）：进入 degraded，放开后恢复', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    t.w.db.db.exec('PRAGMA query_only = ON');
    const err = a.fail('speak', { text: '只读' }, { requestId: 'req-readonly-01' });
    expect(err.code).toBe('recovering');
    expect(t.w.status).toBe('degraded');
    t.advance(1000); // 仍然只读
    expect(t.w.status).toBe('degraded');
    t.w.db.db.exec('PRAGMA query_only = OFF');
    t.advance(1000);
    expect(t.w.status).toBe('running');
    expect(a.act('speak', { text: '好了' }, { requestId: 'req-readonly-01' }).ok).toBe(true);
  });

  it('普通业务错误（处理器抛错）不会让小镇进入 degraded', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    t.w.handlers.set('plain_boom', () => {
      throw new Error('一般的 bug');
    });
    expect(() => a.act('plain_boom')).toThrow('一般的 bug');
    expect(t.w.status).toBe('running');
  });

  it('写入失败时到期任务不被计为失败重试（不会因为磁盘满而被搁置）', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const sent = a.act('send_letter', { to: b.residentId, body: '磁盘满了' });
    quietAdvance(t, 61_000, [a, b]);
    let left = 1;
    t.w.db.failpoint = (p) => {
      if (p === 'before_commit' && left > 0) {
        left--;
        throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
      }
    };
    t.w.runDue();
    const job = t.w.db.get('SELECT status, attempts FROM scheduled_jobs WHERE dedupe_key = ?', `letter:${sent.letterId}`)!;
    expect(t.w.status).toBe('degraded');
    expect(job).toMatchObject({ status: 'pending', attempts: 0 });
    t.advance(1000);
    expect(t.w.status).toBe('running');
    expect(t.w.db.get('SELECT status FROM scheduled_jobs WHERE dedupe_key = ?', `letter:${sent.letterId}`)!.status).toBe('done');
  });

  it('degraded 时进入世界、心跳也返回 recovering', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    t.w.status = 'degraded';
    expect(() => a.enter()).toThrow(/正在恢复/);
    expect(() => a.heartbeat()).toThrow(/正在恢复/);
  });
});

describe('时区与 schema', () => {
  it('时区配置被改后拒绝启动；原时区仍能启动', () => {
    const { t, path } = fileTown({ params: { timezone: 'Asia/Tokyo' } });
    t.w.close();
    expect(() => makeTown({ dbPath: path, params: { timezone: 'America/New_York' } })).toThrow(/时区.*拒绝启动/);
    expect(() => makeTown({ dbPath: path, params: {} })).not.toThrow(); // 默认就是 Asia/Tokyo
  });

  it('不认识的时区在配置校验时被拒绝', () => {
    expect(() => makeTown({ params: { timezone: 'Mars/Olympus' } })).toThrow(/时区/);
  });

  it('新库的 schema 版本写在 PRAGMA user_version 和 worlds 表里', () => {
    const { t } = fileTown();
    expect(t.w.db.userVersion()).toBe(SCHEMA_VERSION);
    expect(t.w.db.get('SELECT schema_version FROM worlds')!.schema_version).toBe(SCHEMA_VERSION);
  });

  it('数据库 schema 比程序新：拒绝打开，且不改动文件', () => {
    const { t, path } = fileTown();
    t.w.db.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    t.w.close();
    expect(() => new TownDb(path)).toThrow(/比这个程序认识的.*新/);
    expect(() => makeTown({ dbPath: path })).toThrow(/新/);
  });

  it('迁移失败：抛错、版本号不前进、不开放写接口', () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    // 一个版本号为 0 却已经有同名表的库：迁移会撞表
    const first = new TownDb(db.path);
    first.db.exec('PRAGMA user_version = 0');
    first.close();
    expect(() => new TownDb(db.path)).toThrow(/迁移到 v1 失败/);
    const probe = new (class extends TownDb {})(':memory:');
    probe.close();
  });

  it('旧版本升级前先留一份迁移前备份（当前只有 v1，没有可升级的版本：备份路径用快照函数覆盖）', () => {
    const { t, dir } = fileTown();
    t.join('阿灯');
    const bak = join(dir, 'town.db.pre-v2-test.bak');
    t.w.db.snapshotTo(bak);
    verifyBackup(bak);
    expect(existsSync(bak)).toBe(true);
  });
});

describe('备份', () => {
  it('每个世界日一份一致备份，能通过验证，只保留最近 7 份', () => {
    const { t, dir } = fileTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    t.advance(1000);
    const backups = () => readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('town-') && f.endsWith('.db')).sort();
    expect(backups().length).toBe(1);
    // 同一个世界日不重复备份
    t.advance(HOUR);
    expect(backups().length).toBe(1);
    for (let i = 0; i < 10; i++) {
      t.clock.advance(DAY);
      a.enter();
      t.w.tick();
    }
    const files = backups();
    expect(files.length).toBe(7);
    // 保留的是最近的 7 份
    const today = t.w.today();
    expect(files[files.length - 1]).toBe(`town-${today}.db`);
    for (const f of files) verifyBackup(join(dir, 'backups', f));
    expect(t.w.db.getMeta('last_backup_date')).toBe(today);
    expect(t.logs.some((l) => l.includes('已备份到'))).toBe(true);
  });

  it('备份是一致快照：包含 WAL 里已提交、还没合并进主文件的内容', () => {
    const { t, dir } = fileTown();
    const a = t.join('阿灯');
    a.act('update_profile', { bio: '在 WAL 里的简介' });
    const out = t.w.backup(join(dir, 'snap.db'))!;
    expect(out.bytes).toBeGreaterThan(0);
    verifyBackup(out.path);
    const copy = new TownDb(out.path);
    expect(JSON.parse(copy.get('SELECT state_json FROM residents')!.state_json).bio).toBe('在 WAL 里的简介');
    copy.close();
  });

  it('损坏的备份验证失败', () => {
    const { t, dir } = fileTown();
    t.join('阿灯');
    const out = t.w.backup(join(dir, 'snap2.db'))!;
    truncateSync(out.path, Math.floor(statSync(out.path).size / 2));
    expect(() => verifyBackup(out.path)).toThrow();
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not a database at all, just text'.repeat(100));
    expect(() => verifyBackup(junk)).toThrow();
  });

  it('备份失败只记日志，不影响运行，当天不反复重试', () => {
    const { t } = fileTown();
    const a = t.join('阿灯');
    t.w.backup = () => {
      throw new Error('磁盘满了');
    };
    t.clock.advance(DAY);
    a.enter();
    expect(() => t.w.tick()).not.toThrow();
    expect(t.logs.some((l) => l.includes('备份失败：磁盘满了'))).toBe(true);
    expect(t.w.status).toBe('running');
    expect(t.w.db.getMeta('last_backup_date')).toBe(t.w.today());
    t.logs.length = 0;
    t.advance(1000);
    expect(t.logs.some((l) => l.includes('备份失败'))).toBe(false);
  });

  it('backupKeep 为 0：不自动备份；内存库不备份', () => {
    const { t, dir } = fileTown({ params: { backupKeep: 0 } });
    t.join('阿灯');
    t.advance(1000);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    const mem = makeTown();
    expect(mem.w.backup()).toBeNull();
  });
});
