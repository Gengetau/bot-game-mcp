extends TFeature
## 全镇公屏（页签「全镇」）与公屏静音。
## 读：GET /town-chat（旧的在前）+ WebSocket 的 town_chat 帧；断线重连后按 hello 里的水位决定要不要补读。
## 写：say_town（闲聊 / 组织活动 / 求助，可带地点提示）经 ctx.act_once；静音是 update_profile 的 muteTownChat。
## 服务端的 id 是不透明游标，不能比较大小，也不能存进浏览器：Godot 给每条消息一个本地序号 ord 交给网页当 id（追新 ++_hi，读更早 --_lo）。
## 公屏不出气泡，也不唤醒谁（回执里没有唤醒信息，这里不猜）。

const MAX_MSGS := 200
const PAGE_DEFAULT := 50
const CATCHUP_LIMIT := 100
const MAX_CATCHUP_PAGES := 10
const OWN_WAIT_MS := 2000.0
const KINDS := ["chat", "activity", "help"]
const PLACES := ["plaza", "tea_house", "bookshop", "kitchen", "garden", "arcade", "residential"]
const RETRY_MS := [1000.0, 3000.0, 8000.0, 20000.0]

var _msgs: Array = []  # {sid, ord, item}，按 ord 升序（也就是服务端顺序）
var _seen: Dictionary = {}  # 服务端 id -> ord
var _rcpt: Dictionary = {}  # 靠回执补进列表的 id：之后回声帧到了要推进 _after
var _buf: Array = []  # 同步期间到的 town_chat 帧
var _after: String = ""  # 已读到哪（只由 HTTP 页的 cursor 与 WS 帧的 cursor 推进，发话回执不推进）
var _older: String = ""
var _has_older: bool = false
var _older_busy: bool = false
var _hi: int = 0
var _lo: int = 0
var _gen: int = 0  # 离开 / 换人时加一
var _sgen: int = 0  # 每次 _sync 加一，旧的在途读取回来后丢弃
var _left: bool = false  # on_leave 之后、下一次 on_enter 之前：hello 不触发读取（会话可能已失效，读了只得 401）
var _epoch: int = 0  # 列表被整体清空时加一（读更早的结果据此丢弃）
var _syncing: bool = false
var _need_sync: bool = true
var _loaded: bool = false
var _load_err: bool = false
var _retry_n: int = 0
var _retry_at: float = 0.0
var _hello_hc: String = ""
var _muted: bool = false
var _my_name: String = ""
var _me_id: String = ""  # on_me 记下的值（按居民编号对上才用，见 on_enter）
var _me_muted: bool = false
var _me_name: String = ""
var _page: int = PAGE_DEFAULT
var _inflight: bool = false
var _mute_busy: bool = false
var _pending_rid: String = ""
var _pending_key: String = ""
var _own_wait: Dictionary = {}  # 回执里的 id -> {text, kind, place, until}
var _acc: float = 0.0
var _last_ack: Dictionary = {}
var _reason: String = ""
var _last_frame: Dictionary = {}
# 计数（debug 用）
var _sent: int = 0
var _syncs: int = 0
var _catchups: int = 0
var _resyncs: int = 0
var _frames: int = 0
var _dupes: int = 0
var _hellos: int = 0


func _init() -> void:
	id = "town"


func frame_types() -> PackedStringArray:
	return PackedStringArray(["town_chat"])


func wants_tick() -> bool:
	return true


func on_enter() -> void:
	_left = false
	# on_me 可能先于 on_enter 到，而 hub 的兜底 on_leave 会在 on_enter 里把它存的值清掉：按居民编号对上就取回来
	if _me_id != "" and _me_id == ctx.self_id():
		_muted = _me_muted
		_my_name = _me_name
	_push_state(true)  # 名字和静音状态先到网页，随后到的历史才能判 @我
	if ctx.ws_ready() and not _syncing:
		_sync("catchup" if _loaded else "initial")


func on_leave() -> void:
	_left = true
	_gen += 1
	_sgen += 1
	_epoch += 1
	_msgs.clear()
	_seen.clear()
	_rcpt.clear()
	_buf.clear()
	_own_wait.clear()
	_after = ""
	_older = ""
	_has_older = false
	_older_busy = false
	_hi = 0
	_lo = 0
	_syncing = false
	_need_sync = true
	_loaded = false
	_load_err = false
	_retry_n = 0
	_retry_at = 0.0
	_hello_hc = ""
	_muted = false
	_my_name = ""
	_page = PAGE_DEFAULT
	_inflight = false
	_mute_busy = false
	_pending_rid = ""
	_pending_key = ""
	_acc = 0.0
	_last_frame = {}
	feed("reset")
	forget_state()


