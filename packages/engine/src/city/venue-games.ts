/**
 * 灯都 M3-B：桌游茶屋同店成局 + 旧物密封竞拍会。
 */
import type { GameEnv } from '../core/game.js';
import type { EmbeddedEntry, EmbeddedSeatView } from '../core/runner.js';
import { GameRunner, todoOf } from '../core/runner.js';
import type { GameRecord, Seat } from '../core/types.js';
import { createRegistry } from '../games/index.js';
import { parseJson, type Row } from '../world/db.js';
import { localParts, localToUtc, nextDate } from '../world/time.js';
import { CityError, cityBadRequest, cityPrecondition } from './errors.js';
import { AUCTION_ESCROW, SHOPS, ledger, purseOf, wallet } from './ledger.js';
import { card } from './residents.js';
import type { CityResident, CityService } from './service.js';
import { spendable } from './trips.js';
import { openVisitOf, type VisitRow } from './visits.js';

export const BOARDGAME_CHAYA_ID = 'kagamiike:boardgame-chaya';
export const AUCTION_HOUSE_RESIDENT = 'res:auction_house';
export const AUCTION_SLOT_MINUTES = 15;
export const VENUE_GAME_TYPES = new Set(['liars_dice', 'color_chain']);
export const VENUE_ACTIONS = [
  'open_table',
  'join_table',
  'start_table',
  'game_act',
  'leave_table',
  'auction_bid',
  'auction_view',
] as const;

const sharedRunner = new GameRunner(createRegistry());

function nextWake(rec: GameRecord): number | null {
  const ph = rec.phase;
  if (rec.status !== 'running' || !ph || ph.openedAt === null) return null;
  const times = [ph.deadline, ph.minDurationMs > 0 ? ph.openedAt + ph.minDurationMs : null].filter((t): t is number => t !== null);
  return times.length ? Math.min(...times) : null;
}

interface AuctionCatalogTemplate {
  key: string;
  itemType: string;
  itemName: string;
  edition: string;
  provenance: string;
  reserveYen: number;
  priceMode: 'first' | 'second';
}

const DAILY_AUCTION_POOL: readonly AuctionCatalogTemplate[] = [
  {
    key: 'rare-poem-1954',
    itemType: 'paperback',
    itemName: '古书店稀有旧书·初版诗集《雨夜抄》',
    edition: '1954年限定初版・带函套',
    provenance: '镜池旧书肆流转孤本',
    reserveYen: 300,
    priceMode: 'first',
  },
  {
    key: 'showa-brass-lamp',
    itemType: 'antique_curio',
    itemName: '昭和古董台灯摆件·琥珀玻璃罩',
    edition: '昭和三十年代黄铜底座孤品',
    provenance: '路地裏茶屋寄售旧物',
    reserveYen: 500,
    priceMode: 'first',
  },
  {
    key: 'toto-tram-map',
    itemType: 'paperback',
    itemName: '手绘灯都旧电车路线折页孤本',
    edition: '手绘石版复刻・编号01',
    provenance: '镜池东口旧货市集',
    reserveYen: 250,
    priceMode: 'second',
  },
];

interface TableRow {
  table_id: string;
  place_id: string;
  game_type: string;
  options_json: string;
  status: 'forming' | 'running' | 'completed' | 'aborted';
  host_id: string;
  game_id: string | null;
  record_json: string | null;
  rng_state: string | null;
  revision: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  abort_reason: string | null;
}

interface SeatRow {
  table_id: string;
  resident_id: string;
  game_seat: number | null;
  joined_at: number;
  left_at: number | null;
  leave_reason: string | null;
}

interface AuctionRow {
  auction_id: string;
  place_id: string;
  item_id: string;
  item_name: string;
  item_type: string;
  reserve_yen: number;
  price_mode: 'first' | 'second';
  status: 'open' | 'settled' | 'unsold' | 'cancelled';
  opens_at: number;
  closes_at: number;
  settled_at: number | null;
  winner_id: string | null;
  winning_price: number | null;
  tie_broken: number;
  created_at: number;
}

