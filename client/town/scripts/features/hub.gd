class_name TFeatureHub
extends RefCounted
## 读 manifest.gd，实例化各功能，按事件类型 / 帧类型 / ui 前缀路由，管 tick 和进入 / 离开的幂等。
## main.gd 只持有一个 hub，对它的调用都是一行转发；没有任何功能覆盖钩子时整个 hub 零行为。

var ctx: TCtx
var _features: Array = []
var _by_id: Dictionary = {}
var _by_event: Dictionary = {}  # type -> Array[TFeature]
var _by_frame: Dictionary = {}  # t -> Array[TFeature]
var _tickers: Array = []
var _entered: bool = false
var _entered_self: String = ""
## 最近一次 on_pick 的记录（kind、id、来源 tap / key / button、有没有被接管、第几次）：只进 debug()，给端到端核对
var _last_pick: Dictionary = {}
## 只在 ?debug=1 下由 main 设置（端到端用），两种都不调任何功能：
## 等于某个编号：对它的 on_pick 直接算「被接管」（假接管）；
## 等于 PICK_MUTE：一律算「没接管」（骨架的端到端用它核对「没有功能接管时旧行为照常」，不受已并入的真功能影响）
const PICK_MUTE := "-"
var _pick_stub: String = ""
## 现在占着浮层卡的功能（居民卡、NPC 菜单……一次只开一张）：功能开卡时 claim，关卡时 release；换人时底座通知上一个主人收起
var _card_owner: String = ""


func setup(main_node) -> void:
	ctx = TCtx.new()
	ctx.m = main_node
	for scr in TManifest.LIST:
		var f: TFeature = scr.new()
		f.ctx = ctx
		_features.append(f)
		if f.id != "":
			_by_id[f.id] = f
		for t in f.event_types():
			if not _by_event.has(t):
				_by_event[t] = []
			(_by_event[t] as Array).append(f)
		for t in f.frame_types():
			if not _by_frame.has(t):
				_by_frame[t] = []
			(_by_frame[t] as Array).append(f)
		if f.wants_tick():
			_tickers.append(f)
	for f in _features:
		(f as TFeature).setup()


func get_feature(fid: String):
	return _by_id.get(fid)


## 功能 fid 要开自己的浮层卡：先让上一张卡的主人收起（它的 on_card_yield），再记成自己的
func claim_card(fid: String) -> void:
	var prev: String = _card_owner
	_card_owner = fid
	if prev != "" and prev != fid:
		var pf = _by_id.get(prev)
		if pf != null:
			(pf as TFeature).on_card_yield()


## 功能自己关了卡：只有它还是主人时才清（被换掉之后它收起时再调是空操作）
func release_card(fid: String) -> void:
	if _card_owner == fid:
		_card_owner = ""


func on_enter() -> void:
	# 兜底：上一次进入的是另一个人（共用设备换人登录而没经过 on_leave 的路径）
	if _entered and _entered_self != ctx.self_id():
		on_leave()
	_entered = true
	_entered_self = ctx.self_id()
	for f in _features:
		(f as TFeature).on_enter()


func on_leave() -> void:
	if not _entered:
		return
	_entered = false
	_entered_self = ""
	_card_owner = ""
	for f in _features:
		(f as TFeature).on_leave()


func on_me(view: Dictionary) -> void:
	for f in _features:
		(f as TFeature).on_me(view)


func on_scene(msg: Dictionary) -> void:
	for f in _features:
		(f as TFeature).on_scene(msg)


func on_hello(msg: Dictionary, resumed: bool, first: bool) -> void:
	for f in _features:
		(f as TFeature).on_hello(msg, resumed, first)


func on_ws_closed() -> void:
	for f in _features:
		(f as TFeature).on_ws_closed()


func on_resync() -> void:
	for f in _features:
		(f as TFeature).on_resync()


func on_event(ev: Dictionary) -> void:
	var list = _by_event.get(str(ev.get("type", "")))
	if list == null:
		return
	for f in list:
		(f as TFeature).on_event(ev)


func on_frame(t: String, msg: Dictionary) -> void:
	var list = _by_frame.get(t)
	if list == null:
		return
	for f in list:
		(f as TFeature).on_frame(t, msg)


## 网页发来的 "<id>.<name>"；没有 "." 或没有这个功能返回 false
func on_ui(ev_name: String, arg: String) -> bool:
	var i: int = ev_name.find(".")
	if i <= 0:
		return false
	var f = _by_id.get(ev_name.substr(0, i))
	if f == null:
		return false
	(f as TFeature).on_ui(ev_name.substr(i + 1), arg)
	return true


func tick(dt: float, now_ms: float) -> void:
	for f in _tickers:
		(f as TFeature).tick(dt, now_ms)


func actions(out: Array) -> void:
	for f in _features:
		(f as TFeature).actions(out)


## arg 是 "<id>:<verb>:<arg>"（main 已去掉 "f:" 前缀）；arg 保留剩余部分
func on_action(arg: String) -> void:
	var parts: PackedStringArray = arg.split(":", true, 2)
	if parts.size() < 2:
		return
	var f = _by_id.get(parts[0])
	if f == null:
		return
	(f as TFeature).on_action(parts[1], parts[2] if parts.size() > 2 else "")


func on_pick(kind: String, pid: String, src: String = "tap") -> bool:
	var taken: bool = false
	if _pick_stub == PICK_MUTE:
		pass
	elif _pick_stub != "" and pid == _pick_stub:
		taken = true
	else:
		for f in _features:
			if (f as TFeature).on_pick(kind, pid):
				taken = true
				break
	_last_pick = {"kind": kind, "id": pid, "src": src, "taken": taken, "n": int(_last_pick.get("n", 0)) + 1}
	return taken


func set_pick_stub(pid: String) -> void:
	_pick_stub = pid


## kind 非空：这一下已经知道选中的是什么（"obj" / "actor"，按 E 而附近什么都没有是 "none"）。
## 哪个功能说「这一下不会让我离开」（pick_stays），就不问它的拦截；别的功能照问。kind 为空（点地面、方向键）：都问。
func blocks_input(kind: String = "", pick_id: String = "") -> String:
	for f in _features:
		if kind != "" and (f as TFeature).pick_stays(kind, pick_id):
			continue
		var why: String = (f as TFeature).blocks_input()
		if why != "":
			return why
	return ""


func tags(cam: Camera3D, size: Vector2, out: Array) -> void:
	for f in _features:
		(f as TFeature).tags(cam, size, out)


func debug() -> Dictionary:
	var d: Dictionary = {}
	for f in _features:
		var x: Dictionary = (f as TFeature).debug()
		if not x.is_empty():
			d[(f as TFeature).id] = x
	if not _last_pick.is_empty():
		d["_pick"] = _last_pick
	if _pick_stub != "":
		d["_stub"] = _pick_stub
	return d
