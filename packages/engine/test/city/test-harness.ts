/**
 * 东京城市世界 · 隔离联调测试环境与确定性故障注入脚手架（M0）。
 *
 * 用途：
 *  1. 使用独立临时目录与独立测试库 `city-test.db`（绝不触碰线上或默认 `town.db` / `city.db`）；
 *  2. 注入可控确定性时钟 `FakeClock`，按到期顺序结算持久作业 `scheduled_jobs`；
 *  3. 在不侵入生产源码的前提下，于测试实例 HTTP 边界提供完整故障开关：
 *     - `bridge503Count`：桥接写请求返回 503 RECOVERING（测 F4/M1-A 原 request_id 退避重试）；
 *     - `delayMs`：注入网络响应延迟（测客户端超时重发）；
 *     - `dropResponseOnce`：让服务端真实提交事务后断开 socket 丢弃回包（真实复现 F4 回包丢失）；
 *     - `purchaseUnknown`：注入购买入账结果未知（复现 F9 未决订单与资金锁定）；
 *     - `setWeather` / `failWeather`：注入指定片区降雨或抓取失败（复现 F13 / F14）；
 *     - `restart(downtimeMs)`：关闭进程并基于同一 `city-test.db` 文件冷启动恢复（复现 F7 / F10）。
 *  4. 可选开启 `/__test/city/*` 本地控制面，供跨进程/跨语言（如 Python `world-kernel`）联调驱动。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, resolveAuth, type BotGameConfig } from '../../src/config.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { FileStateStore } from '../../src/core/store.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, extractKey, type SessionContext } from '../../src/mcp/auth.js';
import { cityPolicy } from '../../src/mcp/city.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { VERSION } from '../../src/version.js';
import { mountCity } from '../../src/city/http.js';
import {
  AREAS,
  applyWeather,
  createCity,
  ledgerImbalance,
  runReconcile,
  type CityService,
  type WeatherReading,
} from '../../src/city/index.js';
import { FakeClock } from '../helpers.js';

/** 默认起始时刻：2026-11-18 10:00 JST（各街区店铺均在营业时段内） */
export const CITY_TEST_T0 = Date.UTC(2026, 10, 18, 1, 0, 0);

const TEMPLATE_PATH = new URL('../../examples/botgame.city-test.json', import.meta.url);

export interface CityFaultState {
  /** 接下来多少次桥接写请求直接拦截返回 503 RECOVERING */
  bridge503Count: number;
  /** 桥接请求人为延迟毫秒数（测试客户端超时） */
  delayMs: number;
  /** 下一次桥接写请求在服务端真实提交事务后立即销毁连接、不发回包（复现 F4） */
  dropResponseOnce: boolean;
  /** 购买动作触发店家入账结果未知（复现 F9）：true = 全部触发，字符串 = 仅匹配该 sku 时触发 */
  purchaseUnknown: boolean | string;
}

export interface IsolatedCityHarnessOptions {
  /** 指定工作目录；不传则自动在系统临时目录创建独立目录 */
  workDir?: string;
  /** 指定 SQLite 文件路径；默认 `<workDir>/city-test.db` */
  dbPath?: string;
  /** 监听端口；默认 0（由内核分配空闲端口，杜绝端口冲突） */
  port?: number;
  /** 初始 UTC 毫秒时间戳；默认 2026-11-18 10:00 JST */
  at?: number;
  /** 固定随机种子 */
  seed?: string;
  /** 是否挂载 `/__test/city/*` 跨进程控制端点（默认 false，跨进程联调脚本传 true） */
  enableControlRoutes?: boolean;
  /** 覆盖 city.params */
  cityParams?: Record<string, unknown>;
  /** 覆盖 city 配置字段（如 publicUrl、devLogin、adminOnlyTickets） */
  cityOverrides?: Record<string, unknown>;
}

