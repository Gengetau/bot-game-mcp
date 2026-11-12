class_name TTownArt
extends RefCounted
## 栖灯镇的程序生成配方：建筑、家具、小摆设。几何体坐标都是世界坐标（建筑）或以脚底原点为局部坐标（小摆设），
## 颜色全在顶点色里（见 mesh_builder.gd / town.gdshader）。素材层的 proc 名字对应这里的 build_<名字>。
## 色板：米白灰泥、木棕、灰蓝瓦、柔和的绿，少量暖橙灯光。

const PLASTER := Color(0.93, 0.89, 0.80)
const PLASTER_D := Color(0.86, 0.80, 0.70)
const TIMBER := Color(0.52, 0.37, 0.26)
const TIMBER_D := Color(0.40, 0.28, 0.20)
const TIMBER_L := Color(0.68, 0.50, 0.34)
const ROOF := Color(0.47, 0.55, 0.65)
const WOOD_IN := Color(0.70, 0.52, 0.36)
const GLASS := Color(0.40, 0.52, 0.60)
const STONE := Color(0.78, 0.75, 0.70)
const STONE_D := Color(0.62, 0.59, 0.55)
const GREEN := Color(0.52, 0.70, 0.40)
const GREEN_D := Color(0.38, 0.56, 0.32)
const PINK := Color(0.96, 0.76, 0.80)
const LANTERN := Color(1.0, 0.62, 0.28)
const CREAM := Color(0.97, 0.94, 0.86)

const WALL_T := 0.30  # 服务器地图里墙的厚度（WALL_FAR - WALL_NEAR）


static func _c(r: float, g: float, b: float) -> Color:
	return Color(r, g, b, 1.0)


static func _mul(c: Color, k: float) -> Color:
	return Color(c.r * k, c.g * k, c.b * k, c.a)


# ─────────────────────────── 小摆设（局部坐标，脚底在原点，朝向 +z 为「正面」）───────────────────────────


static func build_tree_round(b: TMB, _p: Dictionary = {}) -> void:
	b.cyl(Vector3.ZERO, 1.7, 0.2, 0.13, TIMBER, 7)
	b.cyl(Vector3(0.0, 1.0, 0.0), 0.9, 0.1, 0.05, TIMBER_D, 5)  # 一根短枝
	b.blob(Vector3(0.0, 2.7, 0.0), 1.25, GREEN, 8, 4, 0.82, 1.1, 0.8, 1.0)
	b.blob(Vector3(0.75, 2.2, 0.25), 0.85, _mul(GREEN, 0.97), 7, 4, 0.85, 1.08, 0.8, 2.0)
	b.blob(Vector3(-0.7, 2.1, -0.2), 0.8, _mul(GREEN, 1.04), 7, 4, 0.85, 1.08, 0.8, 3.0)


static func build_tree_cherry(b: TMB, _p: Dictionary = {}) -> void:
	b.cyl(Vector3.ZERO, 1.5, 0.2, 0.12, TIMBER_D, 7)
	b.cyl(Vector3(0.0, 0.9, 0.0), 1.0, 0.1, 0.05, TIMBER_D, 5)
	b.blob(Vector3(0.0, 2.55, 0.0), 1.3, PINK, 8, 4, 0.78, 1.08, 0.84, 4.0)
	b.blob(Vector3(0.8, 2.1, 0.3), 0.85, _mul(PINK, 1.02), 7, 4, 0.8, 1.06, 0.84, 5.0)
	b.blob(Vector3(-0.8, 2.05, -0.2), 0.8, _mul(PINK, 0.97), 7, 4, 0.8, 1.06, 0.84, 6.0)


static func build_bush(b: TMB, _p: Dictionary = {}) -> void:
	b.blob(Vector3(0.0, 0.32, 0.0), 0.5, GREEN_D, 7, 3, 0.8, 1.1, 0.8, 7.0)
	b.blob(Vector3(0.38, 0.26, 0.12), 0.34, GREEN, 6, 3, 0.8, 1.1, 0.8, 8.0)


static func build_crate(b: TMB, _p: Dictionary = {}) -> void:
	b.box(Vector3(0, 0.3, 0), Vector3(0.6, 0.6, 0.6), TIMBER_L, 0.0, 0.88)
	for yy in [0.12, 0.48]:
		b.box(Vector3(0, yy, 0), Vector3(0.64, 0.07, 0.64), TIMBER, 0.0, 1.0, "unsew")
	for xx in [-0.27, 0.27]:
		b.box(Vector3(xx, 0.3, 0), Vector3(0.07, 0.62, 0.64), TIMBER, 0.0, 1.0, "unsew")


static func build_barrel(b: TMB, _p: Dictionary = {}) -> void:
	b.cyl(Vector3.ZERO, 0.8, 0.3, 0.3, TIMBER_L, 9, 0.0, true)
	b.cyl(Vector3(0, 0.12, 0), 0.07, 0.315, 0.315, TIMBER_D, 9, 0.0, false)
	b.cyl(Vector3(0, 0.6, 0), 0.07, 0.315, 0.315, TIMBER_D, 9, 0.0, false)


static func build_paper_lantern(b: TMB, _p: Dictionary = {}) -> void:
	b.cyl(Vector3(0, 0.0, 0), 0.42, 0.2, 0.2, LANTERN, 8, 0.75, false)
	b.cyl(Vector3(0, 0.42, 0), 0.05, 0.2, 0.16, TIMBER_D, 8)
	b.cyl(Vector3(0, -0.05, 0), 0.05, 0.14, 0.2, TIMBER_D, 8)
	b.box(Vector3(0, 0.58, 0), Vector3(0.03, 0.3, 0.03), TIMBER_D, 0.0, 1.0, "unsew")


static func build_mailbox(b: TMB, _p: Dictionary = {}) -> void:
	b.box(Vector3(0, 0.55, 0), Vector3(0.12, 1.1, 0.12), TIMBER_D, 0.0, 0.9)
	b.box(Vector3(0, 1.2, 0), Vector3(0.5, 0.36, 0.34), _c(0.78, 0.38, 0.32))
	b.box(Vector3(0, 1.43, 0), Vector3(0.56, 0.08, 0.4), _c(0.62, 0.28, 0.24))
	b.box(Vector3(0, 1.2, 0.18), Vector3(0.32, 0.06, 0.02), CREAM)


