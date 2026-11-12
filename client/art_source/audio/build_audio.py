#!/usr/bin/env python3
"""栖灯镇音频的再生成脚本（需要 ffmpeg 带 libvorbis、numpy）。

用法：python3 -I client/art_source/audio/build_audio.py <RAW 目录> [候选输出目录]

RAW 目录放下载来的原始素材（不进仓库，体积大；来源与 sha256 见 client/ASSETS.md），布局：
  RAW/hot-springs-town/hot_spring_town_1.ogg   RAW/forget-me-not/forget_me_not_in_f_major_0.ogg
  RAW/quaint-town/Quaint_Town_-_LOOPABLE.wav   RAW/hush-hamlet/hush_hamlet_loop_0.wav
  RAW/sunset-plains/sunset_plains.wav          RAW/lonely-night/night_tune3_0.ogg
  RAW/park-ambiences/park_ambience_{birds,river,wind}.wav
  RAW/crickets-ambient-noise-loopable/crickets_1.mp3   RAW/fireplace-sound-loop/fire.wav
音效的 Kenney 原件在 client/art_source/source/audio/（进仓库）。

输出：
  client/town/stream/music/{day,night}.ogg       音乐（不进 pck，进游戏后用 HTTPRequest 取）
  client/town/assets/audio/ambience/*.ogg        环境声（进 pck，单声道）
  client/town/assets/audio/sfx/*.ogg             音效（进 pck，单声道）
  候选目录（可选）：每首音乐候选的成品 ogg，供试听
响度：音乐 -23 LUFS（积分），环境声各自的目标见下表，音效按峰值归一。
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC_SFX = os.path.join(ROOT, 'art_source', 'source', 'audio')
OUT_MUSIC = os.path.join(ROOT, 'town', 'stream', 'music')
OUT_AMB = os.path.join(ROOT, 'town', 'assets', 'audio', 'ambience')
OUT_SFX = os.path.join(ROOT, 'town', 'assets', 'audio', 'sfx')

RAW = os.path.abspath(sys.argv[1])
CAND = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else None
TMP = os.path.join(CAND or RAW, '_work')
for d in (OUT_MUSIC, OUT_AMB, OUT_SFX, TMP):
    os.makedirs(d, exist_ok=True)
if CAND:
    os.makedirs(CAND, exist_ok=True)


def run(*args):
    subprocess.run(args, check=True)


def py(script, *args):
    run('python3', '-I', os.path.join(HERE, script), *args)


def lufs(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True).stderr
    return float(re.search(r'Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS', r[r.rfind('Summary:'):]).group(1))


def encode(src, dst, target_lufs, bitrate, mono=False, extra=''):
    gain = target_lufs - lufs(src)
    af = f'{extra}volume={gain:.2f}dB,alimiter=limit=0.89:level=disabled'
    cmd = ['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', af, '-ar', '44100']
    if mono:
        cmd += ['-ac', '1']
    cmd += ['-c:a', 'libvorbis', '-b:a', bitrate, dst]
    run(*cmd)
    print(f'  {os.path.basename(dst)}: 增益 {gain:+.1f} dB，{os.path.getsize(dst)/1024:.0f} KB')


# ── 音乐：先做循环（找最像开头的结束点 + 等功率交叉淡化），再响度归一并编码 ──
# 名字: (原件, 起点秒, 结束点搜索区间, 淡化秒)；hush 是作者自己给的循环版，不再剪
MUSIC = {
    'quaint': ('quaint-town/Quaint_Town_-_LOOPABLE.wav', 0, 50, 100, 1.5),
    'fmn': ('forget-me-not/forget_me_not_in_f_major_0.ogg', 0, 60, 150, 1.5),
    'hst': ('hot-springs-town/hot_spring_town_1.ogg', 0, 60, 140, 1.5),
    'sunset': ('sunset-plains/sunset_plains.wav', 90, 150, 220, 2.5),
    'lonely': ('lonely-night/night_tune3_0.ogg', 0, 25, 58, 1.0),
}
print('音乐')
loops = {}
for k, (f, s, e0, e1, F) in MUSIC.items():
    out = os.path.join(TMP, f'{k}_loop.wav')
    py('loop.py', os.path.join(RAW, f), out, str(s), str(e0), str(e1), str(F))
    loops[k] = out
loops['hush'] = os.path.join(RAW, 'hush-hamlet', 'hush_hamlet_loop_0.wav')
FINAL = {'day': 'quaint', 'night': 'hush'}
if CAND:
    for k, wav in loops.items():
        encode(wav, os.path.join(CAND, f'music_candidate_{k}.ogg'), -23, '80k')
for use, k in FINAL.items():
    encode(loops[k], os.path.join(OUT_MUSIC, f'{use}.ogg'), -23, '80k')

# ── 环境声（单声道，循环点做交叉淡化）──
print('环境声')
PA = os.path.join(RAW, 'park-ambiences')
py('segpick.py', os.path.join(PA, 'park_ambience_birds.wav'), os.path.join(TMP, 'birds.wav'), 'birdy', '36', '3')
py('segpick.py', os.path.join(PA, 'park_ambience_wind.wav'), os.path.join(TMP, 'wind.wav'), 'steady', '36', '3')
run('ffmpeg', '-v', 'error', '-y', '-i', os.path.join(TMP, 'birds.wav'), '-i', os.path.join(TMP, 'wind.wav'), '-filter_complex', 'amix=inputs=2:weights=1 0.5:normalize=0', os.path.join(TMP, 'day_bed.wav'))
encode(os.path.join(TMP, 'day_bed.wav'), os.path.join(OUT_AMB, 'day.ogg'), -34, '40k', mono=True, extra='lowpass=f=11000,')
run('ffmpeg', '-v', 'error', '-y', '-i', os.path.join(RAW, 'crickets-ambient-noise-loopable', 'crickets_1.mp3'), '-c:a', 'pcm_f32le', os.path.join(TMP, 'crickets.wav'))
encode(os.path.join(TMP, 'crickets.wav'), os.path.join(OUT_AMB, 'night.ogg'), -36, '40k', mono=True)
py('segpick.py', os.path.join(PA, 'park_ambience_river.wav'), os.path.join(TMP, 'river.wav'), 'steady', '24', '3')
encode(os.path.join(TMP, 'river.wav'), os.path.join(OUT_AMB, 'fountain.ogg'), -30, '40k', mono=True, extra='lowpass=f=10000,')
# 室内：壁炉噼啪声 + 很低的棕噪声当房间底声（自制，无版权问题）
run('ffmpeg', '-v', 'error', '-y', '-i', os.path.join(RAW, 'fireplace-sound-loop', 'fire.wav'), '-f', 'lavfi', '-i', 'anoisesrc=c=brown:a=0.3:d=29.263:r=44100:seed=7', '-filter_complex',
    '[1:a]lowpass=f=350[n];[0:a][n]amix=inputs=2:weights=1 0.5:normalize=0:duration=first', '-c:a', 'pcm_f32le', os.path.join(TMP, 'indoor.wav'))
encode(os.path.join(TMP, 'indoor.wav'), os.path.join(OUT_AMB, 'indoor.ogg'), -36, '40k', mono=True, extra='lowpass=f=9000,')

# ── 音效：去开头静音，峰值归一到给定 dBFS，末尾 15ms 渐出，单声道 ──
print('音效')
SFX = {
    # 名字: (原件, 峰值 dBFS, 最长秒数)
    'confirm': ('kenney_interface_confirmation_001.ogg', -9, 1.0),
    'step': ('kenney_impact_footstep_concrete_001.ogg', -16, 1.0),
    'tap': ('kenney_interface_select_005.ogg', -12, 0.5),
    'fail': ('kenney_interface_error_005.ogg', -10, 0.6),
    'start': ('kenney_interface_confirmation_004.ogg', -9, 0.6),
    'mail': ('kenney_interface_glass_001.ogg', -8, 0.4),
    'panel_open': ('kenney_rpg_bookOpen.ogg', -12, 0.4),
    'panel_close': ('kenney_rpg_bookClose.ogg', -12, 0.4),
    'coin': ('kenney_rpg_handleCoins2.ogg', -10, 0.5),
    'door': ('kenney_rpg_doorOpen_1.ogg', -12, 0.8),
}
for name, (f, peak, maxlen) in SFX.items():
    src = os.path.join(SRC_SFX, f)
    # 先测去静音后的峰值，再定增益
    chain = 'silenceremove=start_periods=1:start_threshold=-50dB,'
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', src, '-af', chain + f'atrim=0:{maxlen},volumedetect', '-f', 'null', '-'], capture_output=True, text=True).stderr
    mx = float(re.search(r'max_volume: (-?[\d.]+) dB', r).group(1))
    gain = peak - mx
    dst = os.path.join(OUT_SFX, f'{name}.ogg')
    run('ffmpeg', '-v', 'error', '-y', '-i', src, '-af', f'{chain}atrim=0:{maxlen},volume={gain:.2f}dB,areverse,afade=t=in:d=0.015,areverse,aresample=44100', '-ac', '1', '-c:a', 'libvorbis', '-q:a', '3', dst)
    print(f'  {name}.ogg: 增益 {gain:+.1f} dB，{os.path.getsize(dst)/1024:.1f} KB')
