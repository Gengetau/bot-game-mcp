import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator, type SessionContext } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { startBridge } from '../../src/server/bridge.js';
import { startHttpServer, type HttpHandle } from '../../src/server/http.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

function parse(res: unknown): any {
  const r = res as ToolResult;
  if (r.isError) throw new Error(r.content[0]?.text);
  return JSON.parse(r.content[0]!.text);
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return parse(await client.callTool({ name, arguments: args }));
}

function inMemoryDeps(mode: 'open' | 'keys', agents: { key: string; id: string; name: string }[] = []) {
  const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('mcp') });
  const auth = new Authenticator({ mode, adminKeys: [], agents }, manager);
  return { manager, auth, version: 'test' };
}

async function connect(deps: ReturnType<typeof inMemoryDeps>, ctx: SessionContext): Promise<Client> {
  const server = createMcpServer(deps, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
  return client;
}

const EXPECTED_TOOLS = [
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
  'get_game_log',
  'spectator_say',
  'referee_step',
  'relay_human_message',
  'referee_takeover',
  'referee_offer',
  'issue_key',
  'revoke_key',
  'list_keys',
];

describe('MCP over in-memory transport', () => {
  it('exposes tools with schemas, annotations, resources and prompts', async () => {
    const deps = inMemoryDeps('open');
    const client = await connect(deps, { identity: null, fixed: false, transport: 'memory' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const t of tools) {
      expect(t.description?.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    expect(tools.find((t) => t.name === 'get_my_view')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'abort_game')?.annotations?.destructiveHint).toBe(true);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['botgame://guide/overview', 'botgame://guide/referee', 'botgame://rules/werewolf']),
    );
    const rules = await client.readResource({ uri: 'botgame://rules/undercover' });
    expect((rules.contents[0] as { text: string }).text).toMatch(/卧底/);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['player', 'referee']);
    const prompt = await client.getPrompt({ name: 'referee', arguments: { game_id: 'WW-TEST' } });
    expect(JSON.stringify(prompt.messages)).toMatch(/referee_step/);
    expect(client.getInstructions()).toMatch(/裁判/);
  });

  it('requires login in open mode and protects claimed ids with a secret', async () => {
    const deps = inMemoryDeps('open');
    const c1 = await connect(deps, { identity: null, fixed: false, transport: 'memory' });
    const denied = (await c1.callTool({ name: 'create_game', arguments: { game_type: 'number_bomb', group_id: '1' } })) as ToolResult;
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/login/);

    const first = await call(c1, 'login', { qq_id: '10001', nickname: 'Mio' });
    expect(first.secret).toBeTruthy();
    expect((await call(c1, 'whoami')).identity.id).toBe('10001');

    const c2 = await connect(deps, { identity: null, fixed: false, transport: 'memory' });
    const stolen = (await c2.callTool({ name: 'login', arguments: { qq_id: '10001', nickname: '冒充者' } })) as ToolResult;
    expect(stolen.isError).toBe(true);
    const again = await call(c2, 'login', { qq_id: '10001', nickname: 'Mio', secret: first.secret });
    expect(again.identity.name).toBe('Mio');
    expect(again.secret).toBeUndefined();
  });

  it('keys mode binds identity and refuses login', async () => {
    const deps = inMemoryDeps('keys', [{ key: 'k'.repeat(16), id: '555', name: 'KeyBot' }]);
    const id = deps.auth.identityFromKey('k'.repeat(16));
    expect(id).toEqual({ id: '555', name: 'KeyBot' });
    expect(deps.auth.identityFromKey('wrong-key-123')).toBeNull();
    const client = await connect(deps, { identity: id as Identity, fixed: true, transport: 'memory' });
    expect((await call(client, 'whoami')).identity.name).toBe('KeyBot');
    const r = (await client.callTool({ name: 'login', arguments: { qq_id: '777', nickname: 'x' } })) as ToolResult;
    expect(r.isError).toBe(true);
  });

  it('plays a complete mixed game using only MCP tool calls', async () => {
    const deps = inMemoryDeps('open');
    const ids: Identity[] = [
      { id: '900', name: '裁判' },
      { id: '101', name: 'A' },
      { id: '102', name: 'B' },
    ];
    const clients: Client[] = [];
    for (const id of ids) {
      const c = await connect(deps, { identity: null, fixed: false, transport: 'memory' });
      await call(c, 'login', { qq_id: id.id, nickname: id.name });
      clients.push(c);
    }
    const [ref, a, b] = clients as [Client, Client, Client];
    const created = await call(ref, 'create_game', { game_type: '数字炸弹', group_id: '424242', join_as: 'referee', options: { max: 30 } });
    const gameId: string = created.summary.game_id;
    expect(created.group_message).toMatch(/数字炸弹/);
    await call(a, 'join_game', { game_id: gameId, join_as: 'player', self_post: false });
    await call(b, 'join_game', { game_id: gameId, join_as: 'player' });
    const lobbyRelay = await call(a, 'relay_human_message', { game_id: gameId, qq_id: '201', nickname: '真人小王', text: '加入' });
    expect(lobbyRelay.accepted).toBe(true);
    const started = await call(ref, 'start_game', { game_id: gameId });
    expect(started.referee.id).toBe('900');

    const byId = new Map<string, Client>([
      ['101', a],
      ['102', b],
    ]);
    let finished = false;
    for (let i = 0; i < 300 && !finished; i++) {
      const step = await call(ref, 'referee_step', { game_id: gameId, format: i % 2 ? 'cq' : 'onebot' });
      finished = step.finished;
      if (finished) break;
      const rec = deps.manager.getRecord(gameId);
      if (rec.status !== 'running') continue;
      for (const p of rec.players) {
        if (p.kind === 'agent') {
          const view = await call(byId.get(p.id)!, 'get_my_view', {});
          if (!view.your_turn) continue;
          const input = deps.manager.randomActionFor(gameId, p.seat)!;
          await call(byId.get(p.id)!, 'act', input as unknown as Record<string, unknown>);
        } else if (rec.phase?.openedAt && rec.phase.pending[String(p.seat)] && !rec.phase.pending[String(p.seat)]!.done) {
          const input = deps.manager.randomActionFor(gameId, p.seat)!;
          const relay = await call(ref, 'relay_human_message', { game_id: gameId, qq_id: p.id, text: `猜${input.number}`, channel: 'group' });
          expect(relay.accepted).toBe(true);
        }
      }
    }
    expect(finished).toBe(true);
    const log = await call(a, 'get_game_log', { game_id: gameId });
    expect(log.complete_replay).toBe(true);
    expect(log.result.winnerTeam).toBeTruthy();
  });

  it('returns tool errors (not protocol errors) for invalid moves', async () => {
    const deps = inMemoryDeps('open');
    const c = await connect(deps, { identity: null, fixed: false, transport: 'memory' });
    await call(c, 'login', { qq_id: '1', nickname: 'x' });
    const r = (await c.callTool({ name: 'act', arguments: { action: 'vote', target: 3 } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/没有参与/);
    const bad = (await c.callTool({ name: 'create_game', arguments: { game_type: '飞行棋', group_id: '1' } })) as ToolResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/未知游戏类型/);
  });
});

