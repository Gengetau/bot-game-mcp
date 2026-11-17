class_name TArt
extends RefCounted
## 素材层：「种类 -> 模型」表。
## 默认表是 res://assets/art_table.json（只引用仓库里的 CC0 素材）。导出时如果存在 res://art_private/art_table.json
## （不进 git，放别的素材包用），里面同名条目覆盖默认条目，缺的条目沿用默认表。
##
## 条目字段（都可省）：
##   model   外部模型路径（glb / scn / tscn），取其中所有 MeshInstance3D 的网格和相对变换
##   proc    程序生成配方名（scripts/town_art.gd 里的 build_<proc>）；有 model 时优先 model
##   scale   整体缩放（数字或 [x, y, z]），yaw 绕 y 转多少度，offset [x, y, z]
##   palette 模型是否改用栖灯镇的静态材质（色板贴图 x 顶点色）。默认：路径在 assets/models/kenney/ 下为真，其它为假（保留模型自带材质）
##   fade    true：这类东西会在遮住角色时被淡出（树）
##   glow    [x, y, z]：夜里在这个位置（模型坐标）放一个光晕
##   fit     true：（建筑用）把模型整个拉伸到建筑外框，不再生成程序屋顶，也没有屋顶淡出
##   scene   包装场景路径（assets/kits/<套件>/<资产编号>/<资产编号>.tscn，根节点挂 stateful_prop.gd）。有 scene 的种类不再走 parts() 拍平网格，
##           而是每个物件实例化一份、按服务端状态切外观（world.gd 的 _build_interactables / _add_building）。scene 优先于 model / proc。
##           可查的键：功能物件是 "prop.<物件种类>"（如 prop.stove），建筑是 "building.<区域编号>"（如 building.kitchen）。
##           art_private 里同名条目同样覆盖。资产约定见 client/docs/T02a.md。

const DebugFlags := preload("res://scripts/debug_flags.gd")
const TABLE_PATH := "res://assets/art_table.json"
const OVERRIDE_PATH := "res://art_private/art_table.json"

var kinds: Dictionary = {}
var palette_path: String = ""
var overridden: Array = []
var _parts: Dictionary = {}  # kind -> Array[{mesh, xf, palette}]


static func _read_json(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {}
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return {}
	var d = JSON.parse_string(f.get_as_text())
	return d if d is Dictionary else {}


func _init() -> void:
	var base: Dictionary = _read_json(TABLE_PATH)
	kinds = (base.get("kinds", {}) as Dictionary).duplicate(true)
	palette_path = str(base.get("palette", ""))
	var ov: Dictionary = _read_json(OVERRIDE_PATH)
	for k in (ov.get("kinds", {}) as Dictionary):
		kinds[k] = (ov["kinds"] as Dictionary)[k]
		overridden.append(k)
	if ov.has("palette"):
		palette_path = str(ov["palette"])


## 调试开关最后叠（?debug=1&props=sample）。不能放在 _init 里：TWorld 在 main 的字段初始化时就建好了，那时 bridge.setup 还没读地址栏。
## world.build() 开头调它；不带 debug 时 props_mode 一定是空的，什么都不做。
func apply_debug() -> void:
	for k in DebugFlags.apply_props(kinds, DebugFlags.props_mode):
		if not (k in overridden):
			overridden.append(k)
		_parts.erase(k)


func has(kind: String) -> bool:
	return kinds.has(kind)


## 这个种类的包装场景路径；没有 scene 条目、或文件不存在时返回空串（调用方走原来的路径）。
func scene_path(kind: String) -> String:
	var p: String = str(entry(kind).get("scene", ""))
	if p != "" and ResourceLoader.exists(p):
		return p
	return ""


func has_scene(kind: String) -> bool:
	return scene_path(kind) != ""


func entry(kind: String) -> Dictionary:
	return kinds.get(kind, {})


func proc_name(kind: String) -> String:
	var e: Dictionary = entry(kind)
	if has_scene(kind) or str(e.get("model", "")) != "":
		return ""
	return str(e.get("proc", ""))


func is_fade(kind: String) -> bool:
	return bool(entry(kind).get("fade", false))


func glow_offset(kind: String) -> Variant:
	var g = entry(kind).get("glow")
	if g is Array and (g as Array).size() >= 3:
		return Vector3(float(g[0]), float(g[1]), float(g[2]))
	return null


func _vec3(v, d: Vector3) -> Vector3:
	if v is Array and (v as Array).size() >= 3:
		return Vector3(float(v[0]), float(v[1]), float(v[2]))
	if v is float or v is int:
		return Vector3.ONE * float(v)
	return d


## 模型的网格部件：[{mesh, xf, palette}]，xf 已经含条目的 scale / yaw / offset。
func parts(kind: String) -> Array:
	if _parts.has(kind):
		return _parts[kind]
	var out: Array = []
	var e: Dictionary = entry(kind)
	if has_scene(kind):
		_parts[kind] = out  # 有 scene 的种类不拍平网格（world.gd 按物件实例化包装场景）
		return out
	var path: String = str(e.get("model", ""))
	if path != "" and ResourceLoader.exists(path):
		var res = load(path)
		var inst: Node = null
		if res is PackedScene:
			inst = (res as PackedScene).instantiate()
		if inst != null:
			var sc: Vector3 = _vec3(e.get("scale"), Vector3.ONE)
			var yaw: float = deg_to_rad(float(e.get("yaw", 0.0)))
			var off: Vector3 = _vec3(e.get("offset"), Vector3.ZERO)
			var root_xf := Transform3D(Basis(Vector3.UP, yaw) * Basis.from_scale(sc), off)
			var use_pal: bool = bool(e.get("palette", path.contains("/kenney/")))
			_collect(inst, inst, root_xf, use_pal, out)
			inst.free()
	_parts[kind] = out
	return out


func _collect(n: Node, root: Node, xf_parent: Transform3D, use_pal: bool, out: Array) -> void:
	var xf: Transform3D = xf_parent
	if n != root and n is Node3D:
		xf = xf_parent * (n as Node3D).transform
	if n is MeshInstance3D and (n as MeshInstance3D).mesh != null:
		out.append({"mesh": (n as MeshInstance3D).mesh, "xf": xf, "palette": use_pal})
	for c in n.get_children():
		_collect(c, root, xf, use_pal, out)
