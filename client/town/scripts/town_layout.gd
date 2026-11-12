class_name TLayout
extends RefCounted
## 街景里「地图清单之外」的装饰：树、栅栏、树篱、花、灯、摊位……全部只放在不可走的地方（world.put 会按栅格检查，压到可走格的一律丢掉）。
## 服务器地图改了（mapVersion 变了）要来看一眼这里。位置是人工布置的，随机只用来抖动，不用 randf（用坐标哈希，每次一样）。

static func _h(x: float, z: float, k: float = 0.0) -> float:
	return TMB.hash3(Vector3(x * 1.7, z * 1.3, k))


## 在矩形里按间距撒一批东西（带抖动），kinds 里按哈希挑；density 是留下的比例。
static func scatter(w: TWorld, rect: Rect2, step: float, kinds: Array, density: float, scale_min: float = 0.9, scale_max: float = 1.15, hx: float = 0.5, k: float = 0.0) -> void:
	var z: float = rect.position.y
	var row: int = 0
	while z <= rect.end.y:
		var x: float = rect.position.x + (step * 0.5 if row % 2 == 1 else 0.0)
		while x <= rect.end.x:
			var jx: float = (_h(x, z, k + 1.0) - 0.5) * step * 0.7
			var jz: float = (_h(x, z, k + 2.0) - 0.5) * step * 0.7
			if _h(x, z, k + 3.0) < density:
				var kind: String = kinds[int(_h(x, z, k + 4.0) * float(kinds.size())) % kinds.size()]
				var sc: float = lerpf(scale_min, scale_max, _h(x, z, k + 5.0))
				w.put(kind, x + jx, z + jz, _h(x, z, k + 6.0) * 360.0, sc, hx)
			x += step
		z += step
		row += 1


## 沿线摆（栅栏、树篱）：unit 是单件的长度，yaw_axis "x" 沿 x 方向（yaw 0）、"z" 沿 z 方向（yaw 90）。
static func line(w: TWorld, kind: String, x0: float, z0: float, x1: float, z1: float, unit: float, hx: float = 0.25, skip: Array = []) -> void:
	var len: float = Vector2(x1 - x0, z1 - z0).length()
	var n: int = maxi(1, int(round(len / unit)))
	var yaw: float = rad_to_deg(atan2(-(z1 - z0), x1 - x0))
	for i in range(n):
		var t: float = (float(i) + 0.5) / float(n)
		var x: float = lerpf(x0, x1, t)
		var z: float = lerpf(z0, z1, t)
		var ok := true
		for s in skip:
			if x > float(s[0]) and x < float(s[1]):
				ok = false
		if ok:
			w.put(kind, x, z, yaw, 1.0, hx)


static func populate(w: TWorld, sid: String, _sc: Dictionary) -> void:
	if sid == "town":
		_town(w)
	else:
		_home(w)


static func _home(w: TWorld) -> void:
	# 私宅只有墙边那一圈不可走的缝能放东西：墙上的书架、灯笼
	w.put("prop.bookshelf", 2.2, 0.74, 0.0, 1.0, 0.1, 0.1, {"w": 2.2, "h": 1.7, "d": 0.3}, 0.0, false)
	w.put("prop.bookshelf", 8.0, 0.74, 0.0, 1.0, 0.1, 0.1, {"w": 1.6, "h": 1.7, "d": 0.3}, 0.0, false)
	for x in [3.6, 6.4]:
		w.put("paper_lantern", x, 0.8, 0.0, 1.0, 0.1, 0.1, {}, 1.9, false)
		w.glow(Vector3(x, 2.3, 0.85), 2.2)
	w.pool(5.25, 3.0, 5.0, 0.7)


