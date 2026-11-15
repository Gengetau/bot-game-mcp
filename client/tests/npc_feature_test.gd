extends SceneTree
## npc.gd 的功能级单测：用假的 ctx（继承 TCtx、覆盖要用到的口子）直接喂 on_me / on_event / on_pick / on_ui / tick，不起浏览器。
## 覆盖的先后顺序（详见 client/docs/C6.md 的「输入先后」一节）：
##  - 点选：近处直接开；连点两下只开一次；远处不接管，只有「在这里点的」那个 NPC 的 you_arrived 才开；别的目标 / 别的 NPC 的 you_arrived 不开；
##  - 回执迟到：问话在路上时离开 / 换人（整个丢掉）、关菜单再开另一个 NPC（不写进新菜单，但请求号照记）；
##  - 网络层失败：同一个 NPC 的同一个话题、同一件商品同一个数量沿用同一个请求号；换话题 / 换商品 / 换数量 / 换 NPC 用新的；
##  - 同一个 NPC 上一次问话还在路上时，再点不再发请求；限流：服务器给的 retry_after_ms 之内不发；
##  - 迟到的旧 /me：买成功后本地库存减过，新的 /me 到了才用它的数；
##  - 菜单自动收起：场景换了、NPC 不在了、进了小游戏、走远了；
##  - 一次只开一张卡：别的功能 claim 之后菜单收起；居民卡对 NPC 目标不接管。
## 用法：npm run client:unit

const Npc := preload("res://scripts/features/npc.gd")
const People := preload("res://scripts/features/people.gd")

const SELF := "r_me"
const KEEPER := "npc:teahouse_keeper"
const STROLL := "npc:plaza_stroller"

var _fails: int = 0
var _checks: int = 0


class FakeCtx:
	extends TCtx
	signal act_release
	var toasts: Array = []
	var acts: Dictionary = {}
	var act_calls: Array = []
	var act_opts: Array = []
	var act_queue: Array = []  # 先进先出的结果；空了用 act_default
	var act_default: Dictionary = {"ok": true, "data": {}}
	var hold_act: bool = false
	var refreshes: int = 0
	var scene: String = "town"
	var ingame: bool = false
	var reach: float = 3.0
	var gen: int = 0
	var now_ms: float = 100000.0
	var owner_fid: String = ""
	var feature_by_id: Dictionary = {}
	var approaches: Array = []
	var _br := TBridge.new()

	func bridge() -> TBridge:
		return _br

	func self_id() -> String:
		return SELF

	func actors() -> Dictionary:
		return acts

	func control_mine() -> bool:
		return true

	func in_game() -> bool:
		return ingame

	func conn() -> String:
		return "ok"

	func cur_scene() -> String:
		return scene

	func server_now() -> float:
		return now_ms

	func c4_person_reach() -> float:
		return reach

	func nav_gen() -> int:
		return gen

	func c6_approach(aid: String) -> bool:
		approaches.append(aid)
		gen += 1  # main 的 _do_navigate 同步加一
		return true

	func toast(text: String, kind: String = "info") -> void:
		toasts.append({"text": text, "kind": kind})

	func refresh_me() -> void:
		refreshes += 1

	func mark_dirty() -> void:
		pass

	func new_req_id() -> String:
		return "rid_%d" % act_calls.size()

	func card_claim(fid: String) -> void:
		var prev: String = owner_fid
		owner_fid = fid
		if prev != "" and prev != fid and feature_by_id.has(prev):
			(feature_by_id[prev] as TFeature).on_card_yield()

	func card_release(fid: String) -> void:
		if owner_fid == fid:
			owner_fid = ""

	func act_once(action: Dictionary, opts: Dictionary = {}) -> Dictionary:
		act_calls.append(action)
		act_opts.append(opts)
		if hold_act:
			await act_release
		if not act_queue.is_empty():
			return act_queue.pop_front()
		return act_default


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	_run()


func _actor(c: FakeCtx, id: String, kind: String, pos: Vector2, role: String = "") -> TActor:
	var a := TActor.new()
	a.actor_id = id
	a.actor_name = id
	a.kind = kind
	a.role = role
	a.disp = pos
	c.acts[id] = a
	return a


func _make() -> Array:
	var c := FakeCtx.new()
	_actor(c, SELF, "human", Vector2(0, 0))
	_actor(c, KEEPER, "npc", Vector2(1, 0), "service")
	_actor(c, STROLL, "npc", Vector2(30, 0), "ambient")
	var f = Npc.new()
	f.ctx = c
	c.feature_by_id["npc"] = f
	f.on_enter()
	f.on_me(_me())
	return [f, c]


