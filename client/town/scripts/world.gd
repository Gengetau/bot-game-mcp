class_name TWorld
extends Node3D
## 栖灯镇的街景：从服务器的 /map 清单生成。地面、墙、障碍物、可互动物件的位置全部来自清单（和服务器完全一致），
## 外观由素材层（art.gd / art_table.json）和程序配方（town_art.gd）决定；装饰（树、栅栏、花、灯）只放在不可走的地方，
## 放之前按服务器给的栅格检查，压到可走格的一律丢掉。客户端不栅格化、不寻路。
## 每个场景（town / home）各一棵节点树，按需显示。

const T_GRASS := 0
const T_ROAD := 1
const T_PLAZA := 2
const T_GARDEN := 3
const T_HALL := 4
const T_SILL := 9
const T_HOME := 10
const T_VOID := 11
const ZONE_TERRAIN := {"road": 1, "plaza": 2, "garden": 3, "residential": 4, "tea_house": 5, "bookshop": 6, "kitchen": 7, "arcade": 8, "home": 10}
const INDOOR := ["tea_house", "bookshop", "kitchen", "arcade", "home"]
const BUILDINGS := {
	"tea_house": {"door": {"side": "s", "x0": 9.65, "x1": 12.35}, "sign": "tea", "accent": Color(0.28, 0.46, 0.50), "roof": Color(0.46, 0.55, 0.64), "nwin": [6.0, 11.0, 16.0]},
	"bookshop": {"door": {"side": "s", "x0": 26.65, "x1": 29.35}, "sign": "book", "accent": Color(0.34, 0.52, 0.40), "roof": Color(0.46, 0.55, 0.62), "nwin": [23.3, 32.7]},
	"kitchen": {"door": {"side": "s", "x0": 49.65, "x1": 52.35}, "sign": "kitchen", "accent": Color(0.74, 0.42, 0.30), "roof": Color(0.50, 0.52, 0.60), "chimney": true, "nwin": [45.6, 51.0, 56.6]},
	"arcade": {"door": {"side": "n", "x0": 30.65, "x1": 33.35}, "sign": "arcade", "accent": Color(0.42, 0.46, 0.72), "roof": Color(0.44, 0.50, 0.66), "nwin": []},
}

var manifest: Dictionary = {}
var roots: Dictionary = {}  # scene id -> Node3D
var objects: Dictionary = {}  # scene id -> Array[Dictionary]
var zone_labels: Dictionary = {}  # scene id -> Array[Dictionary{name, pos}]
var portals: Dictionary = {}  # scene id -> Array[Dictionary{id, name, pos}]
var scene_names: Dictionary = {}
var bounds: Dictionary = {}  # scene id -> Rect2
var current: String = ""
var art := TArt.new()
var stats: Dictionary = {}
var quality_high: bool = true
var glow_nodes: Dictionary = {}

var _mat_static: ShaderMaterial
var _mat_glow: ShaderMaterial
var _fade_items: Dictionary = {}  # scene id -> Array[Dictionary{node, mat, aabb, outer, min, fade, inside}]
var _walk: Dictionary = {}  # scene id -> {cols, rows, cell, ox, oz, data: PackedByteArray}
var _mm: Dictionary = {}  # 摆放中的 MultiMesh 数据 scene -> kind -> Array[Transform3D]
var _glows: Dictionary = {}  # scene -> Array[Transform3D]
var _lamps: Dictionary = {}  # scene -> Array[Vector4]
var _kind_cache: Dictionary = {}
var _warmed: Dictionary = {}
var _bakes: Array = []  # 地面烘焙的 SubViewport（挂在自己下面，clear_all 要一并释放）
var _cur: Dictionary = {}  # 正在构建的场景的上下文
var rejected: int = 0
var placed: int = 0


func clear_all() -> void:
	for k in roots:
		(roots[k] as Node).queue_free()
	roots.clear()
	for bv in _bakes:
		if is_instance_valid(bv):
			(bv as Node).queue_free()
	_bakes.clear()
	_warmed.clear()
	objects.clear()
	zone_labels.clear()
	portals.clear()
	scene_names.clear()
	bounds.clear()
	_fade_items.clear()
	_walk.clear()
	_mm.clear()
	_glows.clear()
	glow_nodes.clear()
	_lamps.clear()
	_kind_cache.clear()
	current = ""


func _ensure_materials() -> void:
	if _mat_static != null:
		return
	_mat_static = ShaderMaterial.new()
	_mat_static.shader = load("res://assets/shaders/town.gdshader")
	var pal: Texture2D = load(art.palette_path)
	_mat_static.set_shader_parameter("pal", pal)
	_mat_glow = ShaderMaterial.new()
	_mat_glow.shader = load("res://assets/shaders/glow.gdshader")


func build(m: Dictionary) -> void:
	clear_all()
	manifest = m
	_ensure_materials()
	rejected = 0
	placed = 0
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
	_warm_up(sid)