## 长椅：长 L（沿 x），座面朝 +z，靠背在 -z 一侧。
static func build_bench(b: TMB, p: Dictionary = {}) -> void:
	var L: float = float(p.get("len", 1.8))
	b.box(Vector3(0, 0.44, 0.0), Vector3(L, 0.08, 0.42), TIMBER_L)
	b.box(Vector3(0, 0.78, -0.2), Vector3(L, 0.36, 0.06), TIMBER)
	for sx in [-1.0, 1.0]:
		b.box(Vector3(sx * (L * 0.5 - 0.1), 0.22, 0.0), Vector3(0.08, 0.44, 0.38), TIMBER_D, 0.0, 0.9)
		b.box(Vector3(sx * (L * 0.5 - 0.1), 0.62, -0.2), Vector3(0.08, 0.5, 0.08), TIMBER_D)


static func build_table_round(b: TMB, _p: Dictionary = {}) -> void:
	b.cyl(Vector3(0, 0.0, 0), 0.7, 0.07, 0.07, TIMBER_D, 7, 0.0, false)
	b.cyl(Vector3(0, 0.0, 0), 0.06, 0.28, 0.28, TIMBER_D, 8)
	b.cyl(Vector3(0, 0.7, 0), 0.07, 0.52, 0.52, TIMBER_L, 10)
	# 茶壶与两只杯子
	b.cyl(Vector3(0.0, 0.77, 0.0), 0.16, 0.12, 0.1, _c(0.55, 0.66, 0.62), 7)
	b.cyl(Vector3(0.0, 0.93, 0.0), 0.04, 0.06, 0.0, _c(0.55, 0.66, 0.62), 6)
	b.box(Vector3(0.14, 0.86, 0.0), Vector3(0.08, 0.03, 0.03), _c(0.55, 0.66, 0.62))
	for dx in [-0.28, 0.26]:
		b.cyl(Vector3(dx, 0.77, 0.14), 0.07, 0.045, 0.055, CREAM, 6)


static func build_counter(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 3.0))
	var d: float = float(p.get("d", 1.0))
	var h: float = float(p.get("h", 1.1))
	var kind: String = str(p.get("style", "tea"))
	b.box(Vector3(0, h * 0.5 - 0.04, 0), Vector3(w * 0.96, h - 0.08, d * 0.86), TIMBER, 0.0, 0.85)
	b.box(Vector3(0, h - 0.04, 0), Vector3(w, 0.08, d * 0.98), TIMBER_L)
	# 前面板的装饰条
	var n: int = maxi(2, int(w / 0.8))
	for i in range(n):
		var x: float = -w * 0.5 + (float(i) + 0.5) * w / float(n)
		b.box(Vector3(x, h * 0.45, d * 0.44), Vector3(w / float(n) - 0.14, h * 0.55, 0.03), TIMBER_D, 0.0, 1.0, "unsew")
	if kind == "tea":
		for i in range(3):
			b.cyl(Vector3(-w * 0.35 + 0.45 * float(i), h, -0.1), 0.2, 0.1, 0.1, [_c(0.55, 0.66, 0.62), _c(0.80, 0.62, 0.45), CREAM][i], 7)
		b.cyl(Vector3(w * 0.3, h, 0.0), 0.2, 0.17, 0.12, _c(0.35, 0.36, 0.40), 8)  # 铁壶
		b.cyl(Vector3(w * 0.3, h + 0.2, 0.0), 0.05, 0.06, 0.0, _c(0.35, 0.36, 0.40), 6)
	elif kind == "book":
		for i in range(4):
			b.box(Vector3(-w * 0.35 + 0.28 * float(i), h + 0.07 + 0.07 * float(i % 2), 0.0), Vector3(0.22, 0.14 + 0.14 * float(i % 2), 0.3), [_c(0.62, 0.40, 0.36), _c(0.40, 0.52, 0.44), _c(0.45, 0.50, 0.65), _c(0.80, 0.68, 0.40)][i])
		b.box(Vector3(w * 0.3, h + 0.05, 0.0), Vector3(0.5, 0.1, 0.36), CREAM)
	b.box(Vector3(w * 0.15, h + 0.12, 0.28), Vector3(0.1, 0.24, 0.1), _c(0.78, 0.38, 0.32), 0.0, 1.0, "unsew")


static func build_bookshelf(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 6.0))
	var h: float = float(p.get("h", 2.5))
	var d: float = float(p.get("d", 0.7))
	# 柜体：背板、两侧、隔板
	b.box(Vector3(0, h * 0.5, -d * 0.45), Vector3(w, h, 0.08), TIMBER_D, 0.0, 0.9)
	for sx in [-0.5, 0.5]:
		b.box(Vector3(sx * w, h * 0.5, 0), Vector3(0.1, h, d), TIMBER)
	b.box(Vector3(0, h + 0.04, 0), Vector3(w + 0.2, 0.1, d + 0.1), TIMBER_L)
	var rows: int = 5
	var pal := [_c(0.62, 0.40, 0.36), _c(0.40, 0.52, 0.44), _c(0.45, 0.50, 0.65), _c(0.80, 0.68, 0.40), _c(0.70, 0.55, 0.62), _c(0.88, 0.84, 0.72), _c(0.36, 0.42, 0.52)]
	for r in range(rows):
		var y0: float = 0.12 + float(r) * (h - 0.2) / float(rows)
		b.box(Vector3(0, y0, 0), Vector3(w - 0.1, 0.06, d), TIMBER)
		var x: float = -w * 0.5 + 0.2
		var i: int = 0
		while x < w * 0.5 - 0.3:
			var bw: float = 0.14 + 0.12 * TMB.hash3(Vector3(float(r), float(i), 5.0))
			var bh: float = 0.42 + 0.2 * TMB.hash3(Vector3(float(i), float(r), 9.0))
			var col: Color = pal[(i * 3 + r * 5) % pal.size()]
			b.box(Vector3(x + bw * 0.5, y0 + 0.03 + bh * 0.5, 0.05), Vector3(bw, bh, d * 0.7), col, 0.0, 0.9)
			x += bw + 0.02
			i += 1


