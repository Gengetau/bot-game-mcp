/**
 * 栖灯镇：公共场所的小游戏（嵌入 number_bomb / sealed_auction / liars_dice）。
 *
 * 全部走真实规则动作（world 的 propose_game / join_game / start_game / game_act / quit_game），
 * 视图与动作格式取自各游戏的 publicView / privateView / todo。
 */
import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng, type Rng } from '../../src/core/rng.js';
import type { GameRecord } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { gameViewFor, publicGameView } from '../../src/world/games.js';
import type { WorldError } from '../../src/world/errors.js';
import type { MeView } from '../../src/world/views.js';
import { FakeClock, REF, bot, startGame } from '../helpers.js';
import { isWalkable, zoneAt } from '../../src/world/spatial/index.js';
import { Actor, makeTown, tempDb, type Town } from './helpers.js';

type GameType = 'number_bomb' | 'sealed_auction' | 'liars_dice';
const GAMES: GameType[] = ['number_bomb', 'sealed_auction', 'liars_dice'];
const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const MIN = 60_000;
const TABLE1 = 'arcade:table1';
const TABLE2 = 'arcade:table2';

// ───────────────────────── 测试辅助（只在本文件里用） ─────────────────────────

/** 注册 n 位居民（真人和 AI 交替）。 */
function residents(t: Town, n: number): Actor[] {
  return Array.from({ length: n }, (_, i) => t.join(NAMES[i]!, i % 2 === 0 ? 'human' : 'agent'));
}

/** 把一批人走到某个场所（全程保持心跳）。 */
function gather(t: Town, actors: Actor[], venue: string, table: string | null = venue === 'arcade' ? TABLE1 : null): void {
  for (const a of actors) a.enter(); // 先（重新）登记在场：enter 是幂等的，掉线过的也能回来
  for (const a of actors) if (a.view().here?.space !== venue) a.go(venue);
  // 小游戏按桌入局：走到桌边才能凑桌 / 加入
  if (table) for (const a of actors) a.go(table);
  t.advanceAlive(1_000, actors);
  for (const a of actors) expect(a.view().here?.space).toBe(venue);
}

/** 在 venue 凑一桌并开局。返回活动编号。 */
function openTable(t: Town, game: GameType, actors: Actor[], venue = 'arcade'): string {
  gather(t, actors, venue);
  const [host, ...guests] = actors;
  const p = host!.act('propose_game', { game, objectId: 'arcade:table1' });
  const id = p.activity.id as string;
  for (const g of guests) g.act('join_game', { activityId: id });
  host!.act('start_game', { activityId: id });
  return id;
}

const dbRecord = (t: Town, activityId: string): GameRecord => JSON.parse(t.w.db.get('SELECT record_json FROM game_records WHERE activity_id = ?', activityId)!.record_json) as GameRecord;
const actStatus = (t: Town, activityId: string): string => String(t.w.db.get('SELECT status FROM activities WHERE activity_id = ?', activityId)!.status);
const inGame = (a: Actor, activityId: string): boolean => a.row().activity_id === activityId;

/** 一个随机的合法局内动作（只用本座位看得到的信息）。 */
function legalInput(game: GameType, g: NonNullable<MeView['game']>, rng: Rng): Record<string, unknown> {
  const pub = g.public as any;
  const you = g.you as any;
  if (game === 'number_bomb') return { action: 'guess', number: pub.range.from + rng.int(pub.range.to - pub.range.from + 1) };
  if (game === 'sealed_auction') return { action: 'bid', number: rng.int(Number(you.coins) + 1) };
  const min = pub.min_next_bid as { quantity: number; face: number } | null;
  if (min && (!pub.can_challenge || rng.int(2) === 0)) return { action: 'bid', quantity: min.quantity, face: min.face };
  return { action: 'challenge' };
}

/** 一次让轮到的人各走一步；没人轮到就让时间走一会儿（超时托管）。返回是否做了动作。 */
function stepOnce(t: Town, game: GameType, actors: Actor[], rng: Rng, opts: { only?: Actor[] } = {}): boolean {
  let acted = false;
  for (const a of opts.only ?? actors) {
    const g = a.view().game;
    if (!g || !g.your_turn || g.status !== 'running') continue;
    a.act('game_act', { phaseId: g.phase_id, input: legalInput(game, g, rng) });
    acted = true;
  }
  return acted;
}

/** 打到这一局不再进行。 */
function playOut(t: Town, game: GameType, actors: Actor[], activityId: string, rng: Rng, maxSteps = 600): void {
  for (let i = 0; i < maxSteps; i++) {
    if (actStatus(t, activityId) !== 'running') return;
    if (!stepOnce(t, game, actors, rng)) t.advanceAlive(10_000, actors);
  }
  throw new Error(`${game} 在 ${maxSteps} 步内没有结束`);
}

const sumBalances = (t: Town): number => Number(t.w.db.scalar('SELECT COALESCE(SUM(balance),0) FROM accounts WHERE kind = ?', 'resident'));
const mintedTotal = (t: Town): number => -Number(t.w.db.scalar("SELECT balance FROM accounts WHERE account_id = 'sys:mint'"));
const rewardTx = (t: Town, activityId: string) => t.w.db.all("SELECT cause_key, kind FROM ledger_transactions WHERE cause_key LIKE ?", `game:${activityId}:%`);

/** 经济不变量：双式记账总和为 0；居民持有的硬币恰好等于铸造的数量；账本原因键唯一。 */
function expectLedgerSound(t: Town): void {
  expect(Number(t.w.db.scalar('SELECT COALESCE(SUM(balance),0) FROM accounts'))).toBe(0);
  expect(sumBalances(t)).toBe(mintedTotal(t));
  const dup = t.w.db.scalar('SELECT COUNT(*) FROM (SELECT cause_key FROM ledger_transactions GROUP BY cause_key HAVING COUNT(*) > 1)');
  expect(dup).toBe(0);
}

/** 任意事件流里的所有投影文本（私有 + 公开）。 */
function allEventJson(t: Town): string[] {
  return [...t.w.db.all('SELECT projection FROM recipient_events'), ...t.w.db.all('SELECT projection FROM public_events')].map((r) => String(r.projection));
}

/** 这位居民从头开始的全部事件（Actor.events() 不带游标时只从当前水位开始，读不到历史）。 */
const eventsOf = (t: Town, a: Actor) => t.w.readResidentEvents(a.residentId, t.w.encodeCursor('r', a.residentId, 0), 1000);
const endedOf = (t: Town, a: Actor) => eventsOf(t, a).events.filter((e) => e.type === 'game_ended');
const outcomeOf = (t: Town, id: string): string => String(t.w.db.get('SELECT outcome FROM settlements WHERE activity_id = ?', id)!.outcome);
const gameRewardTotal = (t: Town): number => Number(t.w.db.scalar("SELECT COALESCE(SUM(e.delta),0) FROM ledger_entries e JOIN ledger_transactions x ON x.transaction_id = e.transaction_id WHERE x.kind = 'game_reward' AND e.delta > 0"));

const failOf = (fn: () => unknown): WorldError => {
  try {
    fn();
  } catch (e) {
    return e as WorldError;
  }
  throw new Error('本应失败，却成功了');
};

// ───────────────────────── 流程：凑桌 → 开局 → 打完 → 结算 ─────────────────────────

describe('小游戏：从凑桌到结算（真实规则动作）', () => {
  it('数字炸弹：凑桌、开局、猜数、爆炸、结算（参与奖 2、赢家再 +2）', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const coins0 = [a, b, c].map((x) => x.coins());
    const cv0 = a.view().context.version;

    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    expect(p.status).toBe('accepted');
    expect(p.activity).toMatchObject({ game: 'number_bomb', venue: 'arcade', status: 'forming', min: 2, max: 8 });
    // 同场所的其他人在视图里看得到这一桌
    expect(b.view().here!.activities.map((x) => x.id)).toEqual([p.activity.id]);
    b.act('join_game', { activityId: p.activity.id });
    c.act('join_game', { activityId: p.activity.id });
    const started = a.act('start_game', { activityId: p.activity.id });
    expect(started.gameId).toMatch(/^TG-/);

    const id = p.activity.id as string;
    for (const x of [a, b, c]) {
      expect(x.view().context.activityId).toBe(id);
      expect(x.view().here).toBeNull(); // 局中的人不属于任何场所的现场
    }
    expect(a.view().context.version).toBe(cv0 + 1);

    // 范围二分，直到有人爆炸
    const actors = [a, b, c];
    let guesses = 0;
    while (actStatus(t, id) === 'running') {
      const who = actors.find((x) => x.view().game?.your_turn)!;
      expect(who).toBeTruthy();
      const g = who.lastView.game!;
      const r = (g.public as any).range as { from: number; to: number };
      who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: Math.floor((r.from + r.to) / 2) } });
      guesses++;
      expect(guesses).toBeLessThan(40);
    }
    expect(actStatus(t, id)).toBe('completed');
    const result = JSON.parse(String(t.w.db.get('SELECT result_json FROM activities WHERE activity_id = ?', id)!.result_json));
    expect(result.outcome).toBe('completed');
    expect(result.winnerSeats.length).toBe(2); // 单局：踩雷者之外都赢

    // 回到场所，上下文再 +1，奖励：输家 2、赢家 4
    for (const [i, x] of actors.entries()) {
      expect(x.view().context.activityId).toBeNull();
      expect(x.view().context.version).toBe(cv0 + 2);
      expect(x.view().here?.space).toBe('arcade');
      const ended = endedOf(t, x);
      expect(ended).toHaveLength(1);
      const d = ended[0]!.data as any;
      expect(d).toMatchObject({ activityId: id, outcome: 'completed' });
      expect(x.coins()).toBe(coins0[i]! + (d.won ? 4 : 2));
      expect(d.reward).toBe(d.won ? 4 : 2);
    }
    expect(rewardTx(t, id)).toHaveLength(3);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM settlements WHERE activity_id = ?', id)).toBe(1);
    expectLedgerSound(t);
  });

  it('密封竞拍：3 人 4 轮密封出价，全部结算后回场所并发奖', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const coins0 = players.map((x) => x.coins());
    const id = openTable(t, 'sealed_auction', players);
    const rec0 = dbRecord(t, id);
    expect(rec0.type).toBe('sealed_auction');
    expect(rec0.players).toHaveLength(3);

    for (let round = 1; round <= 4; round++) {
      // 秘密阶段：三个人同时有待办
      for (const x of players) {
        const g = x.view().game!;
        expect(g.your_turn).toBe(true);
        expect(g.round).toBe(round);
        expect((g.todo!.actions[0] as any).action).toBe('bid');
      }
      players.forEach((x, i) => x.act('game_act', { phaseId: x.lastView.game!.phase_id, input: { action: 'bid', number: 5 + i * 3 } }));
    }
    expect(actStatus(t, id)).toBe('completed');
    const total = players.map((x, i) => x.coins() - coins0[i]!);
    // 每人至少有参与奖，赢家 +4（并列时多个赢家）
    expect(total.every((d) => d === 2 || d === 4)).toBe(true);
    expect(total.some((d) => d === 4)).toBe(true);
    expectLedgerSound(t);
  });

  it('大话骰：3 人叫牌、开牌、扣命、出局，直到只剩一人', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'liars_dice', players);
    const rng = new SeededRng('ld-flow');
    playOut(t, 'liars_dice', players, id, rng);
    const rec = dbRecord(t, id);
    expect(rec.status).toBe('ended');
    expect(rec.result?.winnerSeats).toHaveLength(1);
    expect(rec.players.filter((p) => p.alive)).toHaveLength(1);
    // 赢家 4，其余 2
    const coins = players.map((x) => x.coins());
    expect([...coins].sort()).toEqual([22, 22, 24]);
    expectLedgerSound(t);
  });

  it('固定种子的随机合法动作：每种游戏多局都能打完，不卡死，账本健全', () => {
    for (const game of GAMES) {
      for (let seed = 1; seed <= 5; seed++) {
        const t = makeTown({ seed: `${game}-${seed}` });
        const n = game === 'sealed_auction' ? 3 + (seed % 3) : 2 + (seed % 3);
        const players = residents(t, n);
        const id = openTable(t, game, players);
        playOut(t, game, players, id, new SeededRng(`${game}:${seed}`));
        expect(['completed', 'aborted']).toContain(actStatus(t, id));
        expect(actStatus(t, id), `${game} 种子 ${seed}`).toBe('completed');
        for (const x of players) {
          expect(x.row().activity_id).toBeNull();
          expect(x.view().here?.space).toBe('arcade');
        }
        expect(t.w.db.scalar('SELECT COUNT(*) FROM settlements')).toBe(1);
        expect(rewardTx(t, id).length).toBe(n);
        expectLedgerSound(t);
      }
    }
  });
});