## 预热：兼容渲染器在某个东西第一次进入画面时才编译着色器、上传缓冲，软件渲染下一次可达半秒以上，
## 正好发生在玩家走到那里的那一帧（按住方向键的租约只有 0.5 秒，会因此停下）。
## 这里用一个很小的离屏视口、从正上方的正交镜头把整个场景画一遍，让这些一次性开销在进入小镇时就付掉。
func _warm_up(sid: String) -> void:
	if _warmed.has(sid) or not bounds.has(sid) or not is_inside_tree():
		return
	_warmed[sid] = true
	var r: Rect2 = bounds[sid]
	var vp := SubViewport.new()
	vp.size = Vector2i(48, 48)
	vp.render_target_update_mode = SubViewport.UPDATE_ONCE
	vp.disable_3d = false
	var cam := Camera3D.new()
	cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	cam.size = maxf(r.size.x, r.size.y) * 1.05
	cam.near = 0.5
	cam.far = 300.0
	cam.current = true
	vp.add_child(cam)
	add_child(vp)
	var c: Vector2 = r.get_center()
	cam.global_position = Vector3(c.x, 120.0, c.y)
	cam.look_at(Vector3(c.x, 0.0, c.y), Vector3.FORWARD)
	for i in range(3):
		await get_tree().process_frame
	vp.queue_free()


func scene_objects(sid: String) -> Array:
	return objects.get(sid, [])


func find_object(sid: String, oid: String) -> Dictionary:
	for o in scene_objects(sid):
		if str(o["id"]) == oid:
			return o
	return {}


## 站在茶桌旁座位上（离某个使用锚点 maxd 以内）：返回 {object, center}，否则 {}。
func sit_spot(sid: String, pos: Vector2, maxd: float = 0.5) -> Dictionary:
	for o in scene_objects(sid):
		if str(o["kind"]) != "tea_table":
			continue
		for a in (o["anchors"] as Array):
			if (a as Vector2).distance_to(pos) <= maxd:
				return {"object": str(o["id"]), "center": o["center"]}
	return {}


## 区域编号 -> 名字（用 /map 清单里的区域表）。
func space_name(sid: String, space: String) -> String:
	var g: Dictionary = (manifest.get("grids", {}) as Dictionary).get(sid, {})
	for z in g.get("zones", []):
		if str(z.get("id", "")) == space:
			return str(z.get("name", space))
	return str(scene_names.get(sid, space))


# ───────────────────────── 每帧：遮挡淡出 ─────────────────────────


## cam_pos：镜头位置。heads：需要看清的人的头顶位置（世界坐标）。挡在镜头和人之间的屋顶 / 前墙上半 / 树会淡出，
## 人在屋里时整栋房子的屋顶和前墙上半直接淡掉。
func update_view(cam_pos: Vector3, heads: Array, dt: float) -> void:
	var items: Array = _fade_items.get(current, [])
	var k: float = 1.0 - exp(-dt * 9.0)
	for it in items:
		var tgt: float = 1.0
		var aabb: AABB = it["aabb"]
		var outer: Rect2 = it["outer"]
		for h in heads:
			var hp: Vector3 = h
			if outer.size.x > 0.0 and outer.has_point(Vector2(hp.x, hp.z)):
				tgt = 0.0
				break
			if aabb.intersects_segment(cam_pos, hp) != null:
				tgt = minf(tgt, float(it["min"]))
		var f: float = float(it["fade"])
		var nf: float = lerpf(f, tgt, k)
		if absf(nf - tgt) < 0.01:
			nf = tgt
		if nf != f:
			it["fade"] = nf
			(it["mat"] as ShaderMaterial).set_shader_parameter("fade", nf)
			(it["node"] as Node3D).visible = nf > 0.02


## 把所有淡出物立刻设到目标（截图、切换场景时用）。
## 昼夜：n 是 0..1 的夜晚程度。白天不画光晕（白天它们本来就是全黑的加色，白占填充率）。
func set_night(n: float) -> void:
	for sid in glow_nodes:
		(glow_nodes[sid] as Node3D).visible = n > 0.02


func settle_view(cam_pos: Vector3, heads: Array) -> void:
	update_view(cam_pos, heads, 10.0)


# ───────────────────────── 栅格 ─────────────────────────


func _walkable_at(sid: String, x: float, z: float) -> bool:
	var w: Dictionary = _walk.get(sid, {})
	if w.is_empty():
		return false
	var c: int = int(floor((x - float(w["ox"])) / float(w["cell"])))
	var r: int = int(floor((z - float(w["oz"])) / float(w["cell"])))
	if c < 0 or r < 0 or c >= int(w["cols"]) or r >= int(w["rows"]):
		return false
	return (w["data"] as PackedByteArray)[r * int(w["cols"]) + c] == 1


## 以 (x, z) 为中心的矩形 (hx, hz) 是否碰到可走格。
func footprint_free(sid: String, x: float, z: float, hx: float, hz: float) -> bool:
	var cell: float = float((_walk.get(sid, {"cell": 0.5}) as Dictionary)["cell"])
	var xs: float = x - hx
	while xs <= x + hx + cell:
		var zs: float = z - hz
		while zs <= z + hz + cell:
			if _walkable_at(sid, minf(xs, x + hx), minf(zs, z + hz)):
				return false
			zs += cell
		xs += cell
	return true


