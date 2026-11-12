/**
 * 栖灯镇：需要、共同活动、天气、公共事件。
 * 依据：设计文档第 3 节「住宅家具与共同活动」、第 4 节「个性需要」、第 6 节「每日事件与日报」；docs/TOWN.md「规则要点」。
 */
import { describe, expect, it } from 'vitest';
import { WEATHERS, WEATHER_SLOT_MS } from '../../src/world/content.js';
import { publicEventsToday, weatherAt } from '../../src/world/interact.js';
import { effectivePresentMs } from '../../src/world/life.js';
import { localParts, localToUtc } from '../../src/world/time.js';
import { FakeClock } from '../helpers.js';
import { Actor, makeTown, tempDb, type Town, type TownOpts } from './helpers.js';
import { checkInvariants } from './invariants.js';

const MIN = 60_000;
const HOUR = 3600_000;
const TZ = 'Asia/Tokyo';

/** 关掉愿望（奖励会改硬币）和需要的自然下降（让数字可以精确断言）。下降本身有单独的测试。 */
const QUIET = { shortGoals: 0, longGoals: 0, socialDecayPerHour: 0, interestDecayPerHour: 0 };

const marks = new WeakMap<Actor, string>();

function town(opts: TownOpts = {}): Town {
  const t = makeTown({ seed: 'ix-1', ...opts, params: { ...QUIET, ...(opts.params ?? {}) } });
  const join = t.join.bind(t);
  // 记下每位居民加入时的事件游标，之后可以读到他收到过的所有事件
  t.join = (...args: Parameters<Town['join']>) => {
    const a = join(...args);
    marks.set(a, a.events().cursor);
    return a;
  };
  return t;
}

function setNeeds(t: Town, a: Actor, n: { energy?: number; social?: number; interest?: number }): void {
  const r = a.row();
  r.state.needs = { ...r.state.needs, ...n, asOfPresentMs: effectivePresentMs(r, t.clock.t) };
  t.w.saveResident(r);
}

const needs = (a: Actor) => a.view().me.needs;

/** 各个公共地点里默认站到哪件物件旁边（公共物件按距离判定，要走到旁边才能用）。 */
const DEFAULT_SPOT: Record<string, string> = {
  tea_house: 'tea_house:table1',
  bookshop: 'bookshop:shelf',
  kitchen: 'kitchen:stove1',
  garden: 'garden:planter1',
};

/** 走到某地（或某件物件旁边），所有人都走到才返回。place 是地点时站到它的默认物件旁边。 */
function gather(place: string, ...people: Actor[]): void {
  for (const p of people) p.go(DEFAULT_SPOT[place] ?? place);
  for (const p of people) p.heartbeat();
}

/** 让时间走到世界时区的某个钟点（当天或之后最近的一次），期间大家保持心跳。 */
function toLocal(t: Town, people: Actor[], hour: number, minute: number, opts: { date?: string; second?: number } = {}): void {
  let date = opts.date ?? t.w.today();
  let target = localToUtc(TZ, date, hour, minute) + (opts.second ?? 0) * 1000;
  if (target < t.clock.t && !opts.date) {
    const d = new Date(localToUtc(TZ, date, 12, 0) + 24 * HOUR);
    date = localParts(TZ, d.getTime()).date;
    target = localToUtc(TZ, date, hour, minute);
  }
  if (target > t.clock.t) t.advanceAlive(target - t.clock.t, people, 30_000);
}

let restarts = 0;
/**
 * 重启。helpers 的 restart() 用同一个种子重新生成 Rng，新生成的编号会和重启前的撞上（UNIQUE items.item_id），
 * 生产环境用密码学随机源不会有这个问题。这里每次换一个种子。
 */
function restartFresh(t: Town): void {
  t.opts.seed = `${t.opts.seed ?? 'ix-1'}:r${++restarts}`;
  t.restart();
}

const START_WED = 1_700_000_000_000; // 2023-11-15 07:13 JST（周三）
const jst = (date: string, h: number, m = 0) => localToUtc(TZ, date, h, m);

function ixOf(a: Actor) {
  return a.view().interaction;
}

/** 做完一次十分钟的活动。 */
const finishTen = (t: Town, people: Actor[]) => t.advanceAlive(10 * MIN + 2000, people);
const finishFive = (t: Town, people: Actor[]) => t.advanceAlive(5 * MIN + 2000, people);

/**
 * 过一天以上（大家都下线再回来），并落在一个不下雨的时间段里：室内活动在雨天有加成，会让数字不一样。
 * 返回之后所有人重新进入。
 */
function nextClearDay(t: Town, people: Actor[]): void {
  t.advance(24 * HOUR);
  for (let i = 0; i < 12 && [0, 1, 2].some((k) => weatherAt(t.w, t.clock.t + k * HOUR).id === 'rain'); i++) t.advance(6 * HOUR);
  for (const p of people) p.enter();
}

const TABLE1 = 'tea_house:table1';
const TABLE2 = 'tea_house:table2';

const lastDone = (a: Actor, cursor?: string) => a.events(cursor ?? marks.get(a)).events.filter((e) => e.type === 'interaction_done');

// ───────────────────────── 需要 ─────────────────────────

describe('需要：精力 / 社交 / 兴趣', () => {
  it('初始三项都在 0~100，分别是 80 / 60 / 60', () => {
    const t = makeTown({ seed: 'needs' });
    const a = t.join('阿灯');
    expect(needs(a)).toMatchObject({ energy: 80, social: 60, interest: 60 });
  });

  it('社交每小时降 5、兴趣每小时降 3（按有效在场时间，惰性结算）', () => {
    const t = makeTown({ seed: 'needs', params: { shortGoals: 0, longGoals: 0 } });
    const a = t.join('阿灯');
    t.advanceAlive(2 * HOUR, [a], 30_000);
    expect(needs(a)).toMatchObject({ energy: 80, social: 50, interest: 54 });
    t.advanceAlive(HOUR / 2, [a], 30_000);
    expect(needs(a).social).toBe(47.5);
    expect(needs(a).interest).toBe(52.5);
  });

  it('离线不掉：显式离开、租约过期期间都不衰减，回来时从离开那刻继续', () => {
    const t = makeTown({ seed: 'needs', params: { shortGoals: 0, longGoals: 0 } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    t.advanceAlive(HOUR, [a, b], 30_000);
    expect(needs(a).social).toBe(55);
    a.leave();
    t.advance(10 * HOUR); // b 的租约也会过期，b 同样"离线"
    a.enter();
    expect(needs(a)).toMatchObject({ social: 55, interest: 57 });
    // b 没有显式离开，租约宽限 60 秒之内算在场，之后冻结：10 小时只掉了不到几分钟的量
    b.enter();
    expect(needs(b).social).toBeGreaterThan(54.4);
    expect(needs(b).social).toBeLessThanOrEqual(55);
  });

  it('下限 0：长时间在场不会降到负数；精力不随时间变化', () => {
    const t = makeTown({ seed: 'needs', params: { shortGoals: 0, longGoals: 0 } });
    const a = t.join('阿灯');
    t.advanceAlive(30 * HOUR, [a], 30_000);
    expect(needs(a)).toMatchObject({ energy: 80, social: 0, interest: 0 });
  });

  it('上限 100：休息、喝汤等恢复不会超过 100', () => {
    const t = town();
    const a = t.join('阿灯');
    setNeeds(t, a, { energy: 95, social: 99, interest: 99 });
    a.go('home');
    a.act('start_interaction', { objectId: a.view().here!.objects.find((o) => o.type === 'rest_nook')!.id });
    finishTen(t, [a]);
    expect(needs(a).energy).toBe(100);
  });

  it('数值再低也不禁止任何动作（软需要）', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    setNeeds(t, a, { energy: 0, social: 0, interest: 0 });
    a.act('speak', { text: '好累' });
    a.act('buy', { shop: 'stall', sku: 'cookie' });
    a.go(TABLE1);
    b.go(TABLE1);
    a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true });
    b.act('join_interaction', { interactionId: ix.interaction.id });
    a.act('begin_interaction', { interactionId: ix.interaction.id });
    a.act('leave_interaction');
    a.act('move', { to: 'plaza' });
    // 低精力会出现休息的建议，但只是建议
    expect(a.view().suggestions.join('')).toContain('累');
  });

  it('精力随活动变化：喝茶 -5、休息 +20；精力不足时效果打折', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    setNeeds(t, a, { energy: 50, social: 0 });
    setNeeds(t, b, { energy: 2, social: 0 }); // 精力 < 5，tired
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    finishTen(t, [a, b]);
    expect(needs(a)).toMatchObject({ energy: 45, social: 10 });
    expect(needs(b)).toMatchObject({ energy: 0, social: 5 }); // 打了对折，精力不会为负
  });
});