// ───────────────────────── 凑桌的约束 ─────────────────────────

describe('小游戏：场所、人数与凑桌规则', () => {
  it('只能在允许的场所发起；不认识的游戏是 bad_request', () => {
    const t = makeTown();
    const [a] = residents(t, 1) as [Actor];
    // 广场：数字炸弹可以，密封竞拍和大话骰不行
    expect(a.fail('propose_game', { game: 'sealed_auction', objectId: 'arcade:table1' }).reason).toBe('wrong_venue');
    expect(a.fail('propose_game', { game: 'liars_dice' }).reason).toBe('wrong_venue');
    expect(a.fail('propose_game', { game: 'werewolf' }).code).toBe('bad_request');
    expect(a.fail('propose_game', { game: 'texas_holdem' }).code).toBe('bad_request');
    expect(a.fail('propose_game', {}).code).toBe('bad_request');
    // 茶馆没有游戏桌：所有游戏都只能在游戏馆
    a.go('tea_house');
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).reason).toBe('wrong_venue');
    expect(a.fail('propose_game', { game: 'liars_dice', objectId: 'arcade:table1' }).reason).toBe('wrong_venue');
    // 没有凑桌资格的地方（书屋）
    const [b] = [t.join('另一位', 'agent')];
    b.go('bookshop');
    expect(b.fail('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).reason).toBe('wrong_venue');
  });

  it('走在路上（还不在游戏馆的区域里）不能凑桌；已经在一桌里不能再发起或加入别桌', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    a.act('navigate', { to: 'arcade' });
    // 走出广场、还没到游戏馆：脚下是灯笼路，不是游戏馆
    for (let i = 0; i < 40 && a.view().location.space === 'plaza'; i++) t.advanceAlive(1_000, [a, b]);
    expect(a.view().location.space).toBe('road');
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).reason).toBe('wrong_venue');
    a.walk();
    expect(a.view().location.space).toBe('arcade');
    a.go(TABLE1);
    gather(t, [b], 'arcade', TABLE2);
    const p = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 });
    expect(a.fail('propose_game', { game: 'liars_dice', objectId: TABLE1 }).reason).toBe('already_in_activity');
    expect(a.fail('join_game', { activityId: p.activity.id }).reason).toBe('already_in_activity');
    const q = b.act('propose_game', { game: 'liars_dice', objectId: TABLE2 });
    expect(b.fail('join_game', { activityId: p.activity.id }).reason).toBe('already_in_activity');
    expect(q.activity.id).not.toBe(p.activity.id);
  });

  it('人数下限：不够不能开；只有发起人能开；上限：满了加不进', () => {
    const t = makeTown();
    const crowd = residents(t, 9);
    gather(t, crowd, 'arcade');
    const [host, g1, g2] = crowd as [Actor, Actor, Actor];
    const p = host.act('propose_game', { game: 'sealed_auction', objectId: 'arcade:table1' }); // 3~6 人
    const id = p.activity.id as string;
    g1.act('join_game', { activityId: id });
    const e = host.fail('start_game', { activityId: id });
    expect(e.reason).toBe('not_enough');
    expect(g1.fail('start_game', { activityId: id }).reason).toBe('not_host');
    g2.act('join_game', { activityId: id });
    expect(g2.fail('start_game', { activityId: id }).reason).toBe('not_host');
    // 补满 6 人，第 7 个加不进
    for (const x of crowd.slice(3, 6)) x.act('join_game', { activityId: id });
    expect(crowd[6]!.fail('join_game', { activityId: id }).reason).toBe('full');
    host.act('start_game', { activityId: id });
    expect(dbRecord(t, id).players).toHaveLength(6);
    // 已经开局的桌不能再加入
    expect(crowd[6]!.fail('join_game', { activityId: id }).reason).toBe('not_open');
    // 数字炸弹单人不行
    crowd[6]!.go(TABLE2);
    const solo = crowd[6]!.act('propose_game', { game: 'number_bomb', objectId: TABLE2 });
    expect(crowd[6]!.fail('start_game', { activityId: solo.activity.id }).reason).toBe('not_enough');
  });

  it('加入的人必须在这一桌的场所；别处的桌看不见也加不进', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a], 'arcade');
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    expect(b.view().here?.space).toBe('plaza');
    expect(b.view().here!.activities).toHaveLength(0);
    expect(b.fail('join_game', { activityId: p.activity.id }).reason).toBe('not_here');
    expect(b.fail('join_game', { activityId: 'a_nonexistent' }).reason).toBe('not_here');
  });

  it('开局时重新确认在场：走开的人被请出，人数不够则开局失败', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const p = a.act('propose_game', { game: 'sealed_auction', objectId: 'arcade:table1' });
    const id = p.activity.id as string;
    b.act('join_game', { activityId: id });
    c.act('join_game', { activityId: id });
    // b 走开了：离开场所就退出了这一桌
    b.go('plaza'); // 走出游戏馆的区域那一刻就退出了报名
    const names = () => (t.w.db.all('SELECT resident_id FROM activity_participants WHERE activity_id = ?', id)).map((r) => String(r.resident_id));
    expect(names().sort()).toEqual([a.residentId, c.residentId].sort());
    expect(a.fail('start_game', { activityId: id }).reason).toBe('not_enough');
    // 活动还在凑桌：b 走到场所重新加入就能开
    t.advanceAlive(1_000, [a, b, c]);
    gather(t, [b], 'arcade');
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    expect(dbRecord(t, id).players).toHaveLength(3);
  });

  it('开局时重新确认在场：有人离线（租约过期）被剔除，剩下的人够就照常开', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    const id = p.activity.id as string;
    b.act('join_game', { activityId: id });
    c.act('join_game', { activityId: id });
    // c 不再心跳：租约到期后离线
    t.advanceAlive(100_000, [a, b]);
    expect(c.row().present_since).toBeNull();
    a.act('start_game', { activityId: id });
    const rec = dbRecord(t, id);
    expect(rec.players.map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    expect(c.row().activity_id).toBeNull();
  });

  it('开局时的最终确认：参与者表里残留的离线/在途者在开局那一刻被剔除（直接构造残留）', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    c.act('join_game', { activityId: id });
    // 绕过钩子制造「名单里有人其实已经不在场所」：直接把 c 的位置改到别处
    const row = c.row();
    row.location_id = 'bookshop';
    t.w.saveResident(row);
    a.act('start_game', { activityId: id });
    expect(dbRecord(t, id).players.map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    expect(c.row().activity_id).toBeNull();
  });

  it('同时进行的局数有上限：超了 games_busy，别人打完后可以开（游戏馆只有两张桌，所以用参数压到 1）', () => {
    const t = makeTown({ params: { concurrentGames: 1 } });
    const crowd = residents(t, 4);
    gather(t, crowd.slice(0, 2), 'arcade', TABLE1);
    gather(t, crowd.slice(2), 'arcade', TABLE2);
    const p1 = crowd[0]!.act('propose_game', { game: 'number_bomb', objectId: TABLE1 });
    crowd[1]!.act('join_game', { activityId: p1.activity.id });
    const p2 = crowd[2]!.act('propose_game', { game: 'number_bomb', objectId: TABLE2 });
    crowd[3]!.act('join_game', { activityId: p2.activity.id });
    crowd[0]!.act('start_game', { activityId: p1.activity.id });
    expect(crowd[2]!.fail('start_game', { activityId: p2.activity.id }).reason).toBe('games_busy');
    expect(actStatus(t, p2.activity.id)).toBe('forming');
    playOut(t, 'number_bomb', crowd.slice(0, 2), p1.activity.id, new SeededRng('busy'));
    crowd[2]!.act('start_game', { activityId: p2.activity.id });
    expect(actStatus(t, p2.activity.id)).toBe('running');
  });

  it('同一张桌同时只有一局（凑桌中或进行中）；另一张桌可以同时开；打完后这张桌空出来', () => {
    const t = makeTown();
    const crowd = residents(t, 6);
    gather(t, crowd.slice(0, 3), 'arcade', TABLE1);
    gather(t, crowd.slice(3), 'arcade', TABLE2);
    const p1 = crowd[0]!.act('propose_game', { game: 'number_bomb', objectId: TABLE1 });
    expect(p1.activity.tableId).toBe(TABLE1);
    // 凑桌中：同桌的第二个局被拒
    expect(crowd[1]!.fail('propose_game', { game: 'number_bomb', objectId: TABLE1 }).reason).toBe('table_busy');
    // 另一张桌可以同时开
    const p2 = crowd[3]!.act('propose_game', { game: 'number_bomb', objectId: TABLE2 });
    expect(p2.activity.tableId).toBe(TABLE2);
    expect(crowd[4]!.fail('propose_game', { game: 'liars_dice', objectId: TABLE2 }).reason).toBe('table_busy');
    // 视图里每张桌带着占用它的那一局
    const tables = crowd[2]!.view().here!.tables;
    expect(tables.map((x) => [x.id, x.activityId])).toEqual([[TABLE1, p1.activity.id], [TABLE2, p2.activity.id]]);
    expect(tables.find((x) => x.id === TABLE1)!.near).toBe(true);
    expect(tables.find((x) => x.id === TABLE2)!.near).toBe(false);
    expect(crowd[2]!.view().here!.activities.map((x) => x.tableId).sort()).toEqual([TABLE1, TABLE2]);
    // 进行中：同样占着
    crowd[1]!.act('join_game', { activityId: p1.activity.id });
    crowd[0]!.act('start_game', { activityId: p1.activity.id });
    expect(crowd[2]!.fail('propose_game', { game: 'number_bomb', objectId: TABLE1 }).reason).toBe('table_busy');
    // 打完之后桌子空出来，可以再凑一局
    playOut(t, 'number_bomb', crowd.slice(0, 2), p1.activity.id, new SeededRng('table'));
    expect(crowd[2]!.view().here!.tables.find((x) => x.id === TABLE1)!.activityId).toBeNull();
    expect(crowd[2]!.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.tableId).toBe(TABLE1);
    // 数据库兜底：同一张桌不能有两条未结束的活动
    expect(() =>
      t.w.db.run("INSERT INTO activities(activity_id, world_id, venue_id, table_id, game_type, status, host_id, options_json, origin_request_id, created_at, lobby_expires_at) VALUES ('a_dup', ?, 'arcade', ?, 'number_bomb', 'forming', ?, '{}', 'dup-req-0001', 0, 0)", t.w.worldId, TABLE2, crowd[5]!.residentId),
    ).toThrow();
  });

  it('大厅超时（activity_lobby_expire）：到点解散，参与者可以重新凑桌', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    const id = p.activity.id as string;
    b.act('join_game', { activityId: id });
    t.advanceAlive(9 * MIN, [a, b]);
    expect(actStatus(t, id)).toBe('forming');
    t.advanceAlive(2 * MIN, [a, b]);
    expect(actStatus(t, id)).toBe('aborted');
    // 活动事件通知了场内的人
    expect(eventsOf(t, b).events.some((e) => e.type === 'activity' && (e.data as any).reason === '等了太久没凑齐人')).toBe(true);
    // 过期的桌不能再开、不能再加入
    expect(a.fail('start_game', { activityId: id }).reason).toBe('not_host');
    expect(b.fail('join_game', { activityId: id }).reason).toBe('not_open');
    // 双方已经自由：可以重新发起
    const q = b.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    a.act('join_game', { activityId: q.activity.id });
    b.act('start_game', { activityId: q.activity.id });
    expect(actStatus(t, q.activity.id)).toBe('running');
  });

  it('发起人退出大厅：这桌解散；普通参与者退出只是离席', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
    const id = p.activity.id as string;
    b.act('join_game', { activityId: id });
    c.act('join_game', { activityId: id });
    b.act('leave_game_lobby');
    expect(actStatus(t, id)).toBe('forming');
    expect(b.fail('leave_game_lobby').reason).toBe('not_in_lobby');
    a.act('leave_game_lobby');
    expect(actStatus(t, id)).toBe('aborted');
    expect(c.view().here!.activities).toHaveLength(0);
    expect(c.fail('start_game', { activityId: id }).reason).toBe('not_host');
    // c 也自由了
    c.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
  });

  it('发起人走开 / 离线 = 退出大厅，这桌解散', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const id1 = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id1 });
    a.go('plaza');
    expect(actStatus(t, id1)).toBe('aborted');
    const id2 = c.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    t.advanceAlive(100_000, [a, b]); // c 不再心跳
    expect(c.row().present_since).toBeNull();
    expect(actStatus(t, id2)).toBe('aborted');
  });

  it('开局时正在走的成员站住；小游戏里不能 navigate；打完人还在原地', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    // b 在游戏馆里朝角落走（没走出这片区域，所以还在报名名单里）
    b.act('navigate', { to: { x: 29.25, z: 43.25 } });
    t.advanceAlive(200, [a, b]);
    expect(b.pos().moving).toBe(true);
    expect(b.view().location.space).toBe('arcade');
    a.act('start_game', { activityId: id });
    const stoppedAt = b.pos();
    expect(stoppedAt.moving).toBe(false);
    expect(b.view().location.navigation).toBeFalsy();
    // 局中不能迈步
    expect(b.fail('navigate', { to: 'plaza' }).reason).toBe('in_activity');
    expect(b.fail('navigate', { to: { x: 30, z: 44 } }).reason).toBe('in_activity');
    t.advanceAlive(5_000, [a, b]);
    expect(b.pos()).toMatchObject({ x: stoppedAt.x, z: stoppedAt.z, moving: false });
    // 打完：人还在原地，区域标签也没变
    playOut(t, 'number_bomb', [a, b], id, new SeededRng('stay'));
    expect(b.pos()).toMatchObject({ x: stoppedAt.x, z: stoppedAt.z, moving: false });
    expect(b.view().location.space).toBe('arcade');
    expect(b.row().activity_id).toBeNull();
  });

  it('走出游戏馆这片区域（哪怕是被带走的路过）就退出报名，不用等到开局', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const id = a.act('propose_game', { game: 'sealed_auction', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    c.act('join_game', { activityId: id });
    b.act('navigate', { to: 'plaza' });
    for (let i = 0; i < 40 && b.view().location.space === 'arcade'; i++) t.advanceAlive(500, [a, b, c]);
    expect(b.view().location.space).not.toBe('arcade');
    const names = t.w.db.all('SELECT resident_id FROM activity_participants WHERE activity_id = ?', id).map((r) => String(r.resident_id));
    expect(names.sort()).toEqual([a.residentId, c.residentId].sort());
    expect(b.fail('join_game', { activityId: id }).reason).toBe('not_here');
  });

  it('嵌入的一局不产生 QQ 投递：delivery = embedded_web，没有裁判、没有座位链接、发件箱为空', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'liars_dice', players);
    playOut(t, 'liars_dice', players, id, new SeededRng('delivery'));
    const rec = dbRecord(t, id);
    expect(rec.delivery).toBe('embedded_web');
    expect(rec.outbox).toEqual([]);
    expect(rec.referee).toBeNull();
    expect(rec.autoReferee).toBe(true);
    expect(rec.embed).toMatchObject({ worldId: 'town', activityId: id });
    expect(JSON.stringify(rec)).not.toMatch(/watchToken|seatLink|seat_link/);
    // 世界对外的公告箱里没有这局的东西（只有稀疏的公共公告）
    const out = t.w.db.all('SELECT payload FROM notification_outbox').map((r) => String(r.payload));
    expect(out.join('')).not.toContain(rec.id);
  });
});