func on_me(view: Dictionary) -> void:
	var me = view.get("me")
	if not (me is Dictionary):
		return
	var st = me.get("settings")
	_me_id = str(me.get("id", ""))
	_me_name = str(me.get("name", ""))
	_me_muted = st is Dictionary and bool(st.get("muteTownChat", false))
	_muted = _me_muted
	_my_name = _me_name


func on_hello(msg: Dictionary, _resumed: bool, _first: bool) -> void:
	var tc = msg.get("townChat")
	var hc: String = str(tc.get("cursor", "")) if tc is Dictionary else ""
	_hellos += 1
	_hello_hc = hc
	if _left:
		return
	if _syncing:
		return  # 这次读完之后会拿 _hello_hc 对一下，不一样再补读
	if not _loaded:
		_sync("initial")
	elif hc != "" and hc == _after and not _need_sync:
		_hello_hc = ""  # 断线期间公屏没有新话，不用读
	else:
		_sync("catchup")


func on_frame(t: String, msg: Dictionary) -> void:
	if t != "town_chat":
		return
	_frames += 1
	_last_frame = msg.duplicate(true)
	if _syncing or _need_sync or not _loaded:
		# 读取没完成之前不直接入列表，也不推进 _after（否则中间的缺口会漏读）；读完后按顺序排空
		_buf.append(msg)
		while _buf.size() > 200:
			_buf.pop_front()
		return
	_apply_frame(msg)


func _apply_frame(msg: Dictionary) -> void:
	var arr = msg.get("messages")
	if not (arr is Array) or arr.is_empty():
		return
	var list: Array = []
	for m in arr:
		if m is Dictionary:
			list.append(m)
	if list.is_empty():
		return
	var last_sid: String = str(list[list.size() - 1].get("id", ""))
	# 最后一条是新的（或是靠回执先补进来的）才推进：回放 / 重复的帧不会把 _after 拨回去
	var advance: bool = last_sid != "" and (not _seen.has(last_sid) or _rcpt.has(last_sid))
	_ingest_tail(list, true)
	if advance:
		var c: String = str(msg.get("cursor", ""))
		_after = c if c != "" else last_sid
	for m in list:
		_rcpt.erase(str(m.get("id", "")))


# ───────────────────────── 读 ─────────────────────────


## 同步一次。mode: "initial"（读最近一页）或 "catchup"（从 _after 往后读）。
func _sync(mode: String) -> void:
	_sgen += 1
	var sg: int = _sgen
	var g: int = _gen
	_syncing = true
	_need_sync = true
	_syncs += 1
	var cur: String = mode
	while true:
		var res: String
		if cur == "initial":
			res = await _load_initial(sg, g)
		else:
			_catchups += 1
			res = await _load_catchup(sg, g)
		if g != _gen or sg != _sgen:
			return  # 被取消：新的一轮自己管标志
		if res == "resync":
			_resyncs += 1
			_loaded = false
			_clear_list()
			cur = "initial"
			continue
		if res == "fail":
			_syncing = false
			_load_err = true
			var i: int = mini(_retry_n, RETRY_MS.size() - 1)
			_retry_at = Time.get_ticks_msec() + float(RETRY_MS[i])
			_retry_n += 1
			return
		# 成功：先应用结果，再排空缓冲
		_loaded = true
		_load_err = false
		_retry_n = 0
		var hh: String = _hello_hc
		_hello_hc = ""
		if hh != "" and hh != _after:
			cur = "catchup"  # 读的当口又来了新的 hello，水位对不上：再补一轮
			continue
		_need_sync = false
		_syncing = false
		var b: Array = _buf
		_buf = []
		for f in b:
			_apply_frame(f)
		return


func _load_initial(sg: int, g: int) -> String:
	var r: Dictionary = await ctx.api_get("/town-chat?limit=%d" % _page)
	if g != _gen or sg != _sgen:
		return "cancel"
	var d = r.get("data")
	if int(r.get("status", 0)) != 200 or not (d is Dictionary) or bool(d.get("resync", false)):
		return "fail"
	var arr = d.get("messages")
	if not (arr is Array):
		return "fail"
	if not _msgs.is_empty():
		_clear_list()
	_ingest_tail(arr, false, true)
	_after = str(d.get("cursor", ""))
	var older = d.get("older")
	_has_older = older != null and str(older) != ""
	_older = str(older) if _has_older else ""
	return "ok"


