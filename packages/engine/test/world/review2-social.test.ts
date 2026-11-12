/**
 * 二轮审查 #1 关系记忆翻页、#2 长期愿望完成后自选新方向。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { GOALS } from '../../src/world/content.js';
import { mountTown } from '../../src/world/http.js';
import { goalsOf, refillGoals, relationMemories } from '../../src/world/social.js';
import { WorldError } from '../../src/world/errors.js';
import { makeTown, type Actor, type Town } from './helpers.js';
import { checkInvariants } from './invariants.js';

const HOUR = 3600_000;
const BASE = { socialDecayPerHour: 0, interestDecayPerHour: 0 };

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

// ───────────────────────── #1 ─────────────────────────

/** 直接写入一对居民的 n 条共同记忆（occurred_at 从 1000 起，每 3 条里有 2 条同一毫秒，测同刻游标）。 */
function seedMemories(t: Town, a: Actor, b: Actor, n: number): void {
  t.w.db.run('INSERT INTO relationships(resident_id, other_id, familiarity, closeness, updated_at) VALUES (?,?,5,0,0)', a.residentId, b.residentId);
  // 先垫一些别的全局编号，让每对序号和全局自增号对不上
  for (let i = 0; i < 5; i++) t.w.db.run('INSERT INTO memory_refs(owner_id, other_id, event_id, kind, summary, occurred_at) VALUES (?,?,?,?,?,?)', b.residentId, null, 1, 'x', `noise${i}`, 1);
  for (let i = 0; i < n; i++) {
    t.w.db.run('INSERT INTO memory_refs(owner_id, other_id, event_id, kind, summary, occurred_at) VALUES (?,?,?,?,?,?)', a.residentId, b.residentId, 1, 'k', `m${i}`, 1000 + Math.floor(i / 3));
  }
}

