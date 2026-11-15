"""公共厨房标准工位 stove_station：2.0 x 1.5 米砖砌双眼灶台。
轮廓、比例和配色对齐《栖灯镇》低多边形暖色街景（town_art.gd），四个状态在 50 度斜俯视默认镜头下只看颜色与形状即可区分。
用法（build_kits.sh 会调）：blender -b --factory-startup --python build.py -- <输出的.glb>

锚点和服务端地图 town-map.ts 里 kitchen:stove1 对账：物件中心 (48, 2.75)，使用位 (47.75, 4.25) 和 (48.75, 4.25)，
换算到资产局部（原点在占地中心、正面朝 +z）就是 (-0.25, 0, 1.5) 和 (0.75, 0, 1.5)。
"""
import math
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools"))
import kit_lib as K  # noqa: E402

# 线性顶点色板（与 town_art.gd 墙/木/石/暖灯一致，不用纯黑纯白）
STONE_BASE = (0.65, 0.62, 0.57)
STONE_DARK = (0.36, 0.35, 0.37)
BRICK_A = (0.72, 0.41, 0.30)
BRICK_B = (0.78, 0.54, 0.34)
BRICK_MORTAR = (0.54, 0.32, 0.24)
PLASTER_FLUE = (0.88, 0.83, 0.74)
TIMBER = (0.52, 0.37, 0.26)
TIMBER_D = (0.40, 0.28, 0.20)
TIMBER_L = (0.68, 0.50, 0.34)
WOOD_LOG = (0.66, 0.48, 0.32)
WOOD_BARK = (0.44, 0.31, 0.22)
IRON = (0.24, 0.24, 0.27)
POT_COLD = (0.44, 0.46, 0.50)
POT_IRON = (0.30, 0.30, 0.34)
POT_COPPER = (0.74, 0.44, 0.28)
POT_CHAR = (0.22, 0.20, 0.22)
FIRE_BRIGHT = (1.00, 0.56, 0.16)
FIRE_CORE = (1.00, 0.76, 0.28)
EMBER_DIM = (0.68, 0.22, 0.12)
ASH_DARK = (0.18, 0.17, 0.18)
SOOT = (0.15, 0.14, 0.15)
SMOKE_A = (0.19, 0.18, 0.20)
SMOKE_B = (0.25, 0.24, 0.26)
CREAM = (0.94, 0.90, 0.82)
STEAM = (0.92, 0.91, 0.88)
SOUP = (0.88, 0.60, 0.20)
HERB = (0.48, 0.66, 0.36)
BREAD = (0.82, 0.62, 0.36)
CLOTH = (0.90, 0.84, 0.72)


def _shade(c, k):
    return (c[0] * k, c[1] * k, c[2] * k)


def _rot_pt(p, tilt_x=0.0, tilt_z=0.0, yaw=0.0):
    x, y, z = p
    if tilt_x:
        a = math.radians(tilt_x)
        ca, sa = math.cos(a), math.sin(a)
        y, z = y * ca - z * sa, y * sa + z * ca
    if tilt_z:
        a = math.radians(tilt_z)
        ca, sa = math.cos(a), math.sin(a)
        x, y = x * ca - y * sa, x * sa + y * ca
    if yaw:
        a = math.radians(yaw)
        ca, sa = math.cos(a), math.sin(a)
        x, z = x * ca + z * sa, -x * sa + z * ca
    return (x, y, z)


