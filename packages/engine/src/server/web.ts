/**
 * 网页舞台「灯下剧场」：
 *  - GET /web/                         观战页面（静态文件，全部来自仓库，不从 CDN 加载）
 *  - GET /web/api/games/:id?t=令牌      观战视图（只含公开信息；正常结束的局附完整复盘）
 *  - GET /web/api/games/:id/stream?t=   SSE 实时推送（按公开事件序号续传）
 *  - POST /web/api/games/:id/chat?t=    观众席发言 {name, text}（参与者看不到，不进群）
 *  真人座位（s=座位令牌，开局时私聊发给本人，对局结束即作废）：
 *  - GET  /web/api/games/:id/seat?s=          本座位视图（公开部分 + 自己的私密信息、待办、私密消息；没有观众席）
 *  - GET  /web/api/games/:id/seat/stream?s=   SSE 实时推送
 *  - POST /web/api/games/:id/seat/act?s=      {text, mode: command|speech}：和私聊裁判（或群里发言）走同一套解析
 *
 * 观战令牌只能看；座位令牌只能以这个真人座位的身份下指令，和他私聊裁判的效果完全一样。令牌不对一律 404，不让人借此探测对局 ID。
 */
import { readFileSync } from 'node:fs';
import express, { type Express, type Request, type Response } from 'express';
import { GameError } from '../core/errors.js';
import type { GameManager } from '../core/manager.js';

const WEB_DIR = new URL('../../web/', import.meta.url);
const FILES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'icon.svg': 'image/svg+xml',
};

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 链接里带着观战令牌：不要通过 Referer 传给别的站
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

/** 简单的按 IP 限流：每分钟最多 limit 次。 */
function rateLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; since: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.since > windowMs) hits.delete(k);
    const h = hits.get(ip);
    if (!h || now - h.since > windowMs) {
      hits.set(ip, { n: 1, since: now });
      return true;
    }
    h.n += 1;
    return h.n <= limit;
  };
}

export interface WebOptions {
  /** 单局最多几条 SSE 连接 */
  maxStreamsPerGame?: number;
  /** 每个 IP 最多几条 SSE 连接 */
  maxStreamsPerIp?: number;
  /** 每个 IP 每分钟最多几次接口请求 */
  requestsPerMinute?: number;
  /** SSE 心跳间隔 */
  heartbeatMs?: number;
}

