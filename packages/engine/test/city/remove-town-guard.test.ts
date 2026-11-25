/**
 * 栖灯镇（Ftown）删除守卫测试：
 *  1. 扫描 `packages/<pkg>/src` 下全部源码文件，断言不包含 `栖灯镇`、`mountTown`、`registerTownTools`、`createWorld`；
 *  2. 断言晴空都开启时的 MCP 工具清单与删除栖灯镇前逐项完全一致（共 30 个工具），且不再暴露小镇指南/提示词；
 *  3. 断言带旧 `town` 配置段的文件仍可正常加载启动并打印废止提示日志；
 *  4. 断言 `/town/`、`/town/3d/`、`/town/api/public` 均返回 404，而 `/health`、`/city/`、`/city/play/`、`/city/api/public` 均返回 200。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { GameManager } from '../../src/core/manager.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { startHttpServer, type HttpHandle } from '../../src/server/http.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';
import { makeCity } from './helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

const FORBIDDEN_SRC_TOKENS = ['栖灯镇', 'mountTown', 'registerTownTools', 'createWorld'] as const;

/** 删除栖灯镇前（基线 0ae6c94）晴空都开启时的完整 MCP 工具清单 */
const EXPECTED_CITY_MCP_TOOLS = [
  'login',
  'whoami',
  'list_games',
  'get_rules',
  'create_game',
  'join_game',
  'add_human_player',
  'leave_game',
  'start_game',
  'abort_game',
  'get_my_view',
  'speak',
  'act',
  'spectator_say',
  'get_game_log',
  'referee_step',
  'relay_human_message',
  'referee_offer',
  'referee_takeover',
  'issue_key',
  'revoke_key',
  'list_keys',
  'enter_world',
  'world_act',
  'world_wait',
  'heartbeat',
  'claim_control',
  'leave_world',
  'world_query',
  'city_issue_ticket',
] as const;

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

describe('栖灯镇删除守卫（Ftown）', () => {
  let workDir: string | null = null;
  let handle: HttpHandle | null = null;
  let rt: Runtime | null = null;
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      await Promise.resolve(fn()).catch(() => undefined);
    }
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

  it('packages/*/src 下源码不含栖灯镇与旧小镇核心符号', () => {
    const pkgDirs = readdirSync(PACKAGES_DIR)
      .map((name) => join(PACKAGES_DIR, name, 'src'))
      .filter((dir) => existsSync(dir));
    expect(pkgDirs.length).toBeGreaterThanOrEqual(3);

    const hits: string[] = [];
    for (const srcDir of pkgDirs) {
      for (const file of walkFiles(srcDir)) {
        const content = readFileSync(file, 'utf8');
        for (const token of FORBIDDEN_SRC_TOKENS) {
          if (content.includes(token)) {
            hits.push(`${relative(REPO_ROOT, file)}: ${token}`);
          }
        }
      }
    }
    expect(hits, `检测到残留小镇标识：\n${hits.join('\n')}`).toEqual([]);
  });

  it('城市开启时 MCP 工具清单与基线逐项一致，且不注册小镇资源与提示词', async () => {
    const t = makeCity();
    cleanups.push(() => t.c.close());
    const manager = new GameManager({ registry: createRegistry() });
    const auth = new Authenticator({ mode: 'open', agents: [], adminKeys: [] }, manager, () => undefined);
    const ctx: SessionContext = { identity: { id: 'guard-bot', name: '守卫' }, fixed: true, transport: 'stdio' };
    const server = createMcpServer({ manager, auth, version: 'test', city: { city: t.c, auth } }, ctx);
    const client = new Client({ name: 'remove-town-guard', version: '1.0.0' });
    const [cTr, sTr] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTr), client.connect(cTr)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...EXPECTED_CITY_MCP_TOOLS]);

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('botgame://guide/city');
    expect(uris).not.toContain('botgame://guide/town');

    const { prompts } = await client.listPrompts();
    const promptNames = prompts.map((p) => p.name);
    expect(promptNames).toContain('city-resident');
    expect(promptNames).not.toContain('resident');
  });

  it('带旧 town 段的配置文件能照常启动并打提示日志，且 /town/* 返回 404、/city/* 返回 200', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'remove-town-guard-'));
    const cfgFile = join(workDir, 'legacy-with-town.json');
    writeFileSync(
      cfgFile,
      JSON.stringify(
        {
          host: '127.0.0.1',
          port: 0,
          stateFile: null,
          settingsFile: null,
          town: {
            enabled: true,
            dbFile: join(workDir, 'town.db'),
            clientDir: join(workDir, 'client-build'),
          },
          city: {
            enabled: true,
            dbFile: join(workDir, 'city.db'),
            weather: false,
          },
        },
        null,
        2,
      ),
    );

    const logs: string[] = [];
    const cfg = loadConfig(cfgFile, {}, (m) => logs.push(m));
    expect('town' in cfg).toBe(false);
    expect(logs).toContain('配置里的 town 已不再使用，可以删掉');
    expect(cfg.city.enabled).toBe(true);

    rt = createRuntime(cfg, (m) => logs.push(m));
    expect('world' in rt).toBe(false);
    expect(rt.city).toBeDefined();
    for (let i = 0; i < 100 && rt.city!.status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rt.city!.status).toBe('running');

    handle = await startHttpServer(rt, (m) => logs.push(m));
    const baseUrl = handle.url.replace(/\/mcp$/, '');

    expect((await fetch(`${baseUrl}/town/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/town/3d/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/town/api/public`)).status).toBe(404);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    expect((await fetch(`${baseUrl}/city/`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/city/play/`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/city/api/public`)).status).toBe(200);
  });
});
