import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localToUtc } from '../../src/world/time.js';
import {
  CITY_CATALOG_VERSION,
  HOUSE_ENTRANCE,
  TRANSIT_EDGES,
  applyWeather,
  leaveCity,
  ledgerImbalance,
  publicCityView,
  routePreview,
  runReconcile,
  validateCatalog,
  type HouseMemberConfig,
  type WeatherReading,
} from '../../src/city/index.js';
import { HOUR, MIN, makeCity, rejects } from './helpers.js';

const SIX_HOUSEMATES: HouseMemberConfig[] = [
  { actorId: 'nia', name: '妮娅', bio: '喜欢甜食', qqIds: ['3001'] },
  { actorId: 'claire', name: '克蕾雅', bio: '安静看书', qqIds: ['3002'] },
  { actorId: 'alicia', name: '艾莉西亚', bio: '散步观察', qqIds: ['3003'] },
  { actorId: 'grok', name: '格洛克', bio: '夜空速记', qqIds: ['3004'] },
  { actorId: 'xingli', name: '星黎', bio: '听风记录', qqIds: ['3005'] },
  { actorId: 'whale', name: '鲸鱼', bio: '慢悠悠闲逛', qqIds: ['3006'] },
];

const jst = (date: string, h: number, m: number): number => localToUtc('Asia/Tokyo', date, h, m);

const tempDirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'city-m3a-'));
  tempDirs.push(dir);
  return join(dir, 'city.sqlite');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe('M3-A 1：模拟首末班运营时间窗（05:00–00:20 JST，source=simulated）', () => {
  it('目录版本递增至 tokyo-p1.2，铁道边全部携带 simulated 首末班时间并通过自检', () => {
    expect(CITY_CATALOG_VERSION).toBe('tokyo-p1.2');
    expect(validateCatalog()).toEqual([]);
    for (const edge of TRANSIT_EDGES) {
      expect(edge.hours).toEqual({ first: '05:00', last: '00:20' });
      expect(edge.sources).toContain('sim-hours');
    }
  });

  it('00:19 末班车正常发车并在跨过 00:20 后到站落账；00:20–04:59 停运拒载，同片区步行与 24h 店照常；05:00 首班恢复', () => {
    const t = makeCity({ at: jst('2026-11-18', 0, 0) });
    const rider = t.bot('夜归客', { entry: 'ikebukuro:station' });
    const nightBot = t.bot('深夜旅人', { entry: 'ikebukuro:station' });
    const lateWalker = t.bot('散步客', { entry: 'shinjuku:station' });
    rider.act({ type: 'travel', to: 'akabane:station' });
    nightBot.act({ type: 'travel', to: 'akabane:station' });
    lateWalker.act({ type: 'travel', to: 'shinjuku:southern-terrace' });
    t.run(19 * MIN); // 00:19 JST：rider 与 nightBot 在赤羽站，lateWalker 在新宿南口露台

    // 00:19 仍在运营窗内：站内直接上车出发，预计 00:38 到达新宿站
    expect((publicCityView(t.c).transit as any).edges.every((e: any) => e.open === true)).toBe(true);
    const accepted = rider.act({ type: 'travel', to: 'shinjuku:station' });
    expect(accepted.trip).toMatchObject({
      from: 'akabane:station',
      to: 'shinjuku:station',
      fare_yen: 260,
      source: 'simulated',
      same_car_travellers: 0,
    });

    // 00:19 从新宿南口露台去池袋站：需先步行 4 分钟（00:23 才到站上车），前置校验按上车时刻拦截
    const blockedWalkTrain = rejects(
      () => lateWalker.act({ type: 'travel', to: 'ikebukuro:station' }),
      'PRECONDITION_FAILED',
      'transit_closed_night',
    );
    expect(blockedWalkTrain.data).toMatchObject({
      from: 'shinjuku:station',
      to: 'ikebukuro:station',
      board_at_ms: jst('2026-11-18', 0, 23),
      hours: { first: '05:00', last: '00:20' },
      source: 'simulated',
    });

    // 推进 1 分钟至 00:20：全线进入夜间停运
    t.run(1 * MIN);
    expect((publicCityView(t.c).transit as any).edges.every((e: any) => e.open === false)).toBe(true);
    expect(routePreview(t.c, 'akabane:station', 'ikebukuro:station')).toMatchObject({
      transit_open: false,
      transit_closed_reason: 'transit_closed_night',
      dest_open: true,
    });

    rejects(() => nightBot.act({ type: 'travel', to: 'ikebukuro:station' }), 'PRECONDITION_FAILED', 'transit_closed_night');

    // 同街区步行、站前广场及 24h 便利店在停运期照常通行与消费
    nightBot.go('akabane:ekimae-plaza');
    expect(nightBot.view().location).toEqual({ place: 'akabane:ekimae-plaza' });
    nightBot.go('akabane:ekimae-conbini');
    expect(nightBot.view().location).toEqual({ place: 'akabane:ekimae-conbini' });
    expect(nightBot.act({ type: 'buy', sku: 'onigiri' })).toMatchObject({ status: 'completed', paid_yen: 160 });

    // 00:19 已发车的夜归客在 00:38 正常抵达新宿站，不半空卡死
    t.run(18 * MIN);
    expect(rider.view().location).toEqual({ place: 'shinjuku:station' });

    // 推进至 04:59 仍停运；05:00 首班车准点恢复通行
    t.run(jst('2026-11-18', 4, 59) - t.clock.t);
    rejects(() => rider.act({ type: 'travel', to: 'ikebukuro:station' }), 'PRECONDITION_FAILED', 'transit_closed_night');
    // 04:56 从新宿南口露台出发（先步行 4m，05:00 整点才到新宿站上车）：按上车时刻 board_at_ms 判定，准予通行
    const earlyWalker = makeCity({ at: jst('2026-11-18', 4, 56) });
    const ew = earlyWalker.bot('早起行人', { entry: 'shinjuku:station' });
    ew.act({ type: 'travel', to: 'shinjuku:southern-terrace' });
    earlyWalker.run(4 * MIN); // 05:00 -> 回拨到 04:56 测先走后乘
    earlyWalker.clock.t = jst('2026-11-18', 4, 56);
    const walkThenFirstTrain = ew.act({ type: 'travel', to: 'ikebukuro:station' });
    expect(walkThenFirstTrain.trip.legs[1]).toMatchObject({
      mode: 'train',
      depart_at_ms: jst('2026-11-18', 5, 0),
    });
    t.run(1 * MIN); // 05:00 JST
    expect((publicCityView(t.c).transit as any).edges.every((e: any) => e.open === true)).toBe(true);
    rider.go('ikebukuro:station');
    expect(rider.view().location).toEqual({ place: 'ikebukuro:station' });
    expect(ledgerImbalance(t.c)).toBe(0);
  });
});

