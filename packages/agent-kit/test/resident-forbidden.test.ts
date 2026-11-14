/**
 * 进镇被 FORBIDDEN 拒绝（不在进镇名单里）：运行器停下来、done 以这个错误结束，不进入快速重试。
 */
import { describe, expect, it } from 'vitest';
import { ForbiddenError, ResidentRunner, UnauthenticatedError, type DecisionContext, type EnterProfile, type EnterResult } from '../src/index.js';
import { FakeClock, FakePort, chat } from './fakes.js';

const forbidden = () => new ForbiddenError('forbidden', '栖灯镇正在限定测试，这个身份不在进镇名单里。', { tool: 'enter_world' });

class DenyingPort extends FakePort {
  denied = 0;
  denyFrom = 0;
  override async enter(profile?: EnterProfile): Promise<EnterResult> {
    if (this.enters >= this.denyFrom) {
      this.enters++;
      this.denied++;
      throw forbidden();
    }
    return super.enter(profile);
  }
}

describe('ResidentRunner：进镇被 FORBIDDEN 拒绝', () => {
  it('第一次进镇就被拒：只调一次，之后一整天都不再调，done 以这个错误结束', async () => {
    const clock = new FakeClock();
    const port = new DenyingPort(clock);
    const runner = new ResidentRunner({ clock });
    const handle = runner.add({ town: port, profile: { name: '小测' }, decide: () => null });
    const outcome = handle.done.then(
      () => 'resolved',
      (e) => e as Error,
    );
    await clock.advance(0);
    // 一整天的时间（远超任何退避上限）：快速重试会让这个数涨起来
    await clock.advance(24 * 3600_000);
    expect(port.enters).toBe(1);
    const e = await outcome;
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(handle.status).toBe('stopped');
  });

  it('运行中会话失效、重新进入时被拒：同样停下，不再重试', async () => {
    const clock = new FakeClock();
    const port = new DenyingPort(clock);
    port.denyFrom = 1; // 第一次进得去（名单更新前），之后都被拒
    const runner = new ResidentRunner({ clock });
    const handle = runner.add({ town: port, profile: { name: '小测' }, decide: () => null, decideOnStart: false });
    const outcome = handle.done.then(
      () => 'resolved',
      (e) => e as Error,
    );
    await clock.advance(1_000);
    expect(port.enters).toBe(1);
    port.waitFail = () => new UnauthenticatedError('unauthenticated', '先 enter_world', { tool: 'world_wait' });
    await clock.advance(60_000);
    await clock.advance(24 * 3600_000);
    expect(port.enters).toBe(2); // 一次成功 + 一次被拒
    expect(port.denied).toBe(1);
    expect(await outcome).toBeInstanceOf(ForbiddenError);
  });
  it('网络出错后用 reconnect 换新连接、重新进入时被拒：同样停下，新连接只进一次', async () => {
    const clock = new FakeClock();
    const first = new DenyingPort(clock);
    first.denyFrom = 99; // 第一个连接进得去
    const second = new DenyingPort(clock); // 重新连接后的会话：名单更新了，进镇被拒
    let reconnects = 0;
    const runner = new ResidentRunner({ clock });
    const handle = runner.add({
      town: first,
      profile: { name: '小测' },
      decide: () => null,
      decideOnStart: false,
      reconnect: async () => {
        reconnects++;
        return second;
      },
    });
    const outcome = handle.done.then(
      () => 'resolved',
      (e) => e as Error,
    );
    await clock.advance(1_000);
    expect(first.enters).toBe(1);
    first.waitFail = () => new Error('连接断了'); // 普通网络错误：走 backoff 再 reconnect
    await clock.advance(60_000);
    await clock.advance(24 * 3600_000);
    expect(reconnects).toBe(1);
    expect(second.enters).toBe(1);
    expect(second.denied).toBe(1);
    expect(await outcome).toBeInstanceOf(ForbiddenError);
    expect(handle.status).toBe('stopped');
  });

  it('没有 reconnect、视图读到会话丢了、重新进入时被拒：同样停下，不再重试', async () => {
    const clock = new FakeClock();
    const port = new DenyingPort(clock);
    port.denyFrom = 1;
    const runner = new ResidentRunner({ clock });
    const handle = runner.add({ town: port, profile: { name: '小测' }, decide: () => null, decideOnStart: false });
    const outcome = handle.done.then(
      () => 'resolved',
      (e) => e as Error,
    );
    await clock.advance(1_000);
    expect(port.enters).toBe(1);
    port.waitFail = () => new Error('连接断了'); // 普通错误：backoff 之后先读视图确认会话
    port.viewFail = () => new UnauthenticatedError('unauthenticated', '先 enter_world', { tool: 'get_my_view' });
    await clock.advance(60_000);
    await clock.advance(24 * 3600_000);
    expect(port.enters).toBe(2); // 一次成功 + 一次被拒
    expect(port.denied).toBe(1);
    expect(await outcome).toBeInstanceOf(ForbiddenError);
  });
});

describe('ResidentRunner：自己说的话的回显', () => {
  it('chat 事件的发言者是自己：不进积压、不触发决策；别人的话照常进来（引擎对 AI 发言者已不再回显，运行器这一道不依赖它）', async () => {
    const clock = new FakeClock();
    const port = new FakePort(clock);
    const runner = new ResidentRunner({ clock });
    const calls: DecisionContext[] = [];
    runner.add({ town: port, profile: { name: '小测' }, decideOnStart: false, decide: (ctx) => (calls.push(ctx), null) });
    await clock.advance(0);
    port.push(chat(port.residentId, '我自己说的话'));
    await clock.advance(60_000);
    expect(calls).toHaveLength(0);
    port.push(chat('r_other', '别人说的话'));
    await clock.advance(60_000);
    expect(calls).toHaveLength(1);
    const texts = calls[0]!.events.filter((e) => e.type === 'chat').map((e) => e.text);
    expect(texts).toEqual(['别人说的话']);
  });
});
