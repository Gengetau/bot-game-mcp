extends SceneTree
## E 键「挑最近的」（pick_logic.gd，C6 的 D1）和调试开关判定（debug_flags.gd，D2）的单测：无头 Godot 直接跑。

const P := preload("res://scripts/pick_logic.gd")
const F := preload("res://scripts/debug_flags.gd")

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


## 书屋书架的真实坐标：中心 (28, 2.5)；使用站位 (26.25, 3.75)、(28.25, 3.75)、(30.25, 3.75)
func shelf(with_anchors: bool = true) -> Dictionary:
	var anchors: Array = [Vector2(26.25, 3.75), Vector2(28.25, 3.75), Vector2(30.25, 3.75)] if with_anchors else []
	return {"id": "bookshop:shelf", "center": Vector2(28.0, 2.5), "anchors": anchors}


func who(pos: Vector2) -> Array:
	return [{"id": "npc:plaza_stroller", "pos": pos}]


func pick_is(r: Dictionary, kind: String, id: String) -> bool:
	return str(r["kind"]) == kind and str(r["id"]) == id


func _init() -> void:
	var me := Vector2(30.25, 3.75)
	var stroller := Vector2(32.25, 3.75)  # 闲逛者读书的落脚点
	# 前提：到书架中心 2.57 米，到闲逛者 2 米；只按中心算时闲逛者更近
	check(absf(me.distance_to(Vector2(28.0, 2.5)) - 2.575) < 0.01, "前提：到书架中心约 2.57 米")
	check(absf(me.distance_to(stroller) - 2.0) < 0.001, "前提：到闲逛者 2 米")
	# 1. 站在书架最东边的站位、闲逛者在读书的落脚点：选书架
	check(pick_is(P.nearest(me, [shelf()], who(stroller), 8.0), "obj", "bookshop:shelf"), "站在书架站位上按 E 选书架（不是闲逛者）")
	# 2. 同样的位置但物件没有站位：只按中心算，选人
	check(pick_is(P.nearest(me, [shelf(false)], who(stroller), 8.0), "actor", "npc:plaza_stroller"), "没有站位的物件只按中心：选闲逛者（规则确实起作用）")
	# 3. 离 NPC 0.9 米、离最近的站位 1.1 米：选 NPC
	var me3 := Vector2(30.25, 4.85)
	check(absf(me3.distance_to(Vector2(30.25, 3.75)) - 1.1) < 0.001, "前提：离站位 1.1 米")
	check(pick_is(P.nearest(me3, [shelf()], who(Vector2(30.25, 5.75)), 8.0), "actor", "npc:plaza_stroller"), "离 NPC 0.9 米、离站位 1.1 米：选 NPC")
	# 4. 没有站位的物件按中心算
	check(pick_is(P.nearest(Vector2(28.0, 4.0), [shelf(false)], [], 8.0), "obj", "bookshop:shelf"), "没有站位的物件按中心算（1.5 米内）")
	check(pick_is(P.nearest(Vector2(28.0, 12.0), [shelf(false)], [], 8.0), "none", ""), "没有站位：中心 9.5 米，超出范围")
	# 5. 范围内什么都没有：none
	check(pick_is(P.nearest(Vector2(0, 0), [shelf()], who(stroller), 8.0), "none", ""), "范围内什么都没有")
	check(pick_is(P.nearest(me, [], [], 8.0), "none", ""), "什么都没有")
	# 6. 正好等于范围：none（严格小于）
	check(pick_is(P.nearest(Vector2(8.0, 0.0), [{"id": "o", "center": Vector2(0, 0), "anchors": []}], [], 8.0), "none", ""), "物件正好等于范围：不选")
	check(pick_is(P.nearest(Vector2(8.0, 0.0), [], [{"id": "a", "pos": Vector2(0, 0)}], 8.0), "none", ""), "人正好等于范围：不选")
	# 站位让物件在范围内：中心 8.5 米、站位 7.9 米
	check(pick_is(P.nearest(Vector2(0, 0), [{"id": "o", "center": Vector2(8.5, 0.0), "anchors": [Vector2(7.9, 0.0)]}], [], 8.0), "obj", "o"), "中心在范围外、站位在范围内：选得中")
	# 7. 物件和人等距：物件赢（先比物件后比人，严格小于才替换）
	check(pick_is(P.nearest(Vector2(0, 0), [{"id": "o", "center": Vector2(3, 0), "anchors": []}], [{"id": "a", "pos": Vector2(0, 3)}], 8.0), "obj", "o"), "物件和人等距：物件赢")
	# 8. 站位让物件更近不会让原来选得中的物件选不中：中心更近时仍按中心
	check(pick_is(P.nearest(Vector2(28.0, 3.0), [shelf()], who(Vector2(28.0, 4.2)), 8.0), "obj", "bookshop:shelf"), "站在中心旁：照样选书架")
	# 9. 多个物件：取最近的
	var near_ob := {"id": "near", "center": Vector2(5, 0), "anchors": []}
	var far_ob := {"id": "far", "center": Vector2(1, 6), "anchors": [Vector2(1, 5.5)]}
	check(pick_is(P.nearest(Vector2(0, 0), [far_ob, near_ob], [], 8.0), "obj", "near"), "多个物件取最近")
	# 10. object_distance
	check(absf(P.object_distance(me, Vector2(28.0, 2.5), shelf()["anchors"]) - 0.0) < 0.001, "object_distance：站在站位上是 0")
	check(absf(P.object_distance(me, Vector2(28.0, 2.5), []) - 2.575) < 0.01, "object_distance：无站位就是到中心")
	# 11. 调试开关：只在调试模式下认
	check(F.hide_npcs(true, true), "debug 开、全局量设了：隐藏")
	check(not F.hide_npcs(true, false), "debug 开、全局量没设：显示（默认）")
	check(not F.hide_npcs(false, true), "debug 关、全局量设了：无视，显示")
	check(not F.hide_npcs(false, false), "debug 关、全局量没设：显示")

	print("pick_logic_test: ", _checks, " 项检查，", _fails, " 项失败")
	quit(1 if _fails > 0 else 0)
