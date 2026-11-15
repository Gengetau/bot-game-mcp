"""占位建筑 building_sample：只为证明「建筑的替换入口」和「屋顶 / 上半墙淡出」能用。尺寸对着公共厨房（kitchen）：
外框 15.3 x 11.3 米（服务端的室内 14 x 10，四周各加 0.65 米的墙），原点在外框中心的地面上；南墙留一个门洞（地图 x 49.65 到 52.35，
外框中心 x=51，所以局部 -1.35 到 +1.35）。门洞、碰撞只看服务端地图，模型只管好看。
base* 是常显的矮墙（0.9 米，不挡镜头）；fade* 是上半墙和屋顶，人进屋、挡镜头时淡出。
用法（build_kits.sh 会调）：blender -b --factory-startup --python build.py -- <输出的.glb>
"""
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "tools"))
import kit_lib as K  # noqa: E402

W, D = 15.3, 11.3
T = 0.3  # 墙厚
LOW = 0.9  # 矮墙高度
H = 3.0
GAP = 1.35  # 门洞半宽
PLASTER = (0.90, 0.84, 0.72)
STONE = (0.62, 0.60, 0.56)
ROOF = (0.50, 0.52, 0.60)
TIMBER = (0.40, 0.28, 0.20)


def build():
    K.begin("building_sample", "sample", 1, "自制（本脚本生成，无外部素材）", "client/art_source/kits/sample/building_sample/build.py")
    zn = -D / 2 + T / 2
    zs = D / 2 - T / 2
    xs = W / 2 - T / 2
    seg = W / 2 - GAP  # 门洞两侧南墙段的长度
    sx = GAP + seg / 2
    # 矮墙（base）
    K.box("base_wall_n", (0, LOW / 2, zn), (W, LOW, T), STONE)
    K.box("base_wall_s_w", (-sx, LOW / 2, zs), (seg, LOW, T), STONE)
    K.box("base_wall_s_e", (sx, LOW / 2, zs), (seg, LOW, T), STONE)
    K.box("base_wall_w", (-xs, LOW / 2, 0), (T, LOW, D - 2 * T), STONE)
    K.box("base_wall_e", (xs, LOW / 2, 0), (T, LOW, D - 2 * T), STONE)
    K.empty("state_idle")
    # 上半墙和屋顶（fade）：北墙、南墙（含门楣）、东西墙各一块，屋顶一块
    hh = H - LOW
    K.box("fade_wall_n", (0, LOW + hh / 2, zn), (W, hh, T), PLASTER)
    K.box("fade_wall_s_w", (-sx, LOW + hh / 2, zs), (seg, hh, T), PLASTER)
    K.box("fade_wall_s_e", (sx, LOW + hh / 2, zs), (seg, hh, T), PLASTER)
    K.box("fade_lintel", (0, 2.45 + (H - 2.45) / 2, zs), (2 * GAP, H - 2.45, T), TIMBER)
    K.box("fade_wall_w", (-xs, LOW + hh / 2, 0), (T, hh, D - 2 * T), PLASTER)
    K.box("fade_wall_e", (xs, LOW + hh / 2, 0), (T, hh, D - 2 * T), PLASTER)
    K.gable_x("fade_roof", -W / 2 - 0.8, W / 2 + 0.8, 0.0, D / 2 + 0.8, H + 0.05, 2.4, ROOF)
    K.export(K.out_path_from_argv())


K.run(build)
