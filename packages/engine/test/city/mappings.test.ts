/**
 * docs/city/mappings.json 是给内核侧读的权威副本；这里保证它和引擎里的常量逐字一致。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ITEM_TYPES } from '../../src/city/catalog.js';
import { MAPPINGS, engineTypeOf, kernelItemOf } from '../../src/city/mappings.js';

const file = new URL('../../../../docs/city/mappings.json', import.meta.url);

describe('docs/city/mappings.json', () => {
  const text = readFileSync(file, 'utf8');

  it('和 MAPPINGS 常量完全一致', () => {
    expect(JSON.parse(text)).toEqual(MAPPINGS);
  });

  it('是两空格缩进、带结尾换行的格式化 JSON', () => {
    expect(text).toBe(`${JSON.stringify(MAPPINGS, null, 2)}\n`);
  });

  it('每个 engine_type 都在 ITEM_TYPES 里', () => {
    const known = new Set(ITEM_TYPES.map((i) => i.type));
    const mappings = JSON.parse(text) as typeof MAPPINGS;
    for (const m of mappings.items) expect(known.has(m.engine_type), m.engine_type).toBe(true);
    for (const e of mappings.effects) if (e.engine_type !== undefined) expect(known.has(e.engine_type), e.engine_type).toBe(true);
  });

  it('每种引擎物品类型最多一行；双向的行里每种内核资源最多一行；edible 和目录一致', () => {
    const types = MAPPINGS.items.map((m) => m.engine_type);
    expect(new Set(types).size).toBe(types.length);
    const both = MAPPINGS.items.filter((m) => m.direction === undefined).map((m) => `${m.kernel.kind}/${m.kernel.item}`);
    expect(new Set(both).size).toBe(both.length);
    for (const m of MAPPINGS.items) expect(m.edible, m.engine_type).toBe(ITEM_TYPES.find((i) => i.type === m.engine_type)!.kind !== 'thing');
    const effects = MAPPINGS.effects.map((e) => `${e.engine_kind}/${e.engine_type ?? ''}`);
    expect(new Set(effects).size).toBe(effects.length);
  });

  it('engineTypeOf / kernelItemOf 往返不丢信息', () => {
    for (const m of MAPPINGS.items) {
      // 回家方向：每种引擎物品类型只对到一种内核资源
      expect(kernelItemOf(m.engine_type)).toEqual(m.kernel);
      // 出门方向：只有双向的行参与；「只回家」的行不让内核的大类变成城里的某个具体品种
      if (m.direction === undefined) expect(engineTypeOf(m.kernel)).toBe(m.engine_type);
    }
    expect(engineTypeOf({ kind: 'food', item: 'bread' })).toBeNull();
    expect(engineTypeOf({ kind: 'food', item: 'coffee' })).toBeNull();
    expect(engineTypeOf({ kind: 'food', item: 'bottled_tea' })).toBe('green_tea');
    expect(kernelItemOf('coffee_beans')).toEqual({ kind: 'food', item: 'coffee' });
    // 一杯现点的咖啡不是内核的那包咖啡
    expect(kernelItemOf('coffee')).toBeNull();
    expect(engineTypeOf({ kind: 'food', item: 'no-such' })).toBeNull();
    expect(kernelItemOf('no-such')).toBeNull();
  });
});
