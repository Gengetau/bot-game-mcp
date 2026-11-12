/**
 * 栖灯镇的空间同步通道：WebSocket /town/ws。
 *
 * 只做「实时画面」和「事件推送」，耐久动作一律走 HTTP（/town/api/actions）。
 * 连接本身不带身份（不信任 Cookie）：先用 POST /town/api/ws-ticket 取一次性票据，连上后第一条消息是 hello。
 *
 * 客户端 → 服务器（JSON 文本帧，单帧 ≤ 4 KiB）：
 *   {t:'hello', v:1, ticket, cursor?}          5 秒内必须发，只能发一次
 *   {t:'ping', n}                              → {t:'pong', n, serverTime}
 *   {t:'renew', navigationId, revision}        → {t:'renewed', ok, leaseUntil?, navigation}
 *   {t:'dir', seq, epoch, x, z}                键盘方向输入（x 向东、z 向南，零向量 = 停）。成功没有回答，画面看 scene；
 *                                              被丢弃（旧序号、太频繁）→ {t:'dir_dropped', seq, reason}；
 *                                              没有控制权、不在场、在游戏里等 → {t:'error', code, message}。不带坐标
 * 服务器 → 客户端：
 *   {t:'hello', v:1, serverTime, resident, map:{mapVersion,checksum}, renewEveryMs, dirLeaseMs, cursor, townChat:{cursor}}
 *   {t:'scene', …SceneView}                    完整快照（合并发送，每秒最多 10 次）
 *   {t:'events', events, cursor} / {t:'resync', cursor}   耐久私有事件（与 SSE 同一套投影）
 *   {t:'town_chat', messages, cursor}          全镇公屏的新消息（连上之后的，不回放历史；历史走 GET /town-chat）
 *   {t:'error', code, message}
 *
 * 所有发送都发生在事务提交之后（onSpace / onResident 本来就是提交后回调）。
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { townChatHead, townChatSince } from './chat.js';
import { WorldError } from './errors.js';
import { controlDisconnected, directionInput, renewNavigation, sceneKeyOfResident, sceneView } from './space.js';
import type { WorldService } from './service.js';

export const WS_PATH = '/town/ws';

/** 连接序号：重连的新连接序号更大，它的方向输入盖过旧连接迟到的输入 */
let connectionSerial = 0;

export interface TownWsOptions {
  /** 同一 IP 同时开着的 WebSocket 上限，默认 8 */
  maxPerIp?: number;
  /** 同一居民同时开着的 WebSocket 上限，默认 4 */
  maxPerResident?: number;
  /** 连上后多久必须发 hello，默认 5000 毫秒 */
  helloTimeoutMs?: number;
  /** 两次 scene 快照之间的最短间隔，默认 100 毫秒 */
  minSceneIntervalMs?: number;
  /** 协议层 ping 的间隔，默认 30000 毫秒（两次没回 pong 就断开） */
  pingMs?: number;
  /** 票据有效期，默认 30000 毫秒 */
  ticketTtlMs?: number;
  /** 每个 principal 最多同时握着几张未用票据，默认 8 */
  maxTicketsPerPrincipal?: number;
  /** 背压：发送缓冲超过这个字节数就断开，默认 1 MiB */
  maxBufferedBytes?: number;
}

/** 取票时所在的登录会话：连接的寿命不超过它。key 只用来把连接和会话对上（传哈希，不传令牌本身）。 */
export interface TicketSession {
  key: string;
  /** 这个会话此刻还有效吗（没过期、没被撤销） */
  valid: () => boolean;
}

export interface TownWs {
  /** 取一张一次性票据（调用方已经验证过登录） */
  issueTicket(principalId: string, clientId: string, session?: TicketSession): { ticket: string; expiresAt: number };
  /** 挂上 HTTP 服务器的 upgrade 事件（只接 /town/ws） */
  attach(server: HttpServer): void;
  /** 关掉这个登录会话的所有连接并作废它没用过的票据（登出）。同一个人在别的设备上的会话不受影响 */
  closeSession(sessionKey: string): void;
  close(): void;
  /** 当前连接数（含还没 hello 的），测试用 */
  connections(): number;
}

interface Ticket {
  principalId: string;
  clientId: string;
  expiresAt: number;
  session: TicketSession | null;
}

/** 续租的令牌桶（按居民，跨她的所有连接）：正常客户端 3 秒续一次，这里留足余量 */
const RENEW_BURST = 6;
const RENEW_PER_SECOND = 2;

const MAX_FRAME = 4096;
const HELLO_KEYS_MAX = 200;

