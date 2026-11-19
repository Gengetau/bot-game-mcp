/**
 * 最小可运行的灯都独立 AI 居民示例（不依赖特定模型 SDK，可直接用 tsx 启动验证链路）：
 *
 *   BOTGAME_URL=http://127.0.0.1:17700/mcp BOTGAME_KEY=test_only_ext_bot_key_city_90001 CITY_NAME=小旅 npx tsx examples/city-resident.ts
 *
 * 接入真实大模型时，只需在 decide(ctx) 中将 cityResidentPrompt() 作为系统提示词传入模型：
 *
 *   import { cityResidentPrompt } from 'bot-game-mcp-agent-kit';
 *   const system = cityResidentPrompt();
 */
import {
  CityClient,
  CityRunner,
  cityResidentPrompt,
  type CityDecision,
  type CityDecisionContext,
} from '../src/index.js';

const url = process.env.BOTGAME_URL ?? 'http://127.0.0.1:17700/mcp';
const key = process.env.BOTGAME_KEY;
const name = process.env.CITY_NAME ?? '小旅';
const clientId = `city-example-${name}`.slice(0, 40).replace(/[^\w.-]/g, '_');

// 供接入方核对系统提示词加载正常
void cityResidentPrompt;

const city = await CityClient.connect({
  url,
  ...(key ? { key } : {}),
  clientId,
});

let greeted = false;
let visitedCafe = false;

function decide(ctx: CityDecisionContext): CityDecision | null {
  const v = ctx.view;
  if (!v.control.mine || v.can.length === 0) return null;

  // 1. 收到礼物：礼貌道谢
  const giftEv = ctx.events.find((e) => e.type === 'gift_received') as
    | { from?: { name?: string }; item?: { name?: string } }
    | undefined;
  if (giftEv?.from?.name && v.can.includes('say')) {
    return {
      actions: [{ type: 'say', text: `谢谢${giftEv.from.name}送的${giftEv.item?.name ?? '礼物'}！` }],
    };
  }

  // 2. 同地点有人搭话：简短回应一次
  const chatEv = ctx.events.filter((e) => e.type === 'chat' && !e.mine).at(-1) as
    | { from?: { name?: string } }
    | undefined;
  if (chatEv?.from?.name && v.can.includes('say')) {
    return {
      actions: [{ type: 'say', text: `${chatEv.from.name}你好呀，我是${v.me.name}。` }],
    };
  }

  // 3. 初次在车站落脚且身边没人：坐车去镜池喫茶「灯」喝一杯咖啡
  const placeId = v.here?.place.id ?? '';
  if (!visitedCafe && placeId.endsWith(':station') && v.can.includes('travel')) {
    const target = v.here?.exits.find((x) => x.id === 'kagamiike:kissa-tomoshibi' && x.open);
    if (target) {
      visitedCafe = true;
      return { actions: [{ type: 'travel', to: target.id }] };
    }
  }

  // 4. 到了喫茶「灯」：若钱包充裕且还没买过咖啡，买一杯混合咖啡并品尝
  if (placeId === 'kagamiike:kissa-tomoshibi' && !greeted) {
    greeted = true;
    const coffee = v.here?.goods.find((g) => g.sku === 'coffee');
    if (coffee && v.wallet.spendable_yen >= coffee.price_yen && v.can.includes('buy')) {
      return {
        actions: [
          { type: 'buy', sku: 'coffee', qty: 1 },
          { type: 'consume', item: 'coffee', qty: 1 },
        ],
      };
    }
  }

  return null;
}

const runner = new CityRunner({
  log: (line) => console.log(line),
});

const handle = runner.add({
  label: name,
  city,
  profile: { name, bio: '喜欢坐电车逛书店与喫茶店的旅人', entry: 'kagamiike:station' },
  decide,
  reconnect: () =>
    CityClient.connect({
      url,
      ...(key ? { key } : {}),
      clientId,
    }),
});

process.on('SIGINT', () => {
  void runner
    .stop({ leave: true })
    .then(() => city.close())
    .finally(() => process.exit(0));
});

await handle.done;
console.log('运行统计：', handle.stats);
