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
  it('目录版本递增至 toto-p3.0，铁道边全部携带 simulated 首末班时间并通过自检', () => {
    expect(CITY_CATALOG_VERSION).toBe('toto-p3.0');
    expect(validateCatalog()).toEqual([]);
    for (const edge of TRANSIT_EDGES) {
      expect(edge.hours).toEqual({ first: '05:00', last: '00:20' });
      expect(edge.sources).toContain('sim-hours');
    }
  });

  it('00:19 末班车正常发车并在跨过 00:20 后到站落账；00:20–04:59 停运拒载，同片区步行与 24h 店照常；05:00 首班恢复', () => {
    const t = makeCity({ at: jst('2026-11-18', 0, 0) });
    const rider = t.bot('夜归客', { entry: 'ryokogai:station' });
    const nightBot = t.bot('深夜旅人', { entry: 'ryokogai:station' });
    const lateWalker = t.bot('散步客', { entry: 'kumominato:station' });
    rider.act({ type: 'travel', to: 'hiyorizaka:station' });
    nightBot.act({ type: 'travel', to: 'hiyorizaka:station' });
    lateWalker.act({ type: 'travel', to: 'kumominato:southern-terrace' });
    t.run(19 * MIN); // 00:19 JST：rider 与 nightBot 在日和坂站，lateWalker 在云港南口露台

    // 00:19 仍在运营窗内：站内直接上车出发，预计 00:38 到达云港站
    expect((publicCityView(t.c).transit as any).edges.every((e: any) => e.open === true)).toBe(true);
    const accepted = rider.act({ type: 'travel', to: 'kumominato:station' });
    expect(accepted.trip).toMatchObject({
      from: 'hiyorizaka:station',
      to: 'kumominato:station',
      fare_yen: 260,
      source: 'simulated',
      same_car_travellers: 0,
    });

    // 00:19 从云港南口露台去棱光街站：需先步行 4 分钟（00:23 才到站上车），前置校验按上车时刻拦截
    const blockedWalkTrain = rejects(
      () => lateWalker.act({ type: 'travel', to: 'ryokogai:station' }),
      'PRECONDITION_FAILED',
      'transit_closed_night',
    );
    expect(blockedWalkTrain.data).toMatchObject({
      from: 'kumominato:station',
      to: 'ryokogai:station',
      board_at_ms: jst('2026-11-18', 0, 23),
      hours: { first: '05:00', last: '00:20' },
      source: 'simulated',
    });

    // 推进 1 分钟至 00:20：全线进入夜间停运
    t.run(1 * MIN);
    expect((publicCityView(t.c).transit as any).edges.every((e: any) => e.open === false)).toBe(true);
    expect(routePreview(t.c, 'hiyorizaka:station', 'ryokogai:station')).toMatchObject({
      transit_open: false,
      transit_closed_reason: 'transit_closed_night',
      dest_open: true,
    });

    rejects(() => nightBot.act({ type: 'travel', to: 'ryokogai:station' }), 'PRECONDITION_FAILED', 'transit_closed_night');

    // 同街区步行、站前广场及 24h 便利店在停运期照常通行与消费
    nightBot.go('hiyorizaka:ekimae-plaza');
    expect(nightBot.view().location).toEqual({ place: 'hiyorizaka:ekimae-plaza' });
    nightBot.go('hiyorizaka:ekimae-conbini');
    expect(nightBot.view().location).toEqual({ place: 'hiyorizaka:ekimae-conbini' });
    expect(nightBot.act({ type: 'buy', sku: 'onigiri' })).toMatchObject({ status: 'completed', paid_yen: 160 });

    // 00:19 已发车的夜归客在 00:38 正常抵达云港站，不半空卡死
    t.run(18 * MIN);
    expect(rider.view().location).toEqual({ place: 'kumominato:station' });

    // 推进至 04:59 仍停运；05:00 首班车准点恢复通行
    t.run(jst('2026-11-18', 4, 59) - t.clock.t);
    rejects(() => rider.act({ type: 'travel', to: 'ryokogai:station' }), 'PRECONDITION_FAILED', 'transit_closed_night');
    // 04:56 从云港南口露台出发（先步行 4m，05:00 整点才到云港站上车）：按上车时刻 board_at_ms 判定，准予通行
    const earlyWalker = makeCity({ at: jst('2026-11-18', 4, 56) });
    const ew = earlyWalker.bot('早起行人', { entry: 'kumominato:station' });
    ew.act({ type: 'travel', to: 'kumominato:southern-terrace' });
    earlyWalker.run(4 * MIN); // 05:00 -> 回拨到 04:56 测先走后乘
    earlyWalker.clock.t = jst('2026-11-18', 4, 56);
    const walkThenFirstTrain = ew.act({ type: 'travel', to: 'ryokogai:station' });
    expect(walkThenFirstTrain.trip.legs[1]).toMatchObject({
      mode: 'train',
      depart_at_ms: jst('2026-11-18', 5, 0),
    });
    t.run(1 * MIN); // 05:00 JST
    expect((publicCityView(t.c).transit as any).edges.every((e: any) => e.open === true)).toBe(true);
    rider.go('ryokogai:station');
    expect(rider.view().location).toEqual({ place: 'ryokogai:station' });
    expect(ledgerImbalance(t.c)).toBe(0);
  });
});