export function createTownWs(w: WorldService, log: (msg: string) => void, opts: TownWsOptions = {}): TownWs {
  const maxPerIp = opts.maxPerIp ?? 8;
  const maxPerResident = opts.maxPerResident ?? 4;
  const helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
  const minSceneMs = opts.minSceneIntervalMs ?? 100;
  const pingMs = opts.pingMs ?? 30_000;
  const ticketTtlMs = opts.ticketTtlMs ?? 30_000;
  const maxTickets = opts.maxTicketsPerPrincipal ?? 8;
  const maxBuffered = opts.maxBufferedBytes ?? 1024 * 1024;

  // ── 票据（进程内存，不落库；票据是凭据，不进日志） ──
  const tickets = new Map<string, Ticket>();
  const issueTicket: TownWs['issueTicket'] = (principalId, clientId, session) => {
    const now = w.now();
    for (const [k, t] of tickets) if (t.expiresAt <= now) tickets.delete(k);
    const mine = [...tickets.entries()].filter(([, t]) => t.principalId === principalId);
    // Map 按插入顺序迭代：最旧的在前
    for (let i = 0; i <= mine.length - maxTickets; i++) tickets.delete(mine[i]![0]);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + ticketTtlMs;
    tickets.set(ticket, { principalId, clientId, expiresAt, session: session ?? null });
    return { ticket, expiresAt };
  };
  const consumeTicket = (raw: unknown): Ticket | null => {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 100) return null;
    const t = tickets.get(raw);
    if (!t) return null;
    tickets.delete(raw); // 一次性：无论成败都作废
    return t.expiresAt > w.now() ? t : null;
  };

  // ── 连接登记 ──
  interface Conn {
    ws: WebSocket;
    ip: string;
    principalId: string | null;
    clientId: string | null;
    residentId: string | null;
    sessionKey: string | null;
    closeWith(code: number, reason: string): void;
  }
  const conns = new Set<Conn>();
  const perIp = new Map<string, number>();
  const perResident = new Map<string, number>();
  const renewBuckets = new Map<string, { tokens: number; at: number }>();
  /** 续租限流：WebSocket 上的 renew 不经过 HTTP 的限流，这里按居民另算一份。 */
  const takeRenew = (residentId: string): boolean => {
    const now = Date.now();
    const b = renewBuckets.get(residentId) ?? { tokens: RENEW_BURST, at: now };
    b.tokens = Math.min(RENEW_BURST, b.tokens + ((now - b.at) / 1000) * RENEW_PER_SECOND);
    b.at = now;
    renewBuckets.set(residentId, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  let attached: { server: HttpServer; onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void } | null = null;
  let closed = false;

  const ipOf = (req: IncomingMessage): string => {
    const direct = req.socket.remoteAddress ?? '?';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(direct)) return direct;
    const h = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const fwd = h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0];
    return fwd?.trim().slice(0, 64) || direct;
  };

  /** 握手前的拒绝：直接在 socket 上写一个 HTTP 响应。 */
  const reject = (socket: Duplex, status: number, message: string) => {
    if (!socket.writable) return void socket.destroy();
    const body = JSON.stringify({ ok: false, error: status === 429 ? 'rate_limited' : status === 503 ? 'recovering' : 'forbidden', message });
    socket.write(`HTTP/1.1 ${status} ${({ 429: 'Too Many Requests', 403: 'Forbidden', 503: 'Service Unavailable' } as Record<number, string>)[status] ?? 'Bad Request'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${status === 429 ? 'Retry-After: 1\r\n' : ''}\r\n${body}`);
    socket.destroy();
  };

  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // 非浏览器客户端：没有 Origin，但仍然必须有票据
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    const hv = (n: string) => {
      const v = req.headers[n];
      return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
    };
    const expected = hv('x-forwarded-host') || hv('host');
    if (expected && u.host === expected) return true;
    if (w.publicUrl) {
      try {
        if (u.origin === new URL(w.publicUrl).origin) return true;
      } catch {
        /* publicUrl 配置不合法就当没配 */
      }
    }
    return false;
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let path = '';
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      /* 当作别的路径 */
    }
    if (path !== WS_PATH) {
      // 别的路径不动现有行为：有别的 upgrade 监听者就留给它们，没有就和没挂监听时一样直接断开
      if (attached && attached.server.listenerCount('upgrade') <= 1) socket.destroy();
      return;
    }
    socket.on('error', () => undefined);
    if (closed) return reject(socket, 503, '服务正在关闭。');
    if (!originOk(req)) return reject(socket, 403, '跨站连接被拒绝。');
    const ip = ipOf(req);
    if (conns.size >= w.params.maxResidentStreams || (perIp.get(ip) ?? 0) >= maxPerIp) return reject(socket, 429, '连接太多，请稍后再试。');
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ip));
  };

  const bump = (m: Map<string, number>, k: string, d: number) => {
    const n = Math.max(0, (m.get(k) ?? 0) + d);
    if (n === 0) m.delete(k);
    else m.set(k, n);
  };

  function accept(ws: WebSocket, ip: string): void {
    bump(perIp, ip, 1);
    const offs: (() => void)[] = [];
    const timers: NodeJS.Timeout[] = [];
    let helloDone = false;
    let auth: { principalId: string; clientId: string } | null = null;
    let session: TicketSession | null = null;
    let residentId: string | null = null;
    let cursor: string | undefined;
    let lastKey: string | null = null;
    let lastSceneAt = 0;
    let townSeq = 0;
    let sceneTimer: NodeJS.Timeout | null = null;
    let missedPongs = 0;
    let msgWindowStart = 0;
    let msgCount = 0;
    /** 是服务器先关的（撤销、背压、限流……）：对端回什么关闭码都不算「客户端明确离开」 */
    let serverClosed = false;
    const serial = ++connectionSerial;

    const conn: Conn = {
      ws,
      ip,
      principalId: null,
      clientId: null,
      residentId: null,
      sessionKey: null,
      closeWith(code, reason) {
        serverClosed = true;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close(code, reason);
          } catch {
            ws.terminate();
          }
          // 对端不回 close 帧时不能一直挂着
          const t = setTimeout(() => ws.terminate(), 2000);
          t.unref();
        }
      },
    };
    conns.add(conn);

    const send = (msg: Record<string, unknown>): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      if (ws.bufferedAmount > maxBuffered) {
        conn.closeWith(1013, '客户端读得太慢');
        return false;
      }
      ws.send(JSON.stringify(msg));
      if (ws.bufferedAmount > maxBuffered) {
        conn.closeWith(1013, '客户端读得太慢');
        return false;
      }
      return true;
    };
    const sendError = (code: string, message: string) => send({ t: 'error', code, message });

    const sendScene = () => {
      sceneTimer = null;
      if (ws.readyState !== WebSocket.OPEN || !residentId || w.status !== 'running') return;
      try {
        const r = w.resident(residentId);
        if (!r) return;
        const now = w.now();
        // 场景键在发送时现取（人可能已经换了场景）
        lastKey = sceneKeyOfResident(w, residentId);
        lastSceneAt = Date.now();
        send({ t: 'scene', ...sceneView(w, r, now) });
      } catch (e) {
        log(`[town] ws 场景同步出错：${e instanceof Error ? e.message : String(e)}`);
      }
    };
    /** 合并：距离上一份不到 minSceneMs 就等到够间隔再发一份最新的。 */
    const scheduleScene = () => {
      if (sceneTimer || ws.readyState !== WebSocket.OPEN) return;
      const wait = Math.max(0, lastSceneAt + minSceneMs - Date.now());
      sceneTimer = setTimeout(sendScene, wait);
    };

    const pump = () => {
      if (ws.readyState !== WebSocket.OPEN || !residentId) return;
      try {
        for (let i = 0; i < 20; i++) {
          const read = w.readResidentEvents(residentId, cursor ?? w.cursorOf(residentId), 100);
          cursor = read.cursor;
          if (read.resync) {
            send({ t: 'resync', cursor });
            break;
          }
          if (read.events.length) send({ t: 'events', events: read.events.map((ev) => ({ id: ev.id, type: ev.type, at: ev.at, data: ev.data })), cursor });
          if (!read.more) break;
        }
      } catch (e) {
        log(`[town] ws 事件推送出错：${e instanceof Error ? e.message : String(e)}`);
        conn.closeWith(1011, '服务器出错');
      }
    };

    /** 公屏的新消息：连上之后才有的，按本连接自己记的位置读；内容按本人投影（id 绑定世界和本人）。 */
    const pushTownChat = () => {
      if (ws.readyState !== WebSocket.OPEN || !residentId) return;
      try {
        // 对局中的 AI 居民不收公屏（对局期间内容不进入这局 AI 的上下文）；真人的网页连接照常收。位置照样往前推，不留到以后补发
        const me = w.resident(residentId);
        if (me && me.kind === 'agent' && me.activity_id) {
          townSeq = townChatHead(w);
          return;
        }
        for (let i = 0; i < 5; i++) {
          const read = townChatSince(w, residentId, townSeq, 50);
          townSeq = read.seq;
          if (read.messages.length) send({ t: 'town_chat', messages: read.messages, cursor: read.messages[read.messages.length - 1]!.id });
          if (!read.more) break;
        }
      } catch (e) {
        log(`[town] ws 公屏推送出错：${e instanceof Error ? e.message : String(e)}`);
      }
    };

    const cleanup = () => {
      if (!conns.delete(conn)) return;
      bump(perIp, ip, -1);
      if (residentId) {
        bump(perResident, residentId, -1);
        if (!perResident.has(residentId)) renewBuckets.delete(residentId);
      }
      for (const t of timers) clearTimeout(t);
      if (sceneTimer) clearTimeout(sceneTimer);
      sceneTimer = null;
      clearInterval(pinger);
      for (const off of offs) off();
    };

    /** 取票时的登录会话过期或被撤销了：连接不能比它活得更久（和 SSE 一样）。 */
    const sessionGone = (): boolean => {
      // 世界已经关了（数据库也关了）就不去读库：连接随后由服务关闭的流程收掉
      if (!session || w.status !== 'running') return false;
      let valid = true;
      try {
        valid = session.valid();
      } catch (e) {
        log(`WebSocket 会话检查出错：${e instanceof Error ? e.message : String(e)}`);
      }
      if (valid) return false;
      sendError('revoked', '登录已失效，请重新登录。');
      conn.closeWith(4403, '会话已失效');
      return true;
    };

    const pinger = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (sessionGone()) return;
      if (missedPongs >= 2) return void ws.terminate();
      missedPongs++;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, pingMs);
    pinger.unref();
    ws.on('pong', () => {
      missedPongs = 0;
    });

    const helloTimer = setTimeout(() => {
      if (!helloDone) {
        sendError('hello_timeout', '没有及时发送 hello。');
        conn.closeWith(4408, 'hello 超时');
      }
    }, helloTimeoutMs);
    timers.push(helloTimer);

    const doHello = (m: Record<string, unknown>) => {
      if (helloDone) return void sendError('bad_request', '已经 hello 过了。');
      helloDone = true;
      clearTimeout(helloTimer);
      const t = consumeTicket(m.ticket);
      const r = t ? w.residentOfPrincipal(t.principalId) : undefined;
      if (!t || !r || w.status !== 'running' || m.v !== 1) {
        sendError(m.v !== 1 && t ? 'bad_request' : 'unauthenticated', m.v !== 1 && t ? '不支持的协议版本。' : '票据无效或已过期，请重新取票。');
        conn.closeWith(4401, '票据无效');
        return;
      }
      if ((perResident.get(r.resident_id) ?? 0) >= maxPerResident) {
        sendError('rate_limited', '这位居民的连接太多了。');
        conn.closeWith(1013, '连接太多');
        return;
      }
      if (t.session && !t.session.valid()) {
        sendError('unauthenticated', '登录已失效，请重新登录。');
        conn.closeWith(4401, '会话已失效');
        return;
      }
      auth = { principalId: t.principalId, clientId: t.clientId };
      session = t.session;
      residentId = r.resident_id;
      conn.principalId = t.principalId;
      conn.clientId = t.clientId;
      conn.residentId = r.resident_id;
      conn.sessionKey = t.session?.key ?? null;
      bump(perResident, residentId, 1);
      const given = typeof m.cursor === 'string' && m.cursor.length > 0 && m.cursor.length <= HELLO_KEYS_MAX ? m.cursor : undefined;
      cursor = given;
      const usable = given !== undefined && (() => {
        const n = w.decodeCursor('r', r.resident_id, given);
        if (n === null) return false;
        const head = w.streamHead(`r:${r.resident_id}`);
        return n <= head.highWater && n >= head.retainedFrom - 1;
      })();
      send({
        t: 'hello',
        v: 1,
        serverTime: w.now(),
        resident: r.resident_id,
        map: { mapVersion: w.map.mapVersion, checksum: w.map.checksum },
        renewEveryMs: w.params.navRenewEveryMs,
        dirLeaseMs: w.params.dirLeaseMs,
        // 坏游标不回显：随后的 resync 会给出新的
        cursor: usable ? given : w.cursorOf(r.resident_id),
        // 公屏从这一刻之后的新消息会以 town_chat 推来；要历史读 GET /town-chat
        townChat: { cursor: w.encodeCursor('c', `tc:${r.resident_id}`, townChatHead(w)) },
      });
      townSeq = townChatHead(w);
      // 先登记订阅，再发首份快照和补发事件：中间不会漏
      offs.push(
        w.onSpace((keys) => {
          const mine = sceneKeyOfResident(w, r.resident_id);
          if ((mine !== null && keys.includes(mine)) || mine !== lastKey) scheduleScene();
        }),
      );
      offs.push(w.onResident(r.resident_id, pump));
      offs.push(w.onTownChat(pushTownChat));
      offs.push(
        w.onRevoke(r.resident_id, () => {
          sendError('revoked', '会话已失效或已离开小镇。');
          conn.closeWith(4403, '已撤销');
        }),
      );
      sendScene();
      pump();
    };

    const doRenew = (m: Record<string, unknown>) => {
      if (!auth || !residentId) return;
      if (sessionGone()) return;
      if (!takeRenew(residentId)) return void sendError('rate_limited', '续租太频繁了。');
      try {
        const out = renewNavigation(w, auth, { navigationId: m.navigationId, revision: m.revision });
        send({ t: 'renewed', ...out });
      } catch (e) {
        if (e instanceof WorldError) sendError(e.code, e.message);
        else {
          log(`[town] ws 续租出错：${e instanceof Error ? e.message : String(e)}`);
          sendError('internal', '服务器出错了。');
        }
      }
    };

    const doDir = (m: Record<string, unknown>) => {
      if (!auth || !residentId) return;
      if (sessionGone()) return;
      try {
        const out = directionInput(w, auth, { seq: m.seq, epoch: m.epoch, x: m.x, z: m.z, source: serial });
        if (!out.ok) send({ t: 'dir_dropped', seq: typeof m.seq === 'number' ? m.seq : null, reason: out.reason });
      } catch (e) {
        if (e instanceof WorldError) send({ t: 'error', code: e.code, ...(e.reason ? { reason: e.reason } : {}), message: e.message });
        else {
          log(`[town] ws 方向输入出错：${e instanceof Error ? e.message : String(e)}`);
          sendError('internal', '服务器出错了。');
        }
      }
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const now = Date.now();
      if (now - msgWindowStart > 1000) {
        msgWindowStart = now;
        msgCount = 0;
      }
      if (++msgCount > 30) return void conn.closeWith(1008, '消息太频繁');
      if (isBinary) {
        sendError('bad_request', '只接受 JSON 文本帧。');
        return void conn.closeWith(1003, '只接受文本');
      }
      let m: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        m = parsed as Record<string, unknown>;
      } catch {
        return void sendError('bad_request', '消息不是合法的 JSON 对象。');
      }
      if (!helloDone) {
        if (m.t !== 'hello') {
          sendError('bad_request', '第一条消息必须是 hello。');
          return void conn.closeWith(4401, '需要 hello');
        }
        return doHello(m);
      }
      if (!auth) return; // hello 失败后正在关闭
      switch (m.t) {
        case 'hello':
          return void sendError('bad_request', '已经 hello 过了。');
        case 'ping':
          return void send({ t: 'pong', n: typeof m.n === 'number' ? m.n : null, serverTime: w.now() });
        case 'renew':
          return doRenew(m);
        case 'dir':
          return doDir(m);
        default:
          return void sendError('bad_request', '不认识的消息类型（耐久动作请走 HTTP）。');
      }
    });

    ws.on('error', () => ws.terminate());
    ws.on('close', (code: number) => {
      const a = auth;
      cleanup();
      // 客户端正常关闭（页面关了）才立即停步；异常断开让导航租约自己到期，手机网络抖一下不会立刻停。
      // 同一个客户端还有别的连接开着（重连时新旧两条并存，再把旧的关掉）就不算离开。
      const stillHere = a !== null && [...conns].some((c) => c.principalId === a.principalId && c.clientId === a.clientId);
      if (a && !serverClosed && !stillHere && (code === 1000 || code === 1001)) {
        try {
          controlDisconnected(w, a);
        } catch (e) {
          log(`[town] ws 断开处理出错：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    });
  }

  return {
    issueTicket,
    attach(server) {
      if (attached) return;
      server.on('upgrade', onUpgrade);
      attached = { server, onUpgrade };
    },
    closeSession(sessionKey) {
      for (const [k, t] of tickets) if (t.session?.key === sessionKey) tickets.delete(k);
      for (const c of [...conns]) if (c.sessionKey === sessionKey) c.closeWith(4403, '已登出');
    },
    close() {
      closed = true;
      attached?.server.off('upgrade', attached.onUpgrade);
      attached = null;
      tickets.clear();
      renewBuckets.clear();
      for (const c of [...conns]) {
        c.closeWith(1001, '服务关闭');
        c.ws.terminate();
      }
      wss.close();
    },
    connections: () => conns.size,
  };
}
