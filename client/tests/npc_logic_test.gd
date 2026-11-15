extends SceneTree
## npc_logic.gd 的纯逻辑单测：名牌让位、回执分类、限流倒计时、数量夹取、请求号的键、货架合并、远处点选的「是在这里点的」窗口。
## 用法：npm run client:unit

const L := preload("res://scripts/features/npc_logic.gd")

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	t_tags()
	t_classify()
	t_cool()
	t_qty()
	t_keys()
	t_shop()
	t_far()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


func t_tags() -> void:
	var npc := L.tag_rect(100, 100, Vector2(80, 22))
	check(not L.tag_yields(npc, []), "没有别的牌：不让位")
	check(L.tag_yields(npc, [L.tag_rect(100, 100, Vector2(60, 22))]), "完全盖住：让位")
	check(not L.tag_yields(npc, [L.tag_rect(300, 100, Vector2(60, 22))]), "离得远：不让位")
	# 只重叠一小条（<一半）：不让位；重叠超过较小那块的一半：让位
	check(not L.tag_yields(npc, [L.tag_rect(165, 100, Vector2(60, 22))]), "擦边：不让位")
	check(L.tag_yields(npc, [L.tag_rect(130, 100, Vector2(60, 22))]), "重叠过半：让位")
	check(not L.tag_yields(Rect2(), [npc]), "空矩形：不让位")
	check(L.tag_size("掌柜", true).x > L.tag_size("掌柜", false).x, "NPC 牌多一个小标记的宽度")


func t_classify() -> void:
	check(L.classify({"ok": true}) == "ok", "ok")
	check(L.classify({"ok": false, "net_fail": true}) == "net", "网络失败")
	check(L.classify({"ok": false, "error": "stale_session"}) == "stale", "会话作废")
	check(L.classify({"ok": false, "error": "rate_limited", "reason": "npc"}) == "rate_limited", "限流：error 优先于 reason（reason 是桶名）")
	check(L.classify({"ok": false, "error": "action_failed", "reason": "too_far"}) == "too_far", "reason")
	check(L.classify({"ok": false, "error": "not_found"}) == "not_found", "没有 reason 用 error")
	check(L.classify({"ok": false}) == "unknown", "什么都没有")
	check(L.closes_menu("not_here") and L.closes_menu("not_found") and not L.closes_menu("too_far"), "哪些失败关菜单")
	check(L.keeps_rid("net") and not L.keeps_rid("too_far"), "只有网络失败沿用请求号")


func t_cool() -> void:
	var until: float = L.cool_until(1000.0, 2500)
	check(until == 3500.0, "到期时刻")
	check(L.cool_secs(until, 1000.0) == 3, "剩余秒数向上取整")
	check(L.cool_secs(until, 3499.0) == 1, "最后一毫秒还算一秒")
	check(L.cool_secs(until, 3500.0) == 0, "到点为 0")
	check(L.cool_until(1000.0, -5) == 1000.0, "负数当 0")


func t_qty() -> void:
	check(L.clamp_qty(0) == 1 and L.clamp_qty(-3) == 1, "至少 1")
	check(L.clamp_qty(50) == 10, "最多 10")
	check(L.clamp_qty(8, 3) == 3, "不超过库存")
	check(L.clamp_qty(5, 0) == 5, "库存 0（未知或卖完）不再夹")


func t_keys() -> void:
	check(L.ask_key("npc:a", "hello") != L.ask_key("npc:b", "hello"), "ask 键带 NPC")
	check(L.ask_key("npc:a", "hello") != L.ask_key("npc:a", "tea"), "ask 键带话题")
	check(L.buy_key("npc:a", "s", "x", 1) != L.buy_key("npc:a", "s", "x", 2), "buy 键带数量")
	check(L.buy_key("npc:a", "s", "x", 1) != L.buy_key("npc:a", "s", "y", 1), "buy 键带商品")
	check(L.buy_key("npc:a", "s", "x", 1) != L.buy_key("npc:b", "s", "x", 1), "buy 键带 NPC")


func t_shop() -> void:
	var here := [{"id": "tea_counter", "name": "茶柜", "goods": [{"sku": "tea_leaves", "name": "茶叶", "price": 2, "stock": 30}, {"name": "没有 sku"}]}]
	var v: Dictionary = L.shop_view("tea_counter", here)
	check(v["goods"].size() == 1 and v["goods"][0]["price"] == 2, "here.shops：丢掉没有 sku 的")
	check(L.shop_view("x", here).is_empty(), "没有这家店")
	var rv: Dictionary = L.shop_view("tea_counter", [], {"id": "tea_counter", "name": "茶柜", "goods": [{"sku": "tea_leaves", "name": "茶叶", "price": 2, "stock": 5}]})
	check(rv["goods"][0]["stock"] == 5, "here.shops 没有时用回执里的")
	var after: Dictionary = L.after_buy(v, "tea_leaves", 3)
	check(after["goods"][0]["stock"] == 27 and v["goods"][0]["stock"] == 30, "买后库存减、不改原件")
	check(L.sold_out(v, "tea_leaves")["goods"][0]["stock"] == 0, "卖完：归零")
	check(L.after_buy(v, "tea_leaves", 100)["goods"][0]["stock"] == 0, "不会减成负数")
	check(L.topics_of([{"id": "a", "label": "甲"}, {"id": "b"}, 3]).size() == 1, "话题：两样都有才收")
	check(L.npc_entry([{"id": "n1"}], "n1")["id"] == "n1" and L.npc_entry([], "n1").is_empty(), "找 NPC 条目")


func t_far() -> void:
	var s: Dictionary = L.far_step(true, false, 5, 5, 0.5)
	check(s["far"] and not s["armed"], "点了还没发出：等")
	s = L.far_step(true, false, 5, 6, 0.5)
	check(s["far"] and s["armed"] and s["gen"] == 6, "导航代号 +1：就是我们要等的那一次")
	s = L.far_step(true, true, 6, 7, 1.0)
	check(not s["far"], "走的路上点了别处：作废")
	s = L.far_step(true, false, 5, 5, 2.5)
	check(not s["far"], "一直没发出（被拦下）：超过 2 秒作废")
	s = L.far_step(true, false, 5, 8, 0.1)
	check(not s["far"], "一口气变了不止一次：作废")
	s = L.far_step(true, true, 6, 6, 40.0)
	check(s["far"], "走着没改道：一直等")
	check(not L.far_step(false, false, 1, 1, 0.0)["far"], "本来就没在等")
