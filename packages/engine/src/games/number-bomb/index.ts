/**
 * 数字炸弹 —— 参考实现（最简单的游戏，用来示范 BaseGame 的用法）。
 *
 * 程序在 (min, max) 之间随机埋一个炸弹数字，所有人（包括裁判）都不知道。
 * 玩家按座位顺序轮流猜数，范围不断缩小，猜中炸弹的人「爆炸」。
 */
import { z } from 'zod';
import { invalidAction } from '../../core/errors.js';
import { BaseGame } from '../../core/game.js';
import { commonOptionShape, commonOptionsHelp, secondsOption } from '../../core/options.js';
import type { GameDefinition } from '../../core/registry.js';
import { normalizeText, parseIntLoose, stripTrailing } from '../../core/text.js';
import type { ActionInput, ActionMeta, PendingRequest, Seat } from '../../core/types.js';

const optionsSchema = z
  .object({
    ...commonOptionShape,
    min: z.number().int().min(0).max(1_000_000).default(1),
    max: z.number().int().min(3).max(1_000_000).default(100),
    mode: z.enum(['single', 'elimination']).default('single'),
    turn_timeout_s: secondsOption(60),
  })
  .refine((o) => o.max - o.min >= 3, { message: 'max - min 至少为 3（至少要有两个可猜的数）' });

export type NumberBombOptions = z.infer<typeof optionsSchema>;

interface GuessRecord {
  round: number;
  seat: Seat;
  guess: number;
  result: 'low' | 'high' | 'boom';
  auto: boolean;
}

export interface NumberBombState {
  bomb: number;
  /** 开区间下界（不可猜） */
  lo: number;
  /** 开区间上界（不可猜） */
  hi: number;
  current: Seat;
  history: GuessRecord[];
  eliminated: Seat[];
}

const RULES = `## 数字炸弹

- 程序在 (最小值, 最大值) 之间随机埋下一个炸弹数字，**任何人（包括裁判）都不知道**。
- 从程序随机选出的玩家开始，按座位号顺时针轮流猜一个**当前范围内**的整数。
- 没猜中时，程序公布炸弹在猜测数字的哪一边，范围随之缩小。
- 猜中炸弹的人「爆炸」。若范围只剩炸弹本身，轮到的人被迫踩雷。
- 模式：
  - \`single\`（默认）：一次爆炸即结束，其余玩家获胜。
  - \`elimination\`：爆炸者出局，程序重新埋雷继续，最后一名幸存者获胜。
- 超时未猜：程序随机代猜（托管）。

**真人指令**（群里直接发）：轮到你时发送数字，如「50」「猜五十」。
**bot 指令**：\`act({"action":"guess","number":50})\``;

export class NumberBombGame extends BaseGame<NumberBombState, NumberBombOptions> {
  private newBomb(): void {
    const { min, max } = this.options;
    this.state.lo = min;
    this.state.hi = max;
    this.state.bomb = min + 1 + this.rng.int(max - min - 1);
  }

  start(): void {
    this.rec.round = 1;
    Object.assign(this.rec.state, { history: [], eliminated: [] } satisfies Partial<NumberBombState>);
    this.newBomb();
    const alive = this.aliveSeats();
    this.state.current = alive[this.rng.int(alive.length)]!;
    this.announce(
      `💣 数字炸弹开始！程序已在 ${this.options.min + 1}~${this.options.max - 1} 之间埋下炸弹（没有任何人知道是多少）。\n` +
        `模式：${this.options.mode === 'single' ? '一次爆炸定胜负' : '淘汰制，最后幸存者获胜'}。由程序随机抽中的 ${this.label(this.state.current)} 先猜。`,
    );
    this.openTurn();
  }

  private openTurn(): void {
    const { lo, hi, current } = this.state;
    const prompt = `请在 ${lo + 1}~${hi - 1} 之间猜一个整数（猜中炸弹就爆炸）。`;
    this.openPhase({
      key: 'guess',
      title: `第${this.rec.round}轮·${current}号猜数`,
      timeoutMs: this.options.turn_timeout_s * 1000,
      requests: [
        {
          seat: current,
          prompt,
          channel: 'group',
          actions: [
            {
              action: 'guess',
              label: '猜数',
              params: { number: `${lo + 1}~${hi - 1} 之间的整数` },
              example: `act({"action":"guess","number":${Math.floor((lo + hi) / 2)}})`,
              command: '直接发数字，如「50」',
            },
          ],
        },
      ],
    });
    this.announce(`👉 当前范围 ${lo + 1}~${hi - 1}，请 ${this.at(current)} 猜一个数（限时 ${this.options.turn_timeout_s} 秒）。`);
  }

  onAction(seat: Seat, input: ActionInput, _meta: ActionMeta): string {
    this.requireTurn(seat, input.action);
    const n = input.number;
    const { lo, hi } = this.state;
    if (n === undefined || !Number.isInteger(n)) throw invalidAction('需要提供整数 number。');
    if (n <= lo || n >= hi) throw invalidAction(`只能猜 ${lo + 1}~${hi - 1} 之间的数。`);
    this.phase!.data.guess = n;
    this.phase!.data.auto = false;
    this.markDone(seat);
    return `你猜了 ${n}。`;
  }

  protected override timeoutDefault(seat: Seat, _req: PendingRequest): void {
    const { lo, hi } = this.state;
    this.phase!.data.guess = lo + 1 + this.rng.int(hi - lo - 1);
    this.phase!.data.auto = true;
    void seat;
  }

