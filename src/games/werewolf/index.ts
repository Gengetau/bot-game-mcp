/**
 * 狼人杀 —— 经典身份推理游戏。
 *
 * 身份分配、夜间结算、投票、胜负全部由程序决定（this.rng）；AI 裁判只负责拉取消息并转发真人文字。
 * 所有状态都在 rec.state / rec.phase.data 中（可序列化）；流程由 state.agenda（步骤队列）驱动。
 */
import { z } from 'zod';
import { invalidAction } from '../../core/errors.js';
import { BaseGame, type PhaseRequestSpec } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { pick, shuffle } from '../../core/rng.js';
import {
  cleanSpeech,
  isEndSpeech,
  isSkipWord,
  normalizeText,
  resolveSeat,
  stripTrailing,
} from '../../core/text.js';
import type { ActionInput, ActionMeta, ActionSpec, PendingRequest, Seat } from '../../core/types.js';

// ───────────────────────── 选项 ─────────────────────────

const ROLE_KEYS = ['werewolf', 'villager', 'seer', 'witch', 'hunter', 'guard', 'idiot'] as const;
export type Role = (typeof ROLE_KEYS)[number];

const cnt = () => z.number().int().min(0).max(16).default(0);

const optionsSchema = z.object({
  ...commonOptionShape,
  roles: z
    .object({
      werewolf: cnt(),
      villager: cnt(),
      seer: cnt(),
      witch: cnt(),
      hunter: cnt(),
      guard: cnt(),
      idiot: cnt(),
    })
    .optional(),
  win_mode: z.enum(['side', 'all']).default('side'),
  witch_self_save: z.enum(['first_night', 'never', 'always']).default('first_night'),
  first_night_last_words: z.boolean().default(true),
  night_timeout_s: secondsOption(60),
  witch_timeout_s: secondsOption(40),
  speech_timeout_s: secondsOption(90),
  vote_timeout_s: secondsOption(45),
  last_words_timeout_s: secondsOption(60),
  hunter_timeout_s: secondsOption(30),
  pk_speech_timeout_s: secondsOption(60),
  night_min_s: z.number().int().min(0).max(300).default(20),
});

export type WerewolfOptions = z.infer<typeof optionsSchema>;

const PRESETS: Record<number, Partial<Record<Role, number>>> = {
  6: { werewolf: 2, seer: 1, witch: 1, villager: 2 },
  7: { werewolf: 2, seer: 1, witch: 1, hunter: 1, villager: 2 },
  8: { werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 },
  9: { werewolf: 3, seer: 1, witch: 1, hunter: 1, villager: 3 },
  10: { werewolf: 3, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 3 },
  11: { werewolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 3 },
  12: { werewolf: 4, seer: 1, witch: 1, hunter: 1, guard: 1, villager: 4 },
};

const ROLE_NAME: Record<Role, string> = {
  werewolf: '狼人',
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  idiot: '白痴',
};
const GODS: Role[] = ['seer', 'witch', 'hunter', 'guard', 'idiot'];

const ABILITY: Record<Role, string> = {
  werewolf: '每晚与狼队友商量并选择一名玩家袭击（可空刀）；白天隐藏身份，帮狼队赢。',
  villager: '没有特殊技能，白天通过发言与投票找出狼人。',
  seer: '每晚可查验一名玩家（不含自己）是「好人」还是「狼人」。',
  witch: '拥有一瓶解药和一瓶毒药（各限一次，同一晚最多用一瓶）。解药可救当晚被刀的人，毒药可毒杀任意一人。',
  hunter: '被狼人刀杀或被放逐出局时，可开枪带走一名玩家；被女巫毒死则不能开枪；若这次死亡已使某一方满足胜利条件，游戏立即结束，不能开枪。',
  guard: '每晚可守护一名玩家（可守自己），使其不被狼人刀杀；不能连续两晚守护同一人。同守同救则目标仍会死亡。',
  idiot: '被放逐时翻牌公开身份且不会死亡，但此后永远失去投票权；其他方式死亡与常人相同。',
};

const HUMAN_CMDS: Record<Role, string> = {
  werewolf: '夜间私聊我：「刀3」选择袭击目标，「空刀」放弃；夜间发其他任意文字会转发给狼队友。',
  villager: '白天按提示在群里发言（说完发「过」），投票发「投3」或「弃票」。',
  seer: '夜间私聊我：「验3」查验 3 号。',
  witch: '夜间私聊我：「救」使用解药，「毒3」毒杀 3 号，「不用」跳过。',
  hunter: '死亡时按提示发：「开枪3」带走 3 号，或「不开枪」。',
  guard: '夜间私聊我：「守3」守护 3 号，「空守」放弃。',
  idiot: '白天按提示发言、投票；被放逐时会自动翻牌。',
};

const teamOf = (r: Role) => (r === 'werewolf' ? '狼人阵营' : '好人阵营');

// ───────────────────────── 状态 ─────────────────────────

type Step =
  | { t: 'night'; n: number }
  | { t: 'witch' }
  | { t: 'dawn' }
  | { t: 'last_words'; seat: Seat }
  | { t: 'hunter'; seat: Seat }
  | { t: 'discussion' }
  | { t: 'speech'; seat: Seat }
  | { t: 'vote' }
  | { t: 'pk_speech'; seat: Seat }
  | { t: 'pk_vote'; tied: Seat[] };

type Cause = 'wolf' | 'poison' | 'exile' | 'shot';

interface VoteRecord {
  day: number;
  kind: 'vote' | 'pk_vote';
  votes: Record<string, number>;
  abstain: Seat[];
  result: string;
}

export interface WerewolfState {
  roles: Record<string, Role>;
  config: Record<Role, number>;
  potions: Record<string, { antidote: boolean; poison: boolean }>;
  lastGuard: Record<string, number>;
  seerResults: Record<string, { night: number; target: Seat; wolf: boolean }[]>;
  deaths: Record<string, string>;
  poisoned: Seat[];
  idiotRevealed: Seat[];
  agenda: Step[];
  speeches: { seat: Seat; kind: string; text: string }[];
  voteLog: VoteRecord[];
  order: Seat[];
  tonight: { victim: number; guarded: Seat[]; saved: boolean; poisons: Seat[] };
  quiet: number;
}

