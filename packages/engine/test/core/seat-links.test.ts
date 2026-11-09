import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameError } from '../../src/core/errors.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import type { GameRecord } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { memoryLibrary } from '../../src/games/jubensha/index.js';
import { FakeClock, REF, bot, human, pendingSeats, playToEnd, startGame } from '../helpers.js';

const PACK = JSON.parse(readFileSync(join(__dirname, '../../examples/jubensha/demo-search-lighthouse.json'), 'utf8'));
const WEB = 'https://stage.example.com/web/';

function make(webUrl: string | null = WEB, seed = 1) {
  const clock = new FakeClock();
  const manager = new GameManager({
    registry: createRegistry({ scripts: memoryLibrary([PACK]) }),
    now: clock.now,
    rng: new SeededRng(seed),
    webUrl: webUrl ?? undefined,
  });
  return { manager, clock };
}

/** 密封竞拍：1 个真人 + 2 个 bot，座位按报名顺序（真人是 3 号） */
async function auction(webUrl: string | null = WEB) {
  const { manager, clock } = make(webUrl);
  const g = startGame(manager, 'sealed_auction', {
    players: [bot(1), bot(2)],
    humans: [human(1, '小明')],
    referee: REF,
    options: { random_seats: false },
  });
  const seat = g.rec.players.find((p) => p.kind === 'human')!.seat;
  await manager.refereeStep(REF, g.gameId);
  return { manager, clock, ...g, seat };
}

const tokenOf = (rec: GameRecord, seat: number) => rec.seatTokens![String(seat)]!;

describe('真人座位链接：发放', () => {
  it('privately sends each human (and only humans) a seat-bound link at start', async () => {
    const { rec, seat } = await auction();
    expect(Object.keys(rec.seatTokens!)).toEqual([String(seat)]);
    const tok = tokenOf(rec, seat);
    expect(tok).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const url = `${WEB}?g=${rec.id}&s=${tok}`;
    const dm = rec.outbox.filter((d) => d.text.includes(url));
    expect(dm).toHaveLength(1);
    expect(dm[0]!.target).toMatchObject({ type: 'private', userId: '201', seat });
    // 令牌不进群、不进公开记录，bot 也看不到
    expect(rec.outbox.filter((d) => d.target.type === 'group').some((d) => d.text.includes(tok))).toBe(false);
    for (const e of rec.log) {
      if (!e.text.includes(tok)) continue;
      expect(e.audience).toEqual({ type: 'seats', seats: [seat] });
    }
    // 链接比身份信息先到
    const first = rec.outbox.find((d) => d.target.type === 'private')!;
    expect(first.text).toContain(url);
  });

  it('sends no link without a web address, and the human still plays by private chat', async () => {
    const { rec } = await auction(null);
    expect(rec.seatTokens).toBeUndefined();
    expect(rec.outbox.some((d) => d.text.includes('座位网页'))).toBe(false);
  });

  it('resends the link together with the role when the human asks for their identity', async () => {
    const { manager, rec, seat, gameId } = await auction();
    const before = rec.outbox.length;
    manager.relayHumanMessage(REF, gameId, { userId: '201', text: '我的身份呢', channel: 'private' });
    const again = rec.outbox.slice(before).map((d) => d.text).join('\n');
    expect(again).toContain(tokenOf(rec, seat));
  });

  it('revokes every link as soon as the game ends or is aborted', async () => {
    const a = await auction();
    const tok = tokenOf(a.rec, a.seat);
    expect(a.manager.webSeat(a.gameId, tok)).toEqual({ rec: a.rec, seat: a.seat });
    await playToEnd(a.manager, a.gameId, { referee: REF, clock: a.clock });
    expect(a.rec.status).toBe('ended');
    expect(a.rec.seatTokens).toBeUndefined();
    expect(a.manager.webSeat(a.gameId, tok)).toBeNull();

    const b = await auction();
    const tb = tokenOf(b.rec, b.seat);
    b.manager.abortGame(REF, b.gameId, '测试');
    expect(b.rec.seatTokens).toBeUndefined();
    expect(b.manager.webSeat(b.gameId, tb)).toBeNull();
  });

  it('only accepts the exact token for that game', async () => {
    const { manager, rec, seat, gameId } = await auction();
    const tok = tokenOf(rec, seat);
    expect(manager.webSeat(gameId, tok)?.seat).toBe(seat);
    expect(manager.webSeat(gameId, 'x'.repeat(24))).toBeNull();
    expect(manager.webSeat(gameId, '')).toBeNull();
    expect(manager.webSeat('SA-NOPE', tok)).toBeNull();
    // 观战令牌不能当座位令牌用，座位令牌也不能当观战令牌用
    expect(manager.webRecord(gameId, tok)).toBeNull();
  });
});

