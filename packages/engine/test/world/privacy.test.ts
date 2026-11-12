/**
 * 栖灯镇：隐私与信息可见范围。
 * 对照设计文档第 10 节「信息可见范围」表格与 docs/TOWN.md「隐私不变量」。
 *
 * 做法：给每一份秘密塞一个独特的标记（信件正文、聊天句子、背包物品编号、硬币余额、需要数值、愿望编号、
 * 关系记忆、屋内的东西），在一个丰富的场景里跑完，再对每个出口的 JSON 投影做「不得出现」断言。
 */
import { describe, expect, it } from 'vitest';
import { renewNavigation, sceneView } from '../../src/world/space.js';
import { agentView, chatHistory, directory, meView, publicView } from '../../src/world/views.js';
import { listLetters } from '../../src/world/mail.js';
import { outboxPending, report } from '../../src/world/reports.js';
import { relationsOf } from '../../src/world/social.js';
import { Actor, makeTown, type Town } from './helpers.js';
import { checkSpaceInvariants } from './invariants.js';

const STEP = 50_000;
const homeOf = (a: Actor) => `home:${a.residentId}`;

/** 让时间前进 ms，期间名单上的人一直保持心跳（先续一次租）。 */
function stay(t: Town, ms: number, actors: Actor[]): void {
  for (const x of actors) x.heartbeat();
  t.advanceAlive(ms, actors, STEP);
}
const pulse = (actors: Actor[]) => actors.forEach((x) => x.heartbeat());

/** 断言 text 里没有任何一个标记。失败信息指出是哪个出口泄露了哪个标记。 */
function expectClean(label: string, text: string, needles: readonly string[]): void {
  for (const n of needles) expect(text.includes(n), `${label} 泄露了「${n}」`).toBe(false);
}

const L1 = 'LETTER-ONE-暗号KQ7'; // 阿灯 → 小岚（随信附邀请，小岚没读）
const L2 = 'LETTER-TWO-暗号MV3'; // 小满 → 阿灯（阿灯在家读过）
const L3 = 'LETTER-THREE-暗号ZR9'; // 小满 → 小朵（小朵没读）
const LETTERS = [L1, L2, L3];
const CHAT_A = 'CHAT-A-暗号31';
const CHAT_B = 'CHAT-B-暗号32';
const HOME_A = 'HOMECHAT-A-暗号41';
const HOME_B = 'HOMECHAT-B-暗号42';
const CHATS = [CHAT_A, CHAT_B, HOME_A, HOME_B];
const RELATION_MEMORY = '聊到爱好';
const DECOR = '小灯笼';

interface Rich {
  t: Town;
  a: Actor;
  b: Actor;
  c: Actor;
  d: Actor;
  all: Actor[];
  letterInviteGrant: string;
  personalGrant: string;
  letterIds: { l1: string; l2: string; l3: string };
  secrets: Map<string, string[]>;
}

/**
 * 阿灯（寄信人，真人）、小岚（AI，收信人）、小满（路人）、小朵（旁观者）。
 * 阿灯和小岚在广场聊天、问爱好；阿灯买了小灯笼，回家读信、把灯笼摆出来；小岚受邀进了阿灯家并在屋里聊天；
 * 小朵站在会馆门前（灯巷会馆，进各家门的公共入口）；小满在广场。
 */
function richTown(): Rich {
  const t = makeTown();
  const a = t.join('寄信人阿灯');
  const b = t.join('收信人小岚', 'agent');
  const c = t.join('路人小满');
  const d = t.join('旁观者小朵');
  const all = [a, b, c, d];

  c.go('bookshop');
  d.go('tea_house');
  pulse(all);
  a.act('speak', { text: CHAT_A });
  b.act('speak', { text: CHAT_B });
  b.act('update_profile', { interests: ['tea'] });
  a.act('ask_hobby', { target: b.residentId });
  a.act('buy', { shop: 'stall', sku: 'lantern' });
  const personalGrant = a.act('invite', { to: b.residentId }).invite.grantId as string;
  const l1 = a.act('send_letter', { to: b.residentId, body: L1, invite: { reentry: true } });
  const l2 = c.act('send_letter', { to: a.residentId, body: L2 });
  const l3 = c.act('send_letter', { to: d.residentId, body: L3 });
  const letterInviteGrant = a.view().invites.sent.find((i) => i.via === 'letter')!.grantId;
  stay(t, 61_000, all);

  a.go('home');
  pulse(all);
  a.act('read_letter', { letterId: l2.letterId });
  a.act('display_item', { itemType: 'lantern' });
  b.go(homeOf(a));
  pulse(all);
  a.act('speak', { text: HOME_A });
  b.act('speak', { text: HOME_B });
  d.go('residential');
  pulse(all);
  c.go('plaza');
  pulse(all);

  // 最后写入独特的硬币余额和需要数值（之后不再让时间前进，免得被惰性结算改掉）
  const balances = new Map<Actor, number>([
    [a, 4242],
    [b, 4343],
    [c, 4444],
    [d, 4545],
  ]);
  const needs: [Actor, number][] = [
    [a, 11.1],
    [b, 44.4],
    [c, 77.7],
    [d, 88.8],
  ];
  for (const [x, bal] of balances) t.w.db.run('UPDATE accounts SET balance = ? WHERE account_id = ?', bal, `acct:${x.residentId}`);
  for (const [x, base] of needs) {
    const r = x.row();
    r.state.needs = { energy: base + 0.2, social: base, interest: base + 0.1, asOfPresentMs: 999_999_999_999 };
    t.w.saveResident(r);
  }

  const secrets = new Map<string, string[]>();
  for (const x of all) {
    const v = x.view();
    secrets.set(x.residentId, [
      ...v.inventory.items.map((i) => i.itemId),
      ...v.goals.map((g) => g.id),
      `"balance":${balances.get(x)}`,
      `"social":${needs.find(([y]) => y === x)![1]}`,
      `"interest":${(needs.find(([y]) => y === x)![1] + 0.1).toFixed(1)}`,
    ]);
  }
  checkSpaceInvariants(t);
  return { t, a, b, c, d, all, letterInviteGrant, personalGrant, letterIds: { l1: l1.letterId, l2: l2.letterId, l3: l3.letterId }, secrets };
}

