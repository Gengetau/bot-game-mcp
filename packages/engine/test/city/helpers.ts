/**
 * 东京城市世界的测试辅助：内存数据库 + 假时钟 + 固定种子 + 一个「假内核客户端」。
 *
 *   const t = makeCity();
 *   const k = t.kernel('nia');                 // 假内核：管她家里的钱、动作权代次、outbox 游标
 *   k.depart({ yen: 20000, items: [COOKIE], to: 'ikebukuro:kissa-tomoshibi' });   // prepare + commit
 *   t.run(40 * MIN);                           // 推进时间，到期的行程作业照常结算
 *   k.act({ type: 'buy', sku: 'coffee' });
 *   const b = t.bot('小B');                    // 外部 bot
 */
import { SeededRng } from '../../src/core/rng.js';
import {
  CityError,
  HOUSE_ENTRANCE,
  MAPPINGS,
  cityCommand,
  cityPrincipal,
  commitVisit,
  createCity,
  describeVisit,
  enterCity,
  prepareVisit,
  readOutbox,
  releaseVisit,
  requestReturn,
  selfView,
  visitAct,
  abortVisit,
  type BridgeReceipt,
  type CityOptions,
  type CityService,
  type HouseMemberConfig,
  type Settlement,
} from '../../src/city/index.js';
import { FakeClock } from '../helpers.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** 2026-11-17 10:00 JST（周二上午，店都开着） */
export const T0 = Date.UTC(2026, 10, 17, 1, 0, 0);

export const HOUSE: HouseMemberConfig[] = [
  { actorId: 'nia', name: '妮娅', bio: '喜欢甜食', qqIds: ['3001'] },
  { actorId: 'claire', name: '克蕾雅', qqIds: ['3002'] },
];

export const COOKIE = { ref: 'res:cookie:1', kernel: { kind: 'food', item: 'cookie' }, qty: 1 };
export const KISSA = 'ikebukuro:kissa-tomoshibi';

export interface CityTestOpts {
  at?: number;
  clock?: FakeClock;
  dbPath?: string;
  seed?: string;
  params?: Record<string, unknown>;
  house?: HouseMemberConfig[];
  fetchWeather?: CityOptions['fetchWeather'];
  start?: boolean;
}

export class CityTest {
  private botSeq = 0;
  constructor(
    readonly c: CityService,
    readonly clock: FakeClock,
  ) {}

  /** 测试里一直「在线」的外部 bot（相当于它们一直在 world_wait）：推进时间时替它们续在场 */
  readonly online = new Map<string, { principalId: string }>();

  private keepOnline(): void {
    for (const [residentId, b] of this.online) {
      const r = this.c.mustResident(residentId);
      if (!r.in_city) continue;
      const p = this.c.db.get<any>('SELECT principal_id, provider, subject, kind, display_name FROM principals WHERE principal_id = ?', b.principalId);
      enterCity(this.c, p);
    }
  }

  /** 推进时间：按到期时刻一条一条结算作业（和线上每秒 tick 等价，只是不用真的等）。 */
  run(ms: number): void {
    const target = this.clock.t + ms;
    for (;;) {
      this.keepOnline();
      const next = this.c.db.get<{ due_at: number }>("SELECT MIN(due_at) AS due_at FROM scheduled_jobs WHERE status = 'pending'")?.due_at;
      const step = Math.min(target, this.clock.t + 5 * MIN, next ?? target);
      if (step > this.clock.t) this.clock.t = step;
      this.keepOnline();
      this.c.runDue();
      if (this.clock.t >= target) break;
    }
  }

  kernel(actorId: string): FakeKernel {
    return new FakeKernel(this, actorId);
  }

  /** 一个外部 bot（密钥身份），已经进城。 */
  bot(name: string, opts: { id?: string; entry?: string; stay?: boolean } = {}): Bot {
    const id = opts.id ?? `90${++this.botSeq}`;
    const principal = cityPrincipal(this.c, { id, name }, {});
    const out = enterCity(this.c, principal, { name, ...(opts.entry ? { entry: opts.entry } : {}) });
    if (opts.stay !== false) this.online.set(out.resident.resident_id, { principalId: principal.principal_id });
    return new Bot(this, out.resident.resident_id, principal.principal_id, name);
  }

