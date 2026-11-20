/**
 * 晴空都（--city）接入测试：
 *  1. DEFAULT_CITY_KEYWORDS 默认仅收口为 ['晴空都', '进城']，旧词「东京」「东京都」不触发签票；
 *  2. 群内发送「晴空都」通过 city_issue_ticket 私聊送达一次性登录链接，群内不泄露票据；
 *  3. 当 --city 开启且 --town 未开启时，收到「小镇」温和引导发送「晴空都」。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, exchangeCityTicket, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { DEFAULT_CITY_KEYWORDS, isCityCommand, runReferee } from '../src/index.js';
import { FakeOneBot, callText, type ApiCall } from './onebot-fake.js';

const REF_KEY = 'bgk_referee_city_key_0';
const REF_ID = '2362232313';
const GROUP = '1127334885';
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

describe('晴空都：登录链接签发与旧词引导', () => {
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

  it('群内发「晴空都」私聊收到一次性链接，发「东京」不签票，发「小镇」引导发「晴空都」', async () => {
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

      // 3. 当 --city 开而 --town 关时，发「小镇」引导发送「晴空都」
      emitGroup(BOB, '鲍勃', '小镇');
      const hint = await qq.waitForCall((c: ApiCall) => c.action === 'send_group_msg' && callText(c).includes('栖灯镇已停运封存'));
      expect(callText(hint)).toContain('发送「晴空都」可获取晴空都登录链接');
      expect(callText(hint)).not.toContain('东京');
    } finally {
      ac.abort();
      await Promise.race([done, sleep(5000)]);
      await qq.close();
    }
  });
});