describe('真人座位链接：视图和指令', () => {
  it('shows the seat its own private view, todo and private messages, but nothing of other seats and no spectator chat', async () => {
    const { manager, rec, seat, gameId } = await auction();
    const inst = (manager as any).inst(rec);
    const v = manager.webSeatView(rec, seat);
    expect(v.me).toMatchObject({ seat, name: '小明', alive: true, can_speak: false });
    expect(v.me.private).toEqual(inst.privateView(seat));
    expect(v.me.todo?.channel).toBe('private');
    expect(v.me.todo?.actions.length).toBeGreaterThan(0);
    expect(v.mine.length).toBeGreaterThan(0);
    expect(v.mine.every((m) => rec.log.some((e) => e.text === m.text && e.audience.type === 'seats' && e.audience.seats.includes(seat)))).toBe(true);
    expect(v.board).toEqual(inst.publicView());
    const json = JSON.stringify(v);
    for (const other of rec.players.filter((p) => p.seat !== seat)) {
      expect(json).not.toContain(JSON.stringify(inst.privateView(other.seat)));
    }
    expect(v).not.toHaveProperty('chat');
    expect(v).not.toHaveProperty('replay');
    // 增量：since 之后的私密消息才给
    const again = manager.webSeatView(rec, seat, v.last_seq, v.mine_seq);
    expect(again.mine).toEqual([]);
    expect(again.events).toEqual([]);
    void gameId;
  });

  it('runs page commands exactly like a private message to the referee', async () => {
    const { manager, rec, seat } = await auction();
    const coins = (rec.state as any).coins[String(seat)] as number;
    const bad = manager.webSeatAct(rec, seat, { text: `出价 ${coins + 1}`, mode: 'command' });
    expect(bad.accepted).toBe(false);
    expect(bad.message).toContain('只能出价');
    const huh = manager.webSeatAct(rec, seat, { text: '今天天气不错', mode: 'command' });
    expect(huh).toMatchObject({ recognized: false, accepted: false });
    const before = rec.outbox.length;
    const ok = manager.webSeatAct(rec, seat, { text: '出价 3', mode: 'command' });
    expect(ok.accepted).toBe(true);
    expect(rec.phase!.pending[String(seat)]?.done ?? true).toBe(true);
    // 页面上直接显示结果：不再私聊一遍「✅」
    expect(rec.outbox.slice(before).some((d) => d.target.type === 'private' && d.text.startsWith('✅'))).toBe(false);
  });

  it('refuses speech from the page on the group stage, and empty input', async () => {
    const { manager, rec, seat } = await auction();
    expect(() => manager.webSeatAct(rec, seat, { text: '大家好', mode: 'speech' })).toThrow(/群里/);
    expect(() => manager.webSeatAct(rec, seat, { text: '   ', mode: 'command' })).toThrow(GameError);
  });
});