/** 一位居民能看到的所有出口。 */
function surfaces(t: Town, x: Actor): Record<string, string> {
  return {
    meView: JSON.stringify(meView(t.w, x.row(), x.clientId)),
    agentView: JSON.stringify(agentView(t.w, x.row(), x.clientId)),
    privateEvents: JSON.stringify(t.w.readResidentEvents(x.residentId, t.w.encodeCursor('r', x.residentId, 0), 5000).events),
    chatHistory: JSON.stringify(chatHistory(t.w, x.residentId, null, 100)),
    relations: JSON.stringify(relationsOf(t.w, x.residentId)),
    personalReport: JSON.stringify(report(t.w, { residentId: x.residentId }, t.w.today(), t.clock.t)),
  };
}

/** 公开出口。 */
function publicSurfaces(t: Town): Record<string, string> {
  return {
    publicView: JSON.stringify(publicView(t.w)),
    publicEventsTable: JSON.stringify(t.w.db.all('SELECT * FROM public_events')),
    publicStream: JSON.stringify(t.w.readPublicEvents(t.w.encodeCursor('p', 'public', 0), 5000)),
    directory: JSON.stringify(directory(t.w, t.clock.t)),
    publicReport: JSON.stringify(report(t.w, 'public', t.w.today(), t.clock.t)),
    outbox: JSON.stringify(outboxPending(t.w, 50)),
  };
}

describe('栖灯镇隐私：公开出口（公开地图、公开事件流、名录、公开日报、对外公告）', () => {
  it('不出现信件、聊天、背包、硬币、需要、愿望、关系、屋内的物、巷子和门牌归属', () => {
    const s = richTown();
    const everyoneSecrets = [...s.secrets.values()].flat();
    expect(everyoneSecrets.length).toBeGreaterThan(20); // 确认标记确实收集到了
    const needles = [
      ...LETTERS,
      ...CHATS,
      ...everyoneSecrets,
      s.letterInviteGrant,
      s.personalGrant,
      RELATION_MEMORY,
      DECOR,
      'home:',
      'street_east',
      'street_west',
      'house_no',
      '"inventory"',
      '"balance"',
      '"coins"',
      '"familiarity"',
      '"goals"',
    ];
    for (const [label, text] of Object.entries(publicSurfaces(s.t))) {
      if (label !== 'outbox') expect(text.length, `${label} 不应为空`).toBeGreaterThan(2);
      expectClean(`公开出口 ${label}`, text, needles);
    }
  });

  it('公开地图里住宅区的人只到「住宅区」这一层，不分会馆门前还是谁家', () => {
    const s = richTown();
    const v = publicView(s.t.w);
    const residential = v.residential.residents.map((r) => r.name).sort();
    // 阿灯在家里、小岚在阿灯家、小朵在会馆门前：公开层面三个人完全一样
    expect(residential).toEqual(['寄信人阿灯', '收信人小岚', '旁观者小朵'].sort());
    for (const spot of v.residential.residents) expect(Object.keys(spot).sort()).toEqual(['at', 'id', 'kind', 'name']);
    expect(v.residential.residents.every((r) => r.at === 'residential')).toBe(true);
    // 公共地点里只有真正在那里的人
    expect(v.places.find((p) => p.id === 'plaza')!.residents.map((r) => r.name)).toEqual(['路人小满']);
    // 没有旧的在途 / 路网字段，也没有旧的两条巷子
    expect('moving' in v).toBe(false);
    expect('edges' in v).toBe(false);
    expect(v.places.map((p) => p.id)).not.toContain('street_east');
    expect(v.places.map((p) => p.id)).not.toContain('street_west');
    expect(v.places.find((p) => p.id === 'road')).toMatchObject({ through: true });
  });

  it('公开投影（公开地图、公开事件流、名录、日报）里没有坐标、折线、到达 / 租约时间、home:<谁>、实例编号——居民正在路上时也一样', () => {
    const s = richTown();
    // 让几个人同时在走：小满去茶馆、小朵去书屋，小岚从阿灯家出来往广场走
    s.c.act('navigate', { to: 'tea_house' });
    s.d.act('navigate', { to: 'bookshop' });
    s.b.act('navigate', { to: 'plaza' });
    for (let i = 0; i < 7; i++) {
      s.t.advanceAlive(1_000, s.all, 1_000);
      for (const x of s.all) {
        const nav = x.view().location.navigation;
        if (nav) renewNavigation(s.t.w, x.auth, { navigationId: nav.navigationId, revision: nav.revision });
      }
    }
    expect(s.t.w.db.scalar('SELECT COUNT(*) FROM world_actors WHERE nav_json IS NOT NULL')).toBeGreaterThan(0);
    checkSpaceInvariants(s.t); // 正在走的人也满足空间不变量
    const STRUCT = /"(x|z|heading|points|path|route|arriveAt|arrive_at|leaseUntil|lease_until|renewEveryMs|navigationId|navigation|startedAt|crossings|instance|instance_id|scene|scene_id|nav_json|moving|edges)":/;
    const homes = s.all.map((x) => homeOf(x));
    for (const [label, text] of Object.entries(publicSurfaces(s.t))) {
      expect(STRUCT.test(text), `公开出口 ${label} 出现了坐标 / 路线 / 时间 / 实例字段：${STRUCT.exec(text)?.[0]}`).toBe(false);
      expectClean(`公开出口 ${label}`, text, [...homes, 'home:']);
    }
    // 公开事件流里的位置事件只有 id、名字、种类、公开区域
    for (const e of s.t.w.readPublicEvents(s.t.w.encodeCursor('p', 'public', 0), 5000).events.filter((x) => x.type === 'place')) {
      expect(Object.keys((e.data as { resident: object }).resident).sort()).toEqual(expect.arrayContaining(['at', 'id', 'kind', 'name']));
      expect(Object.keys((e.data as { resident: object }).resident).every((k) => ['at', 'id', 'kind', 'name', 'playing'].includes(k))).toBe(true);
      const at = (e.data as { resident: { at: string | null } }).resident.at;
      expect([null, 'plaza', 'tea_house', 'bookshop', 'kitchen', 'garden', 'arcade', 'road', 'residential']).toContain(at);
    }
  });

  it('日报（公开）只有聚合句子，不含信件、聊天、物品', () => {
    const s = richTown();
    // 跨过一个世界日，让昨天的日报生成并落盘
    const day = s.t.w.today();
    while (s.t.w.today() === day) stay(s.t, 3600_000, s.all);
    const text = JSON.stringify(report(s.t.w, 'public', day, s.t.clock.t)) + JSON.stringify(outboxPending(s.t.w, 50));
    expectClean('昨天的公开日报和对外公告', text, [...LETTERS, ...CHATS, DECOR, 'home:', 'street_', ...[...s.secrets.values()].flat()]);
  });
});

