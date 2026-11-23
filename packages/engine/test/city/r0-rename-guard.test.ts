/**
 * 晴空都 R0 全量改名与暂卸内容包专项回归守卫（#277）。
 *
 * 覆盖门禁：
 *  1. 目录、公开 HTML/网页资产、原始公开 JSON、MCP 指南/提示词/工具说明、外部 bot 视图及桥接 L3 JSON
 *     对 docs/city/rename-r0.json 中全部 57 项旧名/旧编号大小写不敏感零命中（桥接 /catalog 仅 handover_node 合法为 hiyorizaka:ai-house:entrance）；
 *  2. world_id: "tokyo" 在仅开城市与城市+栖灯镇同开两种配置下均返回 NOT_FOUND；
 *  3. 隐藏交接点（新/旧）与暂卸包地点对外部 bot travel 的报错码、原因与文案同不存在的乱写地点逐字一致；
 *  4. 非 JST 宿主机时区（TZ=UTC 子进程）下 city/app.js fmtClock 的 Intl 正常路径与异常算术回退路径均输出东京时间；
 *  5. 暂卸内容包（jinbocho / shimokitazawa）留仓不删、脱离挂载与编译产物，维持 3 片区 / 18 公开地点（含桌游茶屋）/ 3 车站印章。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { mountCity } from '../../src/city/http.js';
import {
  AREAS,
  CITY_CATALOG_VERSION,
  CITY_TEXT_VERSION,
  CITY_WORLD_ID,
  CITY_WORLD_NAME,
  CityError,
  FARE_RULE_VERSION,
  HOUSE_ENTRANCE,
  ITEM_TYPES,
  MOUNTED_CONTENT_PACKS,
  NEIGHBORHOODS,
  SOURCES,
  STATION_STAMPS,
  STATIONS,
  TRANSIT_EDGES,
  WARDS,
  cityCommand,
  place,
  planRoute,
  publicPlaces,
} from '../../src/city/index.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeTown } from '../world/helpers.js';
import { KISSA, MIN, makeCity, type CityTest } from './helpers.js';

const RENAME_R0_PATH = fileURLToPath(new URL('../../../../docs/city/rename-r0.json', import.meta.url));
const AGENT_KIT_PROMPT_PATH = fileURLToPath(new URL('../../../agent-kit/prompts/city-resident-zh.md', import.meta.url));
const CITY_WEB_DIR = fileURLToPath(new URL('../../city', import.meta.url));
const ENGINE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const RENAME_R0 = JSON.parse(readFileSync(RENAME_R0_PATH, 'utf8')) as {
  forbidden_legacy_tokens_in_public_and_views: string[];
};
// 晴空都 R1（主人 2026-11-20 定名）：R0 时的显示名（灯都、绯渡……）也不许再出现在公开页面和 bot 视图里。
const RENAME_R1_PATH = fileURLToPath(new URL('../../../../docs/city/rename-r1.json', import.meta.url));
const RENAME_R1 = JSON.parse(readFileSync(RENAME_R1_PATH, 'utf8')) as {
  forbidden_legacy_tokens_in_public_and_views: string[];
};
const R0_TOKENS = RENAME_R0.forbidden_legacy_tokens_in_public_and_views;
const R1_TOKENS = RENAME_R1.forbidden_legacy_tokens_in_public_and_views;
const FORBIDDEN_TOKENS = [...R0_TOKENS, ...R1_TOKENS];

const BRIDGE_KEY = 'bridge-key-r0-guard-0123456789';
const PROBE_AGENT: Identity = { id: '7101', name: '探针旅人' };
const AGENTS = [{ key: 'key-probe', id: PROBE_AGENT.id, name: PROBE_AGENT.name }];

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

function findLegacyTokenHits(raw: string, tokens: readonly string[] = FORBIDDEN_TOKENS): string[] {
  const lower = raw.toLowerCase();
  return tokens.filter((tok) => lower.includes(tok.toLowerCase()));
}

function expectZeroLegacyTokens(label: string, payload: unknown): void {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hits = findLegacyTokenHits(raw);
  expect(hits, `${label} 命中禁用旧词/隐藏编号: ${hits.join(', ')}`).toEqual([]);
}

async function serveHttp(t: CityTest): Promise<{ base: string }> {
  const app = express();
  mountCity(app, t.c, () => undefined, { bridgeKey: BRIDGE_KEY });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function makeMcpEnv(opts: { town?: boolean } = {}): {
  t: CityTest;
  connect: (who?: Identity) => Promise<Client>;
} {
  const t = makeCity({ seed: 'r0-guard-city-seed' });
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('r0-guard-mgr-seed') });
  const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: AGENTS }, manager);
  const town = opts.town ? makeTown() : null;
  const deps = {
    manager,
    auth,
    version: 'test',
    city: { city: t.c },
    ...(town ? { town: { world: town.w, auth, trustedIds: [] } } : {}),
  };
  const connect = async (who: Identity = PROBE_AGENT) => {
    const ctx: SessionContext = { identity: who, fixed: true, transport: 'memory' };
    const server = createMcpServer(deps, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'r0-guard-client', version: '1.0.0' });
    await server.connect(b);
    await client.connect(a);
    return client;
  };
  return { t, connect };
}

async function callRaw(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; json: any }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `${name} 意外失败：${res.content[0]?.text}`).toBeFalsy();
  const text = res.content.map((c) => c.text).join('\n');
  return { text, json: JSON.parse(res.content[0]!.text) };
}

async function callFail(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; reason: string | null; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(res.isError, `${name} 预期失败但成功：${res.content[0]?.text}`).toBe(true);
  const text = res.content[0]!.text;
  return {
    code: text.match(/\(code: ([A-Z_]+)\)/)?.[1] ?? 'INTERNAL',
    reason: text.match(/"reason":"([^"]+)"/)?.[1] ?? null,
    text,
  };
}

describe('晴空都 R0 全量改名与暂卸内容包专项守卫', () => {
  it('门禁 1a：目录导出与公开网页静态资源对 57 项旧词/旧编号零命中', async () => {
    expect(R0_TOKENS).toHaveLength(57);
    expect(R1_TOKENS).toEqual([
      '灯都', '绯渡', '镜池', '千灯', '澪川', '灯环线',
      'hiwatari', 'kagamiike', 'sentou', 'toukan', 'hiyorizaka:mio',
    ]);

    expectZeroLegacyTokens('catalog 导出面', {
      CITY_WORLD_ID,
      CITY_WORLD_NAME,
      CITY_CATALOG_VERSION,
      CITY_TEXT_VERSION,
      FARE_RULE_VERSION,
      AREAS,
      WARDS,
      NEIGHBORHOODS,
      STATIONS,
      TRANSIT_EDGES,
      ITEM_TYPES,
      STATION_STAMPS,
      SOURCES,
      publicPlaces: publicPlaces(),
    });

    for (const a of AREAS) {
      expect('prototype' in (a as unknown as Record<string, unknown>)).toBe(false);
    }

    for (const rel of ['index.html', 'app.js', 'style.css', 'icon.svg']) {
      const content = readFileSync(`${CITY_WEB_DIR}/${rel}`, 'utf8');
      expectZeroLegacyTokens(`city/${rel} 磁盘源码`, content);
    }

    const t = makeCity({ seed: 'r0-guard-http-seed' });
    t.bot('探针住客', { entry: 'kumominato:station' });
    const k = t.kernel('nia');
    k.depart({ yen: 5_000, to: 'hiyorizaka:ekimae-plaza' });
    const { base } = await serveHttp(t);

    for (const path of ['/city/', '/city/play/', '/city/play/app.js', '/city/play/style.css', '/city/play/icon.svg']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, `GET ${path}`).toBe(200);
      const text = await res.text();
      expectZeroLegacyTokens(`HTTP GET ${path}`, text);
    }

    const pubRes = await fetch(`${base}/city/api/public`);
    expect(pubRes.status).toBe(200);
    const pubRaw = await pubRes.text();
    expectZeroLegacyTokens('GET /city/api/public 原始 JSON', pubRaw);
    expect(JSON.parse(pubRaw)).toMatchObject({
      world_id: 'city',
      name: '晴空都',
      timezone: 'JST',
      city_catalog_version: 'toto-p3.0',
      city_text_version: 'toto-text-1.1',
    });

    const cfgRes = await fetch(`${base}/city/api/config`);
    expect(cfgRes.status).toBe(200);
    const cfgRaw = await cfgRes.text();
    expectZeroLegacyTokens('GET /city/api/config 原始 JSON', cfgRaw);
    expect(JSON.parse(cfgRaw)).toMatchObject({
      world: { id: 'city', name: '晴空都', timezone: 'JST' },
    });

    const routeRes = await fetch(`${base}/city/api/route?from=hiyorizaka:station&to=kumominato:station`);
    expect(routeRes.status).toBe(200);
    const routeRaw = await routeRes.text();
    expectZeroLegacyTokens('GET /city/api/route 原始 JSON', routeRaw);

    const catRes = await fetch(`${base}/city/bridge/v1/catalog`, {
      headers: { authorization: `Bearer ${BRIDGE_KEY}` },
    });
    expect(catRes.status).toBe(200);
    const catBody = (await catRes.json()) as Record<string, unknown>;
    expect(catBody).toMatchObject({
      protocol: 'city-bridge/1',
      city_catalog_version: 'toto-p3.0',
      city_text_version: 'toto-text-1.1',
      handover_node: 'hiyorizaka:ai-house:entrance',
    });
    expectZeroLegacyTokens('GET /city/bridge/v1/catalog（除合法 handover_node 外）', {
      ...catBody,
      handover_node: '',
    });

    const wxRes = await fetch(`${base}/city/bridge/v1/weather`, {
      headers: { authorization: `Bearer ${BRIDGE_KEY}` },
    });
    expect(wxRes.status).toBe(200);
    expectZeroLegacyTokens('GET /city/bridge/v1/weather 原始 JSON', await wxRes.text());
  });

  it('门禁 1b：MCP 指南/提示词/工具说明与外部 bot 全链路视图对 57 项旧词零命中', async () => {
    expectZeroLegacyTokens('agent-kit prompts/city-resident-zh.md', readFileSync(AGENT_KIT_PROMPT_PATH, 'utf8'));

    for (const withTown of [false, true]) {
      const { t, connect } = makeMcpEnv({ town: withTown });
      const client = await connect();

      const tools = await client.listTools();
      expectZeroLegacyTokens(`MCP listTools (town=${withTown})`, tools);

      const guide = await client.readResource({ uri: 'botgame://guide/city' });
      expectZeroLegacyTokens(`MCP botgame://guide/city (town=${withTown})`, guide);

      const overview = await client.readResource({ uri: 'botgame://guide/overview' });
      expectZeroLegacyTokens(`MCP botgame://guide/overview (town=${withTown})`, overview);

      const prompt = await client.getPrompt({ name: 'city-resident' });
      expectZeroLegacyTokens(`MCP prompt city-resident (town=${withTown})`, prompt);

      const qPublic = await callRaw(client, 'world_query', { world_id: 'city', what: 'public' });
      expectZeroLegacyTokens(`MCP world_query public (town=${withTown})`, qPublic.text);
      expect(qPublic.json.timezone).toBe('JST');

      const qRoute = await callRaw(client, 'world_query', {
        world_id: 'city',
        what: 'route',
        from: 'hiyorizaka:station',
        to: 'kumominato:station',
      });
      expectZeroLegacyTokens(`MCP world_query route (town=${withTown})`, qRoute.text);

      const entered = await callRaw(client, 'enter_world', {
        world_id: 'city',
        name: '探针旅人',
        entry: 'kumominato:station',
      });
      expectZeroLegacyTokens(`MCP enter_world (town=${withTown})`, entered.text);

      const v0 = await callRaw(client, 'get_my_view');
      expectZeroLegacyTokens(`MCP get_my_view 站内 (town=${withTown})`, v0.text);

      const stamped = await callRaw(client, 'world_act', {
        request_id: `r0-stamp-${withTown ? 't' : 'c'}-001`,
        action_window: 'city',
        context_version: 0,
        action: { type: 'stamp_station' },
      });
      expectZeroLegacyTokens(`MCP stamp_station (town=${withTown})`, stamped.text);

      const qStamps = await callRaw(client, 'world_query', { world_id: 'city', what: 'stamps' });
      expectZeroLegacyTokens(`MCP world_query stamps (town=${withTown})`, qStamps.text);

      const travel = await callRaw(client, 'world_act', {
        request_id: `r0-travel-${withTown ? 't' : 'c'}-001`,
        action_window: 'city',
        context_version: 0,
        action: { type: 'travel', to: KISSA },
      });
      expectZeroLegacyTokens(`MCP travel 受理 (town=${withTown})`, travel.text);

      const inTransit = await callRaw(client, 'get_my_view');
      expectZeroLegacyTokens(`MCP get_my_view 乘车途中 (town=${withTown})`, inTransit.text);

      const waiting = callRaw(client, 'world_wait', { cursor: inTransit.json.cursor, wait_seconds: 5 });
      await new Promise((r) => setTimeout(r, 25));
      t.run(20 * MIN);
      const woke = await waiting;
      expectZeroLegacyTokens(`MCP world_wait 到站事件 (town=${withTown})`, woke.text);

      const vArrived = await callRaw(client, 'get_my_view', { cursor: woke.json.cursor });
      expectZeroLegacyTokens(`MCP get_my_view 到站后 (town=${withTown})`, vArrived.text);

      const qResidents = await callRaw(client, 'world_query', { world_id: 'city', what: 'residents' });
      expectZeroLegacyTokens(`MCP world_query residents (town=${withTown})`, qResidents.text);
    }
  });

  it('门禁 2：world_id="tokyo"（含大小写变体）在仅开城市与双世界同开时均返回 NOT_FOUND', async () => {
    for (const withTown of [false, true]) {
      const { connect } = makeMcpEnv({ town: withTown });
      const client = await connect();
      for (const legacyId of ['tokyo', 'TOKYO', 'Tokyo']) {
        const enterErr = await callFail(client, 'enter_world', { world_id: legacyId, name: '旧客' });
        expect(enterErr.code, `enter_world(${legacyId}) town=${withTown}`).toBe('NOT_FOUND');
        expectZeroLegacyTokens(`enter_world(${legacyId}) 错误回包`, enterErr.text);

        const queryErr = await callFail(client, 'world_query', { world_id: legacyId, what: 'public' });
        expect(queryErr.code, `world_query(${legacyId}) town=${withTown}`).toBe('NOT_FOUND');
        expectZeroLegacyTokens(`world_query(${legacyId}) 错误回包`, queryErr.text);
      }
    }
  });

  it('门禁 3：隐藏门口与暂卸/旧版地点编号对外部 bot travel 的报错与乱写地名逐字完全一致', async () => {
    const { t, connect } = makeMcpEnv({ town: true });
    const client = await connect();
    const entered = await callRaw(client, 'enter_world', {
      world_id: 'city',
      name: '探针旅人',
      entry: 'kumominato:station',
    });
    const residentId = entered.json.resident_id as string;
    const clientId = t.c.mustResident(residentId).controller_id ?? undefined;

    const baselineMcp = await callFail(client, 'world_act', {
      request_id: 'r0-missing-baseline-001',
      action_window: 'city',
      context_version: 0,
      action: { type: 'travel', to: 'kumominato:no-such-place' },
    });
    expect(baselineMcp.code).toBe('NOT_FOUND');
    expect(baselineMcp.reason).toBe('no_such_place');

    let baselineDirect: { code: string; reason?: string; message: string } | null = null;
    try {
      cityCommand(t.c, residentId, 'r0-direct-baseline-001', { type: 'travel', to: 'kumominato:no-such-place' }, { clientId });
    } catch (e) {
      expect(e).toBeInstanceOf(CityError);
      const ce = e as CityError;
      baselineDirect = { code: ce.code, reason: ce.reason, message: ce.message };
    }
    expect(baselineDirect).toEqual({
      code: 'NOT_FOUND',
      reason: 'no_such_place',
      message: '没有这个地方。看视图里 here.exits 列出的地点编号。',
    });

    const hiddenOrLegacyTargets = [
      HOUSE_ENTRANCE,
      'hiyorizaka:ai-house:entrance',
      'akabane:ai-house:entrance',
      'jinbocho:station',
      'shimokitazawa:station',
      'ikebukuro:kissa-tomoshibi',
    ];

    let idx = 0;
    for (const target of hiddenOrLegacyTargets) {
      const mcpErr = await callFail(client, 'world_act', {
        request_id: `r0-missing-probe-${String(++idx).padStart(3, '0')}`,
        action_window: 'city',
        context_version: 0,
        action: { type: 'travel', to: target },
      });
      expect(mcpErr, `MCP travel(${target}) 应与乱写地名逐字一致`).toEqual(baselineMcp);
      expectZeroLegacyTokens(`MCP travel(${target}) 错误文案`, mcpErr.text);

      let directErr: { code: string; reason?: string; message: string } | null = null;
      try {
        cityCommand(
          t.c,
          residentId,
          `r0-direct-probe-${String(idx).padStart(3, '0')}`,
          { type: 'travel', to: target },
          { clientId },
        );
      } catch (e) {
        const ce = e as CityError;
        directErr = { code: ce.code, reason: ce.reason, message: ce.message };
      }
      expect(directErr, `CityError travel(${target}) 应与乱写地名逐字一致`).toEqual(baselineDirect);
    }
  });

  it('门禁 4：非 JST 设备时区（TZ=UTC 子进程）下 city/app.js fmtClock 正常路径与异常回退路径均输出东京时间', () => {
    const appJsPath = `${CITY_WEB_DIR}/app.js`;
    const appJs = readFileSync(appJsPath, 'utf8');
    expect(appJs).not.toContain('Asia/Tokyo');

    const fnMatch = appJs.match(/function fmtClock\([\s\S]*?\n\}/);
    expect(fnMatch, '未能在 city/app.js 中定位 function fmtClock').not.toBeNull();
    const fmtClockSrc = fnMatch![0];
    expect(fmtClockSrc).not.toContain('.getHours(');
    expect(fmtClockSrc).not.toContain('.getMinutes(');

    const childScript = `
      ${fmtClockSrc}
      const hostOffsetMin = new Date(Date.UTC(2026, 10, 19, 6, 5, 0)).getTimezoneOffset();
      const hostLocalHour = new Date(Date.UTC(2026, 10, 19, 6, 5, 0)).getHours();
      const tMorningUtc = Date.UTC(2026, 10, 19, 6, 5, 0);   // 15:05 JST
      const tCrossDayUtc = Date.UTC(2026, 10, 19, 15, 30, 0); // 次日 00:30 JST
      const tLateNightUtc = Date.UTC(2026, 10, 19, 14, 59, 0); // 23:59 JST

      const intlOut = {
        morning: fmtClock(tMorningUtc, 'JST'),
        crossDay: fmtClock(tCrossDayUtc, 'JST'),
        defaultArg: fmtClock(tLateNightUtc),
      };

      const OrigDateTimeFormat = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function () {
        throw new RangeError('Simulated unsupported offset timeZone');
      };
      const fallbackOut = {
        morning: fmtClock(tMorningUtc, 'JST'),
        crossDay: fmtClock(tCrossDayUtc, 'JST'),
        defaultArg: fmtClock(tLateNightUtc),
      };
      Intl.DateTimeFormat = OrigDateTimeFormat;

      process.stdout.write(JSON.stringify({ hostOffsetMin, hostLocalHour, intlOut, fallbackOut }));
    `;

    const stdout = execFileSync(process.execPath, ['-e', childScript], {
      env: { ...process.env, TZ: 'UTC' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout) as {
      hostOffsetMin: number;
      hostLocalHour: number;
      intlOut: { morning: string; crossDay: string; defaultArg: string };
      fallbackOut: { morning: string; crossDay: string; defaultArg: string };
    };

    expect(parsed.hostOffsetMin).toBe(0);
    expect(parsed.hostLocalHour).toBe(6);
    expect(parsed.intlOut).toEqual({
      morning: '15:05',
      crossDay: '00:30',
      defaultArg: '23:59',
    });
    expect(parsed.fallbackOut).toEqual({
      morning: '15:05',
      crossDay: '00:30',
      defaultArg: '23:59',
    });
  });

  it('门禁 5：暂卸内容包（jinbocho / shimokitazawa）回归：留仓不删、脱离挂载与编译产物', () => {
    expect(MOUNTED_CONTENT_PACKS).toEqual([]);
    expect(AREAS.map((a) => a.id)).toEqual(['hiyorizaka', 'ryokogai', 'kumominato']);
    expect(WARDS).toEqual([]);
    expect(publicPlaces()).toHaveLength(18);
    expect(STATION_STAMPS.map((s) => s.stampId)).toEqual(['stamp:hiyorizaka', 'stamp:ryokogai', 'stamp:kumominato']);

    expect(place('jinbocho:station')).toBeUndefined();
    expect(place('shimokitazawa:station')).toBeUndefined();
    expect(planRoute('kumominato:station', 'jinbocho:station')).toBeNull();
    expect(planRoute('kumominato:station', 'shimokitazawa:station')).toBeNull();

    // 原始源码按规范保留在仓内待 M4 迁移
    expect(existsSync(`${ENGINE_ROOT}/src/city/packs/jinbocho.ts`)).toBe(true);
    expect(existsSync(`${ENGINE_ROOT}/src/city/packs/shimokitazawa.ts`)).toBe(true);

    for (const cfgName of ['tsconfig.json', 'tsconfig.build.json']) {
      const cfg = JSON.parse(readFileSync(`${ENGINE_ROOT}/${cfgName}`, 'utf8')) as { exclude?: string[] };
      expect(cfg.exclude, `${cfgName} exclude`).toContain('src/city/packs/jinbocho.ts');
      expect(cfg.exclude, `${cfgName} exclude`).toContain('src/city/packs/shimokitazawa.ts');
    }

    const distPacksDir = `${ENGINE_ROOT}/dist/city/packs`;
    if (existsSync(distPacksDir)) {
      const builtFiles = readdirSync(distPacksDir);
      expect(builtFiles.filter((f) => f.includes('jinbocho') || f.includes('shimokitazawa'))).toEqual([]);
    }
  });
});
