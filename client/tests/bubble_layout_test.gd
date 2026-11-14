extends SceneTree
## 气泡排版（bubble_layout.gd）的单测：无头 Godot 直接跑。

const L := preload("res://scripts/features/bubble_layout.gd")

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func item(id: String, x: float, y: float, text: String, view_w: float = 1000.0) -> Dictionary:
	var sz: Vector2 = L.bubble_size(text, view_w)
	return {"id": id, "x": x, "y": y, "w": sz.x, "h": sz.y}


## 测试自己的相交判断（不借用被测模块里的）
func inter(a: Array, b: Array) -> bool:
	return a[0] < b[1] and b[0] < a[1] and a[2] < b[3] and b[2] < a[3]


## 放好之后的矩形（含小三角），和 layout 里的算法一致
func _rc(cx: float, bottom: float, w: float, h: float) -> Array:
	return [cx - w * 0.5, cx + w * 0.5, bottom - h, bottom]


func rect_of(it: Dictionary, lift: float) -> Array:
	return _rc(it["x"], it["y"] - L.RAISE - lift + L.TAIL, it["w"], it["h"] + L.TAIL)


func _init() -> void:
	t_tag_obstacle()
	t_order_independent()
	t_two_lines()
	t_wide_neighbours()
	t_top()
	t_ease()
	t_sizes()
	t_free()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


# 别人的名牌（层级高于气泡）不能压住气泡
func t_tag_obstacle() -> void:
	var a: Dictionary = item("a", 300.0, 400.0, "是呀我刚在书屋门口也看到了")
	# 旁边那位的名牌底边在 y=400-26+5=379 附近，正好落在 a 的气泡里
	var tags: Array = [{"id": "b", "x": 330.0, "y": 380.0, "w": 80.0}, {"id": "a", "x": 300.0, "y": 398.0, "w": 80.0}]
	var res: Dictionary = L.layout([a], tags, 1000.0, 60.0)
	check(res["a"] != null, "名牌: 放得下")
	var r: Array = rect_of(a, res["a"])
	var tr: Array = [290.0, 370.0, 358.0, 380.0]
	check(not inter(r, tr), "名牌: 气泡不压别人的名牌（lift=%s）" % str(res["a"]))
	# 自己的名牌不算障碍（RAISE 已经躲开了）
	var res2: Dictionary = L.layout([a], [{"id": "a", "x": 300.0, "y": 398.0, "w": 80.0}], 1000.0, 60.0)
	check(res2["a"] == 0.0, "名牌: 只有自己的名牌时不抬高")


# 谁往上让只看屏幕位置（靠上的让），不看谁先说话（传入顺序）
func t_order_independent() -> void:
	var front: Dictionary = item("front", 300.0, 400.0, "你好呀")
	var back: Dictionary = item("back", 310.0, 380.0, "在呢")
	var r1: Dictionary = L.layout([front, back], [], 1000.0, 60.0)
	var r2: Dictionary = L.layout([back, front], [], 1000.0, 60.0)
	check(r1 == r2, "顺序: 传入顺序不影响结果")
	check(r1["front"] == 0.0 and r1["back"] > 0.0, "顺序: 屏幕上靠下的不动，靠上的往上让（%s）" % str(r1))
	check(not inter(rect_of(front, r1["front"]), rect_of(back, r1["back"])), "顺序: 两块不相交")


# 两行气泡比 36 像素高：抬一格固定 36 会叠
func t_two_lines() -> void:
	var a: Dictionary = item("a", 300.0, 400.0, "今天广场上有好多人在放灯，要不要一起去看看呀")
	var b: Dictionary = item("b", 300.0, 400.0, "好呀好呀我们现在就出发吧，顺便带上茶")
	check(a["h"] > 40.0, "两行: 估算高度大于 40（%s）" % str(a["h"]))
	var res: Dictionary = L.layout([a, b], [], 1000.0, 60.0)
	check(not inter(rect_of(a, res["a"]), rect_of(b, res["b"])), "两行: 错开后不相交（lift %s）" % str(res))