describe('栖灯镇隐私：别人的视图与事件流（逐一对照）', () => {
  it('任何居民的 meView / agentView / 私有事件流 / 历史 / 关系 / 个人日报里，都没有别人的背包、硬币、需要、愿望', () => {
    const s = richTown();
    for (const viewer of s.all) {
      const mine = s.secrets.get(viewer.residentId)!;
      const others = [...s.secrets.entries()].filter(([id]) => id !== viewer.residentId).flatMap(([, v]) => v);
      expect(others.length).toBeGreaterThan(10);
      for (const [label, text] of Object.entries(surfaces(s.t, viewer))) {
        expectClean(`${viewer.name} 的 ${label}`, text, others);
      }
      // 反过来确认：自己的秘密在自己的视图里是看得到的（标记不是空话）
      const own = surfaces(s.t, viewer).meView;
      expect(own.includes(mine[0]!), `${viewer.name} 应该看得到自己的东西`).toBe(true);
    }
  });

  it('任何居民的 meView / agentView / 私有事件流里都没有信件正文（读信的动作结果除外）', () => {
    const s = richTown();
    for (const viewer of s.all) {
      for (const [label, text] of Object.entries(surfaces(s.t, viewer))) {
        expectClean(`${viewer.name} 的 ${label}`, text, LETTERS);
      }
    }
  });

  it('没读过的信：收信人在外面的视图 / 事件里没有正文、寄信人、信件编号、邀请编号、寄信人家的门牌', () => {
    const s = richTown();
    // 小岚此刻在阿灯家里，换到一个完全不相干的地方，确保「在外面」
    s.b.go('residential');
    s.b.go('plaza');
    pulse(s.all);
    s.c.go('tea_house'); // 小满离开广场，广场上只剩小岚
    const text = surfaces(s.t, s.b);
    for (const key of ['meView', 'agentView', 'personalReport'] as const) {
      expectClean(`小岚的 ${key}`, text[key]!, [L1, s.letterIds.l1, s.letterInviteGrant, 'LETTER-']);
    }
    // 小岚的邮箱只有数量
    expect(s.b.view().mail).toEqual({ unread: 1, total: 1 });
    expect(JSON.stringify(agentView(s.t.w, s.b.row(), s.b.clientId))).toContain('"mail_unread":1');
    // 「新信」提示事件：不含寄信人和正文
    const mails = s.t.w.readResidentEvents(s.b.residentId, s.t.w.encodeCursor('r', s.b.residentId, 0), 5000).events.filter((e) => e.type === 'mail');
    expect(mails).toHaveLength(1);
    expectClean('mail 事件', JSON.stringify(mails), [L1, '寄信人阿灯', s.a.residentId, s.letterIds.l1, s.letterInviteGrant, '邀请', 'invite']);
    // 随信的邀请没读之前不算得知：不在邀请列表里（当面发的那份才在）
    const invites = s.b.view().invites.received.map((i) => i.grantId);
    expect(invites).toContain(s.personalGrant);
    expect(invites).not.toContain(s.letterInviteGrant);
    // 信箱列表也不带正文
    expectClean('小岚的信箱', JSON.stringify(listLetters(s.t.w, s.b.residentId, 'inbox', null, 20, s.t.clock.t)), [L1]);
  });

  it('寄信人的已发副本只有寄信人自己读得到；收信人、路人的信箱和已发箱里没有', () => {
    const s = richTown();
    expect(JSON.stringify(listLetters(s.t.w, s.a.residentId, 'sent', null, 20, s.t.clock.t))).toContain(L1);
    for (const x of [s.b, s.c, s.d]) {
      for (const box of ['inbox', 'sent'] as const) {
        const text = JSON.stringify(listLetters(s.t.w, x.residentId, box, null, 50, s.t.clock.t));
        if (x === s.c && box === 'sent') continue; // 小满自己寄的 L2、L3
        if (x === s.d && box === 'inbox') continue; // 小朵收到的 L3（没读，不带正文，下面单独断言）
        expectClean(`${x.name} 的 ${box}`, text, [L1, L2, L3]);
      }
    }
    expectClean('小朵未读的 L3', JSON.stringify(listLetters(s.t.w, s.d.residentId, 'inbox', null, 20, s.t.clock.t)), [L3]);
    // 阿灯读过 L2：自己的信箱里带正文
    expect(JSON.stringify(listLetters(s.t.w, s.a.residentId, 'inbox', null, 20, s.t.clock.t))).toContain(L2);
  });

  it('访客在房主家里：看不到房主的信箱、背包、硬币、需要；读不了房主的信', () => {
    const s = richTown();
    expect(s.b.row().location_id).toBe(homeOf(s.a));
    // 小岚（客人）读房主的信、删房主的信，都得到「没有这封信」
    expect(s.b.fail('read_letter', { letterId: s.letterIds.l2 }).reason).toBe('no_such_letter');
    expect(s.b.fail('delete_letter', { letterId: s.letterIds.l2 }).reason).toBe('no_such_letter');
    expect(s.b.fail('revoke_invite', { grantId: s.personalGrant }).reason).toBe('no_such_invite');
    // 小岚在屋里看到的：主人、摆出来的灯笼；看不到别的
    const here = s.b.view().here!;
    expect(here.kind).toBe('home');
    expect(here.home?.mine).toBe(false);
    expect(here.home?.decor.join()).toContain(DECOR);
    const text = JSON.stringify(here);
    expectClean('屋里的现场视图', text, [...(s.secrets.get(s.a.residentId) ?? []), L2, 'inventory']);
  });

  it('旁观者站在会馆门前：看不到屋里的人和物、听不到屋里说的话；只有门牌和能不能进', () => {
    const s = richTown();
    expect(s.d.row().location_id).toBe('residential');
    const v = s.d.view();
    expect(v.here?.kind).toBe('residential');
    expect(v.here?.residents).toEqual([]); // 阿灯、小岚都在屋里
    expect(v.here?.home).toBeUndefined();
    expect(v.here?.objects).toEqual([]);
    const door = v.here!.doors!.find((x) => x.home === homeOf(s.a))!;
    expect(door.canEnter).toBe(false);
    // 门牌条目的形状固定：不表达主人此刻在不在家
    expect(Object.keys(door).sort()).toEqual(['canEnter', 'home', 'lane', 'no', 'owner']);
    for (const d of v.here!.doors!) expect(Object.keys(d).sort()).toEqual(Object.keys(door).sort());
    for (const [label, text] of Object.entries(surfaces(s.t, s.d))) {
      expectClean(`小朵的 ${label}`, text, [HOME_A, HOME_B, DECOR]);
    }
    expect(s.d.fail('navigate', { to: homeOf(s.a) }).reason).toBe('no_access');
  });

  it('不在受众里的人（路人、旁观者）的所有出口都没有别人的现场发言', () => {
    const s = richTown();
    for (const x of [s.c, s.d]) {
      for (const [label, text] of Object.entries(surfaces(s.t, x))) expectClean(`${x.name} 的 ${label}`, text, CHATS);
    }
    for (const [label, text] of Object.entries(publicSurfaces(s.t))) expectClean(`公开 ${label}`, text, CHATS);
    // 受众表里只有当时在场的两个人
    const aud = (marker: string) =>
      s.t.w.db
        .all('SELECT a.resident_id FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id WHERE m.body = ?', marker)
        .map((r) => r.resident_id as string)
        .sort();
    expect(aud(CHAT_A)).toEqual([s.a.residentId, s.b.residentId].sort());
    expect(aud(HOME_A)).toEqual([s.a.residentId, s.b.residentId].sort());
  });

  it('路人的关系列表里没有别人之间的共同经历', () => {
    const s = richTown();
    expectClean('小满的关系', JSON.stringify(relationsOf(s.t.w, s.c.residentId)), [RELATION_MEMORY]);
    expectClean('小朵的关系', JSON.stringify(relationsOf(s.t.w, s.d.residentId)), [RELATION_MEMORY]);
    // 当事人自己看得到
    expect(JSON.stringify(relationsOf(s.t.w, s.a.residentId))).toContain(RELATION_MEMORY);
  });
});

