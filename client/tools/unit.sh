#!/usr/bin/env bash
# 客户端逻辑单测：无头 Godot 直接跑 client/tests/*_test.gd，不起浏览器、不用导出（每个文件不到一秒）。
# 退出码：任何一个文件有 FAIL 行、脚本报错或退出码非零就非零。
# 每个文件限时（UNIT_TIMEOUT 秒，默认 120）：测试脚本在 _init 里出错就走不到 quit()，无头 Godot 会一直空转不退出；
# 超时算失败（退出码 124），不让一个坏文件把后面的检查（和排队等同一把锁的别的任务）一直堵着。
# 新的工作树（没有 client/town/.godot/）要先导入一遍，全局类名才认得，否则 load() 拿不到脚本——正是上面那种空转。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GODOT="${GODOT:-/opt/godot/godot}"
LIMIT="${UNIT_TIMEOUT:-120}"
if [ ! -d "$ROOT/client/town/.godot" ]; then
  echo "[unit] 没有导入缓存，先导入一遍资源…"
  timeout 900 "$GODOT" --headless --path "$ROOT/client/town" --import >/dev/null 2>&1 || true
fi
rc=0
for f in "$ROOT"/client/tests/*_test.gd; do
  echo "[unit] $(basename "$f")"
  out="$(timeout "$LIMIT" "$GODOT" --headless --path "$ROOT/client/town" --script "$f" 2>&1)"
  code=$?
  echo "$out" | grep -v "^Godot Engine\|^$"
  if [ $code -eq 124 ]; then echo "FAIL: $(basename "$f") 超过 ${LIMIT} 秒没有退出（多半是脚本出错、没走到 quit()）"; fi
  if [ $code -ne 0 ] || echo "$out" | grep -q "^FAIL\|SCRIPT ERROR"; then rc=1; fi
done
exit $rc
