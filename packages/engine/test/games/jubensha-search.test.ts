import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActionInput, GameRecord, Seat } from '../../src/core/types.js';
import { memoryLibrary, packWarnings, parsePack } from '../../src/games/jubensha/index.js';
import type { JubenshaState } from '../../src/games/jubensha/index.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

const PACK = JSON.parse(readFileSync(join(__dirname, '../../examples/jubensha/demo-search-lighthouse.json'), 'utf8'));
type Rec = GameRecord<JubenshaState>;
const clone = () => JSON.parse(JSON.stringify(PACK));

/** 只有拿到卡的人才该看到的卡面（「码头·告示」是 public 卡，不在内） */
const CARD_TEXTS: string[] = PACK.clues.filter((c: any) => !c.public).map((c: any) => c.text);

function game(opts: { pack?: unknown; options?: Record<string, unknown>; seed?: string | number; host?: boolean; humans?: number } = {}) {
  const { manager, clock } = setup(opts.seed ?? 1, undefined, { scripts: memoryLibrary([opts.pack ?? PACK]) });
  const players = Array.from({ length: opts.host ? 5 : 4 - (opts.humans ?? 0) }, (_, i) => bot(i + 1));
  const humans = Array.from({ length: opts.humans ?? 0 }, (_, i) => human(i + 1));
  const { gameId, rec } = startGame(manager, 'jubensha', {
    players,
    humans,
    ...(humans.length ? { referee: REF } : { autoReferee: true }),
    options: { random_seats: false, stage: 'group', ...(opts.host ? { host: '105' } : {}), ...opts.options },
  });
  const r = rec as Rec;
  const act = (seat: Seat, input: ActionInput) => manager.act(identityOf(r, seat), gameId, input);
  const view = (seat: Seat) => manager.getView(identityOf(r, seat), gameId) as any;
  const pub = () => (manager.getView(identityOf(r, 1), gameId) as any).public;
  const seatOf = (key: string) => Number(Object.entries(r.state.cast).find(([, k]) => k === key)![0]);
  const key = () => r.phase?.key ?? null;
  const quizDefault = (s: Seat): ActionInput => {
    const q = (view(s).you.questionnaire as any[]).find((x) => x.my_answer === null) ?? view(s).you.questionnaire[0];
    return { action: 'answer_q', text: `${q.no}:${q.options[0].key}` };
  };
  const drive = (over: Record<string, (s: Seat) => ActionInput> = {}, until: () => boolean = () => false) => {
    for (let i = 0; i < 400 && r.status === 'running' && !until(); i++) {
      const seats = pendingSeats(r);
      if (seats.length === 0) {
        clock.advance(5000);
        manager.tick();
        continue;
      }
      const k = key()!;
      for (const s of seats) {
        if (until() || r.phase?.key !== k || !r.phase.pending[String(s)] || r.phase.pending[String(s)]!.done) continue;
        const def: ActionInput =
          k === 'read'
            ? { action: 'ready' }
            : k === 'search'
              ? { action: 'skip' }
              : k === 'discuss'
                ? { action: 'end_speech' }
                : k === 'quiz'
                  ? quizDefault(s)
                  : { action: 'speech', text: '我是我。' };
        act(s, over[k]?.(s) ?? def);
      }
    }
  };
  return { manager, clock, gameId, rec: r, act, view, pub, seatOf, key, drive };
}

const groupTexts = (rec: Rec) => [
  ...rec.log.filter((e) => e.audience.type === 'public').map((e) => e.text),
  ...rec.outbox.filter((d) => d.target.type === 'group').map((d) => d.text),
];

