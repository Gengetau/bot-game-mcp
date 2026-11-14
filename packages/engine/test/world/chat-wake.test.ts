/**
 * 附近聊天的叫醒额度与补叫：AI 说、AI 听时，一句话要不要当场叫醒听者（chat 事件）由两个令牌桶决定；
 * 不够就压下来（话照样进受众表和 here.chat），额度恢复后补叫一次。真人听者、真人发言者不受限制。
 * 时间全用假时钟；到期任务靠 t.advance / t.advanceTo 触发。
 */
import { describe, expect, it } from 'vitest';
import { TOWN_GUIDE } from '../../src/mcp/town.js';
import { AGENT_RECENT_CHAT, agentView, chatHistory, meView } from '../../src/world/views.js';
import { Actor, KEEPER, makeTown, tempDb, type Town } from './helpers.js';

const HOUR = 3600_000;
const MIN = 60_000;
/** 说话本身不被每分钟额度挡住（这里关心的是叫醒额度） */
const LOOSE = { chatPerMinute: 600, chatBurst: 100 };
const PX = 22.25;
const PZ = 27.25;

function stand(a: Actor, x: number, z: number): void {
  a.go({ x, z });
  const p = a.pos();
  expect(Math.hypot(p.x - x, p.z - z), `${a.name} 没有站在 (${x}, ${z})`).toBeLessThan(0.01);
}

interface Cast {
  t: Town;
  all: Actor[];
}

/** 一群人站在广场上互相听得到的地方（相距 0.5 米一个）。 */
function cast(kinds: ('human' | 'agent')[], params: Record<string, unknown> = {}, t: Town = makeTown({ params: { ...LOOSE, ...params } })): Cast & { people: Actor[] } {
  const people = kinds.map((k, i) => t.join(`${k === 'agent' ? 'AI' : '真人'}${i}`, k));
  people.forEach((p, i) => stand(p, PX + i * 0.5, PZ));
  people.forEach((p) => p.heartbeat());
  return { t, all: people, people };
}

interface ChatEv {
  cursor: number;
  at: number;
  scope: string;
  space: string;
  from: { id: string; name: string; kind: string };
  text: string;
  messageId: number;
}
const chatEvents = (t: Town, a: Actor): ChatEv[] =>
  t.w.db
    .all("SELECT cursor, occurred_at, projection FROM recipient_events WHERE resident_id = ? AND type = 'chat' ORDER BY cursor", a.residentId)
    .map((r) => ({ cursor: Number(r.cursor), at: Number(r.occurred_at), ...(JSON.parse(String(r.projection)) as Omit<ChatEv, 'cursor' | 'at'>) }));
const texts = (t: Town, a: Actor) => chatEvents(t, a).map((e) => e.text);
const heard = (t: Town, a: Actor): string[] => chatHistory(t.w, a.residentId, null, 100).messages.map((m) => m.text);
const wakeJobs = (t: Town, status?: string) =>
  t.w.db.all(`SELECT dedupe_key, due_at, status FROM scheduled_jobs WHERE kind = 'nearby_wake'${status ? ` AND status = '${status}'` : ''}`);
const pending = (t: Town) => wakeJobs(t, 'pending');
const pendingFor = (t: Town, a: Actor) => pending(t).filter((j) => j.dedupe_key === `nearby_wake:${a.residentId}`);
const hereChat = (t: Town, a: Actor): string[] => (meView(t.w, a.row(), a.clientId).here?.chat ?? []).map((c) => c.text);
const bucket = (t: Town, a: Actor, name: string): number | null => {
  const r = t.w.db.get('SELECT tokens FROM rate_buckets WHERE resident_id = ? AND bucket = ?', a.residentId, name);
  return r ? Number(r.tokens) : null;
};

/** 推进到某个时刻（每步最多 20 秒，期间 people 保持在场），到点那一步会跑到期任务。 */
function advanceTo(t: Town, at: number, people: Actor[]): void {
  while (t.clock.t < at) {
    for (const p of people) p.heartbeat();
    t.advance(Math.min(20_000, at - t.clock.t));
  }
  for (const p of people) p.heartbeat();
}
const say = (a: Actor, text: string) => a.act('say_nearby', { text });
const strip = (r: Record<string, any>) => {
  // 回执里每句不同的只有序号、请求号；游标是不透明字符串，只比较它的前缀（流里的位置），后半段每个世界各异
  const { messageId: _m, requestId: _q, cursor, ...rest } = r;
  return { ...rest, cursor: String(cursor).split('.')[0] };
};

