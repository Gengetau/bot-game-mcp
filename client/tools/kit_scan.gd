extends RefCounted
## 资产套件的共用扫描（kit_wrap.gd 生成清单、check_assets.gd 校验都用它，保证「写出去的」和「查出来的」是同一套算法）。
## 只在无头 Godot 里当工具用，不进游戏。约定见 client/docs/T02a.md。

const KITS_DIR := "res://assets/kits"
const WRAPPER_SCRIPT := "res://scripts/stateful_prop.gd"
const WHITE_UV := Vector2(0.015, 0.015)
const SNAP := 0.0001


static func kit_dir(kit: String, id: String) -> String:
	return "%s/%s/%s" % [KITS_DIR, kit, id]


static func glb_path(kit: String, id: String) -> String:
	return "%s/%s.glb" % [kit_dir(kit, id), id]


static func tscn_path(kit: String, id: String) -> String:
	return "%s/%s.tscn" % [kit_dir(kit, id), id]


static func manifest_path(kit: String, id: String) -> String:
	return "%s/manifest.json" % kit_dir(kit, id)


## 所有资产：[{kit, id}]，按套件、编号排序。有 manifest.json 或有 .glb 的目录都算。
static func list_assets() -> Array:
	var out: Array = []
	var kits: PackedStringArray = DirAccess.get_directories_at(KITS_DIR)
	kits.sort()
	for k in kits:
		var ids: PackedStringArray = DirAccess.get_directories_at(KITS_DIR + "/" + k)
		ids.sort()
		for i in ids:
			out.append({"kit": k, "id": i})
	return out


## 包装场景的文本。由脚本生成，不手改；路径不带 uid，所以 GLB 重新导入（换 uid）也不会让它变。
static func render_tscn(kit: String, id: String) -> String:
	var s := "[gd_scene load_steps=3 format=3]\n\n"
	s += "[ext_resource type=\"Script\" path=\"%s\" id=\"1_prop\"]\n" % WRAPPER_SCRIPT
	s += "[ext_resource type=\"PackedScene\" path=\"%s\" id=\"2_model\"]\n\n" % glb_path(kit, id)
	s += "[node name=\"%s\" type=\"Node3D\"]\n" % id
	s += "script = ExtResource(\"1_prop\")\n\n"
	s += "[node name=\"model\" parent=\".\" instance=ExtResource(\"2_model\")]\n"
	return s


static func _snap(v: float) -> float:
	return snappedf(v, SNAP)


static func _v3(v: Vector3) -> Array:
	return [_snap(v.x), _snap(v.y), _snap(v.z)]


## 资产根节点：GLB 里带 extras（layout_version）的那个节点；找不到返回 null。
static func find_asset_root(n: Node) -> Node3D:
	if n is Node3D and n.has_meta("extras"):
		var ex = n.get_meta("extras")
		if ex is Dictionary and (ex as Dictionary).has("layout_version"):
			return n
	for c in n.get_children():
		var r: Node3D = find_asset_root(c)
		if r != null:
			return r
	return null


static func _rel(n: Node3D, root: Node3D) -> Transform3D:
	var xf := Transform3D.IDENTITY
	var cur: Node = n
	while cur != null and cur != root:
		if cur is Node3D:
			xf = (cur as Node3D).transform * xf
		cur = cur.get_parent()
	return xf


static func _walk(n: Node, out: Array) -> void:
	for c in n.get_children():
		out.append(c)
		_walk(c, out)