describe('jubensha search: data format', () => {
  it('accepts the demo and rejects broken search data', () => {
    const p = parsePack(PACK);
    expect(p.clues).toHaveLength(10);
    expect(packWarnings(p)).toEqual([]);
    const bad = (mut: (p: any) => void, re: RegExp) => {
      const p = clone();
      mut(p);
      expect(() => parsePack(p)).toThrow(re);
    };
    bad((p) => (p.clues[0].at = 'nowhere'), /既不是地点也不是角色/);
    bad((p) => delete p.clues[2].round, /要写 round/);
    bad((p) => (p.clues[2].round = 5), /没有哪一幕的 search 开放/);
    bad((p) => (p.clues[1].deep = ['stairs_paint']), /成环/);
    bad((p) => (p.clues[0].deep = ['ghost']), /ghost 不存在/);
    bad((p) => (p.clues[0].deep = []), /deep_only.*永远拿不到/);
    bad((p) => (p.clues[0].images = ['nope']), /图片 nope/);
    bad((p) => (p.questionnaire[1].answer = ['z']), /答案 z 不在选项里/);
    bad((p) => (p.questionnaire[1].culprit = true), /至多一道题/);
    bad((p) => (p.search.points = 0), /search\.points/);
    bad((p) => (p.search.carry_over = false), /max_points/);
    bad((p) => p.locations.push({ key: 'mei', name: 'x' }), /和角色 key 重名/);
    // 卡背标签含凶手名：能加载，但给出警告
    const warn = clone();
    warn.clues[2].title = '气象员阿梅的日志';
    expect(packWarnings(parsePack(warn))[0]).toMatch(/可能剧透/);
  });

  it('packs without clues keep the old flow (no search state, vote not questionnaire)', () => {
    const p = clone();
    for (const k of ['clues', 'locations', 'questionnaire', 'search']) delete p[k];
    for (const a of p.acts) delete a.search;
    const g = game({ pack: p });
    expect(g.rec.state.search).toBeUndefined();
    g.drive({}, () => g.key() === 'vote');
    expect(g.key()).toBe('vote');
  });
});

