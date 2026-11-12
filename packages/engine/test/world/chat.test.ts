/**
 * 栖灯镇聊天：附近聊天（按权威位置固定受众）和全镇公屏（独立频道、游标、限流、AI 唤醒、过期清理）。
 * 对照设计稿 v2.0 第 5、12、13 章和正确性矩阵的「聊天权限」「公屏与 AI」两行。
 */
import { describe, expect, it } from 'vitest';
import { townChatPage, townChatDigest, purgeTownChat } from '../../src/world/chat.js';
import { canHear, nearbyAudience, roomOf } from '../../src/world/hearing.js';
import { distanceBetween, renewNavigation, whereabouts } from '../../src/world/space.js';
import { agentView, chatHistory, meView, publicView } from '../../src/world/views.js';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';

const DAY = 24 * 3600_000;
/** 附近聊天不被每分钟额度挡住（本文件里关心的是受众，不是额度） */
const LOOSE = { chatPerMinute: 600, chatBurst: 100 };
/** 公屏不被额度挡住（需要连发很多条的测试用） */
const LOOSE_TOWN = { townChatPerMinute: 600, townChatBurst: 100 };

const heard = (a: Actor): string[] => chatHistory(a.t.w, a.residentId, null, 100).messages.map((m) => m.text);
const pulse = (...xs: Actor[]) => xs.forEach((x) => x.heartbeat());
const nearbyEvents = (a: Actor, cursor: string): string[] => a.events(cursor).events.filter((e) => e.type === 'chat').map((e) => String((e.data as { text?: unknown }).text));

/** 走到地图上的一点并确认到了（位置落在格子中心上，距离判定可以精确）。 */
function stand(a: Actor, x: number, z: number): void {
  a.go({ x, z });
  const p = a.pos();
  expect(Math.hypot(p.x - x, p.z - z), `${a.name} 没有站在 (${x}, ${z})，实际 (${p.x}, ${p.z})`).toBeLessThan(0.01);
}

/** 让所有人继续在场地推进时间。 */
const stepWalk = (t: Town, ms: number, people: Actor[]) => {
  for (let left = ms; left > 0; left -= 500) {
    t.advance(Math.min(500, left));
    for (const x of people) {
      x.heartbeat();
      const nav = whereabouts(t.w, x.row(), t.clock.t).navigation;
      if (nav) renewNavigation(t.w, x.auth, { navigationId: nav.navigationId, revision: nav.revision });
    }
  }
};

// 广场里一排互相看得见的站位（z=27.25，避开喷泉和长椅）：x 每差 1 米就是 1 米
const PX = 22.25;
const PZ = 27.25;

