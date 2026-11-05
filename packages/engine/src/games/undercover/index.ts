/**
 * 谁是卧底。
 *
 * 平民拿到同一个词，卧底拿到相近的另一个词，白板（可选）没有词。
 * 所有人只知道自己的词，不知道自己的身份。每轮依次描述自己的词，然后投票淘汰一人。
 * 词对、身份、结算、胜负全部由程序决定，AI 裁判只负责转发消息。
 */
import { z } from 'zod';
import { invalidAction } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { shuffle } from '../../core/rng.js';
import { cleanSpeech, isSkipWord, normalizeText, splitVoteReason, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, PendingRequest, Seat } from '../../core/types.js';
import { CATEGORIES, allPairs } from './words.js';

export { CATEGORIES, WORD_BANK } from './words.js';

const pairSchema = z.tuple([z.string().trim().min(1).max(20), z.string().trim().min(1).max(20)]);

const optionsSchema = z
  .object({
    ...commonOptionShape,
    undercover_count: z
      .preprocess(
        (v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v),
        z.union([z.literal('auto'), z.number().int().min(1).max(5)]),
      )
      .default('auto'),
    blank_count: z.number().int().min(0).max(1).default(0),
    reveal_on_elimination: z.boolean().default(true),
    final_count: z.number().int().min(2).max(6).default(3),
    category: z.string().default('all'),
    word_pairs: z.array(pairSchema).max(200).default([]),
    forbid_word: z.boolean().default(true),
    discussion: z.boolean().default(false),
    discuss_timeout_s: secondsOption(60),
    describe_timeout_s: secondsOption(60),
    vote_timeout_s: secondsOption(45),
    pk_timeout_s: secondsOption(45),
  })
  .refine((o) => o.category === 'all' || CATEGORIES.includes(o.category), {
    message: `category 必须是 all 或：${CATEGORIES.join('、')}`,
    path: ['category'],
  })
  .refine((o) => o.word_pairs.every(([a, b]) => a.toLowerCase() !== b.toLowerCase()), {
    message: 'word_pairs 里每对词必须不同',
    path: ['word_pairs'],
  });

export type UndercoverOptions = z.infer<typeof optionsSchema>;

type Role = 'civilian' | 'undercover' | 'blank';
const ROLE_NAME: Record<Role, string> = { civilian: '平民', undercover: '卧底', blank: '白板' };

interface DescriptionRec {
  seat: Seat;
  text: string;
  stage: 'describe' | 'pk' | 'discuss';
  auto?: boolean;
}
interface VoteRec {
  stage: 'vote' | 'pk_vote';
  voter: Seat;
  /** null 表示弃票 */
  target: Seat | null;
  /** 公开的投票理由（可选） */
  reason?: string;
}
interface RoundLog {
  round: number;
  descriptions: DescriptionRec[];
  votes: VoteRec[];
  result: string;
}
interface ElimRec {
  seat: Seat;
  round: number;
  reason: 'vote' | 'violation';
  identity?: string;
}

export interface UndercoverState {
  /** [平民词, 卧底词] */
  pair: [string, string];
  roles: Record<string, Role>;
  words: Record<string, string | null>;
  rounds: RoundLog[];
  eliminated: ElimRec[];
  speeches: Record<string, string[]>;
  nextStart: Seat;
  firstSpeaker: Seat;
  elimThisRound: boolean;
  counts: { undercover: number; blank: number };
}

/** 不含任何词库词的通用描述（供随机动作使用）。 */
export const GENERIC_PHRASES = [
  '这个东西挺常见的',
  '大家应该都见过',
  '我觉得很普通',
  '平时偶尔会碰到',
  '说不上特别喜欢',
  '很多人都熟悉它',
  '小时候就认识了',
  '看起来不复杂',
];

