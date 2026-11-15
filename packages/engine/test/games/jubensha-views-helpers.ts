/** 剧本杀视图测试的共用辅助：合成剧本包、按阶段采样视图的驱动（生成基线和测试共用同一套推进方式）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { memoryLibrary } from '../../src/games/jubensha/index.js';
import { bot, identityOf, pendingSeats, setup, startGame } from '../helpers.js';

export interface SynthOpts {
  players: number;
  roleScript: number;
  actN: number;
  actPriv: number;
  actPub: number;
  clues: number;
  clueText: number;
  truth: number;
  notes: number;
  faq: number;
  intro: number;
  confession: number;
  images: number;
  q: number;
  /** 洪水档：每个角色/每幕每角色/每张卡挂几张图（说明 2000 字） */
  floodImages?: number;
  /** 问卷每题选项数（不填则选项是 roles） */
  qOptions?: number;
  blind?: boolean;
  clueTitle?: number;
  /** 地点个数（默认 8；格式上限 50） */
  locations?: number;
  /** 卡背也放在角色身上（搜这个人）：每个角色都成为可搜对象 */
  roleClues?: boolean;
  /** 问卷题干 / 选项文字长度（默认 60 / 50；格式上限 300 / 200） */
  qStem?: number;
  qOptText?: number;
}

export const fill = (n: number, tag: string) => (tag + '这是一段剧本文字，用来占位。').repeat(Math.ceil(n / 14)).slice(0, n);

export function synth(o: SynthOpts): any {
  const keys = Array.from({ length: o.players }, (_, i) => `r${i + 1}`);
  const flood = o.floodImages ?? 0;
  // 图片上限是整包 200 张；洪水档每个角色 / 每幕每角色 / 每张卡都挂前 flood 张（每处最多 30 张），说明每条 2000 字
  const floodImgs = flood ? Array.from({ length: 200 }, (_, i) => ({ id: `fl${i}`, file: `f${i}.jpg`, caption: fill(2000, `FC${i}_`) })) : [];
  const take = () => Array.from({ length: flood }, (_, j) => `fl${j}`);
  const roles = keys.map((k, i) => ({
    key: k,
    name: `角色${i + 1}`,
    public: fill(1000, 'P'),
    script: fill(o.roleScript, k),
    confession: i === 0 ? fill(o.confession, 'X') : '',
    images: flood ? take() : [],
  }));
  const acts = Array.from({ length: o.actN }, (_, a) => ({
    title: `第${a + 1}幕`,
    public: fill(o.actPub, 'A'),
    private: Object.fromEntries(keys.map((k) => [k, fill(o.actPriv, `${k}a${a}`)])),
    ...(flood ? { private_images: Object.fromEntries(keys.map((k) => [k, take()])) } : {}),
    ...(a >= 1 && o.clues ? { search: { round: a } } : {}),
  }));
  return {
    id: 'syn',
    title: '合成大剧本',
    players: o.players,
    summary: '合成',
    intro: fill(o.intro, 'I'),
    rules_note: fill(1500, 'R'),
    images: flood ? floodImgs : Array.from({ length: o.images }, (_, i) => ({ id: `im${i}`, file: `a${i}.jpg`, caption: fill(300, 'C') })),
    roles,
    acts,
    culprits: [keys[0]],
    truth: fill(o.truth, 'T'),
    host_notes: fill(o.notes, 'N'),
    faq: Array.from({ length: o.faq }, (_, i) => ({ keywords: [`kw${i}`], answer: fill(300, 'F') })),
    ...(o.clues
      ? {
          search: { points: 10, carry_over: true, exclusive: true, self_search: false, blind: o.blind ?? false },
          locations: Array.from({ length: o.locations ?? 8 }, (_, i) => ({ key: `loc${i}`, name: `地点${i}` })),
          clues: Array.from({ length: o.clues }, (_, i) => ({
            id: `c${i}`,
            at: o.roleClues && i % 2 === 1 ? keys[(i >> 1) % keys.length] : `loc${(o.roleClues ? i >> 1 : i) % (o.locations ?? 8)}`,
            round: 1 + (i % Math.max(1, o.actN - 1)),
            cost: 1,
            title: fill(o.clueTitle ?? 6, `线索${i}`).slice(0, o.clueTitle ?? 6),
            text: fill(o.clueText, 'K'),
            ...(flood ? { images: take() } : {}),
          })),
        }
      : {}),
    questionnaire: Array.from({ length: o.q }, (_, i) => ({
      id: `q${i}`,
      question: fill(o.qStem ?? 60, 'Q'),
      options: o.qOptions ? Array.from({ length: o.qOptions }, (_, j) => ({ key: `o${j}`, text: fill(o.qOptText ?? 50, 'O') })) : 'roles',
      answer: [o.qOptions ? 'o0' : keys[0]],
      points: 1,
      culprit: !o.qOptions && i === 0,
    })),
  };
}

