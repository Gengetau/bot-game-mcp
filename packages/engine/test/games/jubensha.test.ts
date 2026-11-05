import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActionInput, GameRecord, Seat } from '../../src/core/types.js';
import { chunkText, directoryLibrary, memoryLibrary, parsePack } from '../../src/games/jubensha/index.js';
import type { JubenshaState } from '../../src/games/jubensha/index.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

const DEMO_FILE = join(__dirname, '../../examples/jubensha/demo-rainy-bookshop.json');
const DEMO = JSON.parse(readFileSync(DEMO_FILE, 'utf8'));
const lib = () => memoryLibrary([DEMO]);
type Rec = GameRecord<JubenshaState>;

/** 剧本里只有扮演者/DM 才能看到的句子（用来检查泄露） */
const SECRETS = [
  '母亲住院急需用钱', // 小林人物剧本
  '书脊上那块浅浅的水渍', // 周先生人物剧本
  '手上沾着灰', // 第一幕私密
  '是我拿的', // 认罪书
  '库房最里面那箱旧杂志下', // 真相
  '不要直接点出小林', // 主持手册
];

function game(opts: { bots?: number; humans?: number; options?: Record<string, unknown>; seed?: string | number; referee?: boolean } = {}) {
  const { manager, clock } = setup(opts.seed ?? 1, undefined, { scripts: lib() });
  const players = Array.from({ length: opts.bots ?? 4 }, (_, i) => bot(i + 1));
  const humans = Array.from({ length: opts.humans ?? 0 }, (_, i) => human(i + 1));
  const useRef = opts.referee ?? humans.length > 0;
  const { gameId, rec } = startGame(manager, 'jubensha', {
    players,
    humans,
    ...(useRef ? { referee: REF } : { autoReferee: true }),
    options: { random_seats: false, ...opts.options },
  });
  const r = rec as Rec;
  const act = (seat: Seat, input: ActionInput) => manager.act(identityOf(r, seat), gameId, input);
  const view = (seat: Seat) => manager.getView(identityOf(r, seat), gameId) as any;
  const seatOfRole = (key: string) => Number(Object.entries(r.state.cast).find(([, k]) => k === key)![0]);
  const key = () => r.phase?.key ?? null;
  /** 按默认行为推进（自我介绍说一句、读完、讨论直接过、投票弃票），直到 until() */
  const drive = (over: Record<string, (s: Seat) => ActionInput> = {}, until: () => boolean = () => false) => {
    for (let i = 0; i < 300 && r.status === 'running' && !until(); i++) {
      const seats = pendingSeats(r);
      if (seats.length === 0) {
        clock.advance(5000);
        manager.tick();
        continue;
      }
      const k = key()!;
      for (const s of seats) {
        if (r.phase?.key !== k || !r.phase.pending[String(s)] || r.phase.pending[String(s)]!.done) continue;
        const def: ActionInput =
          k === 'read' ? { action: 'ready' } : k === 'vote' ? { action: 'skip' } : k === 'discuss' ? { action: 'end_speech' } : { action: 'speech', text: '我是我。' };
        act(s, over[k]?.(s) ?? def);
      }
    }
  };
  return { manager, clock, gameId, rec: r, act, view, seatOfRole, key, drive };
}

describe('jubensha: data packs', () => {
  it('validates the demo pack and rejects broken ones', () => {
    expect(parsePack(DEMO).title).toBe('雨夜书屋');
    expect(() => parsePack({ ...DEMO, culprits: ['nobody'] })).toThrow(/culprits/);
    expect(() => parsePack({ ...DEMO, players: 5 })).toThrow(/roles 数量/);
    expect(() => parsePack({ ...DEMO, acts: [{ title: 'x', private: { ghost: 'boo' } }] })).toThrow(/ghost/);
  });

  it('directory library loads *.json, reports bad files and picks up new files without restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbs-'));
    const l = directoryLibrary(dir);
    expect(l.list()).toEqual([]);
    writeFileSync(join(dir, 'demo.json'), JSON.stringify(DEMO));
    writeFileSync(join(dir, 'broken.json'), '{"id":"x"}');
    expect(l.list().map((p) => p.id)).toEqual(['demo']);
    expect(Object.keys(l.errors())).toEqual(['broken.json']);
    expect(l.get('demo')?.players).toBe(4);
    expect(directoryLibrary(join(dir, 'missing')).list()).toEqual([]);
  });

  it('chunkText keeps paragraphs and respects the limit', () => {
    const long = Array.from({ length: 30 }, (_, i) => `第${i}段。`.padEnd(100, '字')).join('\n');
    const parts = chunkText(long, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join('\n').replace(/\n/g, '')).toBe(long.replace(/\n/g, ''));
  });
});

