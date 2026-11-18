#!/usr/bin/env node
/**
 * 东京城市 v1 · M1 故障端到端与三方真实跨进程联调脚本（#246 + #247）。
 *
 * 同场覆盖三类真实玩家 + 跨库故障自愈：
 *   1. 小屋室友（妮娅 nia）：真实 Python 子进程运行 world-kernel/life1 CityBridgeAdapter（Store(synthetic=True)）；
 *   2. 独立外部 Bot（旅人一号）：真实 MCP Streamable HTTP 连接 + packages/agent-kit CityClient（含双端控制权交接）；
 *   3. 人类网页玩家（小灯）：真实裁判签发一次性登录票据 city_issue_ticket → /city/api/auth/exchange 会话 + CSRF 写校验。
 *
 * 全程在独立临时目录与独立测试库 city-test.db 运行（town.enabled = false），零外网、零生产触碰，输出完全脱敏。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createIsolatedCityHarness, CITY_TEST_T0 } from '../packages/engine/test/city/test-harness.js';
import { ledgerImbalance, runReconcile } from '../packages/engine/src/city/index.js';
import {
  BotGameClient,
  CityClient,
  CityControlLostError,
  CityEntryViaHomeOnlyError,
} from '../packages/agent-kit/src/index.js';

class PythonKernelProcess {
  private proc!: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, (msg: Record<string, any>) => void>();

  async start(opts: { kernelDir: string; bridgeUrl: string; bridgeKey: string; startMs: number }): Promise<void> {
    const driverPath = join(opts.kernelDir, 'city_m1_e2e_driver.py');
    assert.ok(existsSync(driverPath), `未找到内核联调驱动：${driverPath}`);
    const catalogParent = resolve(opts.kernelDir, '..', 'world-catalog');
    this.proc = spawn(
      'python3',
      ['-B', driverPath, '--bridge-url', opts.bridgeUrl, '--bridge-key', opts.bridgeKey, '--start-ms', String(opts.startMs)],
      {
        cwd: opts.kernelDir,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: opts.kernelDir,
          ...(existsSync(catalogParent) ? { WORLD_CATALOG_DIR: catalogParent } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const readyPromise = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });

    const rl = createInterface({ input: this.proc.stdout });
    let gotReady = false;
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed) as Record<string, any>;
      if (!gotReady && msg.ready) {
        gotReady = true;
        readyResolve();
        return;
      }
      if (typeof msg.seq === 'number') {
        const cb = this.pending.get(msg.seq);
        if (cb) {
          this.pending.delete(msg.seq);
          cb(msg);
        }
      }
    });

    let stderrBuf = '';
    this.proc.stderr.on('data', (chunk) => {
      stderrBuf += String(chunk);
    });
    this.proc.once('exit', (code) => {
      if (!gotReady) {
        readyReject(new Error(`Python 内核驱动提前退出 (${code}): ${stderrBuf}`));
      }
      for (const [, cb] of this.pending) {
        cb({ ok: false, error: `kernel exited (${code}): ${stderrBuf}` });
      }
      this.pending.clear();
    });

    await readyPromise;
  }

  async call(payload: Record<string, unknown>): Promise<Record<string, any>> {
    const seq = ++this.seq;
    const p = new Promise<Record<string, any>>((res) => {
      this.pending.set(seq, res);
    });
    this.proc.stdin.write(`${JSON.stringify({ ...payload, seq })}\n`);
    return p;
  }

  async stop(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    try {
      await this.call({ op: 'close' });
    } catch {
      this.proc.kill('SIGTERM');
    }
  }
}

async function webJson(
  baseUrl: string,
  path: string,
  opts: {
    method?: string;
    body?: Record<string, unknown>;
    sessionHeader?: string;
    csrfHeader?: string;
    authBearer?: string;
    clientId?: string;
  } = {},
): Promise<{ status: number; body: Record<string, any>; setHeader: string | null }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.sessionHeader) headers.Cookie = opts.sessionHeader;
  if (opts.csrfHeader) headers['X-City-CSRF'] = opts.csrfHeader;
  if (opts.authBearer) headers.Authorization = `Bearer ${opts.authBearer}`;
  if (opts.clientId) headers['X-City-Client'] = opts.clientId;
  const resp = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const setHdr = resp.headers.get('set-cookie');
  const text = await resp.text();
  const parsed = text ? (JSON.parse(text) as Record<string, any>) : {};
  return { status: resp.status, body: parsed, setHeader: setHdr };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'kernel-dir': { type: 'string' },
    },
  });
  const kernelDir = resolve(
    values['kernel-dir'] ?? process.env.WORLD_KERNEL_DIR ?? '/srv/coding-work/mcp-gemini4-ext-city-m1a-247/world-kernel',
  );

  const harness = await createIsolatedCityHarness({
    at: CITY_TEST_T0,
    seed: 'city-m1-three-party-e2e-v1',
    enableControlRoutes: true,
    cityOverrides: {
      publicUrl: 'https://city-test.local/city/play',
      devLogin: false,
      adminOnlyTickets: false,
    },
  });

  const pyKernel = new PythonKernelProcess();
  let botClientA: CityClient | null = null;
  let botClientB: CityClient | null = null;
  let refereeMcp: BotGameClient | null = null;
  let houseQqClient: CityClient | null = null;

  const checkpoints: Record<string, unknown> = {};

  try {
    await pyKernel.start({
      kernelDir,
      bridgeUrl: harness.bridgeUrl,
      bridgeKey: harness.bridgeKey,
      startMs: harness.clock.t,
    });

    // ── Phase 1: F13 雨天无伞拦截 & F16 室友 QQ 侧硬拦截 ──
    harness.setAreaRain({ akabane: false, ikebukuro: true, shinjuku: false });
    const stripped = await pyKernel.call({ op: 'strip_umbrellas', actor_id: 'nia', add_parasol: true });
    assert.equal(stripped.rain_ready, false, '阳伞不应算作雨具');
    const rainRefused = await pyKernel.call({
      op: 'depart',
      actor_id: 'nia',
      destination: 'ikebukuro:kissa-tomoshibi',
      carry_yen: 20000,
      visit_id: 'vis_rain_blocked',
    });
    assert.equal(rainRefused.ok, false);
    assert.equal(rainRefused.refused, 'rain_requires_owned_umbrella');
    const afterRainInspect = await pyKernel.call({ op: 'inspect', actor_id: 'nia' });
    assert.equal(afterRainInspect.wallet_available, 40000, 'F13 雨天拒出不得冻结家庭日元');
    assert.equal(afterRainInspect.actor.location, 'living');

    // F16: 室友 QQ 密钥直接调 enter_world 必须返回 ENTRY_VIA_HOME_ONLY
    houseQqClient = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_house_qq_nia_30001',
      clientId: 'qq-nia-direct',
      maxRetries: 1,
    });
    await assert.rejects(
      () => houseQqClient!.enterWorld({ name: '妮娅' }),
      (err: unknown) => err instanceof CityEntryViaHomeOnlyError && err.code === 'entry_via_home_only',
    );
    await houseQqClient.close();
    houseQqClient = null;
    checkpoints.phase1_f13_f16 = 'PASS';

    // 恢复晴天并给妮娅补回透明雨伞
    harness.setAreaRain({ akabane: false, ikebukuro: false, shinjuku: false });
    await pyKernel.call({ op: 'grant_umbrella', actor_id: 'nia' });

    // ── Phase 2: 三类真实玩家入城并前往池袋·喫茶「灯」（含 F4 commit 丢包恢复 & 双端控制权交接） ──
    // 2A) 小屋室友妮娅：确认计划 -> T1 冻结 ¥20,000 + 1 包家庭曲奇 -> 注入 503 + dropResponseOnce(F4) -> handover 激活
    await pyKernel.call({ op: 'create_plan', plan_id: 'plan_m1_s1', actor_id: 'nia', location: 'place:ikebukuro' });
    const dep1 = await pyKernel.call({
      op: 'depart',
      actor_id: 'nia',
      destination: 'ikebukuro:kissa-tomoshibi',
      carry_yen: 20000,
      carry_items: [{ resource_id: 'nia_cookie_1', qty: 1 }],
      visit_id: 'vis_e2e_1',
      plan_id: 'plan_m1_s1',
    });
    assert.equal(dep1.ok, true);
    assert.equal(dep1.visit.state, 'preparing');

    await pyKernel.call({ op: 'advance', seconds: 60 });
    harness.advance(60_000);
    // 注入 1 次 503 RECOVERING（prepare 重试） + commit 回包丢失（F4 GET /visits/:id 对账恢复）
    harness.faults.bridge503Count = 1;
    let armedDropOnCommit = false;
    const origPrepare = harness.faults;
    void origPrepare;
    // 先跑一次 prepare+commit：设置 dropResponseOnce 在 prepare 之后或直接测 F4：
    harness.faults.dropResponseOnce = true;
    armedDropOnCommit = true;
    void armedDropOnCommit;
    const ho1 = await pyKernel.call({ op: 'handover', visit_id: 'vis_e2e_1' });
    assert.equal(ho1.ok, true, JSON.stringify(ho1));
    assert.equal(ho1.visit.state, 'active');
    assert.equal(ho1.visit.domain_epoch, 1);

    // 2B) 独立外部 Bot（旅人一号）：MCP CityClient 入城 + 双实例控制权测试 + 出发去喫茶「灯」
    botClientA = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_key_city_90001',
      clientId: 'ext-bot-proc-a',
      retryBaseMs: 20,
    });
    const botEnterA = await botClientA.enterWorld({ name: '旅人一号', entry: 'ikebukuro:station', bio: '独立外部Bot' });
    assert.equal(botEnterA.granted_yen, 200_000);
    assert.deepEqual(botEnterA.control, { epoch: 1, mine: true });
    const botResidentId = botEnterA.resident_id;

    botClientB = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_key_city_90001',
      clientId: 'ext-bot-proc-b',
      retryBaseMs: 20,
    });
    const botEnterB = await botClientB.enterWorld();
    assert.equal(botEnterB.control.mine, false, 'enter_world 默认不得暗抢已有活跃控制权');
    const claimed = await botClientB.claimControl();
    assert.deepEqual(claimed.control, { epoch: 2, mine: true });
    await assert.rejects(
      () => botClientA!.say('旧实例试图发言'),
      (err: unknown) => err instanceof CityControlLostError && err.code === 'control_lost',
    );
    await botClientA.close();
    botClientA = null;

    const routeCheck = await botClientB.query('route', { from: 'akabane:station', to: 'ikebukuro:kissa-tomoshibi' });
    assert.equal((routeCheck as any).fare_yen, 200);
    await botClientB.travel('ikebukuro:kissa-tomoshibi');

    // 2C) 人类网页玩家（小灯）：裁判签发一次性票据 -> 兑换 Cookie + CSRF -> 入城 -> 出发去喫茶「灯」
    refereeMcp = await BotGameClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_referee_key_city_0001',
    });
    const issued = await refereeMcp.call<Record<string, any>>('city_issue_ticket', {
      user_id: '777001',
      name: '小灯',
    });
    assert.equal(typeof issued.ticket, 'string');
    assert.ok(String(issued.url).includes('/city/play/#ticket='));

    const exch = await webJson(harness.baseUrl, '/city/api/auth/exchange', {
      body: { ticket: issued.ticket },
    });
    assert.equal(exch.status, 200);
    assert.equal(exch.body.ok, true);
    assert.ok(exch.setHeader && exch.setHeader.includes('HttpOnly'));
    const sessionPair = exch.setHeader!.split(';')[0]!;
    const csrfVal = String(exch.body.csrf_token);

    // 同一张票据二次兑换必须被拒绝
    const exchReplay = await webJson(harness.baseUrl, '/city/api/auth/exchange', {
      body: { ticket: issued.ticket },
    });
    assert.notEqual(exchReplay.status, 200, '一次性登录票据严禁二次兑换');

    // 缺少 X-City-CSRF 的写请求必须返回 403
    const noCsrf = await webJson(harness.baseUrl, '/city/api/enter', {
      body: { name: '小灯', entry: 'ikebukuro:station' },
      sessionHeader: sessionPair,
    });
    assert.equal(noCsrf.status, 403);

    const humanEnter = await webJson(harness.baseUrl, '/city/api/enter', {
      body: { name: '小灯', bio: '人类网页访客', entry: 'ikebukuro:station' },
      sessionHeader: sessionPair,
      csrfHeader: csrfVal,
      clientId: 'web-human-1',
    });
    assert.equal(humanEnter.status, 200, JSON.stringify(humanEnter.body));
    assert.equal(humanEnter.body.granted_yen, 200_000);
    const humanResidentId = String(humanEnter.body.resident_id);

    const humanTravel = await webJson(harness.baseUrl, '/city/api/act', {
      body: {
        request_id: 'web-human-travel-0001',
        action: { type: 'travel', to: 'ikebukuro:kissa-tomoshibi' },
      },
      sessionHeader: sessionPair,
      csrfHeader: csrfVal,
      clientId: 'web-human-1',
    });
    assert.equal(humanTravel.status, 200);
    checkpoints.phase2_three_players_entered = 'PASS';

    // ── Phase 3: 乘车途中引擎重启恢复（验证持久行程不丢、不重复扣车费） ──
    await botClientB.close();
    botClientB = null;
    await refereeMcp.close();
    refereeMcp = null;

    harness.advance(10 * 60_000); // 妮娅已在埼京线列车上（已扣单程 ¥200）
    await pyKernel.call({ op: 'advance', seconds: 600 });
    await harness.restart(2 * 60_000); // 引擎停机 2 分钟并在同一 city-test.db 冷启动恢复
    await pyKernel.call({ op: 'set_bridge_url', bridge_url: harness.bridgeUrl });
    await pyKernel.call({ op: 'advance', seconds: 120 });

    // 重连外部 Bot MCP 会话（沿用同一 clientId 无缝续持控制权 epoch=2）
    botClientB = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_key_city_90001',
      clientId: 'ext-bot-proc-b',
      retryBaseMs: 20,
    });
    const reEnterB = await botClientB.enterWorld();
    assert.equal(reEnterB.control.mine, true);
    assert.ok(reEnterB.control.epoch >= 2);

    // 推进剩余时间，三人全部抵达池袋·喫茶「灯」
    harness.advance(25 * 60_000);
    await pyKernel.call({ op: 'advance', seconds: 25 * 60 });

    // 续期外部 Bot 与人类网页会话在场状态（模拟正常心跳/页面重连）
    await botClientB.enterWorld();
    const humanReEnter = await webJson(harness.baseUrl, '/city/api/enter', {
      body: {},
      sessionHeader: sessionPair,
      csrfHeader: csrfVal,
      clientId: 'web-human-1',
    });
    assert.equal(humanReEnter.status, 200);

    const pubView = await webJson(harness.baseUrl, '/city/api/public');
    assert.equal(pubView.status, 200);
    const pubStr = JSON.stringify(pubView.body);
    assert.equal(pubStr.includes('ai-house:entrance'), false, '隐藏交接点绝不可泄漏到公开视图');

    const botViewHere = await botClientB.view();
    assert.equal(botViewHere.here?.place.id, 'ikebukuro:kissa-tomoshibi');
    const peopleIds = (botViewHere.here?.people ?? []).map((p) => p.id);
    const peopleNames = (botViewHere.here?.people ?? []).map((p) => p.name);
    assert.equal(peopleIds.length, 2, `本人之外应看到妮娅与小灯两人同场，实得：${JSON.stringify(botViewHere.here?.people)}`);
    assert.ok(peopleIds.includes(humanResidentId));
    assert.ok(peopleNames.includes('妮娅'));
    checkpoints.phase3_mid_transit_engine_restart = 'PASS';

    // ── Phase 4: 三方同场互动、具名带出物互赠、热饮即饮/清理、F9 未知订单与内核重启恢复 ──
    // 预设妮娅收到抵达唤醒（第1轮 <=4 动作）与听到聊天唤醒（第2轮 <=4 动作）的自主行动
    await pyKernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'say', text: '下午好呀，这包从家里带来的曲奇分给你尝尝！' },
        { type: 'buy', sku: 'coffee', qty: 1 },
        { type: 'consume', item: 'coffee', qty: 1 },
      ],
    });
    await pyKernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'buy', sku: 'coffee_beans', qty: 1 },
        { type: 'give', to: botResidentId, item: 'cookie', qty: 1 },
      ],
    });

    await botClientB.say('下午好妮娅，很高兴在池袋遇见你和小灯！');
    const humanSay = await webJson(harness.baseUrl, '/city/api/act', {
      body: { request_id: 'web-human-say-0001', action: { type: 'say', text: '你们好呀，这里的咖啡好香！' } },
      sessionHeader: sessionPair,
      csrfHeader: csrfVal,
      clientId: 'web-human-1',
    });
    assert.equal(humanSay.status, 200);

    // 拉取 outbox：消费 walk_15m + 唤醒妮娅执行上述 5 个动作 + 消费 drink_coffee 身体效果 + encounter
    const poll1 = await pyKernel.call({ op: 'poll_outbox' });
    assert.equal(poll1.ok, true, JSON.stringify(poll1));
    // 再拉一次以消费双方互聊产生的 encounter
    await pyKernel.call({ op: 'poll_outbox' });

    // 核验旅人一号收到了妮娅从家里带出的具名曲奇（instance = true，保留原 item_id）
    const botAfterGift = await botClientB.view();
    const giftedCookie = botAfterGift.items.find((i) => i.type === 'cookie');
    assert.ok(giftedCookie, '外部 Bot 应收到妮娅赠送的家庭曲奇');
    assert.equal(giftedCookie!.instance, true, '家庭带出物转赠后必须保持具名实例 instance=true');

    // 人类玩家在书店或现场购买芝士蛋糕，旅人一号去书店买明信片回来送给妮娅（验证未映射礼物返家进 locker）
    const humanBuyCake = await webJson(harness.baseUrl, '/city/api/act', {
      body: { request_id: 'web-human-buy-cake-1', action: { type: 'buy', sku: 'cheesecake', qty: 1 } },
      sessionHeader: sessionPair,
      csrfHeader: csrfVal,
      clientId: 'web-human-1',
    });
    assert.equal(humanBuyCake.status, 200);

    await botClientB.travel('ikebukuro:shiorido');
    harness.advance(15 * 60_000);
    await pyKernel.call({ op: 'advance', seconds: 15 * 60 });
    await botClientB.enterWorld();
    await botClientB.buy('postcard', 1);
    await botClientB.travel('ikebukuro:kissa-tomoshibi');
    harness.advance(15 * 60_000);
    await pyKernel.call({ op: 'advance', seconds: 15 * 60 });
    await botClientB.enterWorld();

    const niaPerson = ((await botClientB.view()).here?.people ?? []).find((p) => p.name === '妮娅');
    assert.ok(niaPerson, '妮娅仍在喫茶「灯」');

    // 注入 F9：royal milk_tea 购买结果未知（锁 ¥500 进 pending）；再买一杯 coffee 不喝（测 carry_home:false -> disposed），然后回家
    harness.faults.purchaseUnknown = 'milk_tea';
    await pyKernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'buy', sku: 'milk_tea', qty: 1 },
        { type: 'buy', sku: 'coffee', qty: 1 },
        { type: 'go_home' },
      ],
    });
    // 旅人一号赠送明信片给妮娅 -> 触发 gift_received decision_wake！
    await botClientB.give(niaPerson!.id, 'postcard', 1);

    // 在妮娅行动前模拟一次 Python world-kernel 重启恢复！
    const kr1 = await pyKernel.call({ op: 'restart_kernel', downtime_s: 10, bridge_url: harness.bridgeUrl });
    assert.equal(kr1.ok, true, JSON.stringify(kr1));
    const poll2 = await pyKernel.call({ op: 'poll_outbox' });
    assert.equal(poll2.ok, true, JSON.stringify(poll2));
    harness.faults.purchaseUnknown = false;
    checkpoints.phase4_interaction_gift_and_kernel_restart = 'PASS';

    // ── Phase 5: 返家结算 T3 + 关单后 pending 订单退款平账 + 纯储物柜访问正常 closed 验证 ──
    harness.advance(35 * 60_000);
    await pyKernel.call({ op: 'advance', seconds: 35 * 60 });
    const pollSettle = await pyKernel.call({ op: 'poll_outbox' });
    assert.equal(pollSettle.ok, true, JSON.stringify(pollSettle));
    await pyKernel.call({ op: 'advance', seconds: 60 }); // 完成 away -> living 归家步行

    const inspReconcile = await pyKernel.call({ op: 'inspect', actor_id: 'nia', visit_id: 'vis_e2e_1' });
    assert.equal(inspReconcile.visit.state, 'reconcile', '含未决 pending 订单时应进入 reconcile');
    assert.equal(inspReconcile.actor.location, 'living');
    assert.equal(inspReconcile.authority.domain, 'home');
    assert.equal(inspReconcile.authority.domain_epoch, 2);

    // 通过管理员接口将未决 milk_tea 订单裁定为 failed -> 自动写 order_refunded outbox 补回 ¥500 并收口 closed
    const pendingRow = harness.city.db.get<{ order_id: string }>(
      "SELECT order_id FROM orders WHERE visit_id = 'vis_e2e_1' AND status = 'pending'",
    );
    assert.ok(pendingRow, '应存在一笔未决 milk_tea 订单');
    const adminResolve = await webJson(harness.baseUrl, `/city/api/admin/orders/${pendingRow!.order_id}/resolve`, {
      body: { outcome: 'failed' },
      authBearer: 'test_only_admin_key_city_isolated_0001',
    });
    assert.equal(adminResolve.status, 200, JSON.stringify(adminResolve.body));

    await pyKernel.call({ op: 'poll_outbox' });
    const inspClosed1 = await pyKernel.call({ op: 'inspect', actor_id: 'nia', visit_id: 'vis_e2e_1', reconcile: true });
    assert.equal(inspClosed1.visit.state, 'closed', '未决订单全清后 reconcile 必须收口为 closed');

    // 精确核对账实（¥1 都不差）：
    // 初始 ¥40,000；支出：去程电车 ¥200 + 第1杯咖啡 ¥450 + 咖啡豆 ¥900 + 第2杯未喝完咖啡(disposed) ¥450 + 回程电车 ¥200 = ¥2,200（未决奶茶 ¥500 已全额退回）
    assert.equal(inspClosed1.wallet_balance, 40_000 - 2_200);
    assert.equal(inspClosed1.wallet_available, 40_000 - 2_200);
    const cookieStock = inspClosed1.resources.find((r: any) => r.resource_id === 'nia_cookie_1');
    assert.equal(cookieStock.qty, 1, '赠送给外部 Bot 的家庭曲奇必须从 2 扣减为 1');
    assert.equal(cookieStock.free_qty, 1);
    const broughtBeans = inspClosed1.resources.find((r: any) => String(r.resource_id).startsWith('city:vis_e2e_1:'));
    assert.ok(broughtBeans, '城里买的 coffee_beans 必须映射入库家庭厨房');
    assert.equal(broughtBeans.item, 'coffee');
    assert.equal(broughtBeans.qty, 1);
    const lockerSummary = JSON.parse(inspClosed1.carry.locker_items);
    assert.equal(lockerSummary.length, 1);
    assert.equal(lockerSummary[0].type, 'postcard', '受赠明信片应转入妮娅的城市储物柜');

    // 再跑一趟无 pending、仅带储物柜物品的短途访问 vis_e2e_2，验证 locker 正常流转直接进 closed！
    const dep2 = await pyKernel.call({
      op: 'depart',
      actor_id: 'nia',
      destination: 'ikebukuro:shiorido',
      carry_yen: 5000,
      visit_id: 'vis_e2e_2',
    });
    assert.equal(dep2.ok, true);
    await pyKernel.call({ op: 'advance', seconds: 60 });
    harness.advance(60_000);
    await pyKernel.call({ op: 'handover', visit_id: 'vis_e2e_2' });
    await pyKernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'buy', sku: 'paperback', qty: 1 },
        { type: 'go_home' },
      ],
    });
    harness.advance(32 * 60_000);
    await pyKernel.call({ op: 'advance', seconds: 32 * 60 });
    await pyKernel.call({ op: 'poll_outbox' });
    harness.advance(35 * 60_000);
    await pyKernel.call({ op: 'advance', seconds: 35 * 60 });
    await pyKernel.call({ op: 'poll_outbox' });
    await pyKernel.call({ op: 'advance', seconds: 60 });

    const inspClosed2 = await pyKernel.call({ op: 'inspect', actor_id: 'nia', visit_id: 'vis_e2e_2', reconcile: true });
    assert.equal(inspClosed2.visit.state, 'closed', '仅有 locker 寄存且无 pending 时必须直接正常进入 closed');
    assert.equal(inspClosed2.authority.domain_epoch, 4);
    const lockerSummary2 = JSON.parse(inspClosed2.carry.locker_items);
    assert.equal(lockerSummary2.length, 1);
    assert.equal(lockerSummary2[0].type, 'paperback');
    assert.equal(inspClosed2.wallet_balance, 40_000 - 2_200 - 1_200);
    checkpoints.phase5_settlement_refund_and_locker_closed = 'PASS';

    // ── Phase 6: 外部 Bot 与人类礼貌离场 + 最终双库零和对账断言 ──
    await botClientB.leaveWorld();
    const humanLogout = await webJson(harness.baseUrl, '/city/api/auth/logout', {
      body: {},
      sessionHeader: sessionPair,
      csrfHeader: csrfVal,
    });
    assert.equal(humanLogout.status, 200);

    const imbalance = ledgerImbalance(harness.city);
    const engRec = runReconcile(harness.city, 'm1_e2e_final');
    const kerRec = inspClosed2.reconcile;

    assert.equal(imbalance, 0, `引擎复式账本必须严格平衡，实得 imbalance=${imbalance}`);
    assert.equal(engRec.ok, true, `引擎对账必须 ok=true（含外部 Bot 持有 origin_ref 曲奇），findings=${JSON.stringify(engRec.findings)}`);
    assert.equal(engRec.findings.length, 0, `不应有任何异常告警，实得：${JSON.stringify(engRec.findings)}`);
    assert.equal(kerRec.ok, true, `内核跨库对账必须 ok=true，findings=${JSON.stringify(kerRec.findings)}`);
    assert.equal(kerRec.engine_reconcile_ok, true);
    checkpoints.phase6_cross_db_zero_sum_reconcile = 'PASS';

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: 'city-m1-three-party-fault-e2e',
          checkpoints,
          assertions: {
            engine_ledger_imbalance: imbalance,
            engine_reconcile_ok: engRec.ok,
            engine_findings_count: engRec.findings.length,
            kernel_reconcile_ok: kerRec.ok,
            nia_final_home_yen: inspClosed2.wallet_balance,
            nia_domain_epoch: inspClosed2.authority.domain_epoch,
            nia_cookie_remaining: cookieStock.qty,
            bot_received_instance_cookie: Boolean(giftedCookie?.instance),
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (botClientA) await botClientA.close().catch(() => undefined);
    if (botClientB) await botClientB.close().catch(() => undefined);
    if (refereeMcp) await refereeMcp.close().catch(() => undefined);
    if (houseQqClient) await houseQqClient.close().catch(() => undefined);
    await pyKernel.stop().catch(() => undefined);
    await harness.close({ cleanup: true });
  }
}

main().catch((err) => {
  process.stderr.write(`city-m1-e2e FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
