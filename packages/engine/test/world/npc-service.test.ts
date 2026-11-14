/**
 * NPC 的台词与服务（N1b）：here.npcs、ask_npc、NPC 在附近聊天里开口（受众、最小间隔、不叫醒 AI）、
 * 掌柜卖茶、闲逛者被搭话时延长停留、台词里没有玩家文字。
 *
 * 写法：位置用真的走过去；等条件而不是固定睡眠；负向断言（没收到、没唤醒、没多说一句）都先让该发生的事真的发生再断言没有。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeName } from '../../src/core/text.js';
import { DESTINATIONS, NPCS, NPC_LINES, PUBLIC_EVENTS, npcDef, npcLineMatches, renderNpcLine } from '../../src/world/content.js';
import { WorldError } from '../../src/world/errors.js';
import { roomOf } from '../../src/world/hearing.js';
import { agentView, chatHistory, directory, publicView } from '../../src/world/views.js';
import { positionOfNpc, positionOfResident } from '../../src/world/space.js';
import { distance, isWalkable } from '../../src/world/spatial/index.js';
import { shopsAt } from '../../src/world/property.js';
import { KEEPER, STROLLER, makeTown, type Actor, type Town } from './helpers.js';
import { checkInvariants } from './invariants.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const err = (e: WorldError) => `${e.code}/${e.reason ?? ''}`;
/** 闲逛者每次停留 10 分钟：测试里它一直坐在长椅上，不会在中途走开 */
const STILL = { npcStayMinMs: 600_000, npcStayMaxMs: 600_000 };

const chatEvents = (a: Actor, cursor?: string) => a.events(cursor).events.filter((e) => e.type === 'chat');
const npcChat = (a: Actor, cursor: string) => chatEvents(a, cursor).filter((e) => (e.data.from as { kind?: string }).kind === 'npc');
const wakes = (a: Actor, cursor: string) => a.events(cursor).events.filter((e) => e.type === 'town_chat_mention');
const dist = (t: Town, a: Actor, npcId: string) => distance(positionOfResident(t.w, a.residentId, t.clock.t)!, positionOfNpc(t.w, npcId, t.clock.t)!);
const reachOf = (t: Town) => t.w.params.personReach;
/** 世界里真实居民的名字：NPC 台词里 {name} 只能是它们之一 */
const names = (t: Town) => t.w.db.all('SELECT name FROM residents').map((r) => String(r.name));

/** 茶馆里离掌柜够不着、但在同一间屋里的一个点（茶桌旁）。 */
const FAR_IN_TEA_HOUSE = 'tea_house:table1';

describe('here.npcs', () => {
  it('在广场：两名 NPC 都列出；near 只对够得着的为真；有区域标签和话题，没有坐标；不混进居民列表', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const v = a.view();
    expect(v.here!.npcs.map((n) => n.id).sort()).toEqual([KEEPER, STROLLER].sort());
    const keeper = v.here!.npcs.find((n) => n.id === KEEPER)!;
    expect(keeper).toMatchObject({ name: '茶馆掌柜', role: 'service', place: 'tea_house', near: false, shop: 'tea_counter' });
    expect(keeper.topics.map((x) => x.id)).toEqual(['hello', 'tea', 'town']);
    const stroller = v.here!.npcs.find((n) => n.id === STROLLER)!;
    expect(stroller).toMatchObject({ name: '广场闲逛者', role: 'ambient', place: 'plaza' });
    expect(stroller.shop).toBeUndefined();
    // 没有坐标、折线、到达时间
    expect(JSON.stringify(v.here!.npcs)).not.toMatch(/"(x|z|heading|points|arriveAt|nav|navigation)":/);
    // 不进任何居民列表
    expect(v.here!.residents.map((r) => r.id)).toEqual([b.residentId]);
    expect(JSON.stringify(directory(t.w, t.clock.t))).not.toContain('npc:');
    expect(JSON.stringify(publicView(t.w))).not.toContain('npc:');
  });

  it('near 随走近走远变化；走进茶馆后掌柜近、闲逛者远', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const near = (id: string) => a.view().here!.npcs.find((n) => n.id === id)!.near;
    expect(near(KEEPER)).toBe(false);
    a.go(KEEPER);
    expect(near(KEEPER)).toBe(true);
    expect(near(STROLLER)).toBe(false);
    expect(a.view().here!.npcs.find((n) => n.id === KEEPER)!.place).toBe('tea_house');
    a.go(STROLLER);
    expect(near(STROLLER)).toBe(true);
    expect(near(KEEPER)).toBe(false);
    // 刚迈步离开：按现算的位置，走出 personReach 之后就不近了
    a.act('navigate', { to: 'tea_house' });
    for (let i = 0; i < 80 && dist(t, a, STROLLER) <= reachOf(t) + 0.2; i++) t.advance(500);
    expect(near(STROLLER)).toBe(false);
  });

  it('在私宅里是空数组（走回广场后又有）；agentView 里带 far 标记和 npc:true 的台词', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go('home');
    expect(a.row().location_id).toBe(`home:${a.residentId}`);
    expect(a.view().here!.npcs).toEqual([]);
    expect((agentView(t.w, a.row(), a.clientId).here as { npcs: unknown[] }).npcs).toEqual([]);
    a.go('plaza');
    const av = agentView(t.w, a.row(), a.clientId).here as { npcs: { id: string; far?: true; topics: string[]; shop?: string }[] };
    expect(av.npcs.find((n) => n.id === KEEPER)).toMatchObject({ far: true, shop: 'tea_counter', topics: ['hello', 'tea', 'town'] });
    expect(av.npcs.find((n) => n.id === STROLLER)).toBeDefined();
  });

  it('在一局小游戏里 here 本来就是 null（不因 npcs 改变）', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (const x of [a, b]) x.go('arcade:table1');
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    expect(a.view().here).toBeNull();
    // 对局中任何世界动作（包括 ask_npc）都被挡在管线上
    expect(err(a.fail('ask_npc', { npcId: KEEPER }))).toBe('precondition_failed/in_activity');
  });
});