describe('附近聊天：受众由权威位置决定', () => {
  it('交谈距离是边界：9 米以内（含）听得到，再远一点就听不到；距离来自地图配置', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const near = t.join('小岚', 'agent');
    const edge = t.join('小满');
    const far = t.join('小朵', 'agent');
    stand(a, PX, PZ);
    stand(near, PX + 8.5, PZ);
    stand(edge, PX + 9, PZ);
    stand(far, PX + 9.5, PZ);
    pulse(a, near, edge, far);
    expect(t.w.map.hearDistance).toBe(9);
    const out = a.act('say_nearby', { text: '大家好' });
    expect(out).toMatchObject({ scope: 'nearby', heardBy: 2 });
    expect(heard(near)).toEqual(['大家好']);
    expect(heard(edge)).toEqual(['大家好']);
    expect(heard(far)).toEqual([]);
    expect(heard(a)).toEqual(['大家好']); // 自己也记着
    // 判定函数本身
    expect(distanceBetween(t.w, a.residentId, far.residentId, t.w.now())).toBeCloseTo(9.5);
    expect(nearbyAudience(t.w, a.row(), t.w.now()).map((r) => r.resident_id).sort()).toEqual([a.residentId, near.residentId, edge.residentId].sort());
  });

  it('同一区域也要看距离：广场两头隔得远，听不到', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    stand(a, 21.25, 27.25);
    stand(b, 42.75, 27.25); // 同在广场，相距 21.5 米
    pulse(a, b);
    expect(a.row().location_id).toBe('plaza');
    expect(b.row().location_id).toBe('plaza');
    a.act('say_nearby', { text: '喂——' });
    expect(heard(b)).toEqual([]);
  });

  it('隔墙不因平面距离近就听见：茶馆里的人听不到墙外的路上，也听不到隔壁书屋；同一间屋里听得到', () => {
    const t = makeTown({ params: LOOSE });
    const inTea = t.join('阿灯');
    const inTea2 = t.join('小岚', 'agent');
    const inBook = t.join('小满');
    const onRoad = t.join('小朵', 'agent');
    stand(inTea, 17.25, 6.25);
    stand(inTea2, 13.25, 6.25);
    stand(inBook, 22.75, 6.25); // 和阿灯只差 5.5 米，但隔着两道墙
    stand(onRoad, 17.25, 13.75); // 墙外的路上，7.5 米
    pulse(inTea, inTea2, inBook, onRoad);
    const d = (a: Actor, b: Actor) => distanceBetween(t.w, a.residentId, b.residentId, t.w.now())!;
    expect(d(inTea, inBook)).toBeLessThan(t.w.map.hearDistance);
    expect(d(inTea, onRoad)).toBeLessThan(t.w.map.hearDistance);
    expect(roomOf(t.w, inTea.pos())).toBe('town:tea_house');
    expect(roomOf(t.w, inBook.pos())).toBe('town:bookshop');
    expect(roomOf(t.w, onRoad.pos())).toBe('town:outdoors');
    inTea.act('say_nearby', { text: '屋里的话' });
    expect(heard(inTea2)).toEqual(['屋里的话']);
    expect(heard(inBook)).toEqual([]);
    expect(heard(onRoad)).toEqual([]);
    // 反过来也一样：墙外的话进不了屋
    onRoad.act('say_nearby', { text: '外面的话' });
    expect(heard(inTea)).toEqual(['屋里的话']);
    expect(canHear(t.w, inTea.pos(), inTea2.pos())).toBe(true);
    expect(canHear(t.w, inTea.pos(), onRoad.pos())).toBe(false);
  });

  it('室外的几片区域算同一个房间：在路上、广场边走边聊，不被区域边界切开', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    stand(a, 21.25, 27.25); // 广场
    stand(b, 17.75, 25.25); // 广场西边的小路（road 区域）
    pulse(a, b);
    expect(a.row().location_id).toBe('plaza');
    expect(b.row().location_id).not.toBe('plaza');
    a.act('say_nearby', { text: '过来聊' });
    expect(heard(b)).toEqual(['过来聊']);
  });

  it('房间切换：后来进屋的人听不到进屋之前的话，也补不到；进屋之后的话听得到', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const late = t.join('小满');
    stand(a, 13.25, 6.25);
    stand(b, 11.25, 6.25);
    stand(late, 11.25, 13.75); // 屋外
    pulse(a, b, late);
    const cursor = late.view().cursor;
    a.act('say_nearby', { text: '进屋之前的话' });
    late.go('tea_house');
    pulse(a, b, late);
    expect(heard(late)).toEqual([]);
    expect(nearbyEvents(late, cursor)).toEqual([]);
    a.act('say_nearby', { text: '进屋之后的话' });
    expect(heard(late)).toEqual(['进屋之后的话']);
    expect(heard(b)).toEqual(['进屋之后的话', '进屋之前的话']);
  });

  it('行走中可以说也可以听；走远之后不再收到新消息，已经听到的历史还在', () => {
    const t = makeTown({ params: LOOSE });
    const speaker = t.join('阿灯');
    const walker = t.join('小岚', 'agent');
    stand(speaker, PX, PZ);
    stand(walker, PX + 2, PZ);
    pulse(speaker, walker);
    walker.act('navigate', { to: { x: PX + 17, z: PZ } }); // 向东走远
    const people = [speaker, walker];
    const lines: { text: string; near: boolean; moving: boolean }[] = [];
    for (let i = 0; i < 24; i++) {
      stepWalk(t, 1_000, people);
      const d = distanceBetween(t.w, speaker.residentId, walker.residentId, t.w.now())!;
      const text = `第${i}句`;
      speaker.act('say_nearby', { text });
      lines.push({ text, near: d <= t.w.map.hearDistance, moving: walker.pos().moving });
    }
    const got = new Set(heard(walker));
    expect(lines.some((l) => l.near && l.moving), '走路时听到过').toBe(true);
    expect(lines.some((l) => !l.near), '走远了').toBe(true);
    for (const l of lines) expect(got.has(l.text), `${l.text}（距离内=${l.near}）`).toBe(l.near);
    // 走远之后历史没有被收回
    expect(got.size).toBe(lines.filter((l) => l.near).length);
    // 说话的人也在走：走着说一样按那一刻的位置定受众
    speaker.act('navigate', { to: { x: PX + 8, z: PZ } });
    stepWalk(t, 1_000, people);
    expect(speaker.pos().moving).toBe(true);
    const before = heard(walker).length;
    speaker.act('say_nearby', { text: '边走边说' });
    const closeEnough = (distanceBetween(t.w, speaker.residentId, walker.residentId, t.w.now()) ?? 99) <= t.w.map.hearDistance;
    expect(heard(walker).length).toBe(before + (closeEnough ? 1 : 0));
  });

  it('受众在发送时固定：事后走近的人听不到、补不到；走开的人已经听到的不会被收回', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const stay = t.join('小岚', 'agent');
    const comer = t.join('小满');
    stand(a, PX, PZ);
    stand(stay, PX + 3, PZ);
    stand(comer, PX + 20, PZ);
    pulse(a, stay, comer);
    const cursor = comer.view().cursor;
    a.act('say_nearby', { text: '这句话只给当时在的人' });
    comer.go({ x: PX + 4, z: PZ });
    pulse(a, stay, comer);
    expect(heard(comer)).toEqual([]);
    expect(nearbyEvents(comer, cursor)).toEqual([]);
    stay.go({ x: PX + 25, z: PZ });
    pulse(a, stay, comer);
    expect(heard(stay)).toEqual(['这句话只给当时在的人']);
  });

  it('私宅里的聊天：同时受实例和在场约束；房主不在场没有旁听权；后来进屋的人看不到之前的话；别家同坐标的实例互不相闻', () => {
    const t = makeTown({ params: LOOSE });
    const host = t.join('阿灯');
    const g1 = t.join('小岚', 'agent');
    const g2 = t.join('小满');
    const other = t.join('小朵', 'agent');
    const door = t.join('小夏');
    for (const g of [g1, g2]) host.act('invite', { to: g.residentId });
    host.go('home');
    g1.go(`home:${host.residentId}`);
    pulse(host, g1, g2, other, door);
    // 另一户人家：同一个门口坐标，但是另一个实例
    other.go('home');
    expect(host.pos().instance).toBe(host.residentId);
    expect(other.pos().instance).toBe(other.residentId);
    expect(host.pos().scene).toBe(other.pos().scene);
    pulse(host, g1, g2, other, door);
    g1.act('say_nearby', { text: '屋里说话' });
    expect(heard(host)).toEqual(['屋里说话']);
    expect(heard(other)).toEqual([]); // 别家
    expect(heard(door)).toEqual([]); // 在会馆门前
    // 房主出门：之后屋里的话房主听不到（没有旁听权）
    host.go('plaza');
    g2.go(`home:${host.residentId}`);
    pulse(host, g1, g2, other, door);
    expect(host.row().location_id).toBe('plaza');
    const hostCursor = host.view().cursor;
    g2.act('say_nearby', { text: '房主不在' });
    expect(heard(g1)).toEqual(['房主不在', '屋里说话']);
    expect(heard(host)).toEqual(['屋里说话']);
    expect(nearbyEvents(host, hostCursor)).toEqual([]);
    // 房主回来：补不到刚才的谈话；g2 在屋里听不到进屋之前 g1 说的那句
    host.go('home');
    expect(heard(host)).toEqual(['屋里说话']);
    expect(heard(g2)).toEqual(['房主不在']);
    // 屋里的话不会出现在屋外的人的视图里
    expect(JSON.stringify(meView(t.w, door.row(), door.clientId))).not.toContain('屋里说话');
  });

  it('离线时保存着的位置不构成听见资格；明确退出后不进新的受众；重连只补曾经有权收到的', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    stand(a, PX, PZ);
    stand(b, PX + 2, PZ);
    pulse(a, b);
    const cursor = b.view().cursor;
    a.act('say_nearby', { text: '第一句' });
    b.leave();
    // 位置还保存着，且就在旁边——但不在场
    expect(b.pos().x).toBeCloseTo(PX + 2);
    expect(nearbyAudience(t.w, a.row(), t.w.now()).map((r) => r.resident_id)).toEqual([a.residentId]);
    a.act('say_nearby', { text: '第二句（b 已离开）' });
    b.enter();
    pulse(a, b);
    expect(heard(b)).toEqual(['第一句']);
    expect(nearbyEvents(b, cursor)).toEqual(['第一句']); // 重连只补曾经有权收到的
    a.act('say_nearby', { text: '第三句（b 回来了）' });
    expect(heard(b)).toEqual(['第三句（b 回来了）', '第一句']);
  });

  it('断线宽限内按在场处理，宽限结束后不再进入新的受众', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    stand(a, PX, PZ);
    stand(b, PX + 2, PZ);
    pulse(a, b);
    // b 不再续租：宽限（60 秒）之内仍然是有效在场
    t.advanceAlive(30_000, [a]);
    expect(b.row().present_since).not.toBeNull();
    a.act('say_nearby', { text: '宽限之内' });
    expect(heard(b)).toEqual(['宽限之内']);
    t.advanceAlive(40_000, [a]);
    expect(b.row().present_since).toBeNull();
    a.act('say_nearby', { text: '宽限之后' });
    expect(heard(b)).toEqual(['宽限之内']);
  });

  it('小游戏期间不接收周围的普通附近聊天', () => {
    const t = makeTown({ params: LOOSE });
    const [p1, p2, watcher] = [t.join('甲'), t.join('乙', 'agent'), t.join('丙')];
    for (const x of [p1, p2, watcher]) x.go('arcade');
    pulse(p1, p2, watcher);
    const host = p1.act('propose_game', { game: 'number_bomb' });
    p2.act('join_game', { activityId: host.activity.id });
    p1.act('start_game', { activityId: host.activity.id });
    pulse(p1, p2, watcher);
    expect(p1.row().activity_id).not.toBeNull();
    watcher.act('say_nearby', { text: '游戏馆里的闲话' });
    expect(heard(p1)).toEqual([]);
    expect(heard(p2)).toEqual([]);
    expect(heard(watcher)).toEqual(['游戏馆里的闲话']);
  });

  it('发送入口明确范围：附近消息永远不会因为走远或换场景悄悄变成全镇消息', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const far = t.join('小满');
    stand(a, PX, PZ);
    stand(b, PX + 2, PZ);
    far.go('garden');
    pulse(a, b, far);
    a.act('say_nearby', { text: '附近的话' });
    a.act('speak', { text: '旧名也是附近' });
    a.go('tea_house');
    pulse(a, b, far);
    a.act('say_nearby', { text: '换了地方还是附近' });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(0);
    expect(heard(far)).toEqual([]);
    expect(townChatPage(t.w, far.residentId).messages).toEqual([]);
    expect(heard(b)).toEqual(['旧名也是附近', '附近的话']);
  });

  it('文字规则：先清洗；空的、超长的给明确错误（say_nearby 不截断）；旧名 speak 保持截断', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('say_nearby', { text: '[CQ:at,qq=all] {@1}\n\t好' });
    const first = heard(b)[0]!;
    expect(first).not.toContain('[CQ:');
    expect(first).not.toContain('{@');
    expect(first).not.toMatch(/[\n\t]/);
    const empty = a.fail('say_nearby', { text: '  \n ' });
    expect(empty.code).toBe('bad_request');
    const long = a.fail('say_nearby', { text: '灯'.repeat(121) });
    expect(long).toMatchObject({ code: 'bad_request', reason: 'text_too_long' });
    expect(long.data).toMatchObject({ maxChars: 120, chars: 121 });
    expect(long.message).toContain('120');
    a.act('say_nearby', { text: '😀'.repeat(120) }); // 恰好上限，按字符数不拆开表情
    a.act('speak', { text: '灯'.repeat(300) });
    expect([...heard(b)[0]!]).toHaveLength(120);
    expect(a.fail('say_nearby', {}).code).toBe('bad_request');
  });

  it('附近聊天的事件里没有坐标；回执里只有受众人数', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    stand(a, PX, PZ);
    stand(b, PX + 2, PZ);
    pulse(a, b);
    const cb = b.view().cursor;
    const out = a.act('say_nearby', { text: '没有坐标' });
    const text = JSON.stringify([out, b.events(cb).events]);
    expect(text).not.toMatch(/"x":|"z":|points|arriveAt/);
  });
});

