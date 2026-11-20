/**
 * 晴空都城市世界的入口。设计和接口契约见 docs/CITY.md，桥接协议见 docs/city/bridge-v1.schema.json。
 */
import { installActions } from './actions.js';
import { ensureSystemAccounts } from './ledger.js';
import { installReconcile } from './reconcile.js';
import { ensureHouseMembers, installResidents } from './residents.js';
import { CityService, type CityOptions } from './service.js';
import { recordCatalogActivation } from './stamps.js';
import { installTrips } from './trips.js';
import { installVisits } from './visits.js';
import { installWeather, openMeteoFetcher } from './weather.js';

/** 建一个城市世界（还没有开始恢复：调用方接着调 start() 或 startSync()）。 */
export function createCity(opts: CityOptions): CityService {
  const c = new CityService({ ...opts, fetchWeather: opts.fetchWeather === undefined ? openMeteoFetcher : opts.fetchWeather });
  try {
    // 系统账户和身份映射要先于一切：启动恢复补跑到期作业时会用到
    c.hooks.recover.push((now) => {
      ensureSystemAccounts(c);
      ensureHouseMembers(c);
      recordCatalogActivation(c, now);
    });
    installTrips(c);
    installVisits(c);
    installResidents(c);
    installActions(c);
    installWeather(c);
    installReconcile(c);
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

export * from './actions.js';
export * from './catalog.js';
export { CITY_SCHEMA_VERSION } from './db.js';
export * from './errors.js';
export * from './ledger.js';
export * from './mappings.js';
export * from './packs/index.js';
export * from './params.js';
export * from './reconcile.js';
export * from './residents.js';
export * from './service.js';
export * from './stamps.js';
export * from './trips.js';
export * from './views.js';
export * from './visits.js';
export * from './weather.js';
