import { describe, expect, it } from 'vitest';
import type { GameRecord, Identity, ActionInput } from '../../src/core/types.js';
import { REF, bot, human, identityOf, pendingSeats, playToEnd, setup, startGame } from '../helpers.js';

type Roles = Partial<Record<'werewolf' | 'wolf_king' | 'villager' | 'seer' | 'witch' | 'hunter' | 'guard' | 'idiot', number>>;
const sum = (r: Roles) => Object.values(r).reduce((a, b) => a + (b ?? 0), 0);

/** 老测试按「无起跳、无警长、屠边」的经典流程写；新机制的测试显式打开。 */
const LEGACY = { claim_phase: false, sheriff: false, win_mode: 'side' };

function make(roles: Roles, extra: Record<string, unknown> = {}, seed: string | number = 1) {
  const n = sum(roles);
  const { manager, clock } = setup(seed);
  const players = Array.from({ length: n }, (_, i) => bot(i + 1));
  const { gameId, rec } = startGame(manager, 'werewolf', { players, autoReferee: true, options: { roles, night_min_s: 0, ...LEGACY, ...extra } });
  const roleOf = (s: number): string => rec.state.roles[String(s)];
  const seatsOf = (role: string): number[] =>
    Object.entries(rec.state.roles as Record<string, string>)
      .filter(([, r]) => r === role)
      .map(([s]) => Number(s))
      .sort((a, b) => a - b);
  const act = (seat: number, input: ActionInput) => manager.act(identityOf(rec, seat), gameId, input);
  const key = () => rec.phase?.key ?? null;
  const alive = (s: number) => rec.players.find((p) => p.seat === s)!.alive;
  const inst = () => (manager as any).inst(rec);
  const trace: string[] = [];
  const DEFAULT = (k: string): ActionInput =>
    k === 'sheriff_order'
      ? { action: 'forward' }
      : ['vote', 'pk_vote', 'sheriff_vote', 'night', 'witch', 'hunter', 'claim', 'sheriff_signup', 'badge'].includes(k)
      ? { action: 'skip' }
      : { action: 'speech', text: '过' };
  /** 按阶段 key 覆盖行为，直到 until() 为真。 */
  function drive(over: Record<string, (seat: number) => ActionInput> = {}, until: () => boolean = () => false, max = 300) {
    for (let i = 0; i < max; i++) {
      if (rec.status !== 'running' || until()) return;
      const k = key()!;
      if (trace[trace.length - 1] !== k) trace.push(k);
      const seats = pendingSeats(rec);
      if (seats.length === 0) {
        clock.advance(5000);
        manager.tick();
        continue;
      }
      for (const s of seats) {
        if (rec.status !== 'running' || rec.phase?.key !== k) break;
        if (!rec.phase?.pending[String(s)] || rec.phase.pending[String(s)]!.done) continue;
        act(s, over[k]?.(s) ?? DEFAULT(k));
      }
    }
    throw new Error('drive: too many steps, trace=' + trace.join(','));
  }
  return { manager, clock, gameId, rec, roleOf, seatsOf, act, key, alive, inst, drive, trace };
}

const notNight = (g: ReturnType<typeof make>) => () => !['night', 'witch'].includes(g.key() ?? '');