// ───────────────────────── 全镇公屏 ─────────────────────────

const sayTown = (a: Actor, text: string, extra: Record<string, unknown> = {}) => a.act('say_town', { text, ...extra });
const townTexts = (a: Actor, q: Parameters<typeof townChatPage>[2] = {}) => townChatPage(a.t.w, a.residentId, q).messages.map((m) => m.text);

describe('全镇公屏：谁能读、谁能发', () => {
  it('已认证居民读保留期内的历史，不要求在场；之后进镇的人也读得到', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const reader = t.join('小岚', 'agent');
    sayTown(a, '大家好');
    reader.leave();
    expect(reader.row().present_since).toBeNull();
    expect(townTexts(reader)).toEqual(['大家好']);
    const late = t.join('小满');
    expect(townTexts(late)).toEqual(['大家好']);
    const m = townChatPage(t.w, late.residentId).messages[0]!;
    expect(m).toMatchObject({ kind: 'chat', text: '大家好', mine: false, from: { id: a.residentId, name: '阿灯' } });
    expect(townChatPage(t.w, a.residentId).messages[0]!.mine).toBe(true);
  });

  it('只有有效在场的居民能发；不在场被明确拒绝', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    a.leave();
    const e = a.fail('say_town', { text: '我不在' });
    expect(e).toMatchObject({ code: 'precondition_failed', reason: 'not_present' });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(0);
  });

  it('对局中只读：发被拒绝，读照常；对局结束后又能发', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const [p1, p2, other] = [t.join('甲'), t.join('乙', 'agent'), t.join('丙')];
    for (const x of [p1, p2]) x.go('arcade');
    pulse(p1, p2, other);
    sayTown(other, '开局之前的公屏');
    const g = p1.act('propose_game', { game: 'number_bomb' });
    p2.act('join_game', { activityId: g.activity.id });
    p1.act('start_game', { activityId: g.activity.id });
    pulse(p1, p2, other);
    expect(p1.row().activity_id).not.toBeNull();
    const denied = p1.fail('say_town', { text: '对局中想发公屏' });
    expect(denied).toMatchObject({ code: 'precondition_failed', reason: 'in_activity' });
    expect(townTexts(p1)).toEqual(['开局之前的公屏']); // 能读
    sayTown(other, '对局中别人发的');
    expect(townTexts(p2)).toEqual(['开局之前的公屏', '对局中别人发的']);
    p1.act('quit_game');
    expect(p1.row().activity_id).toBeNull();
    sayTown(p1, '退出之后能发了');
    expect(townTexts(other).at(-1)).toBe('退出之后能发了');
  });

  it('公屏内容不进入对局 AI 的观察上下文：视图、事件、摘要都没有', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const [p1, p2, other] = [t.join('甲'), t.join('乙', 'agent'), t.join('丙')];
    for (const x of [p1, p2]) x.go('arcade');
    pulse(p1, p2, other);
    const g = p1.act('propose_game', { game: 'number_bomb' });
    p2.act('join_game', { activityId: g.activity.id });
    p1.act('start_game', { activityId: g.activity.id });
    pulse(p1, p2, other);
    const cursor = p2.view().cursor;
    sayTown(other, '乙你快来帮忙', { kind: 'help', place: 'tea_house' });
    sayTown(other, 'SECRET-公屏暗号');
    const v = agentView(t.w, p2.row(), p2.clientId);
    expect(JSON.stringify(v)).not.toContain('公屏暗号');
    expect(v.town_chat).toBeUndefined();
    expect(p2.events(cursor).events.filter((e) => e.type === 'town_chat_mention')).toEqual([]);
    expect(townChatDigest(t.w, p2.row(), t.w.now())).toBeNull();
  });
});