  residentOf(actorId: string): string {
    return this.c.db.get<{ resident_id: string }>('SELECT resident_id FROM house_members WHERE actor_id = ?', actorId)!.resident_id;
  }

  balance(account: string): number {
    return this.c.db.get<{ balance: number }>('SELECT balance FROM accounts WHERE account_id = ?', account)?.balance ?? 0;
  }

  /** outbox 里某次访问的全部记录。 */
  outbox(visitId?: string): { seq: number; kind: string; record_id: string; occurred_at_ms: number; payload: any }[] {
    const all = readOutbox(this.c, 0, 200).records as any[];
    return visitId ? all.filter((r) => r.visit_id === visitId) : all;
  }
}

export function makeCity(opts: CityTestOpts = {}): CityTest {
  const clock = opts.clock ?? new FakeClock();
  if (!opts.clock) clock.t = opts.at ?? T0;
  const c = createCity({
    dbPath: opts.dbPath ?? ':memory:',
    now: clock.now,
    rng: new SeededRng(opts.seed ?? 'city'),
    house: opts.house ?? HOUSE,
    fetchWeather: opts.fetchWeather ?? null,
    ...(opts.params ? { params: opts.params } : {}),
  });
  if (opts.start !== false) c.startSync();
  return new CityTest(c, clock);
}

/** 断言一个调用以某个失败码被拒绝，并返回那个错误。 */
export function rejects(fn: () => unknown, code: string, reason?: string): CityError {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof CityError)) throw e;
    if (e.code !== code || (reason !== undefined && e.reason !== reason)) throw new Error(`期望 ${code}${reason ? `/${reason}` : ''}，得到 ${e.code}${e.reason ? `/${e.reason}` : ''}：${e.message}`);
    return e;
  }
  throw new Error(`期望被拒绝（${code}），但成功了`);
}

export class Bot {
  private seq = 0;
  constructor(
    readonly t: CityTest,
    readonly id: string,
    readonly principalId: string,
    readonly name: string,
  ) {}
  act(action: Record<string, unknown>, requestId?: string): any {
    return cityCommand(this.t.c, this.id, requestId ?? `req-${this.id}-${++this.seq}`, action);
  }
  view(opts?: { clientId?: string; itemOffset?: number; lockerOffset?: number; maxBytes?: number }): any {
    return selfView(this.t.c, this.t.c.mustResident(this.id), opts);
  }
  /** 走到某个地点并等到到达。 */
  go(to: string): void {
    const r = this.act({ type: 'travel', to });
    this.t.run(r.trip.ends_at_ms - this.t.clock.t);
  }
  events(): { type: string; data: any }[] {
    return this.t.c.db.all('SELECT type, projection FROM resident_events WHERE resident_id = ? ORDER BY cursor', this.id).map((e) => ({ type: String(e.type), data: JSON.parse(String(e.projection)) }));
  }
}

/**
 * 假内核客户端：只做内核那一侧最少的事（家里的钱、冻结、动作权代次、outbox 游标、按记录号去重），
 * 用来验证引擎这一侧的协议行为。它直接调桥接操作的函数（和 HTTP 路由调的是同一批）。
 */
export class FakeKernel {
  homeYen = 38_900;
  frozenYen = 0;
  /** 动作权代次：每次交接加一 */
  epoch = 0;
  cursor = 0;
  /** 已经应用过的 outbox 记录（按 record_id 去重） */
  readonly applied = new Map<string, { kind: string; payload: any; occurred_at_ms: number }>();
  /** 身体效果各应用了几次（验证「只扣一次」） */
  readonly bodyApplied = new Map<string, number>();
  settlement: Settlement | null = null;
  visitId = '';
  private seq = 0;
  private visitSeq = 0;

  constructor(
    readonly t: CityTest,
    readonly actorId: string,
  ) {}

  get c(): CityService {
    return this.t.c;
  }

  rid(tag: string): string {
    return `${this.visitId}:d${this.epoch}:${tag}${++this.seq}`;
  }