export function mountWeb(app: Express, manager: GameManager, log: (msg: string) => void, opts: WebOptions = {}): () => void {
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(FILES)) {
    try {
      files.set(name, readFileSync(new URL(name, WEB_DIR)));
    } catch {
      log(`[web] 缺少页面文件 web/${name}`);
    }
  }
  const maxPerGame = opts.maxStreamsPerGame ?? 60;
  const maxPerIp = opts.maxStreamsPerIp ?? 6;
  const allow = rateLimiter(opts.requestsPerMinute ?? 120);
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const streams = new Map<string, Set<() => void>>();
  const perIp = new Map<string, number>();
  // 经隧道/反代进来的请求都来自本机：这时信任代理给的客户端地址
  const ipOf = (req: Request) => {
    const direct = req.socket.remoteAddress ?? '?';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(direct)) return direct;
    const fwd = req.header('cf-connecting-ip') ?? req.header('x-forwarded-for')?.split(',')[0];
    return fwd?.trim().slice(0, 64) || direct;
  };

  const sendFile = (name: string, res: Response) => {
    const body = files.get(name);
    if (!body) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    secure(res);
    res.setHeader('Content-Type', FILES[name]!);
    res.setHeader('Cache-Control', name === 'index.html' ? 'no-cache' : 'public, max-age=300');
    res.send(body);
  };

  // 路由不区分结尾斜杠：/web 和 /web/ 走同一个处理，没斜杠的带着查询串跳到 /web/（页面里的相对路径要靠它）
  app.get('/web', (req, res) => {
    const url = req.originalUrl;
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    if (path.endsWith('/')) return sendFile('index.html', res);
    res.redirect(301, `/web/${q < 0 ? '' : url.slice(q)}`);
  });
  app.get('/web/:file', (req, res, next) => {
    const name = String(req.params.file);
    if (!(name in FILES) || name === 'index.html') return next();
    sendFile(name, res);
  });

  const notFound = (res: Response) => {
    secure(res);
    res.status(404).json({ error: 'not_found', message: '链接无效或对局不存在。' });
  };

  app.get('/web/api/games/:id', (req, res) => {
    if (!allow(ipOf(req))) {
      res.status(429).json({ error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
      return;
    }
    const rec = manager.webRecord(String(req.params.id), String(req.query.t ?? ''));
    if (!rec) return notFound(res);
    secure(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(manager.webView(rec, Number(req.query.since ?? 0), Number(req.query.chat_since ?? 0)));
  });

  // 观众席发言：必须是 JSON（别的网站没法不经预检就跨站提交 JSON），按 IP 限流
  app.post('/web/api/games/:id/chat', express.json({ limit: '4kb' }), (req, res) => {
    const ip = ipOf(req);
    if (!allow(ip)) {
      res.status(429).json({ error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
      return;
    }
    const rec = manager.webRecord(String(req.params.id), String(req.query.t ?? ''));
    if (!rec) return notFound(res);
    secure(res);
    res.setHeader('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'bad_request', message: '请从观战页面发言。' });
      return;
    }
    try {
      const r = manager.spectatorSay(rec, { kind: 'web', name: String(req.body?.name ?? ''), key: ip }, String(req.body?.text ?? ''));
      res.json({ ok: true, seq: r.seq, name: r.name });
    } catch (e) {
      if (e instanceof GameError) res.status(400).json({ error: e.code, message: e.message });
      else {
        log(`[web] 观众席出错：${e instanceof Error ? e.message : String(e)}`);
        res.status(500).json({ error: 'internal', message: '服务器出错了。' });
      }
    }
  });

  app.get('/web/api/games/:id/stream', (req, res) => {
    const ip = ipOf(req);
    if (!allow(ip)) {
      res.status(429).json({ error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
      return;
    }
    const rec = manager.webRecord(String(req.params.id), String(req.query.t ?? ''));
    if (!rec) return notFound(res);
    const set = streams.get(rec.id) ?? new Set();
    if (set.size >= maxPerGame || (perIp.get(ip) ?? 0) >= maxPerIp) {
      res.status(429).json({ error: 'too_many_streams', message: '观战连接太多了，请关掉多余的页面。' });
      return;
    }
    secure(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const resume = Number(req.header('last-event-id') ?? req.query.since ?? 0);
    let sent = Number.isFinite(resume) && resume > 0 ? Math.floor(resume) : 0;
    // 观众席另有序号：每条连接从头给（最多 200 条），页面按 seq 去重
    let chatSent = 0;
    let timer: NodeJS.Timeout | null = null;
    const push = () => {
      timer = null;
      const view = manager.webView(rec, sent, chatSent);
      sent = view.last_seq;
      chatSent = view.chat_seq;
      res.write(`id: ${view.last_seq}\nevent: view\ndata: ${JSON.stringify(view)}\n\n`);
    };
    // 对局一有变化就推（合并 200 毫秒内的多次变化）
    const schedule = () => {
      if (!timer) timer = setTimeout(push, 200);
    };
    const off = manager.onChange((id) => {
      if (id === undefined || id === rec.id) schedule();
    });
    const beat = setInterval(() => res.write(`: ping\n\n`), heartbeatMs);
    beat.unref();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      res.end();
      off();
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      set.delete(close);
      if (set.size === 0) streams.delete(rec.id);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };
    set.add(close);
    streams.set(rec.id, set);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    res.write(`retry: 3000\n\n`);
    push();
    req.on('close', close);
  });

  // ───────── 真人座位 ─────────
  app.get('/web/api/games/:id/seat', (req, res) => {
    if (!allow(ipOf(req))) {
      res.status(429).json({ error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
      return;
    }
    const hit = manager.webSeat(String(req.params.id), String(req.query.s ?? ''));
    if (!hit) return notFound(res);
    secure(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(manager.webSeatView(hit.rec, hit.seat, Number(req.query.since ?? 0), Number(req.query.mine_since ?? 0)));
  });

  // 必须是 JSON（别的网站没法不经预检就跨站提交 JSON），按 IP 限流
  app.post('/web/api/games/:id/seat/act', express.json({ limit: '8kb' }), (req, res) => {
    if (!allow(ipOf(req))) {
      res.status(429).json({ error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
      return;
    }
    const hit = manager.webSeat(String(req.params.id), String(req.query.s ?? ''));
    if (!hit) return notFound(res);
    secure(res);
    res.setHeader('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'bad_request', message: '请从座位页面提交。' });
      return;
    }
    const mode = req.body?.mode === 'speech' ? 'speech' : 'command';
    try {
      const r = manager.webSeatAct(hit.rec, hit.seat, { text: String(req.body?.text ?? ''), mode });
      res.json({ ok: true, accepted: r.accepted, recognized: r.recognized, message: r.message });
    } catch (e) {
      if (e instanceof GameError) res.status(400).json({ error: e.code, message: e.message });
      else {
        log(`[web] 座位指令出错：${e instanceof Error ? e.message : String(e)}`);
        res.status(500).json({ error: 'internal', message: '服务器出错了。' });
      }
    }
  });

  app.get('/web/api/games/:id/seat/stream', (req, res) => {
    const ip = ipOf(req);
    if (!allow(ip)) {
      res.status(429).json({ error: 'rate_limited', message: '请求太频繁，请稍后再试。' });
      return;
    }
    const hit = manager.webSeat(String(req.params.id), String(req.query.s ?? ''));
    if (!hit) return notFound(res);
    const { rec, seat } = hit;
    const key = `${rec.id}#seat`;
    const set = streams.get(key) ?? new Set();
    if (set.size >= maxPerGame || (perIp.get(ip) ?? 0) >= maxPerIp) {
      res.status(429).json({ error: 'too_many_streams', message: '连接太多了，请关掉多余的页面。' });
      return;
    }
    secure(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 每条连接从头给：私密消息和公开事件各有序号，页面按序号去重
    let sent = 0;
    let mineSent = 0;
    let timer: NodeJS.Timeout | null = null;
    let closed = false;
    const push = () => {
      timer = null;
      if (closed) return;
      const view = manager.webSeatView(rec, seat, sent, mineSent);
      sent = view.last_seq;
      mineSent = view.mine_seq;
      res.write(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
      // 对局结束：最后推一次（带结局），然后关掉，链接随之作废
      if (rec.status !== 'running') close();
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(push, 200);
    };
    const off = manager.onChange((id) => {
      if (id === undefined || id === rec.id) schedule();
    });
    const beat = setInterval(() => res.write(`: ping\n\n`), heartbeatMs);
    beat.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      res.end();
      off();
      clearInterval(beat);
      if (timer) clearTimeout(timer);
      set.delete(close);
      if (set.size === 0) streams.delete(key);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    };
    set.add(close);
    streams.set(key, set);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    res.write(`retry: 3000\n\n`);
    push();
    req.on('close', close);
  });

  return () => {
    for (const set of streams.values()) for (const close of [...set]) close();
  };
}