describe('jubensha search: searching', () => {
  it('search phase comes after reading; cards go only to the finder; group sees only where', () => {
    const g = game();
    const steps: string[] = [];
    g.drive({}, () => {
      const k = g.key();
      if (k && steps[steps.length - 1] !== k) steps.push(k);
      return k === 'search';
    });
    expect(steps.slice(-3)).toEqual(['intro', 'read', 'search']);
    expect(g.rec.phase!.secret).toBe(true);
    const lan = g.seatOf('lan');
    const res = g.act(lan, { action: 'search', text: '旋梯' }) as any;
    expect(res.message).toContain('旋梯第十二级刚刷过红漆');
    expect(res.message).toContain('可以深入');
    const v = g.view(lan).you.search;
    expect(v.my_cards.map((c: any) => c.id)).toEqual(['stairs_paint']);
    expect(v.this_round).toBe(1);
    expect(v.points_left).toBe(2);
    // 别人看不到卡面
    const other = g.seatOf('kai');
    expect(JSON.stringify(g.view(other))).not.toContain('半个鞋印');
    expect(JSON.stringify(g.pub())).not.toContain('半个鞋印');
    expect(groupTexts(g.rec).some((t) => t.includes(`搜了 旋梯`))).toBe(true);
    for (const t of groupTexts(g.rec)) expect(t).not.toContain('半个鞋印');
    // 私发给本人
    expect(g.rec.log.some((e) => e.audience.type === 'seats' && e.audience.seats.join() === String(lan) && e.text.includes('半个鞋印'))).toBe(true);
    // 独占：旋梯本轮只有这一张
    expect(() => g.act(other, { action: 'search', text: 'stairs' })).toThrow(/没有你能搜到的线索/);
    // 深入（花 1 点）→ 本轮 max_points=2 用完，自动结束
    const deep = g.act(lan, { action: 'deep', text: '红漆' }) as any;
    expect(deep.message).toContain('女式雨靴');
    expect(deep.message).toContain('本轮点数已用完');
    expect(g.rec.phase!.pending[String(lan)]!.done).toBe(true);
    expect(groupTexts(g.rec).some((t) => t.includes('深入调查了「旋梯·红漆」'))).toBe(true);
    expect(g.pub().search.log.map((x: any) => x.how)).toEqual(['search', 'deep']);
  });

  it('cannot search yourself; can search another role from round 2; unused points carry over', () => {
    const g = game();
    g.drive({}, () => g.key() === 'search');
    const mei = g.seatOf('mei');
    const kai = g.seatOf('kai');
    // 第一轮人身上没卡
    expect(() => g.act(kai, { action: 'search', target: mei })).toThrow(/没有你能搜到的线索/);
    expect(() => g.act(kai, { action: 'search', text: '阿凯' })).toThrow(/不能搜自己/);
    g.act(kai, { action: 'search', text: 'lamp' }); // 1 点
    g.act(kai, { action: 'skip' });
    g.drive({}, () => g.key() === 'search' && g.rec.state.act === 1);
    expect(g.view(kai).you.search.points_left).toBe(2);
    expect(g.view(kai).you.search.this_round).toBe(2); // 第二轮没有 max_points，只受剩余点数限制
    expect(g.view(kai).you.search.places.map((p: any) => p.key)).not.toContain('kai');
    const r = g.act(kai, { action: 'search', text: `${mei}号` }) as any;
    expect(r.message).toContain('漆印');
    // 搜到 public 卡会自动公开
    g.act(kai, { action: 'search', text: '码头' });
    expect(g.view(kai).you.search.points_left).toBe(0);
    expect(g.rec.phase!.pending[String(kai)]!.done).toBe(true);
  });

  it('public clues are announced automatically', () => {
    const g = game();
    g.drive({}, () => g.key() === 'search' && g.rec.state.act === 1);
    const bo = g.seatOf('bo');
    let got: string[] = [];
    for (let i = 0; i < 3 && !got.includes('notice'); i++) {
      try {
        g.act(bo, { action: 'search', text: 'dock' });
      } catch {
        break;
      }
      got = g.view(bo).you.search.my_cards.map((c: any) => c.id);
    }
    expect(got).toContain('notice');
    expect(g.pub().search.shared.map((x: any) => x.id)).toEqual(['notice']);
    expect(groupTexts(g.rec).some((t) => t.includes('气象站下月起搬迁'))).toBe(true);
  });

  it('a holder can share a card during discussion; it then shows in the public view', () => {
    const g = game();
    g.drive({}, () => g.key() === 'search');
    const lan = g.seatOf('lan');
    g.act(lan, { action: 'search', text: 'lamp' });
    expect(() => g.act(g.seatOf('kai'), { action: 'share', text: 'lamp_log' })).toThrow(/还没有线索卡/);
    g.drive({}, () => g.key() === 'discuss');
    expect(g.act(lan, { action: 'share', text: '日志' })).toMatchObject({ message: expect.stringContaining('已在群里公开') });
    expect(g.pub().search.shared[0]).toMatchObject({ by: lan, id: 'lamp_log', text: expect.stringContaining('阿梅来送资料') });
    expect(() => g.act(lan, { action: 'share', text: 'lamp_log' })).toThrow(/都已经公开过了/);
  });

  it('the DM sees every card and can hand one out for free', () => {
    const g = game({ host: true });
    g.drive({}, () => g.key() === 'search');
    const dm = g.view(5).you;
    expect(dm.search.clues.map((c: any) => c.id)).toContain('stairs_paint');
    expect(dm.search.clues.find((c: any) => c.id === 'stairs_paint').text).toBeUndefined();
    expect((g.act(5, { action: 'lookup', text: 'clue:stairs_paint' }) as any).message).toContain('半个鞋印');
    expect(() => g.act(5, { action: 'give', target: 1, text: 'mei_boots' })).toThrow(/没有「mei_boots」|可选/); // 第二轮还没开放
    g.act(5, { action: 'give', target: 1, text: 'dock_boat' });
    expect(g.view(1).you.search.points_left).toBe(3);
    expect(g.view(1).you.search.my_cards[0].id).toBe('dock_boat');
    expect(groupTexts(g.rec).some((t) => t.includes('DM 交给 1号'))).toBe(true);
    expect(() => g.act(2, { action: 'give', target: 1, text: 'lamp_log' })).toThrow();
  });

  it('clue_level switches hint and hard cards', () => {
    const ids = (lvl: string) => {
      const g = game({ host: true, options: { clue_level: lvl } });
      return g.view(5).you.search.clues.map((c: any) => c.id);
    };
    expect(ids('normal')).toContain('bo_bag');
    expect(ids('normal')).not.toContain('lamp_hint');
    expect(ids('easy')).toContain('lamp_hint');
    expect(ids('easy')).not.toContain('bo_bag');
  });

  it('humans search, deepen, finish and share by private chat', async () => {
    const g = game({ humans: 1 });
    const hs = g.rec.players.find((p) => p.kind === 'human')!;
    const relay = (text: string, channel: 'group' | 'private' = 'private') =>
      g.manager.relayHumanMessage(REF, g.gameId, { userId: hs.id, text, channel });
    for (let i = 0; i < 40 && g.key() !== 'search'; i++) {
      await g.manager.refereeStep(REF, g.gameId);
      if (g.key() === 'search') break;
      const k = g.key();
      if (k === 'intro' && g.rec.phase!.pending[String(hs.seat)]) relay('我是我。', 'group'), relay('过', 'group');
      if (k === 'read') relay('读完', 'group');
      for (const s of pendingSeats(g.rec)) if (s !== hs.seat) g.act(s, k === 'read' ? { action: 'ready' } : { action: 'speech', text: '你好。' });
    }
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.key()).toBe('search');
    expect(relay('搜 旋梯').accepted).toBe(true);
    expect(g.view(1).you).toBeTruthy();
    expect(relay('深入 红漆').accepted).toBe(true);
    expect(g.rec.state.search!.holders.stairs_paint2).toEqual([hs.seat]);
    expect(relay('搜完了').recognized).toBe(false); // 点数用完，已经结束
    for (const s of pendingSeats(g.rec)) g.act(s, { action: 'skip' });
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.key()).toBe('discuss');
    expect(relay('公开 鞋印细看', 'group').accepted).toBe(true);
    expect(g.rec.state.search!.shared.map((x) => x.id)).toEqual(['stairs_paint2']);
  });
});

