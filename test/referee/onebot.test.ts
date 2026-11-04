import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configSchema } from '../../src/config.js';
import { cqToPlain, parseOptionTokens, runReferee, segmentsToCq } from '../../src/referee/onebot.js';
import { startHttpServer, type HttpHandle } from '../../src/server/http.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';
import { FakeOneBot, callText, type ApiCall } from './onebot-fake.js';

const KEYS = { ref: 'bgk_referee_key_000000', ai: 'bgk_ai_key_0000000000', admin: 'bgk_admin_key_00000000' };
const GROUP = '1127334885';
const OWNER = '1156798139';
const REF_ID = '2362232313';
const AI_ID = '3127771953';
const OTHER = '55555';

describe('pure helpers', () => {
  it('converts OneBot segments to CQ and back to plain text', () => {
    const cq = segmentsToCq([
      { type: 'reply', data: { id: '42' } },
      { type: 'at', data: { qq: REF_ID } },
      { type: 'text', data: { text: ' 投3号 [a,b]' } },
      { type: 'image', data: { file: 'x.png' } },
    ]);
    expect(cq).toBe(`[CQ:reply,id=42][CQ:at,qq=${REF_ID}] 投3号 &#91;a,b&#93;[CQ:image]`);
    expect(cqToPlain(cq)).toBe('投3号 [a,b]');
    expect(segmentsToCq('纯字符串')).toBe('纯字符串');
  });

  it('parses key=value option tokens and JSON', () => {
    expect(parseOptionTokens(['min=0', 'max=10', 'mode=single', 'nudge_ai=true', 'junk'])).toEqual({ min: 0, max: 10, mode: 'single', nudge_ai: true });
    expect(parseOptionTokens(['{"win_mode":', '"all"}'])).toEqual({ win_mode: 'all' });
  });
});

