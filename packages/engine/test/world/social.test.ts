/**
 * 栖灯镇：关系、共同经历、愿望、称号，以及互相刷收益的防刷验证。
 * 依据：设计文档第 4 节「愿望与个人进展」、第 5 节「关系与共同经历」、第 15 节「防刷与预算」；docs/TOWN.md「规则要点」。
 */
import { describe, expect, it } from 'vitest';
import { EMBEDDED_GAMES, GOALS, INTERACTIONS, type GoalDef } from '../../src/world/content.js';
import { effectivePresentMs } from '../../src/world/life.js';
import { goalsOf, relationLevel, relationsOf, titlesOf } from '../../src/world/social.js';
import { directory } from '../../src/world/views.js';
import { Actor, makeTown, tempDb, type Town, type TownOpts } from './helpers.js';
import { checkInvariants } from './invariants.js';

const MIN = 60_000;
const HOUR = 3600_000;

/** 默认关掉需要的自然下降，让数字稳定。愿望默认开着（这个文件主要就是测它）。 */
const BASE = { socialDecayPerHour: 0, interestDecayPerHour: 0 };
const NO_GOALS = { shortGoals: 0, longGoals: 0 };

function town(opts: TownOpts = {}): Town {
  return makeTown({ seed: 'soc-1', ...opts, params: { ...BASE, ...(opts.params ?? {}) } });
}

/** 没有愿望的小镇：只看关系 / 防刷。 */
const quietTown = (opts: TownOpts = {}) => town({ ...opts, params: { ...NO_GOALS, ...(opts.params ?? {}) } });

const rel = (t: Town, a: Actor, b: Actor) => {
  const row = t.w.db.get('SELECT familiarity, closeness FROM relationships WHERE resident_id = ? AND other_id = ?', a.residentId, b.residentId);
  return row ? { familiarity: row.familiarity as number, closeness: row.closeness as number } : null;
};

/** 大家一起走到某地。 */
function gather(place: string, ...people: Actor[]): void {
  for (const p of people) {
    if (p.view().location.space === place) continue;
    p.go(place);
  }
  for (const p of people) p.heartbeat();
}

/** 大家走到某个公共物件旁边（够得着才能用）。 */
function near(objectId: string, ...people: Actor[]): void {
  for (const p of people) p.go(objectId);
  for (const p of people) p.heartbeat();
}

/** 过一天以上，大家下线再回来。 */
function nextDay(t: Town, people: Actor[]): void {
  t.advance(24 * HOUR);
  for (const p of people) p.enter();
}

/** 给 a 一份指定的愿望（模拟创建时的定义副本）。 */
function giveGoal(t: Town, a: Actor, defId: string, opts: { kind?: 'long' | 'short'; place?: string; replaceAll?: boolean } = {}): string {
  const def = GOALS.find((g) => g.id === defId)!;
  if (opts.replaceAll !== false) t.w.db.run("UPDATE resident_goals SET status = 'replaced' WHERE resident_id = ? AND status = 'active'", a.residentId);
  let stored: GoalDef & { place?: string } = JSON.parse(JSON.stringify(def));
  if (opts.place) {
    stored = JSON.parse(JSON.stringify(def).replaceAll('$placeName', '某处').replaceAll('$place', opts.place));
    stored.place = opts.place;
  }
  const id = `g_test_${defId}_${t.w.db.scalar('SELECT COUNT(*) FROM resident_goals')}`;
  const owned = stored.measure === 'owned' ? t.w.db.scalar("SELECT COALESCE(SUM(quantity),0) FROM items WHERE owner_id = ? AND type = 'book'", a.residentId) : 0;
  t.w.db.run(
    "INSERT INTO resident_goals(goal_id, resident_id, def_id, def_version, def_json, kind, progress_json, status, created_at) VALUES (?,?,?,?,?,?,?,'active',?)",
    id,
    a.residentId,
    def.id,
    def.version,
    JSON.stringify(stored),
    opts.kind ?? def.kind,
    JSON.stringify({ count: owned, partners: [] }),
    t.clock.t,
  );
  return id;
}

const goalRow = (t: Town, id: string) => t.w.db.get('SELECT * FROM resident_goals WHERE goal_id = ?', id)!;
const goalCoins = (t: Town, a: Actor) =>
  t.w.db.scalar("SELECT COALESCE(SUM(e.delta),0) FROM ledger_entries e JOIN ledger_transactions x ON x.transaction_id = e.transaction_id WHERE x.kind = 'goal_reward' AND e.account_id = ?", `acct:${a.residentId}`);

function playBomb(t: Town, a: Actor, b: Actor): void {
  const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
  b.act('join_game', { activityId: p.activity.id });
  a.act('start_game', { activityId: p.activity.id });
  for (let i = 0; i < 200; i++) {
    const who = [a, b].find((x) => x.view().game?.your_turn);
    if (!who) break;
    const g = who.lastView.game!;
    const pub = g.public as { range: { from: number } };
    who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: pub.range.from } });
  }
}

// ───────────────────────── 关系等级 ─────────────────────────

describe('关系：等级阈值', () => {
  it('熟悉程度 0 / 1 / 8 / 20 / 40 为等级分界', () => {
    const cases: [number, string][] = [
      [0, '陌生'],
      [1, '见过面'],
      [7, '见过面'],
      [8, '熟人'],
      [19, '熟人'],
      [20, '朋友'],
      [39, '朋友'],
      [40, '老朋友'],
      [100, '老朋友'],
    ];
    for (const [f, level] of cases) expect(relationLevel(f), `熟悉度 ${f}`).toBe(level);
  });

  it('关系值封顶 100，relationsOf 带上等级', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    t.w.db.run('INSERT INTO relationships(resident_id, other_id, familiarity, closeness, updated_at) VALUES (?,?,99,99,0),(?,?,99,99,0)', a.residentId, b.residentId, b.residentId, a.residentId);
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(rel(t, a, b)).toEqual({ familiarity: 100, closeness: 100 });
    expect(relationsOf(t.w, a.residentId)[0]).toMatchObject({ id: b.residentId, name: '小岚', familiarity: 100, level: '老朋友' });
  });
});

// ───────────────────────── 关系：只由结构化事实驱动 ─────────────────────────

