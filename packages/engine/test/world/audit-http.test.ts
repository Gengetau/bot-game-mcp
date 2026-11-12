/** 审计回归（http 组）：单 IP 事件流并发上限；限流错误体带 retryAfterMs；跨站拒绝码。 */
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { mountTown, type TownHttpOptions } from '../../src/world/http.js';
import { makeTown } from './helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function serve(opts: TownHttpOptions): Promise<string> {
  const t = makeTown();
  const app = express();
  const closeTown = mountTown(app, t.w, () => undefined, opts);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanups.push(() => {
    closeTown();
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 开一条公开流，返回状态码与头；成功时连接保持，由 cleanups 关闭。 */
function openPublic(base: string, ip?: string): Promise<{ status: number; headers: Record<string, unknown>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/town/api/public/events`, { headers: ip ? { 'x-forwarded-for': ip } : {} }, (res) => {
      const close = () => req.destroy();
      cleanups.push(close);
      if (res.statusCode !== 200) res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, close });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('审计：http', () => {
  it('第 5 条：同一 IP 的旁观流有并发上限，关掉后释放，别的 IP 不受影响', async () => {
    const base = await serve({ requestsPerMinute: 100_000, maxStreamsPerIp: 2 });
    const a = await openPublic(base, '198.51.100.1');
    const b = await openPublic(base, '198.51.100.1');
    expect([a.status, b.status]).toEqual([200, 200]);
    const c = await openPublic(base, '198.51.100.1');
    expect(c.status).toBe(429);
    expect(c.headers['retry-after']).toBe('1');
    // 另一个 IP 还有名额
    expect((await openPublic(base, '198.51.100.2')).status).toBe(200);
    // 关掉一条后释放
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    expect((await openPublic(base, '198.51.100.1')).status).toBe(200);
  });

  it('第 18 条：IP 限流的 429 带 Retry-After 头和 retryAfterMs', async () => {
    const base = await serve({ requestsPerMinute: 1 });
    await fetch(`${base}/town/api/config`);
    const r = await fetch(`${base}/town/api/config`);
    expect(r.status).toBe(429);
    const j: any = await r.json();
    expect(j.error).toBe('rate_limited');
    expect(j.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('第 18 条：跨站 Origin 返回 400 bad_request，不是 401', async () => {
    const base = await serve({ requestsPerMinute: 100_000 });
    const r = await fetch(`${base}/town/api/leave`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe('bad_request');
  });

  it('第 18 条（复核）：登录接口超限的 429 也带 retryAfterMs 与 Retry-After', async () => {
    const base = await serve({ requestsPerMinute: 100_000 });
    let last: Response | undefined;
    for (let i = 0; i < 25; i++) {
      last = await fetch(`${base}/town/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '甲' }) });
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    const j: any = await last!.json();
    expect(j.error).toBe('rate_limited');
    expect(j.retryAfterMs).toBeGreaterThanOrEqual(1000);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});