class MeshBuf:
    """把多个闭合低多边形子体合并成一个 K.mesh，以严守网格数上限（<= 32）并保留逐面颜色。"""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.colors = []

    def add_poly(self, pts, face_defs, face_cols):
        base = len(self.verts)
        self.verts.extend(pts)
        for fi, f in enumerate(face_defs):
            self.faces.append(tuple(base + i for i in f))
            self.colors.append(face_cols[fi % len(face_cols)])

    def box(self, center, size, color, bottom_dark=1.0, tilt_x=0.0, tilt_z=0.0, yaw=0.0):
        hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
        raw = [
            (-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
            (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz),
        ]
        cx, cy, cz = center
        pts = []
        for p in raw:
            rx, ry, rz = _rot_pt(p, tilt_x, tilt_z, yaw)
            pts.append((cx + rx, cy + ry, cz + rz))
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 4, 7, 3), (1, 2, 6, 5), (3, 7, 6, 2), (0, 1, 5, 4)]
        cols = [color, color, _shade(color, 0.94), _shade(color, 0.94), _shade(color, 1.04), _shade(color, 0.8 * bottom_dark)]
        self.add_poly(pts, f, cols)

    def block(self, x0, x1, y0, y1, z0, z1, color, bottom_dark=1.0):
        self.box(((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5), (x1 - x0, y1 - y0, z1 - z0), color, bottom_dark=bottom_dark)

    def cyl(self, base_pos, r_bot, r_top, h, color, seg=8, tilt_x=0.0, tilt_z=0.0, yaw=0.0, top_color=None):
        raw = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            raw.append((r_bot * math.cos(a), 0.0, r_bot * math.sin(a)))
        f = []
        cols = []
        if r_top < 1e-6:
            raw.append((0.0, h, 0.0))
            for i in range(seg):
                f.append((i, (i + 1) % seg, seg))
                cols.append(_shade(color, 0.92 + 0.08 * (i % 2)))
            f.append(tuple(range(seg - 1, -1, -1)))
            cols.append(_shade(color, 0.72))
        else:
            for i in range(seg):
                a = 2 * math.pi * i / seg
                raw.append((r_top * math.cos(a), h, r_top * math.sin(a)))
            for i in range(seg):
                j = (i + 1) % seg
                f.append((i, j, seg + j, seg + i))
                cols.append(_shade(color, 0.92 + 0.08 * (i % 2)))
            f.append(tuple(range(seg - 1, -1, -1)))
            cols.append(_shade(color, 0.72))
            f.append(tuple(range(seg, 2 * seg)))
            cols.append(top_color if top_color is not None else _shade(color, 1.05))
        bx, by, bz = base_pos
        pts = []
        for p in raw:
            rx, ry, rz = _rot_pt(p, tilt_x, tilt_z, yaw)
            pts.append((bx + rx, by + ry, bz + rz))
        self.add_poly(pts, f, cols)

    def frustum(self, y0, y1, rx0, rz0, rx1, rz1, xc, zc, color):
        """轴对齐四棱台，用于收口烟道。"""
        pts = [
            (xc - rx0, y0, zc - rz0), (xc + rx0, y0, zc - rz0), (xc + rx0, y0, zc + rz0), (xc - rx0, y0, zc + rz0),
            (xc - rx1, y1, zc - rz1), (xc + rx1, y1, zc - rz1), (xc + rx1, y1, zc + rz1), (xc - rx1, y1, zc + rz1),
        ]
        f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 4, 7, 3), (1, 2, 6, 5), (0, 1, 5, 4), (3, 7, 6, 2)]
        cols = [_shade(color, 0.8), _shade(color, 1.04), _shade(color, 0.94), _shade(color, 0.94), color, color]
        self.add_poly(pts, f, cols)

    def puff(self, center, rx, ry, rz, color, yaw=0.0):
        """八面体低多边形气团/烟团（每团仅 8 个三角形）。"""
        raw = [(rx, 0, 0), (-rx, 0, 0), (0, ry, 0), (0, -ry, 0), (0, 0, rz), (0, 0, -rz)]
        cx, cy, cz = center
        pts = []
        for p in raw:
            px, py, pz = _rot_pt(p, yaw=yaw)
            pts.append((cx + px, cy + py, cz + pz))
        f = [
            (0, 4, 2), (4, 1, 2), (1, 5, 2), (5, 0, 2),
            (4, 0, 3), (1, 4, 3), (5, 1, 3), (0, 5, 3),
        ]
        cols = [
            _shade(color, 1.05), _shade(color, 1.02), _shade(color, 0.96), _shade(color, 0.99),
            _shade(color, 0.88), _shade(color, 0.85), _shade(color, 0.82), _shade(color, 0.86),
        ]
        self.add_poly(pts, f, cols)

    def wedge(self, x0, x1, y0, y1, z0, z1, slope_dir, color):
        """斜切砖/拱角，slope_dir: +1 表示左下斜到右上，-1 表示右下斜到左上（沿 x-y 平面）。"""
        if slope_dir > 0:
            # 缺左下角：保留 (x0,y1), (x1,y1), (x1,y0)
            pts = [
                (x0, y1, z0), (x1, y1, z0), (x1, y0, z0),
                (x0, y1, z1), (x1, y1, z1), (x1, y0, z1),
            ]
        else:
            # 缺右下角：保留 (x0,y0), (x0,y1), (x1,y1)
            pts = [
                (x0, y0, z0), (x0, y1, z0), (x1, y1, z0),
                (x0, y0, z1), (x0, y1, z1), (x1, y1, z1),
            ]
        f = [(0, 2, 1), (3, 4, 5), (0, 1, 4, 3), (1, 2, 5, 4), (2, 0, 3, 5)]
        cols = [color, color, _shade(color, 0.95), _shade(color, 0.95), _shade(color, 0.86)]
        self.add_poly(pts, f, cols)

    def build(self, name, glow=0.0, pos=(0, 0, 0)):
        return K.mesh(name, self.verts, self.faces, self.colors, glow=glow, pos=pos)


