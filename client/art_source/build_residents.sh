#!/usr/bin/env bash
# 重新生成居民底模和动作库（见 client/ASSETS.md「居民」一节）。
# 用法：bash client/art_source/build_residents.sh <KayKit_Adventurers_2.0_FREE 目录> <KayKit_Character_Animations_1.1 目录>
# 需要 Godot 4.7.x（GODOT 环境变量，默认 /opt/godot/godot）和 Python 3 + Pillow（贴图配色另见 recolor_residents.py）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADV="${1:?第一个参数：KayKit_Adventurers_2.0_FREE 解压目录}"
ANI="${2:?第二个参数：KayKit_Character_Animations_1.1 解压目录}"
GODOT="${GODOT:-/opt/godot/godot}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/src"
for b in Rogue Ranger Mage Knight; do cp "$ADV/Characters/gltf/$b.glb" "$TMP/src/"; done
for a in General MovementBasic Simulation; do cp "$ANI/Animations/gltf/Rig_Medium/Rig_Medium_$a.glb" "$TMP/src/"; done
cp "$ROOT/client/art_source/build_residents.gd" "$TMP/"
printf 'config_version=5\n[application]\nconfig/name="build-residents"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n' >"$TMP/project.godot"
"$GODOT" --headless --path "$TMP" --import >/dev/null 2>&1 || true
OUT="$ROOT/client/town/assets/models/characters"
mkdir -p "$OUT"
"$GODOT" --headless --path "$TMP" --script res://build_residents.gd -- out="$OUT" 2>&1 | grep -E "^(save|anim)|ERROR|SCRIPT" || true