describe('ask_npc', () => {
  it('够得着时成功：text 来自模板、带话题、掌柜带货品；回执的 messageId 是提问人自己的听到序号', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go(KEEPER);
    const out = a.act('ask_npc', { npcId: KEEPER, topic: 'hello' });
    expect(out).toMatchObject({ status: 'completed', npc: { id: KEEPER, name: '茶馆掌柜' }, topic: 'hello', spoken: true, messageId: 1 });
    expect(npcLineMatches(KEEPER, out.text, names(t))).toBe(true);
    expect(out.text).toContain('阿灯');
    expect(out.text).toContain('30'); // 今天的存量来自程序
    expect(out.topics.map((x: { id: string }) => x.id)).toEqual(['hello', 'tea', 'town']);
    expect(out.shop).toEqual(shopsAt(t.w, 'tea_house', t.clock.t)[0]);
    expect(out.shop.goods[0]).toMatchObject({ sku: 'tea_leaves', price: 2, stock: 30 });
    checkInvariants(t);
  });

  it('每个话题都有回答，且都出自模板；town 话题只列公共地点和开着的活动', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go(KEEPER);
    for (const topic of ['hello', 'tea', 'town']) {
      t.advance(3_000);
      const out = a.act('ask_npc', { npcId: KEEPER, topic });
      expect(out.topic).toBe(topic);
      expect(npcLineMatches(KEEPER, out.text, names(t)), out.text).toBe(true);
    }
    t.advance(3_000);
    const town = a.act('ask_npc', { npcId: KEEPER, topic: 'town' }).text as string;
    for (const name of ['灯下广场', '栖灯茶馆', '檐下书屋', '公共厨房', '后巷花园', '游戏馆']) expect(town).toContain(name);
    expect(town).not.toContain('灯笼路');
  });

  it('未知话题或不写话题按默认话题回答，不报错', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go(KEEPER);
    expect(a.act('ask_npc', { npcId: KEEPER, topic: '不存在的话题' }).topic).toBe('hello');
    t.advance(3_000);
    expect(a.act('ask_npc', { npcId: KEEPER }).topic).toBe('hello');
    t.advance(3_000);
    expect(a.act('ask_npc', { npcId: KEEPER, topic: { evil: 1 } }).topic).toBe('hello');
  });

  it('闲逛者按姿态和时段回答：坐在长椅上的回答出自 hello.sit 模板', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go(STROLLER);
    const out = a.act('ask_npc', { npcId: STROLLER });
    expect(NPC_LINES[`${STROLLER}/hello.sit`]!.some((tpl) => renderNpcLine(tpl, { name: a.row().name, period: ['早上', '中午', '下午', '傍晚', '夜里'].find((p) => out.text.includes(p)) ?? '', place: '灯下广场' }) === out.text)).toBe(true);
    expect(out.shop).toBeUndefined();
    expect(out.topics.map((x: { id: string }) => x.id)).toEqual(['hello', 'bench', 'books']);
  });

  it('太远：too_far 带 navigateTo，照着走过去再问就成功；没有副作用', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const before = t.w.db.scalar('SELECT COUNT(*) FROM chat_messages');
    const e = a.fail('ask_npc', { npcId: KEEPER });
    expect(err(e)).toBe('precondition_failed/too_far');
    expect((e.data as { navigateTo: string }).navigateTo).toBe(KEEPER);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages')).toBe(before);
    a.go((e.data as { navigateTo: string }).navigateTo);
    expect(a.act('ask_npc', { npcId: KEEPER }).status).toBe('completed');
    // 在茶馆里但离掌柜远（茶桌旁）：同样 too_far
    a.go(FAR_IN_TEA_HOUSE);
    expect(dist(t, a, KEEPER)).toBeGreaterThan(reachOf(t));
    t.advance(3_000);
    expect(err(a.fail('ask_npc', { npcId: KEEPER }))).toBe('precondition_failed/too_far');
  });

  it('不存在的编号、居民编号、缺编号：not_found；在私宅里：not_here', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    for (const npcId of ['npc:nobody', b.residentId, '', undefined, 42]) expect(err(a.fail('ask_npc', { npcId })), String(npcId)).toBe('precondition_failed/not_found');
    a.go(KEEPER);
    a.go('home');
    expect(a.row().location_id).toBe(`home:${a.residentId}`);
    expect(err(a.fail('ask_npc', { npcId: KEEPER }))).toBe('precondition_failed/not_here');
    expect(err(a.fail('ask_npc', { npcId: STROLLER }))).toBe('precondition_failed/not_here');
    // 回到镇上（走出家门），再走到掌柜身边又可以了
    a.go('plaza');
    a.go(KEEPER);
    expect(a.act('ask_npc', { npcId: KEEPER }).status).toBe('completed');
  });

  it('限流：令牌桶用完 rate_limited（每位居民一个桶，别人不受影响）；过一会儿恢复', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    const burst = t.w.params.npcAskBurst;
    for (let i = 0; i < burst; i++) expect(a.act('ask_npc', { npcId: KEEPER }).status).toBe('completed');
    const e = a.fail('ask_npc', { npcId: KEEPER });
    expect(e.code).toBe('rate_limited');
    expect(e.reason).toBe('npc');
    expect(b.act('ask_npc', { npcId: KEEPER }).status).toBe('completed');
    t.advanceAlive(60_000, [a, b], 10_000);
    expect(a.act('ask_npc', { npcId: KEEPER }).status).toBe('completed');
  });
});