describe('roles & options', () => {
  const presets: Record<number, Record<string, number>> = {
    6: { werewolf: 2, seer: 1, witch: 1, villager: 2 },
    7: { werewolf: 2, seer: 1, witch: 1, hunter: 1, villager: 2 },
    8: { werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 },
    9: { werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 3 },
    10: { werewolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 3 },
    11: { werewolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 3 },
    12: { werewolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
  };
  for (const [n, expected] of Object.entries(presets)) {
    it(`preset for ${n} players`, () => {
      const { manager } = setup(Number(n));
      const players = Array.from({ length: Number(n) }, (_, i) => bot(i + 1));
      const { rec } = startGame(manager, 'werewolf', { players, autoReferee: true });
      const counts: Record<string, number> = {};
      for (const r of Object.values(rec.state.roles as Record<string, string>)) counts[r] = (counts[r] ?? 0) + 1;
      expect(counts).toEqual(expected);
      expect(rec.log.find((e) => e.text.includes('狼人杀配置'))?.text).toContain(`共 ${n} 人`);
    });
  }

  it('validates custom roles and large games', () => {
    const tryStart = (n: number, options: Record<string, unknown>) => {
      const { manager } = setup(3);
      return () => startGame(manager, 'werewolf', { players: Array.from({ length: n }, (_, i) => bot(i + 1)), autoReferee: true, options });
    };
    expect(tryStart(6, { roles: { werewolf: 2, villager: 3 } })).toThrow(/合计 5/);
    expect(tryStart(6, { roles: { werewolf: 0, villager: 6 } })).toThrow(/狼人/);
    expect(tryStart(6, { roles: { werewolf: 6 } })).toThrow(/好人/);
    expect(tryStart(13, {})).toThrow(/roles/);
    expect(tryStart(13, { roles: { werewolf: 4, villager: 5, seer: 1, witch: 1, hunter: 1, guard: 1 } })).not.toThrow();
    const g = make({ werewolf: 1, villager: 3, seer: 1, idiot: 1 });
    expect(g.seatsOf('idiot')).toHaveLength(1);
  });
});

describe('night', () => {
  it('seer learns exactly the camp of the target', () => {
    const g = make({ werewolf: 2, villager: 2, seer: 1, witch: 1 });
    const seer = g.seatsOf('seer')[0]!;
    const wolf = g.seatsOf('werewolf')[0]!;
    const vil = g.seatsOf('villager')[0]!;
    const r = g.act(seer, { action: 'check', target: wolf });
    expect(r.message).toContain('狼人');
    expect(() => g.act(seer, { action: 'check', target: vil })).toThrow(/已经行动/);
    const view = g.manager.getView(identityOf(g.rec, seer), g.gameId) as any;
    expect(view.you.seer_results[0]).toContain('狼人');
    const g2 = make({ werewolf: 2, villager: 2, seer: 1, witch: 1 });
    const s2 = g2.seatsOf('seer')[0]!;
    expect(g2.act(s2, { action: 'check', target: g2.seatsOf('villager')[0]! }).message).toContain('好人');
    expect(() => g2.act(g2.seatsOf('witch')[0]!, { action: 'skip' })).toThrow();
  });

  const nightOver = (g: ReturnType<typeof make>, kill: number, guard?: number) => ({
    night: (s: number): ActionInput => {
      const r = g.roleOf(s);
      if (r === 'werewolf') return { action: 'kill', target: kill };
      if (r === 'guard' && guard) return { action: 'guard', target: guard };
      return { action: 'skip' };
    },
  });

  it('guard alone / witch alone save; guard + witch together fail (同守同救)', () => {
    const results: boolean[] = [];
    for (const [guard, save] of [[true, false], [false, true], [true, true], [false, false]] as const) {
      const g = make({ werewolf: 2, villager: 3, seer: 1, witch: 1, guard: 1 }, {}, 5);
      const v = g.seatsOf('villager')[0]!;
      g.drive(
        {
          ...nightOver(g, v, guard ? v : undefined),
          witch: () => (save ? { action: 'save' } : { action: 'skip' }),
        },
        notNight(g),
      );
      results.push(g.alive(v));
    }
    expect(results).toEqual([true, true, false, false]);
  });

  it('witch poison kills, poisoned hunter cannot shoot; wolf-killed hunter can', () => {
    const g = make({ werewolf: 2, hunter: 1, witch: 1, villager: 2 });
    const h = g.seatsOf('hunter')[0]!;
    const w = g.seatsOf('witch')[0]!;
    g.drive(
      {
        night: (s) => ({ action: 'skip' }),
        witch: (s) => (s === w ? { action: 'poison', target: h } : { action: 'skip' }),
      },
      () => g.key() === 'speech',
    );
    expect(g.alive(h)).toBe(false);
    expect(g.trace).not.toContain('hunter');

    const g2 = make({ werewolf: 2, hunter: 1, witch: 1, villager: 2 });
    const h2 = g2.seatsOf('hunter')[0]!;
    const target = g2.seatsOf('werewolf')[0]!;
    g2.drive(
      {
        night: (s) => (g2.roleOf(s) === 'werewolf' ? { action: 'kill', target: h2 } : { action: 'skip' }),
        hunter: () => ({ action: 'shoot', target }),
      },
      () => g2.key() === 'speech',
    );
    expect(g2.trace).toContain('last_words');
    expect(g2.trace.indexOf('hunter')).toBeGreaterThan(g2.trace.indexOf('last_words'));
    expect(g2.alive(h2)).toBe(false);
    expect(g2.alive(target)).toBe(false);
  });

  it('command examples only name seats that can be picked', () => {
    // 先把 3 号放逐，再让狼刀猎人：猎人提示里的「开枪N」不能举例举到已出局的 3 号
    let g = make({ werewolf: 2, hunter: 1, witch: 1, villager: 2 }, { witch_self_save: 'never' });
    for (let seed = 2; g.roleOf(3) !== 'villager'; seed++) g = make({ werewolf: 2, hunter: 1, witch: 1, villager: 2 }, { witch_self_save: 'never' }, seed);
    const h = g.seatsOf('hunter')[0]!;
    const out = 3;
    g.drive({ vote: (s) => (s === out ? { action: 'skip' } : { action: 'vote', target: out }) }, () => g.rec.round === 2 && g.key() === 'night');
    expect(g.alive(out)).toBe(false);
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: h } : { action: 'skip' }) }, () => g.key() === 'hunter');
    const ann = g.rec.log.filter((e) => e.text.includes('是猎人')).pop()!.text;
    const n = Number(ann.match(/「开枪(\d+)」/)![1]);
    expect(g.alive(n)).toBe(true);
    const req = g.rec.phase!.pending[String(h)]!;
    expect(req.actions.find((a) => a.action === 'shoot')!.command).toBe(`开枪${n}`);
  });

  it('witch self-save rules', () => {
    const run = (rule: string, secondNight: boolean) => {
      const g = make({ werewolf: 2, witch: 1, seer: 1, villager: 2 }, { witch_self_save: rule });
      const w = g.seatsOf('witch')[0]!;
      const killWitch = { night: (s: number): ActionInput => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: w } : { action: 'skip' }) };
      if (secondNight) {
        g.drive({}, () => g.key() === 'night' && g.rec.round === 2);
        g.drive(killWitch, () => g.key() === 'witch');
      } else g.drive(killWitch, () => g.key() === 'witch');
      const acts = g.rec.phase!.pending[String(w)]!.actions.map((a) => a.action);
      return { g, w, acts };
    };
    expect(run('first_night', false).acts).toContain('save');
    expect(run('never', false).acts).not.toContain('save');
    expect(run('always', true).acts).toContain('save');
    const r = run('first_night', true);
    expect(r.acts).not.toContain('save');
    expect(() => r.g.act(r.w, { action: 'save' })).toThrow();
    const ok = run('first_night', false);
    ok.g.act(ok.w, { action: 'save' });
    ok.g.drive({}, notNight(ok.g));
    expect(ok.g.alive(ok.w)).toBe(true);
  });

  it('witch only learns the victim while the antidote remains', () => {
    const g = make({ werewolf: 2, witch: 1, seer: 1, villager: 3 });
    const w = g.seatsOf('witch')[0]!;
    const v = g.seatsOf('villager')[0]!;
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: v } : { action: 'skip' }) }, () => g.key() === 'witch');
    expect(g.rec.phase!.pending[String(w)]!.prompt).toContain(`${v}号`);
    expect((g.manager.getView(identityOf(g.rec, w), g.gameId) as any).you.tonight_victim).toBe(v);
    g.act(w, { action: 'save' });
    // 第二夜：解药已用完
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: g.seatsOf('villager')[1]! } : { action: 'skip' }) }, () => g.key() === 'witch' && g.rec.round === 2);
    expect(g.rec.phase!.pending[String(w)]!.prompt).toContain('无法得知');
    expect(g.rec.phase!.pending[String(w)]!.prompt).not.toContain(`${g.seatsOf('villager')[1]}号 被`);
    expect(g.rec.phase!.pending[String(w)]!.actions.map((a) => a.action)).not.toContain('save');
  });

  it('witch_sees_victim=always: the witch still learns the victim after the antidote is gone', () => {
    const g = make({ werewolf: 2, witch: 1, seer: 1, villager: 3 }, { witch_sees_victim: 'always' });
    const w = g.seatsOf('witch')[0]!;
    const [v1, v2] = g.seatsOf('villager');
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: v1! } : { action: 'skip' }) }, () => g.key() === 'witch');
    g.act(w, { action: 'save' });
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: v2! } : { action: 'skip' }) }, () => g.key() === 'witch' && g.rec.round === 2);
    expect(g.rec.phase!.pending[String(w)]!.prompt).toMatch(new RegExp(`今晚 ${v2}号 \\S+ 被狼人袭击`));
    expect((g.manager.getView(identityOf(g.rec, w), g.gameId) as any).you.tonight_victim).toBe(v2);
    expect(g.rec.phase!.pending[String(w)]!.actions.map((a) => a.action)).not.toContain('save');
  });

  it('wolf votes: plurality, tie, 空刀, re-submission, team chat', () => {
    const roles = { werewolf: 3, seer: 1, villager: 4 };
    const victims = (votes: (wolves: number[], vil: number[]) => (number | 0)[], seed = 1) => {
      const g = make(roles, {}, seed);
      const wolves = g.seatsOf('werewolf');
      const vil = g.seatsOf('villager');
      const vs = votes(wolves, vil);
      wolves.forEach((w, i) => g.act(w, vs[i] ? { action: 'kill', target: vs[i] } : { action: 'skip' }));
      g.act(g.seatsOf('seer')[0]!, { action: 'skip' });
      return { g, dead: g.rec.players.filter((p) => !p.alive).map((p) => p.seat), vil, wolves };
    };
    // 多数
    let r = victims((_, v) => [v[0]!, v[0]!, v[1]!]);
    expect(r.dead).toEqual([r.vil[0]]);
    // 平票随机（在平票者中）
    for (let seed = 1; seed <= 6; seed++) {
      r = victims((_, v) => [v[0]!, v[1]!, 0], seed);
      expect(r.dead).toHaveLength(1);
      expect([r.vil[0], r.vil[1]]).toContain(r.dead[0]);
    }
    // 空刀 + 单票
    r = victims(() => [0, 0, 0]);
    expect(r.dead).toEqual([]);
    expect(r.g.rec.log.some((e) => e.text.includes('平安夜'))).toBe(true);
    r = victims((_, v) => [0, v[2]!, 0]);
    expect(r.dead).toEqual([r.vil[2]]);

    // 改刀
    const g = make(roles);
    const [a, b, c] = g.seatsOf('werewolf') as [number, number, number];
    const [x, y] = g.seatsOf('villager') as [number, number];
    g.act(a, { action: 'kill', target: x });
    g.act(b, { action: 'kill', target: x });
    g.act(a, { action: 'kill', target: y });
    g.act(c, { action: 'kill', target: y });
    g.act(g.seatsOf('seer')[0]!, { action: 'skip' });
    expect(g.alive(y)).toBe(false);
    expect(g.alive(x)).toBe(true);
    // 狼队收到彼此的刀人信息，村民没有
    const wolfLog = g.rec.log.filter((e) => e.audience.type === 'seats' && e.audience.seats.includes(b) && e.text.includes('选择'));
    expect(wolfLog.length).toBeGreaterThan(0);
    expect(g.rec.log.filter((e) => e.audience.type === 'seats' && e.audience.seats.includes(x) && e.text.includes('选择'))).toHaveLength(0);

    // 密谈
    const h = make(roles);
    const [w1, w2] = h.seatsOf('werewolf') as [number, number];
    h.act(w1, { action: 'kill', target: h.seatsOf('villager')[0]! });
    h.manager.speak(identityOf(h.rec, w1), h.gameId, '今晚刀3号吧', 'team');
    expect(h.rec.log.some((e) => e.kind === 'team_chat' && e.text.includes('今晚刀3号吧') && e.audience.type === 'seats' && e.audience.seats.includes(w2))).toBe(true);
    expect(h.rec.log.filter((e) => e.text.includes('今晚刀3号吧') && e.audience.type === 'public')).toHaveLength(0);
    expect(() => h.manager.speak(identityOf(h.rec, h.seatsOf('villager')[0]!), h.gameId, '我也说话', 'team')).toThrow();
  });
});

