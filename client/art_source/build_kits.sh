#!/usr/bin/env bash
# 重建资产套件：对每件资产跑 build.py（Blender 无头）生成 GLB -> 让 Godot 导入 GLB -> 生成包装场景和清单 -> 跑校验。
# 用法：
#   bash client/art_source/build_kits.sh                      # 全部资产
#   bash client/art_source/build_kits.sh sample/station_sample # 只建指定的（可以写多个，格式 <套件>/<资产编号>）
# 环境变量：BLENDER（Blender 可执行文件，要 4.2 以上，实测 5.2.3）、GODOT（Godot 4.7 可执行文件）。路径带空格也行。
# Windows 的 Git Bash 和 Linux 都能跑：Windows 例  export BLENDER="D:/steam/steamapps/common/Blender/blender.exe"
# 重建不会删 .import 文件（里面是 GLB 的 uid；删了重新导入会换一个 uid，让包装场景之外的引用对不上）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${BLENDER:?请设置环境变量 BLENDER 指向 Blender 可执行文件}"
: "${GODOT:?请设置环境变量 GODOT 指向 Godot 4.7 可执行文件}"
SRC="$ROOT/client/art_source/kits"
OUT="$ROOT/client/town/assets/kits"
PROJ="$ROOT/client/town"

targets=()
if [ "$#" -gt 0 ]; then
  for t in "$@"; do targets+=("$t"); done
else
  for f in "$SRC"/*/*/build.py; do
    d="$(dirname "$f")"
    targets+=("$(basename "$(dirname "$d")")/$(basename "$d")")
  done
fi
if [ "${#targets[@]}" -eq 0 ]; then echo "[kits] 没有找到任何 build.py"; exit 1; fi

for t in "${targets[@]}"; do
  if [ ! -f "$SRC/$t/build.py" ]; then echo "[kits] 没有 $SRC/$t/build.py"; exit 1; fi
  id="$(basename "$t")"
  mkdir -p "$OUT/$t"
  echo "[kits] Blender 生成 $t"
  rm -f "$OUT/$t/$id.glb"  # 先删旧的：build.py 失败时不能让旧 GLB 蒙混过关（.import 留着）
  rc=0
  out="$("$BLENDER" -b --factory-startup --python "$SRC/$t/build.py" -- "$OUT/$t/$id.glb" 2>&1)" || rc=$?
  echo "$out" | grep "^\[kit\]\|Error\|Traceback\|^  " || true
  if [ "$rc" -ne 0 ] || [ ! -s "$OUT/$t/$id.glb" ]; then echo "[kits] $t 的 build.py 失败（退出码 $rc）"; exit 1; fi
done

echo "[kits] Godot 导入 GLB"
"$GODOT" --headless --path "$PROJ" --import >/dev/null 2>&1 || true
echo "[kits] 生成包装场景和清单"
rc=0
out="$("$GODOT" --headless --path "$PROJ" --script "$ROOT/client/tools/kit_wrap.gd" -- "${targets[@]}" 2>&1)" || rc=$?
echo "$out" | grep "^\[wrap\]\|FAIL\|SCRIPT ERROR\|^ERROR: Parse" || true
if [ "$rc" -ne 0 ]; then echo "[kits] 生成包装场景失败（退出码 $rc）"; exit 1; fi
echo "[kits] 校验"
bash "$ROOT/client/tools/check_assets.sh" "${targets[@]}"
