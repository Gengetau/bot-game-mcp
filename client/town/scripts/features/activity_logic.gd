extends RefCounted
## 共同活动的纯逻辑：不读场景、不取时间（时间由调用方传进来）、不用随机数，所以能在无头 Godot 里单测（client/tests/activity_logic_test.gd）。
## 四件事：走开拦截的状态机（gate）、选座（pick_seat）、桌牌与提示文字（tag_text / dur_text / warn_text）、参与者名单差异（diff_people）。

## 走开拦截：第二次尝试必须是「新的一次操作」，且在第一次提示之后 6 秒内；放行后 6 秒内都不再拦。
## 新的一次操作怎么认：
##  - 方向键：靠「新的一次按下」这个边沿（main 的 key_edge，每次新按下加一，由调用方传进来）。按着不放时每帧都在问、编号不变，
##    哪怕中间有一帧卡了几百毫秒也不算新的一次；松开再按编号变了才算。不靠时间间隔推断（以前靠「间隔大于 300 毫秒」，一帧卡顿就被当成第二次而放行）。
##  - 点击：被拦的每一下点击只问一次，每次被问就是一次点击。
## 300 毫秒：不管哪种，双击 / 触摸点两下（间隔常在 100 到 250 毫秒）算同一次手势，距上一次被问不到 300 毫秒的不放行（这条只作用于「新的一次操作」之间，不再用来区分按住和重按）。
## 6 秒：给玩家「看到提示、想一想、再点一次」的时间，也是放行之后连续走几步不再被拦的窗口；过期就重新提示，免得很久以前的一次提示让以后的误触直接放行。
const REPEAT_GAP_MS := 300
const WINDOW_MS := 6000
## 一个座位上站着别人的距离（米）、算「我已经坐在这个座位上」的距离（米）
const OCCUPIED_R := 0.6
const SEATED_R := 0.5
## 刚放行之后这么久内，「其实这次点击不是要走开」可以撤销放行（点自己所在的桌子、按 E：main 先问拦截、后调 on_pick，拦截看不出这次点击的目的）。
## 取 3 秒：E 键路径在调 on_pick 之前可能先等 /me 刷新（最多约 2.5 秒）
const REVOKE_MS := 3000
const LOBBY_REASON_KEY := "太久"  # 服务器取消原因里「等了太久没凑齐人」的关键字：只用来决定要不要提示，文字原样展示
const ALL_LEFT_REASON_KEY := "大家都离开了"  # 参与者减到零而取消：能收到这条的人必定是最后走开的那一个（或更早走开的），是自己造成的
const ENDED_KEEP := 8


static func new_gate() -> Dictionary:
	return {"warn_at": 0, "warn_edge": -1, "last_call": 0, "confirmed_until": 0, "warned": 0, "passed": 0, "passed_at": 0}


## 清掉确认状态（活动结束、换了一桌、离开、换人时调用）；计数不清，端到端要读
static func gate_clear(st: Dictionary) -> void:
	st["warn_at"] = 0
	st["warn_edge"] = -1
	st["last_call"] = 0
	st["confirmed_until"] = 0
	st["passed_at"] = 0


## 每次被问「现在许不许走」时调用，返回空串放行、非空串是提示文字。st 是 new_gate() 的字典，now 是毫秒。
## key_edge：方向键按着时是这一次按下的编号，没按着（点击等）是 -1。
static func gate(st: Dictionary, now: int, text: String, key_edge: int = -1) -> String:
	if now < int(st["confirmed_until"]):
		return ""
	var warn_at: int = int(st["warn_at"])
	# 同一次按住（编号没变）永远不是第二次尝试，不管帧间隔多长
	var same_hold: bool = key_edge >= 0 and key_edge == int(st["warn_edge"])
	if warn_at > 0 and not same_hold and now - int(st["last_call"]) > REPEAT_GAP_MS and now - warn_at < WINDOW_MS:
		st["confirmed_until"] = now + WINDOW_MS
		st["passed"] = int(st["passed"]) + 1
		st["passed_at"] = now
		return ""
	if warn_at <= 0 or now - warn_at >= WINDOW_MS:
		st["warn_at"] = now
		st["warn_edge"] = key_edge
		st["warned"] = int(st["warned"]) + 1
	st["last_call"] = now
	return text


## 撤销刚刚的放行：点击其实没有要走开（吞掉它的 on_pick 调用）。只撤销 REVOKE_MS 之内的那一次放行（更早的窗口是玩家真的确认过要走），
## 撤销后放行次数退回、确认窗口作废，下一次走开重新从第一次提示开始。返回是否撤销了。
static func gate_revoke(st: Dictionary, now: int) -> bool:
	var at: int = int(st["passed_at"])
	if at <= 0 or now - at > REVOKE_MS:
		return false
	st["passed"] = maxi(0, int(st["passed"]) - 1)
	gate_clear(st)
	return true


