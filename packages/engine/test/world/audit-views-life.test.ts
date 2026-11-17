/**
 * 审计修复回归：views.ts / life.ts
 * 第 19 条 history 的 limit 小数；第 20 条 messageId 不泄露全局计数；
 * 第 32 条现场聊天查询有下界；第 34 条住宅街 doors 只列够用的门。
 */
import { describe, expect, it } from 'vitest';
import { chatHistory } from '../../src/world/views.js';
import { makeTown, type Actor, type Town } from './helpers.js';


const chatIds = (a: Actor) => (a.view().here?.chat ?? []).map((c) => c.messageId);
const chatEventIds = (a: Actor): number[] =>
  a.t.w.db
    .all("SELECT projection FROM recipient_events WHERE resident_id = ? AND type = 'chat' ORDER BY cursor", a.residentId)
    .map((e) => Number(JSON.parse(String(e.projection)).messageId));

/** 往前走一段时间，期间所有人保持心跳。 */
function stay(t: Town, ms: number, who: Actor[]): void {
  for (let left = ms; left > 0; left -= 30_000) {
    t.advance(Math.min(30_000, left));
    for (const x of who) x.heartbeat();
  }
}

function seatTwo(t: Town) {
  const a = t.join('阿灯');
  const b = t.join('小岚', 'agent');
  return { a, b };
}

describe('审计 19：history 的 limit 可以是小数', () => {
  it('limit=2.5 / NaN 不抛错，按取整后的条数返回', () => {
    const t = makeTown();
    const { a } = seatTwo(t);
    for (let i = 0; i < 4; i++) {
      a.act('speak', { text: `第${i}句` });
      t.advance(10_000);
    }
    expect(chatHistory(t.w, a.residentId, null, 2.5).messages).toHaveLength(2);
    expect(chatHistory(t.w, a.residentId, null, Number.NaN).messages).toHaveLength(4);
    expect(chatHistory(t.w, a.residentId, null, 0.2).messages).toHaveLength(1);
  });
});

describe('审计 20：messageId 是每位居民自己连续的序号', () => {
  it('别处的发言不会在我听到的编号里留下空档（视图、事件、历史一致）', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('小满');
    // 小满先走开，到另一处，之后在那里说话时 a、b 听不到
    c.go('bookshop');
    const all = [a, b, c];
    b.act('speak', { text: '一' });
    for (const w of ['书屋里的话1', '书屋里的话2', '书屋里的话3']) {
      stay(t, 10_000, all);
      c.act('speak', { text: w });
    }
    stay(t, 10_000, all);
    a.act('speak', { text: '二' });
    expect(chatIds(b)).toEqual([1, 2]);
    expect(chatIds(a)).toEqual([1, 2]);
    // AI 发言者不收自己那句的回显（一，编号 1），只收别人说的（二，编号 2）
    expect(chatEventIds(b)).toEqual([2]);
    const h = chatHistory(t.w, b.residentId, null, 10).messages;
    expect(h.map((m) => m.messageId)).toEqual([2, 1]);
  });

  it('before / next 翻页用新编号仍然完整无重复', () => {
    const t = makeTown();
    const { a } = seatTwo(t);
    const c = t.join('小满');
    c.go('bookshop');
    for (let i = 1; i <= 5; i++) {
      a.act('speak', { text: `第${i}句` });
      c.act('speak', { text: `别处${i}` });
      t.advance(10_000);
    }
    const p1 = chatHistory(t.w, a.residentId, null, 2);
    expect(p1.messages.map((m) => m.text)).toEqual(['第5句', '第4句']);
    expect(p1.messages.map((m) => m.messageId)).toEqual([5, 4]);
    const p2 = chatHistory(t.w, a.residentId, p1.next, 2);
    expect(p2.messages.map((m) => m.text)).toEqual(['第3句', '第2句']);
    const p3 = chatHistory(t.w, a.residentId, p2.next, 2);
    expect(p3.messages.map((m) => m.text)).toEqual(['第1句']);
    expect(p3.next).toBeNull();
  });

  it('清理旧消息后，剩下的消息编号不变', () => {
    const t = makeTown();
    const { a, b } = seatTwo(t);
    a.act('speak', { text: '旧' });
    t.advance(10_000);
    b.act('speak', { text: '新' });
    const before = chatHistory(t.w, a.residentId, null, 10).messages.map((m) => m.messageId);
    // 删掉最旧一条（模拟过期清理）
    t.w.db.run('DELETE FROM chat_audience WHERE message_id = (SELECT MIN(message_id) FROM chat_messages)');
    const after = chatHistory(t.w, a.residentId, null, 10).messages.map((m) => m.messageId);
    expect(before).toEqual([2, 1]);
    expect(after).toEqual([2]);
  });
});

