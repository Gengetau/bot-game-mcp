/**
 * 栖灯镇接入：真人领取一次性登录链接（只私聊）、限频、私聊失败兜底、号码只来自消息事件、
 * 引擎没开小镇的行为，以及公告转发的确认语义（至少一次）。引擎是真的（开小镇的和没开的各一个），OneBot 是假的。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema, createRuntime, exchangeTicket, startHttpServer, type HttpHandle, type Runtime } from 'bot-game-mcp';
import { DEFAULT_TOWN_KEYWORDS, isTownCommand, runReferee, type RefereeOptions } from '../src/index.js';
import { FakeOneBot, callText, type ApiCall } from './onebot-fake.js';

const REF_KEY = 'bgk_referee_town_key_0';
const REF_ID = '2362232313';
const GROUP = '1127334885';
const ALICE = '10001';
const BOB = '10002';
const MALLORY = '66666';
const TOWN_URL = 'https://town.example.com/town/';
let msgSeq = 100000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootEngine(withTown: boolean, dir: string): Promise<{ rt: Runtime; http: HttpHandle }> {
  const config = configSchema.parse({
    host: '127.0.0.1',
    port: 0,
    stateFile: null,
    seed: 'referee-town',
    refereeIds: [REF_ID],
    auth: { mode: 'keys', adminKeys: [], agents: [{ key: REF_KEY, id: REF_ID, name: '妮娅' }] },
    ...(withTown ? { town: { enabled: true, dbFile: join(dir, 'town.db'), publicUrl: TOWN_URL } } : {}),
  });
  const rt = createRuntime(config, () => undefined);
  if (rt.world) await rt.world.start();
  const http = await startHttpServer(rt, () => undefined);
  return { rt, http };
}

interface Launched {
  qq: FakeOneBot;
  logs: string[];
  stop: () => Promise<void>;
  group: (uid: string, nick: string, message: unknown, card?: string) => void;
  priv: (uid: string, nick: string, text: string) => void;
  privates: (uid?: string) => ApiCall[];
  groupSends: () => ApiCall[];
}

async function launch(http: HttpHandle, extra: Partial<RefereeOptions>): Promise<Launched> {
  const qq = new FakeOneBot();
  await qq.start();
  const ac = new AbortController();
  const logs: string[] = [];
  const done = runReferee({
    url: http.url,
    key: REF_KEY,
    onebotUrl: qq.url,
    groupId: GROUP,
    stepWaitSeconds: 1,
    sendGapMs: 0,
    selfInPool: false,
    signal: ac.signal,
    log: (l) => logs.push(l),
    ...extra,
  });
  await qq.waitForConnection();
  // 等裁判拿到自己的身份、开始处理消息
  await sleep(400);
  const text = (t: string) => [{ type: 'text', data: { text: t } }];
  return {
    qq,
    logs,
    async stop() {
      ac.abort();
      await Promise.race([done, sleep(5000)]);
      await qq.close();
    },
    group: (uid, nick, message, card = '') =>
      qq.emit({ post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP), user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick, card }, message: typeof message === 'string' ? text(message) : message, raw_message: '' }),
    priv: (uid, nick, t) =>
      qq.emit({ post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: Number(uid), message_id: ++msgSeq, sender: { user_id: Number(uid), nickname: nick }, message: text(t), raw_message: t }),
    privates: (uid) => qq.calls.filter((c) => c.action === 'send_private_msg' && (uid === undefined || String(c.params.user_id) === uid)),
    groupSends: () => qq.calls.filter((c) => c.action === 'send_group_msg'),
  };
}

/** 从私聊消息里取出票据（#ticket= 后面那串） */
const ticketIn = (c: ApiCall): string => /#ticket=([\w-]+)/.exec(callText(c))?.[1] ?? '';

describe('isTownCommand', () => {
  it('整条消息就是关键词才算；前缀、斜杠、句尾标点可以有', () => {
    for (const ok of ['小镇', '进小镇', '栖灯镇', ' 小镇 ', '/小镇', '/桌游 小镇', '小镇！', '进小镇。']) expect(isTownCommand(ok), ok).toBe(true);
    for (const no of ['', '小镇好玩吗', '小镇 12345', '我想进小镇', '桌游', '去小镇逛逛']) expect(isTownCommand(no), no).toBe(false);
    expect(isTownCommand('来个镇子', ['来个镇子'])).toBe(true);
    expect(isTownCommand('小镇', ['来个镇子'])).toBe(false);
    expect(DEFAULT_TOWN_KEYWORDS).toContain('栖灯镇');
  });
});

