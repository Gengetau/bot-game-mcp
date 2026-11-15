"""栖灯镇资产套件的 Blender 公用辅助（给各 kits/<套件>/<资产编号>/build.py 引用）。

只能在 Blender 里运行（无头）：
    "$BLENDER" -b --factory-startup --python build.py -- <输出的 .glb 路径>

约定见 client/docs/T02a.md。这里的函数一律用「游戏坐标」：x 向右、y 向上、z 朝前（也就是 Godot / glTF 的坐标，正面朝 +z），
单位米；转成 Blender 的 Z 向上只在这里做（g2b），不许每件资产手工补偿。颜色是线性值，和 mesh_builder.gd 里的 Color 一一对应：
顶点色 alpha = 1 - 发光（alpha 小于 1 的地方夜里发暖光）；所有 UV 都指向色板贴图左上角的纯白块。
"""
import sys

sys.dont_write_bytecode = True  # 不在源目录里留 __pycache__

import math
import re

import bmesh
import bpy

# 色板贴图里纯白块的 UV（和 mesh_builder.gd 的 WHITE_UV 一致）。Blender 的 V 轴向上，glTF 向下，所以写 1 - v
WHITE_UV = (0.015, 0.015)
LAYOUT_VERSION = 1

PLAIN_RE = re.compile(r"^[a-z][a-z0-9_]*$")
BASE_RE = re.compile(r"^base([a-z0-9_]*)$")
FADE_RE = re.compile(r"^fade([a-z0-9_]*)$")
STATE_RE = re.compile(r"^state_([a-z0-9]+)(_[a-z0-9_]*)?$")
ANCHOR_RE = re.compile(r"^anchor_(use|put|fx)_[0-9]+$")
# Godot 导入 GLB 时会把节点名末尾的这些词当成导入指令（碰撞、不导入、导航网格……），名字里不许出现
GODOT_HINT_RE = re.compile(r"[-_](noimp|colonly|convcolonly|col|convcol|navmesh|vehicle|wheel|rigid|occ|occonly|loop|cycle)[0-9_]*$")

_root = None
_meta = {}


class KitError(Exception):
    pass


def g2b(x, y, z):
    """游戏坐标 -> Blender 坐标（Blender Z 向上，正面朝 -Y；这是个纯旋转，面的绕向不变）。"""
    return (x, -z, y)


def begin(asset_id, kit, version, origin, script):
    """清空场景，建资产的根空节点。script：build.py 相对仓库根的路径（写进清单的来源）。"""
    global _root, _meta
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _root = bpy.data.objects.new(asset_id, None)
    bpy.context.scene.collection.objects.link(_root)
    _meta = {"id": asset_id, "kit": kit, "version": int(version), "origin": origin, "script": script}
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 24
    return _root


def _link(obj, parent):
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent if parent is not None else _root


def empty(name, pos=(0, 0, 0), yaw=0.0, parent=None):
    """空节点（锚点、分组、`state_idle` 这种没有几何的状态）。yaw 为绕游戏 y 轴的角度（度）。"""
    o = bpy.data.objects.new(name, None)
    o.empty_display_type = "PLAIN_AXES"
    o.empty_display_size = 0.1
    _link(o, parent)
    o.location = g2b(*pos)
    o.rotation_euler = (0.0, 0.0, math.radians(yaw))
    return o


def _shade(c, k):
    return (c[0] * k, c[1] * k, c[2] * k)


def mesh(name, verts, faces, face_colors, glow=0.0, pos=(0, 0, 0), tilt_x=0.0, yaw=0.0, parent=None, closed=True):
    """低多边形网格。verts：游戏坐标（物件局部）；faces：顶点序号列表（绕向无所谓，闭合体会统一朝外）；
    face_colors：每面一个 (r,g,b)，数量不够就循环。glow：0..1，发光程度（顶点色 alpha = 1 - glow）。
    tilt_x / yaw：物件绕游戏 x / y 轴的旋转（度），缩放永远是 1。"""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bv = [bm.verts.new(g2b(*v)) for v in verts]
    for f in faces:
        bm.faces.new([bv[i] for i in f])
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ca = me.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
    uv = me.uv_layers.new(name="UVMap")
    for pi, p in enumerate(me.polygons):
        c = face_colors[pi % len(face_colors)]
        for li in p.loop_indices:
            ca.data[li].color = (c[0], c[1], c[2], 1.0 - glow)
            uv.data[li].uv = (WHITE_UV[0], 1.0 - WHITE_UV[1])
    o = bpy.data.objects.new(name, me)
    _link(o, parent)
    o.location = g2b(*pos)
    o.rotation_euler = (math.radians(tilt_x), 0.0, math.radians(yaw))
    return o