// ───────────────────────── 局内：上下文、阶段与幂等 ─────────────────────────

describe('小游戏：上下文版本、阶段编号与幂等', () => {
  it('进入和离开都递增 contextVersion；局中用世界动作被拒（过期上下文 → context_stale，新上下文 → in_activity）', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const before = a.view();
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    expect(a.view().context.version).toBe(before.context.version); // 凑桌不算进入
    a.act('start_game', { activityId: id });
    expect(a.view().context.version).toBe(before.context.version + 1);
    expect(b.view().context.version).toBe(before.context.version + 1);

    // 拿开局前的上下文发 speak → context_stale（不落到另一边）
    const stale = a.fail('speak', { text: '还有人吗' }, { expected: { contextVersion: before.context.version, controlEpoch: before.control.epoch, activityId: null }, actionWindow: before.actionWindow });
    expect(stale.code).toBe('context_stale');
    expect(stale.data).toMatchObject({ contextVersion: before.context.version + 1, activityId: id });
    // 用新上下文：游戏中不能做世界动作
    for (const [type, fields] of [
      ['speak', { text: '你好' }],
      ['navigate', { to: 'plaza' }],
      ['move', { to: 'plaza' }], // 旧名别名也一样被拒
      ['buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 1 }],
      ['propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }],
    ] as const) {
      const e = a.fail(type, fields);
      expect(e.code, type).toBe('precondition_failed');
      expect(e.reason, type).toBe('in_activity');
    }
    // 离开：结束后版本再 +1
    playOut(t, 'number_bomb', [a, b], id, new SeededRng('cv'));
    expect(a.view().context.version).toBe(before.context.version + 2);
    // 现在拿局中的上下文发 game_act → context_stale
    const staleGame = a.fail('game_act', { phaseId: 1, input: { action: 'guess', number: 50 } }, { expected: { contextVersion: before.context.version + 1, controlEpoch: before.control.epoch, activityId: id } });
    expect(staleGame.code).toBe('context_stale');
    // 不在局里发 game_act（用对的上下文）也是 context_stale
    expect(a.fail('game_act', { phaseId: 1, input: { action: 'guess', number: 50 } }).code).toBe('context_stale');
    // 退出后世界动作恢复
    a.act('speak', { text: '好玩' });
  });

  it('游戏动作必须带对的 phaseId：缺失 / 旧阶段 / 未来阶段都是 phase_stale，且不改变局面', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    const id = openTable(t, 'number_bomb', [a, b]);
    const actors = [a, b];
    const first = actors.find((x) => x.view().game!.your_turn)!;
    const second = actors.find((x) => x !== first)!;
    const g1 = first.lastView.game!;
    expect(g1.phase_id).toBeGreaterThan(0);
    const rangeOf = (x: Actor) => (x.view().game!.public as any).range;
    const range0 = rangeOf(first);

    expect(first.fail('game_act', { input: { action: 'guess', number: range0.from } }).code).toBe('phase_stale');
    expect(first.fail('game_act', { phaseId: g1.phase_id! + 5, input: { action: 'guess', number: range0.from } }).code).toBe('phase_stale');
    expect(first.fail('game_act', { phaseId: null, input: { action: 'guess', number: range0.from } }).code).toBe('phase_stale');
    expect(rangeOf(first)).toEqual(range0);

    first.act('game_act', { phaseId: g1.phase_id, input: { action: 'guess', number: range0.from } });
    if (actStatus(t, id) !== 'running') return; // 恰好一猜即爆
    // 阶段已经变了：同一个 phaseId 的第二次尝试（新请求号）迟到 → phase_stale
    const late = first.fail('game_act', { phaseId: g1.phase_id, input: { action: 'guess', number: range0.from + 1 } });
    expect(late.code).toBe('phase_stale');
    expect(late.data?.phaseId).toBe(second.view().game!.phase_id);
    // 不是自己的回合：用对的 phaseId 也被游戏规则拒绝（precondition_failed）
    const notMine = first.fail('game_act', { phaseId: second.lastView.game!.phase_id, input: { action: 'guess', number: range0.from + 1 } });
    expect(notMine.code).toBe('precondition_failed');
    expect(notMine.reason).toMatch(/^game_/);
  });

  it('不合法的局内输入：缺 input、超出范围、陌生的 gameId 都被拒绝，不改变状态', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    openTable(t, 'number_bomb', [a, b]);
    const who = [a, b].find((x) => x.view().game!.your_turn)!;
    const g = who.lastView.game!;
    const r = (g.public as any).range;
    expect(who.fail('game_act', { phaseId: g.phase_id }).code).toBe('bad_request');
    expect(who.fail('game_act', { phaseId: g.phase_id, input: 'guess 3' }).code).toBe('bad_request');
    expect(who.fail('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: r.to + 10 } }).code).toBe('precondition_failed');
    expect(who.fail('game_act', { phaseId: g.phase_id, input: { action: 'guess' } }).code).toBe('precondition_failed');
    expect(who.fail('game_act', { phaseId: g.phase_id, input: { action: 'fly' } }).code).toBe('precondition_failed');
    expect(who.fail('game_act', { phaseId: g.phase_id, gameId: 'TG-NOPE', input: { action: 'guess', number: r.from } }).code).toBe('context_stale');
    expect((who.view().game!.public as any).range).toEqual(r);
    // 带上对的 gameId 可以
    who.act('game_act', { phaseId: g.phase_id, gameId: g.game_id, input: { action: 'guess', number: r.from } });
  });

  it('阶段到期先由 game_tick 结算（超时托管），之后迟到的动作是 phase_stale', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    const id = openTable(t, 'number_bomb', [a, b]);
    const who = [a, b].find((x) => x.view().game!.your_turn)!;
    const g = who.lastView.game!;
    const range0 = (g.public as any).range;
    const secondsLeft = g.todo!.seconds_left!;
    expect(secondsLeft).toBeGreaterThan(40);
    expect(secondsLeft).toBeLessThanOrEqual(45);
    const jobs = t.w.db.all("SELECT kind, due_at FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", `gt:${id}`);
    expect(jobs).toHaveLength(1);

    // 过了 45 秒没动：不需要任何人调用，tick 就把托管猜数结算掉
    t.advanceAlive(46_000, [a, b]);
    const pub = (who.view().game ?? a.view().game)!.public as any;
    expect(pub.history.length === 1 || actStatus(t, id) !== 'running').toBe(true);
    if (actStatus(t, id) === 'running') {
      expect(pub.history[0].auto).toBe(true);
      expect(pub.history[0].seat).toBeDefined();
    }
    // 迟到的动作：带旧阶段 → phase_stale（若局已因托管猜中而结束则是 context_stale）
    const late = who.fail('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: range0.from } });
    expect(['phase_stale', 'context_stale']).toContain(late.code);
    if (actStatus(t, id) === 'running') expect(late.code).toBe('phase_stale');
  });

  it('命令入口先处理到期阶段：没有 tick 也不会让旧阶段的动作生效', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    const id = openTable(t, 'number_bomb', [a, b]);
    const who = [a, b].find((x) => x.view().game!.your_turn)!;
    const stale = who.view().game!;
    // 直接拨时钟而不 tick，并保持在场（心跳）
    t.clock.advance(50_000);
    a.heartbeat();
    b.heartbeat();
    const view = who.view(); // 读视图不推进；但提交命令会先 runDue
    const e = who.fail('game_act', { phaseId: stale.phase_id, input: { action: 'guess', number: (stale.public as any).range.from } }, { actionWindow: view.actionWindow });
    expect(['phase_stale', 'context_stale']).toContain(e.code);
    void id;
  });

  it('同 requestId 重放不会重复行动；换了内容是 request_conflict', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    const id = openTable(t, 'number_bomb', [a, b]);
    const who = [a, b].find((x) => x.view().game!.your_turn)!;
    const g = who.lastView.game!;
    const r = (g.public as any).range;
    const guess = r.from + 10;
    const first = who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: guess } }, { requestId: 'guess-once-0001' });
    expect(first.ok).toBe(true);
    const revision = t.w.db.scalar('SELECT revision FROM game_records WHERE activity_id = ?', id);
    const historyLen = () => (dbRecord(t, id).state as any).history.length;
    const h1 = historyLen();
    const again = who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: guess } }, { requestId: 'guess-once-0001' });
    expect(again.replayed).toBe(true);
    expect(again.text).toBe(first.text);
    expect(historyLen()).toBe(h1);
    expect(t.w.db.scalar('SELECT revision FROM game_records WHERE activity_id = ?', id)).toBe(revision);
    const conflict = who.fail('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: guess + 1 } }, { requestId: 'guess-once-0001' });
    expect(conflict.code).toBe('request_conflict');
    // 世界动作也一样：重放 propose 不会开第二桌
    expect(t.w.db.scalar("SELECT COUNT(*) FROM activities WHERE status = 'running'")).toBe(1);
  });

  it('同 requestId 重放 propose_game / join_game / start_game：不重复开桌、不重复开局', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const p = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }, { requestId: 'propose-req-0001' });
    const p2 = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }, { requestId: 'propose-req-0001' });
    expect(p2.replayed).toBe(true);
    expect(p2.activity.id).toBe(p.activity.id);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM activities')).toBe(1);
    b.act('join_game', { activityId: p.activity.id }, { requestId: 'join-req-00001' });
    b.act('join_game', { activityId: p.activity.id }, { requestId: 'join-req-00001' });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM activity_participants')).toBe(2);
    const s = a.act('start_game', { activityId: p.activity.id }, { requestId: 'start-req-0001' });
    // 开局后再重放：直接返回原回执（此时上下文已变，但回执先于上下文检查）
    const s2 = a.act('start_game', { activityId: p.activity.id }, { requestId: 'start-req-0001' });
    expect(s2.replayed).toBe(true);
    expect(s2.gameId).toBe(s.gameId);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM game_records')).toBe(1);
  });

  it('没有控制权的客户端不能行动（control_lost）', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    openTable(t, 'number_bomb', [a, b]);
    const who = [a, b].find((x) => x.view().game!.your_turn)!;
    const g = who.view().game!;
    // 另一个客户端接管
    const other = new Actor(t, who.principalId, who.residentId, `${who.clientId}-2`, who.name);
    other.enter();
    other.claim();
    const e = who.fail('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: (g.public as any).range.from } });
    expect(e.code).toBe('control_lost');
  });
});

