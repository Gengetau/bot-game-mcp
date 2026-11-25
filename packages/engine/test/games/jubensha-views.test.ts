/**
 * 剧本杀 AI 座位视图（FB261108-02 第二轮）：默认视图有预算、目录 you.sections、按需取段、find、事件整理。
 * 合成包的参数、推进方式见 jubensha-views-helpers.ts；基线 fixtures/jubensha-views-baseline.json 是改前（68d1b58）的 you / public。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { MemoryStateStore } from '../../src/core/store.js';
import type { Identity } from '../../src/core/types.js';
import { createRegistry } from '../../src/games/index.js';
import { memoryLibrary } from '../../src/games/jubensha/index.js';
import {
  CAST_PUBLIC_INLINE,
  CAST_PUBLIC_TOTAL_INLINE,
  DM_CLUES_LISTED,
  DM_FAQ_INLINE,
  DM_NOTES_INLINE,
  DM_TRUTH_INLINE,
  DM_VIEW_BUDGET,
  FIND_MAX_HITS,
  FIND_SNIPPET,
  IMAGE_CAPTION_INLINE,
  MY_CARDS_LISTED,
  MY_Q_LISTED,
  OPEN_Q_LISTED,
  PLACES_LISTED,
  PLACE_TITLES_LISTED,
  PUBLIC_PLACES_LISTED,
  QUIZ_STEM_INLINE,
  QUIZ_YOU_INLINE,
  SHARED_LISTED,
  PLAYER_VIEW_BUDGET,
  POINTER_MAX,
  PUBLIC_TRUTH_INLINE,
  QUIZ_PUBLIC_INLINE,
  SECTION_PAGE,
  SHARED_TOTAL_INLINE,
  parseEventKind,
  parseSection,
  pointerLine,
  viewBudget,
} from '../../src/games/jubensha/view-limits.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { Authenticator } from '../../src/mcp/auth.js';
import { REF, bot, human, identityOf, pendingSeats, setup, startGame } from '../helpers.js';
import { makeCity } from '../city/helpers.js';
import { BIG12, NEAR_MAX, X1, driveSamples, exampleDemo, fill, rig, synth, type Rig, type Sample, type SynthOpts } from './jubensha-views-helpers.js';

const baseline = JSON.parse(readFileSync(new URL('./fixtures/jubensha-views-baseline.json', import.meta.url), 'utf8')) as Record<string, { tag: string; seat: number; dm: boolean; you: any; public: any }[]>;

const REFUSAL = '没有这一段，或者你看不到它。可用的段见 get_my_view 的 you.sections。';
const staticLen = (v: any) => JSON.stringify({ ...v, new_events: [] }).length;
const inst = (g: Rig) => (g.manager as any).inst(g.rec) as any;
const err = (fn: () => unknown): { code?: string; message: string } | null => {
  try {
    fn();
    return null;
  } catch (e: any) {
    return { code: e.code, message: e.message };
  }
};
const section = (g: Rig, seat: number, name: string, page = 1) => g.manager.getSection(identityOf(g.rec, seat), g.gameId, name, page) as any;
const joinSection = (g: Rig, seat: number, name: string) => {
  const first = section(g, seat, name);
  let t = first.text as string;
  for (let p = 2; p <= first.pages; p++) t += section(g, seat, name, p).text;
  return t;
};
const hostSeat = (g: Rig) => g.rec.state.host as number;
const playerSeats = (g: Rig) => g.rec.players.map((p: any) => p.seat).filter((s: number) => s !== hostSeat(g));
const REWRITABLE = /^(script:\d+|act\d+:\d+|confession:\d+|clue_.+:\d+)$/;

/** 在某个阶段标签第一次出现时做事（推进照 helpers 的默认方式） */
function until(g: Rig, tag: string, o: Parameters<typeof driveSamples>[1] = {}) {
  let hit = false;
  driveSamples(g, {
    ...o,
    onTag: (t) => {
      if (t === tag && !hit) {
        hit = true;
        throw new Error('__STOP__');
      }
    },
  });
}
function stopAt(g: Rig, tag: string, o: Parameters<typeof driveSamples>[1] = {}) {
  try {
    until(g, tag, o);
  } catch (e: any) {
    if (e.message !== '__STOP__') throw e;
    return;
  }
  throw new Error(`没有走到阶段 ${tag}`);
}

describe('默认视图：没超预算时与改前逐字节相同（示例包）', () => {
  const cases = [
    ['rainy-host', 'demo-rainy-bookshop', true],
    ['rainy-nohost', 'demo-rainy-bookshop', false],
    ['lighthouse-host', 'demo-search-lighthouse', true],
  ] as const;
  for (const [key, name, host] of cases) {
    it(`${key}：you 和 public 与基线深度相等（只多 sections 等新字段）`, () => {
      const g = rig(exampleDemo(name), { host });
      const samples = driveSamples(g, { withLog: true, withFull: true });
      const base = baseline[key]!;
      expect(samples.length).toBe(base.length);
      samples.forEach((s, i) => {
        const b = base[i]!;
        expect([s.tag, s.seat]).toEqual([b.tag, b.seat]);
        const you = { ...s.view.you };
        expect(Array.isArray(you.sections)).toBe(true);
        delete you.sections;
        if (s.dm) {
          delete you.open_questions_look;
          expect(you.note).toContain('open_questions_look');
          expect(you.dm_actions.slice(0, -1)).toEqual(b.you.dm_actions.slice(0, -1));
          expect(you.dm_actions.at(-1)).toContain('lookup');
          expect(you.dm_actions.at(-1)).toContain('"section":"role:3"');
          const { note: _n, dm_actions: _a, questionnaire: qNow, ...rest } = you;
          const { note: _bn, dm_actions: _ba, questionnaire: qBase, ...baseRest } = b.you;
          expect(rest).toEqual(baseRest);
          // 问卷字段：只有「用 lookup 查看」换成指向 get_my_view 的 section（lookup 仍可用，是别名）
          if (typeof qBase === 'string') {
            expect(qNow).toBe(qBase.replace('用 lookup "questionnaire" 查看', '用 get_my_view({"section":"questionnaire"}) 查看'));
            expect(qNow).not.toContain('lookup');
          } else expect(qNow).toEqual(qBase);
        } else {
          expect(you).toEqual(b.you);
          // 玩家的默认视图与完整视图（真人网页用的那份）一致
          expect(you).toEqual({ seat: s.seat, name: g.rec.players.find((p: any) => p.seat === s.seat).name, alive: true, ...s.full });
        }
        expect(s.view.public).toEqual(b.public);
        // 事件：条数、编号与 get_game_log 一致；文字只有「发给自己的重复类」被改写成指引行
        for (const ev of s.view.new_events) {
          const orig = s.log!.find((x) => x.seq === ev.seq)!;
          expect(orig.kind).toBe(ev.kind);
          if (ev.text !== orig.text) {
            expect(ev.kind).toMatch(REWRITABLE);
            expect(ev.private).toBe(true);
            expect(ev.text.length).toBeLessThanOrEqual(POINTER_MAX);
            expect(ev.text.startsWith('〔')).toBe(true);
          }
        }
      });
    });
  }
});

