extends SceneTree
## scene_logic.gd 的单测：遮挡淡出用的「头」只放居民（C6 评审：NPC 的头会让茶馆屋顶永远隐藏）。

const S := preload("res://scripts/scene_logic.gd")

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _actor(kind: String, pos: Vector2) -> TActor:
	var a := TActor.new()
	a.kind = kind
	a.disp = pos
	return a


func _init() -> void:
	var acts := {
		"r_me": _actor("human", Vector2(10, 5)),
		"r_bot": _actor("agent", Vector2(20, 6)),
		"npc:teahouse_keeper": _actor("npc", Vector2(16.25, 8.75)),  # 茶馆柜台后，在茶馆外框 (4,2,14,10) 里
		"npc:plaza_stroller": _actor("npc", Vector2(28.25, 3.75)),  # 书架旁，在书屋外框里
	}
	var heads: Array = S.occluder_heads(acts)
	check(heads.size() == 2, "只有两个居民的头：%d" % heads.size())
	var xs: Array = []
	for h in heads:
		xs.append((h as Vector3).x)
		check(is_equal_approx((h as Vector3).y, 1.6), "头高 1.6")
	check(xs.has(10.0) and xs.has(20.0), "两个居民的位置都在")
	check(not xs.has(16.25) and not xs.has(28.25), "NPC 的头不在里面（否则茶馆屋顶永远隐藏）")
	check(S.occluder_heads({}).is_empty(), "空角色表")
	print("scene_logic_test: ", _checks, " 项检查，", _fails, " 项失败")
	quit(1 if _fails > 0 else 0)
