/**
 * M0 契约守门与隔离故障测试脚手架验证：
 *  1. 校验 docs/city/ 四份 M0 冻结规格文档齐全、核心条款完备；
 *  2. 校验 bridge-v1.schema.json 的 M0/M1 演进项（store_locker / take_locker / disposed / order_refunded / mappings v2 四效果）正反例；
 *  3. 校验 createIsolatedCityHarness 的确定性时钟、503 RECOVERING、F4 回包丢弃重放、F9 purchaseUnknown、F13/F14 天气注入与 F10 跨停机重启恢复。
 */
import { readFileSync } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MAPPINGS, ledgerImbalance } from '../../src/city/index.js';
import { COOKIE, HOUR, KISSA, MIN } from './helpers.js';
import { createIsolatedCityHarness, type IsolatedCityHarness } from './test-harness.js';

const Ajv2020: new (opts: Record<string, unknown>) => any = (Ajv2020Module as any).default ?? Ajv2020Module;
const DOCS_DIR = new URL('../../../../docs/city/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('bridge-v1.schema.json', DOCS_DIR), 'utf8'));
const mappingsJson = JSON.parse(readFileSync(new URL('mappings.json', DOCS_DIR), 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);

function validateDef(def: string, value: unknown): { ok: boolean; text: string } {
  const fn = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!fn) throw new Error(`缺少 schema 定义 $defs/${def}`);
  const ok = Boolean(fn(value));
  return { ok, text: ok ? '' : ajv.errorsText(fn.errors, { separator: '；' }) };
}

describe('M0 四份工程规格文档与 mappings v2 守门', () => {
  it('docs/city/ 下四份核心规格齐全且覆盖全部关键契约条款', () => {
    const specs: { file: string; mustContain: string[] }[] = [
      {
        file: 'IDENTITY-AND-FACTS.md',
        mustContain: ['principal_id', 'resident_id', 'actor_id', 'domain_epoch', 'control_epoch', 'STALE_DOMAIN_EPOCH', 'CONTROL_LOST', 'ENTRY_VIA_HOME_ONLY', 'town.db'],
      },
      {
        file: 'CLIENT-AND-WEB-CONTRACT.md',
        mustContain: ['claim_control', 'heartbeat', 'city_issue_ticket', 'locker_items', 'X-City-CSRF', '/city/play/', '/city/api/stream', 'city-resident', 'botgame://guide/city'],
      },
      {
        file: 'ITEM-AND-LOCKER-SPEC.md',
        mustContain: ['instance', 'origin_ref', 'store_locker', 'take_locker', 'carry_home', 'disposed', 'resolvePendingOrder', 'order_refunded', 'mappings_version: 2'],
      },
      {
        file: 'CONTENT-PACK-SPEC.md',
        mustContain: ['mun:13', 'st:', 'dist:', 'cataloged', 'transitable', 'livable', 'PLACE_OF_STATION', 'akabane:ai-house:entrance'],
      },
    ];
    for (const { file, mustContain } of specs) {
      const content = readFileSync(new URL(file, DOCS_DIR), 'utf8');
      expect(content.length, `${file} 不应为空`).toBeGreaterThan(1500);
      for (const token of mustContain) {
        expect(content, `${file} 缺少关键契约词 ${token}`).toContain(token);
      }
    }
  });

  it('mappings.json 与 mappings.ts 锁定 version = 2 且对齐 life1 四项身体效果', () => {
    expect(mappingsJson.version).toBe(3);
    expect(MAPPINGS.version).toBe(3);
    expect(mappingsJson).toEqual(MAPPINGS);
    const effects = [...new Set<string>(mappingsJson.effects.map((e: any) => String(e.kernel_effect)))].sort();
    expect(effects).toEqual(['drink_coffee', 'drink_tea', 'snack', 'walk_15m']);
    expect(validateDef('MappingsTable', mappingsJson).ok).toBe(true);
    expect(
      validateDef('MappingsTable', {
        ...mappingsJson,
        effects: [{ engine_kind: 'drank', engine_type: 'coffee', kernel_effect: 'unknown_caffeine_boost' }],
      }).ok,
    ).toBe(false);
  });

  it('bridge-v1.schema.json 支持 M1 储物柜动作、热饮 disposed 与关单后退款 outbox 记录', () => {
    // store_locker / take_locker 正反例
    expect(validateDef('Action', { type: 'store_locker', item_id: 'it_abc123', qty: 1 }).ok).toBe(true);
    expect(validateDef('Action', { type: 'take_locker', item: 'umbrella', qty: 2 }).ok).toBe(true);
    expect(validateDef('Action', { type: 'store_locker' }).ok).toBe(false);
    expect(validateDef('Action', { type: 'take_locker', item: 'umbrella', qty: 0 }).ok).toBe(false);
    expect(validateDef('Action', { type: 'store_locker', item: 'umbrella', qty: 100 }).ok).toBe(false);

    // Settlement 支持 fate: disposed 与 notes
    const settlementSample = {
      settlement_id: 'set_m0test001',
      visit_id: 'v-nia-m0',
      actor_id: 'nia',
      cutoff_seq: 8,
      carry_yen: 20_000,
      purse_final_yen: 19_150,
      items: [
        { engine_item_id: 'it_1', origin_ref: 'res:cookie:1', type: 'cookie', qty: 1, fate: 'back' },
        { engine_item_id: 'it_2', origin_ref: null, type: 'paperback', qty: 1, fate: 'locker' },
        { engine_item_id: 'it_3', origin_ref: null, type: 'coffee', qty: 1, fate: 'disposed' },
      ],
      consumed: [],
      given: [],
      pending: [],
      spend_summary: [{ what: '混合咖啡', yen: -450 }],
      notes: ['现点饮品（混合咖啡×1）不便带回或寄存，已在返程前妥善处理。'],
      settled_at_ms: 1794931200000,
    };
    const sRes = validateDef('Settlement', settlementSample);
    expect(sRes.ok, sRes.text).toBe(true);

    // OutboxRecord 支持 order_refunded 正反例
    const refundRecord = {
      seq: 12,
      visit_id: 'v-nia-m0',
      kind: 'order_refunded',
      record_id: 'v-nia-m0:refund:ord_001',
      occurred_at_ms: 1794935000000,
      payload: {
        actor_id: 'nia',
        order_id: 'ord_001',
        yen: 520,
        all_pending_cleared: true,
      },
    };
    const rRes = validateDef('OutboxRecord', refundRecord);
    expect(rRes.ok, rRes.text).toBe(true);
    expect(
      validateDef('OutboxRecord', {
        ...refundRecord,
        payload: { actor_id: 'nia', order_id: 'ord_001', yen: 0, all_pending_cleared: true },
      }).ok,
    ).toBe(false);
  });
});

describe('隔离联调测试环境与确定性故障注入脚手架', () => {
  let harness: IsolatedCityHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.close({ cleanup: true });
      harness = null;
    }
  });

  async function bridgeCall(h: IsolatedCityHarness, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${h.bridgeUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${h.bridgeKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  }

  it('支持 503 RECOVERING 注入、F4 回包丢弃幂等恢复、F9 未决订单、F13/F14 天气注入与 F10 停机重启恢复', async () => {
    harness = await createIsolatedCityHarness({ enableControlRoutes: true });
    const h = harness;

    // 1. F13/F14 天气控制：先注入池袋下雨，再连续超时超 3h 验证退回 fallback
    h.setAreaRain({ ikebukuro: true, akabane: false, shinjuku: false });
    const w1 = await bridgeCall(h, 'GET', '/weather');
    expect(w1.status).toBe(200);
    expect(w1.body.areas.find((a: any) => a.area === 'ikebukuro')).toMatchObject({ rain: true, status: 'ok' });
    expect(w1.body.areas.find((a: any) => a.area === 'akabane')).toMatchObject({ rain: false, status: 'ok' });

    h.advance(4 * HOUR);
    h.injectWeather(null);
    const w2 = await bridgeCall(h, 'GET', '/weather');
    expect(w2.body.areas.every((a: any) => a.status === 'fallback' && a.rain === false)).toBe(true);

    // 2. 注入 503 RECOVERING：前两次 prepare 返回 503，第三次用同一 request_id 成功且只建一条记录
    h.faults.bridge503Count = 2;
    const visitId = 'v-nia-harness-1';
    const prepBody = {
      request_id: `${visitId}:prepare`,
      protocol: 'city-bridge/1',
      vocab_version: 'life1-0.2',
      mappings_version: 3,
      visit_id: visitId,
      actor_id: 'nia',
      carry: { yen: 10_000, items: [COOKIE] },
      plan: { destination: KISSA, start_at_ms: h.clock.t, return_by_ms: h.clock.t + 2 * HOUR },
    };
    expect((await bridgeCall(h, 'POST', '/visits/prepare', prepBody)).status).toBe(503);
    expect((await bridgeCall(h, 'POST', '/visits/prepare', prepBody)).status).toBe(503);
    const prepOk = await bridgeCall(h, 'POST', '/visits/prepare', prepBody);
    expect(prepOk.status).toBe(200);
    expect(prepOk.body.state).toBe('prepared');

    // 3. F4：dropResponseOnce 让 commit 在落盘后断连丢包；查询 GET /visits/:id 为 active，原 request_id 重发得 replayed: true
    h.faults.dropResponseOnce = true;
    const commitBody = { request_id: `${visitId}:commit`, transfer_id: `tr-${visitId}`, domain_epoch: 1 };
    await expect(bridgeCall(h, 'POST', `/visits/${visitId}/commit`, commitBody)).rejects.toThrow();

    const descAfterDrop = await bridgeCall(h, 'GET', `/visits/${visitId}`);
    expect(descAfterDrop.status).toBe(200);
    expect(descAfterDrop.body.state).toBe('active');

    const commitReplay = await bridgeCall(h, 'POST', `/visits/${visitId}/commit`, commitBody);
    expect(commitReplay.status).toBe(200);
    expect(commitReplay.body.replayed).toBe(true);

    // 4. 推进 31 分钟到达喫茶「灯」，注入 F9 purchaseUnknown 产生 pending 订单
    h.advance(31 * MIN);
    h.faults.purchaseUnknown = 'cheesecake';
    const buyUnknown = await bridgeCall(h, 'POST', `/visits/${visitId}/act`, {
      request_id: `${visitId}:d1:a1`,
      domain_epoch: 1,
      action: { type: 'buy', sku: 'cheesecake', qty: 1 },
    });
    expect(buyUnknown.status).toBe(200);
    expect(buyUnknown.body.payload).toMatchObject({ status: 'pending', reason: 'outcome_unknown', held_yen: 520 });
    h.faults.purchaseUnknown = false;

    // 5. F10：停机 95 分钟跨过 return_by_ms，重启同一 city-test.db 后自动补跑回程并结算
    await h.restart(95 * MIN);
    // 重启恢复已触发到期 visit_return 排上回程行程；推进回程耗时到达小屋门口结算
    h.advance(35 * MIN);
    const descSettled = await bridgeCall(h, 'GET', `/visits/${visitId}`);
    expect(descSettled.status).toBe(200);
    expect(descSettled.body.state).toBe('settled');
    expect(descSettled.body.settlement.pending).toHaveLength(1);
    expect(ledgerImbalance(h.city)).toBe(0);

    const rel = await bridgeCall(h, 'POST', `/visits/${visitId}/release`, {
      request_id: `${visitId}:release`,
      settlement_id: descSettled.body.settlement.settlement_id,
      domain_epoch: 2,
    });
    expect(rel.status).toBe(200);
    expect(rel.body.state).toBe('reconcile');
    expect(rel.body.payload.reconcile_ok).toBe(true);
    expect(ledgerImbalance(h.city)).toBe(0);
  });
});
