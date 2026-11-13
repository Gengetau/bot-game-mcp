/**
 * 栖灯镇：人与人的面对面互动按距离判定（询问爱好、当面邀请、报价与成交、当面还东西）。
 * 依据：设计文档第 12 章「可见 可听 可交互分别判定」；docs/TOWN.md「够得着」。
 * 距离一律用权威位置（positionOfResident）在测试里独立量一遍，不借用被测函数。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { homeId } from '../../src/world/content.js';
import { nearbyAudience } from '../../src/world/hearing.js';
import { canInteractPerson } from '../../src/world/reach.js';
import { directionInput, positionOfResident } from '../../src/world/space.js';
import { Actor, makeTown, type Town } from './helpers.js';
import { checkInvariants } from './invariants.js';

const NO_GOALS = { shortGoals: 0, longGoals: 0 };
/** 广场里的两个远点，以及广场东边界（x = 44）两侧相距 1.3 米的两点 */
const NEAR_SPAWN = { x: 32, z: 30.25 };
const FAR_CORNER = { x: 21, z: 19 };
const EDGE_PLAZA = { x: 43.5, z: 26.5 };
const EDGE_ROAD = { x: 44.8, z: 26.5 };

function gap(t: Town, a: Actor, b: Actor): number {
  const p = positionOfResident(t.w, a.residentId, t.w.now())!;
  const q = positionOfResident(t.w, b.residentId, t.w.now())!;
  return Math.hypot(p.x - q.x, p.z - q.z);
}

function two() {
  const t = makeTown({ seed: 'reach-1', params: NO_GOALS });
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  return { t, a, b };
}