describe('关系：结构化事实驱动', () => {
  it('一个人自说自话不产生关系，无论说什么（包括"我们是好朋友"）', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (const text of ['我们是最好的朋友！', '我送了你一份礼物', '好朋友好朋友好朋友']) {
      a.act('speak', { text });
      t.advanceAlive(11_000, [a, b]);
    }
    expect(rel(t, a, b)).toBeNull();
    expect(t.w.db.scalar('SELECT COUNT(*) FROM relationships')).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'conversation'")).toBe(0);
  });

  it('"有来有往"才算交谈：对方回应了 → 熟悉 +1；字面内容不影响数值', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: '早' });
    expect(rel(t, a, b)).toBeNull();
    b.act('speak', { text: '我讨厌你，再也不要见到你' });
    expect(rel(t, a, b)).toEqual({ familiarity: 1, closeness: 0 });
    expect(rel(t, b, a)).toEqual({ familiarity: 1, closeness: 0 });
    expect(relationsOf(t.w, a.residentId)[0]!.level).toBe('见过面');
    // 交谈没有留下"共同经历"摘要
    expect(t.w.db.scalar('SELECT COUNT(*) FROM memory_refs')).toBe(0);
  });

  it('后来的人没听到之前的话，他的回应不算有来有往', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a);
    a.act('speak', { text: '有人吗' });
    gather('tea_house', b);
    b.act('speak', { text: '我来了' });
    expect(rel(t, a, b)).toBeNull();
    // 之后 a 回应，b 听到了 b 的话 → 才算
    a.act('speak', { text: '欢迎' });
    expect(rel(t, a, b)).toEqual({ familiarity: 1, closeness: 0 });
  });

  it('交谈每对居民每天只有前 3 次有关系收益，刷屏之后不涨', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let i = 0; i < 30; i++) {
      (i % 2 ? b : a).act('speak', { text: `第${i}句` });
      t.advanceAlive(11_000, [a, b]);
    }
    expect(rel(t, a, b)!.familiarity).toBe(3);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'conversation'")).toBe(3);
    // 第二天重新计
    nextDay(t, [a, b]);
    a.act('speak', { text: '早' });
    b.act('speak', { text: '早' });
    expect(rel(t, a, b)!.familiarity).toBe(4);
  });

  // BUG（life.ts:257-266，不是本文件负责）：判断"对方回应了我"只看"对方最近五分钟说过话、而且我听到了"，
  // 没有要求对方的话比我上一句更新。结果是 a 说一句、b 回一句之后，a 连说三句也各算一次"有来有往"，
  // 一个人刷屏（对方只说了一次）就能把当天的 3 次交谈收益刷满。
  // 期望：a1、b1、a2、a3 之中，a3 紧跟在自己的 a2 之后，b 没有新话，不应再产生交谈事实（共 2 次）。
  // 建议补丁：replied 的查询再加一个条件——对方那条消息要晚于我在这个空间说的上一条
  //   AND m.sent_at > COALESCE((SELECT MAX(sent_at) FROM chat_messages WHERE sender_id = ? AND space_id = ?), 0)。
  it('交谈要来回：自己连说几句、对方没有新话，后面的不算', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('speak', { text: 'a1' });
    b.act('speak', { text: 'b1' });
    for (const text of ['a2', 'a3', 'a4']) {
      t.advanceAlive(11_000, [a, b]);
      a.act('speak', { text });
    }
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'conversation'")).toBe(2);
  });

  // 设计文档第 5 节：亲近程度允许双方不同，不因为一方送礼就强制另一方喜欢她
  it('送礼只提高送礼人对收礼人的亲近，收礼人这一边不被强制提高', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(rel(t, a, b)!.closeness).toBe(2);
    expect(rel(t, b, a)!.closeness).toBe(0);
  });

  it('送礼被接受：熟悉 +1、亲近 +2，双方各留一条共同经历；没被接受不算', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'seeds', qty: 1 }] } });
    expect(rel(t, a, b)).toBeNull(); // 只是提议
    b.act('accept_offer', { offerId: o.offer.id });
    expect(rel(t, a, b)).toEqual({ familiarity: 1, closeness: 2 });
    expect(rel(t, b, a)).toEqual({ familiarity: 1, closeness: 0 });
    expect(relationsOf(t.w, b.residentId)[0]!.memories.map((m) => m.text)).toEqual(['送礼：1 份花种']);
    const o2 = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 3 } });
    b.act('decline_offer', { offerId: o2.offer.id });
    const o3 = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 3 } });
    a.act('cancel_offer', { offerId: o3.offer.id });
    expect(rel(t, a, b)!.familiarity).toBe(1);
    checkInvariants(t);
  });

  it('同一对居民每天送礼前 3 次有收益，第 4 次起只有礼物转手，没有关系变化', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let i = 0; i < 5; i++) {
      const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
      b.act('accept_offer', { offerId: o.offer.id });
      t.advanceAlive(15_000, [a, b]);
    }
    expect(b.coins()).toBe(25); // 礼物都收到了
    expect(rel(t, a, b)).toEqual({ familiarity: 3, closeness: 6 });
    nextDay(t, [a, b]);
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(rel(t, a, b)).toEqual({ familiarity: 4, closeness: 8 });
    checkInvariants(t);
  });

  it('来回送同一种东西不加分：只有第一次有收益；换一种东西才算新的', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 });
    b.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 });
    const give = (from: Actor, to: Actor, items: { type: string; qty: number }[]) => {
      const o = from.act('offer', { kind: 'gift', to: to.residentId, give: { items } });
      to.act('accept_offer', { offerId: o.offer.id });
      t.advanceAlive(15_000, [a, b]);
    };
    give(a, b, [{ type: 'cookie', qty: 1 }]);
    expect(rel(t, a, b)).toEqual({ familiarity: 1, closeness: 2 });
    give(b, a, [{ type: 'cookie', qty: 1 }]); // 回送同一种
    give(a, b, [{ type: 'cookie', qty: 1 }]);
    give(b, a, [{ type: 'cookie', qty: 1 }]);
    expect(rel(t, a, b)).toEqual({ familiarity: 1, closeness: 2 });
    // 回送另一种东西，是新的往来
    give(b, a, [{ type: 'seeds', qty: 1 }]);
    // 亲近只记在送礼的人这边：这次是小岚送的，所以涨的是小岚对阿灯的亲近
    expect(rel(t, a, b)).toEqual({ familiarity: 2, closeness: 2 });
    expect(rel(t, b, a)).toEqual({ familiarity: 2, closeness: 2 });
    // 礼物都真实转了手
    expect([a.qty('cookie'), b.qty('cookie')]).toEqual([2, 2]);
    // 硬币来回也一样
    give2coins(t, a, b);
    checkInvariants(t);

    function give2coins(tt: Town, x: Actor, y: Actor) {
      const before = rel(tt, x, y)!.familiarity;
      for (const [f, to] of [[x, y], [y, x], [x, y]] as const) {
        const o = f.act('offer', { kind: 'gift', to: to.residentId, give: { coins: 2 } });
        to.act('accept_offer', { offerId: o.offer.id });
        tt.advanceAlive(15_000, [x, y]);
      }
      expect(rel(tt, x, y)!.familiarity).toBe(before + 1);
    }
  });

  it('多件礼物回送时，只要有一种是新的就算新往来', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const send = (f: Actor, to: Actor, items: { type: string; qty: number }[]) => {
      const o = f.act('offer', { kind: 'gift', to: to.residentId, give: { items } });
      to.act('accept_offer', { offerId: o.offer.id });
    };
    send(a, b, [{ type: 'seeds', qty: 1 }]);
    send(b, a, [{ type: 'seeds', qty: 1 }, { type: 'tea_leaves', qty: 1 }]); // 带了新种类
    expect(rel(t, a, b)!.familiarity).toBe(2);
  });

  it('交换：熟悉 +1，不加亲近；每天前 3 次，来回换同一种东西刷不出更多', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let i = 0; i < 6; i++) {
      const [f, to] = i % 2 ? [b, a] : [a, b];
      const o = f.act('offer', { kind: 'trade', to: to.residentId, give: { items: [{ type: 'tea_leaves', qty: 1 }] }, want: { items: [{ type: 'seeds', qty: 1 }] } });
      to.act('accept_offer', { offerId: o.offer.id });
      t.advanceAlive(15_000, [a, b]);
    }
    expect(rel(t, a, b)).toEqual({ familiarity: 3, closeness: 0 });
    expect(relationsOf(t.w, a.residentId)[0]!.memories).toHaveLength(3);
    checkInvariants(t);
  });

  it('出借与归还：借出 +1；还回 +2 亲近；书屋的藏书不涉及另一位居民，不产生关系', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const book = a.view().inventory.items.find((i) => i.type === 'book')!.itemId;
    const o = a.act('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId: book }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(rel(t, a, b)).toEqual({ familiarity: 1, closeness: 0 });
    b.act('return_item', { itemId: book });
    expect(rel(t, a, b)).toEqual({ familiarity: 2, closeness: 2 });
    expect(relationsOf(t.w, a.residentId)[0]!.memories.map((m) => m.text)).toEqual([expect.stringContaining('还回去了'), expect.stringContaining('借出了')]);
    // 书屋
    const c = t.join('阿木');
    c.go('bookshop');
    const id = c.act('borrow_book', { bookId: 'rain_lane' }).itemId;
    c.act('return_item', { itemId: id });
    expect(relationsOf(t.w, c.residentId)).toEqual([]);
  });

  it('一起完成共同活动：熟悉 +2、亲近 +1，指向实际事件的共同经历；一个人做不产生关系', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('阿木');
    gather('tea_house', a, b, c);
    near('tea_house:table1', a, b, c);
    const ix = a.act('start_interaction', { objectId: 'tea_house:table1', wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    c.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    t.advanceAlive(10 * MIN + 2000, [a, b, c]);
    for (const [x, y] of [[a, b], [a, c], [b, c]] as const) expect(rel(t, x, y), `${x.name}→${y.name}`).toEqual({ familiarity: 2, closeness: 1 });
    const refs = relationsOf(t.w, a.residentId).find((r) => r.id === b.residentId)!.memories;
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text).toContain('喝茶');
    const ev = t.w.db.get("SELECT event_id FROM world_events WHERE type = 'interaction_completed'")!;
    expect(t.w.db.all('SELECT event_id FROM memory_refs').every((r) => r.event_id === ev.event_id)).toBe(true);
    // 一个人读书：没有关系变化
    gather('bookshop', a);
    const before = JSON.stringify(t.w.db.all('SELECT * FROM relationships ORDER BY resident_id, other_id'));
    near('bookshop:shelf', a);
    a.act('start_interaction', { objectId: 'bookshop:shelf' });
    t.advanceAlive(10 * MIN + 2000, [a, b, c]);
    expect(JSON.stringify(t.w.db.all('SELECT * FROM relationships ORDER BY resident_id, other_id'))).toBe(before);
  });

  it('同一对居民同一种共同活动每天前 3 次有关系收益', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    near('tea_house:table1', a, b);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 3 });
    for (let i = 0; i < 5; i++) {
      const ix = a.act('start_interaction', { objectId: 'tea_house:table1', wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      t.advanceAlive(10 * MIN + 2000, [a, b]);
    }
    expect(rel(t, a, b)).toEqual({ familiarity: 6, closeness: 3 });
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'interaction_completed'")).toBe(5);
    checkInvariants(t);
  });

  it('一起打完一局：熟悉 +2', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('arcade:table1', a, b);
    playBomb(t, a, b);
    expect(a.view().context.activityId).toBeNull();
    expect(rel(t, a, b)).toEqual({ familiarity: 2, closeness: 0 });
    expect(relationsOf(t.w, a.residentId)[0]!.memories[0]!.text).toContain('一起玩了一局');
    checkInvariants(t);
  });

  it('当面问爱好：熟悉 +2；每天前 3 次；对方关掉后问不了', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent', { interests: ['books', 'tea'] });
    for (let i = 0; i < 5; i++) {
      a.act('ask_hobby', { target: b.residentId });
      t.advanceAlive(31_000, [a, b]);
    }
    expect(rel(t, a, b)).toEqual({ familiarity: 6, closeness: 0 });
    expect(relationsOf(t.w, a.residentId)[0]!.memories[0]!.text).toBe('聊到爱好：书籍、茶');
    b.act('update_profile', { allowAskHobby: false });
    expect(a.fail('ask_hobby', { target: b.residentId }).reason).toBe('declined');
  });

  it('寄信：熟悉 +1，每天前 3 封有收益（不涉及聊天文字）', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let i = 0; i < 5; i++) a.act('send_letter', { to: b.residentId, body: `第 ${i} 封` });
    expect(rel(t, a, b)).toEqual({ familiarity: 3, closeness: 0 });
  });

  it('关系只存在于本人视角：relationsOf 只返回本人的关系和本人的共同经历', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('阿木');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 2 } });
    b.act('accept_offer', { offerId: o.offer.id });
    const o2 = a.act('offer', { kind: 'gift', to: c.residentId, give: { coins: 2 } });
    c.act('accept_offer', { offerId: o2.offer.id });
    expect(relationsOf(t.w, a.residentId).map((r) => r.name).sort()).toEqual(['小岚', '阿木']);
    expect(relationsOf(t.w, b.residentId).map((r) => r.name)).toEqual(['阿灯']);
    expect(relationsOf(t.w, c.residentId).map((r) => r.name)).toEqual(['阿灯']);
    // b 看不到 a 和 c 之间的往事，也没有关于 c 的任何信息
    expect(JSON.stringify(relationsOf(t.w, b.residentId))).not.toContain('阿木');
    // 按熟悉度排序、limit 生效
    expect(relationsOf(t.w, a.residentId, 1)).toHaveLength(1);
    // 没有往来的人是空
    const d = t.join('阿雪');
    expect(relationsOf(t.w, d.residentId)).toEqual([]);
    // 视图里不暴露全镇关系矩阵：meView 里没有别人的关系
    expect(JSON.stringify(d.view())).not.toContain(a.residentId + ':' + b.residentId);
  });

  it('共同经历按 activeMemoryItems 取最近几条，存储只保留最近的一小段', () => {
    const t = quietTown({ params: { activeMemoryItems: 1 } });
    const a = t.join('阿灯', 'human', { interests: ['books'] });
    const b = t.join('小岚', 'agent', { interests: ['books'] });
    // 四类往来各一次：送礼 / 交换 / 问爱好 / 一起读书
    const g = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    b.act('accept_offer', { offerId: g.offer.id });
    const tr = a.act('offer', { kind: 'trade', to: b.residentId, give: { coins: 1 }, want: { items: [{ type: 'seeds', qty: 1 }] } });
    b.act('accept_offer', { offerId: tr.offer.id });
    a.act('ask_hobby', { target: b.residentId });
    gather('bookshop', a, b);
    near('bookshop:shelf', a, b);
    const ix = a.act('start_interaction', { objectId: 'bookshop:shelf', wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    t.advanceAlive(10 * MIN + 2000, [a, b]);
    const stored = t.w.db.scalar('SELECT COUNT(*) FROM memory_refs WHERE owner_id = ? AND other_id = ?', a.residentId, b.residentId);
    expect(stored).toBe(3); // 4 条里留最近 3 条
    const shown = relationsOf(t.w, a.residentId)[0]!.memories;
    expect(shown).toHaveLength(1);
    expect(shown[0]!.text).toContain('读');
  });

  it('关系从事实读取：事实表里每条共同经历都能追溯到真实事件', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 2 } });
    b.act('accept_offer', { offerId: o.offer.id });
    for (const m of t.w.db.all('SELECT event_id, kind FROM memory_refs')) {
      const ev = t.w.db.get('SELECT type FROM world_events WHERE event_id = ?', m.event_id);
      expect(ev?.type).toBe(m.kind);
    }
  });
});

