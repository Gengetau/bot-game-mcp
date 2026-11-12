class_name TWorld
extends Node3D
## 灰盒场景：从服务器的 /map 清单生成（地面按服务器栅格化后的网格着色，障碍、物件、门口按地图源摆放）。
## 客户端不自己栅格化、不自己寻路。每个场景（town / home）各一棵节点树，按需显示。

const WALL_CUT_H := 1.1  # 墙画成半高，免得斜俯视时挡住室内

var manifest: Dictionary = {}
var roots: Dictionary = {}  # scene id -> Node3D
var objects: Dictionary = {}  # scene id -> Array[Dictionary]
var zone_labels: Dictionary = {}  # scene id -> Array[Dictionary{name, pos}]
var portals: Dictionary = {}  # scene id -> Array[Dictionary{id, name, pos}]
var scene_names: Dictionary = {}
var bounds: Dictionary = {}  # scene id -> Rect2
var current: String = ""
var _mats: Dictionary = {}

const ZONE_COLORS := {
	"plaza": Color(0.78, 0.74, 0.64),
	"garden": Color(0.48, 0.66, 0.42),
	"residential": Color(0.76, 0.64, 0.54),
	"road": Color(0.58, 0.59, 0.62),
	"tea_house": Color(0.82, 0.64, 0.46),
	"bookshop": Color(0.66, 0.6, 0.78),
	"kitchen": Color(0.86, 0.74, 0.5),
	"arcade": Color(0.55, 0.68, 0.8),
	"home": Color(0.84, 0.74, 0.6),
}
const KIND_COLORS := {
	"wall": Color(0.9, 0.88, 0.84),
	"building": Color(0.72, 0.68, 0.64),
	"prop": Color(0.8, 0.62, 0.4),
	"water": Color(0.35, 0.58, 0.85),
	"fence": Color(0.62, 0.5, 0.38),
}
const OBJECT_COLORS := {
	"tea_table": Color(0.62, 0.42, 0.26),
	"bookshelf": Color(0.45, 0.3, 0.2),
	"stove": Color(0.35, 0.35, 0.4),
	"planter": Color(0.4, 0.55, 0.28),
}


func clear_all() -> void:
	for k in roots:
		(roots[k] as Node).queue_free()
	roots.clear()
	objects.clear()
	zone_labels.clear()
	portals.clear()
	scene_names.clear()
	bounds.clear()
	_mats.clear()
	current = ""


func build(m: Dictionary) -> void:
	clear_all()
	manifest = m
	var src: Dictionary = m.get("source", {})
	var grids: Dictionary = m.get("grids", {})
	for sc in src.get("scenes", []):
		var sid: String = str(sc.get("id", ""))
		var root := Node3D.new()
		root.name = "scene_" + sid
		root.visible = false
		add_child(root)
		roots[sid] = root
		scene_names[sid] = str(sc.get("name", sid))
		_build_scene(sc, grids.get(sid, {}), root)


func show_scene(sid: String) -> void:
	current = sid
	for k in roots:
		(roots[k] as Node3D).visible = (k == sid)


func scene_objects(sid: String) -> Array:
	return objects.get(sid, [])


func find_object(sid: String, oid: String) -> Dictionary:
	for o in scene_objects(sid):
		if str(o["id"]) == oid:
			return o
	return {}


## 区域编号 -> 名字（用 /map 清单里的区域表）。
func space_name(sid: String, space: String) -> String:
	var g: Dictionary = (manifest.get("grids", {}) as Dictionary).get(sid, {})
	for z in g.get("zones", []):
		if str(z.get("id", "")) == space:
			return str(z.get("name", space))
	return str(scene_names.get(sid, space))


func _mat(color: Color, unshaded: bool = false, alpha: float = 1.0) -> StandardMaterial3D:
	var key := "%s|%s|%s" % [color.to_html(), unshaded, alpha]
	if _mats.has(key):
		return _mats[key]
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(color.r, color.g, color.b, alpha)
	if unshaded:
		m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	if alpha < 1.0:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_mats[key] = m
	return m