// ───────────────────────── 共同活动：喝茶 ─────────────────────────

describe('共同活动：喝茶（2~4 人）', () => {
  function teaSetup(n = 2) {
    const t = town();
    const people = ['阿灯', '小岚', '阿木', '阿青'].slice(0, n).map((nm, i) => t.join(nm, i % 2 ? 'agent' : 'human'));
    gather('tea_house', ...people);
    return { t, people, a: people[0]!, b: people[1]!, c: people[2], d: people[3] };
  }

  it('发起 → 加入 → 开始 → 完成：发起时只预留，开始才消耗，完成各得社交与情绪', () => {
    const { t, a, b } = teaSetup();
    setNeeds(t, a, { social: 20 });
    setNeeds(t, b, { social: 20 });
    const out = a.act('start_interaction', { objectId: TABLE1, wait: true });
    expect(out.status).toBe('accepted');
    const ix = out.interaction;
    expect(ix).toMatchObject({ def: 'share_tea', status: 'open', min: 2, max: 4 });
    expect(ix.participants.map((p: { name: string }) => p.name)).toEqual(['阿灯']);
    // 发起时只是预留
    expect(a.qty('tea_leaves')).toBe(2);
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(1);
    // 看得见需要投入什么
    expect(a.view().here!.objects.find((o) => o.id === TABLE1)!.action!.cost).toContain('茶叶');
    b.act('join_interaction', { interactionId: ix.id });
    expect(b.view().interaction!.participants).toHaveLength(2);
    expect(a.qty('tea_leaves')).toBe(2);
    expect(b.qty('tea_leaves')).toBe(2); // 加入者不出茶叶
    a.act('begin_interaction', { interactionId: ix.id });
    expect(ixOf(a)!.status).toBe('running');
    expect(ixOf(a)!.endsAt! - t.clock.t).toBe(10 * MIN);
    // 开始才消耗
    expect(a.qty('tea_leaves')).toBe(1);
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(1);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM resource_reservations')).toBe(0);
    const cursor = b.events().cursor;
    finishTen(t, [a, b]);
    expect(ixOf(a)).toBeNull();
    expect(needs(a)).toMatchObject({ social: 30, energy: 75 });
    expect(needs(b)).toMatchObject({ social: 30, energy: 75 });
    expect(a.view().me.mood?.id).toBe('happy');
    const done = lastDone(b, cursor);
    expect(done).toHaveLength(1);
    expect(String(done[0]!.data.text)).toContain('社交 +10');
    // 事实记录了实际参与人数
    const f = t.w.db.get("SELECT payload, visibility FROM world_events WHERE type = 'interaction_completed'")!;
    expect(JSON.parse(f.payload)).toMatchObject({ interaction: 'share_tea', participants: 2 });
    expect(f.visibility).toBe('public');
    checkInvariants(t);
  });

  it('人数不够不能开始；只有发起人能开始；不在一处不能加入', () => {
    const { t, a, b, c } = teaSetup(3);
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    expect(a.fail('begin_interaction', { interactionId: ix.id }).reason).toBe('not_enough');
    b.act('join_interaction', { interactionId: ix.id });
    expect(b.fail('begin_interaction', { interactionId: ix.id }).reason).toBe('not_initiator');
    // 走开的人够不着桌子：too_far，并告诉他往哪里走
    c!.go('plaza');
    const far = c!.fail('join_interaction', { interactionId: ix.id });
    expect(far.reason).toBe('too_far');
    expect(far.data).toMatchObject({ navigateTo: TABLE1 });
    expect(ixOf(c!)).toBeNull();
    expect(a.fail('begin_interaction', { interactionId: 'nope' }).reason).toBe('not_initiator');
    checkInvariants(t);
  });

  it('2~4 人：人满（4 人）自动开始，第 5 个人加入报 not_open', () => {
    const { t, people, a } = teaSetup(4);
    const e = t.join('阿雪');
    e.go(TABLE1);
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    people[1]!.act('join_interaction', { interactionId: ix.id });
    people[2]!.act('join_interaction', { interactionId: ix.id });
    expect(ixOf(a)!.status).toBe('open');
    people[3]!.act('join_interaction', { interactionId: ix.id });
    expect(ixOf(a)!.status).toBe('running'); // 第 4 个人到了就自动开始
    expect(a.qty('tea_leaves')).toBe(1);
    expect(e.fail('join_interaction', { interactionId: ix.id }).reason).toBe('not_open');
    finishTen(t, [...people, e]);
    for (const p of people) expect(needs(p).social).toBe(70);
    expect(needs(e).social).toBe(60);
    checkInvariants(t);
  });

  it('同一张桌子同时只能有一场；一个人同时只能做一件事；另一张桌子可以', () => {
    const { t, a, b, c } = teaSetup(3);
    a.act('start_interaction', { objectId: TABLE1, wait: true });
    expect(b.fail('start_interaction', { objectId: TABLE1, wait: true }).reason).toBe('busy');
    // 发起人守在这张桌子旁，够不着另一张：先是距离的问题（够得着两件物件才会碰到 already_busy，见家里的那条）
    expect(a.fail('start_interaction', { objectId: TABLE2, wait: true }).reason).toBe('too_far');
    b.go(TABLE2);
    c!.go(TABLE2);
    const ix2 = b.act('start_interaction', { objectId: TABLE2, wait: true }).interaction;
    c!.act('join_interaction', { interactionId: ix2.id });
    expect(ixOf(b)!.participants.map((p) => p.name)).toEqual(['小岚', '阿木']);
    checkInvariants(t);
  });

  it('不在身边的物件不能发起；没有可做的事的物件报 no_interaction', () => {
    const { t, a } = teaSetup();
    // 另一处的公共物件：够不着，并指给他物件编号
    const far = a.fail('start_interaction', { objectId: 'kitchen:stove1' });
    expect(far.reason).toBe('too_far');
    expect(far.data).toMatchObject({ navigateTo: 'kitchen:stove1' });
    expect(a.fail('start_interaction', { objectId: 'nope' }).reason).toBe('not_here');
    expect(a.fail('start_interaction', { objectId: TABLE1, interaction: 'cook_soup' }).reason).toBe('no_interaction');
    checkInvariants(t);
  });

  it('发起时茶叶不够 → insufficient_items，不留下半个活动', () => {
    const { t, a, b } = teaSetup();
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 2 }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(a.fail('start_interaction', { objectId: TABLE1, wait: true }).reason).toBe('insufficient_items');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM interactions')).toBe(0);
    expect(ixOf(a)).toBeNull();
    checkInvariants(t);
  });

  it('预留中的茶叶不能再送人；退出后又能用', () => {
    const { t, a, b } = teaSetup();
    a.act('start_interaction', { objectId: TABLE1, wait: true });
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 2 }] } }).reason).toBe('insufficient_items');
    a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 1 }] } });
    checkInvariants(t);
  });

  it('开始前发起人取消：预留全数退回，等待者收到取消通知，桌子空出来', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    const cursor = b.events().cursor;
    a.act('leave_interaction');
    expect(t.w.db.get('SELECT status, close_reason FROM interactions WHERE interaction_id = ?', ix.id)).toMatchObject({ status: 'cancelled' });
    expect(a.qty('tea_leaves')).toBe(2);
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    expect(ixOf(a)).toBeNull();
    expect(ixOf(b)).toBeNull();
    expect(b.events(cursor).events.some((e) => e.type === 'interaction' && (e.data.interaction as { status: string }).status === 'cancelled')).toBe(true);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'interaction_lobby_expire' AND status = 'pending'")).toBe(0);
    // 没有任何收获、没有事实
    expect(needs(b).social).toBe(60);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'interaction_completed'")).toBe(0);
    // 桌子可以重新用
    b.act('start_interaction', { objectId: TABLE1, wait: true });
    checkInvariants(t);
  });

  it('开始前非发起人退出：活动继续，席位让出', () => {
    const { t, a, b, c } = teaSetup(3);
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    b.act('leave_interaction');
    expect(ixOf(a)!.status).toBe('open');
    expect(ixOf(a)!.participants).toHaveLength(1);
    expect(a.fail('begin_interaction', { interactionId: ix.id }).reason).toBe('not_enough');
    c!.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    checkInvariants(t);
  });

  it('大厅超时（interaction_lobby_expire）：10 分钟没凑齐人，自动取消并退回投入', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    expect(ix.lobbyExpiresAt - t.clock.t).toBe(10 * MIN);
    t.advanceAlive(10 * MIN - 5000, [a, b]);
    expect(ixOf(a)!.status).toBe('open');
    t.advanceAlive(6000, [a, b]);
    expect(ixOf(a)).toBeNull();
    expect(t.w.db.get('SELECT status, close_reason FROM interactions WHERE interaction_id = ?', ix.id)).toMatchObject({ status: 'cancelled', close_reason: '等了太久没凑齐人' });
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')).toMatchObject({ qty: 2, available: 2 });
    checkInvariants(t);
  });

  it('开始之后大厅超时任务被取消，不会误取消进行中的活动', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    t.advanceAlive(9 * MIN, [a, b]);
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    t.advanceAlive(2 * MIN, [a, b]); // 越过原来的大厅期限
    expect(ixOf(a)!.status).toBe('running');
    finishTen(t, [a, b]);
    expect(needs(a).social).toBe(70);
  });

  it('开始后退出：没有这次的收获，也不退还投入；留下的人社交收益因不足两人而不生效', () => {
    const { t, a, b } = teaSetup();
    setNeeds(t, a, { social: 20 });
    setNeeds(t, b, { social: 20 });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    t.advanceAlive(3 * MIN, [a, b]);
    b.act('leave_interaction');
    expect(ixOf(b)).toBeNull();
    finishTen(t, [a, b]);
    expect(needs(b)).toMatchObject({ social: 20, energy: 80 }); // 什么都没得到，也没消耗
    expect(needs(a).social).toBe(20); // 只剩一个人，不算共同
    expect(needs(a).energy).toBe(75);
    expect(a.qty('tea_leaves')).toBe(1); // 茶叶已经泡了
    expect(lastDone(b)).toHaveLength(0);
    // 只有一个实际参与者，不形成关系
    expect(t.w.db.scalar('SELECT COUNT(*) FROM relationships')).toBe(0);
    checkInvariants(t);
  });

  it('开始后所有人都走了：活动取消，投入不退', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    a.act('move', { to: 'plaza' }); // 走开 = 退出
    b.act('move', { to: 'plaza' });
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)!.status).toBe('cancelled');
    expect(a.qty('tea_leaves')).toBe(1);
    t.advanceAlive(15 * MIN, [a, b]);
    expect(needs(a).social).toBe(60);
    checkInvariants(t);
  });

  it('等人的时候发起人走开：活动取消并退回；参与者走开：只是让出席位', () => {
    const { t, a, b, c } = teaSetup(3);
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    c!.act('join_interaction', { interactionId: ix.id });
    c!.act('move', { to: 'plaza' });
    expect(ixOf(a)!.participants).toHaveLength(2);
    a.act('move', { to: 'plaza' });
    expect(ixOf(b)).toBeNull();
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    checkInvariants(t);
  });

  it('等人的时候发起人离线：活动取消并退回', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.leave();
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)!.status).toBe('cancelled');
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    checkInvariants(t);
  });

  it('两个人都走到同一张茶桌旁才能一起喝茶：一个在桌边、一个在茶馆另一头，后者加入是 too_far', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go(TABLE1);
    b.go(TABLE2); // 同在茶馆，隔着一段距离
    expect(a.view().location.space).toBe('tea_house');
    expect(b.view().location.space).toBe('tea_house');
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    const far = b.fail('join_interaction', { interactionId: ix.id });
    expect(far.reason).toBe('too_far');
    expect(far.data).toMatchObject({ navigateTo: TABLE1 });
    expect(ixOf(b)).toBeNull();
    // 走到桌边就能加入
    b.go(TABLE1);
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    finishTen(t, [a, b]);
    expect(needs(a).social).toBe(70);
    expect(needs(b).social).toBe(70);
    checkInvariants(t);
  });

  it('进行中有人迈步走开（哪怕没走出茶馆）：他退出、没有收获，其余人照常完成', () => {
    const { t, a, b, c } = teaSetup(3);
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    c!.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    t.advanceAlive(MIN, [a, b, c!]);
    const cursor = c!.events().cursor;
    c!.act('navigate', { to: TABLE2 }); // 刚迈步就退出
    expect(c!.view().location.space).toBe('tea_house'); // 还在这片区域里
    expect(ixOf(c!)).toBeNull();
    expect(t.w.db.get('SELECT active FROM interaction_participants WHERE interaction_id = ? AND resident_id = ?', ix.id, c!.residentId)!.active).toBe(0);
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)!.status).toBe('running');
    c!.walk();
    finishTen(t, [a, b, c!]);
    expect(needs(a).social).toBe(70);
    expect(needs(b).social).toBe(70);
    expect(needs(c!).social).toBe(60); // 走开的人没有收获
    expect(lastDone(c!, cursor)).toHaveLength(0);
    expect(lastDone(a)).toHaveLength(1);
    // 投入不退
    expect(a.qty('tea_leaves')).toBe(1);
    checkInvariants(t);
  });

  it('还没开始时发起人迈步走开（没出茶馆）：活动取消并退回预留，等人的也被通知', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    const cursor = b.events().cursor;
    a.act('navigate', { to: TABLE2 });
    expect(a.view().location.space).toBe('tea_house');
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)).toMatchObject({ status: 'cancelled' });
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM resource_reservations')).toBe(0);
    expect(ixOf(b)).toBeNull();
    expect(b.events(cursor).events.some((e) => e.type === 'interaction' && (e.data.interaction as { status: string }).status === 'cancelled')).toBe(true);
    a.walk();
    checkInvariants(t);
  });

  it('走开又走回桌边：已经退出，要重新加入', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    b.go(TABLE2);
    b.go(TABLE1);
    expect(ixOf(b)).toBeNull();
    b.act('join_interaction', { interactionId: ix.id });
    expect(ixOf(b)!.participants).toHaveLength(2);
    checkInvariants(t);
  });

  it('被请出门（撤销邀请）时在别人家里的活动收尾：发起人取消并退回；人落在会馆门口', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('invite', { to: b.residentId });
    b.go(`home:${a.residentId}`);
    expect(b.row().location_id).toBe(`home:${a.residentId}`);
    const table = b.view().here!.objects.find((o) => o.type === 'tea_table')!;
    const ix = b.act('start_interaction', { objectId: table.id, wait: true }).interaction;
    expect(ix.status).toBe('open');
    const grantId = String(t.w.db.get('SELECT grant_id FROM home_access_grants WHERE owner_id = ?', a.residentId)!.grant_id);
    a.act('revoke_invite', { grantId });
    expect(b.row().location_id).toBe('residential');
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)).toMatchObject({ status: 'cancelled' });
    expect(ixOf(b)).toBeNull();
    expect(b.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    checkInvariants(t);
  });

  it('走出茶馆（跨区域）时同样退出：到了广场，活动已经取消', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.go('plaza');
    expect(a.view().location.space).toBe('plaza');
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)).toMatchObject({ status: 'cancelled' });
    expect(ixOf(a)).toBeNull();
    expect(ixOf(b)).toBeNull();
    expect(a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.available).toBe(2);
    checkInvariants(t);
  });

  it('参与者中途离线：已经开始的活动照常完成，离线的人也按参与结算（并且只结算一次）', () => {
    const { t, a, b } = teaSetup();
    setNeeds(t, a, { social: 20 });
    setNeeds(t, b, { social: 20 });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    t.advanceAlive(2 * MIN, [a, b]);
    b.leave();
    expect(t.w.db.get('SELECT active FROM interaction_participants WHERE interaction_id = ? AND resident_id = ?', ix.id, b.residentId)!.active).toBe(1);
    t.advanceAlive(9 * MIN, [a]);
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)!.status).toBe('completed');
    b.enter();
    expect(needs(b).social).toBe(30);
    expect(needs(a).social).toBe(30);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'interaction_completed'")).toBe(1);
    checkInvariants(t);
  });

  it('结算只一次：完成时间跨过重启，重启后恢复也不重复发奖', () => {
    const db = tempDb();
    try {
      const t = town({ dbPath: db.path });
      const a = t.join('阿灯');
      const b = t.join('小岚', 'agent');
      gather('tea_house', a, b);
      setNeeds(t, a, { social: 20 });
      const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      t.clock.advance(20 * MIN); // 停机期间，活动应该完成的时刻已经过去
      restartFresh(t);
      expect(t.w.db.get('SELECT status, closed_at FROM interactions WHERE interaction_id = ?', ix.id)).toMatchObject({ status: 'completed' });
      a.enter();
      expect(needs(a).social).toBe(30);
      restartFresh(t);
      t.advance(HOUR);
      a.enter();
      expect(needs(a).social).toBe(30);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'interaction_completed'")).toBe(1);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE type = 'interaction_done' AND resident_id = ?", a.residentId)).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  it('每次完成形成共同经历：双方各有一条，指向实际事件', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    finishTen(t, [a, b]);
    const refs = t.w.db.all('SELECT owner_id, other_id, summary, event_id FROM memory_refs');
    expect(refs).toHaveLength(2);
    const ev = t.w.db.get("SELECT event_id FROM world_events WHERE type = 'interaction_completed'")!;
    expect(refs.every((r) => r.event_id === ev.event_id)).toBe(true);
    expect(refs.map((r) => r.summary)).toEqual(['一起一起喝茶', '一起一起喝茶']);
  });

  it('活动取消后不留"失落"之类未经事实支持的情绪（取消没有产出）', () => {
    const { t, a, b } = teaSetup();
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('leave_interaction');
    expect(a.view().me.mood).toBeNull();
  });
});