describe('M3-A 2：小屋室友终电归家护栏（23:30 后进城、跨午夜边界、六室友全员不滞留、雨天改道）', () => {
  it('晚间进城且原 return_by 跨过终电时，自动返程截止点收紧至终电前安全时刻并按 last_train 归家', () => {
    const t = makeCity({ at: jst('2026-11-18', 22, 30) });
    const nia = t.kernel('nia');
    // 南池袋公园：回程步行 7m 到池袋站 + 13m 埼京线 + 12m 步行；原 return_by 为次日 02:30
    nia.depart({ yen: 5000, to: 'ikebukuro:minami-park', returnIn: 4 * HOUR });
    t.run(32 * MIN); // 23:02 到达南池袋公园

    const expectedLeaveBy = jst('2026-11-19', 0, 8); // 00:20 - 7m 步行到站 - 5m 安全余量 = 00:08
    expect(nia.view().visit).toMatchObject({
      leave_by_ms: expectedLeaveBy,
      last_train_guard: true,
    });

    // 推进至 00:08 触发终电护栏返程，00:15 在池袋站踏上终电前班次，00:40 回到赤羽小屋门口结算
    t.run(jst('2026-11-19', 0, 45) - t.clock.t);
    expect(nia.describe()).toMatchObject({ state: 'settled', return_reason: 'last_train' });
    const retStarted = t.outbox(nia.visitId).find((r) => r.kind === 'return_started')!;
    expect(retStarted.occurred_at_ms).toBe(expectedLeaveBy);
    expect(retStarted.payload.reason).toBe('last_train');
    const boarded = t
      .outbox(nia.visitId)
      .filter((r) => r.kind === 'visit_progress' && r.payload.phase === 'boarded');
    expect(boarded).toHaveLength(2);
    expect(boarded[1]!.occurred_at_ms).toBe(jst('2026-11-19', 0, 15));
    expect(boarded[1]!.occurred_at_ms).toBeLessThan(jst('2026-11-19', 0, 20));
    expect(nia.release().state).toBe('closed');
    expect(runReconcile(t.c, 'm3a_guard_basic').ok).toBe(true);
  });

  it('23:30 后进城与跨午夜边界：23:35 进城六位室友全员在 00:20 前踏上归途；过晚赶不上回程终电的外区行程前置拦截', () => {
    const t = makeCity({ at: jst('2026-11-18', 23, 35), house: SIX_HOUSEMATES });
    const destinations = [
      'shinjuku:southern-terrace', // 35m -> 00:10 跨午夜抵达，00:11 触发返程，00:15 上车
      'shinjuku:station', // 31m -> 00:06 跨午夜抵达，00:15 触发返程上车
      'ikebukuro:minami-park', // 32m -> 00:07 跨午夜抵达，00:08 触发返程，00:15 上车
      'ikebukuro:station', // 25m -> 00:00 午夜整点抵达，00:15 触发返程上车
      'akabane:ekimae-conbini', // 赤羽本区纯步行 15m，不受铁道停运限制
      'akabane:ekimae-plaza', // 赤羽本区纯步行 14m
    ];
    const kernels = SIX_HOUSEMATES.map((m, idx) => {
      const k = t.kernel(m.actorId);
      const rec = k.depart({ yen: 6000, to: destinations[idx]!, returnIn: 3 * HOUR });
      expect(rec.payload.trip).not.toBeNull();
      return k;
    });

    // 推进到 00:07（跨过午夜 00:00！）：验证在南池袋公园的艾莉西亚主动步行回池袋站时，跨午夜重排仍锚定当晚 00:20 而非次日
    t.run(32 * MIN); // 00:07 JST
    const alicia = kernels[2]!;
    expect(alicia.view().location).toEqual({ place: 'ikebukuro:minami-park' });
    alicia.act({ type: 'travel', to: 'ikebukuro:station' }); // 7m -> 00:14 到站 <= 00:15
    t.run(7 * MIN); // 00:14 JST
    expect(alicia.view().location).toEqual({ place: 'ikebukuro:station' });
    expect(alicia.view().visit.leave_by_ms).toBe(jst('2026-11-19', 0, 15));

    // 推进至 00:50：外区四位室友已全部在 00:20 前上车并回到赤羽小屋 settled，无一人滞留外区
    t.run(36 * MIN); // 00:50 JST
    for (let i = 0; i < 4; i++) {
      const k = kernels[i]!;
      expect(k.describe()).toMatchObject({ state: 'settled', return_reason: 'last_train' });
      const returnBoard = t
        .outbox(k.visitId)
        .filter((r) => r.kind === 'visit_progress' && r.payload.phase === 'boarded')
        .pop()!;
      expect(returnBoard.occurred_at_ms).toBeLessThan(jst('2026-11-19', 0, 20));
      expect(k.release().state).toBe('closed');
    }

    // 赤羽本区的两位室友在 00:50 停运期尝试跨区去新宿会被 transit_closed_night 拦下，随后按原 return_by 步行归家
    rejects(
      () => kernels[4]!.act({ type: 'travel', to: 'shinjuku:station' }),
      'PRECONDITION_FAILED',
      'transit_closed_night',
    );
    t.run(2 * HOUR);
    expect(kernels[4]!.release().state).toBe('closed');
    expect(kernels[5]!.release().state).toBe('closed');

    // 23:52 过晚进城去新宿南口露台（去程 00:04 虽有车，但 00:27 才到，赶不上 00:20 回程终电）：commit 阶段 plan_blocked 留在门口
    const tLate = makeCity({ at: jst('2026-11-19', 23, 52) });
    const niaLate = tLate.kernel('nia');
    const blockedCommit = niaLate.depart({ yen: 5000, to: 'shinjuku:southern-terrace', returnIn: 2 * HOUR });
    expect(blockedCommit.payload).toMatchObject({ trip: null, plan_blocked: 'last_train_cutoff' });
    expect(niaLate.view().location).toEqual({ place: HOUSE_ENTRANCE });
    // 留在赤羽门口的室友仍可改去赤羽 24h 便利店再步行回家
    niaLate.act({ type: 'travel', to: 'akabane:ekimae-conbini' });
    tLate.run(15 * MIN);
    expect(niaLate.view().location).toEqual({ place: 'akabane:ekimae-conbini' });
    niaLate.act({ type: 'go_home' });
    tLate.run(15 * MIN);
    expect(niaLate.release().state).toBe('closed');
    expect(ledgerImbalance(t.c)).toBe(0);
    expect(ledgerImbalance(tLate.c)).toBe(0);
  });

  it('雨天改道回归：终电前外区遇雨躲进车站与跨午夜雨天关闭改道均不破坏归家闭环', () => {
    const t = makeCity({ at: jst('2026-11-18', 23, 20), house: SIX_HOUSEMATES });
    // 先写入晴天实况基准，以便后续触发真实转雨事件
    const clearReadings = (at: number): WeatherReading[] => [
      { area: 'akabane', observed_at_ms: at, code: 1, temp_c: 13, precip_mm: 0, hourly: [] },
      { area: 'ikebukuro', observed_at_ms: at, code: 1, temp_c: 13, precip_mm: 0, hourly: [] },
      { area: 'shinjuku', observed_at_ms: at, code: 1, temp_c: 13, precip_mm: 0, hourly: [] },
    ];
    t.c.commit(() => applyWeather(t.c, clearReadings(t.clock.t), t.clock.t));

    const nia = t.kernel('nia');
    const claire = t.kernel('claire');
    nia.depart({ yen: 5000, to: 'shinjuku:southern-terrace', returnIn: 3 * HOUR }); // 35m -> 23:55 到达新宿露台
    claire.depart({ yen: 5000, to: 'ikebukuro:station', returnIn: 3 * HOUR }); // 25m -> 23:45 到达池袋站
    t.run(35 * MIN); // 23:55 JST

    // 23:55 克蕾雅从池袋站前往赤羽荒川河岸（13m 电车 23:55->00:08 到赤羽站 + 18m 步行 00:08->00:26）
    claire.act({ type: 'travel', to: 'akabane:arakawa-riverbank' });

    // 23:58 新宿与赤羽同时转雨：妮娅在露天步道收到 rain 唤醒；克蕾雅在途，荒川河岸雨天关闭
    t.run(3 * MIN); // 23:58 JST
    t.c.commit(() =>
      applyWeather(
        t.c,
        [
          { area: 'akabane', observed_at_ms: t.clock.t, code: 61, temp_c: 11.5, precip_mm: 2.2, hourly: [] },
          { area: 'ikebukuro', observed_at_ms: t.clock.t, code: 1, temp_c: 12.5, precip_mm: 0, hourly: [] },
          { area: 'shinjuku', observed_at_ms: t.clock.t, code: 61, temp_c: 11.8, precip_mm: 1.9, hourly: [] },
        ],
        t.clock.t,
      ),
    );
    expect(nia.records('decision_wake').some((w) => w.reason === 'rain' && w.area === 'shinjuku')).toBe(true);

    // 23:58 妮娅若想跨区改道去南池袋公园（4+10+7=21m -> 00:19 > 00:08）被终电护栏拦截；改去室内新宿站（4m -> 00:02 <= 00:15）放行
    rejects(
      () => nia.act({ type: 'travel', to: 'ikebukuro:minami-park' }),
      'PRECONDITION_FAILED',
      'last_train_cutoff',
    );
    nia.act({ type: 'travel', to: 'shinjuku:station' });
    t.run(4 * MIN); // 00:02 JST
    expect(nia.view().location).toEqual({ place: 'shinjuku:station' });
    expect(nia.view().visit.leave_by_ms).toBe(jst('2026-11-19', 0, 15));

    // 推进至 00:26：克蕾雅因雨天被改道留在赤羽站（diverted / place_closed_rain）；妮娅已在 00:15 乘上终电回程
    t.run(24 * MIN); // 00:26 JST
    expect(claire.view().location).toEqual({ place: 'akabane:station' });
    expect(claire.records('decision_wake')).toContainEqual(
      expect.objectContaining({ reason: 'diverted', why: 'place_closed_rain', place: 'akabane:station' }),
    );

    // 继续推进至原访问结束：两人均正常回到小屋门口结算关闭，零滞留、零坏账
    t.run(2 * HOUR + 30 * MIN);
    expect(nia.describe()).toMatchObject({ state: 'settled', return_reason: 'last_train' });
    expect(claire.describe().state).toBe('settled');
    expect(nia.release().state).toBe('closed');
    expect(claire.release().state).toBe('closed');
    expect(runReconcile(t.c, 'm3a_rain_diversion').ok).toBe(true);
    expect(ledgerImbalance(t.c)).toBe(0);
  });
});

