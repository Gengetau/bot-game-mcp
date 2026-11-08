import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameError } from '../../src/core/errors.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { mirrorLine } from '../../src/core/text.js';
import type { GameRecord } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { memoryLibrary } from '../../src/games/jubensha/index.js';
import { renderDelivery } from '../../src/mcp/render.js';
import { FakeClock, REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

const PACK = JSON.parse(readFileSync(join(__dirname, '../../examples/jubensha/demo-search-lighthouse.json'), 'utf8'));
const WEB = 'https://stage.example.com/web/';

function webGame(seed = 1, extra: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const manager = new GameManager({
    registry: createRegistry({ scripts: memoryLibrary([PACK]) }),
    now: clock.now,
    rng: new SeededRng(seed),
    webUrl: WEB,
  });
  const players = [1, 2, 3, 4].map((n) => bot(n));
  const { summary } = manager.createGame(REF, { type: 'jubensha', groupId: 'g', joinAs: 'referee', options: { stage: 'web', ...extra } });
  // bot 报名时说自己发群（selfPost=true），网页舞台上一律改成交给引擎
  for (const p of players) manager.joinGame(p, summary.game_id, { as: 'player', selfPost: true });
  return { manager, clock, gameId: summary.game_id, summary, rec: manager.getRecord(summary.game_id) as GameRecord };
}

describe('网页舞台：开房和开局', () => {
  it('picks the web stage only for games that support it, with a watch token', () => {
    const { rec, summary } = webGame();
    expect(rec.stage).toBe('web');
    expect(rec.watchToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(summary.stage).toBe('web');

    // 数字炸弹不支持网页舞台：stage 选项被忽略
    const { manager } = setup(1);
    const nb = manager.createGame(REF, { type: 'number_bomb', groupId: 'g2', joinAs: 'referee', options: { stage: 'web' } });
    expect(manager.getRecord(nb.summary.game_id).stage).toBeUndefined();
    expect(nb.summary.stage).toBe('group');
  });

  it('refuses human seats on the web stage (P1 has none)', () => {
    const { manager, gameId, rec } = webGame();
    expect(() => manager.addHuman(REF, gameId, human(1))).toThrow(GameError);
    const r = manager.relayHumanMessage(REF, gameId, { userId: '201', nickname: '路人', text: '加入', channel: 'group' });
    expect(r).toMatchObject({ recognized: true, accepted: false });
    expect(r.message).toContain('灯下剧场');
    expect(rec.lobby.some((e) => e.kind === 'human')).toBe(false);
  });

  it('posts the watch link first, forces selfPost off, and only mirrors to the group (never images, never long text)', () => {
    const { manager, gameId, rec } = webGame();
    const started = manager.startGame(REF, gameId);
    expect(started.watch_url).toBe(`${WEB}?g=${gameId}&t=${rec.watchToken}`);
    expect(rec.players.every((p) => p.selfPost === false)).toBe(true);

    const group = rec.outbox.filter((d) => d.target.type === 'group');
    expect(group[0]!.text).toContain(started.watch_url!);
    expect(group.every((d) => d.noGate === true)).toBe(true);
    expect(rec.outbox.some((d) => d.target.type === 'private')).toBe(false);
    expect(group.some((d) => d.segments.some((s) => s.type === 'image'))).toBe(false);
    // 剧本的开场长文只在网页上：群里没有
    expect(group.some((d) => d.text.includes(PACK.intro.slice(0, 20)))).toBe(false);
    expect(rec.log.some((e) => e.text.includes(PACK.intro.slice(0, 20)))).toBe(true);
    // 镜像不 @ 人（@ 会把参赛 bot 叫醒、在群里接话）
    expect(group.some((d) => d.segments.some((s) => s.type === 'at'))).toBe(false);
  });

  it('opens phases without waiting for the referee to mirror anything', () => {
    const { manager, gameId, rec } = webGame();
    manager.startGame(REF, gameId);
    expect(rec.referee!.cursor).toBe(0);
    expect(rec.phase!.openedAt).not.toBeNull();
    expect(pendingSeats(rec).length).toBeGreaterThan(0);
  });

  it('mirrors each bot speech verbatim, with the speaker as voice', () => {
    const { manager, gameId, rec } = webGame();
    manager.startGame(REF, gameId);
    const seat = pendingSeats(rec)[0]!;
    const who = identityOf(rec, seat);
    const res = manager.speak(who, gameId, '我九点半在码头，看见灯塔顶的灯灭了一次。');
    expect(res.post_to_group).toBeUndefined();
    const d = rec.outbox.filter((x) => x.category === 'speech').at(-1)!;
    expect(d.noGate).toBe(true);
    expect(d.voice).toEqual({ qq: who.id, text: '我九点半在码头，看见灯塔顶的灯灭了一次。' });
    expect(d.text).toMatch(new RegExp(`^【${seat}号 ${who.name}.*】我九点半在码头`));
    const r = renderDelivery(d, 'onebot') as any;
    expect(r.mirror).toBe(true);
    expect(r.voice).toEqual({ qq: who.id, message: [{ type: 'text', data: { text: '我九点半在码头，看见灯塔顶的灯灭了一次。' } }] });
    // 玩家的提示里说明不要在群里说话
    expect((manager.getView(who, gameId) as any).hint).toContain('网页舞台');
  });

  it('plays a whole game to the end on the web stage', async () => {
    const { manager, clock, gameId, rec } = webGame(3);
    manager.startGame(REF, gameId);
    await playToEnd(manager, gameId, { referee: REF, clock });
    expect(rec.status).toBe('ended');
    expect(rec.outbox.every((d) => d.target.type === 'group' && d.noGate)).toBe(true);
  });

  it('jubensha opens on the web stage by default; stage=group keeps it in the group and lets humans join', () => {
    const s = setup(1, undefined, { scripts: memoryLibrary([PACK]) });
    const a = s.manager.createGame(REF, { type: 'jubensha', groupId: 'g1', joinAs: 'referee' });
    expect(s.manager.getRecord(a.summary.game_id).stage).toBe('web');
    expect(() => s.manager.addHuman(REF, a.summary.game_id, { userId: '50001', name: '真人' })).toThrow(/stage=group/);
    const b = s.manager.createGame(REF, { type: 'jubensha', groupId: 'g2', joinAs: 'referee', options: { stage: 'group' } });
    expect(s.manager.getRecord(b.summary.game_id).stage ?? 'group').toBe('group');
    expect(() => s.manager.addHuman(REF, b.summary.game_id, { userId: '50001', name: '真人' })).not.toThrow();
  });

  it('keeps the group stage exactly as before (gating, no mirror flags)', () => {
    const { manager, rec } = (() => {
      const s = setup(1, undefined, { scripts: memoryLibrary([PACK]) });
      return { manager: s.manager, rec: startGame(s.manager, 'jubensha', { players: [1, 2, 3, 4].map((n) => bot(n)), referee: REF, options: { stage: 'group' } }).rec };
    })();
    void manager;
    expect(rec.stage).toBeUndefined();
    expect(rec.outbox.some((d) => d.noGate || d.voice)).toBe(false);
    expect(rec.phase!.openedAt).toBeNull(); // 等裁判把消息发完才开放
  });
});

describe('网页舞台：观战视图', () => {
  it('needs the right token; group-stage games are invisible', () => {
    const { manager, gameId, rec } = webGame();
    expect(manager.webRecord(gameId, rec.watchToken!)).toBe(rec);
    expect(manager.webRecord(gameId, 'x'.repeat(24))).toBeNull();
    expect(manager.webRecord(gameId, '')).toBeNull();
    expect(manager.webRecord('JB-NOPE', rec.watchToken!)).toBeNull();
    const s = setup(1);
    const g = startGame(s.manager, 'number_bomb', { players: [bot(1), bot(2)], autoReferee: true });
    expect(s.manager.webRecord(g.gameId, '')).toBeNull();
  });

  it('shows only public events, renumbered without gaps, and resumes after a seq', () => {
    const { manager, gameId, rec } = webGame();
    manager.startGame(REF, gameId);
    const v = manager.webView(rec);
    expect(v.events.map((e) => e.seq)).toEqual(v.events.map((_, i) => i + 1));
    expect(v.last_seq).toBe(v.events.length);
    const secrets = rec.log.filter((e) => e.audience.type !== 'public').map((e) => e.text);
    expect(secrets.length).toBeGreaterThan(0);
    const json = JSON.stringify(v);
    for (const t of secrets) expect(json).not.toContain(t);
    // 人物剧本（私密）不在视图里，角色表（公开）在
    for (const r of PACK.roles) expect(json).not.toContain(r.script.slice(0, 30));
    expect((v.board as any).cast).toHaveLength(4);
    expect(v.replay).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(rec.watchToken!);

    const seat = pendingSeats(rec)[0]!;
    manager.speak(identityOf(rec, seat), gameId, '大家好。');
    const more = manager.webView(rec, v.last_seq);
    expect(more.events.length).toBeGreaterThan(0);
    expect(more.events[0]!.seq).toBe(v.last_seq + 1);
    const sp = more.events.find((e) => e.speech === '大家好。');
    expect(sp?.seat).toBe(seat);
  });

  it('hides who is still acting during secret phases', async () => {
    const { manager, clock, gameId, rec } = webGame(2);
    manager.startGame(REF, gameId);
    let checked = false;
    await playToEnd(manager, gameId, {
      referee: REF,
      clock,
      onStep: (r) => {
        if (r.phase?.secret && r.phase.openedAt !== null && !checked) {
          const v = manager.webView(r);
          expect(v.phase!.secret).toBe(true);
          expect(v.phase!.waiting).toEqual([]);
          expect(v.phase!.done).toEqual([]);
          expect(v.phase!.total).toBeNull();
          checked = true;
        }
      },
    });
    expect(checked).toBe(true);
  });

  it('adds the full replay (with private events) only after a normal end', async () => {
    const { manager, clock, gameId, rec } = webGame(4);
    manager.startGame(REF, gameId);
    await playToEnd(manager, gameId, { referee: REF, clock });
    const v = manager.webView(rec);
    expect(v.replay!.length).toBe(rec.log.length);
    expect(v.replay!.some((e) => typeof e.audience === 'object')).toBe(true);
    // 增量包不重复带复盘
    expect(manager.webView(rec, 5).replay).toBeUndefined();

    const b = webGame(5);
    b.manager.startGame(REF, b.gameId);
    b.manager.abortGame(REF, b.gameId, '测试');
    const a = b.manager.webView(b.rec);
    expect(a.aborted).toBe('测试');
    expect(a.replay).toBeUndefined();
  });
});

describe('mirrorLine', () => {
  it('keeps the first line and says the rest is on the web', () => {
    expect(mirrorLine('🎬 第一幕')).toBe('🎬 第一幕');
    expect(mirrorLine('🔎 搜证开始\n可搜：书房')).toBe('🔎 搜证开始（详见网页）');
    expect(mirrorLine('a'.repeat(100))).toBe(`${'a'.repeat(80)}…（详见网页）`);
    expect(mirrorLine('第一行\n   \n')).toBe('第一行');
  });
});