describe('审计 32：现场聊天查询带下界', () => {
  it('查询计划里受众表是带 message_id 下界的主键范围扫描，结果仍是窗口内最近 20 条', () => {
    const t = makeTown();
    const { a, b } = seatTwo(t);
    for (let i = 1; i <= 25; i++) {
      (i % 2 ? a : b).act('speak', { text: `话${i}` });
      stay(t, 10_000, [a, b]);
    }
    const chat = a.view().here!.chat;
    expect(chat).toHaveLength(20);
    expect(chat[chat.length - 1]!.text).toBe('话25');
    // 30 分钟之后窗口里没有消息
    stay(t, 31 * 60_000, [a, b]);
    expect(a.view().here!.chat).toEqual([]);
    const plan = t.w.db
      .all(
        `EXPLAIN QUERY PLAN SELECT m.message_id FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id
         WHERE a.resident_id = ? AND a.message_id >= (SELECT COALESCE(MIN(message_id), 9223372036854775807) FROM chat_messages WHERE sent_at > ?)
         ORDER BY a.message_id DESC LIMIT 20`,
        a.residentId,
        0,
      )
      .map((r) => String(r.detail))
      .join('\n');
    expect(plan).toMatch(/message_id>\?/);
  });
});

describe('审计 34：会馆门前的 doors 不遍历全部注册居民', () => {
  it('只列自己家、有效邀请的家、此刻在场的邻居的家；不表达谁在不在家；邀请的家不在场也列出', () => {
    const t = makeTown();
    const people: Actor[] = [];
    for (let i = 0; i < 8; i++) people.push(t.join(`居民${i}`, i % 2 ? 'agent' : 'human'));
    const a = people[0]!;
    const others = people.filter((p) => p !== a);
    a.go('residential');
    expect(a.row().location_id).toBe('residential');
    const doors = () => (a.view().here!.doors ?? []).map((d) => d.owner.name).sort();
    const off = others[0]!;
    off.leave();
    // 门牌是公开地址：在场的人都有门（不管此刻在屋里、广场还是别处），不在场、也没邀请我的人没有
    expect(doors()).toEqual([a.name, ...others.filter((p) => p !== off).map((p) => p.name)].sort());
    // 门牌不表达在不在家：让一位邻居进自己家、另一位留在广场，门牌条目的形状完全一样
    const inHome = others[1]!;
    inHome.go('home');
    expect(inHome.row().location_id).toBe(`home:${inHome.residentId}`);
    const shapes = (a.view().here!.doors ?? []).filter((d) => d.owner.id !== a.residentId).map((d) => Object.keys(d).sort().join(','));
    expect(new Set(shapes).size).toBe(1);
    // 他回来当面邀请我之后离开：不在场，但我手上有他的有效邀请，所以他的门出现且可进
    off.enter();
    off.go('residential');
    off.act('invite', { to: a.residentId });
    off.go('plaza');
    off.leave();
    const d = a.view().here!.doors!.find((x) => x.owner.name === off.name);
    expect(d?.canEnter).toBe(true);
    // 注册居民很多时，门数不随注册总数增长（上限 60）
    expect(a.view().here!.doors!.length).toBeLessThanOrEqual(60);
  });
});
