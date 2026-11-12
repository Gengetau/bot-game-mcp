/**
 * 栖灯镇测试辅助：内存数据库 + 假时钟 + 固定种子。
 *
 *   const t = makeTown();
 *   const a = t.join('阿灯');            // 注册并进入（真人，开发登录）
 *   const b = t.join('小岚', 'agent');   // AI 居民
 *   a.go('tea_house');                   // 走过去（途中自动续导航租约）
 *   a.act('speak', { text: '你好' });
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { WorldError } from '../../src/world/errors.js';
import { agentPrincipal, claimControl, heartbeat, issueTicket, exchangeTicket, sessionPrincipal, leaveWorld } from '../../src/world/identity.js';
import { createWorld, enterWorld } from '../../src/world/index.js';
import type { WorldService } from '../../src/world/service.js';
import { positionOfResident, renewNavigation, whereabouts } from '../../src/world/space.js';
import { meView, type MeView } from '../../src/world/views.js';
import { FakeClock } from '../helpers.js';

export interface TownOpts {
  seed?: string;
  params?: Record<string, unknown>;
  /** 给了就用文件数据库（重启测试用） */
  dbPath?: string;
  clock?: FakeClock;
  start?: boolean;
}

export class Actor {
  private seq = 0;
  lastView!: MeView;
  constructor(
    readonly t: Town,
    readonly principalId: string,
    readonly residentId: string,
    public clientId: string,
    readonly name: string,
  ) {}

  get auth() {
    return { principalId: this.principalId, clientId: this.clientId };
  }

  /** 重新读本人视图（顺带拿新的动作窗口和上下文版本）。 */
  view(): MeView {
    this.lastView = meView(this.t.w, this.t.w.mustResident(this.residentId), this.clientId);
    return this.lastView;
  }

  row() {
    return this.t.w.mustResident(this.residentId);
  }

  /** 发一条动作。默认每次读最新视图取 expected；传 opts 可以故意用旧值。 */
  act(type: string, fields: Record<string, unknown> = {}, opts: { requestId?: string; expected?: Record<string, unknown>; actionWindow?: string } = {}): Record<string, any> {
    const v = this.view();
    return this.t.w.command(this.auth, {
      requestId: opts.requestId ?? `${this.residentId}-req-${++this.seq}`,
      actionWindow: opts.actionWindow ?? v.actionWindow,
      expected: (opts.expected as never) ?? { contextVersion: v.context.version, controlEpoch: v.control.epoch, activityId: v.context.activityId },
      action: { type, ...fields },
    }) as Record<string, any>;
  }

  /** 期望动作失败，返回错误。 */
  fail(type: string, fields: Record<string, unknown> = {}, opts: Parameters<Actor['act']>[2] = {}): WorldError {
    try {
      this.act(type, fields, opts);
    } catch (e) {
      if (e instanceof WorldError) return e;
      throw e;
    }
    throw new Error(`动作 ${type} 本应失败，却成功了`);
  }

  heartbeat() {
    return heartbeat(this.t.w, this.auth, this.row().presence_epoch);
  }

  enter(profile?: Record<string, unknown>) {
    return enterWorld(this.t.w, this.auth, profile ? { profile } : {});
  }

  leave() {
    return leaveWorld(this.t.w, this.principalId);
  }

  claim() {
    return claimControl(this.t.w, this.auth);
  }

  /**
   * 走到某处并等到达：途中像真正的客户端那样每隔几秒续一次导航租约（顺带保持在场）。
   * 进出家门的多段路一并走完。目的地可以是地点、物件、居民编号或地图点。
   */
  go(to: string | { x: number; z: number }): Record<string, any> {
    const out = this.act('navigate', { to });
    if (out.status === 'accepted') this.walk();
    return out;
  }

  /** 把正在走的这一趟走完。没在走就什么也不做。 */
  walk(): void {
    const w = this.t.w;
    for (let guard = 0; guard < 600; guard++) {
      const nav = whereabouts(w, this.row(), w.now()).navigation;
      if (!nav) return;
      this.t.advanceTo(Math.max(w.now(), Math.min(nav.arriveAt, w.now() + w.params.navRenewEveryMs)));
      try {
        this.heartbeat();
        renewNavigation(w, this.auth, { navigationId: nav.navigationId, revision: nav.revision });
      } catch (e) {
        if (!(e instanceof WorldError)) throw e;
      }
    }
    throw new Error(`${this.name} 走了太久还没到`);
  }

