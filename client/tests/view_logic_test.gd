extends SceneTree
## 镜头给面板让位（view_logic.gd、rig.gd）的单测：无头 Godot 直接跑。
## 「目标屏幕点 -> 注视点偏移」的换算用真的 Camera3D 对一遍：把角色放在原点、按偏移摆镜头，投影回屏幕应当正好是目标点。

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func near(a: float, b: float, eps: float = 0.002) -> bool:
	return absf(a - b) <= eps


func rect(l: float, t: float, r: float, b: float, w: float, h: float) -> Dictionary:
	return {"l": l, "t": t, "r": r, "b": b, "w": w, "h": h}


var _ran: bool = false


## 场景树第一帧才跑：_init / _initialize 里根窗口还没进树，相机的投影用不了
func _process(_dt: float) -> bool:
	if _ran:
		return true
	_ran = true
	t_target()
	t_target_edges()
	t_ease()
	t_offset_center()
	t_offset_vs_camera()
	t_rig()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)
	return true


func t_target() -> void:
	# 整个视口都没被盖：正中偏下（高度 55%）
	var t: Vector2 = ViewLogic.target(rect(0.0, 0.0, 1.0, 1.0, 1440.0, 900.0), Vector2(0.5, 0.5))
	check(near(t.x, 0.5) and near(t.y, 0.55), "全视口：目标点 (0.5, 0.55)，得到 %s" % str(t))
	# 手机抽屉开着：可见区矮（390x844 下 y 从 0.07 到 0.53，约 390 像素高）仍按 55%
	t = ViewLogic.target(rect(0.0, 0.07, 1.0, 0.53, 390.0, 844.0), Vector2(0.5, 0.5))
	check(near(t.x, 0.5) and near(t.y, 0.07 + 0.46 * 0.55), "手机抽屉（高 388 像素）：55%% 处，得到 %s" % str(t))
	# 可见区高度不到 300 像素：取正中
	t = ViewLogic.target(rect(0.0, 0.07, 1.0, 0.37, 390.0, 844.0), Vector2(0.5, 0.5))
	check(near(t.y, 0.22), "可见区高 253 像素：取正中，得到 %s" % str(t))
	# 桌面侧栏：右边被盖掉 340 像素，目标点的横向落在剩下那块的中间
	t = ViewLogic.target(rect(0.0, 0.06, 1.0 - 340.0 / 1440.0, 0.9, 1440.0, 900.0), Vector2(0.5, 0.5))
	check(near(t.x, (1.0 - 340.0 / 1440.0) * 0.5), "桌面侧栏：横向在可见区正中，得到 %s" % str(t))
	# 太小不追：高不到 120、宽不到 160，都保持上一次的目标点
	var prev := Vector2(0.3, 0.4)
	check(ViewLogic.target(rect(0.0, 0.0, 1.0, 119.0 / 400.0, 800.0, 400.0), prev) == prev, "高 119 像素：保持原来的目标点")
	check(ViewLogic.target(rect(0.0, 0.0, 159.0 / 800.0, 1.0, 800.0, 400.0), prev) == prev, "宽 159 像素：保持原来的目标点")
	check(ViewLogic.target(rect(0.0, 0.0, 160.0 / 800.0, 120.0 / 400.0, 800.0, 400.0), prev) != prev, "恰好 160x120：追")
	# 残缺的消息不动
	check(ViewLogic.target({"l": 0.0}, prev) == prev, "残缺的消息：保持原来的目标点")
	check(ViewLogic.target(rect(0.0, 0.0, 1.0, 1.0, 0.0, 0.0), prev) == prev, "视口尺寸为 0：保持原来的目标点")


func t_target_edges() -> void:
	# 可见区贴着视口的角：目标点在 0..1 之内
	var t: Vector2 = ViewLogic.target(rect(0.0, 0.0, 0.2, 0.2, 1000.0, 1000.0), Vector2(0.5, 0.5))
	check(t.x >= 0.0 and t.x <= 1.0 and t.y >= 0.0 and t.y <= 1.0, "左上角的可见区：目标点在 0..1 内，得到 %s" % str(t))
	check(near(t.x, 0.1) and near(t.y, 0.1), "左上角的可见区（200x200 像素，不到 300 高）：正中 (0.1, 0.1)，得到 %s" % str(t))
	t = ViewLogic.target(rect(0.8, 0.8, 1.0, 1.0, 1000.0, 1000.0), Vector2(0.5, 0.5))
	check(near(t.x, 0.9) and near(t.y, 0.9), "右下角的可见区：(0.9, 0.9)，得到 %s" % str(t))


