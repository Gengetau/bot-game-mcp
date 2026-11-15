extends TFeature
## NPC 的服务菜单（浮层 #npcMenu）：点掌柜 / 闲逛者（或对它按 E）打开，选话题发 ask_npc，掌柜处有货架可以 buy。
## NPC 在 main.gd 里并进同一张角色表（kind == "npc"，补的字段；服务器的快照里 npcs 和 actors 仍然分开）；本功能只接管 kind == "npc" 的点选。
## 请求全部走 ctx.act_once（一次性、不动 pending、不睡眠重试、可复用请求号）；网络层失败后重试沿用同一个请求号，键里带上对象（哪个 NPC、哪个话题 / 哪件商品和数量）。
## 三路输入的先后（事件 / /me / 动作回执）怎么处理，写在 client/docs/C6.md。纯逻辑在 npc_logic.gd，单测在 client/tests/。
## 隐私：成交文字只放在买家自己的菜单里，不进聊天、气泡、toast；NPC 的话（回执 text、话题 label）是服务器的固定文字，进网页一律 textContent。

const L := preload("res://scripts/features/npc_logic.gd")

const REACH_SLACK := 0.5  # 走到了之后位置可能还没跟上：留余量
const CLOSE_SLACK := 1.5  # 菜单开着时离 NPC 超过「够得着 + 这个余量」才自动收起（防抖动）
const WANT_WINDOW := 3.0  # 到了之后，等位置跟上的秒数
const FAR_WINDOW := 90.0  # 点了远处的 NPC 之后，最多等这么久的 you_arrived

var _sess: int = 0  # 会话代号：换人、离开加一；在途响应回来对不上就整个丢掉
var _gen: int = 0  # 菜单代号：开、关、换 NPC 加一；对不上的响应不再更新界面（请求号的记账照做）
var _me_id: String = ""
var _entered: bool = false
var _clock: float = 0.0  # 累计秒（不用墙钟）
var _acc: float = 0.0

# 菜单
var _open_id: String = ""
var _open_scene: String = ""
var _answer: Variant = null  # {text, topic}：保留最近一句，不是聊天记录
var _msg: Variant = null  # {scope: ask|buy, kind: ok|err, code, text}
var _recv_topics: Array = []  # 回执里的话题（/me 的 here.npcs 还没有这个 NPC 时的兜底）
var _recv_shop: Variant = null  # 回执里的货架（同上）
var _local_shop: Variant = null  # 买成功后本地减了库存的货架：只盖到下一份 /me 为止
var _far_note: bool = false  # too_far 之后：显示「走过去」
var _walking: bool = false  # 点了「走过去」，正在走
var _walk_gen: int = 0
var _closed_shop: bool = false  # buy 回了 closed：货架置灰
var _cool_until: float = 0.0  # 服务器毫秒；限流到什么时候（对居民而不是对菜单，所以关菜单不清）

# /me 的缓存
var _hn: Dictionary = {}  # NPC 编号 -> here.npcs 的条目
var _shops: Array = []  # here.shops

# 请求
var _pending: Dictionary = {}  # 键 -> 上次网络失败的请求号（键带对象，见 npc_logic 的 ask_key / buy_key）
var _inflight: Dictionary = {}  # "ask:<npc>" / "buy:<npc>" -> true
var _last_ack: Dictionary = {}
var _ack_n: int = 0
var _asks: int = 0
var _buys: int = 0
var _opens: int = 0

# 点远处的 NPC：只有在这里点出来（或点「走过去」）的那一个，到达后才开菜单
var _far_id: String = ""
var _far_until: float = 0.0
var _far_gen: int = 0
var _far_armed: bool = false
var _far_t0: float = 0.0
var _want_id: String = ""
var _want_until: float = 0.0
var _arrivals: int = 0


func _init() -> void:
	id = "npc"


func event_types() -> PackedStringArray:
	return PackedStringArray(["you_arrived", "nav_stopped"])


func wants_tick() -> bool:
	return true


func on_enter() -> void:
	_entered = true


func on_leave() -> void:
	_entered = false
	_reset_session()
	feed("reset")
	forget_state()


## 换人 / 离开：菜单、回答、货架、请求号、等待到达的记号、限流全部清空，在途响应作废
func _reset_session() -> void:
	_sess += 1
	_gen += 1
	_open_id = ""
	_open_scene = ""
	_clear_menu_state()
	_cool_until = 0.0
	_hn.clear()
	_shops = []
	_pending.clear()
	_inflight.clear()
	_last_ack = {}
	_ack_n = 0
	_far_id = ""
	_far_armed = false
	_want_id = ""
	_me_id = ""
	ctx.card_release(id)


