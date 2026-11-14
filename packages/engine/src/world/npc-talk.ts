/**
 * NPC 的台词与服务（N1b）：`ask_npc` 动作、NPC 在附近聊天里开口、视图里的 `here.npcs`。
 *
 * - 回答完全由程序生成：模板在 content.ts 的 NPC_LINES，选哪一句用可复现的随机（带种子时从「种子 + 世界 + NPC + 用途 + 说过几次」派生，
 *   不消耗共享的 w.rng；生产环境就是 w.rng）。模板里唯一的玩家文字是提问人的名字（先 sanitizeName）。
 * - NPC 开口 = 以 NPC 的身份发一条附近聊天：受众在这个事务里按 NPC 此刻的位置一次定下（hearing.ts 的 npcAudience），
 *   写 chat_messages（sender_id 是 NPC 编号）、chat_audience（只有居民），并给每位**真人**听众一条私有 chat 事件（from.kind = 'npc'，界面靠它显示）。
 *   AI 听众不发事件：私有事件会叫醒挂着的 world_wait，而 NPC 的话不叫醒任何 AI（否则几个 AI 围着 NPC 问话就绕过了附近聊天的叫醒额度）。
 *   这句话照样在 AI 的受众表里，出现在 here.chat 和历史里；提问的 AI 从回执的 text 拿到回答。
 *   NPC 永远不是听众，不走公屏、不发 town_chat_mention、不碰任何唤醒额度、不取消也不安排补叫，也不记 w.fact。
 * - 每名 NPC 有开口的最小间隔（npcSpeakCooldownMs）：间隔内提问人照样拿到 text，但不再广播。
 * - 闲逛者停留时被搭话：把这次停留至少延到 现在 + npcTalkHoldMs，一次停留总共最多延长 npcTalkHoldMaxMs。
 * - 位置只读（positionOfNpc / interactivePos），不写 world_actors。
 */
import { SeededRng, type Rng } from '../core/rng.js';
import { sanitizeName } from '../core/text.js';
import { DESTINATIONS, NPC_LINES, NPCS, SHOPS, dayPeriod, npcDef, placeDef, renderNpcLine, type NpcDef, type NpcRole, type NpcTopic } from './content.js';
import { precondition } from './errors.js';
import { npcAudience } from './hearing.js';
import { publicEventsToday } from './interact.js';
import { takeToken } from './life.js';
import { zoneOf } from './project.js';
import { shopsAt } from './property.js';
import { npcReach } from './reach.js';
import type { WorldService } from './service.js';
import { actorOf, anchorSpot, npcActorOf, npcStateOf, posOf, positionOfNpc } from './space.js';
import { distance, zoneAt } from './spatial/grid.js';
import { localParts } from './time.js';
import type { ResidentRow } from './types.js';

type Shop = ReturnType<typeof shopsAt>[number];

/** 这名 NPC 此刻所在区域的标签（和居民的 location_id 同一口径）；没有这名 NPC 返回 null。 */
function zoneIdOf(w: WorldService, npcId: string, now: number): string | null {
  const p = positionOfNpc(w, npcId, now);
  const scene = p ? w.map.scenes.get(p.scene) : undefined;
  return p && scene ? zoneAt(scene, p.x, p.z).id : null;
}

/** NPC 照看的店此刻的货架（价格、今天的存量，和商店视图同一份结构）。 */
export function shopOfNpc(w: WorldService, def: NpcDef, now: number): Shop | undefined {
  const shop = SHOPS.find((s) => s.id === def.shop);
  return shop ? shopsAt(w, shop.place, now).find((s) => s.id === shop.id) : undefined;
}

// ───────────────────────── 台词 ─────────────────────────

/** 每回答一次加一：既是「每次不同的量」（派生随机），也让同一个种子下的两次回答不会选到同一个随机流。 */
function nextCount(w: WorldService, def: NpcDef): number {
  const key = `npcsay:${w.worldId}:${def.id}`;
  const n = w.streamHead(key).highWater + 1;
  w.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1) ON CONFLICT(stream_key) DO UPDATE SET high_water = excluded.high_water', key, n);
  return n;
}

function lineRng(w: WorldService, def: NpcDef, purpose: string, count: number): Rng {
  return w.seed === null ? w.rng : new SeededRng(`${w.seed}:${w.worldId}:npc:${def.id}:${purpose}:${count}`);
}

function pickLine(w: WorldService, def: NpcDef, key: string, purpose: string, count: number): string {
  const lines = NPC_LINES[`${def.id}/${key}`];
  if (!lines || lines.length === 0) throw new Error(`没有台词模板：${def.id}/${key}`);
  return lines[lineRng(w, def, purpose, count).int(lines.length)]!;
}