const RULES = `## 谁是卧底

- 每位玩家只会收到**一个词**（由程序私聊 / 私有视角发放），**没有人被告知自己的身份**。
- 大多数人（平民）拿到同一个词，少数人（卧底）拿到一个相近但不同的词；可选「白板」没有词。
- **描述阶段**：按座位顺时针依次用一句话描述自己的词，**不能直接说出词本身**（\`forbid_word\` 开启时说出即淘汰）。
  - 第 1 轮从随机座位开始；之后从上一位被淘汰者的下一位开始。
- **讨论**（\`discussion\`，默认关闭）：描述结束后，按同样顺序每人再说一句，可以分析别人的描述、说出怀疑谁（同样不能说出自己的词）。
- **投票阶段**：所有存活玩家投票淘汰一个人（不能投自己，可弃票）。得票最多者出局；平票则**PK**：平票者各再描述一次，其余玩家在平票者中再投一次，仍平票则本轮无人出局。全员弃票也无人出局。
- 被淘汰者的身份（平民 / 卧底 / 白板，不含词）会公布（\`reveal_on_elimination\`）。
- **胜负**：
  - 所有卧底和白板都被淘汰 → 平民获胜。
  - 存活的卧底阵营（卧底 + 白板）人数 ≥ 存活平民，或存活总人数 ≤ \`final_count\`（默认 3）且仍有卧底阵营存活 → 卧底阵营获胜。
- 超时未描述记为「（超时未发言）」，超时未投票视为弃票。
- 投票时可以附一句理由，结果公布时和票一起显示。

**真人指令**：轮到你描述时，直接在群里发一句话即可（发出的第一条消息就是你的描述）；投票发「投3」「投票 3号」「票@昵称」或「弃票」，想附理由就写在后面：「投3 他说天气，太宽泛」。
**bot 指令**：描述 \`speak({"text":"..."})\`；投票 \`act({"action":"vote","target":3,"text":"一句理由（可选，会公开）"})\` 或 \`act({"action":"skip"})\`。`;

const TIPS = `- 你只知道自己的词，不知道自己是平民还是卧底：先从别人的描述里判断多数人的词是否和你的相近。
- 描述要有信息量，但不要太具体——太具体会暴露卧底，太含糊又像卧底。
- 发现自己可能是卧底时，向大多数靠拢；发现某人描述明显偏离时，可以投他。
- 白板没有词，要从别人的描述里推测词并蒙混过关。
- 投票时用 text 附一句简短理由（指出对方哪句描述可疑），会和票一起公开，让观众看懂你的判断。`;

function normalizeForMatch(s: string): string {
  return normalizeText(s).toLowerCase().replace(/\s+/g, '');
}

function autoUndercoverCount(n: number): number {
  return n <= 6 ? 1 : n <= 10 ? 2 : 3;
}

export class UndercoverGame extends BaseGame<UndercoverState, UndercoverOptions> {
  // ───────────────────────── 辅助 ─────────────────────────

  private roleOf(seat: Seat): Role {
    return this.state.roles[String(seat)]!;
  }

  private cur(): RoundLog {
    return this.state.rounds[this.state.rounds.length - 1]!;
  }

  private counts(): { civ: number; spy: number } {
    let civ = 0;
    let spy = 0;
    for (const s of this.aliveSeats()) (this.roleOf(s) === 'civilian' ? civ++ : spy++);
    return { civ, spy };
  }

  private timeoutFor(key: string): number {
    const o = this.options;
    return (key === 'describe' ? o.describe_timeout_s : key === 'discuss' ? o.discuss_timeout_s : key === 'vote' ? o.vote_timeout_s : o.pk_timeout_s) * 1000;
  }

  // ───────────────────────── 开局 ─────────────────────────