// ───────────────────────── 局中的人不在场所现场 ─────────────────────────

describe('小游戏：局中的人不在场所现场', () => {
  it('听不到现场发言、不能被当面赠送、不出现在名单里；回来后恢复', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    const aCursor = a.view().cursor;

    // c 还在场所里：看不到 a、b；说话 a 听不到
    expect(c.view().here!.residents.map((r) => r.id)).toEqual([]);
    c.act('speak', { text: '有人吗' });
    expect(a.events(aCursor).events.filter((e) => e.type === 'chat')).toHaveLength(0);
    expect(a.t.w.db.scalar('SELECT COUNT(*) FROM recipient_events WHERE resident_id = ? AND type = ?', a.residentId, 'chat')).toBe(0);
    // 历史里没有（受众在提交那一刻固定）
    // 不能当面赠送给局中的人
    const gift = failOf(() => c.act('offer', { kind: 'gift', to: a.residentId, give: { coins: 1 } }));
    expect(gift.code).toBe('precondition_failed');
    expect(a.coins()).toBe(20);
    // 局中的人也不能向外送
    expect(a.fail('offer', { kind: 'gift', to: c.residentId, give: { coins: 1 } }).reason).toBe('in_activity');

    playOut(t, 'number_bomb', [a, b], id, new SeededRng('presence'));
    // 他们回到场所时，场所里的 c 收到「到达」通知（来自小游戏）
    expect(eventsOf(t, c).events.filter((e) => e.type === 'arrived' && (e.data as any).fromGame).map((e) => (e.data as any).resident.id).sort()).toEqual([a.residentId, b.residentId].sort());
    // 回来后 c 看得到他们，说话听得到，也能送礼
    expect(c.view().here!.residents.map((r) => r.id).sort()).toEqual([a.residentId, b.residentId].sort());
    const cursor2 = a.view().cursor;
    c.act('speak', { text: '回来啦' });
    expect(a.events(cursor2).events.filter((e) => e.type === 'chat')).toHaveLength(1);
    const o = c.act('offer', { kind: 'gift', to: a.residentId, give: { coins: 1 } });
    expect(o.offer).toBeTruthy();
    // 局中说的话 a 事后也读不到（受众已固定）
    const heard = t.w.db.all("SELECT projection FROM recipient_events WHERE resident_id = ? AND type = 'chat'", a.residentId).map((r) => JSON.parse(String(r.projection)).text);
    expect(heard).toEqual(['回来啦']);
  });

  it('进入一局会撤销手上的未完成交换（报价）', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const offer = a.act('offer', { kind: 'gift', to: c.residentId, give: { coins: 5 } });
    expect(offer.offer.id).toBeTruthy();
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    // 报价自动撤销：c 不能再接受，a 的硬币没有被占着
    expect(c.fail('accept_offer', { offerId: offer.offer.id }).code).toBe('precondition_failed');
    expect(a.coins()).toBe(20);
  });
});

// ───────────────────────── 退出、断线、出局 ─────────────────────────