func _clear_menu_state() -> void:
	_answer = null
	_msg = null
	_recv_topics = []
	_recv_shop = null
	_local_shop = null
	_far_note = false
	_walking = false
	_closed_shop = false


# ───────────────────────── 读 /me ─────────────────────────


func on_me(view: Dictionary) -> void:
	var me = view.get("me")
	var mid: String = str(me.get("id", "")) if me is Dictionary else ""
	if mid != "" and mid != _me_id:
		var had: bool = _me_id != ""
		if had:
			_reset_session()
			feed("reset")
			forget_state()
		_me_id = mid
	_hn.clear()
	_shops = []
	var here = view.get("here")
	if here is Dictionary:
		var ns = here.get("npcs")
		if ns is Array:
			for n in ns:
				if n is Dictionary and str(n.get("id", "")) != "":
					_hn[str(n["id"])] = n
		var ss = here.get("shops")
		if ss is Array:
			_shops = ss
	_local_shop = null  # 新的一份 /me 给准数
	_push()


func on_scene(_msg_in: Dictionary) -> void:
	if _open_id == "":
		return
	if ctx.cur_scene() != _open_scene or not ctx.actors().has(_open_id):
		_close_menu()


func on_resync() -> void:
	if _open_id != "":
		ctx.refresh_me()


# ───────────────────────── 事件 ─────────────────────────


func on_event(ev: Dictionary) -> void:
	var data: Dictionary = ev.get("data", {}) if ev.get("data") is Dictionary else {}
	match str(ev.get("type", "")):
		"nav_stopped":
			# 路线被服务器停了：不再等着开菜单，也不再算「正在走过去」
			_far_id = ""
			_want_id = ""
			if _walking:
				_walking = false
				_push()
		"you_arrived":
			_arrivals += 1
			var tg = data.get("target")
			# 这次到达是不是在这里点出来的：每次到达都把记号用掉，不留给下一次
			var mine: String = _far_id if _clock <= _far_until else ""
			_far_id = ""
			_far_armed = false
			if tg is Dictionary and str(tg.get("kind", "")) == "npc":
				var tid: String = str(tg.get("id", ""))
				if tid != "" and tid == mine and _is_npc(tid):
					_want_id = tid
					_want_until = _clock + WANT_WINDOW
				else:
					_want_id = ""
			else:
				_want_id = ""


# ───────────────────────── 点选 ─────────────────────────


func _is_npc(pid: String) -> bool:
	var a = ctx.actors().get(pid)
	return a != null and (a as TActor).kind == "npc"


func _dist_to(pid: String) -> float:
	var sa = ctx.actors().get(ctx.self_id())
	var a = ctx.actors().get(pid)
	if sa == null or a == null:
		return INF
	return ((a as TActor).disp as Vector2).distance_to((sa as TActor).disp)


func on_pick(kind: String, pid: String) -> bool:
	if kind != "actor" or not _is_npc(pid):
		_far_id = ""  # 改去点别的东西了：之前点的那个 NPC 不再等
		_far_armed = false
		return false
	if _open_id == pid:
		return true  # 防重入：这个 NPC 的菜单已经开着（连按两下 E、双击）
	if _dist_to(pid) <= ctx.c4_person_reach():
		_far_id = ""
		_far_armed = false
		_want_id = ""
		_open(pid)
		return true
	# 远处：不接管，main 接着去 approach。记下是在这里点的，ta 的 you_arrived 到了才开菜单
	_far_id = pid
	_far_until = _clock + FAR_WINDOW
	_far_gen = ctx.nav_gen()
	_far_armed = false
	_far_t0 = _clock
	return false


func _open(pid: String) -> void:
	if _open_id == pid or not _is_npc(pid):
		return
	ctx.card_claim(id)  # 一次只开一张卡：居民卡开着的话，它先收起
	_gen += 1
	_clear_menu_state()
	_open_id = pid
	_open_scene = ctx.cur_scene()
	_opens += 1
	ctx.mark_dirty()
	_push()
	ctx.refresh_me()  # 话题和货架取最新的；/me 回来后 on_me 会重推


func _close_menu() -> void:
	if _open_id == "":
		return
	_gen += 1
	_open_id = ""
	_open_scene = ""
	_clear_menu_state()
	ctx.card_release(id)
	ctx.mark_dirty()
	_push()


## 别的功能要开自己的浮层卡了（底座通知）：收起菜单
func on_card_yield() -> void:
	_close_menu()


# ───────────────────────── 网页 -> Godot ─────────────────────────


