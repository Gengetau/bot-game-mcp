/**
 * 地图 town-p1.0：游戏桌座位、NPC 站位锚点、版本与校验值、换版本后的位置校正、schema v5 迁移。
 *
 * town-p0.1 的地图源已经不在代码里了，所以这里按「p1.0 去掉这次的改动」重建出来做对照。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GAME_TABLES } from '../../src/world/content.js';
import { SCHEMA_VERSION } from '../../src/world/db.js';
import { activitiesAt, activityView } from '../../src/world/games.js';
import { actorOf } from '../../src/world/space.js';
import {
  compileMap,
  distance,
  findPath,
  isWalkable,
  manifestOf,
  zoneAt,
  type MapSource,
  type ObstacleSource,
  type SceneSource,
} from '../../src/world/spatial/index.js';
import { TOWN_MAP_SOURCE } from '../../src/world/spatial/town-map.js';
import { FakeClock } from '../helpers.js';
import { makeTown, tempDb, type Actor, type Town } from './helpers.js';
import { rewindSchema } from './schema-rewind.js';

/** 这次新增的、只作标记的锚点：id → 应该落在哪个区域 */
const NEW_ANCHORS: Record<string, string> = {
  'tea_house.counter.staff': 'tea_house',
  'tea_house.counter.front': 'tea_house',
  'plaza.bench1.sit': 'plaza',
  'plaza.bench2.sit': 'plaza',
  'bookshop.shelf.stand': 'bookshop',
};

const townSrc = (): SceneSource => TOWN_MAP_SOURCE.scenes.find((s) => s.id === 'town')!;