# ───────────────────────── 摆放 ─────────────────────────


func _proc_mesh(kind: String, params: Dictionary) -> Array:
	var key: String = kind + "|" + JSON.stringify(params)
	if _kind_cache.has(key):
		return _kind_cache[key]
	var out: Array = []
	var model_parts: Array = art.parts(kind)
	if not model_parts.is_empty():
		out = model_parts
	else:
		var pn: String = art.proc_name(kind)
		var scr: GDScript = load("res://scripts/town_art.gd")
		if pn != "" and scr.has_method("build_" + pn):
			var b := TMB.new()
			scr.call("build_" + pn, b, params)
			if not b.is_empty():
				out.append({"mesh": b.to_mesh(), "xf": Transform3D.IDENTITY, "palette": true})
	_kind_cache[key] = out
	return out


## 摆一个东西。x z：落点；y：离地高度；yaw：绕 y 转的角度（度）；s：缩放；hx hz：占地半尺寸（碰到可走格就丢掉，<0 不检查）。
## 返回是否放下了。
func put(kind: String, x: float, z: float, yaw: float = 0.0, s: float = 1.0, hx: float = 0.3, hz: float = -1.0, params: Dictionary = {}, y: float = 0.0, check: bool = true) -> bool:
	var sid: String = _cur["sid"]
	if check and hx >= 0.0 and not footprint_free(sid, x, z, hx, hx if hz < 0.0 else hz):
		rejected += 1
		return false
	var parts: Array = _proc_mesh(kind, params)
	if parts.is_empty():
		return false
	var xf := Transform3D(Basis(Vector3.UP, deg_to_rad(yaw)).scaled(Vector3.ONE * s), Vector3(x, y, z))
	placed += 1
	if art.is_fade(kind):
		_add_fade_object(parts, xf, kind, hx if hx > 0 else 1.0)
		var gl = art.glow_offset(kind)
		if gl != null:
			pass
		return true
	var mmk: Dictionary = _cur["mm"]
	for i in range(parts.size()):
		var key: String = "%s|%s|%d" % [kind, JSON.stringify(params), i]
		if not mmk.has(key):
			mmk[key] = {"part": parts[i], "xfs": []}
		(mmk[key]["xfs"] as Array).append(xf * (parts[i]["xf"] as Transform3D))
	var g = art.glow_offset(kind)
	if g != null:
		var gp: Vector3 = xf * (g as Vector3)
		_cur["glows"].append(Transform3D(Basis.from_scale(Vector3(2.2, 2.2, 2.2)), gp))
		_cur["lamps"].append(Vector4(x, z, 5.0, 1.0))
	return true


func glow(pos: Vector3, size: float) -> void:
	(_cur["glows"] as Array).append(Transform3D(Basis.from_scale(Vector3(size, size, size)), pos))


func pool(x: float, z: float, radius: float, strength: float) -> void:
	(_cur["lamps"] as Array).append(Vector4(x, z, radius, strength))


func _add_fade_object(parts: Array, xf: Transform3D, _kind: String, r: float) -> void:
	var sid: String = _cur["sid"]
	var root: Node3D = _cur["root"]
	var mat: ShaderMaterial = _mat_static.duplicate()
	var holder := Node3D.new()
	holder.transform = xf
	root.add_child(holder)
	var box := AABB()
	var first := true
	for p in parts:
		var mi := MeshInstance3D.new()
		mi.mesh = p["mesh"]
		mi.transform = p["xf"]
		if bool(p["palette"]):
			mi.material_override = mat
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		holder.add_child(mi)
		var bb: AABB = (p["xf"] as Transform3D) * (p["mesh"] as Mesh).get_aabb()
		box = bb if first else box.merge(bb)
		first = false
	var wb: AABB = xf * box
	# 只取树冠部分（树干不挡人）：把包围盒收窄一点
	var shrink: float = 0.18
	wb = wb.grow(-minf(wb.size.x, wb.size.z) * shrink)
	(_fade_items[sid] as Array).append({"node": holder, "mat": mat, "aabb": wb, "outer": Rect2(), "min": 0.22, "fade": 1.0})


func _flush_multimeshes() -> void:
	var root: Node3D = _cur["root"]
	var mmk: Dictionary = _cur["mm"]
	var verts: int = 0
	for key in mmk:
		var d: Dictionary = mmk[key]
		var xfs: Array = d["xfs"]
		var part: Dictionary = d["part"]
		var mm := MultiMesh.new()
		mm.transform_format = MultiMesh.TRANSFORM_3D
		mm.mesh = part["mesh"]
		mm.instance_count = xfs.size()
		for i in range(xfs.size()):
			mm.set_instance_transform(i, xfs[i])
		var mmi := MultiMeshInstance3D.new()
		mmi.multimesh = mm
		if bool(part["palette"]):
			mmi.material_override = _mat_static
		mmi.name = "mm_" + str(key).get_slice("|", 0).replace(".", "_")
		root.add_child(mmi)
		for si in range((part["mesh"] as Mesh).get_surface_count()):
			var arrs: Array = (part["mesh"] as Mesh).surface_get_arrays(si)
			verts += (arrs[Mesh.ARRAY_VERTEX] as PackedVector3Array).size() * xfs.size()
	_cur["verts_mm"] = verts