describe('jubensha search: questionnaire', () => {
  it('replaces the vote; one answer per call, re-answer allowed; scores, MVP and solved', () => {
    const g = game();
    g.drive({}, () => g.key() === 'quiz');
    expect(g.key()).toBe('quiz');
    const mei = g.seatOf('mei');
    const kai = g.seatOf('kai');
    expect(g.view(kai).you.questionnaire.map((q: any) => q.no)).toEqual([1, 2, 3]);
    expect(g.view(mei).you.questionnaire.map((q: any) => q.no)).toEqual([1, 2]);
    expect(() => g.act(mei, { action: 'answer_q', text: '3:a' })).toThrow(/你要答的题/);
    expect(() => g.act(mei, { action: 'answer_q', text: '1:nobody' })).toThrow(/选项里没有/);
    expect(() => g.act(mei, { action: 'vote', target: 1 })).toThrow(/answer_q/);
    // 凶手乱答
    g.act(mei, { action: 'answer_q', text: `1:${kai}号` });
    g.act(mei, { action: 'answer_q', text: '2:c' });
    const others = [1, 2, 3, 4].filter((s) => s !== mei);
    const [a, b, c] = others as [Seat, Seat, Seat];
    // a、b 答对真凶，c 答错；a 先答错再改
    g.act(a, { action: 'answer_q', text: '1:kai' });
    g.act(a, { action: 'answer_q', text: '1:气象员阿梅' });
    g.act(b, { action: 'answer_q', text: 'who:mei' });
    g.act(c, { action: 'answer_q', text: '1:lan' });
    for (const s of others) g.act(s, { action: 'answer_q', text: '2:a' });
    expect(g.key()).toBe('quiz'); // 阿凯还有第 3 题
    expect(JSON.stringify(g.pub())).not.toContain('my_answer');
    g.act(kai, { action: 'answer_q', text: '第3题 风浪' });
    g.drive({}, () => g.key() === 'confess');
    const res = g.rec.state.quiz!;
    expect(res.scores[String(a)]).toBeGreaterThanOrEqual(15);
    expect(res.scores[String(mei)]).toBe(0);

    expect(g.rec.state.outcome!.solved).toBe(true);
    expect(groupTexts(g.rec).some((t) => t.includes('📊 问卷结果') && t.includes('MVP'))).toBe(true);
    g.drive();
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result!.winnerTeam).toBe('侦破方');
    expect(g.rec.result!.winnerSeats).not.toContain(mei);
    expect(g.pub().quiz.mvp.length).toBeGreaterThan(0);
    // 没被搜到的线索在结束时公布
    expect(groupTexts(g.rec).some((t) => t.includes('🗂 没有被搜到的线索'))).toBe(true);
  });

  it('the culprit scores nothing on the culprit question', () => {
    const g = game();
    g.drive({}, () => g.key() === 'quiz');
    const mei = g.seatOf('mei');
    for (const s of [1, 2, 3, 4]) for (const q of g.view(s).you.questionnaire as any[]) g.act(s, { action: 'answer_q', text: `${q.no}:${q.no === 1 ? 'mei' : 'a'}` });
    g.drive({}, () => g.key() === 'confess');
    expect(g.rec.state.quiz!.scores[String(mei)]).toBe(5);
    expect(g.rec.state.outcome!.top).not.toContain(mei);
  });

  it('without a culprit question the MVP wins', () => {
    const p = clone();
    p.questionnaire[0].culprit = false;
    const g = game({ pack: p });
    const mei = g.seatOf('mei');
    g.drive({}, () => g.key() === 'quiz');
    for (const s of [1, 2, 3, 4]) {
      for (const q of g.view(s).you.questionnaire as any[]) g.act(s, { action: 'answer_q', text: `${q.no}:${q.no === 1 && s !== mei ? 'mei' : q.options[0].key}` });
    }
    g.drive();
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result!.winnerTeam).toBe('MVP');
  });

  it('human answers by private chat', async () => {
    const g = game({ humans: 1 });
    const hs = g.rec.players.find((p) => p.kind === 'human')!;
    const relay = (text: string, channel: 'group' | 'private' = 'private') =>
      g.manager.relayHumanMessage(REF, g.gameId, { userId: hs.id, text, channel });
    for (let i = 0; i < 200 && g.key() !== 'quiz'; i++) {
      await g.manager.refereeStep(REF, g.gameId);
      const k = g.key();
      if (k === 'quiz') break;
      if (g.rec.phase?.pending[String(hs.seat)] && !g.rec.phase.pending[String(hs.seat)]!.done) {
        if (k === 'intro') relay('我是我。', 'group'), relay('过', 'group');
        else if (k === 'read') relay('读完', 'group');
        else if (k === 'search') relay('搜完了');
        else if (k === 'discuss') relay('过', 'group');
      }
      for (const s of pendingSeats(g.rec)) if (s !== hs.seat) g.act(s, k === 'read' ? { action: 'ready' } : k === 'search' ? { action: 'skip' } : k === 'discuss' ? { action: 'end_speech' } : { action: 'speech', text: '嗯。' });
    }
    await g.manager.refereeStep(REF, g.gameId);
    expect(g.key()).toBe('quiz');
    expect(relay('1 若寂').accepted).toBe(false);
    expect(relay('1 阿梅', 'group').recognized).toBe(false); // 群里不收答案
    expect(relay(`1 ${g.seatOf('mei')}号`).accepted).toBe(true);
    expect(relay('2 a').accepted).toBe(true);
    expect(g.rec.phase!.data.answers[String(hs.seat)]).toMatchObject({ who: 'mei', how: 'a' });
  });
});

