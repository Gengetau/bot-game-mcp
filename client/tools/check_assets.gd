extends SceneTree
## 资产套件的校验：扫 res://assets/kits/ 下每件资产，任何一条不过就非零退出，并说清是哪件资产的哪一条。
##   godot --headless --path client/town --script client/tools/check_assets.gd -- [<套件>/<资产编号> ...]
## 检查项：清单齐全且能解析；包装场景能加载、根挂着 stateful_prop.gd；清单里的状态、锚点、动画在场景里都找得到（反过来场景里多出来的也算不一致）；
## 至少有 base* 节点和 state_idle*；尺寸、占地、统计和清单一致；每个网格都有顶点色和色板纯白块的 UV（能走城镇着色器）；
## 导入后的节点名和 GLB 里写的一致（Godot 会按名字末尾的词改名）；包装场景和清单就是脚本生成的那份（没被手改）。

var _scan: GDScript
var _fails: int = 0
var _checks: int = 0
var _cur: String = ""


func _fail(what: String) -> void:
	_fails += 1
	print("FAIL  %s：%s" % [_cur, what])


func _ok(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fail(what)


func _init() -> void:
	_scan = load(get_script().resource_path.get_base_dir().path_join("kit_scan.gd"))
	var targets: Array = []
	for a in OS.get_cmdline_user_args():
		var p: PackedStringArray = str(a).split("/")
		if p.size() == 2:
			targets.append({"kit": p[0], "id": p[1]})
	if targets.is_empty():
		targets = _scan.list_assets()
	if targets.is_empty():
		print("FAIL  没有找到任何资产（assets/kits/ 下是空的）")
		quit(1)
		return
	for t in targets:
		_cur = "%s/%s" % [t["kit"], t["id"]]
		_check_one(str(t["kit"]), str(t["id"]))
	print("%d 件资产，%d 项检查，%d 项失败" % [targets.size(), _checks, _fails])
	quit(1 if _fails > 0 else 0)


func _read_text(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	return "" if f == null else f.get_as_text()


func _check_one(kit: String, id: String) -> void:
	var mp: String = _scan.manifest_path(kit, id)
	_ok(FileAccess.file_exists(mp), "缺 manifest.json")
	_ok(FileAccess.file_exists(_scan.glb_path(kit, id)), "缺 %s.glb" % id)
	_ok(FileAccess.file_exists(_scan.tscn_path(kit, id)), "缺 %s.tscn（包装场景）" % id)
	if not FileAccess.file_exists(mp) or not FileAccess.file_exists(_scan.tscn_path(kit, id)):
		return
	var mtext: String = _read_text(mp)
	var man = JSON.parse_string(mtext)
	if not (man is Dictionary):
		_fail("manifest.json 不是合法的 JSON 对象")
		return
	var d: Dictionary = man
	for key in ["id", "version", "kit", "source", "size", "footprint", "states", "anchors", "animations", "stats", "origin"]:
		_ok(d.has(key), "清单缺字段 %s" % key)
	_ok(str(d.get("id", "")) == id, "清单 id「%s」和目录名不一致" % d.get("id", ""))
	_ok(str(d.get("kit", "")) == kit, "清单 kit「%s」和目录名不一致" % d.get("kit", ""))
	# 包装场景
	var ps = load(_scan.tscn_path(kit, id))
	if not (ps is PackedScene):
		_fail("包装场景加载不了")
		return
	var inst: Node = (ps as PackedScene).instantiate()
	_ok(inst is TStatefulProp, "包装场景的根没有挂 stateful_prop.gd")
	_ok(_read_text(_scan.tscn_path(kit, id)) == _scan.render_tscn(kit, id), "包装场景和生成脚本的输出不一致（被手改过？重跑 npm run client:assets:build）")
	if not (inst is TStatefulProp):
		inst.free()
		return
	var prop: TStatefulProp = inst
	root.add_child(prop)
	var info: Dictionary = _scan.scan(prop)
	if not info["ok"]:
		_fail("；".join(PackedStringArray(info["problems"])))
		prop.queue_free()
		return
	var m: Dictionary = info["manifest"]
	for pr in info["problems"]:
		_fail(str(pr))
	_ok(info["has_base"], "没有 base* 节点（任何状态都显示的部分）")
	_ok("idle" in (m["states"] as Array) and _has_node(info["names"], "state_idle"), "没有 state_idle* 节点（空闲状态；没有几何就建一个空节点）")
	# 清单 -> 场景
	var scene_states: Array = prop.states()
	for s in (d.get("states", []) as Array):
		_ok(str(s) in scene_states, "清单里的状态「%s」在场景里找不到（没有 state_%s* 节点）" % [s, s])
	var scene_anchors: Array = prop.anchor_names()
	var man_anchor_names: Array = []
	for a in (d.get("anchors", []) as Array):
		var an: String = str(a.get("name", ""))
		man_anchor_names.append(an)
		_ok(an in scene_anchors, "清单里的锚点「%s」在场景里找不到" % an)
		if an in scene_anchors:
			var xf: Transform3D = prop.anchor(an)
			var p: Array = a.get("pos", [0, 0, 0])
			_ok(xf.origin.distance_to(Vector3(float(p[0]), float(p[1]), float(p[2]))) < 0.002, "锚点「%s」的位置和清单不一致：场景 %s，清单 %s" % [an, str(xf.origin), str(p)])
			_ok(str(a.get("kind", "")) in TKitLogic.ANCHOR_KINDS, "锚点「%s」的类别「%s」不是 use / put / fx" % [an, a.get("kind", "")])
	# 场景 -> 清单（反过来多出来的也算不一致）
	for an in scene_anchors:
		_ok(an in man_anchor_names, "场景里有锚点「%s」，清单里没有（清单过期了？）" % an)
	for s in scene_states:
		if s != "idle":
			_ok(s in (d.get("states", []) as Array), "场景里有状态「%s」，清单里没有（清单过期了？）" % s)
	# 动画：名字对得上某个状态
	for a in (d.get("animations", []) as Array):
		_ok(str(a.get("state", "")) in scene_states, "动画「%s」对应的状态「%s」在场景里找不到" % [a.get("name", ""), a.get("state", "")])
	# 数字一致
	_ok(_same_vec(d.get("size", []), m["size"], 0.002), "尺寸和清单不一致：场景 %s，清单 %s" % [str(m["size"]), str(d.get("size"))])
	_ok(_same_vec(d.get("footprint", []), m["footprint"], 0.002), "占地和清单不一致：场景 %s，清单 %s" % [str(m["footprint"]), str(d.get("footprint"))])
	var st: Dictionary = d.get("stats", {})
	for k in ["triangles", "material_slots", "meshes"]:
		_ok(int(st.get(k, -1)) == int(m["stats"][k]), "统计 %s 和清单不一致：场景 %d，清单 %s" % [k, int(m["stats"][k]), str(st.get(k))])
	_ok(str(st.get("textures", [])) == str(m["stats"]["textures"]), "贴图列表和清单不一致：场景 %s，清单 %s" % [str(m["stats"]["textures"]), str(st.get("textures"))])
	_ok(int(d.get("version", -1)) == int(m["version"]), "清单版本 %s 和 GLB 里写的 %s 不一致" % [str(d.get("version")), str(m["version"])])
	# 整份清单就是脚本生成的那份
	_ok(mtext == _scan.manifest_text(m), "清单和从 GLB 重新算出来的不一致（过期或被手改过；重跑 npm run client:assets:build）")
	# 导入后节点名没被 Godot 改
	var glb_names: Array = _scan.glb_node_names(_scan.glb_path(kit, id))
	for gn in glb_names:
		if str(gn) == id:
			continue
		_ok(_has_node(info["names"], str(gn), true), "GLB 里的节点名「%s」导入后不见了或被改名" % gn)
	prop.queue_free()


func _has_node(names: Array, prefix: String, exact: bool = false) -> bool:
	for n in names:
		if (exact and str(n) == prefix) or (not exact and str(n).begins_with(prefix)):
			return true
	return false


func _same_vec(a: Variant, b: Variant, tol: float) -> bool:
	if not (a is Array) or not (b is Array) or (a as Array).size() != (b as Array).size():
		return false
	for i in range((a as Array).size()):
		if absf(float(a[i]) - float(b[i])) > tol:
			return false
	return true