# 横向离得比 120 远、但气泡最宽 220：也会叠，要错开
func t_wide_neighbours() -> void:
	var a: Dictionary = item("a", 300.0, 400.0, "今天广场上有好多人在放灯，要不要一起去看看呀")
	var b: Dictionary = item("b", 450.0, 400.0, "好呀好呀我们现在就出发吧，顺便带上茶")
	check(absf(a["x"] - b["x"]) > 120.0 and absf(a["x"] - b["x"]) < (a["w"] + b["w"]) * 0.5, "宽气泡: 前提：相距 >120 但仍重叠")
	var res: Dictionary = L.layout([a, b], [], 1000.0, 60.0)
	check(not inter(rect_of(a, res["a"]), rect_of(b, res["b"])), "宽气泡: 错开后不相交")
	var far: Dictionary = item("c", 800.0, 400.0, "好呀好呀我们现在就出发吧，顺便带上茶")
	var res2: Dictionary = L.layout([a, far], [], 1000.0, 60.0)
	check(res2["a"] == 0.0 and res2["c"] == 0.0, "宽气泡: 真正离得远的不动")


# 太靠近屏幕顶部（顶栏之下放不下）不放
func t_top() -> void:
	var near_top: Dictionary = item("a", 300.0, 70.0, "你好")
	var ok_pos: Dictionary = item("b", 600.0, 300.0, "你好")
	var res: Dictionary = L.layout([near_top, ok_pos], [], 1000.0, 60.0)
	check(res["a"] == null, "顶部: 放不下的不放")
	check(res["b"] == 0.0, "顶部: 放得下的照常")
	# 叠起来被顶出去的也不放，但下面的那块不受影响
	var low: Dictionary = item("low", 300.0, 120.0, "你好")
	var up: Dictionary = item("up", 300.0, 110.0, "你好")
	var res2: Dictionary = L.layout([low, up], [], 1000.0, 60.0)
	check(res2["low"] != null, "顶部: 下面的放得下")


# 平滑：一帧只走一部分，最终吸附到目标；目标突变不会一帧跳满
func t_ease() -> void:
	var v: float = L.ease_toward(0.0, 36.0, 0.016)
	check(v > 0.0 and v < 12.0, "平滑: 一帧只走一小段（%s）" % str(v))
	var c: float = 0.0
	for _i in range(60):
		c = L.ease_toward(c, 36.0, 0.016)
	check(c == 36.0, "平滑: 最终吸附到目标（%s）" % str(c))
	var big: float = L.ease_toward(0.0, 36.0, 1.0)
	check(big > 30.0, "平滑: 软件渲染一帧隔一秒时一步基本到位（%s）" % str(big))
	check(L.ease_toward(5.0, 5.2, 0.016) == 5.2, "平滑: 差不到半像素直接吸附")


func t_sizes() -> void:
	var s1: Vector2 = L.bubble_size("你好", 1000.0)
	check(s1.y < 30.0, "尺寸: 一行高约 26（%s）" % str(s1.y))
	var s2: Vector2 = L.bubble_size("一二三四五六七八九十一二三四五六七八九十", 1000.0)
	check(s2.x <= 220.0 and s2.y > 40.0, "尺寸: 长话折两行，宽不超过 220（%s）" % str(s2))
	var s3: Vector2 = L.bubble_size("一二三四五六七八九十一二三四五六七八九十", 300.0)
	check(s3.x <= 180.0, "尺寸: 窄屏不超过 60vw（%s）" % str(s3.x))


# 没人挡路时不动，不产生抬高
func t_free() -> void:
	var a: Dictionary = item("a", 300.0, 400.0, "你好")
	check(L.layout([a], [], 1000.0, 60.0)["a"] == 0.0, "空旷: 不抬高")
	check(L.layout([], [], 1000.0, 60.0).is_empty(), "空旷: 没有气泡返回空")
