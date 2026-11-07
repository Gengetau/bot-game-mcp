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

const ROLE_KEYS = ['werewolf', 'wolf_king', 'villager', 'seer', 'witch', 'hunter', 'guard', 'idiot'] as const;
export type Role = (typeof ROLE_KEYS)[number];

const cnt = () => z.number().int().min(0).max(16).default(0);

const optionsSchema = z.object({
  ...commonOptionShape,
  roles: z
    .object({
      werewolf: cnt(),
      wolf_king: cnt(),
      villager: cnt(),
      seer: cnt(),
      witch: cnt(),
      hunter: cnt(),
      guard: cnt(),
      idiot: cnt(),
    })
    .optional(),
  win_mode: z.enum(['auto', 'side', 'all']).default('auto'),
  /** 默认板子里把一只普通狼换成狼王（自定义 roles 时直接写 wolf_king 数量） */
  wolf_king: z.boolean().default(false),
  /** 狼人白天能否自爆 */
  self_explode: z.boolean().default(true),
  claim_phase: z.boolean().default(false),
  claim_timeout_s: secondsOption(30),
  second_round: z.boolean().default(false),
  second_round_timeout_s: secondsOption(60),
  sheriff: z.union([z.boolean(), z.literal('auto')]).default('auto'),
  sheriff_signup_timeout_s: secondsOption(30),
  sheriff_order_timeout_s: secondsOption(30),
  badge_timeout_s: secondsOption(30),
  witch_self_save: z.enum(['first_night', 'never', 'always']).default('first_night'),
  /** 女巫能否看到刀口：until_antidote（常见规则：解药用掉后就看不到）/ always（没解药也告诉她） */
  witch_sees_victim: z.enum(['until_antidote', 'always']).default('until_antidote'),
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
  wolf_king: '狼王',
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  idiot: '白痴',
};
const GODS: Role[] = ['seer', 'witch', 'hunter', 'guard', 'idiot'];

const ABILITY: Record<Role, string> = {
  werewolf: '每晚与狼队友商量并选择一名玩家袭击（可空刀）；白天隐藏身份，帮狼队赢。白天发言阶段可以自爆：亮明狼人身份立即出局（没有遗言），当天直接结束、不再投票，进入黑夜。',
  wolf_king:
    '狼人阵营，和狼队友一起刀人、密谈、可自爆。出局时（被刀、被放逐、被猎人带走）可以开枪带走一名玩家；被女巫毒死或自爆则不能开枪。',
  villager: '没有特殊技能，白天通过发言与投票找出狼人。',
  seer: '每晚可查验一名玩家（不含自己）是「好人」还是「狼人」。',
  witch: '拥有一瓶解药和一瓶毒药（各限一次，同一晚最多用一瓶）。解药可救当晚被刀的人，毒药可毒杀任意一人。',
  hunter: '被狼人刀杀或被放逐出局时，可开枪带走一名玩家；被女巫毒死则不能开枪；若这次死亡已使某一方满足胜利条件，游戏立即结束，不能开枪。',
  guard: '每晚可守护一名玩家（可守自己），使其不被狼人刀杀；不能连续两晚守护同一人。同守同救则目标仍会死亡。',
  idiot: '被放逐时翻牌公开身份且不会死亡，但此后永远失去投票权；其他方式死亡与常人相同。',
};

const HUMAN_CMDS: Record<Role, string> = {
  werewolf: '夜间私聊我：「刀3」选择袭击目标，「空刀」放弃；夜间发其他任意文字会转发给狼队友。白天发言阶段在群里发「自爆」可以自爆。',
  wolf_king:
    '夜间私聊我：「刀3」选择袭击目标，「空刀」放弃；夜间发其他任意文字会转发给狼队友。白天发言阶段在群里发「自爆」可以自爆。出局时按提示发「开枪3」带走 3 号，或「不开枪」。',
  villager: '白天按提示在群里发言（说完发「过」），投票发「投3」或「弃票」。',
  seer: '夜间私聊我：「验3」查验 3 号。',
  witch: '夜间私聊我：「救」使用解药，「毒3」毒杀 3 号，「不用」跳过。',
  hunter: '死亡时按提示发：「开枪3」带走 3 号，或「不开枪」。',
  guard: '夜间私聊我：「守3」守护 3 号，「空守」放弃。',
  idiot: '白天按提示发言、投票；被放逐时会自动翻牌。',
};

const isWolf = (r: Role) => r === 'werewolf' || r === 'wolf_king';
const teamOf = (r: Role) => (isWolf(r) ? '狼人阵营' : '好人阵营');
/** 出局时能开枪的身份 */
const isShooter = (r: Role) => r === 'hunter' || r === 'wolf_king';
/** 可以自爆的阶段：白天的报名、竞选发言、定序、起跳和发言。遗言、开枪、移交警徽、投票时不能自爆。 */
const EXPLODE_KEYS = new Set(['sheriff_signup', 'sheriff_speech', 'sheriff_order', 'claim', 'speech', 'speech2', 'pk_speech']);
const ELECTION_KEYS = new Set(['sheriff_signup', 'sheriff_speech']);

// ───────────────────────── 状态 ─────────────────────────

type Step =
  | { t: 'night'; n: number }
  | { t: 'witch' }
  | { t: 'dawn' }
  | { t: 'last_words'; seat: Seat }
  | { t: 'hunter'; seat: Seat }
  | { t: 'discussion' }
  | { t: 'speech'; seat: Seat; second?: boolean }
  | { t: 'claim' }
  | { t: 'sheriff_order' }
  | { t: 'sheriff_signup' }
  | { t: 'sheriff_speech'; seat: Seat }
  | { t: 'sheriff_vote'; candidates: Seat[]; pk: boolean }
  | { t: 'badge'; seat: Seat }
  | { t: 'vote' }
  | { t: 'pk_speech'; seat: Seat }
  | { t: 'pk_vote'; tied: Seat[] };

type Cause = 'wolf' | 'poison' | 'exile' | 'shot' | 'explode';

interface NightRecord {
  n: number;
  victim: number;
  saved: boolean;
  guarded: Seat[];
  poisons: Seat[];
  checks: { seer: Seat; target: Seat; wolf: boolean }[];
}

interface VoteRecord {
  day: number;
  kind: 'vote' | 'pk_vote' | 'sheriff_vote';
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
  /** 实际生效的胜负规则（win_mode=auto 时按人数决定）。旧存档没有这个字段。 */
  winMode?: 'side' | 'all';
  /** 警长座位；0 = 没有警长（无人当选或警徽被撕）。 */
  sheriff?: Seat;
  /** 警长竞选是否已经举行过。 */
  sheriffElected?: boolean;
  /** 今天起跳的玩家（按起跳先后）。 */
  claims?: Seat[];
  /** 今天天亮时公布的昨夜死者（定发言起点用）。 */
  dawnDeaths?: Seat[];
  /** 警长今天定的发言方向：1=顺序（号码从小到大），-1=逆序。没定时为空。 */
  orderDir?: 1 | -1 | null;
  /** 每晚发生了什么（结束后在群里复盘）。 */
  nightLog?: NightRecord[];
}

const SPEECH_KEYS = new Set(['speech', 'speech2', 'last_words', 'pk_speech', 'sheriff_speech']);
const SPEECH_TYPE: Record<string, string> = { speech: '发言', speech2: '补充发言', last_words: '遗言', pk_speech: 'PK发言', sheriff_speech: '竞选发言' };
const CANNED = ['我是好人，大家再听听后面的发言。', '目前信息不多，我先划水，请大家多给点线索。', '我觉得有人的发言有点奇怪，先观察一下。', '过，听后面的。'];

const RULES = `## 狼人杀

**阵营**：狼人阵营（狼人、狼王）vs 好人阵营（村民 + 神职：预言家、女巫、猎人、守卫、白痴）。
**配置**：6~12 人有默认板子（6人：2狼 预 女 2民；7人：+猎人；8人：3狼；10人起加守卫……）；13~16 人或自定义需指定 \`roles\`。\`wolf_king=true\` 时默认板子里的一只狼换成**狼王**。
**流程**：
1. 🌙 夜晚（秘密）：守卫守人 → 狼人刀人（多狼取最多票，平票随机，可空刀；提交后到阶段结束前可改刀，可用私聊密谈）→ 预言家验人（立即得知结果）。
2. 女巫：若有药，得知被刀的人（仅当还有解药时），可救 / 毒 / 不用，同夜最多用一瓶。
3. ☀️ 天亮：公布死亡名单（不说死因）或平安夜。被刀的人：被守或被救则活，**同守同救则死**。第一夜死者有遗言；猎人被刀死可开枪（被毒死不能）。**胜负判定优先**：若这次死亡已使某一方满足胜利条件，游戏立即结束，不再有猎人开枪和遗言。
4. 👮 警长竞选（\`sheriff\`，默认 8 人及以上开启）：仅第 1 天，在讨论前进行。想当警长的发「上警」→ 上警者依次竞选发言 → 未上警的人投票；平票则平票者再发言、再投一次，仍平票则警徽流失；只有一人上警直接当选。警长放逐投票算 **1.5 票**，每天讨论前由警长**决定发言顺序**（「顺序」号码从小到大 /「逆序」从大到小；昨夜单死时从死者的下一位开始，否则从警长的下一位开始），警长**最后发言归票**；警长出局时（遗言后）可「警徽给3」移交或「撕警徽」。
5. 🙋 起跳（\`claim_phase\`，默认关闭；有警长或当天有警长竞选时跳过）：讨论前限时报名，发「起跳」的人按起跳先后**最先发言**，其余人随后。起跳只决定顺序，真跳悍跳都可以，具体内容在发言里讲。
6. 🗣 依次发言（有警长按警长定的顺序；没有警长时，昨夜单死从死者的下一位开始，否则随机起点，方向随机；真人说完发「过」；\`second_round\` 开启时所有人再补充发言一轮）→ 🗳 投票放逐得票最多者；平票则平票者 PK 发言，再由其他人投票，仍平票则无人出局。
7. 💥 自爆（\`self_explode\`，默认开启）：白天的警长竞选报名/发言、警长定序、起跳、发言、PK 发言阶段，存活的狼人（含狼王）可以在群里发「自爆」：亮明狼人身份立即出局，**没有遗言**，当天剩下的发言和投票全部取消，直接进入黑夜。警长竞选中自爆则警徽流失；警长自爆，警徽也随之流失。遗言、开枪、移交警徽和投票时不能自爆。
8. 被放逐者有遗言；猎人、狼王可开枪；白痴被放逐则翻牌免死但失去投票权。同样，若放逐（或猎人开枪）已使某一方满足胜利条件，游戏立即结束，不再有猎人开枪和遗言。
**狼王**：狼人阵营，夜里和狼队友一起刀人；出局时（被刀、被放逐、被开枪带走）可以开枪带走一人，被女巫毒死或自爆则不能开枪。
**胜负**：狼人（含狼王）全灭 → 好人胜。\`win_mode=side\`（屠边）：所有神职死光 或 所有村民死光 → 狼人胜；\`all\`（屠城）：所有好人死光 → 狼人胜；\`auto\`（默认）：6~7 人屠城、8 人及以上屠边。结束时公布身份并**复盘每一夜**（刀谁、守谁、救/毒、验人结果）。
**选项**：\`witch_self_save\`（first_night 默认/never/always）、\`witch_sees_victim\`（until_antidote 默认：解药用掉后看不到刀口，这是常见规则；always：没解药也告诉女巫刀口）、\`first_night_last_words\`、各阶段超时（秒）、\`night_min_s\`（夜晚与女巫阶段最短时长，默认 20 秒，防止通过结算速度推断谁还活着；只要板子里有女巫，每晚都会开启女巫阶段，女巫死亡或药用完时只是空等）。
**超时**：未行动视为放弃（空刀/空守/不用药/弃票/过）；发言超时会公告，投票结果里「未投票（超时）」和主动「弃票」分开标出。连续 6 个昼夜无人死亡视为平局。

**真人指令**：夜间私聊——狼人「刀3」「空刀」、预言家「验3」、守卫「守3」「空守」、女巫「救」「毒3」「不用」；白天——「上警」「不上警」、警长定序「顺序」「逆序」，发言直接说，结束发「过」；投票「投3」「弃票」；猎人/狼王「开枪3」「不开枪」；狼人白天「自爆」；警长出局「警徽给3」「撕警徽」。
**bot 指令**：\`act({"action":"kill|check|guard|save|poison|vote|shoot|run|claim|forward|backward|pass_badge|explode|skip","target":N})\`；发言 \`speak({"text":"…"})\`；狼人夜间密谈 \`speak({"text":"…","channel":"team"})\`。`;

export class WerewolfGame extends BaseGame<WerewolfState, WerewolfOptions> {
  // ───────────────────────── 基础查询 ─────────────────────────

  private roleOf(seat: Seat): Role {
    return this.state.roles[String(seat)]!;
  }

  private seatsOfRole(role: Role, aliveOnly = true): Seat[] {
    return this.players.filter((p) => (!aliveOnly || p.alive) && this.roleOf(p.seat) === role).map((p) => p.seat);
  }

  private wolves(aliveOnly = true): Seat[] {
    return this.players.filter((p) => (!aliveOnly || p.alive) && isWolf(this.roleOf(p.seat))).map((p) => p.seat);
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

  /** 「3号 小明、4号 大锤」：座位后面总是带名字，bot 和真人都不用回头翻座位表。 */
  private seatList(seats: Seat[]): string {
    return seats.map((s) => this.label(s)).join('、');
  }

  /** 实际生效的胜负规则 */
  private winMode(): 'side' | 'all' {
    return this.state.winMode ?? (this.options.win_mode === 'all' ? 'all' : 'side');
  }

  private sheriffEnabled(): boolean {
    const o = this.options.sheriff;
    return o === true || (o === 'auto' && this.players.length >= 8);
  }

  /** 存活的警长座位，没有返回 0 */
  private sheriffSeat(): Seat {
    const s = this.state.sheriff ?? 0;
    return s && this.isAlive(s) ? s : 0;
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
      winMode: this.options.win_mode === 'auto' ? (n <= 7 ? 'all' : 'side') : this.options.win_mode,
      sheriff: 0,
      sheriffElected: false,
      claims: [],
      nightLog: [],
    } satisfies WerewolfState);
    this.rec.round = 1;

    const mode = this.winMode() === 'side' ? '屠边（神职或村民全灭，狼人胜）' : '屠城（好人全灭，狼人胜）';
    const extras = [
      this.sheriffEnabled() ? '第1天先竞选警长（警长 1.5 票、决定发言顺序、最后发言归票）' : '',
      this.options.claim_phase ? '每天发言前有起跳环节（起跳者先发言）' : '',
      this.options.second_round ? '每天两轮发言' : '',
    ].filter(Boolean);
    this.announce(
      `🐺 狼人杀配置：共 ${n} 人，${this.configText()}。胜负规则：${mode}。\n` +
        (extras.length ? `流程：${extras.join('；')}。\n` : '') +
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
      case 'claim':
        this.afterClaim();
        break;
      case 'sheriff_order':
        this.state.orderDir = ph.data.dir === -1 ? -1 : 1;
        break;
      case 'sheriff_signup':
        this.afterSignup();
        break;
      case 'sheriff_vote':
        this.tallySheriff();
        break;
      case 'badge':
        this.afterBadge();
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
        return this.openSpeech(step.second ? 'speech2' : 'speech', step.seat);
      case 'claim':
        return this.openClaim();
      case 'sheriff_order':
        return this.openSheriffOrder();
      case 'sheriff_signup':
        return this.openSignup();
      case 'sheriff_speech':
        return this.openSpeech('sheriff_speech', step.seat);
      case 'sheriff_vote':
        return this.openSheriffVote(step.candidates, step.pk);
      case 'badge':
        return this.openBadge(step.seat);
      case 'pk_speech':
        return this.openSpeech('pk_speech', step.seat);
      case 'hunter':
        return this.openHunter(step.seat);
      case 'discussion':
        if (this.sheriffSeat() && !this.state.orderDir) {
          this.push({ t: 'sheriff_order' }, { t: 'discussion' });
          return false;
        }
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
    const resubmit = isWolf(role) && (a === 'kill' || a === 'skip') && req?.done && ph.openedAt !== null;
    if (!resubmit) req = this.requireTurn(seat, a);
    const data = ph.data as { wolfVotes: Record<string, number>; guard: Record<string, number> };

    if (isWolf(role)) {
      let target = 0;
      if (a === 'kill') target = this.requireTarget(req!, 'kill', input.target);
      else if (a !== 'skip') throw invalidAction('狼人夜间可执行：kill（袭击）、skip（空刀）、team_chat（密谈）。');
      data.wolfVotes[String(seat)] = target;
      this.markDone(seat);
      const text = target ? `刀 ${this.label(target)}` : '空刀';
      this.tellMany(this.others(seat, this.wolves()), `🐺 ${this.label(seat)} 选择：${text}。`);
      return `已提交：${text}（阶段结束前可改刀）。`;
    }
    if (role === 'guard') {
      let target = 0;
      if (a === 'guard') target = this.requireTarget(req!, 'guard', input.target);
      else if (a !== 'skip') throw invalidAction('守卫夜间可执行：guard（守护）、skip（空守）。');
      data.guard[String(seat)] = target;
      this.markDone(seat);
      return target ? `你今晚守护 ${this.label(target)}。` : '你选择了空守。';
    }
    if (role === 'seer') {
      if (a === 'skip') {
        this.markDone(seat);
        return '你今晚没有查验。';
      }
      if (a !== 'check') throw invalidAction('预言家夜间可执行：check（查验）、skip。');
      const target = this.requireTarget(req!, 'check', input.target);
      const wolf = isWolf(this.roleOf(target));
      const list = (this.state.seerResults[String(seat)] ??= []);
      list.push({ night: this.rec.round, target, wolf });
      this.markDone(seat);
      const msg = `🔮 查验结果：${this.label(target)} 是【${wolf ? '狼人' : '好人'}】。`;
      this.tell(seat, msg, { kind: 'info' });
      return msg;
    }
    throw invalidAction('你今晚没有可执行的动作。');
  }

  private teamChat(seat: Seat, input: ActionInput): string {
    const ph = this.phase;
    if (!ph || ph.key !== 'night' || ph.openedAt === null) throw invalidAction('只有夜晚阶段狼人才能密谈。');
    if (!this.isAlive(seat) || !isWolf(this.roleOf(seat))) throw invalidAction('只有存活的狼人可以密谈。');
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

  private witchSeesVictim(hasAntidote: boolean): boolean {
    return hasAntidote || this.options.witch_sees_victim === 'always';
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
      if (this.witchSeesVictim(p.antidote)) info = t.victim ? `今晚 ${this.label(t.victim)} 被狼人袭击。` : '今晚无人被狼人袭击（平安夜）。';
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
      return `你使用了解药，救下 ${this.label(this.state.tonight.victim!)}。`;
    }
    if (input.action === 'poison') {
      const target = this.requireTarget(req, 'poison', input.target);
      p.poison = false;
      choices[String(seat)] = { poison: target };
      this.markDone(seat);
      return `你对 ${this.label(target)} 使用了毒药。`;
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
    (this.state.nightLog ??= []).push({
      n,
      victim: t.victim,
      saved: t.saved,
      guarded: [...t.guarded],
      poisons: [...t.poisons],
      checks: Object.entries(this.state.seerResults).flatMap(([seer, list]) =>
        list.filter((r) => r.night === n).map((r) => ({ seer: Number(seer), target: r.target, wolf: r.wolf })),
      ),
    });
    this.state.speeches = [];
    this.state.claims = [];
    this.state.order = [];
    this.state.orderDir = null;
    this.state.dawnDeaths = deaths.map((d) => d.seat);
    this.state.tonight = { victim: 0, guarded: [], saved: false, poisons: [] };
    for (const d of deaths) this.markDead(d.seat, d.cause, `第${n}夜`);
    this.announce(
      (deaths.length === 0
        ? `☀️ 第${n}天，天亮了。昨夜是平安夜，无人死亡。`
        : `☀️ 第${n}天，天亮了。昨夜死亡的玩家：${deaths.map((d) => this.label(d.seat)).join('、')}。`) +
        `\n存活：${this.seatList(this.aliveSeats())}`,
      { kind: 'death', data: { seats: deaths.map((d) => d.seat) } },
    );
    if (this.checkWin()) return;
    const day: Step[] = [];
    const election = this.sheriffEnabled() && !this.state.sheriffElected;
    if (election) day.push({ t: 'sheriff_signup' });
    else if (this.options.claim_phase && !this.sheriffSeat()) day.push({ t: 'claim' });
    day.push({ t: 'discussion' });
    this.push(...day);
    this.afterDeaths(deaths, n === 1 && this.options.first_night_last_words);
  }

  private afterDeaths(deaths: { seat: Seat; cause: Cause }[], lastWords: boolean): void {
    const steps: Step[] = [];
    if (lastWords) for (const d of deaths) steps.push({ t: 'last_words', seat: d.seat });
    // 警长出局：遗言之后移交警徽
    for (const d of deaths) if (this.state.sheriff && this.state.sheriff === d.seat) steps.push({ t: 'badge', seat: d.seat });
    for (const d of deaths) if (isShooter(this.roleOf(d.seat)) && d.cause !== 'poison' && d.cause !== 'explode') steps.push({ t: 'hunter', seat: d.seat });
    this.push(...steps);
  }

  /** 结束时复盘每一夜（随结算一起公布：身份已经全部公开，夜里发生的事也不再是秘密） */
  private recapText(): string | undefined {
    const nights = this.state.nightLog ?? [];
    if (nights.length === 0) return undefined;
    const lines = nights.map((r) => {
      const parts: string[] = [];
      parts.push(r.victim ? `狼人刀 ${this.label(r.victim)}` : '狼人空刀');
      if (r.guarded.length) parts.push(`守卫守 ${this.seatList(r.guarded)}`);
      if (r.saved) parts.push('女巫用解药救下');
      if (r.poisons.length) parts.push(`女巫毒 ${this.seatList(r.poisons)}`);
      for (const c of r.checks) parts.push(`预言家 ${c.seer}号 验 ${c.target}号=${c.wolf ? '狼人' : '好人'}`);
      return `第${r.n}夜：${parts.join('；')}`;
    });
    return `—— 🌙 夜间复盘 ——\n${lines.join('\n')}`;
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
    const aliveWolves = alive.filter((p) => isWolf(this.roleOf(p.seat)));
    const cfg = this.state.config;
    let winner: '好人阵营' | '狼人阵营' | null = null;
    let reason = '';
    if (aliveWolves.length === 0) {
      winner = '好人阵营';
      reason = '所有狼人已出局';
    } else if (this.winMode() === 'all') {
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
    }, this.recapText());
    return true;
  }

  // ───────────────────────── 发言 ─────────────────────────

  private openSpeech(key: 'speech' | 'speech2' | 'last_words' | 'pk_speech' | 'sheriff_speech', seat: Seat): boolean {
    const o = this.options;
    const secs =
      key === 'speech' || key === 'sheriff_speech'
        ? o.speech_timeout_s
        : key === 'speech2'
          ? o.second_round_timeout_s
          : key === 'last_words'
            ? o.last_words_timeout_s
            : o.pk_speech_timeout_s;
    const name = SPEECH_TYPE[key]!;
    const n = this.rec.round;
    const badge = this.sheriffSeat() === seat && (key === 'speech' || key === 'speech2') ? '（警长，请归票）' : '';
    if (key === 'speech') this.announce(`🎤 请 ${this.at(seat)} 发言${badge}（限时 ${secs} 秒，说完请发「过」）。`);
    else if (key === 'speech2') this.announce(`🔁 第二轮：请 ${this.at(seat)} 补充发言${badge}（限时 ${secs} 秒，说完请发「过」）。`);
    else if (key === 'sheriff_speech') this.announce(`👮 请 ${this.at(seat)} 进行警长竞选发言（限时 ${secs} 秒，说完请发「过」）。`);
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
    const title =
      ph.key === 'last_words' ? '遗言' : ph.key === 'pk_speech' ? 'PK' : ph.key === 'sheriff_speech' ? '竞选' : ph.key === 'speech2' ? '补充' : undefined;
    this.recordSpeech(seat, text, 'speech', title);
    this.state.speeches.push({ seat, kind: ph.key, text });
    ph.data.spoke = true;
    if (meta.via === 'agent') this.markDone(seat);
    return '发言已记录。';
  }

  /** 从 anchor 的下一位起，按 dir 方向绕一圈的存活座位（不含 anchor 本身）。 */
  private ring(anchor: Seat, dir: 1 | -1): Seat[] {
    const n = this.players.length;
    const out: Seat[] = [];
    for (let k = 1; k <= n; k++) {
      const s = ((((anchor - 1 + dir * k) % n) + n) % n) + 1;
      if (s !== anchor && this.isAlive(s)) out.push(s);
    }
    return out;
  }

  /** 昨夜单死时返回死者座位，否则 0。 */
  private singleDawnDeath(): Seat {
    const dd = (this.state.dawnDeaths ?? []).filter((s) => !this.isAlive(s));
    return dd.length === 1 ? dd[0]! : 0;
  }

  private startDiscussion(): void {
    const alive = this.aliveSeats();
    const sheriff = this.sheriffSeat();
    const dead = this.singleDawnDeath();
    let order: Seat[];
    let how = '';
    if (sheriff) {
      // 警长定方向；单死从死者下一位开始，否则从警长下一位开始；警长最后发言归票
      const dir = this.state.orderDir ?? 1;
      order = this.ring(dead || sheriff, dir).filter((s) => s !== sheriff);
      order.push(sheriff);
      how = `警长 ${sheriff}号 定${dir === 1 ? '顺序' : '逆序'}，从${dead ? `昨夜死者 ${dead}号` : '警长'}的下一位开始，警长最后发言归票`;
    } else if (dead) {
      order = this.ring(dead, this.rng.int(2) === 0 ? 1 : -1);
      how = `从昨夜死者 ${dead}号 的下一位开始`;
    } else {
      order = this.orderFrom(pick(this.rng, alive), alive);
      if (this.rng.int(2) === 0) order = [order[0]!, ...order.slice(1).reverse()];
    }
    this.state.orderDir = null;
    const claims = sheriff ? [] : (this.state.claims ?? []).filter((s) => order.includes(s));
    order = [...claims, ...order.filter((s) => !claims.includes(s))];
    this.state.order = order;
    const notes = [claims.length ? `起跳的 ${claims.map((s) => `${s}号`).join('、')} 先发言` : '', how].filter(Boolean).join('，');
    this.announce(
      `🗣️ 第${this.rec.round}天讨论开始，发言顺序：${order.map((s) => this.label(s)).join(' → ')}。${notes ? `（${notes}）` : ''}` +
        (this.options.second_round ? '\n本轮结束后还有一轮补充发言，然后投票。' : ''),
    );
    const steps: Step[] = order.map((seat): Step => ({ t: 'speech', seat }));
    if (this.options.second_round) steps.push(...order.map((seat): Step => ({ t: 'speech', seat, second: true })));
    this.push(...steps, { t: 'vote' });
  }

  // ───────────────────────── 警长定发言顺序 ─────────────────────────

  private openSheriffOrder(): boolean {
    const sheriff = this.sheriffSeat();
    if (!sheriff) return false;
    const secs = this.options.sheriff_order_timeout_s;
    const dead = this.singleDawnDeath();
    const from = dead ? `昨夜单死，从死者 ${dead}号 的下一位开始` : '从警长的下一位开始';
    this.announce(
      `👮 请警长 ${this.at(sheriff)} 在 ${secs} 秒内决定今天的发言顺序：发「顺序」（号码从小到大）或「逆序」（号码从大到小）。${from}，警长最后发言归票。超时按顺序。`,
    );
    this.openPhase({
      key: 'sheriff_order',
      title: `第${this.rec.round}天·警长定发言顺序`,
      requests: [
        {
          seat: sheriff,
          channel: 'group',
          prompt: `你是警长，请决定今天的发言方向（${from}，你最后发言归票）。`,
          actions: [
            { action: 'forward', label: '顺序（号码从小到大）', example: 'act({"action":"forward"})', command: '顺序' },
            { action: 'backward', label: '逆序（号码从大到小）', example: 'act({"action":"backward"})', command: '逆序' },
          ],
        },
      ],
      timeoutMs: secs * 1000,
      data: {},
    });
    return true;
  }

  private sheriffOrderAction(seat: Seat, input: ActionInput): string {
    this.requireTurn(seat, input.action);
    if (input.action === 'forward') this.phase!.data.dir = 1;
    else if (input.action === 'backward') this.phase!.data.dir = -1;
    else throw invalidAction('警长定序可执行：forward（顺序）、backward（逆序）。');
    this.markDone(seat);
    return input.action === 'forward' ? '你选择了顺序发言。' : '你选择了逆序发言。';
  }

  // ───────────────────────── 起跳 ─────────────────────────

  private openClaim(): boolean {
    const alive = this.aliveSeats();
    const secs = this.options.claim_timeout_s;
    this.announce(
      `🙋 起跳环节：想亮明身份、报查验或对跳的玩家，请在 ${secs} 秒内发「起跳」，起跳者优先发言（按起跳先后）；不跳发「不跳」。起跳只决定发言顺序，具体说什么在发言里讲。`,
    );
    this.openPhase({
      key: 'claim',
      title: `第${this.rec.round}天·起跳`,
      requests: alive.map((seat) => ({
        seat,
        channel: 'group' as const,
        prompt: '要起跳吗？起跳＝你有身份或信息要先说（真身份或悍跳都可以），会排到最前面发言。',
        actions: [
          { action: 'claim', label: '起跳', example: 'act({"action":"claim"})', command: '起跳' },
          this.specSkip('不跳', '不跳'),
        ],
      })),
      timeoutMs: secs * 1000,
      data: { claims: [] },
    });
    return true;
  }

  private claimAction(seat: Seat, input: ActionInput): string {
    this.requireTurn(seat, input.action);
    if (input.action === 'claim') (this.phase!.data.claims as Seat[]).push(seat);
    else if (input.action !== 'skip') throw invalidAction('起跳环节可执行：claim（起跳）、skip（不跳）。');
    this.markDone(seat);
    return input.action === 'claim' ? '你起跳了，会优先发言。' : '你选择不跳。';
  }

  private afterClaim(): void {
    const claims = [...((this.phase!.data.claims as Seat[]) ?? [])];
    this.state.claims = claims;
    this.announce(claims.length ? `🙋 起跳：${this.seatList(claims)}。` : '🙋 无人起跳，按正常顺序发言。');
  }

  // ───────────────────────── 警长 ─────────────────────────

  private openSignup(): boolean {
    this.state.sheriffElected = true;
    const alive = this.aliveSeats();
    const secs = this.options.sheriff_signup_timeout_s;
    this.announce(
      `👮 警长竞选：想当警长的玩家请在 ${secs} 秒内发「上警」，不竞选发「不上警」。上警的人依次发言，其余人投票选出警长。警长放逐投票算 1.5 票、每天最后发言归票，出局时可移交警徽。`,
    );
    this.openPhase({
      key: 'sheriff_signup',
      title: `第${this.rec.round}天·警长竞选报名`,
      requests: alive.map((seat) => ({
        seat,
        channel: 'group' as const,
        prompt: '要上警竞选警长吗？',
        actions: [{ action: 'run', label: '上警', example: 'act({"action":"run"})', command: '上警' }, this.specSkip('不上警', '不上警')],
      })),
      timeoutMs: secs * 1000,
      data: { cands: [] },
    });
    return true;
  }

  private signupAction(seat: Seat, input: ActionInput): string {
    this.requireTurn(seat, input.action);
    if (input.action === 'run') (this.phase!.data.cands as Seat[]).push(seat);
    else if (input.action !== 'skip') throw invalidAction('警长竞选报名可执行：run（上警）、skip（不上警）。');
    this.markDone(seat);
    return input.action === 'run' ? '你上警了，稍后请做竞选发言。' : '你选择不上警。';
  }

  private afterSignup(): void {
    const cands = [...((this.phase!.data.cands as Seat[]) ?? [])].sort((a, b) => a - b);
    const voters = this.aliveSeats().filter((s) => this.canVote(s) && !cands.includes(s));
    if (cands.length === 0) {
      this.state.sheriff = 0;
      this.announce('👮 无人上警，本局没有警长。');
      return;
    }
    if (cands.length === 1) {
      this.state.sheriff = cands[0]!;
      this.announce(`👮 只有 ${this.label(cands[0]!)} 上警，自动当选警长。`, { kind: 'sheriff', data: { seat: cands[0] } });
      return;
    }
    if (voters.length === 0) {
      this.state.sheriff = 0;
      this.announce('👮 所有人都上警了，没有人能投票，本局没有警长。');
      return;
    }
    const order = this.orderFrom(pick(this.rng, cands), cands);
    this.announce(`👮 上警：${this.seatList(cands)}。竞选发言顺序：${order.map((s) => `${s}号`).join(' → ')}，之后由其余玩家投票。`);
    this.push(...order.map((seat): Step => ({ t: 'sheriff_speech', seat })), { t: 'sheriff_vote', candidates: cands, pk: false });
  }

  private openSheriffVote(cands: Seat[], pk: boolean): boolean {
    const voters = this.aliveSeats().filter((s) => this.canVote(s) && !cands.includes(s));
    if (voters.length === 0) {
      this.state.sheriff = 0;
      this.announce('👮 没有可以投票的玩家，本局没有警长。');
      return false;
    }
    const secs = this.options.vote_timeout_s;
    this.announce(
      `👮 警长${pk ? ' PK ' : ''}投票：请未上警的玩家在 ${secs} 秒内投给 ${this.seatList(cands)} 之一（发「投${cands[0]}」），或「弃票」。`,
    );
    this.openPhase({
      key: 'sheriff_vote',
      title: `第${this.rec.round}天·警长${pk ? 'PK' : ''}投票`,
      requests: voters.map((seat) => ({
        seat,
        channel: 'group' as const,
        prompt: `请在警长候选 ${this.seatList(cands)} 中投一票，或弃票。`,
        actions: [this.specTarget('vote', '投票', cands, `投${cands[0]}`), this.specSkip('弃票', '弃票')],
      })),
      timeoutMs: secs * 1000,
      data: { votes: {}, cands, pk },
    });
    return true;
  }

  private tallySheriff(): void {
    const ph = this.phase!;
    const votes = ph.data.votes as Record<string, number>;
    const pk = Boolean(ph.data.pk);
    const voters = Object.values(ph.pending).map((r) => r.seat).sort((a, b) => a - b);
    const counts = new Map<number, number>();
    const lines: string[] = [];
    const abstain: Seat[] = [];
    const record: Record<string, number> = {};
    for (const v of voters) {
      const t = votes[String(v)];
      if (t) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
        record[String(v)] = t;
        lines.push(`${this.label(v)} → ${this.label(t)}`);
      } else abstain.push(v);
    }
    if (abstain.length) lines.push(`弃票/未投：${this.seatList(abstain)}`);
    const top = counts.size ? Math.max(...counts.values()) : 0;
    const leaders = [...counts.entries()].filter(([, c]) => c === top).map(([s]) => s).sort((a, b) => a - b);
    const head = `👮 警长${pk ? ' PK ' : ''}投票结果：\n${lines.join('\n') || '无人投票'}`;
    const log = (result: string) => this.state.voteLog.push({ day: this.rec.round, kind: 'sheriff_vote', votes: record, abstain, result });
    if (leaders.length === 1) {
      this.state.sheriff = leaders[0]!;
      this.announce(`${head}\n${this.label(leaders[0]!)} 当选警长！`, { kind: 'sheriff', data: { seat: leaders[0] } });
      log(`${leaders[0]}号 当选警长`);
      return;
    }
    if (leaders.length > 1 && !pk) {
      this.announce(`${head}\n平票：${this.seatList(leaders)}，进入警长 PK。`);
      log(`平票 ${this.seatList(leaders)}，进入PK`);
      this.push(...leaders.map((seat): Step => ({ t: 'sheriff_speech', seat })), { t: 'sheriff_vote', candidates: leaders, pk: true });
      return;
    }
    this.state.sheriff = 0;
    this.announce(`${head}\n${leaders.length ? '再次平票' : '无人得票'}，警徽流失，本局没有警长。`);
    log('无人当选');
  }

  private openBadge(seat: Seat): boolean {
    const alive = this.aliveSeats();
    if (alive.length === 0) return false;
    const secs = this.options.badge_timeout_s;
    this.announce(`👮 警长 ${this.at(seat)} 出局，请在 ${secs} 秒内移交警徽：发「${this.exampleCmd('警徽给3', alive)}」，或发「撕警徽」。`);
    this.openPhase({
      key: 'badge',
      title: `第${this.rec.round}天·移交警徽`,
      requests: [
        {
          seat,
          channel: 'group',
          prompt: '你是出局的警长，请把警徽移交给一名存活玩家，或撕掉警徽。',
          actions: [this.specTarget('pass_badge', '移交警徽', alive, `警徽给${alive[0]}`), this.specSkip('撕警徽', '撕警徽')],
        },
      ],
      timeoutMs: secs * 1000,
      data: { from: seat },
    });
    return true;
  }

  private badgeAction(seat: Seat, input: ActionInput): string {
    const req = this.requireTurn(seat, input.action);
    if (input.action === 'pass_badge') this.phase!.data.to = this.requireTarget(req, 'pass_badge', input.target);
    else if (input.action !== 'skip') throw invalidAction('移交警徽可执行：pass_badge（移交）、skip（撕警徽）。');
    this.markDone(seat);
    return input.action === 'pass_badge' ? `你把警徽交给了 ${this.label(this.phase!.data.to)}。` : '你撕掉了警徽。';
  }

  private afterBadge(): void {
    const ph = this.phase!;
    const from = ph.data.from as Seat;
    const to = ph.data.to as Seat | undefined;
    if (to && this.isAlive(to)) {
      this.state.sheriff = to;
      this.announce(`👮 ${this.label(from)} 把警徽移交给 ${this.label(to)}，${to}号 成为新警长。`, { kind: 'sheriff', data: { seat: to } });
    } else {
      this.state.sheriff = 0;
      this.announce(`👮 ${this.label(from)} 撕掉了警徽，本局不再有警长。`);
    }
  }

  // ───────────────────────── 猎人 ─────────────────────────

  private openHunter(seat: Seat): boolean {
    const alive = this.aliveSeats();
    const who = ROLE_NAME[this.roleOf(seat)];
    this.announce(
      `🔫 ${this.label(seat)} 是${who}！请在 ${this.options.hunter_timeout_s} 秒内在群里发「${this.exampleCmd('开枪3', alive)}」带走 ${this.exampleCmd('3号', alive)}，或发「不开枪」放弃。`,
    );
    this.openPhase({
      key: 'hunter',
      title: `第${this.rec.round}天·${who}开枪`,
      requests: [
        {
          seat,
          channel: 'group',
          prompt: `你是${who}，请选择带走一名玩家，或不开枪。`,
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
    else if (input.action !== 'skip') throw invalidAction('开枪阶段可执行：shoot、skip。');
    if (input.action === 'skip') ph.data.skipped = true;
    this.markDone(seat);
    return input.action === 'shoot' ? `你选择开枪带走 ${this.label(ph.data.target)}。` : '你选择不开枪。';
  }

  /** 返回 true 表示游戏已结束。 */
  private afterHunter(): boolean {
    const ph = this.phase!;
    const hunter = ph.data.seat as Seat;
    const target = ph.data.target as Seat | undefined;
    if (!target || !this.isAlive(target)) {
      this.announce(ph.data.skipped ? `🔫 ${this.label(hunter)} 选择不开枪。` : `🔫 ${this.label(hunter)} 超时未开枪。`);
      return false;
    }
    this.markDead(target, 'shot', `第${this.rec.round}天被${ROLE_NAME[this.roleOf(hunter)]}带走`);
    this.announce(`🔫 ${this.label(hunter)} 开枪带走了 ${this.label(target)}。`, { kind: 'death', data: { seats: [target] } });
    if (this.checkWin()) return true;
    this.afterDeaths([{ seat: target, cause: 'shot' }], true);
    return false;
  }

  // ───────────────────────── 自爆 ─────────────────────────

  /** 这个座位现在能不能自爆：存活的狼、规则开启、白天发言类阶段已开放。 */
  private canExplode(seat: Seat): boolean {
    const ph = this.phase;
    return (
      this.options.self_explode &&
      this.isAlive(seat) &&
      isWolf(this.roleOf(seat)) &&
      ph !== null &&
      ph.openedAt !== null &&
      EXPLODE_KEYS.has(ph.key)
    );
  }

  /**
   * 狼人自爆：亮明身份立即出局（没有遗言，狼王也不能开枪），今天剩下的竞选、发言、投票全部取消，直接进入黑夜。
   * 警长竞选中自爆则警徽流失；自爆的是警长，警徽也随之流失。
   */
  private explode(seat: Seat): string {
    const ph = this.phase;
    if (!this.options.self_explode) throw invalidAction('本局规则不允许自爆。');
    if (!this.isAlive(seat) || !isWolf(this.roleOf(seat))) throw invalidAction('只有存活的狼人可以自爆。');
    if (!ph || ph.openedAt === null || !EXPLODE_KEYS.has(ph.key)) {
      throw invalidAction('只能在白天的发言阶段自爆（警长竞选报名/发言、起跳、发言、PK 发言），遗言、开枪、移交警徽和投票时不能自爆。');
    }
    const day = this.rec.round;
    const inElection = ELECTION_KEYS.has(ph.key);
    const wasSheriff = this.sheriffSeat() === seat;
    this.markDead(seat, 'explode', `第${day}天自爆`);
    const notes: string[] = [];
    if (inElection) {
      this.state.sheriff = 0;
      this.state.sheriffElected = true;
      notes.push('警长竞选中止，警徽流失，本局没有警长');
    } else if (wasSheriff) {
      this.state.sheriff = 0;
      notes.push('警徽随之流失，本局不再有警长');
    }
    this.announce(
      `💥 ${this.label(seat)} 自爆了！TA 是【${ROLE_NAME[this.roleOf(seat)]}】，立即出局，没有遗言。` +
        `${notes.length ? `${notes.join('；')}。` : ''}今天的发言和投票全部取消，直接进入黑夜。`,
      { kind: 'death', data: { seats: [seat], explode: true } },
    );
    this.state.voteLog.push({ day, kind: 'vote', votes: {}, abstain: [], result: `${seat}号 自爆，当天无放逐` });
    if (this.checkWin()) return '你自爆了。';
    this.state.agenda = [{ t: 'night', n: day + 1 }];
    this.proceed();
    return '你自爆了，天黑了。';
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
        ? `🗳️ PK 投票开始！请非平票玩家在 ${secs} 秒内投给 ${this.seatList(tied)} 之一，或弃票（群里发「${this.exampleCmd('投3', tied)}」，也可私聊裁判）。`
        : `🗳️ 投票开始！请所有存活玩家在 ${secs} 秒内投票（群里发「${this.exampleCmd('投3', alive)}」「弃票」，也可私聊裁判）。所有票数将在结束后统一公布。\n存活：${this.seatList(alive)}`,
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
      return `你投了 ${this.label(votes[String(seat)]!)}。`;
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
    const noVote: Seat[] = [];
    const lines: string[] = [];
    const sheriff = this.sheriffSeat();
    for (const v of voters) {
      const t = votes[String(v)];
      if (t !== undefined && t > 0) {
        const w = v === sheriff ? 1.5 : 1;
        counts.set(t, (counts.get(t) ?? 0) + w);
        record[String(v)] = t;
        lines.push(`${this.label(v)}${w !== 1 ? '（警长 1.5 票）' : ''} → ${this.label(t)}`);
      } else if (t === 0) abstain.push(v);
      else noVote.push(v); // 超时没投：和主动弃票分开标出，群里才看得出是没来得及还是不想投
    }
    if (abstain.length) lines.push(`弃票：${this.seatList(abstain)}`);
    if (noVote.length) lines.push(`未投票（超时）：${this.seatList(noVote)}`);
    abstain.push(...noVote);
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

  // ───────────────────────── 超时 ─────────────────────────

  /** 未行动视为放弃。发言阶段超时一个字没说，公告一下，免得群里不知道为什么跳到了下一个人。 */
  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    const ph = this.phase;
    if (ph && SPEECH_KEYS.has(ph.key) && !ph.data.spoke) this.announce(`⏰ ${this.label(seat)} 超时未发言，视为「过」。`);
  }

  // ───────────────────────── 动作入口 ─────────────────────────

  onAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
    if (input.action === 'team_chat') return this.teamChat(seat, input);
    if (input.action === 'explode') return this.explode(seat);
    const key = this.phase?.key;
    if (key === 'night') return this.nightAction(seat, input);
    if (key === 'witch') return this.witchAction(seat, input);
    if (key === 'hunter') return this.hunterAction(seat, input);
    if (key === 'vote' || key === 'pk_vote' || key === 'sheriff_vote') return this.voteAction(seat, input);
    if (key === 'claim') return this.claimAction(seat, input);
    if (key === 'sheriff_order') return this.sheriffOrderAction(seat, input);
    if (key === 'sheriff_signup') return this.signupAction(seat, input);
    if (key === 'badge') return this.badgeAction(seat, input);
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
    if (isWolf(role)) {
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
      if (ph?.key === 'witch' && this.pendingOf(seat) && this.witchSeesVictim(p.antidote)) view.tonight_victim = this.state.tonight.victim || '无人被刀';
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
    if (isShooter(role)) view.can_shoot = this.canShoot(seat);
    if (isWolf(role) && this.options.self_explode) {
      view.can_explode_now = this.canExplode(seat);
      view.explode = '白天发言阶段（含警长竞选报名/发言、起跳）可以 act({"action":"explode"}) 自爆：立即出局、没有遗言，当天直接结束进入黑夜；警长竞选时自爆则警徽流失。';
    }
    view.can_vote = this.canVote(seat);
    return view;
  }

  publicView(): Record<string, unknown> {
    const s = this.state;
    const ph = this.phase;
    const speaker = ph && SPEECH_KEYS.has(ph.key) ? Number(Object.keys(ph.pending)[0]) : null;
    return {
      roles_config: Object.fromEntries(ROLE_KEYS.filter((r) => s.config[r] > 0).map((r) => [ROLE_NAME[r], s.config[r]])),
      win_mode: this.winMode() === 'side' ? '屠边' : '屠城',
      sheriff: this.sheriffSeat() || null,
      today_claims: [...(s.claims ?? [])],
      witch_self_save: this.options.witch_self_save,
      witch_sees_victim: this.options.witch_sees_victim,
      round: this.rec.round,
      stage: ph ? ph.title : null,
      alive: this.players.filter((p) => p.alive).map((p) => ({ seat: p.seat, name: p.name, can_vote: this.canVote(p.seat) })),
      dead: this.players.filter((p) => !p.alive).map((p) => ({ seat: p.seat, name: p.name, died: s.deaths[String(p.seat)] ?? '' })),
      idiot_revealed: [...s.idiotRevealed],
      speaker_order: [...s.order],
      current_speaker: speaker,
      today_speeches: s.speeches.map((x) => ({ seat: x.seat, type: SPEECH_TYPE[x.kind] ?? '发言', text: x.text })),
      vote_records: s.voteLog.map((v) => ({
        day: v.day,
        type: v.kind === 'pk_vote' ? 'PK投票' : v.kind === 'sheriff_vote' ? '警长投票' : '投票',
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

    // 自爆：只有现在真能自爆的狼才认，别人说「自爆」当普通发言/闲聊，不暴露谁不是狼
    if (/^(?:我)?(?:要)?自爆$/u.test(bare) && this.canExplode(seat)) return { action: 'explode' };

    if (key === 'night') {
      if (channel !== 'private' || !this.isAlive(seat)) return null;
      const role = this.roleOf(seat);
      if (isWolf(role)) {
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
    if (key === 'claim') {
      if (!this.pendingOf(seat)) return null;
      if (/^(?:不跳|不起跳|不亮|不亮身份)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
      if (/^(?:我)?(?:要)?(?:起跳|跳|亮身份)/u.test(bare)) return { action: 'claim' };
      return null;
    }
    if (key === 'sheriff_order') {
      if (!this.pendingOf(seat)) return null;
      if (/^(?:顺序|正序|顺着|从小到大)/u.test(bare)) return { action: 'forward' };
      if (/^(?:逆序|倒序|反序|逆着|从大到小)/u.test(bare)) return { action: 'backward' };
      return null;
    }
    if (key === 'sheriff_signup') {
      if (!this.pendingOf(seat)) return null;
      if (/^(?:不上警|不竞选|不参选|不上)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
      if (/^(?:我)?(?:要)?(?:上警|竞选|参选)/u.test(bare)) return { action: 'run' };
      return null;
    }
    if (key === 'badge') {
      if (!this.pendingOf(seat)) return null;
      if (/^(?:撕警徽|撕掉警徽|撕掉|撕|不给)$/u.test(bare) || isSkipWord(bare)) return { action: 'skip' };
      const tg = targetOf(/^(?:警徽给|警徽移交给?|移交给?|传给|给)\s*(.+)$/u);
      return tg !== null ? { action: 'pass_badge', target: tg } : null;
    }
    if (key === 'vote' || key === 'pk_vote' || key === 'sheriff_vote') {
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
    if (ph.key === 'claim' || ph.key === 'sheriff_signup') {
      return this.rng.int(100) < 25 ? { action: ph.key === 'claim' ? 'claim' : 'run' } : { action: 'skip' };
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
  const base: Record<Role, number> = { werewolf: 0, wolf_king: 0, villager: 0, seer: 0, witch: 0, hunter: 0, guard: 0, idiot: 0 };
  if (options.roles) {
    Object.assign(base, options.roles);
    const sum = ROLE_KEYS.reduce((s, r) => s + base[r], 0);
    if (sum !== n) return `自定义 roles 的人数合计 ${sum}，但本局有 ${n} 名玩家，两者必须相等。`;
    const wolves = base.werewolf + base.wolf_king;
    if (wolves < 1) return '自定义 roles 至少需要 1 名狼人（werewolf 或 wolf_king）。';
    if (n - wolves < 1) return '自定义 roles 至少需要 1 名好人。';
    return base;
  }
  const preset = PRESETS[n];
  if (!preset) return `${n} 人局没有默认板子（默认支持 6~12 人），请通过 roles 选项自定义身份数量。`;
  Object.assign(base, preset);
  if (options.wolf_king && base.werewolf > 0) {
    base.werewolf -= 1;
    base.wolf_king += 1;
  }
  return base;
}

export const werewolfDefinition: GameDefinition<WerewolfOptions> = {
  type: 'werewolf',
  name: '狼人杀',
  aliases: ['狼人杀', '狼人', 'werewolf', 'wolf', 'mafia'],
  idPrefix: 'WW',
  minPlayers: 6,
  maxPlayers: 16,
  summary: '经典身份推理：狼人夜间刀人，好人白天发言投票。含预言家、女巫、猎人、守卫、白痴、狼王，狼人可自爆，身份与结算全由程序决定。',
  rules: RULES,
  playerTips:
    '- 好人：认真分析发言与投票，预言家验到狼人后要想办法让大家信任。\n- 不要只说「等预言家」「先听听」：每次发言至少点出一个怀疑对象和理由，没有信息就分析别人的发言和投票。\n- 预言家：一般第 1 天就起跳（或上警）报出查验结果，并说明今晚打算验谁；被悍跳时要对跳，讲清楚对方哪里不像。\n- 女巫：可以在合适时机报出银水（救下的人）或毒了谁来帮好人站边；被投票威胁时亮身份自保。\n- 警长：每天讨论前用 forward（顺序）/ backward（逆序）决定发言方向，想先听谁就往那边排；警长（1.5 票）最后发言时要明确归票。\n- 狼人：夜间可密谈（speak channel=team），白天不要暴露队友；可以悍跳预言家。局面不利时（队友今天要被票出、警徽要落到真预言家手里）可以 act({\"action\":\"explode\"}) 自爆，当天立即结束进入黑夜，代价是自己出局、没有遗言。狼王出局时还能开枪带走一人，优先带走神职。\n- 夜里的私密信息只写在自己的视角里，不要在群里复述工具内容。\n- 白天发言只说话，不要在发言里透露不该公开的程序信息。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    roles: '自定义身份数量 {werewolf,wolf_king,villager,seer,witch,hunter,guard,idiot}，合计须等于玩家数；13~16 人必填',
    wolf_king: '默认板子里把一只普通狼换成狼王（默认 false）。狼王出局时可开枪带走一人，被毒或自爆不能开枪',
    self_explode: '狼人白天发言阶段能否自爆（默认 true）。自爆者立即出局、无遗言，当天结束直接进入黑夜；警长竞选时自爆则警徽流失',
    win_mode: 'auto=6~7 人屠城、8 人及以上屠边（默认）；side=屠边（神职或村民全灭则狼胜）；all=屠城（好人全灭才狼胜）',
    claim_phase: '没有警长时，每天讨论前是否有起跳环节，起跳者先发言（默认 false；有警长或当天竞选警长时跳过）',
    claim_timeout_s: '起跳环节限时（秒，默认 30）',
    second_round: '每天是否进行第二轮补充发言再投票（默认 false）',
    second_round_timeout_s: '第二轮补充发言限时（秒，默认 60）',
    sheriff: "警长竞选：auto=8 人及以上开启（默认）；true/false 强制开关。警长 1.5 票、最后发言归票、出局可移交警徽",
    sheriff_signup_timeout_s: '上警报名限时（秒，默认 30）',
    sheriff_order_timeout_s: '警长决定发言顺序限时（秒，默认 30，超时按顺序）',
    badge_timeout_s: '警长出局移交警徽限时（秒，默认 30）',
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
