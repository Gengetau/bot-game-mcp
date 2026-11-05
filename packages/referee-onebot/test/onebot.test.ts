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

  it('bot-commands: a bot account may open a room and start it, but not abort; other bot chatter stays ignored', async () => {
    const qq3 = new FakeOneBot('tok3');
    await qq3.start();
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
    await qq3.waitForConnection();
    const send3 = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;
    const msg3 = (uid: string, nick: string, t: string) =>
      qq3.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card: '' }, message: text(t), raw_message: t });
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
