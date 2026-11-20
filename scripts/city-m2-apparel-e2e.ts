#!/usr/bin/env node
/**
 * 晴空都持续世界（M2）服饰店买衣/送礼 × 小屋衣柜入柜 × 谷歌云盘限流回填 × 双通道出图跨进程验收脚本（#260）。
 *
 * 全程运行于隔离临时目录，零真实外部网络请求、零付费图像 API 调用。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createIsolatedCityHarness } from '../packages/engine/test/city/test-harness.js';
import {
  APPAREL_CATALOG,
  APPAREL_SHOP_PLACES,
  apparelWindowForPlace,
} from '../packages/engine/src/city/apparel-catalog.js';
import { heldItems, ledgerImbalance, runReconcile } from '../packages/engine/src/city/index.js';
import { CityClient } from '../packages/agent-kit/src/index.js';

const PYTHON_M2_DRIVER_SOURCE = String.raw`import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import sys
import zlib

from worldkernel import outings, vocab_life1 as V
from worldkernel.city_bridge import CityBridgeAdapter, DeterministicCityModel
from worldkernel.city_client import CityBridgeHttpClient
from worldkernel.life import ROSTER, Life
from worldkernel.store import Store, VirtualClock
from worldkernel.wardrobe_render import WardrobeRenderLedger, sha256_bytes
import atlas_drive
from wardrobe_render_worker import WardrobeRenderWorker

TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII="
)
TINY_WEBP = base64.b64decode(
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAEA0JaQAA3AA/vuUAAA="
)


class FakeDriveError(RuntimeError):
    pass


class FakeDriveMod:
    API = "https://www.googleapis.com/drive/v3"
    UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
    FOLDER = "application/vnd.google-apps.folder"
    ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,80}$")
    DriveError = FakeDriveError

    def __init__(self):
        self._seq = 0
        self._access = {"token": "fake-oauth-token"}
        self.files = {}
        self.media = {}
        self.download_calls = 0

    def _token(self):
        return "fake-oauth-token"

    def _q(self, s):
        return str(s).replace("\\", "\\\\").replace("'", "\\'")

    def _next_id(self, prefix):
        self._seq += 1
        return f"fake_{prefix}_{self._seq:06d}"

    def upload_item(self, meta, content, mime):
        fid = self._next_id("file")
        md5 = hashlib.md5(content, usedforsecurity=False).hexdigest()
        rec = {
            "id": fid,
            "name": meta["name"],
            "parents": list(meta.get("parents") or []),
            "mimeType": mime,
            "size": str(len(content)),
            "md5Checksum": md5,
            "appProperties": dict(meta.get("appProperties") or {}),
            "trashed": False,
            "webViewLink": f"https://drive.google.com/file/d/{fid}/view",
        }
        self.files[fid] = rec
        self.media[fid] = bytes(content)
        return dict(rec)

    def _json(self, method, url, *, params=None, body=None):
        params = params or {}
        if method == "POST" and url.endswith("/files"):
            fid = self._next_id("folder")
            rec = {
                "id": fid,
                "name": body["name"],
                "mimeType": body["mimeType"],
                "parents": list(body.get("parents") or []),
                "trashed": False,
            }
            self.files[fid] = rec
            return {"id": fid}
        if method == "GET" and url.endswith("/files"):
            q = str(params.get("q") or "")
            out = []
            if "atlas_key" in q:
                m = re.search(r"value='([^']+)'", q)
                akey = m.group(1) if m else ""
                for f in self.files.values():
                    if not f.get("trashed") and (f.get("appProperties") or {}).get("atlas_key") == akey:
                        out.append(dict(f))
            elif self.FOLDER in q:
                nm = re.search(r"name = '([^']+)'", q)
                pm = re.search(r"'([^']+)' in parents", q)
                want_name = nm.group(1) if nm else ""
                want_parent = pm.group(1) if pm else ""
                for f in self.files.values():
                    if (
                        not f.get("trashed")
                        and f.get("mimeType") == self.FOLDER
                        and f.get("name") == want_name
                        and want_parent in (f.get("parents") or [])
                    ):
                        out.append({"id": f["id"]})
            return {"files": out}
        if method == "GET" and "/files/" in url:
            fid = url.rsplit("/", 1)[-1]
            if fid not in self.files:
                raise FakeDriveError(f"404 not found: {fid}")
            return dict(self.files[fid])
        raise FakeDriveError(f"unexpected _json {method} {url}")

    def _call(self, method, url, *, params=None, stream_to=None):
        params = params or {}
        if method == "GET" and "/files/" in url and params.get("alt") == "media":
            fid = url.rsplit("/", 1)[-1]
            raw = self.media[fid]
            self.download_calls += 1
            with open(stream_to, "wb") as f:
                f.write(raw)
            return len(raw)
        raise FakeDriveError(f"unexpected _call {method} {url}")


class M2Driver:
    def __init__(self, work_dir, life1_dir, bridge_url, bridge_key, start_ms):
        self.work_dir = work_dir
        self.life1_dir = life1_dir
        self.db_path = os.path.join(work_dir, "life1-m2.db")
        self.profiles_dir = os.path.join(work_dir, "profiles")
        self.blob_root = os.path.join(work_dir, "blobs")
        self.staging_dir = os.path.join(work_dir, "staging")
        self.gallery_dir = os.path.join(work_dir, "gallery")
        self.atlas_state_dir = os.path.join(work_dir, "atlas-drive")
        for d in (os.path.join(self.profiles_dir, "nia"), self.blob_root, self.staging_dir, self.gallery_dir, self.atlas_state_dir):
            os.makedirs(d, exist_ok=True)
        with open(os.path.join(self.profiles_dir, "nia", "portrait.png"), "wb") as f:
            f.write(TINY_PNG)
        with open(os.path.join(self.profiles_dir, "nia", "display.json"), "w", encoding="utf-8") as f:
            json.dump({"look": "银白长发猫耳少女"}, f, ensure_ascii=False)

        self.fake_drive = FakeDriveMod()
        self.cpa_requests = []
        self._queued_actions = []
        self.clock = VirtualClock(start_ms / 1000.0)

        os.environ["WARDROBE_PROFILES_DIR"] = self.profiles_dir
        os.environ["WARDROBE_BLOB_ROOT"] = self.blob_root
        os.environ["WARDROBE_RENDER_ACTORS"] = "nia"
        self.s = Store(self.db_path, self.clock, synthetic=True, seed=26099)
        self.s.acquire()
        try:
            self.life = Life(self.s, extensions=[outings.install])
        finally:
            os.environ.pop("WARDROBE_PROFILES_DIR", None)
            os.environ.pop("WARDROBE_BLOB_ROOT", None)
            os.environ.pop("WARDROBE_RENDER_ACTORS", None)

        with self.s.tx() as db:
            for a in ROSTER:
                self.life.k._set_actor(db, a, location="living", activity="idle", action_id=None)

        self.client = CityBridgeHttpClient(bridge_url, bridge_key, timeout_s=5.0, max_retries=3, backoff_base_s=0.05)
        self.adapter = CityBridgeAdapter(
            self.life,
            self.client,
            city_model=DeterministicCityModel(self._model_handler),
            allowed_actors=("nia",),
        )
        self.life.extensions.append(self.adapter)

        self.ledger = WardrobeRenderLedger(os.path.join(work_dir, "wardrobe_render.db"))
        self.worker = WardrobeRenderWorker(
            ledger=self.ledger,
            blob_root=self.blob_root,
            staging_dir=self.staging_dir,
            gallery_dir=self.gallery_dir,
            profiles_dir=self.profiles_dir,
            api_key_loader=lambda: "sk-fake-m2-cpa",
            debounce_seconds=10.0,
            urlopen=self._fake_cpa_urlopen,
            asset_hydrator=self._hydrate_from_fake_drive,
        )

    def _model_handler(self, _ctx):
        if self._queued_actions:
            return self._queued_actions.pop(0)
        return []

    @staticmethod
    def _make_distinct_png(seed_bytes):
        d = hashlib.sha256(seed_bytes).digest()
        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
        idat = zlib.compress(bytes([0, d[0], d[1], d[2]]))
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    def _source_bytes_for_url(self, url):
        ext = os.path.splitext(url)[1].lower()
        seed = url.encode("utf-8")
        if ext == ".png":
            return self._make_distinct_png(seed)
        return TINY_WEBP + hashlib.sha256(seed).digest()[:16]

    def _hydrate_from_fake_drive(self, logical_key, dst_blob_root, **kw):
        return atlas_drive.ensure_asset_blob(
            logical_key,
            dst_blob_root,
            drive_id=kw.get("drive_id"),
            expected_sha256=kw.get("expected_sha256"),
            atlas_key=kw.get("atlas_key"),
            state_dir=self.atlas_state_dir,
            drive_mod=self.fake_drive,
        )

    def _fake_cpa_urlopen(self, req, timeout=60):
        self.cpa_requests.append(bytes(req.data or b""))
        doc = {"id": f"cpa_m2_{len(self.cpa_requests)}", "data": [{"b64_json": base64.b64encode(TINY_PNG).decode("ascii")}]}
        return io.BytesIO(json.dumps(doc).encode("utf-8"))

    def handle(self, cmd):
        op = cmd["op"]
        if op == "sync_clock":
            target_s = float(cmd["now_ms"]) / 1000.0
            if target_s > self.clock.now():
                self.clock.advance(target_s - self.clock.now())
            self.life.k.tick()
            return {"ok": True, "now_ms": int(round(self.clock.now() * 1000))}

        if op == "seed_drive_assets":
            # Rate-limited sync pass for targeted logical keys + verify hourly write cap enforcement
            want_keys = set(cmd["logical_keys"])
            full_cat = atlas_drive.collect_catalog_items(self.life1_dir)
            subset_dir = os.path.join(self.work_dir, "subset-life1")
            os.makedirs(subset_dir, exist_ok=True)
            c_doc = json.loads(Path(self.life1_dir, "poseatlas_costumes.json").read_text(encoding="utf-8"))
            p_doc = json.loads(Path(self.life1_dir, "poseatlas_poses.json").read_text(encoding="utf-8"))
            sub_costumes = {
                aid: spec for aid, spec in c_doc["assets"].items() if f"costume/{aid}" in want_keys
            }
            sub_poses = {}
            for pid, pspec in p_doc["poses"].items():
                vs = [v for v in pspec["variants"] if f"pose/{v['variant_id']}" in want_keys]
                if vs:
                    sub_poses[pid] = {**pspec, "variants": vs}
            Path(subset_dir, "poseatlas_costumes.json").write_text(
                json.dumps({**c_doc, "assets": sub_costumes}, ensure_ascii=False), encoding="utf-8"
            )
            Path(subset_dir, "poseatlas_poses.json").write_text(
                json.dumps({**p_doc, "poses": sub_poses}, ensure_ascii=False), encoding="utf-8"
            )
            dry = atlas_drive.sync_pass(subset_dir, mode="dry", state_dir=self.atlas_state_dir, now=self.clock.now())
            # 1st pass with tight writes_per_hour=4 -> stops gracefully on rate limit
            capped = atlas_drive.sync_pass(
                subset_dir,
                mode="1",
                state_dir=self.atlas_state_dir,
                now=self.clock.now(),
                max_items=10,
                writes_per_hour=4,
                drive_mod=self.fake_drive,
                source_fetcher=self._source_bytes_for_url,
                uploader=lambda dm, meta, raw, mime: dm.upload_item(meta, raw, mime),
            )
            # Advance >1h window in sync clock or raise writes_per_hour=60 to finish remaining items cleanly
            full_sync = atlas_drive.sync_pass(
                subset_dir,
                mode="1",
                state_dir=self.atlas_state_dir,
                now=self.clock.now(),
                max_items=20,
                writes_per_hour=60,
                drive_mod=self.fake_drive,
                source_fetcher=self._source_bytes_for_url,
                uploader=lambda dm, meta, raw, mime: dm.upload_item(meta, raw, mime),
            )
            # Re-running after state flush adopts/skips idempotently with 0 new uploads
            idempotent = atlas_drive.sync_pass(
                subset_dir,
                mode="1",
                state_dir=self.atlas_state_dir,
                now=self.clock.now(),
                max_items=20,
                writes_per_hour=60,
                drive_mod=self.fake_drive,
                source_fetcher=self._source_bytes_for_url,
                uploader=lambda dm, meta, raw, mime: dm.upload_item(meta, raw, mime),
            )
            return {
                "ok": True,
                "full_catalog_total": len(full_cat),
                "dry": dry,
                "capped": capped,
                "full_sync": full_sync,
                "idempotent": idempotent,
            }

        if op == "depart":
            vis = self.adapter.depart(
                cmd["actor"],
                cmd["destination"],
                carry_yen=cmd.get("carry_yen", 35000),
                carry_items=[],
                auto_snack=False,
                visit_id=cmd["visit_id"],
            )
            return {"ok": True, "visit": vis}

        if op == "advance_handover":
            vis = self.adapter.advance_handover(cmd["visit_id"])
            return {"ok": True, "visit": vis}

        if op == "queue_decision":
            self._queued_actions.append(list(cmd["actions"]))
            return {"ok": True, "queued": len(self._queued_actions)}

        if op == "poll_outbox":
            res = self.adapter.poll_outbox_once()
            return {"ok": True, "poll": res}

        if op == "step":
            self.adapter.step()
            return {"ok": True}

        if op == "inspect_wardrobe":
            actor = cmd.get("actor", "nia")
            vid = cmd.get("visit_id")
            with self.s.read() as db:
                links = [
                    dict(r)
                    for r in db.execute(
                        "SELECT garment_id, asset_id, shelf_name FROM garment_asset_links WHERE actor=? ORDER BY garment_id",
                        (actor,),
                    ).fetchall()
                ]
                events = [
                    json.loads(r[0])
                    for r in db.execute(
                        "SELECT payload FROM events WHERE kind='brought_home_garment' AND actor_id=? ORDER BY event_id",
                        (actor,),
                    ).fetchall()
                ]
                bal = int(db.execute("SELECT balance FROM wallets WHERE account=?", (actor,)).fetchone()[0])
            return {
                "ok": True,
                "visit": self.life.k.city_visits.get(vid) if vid else None,
                "actor": self.life.k.actor(actor),
                "authority": self.life.k.city_visits.authority(actor),
                "wallet_balance": bal,
                "shelf_picks": self.life.wardrobe.shelf_picks(actor, limit=50),
                "owned_garment_ids": sorted(g["garment_id"] for g in self.life.wardrobe.owned(actor)),
                "asset_links": links,
                "brought_home_garment_events": events,
            }

        if op == "wear_and_render":
            actor = cmd.get("actor", "nia")
            asset_id = cmd["asset_id"]
            pose_variant_id = cmd.get("pose_variant_id")
            spec = V.GARMENT_ASSETS["assets"][asset_id]
            gids = [f"{actor}__{g['id']}" for g in spec["grants"]]
            occasion = "sleep" if spec.get("nsfw") else "out"
            epoch = self.life.k.city_visits.authority(actor)["domain_epoch"]
            args = {"items": gids, "occasion": occasion}
            if pose_variant_id:
                args["pose_variant_id"] = pose_variant_id
            cpa_before = len(self.cpa_requests)
            dl_before = self.fake_drive.download_calls
            sub = self.life.k.submit({
                "idempotency_key": f"m2-wear-{asset_id}-{int(self.clock.now())}",
                "domain_epoch": epoch,
                "principal": f"channel:{actor}",
                "origin": "model",
                "actor_id": actor,
                "action_type": "change_clothes",
                "args": args,
            })
            if sub.get("status") != "succeeded":
                return {"ok": False, "error": f"change_clothes_failed:{sub}"}
            self.clock.advance(15)
            run_out = self.worker.run_once(self.s.db, now=self.clock.now())
            cpa_delta = len(self.cpa_requests) - cpa_before
            dl_delta = self.fake_drive.download_calls - dl_before
            last_cpa_has_pose = bool(self.cpa_requests and b"Pose Reference Image" in self.cpa_requests[-1])
            int_jobs = self.ledger.intimate_pending_jobs(now=self.clock.now())
            intimate_completed = []
            if cmd.get("complete_intimate") and int_jobs:
                for ij in int_jobs:
                    staged = os.path.join(self.staging_dir, f"{ij['job_id']}-intimate.png")
                    with open(staged, "wb") as f:
                        f.write(TINY_PNG)
                    self.ledger.stage_intimate_job(ij["job_id"], staged, sha256_bytes(TINY_PNG), now=self.clock.now())
                intimate_completed = self.worker.publish_staged_jobs(now=self.clock.now())

            idx_path = os.path.join(self.gallery_dir, "index.json")
            idx = json.loads(Path(idx_path).read_text(encoding="utf-8")) if os.path.isfile(idx_path) else {}
            art_path = os.path.join(self.profiles_dir, "outfit_art.json")
            art = json.loads(Path(art_path).read_text(encoding="utf-8")) if os.path.isfile(art_path) else {}
            return {
                "ok": True,
                "run_out": run_out,
                "cpa_calls_delta": cpa_delta,
                "drive_downloads_delta": dl_delta,
                "last_cpa_has_pose": last_cpa_has_pose,
                "intimate_pending_count": len(int_jobs),
                "intimate_completed": intimate_completed,
                "gallery_index": idx,
                "outfit_art": art.get("outfits") or {},
            }

        if op == "reconcile":
            return {"ok": True, "report": self.adapter.reconcile()}

        if op == "close":
            self.ledger.close()
            if self.s.epoch is not None:
                self.s.release()
            self.s.close()
            return {"ok": True}

        return {"ok": False, "error": f"unknown_op:{op}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--life1-dir", required=True)
    ap.add_argument("--bridge-url", required=True)
    ap.add_argument("--bridge-key", required=True)
    ap.add_argument("--start-ms", type=int, required=True)
    args = ap.parse_args()
    drv = M2Driver(args.work_dir, args.life1_dir, args.bridge_url, args.bridge_key, args.start_ms)
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

interface DriverResponse {
  id?: number;
  ok: boolean;
  error?: string;
  [k: string]: any;
}

class PythonM2Driver {
  private proc!: ChildProcessWithoutNullStreams;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: DriverResponse) => void; reject: (e: Error) => void }>();
  private stderrBuf: string[] = [];

  async start(opts: {
    repoRoot: string;
    workDir: string;
    bridgeUrl: string;
    bridgeKey: string;
    startMs: number;
  }): Promise<void> {
    const scriptPath = join(opts.workDir, 'city_m2_driver.py');
    writeFileSync(scriptPath, PYTHON_M2_DRIVER_SOURCE, 'utf8');
    const kernelDir = join(opts.repoRoot, 'world-kernel');
    const catalogDir = join(opts.repoRoot, 'world-catalog');
    const sharedDir = join(opts.repoRoot, 'shared-services');
    const life1Dir = join(catalogDir, 'worldcatalog', 'life1');

    this.proc = spawn(
      'python3',
      [
        '-B',
        '-u',
        scriptPath,
        '--work-dir',
        opts.workDir,
        '--life1-dir',
        life1Dir,
        '--bridge-url',
        opts.bridgeUrl,
        '--bridge-key',
        opts.bridgeKey,
        '--start-ms',
        String(opts.startMs),
      ],
      {
        cwd: kernelDir,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: [kernelDir, catalogDir, sharedDir].join(':'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.proc.stderr.on('data', (c) => this.stderrBuf.push(String(c)));
    this.proc.on('exit', (code, sig) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`city_m2_driver exited (${code}/${sig}): ${this.stderrBuf.join('')}`));
      }
      this.pending.clear();
    });

    const rl = createInterface({ input: this.proc.stdout });
    let ready = false;
    await new Promise<void>((resReady, rejReady) => {
      const timer = setTimeout(() => rejReady(new Error(`timeout waiting ready: ${this.stderrBuf.join('')}`)), 15_000);
      rl.on('line', (line) => {
        const t = line.trim();
        if (!t) return;
        const msg = JSON.parse(t) as Record<string, any>;
        if (!ready && msg.ready) {
          ready = true;
          clearTimeout(timer);
          resReady();
          return;
        }
        const w = this.pending.get(Number(msg.id));
        if (w) {
          this.pending.delete(Number(msg.id));
          w.resolve(msg as DriverResponse);
        }
      });
    });
  }

  async call(cmd: Record<string, unknown>): Promise<DriverResponse> {
    const id = ++this.seq;
    const res = await new Promise<DriverResponse>((resFn, rejFn) => {
      this.pending.set(id, { resolve: resFn, reject: rejFn });
      this.proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
    });
    if (!res.ok) {
      throw new Error(`PythonM2Driver(${String(cmd.op)}) failed: ${JSON.stringify(res)} | stderr=${this.stderrBuf.join('')}`);
    }
    return res;
  }

  async close(): Promise<void> {
    if (!this.proc || this.proc.killed) return;
    await this.call({ op: 'close' }).catch(() => undefined);
    this.proc.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'house-repo': { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  const houseRepo = resolve(
    values['house-repo'] ??
      (process.env.WORLD_KERNEL_DIR ? dirname(resolve(process.env.WORLD_KERNEL_DIR)) : '/srv/coding-work/.scratch/nia-tokyo-wardrobe-260'),
  );
  const rootWorkDir = mkdtempSync(join(tmpdir(), 'city-m2-apparel-e2e-'));
  const engineDir = join(rootWorkDir, 'engine');
  const kernelWorkDir = join(rootWorkDir, 'kernel');
  mkdirSync(engineDir, { recursive: true });
  mkdirSync(kernelWorkDir, { recursive: true });

  const harness = await createIsolatedCityHarness({
    workDir: engineDir,
    seed: 'city-m2-apparel-seed-20261118',
    enableControlRoutes: true,
  });
  // Advance from 10:00 JST to 13:00 JST so all 3 apparel shops (including 12:00-22:00 Velours Intime) are open.
  harness.advance(3 * 3600_000);

  const driver = new PythonM2Driver();
  const closers: (() => Promise<void>)[] = [];
  let activeExtBot: CityClient | null = null;

  const advanceBoth = async (ms: number) => {
    let rem = ms;
    const chunkMs = 8 * 60_000;
    while (rem > 0) {
      const step = Math.min(rem, chunkMs);
      harness.advance(step);
      await driver.call({ op: 'sync_clock', now_ms: harness.clock.t });
      if (activeExtBot) {
        await activeExtBot.heartbeat();
      }
      rem -= step;
    }
  };

  try {
    await driver.start({
      repoRoot: houseRepo,
      workDir: kernelWorkDir,
      bridgeUrl: harness.bridgeUrl,
      bridgeKey: harness.bridgeKey,
      startMs: harness.clock.t,
    });

    // ── 1. 目录完整性与协议版本 v3 校验 ──
    assert.equal(APPAREL_CATALOG.length, 1_407, '全量服饰目录必须完整收录 1,407 套');
    assert.equal(Object.keys(APPAREL_SHOP_PLACES).length, 3, '三家晴空都虚构服饰店全部启用');
    const suzuranToday = apparelWindowForPlace('ryokogai:suzuran-closet', '2026-11-18');
    const lumiereToday = apparelWindowForPlace('kumominato:lumiere-atelier', '2026-11-18');
    const veloursToday = apparelWindowForPlace('kumominato:velours-intime', '2026-11-18');
    assert.equal(suzuranToday.length, 6);
    assert.equal(lumiereToday.length, 6);
    assert.equal(veloursToday.length, 6);
    assert.ok(veloursToday.every((x) => x.tier === 'intimate'));

    const sfwTarget = suzuranToday[0]!;
    const intimateTarget = veloursToday[0]!;
    const poseVariantId = 'pose_full_single_p001_front';

    // 预同步本次测试用到的 2 套服饰 + 1 张姿势参考图到模拟谷歌云盘，同时验证每小时写入限流与幂等去重
    const syncReport = await driver.call({
      op: 'seed_drive_assets',
      logical_keys: [`costume/${sfwTarget.assetId}`, `costume/${intimateTarget.assetId}`, `pose/${poseVariantId}`],
    });
    assert.equal(syncReport.full_catalog_total, 2_846, '1,407 套衣装 + 1,439 张姿势分镜 = 2,846 项云盘索引');
    assert.equal(syncReport.dry.remaining, 3);
    assert.ok(String(syncReport.capped.stopped_reason ?? '').includes('这一小时图鉴已写入 4 次'), '每小时写入配额必须精确生效并安全停轮');
    assert.equal(syncReport.full_sync.uploaded_total, 3);
    assert.equal(syncReport.idempotent.uploaded_this_pass, 0, '二次同步必须幂等跳过已归档文件');

    // ── 2. 外部 Bot「时尚买手葵」前往云港·丝绒私语购入私密礼盒，再赴棱光街·铃兰衣橱 ──
    const extBot = await CityClient.connect({
      url: harness.mcpUrl,
      key: 'test_only_ext_bot_key_city_90001',
      clientId: 'ext-fashion-aoi',
      retryBaseMs: 25,
    });
    closers.push(() => extBot.close());

    const enterAoi = await extBot.enterWorld({
      name: '时尚买手葵',
      bio: '搜集晴空都独立买手店礼盒的旅人',
      entry: 'kumominato:station',
    });
    assert.equal(enterAoi.granted_yen, 200_000);
    activeExtBot = extBot;

    await extBot.travel('kumominato:velours-intime');
    await advanceBoth(8 * 60_000); // 7m 步行抵达云港·丝绒私语
    const viewAtVelours = await extBot.view();
    assert.equal(viewAtVelours.here?.place.id, 'kumominato:velours-intime');
    assert.ok(Buffer.byteLength(JSON.stringify(viewAtVelours), 'utf8') < 4_096, '单店轮换窗口必须保持 selfView < 4 KB');
    assert.equal(viewAtVelours.here?.goods?.length, 6);

    await extBot.buy(intimateTarget.sku, 1);
    const viewAfterIntimateBuy = await extBot.view();
    const aoiGiftItem = viewAfterIntimateBuy.items.find((i) => i.type === 'apparel_bundle');
    assert.ok(aoiGiftItem?.item_id, '服饰礼盒必须作为带唯一 item_id 的实例物品入包');

    await extBot.travel('ryokogai:suzuran-closet');
    await advanceBoth(30 * 60_000); // 7m 步行 + 晴环线 + 5m 步行抵达棱光街·铃兰衣橱
    assert.equal((await extBot.view()).here?.place.id, 'ryokogai:suzuran-closet');

    // ── 3. 妮娅从 AI 小屋出门前往棱光街·铃兰衣橱（mappings_version = 3） ──
    const dep = await driver.call({
      op: 'depart',
      actor: 'nia',
      destination: 'ryokogai:suzuran-closet',
      carry_yen: 35_000,
      visit_id: 'vis_m2_apparel_1',
    });
    assert.equal(dep.visit.mappings_version, 3);
    assert.equal(dep.visit.city_catalog_version, 'toto-p3.0');

    await advanceBoth(60_000); // 走到玄关 away
    const hand = await driver.call({ op: 'advance_handover', visit_id: 'vis_m2_apparel_1' });
    assert.equal(hand.visit.state, 'active');

    await advanceBoth(32 * 60_000); // 12m 步行 + 13m 北环快线 + 5m 步行抵达棱光街·铃兰衣橱
    const niaResidentId = harness.city.db.get<{ resident_id: string }>(
      "SELECT resident_id FROM house_members WHERE actor_id = 'nia'",
    )!.resident_id;

    // 妮娅在铃兰衣橱自购 1 套当季常服
    await driver.call({
      op: 'queue_decision',
      actions: [
        { type: 'say', text: '这件当季搭配的颜色真好看呀！' },
        { type: 'buy', sku: sfwTarget.sku, qty: 1 },
      ],
    });
    await driver.call({ op: 'poll_outbox' });

    // 时尚买手葵将私密礼盒当面赠送给妮娅
    await extBot.say('妮娅你好！这盒丝绒私语的限定礼服送给你。');
    await extBot.give(niaResidentId, { itemId: aoiGiftItem.item_id }, 1, {
      requestId: 'aoi-give-intimate-box-0001',
    });

    const niaHeld = heldItems(harness.city, niaResidentId);
    assert.equal(niaHeld.length, 2, '妮娅随身应持有自购常服礼盒 + 受赠私密礼盒共 2 件');

    // 安全防伪探测：恶意篡改 meta_json 中的 asset_id，验证结算严格只信任服务端 origin_json.asset_id
    harness.city.db.run(
      'UPDATE items SET meta_json = ? WHERE item_id = ?',
      JSON.stringify({ sku: 'apparel:pa_spr_9999', asset_id: 'pa_spr_9999', label: '伪造高价衣装' }),
      aoiGiftItem.item_id,
    );

    // 妮娅动身返家并完成 T3 原子结算与 release
    await driver.call({
      op: 'queue_decision',
      actions: [{ type: 'go_home' }],
    });
    await driver.call({ op: 'poll_outbox' });
    await advanceBoth(35 * 60_000); // 5m 步行 + 13m 北环快线 + 12m 步行返回小屋门口
    await driver.call({ op: 'poll_outbox' });
    await driver.call({ op: 'step' });
    await advanceBoth(60_000); // 玄关走回客厅 living
    await driver.call({ op: 'step' });

    // ── 4. 校验公共货架隔离与私人衣柜双件入柜 ──
    const wState = await driver.call({ op: 'inspect_wardrobe', actor: 'nia', visit_id: 'vis_m2_apparel_1' });
    assert.equal(wState.visit.state, 'closed');
    assert.equal(wState.actor.location, 'living');
    assert.equal(wState.authority.domain, 'home');
    // 净支出 = 去程 ¥200 + 自购常服 priceYen + 回程 ¥200（受赠礼盒由外部 Bot 付款，妮娅零扣费）
    assert.equal(wState.wallet_balance, 40_000 - (400 + sfwTarget.priceYen));
    assert.equal(
      (wState.shelf_picks as any[]).some((p) => String(p.asset_id).startsWith('pa_')),
      false,
      '晴空都店铺专属服饰严禁出现在小屋免费走廊货架',
    );

    const linkedAssets = (wState.asset_links as any[]).map((x) => x.asset_id);
    assert.ok(linkedAssets.includes(sfwTarget.assetId), '自购常服必须入柜绑定');
    assert.ok(linkedAssets.includes(intimateTarget.assetId), '受赠私密礼服必须按真实 origin_json.asset_id 入柜绑定');
    assert.ok(!linkedAssets.includes('pa_spr_9999'), '篡改的不可信 meta_json.asset_id 绝不可穿透结算');
    assert.equal((wState.brought_home_garment_events as any[]).length, 2);

    // ── 5. 校验云盘按需回填 + 常服 CPA 三图渲染 vs 私密装独立通道隔离 ──
    const sfwRender = await driver.call({
      op: 'wear_and_render',
      actor: 'nia',
      asset_id: sfwTarget.assetId,
      pose_variant_id: poseVariantId,
      complete_intimate: false,
    });
    assert.equal(sfwRender.run_out.published.length, 1);
    assert.equal(sfwRender.cpa_calls_delta, 1, '常服换装应调用 1 次标准 CPA /v1/images/edits');
    assert.equal(sfwRender.drive_downloads_delta, 2, '首次穿戴按需从云盘流式回填衣装图 + 姿势图共 2 个文件');
    assert.equal(sfwRender.last_cpa_has_pose, true, '指定 PoseAtlas 姿势时必须携带第 3 张姿势参考图');
    const sfwGalleryEntries = Object.values(sfwRender.gallery_index as Record<string, any>).filter((e) => !e.nsfw);
    assert.equal(sfwGalleryEntries.length, 1);
    assert.ok(!String(sfwGalleryEntries[0].name).includes('-nsfw-'));

    const intRender = await driver.call({
      op: 'wear_and_render',
      actor: 'nia',
      asset_id: intimateTarget.assetId,
      complete_intimate: true,
    });
    assert.equal(intRender.cpa_calls_delta, 0, '私密内衣/性感服饰严禁向 SFW-only CPA 接口发起任何请求');
    assert.equal(intRender.drive_downloads_delta, 1, '私密服饰原图同样按需从云盘流式回填并校验 SHA-256');
    assert.equal(intRender.intimate_pending_count, 1, '私密任务必须进入独立 intimate_pending 队列');
    assert.equal(intRender.intimate_completed.length, 1, '独立私密渲染器回写后完成发布');
    const nsfwGalleryEntries = Object.values(intRender.gallery_index as Record<string, any>).filter((e) => e.nsfw === true);
    assert.equal(nsfwGalleryEntries.length, 1);
    assert.ok(String(nsfwGalleryEntries[0].name).startsWith('wardrobe-nsfw-nia-'), '私密成图文件名必须带 -nsfw- 隔离标记');

    // ── 6. 引擎与内核双侧零差额对账 ──
    const engineImbalance = ledgerImbalance(harness.city);
    const engineRec = runReconcile(harness.city, 'm2_apparel_e2e_final');
    const kernelRec = await driver.call({ op: 'reconcile' });
    assert.equal(engineImbalance, 0);
    assert.equal(engineRec.ok, true);
    assert.equal(kernelRec.report.ok, true);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          scenario: 'city-m2-apparel-wardrobe-drive-e2e',
          catalog: {
            version: 'toto-p3.0',
            mappingsVersion: 3,
            totalCostumes: APPAREL_CATALOG.length,
            shops: APPAREL_SHOP_PLACES,
          },
          purchasedSfw: { sku: sfwTarget.sku, assetId: sfwTarget.assetId, priceYen: sfwTarget.priceYen },
          giftedIntimate: { sku: intimateTarget.sku, assetId: intimateTarget.assetId, from: '时尚买手葵' },
          driveSync: {
            fullCatalogEntries: syncReport.full_catalog_total,
            rateLimitVerified: true,
            idempotentVerified: true,
          },
          rendering: {
            sfwPublished: sfwGalleryEntries[0].name,
            sfwPoseIncluded: sfwRender.last_cpa_has_pose,
            intimateZeroCpaCalls: intRender.cpa_calls_delta === 0,
            intimatePublished: nsfwGalleryEntries[0].name,
          },
          reconcile: {
            engineLedgerImbalance: engineImbalance,
            engineReconcileOk: engineRec.ok,
            kernelReconcileOk: kernelRec.report.ok,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    for (const fn of closers.reverse()) await fn().catch(() => undefined);
    await driver.close().catch(() => undefined);
    await harness.close({ cleanup: false }).catch(() => undefined);
    if (!values.keep) {
      rmSync(rootWorkDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  process.stderr.write(`city-m2-apparel-e2e 失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