describe('面对面互动按距离：personReach', () => {
  it('参数默认 3 米：大于物件的 interactDistance、小于听力距离', () => {
    const { t } = two();
    expect(t.w.params.personReach).toBe(3);
    expect(t.w.params.personReach).toBeGreaterThan(t.w.map.interactDistance);
    expect(t.w.params.personReach).toBeLessThan(t.w.map.hearDistance);
  });

  it('同一区域但很远 → 邀请、报价、询问都 too_far，带上能直接 navigate 的 approach 对象；走近后全部成功', () => {
    const { t, a, b } = two();
    b.go(FAR_CORNER);
    expect(gap(t, a, b)).toBeGreaterThan(3);
    expect(a.row().location_id).toBe(b.row().location_id); // 同一个区域标签
    for (const [type, f] of [
      ['invite', { to: b.residentId }],
      ['offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } }],
      ['ask_hobby', { target: b.residentId }],
    ] as const) {
      const e = a.fail(type, f);
      expect([type, e.code, e.reason, e.data]).toEqual([type, 'precondition_failed', 'too_far', { navigateTo: b.residentId }]);
    }
    expect(t.w.db.scalar('SELECT COUNT(*) FROM offers')).toBe(0);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM home_access_grants')).toBe(0);
    // navigateTo 可以原样交给 navigate 的 approach
    const nav = a.act('navigate', { approach: b.residentId });
    expect(nav.status).toBe('accepted');
    a.walk();
    expect(gap(t, a, b)).toBeLessThanOrEqual(3);
    expect(a.act('ask_hobby', { target: b.residentId }).status).toBe('completed');
    expect(a.act('invite', { to: b.residentId }).status).toBe('completed');
    expect(a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } }).status).toBe('accepted');
    checkInvariants(t);
  });

  it('隔着区域边界但很近 → 成功（判定里没有区域标签）', () => {
    const { t, a, b } = two();
    a.go(EDGE_PLAZA);
    b.go(EDGE_ROAD);
    expect([a.row().location_id, b.row().location_id]).toEqual(['plaza', 'road']);
    expect(gap(t, a, b)).toBeLessThan(2);
    expect(a.act('invite', { to: b.residentId }).status).toBe('completed');
    expect(a.act('ask_hobby', { target: b.residentId }).status).toBe('completed');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 2 } });
    expect(b.act('accept_offer', { offerId: o.offer.id }).offer.status).toBe('accepted');
    checkInvariants(t);
  });

  it('同一区域、距离恰好在边界两侧：personReach 之内成功，之外 too_far', () => {
    const { t, a, b } = two();
    a.go({ x: 30, z: 26 });
    b.go({ x: 30, z: 28.8 }); // 2.8 米
    expect(gap(t, a, b)).toBeCloseTo(2.8, 1);
    expect(canInteractPerson(t.w, a.row(), b.row())).toBe(true);
    b.go({ x: 30, z: 29.4 }); // 3.4 米
    expect(gap(t, a, b)).toBeCloseTo(3.4, 1);
    expect(canInteractPerson(t.w, a.row(), b.row())).toBe(false);
    expect(a.fail('ask_hobby', { target: b.residentId }).reason).toBe('too_far');
  });

  it('不在同一个场景实例：私宅里和公共场景里的人互相 not_here，不带位置信息，也分不出是在别人家、离线还是不存在', () => {
    const { t, a, b } = two();
    const c = t.join('阿木');
    a.go(NEAR_SPAWN);
    b.go(homeId(b.residentId));
    expect(b.pos().instance).toBe(b.residentId);
    // 整个错误体（去掉本来就不同的字段后）逐字比较：这里每个场景发的动作、对象都一样，所以什么都不用去掉
    const probe = (who: Actor, target: string) =>
      [
        ['invite', { to: target }],
        ['offer', { kind: 'gift', to: target, give: { coins: 1 } }],
        ['ask_hobby', { target }],
      ].map(([type, f]) => who.fail(type as string, f as Record<string, unknown>).toJSON());
    const fromOutside = probe(a, b.residentId); // 对着屋里的人
    expect(fromOutside).toHaveLength(3);
    for (const body of fromOutside) expect(body).toMatchObject({ error: 'precondition_failed', reason: 'not_here' });
    for (const body of fromOutside) expect(Object.keys(body).sort()).toEqual(['error', 'message', 'reason']);
    expect(probe(b, a.residentId)).toEqual(fromOutside); // 屋里对着屋外的人
    // 和「不存在」「离线」整个响应体相同
    c.leave();
    expect(probe(a, c.residentId)).toEqual(fromOutside);
    expect(probe(a, 'r_nobody')).toEqual(fromOutside);
    checkInvariants(t);
  });

  it('在小游戏里的人够不着，也不能对他们发起（not_here）', () => {
    const { t, a, b } = two();
    const c = t.join('阿木');
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    expect(c.fail('ask_hobby', { target: a.residentId }).reason).toBe('not_here');
    expect(c.fail('invite', { to: a.residentId }).reason).toBe('not_here');
    expect(canInteractPerson(t.w, c.row(), a.row())).toBe(false);
  });

  it('按这一刻现算的位置判定：一方在走路，越过 personReach 的那一刻起被拒', () => {
    const { t, a, b } = two();
    a.go(NEAR_SPAWN);
    b.go({ x: 32, z: 29 });
    a.act('navigate', { to: FAR_CORNER });
    let sawFar = false;
    for (let i = 0; i < 60 && !sawFar; i++) {
      t.advance(500);
      b.heartbeat();
      a.heartbeat();
      const d = gap(t, a, b);
      if (d > 3.05) {
        // 走着的人这一刻已在 3 米之外：被拒，与它的区域标签无关
        expect(a.pos().moving).toBe(true);
        expect(canInteractPerson(t.w, a.row(), b.row())).toBe(false);
        expect(b.fail('ask_hobby', { target: a.residentId }).reason).toBe('too_far');
        sawFar = true;
      } else if (d < 2.9) {
        expect(canInteractPerson(t.w, a.row(), b.row())).toBe(true);
      }
    }
    expect(sawFar).toBe(true);
    // 走着的人在 3 米之内也可以发起
    const c = t.join('阿木');
    c.go({ x: 32, z: 29 });
    t.advance(1);
    expect(c.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } }).status).toBe('accepted');
  });
});

