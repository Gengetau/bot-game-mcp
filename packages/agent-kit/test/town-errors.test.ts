/**
 * TownClient 的错误映射和重试规则：用假的调用器逐个构造引擎的错误文本，不需要起引擎。
 */
import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  ContextStaleError,
  ControlLostError,
  NotAvailableError,
  PhaseStaleError,
  PreconditionFailedError,
  RateLimitedError,
  RecoveringError,
  RequestConflictError,
  RequestExpiredError,
  ResyncRequiredError,
  ToolError,
  TownClient,
  TownDisabledError,
  TownError,
  TownNetworkError,
  UnauthenticatedError,
  isDiscardError,
  parseToolErrorText,
  toTownError,
  type ToolCaller,
} from '../src/index.js';

/** 引擎的错误文本格式：❌ 消息 / {json 细节} / 💡 提示 / (code: X) */
const engineError = (code: string, message: string, data?: Record<string, unknown>, hint?: string) => {
  const raw = `❌ ${message}${data ? `\n${JSON.stringify(data)}` : ''}${hint ? `\n💡 ${hint}` : ''}\n(code: ${code})`;
  return new ToolError(message, 'world_act', code, raw);
};

describe('错误映射（docs/TOWN.md 错误码表）', () => {
  const cases: [string, new (...a: never[]) => TownError, string][] = [
    ['UNAUTHENTICATED', UnauthenticatedError, 'unauthenticated'],
    ['CONTROL_LOST', ControlLostError, 'control_lost'],
    ['CONTEXT_STALE', ContextStaleError, 'context_stale'],
    ['PHASE_STALE', PhaseStaleError, 'phase_stale'],
    ['PRECONDITION_FAILED', PreconditionFailedError, 'precondition_failed'],
    ['REQUEST_CONFLICT', RequestConflictError, 'request_conflict'],
    ['REQUEST_EXPIRED', RequestExpiredError, 'request_expired'],
    ['RATE_LIMITED', RateLimitedError, 'rate_limited'],
    ['RESYNC_REQUIRED', ResyncRequiredError, 'resync_required'],
    ['RECOVERING', RecoveringError, 'recovering'],
    ['BAD_REQUEST', BadRequestError, 'bad_request'],
    ['NOT_AVAILABLE', NotAvailableError, 'not_available'],
  ];
  for (const [engineCode, Cls, code] of cases) {
    it(`${engineCode} → ${Cls.name}`, () => {
      const e = toTownError(engineError(engineCode, '原因说明', { reason: 'some_reason', contextVersion: 4 }, '提示'), 'world_act', 'req-12345678') as TownError;
      expect(e).toBeInstanceOf(Cls);
      expect(e).toBeInstanceOf(TownError);
      expect(e.code).toBe(code);
      expect(e.message).toBe('原因说明');
      expect(e.reason).toBe('some_reason');
      expect(e.data.contextVersion).toBe(4);
      expect(e.hint).toBe('提示');
      expect(e.requestId).toBe('req-12345678');
      expect(e.name).toBe(Cls.name);
    });
  }

  it('retryAfterMs 从细节里取出来', () => {
    const e = toTownError(engineError('RATE_LIMITED', '发言太频繁了，歇 4 秒再试。', { reason: 'chat', retryAfterMs: 3200 }), 'world_act') as RateLimitedError;
    expect(e.retryAfterMs).toBe(3200);
    expect(e.reason).toBe('chat');
  });

  it('作废类（世界变了 / 规则不允许）和其它类区分开', () => {
    for (const code of ['CONTEXT_STALE', 'PHASE_STALE', 'PRECONDITION_FAILED', 'REQUEST_EXPIRED', 'REQUEST_CONFLICT', 'BAD_REQUEST', 'NOT_AVAILABLE']) {
      expect(isDiscardError(toTownError(engineError(code, 'x'), 'world_act')), code).toBe(true);
    }
    for (const code of ['CONTROL_LOST', 'RATE_LIMITED', 'RECOVERING', 'UNAUTHENTICATED', 'RESYNC_REQUIRED']) {
      expect(isDiscardError(toTownError(engineError(code, 'x'), 'world_act')), code).toBe(false);
    }
    expect((toTownError(engineError('CONTEXT_STALE', 'x'), 'world_act') as TownError).isStale).toBe(true);
    expect((toTownError(engineError('CONTROL_LOST', 'x'), 'world_act') as TownError).isStale).toBe(false);
  });

  it('没有权限 / 没有错误码 / 工具不存在 / 网络错误', () => {
    expect(toTownError(engineError('FORBIDDEN', '只有可信账号'), 'town_issue_ticket')).toMatchObject({ code: 'forbidden' });
    expect(toTownError(new ToolError('服务器内部错误', 'world_act', undefined, '❌ 服务器内部错误：boom'), 'world_act')).toMatchObject({ code: 'unknown' });
    const off = toTownError(new ToolError('MCP error -32602: Tool enter_world not found', 'enter_world', undefined, 'MCP error -32602: Tool enter_world not found'), 'enter_world');
    expect(off).toBeInstanceOf(TownDisabledError);
    const net = toTownError(new Error('fetch failed'), 'world_act', 'req-12345678') as TownError;
    expect(net).toBeInstanceOf(TownNetworkError);
    expect(net.code).toBe('network');
    expect(net.requestId).toBe('req-12345678');
    // 取消不转成网络错误
    const ab = new DOMException('This operation was aborted', 'AbortError');
    expect(toTownError(ab, 'world_wait')).toBe(ab);
  });

  it('parseToolErrorText 容忍没有细节的文本', () => {
    expect(parseToolErrorText('❌ 出错了\n(code: BAD_REQUEST)')).toEqual({ message: '出错了', data: {}, code: 'BAD_REQUEST' });
  });
});

