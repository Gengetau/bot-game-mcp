class_name TMB
extends RefCounted
## 程序生成的低多边形几何体：方块、柱、屋顶、球冠……全部平面着色（每个面独立法线），颜色放顶点色，UV 指向色板贴图左上角的纯白块。
## 顶点色的 alpha 是发光遮罩（见 town.gdshader）：alpha < 1 的顶点夜里发暖光。
## 约定：quad(a, b, c, d) 的四个点从外面看是逆时针，法线朝外；内部转成 Godot 的顺时针正面。

const WHITE_UV := Vector2(0.015, 0.015)

var v := PackedVector3Array()
var n := PackedVector3Array()
var c := PackedColorArray()
var uv := PackedVector2Array()
var ix := PackedInt32Array()
var jitter: float = 0.04  # 每个面的明暗随机幅度，免得大片平涂


static func hash3(p: Vector3) -> float:
	var h: float = sin(p.x * 12.9898 + p.y * 78.233 + p.z * 37.719) * 43758.5453
	return h - floor(h)


func is_empty() -> bool:
	return v.is_empty()


## 一个四边形。cols 可以是 1 个颜色，也可以是 4 个（逐顶点）。
func quad(a: Vector3, b: Vector3, cc: Vector3, d: Vector3, col: Color, cols: Array = []) -> void:
	var nrm: Vector3 = (b - a).cross(cc - a).normalized()
	if nrm.length() < 0.5:
		nrm = (cc - a).cross(d - a).normalized()
	var k: float = 1.0 + (hash3(a + cc) - 0.5) * 2.0 * jitter
	var base: int = v.size()
	var pts := [a, b, cc, d]
	for i in range(4):
		v.append(pts[i])
		n.append(nrm)
		var cl: Color = cols[i] if cols.size() == 4 else col
		c.append(Color(cl.r * k, cl.g * k, cl.b * k, cl.a))
		uv.append(WHITE_UV)
	# 顺时针正面：a, c, b 和 a, d, c
	ix.append_array([base, base + 2, base + 1, base, base + 3, base + 2])


func tri(a: Vector3, b: Vector3, cc: Vector3, col: Color) -> void:
	var nrm: Vector3 = (b - a).cross(cc - a).normalized()
	var k: float = 1.0 + (hash3(a + cc) - 0.5) * 2.0 * jitter
	var base: int = v.size()
	for p in [a, b, cc]:
		v.append(p)
		n.append(nrm)
		c.append(Color(col.r * k, col.g * k, col.b * k, col.a))
		uv.append(WHITE_UV)
	ix.append_array([base, base + 2, base + 1])


## 轴对齐方块（中心 + 尺寸），可绕 y 轴转 yaw（弧度，绕方块中心）。bottom_dark：四周的墙脚压暗系数（1 = 不压暗）。
## sides：要不要画的面 "u"（上）"d"（下）"n" "s" "e" "w"；默认画 u + 四周，不画下面。
func box(center: Vector3, size: Vector3, col: Color, yaw: float = 0.0, bottom_dark: float = 1.0, sides: String = "unsew", glow: float = 0.0) -> void:
	var hx: float = size.x * 0.5
	var hy: float = size.y * 0.5
	var hz: float = size.z * 0.5
	var xf := Transform3D(Basis(Vector3.UP, yaw), center)
	var p := func(x: float, y: float, z: float) -> Vector3: return xf * Vector3(x, y, z)
	var a: float = 1.0 - glow
	var top := Color(col.r, col.g, col.b, a)
	var low := Color(col.r * bottom_dark, col.g * bottom_dark, col.b * bottom_dark, a)
	if sides.contains("u"):
		quad(p.call(-hx, hy, hz), p.call(hx, hy, hz), p.call(hx, hy, -hz), p.call(-hx, hy, -hz), Color(col.r * 1.04, col.g * 1.04, col.b * 1.04, a))
	if sides.contains("d"):
		quad(p.call(-hx, -hy, -hz), p.call(hx, -hy, -hz), p.call(hx, -hy, hz), p.call(-hx, -hy, hz), low)
	if sides.contains("s"):  # +z
		quad(p.call(-hx, -hy, hz), p.call(hx, -hy, hz), p.call(hx, hy, hz), p.call(-hx, hy, hz), col, [low, low, top, top])
	if sides.contains("n"):  # -z
		quad(p.call(hx, -hy, -hz), p.call(-hx, -hy, -hz), p.call(-hx, hy, -hz), p.call(hx, hy, -hz), col, [low, low, top, top])
	if sides.contains("e"):  # +x
		quad(p.call(hx, -hy, hz), p.call(hx, -hy, -hz), p.call(hx, hy, -hz), p.call(hx, hy, hz), col, [low, low, top, top])
	if sides.contains("w"):  # -x
		quad(p.call(-hx, -hy, -hz), p.call(-hx, -hy, hz), p.call(-hx, hy, hz), p.call(-hx, hy, -hz), col, [low, low, top, top])