describe('小游戏：中途退出、意外断线与提前出局', () => {
  it('quit_game：人回到场所，座位按超时规则自动处理，没有这局的奖励；其余人照常打完', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const [a, b, c] = players as [Actor, Actor, Actor];
    const id = openTable(t, 'sealed_auction', players);
    const cv = a.view().context.version;
    const coins0 = players.map((x) => x.coins());

    const q = a.act('quit_game');
    expect(q.status).toBe('completed');
    expect(a.view().context.activityId).toBeNull();
    expect(a.view().context.version).toBe(cv + 1);
    expect(a.view().here?.space).toBe('arcade');
    expect(a.view().game).toBeNull();
    expect(actStatus(t, id)).toBe('running');
    // 再次 quit：不在局里
    expect(a.fail('quit_game').code).toBe('context_stale');
    // a 又可以做世界动作
    a.act('speak', { text: '我先撤了' });
    // a 的座位自动处理：b、c 出价后每一轮不需要等 a
    for (let round = 1; round <= 4; round++) {
      for (const x of [b, c]) {
        const g = x.view().game!;
        expect(g.round).toBe(round);
        x.act('game_act', { phaseId: g.phase_id, input: { action: 'bid', number: 10 } });
      }
    }
    expect(actStatus(t, id)).toBe('completed');
    const rec = dbRecord(t, id);
    expect((rec.state as any).history.every((h: any) => h.bids.find((x: any) => x.seat === rec.players.find((p) => p.id === a.residentId)!.seat).auto)).toBe(true);
    // 没有记录和奖励；b、c 有
    expect(a.coins()).toBe(coins0[0]);
    expect(b.coins()).toBeGreaterThan(coins0[1]!);
    expect(c.coins()).toBeGreaterThan(coins0[2]!);
    expect(rewardTx(t, id).map((x) => x.cause_key).sort()).toEqual([`game:${id}:${b.residentId}`, `game:${id}:${c.residentId}`].sort());
    const fact = t.w.db.get("SELECT payload FROM world_events WHERE type = 'game_completed'")!;
    expect(JSON.parse(String(fact.payload)).participants).toBe(2);
    const parties = t.w.db.all('SELECT resident_id FROM event_parties WHERE event_id = (SELECT event_id FROM world_events WHERE type = ?)', 'game_completed').map((r) => String(r.resident_id));
    expect(parties).not.toContain(a.residentId);
    // a 收到的结束事件奖励为 0
    const ended = endedOf(t, a);
    expect((ended[0]!.data as any).reward).toBe(0);
    expectLedgerSound(t);
  });

  it('轮到谁谁退出：他的这一手立刻按超时规则自动处理，其余人不用干等', () => {
    const t = makeTown({ seed: 'quit-turn' });
    const players = residents(t, 3);
    const id = openTable(t, 'liars_dice', players);
    const holder = players.find((x) => x.view().game!.your_turn)!;
    const seat = dbRecord(t, id).players.find((p) => p.id === holder.residentId)!.seat;
    const sec = holder.lastView.game!.todo!.seconds_left!;
    expect(sec).toBeGreaterThan(30);
    holder.act('quit_game');
    // 没有过任何时间：他开局的叫牌已经由程序代为叫出，轮到了下一个人
    const state = dbRecord(t, id).state as any;
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ seat, auto: true });
    const rest = players.filter((x) => x !== holder);
    expect(rest.some((x) => x.view().game!.your_turn)).toBe(true);
    // 剩下两个人可以打完（退出者每次轮到都自动处理）
    playOut(t, 'liars_dice', rest, id, new SeededRng('quit-turn-rest'));
    expect(actStatus(t, id)).toBe('completed');
    expect(endedOf(t, holder)[0]!.data).toMatchObject({ reward: 0 });
  });

  it('所有人都走了（quit_game）→ 这局中止：无胜负、无奖励、无记录', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'sealed_auction', players);
    const coins0 = players.map((x) => x.coins());
    for (const x of players) x.act('quit_game');
    expect(actStatus(t, id)).toBe('aborted');
    expect(dbRecord(t, id).status).toBe('aborted');
    expect(outcomeOf(t, id)).toBe('aborted');
    expect(players.map((x) => x.coins())).toEqual(coins0);
    expect(rewardTx(t, id)).toHaveLength(0);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'game_completed'")).toBe(0);
    for (const x of players) {
      expect(x.view().here?.space).toBe('arcade');
      const ended = endedOf(t, x);
      expect(ended).toHaveLength(1);
      expect(ended[0]!.data).toMatchObject({ outcome: 'aborted', won: false, reward: 0 });
    }
    // 该场所又能凑桌
    players[0]!.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
  });

  it('主动离开小镇（leave）= 退出这一局', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const [a] = players as [Actor];
    const id = openTable(t, 'sealed_auction', players);
    a.leave();
    expect(a.row().activity_id).toBeNull();
    expect(t.w.db.get('SELECT quit_at FROM activity_participants WHERE activity_id = ? AND resident_id = ?', id, a.residentId)!.quit_at).not.toBeNull();
    expect(actStatus(t, id)).toBe('running');
  });

  it('意外断线（租约过期）不算退出：座位托管，回来能接着玩，并照常拿奖励', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const [a, b, c] = players as [Actor, Actor, Actor];
    const id = openTable(t, 'sealed_auction', players);
    const coins0 = a.coins();
    // a 掉线（不再心跳）；b、c 继续
    t.advanceAlive(70_000, [b, c]);
    expect(a.row().present_since).toBeNull();
    expect(a.row().activity_id).toBe(id);
    expect(t.w.db.get('SELECT quit_at FROM activity_participants WHERE activity_id = ? AND resident_id = ?', id, a.residentId)!.quit_at).toBeNull();
    expect(actStatus(t, id)).toBe('running');
    // 超时规则：到点后第 1 轮按托管（出价 0）结算
    t.advanceAlive(50_000, [b, c]);
    const rec = dbRecord(t, id);
    expect(rec.round).toBeGreaterThanOrEqual(2);
    // a 回来：重新进入，局还在，可以继续
    a.enter();
    const g = a.view().game!;
    expect(g).toBeTruthy();
    expect(g.your_turn).toBe(true);
    for (const x of [a, b, c]) x.act('game_act', { phaseId: x.view().game!.phase_id, input: { action: 'bid', number: 1 } });
    // 一直打到结束
    playOut(t, 'sealed_auction', players, id, new SeededRng('back'));
    expect(actStatus(t, id)).toBe('completed');
    expect(a.coins()).toBeGreaterThan(coins0);
    expectLedgerSound(t);
  });

  it('liars_dice 出局后（seatFinished）座位提前回到世界，整局结束时仍得参与奖', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'liars_dice', players);
    const rng = new SeededRng('out-early');
    const alive = (x: Actor) => Boolean(dbRecord(t, id).players.find((p) => p.id === x.residentId)!.alive);
    let early: Actor | undefined;
    for (let i = 0; i < 400 && !early; i++) {
      if (actStatus(t, id) !== 'running') break;
      if (!stepOnce(t, 'liars_dice', players, rng)) t.advanceAlive(10_000, players);
      early = players.find((x) => !alive(x));
    }
    expect(early, '应当有人先出局').toBeTruthy();
    expect(actStatus(t, id)).toBe('running');
    const out = early!;
    // 提前回到世界：不在局里，可以旁观（here 有内容）、做世界动作
    expect(out.row().activity_id).toBeNull();
    expect(out.view().game).toBeNull();
    expect(out.view().here?.space).toBe('arcade');
    const outEvents = eventsOf(t, out).events.filter((e) => e.type === 'game_out');
    expect(outEvents).toHaveLength(1);
    expect(outEvents[0]!.data).toMatchObject({ activityId: id });
    out.act('speak', { text: '我出局了' });
    // 局内动作 → context_stale
    expect(out.fail('game_act', { phaseId: 1, input: { action: 'challenge' } }).code).toBe('context_stale');
    // 还在局里的人听不到现场发言
    const rest = players.filter((x) => x !== out);
    expect(rest.every((x) => x.row().activity_id === id)).toBe(true);
    // 参与奖励：整局结束时发（出局者没有 quit_at）
    const coinsOut = out.coins();
    playOut(t, 'liars_dice', players, id, rng);
    expect(out.coins()).toBe(coinsOut + 2);
    expect(rewardTx(t, id)).toHaveLength(3);
    expectLedgerSound(t);
  });

  it('数字炸弹淘汰制：出局者提前离开（用 seatFinished）——仅验证默认单局模式下不会提前离开', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'number_bomb', players);
    // 单局模式：没爆炸之前谁也不会提前回去
    const who = players.find((x) => x.view().game!.your_turn)!;
    const g = who.lastView.game!;
    who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: (g.public as any).range.from } });
    if (actStatus(t, id) === 'running') expect(players.every((x) => x.row().activity_id === id)).toBe(true);
  });
});

// ───────────────────────── 结算：只一次 ─────────────────────────

describe('小游戏：结算只发生一次', () => {
  it('重复 tick、再次处理已结束的局都不会重复发奖；账本原因键唯一', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'number_bomb', players);
    playOut(t, 'number_bomb', players, id, new SeededRng('once'));
    const balances = players.map((x) => x.coins());
    const minted = mintedTotal(t);
    const events = t.w.db.scalar('SELECT COUNT(*) FROM recipient_events');
    for (let i = 0; i < 5; i++) t.advanceAlive(30_000, players);
    // 手工再触发一次「局已结束」的结算入口
    t.w.schedule('game_tick', `gt:${id}:again`, t.clock.now(), { activityId: id });
    t.advance(1000);
    t.w.hooks.tick.forEach((h) => h(t.clock.now()));
    expect(players.map((x) => x.coins())).toEqual(balances);
    expect(mintedTotal(t)).toBe(minted);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM settlements WHERE activity_id = ?', id)).toBe(1);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM world_events WHERE type = 'game_completed'")).toBe(1);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM recipient_events WHERE type = 'game_ended'")).toBe(3);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM recipient_events')).toBeGreaterThanOrEqual(Number(events));
    expect(rewardTx(t, id)).toHaveLength(3);
    // 对已结束的局调度到期任务也不重复
    expectLedgerSound(t);
  });

  it('重启后不重复发奖：已结算的局不会再结算', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const players = residents(t, 3);
      const id = openTable(t, 'number_bomb', players);
      playOut(t, 'number_bomb', players, id, new SeededRng('restart-once'));
      const balances = players.map((x) => x.coins());
      const minted = mintedTotal(t);
      t.restart();
      t.advance(5000);
      expect(players.map((x) => x.coins())).toEqual(balances);
      expect(mintedTotal(t)).toBe(minted);
      expect(t.w.db.scalar('SELECT COUNT(*) FROM settlements')).toBe(1);
      expect(t.w.db.scalar("SELECT COUNT(*) FROM ledger_transactions WHERE kind = 'game_reward'")).toBe(3);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('每天每种游戏前 3 局有奖励，第 4 局没有；第二天重新计数（只算 game_reward，愿望奖励另计）', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const gains: number[] = [];
    const play = (game: GameType, x: Actor, y: Actor, seed: string) => {
      const before = gameRewardTotal(t);
      const id = x.act('propose_game', { game, objectId: 'arcade:table1' }).activity.id as string;
      y.act('join_game', { activityId: id });
      x.act('start_game', { activityId: id });
      playOut(t, game, [x, y], id, new SeededRng(seed));
      return gameRewardTotal(t) - before;
    };
    for (let i = 0; i < 4; i++) gains.push(play('number_bomb', a, b, `daily-${i}`));
    // 单局：一个输家 2、一个赢家 4，共 6；每人每天每种游戏前 3 局有奖
    expect(gains).toEqual([6, 6, 6, 0]);
    // 第 4 局没有奖励，但局照常结算
    expect(t.w.db.scalar("SELECT COUNT(*) FROM settlements WHERE outcome = 'completed'")).toBe(4);
    // 另一种游戏的计数独立
    const c = t.join('丙', 'agent');
    const d = t.join('丁', 'human');
    gather(t, [c, d], 'arcade');
    expect(play('liars_dice', c, d, 'other-type')).toBe(6);
    // 同一个人换了对手，计数跟人走：a 的第 4 局（已经没有）加新对手也只有对手那一份
    gather(t, [a, c], 'arcade');
    const mixed = play('number_bomb', a, c, 'mixed-pair');
    expect([2, 4]).toContain(mixed); // a 已满额；c 还有额度：c 输 2 或赢 4
    // 过了世界日（Asia/Tokyo）重新计数
    for (const x of [a, b, c, d]) x.leave();
    t.advance(24 * 3600_000);
    for (const x of [a, b, c, d]) x.enter();
    gather(t, [a, b], 'arcade');
    expect(play('number_bomb', a, b, 'daily-next')).toBe(6);
    expectLedgerSound(t);
  });

  it('硬币总量只来自铸造：局中、局后、中止都没有别的来源', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const supply0 = sumBalances(t);
    expect(supply0).toBe(60);
    const id = openTable(t, 'sealed_auction', players);
    // 局中（竞拍的金币是游戏内的筹码，不是镇币）
    expect(sumBalances(t)).toBe(supply0);
    playOut(t, 'sealed_auction', players, id, new SeededRng('supply'));
    const gained = sumBalances(t) - supply0;
    expect(gained).toBeGreaterThanOrEqual(6);
    expect(gained).toBe(mintedTotal(t) - supply0);
    const kinds = t.w.db.all('SELECT DISTINCT kind FROM ledger_transactions').map((r) => String(r.kind));
    expect(kinds.sort()).toContain('game_reward');
    expectLedgerSound(t);
  });
});