describe('jubensha search: secrecy and random play', () => {
  it('no unshared card text reaches the group before the end', () => {
    for (const seed of [1, 2, 3]) {
      const g = game({ seed, host: true });
      g.drive(
        {
          search: (s) => {
            const v = g.view(s).you.search;
            const spot = (v.places as any[]).find((p) => p.left > 0);
            return v.this_round > 0 && spot ? { action: 'search', text: spot.key } : { action: 'skip' };
          },
        },
        () => g.key() === 'confess',
      );
      const shared = new Set(g.rec.state.search!.shared.map((x) => x.id));
      const secret = PACK.clues.filter((c: any) => !c.public && !shared.has(c.id)).map((c: any) => c.text) as string[];
      for (const t of groupTexts(g.rec)) for (const s of secret) expect(t).not.toContain(s);
      const pub = JSON.stringify(g.pub());
      for (const s of secret) expect(pub).not.toContain(s);
    }
    expect(CARD_TEXTS.length).toBeGreaterThan(0);
  });

  it('random games always end and the state survives JSON round-trips', async () => {
    for (const seed of [1, 2, 3, 'x', 'y', 'z']) {
      const { manager, clock } = setup(seed, undefined, { scripts: memoryLibrary([PACK]) });
      const players = Array.from({ length: 5 }, (_, i) => bot(i + 1));
      const withHost = typeof seed === 'number';
      const { gameId, rec } = startGame(manager, 'jubensha', {
        players: withHost ? players : players.slice(0, 4),
        autoReferee: true,
        options: { stage: 'group', ...(withHost ? { host: '105' } : {}) },
      });
      await playToEnd(manager, gameId, { clock, onStep: (r) => void JSON.parse(JSON.stringify(r.state)) });
      expect(rec.status).toBe('ended');
      const st = rec.state as JubenshaState;
      expect(st.quiz).toBeTruthy();
      expect(Object.values(st.search!.left).every((x) => x >= 0)).toBe(true);
    }
  });
});
