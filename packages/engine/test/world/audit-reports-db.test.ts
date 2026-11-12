/**
 * 审计回归：日报与清理（reports.ts / db.ts）。
 * 第 9 条恢复期间不固化残缺日报；第 10 条 event_parties 的 event_id 索引与个人日报批量取当事人；
 * 第 12/30 条日期校验和落盘范围；第 14 条新来居民人数；第 33 条衍生表的保留期。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { TownDb, SCHEMA_VERSION } from '../../src/world/db.js';
import { report } from '../../src/world/reports.js';
import type { WorldService } from '../../src/world/service.js';
import { localToUtc, nextDate } from '../../src/world/time.js';
import { makeTown, tempDb } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const count = (w: WorldService, table: string, where = '1=1', ...p: (string | number)[]) => Number(w.db.scalar(`SELECT COUNT(*) FROM ${table} WHERE ${where}`, ...p));

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof WorldError) return e.code;
    throw e;
  }
  return '';
}

describe('第 9 条：恢复追赶期间不固化日报', () => {
  it('status 不是 running 时已过日的日报只现算不存，final 为 false', () => {
    const t = makeTown();
    t.join('阿灯');
    t.advance(2 * DAY);
    const yesterday = nextDate(t.w.today(), -1);
    t.w.commit(() => t.w.db.run('DELETE FROM daily_reports')); // 换日钩子已经存过，清掉再测
    const before = count(t.w, 'daily_reports');
    (t.w as any).status = 'recovering';
    const r = report(t.w, 'public', yesterday, t.clock.t);
    expect(r.final).toBe(false);
    expect(count(t.w, 'daily_reports')).toBe(before);
    (t.w as any).status = 'running';
    const r2 = report(t.w, 'public', yesterday, t.clock.t);
    expect(r2.final).toBe(true);
    expect(count(t.w, 'daily_reports', "scope = 'public' AND business_date = ?", yesterday)).toBe(1);
  });

  it('文件库停机跨日后在 startSync 前读日报，不入库；追赶完成后换日钩子照常生成', () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const t = makeTown({ dbPath: db.path });
    t.join('阿灯');
    const day0 = t.w.today();
    t.advance(HOUR);
    t.w.close();
    t.clock.advance(30 * HOUR);
    const t2 = makeTown({ dbPath: db.path, start: false, clock: t.clock });
    expect(t2.w.status).toBe('recovering');
    const r = report(t2.w, 'public', day0, t.clock.t);
    expect(r.final).toBe(false);
    expect(count(t2.w, 'daily_reports')).toBe(0);
    t2.w.startSync();
    expect(t2.w.status).toBe('running');
    expect(count(t2.w, 'daily_reports', "scope = 'public' AND business_date = ?", day0)).toBe(1);
    t2.w.close();
  });
});

describe('第 10 条：event_parties 按 event_id 查有索引，个人日报批量取当事人', () => {
  it('按 event_id 的查询走索引而不是全表扫描', () => {
    const t = makeTown();
    const plan = t.w.db.all('EXPLAIN QUERY PLAN SELECT resident_id FROM event_parties WHERE event_id = ? AND resident_id <> ?', 1, 'x').map((r) => String(r.detail)).join('|');
    expect(plan).toContain('event_parties_event');
    expect(plan).not.toMatch(/SCAN/);
  });

  it('个人日报内容不变：同一事实多个当事人、超过 3 个写「等人」', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const others = ['小一', '小二', '小三', '小四'].map((n) => t.join(n));
    const day0 = t.w.today();
    t.w.commit(() => {
      t.w.fact('game_completed', [{ id: a.residentId, role: 'winner' }, ...others.map((o) => ({ id: o.residentId, role: 'player' }))], { name: '数字炸弹' }, { visibility: 'public' });
      t.w.fact('gift_accepted', [{ id: a.residentId, role: 'giver' }, { id: others[0]!.residentId, role: 'receiver' }], { give: '茶叶' });
    });
    t.advance(2 * DAY);
    const lines = report(t.w, { residentId: a.residentId }, day0, t.clock.t).lines;
    expect(lines.some((l) => /^和小.、小.、小.等人打完了一局数字炸弹，赢了$/.test(l))).toBe(true);
    expect(lines).toContain('送给小一：茶叶');
  });
});

describe('第 12/30 条：日报日期的校验与落盘范围', () => {
  it('不存在的日期与格式不对的日期返回 bad_request，不落盘', () => {
    const t = makeTown();
    t.join('阿灯');
    t.advance(2 * DAY);
    const before = count(t.w, 'daily_reports');
    for (const d of ['2024-02-30', '2024-13-01', '0001-00-10', 'abcd', '2024-1-1']) expect(codeOf(() => report(t.w, 'public', d, t.clock.t))).toBe('bad_request');
    expect(count(t.w, 'daily_reports')).toBe(before);
  });

  it('早于开服日、早于事实保留期的日期只现算不存', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.advance(60 * DAY);
    const before = count(t.w, 'daily_reports');
    for (const d of ['1900-01-01', '1900-01-02', nextDate(t.w.today(), -40)]) {
      report(t.w, 'public', d, t.clock.t);
      report(t.w, { residentId: a.residentId }, d, t.clock.t);
    }
    expect(count(t.w, 'daily_reports')).toBe(before);
  });

  it('保留期内的昨天照常落盘；日报超过日报保留期（90 天）被清理', () => {
    const t = makeTown();
    t.join('阿灯');
    t.advance(2 * DAY);
    const yesterday = nextDate(t.w.today(), -1);
    expect(report(t.w, 'public', yesterday, t.clock.t).final).toBe(true);
    expect(count(t.w, 'daily_reports', 'business_date = ?', yesterday)).toBe(1);
    // 很久以后的换日钩子会裁掉它
    const later = t.clock.t + 100 * DAY;
    t.w.commit(() => {
      for (const h of t.w.hooks.newDay) h(t.w.today(later), later);
    });
    expect(count(t.w, 'daily_reports', 'business_date = ?', yesterday)).toBe(0);
  });
});

describe('第 14 条：新来居民的人数写总数', () => {
  it('一天新来 15 位，写 15 位，只列 12 个名字并带「等」', () => {
    const t = makeTown();
    for (let i = 0; i < 15; i++) t.join(`居民${String(i).padStart(2, '0')}`);
    const day0 = t.w.today();
    t.advance(2 * DAY);
    const text = report(t.w, 'public', day0, t.clock.t).lines.join('\n');
    expect(text).toMatch(/新来了 15 位居民：/);
    expect(text).toContain(' 等。');
    expect((text.match(/居民\d\d/g) ?? []).length).toBe(12);
  });
});

describe('第 33 条：衍生表的保留期', () => {
  it('终态的旧记录被清理；仍被引用的行和账本不动', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚');
    t.advance(DAY);
    const w = t.w;
    const now = t.clock.t;
    const old = now - 40 * DAY;
    const recent = now - 2 * DAY;
    const later = now + 50 * DAY; // 换日清理发生的时刻
    const farFuture = later + 10 * DAY;
    const cut = later - 35 * DAY;
    expect(old).toBeLessThan(cut);
    expect(recent).toBeLessThan(cut); // 到 later 时 recent 也成了旧的；下面用 later 之后才创建的作为「新」
    const fresh = later - DAY;
    w.commit(() => {
      const ix = (id: string, status: string, closed: number | null) =>
        w.db.run(
          "INSERT INTO interactions(interaction_id, world_id, def_id, def_version, def_json, object_id, space_id, initiator_id, status, created_at, lobby_expires_at, closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          id, w.worldId, 'share_tea', 1, '{}', `obj-${id}`, 'tea_house', a.residentId, status, old, old, closed,
        );
      ix('ix-old-done', 'completed', old);
      ix('ix-old-cancel', 'cancelled', old);
      ix('ix-fresh-done', 'completed', fresh);
      ix('ix-running', 'running', null);
      for (const id of ['ix-old-done', 'ix-fresh-done', 'ix-running']) w.db.run('INSERT INTO interaction_participants(interaction_id, resident_id, joined_at, active) VALUES (?,?,?,0)', id, a.residentId, old);
      for (const id of ['i-ret-old', 'i-ret-fresh', 'i-active']) w.db.run("INSERT INTO items(item_id, world_id, owner_id, holder_id, type, stack, quantity, created_at) VALUES (?,?,?,?,?,0,1,?)", id, w.worldId, a.residentId, a.residentId, 'book', old);
      const loan = (id: string, item: string, status: string, returned: number | null) =>
        w.db.run('INSERT INTO loans(loan_id, item_id, owner_id, borrower_id, via, lent_at, due_at, returned_at, status) VALUES (?,?,?,?,?,?,?,?,?)', id, item, a.residentId, b.residentId, 'x', old, old, returned, status);
      loan('loan-old', 'i-ret-old', 'returned', old);
      loan('loan-fresh', 'i-ret-fresh', 'returned', fresh);
      loan('loan-active', 'i-active', 'active', null);
      const grant = (id: string, expires: number) =>
        w.db.run("INSERT INTO home_access_grants(grant_id, home_id, owner_id, guest_id, via, reentry, created_at, valid_from, expires_at) VALUES (?,?,?,?,'letter',0,?,?,?)", id, 'home', a.residentId, b.residentId, old, old, expires);
      grant('g-old', old);
      grant('g-valid', farFuture);
      grant('g-letter', old);
      w.db.run("INSERT INTO letters(letter_id, world_id, sender_id, recipient_id, body, invite_grant_id, sent_at, deliver_at) VALUES ('l1', ?, ?, ?, '信', 'g-letter', ?, ?)", w.worldId, a.residentId, b.residentId, old, old);
      w.db.run("INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at, processed_at) VALUES ('f-old', ?, 0, 'x', '{}', 'failed', ?, ?)", old, old, old);
      w.db.run("INSERT INTO scheduled_jobs(dedupe_key, due_at, priority, kind, payload, status, created_at, processed_at) VALUES ('f-fresh', ?, 0, 'x', '{}', 'failed', ?, ?)", fresh, fresh, fresh);
    });
    const ledgerBefore = count(w, 'ledger_entries');
    w.commit(() => {
      for (const h of w.hooks.newDay) h(w.today(later), later);
    });
    const ids = (sql: string) => w.db.all(sql).map((r) => String(Object.values(r)[0])).sort();
    expect(ids('SELECT interaction_id FROM interactions')).toEqual(['ix-fresh-done', 'ix-running']);
    expect(ids('SELECT interaction_id FROM interaction_participants')).toEqual(['ix-fresh-done', 'ix-running']);
    expect(ids('SELECT loan_id FROM loans')).toEqual(['loan-active', 'loan-fresh']);
    expect(ids('SELECT grant_id FROM home_access_grants')).toEqual(['g-letter', 'g-valid']);
    expect(count(w, 'letters', "letter_id = 'l1'")).toBe(1);
    expect(ids("SELECT dedupe_key FROM scheduled_jobs WHERE kind = 'x'")).toEqual(['f-fresh']);
    expect(count(w, 'ledger_entries')).toBe(ledgerBefore);
    void localToUtc;
  });
});

describe('复核新增：已有 v1 库升级后补上 event_parties 索引', () => {
  it('user_version=1 且没有该索引的库，重新打开后迁移到最新并能用上索引', () => {
    const tmp = tempDb();
    cleanups.push(tmp.cleanup);
    const first = new TownDb(tmp.path);
    first.db.exec('DROP INDEX event_parties_event');
    first.db.exec('PRAGMA user_version = 1');
    first.close();
    const again = new TownDb(tmp.path);
    expect(again.userVersion()).toBe(SCHEMA_VERSION);
    const plan = again.db.prepare('EXPLAIN QUERY PLAN SELECT resident_id FROM event_parties WHERE event_id = 1').all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join('\n')).toContain('event_parties_event');
    again.close();
  });
});