export const NEAR_MAX: SynthOpts = { players: 6, roleScript: 20000, actN: 4, actPriv: 5000, actPub: 6000, clues: 200, clueText: 1000, truth: 30000, notes: 20000, faq: 40, intro: 8000, confession: 5000, images: 20, q: 8, clueTitle: 40 };
export const X1: SynthOpts = { players: 6, roleScript: 6000, actN: 4, actPriv: 1500, actPub: 1500, clues: 60, clueText: 300, truth: 6000, notes: 4000, faq: 10, intro: 3000, confession: 2000, images: 20, q: 8 };
export const BIG12: SynthOpts = { players: 12, roleScript: 6000, actN: 20, actPriv: 2000, actPub: 1500, clues: 100, clueText: 300, truth: 6000, notes: 4000, faq: 10, intro: 3000, confession: 2000, images: 20, q: 8 };

export function exampleDemo(name: 'demo-rainy-bookshop' | 'demo-search-lighthouse'): any {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../examples/jubensha/${name}.json`, import.meta.url)), 'utf8'));
}

export interface Sample {
  tag: string;
  seat: number;
  dm: boolean;
  view: any;
  /** withLog 时：同一时刻 get_game_log 给这个座位的全部事件（用来逐条对照 new_events） */
  log?: { seq: number; kind: string; text: string }[];
  /** withFull 时：同一时刻的 fullView（真人网页用的完整视图） */
  full?: any;
}

export interface Rig {
  manager: ReturnType<typeof setup>['manager'];
  clock: ReturnType<typeof setup>['clock'];
  gameId: string;
  rec: any;
  act: (seat: number, input: any) => any;
  view: (seat: number, opts?: { fullLog?: boolean }) => any;
}

export function rig(pack: any, o: { host?: boolean; options?: Record<string, unknown>; seed?: number } = {}): Rig {
  const withHost = o.host ?? true;
  const { manager, clock } = setup(o.seed ?? 1, undefined, { scripts: memoryLibrary([pack]) });
  const n = pack.players + (withHost ? 1 : 0);
  const players = Array.from({ length: n }, (_, i) => bot(i + 1));
  const { gameId, rec } = startGame(manager, 'jubensha', {
    players,
    autoReferee: true,
    options: { random_seats: false, stage: 'group', ...(withHost ? { host: `10${n}` } : {}), ...o.options },
  });
  const r: any = rec;
  return {
    manager,
    clock,
    gameId,
    rec: r,
    act: (seat, input) => manager.act(identityOf(r, seat), gameId, input),
    view: (seat, opts) => manager.getView(identityOf(r, seat), gameId, opts) as any,
  };
}

/** 推进一整局，每个阶段变化时每个座位各取一次默认视图（游标照常推进）。 */
export function driveSamples(g: Rig, o: { asks?: number; onTag?: (tag: string, g: Rig) => void; askText?: string; askAll?: number; search?: boolean; withLog?: boolean; withFull?: boolean } = {}): Sample[] {
  const r = g.rec;
  const out: Sample[] = [];
  const sample = (tag: string) => {
    for (const p of r.players) {
      const view = g.view(p.seat);
      const log = o.withLog ? (g.manager.getLog(identityOf(r, p.seat), g.gameId, { limit: 1000 }).events as any[]) : undefined;
      const full = o.withFull ? JSON.parse(JSON.stringify((g.manager as any).inst(r).fullView(p.seat))) : undefined;
      out.push({ tag, seat: p.seat, dm: p.seat === r.state.host, view, ...(log ? { log } : {}), ...(full ? { full } : {}) });
    }
  };
  let last = '';
  let asked = false;
  sample('start');
  for (let i = 0; i < 600 && r.status === 'running'; i++) {
    const k = r.phase?.key ?? '-';
    const tag = `${k}#${r.state.act}`;
    if (r.phase?.openedAt !== null && tag !== last) {
      last = tag;
      if (k === 'discuss' && !asked && r.state.host && (o.asks ?? 1) > 0) {
        asked = true;
        for (let a = 0; a < (o.asks ?? 1); a++) g.act(1, { action: 'ask', text: `${o.askText ?? '钥匙有几把？'}${a}` });
      }
      if (k === 'discuss' && o.askAll) {
        for (const p of r.players) {
          if (p.seat === r.state.host) continue;
          for (let a = 0; a < o.askAll; a++) {
            try {
              g.act(p.seat, { action: 'ask', text: `${a}号问题${'问'.repeat(560)}` });
            } catch {
              break;
            }
          }
        }
      }
      o.onTag?.(tag, g);
      sample(tag);
    }
    const seats = pendingSeats(r);
    if (k === 'quiz') {
      g.clock.advance(2_000_000);
      g.manager.tick();
      continue;
    }
    if (!seats.length) {
      g.clock.advance(5000);
      g.manager.tick();
      continue;
    }
    if (k === 'search' && o.search) {
      for (const s of seats) {
        for (let t = 0; t < 12; t++) {
          try {
            g.act(s, { action: 'search', text: `loc${(s + t) % 8}` });
          } catch {
            break;
          }
        }
      }
    }
    for (const s of seats) {
      if (r.phase?.key !== k || !r.phase.pending[String(s)] || r.phase.pending[String(s)].done) continue;
      const input = k === 'read' ? { action: 'ready' } : k === 'vote' || k === 'search' || k === 'quiz' ? { action: 'skip' } : k === 'discuss' ? { action: 'end_speech' } : { action: 'speech', text: '我是我。' };
      try {
        g.act(s, input);
      } catch {
        /* ignore */
      }
    }
  }
  sample('end');
  return out;
}