/** 话题 + 此刻的情境 -> 模板键（情境全部来自程序状态：姿态、在不在走、柜台有没有货、有没有公开活动）。 */
function variantKey(w: WorldService, def: NpcDef, topic: string, now: number): string {
  if (def.id === 'npc:plaza_stroller' && topic === 'hello') {
    const moving = positionOfNpc(w, def.id, now)?.moving === true;
    const pose = npcStateOf(w, def.id)?.pose ?? 'stand';
    return `hello.${moving ? 'walk' : pose === 'sit' || pose === 'read' ? pose : 'stand'}`;
  }
  if (def.id === 'npc:teahouse_keeper' && topic === 'hello') {
    const stock = shopOfNpc(w, def, now)?.goods[0]?.stock ?? 0;
    return stock > 0 ? 'hello' : 'hello.empty';
  }
  if (def.id === 'npc:teahouse_keeper' && topic === 'town') return publicEventsToday(w, now).some((e) => e.status === 'open') ? 'town.event' : 'town.none';
  return topic;
}

function varsFor(w: WorldService, def: NpcDef, r: ResidentRow, now: number): Record<string, string | number> {
  const good = shopOfNpc(w, def, now)?.goods[0];
  const zone = zoneIdOf(w, def.id, now);
  return {
    name: sanitizeName(r.name),
    period: dayPeriod(localParts(w.params.timezone, now).hour),
    place: (zone && placeDef(zone)?.name) || '这一带',
    price: good?.price ?? 0,
    stock: good?.stock ?? 0,
    places: DESTINATIONS.filter((p) => p.kind === 'public').map((p) => p.name).join('、'),
    events: publicEventsToday(w, now).filter((e) => e.status === 'open').map((e) => e.title).join('、'),
  };
}

/** 一名 NPC 对一个话题的固定回答。未知话题按默认话题（第一个）。 */
export function npcAnswer(w: WorldService, def: NpcDef, topic: string | undefined, r: ResidentRow, now: number, count: number): { topic: string; text: string } {
  const t = def.topics.find((x) => x.id === topic)?.id ?? def.topics[0]!.id;
  return { topic: t, text: renderNpcLine(pickLine(w, def, variantKey(w, def, t, now), `say:${t}`, count), varsFor(w, def, r, now)) };
}

// ───────────────────────── 开口 ─────────────────────────

export const npcCard = (def: Pick<NpcDef, 'id' | 'name'>): { id: string; name: string; kind: 'npc' } => ({ id: def.id, name: def.name, kind: 'npc' });

/**
 * NPC 在附近聊天里说一句。间隔内不说（返回 spoken:false）。受众在这一刻按 NPC 的位置固定。
 * 返回每个听众自己的发言序号（提问人在听众里时回执用它的 messageId）。
 */
export function npcSpeak(w: WorldService, def: NpcDef, text: string, now: number): { spoken: boolean; seqOf: Map<string, number> } {
  const seqOf = new Map<string, number>();
  // 上次开口的时间记在一行小表（stream_heads）里，不去扫 chat_messages（它没有 sender_id 索引，随聊天增长会越来越慢）。
  // 间隔按 NPC 全局计：一名 NPC 每个间隔至多开口一次，不论是谁问的；被压住的人照样拿到回执里的 text
  const lastKey = `npclast:${w.worldId}:${def.id}`;
  const lastRow = w.db.get('SELECT high_water FROM stream_heads WHERE stream_key = ?', lastKey);
  if (lastRow && now - Number(lastRow.high_water) < w.params.npcSpeakCooldownMs) return { spoken: false, seqOf };
  const pos = positionOfNpc(w, def.id, now);
  const zone = zoneIdOf(w, def.id, now);
  if (!pos || !zone) return { spoken: false, seqOf };
  const audience = npcAudience(w, pos, now);
  w.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1) ON CONFLICT(stream_key) DO UPDATE SET high_water = excluded.high_water', lastKey, now);
  const { lastInsertRowid: messageId } = w.db.run('INSERT INTO chat_messages(world_id, space_id, sender_id, body, sent_at) VALUES (?,?,?,?,?)', w.worldId, zone, def.id, text, now);
  for (const a of audience) {
    w.db.run('INSERT INTO chat_audience(resident_id, message_id) VALUES (?,?)', a.resident_id, messageId);
    const key = `chat:${a.resident_id}`;
    const seq = Number(w.db.scalar('SELECT high_water FROM stream_heads WHERE stream_key = ?', key) ?? 0) + 1;
    w.db.run('INSERT INTO stream_heads(stream_key, high_water, retained_from) VALUES (?,?,1) ON CONFLICT(stream_key) DO UPDATE SET high_water = excluded.high_water', key, seq);
    seqOf.set(a.resident_id, seq);
    // 只给真人发事件；AI 听众靠 here.chat（和提问人的回执）看到这句话，不被叫醒
    if (a.kind === 'human') w.emitTo([a.resident_id], 'chat', { scope: 'nearby', space: zone, from: npcCard(def), text, messageId: seq }, now);
  }
  return { spoken: true, seqOf };
}

