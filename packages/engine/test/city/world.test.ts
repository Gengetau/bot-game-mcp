/**
 * 城市本身：外部 bot 的进出与在场、地点的营业与容量、行程、天气和它驱动的两个事件、视图不泄露。
 */
import { describe, expect, it } from 'vitest';
import {
  AREAS,
  HOUSE_ENTRANCE,
  PLACES,
  allWeather,
  applyWeather,
  cityDirectory,
  enterCity,
  ensureHouseMembers,
  eventsToday,
  isRaining,
  leaveCity,
  parseOpenMeteo,
  planRoute,
  publicCityView,
  refreshWeather,
  validateCatalog,
  weatherOf,
  type HouseMemberConfig,
  type WeatherReading,
} from '../../src/city/index.js';
import { HOUR, HOUSE, KISSA, MIN, T0, makeCity, rejects, type CityTest } from './helpers.js';

const reading = (area: string, code: number, precip = 0, at = T0): WeatherReading => ({ area: area as WeatherReading['area'], observed_at_ms: at, code, temp_c: 14.5, precip_mm: precip, hourly: [] });
const setWeather = (t: CityTest, codes: Record<string, number>): void => {
  t.c.commit(() => applyWeather(t.c, AREAS.map((a) => reading(a.id, codes[a.id] ?? 1, (codes[a.id] ?? 1) >= 51 ? 1.2 : 0, t.clock.t)), t.clock.t));
};

describe('目录', () => {
  it('自检通过；每个地点都回得了小屋门口；票价和耗时标注为模拟', () => {
    expect(validateCatalog()).toEqual([]);
    expect(planRoute(HOUSE_ENTRANCE, KISSA)).toMatchObject({ minutes: 31, fareYen: 200 });
    expect(planRoute(HOUSE_ENTRANCE, 'kumominato:muginohi')).toMatchObject({ minutes: 36, fareYen: 260 });
    expect(planRoute(KISSA, 'kumominato:station')).toMatchObject({ minutes: 16, fareYen: 200 });
    // 小屋和河岸之间有近路，不用绕回站前
    expect(planRoute(HOUSE_ENTRANCE, 'hiyorizaka:mio-riverbank')).toMatchObject({ minutes: 9, fareYen: 0 });
    // 日和坂开放站前和浮光川河岸
    expect(PLACES.filter((p) => p.area === 'hiyorizaka' && !p.hidden).map((p) => p.id)).toEqual(['hiyorizaka:station', 'hiyorizaka:ekimae-plaza', 'hiyorizaka:ekimae-conbini', 'hiyorizaka:mio-riverbank']);
    const v: any = publicCityView(makeCity().c);
    expect(v.transit).toMatchObject({ source: 'simulated' });
  });
});

