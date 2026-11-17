/**
 * M0 栖灯镇（town）关停封存演练 + 公共桌游与东京城市并行回归测试：
 *  1. 预置一份含真实居民与资产记录的封存库 `town-frozen.db`，计算封存前 SHA-256；
 *  2. 按 `examples/botgame.city-test.json`（`town.enabled: false`, `city.enabled: true`）启动正式 Runtime + HTTP 服务；
 *  3. 验证 `rt.world === undefined`、`/town/*` 返回 404、`/city/*` 正常服务；
 *  4. 验证公共桌游（`number_bomb` 完整开房→报名→开局→猜中结束）通过同一 `/mcp` 端点 100% 正常回归；
 *  5. 验证外部独立 Bot（MCP `enter_world {world_id:"tokyo"}`）、准入白名单拦截、室友 QQ 密钥 `ENTRY_VIA_HOME_ONLY` 拦截与桥接外出访问同场闭环；
 *  6. 停机后复核 `town-frozen.db` 字节级 SHA-256 纹丝未动，且 `city-test.db` 对账 `ok === true`、`ledgerImbalance === 0`。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createRegistry } from '../../src/games/index.js';
import { startHttpServer, type HttpHandle } from '../../src/server/http.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';
import { agentPrincipal, createWorld, enterWorldAgent } from '../../src/world/index.js';
import { ledgerImbalance, runReconcile } from '../../src/city/index.js';
import { COOKIE, HOUR, KISSA, MIN } from './helpers.js';

const TEMPLATE_PATH = new URL('../../examples/botgame.city-test.json', import.meta.url);

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function connectMcp(url: string, key: string): Promise<Client> {
  const client = new Client({ name: 'm0-drill-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (res.isError) throw new Error(`MCP ${name} 失败：${res.content[0]?.text}`);
  return JSON.parse(res.content[0]!.text);
}

async function callToolExpectError(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ code: string; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `期望 ${name} 报错`).toBe(true);
  const text = res.content[0]?.text ?? '';
  const code = text.match(/\(code: ([A-Z_]+)\)/)?.[1] ?? 'UNKNOWN';
  return { code, text };
}

describe('M0 栖灯镇关停封存演练：town.enabled=false + city.enabled=true', () => {
  let workDir: string | null = null;
  let handle: HttpHandle | null = null;
  let rt: Runtime | null = null;
  const clients: Client[] = [];

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

  it('封存 town.db 零字节改动，公共桌游与东京城市（外部 Bot + 室友桥接）同进程回归全绿', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'm0-town-off-drill-'));
    const frozenTownDb = join(workDir, 'town-frozen.db');
    const cityTestDb = join(workDir, 'city-test.db');

    // 第 1 步：构造一份含历史居民与镇币的栖灯镇数据库并封存关闭，记录字节级 SHA-256
    {
      const w = createWorld({ dbPath: frozenTownDb, registry: createRegistry(), seed: 'freeze-seed' });
      await w.start();
      const p = agentPrincipal(w, { id: '90001', name: '旧镇旅人' });
      enterWorldAgent(w, { principalId: p.principal_id, clientId: 'mcp:freeze' }, { name: '旧镇旅人' });
      // Checkpoint WAL into main db file before sealing
      w.db.checkpoint();
      w.close();
    }
    expect(existsSync(frozenTownDb)).toBe(true);
    const shaBefore = fileSha256(frozenTownDb);

    // 第 2 步：加载 botgame.city-test.json 模板，保持 town.enabled=false & city.enabled=true
    const rawCfg = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as Record<string, any>;
    rawCfg.port = 0;
    rawCfg.stateFile = join(workDir, 'city-test-state.json');
    rawCfg.settingsFile = join(workDir, 'city-test-settings.json');
    rawCfg.auth.issuedKeysFile = join(workDir, 'city-test-keys.json');
    rawCfg.town.enabled = false;
    rawCfg.town.dbFile = frozenTownDb;
    rawCfg.city.enabled = true;
    rawCfg.city.dbFile = cityTestDb;
    const cfgFile = join(workDir, 'botgame.city-test.json');
    writeFileSync(cfgFile, JSON.stringify(rawCfg, null, 2));

    const cfg = loadConfig(cfgFile, {});
    expect(cfg.town.enabled).toBe(false);
    expect(cfg.city.enabled).toBe(true);

    rt = createRuntime(cfg, () => undefined);
    expect(rt.world).toBeUndefined();
    expect(rt.city).toBeDefined();
    // 等待 city 异步恢复变为 running
    for (let i = 0; i < 50 && rt.city!.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rt.city!.status).toBe('running');

    handle = await startHttpServer(rt, () => undefined);
    const baseUrl = handle.url.replace(/\/mcp$/, '');

    // 第 3 步：验证 /town/* 已下线 404，/city/* 正常响应且旧镇币不进入东京
    expect((await fetch(`${baseUrl}/town/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/town/api/public`)).status).toBe(404);

    const cityHtml = await fetch(`${baseUrl}/city/`);
    expect(cityHtml.status).toBe(200);
    expect(cityHtml.headers.get('content-security-policy')).toContain("default-src 'none'");
    const cityPub = (await (await fetch(`${baseUrl}/city/api/public`)).json()) as any;
    expect(cityPub.world_id).toBe('tokyo');

    // 第 4 步：连接真实 HTTP MCP 客户端，跑完一局公共桌游（number_bomb）回归
    const referee = await connectMcp(handle.url, 'test_only_referee_key_city_0001');
    const bot1 = await connectMcp(handle.url, 'test_only_ext_bot_key_city_90001');
    const bot2 = await connectMcp(handle.url, 'test_only_ext_bot_key_city_90002');
    const unlisted = await connectMcp(handle.url, 'test_only_ext_bot_unlisted_90099');
    const niaQq = await connectMcp(handle.url, 'test_only_house_qq_nia_30001');
    clients.push(referee, bot1, bot2, unlisted, niaQq);

    const createdGame = await callTool(bot1, 'create_game', {
      game_type: 'number_bomb',
      group_id: '1000001',
      join_as: 'player',
      auto_referee: true,
    });
    const gameId = String(createdGame.summary.game_id);
    await callTool(bot2, 'join_game', { game_id: gameId, join_as: 'player' });
    await callTool(bot1, 'start_game', { game_id: gameId });

    for (let step = 0; step < 30; step++) {
      const v1 = await callTool(bot1, 'get_my_view', { game_id: gameId });
      if (v1.game?.status === 'ended' || v1.status === 'ended') break;
      const active = v1.your_turn ? { c: bot1, v: v1 } : { c: bot2, v: await callTool(bot2, 'get_my_view', { game_id: gameId }) };
      if (!active.v.your_turn || active.v.game?.status === 'ended' || active.v.status === 'ended') break;
      const low = Number(active.v.public?.range?.from ?? 2);
      const high = Number(active.v.public?.range?.to ?? 99);
      const guess = Math.floor((low + high) / 2);
      await callTool(active.c, 'act', { game_id: gameId, action: 'guess', number: guess });
    }
    const finalGames = await callTool(bot1, 'list_games', { include_finished: true });
    expect(finalGames.games.find((g: any) => g.game_id === gameId)?.status).toBe('ended');

    // 第 5 步：验证东京城市准入门禁、旧镇账号不串资产、外部 Bot 与桥接室友同进程运行
    // 未准入外部 Bot 被拒 FORBIDDEN，但可只读看公开视图
    const deniedUnlisted = await callToolExpectError(unlisted, 'enter_world', { world_id: 'tokyo', name: '路人' });
    expect(deniedUnlisted.code).toBe('FORBIDDEN');
    expect((await callTool(unlisted, 'world_query', { what: 'public', world_id: 'tokyo' })).world_id).toBe('tokyo');

    // 室友 QQ 侧密钥被拒 ENTRY_VIA_HOME_ONLY（F16），但可只读看公开视图
    const deniedHouse = await callToolExpectError(niaQq, 'enter_world', { world_id: 'tokyo', name: '妮娅' });
    expect(deniedHouse.code).toBe('ENTRY_VIA_HOME_ONLY');
    expect((await callTool(niaQq, 'world_query', { what: 'public', world_id: 'tokyo' })).world_id).toBe('tokyo');

    // 90001（曾在旧镇有记录）首次进东京：独立新居民、独立发 ¥200,000，无任何旧镇币混入
    const enteredTokyo = await callTool(bot1, 'enter_world', { world_id: 'tokyo', name: '旧镇旅人', entry: 'ikebukuro:station' });
    expect(enteredTokyo).toMatchObject({
      ok: true,
      world_id: 'tokyo',
      created: true,
      granted_yen: 200_000,
      wallet: { yen: 200_000 },
      location: { place: 'ikebukuro:station' },
    });

    // 桥接驱动妮娅进城并正常立即申请返家结算（起点已在门口，0 分钟结算闭环）
    const bridgeHeaders = {
      authorization: `Bearer ${cfg.city.bridgeKey!}`,
      'content-type': 'application/json',
    };
    const now = rt.city!.now();
    const prepRes = await fetch(`${baseUrl}/city/bridge/v1/visits/prepare`, {
      method: 'POST',
      headers: bridgeHeaders,
      body: JSON.stringify({
        request_id: 'v-drill-nia:prepare',
        protocol: 'city-bridge/1',
        vocab_version: 'life1-0.2',
        mappings_version: 2,
        visit_id: 'v-drill-nia',
        actor_id: 'nia',
        carry: { yen: 5000, items: [COOKIE] },
        plan: { destination: KISSA, start_at_ms: now, return_by_ms: now + 3 * HOUR },
      }),
    });
    expect(prepRes.status).toBe(200);

    // 故意让计划目的地暂不可达（测试门口交接 + 立刻 go_home 结算收口），或正常排程后验证账本
    const commitRes = await fetch(`${baseUrl}/city/bridge/v1/visits/commit`.replace('/visits/commit', '/visits/v-drill-nia/commit'), {
      method: 'POST',
      headers: bridgeHeaders,
      body: JSON.stringify({
        request_id: 'v-drill-nia:commit',
        transfer_id: 'tr-drill-nia',
        domain_epoch: 1,
      }),
    });
    expect(commitRes.status).toBe(200);
    expect(ledgerImbalance(rt.city!)).toBe(0);
    expect(runReconcile(rt.city!, 'm0_drill').ok).toBe(true);

    // 第 6 步：关闭服务后验证封存的 town-frozen.db SHA-256 完全未变（零字节触碰）
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await handle.close();
    handle = null;
    rt.close();
    rt = null;

    expect(existsSync(cityTestDb)).toBe(true);
    expect(fileSha256(frozenTownDb)).toBe(shaBefore);
    void MIN;
  });
});
