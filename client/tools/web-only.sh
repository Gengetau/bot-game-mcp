#!/usr/bin/env bash
# 只改了网页层（client/town/web/ 下的 hud.js / hud.css / dock.* / boot.js / mod/*）时的快速迭代：
# 不重新导出 Godot，直接把这些文件重新拷进已有的 client/town/build/web/，重跑 assemble（从 .index.raw.html 重新注入模板），
# 并先删掉这些文件旧的 .br/.gz 再重新压缩（引擎优先发预压缩副本，不删就会「改了没生效」；index.html 不压缩）。
# 改了 GDScript 或 shell.html 仍需完整导出（npm run client:export，约 2 分钟）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJ="$ROOT/client/town"
OUT="$PROJ/build/web"
[ -f "$OUT/index.html" ] || { echo "[web-only] 还没有导出产物：先 npm run client:export" >&2; exit 1; }
[ -f "$OUT/.index.raw.html" ] || { echo "[web-only] 产物里没有 .index.raw.html（是旧版导出）：先完整导出一次" >&2; exit 1; }
for f in "$PROJ"/web/*; do
  [ -d "$f" ] && continue
  case "$(basename "$f")" in
    shell.html) ;;
    *) cp "$f" "$OUT/" ;;
  esac
done
node "$ROOT/client/tools/assemble.mjs" "$OUT" "$PROJ/web"
BROTLI_QUALITY="${BROTLI_QUALITY:-9}" node "$ROOT/client/tools/compress.mjs" "$OUT" hud.js hud.css dock.js dock.css boot.js town-modules.js town-modules.css
echo "[web-only] 完成：$OUT"