// ───────────────────────── 愿望 ─────────────────────────

describe('愿望：生成与定义副本', () => {
  it('每位新居民一个长期、两个短期，奖励 8 / 2，进度从 0 开始（拥有类的从当前数量算起）', () => {
    const t = town();
    const a = t.join('阿灯');
    const goals = a.view().goals;
    expect(goals.filter((g) => g.kind === 'long')).toHaveLength(1);
    expect(goals.filter((g) => g.kind === 'short')).toHaveLength(2);
    for (const g of goals) {
      expect(g.status).toBe('active');
      expect(g.reward).toBe(g.kind === 'long' ? 8 : 2);
      expect(g.target).toBeGreaterThan(0);
      if (g.title !== '建立自己的小书架') expect(g.progress).toBe(0);
    }
    // 新手物资里有一本书：拥有书的愿望一开始就是 1/3
    for (let i = 0; i < 30; i++) {
      const x = t.join(`居民${i}`, 'agent');
      const own = x.view().goals.find((g) => g.title === '建立自己的小书架');
      if (own) {
        expect(own).toMatchObject({ progress: 1, target: 3 });
        return;
      }
    }
  });

  it('愿望数量参数可调（0 个就是 0 个）', () => {
    const t = quietTown();
    expect(t.join('阿灯').view().goals).toEqual([]);
    const t2 = town({ params: { longGoals: 2, shortGoals: 3 } });
    const b = t2.join('阿灯');
    expect(b.view().goals.filter((g) => g.kind === 'long')).toHaveLength(2);
    expect(b.view().goals.filter((g) => g.kind === 'short')).toHaveLength(3);
    // 同时拥有的愿望来自不同的定义
    const defs = t2.w.db.all("SELECT def_id FROM resident_goals WHERE resident_id = ? AND status = 'active'", b.residentId).map((r) => r.def_id);
    expect(new Set(defs).size).toBe(defs.length);
  });

  it('保存创建时的定义副本：内容之后更新，已有愿望的要求不变', () => {
    const t = town();
    const a = t.join('阿灯');
    const id = giveGoal(t, a, 'write_letter');
    const b = t.join('小岚', 'agent');
    const def = GOALS.find((g) => g.id === 'write_letter')! as { count: number; title: string };
    const old = { count: def.count, title: def.title };
    try {
      def.count = 5;
      def.title = '新版标题';
      const view = goalsOf(t.w, a.residentId).find((g) => g.id === id)!;
      expect(view).toMatchObject({ title: '写一封信', target: 1 });
      a.act('send_letter', { to: b.residentId, body: '你好' });
      expect(goalRow(t, id).status).toBe('completed'); // 按旧要求 1 次就完成
    } finally {
      def.count = old.count;
      def.title = old.title;
    }
  });

  it('没有来源的愿望不生成：没有可嵌入的小游戏就没有"玩一局"；没有做汤活动就没有做汤愿望', () => {
    const savedGames = [...EMBEDDED_GAMES];
    const savedIx = [...INTERACTIONS];
    try {
      (EMBEDDED_GAMES as unknown[]).length = 0;
      (INTERACTIONS as unknown[]).splice(0, INTERACTIONS.length, ...INTERACTIONS.filter((i) => i.id !== 'cook_soup'));
      const t = town({ params: { activeResidentLimit: 200 } });
      const defs = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const a = t.join(`居民${i}`, 'agent');
        for (const r of t.w.db.all('SELECT def_id FROM resident_goals WHERE resident_id = ?', a.residentId)) defs.add(r.def_id);
      }
      expect(defs.has('play_game')).toBe(false);
      expect(defs.has('cook_once')).toBe(false);
      expect(defs.has('good_soup')).toBe(false);
      expect(defs.has('write_letter')).toBe(true); // 其他愿望照常
    } finally {
      (EMBEDDED_GAMES as unknown[]).splice(0, EMBEDDED_GAMES.length, ...savedGames);
      (INTERACTIONS as unknown[]).splice(0, INTERACTIONS.length, ...savedIx);
    }
  });

  it('去某处走走的愿望：目标地点在创建时选定，不是当前所在地，也不是广场', () => {
    const t = town({ params: { activeResidentLimit: 200 } });
    let seen = 0;
    for (let i = 0; i < 40 && seen < 3; i++) {
      const a = t.join(`居民${i}`, 'agent');
      for (const r of t.w.db.all("SELECT def_json FROM resident_goals WHERE resident_id = ? AND def_id = 'visit_place'", a.residentId)) {
        const def = JSON.parse(r.def_json);
        expect(def.place).toBeDefined();
        expect(def.place).not.toBe('plaza');
        // 候选只来自可以当目的地的公共地点：灯笼路只是路过，会馆是住宅接入点，都不出现
        expect(['tea_house', 'bookshop', 'kitchen', 'garden', 'arcade']).toContain(def.place);
        expect(def.paths[0].where.place).toBe(def.place);
        expect(def.title).not.toContain('$');
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('愿望：进度只来自结构化事实，完成只结算一次', () => {
  it('聊天里说"我写了信 / 我送了礼"不推进进度；真正的动作才推进，并给本人发 goal 事件', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const id = giveGoal(t, a, 'write_letter');
    const cursor = a.events().cursor;
    a.act('speak', { text: '我已经写了一封信寄给小岚了！' });
    b.act('speak', { text: '收到了' });
    expect(goalRow(t, id)).toMatchObject({ status: 'active' });
    expect(JSON.parse(goalRow(t, id).progress_json).count).toBe(0);
    a.act('send_letter', { to: b.residentId, body: '真的寄了' });
    expect(goalRow(t, id).status).toBe('completed');
    const ev = a.events(cursor).events.filter((e) => e.type === 'goal');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ completed: true, reward: 2 });
  });

  it('完成发奖励（短期 2 / 长期 8 枚），状态改为 completed，同一事实不会重复发', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const id = giveGoal(t, a, 'write_letter');
    const before = a.coins();
    a.act('send_letter', { to: b.residentId, body: '一' });
    expect(a.coins()).toBe(before + 2);
    expect(goalCoins(t, a)).toBe(2);
    expect(goalRow(t, id)).toMatchObject({ status: 'completed' });
    expect(goalRow(t, id).completion_event_id).not.toBeNull();
    // 再寄信：愿望已经完成，不再发奖励
    a.act('send_letter', { to: b.residentId, body: '二' });
    expect(a.coins()).toBe(before + 2);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = ?", `goal:${id}`)).toBe(1);
    expect(goalsOf(t.w, a.residentId).find((g) => g.id === id)).toBeUndefined(); // 不再出现在进行中的愿望里
    checkInvariants(t);
  });

  it('完成只结算一次：重启之后再来同样的事实也不再发奖励', () => {
    const db = tempDb();
    try {
      const t = quietTown({ dbPath: db.path });
      const a = t.join('阿灯');
      const b = t.join('小岚', 'agent');
      const id = giveGoal(t, a, 'write_letter');
      a.act('send_letter', { to: b.residentId, body: '一' });
      const coins = a.coins();
      t.opts.seed = 'soc-restart';
      t.restart();
      a.enter();
      b.enter();
      a.act('send_letter', { to: b.residentId, body: '二' });
      t.advance(HOUR);
      a.enter();
      expect(a.coins()).toBe(coins);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = ?", `goal:${id}`)).toBe(1);
      checkInvariants(t);
    } finally {
      db.cleanup();
    }
  });

  it('一条事实同时满足两个愿望：各自结算一次', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    giveGoal(t, a, 'ask_hobby');
    giveGoal(t, a, 'meet_neighbors', { replaceAll: false, kind: 'long' });
    const before = a.coins();
    a.act('ask_hobby', { target: b.residentId });
    expect(a.coins()).toBe(before + 2); // ask_hobby 完成；meet_neighbors 才 1/3
    expect(a.view().goals).toHaveLength(1);
    expect(a.view().goals[0]).toMatchObject({ title: '认识不同的居民', progress: 1, target: 3 });
  });

  it('按"不同的人"计数的愿望：同一个人再来不加；被问的一方（非 asker）不因此推进；三位不同的人完成并得到长期奖励和称号', () => {
    const t = quietTown();
    const [a, b, c, d] = ['阿灯', '小岚', '阿木', '阿青'].map((n, i) => t.join(n, i % 2 ? 'agent' : 'human')) as [Actor, Actor, Actor, Actor];
    const id = giveGoal(t, a, 'meet_neighbors');
    const idB = giveGoal(t, b, 'meet_neighbors');
    const ask = (x: Actor, y: Actor) => {
      x.act('ask_hobby', { target: y.residentId });
      t.advanceAlive(31_000, [a, b, c, d]);
    };
    ask(a, b);
    ask(a, b);
    expect(a.view().goals[0]!.progress).toBe(1);
    // b 被问，不是 asker：这条路径不推进
    expect(JSON.parse(goalRow(t, idB).progress_json).partners).toEqual([]);
    ask(a, c);
    expect(a.view().goals[0]!.progress).toBe(2);
    const before = a.coins();
    ask(a, d);
    expect(goalRow(t, id).status).toBe('completed');
    expect(a.coins()).toBe(before + 8);
    expect(a.view().me.titles).toEqual(['镇上的熟面孔']);
    expect(titlesOf(t.w, a.residentId, true)).toEqual(['镇上的熟面孔']);
    // 称号是公开的，别人在居民名录里看得到
    expect(directory(t.w, t.clock.t).find((r) => r.id === a.residentId)!.titles).toEqual(['镇上的熟面孔']);
    // 还没完成的人没有称号
    expect(directory(t.w, t.clock.t).find((r) => r.id === c.residentId)!.titles).toEqual([]);
    checkInvariants(t);
  });

  it('称号只写事实，不点名别人，也没有未替换的占位符', () => {
    for (const g of GOALS) {
      if (!g.title_award) continue;
      expect(g.title_award).not.toMatch(/\$|\{|\}|undefined/);
      expect(g.title_award.length).toBeLessThanOrEqual(12);
    }
    const awards = GOALS.map((g) => g.title_award).filter(Boolean);
    expect(new Set(awards).size).toBe(awards.length);
  });

  it('拥有类愿望：买书、收到书算数，借来的书不算；达到 3 本完成，称号只给一次', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const id = giveGoal(t, a, 'own_bookshelf');
    expect(a.view().goals[0]).toMatchObject({ progress: 1, target: 3 });
    a.go('bookshop');
    a.act('borrow_book', { bookId: 'slow_fire' });
    a.act('borrow_book', { bookId: 'rain_lane' });
    expect(a.view().goals[0]!.progress).toBe(1); // 借来的不算
    a.act('buy', { shop: 'book_counter', sku: 'book:polite_dice' });
    expect(a.view().goals[0]!.progress).toBe(2);
    expect(a.view().goals[0]!.status).toBe('active');
    const before = a.coins();
    b.go('bookshop');
    const o = b.act('offer', { kind: 'gift', to: a.residentId, give: { items: [{ itemId: b.view().inventory.items.find((i) => i.type === 'book')!.itemId }] } });
    a.act('accept_offer', { offerId: o.offer.id });
    expect(goalRow(t, id).status).toBe('completed');
    expect(a.coins()).toBe(before + 8);
    expect(titlesOf(t.w, a.residentId, true)).toEqual(['小书架的主人']);
    // 继续买书，不会再次完成或重复称号
    a.act('buy', { shop: 'book_counter', sku: 'book:gardener_notes' });
    expect(a.coins()).toBe(before + 8 - 6);
    expect(titlesOf(t.w, a.residentId, true)).toEqual(['小书架的主人']);
    expect(goalCoins(t, a)).toBe(8);
    checkInvariants(t);
  });

  it('归还借来的东西：书屋还书推进"借一本书再还回去"，出借人不推进', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const ga = giveGoal(t, a, 'return_borrowed');
    const gb = giveGoal(t, b, 'return_borrowed');
    // a 借出书给 b，b 还回来：b（borrower）完成，a（owner）不完成
    const book = a.view().inventory.items.find((i) => i.type === 'book')!.itemId;
    const o = a.act('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId: book }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(goalRow(t, gb).status).toBe('active'); // 只借不还不算
    b.act('return_item', { itemId: book });
    expect(goalRow(t, gb).status).toBe('completed');
    expect(goalRow(t, ga).status).toBe('active');
    // 书屋
    const c = t.join('阿木');
    const gc = giveGoal(t, c, 'return_borrowed');
    c.go('bookshop');
    const id = c.act('borrow_book', { bookId: 'rain_lane' }).itemId;
    expect(goalRow(t, gc).status).toBe('active');
    c.act('return_item', { itemId: id });
    expect(goalRow(t, gc).status).toBe('completed');
  });

  it('去某地走走：只有到达选定的地点才算', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const id = giveGoal(t, a, 'visit_place', { place: 'garden' });
    a.go('tea_house');
    expect(goalRow(t, id).status).toBe('active');
    a.go('garden');
    expect(goalRow(t, id).status).toBe('completed');
  });

  it('去某地走走：路过的区域（灯笼路、中途经过的地点）不算到达；走到一半停下也不算', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const id = giveGoal(t, a, 'visit_place', { place: 'tea_house' });
    const arrivedPlaces = () => t.w.db.all("SELECT payload FROM world_events WHERE type = 'arrived'").map((r) => JSON.parse(String(r.payload)).place as string);
    // 广场 -> 花园要经过灯笼路：路过不记「到过」
    a.go('garden');
    expect(goalRow(t, id).status).toBe('active');
    expect(arrivedPlaces()).toEqual(['garden']);
    // 往茶馆走，在路上停下：导航没走完，不记
    a.act('navigate', { to: 'tea_house' });
    t.advanceAlive(2_000, [a]);
    a.act('stop_navigation');
    expect(a.view().location.space).not.toBe('tea_house');
    expect(goalRow(t, id).status).toBe('active');
    expect(arrivedPlaces()).toEqual(['garden']);
    a.go('tea_house');
    expect(goalRow(t, id).status).toBe('completed');
  });

  it('共同活动类愿望：一个人做汤算"做一锅汤"，但不算"和人一起做件事"', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const cook = giveGoal(t, a, 'cook_once');
    const shared = giveGoal(t, a, 'join_shared', { replaceAll: false });
    a.go('kitchen');
    near('kitchen:stove1', a);
    a.act('start_interaction', { objectId: 'kitchen:stove1' });
    t.advanceAlive(5 * MIN + 2000, [a]);
    expect(goalRow(t, cook).status).toBe('completed');
    expect(goalRow(t, shared).status).toBe('active');
  });

  it('活动取消、中途退出都不推进活动类愿望', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const id = giveGoal(t, a, 'join_shared');
    gather('tea_house', a, b);
    near('tea_house:table1', a, b);
    const ix = a.act('start_interaction', { objectId: 'tea_house:table1', wait: true }).interaction;
    a.act('leave_interaction');
    expect(goalRow(t, id).status).toBe('active');
    const ix2 = a.act('start_interaction', { objectId: 'tea_house:table1', wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix2.id });
    a.act('begin_interaction', { interactionId: ix2.id });
    a.act('leave_interaction');
    t.advanceAlive(10 * MIN + 2000, [a, b]);
    expect(goalRow(t, id).status).toBe('active'); // 人数不足两人，不算共同
    void ix;
  });

  it('打完一局算"玩一局小游戏"，输赢都算', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const ga = giveGoal(t, a, 'play_game');
    const gb = giveGoal(t, b, 'play_game');
    gather('arcade:table1', a, b);
    playBomb(t, a, b);
    expect(goalRow(t, ga).status).toBe('completed');
    expect(goalRow(t, gb).status).toBe('completed');
  });
});