describe('外部 bot', () => {
  it('第一次进城落在入口车站、得到启动资金；再进只是回来', () => {
    const t = makeCity();
    const b = t.bot('小B');
    expect(b.view()).toMatchObject({ me: { name: '小B', origin: 'external', in_city: true }, location: { place: 'kumominato:station' }, wallet: { yen: 200_000, spendable_yen: 200_000 } });
    expect(b.view().wallet.return_reserve_yen).toBeUndefined();
    const c = t.bot('小C', { entry: 'ryokogai:station' });
    expect(c.view().location).toEqual({ place: 'ryokogai:station' });
    rejects(() => t.bot('小D', { entry: 'hiyorizaka:station' }), 'BAD_REQUEST', 'bad_entry');
    rejects(() => t.bot('小B', { id: '9099' }), 'PRECONDITION_FAILED', 'name_taken');
    // 和室友重名也不行
    rejects(() => t.bot('妮娅', { id: '9098' }), 'PRECONDITION_FAILED', 'name_taken');
    // 钱只进不出地发一次
    b.go('kumominato:muginohi');
    b.act({ type: 'buy', sku: 'melon_pan', qty: 2 });
    leaveCity(t.c, b.id);
    expect(b.view().me.in_city).toBe(false);
    const again = enterCity(t.c, t.c.db.get<any>('SELECT * FROM principals WHERE principal_id = ?', b.principalId));
    expect(again).toMatchObject({ created: false, granted_yen: 0 });
    // 回来还在原来的地方，东西和钱都在
    expect(b.view()).toMatchObject({ location: { place: 'kumominato:muginohi' }, wallet: { yen: 200_000 - 460 } });
    expect(b.view().items).toEqual([expect.objectContaining({ type: 'melon_pan', qty: 2, edible: true })]);
  });

  it('在场靠租约：十分钟没有任何调用就算离开，别人看不到、听不到', () => {
    const t = makeCity();
    const a = t.bot('甲');
    const b = t.bot('乙', { stay: false });
    expect(a.view().here.people.map((p: any) => p.name)).toEqual(['乙']);
    t.run(11 * MIN);
    expect(a.view().here.people).toEqual([]);
    expect(a.events().filter((e) => e.type === 'left').map((e) => e.data.who.name)).toEqual(['乙']);
    expect(a.act({ type: 'say', text: '有人吗' }).heard_by).toBe(0);
    rejects(() => b.act({ type: 'say', text: '我还在' }), 'PRECONDITION_FAILED', 'not_in_city');
  });

  it('说话只有同一个地点的人听得到；听众在说话那一刻定下', () => {
    const t = makeCity();
    const a = t.bot('甲');
    const b = t.bot('乙');
    const c = t.bot('丙', { entry: 'ryokogai:station' });
    expect(a.act({ type: 'say', text: '<b>你好</b>' }).heard_by).toBe(1);
    expect(b.view().here.recent_chat).toEqual([expect.objectContaining({ from: expect.objectContaining({ name: '甲' }), untrusted: true, mine: false })]);
    expect(c.view().here.recent_chat).toEqual([]);
    expect(b.events().filter((e) => e.type === 'chat')).toHaveLength(1);
    // 后来才到的人听不到之前的话
    c.go('kumominato:station');
    expect(c.view().here.recent_chat).toEqual([]);
    rejects(() => a.act({ type: 'say', text: '   ' }), 'BAD_REQUEST', 'text_empty');
    rejects(() => a.act({ type: 'say', text: '字'.repeat(301) }), 'BAD_REQUEST', 'text_too_long');
  });

  it('说得密的时候不是每一句都叫醒对方，但话都在视图里', () => {
    const t = makeCity({ params: { wakeBurst: 2, wakePerHour: 2, chatPerMinute: 100 } });
    const a = t.bot('甲');
    const b = t.bot('乙');
    for (let i = 0; i < 5; i++) a.act({ type: 'say', text: `第 ${i} 句` });
    expect(b.events().filter((e) => e.type === 'chat')).toHaveLength(2);
    expect(b.view().here.recent_chat).toHaveLength(5);
  });

  it('不营业、满了的地方去不了；路上不能做别的', () => {
    const t = makeCity({ at: T0 + 10 * HOUR + 40 * MIN }); // 20:40 JST
    const b = t.bot('小B', { entry: 'ryokogai:station' });
    // 喫茶 21:00 关门，走过去 6 分钟还来得及；书店也是
    const trip = b.act({ type: 'travel', to: KISSA });
    expect(trip.trip).toMatchObject({ minutes: 6, fare_yen: 0, source: 'simulated' });
    rejects(() => b.act({ type: 'say', text: '路上' }), 'PRECONDITION_FAILED', 'in_transit');
    rejects(() => b.act({ type: 'travel', to: 'ryokogai:station' }), 'PRECONDITION_FAILED', 'in_transit');
    t.run(6 * MIN);
    expect(b.events().filter((e) => e.type === 'you_arrived')).toHaveLength(1);
    t.run(20 * MIN); // 21:06
    rejects(() => b.act({ type: 'buy', sku: 'coffee' }), 'PRECONDITION_FAILED', 'place_closed');
    b.go('ryokogai:station');
    rejects(() => b.act({ type: 'travel', to: KISSA }), 'PRECONDITION_FAILED', 'place_closed');
    rejects(() => b.act({ type: 'travel', to: 'ryokogai:station' }), 'PRECONDITION_FAILED', 'already_here');
    rejects(() => b.act({ type: 'travel', to: 'nowhere:at-all' }), 'NOT_FOUND', 'no_such_place');
    rejects(() => b.act({ type: 'fly' }), 'BAD_REQUEST', 'unknown_action');
    rejects(() => b.act({ type: 'go_home' }), 'BAD_REQUEST', 'unknown_action');
  });

  it('到了才发现满了：留在最近的车站', () => {
    const t = makeCity({ params: { maxPresentExternal: 40 } });
    const late = t.bot('迟到', { entry: 'kumominato:station' });
    late.act({ type: 'travel', to: KISSA }); // 16 分钟
    // 它在路上的时候，喫茶坐满了（16 个位子）
    for (let i = 0; i < 16; i++) t.bot(`客${i}`, { entry: 'ryokogai:station' }).act({ type: 'travel', to: KISSA });
    t.run(16 * MIN);
    expect(late.view().location).toEqual({ place: 'ryokogai:station' });
    expect(late.events().find((e) => e.type === 'you_arrived')!.data).toMatchObject({ place: 'ryokogai:station', diverted_from: KISSA, reason: 'place_full' });
    rejects(() => late.act({ type: 'travel', to: KISSA }), 'PRECONDITION_FAILED', 'place_full');
  });

  it('吃喝、送东西', () => {
    const t = makeCity();
    const a = t.bot('甲');
    const b = t.bot('乙');
    a.go('kumominato:kamitsuki');
    a.act({ type: 'buy', sku: 'notebook' });
    rejects(() => a.act({ type: 'consume', item: 'notebook' }), 'PRECONDITION_FAILED', 'not_edible');
    rejects(() => a.act({ type: 'give', to: b.id, item: 'notebook' }), 'PRECONDITION_FAILED', 'not_here');
    rejects(() => a.act({ type: 'buy', sku: 'notebook', qty: 400 }), 'BAD_REQUEST', 'bad_quantity');
    a.go('kumominato:station');
    expect(a.act({ type: 'give', to: b.id, item_id: a.view().items[0].item_id }).status).toBe('completed');
    expect(a.view().items).toEqual([]);
    expect(b.view().items).toEqual([expect.objectContaining({ type: 'notebook', qty: 1 })]);
    rejects(() => a.act({ type: 'give', to: a.id, item: 'notebook' }), 'PRECONDITION_FAILED', 'not_here');
  });
});

