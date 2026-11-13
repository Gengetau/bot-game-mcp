class_name TCtx
extends RefCounted
## 功能模块看 main 的只读窗口，加几个调用口。功能代码不许写 ctx.m.xxx；main 改变量名只改这一个文件。
## 需要新的访问口：加在下面自己那一段的预留分区里，不动别人的分区，也不动公共部分。
## 所有转发协程的包装函数必须 `return await …`，漏掉 await 会拿到协程状态对象而不是 Dictionary。

var m  # main，无类型；只有本文件读 m 的字段


func bridge() -> TBridge:
	return m.bridge


func self_id() -> String:
	return str(m.self_id)


## id -> TActor，只读（每次现取，不要缓存引用）
func actors() -> Dictionary:
	return m.actors


## /me 的 here 视图
func here() -> Dictionary:
	return m.here


## 最近一次 /me 里的 location（scene、space、name、x、z）；没有时是空字典
func me_view() -> Dictionary:
	return m._me_loc


func manifest() -> Dictionary:
	return m.manifest


## manifest["source"]["hearDistance"]，缺失时 9.0（只作软提示，服务端 heardBy 才是准的）
func hear_distance() -> float:
	var src = m.manifest.get("source")
	if src is Dictionary and src.has("hearDistance"):
		return float(src["hearDistance"])
	return 9.0


## 读 /config 的 limits（main 在 _flow_body 读到 /config 时存下 server_cfg）
func cfg_limit(key: String, default_v: int) -> int:
	var lim = m.server_cfg.get("limits")
	if lim is Dictionary and lim.has(key):
		return int(lim[key])
	return default_v


func playing() -> bool:
	return m.phase == m.Phase.PLAYING


func control_mine() -> bool:
	return bool(m.control_mine)


## 在一局小游戏里（activity_id 非空；茶馆等家具互动不写它）
func in_game() -> bool:
	return m.ctx_activity != null


## "ok" | "reconnecting" | "offline"
func conn() -> String:
	return m._conn_state()


func ws_ready() -> bool:
	return bool(m.ws_ready)


func cur_scene() -> String:
	return str(m.cur_scene)


func cur_space() -> String:
	return str(m.cur_space)


func space_name() -> String:
	return str(m.cur_space_name)


func server_now() -> float:
	return m.clock.server_now()


func new_req_id() -> String:
	return m._new_req_id()


## 3 次自动重试，会让所有按钮变灰（pending）：适合导航类
func act(action: Dictionary) -> Dictionary:
	return await m._act(action)


## 一次性提交，不动 pending、不睡眠重试：聊天用。opts: {rid, retry_stale}
func act_once(action: Dictionary, opts: Dictionary = {}) -> Dictionary:
	return await m._act_once(action, opts)


## path 不带 /town/api 前缀，如 "/history?limit=30"
func api_get(path: String) -> Dictionary:
	return await m.bridge.http("GET", m.API + path)


func api_post(path: String, body = null) -> Dictionary:
	return await m.bridge.http("POST", m.API + path, body)


func net_send(d: Dictionary) -> void:
	m.net.send(d)


func toast(text: String, kind: String = "info") -> void:
	m._toast(text, kind)


func refresh_me() -> void:
	m._refresh_me()


func mark_dirty() -> void:
	m._dirty = true


## 取别的功能（只在确有需要时用；默认模块之间不互相引用）
func feature(fid: String):
	return m.features.get_feature(fid)


# ───────────────────────── C1b 分区 ─────────────────────────
## 走到某个公共地点（只是走过去，不替玩家入座或做别的）。必须走 main._do_navigate：它管续租、序号栅栏、落点标记、只读与对局中的拦截。
func navigate_to_place(place_id: String) -> void:
	m.selected_obj = ""
	await m._do_navigate({"to": place_id}, "")
# ─────────────────────────────────────────────────────────────────────────


# ───────────────────────── C2 分区（预留，空）─────────────────────────
# ─────────────────────────────────────────────────────────────────────────


# ───────────────────────── C3 分区（预留，空）─────────────────────────
# ─────────────────────────────────────────────────────────────────────────


# ───────────────────────── C4 分区（预留，空）─────────────────────────
# ─────────────────────────────────────────────────────────────────────────


# ───────────────────────── C5 分区（预留，空）─────────────────────────
# ─────────────────────────────────────────────────────────────────────────


# ───────────────────────── C6 分区（预留，空）─────────────────────────
# ─────────────────────────────────────────────────────────────────────────


# ───────────────────────── C7 分区（预留，空）─────────────────────────
# ─────────────────────────────────────────────────────────────────────────