def _add_pot(mb, center, r, h, body_col, seg=8, handle_mode="two", tilt_x=0.0, tilt_z=0.0, yaw=0.0, soup_col=None):
    """低多边形锅具：带侧耳/长柄，可选锅内汤面。"""
    mb.cyl(center, r * 0.92, r, h, body_col, seg=seg, tilt_x=tilt_x, tilt_z=tilt_z, yaw=yaw)
    cx, cy, cz = center
    if handle_mode == "two":
        for sx in (-1.0, 1.0):
            hx, hy, hz = _rot_pt((sx * (r + 0.03), h * 0.72, 0.0), tilt_x, tilt_z, yaw)
            mb.box((cx + hx, cy + hy, cz + hz), (0.06, 0.04, 0.09), IRON, tilt_x=tilt_x, tilt_z=tilt_z, yaw=yaw)
    elif handle_mode == "long":
        hx, hy, hz = _rot_pt((r + 0.09, h * 0.72, 0.0), tilt_x, tilt_z, yaw)
        mb.box((cx + hx, cy + hy, cz + hz), (0.18, 0.035, 0.045), TIMBER_D, tilt_x=tilt_x, tilt_z=tilt_z, yaw=yaw)
    if soup_col is not None:
        sx, sy, sz = _rot_pt((0.0, h - 0.01, 0.0), tilt_x, tilt_z, yaw)
        mb.cyl((cx + sx, cy + sy, cz + sz), r * 0.82, r * 0.82, 0.025, soup_col, seg=seg, tilt_x=tilt_x, tilt_z=tilt_z, yaw=yaw, top_color=soup_col)


def _add_lid(mb, center, r, lid_col, seg=6, tilt_x=0.0, tilt_z=0.0, yaw=0.0):
    mb.cyl(center, r, r * 0.85, 0.035, lid_col, seg=seg, tilt_x=tilt_x, tilt_z=tilt_z, yaw=yaw)
    cx, cy, cz = center
    kx, ky, kz = _rot_pt((0.0, 0.035, 0.0), tilt_x, tilt_z, yaw)
    mb.cyl((cx + kx, cy + ky, cz + kz), 0.038, 0.0, 0.045, IRON, seg=4, tilt_x=tilt_x, tilt_z=tilt_z, yaw=yaw)