func _me(goods_stock: int = 30) -> Dictionary:
	return {
		"me": {"id": SELF},
		"here": {
			"npcs": [
				{"id": KEEPER, "name": "茶馆掌柜", "role": "service", "topics": [{"id": "hello", "label": "打个招呼"}, {"id": "tea", "label": "聊聊茶"}], "shop": "tea_counter"},
				{"id": STROLL, "name": "闲逛的人", "role": "ambient", "topics": [{"id": "hello", "label": "打个招呼"}]},
			],
			"shops": [{"id": "tea_counter", "name": "茶柜", "goods": [{"sku": "tea_leaves", "name": "茶叶", "price": 2, "stock": goods_stock}]}],
		},
	}


func _ok_ask(text: String = "客官好") -> Dictionary:
	return {"ok": true, "data": {"status": "completed", "text": text, "topic": "hello", "topics": [{"id": "hello", "label": "打个招呼"}]}}


func _net() -> Dictionary:
	return {"ok": false, "net_fail": true, "rid": "net_rid", "error": "net"}


func _err(code: String, extra: Dictionary = {}) -> Dictionary:
	var r: Dictionary = {"ok": false, "error": code, "reason": code, "message": "服务器说：" + code, "data": {}}
	r.merge(extra, true)
	return r


func _run() -> void:
	t_pick_near_and_reentry()
	t_pick_far_arrival()
	t_arrival_wrong_target()
	await t_ask_basic_and_dup()
	await t_net_fail_rid_per_object()
	await t_buy_rid_per_object()
	await t_rate_limited()
	await t_late_after_leave()
	await t_late_after_switch_npc()
	await t_not_here_closes()
	await t_buy_flow()
	await t_buy_errors()
	await t_too_far_walk()
	t_stale_me_overrides_local()
	t_auto_close()
	t_card_exclusive()
	t_people_ignores_npc()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func t_pick_near_and_reentry() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	check(f.on_pick("actor", KEEPER), "近处点掌柜：接管")
	check(f.debug()["open"] and f.debug()["npcId"] == KEEPER, "菜单开在掌柜上")
	var opens: int = f.debug()["opens"]
	check(f.on_pick("actor", KEEPER), "再点一次（连按两下 E）：仍接管，不重开")
	check(f.debug()["opens"] == opens, "只开了一次")
	check(c.act_calls.is_empty(), "开菜单不发任何动作")
	check(not f.on_pick("actor", SELF), "点自己：不接管")
	check(not f.on_pick("object", KEEPER), "点物件：不接管")
	check(c.refreshes >= 1, "开菜单时读了一份 /me")


func t_pick_far_arrival() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	check(not f.on_pick("actor", STROLL), "远处点闲逛者：不接管（main 去走）")
	check(f.debug()["farId"] == STROLL, "记下了是在这里点的")
	c.gen += 1  # main 发出 navigate
	f.tick(0.3, 0.0)
	(c.acts[STROLL] as TActor).disp = Vector2(1.5, 0)
	f.on_event({"type": "you_arrived", "data": {"target": {"kind": "npc", "id": STROLL}}})
	f.tick(0.3, 0.0)
	check(f.debug()["open"] and f.debug()["npcId"] == STROLL, "到达之后开菜单")


func t_arrival_wrong_target() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	# 别处发起的走近（没点过）到达：不开
	f.on_event({"type": "you_arrived", "data": {"target": {"kind": "npc", "id": KEEPER}}})
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "没在这里点过：到达不弹菜单")
	# 点了闲逛者，到达的是掌柜：不开掌柜
	f.on_pick("actor", STROLL)
	c.gen += 1
	f.on_event({"type": "you_arrived", "data": {"target": {"kind": "npc", "id": KEEPER}}})
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "点的是闲逛者、到的是掌柜：不开")
	# 居民目标的到达不动 NPC 的记号
	f.on_pick("actor", STROLL)
	f.on_event({"type": "you_arrived", "data": {"target": {"kind": "actor", "id": "r_other"}}})
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "居民目标的到达：不开")


func t_ask_basic_and_dup() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_ok_ask("欢迎"))
	await f.on_ui("ask", "hello")
	check(c.act_calls.size() == 1 and c.act_calls[0]["type"] == "ask_npc" and c.act_calls[0]["npcId"] == KEEPER and c.act_calls[0]["topic"] == "hello", "发了 ask_npc")
	check(f.debug()["answer"] == "欢迎", "回话写进菜单")
	# 不在话题列表里的话题不发
	await f.on_ui("ask", "nonsense")
	check(c.act_calls.size() == 1, "未知话题不发请求")
	# 在途时再点：只一次
	c.hold_act = true
	f.on_ui("ask", "tea")
	f.on_ui("ask", "tea")
	f.on_ui("ask", "hello")
	check(c.act_calls.size() == 2, "上一次问话还在路上：再点不再发（共 2 次）")
	c.hold_act = false
	c.act_release.emit()
	await process_frame
	check(f.debug()["inflight"].is_empty(), "回执回来后在途记号清掉")


