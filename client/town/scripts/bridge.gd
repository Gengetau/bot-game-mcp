class_name TBridge
extends RefCounted
## 和网页外壳（boot.js / hud.js）之间的桥。
## - 网络请求走浏览器的 fetch（同源 Cookie 由浏览器带），结果经回调回来；
## - Godot -> 界面：调用 window.TownHud 上的方法；
## - 界面 -> Godot：window.TownHost.emit 调到这里的回调。
## 回调对象必须一直被引用，否则会被回收，之后 JS 调用就没有反应。

## 页面脚本（dock.js）与客户端的接口版本：不一致就报「页面文件和客户端版本不一致」，免得缓存错位后半新半旧地运行。
const HUD_PROTOCOL := 2

signal ui_event(ev_name: String, arg: String)
signal visibility_changed(is_visible: bool)

class Pending:
	extends RefCounted
	signal done(result: Dictionary)

var web: bool = false
var host  # JavaScriptObject（无类型：GDScript 才允许直接调用 JS 方法）
var hud
var _cb  # 保持引用
var _next_id: int = 1
var _pending: Dictionary = {}
var origin: String = ""
var debug: bool = false
var debug_hour: float = -1.0


func setup() -> void:
	web = OS.has_feature("web")
	if not web:
		return
	host = JavaScriptBridge.get_interface("TownHost")
	hud = JavaScriptBridge.get_interface("TownHud")
	_cb = JavaScriptBridge.create_callback(_on_js)
	host.setCallback(_cb)
	# 不用 JavaScriptBridge.eval：这条路径的 CSP 没有 'unsafe-eval'
	var loc = JavaScriptBridge.get_interface("location")
	origin = str(loc.origin)
	debug = "debug=1" in str(loc.search).trim_prefix("?").split("&")
	# 截图 / 端到端用：?hour=20 把世界时间固定在某个钟点（只在调试模式下生效）
	for kv in str(loc.search).trim_prefix("?").split("&"):
		if debug and kv.begins_with("hour="):
			debug_hour = float(kv.substr(5))


func ws_origin() -> String:
	if origin.begins_with("https://"):
		return "wss://" + origin.substr(8)
	if origin.begins_with("http://"):
		return "ws://" + origin.substr(7)
	return origin


func client_id() -> String:
	if not web:
		return "godot-offline-0000"
	return str(hud.clientId())


func _on_js(args: Array) -> void:
	if args.is_empty():
		return
	var kind: String = str(args[0])
	match kind:
		"http":
			var id: int = int(args[1])
			var p = _pending.get(id)
			if p == null:
				return
			_pending.erase(id)
			var status: int = int(args[2])
			var text: String = str(args[3])
			var data = null
			if text.length() > 0 and (text[0] == "{" or text[0] == "["):
				data = JSON.parse_string(text)
			p.done.emit({"status": status, "data": data, "text": text, "retry_after": str(args[4]) if args.size() > 4 else ""})
		"ui":
			ui_event.emit(str(args[1]), str(args[2]) if args.size() > 2 else "")
		"vis":
			visibility_changed.emit(str(args[1]) == "1")


## 发请求。返回 {status, data, text, retry_after}；status 为 0 表示网络层失败（text 是原因）。
func http(method: String, path: String, body = null) -> Dictionary:
	if not web:
		return {"status": 0, "data": null, "text": "not web", "retry_after": ""}
	var id: int = _next_id
	_next_id += 1
	var p := Pending.new()
	_pending[id] = p
	var body_text: String = "" if body == null else JSON.stringify(body)
	host.fetchJson(id, method, path, body_text)
	var res: Dictionary = await p.done
	return res


func hud_state(d: Dictionary) -> void:
	if web:
		hud.setState(JSON.stringify(d))


func hud_tags(s: String) -> void:
	if web:
		hud.setTags(s)


func hud_toast(msg: String, kind: String = "info") -> void:
	if web:
		hud.toast(msg, kind)


func hud_debug(s: String) -> void:
	if web:
		hud.debugSet(s)


## 往某个面板功能的网页模块推数据。只传字符串：对象一律先 JSON.stringify，网页一侧再 JSON.parse。
## 注意同步重入：网页模块的 onFeed 里不得同步 emit（要延后），否则会在这次调用栈里重入 hub.on_ui。
func hud_feed(feature: String, kind: String, json: String) -> void:
	if web:
		hud.feed(feature, kind, json)


## 网页一侧的接口版本（dock.js 挂上 2；没加载 dock.js 时 hud.js 的空实现回 0）。非网页环境回 0。
func hud_protocol() -> int:
	return int(hud.protocol()) if web else 0
