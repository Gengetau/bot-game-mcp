/**
 * bot-game-mcp 的 MCP 客户端：把常用的几个工具包成方法，加上「等到轮到我」的辅助函数。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface BotGameClientOptions {
  /** 引擎的 Streamable HTTP 地址，例如 http://127.0.0.1:7700/mcp */
  url: string;
  /** 这个 agent 的密钥（keys 模式必填，open 模式可以不填然后用 login） */
  key?: string;
  /** 报给引擎的客户端名字 */
  clientName?: string;
  /** 普通工具调用的超时（毫秒，默认 60 秒）；长轮询会按 wait_seconds 自动加长 */
  timeoutMs?: number;
}

/** 引擎拒绝了这次调用（参数不对、不是你的回合、没权限……），message 是引擎给的原因。 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    /** 引擎给的错误码（如 CONTEXT_STALE、FORBIDDEN）；没有就是 undefined */
    readonly code?: string,
    /** 引擎返回的完整错误文本（message 只是第一行）；小镇客户端从里面取 reason、retryAfterMs 等细节 */
    readonly raw?: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export type JoinAs = 'player' | 'referee' | 'either';

export interface TodoAction {
  action: string;
  description?: string;
  example?: string;
  command?: string;
  [k: string]: unknown;
}

export interface Todo {
  prompt: string;
  kind: string;
  actions: TodoAction[];
  seconds_left: number | null;
}

export interface GameEvent {
  seq: number;
  round: number;
  kind: string;
  text: string;
  private?: true;
}

/** get_my_view 的返回（玩家视角的常用字段；其余字段原样保留在对象里）。 */
export interface PlayerView {
  game: { game_id: string; type: string; name: string; group_id: string; status: string; round: number; phase: unknown };
  players?: { seat: number; name: string; qq: string; kind: 'agent' | 'human'; alive: boolean }[];
  public?: unknown;
  you?: Record<string, unknown>;
  your_turn?: boolean;
  todo?: Todo | null;
  new_events?: GameEvent[];
  hint?: string;
  result?: unknown;
  [k: string]: unknown;
}

export interface ActionInput {
  action: string;
  [k: string]: unknown;
}

export class BotGameClient {
  private constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {}

  /** 连接引擎（带密钥）。 */
  static async connect(opts: BotGameClientOptions): Promise<BotGameClient> {
    const headers: Record<string, string> = {};
    if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
    const client = new Client({ name: opts.clientName ?? 'bot-game-mcp-agent-kit', version: '0.2.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers } }));
    return new BotGameClient(client, opts.timeoutMs ?? 60_000);
  }

  /** 调用任意工具，返回解析后的 JSON；引擎拒绝时抛 ToolError。 */
  async call<T = any>(name: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<T> {
    const res: any = await this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs, ...(signal ? { signal } : {}) });
    const text: string = res?.content?.[0]?.text ?? '';
    if (res?.isError) throw new ToolError(text.replace(/^❌\s*/, '').split('\n')[0] ?? text, name, /\(code: ([A-Z_]+)\)/.exec(text)?.[1], text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ToolError(`引擎返回的不是 JSON：${text.slice(0, 200)}`, name);
    }
  }

  whoami() {
    return this.call('whoami');
  }

  listGames(groupId?: string, includeFinished = false) {
    return this.call('list_games', { ...(groupId ? { group_id: groupId } : {}), ...(includeFinished ? { all: true } : {}) });
  }

  getRules(gameType?: string) {
    return this.call('get_rules', gameType ? { game_type: gameType } : {});
  }

  createGame(input: {
    game_type: string;
    group_id: string;
    join_as?: JoinAs | 'none';
    options?: Record<string, unknown>;
    self_post?: boolean;
    auto_referee?: boolean;
  }) {
    return this.call('create_game', input);
  }

  joinGame(gameId: string, opts: { as?: JoinAs; selfPost?: boolean } = {}) {
    return this.call('join_game', {
      game_id: gameId,
      ...(opts.as ? { join_as: opts.as } : {}),
      ...(opts.selfPost !== undefined ? { self_post: opts.selfPost } : {}),
    });
  }

  leaveGame(gameId: string) {
    return this.call('leave_game', { game_id: gameId });
  }

  startGame(gameId: string) {
    return this.call('start_game', { game_id: gameId });
  }

  /** 我的视角。waitSeconds>0 时长轮询，轮到你（或游戏结束）才返回。 */
  getMyView(opts: { gameId?: string; waitSeconds?: number; wakeOn?: 'turn' | 'any'; fullLog?: boolean } = {}): Promise<PlayerView> {
    const wait = Math.max(0, Math.min(50, opts.waitSeconds ?? 0));
    return this.call<PlayerView>(
      'get_my_view',
      {
        ...(opts.gameId ? { game_id: opts.gameId } : {}),
        ...(wait > 0 ? { wait_seconds: wait } : {}),
        ...(opts.wakeOn ? { wake_on: opts.wakeOn } : {}),
        ...(opts.fullLog ? { full_log: true } : {}),
      },
      Math.max(this.timeoutMs, (wait + 30) * 1000),
    );
  }

  /** 发言。返回里若有 post_to_group，说明要你自己把原文发到群里。 */
  speak(text: string, opts: { channel?: 'public' | 'team'; gameId?: string } = {}) {
    return this.call('speak', { text, ...(opts.channel ? { channel: opts.channel } : {}), ...(opts.gameId ? { game_id: opts.gameId } : {}) });
  }

  /** 行动：照 todo.actions 里的 example 填。 */
  act(input: ActionInput, gameId?: string) {
    return this.call('act', { ...input, ...(gameId ? { game_id: gameId } : {}) });
  }

  getGameLog(opts: { gameId?: string; sinceSeq?: number; limit?: number } = {}) {
    return this.call('get_game_log', {
      ...(opts.gameId ? { game_id: opts.gameId } : {}),
      ...(opts.sinceSeq !== undefined ? { since_seq: opts.sinceSeq } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * 一直等到轮到我或者游戏结束，返回那一刻的视角。
 * 每轮长轮询 waitSeconds 秒（默认 30），maxWaits 轮后放弃（默认不限）。
 */
export async function waitForTurn(
  client: BotGameClient,
  gameId: string,
  opts: { waitSeconds?: number; maxWaits?: number; signal?: AbortSignal } = {},
): Promise<PlayerView> {
  const waitSeconds = opts.waitSeconds ?? 30;
  for (let i = 0; opts.maxWaits === undefined || i < opts.maxWaits; i++) {
    if (opts.signal?.aborted) throw new Error('waitForTurn 被取消');
    const view = await client.getMyView({ gameId, waitSeconds });
    if (view.your_turn || view.game.status !== 'running') return view;
  }
  throw new Error('waitForTurn：等待次数用完，还没轮到我');
}