const SPEECH_KEYS = new Set(['speech', 'last_words', 'pk_speech']);
const CANNED = ['我是好人，大家再听听后面的发言。', '目前信息不多，我先划水，请大家多给点线索。', '我觉得有人的发言有点奇怪，先观察一下。', '过，听后面的。'];

const RULES = `## 狼人杀

**阵营**：狼人阵营（狼人）vs 好人阵营（村民 + 神职：预言家、女巫、猎人、守卫、白痴）。
**配置**：6~12 人有默认板子（6人：2狼 预 女 2民；7人：+猎人；8人：3狼；10人起加守卫……）；13~16 人或自定义需指定 \`roles\`。
**流程**：
1. 🌙 夜晚（秘密）：守卫守人 → 狼人刀人（多狼取最多票，平票随机，可空刀；提交后到阶段结束前可改刀，可用私聊密谈）→ 预言家验人（立即得知结果）。
2. 女巫：若有药，得知被刀的人（仅当还有解药时），可救 / 毒 / 不用，同夜最多用一瓶。
3. ☀️ 天亮：公布死亡名单（不说死因）或平安夜。被刀的人：被守或被救则活，**同守同救则死**。第一夜死者有遗言；猎人被刀死可开枪（被毒死不能）。**胜负判定优先**：若这次死亡已使某一方满足胜利条件，游戏立即结束，不再有猎人开枪和遗言。
4. 🗣 依次发言（随机玩家起顺时针，真人说完发「过」）→ 🗳 投票放逐得票最多者；平票则平票者 PK 发言，再由其他人投票，仍平票则无人出局。
5. 被放逐者有遗言；猎人可开枪；白痴被放逐则翻牌免死但失去投票权。同样，若放逐（或猎人开枪）已使某一方满足胜利条件，游戏立即结束，不再有猎人开枪和遗言。
**胜负**：狼人全灭 → 好人胜。\`win_mode=side\`（默认，屠边）：所有神职死光 或 所有村民死光 → 狼人胜；\`all\`（屠城）：所有好人死光 → 狼人胜。
**选项**：\`witch_self_save\`（first_night 默认/never/always）、\`first_night_last_words\`、各阶段超时（秒）、\`night_min_s\`（夜晚与女巫阶段最短时长，默认 20 秒，防止通过结算速度推断谁还活着；只要板子里有女巫，每晚都会开启女巫阶段，女巫死亡或药用完时只是空等）。
**超时**：未行动视为放弃（空刀/空守/不用药/弃票/过）。连续 6 个昼夜无人死亡视为平局。

**真人指令**：夜间私聊——狼人「刀3」「空刀」、预言家「验3」、守卫「守3」「空守」、女巫「救」「毒3」「不用」；白天——发言直接说，结束发「过」；投票「投3」「弃票」；猎人「开枪3」「不开枪」。
**bot 指令**：\`act({"action":"kill|check|guard|save|poison|vote|shoot|skip","target":N})\`；发言 \`speak({"text":"…"})\`；狼人夜间密谈 \`speak({"text":"…","channel":"team"})\`。`;

export class WerewolfGame extends BaseGame<WerewolfState, WerewolfOptions> {
  // ───────────────────────── 基础查询 ─────────────────────────

  private roleOf(seat: Seat): Role {
    return this.state.roles[String(seat)]!;
  }

  private seatsOfRole(role: Role, aliveOnly = true): Seat[] {
    return this.players.filter((p) => (!aliveOnly || p.alive) && this.roleOf(p.seat) === role).map((p) => p.seat);
  }

  private wolves(aliveOnly = true): Seat[] {
    return this.seatsOfRole('werewolf', aliveOnly);
  }

  private canVote(seat: Seat): boolean {
    return this.isAlive(seat) && !this.state.idiotRevealed.includes(seat);
  }

  private canShoot(seat: Seat): boolean {
    return !this.state.poisoned.includes(seat);
  }

  private others(seat: Seat, seats = this.aliveSeats()): Seat[] {
    return seats.filter((s) => s !== seat);
  }

  private seatList(seats: Seat[]): string {
    return seats.map((s) => `${s}号`).join('、');
  }

  private push(...steps: Step[]): void {
    this.state.agenda.unshift(...steps);
  }

  private configText(): string {
    return ROLE_KEYS.filter((r) => this.state.config[r] > 0)
      .map((r) => `${this.state.config[r]}${ROLE_NAME[r]}`)
      .join('、');
  }

  // ───────────────────────── 开局 ─────────────────────────

  start(): void {
    const n = this.players.length;
    const config = resolveRoles(n, this.options);
    if (typeof config === 'string') throw new Error(config);
    const list: Role[] = [];
    for (const r of ROLE_KEYS) for (let i = 0; i < config[r]; i++) list.push(r);
    const shuffled = shuffle(this.rng, list);
    const roles: Record<string, Role> = {};
    this.players.forEach((p, i) => (roles[String(p.seat)] = shuffled[i]!));
    const potions: WerewolfState['potions'] = {};
    for (const p of this.players) if (roles[String(p.seat)] === 'witch') potions[String(p.seat)] = { antidote: true, poison: true };
    Object.assign(this.rec.state, {
      roles,
      config,
      potions,
      lastGuard: {},
      seerResults: {},
      deaths: {},
      poisoned: [],
      idiotRevealed: [],
      agenda: [],
      speeches: [],
      voteLog: [],
      order: [],
      tonight: { victim: 0, guarded: [], saved: false, poisons: [] },
      quiet: 0,
    } satisfies WerewolfState);
    this.rec.round = 1;

    const mode = this.options.win_mode === 'side' ? '屠边（神职或村民全灭，狼人胜）' : '屠城（好人全灭，狼人胜）';
    this.announce(
      `🐺 狼人杀配置：共 ${n} 人，${this.configText()}。胜负规则：${mode}。\n` +
        `身份已由程序随机分配，请查看身份牌（真人看私聊，AI 看自己的视角）。天黑后开始第一夜。`,
    );
    const wolves = this.wolves();
    for (const p of this.players) {
      const r = roles[String(p.seat)]!;
      const cmds = p.kind === 'human' ? `\n${HUMAN_CMDS[r]}` : '';
      this.tell(p.seat, `🎴 你的身份是【${ROLE_NAME[r]}】（${teamOf(r)}）。\n技能：${ABILITY[r]}${cmds}`, {
        kind: 'role',
        category: 'role',
      });
    }
    for (const w of wolves) {
      const mates = this.others(w, wolves);
      this.tell(w, mates.length ? `🐺 你的狼队友：${mates.map((s) => this.label(s)).join('、')}。` : '🐺 本局只有你一只狼。', {
        category: 'role',
      });
    }
    this.state.agenda.push({ t: 'night', n: 1 });
    this.proceed();
  }

