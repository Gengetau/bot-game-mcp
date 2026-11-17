extends RefCounted
## 头顶气泡的排版：纯函数，不读场景、不取时间、不用随机数，所以能在无头 Godot 里单测（client/tests/bubble_layout_test.gd）。
## 所有长度都是 CSS 像素（调用方把画布物理像素除以 devicePixelRatio 再传进来）：气泡的尺寸、抬高量（bubbles.css 的 margin-top）都是 CSS 的。
## 做三件事：
##  1. 估算气泡与名牌的屏幕矩形（按字数、字号 13px、最大宽 min(60vw, 220px) 估，宁大勿小）；
##  2. 按「屏幕上更靠下（离镜头近）的人先放」的顺序，每个气泡往上抬到不压住已放好的气泡、也不压住别人的名牌（名牌层级高于气泡，hud.js 设的行内 z-index，样式表压不过）；
##  3. 抬不到屏幕可用区域里（顶栏之下）就不放。
## 抬高量只是目标值；调用方用 ease_toward 平滑，人走动、前一个气泡过期时不会一帧跳 36 像素。

const RAISE := 26.0  # bubbles.css 的 margin-top：气泡底边比锚点高这么多（名牌之上）
const TAIL := 5.0  # 小三角高度
const GAP := 2.0  # 气泡与障碍之间留的缝
const PAD_X := 20.0  # 左右 padding 9 + 边框 1，各一边
const PAD_Y := 8.0  # 上下 padding 3 + 边框 1，各一边
const LINE_H := 17.55  # 13px 字号 × 行高 1.35
const CJK_W := 13.0
const LATIN_W := 7.5
const MAX_W := 220.0
const NAME_H := 22.0  # 名牌高度（含内边距）
const NAME_PAD := 20.0
const NAME_SELF_EXTRA := 30.0  # 自己的名牌后面多一个「 · 你」
const EDGE := 2.0


static func _text_w(s: String) -> float:
	var w: float = 0.0
	for i in range(s.length()):
		w += CJK_W if s.unicode_at(i) > 0x2E7F else LATIN_W
	return w


## 气泡的估算尺寸（宽, 高），不含小三角
static func bubble_size(text: String, view_w: float) -> Vector2:
	var maxw: float = minf(view_w * 0.6, MAX_W)
	var tw: float = _text_w(text)
	var w: float = clampf(tw + PAD_X, 30.0, maxw)
	var lines: int = maxi(1, int(ceil(tw / maxf(1.0, maxw - PAD_X))))
	return Vector2(w, lines * LINE_H + PAD_Y)


static func name_width(name: String, is_self: bool) -> float:
	return _text_w(name) + NAME_PAD + (NAME_SELF_EXTRA if is_self else 0.0)


## 平滑：指数趋近，差不多到了就吸附到目标（不留永远追不上的尾巴，也让 tags 的 JSON 能稳定下来）
static func ease_toward(cur: float, target: float, dt: float) -> float:
	var k: float = 1.0 - exp(-maxf(0.0, dt) / 0.1)
	var v: float = cur + (target - cur) * k
	if absf(target - v) < 0.5:
		return target
	return v


## 矩形：x0 x1 y0 y1（y1 在下）
static func _rect(cx: float, bottom: float, w: float, h: float) -> Array:
	return [cx - w * 0.5, cx + w * 0.5, bottom - h, bottom]


static func _hit(a: Array, b: Array) -> bool:
	return a[0] < b[1] and b[0] < a[1] and a[2] < b[3] and b[2] < a[3]


## 排版。
## items: [{id, x, y, w, h}]，(x, y) 是该说话人头顶锚点的屏幕位置（CSS 像素），w、h 是气泡估算尺寸；
## tags: [{id, x, y, w}]，名牌：(x, y) 是名牌底边中点；障碍里不含和气泡同 id 的那一块（自己的名牌已被 RAISE 躲开）；
## view_w：可用宽度；top_safe：气泡可见部分的上沿不许高于它（顶栏之下）。
## 返回 {id: 抬高量 | null}；null 表示这一帧没有放得下的位置，不要画。
static func layout(items: Array, tags: Array, view_w: float, top_safe: float) -> Dictionary:
	var order: Array = items.duplicate()
	order.sort_custom(func(a, b):
		if a["y"] != b["y"]:
			return a["y"] > b["y"]  # 屏幕上更靠下（离镜头近）的先放，靠上的往上让
		return str(a["id"]) < str(b["id"]))
	var tag_rects: Array = []
	for t in tags:
		tag_rects.append({"id": str(t["id"]), "r": [t["x"] - t["w"] * 0.5, t["x"] + t["w"] * 0.5, t["y"] - NAME_H, t["y"]]})
	var placed: Array = []
	var out: Dictionary = {}
	for it in order:
		var w: float = it["w"]
		var h: float = it["h"]
		var cx: float = clampf(it["x"], w * 0.5 + EDGE, maxf(w * 0.5 + EDGE, view_w - w * 0.5 - EDGE))  # hud.js 会把牌钳进屏幕左右边缘
		var lift: float = 0.0
		for _n in range(24):
			var r: Array = _rect(cx, it["y"] - RAISE - lift + TAIL, w, h + TAIL)
			var need: float = lift
			var hit: bool = false
			for p in placed:
				if _hit(r, p):
					hit = true
					need = maxf(need, it["y"] - RAISE + TAIL - (p[2] - GAP))
			for tr in tag_rects:
				if tr["id"] != str(it["id"]) and _hit(r, tr["r"]):
					hit = true
					need = maxf(need, it["y"] - RAISE + TAIL - (tr["r"][2] - GAP))
			if not hit or need <= lift:
				break
			lift = need
		var fin: Array = _rect(cx, it["y"] - RAISE - lift + TAIL, w, h + TAIL)
		if fin[2] < top_safe:
			out[it["id"]] = null
			continue
		out[it["id"]] = lift
		placed.append(fin)
	return out
