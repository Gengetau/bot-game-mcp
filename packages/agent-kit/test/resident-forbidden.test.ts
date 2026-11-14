/**
 * 进镇被 FORBIDDEN 拒绝（不在进镇名单里）：运行器停下来、done 以这个错误结束，不进入快速重试。
 */
import { describe, expect, it } from 'vitest';
import { ForbiddenError, ResidentRunner, UnauthenticatedError, type EnterProfile, type EnterResult } from '../src/index.js';
import { FakeClock, FakePort } from './fakes.js';

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
});