  start(): void {
    const o = this.options;
    const seats = this.allSeats();
    const n = seats.length;
    const pool = o.word_pairs.length > 0 ? o.word_pairs.map((p) => [p[0], p[1]] as [string, string]) : allPairs(o.category).map((p) => [p[0], p[1]] as [string, string]);
    const chosen = pool[this.rng.int(pool.length)]!;
    const pair: [string, string] = this.rng.int(2) === 0 ? [chosen[0], chosen[1]] : [chosen[1], chosen[0]];

    const ucCount = o.undercover_count === 'auto' ? autoUndercoverCount(n) : o.undercover_count;
    const blankCount = n >= 6 ? o.blank_count : 0;
    const shuffled = shuffle(this.rng, seats);
    const roles: Record<string, Role> = {};
    const words: Record<string, string | null> = {};
    for (const s of seats) {
      roles[String(s)] = 'civilian';
      words[String(s)] = pair[0];
    }
    for (const s of shuffled.slice(0, ucCount)) {
      roles[String(s)] = 'undercover';
      words[String(s)] = pair[1];
    }
    for (const s of shuffled.slice(ucCount, ucCount + blankCount)) {
      roles[String(s)] = 'blank';
      words[String(s)] = null;
    }

    const alive = this.aliveSeats();
    const first = alive[this.rng.int(alive.length)]!;
    this.rec.round = 1;
    Object.assign(this.rec.state, {
      pair,
      roles,
      words,
      rounds: [],
      eliminated: [],
      speeches: {},
      nextStart: first,
      firstSpeaker: first,
      elimThisRound: false,
      counts: { undercover: ucCount, blank: blankCount },
    } satisfies UndercoverState);

    for (const s of seats) {
      const w = words[String(s)];
      this.tell(
        s,
        w === null
          ? `⚪ 你拿到的是【白板】：没有词。\n请根据其他人的描述猜出大概是什么词，说得模棱两可一点，混在人群里不要被投出去。`
          : `🔤 你的词是：「${w}」\n轮到你时用一句话描述它，但不能直接说出这个词。\n注意：没有人知道自己的身份，请从别人的描述里判断大家的词和你的是否相同。`,
        { kind: 'word', category: 'role' },
      );
    }

    this.announce(
      `🕵️ 谁是卧底开始！本局 ${n} 人：卧底 ${ucCount} 名，白板 ${blankCount} 名，其余为平民。\n` +
        `词语已由程序随机发放（真人请查看私聊，AI 请查看自己的视角）。没有人知道自己的身份，只知道自己的词！\n` +
        `每轮依次用一句话描述自己的词（不能说出词本身），然后投票淘汰一人。`,
    );
    this.startRound(first);
  }

  private startRound(start: Seat): void {
    this.state.elimThisRound = false;
    this.state.rounds.push({ round: this.rec.round, descriptions: [], votes: [], result: '' });
    const order = this.orderFrom(start);
    this.state.firstSpeaker = order[0]!;
    this.announce(
      `📣 第 ${this.rec.round} 轮开始，存活 ${order.length} 人。发言顺序：${order.map((s) => this.label(s)).join(' → ')}`,
    );
    this.openDescribe(order, 0, 'describe');
  }

  private openDescribe(order: Seat[], idx: number, stage: 'describe' | 'pk' | 'discuss', tied?: Seat[]): void {
    const seat = order[idx]!;
    const key = stage === 'pk' ? 'pk_describe' : stage === 'discuss' ? 'discuss' : 'describe';
    const secs = stage === 'pk' ? this.options.pk_timeout_s : stage === 'discuss' ? this.options.discuss_timeout_s : this.options.describe_timeout_s;
    const discuss = stage === 'discuss';
    this.openPhase({
      key,
      title: `第${this.rec.round}轮·${stage === 'pk' ? 'PK描述' : discuss ? '讨论' : '描述'}·${seat}号`,
      timeoutMs: secs * 1000,
      requests: [
        {
          seat,
          kind: 'speech',
          prompt: discuss
            ? '讨论：用一句话说说你怀疑谁、为什么（可以引用别人的描述；不能说出自己的词）。'
            : `请用一句话描述你的词（不能直接说出词本身）。${stage === 'pk' ? '这是平票后的 PK 描述。' : ''}`,
          channel: 'group',
          actions: [
            this.specSpeech(discuss ? '直接在群里发一句话（发出的第一条消息就是你的发言）' : '直接在群里发一句话描述你的词（发出的第一条消息就是你的描述）'),
          ],
        },
      ],
      data: { seat, order, idx, stage, ...(tied ? { tied } : {}) },
    });
    this.announce(
      discuss
        ? `💬 讨论：请 ${seat}号 ${this.at(seat)} 说说你怀疑谁、为什么（一句话，限时 ${secs} 秒）`
        : `🎤 请 ${seat}号 ${this.at(seat)} ${stage === 'pk' ? 'PK 再次' : ''}描述你的词（一句话，不能说出词本身，限时 ${secs} 秒）`,
    );
  }

  // ───────────────────────── 动作 ─────────────────────────

