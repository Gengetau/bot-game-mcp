extends SceneTree
## 全镇公屏（town.gd）的逻辑单测：无头 Godot 直接跑，不起浏览器、不用导出。
## 运行：bash client/tools/unit.sh（或 npm run client:unit）。ctx 换成桩，api_get 由测试手动放行，这样能精确造出「读更早与追新并发」「回执与回声的先后」这类时序。

const TownScript := preload("res://scripts/features/town.gd")

var _fails: int = 0
var _checks: int = 0


class Gate:
	extends RefCounted
	signal done(r)
	var path: String = ""


class RecBridge:
	extends TBridge
	var log: Array = []

	func hud_feed(feature: String, kind: String, json: String) -> void:
		log.append({"f": feature, "k": kind, "d": JSON.parse_string(json)})


class StubCtx:
	extends TCtx
	var br := RecBridge.new()
	var pending: Array = []
	var calls: Array = []
	var acts: Array = []

	func bridge() -> TBridge:
		return br

	func self_id() -> String:
		return "me"

	func control_mine() -> bool:
		return true

	func in_game() -> bool:
		return false

	func conn() -> String:
		return "ok"

	func ws_ready() -> bool:
		return true

	func cfg_limit(_k: String, d: int) -> int:
		return d

	func server_now() -> float:
		return 1000.0

	func new_req_id() -> String:
		return "rid"

	func toast(_t: String, _k: String = "info") -> void:
		pass

	func act_once(a: Dictionary, _o: Dictionary = {}) -> Dictionary:
		acts.append(a)
		return {"ok": true, "data": {"id": "own1"}}

	func api_get(path: String) -> Dictionary:
		calls.append(path)
		var g := Gate.new()
		g.path = path
		pending.append(g)
		return await g.done

	## 放行最早一个在途请求
	func answer(resp: Dictionary) -> void:
		var g: Gate = pending.pop_front()
		g.done.emit(resp)


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func msg(sid: String, mine: bool = false) -> Dictionary:
	return {"id": sid, "from": {"id": "me" if mine else "p1", "name": "x", "kind": "human"}, "kind": "chat", "text": "t " + sid, "at": 1000.0, "mine": mine}


func msgs(prefix: String, a: int, b: int) -> Array:
	var out: Array = []
	for i in range(a, b + 1):
		out.append(msg("%s%d" % [prefix, i]))
	return out


func ok(d: Dictionary) -> Dictionary:
	return {"status": 200, "data": d}


func make() -> Array:
	var c := StubCtx.new()
	var t = TownScript.new()
	t.ctx = c
	return [t, c]


## 进入并读完最近一页
func boot(t, c: StubCtx, page: Array, cursor: String, older) -> void:
	t.on_enter()
	t.on_hello({"townChat": {"cursor": cursor}}, false, true)
	c.answer(ok({"messages": page, "older": older, "cursor": cursor}))
	await process_frame


func sids(t) -> Array:
	var out: Array = []
	for e in t._msgs:
		out.append(e["sid"])
	return out


## sids 是否是 order 里的一段连续区间（中间不许断档）
func contiguous(list: Array, order: Array) -> bool:
	if list.is_empty():
		return true
	var i: int = order.find(list[0])
	if i < 0:
		return false
	for k in range(list.size()):
		if i + k >= order.size() or order[i + k] != list[k]:
			return false
	return true


func _init() -> void:
	await _run()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func _run() -> void:
	await t_older_vs_tail()
	await t_older_ok()
	await t_rcpt_no_rewind()
	await t_receipt_does_not_advance()
	await t_syncing_buffers()
	await t_hello_equal_skips()
	await t_resync_rebuilds()
	await t_ord_order()
	await t_leave_clears()
	await t_tick_after_leave()
	await t_older_cap()
	await t_older_truncate()


