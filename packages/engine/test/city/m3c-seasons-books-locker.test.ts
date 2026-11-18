import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { mountCity } from '../../src/city/http.js';
import {
  goodsForPlace,
  place,
  publicCityView,
  resolvePendingOrder,
  runReconcile,
  selfView,
} from '../../src/city/index.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { HOUR, MIN, T0, makeCity, rejects } from './helpers.js';

describe('东京 M3-C：时令物候商品（晚间八折 / 冬夏售货机 / 24h便利店）', () => {
  it('纯函数切面：19:30 后「麦之灯」晚间余量八折（整数日元取整入账），20:00 打烊后拒买', () => {
    // T0 = 2026-11-17 10:00 JST
    const t = makeCity({ at: T0 });
    const b = t.bot('夜归面包客', { entry: 'shinjuku:station' });
    b.go('shinjuku:muginohi');

    // 10:00 JST 原价购买 1 个菠萝包（¥230）
    const morningBuy = b.act({ type: 'buy', sku: 'melon_pan', qty: 1 });
    expect(morningBuy.paid_yen).toBe(230);

    // b.go 已用去 5 分钟（10:05），推进到 19:29 JST：仍为原价
    t.run(9 * HOUR + 24 * MIN);
    expect((b.view().here as any).goods.find((g: any) => g.sku === 'melon_pan').price_yen).toBe(230);

    // 推进 1 分钟到 19:30 JST：挂出晚间余量八折（¥230->¥184, ¥260->¥208, ¥280->¥224）
    t.run(1 * MIN);
    const pub = publicCityView(t.c) as any;
    const pubMuginohi = pub.areas.find((a: any) => a.id === 'shinjuku').places.find((p: any) => p.id === 'shinjuku:muginohi');
    expect(pubMuginohi.goods.find((g: any) => g.sku === 'melon_pan')).toMatchObject({
      price_yen: 184,
      original_price_yen: 230,
      discount_label: '晚间八折',
    });

    const eveGoods = (b.view().here as any).goods;
    expect(eveGoods.find((g: any) => g.sku === 'melon_pan').price_yen).toBe(184);
    expect(eveGoods.find((g: any) => g.sku === 'cream_bun').price_yen).toBe(208);
    expect(eveGoods.find((g: any) => g.sku === 'cookie').price_yen).toBe(224);

    // 纯函数多次调用确定性一致
    const muginohi = place('shinjuku:muginohi')!;
    expect(goodsForPlace(muginohi, { dateStr: '2026-11-17', jstMonth: 11, minuteOfDay: 19 * 60 + 30 })).toEqual(
      goodsForPlace(muginohi, { dateStr: '2026-11-17', jstMonth: 11, minuteOfDay: 19 * 60 + 30 }),
    );

    const beforeYen = b.view().wallet.yen;
    const b1 = b.act({ type: 'buy', sku: 'melon_pan', qty: 2 });
    const b2 = b.act({ type: 'buy', sku: 'cream_bun', qty: 1 });
    expect(b1.paid_yen).toBe(368);
    expect(b2.paid_yen).toBe(208);
    expect(b.view().wallet.yen).toBe(beforeYen - 576);
    expect(runReconcile(t.c, 'muginohi-discount').ok).toBe(true);

    // 20:00 JST 打烊
    t.run(30 * MIN);
    rejects(() => b.act({ type: 'buy', sku: 'melon_pan', qty: 1 }), 'PRECONDITION_FAILED', 'place_closed');
  });

  it('24h 自动售货机冬季（11–3月）供应热玉米浓汤/红豆汤，夏季（6–9月）切换盐味荔枝饮', () => {
    // 冬季：2026-01-15 03:00 JST
    const winterAt = Date.UTC(2026, 0, 14, 18, 0, 0);
    const tw = makeCity({ at: winterAt });
    const bw2 = tw.bot('冬夜旅人', { entry: 'shinjuku:station' });
    const wSkus = (bw2.view().here as any).goods.map((g: any) => g.sku);
    expect(wSkus).toContain('hot_corn_soup');
    expect(wSkus).toContain('hot_red_bean_soup');
    expect(wSkus).not.toContain('salted_lychee');
    expect(bw2.act({ type: 'buy', sku: 'hot_corn_soup', qty: 1 }).paid_yen).toBe(160);
    expect(bw2.act({ type: 'consume', item: 'hot_corn_soup', qty: 1 }).consumed.type).toBe('hot_corn_soup');
    rejects(() => bw2.act({ type: 'buy', sku: 'salted_lychee', qty: 1 }), 'PRECONDITION_FAILED', 'no_such_good');

    // 夏季：2026-07-20 14:00 JST
    const summerAt = Date.UTC(2026, 6, 20, 5, 0, 0);
    const ts = makeCity({ at: summerAt });
    const bs = ts.bot('夏午旅人', { entry: 'ikebukuro:station' });
    const sSkus = (bs.view().here as any).goods.map((g: any) => g.sku);
    expect(sSkus).toContain('salted_lychee');
    expect(sSkus).not.toContain('hot_corn_soup');
    expect(sSkus).not.toContain('hot_red_bean_soup');
    expect(bs.act({ type: 'buy', sku: 'salted_lychee', qty: 1 }).paid_yen).toBe(160);
    expect(bs.act({ type: 'consume', item: 'salted_lychee', qty: 1 }).consumed.type).toBe('salted_lychee');
    rejects(() => bs.act({ type: 'buy', sku: 'hot_corn_soup', qty: 1 }), 'PRECONDITION_FAILED', 'no_such_good');

    // 春秋季：2026-05-10 12:00 JST
    const springAt = Date.UTC(2026, 4, 10, 3, 0, 0);
    const tp = makeCity({ at: springAt });
    const bp = tp.bot('五月旅人', { entry: 'shinjuku:station' });
    const pSkus = (bp.view().here as any).goods.map((g: any) => g.sku);
    expect(pSkus).toEqual(['green_tea', 'roasted_tea']);
  });

  it('三区 24h 便利店补齐：凌晨 02:30 可购 ¥550 透明伞与夜间歇脚简餐', () => {
    // 2026-11-18 02:30 JST
    const lateNight = Date.UTC(2026, 10, 17, 17, 30, 0);
    const t = makeCity({ at: lateNight });
    const b = t.bot('深夜旅人', { entry: 'ikebukuro:station' });

    for (const store of ['ikebukuro:ekimae-conbini', 'shinjuku:south-conbini', 'akabane:ekimae-conbini']) {
      b.act({ type: 'travel', to: store });
      t.run(30 * MIN);
      const goods = (b.view().here as any).goods;
      expect(goods.find((g: any) => g.sku === 'umbrella').price_yen).toBe(550);
      expect(goods.find((g: any) => g.sku === 'egg_sandwich').price_yen).toBe(290);
      expect(goods.find((g: any) => g.sku === 'oden_cup').price_yen).toBe(360);
    }
    expect(b.act({ type: 'buy', sku: 'umbrella', qty: 1 }).paid_yen).toBe(550);
    expect(b.act({ type: 'buy', sku: 'oden_cup', qty: 1 }).paid_yen).toBe(360);
    expect(b.act({ type: 'consume', item: 'oden_cup', qty: 1 }).consumed.type).toBe('oden_cup');
  });
});