describe('全镇公屏：分页与游标', () => {
  it('首屏是最近 50 条；分页有界且不重不漏；limit 有上限', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (let i = 0; i < 130; i++) {
      t.advance(1_000);
      pulse(a, b);
      sayTown(a, `第${String(i).padStart(3, '0')}条`);
    }
    const first = townChatPage(t.w, b.residentId);
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0]!.text).toBe('第080条');
    expect(first.messages.at(-1)!.text).toBe('第129条');
    expect(first.older).not.toBeNull();
    const seen = first.messages.map((m) => m.text);
    let older = first.older;
    let pages = 1;
    while (older) {
      const p = townChatPage(t.w, b.residentId, { before: older, limit: 40 });
      expect(p.messages.length).toBeLessThanOrEqual(40);
      expect(p.resync).toBeUndefined();
      seen.unshift(...p.messages.map((m) => m.text));
      older = p.older;
      pages++;
    }
    expect(pages).toBe(3); // 50 + 40 + 40
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    expect(seen).toEqual([...seen].sort());
    expect(townChatPage(t.w, b.residentId, { limit: 100000 }).messages).toHaveLength(100); // 上限
    expect(townChatPage(t.w, b.residentId, { limit: 0 }).messages).toHaveLength(50); // 0 当作默认
    expect(townChatPage(t.w, b.residentId, { limit: 3 }).messages).toHaveLength(3);
  });

  it('after 游标追新：只给之后的，一页有界，more 提示还有；水位上没有新的就是空', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    sayTown(a, '一');
    const head = townChatPage(t.w, b.residentId).cursor;
    expect(townChatPage(t.w, b.residentId, { after: head }).messages).toEqual([]);
    for (const s of ['二', '三', '四']) sayTown(a, s);
    const p1 = townChatPage(t.w, b.residentId, { after: head, limit: 2 });
    expect(p1.messages.map((m) => m.text)).toEqual(['二', '三']);
    expect(p1.more).toBe(true);
    const p2 = townChatPage(t.w, b.residentId, { after: p1.cursor, limit: 2 });
    expect(p2.messages.map((m) => m.text)).toEqual(['四']);
    expect(p2.more).toBeUndefined();
    // 用某条消息自己的 id 当游标也行
    const all = townChatPage(t.w, b.residentId).messages;
    expect(townChatPage(t.w, b.residentId, { after: all[1]!.id }).messages.map((m) => m.text)).toEqual(['三', '四']);
    expect(() => townChatPage(t.w, b.residentId, { before: all[1]!.id, after: all[1]!.id })).toThrow();
  });

  it('游标绑定世界、主体和通道：别人的、别的通道的、乱写的、伪造的都得到重同步，不会退回全量查询', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const other = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const x = other.join('别处');
    sayTown(a, '秘密之外的话');
    sayTown(x, '另一个世界的话');
    const mine = townChatPage(t.w, a.residentId).messages[0]!.id;
    const theirs = townChatPage(other.w, x.residentId).messages[0]!.id;
    const results = [
      townChatPage(t.w, b.residentId, { after: mine }), // 别人（另一个主体）的游标
      townChatPage(t.w, b.residentId, { before: mine }),
      townChatPage(t.w, a.residentId, { after: theirs }), // 另一个世界的游标
      townChatPage(t.w, a.residentId, { after: t.w.cursorOf(a.residentId) }), // 私人事件流的游标
      townChatPage(t.w, a.residentId, { after: chatHistory(t.w, a.residentId, null, 1).next ?? 'n1.xxxxxxxxxx' }), // 附近聊天历史的游标
      townChatPage(t.w, a.residentId, { after: 'garbage' }),
      townChatPage(t.w, a.residentId, { before: `${mine.slice(0, -1)}A` }), // 改了签名
      townChatPage(t.w, a.residentId, { after: 'c9zzzzz.0000000000' }),
    ];
    for (const r of results) {
      expect(r.resync).toBe(true);
      expect(r.messages).toEqual([]); // 不会借机吐出全量
      expect(r.older).toBeNull();
    }
    // 同一条消息，不同人拿到的 id 不同（绑定主体），且不含数据库自增号
    expect(townChatPage(t.w, b.residentId).messages[0]!.id).not.toBe(mine);
    expect(JSON.stringify(townChatPage(t.w, b.residentId))).not.toMatch(/message_id|messageId|"seq"/);
  });

  it('对外编号是公屏自己的连续序号，不随别处的活动（附近聊天、别人的私人事件）出现空档', () => {
    const t = makeTown({ params: { ...LOOSE, ...LOOSE_TOWN } });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满');
    sayTown(a, '第一条');
    for (let i = 0; i < 5; i++) c.act('say_nearby', { text: `别处的话${i}` });
    sayTown(b, '第二条');
    const ids = townChatPage(t.w, a.residentId).messages.map((m) => m.id);
    const seqs = ids.map((id) => Number.parseInt(id.slice(1, id.indexOf('.')), 36));
    expect(seqs).toEqual([1, 2]);
  });
});