describe('M3-A 2：小屋室友终电归家护栏（23:30 后进城、跨午夜边界、六室友全员不滞留、雨天改道）', () => {
  it('晚间进城且原 return_by 跨过终电时，自动返程截止点收紧至终电前安全时刻并按 last_train 归家', () => {
    const t = makeCity({ at: jst('2026-11-18', 22, 30) });
    const nia = t.kernel('nia');
    // 南棱光公园：回程步行 7m 到棱光街站 + 13m 北环快线 + 12m 步行；原 return_by 为次日 02:30
    nia.depart({ yen: 5000, to: 'ryokogai:minami-park', returnIn: 4 * HOUR });
    t.run(32 * MIN); // 23:02 到达南棱光公园

    const expectedLeaveBy = jst('2026-11-19', 0, 8); // 00:20 - 7m 步行到站 - 5m 安全余量 = 00:08
    expect(nia.view().visit).toMatchObject({
      leave_by_ms: expectedLeaveBy,
      last_train_guard: true,
    });

    // 推进至 00:08 触发终电护栏返程，00:15 在棱光街站踏上终电前班次，00:40 回到日和坂小屋门口结算
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
      'kumominato:southern-terrace', // 35m -> 00:10 跨午夜抵达，00:11 触发返程，00:15 上车
      'kumominato:station', // 31m -> 00:06 跨午夜抵达，00:15 触发返程上车
      'ryokogai:minami-park', // 32m -> 00:07 跨午夜抵达，00:08 触发返程，00:15 上车
      'ryokogai:station', // 25m -> 00:00 午夜整点抵达，00:15 触发返程上车
      'hiyorizaka:ekimae-conbini', // 日和坂本区纯步行 15m，不受铁道停运限制
      'hiyorizaka:ekimae-plaza', // 日和坂本区纯步行 14m
    ];
    const kernels = SIX_HOUSEMATES.map((m, idx) => {
      const k = t.kernel(m.actorId);
      const rec = k.depart({ yen: 6000, to: destinations[idx]!, returnIn: 3 * HOUR });
      expect(rec.payload.trip).not.toBeNull();
      return k;
    });

    // 推进到 00:07（跨过午夜 00:00！）：验证在南棱光公园的艾莉西亚主动步行回棱光街站时，跨午夜重排仍锚定当晚 00:20 而非次日
    t.run(32 * MIN); // 00:07 JST
    const alicia = kernels[2]!;
    expect(alicia.view().location).toEqual({ place: 'ryokogai:minami-park' });
    alicia.act({ type: 'travel', to: 'ryokogai:station' }); // 7m -> 00:14 到站 <= 00:15
    t.run(7 * MIN); // 00:14 JST
    expect(alicia.view().location).toEqual({ place: 'ryokogai:station' });
    expect(alicia.view().visit.leave_by_ms).toBe(jst('2026-11-19', 0, 15));

    // 推进至 00:50：外区四位室友已全部在 00:20 前上车并回到日和坂小屋 settled，无一人滞留外区
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

    // 日和坂本区的两位室友在 00:50 停运期尝试跨区去云港会被 transit_closed_night 拦下，随后按原 return_by 步行归家
    rejects(
      () => kernels[4]!.act({ type: 'travel', to: 'kumominato:station' }),
      'PRECONDITION_FAILED',
      'transit_closed_night',
    );
    t.run(2 * HOUR);
    expect(kernels[4]!.release().state).toBe('closed');
    expect(kernels[5]!.release().state).toBe('closed');

    // 23:52 过晚进城去云港南口露台（去程 00:04 虽有车，但 00:27 才到，赶不上 00:20 回程终电）：commit 阶段 plan_blocked 留在门口
    const tLate = makeCity({ at: jst('2026-11-19', 23, 52) });
    const niaLate = tLate.kernel('nia');
    const blockedCommit = niaLate.depart({ yen: 5000, to: 'kumominato:southern-terrace', returnIn: 2 * HOUR });
    expect(blockedCommit.payload).toMatchObject({ trip: null, plan_blocked: 'last_train_cutoff' });
    expect(niaLate.view().location).toEqual({ place: HOUSE_ENTRANCE });
    // 留在日和坂门口的室友仍可改去日和坂 24h 便利店再步行回家
    niaLate.act({ type: 'travel', to: 'hiyorizaka:ekimae-conbini' });
    tLate.run(15 * MIN);
    expect(niaLate.view().location).toEqual({ place: 'hiyorizaka:ekimae-conbini' });
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
      { area: 'hiyorizaka', observed_at_ms: at, code: 1, temp_c: 13, precip_mm: 0, hourly: [] },
      { area: 'ryokogai', observed_at_ms: at, code: 1, temp_c: 13, precip_mm: 0, hourly: [] },
      { area: 'kumominato', observed_at_ms: at, code: 1, temp_c: 13, precip_mm: 0, hourly: [] },
    ];
    t.c.commit(() => applyWeather(t.c, clearReadings(t.clock.t), t.clock.t));

    const nia = t.kernel('nia');
    const claire = t.kernel('claire');
    nia.depart({ yen: 5000, to: 'kumominato:southern-terrace', returnIn: 3 * HOUR }); // 35m -> 23:55 到达云港露台
    claire.depart({ yen: 5000, to: 'ryokogai:station', returnIn: 3 * HOUR }); // 25m -> 23:45 到达棱光街站
    t.run(35 * MIN); // 23:55 JST

    // 23:55 克蕾雅从棱光街站前往日和坂浮光川河岸（13m 电车 23:55->00:08 到日和坂站 + 18m 步行 00:08->00:26）
    claire.act({ type: 'travel', to: 'hiyorizaka:mio-riverbank' });

    // 23:58 云港与日和坂同时转雨：妮娅在露天步道收到 rain 唤醒；克蕾雅在途，浮光川河岸雨天关闭
    t.run(3 * MIN); // 23:58 JST
    t.c.commit(() =>
      applyWeather(
        t.c,
        [
          { area: 'hiyorizaka', observed_at_ms: t.clock.t, code: 61, temp_c: 11.5, precip_mm: 2.2, hourly: [] },
          { area: 'ryokogai', observed_at_ms: t.clock.t, code: 1, temp_c: 12.5, precip_mm: 0, hourly: [] },
          { area: 'kumominato', observed_at_ms: t.clock.t, code: 61, temp_c: 11.8, precip_mm: 1.9, hourly: [] },
        ],
        t.clock.t,
      ),
    );
    expect(nia.records('decision_wake').some((w) => w.reason === 'rain' && w.area === 'kumominato')).toBe(true);

    // 23:58 妮娅若想跨区改道去南棱光公园（4+10+7=21m -> 00:19 > 00:08）被终电护栏拦截；改去室内云港站（4m -> 00:02 <= 00:15）放行
    rejects(
      () => nia.act({ type: 'travel', to: 'ryokogai:minami-park' }),
      'PRECONDITION_FAILED',
      'last_train_cutoff',
    );
    nia.act({ type: 'travel', to: 'kumominato:station' });
    t.run(4 * MIN); // 00:02 JST
    expect(nia.view().location).toEqual({ place: 'kumominato:station' });
    expect(nia.view().visit.leave_by_ms).toBe(jst('2026-11-19', 0, 15));

    // 推进至 00:26：克蕾雅因雨天被改道留在日和坂站（diverted / place_closed_rain）；妮娅已在 00:15 乘上终电回程
    t.run(24 * MIN); // 00:26 JST
    expect(claire.view().location).toEqual({ place: 'hiyorizaka:station' });
    expect(claire.records('decision_wake')).toContainEqual(
      expect.objectContaining({ reason: 'diverted', why: 'place_closed_rain', place: 'hiyorizaka:station' }),
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
    const sameDirBot = t.bot('同向神秘乘客葵', { entry: 'ryokogai:station' });
    const offlineBot = t.bot('中途下线客', { entry: 'ryokogai:station' });
    sameDirBot.act({ type: 'travel', to: 'hiyorizaka:station' });
    offlineBot.act({ type: 'travel', to: 'hiyorizaka:station' });
    t.run(20 * MIN); // 18:00 JST：两人已在日和坂站就位

    const nia = t.kernel('nia');
    const claire = t.kernel('claire');
    const oppDirBot = t.bot('反向乘客凛', { entry: 'kumominato:station' });
    const otherLineBot = t.bot('晴环线乘客莲', { entry: 'ryokogai:station' });

    // 妮娅与克蕾雅先从日和坂小屋出发去云港不同店铺（前 12 分钟在步行段，尚未上车）
    nia.depart({ yen: 8000, to: 'kumominato:muginohi' });
    claire.depart({ yen: 8000, to: 'kumominato:kamitsuki' });
    expect(nia.view().location.trip.same_car_travellers).toBeUndefined();
    expect(nia.view().location.trip.car_ambiance).toBeUndefined();

    // 18:12 妮娅与克蕾雅抵达日和坂站登上北环快线（18:12 -> 18:31，hiyorizaka:station -> kumominato:station）
    t.run(12 * MIN);
    // 18:15 同向乘客葵与中途下线客也从日和坂站登上同向北环快线；反向乘客与晴环线乘客同时在跑
    t.run(3 * MIN); // 18:15 JST
    const startView = sameDirBot.act({ type: 'travel', to: 'kumominato:southern-terrace' });
    expect(startView.trip.same_car_travellers).toBe(2); // 车上已有妮娅、克蕾雅 2 人
    offlineBot.act({ type: 'travel', to: 'kumominato:station' });
    t.online.delete(offlineBot.id);
    leaveCity(t.c, offlineBot.id); // 已离城（in_city = 0）不计入在场同乘
    oppDirBot.act({ type: 'travel', to: 'hiyorizaka:station' }); // 同线但反向
    otherLineBot.act({ type: 'travel', to: 'kumominato:station' }); // 同终点但属晴环线

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
      '晴环线乘客莲',
      'kumominato:kamitsuki',
      'kumominato:southern-terrace',
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

    // 23:35 妮娅前往云港南口露台（00:10 抵达，00:11 触发 last_train 返程，00:15 登上回日和坂终电）
    k1.depart({ yen: 10_000, to: 'kumominato:southern-terrace', returnIn: 3 * HOUR });
    t1.run(41 * MIN); // 00:16 JST：妮娅已在 00:15 登上回日和坂电车（预计 00:34 到日和坂站，00:46 到小屋门口）
    const b1 = t1.bot('终电旅人', { entry: 'kumominato:station', stay: false });
    b1.act({ type: 'travel', to: 'ryokogai:station' }); // 00:16 从云港站登上晴环线末班车（预计 00:26 到棱光街站）
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

    // 验证终电旅人已在 00:26 正常到棱光街站；妮娅已在 00:46 正常到家 settled，往返车费仅各扣 1 笔（¥260 * 2）
    expect(t3.c.mustResident(b1.id).place_id).toBe('ryokogai:station');
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
    const localBot = t1.bot('同站夜客', { entry: 'kumominato:station', stay: false });

    // 23:35 去云港南口露台，11-19 00:10 到达且仍为 active（原定 00:11 自动返程）
    k1.depart({ yen: 10_000, to: 'kumominato:southern-terrace', returnIn: 3 * HOUR });
    t1.run(35 * MIN); // 2026-11-19 00:10 JST
    expect(k1.describe()).toMatchObject({ state: 'active', location: { place: 'kumominato:southern-terrace' } });

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
          t2.bot('停运验证客', { entry: 'kumominato:station' }).act({ type: 'travel', to: 'ryokogai:station' }),
        ),
      'PRECONDITION_FAILED',
      'transit_closed_night',
    );
    expect(t2.c.mustResident(localBot.id).place_id).toBe('kumominato:station');

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
    kp1.depart({ yen: 8_000, to: 'kumominato:station', returnIn: 3 * HOUR }); // 12m 步行 + 19m 北环快线 -> 00:11 到云港站
    p1.run(15 * MIN); // 23:55 在北环快线列车上
    kp1.returnRequest('bedtime'); // 标为 returning，待 00:11 到云港站后转回程
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

  it('R262-01b：返程或市内出行在步行前往车站途中（尚未上车）停机并跨过终电恢复时，不补记幽灵上车、不误扣模拟票价且零滞留归家', () => {
    // ── 子场景 1（复现返程步行断点）：00:11 开始步行返程 -> 00:12 停机（尚未上 00:15 终电）-> 00:25 恢复 ──
    const dbPath1 = tmpDb();
    const t1 = makeCity({ dbPath: dbPath1, at: jst('2026-11-18', 23, 35) });
    const k1 = t1.kernel('nia');
    k1.depart({ yen: 10_000, to: 'kumominato:southern-terrace', returnIn: 3 * HOUR });
    t1.run(37 * MIN); // 2026-11-19 00:12 JST：00:11 已触发返程步行，正在走往云港站途中（leg_index=0）
    expect(k1.describe()).toMatchObject({ state: 'returning', return_reason: 'last_train' });
    expect(
      t1.c.db.get<{ leg_index: number; status: string }>(
        "SELECT leg_index, status FROM trips WHERE visit_id = ? AND purpose = 'return'",
        k1.visitId,
      ),
    ).toEqual({ leg_index: 0, status: 'running' });
    expect(
      t1.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'", k1.visitId),
    ).toBe(1);

    // 00:12 停机至 00:25（跨过 00:15 计划上车时刻与 00:20 终电停运线）
    t1.c.close();
    t1.clock.t = jst('2026-11-19', 0, 25);
    const t2 = makeCity({ dbPath: dbPath1, clock: t1.clock });
    const k2 = t2.kernel('nia');
    k2.visitId = k1.visitId;
    k2.epoch = k1.epoch;

    expect(k2.describe()).toMatchObject({ state: 'settled', return_reason: 'missed_last_train' });
    expect(
      t2.c.db.get<{ leg_index: number; status: string; stop_reason: string }>(
        "SELECT leg_index, status, stop_reason FROM trips WHERE visit_id = ? AND purpose = 'return'",
        k2.visitId,
      ),
    ).toEqual({ leg_index: 0, status: 'stopped', stop_reason: 'missed_last_train' });

    // 绝不补记 00:15 回程 boarded，绝不误扣回程 ¥260 票价
    const boarded1 = t2
      .outbox(k2.visitId)
      .filter((r) => r.kind === 'visit_progress' && r.payload.phase === 'boarded');
    expect(boarded1).toHaveLength(1);
    expect(boarded1[0]!.occurred_at_ms).toBe(jst('2026-11-18', 23, 47));
    expect(
      t2.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'", k2.visitId),
    ).toBe(1);

    k2.pull();
    expect(k2.settlement!.purse_final_yen).toBe(10_000 - 260);
    expect(k2.settlement!.notes?.some((n) => n.includes('错过终电'))).toBe(true);
    expect(k2.release()).toMatchObject({ state: 'closed', payload: { reconcile_ok: true } });
    expect(ledgerImbalance(t2.c)).toBe(0);
    expect(runReconcile(t2.c, 'm3a_return_walk_outage_0025').ok).toBe(true);
    t2.c.close();

    // ── 子场景 2（长停机跨整夜边界）：00:12 返程步行中停机，直至清晨 05:30 早班重开后才恢复，仍不伪造昨晚 00:15 乘车扣费 ──
    const dbPath2 = tmpDb();
    const m1 = makeCity({ dbPath: dbPath2, at: jst('2026-11-18', 23, 35), house: SIX_HOUSEMATES });
    const km1 = m1.kernel('alicia');
    km1.depart({ yen: 10_000, to: 'kumominato:southern-terrace', returnIn: 3 * HOUR });
    m1.run(37 * MIN); // 00:12 JST：返程步行段 leg_index=0
    m1.c.close();
    m1.clock.t = jst('2026-11-19', 5, 30);
    const m2 = makeCity({ dbPath: dbPath2, clock: m1.clock, house: SIX_HOUSEMATES });
    const km2 = m2.kernel('alicia');
    km2.visitId = km1.visitId;
    km2.epoch = km1.epoch;
    expect(km2.describe()).toMatchObject({ state: 'settled', return_reason: 'missed_last_train' });
    expect(
      m2.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'", km2.visitId),
    ).toBe(1);
    km2.pull();
    expect(km2.settlement!.purse_final_yen).toBe(10_000 - 260);
    expect(km2.release().state).toBe('closed');
    expect(ledgerImbalance(m2.c)).toBe(0);
    expect(runReconcile(m2.c, 'm3a_return_walk_outage_0530').ok).toBe(true);
    m2.c.close();

    // ── 子场景 3（active 市内步行去车站途中停机跨过终电）：23:50 从露台去棱光街站，23:51 停机，00:25 恢复 ──
    const dbPath3 = tmpDb();
    const a1 = makeCity({ dbPath: dbPath3, at: jst('2026-11-18', 23, 15), house: SIX_HOUSEMATES });
    const ka1 = a1.kernel('grok');
    ka1.depart({ yen: 10_000, to: 'kumominato:southern-terrace', returnIn: 3 * HOUR });
    a1.run(35 * MIN); // 23:50 JST 到达露台
    ka1.act({ type: 'travel', to: 'ryokogai:station' }); // 23:50->23:54 步行到云港站，原定 23:54 乘晴环线
    a1.run(1 * MIN); // 23:51 JST 仍在步行去云港站途中（尚未上晴环线）
    a1.c.close();
    a1.clock.t = jst('2026-11-19', 0, 25);
    const a2 = makeCity({ dbPath: dbPath3, clock: a1.clock, house: SIX_HOUSEMATES });
    const ka2 = a2.kernel('grok');
    ka2.visitId = ka1.visitId;
    ka2.epoch = ka1.epoch;
    expect(ka2.describe()).toMatchObject({ state: 'settled', return_reason: 'missed_last_train' });
    expect(
      a2.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE visit_id = ? AND kind = 'fare'", ka2.visitId),
    ).toBe(1); // 仅最初去程 ¥260，未扣山手线 ¥170 也未扣回程 ¥260
    ka2.pull();
    expect(ka2.settlement!.purse_final_yen).toBe(10_000 - 260);
    expect(ka2.release().state).toBe('closed');
    expect(ledgerImbalance(a2.c)).toBe(0);
    expect(runReconcile(a2.c, 'm3a_active_walk_outage_0025').ok).toBe(true);
    a2.c.close();

    // ── 子场景 4（外部居民步行去车站途中停机跨过终电）：停在车站大厅、不补记乘车、不扣模拟车费 ──
    const dbPath4 = tmpDb();
    const e1 = makeCity({ dbPath: dbPath4, at: jst('2026-11-19', 0, 8) });
    const ext = e1.bot('夜行外客', { entry: 'kumominato:station', stay: false });
    ext.act({ type: 'travel', to: 'kumominato:southern-terrace' });
    e1.run(4 * MIN); // 00:12 JST 在云港南口露台
    const walletBefore = ext.view().wallet.yen;
    ext.act({ type: 'travel', to: 'ryokogai:station' }); // 00:12->00:16 步行到云港站，原定 00:16 乘晴环线（¥200）
    e1.run(1 * MIN); // 00:13 JST 步行途中停机
    e1.c.close();
    e1.clock.t = jst('2026-11-19', 0, 25);
    const e2 = makeCity({ dbPath: dbPath4, clock: e1.clock });
    expect(e2.c.mustResident(ext.id).place_id).toBe('kumominato:station');
    expect(
      e2.c.db.get<{ leg_index: number; status: string; stop_reason: string }>(
        "SELECT leg_index, status, stop_reason FROM trips WHERE resident_id = ? ORDER BY rowid DESC LIMIT 1",
        ext.id,
      ),
    ).toEqual({ leg_index: 0, status: 'stopped', stop_reason: 'transit_closed_night' });
    expect(
      e2.c.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'fare'"),
    ).toBe(0);
    expect(e2.c.db.get<{ balance: number }>('SELECT balance FROM accounts WHERE resident_id = ?', ext.id)?.balance).toBe(walletBefore);
    expect(ledgerImbalance(e2.c)).toBe(0);
    e2.c.close();

    // ── 子场景 5（清晨早起室友步行赶首班车）：04:50 出门步行 12m 接 05:02 首班车去棱光街站，不误判昨晚 00:20 终电截止 ──
    const dawn = makeCity({ at: jst('2026-11-19', 4, 50), house: SIX_HOUSEMATES });
    const kd = dawn.kernel('xingli');
    const dawnDep = kd.depart({ yen: 6_000, to: 'ryokogai:station', returnIn: 3 * HOUR }); // return_by = 07:50
    expect(dawnDep.payload.plan_blocked).toBeUndefined();
    expect(dawnDep.payload.trip).not.toBeNull();
    dawn.run(5 * MIN); // 04:55 JST 仍在步行去日和坂站途中，不应被误判错过昨晚终电而提前拉回家
    expect(kd.describe().state).toBe('active');
    expect(kd.view().visit.leave_by_ms).toBe(jst('2026-11-19', 7, 20)); // 07:50 - 25m 回程 - 5m 余量
    dawn.run(20 * MIN); // 05:15 JST 正常搭首班车抵达棱光街站
    expect(kd.view().location).toEqual({ place: 'ryokogai:station' });
    dawn.run(3 * HOUR);
    expect(kd.describe()).toMatchObject({ state: 'settled', return_reason: 'return_by' });
    expect(kd.release().state).toBe('closed');
    expect(ledgerImbalance(dawn.c)).toBe(0);
  });
});
