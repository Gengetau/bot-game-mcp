/**
 * 公共场所里的小游戏（活动）。
 *
 * 规则完全沿用已有的游戏定义：世界只负责凑桌、开局、把动作交给 GameRunner、在结束时结算一次。
 * - 游戏记录归世界所有，存在世界数据库里，和居民状态、奖励在同一个事务提交；公共的 GameManager 不持有、不推进它。
 * - 嵌入的一局不产生任何 QQ 消息（delivery = embedded_web），进度只通过世界的事件流和视图给出。
 * - 进入和离开一局都会递增居民的上下文版本：拿着旧上下文发来的动作被拒绝，不会落到另一边去。
 * - 结算每局只发生一次（settlements 的主键和账本原因键双重保证）；中止的局没有胜负和奖励。
 */
import type { Rng } from '../core/rng.js';
import type { GameRecord, Seat } from '../core/types.js';
import type { EmbeddedSeatView } from '../core/runner.js';
import { EMBEDDED_GAMES, embeddedGameDef, placeDef } from './content.js';
import { type Row, parseJson } from './db.js';
import { WorldError, badRequest, precondition } from './errors.js';
import { addMood, applyNeeds, bumpCounter } from './life.js';
import { card } from './project.js';
import { mint } from './property.js';
import { sha256, type WorldService } from './service.js';
import { stopNav } from './space.js';
import type { ResidentRow } from './types.js';

interface Loaded {
  rec: GameRecord;
  rng: Rng;
  save: () => string | null;
  revision: number;
}

// ───────────────────────── 记录的读写 ─────────────────────────

/** 取一份可以随意修改的候选记录（缓存只是加速：版本对不上就从数据库重读）。 */
function load(w: WorldService, activityId: string): Loaded | null {
  const row = w.db.get('SELECT game_id, revision, rng_state FROM game_records WHERE activity_id = ?', activityId);
  if (!row) return null;
  const cached = w.gameCache.get(activityId);
  let rec: GameRecord;
  if (cached && cached.revision === row.revision) rec = structuredClone(cached.rec);
  else {
    const full = w.db.get('SELECT record_json FROM game_records WHERE activity_id = ?', activityId)!;
    rec = JSON.parse(full.record_json) as GameRecord;
    // 只缓存进行中的局：结束的局不会再被推进，观战读到时从数据库重读即可
    if (rec.status === 'running') w.gameCache.set(activityId, { rec: structuredClone(rec), rng: row.rng_state, revision: Number(row.revision) });
  }
  const { rng, save } = w.gameRng(activityId, row.rng_state);
  return { rec, rng, save, revision: Number(row.revision) };
}

const env = (w: WorldService, g: { rng: Rng }) => ({ now: w.now, rng: g.rng });

