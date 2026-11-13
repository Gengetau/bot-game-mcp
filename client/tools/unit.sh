#!/usr/bin/env bash
# 客户端逻辑单测：无头 Godot 直接跑 client/tests/*_test.gd，不起浏览器、不用导出（每个文件不到一秒）。
# 退出码：任何一个文件有 FAIL 行、脚本报错或退出码非零就非零。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GODOT="${GODOT:-/opt/godot/godot}"
rc=0
for f in "$ROOT"/client/tests/*_test.gd; do
  echo "[unit] $(basename "$f")"
  out="$("$GODOT" --headless --path "$ROOT/client/town" --script "$f" 2>&1)"
  code=$?
  echo "$out" | grep -v "^Godot Engine\|^$"
  if [ $code -ne 0 ] || echo "$out" | grep -q "^FAIL\|SCRIPT ERROR"; then rc=1; fi
done
exit $rc
