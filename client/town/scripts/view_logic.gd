class_name ViewLogic
extends RefCounted
## 镜头给面板让位（V1 第一项）的纯函数：不读场景、不取时间、不用随机数，能在无头 Godot 里单测（client/tests/view_logic_test.gd）。
## 网页层（layout.js）算出「没被界面盖住的那块」，归一化后发来；这里换成「自己的角色该投影在屏幕哪一点」，
## 再换成「镜头注视点要比角色的位置偏多少」。这个偏移只和镜头朝向、距离、视野、宽高比、目标点有关，镜头整体平移不改变它，所以能直接算。

const MIN_W := 160.0  # 可见区宽不到这么多（CSS 像素）就不追
const MIN_H := 120.0  # 高不到这么多就不追（横屏手机开着软键盘）
const FRAC := 0.55  # 角色落在可见区高度的这一处（从上往下数）：中间偏下一点
const FRAC_SMALL := 0.5  # 可见区矮（手机抽屉开着）时取正中
const SMALL_H := 300.0
const DUR := 0.3  # 目标点缓动的时长（秒）
const SKY := 0.02  # 射线几乎水平 / 朝天时的钳制（目标点太靠上、镜头俯角又浅时不让偏移飞到无穷远）


## rect: {l, t, r, b（0..1，相对整个视口）, w, h（视口的 CSS 像素）}；prev 是原来的目标点。
## 可见区太小就还是 prev（保持上一次的目标点，不追）；消息残缺也不动。
static func target(rect: Dictionary, prev: Vector2) -> Vector2:
	for k in ["l", "t", "r", "b", "w", "h"]:
		if not rect.has(k) or not (rect[k] is float or rect[k] is int):
			return prev
	var w: float = float(rect["w"])
	var h: float = float(rect["h"])
	var fw: float = (float(rect["r"]) - float(rect["l"])) * w
	var fh: float = (float(rect["b"]) - float(rect["t"])) * h
	if w <= 0.0 or h <= 0.0 or fw < MIN_W or fh < MIN_H:
		return prev
	var fr: float = FRAC if fh >= SMALL_H else FRAC_SMALL
	var x: float = (float(rect["l"]) + float(rect["r"])) * 0.5
	var y: float = float(rect["t"]) + (float(rect["b"]) - float(rect["t"])) * fr
	return Vector2(clampf(x, 0.0, 1.0), clampf(y, 0.0, 1.0))


## 缓动：从 from 到 goal，已经过去 elapsed 秒；先快后慢，DUR 秒整到位。
static func eased(from: Vector2, goal: Vector2, elapsed: float) -> Vector2:
	var u: float = clampf(elapsed / DUR, 0.0, 1.0)
	var e: float = 1.0 - pow(1.0 - u, 3.0)
	return from.lerp(goal, e)


## 屏幕点 n（0..1，左上为原点）在地面上的落点，相对于画面正中的落点（世界 x、z）。
## 镜头在 focus + (0, sin 俯角, cos 俯角) * 距离，看向 focus（rig.gd 的摆法）；keep_width 为真时 fov 是水平视野（竖屏），否则是垂直视野。
static func ground_offset(pitch_deg: float, dist: float, fov_deg: float, keep_width: bool, aspect: float, n: Vector2) -> Vector2:
	var p: float = deg_to_rad(pitch_deg)
	var th: float = tan(deg_to_rad(fov_deg) * 0.5)
	var a: float = maxf(aspect, 0.05)
	var tx: float = th if keep_width else th * a
	var ty: float = th / a if keep_width else th
	var xn: float = 2.0 * n.x - 1.0
	var yn: float = 1.0 - 2.0 * n.y
	var sp: float = sin(p)
	var cp: float = cos(p)
	var dx: float = xn * tx
	var dy: float = minf(-sp + yn * ty * cp, -SKY)
	var dz: float = -cp - yn * ty * sp
	var t: float = -(dist * sp) / dy
	return Vector2(dx * t, dist * cp + dz * t)
