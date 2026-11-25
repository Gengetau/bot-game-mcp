#!/usr/bin/env node
/**
 * 晴空都持续世界（M1）三方真实跨进程集成与故障重启验收脚本。
 *
 * 覆盖范围（严格隔离于临时目录，绝不触碰线上 city.db / town.db / life1.db / world.db）：
 *  1. 隔离护栏：town.enabled === false、/town/ 返回 404、桌面游戏（number_bomb）照常可用；
 *  2. 门禁与身份硬拦截：室友 QQ 侧密钥调 enter_world 返回 ENTRY_VIA_HOME_ONLY（F16），非白名单外部 Bot 返回 FORBIDDEN；
 *     hiyorizaka:ai-house:entrance 在公开视图、外部 Bot 视图、人类网页视图中均完全隐藏；
 *  3. 出门前雨伞规则（F13）：目的地降雨且妮娅无自有雨伞时，T1 冻结前即拒绝，零钱包/物品残留；
 *  4. 真实跨进程 T1 -> prepare -> commit -> T2 交接：注入 bridge503Count=2 + dropResponseOnce=true（F4），
 *     验证 Python world-kernel CityBridgeAdapter 原 request_id 退避重试 + GET /visits/:id 对账恢复，随身钱包只入账一次；
 *  5. 外部 Bot（M1-B CityClient + CityRunner）：首次入城 ¥200,000 启动金、多端 claim=false 只读旁观与 CityRunner 立即停写、
 *     显式 claim_control 递增 epoch 并使旧连接收到 CONTROL_LOST、书店购入明信片并前往棱光街·喫茶「灯」；
 *  6. 人类玩家（M1-C/D 一次性票据 + /city/api/* 会话 + CSRF + SSE）：裁判 MCP city_issue_ticket 签发 #ticket= 链接、
 *     单次兑换防重放、缺省 CSRF 返回 403、SSE 实时流连通、从云港站乘晴环线前往棱光街·喫茶「灯」；
 *  7. 在途真实引擎冷启动重启（harness.restart）+ 内核进程重启（restart_kernel）：
 *     验证三方在途行程按持久化 scheduled_jobs 恢复到站、零重复扣车费、网页会话跨重启保留、CityRunner 自动重连；
 *  8. 同场三方交互（棱光街·喫茶「灯」）：妮娅、外部 Bot「旅人一叶」、人类「阿澄」同场共处与对话，
 *     妮娅赠送家里烤的曲奇（实例件 origin_ref='nia_cookie_1' 原样保留）、饮用咖啡触发 drink_coffee 身体增量、
 *     购买咖啡豆（direction='home'）与第二杯未饮咖啡（carry_home=false -> disposed）、收到旅人赠送的明信片（locker），
 *     人类动作重发同一 request_id 返回 replayed=true 不二次扣费；
 *  9. 交易结果未知（F9 purchaseUnknown='cheesecake'）+ 返家途中第二次引擎重启 + T3 返家结算 + 关单后 order_refunded：
 *     验证 ¥520 锁定进入 reconcile 态、管理接口确认 failed 后引擎与内核双侧平账退回 ¥520 并收敛至 closed；
 * 10. 全员放行（enable_all）与无挂单储物柜直关（claire 第二次访问）：验证储物柜留存物品直接进入 closed 而非卡在 reconcile，
 *     最终校验引擎 ledgerImbalance === 0、runReconcile.ok === true、内核 adapter.reconcile().ok === true。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createIsolatedCityHarness } from '../packages/engine/test/city/test-harness.js';
import { ledgerImbalance, lockerItems, heldItems, runReconcile } from '../packages/engine/src/city/index.js';
import {
  BotGameClient,
  CityClient,
  CityClientError,
  CityRunner,
  type CityDecisionContext,
} from '../packages/agent-kit/src/index.js';

/**
 * 内嵌只读加载 world-kernel/life1 的跨进程测试宿主（写入临时目录执行，无需污染内核源码目录）。
 */