/** 把 p1.0 倒回 p0.1 的样子：桌子是 2x2 的纯障碍，没有新锚点。 */
function oldMapSource(): MapSource {
  const town = townSrc();
  const tables = town.interactables.filter((i) => i.kind === 'game_table');
  const props: ObstacleSource[] = tables.map((t) => ({ id: t.id.replace(':', '.'), kind: 'prop', h: 0.8, ...t.footprint! }));
  const scene: SceneSource = {
    ...town,
    obstacles: [...town.obstacles, ...props],
    interactables: town.interactables.filter((i) => i.kind !== 'game_table'),
    anchors: town.anchors.filter((a) => !(a.id in NEW_ANCHORS)),
  };
  return { ...TOWN_MAP_SOURCE, mapVersion: 'town-p0.1', scenes: TOWN_MAP_SOURCE.scenes.map((s) => (s.id === 'town' ? scene : s)) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('地图 town-p1.0：版本与校验值', () => {
  it('mapVersion 是 town-p1.0；换了版本校验值跟着变（内容变了变，只改版本号也变）', () => {
    expect(TOWN_MAP_SOURCE.mapVersion).toBe('town-p1.0');
    const now = compileMap(TOWN_MAP_SOURCE);
    const old = compileMap(oldMapSource());
    expect(old.mapVersion).toBe('town-p0.1');
    expect(now.checksum).not.toBe(old.checksum);
    // 内容一样、只改版本号：校验值也不同（版本号盖在校验值里）
    const renamed = compileMap({ ...TOWN_MAP_SOURCE, mapVersion: 'town-p1.0-x' });
    expect(renamed.checksum).not.toBe(now.checksum);
    // 同一份源编译两次校验值稳定
    expect(compileMap(TOWN_MAP_SOURCE).checksum).toBe(now.checksum);
  });

  it('换版本前后：每一格的可走与否、区域划分、房间（indoor / room）都一模一样', () => {
    const a = manifestOf(compileMap(oldMapSource())).grids.town!;
    const b = manifestOf(compileMap(TOWN_MAP_SOURCE)).grids.town!;
    expect(b.cols).toBe(a.cols);
    expect(b.rows).toBe(a.rows);
    expect(b.rows_ascii).toEqual(a.rows_ascii);
    expect(b.zones_ascii).toEqual(a.zones_ascii);
    expect(b.zones).toEqual(a.zones);
    // 私宅场景不动
    expect(manifestOf(compileMap(TOWN_MAP_SOURCE)).grids.home).toEqual(manifestOf(compileMap(oldMapSource())).grids.home);
    // 逐格再核一遍房间：hearing.ts 的 roomOf 只看 zone.indoor / zone.room
    const sa = compileMap(oldMapSource()).scenes.get('town')!;
    const sb = compileMap(TOWN_MAP_SOURCE).scenes.get('town')!;
    for (let r = 0; r < sb.rows; r++) {
      for (let c = 0; c < sb.cols; c++) {
        const x = sb.originX + (c + 0.5) * sb.cell;
        const z = sb.originZ + (r + 0.5) * sb.cell;
        const za = zoneAt(sa, x, z);
        const zb = zoneAt(sb, x, z);
        expect([zb.id, zb.indoor, zb.room]).toEqual([za.id, za.indoor, za.room]);
        expect(isWalkable(sb, x, z)).toBe(isWalkable(sa, x, z));
      }
    }
  });
});

describe('地图 town-p1.0：锚点与游戏桌', () => {
  const map = compileMap(TOWN_MAP_SOURCE);
  const town = map.scenes.get('town')!;

  it('新增的站位锚点都落在可走格上、在该在的区域里，彼此和主要地点之间走得通', () => {
    const ids = Object.keys(NEW_ANCHORS);
    for (const id of ids) {
      const a = town.anchors.get(id);
      expect(a, id).toBeDefined();
      expect(isWalkable(town, a!.x, a!.z), `${id} 应在可走格上`).toBe(true);
      expect(zoneAt(town, a!.x, a!.z).id, id).toBe(NEW_ANCHORS[id]);
    }
    const hubs = ['plaza', 'tea_house', 'bookshop', 'kitchen', 'garden', 'arcade', 'residential'].map((id) => town.anchors.get(id)!);
    const all = [...ids.map((id) => town.anchors.get(id)!), ...hubs];
    for (const from of all) for (const to of all) expect(findPath(town, from, to), `${from.id} → ${to.id}`).not.toBeNull();
    // 柜台前后是两个不同的位置，长椅是两个不同的位置
    expect(distance(town.anchors.get('tea_house.counter.staff')!, town.anchors.get('tea_house.counter.front')!)).toBeGreaterThan(1);
    expect(distance(town.anchors.get('plaza.bench1.sit')!, town.anchors.get('plaza.bench2.sit')!)).toBeGreaterThan(1);
  });

  it('游戏桌：地图里的 game_table 和 content.ts 的 GAME_TABLES 一一对应，占地 2x2，使用位都可走、可达、在 reach 之内', () => {
    const onMap = [...town.interactables.values()].filter((i) => i.kind === 'game_table');
    expect(onMap.map((i) => i.id).sort()).toEqual(GAME_TABLES.map((t) => t.id).sort());
    const spawn = town.anchors.get(TOWN_MAP_SOURCE.spawn.anchor)!;
    for (const t of GAME_TABLES) {
      const it = town.interactables.get(t.id)!;
      expect(it.footprint).toMatchObject({ w: 2, d: 2 });
      expect(it.name).toBe(t.label);
      expect(zoneAt(town, it.x, it.z).id).toBe(t.place);
      expect(it.useAnchors.length).toBe(4);
      const reach = it.reach ?? TOWN_MAP_SOURCE.interactDistance;
      for (const u of it.useAnchors) {
        expect(isWalkable(town, u.x, u.z)).toBe(true);
        expect(zoneAt(town, u.x, u.z).id).toBe(t.place);
        expect(distance(u, it)).toBeLessThanOrEqual(reach);
        expect(findPath(town, spawn, u)).not.toBeNull();
      }
      // 桌子本身占着的地方不能走（占地没缩小）
      expect(isWalkable(town, it.x, it.z)).toBe(false);
    }
  });

  it('从 GET /map 的清单里能看到桌子和新锚点（客户端用）', () => {
    const t = makeTown();
    const m = manifestOf(compileMap(TOWN_MAP_SOURCE));
    const src = m.source.scenes.find((s) => s.id === 'town')!;
    expect(src.interactables.filter((i) => i.kind === 'game_table').map((i) => i.id).sort()).toEqual(['arcade:table1', 'arcade:table2']);
    for (const id of Object.keys(NEW_ANCHORS)) expect(src.anchors.some((a) => a.id === id)).toBe(true);
    expect(t.w.map.mapVersion).toBe('town-p1.0');
  });
});

describe('换地图版本：位置校正（游戏桌原来是纯障碍）', () => {
  const townOf = (t: Town) => t.w.map.scenes.get('town')!;

  it('旧版本记录里站在游戏桌正中间的人，在新地图上不合法：挪到游戏馆的落脚点；站在桌边使用位的人不动', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const b = t.join('小岚');
    a.go('arcade'); // 区域标签是游戏馆：校正时挪到「所在区域」的落脚点
    b.go('arcade:table1');
    const before = b.pos();
    const table = townOf(t).interactables.get('arcade:table2')!;
    const raw = t.w.db.db;
    raw.prepare("UPDATE world_actors SET map_version = 'town-p0.1', x = ?, z = ? WHERE actor_id = ?").run(table.x, table.z, a.residentId);
    raw.prepare("UPDATE world_actors SET map_version = 'town-p0.1' WHERE actor_id = ?").run(b.residentId);
    t.restart();
    const arcade = townOf(t).anchors.get('arcade')!;
    expect(actorOf(t.w, a.residentId)).toMatchObject({ x: arcade.x, z: arcade.z, map_version: 'town-p1.0' });
    expect(a.row().location_id).toBe('arcade');
    expect(actorOf(t.w, b.residentId)).toMatchObject({ x: before.x, z: before.z, map_version: 'town-p1.0' });
    expect(b.row().location_id).toBe('arcade');
    // 被挪走的人可以正常走，也能走到桌边凑桌
    a.enter();
    a.go('arcade:table2');
    expect(a.view().here!.tables.find((x) => x.id === 'arcade:table2')!.near).toBe(true);
  });

  it('旧位置站在新增的锚点上（比如长椅坐位）：本来就合法，换版本不动', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const bench = townOf(t).anchors.get('plaza.bench1.sit')!;
    t.w.db.db.prepare("UPDATE world_actors SET map_version = 'town-p0.1', x = ?, z = ? WHERE actor_id = ?").run(bench.x, bench.z, a.residentId);
    t.restart();
    expect(actorOf(t.w, a.residentId)).toMatchObject({ x: bench.x, z: bench.z, map_version: 'town-p1.0' });
    expect(a.row().location_id).toBe('plaza');
  });
});

