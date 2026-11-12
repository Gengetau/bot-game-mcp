/**
 * 日报、回顾、清理、备份和对外通知。
 *
 * 权限分开：公开日报只读「公开」的事实并且只写聚合后的句子；个人日报只读本人参与过的事实。
 * 屋里发生的事、信件、交换的细节不会出现在公开日报里，也不会出现在别人的个人日报里。
 * 日报按（范围，世界日）只生成一次。回顾只用「本来就发给本人的通知」和公开日报拼出来。
 */
import { INTERACTIONS, PLACES, PUBLIC_EVENTS } from './content.js';
import { type Row, parseJson } from './db.js';
import { WorldError } from './errors.js';
import type { PublicEventDef } from './content.js';
import { weatherAt } from './interact.js';
import { mailboxSummary } from './mail.js';
import type { WorldService } from './service.js';
import { localToUtc, nextDate } from './time.js';

export interface ReportView {
  scope: 'public' | 'personal';
  date: string;
  lines: string[];
  final: boolean;
}

function dayRange(w: WorldService, date: string): [number, number] {
  return [localToUtc(w.params.timezone, date, 0, 0), localToUtc(w.params.timezone, nextDate(date), 0, 0)];
}

/** 公开日报：只用公开事实，只写聚合结果。 */
function buildPublic(w: WorldService, date: string): string[] {
  const [from, to] = dayRange(w, date);
  const lines: string[] = [];
  const weather = weatherAt(w, from + 12 * 3600_000);
  lines.push(`这一天午间的天气：${weather.name}。`);
  const joinedTotal = Number(w.db.scalar('SELECT COUNT(*) FROM residents WHERE world_id = ? AND created_at >= ? AND created_at < ?', w.worldId, from, to) ?? 0);
  const joined = w.db.all('SELECT name FROM residents WHERE world_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, resident_id LIMIT 12', w.worldId, from, to).map((r) => String(r.name));
  // 人数用总数；名字最多列 12 个，多出来的写「等」
  if (joinedTotal > 0) lines.push(`新来了 ${joinedTotal} 位居民：${joined.join('、')}${joinedTotal > joined.length ? ' 等' : ''}。`);
  const facts = w.db.all("SELECT type, payload FROM world_events WHERE world_id = ? AND visibility = 'public' AND occurred_at >= ? AND occurred_at < ?", w.worldId, from, to);
  const byPlace = new Map<string, number>();
  let games = 0;
  for (const f of facts) {
    const d = parseJson<Record<string, any>>(f.payload, {});
    if (f.type === 'interaction_completed') byPlace.set(`${d.space}|${d.interaction}`, (byPlace.get(`${d.space}|${d.interaction}`) ?? 0) + 1);
    else if (f.type === 'game_completed') games++;
  }
  for (const [key, n] of [...byPlace].sort()) {
    const [space, ix] = key.split('|');
    const place = PLACES.find((p) => p.id === space)?.name;
    const name = INTERACTIONS.find((i) => i.id === ix)?.name;
    if (place && name) lines.push(`${place}里有 ${n} 次${name}。`);
  }
  if (games > 0) lines.push(`镇上打完了 ${games} 局小游戏。`);
  for (const ev of w.db.all('SELECT * FROM public_event_instances WHERE business_date = ? ORDER BY opens_at', date)) {
    const def = parseJson<PublicEventDef>(ev.def_json, PUBLIC_EVENTS[0]!);
    if (ev.status === 'missed') lines.push(`「${def.title}」这天没有举行。`);
    else if (ev.status === 'closed') lines.push(ev.reached_at !== null && def.doneText ? `「${def.title}」：${def.doneText}` : `「${def.title}」：${def.quietText}`);
  }
  if (lines.length === 1) lines.push('镇上安安静静地过了一天。');
  return lines;
}

function nameOf(w: WorldService, id: string): string {
  return w.resident(id)?.name ?? '一位居民';
}