describe('小屋门口不公开', () => {
  it('公开视图、外部 bot 的视图和事件、名录里都没有它；外部 bot 走不到', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const b = t.bot('小B', { entry: 'ryokogai:station' });
    b.go('hiyorizaka:station');
    k.depart({ yen: 5000, to: 'hiyorizaka:station' });
    const atDoor = JSON.stringify([publicCityView(t.c), cityDirectory(t.c), b.view()]);
    t.run(12 * MIN);
    k.act({ type: 'say', text: '你好' });
    k.act({ type: 'go_home' });
    t.run(12 * MIN);
    const leaked = [atDoor, JSON.stringify([publicCityView(t.c), cityDirectory(t.c), b.view(), b.events()])].join('\n');
    // 用 includes 而不是 toContain：失败时不把整份视图打印出来
    for (const secret of [HOUSE_ENTRANCE, 'ai-house', '小屋', 'entrance']) expect([secret, leaked.includes(secret)]).toEqual([secret, false]);
    // 她走的时候别人只知道「走了」
    expect(b.events().filter((e) => e.type === 'left').map((e) => Object.keys(e.data).sort())).toEqual([['place', 'who']]);
    // 对外部 bot 来说那个节点不存在：和乱写一个地名是同一个回答
    const e1 = rejects(() => b.act({ type: 'travel', to: HOUSE_ENTRANCE }), 'NOT_FOUND', 'no_such_place');
    const e2 = rejects(() => b.act({ type: 'travel', to: 'hiyorizaka:nothing' }), 'NOT_FOUND', 'no_such_place');
    expect(e1.message).toBe(e2.message);
    // 别人的钱和东西不在任何别人拿得到的地方
    expect(JSON.stringify(b.view().here)).not.toMatch(/wallet|yen":\s*5000|purse/);
  });

  it('她在公开地点时，别人看得到她在那里；在路上只算一个数', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 5000, to: KISSA });
    const v1: any = publicCityView(t.c);
    expect(v1.in_transit).toBe(1);
    expect(JSON.stringify(v1.areas)).not.toContain('妮娅');
    t.run(31 * MIN);
    const v2: any = publicCityView(t.c);
    expect(v2.areas.find((a: any) => a.id === 'ryokogai').places.find((p: any) => p.id === KISSA).here).toEqual([{ id: t.residentOf('nia'), name: '妮娅' }]);
  });
});

describe('小屋的室友', () => {
  it('后加进配置的室友和城里已有的居民重名：不卡住启动，先用带编号的名字', () => {
    const t = makeCity({ house: [HOUSE[0]!] });
    t.bot('克蕾雅');
    (t.c.house as HouseMemberConfig[]).push(HOUSE[1]!);
    t.c.commit(() => ensureHouseMembers(t.c));
    const claire = t.c.mustResident(t.residentOf('claire'));
    expect(claire.name).not.toBe('克蕾雅');
    expect(claire.name).toContain('claire');
    // 再跑一次是幂等的
    t.c.commit(() => ensureHouseMembers(t.c));
    expect(t.c.db.scalar("SELECT COUNT(*) FROM residents WHERE origin = 'house'")).toBe(2);
    // 她照样能出门
    const k = t.kernel('claire');
    expect(k.depart({ yen: 3000, to: 'hiyorizaka:ekimae-plaza' }).state).toBe('active');
  });

  it('留在门口时（计划去不了）：视图里说得清她能做什么', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 300, to: KISSA });
    expect(k.view().can).toEqual(['say', 'travel', 'go_home']);
  });
});