func _load_catchup(sg: int, g: int) -> String:
	var pages: int = 0
	while true:
		var r: Dictionary = await ctx.api_get("/town-chat?after=%s&limit=%d" % [_after.uri_encode(), CATCHUP_LIMIT])
		if g != _gen or sg != _sgen:
			return "cancel"
		var d = r.get("data")
		if int(r.get("status", 0)) != 200 or not (d is Dictionary):
			return "fail"
		if bool(d.get("resync", false)):
			return "resync"
		var arr = d.get("messages")
		if not (arr is Array):
			return "fail"
		_ingest_tail(arr, true, true)
		var c: String = str(d.get("cursor", ""))
		if c != "":
			_after = c
		if not bool(d.get("more", false)):
			return "ok"
		pages += 1
		if pages >= MAX_CATCHUP_PAGES:
			return "resync"
	return "ok"


func _clear_list() -> void:
	_epoch += 1
	_msgs.clear()
	_seen.clear()
	_rcpt.clear()
	_own_wait.clear()
	_hi = 0
	_lo = 0
	_has_older = false
	_older = ""
	_older_busy = false
	feed("rebuild")


func _load_older() -> void:
	if not _has_older or _older_busy or _syncing or _msgs.size() >= MAX_MSGS or _older == "":
		return
	_older_busy = true
	var g: int = _gen
	var ep: int = _epoch
	var front: String = str(_msgs[0]["sid"])  # 发请求时最旧的一条：回来时它必须还是最旧的，这一页才接得上
	var lim: int = maxi(1, mini(_page, MAX_MSGS - _msgs.size()))
	var r: Dictionary = await ctx.api_get("/town-chat?before=%s&limit=%d" % [_older.uri_encode(), lim])
	if g != _gen or ep != _epoch:
		return
	_older_busy = false
	var d = r.get("data")
	if int(r.get("status", 0)) != 200 or not (d is Dictionary):
		return  # 失败静默：按钮还在，用户再点一次
	if bool(d.get("resync", false)):
		_has_older = false
		return
	if _msgs.is_empty() or str(_msgs[0]["sid"]) != front:
		# 等待期间追新把最旧的几条挤掉了（封顶）：这页和现在的最前面之间会缺几条，接上去就断档。丢掉，用户再点一次按当前最旧一条重读
		return
	var arr = d.get("messages")
	var older = d.get("older")
	if arr is Array:
		var room: int = MAX_MSGS - _msgs.size()  # 等待期间追新也可能把列表填满了
		if room <= 0:
			return
		if arr.size() > room:
			arr = arr.slice(arr.size() - room)  # 只留紧挨着现在最前面的那几条
			older = (arr[0] as Dictionary).get("id", "")  # 这一页被截了：更早的从截断处接着读
		_ingest_older(arr)
	_has_older = older != null and str(older) != ""
	_older = str(older) if _has_older else ""


func _item_of(m: Dictionary, ord: int) -> Dictionary:
	var frm = m.get("from")
	var f: Dictionary = frm if frm is Dictionary else {}
	var pl = m.get("place")
	var place = null
	if pl is Dictionary and PLACES.has(str(pl.get("id", ""))):
		place = {"id": str(pl["id"]), "name": str(pl.get("name", ""))}
	var tk: String = str(m.get("kind", "chat"))
	if not KINDS.has(tk):
		tk = "chat"
	return {
		"id": ord,
		"from": str(f.get("id", "")),
		"name": str(f.get("name", "")),
		"kind": TChatUtil.kind_of(f),
		"text": str(m.get("text", "")),
		"at": float(m.get("at", 0.0)),
		"space": "town",
		"spaceName": "",  # 必须是空串：chatkit 看到不同的 spaceName 会插分隔行
		"mine": bool(m.get("mine", false)),
		"tkind": tk,
		"place": place,
	}