describe('栖灯镇隐私：住宅区内部的走动、公开层只到「住宅区」', () => {
  /** 公开地图里和位置有关的部分（去掉游标和时间）。 */
  const residentialSnapshot = (t: Town) => {
    const v = publicView(t.w);
    return JSON.stringify({ residential: v.residential, places: v.places, counts: v.counts });
  };

  it('会馆门前、别人家里、自己家里来回走：公开地图看起来完全一样，公开事件流没有任何新事件', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const all = [a, b];
    a.act('invite', { to: b.residentId });
    b.act('invite', { to: a.residentId });
    pulse(all);
    a.go('home');
    pulse(all);
    b.go(homeOf(a));
    pulse(all);
    const before = publicView(t.w);
    expect(before.residential.residents.map((r) => r.name).sort()).toEqual(['小岚', '阿灯'].sort());
    const snap0 = residentialSnapshot(t);
    const pubCount = t.w.db.scalar('SELECT COUNT(*) FROM public_events');

    // 小岚：阿灯家 → 会馆门前 → 阿灯家 → 会馆门前 → 自己家；阿灯：自己家 → 小岚家。全程没有离开住宅区
    b.go('residential');
    expect(b.row().location_id).toBe('residential');
    expect(residentialSnapshot(t)).toBe(snap0);
    pulse(all);
    b.go(homeOf(a));
    expect(b.row().location_id).toBe(homeOf(a));
    expect(residentialSnapshot(t)).toBe(snap0);
    pulse(all);
    b.go('home'); // 从阿灯家直接去自己家：出门、过会馆门口、进门，一趟走完
    expect(b.row().location_id).toBe(homeOf(b));
    expect(residentialSnapshot(t)).toBe(snap0);
    pulse(all);
    a.go(homeOf(b));
    expect(a.row().location_id).toBe(homeOf(b));
    expect(residentialSnapshot(t)).toBe(snap0);

    // 整个过程没有写入任何公开事件
    expect(t.w.db.scalar('SELECT COUNT(*) FROM public_events')).toBe(pubCount);
    checkSpaceInvariants(t);
  });

  it('从公共地点进住宅区、再出来：公开事件只有位置变化（路上、住宅区、公共地点），没有会馆门前和门牌', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    t.join('小岚', 'agent');
    const cursor = t.w.publicCursor();
    a.go('home');
    a.go('plaza');
    const events = t.w.readPublicEvents(cursor, 100).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.type === 'place')).toBe(true);
    expectClean('公开事件', JSON.stringify(events), ['home:', 'street_', 'house', 'residential_door', '"x"', '"z"']);
    const spots = events.map((e) => (e.data.resident as { at: string | null }).at);
    expect(spots).toContain('residential');
    expect(spots).toContain('plaza');
    // 从别处走到住宅区：只出现一次 at:'residential'（进门、出门都不重复）
    expect(spots.filter((x) => x === 'residential')).toHaveLength(1);
    expect(new Set(spots)).toEqual(new Set(['road', 'residential', 'plaza']));
  });

  it('住宅区里的人被请出家门：公开层面无变化', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const g = a.act('invite', { to: b.residentId }).invite.grantId;
    a.go('home');
    pulse([a, b]);
    b.go(homeOf(a));
    const snap = JSON.stringify(publicView(t.w).residential);
    const n = t.w.db.scalar('SELECT COUNT(*) FROM public_events');
    a.act('revoke_invite', { grantId: g });
    expect(b.row().location_id).toBe('residential');
    expect(JSON.stringify(publicView(t.w).residential)).toBe(snap);
    expect(t.w.db.scalar('SELECT COUNT(*) FROM public_events')).toBe(n);
  });

  it('被请出门之后，客人的视图里不再有屋里的东西', () => {
    const s = richTown();
    s.a.act('revoke_invite', { grantId: s.personalGrant });
    expect(s.b.row().location_id).toBe('residential');
    const v = s.b.view();
    expect(v.here?.home).toBeUndefined();
    expectClean('被请出后的小岚', JSON.stringify(v) + JSON.stringify(agentView(s.t.w, s.b.row(), s.b.clientId)), [DECOR, HOME_A]);
  });

  it('公开层面看不出谁进了哪一家：进门不产生公开事件，公开事件里没有进出门的时间点', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go('tea_house');
    b.go('tea_house');
    pulse([a, b]);
    const placeEvents = () =>
      (t.w.db.all('SELECT occurred_at, projection FROM public_events WHERE type = ? ORDER BY cursor', 'place') as { occurred_at: number; projection: string }[]).map((e) => ({
        at: e.occurred_at,
        resident: JSON.parse(e.projection).resident as { id: string; at: string | null },
      }));

    // 回家：公开位置依次是路上、广场、路上、住宅区；走到会馆门口那一刻出现 residential，进门那一刻没有任何公开事件
    let before = placeEvents().length;
    a.go('home');
    b.go('home');
    expect(a.row().location_id).toBe(homeOf(a));
    expect(b.row().location_id).toBe(homeOf(b));
    let fresh = placeEvents().slice(before);
    for (const x of [a, b]) {
      const mine = fresh.filter((e) => e.resident.id === x.residentId);
      expect(mine.at(-1)!.resident.at).toBe('residential');
      expect(mine.filter((e) => e.resident.at === 'residential')).toHaveLength(1);
      // 进门发生在 residential 事件之后：它之后没有任何关于这个人的公开事件
      expect(fresh.filter((e) => e.resident.id === x.residentId && e.at > mine.at(-1)!.at)).toHaveLength(0);
    }
    // 在屋里待着、屋里来回、出门到会馆门口：都没有公开事件
    before = placeEvents().length;
    stay(t, 40_000, [a, b]);
    a.go('residential');
    expect(a.row().location_id).toBe('residential');
    a.go('home');
    expect(placeEvents().slice(before)).toHaveLength(0);

    // 出门去茶馆：从会馆门口走出去才有公开事件（路上、广场……），公开事件里不带任何时间字段
    before = placeEvents().length;
    a.go('tea_house');
    fresh = placeEvents().slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((e) => e.resident.id === a.residentId)).toBe(true);
    expect(fresh.at(-1)!.resident.at).toBe('tea_house');
    expect(JSON.stringify(fresh.map((e) => e.resident))).not.toMatch(/arrive|lease|until|nav/i);
    expect(JSON.stringify(publicView(t.w))).not.toMatch(/arriveAt|leaseUntil/);
  });
});