func t_net_fail_rid_per_object() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_net())
	await f.on_ui("ask", "hello")
	var rid1: String = str(c.act_opts[0].get("rid", ""))
	c.act_queue.append(_net())
	await f.on_ui("ask", "hello")
	check(str(c.act_opts[1].get("rid", "")) == "net_rid", "网络失败后重试沿用服务器给回的请求号")
	c.act_queue.append(_ok_ask())
	await f.on_ui("ask", "tea")
	check(str(c.act_opts[2].get("rid", "")) != "net_rid", "换一个话题：不用上次的请求号")
	check(rid1 != "", "第一次也带了请求号")
	c.act_queue.append(_ok_ask())
	await f.on_ui("ask", "hello")
	check(str(c.act_opts[3].get("rid", "")) == "net_rid", "回到原话题仍是 net_rid（失败的键还在）")
	c.act_queue.append(_ok_ask())
	await f.on_ui("ask", "hello")
	check(str(c.act_opts[4].get("rid", "")) != "net_rid", "成功之后记号清掉，下一次是新的请求号")


func t_buy_rid_per_object() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_net())
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 1}))
	c.act_queue.append(_net())
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 1}))
	check(str(c.act_opts[1].get("rid", "")) == "net_rid", "同一件同一数量重试：沿用请求号")
	c.act_queue.append(_ok_ask())
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 2}))
	check(str(c.act_opts[2].get("rid", "")) != "net_rid", "换了数量：新的请求号")
	check(c.act_calls[0]["type"] == "buy" and c.act_calls[0]["shop"] == "tea_counter" and c.act_calls[0]["sku"] == "tea_leaves" and c.act_calls[0]["qty"] == 1, "buy 的参数")
	# 不是货架上的商品：不发
	var n: int = c.act_calls.size()
	await f.on_ui("buy", JSON.stringify({"sku": "nope", "qty": 1}))
	check(c.act_calls.size() == n, "货架上没有的商品不发请求")
	# 数量夹到 1..10 且不超过库存
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 99}))
	check(c.act_calls[c.act_calls.size() - 1]["qty"] == 10, "数量最多 10")


func t_rate_limited() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_err("rate_limited", {"reason": "npc", "retry_after_ms": 5000}))
	await f.on_ui("ask", "hello")
	check(f.debug()["cool"] > 0, "限流：记下冷却")
	var n: int = c.act_calls.size()
	await f.on_ui("ask", "hello")
	check(c.act_calls.size() == n, "冷却内不再发")
	c.now_ms += 6000.0
	c.act_queue.append(_ok_ask())
	await f.on_ui("ask", "hello")
	check(c.act_calls.size() == n + 1, "冷却过了可以再发")
	# 限流对居民而不是对菜单：关了再开仍在冷却
	c.act_queue.append(_err("rate_limited", {"reason": "npc", "retry_after_ms": 5000}))
	await f.on_ui("ask", "hello")
	f.on_ui("close", "")
	f.on_pick("actor", KEEPER)
	var m: int = c.act_calls.size()
	await f.on_ui("ask", "hello")
	check(c.act_calls.size() == m, "关了再开：冷却还在")


func t_late_after_leave() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.hold_act = true
	f.on_ui("ask", "hello")
	f.on_leave()
	c.hold_act = false
	c.act_queue.append(_ok_ask("不该看到"))
	c.act_release.emit()
	await process_frame
	check(f.debug()["answer"] == "" and not f.debug()["open"], "离开后迟到的回执：整个丢掉")
	check(f.debug()["lastAck"].is_empty(), "也没有留下回执记号")


func t_late_after_switch_npc() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	(c.acts[STROLL] as TActor).disp = Vector2(1, 1)
	f.on_pick("actor", KEEPER)
	c.hold_act = true
	f.on_ui("ask", "hello")
	f.on_ui("close", "")
	f.on_pick("actor", STROLL)
	c.hold_act = false
	c.act_queue.append(_ok_ask("掌柜的话"))
	c.act_release.emit()
	await process_frame
	check(f.debug()["npcId"] == STROLL and f.debug()["answer"] == "", "关掉掌柜、开了闲逛者之后迟到的回话：不写进新菜单")
	check(f.debug()["lastAck"].get("stale", false) == true, "回执标成 stale")
	# 网络失败的迟到回执：请求号照记（同一个 NPC 的同一话题）
	f.on_ui("close", "")
	f.on_pick("actor", KEEPER)
	c.hold_act = true
	f.on_ui("ask", "tea")
	f.on_ui("close", "")
	c.hold_act = false
	c.act_queue.append(_net())
	c.act_release.emit()
	await process_frame
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_ok_ask())
	await f.on_ui("ask", "tea")
	check(str(c.act_opts[c.act_opts.size() - 1].get("rid", "")) == "net_rid", "菜单关掉后迟到的网络失败：请求号仍记着，再开再问沿用")


