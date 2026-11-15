class_name TNpcLogic
extends RefCounted
## npc.gd 里不依赖场景树的纯逻辑：名牌让位、动作回执分类、限流倒计时、数量夹取、货架合并、请求号的键。
## 都是静态函数，client/tests/npc_logic_test.gd 直接跑（不起浏览器）。

# ───────────────────────── 名牌让位 ─────────────────────────

const TAG_H := 22.0
const TAG_CHAR_W := 13.0  # 13px 的字，汉字宽度
const TAG_PAD := 18.0  # 左右内边距 + 边框
const NPC_MARK_W := 22.0  # 名牌尾巴上的「店」「闲」小标记
const SELF_MARK_W := 34.0  # 自己的牌尾巴「 · 你」


## 一块名牌在屏幕上大概占多大（像素）。只用来判断「两块牌是不是重叠超过一半」，不要求精确；真实尺寸在网页那边量
static func tag_size(text: String, npc: bool = false, self_tag: bool = false) -> Vector2:
	var w: float = float(text.length()) * TAG_CHAR_W + TAG_PAD
	if npc:
		w += NPC_MARK_W
	if self_tag:
		w += SELF_MARK_W
	return Vector2(w, TAG_H)


## 名牌锚点（水平居中、底边在 y）+ 尺寸 -> 矩形
static func tag_rect(cx: float, bottom: float, size: Vector2) -> Rect2:
	return Rect2(Vector2(cx - size.x * 0.5, bottom - size.y), size)


## NPC 的牌要不要让位：和任何一块别的牌（居民的）重叠的面积超过两者中较小那块的一半就让位（居民的牌优先）
static func tag_yields(npc_rect: Rect2, others: Array) -> bool:
	var a_npc: float = npc_rect.get_area()
	if a_npc <= 0.0:
		return false
	for o in others:
		var r: Rect2 = o
		var inter: Rect2 = npc_rect.intersection(r)
		if inter.get_area() <= 0.0:
			continue
		if inter.get_area() > 0.5 * minf(a_npc, r.get_area()):
			return true
	return false


# ───────────────────────── 动作回执 ─────────────────────────


## 把 act_once 的结果归成一个短码。net（网络层失败，要沿用同一个请求号重试）、stale（会话换了，不算数）、
## rate_limited（服务器限流，reason 是桶名，所以先看 error）；其余用 reason（too_far、not_here、sold_out、closed……），没有 reason 用 error。
static func classify(res: Dictionary) -> String:
	if bool(res.get("ok", false)):
		return "ok"
	if bool(res.get("net_fail", false)):
		return "net"
	var err: String = str(res.get("error", ""))
	if err == "stale_session":
		return "stale"
	if err == "rate_limited":
		return "rate_limited"
	var reason: String = str(res.get("reason", ""))
	return reason if reason != "" else (err if err != "" else "unknown")


## 这个失败要不要把菜单关掉（NPC 不在那里了）：not_here、not_found
static func closes_menu(code: String) -> bool:
	return code == "not_here" or code == "not_found"


## 失败是不是「同一个请求号可以安全重发」：只有网络层失败（服务器可能已经处理了，重发由请求号保证只处理一次）
static func keeps_rid(code: String) -> bool:
	return code == "net"


## 限流：服务器说 retry_after_ms，用服务器时间算出到期时刻；之后每次读剩余秒数（向上取整），不依赖本机时钟
static func cool_until(server_now_ms: float, retry_after_ms: int) -> float:
	return server_now_ms + float(maxi(0, retry_after_ms))


static func cool_secs(until_ms: float, server_now_ms: float) -> int:
	if until_ms <= server_now_ms:
		return 0
	return int(ceil((until_ms - server_now_ms) / 1000.0))


## 买几份：服务器一次最多 10 件；知道库存（>0）就不超过库存；至少 1
const QTY_MAX := 10


static func clamp_qty(q: int, stock: int = -1) -> int:
	var hi: int = QTY_MAX
	if stock > 0:
		hi = mini(hi, stock)
	return clampi(q, 1, maxi(1, hi))


# ───────────────────────── 请求号的键（带上对象，不能只按动作类型记） ─────────────────────────


static func ask_key(npc_id: String, topic: String) -> String:
	return "ask:%s:%s" % [npc_id, topic]