const PYTHON_KERNEL_DRIVER_SOURCE = String.raw`import argparse
import json
import os
import sqlite3
import sys

from worldkernel import outings
from worldkernel.city_bridge import CityBridgeAdapter, DeterministicCityModel
from worldkernel.city_client import CityBridgeHttpClient
from worldkernel.kernel import Refused
from worldkernel.legacy import Projector, offline_world
from worldkernel.life import ROSTER, Life
from worldkernel.statuscard import cards
from worldkernel.store import Store, VirtualClock


class Driver:
    def __init__(self, work_dir, bridge_url, bridge_key, start_ms):
        self.work_dir = work_dir
        self.db_path = os.path.join(work_dir, "life1-e2e.db")
        self.world_db = os.path.join(work_dir, "world-e2e.db")
        offline_world(self.world_db)
        self.bridge_url = bridge_url
        self.bridge_key = bridge_key
        self.clock = VirtualClock(start_ms / 1000.0)
        self._boot_seq = 0
        self._allowed_actors = ("nia",)
        self._queued_actions = []
        self._boot()
        with self.s.tx() as db:
            for a in ROSTER:
                self.k._set_actor(db, a, location="living", activity="idle", action_id=None)
            db.execute(
                "INSERT INTO resources(resource_id,kind,item,location,holder,qty,source)"
                " VALUES('nia_cookie_1','food','cookie',NULL,'nia',2,'e2e_seed')"
            )

    def _model_handler(self, ctx):
        if self._queued_actions:
            return self._queued_actions.pop(0)
        return []

    def _boot(self, policy="continue"):
        self._boot_seq += 1
        self.s = Store(self.db_path, self.clock, synthetic=True, seed=900 + self._boot_seq)
        self.s.acquire()
        self.client = CityBridgeHttpClient(
            self.bridge_url,
            self.bridge_key,
            timeout_s=5.0,
            max_retries=4,
            backoff_base_s=0.05,
            max_backoff_s=0.3,
        )
        self.model = DeterministicCityModel(self._model_handler)
        self.life = Life(self.s, extensions=[outings.install])
        self.k = self.life.k
        self.adapter = CityBridgeAdapter(
            self.life,
            self.client,
            city_model=self.model,
            allowed_actors=self._allowed_actors,
            recover_preparing_policy=policy,
            intercept_plans=True,
        )
        self.life.extensions.append(self.adapter)
        self.proj = Projector(self.life, self.world_db)

    def _cards(self):
        self.proj.run()
        wr = sqlite3.connect(f"file:{self.world_db}?mode=ro", uri=True)
        wr.row_factory = sqlite3.Row
        try:
            return cards(self.s.db, wr, self.clock.now())
        finally:
            wr.close()

    def handle(self, cmd):
        op = cmd["op"]
        if op == "sync_clock":
            target_s = float(cmd["now_ms"]) / 1000.0
            if target_s > self.clock.now():
                self.clock.advance(target_s - self.clock.now())
            self.k.tick()
            return {"ok": True, "now_ms": int(round(self.clock.now() * 1000))}

        if op == "strip_umbrellas":
            actor = cmd.get("actor", "nia")
            with self.s.tx() as db:
                db.execute("DELETE FROM garments WHERE actor=? AND (garment_id LIKE '%umbrella%' OR label LIKE '%伞%')", (actor,))
            return {"ok": True}

        if op == "depart":
            try:
                vis = self.adapter.depart(
                    cmd["actor"],
                    cmd["destination"],
                    carry_yen=cmd.get("carry_yen", 20000),
                    carry_items=cmd.get("carry_items"),
                    auto_snack=cmd.get("auto_snack", False),
                    visit_id=cmd.get("visit_id"),
                    duration_s=cmd.get("duration_s", 7200),
                )
                return {"ok": True, "visit": vis}
            except Refused as exc:
                return {"ok": False, "refused": exc.reason, "extra": exc.extra}

        if op == "advance_handover":
            vis = self.adapter.advance_handover(cmd["visit_id"])
            return {"ok": True, "visit": vis}

        if op == "queue_decision":
            self._queued_actions.append(list(cmd["actions"]))
            return {"ok": True, "queued": len(self._queued_actions)}

        if op == "poll_outbox":
            res = self.adapter.poll_outbox_once(wait_ms=int(cmd.get("wait_ms", 0)))
            return {"ok": True, "poll": res}

        if op == "step":
            self.adapter.step()
            return {"ok": True}

        if op == "restart_kernel":
            if cmd.get("bridge_url"):
                self.bridge_url = str(cmd["bridge_url"])
            downtime_s = float(cmd.get("downtime_s", 30))
            stopped = self.clock.now()
            self.s.release()
            self.s.close()
            self.clock.advance(downtime_s)
            self._boot(policy=cmd.get("policy", "continue"))
            self.k.resume(stopped)
            rec = self.adapter.recover()
            return {"ok": True, "recovered": len(rec)}

        if op == "enable_all":
            self._allowed_actors = tuple(ROSTER)
            self.adapter.enable_all_roommates()
            return {"ok": True, "allowed": sorted(self.adapter.allowed_actors)}

        if op == "inspect":
            actor = cmd.get("actor", "nia")
            vid = cmd.get("visit_id")
            c = self._cards()["residents"][actor]
            with self.s.read() as db:
                bal = db.execute("SELECT balance FROM wallets WHERE account=?", (actor,)).fetchone()[0]
                holds = [dict(r) for r in db.execute("SELECT * FROM wallet_holds WHERE account=? AND state='held'", (actor,)).fetchall()]
                foods = [
                    dict(r)
                    for r in db.execute(
                        "SELECT resource_id, item, location, holder, qty FROM resources"
                        " WHERE kind='food' AND (holder=? OR resource_id LIKE 'city:%' OR resource_id LIKE 'nia_%')"
                        " ORDER BY resource_id",
                        (actor,),
                    ).fetchall()
                ]
                encounters = [dict(r) for r in db.execute("SELECT * FROM city_encounters WHERE actor_id=?", (actor,)).fetchall()]
                effs = [dict(r) for r in db.execute("SELECT effect_id, status, reason FROM city_body_effects").fetchall()]
            carry = self.adapter._carry_row(vid) if vid else None
            return {
                "ok": True,
                "actor": self.k.actor(actor),
                "authority": self.k.city_visits.authority(actor),
                "visit": self.k.city_visits.get(vid) if vid else self.k.city_visits.current(actor),
                "carry": carry,
                "wallet_balance": int(bal),
                "wallet_available": self.adapter.wallet.available(actor),
                "holds": holds,
                "foods": foods,
                "encounters": encounters,
                "body_effects": effs,
                "city_card": c.get("city_outing"),
            }

        if op == "reconcile":
            return {"ok": True, "report": self.adapter.reconcile()}

        if op == "close":
            if self.s.epoch is not None:
                self.s.release()
            self.s.close()
            return {"ok": True}

        return {"ok": False, "error": f"unknown_op:{op}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--bridge-url", required=True)
    ap.add_argument("--bridge-key", required=True)
    ap.add_argument("--start-ms", type=int, required=True)
    args = ap.parse_args()
    drv = Driver(args.work_dir, args.bridge_url, args.bridge_key, args.start_ms)
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        req_id = req.get("id")
        try:
            resp = drv.handle(req)
        except Exception as exc:
            resp = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        if req_id is not None:
            resp["id"] = req_id
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        if req.get("op") == "close":
            break


if __name__ == "__main__":
    main()
`;

interface KernelResponse {
  id?: number;
  ok: boolean;
  refused?: string;
  error?: string;
  [k: string]: any;
}

