/**
 * 代码写的玩家：连上引擎，报名本群的对局，轮到自己就按 todo 的示例行动。
 *
 *   BOTGAME_URL=http://127.0.0.1:7700/mcp BOTGAME_KEY=bgk_… BOTGAME_GROUP=123456 npx tsx examples/code-agent.ts
 *
 * 只演示接法：真正的 AI 玩家把 todo.prompt、public、new_events 交给模型决定动作即可。
 */
import { BotGameClient, waitForTurn } from '../src/index.js';

const url = process.env.BOTGAME_URL ?? 'http://127.0.0.1:7700/mcp';
const client = await BotGameClient.connect({ url, key: process.env.BOTGAME_KEY });
const me = await client.whoami();
console.log(`我是 ${me.identity.name}（${me.identity.id}）`);

const { games } = await client.listGames(process.env.BOTGAME_GROUP);
const game = games.find((g: { status: string }) => g.status === 'lobby' || g.status === 'running');
if (!game) {
  console.log('本群没有对局，先让裁判开房。');
  process.exit(0);
}
if (game.status === 'lobby') console.log((await client.joinGame(game.game_id, { as: 'player' })).message);

for (;;) {
  const view = await waitForTurn(client, game.game_id);
  if (view.game.status !== 'running') {
    console.log('游戏结束：', JSON.stringify(view.result));
    break;
  }
  const first = view.todo!.actions[0]!;
  console.log(`轮到我：${view.todo!.prompt}`);
  if (view.todo!.kind === 'speech') {
    const r = await client.speak('我先观察一下。', { gameId: game.game_id });
    if (r.post_to_group) console.log('（需要自己把这句话发到群里）');
  } else {
    // 示例：照第一个动作的 example 原样执行（真实玩家在这里让模型做决定）
    const m = /act\((\{.*\})\)/.exec(first.example ?? '');
    await client.act(m ? JSON.parse(m[1]!) : { action: first.action }, game.game_id);
  }
}
await client.close();