func _flush_glows() -> void:
	var gl: Array = _cur["glows"]
	if gl.is_empty():
		return
	var quad := QuadMesh.new()
	quad.size = Vector2(1, 1)
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = quad
	mm.instance_count = gl.size()
	for i in range(gl.size()):
		mm.set_instance_transform(i, gl[i])
	var mmi := MultiMeshInstance3D.new()
	mmi.multimesh = mm
	mmi.material_override = _mat_glow
	mmi.name = "glows"
	mmi.visible = false
	_cur["glows_node"] = mmi
	mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	(_cur["root"] as Node3D).add_child(mmi)


# ───────────────────────── 建筑 ─────────────────────────


func _add_building(p: Dictionary, is_hall: bool) -> void:
	var sid: String = _cur["sid"]
	var root: Node3D = _cur["root"]
	var kind: String = "building.hall" if is_hall else "building.house"
	var res: Dictionary
	if is_hall:
		res = TTownArt.build_hall(p)
	else:
		res = TTownArt.build_house(p)
	var shell: TMB = res["shell"]
	var up: TMB = res["up"]
	if not shell.is_empty():
		var mi := MeshInstance3D.new()
		mi.mesh = shell.to_mesh()
		mi.material_override = _mat_static
		mi.name = "shell_" + str(p.get("name", "b"))
		root.add_child(mi)
		_cur["verts_static"] += shell.v.size()
	var mat: ShaderMaterial = _mat_static.duplicate()
	var umi := MeshInstance3D.new()
	umi.mesh = up.to_mesh()
	umi.material_override = mat
	umi.name = "up_" + str(p.get("name", "b"))
	root.add_child(umi)
	_cur["verts_static"] += up.v.size()
	var outer: Rect2 = res["outer"] if not is_hall else Rect2()
	(_fade_items[sid] as Array).append({"node": umi, "mat": mat, "aabb": res["up_aabb"], "outer": outer, "min": 0.1, "fade": 1.0})
	for g in res["glows"]:
		glow(g["pos"], float(g["size"]) * float(g["strength"]) * 1.8)
	# 门口的暖光池
	if not is_hall:
		var d: Dictionary = p["door"]
		var ds: float = 1.0 if str(d["side"]) == "s" else -1.0
		var o: Rect2 = res["outer"]
		var zz: float = (o.position.y + o.size.y) if str(d["side"]) == "s" else o.position.y
		pool((float(d["x0"]) + float(d["x1"])) * 0.5, zz + ds * 0.8, 3.2, 0.9)
	else:
		pool(float(p["front_x"]) + 1.2, float(p["door_z"]) - 1.3, 2.8, 0.8)
		pool(float(p["front_x"]) + 1.2, float(p["door_z"]) + 1.3, 2.8, 0.8)
	_cur["builds"].append({"kind": kind, "outer": res["outer"]})


# ───────────────────────── 场景 ─────────────────────────


func _terrain_cell(zid: String, walkable: bool, sid: String) -> int:
	if sid == "home":
		return T_HOME if walkable else T_VOID
	if zid in INDOOR:
		return ZONE_TERRAIN[zid]
	if walkable:
		return ZONE_TERRAIN.get(zid, T_ROAD)
	if zid == "plaza":
		return T_PLAZA
	if zid == "residential":
		return T_HALL
	if zid == "garden":
		return T_GARDEN
	return T_GRASS


static func _is_paved(id: int) -> bool:
	return id == T_ROAD or id == T_PLAZA or id == T_HALL or id == T_SILL


func _zone_index(ch: String) -> int:
	var u: int = ch.unicode_at(0)
	if u >= 48 and u <= 57:
		return u - 48
	if u >= 97 and u <= 122:
		return u - 97 + 10
	return -1