class KernelDriver {
  private proc!: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: KernelResponse) => void; reject: (e: Error) => void }>();
  private stderrBuf: string[] = [];

  async start(opts: { kernelDir: string; workDir: string; bridgeUrl: string; bridgeKey: string; startMs: number }): Promise<void> {
    const driverScript = join(opts.workDir, 'city_e2e_driver.py');
    writeFileSync(driverScript, PYTHON_KERNEL_DRIVER_SOURCE, 'utf8');
    this.proc = spawn(
      'python3',
      [
        '-B',
        '-u',
        driverScript,
        '--work-dir',
        opts.workDir,
        '--bridge-url',
        opts.bridgeUrl,
        '--bridge-key',
        opts.bridgeKey,
        '--start-ms',
        String(opts.startMs),
      ],
      {
        cwd: opts.kernelDir,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: opts.kernelDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.proc.stderr.on('data', (chunk) => {
      this.stderrBuf.push(String(chunk));
    });
    this.proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`city_e2e_driver 意外退出 (code=${code}, sig=${sig}): ${this.stderrBuf.join('')}`));
      }
      this.pending.clear();
    });

    const rl = createInterface({ input: this.proc.stdout });
    let readyResolved = false;
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(new Error(`等待 city_e2e_driver 就绪超时: ${this.stderrBuf.join('')}`));
      }, 15_000);
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const msg = JSON.parse(trimmed) as Record<string, any>;
        if (!readyResolved && msg.ready) {
          readyResolved = true;
          clearTimeout(timer);
          resolveReady();
          return;
        }
        const id = Number(msg.id);
        const waiter = this.pending.get(id);
        if (waiter) {
          this.pending.delete(id);
          waiter.resolve(msg as KernelResponse);
        }
      });
    });
  }

  async call(cmd: Record<string, unknown>, opts: { allowRefused?: boolean } = {}): Promise<KernelResponse> {
    const id = ++this.seq;
    const res = await new Promise<KernelResponse>((resFn, rejFn) => {
      this.pending.set(id, { resolve: resFn, reject: rejFn });
      this.proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
    });
    if (!res.ok && !opts.allowRefused) {
      throw new Error(`KernelDriver(${String(cmd.op)}) 失败: ${JSON.stringify(res)} | stderr=${this.stderrBuf.join('')}`);
    }
    return res;
  }

  async close(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    try {
      await this.call({ op: 'close' }, { allowRefused: true });
    } catch {
      /* ignore */
    }
    this.proc.kill('SIGTERM');
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(30);
  }
  throw new Error(`等待条件超时: ${label}`);
}

