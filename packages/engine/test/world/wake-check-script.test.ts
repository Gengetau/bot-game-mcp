/**
 * 模拟脚本里的「附近聊天叫醒」不变量（scripts/world-lib.ts 的 nearbyWakeCheck）本身要可靠：
 *  - 序号按「水位 - 更新的受众行数」算，受众行被保留期清掉之后不错位；
 *  - 真的压下了话、又没有出路时会报违例（不是空转）；
 *  - NPC 的台词（AI 听者没有事件）不算被压下，也不带偏序号；
 *  - 「在局里作罢」按补叫任务处理的时刻对那一局的起止来认：先报名、话被压下、之后才开局、补叫到期时在局里的听者不算丢；
 *    补叫在开局之前就没了的，之后开过局也照样报；
 *  - 世界模拟脚本在违例汇总和「覆盖不足」打印之前就完成收尾核对，失败原因才列得出来。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Actor, KEEPER, makeTown } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '../../../../scripts');
const LOOSE = { chatPerMinute: 600, chatBurst: 100 };

interface Lib {
  Invariants: new (echo: (m: string) => void) => { totalViolations: number; violations: { invariant: string; detail?: unknown }[] };
  nearbyWakeCheck: (w: unknown, inv: unknown, now: number, since: number) => { suppressed: number; late: number; live: number };
}
const lib = async (): Promise<Lib> => (await import(/* @vite-ignore */ pathToFileURL(join(SCRIPTS, 'world-lib.ts')).href)) as Lib;

function twoAgents() {
  const t = makeTown({ params: LOOSE });
  const a = t.join('说话的', 'agent');
  const b = t.join('听的', 'agent');
  a.go({ x: 22.25, z: 27.25 });
  b.go({ x: 22.75, z: 27.25 });
  a.heartbeat();
  b.heartbeat();
  return { t, a, b };
}
const say = (a: Actor, text: string) => a.act('say_nearby', { text });

