extends SceneTree
## people.gd 里纯逻辑的单测（不起浏览器、不连服务器）。
## 用法（仓库根目录）：/opt/godot/godot --headless --path client/town --script ../tools/test-people.gd
## 失败时退出码为 1。

var _fails: int = 0


func _check(ok: bool, msg: String) -> void:
	if not ok:
		_fails += 1
		printerr("FAIL: " + msg)


func _init() -> void:
	var P = load("res://scripts/features/people.gd")
	var R := 3.0
	var H := 0.6
	# 迟滞：当前对象 b 还在 reach + hyst 之内，c 略近一点，也不改选
	var cands := [{"id": "b", "d": 3.2}, {"id": "c", "d": 3.1 - 0.5}]
	_check(P.pick_meet(cands, "b", R, H) == "b", "当前对象 b 在 3.2 米（<= 3.6）、c 在 2.6 米：应保持 b，实际 " + P.pick_meet(cands, "b", R, H))
	# 两人相距几厘米，来回换位：每一轮都保持第一个选中的人
	var cur: String = P.pick_meet([{"id": "b", "d": 2.50}, {"id": "c", "d": 2.52}], "", R, H)
	_check(cur == "b", "起选应是最近的 b：" + cur)
	for i in range(8):
		var db: float = 2.55 if i % 2 == 0 else 2.45
		var dc: float = 2.50 if i % 2 == 0 else 2.52
		cur = P.pick_meet([{"id": "b", "d": db}, {"id": "c", "d": dc}], cur, R, H)
		_check(cur == "b", "第 %d 轮：b、c 距离只差几厘米，不该换成 %s" % [i, cur])
	# 当前对象失效（走远 / 不在候选里）才换最近者
	_check(P.pick_meet([{"id": "c", "d": 2.0}], "b", R, H) == "c", "b 不在候选里：应改选 c")
	_check(P.pick_meet([{"id": "b", "d": 3.7}, {"id": "c", "d": 2.9}], "b", R, H) == "c", "b 走到 3.7 米（> 3.6）：应改选 c")
	_check(P.pick_meet([{"id": "b", "d": 3.7}, {"id": "c", "d": 3.5}], "b", R, H) == "", "b 超出迟滞、c 也在 3 米外：都不选")
	# 没有当前对象时，进入门槛是 reach 本身
	_check(P.pick_meet([{"id": "b", "d": 3.2}], "", R, H) == "", "没有当前对象时 3.2 米还不到门槛")
	_check(P.pick_meet([{"id": "b", "d": 2.9}], "", R, H) == "b", "2.9 米进入")
	_check(P.pick_meet([], "b", R, H) == "", "没有候选：空")
	if _fails > 0:
		printerr("people 单测失败 %d 项" % _fails)
		quit(1)
	else:
		print("people 单测通过")
		quit(0)