static func build_stove(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 2.0))
	var d: float = float(p.get("d", 1.5))
	b.box(Vector3(0, 0.45, 0), Vector3(w * 0.92, 0.9, d * 0.9), _c(0.72, 0.52, 0.42), 0.0, 0.85)
	b.box(Vector3(0, 0.93, 0), Vector3(w * 0.96, 0.08, d * 0.94), _c(0.34, 0.34, 0.38))
	# 灶口与锅
	for sx in [-0.28, 0.28]:
		b.cyl(Vector3(sx * w, 0.97, 0.05), 0.04, 0.26, 0.26, _c(0.22, 0.22, 0.25), 8)
	b.cyl(Vector3(-0.28 * w, 1.0, 0.05), 0.28, 0.22, 0.2, _c(0.45, 0.47, 0.5), 9)
	b.cyl(Vector3(0.28 * w, 1.0, 0.05), 0.2, 0.2, 0.17, _c(0.7, 0.4, 0.3), 9)
	# 炉门（朝 +z）
	b.box(Vector3(0, 0.38, d * 0.46), Vector3(w * 0.5, 0.4, 0.04), _c(0.25, 0.24, 0.26), 0.0, 1.0, "unsew", 0.4)
	# 排烟罩 + 烟囱
	b.box(Vector3(0, 2.0, -d * 0.28), Vector3(w * 0.9, 0.5, d * 0.4), _c(0.40, 0.40, 0.44), 0.0, 1.0)
	b.box(Vector3(0, 2.6, -d * 0.35), Vector3(0.4, 0.9, 0.4), _c(0.40, 0.40, 0.44), 0.0, 1.0)


static func build_pantry(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 1.5))
	var d: float = float(p.get("d", 2.5))
	var h: float = float(p.get("h", 1.8))
	# 靠西墙的橱柜，正面朝东（+x）：局部按 w=x 深度, d=z 长度
	b.box(Vector3(0, h * 0.5, 0), Vector3(w * 0.9, h, d * 0.94), TIMBER, 0.0, 0.85)
	b.box(Vector3(0, h + 0.03, 0), Vector3(w * 0.96, 0.08, d), TIMBER_L)
	for i in range(3):
		var z: float = -d * 0.3 + float(i) * d * 0.3
		b.box(Vector3(w * 0.46, h * 0.5, z), Vector3(0.03, h * 0.8, d * 0.26), TIMBER_D, 0.0, 1.0, "unsew")
	for i in range(4):
		b.cyl(Vector3(0.0, h + 0.07, -d * 0.36 + float(i) * 0.5), 0.3, 0.14, 0.13, [_c(0.85, 0.70, 0.45), _c(0.60, 0.70, 0.50), CREAM, _c(0.78, 0.48, 0.38)][i], 7)


static func build_shed(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 2.5))
	var d: float = float(p.get("d", 3.0))
	var h: float = float(p.get("h", 2.1))
	b.box(Vector3(0, h * 0.5, 0), Vector3(w, h, d), TIMBER_L, 0.0, 0.85)
	for i in range(int(w / 0.4)):
		b.box(Vector3(-w * 0.5 + 0.2 + 0.4 * float(i), h * 0.5, d * 0.5 + 0.01), Vector3(0.04, h, 0.02), TIMBER_D, 0.0, 1.0, "unsew")
	b.gable_roof_z(-d * 0.5 - 0.25, d * 0.5 + 0.25, 0.0, w * 0.5 + 0.3, h, 0.75, _c(0.50, 0.46, 0.44), 4)
	# 门（朝 +z）与窗
	b.box(Vector3(-0.4, 0.85, d * 0.5 + 0.02), Vector3(0.8, 1.6, 0.05), TIMBER_D, 0.0, 1.0, "unsew")
	b.box(Vector3(0.65, 1.25, d * 0.5 + 0.02), Vector3(0.5, 0.45, 0.05), GLASS, 0.0, 1.0, "unsew", 0.8)
	# 门口的花盆
	b.cyl(Vector3(0.8, 0.0, d * 0.5 + 0.3), 0.3, 0.17, 0.2, _c(0.78, 0.52, 0.40), 7)
	b.blob(Vector3(0.8, 0.45, d * 0.5 + 0.3), 0.22, GREEN, 6, 3, 0.9, 1.1, 0.85, 11.0)


static func build_arcade_table(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 2.0))
	var d: float = float(p.get("d", 2.0))
	var felt := _c(0.36, 0.55, 0.52)
	for sx in [-1.0, 1.0]:
		for sz in [-1.0, 1.0]:
			b.box(Vector3(sx * (w * 0.5 - 0.15), 0.34, sz * (d * 0.5 - 0.15)), Vector3(0.14, 0.68, 0.14), TIMBER_D, 0.0, 0.9)
	b.box(Vector3(0, 0.72, 0), Vector3(w, 0.1, d), TIMBER)
	b.box(Vector3(0, 0.78, 0), Vector3(w - 0.2, 0.03, d - 0.2), felt)
	# 骰子、牌、棋子
	b.box(Vector3(-0.3, 0.85, 0.2), Vector3(0.13, 0.13, 0.13), CREAM, 0.5)
	b.box(Vector3(0.0, 0.84, -0.3), Vector3(0.11, 0.11, 0.11), CREAM, 0.2)
	b.box(Vector3(0.45, 0.81, 0.1), Vector3(0.26, 0.012, 0.18), CREAM, 0.3)
	b.box(Vector3(0.55, 0.81, 0.3), Vector3(0.26, 0.012, 0.18), _c(0.85, 0.5, 0.45), -0.2)
	for i in range(3):
		b.cyl(Vector3(-0.6 + 0.18 * float(i), 0.8, -0.55), 0.1, 0.06, 0.05, [_c(0.78, 0.38, 0.32), _c(0.40, 0.52, 0.70), _c(0.95, 0.82, 0.45)][i], 6)