  onAction(seat: Seat, input: ActionInput, meta: ActionMeta): string {
    const key = this.phase?.key;
    if (key === 'describe' || key === 'pk_describe' || key === 'discuss') return this.onDescribe(seat, input, meta);
    return this.onVote(seat, input);
  }

  private containsOwnWord(seat: Seat, text: string): boolean {
    const w = this.state.words[String(seat)];
    if (!w) return false;
    return normalizeForMatch(text).includes(normalizeForMatch(w));
  }

  private onDescribe(seat: Seat, input: ActionInput, meta: ActionMeta): string {
    this.requireTurn(seat, input.action);
    const text = cleanSpeech(String(input.text ?? ''));
    if (!text) throw invalidAction(this.phase?.key === 'discuss' ? '发言不能为空。' : '描述不能为空，请用一句话描述你的词。');
    const violated = this.options.forbid_word && this.containsOwnWord(seat, text);
    if (violated && meta.via === 'agent') {
      throw invalidAction('描述里不能包含你自己的词本身，请换一种说法重新描述。');
    }
    const data = this.phase!.data;
    const stage = data.stage as 'describe' | 'pk' | 'discuss';
    this.recordSpeech(seat, text, 'speech', stage === 'pk' ? 'PK' : stage === 'discuss' ? '讨论' : undefined);
    this.cur().descriptions.push({ seat, text, stage });
    if (stage !== 'discuss') (this.state.speeches[String(seat)] ??= []).push(text);
    if (violated) data.violation = true;
    this.markDone(seat);
    return violated ? '已记录（但你的描述包含了自己的词）。' : '已记录你的描述。';
  }

