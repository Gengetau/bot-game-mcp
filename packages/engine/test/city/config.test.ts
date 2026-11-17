/**
 * 配置里的 city 段：默认值、环境变量、准入名单和室友名单的校验。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { resolveCityParams } from '../../src/city/index.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const load = (cfg: unknown, env: NodeJS.ProcessEnv = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'city-cfg-'));
  dirs.push(dir);
  const file = join(dir, 'c.json');
  writeFileSync(file, JSON.stringify(cfg));
  return loadConfig(file, env);
};

const keys = { auth: { mode: 'keys', agents: [{ key: 'k'.repeat(24), id: '7001', name: '小B' }] } };
const nia = { actorId: 'nia', name: '妮娅', qqIds: ['3001'] };

describe('city 配置', () => {
  it('默认不开；数据库是独立的文件；没有桥接密钥', () => {
    const c = load({}).city;
    expect(c).toMatchObject({ enabled: false, dbFile: './data/city.db', weather: true, house: [], params: {} });
    expect(c.bridgeKey).toBeUndefined();
    expect(c.allowedAgents).toBeUndefined();
  });

  it('环境变量：开关、数据库路径、桥接密钥', () => {
    const c = load({}, { BOTGAME_CITY: '1', BOTGAME_CITY_DB: '/tmp/x/city.db', BOTGAME_CITY_BRIDGE_KEY: 'b'.repeat(32) }).city;
    expect(c).toMatchObject({ enabled: true, dbFile: '/tmp/x/city.db', bridgeKey: 'b'.repeat(32) });
  });

  it('桥接密钥太短拒绝启动', () => {
    expect(() => load({ city: { enabled: true, bridgeKey: 'short' } })).toThrow(/24/);
  });

  it('准入名单需要密钥模式；空白元素被拒；重复去重', () => {
    expect(() => load({ auth: { mode: 'open' }, city: { enabled: true, allowedAgents: ['7001'] } })).toThrow(/city\.allowedAgents.*密钥模式/);
    expect(() => load({ city: { enabled: true, allowedAgents: [] } })).toThrow(/auth\.mode/);
    expect(() => load({ ...keys, city: { enabled: true, allowedAgents: ['7001', ' '] } })).toThrow(/allowedAgents/);
    expect(load({ ...keys, city: { enabled: true, allowedAgents: [' 7001', '7001'] } }).city.allowedAgents).toEqual(['7001']);
    expect(load({ ...keys, city: { enabled: true, allowedAgents: [] } }).city.allowedAgents).toEqual([]);
  });

  it('室友名单：actorId 和 QQ 身份都不能重复', () => {
    expect(load({ city: { house: [nia] } }).city.house).toEqual([nia]);
    expect(() => load({ city: { house: [nia, { ...nia, qqIds: [] }] } })).toThrow(/actorId/);
    expect(() => load({ city: { house: [nia, { actorId: 'claire', name: '克蕾雅', qqIds: ['3001'] }] } })).toThrow(/3001/);
    expect(() => load({ city: { house: [{ ...nia, actorId: 'Nia!' }] } })).toThrow();
  });

  it('参数：入口只能是两个车站之一', () => {
    expect(resolveCityParams({}).entryPlace).toBe('shinjuku:station');
    expect(resolveCityParams({ entryPlace: 'ikebukuro:station' }).entryPlace).toBe('ikebukuro:station');
    expect(() => resolveCityParams({ entryPlace: 'akabane:station' })).toThrow();
    expect(resolveCityParams({}).backupKeep).toBe(14);
  });
});