describe('M3-A 3：同车厢短暂同行只读切片（匿名计数、隐私隔离、selfView <= 4KB）', () => {
  it('仅统计同线路同方向重叠时间窗内的在城乘车人数，绝不暴露他人身份/姓名/上下车站且字节数 <= 4KB', () => {
    const t = makeCity({ at: jst('2026-11-18', 17, 40) });
    const sameDirBot = t.bot('同向神秘乘客葵', { entry: 'ikebukuro:station' });
    const offlineBot = t.bot('中途下线客', { entry: 'ikebukuro:station' });
    sameDirBot.act({ type: 'travel', to: 'akabane:station' });
    offlineBot.act({ type: 'travel', to: 'akabane:station' });
    t.run(20 * MIN); // 18:00 JST：两人已在赤羽站就位

    const nia = t.kernel('nia');
    const claire = t.kernel('claire');
    const oppDirBot = t.bot('反向乘客凛', { entry: 'shinjuku:station' });
    const otherLineBot = t.bot('山手线乘客莲', { entry: 'ikebukuro:station' });

    // 妮娅与克蕾雅先从赤羽小屋出发去新宿不同店铺（前 12 分钟在步行段，尚未上车）
    nia.depart({ yen: 8000, to: 'shinjuku:muginohi' });
    claire.depart({ yen: 8000, to: 'shinjuku:kamitsuki' });
    expect(nia.view().location.trip.same_car_travellers).toBeUndefined();
    expect(nia.view().location.trip.car_ambiance).toBeUndefined();

    // 18:12 妮娅与克蕾雅抵达赤羽站登上埼京线（18:12 -> 18:31，akabane:station -> shinjuku:station）
    t.run(12 * MIN);
    // 18:15 同向乘客葵与中途下线客也从赤羽站登上同向埼京线；反向乘客与山手线乘客同时在跑
    t.run(3 * MIN); // 18:15 JST
    const startView = sameDirBot.act({ type: 'travel', to: 'shinjuku:southern-terrace' });
    expect(startView.trip.same_car_travellers).toBe(2); // 车上已有妮娅、克蕾雅 2 人
    offlineBot.act({ type: 'travel', to: 'shinjuku:station' });
    t.online.delete(offlineBot.id);
    leaveCity(t.c, offlineBot.id); // 已离城（in_city = 0）不计入在场同乘
    oppDirBot.act({ type: 'travel', to: 'akabane:station' }); // 同线但反向
    otherLineBot.act({ type: 'travel', to: 'shinjuku:station' }); // 同终点但属山手线

    const niaView = nia.view();
    const oppView = oppDirBot.view();
    const yamanoteView = otherLineBot.view();

    expect(niaView.location.trip).toMatchObject({
      same_car_travellers: 2, // 克蕾雅 + 同向神秘乘客葵（不含自己、不含反向、不含山手线、不含已离城）
    });
    expect(typeof niaView.location.trip.car_ambiance).toBe('string');
    expect(niaView.location.trip.car_ambiance.length).toBeGreaterThan(0);
    expect(oppView.location.trip.same_car_travellers).toBe(0);
    expect(yamanoteView.location.trip.same_car_travellers).toBe(0);

    // 严查隐私边界与不开放车厢群聊：本人视图序列化后不含任何他人的 id / 姓名 / 简介 / 他人上下车目的地，且无 say 动作
    expect(niaView.can).not.toContain('say');
    const raw = JSON.stringify(niaView);
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(4096);
    for (const forbidden of [
      t.residentOf('claire'),
      '克蕾雅',
      '安静看书',
      sameDirBot.id,
      '同向神秘乘客葵',
      oppDirBot.id,
      '反向乘客凛',
      otherLineBot.id,
      '山手线乘客莲',
      'shinjuku:kamitsuki',
      'shinjuku:southern-terrace',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe('M3-A 4：终电跨停运边界双重启对账探针（F10 持久恢复 + ledgerImbalance === 0）', () => {
  it('终电返程途中经历停运前重启 + 停运后二次重启：在途电车照常到站结算、车费零重扣、账本零差额', () => {
    const dbPath = tmpDb();
    const t1 = makeCity({ dbPath, at: jst('2026-11-18', 23, 35) });
    const k1 = t1.kernel('nia');

    // 23:35 妮娅前往新宿南口露台（00:10 抵达，00:11 触发 last_train 返程，00:15 登上回赤羽终电）
    k1.depart({ yen: 10_000, to: 'shinjuku:southern-terrace', returnIn: 3 * HOUR });
    t1.run(41 * MIN); // 00:16 JST：妮娅已在 00:15 登上回赤羽电车（预计 00:34 到赤羽站，00:46 到小屋门口）
    const b1 = t1.bot('终电旅人', { entry: 'shinjuku:station', stay: false });
    b1.act({ type: 'travel', to: 'ikebukuro:station' }); // 00:16 从新宿站登上山手线末班车（预计 00:26 到池袋站）
    expect(k1.describe()).toMatchObject({ state: 'returning', return_reason: 'last_train' });

    // ── 第 1 次停机重启：跨过 00:20 停运线，在 00:25 恢复 ──
    t1.c.close();
    t1.clock.t = jst('2026-11-19', 0, 25);
    const t2 = makeCity({ dbPath, clock: t1.clock });
    const k2 = t2.kernel('nia');
    k2.visitId = k1.visitId;
    k2.epoch = k1.epoch;
    expect(k2.describe().state).toBe('returning');
    expect(ledgerImbalance(t2.c)).toBe(0);

    // ── 第 2 次停机重启：跨过电车到站与返家结算时刻，在 00:55 恢复 ──
    t2.c.close();
    t2.clock.t = jst('2026-11-19', 0, 55);
    const t3 = makeCity({ dbPath, clock: t2.clock });
    const k3 = t3.kernel('nia');
    k3.visitId = k1.visitId;
    k3.epoch = k1.epoch;

    // 验证终电旅人已在 00:26 正常到池袋站；妮娅已在 00:46 正常到家 settled，往返车费仅各扣 1 笔（¥260 * 2）
    expect(t3.c.mustResident(b1.id).place_id).toBe('ikebukuro:station');
    expect(k3.describe()).toMatchObject({ state: 'settled', return_reason: 'last_train' });
    k3.pull();
    expect(k3.settlement!.purse_final_yen).toBe(10_000 - 260 - 260);
    const niaTripTx = t3.c.db.scalar(
      "SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'",
      k3.visitId,
    );
    expect(niaTripTx).toBe(2);

    const rel = k3.release();
    expect(rel).toMatchObject({ state: 'closed', payload: { reconcile_ok: true } });
    expect(ledgerImbalance(t3.c)).toBe(0);
    const report = runReconcile(t3.c, 'm3a_dual_restart_probe');
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    t3.c.close();
  });

  it('R262-01：终电前尚未踏上返程即停机、停运后恢复时，走无列车零扣费归家兜底（不新开停运列车、不误扣车费、不误标 last_train、不滞留）', () => {
    const dbPath = tmpDb();
    const t1 = makeCity({ dbPath, at: jst('2026-11-18', 23, 35) });
    const k1 = t1.kernel('nia');
    const localBot = t1.bot('同站夜客', { entry: 'shinjuku:station', stay: false });

    // 23:35 去新宿南口露台，11-19 00:10 到达且仍为 active（原定 00:11 自动返程）
    k1.depart({ yen: 10_000, to: 'shinjuku:southern-terrace', returnIn: 3 * HOUR });
    t1.run(35 * MIN); // 2026-11-19 00:10 JST
    expect(k1.describe()).toMatchObject({ state: 'active', location: { place: 'shinjuku:southern-terrace' } });

    // 00:10 停机至 00:25（跨过 00:11 自动返程时刻与 00:20 终电停运线）
    t1.c.close();
    t1.clock.t = jst('2026-11-19', 0, 25);
    const t2 = makeCity({ dbPath, clock: t1.clock });
    const k2 = t2.kernel('nia');
    k2.visitId = k1.visitId;
    k2.epoch = k1.epoch;

    // 同站普通 travel 在 00:25 正常返回 transit_closed_night
    rejects(
      () =>
        t2.c.commit(() =>
          // 使用外部居民在 00:25 发起跨区乘车验证停运门禁仍在生效
          t2.bot('停运验证客', { entry: 'shinjuku:station' }).act({ type: 'travel', to: 'ikebukuro:station' }),
        ),
      'PRECONDITION_FAILED',
      'transit_closed_night',
    );
    expect(t2.c.mustResident(localBot.id).place_id).toBe('shinjuku:station');

    // 室友未滞留外区，已安全兜底归家进入 settled，且明确区分 return_reason 为 missed_last_train（非 last_train）
    const desc = k2.describe();
    expect(desc.state).toBe('settled');
    expect(desc.return_reason).toBe('missed_last_train');

    // 严查未凭空新增任何停运期回程列车或 00:20 后的 boarded 记录
    const returnTrips = t2.c.db.scalar(
      "SELECT COUNT(*) FROM trips WHERE visit_id = ? AND purpose = 'return'",
      k2.visitId,
    );
    expect(returnTrips).toBe(0);
    const boardedRecords = t2
      .outbox(k2.visitId)
      .filter((r) => r.kind === 'visit_progress' && r.payload.phase === 'boarded');
    expect(boardedRecords).toHaveLength(1); // 仅有 23:47 去程上车那 1 次，绝无 00:29 回程上车
    expect(boardedRecords[0]!.occurred_at_ms).toBe(jst('2026-11-18', 23, 47));

    const retStarted = t2.outbox(k2.visitId).find((r) => r.kind === 'return_started')!;
    expect(retStarted.occurred_at_ms).toBe(jst('2026-11-19', 0, 25));
    expect(retStarted.payload.reason).toBe('missed_last_train');

    // 严查未误扣回程票价：全程仅去程 1 笔 ¥260 车费，回程预留的 ¥260 全额退回随身结算额
    k2.pull();
    expect(k2.settlement!.purse_final_yen).toBe(10_000 - 260);
    expect(k2.settlement!.notes?.some((n) => n.includes('错过终电'))).toBe(true);
    const fareTxCount = t2.c.db.scalar(
      "SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'",
      k2.visitId,
    );
    expect(fareTxCount).toBe(1);

    const rel = k2.release();
    expect(rel).toMatchObject({ state: 'closed', payload: { reconcile_ok: true } });
    expect(ledgerImbalance(t2.c)).toBe(0);
    const report = runReconcile(t2.c, 'm3a_missed_last_train_recovery');
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    t2.c.close();

    // 补充子场景：去程途中已被 return-request 标为 returning，但停机跨过 00:20 后在 00:25 恢复到站转回程，同样不新发停运列车、不扣回程票价
    const dbPath2 = tmpDb();
    const p1 = makeCity({ dbPath: dbPath2, at: jst('2026-11-18', 23, 40) });
    const kp1 = p1.kernel('claire');
    kp1.depart({ yen: 8_000, to: 'shinjuku:station', returnIn: 3 * HOUR }); // 12m 步行 + 19m 埼京线 -> 00:11 到新宿站
    p1.run(15 * MIN); // 23:55 在埼京线列车上
    kp1.returnRequest('bedtime'); // 标为 returning，待 00:11 到新宿站后转回程
    p1.c.close();
    p1.clock.t = jst('2026-11-19', 0, 25); // 停机跨过 00:11 到站与 00:20 停运线
    const p2 = makeCity({ dbPath: dbPath2, clock: p1.clock });
    const kp2 = p2.kernel('claire');
    kp2.visitId = kp1.visitId;
    kp2.epoch = kp1.epoch;
    expect(kp2.describe()).toMatchObject({ state: 'settled', return_reason: 'kernel:bedtime' });
    expect(p2.c.db.scalar("SELECT COUNT(*) FROM trips WHERE visit_id = ? AND purpose = 'return'", kp2.visitId)).toBe(0);
    expect(p2.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'", kp2.visitId)).toBe(1);
    kp2.pull();
    expect(kp2.settlement!.purse_final_yen).toBe(8_000 - 260);
    expect(kp2.release().state).toBe('closed');
    expect(ledgerImbalance(p2.c)).toBe(0);
    expect(runReconcile(p2.c, 'm3a_inflight_return_missed_last_train').ok).toBe(true);
    p2.c.close();
  });
});
