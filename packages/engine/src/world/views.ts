/**
 * 视图投影：每个出口（网页、MCP、SSE 重同步）看到的内容都从这里生成。
 *
 * 三种权限层级：
 *  - 公开投影：任何人可看。位置只到区域这一层（公共地点、路上、住宅区），没有坐标，不含信件、背包、屋内、聊天内容。
 *  - 现场投影：只有此刻在同一区域、有权在场的居民可看（屋里有谁、桌上在做什么）。
 *  - 本人投影：背包、硬币、需要、愿望、关系、信箱。只给认证后的本人。
 * 不把内部状态整个返回；每个字段都是点名加进来的。
 */
import { DESTINATIONS, INTERESTS, PLACES, RESIDENTIAL_PLACE, TRAITS, homeId, homeOwner, isHome, laneName, placeDef } from './content.js';
import { parseJson } from './db.js';
import { activitiesAt, gameViewFor, gamesOfferedAt, type ActivityView } from './games.js';
import { myInteraction, objectsIn, publicEventsToday, weatherAt } from './interact.js';
import { checkHomeAccess, currentMood, settledNeeds, spaceName } from './life.js';
import { activeInviteOwners, invitesOf, mailboxSummary } from './mail.js';
import { RESIDENTIAL, card, publicSpot, zoneOf, type PublicSpot } from './project.js';
import { inventoryOf, itemLabel, openOffers, shopsAt } from './property.js';
import { recap, type Recap } from './reports.js';
import type { WorldService } from './service.js';
import { goalsOf, relationsOf, titlesOf } from './social.js';
import { objectReach, travelSeconds, whereabouts, type NavBrief } from './space.js';
import { localClock } from './time.js';
import type { ResidentRow } from './types.js';

function worldHeader(w: WorldService, now: number) {
  const weather = weatherAt(w, now);
  return { id: w.worldId, name: w.worldName, time: now, clock: localClock(w.params.timezone, now), date: w.today(now), timezone: w.params.timezone, weather: { id: weather.id, name: weather.name }, status: w.status };
}

// ───────────────────────── 公开投影 ─────────────────────────

export interface PublicView {
  world: ReturnType<typeof worldHeader>;
  /** 公共区域。through 为 true 的是路上（只是经过的地方，不能当目的地） */
  places: { id: string; name: string; kind: string; blurb: string; indoor: boolean; through: boolean; residents: PublicSpot[]; activities: { id: string; name: string; status: string; players: number }[] }[];
  /** 住宅区：只有人数和名字，不分在会馆门前还是谁家里 */
  residential: { residents: PublicSpot[] };
  events: ReturnType<typeof publicEventsToday>;
  counts: { residents: number; present: number; capacity: number };
  cursor: string;
}

export function publicView(w: WorldService): PublicView {
  const now = w.now();
  const spots = w.db
    .all('SELECT resident_id FROM residents WHERE world_id = ? AND present_since IS NOT NULL ORDER BY resident_id', w.worldId)
    .map((row) => publicSpot(w.mustResident(String(row.resident_id))));
  return {
    world: worldHeader(w, now),
    places: PLACES.filter((p) => p.kind === 'public').map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      blurb: p.blurb,
      indoor: p.indoor,
      through: Boolean(p.through),
      residents: spots.filter((s) => s.at === p.id),
      activities: activitiesAt(w, p.id).map((a) => ({ id: a.id, name: a.name, status: a.status, players: a.players.length })),
    })),
    residential: { residents: spots.filter((s) => s.at === RESIDENTIAL) },
    events: publicEventsToday(w, now),
    counts: { residents: w.db.scalar('SELECT COUNT(*) FROM residents WHERE world_id = ?', w.worldId), present: spots.length, capacity: w.params.activeResidentLimit },
    cursor: w.publicCursor(),
  };
}

// ───────────────────────── 现场与本人 ─────────────────────────

/** 别人眼里的一位居民（同一空间里）。 */
function neighborCard(w: WorldService, r: ResidentRow, now: number) {
  const mood = currentMood(w, r, now, false);
  return {
    ...card(r),
    bio: r.state.bio,
    traits: r.state.traits.map((id) => TRAITS.find((t) => t.id === id)?.name ?? id),
    titles: titlesOf(w, r.resident_id, true),
    ...(mood ? { mood: mood.name } : {}),
  };
}