## 追新：按到达顺序编号（页内按页的顺序，页是旧的在前）
func _ingest_tail(list: Array, live: bool, from_http: bool = false) -> void:
	var out: Array = []
	for m in list:
		if not (m is Dictionary):
			continue
		var sid: String = str(m.get("id", ""))
		if sid == "":
			continue
		if _seen.has(sid):
			_dupes += 1
			if from_http:
				_rcpt.erase(sid)  # HTTP 页的 cursor 已经把 _after 推过它了：之后回声帧不能再把 _after 拨回去
			continue
		_hi += 1
		var it: Dictionary = _item_of(m, _hi)
		_seen[sid] = _hi
		_msgs.append({"sid": sid, "ord": _hi, "item": it})
		out.append(it)
	if out.is_empty():
		return
	while _msgs.size() > MAX_MSGS:
		var gone: Dictionary = _msgs.pop_front()
		_seen.erase(str(gone["sid"]))
		_has_older = true
		_older = str(_msgs[0]["sid"])  # before 的语义是「比这条更早」，所以最旧一条的 id 永远是对的
	feed("append", {"items": out, "live": live})


## 读更早：页里从新到旧依次 --_lo，所以序号永远和服务端顺序一致
func _ingest_older(list: Array) -> void:
	var entries: Array = []
	for i in range(list.size() - 1, -1, -1):
		var m = list[i]
		if not (m is Dictionary):
			continue
		var sid: String = str(m.get("id", ""))
		if sid == "":
			continue
		if _seen.has(sid):
			_dupes += 1
			continue
		_lo -= 1
		var it: Dictionary = _item_of(m, _lo)
		_seen[sid] = _lo
		entries.push_front({"sid": sid, "ord": _lo, "item": it})
	if entries.is_empty():
		return
	var items: Array = []
	for e in entries:
		items.append(e["item"])
	_msgs = entries + _msgs
	feed("append", {"items": items, "live": false, "older": true})


# ───────────────────────── 写 ─────────────────────────


func on_ui(ui_name: String, arg: String) -> void:
	match ui_name:
		"send":
			var p = JSON.parse_string(arg)
			if p is Dictionary:
				await _send(int(p.get("n", 0)), str(p.get("text", "")).strip_edges(), str(p.get("kind", "chat")), str(p.get("place", "")))
		"older":
			_load_older()
		"mute":
			await _set_mute(arg == "1")
		"goto":
			if PLACES.has(arg):
				await ctx.navigate_to_place(arg)
		"debug_after":
			if ctx.bridge().debug:
				_after = "cbad.bad"
		"debug_replay":
			if ctx.bridge().debug and not _last_frame.is_empty():
				on_frame("town_chat", _last_frame.duplicate(true))
		"debug_page":
			if ctx.bridge().debug and int(arg) > 0:
				_page = int(arg)
				if _loaded and not _syncing:
					_clear_list()
					_loaded = false
					_sync("initial")


func _send(n: int, text: String, kind: String, place: String) -> void:
	if text == "" or _inflight:
		return
	if not ctx.control_mine():
		_ack(n, {"ok": false, "code": "readonly"})
		return
	if ctx.in_game():
		_ack(n, {"ok": false, "code": "in_activity"})
		return
	var mx: int = ctx.cfg_limit("chatMaxChars", 120)
	if text.length() > mx:  # String 按码点计数（表情算一个），和服务端一致
		_ack(n, {"ok": false, "code": "text_too_long", "maxChars": mx})
		return
	if not KINDS.has(kind):
		kind = "chat"
	if not PLACES.has(place):
		place = ""
	_inflight = true
	var g: int = _gen
	var key: String = "%s|%s|%s" % [text, kind, place]
	var rid: String = _pending_rid if (_pending_rid != "" and key == _pending_key) else ctx.new_req_id()
	_pending_key = key
	var action := {"type": "say_town", "text": text, "kind": kind}
	if place != "":
		action["place"] = place
	var r: Dictionary = await ctx.act_once(action, {"rid": rid})
	if g != _gen:
		return  # 期间离开 / 换人：结果不属于现在这个人
	_inflight = false
	if bool(r.get("ok", false)):
		_pending_rid = ""
		_pending_key = ""
		_sent += 1
		var d: Dictionary = r["data"] if r.get("data") is Dictionary else {}
		var sid: String = str(d.get("id", ""))
		if sid != "" and not _seen.has(sid):
			if ctx.ws_ready():
				# 等 WS 回声（同 id，mine:true）；2 秒还没到再用回执补
				_own_wait[sid] = {"text": text, "kind": kind, "place": place, "until": Time.get_ticks_msec() + OWN_WAIT_MS}
			else:
				_add_receipt(sid, text, kind, place)
		_ack(n, {"ok": true, "messageId": 0})  # 公屏没有 heardBy，不能带，否则 chatkit 会显示「没有人听到」
		return
	var data = r.get("data")
	var code: String = "net" if bool(r.get("net_fail", false)) else str(r.get("error", ""))
	if bool(r.get("net_fail", false)):
		_pending_rid = str(r.get("rid", ""))  # 保留请求号，用户重发同一句时带回
	else:
		_pending_rid = ""
	var ack := {"ok": false, "code": code, "reason": str(r.get("reason", "")), "message": str(r.get("message", "")), "retryMs": int(r.get("retry_after_ms", 0))}
	if data is Dictionary and data.has("maxChars"):
		ack["maxChars"] = int(data["maxChars"])
	_ack(n, ack)