// ───────────────────────── 20 分钟时限与重启恢复 ─────────────────────────

describe('小游戏：最长时限与重启恢复', () => {
  it('一局最长 20 分钟（默认）：开局时记下 activity_deadline', () => {
    const t = makeTown();
    const players = residents(t, 3);
    const id = openTable(t, 'sealed_auction', players);
    const act = t.w.db.get('SELECT started_at, deadline FROM activities WHERE activity_id = ?', id)!;
    expect(Number(act.deadline) - Number(act.started_at)).toBe(20 * MIN);
    const job = t.w.db.get("SELECT due_at FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", `ad:${id}`)!;
    expect(Number(job.due_at)).toBe(Number(act.deadline));
  });

  it('到了时限（activity_deadline）→ 中止：无胜负、无奖励，人回到场所', () => {
    const t = makeTown({ params: { gameMaxDurationMs: MIN } }); // 缩短到 60 秒；竞拍 4 轮 × 45 秒打不完
    const players = residents(t, 3);
    const coins0 = players.map((x) => x.coins());
    const id = openTable(t, 'sealed_auction', players);
    t.advanceAlive(50_000, players);
    expect(actStatus(t, id)).toBe('running');
    t.advanceAlive(30_000, players);
    expect(actStatus(t, id)).toBe('aborted');
    const rec = dbRecord(t, id);
    expect(rec.status).toBe('aborted');
    expect(rec.abortReason).toBe('超过了一局的最长时间');
    expect(players.map((x) => x.coins())).toEqual(coins0);
    expect(rewardTx(t, id)).toHaveLength(0);
    for (const x of players) {
      expect(x.row().activity_id).toBeNull();
      expect(x.view().here?.space).toBe('arcade');
      expect(endedOf(t, x)[0]!.data).toMatchObject({ outcome: 'aborted', reward: 0, won: false });
    }
    // 记账时间不晚于截止时间
    const ended = Number(t.w.db.get('SELECT ended_at FROM activities WHERE activity_id = ?', id)!.ended_at);
    const deadline = Number(t.w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', id)!.deadline);
    expect(ended).toBeLessThanOrEqual(deadline);
    expect(t.w.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'pending' AND dedupe_key LIKE ?", `%${id}`)).toBe(0);
    expectLedgerSound(t);
  });

  function crashAndRestart(t: Town, downtimeMs: number): void {
    t.w.close();
    t.clock.advance(downtimeMs);
    t.restart();
  }

  it('停机 ≤ 120 秒：截止时间顺延，重启后继续打完并发奖', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const players = residents(t, 3);
      const id = openTable(t, 'sealed_auction', players);
      // 先打一轮
      players.forEach((x) => x.act('game_act', { phaseId: x.view().game!.phase_id, input: { action: 'bid', number: 7 } }));
      const before = t.w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', id)!;
      const phaseDeadline0 = dbRecord(t, id).phase!.deadline!;
      const coins0 = players.map((x) => x.coins());

      crashAndRestart(t, 90_000);
      expect(t.w.status).toBe('running');
      expect(t.w.lastOutageMs).toBe(90_000);
      expect(actStatus(t, id)).toBe('running');
      expect(Number(t.w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', id)!.deadline)).toBe(Number(before.deadline) + 90_000);
      expect(dbRecord(t, id).phase!.deadline).toBe(phaseDeadline0 + 90_000);
      expect(Number(t.w.db.get("SELECT due_at FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", `ad:${id}`)!.due_at)).toBe(Number(before.deadline) + 90_000);
      // 人们重新进入（掉线 > 租约），局还在他们名下
      for (const x of players) {
        expect(x.row().activity_id).toBe(id);
        x.enter();
        expect(x.view().game).toBeTruthy();
        expect(x.view().game!.round).toBe(2);
      }
      playOut(t, 'sealed_auction', players, id, new SeededRng('after-restart'));
      expect(actStatus(t, id)).toBe('completed');
      players.forEach((x, i) => expect(x.coins()).toBeGreaterThan(coins0[i]!));
      expect(rewardTx(t, id)).toHaveLength(3);
      expectLedgerSound(t);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('停机 > 120 秒：局中止、无奖励，并把人送回场所', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const players = residents(t, 3);
      const id = openTable(t, 'sealed_auction', players);
      const coins0 = players.map((x) => x.coins());
      const cv = players[0]!.view().context.version;

      crashAndRestart(t, 130_000);
      expect(actStatus(t, id)).toBe('aborted');
      expect(dbRecord(t, id).abortReason).toBe('服务器中断太久，这局没法公平地继续');
      for (const x of players) {
        expect(x.row().activity_id).toBeNull();
        expect(x.row().context_version).toBe(cv + 1);
        x.enter();
        expect(x.view().here?.space).toBe('arcade');
        expect(x.view().game).toBeNull();
      }
      expect(players.map((x) => x.coins())).toEqual(coins0);
      expect(rewardTx(t, id)).toHaveLength(0);
      expect(outcomeOf(t, id)).toBe('aborted');
      // 再凑桌没问题
      const p = players[0]!.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' });
      expect(p.activity.status).toBe('forming');
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('已经打完但尚未结算的局：即使停机超过 120 秒也照常结算，不改判中止', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const players = residents(t, 3);
      const id = openTable(t, 'sealed_auction', players);
      const coins0 = players.map((x) => x.coins());
      // 构造「游戏终态已提交、世界还没来得及结算」：把候选记录改成已结束
      const rec = dbRecord(t, id);
      rec.status = 'ended';
      rec.phase = null;
      rec.result = { winnerTeam: '最佳收藏家', winnerSeats: [1], reason: '测试终局', reveal: [] } as never;
      t.w.db.run('UPDATE game_records SET status = ?, record_json = ?, revision = revision + 1 WHERE activity_id = ?', 'ended', JSON.stringify(rec), id);
      t.w.gameCache.clear();
      crashAndRestart(t, 300_000);
      expect(actStatus(t, id)).toBe('completed');
      expect(outcomeOf(t, id)).toBe('completed');
      const winner = players.find((x) => rec.players.find((p) => p.id === x.residentId)!.seat === 1)!;
      players.forEach((x, i) => expect(x.coins() - coins0[i]!).toBe(x === winner ? 4 : 2));
      expect(rewardTx(t, id)).toHaveLength(3);
      expectLedgerSound(t);
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('停机刚好等于上限（120 秒）：仍算短暂中断，继续', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const players = residents(t, 3);
      const id = openTable(t, 'sealed_auction', players);
      crashAndRestart(t, 120_000);
      expect(actStatus(t, id)).toBe('running');
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('停机期间已经到期的凑桌：重启后解散', () => {
    const db = tempDb();
    try {
      const t = makeTown({ dbPath: db.path });
      const [a, b] = residents(t, 2) as [Actor, Actor];
      gather(t, [a, b], 'arcade');
      const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
      b.act('join_game', { activityId: id });
      crashAndRestart(t, 11 * MIN);
      expect(actStatus(t, id)).toBe('aborted');
      t.w.close();
    } finally {
      db.cleanup();
    }
  });

  it('gameCache 与数据库 revision 不一致（事务回滚后）：不使用脏缓存', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    const id = openTable(t, 'number_bomb', [a, b]);
    const who = [a, b].find((x) => x.view().game!.your_turn)!;
    const g = who.view().game!;
    const r0 = (g.public as any).range as { from: number; to: number };
    const revDb = () => Number(t.w.db.scalar('SELECT revision FROM game_records WHERE activity_id = ?', id));
    const rev0 = revDb();
    const snapshot = t.w.db.get('SELECT record_json, rng_state FROM game_records WHERE activity_id = ?', id)!;

    // handler 在落盘之后抛错：整个事务回滚
    const orig = t.w.handlers.get('game_act')!;
    t.w.handlers.set('game_act', (c) => {
      orig(c);
      throw new Error('boom：提交前崩溃');
    });
    const guess = r0.from + 20;
    expect(() => who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: guess } })).toThrow('boom');
    t.w.handlers.set('game_act', orig);

    // 数据库没有变；缓存里躺着回滚前的「候选」记录，revision 与数据库对不上
    expect(revDb()).toBe(rev0);
    expect(t.w.db.get('SELECT record_json, rng_state FROM game_records WHERE activity_id = ?', id)).toEqual(snapshot);
    const cached = t.w.gameCache.get(id)!;
    expect(cached.revision).not.toBe(revDb());
    expect((cached.rec.state as any).history.length).toBe(1); // 脏：包含了回滚掉的那一猜

    // 之后的读（视图）和写都以数据库为准
    expect((gameViewFor(t.w, who.row())!.public as any).history).toEqual([]);
    expect(((publicGameView(t.w, id)!).public as any).history).toEqual([]);
    expect(who.view().game!.your_turn).toBe(true);
    // 回滚的那条请求没有留下回执：同一个请求号可以重试
    who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: r0.from + 1 } });
    const after = dbRecord(t, id);
    if (after.status === 'running') {
      expect((after.state as any).history).toHaveLength(1);
      expect((after.state as any).history[0].guess).toBe(r0.from + 1);
      expect(revDb()).toBe(rev0 + 1);
    }
  });

  it('回滚后随机流也不会被脏缓存带偏：同样的动作在回滚前后得到同样的结果', () => {
    const run = (withRollback: boolean) => {
      const t = makeTown({ seed: 'rng-rollback' });
      const [a, b] = residents(t, 2) as [Actor, Actor];
      const id = openTable(t, 'liars_dice', [a, b]);
      const first = [a, b].find((x) => x.view().game!.your_turn)!;
      const g = first.lastView.game!;
      const min = (g.public as any).min_next_bid;
      if (withRollback) {
        const orig = t.w.handlers.get('game_act')!;
        t.w.handlers.set('game_act', (c) => {
          orig(c);
          throw new Error('boom');
        });
        expect(() => first.act('game_act', { phaseId: g.phase_id, input: { action: 'bid', quantity: min.quantity, face: min.face } })).toThrow('boom');
        t.w.handlers.set('game_act', orig);
      }
      first.act('game_act', { phaseId: g.phase_id, input: { action: 'bid', quantity: min.quantity, face: min.face } });
      const second = [a, b].find((x) => x.view().game!.your_turn)!;
      second.act('game_act', { phaseId: second.lastView.game!.phase_id, input: { action: 'challenge' } });
      const rec = dbRecord(t, id);
      return { dice: (rec.state as any).dice, lives: (rec.state as any).lives, round: rec.round };
    };
    expect(run(true)).toEqual(run(false));
  });
});

// ───────────────────────── 隐私 ─────────────────────────

describe('小游戏：视图与事件流不泄露座位的私密信息', () => {
  const seatOf = (rec: GameRecord, a: Actor) => rec.players.find((p) => p.id === a.residentId)!.seat;

  it('数字炸弹：观战投影、座位视图和全部事件流里都没有炸弹数字', () => {
    const t = makeTown({ seed: 'privacy-bomb' });
    const players = residents(t, 3);
    const id = openTable(t, 'number_bomb', players);
    const guessSome = () => {
      const who = players.find((x) => x.view().game!.your_turn)!;
      const g = who.lastView.game!;
      const r = (g.public as any).range;
      who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: r.from + 1 } });
    };
    // 先让局面前进一步，使范围边界不一定等于炸弹
    let bomb = (dbRecord(t, id).state as any).bomb as number;
    if (bomb === 2) bomb = -1;
    for (let step = 0; step < 3 && actStatus(t, id) === 'running'; step++) {
      bomb = (dbRecord(t, id).state as any).bomb;
      const pubJson = JSON.stringify(publicGameView(t.w, id));
      expect(pubJson).not.toContain('"bomb"');
      expect(pubJson).not.toContain('炸弹正是');
      const range = (publicGameView(t.w, id)!.public as any).range as { from: number; to: number };
      // 炸弹数字只可能与范围端点重合；不在端点时，它不应出现在投影里的任何位置
      if (bomb > range.from && bomb < range.to) {
        expect(pubJson).not.toMatch(new RegExp(`(?<![\\d])${bomb}(?![\\d])`));
        for (const x of players) expect(JSON.stringify(gameViewFor(t.w, x.row()))).not.toMatch(new RegExp(`(?<![\\d])${bomb}(?![\\d])`));
      }
      for (const x of players) {
        const v = JSON.stringify(gameViewFor(t.w, x.row()));
        expect(v).not.toContain('"bomb"');
        expect(v).not.toContain('炸弹正是');
      }
      guessSome();
    }
    for (const j of allEventJson(t)) {
      expect(j).not.toContain('"bomb"');
      expect(j).not.toContain('炸弹正是');
    }
  });

  it('密封竞拍：别人的出价和估价、未揭晓的拍品价值，在观战投影、别人的座位视图、事件流里都没有', () => {
    const t = makeTown({ seed: 'privacy-auction' });
    const players = residents(t, 3);
    const [a, b, c] = players as [Actor, Actor, Actor];
    const id = openTable(t, 'sealed_auction', players);
    const rec = dbRecord(t, id);
    const items = (rec.state as any).items as { name: string; value: number }[];
    a.act('game_act', { phaseId: a.view().game!.phase_id, input: { action: 'bid', number: 37 } });
    b.act('game_act', { phaseId: b.view().game!.phase_id, input: { action: 'bid', number: 53 } });

    const live = dbRecord(t, id);
    const data = live.phase!.data as { estimates: Record<string, number>; bids: Record<string, { amount: number }> };
    expect(data.bids[String(seatOf(live, a))]!.amount).toBe(37);
    expect(data.bids[String(seatOf(live, b))]!.amount).toBe(53);
    const estC = data.estimates[String(seatOf(live, c))]!;

    const pub = publicGameView(t.w, id)!;
    const pubJson = JSON.stringify(pub);
    for (const bad of ['estimate', '"bid":', '鉴定估价', '已密封', '你的出价', '"value"']) expect(pubJson, bad).not.toContain(bad);
    // 后面几轮的拍品名也没有
    for (const it of items.slice(1)) expect(pubJson).not.toContain(it.name);
    expect(pub.phase!.waiting_for).toContain('秘密阶段'); // 谁还没出价也不公开
    expect(pub.events.every((e) => !e.private)).toBe(true);

    // c 的座位视图：只有自己的估价，没有 a、b 的出价和估价
    const cv = JSON.stringify(gameViewFor(t.w, c.row()));
    expect(cv).toContain(`鉴定估价：${estC}`);
    expect(cv).not.toContain('已密封：37');
    expect(cv).not.toContain('已密封：53');
    expect(cv).not.toContain('"bid":37');
    expect(cv).not.toContain('"bid":53');
    for (const x of [a, b]) expect(cv).not.toContain(`鉴定估价：${data.estimates[String(seatOf(live, x))]}`.replace(/：\d+$/, (m) => (m === `：${estC}` ? '：__same__' : m)));
    // a 的座位视图有自己的出价，没有 b 的
    const av = JSON.stringify(gameViewFor(t.w, a.row()));
    expect(av).toContain('已密封：37');
    expect(av).not.toContain('已密封：53');
    expect(JSON.stringify(gameViewFor(t.w, b.row()))).not.toContain('已密封：37');
    // 事件流（私有 + 公开）里没有出价/估价/价值
    for (const j of allEventJson(t)) {
      for (const bad of ['estimate', '"bid":', '鉴定估价', '已密封']) expect(j, bad).not.toContain(bad);
    }
    // 结束后的公开投影：出价随轮次揭晓（游戏规则），但不含私密记录（估价、私聊）
    playOut(t, 'sealed_auction', players, id, new SeededRng('pa'));
    const end = JSON.stringify(publicGameView(t.w, id));
    for (const bad of ['estimate', '鉴定估价', '已密封', '你的出价']) expect(end, bad).not.toContain(bad);
    expect(publicGameView(t.w, id)!.events.every((e) => !e.private)).toBe(true);
    // 结束后座位视图为空（不在局里）
    expect(gameViewFor(t.w, a.row())).toBeNull();
  });

  it('大话骰：骰子只在本座位视图里；观战投影、别人的视图、事件流都没有', () => {
    const t = makeTown({ seed: 'privacy-dice' });
    const players = residents(t, 3);
    const id = openTable(t, 'liars_dice', players);
    const rec = dbRecord(t, id);
    const dice = (rec.state as any).dice as Record<string, number[]>;
    const pubJson = JSON.stringify(publicGameView(t.w, id));
    expect(pubJson).not.toContain('你的骰子');
    expect(pubJson).not.toContain('"dice"');
    expect(pubJson).not.toContain('revealed_dice');
    for (const d of Object.values(dice)) expect(pubJson).not.toContain(JSON.stringify(d));
    expect(publicGameView(t.w, id)!.events.every((e) => !e.private)).toBe(true);
    for (const x of players) {
      const mySeat = String(seatOf(rec, x));
      const v = gameViewFor(t.w, x.row())!;
      expect((v.you as any).dice).toEqual(dice[mySeat]);
      const json = JSON.stringify(v);
      for (const [seat, d] of Object.entries(dice)) {
        if (seat === mySeat || JSON.stringify(d) === JSON.stringify(dice[mySeat])) continue;
        expect(json).not.toContain(`你的骰子：${d.join(' ')}`);
        expect(json).not.toContain(`"dice":${JSON.stringify(d)}`);
      }
      // 本座位的私有事件只有自己的骰子
      expect(v.events.filter((e) => e.private)).toHaveLength(1);
    }
    for (const j of allEventJson(t)) {
      expect(j).not.toContain('你的骰子');
      expect(j).not.toContain('"dice"');
    }
    // 打完：公开投影不含之前每一轮的私聊（骰子私信），座位视图为空
    playOut(t, 'liars_dice', players, id, new SeededRng('ld-priv'));
    const end = publicGameView(t.w, id)!;
    expect(JSON.stringify(end)).not.toContain('你的骰子');
    expect(end.events.every((e) => !e.private)).toBe(true);
    expect(end.status).toBe('ended');
    for (const x of players) expect(gameViewFor(t.w, x.row())).toBeNull();
  });

  it('事件流里的 game 事件只含「有新进展」的固定字段（不含内容）', () => {
    const t = makeTown({ seed: 'privacy-events' });
    const players = residents(t, 3);
    const id = openTable(t, 'sealed_auction', players);
    playOut(t, 'sealed_auction', players, id, new SeededRng('events'));
    const allowed: Record<string, string[]> = {
      game: ['activityId', 'gameId', 'phaseId', 'yourTurn', 'waiting'],
      game_started: ['activityId', 'gameId', 'name', 'seat'],
      game_out: ['activityId', 'gameId', 'text'],
      game_ended: ['activityId', 'gameId', 'name', 'outcome', 'reason', 'won', 'reward'],
    };
    for (const x of players) {
      const evs = eventsOf(t, x).events;
      for (const e of evs) {
        const keys = allowed[e.type];
        if (keys) for (const k of Object.keys(e.data)) expect(keys, `${e.type}.${k}`).toContain(k);
      }
      expect(evs.some((e) => e.type === 'game')).toBe(true);
      // 秘密阶段的「game」事件不公开等待对象
      const mids = evs.filter((e) => e.type === 'game');
      expect(mids.every((e) => !('waiting' in e.data))).toBe(true);
    }
    // 公开事件流里只有场所级别的活动通知
    const pub = t.w.db.all('SELECT type, projection FROM public_events WHERE type = ?', 'activity');
    for (const p of pub) expect(Object.keys(JSON.parse(String(p.projection)))).toEqual(expect.arrayContaining(['activity']));
  });

  it('观战投影：只对进行中/已结束的局开放，凑桌中或不存在的编号返回 null', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: 'arcade:table1' }).activity.id as string;
    expect(publicGameView(t.w, id)).toBeNull();
    expect(publicGameView(t.w, 'a_nope')).toBeNull();
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    const v = publicGameView(t.w, id)!;
    expect(v).toMatchObject({ activityId: id, venue: 'arcade', type: 'number_bomb', status: 'running' });
    expect(v.you).toBeUndefined();
    expect(v.todo).toBeUndefined();
    expect(v.your_turn).toBeUndefined();
  });
});

