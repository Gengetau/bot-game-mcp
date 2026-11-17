"""把一首曲子做成可循环的片段：在 [s, e) 里找最像「曲子开头」的结束点，再做首尾交叉淡化。
用法: loop.py 输入 输出.wav s秒 e最小秒 e最大秒 淡化秒 [尾部渐弱秒]
"""
import sys, subprocess
import numpy as np

SR = 44100

def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-'], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()

def save(path, a):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-c:a', 'pcm_f32le', path], input=a.astype(np.float32).tobytes(), check=True)

def frames(mono, hop=SR // 10, nb=64):
    win = np.hanning(4096)
    edges = np.geomspace(60, 8000, nb + 1)
    f = np.fft.rfftfreq(4096, 1 / SR)
    idx = np.digitize(f, edges) - 1
    out = []
    for i in range(0, len(mono) - 4096, hop):
        sp = np.abs(np.fft.rfft(mono[i:i + 4096] * win))
        b = np.zeros(nb)
        np.add.at(b, np.clip(idx, 0, nb - 1), sp)
        v = np.log1p(b * 20)
        v = v - v.mean()
        n = np.linalg.norm(v)
        out.append(v / n if n > 1e-6 else v)
    return np.array(out)

def main():
    src, dst = sys.argv[1], sys.argv[2]
    s_sec, e0, e1, F = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
    x = load(src)
    mono = x.mean(axis=1)
    hop = SR // 10
    fr = frames(mono)
    s = int(s_sec * SR)
    K = 100  # 10 秒的上下文
    sf = s // hop
    ref = fr[sf:sf + K]
    best = (-9, 0)
    for ef in range(int(e0 * 10), min(int(e1 * 10), len(fr) - K - int(F * 10) - 2)):
        sc = float(np.mean(np.sum(ref * fr[ef:ef + K], axis=1)))
        if sc > best[0]:
            best = (sc, ef)
    score, ef = best
    e = ef * hop
    # 细调到 ±100ms：用开头 1 秒和结尾候选处 1 秒的波形互相关
    w = SR
    a = mono[s:s + w]
    bestc, bo = -9, 0
    for off in range(-SR // 10, SR // 10, 4):
        seg = mono[e + off:e + off + w]
        if len(seg) < w:
            continue
        c = float(np.dot(a, seg) / (np.linalg.norm(a) * np.linalg.norm(seg) + 1e-9))
        if c > bestc:
            bestc, bo = c, off
    e += bo
    n = int(F * SR)
    t = np.linspace(0, np.pi / 2, n)[:, None]
    head = x[s:s + n] * np.sin(t) + x[e:e + n] * np.cos(t)  # 等功率
    y = np.concatenate([head, x[s + n:e]])
    save(dst, y)
    print(f'{src.split("/")[-1]}: s={s/SR:.2f}s e={e/SR:.2f}s len={len(y)/SR:.1f}s 相似度={score:.3f} 波形互相关={bestc:.3f} 淡化={F}s')

main()