describe('全镇公屏：限流、重复、文字规则', () => {
  it('每人每分钟 6 条、突发 2 条：连发第 3 条被限流，过一会儿恢复；被拒绝的不占额度也不产生消息', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    sayTown(a, '一');
    sayTown(a, '二');
    const e = a.fail('say_town', { text: '三' });
    expect(e.code).toBe('rate_limited');
    expect(e.data).toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(townTexts(a)).toEqual(['一', '二']);
    t.advance(10_000);
    a.heartbeat();
    sayTown(a, '三');
    expect(a.fail('say_town', { text: '四' }).code).toBe('rate_limited');
    // 一分钟 6 条的速率：每 10 秒 1 条，持续不会被拒
    for (let i = 0; i < 6; i++) {
      t.advance(10_000);
      a.heartbeat();
      sayTown(a, `稳${i}`);
    }
    expect(townTexts(a)).toHaveLength(9);
  });

  it('与附近聊天、物件使用的额度互相独立', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    sayTown(a, '一');
    sayTown(a, '二');
    expect(a.fail('say_town', { text: '三' }).code).toBe('rate_limited');
    // 公屏额度用完，附近聊天不受影响
    for (let i = 0; i < 3; i++) a.act('say_nearby', { text: `近${i}` });
    expect(a.fail('say_nearby', { text: '近3' }).code).toBe('rate_limited'); // 附近自己的额度（突发 3）
    // 附近额度用完，公屏不受影响（另一个人验证）
    sayTown(b, '小岚的一');
    sayTown(b, '小岚的二');
    for (let i = 0; i < 3; i++) b.act('say_nearby', { text: `岚近${i}` });
    // 物件使用（start_interaction 的额度）也不被公屏占用
    const bucketOf = (x: Actor, bucket: string) => t.w.db.get('SELECT 1 AS x FROM rate_buckets WHERE resident_id = ? AND bucket = ?', x.residentId, bucket);
    expect(bucketOf(a, 'town_chat')).toBeTruthy();
    expect(bucketOf(a, 'chat')).toBeTruthy();
    expect(bucketOf(a, 'interact')).toBeUndefined();
  });

  it('额度持久化在世界数据库里：重启不清零', () => {
    const file = tempDb();
    try {
      const t = makeTown({ dbPath: file.path });
      const a = t.join('阿灯');
      sayTown(a, '一');
      sayTown(a, '二');
      expect(a.fail('say_town', { text: '三' }).code).toBe('rate_limited');
      t.advance(1_000);
      t.restart();
      a.enter();
      expect(a.fail('say_town', { text: '三' }).code).toBe('rate_limited'); // 没有因为重启回满
      t.advance(10_000);
      a.heartbeat();
      sayTown(a, '三'); // 时间过去了才恢复
      expect(townTexts(a)).toEqual(['一', '二', '三']);
    } finally {
      file.cleanup();
    }
  });

  it('重复内容：同一个人窗口内说一模一样的话被拒绝（忽略空白和大小写），换个说法或过了窗口可以；别人说同样的话不受影响', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    sayTown(a, '有人一起喝茶吗');
    expect(a.fail('say_town', { text: '有人一起喝茶吗' })).toMatchObject({ code: 'precondition_failed', reason: 'duplicate' });
    expect(a.fail('say_town', { text: ' 有人 一起喝茶吗  ' }).reason).toBe('duplicate');
    sayTown(a, '有人一起喝茶吗？');
    sayTown(b, '有人一起喝茶吗');
    t.advanceAlive(6 * 60_000, [a, b]);
    sayTown(a, '有人一起喝茶吗');
    expect(townTexts(b)).toHaveLength(4);
  });

  it('文字规则：先清洗；空的和超长的给明确错误，不截断；kind 只能是 chat / activity / help', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    sayTown(a, '[CQ:at,qq=all] {@1}\n好');
    const text = townTexts(a)[0]!;
    expect(text).not.toContain('[CQ:');
    expect(text).not.toContain('{@');
    expect(text).not.toContain('\n');
    expect(a.fail('say_town', { text: '   ' }).code).toBe('bad_request');
    expect(a.fail('say_town', {}).code).toBe('bad_request');
    const long = a.fail('say_town', { text: '灯'.repeat(121) });
    expect(long).toMatchObject({ code: 'bad_request', reason: 'text_too_long' });
    sayTown(a, '😀'.repeat(120));
    expect(a.fail('say_town', { text: 'x', kind: 'shout' }).code).toBe('bad_request');
    expect(townTexts(a)).toHaveLength(2);
  });

  it('活动 / 求助消息的位置提示只到公共地点（区域级）；不能指向私宅或坐标；消息里没有坐标', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    sayTown(a, '茶馆有空位，来坐坐', { kind: 'activity', place: 'tea_house' });
    for (const place of [`home:${a.residentId}`, 'home', 'road', 'nowhere', { x: 3, z: 4 }, 42]) {
      expect(a.fail('say_town', { text: '想去 ' + JSON.stringify(place), kind: 'help', place }).code, JSON.stringify(place)).toBe('bad_request');
    }
    const m = townChatPage(t.w, b.residentId).messages[0]!;
    expect(m).toMatchObject({ kind: 'activity', place: { id: 'tea_house', name: '栖灯茶馆' } });
    expect(JSON.stringify(m)).not.toMatch(/"x":|"z":/);
    // 位置提示只是提示：公屏动作不会让 b 移动、入座或交易
    const before = b.pos();
    expect(b.pos()).toEqual(before);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM interactions')).toBe(0);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM offers')).toBe(0);
  });
});

