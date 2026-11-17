/**
 * 对账（引擎这一侧）。每天一次、每次访问关闭后一次。**只报告，不自动修**：发现不一致就写进报告，由人来看。
 *
 * 引擎能自己核对的不变量：
 *  1. 全部账户余额之和为零（复式记账）。
 *  2. 桥接系统账户余额 = Σ(已交回的访问：带回的钱 − 带出的钱) − Σ(已交接还没交回的访问：带出的钱)。
 *  3. 每次已交回的访问：出门入账、回家扣回两笔都在，金额对得上。
 *  4. 室友不在访问里的时候，随身钱包里只剩被结果未知的交易锁住的钱，而且等于她名下 pending 订单的合计。
 *  5. 带着内核来历（origin_ref）的物品只会在进行中的访问里处于 held 状态。
 *  6. 被锁住的钱 = pending 订单合计（所有居民）。
 * 另外列出要人处理的事（不算错误）：到家很久还没被内核确认的访问、留着寄存包裹或 pending 订单的访问。
 * 内核那一侧的核对（家里的钱和带出带回对不对得上）由内核做，两边按 visit_id 对。
 */
import { parseJson, type Row } from '../world/db.js';
import { localToUtc, nextDate } from '../world/time.js';
import { BRIDGE, accountBalance, ledgerImbalance, purseOf } from './ledger.js';
import type { CityService } from './service.js';

export interface ReconcileFinding {
  level: 'error' | 'info';
  code: string;
  detail: Record<string, unknown>;
}

export interface ReconcileReport {
  report_id: number;
  ran_at_ms: number;
  trigger: string;
  ok: boolean;
  findings: ReconcileFinding[];
}

/** 跑一次对账并写报告。在调用方的事务里（或自己开一个）。 */
export function runReconcile(c: CityService, trigger: string): ReconcileReport {
  return c.commit(() => {
    const now = c.now();
    const findings: ReconcileFinding[] = [];
    const err = (code: string, detail: Record<string, unknown>) => findings.push({ level: 'error', code, detail });
    const info = (code: string, detail: Record<string, unknown>) => findings.push({ level: 'info', code, detail });

    const imbalance = ledgerImbalance(c);
    if (imbalance !== 0) err('ledger_imbalance', { sum: imbalance });

    const visits = c.db.all<Row>("SELECT visit_id, actor_id, resident_id, state, carry_yen, purse_final_yen, settled_at, settlement_json FROM visits WHERE state NOT IN ('prepared','aborted')");
    let expectedBridge = 0;
    for (const v of visits) {
      const released = v.state === 'closed' || v.state === 'reconcile';
      expectedBridge += released ? Number(v.purse_final_yen ?? 0) - Number(v.carry_yen) : -Number(v.carry_yen);
      const sumOf = (cause: string): number | null => {
        const t = c.db.get<{ transaction_id: number }>('SELECT transaction_id FROM ledger_transactions WHERE cause_key = ?', cause);
        if (!t) return null;
        return c.db.scalar('SELECT COALESCE(SUM(delta), 0) FROM ledger_entries WHERE transaction_id = ? AND account_id = ?', t.transaction_id, BRIDGE);
      };
      const inn = sumOf(`visit:${v.visit_id}:in`);
      // 带出 0 日元的访问没有入账分录，只有交易头
      if (inn === null || inn !== -Number(v.carry_yen)) err('visit_in_mismatch', { visit_id: v.visit_id, expected: -Number(v.carry_yen), found: inn });
      if (released) {
        const out = sumOf(`visit:${v.visit_id}:out`);
        if (out === null || out !== Number(v.purse_final_yen ?? 0)) err('visit_out_mismatch', { visit_id: v.visit_id, expected: Number(v.purse_final_yen ?? 0), found: out });
      }
      if (v.state === 'settled' && now - Number(v.settled_at ?? now) > 60 * 60_000) info('awaiting_release', { visit_id: v.visit_id, settled_at_ms: Number(v.settled_at) });
      if (v.state === 'reconcile') {
        const s = parseJson<{ pending?: unknown[]; items?: { fate: string }[] }>(v.settlement_json as string, {});
        info('visit_needs_attention', { visit_id: v.visit_id, pending_orders: s.pending?.length ?? 0, locker_items: (s.items ?? []).filter((i) => i.fate === 'locker').length });
      }
    }
    const bridge = accountBalance(c, BRIDGE);
    if (bridge !== expectedBridge) err('bridge_balance_mismatch', { expected: expectedBridge, found: bridge });

    for (const m of c.db.all<{ actor_id: string; resident_id: string }>('SELECT actor_id, resident_id FROM house_members')) {
      const acct = c.db.get<{ balance: number; held: number }>('SELECT balance, held FROM accounts WHERE account_id = ?', purseOf(m.resident_id));
      const open = c.db.get<{ state: string; purse_final_yen: number | null }>("SELECT state, purse_final_yen FROM visits WHERE resident_id = ? AND state IN ('active','returning','settled')", m.resident_id);
      const balance = acct?.balance ?? 0;
      const held = acct?.held ?? 0;
      if (!open && balance !== held) err('purse_not_empty_at_home', { actor_id: m.actor_id, balance, held });
      if (open?.state === 'settled' && balance !== Number(open.purse_final_yen ?? 0) + held) err('purse_mismatch_at_door', { actor_id: m.actor_id, balance, held, purse_final_yen: open.purse_final_yen });
    }

    for (const row of c.db.all<Row>("SELECT a.resident_id AS resident_id, a.held AS held, COALESCE((SELECT SUM(yen) FROM orders o WHERE o.resident_id = a.resident_id AND o.status = 'pending'), 0) AS pending FROM accounts a WHERE a.kind = 'resident'")) {
      if (Number(row.held) !== Number(row.pending)) err('held_mismatch', { resident_id: row.resident_id, held: Number(row.held), pending_orders_yen: Number(row.pending) });
    }

    const stray = c.db.all<Row>(
      `SELECT i.item_id, i.visit_id FROM items i LEFT JOIN visits v ON v.visit_id = i.visit_id
       WHERE i.origin_ref IS NOT NULL AND i.state = 'held' AND i.quantity > 0 AND (v.state IS NULL OR v.state NOT IN ('active','returning','settled'))`,
    );
    for (const s of stray) err('carried_item_outside_visit', { item_id: s.item_id, visit_id: s.visit_id });

    const failedJobs = c.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'failed'");
    if (failedJobs > 0) err('failed_jobs', { count: failedJobs });
    const stuckJobs = c.db.scalar("SELECT COUNT(*) FROM scheduled_jobs WHERE status = 'pending' AND attempts >= 5");
    if (stuckJobs > 0) err('stuck_jobs', { count: stuckJobs });

    const ok = !findings.some((f) => f.level === 'error');
    const { lastInsertRowid } = c.db.run('INSERT INTO reconcile_reports(ran_at, trigger, ok, findings_json) VALUES (?,?,?,?)', now, trigger, ok ? 1 : 0, JSON.stringify(findings));
    if (!ok) c.log(`[city] 对账发现不一致（${trigger}）：${findings.filter((f) => f.level === 'error').map((f) => f.code).join('、')}`);
    return { report_id: Number(lastInsertRowid), ran_at_ms: now, trigger, ok, findings };
  });
}