describe('HTTP transports', () => {
  const KEYS = { ref: 'ref-key-0123456789', a: 'a-key-0123456789', b: 'b-key-0123456789', admin: 'admin-key-0123456789' };
  let rt: Runtime;
  let http: HttpHandle;

  beforeAll(async () => {
    const config = configSchema.parse({
      host: '127.0.0.1',
      port: 0,
      stateFile: null,
      auth: {
        mode: 'keys',
        adminKeys: [KEYS.admin],
        agents: [
          { key: KEYS.ref, id: '900', name: '裁判' },
          { key: KEYS.a, id: '101', name: 'A' },
          { key: KEYS.b, id: '102', name: 'B' },
        ],
      },
    });
    rt = createRuntime(config, () => undefined);
    http = await startHttpServer(rt, () => undefined);
  });

  afterAll(async () => {
    await http?.close();
    rt?.close();
  });

  const httpClient = async (key?: string) => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers } }));
    return client;
  };

  it('rejects missing or wrong keys', async () => {
    await expect(httpClient()).rejects.toThrow();
    await expect(httpClient('not-a-valid-key-123')).rejects.toThrow();
    const health = (await (await fetch(http.url.replace('/mcp', '/health'))).json()) as any;
    expect(health.ok).toBe(true);
    expect(health.auth_mode).toBe('keys');
  });

  it('runs a game across several Streamable HTTP sessions with long-polling', async () => {
    const ref = await httpClient(KEYS.ref);
    const a = await httpClient(KEYS.a);
    const b = await httpClient(KEYS.b);
    expect((await call(a, 'whoami')).identity.name).toBe('A');

    const created = await call(ref, 'create_game', { game_type: 'number_bomb', group_id: '777', join_as: 'referee', options: { max: 12 } });
    const gameId = created.summary.game_id as string;
    await call(a, 'join_game', { game_id: gameId, join_as: 'player', self_post: false });
    await call(b, 'join_game', { game_id: gameId, join_as: 'player', self_post: false });
    await call(ref, 'start_game', { game_id: gameId });

    const players = new Map([
      ['101', a],
      ['102', b],
    ]);
    // 玩家用长轮询等自己的回合，裁判用长轮询等消息
    const playerLoop = async (id: string, client: Client) => {
      for (let i = 0; i < 40; i++) {
        const v = await call(client, 'get_my_view', { game_id: gameId, wait_seconds: 5 });
        if (v.game.status !== 'running') return;
        if (!v.your_turn) continue;
        const seat = v.you.seat as number;
        const input = rt.manager.randomActionFor(gameId, seat);
        if (input) await call(client, 'act', { ...input, game_id: gameId }).catch(() => undefined);
        void id;
      }
    };
    const refereeLoop = async () => {
      for (let i = 0; i < 60; i++) {
        const s = await call(ref, 'referee_step', { game_id: gameId, wait_seconds: 5 });
        if (s.finished) return s;
      }
      throw new Error('referee loop did not finish');
    };
    const [final] = await Promise.all([refereeLoop(), ...[...players].map(([id, c]) => playerLoop(id, c))]);
    expect(final.finished).toBe(true);

    const pub = (await (await fetch(http.url.replace('/mcp', `/api/games/${gameId}`))).json()) as any;
    expect(pub.summary.status).toBe('ended');
    await Promise.all([ref.close(), a.close(), b.close()]);
  }, 30_000);

  it('serves legacy HTTP+SSE clients', async () => {
    const client = new Client({ name: 'sse-test', version: '1.0.0' });
    const url = new URL(http.url.replace('/mcp', '/sse'));
    url.searchParams.set('key', KEYS.a);
    await client.connect(new SSEClientTransport(url));
    const who = await call(client, 'whoami');
    expect(who.identity.id).toBe('101');
    await client.close();
  });

  it('bridges a stdio-style client to the HTTP server', async () => {
    const [upstreamClientSide, upstreamServerSide] = InMemoryTransport.createLinkedPair();
    const bridge = await startBridge({ url: http.url, key: KEYS.b }, upstreamServerSide);
    const client = new Client({ name: 'bridged', version: '1.0.0' });
    await client.connect(upstreamClientSide);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('referee_step');
    expect((await call(client, 'whoami')).identity.name).toBe('B');
    const res = await client.readResource({ uri: 'botgame://guide/player' });
    expect(JSON.stringify(res)).toMatch(/get_my_view/);
    await client.close();
    await bridge.close();
  });
});
