/**
 * docs/city/bridge-v1.schema.json 要和引擎实际产出的东西一致：
 * 跑一遍真实的出门回家（外加一次取消的访问），把产生的每个请求体、回执、outbox 记录、结算清单、
 * 天气、对账和失败响应都拿去按 $defs 校验；再用几个反例确认 schema 不是什么都放过。
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv2020Module from 'ajv/dist/2020.js';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { mountCity } from '../../src/city/http.js';
import {
  AREAS,
  CityError,
  abortVisit,
  allWeather,
  applyWeather,
  bridgePayloadHash,
  commitVisit,
  describeVisit,
  latestReconcile,
  prepareVisit,
  readOutbox,
  releaseVisit,
  requestReturn,
  visitAct,
  type WeatherReading,
} from '../../src/city/index.js';
import { COOKIE, KISSA, MIN, makeCity, rejects } from './helpers.js';

// ajv 是 CommonJS：NodeNext 下默认导入拿到的是 module.exports，vitest 下可能直接是类，这里两种都认
const Ajv2020: new (opts: Record<string, unknown>) => any = (Ajv2020Module as any).default ?? Ajv2020Module;

const schema = JSON.parse(readFileSync(new URL('../../../../docs/city/bridge-v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);

function validator(def: string): (v: unknown) => boolean {
  const fn = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!fn) throw new Error(`schema 里没有 $defs/${def}`);
  return (v) => Boolean(fn(v));
}

/** 校验并在失败时把 ajv 的原因和对象一起报出来 */
function expectValid(def: string, value: unknown, label = def): void {
  const fn = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!fn) throw new Error(`schema 里没有 $defs/${def}`);
  const ok = fn(value);
  if (!ok) throw new Error(`${label} 不符合 $defs/${def}：${ajv.errorsText(fn.errors, { separator: '；' })}\n${JSON.stringify(value, null, 1).slice(0, 1500)}`);
}

function expectInvalid(def: string, value: unknown): void {
  expect(validator(def)(value), `${def} 应该不通过`).toBe(false);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('bridge-v1.schema.json 本身', () => {
  it('是合法的 2020-12 schema，$defs 覆盖要求的每一项，x-endpoints 的引用都解析得到', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://bot-game-mcp/city/bridge-v1.schema.json');
    for (const def of [
      'PrepareRequest', 'CommitRequest', 'AbortRequest', 'ReturnRequest', 'ReleaseRequest', 'ActRequest', 'Action', 'Receipt',
      'PreparePayload', 'CommitPayload', 'AbortPayload', 'ReturnRequestPayload', 'ReleasePayload', 'ActPayload', 'VisitState',
      'VisitDescription', 'OutboxPage', 'OutboxRecord', 'Settlement', 'WeatherResponse', 'WeatherSnapshot', 'ReconcileResponse', 'Catalog', 'Error',
    ]) {
      expect(schema.$defs[def], def).toBeDefined();
    }
    const endpoints = schema['x-endpoints'] as { method: string; path: string; request: { $ref: string } | null; response: { $ref: string }; errors: string[] }[];
    expect(endpoints.length).toBe(13);
    const codes = new Set<string>(schema.$defs.ErrorCode.enum);
    for (const e of endpoints) {
      expect(e.path.startsWith('/city/bridge/v1/')).toBe(true);
      for (const r of [e.request, e.response]) if (r) validator(r.$ref.replace('#/$defs/', ''));
      for (const code of e.errors) expect(codes.has(code), `${e.path} ${code}`).toBe(true);
    }
  });
});

