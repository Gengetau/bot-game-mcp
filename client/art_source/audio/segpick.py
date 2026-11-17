"""在长录音里挑一段做环境声循环。python3 -I segpick.py 输入 输出.wav 模式(steady|birdy) 秒数 淡化秒
steady：100ms 响度起伏最小的一段（水声、风声）；birdy：2–6kHz 频段起伏最大、总响度不过高的一段（鸟叫多）。
挑出后头尾做等功率交叉淡化，输出立体声 float wav（44.1k）。"""
import sys, subprocess
import numpy as np
SR = 44100
src, dst, mode, dur, F = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-'], capture_output=True).stdout
x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()
m = x.mean(axis=1)
hop = SR // 10
n = len(m) // hop
fr = m[:n * hop].reshape(n, hop)
rms = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-6)
# 2-6k 频段
win = np.hanning(hop)
sp = np.abs(np.fft.rfft(fr * win, axis=1))
f = np.fft.rfftfreq(hop, 1 / SR)
band = 20 * np.log10(sp[:, (f > 2000) & (f < 6000)].sum(axis=1) + 1e-6)
W = int(dur * 10)
best = None
for i in range(0, n - W, 10):
    r, b = rms[i:i + W], band[i:i + W]
    if mode == 'steady':
        sc = -float(r.std())
    else:
        sc = float(b.std()) - 0.3 * max(0.0, float(r.mean()) + 35)
    if best is None or sc > best[0]:
        best = (sc, i)
sc, i = best
s = i * hop
seg = x[s:s + int(dur * SR) + int(F * SR)]
nF = int(F * SR)
t = np.linspace(0, np.pi / 2, nF)[:, None]
head = seg[:nF] * np.sin(t) + seg[-nF:] * np.cos(t)
y = np.concatenate([head, seg[nF:-nF]])
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'pcm_f32le', dst], input=y.astype(np.float32).tobytes(), check=True)
print(f'{src.split("/")[-1]} {mode}: 从 {s/SR:.1f}s 取 {dur}s，得到 {len(y)/SR:.1f}s，score={sc:.2f}')