export interface HereView {
  space: string;
  name: string;
  kind: 'public' | 'residential' | 'home';
  blurb: string;
  residents: ReturnType<typeof neighborCard>[];
  /** near：此刻够得着（公共物件按距离算，要先走到旁边；家里的物件在屋里就够得着） */
  objects: (ReturnType<typeof objectsIn>[number] & { near: boolean })[];
  shops: ReturnType<typeof shopsAt>;
  activities: ActivityView[];
  games: ReturnType<typeof gamesOfferedAt>;
  /** 可以去的地方（navigate 的目的地）。seconds 是大概要走多久，在路上时没有 */
  exits: { id: string; name: string; seconds?: number }[];
  /** 会馆门前：从这里进各家的门 */
  doors?: { home: string; owner: ReturnType<typeof card>; lane: string; no: number; canEnter: boolean }[];
  /** 住宅里：主人和摆出来的东西 */
  home?: { owner: ReturnType<typeof card>; mine: boolean; decor: string[] };
  /** 书屋：藏书架上现在能借的书 */
  library?: { bookId: string; title: string; available: number }[];
  chat: { messageId: number; from: ReturnType<typeof card>; text: string; at: number }[];
}

function hereView(w: WorldService, r: ResidentRow, space: string, now: number): HereView {
  const def = placeDef(space);
  const home = isHome(space);
  const exits: HereView['exits'] = [];
  for (const d of DESTINATIONS) {
    if (d.id === space) continue;
    const seconds = travelSeconds(w, space, d.id);
    exits.push({ id: d.id, name: d.name, ...(seconds !== null ? { seconds } : {}) });
  }
  const others = w.audienceIn(space).filter((x) => x.resident_id !== r.resident_id);
  const view: HereView = {
    space,
    name: spaceName(w, space, r.resident_id),
    kind: home ? 'home' : def?.kind === 'residential' ? 'residential' : 'public',
    blurb: home ? '住宅是私密的：屋里说的话只有屋里的人听得到。' : (def?.blurb ?? ''),
    residents: others.map((x) => neighborCard(w, x, now)),
    objects: objectsIn(w, space).map((o) => ({ ...o, near: objectReach(w, r.resident_id, o.id, now)?.near ?? true })),
    shops: home ? [] : shopsAt(w, space, now),
    activities: home ? [] : activitiesAt(w, space),
    games: home ? [] : gamesOfferedAt(w, space),
    exits,
    chat: hereChat(w, r.resident_id, space, now),
  };
  if (space === RESIDENTIAL_PLACE) {
    // 只列够用的门：自己家、我手上有效邀请对应的家、此刻在场的邻居的家（不遍历全部注册居民）
    const DOOR_CAP = 60;
    const ids = new Set<string>([r.resident_id]);
    for (const id of activeInviteOwners(w, r.resident_id, now, DOOR_CAP)) ids.add(id);
    for (const x of w.db.all('SELECT resident_id FROM residents WHERE world_id = ? AND present_since IS NOT NULL ORDER BY street_id, house_no LIMIT ?', w.worldId, DOOR_CAP)) ids.add(String(x.resident_id));
    view.doors = [...ids]
      .map((id) => w.mustResident(id))
      .slice(0, DOOR_CAP)
      .map((owner) => ({ home: homeId(owner.resident_id), owner: card(owner), lane: laneName(owner.street_id), no: owner.house_no, canEnter: checkHomeAccess(w, r, homeId(owner.resident_id), now).ok }))
      .sort((x, y) => x.lane.localeCompare(y.lane) || x.no - y.no);
  }
  if (home) {
    const owner = w.mustResident(homeOwner(space));
    view.home = {
      owner: card(owner),
      mine: owner.resident_id === r.resident_id,
      decor: w.db.all('SELECT * FROM items WHERE owner_id = ? AND holder_id = ? AND shelved > 0 ORDER BY type, created_at', owner.resident_id, owner.resident_id).map((it) => (it.stack === 1 ? `${itemLabel(it)} ×${it.shelved}` : itemLabel(it))),
    };
  }
  if (space === 'bookshop') {
    const counts = new Map<string, { title: string; n: number }>();
    for (const it of w.db.all("SELECT holder_id, metadata_json FROM items WHERE owner_id = 'town' AND type = 'book'")) {
      const meta = parseJson<{ bookId?: string; title?: string }>(it.metadata_json, {});
      if (!meta.bookId) continue;
      const c = counts.get(meta.bookId) ?? { title: meta.title ?? '', n: 0 };
      if (it.holder_id === 'town') c.n++;
      counts.set(meta.bookId, c);
    }
    view.library = [...counts].map(([bookId, c]) => ({ bookId, title: c.title, available: c.n }));
  }
  return view;
}

