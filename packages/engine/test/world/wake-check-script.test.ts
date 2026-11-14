/**
 * 模拟脚本里的「附近聊天叫醒」不变量（scripts/world-lib.ts 的 nearbyWakeCheck）本身要可靠：
 *  - 序号按「水位 - 更新的受众行数」算，受众行被保留期清掉之后不错位；
 *  - 真的压下了话、又没有出路时会报违例（不是空转）；
 *  - 世界模拟脚本在违例汇总和「覆盖不足」打印之前就完成收尾核对，失败原因才列得出来。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Actor, makeTown } from './helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '../../../../scripts');
const LOOSE = { chatPerMinute: 600, chatBurst: 100 };

interface Lib {
  Invariants: new (echo: (m: string) => void) => { totalViolations: number; violations: { invariant: string }[] };
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