  // ───────────────────────── 流程推进 ─────────────────────────

  advance(): void {
    const ph = this.phase!;
    switch (ph.key) {
      case 'night':
        this.afterNight();
        break;
      case 'witch':
        this.afterWitch();
        break;
      case 'hunter':
        if (this.afterHunter()) return;
        break;
      case 'vote':
        if (this.tally(false)) return;
        break;
      case 'pk_vote':
        if (this.tally(true)) return;
        break;
      default:
        break;
    }
    if (this.rec.status === 'running') this.proceed();
  }

  private proceed(): void {
    for (let guard = 0; guard < 500; guard++) {
      if (this.rec.status !== 'running') return;
      const step = this.state.agenda.shift();
      if (!step) {
        this.state.agenda.push({ t: 'night', n: this.rec.round + 1 });
        continue;
      }
      if (this.runStep(step)) return;
    }
    throw new Error('werewolf: proceed loop overflow');
  }

  /** 返回 true 表示已开启阶段（或游戏结束）。 */
  private runStep(step: Step): boolean {
    switch (step.t) {
      case 'night':
        return this.openNight(step.n);
      case 'witch':
        return this.openWitch();
      case 'dawn':
        this.dawn();
        return this.rec.status !== 'running';
      case 'last_words':
        return this.openSpeech('last_words', step.seat);
      case 'speech':
        return this.openSpeech('speech', step.seat);
      case 'pk_speech':
        return this.openSpeech('pk_speech', step.seat);
      case 'hunter':
        return this.openHunter(step.seat);
      case 'discussion':
        this.startDiscussion();
        return false;
      case 'vote':
        return this.openVote(false, []);
      case 'pk_vote':
        return this.openVote(true, step.tied);
    }
  }

  private nightMinMs(): number {
    return this.options.night_min_s * 1000;
  }

  // ───────────────────────── 夜晚 ─────────────────────────

  private openNight(n: number): boolean {
    this.rec.round = n;
    this.state.quiet += 1;
    if (this.state.quiet > 6) {
      this.finish({
        winnerTeam: '平局',
        winnerSeats: [],
        reason: '连续 6 个昼夜无人死亡，判为平局',
        reveal: this.revealAll(),
      });
      return true;
    }
    const alive = this.aliveSeats();
    const requests: PhaseRequestSpec[] = [];
    for (const w of this.wolves()) {
      requests.push({
        seat: w,
        channel: 'private',
        prompt: `请选择今晚袭击的目标（可选任意存活玩家，也可空刀）。同伴的选择会实时告知你；你可在阶段结束前改刀，也可与队友密谈。`,
        actions: [
          this.specTarget('kill', '袭击', alive, '刀3'),
          this.specSkip('空刀', '空刀'),
          {
            action: 'team_chat',
            label: '狼队密谈',
            example: 'speak({"text":"今晚刀3号吧","channel":"team"})',
            command: '直接发任意非指令文字',
          },
        ],
      });
    }
    for (const g of this.seatsOfRole('guard')) {
      const last = this.state.lastGuard[String(g)] ?? 0;
      requests.push({
        seat: g,
        channel: 'private',
        prompt: `请选择今晚守护的玩家（可守自己）${last ? `，不能连续守护 ${last}号` : ''}，或空守。`,
        actions: [
          this.specTarget('guard', '守护', alive.filter((s) => s !== last), '守3'),
          this.specSkip('空守', '空守'),
        ],
      });
    }
    for (const s of this.seatsOfRole('seer')) {
      requests.push({
        seat: s,
        channel: 'private',
        prompt: `请选择今晚查验的玩家（不含自己），立即得知其为好人或狼人。`,
        actions: [this.specTarget('check', '查验', this.others(s, alive), '验3'), this.specSkip('不查验', '过')],
      });
    }
    this.announce(`🌙 第${n}夜降临，天黑请闭眼。有夜间能力的玩家请行动（限时 ${this.options.night_timeout_s} 秒）。`);
    this.openPhase({
      key: 'night',
      title: `第${n}夜`,
      requests,
      timeoutMs: this.options.night_timeout_s * 1000,
      secret: true,
      minDurationMs: this.nightMinMs(),
      data: { wolfVotes: {}, guard: {} },
    });
    return true;
  }

  private nightAction(seat: Seat, input: ActionInput): string {
    const ph = this.phase!;
    const a = input.action;
    const role = this.roleOf(seat);
    let req: PendingRequest | undefined = ph.pending[String(seat)];
    const resubmit = role === 'werewolf' && (a === 'kill' || a === 'skip') && req?.done && ph.openedAt !== null;
    if (!resubmit) req = this.requireTurn(seat, a);
    const data = ph.data as { wolfVotes: Record<string, number>; guard: Record<string, number> };

    if (role === 'werewolf') {
      let target = 0;
      if (a === 'kill') target = this.requireTarget(req!, 'kill', input.target);
      else if (a !== 'skip') throw invalidAction('狼人夜间可执行：kill（袭击）、skip（空刀）、team_chat（密谈）。');
      data.wolfVotes[String(seat)] = target;
      this.markDone(seat);
      const text = target ? `刀 ${target}号` : '空刀';
      this.tellMany(this.others(seat, this.wolves()), `🐺 ${this.label(seat)} 选择：${text}。`);
      return `已提交：${text}（阶段结束前可改刀）。`;
    }
    if (role === 'guard') {
      let target = 0;
      if (a === 'guard') target = this.requireTarget(req!, 'guard', input.target);
      else if (a !== 'skip') throw invalidAction('守卫夜间可执行：guard（守护）、skip（空守）。');
      data.guard[String(seat)] = target;
      this.markDone(seat);
      return target ? `你今晚守护 ${target}号。` : '你选择了空守。';
    }
    if (role === 'seer') {
      if (a === 'skip') {
        this.markDone(seat);
        return '你今晚没有查验。';
      }
      if (a !== 'check') throw invalidAction('预言家夜间可执行：check（查验）、skip。');
      const target = this.requireTarget(req!, 'check', input.target);
      const wolf = this.roleOf(target) === 'werewolf';
      const list = (this.state.seerResults[String(seat)] ??= []);
      list.push({ night: this.rec.round, target, wolf });
      this.markDone(seat);
      const msg = `🔮 查验结果：${target}号 是【${wolf ? '狼人' : '好人'}】。`;
      this.tell(seat, msg, { kind: 'info' });
      return msg;
    }
    throw invalidAction('你今晚没有可执行的动作。');
  }