describe('方向输入走开（按现算位置判定）', () => {
  /** 一方按住方向键 ms 毫秒（每 150 毫秒重发一次，像真客户端），用的是 directionInput 本身 */
  function hold(a: Actor, x: number, z: number, ms: number, seq: { n: number }) {
    for (let left = ms; left > 0; left -= 150) {
      directionInput(a.t.w, a.auth, { seq: ++seq.n, epoch: a.row().control_epoch, x, z, source: 1 });
      a.t.advance(Math.min(150, left));
    }
  }

  it('一方用方向输入走开后 accept_offer 被拒（too_far）且报价仍在；走回来后成交', () => {
    const { t, a, b } = two();
    b.go({ x: 30, z: 26 });
    a.go({ x: 32.2, z: 26 }); // 2.2 米，a 在 b 的东边
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5 } });
    const seq = { n: 0 };
    hold(a, 1, 0, 1200, seq); // 往东走开
    expect(a.pos().moving || gap(t, a, b) > 3).toBe(true);
    expect(gap(t, a, b)).toBeGreaterThan(3);
    const e = b.fail('accept_offer', { offerId: o.offer.id });
    expect([e.code, e.reason, e.data]).toEqual(['precondition_failed', 'too_far', { navigateTo: a.residentId }]);
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('open');
    expect(a.view().inventory.coins.reserved).toBe(5);
    // 方向输入的租约到期后停在原地，判定依旧
    t.advance(2000);
    b.heartbeat();
    expect(a.pos().moving).toBe(false);
    expect(b.fail('accept_offer', { offerId: o.offer.id }).reason).toBe('too_far');
    // 走回来：方向输入同样按现算位置判定
    hold(a, -1, 0, 1200, seq);
    t.advance(600);
    expect(gap(t, a, b)).toBeLessThanOrEqual(3);
    expect(b.act('accept_offer', { offerId: o.offer.id }).offer.status).toBe('accepted');
    expect([a.coins(), b.coins()]).toEqual([15, 25]);
    checkInvariants(t);
  });
});

describe('「在场」的定义和附近聊天共用', () => {
  it('离线、在小游戏里的人：nearbyAudience 和 canInteractPerson 一致地排除', () => {
    const { t, a, b } = two();
    const c = t.join('阿木');
    const d = t.join('小雨');
    const ids = () => nearbyAudience(t.w, a.row(), t.w.now()).map((r) => r.resident_id);
    const reachable = () => [b, c, d].filter((x) => canInteractPerson(t.w, a.row(), x.row())).map((x) => x.residentId);
    // 先把大家放到彼此很近的地方
    for (const x of [b, c, d]) x.go({ x: 30, z: 27 });
    a.go({ x: 30, z: 26 });
    expect(ids().sort()).toEqual([a, b, c, d].map((x) => x.residentId).sort());
    expect(reachable().sort()).toEqual([b, c, d].map((x) => x.residentId).sort());
    c.leave();
    const p = d.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    d.act('start_game', { activityId: p.activity.id });
    expect(ids().sort()).toEqual([a.residentId]);
    expect(reachable()).toEqual([]);
  });
});

describe('报价与成交按距离', () => {
  it('accept_offer 在对方走远后被拒（too_far），报价仍开着、预留不动；走近再接受成功', () => {
    const { t, a, b } = two();
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 5 } });
    a.go(FAR_CORNER);
    const e = b.fail('accept_offer', { offerId: o.offer.id });
    expect([e.reason, e.data]).toEqual(['too_far', { navigateTo: a.residentId }]);
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('open');
    expect(a.view().inventory.coins.reserved).toBe(5);
    expect([a.coins(), b.coins()]).toEqual([20, 20]);
    b.go(a.residentId);
    expect(b.act('accept_offer', { offerId: o.offer.id }).offer.status).toBe('accepted');
    expect([a.coins(), b.coins()]).toEqual([15, 25]);
    checkInvariants(t);
  });

  it('只是跨过区域边界不撤销；任一方进了私宅（换场景实例）才撤销', () => {
    const { t, a, b } = two();
    a.go(EDGE_PLAZA);
    b.go({ x: 43, z: 26.5 });
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 3 } });
    b.go(EDGE_ROAD);
    expect(b.row().location_id).toBe('road');
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('open');
    a.go(homeId(a.residentId));
    expect(t.w.db.get('SELECT status, close_reason FROM offers WHERE offer_id = ?', o.offer.id)).toMatchObject({ status: 'cancelled' });
    expect(a.view().inventory.coins.reserved).toBe(0);
    checkInvariants(t);
  });

  it('进入小游戏撤销报价（双方任一方）', () => {
    const { t, a, b } = two();
    const c = t.join('阿木');
    const o = c.act('offer', { kind: 'gift', to: a.residentId, give: { coins: 4 } });
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    expect(t.w.db.get('SELECT status FROM offers WHERE offer_id = ?', o.offer.id)!.status).toBe('cancelled');
    expect(c.view().inventory.coins.reserved).toBe(0);
    checkInvariants(t);
  });

  it('当面还东西按距离：站得远 too_far（带 navigateTo），走近后归还成功', () => {
    const { t, a, b } = two();
    const itemId = a.view().inventory.items.find((i) => i.type === 'book' && !i.borrowedFrom)!.itemId;
    const o = a.act('offer', { kind: 'loan', to: b.residentId, give: { items: [{ itemId }] } });
    b.act('accept_offer', { offerId: o.offer.id });
    a.go(FAR_CORNER);
    const e = b.fail('return_item', { itemId });
    expect([e.reason, e.data]).toEqual(['too_far', { navigateTo: a.residentId }]);
    expect(t.w.db.get('SELECT holder_id FROM items WHERE item_id = ?', itemId)!.holder_id).toBe(b.residentId);
    b.go(a.residentId);
    expect(b.act('return_item', { itemId }).status).toBe('completed');
    expect(t.w.db.get('SELECT holder_id FROM items WHERE item_id = ?', itemId)!.holder_id).toBe(a.residentId);
    checkInvariants(t);
  });
});