describe('静态部分（去掉 new_events）在预算内', () => {
  type Tier = { name: string; opts: SynthOpts; drive?: Parameters<typeof driveSamples>[1]; rigOpts?: Parameters<typeof rig>[1]; noQuestionnaire?: boolean };
  const tiers: Tier[] = [
    { name: '近上限 6 座位 4 幕', opts: NEAR_MAX, drive: { search: true } },
    { name: 'x1', opts: X1, drive: { search: true } },
    { name: '12 座位 20 幕', opts: BIG12, drive: { search: true } },
    {
      name: '格式上限的洪水（提问满 20 条、每处 30 张 2000 字图、问卷 30 题 6 选项）',
      opts: { ...NEAR_MAX, floodImages: 30, q: 30, qOptions: 6, images: 0 },
      drive: { search: true, askAll: 20 },
      rigOpts: { options: { ask_limit: 20 } },
      noQuestionnaire: true,
    },
  ];
  for (const t of tiers) {
    it(t.name, () => {
      const g = rig(synth(t.opts), t.rigOpts);
      const samples = driveSamples(g, t.drive);
      let dmMax = 0;
      let plMax = 0;
      for (const s of samples) {
        const v = { ...s.view, new_events: [] as unknown[] };
        if (t.noQuestionnaire && s.tag.startsWith('quiz')) {
          // 已知不覆盖：quiz 阶段 todo.prompt 和 hint 里各带一份问卷全文（答题必需，也是通用层的 todo / hint，本段不动）。
          // you.questionnaire 和 public.questionnaire 不再扣除：超长时它们自己缩短（QUIZ_YOU_INLINE / QUIZ_PUBLIC_INLINE）
          delete v.todo;
          delete v.hint;
        }
        const n = JSON.stringify(v).length;
        const budget = viewBudget(s.dm ? 'dm' : 'player', t.opts.players, t.opts.actN);
        if (s.dm) dmMax = Math.max(dmMax, n);
        else plMax = Math.max(plMax, n);
        expect(n, `${t.name} ${s.dm ? 'DM' : '玩家'} @${s.tag}`).toBeLessThanOrEqual(budget);
      }
      console.info(`[预算实测] ${t.name}：DM 最大 ${dmMax}（上限 ${viewBudget('dm', t.opts.players, t.opts.actN)}），玩家最大 ${plMax}（上限 ${viewBudget('player', t.opts.players, t.opts.actN)}）`);
    });
  }

  it('x1：截断提示里写的 section 名都取得到', () => {
    const g = rig(synth(X1));
    stopAt(g, 'discuss#2', { search: true });
    const names = new Set<string>();
    for (const p of g.rec.players) {
      const v = g.view(p.seat);
      for (const m of JSON.stringify(v).matchAll(/get_my_view\(\{\\"section\\":\\"([^\\]+)\\"/g)) names.add(`${p.seat}|${m[1]}`);
    }
    expect(names.size).toBeGreaterThan(0);
    for (const n of names) {
      const [seat, name] = n.split('|');
      expect(() => section(g, Number(seat), name!), n).not.toThrow();
    }
  });

  it('预算常量自检：几个内联上限加起来仍小于总预算', () => {
    const directory = 3500;
    expect(DM_NOTES_INLINE + DM_TRUTH_INLINE + DM_FAQ_INLINE + directory + OPEN_Q_LISTED * 650).toBeLessThan(DM_VIEW_BUDGET);
    expect(viewBudget('dm', 6, 6)).toBe(DM_VIEW_BUDGET);
    expect(viewBudget('player', 6, 6)).toBe(PLAYER_VIEW_BUDGET);
    expect(viewBudget('dm', 12, 20)).toBe(DM_VIEW_BUDGET + 250 * (6 + 14));
    expect(viewBudget('player', 12, 20)).toBe(PLAYER_VIEW_BUDGET + 400 * 6 + 300 * 14);
  });
});

describe('目录和取段', () => {
  it('目录里每一项都取得到，chars 等于各页拼起来、pages = ceil(chars/页长)；DM 目录含每个座位和每一幕', () => {
    const g = rig(synth(X1));
    stopAt(g, 'discuss#2', { search: true });
    for (const p of g.rec.players) {
      const sections = g.view(p.seat).you.sections as any[];
      for (const it of sections) {
        if (it.section.startsWith('find:')) continue;
        const first = section(g, p.seat, it.section);
        let text = first.text as string;
        for (let pg = 2; pg <= first.pages; pg++) text += section(g, p.seat, it.section, pg).text;
        expect(text.length, `${p.seat} ${it.section}`).toBe(it.chars);
        expect(first.chars).toBe(it.chars);
        expect(first.pages).toBe(it.pages);
        expect(it.pages).toBe(Math.max(1, Math.ceil(it.chars / SECTION_PAGE)));
      }
      if (p.seat === hostSeat(g)) {
        const names = sections.map((x) => x.section);
        for (const s of playerSeats(g)) expect(names).toContain(`role:${s}`);
        for (let a = 1; a <= X1.actN; a++) expect(names).toContain(`act:${a}`);
        for (const n of ['host_notes', 'truth', 'faq', 'clues', 'questionnaire']) expect(names).toContain(n);
        expect(JSON.stringify(sections).length).toBeLessThan(3500);
      } else {
        expect(JSON.stringify(sections).length).toBeLessThan(2500);
      }
    }
  });

  it('截断的内容用段取回完整（人物剧本、幕、真相、手册）', () => {
    const pack = synth(NEAR_MAX);
    const g = rig(pack);
    stopAt(g, 'discuss#1', { search: true });
    const dm = hostSeat(g);
    const dmYou = g.view(dm).you;
    expect(dmYou.truth.length).toBeLessThan(pack.truth.length);
    expect(dmYou.truth).toContain('section');
    const join = (seat: number, name: string) => joinSection(g, seat, name);
    expect(join(dm, 'truth')).toBe(pack.truth);
    expect(join(dm, 'host_notes')).toBe(pack.host_notes);
    for (const s of playerSeats(g)) {
      const role = pack.roles.find((r: any) => r.key === g.rec.state.cast[String(s)]);
      const v = g.view(s).you;
      expect(v.script.length).toBeLessThan(role.script.length);
      expect(join(s, 'script')).toBe(role.script);
      // 被截断的幕：段里有完整私密内容
      v.acts.forEach((a: any, i: number) => {
        const full = pack.acts[i].private[role.key];
        if (a.text !== full) expect(join(s, `act:${i + 1}`)).toBe(full);
      });
    }
  });

  it('分页：14000 字的角色剧本 → 3 页，超出页码按最后一页，最后一页没有 next', () => {
    const pack = synth({ ...X1, clues: 0 });
    pack.roles[0].script = '长'.repeat(14000);
    const g = rig(pack);
    const seat = Number(Object.entries(g.rec.state.cast).find(([, k]) => k === 'r1')![0]);
    const p1 = section(g, seat, 'script');
    expect(p1.pages).toBe(3);
    expect(p1.text.length).toBe(SECTION_PAGE);
    expect(p1.next).toEqual({ section: 'script', page: 2 });
    const p9 = section(g, seat, 'script', 9);
    expect(p9.page).toBe(3);
    expect(p9.next).toBeUndefined();
    expect(p9.text.length).toBe(2000);
    expect(p1.ok).toBe(true);
    for (const k of ['game_id', 'section', 'title', 'page', 'pages', 'chars', 'text']) expect(p1).toHaveProperty(k);
    // 旧的 lookup 文字不变（DM 看同一个角色）
    const lk = g.act(hostSeat(g), { action: 'lookup', text: String(seat), number: 3 }).message as string;
    expect(lk).toMatch(/第 3\/3 页/);
  });
});

describe('find：按关键词找', () => {
  const MARK = { role: '蓝鲸钥匙', act: '红铜怀表', clue: '青花瓷片', truth: '白鹭羽毛', notes: '灰雁手册', faq: '黑猫答疑', other: '别人剧本独有词' };
  function marked() {
    const pack = synth({ ...X1, clues: 20, clueText: 200 });
    pack.roles[0].script += `\n${MARK.role}在第三个抽屉里。`;
    pack.roles[1].script += `\n${MARK.other}只有二号知道。`;
    pack.acts[0].private.r1 += `\n${MARK.act}停在九点。`;
    pack.clues[0].text += `\n${MARK.clue}上有指纹。`;
    pack.truth += `\n${MARK.truth}落在现场。`;
    pack.host_notes += `\n${MARK.notes}提醒别剧透。`;
    pack.faq[0].answer += MARK.faq;
    return pack;
  }
  it('DM 在手册、真相、FAQ、角色剧本、幕私密、线索全文里都找得到，where/section 正确', () => {
    const g = rig(marked());
    stopAt(g, 'discuss#1', { search: true });
    const dm = hostSeat(g);
    const find = (q: string) => section(g, dm, `find:${q}`);
    const seatOfR1 = Number(Object.entries(g.rec.state.cast).find(([, k]) => k === 'r1')![0]);
    expect(find(MARK.role).hits[0]).toMatchObject({ section: `role:${seatOfR1}` });
    expect(find(MARK.role).hits[0].where).toContain('角色剧本');
    expect(find(MARK.act).hits[0]).toMatchObject({ section: 'act:1' });
    expect(find(MARK.act).hits[0].where).toContain('私密');
    expect(find(MARK.clue).hits[0]).toMatchObject({ section: 'clue:c0' });
    expect(find(MARK.truth).hits[0]).toMatchObject({ section: 'truth' });
    expect(find(MARK.notes).hits[0]).toMatchObject({ section: 'host_notes' });
    expect(find(MARK.faq).hits[0]).toMatchObject({ section: 'faq' });
    // 多词 AND、全角空格和大小写
    expect(find(`${MARK.role}　抽屉`).hits.length).toBe(1);
    expect(find(`${MARK.role} ${MARK.truth}`).hits).toEqual([]);
    const none = find('根本没有的词xyz');
    expect(none.hits).toEqual([]);
    expect(none.text).toContain('没找到');
    // 命中数和片段长度有上限
    const many = find('这是一段剧本文字');
    expect(many.hits.length).toBeLessThanOrEqual(FIND_MAX_HITS);
    for (const h of many.hits) expect(h.snippet.length).toBeLessThanOrEqual(FIND_SNIPPET + 2);
    // 每条命中的 section 都是可直接再取的
    for (const h of many.hits) expect(() => section(g, dm, h.section)).not.toThrow();
  });
  it('玩家只在自己的材料里找：自己的词命中，别人的剧本、真相、手册查不到', () => {
    const g = rig(marked());
    stopAt(g, 'discuss#1', { search: true });
    const s1 = Number(Object.entries(g.rec.state.cast).find(([, k]) => k === 'r1')![0]);
    const s2 = Number(Object.entries(g.rec.state.cast).find(([, k]) => k === 'r2')![0]);
    expect(section(g, s1, `find:${MARK.role}`).hits[0]).toMatchObject({ section: 'script' });
    expect(section(g, s1, `find:${MARK.act}`).hits[0]).toMatchObject({ section: 'act:1' });
    for (const w of [MARK.other, MARK.truth, MARK.notes, MARK.faq]) expect(section(g, s1, `find:${w}`).hits, w).toEqual([]);
    expect(section(g, s2, `find:${MARK.other}`).hits.length).toBe(1);
    expect(section(g, s2, `find:${MARK.role}`).hits).toEqual([]);
  });
});

describe('权限：玩家只能取自己的', () => {
  function midGame() {
    const g = rig(synth({ ...X1, clues: 20, clueText: 200 }));
    stopAt(g, 'discuss#2', { search: true });
    return g;
  }
  it('玩家取别人的段、DM 的段、乱写的段：同一个拒绝（错误码和文字逐字相同）', () => {
    const g = midGame();
    const dm = hostSeat(g);
    const seats = playerSeats(g) as number[];
    for (const s of seats) {
      const other = seats.find((x) => x !== s)!;
      const holders = g.rec.state.search.holders as Record<string, number[]>;
      const notMine = (g.rec.state.pack.clues as { id: string }[]).map((c) => c.id).find((id) => !(holders[id] ?? []).includes(s) && !g.rec.state.search.shared.some((x: any) => x.id === id))!;
      const bad = [
        `role:${other}`, `role:${s}`, 'role:99', 'truth', 'host_notes', 'faq', 'clues', `clue:${notMine}`, 'clue:nope', 'questionnaire', 'images', 'confession',
        `act:${g.rec.state.unlocked + 1}`, 'act:0', 'act:99', 'x', '', ' ', 'a'.repeat(200), 'ROLE:３', ` role:${other} `, `act:1;role:${other}`, `role:${other},${s}`, 'role:03x', 'find:', 'find: ', 'clue:',
      ];
      for (const b of bad) {
        const e = err(() => section(g, s, b));
        expect(e, `${s} 取 "${b}"`).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
      }
      // 自己的段都取得到（含全角、大小写、前后空白）
      for (const ok of ['script', ' SCRIPT ', 'act:1', 'ＡＣＴ：1', 'act:1号', 'questions', 'find:剧本']) expect(err(() => section(g, s, ok)), `${s} 取 ${ok}`).toBeNull();
    }
    // DM 取玩家专有的段也被拒
    for (const b of ['script', 'confession', 'places', 'role:99', 'act:0', 'clue:nope', `role:${dm}`]) {
      expect(err(() => section(g, dm, b)), b).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
    }
  });

  it('线索：别人持有的 id 和根本不存在的 id，拒绝完全一样；自己持有的和已公开的取得到', () => {
    const g = midGame();
    const seats = playerSeats(g) as number[];
    const holders = g.rec.state.search.holders as Record<string, number[]>;
    const s = seats.find((x) => Object.values(holders).some((h) => h.includes(x)))!;
    const mine = Object.keys(holders).find((id) => holders[id]!.includes(s))!;
    const theirs = Object.keys(holders).find((id) => !holders[id]!.includes(s))!;
    const a = err(() => section(g, s, `clue:${theirs}`));
    const b = err(() => section(g, s, 'clue:不存在的id'));
    expect(a).toEqual(b);
    expect(a?.message).toBe(REFUSAL);
    expect(section(g, s, `clue:${mine}`).text).toContain('这是一段剧本文字');
    // 公开后别人也取得到
    const owner = holders[theirs]![0]!;
    g.act(owner, { action: 'share', text: theirs });
    expect(err(() => section(g, s, `clue:${theirs}`))).toBeNull();
  });

  it('程序主持（没有 DM）：谁都取不到真相、手册和别人的角色，拒绝文字与有 DM 的局一样', () => {
    const g = rig(synth(X1), { host: false });
    stopAt(g, 'discuss#0');
    const seats = g.rec.players.map((p: any) => p.seat) as number[];
    for (const s of seats) {
      for (const n of ['truth', 'host_notes', 'faq', 'role:1', 'role:2', 'clues', 'act:1;x']) {
        expect(err(() => section(g, s, n)), `${s} ${n}`).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
      }
      expect(err(() => section(g, s, 'script'))).toBeNull();
    }
    const g2 = rig(synth(X1));
    stopAt(g2, 'discuss#0');
    expect(err(() => section(g2, playerSeats(g2)[0], 'truth'))).toEqual(err(() => section(g, 1, 'truth')));
  });

  it('玩家的目录不含别人的东西，也不随别人的材料变化', () => {
    const base = synth({ ...X1, clues: 20, clueText: 200 });
    const alt = synth({ ...X1, clues: 20, clueText: 200 });
    alt.roles[1].script = alt.roles[1].script + '再多一大段'.repeat(2000);
    alt.acts[2].private.r2 = '换了别人的私密内容'.repeat(300);
    alt.truth += '更长的真相';
    const a = rig(base);
    const b = rig(alt);
    stopAt(a, 'discuss#2', { search: true });
    stopAt(b, 'discuss#2', { search: true });
    const s1 = Number(Object.entries(a.rec.state.cast).find(([, k]) => k === 'r1')![0]);
    const sec = a.view(s1).you.sections as any[];
    expect(sec.map((x) => x.section).filter((n) => /^(role|truth|host_notes|faq|clues|questionnaire|images)/.test(n))).toEqual([]);
    expect(sec.map((x) => x.section)).not.toContain(`act:${a.rec.state.unlocked + 1}`);
    expect(JSON.stringify(b.view(s1).you.sections)).toBe(JSON.stringify(sec));
    // 他没拿到的线索不在目录里
    const holders = a.rec.state.search.holders as Record<string, number[]>;
    for (const it of sec.filter((x) => x.section.startsWith('clue:'))) expect(holders[it.section.slice(5)]).toContain(s1);
  });

  it('大厅里的局（还没开始）取段 → INVALID_STATE', () => {
    const { manager } = setup(1, undefined, { scripts: memoryLibrary([exampleDemo('demo-rainy-bookshop')]) });
    const lobby = manager.createGame(bot(1), { type: 'jubensha', groupId: '9000', options: { stage: 'group', script: 'demo-rainy-bookshop' }, joinAs: 'player', autoReferee: true, selfPost: false });
    expect(err(() => manager.getSection(bot(1), lobby.summary.game_id, 'script', 1))).toMatchObject({ code: 'INVALID_STATE', message: '游戏还没开始。' });
  });
});

describe('非参赛者与别的游戏', () => {
  it('真人座位、裁判、没报名的人取段都是 FORBIDDEN；数字炸弹带 section 说没有分段视图', () => {
    const demo = exampleDemo('demo-rainy-bookshop');
    const { manager } = setup(1, undefined, { scripts: memoryLibrary([demo]) });
    const players = [1, 2, 3].map((n) => bot(n));
    const { gameId, rec } = startGame(manager, 'jubensha', { players, humans: [human(1)], referee: REF, options: { stage: 'group', random_seats: false } });
    const humanSeat = rec.players.find((p) => p.kind === 'human')!.seat;
    for (const who of [REF, identityOf(rec, humanSeat), bot(99)]) {
      expect(err(() => manager.getSection(who, gameId, 'script', 1)), who.id).toMatchObject({ code: 'FORBIDDEN', message: '你不是本局的玩家，没有这个视角。' });
    }
    const nb = startGame(manager, 'number_bomb', { players: [bot(11), bot(12)], autoReferee: true, groupId: '9001' });
    expect(err(() => manager.getSection(bot(11), nb.gameId, 'script', 1))).toEqual({ code: 'INVALID_ACTION', message: '这个游戏没有分段视图。' });
  });
});

describe('取段是纯读', () => {
  it('不改 rec，不推进事件游标，不唤醒别人的长轮询', async () => {
    const g = rig(synth(X1));
    stopAt(g, 'discuss#0');
    const dm = hostSeat(g);
    const [a, b] = playerSeats(g) as number[];
    const snap = () => JSON.stringify({ state: g.rec.state, phase: g.rec.phase, log: g.rec.log.length, outbox: g.rec.outbox.length, outboxSeq: g.rec.outboxSeq, round: g.rec.round });
    g.view(a!);
    // 游标：a 看过之后又发生了一个事件；取段不能把它「吃掉」
    g.act(b!, { action: 'speech', text: '我先说一句。' });
    const before = snap();
    section(g, a!, 'script');
    section(g, a!, 'find:剧本');
    section(g, dm, 'truth');
    section(g, dm, 'role:1', 2);
    expect(snap()).toBe(before);
    const v = g.view(a!);
    expect(v.new_events.some((e: any) => e.text.includes('我先说一句'))).toBe(true);
    // 长轮询：先让一个会唤醒它的事件真的发生一次作对照
    const waiter = (seat: number) => {
      let done = false;
      const p = g.manager.waitView(identityOf(g.rec, seat), g.gameId, 60_000, { wakeOn: 'any' }).then((r) => {
        done = true;
        return r;
      });
      return { p, isDone: () => done };
    };
    const tick = () => new Promise((r) => setTimeout(r, 15));
    g.view(dm);
    const w1 = waiter(dm);
    await tick();
    expect(w1.isDone()).toBe(false);
    section(g, a!, 'script');
    section(g, dm, 'truth');
    section(g, a!, 'find:剧本');
    await tick();
    expect(w1.isDone()).toBe(false);
    g.act(playerSeats(g)[2], { action: 'speech', text: '再来一句。' });
    await w1.p;
    expect(w1.isDone()).toBe(true);
  });
});

describe('事件整理', () => {
  it('own 的人物剧本 / 幕私密 / 线索卡 / 认罪书文字变成指引行，条数和编号不变；别人的和公开的逐字不变（含结束后的复盘）', () => {
    const g = rig(synth({ ...X1, clues: 20, clueText: 200 }), { options: { ask_limit: 20 } });
    const samples = driveSamples(g, { search: true, askAll: 2, withLog: true });
    // 结束后用 full_log 再看一遍：别人的事件原样，自己的重复类是指引行
    expect(g.rec.status).toBe('ended');
    let rewritten = 0;
    for (const p of g.rec.players) {
      const v = g.view(p.seat, { fullLog: true });
      const log = g.manager.getLog(identityOf(g.rec, p.seat), g.gameId, { limit: 1000 }).events as any[];
      expect(v.new_events.map((e: any) => e.seq)).toEqual(log.map((e) => e.seq));
      v.new_events.forEach((e: any, i: number) => {
        const orig = log[i]!;
        expect(e.kind).toBe(orig.kind);
        const src = g.rec.log.find((x: any) => x.seq === e.seq) as any;
        const own = !!src && src.kind === e.kind && src.audience.type === 'seats' && src.audience.seats.includes(p.seat);
        if (e.text !== orig.text) {
          rewritten++;
          expect(own, `${p.seat} 的 ${e.kind} 不是自己的却被改写`).toBe(true);
          expect(e.kind).toMatch(REWRITABLE);
          expect(e.text.length).toBeLessThanOrEqual(POINTER_MAX);
          expect(e.text).toBe(pointerLine(parseEventKind(e.kind)!));
        } else if (parseEventKind(e.kind)) {
          // 没被改写的重复类事件只可能是别人的
          expect(own, `${p.seat} ${e.kind} ${e.private}`).toBe(false);
        }
      });
    }
    expect(rewritten).toBeGreaterThan(0);
    // 公开类、发言、提问、回答：逐字相同，没有省略
    const longKinds = new Set(['announce', 'narration', 'truth', 'unfound', 'clue_shared', 'speech', 'dm_speech', 'question', 'answer', 'system', 'act']);
    for (const s of samples) {
      for (const e of s.view.new_events) {
        if (!longKinds.has(e.kind)) continue;
        expect(e.text, `${s.seat} ${e.kind}`).toBe(s.log!.find((x) => x.seq === e.seq)!.text);
      }
    }
    // 指引行里的段名都存在
    expect(parseSection('script')).not.toBeNull();
  });

  it('重启后游标清零：第一次默认视图里事件是指引行，you.script / you.acts 仍完整可读；目录和取段结果与重启前相同', () => {
    const demo = exampleDemo('demo-rainy-bookshop');
    const lib = () => ({ scripts: memoryLibrary([demo]) });
    const { manager, clock } = setup(1, undefined, lib());
    const players = [1, 2, 3, 4, 5].map((n) => bot(n));
    const { gameId, rec } = startGame(manager, 'jubensha', { players, autoReferee: true, options: { random_seats: false, stage: 'group', host: '105' } });
    const g: Rig = { manager, clock, gameId, rec, act: (s, i) => manager.act(identityOf(rec, s), gameId, i), view: (s, o) => manager.getView(identityOf(rec, s), gameId, o) as any };
    stopAt(g, 'discuss#1');
    const keys = Object.keys(rec.state).sort();
    const before = new Map<number, any>();
    for (const p of rec.players) before.set(p.seat, { sections: g.view(p.seat).you.sections, sec: p.seat === 5 ? section(g, 5, 'truth').text : section(g, p.seat, 'script').text });
    const store = new MemoryStateStore();
    store.schedule(() => JSON.parse(JSON.stringify(manager.snapshot())));
    store.flush();
    const restored = setup(1, store, lib()).manager;
    const rrec = restored.getRecord(gameId);
    expect(Object.keys(rrec.state).sort()).toEqual(keys);
    for (const p of rrec.players) {
      const v = restored.getView(identityOf(rrec, p.seat), gameId) as any;
      expect(v.you.sections).toEqual(before.get(p.seat).sections);
      const t = restored.getSection(identityOf(rrec, p.seat), gameId, p.seat === 5 ? 'truth' : 'script', 1) as any;
      expect(t.text).toBe(before.get(p.seat).sec);
      if (p.seat !== 5) {
        expect(v.you.script.length).toBeGreaterThan(0);
        expect(v.you.acts.length).toBeGreaterThan(0);
        const own = v.new_events.filter((e: any) => /^(script|act\d+):\d+$/.test(e.kind));
        expect(own.length).toBeGreaterThan(0);
        for (const e of own) expect(e.text.startsWith('〔')).toBe(true);
      }
    }
  });
});

describe('待答提问、洪水', () => {
  it('DM 不回答：open_questions 只列最早的几条，其余记 more，section:questions 取回全部；玩家只看得到自己的', () => {
    const g = rig(synth(X1), { options: { ask_limit: 20 } });
    stopAt(g, 'read#1', { askAll: 20, asks: 0 });
    const dm = hostSeat(g);
    const you = g.view(dm).you;
    const total = g.rec.state.qa.filter((x: any) => x.a === undefined).length;
    expect(total).toBe(6 * 20);
    expect(you.open_questions.length).toBe(OPEN_Q_LISTED);
    expect(you.open_questions[0].question.startsWith('0号问题')).toBe(true);
    expect(you.open_questions_more).toBe(total - OPEN_Q_LISTED);
    expect(you.open_questions_look.length).toBe(OPEN_Q_LISTED);
    expect(you.open_questions_look[0].look[0]).toBe(`role:${you.open_questions[0].from}`);
    const all = joinSection(g, dm, 'questions');
    for (const q of g.rec.state.qa) expect(all).toContain(q.q);
    expect(g.view(dm).hint).toContain('先看 you.open_questions_look');
    expect(g.view(dm).hint).toContain(`有 ${total} 条待答提问`);
    const s = playerSeats(g)[0] as number;
    const pv = g.view(s).you;
    expect(pv.my_questions.length).toBe(MY_Q_LISTED);
    expect(pv.my_questions_more).toBe(20 - MY_Q_LISTED);
    const mine = joinSection(g, s, 'questions');
    expect(mine.match(/问：/g)!.length).toBe(20);
    expect(g.rec.state.qa.filter((x: any) => x.from === s).every((q: any) => mine.includes(q.q))).toBe(true);
    expect(mine).not.toContain('(等待');
    // 玩家的 hint 不受影响（不会带「待答提问」）
    expect(pv).not.toHaveProperty('open_questions');
    expect(g.view(s).hint).not.toContain('待答提问');
    // DM 回答之后：没有待答、没有 todo 时回到原来的 hint
    for (const q of g.rec.state.qa.slice()) g.act(dm, { action: 'answer', target: q.from, text: '好' });
    const h = g.view(dm);
    expect(h.you.open_questions).toEqual([]);
    expect(h.you.open_questions_look).toBeUndefined();
    expect(h.hint).toContain('现在不是你的回合');
  });

  it('图片说明、地点卡背标题、问卷去重', () => {
    const opts: SynthOpts = { ...NEAR_MAX, floodImages: 30, q: 30, qOptions: 6, images: 0 };
    const pack = synth(opts);
    const g = rig(pack);
    stopAt(g, 'quiz#4', { search: true });
    const s = Number(Object.entries(g.rec.state.cast).find(([, k]) => k === 'r1')![0]);
    const you = g.view(s).you;
    for (const c of you.script_images) expect(c.length).toBeLessThanOrEqual(IMAGE_CAPTION_INLINE + 120);
    for (const a of you.acts) for (const c of a.images ?? []) expect(c.length).toBeLessThanOrEqual(IMAGE_CAPTION_INLINE + 120);
    for (const card of you.search.my_cards) for (const c of card.images ?? []) expect(c.length).toBeLessThanOrEqual(IMAGE_CAPTION_INLINE + 120);
    // 取回的段里有完整说明
    expect(joinSection(g, s, 'script')).toContain(fill(2000, 'FC0_'));
    for (const p of you.search.places) {
      expect(p.cards.length).toBeLessThanOrEqual(PLACE_TITLES_LISTED);
      expect(p.cards.length + (p.cards_more ?? 0)).toBe(p.left);
    }
    const places = joinSection(g, s, 'places').split('\n');
    expect(places.length).toBe(you.search.places.length);
    you.search.places.forEach((p: any, i: number) => expect(places[i]).toContain(`剩 ${p.left} 张`));
    // 问卷：public 去掉选项，玩家自己的有选项，DM 的段有选项
    const v = g.view(s);
    expect(JSON.stringify(inst(g).publicView().questionnaire).length).toBeGreaterThan(QUIZ_PUBLIC_INLINE);
    for (const q of v.public.questionnaire) expect(q).not.toHaveProperty('options');
    // 30 题 × 6 个选项超过 QUIZ_YOU_INLINE：you.questionnaire 缩短（选项在 section:questionnaire 里，见下一条测试和「预算」一组）
    expect(v.you.questionnaire[0]).not.toHaveProperty('options');
    expect(joinSection(g, s, 'questionnaire')).toContain('o5=');
    expect(joinSection(g, hostSeat(g), 'questionnaire')).toContain('选项');
  });

  it('盲搜的局没有 places 段；非盲搜有', () => {
    const blind = rig(synth({ ...X1, blind: true }));
    stopAt(blind, 'discuss#1', { search: true });
    const s = playerSeats(blind)[0] as number;
    expect(blind.view(s).you.sections.map((x: any) => x.section)).not.toContain('places');
    expect(err(() => section(blind, s, 'places'))).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
    const open = rig(synth(X1));
    stopAt(open, 'discuss#1', { search: true });
    expect(open.view(playerSeats(open)[0]).you.sections.map((x: any) => x.section)).toContain('places');
  });

  it('线索清单：超过上限只列一部分，先放现在可以 give 的；不超过时不重排', () => {
    const g = rig(synth({ ...X1, clues: 60, clueText: 100 }));
    stopAt(g, 'search#1', { search: false });
    const search = g.view(hostSeat(g)).you.search;
    expect(search.clues.length).toBe(DM_CLUES_LISTED);
    expect(search.clues_total).toBe(60);
    expect(search.clues_more).toBe(60 - DM_CLUES_LISTED);
    const opened = g.rec.state.search.opened as number[];
    const pack = g.rec.state.pack;
    for (const c of search.clues) expect(opened).toContain(pack.clues.find((x: any) => x.id === c.id).round);
    expect(section(g, hostSeat(g), 'clues').text.split('\n').length).toBe(60);
    const small = rig(synth({ ...X1, clues: 10, clueText: 100 }));
    stopAt(small, 'search#1', { search: false });
    expect(small.view(hostSeat(small)).you.search.clues.map((c: any) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`));
    expect(small.view(hostSeat(small)).you.search.clues_more).toBeUndefined();
  });

  it('结束后 AI 视图里的 public.truth 被截断，网页和观战（publicView）仍是全文；公开线索累计有上限', () => {
    const g = rig(synth(NEAR_MAX));
    driveSamples(g, { search: true });
    const s = playerSeats(g)[0] as number;
    const v = g.view(s);
    expect(v.public.truth.length).toBeLessThan(PUBLIC_TRUTH_INLINE + 120);
    expect(inst(g).publicView().truth.length).toBe(NEAR_MAX.truth);
    expect(v.public.cast[0].public.length).toBeLessThan(400);
    expect(inst(g).publicView().cast[0].public.length).toBe(1000);
  });
});

describe('真人 DM', () => {
  it('座位网页拿到完整视图（含每个角色剧本、各幕私密、线索全文、问卷），文字里不提 get_my_view / section / lookup；开局私信按 DM 是 AI 还是真人分支', () => {
    const demo = exampleDemo('demo-search-lighthouse');
    const { manager } = setup(1, undefined, { scripts: memoryLibrary([demo]), assets: undefined });
    const players = Array.from({ length: demo.players }, (_, i) => bot(i + 1));
    const humanDm = human(1);
    const { gameId, rec } = startGame(manager, 'jubensha', { players, humans: [humanDm], referee: REF, options: { random_seats: false, stage: 'group', host: humanDm.userId } });
    const dmSeat = (rec as any).state.host as number;
    expect(rec.players.find((p) => p.seat === dmSeat)!.kind).toBe('human');
    const web = manager.webSeatView(rec, dmSeat) as any;
    const priv = web.me.private;
    expect(priv.cast[0].script.length).toBeGreaterThan(10);
    expect(priv.acts[0]).toHaveProperty('private');
    expect(priv.search.clues[0]).toHaveProperty('text');
    expect(priv.questionnaire[0]).toHaveProperty('answer');
    expect(priv).not.toHaveProperty('sections');
    const words = JSON.stringify([priv.note, priv.dm_actions]);
    for (const w of ['get_my_view', 'section', 'lookup']) expect(words).not.toContain(w);
    const brief = rec.log.find((e) => e.kind === 'dm_brief')!;
    expect(brief.text).not.toContain('get_my_view');
    expect(brief.text).toContain('座位网页');
    // 玩家的网页看不到这份视图
    const someone = (rec as any).players.find((p: any) => p.kind === 'agent').seat;
    expect(JSON.stringify(manager.webSeatView(rec, someone))).not.toContain(demo.truth.slice(0, 20));
    // AI DM 的开局私信提到 get_my_view
    const ai = rig(demo);
    const aiBrief = ai.rec.log.find((e: any) => e.kind === 'dm_brief');
    expect(aiBrief.text).toContain('get_my_view');
    expect(aiBrief.text).toContain('you.sections');
  });
});

describe('通用层', () => {
  it('别的游戏不变：默认钩子等于原来的视图，视图里没有 sections，带 section 报没有分段视图', () => {
    for (const type of ['number_bomb', 'werewolf']) {
      const n = type === 'werewolf' ? 6 : 3;
      const { manager } = setup(3);
      const players = Array.from({ length: n }, (_, i) => bot(i + 1));
      const { gameId, rec } = startGame(manager, type, { players, autoReferee: true });
      const i = (manager as any).inst(rec);
      for (const p of rec.players) {
        expect(i.agentView(p.seat)).toEqual(i.privateView(p.seat));
        expect(i.agentPublicView(p.seat)).toEqual(i.publicView());
        expect(i.agentHint(p.seat)).toBeNull();
        expect(i.hasViewSections()).toBe(false);
        const v: any = manager.getView(identityOf(rec, p.seat), gameId);
        expect(v.you).not.toHaveProperty('sections');
        expect(v.public).toEqual(i.publicView());
        expect(err(() => manager.getSection(identityOf(rec, p.seat), gameId, 'x', 1))).toEqual({ code: 'INVALID_ACTION', message: '这个游戏没有分段视图。' });
      }
      expect(i.agentEventText(1, { seq: 1, kind: 'announce', text: 'abc', own: true, image: false })).toBe('abc');
    }
    // 小镇嵌入局（runner）仍用完整的 privateView / publicView
    const runner = readFileSync(new URL('../../src/core/runner.ts', import.meta.url), 'utf8');
    expect(runner).toMatch(/\.privateView\(/);
    expect(runner).toMatch(/\.publicView\(/);
    expect(runner).not.toMatch(/agentView|agentPublicView/);
  });

  it('文案里出现的 section 名都是真有的名字或固定前缀', () => {
    const g = rig(synth({ ...X1, clues: 20 }), { options: { ask_limit: 20 } });
    stopAt(g, 'discuss#1', { search: true, askAll: 1 });
    const def = createRegistry({ scripts: memoryLibrary([synth(X1)]) }).get('jubensha')!;
    const texts: string[] = [def.rules, def.playerTips ?? '', JSON.stringify(g.rec.players.map((p: any) => g.view(p.seat))), g.rec.log.map((e: any) => e.text).join('\n')];
    for (const ev of ['script:0', 'act0:0', 'confession:0', 'clue_c1:0']) texts.push(pointerLine(parseEventKind(ev)!));
    const names = new Set<string>();
    for (const t of texts) for (const m of t.matchAll(/"section\\?":\\?"([^"\\]+)\\?"/g)) names.add(m[1]!);
    expect(names.size).toBeGreaterThan(8);
    for (const n of names) {
      const ok = n === 'find:关键词' || n === 'clue:线索id' || parseSection(n) !== null;
      expect(ok, n).toBe(true);
    }
    for (const n of ['role:3', 'act:1', 'host_notes', 'truth', 'faq', 'clues', 'clue:线索id', 'questionnaire', 'images', 'find:钥匙', 'script', 'confession', 'questions', 'places']) {
      expect(parseSection(n === 'clue:线索id' ? 'clue:c1' : n), n).not.toBeNull();
    }
  });
});

describe('段名解析', () => {
  it('大小写、全角、空白、号；纯数字序号；分号逗号一律失败；线索 id 区分大小写', () => {
    expect(parseSection('role:3')).toEqual({ kind: 'role', n: 3 });
    expect(parseSection('role:3号')).toEqual({ kind: 'role', n: 3 });
    expect(parseSection('ROLE:３')).toEqual({ kind: 'role', n: 3 });
    expect(parseSection('  role:3  ')).toEqual({ kind: 'role', n: 3 });
    expect(parseSection('act：2')).toEqual({ kind: 'act', n: 2 });
    for (const bad of ['act:1;role:3', 'role:3,4', 'role:03x', 'role:', 'role', 'act:-1', 'find:', 'find:   ', 'clue:', '', 'a'.repeat(81), 'nope']) expect(parseSection(bad), bad).toBeNull();
    expect(parseSection('clue:AbC')).toEqual({ kind: 'clue', id: 'AbC' });
    expect(parseSection('Clue：x_1')).toEqual({ kind: 'clue', id: 'x_1' });
    expect(parseSection('find：钥匙 水渍')).toEqual({ kind: 'find', q: '钥匙 水渍' });
    expect(parseSection('Truth')).toEqual({ kind: 'truth' });
    // act 事件的序号从 0 起，段名从 1 起
    expect(pointerLine(parseEventKind('act0:2')!)).toContain('第 1 幕');
    expect(pointerLine(parseEventKind('act0:2')!)).toContain('"section":"act:1"');
    // 图片事件不改写，即使线索 id 以 _img 结尾也不会把图片当文字
    expect(parseEventKind('clue_c1_img:0')).toBeNull();
    expect(parseEventKind('script_img:0')).toBeNull();
    expect(parseEventKind('act1_img:3')).toBeNull();
    expect(parseEventKind('clue_shared')).toBeNull();
    expect(parseEventKind('clue_c1:4')).toEqual({ type: 'clue', id: 'c1', i: 4 });
  });
});

describe('MCP：get_my_view 的 section / page', () => {
  async function connect() {
    const demo = exampleDemo('demo-rainy-bookshop');
    const manager = new GameManager({ registry: createRegistry({ scripts: memoryLibrary([demo]) }), rng: new SeededRng('mcp-g2') });
    const agents = [1, 2, 3, 4, 5].map((n) => ({ key: `k${n}`.padEnd(16, 'x'), id: `10${n}`, name: `Bot${n}` }));
    const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents }, manager);
    const clients = await Promise.all(
      agents.map(async (a) => {
        const server = createMcpServer({ manager, auth, version: 't' }, { identity: { id: a.id, name: a.name } as Identity, fixed: true, transport: 'memory' });
        const [x, y] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 't', version: '1' });
        await server.connect(y);
        await client.connect(x);
        return client;
      }),
    );
    const call = async (c: Client, name: string, args: Record<string, unknown>) => {
      const r: any = await c.callTool({ name, arguments: args });
      return { isError: Boolean(r.isError), body: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
    };
    return { manager, clients, call };
  }
  it('带 section 只返回那一段，立刻返回（忽略 wait_seconds），schema 拒绝坏参数', async () => {
    const { manager, clients, call } = await connect();
    const c = await call(clients[0]!, 'create_game', { game_type: 'jubensha', group_id: '1', auto_referee: true, options: { host: '105', random_seats: false, stage: 'group' } });
    const gameId = c.body.game_id ?? c.body.summary?.game_id;
    for (const [i, cl] of clients.entries()) if (i > 0) await call(cl, 'join_game', { game_id: gameId });
    await call(clients[0]!, 'start_game', { game_id: gameId });
    const t0 = Date.now();
    const r = await call(clients[4]!, 'get_my_view', { game_id: gameId, section: 'truth', wait_seconds: 30 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ ok: true, game_id: gameId, section: 'truth', page: 1, pages: 1 });
    expect(r.body).not.toHaveProperty('new_events');
    expect(r.body).not.toHaveProperty('todo');
    expect(r.body).not.toHaveProperty('public');
    const refused = await call(clients[0]!, 'get_my_view', { game_id: gameId, section: 'truth' });
    expect(refused.isError).toBe(true);
    expect(refused.body).toContain(REFUSAL);
    for (const bad of [{ section: 'x'.repeat(81) }, { section: 'truth', page: 0 }, { section: 'truth', page: -1 }, { section: 'truth', page: 1.5 }, { section: 'truth', page: 201 }]) {
      const e = await call(clients[4]!, 'get_my_view', { game_id: gameId, ...bad });
      expect(e.isError, JSON.stringify(bad)).toBe(true);
    }
    const tools = (await clients[0]!.listTools()).tools;
    expect(tools.find((t) => t.name === 'get_my_view')?.annotations?.readOnlyHint).toBe(true);
    expect(manager.getRecord(gameId).status).toBe('running');
  });
});

// ───────────────────────── 评审修复（第二轮）：没有上限的字段、事件的图片标记、测试缺口 ─────────────────────────

describe('预算：地点数、持有的卡、公开线索、问卷', () => {
  const searchOpts = (extra: Partial<SynthOpts> = {}): SynthOpts => ({ ...NEAR_MAX, clues: 500, clueText: 100, clueTitle: 40, locations: 50, roleClues: true, ...extra });
  const maxStatic = (samples: Sample[], players: number, acts: number) => {
    let dm = 0;
    let pl = 0;
    for (const s of samples) {
      const n = staticLen(s.view);
      if (s.dm) dm = Math.max(dm, n);
      else pl = Math.max(pl, n);
      expect(n, `${s.dm ? 'DM' : '玩家'} @${s.tag}`).toBeLessThanOrEqual(viewBudget(s.dm ? 'dm' : 'player', players, acts));
    }
    return { dm, pl };
  };

  it('50 个地点 + 身上有线索的角色：you.search.places 只列前几个，其余记 places_more，section:places 列全；静态部分在预算内', () => {
    const g = rig(synth(searchOpts()));
    const samples = driveSamples(g, { search: true });
    const m = maxStatic(samples, 6, 4);
    console.info(`[预算实测] 50 地点 500 线索：DM 最大 ${m.dm}，玩家最大 ${m.pl}`);
    const s = playerSeats(g)[0] as number;
    const total = inst(g).places(s).length;
    expect(total).toBeGreaterThan(PLACES_LISTED);
    // 搜证中间的视图（还有卡可搜）
    const g2 = rig(synth(searchOpts()));
    stopAt(g2, 'discuss#2', { search: true });
    const you = g2.view(s).you;
    expect(you.search.places.length).toBe(PLACES_LISTED);
    expect(you.search.places_more).toBe(total - PLACES_LISTED);
    for (const p of you.search.places) expect(p.cards.length).toBeLessThanOrEqual(PLACE_TITLES_LISTED);
    expect(joinSection(g2, s, 'places').split('\n').length).toBe(total);
    expect(you.sections.find((x: any) => x.section === 'places').use).toContain('places_more');
    // 公开视图里的地点也只列前几个
    const pub = g2.view(s).public.search;
    expect(pub.places.length).toBe(PUBLIC_PLACES_LISTED);
    expect(pub.places_more).toBe(inst(g2).places(null).length - PUBLIC_PLACES_LISTED);
    expect(inst(g2).publicView().search.places.length).toBe(inst(g2).places(null).length);
  });

  it('盲搜：没有 places 段，地点只有 key 和名字，列全，仍在预算内', () => {
    const g = rig(synth(searchOpts({ blind: true })));
    const m = maxStatic(driveSamples(g, { search: true }), 6, 4);
    console.info(`[预算实测] 50 地点盲搜：DM 最大 ${m.dm}，玩家最大 ${m.pl}`);
    const g2 = rig(synth(searchOpts({ blind: true })));
    stopAt(g2, 'discuss#2', { search: true });
    const s = playerSeats(g2)[0] as number;
    expect(g2.view(s).you.search.places.length).toBe(inst(g2).places(s).length);
    expect(g2.view(s).you.search).not.toHaveProperty('places_more');
  });

  it('12 个座位 + 50 个地点：也在 viewBudget 内', () => {
    const g = rig(synth(searchOpts({ players: 12, clues: 300 })));
    maxStatic(driveSamples(g, { search: true }), 12, 4);
  });

  it('持有的卡太多（cost=0 的卡可以无限搜）：my_cards 只列最新的几张，my_cards_more 记其余，my_clues 列全；目录不随卡数增长', () => {
    const g = rig(synth({ ...X1, clues: 100, clueText: 300 }));
    stopAt(g, 'discuss#2', { search: true });
    const [a, b] = playerSeats(g) as number[];
    const holders = g.rec.state.search.holders as Record<string, number[]>;
    for (const c of g.rec.state.pack.clues) holders[c.id] = [a!];
    const you = g.view(a!).you;
    expect(you.search.my_cards.length).toBe(MY_CARDS_LISTED);
    expect(you.search.my_cards_more).toBe(100 - MY_CARDS_LISTED);
    expect(you.search.my_cards.map((c: any) => c.id)).toEqual(Array.from({ length: MY_CARDS_LISTED }, (_, i) => `c${100 - MY_CARDS_LISTED + i}`));
    const names = you.sections.map((x: any) => x.section);
    expect(names.filter((n: string) => n.startsWith('clue:')).length).toBe(MY_CARDS_LISTED);
    expect(names).toContain('my_clues');
    expect(joinSection(g, a!, 'my_clues').split('\n').length).toBe(100);
    for (const c of g.rec.state.pack.clues) expect(err(() => section(g, a!, `clue:${c.id}`))).toBeNull();
    expect(staticLen(g.view(a!))).toBeLessThanOrEqual(PLAYER_VIEW_BUDGET);
    // 没有卡的人、DM 取 my_clues 都是统一拒绝
    expect(err(() => section(g, b!, 'my_clues'))).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
    expect(err(() => section(g, hostSeat(g), 'my_clues'))).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
    // 卡不多时没有 my_cards_more，也没有 my_clues
    const small = rig(synth({ ...X1, clues: 10, clueText: 100 }));
    stopAt(small, 'discuss#2', { search: true });
    const sv = small.view(playerSeats(small)[0]).you;
    expect(sv.search).not.toHaveProperty('my_cards_more');
    expect(sv.sections.map((x: any) => x.section)).not.toContain('my_clues');
  });

  it('公开线索太多：public.search.shared 只列最新的几条，shared_more 记其余，累计字数有上限', () => {
    const g = rig(synth({ ...X1, clues: 100, clueText: 1000 }));
    stopAt(g, 'discuss#2', { search: true });
    const sx = g.rec.state.search;
    for (const c of g.rec.state.pack.clues) sx.shared.push({ id: c.id, by: playerSeats(g)[0] });
    const total = sx.shared.length;
    expect(total).toBeGreaterThan(SHARED_LISTED);
    for (const seat of [hostSeat(g), ...(playerSeats(g) as number[])]) {
      const v = g.view(seat);
      const sh = v.public.search.shared as { id: string; text: string }[];
      expect(sh.length).toBe(SHARED_LISTED);
      expect(v.public.search.shared_more).toBe(total - SHARED_LISTED);
      expect(sh.map((x) => x.id)).toEqual(sx.shared.slice(-SHARED_LISTED).map((x: any) => x.id));
      expect(sh.reduce((n, x) => n + x.text.length, 0)).toBeLessThan(SHARED_TOTAL_INLINE + SHARED_LISTED * 200);
      expect(staticLen(v)).toBeLessThanOrEqual(viewBudget(seat === hostSeat(g) ? 'dm' : 'player', 6, 4));
    }
    expect(inst(g).publicView().search.shared.length).toBe(total);
  });

  it('问卷格式上限（30 题 × 300 字题干 × 20 个 200 字选项）：public 和 you 都缩短，全文用 section:questionnaire 取，答案不丢', () => {
    const opts: SynthOpts = { ...X1, q: 30, qStem: 300, qOptions: 20, qOptText: 200 };
    const g = rig(synth(opts));
    stopAt(g, 'quiz#4', { search: true });
    const s = playerSeats(g)[0] as number;
    const v = g.view(s);
    expect(JSON.stringify(inst(g).privateView(s).questionnaire).length).toBeGreaterThan(QUIZ_YOU_INLINE);
    expect(JSON.stringify(v.you.questionnaire).length).toBeLessThanOrEqual(QUIZ_YOU_INLINE);
    for (const q of v.you.questionnaire) {
      expect(q).not.toHaveProperty('options');
      expect(q.question.length).toBeLessThanOrEqual(QUIZ_STEM_INLINE + 1);
      expect(q).toHaveProperty('my_answer');
    }
    expect(v.you.questionnaire_note).toContain('"section":"questionnaire"');
    expect(v.public.questionnaire.length).toBe(30);
    for (const q of v.public.questionnaire) {
      // 去掉选项后仍超过 QUIZ_PUBLIC_INLINE：只留题号和分值（题干全文在 todo.prompt / you.questionnaire / section）
      expect(Object.keys(q).sort()).toEqual(['no', 'points']);
    }
    expect(JSON.stringify(v.public.questionnaire).length).toBeLessThan(4000);
    expect(v.public.questionnaire_note).toContain('"section":"questionnaire"');
    // 全文用段取回：题干、选项、我的答案都在，目录的字数对得上
    const full = joinSection(g, s, 'questionnaire');
    expect(full).toContain(fill(300, 'Q'));
    expect(full).toContain(fill(200, 'O'));
    expect(full.match(/我的答案：/g)!.length).toBe(30);
    expect(v.you.sections.find((x: any) => x.section === 'questionnaire').chars).toBe(full.length);
    // 静态部分去掉 quiz 阶段通用层的 todo / hint 后在预算内
    const stat = { ...v, new_events: [], todo: undefined, hint: undefined };
    expect(JSON.stringify(stat).length).toBeLessThanOrEqual(PLAYER_VIEW_BUDGET);
    // 问卷不长（示例包）时原样：you.questionnaire 带选项，没有 note
    const small = rig(synth({ ...X1, q: 4 }));
    stopAt(small, 'quiz#4', { search: true });
    const sv = small.view(playerSeats(small)[0]);
    expect(sv.you.questionnaire[0]).toHaveProperty('options');
    expect(sv.you).not.toHaveProperty('questionnaire_note');
    // 问卷段：不在答题阶段、DM 都是统一拒绝
    expect(err(() => section(g, hostSeat(g), 'questionnaire'))).toBeNull();
    const early = rig(synth(opts));
    stopAt(early, 'discuss#1');
    expect(err(() => section(early, playerSeats(early)[0], 'questionnaire'))).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
  });
});

describe('事件的图片标记', () => {
  it('带图的公告 / 私发在日志里记 data.image，钩子收到的 ev.image 对得上；文字事件没有', () => {
    const g = rig(synth({ ...X1, floodImages: 2, images: 0 }));
    const i = inst(g);
    const seen: { kind: string; image: boolean; own: boolean }[] = [];
    const orig = i.agentEventText.bind(i);
    i.agentEventText = (seat: number, ev: any) => {
      seen.push({ kind: ev.kind, image: ev.image, own: ev.own });
      return orig(seat, ev);
    };
    driveSamples(g, { search: true });
    const imageKinds = (k: string) => /_img:\d+$/.test(k);
    const logs = g.rec.log as { kind: string; data?: Record<string, unknown> }[];
    expect(logs.filter((e) => imageKinds(e.kind)).length).toBeGreaterThan(0);
    for (const e of logs) expect(Boolean(e.data?.image), e.kind).toBe(imageKinds(e.kind));
    expect(seen.filter((x) => imageKinds(x.kind)).length).toBeGreaterThan(0);
    for (const x of seen) expect(x.image, x.kind).toBe(imageKinds(x.kind));
    // 图片事件的文字原样（含自己的，kind 形如 clue_c1_img:0 不会被当成线索文字改写）
    expect(seen.some((x) => imageKinds(x.kind) && x.own)).toBe(true);
  });
});

describe('测试缺口：纯读的副作用、结束后不放宽、小镇会话、事件大小、dm_actions 里的段名', () => {
  it('取段不触发 touch：不通知订阅者（存档和长轮询都靠它）、不动 updatedAt；对照：真的行动会触发', () => {
    const g = rig(synth(X1));
    stopAt(g, 'discuss#0');
    const [a, b] = playerSeats(g) as number[];
    let changes = 0;
    const off = g.manager.onChange(() => changes++);
    g.act(b!, { action: 'speech', text: '对照：这一句会触发。' });
    expect(changes).toBeGreaterThan(0);
    const updated = g.rec.updatedAt;
    g.clock.advance(1000);
    changes = 0;
    section(g, a!, 'script');
    section(g, a!, 'find:剧本');
    section(g, hostSeat(g), 'truth');
    section(g, hostSeat(g), 'role:1', 2);
    expect(err(() => section(g, a!, 'truth'))).not.toBeNull();
    expect(changes).toBe(0);
    expect(g.rec.updatedAt).toBe(updated);
    off();
  });

  it('对局结束 / 中止之后规则不变：玩家仍取不到别人的 role / act，DM 仍取不到 script；get_game_log 的复盘是公开的（对照）', () => {
    for (const how of ['ended', 'aborted'] as const) {
      const g = rig(synth({ ...X1, clues: 20, clueText: 200 }));
      if (how === 'ended') driveSamples(g, { search: true });
      else {
        stopAt(g, 'discuss#2', { search: true });
        g.manager.abortGame({ id: g.rec.hostId, name: 'x' }, g.gameId, '测试中止');
      }
      expect(g.rec.status).toBe(how);
      const dm = hostSeat(g);
      const seats = playerSeats(g) as number[];
      const s = seats[0]!;
      const other = seats[1]!;
      // 对照：结束后的 get_game_log 把别人的私密事件也公开了（中止后不公开），所以「结束后放宽」是有诱惑的
      const kinds = (g.manager.getLog(identityOf(g.rec, s), g.gameId, { limit: 1000 }).events as any[]).filter((e) => /^script:\d+$/.test(e.kind));
      const mine = (g.rec.log as any[]).filter((e) => /^script:\d+$/.test(e.kind) && e.audience.type === 'seats' && e.audience.seats.includes(s)).length;
      expect(mine).toBeGreaterThan(0);
      if (how === 'ended') expect(kinds.length).toBeGreaterThan(mine);
      else expect(kinds.length).toBe(mine);
      for (const b of [`role:${other}`, `role:${s}`, 'act:1;role:2', 'truth', 'host_notes', 'faq', 'clues', 'questionnaire', 'images', `clue:c0`]) {
        // 自己持有的卡可以取；自己的问卷在答问卷阶段起可以取（结束后仍是自己的）；其余统一拒绝
        const hasIt = (b === 'clue:c0' && (g.rec.state.search.holders.c0 ?? []).includes(s)) || (b === 'questionnaire' && how === 'ended');
        const e = err(() => section(g, s, b));
        if (hasIt) expect(e, `${how} ${b}`).toBeNull();
        else expect(e, `${how} 玩家取 ${b}`).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
      }
      for (const b of ['script', 'confession', 'places', 'my_clues']) expect(err(() => section(g, dm, b)), `${how} DM 取 ${b}`).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
      // 自己的、DM 的段照常
      expect(err(() => section(g, s, 'script'))).toBeNull();
      expect(err(() => section(g, dm, 'truth'))).toBeNull();
      expect(err(() => section(g, dm, `role:${other}`))).toBeNull();
    }
  });

  it('MCP：会话在城市里、没带 game_id 带剧本 section → 拒绝，不返回城市视图；带真实的 game_id 照常取', async () => {
    const demo = exampleDemo('demo-rainy-bookshop');
    const t = makeCity();
    const manager = new GameManager({ registry: createRegistry({ scripts: memoryLibrary([demo]) }), rng: new SeededRng('mcp-city-g2') });
    const agents = [1, 2, 3, 4, 5].map((n) => ({ key: `city-k${n}`.padEnd(16, 'x'), id: `600${n}`, name: `Bot${n}` }));
    const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents }, manager);
    const deps = { manager, auth, version: 't', city: { city: t.c, auth, trustedIds: [] as string[] } };
    const clients: Client[] = [];
    for (const a of agents) {
      const server = createMcpServer(deps, { identity: { id: a.id, name: a.name } as Identity, fixed: true, transport: 'memory' });
      const [x, y] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '1' });
      await server.connect(y);
      await client.connect(x);
      clients.push(client);
    }
    const call = async (c: Client, name: string, args: Record<string, unknown>) => {
      const r: any = await c.callTool({ name, arguments: args });
      return { isError: Boolean(r.isError), text: r.content[0].text as string };
    };
    const made = await call(clients[0]!, 'create_game', { game_type: 'jubensha', group_id: '1', auto_referee: true, options: { host: '6005', random_seats: false, stage: 'group' } });
    const gameId = JSON.parse(made.text).game_id ?? JSON.parse(made.text).summary?.game_id;
    for (const [i, c] of clients.entries()) if (i > 0) await call(c, 'join_game', { game_id: gameId });
    await call(clients[0]!, 'start_game', { game_id: gameId });
    const entered = await call(clients[4]!, 'enter_world', { world_id: 'city', name: 'Bot5', client_id: 'run-6005-aaaa' });
    expect(entered.isError, entered.text).toBe(false);
    const inCity = await call(clients[4]!, 'get_my_view', { section: 'truth' });
    expect(inCity.isError).toBe(true);
    expect(inCity.text).toContain('BAD_REQUEST');
    expect(inCity.text).not.toContain('"context"');
    // 带上对局编号：照常取到（DM = 5 号机器人）
    const ok = await call(clients[4]!, 'get_my_view', { game_id: gameId, section: 'truth' });
    expect(ok.isError, ok.text).toBe(false);
    expect(JSON.parse(ok.text)).toMatchObject({ ok: true, section: 'truth', game_id: gameId });
  });

  it('事件单次大小：近上限包里每个阶段变化后各座位取一次，重复类每条 ≤ POINTER_MAX，其余事件的字数不超过该阶段新增的公开文字和发言之和加 2000', () => {
    const g = rig(synth(NEAR_MAX), { options: { ask_limit: 3 } });
    const samples = driveSamples(g, { search: true, withLog: true, askAll: 1 });
    let maxDm = 0;
    let maxPl = 0;
    for (const s of samples) {
      const events = s.view.new_events as { seq: number; kind: string; text: string }[];
      let other = 0;
      let allowed = 2000;
      for (const e of events) {
        if (REWRITABLE.test(e.kind) && e.text.startsWith('〔')) {
          expect(e.text.length, `${s.seat} ${e.kind}`).toBeLessThanOrEqual(POINTER_MAX);
          continue;
        }
        other += e.text.length;
        const orig = s.log!.find((x) => x.seq === e.seq)!;
        expect(e.text, `${s.seat} ${e.kind} 没被改写的事件要和 get_game_log 逐字相同`).toBe(orig.text);
        // 被允许的字数：公开文字、发言、提问、回答、图片说明（都是本来就不改写的）
        allowed += e.text.length;
      }
      expect(other).toBeLessThanOrEqual(allowed);
      const n = JSON.stringify(events).length;
      if (s.dm) maxDm = Math.max(maxDm, n);
      else maxPl = Math.max(maxPl, n);
    }
    console.info(`[事件实测] 近上限 6 座位 4 幕：单次 new_events 最大 DM ${maxDm} 字、玩家 ${maxPl} 字（JSON 长度）`);
    expect(maxDm).toBeGreaterThan(0);
  });

  it('dm_actions 最后一项里裸写的段名（"act:1"、"host_notes"、"clue:线索id"……）都是目录里真有的或可解析的', () => {
    const g = rig(synth({ ...X1, clues: 20, clueText: 200 }));
    stopAt(g, 'discuss#1', { search: true });
    const dm = hostSeat(g);
    const you = g.view(dm).you;
    const last = you.dm_actions.at(-1) as string;
    const names = new Set((you.sections as { section: string }[]).map((x) => x.section));
    const list = last.match(/section 也可以是([^；]*)；/)?.[1];
    expect(list, last).toBeTruthy();
    const bare = [...list!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(bare.length).toBeGreaterThanOrEqual(7);
    for (const n of bare) {
      if (n.startsWith('clue:')) {
        expect(parseSection('clue:c1'), n).not.toBeNull();
        expect(err(() => section(g, dm, 'clue:c1'))).toBeNull();
        expect(names.has('clues')).toBe(true);
      } else {
        expect(parseSection(n), n).not.toBeNull();
        expect(names.has(n), `${n} 不在 DM 目录里`).toBe(true);
        expect(err(() => section(g, dm, n)), n).toBeNull();
      }
    }
    // "find:钥匙" 这一条
    const find = last.match(/"(find:[^"]+)"/)?.[1];
    expect(find).toBeTruthy();
    expect(err(() => section(g, dm, find!))).toBeNull();
  });
});

// ───────────────────────── 与改前（68d1b58）逐条对照 ─────────────────────────

type LogHash = { seq: number; kind: string; sha: string };
type OutHash = { seq: number; sha: string };
interface Base2Case {
  lookups: Record<string, string>;
  stateKeys: string[];
  logs: LogHash[] | Record<string, LogHash[]>;
  outbox: OutHash[];
}
interface Base2Web {
  web: { tag: string; hSeat: number; len: number; sha: string }[];
  status: string;
  outbox: OutHash[];
}
/** 改前（68d1b58）的 get_game_log 每条事件的 sha、出箱每条的 sha、DM lookup 的返回、rec.state 的键、真人座位网页的 private（fixtures/jubensha-views-baseline2.json，由改前的代码生成） */
const base2 = JSON.parse(readFileSync(new URL('./fixtures/jubensha-views-baseline2.json', import.meta.url), 'utf8')) as Record<string, any>;
const sha256 = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

describe('与改前逐条相同：get_game_log、出箱、DM 的 lookup 与取段、rec.state 的键、真人座位网页', () => {
  /** 只允许这些事件的文字变化（本段改的开局私信文案） */
  const CHANGED_KINDS = new Set(['dm_brief']);
  const cases = [
    ['rainy-host', 'demo-rainy-bookshop', true],
    ['rainy-nohost', 'demo-rainy-bookshop', false],
    ['lighthouse-host', 'demo-search-lighthouse', true],
  ] as const;
  for (const [key, name, host] of cases) {
    it(`${key}：get_game_log 每条事件、出箱每条、rec.state 的键与改前相同；lookup 的返回与改前逐字相同，取段的正文与它一致`, () => {
      const b = base2[key] as Base2Case;
      const g = rig(exampleDemo(name), { host });
      const lookups: Record<string, string> = {};
      const secs: Record<string, string> = {};
      driveSamples(g, {
        onTag: (tag) => {
          if (tag !== 'discuss#0' || !host) return;
          const dm = g.rec.state.host as number;
          const texts = [...g.rec.players.filter((p: any) => p.seat !== dm).map((p: any) => String(p.seat)), 'act:1', 'act:2', 'questionnaire', 'images', ...g.rec.state.pack.clues.map((c: any) => `clue:${c.id}`)];
          for (const t of texts) {
            try {
              lookups[t] = g.act(dm, { action: 'lookup', text: t }).message as string;
            } catch (e: any) {
              lookups[t] = `ERR:${e.message}`;
            }
            const sec = /^\d+$/.test(t) ? `role:${t}` : t;
            secs[t] = err(() => section(g, dm, sec)) ? 'ERR' : (section(g, dm, sec).text as string);
          }
        },
      });
      if (host) {
        expect(Object.keys(lookups).length).toBeGreaterThan(4);
        expect(lookups).toEqual(b.lookups);
        for (const [t, msg] of Object.entries(lookups)) {
          if (msg.startsWith('ERR:')) expect(secs[t]).toBe('ERR');
          else if (msg.slice(msg.indexOf('\n') + 1).startsWith('（这个剧本没有')) expect(secs[t], `取段 ${t}：没有这一段`).toBe('ERR'); // lookup 保留旧提示，取段是统一拒绝
          else expect(secs[t], `取段 ${t} 与旧 lookup 的正文`).toBe(msg.slice(msg.indexOf('\n') + 1));
        }
      }
      expect(Object.keys(g.rec.state).sort()).toEqual(b.stateKeys);
      // get_game_log：每个座位看到的每条事件（编号、kind 相同；文字相同，开局私信除外）
      for (const p of g.rec.players) {
        const want = Array.isArray(b.logs) ? b.logs : (b.logs as Record<string, LogHash[]>)[String(p.seat)]!;
        const got = (g.manager.getLog(identityOf(g.rec, p.seat), g.gameId, { limit: 1000 }).events as any[]).map((e) => ({ seq: e.seq, kind: e.kind, sha: sha256(e) }));
        expect(got.map((x) => [x.seq, x.kind]), `座位 ${p.seat} 的事件编号和 kind`).toEqual(want.map((x) => [x.seq, x.kind]));
        const diff = got.filter((x, i) => x.sha !== want[i]!.sha).map((x) => x.kind);
        for (const k of diff) expect(CHANGED_KINDS.has(k), `座位 ${p.seat} 的 ${k} 事件文字变了`).toBe(true);
      }
      // 出箱：条数、编号、每条都相同
      expect(g.rec.outbox.map((d: any) => d.seq)).toEqual(b.outbox.map((d) => d.seq));
      g.rec.outbox.forEach((d: any, i: number) => expect(sha256(d), `出箱第 ${i} 条`).toBe(b.outbox[i]!.sha));
    });
  }

  it('真人玩家的座位网页 private 每个阶段都与改前逐字相同，也等于 fullView；发给真人的出箱每条相同', async () => {
    const b = base2['web-human-player'] as Base2Web;
    const { web, outbox, game } = await driveWithHuman(false);
    expect(web.map((x) => x.tag)).toEqual(b.web.map((x) => x.tag));
    expect(web.length).toBeGreaterThan(3);
    expect(game.rec.status).toBe('ended');
    web.forEach((x, i) => expect(x.sha, `阶段 ${x.tag}`).toBe(b.web[i]!.sha));
    for (const x of web) expect(x.private).toEqual(x.full);
    expect(outbox.map((d) => d.seq)).toEqual(b.outbox.map((d) => d.seq));
    outbox.forEach((d, i) => expect(sha256(d), `出箱第 ${i} 条`).toBe(b.outbox[i]!.sha));
    expect(game.rec.status).toBe(b.status);
  });

  it('真人 DM 的出箱除了开局私信（本段改的文案）外与改前逐条相同', async () => {
    const b = base2['web-human-dm'] as Base2Web;
    const { outbox } = await driveWithHuman(true);
    expect(outbox.map((d) => d.seq)).toEqual(b.outbox.map((d) => d.seq));
    const diff = outbox.map((d, i) => (sha256(d) === b.outbox[i]!.sha ? null : d)).filter((d) => d !== null) as any[];
    expect(diff.length).toBeLessThanOrEqual(1);
    for (const d of diff) expect(d.text).toContain('你是本局 DM');
  });

  /** 与生成基线时相同的推进：1 个真人（玩家或 DM），其余是机器人，裁判代行 */
  async function driveWithHuman(hostHuman: boolean) {
    const demo = exampleDemo('demo-search-lighthouse');
    const { manager, clock } = setup(1, undefined, { scripts: memoryLibrary([demo]) });
    const n = demo.players;
    const bots = Array.from({ length: hostHuman ? n : n - 1 }, (_, i) => bot(i + 1));
    const humans = [human(1)];
    const { gameId, rec } = startGame(manager, 'jubensha', { players: bots, humans, referee: REF, options: { random_seats: false, stage: 'group', ...(hostHuman ? { host: humans[0]!.userId } : {}) } });
    const r: any = rec;
    const hSeat = r.players.find((p: any) => p.kind === 'human').seat;
    const web: { tag: string; hSeat: number; len: number; sha: string; private: any; full: any }[] = [];
    let last = '';
    for (let i = 0; i < 400 && r.status === 'running'; i++) {
      await manager.refereeStep(REF, gameId);
      if (r.status !== 'running') break;
      const k = r.phase?.key ?? '-';
      const tag = `${k}#${r.state.act}`;
      if (r.phase?.openedAt !== null && tag !== last) {
        last = tag;
        const priv = (manager.webSeatView(rec, hSeat) as any).me.private;
        web.push({ tag, hSeat, len: JSON.stringify(priv).length, sha: sha256(JSON.stringify(priv)), private: priv, full: (manager as any).inst(r).fullView(hSeat) });
      }
      for (const seat of pendingSeats(r)) {
        const p = r.players.find((x: any) => x.seat === seat);
        const req = r.phase.pending[String(seat)];
        if (!req || req.done) continue;
        if (p.kind === 'human') {
          try {
            manager.relayHumanMessage(REF, gameId, { userId: p.id, text: '过', channel: req.channel });
          } catch {
            /* ignore */
          }
          continue;
        }
        const input = k === 'read' ? { action: 'ready' } : k === 'vote' || k === 'search' || k === 'quiz' ? { action: 'skip' } : k === 'discuss' ? { action: 'end_speech' } : { action: 'speech', text: '我是我。' };
        try {
          manager.act({ id: p.id, name: p.name }, gameId, input as any);
        } catch {
          /* ignore */
        }
      }
      clock.advance(30_000);
    }
    return { web, outbox: r.outbox as any[], game: { rec: r } };
  }
});

describe('公开段 cast：公开介绍合计不超过总量时原样，超过才每人截断并指向 cast 段', () => {
  const castText = (g: Rig) => (inst(g).publicView().cast as { seat: number; name: string; role: string; public: string }[]).map((c) => `${c.seat}号 ${c.name}【${c.role}】\n${c.public}`).join('\n\n');

  it('合计在总量以内（6 人 × 300 字）：public.cast 与改前的公开视图逐字相同，you.role.public 也是原文；目录里仍列出 cast', () => {
    const opts: SynthOpts = { ...X1, rolePublic: 300 };
    expect(opts.players * 300).toBeLessThanOrEqual(CAST_PUBLIC_TOTAL_INLINE);
    const g = rig(synth(opts));
    stopAt(g, 'discuss#1', { search: true });
    const pv = inst(g).publicView();
    for (const seat of g.rec.players.map((p: any) => p.seat) as number[]) {
      const v = g.view(seat);
      expect(v.public.cast, `${seat}`).toEqual(pv.cast);
      expect(JSON.stringify(v.public.cast)).not.toContain('…（共');
      if (seat !== hostSeat(g)) expect(v.you.role.public).toBe(inst(g).roleOf(seat).public);
      expect(v.you.sections.map((x: any) => x.section)).toContain('cast');
    }
  });

  it('合计超过总量（6 人 × 500 字）：每人截到 CAST_PUBLIC_INLINE 并指向 cast 段；you.role.public 跟同一个判断走', () => {
    const opts: SynthOpts = { ...X1, rolePublic: 500 };
    expect(opts.players * 500).toBeGreaterThan(CAST_PUBLIC_TOTAL_INLINE);
    const g = rig(synth(opts));
    stopAt(g, 'discuss#1', { search: true });
    for (const seat of g.rec.players.map((p: any) => p.seat) as number[]) {
      const v = g.view(seat);
      for (const c of v.public.cast) {
        expect(c.public.startsWith(fill(CAST_PUBLIC_INLINE, 'P')), `${seat}`).toBe(true);
        expect(c.public).toContain('get_my_view({"section":"cast"})');
        expect(c.public.length).toBeLessThan(500);
      }
      if (seat !== hostSeat(g)) {
        expect(v.you.role.public).toContain('get_my_view({"section":"cast"})');
        expect(v.you.role.public.length).toBeLessThan(500);
      }
    }
  });

  it('DM 和每个玩家都取得到 cast 段：全文与公开视图的介绍一致，只含 publicView().cast 里有的字段；段名大小写不敏感；目录的 chars 对得上', () => {
    const g = rig(synth({ ...X1, rolePublic: 500 }));
    stopAt(g, 'discuss#1', { search: true });
    const want = castText(g);
    const pub = inst(g).publicView().cast as { public: string }[];
    for (const c of pub) expect(want).toContain(c.public);
    for (const seat of g.rec.players.map((p: any) => p.seat) as number[]) {
      expect(joinSection(g, seat, 'cast'), `${seat}`).toBe(want);
      for (const name of ['CAST', ' Cast ', 'ＣＡＳＴ']) expect(section(g, seat, name).section).toBe('cast');
      expect(g.view(seat).you.sections.find((x: any) => x.section === 'cast').chars).toBe(want.length);
    }
    // 里面没有任何别的东西：没有剧本、认罪书、真相
    expect(want).not.toContain(fill(40, 'r1'));
    expect(want).not.toContain(fill(40, 'T'));
    expect(want).not.toContain(fill(40, 'X'));
  });

  it('没开局的局取 cast 被拒（INVALID_STATE）；非参赛者 FORBIDDEN', () => {
    const { manager } = setup(1, undefined, { scripts: memoryLibrary([exampleDemo('demo-rainy-bookshop')]) });
    const lobby = manager.createGame(bot(1), { type: 'jubensha', groupId: '9100', options: { stage: 'group', script: 'demo-rainy-bookshop' }, joinAs: 'player', autoReferee: true, selfPost: false });
    expect(err(() => manager.getSection(bot(1), lobby.summary.game_id, 'cast', 1))).toMatchObject({ code: 'INVALID_STATE' });
    const g = rig(synth({ ...X1, rolePublic: 500 }));
    expect(err(() => g.manager.getSection(bot(99), g.gameId, 'cast', 1))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('公开段 shared：已公开的线索全文按需取（public.search.shared 只列最新几条时，较早的在这里）', () => {
  type Shared = { by: number; id: string; title: string; text: string; images?: string[] };
  const sharedText = (g: Rig) =>
    (inst(g).publicView().search.shared as Shared[])
      .map((x, i) => `${i + 1}. 【${x.title}】（${x.id}，${x.by}号公开）\n${x.text}${x.images?.length ? `\n图：${x.images.join('；')}` : ''}`)
      .join('\n\n');
  /** 走到第二轮讨论，把合成包里每张线索的正文改成各不相同的（合成包里原本全是同一串字），清空已公开的 */
  const ready = () => {
    const g = rig(synth({ ...X1, clues: 100, clueText: 1000 }));
    stopAt(g, 'discuss#2', { search: true });
    const clues = g.rec.state.pack.clues as { id: string; title: string; text: string }[];
    clues.forEach((c, i) => (c.text = `〈第${i}张的正文〉${c.text}`));
    g.rec.state.search.shared.splice(0);
    return { g, clues };
  };
  const everyone = (g: Rig) => [hostSeat(g), ...(playerSeats(g) as number[])];

  it('还没有人公开线索：取 shared 和取乱写的段是同一个拒绝，目录里没有它；公开一张之后所有座位都有', () => {
    const { g, clues } = ready();
    for (const seat of everyone(g)) {
      expect(err(() => section(g, seat, 'shared')), `${seat}`).toEqual({ code: 'INVALID_ACTION', message: REFUSAL });
      expect(err(() => section(g, seat, 'shared')), `${seat}`).toEqual(err(() => section(g, seat, 'nope')));
      expect(g.view(seat).you.sections.map((x: any) => x.section)).not.toContain('shared');
    }
    g.rec.state.search.shared.push({ id: clues[0]!.id, by: playerSeats(g)[0] });
    for (const seat of everyone(g)) {
      expect(section(g, seat, 'shared').text, `${seat}`).toContain(clues[0]!.text);
      expect(g.view(seat).you.sections.map((x: any) => x.section)).toContain('shared');
    }
  });

  it('DM 和每个玩家拿到同一份：全部已公开线索的全文，与公开视图逐条一致；没公开的线索（包括别人手里的）一个字都不在里面', () => {
    const { g, clues } = ready();
    const pub = clues.slice(0, SHARED_LISTED + 4);
    const hidden = clues.slice(SHARED_LISTED + 4);
    for (const c of pub) g.rec.state.search.shared.push({ id: c.id, by: playerSeats(g)[0] });
    const want = sharedText(g);
    for (const c of pub) expect(want).toContain(c.text);
    for (const c of hidden) {
      expect(want).not.toContain(`〈第${clues.indexOf(c)}张的正文〉`);
      expect(want).not.toContain(`（${c.id}，`);
    }
    // 对照：没公开的线索里确实有人手里拿着的（否则上面的否定断言没有意义）
    const holders = g.rec.state.search.holders as Record<string, number[]>;
    expect(hidden.some((c) => (holders[c.id] ?? []).length > 0)).toBe(true);
    for (const seat of everyone(g)) {
      expect(joinSection(g, seat, 'shared'), `${seat}`).toBe(want);
      for (const name of ['SHARED', ' Shared ', 'ＳＨＡＲＥＤ']) expect(section(g, seat, name).section).toBe('shared');
    }
    expect(section(g, hostSeat(g), 'shared').pages).toBe(Math.ceil(want.length / SECTION_PAGE));
    expect(section(g, hostSeat(g), 'shared').pages).toBeGreaterThan(1);
  });

  it('默认视图：只列最新的几条并记 shared_more，被截短的正文指向 shared 段；目录的 chars 等于段的全文长度；静态部分仍在预算内', () => {
    const { g, clues } = ready();
    for (const c of clues.slice(0, SHARED_LISTED + 4)) g.rec.state.search.shared.push({ id: c.id, by: playerSeats(g)[0] });
    const want = sharedText(g);
    for (const seat of everyone(g)) {
      const v = g.view(seat);
      const sh = v.public.search.shared as Shared[];
      expect(sh.map((x) => x.id)).toEqual(clues.slice(4, SHARED_LISTED + 4).map((c) => c.id));
      expect(v.public.search.shared_more).toBe(4);
      for (const x of sh) {
        expect(x.text.length, x.id).toBeLessThan(1000);
        expect(x.text, x.id).toContain('get_my_view({"section":"shared"})');
        expect(x.text, x.id).not.toContain('get_game_log');
      }
      expect(v.you.sections.find((x: any) => x.section === 'shared').chars).toBe(want.length);
      expect(staticLen(v)).toBeLessThanOrEqual(viewBudget(seat === hostSeat(g) ? 'dm' : 'player', 6, 4));
    }
    // 网页和观战用的公开视图不变：全部线索、全文
    expect((inst(g).publicView().search.shared as Shared[]).map((x) => x.text)).toEqual(clues.slice(0, SHARED_LISTED + 4).map((c) => c.text));
  });
});