static func build_planter(b: TMB, p: Dictionary = {}) -> void:
	var w: float = float(p.get("w", 0.9))
	var d: float = float(p.get("d", 0.9))
	b.box(Vector3(0, 0.22, 0), Vector3(w, 0.44, d), TIMBER_L, 0.0, 0.85)
	b.box(Vector3(0, 0.45, 0), Vector3(w - 0.12, 0.04, d - 0.12), _c(0.40, 0.30, 0.22))
	var cols := [PINK, _c(0.98, 0.90, 0.55), CREAM, _c(0.88, 0.62, 0.55)]
	var nx: int = maxi(2, int(w / 0.3))
	var nz: int = maxi(2, int(d / 0.3))
	for ix in range(nx):
		for iz in range(nz):
			var x: float = -w * 0.5 + (float(ix) + 0.5) * w / float(nx)
			var z: float = -d * 0.5 + (float(iz) + 0.5) * d / float(nz)
			var hh: float = TMB.hash3(Vector3(x, z, 2.0))
			b.blob(Vector3(x, 0.55 + 0.08 * hh, z), 0.13 + 0.05 * hh, GREEN_D if (ix + iz) % 3 == 0 else cols[(ix * 2 + iz) % cols.size()], 5, 3, 0.85, 1.05, 0.9, float(ix * 7 + iz))


static func build_flowerbed(b: TMB, p: Dictionary = {}) -> void:
	build_planter(b, p)


static func build_fountain_top(b: TMB, _p: Dictionary = {}) -> void:
	b.cyl(Vector3(0, 0.3, 0), 0.9, 0.3, 0.16, STONE, 8)
	b.cyl(Vector3(0, 1.1, 0), 0.12, 0.62, 0.5, STONE, 10)
	b.cyl(Vector3(0, 1.2, 0), 0.1, 0.5, 0.45, _c(0.56, 0.78, 0.80), 10)
	b.cyl(Vector3(0, 1.1, 0), 0.5, 0.1, 0.07, STONE, 6)
	b.cyl(Vector3(0, 1.58, 0), 0.08, 0.3, 0.22, STONE, 8)
	b.blob(Vector3(0, 1.82, 0), 0.16, _c(0.80, 0.92, 0.95), 6, 3, 1.1, 1.05, 0.9, 3.0)


# ─────────────────────────── 建筑 ───────────────────────────


