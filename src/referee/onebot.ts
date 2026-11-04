/**
 * 代码驱动的裁判：把 bot-game-mcp 引擎接到一个 OneBot v11 账号上（正向 WebSocket，Universal 角色）。
 *
 *   bot-game-mcp referee --url http://127.0.0.1:7700/mcp --key 密钥 \
 *       --onebot ws://127.0.0.1:3001/ [--onebot-token-file 文件] --group 群号 \
 *       [--admins QQ,QQ] [--bots QQ,QQ] [--options '{"nudge_ai":true}']
 *
 * 它只是一条消息总线：
 *  - 引擎要发的消息（referee_step）按顺序发到群里，或私聊给对应的真人；
 *  - 真人在群里、私聊里说的话原样转交给引擎（relay_human_message），由引擎解析；
 *  - 群里的「/桌游 …」指令用来开房、开局、中止、看状态和规则。
 * 身份、座位、结算全由引擎决定，本进程没有任何能影响结果的接口。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from '../version.js';

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
  /** 开房时的默认选项（指令里写的选项会覆盖） */
  defaultOptions?: Record<string, unknown>;
  /** referee_step 的长轮询秒数（1~50），默认 25 */
  stepWaitSeconds?: number;
  /** 指令前缀，默认「/桌游」 */
  commandPrefix?: string;
  /** 两条 QQ 消息之间的最小间隔（毫秒），默认 300 */
  sendGapMs?: number;
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
}