func _zone_color(zid: String) -> Color:
	if ZONE_COLORS.has(zid):
		return ZONE_COLORS[zid]
	var h: int = zid.hash()
	return Color.from_hsv(float(h % 360) / 360.0, 0.25, 0.8)


func _box(parent: Node3D, pos: Vector3, size: Vector3, mat: Material, node_name: String = "") -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.material_override = mat
	mi.position = pos
	if node_name != "":
		mi.name = node_name.replace(":", "_").replace(".", "_")
	parent.add_child(mi)
	return mi


func _build_scene(sc: Dictionary, grid: Dictionary, root: Node3D) -> void:
	var sid: String = str(sc.get("id", ""))
	var cell: float = float(sc.get("cell", 0.5))
	var b: Dictionary = sc.get("bounds", {})
	var ox: float = float(b.get("x", 0.0))
	var oz: float = float(b.get("z", 0.0))
	var cols: int = int(grid.get("cols", 0))
	var rows: int = int(grid.get("rows", 0))
	bounds[sid] = Rect2(ox, oz, float(b.get("w", cols * cell)), float(b.get("d", rows * cell)))

	# 场外的地：一大块草地
	var outer := MeshInstance3D.new()
	var opm := PlaneMesh.new()
	opm.size = Vector2(400, 400)
	outer.mesh = opm
	outer.material_override = _mat(Color(0.36, 0.5, 0.36) if sid == "town" else Color(0.3, 0.32, 0.36), true)
	outer.position = Vector3(ox + cols * cell * 0.5, -0.03, oz + rows * cell * 0.5)
	root.add_child(outer)

	# 地面：一格一个像素，颜色按服务器给的区域划分
	if cols > 0 and rows > 0:
		var zones: Array = grid.get("zones", [])
		var rows_ascii: Array = grid.get("rows_ascii", [])
		var zones_ascii: Array = grid.get("zones_ascii", [])
		var img := Image.create(cols, rows, false, Image.FORMAT_RGB8)
		var off_col := Color(0.30, 0.42, 0.30) if sid == "town" else Color(0.22, 0.24, 0.28)
		for r in range(rows):
			var wr: String = str(rows_ascii[r])
			var zr: String = str(zones_ascii[r])
			for c in range(cols):
				var col: Color = off_col
				var zi: int = _zone_index(zr[c])
				var zid: String = "road"
				if zi >= 0 and zi < zones.size():
					zid = str((zones[zi] as Dictionary).get("id", "road"))
				if wr[c] == ".":
					col = _zone_color(zid)
					if (c + r) % 2 == 1:
						col = col.darkened(0.04)
				elif zi > 0 and zid != "road":
					# 不可走但属于某个室内 / 场地区域（墙边、物件占地）：画成同色的暗一点的地
					col = _zone_color(zid).darkened(0.25)
				img.set_pixel(c, r, col)
		var tex := ImageTexture.create_from_image(img)
		var gm := StandardMaterial3D.new()
		gm.albedo_texture = tex
		gm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		gm.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
		var ground := MeshInstance3D.new()
		ground.name = "ground"
		var pm := PlaneMesh.new()
		pm.size = Vector2(cols * cell, rows * cell)
		ground.mesh = pm
		ground.material_override = gm
		ground.position = Vector3(ox + cols * cell * 0.5, 0.0, oz + rows * cell * 0.5)
		root.add_child(ground)

	# 障碍（墙画成半高）
	for ob in sc.get("obstacles", []):
		var kind: String = str(ob.get("kind", "prop"))
		var h: float = float(ob.get("h", 1.0))
		if kind == "wall":
			h = minf(h, WALL_CUT_H)
		var w: float = float(ob.get("w", 1.0))
		var d: float = float(ob.get("d", 1.0))
		var col: Color = KIND_COLORS.get(kind, Color(0.7, 0.7, 0.7))
		_box(root, Vector3(float(ob["x"]) + w * 0.5, h * 0.5, float(ob["z"]) + d * 0.5), Vector3(w, h, d), _mat(col), str(ob.get("id", "obstacle")))

	# 可互动物件
	var objs: Array = []
	for it in sc.get("interactables", []):
		var fp: Dictionary = it.get("footprint", {})
		var fw: float = float(fp.get("w", 1.0))
		var fd: float = float(fp.get("d", 1.0))
		var cx: float = float(fp.get("x", float(it["x"]) - 0.5)) + fw * 0.5
		var cz: float = float(fp.get("z", float(it["z"]) - 0.5)) + fd * 0.5
		var kind: String = str(it.get("kind", ""))
		var oh: float = 1.8 if kind == "bookshelf" else (1.0 if kind == "stove" else 0.8)
		var ocol: Color = OBJECT_COLORS.get(kind, Color(0.8, 0.5, 0.2))
		_box(root, Vector3(cx, oh * 0.5, cz), Vector3(fw * 0.9, oh, fd * 0.9), _mat(ocol), "obj_" + str(it["id"]))
		if kind == "planter":
			var bush := MeshInstance3D.new()
			var sm := SphereMesh.new()
			sm.radius = 0.4
			sm.height = 0.8
			bush.mesh = sm
			bush.material_override = _mat(Color(0.3, 0.7, 0.3))
			bush.position = Vector3(cx, oh + 0.25, cz)
			root.add_child(bush)
		for ua in it.get("useAnchors", []):
			var pad := MeshInstance3D.new()
			var cyl := CylinderMesh.new()
			cyl.top_radius = 0.28
			cyl.bottom_radius = 0.28
			cyl.height = 0.01
			pad.mesh = cyl
			pad.material_override = _mat(Color(0.15, 0.15, 0.2), true, 0.35)
			pad.position = Vector3(float(ua["x"]), 0.025, float(ua["z"]))
			root.add_child(pad)
		var pad_h: float = oh + 0.1
		objs.append(
			{
				"id": str(it["id"]),
				"name": str(it.get("name", it["id"])),
				"kind": kind,
				"pos": Vector3(cx, pad_h, cz),
				"aabb": AABB(Vector3(cx - fw * 0.5 - 0.3, 0.0, cz - fd * 0.5 - 0.3), Vector3(fw + 0.6, oh + 0.3, fd + 0.6)),
				"x": float(it["x"]),
				"z": float(it["z"]),
			}
		)
	objects[sid] = objs

	# 区域名牌位置
	var labels: Array = []
	for z in sc.get("zones", []):
		var rects: Array = z.get("rects", [])
		if rects.is_empty():
			continue
		var r0: Dictionary = rects[0]
		labels.append({"name": str(z.get("name", "")), "pos": Vector3(float(r0["x"]) + float(r0["w"]) * 0.5, 0.2, float(r0["z"]) + float(r0["d"]) * 0.5)})
	zone_labels[sid] = labels

	# 门口（进出口）
	var anchors: Dictionary = {}
	for an in sc.get("anchors", []):
		anchors[str(an["id"])] = an
	var plist: Array = []
	for p in sc.get("portals", []):
		var an: Dictionary = anchors.get(str(p.get("anchor", "")), {})
		if an.is_empty():
			continue
		var px: float = float(an["x"])
		var pz: float = float(an["z"])
		var pname: String = "家门" if str(p["id"]) == "home" else ("出口" if str(p["id"]) == "exit" else str(p["id"]))
		var pad := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(1.4, 0.02, 1.4)
		pad.mesh = bm
		pad.material_override = _mat(Color(0.95, 0.8, 0.3), true, 0.8)
		pad.position = Vector3(px, 0.04, pz)
		root.add_child(pad)
		var facing: float = float(an.get("facing", 0.0))
		var side := Vector3(cos(facing), 0, sin(facing))  # 垂直于朝向（朝向 0 = 北 = -z）
		for sgn in [-1.0, 1.0]:
			_box(root, Vector3(px, 1.0, pz) + side * 0.8 * sgn, Vector3(0.15, 2.0, 0.15), _mat(Color(0.85, 0.65, 0.2)))
		plist.append({"id": str(p["id"]), "name": pname, "pos": Vector3(px, 2.2, pz)})
	portals[sid] = plist


## 区域下标字符（0-9a-z）-> 数字。
func _zone_index(ch: String) -> int:
	var u: int = ch.unicode_at(0)
	if u >= 48 and u <= 57:
		return u - 48
	if u >= 97 and u <= 122:
		return u - 97 + 10
	return -1
