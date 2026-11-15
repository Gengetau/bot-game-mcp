extends SceneTree
## 带状态的物件（stateful_prop.gd）和它在街景里的接入（world.gd）的单测：手搭的最小场景上切状态、取锚点；真实的两件占位样件；
## 一个最小的世界清单上建出带状态的灶台和替换的建筑，按服务端数据和调试钩子切外观。无头 Godot 直接跑（用的是 Dummy 渲染器）。

const STATION := "res://assets/kits/sample/station_sample/station_sample.tscn"
const BUILDING := "res://assets/kits/sample/building_sample/building_sample.tscn"

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	t_hand_built()
	t_samples()
	t_world()
	print("kit_feature_test: %d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func _mesh_node(nm: String, size: Vector3, at: Vector3) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.name = nm
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.position = at
	return mi


func _hand_built() -> TStatefulProp:
	var p := TStatefulProp.new()
	p.name = "hand"
	var base := Node3D.new()
	base.name = "base_body"
	base.add_child(_mesh_node("slab", Vector3(2, 1, 1), Vector3(0, 0.5, 0)))
	p.add_child(base)
	for st in ["idle", "busy", "done"]:
		var s := Node3D.new()
		s.name = "state_" + st
		s.add_child(_mesh_node("x", Vector3(0.2, 0.2, 0.2), Vector3(0, 1.1, 0)))
		p.add_child(s)
	var fade := Node3D.new()
	fade.name = "fade_roof"
	fade.add_child(_mesh_node("r", Vector3(3, 0.2, 2), Vector3(0, 3, 0)))
	p.add_child(fade)
	var a := Node3D.new()
	a.name = "anchor_use_1"
	a.position = Vector3(0.5, 0, 1.5)
	a.rotation.y = PI
	p.add_child(a)
	var f := Node3D.new()
	f.name = "anchor_fx_1"
	f.position = Vector3(0, 1.2, 0)
	p.add_child(f)
	var ap := AnimationPlayer.new()
	p.add_child(ap)
	var lib := AnimationLibrary.new()
	var an := Animation.new()
	an.length = 1.0
	lib.add_animation("state_busy", an)
	ap.add_animation_library("", lib)
	return p


func t_hand_built() -> void:
	var p: TStatefulProp = _hand_built()
	# 不进场景树也能用
	check(p.states() == ["idle", "busy", "done"], "状态列表：%s" % str(p.states()))
	p.set_state("busy")
	check(p.get_state() == "busy", "切到 busy")
	check((p.get_node("state_busy") as Node3D).visible and not (p.get_node("state_idle") as Node3D).visible and not (p.get_node("state_done") as Node3D).visible, "busy：只有 busy 的部件显示")
	check((p.get_node("base_body") as Node3D).visible and (p.get_node("fade_roof") as Node3D).visible, "base 和 fade 常显")
	p.set_state("done")
	check(not (p.get_node("state_busy") as Node3D).visible and (p.get_node("state_done") as Node3D).visible, "切到 done")
	p.set_state("fault")  # 这件资产没有 fault：退回 idle（并记一条警告）
	check(p.get_state() == "idle" and (p.get_node("state_idle") as Node3D).visible, "不认识的状态退回 idle")
	check(not (p.get_node("state_done") as Node3D).visible, "退回 idle 后别的状态隐藏")
	# 锚点（不在树里：沿父链算）
	var use: Array = p.anchors("use")
	check(use.size() == 1 and use[0]["name"] == "anchor_use_1", "use 锚点一个")
	check((use[0]["xf"] as Transform3D).origin.is_equal_approx(Vector3(0.5, 0, 1.5)), "锚点位置")
	check(p.anchors("put").is_empty() and p.anchors("fx").size() == 1, "put 没有，fx 一个")
	check(p.anchor_names() == ["anchor_fx_1", "anchor_use_1"], "锚点名按字典序：%s" % str(p.anchor_names()))
	var fwd: Vector3 = p.anchor("anchor_use_1").basis * Vector3(0, 0, 1)
	check(fwd.is_equal_approx(Vector3(0, 0, -1)), "yaw 180：朝 -z")
	check(p.anchor("nope") == Transform3D.IDENTITY, "不存在的锚点返回单位变换（并记警告）")
	# 包围盒：常显部分 = base + fade；全部 = 含状态部件
	var bb: AABB = p.local_bounds("base")
	check(is_equal_approx(bb.position.y, 0.0) and is_equal_approx(bb.end.y, 3.1), "常显部分的包围盒：%s" % str(bb))
	var ball: AABB = p.local_bounds("all")
	check(ball.end.y >= bb.end.y, "全部的包围盒不比常显的小")
	var fb: AABB = p.fade_bounds(p.fade_nodes()[0])
	check(is_equal_approx(fb.size.x, 3.0) and is_equal_approx(fb.position.y, 2.9), "fade 部分的包围盒：%s" % str(fb))
	# 动画：进入有同名动画的状态时播、离开时停
	var ap: AnimationPlayer = p.get_child(p.get_child_count() - 1)
	p.set_state("busy")
	check(ap.is_playing() and ap.current_animation == "state_busy", "进 busy 播 state_busy 动画")
	p.set_state("idle")
	check(not ap.is_playing(), "离开 busy 动画停")
	# 材质：fade 下面的网格用第二份
	var m1 := StandardMaterial3D.new()
	var m2 := StandardMaterial3D.new()
	p.apply_materials(m1, m2)
	check((p.get_node("fade_roof/r") as MeshInstance3D).material_override == m2 and (p.get_node("base_body/slab") as MeshInstance3D).material_override == m1, "fade 的网格用 fade 材质，其它用常规材质")
	# 进场景树后锚点取全局变换
	p.position = Vector3(10, 0, 20)
	root.add_child(p)
	check(p.anchor("anchor_use_1").origin.is_equal_approx(Vector3(10.5, 0, 21.5)), "进树后是全局位置")
	p.queue_free()


func t_samples() -> void:
	var ps = load(STATION)
	check(ps is PackedScene, "占位工位的包装场景能加载")
	if not (ps is PackedScene):
		return
	var p: TStatefulProp = (ps as PackedScene).instantiate()
	root.add_child(p)
	check(p.states().has("idle") and p.states().has("busy") and p.states().has("done") and p.states().has("fault"), "四个状态都有：%s" % str(p.states()))
	# 每个状态下：对应部件显示、别的状态的部件隐藏
	for st in ["idle", "busy", "done", "fault"]:
		p.set_state(st)
		var shown: Array = []
		var hidden_ok := true
		for n in _all_nodes(p):
			var cl: Dictionary = TKitLogic.classify(str(n.name))
			if cl["role"] == "state":
				if n.visible != (cl["state"] == st):
					hidden_ok = false
				if n.visible:
					shown.append(str(n.name))
		check(hidden_ok and not shown.is_empty(), "状态 %s 的部件显隐对（显示：%s）" % [st, str(shown)])
	p.set_state("busy")
	var ap: AnimationPlayer = null
	for n in _all_nodes(p):
		if n is AnimationPlayer:
			ap = n
	check(ap != null and ap.is_playing() and ap.current_animation == "state_busy", "busy 播循环动画")
	# 使用锚点和服务端地图 kitchen:stove1 对账：物件中心 (48, 2.75)，使用位 (47.75, 4.25)、(48.75, 4.25)
	var center := Vector2(48.0, 2.75)
	var map_use: Array = [Vector2(47.75, 4.25), Vector2(48.75, 4.25)]
	var use: Array = p.anchors("use")
	check(use.size() == 2, "两个 use 锚点")
	for i in range(use.size()):
		var o: Vector3 = (use[i]["xf"] as Transform3D).origin
		var want: Vector2 = map_use[i] - center
		check(Vector2(o.x, o.z).distance_to(want) < 0.001, "use 锚点 %d 和地图使用位对得上：资产 %s，地图 %s" % [i + 1, str(Vector2(o.x, o.z)), str(want)])
	var b: AABB = p.local_bounds("base")
	check(is_equal_approx(b.size.x, 2.0) and is_equal_approx(b.size.z, 1.5), "占地 2 x 1.5：%s" % str(b.size))
	p.queue_free()
	var bs = load(BUILDING)
	var bp: TStatefulProp = (bs as PackedScene).instantiate()
	root.add_child(bp)
	check(bp.fade_nodes().size() >= 2, "占位建筑有 fade 部分")
	bp.queue_free()


func _all_nodes(n: Node) -> Array:
	var out: Array = []
	for c in n.get_children():
		out.append(c)
		out.append_array(_all_nodes(c))
	return out


## 一个最小的世界清单：私宅场景 "home"（10 x 8 米），里面一个灶台，按 /map 的字段形状写。
func _manifest() -> Dictionary:
	var cols := 20
	var rows := 16
	var ascii: Array = []
	var zasc: Array = []
	for r in range(rows):
		var line := ""
		for c in range(cols):
			line += "." if (c >= 2 and c < 18 and r >= 2 and r < 14) else "#"
		ascii.append(line)
		zasc.append("0".repeat(cols))
	return {
		"source": {
			"scenes": [
				{
					"id": "home",
					"name": "家",
					"cell": 0.5,
					"bounds": {"x": 0, "z": 0, "w": 10, "d": 8},
					"zones": [],
					"obstacles": [],
					"anchors": [],
					"portals": [],
					"interactables": [
						{"id": "home:stove", "kind": "stove", "name": "灶台", "x": 5.0, "z": 3.0, "footprint": {"x": 4.0, "z": 2.0, "w": 2.0, "d": 1.5}, "useAnchors": [{"x": 4.75, "z": 4.25}, {"x": 5.75, "z": 4.25}]},
						{"id": "home:shelf", "kind": "bookshelf", "name": "书架", "x": 8.0, "z": 3.0, "footprint": {"x": 7.0, "z": 2.0, "w": 2.0, "d": 1.0}, "useAnchors": []},
					],
				}
			]
		},
		"grids": {"home": {"cols": cols, "rows": rows, "rows_ascii": ascii, "zones_ascii": zasc, "zones": [{"id": "home"}]}},
	}


func t_world() -> void:
	# 没有 scene 条目：灶台走原来的程序模型，没有带状态的物件
	var w0 := TWorld.new()
	root.add_child(w0)
	w0.build(_manifest())
	check((w0._props as Dictionary).is_empty(), "没有 scene 条目时没有带状态的物件")
	check(w0.props_info("home").is_empty(), "props_info 为空")
	w0.set_object_state("home", "home:stove", "busy")  # 安静地返回，不报错
	check(w0.object_state("home", "home:stove") == "" and w0.object_anchor("home", "home:stove", "anchor_use_1") == null, "找不到带状态的物件：空串 / null")
	var o0: Dictionary = w0.find_object("home", "home:stove")
	check(o0["aabb"].size.y > 3.04 and is_equal_approx(o0["pos"].y, 1.1), "没有 scene：点选盒和标牌高度还是写死表里的（灶台 3.05 / 1.0+0.1）：%s" % str(o0["aabb"]))
	w0.queue_free()
	# 有 scene 条目
	var w := TWorld.new()
	root.add_child(w)
	w.art.kinds["prop.stove"] = {"scene": STATION}
	w.art.kinds["building.home"] = {"scene": BUILDING}
	w.build(_manifest())
	var info: Array = w.props_info("home")
	check(info.size() == 1 and info[0]["id"] == "home:stove" and info[0]["state"] == "idle" and info[0]["states"].has("fault"), "灶台是带状态的物件，初始 idle：%s" % str(info))
	var o: Dictionary = w.find_object("home", "home:stove")
	check(o["aabb"].size.y >= 1.9 and o["aabb"].size.y < 3.0, "点选盒高度来自资产的包围盒（不是写死的 3.05）：%s" % str(o["aabb"]))
	var shelf: Dictionary = w.find_object("home", "home:shelf")
	check(shelf["aabb"].size.y >= 2.5, "没有 scene 的种类（书架）不受影响")
	# 按服务端数据切
	w.sync_object_states("home", [{"id": "home:stove", "active": {"status": "running"}}])
	check(w.object_state("home", "home:stove") == "busy", "服务端 active：busy")
	w.sync_object_states("home", [{"id": "home:stove", "active": null}])
	check(w.object_state("home", "home:stove") == "idle", "active 为 null：回到 idle")
	w.sync_object_states("home", [{"id": "home:stove", "active": {"status": "running"}}])
	w.sync_object_states("home", [])
	check(w.object_state("home", "home:stove") == "idle", "不在列表里按 idle")
	# 调试钩子：强行切，服务端刷新盖不回去，解除后回到服务端数据
	w.force_object_state("home:stove", "fault")
	check(w.object_state("home", "home:stove") == "fault", "强行切到 fault")
	w.sync_object_states("home", [{"id": "home:stove", "active": {"status": "running"}}])
	check(w.object_state("home", "home:stove") == "fault", "服务端数据刷新不把强行状态盖回去")
	check(w.props_info("home")[0]["forced"] == true, "props_info 标出被强行指定")
	w.force_object_state("home:stove", "")
	check(w.object_state("home", "home:stove") == "busy", "解除后回到服务端数据（最近一次是 busy）")
	w.set_object_state("home", "home:stove", "bogus")
	check(w.object_state("home", "home:stove") == "idle", "不认识的状态名退回 idle")
	# 锚点
	var xf = w.object_anchor("home", "home:stove", "anchor_use_1")
	check(xf is Transform3D and (xf as Transform3D).origin.is_equal_approx(Vector3(4.75, 0.0, 4.25)), "锚点的全局变换：%s" % str(xf))
	check(w.object_anchor("home", "home:stove", "anchor_use_9") == null, "没有的锚点返回 null")
	# 地图重建后强行状态仍在
	w.force_object_state("home:stove", "done")
	w.build(_manifest())
	check(w.object_state("home", "home:stove") == "done", "地图重建后强行状态还在")
	# 替换的建筑：包装场景挂在场景根下，fade 登记进淡出，行为和房子一致
	var items: Array = w._fade_items["home"]
	var bn := 0
	for it in items:
		if str((it["node"] as Node).name).begins_with("fade_"):
			bn += 1
			check((it["outer"] as Rect2).size.x > 0.0, "建筑的 fade 节点带「人在里面」的外框")
	check(bn >= 2, "建筑的 fade* 节点登记了淡出：%d" % bn)
	check((w.roots["home"] as Node).get_node_or_null("prop_building_home") != null, "替换的建筑挂在场景根下")
	# 人在屋里：整栋淡掉
	w.current = "home"
	w.update_view(Vector3(5, 20, 5), [Vector3(5, 1.6, 4)], 10.0)
	var gone := true
	for it in items:
		if str((it["node"] as Node).name).begins_with("fade_") and float(it["fade"]) > 0.02:
			gone = false
	check(gone, "人在外框里时屋顶和上半墙淡出")
	w.queue_free()