describe('栖灯镇隐私：空间事件与场景快照', () => {
  const COORD = /"(x|z|points|heading|arriveAt|leaseUntil|renewEveryMs|navigationId|startedAt|crossings|instance|instance_id|scene_id)":/;
  const allEvents = (x: Actor, cursor?: string) => x.events(cursor ?? x.t.w.encodeCursor('r', x.residentId, 0)).events;

  it('别的居民拿到的事件（left / arrived / presence / chat …）里没有坐标，也没有路线和时间字段', () => {
    const s = richTown();
    // 让小满、小朵走几趟，阿灯出门，大家的事件都攒起来
    s.c.go('tea_house');
    s.d.go('plaza');
    s.a.go('plaza');
    s.b.go('plaza');
    s.d.go('home');
    for (const x of s.all) {
      const events = allEvents(x).filter((e) => ['left', 'arrived', 'presence', 'chat'].includes(e.type));
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(COORD.test(JSON.stringify(e.data)), `${x.name} 的 ${e.type} 事件里有结构化位置字段`).toBe(false);
        if (e.type === 'left' || e.type === 'arrived') {
          expect(Object.keys(e.data).sort(), `${e.type} 事件只有居民名片和区域标签`).toEqual(['resident', 'space']);
          expect(Object.keys(e.data.resident as object).sort()).toEqual(['id', 'kind', 'name']);
        }
      }
    }
  });

  it('站在会馆门前的人看到有人「到了 / 离开了」，但无法从事件区分对方是进了谁家还是走去了别处', () => {
    const t = makeTown();
    const w = t.join('守门人');
    const x = t.join('进屋的人');
    const y = t.join('出门的人', 'agent');
    const z = t.join('另一位住户');
    for (const p of [w, x, y, z]) p.go('residential');
    const cursor = w.view().cursor;
    const pubCursor = t.w.publicCursor();
    // 进屋：x 进自己家，z 进 x 的邻居（自己家）；出门：y 走去广场
    x.go('home');
    z.go('home');
    const afterEnter = allEvents(w, cursor);
    const enterLeft = afterEnter.filter((e) => e.type === 'left');
    expect(enterLeft.map((e) => (e.data.resident as { id: string }).id).sort()).toEqual([x.residentId, z.residentId, ].sort());
    expect(t.w.readPublicEvents(pubCursor).events).toHaveLength(0); // 进屋：公开位置不变，没有公开事件
    const cursor2 = w.view().cursor;
    const pub2 = t.w.publicCursor();
    y.go('plaza');
    const exitLeft = allEvents(w, cursor2).filter((e) => e.type === 'left');
    expect(exitLeft).toHaveLength(1);
    expect((exitLeft[0]!.data.resident as { id: string }).id).toBe(y.residentId);
    // 走去路上：公开位置变了（road），这是公开信息
    expect(t.w.readPublicEvents(pub2).events.map((e) => (e.data.resident as { at: string | null }).at)).toEqual(expect.arrayContaining(['road']));
    // 进屋和出门的 left 事件长得一模一样：区域标签都是 residential，没有目的地、没有谁家
    for (const e of [...enterLeft, ...exitLeft]) {
      expect(e.data.space).toBe('residential');
      expect(Object.keys(e.data).sort()).toEqual(['resident', 'space']);
      expectClean('left 事件', JSON.stringify(e), ['home:', 'street_', 'to', 'target', 'destination', homeOf(x), homeOf(z)]);
    }
    // 屋里的 x 没有出现在守门人的任何 arrived / presence 里
    expect(allEvents(w, cursor).filter((e) => e.type === 'arrived' && (e.data.resident as { id: string }).id === x.residentId)).toHaveLength(0);
    // 反过来：x 出门回到会馆门前，守门人看到「到了」，同样没有来处
    const cursor3 = w.view().cursor;
    x.go('residential');
    const back = allEvents(w, cursor3).filter((e) => e.type === 'arrived');
    expect(back).toHaveLength(1);
    expect(back[0]!.data).toMatchObject({ space: 'residential' });
    expectClean('arrived 事件', JSON.stringify(back), ['home:', homeOf(x)]);
  });

  it('公共场景的快照里没有任何私宅里的人；私宅快照只给屋里的人；离线的人不在快照里（自己除外）', () => {
    const s = richTown();
    const now = s.t.clock.t;
    // 小满在广场：看到广场上的人，看不到屋里的阿灯和小岚
    const outside = sceneView(s.t.w, s.c.row(), now);
    expect(outside.scene).toBe('town');
    expect(outside.actors.map((x) => x.id).sort()).toEqual([s.c.residentId, s.d.residentId].sort());
    expectClean('公共场景快照', JSON.stringify(outside), [homeOf(s.a), homeOf(s.b), s.a.residentId, s.b.residentId]);
    // 站在会馆门前的小朵也一样
    const door = sceneView(s.t.w, s.d.row(), now);
    expect(door.actors.map((x) => x.id)).not.toContain(s.a.residentId);
    expect(door.actors.map((x) => x.id)).not.toContain(s.b.residentId);
    // 阿灯家：只有阿灯和做客的小岚；不含别家
    const inside = sceneView(s.t.w, s.a.row(), now);
    expect(inside.scene).toBe('home');
    expect(inside.space).toBe(homeOf(s.a));
    expect(inside.actors.map((x) => x.id).sort()).toEqual([s.a.residentId, s.b.residentId].sort());
    expectClean('私宅快照', JSON.stringify(inside), [s.c.residentId, s.d.residentId, homeOf(s.c), homeOf(s.d), homeOf(s.b)]);
    // 小岚自己家（没人在）的快照从来不会出现在阿灯家的快照里；小岚进入自己家之后，阿灯家只剩阿灯
    s.b.go('home');
    const after = sceneView(s.t.w, s.a.row(), s.t.clock.t);
    expect(after.actors.map((x) => x.id)).toEqual([s.a.residentId]);
    expect(sceneView(s.t.w, s.b.row(), s.t.clock.t).actors.map((x) => x.id)).toEqual([s.b.residentId]);
    // 离线的人不在别人的快照里；她自己的快照里只有自己，看不到还在场的人（不在场就不在现场）
    s.c.leave();
    expect(sceneView(s.t.w, s.d.row(), s.t.clock.t).actors.map((x) => x.id)).not.toContain(s.c.residentId);
    const gone = sceneView(s.t.w, s.c.row(), s.t.clock.t);
    expect(gone.actors.map((x) => x.id)).toEqual([s.c.residentId]);
    expectClean('离线者的快照', JSON.stringify(gone), [s.a.residentId, s.b.residentId, s.d.residentId]);
    // 屋里的客人离线：主人的快照里没有他，他的快照里也没有主人
    s.b.go(homeOf(s.a));
    expect(sceneView(s.t.w, s.a.row(), s.t.clock.t).actors.map((x) => x.id)).toContain(s.b.residentId);
    s.b.leave();
    expect(sceneView(s.t.w, s.a.row(), s.t.clock.t).actors.map((x) => x.id)).toEqual([s.a.residentId]);
    expect(sceneView(s.t.w, s.b.row(), s.t.clock.t).actors.map((x) => x.id)).toEqual([s.b.residentId]);
  });

  it('本人视图里只有自己的坐标：here.residents 里别人没有坐标，agentView 里谁都没有坐标', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const v = a.view();
    expect(typeof v.location.x).toBe('number');
    expect(typeof v.location.z).toBe('number');
    expect(v.location.scene).toBe('town');
    const bp = b.pos();
    expect(JSON.stringify(v.here?.residents)).not.toMatch(/"(x|z|heading|scene)":/);
    expect(v.here!.residents.map((r) => r.id)).toEqual([b.residentId]);
    // 别人的坐标数值不出现在我的视图里（除非碰巧相同：这里两个人出生点相同时跳过比较）
    const mine = a.pos();
    if (bp.x !== mine.x || bp.z !== mine.z) expect(JSON.stringify(v)).not.toContain(`"x":${Math.round(bp.x * 1000) / 1000}`);
    const agent = JSON.stringify(agentView(t.w, a.row(), a.clientId));
    expect(agent).not.toMatch(/"(x|z|heading|points|scene|instance)":/);
    // 走路时：本人看得到路线的元信息（编号、版本、时间），身边的人看不到
    a.act('navigate', { to: 'tea_house' });
    expect(a.view().location.navigation).not.toBeNull();
    expect(JSON.stringify(b.view())).not.toMatch(/arriveAt|leaseUntil|navigationId/);
    expect(JSON.stringify(b.events())).not.toMatch(/arriveAt|leaseUntil|navigationId/);
  });

  it('门牌不表达谁在家：同一位在场邻居无论在家、在茶馆还是在会馆门前，别人看到的门牌一模一样', () => {
    const t = makeTown();
    const watcher = t.join('看门牌的人');
    const n = t.join('邻居');
    watcher.go('residential');
    const doorOf = () => watcher.view().here!.doors!.find((d) => d.home === homeOf(n))!;
    n.go('tea_house');
    const atPlaza = doorOf();
    n.go('home');
    const atHome = doorOf();
    n.go('residential');
    const atDoor = doorOf();
    expect(atHome).toEqual(atPlaza);
    expect(atDoor).toEqual(atPlaza);
    // 邻居离线了：门牌（公开地址）仍在列表外，不因在家与否而变化——这里只确认离线不留下「在家」的痕迹
    n.go('home');
    n.leave();
    expect(watcher.view().here!.doors!.map((d) => d.home)).not.toContain(homeOf(n));
  });
});