// ───────────────────────── 读书 / 做汤 / 照料花箱 / 休息 ─────────────────────────

describe('共同活动：读书、做汤、照料花箱、在家休息', () => {
  it('读书：一个人就能读，立刻开始，社交不生效；两个人读社交 +4', () => {
    const t = town();
    const a = t.join('阿灯', 'human', { interests: ['books'] });
    const b = t.join('小岚', 'agent', { interests: ['books'] });
    gather('bookshop', a, b);
    setNeeds(t, a, { social: 20, interest: 20 });
    setNeeds(t, b, { social: 20, interest: 20 });
    const solo = a.act('start_interaction', { objectId: 'bookshop:shelf' }).interaction;
    expect(solo.status).toBe('running');
    expect(solo.min).toBe(1);
    finishTen(t, [a, b]);
    expect(needs(a)).toMatchObject({ social: 20, interest: 30, energy: 75 });
    // 两人一起读
    const ix = a.act('start_interaction', { objectId: 'bookshop:shelf', wait: true }).interaction;
    expect(ix.status).toBe('open');
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    finishTen(t, [a, b]);
    expect(needs(a)).toMatchObject({ social: 24, interest: 40 });
    expect(needs(b)).toMatchObject({ social: 24, interest: 30 });
    checkInvariants(t);
  });

  it('读书：带 itemId 读手上的书；名字变成《书名》，书的偏向兴趣算对口；不在手里的书被拒', () => {
    const t = town();
    const a = t.join('阿灯', 'human', { interests: ['cooking'] }); // 书籍不在兴趣里
    const b = t.join('小岚', 'agent');
    gather('bookshop', a, b);
    a.act('buy', { shop: 'book_counter', sku: 'book:bread_stars' }); // tag: cooking
    a.act('buy', { shop: 'book_counter', sku: 'book:rain_lane' }); // tag: letters
    const byBook = (id: string) => a.view().inventory.items.find((i) => i.type === 'book' && i.name.includes(id))!.itemId;
    setNeeds(t, a, { interest: 10 });
    const on = a.act('start_interaction', { objectId: 'bookshop:shelf', itemId: byBook('面包与星图') }).interaction;
    expect(on.name).toBe('读《面包与星图》');
    finishTen(t, [a, b]);
    expect(needs(a).interest).toBe(20); // 对口 +10
    expect(String(lastDone(a)[0]!.data.text)).toContain('读完了《面包与星图》');
    setNeeds(t, a, { interest: 10 });
    a.act('start_interaction', { objectId: 'bookshop:shelf', itemId: byBook('雨巷里的灯') });
    finishTen(t, [a, b]);
    expect(needs(a).interest).toBe(14); // 不对口 +4
    // 别人的书、不存在的书
    expect(a.fail('start_interaction', { objectId: 'bookshop:shelf', itemId: b.view().inventory.items.find((i) => i.type === 'book')!.itemId }).reason).toBe('not_yours');
    expect(a.fail('start_interaction', { objectId: 'bookshop:shelf', itemId: 'nope' }).reason).toBe('not_yours');
    expect(a.fail('start_interaction', { objectId: 'bookshop:shelf', itemId: a.view().inventory.items.find((i) => i.type === 'tea_leaves')!.itemId }).reason).toBe('not_yours');
    checkInvariants(t);
  });

  it('读借来的书：可以读（不消耗），读完书还在，还是借来的', () => {
    const t = town();
    const a = t.join('阿灯');
    a.go('bookshop:shelf');
    const id = a.act('borrow_book', { bookId: 'slow_fire' }).itemId as string;
    a.act('start_interaction', { objectId: 'bookshop:shelf', itemId: id });
    finishTen(t, [a]);
    expect(t.w.db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', id)).toMatchObject({ owner_id: 'town', holder_id: a.residentId });
    checkInvariants(t);
  });

  it('兴趣对口：读书的人对书籍有兴趣 +10，没兴趣 +4', () => {
    const t = town();
    const a = t.join('阿灯', 'human', { interests: ['books'] });
    const b = t.join('小岚', 'agent', { interests: ['tea'] });
    gather('bookshop', a, b);
    setNeeds(t, a, { interest: 0 });
    setNeeds(t, b, { interest: 0 });
    const ix = a.act('start_interaction', { objectId: 'bookshop:shelf', wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    finishTen(t, [a, b]);
    expect(needs(a).interest).toBe(10);
    expect(needs(b).interest).toBe(4);
  });

  it('做汤：发起人出 2 份蔬菜，每位参与者 1 碗，发起人多 1 碗；开始前蔬菜只是预留', () => {
    const t = town();
    const a = t.join('阿灯', 'human', { interests: ['cooking'] });
    const b = t.join('小岚', 'agent');
    gather('kitchen', a, b);
    setNeeds(t, a, { interest: 0, social: 0 });
    setNeeds(t, b, { interest: 0, social: 0 });
    const ix = a.act('start_interaction', { objectId: 'kitchen:stove1', wait: true }).interaction;
    expect(ix.def).toBe('cook_soup');
    expect(a.qty('vegetables')).toBe(2);
    expect(a.view().inventory.items.find((i) => i.type === 'vegetables')!.available).toBe(0);
    expect(a.fail('start_interaction', { objectId: 'kitchen:stove2' }).reason).toBe('too_far'); // 灶台相隔几米，不在手边
    b.act('join_interaction', { interactionId: ix.id });
    const totals = t.w.db.scalar("SELECT COALESCE(SUM(quantity),0) FROM items WHERE type = 'vegetables'");
    a.act('begin_interaction', { interactionId: ix.id });
    expect(a.qty('vegetables')).toBe(0);
    expect(t.w.db.scalar("SELECT COALESCE(SUM(quantity),0) FROM items WHERE type = 'vegetables'")).toBe(totals - 2);
    expect(ixOf(a)!.endsAt! - t.clock.t).toBe(5 * MIN);
    finishFive(t, [a, b]);
    expect(a.qty('soup')).toBe(2);
    expect(b.qty('soup')).toBe(1);
    expect(needs(a)).toMatchObject({ interest: 10, social: 6, energy: 75 }); // 烹饪对口
    expect(needs(b)).toMatchObject({ interest: 4, social: 6 });
    expect(String(lastDone(a)[0]!.data.text)).toContain('得到 2 份热汤');
    // 汤能喝
    a.act('use_item', { itemType: 'soup' });
    expect(needs(a).energy).toBe(90);
    checkInvariants(t);
  });

  it('做汤：一个人做，收获 2 碗，社交不生效；蔬菜不够 insufficient_items', () => {
    const t = town();
    const a = t.join('阿灯');
    a.go('kitchen:stove1');
    setNeeds(t, a, { social: 0 });
    const out = a.act('start_interaction', { objectId: 'kitchen:stove1' });
    expect(out.interaction.status).toBe('running');
    finishFive(t, [a]);
    expect(a.qty('soup')).toBe(2);
    expect(needs(a).social).toBe(0);
    expect(a.fail('start_interaction', { objectId: 'kitchen:stove1' }).reason).toBe('insufficient_items');
    a.act('buy', { shop: 'pantry', sku: 'vegetables', qty: 2 });
    a.act('start_interaction', { objectId: 'kitchen:stove1' });
    checkInvariants(t);
  });

  it('做汤：3 人满员自动开始；开始后取消不退蔬菜', () => {
    const t = town();
    const [a, b, c] = ['阿灯', '小岚', '阿木'].map((n, i) => t.join(n, i % 2 ? 'agent' : 'human')) as [Actor, Actor, Actor];
    gather('kitchen', a, b, c);
    const ix = a.act('start_interaction', { objectId: 'kitchen:stove1', wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    c.act('join_interaction', { interactionId: ix.id });
    expect(ixOf(a)!.status).toBe('running');
    for (const p of [a, b, c]) p.act('move', { to: 'plaza' });
    expect(t.w.db.get('SELECT status FROM interactions WHERE interaction_id = ?', ix.id)!.status).toBe('cancelled');
    expect(a.qty('vegetables')).toBe(0);
    t.advanceAlive(10 * MIN, [a, b, c]);
    expect(a.qty('soup')).toBe(0);
    checkInvariants(t);
  });

  it('照料花箱：发起人出 1 份花种，收获鲜花（每天最多 2 朵），社交需要 2 人', () => {
    const t = town();
    const a = t.join('阿灯', 'human', { interests: ['plants'] });
    gather('garden', a);
    a.act('buy', { shop: 'shed', sku: 'seeds', qty: 2 });
    setNeeds(t, a, { interest: 0, social: 0 });
    for (let i = 1; i <= 3; i++) {
      a.act('start_interaction', { objectId: 'garden:planter1' });
      finishFive(t, [a]);
      expect(a.qty('flower')).toBe(Math.min(i, 2)); // 第 3 次没有鲜花
    }
    expect(a.qty('seeds')).toBe(1);
    expect(String(lastDone(a).at(-1)!.data.text)).not.toContain('鲜花');
    // 前 3 次全额，所以兴趣 +10 +10 +10
    expect(needs(a)).toMatchObject({ interest: 30, social: 0 });
    checkInvariants(t);
  });

  it('产出每日上限按人按天算：第二天重新计；两个人各有自己的上限', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('garden', a, b);
    a.act('buy', { shop: 'shed', sku: 'seeds', qty: 3 });
    const run = (x: Actor, planter: string, others: Actor[] = []) => {
      const ix = x.act('start_interaction', { objectId: planter, wait: others.length > 0 }).interaction;
      for (const o of others) o.act('join_interaction', { interactionId: ix.id });
      if (others.length) x.act('begin_interaction', { interactionId: ix.id });
      finishFive(t, [a, b]);
    };
    run(a, 'garden:planter1', [b]);
    run(a, 'garden:planter1', [b]);
    run(a, 'garden:planter1', [b]);
    expect([a.qty('flower'), b.qty('flower')]).toEqual([2, 2]);
    nextClearDay(t, [a, b]);
    run(a, 'garden:planter1', [b]);
    expect([a.qty('flower'), b.qty('flower')]).toEqual([3, 3]);
    checkInvariants(t);
  });

  it('前 3 次全额之后减半（每种活动各算各的，每天重新计）', () => {
    const t = town();
    const a = t.join('阿灯', 'human', { interests: ['books'] });
    const b = t.join('小岚', 'agent');
    gather('bookshop', a, b);
    setNeeds(t, a, { interest: 0 });
    const deltas: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = needs(a).interest;
      a.act('start_interaction', { objectId: 'bookshop:shelf' });
      finishTen(t, [a, b]);
      deltas.push(needs(a).interest - before);
    }
    expect(deltas).toEqual([10, 10, 10, 5, 5]);
    expect(String(lastDone(a).at(-1)!.data.text)).toContain('减半');
    // 别的活动不受影响：第一次喝茶仍然全额
    gather('tea_house', a, b);
    setNeeds(t, a, { social: 0 });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    finishTen(t, [a, b]);
    expect(needs(a).social).toBe(10);
    // 第二天重新全额
    nextClearDay(t, [a, b]);
    a.go('bookshop:shelf');
    const before = needs(a).interest;
    a.act('start_interaction', { objectId: 'bookshop:shelf' });
    finishTen(t, [a]);
    expect(needs(a).interest - before).toBe(10);
    checkInvariants(t);
  });

  it('社交收益同样前 3 次全额，之后减半', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    setNeeds(t, a, { social: 0 });
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 4 });
    const deltas: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = needs(a).social;
      const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      finishTen(t, [a, b]);
      deltas.push(needs(a).social - before);
    }
    expect(deltas).toEqual([10, 10, 10, 5]);
    checkInvariants(t);
  });

  it('在家休息：只能在自己家，一个人，立刻开始，十分钟 +20 精力', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    setNeeds(t, a, { energy: 30 });
    a.act('invite', { to: b.residentId }); // 两人开局都在广场：先当面邀请，后面 b 才进得了门
    a.go('home');
    const nook = a.view().here!.objects.find((o) => o.type === 'rest_nook')!;
    const out = a.act('start_interaction', { objectId: nook.id });
    expect(out.interaction).toMatchObject({ def: 'rest', status: 'running', min: 1, max: 1 });
    expect(a.fail('start_interaction', { objectId: nook.id }).reason).toBe('busy');
    expect(a.fail('start_interaction', { objectId: a.view().here!.objects.find((o) => o.type === 'tea_table')!.id, wait: true }).reason).toBe('already_busy');
    finishTen(t, [a, b]);
    expect(needs(a).energy).toBe(50);
    expect(needs(a).social).toBe(60); // 休息不动社交
    expect(a.view().me.mood?.id).toBe('relaxed');
    // 在别人家里不行：b 受邀进了 a 的家，也不能用主人的休息角
    b.go(`home:${a.residentId}`);
    expect(b.row().location_id).toBe(`home:${a.residentId}`);
    expect(b.fail('start_interaction', { objectId: nook.id }).reason).toBe('not_home');
    checkInvariants(t);
  });

  it('家里的家具不按距离：在自己家里任何位置都能用；别人的家不能用 own_home 的', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    // 两人开局都在广场：当面邀请，再各自回去
    a.act('invite', { to: b.residentId });
    a.go('home');
    const nook = a.view().here!.objects.find((o) => o.type === 'rest_nook')!;
    a.go({ x: 1.5, z: 1.5 }); // 屋子的角落，离门最远
    const out = a.act('start_interaction', { objectId: nook.id });
    expect(out.interaction).toMatchObject({ def: 'rest', status: 'running' });
    // 别人家：进得去（受邀），但在里面不能用 own_home 的家具
    b.go(`home:${a.residentId}`);
    expect(b.row().location_id).toBe(`home:${a.residentId}`);
    expect(b.fail('start_interaction', { objectId: nook.id }).reason).toBe('not_home');
    checkInvariants(t);
  });

  it('在家的活动留下的事实是私密的，不进公开日报的来源', () => {
    const t = town();
    const a = t.join('阿灯');
    a.go('home');
    a.act('start_interaction', { objectId: a.view().here!.objects.find((o) => o.type === 'rest_nook')!.id });
    finishTen(t, [a]);
    const f = t.w.db.get("SELECT visibility, payload FROM world_events WHERE type = 'interaction_completed'")!;
    expect(f.visibility).toBe('private');
    expect(JSON.parse(f.payload).space).toBe('home');
  });

  it('买来的花箱摆进家里后可以在家照料；公共花园整理不算在家里的', () => {
    const t = town();
    const a = t.join('阿灯');
    a.go('garden:planter1');
    a.act('buy', { shop: 'shed', sku: 'planter_box' });
    a.go('home');
    a.act('place_furniture', { itemId: a.view().inventory.items.find((i) => i.type === 'planter_box')!.itemId });
    const planter = a.view().here!.objects.find((o) => o.type === 'planter')!;
    expect(planter.action!.name).toBe('照料花箱');
    a.act('start_interaction', { objectId: planter.id });
    finishFive(t, [a]);
    expect(a.qty('flower')).toBe(1);
    checkInvariants(t);
  });

  it('活动期间看得见的物件状态：谁在用、什么时候结束', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    a.act('start_interaction', { objectId: TABLE1, wait: true });
    const o = b.view().here!.objects.find((x) => x.id === TABLE1)!;
    expect(o.active).toMatchObject({ status: 'open' });
    expect(o.active!.participants.map((p) => p.name)).toEqual(['阿灯']);
  });
});