describe('愿望：更换、补满与称号', () => {
  it('每天可以换一个短期愿望，第二次被拒；换出来的是另一种愿望；长期愿望和别人的愿望换不了', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const [short1, short2] = a.view().goals.filter((g) => g.kind === 'short');
    const long = a.view().goals.find((g) => g.kind === 'long')!;
    const oldDef = t.w.db.get('SELECT def_id FROM resident_goals WHERE goal_id = ?', short1!.id)!.def_id;
    const coins = a.coins();
    const out = a.act('replace_goal', { goalId: short1!.id });
    expect(out.goals).toHaveLength(3);
    expect(goalRow(t, short1!.id).status).toBe('replaced');
    const now = a.view().goals;
    expect(now.filter((g) => g.kind === 'short')).toHaveLength(2);
    expect(now.find((g) => g.id === short1!.id)).toBeUndefined();
    expect(t.w.db.all("SELECT def_id FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = 'short'", a.residentId).map((r) => r.def_id)).not.toContain(oldDef);
    expect(a.coins()).toBe(coins); // 换愿望不花钱也不得奖励
    expect(a.fail('replace_goal', { goalId: short2!.id }).reason).toBe('daily_limit');
    expect(a.fail('replace_goal', { goalId: long.id }).reason).toBe('not_replaceable');
    expect(a.fail('replace_goal', { goalId: 'nope' }).reason).toBe('no_such_goal');
    expect(a.fail('replace_goal', { goalId: b.view().goals[0]!.id }).reason).toBe('no_such_goal');
    // 第二天又可以换
    nextDay(t, [a, b]);
    const fresh = a.view().goals.find((g) => g.kind === 'short')!;
    a.act('replace_goal', { goalId: fresh.id });
    checkInvariants(t);
  });

  it('被拒绝的更换什么都不改（失败时愿望原样保留）', () => {
    const t = town();
    const a = t.join('阿灯');
    const [s1, s2] = a.view().goals.filter((g) => g.kind === 'short');
    a.act('replace_goal', { goalId: s1!.id });
    const snap = JSON.stringify(t.w.db.all('SELECT goal_id, status FROM resident_goals WHERE resident_id = ? ORDER BY goal_id', a.residentId));
    a.fail('replace_goal', { goalId: s2!.id });
    expect(JSON.stringify(t.w.db.all('SELECT goal_id, status FROM resident_goals WHERE resident_id = ? ORDER BY goal_id', a.residentId))).toBe(snap);
  });

  it('同一个请求号重放换愿望，不会换第二个', () => {
    const t = town();
    const a = t.join('阿灯');
    const s1 = a.view().goals.find((g) => g.kind === 'short')!;
    a.act('replace_goal', { goalId: s1.id }, { requestId: 'replace-0001' });
    const again = a.act('replace_goal', { goalId: s1.id }, { requestId: 'replace-0001' });
    expect(again.replayed).toBe(true);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM resident_goals WHERE resident_id = ? AND status = 'replaced'", a.residentId)).toBe(1);
  });

  it('完成一个短期愿望后当天不会无限续上，第二天补满到 1 长 2 短', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    giveGoal(t, a, 'write_letter');
    giveGoal(t, a, 'ask_hobby', { replaceAll: false });
    a.act('send_letter', { to: b.residentId, body: '一' });
    expect(a.view().goals.filter((g) => g.kind === 'short')).toHaveLength(1);
    // 同一天内不会因为完成而立刻补上新的
    a.act('speak', { text: '嗨' });
    expect(a.view().goals.filter((g) => g.kind === 'short')).toHaveLength(1);
    // 第二天（0 点后）补满，不需要上线；很久不来的人等回来时补
    t.advance(18 * HOUR);
    expect(goalsOf(t.w, a.residentId).filter((g) => g.kind === 'short')).toHaveLength(2);
    expect(goalsOf(t.w, a.residentId).filter((g) => g.kind === 'long')).toHaveLength(1);
  });

  it('离开很多天再回来：回来时才补愿望，不会堆积多天', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    giveGoal(t, a, 'write_letter');
    a.act('send_letter', { to: b.residentId, body: '一' });
    expect(goalsOf(t.w, a.residentId)).toHaveLength(0);
    t.advance(6 * 24 * HOUR);
    expect(goalsOf(t.w, a.residentId)).toHaveLength(0); // 太久没来，不替他生成
    a.enter();
    expect(goalsOf(t.w, a.residentId).filter((g) => g.kind === 'short')).toHaveLength(2);
    expect(goalsOf(t.w, a.residentId).filter((g) => g.kind === 'long')).toHaveLength(1);
    a.enter();
    expect(goalsOf(t.w, a.residentId)).toHaveLength(3); // 重复进入不会多补
  });

  it('长期愿望完成后，新的长期愿望不会重复已经完成过的那个', () => {
    const t = town({ params: { longGoals: 1 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const done = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const long = t.w.db.get("SELECT goal_id, def_id FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = 'long'", a.residentId)!;
      done.add(long.def_id);
      t.w.db.run("UPDATE resident_goals SET status = 'completed', completed_at = ? WHERE goal_id = ?", t.clock.t, long.goal_id);
      nextDay(t, [a, b]);
      const next = t.w.db.get("SELECT def_id FROM resident_goals WHERE resident_id = ? AND status = 'active' AND kind = 'long'", a.residentId);
      expect(next, `第 ${round} 轮没有补上新的长期愿望`).toBeDefined();
      expect(done.has(next!.def_id)).toBe(false);
    }
  });

  it('称号保留在完成之后：同一个称号只记一次', () => {
    const t = quietTown();
    const a = t.join('阿灯');
    t.w.db.run("INSERT OR IGNORE INTO titles(resident_id, title, visibility, source, awarded_at) VALUES (?,?,'public','x',1)", a.residentId, '小书架的主人');
    t.w.db.run("INSERT OR IGNORE INTO titles(resident_id, title, visibility, source, awarded_at) VALUES (?,?,'public','x',2)", a.residentId, '小书架的主人');
    expect(titlesOf(t.w, a.residentId, false)).toEqual(['小书架的主人']);
  });
});