describe('全镇公屏：AI 唤醒与摘要', () => {
  const woke = (t: Town, x: Actor, cursor: string) => x.events(cursor).events.filter((e) => e.type === 'town_chat_mention');

  it('普通闲聊不唤醒任何人；world_wait 之类的等待不会因为它返回', async () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满', 'agent');
    const cb = b.view().cursor;
    const cc = c.view().cursor;
    for (let i = 0; i < 5; i++) sayTown(a, `今天天气真不错 ${i}`);
    expect(woke(t, b, cb)).toEqual([]);
    expect(b.events(cb).events).toEqual([]);
    expect(await t.w.waitResident(b.residentId, cb, undefined, 0)).toBe('timeout');
    expect(await t.w.waitResident(c.residentId, cc, undefined, 0)).toBe('timeout');
    expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE type = 'town_chat_mention'")).toBe(0);
  });

  it('明确提到自己（名字或 @名字）才进入待处理队列；等待因此返回；事件里文字有长度上限、没有坐标', async () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满', 'agent');
    const cb = b.view().cursor;
    const cc = c.view().cursor;
    sayTown(a, `@小岚 ${'你'.repeat(100)}`, { kind: 'help', place: 'garden' });
    const evs = woke(t, b, cb);
    expect(evs).toHaveLength(1);
    const data = evs[0]!.data as { reason: string; text: string; from: { id: string }; place: { id: string } };
    expect(data).toMatchObject({ reason: 'mention', from: { id: a.residentId }, kind: 'help', place: { id: 'garden' } });
    expect([...data.text].length).toBeLessThanOrEqual(t.w.params.townChatDigestChars);
    expect(JSON.stringify(evs)).not.toMatch(/"x":|"z":/);
    expect(await t.w.waitResident(b.residentId, cb, undefined, 0)).toBe('event');
    expect(woke(t, c, cc)).toEqual([]);
    expect(await t.w.waitResident(c.residentId, cc, undefined, 0)).toBe('timeout');
    // 名字只是别的词的一部分不算；@名字 算；发言的人提到自己不叫醒自己
    const cb2 = b.view().cursor;
    t.advance(1_000);
    sayTown(a, '小岚的茶泡好了吗');
    expect(woke(t, b, cb2)).toHaveLength(0);
    sayTown(a, '@小岚的茶泡好了吗');
    sayTown(b, '我是@小岚');
    expect(woke(t, b, cb2)).toHaveLength(1);
  });

  it('与已有约定有关的话才算：对方有一笔等着我回应的报价时，对方在公屏上说话会叫醒我；无关的人不会', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满', 'agent');
    a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    const cb = b.view().cursor;
    const cc = c.view().cursor;
    sayTown(a, '礼物收到了就告诉我一声哦'); // 普通闲聊：有未决报价也不叫醒
    expect(woke(t, b, cb)).toEqual([]);
    sayTown(a, '礼物的事想请你帮个忙', { kind: 'help' }); // 约定 + 求助类消息：才叫醒
    expect(woke(t, b, cb).map((e) => (e.data as { reason: string }).reason)).toEqual(['commitment']);
    expect(woke(t, c, cc)).toEqual([]);
  });

  it('对局中的提及不触发；不在场的不触发；静音的不触发；对局结束后恢复', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const player = t.join('小岚', 'agent');
    const mate = t.join('小满');
    const muted = t.join('小朵', 'agent');
    const away = t.join('小夏', 'agent');
    muted.act('update_profile', { muteTownChat: true });
    away.leave();
    for (const x of [player, mate]) x.go('arcade');
    pulse(a, player, mate, muted);
    const g = mate.act('propose_game', { game: 'number_bomb' });
    player.act('join_game', { activityId: g.activity.id });
    mate.act('start_game', { activityId: g.activity.id });
    pulse(a, player, mate, muted);
    const cursors = new Map([player, muted, away].map((x) => [x.residentId, x.view().cursor]));
    sayTown(a, '@小岚 @小朵 @小夏 都来看看');
    for (const x of [player, muted, away]) expect(woke(t, x, cursors.get(x.residentId)!), x.name).toEqual([]);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE type = 'town_chat_mention'")).toBe(0);
    // 静音的人读得到历史，只是不被唤醒、视图里没有摘要
    expect(townTexts(muted)).toEqual(['@小岚 @小朵 @小夏 都来看看']);
    expect(townChatDigest(t.w, muted.row(), t.w.now())).toBeNull();
    // 对局结束（退出）之后，再次提到才会触发
    player.act('quit_game');
    t.advance(1_000);
    pulse(a, player);
    sayTown(a, '@小岚 欢迎回来');
    expect(woke(t, player, cursors.get(player.residentId)!)).toHaveLength(1);
  });

  it('唤醒有额度：几个人互相提及形成不了无限循环（超出额度的消息仍在频道里，只是不再叫醒）', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const cb = b.view().cursor;
    for (let i = 0; i < 8; i++) {
      t.advance(5_000);
      pulse(a, b);
      sayTown(a, `@小岚 第${i}次叫你`);
    }
    expect(woke(t, b, cb)).toHaveLength(t.w.params.townChatWakePairBurst);
    expect(townTexts(b)).toHaveLength(8);
    // 一小时后额度恢复
    t.advanceAlive(60 * 60_000, [a, b]);
    const cb2 = b.view().cursor;
    sayTown(a, '@小岚 一小时之后再叫你');
    expect(woke(t, b, cb2)).toHaveLength(1);
  });

  it('公共活动和求助在下一次读视图时以少量摘要附带：条数、长度有上限；闲聊不在里面；提到我的会标出来', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    sayTown(a, '随便聊聊的一句');
    for (let i = 0; i < 6; i++) sayTown(a, `${i}号活动：${'茶'.repeat(200).slice(0, 100)}`, { kind: 'activity', place: 'tea_house' });
    sayTown(a, '谁能帮我找本书？', { kind: 'help', place: 'bookshop' });
    const v = agentView(t.w, b.row(), b.clientId) as { town_chat?: { from: string; kind: string; text: string; place?: string; mentions_you?: boolean }[] };
    expect(v.town_chat).toHaveLength(t.w.params.townChatDigestLines);
    expect(v.town_chat!.every((l) => [...l.text].length <= t.w.params.townChatDigestChars)).toBe(true);
    expect(v.town_chat!.map((l) => l.text).join()).not.toContain('随便聊聊');
    expect(v.town_chat!.at(-1)).toMatchObject({ from: '阿灯', kind: 'help', place: '檐下书屋' });
    // 闲聊里提到我，也会进摘要，并标出来
    sayTown(a, '@小岚 在吗');
    const v2 = agentView(t.w, b.row(), b.clientId) as { town_chat?: { mentions_you?: boolean; text: string }[] };
    expect(v2.town_chat!.at(-1)).toMatchObject({ text: '@小岚 在吗', mentions_you: true, untrusted: true });
    // 自己说的不进自己的摘要；窗口过了就没有了
    expect(JSON.stringify(agentView(t.w, a.row(), a.clientId))).not.toContain('谁能帮我找本书');
    t.advanceAlive(20 * 60_000, [a, b]);
    expect((agentView(t.w, b.row(), b.clientId) as { town_chat?: unknown }).town_chat).toBeUndefined();
  });

  it('公屏不进匿名观众能拿到的任何东西：公开投影、公开事件流、日报', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const pc = t.w.publicCursor();
    sayTown(a, 'PUBLIC-SCREEN-暗号@小岚', { kind: 'activity', place: 'garden' });
    sayTown(a, '再来一条 OUTSIDE-暗号');
    const pub = JSON.stringify([publicView(t.w), t.w.readPublicEvents(pc), meView(t.w, b.row(), b.clientId).events]);
    expect(pub).not.toContain('暗号');
    expect(t.w.readPublicEvents(pc).events.filter((e) => e.type.includes('chat'))).toEqual([]);
    expect(JSON.stringify(t.w.db.all('SELECT payload FROM notification_outbox'))).not.toContain('暗号');
  });
});