// ───────────────────────── 旧游戏回归 ─────────────────────────

describe('小游戏：和公共 GameManager 互不干扰', () => {
  it('普通对局照常能开、能打完；世界里的局不在 GameManager 里，反之亦然', () => {
    // 同一个注册表（和运行时一样），各自的时钟
    const mclock = new FakeClock();
    const t = makeTown({ seed: 'mgr-world' });
    const manager = new GameManager({ registry: t.w.runner.registry, now: mclock.now, rng: new SeededRng('mgr') });

    const players = residents(t, 3);
    const id = openTable(t, 'number_bomb', players);
    expect(manager.listGames({ includeFinished: true })).toHaveLength(0);
    const worldGameId = dbRecord(t, id).id;
    expect(() => manager.getRecord(worldGameId)).toThrow();

    // 同一进程里开一局普通桌游并打完
    const { gameId, rec } = startGame(manager, 'number_bomb', { players: [bot(1), bot(2), bot(3)], autoReferee: true });
    expect(manager.listGames({ includeFinished: true }).map((g) => g.game_id)).toEqual([gameId]);
    for (let i = 0; i < 400 && rec.status === 'running'; i++) {
      mclock.advance(61_000);
      manager.tick();
    }
    expect(rec.status).toBe('ended');
    expect(rec.delivery).not.toBe('embedded_web');
    expect(rec.embed).toBeUndefined();

    // 世界里的局没受影响，也不在 GameManager 里
    expect(actStatus(t, id)).toBe('running');
    playOut(t, 'number_bomb', players, id, new SeededRng('mixed'));
    expect(actStatus(t, id)).toBe('completed');
    expect(manager.listGames({ includeFinished: true }).map((g) => g.game_id)).toEqual([gameId]);
    // 世界里没有普通对局
    expect(t.w.db.scalar('SELECT COUNT(*) FROM game_records WHERE game_id = ?', gameId)).toBe(0);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM game_records')).toBe(1);
  });

  it('嵌入的游戏定义仍可用于普通对局（带 QQ 投递），且 GameManager 的记录不带 embed 标记', () => {
    const clock = new FakeClock();
    const manager = new GameManager({ registry: createRegistry({}), now: clock.now, rng: new SeededRng('mgr2') });
    for (const [i, type] of GAMES.entries()) {
      const { rec } = startGame(manager, type, { players: [bot(1), bot(2), bot(3)], referee: REF, groupId: `g${i}` });
      expect(rec.status).toBe('running');
      expect(rec.embed).toBeUndefined();
      expect(rec.delivery).not.toBe('embedded_web');
    }
  });
});

