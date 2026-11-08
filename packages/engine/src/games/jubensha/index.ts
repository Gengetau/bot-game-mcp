/**
 * 剧本杀（通用引擎 + 私有数据包）。
 *
 * 程序管骨架：选角、按幕私发剧本、自由讨论计时、投票指认、凶手坦白、公布真相。
 * 可选的 DM 席位（一位玩家担任，不扮演角色）管血肉：念白之外的串场、回答玩家提问、
 * 申请提前进入下一环节或延长讨论。DM 不能改变任何结果：发什么、谁是凶手、怎么计票都由程序决定。
 *
 * 剧本内容来自数据包（见 ./pack.ts 与 docs/JUBENSHA.md），不在本仓库里。
 */
import { z } from 'zod';
import { invalidAction, invalidState } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { shuffle } from '../../core/rng.js';
import { cleanSpeech, formatDuration, isEndSpeech, isSkipWord, normalizeText, resolveSeat, splitTrailingEnd, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, ActionSpec, PendingRequest, Seat } from '../../core/types.js';
import type { AssetStore } from '../../core/assets.js';
import { actRounds, packAssets, type PackClue, type PackQuestion, type ScriptLibrary, type ScriptPack } from './pack.js';

export { directoryLibrary, emptyLibrary, memoryLibrary, packAssets, packSchema, packWarnings, parsePack } from './pack.js';
export type { PackClue, PackQuestion, PackSummary, ScriptLibrary, ScriptPack } from './pack.js';

const optionsSchema = z.object({
  ...commonOptionShape,
  /** 剧本编号；剧本库里只有一个剧本时可以不填 */
  script: z.string().trim().max(32).default(''),
  /** DM 的 QQ 号或昵称；不填或此人没报名则由程序主持 */
  host: z.string().trim().max(300).default(''),
  /** 指定选角：QQ 号 → 角色 key；没指定的随机分配 */
  cast: z.record(z.string(), z.string()).default({}),
  intro_timeout_s: secondsOption(120),
  read_timeout_s: secondsOption(120),
  discuss_minutes: z.number().int().min(1).max(60).default(8),
  discuss_max_msgs: z.number().int().min(1).max(30).default(6),
  vote_timeout_s: secondsOption(120),
  confess_timeout_s: secondsOption(180),
  ask_limit: z.number().int().min(0).max(20).default(3),
  search_timeout_s: secondsOption(300, 30, 1800),
  quiz_timeout_s: secondsOption(300, 30, 1800),
  /** easy = 加发提示卡、不发难度卡；normal = 发难度卡、不发提示卡 */
  clue_level: z.enum(['easy', 'normal']).default('normal'),
  /** 结束时公布没被搜到的线索 */
  reveal_unfound: z.boolean().default(true),
  /** 舞台：group = 在群里玩；web = 在网页「灯下剧场」上玩（只有 AI 上场，群里只收镜像） */
  stage: z.enum(['group', 'web']).default('web'),
});

export type JubenshaOptions = z.infer<typeof optionsSchema>;

type Step =
  | { t: 'intro'; seat: Seat }
  | { t: 'act'; i: number }
  | { t: 'search'; i: number }
  | { t: 'discuss'; i: number }
  | { t: 'vote' }
  | { t: 'confess'; seat: Seat }
  | { t: 'end' };

interface QA {
  act: number;
  from: Seat;
  q: string;
  a?: string;
  by?: 'dm' | 'faq';
}

/** 搜证的进度（可序列化） */
export interface SearchState {
  /** 已开放的线索轮次 */
  opened: number[];
  /** 座位 → 剩余行动点 */
  left: Record<string, number>;
  /** 线索 id → 持有者 */
  holders: Record<string, Seat[]>;
  /** 已公开到群里的线索 */
  shared: { id: string; by: Seat }[];
  /** 公开的搜证记录：谁搜了哪里（不含卡面） */
  log: { act: number; seat: Seat; place: string; how: 'search' | 'deep' | 'dm' }[];
}

/** 问卷结果（结算后才有） */
export interface QuizResult {
  /** 座位 → 题目 id → 选项 key */
  answers: Record<string, Record<string, string>>;
  scores: Record<string, number>;
  /** 有没有判定破案的题 */
  hasCulpritQ: boolean;
}

export interface JubenshaState {
  pack: ScriptPack;
  /** 座位 → 角色 key（不含 DM） */
  cast: Record<string, string>;
  /** DM 座位；0 = 程序主持 */
  host: Seat;
  agenda: Step[];
  /** 已解锁的幕数 */
  unlocked: number;
  /** 当前所在的幕（-1 = 自我介绍） */
  act: number;
  /** 本幕每人已提问次数 */
  asks: Record<string, number>;
  qa: QA[];
  votes: Record<string, number>;
  outcome: { solved: boolean; top: Seat[] } | null;
  /** 有线索卡的剧本才有 */
  search?: SearchState;
  quiz?: QuizResult | null;
}

const MAX_CHUNK = 1500;
const CANNED = ['我先听听大家怎么说。', '我那段时间的行踪可以说清楚。', '这里面有个时间对不上。', '我想问问几位当时在哪。', '我没有更多要补充的了。'];

/** 按段落把长文切成不超过 max 字的几段（尽量不在句子中间切开）。 */
/** 选项 host 里的 DM 候选（逗号/空格分隔，按优先级排列）。 */
export function hostCandidates(host: string): string[] {
  return host.split(/[,，、\s]+/u).map((x) => x.trim()).filter(Boolean);
}

/** 按候选顺序找第一个在场的人。 */
function pickHost<T extends { id: string; name: string }>(host: string, list: readonly T[]): T | undefined {
  for (const c of hostCandidates(host)) {
    const hit = list.find((p) => p.id === c || p.name === c);
    if (hit) return hit;
  }
  return undefined;
}

export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const para of text.split(/\n/)) {
    if ((cur + '\n' + para).length <= max) {
      cur = cur ? `${cur}\n${para}` : para;
      continue;
    }
    push();
    let rest = para;
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf('。', max), rest.lastIndexOf('！', max), rest.lastIndexOf('？', max));
      const at = cut > max / 2 ? cut + 1 : max;
      out.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    cur = rest;
  }
  push();
  return out;
}

const RULES = `## 剧本杀

剧本来自私有数据包（开房选项 \`script\`）。程序负责选角、按幕私发剧本、计时、计票和公布真相；可以另请一位玩家担任 **DM**（选项 \`host\`，可写多个候选，取第一个报名的），DM 不扮演角色，负责串场、回答提问、掌握节奏，但**不能改变任何结果**。

**流程**
1. 开局：程序公布角色表（每人的公开介绍），私发每人的人物剧本；有开场念白的在群里播报。
2. 🙋 自我介绍：按座位顺序，每人以角色身份做自我介绍。
3. 每一幕：程序播报本幕公开内容，并私发各角色本幕的新剧本 → 📖 阅读（读完发「读完」）→ 💬 **自由讨论**（限时，人人都能随时说话；AI 不能连续自说自话，要等别人接话；每人每幕最多 \`discuss_max_msgs\` 条；说完了发「过」）。
   有搜证的幕在阅读之后加一个 🔎 **搜证**环节（见下）。
4. 🗳 投票指认凶手（不能投自己，可弃票）。得票最多的人是凶手之一就算破案；平票或没投中，凶手逃脱。剧本写了问卷时改为 📝 **问卷结算**（见下）。
5. 🎭 凶手坦白：凶手按认罪书坦白（此时才会收到认罪书）。
6. 📜 公布结局与真相，所有身份揭晓；结束后完整记录对所有人公开。

**搜证**（剧本有线索卡时）：每人整局有一定行动点。搜证环节里大家同时行动：搜一个地点或另一位玩家，从那里本轮还剩的卡里随机抽一张（花卡上的点数）；拿到的卡可以「深入」拿后续卡。卡面只私发给本人，群里只播报「谁搜了哪里」。默认每张卡只有一张（被搜走就没了）、没用完的点数留到下一轮、不能搜自己。讨论时可以随时把自己的卡**公开**到群里。DM 可以把已开放的卡直接交给某位玩家（不花点数）。结束时公布没被搜到的线索（选项 \`reveal_unfound\`）。

**问卷结算**（剧本写了问卷时代替投票）：每人私下逐题作答，截止前可以改，最后统一公布答案和得分。有「真凶题」时，侦破方（凶手以外）过半数答对即破案，侦破方胜、否则凶手胜（这道题对凶手本人不计分）；另外评出得分最高的 MVP。没有真凶题时只评 MVP。

**问 DM**：任何时候都可以私下提问（每幕最多 \`ask_limit\` 次）。有 DM 时由 DM 回答，没有 DM 时程序按预置答疑回答，问不到的请以自己的剧本为准。

**真人指令**：发言直接在群里说，说完发「过」；读完剧本发「读完」；投票「投3」「弃票」；提问私聊裁判「问DM 你的问题」。搜证私聊裁判「搜 地点」「搜 3号」「深入 线索名」「搜完了」；公开线索「公开 线索名」；问卷私聊裁判「1 3号」「2 b」（题号 + 答案）。
**bot 指令**：发言 \`speak({"text":"…"})\`；结束发言 \`act({"action":"end_speech"})\`；读完 \`act({"action":"ready"})\`；投票 \`act({"action":"vote","target":3})\`；提问 \`act({"action":"ask","text":"…"})\`。搜证 \`act({"action":"search","text":"地点"})\` 或 \`act({"action":"search","target":3})\`；深入 \`act({"action":"deep","text":"线索id"})\`；结束搜证 \`act({"action":"skip"})\`；公开 \`act({"action":"share","text":"线索id"})\`；答题 \`act({"action":"answer_q","text":"1:a"})\`（一次一题）。
**DM 指令**（DM 是 AI 时）：群里说话 \`speak\`；私下回答 \`act({"action":"answer","target":3,"text":"…"})\`；提前进入下一环节 \`act({"action":"next"})\`；延长当前环节 \`act({"action":"extend","number":2})\`（分钟，每个环节最多 2 次，每次 1~5 分钟）；发线索 \`act({"action":"give","target":3,"text":"线索id"})\`（真人 DM 私聊「给3 线索名」）。`;