  prepareBody(o: { yen: number; items?: (typeof COOKIE)[]; to: string; returnIn?: number; visitId?: string }): Record<string, unknown> {
    this.visitId = o.visitId ?? `v-${this.actorId}-${++this.visitSeq}`;
    return {
      request_id: `${this.visitId}:prepare`,
      protocol: 'city-bridge/1',
      vocab_version: 'vocab-test',
      mappings_version: MAPPINGS.version,
      visit_id: this.visitId,
      actor_id: this.actorId,
      carry: { yen: o.yen, items: o.items ?? [] },
      plan: { destination: o.to, start_at_ms: this.t.clock.t, return_by_ms: this.t.clock.t + (o.returnIn ?? 4 * HOUR) },
      source_hold_ref: `hold:${this.visitId}`,
    };
  }

  /** T1（冻结）→ prepare → commit。返回 commit 的回执。 */
  depart(o: { yen: number; items?: (typeof COOKIE)[]; to: string; returnIn?: number; visitId?: string }): BridgeReceipt {
    this.frozenYen += o.yen;
    prepareVisit(this.c, this.prepareBody(o));
    return this.commit();
  }

  commitBody(): Record<string, unknown> {
    return { request_id: `${this.visitId}:commit`, transfer_id: `tr-${this.visitId}`, domain_epoch: this.epoch + 1 };
  }

  commit(): BridgeReceipt {
    const body = this.commitBody();
    const receipt = commitVisit(this.c, this.visitId, body);
    this.epoch = body.domain_epoch as number;
    return receipt;
  }

  act(action: Record<string, unknown>, requestId?: string): BridgeReceipt {
    return visitAct(this.c, this.visitId, { request_id: requestId ?? this.rid('a'), domain_epoch: this.epoch, action });
  }

  view(opts?: { clientId?: string; itemOffset?: number; lockerOffset?: number; maxBytes?: number }): any {
    return selfView(this.c, this.c.mustResident(this.t.residentOf(this.actorId)), opts);
  }

  describe(): any {
    return describeVisit(this.c, this.visitId);
  }

  returnRequest(reason = 'test'): BridgeReceipt {
    return requestReturn(this.c, this.visitId, { request_id: this.rid('ret'), reason });
  }

  abort(): BridgeReceipt {
    return abortVisit(this.c, this.visitId, { request_id: `${this.visitId}:abort`, reason: 'test' });
  }

  /** 从游标拉 outbox，每条记录只应用一次。返回这次新应用的记录。 */
  pull(): { kind: string; payload: any; record_id: string; occurred_at_ms: number }[] {
    const fresh: { kind: string; payload: any; record_id: string; occurred_at_ms: number }[] = [];
    for (;;) {
      const page = readOutbox(this.c, this.cursor, 50);
      for (const rec of page.records as any[]) {
        if (this.applied.has(rec.record_id)) continue;
        this.applied.set(rec.record_id, { kind: rec.kind, payload: rec.payload, occurred_at_ms: rec.occurred_at_ms });
        if (rec.kind === 'body_effect') this.bodyApplied.set(rec.payload.effect_id, (this.bodyApplied.get(rec.payload.effect_id) ?? 0) + 1);
        if (rec.kind === 'visit_settled' && rec.visit_id === this.visitId) this.settlement = rec.payload as Settlement;
        fresh.push(rec);
      }
      this.cursor = page.next_after;
      if (!page.more) break;
    }
    return fresh;
  }

  /** T3（应用结算）→ release。家里的钱 = 原来的 − 带出的 + 带回的。 */
  release(): BridgeReceipt {
    if (!this.settlement) this.pull();
    const s = this.settlement;
    if (!s) throw new Error('还没有收到 visit_settled');
    const receipt = releaseVisit(this.c, this.visitId, { request_id: `${this.visitId}:release`, settlement_id: s.settlement_id, domain_epoch: this.epoch + 1 });
    if (!receipt.replayed) {
      this.epoch += 1;
      this.frozenYen -= s.carry_yen;
      this.homeYen += s.purse_final_yen - s.carry_yen;
      this.settlement = null;
    }
    return receipt;
  }

  kinds(): string[] {
    return this.t.outbox(this.visitId).map((r) => r.kind);
  }

  records(kind: string): any[] {
    return this.t.outbox(this.visitId).filter((r) => r.kind === kind).map((r) => r.payload);
  }

  /** 她在城里和家里的钱加起来（不会多出来）。 */
  totalYen(): number {
    return this.homeYen - this.frozenYen + this.t.balance(`acct:${this.t.residentOf(this.actorId)}`) + 0;
  }
}

export { HOUSE_ENTRANCE };