describe('night privacy (witch phase & timing)', () => {
  it('always opens the witch phase every night when the board has a witch, even if the witch is dead', () => {
    // night_min_s>0：无待行动者的 witch 阶段才会停留到可观察
    const g = make({ werewolf: 2, witch: 1, seer: 1, villager: 2 }, { night_min_s: 5 });
    const w = g.seatsOf('witch')[0]!;
    const killWitch = (s: number): ActionInput => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: w } : { action: 'skip' });
    g.drive({ night: killWitch, witch: () => ({ action: 'skip' }) }, () => g.key() === 'speech');
    expect(g.alive(w)).toBe(false);
    // 第二夜：女巫已死，仍然进入 witch 阶段，只是没有任何待行动者
    g.drive({}, () => g.key() === 'witch' && g.rec.round === 2);
    expect(g.rec.phase!.title).toBe('第2夜·女巫');
    expect(pendingSeats(g.rec)).toEqual([]);
    g.drive({}, () => g.key() === 'night' && g.rec.round === 3);
    expect(g.rec.status).toBe('running');
    expect(g.rec.round).toBe(3);
  });

  it('witch phase is opened (and instantly completes) even with night_min_s=0 when the witch is dead', () => {
    const g = make({ werewolf: 2, witch: 1, seer: 1, villager: 2 });
    const w = g.seatsOf('witch')[0]!;
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: w } : { action: 'skip' }), witch: () => ({ action: 'skip' }) }, () => g.key() === 'speech');
    expect(g.alive(w)).toBe(false);
    g.drive({}, () => g.key() === 'night' && g.rec.round === 2);
    const nightId = g.rec.phase!.id;
    g.drive({}, () => g.key() === 'speech');
    // night(id) -> witch(id+1, 无人可行动，瞬间结束) -> speech(id+2)
    expect(g.rec.phase!.id).toBe(nightId + 2);
  });

  it('witch phase title/timer looks the same whether or not the witch is alive', () => {
    const live = make({ werewolf: 2, witch: 1, seer: 1, villager: 2 }, { night_min_s: 5 });
    live.drive({}, () => live.key() === 'witch');
    const dead = make({ werewolf: 2, witch: 1, seer: 1, villager: 2 }, { night_min_s: 5 });
    const w = dead.seatsOf('witch')[0]!;
    dead.drive({ night: (s) => (dead.roleOf(s) === 'werewolf' ? { action: 'kill', target: w } : { action: 'skip' }) }, () => dead.key() === 'speech');
    dead.drive({}, () => dead.key() === 'witch' && dead.rec.round === 2);
    expect(dead.rec.phase!.timeoutMs).toBe(live.rec.phase!.timeoutMs);
    expect(dead.rec.phase!.minDurationMs).toBe(live.rec.phase!.minDurationMs);
  });

  it('skips the witch phase only when the board has no witch', () => {
    const g = make({ werewolf: 2, seer: 1, villager: 3 }, { night_min_s: 5 });
    g.drive({}, () => g.rec.round === 3);
    expect(g.trace).toContain('night');
    expect(g.trace).not.toContain('witch');
  });

  it('night_min_s defaults to 20s: instant actions do not end the night early', () => {
    const { manager, clock } = setup(7);
    const roles = { werewolf: 2, seer: 1, witch: 1, villager: 2 };
    const { gameId, rec } = startGame(manager, 'werewolf', { players: Array.from({ length: 6 }, (_, i) => bot(i + 1)), autoReferee: true, options: { roles } });
    expect(rec.phase!.minDurationMs).toBe(20_000);
    const act = (seat: number, input: ActionInput) => manager.act(identityOf(rec, seat), gameId, input);
    for (const s of pendingSeats(rec)) act(s, { action: 'skip' });
    expect(rec.phase!.key).toBe('night');
    clock.advance(19_999);
    manager.tick();
    expect(rec.phase!.key).toBe('night');
    clock.advance(1);
    manager.tick();
    expect(rec.phase!.key).toBe('witch');
    expect(rec.phase!.minDurationMs).toBe(20_000);
    for (const s of pendingSeats(rec)) act(s, { action: 'skip' });
    clock.advance(19_999);
    manager.tick();
    expect(rec.phase!.key).toBe('witch');
    clock.advance(1);
    manager.tick();
    expect(rec.phase!.key).not.toBe('witch');
    expect(rec.phase!.key).not.toBe('night');
  });
});

