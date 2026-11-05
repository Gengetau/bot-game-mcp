/**
 * 代码驱动的裁判：把 bot-game-mcp 引擎接到一个或多个 OneBot v11 账号上（正向 WebSocket，Universal 角色）。
 *
 *   bot-game-referee --url http://127.0.0.1:7700/mcp --key 密钥 \
 *       --onebot ws://127.0.0.1:3001/ [--onebot-token-file 文件] --group 群号 \
 *       [--admins QQ,QQ] [--bots QQ,QQ] [--bot-commands] [--main-plays] [--options '{"nudge_ai":true}'] [--voices voices.json]
 *
 * 它只是一条消息总线：
 *  - 引擎要发的消息（referee_step）按顺序发到群里，或私聊给对应的真人；
 *  - 真人在群里、私聊里说的话原样转交给引擎（relay_human_message），由引擎解析；
 *  - 群里的「/桌游 …」指令用来开房、开局、中止、看状态和规则。
 *
 * 随机裁判：主账号之外还可以带若干「嗓子」账号（voices）。报名的 bot 里凡是本进程能替它说话的，
 * 都向引擎登记代行（referee_offer）；开局时引擎在登记池里抽一个当裁判，本进程就用那个账号发消息。
 * 抽中账号自己的模型拿不到任何该发的话（引擎只认带 host_id 的调用），裁判的每句话都是程序发的。
 * 身份、座位、结算全由引擎决定，本进程没有任何能影响结果的接口。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { hostname } from 'node:os';
import { VERSION } from './version.js';
import { renderWheel } from './wheel.js';

/** 一个可以替它说话的额外账号：引擎密钥 + 它自己的 OneBot 连接。 */
export interface VoiceSpec {
  key: string;
  onebotUrl: string;
  onebotToken?: string;
}