describe('NPC 开口：受众与最小间隔', () => {
  /** 掌柜身边的一位听众，加上各种听不到的人。 */
  function scene() {
    const t = makeTown({ params: STILL });
    const asker = t.join('阿灯');
    const near = t.join('小岚');
    asker.go(KEEPER);
    near.go(KEEPER);
    return { t, asker, near };
  }

  it('听距内的第三个人收到 chat 事件，from.kind 是 npc；说话的 NPC 不在受众里；历史、here.chat、agentView 里发言人是 NPC 且不抛错', () => {
    const { t, asker, near } = scene();
    const ca = asker.view().cursor;
    const cn = near.view().cursor;
    const out = asker.act('ask_npc', { npcId: KEEPER });
    const ev = npcChat(near, cn);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ scope: 'nearby', space: 'tea_house', from: { id: KEEPER, name: '茶馆掌柜', kind: 'npc' }, text: out.text });
    // 提问人自己也在受众里：事件和回执里的 text、messageId 是同一句
    const own = npcChat(asker, ca);
    expect(own).toHaveLength(1);
    expect(own[0]!.data).toMatchObject({ text: out.text, messageId: out.messageId });
    // 受众里没有 NPC
    expect(t.w.db.scalar("SELECT COUNT(*) FROM chat_audience WHERE resident_id LIKE 'npc:%'")).toBe(0);
    const msg = t.w.db.get("SELECT * FROM chat_messages WHERE sender_id = ?", KEEPER)!;
    expect(msg.space_id).toBe('tea_house');
    expect(t.w.db.all('SELECT resident_id FROM chat_audience WHERE message_id = ? ORDER BY resident_id', msg.message_id).map((r) => r.resident_id).sort()).toEqual([asker.residentId, near.residentId].sort());
    // 历史
    const hist = chatHistory(t.w, near.residentId, null, 10).messages;
    expect(hist).toHaveLength(1);
    expect(hist[0]!.from).toEqual({ id: KEEPER, name: '茶馆掌柜', kind: 'npc' });
    expect(hist[0]!.text).toBe(out.text);
    // 视图里最近听到的话
    expect(near.view().here!.chat.map((c) => c.from)).toEqual([{ id: KEEPER, name: '茶馆掌柜', kind: 'npc' }]);
    const av = agentView(t.w, near.row(), near.clientId).here as { recent_chat: { from: string; npc?: true; text: string }[] };
    expect(av.recent_chat).toEqual([{ from: '茶馆掌柜', npc: true, text: out.text }]);
    checkInvariants(t);
  });

  it('听距外、隔墙（不同声学房间）、离线、对局中的人收不到；之后才走过来的人在历史里看不到这句', () => {
    const { t, asker, near } = scene();
    const kp = positionOfNpc(t.w, KEEPER, t.clock.t)!;
    const scn = t.w.map.scenes.get('town')!;
    const hear = t.w.map.hearDistance;
    // 隔墙：听距内但在茶馆外（室外）的一个点
    let wall: { x: number; z: number } | null = null;
    for (let dx = -hear; dx <= hear && !wall; dx += 0.5) {
      for (let dz = -hear; dz <= hear && !wall; dz += 0.5) {
        const p = { x: Math.round((kp.x + dx) * 2) / 2, z: Math.round((kp.z + dz) * 2) / 2 };
        if (isWalkable(scn, p.x, p.z) && Math.hypot(p.x - kp.x, p.z - kp.z) <= hear - 0.7 && roomOf(t.w, { scene: 'town', ...p }) !== roomOf(t.w, kp)) wall = p;
      }
    }
    expect(wall, '地图上要有一个离掌柜在听距内、却隔着墙的点').not.toBeNull();
    const farAway = t.join('远处的人'); // 刚进镇站在广场
    const behindWall = t.join('墙外的人');
    const offline = t.join('离线的人');
    const playing = t.join('对局中的人');
    for (const x of [offline, playing]) x.go(KEEPER);
    behindWall.go(wall!);
    expect(roomOf(t.w, positionOfResident(t.w, behindWall.residentId, t.clock.t)!)).not.toBe(roomOf(t.w, kp));
    expect(dist(t, behindWall, KEEPER)).toBeLessThanOrEqual(hear);
    expect(dist(t, farAway, KEEPER)).toBeGreaterThan(hear);
    offline.leave();
    // 对局中：把这位居民标成在一局里（对局的判定就是 residents.activity_id；真开一局要走到游戏馆，离掌柜太远）
    t.w.db.run("UPDATE residents SET activity_id = 'act-test' WHERE resident_id = ?", playing.residentId);
    const cursors = new Map([asker, near, farAway, behindWall, offline, playing].map((x) => [x, x.events().cursor] as const));
    // 先让该发生的事真的发生：提问人和旁边的人都收到了
    asker.act('ask_npc', { npcId: KEEPER });
    expect(npcChat(asker, cursors.get(asker)!)).toHaveLength(1);
    expect(npcChat(near, cursors.get(near)!)).toHaveLength(1);
    // 然后断言另外四位没有
    for (const x of [farAway, behindWall, offline, playing]) {
      expect(npcChat(x, cursors.get(x)!), x.name).toHaveLength(0);
      expect(chatHistory(t.w, x.residentId, null, 10).messages, x.name).toHaveLength(0);
    }
    t.w.db.run('UPDATE residents SET activity_id = NULL WHERE resident_id = ?', playing.residentId);
    // 之后才走过来的人：历史里没有这句，视图里也没有
    farAway.go(KEEPER);
    expect(chatHistory(t.w, farAway.residentId, null, 10).messages).toHaveLength(0);
    expect(farAway.view().here!.chat).toEqual([]);
    // 对照：已经听到的人历史里还在
    expect(chatHistory(t.w, near.residentId, null, 10).messages).toHaveLength(1);
  });

  it('最小间隔：间隔内第二次问，回执有 text、spoken:false、messageId:null，附近的人没有收到第二句；间隔过后恢复', () => {
    const { t, asker, near } = scene();
    const cn = near.view().cursor;
    const first = asker.act('ask_npc', { npcId: KEEPER });
    expect(first.spoken).toBe(true);
    expect(npcChat(near, cn)).toHaveLength(1);
    t.advance(t.w.params.npcSpeakCooldownMs - 500);
    const second = asker.act('ask_npc', { npcId: KEEPER, topic: 'tea' });
    expect(second).toMatchObject({ status: 'completed', spoken: false, messageId: null });
    expect(npcLineMatches(KEEPER, second.text, names(t))).toBe(true);
    expect(npcChat(near, cn)).toHaveLength(1); // 仍然只有第一句
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages WHERE sender_id = ?', KEEPER)).toBe(1);
    t.advance(1_000);
    const third = asker.act('ask_npc', { npcId: KEEPER, topic: 'tea' });
    expect(third.spoken).toBe(true);
    expect(npcChat(near, cn)).toHaveLength(2);
  });

  it('NPC 的话不叫醒任何 AI：站在旁边的 AI 居民不收到 chat 事件（话在它的受众表和 here.chat 里），没有唤醒事件、唤醒额度没有变；旁边的真人照常收到；对照：居民提到它时会有', () => {
    const t = makeTown({ params: STILL });
    const asker = t.join('阿灯');
    const ai = t.join('林小满', 'agent');
    asker.go(KEEPER);
    ai.go(KEEPER);
    const c0 = ai.events().cursor;
    const ca = asker.events().cursor;
    const bucketRows = () =>
      JSON.stringify(t.w.db.all("SELECT bucket, tokens FROM rate_buckets WHERE resident_id = ? AND (bucket LIKE 'town_wake%' OR bucket LIKE 'nearby_wake%') ORDER BY bucket", ai.residentId));
    const buckets0 = bucketRows();
    asker.act('ask_npc', { npcId: KEEPER, topic: 'hello' });
    t.advance(3_000);
    asker.act('ask_npc', { npcId: KEEPER, topic: 'tea' });
    // 先确认该发生的发生了：两句都广播了（真人提问者各收到一条事件），AI 在两句的受众里，现场视图里看得到
    expect(npcChat(asker, ca)).toHaveLength(2);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id WHERE a.resident_id = ? AND m.sender_id = ?', ai.residentId, KEEPER)).toBe(2);
    expect(ai.view().here!.chat.map((c) => c.from.kind)).toEqual(['npc', 'npc']);
    // AI 一条 chat 事件都没有：私有事件会让挂着的 world_wait 返回，NPC 的话不给 AI 发
    expect(chatEvents(ai, c0)).toHaveLength(0);
    expect(wakes(ai, c0)).toHaveLength(0);
    expect(bucketRows()).toBe(buckets0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE type = 'town_chat_mention' AND resident_id = ?", ai.residentId)).toBe(0);
    // 对照：同样的位置，居民在公屏上提到它，唤醒事件和额度记录就出现了（说明上面的断言抓得到）
    asker.act('say_town', { text: '@林小满 一起喝茶吗' });
    expect(wakes(ai, c0)).toHaveLength(1);
    expect(bucketRows()).not.toBe(buckets0);
  });

  it('NPC 不发公屏：全镇公屏里没有它的话', () => {
    const { t, asker } = scene();
    asker.act('ask_npc', { npcId: KEEPER });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(0);
  });
});