func _build_scene(sc: Dictionary, grid: Dictionary, root: Node3D) -> void:
	var sid: String = str(sc.get("id", ""))
	var cell: float = float(sc.get("cell", 0.5))
	var b: Dictionary = sc.get("bounds", {})
	var ox: float = float(b.get("x", 0.0))
	var oz: float = float(b.get("z", 0.0))
	var cols: int = int(grid.get("cols", 0))
	var rows: int = int(grid.get("rows", 0))
	bounds[sid] = Rect2(ox, oz, float(b.get("w", cols * cell)), float(b.get("d", rows * cell)))
	_fade_items[sid] = []
	_cur = {"sid": sid, "root": root, "mm": {}, "glows": [], "lamps": [], "builds": [], "verts_static": 0, "verts_mm": 0}

	# 栅格：可走 / 不可走，地形编号，接触暗角
	var walk := PackedByteArray()
	walk.resize(cols * rows)
	var tid_arr := PackedByteArray()
	tid_arr.resize(cols * rows)
	var types := Image.create(cols, rows, false, Image.FORMAT_RG8)
	var aoi := Image.create(cols, rows, false, Image.FORMAT_R8)
	var zones: Array = grid.get("zones", [])
	var rows_ascii: Array = grid.get("rows_ascii", [])
	var zones_ascii: Array = grid.get("zones_ascii", [])
	for r in range(rows):
		var wr: String = str(rows_ascii[r])
		var zr: String = str(zones_ascii[r])
		for c in range(cols):
			var zi: int = _zone_index(zr[c])
			var zid: String = "road"
			if zi >= 0 and zi < zones.size():
				zid = str((zones[zi] as Dictionary).get("id", "road"))
			var ok: bool = wr[c] == "."
			walk[r * cols + c] = 1 if ok else 0
			var tid: int = _terrain_cell(zid, ok, sid)
			if not ok and zi <= 0 and sid != "home":
				tid = T_GRASS
			tid_arr[r * cols + c] = tid
	_walk[sid] = {"cols": cols, "rows": rows, "cell": cell, "ox": ox, "oz": oz, "data": walk}
	# 建筑内部整块铺地板（墙厚 0.3 的缝隙也盖住），之后再算暗角
	var inner_rects: Array = []
	for z in sc.get("zones", []):
		var zid2: String = str(z.get("id", ""))
		if zid2 in INDOOR and sid == "town":
			var r0: Dictionary = (z.get("rects", []) as Array)[0]
			inner_rects.append({"id": zid2, "rect": Rect2(float(r0["x"]), float(r0["z"]), float(r0["w"]), float(r0["d"]))})
	for ir in inner_rects:
		var rc: Rect2 = (ir["rect"] as Rect2).grow(0.65)
		for r in range(int(floor((rc.position.y - oz) / cell)), int(ceil((rc.end.y - oz) / cell))):
			for c in range(int(floor((rc.position.x - ox) / cell)), int(ceil((rc.end.x - ox) / cell))):
				if r >= 0 and c >= 0 and r < rows and c < cols:
					var cx: float = ox + (float(c) + 0.5) * cell
					var cz: float = oz + (float(r) + 0.5) * cell
					if rc.has_point(Vector2(cx, cz)) and walk[r * cols + c] == 0:
						tid_arr[r * cols + c] = int(ZONE_TERRAIN[ir["id"]])
	# 接触暗角只给墙和建筑（家具、长椅的占地不画）
	var wallc := PackedByteArray()
	wallc.resize(cols * rows)
	for ob in sc.get("obstacles", []):
		var ok2: String = str(ob.get("kind", ""))
		if ok2 != "wall" and ok2 != "building":
			continue
		var c0: int = maxi(0, int(floor((float(ob["x"]) - ox) / cell)))
		var c1: int = mini(cols - 1, int(floor((float(ob["x"]) + float(ob["w"]) - 0.01 - ox) / cell)))
		var r0: int = maxi(0, int(floor((float(ob["z"]) - oz) / cell)))
		var r1: int = mini(rows - 1, int(floor((float(ob["z"]) + float(ob["d"]) - 0.01 - oz) / cell)))
		for rr in range(r0, r1 + 1):
			for cc in range(c0, c1 + 1):
				wallc[rr * cols + cc] = 1
	for r in range(rows):
		for c in range(cols):
			var v: float = 0.0
			if walk[r * cols + c] == 1:
				for d in [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]:
					var nc: int = c + d.x
					var nr: int = r + d.y
					if nc >= 0 and nr >= 0 and nc < cols and nr < rows and wallc[nr * cols + nc] == 1:
						v = maxf(v, 0.5)
			aoi.set_pixel(c, r, Color(v, 0, 0))
	# 地形编号 + 和邻格的交界（G 通道低四位：-x +x -z +z 方向上的邻格是「草地」或「铺面」，着色器据此画路缘和泥土边，省掉逐像素的邻格采样）
	for r in range(rows):
		for c in range(cols):
			var id0: int = tid_arr[r * cols + c]
			var mask: int = 0
			var dirs := [Vector2i(-1, 0), Vector2i(1, 0), Vector2i(0, -1), Vector2i(0, 1)]
			for di in range(4):
				var nc2: int = c + (dirs[di] as Vector2i).x
				var nr2: int = r + (dirs[di] as Vector2i).y
				if nc2 < 0 or nr2 < 0 or nc2 >= cols or nr2 >= rows:
					continue
				var n0: int = tid_arr[nr2 * cols + nc2]
				if _is_paved(id0) and n0 == T_GRASS:
					mask |= 1 << di
				elif id0 == T_GRASS and _is_paved(n0):
					mask |= 1 << di
			types.set_pixel(c, r, Color(float(id0) / 255.0, float(mask) / 255.0, 0))
	_build_ground(sid, cell, ox, oz, cols, rows, types, aoi, root)

	# 障碍：墙、建筑、道具。墙由房子生成器画，其它按 id 换成家具
	_build_obstacles(sc, sid)
	# 建筑
	if sid == "town":
		for z in sc.get("zones", []):
			var zid3: String = str(z.get("id", ""))
			if BUILDINGS.has(zid3):
				var r0: Dictionary = (z.get("rects", []) as Array)[0]
				var bd: Dictionary = BUILDINGS[zid3]
				var st: Dictionary = {"accent": bd["accent"], "roof": bd["roof"], "chimney": bool(bd.get("chimney", false)), "sign": bd["sign"]}
				_add_building({"name": zid3, "inner": Rect2(float(r0["x"]), float(r0["z"]), float(r0["w"]), float(r0["d"])), "door": bd["door"], "style": st, "nwin": bd["nwin"]}, false)
		_add_building({"name": "hall", "front_x": 1.6, "z0": 21.0, "z1": 31.0, "door_z": 26.25, "depth": 7.0}, true)
	else:
		_add_building({"name": "home", "inner": Rect2(1.0, 1.0, 8.0, 6.0), "door": {"side": "none", "x0": 0.0, "x1": 0.0}, "style": {"accent": Color(0.55, 0.46, 0.60), "roof": Color(0.50, 0.55, 0.65), "plaster": Color(0.95, 0.90, 0.82)}, "nwin": [2.6, 5.0, 7.4]}, false)
	_build_interactables(sc, sid, root)
	TLayout.populate(self, sid, sc)
	_build_portals(sc, sid)
	_build_labels(sc, sid)
	_flush_multimeshes()
	_flush_glows()
	if _cur.has("glows_node"):
		glow_nodes[sid] = _cur["glows_node"]
	_apply_lamps(sid)
	var s: Dictionary = {"verts_static": _cur["verts_static"], "verts_mm": _cur["verts_mm"], "mm_nodes": (_cur["mm"] as Dictionary).size()}
	stats[sid] = s