export interface IsolatedCityHarness {
  readonly workDir: string;
  readonly dbPath: string;
  readonly config: BotGameConfig;
  readonly clock: FakeClock;
  readonly faults: CityFaultState;
  readonly logs: string[];
  /** 当前运行实例基址，如 `http://127.0.0.1:43210` */
  readonly baseUrl: string;
  /** MCP Streamable HTTP 地址，如 `http://127.0.0.1:43210/mcp` */
  readonly mcpUrl: string;
  /** 桥接基址，如 `http://127.0.0.1:43210/city/bridge/v1` */
  readonly bridgeUrl: string;
  readonly bridgeKey: string;
  city: CityService;
  manager: GameManager;
  /** 确定性推进时钟 `ms` 毫秒，并按到期顺序逐条结算 `scheduled_jobs` 与 `GameManager.tick()` */
  advance(ms: number): void;
  /** 注入三片天气实况（传 null 则模拟一次天气源抓取失败，用于测 stale / fallback） */
  injectWeather(readings: WeatherReading[] | null): void;
  /** 设置某片区是否下雨的便捷方法 */
  setAreaRain(areaRain: Partial<Record<'akabane' | 'ikebukuro' | 'shinjuku', boolean>>): void;
  /**
   * 模拟引擎停机/崩溃并在同一 `city-test.db` 上重启恢复：
   * 先关闭当前连接与 SQLite → 推进停机时长 `downtimeMs` → 重新打开同一库并完成 `start()` 追赶。
   */
  restart(downtimeMs?: number): Promise<void>;
  /** 关闭服务；cleanup=true（默认仅对自动创建的临时目录）时删除临时测试文件 */
  close(opts?: { cleanup?: boolean }): Promise<void>;
}