describe('掌柜卖茶', () => {
  it('走到身边买成功：钱少了、茶叶多了、库存少了、账本平衡；掌柜说一句成交台词，附近的人听得到', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    const coins = a.coins();
    const tea = a.qty('tea_leaves');
    const cb = b.view().cursor;
    const out = a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 2 });
    expect(out).toMatchObject({ status: 'completed', bought: { name: '茶叶', qty: 2, cost: 4 }, text: '买了 2 件茶叶，花了 4 枚硬币。' });
    expect(a.coins()).toBe(coins - 4);
    expect(a.qty('tea_leaves')).toBe(tea + 2);
    expect(shopsAt(t.w, 'tea_house', t.clock.t)[0]!.goods[0]!.stock).toBe(28);
    const said = npcChat(b, cb);
    expect(said).toHaveLength(1);
    const text = said[0]!.data.text as string;
    expect(NPC_LINES[`${KEEPER}/sold`]!).toContain(text);
    // 成交台词是泛化的：旁听者看不出谁买了什么
    expect(text).not.toContain(a.row().name);
    expect(text).not.toContain('茶叶');
    // NPC 不持有任何账户或物品
    expect(t.w.db.scalar("SELECT COUNT(*) FROM accounts WHERE resident_id LIKE 'npc:%'")).toBe(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM items WHERE owner_id LIKE 'npc:%' OR holder_id LIKE 'npc:%'")).toBe(0);
    checkInvariants(t);
  });

  it('站在茶馆里但离掌柜远：too_far 带 navigateTo，什么都没变；走过去再买成功；在私宅里是 not_here', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go(FAR_IN_TEA_HOUSE);
    expect(a.row().location_id).toBe('tea_house');
    expect(dist(t, a, KEEPER)).toBeGreaterThan(reachOf(t));
    const coins = a.coins();
    const e = a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' });
    expect(err(e)).toBe('precondition_failed/too_far');
    expect((e.data as { navigateTo: string }).navigateTo).toBe(KEEPER);
    expect(a.coins()).toBe(coins);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages')).toBe(0);
    a.go((e.data as { navigateTo: string }).navigateTo);
    expect(a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves' }).status).toBe('completed');
    a.go('home');
    expect(err(a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' }))).toBe('precondition_failed/not_here');
  });

  it('掌柜不在岗位上：closed，文字说明原因，什么都没变', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    a.go(KEEPER);
    // 把掌柜挪离岗位（测试直接改库来模拟「不在岗」；生产里位置只由 space.ts 写）
    t.w.db.run("UPDATE world_actors SET x = x + 8 WHERE actor_id = ?", KEEPER);
    const coins = a.coins();
    const e = a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' });
    expect(err(e)).toBe('precondition_failed/closed');
    expect(e.message).toContain('没人照看');
    expect(a.coins()).toBe(coins);
  });

  it('余额不足、卖完、数量非法沿用原有错误；失败时不说话', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    for (const qty of [0, -1, 11, 1.5, 'x']) expect(a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty }).code, `qty=${String(qty)}`).toBe('bad_request');
    expect(a.fail('buy', { shop: 'tea_counter', sku: 'nope' }).code).toBe('bad_request');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages')).toBe(0);
    // 余额不足：先花光
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 10 });
    expect(a.coins()).toBe(0);
    t.advance(3_000);
    expect(a.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' }).reason).toBe('insufficient_coins');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages WHERE sender_id = ?', KEEPER)).toBe(1); // 只有那次成交说了一句
    // 卖完：把今天的库存改成 0
    t.w.db.run("INSERT INTO shop_stock(shop_id, sku, stock, stock_date) VALUES ('tea_counter','tea_leaves',0,?) ON CONFLICT(shop_id, sku) DO UPDATE SET stock = 0, stock_date = excluded.stock_date", t.w.today(t.clock.t));
    expect(b.fail('buy', { shop: 'tea_counter', sku: 'tea_leaves' }).reason).toBe('sold_out');
    checkInvariants(t);
  });

  it('同一请求号重试：只成交一次、只说一句', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    const coins = a.coins();
    const cb = b.view().cursor;
    const r1 = a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 2 }, { requestId: 'npc-buy-req-0001' });
    const r2 = a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 2 }, { requestId: 'npc-buy-req-0001' });
    expect(r1.replayed).toBeUndefined();
    expect(r2.replayed).toBe(true);
    expect(a.coins()).toBe(coins - 4);
    expect(shopsAt(t.w, 'tea_house', t.clock.t)[0]!.goods[0]!.stock).toBe(28);
    expect(npcChat(b, cb)).toHaveLength(1);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages WHERE sender_id = ?', KEEPER)).toBe(1);
  });

  it('最小间隔内的第二笔买卖照样成交，只是掌柜不再开口', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    const cb = b.view().cursor;
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves' });
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves' });
    expect(a.qty('tea_leaves')).toBe(4);
    expect(npcChat(b, cb)).toHaveLength(1);
  });

  it('没有掌柜的店规则不变：在广场，离掌柜很远也能买小摊的饼干；书屋、厨房、花园照旧只看在不在那片区域', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    expect(a.act('buy', { shop: 'stall', sku: 'cookie' }).status).toBe('completed');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages')).toBe(0);
    expect(err(a.fail('buy', { shop: 'book_counter', sku: 'book:rain_lane' }))).toBe('precondition_failed/not_here');
    a.go('bookshop');
    expect(a.act('buy', { shop: 'book_counter', sku: 'book:rain_lane' }).status).toBe('completed');
    expect(npcDef(KEEPER)!.shop).toBe('tea_counter');
    checkInvariants(t);
  });
});

