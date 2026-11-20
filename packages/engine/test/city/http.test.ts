/**
 * 城市的 HTTP 接口：公开页面、桥接的鉴权、一次经 HTTP 的出门回家、outbox 长轮询、代行的视图和等待。
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { mountCity } from '../../src/city/http.js';
import { MAPPINGS, bridgePayloadHash } from '../../src/city/index.js';
import { COOKIE, HOUSE_ENTRANCE, KISSA, MIN, makeCity, type CityTest } from './helpers.js';

const KEY = 'bridge-key-for-tests-0123456789';

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function serve(t: CityTest, bridgeKey: string | null = KEY): Promise<{ base: string; api: (method: string, path: string, body?: unknown, key?: string | null) => Promise<{ status: number; body: any; headers: Headers }> }> {
  const app = express();
  mountCity(app, t.c, () => undefined, { bridgeKey: bridgeKey ?? undefined });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown, key: string | null = KEY) => {
    const res = await fetch(`${base}/city/bridge/v1${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 不是 JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  return { base, api };
}

describe('公开页面', () => {
  it('文字页面：天气带来源和时间，票价标注为模拟，名字转义，没有小屋门口', async () => {
    const t = makeCity();
    const odd = t.bot('A&B"<b>');
    const k = t.kernel('nia');
    k.depart({ yen: 3000, to: 'hiyorizaka:ekimae-plaza' });
    const { base } = await serve(t);
    const res = await fetch(`${base}/city/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('晴空都');
    expect(html).not.toContain('undefined');
    expect(html).toContain('合成（没取到实时数据）');
    expect(html).toContain('模拟值');
    expect(html).toContain('Open-Meteo');
    // 居民起的名字先被清洗、再转义：页面里没有任何来自名字的标签
    const shown = t.c.mustResident(odd.id).name;
    expect(shown.length).toBeGreaterThan(0);
    expect(html.includes(shown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))).toBe(true);
    expect(html.includes('<b>"') || html.includes('<script')).toBe(false);
    expect(html.includes(HOUSE_ENTRANCE) || html.includes('小屋')).toBe(false);
    const json = await (await fetch(`${base}/city/api/public`)).json();
    expect(json).toMatchObject({ world_id: 'city', timezone: 'JST', city_text_version: 'toto-text-1.1', in_transit: 1 });
    expect(JSON.stringify(json).includes(HOUSE_ENTRANCE)).toBe(false);
  });
});

describe('就绪探针 /city/api/ready（第 1 闸 P8）', () => {
  const ready = async (base: string) => {
    const res = await fetch(`${base}/city/api/ready`);
    return { status: res.status, body: await res.json(), headers: res.headers };
  };

  it('running：200，只回状态字，不缓存，不要凭据', async () => {
    const t = makeCity();
    expect(t.c.status).toBe('running');
    const { base } = await serve(t, null);
    const r = await ready(base);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'running' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  it('启动恢复没完成（recovering）：公开快照仍是 200，ready 是 503', async () => {
    const t = makeCity({ start: false });
    expect(t.c.status).toBe('recovering');
    const { base } = await serve(t);
    const pub = await fetch(`${base}/city/api/public`);
    expect(pub.status).toBe(200);
    const r = await ready(base);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ status: 'recovering' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('degraded 503；回到 running 后马上 200（不缓存旧结果）', async () => {
    const t = makeCity();
    const { base } = await serve(t);
    t.c.status = 'degraded';
    const pub = await fetch(`${base}/city/api/public`);
    expect(pub.status).toBe(200);
    expect(await ready(base)).toMatchObject({ status: 503, body: { status: 'degraded' } });
    t.c.status = 'running';
    expect(await ready(base)).toMatchObject({ status: 200, body: { status: 'running' } });
  });

  it('closed：503', async () => {
    const t = makeCity();
    const { base } = await serve(t);
    t.c.close();
    expect(await ready(base)).toMatchObject({ status: 503, body: { status: 'closed' } });
  });

  it('只读：POST 不存在', async () => {
    const t = makeCity();
    const { base } = await serve(t);
    const res = await fetch(`${base}/city/api/ready`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('桥接接口', () => {
  it('没配密钥就不存在；配了要带对', async () => {
    const t = makeCity();
    const off = await serve(t, null);
    expect((await off.api('GET', '/weather')).status).toBe(404);
    const on = await serve(t);
    expect((await on.api('GET', '/weather', undefined, null)).status).toBe(401);
    expect((await on.api('GET', '/weather', undefined, 'wrong-key')).body).toMatchObject({ error: 'UNAUTHENTICATED' });
    const ok = await on.api('GET', '/weather');
    expect(ok.status).toBe(200);
    expect(ok.body.areas).toHaveLength(3);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect((await on.api('GET', '/nope')).status).toBe(404);
    expect((await on.api('POST', '/visits/prepare', '{bad json')).body).toMatchObject({ error: 'BAD_REQUEST' });
  });

  it('经 HTTP 走一遍：catalog → prepare → commit → 代行 → outbox → release', async () => {
    const t = makeCity();
    const { api } = await serve(t);
    const k = t.kernel('nia');

    const catalog = await api('GET', '/catalog');
    expect(catalog.body).toMatchObject({
      protocol: 'city-bridge/1',
      city_catalog_version: 'toto-p3.0',
      city_text_version: 'toto-text-1.1',
      mappings: { version: MAPPINGS.version },
      handover_node: HOUSE_ENTRANCE,
    });
    expect(catalog.body.places.find((p: any) => p.id === KISSA).homeward).toEqual({ fare_yen: 200, minutes: 31 });

    const prepare = k.prepareBody({ yen: 20_000, items: [COOKIE], to: KISSA });
    const p = await api('POST', '/visits/prepare', { ...prepare, payload_hash: bridgePayloadHash(prepare) });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ visit_id: k.visitId, state: 'prepared', request_id: prepare.request_id });
    const commit = k.commitBody();
    const c = await api('POST', `/visits/${k.visitId}/commit`, commit);
    expect(c.body).toMatchObject({ state: 'active', payload: { purse_yen: 20_000 } });
    k.epoch = 1;
    // 同一个请求再发一次
    expect((await api('POST', `/visits/${k.visitId}/commit`, commit)).body).toMatchObject({ receipt_id: c.body.receipt_id, replayed: true });
    // 换内容：409
    const conflict = await api('POST', `/visits/${k.visitId}/commit`, { ...commit, domain_epoch: 7 });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'CONFLICT', reason: 'request_conflict' });

    t.run(31 * MIN);
    const view = await api('GET', `/visits/${k.visitId}/view?domain_epoch=1`);
    expect(view.body).toMatchObject({ visit_id: k.visitId, state: 'active', location: { place: KISSA }, wallet: { yen: 19_800, return_reserve_yen: 200 } });
    const stale = await api('GET', `/visits/${k.visitId}/view?domain_epoch=0`);
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'STALE_DOMAIN_EPOCH' });

    const buy = await api('POST', `/visits/${k.visitId}/act`, { request_id: `${k.visitId}:d1:a1`, domain_epoch: 1, action: { type: 'buy', sku: 'coffee' } });
    expect(buy.body).toMatchObject({ state: 'active', payload: { status: 'completed', paid_yen: 450 } });
    const poor = await api('POST', `/visits/${k.visitId}/act`, { request_id: `${k.visitId}:d1:a2`, domain_epoch: 1, action: { type: 'buy', sku: 'coffee', qty: 99 } });
    expect(poor.status).toBe(400);
    await api('POST', `/visits/${k.visitId}/act`, { request_id: `${k.visitId}:d1:a3`, domain_epoch: 1, action: { type: 'consume', item: 'coffee' } });

    const page1 = await api('GET', '/outbox?after=0&limit=3');
    expect(page1.body.records).toHaveLength(3);
    expect(page1.body).toMatchObject({ more: true, next_after: page1.body.records[2].seq });
    const rest = await api('GET', `/outbox?after=${page1.body.next_after}&limit=200`);
    expect(rest.body.more).toBe(false);
    const kinds = [...page1.body.records, ...rest.body.records].map((r: any) => r.kind);
    expect(kinds.filter((x: string) => x === 'purchase')).toHaveLength(2);
    expect(kinds).toContain('body_effect');
    expect((await api('GET', '/outbox?after=-1')).status).toBe(400);

    const ret = await api('POST', `/visits/${k.visitId}/return-request`, { request_id: `${k.visitId}:d1:ret`, reason: 'dinner' });
    expect(ret.body).toMatchObject({ state: 'returning', payload: { started: true } });
    t.run(31 * MIN);
    const seen = await api('GET', `/visits/${k.visitId}`);
    expect(seen.body).toMatchObject({ state: 'settled', return_reason: 'kernel:dinner' });
    expect(seen.body.receipts.map((r: any) => r.op)).toEqual(['prepare', 'commit', 'return-request']);
    const release = await api('POST', `/visits/${k.visitId}/release`, { request_id: `${k.visitId}:release`, settlement_id: seen.body.settlement.settlement_id, domain_epoch: 2 });
    expect(release.body).toMatchObject({ state: 'closed', payload: { purse_final_yen: 20_000 - 850, reconcile_ok: true } });
    const reports = await api('GET', '/reconcile');
    expect(reports.body.reports[0]).toMatchObject({ ok: true, trigger: 'visit_closed', findings: [] });
    // 交回之后旧代次的代行
    const late = await api('POST', `/visits/${k.visitId}/act`, { request_id: `${k.visitId}:d1:late`, domain_epoch: 1, action: { type: 'say', text: '还在吗' } });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('STALE_DOMAIN_EPOCH');
    expect((await api('GET', '/visits/no-such-visit')).status).toBe(404);
  });

  it('outbox 长轮询：有新记录（提交之后）立刻返回', async () => {
    const t = makeCity();
    const { api } = await serve(t);
    const k = t.kernel('nia');
    const waiting = api('GET', '/outbox?after=0&wait_ms=5000');
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    k.depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' });
    const got = await waiting;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(got.body.records.map((r: any) => r.kind)).toEqual(['visit_progress']);
    // 没有新记录：等到超时返回空页
    const empty = await api('GET', `/outbox?after=${got.body.next_after}&wait_ms=50`);
    expect(empty.body).toEqual({ records: [], next_after: got.body.next_after, more: false });
  });

  it('代行的等待：到站事件叫醒等待；带游标续读', async () => {
    const t = makeCity();
    const { api } = await serve(t);
    const k = t.kernel('nia');
    k.depart({ yen: 1000, to: 'hiyorizaka:ekimae-plaza' });
    const view = await api('GET', `/visits/${k.visitId}/view?domain_epoch=1`);
    const waiting = api('GET', `/visits/${k.visitId}/wait?domain_epoch=1&wait_ms=5000&cursor=${encodeURIComponent(view.body.cursor)}`);
    await new Promise((r) => setTimeout(r, 30));
    t.run(14 * MIN);
    const got = await waiting;
    expect(got.body.events.map((e: any) => e.type)).toEqual(['you_arrived']);
    expect(got.body.state).toBe('active');
    const again = await api('GET', `/visits/${k.visitId}/wait?domain_epoch=1&wait_ms=0&cursor=${encodeURIComponent(got.body.cursor)}`);
    expect(again.body.events).toEqual([]);
  });
});
