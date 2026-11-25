extends SceneTree
## nav_route.gd 的单测：一次 you_arrived 是不是「现在这一趟出发之前的路」。无头 Godot 直接跑。
## 场景都来自端到端 83.1 的间歇失败：上一趟路的到达被服务器晚一拍才结算，落在新的 navigate 之后。
## 用法：npm run client:unit

const R := preload("res://scripts/nav_route.gd")

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	t_static()
	t_stale_after_response()
	t_stale_before_response()
	t_legit_before_response()
	t_no_accept()
	t_overlap()
	t_reset()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func t_static() -> void:
	# 被接受的是第 3 次导航意图，第一段 5000 到
	check(R.prior(3, 5000.0, 3, 4200.0), "到达时刻早于这一趟的 arriveAt：之前的路")
	check(not R.prior(3, 5000.0, 3, 5000.0), "到达时刻等于 arriveAt：就是这一趟（单段路线）")
	check(not R.prior(3, 5000.0, 3, 7300.0), "到达时刻晚于 arriveAt：这一趟（穿过门口的多段路线）或之后的路")
	check(not R.prior(3, 5000.0, 4, 4200.0), "之后又有新的导航意图（停下、方向键、还没被接受的 navigate）：没法比，不算")
	check(not R.prior(-1, 0.0, 0, 4200.0), "从来没有被接受过的 navigate：不算")
	check(not R.prior(3, 5000.0, 3, 0.0), "事件没有 at：不算")
	check(not R.prior(3, 0.0, 3, 4200.0), "回答里没有 arriveAt：不算")


## 83.1 的原样：上一趟路 4200 就该到了；4300 点了远处的 NPC，navigate 的回答先回来（arriveAt 7000），随后上一趟路的 you_arrived(at 4200) 才到
func t_stale_after_response() -> void:
	var r := R.new()
	r.accepted(1, 7000.0)
	check(r.is_prior(1, 4200.0), "回答先到、旧到达后到：之前的路")
	check(not r.is_prior(1, 7000.0), "这一趟自己的到达：不是之前的路")


## 同一件事的另一种先后：旧到达先到、navigate 的回答后到（服务器在处理 navigate 的那次提交里才把旧路线结清，事件和回答各走各的连接）
func t_stale_before_response() -> void:
	var r := R.new()
	var old := {"type": "you_arrived", "at": 4200.0, "data": {"target": {"kind": "point"}}}
	r.hold(old)  # main：navigate 在路上，先扣着
	check(r.held_count() == 1, "扣着一条")
	r.accepted(1, 7000.0)
	var out: Array = r.take_held()
	check(out.size() == 1 and out[0] == old and r.held_count() == 0, "回答到了：原样放出来，不留")
	check(r.is_prior(1, float(out[0]["at"])), "放出来再判：之前的路")


## 回答比整段路还慢（网络很差）：这一趟自己的到达先到，扣着，回答到了判成「不是之前的路」，菜单照开
func t_legit_before_response() -> void:
	var r := R.new()
	r.hold({"type": "you_arrived", "at": 7000.0})
	r.accepted(1, 7000.0)
	var out: Array = r.take_held()
	check(out.size() == 1 and not r.is_prior(1, float(out[0]["at"])), "这一趟自己的到达：不是之前的路")


## 这次 navigate 被拒 / 已经在旁边（没有 navigation）：没有可比的时刻，旧行为
func t_no_accept() -> void:
	var r := R.new()
	r.accepted(1, 7000.0)  # 更早那一次被接受过
	check(not r.is_prior(2, 4200.0), "现在这一次（第 2 次意图）没被接受：不拿第 1 次的时刻去比")


## 连点两下：两条 navigate 都在路上，各自的回答先后回来；只认最近一次意图
func t_overlap() -> void:
	var r := R.new()
	r.accepted(2, 9000.0)  # 后发的先回来
	r.accepted(1, 7000.0)  # 先发的后回来：不能把记录退回去
	check(r.is_prior(2, 8000.0), "回答乱序：仍按第 2 次的 arriveAt 比")
	check(not r.is_prior(2, 9000.0), "第 2 次自己的到达")


func t_reset() -> void:
	var r := R.new()
	r.accepted(1, 7000.0)
	r.hold({"type": "you_arrived", "at": 1.0})
	r.reset()
	check(r.held_count() == 0 and not r.is_prior(1, 4200.0), "换会话：扣着的和记下的都清掉")