func on_ui(ui_name: String, arg: String) -> void:
	match ui_name:
		"close":
			_close_menu()
		"ask":
			await _ask(arg)
		"buy":
			await _buy(arg)
		"walk":
			_walk()


func _block_reason() -> String:
	if not ctx.control_mine():
		return "readonly"
	if ctx.in_game():
		return "game"
	if ctx.conn() == "offline":
		return "offline"
	return ""


func _walk() -> void:
	if _open_id == "" or _walking or not _far_note:
		return
	if not ctx.c6_approach(_open_id):
		return  # 被拦下（只读、走开确认）：main 已经提示
	_walking = true
	_walk_gen = ctx.nav_gen()
	# 也是在这里发起的走近：到了（you_arrived）照旧确认一下，位置跟上了就把「走过去」收起来
	_far_id = _open_id
	_far_until = _clock + FAR_WINDOW
	_far_armed = false
	_push()


func _topics() -> Array:
	var e: Dictionary = _hn.get(_open_id, {})
	var t: Array = L.topics_of(e.get("topics"))
	return t if not t.is_empty() else _recv_topics


func _shop_id() -> String:
	var e: Dictionary = _hn.get(_open_id, {})
	var s: String = str(e.get("shop", ""))
	if s == "" and _recv_shop is Dictionary:
		s = str(_recv_shop.get("id", ""))
	return s


## 现在要显示的货架：买成功后本地减过库存的 > 最近一份 /me 的 here.shops > 回执里的
func _shop() -> Dictionary:
	var sid: String = _shop_id()
	if sid == "":
		return {}
	if _local_shop is Dictionary and str((_local_shop as Dictionary).get("id", "")) == sid:
		return _local_shop
	return L.shop_view(sid, _shops, _recv_shop)


func _stock_of(shop: Dictionary, sku: String) -> int:
	var gl = shop.get("goods")
	if gl is Array:
		for g in gl:
			if str(g["sku"]) == sku:
				return int(g["stock"])
	return -1


func _ack(verb: String, code: String, extra: Dictionary = {}) -> void:
	_ack_n += 1
	_last_ack = {"n": _ack_n, "verb": verb, "code": code, "ok": code == "ok"}
	_last_ack.merge(extra, true)
	feed("ack", _last_ack)


func _ask(topic: String) -> void:
	if _open_id == "" or not L.has_topic(_topics(), topic):
		return
	if _block_reason() != "" or ctx.server_now() < _cool_until:
		return
	var npc: String = _open_id
	var ikey: String = "ask:" + npc
	if _inflight.has(ikey):
		return  # 这个 NPC 的上一次问话还在路上
	var key: String = L.ask_key(npc, topic)
	var rid: String = str(_pending.get(key, ""))
	if rid == "":
		rid = ctx.new_req_id()
	_inflight[ikey] = true
	_asks += 1
	var g: int = _gen
	var s: int = _sess
	_push()
	var r: Dictionary = await ctx.act_once({"type": "ask_npc", "npcId": npc, "topic": topic}, {"rid": rid})
	if s != _sess:
		return  # 期间离开 / 换人：结果不属于现在这个人
	_inflight.erase(ikey)
	var code: String = L.classify(r)
	if code == "stale":
		_push()
		return
	if L.keeps_rid(code):
		_pending[key] = str(r.get("rid", rid))  # 用户再点同一个 NPC 的同一个话题时带回同一个请求号
	else:
		_pending.erase(key)
	var live: bool = g == _gen and _open_id == npc
	var data = r.get("data")
	if code == "ok":
		var d: Dictionary = data if data is Dictionary else {}
		if live:
			_answer = {"text": str(d.get("text", "")), "topic": str(d.get("topic", topic))}
			_msg = null
			_closed_shop = false
			var tp: Array = L.topics_of(d.get("topics"))
			if not tp.is_empty():
				_recv_topics = tp
			if d.get("shop") is Dictionary:
				_recv_shop = d["shop"]
		_ack("ask", "ok", {"npc": npc, "stale": not live})
		_push()
		return
	if code == "rate_limited":
		var ms: int = int(r.get("retry_after_ms", 0))
		if ms > 0:
			_cool_until = L.cool_until(ctx.server_now(), ms)  # 对居民而不是对菜单：不管菜单还在不在都记
	elif L.closes_menu(code):
		ctx.toast("这会儿找不到它。", "info")
		ctx.refresh_me()
		if live:
			_close_menu()
	elif code == "too_far" and live:
		var nav_to: String = str(data.get("navigateTo", "")) if data is Dictionary else ""
		if nav_to == "" or nav_to == npc:
			_far_note = true
	if live and not L.closes_menu(code):
		_msg = {"scope": "ask", "kind": "err", "code": code, "text": str(r.get("message", ""))}
	_ack("ask", code, {"npc": npc, "stale": not live})
	_push()