## 以 (x0..x1, z0..z1) 为底、y0..y1 为高的方块（常用于墙）。
func block(x0: float, x1: float, y0: float, y1: float, z0: float, z1: float, col: Color, bottom_dark: float = 1.0, sides: String = "unsew", glow: float = 0.0) -> void:
	box(Vector3((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5), Vector3(x1 - x0, y1 - y0, z1 - z0), col, 0.0, bottom_dark, sides, glow)


## 竖直圆柱 / 圆锥台（中心底面 + 半径），seg 边。top_r = 0 时是圆锥。
func cyl(base: Vector3, h: float, r_bot: float, r_top: float, col: Color, seg: int = 8, glow: float = 0.0, cap: bool = true) -> void:
	var a: float = 1.0 - glow
	for i in range(seg):
		var a0: float = TAU * float(i) / float(seg)
		var a1: float = TAU * float(i + 1) / float(seg)
		var b0 := base + Vector3(cos(a0) * r_bot, 0, sin(a0) * r_bot)
		var b1 := base + Vector3(cos(a1) * r_bot, 0, sin(a1) * r_bot)
		var t0 := base + Vector3(cos(a0) * r_top, h, sin(a0) * r_top)
		var t1 := base + Vector3(cos(a1) * r_top, h, sin(a1) * r_top)
		var low := Color(col.r * 0.9, col.g * 0.9, col.b * 0.9, a)
		var hi := Color(col.r, col.g, col.b, a)
		# 外面看逆时针：b1, b0, t0, t1（从外往里看，角度增大是逆时针）
		quad(b1, b0, t0, t1, col, [low, low, hi, hi])
		if cap and r_top > 0.001:
			tri(base + Vector3(0, h, 0), t1, t0, Color(col.r * 1.05, col.g * 1.05, col.b * 1.05, a))


## 低多边形球冠（树冠、灌木）：以 center 为球心，分 seg x rings，上半球 + 一点下半球。flat 把 y 方向压扁。
func blob(center: Vector3, r: float, col: Color, seg: int = 7, rings: int = 4, squash: float = 0.85, tint_top: float = 1.08, tint_bot: float = 0.82, seed: float = 0.0) -> void:
	var pts: Array = []
	for j in range(rings + 1):
		var phi: float = PI * float(j) / float(rings)  # 0 = 顶
		var row: Array = []
		for i in range(seg):
			var th: float = TAU * (float(i) + 0.5 * float(j % 2)) / float(seg)
			var rr: float = r * (1.0 + 0.10 * (hash3(Vector3(float(i), float(j), seed)) - 0.5))
			row.append(center + Vector3(sin(phi) * cos(th) * rr, cos(phi) * rr * squash, sin(phi) * sin(th) * rr))
		pts.append(row)
	for j in range(rings):
		for i in range(seg):
			var i2: int = (i + 1) % seg
			var a: Vector3 = pts[j][i]
			var b: Vector3 = pts[j][i2]
			var cc: Vector3 = pts[j + 1][i2]
			var d: Vector3 = pts[j + 1][i]
			var mid: float = clampf(1.0 - float(j) / float(rings), 0.0, 1.0)
			var k: float = lerpf(tint_bot, tint_top, mid)
			var col2 := Color(col.r * k, col.g * k, col.b * k, 1.0)
			if j == 0:
				tri(a, cc, d, col2)
			elif j == rings - 1:
				tri(a, b, d, col2)  # 底部三角
			else:
				quad(a, b, cc, d, col2)


## 沿 x 方向的山形屋顶（脊线平行于 x）。x0..x1 是屋檐的水平范围，z_mid 是脊线的 z，half_d 是（含出檐）半进深，
## y_eave 是檐口高度，rise 是脊高。rows：每个坡面分几排瓦。返回 void，顶面按排交替明暗。
func gable_roof_x(x0: float, x1: float, z_mid: float, half_d: float, y_eave: float, rise: float, col: Color, rows: int = 8, thick: float = 0.14) -> void:
	for sgn in [1.0, -1.0]:
		for r in range(rows):
			var t0: float = float(r) / float(rows)
			var t1: float = float(r + 1) / float(rows)
			var za: float = z_mid + sgn * half_d * (1.0 - t0)
			var zb: float = z_mid + sgn * half_d * (1.0 - t1)
			var ya: float = y_eave + rise * t0
			var yb: float = y_eave + rise * t1
			var k: float = 0.94 if r % 2 == 0 else 1.04
			var cc := Color(col.r * k, col.g * k, col.b * k, 1.0)
			if sgn > 0.0:
				quad(Vector3(x0, ya, za), Vector3(x1, ya, za), Vector3(x1, yb, zb), Vector3(x0, yb, zb), cc)
			else:
				quad(Vector3(x1, ya, za), Vector3(x0, ya, za), Vector3(x0, yb, zb), Vector3(x1, yb, zb), cc)
		# 屋檐的厚度：前缘一条竖面 + 下面
		var ze: float = z_mid + sgn * half_d
		var edge := Color(col.r * 0.62, col.g * 0.6, col.b * 0.58, 1.0)
		if sgn > 0.0:
			quad(Vector3(x0, y_eave - thick, ze), Vector3(x1, y_eave - thick, ze), Vector3(x1, y_eave, ze), Vector3(x0, y_eave, ze), edge)
		else:
			quad(Vector3(x1, y_eave - thick, ze), Vector3(x0, y_eave - thick, ze), Vector3(x0, y_eave, ze), Vector3(x1, y_eave, ze), edge)
	# 脊瓦
	block(x0 - 0.1, x1 + 0.1, y_eave + rise - 0.02, y_eave + rise + 0.18, z_mid - 0.22, z_mid + 0.22, Color(col.r * 0.82, col.g * 0.82, col.b * 0.85, 1.0))
	# 两端山墙下的遮檐（封住屋顶底面，从下面看不到空洞）
	for xe in [x0, x1]:
		var out: float = 1.0 if xe == x1 else -1.0
		var edge2 := Color(col.r * 0.55, col.g * 0.52, col.b * 0.52, 1.0)
		# 山墙檐板（沿坡的细板）
		for sgn in [1.0, -1.0]:
			var pa := Vector3(xe, y_eave, z_mid + sgn * half_d)
			var pb := Vector3(xe, y_eave + rise, z_mid)
			var pc := Vector3(xe + out * 0.1, y_eave + rise, z_mid)
			var pd := Vector3(xe + out * 0.1, y_eave, z_mid + sgn * half_d)
			if (out * sgn) > 0.0:
				quad(pa, pd, pc, pb, edge2)
			else:
				quad(pa, pb, pc, pd, edge2)


## 沿 z 方向的山形屋顶（脊线平行于 z）。同上，轴互换。
func gable_roof_z(z0: float, z1: float, x_mid: float, half_w: float, y_eave: float, rise: float, col: Color, rows: int = 8, thick: float = 0.14) -> void:
	for sgn in [1.0, -1.0]:
		for r in range(rows):
			var t0: float = float(r) / float(rows)
			var t1: float = float(r + 1) / float(rows)
			var xa: float = x_mid + sgn * half_w * (1.0 - t0)
			var xb: float = x_mid + sgn * half_w * (1.0 - t1)
			var ya: float = y_eave + rise * t0
			var yb: float = y_eave + rise * t1
			var k: float = 0.94 if r % 2 == 0 else 1.04
			var cc := Color(col.r * k, col.g * k, col.b * k, 1.0)
			if sgn > 0.0:
				quad(Vector3(xa, ya, z1), Vector3(xa, ya, z0), Vector3(xb, yb, z0), Vector3(xb, yb, z1), cc)
			else:
				quad(Vector3(xa, ya, z0), Vector3(xa, ya, z1), Vector3(xb, yb, z1), Vector3(xb, yb, z0), cc)
		var xe: float = x_mid + sgn * half_w
		var edge := Color(col.r * 0.62, col.g * 0.6, col.b * 0.58, 1.0)
		if sgn > 0.0:
			quad(Vector3(xe, y_eave - thick, z0), Vector3(xe, y_eave - thick, z1), Vector3(xe, y_eave, z1), Vector3(xe, y_eave, z0), edge)
		else:
			quad(Vector3(xe, y_eave - thick, z1), Vector3(xe, y_eave - thick, z0), Vector3(xe, y_eave, z0), Vector3(xe, y_eave, z1), edge)
	block(x_mid - 0.22, x_mid + 0.22, y_eave + rise - 0.02, y_eave + rise + 0.18, z0 - 0.1, z1 + 0.1, Color(col.r * 0.82, col.g * 0.82, col.b * 0.85, 1.0))


func to_mesh() -> ArrayMesh:
	var m := ArrayMesh.new()
	if v.is_empty():
		return m
	var arr: Array = []
	arr.resize(Mesh.ARRAY_MAX)
	arr[Mesh.ARRAY_VERTEX] = v
	arr[Mesh.ARRAY_NORMAL] = n
	arr[Mesh.ARRAY_COLOR] = c
	arr[Mesh.ARRAY_TEX_UV] = uv
	arr[Mesh.ARRAY_INDEX] = ix
	m.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
	return m