describe('day', () => {
  const voteAll = (target: (seat: number) => number | 0): Record<string, (s: number) => ActionInput> => ({
    vote: (s) => (target(s) ? { action: 'vote', target: target(s) } : { action: 'skip' }),
  });

  it('hunter exiled shoots and shot player gets last words; idiot revealed and loses vote', () => {
    const g = make({ werewolf: 2, hunter: 1, seer: 1, villager: 3 });
    const h = g.seatsOf('hunter')[0]!;
    const wolf = g.seatsOf('werewolf')[0]!;
    g.drive({ ...voteAll((s) => (s === h ? wolf : h)), hunter: () => ({ action: 'shoot', target: wolf }) }, () => g.key() === 'night' && g.rec.round === 2);
    expect(g.alive(h)).toBe(false);
    expect(g.alive(wolf)).toBe(false);
    const i = g.trace.indexOf('hunter');
    expect(i).toBeGreaterThan(0);
    expect(g.trace.slice(i, i + 3)).toEqual(['hunter', 'last_words']);

    const g2 = make({ werewolf: 2, idiot: 1, villager: 3 });
    const idiot = g2.seatsOf('idiot')[0]!;
    g2.drive(voteAll((s) => (s === idiot ? g2.seatsOf('werewolf')[0]! : idiot)), () => g2.key() === 'night' && g2.rec.round === 2);
    expect(g2.alive(idiot)).toBe(true);
    expect(g2.rec.state.idiotRevealed).toEqual([idiot]);
    expect(g2.rec.log.some((e) => e.text.includes('白痴') && e.audience.type === 'public')).toBe(true);
    g2.drive({}, () => g2.key() === 'vote');
    expect(pendingSeats(g2.rec)).not.toContain(idiot);
    expect(pendingSeats(g2.rec)).toHaveLength(5);
    const pub = g2.manager.getView(identityOf(g2.rec, idiot), g2.gameId) as any;
    expect(pub.public.idiot_revealed).toEqual([idiot]);
    expect(pub.you.can_vote).toBe(false);
    // 再次被放逐则死亡
    g2.drive(voteAll((s) => (s === idiot ? g2.seatsOf('werewolf')[0]! : idiot)), () => g2.key() === 'night' && g2.rec.round === 3);
    expect(g2.alive(idiot)).toBe(false);
  });

  it('plurality exile, tie goes to PK, tied again means nobody out', () => {
    const g = make({ werewolf: 2, villager: 4 });
    // 1、3 投 2；2、4 投 1 → 平票 {1,2}
    g.drive({ vote: (s) => (s === 1 || s === 3 ? { action: 'vote', target: 2 } : s === 2 || s === 4 ? { action: 'vote', target: 1 } : { action: 'skip' }) as ActionInput }, () => g.key() === 'pk_speech');
    expect(g.rec.state.voteLog[0].result).toContain('PK');
    g.drive({}, () => g.key() === 'pk_vote');
    expect(pendingSeats(g.rec).sort()).toEqual([3, 4, 5, 6]);
    expect(() => g.act(3, { action: 'vote', target: 5 })).toThrow();
    g.act(3, { action: 'vote', target: 1 });
    g.act(4, { action: 'vote', target: 2 });
    g.act(5, { action: 'skip' });
    g.act(6, { action: 'skip' });
    expect(g.rec.players.every((p) => p.alive)).toBe(true);
    expect(g.key()).toBe('night');
    expect(g.rec.log.some((e) => e.text.includes('再次平票'))).toBe(true);
    const pubText = JSON.stringify((g.manager.getView(identityOf(g.rec, 1), g.gameId) as any).public);
    expect(pubText).toContain('PK');

    // 单一多数直接放逐，投票明细一起公布
    const g2 = make({ werewolf: 2, villager: 4 });
    g2.drive(voteAll((s) => (s === 3 ? 0 : 3)), () => g2.key() === 'night' && g2.rec.round === 2);
    expect(g2.alive(3)).toBe(false);
    expect(g2.rec.log.some((e) => e.text.includes('投票结果') && /1号 \S+ → 3号 \S+/.test(e.text))).toBe(true);
  });

  it('PK flow enqueues each night step exactly once and rounds never go backwards', () => {
    for (const second of ['exile', 'tie-again'] as const) {
      const g = make({ werewolf: 2, villager: 4 });
      const rounds: number[] = [];
      const nightSteps = () => (g.rec.state.agenda as { t: string; n?: number }[]).filter((x) => x.t === 'night');
      const watch = (until: () => boolean) => () => {
        rounds.push(g.rec.round);
        return until();
      };
      // 1、3 投 2；2、4 投 1 → 平票 {1,2} → PK
      const tie = (s: number): ActionInput => (s === 1 || s === 3 ? { action: 'vote', target: 2 } : s === 2 || s === 4 ? { action: 'vote', target: 1 } : { action: 'skip' });
      g.drive({ vote: tie }, watch(() => g.key() === 'pk_vote'));
      // 平票后议程里只有一个夜晚步骤（n=2）
      expect(nightSteps()).toEqual([{ t: 'night', n: 2 }]);
      const pkVote = (s: number): ActionInput => (second === 'exile' ? (s === 3 || s === 4 ? { action: 'vote', target: 1 } : { action: 'skip' }) : s === 3 ? { action: 'vote', target: 1 } : s === 4 ? { action: 'vote', target: 2 } : { action: 'skip' });
      g.drive({ pk_vote: pkVote }, watch(() => g.key() === 'night' && g.rec.round === 2));
      // 进入第 2 夜后不应残留重复的夜晚步骤
      expect(nightSteps()).toEqual([]);
      g.drive({}, watch(() => g.key() === 'night' && g.rec.round === 3));
      expect(nightSteps()).toEqual([]);
      for (let i = 1; i < rounds.length; i++) expect(rounds[i]!).toBeGreaterThanOrEqual(rounds[i - 1]!);
      expect(g.rec.round).toBe(3);
      expect(g.rec.status).toBe('running');
    }
  });

  it('tally tells timed-out voters apart from deliberate abstainers; speech timeouts are announced', () => {
    const g = make({ werewolf: 2, villager: 4 });
    g.drive({}, () => g.key() === 'speech');
    const speaker = pendingSeats(g.rec)[0]!;
    g.clock.advance(g.rec.phase!.timeoutMs + 1000);
    g.manager.tick();
    expect(g.rec.log.some((e) => e.audience.type === 'public' && e.text.includes(`${speaker}号`) && e.text.includes('超时未发言'))).toBe(true);
    g.drive({}, () => g.key() === 'vote');
    g.act(1, { action: 'vote', target: 2 });
    g.act(2, { action: 'skip' });
    g.clock.advance(g.rec.phase!.timeoutMs + 1000);
    g.manager.tick();
    const tally = g.rec.log.find((e) => e.text.includes('投票结果'))!;
    expect(tally.text).toMatch(/1号 \S+ → 2号 \S+/);
    expect(tally.text).toMatch(/弃票：2号 \S+/);
    expect(tally.text).toMatch(/未投票（超时）：3号 \S+、4号 \S+、5号 \S+、6号 \S+/);
    expect(g.rec.state.voteLog[0].abstain).toEqual([2, 3, 4, 5, 6]);
  });

  it('votes stay hidden until the tally', () => {
    const g = make({ werewolf: 2, villager: 4 });
    g.drive({}, () => g.key() === 'vote');
    g.act(1, { action: 'vote', target: 2 });
    expect(g.rec.log.some((e) => e.audience.type === 'public' && (e.text.includes('投票结果') || /1号 \S+ → 2号 \S+\n/.test(e.text)))).toBe(false);
    expect(() => g.act(1, { action: 'vote', target: 1 })).toThrow();
  });

  it('human speech continues until 过; agent speech completes the turn', () => {
    const { manager, clock } = setup(11);
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players: [bot(1), bot(2), bot(3)],
      humans: [human(1), human(2), human(3)],
      referee: REF,
    });
    void clock;
    // 直接推进到第一个 speech 阶段
    const guard = async () => {
      for (let i = 0; i < 200 && rec.phase?.key !== 'speech' && rec.status === 'running'; i++) {
        await manager.refereeStep(REF, gameId);
        const seats = pendingSeats(rec);
        if (!seats.length) { clock.advance(5000); continue; }
        for (const s of seats) {
          const req = rec.phase!.pending[String(s)]!;
          const p = rec.players.find((x) => x.seat === s)!;
          const input = req.kind === 'speech' ? { action: 'end_speech' } : manager.randomActionFor(gameId, s)!;
          if (p.kind === 'agent') manager.act({ id: p.id, name: p.name }, gameId, input);
          else manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '', channel: req.channel, action: input });
        }
      }
    };
    return guard().then(async () => {
      expect(rec.phase?.key).toBe('speech');
      await manager.refereeStep(REF, gameId);
      const seat = pendingSeats(rec)[0]!;
      const p = rec.players.find((x) => x.seat === seat)!;
      if (p.kind === 'human') {
        const r1 = manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '我是好人，先听听', channel: 'group' });
        expect(r1.accepted).toBe(true);
        expect(rec.phase?.pending[String(seat)]?.done).toBe(false);
        manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '私聊发言不算', channel: 'private' });
        expect(JSON.stringify(rec.state.speeches)).not.toContain('私聊发言不算');
        const r2 = manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '过', channel: 'group' });
        expect(r2.accepted).toBe(true);
        expect(rec.state.speeches.some((s: any) => s.seat === seat && s.text.includes('先听听'))).toBe(true);
      } else {
        manager.speak({ id: p.id, name: p.name }, gameId, '我是机器人发言');
        expect(rec.phase?.key === 'speech' && rec.phase.pending[String(seat)]).toBeFalsy();
        expect(rec.state.speeches.some((s: any) => s.text === '我是机器人发言')).toBe(true);
      }
    });
  });
});

describe('win conditions', () => {
  const killOn = (g: ReturnType<typeof make>, order: number[]) => ({
    night: (s: number): ActionInput => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: order[g.rec.round - 1]! } : { action: 'skip' }),
  });

  it('side mode: wolves win once all gods are dead', () => {
    const g = make({ werewolf: 2, villager: 2, seer: 1, witch: 1 });
    const order = [g.seatsOf('seer')[0]!, g.seatsOf('witch')[0]!];
    g.drive(killOn(g, order));
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result?.winnerTeam).toBe('狼人阵营');
    expect(g.rec.result?.reason).toContain('神职');
    expect(g.rec.result?.reveal).toHaveLength(6);
  });

  it('win check takes priority over the hunter shot and last words', () => {
    // 夜晚：猎人是最后一个神职，被刀死后神职全灭 → 立即结束，无遗言、无开枪
    const g = make({ werewolf: 2, hunter: 1, villager: 3 });
    const h = g.seatsOf('hunter')[0]!;
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: h } : { action: 'skip' }), hunter: () => ({ action: 'shoot', target: g.seatsOf('werewolf')[0]! }) });
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result?.winnerTeam).toBe('狼人阵营');
    expect(g.trace).not.toContain('hunter');
    expect(g.trace).not.toContain('last_words');
    expect(g.rec.state.agenda).toEqual([]);

    // 白天：猎人被放逐且是最后一个神职 → 立即结束，无开枪
    const g2 = make({ werewolf: 2, hunter: 1, villager: 3 });
    const h2 = g2.seatsOf('hunter')[0]!;
    g2.drive({ vote: (s) => (s === h2 ? { action: 'skip' } : { action: 'vote', target: h2 }) });
    expect(g2.rec.status).toBe('ended');
    expect(g2.rec.result?.winnerTeam).toBe('狼人阵营');
    expect(g2.trace).toContain('vote');
    expect(g2.trace).not.toContain('hunter');
    expect(g2.trace).not.toContain('last_words');
  });

  it('side mode: wolves win when all villagers die', () => {
    const g = make({ werewolf: 2, villager: 2, seer: 1, witch: 1 });
    g.drive(killOn(g, g.seatsOf('villager')));
    expect(g.rec.result?.winnerTeam).toBe('狼人阵营');
    expect(g.rec.result?.reason).toContain('村民');
  });

  it('all mode: killing the gods is not enough', () => {
    const g = make({ werewolf: 2, villager: 2, seer: 1, witch: 1 }, { win_mode: 'all' });
    const order = [g.seatsOf('seer')[0]!, g.seatsOf('witch')[0]!, ...g.seatsOf('villager')];
    g.drive(killOn(g, order));
    expect(g.rec.result?.winnerTeam).toBe('狼人阵营');
    expect(g.rec.round).toBe(4);
  });

  it('good side wins when all wolves are exiled', () => {
    const g = make({ werewolf: 2, villager: 3, seer: 1 });
    const wolves = g.seatsOf('werewolf');
    g.drive({ vote: (s) => { const t = wolves.find((w) => g.alive(w) && w !== s); return t ? { action: 'vote', target: t } : { action: 'skip' }; } });
    expect(g.rec.result?.winnerTeam).toBe('好人阵营');
    expect(g.rec.result?.winnerSeats.sort()).toEqual(g.rec.players.map((p) => p.seat).filter((s) => !wolves.includes(s)));
  });

  it('draws when nobody ever dies and everybody times out', () => {
    const g = make({ werewolf: 2, villager: 2, seer: 1, witch: 1 });
    for (let i = 0; i < 4000 && g.rec.status === 'running'; i++) {
      g.clock.advance(20_000);
      g.manager.tick();
    }
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result?.winnerTeam).toBe('平局');
  });
});