describe('东京 M3-C：漂流文库本扉页流转与 4KB / 防注入硬护栏', () => {
  it('read_item 升级 instance=1 后，经「栞堂」二手架与车站漂流角多次流转，全程保持同一 item_id', () => {
    const t = makeCity({ at: T0 });
    const a = t.bot('甲', { entry: 'ikebukuro:station' });
    const b = t.bot('乙', { entry: 'ikebukuro:station' });
    const nia = t.kernel('nia');

    a.go('ikebukuro:shiorido');
    a.act({ type: 'buy', sku: 'paperback', qty: 2 });

    // 未批注的 instance=0 文库本禁止直接上架/漂流
    rejects(() => a.act({ type: 'drift_book', item: 'paperback' }), 'PRECONDITION_FAILED', 'not_annotated');

    // 甲阅读第一本并写扉页批注，堆叠 2 -> 1 并拆出 instance=1
    const read1 = a.act({ type: 'read_item', item: 'paperback', title: '东京散步手记', note: '雨前在池袋翻开第一章' });
    const bookId = read1.item.item_id as string;
    expect(read1.item.instance).toBe(true);
    expect(read1.item.flyleaf_count).toBe(1);
    expect(a.view().items.find((i: any) => i.item_id === bookId).qty).toBe(1);
    expect(a.view().items.find((i: any) => i.instance === false && i.type === 'paperback').qty).toBe(1);

    // 卖入书店「栞堂」古书二手架（+¥300）
    const beforeSell = a.view().wallet.yen;
    const sold = a.act({ type: 'drift_book', item_id: bookId, note: '留给下一位读到这里的人' });
    expect(sold.mode).toBe('shelf');
    expect(sold.received_yen).toBe(300);
    expect(a.view().wallet.yen).toBe(beforeSell + 300);

    // 乙来「栞堂」查看书架并用 take_book 买走同一本 item_id
    b.go('ikebukuro:shiorido');
    const shelfBooks = (b.view().here as any).books;
    expect(shelfBooks).toEqual([expect.objectContaining({ item_id: bookId, title: '东京散步手记', price_yen: 350, flyleaf_count: 2 })]);
    // 书架列表绝不展开历任长批注
    expect(shelfBooks[0].flyleaf).toBeUndefined();

    const inspectedShelf = b.act({ type: 'inspect_item', item_id: bookId });
    expect(inspectedShelf.item.meta.flyleaf).toHaveLength(2);
    expect(inspectedShelf.item.meta.flyleaf[0]).toMatchObject({ note: '雨前在池袋翻开第一章', untrusted: true });

    const beforeBuy = b.view().wallet.yen;
    const picked = b.act({ type: 'take_book', item_id: bookId });
    expect(picked.item.item_id).toBe(bookId);
    expect(picked.paid_yen).toBe(350);
    expect(b.view().wallet.yen).toBe(beforeBuy - 350);

    // 乙到赤羽站投入车站图书漂流角，小屋室友妮娅到赤羽站免费淘走同一本 item_id
    b.go('akabane:station');
    const drifted = b.act({ type: 'drift_book', item_id: bookId, note: '放在赤羽站漂流角' });
    expect(drifted.mode).toBe('drift');

    nia.depart({ yen: 5000, items: [], to: 'akabane:station' });
    t.run(20 * MIN);
    const driftCorner = (nia.view().here as any).books;
    expect(driftCorner.map((x: any) => x.item_id)).toContain(bookId);
    const niaPicked = nia.act({ type: 'take_book', item_id: bookId });
    expect((niaPicked.payload as any).item.item_id).toBe(bookId);
    expect(runReconcile(t.c, 'drift-book').ok).toBe(true);
  });

  it('防膨胀与防注入硬护栏：最多保留最近 5 条 <=50 字批注且标 untrusted，selfView <= 4KB', () => {
    const t = makeCity({ at: T0 });
    const a = t.bot('多产读者', { entry: 'ikebukuro:station' });
    const b = t.bot('窥视者', { entry: 'ikebukuro:station' });
    a.go('ikebukuro:shiorido');
    a.act({ type: 'buy', sku: 'paperback', qty: 6 });

    // 超 50 字批注被拒绝
    rejects(() => a.act({ type: 'read_item', item: 'paperback', note: '字'.repeat(51) }), 'BAD_REQUEST', 'text_too_long');

    // 连续写 5 本满长度（每本 7 轮批注，含控制字符），每本最终仅保留最近 5 条、每条 <= 50 字
    const bookIds: string[] = [];
    for (let k = 0; k < 5; k++) {
      const r0 = a.act({ type: 'read_item', item: 'paperback', title: `漂流集第${k + 1}册`, note: `${'墨'.repeat(45)}1` });
      const id = r0.item.item_id as string;
      bookIds.push(id);
      for (let round = 2; round <= 7; round++) {
        a.act({ type: 'read_item', item_id: id, note: `\x00第${round}次${'风'.repeat(42)}` });
      }
    }

    // 窥视者不能 inspect 他人私密背包中的书
    rejects(() => b.act({ type: 'inspect_item', item_id: bookIds[0]! }), 'NOT_FOUND', 'no_such_item');

    // inspect_item 验证：只留最近 5 条（第 3..7 次），清洗掉 \x00，强制 untrusted: true
    const detail = a.act({ type: 'inspect_item', item_id: bookIds[0]! }).item;
    expect(detail.meta.untrusted).toBe(true);
    expect(detail.meta.flyleaf).toHaveLength(5);
    expect(detail.meta.flyleaf[0].note.startsWith('第3次')).toBe(true);
    expect(detail.meta.flyleaf[4].note.startsWith('第7次')).toBe(true);
    expect(detail.meta.flyleaf[4].note).not.toContain('\x00');
    expect(detail.meta.flyleaf.every((e: any) => e.untrusted === true && [...e.note].length <= 50)).toBe(true);

    // 把 1 本放上书架 + 带着其余 4 本去橱窗最满的「铃兰衣橱」校验 selfView <= 4KB
    a.act({ type: 'drift_book', item_id: bookIds[4]! });
    a.go('ikebukuro:suzuran-closet');
    const view = a.view();
    const rawJson = JSON.stringify(view);
    expect(Buffer.byteLength(rawJson, 'utf8')).toBeLessThanOrEqual(4096);
    // 常规背包视图绝不展开历任批注内容
    expect(rawJson).not.toContain('墨墨墨');
    expect(rawJson).not.toContain('风风风');
    expect(view.items.find((i: any) => i.item_id === bookIds[0]!).meta.flyleaf).toBeUndefined();
    expect(view.items.find((i: any) => i.item_id === bookIds[0]!).meta.flyleaf_count).toBe(5);
  });

  it('R264-P2-02：买入并阅读 9+ 本文库本及 20 本存柜时在书店与铃兰衣橱均守住 selfView <= 4096 B，且超出首屏物品可翻页与单件查看', () => {
    const t = makeCity({ at: T0 });
    const nia = t.kernel('nia');
    const niaResidentId = t.residentOf('nia');
    const passerby1 = t.bot('逛街旅人甲', { entry: 'ikebukuro:station' });
    const passerby2 = t.bot('逛街旅人乙', { entry: 'ikebukuro:station' });
    passerby1.act({ type: 'update_profile', bio: '喜欢在雨天逛池袋的旧书店与服装橱窗。' });
    passerby2.act({ type: 'update_profile', bio: '周末常来铃兰衣橱挑应季外套。' });
    passerby1.go('ikebukuro:suzuran-closet');
    passerby2.go('ikebukuro:suzuran-closet');
    passerby1.act({ type: 'say', text: '今天橱窗里的冬装配色真好看。' });

    nia.depart({ yen: 30_000, items: [], to: 'ikebukuro:shiorido' });
    t.run(40 * MIN);

    // 正常买入 9 本文库本并全部阅读写短标题与短批注
    nia.act({ type: 'buy', sku: 'paperback', qty: 9 });
    const readIds: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const res = (
        nia.act({
          type: 'read_item',
          item: 'paperback',
          title: `铁道随笔第${i}卷`,
          note: `在池袋翻完第${i}卷，窗外正飘着细雨。`,
        }).payload as any
      ).item;
      readIds.push(res.item_id);
    }

    // 1) 9 本已读文库本在书店视图 <= 4096 B
    const shopView9 = nia.view();
    expect(Buffer.byteLength(JSON.stringify(shopView9), 'utf8')).toBeLessThanOrEqual(4096);

    // 2) 带着 9 本已读文库本逛橱窗最满的「铃兰衣橱」视图 <= 4096 B
    nia.act({ type: 'travel', to: 'ikebukuro:suzuran-closet' });
    t.run(10 * MIN);
    const closetView9 = nia.view();
    expect(Buffer.byteLength(JSON.stringify(closetView9), 'utf8')).toBeLessThanOrEqual(4096);

    // 3) 校验首屏 + 分页/单件可无损查齐全部 9 本书
    const collected: string[] = [...closetView9.items.map((x: any) => x.item_id)];
    expect(closetView9.items.length).toBeGreaterThan(0);
    if (closetView9.items_page) {
      expect(closetView9.items_page.total).toBe(9);
      expect(closetView9.items_page.shown).toBe(closetView9.items.length);
      let next = closetView9.items_page.next_offset as number | null;
      let guard = 0;
      while (next !== null && guard++ < 10) {
        const pageView = (selfView as any)(t.c, t.c.mustResident(niaResidentId), { itemOffset: next });
        expect(Buffer.byteLength(JSON.stringify(pageView), 'utf8')).toBeLessThanOrEqual(4096);
        expect(pageView.items.length).toBeGreaterThan(0);
        for (const it of pageView.items) collected.push(it.item_id);
        next = pageView.items_page?.next_offset ?? null;
      }
      // 通过 inspect_item 列表分页动作同样可查出溢出项
      const actPage = nia.act({
        type: 'inspect_item',
        scope: 'held',
        offset: closetView9.items_page.next_offset,
        limit: 10,
      }).payload as any;
      expect(Buffer.byteLength(JSON.stringify(actPage), 'utf8')).toBeLessThanOrEqual(4096);
      expect([...closetView9.items.map((x: any) => x.item_id), ...actPage.items.map((x: any) => x.item_id)].sort()).toEqual(
        [...readIds].sort(),
      );
    }
    expect([...collected].sort()).toEqual([...readIds].sort());

    // 对超出首屏的第 9 本书直接调用 inspect_item 查看完整扉页详情
    const lastId = readIds[readIds.length - 1]!;
    const lastDetail = (nia.act({ type: 'inspect_item', item_id: lastId }).payload as any).item;
    expect(lastDetail.item_id).toBe(lastId);
    expect(lastDetail.meta.title).toBe('铁道随笔第9卷');
    expect(lastDetail.meta.flyleaf[0].note).toContain('第9卷');

    // 4) 个人储物柜塞入 20 本已读文库本（+ 随身仍有多本）时，首页与 lockerOffset 翻页均 <= 4096 B
    const collector = t.bot('藏书家', { entry: 'ikebukuro:station' });
    const lockerBookIds: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      collector.go('ikebukuro:shiorido');
      const count = batch < 2 ? 8 : 4;
      collector.act({ type: 'buy', sku: 'paperback', qty: count });
      for (let j = 0; j < count; j++) {
        const idx = lockerBookIds.length + 1;
        const bItem = collector.act({
          type: 'read_item',
          item: 'paperback',
          title: `馆藏文库第${idx}册`,
          note: `第${idx}册扉页签章`,
        }).item;
        lockerBookIds.push(bItem.item_id);
      }
      collector.go('ikebukuro:station');
      for (const bid of lockerBookIds.slice(-count)) {
        collector.act({ type: 'store_locker', item_id: bid, qty: 1 });
      }
    }
    collector.go('ikebukuro:suzuran-closet');
    const cView0 = collector.view();
    expect(Buffer.byteLength(JSON.stringify(cView0), 'utf8')).toBeLessThanOrEqual(4096);
    const seenLocker: string[] = [...cView0.locker_items.map((x: any) => x.item_id)];
    let lNext: number | null = cView0.locker_page?.next_offset ?? null;
    let lGuard = 0;
    while (lNext !== null && lGuard++ < 10) {
      const lPage = (selfView as any)(t.c, t.c.mustResident(collector.id), { lockerOffset: lNext });
      expect(Buffer.byteLength(JSON.stringify(lPage), 'utf8')).toBeLessThanOrEqual(4096);
      expect(lPage.locker_items.length).toBeGreaterThan(0);
      for (const li of lPage.locker_items) seenLocker.push(li.item_id);
      lNext = lPage.locker_page?.next_offset ?? null;
    }
    expect(seenLocker.sort()).toEqual([...lockerBookIds].sort());
  });

  it('R264-P2-02b：MCP get_my_view（item_offset 与 section/page）及桥接 HTTP /visits/:id/view 均守住 4096 B 上限且可翻页查全', async () => {
    const t = makeCity({ at: T0 });
    const nia = t.kernel('nia');
    nia.depart({ yen: 25_000, items: [], to: 'ikebukuro:shiorido' });
    t.run(40 * MIN);
    nia.act({ type: 'buy', sku: 'paperback', qty: 9 });
    const niaBookIds: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const it = (nia.act({ type: 'read_item', item: 'paperback', title: `池袋夜读第${i}本`, note: `短批注第${i}条` }).payload as any).item;
      niaBookIds.push(it.item_id);
    }
    nia.act({ type: 'travel', to: 'ikebukuro:suzuran-closet' });
    t.run(10 * MIN);

    // 1) 桥接 HTTP /visits/:id/view 完整外层 JSON 严格 <= 4096 B，且可通过 item_offset 翻页取全
    const app = express();
    const bridgeKey = 'bridge-test-secret-key-0123456789';
    mountCity(app, t.c, () => {}, { bridgeKey });
    const srv: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const port = (srv.address() as AddressInfo).port;
      const headers = { Authorization: `Bearer ${bridgeKey}` };
      const r1 = await fetch(`http://127.0.0.1:${port}/city/bridge/v1/visits/${nia.visitId}/view?domain_epoch=${nia.epoch}`, { headers });
      expect(r1.status).toBe(200);
      const raw1 = await r1.text();
      expect(Buffer.byteLength(raw1, 'utf8')).toBeLessThanOrEqual(4096);
      const j1 = JSON.parse(raw1);
      const seenBridge = [...j1.items.map((x: any) => x.item_id)];
      let bNext: number | null = j1.items_page?.next_offset ?? null;
      let bGuard = 0;
      while (bNext !== null && bGuard++ < 10) {
        const r2 = await fetch(
          `http://127.0.0.1:${port}/city/bridge/v1/visits/${nia.visitId}/view?domain_epoch=${nia.epoch}&item_offset=${bNext}`,
          { headers },
        );
        expect(r2.status).toBe(200);
        const raw2 = await r2.text();
        expect(Buffer.byteLength(raw2, 'utf8')).toBeLessThanOrEqual(4096);
        const j2 = JSON.parse(raw2);
        expect(j2.items.length).toBeGreaterThan(0);
        seenBridge.push(...j2.items.map((x: any) => x.item_id));
        bNext = j2.items_page?.next_offset ?? null;
      }
      expect(seenBridge.sort()).toEqual([...niaBookIds].sort());
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }

    // 2) MCP get_my_view 首屏、item_offset 翻页与 section="items"/section="item:<id>" 只读查询全部 <= 4096 B
    const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('m3c-mcp') });
    const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents: [{ key: 'k-reader', id: '7777', name: '爱书人' }] }, manager);
    const mcpServer = createMcpServer(
      { manager, auth, version: 'test', city: { city: t.c } },
      { identity: { id: '7777', name: '爱书人' }, fixed: true, transport: 'memory' },
    );
    const [ca, cb] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'm3c-client', version: '1.0.0' });
    await mcpServer.connect(cb);
    await client.connect(ca);
    try {
      const mcpCall = async (name: string, args: Record<string, unknown> = {}) => {
        const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        expect(res.isError, res.content[0]?.text).toBeFalsy();
        const parsed = JSON.parse(res.content[0]!.text);
        expect(Buffer.byteLength(JSON.stringify(parsed), 'utf8')).toBeLessThanOrEqual(4096);
        return parsed;
      };
      await mcpCall('enter_world', { world_id: 'tokyo', name: '爱书人', entry: 'ikebukuro:station' });
      let reqSeq = 0;
      const mcpAct = (action: Record<string, unknown>) =>
        mcpCall('world_act', { request_id: `m3c-mcp-${String(++reqSeq).padStart(4, '0')}`, action });
      const tr1 = await mcpAct({ type: 'travel', to: 'ikebukuro:shiorido' });
      t.run(tr1.trip.ends_at_ms - t.clock.t);
      await mcpCall('enter_world', { world_id: 'tokyo' });
      await mcpAct({ type: 'buy', sku: 'paperback', qty: 9 });
      const botBooks: string[] = [];
      for (let i = 1; i <= 9; i++) {
        const r = await mcpAct({ type: 'read_item', item: 'paperback', title: `散步文库第${i}辑`, note: `第${i}辑随手记` });
        botBooks.push(r.item.item_id);
      }
      const tr2 = await mcpAct({ type: 'travel', to: 'ikebukuro:suzuran-closet' });
      t.run(tr2.trip.ends_at_ms - t.clock.t);
      await mcpCall('enter_world', { world_id: 'tokyo' });

      const v1 = await mcpCall('get_my_view', {});
      const mcpSeen = [...v1.items.map((x: any) => x.item_id)];
      let mNext: number | null = v1.items_page?.next_offset ?? null;
      let mGuard = 0;
      while (mNext !== null && mGuard++ < 10) {
        const v2 = await mcpCall('get_my_view', { item_offset: mNext });
        expect(v2.items.length).toBeGreaterThan(0);
        mcpSeen.push(...v2.items.map((x: any) => x.item_id));
        mNext = v2.items_page?.next_offset ?? null;
      }
      expect(mcpSeen.sort()).toEqual([...botBooks].sort());

      // 通过标准 get_my_view({ section, page }) 只读分段同样可查
      const sec1 = await mcpCall('get_my_view', { section: 'items', page: 1 });
      expect(sec1.total).toBe(9);
      const secItem = await mcpCall('get_my_view', { section: `item:${botBooks[8]!}` });
      expect(secItem.item.meta.title).toBe('散步文库第9辑');
    } finally {
      await client.close();
    }
  });
});