  private teamChat(seat: Seat, input: ActionInput): string {
    const ph = this.phase;
    if (!ph || ph.key !== 'night' || ph.openedAt === null) throw invalidAction('只有夜晚阶段狼人才能密谈。');
    if (!this.isAlive(seat) || this.roleOf(seat) !== 'werewolf') throw invalidAction('只有存活的狼人可以密谈。');
    const text = cleanSpeech(input.text ?? '', 300);
    if (!text) throw invalidAction('密谈内容不能为空。');
    const mates = this.others(seat, this.wolves());
    this.tellMany(mates, `🐺 ${this.label(seat)}（密谈）：${text}`, { kind: 'team_chat' });
    return mates.length ? '已发送给狼队友。' : '你没有存活的队友。';
  }

  private afterNight(): void {
    const ph = this.phase!;
    const data = ph.data as { wolfVotes: Record<string, number>; guard: Record<string, number> };
    const counts = new Map<number, number>();
    for (const t of Object.values(data.wolfVotes)) if (t > 0) counts.set(t, (counts.get(t) ?? 0) + 1);
    let victim = 0;
    if (counts.size > 0) {
      const top = Math.max(...counts.values());
      const tied = [...counts.entries()].filter(([, c]) => c === top).map(([s]) => s).sort((a, b) => a - b);
      victim = tied.length === 1 ? tied[0]! : pick(this.rng, tied);
    }
    const guarded: Seat[] = [];
    for (const g of this.seatsOfRole('guard')) {
      const t = data.guard[String(g)] ?? 0;
      this.state.lastGuard[String(g)] = t;
      if (t > 0) guarded.push(t);
    }
    this.state.tonight = { victim, guarded, saved: false, poisons: [] };
    this.push({ t: 'witch' }, { t: 'dawn' });
  }

  // ───────────────────────── 女巫 ─────────────────────────

  private selfSaveOk(seat: Seat, victim: number): boolean {
    if (victim !== seat) return true;
    const rule = this.options.witch_self_save;
    return rule === 'always' || (rule === 'first_night' && this.rec.round === 1);
  }

  private openWitch(): boolean {
    // 板子里只要有女巫，每晚都开启女巫阶段（女巫死亡/药用完时 requests 为空），
    // 否则公开的阶段名与倒计时会泄露女巫是否存活、是否还有药。
    if (this.state.config.witch <= 0) return false;
    const t = this.state.tonight;
    const alive = this.aliveSeats();
    const requests: PhaseRequestSpec[] = [];
    for (const w of this.seatsOfRole('witch')) {
      const p = this.state.potions[String(w)]!;
      if (!p.antidote && !p.poison) continue;
      const actions: ActionSpec[] = [];
      let info: string;
      if (p.antidote) info = t.victim ? `今晚 ${t.victim}号 被狼人袭击。` : '今晚无人被狼人袭击（平安夜）。';
      else info = '你的解药已用完，无法得知今晚谁被袭击。';
      if (p.antidote && t.victim && this.selfSaveOk(w, t.victim)) {
        actions.push({ action: 'save', label: '使用解药', example: 'act({"action":"save"})', command: '救' });
      } else if (p.antidote && t.victim) info += '（按规则你不能自救。）';
      if (p.poison) actions.push(this.specTarget('poison', '使用毒药', this.others(w, alive), '毒3'));
      actions.push(this.specSkip('不用药', '不用'));
      requests.push({
        seat: w,
        channel: 'private',
        prompt: `${info}你要使用药水吗？（同一晚最多用一瓶）`,
        actions,
      });
    }
    this.openPhase({
      key: 'witch',
      title: `第${this.rec.round}夜·女巫`,
      requests,
      timeoutMs: this.options.witch_timeout_s * 1000,
      secret: true,
      minDurationMs: this.nightMinMs(),
      data: { choices: {} },
    });
    return true;
  }

  private witchAction(seat: Seat, input: ActionInput): string {
    const req = this.requireTurn(seat, input.action);
    const ph = this.phase!;
    const choices = ph.data.choices as Record<string, { save?: boolean; poison?: number }>;
    const p = this.state.potions[String(seat)]!;
    if (input.action === 'save') {
      p.antidote = false;
      choices[String(seat)] = { save: true };
      this.markDone(seat);
      return `你使用了解药，救下 ${this.state.tonight.victim}号。`;
    }
    if (input.action === 'poison') {
      const target = this.requireTarget(req, 'poison', input.target);
      p.poison = false;
      choices[String(seat)] = { poison: target };
      this.markDone(seat);
      return `你对 ${target}号 使用了毒药。`;
    }
    if (input.action === 'skip') {
      choices[String(seat)] = {};
      this.markDone(seat);
      return '你今晚没有用药。';
    }
    throw invalidAction('女巫可执行：save、poison、skip。');
  }

  private afterWitch(): void {
    const choices = (this.phase!.data.choices ?? {}) as Record<string, { save?: boolean; poison?: number }>;
    const t = this.state.tonight;
    for (const c of Object.values(choices)) {
      if (c.save) t.saved = true;
      if (c.poison) t.poisons.push(c.poison);
    }
  }

  // ───────────────────────── 天亮与死亡 ─────────────────────────

  private markDead(seat: Seat, cause: Cause, when: string): void {
    this.player(seat).alive = false;
    this.state.deaths[String(seat)] = when;
    if (cause === 'poison') this.state.poisoned.push(seat);
    this.state.quiet = 0;
  }