function nextWake(rec: GameRecord): number | null {
  const ph = rec.phase;
  if (rec.status !== 'running' || !ph || ph.openedAt === null) return null;
  const times = [ph.deadline, ph.minDurationMs > 0 ? ph.openedAt + ph.minDurationMs : null].filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

function forfeitedSeats(w: WorldService, activityId: string): Set<Seat> {
  return new Set(w.db.all('SELECT game_seat FROM activity_participants WHERE activity_id = ? AND quit_at IS NOT NULL AND game_seat IS NOT NULL', activityId).map((p) => Number(p.game_seat)));
}

// ───────────────────────── 视图 ─────────────────────────

export interface ActivityView {
  id: string;
  game: string;
  name: string;
  venue: string;
  status: string;
  host: ReturnType<typeof card>;
  players: ReturnType<typeof card>[];
  min: number;
  max: number;
  lobbyExpiresAt: number;
  gameId: string | null;
}

export function activityView(w: WorldService, row: Row): ActivityView {
  const def = embeddedGameDef(row.game_type);
  const players = w.db
    .all('SELECT resident_id FROM activity_participants WHERE activity_id = ? ORDER BY joined_at, resident_id', row.activity_id)
    .map((p) => card(w.mustResident(String(p.resident_id))));
  return {
    id: String(row.activity_id),
    game: String(row.game_type),
    name: w.runner.def(row.game_type).name,
    venue: String(row.venue_id),
    status: String(row.status),
    host: card(w.mustResident(row.host_id)),
    players,
    min: def?.minPlayers ?? 2,
    max: def?.maxPlayers ?? 8,
    lobbyExpiresAt: Number(row.lobby_expires_at),
    gameId: row.game_id ?? null,
  };
}

/** 某个场所里正在凑桌或进行中的小游戏（公开信息）。 */
export function activitiesAt(w: WorldService, venueId: string): ActivityView[] {
  return w.db.all("SELECT * FROM activities WHERE venue_id = ? AND status IN ('forming','running') ORDER BY created_at", venueId).map((row) => activityView(w, row));
}

/** 这个场所能发起哪些小游戏。 */
export function gamesOfferedAt(w: WorldService, venueId: string): { type: string; name: string; min: number; max: number; summary: string }[] {
  return EMBEDDED_GAMES.filter((g) => g.venues.includes(venueId)).map((g) => {
    const def = w.runner.def(g.type);
    return { type: g.type, name: def.name, min: g.minPlayers, max: g.maxPlayers, summary: def.summary ?? '' };
  });
}

/** 居民自己座位的小游戏视图；不在局里返回 null。 */
export function gameViewFor(w: WorldService, r: ResidentRow, sinceSeq?: number): (EmbeddedSeatView & { activityId: string; deadline: number | null }) | null {
  if (!r.activity_id) return null;
  const g = load(w, r.activity_id);
  if (!g) return null;
  const me = w.db.get('SELECT game_seat FROM activity_participants WHERE activity_id = ? AND resident_id = ?', r.activity_id, r.resident_id);
  const act = w.db.get('SELECT deadline FROM activities WHERE activity_id = ?', r.activity_id);
  const view = w.runner.view(g.rec, env(w, g), me?.game_seat ?? null, { sinceSeq });
  return { ...view, activityId: r.activity_id, deadline: act?.deadline ?? null };
}

/** 观战投影：只有公开信息（结束后也不公开别人的私密记录）。 */
export function publicGameView(w: WorldService, activityId: string): (EmbeddedSeatView & { activityId: string; venue: string }) | null {
  const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status IN ('running','completed','aborted')", activityId);
  if (!act) return null;
  const g = load(w, activityId);
  if (!g) return null;
  return { ...w.runner.view(g.rec, env(w, g), null, { limit: 30 }), activityId, venue: String(act.venue_id) };
}

// ───────────────────────── 安装 ─────────────────────────

export function installGames(w: WorldService): void {
  w.activityActions.add('game_act');
  w.activityActions.add('quit_game');

  const notifyVenue = (row: Row, at: number, extra: Record<string, unknown> = {}) => {
    const view = activityView(w, row);
    const ids = new Set(w.audienceIn(row.venue_id).map((x) => x.resident_id));
    for (const p of view.players) ids.add(p.id);
    w.emitTo(ids, 'activity', { activity: view, ...extra }, at);
  };

  /** 让一位参与者回到世界：上下文版本递增，之后她的动作按普通居民处理。 */
  const returnToWorld = (activityId: string, residentId: string, at: number) => {
    w.db.run('UPDATE activity_participants SET active = 0, returned_at = COALESCE(returned_at, ?) WHERE activity_id = ? AND resident_id = ?', at, activityId, residentId);
    const r = w.resident(residentId);
    if (!r || r.activity_id !== activityId) return;
    r.activity_id = null;
    r.context_version += 1;
    w.saveResident(r);
    if (r.present_since !== null) {
      const others = w.audienceIn(r.location_id).filter((x) => x.resident_id !== residentId);
      w.emitTo(others.map((x) => x.resident_id), 'arrived', { resident: card(r), space: r.location_id, fromGame: true }, at);
    }
  };

  /** 结算（每局一次）并把还在局里的人送回世界。 */
  const settle = (act: Row, g: Loaded, at: number) => {
    const done = g.rec.status === 'ended';
    const inserted = w.db.run('INSERT OR IGNORE INTO settlements(activity_id, result_hash, outcome, settled_at) VALUES (?,?,?,?)', act.activity_id, sha256(JSON.stringify(g.rec.result ?? null)), done ? 'completed' : 'aborted', at).changes;
    if (inserted !== 1) return;
    const name = w.runner.def(g.rec.type).name;
    const parts = w.db.all('SELECT * FROM activity_participants WHERE activity_id = ? ORDER BY game_seat', act.activity_id);
    const winners = new Set(done ? (g.rec.result?.winnerSeats ?? []) : []);
    const summary: Record<string, unknown> = { name, outcome: done ? 'completed' : 'aborted', reason: done ? (g.rec.result?.reason ?? '') : (g.rec.abortReason ?? '中止') };
    w.db.run('UPDATE activities SET status = ?, ended_at = ?, result_json = ? WHERE activity_id = ?', done ? 'completed' : 'aborted', at, JSON.stringify({ ...summary, winnerSeats: [...winners] }), act.activity_id);
    w.cancelJob(`ad:${act.activity_id}`);
    w.cancelJob(`gt:${act.activity_id}`);
    const stayed = parts.filter((p) => p.quit_at === null);
    const date = w.today(at);
    const rewards = new Map<string, number>();
    if (done) {
      // 中途主动退出的人没有这局的记录和奖励；打完的人不论输赢都有参与奖励（每天每种游戏前几局）
      const fact = w.fact(
        'game_completed',
        stayed.map((p) => ({ id: String(p.resident_id), role: winners.has(Number(p.game_seat)) ? 'winner' : 'player' })),
        { type: g.rec.type, name, venue: act.venue_id, participants: stayed.length },
        { occurredAt: at, visibility: 'public' },
      );
      for (const p of stayed) {
        const rid = String(p.resident_id);
        const played = bumpCounter(w, `game:${rid}`, g.rec.type, date);
        const won = winners.has(Number(p.game_seat));
        const coins = played < w.params.gameRewardsPerDay ? w.params.gameParticipationReward + (won ? w.params.gameWinBonus : 0) : 0;
        if (coins > 0 && mint(w, rid, coins, `game:${act.activity_id}:${rid}`, 'game_reward')) rewards.set(rid, coins);
        const r = w.resident(rid);
        if (r) applyNeeds(w, r, { energy: -5, social: stayed.length >= 2 ? 8 : 0, interest: r.state.interests.includes('games') ? 10 : 4 }, at);
        addMood(w, rid, won ? 'happy' : 'relaxed', won ? `赢了一局${name}` : `玩了一局${name}`, fact.eventId, at);
      }
    }
    for (const p of parts) {
      const rid = String(p.resident_id);
      returnToWorld(act.activity_id, rid, at);
      const seat = Number(p.game_seat);
      // 中途退出的人没有这局的记录：座位后来被托管打赢了也不算她赢
      w.emitTo([rid], 'game_ended', { activityId: act.activity_id, gameId: g.rec.id, ...summary, won: p.quit_at === null && winners.has(seat), reward: rewards.get(rid) ?? 0 }, at);
    }
    const fresh = w.db.get('SELECT * FROM activities WHERE activity_id = ?', act.activity_id)!;
    notifyVenue(fresh, at, { ended: summary });
    w.emitPublic('activity', { activity: { id: act.activity_id, name, venue: act.venue_id, status: fresh.status, players: parts.length }, ...(done ? { text: `${placeDef(act.venue_id)?.name ?? ''}的一局${name}打完了。` } : {}) }, at);
  };

  /** 把候选记录写回数据库；结束了就结算，没结束就安排下一次到期检查，并通知有新进展的座位。 */
  const persist = (act: Row, g: Loaded, at: number, logBefore: number) => {
    const rev = g.revision + 1;
    const json = JSON.stringify(g.rec);
    const rngState = g.save();
    w.db.run('UPDATE game_records SET status = ?, revision = ?, record_json = ?, rng_state = ?, updated_at = ? WHERE activity_id = ?', g.rec.status, rev, json, rngState, at, act.activity_id);
    if (g.rec.status === 'running') w.gameCache.set(act.activity_id, { rec: g.rec, rng: rngState, revision: rev });
    else w.gameCache.delete(act.activity_id);
    g.revision = rev;
    const parts = w.db.all('SELECT resident_id, game_seat, active, quit_at FROM activity_participants WHERE activity_id = ?', act.activity_id);
    if (g.rec.status !== 'running') {
      settle(act, g, at);
      return;
    }
    const wake = nextWake(g.rec);
    if (wake !== null) w.reschedule('game_tick', `gt:${act.activity_id}`, wake, { activityId: act.activity_id });
    // 出局后确定不会再行动的座位，提前回到世界（参与奖励照旧在整局结束时发）
    for (const p of parts) {
      if (p.active === 1 && p.quit_at === null && p.game_seat !== null && w.runner.seatFinished(g.rec, env(w, g), Number(p.game_seat))) {
        returnToWorld(act.activity_id, String(p.resident_id), at);
        w.emitTo([String(p.resident_id)], 'game_out', { activityId: act.activity_id, gameId: g.rec.id, text: '你在这局里已经出局，回到了场所里。可以继续旁观。' }, at);
      }
    }
    // 只通知「有新进展」，内容由各自的视图去取：事件里不带任何座位的私密信息
    void logBefore;
    const waiting = Object.values(g.rec.phase?.pending ?? {}).filter((q) => !q.done).map((q) => q.seat);
    const secret = g.rec.phase?.secret ?? false;
    for (const p of parts) {
      if (p.active !== 1) continue;
      w.emitTo([String(p.resident_id)], 'game', { activityId: act.activity_id, gameId: g.rec.id, phaseId: g.rec.phase?.id ?? null, yourTurn: waiting.includes(Number(p.game_seat)), ...(secret ? {} : { waiting }) }, at);
    }
  };

  const abortGame = (act: Row, reason: string, at: number) => {
    const g = load(w, act.activity_id);
    if (!g || g.rec.status !== 'running') return;
    const before = g.rec.log.length;
    w.runner.abort(g.rec, env(w, g), reason);
    persist(act, g, at, before);
  };

  const closeLobby = (act: Row, reason: string, at: number) => {
    const changed = w.db.run("UPDATE activities SET status = 'aborted', ended_at = ?, result_json = ? WHERE activity_id = ? AND status = 'forming'", at, JSON.stringify({ outcome: 'aborted', reason }), act.activity_id).changes;
    if (changed !== 1) return;
    w.cancelJob(`al:${act.activity_id}`);
    notifyVenue({ ...act, status: 'aborted' }, at, { reason });
    w.db.run('UPDATE activity_participants SET active = 0 WHERE activity_id = ?', act.activity_id);
  };

  /** 离开还在凑桌的一局（走开、离线、主动退出）。发起人离开则这桌解散。 */
  const leaveLobby = (residentId: string, at: number, why: string): boolean => {
    const act = w.db.get(
      "SELECT a.* FROM activities a JOIN activity_participants p ON p.activity_id = a.activity_id WHERE p.resident_id = ? AND p.active = 1 AND a.status = 'forming'",
      residentId,
    );
    if (!act) return false;
    if (act.host_id === residentId) {
      closeLobby(act, `发起人${why}`, at);
      return true;
    }
    w.db.run('DELETE FROM activity_participants WHERE activity_id = ? AND resident_id = ?', act.activity_id, residentId);
    notifyVenue(act, at);
    return true;
  };

  /** 中途退出进行中的一局：人回到世界，座位留在局里按超时规则自动处理；所有人都走了就中止。 */
  const quitRunning = (r: ResidentRow, at: number): boolean => {
    if (!r.activity_id) return false;
    const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status = 'running'", r.activity_id);
    if (!act) return false;
    w.db.run('UPDATE activity_participants SET quit_at = COALESCE(quit_at, ?) WHERE activity_id = ? AND resident_id = ?', at, act.activity_id, r.resident_id);
    returnToWorld(act.activity_id, r.resident_id, at);
    const remaining = w.db.scalar('SELECT COUNT(*) FROM activity_participants WHERE activity_id = ? AND quit_at IS NULL', act.activity_id);
    if (remaining === 0) {
      abortGame(act, '所有玩家都离开了', at);
      return true;
    }
    const g = load(w, act.activity_id);
    if (g && g.rec.status === 'running') {
      const before = g.rec.log.length;
      w.runner.tick(g.rec, env(w, g), forfeitedSeats(w, act.activity_id));
      persist(act, g, at, before);
    }
    return true;
  };

  w.hooks.leaveSpace.push((r, _space, at) => void leaveLobby(r.resident_id, at, '离开了'));
  w.hooks.offline.push((r, at, reason) => {
    leaveLobby(r.resident_id, at, '离线了');
    // 主动离开小镇 = 退出这一局。意外断线不算退出：座位按超时规则托管，回来还能接着玩
    if (reason === 'leave') quitRunning(w.mustResident(r.resident_id), at);
  });

  // ── 凑桌 ──
  w.handlers.set('propose_game', ({ r, action, now, requestId }) => {
    const venue = w.spaceOf(r);
    const def = embeddedGameDef(String(action.game ?? ''));
    if (!def) throw badRequest('这种游戏还没有接入小镇。');
    if (!venue || !def.venues.includes(venue)) throw precondition(`这里不能玩这个。可以去：${def.venues.map((v) => placeDef(v)?.name ?? v).join('、')}。`, 'wrong_venue');
    if (w.db.get('SELECT 1 AS x FROM activity_participants WHERE resident_id = ? AND active = 1', r.resident_id)) throw precondition('你已经在一桌里了。', 'already_in_activity');
    if (w.db.scalar("SELECT COUNT(*) FROM activities WHERE venue_id = ? AND status = 'forming'", venue) >= 3) throw precondition('这里已经有好几桌在等人了，先加入一桌吧。', 'too_many_lobbies');
    const activityId = w.id('a');
    const expires = now + w.params.activityLobbyTtlMs;
    w.db.run(
      "INSERT INTO activities(activity_id, world_id, venue_id, game_type, status, host_id, options_json, origin_request_id, created_at, lobby_expires_at) VALUES (?,?,?,?,'forming',?,?,?,?,?)",
      activityId,
      w.worldId,
      venue,
      def.type,
      r.resident_id,
      JSON.stringify(def.options),
      requestId,
      now,
      expires,
    );
    w.db.run('INSERT INTO activity_participants(activity_id, resident_id, confirmed, active, joined_at) VALUES (?,?,1,1,?)', activityId, r.resident_id, now);
    w.schedule('activity_lobby_expire', `al:${activityId}`, expires, { activityId });
    const row = w.db.get('SELECT * FROM activities WHERE activity_id = ?', activityId)!;
    notifyVenue(row, now);
    return { status: 'accepted', activity: activityView(w, row) };
  });

  w.handlers.set('join_game', ({ r, action, now }) => {
    const act = w.db.get('SELECT * FROM activities WHERE activity_id = ?', String(action.activityId ?? ''));
    if (!act || act.venue_id !== w.spaceOf(r)) throw precondition('这一桌不在你身边。', 'not_here');
    if (act.status !== 'forming') throw precondition(act.status === 'running' ? '这一桌已经开局了。' : '这一桌已经散了。', 'not_open');
    if (w.db.get('SELECT 1 AS x FROM activity_participants WHERE resident_id = ? AND active = 1', r.resident_id)) throw precondition('你已经在一桌里了。', 'already_in_activity');
    const def = embeddedGameDef(act.game_type)!;
    if (w.db.scalar('SELECT COUNT(*) FROM activity_participants WHERE activity_id = ?', act.activity_id) >= def.maxPlayers) throw precondition('这一桌满了。', 'full');
    w.db.run('INSERT INTO activity_participants(activity_id, resident_id, confirmed, active, joined_at) VALUES (?,?,1,1,?)', act.activity_id, r.resident_id, now);
    notifyVenue(act, now);
    return { status: 'accepted', activity: activityView(w, act) };
  });

  w.handlers.set('leave_game_lobby', ({ r, now }) => {
    if (!leaveLobby(r.resident_id, now, '退出了')) throw precondition('你没有在等哪一桌。', 'not_in_lobby');
    return { status: 'completed' };
  });

  // ── 开局：重新确认每个人都还在场、还在这个场所，然后原子地进入小游戏上下文 ──
  w.handlers.set('start_game', ({ r, action, now }) => {
    const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status = 'forming'", String(action.activityId ?? ''));
    if (!act || act.host_id !== r.resident_id) throw precondition('只有发起人能开局，而且要还没开。', 'not_host');
    const def = embeddedGameDef(act.game_type)!;
    const members: ResidentRow[] = [];
    for (const p of w.db.all('SELECT resident_id FROM activity_participants WHERE activity_id = ? ORDER BY joined_at, resident_id', act.activity_id)) {
      const m = w.mustResident(String(p.resident_id));
      if (w.interactive(m) && w.spaceOf(m) === act.venue_id) members.push(m);
      else w.db.run('DELETE FROM activity_participants WHERE activity_id = ? AND resident_id = ?', act.activity_id, m.resident_id);
    }
    if (members.length < def.minPlayers) throw precondition(`${w.runner.def(def.type).name}至少要 ${def.minPlayers} 个人，现在在场的只有 ${members.length} 个。`, 'not_enough');
    if (w.db.scalar("SELECT COUNT(*) FROM activities WHERE world_id = ? AND status = 'running'", w.worldId) >= w.params.concurrentGames) {
      throw precondition('镇上同时进行的游戏已经到上限了，等一桌打完再开。', 'games_busy');
    }
    const gameId = `TG-${w.id('').slice(1, 9).toUpperCase()}`;
    const { rng, save } = w.gameRng(act.activity_id, null);
    const rec = w.runner.create(
      { gameId, type: def.type, worldId: w.worldId, activityId: act.activity_id, options: parseJson<Record<string, unknown>>(act.options_json, {}), entries: members.map((m) => ({ id: m.resident_id, name: m.name, kind: m.kind })) },
      { now: w.now, rng },
    );
    const deadline = now + w.params.gameMaxDurationMs;
    w.db.run("UPDATE activities SET status = 'running', game_id = ?, started_at = ?, deadline = ? WHERE activity_id = ?", gameId, now, deadline, act.activity_id);
    w.db.run('INSERT INTO game_records(game_id, activity_id, type, status, revision, record_json, rng_state, updated_at) VALUES (?,?,?,?,0,?,?,?)', gameId, act.activity_id, def.type, rec.status, JSON.stringify(rec), save(), now);
    w.cancelJob(`al:${act.activity_id}`);
    w.schedule('activity_deadline', `ad:${act.activity_id}`, deadline, { activityId: act.activity_id });
    for (const m of members) {
      // 进入小游戏前收尾：正在走的站住，没完成的交换撤销、手上的共同活动退出
      stopNav(w, m.resident_id, now, 'activity');
      for (const h of w.hooks.leaveSpace) h(m, act.venue_id, now);
      const fresh = w.mustResident(m.resident_id);
      const seat = rec.players.find((p) => p.id === m.resident_id)!.seat;
      w.db.run('UPDATE activity_participants SET game_seat = ? WHERE activity_id = ? AND resident_id = ?', seat, act.activity_id, m.resident_id);
      fresh.activity_id = act.activity_id;
      fresh.context_version += 1;
      w.saveResident(fresh);
      w.emitTo([m.resident_id], 'game_started', { activityId: act.activity_id, gameId, name: w.runner.def(def.type).name, seat }, now);
    }
    const running = w.db.get('SELECT * FROM activities WHERE activity_id = ?', act.activity_id)!;
    notifyVenue(running, now);
    w.emitPublic('activity', { activity: { id: act.activity_id, name: w.runner.def(def.type).name, venue: act.venue_id, status: 'running', players: members.length } }, now);
    const g: Loaded = { rec, rng, save, revision: 0 };
    persist(running, g, now, 0);
    return { status: 'accepted', gameId };
  });

  // ── 局内动作 ──
  w.handlers.set('game_act', ({ r, action, now }) => {
    const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status = 'running'", r.activity_id);
    const g = act ? load(w, act.activity_id) : null;
    const me = act ? w.db.get('SELECT game_seat FROM activity_participants WHERE activity_id = ? AND resident_id = ? AND active = 1', act.activity_id, r.resident_id) : undefined;
    if (!act || !g || !me || g.rec.status !== 'running') throw new WorldError('context_stale', '这局已经结束了，请重新读取视图。', undefined, { contextVersion: r.context_version, activityId: r.activity_id });
    if (action.gameId !== undefined && action.gameId !== g.rec.id) throw new WorldError('context_stale', '这不是你现在所在的那一局。', undefined, { contextVersion: r.context_version, activityId: r.activity_id });
    // 到期的阶段已经由定时任务先结算过了（命令入口先处理到期任务）：这里只认当前阶段
    const phaseId = g.rec.phase && g.rec.phase.openedAt !== null ? g.rec.phase.id : null;
    if (action.phaseId === undefined || action.phaseId === null || Number(action.phaseId) !== phaseId) {
      throw new WorldError('phase_stale', '阶段已经变了，这条动作没有执行。请重新读取这一局的视图。', undefined, { phaseId });
    }
    const input = action.input;
    if (!input || typeof input !== 'object') throw badRequest('需要 input（按视图里 todo 给出的动作格式）。');
    const before = g.rec.log.length;
    const message = w.runner.act(g.rec, env(w, g), Number(me.game_seat), input as Record<string, unknown> & { action: string }, forfeitedSeats(w, act.activity_id));
    persist(act, g, now, before);
    return { status: 'completed', text: message, gameStatus: g.rec.status };
  });

  w.handlers.set('quit_game', ({ r, now }) => {
    if (!quitRunning(r, now)) throw new WorldError('context_stale', '你现在不在一局游戏里。', undefined, { contextVersion: r.context_version, activityId: r.activity_id });
    return { status: 'completed', text: '你离开了这一局，回到了场所里。座位会按超时规则自动处理。' };
  });

  // ── 定时任务 ──
  const tickOne = (activityId: string, at: number) => {
    const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status = 'running'", activityId);
    const g = act ? load(w, activityId) : null;
    if (!act || !g) return;
    const before = g.rec.log.length;
    if (g.rec.status !== 'running') {
      settle(act, g, at);
      return;
    }
    if (w.runner.tick(g.rec, env(w, g), forfeitedSeats(w, activityId))) persist(act, g, at, before);
    else {
      const wake = nextWake(g.rec);
      if (wake !== null && wake > at) w.reschedule('game_tick', `gt:${activityId}`, wake, { activityId });
    }
  };

  w.jobHandlers.set('game_tick', (payload, _job, now) => tickOne(String(payload.activityId), now));

  w.jobHandlers.set('activity_lobby_expire', (payload, _job, now) => {
    const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status = 'forming'", String(payload.activityId));
    if (act) closeLobby(act, '等了太久没凑齐人', Math.min(now, Number(act.lobby_expires_at)));
  });

  // 绝对时限：一局不会无限占着桌子
  w.jobHandlers.set('activity_deadline', (payload, _job, now) => {
    const act = w.db.get("SELECT * FROM activities WHERE activity_id = ? AND status = 'running'", String(payload.activityId));
    if (act) abortGame(act, '超过了一局的最长时间', Math.min(now, Number(act.deadline ?? now)));
  });

  // 兜底：每次 tick 看一眼进行中的局（阶段开放、最短时长这类不靠截止时间的推进）
  w.hooks.tick.push((now) => {
    for (const act of w.db.all("SELECT activity_id FROM activities WHERE world_id = ? AND status = 'running'", w.worldId)) {
      try {
        w.commit(() => tickOne(String(act.activity_id), now));
      } catch (e) {
        w.log(`[town] 小游戏 ${act.activity_id} 推进出错：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  // 重启恢复：短暂中断的局把截止时间顺延后继续；长时间中断的局中止（没有胜负和奖励），已经打完的照常结算
  w.hooks.recover.push((downtime, now) => {
    w.gameCache.clear();
    for (const act of w.db.all("SELECT * FROM activities WHERE world_id = ? AND status = 'running'", w.worldId)) {
      const g = load(w, act.activity_id);
      if (!g) {
        w.db.run("UPDATE activities SET status = 'aborted', ended_at = ?, result_json = ? WHERE activity_id = ?", now, JSON.stringify({ outcome: 'aborted', reason: '记录缺失' }), act.activity_id);
        for (const p of w.db.all('SELECT resident_id FROM activity_participants WHERE activity_id = ?', act.activity_id)) returnToWorld(act.activity_id, String(p.resident_id), now);
        continue;
      }
      if (g.rec.status !== 'running') {
        settle(act, g, now);
        continue;
      }
      if (downtime > w.params.shortOutageLimitMs) {
        abortGame(act, '服务器中断太久，这局没法公平地继续', now);
        continue;
      }
      // 活动自身的绝对截止时间已在停机期间过去：按超时中止，不再顺延
      if (act.deadline !== null && act.deadline !== undefined && Number(act.deadline) <= now) {
        abortGame(act, '超过了一局的最长时间', Number(act.deadline));
        continue;
      }
      const before = g.rec.log.length;
      if (g.rec.phase?.deadline) g.rec.phase.deadline += downtime;
      w.db.run('UPDATE activities SET deadline = deadline + ? WHERE activity_id = ?', downtime, act.activity_id);
      w.reschedule('activity_deadline', `ad:${act.activity_id}`, Number(act.deadline ?? now) + downtime, { activityId: act.activity_id });
      persist(act, g, now, before);
    }
  });
}