## 靠回执把自己这句补进列表（ws 没连着，或回声 2 秒没到）。不推进 _after；之后回声到了按 id 去重，并借 _rcpt 推进 _after。
func _add_receipt(sid: String, text: String, kind: String, place: String) -> void:
	if _seen.has(sid):
		return
	var m := {"id": sid, "from": {"id": ctx.self_id(), "name": _my_name, "kind": "human"}, "kind": kind, "text": text, "at": ctx.server_now(), "mine": true}
	if place != "":
		m["place"] = {"id": place, "name": ""}  # 名字缺省时网页用文字库里的
	_rcpt[sid] = true
	_ingest_tail([m], true)


func _ack(n: int, d: Dictionary) -> void:
	d["n"] = n
	_last_ack = d.duplicate()
	feed("ack", d)


func _set_mute(v: bool) -> void:
	if _mute_busy:
		return
	if not ctx.control_mine():
		ctx.toast("另一处握着你的居民，这里只能看。", "warn")
		_push_state(true)
		return
	_mute_busy = true
	var g: int = _gen
	var r: Dictionary = await ctx.act_once({"type": "update_profile", "muteTownChat": v})
	if g != _gen:
		return
	_mute_busy = false
	if bool(r.get("ok", false)):
		_muted = v
		_me_muted = v
	else:
		var msg: String = str(r.get("message", ""))
		ctx.toast(msg if msg != "" else "没能改成，稍后再试。", "err")
	_push_state(true)


# ───────────────────────── 每帧 ─────────────────────────


func tick(dt: float, _now_ms: float) -> void:
	if _left:
		return  # 离开之后到下一次进入之前不推 state：面板里是登出状态，推了只会显示「正在读公屏…」
	_acc += dt
	if _acc < 0.25:
		return
	_acc = 0.0
	var t: float = Time.get_ticks_msec()
	if not _own_wait.is_empty():
		var due: Array = []
		for sid in _own_wait:
			if t >= float(_own_wait[sid]["until"]):
				due.append(sid)
		for sid in due:
			var w: Dictionary = _own_wait[sid]
			_own_wait.erase(sid)
			_add_receipt(str(sid), str(w["text"]), str(w["kind"]), str(w["place"]))
	if _load_err and not _syncing and t >= _retry_at:
		_sync("catchup" if _loaded else "initial")
	_push_state(false)


func _push_state(force: bool) -> void:
	var reason: String = ""
	if not ctx.control_mine():
		reason = "readonly"
	elif ctx.in_game():
		reason = "game"
	elif ctx.conn() == "offline":
		reason = "offline"
	_reason = reason
	var at_cap: bool = _msgs.size() >= MAX_MSGS
	var st := {
		"canSend": reason == "",
		"reason": reason,
		"max": ctx.cfg_limit("chatMaxChars", 120),
		"place": "",
		"hear": 0,
		"alone": false,
		"me": _my_name,
		"muted": _muted,
		"hasOlder": _has_older and not at_cap,
		"olderBusy": _older_busy,
		"loading": not _loaded and not _load_err,
		"loadErr": _load_err,
		"atCap": at_cap and _has_older,
	}
	if force:
		_last_state = ""
	feed_state(st)


func debug() -> Dictionary:
	return {
		"sent": _sent, "lastAck": _last_ack, "reason": _reason, "size": _msgs.size(), "seen": _seen.size(), "after": _after, "older": _older, "hasOlder": _has_older,
		"syncs": _syncs, "catchups": _catchups, "resyncs": _resyncs, "frames": _frames, "dupes": _dupes, "buffered": _buf.size(), "muted": _muted, "page": _page, "loadErr": _load_err, "hellos": _hellos,
	}