func _buy(arg: String) -> void:
	var p = JSON.parse_string(arg)
	if not (p is Dictionary) or _open_id == "":
		return
	var sku: String = str(p.get("sku", ""))
	var shop: Dictionary = _shop()
	if shop.is_empty() or _stock_of(shop, sku) < 0:
		return  # 这家店没有这件货：网页只会发它列出来的，这里再核一遍
	if _block_reason() != "" or _closed_shop:
		return
	var npc: String = _open_id
	var ikey: String = "buy:" + npc
	if _inflight.has(ikey):
		return
	var qty: int = L.clamp_qty(int(p.get("qty", 1)), _stock_of(shop, sku))
	var key: String = L.buy_key(npc, str(shop["id"]), sku, qty)
	var rid: String = str(_pending.get(key, ""))
	if rid == "":
		rid = ctx.new_req_id()
	_inflight[ikey] = true
	_buys += 1
	var g: int = _gen
	var s: int = _sess
	_push()
	var r: Dictionary = await ctx.act_once({"type": "buy", "shop": str(shop["id"]), "sku": sku, "qty": qty}, {"rid": rid})
	if s != _sess:
		return
	_inflight.erase(ikey)
	var code: String = L.classify(r)
	if code == "stale":
		_push()
		return
	if L.keeps_rid(code):
		_pending[key] = str(r.get("rid", rid))
	else:
		_pending.erase(key)
	var live: bool = g == _gen and _open_id == npc
	var data = r.get("data")
	if code == "ok":
		var d: Dictionary = data if data is Dictionary else {}
		if live:
			# 成交文字只放在买家自己的菜单里（服务器的回执原文），不进聊天、气泡、toast
			_msg = {"scope": "buy", "kind": "ok", "code": "ok", "text": str(d.get("text", "")), "sku": sku}
			_local_shop = L.after_buy(_shop(), sku, qty)
		_ack("buy", "ok", {"npc": npc, "sku": sku, "qty": qty, "stale": not live})
		_push()
		ctx.refresh_me()  # 钱和背包变了，库存也变了
		return
	if code == "sold_out" and live:
		_local_shop = L.sold_out(_shop(), sku)
		ctx.refresh_me()
	elif code == "closed" and live:
		_closed_shop = true
	elif L.closes_menu(code):
		ctx.toast("这会儿找不到它。", "info")
		ctx.refresh_me()
		if live:
			_close_menu()
	elif code == "too_far" and live:
		var nav_to: String = str(data.get("navigateTo", "")) if data is Dictionary else ""
		if nav_to == "" or nav_to == npc:
			_far_note = true
	if live and not L.closes_menu(code):
		_msg = {"scope": "buy", "kind": "err", "code": code, "text": str(r.get("message", "")), "sku": sku}
	_ack("buy", code, {"npc": npc, "sku": sku, "qty": qty, "stale": not live})
	_push()


# ───────────────────────── 每帧 ─────────────────────────


func tick(dt: float, _now_ms: float) -> void:
	_clock += dt
	_acc += dt
	if _acc < 0.25:
		return
	_acc = 0.0
	var acts: Dictionary = ctx.actors()
	var sa = acts.get(ctx.self_id())
	if sa == null:
		return
	var reach: float = ctx.c4_person_reach()
	# 点了远处的 NPC：main 随后发 navigate（导航代号 +1）；中途改道、被顶掉、一直没发出，都不再等
	if _far_id != "":
		if _clock > _far_until or not _is_npc(_far_id):
			_far_id = ""
			_far_armed = false
		else:
			var st: Dictionary = L.far_step(true, _far_armed, _far_gen, ctx.nav_gen(), _clock - _far_t0)
			_far_armed = bool(st["armed"])
			_far_gen = int(st["gen"])
			if not bool(st["far"]):
				_far_id = ""
				_far_armed = false
	# 到了：等位置跟上再开
	if _want_id != "":
		if _clock > _want_until or not _is_npc(_want_id):
			_want_id = ""
		elif _dist_to(_want_id) <= reach + REACH_SLACK:
			var wid: String = _want_id
			_want_id = ""
			if not ctx.in_game():
				if _open_id == wid:
					_walking = false  # 走过去的按钮：到了
					_far_note = false
				else:
					_open(wid)
	# 菜单：NPC 还在不在、走远了没有、进了小游戏
	if _open_id != "":
		if not acts.has(_open_id) or ctx.cur_scene() != _open_scene or ctx.in_game():
			_close_menu()
		else:
			var d: float = _dist_to(_open_id)
			if _walking:
				if ctx.nav_gen() != _walk_gen:
					_walking = false  # 走的路上点了别处
				elif d <= reach:
					_walking = false
					_far_note = false
			elif d > reach + CLOSE_SLACK:
				_close_menu()
			elif d <= reach and _far_note:
				_far_note = false  # 自己走到跟前了：「走过去」不再需要
	_push()


