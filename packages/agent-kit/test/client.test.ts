import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { BotGameClient, ToolError, playerPrompt, waitForTurn, type PlayerView } from '../src/index.js';

const KEY_A = 'bgk_test_key_A_0000000000';
const KEY_B = 'bgk_test_key_B_0000000000';

let rt: Runtime;
let http: HttpHandle;

beforeAll(async () => {
  const config = configSchema.parse({
    host: '127.0.0.1',
    port: 0,
    stateFile: null,
    seed: 'agent-kit',
    auth: {
      mode: 'keys',
      adminKeys: [],
      agents: [
        { key: KEY_A, id: '1001', name: '甲' },
        { key: KEY_B, id: '1002', name: '乙' },
      ],
    },
  });
  rt = createRuntime(config, () => undefined);
  http = await startHttpServer(rt, () => undefined);
});

afterAll(async () => {
  await http.close();
  rt.close();
});

const guessFrom = (view: PlayerView): number => {
  const m = /"number":\s*(\d+)/.exec(view.todo?.actions[0]?.example ?? '');
  if (!m) throw new Error(`todo 里没有猜数示例：${JSON.stringify(view.todo)}`);
  return Number(m[1]);
};

describe('agent-kit 客户端', () => {
  it('两个代码玩家用客户端打完一局数字炸弹', async () => {
    const a = await BotGameClient.connect({ url: http.url, key: KEY_A });
    const b = await BotGameClient.connect({ url: http.url, key: KEY_B });
    try {
      expect((await a.whoami()).identity.name).toBe('甲');
      const created = await a.createGame({
        game_type: 'number_bomb',
        group_id: 'g1',
        join_as: 'player',
        auto_referee: true,
        options: { min: 0, max: 12, mode: 'single' },
      });
      const id: string = created.summary.game_id;
      await b.joinGame(id, { as: 'player' });
      await a.startGame(id);

      // 开局后恰好一个人有回合；另一个人此时 act 会被引擎拒绝
      const va = await a.getMyView({ gameId: id });
      const vb = await b.getMyView({ gameId: id });
      expect(Boolean(va.your_turn) !== Boolean(vb.your_turn)).toBe(true);
      const [mover, waiter] = va.your_turn ? [a, b] : [b, a];
      await expect(waiter.act({ action: 'guess', number: 5 }, id)).rejects.toBeInstanceOf(ToolError);
      const turn = await waitForTurn(mover, id, { waitSeconds: 1 });
      expect(turn.your_turn).toBe(true);
      expect(turn.todo?.kind).toBeDefined();

      let status = 'running';
      for (let i = 0; i < 40 && status === 'running'; i++) {
        for (const c of [a, b]) {
          const v = await c.getMyView({ gameId: id });
          status = v.game.status;
          if (status !== 'running') break;
          if (v.your_turn) await c.act({ action: 'guess', number: guessFrom(v) }, id);
        }
      }
      expect(status).toBe('ended');
      const log = await a.getGameLog({ gameId: id });
      expect(log.complete_replay).toBe(true);
      expect(log.result).toBeDefined();
      expect(log.events.map((e: { seq: number }) => e.seq)).toEqual(log.events.map((_: unknown, i: number) => i + 1));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('prompts/player-zh.md 和代码里的提示词一致', () => {
    const md = readFileSync(new URL('../prompts/player-zh.md', import.meta.url), 'utf8');
    expect(md.trim()).toBe(playerPrompt({ toolPrefix: '{p}' }).trim());
  });
});