/** 掌柜成交后的一句台词（受最小间隔限制，不影响成交）。 */
export function keeperSoldLine(w: WorldService, def: NpcDef, now: number): { spoken: boolean } {
  const count = nextCount(w, def);
  // 成交台词不带买家的名字和货品（谁买了什么是私有的），模板里没有占位符
  const text = renderNpcLine(pickLine(w, def, 'sold', 'sold', count), {});
  return { spoken: npcSpeak(w, def, text, now).spoken };
}

// ───────────────────────── 被搭话时别转身就走 ─────────────────────────

/**
 * 闲逛者停留期间被搭话：这次停留至少延到 现在 + npcTalkHoldMs，一次停留总共最多延长 npcTalkHoldMaxMs。
 * 只改这一条 npc_step 任务的到期时间和 payload 里的「已延长多少」；任务仍然只有一条，导航编号和版本不动。
 * 正在走（有路线）时什么也不做。
 */
export function holdNpcOnTalk(w: WorldService, def: NpcDef, now: number): void {
  if (!def.schedule) return;
  const a = npcActorOf(w, def.id);
  if (!a || a.nav) return;
  const job = w.db.get("SELECT due_at, payload FROM scheduled_jobs WHERE dedupe_key = ? AND status = 'pending'", `npc_step:${def.id}`);
  if (!job) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(String(job.payload)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (payload.phase !== 'stay') return;
  const due = Number(job.due_at);
  const extended = Math.max(0, Number(payload.extendedMs ?? 0));
  const base = due - extended;
  const next = Math.min(base + w.params.npcTalkHoldMaxMs, Math.max(due, now + w.params.npcTalkHoldMs));
  if (next <= due) return;
  w.reschedule('npc_step', `npc_step:${def.id}`, next, { ...payload, extendedMs: next - base });
}

// ───────────────────────── 掌柜在岗 ─────────────────────────

/** 掌柜在不在岗：NPC 行在，且离它的岗位锚点不远（P1 全天在岗，留出判断）。 */
export function onDuty(w: WorldService, def: NpcDef, now: number): boolean {
  const p = positionOfNpc(w, def.id, now);
  return !!p && distance(p, anchorSpot(w, def.post.anchor)) <= 1.5;
}

// ───────────────────────── 视图 ─────────────────────────

export interface HereNpc {
  id: string;
  name: string;
  role: NpcRole;
  /** 此刻所在的区域标签（公开口径，只到区域）。没有坐标 */
  place: string;
  /** 此刻我够得着它（现算位置）：能 ask_npc、能在掌柜这里买东西 */
  near: boolean;
  topics: NpcTopic[];
  shop?: string;
}

/**
 * 和我在同一个公共场景里的 NPC。我在私宅实例里为空。
 * 不带坐标、折线、到达时间（坐标只在场景快照里）。
 */
export function hereNpcs(w: WorldService, r: ResidentRow, now: number): HereNpc[] {
  const actor = actorOf(w, r.resident_id);
  const me = actor ? posOf(actor, now) : null;
  if (me && me.instance !== '') return [];
  if (!me && r.location_id.startsWith('home:')) return [];
  const out: HereNpc[] = [];
  for (const def of NPCS) {
    const a = npcActorOf(w, def.id);
    if (!a || a.instance_id !== '' || (me && a.scene_id !== me.scene)) continue;
    const zone = zoneIdOf(w, def.id, now);
    if (!zone) continue;
    out.push({
      id: def.id,
      name: def.name,
      role: def.role,
      place: zoneOf(zone),
      near: npcReach(w, r, def.id, now).ok,
      topics: def.topics.map((t) => ({ ...t })),
      ...(def.shop ? { shop: def.shop } : {}),
    });
  }
  return out;
}

// ───────────────────────── 动作 ─────────────────────────

export function installNpcTalk(w: WorldService): void {
  w.handlers.set('ask_npc', ({ r, action, now }) => {
    const def = typeof action.npcId === 'string' ? npcDef(action.npcId) : undefined;
    if (!def) throw precondition('镇上没有这个人。', 'not_found');
    const reach = npcReach(w, r, def.id, now);
    if (!reach.ok) {
      if (reach.why === 'too_far') throw precondition(`离${def.name}太远了，先走到它身边。`, 'too_far', { navigateTo: def.id });
      throw precondition(`${def.name}不在你身边。`, reach.why);
    }
    takeToken(w, r.resident_id, 'npc', w.params.npcAskBurst, w.params.npcAskPerMinute, now, '搭话');
    const topic = typeof action.topic === 'string' ? action.topic : undefined;
    const answer = npcAnswer(w, def, topic, r, now, nextCount(w, def));
    const said = npcSpeak(w, def, answer.text, now);
    holdNpcOnTalk(w, def, now);
    const shop = shopOfNpc(w, def, now);
    return {
      status: 'completed',
      npc: { id: def.id, name: def.name },
      topic: answer.topic,
      text: answer.text,
      topics: def.topics.map((t) => ({ ...t })),
      ...(shop ? { shop } : {}),
      spoken: said.spoken,
      messageId: said.seqOf.get(r.resident_id) ?? null,
    };
  });
}