/** 个人日报：只读本人是当事人的事实。 */
function buildPersonal(w: WorldService, residentId: string, date: string): string[] {
  const [from, to] = dayRange(w, date);
  const rows = w.db.all(
    `SELECT e.event_id, e.type, e.payload, p.role FROM event_parties p JOIN world_events e ON e.event_id = p.event_id
     WHERE p.resident_id = ? AND e.occurred_at >= ? AND e.occurred_at < ? ORDER BY e.event_id`,
    residentId,
    from,
    to,
  );
  // 一次取出这些事实的其他当事人，不再每条事实查一次（走 event_id 索引）；分块避开变量个数上限
  const othersByEvent = new Map<number, string[]>();
  const ids = rows.map((r) => Number(r.event_id));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const o of w.db.all(`SELECT event_id, resident_id FROM event_parties WHERE event_id IN (${chunk.map(() => '?').join(',')}) AND resident_id <> ? ORDER BY event_id, resident_id`, ...chunk, residentId)) {
      const k = Number(o.event_id);
      const list = othersByEvent.get(k);
      if (list) list.push(String(o.resident_id));
      else othersByEvent.set(k, [String(o.resident_id)]);
    }
  }
  const lines: string[] = [];
  const counts = new Map<string, number>();
  const push = (text: string) => counts.set(text, (counts.get(text) ?? 0) + 1);
  for (const row of rows) {
    const d = parseJson<Record<string, any>>(row.payload, {});
    const others = (othersByEvent.get(Number(row.event_id)) ?? []).map((id) => nameOf(w, id));
    const withWho = others.length ? `和${others.slice(0, 3).join('、')}${others.length > 3 ? '等人' : ''}` : '';
    switch (row.type) {
      case 'interaction_completed':
        push(`${withWho || '一个人'}${String(d.name ?? '做了件事')}`);
        break;
      case 'game_completed':
        push(`${withWho}打完了一局${String(d.name ?? '游戏')}${row.role === 'winner' ? '，赢了' : ''}`);
        break;
      case 'gift_accepted':
        push(row.role === 'giver' ? `送给${others[0] ?? '别人'}：${String(d.give ?? '')}` : `收到${others[0] ?? '别人'}送的：${String(d.give ?? '')}`);
        break;
      case 'trade_completed':
        push(`${withWho}交换了东西`);
        break;
      case 'loan_started':
        push(row.role === 'borrower' ? `借来了${String(d.item ?? '东西')}` : `把${String(d.item ?? '东西')}借给了${others[0] ?? '别人'}`);
        break;
      case 'loan_returned':
        push(row.role === 'borrower' ? `还掉了${String(d.item ?? '东西')}` : `${others[0] ?? '别人'}还回了${String(d.item ?? '东西')}`);
        break;
      case 'letter_sent':
        push(row.role === 'sender' ? `给${others[0] ?? '别人'}寄了信` : '');
        break;
      case 'home_visit':
        push(row.role === 'host' ? `${others[0] ?? '有人'}来家里做客` : `去${others[0] ?? '别人'}家做客`);
        break;
      case 'asked_hobby':
        push(row.role === 'asker' ? `问了${others[0] ?? '别人'}的爱好` : '');
        break;
      case 'public_event_contribution':
        push('参加了花园整理');
        break;
      default:
        break;
    }
  }
  for (const [text, n] of counts) if (text) lines.push(n > 1 ? `${text}（${n} 次）` : text);
  const goals = w.db.all("SELECT def_json FROM resident_goals WHERE resident_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?", residentId, from, to);
  for (const g of goals) lines.push(`完成了愿望「${parseJson<{ title?: string }>(g.def_json, {}).title ?? ''}」`);
  const coins = w.db.scalar(
    `SELECT COALESCE(SUM(le.delta), 0) FROM ledger_entries le JOIN ledger_transactions t ON t.transaction_id = le.transaction_id
     WHERE le.account_id = ? AND t.created_at >= ? AND t.created_at < ?`,
    `acct:${residentId}`,
    from,
    to,
  );
  if (coins !== 0) lines.push(`硬币 ${coins > 0 ? '+' : ''}${coins}`);
  return lines;
}

/** 事实保留天数：日报、衍生记录都按它对齐（个人日报的原始事实超过它就没有了）。 */
const FACT_RETENTION_DAYS = 35;