describe('schema v5：activities.table_id', () => {
  const columns = (t: Town) => t.w.db.all("SELECT name FROM pragma_table_info('activities')").map((r) => String(r.name));
  const hasIndex = (t: Town) => Boolean(t.w.db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'activities_table_open'"));

  /** 在游戏馆凑一桌，两个人都在桌边。返回活动编号。 */
  function lobby(t: Town, host: Actor, guest: Actor): string {
    for (const x of [host, guest]) x.go('arcade:table1');
    const p = host.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    guest.act('join_game', { activityId: p.activity.id });
    return String(p.activity.id);
  }

  for (const from of [3, 4] as const) {
    it(`v${from} → v${SCHEMA_VERSION}：补上 table_id 和部分唯一索引，旧的凑桌记录照常能读，重复启动不再迁移`, () => {
      const file = tempDb();
      cleanups.push(file.cleanup);
      const clock = new FakeClock();
      const t = makeTown({ dbPath: file.path, clock });
      const a = t.join('阿灯');
      const b = t.join('小岚', 'agent');
      const id = lobby(t, a, b);
      expect(columns(t)).toContain('table_id');
      // 倒回旧版本（table_id 这一列和索引都没了），旧的凑桌记录留在库里
      rewindSchema(t.w.db.db, from);
      expect(columns(t)).not.toContain('table_id');
      t.clock.advance(5_000);
      t.restart({ crash: true });
      expect(t.w.db.userVersion()).toBe(SCHEMA_VERSION);
      expect(columns(t)).toContain('table_id');
      expect(hasIndex(t)).toBe(true);
      expect(t.w.db.get('SELECT 1 AS x FROM sqlite_master WHERE name = ?', 'town_chat_messages')).toBeTruthy();
      // 旧记录：table_id 是 NULL，视图照常读得出来（重启时所有人都先下线，所以这条凑桌已经散了，记录还在）
      const row = t.w.db.get('SELECT * FROM activities WHERE activity_id = ?', id)!;
      expect(row.table_id).toBeNull();
      expect(row.status).toBe('aborted');
      expect(activityView(t.w, row)).toMatchObject({ id, tableId: null, game: 'number_bomb', status: 'aborted' });
      expect(activitiesAt(t.w, 'arcade')).toEqual([]);
      // 模拟「升级时还开着的旧凑桌」：没有桌子的凑桌不能加入 / 开局（没有桌子可以核对距离），要另凑一桌；NULL 记录不互相冲突、不占桌
      a.enter();
      b.enter();
      expect(a.view().here!.tables.map((x) => x.activityId)).toEqual([null, null]);
      const c = t.join('阿树');
      for (const x of [a, b, c]) x.go('arcade:table1');
      const legacy = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
      t.w.db.run('UPDATE activities SET table_id = NULL WHERE activity_id = ?', legacy);
      expect(activitiesAt(t.w, 'arcade').map((x) => x.id)).toEqual([legacy]);
      expect(activitiesAt(t.w, 'arcade')[0]!.tableId).toBeNull();
      expect(c.fail('join_game', { activityId: legacy }).reason).toBe('not_open');
      expect(a.fail('start_game', { activityId: legacy }).reason).toBe('not_open');
      a.act('leave_game_lobby', { activityId: legacy });
      expect(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', legacy)!.status).toBe('aborted');
      const fresh = c.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
      expect(t.w.db.get('SELECT table_id FROM activities WHERE activity_id = ?', fresh.activity.id)!.table_id).toBe('arcade:table1');
      // 再启动几次：不再迁移，数据不变
      for (let i = 0; i < 2; i++) {
        t.restart();
        expect(t.w.db.userVersion()).toBe(SCHEMA_VERSION);
        expect(t.w.db.get('SELECT table_id FROM activities WHERE activity_id = ?', fresh.activity.id)!.table_id).toBe('arcade:table1');
      }
      expect(t.logs.join('\n')).not.toContain('迁移失败');
    });
  }

  it('升级前已经在打的一局（旧记录没有桌子）：升级后照常打完、奖励只发一次；它不占桌，新桌可以另开', () => {
    const file = tempDb();
    cleanups.push(file.cleanup);
    const clock = new FakeClock();
    const t = makeTown({ dbPath: file.path, clock });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const id = lobby(t, a, b);
    a.act('start_game', { activityId: id });
    expect(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', id)!.status).toBe('running');
    rewindSchema(t.w.db.db, 4);
    t.clock.advance(5_000);
    t.restart({ crash: true });
    expect(t.w.db.get('SELECT status, table_id FROM activities WHERE activity_id = ?', id)).toMatchObject({ status: 'running', table_id: null });
    // 局里的视图读得出来（旧的对局记录还能读）
    expect(a.view().game).toMatchObject({ status: 'running', activityId: id });
    for (let i = 0; i < 80 && t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', id)!.status === 'running'; i++) t.advanceAlive(15_000, [a, b]);
    expect(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', id)!.status).toBe('completed');
    for (const x of [a, b]) expect(t.w.db.scalar('SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = ?', `game:${id}:${x.residentId}`)).toBe(1);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM settlements WHERE activity_id = ?', id)).toBe(1);
    // 打完留在原位，可以接着在同一张桌凑新的一桌
    const next = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    expect(t.w.db.get('SELECT table_id FROM activities WHERE activity_id = ?', next.activity.id)!.table_id).toBe('arcade:table1');
  });
});