export async function runReferee(opts: RefereeOptions): Promise<void> {
  const log: Log = opts.log ?? ((l) => process.stderr.write(`${l}\n`));
  const prefix = opts.commandPrefix ?? '/桌游';
  const admins = new Set(opts.admins ?? []);
  const bots = new Set(opts.bots ?? []);
  const stepWait = Math.max(1, Math.min(50, opts.stepWaitSeconds ?? 25));
  const sendGap = opts.sendGapMs ?? 300;
  const engine = new Engine(opts.url, opts.key, log);

  let stopped = false;
  let me = { id: '', name: '' };
  // 放在对象里：闭包里会改它们，用裸 let 的话 TypeScript 的类型收窄会出错
  const st: { game: CurrentGame | null; lastSeq: number } = { game: null, lastSeq: -1 }; // lastSeq：本局已发出的最后一条 seq；-1 = 未知
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

  // 所有往 QQ 发的消息排成一队，保证顺序和间隔
  let sendChain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const next = sendChain.then(fn, fn);
    sendChain = next.catch(() => undefined);
    return next;
  };
  const sendGroup = (message: unknown) =>
    enqueue(async () => {
      try {
        await onebot.call('send_group_msg', { group_id: Number(opts.groupId), message });
      } catch (e) {
        log(`[referee] 群消息发送失败：${errMsg(e)}`);
      }
      await pause(sendGap);
    });
  const sendPrivate = (userId: string, text: string) =>
    enqueue(async () => {
      try {
        await onebot.call('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text } }] });
      } catch (e) {
        log(`[referee] 私聊发送失败（${userId}）：${errMsg(e)}`);
      }
      await pause(sendGap);
    });
  const say = (text: string) => sendGroup([{ type: 'text', data: { text } }]);
  const sayTo = (userId: string, text: string) =>
    sendGroup([
      { type: 'at', data: { qq: userId } },
      { type: 'text', data: { text: ` ${text}` } },
    ]);

  const help =
    `🎲 桌游指令（由程序主持，裁判不参与、不决定任何结果）：\n` +
    `${prefix} 狼人杀 | 谁是卧底 | 大话骰 | 数字炸弹 [选项，如 win_mode=all]  开房\n` +
    `${prefix} 开局 · ${prefix} 中止 · ${prefix} 状态 · ${prefix} 规则 狼人杀\n` +
    `报名：发「加入」；游戏中按提示在群里发指令（如「投3号」），夜间行动私聊我。`;

  async function refreshGame(): Promise<void> {
    const r = await engine.call('list_games', { group_id: opts.groupId });
    const g = (r.games ?? []).find((x: Json) => x.status === 'lobby' || x.status === 'running');
    if (!g) {
      if (st.game) log(`[referee] 对局 ${st.game.id} 已结束`);
      st.game = null;
      st.lastSeq = -1;
      return;
    }
    if (st.game?.id !== g.game_id) st.lastSeq = -1;
    st.game = { id: String(g.game_id), status: g.status, host: String(g.host ?? '') };
    if (g.status === 'lobby' && !(g.lobby ?? []).some((e: Json) => String(e.id) === me.id)) {
      const j = await engine.call('join_game', { game_id: g.game_id, join_as: 'referee' });
      log(`[referee] 已以裁判身份加入 ${g.game_id}`);
      if (j.group_message) await say(j.group_message);
    }
    wake?.();
  }

  async function handleCommand(uid: string, nick: string, rest: string): Promise<void> {
    const [head, ...tail] = rest.split(/\s+/).filter(Boolean);
    const canAdmin = admins.size === 0 || admins.has(uid);
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
          const r = await engine.call('list_games', { group_id: opts.groupId });
          const g = (r.games ?? []).find((x: Json) => x.game_id === st.game!.id) ?? {};
          await say(
            `对局 ${st.game.id}：${g.name ?? ''}，${st.game.status === 'lobby' ? '报名中' : '进行中'}，${g.players ?? 0} 人` +
              (g.phase ? `，当前：${g.phase}` : '') +
              (st.game.status === 'lobby' ? `。发「加入」报名，发「${prefix} 开局」开始。` : '。'),
          );
          return;
        }
        case '规则':
        case 'rules': {
          const r = await engine.call('get_rules', tail[0] ? { game_type: tail[0] } : {});
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
          const r = await engine.call('start_game', { game_id: st.game.id });
          if (r.group_message) await say(r.group_message);
          await refreshGame();
          return;
        }
        case '中止':
        case 'abort':
        case '结束': {
          if (!canAdmin) return void (await sayTo(uid, '只有管理员能中止对局。'));
          await refreshGame();
          if (!st.game) return void (await say('本群没有进行中的对局。'));
          const wasLobby = st.game.status === 'lobby';
          await engine.call('abort_game', { game_id: st.game.id, reason: `${nick} 中止` });
          if (wasLobby) await say('已取消报名中的对局。');
          await refreshGame();
          return;
        }
        default: {
          if (!canAdmin) return void (await sayTo(uid, '只有管理员能开房。'));
          await refreshGame();
          if (st.game) return void (await say(`本群已有对局 ${st.game.id}（${st.game.status === 'lobby' ? '报名中' : '进行中'}）。发「${prefix} 中止」可以结束它。`));
          let options: Record<string, unknown>;
          try {
            options = { ...(opts.defaultOptions ?? {}), ...parseOptionTokens(tail) };
          } catch {
            return void (await say('选项格式不对：用 key=value，或者一个 JSON 对象。'));
          }
          const r = await engine.call('create_game', { game_type: head, group_id: opts.groupId, join_as: 'referee', options });
          const id = String(r.summary?.game_id ?? r.game_id ?? '');
          st.game = { id, status: 'lobby', host: me.id };
          st.lastSeq = -1;
          log(`[referee] 已开房 ${id}（${head}）`);
          await say(`${r.group_message ?? `已开房 ${id}`}\n发「加入」报名；人齐后发「${prefix} 开局」。`);
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

  async function handleGroup(uid: string, nick: string, cq: string): Promise<void> {
    const plain = cqToPlain(cq);
    if (plain.startsWith(prefix)) return handleCommand(uid, nick, plain.slice(prefix.length).trim());
    if (!st.game) return;
    const r = await engine.call('relay_human_message', { game_id: st.game.id, qq_id: uid, nickname: nick, text: cq, channel: 'group' });
    if (st.game.status === 'lobby') {
      if (r.accepted && r.message) await say(r.message);
      return;
    }
    if (r.recognized && !r.accepted && r.message) await sayTo(uid, r.message);
  }

  async function handlePrivate(uid: string, nick: string, cq: string): Promise<void> {
    if (!st.game || st.game.status !== 'running') return;
    const r = await engine.call('relay_human_message', { game_id: st.game.id, qq_id: uid, nickname: nick, text: cq, channel: 'private' });
    if (r.recognized) log(`[referee] 私聊指令 ${uid}：${r.accepted ? '已接受' : '未生效'}`);
  }

  // 收到的消息按先后顺序处理，避免乱序转交
  let inbound: Promise<void> = Promise.resolve();
  const onEvent = (ev: Json) => {
    if (ev.post_type !== 'message') return;
    const uid = String(ev.user_id ?? '');
    if (!uid || uid === me.id || bots.has(uid)) return;
    const nick = String(ev.sender?.card || ev.sender?.nickname || uid).trim() || uid;
    const cq = segmentsToCq(ev.message ?? ev.raw_message ?? '');
    let job: () => Promise<void>;
    if (ev.message_type === 'group') {
      if (String(ev.group_id) !== opts.groupId) return;
      job = () => handleGroup(uid, nick, cq);
    } else if (ev.message_type === 'private') {
      job = () => handlePrivate(uid, nick, cq);
    } else return;
    inbound = inbound.then(job, job).catch((e) => log(`[referee] 处理消息失败：${errMsg(e)}`));
  };
  const onebot = new OneBot(opts.onebotUrl, opts.onebotToken, onEvent, log);

  async function deliver(d: Json): Promise<void> {
    if (d.to === 'group') await sendGroup(d.message);
    else if (d.to === 'private') await sendPrivate(String(d.user_id), String(d.text ?? ''));
  }

  const stop = () => {
    stopped = true;
    wake?.();
    onebot.close();
  };
  opts.signal?.addEventListener('abort', stop, { once: true });

  try {
    const who = await engine.call('whoami');
    me = { id: String(who.identity?.id ?? ''), name: String(who.identity?.name ?? '') };
    if (!me.id) throw new Error('引擎没有返回身份：请用 keys 模式并提供裁判的密钥。');
    log(`[referee] 身份 ${me.name}(${me.id})，群 ${opts.groupId}，引擎 ${opts.url}`);
    onebot.start();

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
          continue;
        }
        const args: Json = { game_id: cur.id, wait_seconds: recovering ? 0 : stepWait, format: 'onebot' };
        let r = await engine.call('referee_step', args, (stepWait + 40) * 1000);
        if (recovering) {
          recovering = false;
          // 传输失败后的第一次调用：响应若在途中丢过，引擎游标会越过没发出的消息，用 since_seq 补发
          const ds: Json[] = r.deliveries ?? [];
          const first = ds[0]?.seq as number | undefined;
          const lost = st.lastSeq >= 0 && ((first !== undefined && first > st.lastSeq + 1) || (ds.length === 0 && typeof r.last_seq === 'number' && r.last_seq > st.lastSeq));
          if (lost) {
            log(`[referee] 补发 seq>${st.lastSeq} 的消息`);
            r = await engine.call('referee_step', { game_id: cur.id, wait_seconds: 0, format: 'onebot', since_seq: st.lastSeq }, 30_000);
          }
        }
        for (const d of r.deliveries ?? []) {
          if (typeof d.seq === 'number' && d.seq <= st.lastSeq) continue;
          if (typeof d.seq === 'number') st.lastSeq = d.seq;
          await deliver(d);
        }
        if (r.finished) {
          log(`[referee] 对局 ${cur.id} 结束，消息已全部发出`);
          st.game = null;
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
    onebot.close();
    await sendChain;
    await engine.drop();
  }
}
