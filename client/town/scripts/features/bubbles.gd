extends TFeature
## 头顶气泡：听到附近的话（nearby.heard，只在 live 消息时发，自己说的也发）时，在说话人头顶显示一小段，淡出。
## 公屏消息不出气泡（只订阅附近）。气泡是 hud.js 的一块 .tag.b：位置每帧由 tags() 追加，淡出靠先置 sel、过 FADE_MS 再移除；
## 像素抬升（名牌上方）由 bubbles.css 的 margin-top 完成，这里只给世界点。

const MAX_ACTIVE := 6
const STALE_MS := 8000.0  # 断线续传补回来的旧话不冒泡
const FADE_MS := 700.0
const MAX_CHARS := 28
const LIFT_Y := 2.2  # 比名牌的 2.05 略高
const STACK_DX := 120.0  # 屏幕像素：横向离得比这近、纵向比 STACK_DY 近的两个气泡，后者往上错开
const STACK_DY := 36.0

var _b: Dictionary = {}  # 说话人编号 -> {text, born, show_ms}
var _shown: int = 0
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
	_b[speaker] = {"text": text, "born": now, "show_ms": clampf(2200.0 + 80.0 * n, 3000.0, 6500.0)}
	_shown += 1


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
	var gone: Array = []
	var placed: Array = []  # 本帧已放好的气泡屏幕点，后来的离得太近就往上错一格
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
		var sp: Vector2 = cam.unproject_position(wp)
		# 两位居民站得很近时气泡会叠在一起：每有一个已放好的离得近就再往上抬一格（只往上，仍在自己名牌之上）
		for _i in range(MAX_ACTIVE):
			var hit := false
			for q in placed:
				if absf(q.x - sp.x) < STACK_DX and absf(q.y - sp.y) < STACK_DY:
					hit = true
					break
			if not hit:
				break
			sp.y -= STACK_DY
		placed.append(sp)
		out.append({"i": "b:" + str(k), "n": e["text"], "x": snappedf(sp.x / size.x, 0.0005), "y": snappedf(sp.y / size.y, 0.0005), "k": "b", "sel": age >= float(e["show_ms"])})
	for k in gone:
		_b.erase(k)


func debug() -> Dictionary:
	var act: Array = []
	var now: float = Time.get_ticks_msec()
	for k in _b:
		var e: Dictionary = _b[k]
		act.append({"id": k, "len": str(e["text"]).length(), "phase": "fade" if now - float(e["born"]) >= float(e["show_ms"]) else "show"})
	return {"active": act, "shown": _shown, "skipped_stale": _skipped_stale}