## 一栋房子。p：
##   inner Rect2（地图里的室内矩形）、door {side "s"|"n", x0, x1（门洞的实际范围）}、h（墙高，默认 3.0）、
##   style {plaster, roof, accent, sign, chimney}
## 返回 {shell: TMB, up: TMB, interior: TMB, glows: Array[{pos, size, strength}], up_aabb: AABB, outer: Rect2}
## shell：一直显示的部分（后墙、侧墙、前墙下半、门框、室内陈设）；up：会淡出的部分（屋顶、山墙、前墙上半、窗）。
static func build_house(p: Dictionary) -> Dictionary:
	var inner: Rect2 = p["inner"]
	var door: Dictionary = p["door"]
	var H: float = float(p.get("h", 3.0))
	var st: Dictionary = p.get("style", {})
	var plaster: Color = st.get("plaster", PLASTER)
	var roof: Color = st.get("roof", ROOF)
	var accent: Color = st.get("accent", _c(0.30, 0.38, 0.55))
	var sign: String = str(st.get("sign", ""))
	var X0: float = inner.position.x - 0.65
	var X1: float = inner.position.x + inner.size.x + 0.65
	var Z0: float = inner.position.y - 0.65
	var Z1: float = inner.position.y + inner.size.y + 0.65
	var shell := TMB.new()
	var up := TMB.new()
	var interior := TMB.new()
	var glows: Array = []
	var lowh: float = 0.85  # 前墙下半的高度（淡出时留下的墙脚）
	var inner_wall: Color = st.get("inner", _mul(PLASTER, 0.96))
	var wains: Color = st.get("wainscot", _c(0.62, 0.45, 0.32))

	# 墙：每面墙是「外层灰泥 + 内层木护墙/灰泥」两块。南墙拆成下半（shell）和上半（up）。
	var gap0: float = float(door["x0"])
	var gap1: float = float(door["x1"])
	var south_door: bool = str(door["side"]) == "s"
	var north_door: bool = str(door["side"]) == "n"
	# 北墙：z 在 Z0..Z0+T，外层在北（z 小），内层在南
	_wall_x(shell, shell, X0, X1, Z0, Z0 + WALL_T, 0.0, H, plaster, inner_wall, wains, true, gap0 if north_door else NAN, gap1 if north_door else NAN)
	# 南墙：外层在南（z 大）
	_wall_x(shell, up, X0, X1, Z1 - WALL_T, Z1, 0.0, H, plaster, inner_wall, wains, false, gap0 if south_door else NAN, gap1 if south_door else NAN, lowh)
	# 东西墙（全高，shell）
	for west in [true, false]:
		var xa: float = X0 if west else X1 - WALL_T
		var out_first: bool = west
		_wall_z(shell, xa, xa + WALL_T, Z0, Z1, 0.0, H, plaster, inner_wall, wains, out_first)

	# 木框：四角立柱、顶梁、中间立柱（南墙的上半在 up）
	var post := 0.26
	for xx in [X0, X1 - post]:
		for zz in [Z0, Z1 - post]:
			shell.block(xx - 0.02, xx + post + 0.02, 0.0, H + 0.1, zz - 0.02, zz + post + 0.02, TIMBER, 0.85)
	shell.block(X0, X1, H - 0.2, H + 0.1, Z0 - 0.04, Z0 + WALL_T + 0.04, TIMBER_D, 1.0, "unsew")
	shell.block(X0 - 0.04, X0 + WALL_T + 0.04, H - 0.2, H + 0.1, Z0, Z1, TIMBER_D, 1.0, "unsew")
	shell.block(X1 - WALL_T - 0.04, X1 + 0.04, H - 0.2, H + 0.1, Z0, Z1, TIMBER_D, 1.0, "unsew")
	up.block(X0, X1, H - 0.2, H + 0.1, Z1 - WALL_T - 0.04, Z1 + 0.04, TIMBER_D, 1.0, "unsew")
	shell.block(X0, X1, 0.0, 0.14, Z0 - 0.05, Z0 + 0.35, STONE_D, 0.8, "unsew")  # 墙基
	up_or_shell_sill(shell, X0, X1, Z1 - WALL_T - 0.05, Z1 + 0.05, gap0 if south_door else NAN, gap1 if south_door else NAN)
	# 立柱：南墙每隔约 3 米一根（避开门洞和窗）
	var span: float = X1 - X0
	var nposts: int = maxi(2, int(round(span / 3.0)))
	var win_x: Array = []
	for i in range(1, nposts):
		var x: float = X0 + span * float(i) / float(nposts)
		if x > gap0 - 0.6 and x < gap1 + 0.6:
			continue
		var pe: TMB = shell
		shell.block(x - 0.1, x + 0.1, 0.0, lowh, Z1 - WALL_T - 0.03, Z1 + 0.04, TIMBER, 0.85, "unsew")
		up.block(x - 0.1, x + 0.1, lowh, H - 0.2, Z1 - WALL_T - 0.03, Z1 + 0.04, TIMBER, 1.0, "unsew")
		shell.block(x - 0.1, x + 0.1, 0.0, H, Z0 - 0.03, Z0 + WALL_T + 0.03, TIMBER, 0.85, "unsew")
		pe = pe
	# 窗：南墙上，每两根立柱之间放一扇（避开门洞）
	var cuts: Array = [X0]
	for i in range(1, nposts):
		cuts.append(X0 + span * float(i) / float(nposts))
	cuts.append(X1)
	for i in range(cuts.size() - 1):
		var xc: float = (float(cuts[i]) + float(cuts[i + 1])) * 0.5
		var half: float = (float(cuts[i + 1]) - float(cuts[i])) * 0.5
		if xc + 0.7 > gap0 - 0.3 and xc - 0.7 < gap1 + 0.3:
			continue
		if half < 1.0:
			continue
		_window(up, Vector3(xc, 1.75, Z1 + 0.04), 1.2, 1.0, accent, true)
		glows.append({"pos": Vector3(xc, 1.75, Z1 + 0.35), "size": 2.4, "strength": 0.55})
	# 北墙内侧的窗（从镜头方向看得见，夜里是暖光）
	for nx in (p.get("nwin", []) as Array):
		_window(shell, Vector3(float(nx), 1.9, Z0 + WALL_T + 0.02), 1.2, 1.0, accent, true)
		glows.append({"pos": Vector3(float(nx), 1.9, Z0 + WALL_T + 0.5), "size": 2.4, "strength": 0.5})
	# 门：框、门楣、暖帘、招牌、门灯
	var dz: float = Z1 if south_door else Z0
	var dsg: float = 1.0 if south_door else -1.0
	if south_door or north_door:
		var dx: float = (gap0 + gap1) * 0.5
		var dw: float = gap1 - gap0
		var jamb := TIMBER
		shell.block(gap0 - 0.14, gap0 + 0.08, 0.0, 2.45, dz - 0.38, dz + 0.1, jamb, 0.85, "unsew")
		shell.block(gap1 - 0.08, gap1 + 0.14, 0.0, 2.45, dz - 0.38, dz + 0.1, jamb, 0.85, "unsew")
		# 门楣：南墙的门楣属于 up（会淡出），但要和下半的门框接上
		var lintel_tmb: TMB = up if south_door else shell
		lintel_tmb.block(gap0 - 0.14, gap1 + 0.14, 2.4, 2.65, dz - 0.4, dz + 0.12, TIMBER_D, 1.0, "unsew")
		# 门楣之上到屋檐是灰泥（up 里的上半墙已经有；门洞上方补一块）
		# 暖帘：三条垂下来的布，在门洞里偏外一点
		var cloth_cols: Array = [accent, _mul(accent, 1.08), accent]
		var strips: int = 4
		for i in range(strips):
			var sx: float = gap0 + (float(i) + 0.5) * dw / float(strips)
			var cc: Color = cloth_cols[i % 3] if i % 2 == 0 else _mul(CREAM, 0.95)
			lintel_tmb.block(sx - dw / float(strips) * 0.42, sx + dw / float(strips) * 0.42, 1.78, 2.4, dz + dsg * 0.06 - 0.03, dz + dsg * 0.06 + 0.03, cc, 1.0, "unsew")
		# 招牌：门楣之上悬挑一块板（南墙上在 up）
		var sign_tmb: TMB = up if south_door else shell
		var sy0: float = 2.7
		sign_tmb.block(dx - 1.0, dx + 1.0, sy0, sy0 + 0.5, dz + dsg * 0.14 - 0.04, dz + dsg * 0.14 + 0.04, accent, 1.0, "unsew")
		sign_tmb.block(dx - 1.06, dx + 1.06, sy0 - 0.04, sy0 + 0.54, dz + dsg * 0.1 - 0.02, dz + dsg * 0.1 + 0.02, TIMBER_D, 1.0, "unsew")
		_sign_icon(sign_tmb, sign, Vector3(dx, sy0 + 0.25, dz + dsg * 0.2), dsg)
		# 门灯：两侧各一只纸灯笼
		for sx2 in [gap0 - 0.5, gap1 + 0.5]:
			var lt := TMB.new()
			build_paper_lantern(lt)
			shell_append(shell if not south_door else up, lt, Transform3D(Basis(), Vector3(sx2, 1.9, dz + dsg * 0.3)))
			glows.append({"pos": Vector3(sx2, 2.1, dz + dsg * 0.4), "size": 1.8, "strength": 0.85})
	# 屋顶：脊线平行于 x，出檐 0.8
	var ov: float = 0.8
	var half_d: float = (Z1 - Z0) * 0.5 + ov
	var rise: float = half_d * 0.46
	up.gable_roof_x(X0 - ov, X1 + ov, (Z0 + Z1) * 0.5, half_d, H + 0.05, rise, roof, maxi(6, int(half_d * 2.0)))
	# 山墙：东西两端各一个三角（灰泥）+ 木梁 + 小圆窗
	var rise_w: float = rise * ((Z1 - Z0) * 0.5) / half_d
	var zm: float = (Z0 + Z1) * 0.5
	up.tri(Vector3(X0, H + 0.1, Z1), Vector3(X0, H + 0.1, Z0), Vector3(X0, H + 0.05 + rise_w, zm), _mul(plaster, 0.97))
	up.tri(Vector3(X1, H + 0.1, Z0), Vector3(X1, H + 0.1, Z1), Vector3(X1, H + 0.05 + rise_w, zm), _mul(plaster, 0.97))
	# 山墙内侧的暗面（从内部看）
	up.tri(Vector3(X0 + 0.01, H + 0.1, Z0), Vector3(X0 + 0.01, H + 0.1, Z1), Vector3(X0 + 0.01, H + 0.05 + rise_w, zm), _mul(plaster, 0.8))
	up.tri(Vector3(X1 - 0.01, H + 0.1, Z1), Vector3(X1 - 0.01, H + 0.1, Z0), Vector3(X1 - 0.01, H + 0.05 + rise_w, zm), _mul(plaster, 0.8))
	for xe in [X0 - 0.04, X1 - 0.02]:
		up.block(xe, xe + 0.06, H + 0.1, H + 0.2, Z0, Z1, TIMBER_D, 1.0, "unsew")
		up.block(xe, xe + 0.06, H + 0.1, H + 0.05 + rise_w, zm - 0.07, zm + 0.07, TIMBER_D, 1.0, "unsew")
		up.block(xe, xe + 0.06, H + 0.55, H + 1.05, zm - 0.28, zm + 0.28, GLASS, 1.0, "unsew", 0.8)
	glows.append({"pos": Vector3(X0 - 0.2, H + 0.8, zm), "size": 1.5, "strength": 0.4})
	glows.append({"pos": Vector3(X1 + 0.2, H + 0.8, zm), "size": 1.5, "strength": 0.4})
	# 烟囱
	if bool(st.get("chimney", false)):
		var cx: float = X1 - 2.2
		up.block(cx - 0.4, cx + 0.4, H + 0.5, H + rise + 1.4, zm - 0.95, zm - 0.15, _c(0.72, 0.56, 0.48), 1.0)
		up.block(cx - 0.5, cx + 0.5, H + rise + 1.4, H + rise + 1.6, zm - 1.05, zm - 0.05, _c(0.55, 0.45, 0.42), 1.0)
	# 墙面的木横梁装饰（山墙下沿、东西墙）
	var aabb := AABB(Vector3(X0 - ov, lowh, Z0 - ov), Vector3(X1 - X0 + 2.0 * ov, H + rise + 1.7 - lowh, Z1 - Z0 + 2.0 * ov))
	return {"shell": shell, "up": up, "interior": interior, "glows": glows, "up_aabb": aabb, "outer": Rect2(X0, Z0, X1 - X0, Z1 - Z0), "H": H, "inner_wall": inner_wall}


