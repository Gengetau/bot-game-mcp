/**
 * 离线模拟：用随机策略的「AI 玩家」+ 模拟裁判把一局游戏完整跑完，输出 QQ 风格的消息记录。
 * 使用假时钟，瞬间跑完；afk>0 时部分玩家会「挂机」，用来演示超时托管。
 */
import { GameManager } from '../core/manager.js';
import { SeededRng } from '../core/rng.js';
import type { ActionInput, Delivery, GameResult, Identity } from '../core/types.js';
import { createRegistry } from '../games/index.js';
import { toCq } from '../mcp/render.js';

export interface SimulateOptions {
  type: string;
  players: number;
  humans?: number;
  seed?: string | number;
  options?: Record<string, unknown>;
  /** 每个待办被「挂机」（不行动、等超时）的概率 0~1 */
  afk?: number;
  format?: 'text' | 'cq';
  maxSteps?: number;
  out?: (line: string) => void;
}

export interface SimulateResult {
  gameId: string;
  status: string;
  result: GameResult | null;
  steps: number;
  deliveries: number;
  timeouts: number;
}

/** 把结构化动作还原成真人在 QQ 里会说的话（用于演示与端到端测试指令解析）。 */
export function toHumanText(input: ActionInput): string | null {
  const t = input.target;
  switch (input.action) {
    case 'speech':
    case 'team_chat':
      return input.text ?? null;
    case 'end_speech':
      return '过';
    case 'vote':
      return t !== undefined ? `投${t}号` : null;
    case 'kill':
      return t !== undefined ? `刀${t}` : null;
    case 'check':
      return t !== undefined ? `验${t}` : null;
    case 'guard':
      return t !== undefined ? `守${t}` : null;
    case 'save':
      return '救';
    case 'poison':
      return t !== undefined ? `毒${t}` : null;
    case 'shoot':
      return t !== undefined ? `开枪${t}` : null;
    case 'claim':
      return '起跳';
    case 'run':
      return '上警';
    case 'pass_badge':
      return t !== undefined ? `警徽给${t}` : null;
    case 'guess':
      return input.number !== undefined ? String(input.number) : null;
    case 'bid':
      return input.quantity !== undefined && input.face !== undefined ? `${input.quantity}个${input.face}` : null;
    case 'challenge':
      return '开';
    default:
      return null;
  }
}

export async function simulate(o: SimulateOptions): Promise<SimulateResult> {
  const out = o.out ?? ((line: string) => console.log(line));
  const seed = o.seed ?? Date.now();
  let t = Date.UTC(2026, 0, 1, 12, 0, 0);
  const manager = new GameManager({ registry: createRegistry(), now: () => t, rng: new SeededRng(seed) });
  const decide = new SeededRng(`${seed}:afk`);
  const humanCount = Math.max(0, Math.min(o.humans ?? 0, o.players));
  const referee: Identity = { id: '90000', name: '裁判' };
  const bots: Identity[] = Array.from({ length: o.players - humanCount }, (_, i) => ({ id: String(10001 + i), name: `AI-${i + 1}` }));
  const humans = Array.from({ length: humanCount }, (_, i) => ({ userId: String(20001 + i), name: `真人${i + 1}` }));

  const { summary } = manager.createGame(referee, { type: o.type, groupId: '123456', options: o.options, joinAs: 'referee' });
  const id = summary.game_id;
  for (const b of bots) manager.joinGame(b, id, { as: 'player', selfPost: false });
  for (const h of humans) manager.addHuman(referee, id, h);
  const def = manager.describeType(o.type);
  out(`=== ${def.name} 模拟：${o.players} 名玩家（AI ${bots.length} / 真人 ${humans.length}），种子 ${String(seed)} ===`);
  manager.startGame(referee, id);
  const rec = manager.getRecord(id);

  const print = (d: Delivery) => {
    const body = o.format === 'cq' ? toCq(d.segments) : d.text;
    const head = d.target.type === 'group' ? '💬 [群]' : `🔒 [私聊 → ${d.target.name}]`;
    out(`${head} ${body.replace(/\n/g, '\n    ')}`);
  };

  let deliveries = 0;
  let timeouts = 0;
  let steps = 0;
  const maxSteps = o.maxSteps ?? 20_000;
  for (; steps < maxSteps; steps++) {
    const r = await manager.refereeStep(referee, id);
    r.deliveries.forEach(print);
    deliveries += r.deliveries.length;
    if (r.finished) break;
    const ph = rec.phase;
    if (rec.status !== 'running' || !ph || ph.openedAt === null) {
      t += 1000;
      continue;
    }
    const pending = Object.values(ph.pending).filter((p) => !p.done);
    let acted = false;
    for (const req of pending) {
      if (rec.phase !== ph || rec.status !== 'running') break;
      if (req.done) continue;
      if ((o.afk ?? 0) > 0 && decide.int(1000) < (o.afk ?? 0) * 1000) continue;
      const input = manager.randomActionFor(id, req.seat);
      if (!input) continue;
      const p = rec.players.find((pl) => pl.seat === req.seat)!;
      try {
        if (p.kind === 'agent') manager.act({ id: p.id, name: p.name }, id, input);
        else {
          const say = (msg: string) =>
            out(req.channel === 'group' ? `🙋 [群·${p.seat}号 ${p.name}] ${msg}` : `🙋 [私聊→裁判·${p.name}] ${msg}`);
          // 真人：优先用自然语言指令，程序解析不了时才让裁判提交结构化指令
          const skipCmd = req.actions.find((a) => a.action === 'skip')?.command?.split(/[\/／、]/u)[0]?.replace(/[「」"“”\s]/gu, '');
          const text = input.action === 'skip' ? skipCmd || null : toHumanText(input);
          if (text) say(text);
          const viaText = text ? manager.relayHumanMessage(referee, id, { userId: p.id, text, channel: req.channel }) : null;
          if (!viaText?.accepted) {
            manager.relayHumanMessage(referee, id, { userId: p.id, text: text ?? '', channel: req.channel, action: input });
          } else if (input.action === 'speech' && req.kind === 'speech' && rec.phase === ph && !req.done) {
            // 狼人杀等需要「过」结束发言的游戏
            say('过');
            manager.relayHumanMessage(referee, id, { userId: p.id, text: '过', channel: req.channel });
          }
        }
        acted = true;
      } catch {
        // 随机动作偶尔不合法（例如阶段刚刚变化），忽略即可
      }
    }
    if (acted) t += 1500;
    else if (pending.length === 0) {
      // 都行动完了，只是在等阶段最短时长（例如狼人杀夜晚），快进到可以结算的时刻
      t = Math.max(t + 1000, ph.openedAt + ph.minDurationMs);
    } else if (ph.deadline !== null && t < ph.deadline) {
      // 有人没行动（挂机）：跳到截止时间，触发程序托管
      t = ph.deadline + 1;
      timeouts += 1;
    } else t += 1000;
  }
  const res = rec.result;
  out('');
  out(
    res
      ? `=== 结束：${res.winnerTeam} 获胜（${res.reason}）。共 ${deliveries} 条消息，${timeouts} 次超时托管 ===`
      : `=== 未正常结束（${rec.status}） ===`,
  );
  return { gameId: id, status: rec.status, result: res, steps, deliveries, timeouts };
}
