/**
 * 家具与共同活动、天气、公共事件。
 *
 * 共同活动由内容数据定义（见 content.ts 的 INTERACTIONS），这里只有固定的处理器：
 * 发起 → 等人（open）→ 正式开始（running，此时才消耗投入）→ 到时间完成（completed）。
 * 开始前取消全数退回投入；开始后中途离开不退、也没有这次的收获。完成由定时任务结算，保留应完成的时间。
 * 社交收益只在实际参与者不少于两人时生效；每天前几次全额，之后减半；产出有每日上限。
 */
import {
  HOME_STARTER_OBJECTS,
  INTERACTIONS,
  PUBLIC_EVENTS,
  PUBLIC_OBJECTS,
  WEATHERS,
  WEATHER_SLOT_MS,
  bookDef,
  homeId,
  homeOwner,
  isHome,
  itemDef,
  objectTypeName,
  placeDef,
  type InteractionDef,
  type PublicEventDef,
} from './content.js';
import { type Row, parseJson } from './db.js';
import { badRequest, precondition } from './errors.js';
import { addMood, applyNeeds, bumpCounter, counter, settledNeeds } from './life.js';
import { card } from './project.js';
import { addStack, mint, release, reserve, takeStack } from './property.js';
import { sha256, type WorldService } from './service.js';
import { localParts, localToUtc } from './time.js';
import type { ResidentRow } from './types.js';

// ───────────────────────── 天气 ─────────────────────────

/** 天气按现实时间分段，由世界编号和时间段决定：任何人、任何时候查到的都一样，重启不变。 */
export function weatherAt(w: WorldService, at: number): { id: string; name: string; until: number } {
  const slot = Math.floor(at / WEATHER_SLOT_MS);
  const total = WEATHERS.reduce((s, x) => s + x.weight, 0);
  let roll = Number.parseInt(sha256(`weather:${w.worldId}:${slot}`).slice(0, 8), 16) % total;
  let pick = WEATHERS[0]!;
  for (const x of WEATHERS) {
    roll -= x.weight;
    if (roll < 0) {
      pick = x;
      break;
    }
  }
  return { id: pick.id, name: pick.name, until: (slot + 1) * WEATHER_SLOT_MS };
}

// ───────────────────────── 物件与活动的视图 ─────────────────────────

interface StoredDef extends InteractionDef {
  /** 读书时拿着的那本书偏向的兴趣 */
  bookTag?: string;
  bookTitle?: string;
}

export interface InteractionView {
  id: string;
  def: string;
  name: string;
  status: string;
  objectId: string;
  initiator: ReturnType<typeof card>;
  participants: ReturnType<typeof card>[];
  min: number;
  max: number;
  endsAt: number | null;
  lobbyExpiresAt: number;
  cost: string;
}

function participantsOf(w: WorldService, interactionId: string): ResidentRow[] {
  return w.db
    .all('SELECT resident_id FROM interaction_participants WHERE interaction_id = ? AND active = 1 ORDER BY joined_at, resident_id', interactionId)
    .map((p) => w.mustResident(String(p.resident_id)));
}

export function interactionView(w: WorldService, row: Row): InteractionView {
  const def = parseJson<StoredDef>(row.def_json, {} as StoredDef);
  return {
    id: String(row.interaction_id),
    def: String(row.def_id),
    name: def.bookTitle ? `读${def.bookTitle}` : def.name,
    status: String(row.status),
    objectId: String(row.object_id),
    initiator: card(w.mustResident(row.initiator_id)),
    participants: participantsOf(w, row.interaction_id).map(card),
    min: def.participants.min,
    max: def.participants.max,
    endsAt: row.ends_at === null ? null : Number(row.ends_at),
    lobbyExpiresAt: Number(row.lobby_expires_at),
    cost: def.costText,
  };
}

export interface ObjectView {
  id: string;
  type: string;
  label: string;
  /** 这件东西能做的活动 */
  action: { def: string; name: string; cost: string; min: number; max: number } | null;
  active: InteractionView | null;
}

