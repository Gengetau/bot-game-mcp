extends TFeature
## 附近聊天（页签「附近」）：C1a 的示范功能。
## 听见的话来自 WS 的 chat 事件，断线 / 刷新后用 GET /history 补；发话走 ctx.act_once（一次性，不动 pending，不睡眠重试）。
## 听得见的范围、限流、对局中不能说话都由服务端判，这里只做软提示（附近没人、对局中、只读），永不替服务器拒绝。

## 每听到一条新的（live）话发一次，供 C1b 的头顶气泡订阅：ctx.feature("nearby").heard.connect(...)。历史补读不发。
signal heard(m: Dictionary)

const MAX_MSGS := 200
const FRESH_MS := 1800000.0  # 页面刚开、列表为空时，只收最近 30 分钟内的历史

var _msgs: Array = []  # 按 id 升序的消息字典（TChatUtil.item 的格式）
var _seen: Dictionary = {}  # id -> true，随 _msgs 修剪
var _gen: int = 0  # 离开 / 换人时加一：在途的 /history 与发话结果回来后据此丢弃
var _inflight: bool = false
var _pending_rid: String = ""  # 上次网络层失败的请求号：用户重发同一句话时带回，服务器按请求号回放回执，不会说两遍
var _pending_text: String = ""
var _next: String = ""  # /history 更早一页的游标（以后「更早」用）
var _acc: float = 0.0
var _sent: int = 0
var _last_ack: Dictionary = {}
var _reason: String = ""
var _alone: bool = false
var _events: int = 0  # 收到的 chat 事件条数（端到端用它当屏障：自己那条的回声到了，说明这之前的事件都已到）
var _late: float = -1.0  # 续传成功后的延迟补读倒计时（秒）


func _init() -> void:
	id = "nearby"


func event_types() -> PackedStringArray:
	return PackedStringArray(["chat"])


func wants_tick() -> bool:
	return true


func on_enter() -> void:
	if ctx.ws_ready():
		_backfill()  # 靠去重安全


func on_leave() -> void:
	_gen += 1
	_msgs.clear()
	_seen.clear()
	_pending_rid = ""
	_pending_text = ""
	_inflight = false
	_next = ""
	_acc = 0.0
	_late = -1.0
	feed("reset")
	forget_state()


func on_hello(_msg: Dictionary, resumed: bool, first: bool) -> void:
	# 游标被接受：缺的 chat 事件会自动补发（live，计未读），所以这时不立刻读历史（历史条目不计未读，抢先到会让补发的事件被当成已有）；
	# 隔几秒再读一次历史当双保险（去重，不会重复）。页面第一次 hello 没有游标，不被接受时服务器随后发 resync，历史是唯一来源。
	if resumed and not first:
		_late = 3.0
	else:
		_backfill()


func on_resync() -> void:
	_backfill()


func on_event(ev: Dictionary) -> void:
	var data = ev.get("data")
	if not (data is Dictionary) or str(data.get("scope", "")) != "nearby":
		return
	var m: Dictionary = TChatUtil.from_event(ev, ctx.self_id(), ctx.cur_space(), ctx.space_name())
	if m.is_empty():
		return
	_events += 1
	_ingest([m], true)


## 补读最近的历史。服务端新的在前，反转成旧的在前再交给 _ingest；全部 live=false，永不计未读。
func _backfill() -> void:
	var g: int = _gen
	var fresh: bool = _msgs.is_empty()  # 按「列表为空」判定，不按「页面第一次 hello」：换人重新登录时新人的旧历史不能全放进来
	var r: Dictionary = await ctx.api_get("/history?limit=30")
	if g != _gen:
		return
	var d = r.get("data")
	if int(r.get("status", 0)) != 200 or not (d is Dictionary):
		return  # 失败静默放弃，下次重连再补
	if bool(d.get("resync", false)):
		_next = ""
	else:
		_next = str(d.get("next", ""))
	var arr = d.get("messages")
	if not (arr is Array):
		return
	var cutoff: float = ctx.server_now() - FRESH_MS
	var list: Array = []
	for i in range(arr.size() - 1, -1, -1):
		if not (arr[i] is Dictionary):
			continue
		var m: Dictionary = TChatUtil.from_history(arr[i], ctx.self_id())
		if m.is_empty():
			continue
		if fresh and float(m["at"]) < cutoff:
			continue
		list.append(m)
	_ingest(list, false)


## 收下新消息：跳过已有的（同 id 的事件文字覆盖旧文字），按 id 升序、封顶 200，推给网页
func _ingest(list: Array, live: bool) -> void:
	var out: Array = []
	var newly: Array = []
	for m in list:
		var mid: int = int(m["id"])
		if _seen.has(mid):
			if live:
				for e in _msgs:
					if int(e["id"]) == mid:
						if str(e["text"]) != str(m["text"]):
							e["text"] = m["text"]
							out.append(m)  # 网页按 id 更新文字
						break
			continue
		_seen[mid] = true
		_msgs.append(m)
		out.append(m)
		newly.append(m)
	if out.is_empty():
		return
	_msgs.sort_custom(func(a, b): return int(a["id"]) < int(b["id"]))
	while _msgs.size() > MAX_MSGS:
		var gone: Dictionary = _msgs.pop_front()
		_seen.erase(int(gone["id"]))
	feed("append", {"items": out, "live": live})
	if live:
		for m in newly:
			heard.emit(m)


