extends SceneTree
## 资产套件的纯逻辑单测：节点名 -> 角色、给定状态哪些显示、状态名解析（kit_logic.gd）；服务端数据 -> 状态名的映射（prop_state.gd）；
## 调试开关 ?debug=1&props=sample 的判定与外观表叠加（debug_flags.gd）；外观表 scene 条目的解析（art.gd）。无头 Godot 直接跑。

const Flags := preload("res://scripts/debug_flags.gd")

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	t_classify()
	t_visibility()
	t_resolve()
	t_prop_state()
	t_flags()
	t_art_scene()
	print("kit_logic_test: %d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func t_classify() -> void:
	check(TKitLogic.classify("base")["role"] == "base", "base 是 base")
	check(TKitLogic.classify("base_top")["role"] == "base", "base_top 是 base")
	check(TKitLogic.classify("base2")["role"] == "base", "base2 是 base")
	check(TKitLogic.classify("baseball")["role"] == "", "baseball 不是 base")
	check(TKitLogic.classify("fade_roof")["role"] == "fade", "fade_roof 是 fade")
	check(TKitLogic.classify("faded")["role"] == "", "faded 不是 fade")
	var s: Dictionary = TKitLogic.classify("state_busy_flame_1")
	check(s["role"] == "state" and s["state"] == "busy", "state_busy_flame_1 是 busy 状态的部件：%s" % str(s))
	check(TKitLogic.classify("state_idle")["state"] == "idle", "state_idle 的状态是 idle")
	check(TKitLogic.classify("state_")["role"] == "", "state_ 没有状态名，不算")
	check(TKitLogic.classify("state_Busy")["role"] == "", "大写不算")
	var a: Dictionary = TKitLogic.classify("anchor_use_2")
	check(a["role"] == "anchor" and a["kind"] == "use", "anchor_use_2 是 use 锚点")
	check(TKitLogic.classify("anchor_fx_1")["kind"] == "fx" and TKitLogic.classify("anchor_put_10")["kind"] == "put", "fx 和 put")
	check(TKitLogic.classify("anchor_bad_1")["role"] == "", "不认识的锚点类别不算")
	check(TKitLogic.classify("anchor_use_x")["role"] == "", "锚点序号要是数字")
	check(TKitLogic.classify("Cube")["role"] == "", "普通名字没有角色")
	var names := ["base_a", "state_idle", "state_busy_x", "state_busy_y", "state_done", "anchor_use_1", "model"]
	check(TKitLogic.states_of(names) == ["idle", "busy", "done"], "状态按首次出现的顺序去重：%s" % str(TKitLogic.states_of(names)))


func t_visibility() -> void:
	var names := ["base_a", "fade_roof", "state_idle", "state_busy_x", "state_busy_y", "state_done", "anchor_use_1", "other"]
	var v: Dictionary = TKitLogic.visibility(names, "busy")
	check(v["base_a"] and v["fade_roof"], "base 和 fade 任何状态都显示")
	check(v["state_busy_x"] and v["state_busy_y"], "busy 的两个部件都显示")
	check(not v["state_idle"] and not v["state_done"], "别的状态隐藏")
	check(not v.has("anchor_use_1") and not v.has("other"), "锚点和无角色节点不归它管")
	var v2: Dictionary = TKitLogic.visibility(names, "idle")
	check(v2["state_idle"] and not v2["state_busy_x"], "idle：只有 idle 的部件")
	var v3: Dictionary = TKitLogic.visibility(names, "nonsense")
	check(not v3["state_idle"] and not v3["state_busy_x"] and v3["base_a"], "不认识的状态名这个纯函数不替它猜（解析在 resolve_state）")


func t_resolve() -> void:
	check(TKitLogic.resolve_state("busy", ["idle", "busy"]) == "busy", "认识的状态原样")
	check(TKitLogic.resolve_state("fault", ["idle", "busy"]) == "idle", "不认识的退回 idle")
	check(TKitLogic.resolve_state("", ["idle"]) == "idle", "空串退回 idle")
	check(TKitLogic.anim_state("state_busy") == "busy" and TKitLogic.anim_state("walk") == "", "动画名 -> 状态名")


func t_prop_state() -> void:
	check(TPropState.state_for_object({"id": "k", "active": null}) == "idle", "active 为 null：空闲")
	check(TPropState.state_for_object({"id": "k"}) == "idle", "没有 active 字段：空闲")
	check(TPropState.state_for_object({"id": "k", "active": {"status": "running"}}) == "busy", "有共同活动（running）：使用中")
	check(TPropState.state_for_object({"id": "k", "active": {"status": "open"}}) == "busy", "报名中（open）：服务端也不让别人开始，算使用中")
	check(TPropState.state_for_object(null) == "idle" and TPropState.state_for_object("x") == "idle", "不是字典：空闲")
	var objs: Array = [{"id": "kitchen:stove1", "active": {"status": "running"}}, {"id": "kitchen:stove2", "active": null}, "junk", {"nope": 1}]
	var m: Dictionary = TPropState.states_by_id(objs)
	check(m == {"kitchen:stove1": "busy", "kitchen:stove2": "idle"}, "整批映射：%s" % str(m))
	check(TPropState.state_of(objs, "kitchen:stove1") == "busy", "state_of 找得到")
	check(TPropState.state_of(objs, "kitchen:stove9") == "idle", "不在列表里的按 idle")
	check(TPropState.state_of(null, "x") == "idle" and TPropState.states_by_id(null).is_empty(), "objs 不是数组当空")


func t_flags() -> void:
	check(Flags.props_mode_of(true, "?debug=1&props=sample") == "sample", "debug 下认 props=sample")
	check(Flags.props_mode_of(true, "debug=1&hour=20&props=sample") == "sample", "不带问号、参数顺序不同")
	check(Flags.props_mode_of(false, "?debug=1&props=sample") == "", "没开 debug（debug_on 为假）一律无视")
	check(Flags.props_mode_of(false, "?props=sample") == "", "不带 debug=1 的地址栏无视")
	check(Flags.props_mode_of(true, "?debug=1") == "", "没有 props 参数是空串")
	check(Flags.props_mode_of(true, "?debug=1&props=") == "", "props 为空")
	var kinds: Dictionary = {"prop.stove": {"proc": "stove"}, "bush": {"proc": "bush"}}
	check(Flags.apply_props(kinds, "").is_empty() and kinds["prop.stove"].has("proc"), "空模式不改表")
	check(Flags.apply_props(kinds, "other").is_empty() and kinds["prop.stove"].has("proc"), "不认识的模式不改表")
	var changed: Array = Flags.apply_props(kinds, "sample")
	check(changed.has("prop.stove") and changed.has("building.kitchen"), "sample 模式覆盖 prop.stove 和 building.kitchen：%s" % str(changed))
	check(str(kinds["prop.stove"]["scene"]).ends_with("station_sample.tscn") and not kinds["prop.stove"].has("proc"), "prop.stove 整条换成 scene 条目")
	check(str(kinds["building.kitchen"]["scene"]).ends_with("building_sample.tscn"), "building.kitchen 指到占位建筑")
	check(kinds["bush"]["proc"] == "bush", "别的条目不动")
	# 叠加顺序：默认表 -> art_private -> 调试；调试最后，所以压得过 art_private 的同名条目
	var k2: Dictionary = {"prop.stove": {"scene": "res://art_private/x.tscn"}}
	Flags.apply_props(k2, "sample")
	check(str(k2["prop.stove"]["scene"]).contains("station_sample"), "调试开关压过 art_private 的同名条目（最后叠）")
	# 默认外观表里没有指到样件的条目（线上不出现灰盒样件）
	var f := FileAccess.open("res://assets/art_table.json", FileAccess.READ)
	var tbl: String = f.get_as_text()
	check(not tbl.contains("kits/") and not tbl.contains("\"scene\""), "默认外观表不指到任何包装场景")


func t_art_scene() -> void:
	var art := TArt.new()
	check(not art.has_scene("prop.stove") and art.scene_path("prop.stove") == "", "默认没有 scene 条目")
	check(art.proc_name("prop.stove") == "stove", "没有 scene：仍是程序配方 stove")
	art.kinds["prop.stove"] = {"scene": "res://assets/kits/sample/station_sample/station_sample.tscn", "proc": "stove"}
	check(art.has_scene("prop.stove"), "scene 条目解析出来")
	check(art.scene_path("prop.stove").ends_with("station_sample.tscn"), "路径原样")
	check(art.proc_name("prop.stove") == "", "有 scene：不再走程序配方")
	check(art.parts("prop.stove").is_empty(), "有 scene：不拍平网格")
	art.kinds["prop.pantry"] = {"scene": "res://assets/kits/sample/none/none.tscn", "proc": "pantry"}
	check(not art.has_scene("prop.pantry") and art.proc_name("prop.pantry") == "pantry", "scene 文件不存在：当作没有这个条目，回到程序配方")
	# 调试叠加经 TArt.apply_debug
	Flags.props_mode = "sample"
	var art2 := TArt.new()
	art2.apply_debug()
	check(art2.has_scene("prop.stove") and art2.has_scene("building.kitchen") and art2.overridden.has("prop.stove"), "apply_debug 把样件叠上去")
	Flags.props_mode = ""
	var art3 := TArt.new()
	art3.apply_debug()
	check(not art3.has_scene("prop.stove") and not art3.has_scene("building.kitchen"), "props_mode 为空：apply_debug 什么都不做")