describe('栖灯镇隐私：现场发言的受众', () => {
  it('只有提交那一刻在同一区域、在场的人收得到；离线的、此刻在别的区域（含路上）的、后来才到的都没有', () => {
    const t = makeTown();
    const speaker = t.join('说话人');
    const hearer = t.join('听众', 'agent');
    const offline = t.join('离线者');
    const walker = t.join('在路上的人');
    const away = t.join('在别处的人');
    const all = [speaker, hearer, offline, walker, away];
    walker.go('tea_house');
    away.go('bookshop');
    pulse(all);
    walker.act('navigate', { to: 'plaza' }); // 从茶馆往广场走，说话的那一刻还在茶馆那边
    offline.leave();
    const MARK = 'AUDIENCE-暗号88';
    const out = speaker.act('speak', { text: MARK });
    expect(out.heardBy).toBe(1);
    walker.walk(); // 之后才走到广场
    expect(walker.row().location_id).toBe('plaza');
    offline.enter();
    const late = t.join('后来者');

    for (const x of [speaker, hearer]) {
      const text = JSON.stringify([meView(t.w, x.row(), x.clientId), chatHistory(t.w, x.residentId, null, 50)]);
      expect(text.includes(MARK), `${x.name} 应该听得到`).toBe(true);
    }
    for (const x of [offline, walker, away, late]) {
      for (const [label, text] of Object.entries(surfaces(t, x))) expectClean(`${x.name} 的 ${label}`, text, [MARK]);
    }
    for (const [label, text] of Object.entries(publicSurfaces(t))) expectClean(`公开 ${label}`, text, [MARK]);
  });

  it('发言不进公开事件流，也不进事实表（关系只读结构化事实，不读聊天文字）', () => {
    const t = makeTown();
    const a = t.join('甲');
    const b = t.join('乙', 'agent');
    const MARK = 'NOFACT-暗号66';
    a.act('speak', { text: MARK });
    b.act('speak', { text: MARK + '回' });
    expectClean('事实表', JSON.stringify(t.w.db.all('SELECT * FROM world_events')), [MARK]);
    expectClean('公开事件表', JSON.stringify(t.w.db.all('SELECT * FROM public_events')), [MARK]);
    expectClean('关系', JSON.stringify([relationsOf(t.w, a.residentId), relationsOf(t.w, b.residentId)]), [MARK]);
    expectClean('个人日报', JSON.stringify(report(t.w, { residentId: a.residentId }, t.w.today(), t.clock.t)), [MARK]);
  });
});