describe('东京 M3-C：车站投币储物柜凭条代取与 72h 超时退回防占柜', () => {
  it('支持指定 recipient_id 与一次性 voucher 凭条错峰代取，且校验同站与权限', () => {
    const t = makeCity({ at: T0 });
    const a = t.bot('早班存物人', { entry: 'ikebukuro:station' });
    const b = t.bot('夜班代取人', { entry: 'shinjuku:station' });
    const c = t.bot('无关路人', { entry: 'ikebukuro:station' });

    a.go('ikebukuro:shiorido');
    a.act({ type: 'buy', sku: 'paperback', qty: 1 });
    const bookId = a.act({ type: 'read_item', item: 'paperback', note: '托你转交的书' }).item.item_id as string;
    a.go('ikebukuro:ekimae-conbini');
    a.act({ type: 'buy', sku: 'onigiri', qty: 2 });

    // 1) 指定受托人存入池袋站投币柜
    a.go('ikebukuro:station');
    const dep1 = a.act({ type: 'store_locker', item_id: bookId, qty: 1, recipient_id: b.id }).deposit;
    expect(dep1).toMatchObject({ item_id: bookId, recipient_id: b.id, place_id: 'ikebukuro:station' });

    // 2) 一次性凭条存入饭团
    const dep2Res = a.act({ type: 'store_locker', item: 'onigiri', qty: 2, voucher: true });
    const dep2 = dep2Res.deposit;
    const voucherCode = dep2.voucher_code as string;
    expect(voucherCode).toMatch(/^clk_/);
    // selfView 绝不泄露原始凭条码
    expect(JSON.stringify(a.view())).not.toContain(voucherCode);
    expect(b.view().locker_pickups).toHaveLength(1);

    // 错站领取被拒；无关路人试图冒领指定受托柜被拒
    rejects(() => b.act({ type: 'take_locker', deposit_id: dep1.deposit_id }), 'PRECONDITION_FAILED', 'wrong_station');
    rejects(() => c.act({ type: 'take_locker', deposit_id: dep1.deposit_id }), 'FORBIDDEN', 'not_recipient');

    // B 到池袋站领取两笔（保持原 bookId + 凭条一次有效）
    b.go('ikebukuro:station');
    const claim1 = b.act({ type: 'take_locker', deposit_id: dep1.deposit_id }).retrieved;
    expect(claim1.item_id).toBe(bookId);
    const claim2 = b.act({ type: 'take_locker', voucher: voucherCode }).retrieved;
    expect(claim2).toMatchObject({ type: 'onigiri', qty: 2 });

    // 同一凭条再次领取被拒
    rejects(() => c.act({ type: 'take_locker', voucher: voucherCode }), 'NOT_FOUND', 'invalid_voucher');
    expect(b.view().items.find((i: any) => i.item_id === bookId)).toBeTruthy();
    expect(b.view().items.find((i: any) => i.type === 'onigiri' && i.qty === 2)).toBeTruthy();
  });

  it('防死号占柜硬门禁：单人占柜上限 + 72h 超时自动退回原主或转招领态释放柜位', () => {
    const t = makeCity({ at: T0, params: { maxLockerEntries: 2, maxActiveLockerDeposits: 2 } });
    const a = t.bot('囤物者', { entry: 'shinjuku:station' });
    const b = t.bot('收件人', { entry: 'shinjuku:station' });

    a.go('shinjuku:south-conbini');
    a.act({ type: 'buy', sku: 'onigiri', qty: 6 });
    a.go('shinjuku:station');

    // 占满 maxActiveLockerDeposits = 2 个公共代取柜位
    const d1 = a.act({ type: 'store_locker', item: 'onigiri', qty: 1, voucher: true }).deposit;
    const d2 = a.act({ type: 'store_locker', item: 'onigiri', qty: 1, recipient_id: b.id }).deposit;
    rejects(() => a.act({ type: 'store_locker', item: 'onigiri', qty: 1, voucher: true }), 'PRECONDITION_FAILED', 'locker_deposit_limit');

    // 推进 72 小时：两笔到期自动退回原主个人储物柜（因原主个人柜仅占 1 格 <= maxLockerEntries=2），公共柜位释放
    t.run(72 * HOUR);
    expect(a.view().locker_items.find((i: any) => i.type === 'onigiri')?.qty).toBe(2);
    expect(a.view().locker_deposits).toBeUndefined();
    // 过期凭条无法领取
    rejects(() => b.act({ type: 'take_locker', voucher: d1.voucher_code }), 'NOT_FOUND', 'invalid_voucher');
    rejects(() => b.act({ type: 'take_locker', deposit_id: d2.deposit_id }), 'PRECONDITION_FAILED', 'voucher_expired');

    // 填满原主个人柜（第 2 格放 umbrella）后，再存公共代取柜并超时 72h -> 转招领态（lost_found）释放公共柜位
    a.go('shinjuku:south-conbini');
    a.act({ type: 'buy', sku: 'umbrella', qty: 1 });
    a.act({ type: 'buy', sku: 'cookie', qty: 1 });
    a.go('shinjuku:station');
    a.act({ type: 'store_locker', item: 'umbrella', qty: 1 });
    expect(a.view().locker_items).toHaveLength(2);

    const d3 = a.act({ type: 'store_locker', item: 'cookie', qty: 1, voucher: true }).deposit;
    t.run(72 * HOUR);
    const row = t.c.db.get<{ status: string }>('SELECT status FROM locker_deposits WHERE deposit_id = ?', d3.deposit_id)!;
    expect(row.status).toBe('expired_lost_found');
    const itemRow = t.c.db.get<{ state: string }>('SELECT state FROM items WHERE item_id = ?', d3.item_id)!;
    expect(itemRow.state).toBe('lost_found');
    expect(runReconcile(t.c, 'locker-expiry').ok).toBe(true);
  });

  it('跨季 F9 售货机未决订单可按全池恢复，室友可经桥接代取凭条与人类/外部 Bot 错峰交接', () => {
    // 冬季 2026-02-10 10:00 JST
    const winterAt = Date.UTC(2026, 1, 10, 1, 0, 0);
    const t = makeCity({ at: winterAt });
    const nia = t.kernel('nia');
    const bot = t.bot('跨季旅人', { entry: 'shinjuku:station' });

    // 冬季在车站售货机下热玉米浓汤订单遇 F9 结果未知
    t.c.failpoints.purchaseUnknown = () => true;
    const pending = bot.act({ type: 'buy', sku: 'hot_corn_soup', qty: 1 });
    expect(pending.status).toBe('pending');
    t.c.failpoints.purchaseUnknown = undefined;

    // 推 120 天到 6 月夏季后人工确认成交，仍能按全池解析发货且对账全绿
    t.run(120 * 24 * HOUR);
    const res = resolvePendingOrder(t.c, String(pending.order_id), 'completed');
    expect(res.reconcile_ok).toBe(true);
    expect(bot.view().items.some((i: any) => i.type === 'hot_corn_soup')).toBe(true);

    // 室友妮娅在池袋站寄存一本已批注文库本给外部 Bot（带一次性凭条）
    nia.depart({ yen: 5000, items: [], to: 'ikebukuro:shiorido' });
    t.run(40 * MIN);
    nia.act({ type: 'buy', sku: 'paperback', qty: 1 });
    const niaBook = (nia.act({ type: 'read_item', item: 'paperback', note: '从家里出门时给你留的一本书' }).payload as any).item.item_id as string;
    nia.act({ type: 'travel', to: 'ikebukuro:station' });
    t.run(10 * MIN);
    const dep = (nia.act({ type: 'store_locker', item_id: niaBook, qty: 1, recipient_id: bot.id, voucher: true }).payload as any).deposit;
    nia.act({ type: 'go_home' });
    t.run(30 * MIN);
    expect(nia.release().state).toBe('closed');

    // 妮娅回家后，错峰的外部 Bot 去池袋站凭 voucher + 指定受托身份领取，保持同一 item_id
    bot.go('ikebukuro:station');
    const got = bot.act({ type: 'take_locker', voucher: dep.voucher_code }).retrieved;
    expect(got.item_id).toBe(niaBook);
    expect(runReconcile(t.c, 'bridge-locker').ok).toBe(true);
  });

  it('R264-P2-01：统一隔离个人与代取储物柜行——个人存柜、室友返家托管、跨关单补发与代取领取数量严格守恒', () => {
    const t = makeCity({ at: T0 });
    const a = t.bot('存物居民', { entry: 'ikebukuro:station' });
    const b = t.bot('代取居民', { entry: 'ikebukuro:station' });
    const nia = t.kernel('nia');
    const claire = t.kernel('claire');

    // 1) 个人存柜 vs 代取柜：居民留 1 份饭团代取、另 1 份存自己个人柜 -> 不同 item_id，私柜为 1，领取数量严格守恒
    a.go('ikebukuro:ekimae-conbini');
    a.act({ type: 'buy', sku: 'onigiri', qty: 2 });
    a.go('ikebukuro:station');

    const depRes = a.act({ type: 'store_locker', item: 'onigiri', qty: 1, recipient_id: b.id });
    const depItemId = depRes.deposit.item_id as string;
    const personalRes = a.act({ type: 'store_locker', item: 'onigiri', qty: 1 });
    const personalItemId = personalRes.stored.item_id as string;

    expect(personalItemId).not.toBe(depItemId);
    expect(a.view().locker_items).toEqual([expect.objectContaining({ item_id: personalItemId, type: 'onigiri', qty: 1 })]);
    expect(a.view().locker_deposits).toEqual([
      expect.objectContaining({ deposit_id: depRes.deposit.deposit_id, item_id: depItemId, type: 'onigiri', qty: 1 }),
    ]);
    expect(runReconcile(t.c, 'after-personal-and-deposit').ok).toBe(true);

    const claimed = b.act({ type: 'take_locker', deposit_id: depRes.deposit.deposit_id }).retrieved;
    expect(claimed.qty).toBe(1);
    expect(b.view().items.find((i: any) => i.type === 'onigiri')?.qty).toBe(1);
    expect(a.view().locker_items).toEqual([expect.objectContaining({ item_id: personalItemId, type: 'onigiri', qty: 1 })]);
    const takenOwn = a.act({ type: 'take_locker', item: 'onigiri', qty: 1 }).retrieved;
    expect(takenOwn.qty).toBe(1);
    expect(a.view().locker_items).toEqual([]);

    // 2) 室友返家托管（零个人底仓子场景）：买 2 份未映射鸡蛋三明治（egg_sandwich），1 份代取、1 份随身返家 releaseVisit -> moveItemToLocker 绝不混入代取行
    nia.depart({ yen: 5000, items: [], to: 'ikebukuro:ekimae-conbini' });
    t.run(40 * MIN);
    nia.act({ type: 'buy', sku: 'egg_sandwich', qty: 2 });
    nia.act({ type: 'travel', to: 'ikebukuro:station' });
    t.run(10 * MIN);
    const niaDep = (nia.act({ type: 'store_locker', item: 'egg_sandwich', qty: 1, recipient_id: b.id, voucher: true }).payload as any).deposit;
    nia.act({ type: 'go_home' });
    t.run(30 * MIN);
    expect(nia.release().state).toBe('closed');
    expect(runReconcile(t.c, 'after-nia-home-custody').ok).toBe(true);

    const bGotNia = b.act({ type: 'take_locker', voucher: niaDep.voucher_code }).retrieved;
    expect(bGotNia.qty).toBe(1);
    expect(b.view().items.find((i: any) => i.type === 'egg_sandwich')?.qty).toBe(1);

    nia.depart({ yen: 3000, items: [], to: 'ikebukuro:station' });
    t.run(30 * MIN);
    expect(nia.view().locker_items).toEqual([expect.objectContaining({ type: 'egg_sandwich', qty: 1 })]);
    nia.act({ type: 'go_home' });
    t.run(30 * MIN);
    expect(nia.release().state).toBe('closed');

    // 3) 室友返家托管（有个人底仓 + 跨关单 F9 补发 addPlainToLocker 子场景）：买未映射透明伞（umbrella）1 代取 + 1 私柜 + 1 随身返家 + 1 关单后补发 = 1 代取 + 3 私柜
    claire.depart({ yen: 5000, items: [], to: 'ikebukuro:ekimae-conbini' });
    t.run(40 * MIN);
    claire.act({ type: 'buy', sku: 'umbrella', qty: 3 });
    t.c.failpoints.purchaseUnknown = () => true;
    const pendingOrd = (claire.act({ type: 'buy', sku: 'umbrella', qty: 1 }).payload as any).order_id as string;
    t.c.failpoints.purchaseUnknown = undefined;
    claire.act({ type: 'travel', to: 'ikebukuro:station' });
    t.run(10 * MIN);

    const claireDep = (claire.act({ type: 'store_locker', item: 'umbrella', qty: 1, voucher: true }).payload as any).deposit;
    const clairePersonal = (claire.act({ type: 'store_locker', item: 'umbrella', qty: 1 }).payload as any).stored;
    expect(clairePersonal.item_id).not.toBe(claireDep.item_id);

    claire.act({ type: 'go_home' });
    t.run(30 * MIN);
    expect(claire.release().state).toBe('reconcile');
    const resolved = resolvePendingOrder(t.c, pendingOrd, 'completed');
    expect(resolved.reconcile_ok).toBe(true);

    const bGotClaire = b.act({ type: 'take_locker', voucher: claireDep.voucher_code }).retrieved;
    expect(bGotClaire.qty).toBe(1);
    expect(b.view().items.find((i: any) => i.type === 'umbrella')?.qty).toBe(1);

    claire.depart({ yen: 3000, items: [], to: 'ikebukuro:station' });
    t.run(30 * MIN);
    expect(claire.view().locker_items).toEqual([expect.objectContaining({ item_id: clairePersonal.item_id, type: 'umbrella', qty: 3 })]);
    expect(runReconcile(t.c, 'locker-isolation-full').ok).toBe(true);
  });
});