## 从实例化的场景（GLB 或包装场景）读出能算出来的全部信息。问题（不合约定但还读得出来的）放进 problems。
static func scan(inst: Node) -> Dictionary:
	var problems: Array = []
	var root: Node3D = find_asset_root(inst)
	if root == null:
		return {"ok": false, "problems": ["找不到资产根节点（GLB 里根空节点要带 extras.layout_version）"]}
	var ex: Dictionary = root.get_meta("extras")
	var all: Array = []
	_walk(root, all)
	var names: Array = []
	for n in all:
		names.append(str(n.name))
	# 状态
	var state_names: Array = TKitLogic.states_of(names)
	var has_base: bool = false
	for nm in names:
		if TKitLogic.classify(str(nm))["role"] == TKitLogic.ROLE_BASE:
			has_base = true
	# 锚点
	var anchors: Array = []
	for n in all:
		var cl: Dictionary = TKitLogic.classify(str(n.name))
		if cl["role"] == TKitLogic.ROLE_ANCHOR and n is Node3D:
			var xf: Transform3D = _rel(n, root)
			var fwd: Vector3 = xf.basis * Vector3(0, 0, 1)
			var yaw: float = rad_to_deg(atan2(fwd.x, fwd.z))
			yaw = _snap(yaw)
			if yaw <= -180.0 + SNAP:
				yaw = 180.0  # 范围 (-180, 180]，免得 ±180 来回跳
			anchors.append({"name": str(n.name), "kind": cl["kind"], "pos": _v3(xf.origin), "yaw": yaw})
	anchors.sort_custom(func(a, b): return str(a["name"]) < str(b["name"]))
	# 网格：包围盒、三角形、材质槽、顶点色和 UV
	var box := AABB()
	var bfirst := true
	var base_box := AABB()
	var base_first := true
	var tris: int = 0
	var slots: int = 0
	var textures: Array = []
	var meshes: int = 0
	for n in all:
		if not (n is MeshInstance3D) or (n as MeshInstance3D).mesh == null:
			continue
		var mi: MeshInstance3D = n
		meshes += 1
		var bb: AABB = _rel(mi, root) * mi.mesh.get_aabb()
		box = bb if bfirst else box.merge(bb)
		bfirst = false
		if _always_on(mi, root):
			base_box = bb if base_first else base_box.merge(bb)
			base_first = false
		slots += mi.mesh.get_surface_count()
		if not _has_role_ancestor(mi, root):
			problems.append("网格「%s」没有归属（它自己或祖先要叫 base* / state_<状态>* / fade*）" % mi.name)
		for si in range(mi.mesh.get_surface_count()):
			var arr: Array = mi.mesh.surface_get_arrays(si)
			var idx = arr[Mesh.ARRAY_INDEX]
			var verts: PackedVector3Array = arr[Mesh.ARRAY_VERTEX]
			tris += (idx as PackedInt32Array).size() / 3 if idx != null else verts.size() / 3
			if arr[Mesh.ARRAY_COLOR] == null:
				problems.append("网格「%s」没有顶点色" % mi.name)
			var uvs = arr[Mesh.ARRAY_TEX_UV]
			if uvs == null:
				problems.append("网格「%s」没有 UV（要指向色板纯白块）" % mi.name)
			else:
				for uv in (uvs as PackedVector2Array):
					if absf(uv.x - WHITE_UV.x) > 0.02 or absf(uv.y - WHITE_UV.y) > 0.02:
						problems.append("网格「%s」的 UV 不在色板纯白块里：%s" % [mi.name, str(uv)])
						break
			var mat: Material = mi.mesh.surface_get_material(si)
			if mat is BaseMaterial3D and (mat as BaseMaterial3D).albedo_texture != null:
				var tp: String = (mat as BaseMaterial3D).albedo_texture.resource_path
				if not (tp in textures):
					textures.append(tp)
	textures.sort()
	# 动画
	var anims: Array = []
	var everything: Array = []
	_walk(inst, everything)  # AnimationPlayer 是资产根的兄弟（挂在 GLB 场景根上）
	for n in everything:
		if n is AnimationPlayer:
			var ap: AnimationPlayer = n
			var an: PackedStringArray = ap.get_animation_list()
			for a in an:
				var anim: Animation = ap.get_animation(a)
				anims.append({"name": str(a), "state": TKitLogic.anim_state(str(a)), "loop": anim.loop_mode != Animation.LOOP_NONE})
	anims.sort_custom(func(a, b): return str(a["name"]) < str(b["name"]))
	var size: Vector3 = box.size if not bfirst else Vector3.ZERO
	var foot: Vector3 = base_box.size if not base_first else Vector3.ZERO
	var m: Dictionary = {
		"id": str(ex.get("id", root.name)),
		"version": int(ex.get("version", 0)),
		"kit": str(ex.get("kit", "")),
		"source": {"script": str(ex.get("script", "")), "blender": str(ex.get("blender", ""))},
		"size": _v3(size),
		"bounds": {"min": _v3(box.position), "max": _v3(box.end)},
		"footprint": [_snap(foot.x), _snap(foot.z)],
		"states": state_names,
		"anchors": anchors,
		"animations": anims,
		"stats": {"triangles": tris, "material_slots": slots, "meshes": meshes, "textures": textures},
		"origin": str(ex.get("origin", "")),
	}
	return {"ok": true, "manifest": m, "names": names, "has_base": has_base, "problems": problems, "root_name": str(root.name)}


static func _always_on(n: Node, root: Node) -> bool:
	var cur: Node = n
	while cur != null and cur != root:
		var r: String = TKitLogic.classify(str(cur.name))["role"]
		if r == TKitLogic.ROLE_STATE:
			return false
		if r == TKitLogic.ROLE_BASE:
			return true
		cur = cur.get_parent()
	return false


static func _has_role_ancestor(n: Node, root: Node) -> bool:
	var cur: Node = n
	while cur != null and cur != root:
		if TKitLogic.classify(str(cur.name))["role"] != TKitLogic.ROLE_NONE:
			return true
		cur = cur.get_parent()
	return false


## 清单的文本：键排序、两空格缩进、末尾一个换行（同样的输入逐字节相同）。
static func manifest_text(m: Dictionary) -> String:
	return JSON.stringify(m, "  ", true) + "\n"


## GLB 文件里 JSON 块的节点名（导入后的场景里名字必须一样：Godot 对名字末尾的某些词有特殊处理）。
static func glb_node_names(path: String) -> Array:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return []
	f.get_32()
	f.get_32()
	f.get_32()
	var clen: int = f.get_32()
	f.get_32()
	var txt: String = f.get_buffer(clen).get_string_from_utf8()
	var j = JSON.parse_string(txt)
	var out: Array = []
	if j is Dictionary:
		for n in (j as Dictionary).get("nodes", []):
			out.append(str(n.get("name", "")))
	return out