describe('附近聊天的叫醒额度', () => {
  it('1. AI 对 AI 当场：前 nearbyWakePairBurst 句都有事件；下一句没有，但受众表和 here.chat 里有；回执只有 messageId 不同', () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    expect(t.w.params.nearbyWakePairBurst).toBe(5);
    const receipts: Record<string, any>[] = [];
    for (let i = 1; i <= 5; i++) {
      receipts.push(say(a, `第${i}句`));
      expect(texts(t, b), `第 ${i} 句应当场叫醒`).toHaveLength(i);
    }
    receipts.push(say(a, '第6句'));
    expect(texts(t, b)).toEqual(['第1句', '第2句', '第3句', '第4句', '第5句']); // 第 6 句被压下
    expect(heard(t, b)).toContain('第6句'); // 受众表里有
    expect(hereChat(t, b)).toContain('第6句'); // 视图里有
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_audience WHERE resident_id = ?', b.residentId)).toBe(6);
    for (const r of receipts) expect(strip(r)).toEqual(strip(receipts[0]!));
    expect(receipts.map((r) => r.messageId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(receipts[5]).toMatchObject({ status: 'completed', scope: 'nearby', heardBy: 1 });
  });

  it('2. 补叫：到期之前没有事件；到期恰好多一条，内容是被压下的最新一句、形状和当场发的一样；之后不再有，也没有残留任务', () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    for (let i = 1; i <= 5; i++) say(a, `第${i}句`);
    say(a, '第6句');
    say(a, '第7句');
    expect(texts(t, b)).toHaveLength(5);
    const jobs = pending(t);
    expect(jobs).toHaveLength(1); // 每位听者最多一条待办
    expect(jobs[0]!.dedupe_key).toBe(`nearby_wake:${b.residentId}`);
    const due = Number(jobs[0]!.due_at);
    // 成对桶 5 个用光，每小时恢复 20 个：3 分钟一个
    expect(due - t.clock.t).toBeGreaterThan(2 * MIN);
    expect(due - t.clock.t).toBeLessThanOrEqual(3 * MIN + 1);
    advanceTo(t, due - 1, [a, b]);
    expect(texts(t, b)).toHaveLength(5);
    expect(pending(t)).toHaveLength(1);
    advanceTo(t, due, [a, b]);
    const evs = chatEvents(t, b);
    expect(evs).toHaveLength(6);
    const live = evs[0]!;
    const late = evs[5]!;
    expect(late.text).toBe('第7句'); // 压下的最新一句
    expect(Object.keys(late).sort()).toEqual(Object.keys(live).sort());
    expect(late).toMatchObject({ scope: 'nearby', space: live.space, from: live.from, messageId: 7 });
    expect(pending(t)).toHaveLength(0);
    // 没有新话：再过一天也没有新事件，没有残留的待办
    advanceTo(t, t.clock.t + 24 * HOUR, [a, b]);
    expect(texts(t, b)).toHaveLength(6);
    expect(wakeJobs(t, 'pending')).toHaveLength(0);
  });

  it('3a. 补叫被取消：真人在旁边说一句，听者当场收到事件，到原定时刻不再多出事件', () => {
    const { t, people } = cast(['agent', 'agent', 'human']);
    const [a, b, h] = people as [Actor, Actor, Actor];
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
    expect(pending(t)).toHaveLength(1);
    const due = Number(pending(t)[0]!.due_at);
    say(h, '真人来了');
    expect(texts(t, b)).toEqual(['第1句', '第2句', '第3句', '第4句', '第5句', '真人来了']);
    expect(pending(t)).toHaveLength(0);
    advanceTo(t, due + 1000, [a, b, h]);
    expect(texts(t, b)).toHaveLength(6);
  });

  it('3b. 补叫被取消：另一位额度够的 AI 说一句，听者当场收到，到原定时刻不再多出事件', () => {
    const { t, people } = cast(['agent', 'agent', 'agent']);
    const [a, b, c] = people as [Actor, Actor, Actor];
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
    const due = Number(pendingFor(t, b)[0]!.due_at);
    say(c, '另一位的话');
    expect(texts(t, b)).toHaveLength(6);
    expect(texts(t, b)[5]).toBe('另一位的话');
    expect(pendingFor(t, b)).toHaveLength(0); // c 自己也被压下过 a 的话，它的补叫不受影响
    advanceTo(t, due + 1000, [a, b, c]);
    expect(texts(t, b)).toHaveLength(6);
  });

  it('4a. 两个桶一起扣：成对桶不够时总桶不动；紧接着换一位发言者说，仍然当场叫得醒', () => {
    const { t, people } = cast(['agent', 'agent', 'agent']);
    const [a, b, c] = people as [Actor, Actor, Actor];
    for (let i = 1; i <= 5; i++) say(a, `a${i}`);
    expect(bucket(t, b, 'nearby_wake')).toBeCloseTo(5, 5);
    say(a, 'a6'); // 成对桶空了：被压下
    expect(texts(t, b)).toHaveLength(5);
    expect(bucket(t, b, 'nearby_wake')).toBeCloseTo(5, 5); // 总桶没有被多扣
    expect(bucket(t, b, `nearby_wake_from:${a.residentId}`)).toBeCloseTo(0, 5);
    say(c, 'c1');
    expect(texts(t, b)).toHaveLength(6);
    expect(bucket(t, b, 'nearby_wake')).toBeCloseTo(4, 5);
  });

  it('4b. 两个桶一起扣：总桶不够时成对桶不动；总桶恢复后这位发言者的下一句当场叫得醒', () => {
    const { t, people } = cast(['agent', 'agent'], { nearbyWakeBurst: 2 });
    const [a, b] = people as [Actor, Actor];
    say(a, 'a1');
    say(a, 'a2');
    expect(bucket(t, b, `nearby_wake_from:${a.residentId}`)).toBeCloseTo(3, 5);
    say(a, 'a3'); // 总桶空了：被压下，成对桶不动
    expect(texts(t, b)).toEqual(['a1', 'a2']);
    expect(bucket(t, b, `nearby_wake_from:${a.residentId}`)).toBeCloseTo(3, 5);
    // 总桶每小时恢复 30 个：2 分钟一个。补叫在那一刻发出 a3，之后总桶又空
    const due = Number(pending(t)[0]!.due_at);
    advanceTo(t, due, [a, b]);
    expect(texts(t, b)).toEqual(['a1', 'a2', 'a3']);
    expect(bucket(t, b, `nearby_wake_from:${a.residentId}`)).toBeLessThan(3); // 补叫扣了成对桶
    advanceTo(t, t.clock.t + 2 * MIN + 1, [a, b]);
    say(a, 'a4');
    expect(texts(t, b)).toEqual(['a1', 'a2', 'a3', 'a4']); // 当场
    expect(pending(t)).toHaveLength(0);
  });

  it('5. 总额度：多位 AI 发言者各自没超过成对额度，听者当场收到的最多 nearbyWakeBurst 条', () => {
    const { t, people } = cast(['agent', 'agent', 'agent', 'agent', 'agent']);
    const [b, ...speakers] = people as Actor[];
    expect(speakers).toHaveLength(4);
    for (const s of speakers) for (let i = 1; i <= 5; i++) say(s, `${s.name}-${i}`);
    expect(t.w.params.nearbyWakeBurst).toBe(10);
    expect(texts(t, b!)).toHaveLength(10);
    // 第 11 条起都在受众表里，只是没有当场事件
    expect(heard(t, b!)).toHaveLength(20);
    expect(pendingFor(t, b!)).toHaveLength(1);
  });

  it('6. 听者是真人：说到远超额度，每一句都有事件，没有任何补叫任务', () => {
    const { t, people } = cast(['agent', 'human']);
    const [a, h] = people as [Actor, Actor];
    for (let i = 1; i <= 40; i++) say(a, `第${i}句`);
    expect(texts(t, h)).toHaveLength(40);
    expect(wakeJobs(t)).toHaveLength(0);
    expect(bucket(t, h, 'nearby_wake')).toBeNull();
  });

  it('7. 发言者是真人、听者是 AI：每一句都有事件，不消耗额度；之后换 AI 来说，头几句照样当场叫得醒', () => {
    const { t, people } = cast(['human', 'agent', 'agent']);
    const [h, b, a] = people as [Actor, Actor, Actor];
    for (let i = 1; i <= 30; i++) say(h, `真人${i}`);
    expect(texts(t, b)).toHaveLength(30);
    expect(wakeJobs(t)).toHaveLength(0);
    expect(bucket(t, b, 'nearby_wake')).toBeNull();
    for (let i = 1; i <= 5; i++) say(a, `AI${i}`);
    expect(texts(t, b)).toHaveLength(35);
    expect(bucket(t, b, 'nearby_wake')).toBeCloseTo(5, 5);
  });

  it('8. 等待：额度内的一句叫醒 world_wait（先证明）；被压下的一句不叫醒；补叫到期时叫醒', async () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    const waitOn = (ms: number) => t.w.waitResident(b.residentId, b.events().cursor, undefined, ms);
    const w1 = waitOn(2000);
    say(a, '第1句');
    expect(await w1).toBe('event');
    for (let i = 2; i <= 5; i++) say(a, `第${i}句`);
    const w2 = waitOn(150);
    say(a, '第6句'); // 压下
    expect(await w2).toBe('timeout');
    const due = Number(pending(t)[0]!.due_at);
    const w3 = waitOn(5000);
    advanceTo(t, due, [a, b]);
    expect(await w3).toBe('event');
    expect(texts(t, b)[5]).toBe('第6句');
  });

  it('9a. 到期时听者已经离线：不发事件，任务结束，不重排', () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
    const due = Number(pending(t)[0]!.due_at);
    b.leave();
    advanceTo(t, due + 1000, [a]);
    expect(texts(t, b)).toHaveLength(5);
    expect(pending(t)).toHaveLength(0);
    expect(wakeJobs(t, 'done')).toHaveLength(1);
    advanceTo(t, due + HOUR, [a]);
    expect(wakeJobs(t, 'pending')).toHaveLength(0);
  });

  it('9b. 到期时听者已经进了一局小游戏：不发事件，任务结束，不重排', () => {
    const { t, people } = cast(['agent', 'agent', 'agent']);
    const [a, b, c] = people as [Actor, Actor, Actor];
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
    const due = Number(pending(t)[0]!.due_at);
    // b 和 c 去游戏馆凑一桌开局
    for (const x of [b, c]) x.go('arcade:table1');
    const p = b.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    c.act('join_game', { activityId: p.activity.id });
    b.act('start_game', { activityId: p.activity.id });
    expect(b.row().activity_id).not.toBeNull();
    expect(t.clock.t).toBeLessThan(due);
    // 全程给三个人心跳：b 一直在场，唯一让补叫结束的原因只能是「在对局里」
    advanceTo(t, due + 1000, [a, b, c]);
    expect(b.row().present_since).not.toBeNull();
    expect(b.row().activity_id).not.toBeNull();
    expect(wakeJobs(t, 'done').filter((j) => j.dedupe_key === `nearby_wake:${b.residentId}`)).toHaveLength(1);
    expect(texts(t, b)).toHaveLength(5);
    expect(pending(t)).toHaveLength(0);
  });

  it('9c. 到期时听者已经被请出那间私宅：屋里的话不再叫醒它，任务结束，不重排', () => {
    const t = makeTown({ params: LOOSE });
    const host = t.join('屋主', 'agent');
    const guest = t.join('客人', 'agent');
    host.act('invite', { to: guest.residentId });
    host.go('home');
    guest.go(`home:${host.residentId}`);
    host.heartbeat();
    guest.heartbeat();
    for (let i = 1; i <= 6; i++) say(host, `屋里第${i}句`);
    expect(texts(t, guest)).toHaveLength(5);
    expect(hereChat(t, guest)).toContain('屋里第6句');
    const due = Number(pending(t)[0]!.due_at);
    guest.go('plaza'); // 出门（被请出门同理：不在那间屋里了）
    expect(hereChat(t, guest)).not.toContain('屋里第6句');
    advanceTo(t, due + 1000, [host, guest]);
    expect(texts(t, guest)).toHaveLength(5);
    expect(pending(t)).toHaveLength(0);
  });

  it('10a. 上限：一位 AI 以最快速度对另一位 AI 连说，任意一小时里听者收到不超过 nearbyWakePairBurst + nearbyWakePairPerHour，并且补叫确实发生过', () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    const sentAt = new Map<string, number>();
    for (let i = 0; i < 3 * HOUR / 5000; i++) {
      const text = `m${i}`;
      sentAt.set(text, t.clock.t);
      say(a, text);
      advanceTo(t, t.clock.t + 5000, [a, b]);
    }
    const evs = chatEvents(t, b);
    const cap = t.w.params.nearbyWakePairBurst + t.w.params.nearbyWakePairPerHour;
    for (const e of evs) {
      const inWindow = evs.filter((x) => x.at >= e.at && x.at < e.at + HOUR).length;
      expect(inWindow, `从 ${e.at} 起一小时内`).toBeLessThanOrEqual(cap);
    }
    expect(evs.length).toBeGreaterThan(t.w.params.nearbyWakePairBurst + 20);
    // 补叫：事件发出的时刻晚于那句话说出的时刻
    const late = evs.filter((e) => e.at > sentAt.get(e.text)!);
    expect(late.length).toBeGreaterThan(10);
  });

  it('10b. 上限：好几位 AI 轮流说，总数不超过 nearbyWakeBurst + nearbyWakePerHour，同一位发言者不超过成对上限', () => {
    const { t, people } = cast(['agent', 'agent', 'agent', 'agent']);
    const [b, ...speakers] = people as Actor[];
    for (let i = 0; i < (3 * HOUR) / 2000; i++) {
      say(speakers[i % 3]!, `m${i}`);
      advanceTo(t, t.clock.t + 2000, people);
    }
    const evs = chatEvents(t, b!);
    const total = t.w.params.nearbyWakeBurst + t.w.params.nearbyWakePerHour;
    const pair = t.w.params.nearbyWakePairBurst + t.w.params.nearbyWakePairPerHour;
    for (const e of evs) {
      const win = evs.filter((x) => x.at >= e.at && x.at < e.at + HOUR);
      expect(win.length).toBeLessThanOrEqual(total);
      expect(win.filter((x) => x.from.id === e.from.id).length).toBeLessThanOrEqual(pair);
    }
    expect(evs.length).toBeGreaterThan(t.w.params.nearbyWakeBurst);
    expect(wakeJobs(t, 'done').length + pending(t).length).toBeGreaterThan(0);
  });
});