  advance(): void {
    const seat = this.state.current;
    const guess = Number(this.phase!.data.guess);
    const auto = Boolean(this.phase!.data.auto);
    const autoText = auto ? '（超时，程序代猜）' : '';
    if (guess === this.state.bomb) {
      this.state.history.push({ round: this.rec.round, seat, guess, result: 'boom', auto });
      this.explode(seat, `${this.label(seat)} 猜了 ${guess}${autoText}`);
      return;
    }
    const result = guess < this.state.bomb ? 'low' : 'high';
    if (result === 'low') this.state.lo = guess;
    else this.state.hi = guess;
    this.state.history.push({ round: this.rec.round, seat, guess, result, auto });
    const { lo, hi } = this.state;
    this.announce(`✅ ${this.label(seat)} 猜 ${guess}${autoText}，安全！炸弹在 ${lo + 1}~${hi - 1} 之间。`);
    const next = this.nextAlive(seat)!;
    if (hi - lo === 2) {
      this.explode(next, `范围只剩 ${lo + 1} 了，轮到的 ${this.label(next)} 被迫踩雷`);
      return;
    }
    this.state.current = next;
    this.openTurn();
  }

  private explode(seat: Seat, how: string): void {
    const bomb = this.state.bomb;
    this.announce(`💥 BOOM！${how}——炸弹正是 ${bomb}！`, { kind: 'boom', data: { seat, bomb } });
    if (this.options.mode === 'single') {
      const winners = this.allSeats().filter((s) => s !== seat);
      this.finish({
        winnerTeam: '幸存者',
        winnerSeats: winners,
        reason: `${this.label(seat)} 踩中了炸弹 ${bomb}`,
        reveal: this.players.map((p) => ({ seat: p.seat, name: p.name, identity: p.seat === seat ? '💥 踩雷' : '幸存' })),
      });
      return;
    }
    this.player(seat).alive = false;
    this.state.eliminated.push(seat);
    const alive = this.aliveSeats();
    if (alive.length <= 1) {
      this.finish({
        winnerTeam: '最后的幸存者',
        winnerSeats: alive,
        reason: `其他玩家依次踩雷出局`,
        reveal: this.players.map((p) => ({
          seat: p.seat,
          name: p.name,
          identity: p.alive ? '🏆 幸存' : `第${this.state.eliminated.indexOf(p.seat) + 1}个出局`,
        })),
      });
      return;
    }
    this.rec.round += 1;
    this.newBomb();
    this.state.current = this.nextAlive(seat)!;
    this.announce(`🔄 ${this.label(seat)} 出局！程序重新埋雷（${this.options.min + 1}~${this.options.max - 1}），第 ${this.rec.round} 轮开始。`);
    this.openTurn();
  }

  privateView(_seat: Seat): Record<string, unknown> {
    return { identity: '普通玩家', note: '数字炸弹没有私密信息：没有任何人（包括裁判）知道炸弹数字。' };
  }

  publicView(): Record<string, unknown> {
    const { lo, hi, current, history, eliminated } = this.state;
    return {
      mode: this.options.mode,
      range: { from: lo + 1, to: hi - 1 },
      current_turn: this.rec.status === 'running' ? `${current}号` : null,
      eliminated: eliminated.map((s) => this.label(s)),
      history: history.slice(-30).map((h) => ({
        round: h.round,
        seat: h.seat,
        guess: h.guess,
        result: h.result === 'boom' ? '💥爆炸' : h.result === 'low' ? '炸弹更大' : '炸弹更小',
        ...(h.auto ? { auto: true } : {}),
      })),
    };
  }

  override parseCommand(seat: Seat, text: string, _channel: 'group' | 'private'): ActionInput | null {
    if (this.phase?.key !== 'guess' || !this.pendingOf(seat)) return null;
    const t = stripTrailing(normalizeText(text)).replace(/^(我猜|猜|选|就|我选)\s*/u, '');
    const n = parseIntLoose(t);
    return n === null ? null : { action: 'guess', number: n };
  }

  override randomAction(seat: Seat): ActionInput | null {
    if (!this.pendingOf(seat)) return null;
    const { lo, hi } = this.state;
    return { action: 'guess', number: lo + 1 + this.rng.int(hi - lo - 1) };
  }
}

export const numberBombDefinition: GameDefinition<NumberBombOptions> = {
  type: 'number_bomb',
  name: '数字炸弹',
  aliases: ['数字炸弹', '炸弹', 'numberbomb', 'number-bomb', 'bomb'],
  idPrefix: 'NB',
  minPlayers: 2,
  maxPlayers: 20,
  summary: '轮流猜数，范围越缩越小，猜中炸弹的人爆炸。规则简单，适合暖场。',
  rules: RULES,
  playerTips: '- 范围大时可以大胆二分；范围很小时尽量让下一位只剩危险选择。\n- 不知道炸弹位置的不只是你——裁判也不知道。',
  optionsSchema,
  optionsHelp: {
    ...commonOptionsHelp,
    min: '范围下界（不可猜，默认 1）',
    max: '范围上界（不可猜，默认 100）',
    mode: 'single=一次爆炸结束（默认）；elimination=淘汰制直到剩一人',
    turn_timeout_s: '每次猜数限时（秒，默认 60）',
  },
  create: (rec, env) => new NumberBombGame(rec, env),
};
