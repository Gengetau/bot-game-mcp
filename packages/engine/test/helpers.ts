import { GameManager } from '../src/core/manager.js';
import { SeededRng } from '../src/core/rng.js';
import type { StateStore } from '../src/core/store.js';
import type { ActionInput, GameRecord, Identity, Seat } from '../src/core/types.js';
import { createRegistry } from '../src/games/index.js';

export class FakeClock {
  t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function setup(seed: string | number = 1, store?: StateStore) {
  const clock = new FakeClock();
  const manager = new GameManager({ registry: createRegistry(), now: clock.now, rng: new SeededRng(seed), store });
  return { clock, manager };
}

export const bot = (n: number | string, name?: string): Identity => ({ id: `10${n}`, name: name ?? `Bot${n}` });
export const human = (n: number | string, name?: string) => ({ userId: `20${n}`, name: name ?? `Human${n}` });
export const REF: Identity = { id: '999', name: 'Judge' };

export interface StartOpts {
  players: Identity[];
  humans?: { userId: string; name: string }[];
  referee?: Identity;
  options?: Record<string, unknown>;
  autoReferee?: boolean;
  groupId?: string;
  selfPost?: boolean;
}

/** 建房 → 报名 → 开局。referee 存在时以 referee 身份建房。 */
export function startGame(manager: GameManager, type: string, opts: StartOpts) {
  const host = opts.referee ?? opts.players[0]!;
  const { summary } = manager.createGame(host, {
    type,
    groupId: opts.groupId ?? '9000',
    options: opts.options,
    joinAs: opts.referee ? 'referee' : 'player',
    autoReferee: opts.autoReferee,
    selfPost: opts.selfPost ?? false,
  });
  for (const p of opts.players) if (p !== host) manager.joinGame(p, summary.game_id, { as: 'player', selfPost: opts.selfPost ?? false });
  for (const h of opts.humans ?? []) manager.addHuman(host, summary.game_id, h);
  const started = manager.startGame(host, summary.game_id);
  return { gameId: summary.game_id, started, rec: manager.getRecord(summary.game_id) };
}

export function identityOf(rec: GameRecord, seat: Seat): Identity {
  const p = rec.players.find((pl) => pl.seat === seat)!;
  return { id: p.id, name: p.name };
}

export function pendingSeats(rec: GameRecord): Seat[] {
  const ph = rec.phase;
  if (!ph || ph.openedAt === null) return [];
  return Object.values(ph.pending)
    .filter((r) => !r.done)
    .map((r) => r.seat);
}

/**
 * 用随机合法动作把对局打到结束。真人动作通过裁判的结构化转发提交。
 * 返回推进的步数。
 */
export async function playToEnd(
  manager: GameManager,
  gameId: string,
  opts: { referee?: Identity; clock?: FakeClock; maxSteps?: number; onStep?: (rec: GameRecord) => void } = {},
): Promise<number> {
  const rec = manager.getRecord(gameId);
  let step = 0;
  for (; step < (opts.maxSteps ?? 5000); step++) {
    if (rec.status !== 'running') break;
    if (opts.referee) await manager.refereeStep(opts.referee, gameId);
    if (rec.status !== 'running') break;
    const seats = pendingSeats(rec);
    if (seats.length === 0) {
      // 等待 notBefore / minDuration：推进时钟
      opts.clock?.advance(5000);
      if (!opts.referee) manager.tick();
      continue;
    }
    for (const seat of seats) {
      if (rec.status !== 'running') break;
      const req = rec.phase?.pending[String(seat)];
      if (!req || req.done) continue;
      const input: ActionInput | null = manager.randomActionFor(gameId, seat);
      const p = rec.players.find((pl) => pl.seat === seat)!;
      if (!input) continue;
      if (p.kind === 'agent') manager.act({ id: p.id, name: p.name }, gameId, input);
      else
        manager.relayHumanMessage(opts.referee!, gameId, {
          userId: p.id,
          text: '',
          channel: req.channel,
          action: input,
        });
    }
    opts.onStep?.(rec);
  }
  if (opts.referee) {
    opts.clock?.advance(60_000);
    await manager.refereeStep(opts.referee, gameId);
  }
  return step;
}