# 读更早与追新并发：更早那页回来之前列表因封顶从前面弹掉了几条，这页不能再接到最前面（否则中间断档）
func t_older_vs_tail() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	var first: Array = msgs("m", 1, 195)
	await boot(t, c, first, "c195", "o0")
	t.on_ui("older", "")
	check(c.pending.size() == 1, "older: 发出一个请求")
	var tail: Array = msgs("m", 196, 205)
	t.on_frame("town_chat", {"messages": tail, "cursor": "c205"})
	var page: Array = msgs("p", 1, 5)
	c.answer(ok({"messages": page, "older": "o5", "cursor": "c205"}))
	await process_frame
	var order: Array = []
	order.append_array(page)
	for m in first + tail:
		order.append(m["id"])
	var ids: Array = []
	for m in page:
		ids.append(m["id"])
	ids.append_array(order.slice(5))
	check(t._msgs.size() <= 200, "older 并发: 不超过 200 条（%d）" % t._msgs.size())
	check(contiguous(sids(t), ids), "older 并发: 列表是服务端顺序里的连续一段，没有断档")
	var front: String = str(t._msgs[0]["sid"])
	check(not t._has_older or t._older == front or t._older == "o5", "older 并发: _older 指向当前最旧一条或页的更早游标")
	check(not t._older_busy, "older 并发: 读完后不再忙")


# 没有并发时：更早的一页照常接到最前面
func t_older_ok() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 6, 10), "c10", "o5")
	t.on_ui("older", "")
	c.answer(ok({"messages": msgs("m", 1, 5), "older": null, "cursor": "c10"}))
	await process_frame
	check(sids(t) == ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"], "older 正常: 顺序对")
	check(not t._has_older, "older 正常: 到头后 _has_older 为假")


# 回执补进列表后，晚到的回声帧不能把 _after 拨回比 HTTP 补读更旧的值
func t_rcpt_no_rewind() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, [msg("a1")], "c1", null)
	t._add_receipt("own1", "hi", "chat", "")
	check(t._rcpt.has("own1"), "回执: 记下 _rcpt")
	check(t._after == "c1", "回执: 不推进 _after")
	t.on_hello({"townChat": {"cursor": "c9"}}, false, false)  # 水位对不上：开始补读
	check(t._syncing, "补读: 进入同步")
	t.on_frame("town_chat", {"messages": [msg("own1", true)], "cursor": "c2"})  # 回声在补读期间到，进缓冲
	check(t._buf.size() == 1, "补读: 回声进缓冲")
	c.answer(ok({"messages": [msg("own1", true), msg("x1")], "cursor": "c9"}))
	await process_frame
	check(t._after == "c9", "补读后排空缓冲: _after 仍是 HTTP 页的水位 c9（实际 %s）" % t._after)
	check(sids(t).count("own1") == 1, "补读: 自己那句恰一条")


# 回执只补列表，不推进 _after；回声帧到了才推进
func t_receipt_does_not_advance() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, [msg("a1")], "c1", null)
	t._add_receipt("own1", "hi", "chat", "")
	check(t._after == "c1", "回执不推进 _after")
	t.on_frame("town_chat", {"messages": [msg("own1", true)], "cursor": "c2"})
	check(t._after == "c2", "回声帧推进 _after")
	check(sids(t).count("own1") == 1, "回执与回声恰一条")


# 同步期间到的帧只进缓冲，不直接入列表；读完后按序排空
func t_syncing_buffers() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, [msg("a1")], "c1", null)
	t.on_hello({"townChat": {"cursor": "c2"}}, false, false)
	t.on_frame("town_chat", {"messages": [msg("b2")], "cursor": "c3"})  # 连接之后的新话，补读还没回来
	check(sids(t) == ["a1"], "同步期间: 帧不直接入列表")
	check(t._buf.size() == 1, "同步期间: 帧进缓冲")
	c.answer(ok({"messages": [msg("b1")], "cursor": "c2"}))
	await process_frame
	check(sids(t) == ["a1", "b1", "b2"], "同步后: 先 HTTP 结果再缓冲，顺序对（%s）" % str(sids(t)))


# hello 水位和 _after 相等：断线期间没有新话，不读
func t_hello_equal_skips() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, [msg("a1")], "c1", null)
	var n: int = c.calls.size()
	t.on_hello({"townChat": {"cursor": "c1"}}, false, false)
	check(c.calls.size() == n and not t._syncing, "水位相等: 不发请求")
	t.on_hello({"townChat": {"cursor": "c7"}}, false, false)
	check(c.calls.size() == n + 1, "水位不等: 补读一次")
	c.answer(ok({"messages": [], "cursor": "c7"}))
	await process_frame