static func shell_append(dst: TMB, src: TMB, xf: Transform3D) -> void:
	var base: int = dst.v.size()
	for i in range(src.v.size()):
		dst.v.append(xf * src.v[i])
		dst.n.append((xf.basis * src.n[i]).normalized())
		dst.c.append(src.c[i])
		dst.uv.append(src.uv[i])
	for k in src.ix:
		dst.ix.append(base + k)


static func up_or_shell_sill(shell: TMB, x0: float, x1: float, za: float, zb: float, g0: float, g1: float) -> void:
	if is_nan(g0):
		shell.block(x0, x1, 0.0, 0.14, za, zb, STONE_D, 0.8, "unsew")
	else:
		shell.block(x0, g0 - 0.14, 0.0, 0.14, za, zb, STONE_D, 0.8, "unsew")
		shell.block(g1 + 0.14, x1, 0.0, 0.14, za, zb, STONE_D, 0.8, "unsew")


## 沿 x 的一面墙（z0..z1 是墙的厚度范围）。out_north：外层在 z 小的一侧。gap0/gap1：门洞（NAN = 没有）。
## 下半（0..split）画进 lo，上半画进 hi（lo 和 hi 是同一个 TMB 就不分）。
static func _wall_x(lo: TMB, hi: TMB, x0: float, x1: float, z0: float, z1: float, y0: float, y1: float, outer: Color, inner_c: Color, wains: Color, out_north: bool, gap0: float, gap1: float, split: float = -1.0) -> void:
	var zm: float = (z0 + z1) * 0.5
	var segs: Array = []
	if is_nan(gap0):
		segs.append([x0, x1])
	else:
		segs.append([x0, gap0])
		segs.append([gap1, x1])
	var za: float = z0 if out_north else zm  # 外层
	var zb: float = zm if out_north else z1
	var zi0: float = zm if out_north else z0   # 内层
	var zi1: float = z1 if out_north else zm
	for s in segs:
		var xa: float = s[0]
		var xb: float = s[1]
		var cut: float = split if split > 0.0 else y1
		lo.block(xa, xb, y0, cut, za, zb, outer, 0.82, "unsew")
		lo.block(xa, xb, y0, cut, zi0, zi1, inner_c, 0.9, "unsew")
		if out_north:
			lo.block(xa, xb, y0, minf(cut, 0.9), zi0, zi1 + 0.03, wains, 0.9, "unsw")
		else:
			lo.block(xa, xb, y0, minf(cut, 0.9), zi0 - 0.03, zi1, wains, 0.9, "unse")
		if split > 0.0:
			hi.block(xa, xb, split, y1, za, zb, outer, 1.0, "unsew")
			hi.block(xa, xb, split, y1, zi0, zi1, inner_c, 1.0, "unsew")


static func _wall_z(b: TMB, x0: float, x1: float, z0: float, z1: float, y0: float, y1: float, outer: Color, inner_c: Color, wains: Color, out_first: bool) -> void:
	var xm: float = (x0 + x1) * 0.5
	var xa0: float = x0 if out_first else xm
	var xa1: float = xm if out_first else x1
	var xi0: float = xm if out_first else x0
	var xi1: float = x1 if out_first else xm
	b.block(xa0, xa1, y0, y1, z0, z1, outer, 0.82, "unsew")
	b.block(xi0, xi1, y0, y1, z0, z1, inner_c, 0.9, "unsew")
	if out_first:
		b.block(xi0, xi1 + 0.03, y0, 0.9, z0, z1, wains, 0.9, "unsew")
	else:
		b.block(xi0 - 0.03, xi1, y0, 0.9, z0, z1, wains, 0.9, "unsew")


