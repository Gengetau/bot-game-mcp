extends SceneTree
## 共同活动的纯逻辑（activity_logic.gd）的单测：走开拦截状态机、选座、文字、名单差异。无头 Godot 直接跑。

const L := preload("res://scripts/features/activity_logic.gd")
const TXT := "拦"

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	t_gate_two_tries()
	t_gate_double_click()
	t_gate_hold_key()
	t_gate_window_expiry()
	t_gate_clear()
	t_gate_confirmed_window()
	t_seat_pick()
	t_seat_seated()
	t_seat_all_taken()
	t_texts()
	t_diff()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func t_gate_two_tries() -> void:
	var st: Dictionary = L.new_gate()
	check(L.gate(st, 1000, TXT) == TXT, "拦截: 第一次被拦")
	check(int(st["warned"]) == 1, "拦截: 计一次提示")
	# 隔 400 毫秒的第二次：放行，并进入 6 秒的确认窗口
	check(L.gate(st, 1400, TXT) == "", "拦截: 隔开一个操作的第二次放行")
	check(int(st["passed"]) == 1, "拦截: 计一次放行")
	check(L.gate(st, 1500, TXT) == "", "拦截: 窗口里连续放行（走路途中的第二次问询）")
	check(L.gate(st, 7399, TXT) == "", "拦截: 窗口 6 秒内仍放行")
	check(L.gate(st, 7500, TXT) == TXT, "拦截: 窗口过期重新提示")
	check(int(st["warned"]) == 2, "拦截: 过期后重新计提示")


func t_gate_double_click() -> void:
	var st: Dictionary = L.new_gate()
	check(L.gate(st, 1000, TXT) == TXT, "双击: 第一下被拦")
	check(L.gate(st, 1150, TXT) == TXT, "双击: 150 毫秒后的第二下仍被拦（同一次手势）")
	check(L.gate(st, 1300, TXT) == TXT, "双击: 再隔 150 毫秒仍被拦（间隔按距上一次被问起算）")
	check(int(st["warned"]) == 1, "双击: 只算一次提示")
	check(L.gate(st, 1700, TXT) == "", "双击: 隔了 400 毫秒的下一次放行")


func t_gate_hold_key() -> void:
	var st: Dictionary = L.new_gate()
	var t: int = 1000
	for i in range(100):
		check(L.gate(st, t, TXT) == TXT, "按着: 每帧都在问也一直拦（第 %d 帧）" % i)
		t += 16
	# 松开：没有问询的空档；再按下
	t += 400
	check(L.gate(st, t, TXT) == "", "按着: 松开再按放行")
	check(int(st["warned"]) == 1, "按着: 按着不放只算一次提示")


func t_gate_window_expiry() -> void:
	var st: Dictionary = L.new_gate()
	check(L.gate(st, 1000, TXT) == TXT, "过期: 第一次")
	# 很久之后的误触不能直接放行
	check(L.gate(st, 20000, TXT) == TXT, "过期: 6 秒之后的下一次重新提示而不是放行")
	check(L.gate(st, 20400, TXT) == "", "过期: 重新提示之后隔开的下一次放行")


func t_gate_clear() -> void:
	var st: Dictionary = L.new_gate()
	L.gate(st, 1000, TXT)
	L.gate(st, 1400, TXT)
	L.gate_clear(st)
	check(int(st["confirmed_until"]) == 0 and int(st["warn_at"]) == 0, "清除: 状态回零")
	check(L.gate(st, 1500, TXT) == TXT, "清除: 清掉后又是第一次")
	check(int(st["warned"]) == 2 and int(st["passed"]) == 1, "清除: 计数不清")


func t_gate_confirmed_window() -> void:
	var st: Dictionary = L.new_gate()
	st["confirmed_until"] = 5000
	check(L.gate(st, 4999, TXT) == "", "窗口: 确认期内不动状态")
	check(int(st["warned"]) == 0, "窗口: 不计提示")