describe('栖灯镇：登录链接', () => {
  const dir = mkdtempSync(join(tmpdir(), 'referee-town-'));
  let eng: { rt: Runtime; http: HttpHandle };
  let off: { rt: Runtime; http: HttpHandle };

  beforeAll(async () => {
    eng = await bootEngine(true, dir);
    off = await bootEngine(false, dir);
  }, 20_000);
  afterAll(async () => {
    await eng.http.close();
    eng.rt.close();
    await off.http.close();
    off.rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('群里发「小镇」：只私聊收到链接，群里没有链接和票据；票据绑的是发消息的人', async () => {
    const r = await launch(eng.http, { town: {} });
    try {
      r.group(ALICE, '爱丽丝', '小镇', '群名片爱丽丝');
      const dm = await r.qq.waitForCall((c) => c.action === 'send_private_msg');
      expect(String(dm.params.user_id)).toBe(ALICE);
      expect(callText(dm)).toContain(TOWN_URL);
      const ticket = ticketIn(dm);
      expect(ticket.length).toBeGreaterThan(20);
      // 群里只有一句「已私聊」
      const tip = await r.qq.waitForCall((c) => c.action === 'send_group_msg');
      expect(callText(tip)).toContain('已私聊');
      expect(callText(tip)).toContain(`@${ALICE}`);
      for (const g of r.groupSends()) {
        expect(JSON.stringify(g.params)).not.toContain(ticket);
        expect(JSON.stringify(g.params)).not.toContain('#ticket');
        expect(JSON.stringify(g.params)).not.toContain('town.example.com');
      }
      // 日志里没有票据和链接
      expect(r.logs.join('\n')).not.toContain(ticket);
      expect(r.logs.join('\n')).not.toContain('town.example.com');
      // 票据是 ALICE 的，用群名片作显示名
      const s = exchangeTicket(eng.rt.world!, ticket);
      expect(s.principal.provider).toBe('qq');
      expect(s.principal.subject).toBe(ALICE);
      expect(s.principal.display_name).toBe('群名片爱丽丝');
    } finally {
      await r.stop();
    }
  });

  it('号码只来自消息事件：消息里 @ 或写别人的号都不会给别人签票', async () => {
    const r = await launch(eng.http, { town: {} });
    try {
      // MALLORY 在消息里 @ 了 BOB：票据仍然只给发消息的 MALLORY
      r.group(MALLORY, '马洛里', [{ type: 'at', data: { qq: BOB } }, { type: 'text', data: { text: ' 小镇' } }]);
      const dm = await r.qq.waitForCall((c) => c.action === 'send_private_msg');
      expect(String(dm.params.user_id)).toBe(MALLORY);
      expect(exchangeTicket(eng.rt.world!, ticketIn(dm)).principal.subject).toBe(MALLORY);
      // 消息文字里写着 BOB 的号：不是纯关键词，不触发
      const before = r.qq.calls.length;
      r.group(MALLORY, '马洛里', `小镇 ${BOB}`);
      r.group(MALLORY, '马洛里', `给 ${BOB} 发小镇链接`);
      await sleep(700);
      expect(r.qq.calls.slice(before).filter((c) => c.action === 'send_private_msg')).toHaveLength(0);
      expect(r.privates(BOB)).toHaveLength(0);
    } finally {
      await r.stop();
    }
  });

  it('同一个人限频：冷却内不再签发，只提示一次', async () => {
    const r = await launch(eng.http, { town: { ticketCooldownSeconds: 60 } });
    try {
      r.group(BOB, '鲍勃', '小镇');
      await r.qq.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('已私聊'));
      expect(r.privates(BOB)).toHaveLength(1);
      r.group(BOB, '鲍勃', '进小镇');
      await r.qq.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('刚给你发过'));
      r.group(BOB, '鲍勃', '栖灯镇');
      r.priv(BOB, '鲍勃', '小镇');
      await sleep(600);
      expect(r.privates(BOB)).toHaveLength(1);
      expect(r.groupSends().filter((c) => callText(c).includes('刚给你发过'))).toHaveLength(1);
      // 别人不受影响
      r.group(ALICE, '爱丽丝', '小镇');
      await r.qq.waitForCall((c) => c.action === 'send_private_msg' && String(c.params.user_id) === ALICE);
    } finally {
      await r.stop();
    }
  });

  it('冷却过后可以再领', async () => {
    const r = await launch(eng.http, { town: { ticketCooldownSeconds: 1 } });
    try {
      r.group(ALICE, '爱丽丝', '小镇');
      await r.qq.waitForCall((c) => c.action === 'send_private_msg');
      await sleep(1200);
      r.group(ALICE, '爱丽丝', '小镇');
      await sleep(800);
      expect(r.privates(ALICE)).toHaveLength(2);
      expect(ticketIn(r.privates(ALICE)[0]!)).not.toBe(ticketIn(r.privates(ALICE)[1]!));
    } finally {
      await r.stop();
    }
  });

  it('私聊发不出去：群里提示加好友 / 先私聊，不贴链接', async () => {
    const r = await launch(eng.http, { town: {} });
    try {
      r.qq.failActions.add('send_private_msg');
      r.group(ALICE, '爱丽丝', '小镇');
      const tip = await r.qq.waitForCall((c) => c.action === 'send_group_msg');
      expect(callText(tip)).toMatch(/好友|临时会话/);
      expect(callText(tip)).not.toContain('已私聊');
      // 先试好友，再试群临时会话
      expect(r.privates(ALICE).length).toBe(2);
      expect(r.privates(ALICE)[1]!.params.group_id).toBe(Number(GROUP));
      const ticket = ticketIn(r.privates(ALICE)[0]!);
      for (const g of r.groupSends()) {
        expect(JSON.stringify(g.params)).not.toContain(ticket);
        expect(JSON.stringify(g.params)).not.toContain('#ticket');
      }
      expect(r.logs.join('\n')).not.toContain(ticket);
      // 不会存起来以后补发：对方后来私聊一句，不会收到旧链接
      r.qq.failActions.clear();
      const n = r.privates(ALICE).length;
      r.priv(ALICE, '爱丽丝', '你好');
      await sleep(500);
      expect(r.privates(ALICE).length).toBe(n);
    } finally {
      await r.stop();
    }
  });

  it('私聊领取：要求对方在群里；在群里就私聊回链接', async () => {
    const r = await launch(eng.http, { town: {} });
    try {
      r.qq.failWhen = (c) => c.action === 'get_group_member_info' && String(c.params.user_id) === MALLORY;
      r.priv(MALLORY, '马洛里', '小镇');
      const no = await r.qq.waitForCall((c) => c.action === 'send_private_msg');
      expect(callText(no)).toContain('不在群');
      expect(callText(no)).not.toContain('#ticket');
      r.priv(ALICE, '爱丽丝', '/桌游 小镇');
      const ok = await r.qq.waitForCall((c) => c.action === 'send_private_msg' && String(c.params.user_id) === ALICE);
      expect(callText(ok)).toContain('#ticket=');
      expect(r.groupSends()).toHaveLength(0); // 私聊领取不在群里说话
    } finally {
      await r.stop();
    }
  });

  it('关键词可配', async () => {
    const r = await launch(eng.http, { town: { keywords: ['去逛逛'] } });
    try {
      r.group(ALICE, '爱丽丝', '小镇'); // 默认词不再生效
      await sleep(500);
      expect(r.privates()).toHaveLength(0);
      r.group(ALICE, '爱丽丝', '去逛逛');
      await r.qq.waitForCall((c) => c.action === 'send_private_msg');
    } finally {
      await r.stop();
    }
  });

  it('引擎没开小镇：回「小镇没开」，或者（silent）不响应；不泄露任何东西', async () => {
    const r = await launch(off.http, { town: {} });
    try {
      r.group(ALICE, '爱丽丝', '小镇');
      const tip = await r.qq.waitForCall((c) => c.action === 'send_group_msg');
      expect(callText(tip)).toContain('小镇没开');
      expect(r.privates()).toHaveLength(0);
      // 失败不占冷却：马上再问还是得到同样的回答
      r.group(ALICE, '爱丽丝', '小镇');
      await sleep(600);
      expect(r.groupSends().filter((c) => callText(c).includes('小镇没开'))).toHaveLength(2);
    } finally {
      await r.stop();
    }
    const q = await launch(off.http, { town: { whenOff: 'silent' } });
    try {
      q.group(ALICE, '爱丽丝', '小镇');
      await sleep(700);
      expect(q.qq.calls.filter((c) => c.action === 'send_group_msg' || c.action === 'send_private_msg')).toHaveLength(0);
    } finally {
      await q.stop();
    }
  });

  it('没配 town：对「小镇」完全不响应（零影响）', async () => {
    const r = await launch(eng.http, {});
    try {
      r.group(ALICE, '爱丽丝', '小镇');
      r.priv(ALICE, '爱丽丝', '小镇');
      await sleep(700);
      expect(r.qq.calls.filter((c) => c.action === 'send_group_msg' || c.action === 'send_private_msg')).toHaveLength(0);
    } finally {
      await r.stop();
    }
  });

  it('机器人账号发「小镇」不签票（它们不是真人）', async () => {
    const r = await launch(eng.http, { town: {}, bots: ['77777'] });
    try {
      r.group('77777', '某bot', '小镇');
      await sleep(600);
      expect(r.privates()).toHaveLength(0);
    } finally {
      await r.stop();
    }
  });
});