  private onVote(seat: Seat, input: ActionInput): string {
    const req = this.requireTurn(seat, input.action);
    const data = this.phase!.data;
    data.votes ??= {};
    if (input.action === 'skip') {
      data.votes[String(seat)] = 0;
      this.markDone(seat);
      return '你选择了弃票。';
    }
    const target = this.requireTarget(req, 'vote', input.target);
    data.votes[String(seat)] = target;
    const reason = cleanSpeech(String(input.text ?? '')).slice(0, 60);
    if (reason) (data.reasons ??= {})[String(seat)] = reason;
    this.markDone(seat);
    return `你投了 ${target} 号${reason ? '（理由会随结果公开）' : ''}。`;
  }

  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    const ph = this.phase!;
    if (ph.key === 'describe' || ph.key === 'pk_describe' || ph.key === 'discuss') {
      this.cur().descriptions.push({ seat, text: '（超时未发言）', stage: ph.data.stage, auto: true });
      this.announce(`⏰ ${this.label(seat)} 超时未发言。`);
    } else {
      ph.data.votes ??= {};
      ph.data.votes[String(seat)] = 0;
    }
  }

  // ───────────────────────── 推进 ─────────────────────────

  advance(): void {
    const key = this.phase!.key;
    if (key === 'describe' || key === 'pk_describe' || key === 'discuss') this.advanceDescribe();
    else this.tally();
  }

  private advanceDescribe(): void {
    const d = this.phase!.data;
    const seat = d.seat as Seat;
    const order = d.order as Seat[];
    const stage = d.stage as 'describe' | 'pk' | 'discuss';
    if (d.violation) {
      this.announce(`🚫 ${this.label(seat)} 的描述里说出了自己的词，违规出局！`);
      this.eliminate(seat, 'violation');
      if (this.checkWin()) return;
    }
    let idx = (d.idx as number) + 1;
    while (idx < order.length && !this.isAlive(order[idx]!)) idx++;
    if (idx < order.length) {
      this.openDescribe(order, idx, stage, d.tied);
      return;
    }
    if (stage === 'describe' && this.options.discussion) {
      const alive = order.filter((s) => this.isAlive(s));
      if (alive.length > 0) {
        this.announce('💬 描述结束，进入讨论：按同样顺序每人一句，说说你怀疑谁、为什么。');
        this.openDescribe(alive, 0, 'discuss');
        return;
      }
    }
    if (stage === 'describe' || stage === 'discuss') {
      this.openVote('vote', this.aliveSeats(), this.aliveSeats());
      return;
    }
    const tied = ((d.tied as Seat[]) ?? []).filter((s) => this.isAlive(s));
    const voters = this.aliveSeats().filter((s) => !tied.includes(s));
    if (tied.length >= 2 && voters.length > 0) {
      this.openVote('pk_vote', voters, tied);
      return;
    }
    this.endRound('PK 无法继续，本轮无人出局。');
  }

  private openVote(stage: 'vote' | 'pk_vote', voters: Seat[], targets: Seat[]): void {
    const secs = stage === 'vote' ? this.options.vote_timeout_s : this.options.pk_timeout_s;
    this.openPhase({
      key: stage,
      title: `第${this.rec.round}轮·${stage === 'vote' ? '投票' : 'PK投票'}`,
      timeoutMs: secs * 1000,
      requests: voters.map((v) => {
        const ts = targets.filter((t) => t !== v);
        return {
          seat: v,
          prompt: stage === 'vote' ? '投票淘汰你认为的卧底（不能投自己，可弃票）。' : `PK 投票：只能在 ${targets.map((t) => `${t}号`).join('、')} 中选择，也可弃票。`,
          channel: 'group' as const,
          actions: [
            { ...this.specTarget('vote', '投票', ts, '投3 / 投票 3号 / 票@昵称，可在后面附理由：投3 他说天气太宽泛'), example: `act({"action":"vote","target":${ts[0] ?? 1},"text":"一句理由（可选，会公开）"})` },
            this.specSkip('弃票', '弃票'),
          ],
        };
      }),
      data: { stage, votes: {}, targets },
    });
    const list = voters.map((v) => `${v}号${this.at(v)}`).join(' ');
    const how = `群里发「投${targets[0] ?? 3}」或「弃票」，可附理由「投${targets[0] ?? 3} 理由」，限时 ${secs} 秒`;
    this.announce(
      stage === 'vote'
        ? `🗳️ 进入投票！请 ${list} 投出你认为的卧底（${how}）。\n可投：${targets.map((t) => this.label(t)).join("、")}`
        : `⚔️ PK 投票！平票者：${targets.map((t) => this.label(t)).join("、")} 已再次描述。请 ${list} 在平票者中投票（${how}）。`,
    );
  }

  private tally(): void {
    const d = this.phase!.data;
    const stage = d.stage as 'vote' | 'pk_vote';
    const votes = d.votes as Record<string, number>;
    const reasons = (d.reasons ?? {}) as Record<string, string>;
    const counts = new Map<number, number>();
    const lines: string[] = [];
    for (const [v, t] of Object.entries(votes).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const voter = Number(v);
      const reason = t === 0 ? undefined : reasons[v];
      this.cur().votes.push({ stage, voter, target: t === 0 ? null : t, ...(reason ? { reason } : {}) });
      if (t === 0) lines.push(`${this.label(voter)} → 弃票`);
      else {
        lines.push(`${this.label(voter)} → ${this.label(t)}${reason ? `：「${reason}」` : ''}`);
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const summary = ranking.length ? ranking.map(([s, c]) => `${s}号 ${c}票`).join('，') : '全员弃票';
    this.announce(`📊 ${stage === 'vote' ? '投票' : 'PK 投票'}结果：\n${lines.join('\n')}\n票数：${summary}`, { kind: 'vote' });

    const top = ranking.length ? ranking[0]![1] : 0;
    const leaders = ranking.filter(([, c]) => c === top).map(([s]) => s);
    if (top === 0) {
      this.endRound('全员弃票，本轮无人出局。');
      return;
    }
    if (leaders.length === 1) {
      const seat = leaders[0]!;
      this.cur().result = `${seat}号 被投出`;
      this.eliminate(seat, 'vote');
      if (this.checkWin()) return;
      this.nextRound();
      return;
    }
    if (stage === 'vote') {
      const tied = leaders.sort((a, b) => a - b);
      this.announce(`⚖️ ${tied.map((s) => this.label(s)).join('、')} 平票，进入 PK！平票者依次再描述一次，其余玩家再投票。`);
      const order = this.orderFrom(tied[0]!, tied);
      this.openDescribe(order, 0, 'pk', tied);
      return;
    }
    this.endRound('PK 投票仍然平票，本轮无人出局。');
  }

  private endRound(text: string): void {
    this.cur().result = text;
    this.announce(`🤝 ${text}`);
    if (!this.state.elimThisRound) this.state.nextStart = this.nextAlive(this.state.firstSpeaker) ?? this.state.firstSpeaker;
    this.nextRound();
  }

  private nextRound(): void {
    this.rec.round += 1;
    this.startRound(this.state.nextStart);
  }

  private eliminate(seat: Seat, reason: 'vote' | 'violation'): void {
    const role = this.roleOf(seat);
    this.player(seat).alive = false;
    const identity = this.options.reveal_on_elimination ? ROLE_NAME[role] : undefined;
    this.state.eliminated.push({ seat, round: this.rec.round, reason, ...(identity ? { identity } : {}) });
    this.state.nextStart = seat + 1;
    this.state.elimThisRound = true;
    if (reason === 'violation') this.cur().result = `${seat}号 违规出局`;
    this.announce(
      `☠️ ${this.label(seat)} 被淘汰` + (identity ? `，身份是【${identity}】` : '，身份暂不公布') + '。',
      { kind: 'death', data: { seat } },
    );
  }

  private checkWin(): boolean {
    const { civ, spy } = this.counts();
    const alive = civ + spy;
    let win: 'civilian' | 'spy' | null = null;
    let reason = '';
    if (spy === 0) {
      win = 'civilian';
      reason = '所有卧底和白板都被找出来了';
    } else if (spy >= civ) {
      win = 'spy';
      reason = `存活的卧底阵营（${spy} 人）不少于平民（${civ} 人）`;
    } else if (alive <= this.options.final_count) {
      win = 'spy';
      reason = `场上只剩 ${alive} 人，卧底阵营坚持到了最后`;
    }
    if (!win) return false;
    const seats = this.allSeats();
    const winners = seats.filter((s) => (win === 'civilian') === (this.roleOf(s) === 'civilian'));
    this.finish(
      {
        winnerTeam: win === 'civilian' ? '平民' : '卧底阵营',
        winnerSeats: winners,
        reason,
        reveal: seats.map((s) => {
          const r = this.roleOf(s);
          const w = this.state.words[String(s)];
          return { seat: s, name: this.player(s).name, identity: `${ROLE_NAME[r]}（${w === null ? '无词' : w}）` };
        }),
      },
      `📖 平民词：${this.state.pair[0]}　卧底词：${this.state.pair[1]}`,
    );
    return true;
  }

  // ───────────────────────── 视角 ─────────────────────────

  privateView(seat: Seat): Record<string, unknown> {
    const w = this.state.words[String(seat)];
    const mine = this.state.speeches[String(seat)] ?? [];
    return {
      ...(w === null ? { word: null, blank: true, note: '你没有词，请根据其他人的描述推测并蒙混过关。' } : { word: w, note: '你只知道自己的词；请从别人的描述里判断大家的词是否和你的相同。' }),
      my_descriptions: mine,
    };
  }

  publicView(): Record<string, unknown> {
    const s = this.state;
    const ph = this.phase;
    const ended = this.rec.status === 'ended';
    return {
      round: this.rec.round,
      counts: s.counts,
      phase: ph ? ph.key : null,
      current_speaker: ph && (ph.key === 'describe' || ph.key === 'pk_describe' || ph.key === 'discuss') ? ph.data.seat : null,
      pk_tied: ph?.data.stage === 'pk' || ph?.key === 'pk_vote' ? (ph.data.tied ?? ph.data.targets ?? null) : null,
      order: ph && (ph.key === 'describe' || ph.key === 'pk_describe' || ph.key === 'discuss') ? ph.data.order : null,
      alive: this.aliveSeats(),
      eliminated: s.eliminated.map((e) => ({
        seat: e.seat,
        name: this.player(e.seat).name,
        round: e.round,
        reason: e.reason === 'vote' ? '被投出' : '违规说出自己的词',
        ...(e.identity ? { identity: e.identity } : {}),
      })),
      rounds: s.rounds.map((r) => ({
        round: r.round,
        descriptions: r.descriptions.map((d) => ({ seat: d.seat, stage: d.stage, text: d.text })),
        votes: r.votes.map((v) => ({ stage: v.stage, voter: v.voter, target: v.target === null ? '弃票' : v.target, ...(v.reason ? { reason: v.reason } : {}) })),
        result: r.result || (r.round === this.rec.round ? '进行中' : '无人出局'),
      })),
      ...(ended ? { words: { civilian: s.pair[0], undercover: s.pair[1] }, result: this.rec.result } : {}),
    };
  }

  // ───────────────────────── 真人指令 / 随机动作 ─────────────────────────

  override parseCommand(seat: Seat, text: string, channel: 'group' | 'private'): ActionInput | null {
    const key = this.phase?.key;
    if (!key || !this.pendingOf(seat)) return null;
    if (key === 'describe' || key === 'pk_describe' || key === 'discuss') {
      if (channel === 'private') return null;
      const t = cleanSpeech(text);
      return t ? { action: 'speech', text: t } : null;
    }
    const t = stripTrailing(normalizeText(text));
    if (/^(弃票|弃权|放弃|过|跳过|不投)$/u.test(t) || (isSkipWord(t) && t !== '')) return { action: 'skip' };
    const m = t.match(/^(?:我)?(?:投票给|投票|投给|投|票给|票)\s*(.+)$/u);
    if (!m) return null;
    const r = splitVoteReason(m[1]!, this.players);
    if (r === null) return null;
    return r.reason ? { action: 'vote', target: r.target, text: r.reason } : { action: 'vote', target: r.target };
  }

  override randomAction(seat: Seat): ActionInput | null {
    const req = this.pendingOf(seat);
    if (!req) return null;
    if (req.actions.some((a) => a.action === 'speech')) {
      return { action: 'speech', text: GENERIC_PHRASES[this.rng.int(GENERIC_PHRASES.length)]! };
    }
    const targets = req.actions.find((a) => a.action === 'vote')?.targets ?? [];
    if (targets.length === 0 || this.rng.int(8) === 0) return { action: 'skip' };
    return { action: 'vote', target: targets[this.rng.int(targets.length)]! };
  }
}

export const undercoverDefinition: GameDefinition<UndercoverOptions> = {
  type: 'undercover',
  name: '谁是卧底',
  aliases: ['谁是卧底', '卧底', 'undercover', 'spy', 'whoistheundercover'],
  idPrefix: 'UC',
  minPlayers: 4,
  maxPlayers: 12,
  summary: '每人只拿到一个词，卧底的词和大家相近但不同，没人知道自己的身份。轮流描述、投票淘汰，找出卧底。',
  rules: RULES,
  playerTips: TIPS,
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    undercover_count: "卧底人数：auto（默认，≤6人1个、≤10人2个、否则3个）或具体数字（须保证平民占严格多数）",
    blank_count: '白板人数 0 或 1（默认 0，仅 6 人及以上生效）',
    reveal_on_elimination: '被淘汰时是否公布身份（平民/卧底/白板，不公布词，默认 true）',
    final_count: '存活人数 ≤ 该值且仍有卧底阵营存活时，卧底阵营获胜（默认 3）',
    category: `词库分类：all（默认）或 ${CATEGORIES.join('、')}`,
    word_pairs: '自定义词对列表，如 [["苹果","梨"]]；设置后只从中随机抽取（谁拿哪个词仍由程序随机）',
    forbid_word: '描述里说出自己的词是否违规（默认 true；AI 会被拒绝重说，真人会被淘汰）',
    discussion: '描述后是否加一轮讨论（每人一句说怀疑谁，默认 false）',
    discuss_timeout_s: '讨论每人限时（秒，默认 60）',
    describe_timeout_s: '每人描述限时（秒，默认 60）',
    vote_timeout_s: '投票限时（秒，默认 45）',
    pk_timeout_s: 'PK 描述与 PK 投票限时（秒，默认 45）',
  },
  checkStart(n, o) {
    const uc = o.undercover_count === 'auto' ? autoUndercoverCount(n) : o.undercover_count;
    const blank = n >= 6 ? o.blank_count : 0;
    const civ = n - uc - blank;
    if (civ <= uc + blank) {
      return `${n} 人局设置 ${uc} 个卧底${blank ? ' + 1 个白板' : ''} 会让平民（${civ} 人）不占严格多数，请减少卧底人数。`;
    }
    if (n <= o.final_count) return `final_count（${o.final_count}）不能大于等于玩家人数（${n}）。`;
    return null;
  },
  create: (rec, env) => new UndercoverGame(rec, env),
};
