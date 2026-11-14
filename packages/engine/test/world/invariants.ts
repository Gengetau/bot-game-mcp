/**
 * 栖灯镇财物不变量检查（property / social / interact 测试共用，本身不含用例）。
 */
import { expect } from 'vitest';
import { MINT, SINK } from '../../src/world/property.js';
import { isWalkable, zoneAt } from '../../src/world/spatial/grid.js';
import type { Town } from './helpers.js';

/**
 * 全镇硬币与物品的结构性不变量：
 * - 复式：每笔交易分录合计为零；每个账户余额 = 分录合计；所有账户余额之和为零（mint 为负、sink 为正，居民为正）。
 * - 居民账户不为负，预留 ≤ 余额，且预留总额 = 预留表里的硬币合计。
 * - 居民持有的硬币总量 = 发行总量 − 回收总量（只有 mint/sink 能让居民总量变化）。
 * - 物品：预留数 = 预留表数量；预留的东西必有一份开着的报价或共同活动；借出的物品所有者 ≠ 持有者当且仅当有一条进行中的借条。
 */
export function checkInvariants(t: Town): void {
  checkSpaceInvariants(t);
  const db = t.w.db;
  // 每笔交易平衡
  const unbalanced = db.all('SELECT transaction_id, SUM(delta) AS s FROM ledger_entries GROUP BY transaction_id HAVING s <> 0');
  expect(unbalanced, '存在不平的交易').toEqual([]);
  // 余额 = 分录合计
  for (const a of db.all('SELECT account_id, balance, reserved, kind FROM accounts')) {
    const sum = db.scalar('SELECT COALESCE(SUM(delta),0) FROM ledger_entries WHERE account_id = ?', a.account_id);
    expect(a.balance, `账户 ${a.account_id} 余额与分录不符`).toBe(sum);
    if (a.kind === 'resident') {
      expect(a.balance).toBeGreaterThanOrEqual(0);
      expect(a.reserved).toBeLessThanOrEqual(a.balance);
      const reservedRows = db.scalar('SELECT COALESCE(SUM(coins),0) FROM resource_reservations WHERE resident_id = ?', a.account_id.replace('acct:', ''));
      expect(a.reserved, `账户 ${a.account_id} 的预留与预留表不符`).toBe(reservedRows);
    }
  }
  expect(db.scalar('SELECT COALESCE(SUM(balance),0) FROM accounts')).toBe(0);
  const residents = db.scalar("SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind = 'resident'");
  const minted = -db.scalar('SELECT balance FROM accounts WHERE account_id = ?', MINT);
  const sunk = db.scalar('SELECT balance FROM accounts WHERE account_id = ?', SINK);
  expect(residents).toBe(minted - sunk);
  // 物品预留
  for (const it of db.all('SELECT item_id, reserved, quantity, shelved FROM items')) {
    const rs = db.scalar('SELECT COALESCE(SUM(quantity),0) FROM resource_reservations WHERE item_id = ?', it.item_id);
    expect(it.reserved, `物品 ${it.item_id} 预留数与预留表不符`).toBe(rs);
    expect(it.reserved + it.shelved).toBeLessThanOrEqual(it.quantity);
  }
  // 预留必须挂在还开着的事项上
  for (const r of db.all('SELECT DISTINCT holder_kind, holder_ref FROM resource_reservations')) {
    if (r.holder_kind === 'offer') expect(db.scalar("SELECT COUNT(*) FROM offers WHERE offer_id = ? AND status = 'open'", r.holder_ref), `孤儿预留 offer:${r.holder_ref}`).toBe(1);
    if (r.holder_kind === 'interaction') expect(db.scalar("SELECT COUNT(*) FROM interactions WHERE interaction_id = ? AND status = 'open'", r.holder_ref), `孤儿预留 interaction:${r.holder_ref}`).toBe(1);
  }
  // 借出：所有者与持有者不同，当且仅当有进行中的借条
  for (const it of db.all('SELECT item_id, owner_id, holder_id FROM items WHERE owner_id <> holder_id')) {
    const loan = db.get("SELECT borrower_id FROM loans WHERE item_id = ? AND status = 'active'", it.item_id);
    expect(loan?.borrower_id, `物品 ${it.item_id} 持有者与所有者不同却没有借条`).toBe(it.holder_id);
  }
  for (const l of db.all("SELECT item_id, owner_id, borrower_id FROM loans WHERE status = 'active'")) {
    const it = db.get('SELECT owner_id, holder_id FROM items WHERE item_id = ?', l.item_id)!;
    expect(it.owner_id).toBe(l.owner_id);
    expect(it.holder_id).toBe(l.borrower_id);
  }
}


