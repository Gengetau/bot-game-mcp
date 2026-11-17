"""占位工位 station_sample：2 x 1.5 米占地的灶台式工位，用来证明「Blender 脚本 -> GLB -> 包装场景 -> 带状态的物件」这条链。
不追求好看，只要四种状态一眼分得清：idle 冷锅盖着；busy 锅下有亮着的火（有循环动画）；done 台面上多一个盘子；fault 锅歪了、冒深色的烟。
用法（build_kits.sh 会调）：blender -b --factory-startup --python build.py -- <输出的.glb>

锚点和服务端地图 town-map.ts 里 kitchen:stove1 对账：物件中心 (48, 2.75)，使用位 (47.75, 4.25) 和 (48.75, 4.25)，
换算到资产局部（原点在占地中心、正面朝 +z）就是 (-0.25, 1.5) 和 (0.75, 1.5)。
"""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools"))
import kit_lib as K  # noqa: E402

WOOD = (0.55, 0.38, 0.25)
STONE = (0.72, 0.70, 0.66)
IRON = (0.20, 0.20, 0.22)
POT = (0.56, 0.34, 0.26)
POT_COLD = (0.50, 0.52, 0.56)
FIRE = (1.0, 0.55, 0.16)
CREAM = (0.96, 0.92, 0.82)
SMOKE = (0.16, 0.15, 0.17)
SOUP = (0.86, 0.62, 0.22)


def build():
    K.begin("station_sample", "sample", 1, "自制（本脚本生成，无外部素材）", "client/art_source/kits/sample/station_sample/build.py")
    # base：任何状态都在。台柜 2 x 0.8 x 1.5，台面石板，两个灶眼，后挡板
    K.box("base_body", (0, 0.4, 0), (2.0, 0.8, 1.5), WOOD)
    K.box("base_top", (0, 0.85, 0), (2.0, 0.1, 1.5), STONE)
    K.cyl("base_ring_l", (-0.45, 0.9, 0.05), 0.27, 0.27, 0.03, IRON, seg=12)
    K.cyl("base_ring_r", (0.45, 0.9, 0.05), 0.27, 0.27, 0.03, IRON, seg=12)
    K.box("base_back", (0, 1.15, -0.65), (2.0, 0.5, 0.1), STONE)
    # 锚点：use 站位（脸朝 -z，所以 yaw 180）、put 放东西的点、fx 特效点
    K.empty("anchor_use_1", (-0.25, 0, 1.5), yaw=180)
    K.empty("anchor_use_2", (0.75, 0, 1.5), yaw=180)
    K.empty("anchor_put_1", (0.45, 0.93, 0.05))
    K.empty("anchor_fx_1", (-0.45, 1.25, 0.05))
    # idle：冷锅，盖着盖子，灰色
    K.empty("state_idle")
    K.cyl("state_idle_pot", (-0.45, 0.93, 0.05), 0.22, 0.2, 0.2, POT_COLD, seg=10)
    K.cyl("state_idle_lid", (-0.45, 1.13, 0.05), 0.2, 0.05, 0.05, IRON, seg=10)
    # busy：红褐的锅，锅下三簇亮着的火（发光），火有循环的上下抖动
    K.cyl("state_busy_pot", (-0.45, 0.93, 0.05), 0.22, 0.2, 0.2, POT, seg=10)
    for i, (dx, dz) in enumerate([(-0.12, 0.0), (0.1, 0.07), (0.02, -0.1)]):
        K.cyl("state_busy_flame_%d" % (i + 1), (-0.45 + dx, 0.93, 0.05 + dz), 0.07, 0.0, 0.2, FIRE, seg=6, glow=0.9)
    K.cyl("state_busy_ring_glow", (-0.45, 0.93, 0.05), 0.27, 0.27, 0.01, FIRE, seg=12, glow=0.85)
    K.cyl("state_busy_steam", (-0.45, 1.15, 0.05), 0.07, 0.12, 0.25, CREAM, seg=6)
    fl = bpy_obj("state_busy_flame_1")
    K.animate(fl, "state_busy-loop", "location", [(1, (-0.57, 0.93, 0.05)), (7, (-0.57, 0.97, 0.05)), (13, (-0.57, 0.93, 0.05)), (19, (-0.57, 0.96, 0.05)), (24, (-0.57, 0.93, 0.05))])
    # done：锅放着，右边台面上多一个盘子，盘里一碗汤
    K.cyl("state_done_pot", (-0.45, 0.93, 0.05), 0.22, 0.2, 0.2, POT, seg=10)
    K.cyl("state_done_plate", (0.45, 0.93, 0.05), 0.25, 0.25, 0.03, CREAM, seg=12)
    K.cyl("state_done_soup", (0.45, 0.96, 0.05), 0.15, 0.13, 0.1, SOUP, seg=10)
    # fault：锅歪了（绕 x 倾斜），冒一缕深色的烟
    K.cyl("state_fault_pot", (-0.45, 0.95, 0.05), 0.22, 0.2, 0.2, POT, seg=10, tilt_x=24.0)
    for i in range(4):
        K.cyl("state_fault_smoke_%d" % (i + 1), (-0.45 + 0.03 * i, 1.18 + 0.2 * i, 0.05), 0.09 + 0.03 * i, 0.12 + 0.03 * i, 0.2, SMOKE, seg=6)
    K.export(K.out_path_from_argv())


def bpy_obj(name):
    import bpy

    return bpy.data.objects[name]


K.run(build)
