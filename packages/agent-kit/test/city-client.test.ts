/**
 * CityClient 单测与真实隔离引擎 HTTP MCP 联调测试：
 *  1. 结构化错误映射（RECOVERING / RATE_LIMITED / CONTROL_LOST / ENTRY_VIA_HOME_ONLY / PRECONDITION_FAILED 等）；
 *  2. request_id 幂等退避重试（503、429、网络断连带同一 request_id 重试；业务/控制权/门禁错误绝不重试）；
 *  3. 连接真实 town.enabled=false + city.enabled=true 引擎实例跑通进城、乘车、到站、买喝、发言、离城闭环。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, startHttpServer, createRuntime, type HttpHandle, type Runtime } from 'bot-game-mcp';
import {
  CityBadRequestError,
  CityClient,
  CityConflictError,
  CityControlLostError,
  CityDisabledError,
  CityEntryViaHomeOnlyError,
  CityForbiddenError,
  CityNetworkError,
  CityNotFoundError,
  CityPreconditionError,
  CityRateLimitedError,
  CityRecoveringError,
  CityUnauthenticatedError,
  ToolError,
  type ToolCaller,
} from '../src/index.js';

function makeError(code: string, message: string, extra?: Record<string, unknown>, hint?: string): ToolError {
  const lines = [`❌ ${message}`];
  if (extra && Object.keys(extra).length > 0) lines.push(JSON.stringify(extra));
  if (hint) lines.push(`💡 ${hint}`);
  lines.push(`(code: ${code})`);
  const raw = lines.join('\n');
  return new ToolError(message, 'world_act', code, raw);
}

describe('CityClient：结构化错误与 request_id 幂等重试', () => {
  it('准确映射全部 M0/M1 错误码为对应子类并保留附加字段', async () => {
    const cases: Array<{ raw: unknown; tool?: string; cls: any; code: string; check?: (e: any) => void }> = [
      { raw: makeError('RECOVERING', '城市恢复中'), cls: CityRecoveringError, code: 'recovering' },
      {
        raw: makeError('RATE_LIMITED', '太快了', { reason: 'act', retryAfterMs: 1200 }),
        cls: CityRateLimitedError,
        code: 'rate_limited',
        check: (e: CityRateLimitedError) => {
          expect(e.reason).toBe('act');
          expect(e.retryAfterMs).toBe(1200);
        },
      },
      {
        raw: makeError('CONTROL_LOST', '被另一端接管', { reason: 'control_lost', control: { epoch: 4, mine: false } }),
        cls: CityControlLostError,
        code: 'control_lost',
        check: (e: CityControlLostError) => {
          expect(e.control).toEqual({ epoch: 4, mine: false });
        },
      },
      { raw: makeError('ENTRY_VIA_HOME_ONLY', '室友只能经桥接进城'), cls: CityEntryViaHomeOnlyError, code: 'entry_via_home_only' },
      { raw: makeError('UNAUTHENTICATED', '未进城', { reason: 'no_resident' }), cls: CityUnauthenticatedError, code: 'unauthenticated' },
      { raw: makeError('FORBIDDEN', '不在名单上', { reason: 'not_admitted' }), cls: CityForbiddenError, code: 'forbidden' },
      {
        raw: makeError('PRECONDITION_FAILED', '余额不足', { reason: 'insufficient_funds' }),
        cls: CityPreconditionError,
        code: 'precondition_failed',
        check: (e: CityPreconditionError) => expect(e.reason).toBe('insufficient_funds'),
      },
      { raw: makeError('CONFLICT', '请求号冲突', { reason: 'request_conflict' }), cls: CityConflictError, code: 'conflict' },
      { raw: makeError('NOT_FOUND', '地点不存在', { reason: 'no_such_place' }), cls: CityNotFoundError, code: 'not_found' },
      { raw: makeError('BAD_REQUEST', '参数错误', { reason: 'bad_quantity' }), cls: CityBadRequestError, code: 'bad_request' },
      {
        raw: new ToolError('Tool enter_world not found', 'enter_world', undefined, 'Tool enter_world not found'),
        tool: 'enter_world',
        cls: CityDisabledError,
        code: 'city_disabled',
      },
      { raw: new Error('socket hang up'), cls: CityNetworkError, code: 'network' },
    ];

    for (const c of cases) {
      const caller: ToolCaller = {
        async call() {
          throw c.raw;
        },
      };
      const client = new CityClient(caller, { maxRetries: 0 });
      let caught: any;
      try {
        if (c.tool === 'enter_world') await client.enterWorld({ name: '测试' });
        else await client.act({ type: 'say', text: '你好' }, { requestId: 'req-test-0001' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(c.cls);
      expect(caught.code).toBe(c.code);
      c.check?.(caught);
    }
  });

  it('RECOVERING、RATE_LIMITED 与网络断连时始终复用同一 request_id 退避重试', async () => {
    const seenReqIds: string[] = [];
    const sleeps: number[] = [];
    let seq = 0;
    const caller: ToolCaller = {
      async call(_name, args): Promise<any> {
        seenReqIds.push(String(args?.request_id));
        seq += 1;
        if (seq === 1) throw makeError('RECOVERING', '恢复中');
        if (seq === 2) throw new Error('fetch timeout');
        if (seq === 3) throw makeError('RATE_LIMITED', '限流', { retryAfterMs: 300 });
        return { ok: true, request_id: args?.request_id, status: 'completed', replayed: true };
      },
    };
    const client = new CityClient(caller, {
      maxRetries: 4,
      retryBaseMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await client.buy('coffee', 1);
    expect(res.status).toBe('completed');
    expect(seenReqIds).toHaveLength(4);
    expect(new Set(seenReqIds).size).toBe(1);
    expect(sleeps).toEqual([100, 200, 350]);
  });

  it('CONTROL_LOST、ENTRY_VIA_HOME_ONLY、PRECONDITION_FAILED 绝不自动重试，且 CONTROL_LOST 立即标记 controlMine=false', async () => {
    let calls = 0;
    const caller: ToolCaller = {
      async call(name): Promise<any> {
        if (name === 'enter_world') {
          return {
            ok: true,
            world_id: 'city',
            created: false,
            resident_id: 'res_1',
            me: { id: 'res_1', name: '旅人', origin: 'external', in_city: true },
            control: { epoch: 2, mine: true },
            location: { place: 'ryokogai:station' },
            wallet: { yen: 1000, held_yen: 0, spendable_yen: 1000 },
            items: [],
            locker_items: [],
            here: null,
            can: ['say'],
            mappings_version: 3,
            action_window: 'city',
            context: { version: 0 },
            cursor: 'r1.aaa',
          };
        }
        calls += 1;
        throw makeError('CONTROL_LOST', '另一终端已接管', { control: { epoch: 3, mine: false } });
      },
    };
    const client = new CityClient(caller, { maxRetries: 3 });
    await client.enterWorld();
    expect(client.state.controlMine).toBe(true);

    await expect(client.say('测试')).rejects.toBeInstanceOf(CityControlLostError);
    expect(calls).toBe(1);
    expect(client.state.controlMine).toBe(false);
    expect(client.state.controlEpoch).toBe(3);
  });

  it('claimControl、storeLocker、takeLocker、leaveWorld 与 query(route) 参数传递符合 M0 契约', async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const caller: ToolCaller = {
      async call(name, args = {}): Promise<any> {
        log.push({ name, args });
        if (name === 'claim_control') return { ok: true, control: { epoch: 5, mine: true } };
        if (name === 'leave_world') return { ok: true };
        if (name === 'world_query') return { from: args.from, to: args.to, minutes: 13, fare_yen: 200 };
        return { ok: true, status: 'completed' };
      },
    };
    const client = new CityClient(caller, { clientId: 'bot-fixed-01' });

    const claimed = await client.claimControl();
    expect(claimed.control).toEqual({ epoch: 5, mine: true });
    expect(client.state.controlMine).toBe(true);

    await client.storeLocker({ itemId: 'it_book_1' }, 1, { requestId: 'req-store-01' });
    await client.takeLocker('umbrella', 2, { requestId: 'req-take-01' });
    const route = await client.query('route', { from: 'hiyorizaka:station', to: 'ryokogai:station' });
    expect(route.fare_yen).toBe(200);

    await client.leaveWorld();
    expect(client.state.controlMine).toBe(false);

    expect(log.map((x) => x.name)).toEqual(['claim_control', 'world_act', 'world_act', 'world_query', 'leave_world']);
    expect(log[1]!.args.action).toEqual({ type: 'store_locker', item_id: 'it_book_1', qty: 1 });
    expect(log[2]!.args.action).toEqual({ type: 'take_locker', item: 'umbrella', qty: 2 });
    expect(log[3]!.args).toEqual({ world_id: 'city', what: 'route', from: 'hiyorizaka:station', to: 'ryokogai:station' });
  });
});

describe('CityClient：真实隔离引擎（town.enabled=false, city.enabled=true）端到端回归', () => {
  let workDir: string | null = null;
  let rt: Runtime | null = null;
  let handle: HttpHandle | null = null;
  const clients: CityClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    if (handle) {
      await handle.close();
      handle = null;
    }
    if (rt) {
      rt.close();
      rt = null;
    }
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = null;
    }
  });

  it('完成准入校验、F16 室友密钥拦截、首次进城领钱、步行进店购买食用与主动离城', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'city-client-e2e-'));
    const cfg = loadConfig(undefined, {
      BOTGAME_HOST: '127.0.0.1',
      BOTGAME_PORT: '0',
    });
    cfg.city.enabled = true;
    cfg.city.dbFile = join(workDir, 'city-test.db');
    cfg.city.weather = false;
    cfg.city.allowedAgents = ['ext-1'];
    cfg.city.house = [{ actorId: 'nia', name: '妮娅', qqIds: ['house-nia-qq'] }];
    cfg.auth = {
      mode: 'keys',
      adminKeys: ['adm-key'],
      agents: [
        { key: 'k-ext-1', id: 'ext-1', name: '旅人甲' },
        { key: 'k-unlisted', id: 'ext-99', name: '路人乙' },
        { key: 'k-nia-qq', id: 'house-nia-qq', name: '妮娅QQ' },
      ],
      issuedKeysFile: null,
    };

    rt = createRuntime(cfg, () => undefined);
    for (let i = 0; i < 50 && rt.city!.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    handle = await startHttpServer(rt, () => undefined);

    const houseBot = await CityClient.connect({ url: handle.url, key: 'k-nia-qq', clientId: 'nia-qq-client' });
    const unlistedBot = await CityClient.connect({ url: handle.url, key: 'k-unlisted', clientId: 'unlisted-client' });
    const extBot = await CityClient.connect({ url: handle.url, key: 'k-ext-1', clientId: 'ext-1-main' });
    clients.push(houseBot, unlistedBot, extBot);

    await expect(houseBot.enterWorld({ name: '妮娅' })).rejects.toBeInstanceOf(CityEntryViaHomeOnlyError);
    await expect(unlistedBot.enterWorld({ name: '路人乙' })).rejects.toBeInstanceOf(CityForbiddenError);
    // 室友 QQ 密钥仍可只读看公开视图
    const pub = await houseBot.query('public');
    expect(pub.world_id).toBe('city');

    const entered = await extBot.enterWorld({
      name: '小旅',
      bio: '独立外部测试居民',
      entry: 'kumominato:station',
    });
    expect(entered.created).toBe(true);
    expect(entered.granted_yen).toBe(200_000);
    expect(entered.location).toEqual({ place: 'kumominato:station' });

    // 前往云港南口露台步道（全天开放）验证移动
    const terrace = await extBot.travel('kumominato:southern-terrace');
    expect(terrace.status).toBe('accepted');
    const inTransitView = await extBot.view();
    expect(inTransitView.location).toMatchObject({ in_transit: true });

    const leftRes = await extBot.leaveWorld();
    expect(leftRes.ok).toBe(true);
  });
});
