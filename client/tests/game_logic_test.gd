extends SceneTree
## game.gd 里纯逻辑的单测：游戏桌落脚点怎么选（不起浏览器、不连服务器）。
## 用法（仓库根目录）：npm run client:unit（或 /opt/godot/godot --headless --path client/town --script ../tests/game_logic_test.gd）

var _fails: int = 0


func _check(ok: bool, msg: String) -> void:
	if not ok:
		_fails += 1
		printerr("FAIL: " + msg)


func _init() -> void:
	var G = load("res://scripts/features/game.gd")
	# 桌心 (10, 10)，四个落脚点距中心 1.75：北 / 南 / 东 / 西
	var anchors: Array = [Vector2(10, 8.25), Vector2(10, 11.75), Vector2(11.75, 10), Vector2(8.25, 10)]
	var busy := 0.6
	# 自己在南边远处：没人占时选最近的南边
	_check(G.pick_seat(anchors, [], Vector2(10, 20), busy) == 1, "从南边来、没人占：应选南（1）")
	# 南边已经站着一个人（0.6 米内）：改选离自己最近的空位（东或西，到南边的人也在 1.x 米外）
	var i2: int = G.pick_seat(anchors, [Vector2(10, 11.9)], Vector2(10, 20), busy)
	_check(i2 == 2 or i2 == 3, "南边被占：应选东或西，实际 %d" % i2)
	# 别人站在 0.59 米处算占着，0.61 米处不算
	_check(G.pick_seat(anchors, [Vector2(10, 11.75 - 0.59)], Vector2(10, 20), busy) != 1, "0.59 米内算占着")
	_check(G.pick_seat(anchors, [Vector2(10, 11.75 - 0.61)], Vector2(10, 20), busy) == 1, "0.61 米不算占着")
	# 四个全被占：取离自己最近的（不卡死）
	var all_taken: Array = [Vector2(10, 8.3), Vector2(10, 11.7), Vector2(11.7, 10), Vector2(8.3, 10)]
	_check(G.pick_seat(anchors, all_taken, Vector2(10, 20), busy) == 1, "全被占：取最近的南（1）")
	# 两个人先后选：A 占了南，B 选的不能是南
	var a: int = G.pick_seat(anchors, [], Vector2(10, 20), busy)
	var b: int = G.pick_seat(anchors, [anchors[a]], Vector2(10, 20), busy)
	_check(a != b, "A、B 选的落脚点要不同：%d %d" % [a, b])
	_check((anchors[a] as Vector2).distance_to(anchors[b]) > 1.0, "A、B 落脚点相距要大于 1 米")
	# 没有落脚点：返回 -1
	_check(G.pick_seat([], [], Vector2.ZERO, busy) == -1, "没有落脚点：-1")
	if _fails > 0:
		printerr("game 单测失败 %d 项" % _fails)
		quit(1)
	else:
		print("game 单测通过")
		quit(0)