/** 给本人的行动建议：只是提示，不替居民做决定，也不因为数值低惩罚谁。 */
function suggestions(w: WorldService, r: ResidentRow, now: number, needs: { energy: number; social: number; interest: number }, mail: { unread: number }): string[] {
  const out: string[] = [];
  if (mail.unread > 0) out.push(`信箱里有 ${mail.unread} 封新信，回家可以读。`);
  if (needs.energy < 30) out.push('有点累了：回家在小憩角休息，或者喝碗汤、吃块饼干。');
  if (needs.social < 35) out.push('好一阵没和人相处了：去茶馆找人一起喝茶，或者在游戏馆凑一桌。');
  if (needs.interest < 35) {
    const fav = r.state.interests.map((id) => INTERESTS.find((i) => i.id === id)).find(Boolean);
    out.push(fav ? `想做点喜欢的事：${fav.name}相关的地方在${placeDef(fav.place)?.name ?? ''}。` : '想做点喜欢的事：读书、做汤、照料花箱都可以。');
  }
  if (weatherAt(w, now).id === 'rain') out.push('外面在下小雨，室内的活动会更舒服一点。');
  const open = publicEventsToday(w, now).find((e) => e.status === 'open');
  if (open) out.push(`「${open.title}」正在${placeDef(open.place)?.name ?? ''}进行。`);
  return out.slice(0, 4);
}

export interface MeView {
  world: ReturnType<typeof worldHeader>;
  me: {
    id: string;
    name: string;
    kind: 'human' | 'agent';
    bio: string;
    traits: { id: string; name: string }[];
    interests: { id: string; name: string }[];
    titles: string[];
    home: { id: string; street: string; streetName: string; no: number };
    needs: { energy: number; social: number; interest: number };
    mood: ReturnType<typeof currentMood>;
    settings: ResidentRow['state']['settings'];
    present: boolean;
  };
  control: { epoch: number; mine: boolean; presenceEpoch: number };
  context: { version: number; activityId: string | null };
  /** 带在动作请求里；过期后重新读视图会拿到新的 */
  actionWindow: string;
  cursor: string;
  /**
   * 我在哪：区域（space）和场景里的坐标（米）。navigation 是正在走的那一趟：
   * 要按 renewEveryMs 续租（普通程序做，不用模型），leaseUntil 之前没续上就会停在半路。
   */
  location: { space: string; name: string; scene: string; x: number; z: number; navigation: NavBrief | null };
  here: HereView | null;
  inventory: ReturnType<typeof inventoryOf>;
  goals: ReturnType<typeof goalsOf>;
  mail: { unread: number; total: number };
  invites: ReturnType<typeof invitesOf>;
  offers: ReturnType<typeof openOffers>;
  interaction: ReturnType<typeof myInteraction>;
  game: ReturnType<typeof gameViewFor>;
  events: ReturnType<typeof publicEventsToday>;
  suggestions: string[];
  recap?: Recap;
}

export function meView(w: WorldService, r: ResidentRow, clientId: string, opts: { recapSince?: number | null } = {}): MeView {
  const now = w.now();
  const needs = settledNeeds(w, r, now);
  const space = w.spaceOf(r);
  const where = whereabouts(w, r, now);
  const mail = mailboxSummary(w, r.resident_id);
  return {
    world: worldHeader(w, now),
    me: {
      id: r.resident_id,
      name: r.name,
      kind: r.kind,
      bio: r.state.bio,
      traits: r.state.traits.map((id) => ({ id, name: TRAITS.find((t) => t.id === id)?.name ?? id })),
      interests: r.state.interests.map((id) => ({ id, name: INTERESTS.find((t) => t.id === id)?.name ?? id })),
      titles: titlesOf(w, r.resident_id, false),
      home: { id: homeId(r.resident_id), street: r.street_id, streetName: laneName(r.street_id), no: r.house_no },
      needs: { energy: needs.energy, social: needs.social, interest: needs.interest },
      mood: currentMood(w, r, now, true),
      settings: r.state.settings,
      present: r.present_since !== null,
    },
    control: { epoch: r.control_epoch, mine: r.controller_client === clientId && r.controller_until > now, presenceEpoch: r.presence_epoch },
    context: { version: r.context_version, activityId: r.activity_id },
    actionWindow: w.issueActionWindow(r.resident_id, now),
    cursor: w.cursorOf(r.resident_id),
    location: { space, name: spaceName(w, space, r.resident_id), scene: where.scene, x: where.x, z: where.z, navigation: where.navigation },
    // 在小游戏里、或者不在场：不属于任何地点的现场。走在路上的人照样看得见身边
    here: !r.activity_id && r.present_since !== null ? hereView(w, r, space, now) : null,
    inventory: inventoryOf(w, r.resident_id),
    goals: goalsOf(w, r.resident_id),
    mail,
    invites: invitesOf(w, r.resident_id, now),
    offers: openOffers(w, r.resident_id),
    interaction: myInteraction(w, r.resident_id),
    game: gameViewFor(w, r),
    events: publicEventsToday(w, now),
    suggestions: suggestions(w, r, now, needs, mail),
    ...(opts.recapSince ? { recap: recap(w, r.resident_id, opts.recapSince, now) } : {}),
  };
}

