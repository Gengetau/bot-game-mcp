#!/usr/bin/env node
/**
 * 灯都持续世界（M1）三方真实跨进程集成与故障重启验收脚本。
 *
 * 覆盖范围（严格隔离于临时目录，绝不触碰线上 city.db / town.db / life1.db / world.db）：
 *  1. 隔离护栏：town.enabled === false、/town/ 返回 404、桌面游戏（number_bomb）照常可用；
 *  2. 门禁与身份硬拦截：室友 QQ 侧密钥调 enter_world 返回 ENTRY_VIA_HOME_ONLY（F16），非白名单外部 Bot 返回 FORBIDDEN；
 *     hiwatari:ai-house:entrance 在公开视图、外部 Bot 视图、人类网页视图中均完全隐藏；
 *  3. 出门前雨伞规则（F13）：目的地降雨且妮娅无自有雨伞时，T1 冻结前即拒绝，零钱包/物品残留；
 *  4. 真实跨进程 T1 -> prepare -> commit -> T2 交接：注入 bridge503Count=2 + dropResponseOnce=true（F4），
 *     验证 Python world-kernel CityBridgeAdapter 原 request_id 退避重试 + GET /visits/:id 对账恢复，随身钱包只入账一次；
 *  5. 外部 Bot（M1-B CityClient + CityRunner）：首次入城 ¥200,000 启动金、多端 claim=false 只读旁观与 CityRunner 立即停写、
 *     显式 claim_control 递增 epoch 并使旧连接收到 CONTROL_LOST、书店购入明信片并前往镜池·喫茶「灯」；
 *  6. 人类玩家（M1-C/D 一次性票据 + /city/api/* 会话 + CSRF + SSE）：裁判 MCP city_issue_ticket 签发 #ticket= 链接、
 *     单次兑换防重放、缺省 CSRF 返回 403、SSE 实时流连通、从千灯站乘灯环线前往镜池·喫茶「灯」；
 *  7. 在途真实引擎冷启动重启（harness.restart）+ 内核进程重启（restart_kernel）：
 *     验证三方在途行程按持久化 scheduled_jobs 恢复到站、零重复扣车费、网页会话跨重启保留、CityRunner 自动重连；
 *  8. 同场三方交互（镜池·喫茶「灯」）：妮娅、外部 Bot「旅人一叶」、人类「阿澄」同场共处与对话，
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createIsolatedCityHarness } from '../packages/engine/test/city/test-harness.js';
import { ledgerImbalance, lockerItems, heldItems, runReconcile } from '../packages/engine/src/city/index.js';
import {
  BotGameClient,
  CityClient,
  CityClientError,
  CityRunner,
  type CityDecisionContext,
} from '../packages/agent-kit/src/index.js';

const RENAME_R0_PATH = fileURLToPath(new URL('../docs/city/rename-r0.json', import.meta.url));
const RENAME_R0_SPEC = JSON.parse(readFileSync(RENAME_R0_PATH, 'utf8')) as {
  forbidden_legacy_tokens_in_public_and_views: string[];
};
assert.equal(
  RENAME_R0_SPEC.forbidden_legacy_tokens_in_public_and_views.length,
  57,
  'docs/city/rename-r0.json 必须包含完整 57 项禁用旧词',
);
const FORBIDDEN_RUNTIME_TOKENS = Array.from(
  new Set([
    ...RENAME_R0_SPEC.forbidden_legacy_tokens_in_public_and_views,
    'ai-house:entrance',
    'hiwatari_entrance',
    'akabane_entrance',
    'house_entrance',
    '小屋门口',
  ]),
);

type ScanCategory = 'webAndSse' | 'publicOutputs' | 'externalBotViews' | 'kernelProjections';

class LegacyRuntimeScanner {
  readonly stats: Record<ScanCategory, { samples: number; bytes: number }> = {
    webAndSse: { samples: 0, bytes: 0 },
    publicOutputs: { samples: 0, bytes: 0 },
    externalBotViews: { samples: 0, bytes: 0 },
    kernelProjections: { samples: 0, bytes: 0 },
  };
  totalHits = 0;

  scan(
    category: ScanCategory,
    label: string,
    payload: unknown,
    opts: { allowBridgeHandoverNode?: boolean } = {},
  ): string {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    assert.ok(raw.length > 0, `运行时采样为空: [${category}] ${label}`);
    const sanitizedForScan = opts.allowBridgeHandoverNode
      ? raw.replaceAll('"handover_node":"hiwatari:ai-house:entrance"', '"handover_node":"<valid_handover_node>"')
      : raw;
    const lower = sanitizedForScan.toLowerCase();
    const hits = FORBIDDEN_RUNTIME_TOKENS.filter((tok) => lower.includes(tok.toLowerCase()));
    this.totalHits += hits.length;
    assert.deepEqual(
      hits,
      [],
      `运行时旧名/隐藏门口扫描命中禁用项 [${category}] ${label}: ${hits.join(', ')}`,
    );
    this.stats[category].samples += 1;
    this.stats[category].bytes += Buffer.byteLength(raw, 'utf8');
    return raw;
  }
}

/**
 * 内嵌只读加载 world-kernel/life1 的跨进程测试宿主（写入临时目录执行，无需污染内核源码目录）。
 */