const BAKE_PPM := 32.0  # 地面贴图的分辨率：每米多少像素


func _build_ground(sid: String, cell: float, ox: float, oz: float, cols: int, rows: int, types: Image, aoi: Image, root: Node3D) -> void:
	# 场外的地：地面四周各一块草地（受光，和地面草色相近；私宅外是暗色的虚空）。不铺在地面下面，省一次满屏的重叠绘制
	var om := StandardMaterial3D.new()
	om.albedo_color = Color(0.50, 0.68, 0.40) if sid == "town" else Color(0.17, 0.18, 0.22)
	om.roughness = 1.0
	om.metallic_specular = 0.0
	var gw: float = cols * cell
	var gd: float = rows * cell
	var big: float = 200.0
	for rect in [Rect2(ox - big, oz - big, gw + 2.0 * big, big), Rect2(ox - big, oz + gd, gw + 2.0 * big, big), Rect2(ox - big, oz, big, gd), Rect2(ox + gw, oz, big, gd)]:
		var outer := MeshInstance3D.new()
		var opm := PlaneMesh.new()
		opm.size = (rect as Rect2).size
		outer.mesh = opm
		outer.material_override = om
		outer.position = Vector3(rect.position.x + rect.size.x * 0.5, -0.0, rect.position.y + rect.size.y * 0.5)
		outer.name = "outer_ground"
		outer.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		root.add_child(outer)

	var fountain := Vector2(-100, -100)
	for ob in ((manifest.get("source", {}) as Dictionary).get("scenes", []) as Array):
		if str(ob.get("id", "")) == sid:
			for o in ob.get("obstacles", []):
				if str(o.get("id", "")) == "plaza.fountain":
					fountain = Vector2(float(o["x"]) + float(o["w"]) * 0.5, float(o["z"]) + float(o["d"]) * 0.5)
	var wm: float = cols * cell
	var hm: float = rows * cell
	# 地面花纹只画一次：把 ground.gdshader 画到 SubViewport 里（正交俯视），之后每帧只采样这张贴图
	var gm := ShaderMaterial.new()
	gm.shader = load("res://assets/shaders/ground.gdshader")
	gm.set_shader_parameter("types", ImageTexture.create_from_image(types))
	gm.set_shader_parameter("ao", ImageTexture.create_from_image(aoi))
	gm.set_shader_parameter("grid_size", Vector2(cols, rows))
	gm.set_shader_parameter("cell", cell)
	gm.set_shader_parameter("origin", Vector2(ox, oz))
	gm.set_shader_parameter("fountain", fountain)
	gm.set_shader_parameter("lamp_count", 0)
	gm.set_shader_parameter("bake", 1.0)
	var svp := SubViewport.new()
	svp.name = "ground_bake_" + sid
	svp.size = Vector2i(int(wm * BAKE_PPM), int(hm * BAKE_PPM))
	svp.own_world_3d = true
	svp.transparent_bg = false
	svp.render_target_update_mode = SubViewport.UPDATE_ONCE
	svp.msaa_3d = Viewport.MSAA_DISABLED
	add_child(svp)
	_bakes.append(svp)
	var bp := MeshInstance3D.new()
	var bpm := PlaneMesh.new()
	bpm.size = Vector2(wm, hm)
	bp.mesh = bpm
	bp.material_override = gm
	bp.position = Vector3(ox + wm * 0.5, 0.0, oz + hm * 0.5)
	svp.add_child(bp)
	var bc := Camera3D.new()
	bc.projection = Camera3D.PROJECTION_ORTHOGONAL
	bc.keep_aspect = Camera3D.KEEP_HEIGHT
	bc.size = hm
	bc.near = 1.0
	bc.far = 200.0
	svp.add_child(bc)
	bc.look_at_from_position(Vector3(ox + wm * 0.5, 50.0, oz + hm * 0.5), Vector3(ox + wm * 0.5, 0.0, oz + hm * 0.5), Vector3(0, 0, -1))
	bc.current = true

	var dm := ShaderMaterial.new()
	dm.shader = load("res://assets/shaders/ground_baked.gdshader")
	dm.set_shader_parameter("baked", svp.get_texture())
	dm.set_shader_parameter("size_m", Vector2(wm, hm))
	dm.set_shader_parameter("origin", Vector2(ox, oz))
	_cur["ground_mat"] = dm
	var ground := MeshInstance3D.new()
	ground.name = "ground"
	var pm := PlaneMesh.new()
	pm.size = Vector2(wm, hm)
	ground.mesh = pm
	ground.material_override = dm
	ground.position = Vector3(ox + wm * 0.5, 0.0, oz + hm * 0.5)
	ground.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	root.add_child(ground)


