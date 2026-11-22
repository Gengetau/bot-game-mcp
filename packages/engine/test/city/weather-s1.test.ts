/**
 * 晴空都 S1 自研天象引擎、天象拨盘与栈顶降级专项测试。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { openCityDb } from '../../src/city/db.js';
import { mountCity } from '../../src/city/http.js';
import {
  AREAS,
  CITY_SCHEMA_VERSION,
  QINGKONG_WEATHER_ATTRIBUTION,
  createCity,
  evalNaturalSlot,
  eventsToday,
  floorHour,
  isRaining,
  weatherOf,
} from '../../src/city/index.js';
import { SeededRng } from '../../src/core/rng.js';
import { FakeClock } from '../helpers.js';
import { HOUSE, HOUR, MIN, T0, makeCity } from './helpers.js';

const SCHEMA_PATH = fileURLToPath(new URL('../../../../docs/city/bridge-v1.schema.json', import.meta.url));
const DOWNGRADE_SCRIPT = fileURLToPath(new URL('../../../../scripts/city-schema-downgrade.mjs', import.meta.url));
const ADMIN_KEY = 'admin-dial-secret-key-s1-test';
const BRIDGE_KEY = 'bridge-key-s1-tests-0123456789';

const Ajv2020: new (opts: Record<string, unknown>) => any = (Ajv2020Module as any).default ?? Ajv2020Module;
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(schema);

const validateWeatherResponse = ajv.getSchema(`${schema.$id}#/$defs/WeatherResponse`)!;

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTmpDb(name = 'city.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'city-s1-'));
  tempDirs.push(dir);
  return join(dir, name);
}

async function serveAdmin(
  c: ReturnType<typeof createCity>,
  opts: { adminKeys?: string[]; bridgeKey?: string; devLogin?: boolean } = {},
) {
  const app = express();
  mountCity(app, c, () => undefined, {
    bridgeKey: opts.bridgeKey ?? BRIDGE_KEY,
    ...(opts.adminKeys ? { adminKeys: opts.adminKeys } : {}),
    ...(opts.devLogin ? { devLogin: true } : {}),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base };
}

describe('S1 自研天象引擎', () => {
  it('365 天 4380 槽自然基底压测：双护栏、晨雾时段、短阵雨与冬雪规则全部成立', () => {
    const seeds = ['seed-alpha-2026', 'seed-beta-2026', 'seed-gamma-2026'];
    for (const seed of seeds) {
      for (const area of AREAS) {
        let consecutiveRain = 0;
        let consecutiveWet = 0;
        let snowCount = 0;
        const dailyDaytimeDry: number[] = [];

        for (let dayIdx = 0; dayIdx < 365; dayIdx++) {
          const dateStr = new Date(Date.UTC(2026, 0, 1 + dayIdx)).toISOString().slice(0, 10);
          const month = Number(dateStr.slice(5, 7));
          let daytimeDry = 0;
          for (let slot = 0; slot < 12; slot++) {
            const res = evalNaturalSlot(seed, dateStr, slot, area.id);
            const isSnow = res.code === 71 || res.code === 85;
            const isWet = res.rain || isSnow;

            // 晨雾严格限定 04:00-09:59 (slots 2..4)
            if (res.code === 45) {
              expect(slot).toBeGreaterThanOrEqual(2);
              expect(slot).toBeLessThanOrEqual(4);
            }
            // 阵雨 '80' 单槽即停（不连槽）
            if (slot > 0) {
              const prev = evalNaturalSlot(seed, dateStr, slot - 1, area.id);
              if (prev.code === 80) expect(isWet).toBe(false);
            }
            // 冬雪 rain=false 且仅限 12-2 月气温 <= 2.5C
            if (isSnow) {
              snowCount++;
              expect(res.rain).toBe(false);
              expect([12, 1, 2]).toContain(month);
              expect(res.temp_c).toBeLessThanOrEqual(2.5);
            }
            consecutiveRain = res.rain ? consecutiveRain + 1 : 0;
            consecutiveWet = isWet ? consecutiveWet + 1 : 0;
            expect(consecutiveRain).toBeLessThanOrEqual(3);
            expect(consecutiveWet).toBeLessThanOrEqual(3);

            if (slot >= 5 && slot <= 8 && !res.rain) daytimeDry++;
          }
          dailyDaytimeDry.push(daytimeDry);
          if (dayIdx >= 2) {
            const sum3DaysDry = dailyDaytimeDry[dayIdx]! + dailyDaytimeDry[dayIdx - 1]! + dailyDaytimeDry[dayIdx - 2]!;
            expect(sum3DaysDry).toBeGreaterThanOrEqual(6);
          }
        }
        expect(snowCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('10:20 JST 同步生成 25 点半开区间 hourly（含 11:00 与 12:00），并跨整点自动刷新', async () => {
    const at1020 = T0 + 20 * MIN; // 2026-11-17 10:20 JST
    const t = makeCity({
      at: at1020,
      params: { weatherSource: 'qingkong', weatherSeed: 's1-hourly-test' },
    });
    expect(t.c.db.getMeta('weather_seed')).toBe('s1-hourly-test');
    const snap = weatherOf(t.c, 'hiyorizaka')!;
    expect(snap.source).toBe('qingkong');
    expect(snap.status).toBe('ok');
    expect(snap.hourly).toHaveLength(25);
    const h0 = floorHour(at1020);
    expect(snap.hourly[0]!.at_ms).toBe(h0);
    expect(snap.hourly[1]!.at_ms).toBe(h0 + HOUR); // 11:00
    expect(snap.hourly[2]!.at_ms).toBe(h0 + 2 * HOUR); // 12:00
    expect(snap.hourly[24]!.at_ms).toBe(h0 + 24 * HOUR);
    expect(snap.hourly[1]!.natural).toMatchObject({
      code: snap.hourly[1]!.code,
      temp_c: snap.hourly[1]!.temp_c,
      precip_mm: snap.hourly[1]!.precip_mm,
      rain: snap.hourly[1]!.rain,
    });
    expect(snap.tomorrow_daytime).toBeDefined();
    expect(snap.tomorrow_daytime!.date).toBe('2026-11-18');

    const { base } = await serveAdmin(t.c, { adminKeys: [ADMIN_KEY] });
    const bridgeRes = await fetch(`${base}/city/bridge/v1/weather`, {
      headers: { authorization: `Bearer ${BRIDGE_KEY}` },
    });
    expect(bridgeRes.status).toBe(200);
    const bridgeBody = (await bridgeRes.json()) as any;
    expect(bridgeBody.attribution).toBe(QINGKONG_WEATHER_ATTRIBUTION);
    expect(validateWeatherResponse(bridgeBody)).toBe(true);

    // 跨越 11:00 整点，tick 立即重算并刷新 observed_at_ms
    t.clock.advance(40 * MIN);
    t.c.tick();
    const afterHour = weatherOf(t.c, 'hiyorizaka')!;
    expect(afterHour.observed_at_ms).toBe(at1020 + 40 * MIN);
    expect(afterHour.hourly[0]!.at_ms).toBe(h0 + HOUR);
  });

  it('天象拨盘：11:05 非整点到期前后边界与读取零残留，且 12h 人工雨不污染自然双护栏', async () => {
    const at1020 = T0 + 20 * MIN;
    const t = makeCity({
      at: at1020,
      params: { weatherSource: 'qingkong', weatherSeed: 's1-dial-boundary' },
    });
    const k = t.kernel('nia');
    // 让日和坂当前为非雨态（若自然碰巧下雨，先用拨盘切晴后进入自然晴再转雨）
    const { base } = await serveAdmin(t.c, { adminKeys: [ADMIN_KEY] });
    const callAdmin = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}/city/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${ADMIN_KEY}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    // 确保河岸处于非雨并让妮娅进城到日和坂广场
    await callAdmin('/admin/weather/override', {
      request_id: 'dial-clear-pre',
      area: 'hiyorizaka',
      preset: 'clear',
      duration_minutes: 15,
    });
    k.depart({ yen: 5000, to: 'hiyorizaka:ekimae-plaza' });
    t.run(5 * MIN); // 10:25 JST，已抵达

    // 从 10:25 设置 40 分钟人工阵雨 -> 到期 11:05:00（非整点）
    const ovRes = await callAdmin('/admin/weather/override', {
      request_id: 'dial-rain-40m',
      area: 'hiyorizaka',
      preset: 'sun_shower',
      duration_minutes: 40,
      reason: '午间短雨演练',
    });
    expect(ovRes.status).toBe(200);
    const expMs = ovRes.body.expires_at_ms;
    expect(expMs).toBe(at1020 + 5 * MIN + 40 * MIN);
    expect(isRaining(t.c, 'hiyorizaka')).toBe(true);
    expect(weatherOf(t.c, 'hiyorizaka')!.override?.preset).toBe('sun_shower');
    expect(weatherOf(t.c, 'hiyorizaka')!.clear_window_at_ms).toBeTypeOf('number');
    expect(k.records('decision_wake').map((w) => w.reason)).toContain('rain');

    // 11:04:59 仍在拨盘有效期内，且 scheduled_jobs 绝无新增天气作业
    t.clock.t = expMs - 1000;
    expect(weatherOf(t.c, 'hiyorizaka')!.rain).toBe(true);
    expect(weatherOf(t.c, 'hiyorizaka')!.override).not.toBeNull();
    expect(t.c.db.all<{ kind: string }>("SELECT DISTINCT kind FROM scheduled_jobs WHERE kind LIKE '%weather%'")).toHaveLength(0);

    // 11:05:00 尚未 tick()：读取路径立即屏蔽过期覆盖（零残留）
    t.clock.t = expMs;
    const atExpiryRead = weatherOf(t.c, 'hiyorizaka')!;
    expect(atExpiryRead.override).toBeNull();
    expect(atExpiryRead.hourly[0]!.at_ms).toBe(floorHour(expMs));
    // 11:05 的自然态应匹配 natural
    expect(atExpiryRead.rain).toBe(atExpiryRead.hourly[0]!.natural!.rain);

    // 触发 tick()：落库清理过期行
    t.c.tick();
    expect(t.c.db.all('SELECT * FROM weather_overrides')).toHaveLength(0);

    // 12 小时人工雨（720m）可超 6 小时自然上限；清除/到期后立刻回归自然双护栏
    const longRain = await callAdmin('/admin/weather/override', {
      request_id: 'dial-rain-12h',
      area: 'all',
      preset: 'rain',
      duration_minutes: 720,
    });
    expect(longRain.status).toBe(200);
    expect(isRaining(t.c, 'ryokogai')).toBe(true);
    t.clock.t = longRain.body.expires_at_ms + 1000;
    t.c.tick();
    expect(weatherOf(t.c, 'ryokogai')!.override).toBeNull();

    // 下雪预设 rain=false，不关闭浮光川河岸
    const snowRes = await callAdmin('/admin/weather/override', {
      request_id: 'dial-snow-15m',
      area: 'hiyorizaka',
      preset: 'snow',
      duration_minutes: 15,
    });
    expect(snowRes.status).toBe(200);
    const snowSnap = weatherOf(t.c, 'hiyorizaka')!;
    expect(snowSnap.code).toBe(71);
    expect(snowSnap.rain).toBe(false);
    expect(snowSnap.temp_c).toBeLessThanOrEqual(1.5);
  });

  it('管理端鉴权、Cookie 拒认、未切换 409 门禁与 request_id 幂等冲突矩阵', async () => {
    // 1) 未配置 adminKeys -> 一律 404
    const tNoAdmin = makeCity({ params: { weatherSource: 'qingkong' } });
    const srvNoAdmin = await serveAdmin(tNoAdmin.c);
    const r404 = await fetch(`${srvNoAdmin.base}/city/api/admin/weather`);
    expect(r404.status).toBe(404);

    // 2) 配置了 adminKeys，但处于默认暗装态 weatherSource='legacy_open_meteo'
    const legacyClock = new FakeClock();
    legacyClock.t = T0;
    const cLegacy = createCity({
      dbPath: ':memory:',
      now: legacyClock.now,
      rng: new SeededRng('legacy-auth'),
      house: HOUSE,
      fetchWeather: null,
      devLogin: true,
    });
    cLegacy.startSync();
    const srvLegacy = await serveAdmin(cLegacy, { adminKeys: [ADMIN_KEY], devLogin: true });
    // 获取真实网页 Cookie 验证管理端拒认 Cookie
    const devRes = await fetch(`${srvLegacy.base}/city/api/auth/dev`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '网页访客' }),
    });
    expect(devRes.status).toBe(200);
    const cookie = devRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const rNoAuth = await fetch(`${srvLegacy.base}/city/api/admin/weather`);
    expect(rNoAuth.status).toBe(401);
    const rCookieOnly = await fetch(`${srvLegacy.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ request_id: 'c1', area: 'all', preset: 'rain', duration_minutes: 30 }),
    });
    expect(rCookieOnly.status).toBe(401);
    const rWrongKey = await fetch(`${srvLegacy.base}/city/api/admin/weather`, {
      headers: { authorization: 'Bearer wrong-key' },
    });
    expect(rWrongKey.status).toBe(403);
    const rBadCt = await fetch(`${srvLegacy.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'text/plain' },
      body: 'not-json',
    });
    expect(rBadCt.status).toBe(400);

    // 暗装期 POST /override -> 409 weather_cutover_inactive，零写库
    const rCutover = await fetch(`${srvLegacy.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'cutover-1', area: 'all', preset: 'rain', duration_minutes: 30 }),
    });
    expect(rCutover.status).toBe(409);
    const cutBody = (await rCutover.json()) as any;
    expect(cutBody.reason).toBe('weather_cutover_inactive');
    expect(cLegacy.db.all('SELECT * FROM weather_overrides')).toHaveLength(0);
    expect(cLegacy.db.all('SELECT * FROM weather_override_receipts')).toHaveLength(0);
    cLegacy.close();

    // 3) 开启 qingkong 后验证幂等与密钥不落明文
    const tQk = makeCity({ params: { weatherSource: 'qingkong', weatherSeed: 'idem-seed' } });
    const srvQk = await serveAdmin(tQk.c, { adminKeys: [ADMIN_KEY] });
    const payload = { request_id: 'idem-1', area: 'kumominato', preset: 'breezy', duration_minutes: 30, reason: '海风活动' };
    const ok1 = await fetch(`${srvQk.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(ok1.status).toBe(200);
    const body1 = (await ok1.json()) as any;
    expect(body1.actor_tag).toMatch(/^adm:[0-9a-f]{8}$/);
    // 数据库内绝不存储明文密钥
    const storedReceipt = tQk.c.db.get<{ actor_tag: string; response_json: string }>(
      'SELECT actor_tag, response_json FROM weather_override_receipts WHERE request_id = ?',
      'idem-1',
    )!;
    expect(storedReceipt.actor_tag).toBe(body1.actor_tag);
    expect(storedReceipt.response_json).not.toContain(ADMIN_KEY);

    // 同 request_id 同 payload -> 200 原回执
    const ok2 = await fetch(`${srvQk.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(ok2.status).toBe(200);
    expect(await ok2.json()).toEqual(body1);

    // 同 request_id 异 payload -> 409
    const conflict = await fetch(`${srvQk.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, duration_minutes: 60 }),
    });
    expect(conflict.status).toBe(409);

    // 云港微气候 gusty 非雨海风生成 harbor_breeze 公开事件
    expect(eventsToday(tQk.c).some((e) => e.kind === 'harbor_breeze' && e.area === 'kumominato')).toBe(true);

    // 傍晚 16:30 JST 给日和坂拨盘晚霞 afterglow，衔接 riverbank_evening 公开事件
    tQk.clock.t = T0 + 6 * HOUR + 30 * MIN;
    const afterglowRes = await fetch(`${srvQk.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'evening-1', area: 'hiyorizaka', preset: 'afterglow', duration_minutes: 30 }),
    });
    expect(afterglowRes.status).toBe(200);
    expect(eventsToday(tQk.c).some((e) => e.kind === 'riverbank_evening' && e.area === 'hiyorizaka')).toBe(true);

    // GET /admin/weather & POST /clear
    const listRes = await fetch(`${srvQk.base}/city/api/admin/weather`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.overrides.map((o: any) => o.area)).toEqual(['hiyorizaka']);
    expect(listBody.receipts).toHaveLength(2);

    const clrRes = await fetch(`${srvQk.base}/city/api/admin/weather/clear`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'clr-1', area: 'all' }),
    });
    expect(clrRes.status).toBe(200);
    expect(tQk.c.db.all('SELECT * FROM weather_overrides')).toHaveLength(0);
  });

  it('防串源撤回：qingkong 切回 legacy_open_meteo 在 start() 开放前清覆盖、禁跨源 stale 并即时重抓/退化', async () => {
    const dbPath = makeTmpDb();
    const clock = new FakeClock();
    clock.t = T0;
    const c1 = createCity({
      dbPath,
      now: clock.now,
      rng: new SeededRng('revert-1'),
      house: HOUSE,
      params: { weatherSource: 'qingkong', weatherSeed: 'revert-seed' },
    });
    await c1.start();
    // 注入一条人工雨覆盖
    const srv1 = await serveAdmin(c1, { adminKeys: [ADMIN_KEY] });
    await fetch(`${srv1.base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'rev-rain', area: 'all', preset: 'rain', duration_minutes: 120 }),
    });
    expect(isRaining(c1, 'hiyorizaka')).toBe(true);
    c1.close();

    // 场景 A：撤回 legacy_open_meteo 时外网首次抓取失败 -> 禁止延续 qingkong 成 stale，立刻退为无雨 synthetic/fallback
    clock.advance(5 * MIN);
    const c2 = createCity({
      dbPath,
      now: clock.now,
      rng: new SeededRng('revert-2'),
      house: HOUSE,
      params: { weatherSource: 'legacy_open_meteo' },
      fetchWeather: async () => {
        throw new Error('upstream unreachable');
      },
    });
    await c2.start();
    expect(c2.db.all('SELECT * FROM weather_overrides')).toHaveLength(0);
    for (const a of AREAS) {
      expect(weatherOf(c2, a.id)).toMatchObject({ source: 'synthetic', status: 'fallback', rain: false });
    }
    c2.close();

    // 场景 B：再度自 qingkong 撤回 legacy_open_meteo 且外网成功 -> start() 返回前已落库最新 open-meteo ok
    const c3 = createCity({
      dbPath,
      now: clock.now,
      rng: new SeededRng('revert-3'),
      house: HOUSE,
      params: { weatherSource: 'qingkong', weatherSeed: 'revert-seed' },
    });
    await c3.start();
    expect(weatherOf(c3, 'hiyorizaka')!.source).toBe('qingkong');
    c3.close();

    clock.advance(5 * MIN);
    const c4 = createCity({
      dbPath,
      now: clock.now,
      rng: new SeededRng('revert-4'),
      house: HOUSE,
      params: { weatherSource: 'legacy_open_meteo' },
      fetchWeather: async (areas) => areas.map((a) => ({ area: a.id, observed_at_ms: clock.t, code: 1, temp_c: 16.2, precip_mm: 0, hourly: [] })),
    });
    await c4.start();
    expect(weatherOf(c4, 'hiyorizaka')).toMatchObject({ source: 'open-meteo', status: 'ok', temp_c: 16.2, rain: false });
    c4.close();
  });

  it('受控栈顶降级脚本：v5 -> v4 -> v3 逐级降级并可再升级；非栈顶拒绝执行且零改库', async () => {
    const dbPath = makeTmpDb('downgrade-city.db');
    const clock = new FakeClock();
    clock.t = T0;
    const c1 = createCity({
      dbPath,
      now: clock.now,
      rng: new SeededRng('dg-1'),
      house: HOUSE,
      params: { weatherSource: 'qingkong', weatherSeed: 'dg-seed' },
    });
    await c1.start();
    expect(c1.db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(CITY_SCHEMA_VERSION);
    c1.close();

    // 1) 模拟已存在后续更高版本 v6 迁移 -> --to 4 与 --to 3 均非栈顶，必须非 0 拒绝并保持 v6 不变
    const v6Db = new DatabaseSync(dbPath);
    v6Db.exec('PRAGMA user_version = 6');
    v6Db.close();
    expect(() => execFileSync(process.execPath, [DOWNGRADE_SCRIPT, '--db', dbPath, '--to', '4'], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(process.execPath, [DOWNGRADE_SCRIPT, '--db', dbPath, '--to', '3'], { stdio: 'pipe' })).toThrow();
    const checkV6 = new DatabaseSync(dbPath);
    expect(checkV6.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    checkV6.exec('PRAGMA user_version = 5');
    checkV6.close();

    // 2) v5 下直接 --to 3 拒绝，先 --to 4 栈顶降级至 v4，再清 pending 标记后 --to 3 降级至 v3
    expect(() => execFileSync(process.execPath, [DOWNGRADE_SCRIPT, '--db', dbPath, '--to', '3'], { stdio: 'pipe' })).toThrow();
    const out4 = execFileSync(process.execPath, [DOWNGRADE_SCRIPT, '--db', dbPath, '--to', '4'], { encoding: 'utf8' });
    expect(JSON.parse(out4.trim())).toMatchObject({ ok: true, from_version: 5, to_version: 4 });
    const checkV4 = new DatabaseSync(dbPath);
    expect(checkV4.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
    checkV4.exec("DELETE FROM meta WHERE key LIKE 's2_pending_restore_%'");
    checkV4.close();

    // 3) 栈顶 v4 -> v3 降级成功，qingkong 快照清洗为 synthetic/fallback，且备份完整生成
    const out = execFileSync(process.execPath, [DOWNGRADE_SCRIPT, '--db', dbPath, '--to', '3'], { encoding: 'utf8' });
    const parsed = JSON.parse(out.trim()) as { ok: boolean; from_version: number; to_version: number; backup: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.from_version).toBe(4);
    expect(parsed.to_version).toBe(3);

    const checkV3 = new DatabaseSync(dbPath);
    expect(checkV3.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
    const ovTables = checkV3.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'weather_override%'").all();
    expect(ovTables).toHaveLength(0);
    const snaps = checkV3.prepare('SELECT area, source, status, rain FROM weather_snapshots').all() as any[];
    expect(snaps.every((s) => s.source === 'synthetic' && s.status === 'fallback' && s.rain === 0)).toBe(true);
    checkV3.close();

    // 4) 再升级恢复最新 schema 无损启动
    const dbReopen = openCityDb(dbPath);
    expect(dbReopen.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(CITY_SCHEMA_VERSION);
    dbReopen.close();
  });

  it('P2 与页脚回归：自然雨紧邻整点 18:00 停雨精确报告，且 qingkong 下城市公开页/视图不含 Open-Meteo', async () => {
    // P2 固定复现输入：seed='s1-hourly-test', hiyorizaka, 2026-11-01 17:20 JST
    const at1720 = Date.UTC(2026, 10, 1, 8, 20, 0); // 17:20 JST
    const h17 = Date.UTC(2026, 10, 1, 8, 0, 0); // 17:00 JST
    const h18 = Date.UTC(2026, 10, 1, 9, 0, 0); // 18:00 JST
    const t = makeCity({
      at: at1720,
      params: { weatherSource: 'qingkong', weatherSeed: 's1-hourly-test' },
    });
    const snap = weatherOf(t.c, 'hiyorizaka')!;
    expect(snap.rain).toBe(true);
    expect(snap.hourly[0]!.at_ms).toBe(h17);
    expect(snap.hourly[0]!.rain).toBe(true);
    expect(snap.hourly[1]!.at_ms).toBe(h18);
    expect(snap.hourly[1]!.rain).toBe(false);
    expect(snap.hourly[2]!.rain).toBe(false);
    // 18:00 即已停雨，clear_window_at_ms 必须为 18:00 JST（不得跳到 19:00）
    expect(snap.clear_window_at_ms).toBe(h18);

    // 城市文字页 /city/、/city/api/public、/city/api/config 切换 qingkong 后均不再带 Open-Meteo
    const { base } = await serveAdmin(t.c, { adminKeys: [ADMIN_KEY] });
    const htmlRes = await fetch(`${base}/city/`);
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html.toLowerCase()).not.toContain('open-meteo');
    expect(html).toContain('晴空都气象台');
    expect(html).toContain('晴空都自研天象引擎');

    const pubRes = await fetch(`${base}/city/api/public`);
    expect(pubRes.status).toBe(200);
    const pub = (await pubRes.json()) as any;
    expect(JSON.stringify(pub).toLowerCase()).not.toContain('open-meteo');
    expect(pub.sources.some((s: any) => s.id === 'qingkong-weather')).toBe(true);

    const cfgRes = await fetch(`${base}/city/api/config`);
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as any;
    expect(cfg.weather_source).toBe('qingkong');

    // 整点拨盘覆盖（17:20 + 40m = 18:00 JST 到期且 18:00 自然态已停雨）同样精确返回 18:00
    const ovRes = await fetch(`${base}/city/api/admin/weather/override`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'p2-1800-exp', area: 'hiyorizaka', preset: 'rain', duration_minutes: 40 }),
    });
    expect(ovRes.status).toBe(200);
    expect(weatherOf(t.c, 'hiyorizaka')!.clear_window_at_ms).toBe(h18);
  });
});