static func buy_key(npc_id: String, shop: String, sku: String, qty: int) -> String:
	return "buy:%s:%s:%s:%d" % [npc_id, shop, sku, qty]


# ───────────────────────── 视图数据 ─────────────────────────


## here.npcs 里找一个 NPC 的条目（没有就空字典）
static func npc_entry(here_npcs, npc_id: String) -> Dictionary:
	if here_npcs is Array:
		for n in here_npcs:
			if n is Dictionary and str(n.get("id", "")) == npc_id:
				return n
	return {}


## 话题列表：[{id, label}]，只收两样都是字符串的
static func topics_of(raw) -> Array:
	var out: Array = []
	if raw is Array:
		for t in raw:
			if t is Dictionary and str(t.get("id", "")) != "" and str(t.get("label", "")) != "":
				out.append({"id": str(t["id"]), "label": str(t["label"])})
	return out


static func has_topic(topics: Array, tid: String) -> bool:
	for t in topics:
		if str(t["id"]) == tid:
			return true
	return false


## 货架：[{sku, name, price, stock}]。来源可以是 here.shops（一个 Array，每项 {id, name, goods}）里编号对上的那一家，或回执里的 shop（一个 {id, name, goods}）
static func shop_view(shop_id: String, here_shops, receipt_shop = null) -> Dictionary:
	var src = null
	if here_shops is Array:
		for s in here_shops:
			if s is Dictionary and str(s.get("id", "")) == shop_id:
				src = s
				break
	if src == null and receipt_shop is Dictionary and str(receipt_shop.get("id", "")) == shop_id:
		src = receipt_shop
	if src == null:
		return {}
	var goods: Array = []
	var gl = src.get("goods")
	if gl is Array:
		for g in gl:
			if g is Dictionary and str(g.get("sku", "")) != "":
				goods.append({"sku": str(g["sku"]), "name": str(g.get("name", "")), "price": int(g.get("price", 0)), "stock": int(g.get("stock", 0))})
	return {"id": shop_id, "name": str(src.get("name", "")), "goods": goods}


## 买成功之后先在本地把库存减掉（随后 /me 会给准数）；返回新的货架（不改原件）
static func after_buy(shop: Dictionary, sku: String, qty: int) -> Dictionary:
	var out: Dictionary = shop.duplicate(true)
	var goods = out.get("goods")
	if goods is Array:
		for g in goods:
			if str(g["sku"]) == sku:
				g["stock"] = maxi(0, int(g["stock"]) - qty)
	return out


static func sold_out(shop: Dictionary, sku: String) -> Dictionary:
	return after_buy(shop, sku, QTY_MAX * 1000)


# ───────────────────────── 远处点 NPC 之后的「是在这里点的」窗口 ─────────────────────────

## 点了远处的 NPC 之后，main 随后会发 navigate（导航代号 +1）：
##  - 点的那一刻记下代号（pick_gen）。main 发出后代号变成 pick_gen + 1：这是「我们要等的那一次」，之后再变就是改道了。
##  - 一直没变成 pick_gen + 1（被拦下没发出）超过 UNARMED_S 秒：作废。
## 返回新的状态：{far: bool, armed: bool, gen: int}
const UNARMED_S := 2.0


static func far_step(far: bool, armed: bool, gen_at_pick: int, nav_gen: int, waited_s: float) -> Dictionary:
	if not far:
		return {"far": false, "armed": false, "gen": gen_at_pick}
	if not armed:
		if nav_gen == gen_at_pick + 1:
			return {"far": true, "armed": true, "gen": nav_gen}
		if nav_gen > gen_at_pick + 1:
			return {"far": false, "armed": false, "gen": gen_at_pick}  # 一口气变了不止一次：已经不是我们那一下了
		if waited_s > UNARMED_S:
			return {"far": false, "armed": false, "gen": gen_at_pick}  # 没发出（被拦下）
		return {"far": true, "armed": false, "gen": gen_at_pick}
	if nav_gen != gen_at_pick:
		return {"far": false, "armed": false, "gen": gen_at_pick}  # 走的路上点了别处 / 停下 / 方向键
	return {"far": true, "armed": true, "gen": gen_at_pick}