## 窗：框、玻璃（发光）、十字窗棂、窗台、两侧百叶（accent 色）。z 是墙外皮的位置，窗朝 +z。
static func _window(b: TMB, c: Vector3, w: float, h: float, accent: Color, shutters: bool) -> void:
	b.block(c.x - w * 0.5 - 0.08, c.x + w * 0.5 + 0.08, c.y - h * 0.5 - 0.08, c.y + h * 0.5 + 0.08, c.z - 0.03, c.z + 0.06, TIMBER_D, 1.0, "unsew")
	b.block(c.x - w * 0.5, c.x + w * 0.5, c.y - h * 0.5, c.y + h * 0.5, c.z + 0.04, c.z + 0.07, GLASS, 1.0, "unsew", 0.9)
	b.block(c.x - 0.025, c.x + 0.025, c.y - h * 0.5, c.y + h * 0.5, c.z + 0.07, c.z + 0.1, TIMBER_D, 1.0, "unsew")
	b.block(c.x - w * 0.5, c.x + w * 0.5, c.y - 0.025, c.y + 0.025, c.z + 0.07, c.z + 0.1, TIMBER_D, 1.0, "unsew")
	b.block(c.x - w * 0.5 - 0.14, c.x + w * 0.5 + 0.14, c.y - h * 0.5 - 0.14, c.y - h * 0.5 - 0.05, c.z - 0.02, c.z + 0.2, TIMBER, 1.0, "unsew")
	if shutters:
		for sx in [-1.0, 1.0]:
			var xs: float = c.x + sx * (w * 0.5 + 0.28)
			b.block(xs - 0.2, xs + 0.2, c.y - h * 0.5 - 0.04, c.y + h * 0.5 + 0.04, c.z - 0.01, c.z + 0.06, accent, 1.0, "unsew")
			for k in range(4):
				var yy: float = c.y - h * 0.5 + 0.12 + float(k) * h * 0.25
				b.block(xs - 0.17, xs + 0.17, yy, yy + 0.03, c.z + 0.06, c.z + 0.075, _mul(accent, 0.82), 1.0, "unsew")


## 招牌上的小图标（正面朝 sgn 方向的 z）。
static func _sign_icon(b: TMB, sign: String, c: Vector3, sgn: float) -> void:
	var z: float = c.z + sgn * 0.05
	if sign == "tea":
		b.cyl(Vector3(c.x, c.y - 0.16, z), 0.2, 0.17, 0.2, CREAM, 8)
		b.block(c.x + 0.18, c.x + 0.3, c.y - 0.08, c.y + 0.0, z - 0.03, z + 0.03, CREAM, 1.0, "unsew")
		b.block(c.x - 0.03, c.x + 0.03, c.y + 0.07, c.y + 0.2, z - 0.02, z + 0.02, CREAM, 1.0, "unsew")
	elif sign == "book":
		b.block(c.x - 0.32, c.x - 0.02, c.y - 0.15, c.y + 0.15, z - 0.02, z + 0.02, CREAM, 1.0, "unsew")
		b.block(c.x + 0.02, c.x + 0.32, c.y - 0.15, c.y + 0.15, z - 0.02, z + 0.02, _mul(CREAM, 0.9), 1.0, "unsew")
	elif sign == "kitchen":
		b.cyl(Vector3(c.x, c.y - 0.15, z), 0.18, 0.2, 0.22, CREAM, 8)
		b.block(c.x - 0.3, c.x + 0.3, c.y + 0.03, c.y + 0.07, z - 0.02, z + 0.02, CREAM, 1.0, "unsew")
		b.block(c.x - 0.1, c.x - 0.04, c.y + 0.1, c.y + 0.22, z - 0.02, z + 0.02, LANTERN, 1.0, "unsew", 0.6)
		b.block(c.x + 0.04, c.x + 0.1, c.y + 0.1, c.y + 0.26, z - 0.02, z + 0.02, LANTERN, 1.0, "unsew", 0.6)
	elif sign == "arcade":
		b.block(c.x - 0.18, c.x + 0.18, c.y - 0.18, c.y + 0.18, z - 0.04, z + 0.04, CREAM, 1.0, "unsew")
		for dxy in [[-0.08, 0.08], [0.08, -0.08], [0.0, 0.0]]:
			b.block(c.x + dxy[0] - 0.03, c.x + dxy[0] + 0.03, c.y + dxy[1] - 0.03, c.y + dxy[1] + 0.03, z + sgn * 0.03, z + sgn * 0.05, _c(0.3, 0.3, 0.34), 1.0, "unsew")


