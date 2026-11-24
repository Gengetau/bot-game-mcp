/**
 * 晴空都 M3-D（#265）× R0 暂卸内容包与三站契约回归测试：
 *  1. R0 内容包暂卸隔离（MOUNTED_CONTENT_PACKS === []，暂卸包零出现在目录/路由/印章/公开视图）与
 *     架空 CityContentPack 规范（ward:<slug> + 内部 prototype）自检；
 *  2. 车站印章帐（Eki-Stamp）：三站唯一印章、同站重复盖章幂等、非车站 422 拒绝、零占背包/储物柜槽位、按需查询明细；
 *  3. 高压满载下的 selfView <= 4 KB（4096 UTF-8 字节）与 here.exits <= 24 守门（含带 cursor 合并事件零跳漏）；
 *  4. 人类网页端 /city/play/ 车门液晶牌、微缩天气×昼夜窗景、三站呼吸拓扑、动效暂停按钮、CSP 安全及严格信息对等。
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import {
  AREAS,
  CITY_CATALOG_VERSION,
  MOUNTED_CONTENT_PACKS,
  SELF_VIEW_MAX_BYTES,
  STATION_STAMPS,
  TRANSIT_EDGES,
  WARDS,
  applyWeather,
  homeward,
  ledgerImbalance,
  place,
  planRoute,
  publicCityView,
  runReconcile,
  stampBookView,
  validateCatalog,
  validateContentPack,
  type CityContentPack,
  type WeatherReading,
} from '../../src/city/index.js';
import { HOUR, MIN, T0, makeCity } from './helpers.js';
import { createIsolatedCityHarness } from './test-harness.js';

const CITY_WEB_DIR = new URL('../../city/', import.meta.url);

const SYNTHETIC_FICTIONAL_PACK: CityContentPack = {
  packId: 'pack:tsukimori',
  version: '1.0.0',
  specVersion: 1,
  ward: { id: 'ward:seibu', name: '西灯区', source: 'fictional' },
  district: {
    id: 'dist:kumominato-west',
    areaId: 'kumominato',
    name: '云港西庭',
    wardId: 'ward:seibu',
    openness: 'livable',
    hubStationId: 'st:tsukimori',
    weatherPoint: { lat: 35.661, lon: 139.668 },
    blurb: '晴空都西侧绿荫步道与旧书廊构成的安静街区。',
  },
  prototype: {
    weatherPoint: { lat: 35.661, lon: 139.668 },
    distanceRef: 'synthetic-test-pack',
  },
  stations: [
    {
      id: 'st:tsukimori',
      name: '月森站',
      area: 'kumominato',
      placeId: 'kumominato:tsukimori-station',
      stops: [{ id: 'st:tsukimori:seibu', line: '西庭支线', operator: '晴空都铁道' }],
    },
  ],
  transitEdges: [
    {
      id: 'te:kumominato-tsukimori',
      a: 'st:kumominato',
      b: 'st:tsukimori',
      line: '西庭支线',
      operator: 'toto-rail',
      transportKind: 'rail',
      distanceKm: 4.5,
      minutes: 9,
      fareYen: 180,
      hours: { first: '05:00', last: '00:20' },
      sources: ['prototype-network', 'sim-fares', 'sim-times', 'sim-hours'],
    },
  ],
  neighborhoods: [{ id: 'kumominato:tsukimori', area: 'kumominato', name: '月森绿道' }],
  places: [
    {
      id: 'kumominato:tsukimori-station',
      name: '月森站',
      area: 'kumominato',
      neighborhood: 'kumominato:tsukimori',
      station: 'st:tsukimori',
      walkMinutes: 0,
      type: 'station',
      indoor: true,
      capacity: 220,
      hours: null,
      rain: 'none',
      fictional: false,
      source: 'prototype-network',
      blurb: '西庭支线的木造顶棚小站。',
      goods: [],
      actions: ['say', 'travel', 'consume', 'give'],
    },
  ],
  stamps: [
    {
      stampId: 'stamp:tsukimori',
      stationId: 'st:tsukimori',
      placeId: 'kumominato:tsukimori-station',
      title: '月森站 · 绿道木叶与拱门',
      motif: '绿道木叶与小站木棚',
      inkColor: '#1f5e3b',
      emblem: 'stage',
    },
  ],
  sources: [
    {
      id: 'fictional-tsukimori',
      kind: 'fictional',
      title: '测试用架空街区设定',
      license: '仓库自拟',
      retrieved: '2026-11-19',
      note: '仅用于单测校验 validateContentPack 架空契约。',
    },
  ],
};

describe('M3-D 标准 ContentPack：R0 暂卸隔离与架空契约校验 (#265 / #277)', () => {
  it('R0 MOUNTED_CONTENT_PACKS 为空且目录自检零错误，合成架空 ContentPack 正反例校验生效并落库 catalog_versions', () => {
    expect(CITY_CATALOG_VERSION).toBe('toto-p3.1');
    expect(MOUNTED_CONTENT_PACKS).toEqual([]);
    expect(WARDS).toEqual([]);
    expect(AREAS.map((a) => a.id)).toEqual(['hiyorizaka', 'ryokogai', 'kumominato']);
    expect(validateCatalog()).toEqual([]);

    // 暂卸内容包地点与路由完全不可见
    for (const deferredId of ['jinbocho:station', 'jinbocho:koushodou', 'shimokitazawa:station', 'shimokitazawa:kissa-yorufune']) {
      expect(place(deferredId)).toBeUndefined();
      expect(planRoute('kumominato:station', deferredId)).toBeNull();
    }

    // 架空 ContentPack 规范校验：合法架空包零错误，塞入旧 mun:13xxx 或越权 hidden 地点报错
    expect(validateContentPack(SYNTHETIC_FICTIONAL_PACK)).toEqual([]);
    expect(
      validateContentPack({
        ...SYNTHETIC_FICTIONAL_PACK,
        ward: { id: 'mun:13101', name: '旧编码', source: 'fictional' },
      }).length,
    ).toBeGreaterThan(0);

    const t = makeCity();
    const verRow = t.c.db.get<{ catalog_version: string; fare_rule_version: string; summary_json: string }>(
      'SELECT catalog_version, fare_rule_version, summary_json FROM catalog_versions WHERE catalog_version = ?',
      'toto-p3.1',
    );
    expect(verRow).toBeDefined();
    expect(JSON.parse(verRow!.summary_json)).toMatchObject({
      stations: 3,
      places: 18,
      stamps: 3,
    });
  });

  it('三片区换乘距离、模拟票价、回程预留与雨天开闭规则全部确定性成立', () => {
    const rHokkan = planRoute('hiyorizaka:station', 'ryokogai:station')!;
    expect(rHokkan).toMatchObject({ minutes: 13, fareYen: 200 });
    expect(rHokkan.legs[0]).toMatchObject({ mode: 'train', line: '北环快线' });
    expect(TRANSIT_EDGES.every((e) => e.operator === 'toto-rail')).toBe(true);

    const rSeikan = planRoute('ryokogai:station', 'kumominato:station')!;
    expect(rSeikan).toMatchObject({ minutes: 10, fareYen: 200 });
    expect(rSeikan.legs[0]).toMatchObject({ mode: 'train', line: '晴环线' });

    expect(homeward('ryokogai:shiorido')).toEqual({ minutes: 30, fareYen: 200 });
    expect(homeward('kumominato:kamitsuki')).toEqual({ minutes: 37, fareYen: 260 });

    // 真雨天气下：三片街区同步实时降水，云港露台步道保持开放并给出淋雨提示，日和坂浮光川河岸按 rain 关闭
    const t = makeCity({ at: Date.UTC(2026, 10, 17, 3, 0, 0) }); // 12:00 JST
    const rainyReadings: WeatherReading[] = AREAS.map((a) => ({
      area: a.id,
      observed_at_ms: t.clock.t,
      code: 61,
      temp_c: 13.2,
      precip_mm: 2.8,
      hourly: [{ at_ms: t.clock.t, code: 61, temp_c: 13.2, precip_mm: 2.8 }],
    }));
    t.c.commit(() => applyWeather(t.c, rainyReadings, t.clock.t));

    const pub = publicCityView(t.c) as any;
    expect(pub.areas).toHaveLength(3);
    const stArea = pub.areas.find((a: any) => a.id === 'kumominato');
    const hwArea = pub.areas.find((a: any) => a.id === 'hiyorizaka');
    expect(stArea.places.find((p: any) => p.id === 'kumominato:southern-terrace').open).toBe(true);
    expect(hwArea.places.find((p: any) => p.id === 'hiyorizaka:fukogawa-riverbank')).toMatchObject({
      open: false,
      closed_reason: 'rain',
    });
    const walker = t.bot('雨中旅人', { entry: 'kumominato:station' });
    walker.go('kumominato:southern-terrace');
    expect((walker.view().here as any).place.rain_notice).toContain('下雨');
  });

  it('零改 ledger/visits 下，室友赴棱光街喫茶饮咖、逛书店并盖站章，返家结算与复式账本零误差', () => {
    const t = makeCity({ at: Date.UTC(2026, 10, 17, 3, 0, 0) }); // 12:00 JST
    const nia = t.kernel('nia');

    nia.depart({ yen: 15_000, items: [], to: 'ryokogai:kissa-tomoshibi' });
    t.run(35 * MIN);

    expect((nia.view().location as any).place).toBe('ryokogai:kissa-tomoshibi');
    // 买两杯现点热咖啡：喝掉 1 杯，剩 1 杯验证返家按 carry_home=false 自动归 disposed
    nia.act({ type: 'buy', sku: 'coffee', qty: 2 });
    nia.act({ type: 'consume', item: 'coffee', qty: 1 });

    // 步行去栞堂买一本文库本并写批注，再去棱光街站大厅盖纪念章后回家
    nia.act({ type: 'travel', to: 'ryokogai:shiorido' });
    t.run(15 * MIN);
    nia.act({ type: 'buy', sku: 'paperback', qty: 1 });
    nia.act({ type: 'read_item', item: 'paperback', title: '棱光街旧书手记', note: '午后在书架旁读完序章' });

    nia.act({ type: 'travel', to: 'ryokogai:station' });
    t.run(10 * MIN);
    const stampRes = nia.act({ type: 'stamp_station' });
    expect(stampRes.payload).toMatchObject({
      status: 'completed',
      newly_stamped: true,
      stamp: { stamp_id: 'stamp:ryokogai', station_id: 'st:ryokogai' },
      stamp_book: { collected: 1, total: 3, here_stamped: true },
    });

    nia.act({ type: 'go_home' });
    t.run(45 * MIN);
    nia.pull();
    const settled = nia.settlement!;
    expect(settled).not.toBeNull();
    expect(settled.items.some((i) => i.type === 'paperback' && i.fate === 'locker')).toBe(true);
    expect(settled.items.some((i) => i.type === 'coffee' && i.fate === 'consumed')).toBe(true);
    expect(settled.items.some((i) => i.type === 'coffee' && i.fate === 'disposed')).toBe(true);

    expect(nia.release().state).toBe('closed');
    expect(ledgerImbalance(t.c)).toBe(0);
    expect(runReconcile(t.c, 'm3d-visit').ok).toBe(true);
  });
});

describe('车站印章帐（Eki-Stamp）幂等、零占包与按需查询 (#265)', () => {
  it('巡游三站集齐 3 枚唯一印章，同站重复盖章幂等保留首次时间戳且绝不占随身背包或储物柜', () => {
    expect(STATION_STAMPS).toHaveLength(3);
    expect(new Set(STATION_STAMPS.map((s) => s.stampId)).size).toBe(3);

    const t = makeCity({ at: T0 });
    const traveler = t.bot('集章旅人', { entry: 'kumominato:station', stay: true });

    // 先把随身背包买满 12 件手账本，证明满包状态下依然可以在全部车站自由盖章，零占槽位
    traveler.go('kumominato:kamitsuki');
    for (let i = 0; i < 12; i++) traveler.act({ type: 'buy', sku: 'notebook', qty: 1 });
    expect((traveler.view().items as any[]).reduce((n, x) => n + x.qty, 0)).toBe(12);

    // 在非车站店铺尝试盖章：明确返回 PRECONDITION_FAILED (not_at_stamp_desk)
    expect(() => traveler.act({ type: 'stamp_station' })).toThrowError(/印章台/);

    // 首站：云港站盖章，并测试 20 分钟后新 request_id 同站重复盖章幂等
    traveler.go('kumominato:station');
    const firstStamp = traveler.act({ type: 'stamp_station' });
    const firstAt = (firstStamp.stamp as any).stamped_at_ms as number;
    expect(firstStamp).toMatchObject({
      newly_stamped: true,
      stamp_book: { collected: 1, total: 3, here_stamped: true },
    });

    t.run(20 * MIN);
    const repeatStamp = traveler.act({ type: 'stamp_station' });
    expect(repeatStamp).toMatchObject({
      newly_stamped: false,
      stamp: { stamp_id: 'stamp:kumominato', stamped_at_ms: firstAt },
      stamp_book: { collected: 1, total: 3, here_stamped: true },
    });

    // 继续巡游棱光街与日和坂两站
    for (const stPlace of ['ryokogai:station', 'hiyorizaka:station']) {
      traveler.go(stPlace);
      const out = traveler.act({ type: 'stamp_station' });
      expect(out.newly_stamped).toBe(true);
    }

    const v = traveler.view();
    expect(v.stamp_book).toEqual({ collected: 3, total: 3, here_stamped: true });
    expect((v.items as any[]).length).toBe(1);
    expect((v.locker_items as any[]).length).toBe(0);

    const detail = stampBookView(t.c, traveler.id);
    expect(detail.collected).toBe(3);
    expect(detail.total).toBe(3);
    expect(detail.stamps.every((s) => s.collected && typeof s.stamped_at_ms === 'number')).toBe(true);
    expect(detail.stamps.find((s) => s.station_id === 'st:kumominato')!.stamped_at_ms).toBe(firstAt);
  });
});

describe('三片街区高压满载 selfView <= 4 KB 与网页端 /city/play/ 契约验证 (#265 / #277)', () => {
  it('高压满载（站章 + 12 具名背包件 + 12 储物柜件 + 同场人群 + 长聊天 + 待读事件）下 selfView 与 get_my_view 严守 <= 4096 B 且游标不漏事件', async () => {
    const h = await createIsolatedCityHarness();
    try {
      const auth = new Authenticator(
        { mode: 'keys', adminKeys: [], agents: [{ key: 'k-m3d', id: '7901', name: '满载测算员' }] },
        h.manager ?? new GameManager({ registry: createRegistry(), rng: new SeededRng('m3d') }),
      );
      const srv = createMcpServer(
        { manager: h.manager, auth, version: 'test', city: { city: h.city } },
        { identity: { id: '7901', name: '满载测算员' }, fixed: true, transport: 'memory' },
      );
      const [cliSide, srvSide] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: 'm3d-budget-test', version: '1.0.0' });
      await srv.connect(srvSide);
      await mcp.connect(cliSide);

      const callJson = async (name: string, args: Record<string, unknown>) => {
        const res = await mcp.callTool({ name, arguments: args });
        const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
        expect(res.isError, `${name} 报错: ${text}`).toBeFalsy();
        return { rawText: text, bytes: Buffer.byteLength(text, 'utf8'), data: JSON.parse(text) };
      };

      h.advance(35 * MIN); // 10:35 JST，书店「栞堂」营业中
      const entered = await callJson('enter_world', {
        world_id: 'city',
        name: '满载测算员',
        bio: '在三片街区满载旧书与明信片验证四千字节契约上限的旅人',
        entry: 'kumominato:station',
        client_id: 'm3d_budget_cli',
      });
      let ctxVer = entered.data.context.version as number;
      let reqSeq = 0;
      const act = async (action: Record<string, unknown>) => {
        reqSeq += 1;
        const r = await callJson('world_act', {
          request_id: `m3d_req_${String(reqSeq).padStart(4, '0')}`,
          action_window: 'city',
          context_version: ctxVer,
          action,
        });
        return r.data;
      };
      const advanceOnline = async (totalMin: number) => {
        for (let m = 0; m < totalMin; m += 2) {
          h.advance(Math.min(2, totalMin - m) * MIN);
          await callJson('heartbeat', {});
        }
      };

      // 先在云港站盖章，再去棱光街栞堂买 12 本具名批注文库本存入棱光街站储物柜，再买 12 本随身携带
      await act({ type: 'stamp_station' });
      await act({ type: 'travel', to: 'ryokogai:shiorido' });
      await advanceOnline(20);
      const firstShopView = await callJson('get_my_view', {});
      ctxVer = firstShopView.data.context.version;
      expect(firstShopView.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      expect(firstShopView.data.here.exits.map((e: any) => e.id)).toEqual(
        expect.arrayContaining(['ryokogai:station', 'kumominato:station', 'hiyorizaka:station']),
      );

      const lockerBookIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        await act({ type: 'buy', sku: 'paperback', qty: 1 });
        const rd = await act({ type: 'read_item', item: 'paperback', title: `柜藏旧书第${i + 1}册`, note: `扉页短笺${i + 1}` });
        lockerBookIds.push(String(rd.item.item_id));
      }
      await act({ type: 'travel', to: 'ryokogai:station' });
      await advanceOnline(10);
      let viewCall = await callJson('get_my_view', {});
      ctxVer = viewCall.data.context.version;
      await act({ type: 'stamp_station' });
      for (const itemId of lockerBookIds) {
        await act({ type: 'store_locker', item_id: itemId, qty: 1 });
      }

      await act({ type: 'travel', to: 'ryokogai:shiorido' });
      await advanceOnline(65);
      const normalView = await callJson('get_my_view', {});
      ctxVer = normalView.data.context.version;
      expect(normalView.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      for (let i = 0; i < 12; i++) {
        await act({ type: 'buy', sku: 'paperback', qty: 1 });
        await act({ type: 'read_item', item: 'paperback', title: `随身旧书第${i + 1}册`, note: `随身批注${i + 1}` });
      }

      // 同场加入 5 位带长简介的外部旅人并刷满 10 条 260 字长对话，制造高压现场视图与未读事件队列
      const baseCursor = (await callJson('get_my_view', {})).data.cursor as string;
      for (let p = 1; p <= 5; p++) {
        const pr = h.city.commit(() => {
          const principalId = `pri_stress_${p}`;
          h.city.db.run(
            "INSERT INTO principals(principal_id, provider, subject, kind, display_name, created_at) VALUES (?,'open',?,'agent',?,?)",
            principalId,
            `stress_${p}`,
            `书客${p}号`,
            h.city.now(),
          );
          const resId = `res_stress_${p}`;
          h.city.db.run(
            "INSERT INTO residents(resident_id, principal_id, name, bio, origin, in_city, place_id, present_until, created_at, last_seen_at) VALUES (?,?,?,?,'external',1,'ryokogai:shiorido',?,?,?)",
            resId,
            principalId,
            `棱光街书客${p}`,
            '常年在棱光街书街搜集近代文学初版本与手冲咖啡食评的独立读书人，遇到好书会写长笔记。',
            h.city.now() + HOUR,
            h.city.now(),
            h.city.now(),
          );
          return resId;
        });
        for (let m = 0; m < 2; m++) {
          citySayForStress(h, pr, `第${p}-${m}条书评：` + '在棱光街栞堂翻到了装帧考究的旧诗集与铁道地图册，纸页间还夹着当年的木纹书签。'.repeat(5));
        }
      }

      // 1) 极端满载下不带 cursor 的 get_my_view 依然严格 <= 4096 B，且保底保留本街区枢纽站出口
      const vPlain = await callJson('get_my_view', {});
      expect(vPlain.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      expect(vPlain.data.here.exits.length).toBeLessThanOrEqual(24);
      const exitIds = vPlain.data.here.exits.map((e: any) => e.id);
      expect(exitIds).toContain('ryokogai:station');
      expect(vPlain.data.stamp_book).toEqual({ collected: 2, total: 3 });

      // 2) 带旧 cursor 的 get_my_view 合并 new_events 时同样 <= 4096 B，且分页读取完整找回全部 10 条 chat 事件零跳漏
      const seenChatMsgs = new Set<number>();
      let cur = baseCursor;
      for (let guard = 0; guard < 20; guard++) {
        const page = await callJson('get_my_view', { cursor: cur });
        expect(page.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        for (const ev of page.data.new_events ?? []) {
          if (ev.type === 'chat' && typeof ev.message_id === 'number') seenChatMsgs.add(ev.message_id);
        }
        cur = page.data.cursor;
        if (!page.data.more) break;
      }
      expect(seenChatMsgs.size).toBe(10);

      // 3) world_query(what="stamps") 返回完整三站印章明细
      const stampsQuery = await callJson('world_query', { world_id: 'city', what: 'stamps' });
      expect(stampsQuery.data).toMatchObject({ collected: 2, total: 3 });
      expect(stampsQuery.data.stamps).toHaveLength(3);

      await mcp.close();
    } finally {
      await h.close();
    }
  });

  it('R265-01 & R265-02 回归：双会话在云港流光工坊满载 12 件独立服饰背包 + 12 件柜件 + 80 字简介 + 300 字聊天时严守 <= 4096 B，且分段/offset 完整枚举 12/12', async () => {
    const h = await createIsolatedCityHarness();
    try {
      const auth = new Authenticator(
        {
          mode: 'keys',
          adminKeys: [],
          agents: [
            { key: 'k-r265-a', id: '7911', name: '成衣藏家甲' },
            { key: 'k-r265-b', id: '7912', name: '同行买手乙' },
          ],
        },
        h.manager ?? new GameManager({ registry: createRegistry(), rng: new SeededRng('r265') }),
      );
      const connectSession = async (id: string, name: string) => {
        const srv = createMcpServer(
          { manager: h.manager, auth, version: 'test', city: { city: h.city } },
          { identity: { id, name }, fixed: true, transport: 'memory' },
        );
        const [cliSide, srvSide] = InMemoryTransport.createLinkedPair();
        const cli = new Client({ name: `r265-${id}`, version: '1.0.0' });
        await srv.connect(srvSide);
        await cli.connect(cliSide);
        let seq = 0;
        const call = async (tool: string, args: Record<string, unknown>) => {
          const res = await cli.callTool({ name: tool, arguments: args });
          const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
          expect(res.isError, `${name}:${tool} 报错: ${text}`).toBeFalsy();
          return { rawText: text, bytes: Buffer.byteLength(text, 'utf8'), data: JSON.parse(text) };
        };
        const act = async (action: Record<string, unknown>) => {
          seq += 1;
          return (
            await call('world_act', {
              request_id: `r265_${id}_${String(seq).padStart(4, '0')}`,
              action_window: 'city',
              context_version: 0,
              action,
            })
          ).data;
        };
        return { cli, call, act };
      };

      const sessA = await connectSession('7911', '成衣藏家甲');
      const sessB = await connectSession('7912', '同行买手乙');

      // 推进到 12:00 JST，云港流光工坊（11:00–21:00）正常营业
      h.advance(2 * HOUR);
      const bio80A = '偏爱在云港流光工坊与棱光街书街之间漫步搜集四季成衣礼盒与初版诗集，每逢雨天便在窗边记录晴空都街景与电车时刻的旅人甲。'.padEnd(80, '甲').slice(0, 80);
      const bio80B = '常驻云港与棱光街窄巷寻访独立设计师礼服与喫茶手冲咖啡的买手同伴，习惯用长句分享每一套成衣剪裁细节的旅人乙。'.padEnd(80, '乙').slice(0, 80);
      expect([...bio80A]).toHaveLength(80);
      expect([...bio80B]).toHaveLength(80);

      const enterA = await sessA.call('enter_world', {
        world_id: 'city',
        name: '成衣藏家甲',
        bio: bio80A,
        entry: 'kumominato:station',
        client_id: 'r265_cli_a',
      });
      const resIdA = enterA.data.resident_id as string;
      await sessB.call('enter_world', {
        world_id: 'city',
        name: '同行买手乙',
        bio: bio80B,
        entry: 'kumominato:station',
        client_id: 'r265_cli_b',
      });

      const advanceBoth = async (mins: number) => {
        for (let m = 0; m < mins; m += 2) {
          h.advance(Math.min(2, mins - m) * MIN);
          await sessA.call('heartbeat', {});
          await sessB.call('heartbeat', {});
        }
      };

      // 双人步行至云港流光工坊：甲买 12 件独立服饰，回云港站全部存入个人储物柜；乙买 12 件独立服饰在店内当面送给甲
      await sessA.act({ type: 'travel', to: 'kumominato:lumiere-atelier' });
      await sessB.act({ type: 'travel', to: 'kumominato:lumiere-atelier' });
      await advanceBoth(10);

      const shopViewA = await sessA.call('get_my_view', {});
      const sortedGoods = [...(shopViewA.data.here.goods as Array<{ sku: string; price_yen: number }>)].sort(
        (x, y) => x.price_yen - y.price_yen,
      );
      const cheapSku = sortedGoods[0]!.sku;

      const lockerExpectedIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const bought = await sessA.act({ type: 'buy', sku: cheapSku, qty: 1 });
        lockerExpectedIds.push(String(bought.item.item_id));
      }
      await sessA.act({ type: 'travel', to: 'kumominato:station' });
      await advanceBoth(10);
      for (const id of lockerExpectedIds) {
        await sessA.act({ type: 'store_locker', item_id: id, qty: 1 });
      }

      await sessA.act({ type: 'travel', to: 'kumominato:lumiere-atelier' });
      await advanceBoth(10);

      const bagExpectedIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const bought = await sessB.act({ type: 'buy', sku: cheapSku, qty: 1 });
        const itemId = String(bought.item.item_id);
        await sessB.act({ type: 'give', to: resIdA, item_id: itemId, qty: 1 });
        bagExpectedIds.push(itemId);
      }

      // ── 验证 R265-01a：同处满载 12 背包服饰 + 12 柜件服饰 + 双人 80 字简介时，get_my_view 与重连 enter_world 均 <= 4096 B ──
      const fullPlain = await sessA.call('get_my_view', {});
      expect(fullPlain.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      const baseCursor = fullPlain.data.cursor as string;

      const reEnter = await sessA.call('enter_world', {
        world_id: 'city',
        client_id: 'r265_cli_a',
      });
      expect(reEnter.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);

      // ── 验证 R265-01b：同伴正常发 300 字长聊天（连发 2 条）后从旧游标读取，每页 <= 4096 B 且可续游标零漏事件 ──
      const chat300_1 = '今天流光工坊橱窗里的礼服裙摆层次感真好，从云港南口一路走过来正好赶上换季陈列，每一套缎面与蕾丝的配色都很适合带回小屋衣柜珍藏。'.repeat(6).slice(0, 300);
      const chat300_2 = '等会儿逛完云港我们还可以乘晴环线去棱光街书店淘两本旧诗集，顺便在车站大厅把纪念印章也盖进印章帐里，傍晚再去浮光川河岸散步。'.repeat(6).slice(0, 300);
      expect([...chat300_1]).toHaveLength(300);
      expect([...chat300_2]).toHaveLength(300);
      await sessB.call('speak', { text: chat300_1, request_id: 'r265_speak_0001' });
      await sessB.call('speak', { text: chat300_2, request_id: 'r265_speak_0002' });

      const receivedTexts: string[] = [];
      let cur = baseCursor;
      for (let guard = 0; guard < 10; guard++) {
        const evPage = await sessA.call('get_my_view', { cursor: cur });
        expect(evPage.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        for (const ev of evPage.data.new_events ?? []) {
          if (ev.type === 'chat') receivedTexts.push(String(ev.text));
        }
        cur = evPage.data.cursor;
        if (!evPage.data.more) break;
      }
      expect(receivedTexts).toEqual([chat300_1, chat300_2]);

      // ── 验证 R265-02a：section="items" 与 section="locker_items" 按 page=1,2,... 逐页去重完整枚举全部 12 件 ──
      const seenBagByPage: string[] = [];
      for (let page = 1; page <= 15; page++) {
        const pRes = await sessA.call('get_my_view', { section: 'items', page });
        expect(pRes.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        const ids = (pRes.data.items as Array<{ item_id: string }>).map((x) => x.item_id);
        if (ids.length === 0) break;
        seenBagByPage.push(...ids);
        if (pRes.data.items_page?.next_offset === null) break;
      }
      expect(new Set(seenBagByPage).size).toBe(12);
      expect(seenBagByPage).toHaveLength(12);
      expect(new Set(seenBagByPage)).toEqual(new Set(bagExpectedIds));

      const seenLockerByPage: string[] = [];
      for (let page = 1; page <= 15; page++) {
        const pRes = await sessA.call('get_my_view', { section: 'locker_items', page });
        expect(pRes.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        const ids = (pRes.data.locker_items as Array<{ item_id: string }>).map((x) => x.item_id);
        if (ids.length === 0) break;
        seenLockerByPage.push(...ids);
        if (pRes.data.locker_page?.next_offset === null) break;
      }
      expect(new Set(seenLockerByPage).size).toBe(12);
      expect(seenLockerByPage).toHaveLength(12);
      expect(new Set(seenLockerByPage)).toEqual(new Set(lockerExpectedIds));

      // ── 验证 R265-02b：首屏返回的 next_offset 可直接传入 get_my_view(section, offset) 及全视图 item_offset 续读完整 12 件 ──
      const firstFull = await sessA.call('get_my_view', {});
      expect(firstFull.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      const seenBagByOffset = new Set<string>((firstFull.data.items as Array<{ item_id: string }>).map((x) => x.item_id));
      let nextBagOff: number | null = firstFull.data.items_page?.next_offset ?? null;
      for (let guard = 0; nextBagOff !== null && guard < 15; guard++) {
        const offRes = await sessA.call('get_my_view', { section: 'items', offset: nextBagOff });
        expect(offRes.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        expect(offRes.data.items.length).toBeGreaterThan(0);
        for (const it of offRes.data.items) seenBagByOffset.add(String(it.item_id));
        nextBagOff = offRes.data.items_page?.next_offset ?? null;
      }
      expect(seenBagByOffset.size).toBe(12);

      const seenFullViewOffsets = new Set<string>((firstFull.data.items as Array<{ item_id: string }>).map((x) => x.item_id));
      let fvOff: number | null = firstFull.data.items_page?.next_offset ?? null;
      for (let guard = 0; fvOff !== null && guard < 20; guard++) {
        const fvPage = await sessA.call('get_my_view', { item_offset: fvOff });
        expect(fvPage.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        expect(fvPage.data.items.length).toBeGreaterThan(0);
        for (const it of fvPage.data.items) seenFullViewOffsets.add(String(it.item_id));
        fvOff = fvPage.data.items_page?.next_offset ?? null;
      }
      expect(seenFullViewOffsets.size).toBe(12);

      const seenLockerByOffset = new Set<string>((firstFull.data.locker_items as Array<{ item_id: string }>).map((x) => x.item_id));
      let nextLkOff: number | null = firstFull.data.locker_page?.next_offset ?? null;
      for (let guard = 0; nextLkOff !== null && guard < 15; guard++) {
        const lkOffRes = await sessA.call('get_my_view', { section: 'locker_items', offset: nextLkOff });
        expect(lkOffRes.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        expect(lkOffRes.data.locker_items.length).toBeGreaterThan(0);
        for (const lk of lkOffRes.data.locker_items) seenLockerByOffset.add(String(lk.item_id));
        nextLkOff = lkOffRes.data.locker_page?.next_offset ?? null;
      }
      expect(seenLockerByOffset.size).toBe(12);

      const seenFullLockerOffsets = new Set<string>((firstFull.data.locker_items as Array<{ item_id: string }>).map((x) => x.item_id));
      let fvLkOff: number | null = firstFull.data.locker_page?.next_offset ?? null;
      for (let guard = 0; fvLkOff !== null && guard < 20; guard++) {
        const fvLkPage = await sessA.call('get_my_view', { locker_offset: fvLkOff });
        expect(fvLkPage.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        expect(fvLkPage.data.locker_items.length).toBeGreaterThan(0);
        for (const lk of fvLkPage.data.locker_items) seenFullLockerOffsets.add(String(lk.item_id));
        fvLkOff = fvLkPage.data.locker_page?.next_offset ?? null;
      }
      expect(seenFullLockerOffsets.size).toBe(12);

      // ── 验证极端边界 1：超长单事件（> 3.2 KB 文本 & 巨型非文本载荷）依然 <= 4096 B 且保留可续游标零漏事件 ──
      const beforeOversizeCur = (await sessA.call('get_my_view', {})).data.cursor as string;
      h.city.commit(() => {
        h.city.emitTo(
          [resIdA],
          'chat',
          {
            message_id: 99001,
            place: 'kumominato:lumiere-atelier',
            from: { id: 'res_oversize', name: '长文客', bio: bio80B },
            text: '超长书信段落'.repeat(300),
            untrusted: true,
          },
          h.city.now(),
        );
      });
      const oversizeTextPage = await sessA.call('get_my_view', { cursor: beforeOversizeCur });
      expect(oversizeTextPage.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      expect(oversizeTextPage.data.new_events).toHaveLength(1);
      expect(oversizeTextPage.data.new_events[0]).toMatchObject({ type: 'chat', message_id: 99001, text_truncated: true });
      expect(oversizeTextPage.data.cursor).not.toBe(beforeOversizeCur);

      const beforeBlobCur = oversizeTextPage.data.cursor as string;
      h.city.commit(() => {
        h.city.emitTo(
          [resIdA],
          'custom_huge',
          { huge_blob: 'X'.repeat(4200) },
          h.city.now(),
        );
      });
      const deferredPage = await sessA.call('get_my_view', { cursor: beforeBlobCur });
      expect(deferredPage.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      expect(deferredPage.data).toMatchObject({
        new_events: [],
        more: true,
        events_deferred: true,
        cursor: beforeBlobCur,
      });
      // 用保留的原可续游标调 world_wait 可无损读出该条巨型原始事件，零静默漏事件
      const waitedHuge = await sessA.call('world_wait', { cursor: beforeBlobCur, wait_seconds: 0 });
      expect(waitedHuge.data.events).toHaveLength(1);
      expect(waitedHuge.data.events[0].type).toBe('custom_huge');

      // ── 验证极端边界 2：当 12 件实例均携带 300 字长 summary 时，section 分页自动收紧一致 page_size 且 <= 4096 B 完整枚举 ──
      h.city.commit(() => {
        for (const id of bagExpectedIds) {
          h.city.db.run(
            'UPDATE items SET meta_json = ? WHERE item_id = ?',
            JSON.stringify({
              title: '附长篇手写穿搭札记与季节剪裁卡片的限量礼服典藏盒',
              summary: '在云港流光工坊试穿后附上三百字面料保养说明与搭配手记，记录晴空都秋日街景。'.repeat(9).slice(0, 300),
              untrusted: true,
            }),
            id,
          );
        }
      });
      const heavyBagSeen: string[] = [];
      for (let page = 1; page <= 20; page++) {
        const pRes = await sessA.call('get_my_view', { section: 'items', page });
        expect(pRes.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        const ids = (pRes.data.items as Array<{ item_id: string }>).map((x) => x.item_id);
        if (ids.length === 0) break;
        heavyBagSeen.push(...ids);
        if (pRes.data.items_page?.next_offset === null) break;
      }
      expect(new Set(heavyBagSeen).size).toBe(12);
      expect(heavyBagSeen).toHaveLength(12);

      await sessA.cli.close();
      await sessB.cli.close();
    } finally {
      await h.close();
    }
  });

  it('/city/play/ 静态契约、CSP、Modern Web Guidance 规范、严格信息对等与人类会话盖章全链路成立', async () => {
    const html = readFileSync(new URL('index.html', CITY_WEB_DIR), 'utf8');
    const css = readFileSync(new URL('style.css', CITY_WEB_DIR), 'utf8');
    const js = readFileSync(new URL('app.js', CITY_WEB_DIR), 'utf8');
    const jsCode = stripJsComments(js);

    // 组件存在性：车门液晶牌、微缩窗景、动效暂停钮、三站呼吸拓扑、车站印章帐
    expect(html).toContain('id="lcd-board"');
    expect(html).toContain('id="window-cutout-svg"');
    expect(html).toContain('id="toggle-motion-btn"');
    expect(html).toContain('id="rail-topology-svg"');
    expect(html).toContain('id="stamp-book-card"');
    expect(html).toContain('id="bag-pager"');
    expect(html).toContain('id="locker-pager"');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    // WCAG 2.2.2：文案切换型暂停按钮不挂 aria-pressed
    expect(html).not.toContain('aria-pressed');
    expect(jsCode).not.toContain('aria-pressed');

    // CSP 与 DOM 安全：零 innerHTML、零内联 style 操作
    expect(jsCode).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/);
    expect(jsCode).not.toMatch(/\.style\b/);
    expect(jsCode).not.toMatch(/setAttribute\s*\(\s*['"`]style['"`]/);
    for (const stId of ['st:hiyorizaka', 'st:ryokogai', 'st:kumominato']) {
      expect(jsCode).toContain(stId);
    }
    for (const legacySt of ['st:akabane', 'st:ikebukuro', 'st:shinjuku', 'st:jinbocho', 'st:shimokitazawa']) {
      expect(jsCode).not.toContain(legacySt);
    }

    // 严格信息对等：/city/play/ 的总览渲染绝不读取 p.here 透视全城其他居民姓名
    expect(jsCode).not.toMatch(/\bp\.here\b/);

    // Modern Web Guidance：零 px 字号、局部深色液晶牌 color-scheme: dark、无全局 0.01ms 反模式、仅在 no-preference 启用合成器动画
    expect(css).not.toMatch(/font-size\s*:\s*[\d.]+px/i);
    expect(css).not.toContain('0.01ms');
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('prefers-reduced-motion: no-preference');

    // HTTP 真链路：静态资源 CSP 头 + devLogin 登录入城 -> 乘晴环线赴棱光街站 -> POST /city/api/act 盖章 -> GET /city/api/stamps
    const h = await createIsolatedCityHarness({ cityOverrides: { devLogin: true } });
    try {
      const pageRes = await fetch(`${h.baseUrl}/city/play/`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get('content-security-policy')).toContain("style-src 'self'");

      const origin = h.baseUrl;
      const loginRes = await fetch(`${h.baseUrl}/city/api/auth/dev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ name: '网页旅人' }),
      });
      expect(loginRes.status).toBe(200);
      const rawCookie = loginRes.headers.get('set-cookie') ?? '';
      const cookie = rawCookie.split(';')[0]!;
      const { csrf_token: csrf } = (await loginRes.json()) as { csrf_token: string };

      const authed = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(`${h.baseUrl}/city/api${path}`, {
          method,
          headers: {
            cookie,
            'x-city-client': 'web_m3d_e2e',
            ...(method !== 'GET' ? { 'content-type': 'application/json', origin, 'x-city-csrf': csrf } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: r.status, body: (await r.json()) as any };
      };

      const entered = await authed('POST', '/enter', {
        name: '网页旅人',
        entry: 'kumominato:station',
        client_id: 'web_m3d_e2e',
      });
      expect(entered.status).toBe(200);
      expect(entered.body.view.stamp_book).toEqual({ collected: 0, total: 3, here_stamped: false });

      const traveled = await authed('POST', '/act', {
        client_id: 'web_m3d_e2e',
        request_id: 'web_m3d_travel_kg',
        action: { type: 'travel', to: 'ryokogai:station' },
      });
      expect(traveled.status).toBe(200);
      for (let i = 0; i < 6; i++) {
        h.advance(2 * MIN);
        await authed('POST', '/heartbeat', { client_id: 'web_m3d_e2e' });
      }

      const stamped = await authed('POST', '/act', {
        client_id: 'web_m3d_e2e',
        request_id: 'web_m3d_stamp_kg',
        action: { type: 'stamp_station' },
      });
      expect(stamped.status).toBe(200);
      expect(stamped.body).toMatchObject({
        newly_stamped: true,
        stamp: { stamp_id: 'stamp:ryokogai', station_id: 'st:ryokogai' },
        view: { stamp_book: { collected: 1, total: 3, here_stamped: true } },
      });

      const book = await authed('GET', '/stamps');
      expect(book.status).toBe(200);
      expect(book.body).toMatchObject({ collected: 1, total: 3 });
      expect(book.body.stamps.find((s: any) => s.station_id === 'st:ryokogai')).toMatchObject({
        collected: true,
        emblem: 'owl',
      });

      // 塞入 12 件具名服饰礼盒进储物柜 + 8 件随身：验证首屏 <=4096 B 截断后，网页 /me?locker_offset=... 能完整遍历并取出非首屏物品
      h.city.commit(() => {
        const meId = String(entered.body.resident_id);
        for (let idx = 1; idx <= 12; idx++) {
          h.city.db.run(
            "INSERT INTO items(item_id, owner_id, type, quantity, state, instance, meta_json, created_at, updated_at) VALUES (?,?,'apparel_bundle',1,'locker',1,?,?,?)",
            `it_lk_page_${idx}`,
            meId,
            JSON.stringify({ title: `典藏成衣礼盒第${idx}号`, summary: '附独立缎带防尘袋与手工编号标签的限量成衣套装', untrusted: true }),
            h.city.now(),
            h.city.now() + idx,
          );
        }
        for (let idx = 1; idx <= 8; idx++) {
          h.city.db.run(
            "INSERT INTO items(item_id, owner_id, type, quantity, state, instance, meta_json, created_at, updated_at) VALUES (?,?,'apparel_bundle',1,'held',1,?,?,?)",
            `it_bag_page_${idx}`,
            meId,
            JSON.stringify({ title: `随身礼盒第${idx}号`, summary: '棱光街与云港逛街购入的成衣礼盒', untrusted: true }),
            h.city.now(),
            h.city.now() + idx,
          );
        }
      });

      const seenLockerIds = new Set<string>();
      let lkOff: number | null = 0;
      for (let step = 0; lkOff !== null && step < 25; step++) {
        const mePage = await authed('GET', `/me?client_id=web_m3d_e2e&locker_offset=${lkOff}`);
        expect(mePage.status).toBe(200);
        expect(Buffer.byteLength(JSON.stringify(mePage.body), 'utf8')).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
        expect(mePage.body.locker_items.length).toBeGreaterThan(0);
        for (const lk of mePage.body.locker_items) seenLockerIds.add(String(lk.item_id));
        lkOff = mePage.body.locker_page?.next_offset ?? null;
      }
      expect(lkOff).toBeNull();
      expect(seenLockerIds.size).toBe(12);
      // 站在神保町站大厅直接取出末页的 it_lk_page_12
      const takeTail = await authed('POST', '/act', {
        client_id: 'web_m3d_e2e',
        request_id: 'web_m3d_take_tail',
        locker_offset: 11,
        action: { type: 'take_locker', item_id: 'it_lk_page_12', qty: 1 },
      });
      expect(takeTail.status).toBe(200);
      expect(takeTail.body.view.locker_page?.offset ?? 0).toBeLessThanOrEqual(10);
    } finally {
      await h.close();
    }
  });
});

function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function citySayForStress(h: Awaited<ReturnType<typeof createIsolatedCityHarness>>, residentId: string, text: string): void {
  const seq = h.city.db.scalar('SELECT COUNT(*) FROM chat_messages') + 1;
  h.city.commit(() => {
    const now = h.city.now();
    const msgId = Number(
      h.city.db.run('INSERT INTO chat_messages(place_id, sender_id, body, sent_at) VALUES (?,?,?,?)', 'ryokogai:shiorido', residentId, text, now)
        .lastInsertRowid,
    );
    for (const r of h.city.presentAt('ryokogai:shiorido')) {
      h.city.db.run('INSERT OR IGNORE INTO chat_audience(message_id, resident_id) VALUES (?,?)', msgId, r.resident_id);
    }
    const targets = h.city
      .presentAt('ryokogai:shiorido')
      .map((r) => r.resident_id)
      .filter((id) => id !== residentId);
    h.city.emitTo(
      targets,
      'chat',
      {
        message_id: msgId,
        place: 'ryokogai:shiorido',
        from: { id: residentId, name: `书客${seq}` },
        text,
        untrusted: true,
      },
      now,
    );
  });
}