def build():
    K.begin("stove_station", "kitchen", 1, "自制（本脚本生成，无外部素材）", "client/art_source/kits/kitchen/stove_station/build.py")

    # ─── 1. 常显部分 base*（严格落在 2.0 x 1.5 米占地上：x [-1,1], z [-0.75,0.75], y >= 0）───
    # 1.1 石砌台基与前 hearth 围沿
    plinth = MeshBuf()
    plinth.block(-1.0, 1.0, 0.0, 0.08, -0.75, 0.75, STONE_BASE, bottom_dark=0.85)
    plinth.block(-0.76, 0.92, 0.08, 0.12, 0.50, 0.66, _shade(STONE_BASE, 0.92))  # 灶口前踏石
    plinth.build("base_plinth")

    # 1.2 砖砌台体（后墙、三根砖柱、两孔拱形灶口、错位角砖与灰缝色带）
    brick = MeshBuf()
    # 主体背块与灶底
    brick.block(-0.74, 0.90, 0.08, 0.86, -0.66, 0.22, BRICK_A, bottom_dark=0.88)
    brick.block(-0.74, 0.90, 0.08, 0.14, 0.22, 0.52, BRICK_MORTAR)
    # 三根前柱（左右灶口之间与两侧）
    brick.block(-0.74, -0.54, 0.14, 0.86, 0.22, 0.52, BRICK_A)
    brick.block(-0.14, 0.22, 0.14, 0.86, 0.22, 0.52, BRICK_A)
    brick.block(0.58, 0.90, 0.14, 0.86, 0.22, 0.52, BRICK_A)
    # 两个灶口上方的过梁
    brick.block(-0.54, -0.14, 0.56, 0.86, 0.22, 0.52, BRICK_A)
    brick.block(0.22, 0.58, 0.52, 0.86, 0.22, 0.52, BRICK_A)
    # 两条水平灰缝/深砖色带（绕正面和左右侧面，不用每块砖单独建模）
    brick.block(-0.75, 0.91, 0.34, 0.38, -0.67, 0.53, BRICK_MORTAR)
    brick.block(-0.75, 0.91, 0.68, 0.72, -0.67, 0.53, BRICK_MORTAR)
    # 四个角错位土黄砖块（强调整体砖砌质感）
    brick.block(-0.755, -0.62, 0.18, 0.30, 0.36, 0.535, BRICK_B)
    brick.block(-0.755, -0.64, 0.44, 0.56, 0.38, 0.535, BRICK_B)
    brick.block(0.76, 0.915, 0.20, 0.32, 0.36, 0.535, BRICK_B)
    brick.block(0.78, 0.915, 0.46, 0.58, 0.38, 0.535, BRICK_B)
    # 两个拱形灶口的拱券砖框 + 内斜拱角
    for (ax0, ax1, ay_top) in [(-0.54, -0.14, 0.56), (0.22, 0.58, 0.52)]:
        am = (ax0 + ax1) * 0.5
        brick.wedge(ax0, ax0 + 0.10, ay_top - 0.12, ay_top, 0.24, 0.52, 1, BRICK_MORTAR)
        brick.wedge(ax1 - 0.10, ax1, ay_top - 0.12, ay_top, 0.24, 0.52, -1, BRICK_MORTAR)
        brick.block(ax0 - 0.04, ax0 + 0.06, ay_top - 0.10, ay_top + 0.04, 0.48, 0.545, BRICK_B)
        brick.block(ax1 - 0.06, ax1 + 0.04, ay_top - 0.10, ay_top + 0.04, 0.48, 0.545, BRICK_B)
        brick.block(am - 0.10, am + 0.10, ay_top - 0.01, ay_top + 0.08, 0.48, 0.55, BRICK_B)
    brick.build("base_brick_body")

    # 1.3 深色石板台面（最高 0.94 米）、双铸铁灶圈与前右备菜木案板
    counter = MeshBuf()
    counter.block(-0.78, 0.94, 0.86, 0.94, -0.68, 0.56, STONE_DARK, bottom_dark=0.85)
    # 左大灶圈 + 十字炉架
    counter.cyl((-0.34, 0.94, 0.04), 0.28, 0.26, 0.032, IRON, seg=8)
    counter.box((-0.34, 0.96, 0.04), (0.58, 0.02, 0.04), _shade(IRON, 1.15))
    # 右中灶圈 + 横炉架
    counter.cyl((0.38, 0.94, -0.06), 0.21, 0.19, 0.032, IRON, seg=8)
    counter.box((0.38, 0.96, -0.06), (0.44, 0.02, 0.035), _shade(IRON, 1.15))
    # 右前备菜木板（anchor_put_1 所在）
    counter.block(0.24, 0.72, 0.94, 0.97, 0.14, 0.48, TIMBER_L)
    counter.build("base_counter")

    # 1.4 后挡板、矮烟道（-z 侧，最高 1.82 米 < 1.9 米，不挡前侧人物）与调料架
    chimney = MeshBuf()
    chimney.block(-0.76, 0.92, 0.94, 1.30, -0.74, -0.50, BRICK_A)
    chimney.block(-0.77, 0.93, 1.28, 1.33, -0.75, -0.48, STONE_BASE)
    # 砖石基座 + 灰泥收口烟道 + 砖帽
    chimney.block(-0.34, 0.26, 1.33, 1.50, -0.74, -0.48, BRICK_B)
    chimney.frustum(1.50, 1.76, 0.26, 0.13, 0.19, 0.11, -0.04, -0.61, PLASTER_FLUE)
    chimney.block(-0.27, 0.19, 1.76, 1.82, -0.74, -0.48, BRICK_A)
    # 调料木架 + 两只陶罐
    chimney.block(0.32, 0.88, 1.16, 1.20, -0.50, -0.34, TIMBER)
    chimney.cyl((0.48, 1.20, -0.41), 0.055, 0.045, 0.11, CREAM, seg=5)
    chimney.cyl((0.68, 1.20, -0.41), 0.05, 0.04, 0.09, BRICK_B, seg=5)
    chimney.build("base_chimney")

    # 1.5 左侧柴火架与劈柴 + 右侧木挂杆与擦手布
    side = MeshBuf()
    # 左侧柴垛（x 到 -0.99，严守占地边界）
    side.block(-0.99, -0.74, 0.08, 0.13, -0.44, 0.36, TIMBER_D)
    for sz in (-0.40, 0.32):
        side.block(-0.99, -0.93, 0.13, 0.52, sz - 0.03, sz + 0.03, TIMBER)
    for (lx, ly, yaw_l) in [(-0.91, 0.195, 2.0), (-0.80, 0.195, -3.0), (-0.855, 0.30, 1.5)]:
        side.cyl((lx, ly, -0.35), 0.062, 0.058, 0.66, WOOD_BARK, seg=5, tilt_x=90.0, yaw=yaw_l, top_color=WOOD_LOG)
    # 右侧木挂杆 + 布巾
    side.block(0.90, 0.99, 0.72, 0.76, -0.28, 0.28, TIMBER_D)
    side.block(0.94, 0.98, 0.48, 0.74, -0.06, 0.18, CLOTH)
    side.build("base_side_props")

    # ─── 2. 锚点 ───
    K.empty("anchor_use_1", (-0.25, 0.0, 1.5), yaw=180)
    K.empty("anchor_use_2", (0.75, 0.0, 1.5), yaw=180)
    K.empty("anchor_put_1", (0.48, 0.97, 0.31))
    K.empty("anchor_fx_1", (-0.34, 1.28, 0.04))

    # ─── 3. 状态 idle：冷灰烬、冷锅、盖子盖紧，无火无汽 ───
    ash_idle = MeshBuf()
    ash_idle.block(-0.50, -0.18, 0.14, 0.19, 0.26, 0.48, ASH_DARK)
    ash_idle.block(0.26, 0.54, 0.14, 0.18, 0.26, 0.48, ASH_DARK)
    ash_idle.build("state_idle_ash")

    pots_idle = MeshBuf()
    _add_pot(pots_idle, (-0.34, 0.97, 0.04), 0.24, 0.22, POT_COLD, seg=8, handle_mode="two")
    _add_pot(pots_idle, (0.38, 0.97, -0.06), 0.17, 0.16, _shade(POT_COPPER, 0.85), seg=6, handle_mode="long")
    pots_idle.build("state_idle_pots")

    lids_idle = MeshBuf()
    _add_lid(lids_idle, (-0.34, 1.19, 0.04), 0.245, IRON, seg=8)
    _add_lid(lids_idle, (0.38, 1.13, -0.06), 0.175, IRON, seg=6)
    lids_idle.build("state_idle_lids")

    # ─── 4. 状态 busy：旺火橙光（glow > 0.8）、掀盖煮汤、蒸汽循环上下浮动 ───
    fire_busy = MeshBuf()
    # 两个灶口里的火舌（四棱锥）与炉口微光圈
    for (fx, fz, h_scale) in [
        (-0.42, 0.40, 0.24), (-0.33, 0.34, 0.30), (-0.24, 0.41, 0.22),
        (0.32, 0.40, 0.21), (0.40, 0.35, 0.26), (0.48, 0.41, 0.19),
    ]:
        fire_busy.cyl((fx, 0.18, fz), 0.065, 0.0, h_scale, FIRE_BRIGHT, seg=4)
    fire_busy.cyl((-0.34, 0.18, 0.37), 0.05, 0.0, 0.20, FIRE_CORE, seg=4)
    fire_busy.cyl((0.40, 0.18, 0.37), 0.045, 0.0, 0.17, FIRE_CORE, seg=4)
    # 灶眼锅底火光圈
    fire_busy.cyl((-0.34, 0.955, 0.04), 0.26, 0.26, 0.02, FIRE_BRIGHT, seg=8)
    fire_busy.cyl((0.38, 0.955, -0.06), 0.19, 0.19, 0.02, FIRE_BRIGHT, seg=6)
    fire_busy.build("state_busy_fire", glow=0.92)

    embers_busy = MeshBuf()
    embers_busy.block(-0.50, -0.18, 0.14, 0.20, 0.26, 0.50, FIRE_BRIGHT)
    embers_busy.block(0.26, 0.54, 0.14, 0.19, 0.26, 0.50, FIRE_BRIGHT)
    embers_busy.build("state_busy_embers", glow=0.84)

    pots_busy = MeshBuf()
    _add_pot(pots_busy, (-0.34, 0.97, 0.04), 0.24, 0.22, POT_IRON, seg=8, handle_mode="two", soup_col=SOUP)
    _add_pot(pots_busy, (0.38, 0.97, -0.06), 0.17, 0.16, POT_COPPER, seg=6, handle_mode="long", soup_col=SOUP)
    pots_busy.build("state_busy_pots")

    lids_busy = MeshBuf()
    _add_lid(lids_busy, (-0.54, 1.16, -0.14), 0.23, IRON, seg=6, tilt_x=38.0, yaw=-25.0)
    _add_lid(lids_busy, (0.56, 1.11, -0.20), 0.165, IRON, seg=6, tilt_x=34.0, yaw=20.0)
    lids_busy.build("state_busy_lids")

    steam_busy = MeshBuf()
    for (sx, sy, sz, sr, sh) in [
        (-0.36, 1.30, 0.06, 0.11, 0.09),
        (-0.28, 1.44, 0.00, 0.14, 0.11),
        (-0.38, 1.60, 0.04, 0.12, 0.10),
        (0.38, 1.25, -0.05, 0.09, 0.08),
        (0.42, 1.40, -0.08, 0.11, 0.09),
    ]:
        steam_busy.puff((sx, sy, sz), sr, sh, sr, STEAM, yaw=sx * 40.0)
    steam_obj = steam_busy.build("state_busy_steam")
    # 循环动画：1.5 秒周期（24fps 下 36 帧），垂直浮动 10 厘米
    K.animate(
        steam_obj,
        "state_busy-loop",
        "location",
        [(1, (0.0, 0.0, 0.0)), (10, (0.0, 0.05, 0.0)), (19, (0.0, 0.10, 0.0)), (28, (0.0, 0.05, 0.0)), (37, (0.0, 0.0, 0.0))],
    )

    # ─── 5. 状态 done：余烬微亮、台面多出暖色盛好汤碗和木盘、一缕淡热气 ───
    embers_done = MeshBuf()
    embers_done.block(-0.48, -0.20, 0.14, 0.18, 0.28, 0.46, EMBER_DIM)
    embers_done.block(0.28, 0.52, 0.14, 0.18, 0.28, 0.46, EMBER_DIM)
    embers_done.build("state_done_embers", glow=0.35)

    pots_done = MeshBuf()
    _add_pot(pots_done, (-0.34, 0.97, 0.04), 0.24, 0.22, POT_IRON, seg=8, handle_mode="two")
    _add_pot(pots_done, (0.38, 0.97, -0.06), 0.17, 0.16, POT_COPPER, seg=6, handle_mode="long", soup_col=SOUP)
    _add_lid(pots_done, (-0.34, 1.19, 0.04), 0.245, IRON, seg=6)
    pots_done.build("state_done_pots")

    dishes_done = MeshBuf()
    # 案板上：浅色大餐盘 + 盛满金黄浓汤的大碗 + 香草点缀 + 面包
    dishes_done.cyl((0.48, 0.972, 0.31), 0.16, 0.17, 0.018, CREAM, seg=8)
    dishes_done.cyl((0.48, 0.99, 0.31), 0.09, 0.115, 0.065, CREAM, seg=6, top_color=SOUP)
    dishes_done.box((0.48, 1.06, 0.31), (0.05, 0.025, 0.05), HERB, yaw=20.0)
    # 灶台前中空位：第二只汤碗与暖色面包块
    dishes_done.cyl((0.02, 0.942, 0.34), 0.08, 0.10, 0.06, CREAM, seg=6, top_color=SOUP)
    dishes_done.box((0.68, 0.995, 0.24), (0.11, 0.05, 0.07), BREAD, yaw=-15.0)
    dishes_done.build("state_done_dishes")

    wisp_done = MeshBuf()
    wisp_done.puff((0.48, 1.16, 0.31), 0.055, 0.06, 0.055, STEAM, yaw=15.0)
    wisp_done.puff((0.50, 1.28, 0.30), 0.045, 0.055, 0.045, STEAM, yaw=-20.0)
    wisp_done.build("state_done_wisp")

    # ─── 6. 状态 fault：锅歪、熏黑痕迹、明显黑灰烟团，无橙火 ───
    scorch_fault = MeshBuf()
    scorch_fault.block(-0.50, -0.18, 0.14, 0.19, 0.26, 0.50, SOOT)
    scorch_fault.block(0.26, 0.54, 0.14, 0.18, 0.26, 0.50, SOOT)
    # 灶口上方与前踏石熏黑痕（略微偏出避免共面闪烁）
    scorch_fault.block(-0.52, -0.16, 0.54, 0.72, 0.552, 0.570, SOOT)
    scorch_fault.block(-0.62, 0.10, 0.942, 0.955, -0.22, 0.44, SOOT)
    scorch_fault.build("state_fault_scorch")

    pot_fault_l = MeshBuf()
    _add_pot(pot_fault_l, (-0.34, 1.00, 0.06), 0.24, 0.22, POT_CHAR, seg=8, handle_mode="two", tilt_x=22.0, yaw=-20.0)
    _add_lid(pot_fault_l, (-0.58, 0.97, 0.34), 0.23, _shade(IRON, 0.82), seg=6, tilt_x=12.0, tilt_z=24.0)
    pot_fault_l.build("state_fault_pot_l")

    pot_fault_r = MeshBuf()
    _add_pot(pot_fault_r, (0.40, 0.99, -0.04), 0.17, 0.16, _shade(POT_CHAR, 1.1), seg=6, handle_mode="long", tilt_x=-16.0, yaw=24.0)
    pot_fault_r.build("state_fault_pot_r")

    smoke_fault = MeshBuf()
    for i, (sx, sy, sz, sr, col) in enumerate([
        (-0.34, 1.24, 0.08, 0.14, SMOKE_A),
        (-0.28, 1.40, 0.12, 0.17, SMOKE_B),
        (-0.38, 1.56, 0.06, 0.20, SMOKE_A),
        (-0.26, 1.72, 0.10, 0.22, SMOKE_B),
        (-0.35, 0.62, 0.62, 0.11, SMOKE_A),
        (-0.30, 0.80, 0.66, 0.13, SMOKE_B),
        (0.40, 1.28, -0.02, 0.13, SMOKE_A),
    ]):
        smoke_fault.puff((sx, sy, sz), sr, sr * 0.85, sr, col, yaw=i * 28.0)
    smoke_fault.build("state_fault_smoke")

    K.export(K.out_path_from_argv())


K.run(build)