  private dawn(): void {
    const n = this.rec.round;
    const t = this.state.tonight;
    const dead = new Map<number, Cause>();
    if (t.victim > 0) {
      const guarded = t.guarded.includes(t.victim);
      if (guarded === t.saved) dead.set(t.victim, 'wolf');
    }
    for (const p of t.poisons) dead.set(p, 'poison');
    for (const s of [...dead.keys()]) if (!this.isAlive(s)) dead.delete(s);
    const deaths = [...dead.entries()].map(([seat, cause]) => ({ seat, cause })).sort((a, b) => a.seat - b.seat);
    this.state.speeches = [];
    this.state.order = [];
    this.state.tonight = { victim: 0, guarded: [], saved: false, poisons: [] };
    for (const d of deaths) this.markDead(d.seat, d.cause, `第${n}夜`);
    this.announce(
      deaths.length === 0
        ? `☀️ 第${n}天，天亮了。昨夜是平安夜，无人死亡。`
        : `☀️ 第${n}天，天亮了。昨夜死亡的玩家：${deaths.map((d) => this.label(d.seat)).join('、')}。`,
      { kind: 'death', data: { seats: deaths.map((d) => d.seat) } },
    );
    if (this.checkWin()) return;
    this.push({ t: 'discussion' });
    this.afterDeaths(deaths, n === 1 && this.options.first_night_last_words);
  }

  private afterDeaths(deaths: { seat: Seat; cause: Cause }[], lastWords: boolean): void {
    const steps: Step[] = [];
    if (lastWords) for (const d of deaths) steps.push({ t: 'last_words', seat: d.seat });
    for (const d of deaths) if (this.roleOf(d.seat) === 'hunter' && d.cause !== 'poison') steps.push({ t: 'hunter', seat: d.seat });
    this.push(...steps);
  }