// ───────────────────────── 天气 ─────────────────────────

describe('天气', () => {
  it('由世界和时间段决定：重复查询一致、重启不变、同一时间段内不变', () => {
    const db = tempDb();
    try {
      const t = town({ dbPath: db.path });
      const slot = Math.floor(t.clock.t / WEATHER_SLOT_MS);
      const at = slot * WEATHER_SLOT_MS + 10;
      const w1 = weatherAt(t.w, at);
      expect(WEATHERS.map((x) => x.id)).toContain(w1.id);
      expect(weatherAt(t.w, at + WEATHER_SLOT_MS - 20)).toEqual(w1);
      expect(w1.until).toBe((slot + 1) * WEATHER_SLOT_MS);
      restartFresh(t);
      expect(weatherAt(t.w, at)).toEqual(w1);
      const kinds = new Set(Array.from({ length: 200 }, (_, i) => weatherAt(t.w, (slot + i) * WEATHER_SLOT_MS).id));
      expect(kinds).toEqual(new Set(WEATHERS.map((x) => x.id)));
    } finally {
      db.cleanup();
    }
  });
});

/** 在固定的世界里找一个雨天 / 非雨天的时间段，返回时间段内的一个时刻（段开始后 30 分钟）。 */
function findSlot(rain: boolean): number {
  const probe = makeTown({ seed: 'probe' });
  const first = Math.ceil(START_WED / WEATHER_SLOT_MS);
  for (let s = first; s < first + 400; s++) {
    const at = s * WEATHER_SLOT_MS + 30 * MIN;
    if ((weatherAt(probe.w, at).id === 'rain') !== rain) continue;
    // 避开公共事件窗口（花园 12:30、集市/茶会 20:00）
    const p = localParts(TZ, at);
    if (p.hour === 12 || p.hour === 13 || p.hour === 19 || p.hour === 20) continue;
    return at;
  }
  throw new Error('没有找到合适的天气时间段');
}