export function objectsIn(w: WorldService, spaceId: string): ObjectView[] {
  return w.db.all('SELECT * FROM placed_objects WHERE space_id = ? ORDER BY created_at, object_id', spaceId).map((o) => {
    const def = INTERACTIONS.find((i) => i.objectType === o.type);
    const active = w.db.get("SELECT * FROM interactions WHERE object_id = ? AND status IN ('open','running')", o.object_id);
    return {
      id: String(o.object_id),
      type: String(o.type),
      label: String(o.label),
      action: def ? { def: def.id, name: def.name, cost: def.costText, min: def.participants.min, max: def.participants.max } : null,
      active: active ? interactionView(w, active) : null,
    };
  });
}

/** 我正在参与的共同活动。 */
export function myInteraction(w: WorldService, residentId: string): InteractionView | null {
  const row = w.db.get(
    "SELECT i.* FROM interactions i JOIN interaction_participants p ON p.interaction_id = i.interaction_id WHERE p.resident_id = ? AND p.active = 1 AND i.status IN ('open','running')",
    residentId,
  );
  return row ? interactionView(w, row) : null;
}

// ───────────────────────── 公共事件 ─────────────────────────

export interface PublicEventView {
  id: string;
  def: string;
  title: string;
  place: string;
  status: string;
  opensAt: number;
  closesAt: number;
  progress?: number;
  target?: number;
  text: string;
}

function eventView(row: Row): PublicEventView {
  const def = parseJson<PublicEventDef>(row.def_json, {} as PublicEventDef);
  return {
    id: String(row.instance_id),
    def: String(row.def_id),
    title: def.title,
    place: def.place,
    status: String(row.status),
    opensAt: Number(row.opens_at),
    closesAt: Number(row.closes_at),
    ...(row.target > 0 ? { progress: Number(row.progress), target: Number(row.target) } : {}),
    text: def.openText,
  };
}

/** 今天的公共事件（公开信息）。 */
export function publicEventsToday(w: WorldService, now: number): PublicEventView[] {
  return w.db.all('SELECT * FROM public_event_instances WHERE business_date = ? ORDER BY opens_at', w.today(now)).map(eventView);
}

function openEvent(w: WorldService, defId: string): Row | undefined {
  return w.db.get("SELECT * FROM public_event_instances WHERE def_id = ? AND status = 'open'", defId);
}

/** 为某个世界日生成事件实例（每种每天最多一条，由唯一约束保证）。已经错过的时间窗直接记为错过。 */
function ensureEventInstances(w: WorldService, date: string, now: number): void {
  const weekday = localParts(w.params.timezone, localToUtc(w.params.timezone, date, 12, 0)).weekday;
  for (const def of PUBLIC_EVENTS) {
    if (def.weekdays && !def.weekdays.includes(weekday)) continue;
    if (w.db.get('SELECT 1 AS x FROM public_event_instances WHERE def_id = ? AND business_date = ?', def.id, date)) continue;
    const opensAt = localToUtc(w.params.timezone, date, def.startHour, def.startMinute);
    const closesAt = opensAt + def.durationMinutes * 60_000;
    const id = `pe_${def.id}_${date}`;
    // 整个时间窗都在停机里过去了：记为错过，不补造参与者，也不让人回到过去参加
    const missed = closesAt <= now;
    w.db.run(
      'INSERT INTO public_event_instances(instance_id, def_id, def_json, business_date, opens_at, closes_at, status, target) VALUES (?,?,?,?,?,?,?,?)',
      id,
      def.id,
      JSON.stringify(def),
      date,
      opensAt,
      closesAt,
      missed ? 'missed' : 'scheduled',
      def.target ?? 0,
    );
    if (!missed) {
      w.schedule('public_event_open', `pe:open:${id}`, opensAt, { instanceId: id });
      w.schedule('public_event_close', `pe:close:${id}`, closesAt, { instanceId: id });
    }
  }
}

// ───────────────────────── 安装 ─────────────────────────

