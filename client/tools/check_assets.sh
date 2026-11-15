#!/usr/bin/env bash
# 资产套件校验（Godot 无头）：扫 client/town/assets/kits/ 下每件资产，任何一条不过就非零退出，输出说清是哪件资产的哪一条。
# 用法：bash client/tools/check_assets.sh [<套件>/<资产编号> ...]    环境变量 GODOT 指向 Godot 4.7 可执行文件
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${GODOT:?请设置环境变量 GODOT 指向 Godot 4.7 可执行文件}"
CACHE="$ROOT/client/town/.godot/global_script_class_cache.cfg"
declared="$(grep -rhoE '^class_name[[:space:]]+[A-Za-z0-9_]+' "$ROOT/client/town" --include='*.gd' --exclude-dir=.godot --exclude-dir=build 2>/dev/null | awk '{print $2}' | sort -u)"
cached="$(grep -oE '"class": &"[A-Za-z0-9_]+"' "$CACHE" 2>/dev/null | sed -E 's/.*&"([^"]+)"/\1/' | sort -u)"
# 有哪件套件的 GLB 还没被这份工程导入过（刚拉下来的、刚从别的工作树拷来的）：也要先导入，否则校验读到的是没有导入结果的场景，
# 报出来的是「找不到资产根节点」这种看不出原因的话
stale=0
while IFS= read -r glb; do
  [ -n "$glb" ] || continue
  if ! ls "$ROOT/client/town/.godot/imported/$(basename "$glb")"-*.scn >/dev/null 2>&1; then
    stale=1
  fi
done < <(find "$ROOT/client/town/assets/kits" -name '*.glb' 2>/dev/null)
if [ ! -f "$CACHE" ] || [ "$declared" != "$cached" ] || [ "$stale" = 1 ]; then
  echo "[assets] 导入缓存没有、类名和脚本对不上，或者有 GLB 还没导入：先导入一遍资源…"
  timeout 900 "$GODOT" --headless --path "$ROOT/client/town" --import >/dev/null 2>&1 || true
fi
args=()
if [ "$#" -gt 0 ]; then args=(-- "$@"); fi
out="$(timeout "${ASSETS_TIMEOUT:-300}" "$GODOT" --headless --path "$ROOT/client/town" --script "$ROOT/client/tools/check_assets.gd" "${args[@]}" 2>&1)"
code=$?
echo "$out" | grep -v "^Godot Engine\|^$\|leaked\|RID allocations\|ObjectDB\|PagedAllocator\|Leaked instance\|still in use\|at: "
if [ $code -ne 0 ] || echo "$out" | grep -q "^FAIL\|SCRIPT ERROR"; then
  echo "[assets] 校验没有通过"
  exit 1
fi
echo "[assets] 校验通过"