describe('栖灯镇：公告转发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'referee-town-outbox-'));
  let eng: { rt: Runtime; http: HttpHandle };
  const insert = (key: string, title: string, text: string) =>
    eng.rt.world!.db.run('INSERT INTO notification_outbox(dedupe_key, destination, payload, created_at) VALUES (?,?,?,?)', key, 'announce', JSON.stringify({ kind: 'public_event', title, text, at: Date.now() }), Date.now());
  // 只数测试自己放进去的公告：引擎按真实时间运行，到了钟点（比如 12:30 的花园整理）会自己产生公告
  const unsent = () => Number(eng.rt.world!.db.get("SELECT COUNT(*) AS c FROM notification_outbox WHERE sent_at IS NULL AND (dedupe_key LIKE 'off-%' OR dedupe_key LIKE 'a-%')")?.c);

  beforeAll(async () => {
    eng = await bootEngine(true, dir);
  }, 20_000);
  afterAll(async () => {
    await eng.http.close();
    eng.rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认关：有公告也不转发', async () => {
    insert('off-1', '花园整理', '今天 12:30 开始');
    const r = await launch(eng.http, { town: {} });
    try {
      await sleep(700);
      expect(r.groupSends()).toHaveLength(0);
      expect(unsent()).toBe(1);
    } finally {
      await r.stop();
    }
    eng.rt.world!.db.run('DELETE FROM notification_outbox');
  });

  it('发成功才确认；发送失败不确认，下个周期重发（至少一次）', async () => {
    const r = await launch(eng.http, { town: { outbox: { intervalSeconds: 0.25, limit: 5 } } });
    try {
      // 先让群消息发送失败：公告留在待发里，不确认
      r.qq.failActions.add('send_group_msg');
      insert('a-1', '灯下集市', '晚上 8 点开市');
      insert('a-2', '小镇小报', '昨天很热闹');
      await sleep(900);
      expect(unsent()).toBe(2);
      expect(r.logs.some((l) => l.includes('公告发送失败'))).toBe(true);
      const failedTries = r.groupSends().length;
      expect(failedTries).toBeGreaterThanOrEqual(2); // 每个周期都重试，而且保持顺序：失败就不继续发后面的
      // 恢复：按顺序发出并确认
      r.qq.failActions.clear();
      const mark = r.qq.calls.length;
      await r.qq.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('小镇小报'), 5000, mark);
      for (let i = 0; i < 20 && unsent() > 0; i++) await sleep(100);
      expect(unsent()).toBe(0);
      const ok = r.qq.calls.slice(mark).filter((c) => c.action === 'send_group_msg');
      expect(ok.map((c) => callText(c).split('\n')[0])).toEqual(['🏮 灯下集市', '🏮 小镇小报']);
      expect(callText(ok[0]!)).toContain('晚上 8 点开市');
      // 确认之后不会重复发
      const n = r.groupSends().length;
      await sleep(700);
      expect(r.groupSends().length).toBe(n);
      // 新公告照常转发
      insert('a-3', '周末茶会', '周六 20:00');
      await r.qq.waitForCall((c) => c.action === 'send_group_msg' && callText(c).includes('周末茶会'), 5000);
      for (let i = 0; i < 20 && unsent() > 0; i++) await sleep(100);
      expect(unsent()).toBe(0);
    } finally {
      await r.stop();
    }
  });

  it('引擎没开小镇：公告转发安静地停掉', async () => {
    const offDir = mkdtempSync(join(tmpdir(), 'referee-town-off-'));
    const off = await bootEngine(false, offDir);
    const r = await launch(off.http, { town: { outbox: { intervalSeconds: 0.2 } } });
    try {
      await sleep(800);
      expect(r.logs.some((l) => l.includes('公告转发停止'))).toBe(true);
      expect(r.groupSends()).toHaveLength(0);
    } finally {
      await r.stop();
      await off.http.close();
      off.rt.close();
      rmSync(offDir, { recursive: true, force: true });
    }
  });
});