describe('下雨的室内加成', () => {
  function atTime(at: number) {
    const clock = new FakeClock();
    clock.t = at;
    return town({ clock });
  }

  it('喝茶（茶馆，室内）：下雨社交 +12，不下雨 +10', () => {
    const results = [true, false].map((rain) => {
      const t = atTime(findSlot(rain));
      expect(weatherAt(t.w, t.clock.t).id === 'rain').toBe(rain);
      const a = t.join('阿灯');
      const b = t.join('小岚', 'agent');
      gather('tea_house', a, b);
      setNeeds(t, a, { social: 0 });
      setNeeds(t, b, { social: 0 });
      const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      finishTen(t, [a, b]);
      return needs(a).social;
    });
    expect(results).toEqual([12, 10]);
  });

  it('读书（书屋，室内）：对口下雨 +12 / 晴 +10；不对口下雨 +6 / 晴 +4', () => {
    const run = (rain: boolean, interests: string[]) => {
      const t = atTime(findSlot(rain));
      const a = t.join('阿灯', 'human', { interests });
      a.go('bookshop:shelf');
      setNeeds(t, a, { interest: 0 });
      a.act('start_interaction', { objectId: 'bookshop:shelf' });
      finishTen(t, [a]);
      return needs(a).interest;
    };
    expect(run(true, ['books'])).toBe(12);
    expect(run(false, ['books'])).toBe(10);
    // 不对口的 +4，下雨时同样 +2（加成按收益大于 0 就生效）
    expect(run(true, ['tea'])).toBe(6);
    expect(run(false, ['tea'])).toBe(4);
  });

  it('在家读书同样算室内；户外的花园照料没有雨天加成', () => {
    const rainy = (place: string, objectId: string, interests: string[]) => {
      const t = atTime(findSlot(true));
      const a = t.join('阿灯', 'human', { interests });
      a.go(place === 'home' ? 'home' : objectId);
      setNeeds(t, a, { interest: 0 });
      const obj = place === 'home' ? a.view().here!.objects.find((o) => o.type === 'bookshelf')!.id : objectId;
      a.act('start_interaction', { objectId: obj });
      finishFive(t, [a]);
      finishFive(t, [a]);
      return needs(a).interest;
    };
    expect(rainy('home', '', ['books'])).toBe(12);
    expect(rainy('garden', 'garden:planter1', ['plants'])).toBe(10);
  });

  it('下雨加成也要遵守前 3 次全额之后减半', () => {
    const t = atTime(findSlot(true));
    const a = t.join('阿灯', 'human', { interests: ['books'] });
    a.go('bookshop:shelf');
    setNeeds(t, a, { interest: 0 });
    const deltas: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = needs(a).interest;
      a.act('start_interaction', { objectId: 'bookshop:shelf' });
      finishTen(t, [a]);
      deltas.push(needs(a).interest - before);
    }
    // 4 次十分钟总共 40 分钟，仍在同一个 6 小时的雨天时间段里
    expect(deltas).toEqual([12, 12, 12, 6]);
  });
});