describe('补叫的其它性质', () => {
  it('11. 不泄露：发言者收不到和额度、补叫有关的事件；听者额度够和不够两种情况下，发言者的回执、事件和公开事件流相同', () => {
    const run = (drained: boolean) => {
      const { t, people } = cast(['agent', 'agent'], {}, makeTown({ params: LOOSE, seed: 'leak' }));
      const [a, b] = people as [Actor, Actor];
      if (drained) {
        t.w.db.run("INSERT INTO rate_buckets(resident_id, bucket, tokens, updated_at) VALUES (?, 'nearby_wake', 0, ?)", b.residentId, t.clock.t);
      }
      const receipts = [say(a, '你好'), say(a, '在吗')].map(strip);
      const mine = t.w.db.all('SELECT type FROM recipient_events WHERE resident_id = ? ORDER BY cursor', a.residentId).map((r) => String(r.type));
      const pub = t.w.db.all('SELECT type, projection FROM public_events ORDER BY cursor').map((r) => `${r.type}:${r.projection}`);
      return { receipts, mine, pub, bGot: texts(t, b).length, jobs: pending(t).length };
    };
    const ok = run(false);
    const drained = run(true);
    // 先证明两种情况确实不同：额度够的当场收到，额度不够的被压下并排了补叫
    expect(ok.bGot).toBe(2);
    expect(ok.jobs).toBe(0);
    expect(drained.bGot).toBe(0);
    expect(drained.jobs).toBe(1);
    // 发言者这一侧完全一样
    expect(drained.receipts).toEqual(ok.receipts);
    expect(drained.mine).toEqual(ok.mine);
    expect(drained.pub).toEqual(ok.pub);
    for (const ty of drained.mine) expect(ty).not.toMatch(/wake|nearby|quota/i);
  });

  it('12. 发言者自己的回显：AI 发言者挂着 world_wait 不会被自己的话叫醒；真人发言者照旧收到自己那一条', async () => {
    const { t, people } = cast(['agent', 'human', 'agent']);
    const [a, h, other] = people as [Actor, Actor, Actor];
    const waitFor = (x: Actor, ms: number) => t.w.waitResident(x.residentId, x.events().cursor, undefined, ms);
    // 先证明 world_wait 会被事件叫醒：别人的话叫醒 AI
    const w0 = waitFor(a, 2000);
    say(other, '别人的话');
    expect(await w0).toBe('event');
    // 自己的话不叫醒自己
    const w1 = waitFor(a, 150);
    say(a, '自己的话');
    expect(await w1).toBe('timeout');
    expect(texts(t, a)).toEqual(['别人的话']); // 没有自己那句
    // 受众表和视图里照样有；回执有 messageId
    expect(heard(t, a)).toContain('自己的话');
    expect(hereChat(t, a)).toContain('自己的话');
    // 真人发言者：网页靠回显显示自己的话
    say(h, '真人自己的话');
    expect(texts(t, h)).toContain('真人自己的话');
    // 回显不走额度：a 对自己没有任何桶
    expect(bucket(t, a, `nearby_wake_from:${a.residentId}`)).toBeNull();
  });

  it('14. 交谈事实：话被压下的听者后来醒来并回话，「有来有往」的事实照样形成', () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    const convs = () => Number(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'conversation'"));
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
    const before = convs();
    advanceTo(t, Number(pending(t)[0]!.due_at), [a, b]); // 补叫：b 醒来
    expect(texts(t, b)).toHaveLength(6);
    say(b, '我听到了，回你');
    expect(convs()).toBeGreaterThan(before);
  });

  it('13. 参数：四个新参数能经 town.params 覆盖，越界被拒', () => {
    const t = makeTown({ params: { nearbyWakeBurst: 3, nearbyWakePerHour: 7, nearbyWakePairBurst: 2, nearbyWakePairPerHour: 4 } });
    expect(t.w.params).toMatchObject({ nearbyWakeBurst: 3, nearbyWakePerHour: 7, nearbyWakePairBurst: 2, nearbyWakePairPerHour: 4 });
    for (const bad of [{ nearbyWakeBurst: 0 }, { nearbyWakeBurst: 101 }, { nearbyWakePerHour: 0 }, { nearbyWakePerHour: 1001 }, { nearbyWakePairBurst: 0 }, { nearbyWakePairBurst: 101 }, { nearbyWakePairPerHour: 0 }, { nearbyWakePairPerHour: 1001 }]) {
      expect(() => makeTown({ params: bad }), JSON.stringify(bad)).toThrow();
    }
    // 默认值
    const d = makeTown();
    expect(d.w.params).toMatchObject({ nearbyWakeBurst: 10, nearbyWakePerHour: 30, nearbyWakePairBurst: 5, nearbyWakePairPerHour: 20 });
  });

  it('15. 重启：额度用掉一部分、有补叫待办时重开世界：额度没有回满，补叫到期后恰好发出一次', () => {
    const db = tempDb();
    try {
      const t = makeTown({ params: LOOSE, dbPath: db.path });
      const a = t.join('AI0', 'agent');
      const b = t.join('AI1', 'agent');
      stand(a, PX, PZ);
      stand(b, PX + 0.5, PZ);
      for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
      const due = Number(pending(t)[0]!.due_at);
      const tokensBefore = bucket(t, b, 'nearby_wake');
      expect(tokensBefore).toBeCloseTo(5, 5);
      t.restart();
      expect(bucket(t, b, 'nearby_wake')).toBeCloseTo(5, 5); // 没有回满
      expect(pending(t)).toHaveLength(1);
      expect(Number(pending(t)[0]!.due_at)).toBe(due);
      b.enter();
      a.enter();
      advanceTo(t, due - 1, [a, b]);
      expect(texts(t, b)).toHaveLength(5);
      advanceTo(t, due, [a, b]);
      expect(texts(t, b)).toHaveLength(6);
      advanceTo(t, due + HOUR, [a, b]);
      expect(texts(t, b)).toHaveLength(6); // 恰好一次
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('16. 浮点边界：取几组不整除的参数，补叫到期那一刻一次就发出，任务没有被重排', () => {
    const sets = [
      { nearbyWakePairBurst: 1, nearbyWakePairPerHour: 7, nearbyWakeBurst: 3, nearbyWakePerHour: 11 },
      { nearbyWakePairBurst: 2, nearbyWakePairPerHour: 13, nearbyWakeBurst: 1, nearbyWakePerHour: 17 },
      { nearbyWakePairBurst: 3, nearbyWakePairPerHour: 29, nearbyWakeBurst: 100, nearbyWakePerHour: 1000 },
      { nearbyWakePairBurst: 1, nearbyWakePairPerHour: 20, nearbyWakeBurst: 1, nearbyWakePerHour: 7 },
    ];
    for (const p of sets) {
      const { t, people } = cast(['agent', 'agent'], p);
      const [a, b] = people as [Actor, Actor];
      // 把时间错开到不整齐的毫秒上，再连说到压下
      t.advance(137);
      a.heartbeat();
      b.heartbeat();
      for (let i = 1; i <= 8; i++) {
        say(a, `第${i}句`);
        advanceTo(t, t.clock.t + 333, [a, b]);
      }
      expect(pending(t), JSON.stringify(p)).toHaveLength(1);
      for (let round = 0; round < 3 && pending(t).length; round++) {
        const job = t.w.db.get("SELECT job_id, due_at FROM scheduled_jobs WHERE kind = 'nearby_wake' AND status = 'pending'")!;
        const due = Number(job.due_at);
        const n = texts(t, b).length;
        advanceTo(t, due, [a, b]);
        expect(texts(t, b).length, `${JSON.stringify(p)} 第 ${round} 轮到点应一次发出`).toBe(n + 1);
        // 没有被重排：旧任务变成 done，或者（还有新压下的话时）同一键的新到期时刻晚于现在，而不是停在原时刻
        const after = t.w.db.get("SELECT due_at, status FROM scheduled_jobs WHERE job_id = ?", Number(job.job_id))!;
        if (after.status === 'pending') expect(Number(after.due_at)).toBeGreaterThan(due);
      }
    }
  });
});

describe('NPC 的台词与叫醒额度', () => {
  /** 掌柜身边：一位 AI 发言者、一位 AI 听者、一位真人。闲逛者一直停着，不来添乱。 */
  function atKeeper(params: Record<string, unknown> = {}) {
    const t = makeTown({ params: { ...LOOSE, npcStayMinMs: 600_000, npcStayMaxMs: 600_000, ...params } });
    const a = t.join('AI甲', 'agent');
    const l = t.join('AI乙', 'agent');
    const h = t.join('真人丙');
    for (const p of [a, l, h]) p.go(KEEPER);
    for (const p of [a, l, h]) p.heartbeat();
    return { t, a, l, h, all: [a, l, h] };
  }
  const fromNpc = (t: Town, x: Actor) => chatEvents(t, x).filter((e) => e.from.kind === 'npc');

  it('17. NPC 开口：真人听众收到事件；AI 旁听者和 AI 提问者都没有事件，话在它们的 here.chat 里，提问者从回执拿到回答；叫醒额度和补叫都没动', () => {
    const { t, a, l, h } = atKeeper();
    const out = a.act('ask_npc', { npcId: KEEPER });
    expect(out).toMatchObject({ status: 'completed', spoken: true });
    expect(String(out.text).length).toBeGreaterThan(0);
    // 先证明这句话真的广播了：真人收到了，三个人都在受众里
    expect(fromNpc(t, h).map((e) => e.text)).toEqual([out.text]);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id WHERE m.sender_id = ?', KEEPER)).toBe(3);
    // 两位 AI 都没有任何 chat 事件
    expect(chatEvents(t, a)).toHaveLength(0);
    expect(chatEvents(t, l)).toHaveLength(0);
    // 但都看得到这句话；提问者回执里的 messageId 是它自己听到这句的序号
    expect(hereChat(t, l)).toEqual([out.text]);
    expect(hereChat(t, a)).toEqual([out.text]);
    expect(out.messageId).toBe(1);
    // 叫醒额度没有动，也没有补叫任务
    expect(t.w.db.all("SELECT bucket FROM rate_buckets WHERE bucket LIKE 'nearby_wake%'")).toEqual([]);
    expect(wakeJobs(t)).toHaveLength(0);
  });

  it('18. NPC 的话夹在中间：之前被压下的那句照样补叫，补发的是那位 AI 的话，不是 NPC 的台词', () => {
    const { t, a, l, h, all } = atKeeper({ nearbyWakePairBurst: 1 });
    say(a, '第一句');
    say(a, '第二句'); // 成对桶只有 1 个：这句对 l 被压下
    expect(texts(t, l)).toEqual(['第一句']);
    const job = pendingFor(t, l);
    expect(job).toHaveLength(1);
    const due = Number(job[0]!.due_at);
    // 真人问掌柜：掌柜开口，l 也在受众里，但不给它发事件，也不动它的补叫
    const out = h.act('ask_npc', { npcId: KEEPER });
    expect(out.spoken).toBe(true);
    expect(fromNpc(t, h)).toHaveLength(1);
    expect(hereChat(t, l)).toEqual(['第一句', '第二句', out.text]); // l 的现场里最新的一句是 NPC 的
    expect(texts(t, l)).toEqual(['第一句']);
    expect(pendingFor(t, l).map((j) => Number(j.due_at))).toEqual([due]);
    advanceTo(t, due - 1, all);
    expect(texts(t, l)).toEqual(['第一句']);
    advanceTo(t, due, all);
    const evs = chatEvents(t, l);
    expect(evs.map((e) => e.text)).toEqual(['第一句', '第二句']);
    expect(evs[1]!.from).toMatchObject({ id: a.residentId, kind: 'agent' });
    expect(evs[1]!.messageId).toBe(2);
    expect(pendingFor(t, l)).toHaveLength(0);
  });

  it('19. 只有 NPC 说过话：没有东西可补叫（NPC 的台词不安排补叫，也不会被当成被压下的话补发）', () => {
    const { t, a, l, h, all } = atKeeper({ nearbyWakePairBurst: 1 });
    say(a, '第一句'); // 用掉 l 对 a 的成对额度
    expect(texts(t, l)).toEqual(['第一句']);
    h.act('ask_npc', { npcId: KEEPER });
    expect(fromNpc(t, h)).toHaveLength(1);
    expect(wakeJobs(t)).toHaveLength(0);
    advanceTo(t, t.clock.t + HOUR, all);
    expect(texts(t, l)).toEqual(['第一句']);
    expect(wakeJobs(t, 'pending')).toHaveLength(0);
  });
});

describe('AI 的视图怎么看到被压下的话', () => {
  it('20. AI 的紧凑视图里是 here.recent_chat，只有最新的 AGENT_RECENT_CHAT 条（没有 here.chat）；被压下的话比这多时，历史里翻得到全部；指南写的字段名和条数与此一致', () => {
    const { t, people } = cast(['agent', 'agent']);
    const [a, b] = people as [Actor, Actor];
    const N = AGENT_RECENT_CHAT + 4;
    for (let i = 1; i <= N; i++) say(a, `第${i}句`);
    // 前 5 句当场，后面的都被压下：b 醒来时要靠视图和历史补上
    expect(texts(t, b)).toHaveLength(5);
    const here = agentView(t.w, b.row(), b.clientId).here as { recent_chat: { from: string; text: string }[]; chat?: unknown };
    expect(here.chat).toBeUndefined();
    expect(here.recent_chat.map((c) => c.text)).toEqual(Array.from({ length: AGENT_RECENT_CHAT }, (_, i) => `第${N - AGENT_RECENT_CHAT + 1 + i}句`));
    // 真人视图（和内部的 here.chat）有全部 N 句；AI 要看更早的，用历史
    expect(hereChat(t, b)).toHaveLength(N);
    expect(heard(t, b).reverse()).toEqual(Array.from({ length: N }, (_, i) => `第${i + 1}句`));
    // 指南指的是 AI 视图里真有的字段、说的是真的条数
    expect(TOWN_GUIDE).toContain('here.recent_chat');
    expect(TOWN_GUIDE).not.toContain('here.chat');
    expect(TOWN_GUIDE).toContain(`最多 ${AGENT_RECENT_CHAT} 条、30 分钟内`);
  });
});