/** 已定稿日报的保留天数，不短于事实保留期。 */
const REPORT_RETENTION_DAYS = 90;

function isRealDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(2000, mo - 1, d));
  t.setUTCFullYear(y, mo - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * 读某一天的日报。已经过完的世界日只生成一次并存下来；今天的是「到目前为止」，不存。
 *
 * 只有世界在正常运行（追赶完成）时才落盘：恢复追赶期间已过日的事实可能还没全部结算，
 * 这时现算现返回（final 为 false），不能把残缺的日报固化。换日钩子在追赶中按时间顺序结算，
 * 显式传 persist = true。
 * 世界创建之前、或早于事实保留期的日期只现算不存，免得被遍历日期撑大数据库、或把空日报固化。
 */
export function report(w: WorldService, scope: 'public' | { residentId: string }, date: string, now: number, persist: boolean = w.status === 'running'): ReportView {
  if (!isRealDate(date)) throw new WorldError('bad_request', '日期不对。');
  const key = scope === 'public' ? 'public' : `r:${scope.residentId}`;
  const kind = scope === 'public' ? 'public' : 'personal';
  const today = w.today(now);
  const isPast = date < today;
  if (isPast) {
    const row = w.db.get('SELECT body_json FROM daily_reports WHERE scope = ? AND business_date = ?', key, date);
    if (row) return { scope: kind, date, lines: parseJson<string[]>(row.body_json, []), final: true };
  }
  const lines = scope === 'public' ? buildPublic(w, date) : buildPersonal(w, scope.residentId, date);
  const created = Number(w.db.get('SELECT created_at FROM worlds WHERE world_id = ?', w.worldId)?.created_at ?? now);
  const store = isPast && persist && date >= w.today(created) && date >= nextDate(today, -FACT_RETENTION_DAYS);
  if (store) {
    w.commit(() => {
      const water = w.db.scalar('SELECT COALESCE(MAX(event_id), 0) FROM world_events');
      w.db.run('INSERT OR IGNORE INTO daily_reports(scope, business_date, source_water, version, body_json, created_at) VALUES (?,?,?,1,?,?)', key, date, water, JSON.stringify(lines), now);
    });
  }
  return { scope: kind, date, lines, final: isPast && persist };
}

export interface Recap {
  since: number;
  lines: string[];
}

/** 回到小镇时的回顾：只包含本来就发给本人的通知、信箱提示和公开日报。 */
export function recap(w: WorldService, residentId: string, since: number, now: number): Recap {
  const lines: string[] = [];
  const mail = mailboxSummary(w, residentId);
  if (mail.unread > 0) lines.push(`信箱里有 ${mail.unread} 封没读的信。`);
  const notices = w.db
    .all("SELECT type, projection FROM recipient_events WHERE resident_id = ? AND occurred_at > ? AND type IN ('notice','invite','interaction_done','goal','game_ended') ORDER BY cursor DESC LIMIT 12", residentId, since)
    .reverse();
  for (const n of notices) {
    const d = parseJson<Record<string, any>>(n.projection, {});
    if (n.type === 'goal' && !d.completed) continue;
    const text = n.type === 'goal' ? `完成了愿望「${d.goal?.title ?? ''}」` : n.type === 'game_ended' ? `一局${d.name ?? '游戏'}结束了` : (d.text as string | undefined);
    if (text && !lines.includes(text)) lines.push(text);
  }
  const lastDay = w.today(since);
  const today = w.today(now);
  if (lastDay < today) {
    const yesterday = nextDate(today, -1);
    for (const line of report(w, 'public', yesterday, now).lines.slice(0, 5)) lines.push(`昨天：${line}`);
  }
  return { since, lines: lines.slice(0, 20) };
}

// ───────────────────────── 对外通知 ─────────────────────────

/** 待发的稀疏公告（公共事件开场、日报）。由可信的平台适配层取走再确认。 */
export function outboxPending(w: WorldService, limit = 10): { id: number; kind: string; payload: Record<string, unknown>; createdAt: number }[] {
  return w.db
    .all('SELECT notification_id, destination, payload, created_at FROM notification_outbox WHERE sent_at IS NULL ORDER BY notification_id LIMIT ?', Math.max(1, Math.min(50, limit)))
    .map((row) => ({ id: Number(row.notification_id), kind: String(row.destination), payload: parseJson<Record<string, unknown>>(row.payload, {}), createdAt: Number(row.created_at) }));
}

export function outboxAck(w: WorldService, ids: readonly number[]): number {
  return w.commit(() => {
    let n = 0;
    for (const id of ids) n += w.db.run('UPDATE notification_outbox SET sent_at = ?, attempts = attempts + 1 WHERE notification_id = ? AND sent_at IS NULL', w.now(), Number(id)).changes;
    return n;
  });
}

// ───────────────────────── 清理 ─────────────────────────

function prune(w: WorldService, now: number): void {
  let n = 0;
  const run = (sql: string, ...params: (string | number)[]) => {
    n += w.db.run(sql, ...params).changes;
  };
  const replayCut = now - w.params.eventReplayRetentionMs;
  // 事件裁剪后推进「最早还能续传的位置」，水位不重置：拿着被裁掉区间的游标来续传会被要求重同步
  for (const row of w.db.all('SELECT resident_id, MAX(cursor) AS c FROM recipient_events WHERE created_at < ? GROUP BY resident_id', replayCut)) {
    w.db.run('UPDATE stream_heads SET retained_from = MAX(retained_from, ?) WHERE stream_key = ?', Number(row.c) + 1, `r:${row.resident_id}`);
  }
  run('DELETE FROM recipient_events WHERE created_at < ?', replayCut);
  const pubMax = w.db.get('SELECT MAX(cursor) AS c FROM public_events WHERE world_id = ? AND created_at < ?', w.worldId, replayCut);
  if (pubMax?.c) w.db.run('UPDATE stream_heads SET retained_from = MAX(retained_from, ?) WHERE stream_key = ?', Number(pubMax.c) + 1, `pub:${w.worldId}`);
  run('DELETE FROM public_events WHERE created_at < ?', replayCut);
  const chatCut = now - w.params.chatBodyRetentionMs;
  run('DELETE FROM chat_audience WHERE message_id IN (SELECT message_id FROM chat_messages WHERE sent_at < ?)', chatCut);
  run('DELETE FROM chat_messages WHERE sent_at < ?', chatCut);
  run('DELETE FROM request_receipts WHERE expires_at < ?', now);
  run('DELETE FROM login_tickets WHERE expires_at < ?', now - 86400_000);
  run('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', now, now - 86400_000);
  run("DELETE FROM scheduled_jobs WHERE status IN ('done','cancelled') AND processed_at < ?", now - 7 * 86400_000);
  run('DELETE FROM interaction_counters WHERE business_date < ?', nextDate(w.today(now), -14));
  run('DELETE FROM mood_effects WHERE expires_at < ?', now);
  run('DELETE FROM letters WHERE sender_deleted_at IS NOT NULL AND recipient_deleted_at IS NOT NULL');
  run("DELETE FROM offers WHERE status <> 'open' AND closed_at < ?", now - 7 * 86400_000);
  run('DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at < ?', now - 7 * 86400_000);
  run('DELETE FROM notification_outbox WHERE sent_at IS NULL AND created_at < ?', now - 2 * 86400_000);
  run("DELETE FROM business_keys WHERE key LIKE 'newday:%' AND created_at < ?", now - 14 * 86400_000);
  // 结构化事实保留到个人日报肯定已经生成之后（回顾和日报之外不再需要原始事实）
  const factCut = now - FACT_RETENTION_DAYS * 86400_000;
  run('DELETE FROM event_parties WHERE event_id IN (SELECT event_id FROM world_events WHERE occurred_at < ?)', factCut);
  run('DELETE FROM world_events WHERE occurred_at < ?', factCut);
  // 已定稿的日报比原始事实多留一阵（事实裁掉后它是唯一的当日记录），超过日报保留期再裁
  run('DELETE FROM daily_reports WHERE business_date < ?', nextDate(w.today(now), -REPORT_RETENTION_DAYS));
  // 已经结束的衍生记录（只删终态；进行中的互动、未过期的邀请、未归还的借出、未读信都不动。
  // 账本、结算、活动结果是业务凭据，长期保留，不在这里）
  run("DELETE FROM interaction_participants WHERE interaction_id IN (SELECT interaction_id FROM interactions WHERE status IN ('completed','cancelled') AND closed_at < ?)", factCut);
  run("DELETE FROM interactions WHERE status IN ('completed','cancelled') AND closed_at < ?", factCut);
  run("DELETE FROM loans WHERE status = 'returned' AND returned_at < ?", factCut);
  run('DELETE FROM home_access_grants WHERE expires_at < ? AND (revoked_at IS NULL OR revoked_at < ?) AND grant_id NOT IN (SELECT invite_grant_id FROM letters WHERE invite_grant_id IS NOT NULL)', factCut, factCut);
  run("DELETE FROM scheduled_jobs WHERE status = 'failed' AND COALESCE(processed_at, due_at) < ?", factCut);
  // 结束很久的小游戏记录
  const gameCut = now - 7 * 86400_000;
  run("DELETE FROM game_records WHERE activity_id IN (SELECT activity_id FROM activities WHERE status IN ('completed','aborted') AND ended_at < ?)", gameCut);
  w.metrics.pruned += n;
}

// ───────────────────────── 安装 ─────────────────────────

export function installReports(w: WorldService): void {
  w.jobHandlers.set('daily_rollover', (_payload, _job, now) => {
    for (const h of w.hooks.newDay) h(w.today(now), now);
  });

  w.hooks.newDay.push((date, now) => {
    // 下一次换日：下个世界日零点过后留一小段时间，让跨零点的结算先落定
    const next = nextDate(date);
    w.schedule('daily_rollover', `rollover:${next}`, localToUtc(w.params.timezone, next, 0, 0) + w.params.dailyReportDelayMs, {});
    const key = `newday:reports:${date}`;
    if (w.db.get('SELECT 1 AS x FROM business_keys WHERE key = ?', key)) return;
    w.db.run('INSERT INTO business_keys(key, created_at) VALUES (?,?)', key, now);
    const created = Number(w.db.get('SELECT created_at FROM worlds WHERE world_id = ?', w.worldId)?.created_at ?? now);
    const yesterday = nextDate(date, -1);
    if (w.today(created) <= yesterday) {
      // 昨天的公开日报，以及昨天有过记录的居民各自的个人日报
      const pub = report(w, 'public', yesterday, now, true);
      const [from, to] = dayRange(w, yesterday);
      for (const row of w.db.all(
        'SELECT DISTINCT p.resident_id FROM event_parties p JOIN world_events e ON e.event_id = p.event_id WHERE e.occurred_at >= ? AND e.occurred_at < ?',
        from,
        to,
      )) {
        report(w, { residentId: String(row.resident_id) }, yesterday, now, true);
      }
      w.emitPublic('report', { date: yesterday, lines: pub.lines }, now);
      w.db.run('INSERT OR IGNORE INTO notification_outbox(dedupe_key, destination, payload, created_at) VALUES (?,?,?,?)', `report:${yesterday}`, 'announce', JSON.stringify({ kind: 'daily_report', title: `${w.worldName}日报 ${yesterday}`, text: pub.lines.join('\n'), at: now }), now);
    }
    prune(w, now);
  });

  // 每个世界日做一次一致备份（在事务之外）。备份失败只记日志，不影响小镇运行
  w.hooks.tick.push((now) => {
    if (w.db.inMemory || w.params.backupKeep <= 0) return;
    const today = w.today(now);
    if (w.db.getMeta('last_backup_date') === today) return;
    try {
      const out = w.backup();
      w.db.tx(() => w.db.setMeta('last_backup_date', today));
      if (out) w.log(`[town] 已备份到 ${out.path}（${Math.round(out.bytes / 1024)} KiB，${Math.round(out.ms)} ms，已验证可恢复）`);
    } catch (e) {
      w.db.tx(() => w.db.setMeta('last_backup_date', today));
      w.log(`[town] 备份失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

export type { Row };