func t_seat_pick() -> void:
	var anchors: Array = [Vector2(7, 3.75), Vector2(7, 6.25), Vector2(8.25, 5), Vector2(5.75, 5)]
	# 我在门口（南边），别人坐在最近的 (7, 6.25)
	var me := Vector2(7, 10)
	var r: Dictionary = L.pick_seat(anchors, me, [Vector2(7.1, 6.2)])
	check(not bool(r["seated"]), "选座: 还没坐下")
	var pt: Vector2 = r["point"]
	check(pt.distance_to(Vector2(8.25, 5)) < 0.01 or pt.distance_to(Vector2(5.75, 5)) < 0.01, "选座: 绕开被占的最近座位（%s）" % str(pt))
	# 没人占：取最近的
	var r2: Dictionary = L.pick_seat(anchors, me, [])
	check((r2["point"] as Vector2).distance_to(Vector2(7, 6.25)) < 0.01, "选座: 没人占取最近")
	# 别人站得差一点（距离 0.7）不算占
	var r3: Dictionary = L.pick_seat(anchors, me, [Vector2(7, 6.25 + 0.7)])
	check((r3["point"] as Vector2).distance_to(Vector2(7, 6.25)) < 0.01, "选座: 0.7 米外不算占")


func t_seat_seated() -> void:
	var anchors: Array = [Vector2(7, 3.75), Vector2(7, 6.25)]
	var r: Dictionary = L.pick_seat(anchors, Vector2(7.2, 6.25), [])
	check(bool(r["seated"]), "已坐: 离座位 0.2 米算坐着")
	var r2: Dictionary = L.pick_seat(anchors, Vector2(7.6, 6.25), [])
	check(not bool(r2["seated"]), "已坐: 0.6 米不算")
	# 别人也站在我的座位旁不影响「我坐着」
	var r3: Dictionary = L.pick_seat(anchors, Vector2(7, 6.25), [Vector2(7, 6.3)])
	check(bool(r3["seated"]), "已坐: 先判自己")


func t_seat_all_taken() -> void:
	var anchors: Array = [Vector2(7, 3.75), Vector2(7, 6.25)]
	var r: Dictionary = L.pick_seat(anchors, Vector2(7, 10), [Vector2(7, 3.75), Vector2(7, 6.25)])
	check((r["point"] as Vector2).distance_to(Vector2(7, 6.25)) < 0.01, "全占: 取最近的")
	var r2: Dictionary = L.pick_seat([], Vector2(1, 1), [])
	check((r2["point"] as Vector2) == Vector2(1, 1) and not bool(r2["seated"]), "没有使用位: 原地")


func t_texts() -> void:
	check(L.tag_text("喝茶", "open", 1, 2, 4) == "喝茶 · 等人 1/2", "桌牌: 等人")
	check(L.tag_text("喝茶", "open", 2, 2, 4) == "喝茶 · 可开始 2/4", "桌牌: 可开始")
	check(L.tag_text("喝茶", "running", 2, 2, 4) == "喝茶 · 2 人", "桌牌: 进行中")
	check(L.dur_text(45000.0) == "45 秒", "时长: 秒（%s）" % L.dur_text(45000.0))
	check(L.dur_text(600000.0) == "10 分钟", "时长: 分钟（%s）" % L.dur_text(600000.0))
	check(L.dur_text(-5.0) == "1 秒", "时长: 负数不出错")
	check(L.warn_text("open", true, "喝茶").find("取消") >= 0, "提示: 发起人等人说取消")
	check(L.warn_text("open", false, "喝茶").find("让出位子") >= 0, "提示: 参与者等人说让位")
	check(L.warn_text("running", false, "喝茶").find("没有这次的收获") >= 0, "提示: 进行中说没有收获")
	check(L.warn_text("running", true, "喝茶").find("再试一次就走") >= 0, "提示: 都说下一步")


func t_diff() -> void:
	var prev: Dictionary = {"a": "甲", "b": "乙"}
	var cur: Array = [{"id": "a", "name": "甲"}, {"id": "c", "name": "丙"}]
	var d: Dictionary = L.diff_people(prev, cur, "a")
	check(d["joined"] == ["丙"], "名单: 新增的人（%s）" % str(d["joined"]))
	check(d["left"] == ["乙"], "名单: 少了的人（%s）" % str(d["left"]))
	# 我自己的变化不提示
	var d2: Dictionary = L.diff_people({"a": "甲", "b": "乙"}, [{"id": "b", "name": "乙"}], "a")
	check(d2["joined"].is_empty() and d2["left"].is_empty(), "名单: 我自己走开不提示")
	var d3: Dictionary = L.diff_people({}, [{"id": "a", "name": "甲"}, "坏数据", {"id": "b", "name": "乙"}], "a")
	check(d3["joined"] == ["乙"], "名单: 坏数据跳过")