describe('jubensha: start checks', () => {
  it('needs a script library and the right head count', () => {
    const { manager } = setup(1);
    expect(() => startGame(manager, 'jubensha', { players: [bot(1), bot(2)], autoReferee: true })).toThrow(/剧本库里还没有剧本/);
    const s = setup(1, undefined, { scripts: lib() });
    expect(() => startGame(s.manager, 'jubensha', { players: [bot(1), bot(2), bot(3)], autoReferee: true })).toThrow(/需要 4 名玩家/);
    const t = setup(1, undefined, { scripts: lib() });
    expect(() =>
      startGame(t.manager, 'jubensha', { players: [bot(1), bot(2), bot(3), bot(4)], autoReferee: true, options: { script: 'nope' } }),
    ).toThrow(/找不到剧本 nope/);
  });

  it('host must be signed up to take the extra seat; cast is validated', () => {
    const a = setup(1, undefined, { scripts: lib() });
    expect(() =>
      startGame(a.manager, 'jubensha', { players: [1, 2, 3, 4, 5].map((n) => bot(n)), autoReferee: true, options: { host: '777' } }),
    ).toThrow(/另加 DM/);
    const b = setup(1, undefined, { scripts: lib() });
    expect(() =>
      startGame(b.manager, 'jubensha', { players: [1, 2, 3, 4].map((n) => bot(n)), autoReferee: true, options: { cast: { '101': 'ghost' } } }),
    ).toThrow(/角色 ghost/);
  });

  it('a host who did not sign up just means the program hosts', () => {
    const g = game({ options: { host: '777' } });
    expect(g.rec.state.host).toBe(0);
    expect(g.rec.log.some((e) => e.text.includes('本局由程序主持'))).toBe(true);
  });

  it('cast pins roles to QQ ids', () => {
    const g = game({ options: { cast: { '103': 'lin' } } });
    expect(g.rec.state.cast['3']).toBe('lin');
  });
});

describe('jubensha: flow with a DM', () => {
  const withHost = (seed: string | number = 1) => game({ bots: 5, options: { host: '105' }, seed });

  it('DM takes no role, sees everything; players see only their own script', () => {
    const g = withHost();
    expect(g.rec.state.host).toBe(5);
    expect(Object.keys(g.rec.state.cast).sort()).toEqual(['1', '2', '3', '4']);
    const dm = g.view(5);
    expect(dm.you.role).toBe('DM');
    expect(dm.you.truth).toContain('库房最里面');
    expect(dm.you.host_notes).toContain('不要直接点出小林');
    const lin = g.seatOfRole('lin');
    const zhou = g.seatOfRole('zhou');
    const other = [1, 2, 3, 4].find((s) => s !== lin && s !== zhou)!;
    const v = g.view(other);
    expect(v.you.script).toBeTruthy();
    const dump = JSON.stringify(v);
    for (const s of SECRETS) expect(dump).not.toContain(s);
    expect(JSON.stringify(g.view(lin))).toContain('母亲住院急需用钱');
    // 认罪书在坦白阶段之前不给
    expect(g.view(lin).you.confession).toBeUndefined();
  });

  it('runs intro → acts → vote → confession → truth, and solves the case', () => {
    const g = withHost();
    const lin = g.seatOfRole('lin');
    g.drive({ vote: (s) => (s === lin ? { action: 'skip' } : { action: 'vote', target: lin }) }, () => g.key() === 'confess');
    expect(g.rec.state.outcome?.solved).toBe(true);
    expect(pendingSeats(g.rec)).toEqual([lin]);
    expect(g.view(lin).you.confession).toContain('是我拿的');
    g.act(lin, { action: 'speech', text: '是我，我认。' });
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result?.winnerTeam).toBe('侦破方');
    expect(g.rec.result?.winnerSeats).not.toContain(lin);
    expect(g.rec.result?.winnerSeats).not.toContain(5);
    const texts = g.rec.log.map((e) => e.text).join('\n');
    expect(texts).toContain('秦老先生在库房找回了《雨窗集》');
    expect(texts).toContain('📜 真相');
  });

  it('nothing secret reaches the public log or group before the truth', () => {
    const g = withHost('leak');
    g.drive({}, () => g.key() === 'confess');
    for (const e of g.rec.log) {
      if (e.audience.type !== 'public') continue;
      for (const s of SECRETS) expect(e.text).not.toContain(s);
    }
    for (const d of g.rec.outbox) if (d.target.type === 'group') for (const s of SECRETS) expect(d.text).not.toContain(s);
  });

  it('DM can answer privately, skip ahead and extend; players cannot', () => {
    const g = withHost();
    g.drive({}, () => g.key() === 'discuss');
    g.act(1, { action: 'ask', text: '钥匙有几把？' });
    expect(g.view(5).you.open_questions).toEqual([{ from: 1, role: expect.any(String), question: '钥匙有几把？' }]);
    expect(g.rec.outbox.some((d) => d.text.includes('有玩家私下向 DM 提问'))).toBe(true);
    g.act(5, { action: 'answer', target: 1, text: '两把。' });
    expect(g.view(1).you.my_questions).toEqual([{ question: '钥匙有几把？', answer: '两把。' }]);
    expect(g.view(5).you.open_questions).toEqual([]);

    const before = g.rec.phase!.deadline!;
    g.act(5, { action: 'extend', number: 3 });
    expect(g.rec.phase!.deadline).toBe(before + 180_000);
    g.act(5, { action: 'extend', number: 9 });
    expect(() => g.act(5, { action: 'extend' })).toThrow(/2 次/);
    expect(() => g.act(1, { action: 'next' })).toThrow();
    const title = g.rec.phase!.title;
    g.act(5, { action: 'next' });
    expect(g.rec.phase!.title).not.toBe(title);
    g.act(5, { action: 'speech', text: '各位，请看第二幕。' });
    expect(g.rec.log.some((e) => e.kind === 'dm_speech' && e.text.includes('（DM）'))).toBe(true);
  });
});