export async function createIsolatedCityHarness(opts: IsolatedCityHarnessOptions = {}): Promise<IsolatedCityHarness> {
  const ownsDir = !opts.workDir;
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'botgame-city-test-'));
  const dbPath = opts.dbPath ?? join(workDir, 'city-test.db');
  const rawCfg = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8')) as Record<string, any>;
  rawCfg.port = opts.port ?? 0;
  rawCfg.stateFile = join(workDir, 'city-test-state.json');
  rawCfg.settingsFile = join(workDir, 'city-test-settings.json');
  rawCfg.auth.issuedKeysFile = join(workDir, 'city-test-keys.json');
  rawCfg.town.enabled = false;
  rawCfg.town.dbFile = join(workDir, 'town-untouched.db');
  rawCfg.city.enabled = true;
  rawCfg.city.dbFile = dbPath;
  rawCfg.city.weather = false;
  if (opts.seed) rawCfg.seed = opts.seed;
  if (opts.cityParams) rawCfg.city.params = { ...rawCfg.city.params, ...opts.cityParams };
  if (opts.cityOverrides) rawCfg.city = { ...rawCfg.city, ...opts.cityOverrides };

  // 通过正式 configSchema 校验配置合法性
  const tmpCfgFile = join(workDir, 'botgame.city-test.resolved.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tmpCfgFile, JSON.stringify(rawCfg, null, 2));
  const config = loadConfig(tmpCfgFile, {});
  if (config.town.enabled) throw new Error('隔离城市测试环境必须保持 town.enabled = false');

  const clock = new FakeClock();
  clock.t = opts.at ?? CITY_TEST_T0;
  const logs: string[] = [];
  const log = (msg: string) => {
    logs.push(msg);
  };
  const faults: CityFaultState = {
    bridge503Count: 0,
    delayMs: 0,
    dropResponseOnce: false,
    purchaseUnknown: false,
  };

  let bootSeq = 0;
  let currentCity!: CityService;
  let currentManager!: GameManager;
  let currentServer!: HttpServer;
  let closeCityHttp: () => void = () => undefined;
  let currentPort = config.port;
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

  const advance = (ms: number): void => {
    if (ms < 0 || !Number.isFinite(ms)) throw new Error('advance(ms) 需要非负有限毫秒数');
    const target = clock.t + ms;
    for (;;) {
      const nextJob = currentCity.db.get<{ due_at: number }>("SELECT MIN(due_at) AS due_at FROM scheduled_jobs WHERE status = 'pending'")?.due_at;
      const step = Math.min(target, clock.t + 5 * 60_000, nextJob ?? target);
      if (step > clock.t) clock.t = step;
      currentCity.runDue();
      currentManager.tick();
      if (clock.t >= target) {
        currentCity.runDue();
        break;
      }
    }
  };

  const injectWeather = (readings: WeatherReading[] | null): void => {
    currentCity.commit(() => applyWeather(currentCity, readings, clock.t));
  };

  const setAreaRain = (areaRain: Partial<Record<'akabane' | 'ikebukuro' | 'shinjuku', boolean>>): void => {
    const readings: WeatherReading[] = AREAS.map((a) => {
      const rain = Boolean(areaRain[a.id]);
      return {
        area: a.id,
        observed_at_ms: clock.t,
        code: rain ? 61 : 1,
        temp_c: rain ? 12.0 : 17.5,
        precip_mm: rain ? 2.4 : 0,
        hourly: [{ at_ms: clock.t, code: rain ? 61 : 1, temp_c: rain ? 12.0 : 17.5, precip_mm: rain ? 2.4 : 0 }],
      };
    });
    injectWeather(readings);
  };

  const boot = async (listenPort: number): Promise<void> => {
    bootSeq += 1;
    const store = config.stateFile ? new FileStateStore(config.stateFile) : undefined;
    const manager = new GameManager({
      registry: createRegistry({}),
      rng: new SeededRng(`${config.seed ?? 'test'}:mgr:${bootSeq}`),
      store,
      now: clock.now,
      refereeStaleMs: config.refereeStaleSeconds * 1000,
      lobbyTtlMs: config.lobbyTtlMinutes * 60_000,
      idleGameTtlMs: config.idleGameTtlMinutes * 60_000,
      allowedGroups: config.allowedGroups,
      maxActiveGames: config.maxActiveGames,
      refereeIds: config.refereeIds,
      defaultOptions: config.defaultOptions,
    });
    const city = createCity({
      dbPath,
      params: config.city.params,
      publicUrl: config.city.publicUrl,
      devLogin: config.city.devLogin,
      now: clock.now,
      rng: new SeededRng(`${config.seed ?? 'test'}:city:${bootSeq}`),
      house: config.city.house.map((m) => ({ actorId: m.actorId, name: m.name, ...(m.bio ? { bio: m.bio } : {}), qqIds: m.qqIds })),
      fetchWeather: null,
      log,
    });
    city.failpoints.purchaseUnknown = ({ sku }) => {
      if (typeof faults.purchaseUnknown === 'string') return faults.purchaseUnknown === sku;
      return Boolean(faults.purchaseUnknown);
    };
    await city.start();

    const auth = new Authenticator(resolveAuth(config), manager, log);
    manager.isKeyedAgent = (id) => auth.hasKeyFor(id);

    const app: Express = createMcpExpressApp({ host: config.host });
    const deps = {
      manager,
      auth,
      version: VERSION,
      log,
      city: {
        city,
        auth,
        trustedIds: config.refereeIds,
        ...cityPolicy(config.city),
      },
    };

    // ── 测试故障注入中间件（仅存在于隔离测试脚手架） ──
    app.use('/city/bridge/v1', async (req: Request, res: Response, next: NextFunction) => {
      if (faults.delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, faults.delayMs));
      }
      if (req.method === 'POST' && faults.bridge503Count > 0) {
        faults.bridge503Count -= 1;
        res.status(503).json({ error: 'RECOVERING', message: '[test-fault] 模拟城市恢复中，请带同一 request_id 重试。' });
        return;
      }
      if (req.method === 'POST' && faults.dropResponseOnce) {
        faults.dropResponseOnce = false;
        const origJson = res.json.bind(res);
        res.json = ((body: unknown) => {
          // 此时同步桥接处理器已完成 SQLite 事务提交；销毁底层连接模拟响应包在网络中丢失（F4）
          void body;
          req.socket.destroy();
          return res;
        }) as typeof res.json;
        void origJson;
      }
      next();
    });

    // ── 标准 MCP Streamable HTTP ──
    const handleMcp = async (req: Request, res: Response) => {
      const key = extractKey(req.headers, req.query as Record<string, unknown>);
      const identity = auth.identityFromKey(key);
      if (identity === null || (identity === undefined && auth.mode === 'keys')) {
        res.status(401).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null });
        return;
      }
      const sid = req.header('mcp-session-id');
      if (sid) {
        const existing = mcpSessions.get(sid);
        if (!existing) {
          res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
          return;
        }
        await existing.handleRequest(req, res, req.body);
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
        return;
      }
      const ctx: SessionContext = { identity: identity ?? null, fixed: Boolean(identity), transport: 'http' };
      const mcpServer: McpServer = createMcpServer(deps, ctx);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpSessions.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpSessions.delete(transport.sessionId);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    };
    app.post(config.path, handleMcp);
    app.get(config.path, handleMcp);
    app.delete(config.path, handleMcp);

    app.get('/health', (_req, res) => {
      res.json({ ok: true, mode: 'city-isolated-test', town_enabled: false, city_enabled: true, now_ms: clock.t });
    });
    app.get('/api/games', (req, res) => {
      res.json({ games: manager.listGames({ groupId: req.query.group_id as string | undefined, includeFinished: req.query.all === '1' }) });
    });

    closeCityHttp = mountCity(app, city, log, {
      bridgeKey: config.city.bridgeKey,
      adminKeys: config.auth.adminKeys,
      requestsPerMinute: 10_000,
    });

    if (opts.enableControlRoutes) {
      const ctl = express.Router();
      ctl.use(express.json());
      ctl.get('/state', (_req, res) => {
        const rec = runReconcile(city, 'test_inspect');
        res.json({
          now_ms: clock.t,
          local_time: city.clock(clock.t),
          ledger_imbalance: ledgerImbalance(city),
          reconcile_ok: rec.ok,
          findings: rec.findings,
          faults,
        });
      });
      ctl.post('/advance', (req, res) => {
        const ms = Number(req.body?.ms ?? 0);
        advance(ms);
        res.json({ ok: true, now_ms: clock.t, local_time: city.clock(clock.t) });
      });
      ctl.post('/faults', (req, res) => {
        const b = req.body ?? {};
        if (typeof b.bridge503Count === 'number') faults.bridge503Count = b.bridge503Count;
        if (typeof b.delayMs === 'number') faults.delayMs = b.delayMs;
        if (typeof b.dropResponseOnce === 'boolean') faults.dropResponseOnce = b.dropResponseOnce;
        if (typeof b.purchaseUnknown === 'boolean' || typeof b.purchaseUnknown === 'string') faults.purchaseUnknown = b.purchaseUnknown;
        res.json({ ok: true, faults });
      });
      ctl.post('/weather', (req, res) => {
        if (req.body?.fail) injectWeather(null);
        else if (Array.isArray(req.body?.readings)) injectWeather(req.body.readings);
        else if (req.body?.rain && typeof req.body.rain === 'object') setAreaRain(req.body.rain);
        res.json({ ok: true, now_ms: clock.t });
      });
      ctl.post('/restart', async (req, res) => {
        const downtimeMs = Number(req.body?.downtime_ms ?? 0);
        res.json({ ok: true, restarting: true, downtime_ms: downtimeMs });
        setImmediate(() => {
          void restart(downtimeMs);
        });
      });
      app.use('/__test/city', ctl);
    }

    const srv = await new Promise<HttpServer>((resolve, reject) => {
      const s = app.listen(listenPort, config.host, () => resolve(s));
      s.once('error', reject);
    });
    currentPort = (srv.address() as AddressInfo).port;
    currentCity = city;
    currentManager = manager;
    currentServer = srv;
  };

  const shutdownCurrent = async (): Promise<void> => {
    for (const t of mcpSessions.values()) await t.close().catch(() => undefined);
    mcpSessions.clear();
    closeCityHttp();
    closeCityHttp = () => undefined;
    if (currentServer) {
      currentServer.closeAllConnections();
      await new Promise<void>((r) => currentServer.close(() => r()));
    }
    currentManager?.flush();
    currentCity?.close();
  };

  const restart = async (downtimeMs = 0): Promise<void> => {
    const keepPort = currentPort;
    await shutdownCurrent();
    if (downtimeMs > 0) clock.t += downtimeMs;
    // 优先绑定原端口；若瞬间处于 TIME_WAIT 则退回 0 分配新端口
    try {
      await boot(keepPort);
    } catch {
      await boot(0);
    }
  };

  await boot(config.port);

  return {
    workDir,
    dbPath,
    config,
    clock,
    faults,
    logs,
    get baseUrl() {
      return `http://127.0.0.1:${currentPort}`;
    },
    get mcpUrl() {
      return `http://127.0.0.1:${currentPort}${config.path}`;
    },
    get bridgeUrl() {
      return `http://127.0.0.1:${currentPort}/city/bridge/v1`;
    },
    bridgeKey: config.city.bridgeKey!,
    get city() {
      return currentCity;
    },
    get manager() {
      return currentManager;
    },
    advance,
    injectWeather,
    setAreaRain,
    restart,
    async close(closeOpts?: { cleanup?: boolean }) {
      await shutdownCurrent();
      if (closeOpts?.cleanup ?? ownsDir) {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
}