describe('全镇公屏：保留期与过期清理（定时任务）', () => {
  it('保留 7 天：读的时候就按保留期筛；过期清理由定时任务做并推进最早可续传的位置，旧游标得到重同步', () => {
    const t = makeTown({ params: LOOSE_TOWN });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const emptyCursor = townChatPage(t.w, b.residentId).cursor; // 还没有消息时的水位
    sayTown(a, '老消息');
    const oldCursor = townChatPage(t.w, b.residentId).cursor; // 看完老消息之后的水位
    t.advance(3 * DAY);
    a.enter();
    b.enter();
    sayTown(a, '三天前的消息');
    t.advance(5 * DAY); // 老消息 8 天，另一条 5 天
    a.enter();
    b.enter();
    expect(townTexts(b)).toEqual(['三天前的消息']);
    // 定时任务跑过了：表里的老消息已经删掉
    expect(t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(1);
    const head = t.w.streamHead(`tc:${t.w.worldId}`);
    expect(head.highWater).toBe(2);
    expect(head.retainedFrom).toBe(2);
    // 保留期之外的游标：明确的重同步
    // 中间有消息已经过了保留期、没法补给你：必须重同步
    expect(townChatPage(t.w, b.residentId, { after: emptyCursor })).toMatchObject({ resync: true, messages: [] });
    // 看完老消息的游标和被删的区间没有缺口：照常追新
    expect(townChatPage(t.w, b.residentId, { after: oldCursor }).messages.map((m) => m.text)).toEqual(['三天前的消息']);
    // 序号不倒退：新消息接着数，重同步之后的新游标可用
    sayTown(a, '新消息');
    const page = townChatPage(t.w, b.residentId);
    expect(page.messages.map((m) => m.text)).toEqual(['三天前的消息', '新消息']);
    expect(townChatPage(t.w, b.residentId, { after: page.messages[0]!.id }).messages.map((m) => m.text)).toEqual(['新消息']);
  });

  it('清理是一条按间隔自己续期的定时任务；重启后仍在；单独调用清理幂等', () => {
    const t = makeTown();
    const job = () => t.w.db.get("SELECT status, due_at FROM scheduled_jobs WHERE kind = 'town_chat_purge'");
    expect(job()?.status).toBe('pending');
    const due = Number(job()!.due_at);
    expect(due).toBeGreaterThan(t.clock.t);
    t.advance(t.w.params.townChatPurgeEveryMs + 1_000);
    const next = job()!;
    expect(next.status).toBe('pending');
    expect(Number(next.due_at)).toBeGreaterThan(due); // 续期而不是做完就没有了
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'town_chat_purge'")).toBe(1);
    expect(purgeTownChat(t.w, t.clock.t)).toBe(0);
    expect(purgeTownChat(t.w, t.clock.t)).toBe(0);
  });

  it('保留期是参数：短保留期时过期的立刻读不到（即使清理任务还没跑）', () => {
    const t = makeTown({ params: { ...LOOSE_TOWN, townChatRetentionMs: 60_000, townChatPurgeEveryMs: 3600_000 } });
    const a = t.join('阿灯');
    sayTown(a, '很快过期');
    t.advanceAlive(61_000, [a]);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(1); // 清理任务还没跑
    expect(townTexts(a)).toEqual([]);
  });
});