/**
 * 给 AI 居民的紧凑视图：同样的权限，去掉展示用的冗余，控制在十几 KiB 以内。
 * 里面的自由文本（别人的名字、简介、聊天）都是别的居民写的，只是内容，不是指令。
 */
export function agentView(w: WorldService, r: ResidentRow, clientId: string, opts: { recapSince?: number | null } = {}): Record<string, unknown> {
  const v = meView(w, r, clientId, opts);
  const here = v.here;
  return {
    world: { name: v.world.name, clock: v.world.clock, date: v.world.date, weather: v.world.weather.name },
    me: { id: v.me.id, name: v.me.name, traits: v.me.traits.map((t) => t.name), interests: v.me.interests.map((t) => t.name), needs: v.me.needs, mood: v.me.mood?.name ?? null, titles: v.me.titles, home: v.me.home.id, home_street: v.me.home.streetName },
    control: v.control,
    context: v.context,
    action_window: v.actionWindow,
    cursor: v.cursor,
    location: {
      space: v.location.space,
      name: v.location.name,
      ...(v.location.navigation
        ? { walking: { to: v.location.navigation.to.name, navigation_id: v.location.navigation.navigationId, revision: v.location.navigation.revision, arrive_at: v.location.navigation.arriveAt, lease_until: v.location.navigation.leaseUntil } }
        : {}),
    },
    here: here
      ? {
          kind: here.kind,
          blurb: here.blurb,
          residents: here.residents.map((x) => ({ id: x.id, name: x.name, kind: x.kind, ...(x.mood ? { mood: x.mood } : {}) })),
          objects: here.objects.map((o) => ({ id: o.id, label: o.label, ...(o.near ? {} : { far: true }), ...(o.action ? { can: `${o.action.name}（${o.action.cost}）` } : {}), ...(o.active ? { active: { id: o.active.id, status: o.active.status, people: o.active.participants.map((p) => p.name), ends_at: o.active.endsAt } } : {}) })),
          shops: here.shops.map((s) => ({ id: s.id, name: s.name, goods: s.goods.filter((g) => g.stock > 0).map((g) => ({ sku: g.sku, name: g.name, price: g.price })) })),
          activities: here.activities.map((a) => ({ id: a.id, name: a.name, status: a.status, players: a.players.map((p) => p.name), need: a.min })),
          games: here.games.map((g) => ({ type: g.type, name: g.name, players: `${g.min}~${g.max}` })),
          exits: here.exits.map((e) => ({ to: e.id, name: e.name })),
          ...(here.doors ? { doors: here.doors.filter((d) => d.canEnter).map((d) => ({ home: d.home, owner: d.owner.name })) } : {}),
          ...(here.home ? { home_of: here.home.owner.name } : {}),
          ...(here.library ? { library: here.library.filter((b) => b.available > 0).map((b) => ({ bookId: b.bookId, title: b.title })) } : {}),
          recent_chat: here.chat.slice(-8).map((c) => ({ from: c.from.name, text: c.text })),
        }
      : null,
    coins: v.inventory.coins.available,
    items: v.inventory.items.map((i) => ({ ...(!i.stackable && i.category !== 'consumable' ? { itemId: i.itemId } : {}), type: i.type, name: i.name, qty: i.qty, ...(i.borrowedFrom ? { borrowed_from: i.borrowedFrom } : {}) })),
    // 候选（长期愿望完成后可自选的新方向）单独标出来：没有进度，choose_goal {goalId} 选定
    goals: v.goals.map((g) =>
      g.status === 'offered'
        ? { id: g.id, kind: g.kind, title: g.title, how: g.description, offered: true }
        : { id: g.id, kind: g.kind, title: g.title, how: g.description, progress: `${g.progress}/${g.target}` },
    ),
    mail_unread: v.mail.unread,
    invites: v.invites.received.map((i) => ({ home: i.home, host: i.host.name, expires_at: i.expiresAt })),
    offers: v.offers.map((o) => ({ id: o.id, text: o.text, mine: o.from.id === v.me.id })),
    doing: v.interaction ? { id: v.interaction.id, name: v.interaction.name, status: v.interaction.status, ends_at: v.interaction.endsAt } : null,
    game: v.game ? { game_id: v.game.game_id, name: v.game.name, status: v.game.status, phase_id: v.game.phase_id, your_turn: v.game.your_turn ?? false, todo: v.game.todo ?? null, you: v.game.you, public: v.game.public, events: v.game.events.slice(-12) } : null,
    events_today: v.events.filter((e) => e.status === 'open' || e.status === 'scheduled').map((e) => ({ title: e.title, place: placeDef(e.place)?.name, status: e.status, opens_at: e.opensAt })),
    suggestions: v.suggestions,
    ...(v.recap ? { recap: v.recap.lines } : {}),
  };
}

