/**
 * 聊天与键盘方向输入的交叉：方向输入走路的人按 posOf 进出附近聊天的受众；
 * 对局中方向输入被拒与公屏被拒互不影响。
 */
import { describe, expect, it } from 'vitest';
import { WorldError } from '../../src/world/errors.js';
import { directionInput } from '../../src/world/space.js';
import { chatHistory } from '../../src/world/views.js';
import { makeTown, type Actor } from './helpers.js';

const PX = 22.25;
const PZ = 27.25;
const LOOSE = { chatPerMinute: 600, chatBurst: 100, townChatPerMinute: 600, townChatBurst: 100 };
const heard = (a: Actor): string[] => chatHistory(a.t.w, a.residentId, null, 100).messages.map((m) => m.text);

function stand(a: Actor, x: number, z: number): void {
  a.go({ x, z });
  const p = a.pos();
  expect(Math.hypot(p.x - x, p.z - z)).toBeLessThan(0.01);
}

class Keys {
  seq = 0;
  constructor(readonly a: Actor) {}
  press(x: number, z: number) {
    return directionInput(this.a.t.w, this.a.auth, { seq: ++this.seq, epoch: this.a.row().control_epoch, x, z, source: 1 });
  }
  /** 按住 ms 毫秒，并让所有人保持在场 */
  hold(x: number, z: number, ms: number, keep: Actor[]) {
    for (let left = ms; left > 0; left -= 175) {
      this.press(x, z);
      this.a.t.advance(Math.min(175, left));
      for (const k of keep) k.heartbeat();
    }
  }
}

describe('方向输入 × 附近聊天', () => {
  it('用方向键走近后能听见，走远后听不见；按 posOf 的实时位置定受众', () => {
    const t = makeTown({ params: LOOSE });
    const speaker = t.join('阿灯');
    const walker = t.join('小岚', 'agent');
    stand(speaker, PX, PZ);
    stand(walker, PX + 20, PZ); // 远
    const all = [speaker, walker];
    all.forEach((x) => x.heartbeat());
    const k = new Keys(walker);
    speaker.act('say_nearby', { text: '太远了' });
    expect(heard(walker)).toEqual([]);
    // 向西走近：边走边说，什么时候进的受众由那一刻的位置决定
    const log: { text: string; near: boolean }[] = [];
    for (let i = 0; i < 12; i++) {
      k.hold(-1, 0, 1000, all);
      const d = Math.hypot(walker.pos().x - speaker.pos().x, walker.pos().z - speaker.pos().z);
      const text = `近了${i}`;
      speaker.act('say_nearby', { text });
      log.push({ text, near: d <= t.w.map.hearDistance });
    }
    k.press(0, 0);
    expect(log.some((l) => l.near) && log.some((l) => !l.near)).toBe(true);
    const got = new Set(heard(walker));
    for (const l of log) expect(got.has(l.text), `${l.text} near=${l.near}`).toBe(l.near);
    // 再向东走远：听到过的还在，新的不再收到
    const before = heard(walker).length;
    k.hold(1, 0, 12_000, all);
    k.press(0, 0);
    expect(Math.hypot(walker.pos().x - speaker.pos().x, walker.pos().z - speaker.pos().z)).toBeGreaterThan(t.w.map.hearDistance);
    speaker.act('say_nearby', { text: '又走远了' });
    expect(heard(walker).length).toBe(before);
    expect(heard(walker)).not.toContain('又走远了');
  });
});

describe('方向输入 × 对局中', () => {
  it('对局中方向输入被拒（in_activity），公屏发送也被拒（in_activity）；互不影响，局外人照常', () => {
    const t = makeTown({ params: LOOSE });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    const out = t.join('小满', 'agent');
    a.go('arcade:table1');
    b.go('arcade:table1');
    [a, b, out].forEach((x) => x.heartbeat());
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    const kb = new Keys(b);
    const dirReason = () => {
      try {
        kb.press(1, 0);
      } catch (e) {
        if (e instanceof WorldError) return e.reason;
        throw e;
      }
      return 'ok';
    };
    expect(dirReason()).toBe('in_activity');
    expect(b.fail('say_town', { text: '局里想发' })).toMatchObject({ code: 'precondition_failed', reason: 'in_activity' });
    expect(b.fail('say_nearby', { text: '局里想说' }).code).toBe('precondition_failed');
    expect(dirReason()).toBe('in_activity');
    expect(b.pos().moving).toBe(false);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM town_chat_messages')).toBe(0);
    out.act('say_town', { text: '局外人的话' });
    expect(new Keys(out).press(1, 0)).toMatchObject({ ok: true });
  });
});
