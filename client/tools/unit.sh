#!/usr/bin/env bash
# 客户端逻辑单测：无头 Godot 直接跑 client/tests/*_test.gd，不起浏览器、不用导出。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GODOT="${GODOT:-/opt/godot/godot}"
rc=0
for f in "$ROOT"/client/tests/*_test.gd; do
  echo "[unit] $(basename "$f")"
  "$GODOT" --headless --path "$ROOT/client/town" --script "$f" 2>&1 | grep -v "^Godot Engine\|^$" || true
  "$GODOT" --headless --path "$ROOT/client/town" --script "$f" >/dev/null 2>&1 || rc=1
done
exit $rc