# resync：旧列表整体丢掉，重读最近一页，旧的行不残留
func t_resync_rebuilds() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 1, 3), "c3", null)
	t.on_hello({"townChat": {"cursor": "c9"}}, false, false)
	c.answer(ok({"messages": [], "older": null, "cursor": "c9", "resync": true}))
	await process_frame
	check(c.pending.size() == 1 and "after=" not in c.pending[0].path, "resync: 随后不带游标重读最近一页")
	c.answer(ok({"messages": msgs("n", 1, 2), "older": null, "cursor": "c9"}))
	await process_frame
	check(sids(t) == ["n1", "n2"], "resync: 列表只剩新读的（%s）" % str(sids(t)))
	check(not t._seen.has("m1"), "resync: _seen 里没有旧的")
	check(t._resyncs == 1, "resync: 计数 1")


# 读更早的页按 --_lo 编号，所以 ord 永远和服务端顺序一致
func t_ord_order() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 4, 6), "c6", "o3")
	t.on_ui("older", "")
	c.answer(ok({"messages": msgs("m", 1, 3), "older": null, "cursor": "c6"}))
	await process_frame
	var last: int = -999999
	var asc: bool = true
	for e in t._msgs:
		if int(e["ord"]) <= last:
			asc = false
		last = int(e["ord"])
	check(asc, "ord: 严格升序")
	check(sids(t) == ["m1", "m2", "m3", "m4", "m5", "m6"], "ord: 顺序对")


# 离开：列表、_seen、静音、名字、待发状态全清
func t_leave_clears() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 1, 3), "c3", null)
	t._muted = true
	t._my_name = "甲"
	t.on_leave()
	check(t._msgs.is_empty() and t._seen.is_empty(), "离开: 列表与 _seen 清空")
	check(not t._muted and t._my_name == "", "离开: 静音与名字清空")
	check(t._after == "" and not t._loaded, "离开: 游标与已读状态清空")
	t.on_leave()  # 幂等
	check(t._msgs.is_empty() and t._after == "", "离开: 再离开一次仍是空的")


# 离开之后 tick 不能再向网页推 state（会在登出状态下显示读取中）
func t_tick_after_leave() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 1, 3), "c3", null)
	t.on_leave()
	c.br.log.clear()
	t.tick(1.0, 0.0)
	var states: int = 0
	for e in c.br.log:
		if e["k"] == "state":
			states += 1
	check(states == 0, "离开后 tick 不推 state（推了 %d 次）" % states)
	t.on_enter()
	c.br.log.clear()
	t.tick(1.0, 0.0)
	var again: int = 0
	for e in c.br.log:
		if e["k"] == "state":
			again += 1
	check(again <= 1, "重新进入后 tick 照常（不会刷屏）")


# 封顶：读更早的一页只取得下 200 - size 条
func t_older_cap() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 101, 297), "c297", "o100")  # 197 条
	t.on_ui("older", "")
	check("limit=3" in c.pending[0].path, "封顶: 只要 200 - 197 = 3 条（%s）" % c.pending[0].path)
	c.answer(ok({"messages": msgs("m", 98, 100), "older": "o97", "cursor": "c297"}))
	await process_frame
	check(t._msgs.size() == 200, "封顶: 恰 200 条")
	check(not (t._has_older and t._msgs.size() < 200), "封顶: 到顶后不再显示按钮由界面按 atCap 处理")


# 等待期间追新把列表填满了一部分：更早的一页只留得下的那几条（紧挨着现在最前面的），_older 从截断处接着读
func t_older_truncate() -> void:
	var r = make()
	var t = r[0]
	var c: StubCtx = r[1]
	await boot(t, c, msgs("m", 101, 290), "c290", "o100")  # 190 条
	t.on_ui("older", "")
	check("limit=10" in c.pending[0].path, "截断: 请求 10 条（%s）" % c.pending[0].path)
	t.on_frame("town_chat", {"messages": msgs("m", 291, 293), "cursor": "c293"})  # 193 条，没有封顶弹出
	c.answer(ok({"messages": msgs("m", 90, 99), "older": "o89", "cursor": "c293"}))
	await process_frame
	check(t._msgs.size() == 200, "截断: 恰 200 条（%d）" % t._msgs.size())
	check(str(t._msgs[0]["sid"]) == "m93", "截断: 最前面是紧挨着原来最前面的 m93..m99 里最旧的（%s）" % str(t._msgs[0]["sid"]))
	check(t._older == "m93" and t._has_older, "截断: _older 是现在最旧一条（%s）" % t._older)