describe('闲逛者被搭话：别转身就走', () => {
  const pendingJobs = (t: Town) => t.w.db.all("SELECT due_at, payload FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", `npc_step:${STROLLER}`);
  const job = (t: Town) => {
    const rows = pendingJobs(t);
    expect(rows).toHaveLength(1); // 待办始终恰好一条
    return { due: Number(rows[0]!.due_at), payload: JSON.parse(String(rows[0]!.payload)) as { phase: string; extendedMs?: number } };
  };

  it('快要出发时被问：出发时刻被推后；它没有被钉死——连续搭话到上限后照常出发，期间待办始终恰好一条', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(STROLLER);
    b.go(STROLLER);
    const base = job(t).due;
    const hold = t.w.params.npcTalkHoldMs;
    const max = t.w.params.npcTalkHoldMaxMs;
    // 推到快要出发（还剩 2 秒）
    t.advanceAlive(base - 2_000 - t.clock.t, [a, b], 2_000);
    expect(job(t).due).toBe(base);
    a.act('ask_npc', { npcId: STROLLER });
    const first = job(t);
    expect(first.due).toBe(t.clock.t + hold);
    expect(first.due).toBeGreaterThan(base);
    expect(first.payload.extendedMs).toBe(first.due - base);
    // 持续搭话：每次都只推到「到期前 1 秒」（不越过到期），在那时问一次；两个人轮流问，避开每人的令牌桶
    let guard = 0;
    let rounds = 0;
    while ((job(t).payload.extendedMs ?? 0) < max && guard++ < 40) {
      const before = job(t);
      const wait = before.due - 1_000 - t.clock.t;
      if (wait > 0) t.advanceAlive(wait, [a, b], 1_000);
      expect(t.clock.t).toBeLessThan(before.due);
      expect(positionOfNpc(t.w, STROLLER, t.clock.t)!.moving).toBe(false); // 还没走
      (rounds++ % 2 === 0 ? a : b).act('ask_npc', { npcId: STROLLER });
      expect(job(t).due).toBeGreaterThan(before.due); // 每次都真的延长了
    }
    expect(rounds).toBeGreaterThanOrEqual(Math.floor(max / hold)); // 真的连续问到了上限
    const capped = job(t);
    expect(capped.payload.extendedMs).toBe(max);
    expect(capped.due).toBe(base + max);
    // 上限之后不再延长：到期前 1 秒再问一次，到期时间与已延长量都不变
    t.advanceAlive(capped.due - 1_000 - t.clock.t, [a, b], 1_000);
    expect(positionOfNpc(t.w, STROLLER, t.clock.t)!.moving).toBe(false);
    a.act('ask_npc', { npcId: STROLLER });
    expect(job(t)).toEqual(capped);
    const before = t.w.db.get('SELECT nav_revision FROM world_actors WHERE actor_id = ?', STROLLER)!.nav_revision as number;
    t.advanceAlive(capped.due + 1_000 - t.clock.t, [a, b], 1_000);
    expect(positionOfNpc(t.w, STROLLER, t.clock.t)!.moving).toBe(true);
    expect(t.w.db.get('SELECT nav_revision FROM world_actors WHERE actor_id = ?', STROLLER)!.nav_revision as number).toBeGreaterThan(before);
    expect(pendingJobs(t)).toHaveLength(1);
    checkInvariants(t);
  });

  it('多人轮流搭话也钉不住它：总延长量不超过上限', () => {
    const t = makeTown({ params: STILL });
    const people = [t.join('甲'), t.join('乙'), t.join('丙')];
    for (const p of people) p.go(STROLLER);
    const base = job(t).due;
    const max = t.w.params.npcTalkHoldMaxMs;
    for (let i = 0; i < 60 && t.clock.t < base + max + 30_000; i++) {
      const p = people[i % people.length]!;
      const j = job(t);
      if (positionOfNpc(t.w, STROLLER, t.clock.t)!.moving) break;
      // 在快要出发时被问
      const wait = j.due - 1_000 - t.clock.t;
      if (wait > 0) t.advanceAlive(wait, people, 1_000);
      for (const x of people) x.heartbeat();
      try {
        p.act('ask_npc', { npcId: STROLLER });
      } catch (e) {
        if (!(e instanceof WorldError)) throw e;
        t.advanceAlive(5_000, people, 1_000);
      }
      if (!positionOfNpc(t.w, STROLLER, t.clock.t)!.moving) expect(job(t).due).toBeLessThanOrEqual(base + max);
      t.advanceAlive(2_500, people, 500);
    }
    expect(positionOfNpc(t.w, STROLLER, t.clock.t)!.moving).toBe(true);
    expect(pendingJobs(t)).toHaveLength(1);
  });

  it('它正走在路上时被问到：照常回答，不停步，路线版本不变', () => {
    const t = makeTown({ params: { npcStayMinMs: 5_000, npcStayMaxMs: 5_000 } });
    const a = t.join('阿灯');
    // 等它出发，再走到它身边够得着时问
    let guard = 0;
    while (!positionOfNpc(t.w, STROLLER, t.clock.t)!.moving && guard++ < 200) t.advanceAlive(1_000, [a], 1_000);
    expect(positionOfNpc(t.w, STROLLER, t.clock.t)!.moving).toBe(true);
    const row0 = t.w.db.get('SELECT nav_revision FROM world_actors WHERE actor_id = ?', STROLLER)!;
    // 这个居民直接站到它此刻的位置旁边：用导航走过去，期间它还在走，找一个够得着的时刻
    a.act('navigate', { approach: STROLLER });
    let asked = false;
    for (let i = 0; i < 200 && !asked; i++) {
      t.advanceAlive(500, [a], 500);
      try {
        renewIfWalking(a);
        const moving = positionOfNpc(t.w, STROLLER, t.clock.t)!.moving;
        if (moving && dist(t, a, STROLLER) <= reachOf(t)) {
          const rev = t.w.db.get('SELECT nav_revision FROM world_actors WHERE actor_id = ?', STROLLER)!.nav_revision;
          const out = a.act('ask_npc', { npcId: STROLLER });
          expect(npcLineMatches(STROLLER, out.text, names(t))).toBe(true);
          expect(out.text).not.toContain('坐在'); // 走路时的台词，不是坐着的
          expect(t.w.db.get('SELECT nav_revision FROM world_actors WHERE actor_id = ?', STROLLER)!.nav_revision).toBe(rev);
          expect(positionOfNpc(t.w, STROLLER, t.clock.t)!.moving).toBe(true);
          expect(pendingJobs(t)).toHaveLength(1);
          asked = true;
        }
      } catch (e) {
        if (!(e instanceof WorldError)) throw e;
      }
    }
    void row0;
    expect(asked, '要在它走路时够得着它至少一次').toBe(true);
  });
});

