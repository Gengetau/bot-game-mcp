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
	t_gate_hold_key_gap()
	t_gate_click_gap()
	t_gate_window_expiry()
	t_gate_clear()
	t_gate_confirmed_window()
	t_seat_pick()
	t_seat_seated()
	t_seat_all_taken()
	t_texts()
	t_diff()
	t_revoke()
	t_cancel_text()
	t_ended()
	t_state_reached()
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


## 按住方向键：每帧问一次，同一次按下的编号（key_edge）不变。哪怕中间有一帧卡了 400 或 800 毫秒，也不是新的一次操作，不能放行；
## 松开再按（编号变了、隔了一会儿）才放行。第二次尝试由「新的一次按下」这个边沿认定，不靠时间间隔推断。
func t_gate_hold_key_gap() -> void:
	var st: Dictionary = L.new_gate()
	check(L.gate(st, 1000, TXT, 5) == TXT, "按住卡顿: 第一帧被拦")
	check(L.gate(st, 1016, TXT, 5) == TXT, "按住卡顿: 下一帧仍被拦")
	check(L.gate(st, 1416, TXT, 5) == TXT, "按住卡顿: 中间卡了 400 毫秒的一帧，同一次按下仍被拦")
	check(L.gate(st, 2216, TXT, 5) == TXT, "按住卡顿: 再卡 800 毫秒，同一次按下仍被拦")
	check(int(st["passed"]) == 0, "按住卡顿: 一次都没放行")
	check(int(st["warned"]) == 1, "按住卡顿: 按着不放只算一次提示")
	# 松开再按（新的按下编号，隔了 400 毫秒）：放行
	check(L.gate(st, 2616, TXT, 6) == "", "按住卡顿: 松开再按（新的一次按下）放行")
	check(int(st["passed"]) == 1, "按住卡顿: 计一次放行")
	# 松开后立刻连按两下（间隔小于 300 毫秒）：新的按下，但仍是同一次手势，不放行
	var st2: Dictionary = L.new_gate()
	check(L.gate(st2, 1000, TXT, 5) == TXT, "连按: 第一下被拦")
	check(L.gate(st2, 1150, TXT, 6) == TXT, "连按: 150 毫秒后的新按下仍被拦（同一次手势）")
	check(int(st2["passed"]) == 0, "连按: 没放行")


## 点击：每一下点击只问一次（被拦时），所以每次被问就是一次新的点击；两下间隔小于 300 毫秒算同一次手势，不放行。
func t_gate_click_gap() -> void:
	var st: Dictionary = L.new_gate()
	check(L.gate(st, 1000, TXT) == TXT, "点击: 第一下被拦")
	check(L.gate(st, 1250, TXT) == TXT, "点击: 250 毫秒后的第二下不放行")
	check(int(st["passed"]) == 0, "点击: 没放行")
	check(L.gate(st, 1600, TXT) == "", "点击: 间隔大于 300 毫秒的下一次放行")
	# 按住方向键被拦之后，隔一会儿用鼠标点地：是新的一次操作
	var st3: Dictionary = L.new_gate()
	check(L.gate(st3, 1000, TXT, 5) == TXT, "混用: 先按住方向键被拦")
	check(L.gate(st3, 1500, TXT) == "", "混用: 松开隔 500 毫秒后点击放行")


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


func t_revoke() -> void:
	var st: Dictionary = L.new_gate()
	L.gate(st, 1000, TXT)
	check(L.gate(st, 1400, TXT) == "", "撤销: 先放行")
	check(int(st["passed"]) == 1 and int(st["passed_at"]) == 1400, "撤销: 记下放行时刻")
	check(L.gate_revoke(st, 2000), "撤销: 放行之后不久可以撤销")
	check(int(st["passed"]) == 0 and int(st["confirmed_until"]) == 0, "撤销: 放行次数退回、窗口作废")
	check(L.gate(st, 2100, TXT) == TXT, "撤销: 撤销之后又是第一次提示")
	check(not L.gate_revoke(st, 2200), "撤销: 没有放行过就不撤销")
	# 过了 REVOKE_MS 的放行是玩家真的确认过要走，不撤销
	var st2: Dictionary = L.new_gate()
	L.gate(st2, 1000, TXT)
	L.gate(st2, 1400, TXT)
	check(not L.gate_revoke(st2, 1400 + L.REVOKE_MS + 1), "撤销: 太久以前的放行不撤销")
	check(int(st2["passed"]) == 1, "撤销: 不撤销时次数不动")
	L.gate_clear(st2)
	check(int(st2["passed_at"]) == 0, "撤销: gate_clear 一并清掉放行时刻")


func t_cancel_text() -> void:
	check(L.cancel_text(false, "发起人走开了") == "这一桌散了：发起人走开了", "取消: 别人造成的原样说")
	check(L.cancel_text(true, "发起人走开了") == "", "取消: 发起人自己走开不对自己说")
	check(L.cancel_text(true, "等了太久没凑齐人") == "这一桌散了：等了太久没凑齐人", "取消: 等太久对发起人也说")
	check(L.cancel_text(false, "大家都离开了") == "", "取消: 最后一个走开的非发起人不对自己说")
	check(L.cancel_text(false, "") == "这一桌散了。", "取消: 没有原因")
	check(L.cancel_text(true, "") == "", "取消: 发起人没有原因也不说")


func t_ended() -> void:
	var e: Array = []
	L.remember_ended(e, "")
	check(e.is_empty(), "已结束: 空编号不记")
	L.remember_ended(e, "a")
	L.remember_ended(e, "a")
	check(e == ["a"], "已结束: 不重复")
	for i in range(20):
		L.remember_ended(e, "x%d" % i)
	check(e.size() == L.ENDED_KEEP and e.has("x19") and not e.has("a"), "已结束: 只留最近几个（%d）" % e.size())


func t_state_reached() -> void:
	check(not L.state_reached("invite", "") and L.state_reached("invite", "open"), "追上: 约人之后要有活动")
	check(not L.state_reached("join", "") and L.state_reached("join", "running"), "追上: 加入之后要有活动")
	check(not L.state_reached("begin", "open") and L.state_reached("begin", "running"), "追上: 开始之后要是进行中")