func _apply_lamps(sid: String) -> void:
	var gm: ShaderMaterial = _cur["ground_mat"]
	var arr: Array = _cur["lamps"]
	var packed := PackedVector4Array()
	for i in range(24):
		packed.append(arr[i] if i < arr.size() else Vector4())
	gm.set_shader_parameter("lamps", packed)
	gm.set_shader_parameter("lamp_count", mini(arr.size(), 24))
	_lamps[sid] = arr


func _build_obstacles(sc: Dictionary, sid: String) -> void:
	for ob in sc.get("obstacles", []):
		var oid: String = str(ob.get("id", ""))
		var x: float = float(ob["x"])
		var z: float = float(ob["z"])
		var w: float = float(ob.get("w", 1.0))
		var d: float = float(ob.get("d", 1.0))
		var cx: float = x + w * 0.5
		var cz: float = z + d * 0.5
		match oid:
			"plaza.fountain":
				_make_fountain(cx, cz, minf(w, d) * 0.5)
			"plaza.stall":
				put("stall.red", cx, cz, 0.0, 1.0, -1.0)
				put("crate", cx - 1.1, cz + 0.2, 20.0, 1.0, -1.0)
				put("barrel", cx + 1.1, cz + 0.3, 0.0, 1.0, -1.0)
				glow(Vector3(cx, 2.3, cz + 0.4), 2.4)
			"plaza.bench1", "plaza.bench2":
				put("bench", cx, cz + 0.05, 180.0, 1.0, -1.0, -1.0, {"len": w * 0.95})
			"tea_house.counter":
				put("prop.counter", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": w, "d": d, "h": 1.1, "style": "tea"})
				put("paper_lantern", cx - 1.2, cz, 0.0, 1.0, -1.0, -1.0, {}, 1.1)
				glow(Vector3(cx - 1.2, 1.55, cz), 1.4)
			"bookshop.counter":
				put("prop.counter", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": w, "d": d, "h": 1.1, "style": "book"})
				put("paper_lantern", cx + 1.2, cz, 0.0, 1.0, -1.0, -1.0, {}, 1.1)
				glow(Vector3(cx + 1.2, 1.55, cz), 1.4)
			"kitchen.pantry":
				put("prop.pantry", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": w, "d": d, "h": 1.8})
			"garden.shed":
				put("prop.shed", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": w, "d": d, "h": 2.1})
			"lamp.1", "lamp.2", "lamp.3", "lamp.4":
				put("lamp", cx, cz, 0.0, 1.0, -1.0)
				pool(cx, cz, 5.2, 1.0)
			_:
				pass


func _make_fountain(cx: float, cz: float, r: float) -> void:
	var b := TMB.new()
	# 石质水池：外墙、压顶、水面下的池底
	var R: float = r * 0.98
	b.cyl(Vector3.ZERO, 0.62, R, R - 0.05, TTownArt.STONE, 14)
	b.cyl(Vector3(0, 0.6, 0), 0.1, R + 0.1, R + 0.1, TTownArt.CREAM, 14, 0.0, false)
	b.cyl(Vector3(0, 0.6, 0), 0.0, R + 0.1, R - 0.28, _mul(TTownArt.CREAM, 0.96), 14, 0.0, true)
	b.cyl(Vector3.ZERO, 0.06, R - 0.2, R - 0.2, _mul(TTownArt.STONE, 0.8), 14)
	var mesh_parts := [{"mesh": b.to_mesh(), "xf": Transform3D.IDENTITY, "palette": true}]
	var key := "fountain_base"
	var mmk: Dictionary = _cur["mm"]
	mmk[key] = {"part": mesh_parts[0], "xfs": [Transform3D(Basis(), Vector3(cx, 0, cz))]}
	put("prop.fountain_top", cx, cz, 0.0, 1.2, -1.0, -1.0, {}, 0.0)
	# 水面
	var wm := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2((R - 0.28) * 2.0, (R - 0.28) * 2.0)
	wm.mesh = pm
	var m := ShaderMaterial.new()
	m.shader = load("res://assets/shaders/water.gdshader")
	wm.material_override = m
	wm.position = Vector3(cx, 0.5, cz)
	wm.name = "water"
	wm.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	(_cur["root"] as Node3D).add_child(wm)
	pool(cx, cz, 6.0, 0.55)
	glow(Vector3(cx, 2.1, cz), 1.8)


func _mul(c: Color, k: float) -> Color:
	return Color(c.r * k, c.g * k, c.b * k, c.a)


## 可互动物件画出来的高度（米）：书架按参数画，灶台以 town_art.gd 里烟囱的顶（2.6 + 0.45）为准，茶桌以茶壶嘴为准，花箱以花丛顶为准，游戏桌以桌面上的骰子为准。
const INTERACTABLE_MODEL_H := {"bookshelf": 2.5, "stove": 3.05, "tea_table": 1.0, "planter": 0.9, "game_table": 0.95}


func _build_interactables(sc: Dictionary, sid: String, root: Node3D) -> void:
	var objs: Array = []
	for it in sc.get("interactables", []):
		var fp: Dictionary = it.get("footprint", {})
		var fw: float = float(fp.get("w", 1.0))
		var fd: float = float(fp.get("d", 1.0))
		var cx: float = float(fp.get("x", float(it["x"]) - 0.5)) + fw * 0.5
		var cz: float = float(fp.get("z", float(it["z"]) - 0.5)) + fd * 0.5
		var kind: String = str(it.get("kind", ""))
		var oh: float = 1.8 if kind == "bookshelf" else (1.0 if kind == "stove" else 0.8)
		# 画出来的模型高度（点击盒至少要罩住它，否则点物件上部的射线会穿过去落到后面的地面）
		var mh: float = float(INTERACTABLE_MODEL_H.get(kind, 0.0))
		match kind:
			"tea_table":
				put("prop.table_round", cx, cz, 0.0, 1.0, -1.0)
				for ua in it.get("useAnchors", []):
					var ax: float = float(ua["x"])
					var az: float = float(ua["z"])
					put("stool", ax, az, 0.0, 1.0, -1.0)
				glow(Vector3(cx, 1.35, cz), 1.1)
			"bookshelf":
				put("prop.bookshelf", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": fw, "h": mh, "d": fd * 0.95})
			"stove":
				put("prop.stove", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": fw, "d": fd})
				glow(Vector3(cx, 0.55, cz + fd * 0.5 + 0.05), 1.2)
			"planter":
				put("prop.planter", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": fw * 0.92, "d": fd * 0.92})
			"game_table":
				# 地图 town-p1.0 起游戏桌是可交互物件（之前是 obstacles 里的 arcade.table1 / arcade.table2）
				put("prop.arcade_table", cx, cz, 0.0, 1.0, -1.0, -1.0, {"w": fw, "d": fd})
				put("stool", cx - 0.9, cz + 1.4, 0.0, 0.8, -1.0)
				put("stool", cx + 0.9, cz + 1.4, 0.0, 0.8, -1.0)
				glow(Vector3(cx, 1.4, cz), 1.6)
		var anchor_pts: Array = []
		for ua in it.get("useAnchors", []):
			anchor_pts.append(Vector2(float(ua["x"]), float(ua["z"])))
		objs.append(
			{
				"anchors": anchor_pts,
				"center": Vector2(cx, cz),
				"id": str(it["id"]),
				"name": str(it.get("name", it["id"])),
				"kind": kind,
				"pos": Vector3(cx, oh + 0.1, cz),
				"aabb": AABB(Vector3(cx - fw * 0.5 - 0.3, 0.0, cz - fd * 0.5 - 0.3), Vector3(fw + 0.6, maxf(oh + 0.3, mh), fd + 0.6)),
				"x": float(it["x"]),
				"z": float(it["z"]),
			}
		)
	objects[sid] = objs


func _build_labels(sc: Dictionary, sid: String) -> void:
	var labels: Array = []
	for z in sc.get("zones", []):
		var rects: Array = z.get("rects", [])
		if rects.is_empty():
			continue
		var r0: Dictionary = rects[0]
		labels.append({"name": str(z.get("name", "")), "pos": Vector3(float(r0["x"]) + float(r0["w"]) * 0.5, 0.2, float(r0["z"]) + float(r0["d"]) * 0.5)})
	zone_labels[sid] = labels


func _build_portals(sc: Dictionary, sid: String) -> void:
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
		pool(px, pz, 2.2, 0.9)
		glow(Vector3(px, 0.15, pz), 1.3)
		plist.append({"id": str(p["id"]), "name": pname, "pos": Vector3(px, 2.2, pz)})
	portals[sid] = plist


# ───────────────────────── 质量档 ─────────────────────────


## 高档：平行光开实时阴影（daynight.gd）；低档（手机默认）：不开，只有脚下的软圆影。世界这边没有要换的资源，
## 地面、光晕、水本来就不投影，其余几何体默认投影，光不开阴影时没有开销。
func set_quality(high: bool) -> void:
	quality_high = high