async function openSseProbe(url: string, sessionHeader: string): Promise<{ lines: string[]; close: () => Promise<void> }> {
  const ac = new AbortController();
  const lines: string[] = [];
  const resp = await fetch(url, {
    headers: { cookie: sessionHeader, accept: 'text/event-stream' },
    signal: ac.signal,
  });
  assert.equal(resp.status, 200, 'SSE /city/api/stream 应返回 200');
  assert.match(String(resp.headers.get('content-type')), /text\/event-stream/i);
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let carry = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        const parts = carry.split('\n');
        carry = parts.pop() ?? '';
        for (const p of parts) lines.push(p);
      }
    } catch {
      /* aborted on close */
    }
  })();
  await waitFor(() => lines.some((l) => l.includes('connected')), 'SSE 首帧 : connected');
  return {
    lines,
    async close() {
      ac.abort();
      await pump.catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'kernel-dir': { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const kernelDir = resolve(values['kernel-dir'] ?? process.env.WORLD_KERNEL_DIR ?? '/mcp-wt/world-kernel');
  const rootWorkDir = mkdtempSync(join(tmpdir(), 'city-m1-e2e-'));
  const engineDir = join(rootWorkDir, 'engine');
  const kernelWorkDir = join(rootWorkDir, 'kernel');
  mkdirSafe(engineDir);
  mkdirSafe(kernelWorkDir);

  const harness = await createIsolatedCityHarness({
    workDir: engineDir,
    seed: 'city-m1-e2e-seed-20261118',
    enableControlRoutes: true,
    cityOverrides: { publicUrl: 'https://city-e2e.invalid/city/play/' },
  });
  const kernel = new KernelDriver();
  let botRunner: CityRunner | null = null;
  let sseProbe: { lines: string[]; close: () => Promise<void> } | null = null;
  const closers: (() => Promise<void>)[] = [];

  const advanceBoth = async (ms: number) => {
    harness.advance(ms);
    await kernel.call({ op: 'sync_clock', now_ms: harness.clock.t });
  };

  try {
    await kernel.start({
      kernelDir,
      workDir: kernelWorkDir,
      bridgeUrl: harness.bridgeUrl,
      bridgeKey: harness.bridgeKey,
      startMs: harness.clock.t,
    });

    // ── 1. 隔离护栏与桌面游戏不受影响 ──
    assert.equal('town' in harness.config, false);
    const health = await (await fetch(`${harness.baseUrl}/health`)).json() as Record<string, any>;
    assert.equal(health.ok, true);
    assert.equal(health.town_enabled, false);
    assert.equal(health.city_enabled, true);

    const townResp = await fetch(`${harness.baseUrl}/town/`);
    assert.equal(townResp.status, 404, '/town/ 必须返回 404');

    const cityPage = await fetch(`${harness.baseUrl}/city/`);
    assert.equal(cityPage.status, 200);
    assert.match(await cityPage.text(), /晴空都/);

    const playNoSlash = await fetch(`${harness.baseUrl}/city/play`, { redirect: 'manual' });
    assert.equal(playNoSlash.status, 302);
    assert.equal(playNoSlash.headers.get('location'), '/city/play/');

    const playPage = await fetch(`${harness.baseUrl}/city/play/`);
    assert.equal(playPage.status, 200);
    assert.match(String(playPage.headers.get('content-security-policy')), /script-src 'self'/);

    // 验证桌面游戏引擎（number_bomb）在同一进程内照常工作
    const refClient = await BotGameClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_referee_key_city_0001',
    });
    closers.push(() => refClient.close());
    const createdGame = await refClient.call<Record<string, any>>('create_game', {
      game_type: 'number_bomb',
      group_id: '1000001',
    });
    assert.ok(createdGame.summary?.game_id, 'number_bomb 桌游创建正常');

    // ── 2. 身份门禁（F16 室友 QQ 侧禁入 + 非白名单外部 Bot 禁入 + 交接节点隐藏） ──
    const niaQq = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_house_qq_nia_30001',
      clientId: 'nia-qq-probe',
    });
    closers.push(() => niaQq.close());
    await assert.rejects(
      () => niaQq.enterWorld({ name: '妮娅' }),
      (err: unknown) => err instanceof CityClientError && err.code === 'entry_via_home_only',
      '室友 QQ 密钥调 enter_world 必须被 ENTRY_VIA_HOME_ONLY 拦截',
    );
    const pubFromNiaQq = await niaQq.query('public');
    assert.ok(!JSON.stringify(pubFromNiaQq).includes('ai-house:entrance'), '公开视图严禁暴露小屋交接点');

    const unlistedBot = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_unlisted_90099',
      clientId: 'unlisted-probe',
    });
    closers.push(() => unlistedBot.close());
    await assert.rejects(
      () => unlistedBot.enterWorld({ name: '名单外' }),
      (err: unknown) => err instanceof CityClientError && err.code === 'forbidden',
      '非白名单外部 Bot 必须被 FORBIDDEN 拦截',
    );

    // ── 3. 出门前雨天无伞拦截（F13：在任何钱包/物品冻结之前拒绝） ──
    await kernel.call({ op: 'strip_umbrellas', actor: 'nia' });
    const niaPre0 = await kernel.call({ op: 'inspect', actor: 'nia' });
    const initialNiaWallet = Number(niaPre0.wallet_balance);
    harness.setAreaRain({ ryokogai: true });
    const rainRefused = await kernel.call(
      { op: 'depart', actor: 'nia', destination: 'ryokogai:kissa-tomoshibi', carry_yen: 20_000 },
      { allowRefused: true },
    );
    assert.equal(rainRefused.ok, false);
    assert.equal(rainRefused.refused, 'rain_requires_owned_umbrella');
    const niaAfterRainRefuse = await kernel.call({ op: 'inspect', actor: 'nia' });
    assert.equal(niaAfterRainRefuse.wallet_balance, initialNiaWallet);
    assert.equal(niaAfterRainRefuse.holds.length, 0);
    assert.equal(niaAfterRainRefuse.authority.domain, 'home');
    assert.equal(niaAfterRainRefuse.authority.domain_epoch, 0);

    // 天放晴后正式出门（携带 ¥20,000 与 1 份家庭曲奇 nia_cookie_1）
    harness.setAreaRain({ hiyorizaka: false, ryokogai: false, kumominato: false });
    const dep1 = await kernel.call({
      op: 'depart',
      actor: 'nia',
      destination: 'ryokogai:kissa-tomoshibi',
      carry_yen: 20_000,
      carry_items: [{ resource_id: 'nia_cookie_1', qty: 1 }],
      visit_id: 'vis_m1_e2e_1',
    });
    assert.equal(dep1.visit.state, 'preparing');
    await advanceBoth(60_000); // 妮娅从客厅走到玄关 away（60s）

    // 注入桥接 503 RECOVERING x2 + 提交后丢回包（F4），验证 prepare/commit 幂等恢复且只入账一次
    harness.faults.bridge503Count = 2;
    harness.faults.dropResponseOnce = true;
    const hand1 = await kernel.call({ op: 'advance_handover', visit_id: 'vis_m1_e2e_1' });
    assert.equal(hand1.visit.state, 'active');
    assert.equal(hand1.visit.domain_epoch, 1);
    assert.equal(harness.faults.bridge503Count, 0);
    assert.equal(harness.faults.dropResponseOnce, false);

    const niaResidentRow = harness.city.db.get<{ resident_id: string }>(
      "SELECT resident_id FROM house_members WHERE actor_id = 'nia'",
    )!;
    const niaResidentId = niaResidentRow.resident_id;

    // ── 4. 外部 Bot「旅人一叶」（M1-B CityClient + 多端控制权栅栏 + CityRunner） ──
    const botB1 = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_key_city_90001',
      clientId: 'ext-bot-b-1',
      retryBaseMs: 25,
    });
    closers.push(() => botB1.close());
    const enterB1 = await botB1.enterWorld({
      name: '旅人一叶',
      bio: '带着旧相机的旅人',
      entry: 'ryokogai:station',
    });
    assert.equal(enterB1.created, true);
    assert.equal(enterB1.granted_yen, 200_000);
    assert.deepEqual(enterB1.control, { epoch: 1, mine: true });
    const botBResidentId = enterB1.resident_id;

    // 第二个连接默认 claim=false：必须返回 mine=false，且 CityRunner 立即进入 control_lost 停写态
    const botB2 = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_key_city_90001',
      clientId: 'ext-bot-b-2',
      retryBaseMs: 25,
    });
    closers.push(() => botB2.close());
    const enterB2 = await botB2.enterWorld({ claim: false });
    assert.deepEqual(enterB2.control, { epoch: 1, mine: false });

    const passiveRunner = new CityRunner({ minIntervalMs: 0, waitSeconds: 1 });
    let passiveDecideCalls = 0;
    const passiveHandle = passiveRunner.add({
      label: 'botB-passive',
      city: botB2,
      decide: () => {
        passiveDecideCalls += 1;
        return null;
      },
    });
    await waitFor(() => passiveHandle.status === 'control_lost', '副连接 CityRunner 进入 control_lost');
    assert.equal(passiveDecideCalls, 0, '未持权客户端严禁触发模型决策');
    await passiveRunner.stop();

    // 显式 claim_control 接管 -> epoch=2，原连接写动作立即收到 CONTROL_LOST
    const claimed2 = await botB2.claimControl();
    assert.deepEqual(claimed2.control, { epoch: 2, mine: true });
    await assert.rejects(
      () => botB1.say('旧连接尝试发言'),
      (err: unknown) => err instanceof CityClientError && err.code === 'control_lost',
      '失权连接写动作必须收到 CONTROL_LOST',
    );
    // 显式切回主连接 botB1 -> epoch=3
    const claimed1 = await botB1.claimControl();
    assert.deepEqual(claimed1.control, { epoch: 3, mine: true });

    // 启动正式 CityRunner 驱动外部 Bot：先去书店「栞堂」买明信片，再步行去喫茶「灯」，收到曲奇后回赠明信片
    let botGiftedNia = false;
    let botHeadedToCafe = false;
    let botBCurrent = botB1;
    botRunner = new CityRunner({
      minIntervalMs: 0,
      debounceMs: 20,
      debounceMaxMs: 60,
      urgentDebounceMs: 80,
      waitSeconds: 1,
      reconnectBaseMs: 30,
      reconnectMaxMs: 200,
    });
    const botHandle = botRunner.add({
      label: 'tabibito-kazuha',
      city: botB1,
      reconnect: async () => {
        const next = await CityClient.connect({
          url: harness.mcpUrl,
          key: 'test_only_ext_bot_key_city_90001',
          clientId: 'ext-bot-b-1',
          retryBaseMs: 25,
        });
        closers.push(() => next.close());
        botBCurrent = next;
        return next;
      },
      decide: (ctx: CityDecisionContext) => {
        const placeId = ctx.view.here?.place.id;
        const hasPostcard = ctx.view.items.some((i) => i.type === 'postcard' && i.qty > 0);
        const hasCookieFromNia = ctx.view.items.some((i) => i.type === 'cookie' && i.qty > 0);
        if (placeId === 'ryokogai:station' && !hasPostcard) {
          return { actions: [{ type: 'travel', to: 'ryokogai:shiorido' }] };
        }
        if (placeId === 'ryokogai:shiorido' && !hasPostcard) {
          botHeadedToCafe = true;
          return {
            actions: [
              { type: 'buy', sku: 'postcard', qty: 2 },
              { type: 'travel', to: 'ryokogai:kissa-tomoshibi' },
            ],
          };
        }
        if (placeId === 'ryokogai:kissa-tomoshibi' && hasCookieFromNia && !botGiftedNia) {
          botGiftedNia = true;
          return {
            actions: [
              { type: 'say', text: '谢谢妮娅的曲奇！这张书店明信片送给你。' },
              { type: 'give', to: niaResidentId, item: 'postcard', qty: 1 },
            ],
          };
        }
        return null;
      },
    });

    await waitFor(() => {
      const r = harness.city.mustResident(botBResidentId);
      return Boolean(r.trip_id);
    }, '外部 Bot 出发前往书店');
    await advanceBoth(5 * 60_000); // 5 分钟到书店「栞堂」
    await waitFor(() => botHeadedToCafe && Boolean(harness.city.mustResident(botBResidentId).trip_id), '外部 Bot 买好明信片并出发去喫茶「灯」');

    // ── 5. 人类玩家「阿澄」（裁判签发一次性票据 + /city/api/* + CSRF + SSE） ──
    const ticketRes = await refClient.call<{
      ok: true;
      ticket: string;
      url: string | null;
      expires_at_ms: number;
    }>('city_issue_ticket', {
      user_id: '70001',
      name: '阿澄',
    });
    assert.equal(ticketRes.ok, true);
    assert.ok(ticketRes.url?.includes('#ticket='), '人类登录 URL 必须采用 #ticket= Fragment 承载票据');
    assert.ok(!ticketRes.url?.includes('?ticket='), '严禁把票据放在 Query 参数中');

    const exchResp = await fetch(`${harness.baseUrl}/city/api/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.baseUrl },
      body: JSON.stringify({ ticket: ticketRes.ticket }),
    });
    assert.equal(exchResp.status, 200);
    const setSessionRaw = exchResp.headers.get('set-cookie') ?? '';
    const humanSessionHeader = setSessionRaw.split(';')[0]!;
    assert.ok(humanSessionHeader.startsWith('city_session='), '应签发 HttpOnly 会话凭证');
    const exchBody = (await exchResp.json()) as { ok: boolean; csrf_token: string };
    const humanCsrf = exchBody.csrf_token;
    assert.ok(humanCsrf.length >= 16);

    // 同一张一次性票据二次兑换必须 401
    const replayExch = await fetch(`${harness.baseUrl}/city/api/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.baseUrl },
      body: JSON.stringify({ ticket: ticketRes.ticket }),
    });
    assert.equal(replayExch.status, 401, '一次性票据重放必须返回 401');

    // 缺少 CSRF 头写操作必须 403
    const noCsrfResp = await fetch(`${harness.baseUrl}/city/api/enter`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: harness.baseUrl,
        cookie: humanSessionHeader,
      },
      body: JSON.stringify({ name: '阿澄', entry: 'kumominato:station', client_id: 'human-web-1' }),
    });
    assert.equal(noCsrfResp.status, 403, '缺少 x-city-csrf 必须返回 403');

    // 正常入城（落点云港站，发放 ¥200,000）
    const humanEnterResp = await fetch(`${harness.baseUrl}/city/api/enter`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: harness.baseUrl,
        cookie: humanSessionHeader,
        'x-city-csrf': humanCsrf,
      },
      body: JSON.stringify({
        name: '阿澄',
        bio: '周末散步的人类旅人',
        entry: 'kumominato:station',
        client_id: 'human-web-1',
      }),
    });
    assert.equal(humanEnterResp.status, 200);
    const humanEnter = (await humanEnterResp.json()) as Record<string, any>;
    assert.equal(humanEnter.created, true);
    assert.equal(humanEnter.granted_yen, 200_000);
    const humanResidentId = String(humanEnter.resident_id);

    // 连接人类 SSE 流并发起从云港前往棱光街·喫茶「灯」的电车行程（10m 晴环线 ¥200 + 6m 步行）
    sseProbe = await openSseProbe(`${harness.baseUrl}/city/api/stream?client_id=human-web-1`, humanSessionHeader);
    const humanTravelResp = await fetch(`${harness.baseUrl}/city/api/act`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: harness.baseUrl,
        cookie: humanSessionHeader,
        'x-city-csrf': humanCsrf,
      },
      body: JSON.stringify({
        request_id: 'human-travel-kissa-0001',
        client_id: 'human-web-1',
        action: { type: 'travel', to: 'ryokogai:kissa-tomoshibi' },
      }),
    });
    assert.equal(humanTravelResp.status, 200);

    // ── 6. 三方在途推进 + 真实引擎冷启动崩溃重启（F7 / F10） ──
    // 按 <10m 在场租约分三段推进至 t+24m（旅人一叶与阿澄定时续心跳，妮娅在北环快线/棱光街步行途中）
    const keepPresenceAlive = async () => {
      await botBCurrent.heartbeat();
      const hb = await fetch(`${harness.baseUrl}/city/api/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: harness.baseUrl,
          cookie: humanSessionHeader,
          'x-city-csrf': humanCsrf,
        },
        body: JSON.stringify({ client_id: 'human-web-1' }),
      });
      assert.equal(hb.status, 200);
    };
    for (let stepIdx = 0; stepIdx < 3; stepIdx++) {
      await advanceBoth(8 * 60_000);
      await keepPresenceAlive();
    }
    await sseProbe.close();
    sseProbe = null;

    // 引擎进程关闭重开（停机 8 分钟：既在 10m 租约窗口内，又跨越妮娅 t+31m 到店时刻）+ 内核进程重启恢复
    await harness.restart(8 * 60_000);
    const kRec = await kernel.call({
      op: 'restart_kernel',
      downtime_s: 8 * 60,
      bridge_url: harness.bridgeUrl,
    });
    assert.equal(kRec.ok, true);

    // 人类网页会话跨引擎重启保留（无需重新兑换票据），且车费只扣一次（200000 - 200 = 199800）
    sseProbe = await openSseProbe(`${harness.baseUrl}/city/api/stream?client_id=human-web-1`, humanSessionHeader);
    const humanMeAfterRestart = (await (
      await fetch(`${harness.baseUrl}/city/api/me?client_id=human-web-1`, {
        headers: { cookie: humanSessionHeader },
      })
    ).json()) as Record<string, any>;
    assert.equal(humanMeAfterRestart.here?.place?.id, 'ryokogai:kissa-tomoshibi');
    assert.equal(humanMeAfterRestart.wallet?.yen, 199_800, '跨引擎重启后晴环线车费严禁二次扣款');
    assert.ok(!JSON.stringify(humanMeAfterRestart).includes('ai-house:entrance'), '人类视图严禁暴露小屋交接点');

    // CityRunner 在引擎断连后自动调用 reconnect() 重建 MCP 连接并恢复事件循环
    await waitFor(() => botBCurrent !== botB1, 'CityRunner 跨引擎重启自动建立新 MCP 连接');
    await waitFor(() => botHandle.status === 'running', 'CityRunner 重连后保持 running');
    const botViewAtCafe = await botBCurrent.view();
    assert.equal(botViewAtCafe.here?.place.id, 'ryokogai:kissa-tomoshibi');
    assert.ok(!JSON.stringify(botViewAtCafe).includes('ai-house:entrance'), '外部 Bot 视图严禁暴露小屋交接点');

    // ── 7. 三方在棱光街·喫茶「灯」真实同场交互 ──
    const pubAtCafe = (await (await fetch(`${harness.baseUrl}/city/api/public`)).json()) as Record<string, any>;
    const kagArea = (pubAtCafe.areas as any[]).find((a) => a.id === 'ryokogai');
    const cafePlace = (kagArea.places as any[]).find((p) => p.id === 'ryokogai:kissa-tomoshibi');
    const cafeNames = (cafePlace.here as any[]).map((x) => x.name).sort();
    assert.deepEqual(cafeNames, ['妮娅', '旅人一叶', '阿澄'].sort(), '三类玩家必须在棱光街·喫茶「灯」同场共处');

    // 人类玩家「阿澄」率先现场搭话（触发妮娅 heard_chat 唤醒）+ 买皇家奶茶（重发同一 request_id 验证幂等不重复扣费）
    const humanSayResp = await fetch(`${harness.baseUrl}/city/api/act`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: harness.baseUrl,
        cookie: humanSessionHeader,
        'x-city-csrf': humanCsrf,
      },
      body: JSON.stringify({
        request_id: 'human-say-kissa-0001',
        client_id: 'human-web-1',
        action: { type: 'say', text: '下午好！我刚从新宿坐山手线过来，这里的咖啡好香。' },
      }),
    });
    assert.equal(humanSayResp.status, 200);

    const buyTeaBody = JSON.stringify({
      request_id: 'human-buy-tea-0001',
      client_id: 'human-web-1',
      action: { type: 'buy', sku: 'milk_tea', qty: 1 },
    });
    const buyTea1 = (await (
      await fetch(`${harness.baseUrl}/city/api/act`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: harness.baseUrl,
          cookie: humanSessionHeader,
          'x-city-csrf': humanCsrf,
        },
        body: buyTeaBody,
      })
    ).json()) as Record<string, any>;
    const buyTea2 = (await (
      await fetch(`${harness.baseUrl}/city/api/act`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: harness.baseUrl,
          cookie: humanSessionHeader,
          'x-city-csrf': humanCsrf,
        },
        body: buyTeaBody,
      })
    ).json()) as Record<string, any>;
    assert.equal(buyTea1.status, 'completed');
    assert.equal(buyTea2.replayed, true, '同一 request_id 重放必须返回原回执且不二次扣款');
    assert.equal(buyTea2.view.wallet.yen, 199_300); // 199800 - 500 = 199300

    // 妮娅第一次决策（响应 heard_chat 唤醒）：问候 + 买第一杯咖啡 + 买咖啡豆带回家 + 把家里带的曲奇送给旅人一叶
    await kernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'say', text: '下午好呀，店里的煤油灯好暖和。' },
        { type: 'buy', sku: 'coffee', qty: 1 },
        { type: 'buy', sku: 'coffee_beans', qty: 1 },
        { type: 'give', to: botBResidentId, item: 'cookie', qty: 1 },
      ],
    });
    await kernel.call({ op: 'poll_outbox' });

    // 等待外部 Bot CityRunner 被 gift_received/chat 立即唤醒并回赠书店明信片给妮娅
    await waitFor(() => botGiftedNia, '外部 Bot 收到曲奇并启动回赠');
    await waitFor(
      () => heldItems(harness.city, niaResidentId).some((i) => i.type === 'postcard' && i.quantity === 1),
      '妮娅随身收到外部 Bot 回赠的明信片',
    );

    // 核对旅人一叶收到的曲奇保持原实例身份（origin_ref === 'nia_cookie_1'）
    const botCookies = heldItems(harness.city, botBResidentId).filter((i) => i.type === 'cookie');
    assert.equal(botCookies.length, 1);
    assert.equal(botCookies[0]!.origin_ref, 'nia_cookie_1', '室友赠予外部 Bot 的手作物品必须保留原 origin_ref');
    assert.equal(botCookies[0]!.instance, 1);

    // 校验人类 SSE 实时收到店内事件帧
    await waitFor(() => sseProbe!.lines.some((l) => l.includes('煤油灯') || l.includes('明信片')), '人类 SSE 收到同场聊天推送');

    // ── 8. 注入交易结果未知（F9 purchaseUnknown='cheesecake'）+ 返家途中第二次引擎重启 + T3 + 关单后退款 ──
    harness.faults.purchaseUnknown = 'cheesecake';
    await kernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'consume', item: 'coffee', qty: 1 }, // 喝掉第一杯咖啡 -> drink_coffee 身体效果
        { type: 'buy', sku: 'coffee', qty: 1 }, // 再买第二杯未喝完 -> 返家自动 disposed
        { type: 'buy', sku: 'cheesecake', qty: 1 }, // ¥520 触发 purchaseUnknown -> pending 锁款
        { type: 'go_home' }, // 动身返家
      ],
    });
    await kernel.call({ op: 'poll_outbox' });
    harness.faults.purchaseUnknown = false;

    const pendingOrder = harness.city.db.get<{ order_id: string; yen: number; status: string }>(
      "SELECT order_id, yen, status FROM orders WHERE visit_id = 'vis_m1_e2e_1' AND status = 'pending'",
    );
    assert.ok(pendingOrder, 'F9 故障应生成一笔 status=pending 的未决订单');
    assert.equal(pendingOrder.yen, 520);

    // 返家途中（且挂有未决订单 ¥520）再次执行真实引擎冷启动重启
    await sseProbe.close();
    sseProbe = null;
    await botRunner.stop();
    botRunner = null;

    await harness.restart(40 * 60_000); // 跨越回程电车+步行耗时，引擎恢复时自动结算至小屋门口
    await kernel.call({
      op: 'restart_kernel',
      downtime_s: 40 * 60,
      bridge_url: harness.bridgeUrl,
    });

    // 内核消费 visit_settled -> 执行原子 T3 + POST /visits/:id/release -> 走回客厅 living
    await kernel.call({ op: 'poll_outbox' });
    await kernel.call({ op: 'step' });
    await advanceBoth(60_000);
    await kernel.call({ op: 'step' });

    const niaReconcile = await kernel.call({ op: 'inspect', actor: 'nia', visit_id: 'vis_m1_e2e_1' });
    assert.equal(niaReconcile.actor.location, 'living');
    assert.equal(niaReconcile.authority.domain, 'home');
    assert.equal(niaReconcile.authority.domain_epoch, 2);
    assert.equal(niaReconcile.visit.state, 'reconcile', '存在未决订单时返家后必须停在 reconcile 等对账');
    assert.equal(
      harness.city.db.get<{ state: string }>("SELECT state FROM visits WHERE visit_id = 'vis_m1_e2e_1'")?.state,
      'reconcile',
    );
    // 此时 ¥520 仍锁定在未决订单中：总扣减 = 200(去程) + 450(咖啡1) + 900(咖啡豆) + 450(咖啡2) + 520(锁款) + 200(回程) = 2720
    assert.equal(niaReconcile.wallet_balance, initialNiaWallet - 2_720);
    assert.equal(niaReconcile.holds.length, 0);

    // 管理员通过正式 HTTP 管理接口确认未决订单为 failed -> 引擎退款回桥接池并写 order_refunded -> 双侧收敛至 closed
    const resolveResp = await fetch(`${harness.baseUrl}/city/api/admin/orders/${pendingOrder.order_id}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test_only_admin_key_city_isolated_0001',
      },
      body: JSON.stringify({ outcome: 'failed' }),
    });
    assert.equal(resolveResp.status, 200);
    const resolveJson = (await resolveResp.json()) as Record<string, any>;
    assert.equal(resolveJson.visit_state, 'closed');
    assert.equal(resolveJson.reconcile_ok, true);

    await kernel.call({ op: 'poll_outbox' });
    const niaClosed = await kernel.call({ op: 'inspect', actor: 'nia', visit_id: 'vis_m1_e2e_1' });
    assert.equal(niaClosed.visit.state, 'closed', '消费 order_refunded 后内核访问状态必须收敛至 closed');
    assert.equal(niaClosed.wallet_balance, initialNiaWallet - 2_200, '¥520 未决退款必须准确补回家庭钱包');

    // 核对妮娅物品、储物柜、身体增量与当面交谈记录
    const niaSeedCookie = (niaClosed.foods as any[]).find((f) => f.resource_id === 'nia_cookie_1');
    assert.equal(niaSeedCookie?.qty, 1, '带出门的 1 份曲奇已送出，家里剩余 1 份');
    const niaHomeCoffee = (niaClosed.foods as any[]).find(
      (f) => String(f.resource_id).startsWith('city:vis_m1_e2e_1:') && f.item === 'coffee',
    );
    assert.equal(niaHomeCoffee?.qty, 1, '城里买的 coffee_beans 必须按 mappings v2 转入家里厨房 food/coffee');
    assert.equal(
      (niaClosed.foods as any[]).some((f) => String(f.item).includes('postcard')),
      false,
      '未映射的明信片不得混入家庭库存',
    );
    const niaLocker = lockerItems(harness.city, niaResidentId);
    assert.equal(niaLocker.length, 1);
    assert.equal(niaLocker[0]!.type, 'postcard', '旅人赠送的明信片必须在返家时自动留存妮娅城市储物柜');

    const encounterNames = (niaClosed.encounters as any[]).map((e) => e.other_name).sort();
    assert.deepEqual(encounterNames, ['旅人一叶', '阿澄'].sort(), '妮娅与外部 Bot、人类的双向当面交谈均须入库');
    assert.ok(
      (niaClosed.body_effects as any[]).filter((e) => e.status === 'applied').length >= 2,
      '步行与饮用咖啡的身体效果必须幂等应用',
    );

    // ── 9. 全员放行（enable_all）+ 无挂单储物柜留存直接 closed 验收（claire 第二次访问） ──
    const enabled = await kernel.call({ op: 'enable_all' });
    assert.equal(enabled.allowed.length, 6);

    const dep2 = await kernel.call({
      op: 'depart',
      actor: 'claire',
      destination: 'ryokogai:shiorido',
      carry_yen: 5_000,
      visit_id: 'vis_m1_e2e_2',
    });
    assert.equal(dep2.visit.state, 'preparing');
    await advanceBoth(60_000);
    const hand2 = await kernel.call({ op: 'advance_handover', visit_id: 'vis_m1_e2e_2' });
    assert.equal(hand2.visit.state, 'active');
    await advanceBoth(35 * 60_000); // 抵达棱光街·书店「栞堂」
    await kernel.call({
      op: 'queue_decision',
      actions: [
        { type: 'buy', sku: 'paperback', qty: 1 }, // ¥800 未映射文库本 -> 返家存 locker
        { type: 'go_home' },
      ],
    });
    await kernel.call({ op: 'poll_outbox' });
    await advanceBoth(40 * 60_000);
    await kernel.call({ op: 'poll_outbox' });
    await kernel.call({ op: 'step' });
    await advanceBoth(60_000);
    await kernel.call({ op: 'step' });

    const claireClosed = await kernel.call({ op: 'inspect', actor: 'claire', visit_id: 'vis_m1_e2e_2' });
    assert.equal(claireClosed.actor.location, 'living');
    assert.equal(claireClosed.visit.state, 'closed', '仅储物柜留存物品、无 pending 订单时必须直接 closed');
    assert.equal(
      harness.city.db.get<{ state: string }>("SELECT state FROM visits WHERE visit_id = 'vis_m1_e2e_2'")?.state,
      'closed',
    );
    const claireResidentId = harness.city.db.get<{ resident_id: string }>(
      "SELECT resident_id FROM house_members WHERE actor_id = 'claire'",
    )!.resident_id;
    assert.equal(lockerItems(harness.city, claireResidentId)[0]?.type, 'paperback');

    // ── 10. 最终跨库零差额对账（Engine ledger + reconcile & Kernel reconcile） ──
    const engineImbalance = ledgerImbalance(harness.city);
    const engineRec = runReconcile(harness.city, 'm1_e2e_final');
    const kernelRec = await kernel.call({ op: 'reconcile' });

    assert.equal(engineImbalance, 0, `引擎总账必须严格平衡，实际差额=${engineImbalance}`);
    assert.equal(engineRec.ok, true, `引擎对账发现异常: ${JSON.stringify(engineRec.findings)}`);
    assert.equal(kernelRec.report.ok, true, `内核跨库对账发现异常: ${JSON.stringify(kernelRec.report.findings)}`);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          scenario: 'city-m1-three-party-and-fault-e2e',
          coPresentAt: 'ryokogai:kissa-tomoshibi',
          participants: {
            house: { actor: 'nia', residentId: niaResidentId, secondActor: 'claire' },
            externalBot: { name: '旅人一叶', residentId: botBResidentId },
            human: { name: '阿澄', residentId: humanResidentId },
          },
          restartsSurvived: 2,
          faultsVerified: [
            'F4_bridge_503_and_dropped_response',
            'F7_F10_mid_transit_engine_and_kernel_cold_restart',
            'F9_purchase_unknown_reconcile_and_post_close_order_refunded',
            'F13_rain_without_owned_umbrella_pre_freeze_cancel',
            'F16_house_qq_key_entry_via_home_only',
            'M1B_multi_client_control_lost_fence',
            'M1C_one_time_fragment_ticket_csrf_and_sse',
          ],
          settlement: {
            niaInitialWallet: initialNiaWallet,
            niaFinalWallet: niaClosed.wallet_balance,
            niaNetSpentYen: 2_200,
            giftedCookieOriginRef: botCookies[0]!.origin_ref,
            niaHomeCoffeeBeansQty: niaHomeCoffee?.qty,
            niaLockerTypes: niaLocker.map((i) => i.type),
            claireVisitState: claireClosed.visit.state,
          },
          reconcile: {
            engineLedgerImbalance: engineImbalance,
            engineReconcileOk: engineRec.ok,
            kernelReconcileOk: kernelRec.report.ok,
            checkedVisits: kernelRec.report.checked_visits,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (sseProbe) await sseProbe.close().catch(() => undefined);
    if (botRunner) await botRunner.stop().catch(() => undefined);
    for (const fn of closers.reverse()) await fn().catch(() => undefined);
    await kernel.close().catch(() => undefined);
    await harness.close({ cleanup: false }).catch(() => undefined);
    if (!values.keep) {
      rmSync(rootWorkDir, { recursive: true, force: true });
    }
  }
}

function mkdirSafe(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

main().catch((err) => {
  const cause = err && typeof err === 'object' && 'cause' in err ? ` | cause=${String((err as any).cause?.stack ?? (err as any).cause)}` : '';
  process.stderr.write(`city-m1-e2e 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}${cause}\n`);
  process.exit(1);
});