describe('模拟脚本：nearbyWakeCheck', () => {
  it('受众行被保留期清掉一部分之后，序号仍然对得上（不是用行下标 i+1）', async () => {
    const { nearbyWakeCheck, Invariants } = await lib();
    const { t, a, b } = twoAgents();
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`); // 前 5 句当场，第 6 句被压下，补叫待办
    const rowsOf = () => Number(t.w.db.scalar('SELECT COUNT(*) FROM chat_audience WHERE resident_id = ?', b.residentId));
    expect(rowsOf()).toBe(6);
    const before = nearbyWakeCheck(t.w, new Invariants(() => undefined), t.clock.t, 0);
    expect(before).toMatchObject({ live: 5, suppressed: 1 });
    // 模拟 reports.ts 的保留期清理：最早的两句的受众行被删掉（序号水位不变）
    const old = t.w.db.all('SELECT message_id FROM chat_audience WHERE resident_id = ? ORDER BY message_id LIMIT 2', b.residentId);
    for (const r of old) t.w.db.run('DELETE FROM chat_audience WHERE resident_id = ? AND message_id = ?', b.residentId, r.message_id);
    expect(rowsOf()).toBe(4);
    const inv = new Invariants(() => undefined);
    const after = nearbyWakeCheck(t.w, inv, t.clock.t, 0);
    // 剩下 3 句当场 + 1 句压下；按行下标算序号会把压下的那句错认成「有事件」，得到 live 4 / suppressed 0
    expect(after).toMatchObject({ live: 3, suppressed: 1 });
    expect(inv.totalViolations).toBe(0);
  });

  it('话被压下、补叫任务也没了、听者还在场：报 nearby_wake_lost（证明不丢核对不是空转）', async () => {
    const { nearbyWakeCheck, Invariants } = await lib();
    const { t, a, b } = twoAgents();
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`);
    const ok = new Invariants(() => undefined);
    nearbyWakeCheck(t.w, ok, t.clock.t, 0);
    expect(ok.totalViolations).toBe(0); // 有待办的补叫：放行
    t.w.db.run("UPDATE scheduled_jobs SET status = 'done' WHERE kind = 'nearby_wake' AND dedupe_key = ?", `nearby_wake:${b.residentId}`);
    const bad = new Invariants(() => undefined);
    nearbyWakeCheck(t.w, bad, t.clock.t, 0);
    expect(bad.violations.map((v) => v.invariant)).toContain('nearby_wake_lost');
  });

  it('NPC 的台词在 AI 听者的受众表里没有事件：不算被压下、不报违例；它后面真被压下又没出路的话照样报，序号不被它带偏', async () => {
    const { nearbyWakeCheck, Invariants } = await lib();
    // 闲逛者一直停着，不来添乱
    const t = makeTown({ params: { ...LOOSE, npcStayMinMs: 600_000, npcStayMaxMs: 600_000 } });
    const a = t.join('说话的', 'agent');
    const b = t.join('听的', 'agent');
    for (const p of [a, b]) p.go(KEEPER);
    for (const p of [a, b]) p.heartbeat();
    for (let i = 1; i <= 5; i++) say(a, `第${i}句`); // 5 句当场
    expect(a.act('ask_npc', { npcId: KEEPER }).spoken).toBe(true); // 掌柜开口：b 在受众里，但 AI 没有事件
    expect(Number(t.w.db.scalar("SELECT COUNT(*) FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id WHERE a.resident_id = ? AND m.sender_id = ?", b.residentId, KEEPER))).toBe(1);
    const calm = new Invariants(() => undefined);
    expect(nearbyWakeCheck(t.w, calm, t.clock.t, 0)).toMatchObject({ live: 5, suppressed: 0, late: 0 });
    expect(calm.totalViolations).toBe(0);
    say(a, '第6句'); // 成对额度用完：被压下，补叫待办
    const ok = new Invariants(() => undefined);
    expect(nearbyWakeCheck(t.w, ok, t.clock.t, 0)).toMatchObject({ live: 5, suppressed: 1 });
    expect(ok.totalViolations).toBe(0);
    t.w.db.run("UPDATE scheduled_jobs SET status = 'done' WHERE kind = 'nearby_wake' AND dedupe_key = ?", `nearby_wake:${b.residentId}`);
    const bad = new Invariants(() => undefined);
    nearbyWakeCheck(t.w, bad, t.clock.t, 0);
    expect(bad.totalViolations).toBe(1);
    // b 听到的第 7 句（5 句 + 掌柜的一句 + 第 6 句）：序号把 NPC 那一行也数进去了
    expect(bad.violations[0]).toMatchObject({ invariant: 'nearby_wake_lost', detail: { listener: b.residentId, from: a.residentId, messageSeq: 7 } });
  });

  it('先报名凑桌、话被压下、之后才开局：补叫到期时听者在局里就作罢，它回到镇上后不报违例（按补叫处理的时刻对那一局的起止来认）；对照：只报了名、还没开局，补叫没了照样报', async () => {
    const { nearbyWakeCheck, Invariants } = await lib();
    // 成对额度恢复调到最快（每小时 1000 个，约 3.6 秒一个）：补叫几秒后就到期，局还没来得及因为超时自己结束
    const t = makeTown({ params: { ...LOOSE, nearbyWakePairPerHour: 1000 } });
    const a = t.join('说话的', 'agent');
    const b = t.join('听的', 'agent');
    const c = t.join('牌友', 'agent');
    for (const x of [a, b, c]) x.go('arcade:table1');
    const beat = () => [a, b, c].forEach((x) => x.heartbeat());
    beat();
    // b 发起凑桌、c 报名：报名时刻早于后面那句话；凑桌的人仍在场、仍听得到
    const p = b.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    c.act('join_game', { activityId: p.activity.id });
    t.advance(2000);
    beat();
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`); // 第 6 句对 b 被压下
    const key = `nearby_wake:${b.residentId}`;
    const job = () => t.w.db.get('SELECT status, due_at FROM scheduled_jobs WHERE dedupe_key = ?', key)!;
    const eventsOfB = () => Number(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE resident_id = ? AND type = 'chat'", b.residentId));
    expect(eventsOfB()).toBe(5);
    expect(job().status).toBe('pending');
    const due = Number(job().due_at);
    expect(due).toBeGreaterThan(t.clock.t);
    const joinedAt = Number(t.w.db.scalar('SELECT joined_at FROM activity_participants WHERE activity_id = ? AND resident_id = ?', p.activity.id, b.residentId));
    const sentAt = Number(t.w.db.scalar('SELECT MAX(sent_at) FROM chat_messages WHERE sender_id = ?', a.residentId));
    expect(joinedAt).toBeLessThan(sentAt);
    // 对照：只报了名、还没开局（报名不等于离开），补叫没了 → 报违例
    t.w.db.run("UPDATE scheduled_jobs SET status = 'done' WHERE dedupe_key = ?", key);
    const bad = new Invariants(() => undefined);
    nearbyWakeCheck(t.w, bad, t.clock.t, 0);
    expect(bad.violations.filter((v) => v.invariant === 'nearby_wake_lost')).toHaveLength(1);
    expect(bad.violations[0]).toMatchObject({ detail: { listener: b.residentId } });
    t.w.db.run("UPDATE scheduled_jobs SET status = 'pending' WHERE dedupe_key = ?", key);
    // 开局（晚于那句话）；补叫到期时 b 在局里：任务结束，没有补发
    b.act('start_game', { activityId: p.activity.id });
    expect(b.row().activity_id).not.toBeNull();
    expect(t.clock.t).toBeLessThan(due);
    t.advanceTo(due + 500);
    expect(job().status).toBe('done');
    expect(eventsOfB()).toBe(5);
    // b 退出这一局回到镇上：在场、不在局里、没有待办的补叫，那句话始终没有事件
    b.act('quit_game');
    expect(b.row().activity_id).toBeNull();
    expect(b.row().present_since).not.toBeNull();
    const inv = new Invariants(() => undefined);
    const stats = nearbyWakeCheck(t.w, inv, t.clock.t, 0);
    expect(stats.suppressed).toBeGreaterThanOrEqual(1);
    expect(inv.totalViolations).toBe(0);
  });

  it('补叫在开局之前就没了（处理时听者不在任何一局里，也没发出事件），之后听者开了一局又回来：照样报 nearby_wake_lost，不因为「之后开过局」放行', async () => {
    const { nearbyWakeCheck, Invariants } = await lib();
    const t = makeTown({ params: { ...LOOSE, nearbyWakePairPerHour: 1000 } });
    const a = t.join('说话的', 'agent');
    const b = t.join('听的', 'agent');
    const c = t.join('牌友', 'agent');
    for (const x of [a, b, c]) x.go('arcade:table1');
    const beat = () => [a, b, c].forEach((x) => x.heartbeat());
    beat();
    for (let i = 1; i <= 6; i++) say(a, `第${i}句`); // 第 6 句对 b 被压下，补叫待办
    const key = `nearby_wake:${b.residentId}`;
    const job = () => t.w.db.get('SELECT status, due_at, processed_at FROM scheduled_jobs WHERE dedupe_key = ?', key)!;
    const eventsOfB = () => Number(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE resident_id = ? AND type = 'chat'", b.residentId));
    expect(eventsOfB()).toBe(5);
    expect(job().status).toBe('pending');
    const sentAt = Number(t.w.db.scalar('SELECT MAX(sent_at) FROM chat_messages WHERE sender_id = ?', a.residentId));
    // 模拟引擎把补叫弄丢：任务此刻就被标成处理完（b 在场、不在任何一局里），没有发出事件
    const lostAt = t.clock.t;
    t.w.db.run("UPDATE scheduled_jobs SET status = 'done', processed_at = ? WHERE dedupe_key = ?", lostAt, key);
    expect(lostAt).toBeGreaterThanOrEqual(sentAt);
    // 之后 b 才凑桌、开局、退出，回到镇上
    t.advance(1000);
    beat();
    const p = b.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    c.act('join_game', { activityId: p.activity.id });
    b.act('start_game', { activityId: p.activity.id });
    expect(b.row().activity_id).not.toBeNull();
    const startedAt = Number(t.w.db.scalar('SELECT started_at FROM activities WHERE activity_id = ?', p.activity.id));
    expect(startedAt).toBeGreaterThan(lostAt); // 开局晚于补叫没了的时刻
    // b 还在局里：按「此刻不在镇上」放行（它出局时有自己的事件）
    const during = new Invariants(() => undefined);
    nearbyWakeCheck(t.w, during, t.clock.t, 0);
    expect(during.totalViolations).toBe(0);
    t.advance(1000);
    b.act('quit_game');
    expect(b.row().activity_id).toBeNull();
    expect(b.row().present_since).not.toBeNull();
    expect(Number(b.row().present_since)).toBeLessThan(sentAt); // 没有掉线重进：不靠「离开又回来」放行
    expect(job()).toMatchObject({ status: 'done', processed_at: lostAt }); // 之后没有新的压下去重排它
    expect(eventsOfB()).toBe(5);
    const inv = new Invariants(() => undefined);
    nearbyWakeCheck(t.w, inv, t.clock.t, 0);
    expect(inv.violations.filter((v) => v.invariant === 'nearby_wake_lost')).toHaveLength(1);
    expect(inv.violations[0]).toMatchObject({ detail: { listener: b.residentId, from: a.residentId, messageSeq: 6 } });
  });
});

describe('模拟脚本：收尾核对和覆盖断言排在汇总打印之前', () => {
  it('world-simulate.ts 里 wakeFinal 和两条覆盖缺口都在「不变量」汇总和「覆盖不足」打印之前，并并入 coverageMissing', () => {
    const src = readFileSync(join(SCRIPTS, 'world-simulate.ts'), 'utf8');
    const at = (s: string) => {
      const i = src.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    const summary = at("console.log('\\n── 不变量 ──')");
    const missingPrint = at("console.log('\\n覆盖不足：')");
    expect(at('const wakeFinal = nearbyWakeCheck(')).toBeLessThan(summary);
    expect(at("wakeCoverageMissing.push('附近聊天的叫醒额度：「被压下」")).toBeLessThan(summary);
    expect(at("wakeCoverageMissing.push('附近聊天的叫醒额度：「补叫真的发出」")).toBeLessThan(summary);
    expect(at('const coverageMissing: string[] = [...wakeCoverageMissing]')).toBeLessThan(missingPrint);
    // 不能再有排在打印之后才 push 的 coverageMissing 的叫醒条目
    expect(src).not.toMatch(/coverageMissing\.push\('附近聊天的叫醒额度/);
  });
});