func t_ease() -> void:
	var a := Vector2(0.5, 0.5)
	var b := Vector2(0.5, 0.2)
	check(ViewLogic.eased(a, b, 0.0) == a, "缓动：起点")
	check(ViewLogic.eased(a, b, ViewLogic.DUR).is_equal_approx(b), "缓动：整 0.3 秒到位")
	check(ViewLogic.eased(a, b, 10.0).is_equal_approx(b), "缓动：超时也停在终点")
	var prev: float = 0.5
	var mono: bool = true
	for i in range(1, 11):
		var y: float = ViewLogic.eased(a, b, ViewLogic.DUR * i / 10.0).y
		if y > prev + 0.000001:
			mono = false
		prev = y
	check(mono, "缓动：单调、不回头、不越过终点")
	var half: Vector2 = ViewLogic.eased(a, b, ViewLogic.DUR * 0.5)
	check(half.y < 0.35, "缓动：先快后慢，走到一半时间时已经过了一大半，得到 %f" % half.y)
	check(ViewLogic.DUR >= 0.25 and ViewLogic.DUR <= 0.35, "缓动时长在 0.25 到 0.35 秒之间")


func t_offset_center() -> void:
	for asp in [0.46, 1.0, 1.6, 2.4]:
		var o: Vector2 = ViewLogic.ground_offset(40.0, 17.0, 40.0, asp < 1.0, asp, Vector2(0.5, 0.5))
		check(o.length() < 0.0001, "正中的偏移为零（宽高比 %.2f）：%s" % [asp, str(o)])
	# 目标点在中线之下：落点比中心更靠近镜头（z 更大）；左右对称
	var o2: Vector2 = ViewLogic.ground_offset(40.0, 17.0, 40.0, false, 1.6, Vector2(0.5, 0.55))
	check(o2.y > 0.0 and absf(o2.x) < 0.0001, "目标点在中线之下：落点往镜头这边偏，得到 %s" % str(o2))
	var ol: Vector2 = ViewLogic.ground_offset(40.0, 17.0, 40.0, false, 1.6, Vector2(0.3, 0.5))
	var orr: Vector2 = ViewLogic.ground_offset(40.0, 17.0, 40.0, false, 1.6, Vector2(0.7, 0.5))
	check(near(ol.x, -orr.x, 0.0001) and ol.x < 0.0, "左右对称：%s %s" % [str(ol), str(orr)])
	# 距离翻倍，偏移翻倍
	var d1: Vector2 = ViewLogic.ground_offset(40.0, 10.0, 40.0, false, 1.6, Vector2(0.4, 0.6))
	var d2: Vector2 = ViewLogic.ground_offset(40.0, 20.0, 40.0, false, 1.6, Vector2(0.4, 0.6))
	check(near(d2.x, d1.x * 2.0, 0.0001) and near(d2.y, d1.y * 2.0, 0.0001), "距离翻倍偏移翻倍：%s %s" % [str(d1), str(d2)])
	# 目标点在地平线以上：偏移有限（不飞到无穷远）
	var sky: Vector2 = ViewLogic.ground_offset(20.0, 17.0, 40.0, false, 2.4, Vector2(0.5, 0.0))
	check(is_finite(sky.x) and is_finite(sky.y) and sky.length() < 2000.0, "朝天的点：偏移有限，得到 %s" % str(sky))