describe('关系记忆翻页（relationMemories）', () => {
  it('新的在前，游标连续翻完，不重不漏；游标里没有全局自增号', () => {
    const t = makeTown({ params: { ...BASE, shortGoals: 0, longGoals: 0 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    seedMemories(t, a, b, 30);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = relationMemories(t.w, a.residentId, b.residentId, cursor, 7);
      expect(page.memories.length).toBeLessThanOrEqual(7);
      seen.push(...page.memories.map((m) => m.text));
      if (page.next) expect(page.next).toMatch(/^1\d{3}\.\d+$/);
      cursor = page.next;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBe(5);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen[0]).toBe('m29');
    expect(seen[29]).toBe('m0');
    // 默认条数 = activeMemoryItems
    expect(relationMemories(t.w, a.residentId, b.residentId).memories).toHaveLength(t.w.params.activeMemoryItems);
  });

  it('只能查自己认识的人；坏游标是 bad_request；对方看不到我这一侧的记忆', () => {
    const t = makeTown({ params: { ...BASE, shortGoals: 0, longGoals: 0 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('阿墨', 'agent');
    seedMemories(t, a, b, 3);
    expect(() => relationMemories(t.w, a.residentId, c.residentId)).toThrow(WorldError);
    expect(() => relationMemories(t.w, c.residentId, b.residentId)).toThrow(WorldError);
    expect(() => relationMemories(t.w, b.residentId, a.residentId)).toThrow(WorldError); // b 没有这条关系
    try {
      relationMemories(t.w, a.residentId, b.residentId, 'abc');
      throw new Error('应当失败');
    } catch (e) {
      expect((e as WorldError).code).toBe('bad_request');
    }
  });

  it('保留上限 activeMemoryItems*3：第 31 条挤掉最早的，翻页看得到的正好是保留的', () => {
    const t = makeTown({ params: { ...BASE, shortGoals: 0, longGoals: 0 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    // 用真实事实产生记忆：来回写信不产生记忆，这里用 home_visit 事实不方便，改用 social 模块的 remember 路径 = 事实钩子
    for (let i = 0; i < 40; i++) {
      t.w.commit(() => {
        const f = { eventId: i + 1, type: 'home_visit', occurredAt: 5000 + i, parties: [{ id: a.residentId, role: 'guest' }, { id: b.residentId, role: 'host' }], data: {} };
        for (const h of t.w.hooks.fact) h(f as never);
      });
      // 每对居民每天只有前几次带来变化：换一天
      t.advance(24 * HOUR);
    }
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const p = relationMemories(t.w, a.residentId, b.residentId, cursor, 50);
      all.push(...p.memories.map((m) => m.text));
      cursor = p.next;
    } while (cursor);
    expect(all.length).toBe(t.w.params.activeMemoryItems * 3);
  });

  it('HTTP：GET /relations?with=&before=&limit= 翻页；不带 with 行为不变；陌生人 4xx', async () => {
    const t = makeTown({ params: { ...BASE, shortGoals: 0, longGoals: 0 } });
    const app = express();
    app.use(express.json());
    mountTown(app, t.w, () => {});
    const server = await new Promise<Server>((res) => {
      const s = app.listen(0, '127.0.0.1', () => res(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let cookie = '';
    const req = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { 'content-type': 'application/json', origin: base } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const sc = res.headers.getSetCookie().find((c) => c.startsWith('town_session='));
      if (sc) cookie = sc.split(';')[0]!;
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };
    expect((await req('POST', '/town/api/auth/dev', { name: '阿灯' })).status).toBe(200);
    const e = await req('POST', '/town/api/enter', { clientId: 'tab-r2-0001', profile: { name: '阿灯' } });
    const me = e.json.residentId as string;
    const b = t.join('小岚', 'agent');
    const fake = { residentId: me } as Actor;
    seedMemories(t, fake, b, 12);
    const p1 = await req('GET', `/town/api/relations?with=${b.residentId}&limit=5`);
    expect(p1.status).toBe(200);
    expect(p1.json.memories.map((m: any) => m.text)).toEqual(['m11', 'm10', 'm9', 'm8', 'm7']);
    const p2 = await req('GET', `/town/api/relations?with=${b.residentId}&limit=5&before=${p1.json.next}`);
    expect(p2.json.memories.map((m: any) => m.text)).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    expect((await req('GET', '/town/api/relations')).json).toHaveProperty('relations');
    const stranger = t.join('阿墨', 'agent');
    expect((await req('GET', `/town/api/relations?with=${stranger.residentId}`)).status).toBeGreaterThanOrEqual(400);
  });
});

// ───────────────────────── #2 ─────────────────────────

/** 给 a 一个一步就能完成的长期愿望（写一封信），原有的进行中愿望全部作废。 */
function giveEasyLongGoal(t: Town, a: Actor): string {
  t.w.db.run("UPDATE resident_goals SET status = 'replaced', completed_at = ? WHERE resident_id = ? AND status = 'active' AND kind = 'long'", t.clock.t, a.residentId);
  // 注册时补的长期愿望占了当天的名额；模拟「愿望是前几天拿到的」
  t.w.db.run("DELETE FROM interaction_counters WHERE scope = ? AND category = 'long'", `goals:${a.residentId}`);
  const def = { ...GOALS.find((g) => g.kind === 'long')!, id: 'easy_long', title: '写一封信', count: 1, measure: 'times', paths: [{ fact: 'letter_sent' }], requires: undefined };
  const id = `g_easy_${t.w.db.scalar('SELECT COUNT(*) FROM resident_goals')}`;
  t.w.db.run(
    "INSERT INTO resident_goals(goal_id, resident_id, def_id, def_version, def_json, kind, progress_json, status, created_at) VALUES (?,?,?,?,?,'long',?,'active',?)",
    id,
    a.residentId,
    def.id,
    1,
    JSON.stringify(def),
    JSON.stringify({ count: 0, partners: [] }),
    t.clock.t,
  );
  return id;
}

const offered = (t: Town, a: Actor) => goalsOf(t.w, a.residentId).filter((g) => g.status === 'offered');
const activeLong = (t: Town, a: Actor) => t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = 'long'", a.residentId);

function setup(seed = 'r2-goal') {
  const t = makeTown({ seed, params: BASE });
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  giveEasyLongGoal(t, a);
  a.act('send_letter', { to: b.residentId, body: '写好了' });
  return { t, a, b };
}

describe('长期愿望完成后自选新方向', () => {
  it('完成后出现 3 个不同的候选；进行中的长期愿望空着；别人看不到', () => {
    const { t, a, b } = setup();
    const o = offered(t, a);
    expect(o).toHaveLength(3);
    expect(new Set(o.map((g) => g.title)).size).toBe(3);
    expect(o.every((g) => g.kind === 'long')).toBe(true);
    expect(activeLong(t, a)).toBe(0);
    // 本人视图能看到；别人的视图没有
    expect(a.view().goals.filter((g) => g.status === 'offered')).toHaveLength(3);
    expect(b.view().goals.some((g) => g.status === 'offered')).toBe(false);
    // 候选不泄露到公开层
    expect(JSON.stringify(t.w.db.all('SELECT projection FROM public_events')).includes('offered')).toBe(false);
    checkInvariants(t);
  });

  it('choose_goal 选定其一，其余作废；进行中数量守住上限', () => {
    const { t, a } = setup();
    const o = offered(t, a);
    const pick = o[1]!;
    const out = a.act('choose_goal', { goalId: pick.id });
    expect(out.status).toBe('completed');
    expect(activeLong(t, a)).toBe(1);
    expect(offered(t, a)).toHaveLength(0);
    const active = goalsOf(t.w, a.residentId).filter((g) => g.kind === 'long');
    expect(active.map((g) => g.id)).toEqual([pick.id]);
    expect(active[0]!.status).toBe('active');
    // 其余候选行被删除
    expect(t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE goal_id IN (?, ?)", o[0]!.id, o[2]!.id)).toBe(0);
    // 再选一次：没有候选了
    expect(a.fail('choose_goal', { goalId: o[0]!.id }).reason).toBe('no_such_offer');
    // 补位不会再多补一个长期愿望
    refillGoals(t.w, t.w.mustResident(a.residentId), t.clock.t);
    expect(activeLong(t, a)).toBe(1);
    checkInvariants(t);
  });

  it('不能选别人的候选，也不能选不存在的或进行中的愿望', () => {
    const { t, a, b } = setup();
    const o = offered(t, a);
    expect(b.fail('choose_goal', { goalId: o[0]!.id }).reason).toBe('no_such_offer');
    expect(a.fail('choose_goal', { goalId: 'nope' }).reason).toBe('no_such_offer');
    const shortId = goalsOf(t.w, a.residentId).find((g) => g.kind === 'short')!.id;
    expect(a.fail('choose_goal', { goalId: shortId }).reason).toBe('no_such_offer');
    expect(offered(t, a)).toHaveLength(3);
  });

  it('当天回到小镇补位不会替人选；过了一个世界日仍没选，候选作废并随机补一个', () => {
    const { t, a } = setup();
    refillGoals(t.w, t.w.mustResident(a.residentId), t.clock.t + 1000);
    expect(offered(t, a)).toHaveLength(3);
    expect(activeLong(t, a)).toBe(0);
    t.advance(24 * HOUR);
    a.enter();
    expect(offered(t, a)).toHaveLength(0);
    expect(activeLong(t, a)).toBe(1);
    checkInvariants(t);
  });

  it('同一个种子得到同样的候选（确定性）', () => {
    const x = setup('r2-same');
    const y = setup('r2-same');
    expect(offered(x.t, x.a).map((g) => g.title)).toEqual(offered(y.t, y.a).map((g) => g.title));
  });
});
