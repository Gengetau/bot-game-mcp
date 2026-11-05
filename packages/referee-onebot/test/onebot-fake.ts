/**
 * 测试用的假 OneBot v11 正向 WebSocket 服务器（Universal）：
 * 只实现文本帧、ping/pong 和 close，够裁判进程用。记录收到的 API 调用，并能向客户端推送事件。
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ApiCall {
  action: string;
  params: any;
  echo?: string;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrame(b: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (b.length < 2) return null;
  const opcode = b[0]! & 0x0f;
  const masked = (b[1]! & 0x80) !== 0;
  let len = b[1]! & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  let mask: Buffer | null = null;
  if (masked) {
    if (b.length < off + 4) return null;
    mask = b.subarray(off, off + 4);
    off += 4;
  }
  if (b.length < off + len) return null;
  const payload = Buffer.from(b.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { opcode, payload, size: off + len };
}

export class FakeOneBot {
  readonly calls: ApiCall[] = [];
  url = '';
  private server: Server | null = null;
  private readonly sockets = new Set<Duplex>();
  private msgId = 0;
  private waiters: { pred: (c: ApiCall) => boolean; resolve: (c: ApiCall) => void }[] = [];
  private connWaiters: (() => void)[] = [];
  /** 对某些 action 返回失败（测试发送失败时的容错） */
  failActions = new Set<string>();
  /** 按调用内容决定是否失败（比如 @ 了某个解析不了的号） */
  failWhen: ((call: ApiCall) => boolean) | null = null;

  constructor(private readonly token?: string) {}

  async start(): Promise<string> {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? u.searchParams.get('access_token') ?? '';
      if (this.token && auth !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1').update(key + GUID).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      this.attach(socket, head);
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.server = server;
    this.url = `ws://127.0.0.1:${port}/`;
    return this.url;
  }

  private attach(socket: Duplex, head: Buffer): void {
    this.sockets.add(socket);
    for (const w of this.connWaiters.splice(0)) w();
    let buf = head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = parseFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.size);
        if (f.opcode === 1) this.onText(socket, f.payload.toString('utf8'));
        else if (f.opcode === 8) {
          try {
            socket.write(frame(8, f.payload.subarray(0, 2)));
          } catch {
            /* 已关闭 */
          }
          socket.end();
        } else if (f.opcode === 9) socket.write(frame(10, f.payload));
      }
    });
    const gone = () => this.sockets.delete(socket);
    socket.on('close', gone);
    socket.on('error', gone);
  }

  private onText(socket: Duplex, text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const call: ApiCall = { action: String(msg.action), params: msg.params ?? {}, echo: msg.echo };
    this.calls.push(call);
    for (const w of this.waiters.splice(0)) {
      if (w.pred(call)) w.resolve(call);
      else this.waiters.push(w);
    }
    const fail = this.failActions.has(call.action) || Boolean(this.failWhen?.(call));
    const reply = fail
      ? { status: 'failed', retcode: 1400, wording: '假装失败', echo: msg.echo }
      : { status: 'ok', retcode: 0, data: { message_id: ++this.msgId }, echo: msg.echo };
    socket.write(frame(1, Buffer.from(JSON.stringify(reply))));
  }

  get connections(): number {
    return this.sockets.size;
  }

  waitForConnection(timeoutMs = 5000): Promise<void> {
    if (this.sockets.size > 0) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('没有客户端连上来')), timeoutMs);
      this.connWaiters.push(() => {
        clearTimeout(t);
        res();
      });
    });
  }

  /** 向所有客户端推送一个事件 */
  emit(event: Record<string, unknown>): void {
    const data = frame(1, Buffer.from(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: 0, ...event })));
    for (const s of this.sockets) s.write(data);
  }

  /** 等待一个满足条件的 API 调用（包括从 after 起已经收到的） */
  waitForCall(pred: (c: ApiCall) => boolean, timeoutMs = 10_000, after = 0): Promise<ApiCall> {
    const hit = this.calls.slice(after).find(pred);
    if (hit) return Promise.resolve(hit);
    const where = (new Error().stack ?? '').split('\n').find((l) => l.includes('.test.ts')) ?? '';
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`等待 OneBot 调用超时（${this.calls.length} 条调用）${where.trim()}`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (c) => {
          clearTimeout(t);
          res(c);
        },
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
  }
}

/** 消息段里的纯文本（@ 显示为 @qq） */
export function callText(c: ApiCall): string {
  const m = c.params?.message;
  if (typeof m === 'string') return m;
  if (!Array.isArray(m)) return '';
  return m.map((s: any) => (s.type === 'text' ? String(s.data?.text ?? '') : s.type === 'at' ? `@${s.data?.qq}` : `[${s.type}]`)).join('');
}