describe('human commands', () => {
  it('parses night commands', () => {
    const g = make({ werewolf: 2, villager: 1, seer: 1, witch: 1, guard: 1 });
    const [w1] = g.seatsOf('werewolf') as [number];
    const seer = g.seatsOf('seer')[0]!;
    const guard = g.seatsOf('guard')[0]!;
    const witch = g.seatsOf('witch')[0]!;
    const vil = g.seatsOf('villager')[0]!;
    const p = (s: number, t: string, ch: 'group' | 'private' = 'private') => g.inst().parseCommand(s, t, ch);
    expect(p(w1, '刀3')).toEqual({ action: 'kill', target: 3 });
    expect(p(w1, '杀 3号')).toEqual({ action: 'kill', target: 3 });
    expect(p(w1, '刀三号')).toEqual({ action: 'kill', target: 3 });
    expect(p(w1, `刀@${g.rec.players[3]!.name}`)).toEqual({ action: 'kill', target: 4 });
    expect(p(w1, '空刀')).toEqual({ action: 'skip' });
    expect(p(w1, '我觉得先刀神')).toEqual({ action: 'team_chat', text: '我觉得先刀神' });
    expect(p(w1, '刀3', 'group')).toBeNull();
    expect(p(seer, '验3')).toEqual({ action: 'check', target: 3 });
    expect(p(seer, '查3')).toEqual({ action: 'check', target: 3 });
    expect(p(seer, '查验三号')).toEqual({ action: 'check', target: 3 });
    expect(p(seer, '随便聊聊')).toBeNull();
    expect(p(guard, '守3')).toEqual({ action: 'guard', target: 3 });
    expect(p(guard, '守护3')).toEqual({ action: 'guard', target: 3 });
    expect(p(guard, '空守')).toEqual({ action: 'skip' });
    expect(p(vil, '刀3')).toBeNull();
    expect(p(witch, '救')).toBeNull(); // 夜间阶段女巫还没轮到
    // 女巫阶段
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: vil } : { action: 'skip' }) }, () => g.key() === 'witch');
    expect(p(witch, '救')).toEqual({ action: 'save' });
    expect(p(witch, '用解药')).toEqual({ action: 'save' });
    expect(p(witch, '毒3')).toEqual({ action: 'poison', target: 3 });
    expect(p(witch, '不用')).toEqual({ action: 'skip' });
    expect(p(witch, '过')).toEqual({ action: 'skip' });
    expect(p(vil, '救')).toBeNull();
  });

  it('parses day commands', () => {
    const g = make({ werewolf: 2, hunter: 1, seer: 1, villager: 3 });
    const h = g.seatsOf('hunter')[0]!;
    const p = (s: number, t: string, ch: 'group' | 'private' = 'group') => g.inst().parseCommand(s, t, ch);
    g.drive({ night: (s) => (g.roleOf(s) === 'werewolf' ? { action: 'kill', target: h } : { action: 'skip' }) }, () => g.key() === 'last_words');
    const speaker = pendingSeats(g.rec)[0]!;
    expect(speaker).toBe(h);
    expect(p(h, '我留个遗言')).toEqual({ action: 'speech', text: '我留个遗言' });
    expect(p(h, '过')).toEqual({ action: 'end_speech' });
    expect(p(h, '私聊遗言', 'private')).toBeNull();
    const other = g.seatsOf('villager')[0]!;
    expect(p(other, '我也说两句')).toBeNull();
    g.drive({}, () => g.key() === 'hunter');
    expect(p(h, '开枪3')).toEqual({ action: 'shoot', target: 3 });
    expect(p(h, '带走三号')).toEqual({ action: 'shoot', target: 3 });
    expect(p(h, '不开枪')).toEqual({ action: 'skip' });
    g.act(h, { action: 'skip' });
    g.drive({}, () => g.key() === 'vote');
    const voter = pendingSeats(g.rec)[0]!;
    expect(p(voter, '投3')).toEqual({ action: 'vote', target: 3 });
    expect(p(voter, '投票 3号')).toEqual({ action: 'vote', target: 3 });
    expect(p(voter, '票三')).toEqual({ action: 'vote', target: 3 });
    expect(p(voter, `投 @${g.rec.players[4]!.name}`)).toEqual({ action: 'vote', target: 5 });
    expect(p(voter, '弃票')).toEqual({ action: 'skip' });
    expect(p(voter, '投3', 'private')).toEqual({ action: 'vote', target: 3 });
    expect(p(voter, '今天天气不错')).toBeNull();
    expect(p(h, '投3')).toBeNull(); // 已出局
  });

  it('accepts the same vote prefixes as undercover and ignores chatter starting with 投', () => {
    const g = make({ werewolf: 2, hunter: 1, seer: 1, villager: 3 });
    g.drive({}, () => g.key() === 'vote');
    const voter = pendingSeats(g.rec)[0]!;
    const p = (t: string, ch: 'group' | 'private' = 'group') => g.inst().parseCommand(voter, t, ch);
    expect(p('投给3号')).toEqual({ action: 'vote', target: 3 });
    expect(p('我投给3号')).toEqual({ action: 'vote', target: 3 });
    expect(p('投票给3')).toEqual({ action: 'vote', target: 3 });
    expect(p('票给三号')).toEqual({ action: 'vote', target: 3 });
    expect(p('我投3')).toEqual({ action: 'vote', target: 3 });
    expect(p('投3，他踩了预言家')).toEqual({ action: 'vote', target: 3 });
    expect(p('弃票')).toEqual({ action: 'skip' });
    expect(p('投资有风险，我觉得3号可疑')).toBeNull();
  });

  it('random actions are legal for every pending seat', () => {
    const g = make({ werewolf: 2, villager: 2, seer: 1, witch: 1, hunter: 1, guard: 1 });
    for (let i = 0; i < 400 && g.rec.status === 'running'; i++) {
      const seats = pendingSeats(g.rec);
      if (!seats.length) { g.clock.advance(5000); g.manager.tick(); continue; }
      for (const s of seats) {
        const a = g.manager.randomActionFor(g.gameId, s);
        expect(a).not.toBeNull();
        g.act(s, a!);
        if (g.rec.status !== 'running') break;
      }
    }
  });
});