## 灯巷会馆：门脸朝东（+x）的长条建筑，主体延伸到地图西边界以外（视觉上更像一栋大房子）。
## p：front_x（门脸所在 x）、z0 z1（沿门脸的长度）、door_z（门中心）、depth（向西延伸多深）、h
static func build_hall(p: Dictionary) -> Dictionary:
	var fx: float = float(p["front_x"])
	var z0: float = float(p["z0"])
	var z1: float = float(p["z1"])
	var dz: float = float(p["door_z"])
	var depth: float = float(p.get("depth", 7.0))
	var H: float = float(p.get("h", 3.4))
	var shell := TMB.new()
	var up := TMB.new()
	var glows: Array = []
	var plaster := _c(0.95, 0.88, 0.80)
	var roof := _c(0.44, 0.50, 0.62)
	var accent := _c(0.62, 0.30, 0.28)
	var xw: float = fx - depth
	# 门脸（东面）：下半 shell，上半 up
	var lowh: float = 0.85
	# 墙体：整块（东西向的厚墙），门洞居中
	var dw: float = 1.6
	for seg in [[z0, dz - dw * 0.5], [dz + dw * 0.5, z1]]:
		shell.block(xw, fx, 0.0, lowh, seg[0], seg[1], plaster, 0.82, "unsew")
		up.block(xw, fx, lowh, H, seg[0], seg[1], plaster, 1.0, "unsew")
	shell.block(xw, fx, 0.0, 2.35, z0 - 0.0, z0 + 0.2, plaster, 0.82, "unsew")
	up.block(xw, fx, 2.35, H, dz - dw * 0.5, dz + dw * 0.5, plaster, 1.0, "unsew")
	# 北、南山墙面（朝 +z 的南墙在镜头里能看到）
	shell.block(xw, fx, 0.0, H, z1 - 0.0, z1 + 0.0, plaster, 0.82, "unsew")
	# 立柱、横梁、门框
	for z in [z0 + 0.1, z1 - 0.1, dz - dw * 0.5 - 0.1, dz + dw * 0.5 + 0.1]:
		shell.block(fx - 0.12, fx + 0.14, 0.0, lowh, z - 0.12, z + 0.12, TIMBER, 0.85, "unsew")
		up.block(fx - 0.12, fx + 0.14, lowh, H, z - 0.12, z + 0.12, TIMBER, 1.0, "unsew")
	up.block(fx - 0.1, fx + 0.2, H - 0.25, H + 0.05, z0 - 0.1, z1 + 0.1, TIMBER_D, 1.0, "unsew")
	shell.block(fx - 0.1, fx + 0.16, 2.35, 2.6, dz - dw * 0.5 - 0.14, dz + dw * 0.5 + 0.14, TIMBER_D, 1.0, "unsew")
	# 门：双扇红门（半开）
	for sgn in [-1.0, 1.0]:
		up.block(fx + 0.02, fx + 0.1, 0.0, 2.3, dz + sgn * dw * 0.5 - 0.0 - (0.0 if sgn > 0 else 0.0) - 0.0, dz + sgn * (dw * 0.5 - 0.5), accent, 0.9, "unsew")
	# 窗
	for z in [z0 + 1.6, z1 - 1.6]:
		_window_x(up, Vector3(fx + 0.04, 1.75, z), 1.1, 1.0, accent)
		glows.append({"pos": Vector3(fx + 0.4, 1.75, z), "size": 2.2, "strength": 0.5})
	# 屋顶：脊线平行于 x（东西），南北两坡，山墙在东西两端；东端山墙冲着街，但门脸在东面——所以让脊线平行于 z，东西两坡
	var ov: float = 0.7
	var half_w: float = depth * 0.5 + ov
	var rise: float = half_w * 0.42
	up.gable_roof_z(z0 - ov, z1 + ov, (xw + fx) * 0.5, half_w, H + 0.05, rise, roof, 8)
	# 南端山墙三角（朝 +z）
	var rise_w: float = rise * (depth * 0.5) / half_w
	var xm: float = (xw + fx) * 0.5
	up.tri(Vector3(xw, H + 0.1, z1), Vector3(fx, H + 0.1, z1), Vector3(xm, H + 0.05 + rise_w, z1), _mul(plaster, 0.97))
	up.tri(Vector3(fx, H + 0.1, z0), Vector3(xw, H + 0.1, z0), Vector3(xm, H + 0.05 + rise_w, z0), _mul(plaster, 0.97))
	up.block(xm - 0.3, xm + 0.3, H + 0.6, H + 1.1, z1 - 0.02, z1 + 0.06, GLASS, 1.0, "unsew", 0.8)
	# 门前台阶 + 门灯（东面）
	shell.block(fx, fx + 0.5, 0.0, 0.12, dz - 1.1, dz + 1.1, STONE, 0.9)
	for sz in [dz - 1.3, dz + 1.3]:
		var lt := TMB.new()
		build_paper_lantern(lt)
		shell_append(up, lt, Transform3D(Basis(), Vector3(fx + 0.35, 2.0, sz)))
		glows.append({"pos": Vector3(fx + 0.5, 2.2, sz), "size": 1.9, "strength": 0.9})
	# 招牌（门楣上）
	up.block(fx + 0.14, fx + 0.22, 2.75, 3.25, dz - 0.9, dz + 0.9, _c(0.30, 0.38, 0.52), 1.0, "unsew")
	up.block(fx + 0.22, fx + 0.26, 2.9, 3.1, dz - 0.5, dz + 0.5, CREAM, 1.0, "unsew")
	# 一排信箱（门脸南侧，z 贴墙）
	var aabb := AABB(Vector3(xw - ov, lowh, z0 - ov), Vector3(depth + 2.0 * ov, H + rise + 0.5 - lowh, z1 - z0 + 2.0 * ov))
	return {"shell": shell, "up": up, "interior": TMB.new(), "glows": glows, "up_aabb": aabb, "outer": Rect2(xw, z0, depth, z1 - z0), "H": H}


static func _window_x(b: TMB, c: Vector3, w: float, h: float, accent: Color) -> void:
	# 朝 +x 的窗（会馆门脸）
	b.block(c.x - 0.03, c.x + 0.06, c.y - h * 0.5 - 0.08, c.y + h * 0.5 + 0.08, c.z - w * 0.5 - 0.08, c.z + w * 0.5 + 0.08, TIMBER_D, 1.0, "unsew")
	b.block(c.x + 0.04, c.x + 0.07, c.y - h * 0.5, c.y + h * 0.5, c.z - w * 0.5, c.z + w * 0.5, GLASS, 1.0, "unsew", 0.9)
	b.block(c.x + 0.07, c.x + 0.1, c.y - h * 0.5, c.y + h * 0.5, c.z - 0.025, c.z + 0.025, TIMBER_D, 1.0, "unsew")
	b.block(c.x + 0.07, c.x + 0.1, c.y - 0.025, c.y + 0.025, c.z - w * 0.5, c.z + w * 0.5, TIMBER_D, 1.0, "unsew")
	b.block(c.x - 0.02, c.x + 0.2, c.y - h * 0.5 - 0.14, c.y - h * 0.5 - 0.05, c.z - w * 0.5 - 0.14, c.z + w * 0.5 + 0.14, TIMBER, 1.0, "unsew")
	for sz in [-1.0, 1.0]:
		var zs: float = c.z + sz * (w * 0.5 + 0.28)
		b.block(c.x - 0.01, c.x + 0.06, c.y - h * 0.5 - 0.04, c.y + h * 0.5 + 0.04, zs - 0.2, zs + 0.2, accent, 1.0, "unsew")
