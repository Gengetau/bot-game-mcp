/**
 * M0 契约守门单测（#247）：
 *  1. bridge-v1.schema.json 的 mappings_version=2、四个 life1 身体效果名枚举、store_locker/take_locker、
 *     现点热饮 disposed / locker 正常 closed、六街区 AreaId 与 CONTROL_LOST 错误码；
 *  2. docs/city/mappings.json（v2）与四个 life1 效果名的双向核对；
 *  3. docs/city/IDENTITY-AND-FACTS.md 与 ITEM-AND-LOCKER-SPEC.md 章节完整性守门。
 */
import { existsSync, readFileSync } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { MAPPINGS, kernelEffectOf, walkEffect } from '../../src/city/mappings.js';

const Ajv2020: new (opts: Record<string, unknown>) => any = (Ajv2020Module as any).default ?? Ajv2020Module;

const cityDocsDir = new URL('../../../../docs/city/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('bridge-v1.schema.json', cityDocsDir), 'utf8'));
const mappingsJson = JSON.parse(readFileSync(new URL('mappings.json', cityDocsDir), 'utf8'));

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);

function validateDef(def: string, value: unknown): boolean {
  const fn = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!fn) throw new Error(`missing $defs/${def}`);
  return Boolean(fn(value));
}

describe('M0 桥接协议与 life1 词表对齐守门', () => {
  it('锁定 mappings_version = 2，拒绝旧版本或未知版本', () => {
    expect(schema['x-mappings-version']).toBe(3);
    expect(mappingsJson.version).toBe(3);
    expect(MAPPINGS.version).toBe(3);
    expect(validateDef('MappingsTable', mappingsJson)).toBe(true);
    expect(validateDef('MappingsTable', { ...mappingsJson, version: 1 })).toBe(false);

    const basePrepare = {
      request_id: 'visit:v1:prepare',
      protocol: 'city-bridge/1',
      mappings_version: 3,
      visit_id: 'v-nia-m0',
      actor_id: 'nia',
      carry: {
        yen: 20_000,
        items: [
          {
            ref: 'res:cookie:1#1',
            kernel: { kind: 'food', item: 'cookie' },
            qty: 1,
            meta: { author_name: '妮娅', untrusted: true },
          },
        ],
      },
      plan: {
        destination: 'kagamiike:kissa-tomoshibi',
        start_at_ms: 1_794_900_000_000,
        return_by_ms: 1_794_910_000_000,
      },
    };
    expect(validateDef('PrepareRequest', basePrepare)).toBe(true);
    expect(validateDef('PrepareRequest', { ...basePrepare, mappings_version: 1 })).toBe(false);
    expect(validateDef('PrepareRequest', { ...basePrepare, mappings_version: 2 })).toBe(false);
    expect(validateDef('PrepareRequest', { ...basePrepare, mappings_version: 4 })).toBe(false);
  });

  it('四个城市身体效果名与 life1 约定严格一致（snack / drink_coffee / drink_tea / walk_15m）', () => {
    const expectedEffects = ['drink_coffee', 'drink_tea', 'snack', 'walk_15m'];
    const fromMappings = [...new Set(MAPPINGS.effects.map((e) => e.kernel_effect))].sort();
    expect(fromMappings).toEqual(expectedEffects);

    expect(kernelEffectOf('ate', 'cookie')).toBe('snack');
    expect(kernelEffectOf('ate', 'cheesecake')).toBe('snack');
    expect(kernelEffectOf('drank', 'coffee')).toBe('drink_coffee');
    expect(kernelEffectOf('drank', 'milk_tea')).toBe('drink_tea');
    expect(kernelEffectOf('drank', 'green_tea')).toBe('drink_tea');
    expect(walkEffect()).toEqual({ minutes: 15, kernel_effect: 'walk_15m' });

    for (const effect of [...expectedEffects, null]) {
      expect(
        validateDef('BodyEffectPayload', {
          actor_id: 'nia',
          effect_id: 'v-nia-m0:e1',
          engine_kind: effect === 'walk_15m' ? 'walked' : 'drank',
          ...(effect === 'walk_15m' ? { minutes: 15 } : { engine_type: 'coffee', qty: 1 }),
          kernel_effect: effect,
        }),
      ).toBe(true);
    }
    expect(
      validateDef('BodyEffectPayload', {
        actor_id: 'nia',
        effect_id: 'v-nia-m0:e2',
        engine_kind: 'drank',
        engine_type: 'coffee',
        qty: 1,
        kernel_effect: 'caffeine_boost_invented',
      }),
    ).toBe(false);
  });

  it('Action 支持 store_locker 与 take_locker，且校验必填物品选择子和数量边界', () => {
    expect(validateDef('Action', { type: 'store_locker', item_id: 'it_book_1' })).toBe(true);
    expect(validateDef('Action', { type: 'store_locker', item: 'paperback', qty: 2 })).toBe(true);
    expect(validateDef('Action', { type: 'take_locker', item_id: 'it_umb_1' })).toBe(true);
    expect(validateDef('Action', { type: 'take_locker', item: 'postcard', qty: 5 })).toBe(true);

    expect(validateDef('Action', { type: 'store_locker' })).toBe(false);
    expect(validateDef('Action', { type: 'take_locker', qty: 1 })).toBe(false);
    expect(validateDef('Action', { type: 'store_locker', item: 'paperback', qty: 100 })).toBe(false);
  });

  it('Settlement 支持现点热饮 disposed、具名实例件 meta，以及含 locker 时正常 closed 的 ReleaseReceipt', () => {
    const settlement = {
      settlement_id: 'set_m0_1',
      visit_id: 'v-nia-m0',
      actor_id: 'nia',
      cutoff_seq: 12,
      carry_yen: 20_000,
      purse_final_yen: 18_300,
      items: [
        {
          engine_item_id: 'it_cookie_1',
          origin_ref: 'res:cookie:1',
          type: 'cookie',
          qty: 1,
          fate: 'back',
          instance: 1,
          meta: null,
        },
        {
          engine_item_id: 'it_book_1',
          origin_ref: null,
          type: 'paperback',
          qty: 1,
          fate: 'locker',
          instance: 1,
          meta: { title: '银河铁道之夜', reading_progress: 1, untrusted: true },
        },
        {
          engine_item_id: 'it_coffee_1',
          origin_ref: null,
          type: 'coffee',
          qty: 1,
          fate: 'disposed',
          instance: 0,
        },
      ],
      consumed: [],
      given: [],
      pending: [],
      spend_summary: [
        { what: '电车', yen: -400 },
        { what: '文库本', yen: -800 },
        { what: '咖啡', yen: -450 },
      ],
      notes: ['未饮完的混合咖啡已在返家前处理，未带回或寄存。'],
      settled_at_ms: 1_794_905_000_000,
    };
    expect(validateDef('Settlement', settlement)).toBe(true);

    const releaseClosed = {
      receipt_id: 'rcpt_rel_1',
      request_id: 'visit:v-nia-m0:release',
      visit_id: 'v-nia-m0',
      state: 'closed',
      accepted_at_ms: 1_794_905_001_000,
      payload: {
        settlement_id: 'set_m0_1',
        purse_final_yen: 18_300,
        home_epoch: 2,
        reconcile_ok: true,
      },
    };
    expect(validateDef('ReleaseReceipt', releaseClosed)).toBe(true);

    const refundOutbox = {
      seq: 13,
      visit_id: 'v-nia-m0',
      kind: 'order_refunded',
      record_id: 'v-nia-m0:refund:ord_1',
      occurred_at_ms: 1_794_906_000_000,
      payload: {
        actor_id: 'nia',
        order_id: 'ord_1',
        yen: 520,
        all_pending_cleared: true,
      },
    };
    expect(validateDef('OutboxRecord', refundOutbox)).toBe(true);
  });

  it('AreaId 严格锁定 R0 三片区并拒绝旧现实地名与未知地区，ErrorCode 包含 CONTROL_LOST', () => {
    for (const area of ['hiwatari', 'kagamiike', 'sentou']) {
      expect(validateDef('AreaId', area)).toBe(true);
    }
    for (const bad of ['akabane', 'ikebukuro', 'shinjuku', 'jinbocho', 'shimokitazawa', 'asakusa', 'osaka']) {
      expect(validateDef('AreaId', bad)).toBe(false);
    }
    expect(
      validateDef('Error', {
        error: 'CONTROL_LOST',
        message: '这位居民的控制权已被另一个客户端接管。',
        control: { epoch: 3, mine: false },
      }),
    ).toBe(true);
  });

  it('M0 内核主笔规格文档存在且包含核心契约章节', () => {
    const identityFile = new URL('IDENTITY-AND-FACTS.md', cityDocsDir);
    const itemFile = new URL('ITEM-AND-LOCKER-SPEC.md', cityDocsDir);
    expect(existsSync(identityFile)).toBe(true);
    expect(existsSync(itemFile)).toBe(true);

    const identityText = readFileSync(identityFile, 'utf8');
    for (const token of ['principal_id', 'resident_id', 'actor_id', 'domain_epoch', 'control_epoch', 'CONTROL_LOST', 'town.db', '¥200,000', 'walk_15m']) {
      expect(identityText).toContain(token);
    }

    const itemText = readFileSync(itemFile, 'utf8');
    for (const token of ['instance = 0', 'instance = 1', 'origin_ref', 'carry_home: false', 'store_locker', 'take_locker', 'disposed', 'carried_item_outside_visit']) {
      expect(itemText).toContain(token);
    }
  });
});