describe('jubensha: free discussion', () => {
  it('AI cannot monologue; others are re-armed after each line; quota and pass end the round', () => {
    const g = game({ options: { discuss_max_msgs: 2 } });
    g.drive({}, () => g.key() === 'discuss');
    g.act(1, { action: 'speech', text: '我七点在前厅。' });
    expect(() => g.act(1, { action: 'speech', text: '还有……' })).toThrow(/等别人接话/);
    expect(pendingSeats(g.rec).sort()).toEqual([2, 3, 4]);
    g.act(2, { action: 'speech', text: '我在里间。' });
    expect(pendingSeats(g.rec).sort()).toEqual([1, 3, 4]);
    g.act(1, { action: 'speech', text: '那七点二十呢？' });
    // 1 号用完 2 条，不再被重新开放
    g.act(3, { action: 'speech', text: '我去了洗手间。' });
    expect(pendingSeats(g.rec)).not.toContain(1);
    expect(() => g.act(1, { action: 'speech', text: '再说一句' })).toThrow(/2 条/);
    g.act(2, { action: 'end_speech' });
    g.act(3, { action: 'end_speech' });
    expect(g.key()).toBe('discuss');
    g.act(4, { action: 'end_speech' });
    expect(g.key()).toBe('read');
  });

  it('times out after discuss_minutes', () => {
    const g = game({ options: { discuss_minutes: 1 } });
    g.drive({}, () => g.key() === 'discuss');
    g.clock.advance(61_000);
    g.manager.tick();
    expect(g.key()).toBe('read');
  });
});

describe('jubensha: questions without a DM', () => {
  it('answers from the FAQ, falls back to the script, and enforces ask_limit', () => {
    const g = game({ options: { ask_limit: 2 } });
    const r1 = g.act(1, { action: 'ask', text: '柜子钥匙在哪？' });
    expect(r1.message).toContain('收银台下面的钩子');
    const r2 = g.act(1, { action: 'ask', text: '外面下雨吗？' });
    expect(r2.message).toContain('以你自己的剧本为准');
    expect(() => g.act(1, { action: 'ask', text: '再问一个' })).toThrow(/次数已用完/);
  });
});

describe('jubensha: humans', () => {
  it('parses human commands and delivers secrets only by private message', async () => {
    const g = game({ bots: 3, humans: 1, seed: 'h' });
    const hs = g.rec.players.find((p) => p.kind === 'human')!;
    const relay = (text: string, channel: 'group' | 'private' = 'group') =>
      g.manager.relayHumanMessage(REF, g.gameId, { userId: hs.id, text, channel });
    // 人物剧本私聊发给真人
    const role = g.rec.state.cast[String(hs.seat)]!;
    const script = DEMO.roles.find((r: any) => r.key === role).script.slice(0, 10);
    expect(g.rec.outbox.some((d) => d.target.type === 'private' && d.text.includes(script))).toBe(true);
    expect(g.rec.outbox.some((d) => d.target.type === 'group' && d.text.includes(script))).toBe(false);
    // MCP 视角拿不到真人的剧本
    const spectator = g.manager.getView({ id: hs.id, name: hs.name }, g.gameId) as any;
    expect(JSON.stringify(spectator)).not.toContain(script);

    expect(relay('问DM 钥匙有几把', 'private').accepted).toBe(true);
    for (let i = 0; i < 40 && g.key() !== 'read'; i++) {
      await g.manager.refereeStep(REF, g.gameId);
      for (const s of pendingSeats(g.rec)) {
        if (s === hs.seat) {
          relay('我是我自己。');
          relay('过');
        } else g.act(s, { action: 'speech', text: '你好。' });
      }
    }
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.key()).toBe('read');
    expect(relay('读完').accepted).toBe(true);
    for (const s of pendingSeats(g.rec)) g.act(s, { action: 'ready' });
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.key()).toBe('discuss');
    expect(relay('我觉得时间对不上').accepted).toBe(true);
    expect(relay('还有钥匙的事').accepted).toBe(true); // 真人可以连续说
    expect(relay('过').accepted).toBe(true);
    expect(relay('我又想说').recognized).toBe(false);
  });
});

describe('jubensha: random play', () => {
  it('always reaches the end', async () => {
    for (const seed of [1, 2, 3, 'x', 'y']) {
      const { manager, clock } = setup(seed, undefined, { scripts: lib() });
      const players = Array.from({ length: 5 }, (_, i) => bot(i + 1));
      const { gameId, rec } = startGame(manager, 'jubensha', { players, autoReferee: true, options: { host: '105' } });
      await playToEnd(manager, gameId, { clock });
      expect(rec.status).toBe('ended');
    }
  });
});
