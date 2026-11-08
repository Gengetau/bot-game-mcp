import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configSchema, createRuntime, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { cqToPlain, parseOptionTokens, runReferee, segmentsToCq } from '../src/index.js';
import { FakeOneBot, callText, type ApiCall } from './onebot-fake.js';

const KEYS = { ref: 'bgk_referee_key_000000', ai: 'bgk_ai_key_0000000000', ai2: 'bgk_ai2_key_000000000', admin: 'bgk_admin_key_00000000' };
const GROUP = '1127334885';
const OWNER = '1156798139';
const REF_ID = '2362232313';
const AI_ID = '3127771953';
const OTHER = '55555';
const AI2_ID = '2742096348';
let msgSeq = 0; // 真实 OneBot 的 message_id 唯一；裁判按它去重，所以这里不能用时间戳

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
  const keysDir = mkdtempSync(join(tmpdir(), 'botgame-referee-keys-'));
  // 剧本杀：演示剧本 + 两张线索图（开场地图群发，人物剧本附图私发）
  const scriptsDir = mkdtempSync(join(tmpdir(), 'botgame-referee-scripts-'));
  const assetsDir = mkdtempSync(join(tmpdir(), 'botgame-referee-assets-'));
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  {
    const demo = JSON.parse(readFileSync(join(__dirname, '../../engine/examples/jubensha/demo-rainy-bookshop.json'), 'utf8'));
    demo.images = [
      { id: 'map', file: 'map.png', caption: '书屋平面图' },
      { id: 'badge', file: 'badge.png', caption: '你的名牌' },
    ];
    demo.intro_images = ['map'];
    for (const r of demo.roles) r.images = ['badge'];
    writeFileSync(join(scriptsDir, 'demo.json'), JSON.stringify(demo));
    mkdirSync(join(assetsDir, 'demo'));
    writeFileSync(join(assetsDir, 'demo', 'map.png'), PNG);
    writeFileSync(join(assetsDir, 'demo', 'badge.png'), PNG);
  }
  const ac = new AbortController();
  const logs: string[] = [];
  let refereeDone: Promise<void>;

  beforeAll(async () => {
    const config = configSchema.parse({
      host: '127.0.0.1',
      port: 0,
      stateFile: null,
      seed: 'referee-test',
      scriptsDir,
      assetsDir,
      refereeIds: [REF_ID, AI_ID, AI2_ID],
      auth: {
        mode: 'keys',
        adminKeys: [KEYS.admin],
        issuedKeysFile: join(keysDir, 'keys.json'),
        agents: [
          { key: KEYS.ref, id: REF_ID, name: '妮娅' },
          { key: KEYS.ai, id: AI_ID, name: '克蕾雅' },
          { key: KEYS.ai2, id: AI2_ID, name: '艾莉希娅' },
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
      quietGraceMs: 300,
      turnRemindDelayMs: 300,
      selfInPool: false, // 这个常驻裁判和下面几个测试共用引擎：不让它把妮娅登记进抽签池
      signal: ac.signal,
      log: (l) => logs.push(l),
    });
    await qq.waitForConnection();
  }, 20_000);

  afterAll(async () => {
    if (process.env.REF_DEBUG) console.log(['=== shared logs', ...logs, '=== shared calls', ...qq.calls.map((c) => `${c.action} ${callText(c)}`)].join('\n'));
    ac.abort();
    await Promise.race([refereeDone, new Promise((res) => setTimeout(res, 5000))]);
    await qq.close();
    await http.close();
    rt.close();
    rmSync(keysDir, { recursive: true, force: true });
    rmSync(scriptsDir, { recursive: true, force: true });
    rmSync(assetsDir, { recursive: true, force: true });
  });

  const groupMsg = (uid: string, nick: string, message: unknown) =>
    qq.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message, raw_message: '' });
  const privateMsg = (uid: string, nick: string, text: string) =>
    qq.emit({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick }, message: [{ type: 'text', data: { text } }], raw_message: text });
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

  it('reminds a bot whose turn it is when it talks in the group instead of calling the tool, once per turn', async () => {
    let mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 数字炸弹 min=0 max=10 mode=single'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('报名'), 10_000, mark);
    const ai = new Client({ name: 'ai-turn', version: '1.0.0' });
    await ai.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.ai}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await ai.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(t);
      return JSON.parse(t);
    };
    const gameId: string = (await call('list_games', { group_id: GROUP })).games[0].game_id;
    await call('join_game', { game_id: gameId, join_as: 'player', self_post: false });
    groupMsg(OWNER, '主人', text('加入'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('加入了'), 10_000, mark);
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 开局'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('数字炸弹开始'), 10_000, mark);
    const isReminder = (c: ApiCall) => groupSend(c) && callText(c).includes('在群里直接说的话不算数');

    // 不是自己的回合在群里说话：不提醒
    let finished = false;
    let reminded = false;
    const aiLoop = (async () => {
      while (!finished) {
        const v = await call('get_my_view', { game_id: gameId, wait_seconds: 2 });
        if (v.game?.status && v.game.status !== 'running') break;
        if (!v.todo) continue;
        const m = String(v.todo.prompt).match(/(\d+)~(\d+)/);
        const lo = Number(m![1]);
        if (!reminded) {
          // 第一次轮到它：先在群里说（程序收不到），被 @ 提醒后再说一遍，也只提醒一次
          const at = qq.calls.length;
          groupMsg(AI_ID, '克蕾雅', text(`我猜 ${lo}`));
          const r = await qq.waitForCall(isReminder, 10_000, at);
          expect(callText(r)).toContain(`@${AI_ID}`);
          groupMsg(AI_ID, '克蕾雅', text(`我猜 ${lo}！`));
          await new Promise((res) => setTimeout(res, 900));
          expect(qq.calls.slice(at).filter(isReminder)).toHaveLength(1);
          reminded = true;
        }
        await call('act', { game_id: gameId, action: 'guess', number: lo }).catch(() => undefined);
      }
    })();
    const humanLoop = (async () => {
      let seen = mark;
      while (!finished) {
        const c = await qq.waitForCall((x) => groupSend(x) && (callText(x).includes(`@${OWNER}`) || callText(x).includes('BOOM')), 15_000, seen);
        seen = qq.calls.indexOf(c) + 1;
        const t = callText(c);
        if (t.includes('BOOM')) break;
        const m = t.match(/范围 (\d+)~(\d+)/);
        if (!m) continue;
        groupMsg(OWNER, '主人', text(m[1]!));
      }
    })();
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('游戏结束'), 40_000, mark);
    finished = true;
    await Promise.all([aiLoop, humanLoop]);
    expect(reminded).toBe(true);
    // 真人（不在 turn_ids 里）在群里说话从不触发提醒
    expect(qq.calls.slice(mark).filter((c) => isReminder(c) && callText(c).includes(`@${OWNER}`))).toHaveLength(0);
    await ai.close();
    await new Promise((res) => setTimeout(res, 300));
  }, 60_000);

  it('jubensha: sends clue images to the group and by private chat as OneBot image segments', async () => {
    const humans = ['61001', '61002', '61003', '61004'];
    let mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 剧本杀'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('报名'), 10_000, mark);
    for (const [i, uid] of humans.entries()) groupMsg(uid, `玩家${i + 1}`, text('加入'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('玩家4'), 10_000, mark);
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 开局'));
    const isImg = (c: ApiCall) => Array.isArray(c.params.message) && (c.params.message as any[]).some((x) => x.type === 'image');
    const grp = await qq.waitForCall((c) => groupSend(c) && isImg(c), 15_000, mark);
    const gImg = (grp.params.message as any[]).find((x) => x.type === 'image');
    expect(Buffer.from(String(gImg.data.file).replace('base64://', ''), 'base64').equals(PNG)).toBe(true);
    expect(callText(grp)).toContain('书屋平面图');
    const priv = await qq.waitForCall((c) => c.action === 'send_private_msg' && isImg(c), 15_000, mark);
    expect(humans).toContain(String(priv.params.user_id));
    expect(callText(priv)).toContain('你的名牌');
    // 文字私聊照旧
    expect(qq.calls.slice(mark).some((c) => c.action === 'send_private_msg' && callText(c).includes('你的人物剧本'))).toBe(true);
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 中止'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('中止'), 10_000, mark);
    await new Promise((res) => setTimeout(res, 300));
  }, 40_000);

  it('werewolf night: recalls and mutes an alive AI player who talks in the group, then lifts the mute', async () => {
    const humans = ['62001', '62002', '62003', '62004'];
    let mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 狼人杀 night_timeout_s=60'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('报名'), 10_000, mark);
    const ai = new Client({ name: 'ai-ww', version: '1.0.0' });
    await ai.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.ai}` } } }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await ai.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(t);
      return JSON.parse(t);
    };
    const gameId: string = (await call('list_games', { group_id: GROUP })).games[0].game_id;
    await call('join_game', { game_id: gameId, join_as: 'player', self_post: true });
    for (const [i, uid] of humans.entries()) groupMsg(uid, `玩家${i + 1}`, text('加入'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('玩家4'), 10_000, mark);
    // 再来一个 AI 凑够 6 人
    const ai2 = new Client({ name: 'ai-ww2', version: '1.0.0' });
    await ai2.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.ai2}` } } }));
    await ai2.callTool({ name: 'join_game', arguments: { game_id: gameId, join_as: 'player', self_post: true } });
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 开局'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('天黑'), 15_000, mark);
    await new Promise((res) => setTimeout(res, 600));
    // 夜里真人在群里说话不管；AI 说话：撤回 + 禁言 + 提醒
    mark = qq.calls.length;
    groupMsg(humans[0]!, '玩家1', text('好黑啊'));
    groupMsg(AI_ID, '克蕾雅', text('我是预言家'));
    const mid = msgSeq;
    const del = await qq.waitForCall((c) => c.action === 'delete_msg', 10_000, mark);
    expect(del.params.message_id).toBe(mid);
    const ban = await qq.waitForCall((c) => c.action === 'set_group_ban', 10_000, mark);
    expect(String(ban.params.user_id)).toBe(AI_ID);
    expect(Number(ban.params.duration)).toBeGreaterThan(0);
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('禁言到天亮'), 10_000, mark);
    expect(qq.calls.slice(mark).filter((c) => c.action === 'delete_msg')).toHaveLength(1);
    // 对局结束（这里是中止）后解除禁言
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 中止'));
    const unban = await qq.waitForCall((c) => c.action === 'set_group_ban' && Number(c.params.duration) === 0, 15_000, mark);
    expect(String(unban.params.user_id)).toBe(AI_ID);
    await ai.close();
    await ai2.close();
    await new Promise((res) => setTimeout(res, 300));
  }, 60_000);

  it('mutes anyone not in the running game (bots and humans, admins exempt) who talks in the group, and lifts it when the game ends', async () => {
    const humans = ['63001', '63002'];
    let mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 数字炸弹 min=0 max=100 mode=single'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('报名'), 10_000, mark);
    for (const [i, uid] of humans.entries()) groupMsg(uid, `玩家${i + 1}`, text('加入'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('玩家2'), 10_000, mark);
    // 报名阶段 bot 说话不管
    groupMsg(AI_ID, '克蕾雅', text('我先看看'));
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 开局'));
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('数字炸弹开始'), 10_000, mark);
    await new Promise((res) => setTimeout(res, 600));
    // 对局中：管理员说话不管，指令不管；没参加的 bot 插话：撤回 + 禁言 + 提醒一次
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('加油'));
    groupMsg(AI_ID, '克蕾雅', text('/桌游 状态'));
    groupMsg(AI_ID, '克蕾雅', text('我觉得是 50'));
    const mid = msgSeq;
    const del = await qq.waitForCall((c) => c.action === 'delete_msg', 10_000, mark);
    expect(del.params.message_id).toBe(mid);
    const ban = await qq.waitForCall((c) => c.action === 'set_group_ban', 10_000, mark);
    expect(String(ban.params.user_id)).toBe(AI_ID);
    expect(Number(ban.params.duration)).toBeGreaterThan(0);
    await qq.waitForCall((c) => groupSend(c) && callText(c).includes('没有参加本局'), 10_000, mark);
    // 再说一句：只撤回，不重复禁言和提醒
    groupMsg(AI_ID, '克蕾雅', text('还有'));
    await qq.waitForCall((c) => c.action === 'delete_msg' && c.params.message_id === msgSeq, 10_000, mark);
    await new Promise((res) => setTimeout(res, 300));
    const after = qq.calls.slice(mark);
    expect(after.filter((c) => c.action === 'delete_msg')).toHaveLength(2);
    expect(after.filter((c) => c.action === 'set_group_ban')).toHaveLength(1);
    expect(after.filter((c) => groupSend(c) && callText(c).includes('没有参加本局'))).toHaveLength(1);
    // 第一次撤回失败：隔一会儿重试，直到撤掉
    mark = qq.calls.length;
    let failed = 0;
    qq.failWhen = (c) => c.action === 'delete_msg' && failed++ === 0;
    groupMsg(AI_ID, '克蕾雅', text('再说一句'));
    const retryId = msgSeq;
    const isRetry = (c: { action: string; params: Record<string, unknown> }) => c.action === 'delete_msg' && c.params.message_id === retryId;
    await qq.waitForCall((c) => isRetry(c) && qq.calls.slice(mark).filter(isRetry).length >= 2, 10_000, mark);
    qq.failWhen = null;
    expect(qq.calls.slice(mark).filter(isRetry)).toHaveLength(2);
    // 没参加的真人观众也一样
    mark = qq.calls.length;
    groupMsg(OTHER, '路人', text('我猜 30'));
    const hban = await qq.waitForCall((c) => c.action === 'set_group_ban' && String(c.params.user_id) === OTHER, 10_000, mark);
    expect(Number(hban.params.duration)).toBeGreaterThan(0);
    // 本局的真人玩家说话不管
    groupMsg(humans[0]!, '玩家1', text('好紧张'));
    await new Promise((res) => setTimeout(res, 300));
    expect(qq.calls.slice(mark).some((c) => c.action === 'set_group_ban' && String(c.params.user_id) === humans[0])).toBe(false);
    // 结束（中止）后解除
    mark = qq.calls.length;
    groupMsg(OWNER, '主人', text('/桌游 中止'));
    await qq.waitForCall((c) => c.action === 'set_group_ban' && Number(c.params.duration) === 0 && String(c.params.user_id) === AI_ID, 15_000, mark);
    await qq.waitForCall((c) => c.action === 'set_group_ban' && Number(c.params.duration) === 0 && String(c.params.user_id) === OTHER, 15_000, mark);
    await new Promise((res) => setTimeout(res, 300));
  }, 40_000);

  it('auto-starts a lobby once the target player count is reached, and after the quiet period otherwise', async () => {
    const qq2 = new FakeOneBot('tok2');
    await qq2.start();
    const ac2 = new AbortController();
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qq2.url,
      onebotToken: 'tok2',
      groupId: GROUP,
      admins: [OWNER],
      bots: [AI_ID],
      stepWaitSeconds: 1,
      sendGapMs: 0,
      autoStartSeconds: 2,
      selfInPool: false,
      signal: ac2.signal,
      log: (l) => logs.push(l),
    });
    await qq2.waitForConnection();
    const send2 = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;
    const msg2 = (uid: string, nick: string, t: string) =>
      qq2.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t });
    try {
      // 「/桌游 数字炸弹 2」：凑满 2 人立刻开局，不用再发「开局」
      let mark = qq2.calls.length;
      msg2(OWNER, '主人', '/桌游 数字炸弹 2');
      const opened = await qq2.waitForCall((c) => send2(c) && callText(c).includes('报名'), 10_000, mark);
      expect(callText(opened)).toContain('2 人');
      msg2(OWNER, '主人', '加入');
      msg2('777', '路人甲', '加入');
      const started = await qq2.waitForCall((c) => send2(c) && callText(c).includes('数字炸弹开始'), 15_000, mark);
      expect(callText(started)).toBeTruthy();
      expect(qq2.calls.slice(mark).some((c) => send2(c) && callText(c).includes('秒内没有新人'))).toBe(false);
      msg2(OWNER, '主人', '/桌游 中止');
      await qq2.waitForCall((c) => send2(c) && callText(c).includes('中止'), 10_000, mark);

      // 没指定人数：够最少人数后先预告，安静 2 秒自动开局
      mark = qq2.calls.length;
      msg2(OWNER, '主人', '/桌游 数字炸弹');
      await qq2.waitForCall((c) => send2(c) && callText(c).includes('报名'), 10_000, mark);
      msg2(OWNER, '主人', '加入');
      msg2('777', '路人甲', '加入');
      const notice = await qq2.waitForCall((c) => send2(c) && callText(c).includes('秒内没有新人'), 15_000, mark);
      expect(callText(notice)).toMatch(/已有 2 人报名/);
      const auto = await qq2.waitForCall((c) => send2(c) && callText(c).includes('数字炸弹开始'), 15_000, mark);
      expect(qq2.calls.indexOf(auto)).toBeGreaterThan(qq2.calls.indexOf(notice));
      expect(qq2.calls.slice(mark).filter((c) => send2(c) && callText(c).includes('秒内没有新人'))).toHaveLength(1);
      // 收尾：别把进行中的对局留给下一个测试
      mark = qq2.calls.length;
      msg2(OWNER, '主人', '/桌游 中止');
      await qq2.waitForCall((c) => send2(c) && callText(c).includes('中止'), 10_000, mark);
    } finally {
      if (process.env.REF_DEBUG) console.log(['--- logs', ...logs, '--- calls', ...qq2.calls.map((c) => `${c.action} ${callText(c)}`)].join('\n'));
      ac2.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await qq2.close();
    }
  }, 60_000);

  it('draws the referee among registered voices, posts a wheel, speaks with the drawn account and keeps its own model idle', async () => {
    const qqMain = new FakeOneBot('t0');
    const qqA = new FakeOneBot('tA');
    const qqB = new FakeOneBot('tB');
    await Promise.all([qqMain.start(), qqA.start(), qqB.start()]);
    const ac2 = new AbortController();
    const lines: string[] = [];
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qqMain.url,
      onebotToken: 't0',
      groupId: GROUP,
      admins: [OWNER],
      bots: [AI_ID, AI2_ID],
      voices: [
        { key: KEYS.ai, onebotUrl: qqA.url, onebotToken: 'tA' },
        { key: KEYS.ai2, onebotUrl: qqB.url, onebotToken: 'tB' },
      ],
      hostId: 'test-host',
      selfInPool: false,
      defaultOptions: { turn_timeout_s: 60 },
      stepWaitSeconds: 1,
      sendGapMs: 0,
      autoStartSeconds: 1,
      signal: ac2.signal,
      log: (l) => lines.push(l),
    });
    await Promise.all([qqMain.waitForConnection(), qqA.waitForConnection(), qqB.waitForConnection()]);
    const sendOf = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;
    const emitAll = (ev: Record<string, unknown>) => {
      for (const q of [qqMain, qqA, qqB]) q.emit(ev);
    };
    const msgAll = (uid: string, nick: string, t: string) =>
      emitAll({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t });
    const mcp = async (key: string) => {
      const c = new Client({ name: 'brain', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      return c;
    };
    const callOn = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
      const r: any = await c.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(t);
      return JSON.parse(t);
    };
    const brainA = await mcp(KEYS.ai);
    const brainB = await mcp(KEYS.ai2);
    try {
      let mark = qqMain.calls.length;
      msgAll(OWNER, '主人', '/桌游 数字炸弹');
      await qqMain.waitForCall((c) => sendOf(c) && callText(c).includes('报名'), 10_000, mark);
      const list = await callOn(brainA, 'list_games', { group_id: GROUP });
      const gameId: string = list.games[0].game_id;
      // 两个 bot 的「脑子」各自报名当玩家；主人加入。群消息三路连接都会收到，但只处理一次
      await callOn(brainA, 'join_game', { game_id: gameId, join_as: 'player' });
      await callOn(brainB, 'join_game', { game_id: gameId, join_as: 'player' });
      msgAll(OWNER, '主人', '加入');
      const joined = await qqMain.waitForCall((c) => sendOf(c) && callText(c).includes('加入了'), 10_000, mark);
      expect(callText(joined)).toContain('主人');
      // 开局：主账号发转盘图和开局公告；裁判在两个 bot 里抽
      const wheel = await qqMain.waitForCall((c) => sendOf(c) && Array.isArray(c.params.message) && c.params.message.some((s: any) => s.type === 'image' && String(s.data?.file).startsWith('base64://')), 20_000, mark);
      expect(wheel).toBeTruthy();
      await qqMain.waitForCall((c) => sendOf(c) && callText(c).includes('开局！'), 20_000, mark);
      expect(qqMain.calls.slice(mark).filter((c) => sendOf(c) && callText(c).includes('加入了'))).toHaveLength(1);
      const sum = (await callOn(brainA, 'list_games', { group_id: GROUP })).games[0];
      expect([AI_ID, AI2_ID]).toContain(sum.referee_id);
      expect(sum.referee_hosted_by).toBe('test-host');
      expect(sum.referee_draw.candidates.map((c: any) => c.id).sort()).toEqual([AI_ID, AI2_ID].sort());
      const drawn = sum.referee_id === AI_ID ? qqA : qqB;
      const other = sum.referee_id === AI_ID ? qqB : qqA;
      const drawnBrain = sum.referee_id === AI_ID ? brainA : brainB;
      const playerBrain = sum.referee_id === AI_ID ? brainB : brainA;
      // 游戏消息用抽中的账号发；没抽中的账号和主账号都不发游戏消息
      const first = await drawn.waitForCall((c) => sendOf(c) && callText(c).includes('当前范围'), 20_000);
      expect(first).toBeTruthy();
      expect(other.calls.some((c) => sendOf(c))).toBe(false);
      expect(qqMain.calls.slice(mark).some((c) => sendOf(c) && callText(c).includes('当前范围'))).toBe(false);
      // 抽中账号自己的模型：空结果，不能推进
      const idle = await callOn(drawnBrain, 'referee_step', { game_id: gameId });
      expect(idle.hosted).toBe(true);
      expect(idle.deliveries).toHaveLength(0);
      const view = await callOn(drawnBrain, 'get_my_view', { game_id: gameId });
      expect(view.you.role).toBe('referee');
      expect(view.you.hosted_by).toBe('test-host');
      // 另一个 bot 是玩家；真人的指令照常被转交（只转交一次）
      const pv = await callOn(playerBrain, 'get_my_view', { game_id: gameId });
      expect(pv.you.role).not.toBe('referee');
      expect(lines.some((l) => l.includes('由本进程代行'))).toBe(true);
      // 收尾：别把进行中的对局留给下一个测试
      mark = qqMain.calls.length;
      msgAll(OWNER, '主人', '/桌游 中止');
      // 中止公告由本局裁判账号（抽中的那个）发
      await drawn.waitForCall((c) => sendOf(c) && callText(c).includes('中止'), 10_000);
    } finally {
      if (process.env.REF_DEBUG) console.log(['--- lines', ...lines, '--- main', ...qqMain.calls.map((c) => `${c.action} ${callText(c)}`), '--- A', ...qqA.calls.map((c) => `${c.action} ${callText(c)}`), '--- B', ...qqB.calls.map((c) => `${c.action} ${callText(c)}`)].join('\n'));
      ac2.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await Promise.all([brainA.close(), brainB.close(), qqMain.close(), qqA.close(), qqB.close()]);
    }
  }, 60_000);

  it('follower mode: an external bot process only offers its own account and hosts when drawn, never answers commands', async () => {
    const qqB = new FakeOneBot('tB');
    await qqB.start();
    const ac2 = new AbortController();
    const lines: string[] = [];
    const done = runReferee({
      url: http.url,
      key: KEYS.ai2,
      onebotUrl: qqB.url,
      onebotToken: 'tB',
      groupId: GROUP,
      follower: true,
      hostId: 'ext-host',
      stepWaitSeconds: 1,
      sendGapMs: 0,
      signal: ac2.signal,
      log: (l) => lines.push(l),
    });
    await qqB.waitForConnection();
    const sendOf = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;
    const msgBoth = (uid: string, nick: string, t: string) => {
      const ev = { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t };
      qq.emit(ev);
      qqB.emit(ev);
    };
    const brainB = new Client({ name: 'brain', version: '1.0.0' });
    await brainB.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.ai2}` } } }));
    const brainA = new Client({ name: 'brain', version: '1.0.0' });
    await brainA.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.ai}` } } }));
    const callB = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await brainB.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(t);
      return JSON.parse(t);
    };
    try {
      // 指令只有主机的裁判（qq）回应，跟随者不出声
      let mark = qq.calls.length;
      msgBoth(OWNER, '主人', '/桌游 帮助');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('桌游指令'), 10_000, mark);
      mark = qq.calls.length;
      msgBoth(OWNER, '主人', '/桌游 数字炸弹');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('报名'), 10_000, mark);
      const gameId: string = (await callB('list_games', { group_id: GROUP })).games[0].game_id;
      // 外接 bot 的脑子报名当玩家；跟随者发现自己报名了，登记进抽签池。再加一个本地 bot，凑够「抽走一人仍够开局」
      await callB('join_game', { game_id: gameId, join_as: 'player' });
      await brainA.callTool({ name: 'join_game', arguments: { game_id: gameId, join_as: 'player' } });
      msgBoth(OWNER, '主人', '加入');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('加入了'), 10_000, mark);
      const deadline = Date.now() + 10_000;
      let hosted: string[] = [];
      while (Date.now() < deadline) {
        const g = (await callB('list_games', { group_id: GROUP })).games[0];
        hosted = (g.lobby ?? []).filter((e: any) => e.hosted).map((e: any) => String(e.id));
        if (hosted.includes(AI2_ID)) break;
        await new Promise((res) => setTimeout(res, 300));
      }
      expect(hosted).toEqual([AI2_ID]);
      expect(qqB.calls.some(sendOf)).toBe(false);
      // 主机那边开局：池里只有外接账号，抽中它；之后游戏消息由跟随者用自己的账号发
      msgBoth(OWNER, '主人', '/桌游 开局');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('开局！'), 10_000, mark);
      const sum = (await callB('list_games', { group_id: GROUP })).games[0];
      expect(sum.referee_id).toBe(AI2_ID);
      expect(sum.referee_hosted_by).toBe('ext-host');
      await qqB.waitForCall((c) => sendOf(c) && callText(c).includes('数字炸弹开始'), 15_000);
      expect(qq.calls.slice(mark).some((c) => groupSend(c) && callText(c).includes('数字炸弹开始'))).toBe(false);
      expect(logs.some((l) => l.includes('只旁观'))).toBe(true);
      // 收尾
      mark = qq.calls.length;
      msgBoth(OWNER, '主人', '/桌游 中止');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('中止'), 10_000, mark);
    } finally {
      ac2.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await Promise.all([brainA.close(), brainB.close(), qqB.close()]);
    }
  }, 60_000);

  it('bot-commands: a bot account (also a voice of this process) may open a room and start it, but not abort; other bot chatter stays ignored', async () => {
    const qq3 = new FakeOneBot('tok3');
    const qq3v = new FakeOneBot('tok3v');
    await Promise.all([qq3.start(), qq3v.start()]);
    const ac3 = new AbortController();
    const lines: string[] = [];
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qq3.url,
      onebotToken: 'tok3',
      groupId: GROUP,
      admins: [OWNER],
      bots: [AI_ID],
      botCommands: true,
      // 线上玩家 bot 同时也是本进程的嗓子账号：它自己发的指令不能被当成「自己的话」丢掉
      voices: [{ key: KEYS.ai, onebotUrl: qq3v.url, onebotToken: 'tok3v' }],
      hostId: 'bot-cmd-host',
      stepWaitSeconds: 1,
      sendGapMs: 0,
      autoStartSeconds: 0,
      selfInPool: false,
      signal: ac3.signal,
      log: (l) => {
        lines.push(l);
        logs.push(l);
      },
    });
    await Promise.all([qq3.waitForConnection(), qq3v.waitForConnection()]);
    const send3 = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;
    // 两个账号都在群里，同一条群消息两边都会收到
    const msg3 = (uid: string, nick: string, t: string) => {
      const ev = { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t };
      qq3.emit(ev);
      qq3v.emit(ev);
    };
    try {
      // bot 开房
      let mark = qq3.calls.length;
      msg3(AI_ID, '克蕾雅', '/桌游 数字炸弹');
      const opened = await qq3.waitForCall((c) => send3(c) && callText(c).includes('报名'), 10_000, mark);
      expect(callText(opened)).toContain('数字炸弹');
      // bot 的「加入」不是真人报名，不转交；真人两个报名
      msg3(AI_ID, '克蕾雅', '加入');
      msg3(OWNER, '主人', '加入');
      msg3('777', '路人甲', '加入');
      await qq3.waitForCall((c) => send3(c) && callText(c).includes('路人甲'), 10_000, mark);
      expect(qq3.calls.slice(mark).some((c) => send3(c) && callText(c).includes('克蕾雅') && callText(c).includes('报名'))).toBe(false);
      // bot 不能中止
      msg3(AI_ID, '克蕾雅', '/桌游 中止');
      await new Promise((res) => setTimeout(res, 500));
      expect(qq3.calls.slice(mark).some((c) => send3(c) && callText(c).includes('已取消'))).toBe(false);
      // bot 开局
      msg3(AI_ID, '克蕾雅', '/桌游 开局');
      await qq3.waitForCall((c) => send3(c) && callText(c).includes('数字炸弹开始'), 15_000, mark);
      // 收尾由管理员中止
      mark = qq3.calls.length;
      msg3(OWNER, '主人', '/桌游 中止');
      await qq3.waitForCall((c) => send3(c) && callText(c).includes('中止'), 10_000, mark);
      expect(lines.some((l) => l.includes('bot 可开房'))).toBe(true);
    } finally {
      if (process.env.REF_DEBUG) console.log(['--- bot-commands calls', ...qq3.calls.map((c) => `${c.action} ${callText(c)}`)].join('\n'));
      ac3.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await qq3.close();
      await qq3v.close();
    }
  }, 60_000);

  it('lobby-timeout: a lobby that never fills is cancelled after the quiet period', async () => {
    const qq4 = new FakeOneBot('tok4');
    await qq4.start();
    const ac4 = new AbortController();
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qq4.url,
      onebotToken: 'tok4',
      groupId: GROUP,
      admins: [OWNER],
      bots: [AI_ID],
      stepWaitSeconds: 1,
      sendGapMs: 0,
      autoStartSeconds: 0,
      lobbyTimeoutSeconds: 2,
      selfInPool: false,
      signal: ac4.signal,
      log: (l) => logs.push(l),
    });
    await qq4.waitForConnection();
    const send4 = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;
    const msg4 = (uid: string, nick: string, t: string) =>
      qq4.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t });
    try {
      let mark = qq4.calls.length;
      msg4(OWNER, '主人', '/桌游 数字炸弹');
      await qq4.waitForCall((c) => send4(c) && callText(c).includes('报名'), 10_000, mark);
      msg4(OWNER, '主人', '加入'); // 只有 1 人，不够最少人数
      const cancelled = await qq4.waitForCall((c) => send4(c) && callText(c).includes('已取消'), 15_000, mark);
      expect(callText(cancelled)).toContain('只有 1 人');
      // 房间真的没了，可以再开
      mark = qq4.calls.length;
      msg4(OWNER, '主人', '/桌游 状态');
      await qq4.waitForCall((c) => send4(c) && callText(c).includes('没有对局'), 10_000, mark);
    } finally {
      ac4.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await qq4.close();
    }
  }, 60_000);

  it('main-plays: the main account joins as a player through its own model; it hosts only when no other referee can be drawn', async () => {
    const GROUP_MP = '1127300555';
    const qqM = new FakeOneBot('tm');
    const qqA = new FakeOneBot('ta');
    await Promise.all([qqM.start(), qqA.start()]);
    const ac5 = new AbortController();
    const lines: string[] = [];
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qqM.url,
      onebotToken: 'tm',
      groupId: GROUP_MP,
      admins: [OWNER],
      bots: [AI_ID],
      voices: [{ key: KEYS.ai, onebotUrl: qqA.url, onebotToken: 'ta' }],
      hostId: 'main-plays-host',
      mainPlays: true,
      issuerKey: KEYS.admin, // 管理员中止用（没配 --key-issuer 也生效）
      defaultOptions: { turn_timeout_s: 60 },
      stepWaitSeconds: 1,
      sendGapMs: 0,
      autoStartSeconds: 1,
      signal: ac5.signal,
      log: (l) => lines.push(l),
    });
    await Promise.all([qqM.waitForConnection(), qqA.waitForConnection()]);
    const sendM = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP_MP;
    const msgAll = (uid: string, nick: string, t: string) => {
      const ev = { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP_MP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t };
      qqM.emit(ev);
      qqA.emit(ev);
    };
    const mcp = async (key: string) => {
      const c = new Client({ name: 'brain', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      return c;
    };
    const callOn = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
      const r: any = await c.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? '';
      if (r.isError) throw new Error(t);
      return JSON.parse(t);
    };
    const brainMain = await mcp(KEYS.ref); // 主账号自己的模型
    const brainA = await mcp(KEYS.ai);
    const allSends = () => [...qqM.calls, ...qqA.calls].filter(sendM).map(callText);
    try {
      // —— 1. 人数只够最少：主账号报名了玩家，但抽不出别的裁判 → 它坐庄 ——
      let mark = qqM.calls.length;
      msgAll(OWNER, '主人', '/桌游 数字炸弹');
      await qqM.waitForCall((c) => sendM(c) && callText(c).includes('报名'), 10_000, mark);
      let gameId: string = (await callOn(brainMain, 'list_games', { group_id: GROUP_MP })).games[0].game_id;
      // 开房时主账号已经以「都行」报名（抽不中就上场），它的模型不用自己报名
      const lobby0 = (await callOn(brainMain, 'get_my_view', { game_id: gameId })) as any;
      expect(JSON.stringify(lobby0)).toContain('either');
      msgAll(OWNER, '主人', '加入');
      // 主账号 + 主人 = 2 人，但主账号得坐庄 → 有效 1 人，不够最少 2 人，不会开
      await new Promise((res) => setTimeout(res, 2500));
      expect(allSends().some((t) => t.includes('数字炸弹开始'))).toBe(false);
      msgAll('777', '路人甲', '加入');
      const sitOut = await qqM.waitForCall((c) => sendM(c) && callText(c).includes('坐庄'), 15_000, mark);
      expect(callText(sitOut)).toContain('妮娅');
      await qqM.waitForCall((c) => sendM(c) && callText(c).includes('数字炸弹开始'), 15_000, mark);
      let sum = (await callOn(brainMain, 'list_games', { group_id: GROUP_MP })).games[0];
      expect(sum.referee_id).toBe(REF_ID);
      expect(sum.referee_hosted_by).toBe('main-plays-host');
      expect(sum.players).toBe(2);
      mark = qqM.calls.length;
      msgAll(OWNER, '主人', '/桌游 中止');
      await qqM.waitForCall((c) => sendM(c) && callText(c).includes('中止'), 10_000, mark);

      // —— 2. 人数充裕：主账号和 bot 都报名玩家，抽走一个仍够 → 程序在两人里抽裁判，另一个上场 ——
      mark = qqM.calls.length;
      msgAll(OWNER, '主人', '/桌游 数字炸弹');
      await qqM.waitForCall((c) => sendM(c) && callText(c).includes('报名'), 10_000, mark);
      gameId = (await callOn(brainMain, 'list_games', { group_id: GROUP_MP })).games[0].game_id;
      await callOn(brainA, 'join_game', { game_id: gameId, join_as: 'player' });
      msgAll(OWNER, '主人', '加入');
      msgAll('777', '路人甲', '加入');
      const started = await Promise.race([
        qqM.waitForCall((c) => sendM(c) && callText(c).includes('数字炸弹开始'), 15_000, mark),
        qqA.waitForCall((c) => sendM(c) && callText(c).includes('数字炸弹开始'), 15_000),
      ]);
      expect(callText(started)).toBeTruthy();
      sum = (await callOn(brainMain, 'list_games', { group_id: GROUP_MP })).games[0];
      expect([REF_ID, AI_ID]).toContain(sum.referee_id);
      expect(sum.referee_hosted_by).toBe('main-plays-host');
      expect(sum.players).toBe(3);
      expect(sum.referee_draw.candidates.map((c: any) => c.id).sort()).toEqual([AI_ID, REF_ID].sort());
      expect(allSends().filter((t) => t.includes('坐庄'))).toHaveLength(1); // 只有第一局坐庄
      // 没抽中的那个账号是玩家，能看到自己的行动面板
      const playerBrain = sum.referee_id === REF_ID ? brainA : brainMain;
      const view = await callOn(playerBrain, 'get_my_view', { game_id: gameId });
      expect(view.you?.role ?? view.you?.seat).toBeDefined();
      mark = qqM.calls.length;
      msgAll(OWNER, '主人', '/桌游 中止');
      await Promise.race([
        qqM.waitForCall((c) => sendM(c) && callText(c).includes('中止'), 10_000, mark),
        qqA.waitForCall((c) => sendM(c) && callText(c).includes('中止'), 10_000),
      ]);
      // —— 3. bot 自己调 create_game 开房：开房后马上「加入」也能登记；主账号也报名（都行）；能自动开局 ——
      await new Promise((res) => setTimeout(res, 500));
      const created = await callOn(brainA, 'create_game', { game_type: 'number_bomb', group_id: GROUP_MP, join_as: 'player' });
      const gid3: string = created.summary?.game_id ?? created.game_id;
      const [markM3, markA3] = [qqM.calls.length, qqA.calls.length];
      const newSends = () => [...qqM.calls.slice(markM3), ...qqA.calls.slice(markA3)].filter(sendM).map(callText);
      const until = async (pred: (t: string) => boolean, ms: number) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (newSends().some(pred)) return;
          await new Promise((res) => setTimeout(res, 100));
        }
        throw new Error('等不到群消息');
      };
      msgAll(OWNER, '主人', '加入');
      await until((t) => t.includes('主人 加入了'), 10_000);
      await until((t) => t.includes('数字炸弹开始'), 15_000);
      const g3 = (await callOn(brainMain, 'list_games', { group_id: GROUP_MP })).games.find((x: any) => x.game_id === gid3);
      expect(g3.status).toBe('running');
      expect(g3.players).toBe(2); // 克蕾雅、主人、妮娅 三人里抽一个当裁判
      expect(lines.some((l) => l.includes('处理消息失败') || l.includes('引擎拒绝'))).toBe(false);
      await callOn(brainA, 'abort_game', { game_id: gid3 });
      await until((t) => t.includes('已中止'), 10_000);

      // —— 4. 复现 NB-292D：bot 开房、主账号报名「都行」后 bot 马上开局 → 两人都上场、程序自动主持，
      //        主账号既不是房主也不是裁判；管理员「/桌游 中止」要能结束它（靠管理员密钥） ——
      await new Promise((res) => setTimeout(res, 1500));
      const c4 = await callOn(brainA, 'create_game', { game_type: 'number_bomb', group_id: GROUP_MP, join_as: 'player', auto_referee: true });
      const gid4: string = c4.summary?.game_id ?? c4.game_id;
      const joinedEnd = Date.now() + 10_000;
      while (!lines.some((l) => l.includes(`加入 ${gid4}`)) && Date.now() < joinedEnd) await new Promise((res) => setTimeout(res, 100));
      await callOn(brainA, 'start_game', { game_id: gid4 });
      const g4 = (await callOn(brainMain, 'list_games', { group_id: GROUP_MP })).games.find((x: any) => x.game_id === gid4);
      expect(g4.status).toBe('running');
      expect(g4.referee_id ?? null).toBeNull(); // 程序自动主持
      await expect(callOn(brainMain, 'abort_game', { game_id: gid4 })).rejects.toThrow(/房主|裁判|管理员/); // 主账号自己的密钥中止不了
      const [m4, a4] = [qqM.calls.length, qqA.calls.length];
      msgAll(OWNER, '主人', '/桌游 中止');
      const sends4 = () => [...qqM.calls.slice(m4), ...qqA.calls.slice(a4)].filter(sendM).map(callText);
      const end4 = Date.now() + 10_000;
      while (!sends4().some((t) => t.includes('已中止')) && Date.now() < end4) await new Promise((res) => setTimeout(res, 100));
      expect(sends4().some((t) => t.includes(`${gid4} 已中止`))).toBe(true);
      expect(sends4().some((t) => t.includes('只有房主'))).toBe(false);
      expect(lines.some((l) => l.includes('主账号参赛'))).toBe(true);
    } finally {
      if (process.env.REF_DEBUG) console.log(['--- main-plays logs', ...lines, '--- calls', ...qqM.calls.map((c) => `${c.action} ${callText(c)}`)].join('\n'));
      ac5.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await Promise.all([brainMain.close(), brainA.close(), qqM.close(), qqA.close()]);
    }
  }, 90_000);

  it('key-issuer: a voice account hands out engine keys over private chat', async () => {
    const qqM = new FakeOneBot('tm2');
    const qqX = new FakeOneBot('tx2');
    await Promise.all([qqM.start(), qqX.start()]);
    const acK = new AbortController();
    const lines: string[] = [];
    // 引擎里也有不对应 QQ 号的密钥（对局复盘用的 gamerecap）：同步时不能当成 bot 去 @
    const adminCall = async (name: string, args: Record<string, unknown>) => {
      const c = new Client({ name: 't', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.admin}` } } }));
      try {
        await c.callTool({ name, arguments: args });
      } finally {
        await c.close();
      }
    };
    await adminCall('issue_key', { qq_id: 'gamerecap', name: '复盘' });
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qqM.url,
      onebotToken: 'tm2',
      groupId: GROUP,
      admins: [OWNER],
      bots: [AI_ID],
      voices: [{ key: KEYS.ai2, onebotUrl: qqX.url, onebotToken: 'tx2' }],
      keyIssuer: AI2_ID,
      issuerKey: KEYS.admin,
      publicUrl: 'https://example.test/mcp',
      maxKeysPerOwner: 2,
      stepWaitSeconds: 1,
      sendGapMs: 0,
      selfInPool: false,
      hostId: 'key-issuer-host',
      signal: acK.signal,
      log: (l) => lines.push(l),
    });
    await Promise.all([qqM.waitForConnection(), qqX.waitForConnection()]);
    const pm = (q: FakeOneBot, uid: string, nick: string, t: string) =>
      q.emit({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick }, message: text(t), raw_message: t });
    const privTo = (uid: string) => (c: ApiCall) => c.action === 'send_private_msg' && String(c.params.user_id) === uid;
    const replyText = (c: ApiCall) => (c.params.message as any[]).map((s) => String(s.data?.text ?? '')).join('');
    const whoamiWith = async (key: string) => {
      const c = new Client({ name: 't', version: '1' });
      await c.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      try {
        const r: any = await c.callTool({ name: 'whoami', arguments: {} });
        return JSON.parse(r.content[0].text).identity;
      } finally {
        await c.close();
      }
    };
    try {
      // 不在群里的人不能申请
      let mark = qqX.calls.length;
      qqX.failActions.add('get_group_member_info');
      pm(qqX, OTHER, '路人', '申请密钥 90001 小外');
      let r = await qqX.waitForCall(privTo(OTHER), 10_000, mark);
      expect(replyText(r)).toContain('不在群');
      for (let i = 0; i < 50 && !lines.some((l) => l.includes('密钥由 艾莉希娅')); i++) await new Promise((res) => setTimeout(res, 100));
      expect(lines.some((l) => l.includes('密钥由 艾莉希娅'))).toBe(true);
      expect(lines.some((l) => l.includes('[keys] 已发放密钥的 bot：无'))).toBe(true);
      await adminCall('revoke_key', { qq_id: 'gamerecap' });
      qqX.failActions.delete('get_group_member_info');

      // 群成员申请：收到密钥，密钥立刻可用，身份是申请时写的昵称
      // 申请人不是好友：普通私聊被拒，改走群临时会话（带 group_id）
      qqX.failWhen = (c) => c.action === 'send_private_msg' && c.params.group_id === undefined;
      mark = qqX.calls.length;
      pm(qqX, OTHER, '路人', '/桌游 申请密钥 90001 小外');
      r = await qqX.waitForCall((c) => privTo(OTHER)(c) && c.params.group_id !== undefined, 10_000, mark);
      expect(replyText(r)).toContain('✅ 已给 小外(90001) 发放密钥');
      expect(replyText(r)).toContain('https://example.test/mcp');
      expect(Number(r.params.group_id)).toBe(Number(GROUP));
      qqX.failWhen = null;
      const key1 = replyText(r).match(/bgk_[A-Za-z0-9_-]{32}/)![0];
      expect(await whoamiWith(key1)).toEqual({ id: '90001', name: '小外' });
      expect(qqX.calls.slice(mark).some((c) => c.action === 'get_group_member_info' && String(c.params.user_id) === '90001')).toBe(true);

      // 好友和临时会话都发不出去（对方还没发起过临时会话）：群里 @ 对方，等他私聊一句后补发
      qqX.failWhen = (c) => c.action === 'send_private_msg' && String(c.params.user_id) === '4444';
      mark = qqX.calls.length;
      pm(qqX, '4444', '新人', '密钥');
      const tip = await qqX.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('发起临时会话'), 10_000, mark);
      expect(callText(tip)).toContain('@4444');
      qqX.failWhen = null;
      mark = qqX.calls.length;
      pm(qqX, '4444', '新人', '在吗');
      r = await qqX.waitForCall(privTo('4444'), 10_000, mark);
      expect(replyText(r)).toContain('申请密钥 <bot的QQ号>');
      expect(lines.some((l) => l.includes('给 4444 补发 1 条私聊'))).toBe(true);

      // 发错格式 / 只发「密钥」得到帮助；主账号的私聊不管密钥
      mark = qqX.calls.length;
      pm(qqX, OTHER, '路人', '密钥');
      r = await qqX.waitForCall(privTo(OTHER), 10_000, mark);
      expect(replyText(r)).toContain('申请密钥 <bot的QQ号>');
      mark = qqM.calls.length;
      pm(qqM, OTHER, '路人', '申请密钥 90009 不该发');
      await new Promise((res) => setTimeout(res, 500));
      expect(qqM.calls.slice(mark).some((c) => c.action === 'send_private_msg')).toBe(false);

      qqM.failWhen = (c) => c.action === 'send_group_msg' && Array.isArray(c.params.message) && (c.params.message as any[]).some((m) => m.type === 'at' && String(m.data?.qq) === '90077');
      // 别人（星璃的模型）直接在引擎里发的密钥：开房时同步进 bots，同样会 @ 它
      {
        const c = new Client({ name: 't', version: '1' });
        await c.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${KEYS.admin}` } } }));
        const ir: any = await c.callTool({ name: 'issue_key', arguments: { qq_id: '90077', name: '外发', owner: '888' } });
        expect(ir.isError).toBeFalsy();
        await c.close();
      }
      // 新 bot 自动算进 bots：开房时会 @ 它
      mark = qqM.calls.length;
      qqM.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(OWNER), message_id: ++msgSeq, sender: { user_id: Number(OWNER), nickname: '主人', card: '' }, message: text('/桌游 数字炸弹'), raw_message: '' });
      const nudge = await qqM.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('AI 玩家请调用'), 10_000, mark);
      expect(callText(nudge)).toContain('@90001');
      expect(callText(nudge)).toContain('@90077');
      // QQ 侧解析不了某个 @（例如 bot 不在群里）时整条被拒：裁判去掉 @ 重发，其余内容照常送达
      const retry = await qqM.waitForCall((c) => c.action === 'send_group_msg' && Array.isArray(c.params.message) && (c.params.message as any[]).every((m) => m.type !== 'at') && callText(c).includes('AI 玩家请调用'), 10_000, mark);
      expect(callText(retry)).toContain('@90077');
      qqM.failWhen = null;
      qqM.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(OWNER), message_id: ++msgSeq, sender: { user_id: Number(OWNER), nickname: '主人', card: '' }, message: text('/桌游 中止'), raw_message: '' });
      await qqM.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('取消'), 10_000, mark);
      // 群里的帮助会提到找谁申请
      mark = qqM.calls.length;
      qqM.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(OWNER), message_id: ++msgSeq, sender: { user_id: Number(OWNER), nickname: '主人', card: '' }, message: text('/桌游 帮助'), raw_message: '' });
      const help = await qqM.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('桌游指令'), 10_000, mark);
      expect(callText(help)).toContain('私聊 艾莉希娅 发「申请密钥');

      // 每人最多 2 把；别人不能撤销；申请人能撤销，撤销后密钥失效
      mark = qqX.calls.length;
      pm(qqX, OTHER, '路人', '申请密钥 90002 小外二');
      r = await qqX.waitForCall(privTo(OTHER), 10_000, mark);
      expect(replyText(r)).toContain('90002');
      mark = qqX.calls.length;
      pm(qqX, OTHER, '路人', '申请密钥 90003 小外三');
      r = await qqX.waitForCall(privTo(OTHER), 10_000, mark);
      expect(replyText(r)).toContain('最多 2 把');
      mark = qqX.calls.length;
      pm(qqX, '777', '甲', '撤销密钥 90001');
      r = await qqX.waitForCall(privTo('777'), 10_000, mark);
      expect(replyText(r)).toContain('不是你申请的');
      mark = qqX.calls.length;
      pm(qqX, OWNER, '主人', '密钥列表');
      r = await qqX.waitForCall(privTo(OWNER), 10_000, mark);
      expect(replyText(r)).toContain(`小外(90001) 申请人 ${OTHER}`);
      mark = qqX.calls.length;
      pm(qqX, OTHER, '路人', '撤销密钥 90001');
      r = await qqX.waitForCall(privTo(OTHER), 10_000, mark);
      expect(replyText(r)).toContain('已作废 小外(90001)');
      await expect(whoamiWith(key1)).rejects.toThrow();
      // 申请人自己就是 bot：昵称可以省略
      mark = qqX.calls.length;
      pm(qqX, OTHER, '路人', '申请密钥 55555');
      r = await qqX.waitForCall(privTo(OTHER), 10_000, mark);
      const key2 = replyText(r).match(/bgk_[A-Za-z0-9_-]{32}/)![0];
      expect(await whoamiWith(key2)).toEqual({ id: OTHER, name: '路人' });
    } finally {
      if (process.env.REF_DEBUG) console.log(['--- logs', ...lines, '--- X calls', ...qqX.calls.map((c) => `${c.action} ${JSON.stringify(c.params)}`)].join('\n'));
      acK.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await Promise.all([qqM.close(), qqX.close()]);
    }
  }, 60_000);

  it('web stage: mirrors speeches (a voice speaks with its own account), recalls playing bots who talk in the group, leaves spectators alone', async () => {
    const G2 = '1127334886'; // 单独的群：和共用的常驻裁判互不干扰
    const m = rt.manager;
    const ids = { ai: { id: AI_ID, name: '克蕾雅' }, ai2: { id: AI2_ID, name: '艾莉希娅' }, p3: { id: '7003', name: '林夕' }, p4: { id: '7004', name: '苏菲' } };
    // 先在引擎里开好一局网页舞台（裁判 = 妮娅本人，没有代行登记）：裁判进程起来后直接接手主持
    const { summary } = m.createGame({ id: REF_ID, name: '妮娅' }, { type: 'jubensha', groupId: G2, joinAs: 'referee', options: { stage: 'web' } });
    const gameId = summary.game_id;
    for (const p of Object.values(ids)) m.joinGame(p, gameId, { as: 'player', selfPost: true });
    m.startGame({ id: REF_ID, name: '妮娅' }, gameId);
    const rec = m.getRecord(gameId);
    expect(rec.stage).toBe('web');

    const qqMain = new FakeOneBot('w0');
    const qqA = new FakeOneBot('wA');
    await Promise.all([qqMain.start(), qqA.start()]);
    const ac2 = new AbortController();
    const lines: string[] = [];
    const done = runReferee({
      url: http.url,
      key: KEYS.ref,
      onebotUrl: qqMain.url,
      onebotToken: 'w0',
      groupId: G2,
      admins: [OWNER],
      bots: [AI_ID, AI2_ID],
      voices: [{ key: KEYS.ai, onebotUrl: qqA.url, onebotToken: 'wA' }],
      stepWaitSeconds: 1,
      sendGapMs: 0,
      signal: ac2.signal,
      log: (l) => lines.push(l),
    });
    await Promise.all([qqMain.waitForConnection(), qqA.waitForConnection()]);
    const sendTo = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === G2;
    const emitAll = (uid: string, nick: string, t: string) => {
      const ev = { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(G2), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t };
      for (const q of [qqMain, qqA]) q.emit(ev);
      return ev.message_id;
    };
    try {
      // 开场：观战说明由主持的账号发，群里只有镜像
      await qqMain.waitForCall((c) => sendTo(c) && callText(c).includes('灯下剧场'), 15_000);
      // 自我介绍：轮到谁谁说；克蕾雅是本进程的嗓子 → 用她自己的号发原文，别人 → 主持账号加前缀
      const said: { who: keyof typeof ids; text: string }[] = [];
      for (let i = 0; i < 4 && rec.phase?.key === 'intro'; i++) {
        const seat = Object.values(rec.phase.pending).find((r) => !r.done)!.seat;
        const p = rec.players.find((x) => x.seat === seat)!;
        const who = (Object.keys(ids) as (keyof typeof ids)[]).find((k) => ids[k].id === p.id)!;
        const t = `我是${p.name}，第${i + 1}个发言。`;
        m.speak(ids[who], gameId, t);
        said.push({ who, text: t });
      }
      for (const s of said) {
        if (s.who === 'ai') {
          const c = await qqA.waitForCall((x) => sendTo(x) && callText(x) === s.text, 10_000);
          expect(c).toBeTruthy();
        } else {
          const c = await qqMain.waitForCall((x) => sendTo(x) && callText(x).includes(s.text), 10_000);
          expect(callText(c)).toMatch(/^【\d+号 /);
        }
      }
      expect(qqMain.calls.some((c) => sendTo(c) && callText(c) === said.find((s) => s.who === 'ai')!.text)).toBe(false);

      // 克蕾雅那条镜像发言回到群里（别的连接收到）：不算违规
      const mark = qqMain.calls.length;
      emitAll(AI_ID, '克蕾雅', said.find((s) => s.who === 'ai')!.text);
      // 旁观者随便聊：不撤回、不禁言
      emitAll(OTHER, '路人', '这局好看');
      await new Promise((res) => setTimeout(res, 500));
      expect(qqMain.calls.slice(mark).some((c) => c.action === 'delete_msg' || c.action === 'set_group_ban')).toBe(false);

      // 参赛 bot 在群里说话：撤回 + 提醒（每局一次），不禁言
      const bad = emitAll(AI2_ID, '艾莉希娅', '偷偷说，我签约了');
      const del = await qqMain.waitForCall((c) => c.action === 'delete_msg', 10_000, mark);
      expect(del.params.message_id).toBe(bad);
      await qqMain.waitForCall((c) => sendTo(c) && callText(c).includes('speak'), 10_000, mark);
      const bad2 = emitAll(AI2_ID, '艾莉希娅', '再说一句');
      await qqMain.waitForCall((c) => c.action === 'delete_msg' && c.params.message_id === bad2, 10_000, mark);
      await new Promise((res) => setTimeout(res, 300));
      expect(qqMain.calls.slice(mark).filter((c) => sendTo(c) && callText(c).includes('speak'))).toHaveLength(1);
      expect(qqMain.calls.slice(mark).some((c) => c.action === 'set_group_ban')).toBe(false);
      // 参赛 bot 自己说的不是镜像原文：也撤回（克蕾雅换了一句）
      const bad3 = emitAll(AI_ID, '克蕾雅', '我觉得凶手是 2 号');
      await qqMain.waitForCall((c) => c.action === 'delete_msg' && c.params.message_id === bad3, 10_000, mark);
    } finally {
      if (process.env.REF_DEBUG) console.log(['--- lines', ...lines, '--- main', ...qqMain.calls.map((c) => `${c.action} ${callText(c)}`), '--- A', ...qqA.calls.map((c) => `${c.action} ${callText(c)}`)].join('\n'));
      if (rec.status === 'running') m.abortGame({ id: REF_ID, name: '妮娅' }, gameId, '测试结束');
      await new Promise((res) => setTimeout(res, 1500));
      ac2.abort();
      await Promise.race([done, new Promise((res) => setTimeout(res, 5000))]);
      await Promise.all([qqMain.close(), qqA.close()]);
    }
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