  private revealAll() {
    return this.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      identity: `${ROLE_NAME[this.roleOf(p.seat)]}（${teamOf(this.roleOf(p.seat))}）`,
    }));
  }

  private checkWin(): boolean {
    const alive = this.players.filter((p) => p.alive);
    const aliveWolves = alive.filter((p) => this.roleOf(p.seat) === 'werewolf');
    const cfg = this.state.config;
    let winner: '好人阵营' | '狼人阵营' | null = null;
    let reason = '';
    if (aliveWolves.length === 0) {
      winner = '好人阵营';
      reason = '所有狼人已出局';
    } else if (this.options.win_mode === 'all') {
      if (alive.length === aliveWolves.length) {
        winner = '狼人阵营';
        reason = '所有好人已出局（屠城）';
      }
    } else {
      const godAlive = alive.filter((p) => GODS.includes(this.roleOf(p.seat))).length;
      const vilAlive = alive.filter((p) => this.roleOf(p.seat) === 'villager').length;
      const godCfg = GODS.reduce((s, r) => s + cfg[r], 0);
      if (godCfg > 0 && godAlive === 0) {
        winner = '狼人阵营';
        reason = '所有神职已出局（屠边）';
      } else if (cfg.villager > 0 && vilAlive === 0) {
        winner = '狼人阵营';
        reason = '所有村民已出局（屠边）';
      }
    }
    if (!winner) return false;
    this.finish({
      winnerTeam: winner,
      winnerSeats: this.players.filter((p) => (teamOf(this.roleOf(p.seat)) === winner)).map((p) => p.seat),
      reason,
      reveal: this.revealAll(),
    });
    return true;
  }

  // ───────────────────────── 发言 ─────────────────────────

  private openSpeech(key: 'speech' | 'last_words' | 'pk_speech', seat: Seat): boolean {
    const o = this.options;
    const secs = key === 'speech' ? o.speech_timeout_s : key === 'last_words' ? o.last_words_timeout_s : o.pk_speech_timeout_s;
    const name = key === 'speech' ? '发言' : key === 'last_words' ? '遗言' : 'PK发言';
    const n = this.rec.round;
    if (key === 'speech') this.announce(`🎤 请 ${this.at(seat)} 发言（限时 ${secs} 秒，说完请发「过」）。`);
    else if (key === 'last_words') this.announce(`🕯️ 请 ${this.at(seat)} 留遗言（限时 ${secs} 秒，说完请发「过」）。`);
    else this.announce(`⚔️ 请 ${this.at(seat)} 进行 PK 发言（限时 ${secs} 秒，说完请发「过」）。`);
    this.openPhase({
      key,
      title: `第${n}天·${seat}号${name}`,
      requests: [
        {
          seat,
          kind: 'speech',
          channel: 'group',
          prompt: `请${name}。真人在群里直接说话，说完发「过」；AI 调用 speak。`,
          actions: [
            this.specSpeech(),
            { action: 'end_speech', label: '结束发言', example: 'act({"action":"end_speech"})', command: '过' },
          ],
        },
      ],
      timeoutMs: secs * 1000,
      data: {},
    });
    return true;
  }

  private speechAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
    this.requireTurn(seat, input.action);
    const ph = this.phase!;
    if (input.action === 'end_speech') {
      this.markDone(seat);
      return '已结束发言。';
    }
    if (input.action !== 'speech') throw invalidAction('当前只能发言（speech）或结束发言（end_speech）。');
    const text = cleanSpeech(input.text ?? '');
    if (!text) throw invalidAction('发言内容不能为空。');
    const title = ph.key === 'last_words' ? '遗言' : ph.key === 'pk_speech' ? 'PK' : undefined;
    this.recordSpeech(seat, text, 'speech', title);
    this.state.speeches.push({ seat, kind: ph.key, text });
    ph.data.spoke = true;
    if (meta.via === 'agent') this.markDone(seat);
    return '发言已记录。';
  }

  private startDiscussion(): void {
    const alive = this.aliveSeats();
    const start = pick(this.rng, alive);
    const order = this.orderFrom(start, alive);
    this.state.order = order;
    this.announce(`🗣️ 第${this.rec.round}天讨论开始，发言顺序：${order.map((s) => `${s}号`).join(' → ')}。`);
    this.push(...order.map((seat): Step => ({ t: 'speech', seat })), { t: 'vote' });
  }

  // ───────────────────────── 猎人 ─────────────────────────

  private openHunter(seat: Seat): boolean {
    const alive = this.aliveSeats();
    this.announce(`🔫 ${this.label(seat)} 是猎人！请在 ${this.options.hunter_timeout_s} 秒内选择开枪目标，或放弃。`);
    this.openPhase({
      key: 'hunter',
      title: `第${this.rec.round}天·猎人开枪`,
      requests: [
        {
          seat,
          channel: 'group',
          prompt: '你是猎人，请选择带走一名玩家，或不开枪。',
          actions: [this.specTarget('shoot', '开枪', alive, '开枪3'), this.specSkip('不开枪', '不开枪')],
        },
      ],
      timeoutMs: this.options.hunter_timeout_s * 1000,
      data: { seat },
    });
    return true;
  }

  private hunterAction(seat: Seat, input: ActionInput): string {
    const req = this.requireTurn(seat, input.action);
    const ph = this.phase!;
    if (input.action === 'shoot') ph.data.target = this.requireTarget(req, 'shoot', input.target);
    else if (input.action !== 'skip') throw invalidAction('猎人可执行：shoot、skip。');
    this.markDone(seat);
    return input.action === 'shoot' ? `你选择开枪带走 ${ph.data.target}号。` : '你选择不开枪。';
  }

  /** 返回 true 表示游戏已结束。 */
  private afterHunter(): boolean {
    const ph = this.phase!;
    const hunter = ph.data.seat as Seat;
    const target = ph.data.target as Seat | undefined;
    if (!target || !this.isAlive(target)) {
      this.announce(`🔫 ${this.label(hunter)} 选择不开枪。`);
      return false;
    }
    this.markDead(target, 'shot', `第${this.rec.round}天被猎人带走`);
    this.announce(`🔫 ${this.label(hunter)} 开枪带走了 ${this.label(target)}。`, { kind: 'death', data: { seats: [target] } });
    if (this.checkWin()) return true;
    this.afterDeaths([{ seat: target, cause: 'shot' }], true);
    return false;
  }

  // ───────────────────────── 投票 ─────────────────────────

  private openVote(pk: boolean, tied: Seat[]): boolean {
    const alive = this.aliveSeats();
    const voters = alive.filter((s) => this.canVote(s) && !(pk && tied.includes(s)));
    const targetsFor = (s: Seat) => (pk ? tied : this.others(s, alive));
    if (voters.length === 0) {
      this.announce('🗳️ 没有可投票的玩家，本轮无人被放逐。');
      this.state.voteLog.push({ day: this.rec.round, kind: pk ? 'pk_vote' : 'vote', votes: {}, abstain: [], result: '无人投票，无人被放逐' });
      return false;
    }
    const secs = this.options.vote_timeout_s;
    this.announce(
      pk
        ? `🗳️ PK 投票开始！请非平票玩家在 ${secs} 秒内投给 ${this.seatList(tied)} 之一，或弃票（群里发「投3」，也可私聊裁判）。`
        : `🗳️ 投票开始！请所有存活玩家在 ${secs} 秒内投票（群里发「投3」「弃票」，也可私聊裁判）。所有票数将在结束后统一公布。`,
    );
    this.openPhase({
      key: pk ? 'pk_vote' : 'vote',
      title: `第${this.rec.round}天·${pk ? 'PK投票' : '投票'}`,
      requests: voters.map((seat) => ({
        seat,
        channel: 'group' as const,
        prompt: pk ? `请在平票玩家 ${this.seatList(tied)} 中选择放逐对象，或弃票。` : '请选择放逐对象（不能投自己），或弃票。',
        actions: [this.specTarget('vote', '投票', targetsFor(seat), '投3'), this.specSkip('弃票', '弃票')],
      })),
      timeoutMs: secs * 1000,
      data: { votes: {}, tied },
    });
    return true;
  }

  private voteAction(seat: Seat, input: ActionInput): string {
    const req = this.requireTurn(seat, input.action);
    const votes = this.phase!.data.votes as Record<string, number>;
    if (input.action === 'vote') {
      votes[String(seat)] = this.requireTarget(req, 'vote', input.target);
      this.markDone(seat);
      return `你投了 ${votes[String(seat)]}号。`;
    }
    if (input.action === 'skip') {
      votes[String(seat)] = 0;
      this.markDone(seat);
      return '你选择弃票。';
    }
    throw invalidAction('投票阶段可执行：vote、skip。');
  }

  /** 返回 true 表示游戏已结束。 */
  private tally(pk: boolean): boolean {
    const ph = this.phase!;
    const votes = ph.data.votes as Record<string, number>;
    const voters = Object.values(ph.pending).map((r) => r.seat).sort((a, b) => a - b);
    const counts = new Map<number, number>();
    const record: Record<string, number> = {};
    const abstain: Seat[] = [];
    const lines: string[] = [];
    for (const v of voters) {
      const t = votes[String(v)] ?? 0;
      if (t > 0) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
        record[String(v)] = t;
        lines.push(`${v}号 → ${t}号`);
      } else abstain.push(v);
    }
    if (abstain.length) lines.push(`弃票：${this.seatList(abstain)}`);
    const tallyText = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([s, c]) => `${s}号 ${c}票`)
      .join('，');
    const day = this.rec.round;
    const nextNight: Step = { t: 'night', n: day + 1 };
    // 每个夜晚步骤只入队一次：平票进 PK 时已把 nextNight 排在 pk_vote 之后，PK 结算时不再重复入队。
    const enqueueNight = () => {
      if (!this.state.agenda.some((s) => s.t === 'night')) this.push(nextNight);
    };
    const head = `🗳️ ${pk ? 'PK ' : ''}投票结果：\n${lines.join('\n')}\n统计：${tallyText || '无人得票'}。`;
    const top = counts.size ? Math.max(...counts.values()) : 0;
    const leaders = [...counts.entries()].filter(([, c]) => c === top).map(([s]) => s).sort((a, b) => a - b);
    const log = (result: string) => this.state.voteLog.push({ day, kind: pk ? 'pk_vote' : 'vote', votes: record, abstain, result });

    if (leaders.length === 0) {
      this.announce(`${head}\n全员弃票，今天无人被放逐（平安日）。`);
      log('全员弃票，无人被放逐');
      enqueueNight();
      return false;
    }
    if (leaders.length > 1) {
      if (pk) {
        this.announce(`${head}\n再次平票（${this.seatList(leaders)}），今天无人被放逐（平安日）。`);
        log(`PK 再次平票（${this.seatList(leaders)}），无人被放逐`);
        enqueueNight();
        return false;
      }
      this.announce(`${head}\n平票：${this.seatList(leaders)}，进入 PK 环节。`);
      log(`平票 ${this.seatList(leaders)}，进入PK`);
      this.push(...leaders.map((seat): Step => ({ t: 'pk_speech', seat })), { t: 'pk_vote', tied: leaders }, nextNight);
      return false;
    }
    const out = leaders[0]!;
    enqueueNight();
    if (this.roleOf(out) === 'idiot' && !this.state.idiotRevealed.includes(out)) {
      this.state.idiotRevealed.push(out);
      this.announce(`${head}\n${this.label(out)} 被放逐——翻牌！他是【白痴】，免于死亡，但从此失去投票权。`, { kind: 'idiot_reveal', data: { seat: out } });
      log(`${out}号 被放逐，翻牌白痴免死`);
      return false;
    }
    this.markDead(out, 'exile', `第${day}天放逐`);
    this.announce(`${head}\n${this.label(out)} 被放逐出局。`, { kind: 'death', data: { seats: [out] } });
    log(`${out}号 被放逐`);
    if (this.checkWin()) return true;
    this.afterDeaths([{ seat: out, cause: 'exile' }], true);
    return false;
  }

  // ───────────────────────── 动作入口 ─────────────────────────

  onAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
    if (input.action === 'team_chat') return this.teamChat(seat, input);
    const key = this.phase?.key;
    if (key === 'night') return this.nightAction(seat, input);
    if (key === 'witch') return this.witchAction(seat, input);
    if (key === 'hunter') return this.hunterAction(seat, input);
    if (key === 'vote' || key === 'pk_vote') return this.voteAction(seat, input);
    if (key && SPEECH_KEYS.has(key)) return this.speechAction(seat, input, meta);
    this.requireTurn(seat, input.action);
    throw invalidAction(`当前阶段不能执行「${input.action}」。`);
  }

  // ───────────────────────── 视角 ─────────────────────────

  privateView(seat: Seat): Record<string, unknown> {
    const role = this.roleOf(seat);
    const ph = this.phase;
    const view: Record<string, unknown> = {
      role: ROLE_NAME[role],
      team: teamOf(role),
      ability: ABILITY[role],
    };
    if (role === 'werewolf') {
      view.wolf_teammates = this.others(seat, this.wolves(false)).map((s) => ({ seat: s, alive: this.isAlive(s) }));
      if (ph?.key === 'night') {
        const wv = (ph.data.wolfVotes ?? {}) as Record<string, number>;
        view.tonight_wolf_votes = Object.fromEntries(
          this.wolves().map((s) => [`${s}号`, wv[String(s)] === undefined ? '未提交' : wv[String(s)] ? `刀${wv[String(s)]}号` : '空刀']),
        );
      }
    }
    if (role === 'witch') {
      const p = this.state.potions[String(seat)]!;
      view.potions = { antidote: p.antidote ? '有' : '已用', poison: p.poison ? '有' : '已用' };
      if (ph?.key === 'witch' && this.pendingOf(seat) && p.antidote) view.tonight_victim = this.state.tonight.victim || '无人被刀';
      view.witch_self_save = this.options.witch_self_save;
    }
    if (role === 'guard') {
      view.last_guarded = this.state.lastGuard[String(seat)] || null;
    }
    if (role === 'seer') {
      view.seer_results = (this.state.seerResults[String(seat)] ?? []).map((r) => `第${r.night}夜 ${r.target}号：${r.wolf ? '狼人' : '好人'}`);
    }
    if (role === 'idiot') {
      const revealed = this.state.idiotRevealed.includes(seat);
      view.idiot_revealed = revealed;
      view.can_vote = !revealed;
    }
    if (role === 'hunter') view.can_shoot = this.canShoot(seat);
    view.can_vote = this.canVote(seat);
    return view;
  }

  publicView(): Record<string, unknown> {
    const s = this.state;
    const ph = this.phase;
    const speaker = ph && SPEECH_KEYS.has(ph.key) ? Number(Object.keys(ph.pending)[0]) : null;
    return {
      roles_config: Object.fromEntries(ROLE_KEYS.filter((r) => s.config[r] > 0).map((r) => [ROLE_NAME[r], s.config[r]])),
      win_mode: this.options.win_mode === 'side' ? '屠边' : '屠城',
      witch_self_save: this.options.witch_self_save,
      round: this.rec.round,
      stage: ph ? ph.title : null,
      alive: this.players.filter((p) => p.alive).map((p) => ({ seat: p.seat, name: p.name, can_vote: this.canVote(p.seat) })),
      dead: this.players.filter((p) => !p.alive).map((p) => ({ seat: p.seat, name: p.name, died: s.deaths[String(p.seat)] ?? '' })),
      idiot_revealed: [...s.idiotRevealed],
      speaker_order: [...s.order],
      current_speaker: speaker,
      today_speeches: s.speeches.map((x) => ({ seat: x.seat, type: x.kind === 'last_words' ? '遗言' : x.kind === 'pk_speech' ? 'PK发言' : '发言', text: x.text })),
      vote_records: s.voteLog.map((v) => ({
        day: v.day,
        type: v.kind === 'pk_vote' ? 'PK投票' : '投票',
        votes: Object.fromEntries(Object.entries(v.votes).map(([a, b]) => [`${a}号`, `${b}号`])),
        abstain: v.abstain,
        result: v.result,
      })),
    };
  }

  // ───────────────────────── 真人指令 ─────────────────────────

  override parseCommand(seat: Seat, text: string, channel: 'group' | 'private'): ActionInput | null {
    const ph = this.phase;
    if (!ph || !this.hasSeat(seat)) return null;
    const t = normalizeText(text);
    if (!t) return null;
    const bare = stripTrailing(t);
    const targetOf = (re: RegExp): Seat | null => {
      const m = t.match(re);
      return m ? resolveSeat(m[1]!, this.players) : null;
    };
    const key = ph.key;

    if (key === 'night') {
      if (channel !== 'private' || !this.isAlive(seat)) return null;
      const role = this.roleOf(seat);
      if (role === 'werewolf') {
        const tg = targetOf(/^(?:刀|杀|袭击|砍|咬)\s*(.+)$/u);
        if (tg !== null) return { action: 'kill', target: tg };
        if (/^(?:空刀|不刀|放弃)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
        return { action: 'team_chat', text: text };
      }
      if (!this.pendingOf(seat)) return null;
      if (role === 'seer') {
        const tg = targetOf(/^(?:查验|验|查)\s*(.+)$/u);
        return tg !== null ? { action: 'check', target: tg } : isSkipWord(bare) ? { action: 'skip' } : null;
      }
      if (role === 'guard') {
        const tg = targetOf(/^(?:守护|守|保护)\s*(.+)$/u);
        return tg !== null ? { action: 'guard', target: tg } : isSkipWord(bare) ? { action: 'skip' } : null;
      }
      return null;
    }
    if (key === 'witch') {
      if (channel !== 'private' || !this.pendingOf(seat)) return null;
      if (/^(?:救|救人|救他|用解药|使用解药|解药)$/u.test(bare)) return { action: 'save' };
      const tg = targetOf(/^(?:毒杀|下毒|毒)\s*(.+)$/u);
      if (tg !== null) return { action: 'poison', target: tg };
      if (/^(?:不救|不毒|不用药)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
      return null;
    }
    if (key === 'hunter') {
      if (!this.pendingOf(seat)) return null;
      const tg = targetOf(/^(?:开枪|带走|枪|崩|射)\s*(.+)$/u);
      if (tg !== null) return { action: 'shoot', target: tg };
      if (/^(?:不开枪|不带走|放弃)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
      return null;
    }
    if (key === 'vote' || key === 'pk_vote') {
      if (!this.pendingOf(seat)) return null;
      const tg = targetOf(/^(?:我)?(?:投票给|投票|投给|投|票给|票)\s*(.+)$/u);
      if (tg !== null) return { action: 'vote', target: tg };
      if (/^(?:弃票|不投|弃权|不投票)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
      return null;
    }
    if (SPEECH_KEYS.has(key)) {
      if (!this.pendingOf(seat)) return null;
      if (isEndSpeech(t)) return { action: 'end_speech' };
      if (channel !== 'group') return null;
      return cleanSpeech(t) ? { action: 'speech', text } : null;
    }
    return null;
  }

  override randomAction(seat: Seat): ActionInput | null {
    const req = this.pendingOf(seat);
    const ph = this.phase;
    if (!req || !ph) return null;
    if (SPEECH_KEYS.has(ph.key)) {
      if (this.player(seat).kind === 'human' && ph.data.spoke) return { action: 'end_speech' };
      return { action: 'speech', text: pick(this.rng, CANNED) };
    }
    const acts = req.actions.filter((a) => a.action !== 'team_chat');
    const real = acts.filter((a) => a.action !== 'skip');
    const choice = real.length === 0 || this.rng.int(100) < 12 ? acts.find((a) => a.action === 'skip') ?? acts[0]! : pick(this.rng, real);
    if (choice.targets) return { action: choice.action, target: pick(this.rng, choice.targets) };
    return { action: choice.action };
  }
}

// ───────────────────────── 配置 ─────────────────────────

/** 解析本局身份配置；失败返回错误信息。 */
export function resolveRoles(n: number, options: WerewolfOptions): Record<Role, number> | string {
  const base: Record<Role, number> = { werewolf: 0, villager: 0, seer: 0, witch: 0, hunter: 0, guard: 0, idiot: 0 };
  if (options.roles) {
    Object.assign(base, options.roles);
    const sum = ROLE_KEYS.reduce((s, r) => s + base[r], 0);
    if (sum !== n) return `自定义 roles 的人数合计 ${sum}，但本局有 ${n} 名玩家，两者必须相等。`;
    if (base.werewolf < 1) return '自定义 roles 至少需要 1 名狼人。';
    if (n - base.werewolf < 1) return '自定义 roles 至少需要 1 名好人。';
    return base;
  }
  const preset = PRESETS[n];
  if (!preset) return `${n} 人局没有默认板子（默认支持 6~12 人），请通过 roles 选项自定义身份数量。`;
  Object.assign(base, preset);
  return base;
}

export const werewolfDefinition: GameDefinition<WerewolfOptions> = {
  type: 'werewolf',
  name: '狼人杀',
  aliases: ['狼人杀', '狼人', 'werewolf', 'wolf', 'mafia'],
  idPrefix: 'WW',
  minPlayers: 6,
  maxPlayers: 16,
  summary: '经典身份推理：狼人夜间刀人，好人白天发言投票。含预言家、女巫、猎人、守卫、白痴，身份与结算全由程序决定。',
  rules: RULES,
  playerTips:
    '- 好人：认真分析发言与投票，预言家验到狼人后要想办法让大家信任。\n- 狼人：夜间可密谈（speak channel=team），白天不要暴露队友；可以悍跳预言家。\n- 夜里的私密信息只写在自己的视角里，不要在群里复述工具内容。\n- 白天发言只说话，不要在发言里透露不该公开的程序信息。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    roles: '自定义身份数量 {werewolf,villager,seer,witch,hunter,guard,idiot}，合计须等于玩家数；13~16 人必填',
    win_mode: 'side=屠边（默认，神职或村民全灭则狼胜）；all=屠城（好人全灭才狼胜）',
    witch_self_save: 'first_night=仅首夜可自救（默认）；never=不可自救；always=可自救',
    first_night_last_words: '第一夜死者是否有遗言（默认 true）',
    night_timeout_s: '夜晚行动限时（秒，默认 60）',
    witch_timeout_s: '女巫行动限时（秒，默认 40）',
    speech_timeout_s: '白天发言限时（秒，默认 90）',
    vote_timeout_s: '投票限时（秒，默认 45）',
    last_words_timeout_s: '遗言限时（秒，默认 60）',
    hunter_timeout_s: '猎人开枪限时（秒，默认 30）',
    pk_speech_timeout_s: 'PK 发言限时（秒，默认 60）',
    night_min_s: '夜晚/女巫阶段最短持续秒数（默认 20）；>0 时即使都提交了也等满，避免从结算速度推断谁还活着；设 0 可关闭',
  },
  checkStart(playerCount, options) {
    const r = resolveRoles(playerCount, options);
    return typeof r === 'string' ? r : null;
  },
  create: (rec, env) => new WerewolfGame(rec, env),
};
