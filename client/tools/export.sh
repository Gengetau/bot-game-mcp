#!/usr/bin/env bash
# 导出 Godot 网页客户端到 client/town/build/web/：
#   1) 导入资源  2) export-release  3) 拷 web/ 下的外壳文件（除 shell.html）  4) 生成 .br / .gz 预压缩  5) 打印大小  6) 换到位
# 注意：SKIP_COMPRESS=1 的产物没有 .br，过不了 npm run client:e2e 的步骤 1（它断言 index.pck 发 br）。
# 环境变量：GODOT（默认 /opt/godot/godot）、BROTLI_QUALITY（默认 11）、SKIP_COMPRESS=1 跳过预压缩。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJ="$ROOT/client/town"
FINAL="$PROJ/build/web"
# 先导到临时目录，全部成功后再换到位：导出中途失败时，正在运行的站点（引擎托管的 /town/3d/）还用着旧产物，
# 不会变成缺文件。目录名以点开头，Godot 的资源扫描会跳过它。
OUT="$PROJ/build/.web-new"
GODOT="${GODOT:-/opt/godot/godot}"

if [ ! -x "$GODOT" ] && ! command -v "$GODOT" >/dev/null 2>&1; then
  echo "找不到 Godot：设置环境变量 GODOT 指向 Godot 4.7.x 可执行文件（需装网页导出模板）。" >&2
  exit 1
fi

echo "[export] Godot: $("$GODOT" --version)"
rm -rf "$OUT"
mkdir -p "$OUT"
cleanup() { rm -rf "$OUT"; }
trap cleanup EXIT

echo "[export] 导入资源…"
"$GODOT" --headless --path "$PROJ" --import >/dev/null 2>&1 || true

echo "[export] 导出 Web（release，单线程）…"
LOG="$(mktemp)"
if ! "$GODOT" --headless --path "$PROJ" --export-release "Web" "$OUT/index.html" >"$LOG" 2>&1; then
  cat "$LOG" >&2
  rm -f "$LOG"
  echo "[export] 导出失败" >&2
  exit 1
fi
if grep -E "SCRIPT ERROR|Parse Error|ERROR:" "$LOG" >/dev/null 2>&1; then
  grep -E "SCRIPT ERROR|Parse Error|ERROR:" "$LOG" >&2 || true
  rm -f "$LOG"
  echo "[export] 导出日志里有错误" >&2
  exit 1
fi
rm -f "$LOG"
[ -f "$OUT/index.wasm" ] && [ -f "$OUT/index.pck" ] && [ -f "$OUT/index.html" ] || { echo "[export] 缺少 index.wasm / index.pck / index.html" >&2; exit 1; }

echo "[export] 拷贝外壳文件…"
for f in "$PROJ"/web/*; do
  case "$(basename "$f")" in
    shell.html) ;;
    *) cp "$f" "$OUT/" ;;
  esac
done

if [ "${SKIP_COMPRESS:-0}" != "1" ]; then
  echo "[export] 生成预压缩副本（.br / .gz）…"
  OUT="$OUT" node --input-type=module -e '
    import { readdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
    import { brotliCompressSync, gzipSync, constants } from "node:zlib";
    import { join } from "node:path";
    const dir = process.env.OUT;
    const q = Number(process.env.BROTLI_QUALITY ?? 11);
    for (const f of readdirSync(dir)) {
      if (/\.(br|gz)$/.test(f)) rmSync(join(dir, f));
    }
    for (const f of readdirSync(dir)) {
      if (!/\.(wasm|pck|js|css)$/.test(f)) continue;
      const p = join(dir, f);
      const buf = readFileSync(p);
      writeFileSync(p + ".gz", gzipSync(buf, { level: 9 }));
      writeFileSync(p + ".br", brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: q, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
    }
  '
fi

echo "[export] 产物（字节）："
printf '%-34s %12s %12s %12s\n' 文件 原始 gzip brotli
for f in "$OUT"/*; do
  b="$(basename "$f")"
  case "$b" in *.br|*.gz) continue ;; esac
  # wc -c 在 GNU 和 BSD（macOS）上都能用；stat 的参数两边不一样
  raw="$(wc -c <"$f" | tr -d ' ')"
  gz="-"; br="-"
  [ -f "$f.gz" ] && gz="$(wc -c <"$f.gz" | tr -d ' ')"
  [ -f "$f.br" ] && br="$(wc -c <"$f.br" | tr -d ' ')"
  printf '%-34s %12s %12s %12s\n' "$b" "$raw" "$gz" "$br"
done
# 换到位：旧目录先挪开再换新的，最后删旧的（两步 mv 之间的窗口极短，且都在同一个文件系统内）
rm -rf "$FINAL.old"
[ -d "$FINAL" ] && mv "$FINAL" "$FINAL.old"
mv "$OUT" "$FINAL"
rm -rf "$FINAL.old"
echo "[export] 完成：$FINAL"