interface BidRow {
  auction_id: string;
  resident_id: string;
  bid_yen: number;
  held_yen: number;
  visit_id: string | null;
  status: 'active' | 'withdrawn' | 'won' | 'lost' | 'refunded';
  placed_at: number;
  updated_at: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function assertAtVenue(r: CityResident, placeId: string): void {
  if (r.in_city !== 1) throw cityPrecondition('你现在不在城里。', 'not_in_city');
  if (r.trip_id || !r.place_id) throw cityPrecondition('你还在路上，到了再说。', 'in_transit');
  if (r.place_id !== placeId) throw cityPrecondition('必须先来到同一间桌游茶屋内才能参与。', 'not_at_venue', { required_place: placeId, current_place: r.place_id });
}

function activeSeatOfResident(c: CityService, residentId: string): (SeatRow & { place_id: string; status: TableRow['status'] }) | undefined {
  return c.db.get<(SeatRow & { place_id: string; status: TableRow['status'] }) & Row>(
    `SELECT s.*, t.place_id, t.status
     FROM venue_table_seats s
     JOIN venue_tables t ON t.table_id = s.table_id
     WHERE s.resident_id = ? AND s.left_at IS NULL AND t.status IN ('forming','running')
     LIMIT 1`,
    residentId,
  );
}

function activeSeatsOfTable(c: CityService, tableId: string): SeatRow[] {
  return c.db.all<SeatRow & Row>(
    'SELECT * FROM venue_table_seats WHERE table_id = ? AND left_at IS NULL ORDER BY joined_at, resident_id',
    tableId,
  );
}

function forfeitedSeatsOfTable(c: CityService, tableId: string): Set<Seat> {
  return new Set(
    c.db
      .all<{ game_seat: number } & Row>(
        'SELECT game_seat FROM venue_table_seats WHERE table_id = ? AND left_at IS NOT NULL AND game_seat IS NOT NULL',
        tableId,
      )
      .map((row) => Number(row.game_seat)),
  );
}

function scheduleTableTick(c: CityService, tableId: string, rec: GameRecord): void {
  const due = nextWake(rec);
  if (due !== null) c.reschedule('venue_table_tick', `venue:table:${tableId}:tick`, due, { tableId });
  else c.cancelJob(`venue:table:${tableId}:tick`);
}

function notifyTableParticipants(c: CityService, tableId: string, type: string, data: Record<string, unknown>, at: number): void {
  const targets = activeSeatsOfTable(c, tableId).map((s) => s.resident_id);
  if (targets.length > 0) c.emitTo(targets, type, data, at);
}

function notifyTableAndVenue(
  c: CityService,
  placeId: string,
  participantIds: readonly string[],
  type: string,
  data: Record<string, unknown>,
  at: number,
): void {
  const targets = [...new Set([...participantIds, ...c.presentAt(placeId).map((x) => x.resident_id)])];
  if (targets.length > 0) c.emitTo(targets, type, data, at);
}

function finalizeTableIfDone(c: CityService, table: TableRow, rec: GameRecord, at: number): boolean {
  if (rec.status === 'running') return false;
  const status = rec.status === 'aborted' ? 'aborted' : 'completed';
  c.db.run(
    'UPDATE venue_tables SET status = ?, record_json = ?, ended_at = ?, revision = revision + 1 WHERE table_id = ?',
    status,
    JSON.stringify(rec),
    at,
    table.table_id,
  );
  c.cancelJob(`venue:table:${table.table_id}:tick`);
  const remaining = activeSeatsOfTable(c, table.table_id);
  c.db.run(
    'UPDATE venue_table_seats SET left_at = ?, leave_reason = COALESCE(leave_reason, ?) WHERE table_id = ? AND left_at IS NULL',
    at,
    status === 'aborted' ? 'table_aborted' : 'game_completed',
    table.table_id,
  );
  notifyTableAndVenue(
    c,
    table.place_id,
    remaining.map((s) => s.resident_id),
    'venue_table_ended',
    {
      table_id: table.table_id,
      place_id: table.place_id,
      game: table.game_type,
      status,
      winner_seats: rec.result?.winnerSeats ?? [],
      winner_team: rec.result?.winnerTeam ?? '',
      reason: rec.result?.reason ?? '',
    },
    at,
  );
  return true;
}

function runTableTick(c: CityService, tableId: string, at: number): void {
  const table = c.db.get<TableRow & Row>('SELECT * FROM venue_tables WHERE table_id = ?', tableId);
  if (!table || table.status !== 'running' || !table.record_json) return;
  const rec = JSON.parse(table.record_json) as GameRecord;
  const forfeited = forfeitedSeatsOfTable(c, tableId);
  const env: GameEnv = { now: () => at, rng: c.rng };
  const changed = sharedRunner.tick(rec, env, forfeited);
  if (finalizeTableIfDone(c, table, rec, at)) return;
  if (changed) {
    c.db.run('UPDATE venue_tables SET record_json = ?, revision = revision + 1 WHERE table_id = ?', JSON.stringify(rec), tableId);
    notifyTableParticipants(c, tableId, 'venue_table_updated', { table_id: tableId, round: rec.round, phase: rec.phase?.key ?? null }, at);
  }
  scheduleTableTick(c, tableId, rec);
}

function leaveTableCore(c: CityService, residentId: string, reason: string, at: number): void {
  const seat = activeSeatOfResident(c, residentId);
  if (!seat) return;
  const table = c.db.get<TableRow & Row>('SELECT * FROM venue_tables WHERE table_id = ?', seat.table_id);
  if (!table) return;
  c.db.run(
    'UPDATE venue_table_seats SET left_at = ?, leave_reason = ? WHERE table_id = ? AND resident_id = ?',
    at,
    reason,
    table.table_id,
    residentId,
  );
  const remaining = activeSeatsOfTable(c, table.table_id);
  if (table.status === 'forming') {
    if (remaining.length === 0) {
      c.db.run(
        "UPDATE venue_tables SET status = 'aborted', ended_at = ?, abort_reason = ?, revision = revision + 1 WHERE table_id = ?",
        at,
        reason,
        table.table_id,
      );
    } else if (table.host_id === residentId) {
      c.db.run('UPDATE venue_tables SET host_id = ?, revision = revision + 1 WHERE table_id = ?', remaining[0]!.resident_id, table.table_id);
    }
    notifyTableAndVenue(
      c,
      table.place_id,
      remaining.map((s) => s.resident_id),
      'venue_table_left',
      { table_id: table.table_id, resident_id: residentId, reason },
      at,
    );
    return;
  }
  if (table.status === 'running' && table.record_json) {
    const rec = JSON.parse(table.record_json) as GameRecord;
    const env: GameEnv = { now: () => at, rng: c.rng };
    if (remaining.length === 0) {
      sharedRunner.abort(rec, env, `all_left:${reason}`);
      finalizeTableIfDone(c, table, rec, at);
      return;
    }
    const forfeited = forfeitedSeatsOfTable(c, table.table_id);
    sharedRunner.tick(rec, env, forfeited);
    if (finalizeTableIfDone(c, table, rec, at)) return;
    c.db.run('UPDATE venue_tables SET record_json = ?, revision = revision + 1 WHERE table_id = ?', JSON.stringify(rec), table.table_id);
    scheduleTableTick(c, table.table_id, rec);
    notifyTableAndVenue(
      c,
      table.place_id,
      remaining.map((s) => s.resident_id),
      'venue_table_left',
      { table_id: table.table_id, resident_id: residentId, reason },
      at,
    );
  }
}

function doOpenTable(c: CityService, r: CityResident, a: Record<string, unknown>, at: number): Record<string, unknown> {
  assertAtVenue(r, BOARDGAME_CHAYA_ID);
  if (activeSeatOfResident(c, r.resident_id)) {
    throw cityPrecondition('你已经坐在一张牌桌上了，先退出当前牌桌再开新桌。', 'already_seated');
  }
  const game = str(a.game) || 'liars_dice';
  if (!VENUE_GAME_TYPES.has(game)) {
    throw cityBadRequest('桌游茶屋目前支持：liars_dice（大话骰）、color_chain（彩牌接龙）。', 'unsupported_game');
  }
  const def = sharedRunner.def(game);
  const rawOptions = a.options && typeof a.options === 'object' && !Array.isArray(a.options) ? (a.options as Record<string, unknown>) : {};
  const parsed = def.optionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw cityBadRequest(`牌桌选项无效：${parsed.error.issues.map((i) => i.message).join('；')}`, 'invalid_options');
  }
  const tableId = c.id('tbl');
  c.db.run(
    "INSERT INTO venue_tables(table_id, place_id, game_type, options_json, status, host_id, created_at) VALUES (?,?,?,?,'forming',?,?)",
    tableId,
    BOARDGAME_CHAYA_ID,
    game,
    JSON.stringify(parsed.data),
    r.resident_id,
    at,
  );
  c.db.run('INSERT INTO venue_table_seats(table_id, resident_id, joined_at) VALUES (?,?,?)', tableId, r.resident_id, at);
  c.emitTo(
    c.presentAt(BOARDGAME_CHAYA_ID).map((x) => x.resident_id),
    'venue_table_opened',
    { table_id: tableId, place_id: BOARDGAME_CHAYA_ID, game, name: def.name, host: card(r) },
    at,
  );
  return { status: 'completed', table_id: tableId, game, min_players: def.minPlayers, max_players: def.maxPlayers };
}

