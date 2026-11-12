"""把 Kenney Mini Characters 的 character-male-a 整理成栖灯镇的居民模型。

用法（Python 3.13，需要 `pip install bpy`，不需要装 Blender 本体）：

    python client/art_source/build_resident.py
    python client/art_source/build_resident.py --input <原始.glb> --output <resident.glb>

做的事（可重复运行，同样输入得到同样输出）：
  1. 导入原始 GLB（Kenney 原包就是 Y 向上的 GLB，自带骨架、蒙皮、34 个动作、内嵌贴图）。
  2. 删掉模型里多余的杂物（名为 Icosphere 的游离球体）。
  3. 只保留 `idle`、`walk` 两个动作（原包本来就有，名字不用改），删除其余动作。
  4. 统一比例：原模型约 0.67 米高，整体放大到 1.7 米（缩放烘进顶点、骨骼静止位置和动作里的位移键，\n     物件缩放保持 1）。
     原点在脚底（脚底 z=0），朝向沿用原包：glTF 的 +Z，也就是 Godot 里的 +Z（见 client/art_source/README.md）。
  5. 贴图内嵌，导出 GLB。导出后重新导入一次，检查动作、骨骼、高度，不通过就退出码 1。
"""
import argparse
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TARGET_HEIGHT = 1.7
KEEP_ACTIONS = ("idle", "walk")


def world_bounds(objs):
    pts = []
    for o in objs:
        pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    return lo, hi


def action_fcurves(action):
    """兼容旧版（action.fcurves）和 Blender 4.4+ 的分层动作。"""
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    out = []
    for layer in action.layers:
        for strip in layer.strips:
            for cb in strip.channelbags:
                out += list(cb.fcurves)
    return out


def skinned_meshes():
    return [o for o in bpy.data.objects if o.type == "MESH" and o.parent is not None and o.parent.type == "ARMATURE"]


def build(src, dst):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    # 2. 只取挂在骨架下的蒙皮网格；导入器自己造的 Icosphere（骨骼显示形状，
    #    在 glTF_not_exported 集合里）不会被导出，也不参与量尺寸
    meshes = skinned_meshes()

    # 3. 只留 idle / walk
    for a in list(bpy.data.actions):
        if a.name not in KEEP_ACTIONS:
            bpy.data.actions.remove(a)
    missing = [n for n in KEEP_ACTIONS if n not in bpy.data.actions]
    if missing:
        raise SystemExit("原始模型缺少动作: %s" % missing)
    for a in bpy.data.actions:
        a.use_fake_user = True
    arm.animation_data.action = bpy.data.actions["idle"]
    bpy.context.view_layer.update()

    # 4. 比例与原点：脚底 z=0；放大到 1.7 米。
    #    缩放直接烘进数据（顶点、骨骼静止位置、动作里的位移键），物件缩放保持 1，
    #    否则 Godot 里蒙皮网格的包围盒会算成放大两次（实测 4.3 米）。
    lo, hi = world_bounds(meshes)
    height = hi[2] - lo[2]
    s = TARGET_HEIGHT / height
    foot = lo[2]
    for m in meshes:
        m.data.transform(Matrix.Translation((0, 0, -foot)) @ Matrix.Scale(s, 4))
        m.data.update()
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for eb in arm.data.edit_bones:
        eb.head = (eb.head - Vector((0, 0, foot))) * s
        eb.tail = (eb.tail - Vector((0, 0, foot))) * s
    bpy.ops.object.mode_set(mode="OBJECT")
    for a in bpy.data.actions:
        for fc in action_fcurves(a):
            if fc.data_path.endswith(".location"):
                for kp in fc.keyframe_points:
                    kp.co[1] *= s
                    kp.handle_left[1] *= s
                    kp.handle_right[1] *= s
                fc.update()
    bpy.context.view_layer.update()
    lo, hi = world_bounds(meshes)
    print("整理后高度 %.3f m，脚底 z=%.4f" % (hi[2] - lo[2], lo[2]))

    # 5. 导出
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_image_format="AUTO",     # 贴图内嵌（PNG）
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=False,
        export_yup=True,
        export_apply=False,
        export_cameras=False,
        export_lights=False,
    )
    print("已导出", dst, os.path.getsize(dst), "字节")

    # 重新导入自检
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=dst)
    names = sorted(a.name for a in bpy.data.actions)
    assert names == sorted(KEEP_ACTIONS), "动作应只有 idle、walk，实际 %s" % names
    ms = skinned_meshes()
    lo, hi = world_bounds(ms)
    print("重新导入的包围盒", lo, hi)
    assert abs((hi[2] - lo[2]) - TARGET_HEIGHT) < 0.05, "高度不对"
    assert abs(lo[2]) < 0.02, "原点不在脚底"
    print("自检通过: 动作", names, "骨骼", [b.name for a in bpy.data.armatures for b in a.bones])


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("--input", default=os.path.join(HERE, "source", "kenney_mini_character_male_a.glb"))
    p.add_argument("--output", default=os.path.join(ROOT, "town", "assets", "models", "characters", "resident.glb"))
    a = p.parse_args(argv)
    build(os.path.abspath(a.input), os.path.abspath(a.output))


if __name__ == "__main__":
    main()
