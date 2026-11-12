#!/usr/bin/env bash
# 把 Kenney 的两个 ogg 原件转成游戏用的单声道 44.1 kHz 16 位 wav（需要 ffmpeg）。
# 用法：bash client/art_source/convert_sfx.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../town/assets/audio/sfx"
mkdir -p "$OUT"
# 确认音：去掉开头静音，音量归一到约 -3 dB 峰值
ffmpeg -v error -y -i "$HERE/source/audio/kenney_interface_confirmation_001.ogg" \
  -af "silenceremove=start_periods=1:start_threshold=-50dB,loudnorm=I=-18:TP=-3:LRA=7" \
  -ac 1 -ar 44100 -c:a pcm_s16le "$OUT/confirm.wav"
# 脚步声：同样处理，音量比确认音略低
ffmpeg -v error -y -i "$HERE/source/audio/kenney_impact_footstep_concrete_001.ogg" \
  -af "silenceremove=start_periods=1:start_threshold=-50dB,loudnorm=I=-22:TP=-4:LRA=7" \
  -ac 1 -ar 44100 -c:a pcm_s16le "$OUT/footstep.wav"
ls -l "$OUT"