  /** 此刻的权威位置。 */
  pos(): { scene: string; instance: string; x: number; z: number; moving: boolean } {
    const p = positionOfResident(this.t.w, this.residentId, this.t.w.now());
    if (!p) throw new Error(`${this.name} 还没有位置`);
    return p;
  }

  /** 这位居民游标之后的事件。 */
  events(cursor?: string) {
    return this.t.w.readResidentEvents(this.residentId, cursor ?? undefined);
  }

  coins(): number {
    return this.view().inventory.coins.balance;
  }

  qty(type: string): number {
    return this.view().inventory.items.filter((i) => i.type === type).reduce((s, i) => s + i.qty, 0);
  }
}

export class Town {
  w: WorldService;
  readonly clock: FakeClock;
  readonly logs: string[] = [];
  private n = 0;
  private opens = 0;
  constructor(readonly opts: TownOpts = {}) {
    this.clock = opts.clock ?? new FakeClock();
    this.w = this.open();
  }

  private open(): WorldService {
    const w = createWorld({
      dbPath: this.opts.dbPath ?? ':memory:',
      registry: createRegistry({}),
      now: this.clock.now,
      // 编号用的随机流每次重开换一段：同一个种子从头再来会生成和库里已有的一样的编号
      rng: new SeededRng(`${this.opts.seed ?? 'town-test'}${this.opens++ ? `#${this.opens}` : ''}`),
      seed: this.opts.seed ?? 'town-test',
      params: this.opts.params ?? {},
      log: (m) => this.logs.push(m),
      devLogin: true,
    });
    if (this.opts.start !== false) w.startSync();
    return w;
  }

  /** 模拟进程重启：关掉再用同一个数据库文件打开（需要 dbPath）。crash=true 是进程被杀：不写 last_alive_at。 */
  restart(opts: { crash?: boolean } = {}): WorldService {
    if (opts.crash) this.w.db.db.close();
    else this.w.close();
    this.w = this.open();
    return this.w;
  }

  /** 注册并进入一位居民。真人走「票据 → 会话」，AI 走 MCP 身份。 */
  join(name: string, kind: 'human' | 'agent' = 'human', profile: Record<string, unknown> = {}): Actor {
    const n = ++this.n;
    let principalId: string;
    if (kind === 'agent') principalId = agentPrincipal(this.w, { id: `30${n}`, name }).principal_id;
    else {
      const ticket = issueTicket(this.w, { provider: 'qq', subject: `20${n}`, name });
      const session = exchangeTicket(this.w, ticket.ticket);
      principalId = sessionPrincipal(this.w, session.token)!.principal_id;
    }
    const clientId = `${kind === 'agent' ? 'mcp' : 'web'}:client-${n}`;
    const out = enterWorld(this.w, { principalId, clientId }, { clientKind: kind === 'agent' ? 'mcp' : 'web', profile: { name, ...profile } });
    const actor = new Actor(this, principalId, out.enter.residentId, clientId, name);
    actor.lastView = out.view;
    return actor;
  }

  /** 时间前进并让调度器检查一次。 */
  advance(ms: number): void {
    this.clock.advance(ms);
    this.w.tick();
  }

  advanceTo(at: number): void {
    if (at > this.clock.t) this.clock.t = at;
    this.w.tick();
  }

  /** 时间前进，期间所有人保持心跳（不会因为租约到期掉线）。 */
  advanceAlive(ms: number, actors: Actor[], stepMs = 20_000): void {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.clock.advance(step);
      for (const a of actors) a.heartbeat();
      this.w.tick();
      left -= step;
    }
  }
}

export function makeTown(opts: TownOpts = {}): Town {
  return new Town(opts);
}

/** 临时目录里的文件数据库（重启、备份测试用）。用完调 cleanup。 */
export function tempDb(): { path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(joinPath(tmpdir(), 'town-test-'));
  return { path: joinPath(dir, 'town.db'), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