## 取消事件要不要对我说、说什么（空串 = 不说）。服务器的取消事件里没有「谁造成」，只能按原因判断：
## 等了太久没凑齐人（谁都没走）：都说；发起人自己走开引起的取消：不对他自己再说一遍；
## 「大家都离开了」：参与者减到零，收到的人是最后走开的那一个，是自己造成的，不说；其余（发起人走开了等）别人造成的，原样说。
static func cancel_text(is_initiator: bool, reason: String) -> String:
	var said: String = "这一桌散了：" + reason if reason != "" else "这一桌散了。"
	if reason.find(LOBBY_REASON_KEY) >= 0:
		return said
	if is_initiator or reason.find(ALL_LEFT_REASON_KEY) >= 0:
		return ""
	return said


## 记下已经结束（完成或取消）的活动编号：更旧的 /me 迟到时不能让它复活。只留最近几个
static func remember_ended(ended: Array, id: String) -> void:
	if id == "" or ended.has(id):
		return
	ended.append(id)
	while ended.size() > ENDED_KEEP:
		ended.remove_at(0)


## 动作成功之后 /me 要追上的状态：约人、加入之后我有了活动；开始之后活动是进行中
static func state_reached(verb: String, mine_status: String) -> bool:
	if verb == "begin":
		return mine_status == "running"
	return mine_status != ""


## 走开提示：等人且我是发起人 / 等人且我是参与者 / 进行中
static func warn_text(status: String, is_initiator: bool, name: String) -> String:
	if status == "open":
		if is_initiator:
			return "你发起的%s还在等人，走开就取消了。再试一次就走。" % name
		return "走开就让出位子。再试一次就走。"
	return "%s还没结束，现在走开就退出，没有这次的收获。再试一次就走。" % name


## 选座。anchors：这件物件的使用位（Vector2 数组），me：我的位置，others：别人的位置（Vector2 数组，不含我）。
## 返回 {"seated": bool, "point": Vector2}：seated 为真表示我已经站在某个使用位上（距离不大于 SEATED_R），什么都不用做；
## 否则 point 是该走去的使用位：没被别人占着（距离不小于 OCCUPIED_R）的里面离我最近的；全被占就取离我最近的。anchors 为空时 point 为 me。
static func pick_seat(anchors: Array, me: Vector2, others: Array) -> Dictionary:
	if anchors.is_empty():
		return {"seated": false, "point": me}
	var best_free := Vector2.ZERO
	var best_free_d: float = INF
	var best_any := Vector2.ZERO
	var best_any_d: float = INF
	for a in anchors:
		var p: Vector2 = a
		var d: float = me.distance_to(p)
		if d <= SEATED_R:
			return {"seated": true, "point": p}
		if d < best_any_d:
			best_any_d = d
			best_any = p
		var taken: bool = false
		for o in others:
			if (o as Vector2).distance_to(p) < OCCUPIED_R:
				taken = true
				break
		if not taken and d < best_free_d:
			best_free_d = d
			best_free = p
	return {"seated": false, "point": best_free if best_free_d < INF else best_any}


## 桌牌文字（名字用活动名，不放倒计时，免得文字每秒变）
static func tag_text(name: String, status: String, n: int, mn: int, mx: int) -> String:
	if status == "running":
		return "%s · %d 人" % [name, n]
	if n < mn:
		return "%s · 等人 %d/%d" % [name, n, mn]
	return "%s · 可开始 %d/%d" % [name, n, mx]


## 「开始了，大约 N 分钟。」里的时长：不到一分半钟按秒说（端到端把十分钟的活动缩成约 45 秒）
static func dur_text(ms: float) -> String:
	var s: int = int(round(maxf(0.0, ms) / 1000.0))
	if s < 90:
		return "%d 秒" % maxi(1, s)
	return "%d 分钟" % int(round(float(s) / 60.0))


## 名单差异：prev 是 {编号: 名字}，cur 是参与者数组（每项 {id, name}）。返回 {joined: [名字], left: [名字]}，都不含 me_id。
static func diff_people(prev: Dictionary, cur: Array, me_id: String) -> Dictionary:
	var joined: Array = []
	var left: Array = []
	var now_ids: Dictionary = {}
	for p in cur:
		if not (p is Dictionary):
			continue
		var pid: String = str(p.get("id", ""))
		now_ids[pid] = true
		if pid != me_id and not prev.has(pid):
			joined.append(str(p.get("name", "")))
	for k in prev:
		if str(k) != me_id and not now_ids.has(k):
			left.append(str(prev[k]))
	return {"joined": joined, "left": left}
