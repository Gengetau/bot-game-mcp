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

  it('engineTypeOf / kernelItemOf 往返不丢信息', () => {
    for (const m of MAPPINGS.items) {
      expect(engineTypeOf(m.kernel)).toBe(m.engine_type);
      expect(kernelItemOf(m.engine_type)).toEqual(m.kernel);
    }
    expect(engineTypeOf({ kind: 'food', item: 'no-such' })).toBeNull();
    expect(kernelItemOf('no-such')).toBeNull();
  });
});