// ───────────────────────── 按桌入局 ─────────────────────────

describe('小游戏：按桌入局（town-p1.0）', () => {
  const nearTable = (a: Actor, tableId: string): boolean => a.view().here!.tables.find((x) => x.id === tableId)!.near;

  it('不在桌边凑桌 / 加入 / 开局：too_far 并带可以走过去的桌子；走过去就行', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade', null); // 在游戏馆门口，还没到桌边
    expect(nearTable(a, TABLE1)).toBe(false);
    const far = a.fail('propose_game', { game: 'number_bomb', objectId: TABLE1 });
    expect(far.reason).toBe('too_far');
    expect(far.data).toMatchObject({ navigateTo: TABLE1 });
    expect(t.w.db.scalar('SELECT COUNT(*) FROM activities')).toBe(0);
    a.go(far.data!.navigateTo as string);
    expect(nearTable(a, TABLE1)).toBe(true);
    const id = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    // 加入同样要在桌边
    const farJoin = b.fail('join_game', { activityId: id });
    expect(farJoin.reason).toBe('too_far');
    expect(farJoin.data).toMatchObject({ navigateTo: TABLE1 });
    b.go(TABLE1);
    b.act('join_game', { activityId: id });
    // 发起人开局时也得在桌边：走开一段（仍在游戏馆里）再开 → too_far
    a.go({ x: 38.5, z: 42.25 });
    expect(a.view().here!.space).toBe('arcade');
    expect(a.fail('start_game', { activityId: id }).reason).toBe('too_far');
    expect(actStatus(t, id)).toBe('forming');
    a.go(TABLE1);
    a.act('start_game', { activityId: id });
    expect(actStatus(t, id)).toBe('running');
  });

  it('伪造 / 写错 / 缺失的 objectId 被明确拒绝，不会落到「查不到就放行」', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade'); // 都在 table1 旁边
    expect(a.fail('propose_game', { game: 'number_bomb' }).code).toBe('bad_request');
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: '' }).code).toBe('bad_request');
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: 'arcade:table9' }).reason).toBe('not_a_table');
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: 'nowhere' }).reason).toBe('not_a_table');
    // 别的物件（茶桌）也不行
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: 'tea_house:table1' }).reason).toBe('not_a_table');
    expect(a.fail('propose_game', { game: 'number_bomb', objectId: 42 }).code).toBe('bad_request');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM activities')).toBe(0);
    // 加入时带的 objectId 也要对得上这一桌所在的桌子
    const id = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    expect(b.fail('join_game', { activityId: id, objectId: 'bogus' }).reason).toBe('not_a_table');
    expect(b.fail('join_game', { activityId: id, objectId: TABLE2 }).reason).toBe('wrong_table');
    b.act('join_game', { activityId: id, objectId: TABLE1 });
  });

  it('凑桌 / 加入 / 开局通过距离校验时，会让正在走的人站住', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade'); // 都在 table1 东侧
    const id = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    // b 朝桌旁的空地走一小段（始终在 reach 内），走到一半 join：站住
    b.act('navigate', { to: { x: 29.25, z: 43.25 } });
    t.advanceAlive(200, [a, b]);
    expect(b.pos().moving).toBe(true);
    b.act('join_game', { activityId: id });
    expect(b.pos().moving).toBe(false);
    expect(b.view().location.navigation).toBeFalsy();
    // 发起人开局同理
    a.act('navigate', { to: { x: 29.25, z: 45.75 } });
    t.advanceAlive(200, [a, b]);
    expect(a.pos().moving).toBe(true);
    a.act('start_game', { activityId: id });
    expect(a.pos().moving).toBe(false);
    // 凑桌（另一张桌）也一样
    const c = t.join('丙', 'agent');
    c.enter();
    c.go(TABLE2);
    c.act('navigate', { to: { x: 36.5, z: 46.25 } });
    t.advanceAlive(200, [a, b, c]);
    expect(c.pos().moving).toBe(true);
    c.act('propose_game', { game: 'number_bomb', objectId: TABLE2 });
    expect(c.pos().moving).toBe(false);
  });

  it('开局时成员走开了（仍在游戏馆里）：被剔除，剩下的人够就照常开；不够则不开并说明谁不在桌边', () => {
    const t = makeTown();
    const [a, b, c] = residents(t, 3) as [Actor, Actor, Actor];
    gather(t, [a, b, c], 'arcade');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    b.act('join_game', { activityId: id });
    c.act('join_game', { activityId: id });
    c.go({ x: 38.5, z: 42.25 }); // 走到另一头，没出游戏馆，所以还挂在名单里
    expect(c.view().here!.space).toBe('arcade');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM activity_participants WHERE activity_id = ?', id)).toBe(3);
    const started = a.act('start_game', { activityId: id });
    expect(started.dropped).toEqual([c.name]);
    expect(dbRecord(t, id).players.map((x) => x.id).sort()).toEqual([a.residentId, b.residentId].sort());
    expect(c.row().activity_id).toBeNull();
    // 人数不够：不开，原因里写明谁不在桌边
    const t2 = makeTown();
    const [x, y] = residents(t2, 2) as [Actor, Actor];
    gather(t2, [x, y], 'arcade');
    const id2 = x.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    y.act('join_game', { activityId: id2 });
    y.go({ x: 38.5, z: 42.25 });
    const e = x.fail('start_game', { activityId: id2 });
    expect(e.reason).toBe('not_enough');
    expect(e.message).toContain(y.name);
    expect(e.message).toContain('不在桌边');
    expect(actStatus(t2, id2)).toBe('forming');
    // y 走回来就能开
    y.go(TABLE1);
    x.act('start_game', { activityId: id2 });
    expect(actStatus(t2, id2)).toBe('running');
  });

  it('打完后居民留在桌边的原位（合法位置），区域标签不变，可以继续走；奖励只结算一次', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const id = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    const pa = a.pos();
    const pb = b.pos();
    playOut(t, 'number_bomb', [a, b], id, new SeededRng('after'));
    expect(a.pos()).toMatchObject({ x: pa.x, z: pa.z, moving: false });
    expect(b.pos()).toMatchObject({ x: pb.x, z: pb.z, moving: false });
    const town = t.w.map.scenes.get('town')!;
    for (const p of [a.pos(), b.pos()]) {
      expect(isWalkable(town, p.x, p.z)).toBe(true);
      expect(zoneAt(town, p.x, p.z).id).toBe('arcade');
    }
    expect(a.view().here!.space).toBe('arcade');
    expect(a.view().here!.tables.find((x) => x.id === TABLE1)!.activityId).toBeNull();
    // 奖励只发一次：每位参与者恰好一笔，结算一行
    for (const x of [a, b]) {
      expect(t.w.db.scalar('SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = ?', `game:${id}:${x.residentId}`)).toBe(1);
    }
    expect(t.w.db.scalar('SELECT COUNT(*) FROM settlements WHERE activity_id = ?', id)).toBe(1);
    // 可以继续走
    a.go('plaza');
    expect(a.view().here!.space).toBe('plaza');
    expect(t.w.db.scalar('SELECT COUNT(*) FROM ledger_transactions WHERE cause_key = ?', `game:${id}:${a.residentId}`)).toBe(1);
  });

  it('开局后拿旧上下文发的动作被拒（context_stale）', () => {
    const t = makeTown();
    const [a, b] = residents(t, 2) as [Actor, Actor];
    gather(t, [a, b], 'arcade');
    const before = a.view().context;
    const epoch = a.view().control.epoch;
    const id = a.act('propose_game', { game: 'number_bomb', objectId: TABLE1 }).activity.id as string;
    b.act('join_game', { activityId: id });
    a.act('start_game', { activityId: id });
    const stale = a.fail('speak', { text: '旧上下文' }, { expected: { contextVersion: before.version, controlEpoch: epoch, activityId: null } });
    expect(stale.code).toBe('context_stale');
  });
});