## 用真的相机对：角色放在原点，镜头看向 -偏移，把原点投影回屏幕，应该正好是目标点。覆盖横屏、竖屏、几个目标点（含角上）和极端宽高比。
func t_offset_vs_camera() -> void:
	var cases := [
		[40.0, 17.0, 40.0, false, 1.6, Vector2(0.5, 0.55)],
		[40.0, 17.0, 40.0, false, 1.6, Vector2(0.35, 0.3)],
		[40.0, 36.0, 40.0, false, 2.4, Vector2(0.85, 0.8)],
		[40.0, 6.5, 40.0, false, 1.0, Vector2(0.1, 0.9)],
		[46.0, 14.0, 55.0, true, 0.46, Vector2(0.5, 0.3)],
		[46.0, 14.0, 55.0, true, 0.46, Vector2(0.5, 0.55)],
		[46.0, 30.0, 55.0, true, 0.46, Vector2(0.9, 0.9)],
		[46.0, 14.0, 55.0, true, 0.75, Vector2(0.2, 0.2)],
	]
	var ok_all: bool = true
	var first_bad: String = ""
	for c in cases:
		var cam := Camera3D.new()
		cam.fov = c[2]
		cam.keep_aspect = Camera3D.KEEP_WIDTH if c[3] else Camera3D.KEEP_HEIGHT
		get_root().add_child(cam)
		var vs: Vector2 = Vector2(1000.0 * c[4], 1000.0)
		get_root().size = Vector2i(int(vs.x), int(vs.y))
		var n: Vector2 = c[5]
		var off: Vector2 = ViewLogic.ground_offset(c[0], c[1], c[2], c[3], c[4], n)
		var look := Vector3(-off.x, 0.0, -off.y)
		var pitch: float = deg_to_rad(c[0])
		cam.position = look + Vector3(0.0, sin(pitch), cos(pitch)) * c[1]
		cam.look_at_from_position(cam.position, look, Vector3.UP)
		var sp: Vector2 = cam.unproject_position(Vector3.ZERO)
		var got := Vector2(sp.x / vs.x, sp.y / vs.y)
		if not (near(got.x, n.x, 0.003) and near(got.y, n.y, 0.003)):
			ok_all = false
			first_bad += " [%s -> %s]" % [str(c), str(got)]
		cam.queue_free()
	check(ok_all, "原点按偏移摆好镜头后投影回目标点：不符 %s" % first_bad)


func t_rig() -> void:
	var rig := TRig.new()
	get_root().add_child(rig)
	get_root().size = Vector2i(1600, 1000)
	rig.set_aspect(1.6)
	rig.snap(Vector3(10.0, 0.0, 5.0))
	check(rig.tgt == Vector2(0.5, 0.5) and rig.settled, "新镜头：目标点在正中、已到位")
	var m0: int = rig.view_msgs
	rig.set_view(rect(0.0, 0.07, 1.0, 0.53, 1000.0, 844.0))
	check(rig.view_msgs == m0 + 1, "收到版式消息：计数加一")
	check(not rig.settled, "目标点变了：还没到位")
	# 缓动 0.3 秒，每帧 1/30 秒，镜头跟随追上
	var steps: int = 0
	while not rig.settled and steps < 300:
		rig.follow(Vector3(10.0, 0.0, 5.0), 1.0 / 30.0)
		steps += 1
	check(rig.settled and steps < 120, "目标点缓动完、跟随赶上：%d 帧" % steps)
	check(rig.tgt.is_equal_approx(rig.tgt_goal), "到位后现在的目标点等于终点")
	var vs: Vector2 = Vector2(get_root().size)
	var sp: Vector2 = rig.cam.unproject_position(Vector3(10.0, 0.0, 5.0))
	check(near(sp.x / vs.x, rig.tgt_goal.x, 0.004) and near(sp.y / vs.y, rig.tgt_goal.y, 0.004), "角色投影在目标点上：%s 对 %s" % [str(Vector2(sp.x / vs.x, sp.y / vs.y)), str(rig.tgt_goal)])
	# 缩放时角色仍停在目标点上
	rig.zoom_mul(1.5)
	sp = rig.cam.unproject_position(Vector3(10.0, 0.0, 5.0))
	check(near(sp.x / vs.x, rig.tgt_goal.x, 0.004) and near(sp.y / vs.y, rig.tgt_goal.y, 0.004), "缩放之后角色仍在目标点上：%s" % str(Vector2(sp.x / vs.x, sp.y / vs.y)))
	# 同一个矩形再发一次：目标点不变、不重新缓动，但消息计数照加
	var m1: int = rig.view_msgs
	rig.set_view(rect(0.0, 0.07, 1.0, 0.53, 1000.0, 844.0))
	check(rig.view_msgs == m1 + 1 and rig.settled, "同样的矩形：计数加一，仍到位（不再缓动）")
	# 太小：保持上一次的目标点
	var goal: Vector2 = rig.tgt_goal
	rig.set_view(rect(0.0, 0.0, 1.0, 0.1, 1000.0, 844.0))
	check(rig.tgt_goal == goal and rig.settled, "可见区太小：目标点不动")
	# 从太小恢复：缓动过去，不跳（第一帧的目标点离终点还远）
	rig.set_view(rect(0.0, 0.0, 1.0, 1.0, 1000.0, 844.0))
	rig.follow(Vector3(10.0, 0.0, 5.0), 1.0 / 30.0)
	check(rig.tgt.distance_to(rig.tgt_goal) > 0.02, "从太小恢复：第一帧不跳到终点")
	rig.queue_free()