describe('referee view & privacy', () => {
  it('humans receive private role cards through the referee', async () => {
    const { manager } = setup(21);
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players: [bot(1), bot(2), bot(3)],
      humans: [human(1), human(2), human(3)],
      referee: REF,
    });
    const step = await manager.refereeStep(REF, gameId);
    const cards = step.deliveries.filter((d: any) => d.category === 'role' && d.target.type === 'private');
    const humans = rec.players.filter((p) => p.kind === 'human');
    for (const h of humans) {
      const role = { werewolf: '狼人', villager: '村民', seer: '预言家', witch: '女巫', hunter: '猎人', guard: '守卫', idiot: '白痴' }[rec.state.roles[String(h.seat)] as string]!;
      const mine = cards.filter((d: any) => d.target.userId === h.id);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.some((d: any) => d.text.includes(`【${role}】`))).toBe(true);
      if (role === '狼人') expect(mine.some((d: any) => d.text.includes('队友') || d.text.includes('只有你'))).toBe(true);
    }
    expect(cards.filter((d: any) => rec.players.find((p) => p.id === d.target.userId)?.kind === 'agent')).toHaveLength(0);
  });

  it('a human asking 「我身份呢」 in private gets the role card again (not relayed as wolf chat)', async () => {
    const { manager } = setup(21);
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players: [bot(1), bot(2), bot(3)],
      humans: [human(1), human(2), human(3)],
      referee: REF,
    });
    await manager.refereeStep(REF, gameId);
    const logLen = rec.log.length;
    for (const h of rec.players.filter((p) => p.kind === 'human')) {
      const r = manager.relayHumanMessage(REF, gameId, { userId: h.id, text: '我身份呢？', channel: 'private' });
      expect(r).toMatchObject({ recognized: true, accepted: true });
      const step = await manager.refereeStep(REF, gameId);
      const mine = step.deliveries.filter((d: any) => d.target.type === 'private' && d.target.userId === h.id);
      expect(mine.some((d: any) => d.category === 'role' && d.text.startsWith('🔁 补发：🎴 你的身份是【'))).toBe(true);
      if (rec.state.roles[String(h.seat)] === 'werewolf') expect(mine.some((d: any) => d.text.includes('狼队友') || d.text.includes('只有你'))).toBe(true);
    }
    // 没有被当成狼队密谈或别的指令
    expect(rec.log.slice(logLen).some((e) => e.kind === 'team_chat' || e.text.includes('我身份呢'))).toBe(false);
    // 群里问不补发（身份是秘密）
    const h1 = rec.players.find((p) => p.kind === 'human')!;
    expect(manager.relayHumanMessage(REF, gameId, { userId: h1.id, text: '我身份呢', channel: 'group' }).message).not.toContain('补发');
  });

  it('never leaks bot identities in public logs or referee deliveries', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { manager, clock } = setup(`leak${seed}`);
      const n = 6 + seed;
      const { gameId, rec } = startGame(manager, 'werewolf', {
        players: Array.from({ length: n }, (_, i) => bot(i + 1)),
        referee: REF,
      });
      const seen: string[] = [];
      await playToEnd(manager, gameId, {
        referee: REF,
        clock,
        onStep: () => {
          for (const d of rec.outbox) seen.push(d.text);
        },
      });
      expect(rec.status).toBe('ended');
      const isConfig = (t: string) => t.startsWith('🐺 狼人杀配置');
      const bad = /狼(?!人杀)/;
      for (const e of rec.log) {
        if (e.audience.type === 'public' && e.kind !== 'game_over' && !isConfig(e.text)) expect(e.text).not.toMatch(bad);
        if (e.audience.type === 'referee') expect(e.text).not.toMatch(bad);
      }
      for (const d of rec.outbox) {
        expect(d.target.type).toBe('group');
        if (d.category !== 'announce' || !d.text.includes('游戏结束')) if (!isConfig(d.text)) expect(d.text).not.toMatch(bad);
      }
      const view = JSON.stringify((manager.getView(REF, gameId) as any).public);
      expect(view).not.toMatch(/狼人阵营/);
    }
  });
});

describe('full random games', () => {
  it('250 random games all terminate with a valid result', async () => {
    const outcomes: Record<string, number> = {};
    for (let seed = 0; seed < 250; seed++) {
      const { manager, clock } = setup(`ww${seed}`);
      const n = 6 + (seed % 7);
      const nh = seed % 4; // 0..3 个真人
      const players = Array.from({ length: n - nh }, (_, i) => bot(i + 1));
      const humans = Array.from({ length: nh }, (_, i) => human(i + 1));
      const options: Record<string, unknown> = {};
      if (seed % 5 === 0) options.win_mode = 'all';
      if (seed % 7 === 0) options.night_min_s = 5;
      if (seed % 11 === 0) options.witch_self_save = 'always';
      if (seed % 2 === 0) options.wolf_king = true;
      if (seed % 3 === 0 && n >= 8) options.roles = { werewolf: n >= 10 ? 3 : 2, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1, villager: n - (n >= 10 ? 3 : 2) - 5 };
      const { gameId, rec } = startGame(manager, 'werewolf', { players, humans, referee: REF, options });
      await playToEnd(manager, gameId, { referee: REF, clock, maxSteps: 4000 });
      expect(rec.status, `seed ${seed}`).toBe('ended');
      expect(rec.result, `seed ${seed}`).not.toBeNull();
      expect(['好人阵营', '狼人阵营', '平局']).toContain(rec.result!.winnerTeam);
      expect(rec.result!.reveal).toHaveLength(n);
      outcomes[rec.result!.winnerTeam] = (outcomes[rec.result!.winnerTeam] ?? 0) + 1;
    }
    expect(outcomes['好人阵营']).toBeGreaterThan(0);
    expect(outcomes['狼人阵营']).toBeGreaterThan(0);
  }, 120_000);
});