const TIPS = `- 你扮演剧本里的角色：用角色的口吻说话，按自己的剧本行事。剧本里要求隐瞒的事可以隐瞒、可以说谎（凶手尤其如此），但不要编造剧本外的关键事实。
- 每一幕先读新解锁的剧本（get_my_view 的 you.acts），再参与讨论；讨论时回应别人、追问疑点，不要一个人连续发长篇。
- 拿不准的规则或剧情细节可以私下问 DM（act ask），但 DM 不会替你推理。
- 有搜证时，先想清楚要查什么再花点数；搜到的卡在 you.search.my_cards。对破案有用的卡可以在讨论时 share 公开，但凶手可以选择藏着自己不利的卡。
- 投票（或问卷）前梳理时间线和动机，投你认为的凶手。问卷一次答一题：act({"action":"answer_q","text":"题号:选项key"})。
- 这是演出：对局里的身份、罪行和关系都属于剧本角色，不是你自己的经历。`;

/**
 * @param library 剧本库
 * @param assets  图片素材库（可选）：开局时预取本局要用的图。没有它时图片仍会作为「[图片] + 文字说明」发出。
 */
export function createJubenshaDefinition(
  library: ScriptLibrary,
  assets?: AssetStore,
  defaultScript?: () => string | undefined,
): GameDefinition<JubenshaOptions> {
  const resolvePack = (o: JubenshaOptions): ScriptPack | string => {
    const list = library.list();
    if (!o.script) {
      if (list.length === 1) return library.get(list[0]!.id)!;
      if (list.length === 0) return '剧本库里还没有剧本（需要在引擎配置 scriptsDir 指向的私有目录里放入数据包）。';
      const def = defaultScript?.();
      const pack = def ? library.get(def) : null;
      if (pack) return pack;
      return `请用选项 script 指定剧本（或由管理员在管理页设默认剧本）：${list.map((p) => `${p.id}（${p.title}，${p.players} 人）`).join('、')}`;
    }
    return library.get(o.script) ?? `找不到剧本 ${o.script}。可用剧本：${list.map((p) => `${p.id}（${p.title}）`).join('、') || '无'}`;
  };

  class JubenshaGame extends BaseGame<JubenshaState, JubenshaOptions> {
    // ───────────────────────── 查询 ─────────────────────────

    private get pack(): ScriptPack {
      return this.state.pack;
    }

    private roleOf(seat: Seat) {
      const k = this.state.cast[String(seat)];
      return k ? this.pack.roles.find((r) => r.key === k) ?? null : null;
    }

    private playerSeats(): Seat[] {
      return this.allSeats().filter((s) => s !== this.state.host);
    }

    private isCulprit(seat: Seat): boolean {
      const r = this.roleOf(seat);
      return Boolean(r && this.pack.culprits.includes(r.key));
    }

    private roleLabel(seat: Seat): string {
      const r = this.roleOf(seat);
      return `${this.label(seat)}（${r ? r.name : 'DM'}）`;
    }

    private push(...steps: Step[]): void {
      this.state.agenda.unshift(...steps);
    }

    private announceLong(text: string, kind = 'announce'): void {
      // 长文本（剧本规则、幕文本、真相）只在网页上看，不往群里镜像
      for (const part of chunkText(text)) this.announce(part, { kind, mirror: false });
    }

    private tellLong(seat: Seat, text: string, kind: string): void {
      chunkText(text).forEach((part, i) => this.tell(seat, part, { kind: `${kind}:${i}`, category: 'role' }));
    }

    private image(id: string) {
      const img = this.pack.images.find((x) => x.id === id)!;
      return { asset: `${this.pack.id}/${img.file}`, caption: img.caption };
    }

    /** 群里发图（图片 + 文字说明；AI 从日志里看到说明） */
    private announceImages(ids: string[], kind: string): void {
      for (const id of ids) {
        const image = this.image(id);
        this.announce(`🖼 ${image.caption}`, { kind, image });
      }
    }

    /** 私发图片给某个角色 */
    private tellImages(seat: Seat, ids: string[], kind: string): void {
      ids.forEach((id, j) => {
        const image = this.image(id);
        this.tell(seat, `🖼 ${image.caption}`, { kind: `${kind}:${j}`, image });
      });
    }

    /** 某个角色到目前为止收到的图片说明 */
    private imageCaptions(ids: string[]): string[] {
      return ids.map((id) => this.pack.images.find((x) => x.id === id)!.caption);
    }

    // ───────────────────────── 开局 ─────────────────────────

    start(): void {
      const o = this.options;
      const resolved = resolvePack(o);
      if (typeof resolved === 'string') throw invalidState(resolved);
      const pack = resolved;
      const hostP = this.players.length === pack.players + 1 ? pickHost(o.host, this.players) : undefined;
      const host = hostP ? hostP.seat : 0;
      const seats = this.allSeats().filter((s) => s !== host);

      // 选角：先按 cast 指定，其余随机
      const cast: Record<string, string> = {};
      const free = new Set(pack.roles.map((r) => r.key));
      for (const s of seats) {
        const want = o.cast[this.player(s).id];
        if (want && free.has(want)) {
          cast[String(s)] = want;
          free.delete(want);
        }
      }
      const rest = shuffle(this.rng, [...free]);
      for (const s of seats) if (!cast[String(s)]) cast[String(s)] = rest.shift()!;

      const agenda: Step[] = [
        ...seats.map((seat): Step => ({ t: 'intro', seat })),
        ...pack.acts.flatMap((a, i): Step[] => [{ t: 'act', i }, ...(a.search ? [{ t: 'search', i } as Step] : []), { t: 'discuss', i }]),
        { t: 'vote' },
      ];
      Object.assign(this.rec.state, {
        pack,
        cast,
        host,
        agenda,
        unlocked: 0,
        act: -1,
        asks: {},
        qa: [],
        votes: {},
        outcome: null,
        ...(pack.clues.length
          ? { search: { opened: [], left: Object.fromEntries(seats.map((x) => [String(x), pack.search.points])), holders: {}, shared: [], log: [] } }
          : {}),
        quiz: null,
      } satisfies JubenshaState);
      this.rec.round = 0;
      if (pack.images.length) assets?.prepare(this.rec.id, packAssets(pack));

      const castText = seats
        .map((s) => {
          const r = this.roleOf(s)!;
          return `${s}号 ${this.player(s).name} → 【${r.name}】${r.public ? `：${r.public}` : ''}`;
        })
        .join('\n');
      this.announce(
        `🎭 剧本杀《${pack.title}》开始！共 ${seats.length} 位玩家，${pack.acts.length} 幕。\n` +
          (host ? `本局 DM：${this.at(host)}（不扮演角色，负责主持与答疑，不能改变任何结果）。\n` : '本局由程序主持。\n') +
          `角色表：\n${castText}\n` +
          `人物剧本已私发（AI 请查看 get_my_view 的 you.script，真人请查收裁判私聊）。任何时候都可以私下「问DM」（每幕最多 ${o.ask_limit} 次）。`,
      );
      if (pack.rules_note) this.announceLong(`📏 本剧本规则：\n${pack.rules_note}`);
      if (pack.clues.length) {
        const s = pack.search;
        this.announce(
          `🔎 本剧本有搜证：每人整局 ${s.points} 个行动点${s.carry_over ? '（没用完的留到下一轮）' : '（每轮没用完的作废）'}，` +
            `${s.exclusive ? '每张线索卡只有一张，被人搜走就没了' : '同一张线索每个人都能搜到'}${s.self_search ? '' : '，不能搜自己'}。` +
            `搜到的卡只私发给你，群里只播报谁搜了哪里；讨论时可以「公开 线索名」把卡亮给大家。`,
        );
      }
      if (pack.questionnaire.length) {
        this.announce(`📝 本剧本用问卷结算（共 ${pack.questionnaire.length} 题，按答对计分），${pack.questionnaire.some((q) => q.culprit) ? '侦破方多数人答对真凶题即破案，' : ''}另外评出得分最高的 MVP。`);
      }

      for (const s of seats) {
        const r = this.roleOf(s)!;
        this.tellLong(s, `🎭 你扮演【${r.name}】。\n${r.public ? `公开介绍：${r.public}\n` : ''}—— 你的人物剧本 ——\n${r.script}`, 'script');
        this.tellImages(s, r.images, 'script_img');
      }
      if (host) {
        this.tell(
          host,
          `🎬 你是本局 DM。完整剧本、真相和主持手册在 get_my_view 的 you 里（只有你能看到）。` +
            `你可以在群里串场、私下回答提问（answer）、提前进入下一环节（next）、延长讨论（extend）；不能透露真相，也不能替玩家推理。`,
          { kind: 'dm_brief', category: 'role' },
        );
      }
      if (pack.intro) this.announceLong(`📖 ${pack.intro}`, 'narration');
      this.announceImages(pack.intro_images, 'narration');
      this.proceed();
    }

    // ───────────────────────── 推进 ─────────────────────────

    private proceed(): void {
      for (let guard = 0; guard < 200; guard++) {
        if (this.rec.status !== 'running') return;
        const step = this.state.agenda.shift();
        if (!step) return;
        if (this.runStep(step)) return;
      }
    }

    /** 返回 true 表示开了一个阶段（等待玩家）。 */
    private runStep(step: Step): boolean {
      switch (step.t) {
        case 'intro':
          if (!this.rec.log.some((e) => e.kind === 'intro_start')) {
            this.announce('🙋 自我介绍环节：按座位顺序，每人以角色身份介绍自己。', { kind: 'intro_start' });
          }
          return this.openSpeech('intro', step.seat, this.options.intro_timeout_s, '自我介绍');
        case 'act':
          return this.openAct(step.i);
        case 'search':
          return this.openSearch(step.i);
        case 'discuss':
          return this.openDiscuss(step.i);
        case 'vote':
          return this.pack.questionnaire.length ? this.openQuiz() : this.openVote();
        case 'confess':
          return this.openConfess(step.seat);
        case 'end':
          this.finishGame();
          return true;
      }
    }

    advance(): void {
      const ph = this.phase!;
      if (ph.key === 'discuss') this.announce(`⏹️ ${this.pack.acts[ph.data.i as number]!.title} 讨论结束。`);
      if (ph.key === 'vote') this.tally();
      if (ph.key === 'search') this.closeSearch();
      if (ph.key === 'quiz') this.scoreQuiz();
      if (ph.key === 'confess') {
        const seat = ph.data.seat as Seat;
        if (!ph.data.spoke) {
          const r = this.roleOf(seat)!;
          if (r.confession) this.announceLong(`📜 ${this.roleLabel(seat)} 没有开口，以下是认罪书原文：\n${r.confession}`);
        }
      }
      this.proceed();
    }

    // ───────────────────────── 阶段 ─────────────────────────

    private speechActions(): ActionSpec[] {
      return [this.specSpeech('直接在群里说，说完发「过」'), { action: 'end_speech', label: '结束发言', example: 'act({"action":"end_speech"})', command: '过' }];
    }

    private openSpeech(key: 'intro' | 'confess', seat: Seat, secs: number, name: string): boolean {
      const r = this.roleOf(seat)!;
      this.announce(`🎤 请 ${this.at(seat)}【${r.name}】${name}（限时 ${secs} 秒，说完发「过」）。`);
      this.openPhase({
        key,
        title: `${name}·${seat}号`,
        requests: [
          {
            seat,
            kind: 'speech',
            prompt: key === 'intro' ? `请以【${r.name}】的身份做自我介绍。` : '请按你的认罪书坦白（可以用自己的话，认罪书在 you.confession）。',
            actions: this.speechActions(),
          },
        ],
        timeoutMs: secs * 1000,
        data: { seat },
      });
      return true;
    }

    private openAct(i: number): boolean {
      const act = this.pack.acts[i]!;
      this.state.act = i;
      this.state.unlocked = Math.max(this.state.unlocked, i + 1);
      this.state.asks = {};
      this.rec.round = i + 1;
      this.announce(`🎬 ${act.title}`, { kind: 'act' });
      if (act.public) this.announceLong(act.public, 'narration');
      this.announceImages(act.public_images, 'narration');
      for (const s of this.playerSeats()) {
        const k = this.state.cast[String(s)]!;
        const t = act.private[k];
        if (t) this.tellLong(s, `📖 ${act.title}·你的新剧本：\n${t}`, `act${i}`);
        this.tellImages(s, act.private_images[k] ?? [], `act${i}_img`);
      }
      const secs = this.options.read_timeout_s;
      this.announce(`📖 请阅读本幕剧本（限时 ${secs} 秒），读完发「读完」。`);
      this.openPhase({
        key: 'read',
        title: `${act.title}·阅读`,
        requests: this.playerSeats().map((seat) => ({
          seat,
          prompt: `阅读${act.title}的新剧本（get_my_view 的 you.acts），读完执行 ready。`,
          actions: [{ action: 'ready', label: '读完', example: 'act({"action":"ready"})', command: '读完' }],
        })),
        timeoutMs: secs * 1000,
        data: { i },
      });
      return true;
    }

    private openDiscuss(i: number): boolean {
      const act = this.pack.acts[i]!;
      const mins = act.discuss_minutes ?? this.options.discuss_minutes;
      const max = this.options.discuss_max_msgs;
      this.announce(
        `💬 ${act.title}·自由讨论（${mins} 分钟）：大家随时可以说话、互相追问。每人本幕最多 ${max} 条，说完了发「过」；所有人都「过」或时间到就进入下一环节。`,
      );
      this.openPhase({
        key: 'discuss',
        title: `${act.title}·讨论`,
        requests: this.playerSeats().map((seat) => ({
          seat,
          kind: 'speech',
          prompt: `自由讨论：以角色身份发言、回应别人、追问疑点。每人最多 ${max} 条；刚说完要等别人接话再说；没有要说的就 end_speech（过）。`,
          actions: this.speechActions(),
        })),
        timeoutMs: mins * 60_000,
        data: { i, counts: {}, passed: [], last: 0, extends: 0 },
      });
      return true;
    }

    private openVote(): boolean {
      this.state.act = this.pack.acts.length;
      const seats = this.playerSeats();
      const secs = this.options.vote_timeout_s;
      this.announce(
        `🗳️ 投票：${this.pack.vote.question}（${secs} 秒内群里发「${this.exampleCmd('投3', seats)}」或「弃票」，也可私聊裁判；票数结束后统一公布）\n可投：${seats.map((s) => this.roleLabel(s)).join('、')}`,
      );
      this.openPhase({
        key: 'vote',
        title: '投票指认',
        requests: seats.map((seat) => ({
          seat,
          prompt: `${this.pack.vote.question} 投你认为的凶手（不能投自己），或弃票。`,
          actions: [this.specTarget('vote', '投票', seats.filter((s) => s !== seat), '投3'), this.specSkip('弃票', '弃票')],
        })),
        timeoutMs: secs * 1000,
        data: { votes: {} },
      });
      return true;
    }

    private openConfess(seat: Seat): boolean {
      const r = this.roleOf(seat)!;
      if (r.confession) this.tellLong(seat, `📜 你的认罪书：\n${r.confession}`, 'confession');
      return this.openSpeech('confess', seat, this.options.confess_timeout_s, '坦白');
    }

    // ───────────────────────── 搜证 ─────────────────────────

    private get sx(): SearchState {
      return (this.state.search ??= { opened: [], left: {}, holders: {}, shared: [], log: [] });
    }

    /** 本局发不发这张卡（难度调节） */
    private clueOn(c: PackClue): boolean {
      if (c.level === 'easy') return this.options.clue_level === 'easy';
      if (c.level === 'hard') return this.options.clue_level !== 'easy';
      return true;
    }

    private clueById(id: string): PackClue | undefined {
      return this.pack.clues.find((c) => c.id === id);
    }

    private holds(seat: Seat, id: string): boolean {
      return (this.sx.holders[id] ?? []).includes(seat);
    }

    private held(seat: Seat): PackClue[] {
      return this.pack.clues.filter((c) => this.holds(seat, c.id));
    }

    /** 这张卡对 seat 来说还拿得到（独占时：没人拿过；不独占时：自己没拿过） */
    private obtainable(c: PackClue, seat: Seat): boolean {
      if (!this.clueOn(c) || this.holds(seat, c.id)) return false;
      if (this.pack.search.exclusive && (this.sx.holders[c.id]?.length ?? 0) > 0) return false;
      return c.round === undefined || this.sx.opened.includes(c.round);
    }

    private placeName(at: string): string {
      return this.pack.locations.find((l) => l.key === at)?.name ?? this.pack.roles.find((r) => r.key === at)?.name ?? at;
    }

    /** 可以搜的地方：登记的地点 + 身上有线索的角色（不能搜自己时去掉自己） */
    private places(seat: Seat | null): { key: string; name: string }[] {
      const withClues = new Set(this.pack.clues.filter((c) => !c.deep_only && c.at).map((c) => c.at!));
      const mine = seat === null ? null : this.state.cast[String(seat)];
      const roles = this.pack.roles
        .filter((r) => withClues.has(r.key) && (this.pack.search.self_search || r.key !== mine))
        .map((r) => ({ key: r.key, name: r.name }));
      return [...this.pack.locations.filter((l) => withClues.has(l.key)), ...roles];
    }

    /** 某处还能搜到的卡；seat 为 null 时按「谁都还没拿」算（公开视图用） */
    private remaining(at: string, seat: Seat | null): PackClue[] {
      return this.pack.clues.filter(
        (c) =>
          !c.deep_only &&
          c.at === at &&
          (seat === null ? this.clueOn(c) && !(this.sx.holders[c.id]?.length && this.pack.search.exclusive) && (c.round === undefined || this.sx.opened.includes(c.round)) : this.obtainable(c, seat)),
      );
    }

    /** 本轮 seat 还能花几点 */
    private allowance(seat: Seat): number {
      const left = this.sx.left[String(seat)] ?? 0;
      const ph = this.phase;
      if (!ph || ph.key !== 'search') return 0;
      const max = ph.data.max as number | null;
      if (max === null) return left;
      return Math.max(0, Math.min(left, max - ((ph.data.spent as Record<string, number>)[String(seat)] ?? 0)));
    }

    private resolvePlace(seat: Seat, input: ActionInput): string {
      let key: string | undefined;
      if (input.target !== undefined && input.target !== null) {
        if (!this.playerSeats().includes(input.target)) throw invalidAction(`${input.target}号 不是可以搜的玩家。`);
        key = this.state.cast[String(input.target)];
      } else {
        const raw = String(input.text ?? '').trim();
        const t = normalizeText(raw).replace(/\s+/g, '').toLowerCase();
        if (!t) throw invalidAction('search 需要 text（地点）或 target（搜某位玩家的座位号）。');
        const all = [...this.pack.locations, ...this.pack.roles.map((r) => ({ key: r.key, name: r.name }))];
        const norm = (x: string) => normalizeText(x).replace(/\s+/g, '').toLowerCase();
        const exact = all.find((p) => p.key.toLowerCase() === t || norm(p.name) === t);
        if (exact) key = exact.key;
        else {
          const sm = t.match(/^(\d{1,2})号?$/u);
          const bySeat = sm ? Number(sm[1]) : resolveSeat(raw, this.players);
          if (bySeat !== null && this.playerSeats().includes(bySeat)) key = this.state.cast[String(bySeat)];
          else {
            const part = all.filter((p) => norm(p.name).includes(t) || t.includes(norm(p.name)));
            if (part.length === 1) key = part[0]!.key;
            else if (part.length > 1) throw invalidAction(`「${raw}」能对上好几个地方：${part.map((p) => p.name).join('、')}，请说具体一点。`);
          }
        }
        if (!key) throw invalidAction(`没有叫「${raw}」的地方。可以搜：${this.places(seat).map((p) => p.name).join('、') || '无'}`);
      }
      if (key === this.state.cast[String(seat)] && !this.pack.search.self_search) throw invalidAction('不能搜自己。');
      return key!;
    }

    /** 在 pool 里按 id / 卡背标签找一张卡 */
    private resolveClue(ref: string, pool: PackClue[], what: string): PackClue {
      const raw = ref.trim();
      const t = normalizeText(raw).replace(/\s+/g, '').toLowerCase();
      if (!t) throw invalidAction(`请写${what}的线索 id 或卡背标签。`);
      const norm = (x: string) => normalizeText(x).replace(/[\s【】「」]/gu, '').toLowerCase();
      const byId = pool.find((c) => c.id.toLowerCase() === t);
      if (byId) return byId;
      const exact = pool.filter((c) => norm(c.title) === t);
      if (exact.length === 1) return exact[0]!;
      const part = pool.filter((c) => norm(c.title).includes(t));
      if (part.length === 1) return part[0]!;
      const list = (part.length ? part : pool).map((c) => `${c.id}（${c.title}）`).join('、');
      throw invalidAction(part.length ? `「${raw}」对上了好几张卡：${list}，请写 id。` : `${what}里没有「${raw}」。可选：${list || '无'}`);
    }

    private deepKids(seat: Seat, parent: PackClue): PackClue[] {
      return parent.deep.map((id) => this.clueById(id)).filter((c): c is PackClue => Boolean(c && this.obtainable(c, seat)));
    }

    private cardText(c: PackClue): string {
      const caps = this.imageCaptions(c.images);
      return `【${c.title}】${c.text ? `\n${c.text}` : ''}${caps.length ? `\n${caps.map((x) => `🖼 ${x}`).join('\n')}` : ''}`;
    }

    private searchActions(): ActionSpec[] {
      return [
        { action: 'search', label: '搜证', params: { text: '地点 key 或名称', target: '或者搜某位玩家（座位号）' }, example: 'act({"action":"search","text":"地点"})', command: '搜 地点' },
        { action: 'deep', label: '深入', params: { text: '你持有的线索 id' }, example: 'act({"action":"deep","text":"线索id"})', command: '深入 线索名' },
        this.specSkip('结束本轮搜证', '搜完了'),
      ];
    }

    private openSearch(i: number): boolean {
      const act = this.pack.acts[i]!;
      const cfg = act.search!;
      for (const r of actRounds(cfg)) if (!this.sx.opened.includes(r)) this.sx.opened.push(r);
      const ms = cfg.minutes ? cfg.minutes * 60_000 : this.options.search_timeout_s * 1000;
      const seats = this.playerSeats();
      const placeText = this.places(null)
        .map((p) => `${p.name}（${this.remaining(p.key, null).length} 张）`)
        .join('、');
      this.announce(
        `🔎 ${act.title}·搜证（限时 ${formatDuration(ms)}${cfg.max_points ? `，本轮每人最多 ${cfg.max_points} 点` : ''}）：` +
          `私聊裁判「搜 地点」或「搜 3号」，拿到的卡可以「深入 线索名」，搜完发「搜完了」。群里只播报谁搜了哪里，卡面只私发给你。\n可搜：${placeText || '无'}`,
        { kind: 'search_start' },
      );
      this.openPhase({
        key: 'search',
        title: `${act.title}·搜证`,
        secret: true,
        requests: seats.map((seat) => ({
          seat,
          channel: 'private',
          prompt: `搜证：用行动点搜地点或别的角色，搜到的卡只有你能看到（get_my_view 的 you.search）。本轮用完点数或执行 skip 就结束。`,
          actions: this.searchActions(),
        })),
        timeoutMs: ms,
        data: { i, spent: {}, max: cfg.max_points ?? null, extends: 0 },
      });
      for (const s of seats) if (this.allowance(s) <= 0) this.markDone(s);
      return true;
    }

    private closeSearch(): void {
      const ph = this.phase!;
      if (!this.pack.search.carry_over) {
        for (const s of this.playerSeats()) {
          const k = String(s);
          this.sx.left[k] = Math.max(0, (this.sx.left[k] ?? 0) - this.allowance(s));
        }
      }
      this.announce(`⏹️ ${this.pack.acts[ph.data.i as number]!.title} 搜证结束。`);
    }

    /** 把卡交给 seat：私发卡面，群里只播报去向 */
    private grant(seat: Seat, c: PackClue, how: { at?: string; parent?: PackClue; dm?: boolean }): string {
      const k = String(seat);
      if (!how.dm) {
        this.sx.left[k] = Math.max(0, (this.sx.left[k] ?? 0) - c.cost);
        const spent = this.phase!.data.spent as Record<string, number>;
        spent[k] = (spent[k] ?? 0) + c.cost;
      }
      (this.sx.holders[c.id] ??= []).push(seat);
      const place = how.dm ? 'DM' : how.parent ? how.parent.title : this.placeName(how.at!);
      this.sx.log.push({ act: this.state.act, seat, place, how: how.dm ? 'dm' : how.parent ? 'deep' : 'search' });
      this.announce(
        how.dm ? `🎭 DM 交给 ${this.label(seat)} 一张线索。` : how.parent ? `🔎 ${this.label(seat)} 深入调查了「${how.parent.title}」。` : `🔎 ${this.label(seat)} 搜了 ${place}。`,
        { kind: 'search_log' },
      );
      this.tellLong(seat, `🃏 你拿到线索 ${c.id}【${c.title}】${c.text ? `\n${c.text}` : ''}`, `clue_${c.id}`);
      this.tellImages(seat, c.images, `clue_${c.id}_img`);
      if (c.public) this.publish(seat, c);
      let tail = '';
      if (!how.dm) {
        const left = this.allowance(seat);
        if (left <= 0) {
          this.markDone(seat);
          tail = '本轮点数已用完。';
        } else tail = `本轮还能用 ${left} 点。`;
      }
      const deep = this.deepKids(seat, c).length ? `这张卡可以深入（act deep，text="${c.id}"）。` : '';
      return `你拿到线索 ${c.id}：${this.cardText(c)}\n${deep}${tail}`.trim();
    }

    private publish(seat: Seat, c: PackClue): void {
      this.sx.shared.push({ id: c.id, by: seat });
      this.announceLong(`🃏 ${this.roleLabel(seat)} 公开了线索【${c.title}】${c.text ? `：\n${c.text}` : ''}`, 'clue_shared');
      this.announceImages(c.images, 'clue_shared');
    }

    private searchAction(seat: Seat, input: ActionInput): string {
      this.requireTurn(seat, input.action);
      if (input.action === 'skip') {
        this.markDone(seat);
        return `本轮搜证结束（剩余总点数 ${this.sx.left[String(seat)] ?? 0}${this.pack.search.carry_over ? '，留到下一轮' : ''}）。`;
      }
      const allow = this.allowance(seat);
      if (input.action === 'search') {
        const at = this.resolvePlace(seat, input);
        const pool = this.remaining(at, seat);
        if (!pool.length) throw invalidAction(`${this.placeName(at)} 现在没有你能搜到的线索了。`);
        const afford = pool.filter((c) => c.cost <= allow);
        if (!afford.length) throw invalidAction(`点数不够：${this.placeName(at)} 的线索至少要 ${Math.min(...pool.map((c) => c.cost))} 点，你本轮还有 ${allow} 点。`);
        return this.grant(seat, afford[this.rng.int(afford.length)]!, { at });
      }
      // deep
      const mine = this.held(seat).filter((c) => c.deep.length);
      if (!mine.length) throw invalidAction('你手上没有可以深入的线索。');
      const parent = this.resolveClue(String(input.text ?? ''), mine, '可以深入的卡');
      const kids = this.deepKids(seat, parent);
      if (!kids.length) throw invalidAction(`「${parent.title}」已经没有可以深入的内容了。`);
      const c = kids[0]!;
      if (c.cost > allow) throw invalidAction(`点数不够：深入要 ${c.cost} 点，你本轮还有 ${allow} 点。`);
      return this.grant(seat, c, { parent });
    }

    private share(seat: Seat, input: ActionInput): string {
      const mine = this.held(seat).filter((c) => !this.sx.shared.some((x) => x.id === c.id));
      if (!mine.length) throw invalidAction(this.held(seat).length ? '你的线索都已经公开过了。' : '你手上还没有线索卡。');
      const c = this.resolveClue(String(input.text ?? ''), mine, '你没公开的卡');
      this.publish(seat, c);
      return `已在群里公开【${c.title}】。`;
    }

    // ───────────────────────── 问卷 ─────────────────────────

    /** seat 要答的题（no = 全卷题号，从 1 开始） */
    private quizFor(seat: Seat): { no: number; q: PackQuestion }[] {
      const k = this.state.cast[String(seat)];
      return this.pack.questionnaire.map((q, i) => ({ no: i + 1, q })).filter(({ q }) => !q.for.length || (k !== undefined && q.for.includes(k)));
    }

    private quizOptions(q: PackQuestion): { key: string; text: string }[] {
      if (q.options !== 'roles') return q.options;
      return this.pack.roles.map((r) => {
        const seat = this.playerSeats().find((x) => this.state.cast[String(x)] === r.key);
        return { key: r.key, text: seat ? `${r.name}（${seat}号）` : r.name };
      });
    }

    private optionText(q: PackQuestion, key: string): string {
      return this.quizOptions(q).find((o) => o.key === key)?.text ?? key;
    }

    private resolveOption(q: PackQuestion, raw: string): string {
      const opts = this.quizOptions(q);
      const norm = (x: string) => normalizeText(x).replace(/\s+/g, '').toLowerCase();
      const t = norm(stripTrailing(raw));
      const hit = opts.find((o) => o.key.toLowerCase() === t) ?? opts.find((o) => norm(o.text) === t);
      if (hit) return hit.key;
      if (q.options === 'roles') {
        const role = this.pack.roles.find((r) => norm(r.name) === t);
        if (role) return role.key;
        const sm = t.match(/^(\d{1,2})号?$/u);
        const seat = sm ? Number(sm[1]) : resolveSeat(raw, this.players);
        if (seat !== null && this.playerSeats().includes(seat)) return this.state.cast[String(seat)]!;
      }
      const part = opts.filter((o) => norm(o.text).includes(t));
      if (t && part.length === 1) return part[0]!.key;
      throw invalidAction(`选项里没有「${raw.trim()}」。可选：${opts.map((o) => `${o.key}=${o.text}`).join('、')}`);
    }

    private quizText(seat: Seat | null): string {
      const list = seat === null ? this.pack.questionnaire.map((q, i) => ({ no: i + 1, q })) : this.quizFor(seat);
      return list
        .map(({ no, q }) => `${no}. ${q.question}（${q.points} 分）\n   ${this.quizOptions(q).map((o) => `${o.key}=${o.text}`).join('  ')}`)
        .join('\n');
    }

    private openQuiz(): boolean {
      this.state.act = this.pack.acts.length;
      const seats = this.playerSeats().filter((s) => this.quizFor(s).length);
      const ms = this.options.quiz_timeout_s * 1000;
      this.announce(
        `📝 问卷结算（限时 ${formatDuration(ms)}）：私聊裁判作答，一条答一题，格式「题号 答案」，如「1 3号」「2 b」；截止前可以改，最后统一公布。\n${this.quizText(null)}`,
        { kind: 'quiz_start' },
      );
      this.openPhase({
        key: 'quiz',
        title: '问卷',
        requests: seats.map((seat) => ({
          seat,
          channel: 'private',
          prompt: `逐题作答（每次一题，截止前可以改）：\n${this.quizText(seat)}`,
          actions: [{ action: 'answer_q', label: '答题', params: { text: '"题号:选项 key"，如 "1:a"' }, example: 'act({"action":"answer_q","text":"1:a"})', command: '1 a' }],
        })),
        timeoutMs: ms,
        data: { answers: {} },
      });
      return true;
    }

    private answerQ(seat: Seat, input: ActionInput): string {
      const ph = this.phase!;
      const req = ph.pending[String(seat)];
      if (!req) throw invalidAction('你没有要答的题。');
      if (ph.openedAt === null) throw invalidAction('问卷尚未开放，请稍后。');
      if (input.action !== 'answer_q') throw invalidAction('问卷环节请用 act({"action":"answer_q","text":"题号:选项"})。');
      const raw = String(input.text ?? '');
      const m = raw.trim().match(/^第?\s*([A-Za-z0-9_-]{1,24}?)\s*题?\s*[:：,，\s]\s*(.+)$/su);
      if (!m) throw invalidAction('格式是「题号:选项」，如 "1:a" 或 "1:3号"。');
      const mine = this.quizFor(seat);
      const ref = m[1]!;
      const item = mine.find((x) => String(x.no) === ref || x.q.id === ref);
      if (!item) throw invalidAction(`你要答的题是：${mine.map((x) => `${x.no}（${x.q.id}）`).join('、')}`);
      const opt = this.resolveOption(item.q, m[2]!);
      const answers = ph.data.answers as Record<string, Record<string, string>>;
      (answers[String(seat)] ??= {})[item.q.id] = opt;
      const todo = mine.filter((x) => !answers[String(seat)]![x.q.id]);
      req.done = todo.length === 0;
      return `已记下第 ${item.no} 题：${this.optionText(item.q, opt)}。` + (todo.length ? `还没答：第 ${todo.map((x) => x.no).join('、')} 题。` : '全部答完了。');
    }

    private scoreQuiz(): void {
      const answers = { ...(this.phase!.data.answers as Record<string, Record<string, string>>) };
      const seats = this.playerSeats();
      const scores: Record<string, number> = {};
      for (const s of seats) {
        // 真凶题对凶手本人不计分（答案就是自己）
        scores[String(s)] = this.quizFor(s).reduce(
          (n, { q }) => n + (!(q.culprit && this.isCulprit(s)) && q.answer.includes(answers[String(s)]?.[q.id] ?? '') ? q.points : 0),
          0,
        );
      }
      const lines = this.pack.questionnaire.map((q, i) => {
        const who = seats
          .filter((s) => this.quizFor(s).some((x) => x.q.id === q.id))
          .map((s) => {
            const a = answers[String(s)]?.[q.id];
            return `${s}号${a ? `${q.answer.includes(a) ? '✅' : '❌'}${this.optionText(q, a)}` : '⏰未答'}`;
          });
        return `${i + 1}. ${q.question} 答案：${q.answer.map((a) => this.optionText(q, a)).join(' / ')}\n   ${who.join('  ')}`;
      });
      const best = Math.max(0, ...Object.values(scores));
      const mvp = seats.filter((s) => scores[String(s)] === best && best > 0);
      const cq = this.pack.questionnaire.find((q) => q.culprit);
      let solved = false;
      if (cq) {
        const eligible = seats.filter((s) => !this.isCulprit(s) && this.quizFor(s).some((x) => x.q.id === cq.id));
        const right = eligible.filter((s) => cq.answer.includes(answers[String(s)]?.[cq.id] ?? '')).length;
        solved = eligible.length > 0 && right * 2 > eligible.length;
      }
      this.state.quiz = { answers, scores, hasCulpritQ: Boolean(cq) };
      this.state.outcome = { solved, top: mvp };
      this.announceLong(
        `📊 问卷结果：\n${lines.join('\n')}\n得分：${seats.map((s) => `${this.label(s)} ${scores[String(s)]} 分`).join('、')}\n` +
          (mvp.length ? `🏅 MVP：${mvp.map((s) => this.roleLabel(s)).join('、')}（${best} 分）` : '🏅 没有人得分。'),
        'quiz',
      );
      const culprits = seats.filter((s) => this.isCulprit(s));
      if (cq) this.announce(solved ? '🔍 多数人答对了真凶！请真凶坦白。' : '🌫️ 多数人没有答对真凶……请真凶现身坦白。');
      else this.announce('🎭 请真凶现身坦白。');
      this.push(...culprits.map((seat): Step => ({ t: 'confess', seat })), { t: 'end' });
    }

    private tally(): void {
      const votes = this.phase!.data.votes as Record<string, number>;
      const counts = new Map<number, number>();
      const lines: string[] = [];
      for (const s of this.playerSeats()) {
        const t = votes[String(s)];
        if (t) {
          counts.set(t, (counts.get(t) ?? 0) + 1);
          lines.push(`${this.label(s)} → ${this.roleLabel(t)}`);
        } else lines.push(`${this.label(s)} → 弃票`);
      }
      const top = counts.size ? Math.max(...counts.values()) : 0;
      const leaders = [...counts.entries()].filter(([, c]) => c === top).map(([s]) => s).sort((a, b) => a - b);
      const solved = leaders.length === 1 && this.isCulprit(leaders[0]!);
      this.state.votes = { ...votes };
      this.state.outcome = { solved, top: leaders };
      const summary = top === 0 ? '无人得票' : leaders.length === 1 ? `得票最多：${this.roleLabel(leaders[0]!)}（${top} 票）` : `平票：${leaders.map((s) => this.roleLabel(s)).join('、')}`;
      this.announce(`📊 投票结果：\n${lines.join('\n')}\n${summary}`, { kind: 'vote' });
      const culprits = this.playerSeats().filter((s) => this.isCulprit(s));
      this.announce(solved ? '🔍 指认成功！请真凶坦白。' : '🌫️ 没有指认出真凶……请真凶现身坦白。');
      this.push(...culprits.map((seat): Step => ({ t: 'confess', seat })), { t: 'end' });
    }

    private finishGame(): void {
      const out = this.state.outcome ?? { solved: false, top: [] };
      const ending = out.solved ? this.pack.endings.solved : this.pack.endings.unsolved;
      if (ending) this.announceLong(`🎬 ${ending}`, 'narration');
      this.announceLong(`📜 真相：\n${this.pack.truth}`, 'truth');
      this.announceImages(this.pack.truth_images, 'truth');
      if (this.state.search && this.options.reveal_unfound) {
        const unfound = this.pack.clues.filter((c) => this.clueOn(c) && !this.sx.holders[c.id]?.length);
        if (unfound.length) this.announceLong(`🗂 没有被搜到的线索：\n${unfound.map((c) => this.cardText(c)).join('\n')}`, 'unfound');
      }
      const seats = this.playerSeats();
      const culprits = seats.filter((s) => this.isCulprit(s));
      const quiz = this.state.quiz;
      if (quiz && !quiz.hasCulpritQ) {
        this.finish({
          winnerTeam: 'MVP',
          winnerSeats: out.top,
          reason: out.top.length ? '问卷得分最高' : '没有人在问卷里得分',
          reveal: [
            ...seats.map((s) => ({ seat: s, name: this.player(s).name, identity: `${this.roleOf(s)!.name}${this.isCulprit(s) ? '（凶手）' : ''}` })),
            ...(this.state.host ? [{ seat: this.state.host, name: this.player(this.state.host).name, identity: 'DM' }] : []),
          ],
        });
        return;
      }
      this.finish({
        winnerTeam: out.solved ? '侦破方' : '凶手',
        winnerSeats: out.solved ? seats.filter((s) => !this.isCulprit(s)) : culprits,
        reason: quiz ? (out.solved ? '问卷里多数人答对了真凶' : '问卷里多数人没有答对真凶') : out.solved ? '投票指认出了真凶' : '真凶逃脱了指认',
        reveal: [
          ...seats.map((s) => ({ seat: s, name: this.player(s).name, identity: `${this.roleOf(s)!.name}${this.isCulprit(s) ? '（凶手）' : ''}` })),
          ...(this.state.host ? [{ seat: this.state.host, name: this.player(this.state.host).name, identity: 'DM' }] : []),
        ],
      });
    }

    // ───────────────────────── 动作 ─────────────────────────

    onAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
      if (seat === this.state.host) return this.hostAction(seat, input);
      if (input.action === 'ask') return this.ask(seat, input);
      if (input.action === 'share') return this.share(seat, input);
      const key = this.phase?.key;
      if (key === 'search') return this.searchAction(seat, input);
      if (key === 'quiz') return this.answerQ(seat, input);
      if (key === 'discuss') return this.discussAction(seat, input, meta);
      if (key === 'intro' || key === 'confess') return this.speechAction(seat, input, meta);
      if (key === 'read') {
        this.requireTurn(seat, input.action);
        this.markDone(seat);
        return '已读。';
      }
      if (key === 'vote') {
        const req = this.requireTurn(seat, input.action);
        const votes = this.phase!.data.votes as Record<string, number>;
        if (input.action === 'skip') {
          votes[String(seat)] = 0;
          this.markDone(seat);
          return '你选择弃票。';
        }
        votes[String(seat)] = this.requireTarget(req, 'vote', input.target);
        this.markDone(seat);
        return `你投了 ${votes[String(seat)]}号。`;
      }
      throw invalidAction('现在没有你可以做的事。');
    }

    private speechAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
      const ph = this.phase!;
      this.requireTurn(seat, input.action);
      if (input.action === 'end_speech') {
        this.markDone(seat);
        return '发言结束。';
      }
      const text = cleanSpeech(String(input.text ?? ''));
      if (!text) throw invalidAction('发言不能为空。');
      this.recordSpeech(seat, text, 'speech', ph.key === 'intro' ? '自我介绍' : '坦白');
      ph.data.spoke = true;
      // AI 一次说完；真人可以分几条说，发「过」结束
      if (meta.via === 'agent') this.markDone(seat);
      return '已记录。';
    }

    private discussAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
      const ph = this.phase!;
      const req = ph.pending[String(seat)];
      if (!req) throw invalidAction('你不参与本环节。');
      if (ph.openedAt === null) throw invalidAction('本环节尚未开放，请稍后。');
      const d = ph.data as { counts: Record<string, number>; passed: Seat[]; last: Seat };
      if (d.passed.includes(seat)) throw invalidAction('你本幕已经结束发言了。');
      if (input.action === 'end_speech' || input.action === 'skip') {
        d.passed.push(seat);
        req.done = true;
        return '你结束了本幕发言。';
      }
      if (input.action !== 'speech') throw invalidAction(`讨论环节可执行：speech（发言）、end_speech（过）、ask（问 DM）${this.state.search ? '、share（公开线索）' : ''}。`);
      const max = this.options.discuss_max_msgs;
      const used = d.counts[String(seat)] ?? 0;
      if (used >= max) throw invalidAction(`你本幕已经说了 ${max} 条，等下一幕吧。`);
      if (meta.via === 'agent' && d.last === seat) {
        throw invalidAction('你刚刚说过，等别人接话后再说；没有要说的就 end_speech（过）。');
      }
      let text = cleanSpeech(String(input.text ?? ''));
      // AI 常把「过」写在发言末尾而不调用 end_speech：记下发言，再按「过」处理（真人由 manager 拆分）
      let endAfter = false;
      if (meta.via === 'agent') {
        const sp = splitTrailingEnd(text);
        if (sp.end && sp.body) {
          text = sp.body;
          endAfter = true;
        }
      }
      if (!text) throw invalidAction('发言不能为空。');
      this.recordSpeech(seat, text);
      d.counts[String(seat)] = used + 1;
      d.last = seat;
      // 说完先「完成」，别人接话后再重新开放；这样 AI 不会连续自说自话，全员都说完或「过」才结束
      req.done = true;
      for (const r of Object.values(ph.pending)) {
        if (r.seat === seat || d.passed.includes(r.seat) || (d.counts[String(r.seat)] ?? 0) >= max) continue;
        r.done = false;
      }
      if (endAfter) {
        d.passed.push(seat);
        return '已记录，并结束了你本幕的发言。';
      }
      const left = max - used - 1;
      return left > 0 ? `已记录（本幕还能说 ${left} 条）。` : '已记录（本幕发言次数已用完）。';
    }

    private ask(seat: Seat, input: ActionInput): string {
      const q = cleanSpeech(String(input.text ?? ''));
      if (!q) throw invalidAction('提问内容不能为空：act({"action":"ask","text":"你的问题"})。');
      const used = this.state.asks[String(seat)] ?? 0;
      if (used >= this.options.ask_limit) throw invalidAction(`本幕提问次数已用完（${this.options.ask_limit} 次）。`);
      this.state.asks[String(seat)] = used + 1;
      const entry: QA = { act: this.state.act, from: seat, q };
      this.state.qa.push(entry);
      const host = this.state.host;
      if (host) {
        this.tell(host, `❓ ${this.roleLabel(seat)} 私下问你：${q}\n（用 act({"action":"answer","target":${seat},"text":"…"}) 私下回答）`, { kind: 'question' });
        // 只叫醒 DM，不说是谁问的
        this.pushDelivery({ type: 'group', groupId: this.rec.groupId }, `${this.at(host)} 有玩家私下向 DM 提问，请调用 get_my_view 查看。`, 'prompt', 0, undefined, {
          mirror: true,
          keepAt: true,
        });
        return '已转交 DM，回答会私下发给你。';
      }
      const norm = normalizeText(q).toLowerCase();
      const hit = this.pack.faq.find((f) => f.keywords.some((k) => norm.includes(normalizeText(k).toLowerCase())));
      entry.a = hit ? hit.answer : '这个问题剧本里没有额外说明，请以你自己的剧本为准。';
      entry.by = 'faq';
      this.tell(seat, `🎭 DM：${entry.a}`, { kind: 'answer' });
      return `DM：${entry.a}`;
    }

    private hostAction(seat: Seat, input: ActionInput): string {
      const ph = this.phase;
      switch (input.action) {
        case 'speech': {
          const text = cleanSpeech(String(input.text ?? ''));
          if (!text) throw invalidAction('发言不能为空。');
          this.recordSpeech(seat, text, 'dm_speech', 'DM');
          return '已记录。';
        }
        case 'answer': {
          const target = input.target;
          if (!target || !this.playerSeats().includes(target)) throw invalidAction('answer 需要 target（提问玩家的座位号）。');
          const text = cleanSpeech(String(input.text ?? ''));
          if (!text) throw invalidAction('回答内容不能为空。');
          const open = [...this.state.qa].reverse().find((x) => x.from === target && x.a === undefined);
          if (open) {
            open.a = text;
            open.by = 'dm';
          }
          this.tell(target, `🎭 DM 回复你：${text}`, { kind: 'answer' });
          return `已私下回复 ${target}号。`;
        }
        case 'give': {
          if (!this.state.search) throw invalidAction('这个剧本没有线索卡。');
          const target = input.target;
          if (!target || !this.playerSeats().includes(target)) throw invalidAction('give 需要 target（玩家座位号）和 text（线索 id）。');
          const pool = this.pack.clues.filter((c) => this.obtainable(c, target));
          const c = this.resolveClue(String(input.text ?? ''), pool, '本轮已开放、还没被拿走的卡');
          this.grant(target, c, { dm: true });
          return `已把【${c.title}】交给 ${target}号。`;
        }
        case 'next': {
          if (!ph || !['intro', 'read', 'search', 'discuss'].includes(ph.key) || ph.openedAt === null) {
            throw invalidAction('只有自我介绍、阅读、搜证、讨论环节可以提前结束。');
          }
          for (const r of Object.values(ph.pending)) r.done = true;
          this.announce(`🎭 DM 宣布进入下一环节。`);
          return '已进入下一环节。';
        }
        case 'extend': {
          if (!ph || !['read', 'search', 'discuss'].includes(ph.key) || ph.deadline === null) throw invalidAction('只有阅读、搜证和讨论环节可以延长。');
          const used = Number(ph.data.extends ?? 0);
          if (used >= 2) throw invalidAction('本环节已经延长过 2 次了。');
          const mins = Math.min(5, Math.max(1, Math.trunc(Number(input.number ?? 2))));
          ph.data.extends = used + 1;
          ph.deadline += mins * 60_000;
          ph.timeoutMs += mins * 60_000;
          this.announce(`🎭 DM 将「${ph.title}」延长 ${mins} 分钟。`);
          return `已延长 ${mins} 分钟。`;
        }
        default:
          throw invalidAction('DM 可执行：speech（发言）、answer（私下回答）、give（发线索，target+text）、next（进入下一环节）、extend（延长，number=分钟）。');
      }
    }

    protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
      const ph = this.phase!;
      if (ph.key === 'intro' && !ph.data.spoke) this.announce(`⏰ ${this.label(seat)} 超时未做自我介绍。`);
      if (ph.key === 'vote') (ph.data.votes as Record<string, number>)[String(seat)] ??= 0;
    }

    // ───────────────────────── 视角 ─────────────────────────

    privateView(seat: Seat): Record<string, unknown> {
      const s = this.state;
      const ended = this.rec.status === 'ended';
      if (seat === s.host) {
        const ph = this.phase;
        return {
          role: 'DM',
          note: '你是 DM：不扮演角色，不能透露真相、不能替玩家推理。可以串场、私下回答提问、掌握节奏。',
          dm_actions: [
            'speak({"text":"…"}) 在群里说话',
            'act({"action":"answer","target":3,"text":"…"}) 私下回答 3 号的提问',
            'act({"action":"next"}) 提前结束当前的自我介绍/阅读/讨论环节',
            'act({"action":"extend","number":2}) 把当前阅读/搜证/讨论环节延长 2 分钟（每环节最多 2 次）',
            ...(s.search ? ['act({"action":"give","target":3,"text":"线索id"}) 把一张已开放的线索交给 3 号（不花点数）'] : []),
          ],
          open_questions: s.qa.filter((x) => x.a === undefined).map((x) => ({ from: x.from, role: this.roleOf(x.from)?.name, question: x.q })),
          current: ph ? { key: ph.key, title: ph.title, seconds_left: ph.deadline === null ? null : Math.max(0, Math.round((ph.deadline - this.now()) / 1000)) } : null,
          host_notes: s.pack.host_notes,
          truth: s.pack.truth,
          culprits: this.playerSeats().filter((x) => this.isCulprit(x)).map((x) => ({ seat: x, role: this.roleOf(x)!.name })),
          cast: this.playerSeats().map((x) => {
            const r = this.roleOf(x)!;
            return { seat: x, name: this.player(x).name, role: r.name, script: r.script, confession: r.confession || undefined };
          }),
          acts: s.pack.acts.map((a, i) => ({
            title: a.title,
            unlocked: i < s.unlocked,
            public: a.public,
            private: a.private,
            ...(a.public_images.length || Object.keys(a.private_images).length ? { public_images: a.public_images, private_images: a.private_images } : {}),
          })),
          ...(s.pack.images.length ? { images: s.pack.images.map((x) => ({ id: x.id, caption: x.caption })) } : {}),
          faq: s.pack.faq,
          ...(s.search
            ? {
                search: {
                  points_left: Object.fromEntries(this.playerSeats().map((x) => [x, s.search!.left[String(x)] ?? 0])),
                  opened_rounds: [...s.search.opened],
                  clues: s.pack.clues.filter((c) => this.clueOn(c)).map((c) => ({
                    id: c.id,
                    title: c.title,
                    at: c.at ? this.placeName(c.at) : undefined,
                    round: c.round,
                    cost: c.cost,
                    text: c.text,
                    holders: s.search!.holders[c.id] ?? [],
                    shared: s.search!.shared.some((x) => x.id === c.id),
                  })),
                },
              }
            : {}),
          ...(s.pack.questionnaire.length ? { questionnaire: s.pack.questionnaire, quiz_answers: ph?.key === 'quiz' ? ph.data.answers : s.quiz?.answers } : {}),
        };
      }
      const r = this.roleOf(seat);
      if (!r) return {};
      const confessing = this.isCulprit(seat) && (ended || this.rec.log.some((e) => e.kind.startsWith('confession:') && e.audience.type === 'seats' && e.audience.seats.includes(seat)));
      return {
        role: { key: r.key, name: r.name, public: r.public },
        script: r.script,
        ...(r.images.length ? { script_images: this.imageCaptions(r.images) } : {}),
        acts: s.pack.acts.slice(0, s.unlocked).map((a) => {
          const imgs = this.imageCaptions(a.private_images[r.key] ?? []);
          return { title: a.title, text: a.private[r.key] ?? '（本幕没有新剧本）', ...(imgs.length ? { images: imgs } : {}) };
        }),
        ...(confessing && r.confession ? { confession: r.confession } : {}),
        my_questions: s.qa.filter((x) => x.from === seat).map((x) => ({ question: x.q, answer: x.a ?? '（等待 DM 回答）' })),
        asks_left: Math.max(0, this.options.ask_limit - (s.asks[String(seat)] ?? 0)),
        how_to_ask: 'act({"action":"ask","text":"你的问题"}) 私下问 DM',
        ...(s.search ? { search: this.searchView(seat) } : {}),
        ...(this.quizFor(seat).length && (this.phase?.key === 'quiz' || s.quiz) ? { questionnaire: this.quizView(seat) } : {}),
      };
    }

    private searchView(seat: Seat): Record<string, unknown> {
      const sx = this.sx;
      const searching = this.phase?.key === 'search';
      return {
        points_left: sx.left[String(seat)] ?? 0,
        ...(searching ? { this_round: this.allowance(seat) } : {}),
        places: this.places(seat).map((p) => {
          const left = this.remaining(p.key, seat);
          return { key: p.key, name: p.name, left: left.length, cards: left.map((c) => c.title) };
        }),
        my_cards: this.held(seat).map((c) => ({
          id: c.id,
          title: c.title,
          text: c.text,
          ...(c.images.length ? { images: this.imageCaptions(c.images) } : {}),
          shared: sx.shared.some((x) => x.id === c.id),
          ...(this.deepKids(seat, c).length ? { can_deep: true } : {}),
        })),
        how_to: [
          '搜证环节：act({"action":"search","text":"地点 key"}) 或 act({"action":"search","target":3}) 搜 3 号；act({"action":"deep","text":"线索id"}) 深入；act({"action":"skip"}) 结束本轮',
          '任何时候：act({"action":"share","text":"线索id"}) 把自己的卡公开到群里',
        ],
      };
    }

    private quizView(seat: Seat): Record<string, unknown>[] {
      const ph = this.phase;
      const mine = (ph?.key === 'quiz' ? (ph.data.answers as Record<string, Record<string, string>>) : this.state.quiz?.answers ?? {})[String(seat)] ?? {};
      return this.quizFor(seat).map(({ no, q }) => ({
        no,
        id: q.id,
        question: q.question,
        points: q.points,
        options: this.quizOptions(q),
        my_answer: mine[q.id] ?? null,
        ...(this.state.quiz ? { correct: q.answer } : {}),
      }));
    }

    publicView(): Record<string, unknown> {
      const s = this.state;
      const ph = this.phase;
      const ended = this.rec.status === 'ended';
      return {
        script: { id: s.pack.id, title: s.pack.title, acts: s.pack.acts.length },
        dm: s.host ? { seat: s.host, name: this.player(s.host).name } : null,
        cast: this.playerSeats().map((x) => {
          const r = this.roleOf(x)!;
          return { seat: x, name: this.player(x).name, role: r.name, public: r.public };
        }),
        act: s.act >= 0 && s.act < s.pack.acts.length ? { index: s.act + 1, title: s.pack.acts[s.act]!.title } : null,
        stage: ph ? ph.title : null,
        discussion:
          ph?.key === 'discuss'
            ? {
                messages_left: Object.fromEntries(this.playerSeats().map((x) => [x, Math.max(0, this.options.discuss_max_msgs - ((ph.data.counts as Record<string, number>)[String(x)] ?? 0))])),
                passed: [...(ph.data.passed as Seat[])],
              }
            : null,
        ...(s.search
          ? {
              search: {
                places: this.places(null).map((p) => ({ key: p.key, name: p.name, left: this.remaining(p.key, null).length })),
                log: s.search.log.map((x) => ({ seat: x.seat, place: x.place, how: x.how })),
                shared: s.search.shared.map((x) => {
                  const c = this.clueById(x.id)!;
                  return { by: x.by, id: c.id, title: c.title, text: c.text, ...(c.images.length ? { images: this.imageCaptions(c.images) } : {}) };
                }),
              },
            }
          : {}),
        ...(ph?.key === 'quiz' ? { questionnaire: this.pack.questionnaire.map((q, i) => ({ no: i + 1, question: q.question, points: q.points, options: this.quizOptions(q) })) } : {}),
        ...(s.outcome && s.quiz
          ? {
              quiz: { scores: Object.fromEntries(this.playerSeats().map((x) => [x, s.quiz!.scores[String(x)] ?? 0])), mvp: s.outcome.top },
              ...(s.quiz.hasCulpritQ ? { solved: s.outcome.solved } : {}),
            }
          : s.outcome
            ? {
                votes: Object.fromEntries(this.playerSeats().map((x) => [x, s.votes[String(x)] || '弃票'])),
                solved: s.outcome.solved,
              }
            : {}),
        ...(ended ? { truth: s.pack.truth, culprits: this.playerSeats().filter((x) => this.isCulprit(x)) } : {}),
      };
    }

    // ───────────────────────── 真人指令 / 模拟 ─────────────────────────

    override parseCommand(seat: Seat, text: string, channel: 'group' | 'private'): ActionInput | null {
      const raw = text.trim();
      const t = stripTrailing(normalizeText(raw));
      const askM = raw.match(/^(?:问\s*DM|@?DM|问主持人?|问dm)\s*[:：,，]?\s*(.+)$/isu);
      const host = seat === this.state.host;
      if (host) {
        const ans = raw.match(/^(?:回复|回答|答)\s*(\d{1,2})\s*号?\s*[:：,，]?\s*(.+)$/su);
        if (ans) return { action: 'answer', target: Number(ans[1]), text: ans[2]! };
        if (/^(下一步|下一环节|进入下一环节|推进)$/u.test(t)) return { action: 'next' };
        const give = raw.match(/^(?:给|交给|发给)\s*(\d{1,2})\s*号?\s*[:：,，]?\s*(?:线索)?\s*(.+)$/su);
        if (give && this.state.search) return { action: 'give', target: Number(give[1]), text: give[2]!.trim() };
        const ext = t.match(/^延长\s*(\d)?\s*分钟?$/u);
        if (ext) return { action: 'extend', number: Number(ext[1] ?? 2) };
        return channel === 'group' && cleanSpeech(raw) ? { action: 'speech', text: raw } : null;
      }
      if (askM && cleanSpeech(askM[1]!)) return { action: 'ask', text: askM[1]! };
      const shareM = raw.match(/^(?:公开|亮出|出示)\s*(?:线索)?\s*(.+)$/su);
      if (shareM && this.state.search && this.held(seat).length) return { action: 'share', text: shareM[1]!.trim() };
      const ph = this.phase;
      if (!ph) return null;
      const req = ph.pending[String(seat)];
      if (!req) return null;
      if (ph.key === 'search') {
        if (req.done) return null;
        if (/^(搜完了|搜完|不搜了|结束搜证)$/u.test(t) || isSkipWord(t)) return { action: 'skip' };
        const deep = raw.match(/^深入\s*(?:调查)?\s*(.+)$/su);
        if (deep) return { action: 'deep', text: deep[1]!.trim() };
        const sm = raw.match(/^(?:搜证|搜查|搜索|搜)\s*(.+)$/su);
        if (!sm) return null;
        const arg = sm[1]!.trim();
        const seatM = normalizeText(arg).match(/^(\d{1,2})\s*号?$/u);
        return seatM ? { action: 'search', target: Number(seatM[1]) } : { action: 'search', text: arg };
      }
      if (ph.key === 'quiz') {
        if (channel !== 'private') return null;
        const m = normalizeText(raw).trim().match(/^第?\s*(\d{1,2})\s*题?\s*[:：,，.、\s]\s*(.+)$/su);
        return m ? { action: 'answer_q', text: `${m[1]}:${m[2]!.trim()}` } : null;
      }
      if (ph.key === 'read') return !req.done && /^(读完|已读|读完了|看完|看完了|好了|ok|过)$/iu.test(t) ? { action: 'ready' } : null;
      if (ph.key === 'vote') {
        if (req.done) return null;
        if (/^(弃票|弃权|不投)$/u.test(t) || isSkipWord(t)) return { action: 'skip' };
        const m = t.match(/^(?:我)?(?:投票给|投票|投给|投|票给|票)\s*(.+)$/u);
        const target = m ? resolveSeat(m[1]!, this.players) : null;
        return target === null ? null : { action: 'vote', target };
      }
      if (channel !== 'group') return null;
      if (ph.key === 'discuss') {
        if ((ph.data.passed as Seat[]).includes(seat)) return null;
        if (isEndSpeech(raw)) return { action: 'end_speech' };
        return cleanSpeech(raw) ? { action: 'speech', text: raw } : null;
      }
      if (ph.key === 'intro' || ph.key === 'confess') {
        if (req.done) return null;
        if (isEndSpeech(raw)) return { action: 'end_speech' };
        return cleanSpeech(raw) ? { action: 'speech', text: raw } : null;
      }
      return null;
    }

    override randomAction(seat: Seat): ActionInput | null {
      const ph = this.phase;
      const req = this.pendingOf(seat);
      if (!ph || !req) return null;
      if (ph.key === 'read') return { action: 'ready' };
      if (ph.key === 'search') {
        const allow = this.allowance(seat);
        const spots = this.places(seat).filter((p) => this.remaining(p.key, seat).some((c) => c.cost <= allow));
        return spots.length && this.rng.int(5) > 0 ? { action: 'search', text: spots[this.rng.int(spots.length)]!.key } : { action: 'skip' };
      }
      if (ph.key === 'quiz') {
        const answers = (ph.data.answers as Record<string, Record<string, string>>)[String(seat)] ?? {};
        const todo = this.quizFor(seat).find((x) => !answers[x.q.id]);
        if (!todo) return null;
        const opts = this.quizOptions(todo.q);
        return { action: 'answer_q', text: `${todo.no}:${opts[this.rng.int(opts.length)]!.key}` };
      }
      if (ph.key === 'vote') {
        const targets = req.actions.find((a) => a.action === 'vote')?.targets ?? [];
        return targets.length && this.rng.int(6) > 0 ? { action: 'vote', target: targets[this.rng.int(targets.length)]! } : { action: 'skip' };
      }
      if (ph.key === 'discuss' && this.rng.int(3) === 0) return { action: 'end_speech' };
      return { action: 'speech', text: CANNED[this.rng.int(CANNED.length)]! };
    }
  }

  return {
    type: 'jubensha',
    name: '剧本杀',
    aliases: ['剧本杀', '剧本', 'jbs', 'murder', 'murdermystery'],
    idPrefix: 'JB',
    minPlayers: 2,
    maxPlayers: 13,
    summary: '按私有剧本数据包进行的剧本杀：程序选角、分幕发剧本、计时、计票、公布真相；可请一位玩家担任 DM 串场答疑。',
    rules: RULES,
    playerTips: TIPS,
    stages: ['group', 'web'],
    optionsSchema: optionsSchema.transform((o) => {
      const pack = resolvePack(o);
      // 开房时锁定默认/唯一剧本，避免默认切换后大厅人数与实际开局不同。
      return typeof pack === 'string' ? o : { ...o, script: pack.id };
    }),
    playerLimits(o, lobby) {
      const pack = resolvePack(o);
      if (typeof pack === 'string') return { min: 2, max: 13 };
      return { min: pack.players, max: pack.players + (pickHost(o.host, lobby) ? 1 : 0) };
    },
    optionsHelp: {
      ...commonOptionsHelp,
      script: '剧本编号（剧本库里只有一个剧本、或管理员设了默认剧本时可以不填）',
      host: 'DM 的 QQ 号或昵称；可以用逗号分隔写多个候选，按顺序取第一个报了名的当 DM，其余候选照常当玩家。DM 不扮演角色、负责主持答疑（报名人数要比剧本人数多 1）；不填、没人报名或人数不是剧本人数 +1 时由程序主持',
      cast: '指定选角 {"QQ号":"角色key"}；没指定的随机分配',
      intro_timeout_s: '自我介绍每人限时（秒，默认 120）',
      read_timeout_s: '每幕阅读限时（秒，默认 120）',
      discuss_minutes: '每幕自由讨论时长（分钟，默认 8；剧本里可按幕单独设置）',
      discuss_max_msgs: '自由讨论每人每幕最多几条（默认 6）',
      vote_timeout_s: '投票限时（秒，默认 120）',
      confess_timeout_s: '凶手坦白限时（秒，默认 180）',
      ask_limit: '每人每幕最多私下问 DM 几次（默认 3）',
      search_timeout_s: '搜证环节限时（秒，默认 300；剧本里可按幕单独设置）',
      quiz_timeout_s: '问卷作答限时（秒，默认 300）',
      clue_level: '线索难度：normal（默认，发难度卡、不发提示卡）或 easy（发提示卡、不发难度卡）',
      reveal_unfound: '结束时公布没被搜到的线索（默认 true）',
      stage: '舞台：web（默认，在网页「灯下剧场」上玩：只有 AI 上场，剧本和线索在网页上看，群里同步发言和环节提示，开局时发观战链接）或 group（在 QQ 群里玩，真人也能上场）',
    },
    // 只保护真正会当 DM 的那位（报了名的第一个候选），其他候选照常可以被抽去当裁判
    mustPlay: (o, lobby) => {
      const h = pickHost(o.host, lobby);
      return h ? [h.id] : [];
    },
    checkStart(n, o, entries) {
      const pack = resolvePack(o);
      if (typeof pack === 'string') return pack;
      const hostEntry = entries ? pickHost(o.host, entries) : undefined;
      if (hostEntry && n === pack.players + 1) {
        // 有 DM
      } else if (n !== pack.players) {
        return `《${pack.title}》需要 ${pack.players} 名玩家${o.host ? `（另加 DM ${hostEntry ? hostEntry.name : hostCandidates(o.host).join('/')} 共 ${pack.players + 1} 人）` : ''}，当前报名 ${n} 人。`;
      }
      const keys = new Set(pack.roles.map((r) => r.key));
      const used = new Set<string>();
      for (const [id, k] of Object.entries(o.cast)) {
        if (!keys.has(k)) return `cast 里的角色 ${k} 不在《${pack.title}》中。可用角色：${pack.roles.map((r) => `${r.key}（${r.name}）`).join('、')}`;
        if (used.has(k)) return `cast 里角色 ${k} 被指定了不止一次。`;
        used.add(k);
        if (hostEntry && hostEntry.id === id) return 'DM 不扮演角色，不能在 cast 里给 DM 指定角色。';
      }
      return null;
    },
    create: (rec, env) => new JubenshaGame(rec, env),
  };
}
