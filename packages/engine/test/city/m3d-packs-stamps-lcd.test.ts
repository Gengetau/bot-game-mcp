/**
 * 东京 M3-D（#265）专项回归测试：
 *  1. 神保町（dist:jinbocho / mun:13101）与下北泽（dist:shimokitazawa / mun:13112）标准 CityContentPack 挂载、
 *     真实公共空间 vs 虚构店铺分层、跨午夜营业时段、雨天开闭规则、多运营商换乘距离与模拟票价；
 *  2. 零侵入 ledger.ts / visits.ts 核心状态机下，室友完整外出闭环（神保町咖喱堂食与古书带回、下北泽回程车费预留）；
 *  3. 车站印章帐（Eki-Stamp）：五站唯一印章、同站重复盖章幂等、非车站 422 拒绝、零占背包/储物柜槽位、按需查询明细；
 *  4. 挂载全部五片街区后的 selfView <= 4 KB（4096 UTF-8 字节）与 here.exits <= 24 高压守门（含带 cursor 合并事件零跳漏）；
 *  5. 人类网页端 /city/play/ 车门液晶牌、微缩天气×昼夜窗景、五站呼吸拓扑、动效暂停按钮、CSP 安全及严格信息对等。
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
  JINBOCHO_PACK,
  MOUNTED_CONTENT_PACKS,
  MUNICIPALITIES,
  SELF_VIEW_MAX_BYTES,
  SHIMOKITAZAWA_PACK,
  STATION_STAMPS,
  applyWeather,
  homeward,
  ledgerImbalance,
  openAt,
  place,
  planRoute,
  publicCityView,
  runReconcile,
  stampBookView,
  validateCatalog,
  validateContentPack,
  type WeatherReading,
} from '../../src/city/index.js';
import { HOUR, MIN, T0, makeCity } from './helpers.js';
import { createIsolatedCityHarness } from './test-harness.js';

const CITY_WEB_DIR = new URL('../../city/', import.meta.url);

describe('M3-D 标准 ContentPack：神保町与下北泽地理/虚构分层及跨站换乘 (#265)', () => {
  it('标准挂载 JINBOCHO_PACK 与 SHIMOKITAZAWA_PACK，目录静态自检零错误并落库 catalog_versions', () => {
    expect(CITY_CATALOG_VERSION).toBe('tokyo-p1.2');
    expect(MOUNTED_CONTENT_PACKS.map((p) => p.packId)).toEqual(['pack:jinbocho', 'pack:shimokitazawa']);
    expect(validateContentPack(JINBOCHO_PACK)).toEqual([]);
    expect(validateContentPack(SHIMOKITAZAWA_PACK)).toEqual([]);
    expect(validateCatalog()).toEqual([]);

    expect(MUNICIPALITIES.map((m) => m.id)).toEqual(['mun:13117', 'mun:13116', 'mun:13104', 'mun:13101', 'mun:13112']);
    expect(JINBOCHO_PACK.municipality).toMatchObject({ id: 'mun:13101', name: '千代田区' });
    expect(JINBOCHO_PACK.district).toMatchObject({ id: 'dist:jinbocho', municipalityId: 'mun:13101', openness: 'livable' });
    expect(SHIMOKITAZAWA_PACK.municipality).toMatchObject({ id: 'mun:13112', name: '世田谷区' });
    expect(SHIMOKITAZAWA_PACK.district).toMatchObject({ id: 'dist:shimokitazawa', municipalityId: 'mun:13112', openness: 'livable' });

    // 真实公共空间（车站 + 靖国通书街步道 / 下北线路街绿道）与虚构店铺严格分离
    for (const realId of [
      'jinbocho:station',
      'jinbocho:yasukuni-promenade',
      'shimokitazawa:station',
      'shimokitazawa:senrogai-greenway',
    ]) {
      const p = place(realId)!;
      expect(p.fictional, `${realId} 应为真实地理空间`).toBe(false);
      expect(p.source).not.toBe('fictional');
    }
    for (const ficId of [
      'jinbocho:drift-book-corner',
      'jinbocho:koushodou',
      'jinbocho:curry-kohaku',
      'shimokitazawa:roji-theatre',
      'shimokitazawa:furudougu-neko',
      'shimokitazawa:kissa-yorufune',
    ]) {
      const p = place(ficId)!;
      expect(p.fictional, `${ficId} 应标为虚构店铺`).toBe(true);
      expect(p.source).toBe('fictional');
    }

    const t = makeCity();
    const verRow = t.c.db.get<{ catalog_version: string; fare_rule_version: string; summary_json: string }>(
      'SELECT catalog_version, fare_rule_version, summary_json FROM catalog_versions WHERE catalog_version = ?',
      'tokyo-p1.2',
    );
    expect(verRow).toBeDefined();
    expect(JSON.parse(verRow!.summary_json)).toMatchObject({
      stations: 5,
      stamps: 5,
    });
  });

  it('换乘距离、模拟票价、跨午夜喫茶营业时段与雨天绿道关闭规则全部确定性成立', () => {
    const rJinbocho = planRoute('shinjuku:station', 'jinbocho:station')!;
    expect(rJinbocho).toMatchObject({ minutes: 11, fareYen: 220 });
    expect(rJinbocho.legs[0]).toMatchObject({ mode: 'train', line: '都营新宿线' });

    const rShimokita = planRoute('shinjuku:station', 'shimokitazawa:station')!;
    expect(rShimokita).toMatchObject({ minutes: 9, fareYen: 170 });
    expect(rShimokita.legs[0]).toMatchObject({ mode: 'train', line: '小田急小田原线' });

    // 室友从两片新街区回赤羽小屋门口的保底预留车费与耗时
    expect(homeward('jinbocho:koushodou')).toEqual({ minutes: 45, fareYen: 480 });
    expect(homeward('shimokitazawa:kissa-yorufune')).toEqual({ minutes: 44, fareYen: 430 });

    // 下北泽深夜喫茶「夜船」（18:00–02:00 跨午夜）：01:00 与 23:30 营业，03:00 与 14:00 休息
    const yorufune = place('shimokitazawa:kissa-yorufune')!;
    expect(openAt(yorufune, 1 * 60)).toBe(true);
    expect(openAt(yorufune, 23 * 60 + 30)).toBe(true);
    expect(openAt(yorufune, 3 * 60)).toBe(false);
    expect(openAt(yorufune, 14 * 60)).toBe(false);

    // 真雨天气下：五片街区同步实时降水，神保町与下北泽露天步道保持开放并给出淋雨提示，南池袋公园按 closed_rain 关闭
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
    expect(pub.areas).toHaveLength(5);
    const jbArea = pub.areas.find((a: any) => a.id === 'jinbocho');
    const skArea = pub.areas.find((a: any) => a.id === 'shimokitazawa');
    const akArea = pub.areas.find((a: any) => a.id === 'akabane');
    expect(jbArea.places.find((p: any) => p.id === 'jinbocho:yasukuni-promenade').open).toBe(true);
    expect(skArea.places.find((p: any) => p.id === 'shimokitazawa:senrogai-greenway').open).toBe(true);
    expect(akArea.places.find((p: any) => p.id === 'akabane:arakawa-riverbank')).toMatchObject({
      open: false,
      closed_reason: 'rain',
    });
    const walker = t.bot('雨中旅人', { entry: 'shinjuku:station' });
    walker.go('jinbocho:yasukuni-promenade');
    expect((walker.view().here as any).place.rain_notice).toContain('下雨');
  });

  it('零改 ledger/visits 下，室友赴神保町堂食咖喱、淘旧书并盖站章，返家结算与复式账本零误差', () => {
    const t = makeCity({ at: Date.UTC(2026, 10, 17, 3, 0, 0) }); // 12:00 JST（琥珀堂与向书堂均营业）
    const nia = t.kernel('nia');

    nia.depart({ yen: 15_000, items: [], to: 'jinbocho:curry-kohaku' });
    t.run(50 * MIN);

    expect((nia.view().location as any).place).toBe('jinbocho:curry-kohaku');
    // 买两份堂食欧风咖喱：吃掉 1 份，剩 1 份验证返家按 carry_home=false 自动归 disposed
    nia.act({ type: 'buy', sku: 'curry_rice', qty: 2 });
    nia.act({ type: 'consume', item: 'curry_rice', qty: 1 });

    // 步行去向书堂买一本具名旧书，再去神保町站大厅盖纪念章后回家
    nia.act({ type: 'travel', to: 'jinbocho:koushodou' });
    t.run(15 * MIN);
    nia.act({ type: 'buy', sku: 'used_paperback', qty: 1 });

    nia.act({ type: 'travel', to: 'jinbocho:station' });
    t.run(10 * MIN);
    const stampRes = nia.act({ type: 'stamp_station' });
    expect(stampRes.payload).toMatchObject({
      status: 'completed',
      newly_stamped: true,
      stamp: { stamp_id: 'stamp:jinbocho', station_id: 'st:jinbocho' },
      stamp_book: { collected: 1, total: 5, here_stamped: true },
    });

    nia.act({ type: 'go_home' });
    t.run(45 * MIN);
    nia.pull();
    const settled = nia.settlement!;
    expect(settled).not.toBeNull();
    expect(settled.items.some((i) => i.type === 'paperback' && i.fate === 'locker')).toBe(true);
    expect(settled.items.some((i) => i.type === 'curry_rice' && i.fate === 'consumed')).toBe(true);
    expect(settled.items.some((i) => i.type === 'curry_rice' && i.fate === 'disposed')).toBe(true);

    expect(nia.release().state).toBe('closed');
    expect(ledgerImbalance(t.c)).toBe(0);
    expect(runReconcile(t.c, 'm3d-visit').ok).toBe(true);
  });
});

describe('车站印章帐（Eki-Stamp）幂等、零占包与按需查询 (#265)', () => {
  it('巡游五站集齐 5 枚唯一印章，同站重复盖章幂等保留首次时间戳且绝不占随身背包或储物柜', () => {
    expect(STATION_STAMPS).toHaveLength(5);
    expect(new Set(STATION_STAMPS.map((s) => s.stampId)).size).toBe(5);

    const t = makeCity({ at: T0 });
    const traveler = t.bot('集章旅人', { entry: 'shinjuku:station', stay: true });

    // 先把随身背包买满 12 件手账本，证明满包状态下依然可以在全部车站自由盖章，零占槽位
    traveler.go('shinjuku:kamitsuki');
    for (let i = 0; i < 12; i++) traveler.act({ type: 'buy', sku: 'notebook', qty: 1 });
    expect((traveler.view().items as any[]).reduce((n, x) => n + x.qty, 0)).toBe(12);

    // 在非车站店铺尝试盖章：明确返回 PRECONDITION_FAILED (not_at_stamp_desk)
    expect(() => traveler.act({ type: 'stamp_station' })).toThrowError(/印章台/);

    // 首站：新宿站盖章，并测试 20 分钟后新 request_id 同站重复盖章幂等
    traveler.go('shinjuku:station');
    const firstStamp = traveler.act({ type: 'stamp_station' });
    const firstAt = (firstStamp.stamp as any).stamped_at_ms as number;
    expect(firstStamp).toMatchObject({
      newly_stamped: true,
      stamp_book: { collected: 1, total: 5, here_stamped: true },
    });

    t.run(20 * MIN);
    const repeatStamp = traveler.act({ type: 'stamp_station' });
    expect(repeatStamp).toMatchObject({
      newly_stamped: false,
      stamp: { stamp_id: 'stamp:shinjuku', stamped_at_ms: firstAt },
      stamp_book: { collected: 1, total: 5, here_stamped: true },
    });

    // 继续巡游神保町、下北泽、池袋与赤羽四站
    for (const stPlace of ['jinbocho:station', 'shimokitazawa:station', 'ikebukuro:station', 'akabane:station']) {
      traveler.go(stPlace);
      const out = traveler.act({ type: 'stamp_station' });
      expect(out.newly_stamped).toBe(true);
    }

    const v = traveler.view();
    expect(v.stamp_book).toEqual({ collected: 5, total: 5, here_stamped: true });
    expect((v.items as any[]).length).toBe(1);
    expect((v.locker_items as any[]).length).toBe(0);

    const detail = stampBookView(t.c, traveler.id);
    expect(detail.collected).toBe(5);
    expect(detail.total).toBe(5);
    expect(detail.stamps.every((s) => s.collected && typeof s.stamped_at_ms === 'number')).toBe(true);
    expect(detail.stamps.find((s) => s.station_id === 'st:shinjuku')!.stamped_at_ms).toBe(firstAt);
  });
});

describe('挂载全部五片街区后的 selfView <= 4 KB 与网页端 /city/play/ 契约验证 (#265)', () => {
  it('高压满载（5 站章 + 12 具名背包件 + 12 储物柜件 + 同场人群 + 长聊天 + 待读事件）下 selfView 与 get_my_view 严守 <= 4096 B 且游标不漏事件', async () => {
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

      h.advance(35 * MIN); // 先把时钟推进到 10:35 JST，墨香堂（10:30 开门）营业中
      const entered = await callJson('enter_world', {
        world_id: 'tokyo',
        name: '满载测算员',
        bio: '在五片街区满载旧书与明信片验证四千字节契约上限的旅人',
        entry: 'shinjuku:station',
        client_id: 'm3d_budget_cli',
      });
      let ctxVer = entered.data.context.version as number;
      let reqSeq = 0;
      const act = async (action: Record<string, unknown>) => {
        reqSeq += 1;
        const r = await callJson('world_act', {
          request_id: `m3d_req_${String(reqSeq).padStart(4, '0')}`,
          action_window: 'tokyo',
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

      // 先在新宿站盖章，再去神保町向书堂买 12 本具名旧书存入神保町站储物柜，再买 12 本随身携带
      await act({ type: 'stamp_station' });
      await act({ type: 'travel', to: 'jinbocho:koushodou' });
      await advanceOnline(20);
      const firstShopView = await callJson('get_my_view', {});
      ctxVer = firstShopView.data.context.version;
      expect(firstShopView.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      expect(firstShopView.data.here.exits.map((e: any) => e.id)).toEqual(
        expect.arrayContaining(['jinbocho:station', 'shinjuku:station', 'shimokitazawa:station', 'ikebukuro:station', 'akabane:station']),
      );

      for (let i = 0; i < 12; i++) await act({ type: 'buy', sku: 'used_paperback', qty: 1 });
      await act({ type: 'travel', to: 'jinbocho:station' });
      await advanceOnline(10);
      let viewCall = await callJson('get_my_view', {});
      ctxVer = viewCall.data.context.version;
      await act({ type: 'stamp_station' });
      for (const it of viewCall.data.items as any[]) {
        await act({ type: 'store_locker', item_id: it.item_id, qty: 1 });
      }

      await act({ type: 'travel', to: 'jinbocho:koushodou' });
      await advanceOnline(10);
      const normalView = await callJson('get_my_view', {});
      ctxVer = normalView.data.context.version;
      expect(normalView.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      for (let i = 0; i < 12; i++) await act({ type: 'buy', sku: 'used_paperback', qty: 1 });

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
            "INSERT INTO residents(resident_id, principal_id, name, bio, origin, in_city, place_id, present_until, created_at, last_seen_at) VALUES (?,?,?,?,'external',1,'jinbocho:koushodou',?,?,?)",
            resId,
            principalId,
            `神保町书客${p}`,
            '常年在靖国通旧书回廊搜集近代文学初版本与欧风咖喱食评的独立读书人，遇到好书会写长笔记。',
            h.city.now() + HOUR,
            h.city.now(),
            h.city.now(),
          );
          return resId;
        });
        for (let m = 0; m < 2; m++) {
          citySayForStress(h, pr, `第${p}-${m}条书评：` + '在神保町向书堂翻到了昭和年代装帧考究的旧诗集与地图册，纸页间还夹着当年的书签。'.repeat(5));
        }
      }

      // 1) 极端满载下不带 cursor 的 get_my_view 依然严格 <= 4096 B，且保留本街区枢纽站与跨区换乘出口
      const vPlain = await callJson('get_my_view', {});
      expect(vPlain.bytes).toBeLessThanOrEqual(SELF_VIEW_MAX_BYTES);
      expect(vPlain.data.here.exits.length).toBeLessThanOrEqual(24);
      const exitIds = vPlain.data.here.exits.map((e: any) => e.id);
      expect(exitIds).toEqual(expect.arrayContaining(['jinbocho:station', 'shinjuku:station']));
      expect(vPlain.data.stamp_book).toEqual({ collected: 2, total: 5 });

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

      // 3) world_query(what="stamps") 返回完整五站印章明细
      const stampsQuery = await callJson('world_query', { world_id: 'tokyo', what: 'stamps' });
      expect(stampsQuery.data).toMatchObject({ collected: 2, total: 5 });
      expect(stampsQuery.data.stamps).toHaveLength(5);

      await mcp.close();
    } finally {
      await h.close();
    }
  });

  it('/city/play/ 静态契约、CSP、Modern Web Guidance 规范、严格信息对等与人类会话盖章全链路成立', async () => {
    const html = readFileSync(new URL('index.html', CITY_WEB_DIR), 'utf8');
    const css = readFileSync(new URL('style.css', CITY_WEB_DIR), 'utf8');
    const js = readFileSync(new URL('app.js', CITY_WEB_DIR), 'utf8');
    const jsCode = stripJsComments(js);

    // 组件存在性：车门液晶牌、微缩窗景、动效暂停钮、五站呼吸拓扑、车站印章帐
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
    for (const stId of ['st:akabane', 'st:ikebukuro', 'st:shinjuku', 'st:jinbocho', 'st:shimokitazawa']) {
      expect(jsCode).toContain(stId);
    }

    // 严格信息对等：/city/play/ 的总览渲染绝不读取 p.here 透视全城其他居民姓名
    expect(jsCode).not.toMatch(/\bp\.here\b/);

    // Modern Web Guidance：零 px 字号、局部深色液晶牌 color-scheme: dark、无全局 0.01ms 反模式、仅在 no-preference 启用合成器动画
    expect(css).not.toMatch(/font-size\s*:\s*[\d.]+px/i);
    expect(css).not.toContain('0.01ms');
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('prefers-reduced-motion: no-preference');

    // HTTP 真链路：静态资源 CSP 头 + devLogin 登录入城 -> 乘都营新宿线赴神保町站 -> POST /city/api/act 盖章 -> GET /city/api/stamps
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
        entry: 'shinjuku:station',
        client_id: 'web_m3d_e2e',
      });
      expect(entered.status).toBe(200);
      expect(entered.body.view.stamp_book).toEqual({ collected: 0, total: 5, here_stamped: false });

      const traveled = await authed('POST', '/act', {
        client_id: 'web_m3d_e2e',
        request_id: 'web_m3d_travel_jb',
        action: { type: 'travel', to: 'jinbocho:station' },
      });
      expect(traveled.status).toBe(200);
      for (let i = 0; i < 6; i++) {
        h.advance(2 * MIN);
        await authed('POST', '/heartbeat', { client_id: 'web_m3d_e2e' });
      }

      const stamped = await authed('POST', '/act', {
        client_id: 'web_m3d_e2e',
        request_id: 'web_m3d_stamp_jb',
        action: { type: 'stamp_station' },
      });
      expect(stamped.status).toBe(200);
      expect(stamped.body).toMatchObject({
        newly_stamped: true,
        stamp: { stamp_id: 'stamp:jinbocho', station_id: 'st:jinbocho' },
        view: { stamp_book: { collected: 1, total: 5, here_stamped: true } },
      });

      const book = await authed('GET', '/stamps');
      expect(book.status).toBe(200);
      expect(book.body).toMatchObject({ collected: 1, total: 5 });
      expect(book.body.stamps.find((s: any) => s.station_id === 'st:jinbocho')).toMatchObject({
        collected: true,
        emblem: 'books',
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
            JSON.stringify({ title: `随身礼盒第${idx}号`, summary: '神保町与新宿逛街购入的成衣礼盒', untrusted: true }),
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
      h.city.db.run('INSERT INTO chat_messages(place_id, sender_id, body, sent_at) VALUES (?,?,?,?)', 'jinbocho:koushodou', residentId, text, now)
        .lastInsertRowid,
    );
    for (const r of h.city.presentAt('jinbocho:koushodou')) {
      h.city.db.run('INSERT OR IGNORE INTO chat_audience(message_id, resident_id) VALUES (?,?)', msgId, r.resident_id);
    }
    const targets = h.city
      .presentAt('jinbocho:koushodou')
      .map((r) => r.resident_id)
      .filter((id) => id !== residentId);
    h.city.emitTo(
      targets,
      'chat',
      {
        message_id: msgId,
        place: 'jinbocho:koushodou',
        from: { id: residentId, name: `书客${seq}` },
        text,
        untrusted: true,
      },
      now,
    );
  });
}