describe('act 的重试规则', () => {
  type Call = { name: string; args: Record<string, any> };
  const fakeCaller = (script: (call: Call, n: number) => unknown) => {
    const calls: Call[] = [];
    const caller: ToolCaller = {
      async call(name, args = {}) {
        const call = { name, args };
        calls.push(call);
        const out = script(call, calls.length);
        if (out instanceof Error) throw out;
        return out as never;
      },
    };
    return { calls, caller };
  };
  const view = { action_window: 'aw.1.x', context: { version: 3, activityId: null }, control: { epoch: 1, mine: true, presenceEpoch: 0 }, cursor: 'c1', me: { id: 'r_1' }, game: null };
  const ok = (id: string) => ({ ok: true, requestId: id, status: 'completed', contextVersion: 3, activityId: null, cursor: 'c2' });
  const sleeps: number[] = [];
  const mk = (caller: ToolCaller, extra = {}) => new TownClient(caller, { clientId: 'unit-client', sleep: async (ms) => void sleeps.push(ms), ...extra });

  it('自动生成请求号、带上视图里的窗口和版本；成功后更新上下文版本', async () => {
    sleeps.length = 0;
    const { calls, caller } = fakeCaller((c) => (c.name === 'get_my_view' ? view : { ...ok(c.args.request_id), contextVersion: 4 }));
    const c = mk(caller);
    const r = await c.speak('你好');
    expect(calls.map((x) => x.name)).toEqual(['get_my_view', 'world_act']); // 没有视图时先读一次
    const sent = calls[1]!.args;
    expect(sent.request_id).toMatch(/^rq-[0-9a-f-]{36}$/);
    expect(sent.request_id.length).toBeGreaterThanOrEqual(8);
    expect(sent).toMatchObject({ action_window: 'aw.1.x', context_version: 3, activity_id: null, action: { type: 'speak', text: '你好' } });
    expect(r.requestId).toBe(sent.request_id);
    expect(c.state.contextVersion).toBe(4);
    // 第二个动作换新的请求号
    await c.speak('再说一句');
    expect(calls[2]!.args.request_id).not.toBe(sent.request_id);
    expect(calls.length).toBe(3);
  });

  it('recovering：用同一个请求号自动重试（指数退避）', async () => {
    sleeps.length = 0;
    let n = 0;
    const { calls, caller } = fakeCaller((c) => {
      if (c.name === 'get_my_view') return view;
      return ++n <= 2 ? engineError('RECOVERING', '小镇正在恢复') : ok(c.args.request_id);
    });
    const c = mk(caller, { retryBaseMs: 100 });
    await c.act({ type: 'speak', text: 'x' }, { requestId: 'fixed-req-0001' });
    const acts = calls.filter((x) => x.name === 'world_act');
    expect(acts).toHaveLength(3);
    expect(new Set(acts.map((x) => x.args.request_id))).toEqual(new Set(['fixed-req-0001']));
    expect(sleeps).toEqual([100, 200]);
  });

  it('recovering 一直不好：重试次数用完后抛 RecoveringError', async () => {
    sleeps.length = 0;
    const { calls, caller } = fakeCaller((c) => (c.name === 'get_my_view' ? view : engineError('RECOVERING', '小镇正在恢复')));
    const c = mk(caller, { maxRetries: 2 });
    const e = await c.speak('x', { requestId: 'fixed-req-0002' }).catch((x) => x);
    expect(e).toBeInstanceOf(RecoveringError);
    expect(e.requestId).toBe('fixed-req-0002');
    expect(calls.filter((x) => x.name === 'world_act')).toHaveLength(3);
  });

  it('rate_limited：按 retryAfterMs 等一等，用同一个请求号重试；要等太久就直接抛', async () => {
    sleeps.length = 0;
    let n = 0;
    const { calls, caller } = fakeCaller((c) => {
      if (c.name === 'get_my_view') return view;
      return ++n === 1 ? engineError('RATE_LIMITED', '太频繁', { reason: 'chat', retryAfterMs: 2500 }) : ok(c.args.request_id);
    });
    const c = mk(caller);
    await c.speak('x', { requestId: 'fixed-req-0003' });
    expect(sleeps).toEqual([2550]);
    expect(calls.filter((x) => x.name === 'world_act').map((x) => x.args.request_id)).toEqual(['fixed-req-0003', 'fixed-req-0003']);

    sleeps.length = 0;
    const slow = fakeCaller((c) => (c.name === 'get_my_view' ? view : engineError('RATE_LIMITED', '太频繁', { retryAfterMs: 60_000 })));
    const e = await mk(slow.caller, { rateLimitMaxWaitMs: 15_000 }).speak('x').catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitedError);
    expect(e.retryAfterMs).toBe(60_000);
    expect(sleeps).toEqual([]);
    expect(slow.calls.filter((x) => x.name === 'world_act')).toHaveLength(1);
  });

  it('其它错误一律不自动重试', async () => {
    for (const code of ['CONTROL_LOST', 'CONTEXT_STALE', 'PHASE_STALE', 'PRECONDITION_FAILED', 'REQUEST_EXPIRED', 'REQUEST_CONFLICT', 'UNAUTHENTICATED', 'BAD_REQUEST']) {
      const { calls, caller } = fakeCaller((c) => (c.name === 'get_my_view' ? view : engineError(code, '不行')));
      const e = await mk(caller).speak('x').catch((x) => x);
      expect(e, code).toBeInstanceOf(TownError);
      expect(e.code).toBe(code.toLowerCase());
      expect(calls.filter((x) => x.name === 'world_act'), code).toHaveLength(1);
    }
  });

  it('网络错误：不自动重试，抛 TownNetworkError 并带上请求号；调用方用同一个请求号再调一次', async () => {
    let n = 0;
    const { calls, caller } = fakeCaller((c) => {
      if (c.name === 'get_my_view') return view;
      return ++n === 1 ? new Error('socket hang up') : { ...ok(c.args.request_id), replayed: true };
    });
    const c = mk(caller);
    const e = await c.speak('x').catch((x) => x);
    expect(e).toBeInstanceOf(TownNetworkError);
    expect(e.requestId).toMatch(/^rq-/);
    const again = await c.speak('x', { requestId: e.requestId });
    expect(again.replayed).toBe(true);
    const acts = calls.filter((x) => x.name === 'world_act');
    expect(acts[0]!.args.request_id).toBe(acts[1]!.args.request_id);
  });

  it('显式传入的窗口、版本、activityId 原样提交（运行器按决策时的视图提交）', async () => {
    const { calls, caller } = fakeCaller((c) => (c.name === 'get_my_view' ? view : ok(c.args.request_id)));
    const c = mk(caller);
    await c.view();
    await c.speak('x', { actionWindow: 'aw.old', contextVersion: 1, activityId: 'act-9' });
    expect(calls.at(-1)!.args).toMatchObject({ action_window: 'aw.old', context_version: 1, activity_id: 'act-9' });
    expect(c.state.contextVersion).toBe(3); // 显式传入时不改客户端记着的版本
  });

  it('requestId 长度不对直接报错；gameAct 没有 phaseId 报错', async () => {
    const { caller } = fakeCaller(() => view);
    const c = mk(caller);
    await expect(c.act({ type: 'speak', text: 'x' }, { requestId: 'short' })).rejects.toThrow('requestId');
    await c.view();
    expect(() => c.gameAct({ action: 'guess', number: 1 })).toThrow('phaseId');
  });
});
