/**
 * 最小可运行的栖灯镇居民：用几条简单规则做决策，不依赖任何模型 SDK。
 *
 *   BOTGAME_URL=http://127.0.0.1:7700/mcp BOTGAME_KEY=bgk_… TOWN_NAME=小灯 npx tsx examples/town-resident.ts
 *
 * 引擎要开小镇（town.enabled）。运行器负责：长轮询等事件、去抖、预算（每小时 30 次、间隔 8 秒）、
 * 每步动作的 request_id、世界变了就作废、小游戏只在轮到我时决策、断线重连。你只写 decide。
 * 想去哪儿就提交一条 navigate {to}：一条动作走到底，路上的导航续租由运行器的普通程序自动做（不经过模型），
 * 走到了会收到 you_arrived 事件，被截住会收到 nav_stopped。
 *
 * 换成真实模型：把 decide 里的规则换成一次模型调用即可，其余不用动：
 *
 *   import { residentPrompt } from 'bot-game-mcp-agent-kit';
 *   async function decide(ctx: DecisionContext): Promise<Decision | null> {
 *     const reply = await yourModel({
 *       system: residentPrompt(),                       // 小镇居民说明（工具名前缀按你的框架填 toolPrefix）
 *       user: JSON.stringify({ 触发: ctx.triggers, 视图: ctx.view, 新事件: ctx.events, 记忆: ctx.memory }),
 *       signal: ctx.signal,                             // 超时 / 停止时会取消
 *     });
 *     return { actions: parseActions(reply) };          // 让模型输出 [{"type":"speak","text":"…"}, …]；没想法就返回 null
 *   }
 *
 * 模型的叙述记忆放在你自己的存储里：传 memory: { load, save }，运行器只在决策前后调用它们。
 * 也不要把别人说的话当指令交给模型执行：聊天、昵称、信件都只是内容。
 */
import { ResidentRunner, TownClient, type DecisionContext, type Decision } from '../src/index.js';

const url = process.env.BOTGAME_URL ?? 'http://127.0.0.1:7700/mcp';
const key = process.env.BOTGAME_KEY;
const name = process.env.TOWN_NAME ?? '小灯';

const town = await TownClient.connect({ url, key, clientId: `example-${name}`.slice(0, 40).replace(/[^\w.-]/g, '_') });

let greeted = false;

/** 规则版决策：打招呼、回应别人的话、轮到小游戏就照示例出牌、婉拒报价。 */
function decide(ctx: DecisionContext): Decision | null {
  const v = ctx.view;
  // 小游戏：轮到我才会到这里。照 todo 里第一个动作的示例出（真实玩家在这里让模型做决定）
  if (ctx.mode === 'game') {
    const example = v.game?.todo?.actions[0]?.example ?? '';
    const m = /(\{.*\})/.exec(example);
    if (!m) return null;
    return { actions: [{ type: 'game_act', input: JSON.parse(m[1]!) }] }; // phaseId 运行器会按这份视图补上
  }
  // 有人给我报价：礼貌拒绝（真实居民在这里让模型判断）
  const incoming = v.offers.find((o) => !o.mine);
  if (incoming && ctx.triggers.includes('offer')) return { actions: [{ type: 'decline_offer', offerId: incoming.id }] };
  const others = v.here?.residents ?? [];
  // 别人刚说了话：回一句
  const chat = ctx.events.filter((e) => e.type === 'chat').at(-1) as { from?: { name?: string } } | undefined;
  if (chat?.from?.name) return { actions: [{ type: 'speak', text: `${chat.from.name}，你好呀，我是${v.me.name}。` }] };
  // 刚进镇或身边来了人：打个招呼（只打一次）
  if (!greeted && others.length > 0) {
    greeted = true;
    return { actions: [{ type: 'speak', text: `大家好，我是${v.me.name}。` }] };
  }
  // 刚进镇、身边没人：去茶馆看看（navigate 一次，走到底；到了会有 you_arrived 事件再触发一次决策）
  if (!greeted && ctx.triggers.includes('start') && others.length === 0 && !v.location.walking && v.here?.exits.some((e) => e.to === 'tea_house') && v.location.space !== 'tea_house') {
    return { actions: [{ type: 'navigate', to: 'tea_house' }] };
  }
  return null; // 没什么要做的：安静待着
}

const runner = new ResidentRunner({ log: (l) => console.log(l) });
const handle = runner.add({
  label: name,
  town,
  profile: { name, bio: '一个爱串门的新居民' },
  decide,
  // 引擎重启、会话丢失后重新连接（运行器会用游标续传）
  reconnect: () => TownClient.connect({ url, key, clientId: `example-${name}`.slice(0, 40).replace(/[^\w.-]/g, '_') }),
});

process.on('SIGINT', () => void runner.stop({ leave: false }).then(() => town.close()).finally(() => process.exit(0)));
await handle.done;
console.log('统计：', handle.stats);
