/**
 * 晴空都（--city）接入测试：
 *  1. DEFAULT_CITY_KEYWORDS 默认仅收口为 ['晴空都', '进城']，旧词「东京」「东京都」不触发签票；
 *  2. 群内发送「晴空都」通过 city_issue_ticket 私聊送达一次性登录链接，群内不泄露票据；
 *  3. 发送旧词「小镇」不再响应或签票；
 *  4. 对局中旁观者发送「小镇」按普通话处理（与发普通话完全相同，无任何小镇引导文字）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, exchangeCityTicket, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { DEFAULT_CITY_KEYWORDS, isCityCommand, runReferee } from '../src/index.js';
import { FakeOneBot, callText, type ApiCall } from './onebot-fake.js';

const REF_KEY = 'bgk_referee_city_key_0';
const REF_ID = '1000000001';
const GROUP = '9000000001';
const ALICE = '10001';
const BOB = '10002';
const CITY_URL = 'https://city.example.com/city/play/';
let msgSeq = 200000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('isCityCommand（晴空都 R0 默认关键词）', () => {
  it('默认仅匹配「晴空都」「进城」，旧词「东京」「东京都」不再误触发', () => {
    expect(DEFAULT_CITY_KEYWORDS).toEqual(['晴空都', '进城']);
    for (const ok of ['晴空都', '进城', ' 晴空都 ', '/晴空都', '/桌游 晴空都', '晴空都！', '进城。']) {
      expect(isCityCommand(ok), ok).toBe(true);
    }
    for (const no of ['', '东京', '东京都', '/东京', '晴空都好玩吗', '晴空都 12345']) {
      expect(isCityCommand(no), no).toBe(false);
    }
  });
});

describe('晴空都：登录链接签发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'referee-city-'));
  let eng: { rt: Runtime; http: HttpHandle };

  beforeAll(async () => {
    const config = configSchema.parse({
      host: '127.0.0.1',
      port: 0,
      stateFile: null,
      seed: 'referee-city',
      refereeIds: [REF_ID],
      auth: { mode: 'keys', adminKeys: [], agents: [{ key: REF_KEY, id: REF_ID, name: '妮娅' }] },
      city: {
        enabled: true,
        dbFile: join(dir, 'city.db'),
        weather: false,
        publicUrl: CITY_URL,
      },
    });
    const rt = createRuntime(config, () => undefined);
    for (let i = 0; i < 50 && rt.city?.status !== 'running'; i++) await sleep(10);
    const http = await startHttpServer(rt, () => undefined);
    eng = { rt, http };
  }, 20_000);

  afterAll(async () => {
    await eng.http.close();
    eng.rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('群内发「晴空都」私聊收到一次性链接，发「东京」「小镇」均不签票不回复', async () => {
    const qq = new FakeOneBot();
    await qq.start();
    const ac = new AbortController();
    const done = runReferee({
      url: eng.http.url,
      key: REF_KEY,
      onebotUrl: qq.url,
      groupId: GROUP,
      stepWaitSeconds: 1,
      sendGapMs: 0,
      selfInPool: false,
      city: {},
      signal: ac.signal,
      log: () => undefined,
    });
    await qq.waitForConnection();
    await sleep(400);

    const emitGroup = (uid: string, nick: string, t: string) =>
      qq.emit({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        group_id: Number(GROUP),
        user_id: Number(uid),
        message_id: ++msgSeq,
        sender: { user_id: Number(uid), nickname: nick, card: nick },
        message: [{ type: 'text', data: { text: t } }],
        raw_message: t,
      });

    try {
      // 1. 旧词「东京」不签发任何私聊票据
      emitGroup(ALICE, '爱丽丝', '东京');
      await sleep(300);
      expect(qq.calls.filter((c) => c.action === 'send_private_msg')).toHaveLength(0);

      // 2. 新词「晴空都」私聊送达链接且群内不泄露票据
      emitGroup(ALICE, '爱丽丝', '晴空都');
      const dm = await qq.waitForCall((c: ApiCall) => c.action === 'send_private_msg');
      expect(String(dm.params.user_id)).toBe(ALICE);
      expect(callText(dm)).toContain('晴空都登录链接');
      expect(callText(dm)).toContain(CITY_URL);
      const ticket = /#ticket=([\w-]+)/.exec(callText(dm))?.[1] ?? '';
      expect(ticket.length).toBeGreaterThan(20);
      const tip = await qq.waitForCall((c: ApiCall) => c.action === 'send_group_msg' && callText(c).includes('晴空都登录链接已私聊'));
      expect(callText(tip)).not.toContain(ticket);

      const exchanged = exchangeCityTicket(eng.rt.city!, ticket);
      expect(exchanged.principal).toMatchObject({
        display_name: '爱丽丝',
        kind: 'human',
      });
      expect(eng.rt.city!.db.get<{ subject: string }>('SELECT subject FROM principals WHERE principal_id = ?', exchanged.principal.principal_id)?.subject).toBe(ALICE);

      // 3. 发旧词「小镇」不再回复旧引导，也不签发任何票据
      const callsBefore = qq.calls.length;
      emitGroup(BOB, '鲍勃', '小镇');
      await sleep(300);
      expect(qq.calls.slice(callsBefore)).toHaveLength(0);
    } finally {
      ac.abort();
      await Promise.race([done, sleep(5000)]);
      await qq.close();
    }
  });

  it('对局中旁观者发「小镇」与发普通话处理完全相同，且无任何小镇引导文字', async () => {
    const ADMIN = '10000';
    const SPEC_TOWN = '10003';
    const SPEC_PLAIN = '10004';
    const qq = new FakeOneBot();
    await qq.start();
    const ac = new AbortController();
    const done = runReferee({
      url: eng.http.url,
      key: REF_KEY,
      onebotUrl: qq.url,
      groupId: GROUP,
      admins: [ADMIN],
      defaultOptions: { turn_timeout_s: 60 },
      stepWaitSeconds: 1,
      sendGapMs: 0,
      selfInPool: false,
      city: {},
      signal: ac.signal,
      log: () => undefined,
    });
    await qq.waitForConnection();
    await sleep(400);

    const emitGroup = (uid: string, nick: string, t: string) => {
      const id = ++msgSeq;
      qq.emit({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        group_id: Number(GROUP),
        user_id: Number(uid),
        message_id: id,
        sender: { user_id: Number(uid), nickname: nick, card: nick },
        message: [{ type: 'text', data: { text: t } }],
        raw_message: t,
      });
      return id;
    };
    const groupSend = (c: ApiCall) => c.action === 'send_group_msg' && String(c.params.group_id) === GROUP;

    try {
      // 管理员开一局数字炸弹，爱丽丝与鲍勃报名并开局
      let mark = qq.calls.length;
      emitGroup(ADMIN, '管理员', '/桌游 数字炸弹 min=0 max=10 mode=single');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('报名'), 10_000, mark);

      mark = qq.calls.length;
      emitGroup(ALICE, '爱丽丝', '加入');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('爱丽丝') && callText(c).includes('加入了'), 10_000, mark);
      mark = qq.calls.length;
      emitGroup(BOB, '鲍勃', '加入');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('鲍勃') && callText(c).includes('加入了'), 10_000, mark);

      mark = qq.calls.length;
      emitGroup(ADMIN, '管理员', '/桌游 开局');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('数字炸弹开始'), 10_000, mark);
      await sleep(600);

      // 旁观者甲发「小镇」
      const markTown = qq.calls.length;
      const townMsgId = emitGroup(SPEC_TOWN, '旁观甲', '小镇');
      await qq.waitForCall((c) => c.action === 'delete_msg' && c.params.message_id === townMsgId, 10_000, markTown);
      await qq.waitForCall((c) => c.action === 'set_group_ban' && String(c.params.user_id) === SPEC_TOWN, 10_000, markTown);
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('旁观甲'), 10_000, markTown);
      await sleep(250);
      const townCalls = qq.calls.slice(markTown);

      // 旁观者乙发一句普通话
      const markPlain = qq.calls.length;
      const plainMsgId = emitGroup(SPEC_PLAIN, '旁观乙', '今天天气真好');
      await qq.waitForCall((c) => c.action === 'delete_msg' && c.params.message_id === plainMsgId, 10_000, markPlain);
      await qq.waitForCall((c) => c.action === 'set_group_ban' && String(c.params.user_id) === SPEC_PLAIN, 10_000, markPlain);
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('旁观乙'), 10_000, markPlain);
      await sleep(250);
      const plainCalls = qq.calls.slice(markPlain);

      // 动作序列、撤回、禁言时长、群提示文案完全一致，均无私聊、均无小镇引导文字
      expect(townCalls.map((c) => c.action)).toEqual(['delete_msg', 'set_group_ban', 'send_group_msg']);
      expect(townCalls.map((c) => c.action)).toEqual(plainCalls.map((c) => c.action));

      const townBan = townCalls.find((c) => c.action === 'set_group_ban')!;
      const plainBan = plainCalls.find((c) => c.action === 'set_group_ban')!;
      expect(townBan.params.duration).toBe(plainBan.params.duration);
      expect(Number(townBan.params.duration)).toBeGreaterThan(0);

      const townGroupText = callText(townCalls.find((c) => c.action === 'send_group_msg')!);
      const plainGroupText = callText(plainCalls.find((c) => c.action === 'send_group_msg')!);
      expect(townGroupText.replace('旁观甲', '<NAME>')).toBe(plainGroupText.replace('旁观乙', '<NAME>'));
      expect(townGroupText).toContain('没有参加本局');
      for (const forbidden of ['栖灯镇', '小镇', '晴空都', '登录链接', '/town']) {
        expect(townGroupText).not.toContain(forbidden);
      }

      // 清理：中止对局
      mark = qq.calls.length;
      emitGroup(ADMIN, '管理员', '/桌游 中止');
      await qq.waitForCall((c) => groupSend(c) && callText(c).includes('中止'), 10_000, mark);
    } finally {
      ac.abort();
      await Promise.race([done, sleep(5000)]);
      await qq.close();
    }
  }, 30_000);
});