describe('day flow options (claim / second round / sheriff / recap)', () => {
  it('win_mode auto: 6–7 players play 屠城, 8+ play 屠边', () => {
    for (const [n, mode] of [[6, 'all'], [7, 'all'], [8, 'side'], [12, 'side']] as const) {
      const { manager } = setup(n);
      const { rec } = startGame(manager, 'werewolf', { players: Array.from({ length: n }, (_, i) => bot(i + 1)), autoReferee: true });
      expect(rec.state.winMode).toBe(mode);
    }
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 2 }, { win_mode: 'side' });
    expect(g.rec.state.winMode).toBe('side');
  });

  it('claim phase: claimers speak first in claim order, then the rest', () => {
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 2 }, { claim_phase: true });
    g.drive({}, () => g.key() === 'claim');
    expect(pendingSeats(g.rec).length).toBe(6);
    const p = (s: number, t: string) => g.inst().parseCommand(s, t, 'group');
    expect(p(1, '起跳')).toEqual({ action: 'claim' });
    expect(p(1, '我跳预言家')).toEqual({ action: 'claim' });
    expect(p(1, '不跳')).toEqual({ action: 'skip' });
    expect(p(1, '今天天气不错')).toBeNull();
    g.act(5, { action: 'claim' });
    g.act(2, { action: 'claim' });
    g.drive({}, () => g.key() === 'speech');
    expect(g.rec.state.order.slice(0, 2)).toEqual([5, 2]);
    expect(g.rec.state.order.length).toBe(6);
    expect(g.rec.log.some((e) => e.text.includes('起跳：5号') || e.text.includes('起跳：'))).toBe(true);
    expect(g.inst().publicView().today_claims).toEqual([5, 2]);
  });

  it('second round: every alive player speaks twice before the vote', () => {
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 2 }, { second_round: true });
    g.drive({}, () => g.key() === 'vote');
    expect(g.trace).toContain('speech2');
    const kinds = g.rec.state.speeches.map((x: { kind: string }) => x.kind);
    expect(kinds.filter((k: string) => k === 'speech').length).toBe(6);
    expect(kinds.filter((k: string) => k === 'speech2').length).toBe(6);
  });

  it('sheriff: election, 1.5 votes, speaks last, passes the badge on exile', () => {
    const g = make({ werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 }, { sheriff: true, claim_phase: true });
    g.drive({}, () => g.key() === 'sheriff_signup');
    const p = (s: number, t: string) => g.inst().parseCommand(s, t, 'group');
    expect(p(1, '上警')).toEqual({ action: 'run' });
    expect(p(1, '不上警')).toEqual({ action: 'skip' });
    // 当天有竞选就不再起跳
    g.drive({ sheriff_signup: (s) => (s === 1 || s === 2 ? { action: 'run' } : { action: 'skip' }), sheriff_vote: () => ({ action: 'vote', target: 1 }) }, () => g.key() === 'speech');
    expect(g.trace).toContain('sheriff_speech');
    expect(g.trace).not.toContain('claim');
    expect(g.rec.state.sheriff).toBe(1);
    expect(g.inst().publicView().sheriff).toBe(1);
    const order = g.rec.state.order as number[];
    expect(order[order.length - 1]).toBe(1);
    expect(order[0]).toBe(2);
    // 警长 1 号 + 3 号投 4 号（2.5 票），其余 6 人中 2 人投 5 号、其余弃票 → 4 号出局
    g.drive({ vote: (s) => (s === 1 || s === 3 ? { action: 'vote', target: 4 } : s === 6 || s === 7 ? { action: 'vote', target: 5 } : { action: 'skip' }) }, () => g.key() !== 'speech' && g.key() !== 'vote');
    const tallyText = g.rec.log.filter((e) => e.text.includes('1.5 票')).map((e) => e.text);
    expect(tallyText.length).toBeGreaterThan(0);
    expect(g.alive(4)).toBe(false);
    expect(g.alive(5)).toBe(true);
    // 第二天把警长投出去 → 遗言 → 移交警徽
    g.drive({}, () => g.key() === 'vote' || g.rec.status !== 'running');
    if (g.rec.status !== 'running') return;
    g.drive({ vote: (s) => (s === 1 ? { action: 'skip' } : { action: 'vote', target: 1 }) }, () => g.key() === 'badge' || g.rec.status !== 'running');
    if (g.rec.status !== 'running') return;
    expect(pendingSeats(g.rec)).toEqual([1]);
    expect(p(1, '警徽给3')).toEqual({ action: 'pass_badge', target: 3 });
    expect(p(1, '撕警徽')).toEqual({ action: 'skip' });
    g.act(1, { action: 'pass_badge', target: 3 });
    g.drive({}, () => g.key() !== 'badge');
    expect(g.rec.state.sheriff).toBe(3);
  });

  it('sheriff picks the speaking direction; a single night death sets the starting point; no claim phase', () => {
    const g = make({ werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 }, { sheriff: true, claim_phase: true });
    const wolves = g.seatsOf('werewolf');
    const victim = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => !wolves.includes(s) && g.roleOf(s) !== 'hunter' && g.roleOf(s) !== 'witch' && s !== 1)!;
    g.drive(
      {
        night: (s) => (wolves.includes(s) ? { action: 'kill', target: victim } : { action: 'skip' }),
        sheriff_signup: (s) => (s === 1 ? { action: 'run' } : { action: 'skip' }),
      },
      () => g.key() === 'sheriff_order',
    );
    expect(g.rec.state.sheriff).toBe(1);
    expect(pendingSeats(g.rec)).toEqual([1]);
    const p = (t: string) => g.inst().parseCommand(1, t, 'group');
    expect(p('逆序')).toEqual({ action: 'backward' });
    expect(p('顺序')).toEqual({ action: 'forward' });
    g.act(1, { action: 'backward' });
    g.drive({}, () => g.key() === 'speech');
    const order = g.rec.state.order as number[];
    const alive = [1, 2, 3, 4, 5, 6, 7, 8].filter((s) => s !== victim);
    // 从死者的下一位（逆序）开始，警长最后
    const expected: number[] = [];
    for (let k = 1; k <= 8; k++) {
      const s = ((victim - 1 - k + 16) % 8) + 1;
      if (alive.includes(s) && s !== 1) expected.push(s);
    }
    expect(order).toEqual([...expected, 1]);
    expect(g.trace).not.toContain('claim');
    // 第二天警长还在，又要定序
    g.drive({}, () => g.key() === 'sheriff_order' || g.rec.status !== 'running');
    if (g.rec.status !== 'running') return;
    expect(g.trace).not.toContain('claim');
  });

  it('sheriff: tie goes to PK, second tie loses the badge; sole candidate is elected', () => {
    const g = make({ werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 }, { sheriff: true });
    g.drive(
      {
        sheriff_signup: (s) => (s <= 2 ? { action: 'run' } : { action: 'skip' }),
        sheriff_vote: (s) => ({ action: 'vote', target: s % 2 === 0 ? 1 : 2 }),
      },
      () => g.key() === 'speech',
    );
    expect(g.trace.filter((k) => k === 'sheriff_vote').length).toBe(2);
    expect(g.rec.state.sheriff).toBe(0);
    expect(g.rec.log.some((e) => e.text.includes('警徽流失'))).toBe(true);

    const h = make({ werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 }, { sheriff: true });
    h.drive({ sheriff_signup: (s) => (s === 7 ? { action: 'run' } : { action: 'skip' }) }, () => h.key() === 'speech');
    expect(h.rec.state.sheriff).toBe(7);
    expect(h.trace).not.toContain('sheriff_vote');
  });

  it('sheriff auto: only boards of 8+ hold an election', () => {
    for (const [n, has] of [[7, false], [8, true]] as const) {
      const { manager } = setup(n);
      const { rec } = startGame(manager, 'werewolf', { players: Array.from({ length: n }, (_, i) => bot(i + 1)), autoReferee: true, options: { night_min_s: 0 } });
      expect(rec.log.some((e) => e.text.includes('竞选警长'))).toBe(has);
    }
  });

  it('game over includes a night-by-night recap', () => {
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 2 });
    const seer = g.seatsOf('seer')[0]!;
    const wolf = g.seatsOf('werewolf')[0]!;
    g.drive({
      night: (s) => (g.roleOf(s) === 'seer' && g.alive(wolf) ? { action: 'check', target: wolf } : { action: 'skip' }),
      vote: (s) => {
        const w = g.seatsOf('werewolf').find((x) => g.alive(x) && x !== s);
        return w ? { action: 'vote', target: w } : { action: 'skip' };
      },
    });
    const over = g.rec.log.find((e) => e.kind === 'game_over')!;
    expect(over.text).toContain('夜间复盘');
    expect(over.text).toContain(`第1夜：狼人空刀`);
    expect(over.text).toContain(`预言家 ${seer}号 验 ${wolf}号=狼人`);
  });
});