const PYTHON_KERNEL_DRIVER_SOURCE = String.raw`import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sqlite3
import sys
import threading
import types

from worldkernel import city_projection, outings
from worldkernel.city_bridge import CityBridgeAdapter, DeterministicCityModel
from worldkernel.city_client import CityBridgeHttpClient
from worldkernel.kernel import Refused
from worldkernel.legacy import Projector, offline_world
from worldkernel.life import ROSTER, Life
from worldkernel.statuscard import cards
from worldkernel.store import Store, VirtualClock


class _WorldHttpServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def _make_world_http_handler(drv):
    class _Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def do_POST(self):
            parts = [p for p in self.path.split("?", 1)[0].strip("/").split("/") if p]
            if len(parts) != 3 or parts[0] != "world" or parts[2] != "now":
                self._send_json(404, {"error": "unknown"})
                return
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                _ = json.loads(raw or b"{}")
                payload = drv.serve_world_now(parts[1])
                self._send_json(200, payload)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)[:200]})
            except Exception as exc:
                self._send_json(503, {"error": f"{type(exc).__name__}: {exc}"})

        def _send_json(self, status, obj):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return _Handler


class Driver:
    def __init__(self, kernel_dir, shared_services_dir, work_dir, bridge_url, bridge_key, start_ms):
        self._lock = threading.RLock()
        self.kernel_dir = kernel_dir
        self.shared_services_dir = shared_services_dir
        self.work_dir = work_dir
        self.db_path = os.path.join(work_dir, "life1-e2e.db")
        self.world_db = os.path.join(work_dir, "world-e2e.db")
        os.environ["WORLD"] = "1"
        os.environ["WORLD_KERNEL"] = "authority"
        os.environ["WORLD_WEATHER"] = "0"
        os.environ["WORLD_DB"] = self.world_db
        os.environ["WORLD_SEED"] = os.path.join(work_dir, "world_seed.json")
        os.environ["WORLD_KERNEL_DB"] = self.db_path
        os.environ["WORLD_KERNEL_DIR"] = kernel_dir
        if shared_services_dir not in sys.path:
            sys.path.insert(0, shared_services_dir)
        import roster as shared_roster  # type: ignore
        import world as shared_world  # type: ignore

        self._shared_roster = shared_roster
        self._shared_world = shared_world
        self._shared_world.DB_PATH = self.world_db
        self._shared_world.WEATHER = False
        self._shared_world.init()
        offline_world(self.world_db)
        self.bridge_url = bridge_url
        self.bridge_key = bridge_key
        self.clock = VirtualClock(start_ms / 1000.0)
        self._boot_seq = 0
        self._allowed_actors = ("nia",)
        self._queued_actions = []
        self._arrival_go_home = False
        self._boot()
        with self.s.tx() as db:
            for a in ROSTER:
                self.k._set_actor(db, a, location="living", activity="idle", action_id=None)
            db.execute(
                "INSERT INTO resources(resource_id,kind,item,location,holder,qty,source)"
                " VALUES('nia_cookie_1','food','cookie',NULL,'nia',2,'e2e_seed')"
            )
        self.proj.run()
        self._http_server = _WorldHttpServer(("127.0.0.1", 0), _make_world_http_handler(self))
        self.world_http_url = f"http://127.0.0.1:{self._http_server.server_address[1]}"
        self.consumers = [r["consumer"] for r in self._shared_roster.ROSTER]
        self._http_thread = threading.Thread(target=self._http_server.serve_forever, daemon=True)
        self._http_thread.start()

    def serve_world_now(self, consumer):
        with self._lock:
            sw = self._shared_world
            prev_db = sw.DB_PATH
            prev_weather = sw.WEATHER
            prev_time = sw.time
            now_ts = float(self.clock.now())
            try:
                sw.DB_PATH = self.world_db
                sw.WEATHER = False
                fake_time = types.SimpleNamespace(
                    **{k: getattr(prev_time, k) for k in dir(prev_time) if not k.startswith("__")}
                )
                fake_time.time = lambda: now_ts
                sw.time = fake_time
                return sw.now_info(consumer)
            finally:
                sw.DB_PATH = prev_db
                sw.WEATHER = prev_weather
                sw.time = prev_time

    def _model_handler(self, ctx):
        # S1 正常路径：到店（wake.reason == arrived）即回家，且按人区分，不走全局 FIFO 队列
        if self._arrival_go_home and ((ctx.get("wake") or {}).get("reason") == "arrived"):
            return [{"type": "go_home"}]
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
        with self._lock:
            return self._handle_locked(cmd)

    def _handle_locked(self, cmd):
        op = cmd["op"]
        if op == "sync_projection":
            self.proj.run()
            return {"ok": True}

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

        if op == "life_step":
            # 与线上同一入口：Life.step() 内部依次跑 plans.sync / cog.advance_plans / 各 extension.step（含桥接适配器）
            self.life.step()
            return {"ok": True}

        if op == "enable_actor":
            self._allowed_actors = tuple(sorted(set(self._allowed_actors) | {cmd["actor"]}))
            self.adapter.enable_actor(cmd["actor"])
            return {"ok": True, "allowed": sorted(self.adapter.allowed_actors)}

        if op == "set_arrival_policy":
            self._arrival_go_home = bool(cmd.get("go_home", False))
            return {"ok": True, "go_home": self._arrival_go_home}

        if op == "submit":
            actor = cmd["actor"]
            res = self.k.submit(
                {
                    "idempotency_key": cmd["key"],
                    "principal": f"channel:{actor}",
                    "actor_id": actor,
                    "origin": "self",
                    "domain_epoch": self.k.city_visits.authority(actor)["domain_epoch"],
                    "action_type": cmd["action"],
                    "args": cmd["args"],
                }
            )
            return {"ok": True, "result": res}

        if op == "pending_invites":
            return {
                "ok": True,
                "pending": [
                    {"inv_id": p["inv_id"], "plan_id": p["plan_id"]}
                    for p in self.life.plans.pending_for(cmd["actor"])
                ],
            }

        if op == "plan_state":
            return {"ok": True, "state": self.life.plans.plan(cmd["plan_id"])["state"]}

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

        if op == "projection_snapshot":
            cards_out = self._cards()
            wr = sqlite3.connect(f"file:{self.world_db}?mode=ro", uri=True)
            wr.row_factory = sqlite3.Row
            try:
                reality_rows = [dict(r) for r in wr.execute("SELECT * FROM reality ORDER BY actor").fetchall()]
                kernel_cards = {
                    r["actor"]: json.loads(r["data"])
                    for r in wr.execute("SELECT actor, data FROM kernel_card ORDER BY actor").fetchall()
                }
            finally:
                wr.close()
            with self.s.read() as db:
                encounters = [dict(r) for r in db.execute("SELECT * FROM city_encounters ORDER BY rowid").fetchall()]
                direct_proj = {
                    a: city_projection.resolve_projection_conn(db, a, now=self.clock.now())
                    for a in ROSTER
                }
            redact_inputs = {
                "new_entrance": "hiwatari:ai-house:entrance",
                "old_entrance": "akabane:ai-house:entrance",
                "entrance_alias_new": "hiwatari_entrance",
                "entrance_alias_old": "akabane_entrance",
                "door_wording": "小屋门口（灯都绯渡西2-13-4 101号室 / 東京都北区赤羽西2-13-4 101号室）",
                "mixed_address": "从绯渡3丁目5番地与赤羽二丁目经 Hiwatari 2-13-4 / Akabane 1-2-3 返回",
                "benign_station": "绯渡站",
                "benign_venue": "在镜池·喫茶「灯」",
            }
            redact_samples = {k: city_projection.redact_text(v) for k, v in redact_inputs.items()}
            return {
                "ok": True,
                "cards": cards_out,
                "reality": reality_rows,
                "kernel_cards": kernel_cards,
                "direct_projections": direct_proj,
                "encounters": encounters,
                "redact_samples": redact_samples,
            }

        if op == "reconcile":
            return {"ok": True, "report": self.adapter.reconcile()}

        if op == "close":
            try:
                self._http_server.shutdown()
                self._http_server.server_close()
            except Exception:
                pass
            if self.s.epoch is not None:
                self.s.release()
            self.s.close()
            return {"ok": True}

        return {"ok": False, "error": f"unknown_op:{op}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kernel-dir", required=True)
    ap.add_argument("--shared-services-dir", required=True)
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--bridge-url", required=True)
    ap.add_argument("--bridge-key", required=True)
    ap.add_argument("--start-ms", type=int, required=True)
    args = ap.parse_args()
    drv = Driver(
        args.kernel_dir,
        args.shared_services_dir,
        args.work_dir,
        args.bridge_url,
        args.bridge_key,
        args.start_ms,
    )
    sys.stdout.write(
        json.dumps({"ready": True, "world_http_url": drv.world_http_url, "consumers": drv.consumers}) + "\n"
    )
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
  worldHttpUrl = '';
  consumers: string[] = [];

  async start(opts: {
    kernelDir: string;
    sharedServicesDir: string;
    workDir: string;
    bridgeUrl: string;
    bridgeKey: string;
    startMs: number;
  }): Promise<void> {
    const driverScript = join(opts.workDir, 'city_e2e_driver.py');
    writeFileSync(driverScript, PYTHON_KERNEL_DRIVER_SOURCE, 'utf8');
    this.proc = spawn(
      'python3',
      [
        '-B',
        '-u',
        driverScript,
        '--kernel-dir',
        opts.kernelDir,
        '--shared-services-dir',
        opts.sharedServicesDir,
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
          this.worldHttpUrl = String(msg.world_http_url ?? '');
          this.consumers = Array.isArray(msg.consumers) ? msg.consumers.map(String) : [];
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
      'shared-services-dir': { type: 'string' },
      scenario: { type: 'string', default: 'full' },
      keep: { type: 'boolean', default: false },
    },
  });
  if (values.scenario !== 'full' && values.scenario !== 's1-normal') {
    throw new Error(`未知 --scenario=${String(values.scenario)}（可选 full | s1-normal）`);
  }
  const kernelDir = resolve(values['kernel-dir'] ?? process.env.WORLD_KERNEL_DIR ?? '/mcp-wt/world-kernel');
  const sharedServicesDir = resolve(
    values['shared-services-dir'] ?? process.env.SHARED_SERVICES_DIR ?? join(kernelDir, '..', 'shared-services'),
  );
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
  const scanner = new LegacyRuntimeScanner();

  const advanceBoth = async (ms: number) => {
    harness.advance(ms);
    await kernel.call({ op: 'sync_clock', now_ms: harness.clock.t });
  };

  const fetchWorldNow = async (consumer: string, stageLabel: string): Promise<Record<string, any>> => {
    await kernel.call({ op: 'sync_projection' });
    const resp = await fetch(`${kernel.worldHttpUrl}/world/${consumer}/now`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(resp.status, 200, `POST /world/${consumer}/now (${stageLabel}) 应返回 200`);
    const raw = await resp.text();
    scanner.scan('kernelProjections', `POST /world/${consumer}/now (${stageLabel})`, raw);
    return JSON.parse(raw) as Record<string, any>;
  };

  try {
    await kernel.start({
      kernelDir,
      sharedServicesDir,
      workDir: kernelWorkDir,
      bridgeUrl: harness.bridgeUrl,
      bridgeKey: harness.bridgeKey,
      startMs: harness.clock.t,
    });
    assert.ok(kernel.worldHttpUrl.startsWith('http://127.0.0.1:'), '隔离 /world/{consumer}/now HTTP 服务应已就绪');
    assert.deepEqual(
      [...kernel.consumers].sort(),
      ['alicia', 'claire', 'grok', 'mio', 'whale', 'xingli'],
      'shared-services consumer 列表应完整覆盖六位室友',
    );

    if (values.scenario === 's1-normal') {
      await runS1Normal({ harness, kernel, scanner, advanceBoth, fetchWorldNow });
      return;
    }

    // ── 1. 隔离护栏与桌面游戏不受影响 ──
    assert.equal(harness.config.town.enabled, false);
    const health = await (await fetch(`${harness.baseUrl}/health`)).json() as Record<string, any>;
    assert.equal(health.ok, true);
    assert.equal(health.town_enabled, false);
    assert.equal(health.city_enabled, true);

    const townResp = await fetch(`${harness.baseUrl}/town/`);
    assert.equal(townResp.status, 404, 'town.enabled=false 时 /town/ 必须返回 404');

    const cityPage = await fetch(`${harness.baseUrl}/city/`);
    assert.equal(cityPage.status, 200);
    const cityPageHtml = await cityPage.text();
    assert.match(cityPageHtml, /灯都/);
    scanner.scan('webAndSse', 'GET /city/', cityPageHtml);
    scanner.scan('publicOutputs', 'GET /city/ HTML', cityPageHtml);

    const playNoSlash = await fetch(`${harness.baseUrl}/city/play`, { redirect: 'manual' });
    assert.equal(playNoSlash.status, 302);
    assert.equal(playNoSlash.headers.get('location'), '/city/play/');

    const playPage = await fetch(`${harness.baseUrl}/city/play/`);
    assert.equal(playPage.status, 200);
    assert.match(String(playPage.headers.get('content-security-policy')), /script-src 'self'/);
    scanner.scan('webAndSse', 'GET /city/play/', await playPage.text());

    for (const assetPath of ['/city/play/app.js', '/city/play/style.css', '/city/play/icon.svg', '/city/api/config']) {
      const assetResp = await fetch(`${harness.baseUrl}${assetPath}`);
      assert.equal(assetResp.status, 200, `GET ${assetPath} 应返回 200`);
      const assetText = await assetResp.text();
      scanner.scan('webAndSse', `GET ${assetPath}`, assetText);
      if (assetPath === '/city/api/config') {
        scanner.scan('publicOutputs', 'GET /city/api/config raw JSON', assetText);
      }
    }
    const initRouteResp = await fetch(`${harness.baseUrl}/city/api/route?from=hiwatari:station&to=sentou:station`);
    assert.equal(initRouteResp.status, 200);
    scanner.scan('publicOutputs', 'GET /city/api/route raw JSON', await initRouteResp.text());

    // 桥接 L3 管理面（docs/city/rename-r0.json bridge_l3_note）：除 handover_node 合法为 hiwatari:ai-house:entrance 外，其余旧词/旧编号零命中
    const bridgeCatalogResp = await fetch(`${harness.bridgeUrl}/catalog`, {
      headers: { authorization: `Bearer ${harness.bridgeKey}` },
    });
    assert.equal(bridgeCatalogResp.status, 200);
    const bridgeCatalogRaw = await bridgeCatalogResp.text();
    const bridgeCatalogJson = JSON.parse(bridgeCatalogRaw) as Record<string, any>;
    assert.equal(bridgeCatalogJson.handover_node, 'hiwatari:ai-house:entrance');
    scanner.scan('publicOutputs', 'GET /city/bridge/v1/catalog (L3)', bridgeCatalogRaw, {
      allowBridgeHandoverNode: true,
    });
    const bridgeWeatherResp = await fetch(`${harness.bridgeUrl}/weather`, {
      headers: { authorization: `Bearer ${harness.bridgeKey}` },
    });
    assert.equal(bridgeWeatherResp.status, 200);
    scanner.scan('publicOutputs', 'GET /city/bridge/v1/weather (L3)', await bridgeWeatherResp.text());

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
    scanner.scan('publicOutputs', 'MCP world_query(public) via house QQ key', pubFromNiaQq);

    const rawMcpProbe = new Client({ name: 'city-r0-mcp-surface-probe', version: '0.2.0' });
    await rawMcpProbe.connect(
      new StreamableHTTPClientTransport(new URL(harness.mcpUrl), {
        requestInit: { headers: { Authorization: 'Bearer test_only_ext_bot_key_city_90001' } },
      }),
    );
    closers.push(() => rawMcpProbe.close());
    scanner.scan('publicOutputs', 'MCP listTools', await rawMcpProbe.listTools());
    scanner.scan('publicOutputs', 'MCP resource botgame://guide/city', await rawMcpProbe.readResource({ uri: 'botgame://guide/city' }));
    scanner.scan('publicOutputs', 'MCP resource botgame://guide/overview', await rawMcpProbe.readResource({ uri: 'botgame://guide/overview' }));
    scanner.scan('publicOutputs', 'MCP prompt city-resident', await rawMcpProbe.getPrompt({ name: 'city-resident' }));

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
    harness.setAreaRain({ kagamiike: true });
    const rainRefused = await kernel.call(
      { op: 'depart', actor: 'nia', destination: 'kagamiike:kissa-tomoshibi', carry_yen: 20_000 },
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
    harness.setAreaRain({ hiwatari: false, kagamiike: false, sentou: false });
    const dep1 = await kernel.call({
      op: 'depart',
      actor: 'nia',
      destination: 'kagamiike:kissa-tomoshibi',
      carry_yen: 20_000,
      carry_items: [{ resource_id: 'nia_cookie_1', qty: 1 }],
      visit_id: 'vis_m1_e2e_1',
    });
    assert.equal(dep1.visit.state, 'preparing');
    const projPreparing = await kernel.call({ op: 'projection_snapshot' });
    assert.match(String(projPreparing.direct_projections?.nia?.place ?? ''), /镜池/, 'preparing 阶段内核投影应显示新片区中文名「镜池」');
    scanner.scan('kernelProjections', 'kernel projection_snapshot (nia preparing)', projPreparing);
    const nowMioPreparing = await fetchWorldNow('mio', 'nia preparing');
    assert.match(String(nowMioPreparing.text ?? ''), /外出中/, '/world/mio/now preparing 阶段应显示外出中');
    assert.match(String(nowMioPreparing.text ?? ''), /镜池/, '/world/mio/now preparing 阶段应显示新片区中文名「镜池」');
    await advanceBoth(60_000); // 妮娅从客厅走到玄关 away（60s）

    // 注入桥接 503 RECOVERING x2 + 提交后丢回包（F4），验证 prepare/commit 幂等恢复且只入账一次
    harness.faults.bridge503Count = 2;
    harness.faults.dropResponseOnce = true;
    const hand1 = await kernel.call({ op: 'advance_handover', visit_id: 'vis_m1_e2e_1' });
    assert.equal(hand1.visit.state, 'active');
    assert.equal(hand1.visit.domain_epoch, 1);
    assert.equal(harness.faults.bridge503Count, 0);
    assert.equal(harness.faults.dropResponseOnce, false);
    await kernel.call({ op: 'poll_outbox' });
    scanner.scan('kernelProjections', 'kernel projection_snapshot (nia handed over / in-transit)', await kernel.call({ op: 'projection_snapshot' }));
    const nowMioTransit = await fetchWorldNow('mio', 'nia handed over / in-transit');
    assert.match(String(nowMioTransit.text ?? ''), /外出中/, '/world/mio/now 在途阶段应显示外出中');

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
      entry: 'kagamiike:station',
    });
    assert.equal(enterB1.created, true);
    assert.equal(enterB1.granted_yen, 200_000);
    assert.deepEqual(enterB1.control, { epoch: 1, mine: true });
    scanner.scan('externalBotViews', 'botB1 enter_world', enterB1);
    const initResidentsFromBot = await botB1.query('residents');
    assert.ok(
      Array.isArray(initResidentsFromBot.residents) &&
        initResidentsFromBot.residents.some((r: any) => r.name === '旅人一叶'),
      'MCP world_query(residents) 应返回当前在城居民目录',
    );
    scanner.scan('publicOutputs', 'MCP world_query(residents) via botB1 (in-transit)', initResidentsFromBot);
    scanner.scan('publicOutputs', 'MCP world_query(route) via botB1', await botB1.query('route', { from: 'hiwatari:station', to: 'sentou:station' }));
    scanner.scan('publicOutputs', 'MCP world_query(stamps) via botB1', await botB1.query('stamps'));
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
    scanner.scan('externalBotViews', 'botB2 enter_world(claim=false)', enterB2);

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
    scanner.scan('externalBotViews', 'botB2/botB1 claim_control', { claimed2, claimed1 });

    // 启动正式 CityRunner 驱动外部 Bot：先去书店「栞堂」买明信片，再步行去喫茶「灯」，收到曲奇后回赠明信片
    let botGiftedNia = false;
    let botHeadedToCafe = false;
    let botRunnerSampledGreeting = false;
    let botBCurrent = botB1;
    const runnerLogs: string[] = [];
    botRunner = new CityRunner({
      minIntervalMs: 0,
      debounceMs: 20,
      debounceMaxMs: 60,
      urgentDebounceMs: 80,
      waitSeconds: 1,
      reconnectBaseMs: 30,
      reconnectMaxMs: 200,
      log: (line) => runnerLogs.push(line),
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
        const rawCtx = scanner.scan(
          'externalBotViews',
          `CityRunner wake (${ctx.view.here?.place.id ?? 'in_transit'})`,
          { view: ctx.view, events: ctx.events },
        );
        if (rawCtx.includes('刚从千灯坐灯环线过来')) {
          botRunnerSampledGreeting = true;
        }
        const placeId = ctx.view.here?.place.id;
        const hasPostcard = ctx.view.items.some((i) => i.type === 'postcard' && i.qty > 0);
        const hasCookieFromNia = ctx.view.items.some((i) => i.type === 'cookie' && i.qty > 0);
        if (placeId === 'kagamiike:station' && !hasPostcard) {
          return { actions: [{ type: 'travel', to: 'kagamiike:shiorido' }] };
        }
        if (placeId === 'kagamiike:shiorido' && !hasPostcard) {
          botHeadedToCafe = true;
          return {
            actions: [
              { type: 'buy', sku: 'postcard', qty: 2 },
              { type: 'travel', to: 'kagamiike:kissa-tomoshibi' },
            ],
          };
        }
        if (placeId === 'kagamiike:kissa-tomoshibi' && hasCookieFromNia && !botGiftedNia) {
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
      body: JSON.stringify({ name: '阿澄', entry: 'sentou:station', client_id: 'human-web-1' }),
    });
    assert.equal(noCsrfResp.status, 403, '缺少 x-city-csrf 必须返回 403');

    // 正常入城（落点千灯站，发放 ¥200,000）
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
        entry: 'sentou:station',
        client_id: 'human-web-1',
      }),
    });
    assert.equal(humanEnterResp.status, 200);
    const humanEnterRaw = await humanEnterResp.text();
    scanner.scan('webAndSse', 'POST /city/api/enter', humanEnterRaw);
    const humanEnter = JSON.parse(humanEnterRaw) as Record<string, any>;
    assert.equal(humanEnter.created, true);
    assert.equal(humanEnter.granted_yen, 200_000);
    const humanResidentId = String(humanEnter.resident_id);

    // 连接人类 SSE 流并发起从千灯前往镜池·喫茶「灯」的电车行程（10m 灯环线 ¥200 + 6m 步行）
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
        action: { type: 'travel', to: 'kagamiike:kissa-tomoshibi' },
      }),
    });
    assert.equal(humanTravelResp.status, 200);
    scanner.scan('webAndSse', 'POST /city/api/act (travel)', await humanTravelResp.text());

    // ── 6. 三方在途推进 + 真实引擎冷启动崩溃重启（F7 / F10） ──
    // 按 <10m 在场租约分三段推进至 t+24m（旅人一叶与阿澄定时续心跳，妮娅在北环快线/镜池步行途中）
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
    scanner.scan('webAndSse', 'SSE /city/api/stream phase-1 (in-transit)', sseProbe.lines.join('\n'));
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
    const humanMeAfterRestartRaw = await (
      await fetch(`${harness.baseUrl}/city/api/me?client_id=human-web-1`, {
        headers: { cookie: humanSessionHeader },
      })
    ).text();
    scanner.scan('webAndSse', 'GET /city/api/me (after cold restart)', humanMeAfterRestartRaw);
    const humanMeAfterRestart = JSON.parse(humanMeAfterRestartRaw) as Record<string, any>;
    assert.equal(humanMeAfterRestart.here?.place?.id, 'kagamiike:kissa-tomoshibi');
    assert.equal(humanMeAfterRestart.wallet?.yen, 199_800, '跨引擎重启后灯环线车费严禁二次扣款');
    assert.ok(!JSON.stringify(humanMeAfterRestart).includes('ai-house:entrance'), '人类视图严禁暴露小屋交接点');

    // CityRunner 在引擎断连后自动调用 reconnect() 重建 MCP 连接并恢复事件循环
    await waitFor(
      () => botBCurrent !== botB1,
      `CityRunner 跨引擎重启自动建立新 MCP 连接 (status=${botHandle.status}, logs=${runnerLogs.join(' | ')})`,
      35_000,
    );
    await waitFor(() => botHandle.status === 'running', 'CityRunner 重连后保持 running');
    const botViewAtCafe = await botBCurrent.view();
    assert.equal(botViewAtCafe.here?.place.id, 'kagamiike:kissa-tomoshibi');
    assert.ok(!JSON.stringify(botViewAtCafe).includes('ai-house:entrance'), '外部 Bot 视图严禁暴露小屋交接点');
    scanner.scan('externalBotViews', 'botBCurrent.view() at kagamiike:kissa-tomoshibi (pre-chat)', botViewAtCafe);

    // ── 7. 三方在镜池·喫茶「灯」真实同场交互 ──
    const pubAtCafeRaw = await (await fetch(`${harness.baseUrl}/city/api/public`)).text();
    scanner.scan('publicOutputs', 'GET /city/api/public (3-party co-present)', pubAtCafeRaw);
    const pubAtCafe = JSON.parse(pubAtCafeRaw) as Record<string, any>;
    const kagArea = (pubAtCafe.areas as any[]).find((a) => a.id === 'kagamiike');
    const cafePlace = (kagArea.places as any[]).find((p) => p.id === 'kagamiike:kissa-tomoshibi');
    const cafeNames = (cafePlace.here as any[]).map((x) => x.name).sort();
    assert.deepEqual(cafeNames, ['妮娅', '旅人一叶', '阿澄'].sort(), '三类玩家必须在镜池·喫茶「灯」同场共处');

    // 人类玩家「阿澄」率先现场搭话（触发妮娅 heard_chat 唤醒）+ 买皇家奶茶（重发同一 request_id 验证幂等不重复扣费）
    const humanGreetingText = '下午好！我刚从千灯坐灯环线过来，这里的咖啡好香。';
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
        action: { type: 'say', text: humanGreetingText },
      }),
    });
    assert.equal(humanSayResp.status, 200);
    const humanSayRaw = await humanSayResp.text();
    scanner.scan('webAndSse', 'POST /city/api/act (say greeting)', humanSayRaw);
    await waitFor(
      () => botRunnerSampledGreeting,
      '外部 Bot CityRunner world_wait 事件流实时采入阿澄改名后的千灯/灯环线问候',
    );
    scanner.scan(
      'externalBotViews',
      'botBCurrent.view() right after human greeting',
      await botBCurrent.view(),
    );

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
    scanner.scan('webAndSse', 'POST /city/api/act (buy milk_tea + idempotent replay)', { buyTea1, buyTea2 });

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

    // 校验人类 SSE 完整收到妮娅与旅人一叶两条同场聊天推送，且人类网页/聊天历史与外部 Bot 视图均已采入阿澄改名后的问候语
    await waitFor(
      () =>
        sseProbe!.lines.some((l) => l.includes('煤油灯')) &&
        sseProbe!.lines.some((l) => l.includes('明信片')),
      '人类 SSE 完整收到妮娅与旅人一叶两条同场聊天推送',
    );
    const ssePhase2Raw = sseProbe.lines.join('\n');
    scanner.scan('webAndSse', 'SSE /city/api/stream phase-2 (co-present chat)', ssePhase2Raw);

    const humanMeAfterChatRaw = await (
      await fetch(`${harness.baseUrl}/city/api/me?client_id=human-web-1`, {
        headers: { cookie: humanSessionHeader },
      })
    ).text();
    assert.ok(
      humanMeAfterChatRaw.includes('刚从千灯坐灯环线过来') &&
        humanMeAfterChatRaw.includes('煤油灯') &&
        humanMeAfterChatRaw.includes('明信片'),
      '人类 /city/api/me 实时视图必须完整包含三方改名后同场对话',
    );
    scanner.scan('webAndSse', 'GET /city/api/me (with 3-party chat)', humanMeAfterChatRaw);

    const humanChatHistoryResp = await fetch(`${harness.baseUrl}/city/api/history`, {
      headers: { cookie: humanSessionHeader },
    });
    assert.equal(humanChatHistoryResp.status, 200);
    const humanChatHistoryRaw = await humanChatHistoryResp.text();
    assert.ok(humanChatHistoryRaw.includes('刚从千灯坐灯环线过来'), 'GET /city/api/history 必须采入改名后的千灯/灯环线台词');
    scanner.scan('webAndSse', 'GET /city/api/history (co-present history)', humanChatHistoryRaw);

    const humanStampsResp = await fetch(`${harness.baseUrl}/city/api/stamps`, {
      headers: { cookie: humanSessionHeader },
    });
    assert.equal(humanStampsResp.status, 200);
    scanner.scan('webAndSse', 'GET /city/api/stamps', await humanStampsResp.text());

    const botViewAfterChat = await botBCurrent.view();
    scanner.scan(
      'externalBotViews',
      'botBCurrent.view() at kagamiike:kissa-tomoshibi (post-chat)',
      botViewAfterChat,
    );
    assert.equal(botRunnerSampledGreeting, true, '外部 Bot 事件流必须已采入阿澄改名后的问候');

    const coPresentResidents = await botBCurrent.query('residents');
    assert.deepEqual(
      (coPresentResidents.residents as any[]).map((x) => x.name).sort(),
      ['妮娅', '旅人一叶', '阿澄'].sort(),
      'MCP world_query(residents) 必须完整返回同场三方居民且不暴露隐藏门口',
    );
    scanner.scan('publicOutputs', 'MCP world_query(residents) via botBCurrent (3-party co-present)', coPresentResidents);

    const botHistoryAtCafe = await botBCurrent.query('history');
    assert.ok(
      JSON.stringify(botHistoryAtCafe).includes('刚从千灯坐灯环线过来'),
      'MCP world_query(history) 必须包含阿澄改名后的千灯/灯环线台词',
    );
    scanner.scan('externalBotViews', 'MCP world_query(history) via botBCurrent (co-present)', botHistoryAtCafe);

    const projAtCafe = await kernel.call({ op: 'projection_snapshot' });
    assert.match(
      String(projAtCafe.direct_projections?.nia?.place ?? ''),
      /镜池/,
      '同场活动期内核投影必须使用新片区名「镜池」',
    );
    assert.equal(projAtCafe.redact_samples?.new_entrance, '绯渡一带');
    assert.equal(projAtCafe.redact_samples?.old_entrance, '绯渡一带');
    assert.equal(projAtCafe.redact_samples?.benign_station, '绯渡站');
    assert.equal(projAtCafe.redact_samples?.benign_venue, '在镜池·喫茶「灯」');
    scanner.scan('kernelProjections', 'kernel projection_snapshot (nia active at cafe)', projAtCafe);
    scanner.scan('kernelProjections', 'city_projection.redact_text output', projAtCafe.redact_samples);
    const nowMioAtCafe = await fetchWorldNow('mio', 'nia active at cafe');
    assert.match(String(nowMioAtCafe.text ?? ''), /外出中/, '/world/mio/now 同场阶段应显示外出中');
    assert.match(String(nowMioAtCafe.text ?? ''), /在镜池·喫茶「灯」/, '/world/mio/now 同场阶段应显示在镜池·喫茶「灯」');

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
    scanner.scan('kernelProjections', 'kernel projection_snapshot (nia closed)', await kernel.call({ op: 'projection_snapshot' }));
    const nowMioClosed = await fetchWorldNow('mio', 'nia closed');
    assert.doesNotMatch(String(nowMioClosed.text ?? ''), /外出中/, '/world/mio/now 返家结案后不应残留外出中');

    // ── 9. 全员放行（enable_all）+ 无挂单储物柜留存直接 closed 验收（claire 第二次访问） ──
    const enabled = await kernel.call({ op: 'enable_all' });
    assert.equal(enabled.allowed.length, 6);

    const dep2 = await kernel.call({
      op: 'depart',
      actor: 'claire',
      destination: 'kagamiike:shiorido',
      carry_yen: 5_000,
      visit_id: 'vis_m1_e2e_2',
    });
    assert.equal(dep2.visit.state, 'preparing');
    await advanceBoth(60_000);
    const hand2 = await kernel.call({ op: 'advance_handover', visit_id: 'vis_m1_e2e_2' });
    assert.equal(hand2.visit.state, 'active');
    await advanceBoth(35 * 60_000); // 抵达镜池·书店「栞堂」
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
    scanner.scan('kernelProjections', 'kernel projection_snapshot (claire closed / final)', await kernel.call({ op: 'projection_snapshot' }));
    for (const consumer of kernel.consumers) {
      const nowFinal = await fetchWorldNow(consumer, `final all-consumers (${consumer})`);
      assert.doesNotMatch(String(nowFinal.text ?? ''), /外出中/, `/world/${consumer}/now 终态不应残留外出中`);
    }

    for (const [cat, stat] of Object.entries(scanner.stats)) {
      assert.ok(stat.samples >= 3, `扫描类别 ${cat} 采样数不足: ${stat.samples}`);
    }
    assert.equal(scanner.totalHits, 0);

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
          coPresentAt: 'kagamiike:kissa-tomoshibi',
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
          legacyRuntimeScan: {
            forbiddenTokenCount: FORBIDDEN_RUNTIME_TOKENS.length,
            totalHits: scanner.totalHits,
            renamedHumanChatSampledInWebAndBot: true,
            sseCoPresentMessagesSampled: true,
            worldNowHttpEndpointSampled: true,
            mcpWorldQueryResidentsSampled: true,
            redactTextOutputSampled: true,
            bridgeL3CatalogAndWeatherSampled: true,
            categories: scanner.stats,
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

/**
 * #279 补测：正常无故障 S1（真实引擎 + 真实内核，同一进程组）。
 * 与 full 场景互相独立：自己的 harness / 内核库，不碰已审的故障变体。
 * 流程：真实 invite -> respond_invite 确认 -> 到点只靠 Life.step() 自动 T1（¥20,000 + 自动带的映射曲奇）
 *   -> prepare/commit 到引擎 active -> 到店 -> 回家 -> T3/release -> 计划 done -> 曲奇原样返家 -> 双侧对账。
 * S1_NEG=engine-reject：让引擎对所有 POST 回 503，场景必须在「引擎侧 active」断言处变红（反向验证）。
 */
async function runS1Normal(ctx: {
  harness: Awaited<ReturnType<typeof createIsolatedCityHarness>>;
  kernel: KernelDriver;
  scanner: LegacyRuntimeScanner;
  advanceBoth: (ms: number) => Promise<void>;
  fetchWorldNow: (consumer: string, stageLabel: string) => Promise<Record<string, any>>;
}): Promise<void> {
  const { harness, kernel, scanner, advanceBoth, fetchWorldNow } = ctx;
  const negative = process.env.S1_NEG === 'engine-reject';
  const parseJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
  const engineVisit = (vid: string) =>
    harness.city.db.get<Record<string, any>>('SELECT * FROM visits WHERE visit_id = ?', vid);
  const engineCookieRows = () =>
    harness.city.db.all<Record<string, any>>(
      "SELECT item_id, owner_id, type, quantity, instance, origin_ref, state, visit_id FROM items WHERE origin_ref = 'nia_cookie_1'",
    );

  harness.setAreaRain({ hiwatari: false, kagamiike: false, sentou: false });
  assert.equal((await kernel.call({ op: 'enable_actor', actor: 'claire' })).allowed.includes('claire'), true);
  await kernel.call({ op: 'set_arrival_policy', go_home: true });

  // ── 0. 起点：钱全可用、没有任何外出记录、家里 2 份曲奇 ──
  const nia0 = await kernel.call({ op: 'inspect', actor: 'nia' });
  const initialWallet = Number(nia0.wallet_balance);
  assert.equal(nia0.wallet_available, initialWallet);
  assert.equal(nia0.holds.length, 0);
  assert.equal(nia0.authority.domain, 'home');
  assert.equal(nia0.visit, null);
  assert.equal((nia0.foods as any[]).find((f) => f.resource_id === 'nia_cookie_1')?.qty, 2);
  assert.equal(harness.city.db.scalar('SELECT COUNT(*) FROM visits'), 0);
  const claire0 = await kernel.call({ op: 'inspect', actor: 'claire' });
  const claireInitialWallet = Number(claire0.wallet_balance);

  // ── 1. 真实邀约：妮娅发起 -> 克蕾雅答应；确认前后都不应有任何外出/携带记录（不直接 depart、不直接插计划） ──
  const startAtS = Math.floor(harness.clock.t / 1000) + 600;
  const inv = await kernel.call({
    op: 'submit',
    actor: 'nia',
    key: 's1n:inv',
    action: 'invite',
    args: { to: ['claire'], kind: 'outing', what: 'cafe_time', location: 'place:kagamiike', start_at: startAtS, end_at: startAtS + 6600 },
  });
  assert.equal(inv.result.status, 'succeeded', JSON.stringify(inv.result));
  const planId = String(inv.result.plan_id);
  const pending = ((await kernel.call({ op: 'pending_invites', actor: 'claire' })).pending as any[]).filter(
    (p) => p.plan_id === planId,
  );
  assert.equal(pending.length, 1, '克蕾雅应收到恰好一份对应邀约');
  const ans = await kernel.call({
    op: 'submit',
    actor: 'claire',
    key: 's1n:yes',
    action: 'respond_invite',
    args: { inv_id: pending[0].inv_id, answer: 'yes' },
  });
  assert.equal(ans.result.status, 'succeeded', JSON.stringify(ans.result));
  assert.equal((await kernel.call({ op: 'plan_state', plan_id: planId })).state, 'confirmed');
  assert.equal(harness.city.db.scalar('SELECT COUNT(*) FROM visits'), 0, '确认邀约本身不得让引擎出现访问');
  assert.equal((await kernel.call({ op: 'inspect', actor: 'nia' })).visit, null);
  assert.equal((await kernel.call({ op: 'inspect', actor: 'nia' })).wallet_available, initialWallet);

  // ── 2. start_at 之前不出门；之后只靠 Life.step() 自动 T1 ──
  await advanceBoth(300_000);
  await kernel.call({ op: 'life_step' });
  assert.equal((await kernel.call({ op: 'inspect', actor: 'nia' })).visit, null, 'start_at 之前不得出门');
  assert.equal(harness.city.db.scalar('SELECT COUNT(*) FROM visits'), 0);
  if (negative) harness.faults.bridge503Count = 1_000_000; // 反向验证：引擎拒收所有 POST
  await advanceBoth(300_000);
  let niaVisitId = '';
  let claireVisitId = '';
  for (let i = 0; i < 4 && !(niaVisitId && claireVisitId); i++) {
    await kernel.call({ op: 'life_step' });
    niaVisitId = String((await kernel.call({ op: 'inspect', actor: 'nia' })).visit?.visit_id ?? '');
    claireVisitId = String((await kernel.call({ op: 'inspect', actor: 'claire' })).visit?.visit_id ?? '');
    if (!(niaVisitId && claireVisitId)) await advanceBoth(60_000);
  }
  assert.ok(niaVisitId && claireVisitId, '到点后 Life.step() 应自动为两人建立外出访问');
  assert.notEqual(niaVisitId, claireVisitId);

  // ── 3. T1（内核侧）：同一 plan_id，¥20,000 预留，自动带 1 份映射曲奇 ──
  const niaT1 = await kernel.call({ op: 'inspect', actor: 'nia', visit_id: niaVisitId });
  assert.equal(niaT1.visit.plan.destination, 'kagamiike:kissa-tomoshibi');
  assert.equal(niaT1.carry.plan_id, planId);
  assert.equal(niaT1.carry.actor_id, 'nia');
  assert.equal(Number(niaT1.carry.carry_yen), 20_000);
  const carryItems = parseJson(niaT1.carry.carry_items) as any[];
  assert.deepEqual(
    carryItems.map((i) => i.ref),
    ['nia_cookie_1'],
    `自动携带物应恰为 1 份映射曲奇: ${JSON.stringify(carryItems)}`,
  );

  // ── 4. prepare -> commit：引擎侧必须真的接受（active）并持有这份曲奇 ──
  for (let i = 0; i < 6; i++) {
    if (engineVisit(niaVisitId)?.state === 'active' && engineVisit(claireVisitId)?.state === 'active') break;
    await advanceBoth(60_000);
    await kernel.call({ op: 'life_step' });
  }
  const engNiaActive = engineVisit(niaVisitId);
  assert.equal(engNiaActive?.state, 'active', `引擎应接受自动 T1 的访问并进入 active，实际 ${engNiaActive?.state ?? '无此访问行'}`);
  assert.equal(engineVisit(claireVisitId)?.state, 'active');
  assert.equal(Number(engNiaActive.carry_yen), 20_000);
  assert.ok(String(engNiaActive.carry_items_json).includes('nia_cookie_1'), `引擎收到的携带物应含映射曲奇: ${engNiaActive.carry_items_json}`);
  assert.equal(engNiaActive.domain_epoch, 1);
  const cookiesActive = engineCookieRows();
  assert.equal(cookiesActive.length, 1, '引擎侧应恰有 1 件来源为 nia_cookie_1 的实例');
  assert.equal(cookiesActive[0]!.state, 'held');
  assert.equal(cookiesActive[0]!.visit_id, niaVisitId);
  assert.equal(cookiesActive[0]!.type, 'cookie');
  assert.equal(cookiesActive[0]!.instance, 1);
  assert.equal(cookiesActive[0]!.quantity, 1);
  const niaActive = await kernel.call({ op: 'inspect', actor: 'nia', visit_id: niaVisitId });
  assert.equal(niaActive.authority.domain, 'city');
  assert.equal(niaActive.authority.domain_epoch, 1);
  assert.equal(niaActive.wallet_available, initialWallet - 20_000);
  scanner.scan('kernelProjections', 'S1-normal projection_snapshot (active)', await kernel.call({ op: 'projection_snapshot' }));
  const nowActive = await fetchWorldNow('mio', 'S1-normal active');
  assert.match(String(nowActive.text ?? ''), /外出中/);

  // ── 5. 在途 -> 到店 -> 脚本回家 -> 引擎结算 -> 内核 T3 + release；只用 Life.step() 推进 ──
  let closed = false;
  for (let i = 0; i < 36 && !closed; i++) {
    await advanceBoth(5 * 60_000);
    await kernel.call({ op: 'life_step' });
    closed =
      (await kernel.call({ op: 'inspect', actor: 'nia', visit_id: niaVisitId })).visit.state === 'closed' &&
      (await kernel.call({ op: 'inspect', actor: 'claire', visit_id: claireVisitId })).visit.state === 'closed';
  }
  assert.ok(closed, '3 小时内两人的访问应在两侧都收敛到 closed');
  await kernel.call({ op: 'life_step' });

  // ── 6. 收尾核对：计划 done、权威域回家、曲奇原样返家、钱只花了来回车费 ──
  assert.equal((await kernel.call({ op: 'plan_state', plan_id: planId })).state, 'done');
  const niaEnd = await kernel.call({ op: 'inspect', actor: 'nia', visit_id: niaVisitId });
  assert.equal(niaEnd.authority.domain, 'home');
  assert.equal(niaEnd.authority.domain_epoch, 2);
  assert.equal(niaEnd.holds.length, 0);
  assert.equal(niaEnd.wallet_balance, initialWallet - 400, '只应花掉来回车费 2×¥200');
  assert.equal(niaEnd.wallet_available, initialWallet - 400);
  const claireEnd = await kernel.call({ op: 'inspect', actor: 'claire', visit_id: claireVisitId });
  assert.equal(claireEnd.wallet_balance, claireInitialWallet - 400);
  assert.equal((niaEnd.foods as any[]).find((f) => f.resource_id === 'nia_cookie_1')?.qty, 2, '曲奇未消费、数量原样');
  assert.equal(Number(niaEnd.carry.release_confirmed), 1);
  assert.deepEqual(parseJson(niaEnd.carry.locker_items) ?? [], []);
  const engNiaEnd = engineVisit(niaVisitId)!;
  assert.equal(engNiaEnd.state, 'closed');
  assert.equal(Number(engNiaEnd.purse_final_yen), 20_000 - 400, '引擎随身钱包结算 = 携带 − 来回车费');
  assert.equal(engineVisit(claireVisitId)?.state, 'closed');
  const cookiesEnd = engineCookieRows();
  assert.equal(cookiesEnd.length, 1);
  assert.equal(cookiesEnd[0]!.state, 'returned', '引擎侧曲奇应标记 returned（回家），而不是 locker/disposed/被送出');
  assert.equal(cookiesEnd[0]!.visit_id, niaVisitId);
  const niaResidentId = harness.city.db.get<{ resident_id: string }>(
    "SELECT resident_id FROM house_members WHERE actor_id = 'nia'",
  )!.resident_id;
  assert.equal(lockerItems(harness.city, niaResidentId).length, 0);
  scanner.scan('kernelProjections', 'S1-normal projection_snapshot (closed)', await kernel.call({ op: 'projection_snapshot' }));
  for (const consumer of kernel.consumers) {
    const nowFinal = await fetchWorldNow(consumer, `S1-normal final (${consumer})`);
    assert.doesNotMatch(String(nowFinal.text ?? ''), /外出中/);
  }
  assert.equal(scanner.totalHits, 0);

  // ── 7. 双侧对账 ──
  const engineImbalance = ledgerImbalance(harness.city);
  const engineRec = runReconcile(harness.city, 's1_normal_final');
  const kernelRec = await kernel.call({ op: 'reconcile' });
  assert.equal(engineImbalance, 0, `引擎总账必须平衡，实际差额=${engineImbalance}`);
  assert.equal(engineRec.ok, true, `引擎对账发现异常: ${JSON.stringify(engineRec.findings)}`);
  assert.equal(kernelRec.report.ok, true, `内核跨库对账发现异常: ${JSON.stringify(kernelRec.report.findings)}`);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        scenario: 'city-s1-normal-invite-real-engine',
        planId,
        visits: { nia: niaVisitId, claire: claireVisitId },
        t1: { carryYen: 20_000, carryItems: carryItems.map((i) => i.ref) },
        engine: { cookieStateActive: cookiesActive[0]!.state, cookieStateEnd: cookiesEnd[0]!.state, niaPurseFinalYen: engNiaEnd.purse_final_yen },
        wallets: { niaNetSpentYen: initialWallet - Number(niaEnd.wallet_balance), claireNetSpentYen: claireInitialWallet - Number(claireEnd.wallet_balance) },
        reconcile: { engineLedgerImbalance: engineImbalance, engineReconcileOk: engineRec.ok, kernelReconcileOk: kernelRec.report.ok },
        legacyRuntimeScan: { forbiddenTokenCount: FORBIDDEN_RUNTIME_TOKENS.length, totalHits: scanner.totalHits, categories: scanner.stats },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((err) => {
  const cause = err && typeof err === 'object' && 'cause' in err ? ` | cause=${String((err as any).cause?.stack ?? (err as any).cause)}` : '';
  process.stderr.write(`city-m1-e2e 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}${cause}\n`);
  process.exit(1);
});