export interface RefereeOptions {
  /** 引擎的 Streamable HTTP 地址，如 http://127.0.0.1:7700/mcp */
  url: string;
  /** 裁判在引擎里的密钥（keys 模式） */
  key?: string;
  /** OneBot v11 正向 WebSocket 地址（Universal），如 ws://127.0.0.1:3001/ */
  onebotUrl: string;
  /** OneBot access_token（作为 access_token 查询参数发送） */
  onebotToken?: string;
  /** 只服务这个群 */
  groupId: string;
  /** 可以开房、开局、中止的 QQ 号；为空则群里任何人都可以 */
  admins?: string[];
  /** 其他 bot 的 QQ 号：它们通过 MCP 自己参与，群里的话不转交 */
  bots?: string[];
  /**
   * 允许 bots 里的账号在群里发「/桌游 <游戏>」开房、「/桌游 开局」开局（以及状态、规则、帮助）。
   * 它们的其余群消息照旧忽略，「中止」仍然只有管理员能用。默认 false：bot 的群消息全部忽略。
   */
  botCommands?: boolean;
  /** 开房时的默认选项（指令里写的选项会覆盖） */
  defaultOptions?: Record<string, unknown>;
  /** referee_step 的长轮询秒数（1~50），默认 25 */
  stepWaitSeconds?: number;
  /** 指令前缀，默认「/桌游」 */
  commandPrefix?: string;
  /**
   * 自动开局：报名人数达到最少人数后，这么多秒没有新人加入就自动开局（0 或不填 = 关闭，等「开局」指令）。
   * 开房指令里写一个数字（如「/桌游 狼人杀 7」）表示凑满这么多人立刻开局；人数达到上限也立刻开局。
   */
  autoStartSeconds?: number;
  /** 报名兜底：人数还不够最少人数时，这么多秒没有新人报名就取消房间（0 或不填 = 不取消），默认 0 */
  lobbyTimeoutSeconds?: number;
  /** 两条 QQ 消息之间的最小间隔（毫秒），默认 300 */
  sendGapMs?: number;
  /** 额外的嗓子账号：报名了的会进裁判抽签池，抽中就用它发消息 */
  voices?: VoiceSpec[];
  /** 本进程的标识（引擎用它区分「代行进程」和「账号自己的模型」），默认主机名。重启后要保持不变 */
  hostId?: string;
  /** 主账号是否进抽签池（默认 true；false 则主账号只当候补裁判和开房的嗓子） */
  selfInPool?: boolean;
  /**
   * 主账号也参赛：开房时不再自动把主账号登记成裁判候选，由它自己的模型像别的 bot 一样 join_game 报名当玩家；
   * 报名了就进抽签池（抽中则由本进程代行裁判，没抽中就上场玩）。开局前若抽不出别的裁判（没有别的候选，
   * 或人数只够不能少一个），本进程把主账号改回裁判，它这局坐庄。主账号的模型没报名时和原来一样：它当裁判。
   */
  mainPlays?: boolean;
  /**
   * 跟随模式（外接 bot 用）：本进程不开房、不响应「/桌游」指令、不转交报名消息、不当候补裁判。
   * 它只做一件事：自己的账号报名了就登记进裁判抽签池，抽中了就用自己的账号主持（含转交真人消息）。
   * 群里的开房、开局由主机那边的裁判进程负责。
   */
  follower?: boolean;
  /** 开局时把抽签结果画成转盘图发到群里（默认 true；候选只有一人时不画） */
  wheelImage?: boolean;
  /** 转盘图的字体：GNU Unifont .hex / .hex.gz 路径；不给则中文画成方块 */
  wheelFont?: string;
  /** 外部停止信号 */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

type Log = (line: string) => void;
type Json = Record<string, any>;

export class ToolError extends Error {}
export class TransportError extends Error {}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pause = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// ───────────────────────── CQ 码 ─────────────────────────

const escapeCqText = (s: string) => s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
const escapeCqParam = (s: string) => escapeCqText(s).replace(/,/g, '&#44;');
const unescapeCq = (s: string) => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');

/** OneBot 消息（消息段数组或 CQ 字符串）→ CQ 码字符串。引擎的 relay_human_message 接受这种原文。 */
export function segmentsToCq(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .map((seg: any) => {
      const type = String(seg?.type ?? '');
      const data = (seg?.data ?? {}) as Json;
      if (type === 'text') return escapeCqText(String(data.text ?? ''));
      if (type === 'at') return `[CQ:at,qq=${escapeCqParam(String(data.qq ?? ''))}]`;
      if (type === 'reply') return `[CQ:reply,id=${escapeCqParam(String(data.id ?? ''))}]`;
      return `[CQ:${type.replace(/[^\w]/g, '') || 'unknown'}]`;
    })
    .join('');
}

/** 去掉全部 CQ 码、还原转义，用来识别指令。 */
export function cqToPlain(cq: string): string {
  return unescapeCq(cq.replace(/\[CQ:[^\]]*\]/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 「/桌游 狼人杀 win_mode=all night_min_s=30」里的选项；也接受一个 JSON 对象。 */
export function parseOptionTokens(tokens: string[]): Record<string, unknown> {
  const joined = tokens.join(' ').trim();
  if (joined.startsWith('{')) return JSON.parse(joined) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const t of tokens) {
    const m = t.match(/^([A-Za-z_][\w]*)=(.*)$/);
    if (!m) continue;
    const v = m[2]!;
    out[m[1]!] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return out;
}

// ───────────────────────── 引擎（MCP 客户端） ─────────────────────────

class Engine {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly url: string,
    private readonly key: string | undefined,
    private readonly log: Log,
  ) {}

  private ensure(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = (async () => {
        const headers: Record<string, string> = {};
        if (this.key) headers.Authorization = `Bearer ${this.key}`;
        const client = new Client({ name: 'bot-game-mcp-referee', version: VERSION });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } }));
        } finally {
          this.connecting = null;
        }
        client.onclose = () => {
          if (this.client === client) this.client = null;
        };
        this.client = client;
        this.log('[engine] 已连接');
        return client;
      })();
    }
    return this.connecting;
  }

  /** 调用工具；传输层问题抛 TransportError（可重试），引擎拒绝抛 ToolError。 */
  async call(name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<any> {
    let client: Client;
    try {
      client = await this.ensure();
    } catch (e) {
      throw new TransportError(`连接引擎失败：${errMsg(e)}`);
    }
    let res: any;
    try {
      res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (e) {
      if (e instanceof McpError && e.code !== ErrorCode.ConnectionClosed && e.code !== ErrorCode.RequestTimeout) {
        throw new ToolError(`${name}：${errMsg(e)}`);
      }
      await this.drop();
      throw new TransportError(`${name}：${errMsg(e)}`);
    }
    const text: string = res?.content?.[0]?.text ?? '';
    if (res?.isError) throw new ToolError(text.replace(/^❌\s*/, '').split('\n')[0] ?? text);
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(`引擎返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }

  async drop(): Promise<void> {
    const c = this.client;
    this.client = null;
    try {
      await c?.close();
    } catch {
      /* 已经断开 */
    }
  }
}

// ───────────────────────── OneBot v11 正向 WebSocket ─────────────────────────

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class OneBot {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;
  private backoff = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly onEvent: (ev: Json) => void,
    private readonly log: Log,
  ) {}

  start(): void {
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.closed) return;
    const u = new URL(this.url);
    if (this.token) u.searchParams.set('access_token', this.token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(u);
    } catch (e) {
      this.log(`[onebot] 无法连接：${errMsg(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let gone = false;
    const lost = (why: string) => {
      if (gone) return;
      gone = true;
      if (this.ws === ws) this.ws = null;
      this.failPending(new Error(`OneBot 连接已断开（${why}）`));
      if (!this.closed) this.log(`[onebot] 连接断开（${why}），${this.backoff / 1000} 秒后重连`);
      this.scheduleReconnect();
    };
    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this.log('[onebot] 已连接');
    });
    ws.addEventListener('message', (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data)));
    // 握手失败（如 401、连不上）时 Node 的 WebSocket 只触发 error、不触发 close
    ws.addEventListener('error', (ev) => lost(String((ev as { message?: string }).message ?? '连接错误')));
    ws.addEventListener('close', (ev) => lost(String(ev.code)));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private onMessage(raw: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.echo !== undefined && msg.status !== undefined) {
      const p = this.pending.get(String(msg.echo));
      if (!p) return;
      this.pending.delete(String(msg.echo));
      clearTimeout(p.timer);
      if (msg.status === 'ok' || msg.retcode === 0) p.resolve(msg.data);
      else p.reject(new Error(`OneBot 返回 ${msg.retcode}：${msg.wording ?? msg.msg ?? msg.message ?? ''}`));
      return;
    }
    if (msg.post_type) {
      try {
        this.onEvent(msg);
      } catch (e) {
        this.log(`[onebot] 处理事件失败：${errMsg(e)}`);
      }
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  call(action: string, params: Json, timeoutMs = 15_000): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OneBot 未连接'));
    const echo = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot ${action} 超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.failPending(new Error('已关闭'));
    try {
      this.ws?.close();
    } catch {
      /* 忽略 */
    }
    this.ws = null;
  }
}

// ───────────────────────── 裁判主体 ─────────────────────────

interface CurrentGame {
  id: string;
  status: 'lobby' | 'running';
  host: string;
  /** 报名人数（不含裁判）与这款游戏的人数范围 */
  players: number;
  min: number;
  max: number;
  /** 开房时指定的目标人数：凑满就开 */
  target?: number;
  /** 进行中：裁判账号与代行它的进程 */
  refereeId: string | null;
  hostedBy: string | null;
  refereeIdleS: number | null;
  /** 报名中：已登记代行的账号 */
  hosted: Set<string>;
  lobbyIds: Set<string>;
  /** 报名中：每个报名者的身份偏好（player / referee / either） */
  lobbyPref: Map<string, string>;
  /** 主账号这局是玩家（--main-plays 时由它的模型报名的）；进行中沿用报名时的判断 */
  mainIsPlayer: boolean;
}

/** 一个账号：引擎会话 + OneBot 连接。 */
interface Voice {
  id: string;
  name: string;
  engine: Engine;
  onebot: OneBot;
  main: boolean;
}

export async function runReferee(opts: RefereeOptions): Promise<void> {
  const log: Log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const prefix = opts.commandPrefix ?? '/桌游';
  const admins = new Set(opts.admins ?? []);
  const bots = new Set(opts.bots ?? []);
  const botCommands = opts.botCommands ?? false;
  const stepWait = Math.max(1, Math.min(50, opts.stepWaitSeconds ?? 25));
  const autoStart = Math.max(0, opts.autoStartSeconds ?? 0);
  const lobbyTimeout = Math.max(0, opts.lobbyTimeoutSeconds ?? 0);
  const sendGap = opts.sendGapMs ?? 300;
  const hostId = (opts.hostId ?? hostname()).trim().slice(0, 100) || 'referee';
  const follower = opts.follower ?? false;
  const selfInPool = follower ? false : (opts.selfInPool ?? true);
  const mainPlays = !follower && (opts.mainPlays ?? false);
  const wheelImage = opts.wheelImage ?? true;

  let stopped = false;
  // 放在对象里：闭包里会改它们，用裸 let 的话 TypeScript 的类型收窄会出错
  const st: {
    game: CurrentGame | null;
    lastSeq: number;
    lobby: { count: number; changedAt: number; announced: boolean };
    /** 正在替引擎说话的账号（本局裁判是我的某个账号时） */
    active: Voice | null;
    takeoverAt: number;
    /** 上次记过日志的「对局:裁判:代行者」，避免每次刷新都重复打印 */
    noted: string;
  } = {
    game: null,
    lastSeq: -1, // 本局已发出的最后一条 seq；-1 = 未知
    lobby: { count: -1, changedAt: 0, announced: false }, // 自动开局：人数上次变化的时间
    active: null,
    takeoverAt: 0,
    noted: '',
  };
  let wake: (() => void) | null = null;
  const idle = (ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(() => {
        wake = null;
        res();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        res();
      };
    });

  // ── 账号 ──
  // 群消息每个账号的连接都会收到一份：按 message_id 去重
  const seenGroup = new Set<string>();
  const seenQueue: string[] = [];
  const dedupe = (key: string): boolean => {
    if (seenGroup.has(key)) return true;
    seenGroup.add(key);
    seenQueue.push(key);
    if (seenQueue.length > 2000) seenGroup.delete(seenQueue.shift()!);
    return false;
  };
  const voices: Voice[] = [];
  const makeVoice = (key: string | undefined, onebotUrl: string, token: string | undefined, main: boolean): Voice => {
    const tag = main ? '' : `[${voices.length}]`;
    const v: Voice = {
      id: '',
      name: '',
      engine: new Engine(opts.url, key, (l) => log(`${l}${tag}`)),
      onebot: new OneBot(onebotUrl, token, (ev) => onEvent(v, ev), (l) => log(`${l}${tag}`)),
      main,
    };
    voices.push(v);
    return v;
  };
  const main = makeVoice(opts.key, opts.onebotUrl, opts.onebotToken, true);
  for (const spec of opts.voices ?? []) makeVoice(spec.key, spec.onebotUrl, spec.onebotToken, false);
  const voiceOf = (id: string | null | undefined) => voices.find((v) => v.id === id) ?? null;
  const myIds = () => new Set(voices.map((v) => v.id).filter(Boolean));
  /** 现在该用哪个账号说话：本局裁判是我的账号就用它，否则主账号 */
  const speaker = () => st.active ?? main;
  /** 账号的 OneBot 掉线时退回主账号发（宁可换个嗓子也别把消息吞掉） */
  const sendable = (v: Voice) => (v.onebot.connected || !main.onebot.connected ? v : main);

  // 所有往 QQ 发的消息排成一队，保证顺序和间隔
  let sendChain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const next = sendChain.then(fn, fn);
    sendChain = next.catch(() => undefined);
    return next;
  };
  const sendGroupAs = (v: Voice, message: unknown) =>
    enqueue(async () => {
      const via = sendable(v);
      try {
        await via.onebot.call('send_group_msg', { group_id: Number(opts.groupId), message });
      } catch (e) {
        log(`[referee] 群消息发送失败（${via.name || via.id}）：${errMsg(e)}`);
      }
      await pause(sendGap);
    });
  const sendPrivateAs = (v: Voice, userId: string, text: string) =>
    enqueue(async () => {
      const via = sendable(v);
      try {
        await via.onebot.call('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text } }] });
      } catch (e) {
        log(`[referee] 私聊发送失败（${via.name || via.id} → ${userId}）：${errMsg(e)}`);
      }
      await pause(sendGap);
    });
  const sendGroup = (message: unknown) => sendGroupAs(speaker(), message);
  const say = (text: string) => sendGroup([{ type: 'text', data: { text } }]);
  const sayTo = (userId: string, text: string) =>
    sendGroup([
      { type: 'at', data: { qq: userId } },
      { type: 'text', data: { text: ` ${text}` } },
    ]);

  const help =
    `🎲 桌游指令（由程序主持，裁判不参与、不决定任何结果）：\n` +
    `${prefix} 狼人杀 | 谁是卧底 | 大话骰 | 数字炸弹 [人数] [选项，如 win_mode=all]  开房\n` +
    `${prefix} 开局 · ${prefix} 中止 · ${prefix} 状态 · ${prefix} 规则 狼人杀\n` +
    `报名：发「加入」；游戏中按提示在群里发指令（如「投3号」），夜间行动私聊本局裁判。` +
    (voices.length > 1 || selfInPool ? `\n裁判由程序在报名的 bot（含我）里抽签决定，抽中谁就用谁的账号主持。` : '') +
    (botCommands && bots.size > 0 ? `\nbot 也可以发「${prefix} <游戏>」开房、「${prefix} 开局」开局。` : '') +
    (mainPlays ? `\n${main.name} 也会报名当玩家；抽不出别的裁判时它坐庄。` : '') +
    (autoStart > 0 ? `\n报名够人后 ${autoStart} 秒没有新人加入就自动开局；开房时写人数（如「${prefix} 狼人杀 7」）则凑满立刻开局。` : '') +
    (lobbyTimeout > 0 ? `\n人数不够时 ${fmtDuration(lobbyTimeout)} 没有新人报名，房间自动取消。` : '');

  function fmtDuration(sec: number): string {
    if (sec % 60 === 0) return `${sec / 60} 分钟`;
    return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
  }

  async function refreshGame(): Promise<void> {
    const r = await main.engine.call('list_games', { group_id: opts.groupId });
    const g = (r.games ?? []).find((x: Json) => x.status === 'lobby' || x.status === 'running');
    if (!g) {
      if (st.game) log(`[referee] 对局 ${st.game.id} 已结束`);
      st.game = null;
      st.active = null;
      st.lastSeq = -1;
      return;
    }
    const fresh = st.game?.id !== g.game_id;
    if (fresh) {
      st.lastSeq = -1;
      st.lobby = { count: -1, changedAt: 0, announced: false };
      st.takeoverAt = 0;
    }
    const lobby: Json[] = g.lobby ?? [];
    st.game = {
      id: String(g.game_id),
      status: g.status,
      host: String(g.host ?? ''),
      players: Number(g.players ?? 0),
      min: Number(g.min_players ?? 0),
      max: Number(g.max_players ?? 0),
      target: fresh ? undefined : st.game?.target,
      refereeId: g.referee_id ? String(g.referee_id) : null,
      hostedBy: g.referee_hosted_by ? String(g.referee_hosted_by) : null,
      refereeIdleS: typeof g.referee_idle_s === 'number' ? g.referee_idle_s : null,
      hosted: new Set(lobby.filter((e) => e.hosted).map((e) => String(e.id))),
      lobbyIds: new Set(lobby.map((e) => String(e.id))),
      lobbyPref: new Map(lobby.map((e) => [String(e.id), String(e.join_as ?? 'player')])),
      mainIsPlayer:
        g.status === 'lobby'
          ? mainPlays && lobby.some((e) => String(e.id) === main.id && e.join_as !== 'referee')
          : (!fresh && st.game?.mainIsPlayer) || false,
    };
    if (g.status === 'lobby') {
      // 主账号参赛模式下不自动当裁判候选：它的模型自己报名；抽不出别的裁判时再在开局前改回裁判（见 ensureReferee）
      if (!follower && !mainPlays && !st.game.lobbyIds.has(main.id)) {
        const j = await main.engine.call('join_game', { game_id: g.game_id, join_as: 'referee' });
        log(`[referee] 已以裁判身份加入 ${g.game_id}`);
        st.game.lobbyIds.add(main.id);
        if (j.group_message) await say(j.group_message);
      }
      await offerVoices();
    } else {
      // 本局裁判是我的账号，且没有别的进程在代行（没登记过代行时 hostedBy 为空，也是我来）
      const mine = voiceOf(st.game.refereeId);
      const next = mine && (!st.game.hostedBy || st.game.hostedBy === hostId) ? mine : null;
      const key = `${st.game.id}:${st.game.refereeId}:${st.game.hostedBy ?? ''}`;
      if (next !== st.active || key !== st.noted) {
        st.active = next;
        st.noted = key;
        if (next) log(`[referee] 本局裁判 ${next.name}(${next.id}) 由本进程代行`);
        else if (mine) log(`[referee] 本局裁判 ${mine.name} 由别的进程（${st.game.hostedBy ?? '它自己'}）代行，本进程只旁观`);
        else log(`[referee] 本局裁判 ${g.referee ?? '?'} 不是本进程的账号，本进程只旁观（可候补接管）`);
      }
    }
    wake?.();
  }

  /** 向引擎登记：报名了的、本进程能替它说话的账号，抽中就由本进程代行。 */
  async function offerVoices(): Promise<void> {
    const g = st.game;
    if (!g || g.status !== 'lobby') return;
    for (const v of voices) {
      if (!v.id || g.hosted.has(v.id)) continue;
      // 主账号：默认直接进池（它是开房的嗓子）；跟随模式和参赛模式下它和别的账号一样，报名了才进池
      if (v.main && !follower && !mainPlays ? !selfInPool : !g.lobbyIds.has(v.id)) continue;
      try {
        await v.engine.call('referee_offer', { game_id: g.id, host_id: hostId });
        g.hosted.add(v.id);
        log(`[referee] 已登记 ${v.name}(${v.id}) 进裁判抽签池`);
      } catch (e) {
        if (e instanceof ToolError) log(`[referee] 登记 ${v.name} 代行失败：${e.message}`);
        else throw e;
      }
    }
  }

  /** 开局时把抽签结果画成转盘图发群里（只是展示，结果以引擎为准）。 */
  async function postWheel(draw: Json | null | undefined, gameId: string): Promise<void> {
    if (!wheelImage || !draw || !Array.isArray(draw.candidates) || draw.candidates.length < 2) return;
    const names: string[] = draw.candidates.map((c: Json) => String(c.name ?? c.id));
    const picked = draw.candidates.findIndex((c: Json) => String(c.id) === String(draw.picked));
    if (picked < 0) return;
    try {
      const png = renderWheel({ options: names, picked, title: '抽裁判', footer: `程序抽签 · 对局 ${gameId}`, fontPath: opts.wheelFont });
      await sendGroupAs(main, [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }]);
    } catch (e) {
      log(`[referee] 转盘图没画出来：${errMsg(e)}`);
    }
  }

  /** 开局（指令或自动）。 */
  async function startNow(why: string): Promise<void> {
    if (!st.game || st.game.status !== 'lobby') return;
    await ensureReferee();
    await offerVoices();
    log(`[referee] 开局 ${st.game.id}（${why}）`);
    const r = await main.engine.call('start_game', { game_id: st.game.id });
    await postWheel(r.referee_draw, st.game.id);
    if (r.group_message) await sendGroupAs(main, [{ type: 'text', data: { text: String(r.group_message) } }]);
    await refreshGame();
  }

  /**
   * 开局前的人数核算。主账号参赛模式下，若除主账号外抽不出裁判（没有别的候选，或抽走一个玩家后人数不够），
   * 主账号就得坐庄：它报名了玩家的话，有效人数要减一。
   */
  function plan(g: CurrentGame): { effective: number; mainSitsOut: boolean } {
    if (!mainPlays) return { effective: g.players, mainSitsOut: false };
    const otherCandidate = [...g.lobbyIds].some((id) => {
      if (id === main.id) return false;
      const pref = g.lobbyPref.get(id);
      if (pref === 'referee' || pref === 'either') return true;
      return g.hosted.has(id) && g.players - 1 >= g.min;
    });
    const mainSitsOut = !otherCandidate;
    return { effective: g.players - (mainSitsOut && g.mainIsPlayer ? 1 : 0), mainSitsOut };
  }

  /** 主账号参赛模式：开局前抽不出别的裁判时，把主账号改成裁判候选（它这局坐庄）。 */
  async function ensureReferee(): Promise<void> {
    const g = st.game;
    if (!mainPlays || !g || g.status !== 'lobby') return;
    const { mainSitsOut } = plan(g);
    if (!mainSitsOut) return;
    const wasPlayer = g.mainIsPlayer;
    await main.engine.call('join_game', { game_id: g.id, join_as: 'referee' });
    g.lobbyIds.add(main.id);
    g.lobbyPref.set(main.id, 'referee');
    g.mainIsPlayer = false;
    if (wasPlayer) {
      g.players -= 1;
      log(`[referee] 抽不出别的裁判，${main.name} 退出玩家席改当裁判`);
      await say(`人数只够开局、抽不出别的裁判：${main.name} 这局不玩了，坐庄当裁判。`);
    } else {
      log(`[referee] 已以裁判身份加入 ${g.id}`);
    }
  }

  /** 自动开局：报名够人且一段时间没有新人就开；凑满目标人数或上限立刻开。人数不够且长时间没人报名则取消房间。 */
  async function maybeAutoStart(): Promise<void> {
    const g = st.game;
    if (!g || g.status !== 'lobby') return;
    const now = Date.now();
    if (g.players !== st.lobby.count) st.lobby = { count: g.players, changedAt: now, announced: false };
    const { effective } = plan(g);
    if (effective < g.min) {
      if (lobbyTimeout > 0 && now - st.lobby.changedAt >= lobbyTimeout * 1000) {
        log(`[referee] 房间 ${g.id} 报名 ${fmtDuration(lobbyTimeout)} 没凑够人，取消`);
        await main.engine.call('abort_game', { game_id: g.id, reason: `报名 ${fmtDuration(lobbyTimeout)} 没凑够人` });
        await say(`⌛ 房间 ${g.id} 报名 ${fmtDuration(lobbyTimeout)} 只有 ${effective} 人（最少 ${g.min} 人），已取消。想玩再发「${prefix} <游戏>」开房。`);
        await refreshGame();
      }
      return;
    }
    if (autoStart <= 0) return;
    if ((g.target && effective >= g.target) || (g.max > 0 && effective >= g.max)) return startNow(`已凑满 ${effective} 人`);
    if (!st.lobby.announced) {
      st.lobby.announced = true;
      await say(`已有 ${effective} 人报名（最少 ${g.min} 人）。${autoStart} 秒内没有新人加入就自动开局；发「${prefix} 开局」可以立即开始。`);
      return;
    }
    if (now - st.lobby.changedAt >= autoStart * 1000) await startNow(`${effective} 人报名，${autoStart} 秒无人加入`);
  }

  /** 本局裁判是别的进程/别的 AI 时：它失联了就用主账号接管（引擎会核对失联时限和候补资格）。 */
  async function maybeTakeover(): Promise<void> {
    const g = st.game;
    if (!g || g.status !== 'running' || st.active || !main.id || g.refereeId === main.id || g.mainIsPlayer) return;
    if (g.refereeIdleS === null || g.refereeIdleS < 60) return;
    if (Date.now() - st.takeoverAt < 15_000) return;
    st.takeoverAt = Date.now();
    try {
      const r = await main.engine.call('referee_takeover', { game_id: g.id, host_id: hostId });
      log(`[referee] 已接管对局 ${g.id}：${r.message ?? ''}`);
      st.lastSeq = -1;
      await refreshGame();
    } catch (e) {
      if (e instanceof ToolError) log(`[referee] 暂不能接管：${e.message}`);
      else throw e;
    }
  }

  async function handleCommand(uid: string, nick: string, rest: string, fromBot = false): Promise<void> {
    const [head, ...tail] = rest.split(/\s+/).filter(Boolean);
    // bot 账号（--bot-commands）可以开房、开局，但不能中止别人的对局
    const canAdmin = fromBot || admins.size === 0 || admins.has(uid);
    try {
      switch (head) {
        case undefined:
        case '帮助':
        case 'help':
        case '?':
          await say(help);
          return;
        case '状态':
        case 'status': {
          await refreshGame();
          if (!st.game) {
            await say('本群现在没有对局。');
            return;
          }
          const r = await main.engine.call('list_games', { group_id: opts.groupId });
          const g = (r.games ?? []).find((x: Json) => x.game_id === st.game!.id) ?? {};
          await say(
            `对局 ${st.game.id}：${g.name ?? ''}，${st.game.status === 'lobby' ? '报名中' : '进行中'}，${g.players ?? 0} 人` +
              (g.phase ? `，当前：${g.phase}` : '') +
              (g.referee ? `，裁判：${g.referee}` : '') +
              (st.game.status === 'lobby' ? `。发「加入」报名，发「${prefix} 开局」开始。` : '。'),
          );
          return;
        }
        case '规则':
        case 'rules': {
          const r = await main.engine.call('get_rules', tail[0] ? { game_type: tail[0] } : {});
          const text: string = r.rules ?? r.overview ?? JSON.stringify(r);
          await say(text.length > 900 ? `${text.slice(0, 900)}…` : text);
          return;
        }
        case '开局':
        case 'start': {
          if (!canAdmin) return void (await sayTo(uid, '只有管理员能开局。'));
          await refreshGame();
          if (!st.game) return void (await say(`本群没有报名中的对局。先发「${prefix} 狼人杀」这样的指令开房。`));
          if (st.game.status !== 'lobby') return void (await say('对局已经开始了。'));
          await startNow(`${nick} 发了开局指令`);
          return;
        }
        case '中止':
        case 'abort':
        case '结束': {
          if (!canAdmin || fromBot) return void (await sayTo(uid, '只有管理员能中止对局。'));
          await refreshGame();
          if (!st.game) return void (await say('本群没有进行中的对局。'));
          const wasLobby = st.game.status === 'lobby';
          const r = await main.engine.call('abort_game', { game_id: st.game.id, reason: `${nick} 中止` });
          if (wasLobby) await say('已取消报名中的对局。');
          else if (r.group_message) await say(String(r.group_message));
          await refreshGame();
          return;
        }
        default: {
          if (!canAdmin) return void (await sayTo(uid, '只有管理员能开房。'));
          await refreshGame();
          if (st.game) return void (await say(`本群已有对局 ${st.game.id}（${st.game.status === 'lobby' ? '报名中' : '进行中'}）。发「${prefix} 中止」可以结束它。`));
          // 「/桌游 狼人杀 7 win_mode=all」：单独的数字是目标人数，其余是选项
          const target = tail.find((t) => /^\d+$/.test(t));
          let options: Record<string, unknown>;
          try {
            options = { ...(opts.defaultOptions ?? {}), ...parseOptionTokens(tail.filter((t) => !/^\d+$/.test(t))) };
          } catch {
            return void (await say('选项格式不对：用 key=value，或者一个 JSON 对象。'));
          }
          const r = await main.engine.call('create_game', { game_type: head, group_id: opts.groupId, join_as: 'referee', options });
          const id = String(r.summary?.game_id ?? r.game_id ?? '');
          const sum = r.summary ?? {};
          st.game = {
            id,
            status: 'lobby',
            host: main.id,
            players: Number(sum.players ?? 0),
            min: Number(sum.min_players ?? 0),
            max: Number(sum.max_players ?? 0),
            target: target ? Number(target) : undefined,
            refereeId: null,
            hostedBy: null,
            refereeIdleS: null,
            hosted: new Set(),
            lobbyIds: new Set([main.id]),
            lobbyPref: new Map([[main.id, 'referee']]),
            mainIsPlayer: false,
          };
          st.lastSeq = -1;
          st.lobby = { count: -1, changedAt: 0, announced: false };
          st.active = null;
          log(`[referee] 已开房 ${id}（${head}${target ? `，目标 ${target} 人` : ''}）`);
          await offerVoices();
          const howStart = target
            ? `凑满 ${target} 人自动开局`
            : autoStart > 0
              ? `报名够人后 ${autoStart} 秒没有新人就自动开局`
              : `人齐后发「${prefix} 开局」`;
          await say(`${r.group_message ?? `已开房 ${id}`}\n发「加入」报名；${howStart}。`);
          // 只有被 @ 才会醒来的聊天 bot：点名请它们报名
          if (bots.size > 0) {
            await sendGroup([
              ...[...bots].flatMap((qq) => [
                { type: 'at', data: { qq } },
                { type: 'text', data: { text: ' ' } },
              ]),
              { type: 'text', data: { text: `AI 玩家请调用 join_game(game_id="${id}", join_as="player") 报名。` } },
            ]);
          }
          return;
        }
      }
    } catch (e) {
      if (e instanceof ToolError) await say(`⚠️ ${e.message}`);
      else throw e;
    }
  }

  /** 转交真人消息：报名阶段用主账号，进行中用本局裁判账号（带 host_id）。 */
  async function relay(uid: string, nick: string, cq: string, channel: 'group' | 'private'): Promise<Json | null> {
    const g = st.game;
    if (!g) return null;
    if (g.status === 'lobby') {
      if (channel === 'private' || follower) return null;
      return main.engine.call('relay_human_message', { game_id: g.id, qq_id: uid, nickname: nick, text: cq, channel });
    }
    if (!st.active) return null; // 本局裁判不是我的账号：它的进程会转交
    return st.active.engine.call('relay_human_message', { game_id: g.id, qq_id: uid, nickname: nick, text: cq, channel, host_id: hostId });
  }

  async function handleGroup(uid: string, nick: string, cq: string): Promise<void> {
    const plain = cqToPlain(cq);
    if (plain.startsWith(prefix)) return follower ? undefined : handleCommand(uid, nick, plain.slice(prefix.length).trim());
    const r = await relay(uid, nick, cq, 'group');
    if (!r || !st.game) return;
    if (st.game.status === 'lobby') {
      if (r.accepted && r.message) await say(r.message);
      return;
    }
    if (r.recognized && !r.accepted && r.message) await sayTo(uid, r.message);
  }

  async function handlePrivate(uid: string, nick: string, cq: string): Promise<void> {
    if (!st.game || st.game.status !== 'running') return;
    const r = await relay(uid, nick, cq, 'private');
    if (r?.recognized) log(`[referee] 私聊指令 ${uid}：${r.accepted ? '已接受' : '未生效'}`);
  }

  // 收到的消息按先后顺序处理，避免乱序转交
  let inbound: Promise<void> = Promise.resolve();
  function onEvent(v: Voice, ev: Json): void {
    if (ev.post_type !== 'message') return;
    const uid = String(ev.user_id ?? '');
    if (!uid) return;
    const nick = String(ev.sender?.card || ev.sender?.nickname || uid).trim() || uid;
    const cq = segmentsToCq(ev.message ?? ev.raw_message ?? '');
    let job: () => Promise<void>;
    if (bots.has(uid)) {
      // bot 账号的话从不转交；开了 --bot-commands 才认它们的「/桌游」指令（跟随模式不响应任何指令）。
      // 先于「自己的账号」判断：玩家 bot 往往同时是本进程的嗓子账号，它们自己说的话也要能当指令
      if (!botCommands || follower || ev.message_type !== 'group' || String(ev.group_id) !== opts.groupId) return;
      const plain = cqToPlain(cq);
      if (!plain.startsWith(prefix)) return;
      if (dedupe(`${ev.group_id}:${ev.message_id ?? `${uid}:${cq}`}`)) return;
      job = () => handleCommand(uid, nick, plain.slice(prefix.length).trim(), true);
    } else if (myIds().has(uid)) {
      return; // 本进程自己账号发的话
    } else if (ev.message_type === 'group') {
      if (String(ev.group_id) !== opts.groupId) return;
      if (dedupe(`${ev.group_id}:${ev.message_id ?? `${uid}:${cq}`}`)) return;
      job = () => handleGroup(uid, nick, cq);
    } else if (ev.message_type === 'private') {
      // 夜间行动是私聊「本局裁判」：只认发给正在主持的那个账号的私聊
      if (st.active && v !== st.active) return;
      job = () => handlePrivate(uid, nick, cq);
    } else return;
    inbound = inbound.then(job, job).catch((e) => log(`[referee] 处理消息失败：${errMsg(e)}`));
  }

  async function deliver(v: Voice, d: Json): Promise<void> {
    if (d.to === 'group') await sendGroupAs(v, d.message);
    else if (d.to === 'private') await sendPrivateAs(v, String(d.user_id), String(d.text ?? ''));
  }

  const stop = () => {
    stopped = true;
    wake?.();
    for (const v of voices) v.onebot.close();
  };
  opts.signal?.addEventListener('abort', stop, { once: true });

  try {
    for (const v of voices) {
      const who = await v.engine.call('whoami');
      v.id = String(who.identity?.id ?? '');
      v.name = String(who.identity?.name ?? '');
      if (!v.id) throw new Error(`引擎没有返回${v.main ? '' : '嗓子账号的'}身份：请用 keys 模式并提供密钥。`);
      v.onebot.start();
    }
    log(
      `[referee] 身份 ${main.name}(${main.id})，群 ${opts.groupId}，引擎 ${opts.url}，host_id ${hostId}${follower ? '，跟随模式' : ''}${botCommands && bots.size > 0 ? '，bot 可开房' : ''}${mainPlays ? '，主账号参赛' : ''}` +
        (voices.length > 1 ? `，嗓子账号：${voices.filter((v) => !v.main).map((v) => `${v.name}(${v.id})`).join('、')}` : ''),
    );

    let recovering = false;
    while (!stopped) {
      try {
        const cur = st.game;
        if (!cur) {
          await refreshGame();
          if (!st.game && !stopped) await idle(5000);
          continue;
        }
        if (cur.status === 'lobby') {
          await idle(3000);
          if (!stopped) await refreshGame();
          if (!stopped && !follower) await maybeAutoStart();
          continue;
        }
        const active = st.active;
        if (!active) {
          // 旁观：别的进程在主持。它失联了就接管
          await idle(10_000);
          if (!stopped) await refreshGame();
          if (!stopped && !follower) await maybeTakeover();
          continue;
        }
        const args: Json = { game_id: cur.id, wait_seconds: recovering ? 0 : stepWait, format: 'onebot', host_id: hostId };
        let r = await active.engine.call('referee_step', args, (stepWait + 40) * 1000);
        if (r.hosted) {
          // 引擎认为代行者不是我（比如 host_id 变了）：退回旁观
          log(`[referee] 引擎不接受本进程代行（${r.next_call_hint ?? ''}）`);
          st.active = null;
          await idle(5000);
          continue;
        }
        if (recovering) {
          recovering = false;
          // 传输失败后的第一次调用：响应若在途中丢过，引擎游标会越过没发出的消息，用 since_seq 补发
          const ds: Json[] = r.deliveries ?? [];
          const first = ds[0]?.seq as number | undefined;
          const lost = st.lastSeq >= 0 && ((first !== undefined && first > st.lastSeq + 1) || (ds.length === 0 && typeof r.last_seq === 'number' && r.last_seq > st.lastSeq));
          if (lost) {
            log(`[referee] 补发 seq>${st.lastSeq} 的消息`);
            r = await active.engine.call('referee_step', { game_id: cur.id, wait_seconds: 0, format: 'onebot', since_seq: st.lastSeq, host_id: hostId }, 30_000);
          }
        }
        for (const d of r.deliveries ?? []) {
          if (typeof d.seq === 'number' && d.seq <= st.lastSeq) continue;
          if (typeof d.seq === 'number') st.lastSeq = d.seq;
          await deliver(active, d);
        }
        if (r.finished) {
          log(`[referee] 对局 ${cur.id} 结束，消息已全部发出`);
          st.game = null;
          st.active = null;
          st.lastSeq = -1;
        }
      } catch (e) {
        if (stopped) break;
        if (e instanceof TransportError) {
          log(`[referee] 引擎连接问题：${e.message}，1 秒后重试`);
          recovering = true;
          await idle(1000);
        } else if (e instanceof ToolError) {
          log(`[referee] 引擎拒绝：${e.message}`);
          try {
            await refreshGame();
          } catch {
            /* 下一轮再试 */
          }
          await idle(2000);
        } else {
          log(`[referee] 未预期的错误：${errMsg(e)}`);
          await idle(2000);
        }
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', stop);
    for (const v of voices) v.onebot.close();
    await sendChain;
    await Promise.all(voices.map((v) => v.engine.drop()));
  }
}