/**
 * 空间结构性不变量（在任何提交点都成立）：
 * - 每位居民恰好一条 world_actors，编号相同；
 * - 存下来的坐标落在所在场景的可走格子上（走路时存的是这一段的起点，同样可走）；
 * - 私宅里的人 location_id = home:<实例编号> 且房主存在；公共场景里「没在走」的人 location_id = 脚下的区域
 *   （走路时区域标签跟着沿路结算，存的坐标是这一段的起点，所以不比较）；
 * - 有 nav_json 的人恰好有一条 pending 的 nav_step（dedupe_key = nav:<编号>），没有的人没有；
 * - 离线的人没有 nav_json；
 * - 旧模型的残留（pending 的 move_arrive、residents.move_json）不会再出现。
 */
export function checkSpaceInvariants(t: Town): void {
  const { db, map } = t.w;
  const worldId = t.w.worldId;
  const residents = db.all('SELECT resident_id, location_id, present_since, move_json FROM residents WHERE world_id = ?', worldId);
  const actors = db.all('SELECT * FROM world_actors WHERE world_id = ?', worldId);
  expect(actors.filter((a) => a.kind === 'resident').length, '居民数与居民角色行数不符').toBe(residents.length);
  const byId = new Map(actors.map((a) => [String(a.actor_id), a]));
  for (const r of residents) {
    const id = String(r.resident_id);
    const a = byId.get(id);
    expect(a, `居民 ${id} 没有 world_actors 行`).toBeDefined();
    if (!a) continue;
    expect(a.resident_id, `角色 ${id} 的 resident_id`).toBe(id);
    const scene = map.scenes.get(String(a.scene_id));
    expect(scene, `居民 ${id} 在不存在的场景 ${a.scene_id}`).toBeDefined();
    if (!scene) continue;
    expect(isWalkable(scene, Number(a.x), Number(a.z)), `居民 ${id} 的坐标 (${a.x}, ${a.z}) 不在 ${a.scene_id} 的可走格子上`).toBe(true);
    const label = String(r.location_id);
    if (scene.instanced) {
      expect(label, `居民 ${id} 在私宅里，区域标签应为 home:<实例>`).toBe(`home:${a.instance_id}`);
      expect(db.get('SELECT 1 AS ok FROM residents WHERE resident_id = ? AND world_id = ?', String(a.instance_id), worldId), `居民 ${id} 所在私宅 ${a.instance_id} 没有房主`).toBeDefined();
    } else {
      expect(a.instance_id, `公共场景里的居民 ${id} 不该有实例编号`).toBe('');
      if (a.nav_json === null) expect(label, `居民 ${id} 站在 (${a.x}, ${a.z})，区域标签应是脚下的区域`).toBe(zoneAt(scene, Number(a.x), Number(a.z)).id);
    }
    const pendingSteps = db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND dedupe_key = ? AND status = 'pending'", `nav:${id}`);
    expect(pendingSteps, a.nav_json === null ? `居民 ${id} 没在走却有 pending 的 nav_step` : `居民 ${id} 在走，应恰好有一条 pending 的 nav_step`).toBe(a.nav_json === null ? 0 : 1);
    if (r.present_since === null) expect(a.nav_json, `离线的居民 ${id} 不该还在走`).toBeNull();
    expect(r.move_json, `居民 ${id} 的 move_json 应该是空的`).toBeNull();
  }
  expect(db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'move_arrive' AND status = 'pending'"), '不该再有 pending 的 move_arrive').toBe(0);
  expect(db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE kind = 'nav_step' AND status = 'pending'"), 'pending 的 nav_step 数与在走的人数不符').toBe(
    db.scalar("SELECT COUNT(*) FROM world_actors WHERE world_id = ? AND kind = 'resident' AND nav_json IS NOT NULL", worldId),
  );
}