describe('栖灯镇隐私：权限错误的说法一致', () => {
  it('读不存在的信与读别人的信得到同样的错误；删别人的信同理', () => {
    const s = richTown();
    const other = s.c.fail('read_letter', { letterId: s.letterIds.l1 });
    const none = s.c.fail('read_letter', { letterId: 'm_does_not_exist' });
    expect(other.code).toBe(none.code);
    expect(other.reason).toBe(none.reason);
    expect(other.message).toBe(none.message);
    const del1 = s.c.fail('delete_letter', { letterId: s.letterIds.l1 });
    const del2 = s.c.fail('delete_letter', { letterId: 'm_does_not_exist' });
    expect([del1.code, del1.reason, del1.message]).toEqual([del2.code, del2.reason, del2.message]);
    // 撤销别人的邀请与撤销不存在的邀请一致
    const r1 = s.c.fail('revoke_invite', { grantId: s.personalGrant });
    const r2 = s.c.fail('revoke_invite', { grantId: 'h_does_not_exist' });
    expect([r1.code, r1.reason, r1.message]).toEqual([r2.code, r2.reason, r2.message]);
  });

  it('对离线的人、不存在的人当面操作，回应一致（不能用来探测谁在线）', () => {
    const t = makeTown();
    const a = t.join('甲');
    const b = t.join('乙', 'agent');
    b.leave();
    for (const [type, f] of [
      ['invite', (to: string) => ({ to })],
      ['ask_hobby', (to: string) => ({ target: to })],
      ['offer', (to: string) => ({ kind: 'gift', to, give: { coins: 1 } })],
    ] as const) {
      const off = a.fail(type, f(b.residentId));
      const ghost = a.fail(type, f('r_nobody'));
      expect([off.code, off.reason, off.message]).toEqual([ghost.code, ghost.reason, ghost.message]);
    }
  });
});

describe('二轮审查：未读邀请与已读回执', () => {
  it('寄信人离线、信未读：收信人站在会馆门前，门牌没有寄信人；寄信人的已发信箱没有 read', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go('residential');
    const out = a.act('send_letter', { to: b.residentId, body: '来坐坐', invite: true });
    a.leave();
    b.go('residential');
    expect((b.view().here?.doors ?? []).map((d) => d.owner.id)).not.toContain(a.residentId);
    expect(JSON.stringify(agentView(t.w, b.row(), b.clientId))).not.toContain('阿灯的家');
    const sent = listLetters(t.w, a.residentId, 'sent', null, 20, t.clock.t).letters.find((l) => l.id === out.letterId)!;
    expect('read' in sent).toBe(false);
  });
});