static func _town(w: TWorld) -> void:
	var pines := ["tree.pine", "tree.pine_tall", "tree.pine_crooked"]
	var mixed := ["tree.pine", "tree.round", "tree.pine_tall", "tree.round", "tree.cherry"]
	# ── 北边：房子后面的一圈林子、房子之间的缝 ──
	scatter(w, Rect2(2.0, 0.3, 58.0, 0.7), 2.6, pines + ["tree.round"], 0.8, 0.9, 1.15, 0.6, 10.0)
	scatter(w, Rect2(59.2, 1.0, 4.0, 11.5), 2.4, mixed, 0.85, 0.9, 1.2, 0.6, 20.0)
	scatter(w, Rect2(0.5, 1.0, 2.4, 11.5), 2.4, mixed, 0.85, 0.9, 1.2, 0.6, 30.0)
	# 书屋和厨房之间的小花园（两棵樱树、长椅、花箱）
	w.put("tree.cherry", 37.0, 4.0, 0.0, 1.15, 0.7)
	w.put("tree.cherry", 41.2, 8.0, 80.0, 1.05, 0.7)
	w.put("tree.round", 40.8, 3.2, 30.0, 0.9, 0.6)
	w.put("bench", 38.6, 9.4, 0.0, 1.0, 1.0, 0.5, {"len": 1.8})
	w.put("prop.planter", 36.2, 8.4, 0.0, 1.0, 0.5, 0.5, {"w": 0.9, "d": 0.9})
	w.put("prop.planter", 39.2, 6.0, 0.0, 1.0, 0.5, 0.5, {"w": 1.0, "d": 1.0})
	line(w, "hedge_low", 35.3, 11.3, 43.0, 11.3, 1.0, 0.3)
	w.put("lamp", 35.4, 3.0, 0.0, 1.0, 0.3)
	w.pool(35.4, 3.0, 5.0, 1.0)
	w.put("lamp", 42.6, 10.4, 0.0, 1.0, 0.3)
	w.pool(42.6, 10.4, 5.0, 1.0)
	# 茶馆和书屋之间的窄缝：灌木、木箱
	for z in [3.0, 5.2, 7.4, 9.6]:
		w.put("bush", 20.0, z, 0.0, 1.0 + 0.15 * _h(20.0, z), 0.4)
	w.put("crate", 19.6, 11.2, 20.0, 1.0, 0.4)
	w.put("barrel", 20.4, 11.0, 0.0, 1.0, 0.4)
	# 厨房东侧：木桶、木箱、柴堆
	w.put("barrel", 59.4, 11.2, 0.0, 1.0, 0.4)
	w.put("barrel", 60.0, 10.6, 0.0, 1.0, 0.4)
	w.put("crate", 59.5, 9.8, 15.0, 1.0, 0.4)
	w.put("crate", 60.1, 9.5, 40.0, 0.9, 0.4)
	w.put("cart", 61.4, 7.6, 90.0, 1.0, 0.9, 1.4)
	# ── 横贯的大路（z 13..18）两侧：路灯、灯笼、小摊 ──
	w.put("lamp", 11.0, 12.8, 0.0, 1.0, 0.3)
	w.pool(11.0, 12.8, 5.0, 1.0)
	w.put("lamp", 51.0, 12.8, 0.0, 1.0, 0.3)
	w.pool(51.0, 12.8, 5.0, 1.0)
	# ── 路的北边：茶馆前的两张小桌、书屋前的书车、厨房前的蔬果摊 ──
	# ── 大路南边（z 18..20）：树篱、树 ──
	line(w, "hedge", 2.4, 18.8, 14.4, 18.8, 2.0, 0.4)
	w.put("tree.round", 5.0, 19.0, 0.0, 1.0, 0.5)
	w.put("tree.cherry", 12.0, 19.0, 40.0, 1.0, 0.5)
	# 灯巷会馆前：信箱、纸灯笼
	for i in range(5):
		w.put("mailbox", 1.82, 22.0 + 1.8 * float(i), 270.0, 1.0, 0.25, 0.25)
	# ── 会馆和广场之间两块缝：樱树、树篱、长椅 ──
	w.put("tree.cherry", 17.6, 21.6, 0.0, 1.1, 0.7)
	w.put("tree.round", 18.2, 29.4, 0.0, 1.0, 0.6)
	w.put("tree.round", 17.6, 32.6, 0.0, 0.9, 0.6)
	line(w, "hedge_low", 16.5, 23.4, 19.5, 23.4, 1.0, 0.3)
	w.put("bush", 16.8, 27.2 + 0.0, 0.0, 1.0, 0.4)
	w.put("bush", 18.8, 27.4, 0.0, 1.1, 0.4)
	w.put("bush", 16.6, 33.2, 0.0, 1.0, 0.4)
	# 广场东边的缝
	w.put("tree.cherry", 45.6, 20.8, 0.0, 1.1, 0.7)
	w.put("tree.round", 46.2, 30.4, 0.0, 1.0, 0.6)
	w.put("tree.round", 45.6, 33.2, 0.0, 0.9, 0.6)
	line(w, "hedge_low", 44.5, 23.8, 47.5, 23.8, 1.0, 0.3)
	w.put("bush", 45.0, 27.2, 0.0, 1.0, 0.4)
	w.put("bush", 47.0, 27.4, 0.0, 1.1, 0.4)
	# 广场西北、东北角之外的草地（z 18..20 的窄缝）
	for x in [21.0, 23.5, 26.0]:
		w.put("bush", x, 18.9, 0.0, 1.0, 0.4)
	for x in [39.0, 41.0]:
		w.put("bush", x, 18.9, 0.0, 1.0, 0.4)
	w.put("banner.green", 22.0, 18.7, 0.0, 1.0, 0.3)
	w.put("banner.red", 42.2, 18.7, 0.0, 1.0, 0.3)
	# 广场内摊位的旗、周围的灌木（stall 的碰撞盒在 38..41 / 19.5..21）
	w.put("bush", 37.2, 20.6, 0.0, 1.0, 0.4)
	w.put("bush", 41.6, 20.4, 0.0, 1.0, 0.4)
	# 广场北侧长椅旁的空格（z 22..24 x 36..38 在广场里是可走的，不放）
	# ── 广场南边（z 34..36）：树篱、灯、长椅 ──
	line(w, "hedge_low", 20.2, 34.6, 29.8, 34.6, 1.0, 0.3)
	line(w, "hedge_low", 34.2, 34.6, 43.8, 34.6, 1.0, 0.3)
	line(w, "hedge", 0.4, 34.6, 6.6, 34.6, 2.0, 0.4)
	line(w, "hedge", 12.0, 34.6, 19.0, 34.6, 2.0, 0.4)
	w.put("bush", 21.0, 35.2, 0.0, 1.0, 0.4)
	w.put("bush", 42.5, 35.2, 0.0, 1.0, 0.4)
	w.put("tree.round", 3.0, 33.4, 0.0, 1.1, 0.6)
	w.put("tree.round", 9.0, 33.6, 0.0, 1.0, 0.6)
	w.put("tree.cherry", 15.5, 33.5, 30.0, 1.1, 0.6)
	# ── 花园（x 48..62, z 20..34）：围栏、树篱、花床、小亭 ──
	line(w, "fence", 48.3, 19.6, 62.0, 19.6, 1.8, 0.2, [[53.0, 57.0]])
	line(w, "fence", 62.2, 19.8, 62.2, 34.0, 1.8, 0.2)
	line(w, "hedge", 48.2, 34.6, 53.2, 34.6, 2.0, 0.4)
	line(w, "hedge", 58.4, 34.6, 62.0, 34.6, 2.0, 0.4)
	w.put("fence_gate", 55.0, 19.6, 0.0, 1.0, -1.0)
	w.put("tree.cherry", 49.2, 21.0, 0.0, 1.1, 0.7)
	w.put("tree.round", 61.4, 20.8, 0.0, 1.0, 0.6)
	w.put("tree.cherry", 61.4, 33.4, 0.0, 1.0, 0.6)
	w.put("flowerbed", 50.0, 31.9, 0.0, 1.0, 0.7, 0.4, {"w": 1.2, "d": 0.7})
	w.put("flowerbed", 50.0, 26.2, 0.0, 1.0, 0.7, 0.4, {"w": 1.2, "d": 0.7})
	w.put("bench", 61.4, 27.0, 90.0, 1.0, 0.3, 0.9, {"len": 1.8})
	w.put("bush", 59.2, 25.0, 0.0, 1.1, 0.4)
	w.put("rock.small", 49.6, 28.8, 20.0, 1.0, 0.4)
	w.put("lamp", 62.0, 24.0, 0.0, 1.0, 0.3)
	w.pool(62.0, 24.0, 5.0, 1.0)
	# ── 下方的大路（z 36..40）南边：游戏馆前后的草地、树林 ──
	scatter(w, Rect2(0.6, 40.4, 22.0, 7.0), 2.7, mixed, 0.7, 0.9, 1.2, 0.6, 40.0)
	scatter(w, Rect2(41.4, 40.4, 22.2, 7.0), 2.7, mixed, 0.7, 0.9, 1.2, 0.6, 50.0)
	scatter(w, Rect2(23.0, 47.6, 18.0, 0.4), 2.4, pines, 0.8, 0.9, 1.1, 0.6, 60.0)
	w.put("rock", 8.0, 43.0, 30.0, 1.1, 0.7)
	w.put("rock.wide", 54.0, 44.0, 70.0, 1.0, 0.8)
	w.put("rock.small", 44.5, 41.2, 120.0, 1.0, 0.4)
	# 游戏馆两侧和南墙外
	for x in [22.5, 41.5]:
		w.put("bush", x, 40.8, 0.0, 1.0, 0.4)
	# 游戏馆里的旗子（贴着内墙的缝）
	w.put("banner.red", 26.6, 40.88, 0.0, 1.0, -1.0, -1.0, {}, 0.0, false)
	w.put("banner.green", 37.4, 40.88, 0.0, 1.0, -1.0, -1.0, {}, 0.0, false)
	w.glow(Vector3(32.0, 2.2, 41.0), 2.6)
	# 大路两侧的灯（下路）
	w.put("lamp", 15.0, 39.8, 0.0, 1.0, 0.3)
	w.pool(15.0, 39.8, 5.0, 1.0)
	w.put("lamp", 49.0, 39.8, 0.0, 1.0, 0.3)
	w.pool(49.0, 39.8, 5.0, 1.0)