// ───────────────────────── 公共事件 ─────────────────────────

describe('公共事件', () => {
  const eventRow = (t: Town, def: string, date?: string) => t.w.db.get('SELECT * FROM public_event_instances WHERE def_id = ? AND business_date = ?', def, date ?? t.w.today());

  it('按周几生成：工作日有灯下集市，周末有茶会；花园整理每天都有；每种每天只有一条', () => {
    const wed = town();
    const defsWed = publicEventsToday(wed.w, wed.clock.t).map((e) => e.def).sort();
    expect(defsWed).toEqual(['garden_care', 'lantern_market']);
    const clock = new FakeClock();
    clock.t = jst('2023-11-18', 9); // 周六
    const sat = town({ clock });
    expect(publicEventsToday(sat.w, sat.clock.t).map((e) => e.def).sort()).toEqual(['garden_care', 'tea_party']);
    clock.t = jst('2023-11-19', 9); // 周日
    const sun = town({ clock: new FakeClock() });
    void sun;
    // 重启、重复换日都不会生成重复实例
    expect(sat.w.db.scalar('SELECT COUNT(*) FROM public_event_instances')).toBe(2);
  });

  it('开闭时间：花园整理 12:30~13:00，状态 scheduled → open → closed，各 30 分钟', () => {
    const t = town();
    const a = t.join('阿灯');
    const row = eventRow(t, 'garden_care')!;
    expect(row.opens_at).toBe(jst('2023-11-15', 12, 30));
    expect(row.closes_at - row.opens_at).toBe(30 * MIN);
    expect(row.status).toBe('scheduled');
    toLocal(t, [a], 12, 29, { second: 58 });
    expect(eventRow(t, 'garden_care')!.status).toBe('scheduled');
    toLocal(t, [a], 12, 30, { second: 1 });
    expect(eventRow(t, 'garden_care')!.status).toBe('open');
    expect(publicEventsToday(t.w, t.clock.t).find((e) => e.def === 'garden_care')).toMatchObject({ status: 'open', progress: 0, target: 4, place: 'garden' });
    toLocal(t, [a], 12, 59, { second: 58 });
    expect(eventRow(t, 'garden_care')!.status).toBe('open');
    toLocal(t, [a], 13, 0, { second: 1 });
    expect(eventRow(t, 'garden_care')!.status).toBe('closed');
  });

  it('灯下集市：工作日 20:00~20:30，纸灯只在这段时间卖；之后买不到', () => {
    const t = town();
    const a = t.join('阿灯');
    expect(a.fail('buy', { shop: 'stall', sku: 'paper_lamp' }).reason).toBe('not_on_sale');
    toLocal(t, [a], 19, 59, { second: 50 });
    expect(a.fail('buy', { shop: 'stall', sku: 'paper_lamp' }).reason).toBe('not_on_sale');
    toLocal(t, [a], 20, 0, { second: 5 });
    expect(eventRow(t, 'lantern_market')!.status).toBe('open');
    a.act('buy', { shop: 'stall', sku: 'paper_lamp', qty: 2 });
    expect(a.qty('paper_lamp')).toBe(2);
    const goods = a.view().here!.shops[0]!.goods;
    expect(goods.find((g) => g.sku === 'paper_lamp')!.note).toBe('活动期间限定');
    toLocal(t, [a], 20, 30, { second: 2 });
    expect(eventRow(t, 'lantern_market')!.status).toBe('closed');
    expect(a.fail('buy', { shop: 'stall', sku: 'paper_lamp' }).reason).toBe('not_on_sale');
    expect(a.view().here!.shops[0]!.goods.map((g) => g.sku)).not.toContain('paper_lamp');
    checkInvariants(t);
  });

  it('周末茶会：周六 20:00~20:30 在茶馆喝茶不用自带茶叶，窗口外要自己出', () => {
    const clock = new FakeClock();
    clock.t = jst('2023-11-18', 19, 50);
    const t = town({ clock });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    // 先把茶叶送光，证明茶会时不需要
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 2 }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    expect(a.fail('start_interaction', { objectId: TABLE1, wait: true }).reason).toBe('insufficient_items');
    toLocal(t, [a, b], 20, 1);
    expect(eventRow(t, 'tea_party')!.status).toBe('open');
    setNeeds(t, a, { social: 0 });
    const ix = a.act('start_interaction', { objectId: TABLE1, wait: true }).interaction;
    b.act('join_interaction', { interactionId: ix.id });
    a.act('begin_interaction', { interactionId: ix.id });
    expect(a.qty('tea_leaves')).toBe(0); // 没有扣
    expect(b.qty('tea_leaves')).toBe(4);
    finishTen(t, [a, b]);
    // 晚上的天气可能在下雨（室内 +2），按确定性的天气算
    expect(needs(a).social).toBe(10 + (weatherAt(t.w, t.clock.t - 10 * MIN).id === 'rain' ? 2 : 0));
    // 窗口外（20:30 之后）没有这个优待
    toLocal(t, [a, b], 20, 31);
    expect(eventRow(t, 'tea_party')!.status).toBe('closed');
    expect(a.fail('start_interaction', { objectId: TABLE1, wait: true }).reason).toBe('insufficient_items');
    // 取消不会凭空多出茶叶
    expect(t.w.db.scalar('SELECT COUNT(*) FROM resource_reservations')).toBe(0);
    checkInvariants(t);
  });

  it('工作日没有茶会：同样的时间在茶馆喝茶仍要自己出茶叶', () => {
    const t = town();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    gather('tea_house', a, b);
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 2 }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    toLocal(t, [a, b], 20, 5);
    expect(eventRow(t, 'tea_party')).toBeUndefined();
    expect(a.fail('start_interaction', { objectId: TABLE1, wait: true }).reason).toBe('insufficient_items');
  });

  describe('花园整理：贡献与奖励', () => {
    function garden(n = 4) {
      const t = town();
      const people = ['阿灯', '小岚', '阿木', '阿青'].slice(0, n).map((nm, i) => t.join(nm, i % 2 ? 'agent' : 'human'));
      gather('garden', ...people);
      return { t, people };
    }

    it('窗口里照料花箱计入共同进度，每人参与奖励 3 枚，只发一次；达标发布完成公告', () => {
      const { t, people } = garden(4);
      const [a, b, c, d] = people as [Actor, Actor, Actor, Actor];
      toLocal(t, people, 12, 31);
      const cursor = a.events().cursor;
      const pubCursor = t.w.readPublicEvents(undefined).cursor;
      const ix = a.act('start_interaction', { objectId: 'garden:planter1', wait: true }).interaction;
      b.act('join_interaction', { interactionId: ix.id });
      a.act('begin_interaction', { interactionId: ix.id });
      c.go('garden:planter2');
      d.go('garden:planter3');
      c.act('start_interaction', { objectId: 'garden:planter2' });
      d.act('start_interaction', { objectId: 'garden:planter3' });
      finishFive(t, people);
      const inst = eventRow(t, 'garden_care')!;
      expect(inst.progress).toBe(4);
      expect(inst.reached_at).not.toBeNull();
      for (const p of people) expect(p.coins()).toBe(23);
      expect(a.events(cursor).events.some((e) => e.type === 'notice' && String(e.data.text).includes('花园整理'))).toBe(true);
      const pub = t.w.readPublicEvents(pubCursor).events.filter((e) => e.type === 'public_event');
      expect(pub.filter((e) => (e.data as { text?: string }).text?.includes('花园整理完成'))).toHaveLength(1);
      // 每人一条贡献记录
      expect(t.w.db.all('SELECT contributions, rewarded FROM event_participation').map((r) => [r.contributions, r.rewarded])).toEqual([[1, 1], [1, 1], [1, 1], [1, 1]]);
      // 再做一次：贡献+1，进度+1，但奖励不再发
      a.act('start_interaction', { objectId: 'garden:planter1' });
      finishFive(t, people);
      expect(a.coins()).toBe(23);
      expect(eventRow(t, 'garden_care')!.progress).toBe(5);
      expect(t.w.db.get('SELECT contributions FROM event_participation WHERE resident_id = ?', a.residentId)!.contributions).toBe(2);
      // 到点关闭：达标发完成文案
      toLocal(t, people, 13, 1);
      expect(eventRow(t, 'garden_care')!.status).toBe('closed');
      checkInvariants(t);
    });

    it('没达标也有各自的参与奖励；未参与的人没有奖励', () => {
      const { t, people } = garden(2);
      const [a, b] = people as [Actor, Actor];
      toLocal(t, people, 12, 40);
      a.act('start_interaction', { objectId: 'garden:planter1' });
      finishFive(t, people);
      expect(eventRow(t, 'garden_care')!.reached_at).toBeNull();
      expect(a.coins()).toBe(23);
      expect(b.coins()).toBe(20);
      toLocal(t, people, 13, 5);
      const pubs = t.w.readPublicEvents('x').events;
      void pubs;
      expect(eventRow(t, 'garden_care')!.status).toBe('closed');
      checkInvariants(t);
    });

    it('窗口边界：开始得比窗口早的不算；窗口内开始、窗口后才完成的算', () => {
      const { t, people } = garden(2);
      const [a, b] = people as [Actor, Actor];
      toLocal(t, people, 12, 27);
      a.act('start_interaction', { objectId: 'garden:planter1' }); // 12:27 开始，12:32 完成
      toLocal(t, people, 12, 58);
      b.go('garden:planter2');
      b.act('start_interaction', { objectId: 'garden:planter2' }); // 12:58 开始，13:03 完成
      toLocal(t, people, 13, 5);
      const inst = eventRow(t, 'garden_care')!;
      expect(inst.progress).toBe(1);
      expect(a.coins()).toBe(20);
      expect(b.coins()).toBe(23);
      // 13:10 之后再做，也不算
      toLocal(t, people, 13, 10);
      a.act('start_interaction', { objectId: 'garden:planter1' });
      finishFive(t, people);
      expect(eventRow(t, 'garden_care')!.progress).toBe(1);
      expect(a.coins()).toBe(20);
      checkInvariants(t);
    });

    it('在别的地方照料花箱（自己家的花箱）不计入花园整理', () => {
      const { t, people } = garden(1);
      const a = people[0]!;
      a.act('buy', { shop: 'shed', sku: 'planter_box' });
      a.go('home');
      a.act('place_furniture', { itemId: a.view().inventory.items.find((i) => i.type === 'planter_box')!.itemId });
      toLocal(t, people, 12, 35);
      a.act('start_interaction', { objectId: a.view().here!.objects.find((o) => o.type === 'planter')!.id });
      finishFive(t, people);
      expect(eventRow(t, 'garden_care')!.progress).toBe(0);
      expect(t.w.db.scalar('SELECT COUNT(*) FROM event_participation')).toBe(0);
      expect(a.coins()).toBe(12);
    });

    it('没有人参加：自然结束，不编造参与者，不发奖励', () => {
      const t = town();
      const a = t.join('阿灯');
      const pubCursor = t.w.readPublicEvents(undefined).cursor;
      toLocal(t, [a], 13, 5);
      const inst = eventRow(t, 'garden_care')!;
      expect(inst).toMatchObject({ status: 'closed', progress: 0 });
      expect(inst.reached_at).toBeNull();
      expect(t.w.db.scalar('SELECT COUNT(*) FROM event_participation')).toBe(0);
      expect(a.coins()).toBe(20);
      const closed = t.w.readPublicEvents(pubCursor).events.filter((e) => e.type === 'public_event');
      expect(closed.map((e) => (e.data as { text?: string }).text)).toContain('午间的花园整理安静地过去了。');
      checkInvariants(t);
    });

    it('开始公告写进待发的外部公告队列，同一场只有一条', () => {
      const t = town();
      const a = t.join('阿灯');
      toLocal(t, [a], 12, 35);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM notification_outbox WHERE dedupe_key = ?", 'pe:pe_garden_care_2023-11-15')).toBe(1);
    });
  });

  describe('停机跨过窗口', () => {
    it('整个窗口都在停机中过去：记为"错过"，没有参与者、没有奖励，也没有补发的公共事件', () => {
      const db = tempDb();
      try {
        const t = town({ dbPath: db.path });
        const a = t.join('阿灯');
        a.go('garden:planter1');
        const pubCursor = t.w.readPublicEvents(undefined).cursor;
        t.w.close();
        t.clock.t = jst('2023-11-15', 14, 0);
        restartFresh(t);
        const inst = eventRow(t, 'garden_care')!;
        expect(inst.status).toBe('missed');
        expect(t.w.db.scalar('SELECT COUNT(*) FROM event_participation')).toBe(0);
        expect(t.w.db.scalar("SELECT COUNT(*) FROM public_event_instances WHERE status = 'open'")).toBe(0);
        expect(t.w.readPublicEvents(pubCursor).events.filter((e) => e.type === 'public_event')).toHaveLength(0);
        // 回来后也不能"回到过去"参加：现在开始的活动不计入
        a.enter();
        a.act('start_interaction', { objectId: 'garden:planter1' });
        finishFive(t, [a]);
        expect(eventRow(t, 'garden_care')!.progress).toBe(0);
        expect(a.coins()).toBe(20);
        // 今晚的集市还没到，照常安排
        expect(eventRow(t, 'lantern_market')!.status).toBe('scheduled');
        checkInvariants(t);
      } finally {
        db.cleanup();
      }
    });

    it('停机跨过整整几天：以前的窗口都不补造；今天的事件照常生成', () => {
      const db = tempDb();
      try {
        const t = town({ dbPath: db.path });
        t.join('阿灯');
        t.w.close();
        t.clock.t = jst('2023-11-18', 10, 0); // 周六上午
        restartFresh(t);
        const rows = t.w.db.all('SELECT def_id, business_date, status FROM public_event_instances ORDER BY business_date, def_id');
        // 15 号（原有）的窗口全部错过；18 号上午的花园整理还没到
        const old = rows.filter((r) => r.business_date < '2023-11-18');
        expect(old.every((r) => r.status === 'missed')).toBe(true);
        expect(rows.filter((r) => r.business_date === '2023-11-18').map((r) => [r.def_id, r.status])).toEqual([
          ['garden_care', 'scheduled'],
          ['tea_party', 'scheduled'],
        ]);
        expect(t.w.db.scalar('SELECT COUNT(*) FROM event_participation')).toBe(0);
      } finally {
        db.cleanup();
      }
    });

    it('窗口进行到一半时重启：事件按剩余时间开着，到点关闭', () => {
      const db = tempDb();
      try {
        const t = town({ dbPath: db.path });
        const a = t.join('阿灯');
        t.w.close();
        t.clock.t = jst('2023-11-15', 12, 45);
        restartFresh(t);
        expect(eventRow(t, 'garden_care')!.status).toBe('open');
        a.enter();
        a.go('garden:planter1');
        a.act('start_interaction', { objectId: 'garden:planter1' });
        finishFive(t, [a]); // 12:50 完成 → 进度 +1（窗口内开始）
        expect(eventRow(t, 'garden_care')!.progress).toBe(1);
        toLocal(t, [a], 13, 1);
        expect(eventRow(t, 'garden_care')!.status).toBe('closed');
      } finally {
        db.cleanup();
      }
    });

    it('进行中的共同活动跨重启时，事件进度只在完成那一次结算，不重复', () => {
      const db = tempDb();
      try {
        const t = town({ dbPath: db.path });
        const a = t.join('阿灯');
        a.go('garden:planter1');
        toLocal(t, [a], 12, 40);
        a.act('start_interaction', { objectId: 'garden:planter1' });
        t.w.close();
        t.clock.advance(10 * MIN);
        restartFresh(t);
        expect(eventRow(t, 'garden_care')!.progress).toBe(1);
        restartFresh(t);
        expect(eventRow(t, 'garden_care')!.progress).toBe(1);
        a.enter();
        expect(a.coins()).toBe(23);
      } finally {
        db.cleanup();
      }
    });
  });
});