describe('协议产物和 schema 对得上', () => {
  const t = makeCity();
  const c = t.c;
  const k = t.kernel('nia');
  const nia = t.residentOf('nia');
  const b = t.bot('小B', { entry: 'ikebukuro:station' });
  const servers: Server[] = [];
  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  const seen = { requests: [] as string[], receipts: 0 };
  const req = (def: string, body: Record<string, unknown>): void => {
    // 请求体：带或不带 payload_hash 都要通过
    expectValid(def, body);
    expectValid(def, { ...body, payload_hash: bridgePayloadHash(body) }, `${def}+payload_hash`);
    seen.requests.push(def);
  };
  const receipt = (def: string, r: unknown): any => {
    expectValid('Receipt', r);
    expectValid(def, r);
    seen.receipts++;
    return r;
  };

  const niaVisit = 'v-nia-1';
  let settled: any;
  let cutoff = 0;

  it('prepare / commit：请求体和回执，重发返回 replayed', () => {
    const prep = k.prepareBody({ yen: 20_000, items: [COOKIE], to: KISSA, visitId: niaVisit });
    req('PrepareRequest', prep);
    const hashed = { ...prep, payload_hash: bridgePayloadHash(prep) };
    const r1 = receipt('PrepareReceipt', prepareVisit(c, hashed));
    expect(r1.state).toBe('prepared');
    expect(r1.replayed).toBeUndefined();
    const again = receipt('PrepareReceipt', prepareVisit(c, prep));
    expect(again.replayed).toBe(true);
    expect(again.receipt_id).toBe(r1.receipt_id);
    k.frozenYen += 20_000;

    // 同一个 visit 在 prepared 时的描述
    expectValid('VisitDescription', describeVisit(c, k.visitId), 'describe(prepared)');

    const commitBody = k.commitBody();
    req('CommitRequest', commitBody);
    const rc = receipt('CommitReceipt', commitVisit(c, k.visitId, commitBody));
    k.epoch = commitBody.domain_epoch as number;
    expect(rc.state).toBe('active');
    expect(rc.payload.trip).toMatchObject({ to: KISSA });
    // 换了 request_id 重发同一次交接：回当时的回执，多两个 original_* 字段
    const resend = receipt('CommitReceipt', commitVisit(c, k.visitId, { ...commitBody, request_id: `${k.visitId}:commit-again` }));
    expect(resend.payload).toMatchObject({ original_receipt_id: rc.receipt_id });
    const d = describeVisit(c, k.visitId) as any;
    expectValid('VisitDescription', d, 'describe(active)');
    expect(d.location).toMatchObject({ in_transit: true });
  });

  it('在咖啡馆：外部 bot 搭话（encounter）、买咖啡、喝掉、送出曲奇、回家', () => {
    t.run(31 * MIN);
    expect((describeVisit(c, k.visitId) as any).location).toEqual({ place: KISSA });
    expectValid('VisitDescription', describeVisit(c, k.visitId), 'describe(at cafe)');
    b.go(KISSA);
    b.act({ type: 'say', text: '你好，这里的咖啡好喝吗？' });

    const act = (action: Record<string, unknown>): any => {
      const body = { request_id: k.rid('a'), domain_epoch: k.epoch, action };
      req('ActRequest', body);
      const r = receipt('ActReceipt', visitAct(c, k.visitId, body));
      expectValid('ActPayload', r.payload);
      return r;
    };
    act({ type: 'say', text: '我也是第一次来。' });
    b.act({ type: 'say', text: '那一起试试。' });
    expect(act({ type: 'buy', sku: 'coffee' }).payload).toMatchObject({ status: 'completed' });
    expect(act({ type: 'consume', item: 'coffee' }).payload).toMatchObject({ status: 'completed' });
    expect(act({ type: 'give', to: b.id, item: 'cookie' }).payload).toMatchObject({ status: 'completed' });
    // 动作的每一种写法都要通过 Action
    const buyReceipt = visitAct(c, k.visitId, { request_id: k.rid('a'), domain_epoch: k.epoch, action: { type: 'buy', sku: 'coffee', qty: 1 } });
    expect(buyReceipt.state).toBe('active');
    for (const action of [
      { type: 'travel', to: 'ikebukuro:station' },
      { type: 'say', text: 'hi' },
      { type: 'buy', sku: 'coffee', qty: 2 },
      { type: 'consume', item_id: 'itm_x', qty: 1 },
      { type: 'give', to: 'r1', item: 'cookie' },
      { type: 'inspect_item', item_id: 'itm_x' },
      { type: 'inspect_item', scope: 'held', offset: 0, limit: 10 },
      { type: 'go_home' },
    ]) {
      expectValid('Action', action);
    }
    const home = act({ type: 'go_home' });
    expect(home.state).toBe('returning');

    // 已经在回家路上：return-request 什么都不做
    const rrBody = { request_id: k.rid('ret'), reason: '内核也想让她回家' };
    req('ReturnRequest', rrBody);
    const rr = receipt('ReturnRequestReceipt', requestReturn(c, k.visitId, rrBody));
    expect(rr.payload).toEqual({ started: false });
    expectValid('VisitDescription', describeVisit(c, k.visitId), 'describe(returning)');
  });

  it('到家：结算清单、visit_settled、release', () => {
    t.run(31 * MIN);
    const d = describeVisit(c, k.visitId) as any;
    expectValid('VisitDescription', d, 'describe(settled)');
    expect(d.state).toBe('settled');
    expectValid('Settlement', d.settlement);
    expect(d.settlement.given).toHaveLength(1);
    expect(d.settlement.consumed).toHaveLength(1);

    const page = readOutbox(c, 0, 200);
    const rec = page.records.find((r: any) => r.kind === 'visit_settled' && r.visit_id === k.visitId) as any;
    settled = rec.payload;
    cutoff = settled.cutoff_seq;
    expectValid('Settlement', settled, 'visit_settled.payload');
    expect(settled).toEqual(d.settlement);

    const body = { request_id: `${k.visitId}:release`, settlement_id: settled.settlement_id, domain_epoch: k.epoch + 1 };
    req('ReleaseRequest', body);
    const r = receipt('ReleaseReceipt', releaseVisit(c, k.visitId, body));
    // 多买的那杯现点咖啡（carry_home: false）没喝完：返家前按 disposed 处理（不进储物柜、不代喝），无 pending 订单时正常 closed
    expect(settled.items.filter((i: any) => i.fate === 'disposed')).toHaveLength(1);
    expect(r.state).toBe('closed');
    expect(r.payload).toMatchObject({ reconcile_ok: true });
    const replay = receipt('ReleaseReceipt', releaseVisit(c, k.visitId, body));
    expect(replay.replayed).toBe(true);
    const closed = describeVisit(c, k.visitId) as any;
    expectValid('VisitDescription', closed, 'describe(closed)');
    expect(closed.state).toBe('closed');
    expect(closed.receipts.map((x: any) => x.op)).toEqual(['prepare', 'commit', 'commit', 'return-request', 'release']);
  });

  it('outbox：每条记录、整页、七种 kind 都出现过', () => {
    const page = readOutbox(c, 0, 200);
    expectValid('OutboxPage', page);
    for (const rec of page.records) expectValid('OutboxRecord', rec, `outbox #${(rec as any).seq} ${(rec as any).kind}`);
    const kinds = new Set(page.records.map((r: any) => r.kind));
    expect([...kinds].sort()).toEqual(['body_effect', 'decision_wake', 'encounter', 'purchase', 'return_started', 'visit_progress', 'visit_settled']);
    // 步行、喝咖啡都有 body_effect；买咖啡和电车都有 purchase
    const effects = page.records.filter((r: any) => r.kind === 'body_effect').map((r: any) => r.payload.engine_kind);
    expect(effects).toContain('drank');
    expect(effects).toContain('walked');
    expect(page.records.filter((r: any) => r.kind === 'purchase').length).toBeGreaterThanOrEqual(2);
    // 空页和分页
    const empty = readOutbox(c, page.next_after, 50);
    expectValid('OutboxPage', empty, 'empty page');
    expect(empty).toEqual({ records: [], next_after: page.next_after, more: false });
    const small = readOutbox(c, 0, 3);
    expectValid('OutboxPage', small, 'small page');
    expect(small.more).toBe(true);
    expect(cutoff).toBeGreaterThan(0);
  });

  it('取消的访问：prepare → abort；没见过的 visit_id 也能 abort', () => {
    const k2 = t.kernel('claire');
    const prep = k2.prepareBody({ yen: 1000, to: 'akabane:ekimae-plaza' });
    req('PrepareRequest', prep);
    receipt('PrepareReceipt', prepareVisit(c, prep));
    const body = { request_id: `${k2.visitId}:abort`, reason: '冻结失败' };
    req('AbortRequest', body);
    const r = receipt('AbortReceipt', abortVisit(c, k2.visitId, body));
    expect(r).toMatchObject({ state: 'aborted', payload: { known: true } });
    const d = describeVisit(c, k2.visitId) as any;
    expectValid('VisitDescription', d, 'describe(aborted)');
    expect(d.state).toBe('aborted');
    expect(d.times.aborted_at_ms).not.toBeNull();

    const ghost = abortVisit(c, 'v-ghost-0001', { request_id: 'v-ghost-0001:abort' });
    receipt('AbortReceipt', ghost);
    expect(ghost.payload).toEqual({ known: false });
    const gd = describeVisit(c, 'v-ghost-0001') as any;
    expectValid('VisitDescription', gd, 'describe(ghost)');
    expect(gd.known).toBe(false);
  });

  it('天气和对账：按 HTTP 处理器的包装', () => {
    const readings: WeatherReading[] = AREAS.map((a, i) => ({
      area: a.id,
      observed_at_ms: t.clock.t,
      code: i === 1 ? 61 : 1,
      temp_c: 14.5,
      precip_mm: i === 1 ? 0.8 : 0,
      hourly: [{ at_ms: t.clock.t, code: 1, temp_c: 14.5, precip_mm: 0 }],
    }));
    c.commit(() => applyWeather(c, readings, t.clock.t));
    const wrap = () => ({ at_ms: c.now(), attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)', areas: allWeather(c) });
    const live = wrap();
    expect(live.areas).toHaveLength(3);
    expectValid('WeatherResponse', live, 'weather(ok)');
    expect(live.areas.map((a) => a.status)).toEqual(['ok', 'ok', 'ok']);
    // 合成天气（没抓到）
    t.run(5 * MIN);
    c.commit(() => applyWeather(c, null, t.clock.t));
    const fb = wrap();
    expectValid('WeatherResponse', fb, 'weather(fallback/stale)');
    expect(fb.areas.every((a) => a.status !== 'ok')).toBe(true);
    for (const s of fb.areas) expectValid('WeatherSnapshot', s);

    const rec = { reports: latestReconcile(c, 10) };
    expect(rec.reports.length).toBeGreaterThan(0);
    expectValid('ReconcileResponse', rec);
    expect(rec.reports.every((r) => r.ok)).toBe(true);
  });

  it('失败响应：CityError#toJSON() 都符合 Error', () => {
    const errs: CityError[] = [];
    // 同一个请求号不同内容
    const prep = k.prepareBody({ yen: 100, to: KISSA, visitId: 'v-conflict-1' });
    prepareVisit(c, prep);
    errs.push(rejects(() => prepareVisit(c, { ...prep, carry: { yen: 101, items: [] } }), 'CONFLICT', 'request_conflict'));
    // payload_hash 对不上（带 expected）
    errs.push(rejects(() => prepareVisit(c, { ...prep, request_id: 'v-conflict-1:p2', payload_hash: 'deadbeef' }), 'BAD_REQUEST', 'payload_hash_mismatch'));
    // 协议版本
    errs.push(rejects(() => prepareVisit(c, { ...prep, request_id: 'v-conflict-2:p', visit_id: 'v-conflict-2', protocol: 'city-bridge/9' }), 'VERSION_MISMATCH', 'protocol'));
    // 已经结束的访问上发动作
    errs.push(rejects(() => visitAct(c, niaVisit, { request_id: 'late-act-0001', domain_epoch: 1, action: { type: 'say', text: '还在吗' } }), 'STALE_DOMAIN_EPOCH'));
    // 找不到
    errs.push(rejects(() => describeVisit(c, 'v-no-such-visit'), 'NOT_FOUND', 'no_such_visit'));
    // 没带请求号
    errs.push(rejects(() => abortVisit(c, 'v-whatever-1', {}), 'BAD_REQUEST'));
    for (const e of errs) {
      expectValid('Error', e.toJSON(), `${e.code}/${e.reason}`);
      expectValid('Error', JSON.parse(JSON.stringify(e)));
    }
    expect(errs[1]!.toJSON()).toHaveProperty('expected');
    // 失败码枚举和 errors.ts 一致
    const all: string[] = [...schema.$defs.ErrorCode.enum];
    for (const code of ['BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'PRECONDITION_FAILED', 'RATE_LIMITED', 'RECOVERING', 'REQUEST_EXPIRED', 'ENTRY_VIA_HOME_ONLY', 'STALE_DOMAIN_EPOCH', 'VISIT_NOT_ACTIVE', 'VERSION_MISMATCH']) {
      expect(all).toContain(code);
    }
  });

  it('真实 HTTP：catalog / weather / reconcile / outbox / 访问描述 / 错误响应', async () => {
    const KEY = 'bridge-key-for-schema-test-0123';
    const app = express();
    mountCity(app, c, () => undefined, { bridgeKey: KEY });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/city/bridge/v1`;
    const call = async (method: string, path: string, body?: unknown, key: string | null = KEY): Promise<{ status: number; body: any }> => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const cat = await call('GET', '/catalog');
    expect(cat.status).toBe(200);
    expectValid('Catalog', cat.body);
    expect(cat.body.mappings).toEqual(JSON.parse(readFileSync(new URL('../../../../docs/city/mappings.json', import.meta.url), 'utf8')));
    expectValid('WeatherResponse', (await call('GET', '/weather')).body, 'http weather');
    expectValid('ReconcileResponse', (await call('GET', '/reconcile')).body, 'http reconcile');
    const ob = await call('GET', '/outbox?after=0&limit=200');
    expectValid('OutboxPage', ob.body, 'http outbox');
    expect(ob.body.records.length).toBeGreaterThan(10);
    const vd = await call('GET', `/visits/${k.visitId}`);
    expectValid('VisitDescription', vd.body, 'http describe');

    // 用 HTTP 走一次新的 prepare → abort，回执结构一样
    const k3 = t.kernel('claire');
    const prep = k3.prepareBody({ yen: 500, to: 'akabane:ekimae-plaza', visitId: 'v-claire-http-1' });
    const p = await call('POST', '/visits/prepare', prep);
    expect(p.status).toBe(200);
    expectValid('PrepareReceipt', p.body, 'http prepare');
    const a = await call('POST', `/visits/${k3.visitId}/abort`, { request_id: `${k3.visitId}:abort` });
    expectValid('AbortReceipt', a.body, 'http abort');

    // 再走一次不带东西的完整访问：commit → return-request（真的开始回家）→ 到家 → release → closed
    const full = k3.prepareBody({ yen: 500, to: 'akabane:ekimae-plaza', visitId: 'v-claire-http-2' });
    expect((await call('POST', '/visits/prepare', { ...full, payload_hash: bridgePayloadHash(full) })).status).toBe(200);
    const cm = await call('POST', `/visits/${k3.visitId}/commit`, { request_id: `${k3.visitId}:commit`, transfer_id: 'tr-claire-http-2', domain_epoch: 1 });
    expectValid('CommitReceipt', cm.body, 'http commit');
    const rq = await call('POST', `/visits/${k3.visitId}/return-request`, { request_id: `${k3.visitId}:ret`, reason: 'http' });
    expectValid('ReturnRequestReceipt', rq.body, 'http return-request');
    expect(rq.body.payload).toEqual({ started: true });
    t.run(40 * MIN);
    const done = await call('GET', `/visits/${k3.visitId}`);
    expectValid('VisitDescription', done.body, 'http describe(settled)');
    expect(done.body.state).toBe('settled');
    const rl = await call('POST', `/visits/${k3.visitId}/release`, { request_id: `${k3.visitId}:release`, settlement_id: done.body.settlement.settlement_id, domain_epoch: 2 });
    expectValid('ReleaseReceipt', rl.body, 'http release');
    expect(rl.body.state).toBe('closed');
    const act = await call('POST', `/visits/${k3.visitId}/act`, { request_id: `${k3.visitId}:late`, domain_epoch: 1, action: { type: 'say', text: 'x' } });
    expect(act.status).toBe(409);
    expectValid('Error', act.body, 'http stale act');

    // 各种错误响应
    const errors = [
      await call('GET', '/catalog', undefined, null), // 401
      await call('GET', '/visits/v-nope-0001'), // 404 NOT_FOUND
      await call('GET', '/outbox?after=-1'), // 400
      await call('POST', '/visits/prepare', '{not json'), // 400 body parser
      await call('GET', '/nonsense'), // 404 路由
      await call('POST', '/visits/v-claire-http-1/commit', { request_id: 'v-claire-http-1:commit', transfer_id: 'tr-late-0001', domain_epoch: 9 }), // 409 visit_aborted
    ];
    expect(errors.map((e) => e.status)).toEqual([401, 404, 400, 400, 404, 409]);
    for (const e of errors) expectValid('Error', e.body, `http ${e.status}`);
  });

  it('请求体和回执都被覆盖到了', () => {
    expect([...new Set(seen.requests)].sort()).toEqual(['AbortRequest', 'ActRequest', 'CommitRequest', 'PrepareRequest', 'ReleaseRequest', 'ReturnRequest']);
    expect(seen.receipts).toBeGreaterThan(10);
    expect(nia).toBeTruthy();
  });
});

describe('反例：schema 不是什么都放过', () => {
  const t = makeCity();
  const k = t.kernel('nia');
  const prep = k.prepareBody({ yen: 1000, to: KISSA });
  const good = prepareVisit(t.c, prep) as any;
  const sample = clone(good);

  it('回执缺字段或字段类型不对', () => {
    expectValid('Receipt', sample);
    for (const key of ['receipt_id', 'request_id', 'visit_id', 'state', 'accepted_at_ms', 'payload']) {
      const bad = clone(sample);
      delete bad[key];
      expectInvalid('Receipt', bad);
    }
    expectInvalid('Receipt', { ...sample, state: 'finished' });
    expectInvalid('Receipt', { ...sample, replayed: false });
    expectInvalid('Receipt', { ...sample, accepted_at_ms: 'now' });
    // 各操作的回执要带对应的 state
    expectInvalid('PrepareReceipt', { ...sample, state: 'active' });
    expectInvalid('CommitReceipt', sample);
    expectInvalid('AbortReceipt', { ...sample, payload: {} });
  });

  it('请求体', () => {
    expectInvalid('PrepareRequest', { ...prep, carry: { yen: -1, items: [] } });
    expectInvalid('PrepareRequest', { ...prep, carry: { yen: 10_000_001, items: [] } });
    expectInvalid('PrepareRequest', { ...prep, carry: { yen: 10.5, items: [] } });
    expectInvalid('PrepareRequest', { ...prep, protocol: 'city-bridge/2' });
    expectInvalid('PrepareRequest', { ...prep, request_id: 'short' });
    expectInvalid('PrepareRequest', { ...prep, request_id: 'has space in it' });
    expectInvalid('PrepareRequest', { ...prep, carry: { yen: 1, items: [{ ref: 'x', kernel: { kind: 'food', item: 'cookie' }, qty: 0 }] } });
    expectInvalid('PrepareRequest', { ...prep, plan: { destination: KISSA } });
    const { visit_id: _v, ...noVisit } = prep;
    expectInvalid('PrepareRequest', noVisit);
    expectInvalid('CommitRequest', { request_id: 'commit-0001', transfer_id: 'tr-0001', domain_epoch: 0 });
    expectInvalid('ReleaseRequest', { request_id: 'release-0001', domain_epoch: 2 });
    expectInvalid('ActRequest', { request_id: 'act-request-1', domain_epoch: 1, action: { type: 'dance' } });
    expectInvalid('ActRequest', { request_id: 'act-request-1', domain_epoch: 1 });
    expectInvalid('Action', { type: 'say' });
    expectInvalid('Action', { type: 'buy', sku: 'coffee', qty: 10 });
    expectInvalid('Action', { type: 'consume' });
  });

  it('outbox 记录', () => {
    const k2 = t.kernel('claire');
    k2.depart({ yen: 3000, to: 'akabane:ekimae-plaza' });
    t.run(30 * MIN);
    const recs = readOutbox(t.c, 0, 200).records as any[];
    const progress = recs.find((r) => r.kind === 'visit_progress' && r.payload.phase === 'boarded' && r.visit_id === k2.visitId) ?? recs.find((r) => r.kind === 'visit_progress');
    expectValid('OutboxRecord', progress);
    expectInvalid('OutboxRecord', { ...progress, kind: 'weather_report' });
    expectInvalid('OutboxRecord', { ...progress, kind: 'purchase' });
    expectInvalid('OutboxRecord', { ...progress, seq: 'one' });
    const noRecordId = clone(progress);
    delete noRecordId.record_id;
    expectInvalid('OutboxRecord', noRecordId);
    expectInvalid('OutboxRecord', { ...progress, payload: { ...progress.payload, phase: 'teleported' } });
    const noActor = clone(progress);
    delete noActor.payload.actor_id;
    expectInvalid('OutboxRecord', noActor);
    // boarded 一定要有票价
    const boarded = recs.find((r) => r.kind === 'visit_progress' && r.payload.phase === 'boarded');
    if (boarded) {
      expectValid('OutboxRecord', boarded);
      const noFare = clone(boarded);
      delete noFare.payload.fare_yen;
      expectInvalid('OutboxRecord', noFare);
    }
    const wake = recs.find((r) => r.kind === 'decision_wake');
    expectValid('OutboxRecord', wake);
    expectInvalid('OutboxRecord', { ...wake, payload: { ...wake.payload, reason: 'boredom' } });
    expectInvalid('OutboxPage', { records: [{ ...progress, kind: 'nope' }], next_after: 1, more: false });
    expectInvalid('OutboxPage', { records: [], next_after: -1, more: false });
  });

  it('失败响应和状态枚举', () => {
    expectValid('Error', new CityError('CONFLICT', 'x', 'request_conflict').toJSON());
    expectInvalid('Error', { error: 'TEAPOT', message: 'x' });
    expectInvalid('Error', { error: 'CONFLICT' });
    expectInvalid('VisitState', 'finished');
    expectInvalid('Settlement', { settlement_id: 's' });
    expectInvalid('WeatherSnapshot', { area: 'osaka' });
  });
});