describe('too_far 的线上形状：navigateTo 在错误体顶层，没有 data 这一层', () => {
  it('WorldError 序列化后顶层有 navigateTo，且可以原样做 navigate 的 approach', () => {
    const { a, b } = two();
    b.go(FAR_CORNER);
    const e = a.fail('invite', { to: b.residentId });
    const wire = JSON.parse(JSON.stringify({ ok: false, ...e.toJSON() }));
    expect(wire.navigateTo).toBe(b.residentId);
    expect(wire.reason).toBe('too_far');
    expect(wire.data).toBeUndefined();
  });

  it('指南、居民提示词、TOWN.md 不再把它写成 data.navigateTo', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = ['../../src/mcp/town.ts', '../../../agent-kit/prompts/resident-zh.md', '../../../agent-kit/src/prompts.ts', '../../../../docs/TOWN.md'];
    for (const f of files) expect(readFileSync(join(here, f), 'utf8'), f).not.toContain('data.navigateTo');
  });
});

describe('仿真不变量 face_to_face_in_reach 覆盖当面归还', () => {
  async function inv() {
    const lib = (await import(/* @vite-ignore */ pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/world-lib.ts')).href)) as { Invariants: new (echo: (m: string) => void) => any };
    return new lib.Invariants(() => undefined);
  }
  it('记为当面归还、但双方实际相距很远 → 违例；站得近 → 通过；走归还箱不要求', async () => {
    const { t, a, b } = two();
    b.go(FAR_CORNER);
    expect(gap(t, a, b)).toBeGreaterThan(3);
    const record = (how: string) => t.w.fact('loan_returned', [{ id: b.residentId, role: 'borrower' }, { id: a.residentId, role: 'owner' }], { item: 'x', how });
    const i = await inv();
    record('return_box');
    i.checkFaceToFace(t.w, 'return_item', b.residentId, {}, t.w.now());
    expect(i.totalViolations).toBe(0);
    record('in_person');
    i.checkFaceToFace(t.w, 'return_item', b.residentId, {}, t.w.now());
    expect(i.totalViolations).toBe(1);
    b.go(a.residentId);
    record('in_person');
    i.checkFaceToFace(t.w, 'return_item', b.residentId, {}, t.w.now());
    expect(i.totalViolations).toBe(1);
    expect(i.runs.get('face_to_face_in_reach').checks).toBe(2);
  });
});

describe('here.chat 只按受众表', () => {
  it('跨过区域边界后仍能看到当时听到的话；当时不在受众里的人看不到', () => {
    const { t, a, b } = two();
    a.act('speak', { text: '广场上的一句话' });
    const late = t.join('阿木'); // 说完之后才来：不在受众里
    expect(b.view().here!.chat.map((m) => m.text)).toEqual(['广场上的一句话']);
    b.go('tea_house');
    expect(b.row().location_id).toBe('tea_house');
    expect(b.view().here!.chat.map((m) => m.text)).toEqual(['广场上的一句话']);
    expect(late.view().here!.chat).toEqual([]);
  });

  it('同一区域但在听力距离之外的人，当时不在受众里，视图里看不到（与区域标签无关）', () => {
    const { t, a, b } = two();
    a.go({ x: 22, z: 20 });
    b.go({ x: 40, z: 31 }); // 同在广场，相距超过 9 米
    expect(a.row().location_id).toBe(b.row().location_id);
    expect(gap(t, a, b)).toBeGreaterThan(t.w.map.hearDistance);
    a.act('speak', { text: '这句话传不远' });
    expect(a.view().here!.chat.map((m) => m.text)).toEqual(['这句话传不远']);
    expect(b.view().here!.chat).toEqual([]);
  });
});
