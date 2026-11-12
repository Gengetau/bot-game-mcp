/**
 * /town/3d/：三维客户端导出目录的静态托管。
 * 用临时目录造一个假的导出目录；穿越类请求用原始 http 发（fetch 会先规范化路径）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 让测试能在 stat 成功之后让「打开文件」失败（模拟文件刚被删、权限、EMFILE）；默认原样转发
const openFail = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: ((...args: Parameters<typeof actual.createReadStream>) =>
      openFail.on ? actual.createReadStream('/nonexistent/town-open-fail') : actual.createReadStream(...args)) as typeof actual.createReadStream,
  };
});
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { mountTown, type TownHttpOptions } from '../../src/world/http.js';
import { createWorld } from '../../src/world/index.js';
import { FakeClock } from '../helpers.js';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  text: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  openFail.on = false;
  while (cleanups.length) await cleanups.pop()!();
});

let root: string; // 假的导出目录
let outside: string; // 目录之外的东西（符号链接逃逸用）

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'town-client-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  root = join(base, 'export');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>3d</title>');
  writeFileSync(join(root, 'boot.js'), 'console.log(1)');
  writeFileSync(join(root, 'game.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  writeFileSync(join(root, 'game.pck'), Buffer.alloc(64, 7));
  writeFileSync(join(root, 'sub', 'a.png'), Buffer.from([0x89, 0x50]));
  writeFileSync(join(root, 'game.js'), 'var big = 1;'.repeat(100));
  writeFileSync(join(root, 'game.js.gz'), gzipSync('GZIPPED'));
  writeFileSync(join(root, 'game.js.br'), 'BROTLI-BYTES');
  writeFileSync(join(root, 'notes.txt'), 'x');
  writeFileSync(join(root, '.secret.json'), '{}');
  writeFileSync(join(outside, 'leak.json'), '{"leak":true}');
  symlinkSync(join(outside, 'leak.json'), join(root, 'link.json'));
  symlinkSync(outside, join(root, 'linkdir'));
  writeFileSync(join(base, 'sibling.json'), '{"sibling":true}');
  mkdirSync(join(base, 'export-evil'));
  writeFileSync(join(base, 'export-evil', 'x.json'), '{}');
});

async function serve(opts: TownHttpOptions & { publicUrl?: string } = {}) {
  const clock = new FakeClock();
  const w = createWorld({
    dbPath: ':memory:',
    registry: createRegistry({}),
    now: clock.now,
    rng: new SeededRng('host'),
    seed: 'host',
    ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
  });
  w.startSync();
  const app = express();
  const close = mountTown(app, w, () => undefined, { requestsPerMinute: 100_000, clientDir: root, ...opts });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanups.push(async () => {
    close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    w.close();
  });
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    new Promise<Res>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: r.statusCode ?? 0, headers: r.headers, body, text: body.toString('utf8') });
        });
      });
      req.on('error', reject);
      req.end();
    });
  return { get, port };
}

describe('/town/3d/ 静态托管', () => {
  it('stat 之后打开失败：404 不带 Content-Encoding / ETag / Last-Modified', async () => {
    const { get } = await serve();
    const ok = await get('/town/3d/game.js', { 'accept-encoding': 'br, gzip' });
    expect(ok.status).toBe(200);
    openFail.on = true;
    const r = await get('/town/3d/game.js', { 'accept-encoding': 'br, gzip' });
    expect(r.status).toBe(404);
    expect(r.headers['content-encoding']).toBeUndefined();
    // Express 会按 404 正文自己算一个 ETag；这里只要求不是原文件的那个
    expect(r.headers.etag).not.toBe(ok.headers.etag);
    expect(r.headers['last-modified']).toBeUndefined();
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.text).toBe('没有这个文件。');
  });

  it('/town/3d 重定向到 /town/3d/（保留查询串）', async () => {
    const { get } = await serve();
    const r = await get('/town/3d?debug=1');
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('/town/3d/?debug=1');
  });

  it('/town/3d/ 发 index.html，不长缓存', async () => {
    const { get } = await serve();
    const r = await get('/town/3d/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.text).toContain('<title>3d</title>');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('/town/3d/index.html 也行；HEAD 只有头', async () => {
    const { get } = await serve();
    expect((await get('/town/3d/index.html')).status).toBe(200);
    const h = await get('/town/3d/index.html', {}, 'HEAD');
    expect(h.status).toBe(200);
    expect(h.body.length).toBe(0);
    expect(Number(h.headers['content-length'])).toBeGreaterThan(0);
  });

  it('非 GET 返回 405', async () => {
    const { get } = await serve();
    const r = await get('/town/3d/index.html', {}, 'POST');
    expect(r.status).toBe(405);
    // 拒绝的回应也带安全头
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('各种类型的 MIME；子目录可取；内容完整', async () => {
    const { get } = await serve();
    const cases: [string, string][] = [
      ['/town/3d/boot.js', 'text/javascript; charset=utf-8'],
      ['/town/3d/game.wasm', 'application/wasm'],
      ['/town/3d/game.pck', 'application/octet-stream'],
      ['/town/3d/sub/a.png', 'image/png'],
    ];
    for (const [path, type] of cases) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-type'], path).toBe(type);
    }
    const wasm = await get('/town/3d/game.wasm');
    expect([...wasm.body.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
    expect(Number(wasm.headers['content-length'])).toBe(8);
  });

  it('文件类型表覆盖 glb / ogg / wav / mp3 / woff2 / ico / css / json / webp / svg', async () => {
    for (const n of ['a.glb', 'a.ogg', 'a.wav', 'a.mp3', 'a.woff2', 'a.ico', 'a.css', 'a.json', 'a.webp', 'a.svg']) writeFileSync(join(root, n), 'x');
    const { get } = await serve();
    const want: Record<string, string> = {
      glb: 'model/gltf-binary',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      woff2: 'font/woff2',
      ico: 'image/x-icon',
      css: 'text/css; charset=utf-8',
      json: 'application/json; charset=utf-8',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    };
    for (const [ext, type] of Object.entries(want)) expect((await get(`/town/3d/a.${ext}`)).headers['content-type'], ext).toBe(type);
  });

  it('不认识的后缀 404（文件存在也一样）；预压缩文件不能被直接请求', async () => {
    const { get } = await serve();
    expect((await get('/town/3d/notes.txt')).status).toBe(404);
    expect((await get('/town/3d/game.js.gz')).status).toBe(404);
    expect((await get('/town/3d/game.js.br')).status).toBe(404);
    expect((await get('/town/3d/missing.js')).status).toBe(404);
    expect((await get('/town/3d/sub/')).status).toBe(404);
  });

  it('预压缩协商：br 优先，其次 gzip，没有则原文件；Content-Type 仍是原文件的', async () => {
    const { get } = await serve();
    const br = await get('/town/3d/game.js', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.status).toBe(200);
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toBe('Accept-Encoding');
    expect(br.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(br.text).toBe('BROTLI-BYTES');
    const gz = await get('/town/3d/game.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body.equals(gzipSync('GZIPPED'))).toBe(true); // 原样发预压缩文件
    expect(gz.body[0]).toBe(0x1f);
    const plain = await get('/town/3d/game.js', { 'accept-encoding': 'identity' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.text.startsWith('var big')).toBe(true);
    const none = await get('/town/3d/game.js');
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.headers.vary).toBe('Accept-Encoding');
    // q=0 表示不接受
    const q0 = await get('/town/3d/game.js', { 'accept-encoding': 'br;q=0, gzip' });
    expect(q0.headers['content-encoding']).toBe('gzip');
    // 没有预压缩文件的不受影响
    const w = await get('/town/3d/game.wasm', { 'accept-encoding': 'br, gzip' });
    expect(w.headers['content-encoding']).toBeUndefined();
  });

  it('ETag 与 If-None-Match → 304；不同编码的 ETag 不同', async () => {
    const { get } = await serve();
    const a = await get('/town/3d/boot.js');
    const etag = String(a.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(a.headers['last-modified']).toBeTruthy();
    const b = await get('/town/3d/boot.js', { 'if-none-match': etag });
    expect(b.status).toBe(304);
    expect(b.body.length).toBe(0);
    expect((await get('/town/3d/boot.js', { 'if-none-match': '"nope"' })).status).toBe(200);
    expect((await get('/town/3d/boot.js', { 'if-none-match': `W/${etag}` })).status).toBe(304);
    const g = await get('/town/3d/game.js', { 'accept-encoding': 'gzip' });
    const p = await get('/town/3d/game.js');
    expect(g.headers.etag).not.toBe(p.headers.etag);
    expect((await get('/town/3d/game.js', { 'accept-encoding': 'gzip', 'if-none-match': String(g.headers.etag) })).status).toBe(304);
  });

  it('目录穿越的各种写法全部 404', async () => {
    const { get } = await serve();
    const bad = [
      '/town/3d/../sibling.json',
      '/town/3d/%2e%2e/sibling.json',
      '/town/3d/%2E%2E%2Fsibling.json',
      '/town/3d/..%2fsibling.json',
      '/town/3d/sub/../../sibling.json',
      '/town/3d/sub/%2e%2e/%2e%2e/sibling.json',
      '/town/3d/..%5csibling.json',
      '/town/3d/sub%5c..%5c..%5csibling.json',
      '/town/3d/%00',
      '/town/3d/boot.js%00.png',
      '/town/3d/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/town/3d/.secret.json',
      '/town/3d/sub/.hidden/a.png',
      '/town/3d/%2esecret.json',
      '/town/3d//boot.js',
      '/town/3d/sub//a.png',
      '/town/3d/../export-evil/x.json',
      '/town/3d/%E0%A4%A', // 坏的百分号编码
      '/town/3d/link.json', // 符号链接指向目录之外
      '/town/3d/linkdir/leak.json', // 符号链接目录
    ];
    for (const p of bad) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(r.text, p).not.toContain('leak');
      expect(r.text, p).not.toContain('sibling');
    }
  });

  it('符号链接指向目录之内的文件是允许的', async () => {
    symlinkSync(join(root, 'boot.js'), join(root, 'alias.js'));
    const { get } = await serve();
    expect((await get('/town/3d/alias.js')).status).toBe(200);
  });

  it('没配 clientDir 或目录不存在：404 + 一句中文纯文本，不抛异常', async () => {
    for (const clientDir of [null, undefined, join(root, 'nope')]) {
      const { get } = await serve({ clientDir });
      for (const p of ['/town/3d/', '/town/3d/index.html', '/town/3d/boot.js']) {
        const r = await get(p);
        expect(r.status, `${clientDir} ${p}`).toBe(404);
        expect(String(r.headers['content-type'])).toContain('text/plain');
        expect(r.text).toMatch(/三维客户端|没有这个文件/);
      }
    }
    // clientDir 指向一个文件而不是目录
    const { get } = await serve({ clientDir: join(root, 'index.html') });
    expect((await get('/town/3d/')).status).toBe(404);
  });

  it('目录晚点才出现也行（每次请求都看）', async () => {
    const later = join(root, 'later');
    const { get } = await serve({ clientDir: later });
    expect((await get('/town/3d/')).status).toBe(404);
    mkdirSync(later);
    writeFileSync(join(later, 'index.html'), 'hi');
    expect((await get('/town/3d/')).text).toBe('hi');
  });
});

describe('/town/3d/ 的 CSP', () => {
  const directives = (csp: string) => Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

  it('只放宽必要的部分，其余照旧', async () => {
    const { get } = await serve();
    const r = await get('/town/3d/', { host: '127.0.0.1:7700' });
    const d = directives(String(r.headers['content-security-policy']));
    expect(d['default-src']).toEqual(["'none'"]);
    expect(d['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(d['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(d['media-src']).toEqual(["'self'", 'blob:']);
    expect(d['worker-src']).toEqual(["'self'", 'blob:']);
    expect(d['font-src']).toEqual(["'self'"]);
    expect(d['base-uri']).toEqual(["'none'"]);
    expect(d['form-action']).toEqual(["'none'"]);
    expect(d['frame-ancestors']).toEqual(["'none'"]);
    expect(d['connect-src']).toEqual(["'self'", 'ws://127.0.0.1:7700']);
    expect(String(r.headers['content-security-policy'])).not.toContain("'unsafe-eval'");
  });

  it('子文件和 404 也带同一份 CSP', async () => {
    const { get } = await serve();
    const a = await get('/town/3d/boot.js', { host: 'town.test' });
    const b = await get('/town/3d/missing.js', { host: 'town.test' });
    expect(a.headers['content-security-policy']).toBe(b.headers['content-security-policy']);
    expect(String(a.headers['content-security-policy'])).toContain('ws://town.test');
  });

  it('经 HTTPS 代理时用 wss；publicUrl 的源也会加上', async () => {
    const { get } = await serve({ publicUrl: 'https://town.example.com/town/' });
    const r = await get('/town/3d/', { host: 'internal:7700', 'x-forwarded-host': 'town.example.com', 'x-forwarded-proto': 'https' });
    const d = directives(String(r.headers['content-security-policy']));
    expect(d['connect-src']).toEqual(["'self'", 'wss://town.example.com']);
    const r2 = await get('/town/3d/', { host: 'localhost:7700' });
    const d2 = directives(String(r2.headers['content-security-policy']));
    expect(d2['connect-src']).toEqual(["'self'", 'ws://localhost:7700', 'wss://town.example.com']);
  });

  it('Host 头里的注入不会进 CSP', async () => {
    const { get } = await serve();
    const evil = ['a.com; script-src *', "a.com 'unsafe-inline'", 'a.com\\x', 'http://a.com', 'a b', '-', 'a.com:99999999'];
    for (const h of evil) {
      const r = await get('/town/3d/', { 'x-forwarded-host': h, host: '127.0.0.1:1' });
      const csp = String(r.headers['content-security-policy']);
      const d = directives(csp);
      expect(d['script-src'], h).toEqual(["'self'", "'wasm-unsafe-eval'"]);
      expect(csp, h).not.toContain('a.com');
      expect(d['connect-src'], h).toEqual(["'self'"]);
    }
  });
});

describe('旧页面不受影响', () => {
  const OLD_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  it('/town/ 与 /town/api 的 CSP 没变，/town/3d 不会被当成文件名', async () => {
    const { get } = await serve();
    const page = await get('/town/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe(OLD_CSP);
    const api = await get('/town/api/config');
    expect(api.status).toBe(200);
    expect(api.headers['content-security-policy']).toBe(OLD_CSP);
    const js = await get('/town/app.js');
    expect(js.headers['content-security-policy'] ?? OLD_CSP).toBe(OLD_CSP);
    // 旧路由对 3d 不再是「文件」：没配 clientDir 时同样走 3d 的 404
    const { get: get2 } = await serve({ clientDir: null });
    const r = await get2('/town/3d');
    expect(r.status).toBe(301);
  });
});
