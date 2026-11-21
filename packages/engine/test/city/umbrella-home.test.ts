/**
 * mappings v4（11-21）：城里买的透明雨伞回家变成她自己的配饰（内核 garment/umbrella），下雨天出门算「自有雨伞」。
 * 借来的伞不是她的，仍然留在城市储物柜。
 */
import { describe, expect, it } from 'vitest';
import { runReconcile } from '../../src/city/reconcile.js';
import { MAPPINGS, engineTypeOf, kernelItemOf } from '../../src/city/mappings.js';
import { MIN, makeCity } from './helpers.js';

describe('mappings v4：城里买的雨伞带回家', () => {
  it('映射表 v4 有雨伞这一行，只回家', () => {
    expect(MAPPINGS.version).toBe(4);
    expect(kernelItemOf('umbrella')).toEqual({ kind: 'garment', item: 'umbrella' });
    expect(engineTypeOf({ kind: 'garment', item: 'umbrella' })).toBeNull();
    // 文库本、明信片、笔记本这一版还不回家
    for (const t of ['paperback', 'postcard', 'notebook']) expect(kernelItemOf(t)).toBeNull();
  });

  it('买的伞结算 fate=back 带内核目标；借来的伞留在储物柜', () => {
    const t = makeCity();
    const nia = t.kernel('nia');
    nia.depart({ yen: 5000, items: [], to: 'ryokogai:ekimae-conbini' });
    t.run(40 * MIN);
    nia.act({ type: 'buy', sku: 'umbrella', qty: 1 });
    const held = (nia.view().items as any[]).find((i) => i.type === 'umbrella');
    expect(held?.can_go_home).toBe(true);
    nia.act({ type: 'go_home' });
    t.run(40 * MIN);
    nia.pull();
    expect(nia.settlement!.items).toContainEqual(
      expect.objectContaining({ type: 'umbrella', fate: 'back', qty: 1, kernel: { kind: 'garment', item: 'umbrella' } }),
    );
    expect(nia.release().state).toBe('closed');
    expect(runReconcile(t.c, 'umbrella-back').ok).toBe(true);

    // 第二次：买一把，再模拟「借来的」（borrowed_from 指向别人），结算留在储物柜
    const other = t.bot('借伞的人', { entry: 'ryokogai:station', stay: true });
    nia.depart({ yen: 5000, items: [], to: 'ryokogai:ekimae-conbini' });
    t.run(40 * MIN);
    const bought = nia.act({ type: 'buy', sku: 'umbrella', qty: 1 });
    const itemId = (bought.payload as any).item.item_id as string;
    t.c.db.run('UPDATE items SET borrowed_from = ? WHERE item_id = ?', other.id, itemId);
    const borrowed = (nia.view().items as any[]).find((i) => i.item_id === itemId);
    expect(borrowed?.can_go_home).toBe(false);
    nia.act({ type: 'go_home' });
    t.run(40 * MIN);
    nia.pull();
    const row = nia.settlement!.items.find((i) => i.engine_item_id === itemId)!;
    expect(row.fate).toBe('locker');
    expect(row.kernel).toBeUndefined();
  });
});