// ───────────────────────── 防刷 ─────────────────────────

describe('防刷：两个居民互相刷', () => {
  it('互刷礼物 / 交谈 / 共同活动 / 问爱好一整天：关系收益封顶，硬币总量不变，需要收益在 3 次之后减半', () => {
    const t = quietTown();
    const a = t.join('阿灯', 'human', { interests: ['tea'] });
    const b = t.join('小岚', 'agent', { interests: ['tea'] });
    gather('tea_house', a, b);
    near('tea_house:table1', a, b);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 5 });
    const coins0 = a.coins() + b.coins();
    // 交谈刷屏
    for (let i = 0; i < 20; i++) {
      (i % 2 ? b : a).act('speak', { text: `嗨${i}` });
      t.advanceAlive(11_000, [a, b]);
    }
    // 礼物来回
    for (let i = 0; i < 10; i++) {
      const [f, to] = i % 2 ? [b, a] : [a, b];
      const o = f.act('offer', { kind: 'gift', to: to.residentId, give: { items: [{ type: 'tea_leaves', qty: 1 }] } });
      to.act('accept_offer', { offerId: o.offer.id });
      t.advanceAlive(15_000, [a, b]);
    }
    // 硬币来回
    for (let i = 0; i < 10; i++) {
      const [f, to] = i % 2 ? [b, a] : [a, b];
      const o = f.act('offer', { kind: 'gift', to: to.residentId, give: { coins: 2 } });
      to.act('accept_offer', { offerId: o.offer.id });
      t.advanceAlive(15_000, [a, b]);
    }
    // 问爱好
    for (let i = 0; i < 8; i++) {
      a.act('ask_hobby', { target: b.residentId });
      b.act('ask_hobby', { target: a.residentId });
      t.advanceAlive(61_000, [a, b]);
    }
    // 一起喝茶 8 次（社交）
    const social: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = a.view().me.needs.social;
      const ix = a.act('start_interaction', { objectId: 'tea_house:table1', wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      t.advanceAlive(10 * MIN + 2000, [a, b]);
      social.push(a.view().me.needs.social - before);
      if (i === 4) a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 5 });
    }
    // 关系：交谈 3 次(+3)、礼物类 1(同种往返)+1(硬币往返)=2 次(+2)、问爱好 3 次(+6)、喝茶 3 次(+6)
    const r = rel(t, a, b)!;
    expect(r.familiarity).toBe(3 + 2 + 6 + 6);
    expect(r.closeness).toBe(2 * 2 + 3 * 1);
    // 需要收益 10,10,10,5,5,... （社交最高 100，起始 60：会被 100 截断，所以只看没截断的前几次）
    expect(social.slice(0, 3)).toEqual([10, 10, 10]);
    expect(social[3]).toBeLessThanOrEqual(5);
    // 硬币：只在两人之间转，总量只因茶叶购买减少
    expect(a.coins() + b.coins()).toBe(coins0 - 5 * 2);
    // 关系值上没有超过封顶
    expect(r.familiarity).toBeLessThanOrEqual(100);
    checkInvariants(t);
  });

  it('开着愿望一整天刷：愿望奖励有界（每个愿望只一次，短期愿望当天不续），不会凭空增发硬币', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    near('tea_house:table1', a, b);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 6 });
    const coins0 = a.coins() + b.coins();
    for (let i = 0; i < 6; i++) {
      const ix = a.act('start_interaction', { objectId: 'tea_house:table1', wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      t.advanceAlive(10 * MIN + 2000, [a, b]);
      a.act('ask_hobby', { target: b.residentId });
      b.act('ask_hobby', { target: a.residentId });
      for (const [x, y] of [[a, b], [b, a]] as const) {
        const o = x.act('offer', { kind: 'gift', to: y.residentId, give: { coins: 1 } });
        y.act('accept_offer', { offerId: o.offer.id });
      }
      t.advanceAlive(61_000, [a, b]);
      a.act('send_letter', { to: b.residentId, body: `信${i}` });
    }
    // 每人最多 2 个短期 + 1 个长期（当天不续）：奖励上限 2*2+8
    for (const x of [a, b]) expect(goalCoins(t, x)).toBeLessThanOrEqual(12);
    const minted = t.w.db.scalar("SELECT COALESCE(SUM(e.delta),0) FROM ledger_entries e JOIN ledger_transactions x ON x.transaction_id = e.transaction_id WHERE e.account_id = 'sys:mint'");
    expect(-minted).toBe(40 + goalCoins(t, a) + goalCoins(t, b));
    expect(a.coins() + b.coins()).toBe(coins0 + goalCoins(t, a) + goalCoins(t, b));
    checkInvariants(t);
  });

  it('每天新建的愿望有上限：不管完成多少，每个世界日每人最多新建 2 个短期、1 个长期', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let day = 0; day < 3; day++) {
      for (let i = 0; i < 4; i++) {
        // 把进行中的愿望全部换成"寄信就完成"的，连续完成
        for (const g of a.view().goals.filter((x) => x.kind === 'short')) t.w.db.run("UPDATE resident_goals SET status = 'replaced' WHERE goal_id = ?", g.id);
        giveGoal(t, a, 'write_letter', { replaceAll: false });
        a.act('send_letter', { to: b.residentId, body: `d${day}-${i}` });
        t.advanceAlive(31_000, [a, b]);
      }
      nextDay(t, [a, b]);
    }
    const created = t.w.db.all("SELECT category, business_date, count FROM interaction_counters WHERE scope = ?", `goals:${a.residentId}`);
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) expect(c.count, `${c.business_date} ${c.category}`).toBeLessThanOrEqual(c.category === 'long' ? 1 : 2);
    expect(goalCoins(t, a)).toBeLessThanOrEqual(3 * 4 * 2); // 手工塞进来的愿望每个 2 枚；自动生成的受每日上限约束
    checkInvariants(t);
  });
});
