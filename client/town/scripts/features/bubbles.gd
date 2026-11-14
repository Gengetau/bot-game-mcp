extends TFeature
## 头顶气泡：听到附近的话（nearby.heard，只在 live 消息时发，自己说的也发）时，在说话人头顶显示一小段，淡出。
## 公屏消息不出气泡（只订阅附近）。气泡是 hud.js 的一块 .tag.b：位置每帧由 tags() 追加，淡出靠先置 sel、过 FADE_MS 再移除；
## 像素抬升（名牌上方）由 bubbles.css 的 margin-top 完成，这里只给世界点。

const MAX_ACTIVE := 6
const STALE_MS := 8000.0  # 断线续传补回来的旧话不冒泡
const FADE_MS := 700.0
const MAX_CHARS := 28
const LIFT_Y := 2.2  # 比名牌的 2.05 略高
const NAME_Y := 2.05  # main._update_tags 里名牌的世界高度
const TOP_SAFE := 60.0  # CSS 像素：气泡可见部分的上沿不许高于它（顶栏之下；顶栏在 hud.css 里约 10 到 54 像素）
const Layout := preload("res://scripts/features/bubble_layout.gd")

var _b: Dictionary = {}  # 说话人编号 -> {text, born, show_ms, lift（正在显示的抬高量，CSS 像素）, lt（上次更新的时刻）}
var _shown: int = 0
var _shown_by: Dictionary = {}  # 说话人编号 -> 累计冒过几次（端到端用它证明「没有给某人冒过气泡」，不受气泡存活时间影响）
var _skipped_stale: int = 0


func _init() -> void:
	id = "bubbles"


func setup() -> void:
	var n = ctx.feature("nearby")
	if n != null:
		n.heard.connect(_on_heard)


func on_leave() -> void:
	_b.clear()


## 「发言人在哪、抬多高」集中在这一个函数里。查不到就不显示。
## C6 接 NPC 时只改这里：NPC 不在 actors 里，在场景快照单独的 npcs 字段，在这里补一个分支返回它的世界点（Vector3）；
## tags() 与 _on_heard() 都只通过它取位置，别处没有「不在 actors 就丢弃」的判断。
func _anchor(speaker: String):
	var a = ctx.actors().get(speaker)
	if a == null:
		return null
	var d: Vector2 = (a as TActor).disp
	return Vector3(d.x, LIFT_Y, d.y)


func _on_heard(m: Dictionary) -> void:
	var speaker: String = str(m.get("from", ""))
	if speaker == "" or _anchor(speaker) == null:
		return
	if ctx.server_now() - float(m.get("at", 0.0)) > STALE_MS:
		_skipped_stale += 1
		return
	var text: String = _squash(str(m.get("text", "")))
	if text == "":
		return
	var n: int = text.length()
	if n > MAX_CHARS:
		text = text.substr(0, MAX_CHARS - 1) + "…"
		n = MAX_CHARS
	var now: float = Time.get_ticks_msec()
	if not _b.has(speaker) and _b.size() >= MAX_ACTIVE:
		var oldest: String = ""
		var oldest_t: float = INF
		for k in _b:
			if float(_b[k]["born"]) < oldest_t:
				oldest_t = float(_b[k]["born"])
				oldest = k
		_b.erase(oldest)
	_b[speaker] = {"text": text, "born": now, "show_ms": clampf(2200.0 + 80.0 * n, 3000.0, 6500.0), "lift": -1.0, "lt": now}
	_shown += 1
	_shown_by[speaker] = int(_shown_by.get(speaker, 0)) + 1


## 压成一行：换行 / 制表符 / 连续空白变成一个空格
func _squash(s: String) -> String:
	var out: String = ""
	var prev_space: bool = false
	for i in range(s.length()):
		var c: String = s[i]
		var sp: bool = c == " " or c == "\n" or c == "\r" or c == "\t"
		if sp:
			if not prev_space:
				out += " "
			prev_space = true
		else:
			out += c
			prev_space = false
	return out.strip_edges()


func tags(cam: Camera3D, size: Vector2, out: Array) -> void:
	if _b.is_empty():
		return  # 常态：零开销
	var now: float = Time.get_ticks_msec()
	# 排版用 CSS 像素（气泡尺寸、抬高量都是 CSS 的）；size 是画布的物理像素，网页端 screen_get_scale() 是 devicePixelRatio
	var dpr: float = maxf(1.0, DisplayServer.screen_get_scale())
	var view_w: float = size.x / dpr
	var gone: Array = []
	var items: Array = []
	var live: Dictionary = {}  # 说话人编号 -> 屏幕点（CSS 像素）
	for k in _b:
		var e: Dictionary = _b[k]
		var age: float = now - float(e["born"])
		if age >= float(e["show_ms"]) + FADE_MS:
			gone.append(k)
			continue
		var wp = _anchor(k)
		if wp == null:
			gone.append(k)
			continue
		if cam.is_position_behind(wp):
			continue
		var sp: Vector2 = cam.unproject_position(wp) / dpr
		var sz: Vector2 = Layout.bubble_size(str(e["text"]), view_w)
		live[k] = sp
		items.append({"id": k, "x": sp.x, "y": sp.y, "w": sz.x, "h": sz.y})
	for k in gone:
		_b.erase(k)
	if items.is_empty():
		return
	# 别人的名牌层级比气泡高，气泡不能被它压住：把所有人的名牌当障碍
	var tag_obs: Array = []
	var actors: Dictionary = ctx.actors()
	var me: String = ctx.self_id()
	for id in actors:
		var a: TActor = actors[id]
		var np := Vector3(a.disp.x, NAME_Y, a.disp.y)
		if cam.is_position_behind(np):
			continue
		var tp: Vector2 = cam.unproject_position(np) / dpr
		tag_obs.append({"id": str(id), "x": tp.x, "y": tp.y, "w": Layout.name_width(a.actor_name, str(id) == me)})
	var lifts: Dictionary = Layout.layout(items, tag_obs, view_w, TOP_SAFE)
	for k in live:
		var target = lifts.get(k)
		if target == null:
			continue  # 屏幕上方放不下：这一帧不画（人走下来就会出现）
		var e2: Dictionary = _b[k]
		var cur: float = float(e2["lift"])
		# 抬高量平滑过去：人走动穿过阈值、前一个气泡过期时不会一帧跳一大截
		cur = float(target) if cur < 0.0 else Layout.ease_toward(cur, float(target), (now - float(e2["lt"])) / 1000.0)
		e2["lift"] = cur
		e2["lt"] = now
		var sp2: Vector2 = live[k]
		var age2: float = now - float(e2["born"])
		out.append({"i": "b:" + str(k), "n": e2["text"], "x": snappedf(sp2.x / view_w, 0.0005), "y": snappedf((sp2.y - cur) * dpr / size.y, 0.0005), "k": "b", "sel": age2 >= float(e2["show_ms"])})


func debug() -> Dictionary:
	var act: Array = []
	var now: float = Time.get_ticks_msec()
	for k in _b:
		var e: Dictionary = _b[k]
		act.append({"id": k, "len": str(e["text"]).length(), "phase": "fade" if now - float(e["born"]) >= float(e["show_ms"]) else "show"})
	return {"active": act, "shown": _shown, "shown_by": _shown_by.duplicate(), "skipped_stale": _skipped_stale}
