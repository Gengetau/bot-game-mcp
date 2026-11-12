#!/usr/bin/env python3
"""居民外观：把 KayKit 底模的调色板贴图重新配色成 8 套日常服装 / 发色 / 肤色。

用法：python3 -I client/art_source/recolor_residents.py <KayKit_Adventurers_2.0_FREE 目录> <输出目录>

KayKit 的贴图是 1024x1024、8x8 个格子（每格 128 像素，竖向渐变），每两行格子是一个色块的上下两半。
一个「色块」用 (列, 行对) 表示，行对 = 格子行 // 2。每个色块按目标色换色，同时保留块内的明暗渐变
（新色 = 目标色 x 像素亮度 / 块内平均亮度），所以阴影、描边的层次不变，只是换了颜色。
输出 128x128 的 RGB png（每格 16 像素，运行时用线性过滤、不要 mipmap）。
每套外观对应哪个底模、哪些色块，写在下面的 OUTFITS 里；换色块用的是对 KayKit 四个底模的实测（见 ASSETS.md）。
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(sys.argv[1]) / "Characters" / "gltf"
OUT = Path(sys.argv[2])

# 各底模的色块角色 (列, 行对)
ROLES = {
    "rogue": {"skin": (0, 0), "hair": (1, 0), "top": (0, 1), "collar": (1, 1), "belt": (5, 0), "pants": (3, 2), "boots": (7, 1)},
    "ranger": {"skin": (0, 0), "hair": (1, 0), "scarf": (0, 1), "shirt": (6, 0), "vest": (7, 0), "pants": (3, 2)},
    "mage": {"skin": (0, 0), "hair": (1, 0), "coat": (0, 1), "belt": (5, 0), "boots": (3, 2), "pants": (7, 1)},
    "knight": {"skin": (0, 0), "hair": (1, 0), "coat": (3, 0), "coat2": (7, 0), "coat3": (2, 1), "belt": (6, 0), "boots": (7, 1)},
}

SKIN = {"fair": "#f2c6a4", "light": "#e8b48e", "tan": "#cf966e", "brown": "#a86f4c", "deep": "#80523a"}

# 8 套：底模 + {角色: 颜色}。肤色用 SKIN 里的名字（对 skin 色块），其余是 #rrggbb。
OUTFITS = [
    ("rogue", {"skin": "fair", "hair": "#6b4a36", "top": "#6f9a72", "collar": "#9cbf8e", "belt": "#a8754d", "pants": "#7a6350", "boots": "#5c4636"}),
    ("rogue", {"skin": "tan", "hair": "#2d2523", "top": "#c0714f", "collar": "#e0b17f", "belt": "#6f5039", "pants": "#4f5d6b", "boots": "#4a3a30"}),
    ("ranger", {"skin": "light", "hair": "#8a5a3b", "scarf": "#6f93b6", "shirt": "#efe3d2", "vest": "#8a6a4e", "pants": "#7d7367"}),
    ("ranger", {"skin": "brown", "hair": "#2b2220", "scarf": "#d98a76", "shirt": "#f1d9a0", "vest": "#5f7a6a", "pants": "#4d5560"}),
    ("mage", {"skin": "light", "hair": "#2a2427", "coat": "#b97e8c", "belt": "#d6a45c", "boots": "#6d4f3f", "pants": "#4a4455"}),
    ("mage", {"skin": "deep", "hair": "#6a4a3a", "coat": "#5f8f93", "belt": "#c58b4e", "boots": "#5a4437", "pants": "#3f4d52"}),
    ("knight", {"skin": "fair", "hair": "#d8b878", "coat": "#56688a", "coat2": "#8d9bb5", "coat3": "#c9d0dc", "belt": "#8a6445", "boots": "#46403d"}),
    ("knight", {"skin": "tan", "hair": "#3b2e2a", "coat": "#7d8f70", "coat2": "#aeb99f", "coat3": "#e6e0cc", "belt": "#6d5139", "boots": "#4a4036"}),
]


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def lum(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def build(base, spec):
    im = np.asarray(Image.open(SRC / f"{base}_texture.png").convert("RGB"), dtype=np.float32).copy()
    roles = ROLES[base]
    for role, col in spec.items():
        c, rp = roles[role]
        target = hex_rgb(SKIN[col] if role == "skin" else col)
        reg = im[rp * 256 : (rp + 1) * 256, c * 128 : (c + 1) * 128]
        m = max(1.0, float(lum(reg).mean()))
        k = (lum(reg) / m)[..., None]
        # 压一下对比：渐变的上下端不要拉得太开
        k = 1.0 + (k - 1.0) * 0.8
        im[rp * 256 : (rp + 1) * 256, c * 128 : (c + 1) * 128] = np.clip(target * k, 0, 255)
    out = Image.fromarray(im.astype(np.uint8)).resize((128, 128), Image.BOX)
    return out


OUT.mkdir(parents=True, exist_ok=True)
for i, (base, spec) in enumerate(OUTFITS):
    p = OUT / f"outfit_{i}.png"
    build(base, spec).save(p, optimize=True)
    print(p, base)