describe('OneBot referee against the real engine', () => {
  let rt: Runtime;
  let http: HttpHandle;
  let qq: FakeOneBot;
  const ac = new AbortController();
  const logs: string[] = [];
  let refereeDone: Promise<void>;

  beforeAll(async () => {
    const config = configSchema.parse({
      host: '127.0.0.1',
      port: 0,
      stateFile: null,
      seed: 'referee-test',
      auth: {
        mode: 'keys',
        adminKeys: [KEYS.admin],
        agents: [
          { key: KEYS.ref, id: REF_ID, name: '妮娅' },
          { key: KEYS.ai, id: AI_ID, name: '克蕾雅' },
        ],
      },
    });
    rt = createRuntime(config, () => undefined);
    http = await startHttpServer(rt, () => undefined);
    qq = new FakeOneBot('tok-secret');
    await qq.start();
    refereeDone = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qq.url,
      onebotToken: 'tok-secret',
      groupId: GROUP,
      admins: [OWNER],
      bots: [AI_ID],
      defaultOptions: { nudge_ai: true, turn_timeout_s: 60 },
      stepWaitSeconds: 2,
      sendGapMs: 0,
      signal: ac.signal,
      log: (l) => logs.push(l),
    });
    await qq.waitForConnection();
  }, 20_000);

  afterAll(async () => {
    ac.abort();
    await Promise.race([refereeDone, new Promise((res) => setTimeout(res, 5000))]);
    await qq.close();
    await http.close();
    rt.close();
  });

  const groupMsg = (uid: string, nick: string, message: unknown) =>
    qq.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: Date.now(), sender: { user_id: Number(uid), nickname: nick, card: '' }, message, raw_message: '' });
  const privateMsg = (uid: string, nick: string, text: string) =>
    qq.emit({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: Date.now(), sender: { user_id: Number(uid), nickname: nick }, message: [{ type: 'text', data: { text } }], raw_message: text });
  const text = (t: string) => [{ type: 'text', data: { text: t } }];
  const groupSend = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;

  it('plays a number bomb with one AI (via MCP) and one human (via QQ)', async () => {
    // 非管理员不能开房
    groupMsg(OTHER, '路人', text('/桌游 数字炸弹'));
    const denied = await qq.waitForCall((c) => groupSend(c) && callText(c).includes('只有管理员能开房'));
    expect(callText(denied)).toContain(`@${OTHER}`);

    // 管理员 @裁判 开房，选项用 key=value
    let mark = qq.calls.length;
    groupMsg(OWNER, '主人', [{ type: 'at', data: { qq: REF_ID } }, ...text(' /桌游 数字炸弹 min=0 max=10 mode=single')]);
    const opened = await qq.waitForCall((c) => groupSend(c) && callText(c).includes('开局'), 10_000, mark);
    expect(callText(opened)).toContain('报名');

    // AI 通过 MCP 报名
    const ai = new Client({ name: 'ai', version: '1.0.0' });
    await ai.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.ai}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await ai.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(t);
      return JSON.parse(t);
    };
    const list = await call('list_games', { group_id: GROUP });
    const gameId: string = list.games[0].game_id;
    expect(list.games[0].status).toBe('lobby');
    await call('join_game', { game_id: gameId, join_as: 'player', self_post: false });

    // bot 账号在群里说「加入」不会被转交；真人「加入」会（带回复引用的噪音）
    mark = qq.calls.length;
    groupMsg(AI_ID, '克蕾雅', text('加入'));
    groupMsg(OWNER, '主人', [{ type: 'reply', data: { id: '1' } }, ...text('加入')]);
    const joined = await qq.waitForCall((c) => groupSend(c) && callText(c).includes('加入了'), 10_000, mark);
    expect(callText(joined)).toContain('主人');
    expect(qq.calls.slice(mark).filter((c) => groupSend(c) && callText(c).includes('加入了'))).toHaveLength(1);

    // 开局
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 开局'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('数字炸弹开始'), 10_000, mark);

    // 私聊闲聊不会出错；游戏中非指令群消息也不会出错
    privateMsg(OWNER, '主人', '你好呀');
    groupMsg(OWNER, '主人', text('大家好'));

    // AI：轮到自己就按范围猜；真人：被 @ 时在群里发数字
    let finished = false;
    const aiLoop = (async () => {
      while (!finished) {
        const v = await call('get_my_view', { game_id: gameId, wait_seconds: 2 });
        if (v.game?.status && v.game.status !== 'running') break;
        if (v.todo) {
          const m = String(v.todo.prompt).match(/(\d+)~(\d+)/);
          const lo = Number(m![1]);
          const hi = Number(m![2]);
          await call('act', { game_id: gameId, action: 'guess', number: lo + Math.floor(Math.random() * (hi - lo + 1)) }).catch(() => undefined);
        }
      }
    })();
    const humanLoop = (async () => {
      let seen = 0;
      while (!finished) {
        const c = await qq.waitForCall((x) => groupSend(x) && (callText(x).includes(`@${OWNER}`) || callText(x).includes('BOOM')), 15_000, seen);
        seen = qq.calls.indexOf(c) + 1;
        const t = callText(c);
        if (t.includes('BOOM')) break;
        const m = t.match(/范围 (\d+)~(\d+)/);
        if (!m) continue;
        const lo = Number(m[1]);
        const hi = Number(m[2]);
        groupMsg(OWNER, '主人', text(String(lo + Math.floor(Math.random() * (hi - lo + 1)))));
      }
    })();
    const over = await qq.waitForCall((c) => groupSend(c) && callText(c).includes('游戏结束'), 30_000);
    finished = true;
    await Promise.all([aiLoop, humanLoop]);
    expect(callText(over)).toContain('获胜');

    // 顺序与去重：群消息的 seq 单调（裁判没有重复发送同一条）
    const sent = qq.calls.filter(groupSend).map(callText);
    expect(new Set(sent.filter((t) => t.includes('当前范围'))).size).toBe(sent.filter((t) => t.includes('当前范围')).length);
    // 结束后裁判把对局放下，可以再开
    await new Promise((res) => setTimeout(res, 300));
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 状态'));
    const status = await qq.waitForCall((c) => groupSend(c) && callText(c).includes('没有对局'), 10_000, mark);
    expect(status).toBeTruthy();
    await ai.close();
  }, 60_000);

  it('rejects a wrong OneBot token', async () => {
    const bad = new FakeOneBot('right');
    await bad.start();
    const ac2 = new AbortController();
    const lines: string[] = [];
    const done = runReferee({ url: http.url, key: KEYS.ref, onebotUrl: bad.url, onebotToken: 'wrong', groupId: '1', stepWaitSeconds: 1, signal: ac2.signal, log: (l) => lines.push(l) });
    await new Promise((res) => setTimeout(res, 800));
    expect(bad.connections).toBe(0);
    ac2.abort();
    await done;
    await bad.close();
    expect(lines.some((l) => l.includes('连接断开') || l.includes('无法连接'))).toBe(true);
  }, 15_000);
});