func t_not_here_closes() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_err("not_here"))
	await f.on_ui("ask", "hello")
	check(not f.debug()["open"], "not_here：关菜单")
	check(c.toasts.size() == 1, "提示一句")


func t_buy_flow() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	check(f.debug()["shop"].size() == 1 and f.debug()["shop"][0]["stock"] == 30, "货架来自 here.shops")
	c.act_queue.append({"ok": true, "data": {"status": "completed", "bought": 2, "coins": 5, "text": "买了 2 件茶叶，花了 4 枚硬币。"}})
	var r0: int = c.refreshes
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 2}))
	check(f.debug()["shop"][0]["stock"] == 28, "买成功：本地库存先减")
	check(c.refreshes > r0, "买成功之后读一份 /me")
	check(c.toasts.is_empty(), "成交文字不进 toast")
	f.on_me(_me(28))
	check(f.debug()["shop"][0]["stock"] == 28, "新的 /me 到了用它的数")


func t_buy_errors() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_err("sold_out"))
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 1}))
	check(f.debug()["shop"][0]["stock"] == 0, "sold_out：本地库存归零")
	c.act_queue.append(_err("closed"))
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 1}))
	check(f.debug()["closedShop"] == true, "closed：货架置灰")
	var n: int = c.act_calls.size()
	await f.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 1}))
	check(c.act_calls.size() == n, "置灰后不再发 buy")
	# 钱不够：显示服务器文字，不关菜单
	var p2: Array = _make()
	var f2 = p2[0]
	var c2: FakeCtx = p2[1]
	f2.on_pick("actor", KEEPER)
	c2.act_queue.append(_err("insufficient_coins"))
	await f2.on_ui("buy", JSON.stringify({"sku": "tea_leaves", "qty": 1}))
	check(f2.debug()["open"], "硬币不够：菜单还开着")
	check(c2.toasts.is_empty(), "硬币不够：不弹 toast，文字留在菜单里")


func t_too_far_walk() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.act_queue.append(_err("too_far", {"data": {"navigateTo": KEEPER}}))
	await f.on_ui("ask", "hello")
	check(f.debug()["farNote"] == true, "too_far：显示「走过去」")
	f.on_ui("walk", "")
	check(c.approaches == [KEEPER], "点「走过去」：走向这个 NPC")
	check(f.debug()["walking"] == true, "正在走")
	(c.acts[KEEPER] as TActor).disp = Vector2(0.5, 0)
	f.tick(0.3, 0.0)
	check(not f.debug()["walking"], "到了：不再显示正在走")


func t_stale_me_overrides_local() -> void:
	var p: Array = _make()
	var f = p[0]
	f.on_pick("actor", KEEPER)
	f.on_me(_me(7))
	check(f.debug()["shop"][0]["stock"] == 7, "/me 的库存直接用")


func t_auto_close() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	f.on_pick("actor", KEEPER)
	c.scene = "home_x"
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "场景换了：收起")
	c.scene = "town"
	f.on_pick("actor", KEEPER)
	c.ingame = true
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "进了小游戏：收起")
	c.ingame = false
	f.on_pick("actor", KEEPER)
	(c.acts[KEEPER] as TActor).disp = Vector2(20, 0)
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "走远了：收起")
	f.on_pick("actor", KEEPER)
	(c.acts[KEEPER] as TActor).disp = Vector2(1, 0)
	f.on_pick("actor", KEEPER)
	c.acts.erase(KEEPER)
	f.tick(0.3, 0.0)
	check(not f.debug()["open"], "NPC 不在了：收起")


func t_card_exclusive() -> void:
	var p: Array = _make()
	var f = p[0]
	var c: FakeCtx = p[1]
	c.owner_fid = "people"
	f.on_pick("actor", KEEPER)
	check(c.owner_fid == "npc", "开菜单：卡的主人换成 npc")
	c.card_claim("people")
	check(not f.debug()["open"], "居民卡 claim：菜单收起")
	f.on_pick("actor", KEEPER)
	f.on_ui("close", "")
	check(c.owner_fid == "", "关菜单：释放")


func t_people_ignores_npc() -> void:
	var c := FakeCtx.new()
	_actor(c, SELF, "human", Vector2(0, 0))
	_actor(c, KEEPER, "npc", Vector2(1, 0), "service")
	var f = People.new()
	f.ctx = c
	f.on_enter()
	check(not f.on_pick("actor", KEEPER), "居民卡不接管 NPC")
	f.on_event({"type": "you_arrived", "data": {"target": {"kind": "npc", "id": KEEPER}}})
	f.tick(0.3, 0.0)
	check(f.debug().get("cardId", "") == "" if f.debug().has("cardId") else true, "NPC 目标的到达不开居民卡")