function renewIfWalking(a: Actor): void {
  // 居民自己走路要续租，否则会停在租约截止处
  const nav = a.t.w.db.get('SELECT nav_json FROM world_actors WHERE actor_id = ?', a.residentId)?.nav_json;
  if (nav) a.walk();
}

describe('台词里没有玩家文字', () => {
  it('名字里带特殊字符：事件、历史、回执里的文字和模板逐字相同（只有清洗后的名字）', () => {
    const t = makeTown({ params: STILL });
    // 能通过注册的最刁钻的名字：占位符花括号、CQ 码、方向控制符、模板分隔符
    const nasty = '{name}{@灯}[CQ:at,qq=1]‮<b>';
    const a = t.join(nasty);
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    const cleaned = sanitizeName(a.row().name);
    expect(cleaned).toBe(a.row().name);
    expect(cleaned).not.toContain('‮');
    const cb = b.view().cursor;
    const out = a.act('ask_npc', { npcId: KEEPER, topic: 'hello' });
    const stock = 30;
    const expected = new Set([...NPC_LINES[`${KEEPER}/hello`]!].map((tpl) => renderNpcLine(tpl, { name: cleaned, price: 2, stock })));
    expect(expected.has(out.text), out.text).toBe(true);
    expect(npcLineMatches(KEEPER, out.text, names(t))).toBe(true);
    const evText = npcChat(b, cb)[0]!.data.text as string;
    expect(evText).toBe(out.text);
    expect(chatHistory(t.w, b.residentId, null, 5).messages[0]!.text).toBe(out.text);
    // 掌柜的成交台词同理
    t.advance(3_000);
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves' });
    const sold = t.w.db.all('SELECT body FROM chat_messages WHERE sender_id = ? ORDER BY message_id', KEEPER).map((r) => String(r.body));
    expect(sold).toHaveLength(2);
    expect(NPC_LINES[`${KEEPER}/sold`]!).toContain(sold[1]);
    // 每句话都出自模板；而一句混进了别的文字的话对不上（证明检查抓得到）
    for (const s of sold) expect(npcLineMatches(KEEPER, s, names(t))).toBe(true);
    expect(npcLineMatches(KEEPER, `${sold[0]}（别人写的话）`, names(t))).toBe(false);
  });

  it('{name} 只认真实居民的名字：对每个含 {name} 的模板，真名匹配，前面或后面混进别的文字都不匹配（与选中哪条模板无关）', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const real = names(t);
    let checked = 0;
    for (const def of NPCS) {
      for (const [key, lines] of Object.entries(NPC_LINES)) {
        if (!key.startsWith(`${def.id}/`)) continue;
        for (const tpl of lines.filter((x) => x.includes('{name}'))) {
          const vars = { period: '早上', place: '这一带', price: 2, stock: 3, places: '', events: '' };
          const ok = renderNpcLine(tpl, { ...vars, name: a.row().name });
          // places / events 在这些模板里不出现；出现的话用真实值渲染（下面单独断言过它们）
          if (/\{(places|events)\}/.test(tpl)) continue;
          expect(npcLineMatches(def.id, ok, real), ok).toBe(true);
          expect(npcLineMatches(def.id, renderNpcLine(tpl, { ...vars, name: `别人写的话${a.row().name}` }), real), tpl).toBe(false);
          expect(npcLineMatches(def.id, renderNpcLine(tpl, { ...vars, name: '路人甲' }), real), tpl).toBe(false); // 不是居民的名字
          expect(npcLineMatches(def.id, ok, []), tpl).toBe(false); // 没有居民名可认时什么都不匹配
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    // places / events 也只认程序里的固定值，不是任意文字
    const keys = Object.keys(NPC_LINES).filter((k) => k.startsWith(`${KEEPER}/town`));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const places = DESTINATIONS.filter((p) => p.kind === 'public').map((p) => p.name).join('、');
    const title = PUBLIC_EVENTS[0]!.title;
    for (const tpl of keys.flatMap((k) => NPC_LINES[k]!)) {
      const good = renderNpcLine(tpl, { places, events: title });
      expect(npcLineMatches(KEEPER, good, real), good).toBe(true);
      expect(npcLineMatches(KEEPER, renderNpcLine(tpl, { places: `${places}、别人写的地方`, events: title }), real)).toBe(false);
      if (tpl.includes('{events}')) expect(npcLineMatches(KEEPER, renderNpcLine(tpl, { places, events: `${title}、别人写的活动` }), real)).toBe(false);
    }
  });

  it('模板本身只含白名单占位符；每名 NPC 的每个话题都有台词', () => {
    for (const [key, lines] of Object.entries(NPC_LINES)) {
      expect(lines.length, key).toBeGreaterThanOrEqual(2);
      for (const tpl of lines) for (const m of tpl.matchAll(/\{(\w+)\}/g)) expect(['name', 'period', 'place', 'price', 'stock', 'places', 'events'], `${key}: ${tpl}`).toContain(m[1]);
    }
    for (const def of NPCS) {
      expect(def.topics.length).toBeGreaterThanOrEqual(2);
      for (const topic of def.topics) expect(Object.keys(NPC_LINES).some((k) => k.startsWith(`${def.id}/${topic.id}`)), `${def.id}/${topic.id}`).toBe(true);
    }
  });
});

describe('ask_npc 的请求幂等', () => {
  it('同一请求号连发两次：第二次是回放，只多一条 chat_messages、只数一次台词序号，旁边的人只收到一条 chat 事件', () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go(KEEPER);
    b.go(KEEPER);
    const cb = b.view().cursor;
    const msgs = () => Number(t.w.db.scalar('SELECT COUNT(*) FROM chat_messages WHERE sender_id = ?', KEEPER));
    const said = () => t.w.streamHead(`npcsay:${t.w.worldId}:${KEEPER}`).highWater;
    const tokens = () => JSON.stringify(t.w.db.all("SELECT * FROM rate_buckets WHERE resident_id = ?", a.residentId));
    const m0 = msgs();
    const n0 = said();
    const r1 = a.act('ask_npc', { npcId: KEEPER, topic: 'tea' }, { requestId: 'npc-ask-req-0001' });
    const afterFirst = { m: msgs(), n: said(), tok: tokens() };
    t.advance(5_000); // 过了最小间隔：若重试被当成新的一次，就会再说一句
    const r2 = a.act('ask_npc', { npcId: KEEPER, topic: 'tea' }, { requestId: 'npc-ask-req-0001' });
    expect(r1.replayed).toBeUndefined();
    expect(r2.replayed).toBe(true);
    expect(r2.text).toBe(r1.text);
    expect(afterFirst.m).toBe(m0 + 1);
    expect(afterFirst.n).toBe(n0 + 1);
    expect(msgs()).toBe(afterFirst.m);
    expect(said()).toBe(afterFirst.n);
    expect(tokens()).toBe(afterFirst.tok); // 回放不再耗令牌
    expect(npcChat(b, cb)).toHaveLength(1);
  });
});

describe('NPC 的话与 world_wait', () => {
  it('NPC 在旁边说话不让卡在 world_wait 的 AI 居民返回（话在它的 here.chat 里）；真人听众的等待照常返回；对照：真人说一句附近聊天，AI 的等待就返回', async () => {
    const t = makeTown({ params: STILL });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('阿树');
    a.go(KEEPER);
    b.go(KEEPER);
    c.go(KEEPER);
    const cb = b.view().cursor;
    const cc = c.view().cursor;
    const waitingB = t.w.waitResident(b.residentId, cb, undefined, 300);
    const waitingC = t.w.waitResident(c.residentId, cc, undefined, 20_000);
    const out = a.act('ask_npc', { npcId: KEEPER });
    // 先证明 NPC 真的开口了：真人旁听者的等待返回，并且收到这一句
    expect(await waitingC).toBe('event');
    expect(npcChat(c, cc)).toHaveLength(1);
    // AI 的等待没有被它叫醒，也没有任何 chat 事件；话在现场视图里
    expect(await waitingB).toBe('timeout');
    expect(chatEvents(b, cb)).toHaveLength(0);
    expect(wakes(b, cb)).toHaveLength(0);
    expect(b.view().here!.chat.map((x) => x.text)).toEqual([out.text]);
    // 对照：同一个位置，真人说一句附近聊天，AI 的等待就返回（上面等不到不是等待本身坏了）
    const waitingB2 = t.w.waitResident(b.residentId, cb, undefined, 20_000);
    a.act('say_nearby', { text: '掌柜的茶不错' });
    expect(await waitingB2).toBe('event');
    expect(chatEvents(b, cb)).toHaveLength(1);
  });
});