function doJoinTable(c: CityService, r: CityResident, a: Record<string, unknown>, at: number): Record<string, unknown> {
  assertAtVenue(r, BOARDGAME_CHAYA_ID);
  if (activeSeatOfResident(c, r.resident_id)) {
    throw cityPrecondition('你已经坐在一张牌桌上了。', 'already_seated');
  }
  const requestedId = str(a.table_id);
  let table: TableRow | undefined;
  if (requestedId) {
    table = c.db.get<TableRow & Row>('SELECT * FROM venue_tables WHERE table_id = ?', requestedId);
  } else {
    const forming = c.db.all<TableRow & Row>(
      "SELECT * FROM venue_tables WHERE place_id = ? AND status = 'forming' ORDER BY created_at",
      BOARDGAME_CHAYA_ID,
    );
    if (forming.length === 1) table = forming[0];
    else if (forming.length > 1) throw cityBadRequest('茶屋里有多张凑桌中的牌桌，请指定 table_id。', 'ambiguous_table');
  }
  if (!table || table.place_id !== BOARDGAME_CHAYA_ID) throw new CityError('NOT_FOUND', '没有这张牌桌。', 'no_such_table');
  if (table.status !== 'forming') throw cityPrecondition('这张牌桌已经开局或结束了。', 'table_not_forming');
  const def = sharedRunner.def(table.game_type);
  const seats = activeSeatsOfTable(c, table.table_id);
  if (seats.length >= def.maxPlayers) throw cityPrecondition('这张牌桌已经满员了。', 'table_full');
  c.db.run(
    'INSERT OR REPLACE INTO venue_table_seats(table_id, resident_id, game_seat, joined_at, left_at, leave_reason) VALUES (?,?,NULL,?,NULL,NULL)',
    table.table_id,
    r.resident_id,
    at,
  );
  notifyTableAndVenue(
    c,
    table.place_id,
    activeSeatsOfTable(c, table.table_id).map((s) => s.resident_id),
    'venue_table_joined',
    { table_id: table.table_id, who: card(r) },
    at,
  );
  return { status: 'completed', table_id: table.table_id, players: seats.length + 1 };
}