describe('天气', () => {
  it('没有抓取函数：合成天气，标 fallback，不下雨', () => {
    const t = makeCity();
    const all = allWeather(t.c);
    expect(all.map((w) => w.area)).toEqual(['hiyorizaka', 'ryokogai', 'kumominato']);
    for (const w of all) expect(w).toMatchObject({ status: 'fallback', source: 'synthetic', rain: false, precip_mm: 0 });
  });

  it('F14：抓不到时先沿用（stale），超过 3 小时退回合成天气（fallback）；内核和城市读的是同一份', async () => {
    let ok = true;
    const t = makeCity({
      fetchWeather: async (areas) => {
        if (!ok) throw new Error('network down');
        return areas.map((a) => reading(a.id, 61, 2.5, t.clock.t));
      },
    });
    await refreshWeather(t.c);
    expect(weatherOf(t.c, 'hiyorizaka')).toMatchObject({ status: 'ok', source: 'open-meteo', rain: true, code: 61, text: '下雨' });
    ok = false;
    t.clock.advance(2 * HOUR);
    await refreshWeather(t.c);
    expect(weatherOf(t.c, 'hiyorizaka')).toMatchObject({ status: 'stale', source: 'open-meteo', rain: true, observed_at_ms: T0 });
    t.clock.advance(61 * MIN);
    await refreshWeather(t.c);
    const fallback = weatherOf(t.c, 'hiyorizaka')!;
    expect(fallback).toMatchObject({ status: 'fallback', source: 'synthetic', rain: false });
    // 同一份快照：桥接的 /weather、公开页面、现场视图
    const pub: any = publicCityView(t.c);
    expect(pub.areas[0].weather).toMatchObject({ status: 'fallback', source: 'synthetic', text: fallback.text, temp_c: fallback.temp_c, observed_at_ms: fallback.observed_at_ms });
    const b = t.bot('小B');
    expect(b.view().here.weather).toMatchObject({ status: 'fallback', source: 'synthetic' });
    // 恢复之后回到 ok
    ok = true;
    await refreshWeather(t.c);
    expect(weatherOf(t.c, 'hiyorizaka')).toMatchObject({ status: 'ok', rain: true });
  });

  it('转雨：每片每天一次事件；雨天不开放的河岸不能再进，已经在里面的人不赶', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const inside = t.bot('河边', { entry: 'ryokogai:station' });
    const outside = t.bot('路人', { entry: 'ryokogai:station' });
    setWeather(t, {});
    inside.go('hiyorizaka:mio-riverbank');
    outside.go('hiyorizaka:ekimae-plaza');
    k.depart({ yen: 3000, to: 'hiyorizaka:mio-riverbank' });
    t.run(9 * MIN);
    setWeather(t, { hiyorizaka: 63 });
    expect(isRaining(t.c, 'hiyorizaka')).toBe(true);
    expect(isRaining(t.c, 'ryokogai')).toBe(false);
    expect(eventsToday(t.c).map((e) => [e.kind, e.area])).toEqual([['rain_started', 'hiyorizaka']]);
    // 露天地点里的人收到提示；室友收到一条值得她决定的唤醒
    expect(inside.events().filter((e) => e.type === 'weather')).toHaveLength(1);
    expect(outside.events().filter((e) => e.type === 'weather')).toHaveLength(1);
    expect(k.records('decision_wake').map((w) => w.reason)).toEqual(['arrived', 'rain']);
    // 河岸：已经在的人还在，新来的进不去
    expect(inside.view().location).toEqual({ place: 'hiyorizaka:mio-riverbank' });
    expect(inside.view().here.place).toMatchObject({ open: false, closed_reason: 'rain' });
    rejects(() => outside.act({ type: 'travel', to: 'hiyorizaka:mio-riverbank' }), 'PRECONDITION_FAILED', 'place_closed_rain');
    // 站前广场只是提示，照常能去
    expect(inside.view().here.exits.find((x: any) => x.id === 'hiyorizaka:ekimae-plaza')).toMatchObject({ open: true });
    // 雨停了又下：同一天不再发第二次
    setWeather(t, {});
    setWeather(t, { hiyorizaka: 61 });
    expect(eventsToday(t.c).filter((e) => e.kind === 'rain_started')).toHaveLength(1);
    expect(k.records('decision_wake').filter((w) => w.reason === 'rain')).toHaveLength(1);
    // 第二天可以再有
    t.clock.advance(24 * HOUR);
    setWeather(t, {});
    setWeather(t, { hiyorizaka: 61 });
    expect(eventsToday(t.c).map((e) => e.kind)).toEqual(['rain_started']);
  });

  it('第一次拿到实况时已经在下雨：不算「开始下雨」（上一份是合成天气，没法比较）；之后停了再下才算', () => {
    const t = makeCity();
    expect(weatherOf(t.c, 'hiyorizaka')?.status).toBe('fallback');
    setWeather(t, { hiyorizaka: 63 });
    expect(isRaining(t.c, 'hiyorizaka')).toBe(true);
    expect(eventsToday(t.c)).toEqual([]);
    // 雨天不开放的地方照样按实况关着
    const b = t.bot('路人', { entry: 'ryokogai:station' });
    b.go('hiyorizaka:station');
    rejects(() => b.act({ type: 'travel', to: 'hiyorizaka:mio-riverbank' }), 'PRECONDITION_FAILED', 'place_closed_rain');
    setWeather(t, {});
    setWeather(t, { hiyorizaka: 63 });
    expect(eventsToday(t.c).map((e) => e.kind)).toEqual(['rain_started']);
  });

  it('日和坂傍晚放晴：浮光川河岸的公开小事件，每天一次；合成天气不触发', () => {
    const t = makeCity({ at: T0 + 6 * HOUR + 30 * MIN }); // 16:30 JST
    expect(eventsToday(t.c)).toEqual([]); // 启动时只有合成天气
    setWeather(t, { hiyorizaka: 0 });
    setWeather(t, { hiyorizaka: 1 });
    const ev = eventsToday(t.c);
    expect(ev).toEqual([expect.objectContaining({ kind: 'riverbank_evening', area: 'hiyorizaka', place: 'hiyorizaka:mio-riverbank', title: '浮光川河岸的傍晚' })]);
    expect(t.c.clock(ev[0]!.ends_at_ms)).toBe('18:30');
    const pub: any = publicCityView(t.c);
    expect(pub.events_today).toHaveLength(1);
    // 阴天、下雨、别的片区、别的钟点都不触发
    const t2 = makeCity({ at: T0 + 6 * HOUR + 30 * MIN });
    setWeather(t2, { hiyorizaka: 3, ryokogai: 0 });
    expect(eventsToday(t2.c)).toEqual([]);
    const t3 = makeCity({ at: T0 });
    setWeather(t3, { hiyorizaka: 0 });
    expect(eventsToday(t3.c)).toEqual([]);
  });

  it('解析 open-meteo 的返回；坏掉的那一片跳过', () => {
    const body = [
      { current: { time: 1_790_000_000, temperature_2m: 12.3, precipitation: 0.4, rain: 0.4, weather_code: 61 }, hourly: { time: [1_790_000_000, 1_790_003_600], temperature_2m: [12.3, 12], precipitation: [0.4, 0], weather_code: [61, 3] } },
      { current: { time: 1_790_000_000, temperature_2m: 'x', weather_code: 1 } },
      { current: { time: 1_790_000_000, temperature_2m: 13, precipitation: 0, rain: 0, weather_code: 2 } },
    ];
    const out = parseOpenMeteo(AREAS, body);
    expect(out.map((r) => r.area)).toEqual(['hiyorizaka', 'kumominato']);
    expect(out[0]).toMatchObject({ observed_at_ms: 1_790_000_000_000, code: 61, temp_c: 12.3, precip_mm: 0.4 });
    expect(out[0]!.hourly).toEqual([
      { at_ms: 1_790_000_000_000, code: 61, temp_c: 12.3, precip_mm: 0.4 },
      { at_ms: 1_790_003_600_000, code: 3, temp_c: 12, precip_mm: 0 },
    ]);
    expect(parseOpenMeteo(AREAS, { error: true })).toEqual([]);
  });

  it('定时抓取：每 30 分钟一次，由 tick 触发，抓取在事务外', async () => {
    let calls = 0;
    const t = makeCity({
      fetchWeather: async (areas) => {
        calls++;
        return areas.map((a) => reading(a.id, 2, 0, t.clock.t));
      },
    });
    t.c.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    expect(weatherOf(t.c, 'kumominato')).toMatchObject({ status: 'ok', text: '多云间晴' });
    t.clock.advance(10 * MIN);
    t.c.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    t.clock.advance(21 * MIN);
    t.c.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(2);
  });
});