export function latestReconcile(c: CityService, limit = 5): ReconcileReport[] {
  return c.db
    .all<Row>('SELECT * FROM reconcile_reports ORDER BY report_id DESC LIMIT ?', limit)
    .map((r) => ({ report_id: Number(r.report_id), ran_at_ms: Number(r.ran_at), trigger: String(r.trigger), ok: Number(r.ok) === 1, findings: parseJson<ReconcileFinding[]>(r.findings_json as string, []) }));
}

function scheduleDaily(c: CityService, now: number): void {
  const today = c.today(now);
  let due = localToUtc(c.params.timezone, today, c.params.reconcileHour, 0);
  let date = today;
  if (due <= now) {
    date = nextDate(today);
    due = localToUtc(c.params.timezone, date, c.params.reconcileHour, 0);
  }
  c.schedule('reconcile_daily', `reconcile:${date}`, due);
}

export function installReconcile(c: CityService): void {
  c.jobHandlers.set('reconcile_daily', (_payload, _job, now) => {
    runReconcile(c, 'daily');
    scheduleDaily(c, now);
  });
  c.hooks.recover.push((now) => scheduleDaily(c, now));

  // 每个世界日做一次一致备份（在事务之外）。备份失败只记日志，不影响城市运行
  c.hooks.tick.push((now) => {
    if (c.db.inMemory || c.params.backupKeep <= 0) return;
    const today = c.today(now);
    if (c.db.getMeta('last_backup_date') === today) return;
    try {
      const out = c.backup();
      if (out) c.log(`[city] 已备份到 ${out.path}（${Math.round(out.bytes / 1024)} KiB，${Math.round(out.ms)} ms，已验证可恢复）`);
    } catch (e) {
      c.log(`[city] 备份失败：${e instanceof Error ? e.message : String(e)}`);
    }
    c.db.tx(() => c.db.setMeta('last_backup_date', today));
  });
}