/** 推进一步：bot 随机行动；真人用结构化指令行动，发言后补一个「过」（真人的发言不会自动结束）。stopAt 座位轮到时不动它 */
async function step(manager: GameManager, clock: FakeClock, rec: GameRecord, gameId: string, stopAt: number) {
  const ps = pendingSeats(rec);
  if (ps.length === 0) {
    clock.advance(5000);
    await manager.refereeStep(REF, gameId);
    return;
  }
  for (const s of ps) {
    if (s === stopAt || rec.status !== 'running') continue;
    const req = rec.phase?.pending[String(s)];
    if (!req || req.done) continue;
    const input = manager.randomActionFor(gameId, s);
    const who = rec.players.find((p) => p.seat === s)!;
    if (!input) continue;
    if (who.kind === 'agent') manager.act({ id: who.id, name: who.name }, gameId, input);
    else {
      manager.relayHumanMessage(REF, gameId, { userId: who.id, text: '', channel: req.channel, action: input });
      if (rec.phase?.pending[String(s)] && !rec.phase.pending[String(s)]!.done) {
        try {
          manager.relayHumanMessage(REF, gameId, { userId: who.id, text: '', channel: req.channel, action: { action: 'end_speech' } });
        } catch {
          /* 不是发言环节 */
        }
      }
    }
  }
}

describe('真人座位链接：网页舞台', () => {
  function webGame() {
    const { manager, clock } = make();
    const { summary } = manager.createGame(REF, { type: 'jubensha', groupId: 'g', joinAs: 'referee', options: { stage: 'web', random_seats: false } });
    for (const n of [1, 2, 3]) manager.joinGame(bot(n), summary.game_id, { as: 'player' });
    const joined = manager.relayHumanMessage(REF, summary.game_id, { userId: '201', nickname: '小明', text: '加入', channel: 'group' });
    expect(joined.accepted).toBe(true);
    manager.startGame(REF, summary.game_id);
    const rec = manager.getRecord(summary.game_id);
    const seat = rec.players.find((p) => p.kind === 'human')!.seat;
    return { manager, clock, rec, seat, gameId: summary.game_id };
  }

  it('lets humans join, sends them the seat link, and mirrors their page speech to the group', async () => {
    const { manager, clock, rec, seat, gameId } = webGame();
    expect(rec.outbox.some((d) => d.target.type === 'private' && d.text.includes(tokenOf(rec, seat)))).toBe(true);
    // 打到轮到真人发言
    for (let i = 0; i < 400 && !(pendingSeats(rec).includes(seat) && rec.phase!.pending[String(seat)]!.kind === 'speech'); i++) {
      await step(manager, clock, rec, gameId, seat);
    }
    expect(rec.phase!.pending[String(seat)]!.kind).toBe('speech');
    expect(manager.webSeatView(rec, seat).me.can_speak).toBe(true);
    // 群里说的话不算数
    const g = manager.relayHumanMessage(REF, gameId, { userId: '201', text: '我在群里说一句', channel: 'group' });
    expect(g.accepted).toBe(false);
    expect(rec.log.some((e) => e.text.includes('我在群里说一句'))).toBe(false);
    // 页面上的发言：记进公开记录，并带前缀镜像到群里（不用真人的号说话）
    const r = manager.webSeatAct(rec, seat, { text: '我九点在码头。', mode: 'speech' });
    expect(r.accepted).toBe(true);
    expect(rec.log.some((e) => e.audience.type === 'public' && e.text.includes('我九点在码头。'))).toBe(true);
    const d = rec.outbox.filter((x) => x.category === 'speech').at(-1)!;
    expect(d.text).toMatch(new RegExp(`^【${seat}号 小明(·[^】]+)?】我九点在码头。$`));
    expect(d.noGate).toBe(true);
    expect(d.voice).toBeUndefined();
  });

  it('plays a web-stage game with a human to the end, then revokes the link', async () => {
    const { manager, clock, rec, seat, gameId } = webGame();
    const tok = tokenOf(rec, seat);
    for (let i = 0; i < 3000 && rec.status === 'running'; i++) await step(manager, clock, rec, gameId, -1);
    expect(rec.status).toBe('ended');
    expect(manager.webSeat(gameId, tok)).toBeNull();
  });
});

describe('referee_step 给出真人名单', () => {
  it('lists human ids while running', async () => {
    const { manager, gameId } = await auction();
    const r = await manager.refereeStep(REF, gameId);
    expect(r.human_ids).toEqual(['201']);
  });
});
