import express from 'express';
import { describe, expect, it } from 'vitest';
import { mountCity } from '../../src/city/http.js';
import { APPAREL_CATALOG, apparelWindowForPlace } from '../../src/city/apparel-catalog.js';
import { resolvePendingOrder } from '../../src/city/actions.js';
import { runReconcile } from '../../src/city/reconcile.js';
import { HOUR, MIN, makeCity } from './helpers.js';

describe('晴空都服饰买手店与 mappings v3 返家入柜闭环 (#260)', () => {
  it('全量收录 1,407 套服饰（SFW 1,068 + 私密 339），三家店按日确定性轮换且单次视图不超 4 KB', () => {
    expect(APPAREL_CATALOG).toHaveLength(1407);
    expect(APPAREL_CATALOG.filter((x) => x.tier === 'sfw')).toHaveLength(1068);
    expect(APPAREL_CATALOG.filter((x) => x.tier === 'intimate')).toHaveLength(339);

    const w1 = apparelWindowForPlace('ryokogai:suzuran-closet', '2026-11-18');
    const w2 = apparelWindowForPlace('ryokogai:suzuran-closet', '2026-11-19');
    expect(w1).toHaveLength(6);
    expect(w2).toHaveLength(6);
    expect(w1.map((x) => x.sku)).not.toEqual(w2.map((x) => x.sku));

    const t = makeCity();
    const b = t.bot('旅人A', { entry: 'ryokogai:station' });
    b.act({ type: 'travel', to: 'ryokogai:suzuran-closet' });
    t.run(10 * MIN);
    const viewBytes = Buffer.byteLength(JSON.stringify(b.view()), 'utf8');
    expect(viewBytes).toBeLessThan(4096);
  });

  it('室友自购服饰 + 收到外部 Bot 买衣送礼（含私密店礼盒）-> 返家 Settlement 标 fate=back 携带可信 asset_id，防 meta 伪造', () => {
    const t = makeCity();
    const nia = t.kernel('nia');
    const niaResId = t.residentOf('nia');
    const bot = t.bot('送礼友人', { entry: 'kumominato:station', stay: true });

    // 外部 Bot 先去云港「丝绒私语」买一件私密服饰礼盒，再去棱光街「铃兰衣橱」等妮娅
    t.run(2 * HOUR); // 先推进到 12:00 JST 丝绒私语开门
    bot.act({ type: 'travel', to: 'kumominato:velours-intime' });
    t.run(10 * MIN);
    const veloursSku = (bot.view().here as any).goods[0].sku as string;
    const boughtGift = bot.act({ type: 'buy', sku: veloursSku });
    expect((boughtGift.item as any).instance).toBe(true);
    const giftItemId = (boughtGift.item as any).item_id as string;

    // 尝试在数据库伪造 untrusted meta_json 中的 asset_id，验证结算只认服务端 origin_json
    t.c.db.run(
      'UPDATE items SET meta_json = ? WHERE item_id = ?',
      JSON.stringify({ title: '试图伪造', asset_id: 'pa_forged_9999', untrusted: true }),
      giftItemId,
    );

    bot.act({ type: 'travel', to: 'ryokogai:suzuran-closet' });
    nia.depart({ yen: 20_000, items: [], to: 'ryokogai:suzuran-closet' });
    t.run(40 * MIN);

    const suzuranGood = (nia.view().here as any).goods[0];
    nia.act({ type: 'buy', sku: suzuranGood.sku });
    bot.act({ type: 'give', to: niaResId, item_id: giftItemId });

    nia.act({ type: 'go_home' });
    t.run(40 * MIN);
    nia.pull();
    const settled = nia.settlement!;
    expect(settled).not.toBeNull();
    const backApparel = settled.items.filter((i) => i.type === 'apparel_bundle' && i.fate === 'back');
    expect(backApparel).toHaveLength(2);
    const grantedAssets = backApparel.map((i) => i.kernel!).sort((a, b) => a.item.localeCompare(b.item));
    expect(grantedAssets.every((k) => k.kind === 'wardrobe_asset' && k.item.startsWith('pa_'))).toBe(true);
    expect(grantedAssets.some((k) => k.item === 'pa_forged_9999')).toBe(false);

    const rel = nia.release();
    expect(rel.state).toBe('closed');
    expect(runReconcile(t.c, 'test').ok).toBe(true);
  });

  it('F9 未决服饰订单在室友返家关单后确认为已成交 -> 自动发入个人车站储物柜，下次进城可取出带回家', () => {
    const t = makeCity();
    const nia = t.kernel('nia');
    t.run(HOUR); // 先推进到 11:00 JST 流光工坊开门
    nia.depart({ yen: 20_000, items: [], to: 'kumominato:lumiere-atelier' });
    t.run(50 * MIN);

    const sku = (nia.view().here as any).goods[0].sku as string;
    t.c.failpoints.purchaseUnknown = () => true;
    const pendingRes = nia.act({ type: 'buy', sku });
    expect(pendingRes.payload.status).toBe('pending');
    const orderId = String(pendingRes.payload.order_id);
    t.c.failpoints.purchaseUnknown = undefined;

    nia.act({ type: 'go_home' });
    t.run(50 * MIN);
    expect(nia.release().state).toBe('reconcile');

    // 跨日之后店家确认成交（即使次日橱窗已轮换，仍能按全池解析 assetId 发入 locker）
    t.run(24 * HOUR);
    const resolved = resolvePendingOrder(t.c, orderId, 'completed');
    expect(resolved.reconcile_ok).toBe(true);
    expect(resolved.visit_state).toBe('closed');

    // 下次进城到车站即可从储物柜取出并带回家结算为 fate=back
    nia.depart({ yen: 5_000, items: [], to: 'hiyorizaka:station' });
    t.run(20 * MIN);
    const lockerList = (nia.view() as any).locker_items;
    expect(lockerList).toHaveLength(1);
    expect(lockerList[0].type).toBe('apparel_bundle');
    expect(lockerList[0].instance).toBe(true);
    nia.act({ type: 'take_locker', item_id: lockerList[0].item_id });
    nia.act({ type: 'go_home' });
    t.run(20 * MIN);
    nia.pull();
    const s2 = nia.settlement!;
    expect(s2.items.some((i) => i.type === 'apparel_bundle' && i.fate === 'back' && i.kernel?.kind === 'wardrobe_asset')).toBe(true);
    expect(nia.release().state).toBe('closed');
    expect(runReconcile(t.c, 'test2').ok).toBe(true);
  });

  it('R260-04 & P3：跨日后 /city/bridge/v1/catalog 与店内实时橱窗完全一致，且流光工坊春夏常驻包含派对礼服', async () => {
    const t = makeCity();
    const app = express();
    const close = mountCity(app, t.c, () => {}, { bridgeKey: 'test_bridge_key_260' });
    const srv = await new Promise<import('node:http').Server>((res) => {
      const s = app.listen(0, '127.0.0.1', () => res(s));
    });
    try {
      const addr = srv.address() as import('node:net').AddressInfo;
      t.run(50 * HOUR);
      expect(t.c.today(t.c.now())).toBe('2026-11-19');

      const resp = await fetch(`http://127.0.0.1:${addr.port}/city/bridge/v1/catalog`, {
        headers: { Authorization: 'Bearer test_bridge_key_260' },
      });
      const cat = (await resp.json()) as any;
      const catalogSkus = cat.places
        .find((p: any) => p.id === 'ryokogai:suzuran-closet')
        .goods.map((g: any) => g.sku);

      const b = t.bot('跨日旅人', { entry: 'ryokogai:station' });
      b.act({ type: 'travel', to: 'ryokogai:suzuran-closet' });
      t.run(10 * MIN);
      const liveShopSkus = ((b.view().here as any).goods as any[]).map((g: any) => g.sku);
      expect(catalogSkus).toEqual(liveShopSkus);

      let partySeenSpringSummer = 0;
      for (const m of ['03', '04', '05', '06', '07', '08']) {
        for (let d = 1; d <= 28; d++) {
          const w = apparelWindowForPlace('kumominato:lumiere-atelier', `2026-${m}-${String(d).padStart(2, '0')}`);
          partySeenSpringSummer += w.filter((x) => x.cat === 'party').length;
        }
      }
      expect(partySeenSpringSummer).toBeGreaterThan(0);
    } finally {
      close();
      await new Promise<void>((res) => srv.close(() => res()));
    }
  });
});