func on_ui(ui_name: String, arg: String) -> void:
	if ui_name != "send":
		return
	var p = JSON.parse_string(arg)
	if not (p is Dictionary):
		return
	await _send(int(p.get("n", 0)), str(p.get("text", "")).strip_edges())


func _send(n: int, text: String) -> void:
	if text == "" or _inflight:
		return
	if not ctx.control_mine():
		_ack(n, {"ok": false, "code": "readonly"})
		return
	if ctx.in_game():
		_ack(n, {"ok": false, "code": "in_activity"})
		return
	var mx: int = ctx.cfg_limit("chatMaxChars", 120)
	if text.length() > mx:  # GDScript 的 String 按码点计数（表情算一个），和服务器一致
		_ack(n, {"ok": false, "code": "text_too_long", "maxChars": mx})
		return
	_inflight = true
	var g: int = _gen
	var rid: String = _pending_rid if (_pending_rid != "" and text == _pending_text) else ctx.new_req_id()
	_pending_text = text
	var r: Dictionary = await ctx.act_once({"type": "say_nearby", "text": text}, {"rid": rid})
	if g != _gen:
		return  # 期间离开 / 换人了：结果不属于现在这个人，网页那边已经 reset
	_inflight = false
	if bool(r.get("ok", false)):
		_pending_rid = ""
		_pending_text = ""
		_sent += 1
		var d: Dictionary = r["data"] if r.get("data") is Dictionary else {}
		var mid: int = int(d.get("messageId", 0))
		if mid > 0:
			# 立刻把自己这条放进去；事件回声到达时按 id 去重并以服务端文字为准
			var me := {"id": mid, "name": ""}
			var sa = ctx.actors().get(ctx.self_id())
			if sa != null:
				me["name"] = (sa as TActor).actor_name
			_ingest([TChatUtil.item(mid, {"id": ctx.self_id(), "name": me["name"], "kind": "human"}, text, ctx.server_now(), ctx.cur_space(), ctx.space_name(), ctx.self_id())], true)
		_ack(n, {"ok": true, "heardBy": int(d.get("heardBy", 0)), "messageId": mid})
		return
	var data = r.get("data")
	var code: String = "net" if bool(r.get("net_fail", false)) else str(r.get("error", ""))
	if bool(r.get("net_fail", false)):
		_pending_rid = str(r.get("rid", ""))  # 保留请求号与文字，用户重发同一句话时带回
	else:
		_pending_rid = ""
	var ack := {"ok": false, "code": code, "reason": str(r.get("reason", "")), "message": str(r.get("message", "")), "retryMs": int(r.get("retry_after_ms", 0))}
	if data is Dictionary and data.has("maxChars"):
		ack["maxChars"] = int(data["maxChars"])
	_ack(n, ack)


func _ack(n: int, d: Dictionary) -> void:
	d["n"] = n
	_last_ack = d.duplicate()
	feed("ack", d)


func tick(dt: float, _now_ms: float) -> void:
	if _late > 0.0:
		_late -= dt
		if _late <= 0.0:
			_late = -1.0
			_backfill()
	_acc += dt
	if _acc < 0.25:
		return
	_acc = 0.0
	var reason: String = ""
	if not ctx.control_mine():
		reason = "readonly"
	elif ctx.in_game():
		reason = "game"
	elif ctx.conn() == "offline":
		reason = "offline"  # reconnecting 仍可输入发送，失败走网络层失败的提示
	_reason = reason
	# 「附近没人」只按距离算，不知道声学房间（隔墙、不同房间时服务端听不见而这里会判「有人」），所以只是软提示，永不拦发送
	var sa = ctx.actors().get(ctx.self_id())
	var alone: bool = false
	if sa != null:
		alone = true
		var hear: float = ctx.hear_distance()
		var acts: Dictionary = ctx.actors()
		for aid in acts:
			if aid == ctx.self_id():
				continue
			var a: TActor = acts[aid]
			if a.busy:
				continue
			if (a.disp as Vector2).distance_to((sa as TActor).disp) <= hear:
				alone = false
				break
	_alone = alone
	feed_state({"canSend": reason == "", "reason": reason, "max": ctx.cfg_limit("chatMaxChars", 120), "alone": alone, "place": ctx.space_name(), "hear": ctx.hear_distance()})


func debug() -> Dictionary:
	return {"sent": _sent, "lastAck": _last_ack, "reason": _reason, "alone": _alone, "seen": _seen.size(), "next": _next, "events": _events}