def box(name, center, size, color, glow=0.0, bottom_dark=1.0, **kw):
    """轴对齐方块（center 是物件的位置，几何围绕它）。上面略亮，侧面略暗，和 mesh_builder.gd 的 box 同一个思路。"""
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    v = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz), (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 4, 7, 3), (1, 2, 6, 5), (3, 7, 6, 2), (0, 1, 5, 4)]  # -z +z -x +x 上 下
    cols = [color, color, _shade(color, 0.94), _shade(color, 0.94), _shade(color, 1.04), _shade(color, 0.8 * bottom_dark)]
    return mesh(name, v, f, cols, glow=glow, pos=center, **kw)


def cyl(name, base_pos, r_bot, r_top, h, color, seg=10, glow=0.0, **kw):
    """圆台（r_top = 0 是圆锥）。base_pos 是底面中心，也是物件的位置；侧面逐面略有明暗，免得大片平涂。"""
    v = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        v.append((r_bot * math.cos(a), 0.0, r_bot * math.sin(a)))
    if r_top < 1e-6:  # 圆锥：一个尖顶，没有顶面，不留退化的三角形
        v.append((0.0, h, 0.0))
        f = []
        cols = []
        for i in range(seg):
            f.append((i, (i + 1) % seg, seg))
            cols.append(_shade(color, 0.92 + 0.08 * (i % 2)))
        f.append(tuple(range(seg - 1, -1, -1)))
        cols.append(_shade(color, 0.7))
        return mesh(name, v, f, cols, glow=glow, pos=base_pos, **kw)
    for i in range(seg):
        a = 2 * math.pi * i / seg
        v.append((r_top * math.cos(a), h, r_top * math.sin(a)))
    f = []
    cols = []
    for i in range(seg):
        j = (i + 1) % seg
        f.append((i, j, seg + j, seg + i))
        cols.append(_shade(color, 0.92 + 0.08 * (i % 2)))
    f.append(tuple(range(seg - 1, -1, -1)))  # 底
    cols.append(_shade(color, 0.7))
    f.append(tuple(range(seg, 2 * seg)))  # 顶
    cols.append(_shade(color, 1.05))
    return mesh(name, v, f, cols, glow=glow, pos=base_pos, **kw)


def gable_x(name, x0, x1, zc, half_d, y0, rise, color, **kw):
    """脊线平行于 x 的双坡屋顶（实心三棱柱，底面在 y0）。zc：中线的 z。几何用世界局部坐标，物件在原点。"""
    v = [(x0, y0, zc - half_d), (x1, y0, zc - half_d), (x1, y0, zc + half_d), (x0, y0, zc + half_d), (x0, y0 + rise, zc), (x1, y0 + rise, zc)]
    f = [(0, 1, 5, 4), (3, 4, 5, 2), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]  # 北坡 南坡 西山墙 东山墙 底
    cols = [color, _shade(color, 1.06), _shade(color, 0.85), _shade(color, 0.85), _shade(color, 0.6)]
    return mesh(name, v, f, cols, **kw)


# ───────────────────────── 动画 ─────────────────────────


def animate(obj, action_name, prop, keys):
    """给物件 obj 做一段动画。action_name 就是动画名：`state_<状态名>`，循环的在后面加 `-loop`（Godot 导入时认这个后缀，去掉它并设成循环）。
    prop：'location'（游戏坐标的绝对值）或 'rotation_x' / 'rotation_y'（度）。keys：[(帧, 值)]。"""
    if obj.animation_data is None:
        obj.animation_data_create()
    act = bpy.data.actions.new(action_name)
    obj.animation_data.action = act
    for frame, val in keys:
        if prop == "location":
            obj.location = g2b(*val)
            obj.keyframe_insert("location", frame=frame)
        elif prop == "rotation_x":
            obj.rotation_euler[0] = math.radians(val)
            obj.keyframe_insert("rotation_euler", index=0, frame=frame)
        elif prop == "rotation_y":
            obj.rotation_euler[2] = math.radians(val)
            obj.keyframe_insert("rotation_euler", index=2, frame=frame)
        else:
            raise KitError("animate：不认识的属性 " + prop)
    return act


# ───────────────────────── 导出前检查和导出 ─────────────────────────


def _all_objects():
    return [o for o in bpy.data.objects if o is not _root]


def _role_of(o):
    cur = o
    while cur is not None and cur is not _root:
        if BASE_RE.match(cur.name) or FADE_RE.match(cur.name) or STATE_RE.match(cur.name):
            return cur.name
        cur = cur.parent
    return None