# ───────────────────────── 名牌 ─────────────────────────


## 往 #tags 里追加 NPC 的名牌（main 的 _update_tags 跳过了 kind == "npc"）。NPC 牌的层级低于居民牌（hud.js 里 k 不是 s / a 的一律是 3），
## 并且和居民牌重叠超过一半就让位（不画）。k 是 "npc npc-<角色>"：类名 tag npc npc-service，样式在 mod/npc.css。
func tags(cam: Camera3D, size: Vector2, out: Array) -> void:
	# 排版用 CSS 像素（牌的尺寸是 CSS 的）；size 是画布的物理像素，网页端 screen_get_scale() 是 devicePixelRatio
	var dpr: float = maxf(1.0, DisplayServer.screen_get_scale())
	var rects: Array = []
	for t in out:
		if t is Dictionary and (str(t.get("k", "")) == "s" or str(t.get("k", "")) == "a"):
			var sz: Vector2 = L.tag_size(str(t.get("n", "")), false, str(t.get("k", "")) == "s")
			rects.append(L.tag_rect(float(t["x"]) * size.x / dpr, float(t["y"]) * size.y / dpr, sz))
	var acts: Dictionary = ctx.actors()
	for aid in acts:
		var a: TActor = acts[aid]
		if a.kind != "npc":
			continue
		var wp := Vector3(a.disp.x, 2.05, a.disp.y)
		if cam.is_position_behind(wp):
			continue
		var sp: Vector2 = cam.unproject_position(wp)
		var r: Rect2 = L.tag_rect(sp.x / dpr, sp.y / dpr, L.tag_size(a.actor_name, true))
		if L.tag_yields(r, rects):
			continue
		out.append({"i": str(aid), "n": a.actor_name, "x": snappedf(sp.x / size.x, 0.0005), "y": snappedf(sp.y / size.y, 0.0005), "k": "npc npc-" + (a.role if a.role != "" else "ambient"), "sel": str(aid) == _open_id})


# ───────────────────────── 推给网页 ─────────────────────────


func _state() -> Dictionary:
	var ctl: String = _block_reason()
	if _open_id == "":
		return {"open": false, "ctl": ctl}
	var a = ctx.actors().get(_open_id)
	var name: String = (a as TActor).actor_name if a != null else ""
	var role: String = (a as TActor).role if a != null else ""
	var shop: Dictionary = _shop()
	var cool: int = L.cool_secs(_cool_until, ctx.server_now())
	var out: Dictionary = {
		"open": true,
		"id": _open_id,
		"name": name,
		"role": role,
		"ctl": ctl,
		"topics": _topics(),
		"answer": _answer,
		"msg": _msg,
		"shop": shop if not shop.is_empty() else null,
		"shopClosed": _closed_shop,
		"busy": {"ask": _inflight.has("ask:" + _open_id), "buy": _inflight.has("buy:" + _open_id)},
		"cool": cool,
		"far": _far_note,
		"walking": _walking,
	}
	return out


func _push() -> void:
	if not _entered and _me_id == "":
		return
	feed_state(_state())


func debug() -> Dictionary:
	var shop: Dictionary = _shop() if _open_id != "" else {}
	var goods: Array = []
	if shop.has("goods"):
		for g in shop["goods"]:
			goods.append({"sku": g["sku"], "price": g["price"], "stock": g["stock"]})
	var tp: Array = []
	if _open_id != "":
		for t in _topics():
			tp.append(t["id"])
	return {
		"open": _open_id != "",
		"npcId": _open_id,
		"topics": tp,
		"answer": str((_answer as Dictionary).get("text", "")) if _answer is Dictionary else "",
		"shop": goods,
		"pending": _pending.keys(),
		"inflight": _inflight.keys(),
		"farId": _far_id,
		"wantId": _want_id,
		"walking": _walking,
		"farNote": _far_note,
		"closedShop": _closed_shop,
		"cool": L.cool_secs(_cool_until, ctx.server_now()),
		"opens": _opens,
		"asks": _asks,
		"buys": _buys,
		"arrivals": _arrivals,
		"lastAck": _last_ack,
		"me": _me_id,
		"gen": _gen,
		"sess": _sess,
	}
