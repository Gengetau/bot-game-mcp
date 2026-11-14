class_name TFeature
extends RefCounted
## 面板功能的基类：每个功能一个子类，id 同时是网页模块 id、ui 事件前缀、feed 通道名（小写字母数字，不含 "."）。
## 钩子全部是空实现；功能只覆盖自己要的。运行时由 TFeatureHub 按 manifest.gd 里的清单实例化并转发。
## 约定：钩子开头先判空、判类型，不假设字典里有某个键；on_enter / on_leave 必须幂等。

var id: String = ""
var ctx: TCtx
var _last_state: String = ""


## 要收的 events 帧里的事件 type，如 ["chat"]
func event_types() -> PackedStringArray:
	return PackedStringArray()


## 要收的 WS 顶层帧 t，如 ["town_chat"]
func frame_types() -> PackedStringArray:
	return PackedStringArray()


func wants_tick() -> bool:
	return false


## main._ready 里一次
func setup() -> void:
	pass


## 进入 PLAYING（每次登录流程成功后都会来一次）；必须幂等
func on_enter() -> void:
	pass


## 离开 PLAYING；必须幂等；清掉本人相关缓存并让网页清空
func on_leave() -> void:
	pass


## _apply_me 之后；可能在 on_enter 之前、self_id 为空或还是上一个人时被调到，必须容忍
func on_me(_view: Dictionary) -> void:
	pass


func on_scene(_msg: Dictionary) -> void:
	pass


## first=本页面第一次 hello；resumed=服务器接受了我们带的事件游标
func on_hello(_msg: Dictionary, _resumed: bool, _first: bool) -> void:
	pass


func on_ws_closed() -> void:
	pass


func on_resync() -> void:
	pass


## 只收 event_types 里的；ev.id/type/at/data
func on_event(_ev: Dictionary) -> void:
	pass


func on_frame(_t: String, _msg: Dictionary) -> void:
	pass


## 网页发来 "<id>.<name>"，已去前缀；多字段用 JSON；内部可以有 await，hub 不 await 它
func on_ui(_name: String, _arg: String) -> void:
	pass


## 仅 wants_tick，仅 PLAYING，每帧；自己节流到 4Hz 以内
func tick(_dt: float, _now_ms: float) -> void:
	pass


# ── 预留给 C2 到 C6 的一行转发钩子（没有功能实现时必须零行为）──


## _build_actions 末尾追加；按钮 id 必须以 "f:<id>:" 开头
func actions(_out: Array) -> void:
	pass


## 按钮 "f:<id>:<verb>:<arg>" 被点；arg 保留剩余部分
func on_action(_verb: String, _arg: String) -> void:
	pass


## _on_tap 命中 actor/obj，返回 true 表示接管
func on_pick(_kind: String, _pick_id: String) -> bool:
	return false


## 非空串=现在不许点地/方向键，值是提示原因
func blocks_input() -> String:
	return ""


## _update_tags 末尾，可追加或改 out
func tags(_cam: Camera3D, _size: Vector2, _out: Array) -> void:
	pass


## 合并进 window.__town.features[id]
func debug() -> Dictionary:
	return {}


# ── 助手 ──


func feed(kind: String, payload = null) -> void:
	ctx.bridge().hud_feed(id, kind, JSON.stringify(payload))


## kind="state"，整份替换；JSON 与上次相同不推
func feed_state(d: Dictionary) -> void:
	var s := JSON.stringify(d)
	if s == _last_state:
		return
	_last_state = s
	ctx.bridge().hud_feed(id, "state", s)


## on_leave 里调
func forget_state() -> void:
	_last_state = ""