def check():
    """导出前的约定检查：不合格抛 KitError（build.py 让它直接终止，Blender 返回非零）。"""
    errs = []
    names = set()
    objs = _all_objects()
    if _root.name != _meta["id"] or not PLAIN_RE.match(_root.name):
        errs.append("根节点名要等于资产编号（小写字母、数字、下划线）：" + _root.name)
    has_base = False
    has_idle = False
    for o in objs:
        n = o.name
        if n in names:
            errs.append("节点名重复：" + n)
        names.add(n)
        if not PLAIN_RE.match(n):
            errs.append("节点名只许小写字母、数字和下划线，且以字母开头：" + n)
        if GODOT_HINT_RE.search(n):
            errs.append("节点名以 Godot 导入指令词结尾（_col _noimp _loop _occ 等），导入时会被改掉：" + n)
        if o.type not in ("MESH", "EMPTY"):
            errs.append("不支持的物件类型 %s：%s" % (o.type, n))
        sc = o.scale
        if abs(sc[0] - 1) > 1e-6 or abs(sc[1] - 1) > 1e-6 or abs(sc[2] - 1) > 1e-6:
            errs.append("物件缩放必须是 1（缩放烘进顶点）：%s 是 %s" % (n, tuple(round(x, 4) for x in sc)))
        if n.startswith("anchor_"):
            if not ANCHOR_RE.match(n):
                errs.append("锚点名要是 anchor_use_<n> / anchor_put_<n> / anchor_fx_<n>：" + n)
            if o.type != "EMPTY":
                errs.append("锚点必须是空节点：" + n)
        if BASE_RE.match(n):
            has_base = True
        if STATE_RE.match(n) and STATE_RE.match(n).group(1) == "idle":
            has_idle = True
        if o.type == "MESH":
            if _role_of(o) is None:
                errs.append("网格没有归属：它自己或祖先要叫 base* / state_<状态>* / fade*：" + n)
            me = o.data
            if len(me.color_attributes) == 0:
                errs.append("网格没有顶点色（颜色约定：顶点色乘色板）：" + n)
            if len(me.uv_layers) == 0:
                errs.append("网格没有 UV（要指向色板的纯白块）：" + n)
            else:
                for d in me.uv_layers[0].data:
                    if abs(d.uv[0] - WHITE_UV[0]) > 0.02 or abs(d.uv[1] - (1 - WHITE_UV[1])) > 0.02:
                        errs.append("UV 不在色板纯白块里：" + n)
                        break
            if len(me.polygons) == 0:
                errs.append("网格是空的：" + n)
    if not has_base:
        errs.append("缺少 base* 节点（任何状态都显示的部分）")
    if not has_idle:
        errs.append("缺少 state_idle* 节点（空闲状态；没有几何就建一个空节点）")
    if tuple(_root.scale) != (1.0, 1.0, 1.0) or tuple(_root.location) != (0.0, 0.0, 0.0):
        errs.append("根节点必须在原点、缩放 1")
    # 原点：base 部分的底面在 y=0、占地中心在 x=z=0
    bpy.context.scene.frame_set(1)
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for o in objs:
        if o.type == "MESH" and (_role_of(o) or "").startswith("base"):
            for v in o.data.vertices:
                w = o.matrix_world @ v.co
                gx, gy, gz = w.x, w.z, -w.y
                lo = [min(lo[0], gx), min(lo[1], gy), min(lo[2], gz)]
                hi = [max(hi[0], gx), max(hi[1], gy), max(hi[2], gz)]
    if lo[0] < 1e8:
        if abs(lo[1]) > 0.002:
            errs.append("base 的底面应在 y=0（原点在底面中心），现在最低是 %.3f" % lo[1])
        if abs((lo[0] + hi[0]) / 2) > 0.02 or abs((lo[2] + hi[2]) / 2) > 0.02:
            errs.append("base 的占地中心应在 x=z=0，现在是 (%.3f, %.3f)" % ((lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2))
    for a in bpy.data.actions:
        base_name = a.name[: -len("-loop")] if a.name.endswith("-loop") else a.name
        if not STATE_RE.match(base_name) or "_" in base_name[len("state_") :]:
            errs.append("动画名要是 state_<状态名>（循环的后面加 -loop）：" + a.name)
    if errs:
        raise KitError("资产 %s 不符合约定：\n  - " % _meta["id"] + "\n  - ".join(errs))


def export(out_path):
    """检查并导出 GLB。out_path 取命令行 `--` 后的第一个参数。"""
    check()
    _root["layout_version"] = LAYOUT_VERSION
    _root["kit"] = _meta["kit"]
    _root["version"] = _meta["version"]
    _root["origin"] = _meta["origin"]
    _root["script"] = _meta["script"]
    _root["blender"] = bpy.app.version_string
    bpy.ops.object.select_all(action="SELECT")
    r = bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_extras=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_cameras=False,
        export_lights=False,
    )
    if "FINISHED" not in r:
        raise KitError("glTF 导出失败：" + str(r))
    print("[kit] 已导出 " + out_path)


def out_path_from_argv():
    argv = sys.argv
    if "--" not in argv or len(argv) <= argv.index("--") + 1:
        raise KitError("用法：blender -b --factory-startup --python build.py -- <输出的.glb>")
    return argv[argv.index("--") + 1]


def run(fn):
    """build.py 的入口：出错打印原因并以非零退出（Blender 脚本出错默认也可能返回 0，所以显式 exit）。"""
    try:
        fn()
    except KitError as e:
        print("[kit] 失败：" + str(e))
        sys.exit(2)
    except Exception:
        import traceback

        traceback.print_exc()
        sys.exit(3)