describe('self-explode (自爆) & wolf king (狼王)', () => {
  const isWolfRole = (r: string) => r === 'werewolf' || r === 'wolf_king';

  it('a wolf explodes mid-discussion: out with no last words, no vote, straight to night', () => {
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 3 });
    g.drive({}, () => g.key() === 'speech');
    const wolf = g.seatsOf('werewolf')[0]!;
    const round = g.rec.round;
    const speaker = pendingSeats(g.rec)[0]!;
    const res = g.act(wolf, { action: 'explode' });
    expect(res.ok).toBe(true);
    expect(g.alive(wolf)).toBe(false);
    expect(g.alive(speaker) || speaker === wolf).toBe(true);
    expect(g.rec.log.some((e) => e.text.includes('自爆了') && e.text.includes('【狼人】'))).toBe(true);
    g.drive({}, () => g.key() === 'night');
    expect(g.rec.round).toBe(round + 1);
    expect(g.trace).not.toContain('vote');
    expect(g.trace).not.toContain('last_words');
  });

  it('only living wolves in a speaking phase can explode; other players saying 自爆 are not exposed', () => {
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 3 });
    const wolf = g.seatsOf('werewolf')[0]!;
    const vil = g.seatsOf('villager')[0]!;
    const p = (s: number, t: string, ch: 'group' | 'private' = 'group') => g.inst().parseCommand(s, t, ch);
    // 夜里不能自爆
    expect(() => g.act(wolf, { action: 'explode' })).toThrow(/白天/);
    g.drive({}, () => g.key() === 'speech');
    expect(p(wolf, '自爆')).toEqual({ action: 'explode' });
    expect(p(wolf, '我自爆')).toEqual({ action: 'explode' });
    // 好人说「自爆」：轮到他发言就是普通发言，没轮到就忽略，不会报错暴露身份
    const speaker = pendingSeats(g.rec)[0]!;
    if (!isWolfRole(g.roleOf(speaker))) expect(p(speaker, '自爆')).toEqual({ action: 'speech', text: '自爆' });
    if (vil !== speaker) expect(p(vil, '自爆')).toBeNull();
    expect(() => g.act(vil, { action: 'explode' })).toThrow(/狼人/);
    expect(g.inst().privateView(wolf).can_explode_now).toBe(true);
    expect(g.inst().privateView(vil).can_explode_now).toBeUndefined();
    // 投票时不能自爆
    g.drive({}, () => g.key() === 'vote');
    expect(p(wolf, '自爆')).toBeNull();
    expect(() => g.act(wolf, { action: 'explode' })).toThrow(/投票/);
  });

  it('self_explode=false turns it off', () => {
    const g = make({ werewolf: 2, seer: 1, witch: 1, villager: 3 }, { self_explode: false });
    g.drive({}, () => g.key() === 'speech');
    const wolf = g.seatsOf('werewolf')[0]!;
    expect(g.inst().parseCommand(wolf, '自爆', 'group')).not.toEqual({ action: 'explode' });
    expect(() => g.act(wolf, { action: 'explode' })).toThrow(/不允许/);
  });

  it('exploding during the sheriff election swallows the badge for the whole game', () => {
    const g = make({ werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 }, { sheriff: true });
    g.drive({ night: () => ({ action: 'skip' }) }, () => g.key() === 'sheriff_signup');
    const wolf = g.seatsOf('werewolf')[0]!;
    g.act(wolf, { action: 'explode' });
    expect(g.rec.state.sheriff).toBe(0);
    expect(g.rec.log.some((e) => e.text.includes('警徽流失'))).toBe(true);
    g.drive({ night: () => ({ action: 'skip' }) }, () => g.key() === 'speech' || g.rec.status !== 'running');
    expect(g.trace).not.toContain('sheriff_signup'); // 第二天不再竞选
    expect(g.rec.state.sheriff).toBe(0);
  });

  it('the last wolf exploding hands the game to the good side', () => {
    const g = make({ werewolf: 1, seer: 1, witch: 1, villager: 3 });
    g.drive({ night: () => ({ action: 'skip' }) }, () => g.key() === 'speech');
    g.act(g.seatsOf('werewolf')[0]!, { action: 'explode' });
    expect(g.rec.status).toBe('ended');
    expect(g.rec.result?.winnerTeam).toBe('好人阵营');
  });

  it('wolf_king option swaps one preset wolf; custom roles may list wolf_king', () => {
    const { manager } = setup(9);
    const players = Array.from({ length: 9 }, (_, i) => bot(i + 1));
    const { rec } = startGame(manager, 'werewolf', { players, autoReferee: true, options: { wolf_king: true } });
    const counts: Record<string, number> = {};
    for (const r of Object.values(rec.state.roles as Record<string, string>)) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts).toEqual({ werewolf: 2, wolf_king: 1, seer: 1, witch: 1, hunter: 1, villager: 3 });
    expect(rec.log.find((e) => e.text.includes('狼人杀配置'))?.text).toContain('1狼王');
    const g = make({ wolf_king: 1, villager: 3, seer: 1, witch: 1 });
    expect(g.seatsOf('wolf_king')).toHaveLength(1);
  });

  it('wolf king hunts with the pack, checks as a wolf, and shoots when exiled', () => {
    const g = make({ werewolf: 1, wolf_king: 1, seer: 1, witch: 1, villager: 3 });
    const king = g.seatsOf('wolf_king')[0]!;
    const wolf = g.seatsOf('werewolf')[0]!;
    const seer = g.seatsOf('seer')[0]!;
    const vil = g.seatsOf('villager')[0]!;
    const view = g.inst().privateView(king);
    expect(view.role).toBe('狼王');
    expect((view.wolf_teammates as { seat: number }[]).map((t) => t.seat)).toEqual([wolf]);
    expect(view.can_shoot).toBe(true);
    // 狼王也参与刀人；预言家验狼王是狼人
    g.drive(
      {
        night: (s) => (s === king ? { action: 'kill', target: vil } : s === seer ? { action: 'check', target: king } : { action: 'skip' }),
      },
      notNight(g),
    );
    expect(g.alive(vil)).toBe(false);
    expect(g.rec.log.some((e) => e.text.includes(`查验结果：${king}号`) && e.text.includes('【狼人】'))).toBe(true);
    // 放逐狼王 → 狼王开枪
    g.drive({ vote: (s) => (s === king ? { action: 'skip' } : { action: 'vote', target: king }) }, () => g.key() === 'hunter' || g.rec.status !== 'running');
    expect(g.rec.status).toBe('running');
    expect(pendingSeats(g.rec)).toEqual([king]);
    expect(g.rec.phase!.title).toContain('狼王开枪');
    expect(g.rec.log.some((e) => e.text.includes(`是狼王`))).toBe(true);
    g.act(king, { action: 'shoot', target: seer });
    g.drive({}, () => g.key() !== 'hunter');
    expect(g.alive(seer)).toBe(false);
  });

  it('wolf king cannot shoot after exploding or being poisoned', () => {
    const g = make({ werewolf: 1, wolf_king: 1, seer: 1, witch: 1, villager: 3 });
    const king = g.seatsOf('wolf_king')[0]!;
    g.drive({ night: () => ({ action: 'skip' }) }, () => g.key() === 'speech');
    g.act(king, { action: 'explode' });
    expect(g.alive(king)).toBe(false);
    expect(g.rec.log.some((e) => e.text.includes('【狼王】'))).toBe(true);
    g.drive({}, () => g.key() === 'night');
    expect(g.trace).not.toContain('hunter');

    const g2 = make({ werewolf: 1, wolf_king: 1, seer: 1, witch: 1, villager: 3 });
    const king2 = g2.seatsOf('wolf_king')[0]!;
    const witch = g2.seatsOf('witch')[0]!;
    g2.drive(
      { night: () => ({ action: 'skip' }), witch: (s) => (s === witch ? { action: 'poison', target: king2 } : { action: 'skip' }) },
      () => g2.key() === 'speech',
    );
    expect(g2.alive(king2)).toBe(false);
    expect(g2.trace).not.toContain('hunter');
  });
});

describe('random games with explosions', () => {
  it('150 random games where wolves sometimes explode all terminate', () => {
    const SPEAK = ['sheriff_signup', 'sheriff_speech', 'sheriff_order', 'claim', 'speech', 'speech2', 'pk_speech'];
    let exploded = 0;
    for (let seed = 0; seed < 150; seed++) {
      const n = 6 + (seed % 7);
      const { manager, clock } = setup(`boom${seed}`);
      const players = Array.from({ length: n }, (_, i) => bot(i + 1));
      const options = { night_min_s: 0, wolf_king: seed % 2 === 0, sheriff: seed % 3 === 0, claim_phase: seed % 4 === 0 };
      const { gameId, rec } = startGame(manager, 'werewolf', { players, autoReferee: true, options });
      const inst = (manager as any).inst(rec);
      let r = seed * 7919 + 1;
      const rand = (k: number) => ((r = (r * 1103515245 + 12345) % 2147483648), r % k);
      for (let i = 0; i < 5000 && rec.status === 'running'; i++) {
        const k = rec.phase?.key ?? '';
        if (rec.phase?.openedAt != null && SPEAK.includes(k) && rand(100) < 8) {
          const wolves = rec.players.filter((p) => p.alive && ['werewolf', 'wolf_king'].includes(rec.state.roles[String(p.seat)]));
          if (wolves.length) {
            manager.act(identityOf(rec, wolves[0]!.seat), gameId, { action: 'explode' });
            exploded++;
            continue;
          }
        }
        const seats = pendingSeats(rec);
        if (seats.length === 0) {
          clock.advance(5000);
          manager.tick();
          continue;
        }
        const s = seats[0]!;
        const a = inst.randomAction(s);
        if (a) manager.act(identityOf(rec, s), gameId, a);
        else {
          clock.advance(5000);
          manager.tick();
        }
      }
      expect(rec.status, `seed ${seed}`).toBe('ended');
      expect(['好人阵营', '狼人阵营', '平局']).toContain(rec.result!.winnerTeam);
    }
    expect(exploded).toBeGreaterThan(20);
  }, 60_000);
});

describe('human self-explode via the referee', () => {
  it('a human wolf types 自爆 in the group during someone else\'s speech', async () => {
    const { manager, clock } = setup('boom-human');
    const humans = [1, 2, 3, 4, 5, 6].map((n) => human(n, `玩家${n}`));
    const { gameId, rec } = startGame(manager, 'werewolf', {
      players: [],
      humans,
      referee: REF,
      options: { roles: { werewolf: 2, seer: 1, witch: 1, villager: 2 }, night_min_s: 0, sheriff: false, claim_phase: false },
    });
    // 一路超时到白天发言
    for (let i = 0; i < 50 && rec.phase?.key !== 'speech'; i++) {
      await manager.refereeStep(REF, gameId);
      clock.advance(200_000);
      manager.tick();
    }
    await manager.refereeStep(REF, gameId);
    expect(rec.phase?.key).toBe('speech');
    const speaker = pendingSeats(rec)[0]!;
    const wolfSeat = rec.players.find((p) => p.alive && p.seat !== speaker && rec.state.roles[String(p.seat)] === 'werewolf')!.seat;
    const wolf = rec.players.find((p) => p.seat === wolfSeat)!;
    const r = manager.relayHumanMessage(REF, gameId, { userId: wolf.id, text: '自爆', channel: 'group' });
    expect(r.accepted).toBe(true);
    expect(wolf.alive).toBe(false);
    expect(rec.phase?.key).toBe('night');
    expect(rec.log.some((e) => e.audience.type === 'public' && e.text.includes(`${wolfSeat}号`) && e.text.includes('自爆了'))).toBe(true);
  });
});
