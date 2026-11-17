#!/usr/bin/env python3
"""把 Kenney Fantasy Town Kit 的糖果色调色板贴图重新配色成栖灯镇的色板（米白、木棕、灰蓝屋顶、柔和的绿）。

用法：python3 -I client/art_source/recolor_kenney.py <原版 Textures/colormap.png> <输出 png>

原图是 512x512 的调色板：每个色块宽 32 像素、高 128 像素（竖向渐变），只用到中间三行。
做法：按色块求平均色，归到「色带」（木、屋顶、草木、石、红……），整块按色带的规则变换色相/饱和度/明度，
同一色块里的渐变保持（所以明暗关系还在）。另外在左上角画一小块纯白（16x16），给程序生成的几何体取色用
（顶点色 × 白色 = 顶点色），这样整个静态场景可以共用一张贴图、一种材质。

输出已经提交在 client/town/assets/models/kenney/Textures/colormap.png，需要重做时再跑本脚本（需要 Pillow）。
"""
import colorsys
import sys

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
px = im.load()
W, H = im.size


def band(r, g, b):
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    d = h * 360
    if s < 0.10:
        return "neutral"
    if 205 <= d < 300 and s < 0.6:
        return "stone"
    if 158 <= d < 200:
        return "roof"
    if 100 <= d < 158:
        return "green"
    if 5 <= d < 40 and s > 0.35:
        return "orange_bright" if (v > 0.95 and s > 0.7) else "wood"
    if (d >= 340 or d < 5) and s > 0.35:
        return "red"
    if 200 <= d < 240 and s >= 0.6:
        return "blue"
    return "other"


def xf(bd, h, s, v):
    if bd == "neutral":
        if v > 0.9:
            return 40 / 360, 0.12, 0.95
        return 36 / 360, 0.09 + s * 0.5, v * 0.96
    if bd == "stone":
        return 34 / 360, 0.10 + s * 0.12, v * 0.86
    if bd == "roof":
        return 212 / 360, 0.28 + s * 0.08, v * 0.80
    if bd == "green":
        return 98 / 360, s * 0.55, v * 0.88
    if bd == "orange_bright":
        return h, s * 0.85, v
    if bd == "wood":
        return 27 / 360, s * 0.60, v * 0.80
    if bd == "red":
        return 12 / 360, s * 0.72, v * 0.86
    if bd == "blue":
        return 210 / 360, s * 0.5, v * 0.92
    return h, s * 0.85, v


BW, BH = 32, 128
for by in range(0, H, BH):
    for bx in range(0, W, BW):
        rs = gs = bs = n = 0
        for y in range(by, by + BH, 8):
            for x in range(bx, bx + BW, 8):
                r, g, b, a = px[x, y]
                if a:
                    rs += r
                    gs += g
                    bs += b
                    n += 1
        if not n:
            continue
        bd = band(rs / n, gs / n, bs / n)
        for y in range(by, by + BH):
            for x in range(bx, bx + BW):
                r, g, b, a = px[x, y]
                h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                nh, ns, nv = xf(bd, h, s, v)
                r2, g2, b2 = colorsys.hsv_to_rgb(nh, max(0, min(1, ns)), max(0, min(1, nv)))
                px[x, y] = (int(r2 * 255), int(g2 * 255), int(b2 * 255), a)

# 左上角留一块纯白：程序生成的几何体 UV 指向这里，颜色全靠顶点色
for y in range(0, 16):
    for x in range(0, 16):
        px[x, y] = (255, 255, 255, 255)
# 顶部其余是原图的空白区，填成不透明白色，免得有透明边缘（整张贴图不带 alpha）
for y in range(0, 128):
    for x in range(0, W):
        if px[x, y][3] == 0 or (x >= 16 or y >= 16):
            px[x, y] = (255, 255, 255, 255)

im.convert("RGB").save(dst, optimize=True)
print("ok", dst)