// ───────────────────────── 分页查询 ─────────────────────────

/** 镇上的居民名录（公开资料）：写信要靠它找收信人。 */
export function directory(w: WorldService, now: number): { id: string; name: string; kind: string; bio: string; titles: string[]; present: boolean; at: string | null }[] {
  return w.db
    .all('SELECT resident_id FROM residents WHERE world_id = ? ORDER BY created_at LIMIT 500', w.worldId)
    .map((row) => {
      const r = w.mustResident(String(row.resident_id));
      const spot = publicSpot(r);
      void now;
      return { id: r.resident_id, name: r.name, kind: r.kind, bio: r.state.bio, titles: titlesOf(w, r.resident_id, true), present: r.present_since !== null, at: spot.at };
    });
}

/**
 * 对外的现场发言编号：每位居民自己连续的序号（stream_heads 里 chat:<id> 的高水位，发言时给每个受众各取一个）。
 * 内部 message_id 是全世界共用的，不外露。某条消息的序号 = 高水位 - 我这边比它更新的消息条数；清理旧消息不会让它变。
 */
function chatHigh(w: WorldService, residentId: string): number {
  return Number(w.db.scalar('SELECT high_water FROM stream_heads WHERE stream_key = ?', `chat:${residentId}`) ?? 0);
}
function chatSeqOf(w: WorldService, residentId: string, high: number, messageId: number): number {
  return high - Number(w.db.scalar('SELECT COUNT(*) FROM chat_audience WHERE resident_id = ? AND message_id > ?', residentId, messageId));
}

function hereChat(w: WorldService, residentId: string, space: string, now: number): HereView['chat'] {
  const cut = now - 30 * 60_000;
  // message_id 随时间递增：给受众表的主键扫描加下界（30 分钟窗口内最早的消息），查询量与历史长度无关
  const rows = w.db.all(
    `SELECT m.message_id, m.sender_id, m.body, m.sent_at FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id
     WHERE a.resident_id = ? AND a.message_id >= (SELECT COALESCE(MIN(message_id), 9223372036854775807) FROM chat_messages WHERE sent_at > ?)
       AND m.space_id = ? AND m.sent_at > ? ORDER BY a.message_id DESC LIMIT 20`,
    residentId,
    cut,
    space,
    cut,
  );
  const high = chatHigh(w, residentId);
  return rows
    .reverse()
    .map((m) => ({ messageId: chatSeqOf(w, residentId, high, Number(m.message_id)), from: card(w.mustResident(m.sender_id)), text: String(m.body), at: Number(m.sent_at) }));
}

/** 我听到过的现场发言（按我自己的消息序号往前翻页）。只包含当时我在受众里的消息。 */
export function chatHistory(w: WorldService, residentId: string, before: number | null, limit: number): { messages: { messageId: number; space: string; spaceName: string; from: ReturnType<typeof card>; text: string; at: number }[]; next: number | null } {
  const lim = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 30)));
  const high = chatHigh(w, residentId);
  // before 是序号：跳过序号 >= before 的那些（它们是最新的 high-before+1 条）
  const skip = before === null || !Number.isFinite(before) ? 0 : Math.max(0, high - Math.floor(before) + 1);
  const rows = w.db.all(
    `SELECT m.* FROM chat_audience a JOIN chat_messages m ON m.message_id = a.message_id
     WHERE a.resident_id = ? ORDER BY a.message_id DESC LIMIT ? OFFSET ?`,
    residentId,
    lim + 1,
    skip,
  );
  const page = rows.slice(0, lim);
  const top = page.length ? chatSeqOf(w, residentId, high, Number(page[0]!.message_id)) : 0;
  const messages = page.map((m, i) => ({ messageId: top - i, space: String(m.space_id), spaceName: spaceName(w, m.space_id, residentId), from: card(w.mustResident(m.sender_id)), text: String(m.body), at: Number(m.sent_at) }));
  return { messages, next: rows.length > lim ? top - (page.length - 1) : null };
}

export { relationsOf };
