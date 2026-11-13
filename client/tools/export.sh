#!/usr/bin/env bash
# 导出 Godot 网页客户端到 client/town/build/web/：
#   1) 导入资源  2) export-release  3) 拷 web/ 顶层的外壳文件（除 shell.html；mod/ 子目录由 assemble.mjs 合并并注入模板）  4) 生成 .br / .gz 预压缩  5) 打印大小  6) 换到位
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
# build/ 在 Godot 工程目录里：不挡住的话，上一次导出留下的 build/web/*.png 会被当成工程资源导入，再打进这一次的资源包。
: >"$PROJ/build/.gdignore"
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
  [ -d "$f" ] && continue # web/mod/ 等子目录不直接拷：由下面的 assemble 合并
  case "$(basename "$f")" in
    shell.html) ;;
    *) cp "$f" "$OUT/" ;;
  esac
done

echo "[export] 合并网页模块（检查、拼接、注入模板）…"
node "$ROOT/client/tools/assemble.mjs" "$OUT" "$PROJ/web"

# 音乐等「进游戏后才取」的大文件放在 client/town/stream/（有 .gdignore，Godot 不导入，也就不进 pck），整个目录树拷到产物里：
# client/town/stream/music/day.ogg -> build/web/music/day.ogg，客户端用 HTTPRequest 取。不预压缩（ogg 已是压缩格式）。
if [ -d "$PROJ/stream" ]; then
  echo "[export] 拷贝流式资源…"
  for d in "$PROJ"/stream/*/; do
    [ -d "$d" ] && cp -R "$d" "$OUT/$(basename "$d")"
  done
fi

if [ "${SKIP_COMPRESS:-0}" != "1" ]; then
  echo "[export] 生成预压缩副本（.br / .gz）…"
  BROTLI_QUALITY="${BROTLI_QUALITY:-11}" node "$ROOT/client/tools/compress.mjs" "$OUT"
fi

echo "[export] 产物（字节）："
printf '%-34s %12s %12s %12s\n' 文件 原始 gzip brotli
for f in "$OUT"/*; do
  b="$(basename "$f")"
  [ -f "$f" ] || continue
  case "$b" in *.br|*.gz) continue ;; esac
  # wc -c 在 GNU 和 BSD（macOS）上都能用；stat 的参数两边不一样
  raw="$(wc -c <"$f" | tr -d ' ')"
  gz="-"; br="-"
  [ -f "$f.gz" ] && gz="$(wc -c <"$f.gz" | tr -d ' ')"
  [ -f "$f.br" ] && br="$(wc -c <"$f.br" | tr -d ' ')"
  printf '%-34s %12s %12s %12s\n' "$b" "$raw" "$gz" "$br"
done
# 换到位：旧目录先挪开再换新的，最后删旧的（都在同一个文件系统内）。
# 两步 mv 之间有一瞬间 build/web 不存在；在那里被打断（出错、Ctrl-C）时把旧的挪回去，不会留下半份或空目录。
rm -rf "$FINAL.old"
swap_back() { if [ ! -d "$FINAL" ] && [ -d "$FINAL.old" ]; then mv "$FINAL.old" "$FINAL"; fi; cleanup; }
trap swap_back EXIT
if [ -d "$FINAL" ]; then mv "$FINAL" "$FINAL.old"; fi
mv "$OUT" "$FINAL"
trap - EXIT
rm -rf "$FINAL.old"
echo "[export] 完成：$FINAL"