export function installInteract(w: WorldService): void {
  // 公共场所的固定物件：只生成一次
  w.commit(() => {
    for (const o of PUBLIC_OBJECTS) {
      w.db.run('INSERT OR IGNORE INTO placed_objects(object_id, world_id, space_id, type, label, owner_id, config_version, created_at) VALUES (?,?,?,?,?,NULL,1,?)', o.id, w.worldId, o.place, o.type, o.label, w.now());
    }
  });

  // 新住宅自带的家具
  w.hooks.registered.push((r, now) => {
    for (const type of HOME_STARTER_OBJECTS) {
      w.db.run('INSERT INTO placed_objects(object_id, world_id, space_id, type, label, owner_id, config_version, created_at) VALUES (?,?,?,?,?,?,1,?)', w.id('o'), w.worldId, homeId(r.resident_id), type, objectTypeName(type), r.resident_id, now);
    }
  });

  const broadcast = (row: Row, at: number, extra: Record<string, unknown> = {}) => {
    const view = interactionView(w, row);
    const ids = new Set(w.audienceIn(row.space_id).map((x) => x.resident_id));
    for (const p of view.participants) ids.add(p.id);
    w.emitTo(ids, 'interaction', { interaction: view, ...extra }, at);
  };

  const cancel = (row: Row, reason: string, at: number) => {
    const changed = w.db.run("UPDATE interactions SET status = 'cancelled', closed_at = ?, close_reason = ? WHERE interaction_id = ? AND status IN ('open','running')", at, reason, row.interaction_id).changes;
    if (changed !== 1) return;
    // 开始前取消：预留的投入全数退回。开始后投入已经消耗，不退
    release(w, 'interaction', row.interaction_id);
    const ids = w.db.all('SELECT resident_id FROM interaction_participants WHERE interaction_id = ? AND active = 1', row.interaction_id).map((p) => String(p.resident_id));
    w.db.run('UPDATE interaction_participants SET active = 0, left_at = ? WHERE interaction_id = ? AND active = 1', at, row.interaction_id);
    w.cancelJob(`ix:${row.interaction_id}`);
    w.cancelJob(`ixl:${row.interaction_id}`);
    const view = interactionView(w, { ...row, status: 'cancelled' });
    const audience = new Set([...w.audienceIn(row.space_id).map((x) => x.resident_id), ...ids]);
    w.emitTo(audience, 'interaction', { interaction: view, reason }, at);
  };

  const begin = (row: Row, now: number) => {
    const def = parseJson<StoredDef>(row.def_json, {} as StoredDef);
    release(w, 'interaction', row.interaction_id);
    if (row.free_inputs !== 1) for (const input of def.inputs) takeStack(w, row.initiator_id, input.type, input.qty);
    const endsAt = now + def.durationSeconds * 1000;
    w.db.run("UPDATE interactions SET status = 'running', started_at = ?, ends_at = ? WHERE interaction_id = ?", now, endsAt, row.interaction_id);
    w.cancelJob(`ixl:${row.interaction_id}`);
    w.schedule('interaction_finish', `ix:${row.interaction_id}`, endsAt, { interactionId: row.interaction_id });
    broadcast({ ...row, status: 'running', started_at: now, ends_at: endsAt }, now);
  };

  /** 某人退出一个活动（走开、离线、被请出门、主动退出）。 */
  const leave = (residentId: string, at: number, why: string, onlyOpen = false) => {
    const row = w.db.get(
      "SELECT i.* FROM interactions i JOIN interaction_participants p ON p.interaction_id = i.interaction_id WHERE p.resident_id = ? AND p.active = 1 AND i.status IN ('open','running')",
      residentId,
    );
    if (!row || (onlyOpen && row.status !== 'open')) return false;
    if (row.status === 'open' && row.initiator_id === residentId) {
      cancel(row, `发起人${why}`, at);
      return true;
    }
    w.db.run('UPDATE interaction_participants SET active = 0, left_at = ? WHERE interaction_id = ? AND resident_id = ?', at, row.interaction_id, residentId);
    if (participantsOf(w, row.interaction_id).length === 0) cancel(row, '大家都离开了', at);
    else broadcast(row, at);
    return true;
  };

  w.hooks.leaveSpace.push((r, _space, at) => void leave(r.resident_id, at, '离开了'));
  // 离线：还没开始的席位让出来；已经开始的照常完成
  w.hooks.offline.push((r, at) => void leave(r.resident_id, at, '离线了', true));

  // ── 发起 ──
  w.handlers.set('start_interaction', ({ r, action, now }) => {
    const space = w.spaceOf(r);
    const obj = w.db.get('SELECT * FROM placed_objects WHERE object_id = ?', String(action.objectId ?? ''));
    if (!space || !obj || obj.space_id !== space) throw precondition('这件东西不在你身边。', 'not_here');
    const def = INTERACTIONS.find((i) => i.objectType === obj.type && (action.interaction === undefined || i.id === action.interaction));
    if (!def) throw precondition('这件东西现在没有可以做的事。', 'no_interaction');
    if (def.permission === 'own_home' && space !== homeId(r.resident_id)) throw precondition(`${def.name}只能在自己家。`, 'not_home');
    if (w.db.get("SELECT 1 AS x FROM interactions WHERE object_id = ? AND status IN ('open','running')", obj.object_id)) throw precondition(`${obj.label}正有人在用，可以加入或者等一等。`, 'busy');
    if (myInteraction(w, r.resident_id)) throw precondition('你手上还有一件事没做完。', 'already_busy');
    const stored: StoredDef = JSON.parse(JSON.stringify(def)) as StoredDef;
    if (def.id === 'read' && typeof action.itemId === 'string') {
      const it = w.db.get("SELECT metadata_json FROM items WHERE item_id = ? AND holder_id = ? AND type = 'book'", action.itemId, r.resident_id);
      const book = it ? bookDef(parseJson<{ bookId?: string }>(it.metadata_json, {}).bookId ?? '') : undefined;
      if (!book) throw precondition('这本书不在你手里。', 'not_yours');
      stored.bookTag = book.tag;
      stored.bookTitle = book.title;
    }
    // 茶会期间在茶馆喝茶，由茶馆出茶叶
    const free = def.id === 'share_tea' && space === 'tea_house' && Boolean(openEvent(w, 'tea_party'));
    const id = w.id('x');
    if (!free) for (const input of def.inputs) reserve(w, 'interaction', id, r.resident_id, { type: input.type, qty: input.qty });
    const lobbyExpires = now + w.params.activityLobbyTtlMs;
    w.db.run(
      "INSERT INTO interactions(interaction_id, world_id, def_id, def_version, def_json, object_id, space_id, initiator_id, status, free_inputs, created_at, lobby_expires_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?,?)",
      id,
      w.worldId,
      def.id,
      def.version,
      JSON.stringify(stored),
      obj.object_id,
      space,
      r.resident_id,
      free ? 1 : 0,
      now,
      lobbyExpires,
    );
    w.db.run('INSERT INTO interaction_participants(interaction_id, resident_id, joined_at, active) VALUES (?,?,?,1)', id, r.resident_id, now);
    const row = w.db.get('SELECT * FROM interactions WHERE interaction_id = ?', id)!;
    // 一个人就能做、而且不打算等人的，直接开始
    const solo = def.participants.min <= 1 && (def.participants.max === 1 || action.wait !== true);
    if (solo) begin(row, now);
    else {
      w.schedule('interaction_lobby_expire', `ixl:${id}`, lobbyExpires, { interactionId: id });
      broadcast(row, now);
    }
    return { status: 'accepted', interaction: interactionView(w, w.db.get('SELECT * FROM interactions WHERE interaction_id = ?', id)!) };
  });

  w.handlers.set('join_interaction', ({ r, action, now }) => {
    const row = w.db.get('SELECT * FROM interactions WHERE interaction_id = ?', String(action.interactionId ?? ''));
    if (!row || row.space_id !== w.spaceOf(r)) throw precondition('这件事不在你身边。', 'not_here');
    if (row.status !== 'open') throw precondition(row.status === 'running' ? '已经开始了，等下一次吧。' : '这件事已经结束了。', 'not_open');
    const def = parseJson<StoredDef>(row.def_json, {} as StoredDef);
    if (myInteraction(w, r.resident_id)) throw precondition('你手上还有一件事没做完。', 'already_busy');
    if (participantsOf(w, row.interaction_id).length >= def.participants.max) throw precondition('人已经满了。', 'full');
    w.db.run(
      `INSERT INTO interaction_participants(interaction_id, resident_id, joined_at, active) VALUES (?,?,?,1)
       ON CONFLICT(interaction_id, resident_id) DO UPDATE SET active = 1, joined_at = excluded.joined_at, left_at = NULL`,
      row.interaction_id,
      r.resident_id,
      now,
    );
    // 人满了自动开始；没满由发起人决定什么时候开始
    if (participantsOf(w, row.interaction_id).length >= def.participants.max) begin(row, now);
    else broadcast(row, now);
    return { status: 'accepted', interaction: interactionView(w, w.db.get('SELECT * FROM interactions WHERE interaction_id = ?', row.interaction_id)!) };
  });

  w.handlers.set('begin_interaction', ({ r, action, now }) => {
    const row = w.db.get("SELECT * FROM interactions WHERE interaction_id = ? AND status = 'open'", String(action.interactionId ?? ''));
    if (!row || row.initiator_id !== r.resident_id) throw precondition('只有发起人能决定开始，而且要还没开始。', 'not_initiator');
    const def = parseJson<StoredDef>(row.def_json, {} as StoredDef);
    const n = participantsOf(w, row.interaction_id).length;
    if (n < def.participants.min) throw precondition(`${def.name}至少要 ${def.participants.min} 个人，现在 ${n} 个。`, 'not_enough');
    begin(row, now);
    return { status: 'accepted', interaction: interactionView(w, w.db.get('SELECT * FROM interactions WHERE interaction_id = ?', row.interaction_id)!) };
  });

  w.handlers.set('leave_interaction', ({ r, now }) => {
    if (!leave(r.resident_id, now, '退出了')) throw precondition('你现在没有在做什么共同的事。', 'not_in_interaction');
    return { status: 'completed' };
  });

  w.jobHandlers.set('interaction_lobby_expire', (payload, _job, now) => {
    const row = w.db.get("SELECT * FROM interactions WHERE interaction_id = ? AND status = 'open'", String(payload.interactionId));
    if (row) cancel(row, '等了太久没凑齐人', Math.min(now, Number(row.lobby_expires_at)));
  });

  // ── 完成结算 ──
  w.jobHandlers.set('interaction_finish', (payload) => {
    const row = w.db.get("SELECT * FROM interactions WHERE interaction_id = ? AND status = 'running'", String(payload.interactionId));
    if (!row) return;
    const at = Number(row.ends_at);
    const def = parseJson<StoredDef>(row.def_json, {} as StoredDef);
    const people = participantsOf(w, row.interaction_id);
    w.db.run("UPDATE interactions SET status = 'completed', closed_at = ? WHERE interaction_id = ?", at, row.interaction_id);
    w.db.run('UPDATE interaction_participants SET active = 0, left_at = ? WHERE interaction_id = ? AND active = 1', at, row.interaction_id);
    if (people.length === 0) return;
    const date = w.today(at);
    const shared = people.length >= 2;
    const place = placeDef(row.space_id);
    const rainy = weatherAt(w, at).id === 'rain' && (isHome(row.space_id) || Boolean(place?.indoor));
    const gardenCare = def.id === 'tend_plants' && row.space_id === 'garden' ? openEventAt(w, 'garden_care', Number(row.started_at)) : undefined;
    const results: Record<string, { text: string }> = {};
    for (const p of people) {
      // 每天前几次全额，之后减半（每种活动各算各的）
      const times = bumpCounter(w, `ix:${p.resident_id}`, def.id, date);
      const tired = settledNeeds(w, p, at).energy < Math.abs(Math.min(0, def.effects.energy ?? 0));
      const factor = (times >= w.params.interactionFullEffectPerDay ? 0.5 : 1) * (tired ? 0.5 : 1);
      const onTag = p.state.interests.includes(def.tag) || (def.bookTag !== undefined && p.state.interests.includes(def.bookTag));
      const interestBase = def.effects.interest === undefined ? 0 : onTag ? def.effects.interest : (def.effects.interestOffTag ?? 0);
      const delta = {
        energy: def.effects.energy ?? 0,
        // 社交收益只在确实有别人一起时生效
        social: shared ? Math.round(((def.effects.social ?? 0) + (rainy ? (def.rainBonus?.social ?? 0) : 0)) * factor) : 0,
        interest: Math.round((interestBase + (rainy && interestBase > 0 ? (def.rainBonus?.interest ?? 0) : 0)) * factor),
      };
      applyNeeds(w, p, delta, at);
      // 同一种东西合并成一句（发起人的"每人一碗"和"多一碗"是同一种汤，只写一次）
      const gotQty = new Map<string, number>();
      const outputs: { type: string; qty: number; dailyCap?: number }[] = [...def.outputsEach, ...(p.resident_id === row.initiator_id ? def.outputsInitiator : [])];
      for (const o of outputs) {
        let qty = o.qty;
        const cap = o.dailyCap;
        if (cap !== undefined) {
          const had = counter(w, `out:${p.resident_id}`, o.type, date);
          qty = Math.max(0, Math.min(qty, cap - had));
          if (qty > 0) bumpCounter(w, `out:${p.resident_id}`, o.type, date, qty);
        }
        if (qty > 0) {
          addStack(w, p.resident_id, o.type, qty);
          gotQty.set(o.type, (gotQty.get(o.type) ?? 0) + qty);
        }
      }
      const got = [...gotQty].map(([type, n]) => `${n} 份${itemDef(type)?.name ?? type}`);
      const bits = [
        delta.social > 0 ? `社交 +${delta.social}` : '',
        delta.interest > 0 ? `兴趣 +${delta.interest}` : '',
        delta.energy !== 0 ? `精力 ${delta.energy > 0 ? '+' : ''}${delta.energy}` : '',
        ...got.map((g) => `得到 ${g}`),
        factor < 1 ? (tired ? '（有点累，效果打了折）' : '（今天做得多了，效果减半）') : '',
      ].filter(Boolean);
      results[p.resident_id] = { text: `${def.bookTitle ? `读完了${def.bookTitle}` : `${def.name}完成了`}：${bits.join('，') || '歇了一会儿'}` };
    }
    const fact = w.fact(
      'interaction_completed',
      people.map((p) => ({ id: p.resident_id, role: p.resident_id === row.initiator_id ? 'initiator' : 'participant' })),
      { interaction: def.id, name: def.name, participants: people.length, space: isHome(row.space_id) ? 'home' : row.space_id, tag: def.tag },
      { occurredAt: at, visibility: isHome(row.space_id) ? 'private' : 'public' },
    );
    for (const p of people) {
      if (def.mood) addMood(w, p.resident_id, shared && def.mood === 'relaxed' ? 'happy' : def.mood, shared ? `和人一起${def.name}` : def.name, fact.eventId, at);
      w.emitTo([p.resident_id], 'interaction_done', { interactionId: row.interaction_id, name: def.name, text: results[p.resident_id]!.text }, at);
    }
    const watchers = w.audienceIn(row.space_id).map((x) => x.resident_id).filter((id) => !people.some((p) => p.resident_id === id));
    w.emitTo(watchers, 'interaction', { interaction: interactionView(w, { ...row, status: 'completed' }) }, at);

    // 公共事件：活动开始时事件正开着才算贡献，先后来都计入同一个进度
    if (gardenCare) {
      let progress = Number(gardenCare.progress);
      for (const p of people) {
        w.db.run(
          `INSERT INTO event_participation(instance_id, resident_id, contributions, rewarded) VALUES (?,?,1,0)
           ON CONFLICT(instance_id, resident_id) DO UPDATE SET contributions = contributions + 1`,
          gardenCare.instance_id,
          p.resident_id,
        );
        progress += 1;
        // 参与奖励每人每次事件只发一次
        if (mint(w, p.resident_id, w.params.publicEventReward, `pe:${gardenCare.instance_id}:${p.resident_id}`, 'public_event')) {
          w.db.run('UPDATE event_participation SET rewarded = 1 WHERE instance_id = ? AND resident_id = ?', gardenCare.instance_id, p.resident_id);
          w.emitTo([p.resident_id], 'notice', { text: `你参加了今天的花园整理，得到 ${w.params.publicEventReward} 枚硬币。` }, at);
        }
        w.fact('public_event_contribution', [{ id: p.resident_id, role: 'self' }], { event: 'garden_care', instanceId: gardenCare.instance_id }, { occurredAt: at, visibility: 'public' });
      }
      const reached = gardenCare.reached_at === null && progress >= Number(gardenCare.target) && Number(gardenCare.target) > 0;
      w.db.run('UPDATE public_event_instances SET progress = ?, reached_at = COALESCE(reached_at, ?) WHERE instance_id = ?', progress, reached ? at : null, gardenCare.instance_id);
      const fresh = w.db.get('SELECT * FROM public_event_instances WHERE instance_id = ?', gardenCare.instance_id)!;
      w.emitPublic('public_event', { event: eventView(fresh), ...(reached ? { text: parseJson<PublicEventDef>(fresh.def_json, {} as PublicEventDef).doneText } : {}) }, at);
    }
  });

  // ── 公共事件的开始与结束 ──
  w.jobHandlers.set('public_event_open', (payload, _job, now) => {
    const row = w.db.get("SELECT * FROM public_event_instances WHERE instance_id = ? AND status = 'scheduled'", String(payload.instanceId));
    if (!row) return;
    if (now >= Number(row.closes_at)) {
      w.db.run("UPDATE public_event_instances SET status = 'missed' WHERE instance_id = ?", row.instance_id);
      return;
    }
    w.db.run("UPDATE public_event_instances SET status = 'open' WHERE instance_id = ?", row.instance_id);
    const view = eventView({ ...row, status: 'open' });
    w.emitPublic('public_event', { event: view, text: view.text }, Number(row.opens_at));
    w.db.run('INSERT OR IGNORE INTO notification_outbox(dedupe_key, destination, payload, created_at) VALUES (?,?,?,?)', `pe:${row.instance_id}`, 'announce', JSON.stringify({ kind: 'public_event', title: view.title, text: view.text, at: view.opensAt }), now);
  });

  w.jobHandlers.set('public_event_close', (payload) => {
    const row = w.db.get("SELECT * FROM public_event_instances WHERE instance_id = ? AND status IN ('scheduled','open')", String(payload.instanceId));
    if (!row) return;
    if (row.status === 'scheduled') {
      w.db.run("UPDATE public_event_instances SET status = 'missed' WHERE instance_id = ?", row.instance_id);
      return;
    }
    w.db.run("UPDATE public_event_instances SET status = 'closed' WHERE instance_id = ?", row.instance_id);
    const def = parseJson<PublicEventDef>(row.def_json, {} as PublicEventDef);
    const text = row.reached_at !== null && def.doneText ? def.doneText : def.quietText;
    w.emitPublic('public_event', { event: eventView({ ...row, status: 'closed' }), text }, Number(row.closes_at));
  });

  w.hooks.newDay.push((date, now) => ensureEventInstances(w, date, now));
  void badRequest;
  void homeOwner;
}

/** 某个时刻正开着的事件实例（按时间窗判断，结算晚了也算数）。 */
function openEventAt(w: WorldService, defId: string, at: number): Row | undefined {
  return w.db.get("SELECT * FROM public_event_instances WHERE def_id = ? AND opens_at <= ? AND closes_at > ? AND status IN ('open','closed')", defId, at, at);
}