function doStartTable(c: CityService, r: CityResident, a: Record<string, unknown>, at: number): Record<string, unknown> {
  assertAtVenue(r, BOARDGAME_CHAYA_ID);
  const mySeat = activeSeatOfResident(c, r.resident_id);
  const tableId = str(a.table_id) || mySeat?.table_id || '';
  if (!tableId) throw cityPrecondition('你当前不在任何牌桌上，请先开桌或入座。', 'not_seated');
  const table = c.db.get<TableRow & Row>('SELECT * FROM venue_tables WHERE table_id = ?', tableId);
  if (!table || table.place_id !== BOARDGAME_CHAYA_ID) throw new CityError('NOT_FOUND', '没有这张牌桌。', 'no_such_table');
  if (table.status !== 'forming') throw cityPrecondition('这张牌桌不在等待开局状态。', 'table_not_forming');
  const seats = activeSeatsOfTable(c, table.table_id);
  if (!seats.some((s) => s.resident_id === r.resident_id)) throw cityPrecondition('只有同桌在座的人才能开局。', 'not_seated');
  for (const s of seats) {
    const p = c.mustResident(s.resident_id);
    if (p.in_city !== 1 || p.trip_id || p.place_id !== table.place_id) {
      throw cityPrecondition(`${p.name}已经不在茶屋里了。`, 'player_not_at_venue');
    }
  }
  const entries: EmbeddedEntry[] = seats.map((s) => {
    const p = c.mustResident(s.resident_id);
    return { id: p.resident_id, name: p.name, kind: p.origin === 'human' ? 'human' : 'agent' };
  });
  const gameId = c.id('vg');
  const env: GameEnv = { now: () => at, rng: c.rng };
  let rec: GameRecord;
  try {
    rec = sharedRunner.create(
      {
        gameId,
        worldId: c.worldId,
        activityId: table.table_id,
        type: table.game_type,
        options: parseJson<Record<string, unknown>>(table.options_json, {}),
        entries,
      },
      env,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw cityPrecondition(msg, 'cannot_start_table');
  }
  for (const p of rec.players) {
    c.db.run('UPDATE venue_table_seats SET game_seat = ? WHERE table_id = ? AND resident_id = ?', p.seat, table.table_id, p.id);
  }
  c.db.run(
    "UPDATE venue_tables SET status = 'running', game_id = ?, record_json = ?, started_at = ?, revision = revision + 1 WHERE table_id = ?",
    gameId,
    JSON.stringify(rec),
    at,
    table.table_id,
  );
  scheduleTableTick(c, table.table_id, rec);
  notifyTableAndVenue(
    c,
    table.place_id,
    seats.map((s) => s.resident_id),
    'venue_table_started',
    { table_id: table.table_id, game: table.game_type, game_id: gameId },
    at,
  );
  return { status: 'completed', table_id: table.table_id, game: table.game_type, game_id: gameId };
}

function doGameAct(c: CityService, r: CityResident, a: Record<string, unknown>, at: number): Record<string, unknown> {
  assertAtVenue(r, BOARDGAME_CHAYA_ID);
  const mySeat = activeSeatOfResident(c, r.resident_id);
  const tableId = str(a.table_id) || mySeat?.table_id || '';
  if (!mySeat || mySeat.table_id !== tableId) throw cityPrecondition('你当前不在进行中的牌桌上。', 'not_seated');
  const table = c.db.get<TableRow & Row>('SELECT * FROM venue_tables WHERE table_id = ?', tableId);
  if (!table || table.status !== 'running' || !table.record_json) throw cityPrecondition('这张牌桌没有在进行中。', 'table_not_running');
  if (mySeat.game_seat === null) throw cityPrecondition('座位还没有分配。', 'no_seat');
  const rec = JSON.parse(table.record_json) as GameRecord;
  const forfeited = forfeitedSeatsOfTable(c, table.table_id);
  const env: GameEnv = { now: () => at, rng: c.rng };
  const rawInput = (a.input && typeof a.input === 'object' && !Array.isArray(a.input) ? a.input : a) as Record<string, unknown>;
  const actionName = str(rawInput.game_action ?? rawInput.move ?? rawInput.action);
  if (!actionName || actionName === 'game_act') throw cityBadRequest('请指定游戏动作。', 'missing_game_action');
  let message: string;
  try {
    message = sharedRunner.act(rec, env, mySeat.game_seat, { ...rawInput, action: actionName } as never, forfeited);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw cityBadRequest(msg, 'invalid_game_action');
  }
  const done = finalizeTableIfDone(c, table, rec, at);
  if (!done) {
    c.db.run('UPDATE venue_tables SET record_json = ?, revision = revision + 1 WHERE table_id = ?', JSON.stringify(rec), table.table_id);
    scheduleTableTick(c, table.table_id, rec);
    notifyTableParticipants(c, table.table_id, 'venue_table_updated', { table_id: table.table_id, round: rec.round, phase: rec.phase?.key ?? null }, at);
  }
  return { status: 'completed', table_id: table.table_id, message, game_status: rec.status };
}

function doLeaveTable(c: CityService, r: CityResident, at: number): Record<string, unknown> {
  const seat = activeSeatOfResident(c, r.resident_id);
  if (!seat) throw cityPrecondition('你当前不在任何牌桌上。', 'not_seated');
  leaveTableCore(c, r.resident_id, 'self_leave', at);
  return { status: 'completed', table_id: seat.table_id };
}

export function ensureAuctionHouse(c: CityService): void {
  const now = c.now();
  c.db.run(
    "INSERT OR IGNORE INTO principals(principal_id, provider, subject, kind, display_name, created_at) VALUES ('prin:auction_house','system','auction_house','agent','旧物竞拍行',?)",
    now,
  );
  c.db.run(
    "INSERT OR IGNORE INTO residents(resident_id, principal_id, name, bio, origin, in_city, created_at, last_seen_at) VALUES (?,'prin:auction_house','旧物竞拍行','','external',0,?,?)",
    AUCTION_HOUSE_RESIDENT,
    now,
    now,
  );
}

export interface CreateAuctionInput {
  auctionId?: string;
  placeId?: string;
  itemId?: string;
  itemType: string;
  itemName: string;
  reserveYen: number;
  priceMode?: 'first' | 'second';
  opensAt?: number;
  closesAt: number;
  meta?: Record<string, unknown>;
}

export function createVenueAuction(c: CityService, input: CreateAuctionInput, at?: number): AuctionRow {
  return c.commit(() => {
    ensureAuctionHouse(c);
    const now = at ?? c.now();
    const placeId = input.placeId ?? BOARDGAME_CHAYA_ID;
    const auctionId = input.auctionId ?? c.id('auc');
    const itemId = input.itemId ?? c.id('curio');
    const meta = { domain: 'city_auction', title: input.itemName, auction_id: auctionId, ...(input.meta ?? {}) };
    c.db.run(
      "INSERT OR IGNORE INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?, ?, ?, 1, 1, NULL, NULL, ?, NULL, NULL, 'space', ?, ?)",
      itemId,
      AUCTION_HOUSE_RESIDENT,
      input.itemType,
      JSON.stringify(meta),
      now,
      now,
    );
    c.db.run(
      "INSERT INTO venue_auctions(auction_id, place_id, item_id, item_name, item_type, reserve_yen, price_mode, status, opens_at, closes_at, created_at) VALUES (?,?,?,?,?,?,?,'open',?,?,?)",
      auctionId,
      placeId,
      itemId,
      input.itemName,
      input.itemType,
      input.reserveYen,
      input.priceMode ?? 'first',
      input.opensAt ?? now,
      input.closesAt,
      now,
    );
    c.reschedule('venue_auction_settle', `venue:auction:${auctionId}:settle`, input.closesAt, { auctionId });
    const present = c.presentAt(placeId).map((x) => x.resident_id);
    if (present.length > 0) {
      c.emitTo(
        present,
        'auction_opened',
        {
          auction_id: auctionId,
          place_id: placeId,
          item_id: itemId,
          item_name: input.itemName,
          reserve_yen: input.reserveYen,
          closes_at_ms: input.closesAt,
        },
        now,
      );
    }
    return c.db.get<AuctionRow & Row>('SELECT * FROM venue_auctions WHERE auction_id = ?', auctionId)!;
  });
}

export function ensureDailyAuctions(c: CityService, at: number): void {
  c.commit(() => {
    ensureAuctionHouse(c);
    const openCount = c.db.scalar("SELECT COUNT(*) FROM venue_auctions WHERE place_id = ? AND status = 'open' AND closes_at > ?", BOARDGAME_CHAYA_ID, at);
    if (openCount > 0) return;
    const lp = localParts(c.params.timezone, at);
    const day = lp.date;
    const slotIdx = Math.floor((lp.hour * 60 + lp.minute) / AUCTION_SLOT_MINUTES);
    const startMin = slotIdx * AUCTION_SLOT_MINUTES;
    const endMin = (slotIdx + 1) * AUCTION_SLOT_MINUTES;
    const opensAt = localToUtc(c.params.timezone, day, Math.floor(startMin / 60), startMin % 60);
    const closesAt =
      endMin < 1440
        ? localToUtc(c.params.timezone, day, Math.floor(endMin / 60), endMin % 60)
        : localToUtc(c.params.timezone, nextDate(day), 0, 0);
    if (closesAt <= at) return;
    const dayHash = [...day].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const tpl = DAILY_AUCTION_POOL[(dayHash + slotIdx) % DAILY_AUCTION_POOL.length]!;
    const slotTag = String(slotIdx).padStart(2, '0');
    const auctionId = `auc:${day}:s${slotTag}:${tpl.key}`;
    const existing = c.db.get('SELECT 1 AS x FROM venue_auctions WHERE auction_id = ?', auctionId);
    if (existing) return;
    createVenueAuction(
      c,
      {
        auctionId,
        placeId: BOARDGAME_CHAYA_ID,
        itemId: `curio:${day}:s${slotTag}:${tpl.key}`,
        itemType: tpl.itemType,
        itemName: tpl.itemName,
        reserveYen: tpl.reserveYen,
        priceMode: tpl.priceMode,
        opensAt,
        closesAt,
        meta: { edition: tpl.edition, provenance: tpl.provenance },
      },
      at,
    );
  });
}

function withdrawAuctionBids(c: CityService, residentId: string, reason: string, at: number): void {
  const bids = c.db.all<(BidRow & { item_name: string }) & Row>(
    `SELECT b.*, a.item_name
     FROM venue_auction_bids b
     JOIN venue_auctions a ON a.auction_id = b.auction_id
     WHERE b.resident_id = ? AND b.status = 'active' AND a.status = 'open'`,
    residentId,
  );
  for (const b of bids) {
    if (b.held_yen > 0) {
      ledger(
        c,
        `auction:withdraw:${b.auction_id}:${residentId}:${at}`,
        'auction_refund',
        `竞拍撤回解冻：${b.item_name}`,
        [[AUCTION_ESCROW, -b.held_yen], [purseOf(residentId), b.held_yen]],
        b.visit_id,
      );
    }
    c.db.run(
      "UPDATE venue_auction_bids SET status = 'withdrawn', held_yen = 0, updated_at = ? WHERE auction_id = ? AND resident_id = ?",
      at,
      b.auction_id,
      residentId,
    );
    c.emitTo([residentId], 'auction_withdrawn', { auction_id: b.auction_id, reason, refunded_yen: b.held_yen }, at);
  }
}

export function settleVenueAuction(c: CityService, auctionId: string, at: number): AuctionRow {
  return c.commit(() => {
    const auction = c.db.get<AuctionRow & Row>('SELECT * FROM venue_auctions WHERE auction_id = ?', auctionId);
    if (!auction) throw new CityError('NOT_FOUND', '没有这场竞拍会。', 'no_such_auction');
    if (auction.status !== 'open') return auction;
    c.cancelJob(`venue:auction:${auctionId}:settle`);

    const activeBids = c.db.all<BidRow & Row>(
      "SELECT * FROM venue_auction_bids WHERE auction_id = ? AND status = 'active' ORDER BY bid_yen DESC, placed_at ASC, resident_id ASC",
      auctionId,
    );
    const validBids = activeBids.filter((b) => b.bid_yen >= auction.reserve_yen);
    if (validBids.length === 0) {
      for (const b of activeBids) {
        if (b.held_yen > 0) {
          ledger(
            c,
            `auction:unsold:${auctionId}:${b.resident_id}`,
            'auction_refund',
            `竞拍流拍解冻：${auction.item_name}`,
            [[AUCTION_ESCROW, -b.held_yen], [purseOf(b.resident_id), b.held_yen]],
            b.visit_id,
          );
        }
        c.db.run("UPDATE venue_auction_bids SET status = 'refunded', held_yen = 0, updated_at = ? WHERE auction_id = ? AND resident_id = ?", at, auctionId, b.resident_id);
      }
      c.db.run("UPDATE venue_auctions SET status = 'unsold', settled_at = ? WHERE auction_id = ?", at, auctionId);
      const unsoldTargets = [...new Set([...activeBids.map((b) => b.resident_id), ...c.presentAt(auction.place_id).map((x) => x.resident_id)])];
      if (unsoldTargets.length > 0) {
        c.emitTo(
          unsoldTargets,
          'auction_unsold',
          { auction_id: auctionId, place_id: auction.place_id, item_id: auction.item_id, item_name: auction.item_name },
          at,
        );
      }
      if (auction.place_id === BOARDGAME_CHAYA_ID && c.headcount(BOARDGAME_CHAYA_ID) > 0) ensureDailyAuctions(c, at);
      return c.db.get<AuctionRow & Row>('SELECT * FROM venue_auctions WHERE auction_id = ?', auctionId)!;
    }

    const topBid = validBids[0]!.bid_yen;
    const tied = validBids.filter((b) => b.bid_yen === topBid);
    const tieBroken = tied.length > 1 ? 1 : 0;
    const winner = tied[tied.length > 1 ? c.rng.int(tied.length) : 0]!;
    const others = activeBids.filter((b) => b.resident_id !== winner.resident_id);
    const secondHighest = others.length > 0 ? Math.max(auction.reserve_yen, ...others.map((b) => b.bid_yen)) : auction.reserve_yen;
    const price = auction.price_mode === 'second' && others.length > 0 ? Math.min(winner.bid_yen, secondHighest) : winner.bid_yen;

    const refundWinner = winner.held_yen - price;
    if (refundWinner > 0) {
      ledger(
        c,
        `auction:diff:${auctionId}:${winner.resident_id}`,
        'auction_refund',
        `竞拍二价退差：${auction.item_name}`,
        [[AUCTION_ESCROW, -refundWinner], [purseOf(winner.resident_id), refundWinner]],
        winner.visit_id,
      );
    }
    if (price > 0) {
      ledger(
        c,
        `auction:settle:${auctionId}`,
        'auction_settle',
        `竞拍成交：${auction.item_name}`,
        [[AUCTION_ESCROW, -price], [SHOPS, price]],
        winner.visit_id,
      );
    }
    c.db.run("UPDATE venue_auction_bids SET status = 'won', held_yen = 0, updated_at = ? WHERE auction_id = ? AND resident_id = ?", at, auctionId, winner.resident_id);

    const winnerResident = c.mustResident(winner.resident_id);
    const winnerVisitId = winnerResident.origin === 'house' ? (openVisitOf(c, winner.resident_id)?.visit_id ?? winner.visit_id) : null;
    c.db.run(
      "UPDATE items SET owner_id = ?, state = 'held', visit_id = ?, updated_at = ? WHERE item_id = ?",
      winner.resident_id,
      winnerVisitId,
      at,
      auction.item_id,
    );
    c.db.run(
      "INSERT INTO item_events(visit_id, resident_id, item_id, type, origin_ref, quantity, fate, counterparty, at) VALUES (?,?,?,?,?,1,'acquired',?,?)",
      winnerVisitId,
      winner.resident_id,
      auction.item_id,
      auction.item_type,
      null,
      `auction:${auctionId}`,
      at,
    );

    for (const b of others) {
      if (b.held_yen > 0) {
        ledger(
          c,
          `auction:lost:${auctionId}:${b.resident_id}`,
          'auction_refund',
          `竞拍未中标解冻：${auction.item_name}`,
          [[AUCTION_ESCROW, -b.held_yen], [purseOf(b.resident_id), b.held_yen]],
          b.visit_id,
        );
      }
      c.db.run("UPDATE venue_auction_bids SET status = 'lost', held_yen = 0, updated_at = ? WHERE auction_id = ? AND resident_id = ?", at, auctionId, b.resident_id);
    }

    c.db.run(
      "UPDATE venue_auctions SET status = 'settled', settled_at = ?, winner_id = ?, winning_price = ?, tie_broken = ? WHERE auction_id = ?",
      at,
      winner.resident_id,
      price,
      tieBroken,
      auctionId,
    );
    const bidderIds = activeBids.map((b) => b.resident_id);
    const bidderSet = new Set(bidderIds);
    c.emitTo(
      bidderIds,
      'auction_settled',
      {
        auction_id: auctionId,
        place_id: auction.place_id,
        item_id: auction.item_id,
        item_name: auction.item_name,
        winner: card(winnerResident),
        winning_price: price,
        tie_broken: tieBroken === 1,
      },
      at,
    );
    const bystanders = c
      .presentAt(auction.place_id)
      .map((x) => x.resident_id)
      .filter((id) => !bidderSet.has(id));
    if (bystanders.length > 0) {
      c.emitTo(
        bystanders,
        'auction_closed',
        {
          auction_id: auctionId,
          place_id: auction.place_id,
          item_id: auction.item_id,
          item_name: auction.item_name,
          status: 'settled',
        },
        at,
      );
    }
    if (auction.place_id === BOARDGAME_CHAYA_ID && c.headcount(BOARDGAME_CHAYA_ID) > 0) ensureDailyAuctions(c, at);
    return c.db.get<AuctionRow & Row>('SELECT * FROM venue_auctions WHERE auction_id = ?', auctionId)!;
  });
}

function doAuctionBid(c: CityService, r: CityResident, a: Record<string, unknown>, at: number, visit: VisitRow | null): Record<string, unknown> {
  ensureDailyAuctions(c, at);
  const auctionId = str(a.auction_id);
  let auction: AuctionRow | undefined;
  if (auctionId) {
    auction = c.db.get<AuctionRow & Row>('SELECT * FROM venue_auctions WHERE auction_id = ?', auctionId);
  } else {
    assertAtVenue(r, BOARDGAME_CHAYA_ID);
    const openList = c.db.all<AuctionRow & Row>(
      "SELECT * FROM venue_auctions WHERE place_id = ? AND status = 'open' AND closes_at > ? ORDER BY closes_at ASC",
      BOARDGAME_CHAYA_ID,
      at,
    );
    if (openList.length === 1) auction = openList[0];
    else if (openList.length > 1) throw cityBadRequest('当前有多场竞拍，请指定 auction_id。', 'ambiguous_auction');
  }
  if (!auction) throw new CityError('NOT_FOUND', '没有这场旧物竞拍会。', 'no_such_auction');
  assertAtVenue(r, auction.place_id);
  if (auction.status !== 'open' || at < auction.opens_at || at >= auction.closes_at) {
    throw cityPrecondition('这场旧物竞拍会已截标或尚未开场。', 'auction_closed');
  }
  const bidYen = a.yen;
  if (typeof bidYen !== 'number' || !Number.isInteger(bidYen) || bidYen < auction.reserve_yen || bidYen <= 0) {
    throw cityBadRequest(`出价必须是不少于起拍价 ¥${auction.reserve_yen} 的正整数日元。`, 'invalid_bid');
  }
  const existing = c.db.get<BidRow & Row>(
    "SELECT * FROM venue_auction_bids WHERE auction_id = ? AND resident_id = ? AND status = 'active'",
    auction.auction_id,
    r.resident_id,
  );
  if (existing) throw cityPrecondition('密封竞拍每人每场只能出价一次，不可修改。', 'already_bid');

  const can = spendable(c, r);
  if (can.yen < bidYen) {
    if (wallet(c, r.resident_id).available >= bidYen) {
      throw cityPrecondition(
        `出价后就回不了家：出价 ¥${bidYen}，你得留 ¥${can.returnReserveYen} 的回程车费。`,
        'return_fare_reserved',
        { bid_yen: bidYen, return_reserve_yen: can.returnReserveYen, spendable_yen: can.yen },
      );
    }
    throw cityPrecondition(`钱不够：出价 ¥${bidYen}，你能花的只有 ¥${can.yen}。`, 'insufficient_funds', { bid_yen: bidYen, spendable_yen: can.yen });
  }

  ledger(
    c,
    `auction:bid:${auction.auction_id}:${r.resident_id}:${at}`,
    'auction_hold',
    `竞拍预占：${auction.item_name}`,
    [[purseOf(r.resident_id), -bidYen], [AUCTION_ESCROW, bidYen]],
    visit?.visit_id ?? null,
  );
  c.db.run(
    `INSERT INTO venue_auction_bids(auction_id, resident_id, bid_yen, held_yen, visit_id, status, placed_at, updated_at)
     VALUES (?,?,?, ?,?,'active',?,?)
     ON CONFLICT(auction_id, resident_id) DO UPDATE SET
       bid_yen = excluded.bid_yen, held_yen = excluded.held_yen, visit_id = excluded.visit_id, status = 'active', placed_at = excluded.placed_at, updated_at = excluded.updated_at`,
    auction.auction_id,
    r.resident_id,
    bidYen,
    bidYen,
    visit?.visit_id ?? null,
    at,
    at,
  );
  return {
    status: 'completed',
    auction_id: auction.auction_id,
    item_id: auction.item_id,
    bid_yen: bidYen,
    held_yen: bidYen,
    purse_yen: wallet(c, r.resident_id).balance,
  };
}

function doAuctionView(c: CityService, r: CityResident, a: Record<string, unknown>, at: number): Record<string, unknown> {
  ensureDailyAuctions(c, at);
  const auctionId = str(a.auction_id);
  const rows = auctionId
    ? c.db.all<AuctionRow & Row>('SELECT * FROM venue_auctions WHERE auction_id = ?', auctionId)
    : c.db.all<AuctionRow & Row>(
        'SELECT * FROM venue_auctions WHERE place_id = ? ORDER BY created_at DESC LIMIT 5',
        r.place_id ?? BOARDGAME_CHAYA_ID,
      );
  return {
    status: 'completed',
    auctions: rows.map((row) => {
      const bidCount =
        row.status === 'open'
          ? c.db.scalar("SELECT COUNT(*) FROM venue_auction_bids WHERE auction_id = ? AND status = 'active'", row.auction_id)
          : c.db.scalar(
              "SELECT COUNT(*) FROM venue_auction_bids WHERE auction_id = ? AND status IN ('active','won','lost','refunded')",
              row.auction_id,
            );
      const mine = c.db.get<BidRow & Row>('SELECT * FROM venue_auction_bids WHERE auction_id = ? AND resident_id = ?', row.auction_id, r.resident_id);
      return {
        auction_id: row.auction_id,
        place_id: row.place_id,
        item_id: row.item_id,
        item_name: row.item_name,
        item_type: row.item_type,
        reserve_yen: row.reserve_yen,
        price_mode: row.price_mode,
        status: row.status,
        closes_at_ms: row.closes_at,
        bid_count: bidCount,
        ...(mine ? { my_bid: { yen: mine.bid_yen, status: mine.status } } : {}),
        ...(row.status === 'settled' ? { winner_id: row.winner_id, winning_price: row.winning_price } : {}),
      };
    }),
  };
}

export function performVenueGameAction(
  c: CityService,
  r: CityResident,
  actionType: string,
  a: Record<string, unknown>,
  at: number,
  visit: VisitRow | null,
): Record<string, unknown> | null {
  switch (actionType) {
    case 'open_table':
      return doOpenTable(c, r, a, at);
    case 'join_table':
      return doJoinTable(c, r, a, at);
    case 'start_table':
      return doStartTable(c, r, a, at);
    case 'game_act':
      return doGameAct(c, r, a, at);
    case 'leave_table':
      return doLeaveTable(c, r, at);
    case 'auction_bid':
      return doAuctionBid(c, r, a, at, visit);
    case 'auction_view':
      return doAuctionView(c, r, a, at);
    default:
      return null;
  }
}

export function venueSceneProjection(c: CityService, placeId: string, viewer: CityResident, at: number): Record<string, unknown> {
  if (placeId !== BOARDGAME_CHAYA_ID) return {};
  const tables = c.db
    .all<TableRow & Row>(
      "SELECT * FROM venue_tables WHERE place_id = ? AND status IN ('forming','running') ORDER BY created_at DESC LIMIT 4",
      placeId,
    )
    .map((t) => ({
      id: t.table_id,
      game: t.game_type,
      status: t.status,
      players: activeSeatsOfTable(c, t.table_id).length,
    }));
  const auctions = c.db
    .all<AuctionRow & Row>(
      "SELECT * FROM venue_auctions WHERE place_id = ? AND status = 'open' AND closes_at > ? ORDER BY closes_at ASC LIMIT 2",
      placeId,
      at,
    )
    .map((row) => {
      const mine = c.db.get<{ bid_yen: number } & Row>(
        "SELECT bid_yen FROM venue_auction_bids WHERE auction_id = ? AND resident_id = ? AND status = 'active'",
        row.auction_id,
        viewer.resident_id,
      );
      return {
        id: row.auction_id,
        item_name: row.item_name,
        reserve_yen: row.reserve_yen,
        closes_at_ms: row.closes_at,
        bid_count: c.db.scalar("SELECT COUNT(*) FROM venue_auction_bids WHERE auction_id = ? AND status = 'active'", row.auction_id),
        ...(mine ? { my_bid_yen: Number(mine.bid_yen) } : {}),
      };
    });
  return { ...(tables.length > 0 ? { tables } : {}), ...(auctions.length > 0 ? { auctions } : {}) };
}

export function venueSelfProjection(c: CityService, r: CityResident, at: number): Record<string, unknown> {
  const seat = activeSeatOfResident(c, r.resident_id);
  if (!seat) return {};
  const table = c.db.get<TableRow & Row>('SELECT * FROM venue_tables WHERE table_id = ?', seat.table_id);
  if (!table) return {};
  if (table.status === 'forming') {
    return {
      venue_table: {
        id: table.table_id,
        game: table.game_type,
        status: 'forming',
        players: activeSeatsOfTable(c, table.table_id).length,
      },
    };
  }
  if (table.status === 'running' && table.record_json && seat.game_seat !== null) {
    const rec = JSON.parse(table.record_json) as GameRecord;
    const todo = todoOf(rec, seat.game_seat, at);
    const gv: EmbeddedSeatView = sharedRunner.view(rec, { now: () => at, rng: c.rng }, seat.game_seat, { limit: 3 });
    return {
      venue_table: {
        id: table.table_id,
        game: table.game_type,
        status: rec.status,
        seat: seat.game_seat,
        round: rec.round,
        phase: gv.phase?.key ?? null,
        public: gv.public,
        ...(gv.you ? { you: gv.you } : {}),
        ...(todo ? { todo: { prompt: todo.prompt, actions: todo.actions.map((x) => x.action), seconds_left: todo.seconds_left } } : {}),
      },
    };
  }
  return {};
}

export function installVenueGames(c: CityService): void {
  c.hooks.arrivePlace.push((_residentId, placeId, at) => {
    if (placeId === BOARDGAME_CHAYA_ID) ensureDailyAuctions(c, at);
  });
  c.hooks.tick.push((now) => {
    if (c.headcount(BOARDGAME_CHAYA_ID) === 0) return;
    const hasOpen = c.db.scalar(
      "SELECT COUNT(*) FROM venue_auctions WHERE place_id = ? AND status = 'open' AND closes_at > ?",
      BOARDGAME_CHAYA_ID,
      now,
    );
    if (hasOpen === 0) {
      c.commit(() => ensureDailyAuctions(c, now));
    }
  });
  c.hooks.departPlace.push((residentId, _placeId, reason, at) => {
    leaveTableCore(c, residentId, reason, at);
    withdrawAuctionBids(c, residentId, reason, at);
  });
  c.jobHandlers.set('venue_table_tick', (payload, _job, now) => {
    runTableTick(c, String(payload.tableId), now);
  });
  c.jobHandlers.set('venue_auction_settle', (payload, _job, now) => {
    settleVenueAuction(c, String(payload.auctionId), now);
  });
}
