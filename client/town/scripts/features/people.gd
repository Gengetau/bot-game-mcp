extends TFeature
## 人和人当面认识（页签「人家」+ 居民卡）：点人出卡、问爱好、邀请到家里；请柬、会馆门牌、进屋 / 出门。
## 资料只来自 /me：here.residents（公开资料）、here.doors、here.home、invites。爱好只在问过之后存在内存里。
## 动作一律 ctx.act_once（不动 pending、不睡眠重试、可复用请求号）；too_far 时只走过去，不自动重发动作（邀请不是幂等的）。
## 「点到的是谁、资料从哪来」集中在 _profile_of / _pickable：C6 接 NPC 时改这两处（让 NPC 返回自己的简化资料），其余不用动。

const REACH_SLACK := 0.5  # 到达时快照位置可能还没更新：留余量
const AUTO_CLOSE_DIST := 8.0
const WANT_WINDOW := 3.0  # 走到了之后，等位置跟上的秒数
const MEET_HYST := 0.6

var _gen: int = 0
var _me_id: String = ""
var _my_home: String = ""
var _clock: float = 0.0  # 累计秒（不用 Date / Time）
var _acc: float = 0.0

# 卡片
var _card_id: String = ""
var _card_scene: String = ""
var _card_walk: bool = false
var _want_id: String = ""
var _want_until: float = 0.0

# 资料与缓存（都只在内存）
var _res: Dictionary = {}  # 居民编号 -> here.residents 里的公开资料
var _hobby: Dictionary = {}  # 居民编号 -> [爱好名]
var _doors: Variant = null  # null 或 Array
var _home: Variant = null  # null 或 Dictionary
var _recv: Array = []  # view.invites.received（InviteView）
var _sent: Dictionary = {}  # 居民编号 -> 邀请到期的服务器毫秒（view.invites.sent 的 guest）
var _known: Dictionary = {}  # grantId -> true
var _seeded: bool = false
var _fresh: Dictionary = {}  # grantId -> true（还没处理的新请柬）
var _unseen: Dictionary = {}  # grantId -> true（页签还没被看到：角标用）
var _dismissed: Dictionary = {}
var _pending: Dictionary = {}  # verb:id -> 上次网络失败的请求号
var _inflight: Dictionary = {}  # verb -> true
var _meet_id: String = ""
var _notice_wait: float = -1.0
var _last_ack: Dictionary = {}
var _asks: int = 0
var _invites_sent: int = 0
var _entered: bool = false


func _init() -> void:
	id = "people"


func event_types() -> PackedStringArray:
	return PackedStringArray(["invite", "asked_hobby", "notice", "you_arrived"])


func wants_tick() -> bool:
	return true


func on_enter() -> void:
	_entered = true


func on_leave() -> void:
	_gen += 1
	_entered = false
	_reset_all()
	_me_id = ""
	feed("reset")
	forget_state()


func _reset_all() -> void:
	_card_id = ""
	_card_scene = ""
	_card_walk = false
	_want_id = ""
	_want_until = 0.0
	_res.clear()
	_hobby.clear()
	_doors = null
	_home = null
	_recv = []
	_sent.clear()
	_known.clear()
	_seeded = false
	_fresh.clear()
	_unseen.clear()
	_dismissed.clear()
	_pending.clear()
	_inflight.clear()
	_meet_id = ""
	_notice_wait = -1.0
	_last_ack = {}
	_asks = 0
	_invites_sent = 0
	_my_home = ""


# ───────────────────────── 读 /me ─────────────────────────


func on_me(view: Dictionary) -> void:
	var me = view.get("me")
	var mid: String = ""
	if me is Dictionary:
		mid = str(me.get("id", ""))
	if mid != "" and mid != _me_id:
		# 换人（共用设备）或第一次：上一个人的一切都不能留下
		var had: bool = _me_id != ""
		_gen += 1
		_reset_all()
		_me_id = mid
		if had:
			feed("reset")
			forget_state()
	if me is Dictionary and me.get("home") is Dictionary:
		_my_home = str(me["home"].get("id", ""))
	_res.clear()
	_doors = null
	_home = null
	var here = view.get("here")
	if here is Dictionary:
		var rs = here.get("residents")
		if rs is Array:
			for r in rs:
				if r is Dictionary and str(r.get("id", "")) != "":
					_res[str(r["id"])] = r
		var ds = here.get("doors")
		if ds is Array:
			var list: Array = []
			for d in ds:
				if not (d is Dictionary):
					continue
				var ow = d.get("owner")
				if not (ow is Dictionary):
					continue
				list.append(
					{
						"home": str(d.get("home", "")),
						"ownerId": str(ow.get("id", "")),
						"ownerName": str(ow.get("name", "")),
						"ownerKind": _kind_of(str(ow.get("kind", ""))),
						"lane": str(d.get("lane", "")),
						"no": int(d.get("no", 0)),
						"can": bool(d.get("canEnter", false)),
						"mine": str(ow.get("id", "")) == _me_id,
					}
				)
			_doors = list
		var hm = here.get("home")
		if hm is Dictionary and hm.get("owner") is Dictionary:
			var others: Array = []
			if rs is Array:
				for r2 in rs:
					if r2 is Dictionary:
						others.append({"id": str(r2.get("id", "")), "name": str(r2.get("name", "")), "kind": _kind_of(str(r2.get("kind", "")))})
			var decor: Array = []
			var dc = hm.get("decor")
			if dc is Array:
				for x in dc:
					decor.append(str(x))
			_home = {"ownerName": str(hm["owner"].get("name", "")), "ownerKind": _kind_of(str(hm["owner"].get("kind", ""))), "mine": bool(hm.get("mine", false)), "decor": decor, "others": others}
	# 邀请
	var inv = view.get("invites")
	_sent.clear()
	var recv: Array = []
	if inv is Dictionary:
		var sl = inv.get("sent")
		if sl is Array:
			for s in sl:
				if s is Dictionary and s.get("guest") is Dictionary:
					var gid: String = str(s["guest"].get("id", ""))
					var ex: float = float(s.get("expiresAt", 0))
					if gid != "" and ex > float(_sent.get(gid, 0.0)):
						_sent[gid] = ex
		var rl = inv.get("received")
		if rl is Array:
			for g in rl:
				if g is Dictionary and str(g.get("grantId", "")) != "" and g.get("host") is Dictionary:
					recv.append(g)
	_recv = recv
	_note_received()
	_push()


## 对比 received：第一次只入库不提醒；之后新出现的 grantId 算新的（当面来的有事件，信里附的读信后才出现）
func _note_received() -> void:
	var live: Dictionary = {}
	for g in _recv:
		live[str(g["grantId"])] = true
	if not _seeded:
		for gid in live:
			_known[gid] = true
		_seeded = true
	else:
		for gid in live:
			if not _known.has(gid):
				_known[gid] = true
				if not _dismissed.has(gid):
					_fresh[gid] = true
					_unseen[gid] = true
	# 不在了的（过期 / 收回）不再算新
	for gid in _fresh.keys():
		if not live.has(gid):
			_fresh.erase(gid)
			_unseen.erase(gid)


func on_scene(_msg: Dictionary) -> void:
	if _card_id == "":
		return
	if ctx.cur_scene() != _card_scene or not ctx.actors().has(_card_id):
		_close_card()
		_push()


func on_resync() -> void:
	ctx.refresh_me()


# ───────────────────────── 事件 ─────────────────────────


func on_event(ev: Dictionary) -> void:
	var data: Dictionary = ev.get("data", {}) if ev.get("data") is Dictionary else {}
	match str(ev.get("type", "")):
		"invite":
			var iv = data.get("invite")
			if iv is Dictionary and str(iv.get("grantId", "")) != "" and iv.get("host") is Dictionary:
				var gid: String = str(iv["grantId"])
				if not _known.has(gid):
					_known[gid] = true
					_fresh[gid] = true
					_unseen[gid] = true
					_dismissed.erase(gid)
					var have: bool = false
					for g in _recv:
						if str(g.get("grantId", "")) == gid:
							have = true
					if not have:
						_recv.append(iv)
			var t: String = str(data.get("text", ""))
			if t != "":
				ctx.toast(t, "ok")
			ctx.refresh_me()
			_push()
		"asked_hobby":
			var frm = data.get("from")
			if frm is Dictionary:
				ctx.toast("%s 问了你的爱好。" % str(frm.get("name", "")), "info")
		"notice":
			_notice_wait = 0.12
		"you_arrived":
			var tg = data.get("target")
			if tg is Dictionary and str(tg.get("kind", "")) == "resident":
				var tid: String = str(tg.get("id", ""))
				if tid != "" and tid != ctx.self_id():
					_want_id = tid
					_want_until = _clock + WANT_WINDOW
			else:
				_want_id = ""


# ───────────────────────── 点人 ─────────────────────────


## 能不能当「一个人」来点：C6 接 NPC 时在这里让路 / 接手
func _pickable(pid: String) -> bool:
	if pid == "" or pid == ctx.self_id():
		return false
	var a = ctx.actors().get(pid)
	if a == null:
		return false
	var k: String = (a as TActor).kind
	return k == "human" or k == "agent"


## 资料从哪来：公开资料（here.residents）。没有就只有名字和种类；C6 的 NPC 简化版也从这里接
func _profile_of(pid: String) -> Dictionary:
	var a = ctx.actors().get(pid)
	var p: Dictionary = {"id": pid, "name": "", "kind": "human", "known": false, "bio": "", "traits": [], "titles": [], "mood": ""}
	if a != null:
		p["name"] = (a as TActor).actor_name
		p["kind"] = _kind_of((a as TActor).kind)
	var r = _res.get(pid)
	if r is Dictionary:
		p["known"] = true
		# 名字以场景快照里的为准（改名后它先到，/me 里的资料可能还是旧的）
		p["kind"] = _kind_of(str(r.get("kind", p["kind"])))
		p["bio"] = str(r.get("bio", ""))
		p["traits"] = _strs(r.get("traits"), 4)
		p["titles"] = _strs(r.get("titles"), 3)
		p["mood"] = str(r.get("mood", ""))
	return p


func _strs(v, cap: int) -> Array:
	var out: Array = []
	if v is Array:
		for x in v:
			if out.size() >= cap:
				break
			out.append(str(x))
	return out


func _kind_of(k: String) -> String:
	return "agent" if k == "agent" else "human"


func _dist_to(pid: String) -> float:
	var sa = ctx.actors().get(ctx.self_id())
	var a = ctx.actors().get(pid)
	if sa == null or a == null:
		return INF
	return ((a as TActor).disp as Vector2).distance_to((sa as TActor).disp)


func on_pick(kind: String, pid: String) -> bool:
	if kind != "actor" or not _pickable(pid):
		return false
	if _dist_to(pid) <= ctx.c4_person_reach():
		_open_card(pid)
		return true
	return false


func _open_card(pid: String) -> void:
	if not _pickable(pid):
		return
	if _card_id == pid:
		return
	_card_id = pid
	_card_scene = ctx.cur_scene()
	_card_walk = false
	ctx.mark_dirty()
	_push()
	ctx.refresh_me()  # 资料（简介、称号、个性）取最新的；/me 回来后 on_me 会重推


func _close_card() -> void:
	_card_id = ""
	_card_scene = ""
	_card_walk = false
	ctx.mark_dirty()


# ───────────────────────── 网页 -> Godot ─────────────────────────


func on_ui(ui_name: String, arg: String) -> void:
	match ui_name:
		"close":
			_close_card()
			_push()
		"ask":
			await _do_json("ask", arg)
		"invite":
			await _do_json("invite", arg)
		"visit":
			_visit(arg)
		"leave_home":
			ctx.c4_go({"to": "residential"}, "")
		"dismiss":
			_dismissed[arg] = true
			_fresh.erase(arg)
			_unseen.erase(arg)
			_push()
			ctx.mark_dirty()
		"seen":
			if not _unseen.is_empty():
				_unseen.clear()
				_push()
			ctx.refresh_me()


func _do_json(verb: String, arg: String) -> void:
	var p = JSON.parse_string(arg)
	if not (p is Dictionary):
		return
	await _do(verb, str(p.get("id", "")), int(p.get("n", 0)))


func _visit(home: String) -> void:
	if not home.begins_with("home:") or home.length() > 80:
		return
	var owner_name: String = ""
	for g in _recv:
		if str(g.get("home", "")) == home:
			var gid: String = str(g["grantId"])
			_fresh.erase(gid)
			_unseen.erase(gid)
			if g.get("host") is Dictionary:
				owner_name = str(g["host"].get("name", ""))
	if owner_name == "" and _doors is Array:
		for d in _doors:
			if str(d["home"]) == home:
				owner_name = str(d["ownerName"])
	var to: Dictionary = {"to": "home"} if home == _my_home else {"to": home}
	_push()
	ctx.mark_dirty()
	ctx.c4_go(to, owner_name)


# ───────────────────────── 动作：问爱好、邀请 ─────────────────────────


func _block_reason() -> String:
	if not ctx.control_mine():
		return "readonly"
	if ctx.in_game():
		return "game"
	if ctx.conn() == "offline":
		return "offline"
	return ""


func _ack(n: int, verb: String, pid: String, d: Dictionary) -> void:
	d["n"] = n
	d["verb"] = verb
	d["id"] = pid
	_last_ack = d.duplicate()
	feed("ack", d)


func _do(verb: String, pid: String, n: int) -> void:
	if not _pickable(pid):
		return
	var why: String = _block_reason()
	if why != "":
		_ack(n, verb, pid, {"ok": false, "code": why})
		return
	if (ctx.actors().get(pid) as TActor).busy:
		_ack(n, verb, pid, {"ok": false, "code": "busy"})
		return
	if verb == "invite" and _sent.has(pid) and float(_sent[pid]) > ctx.server_now():
		_ack(n, verb, pid, {"ok": false, "code": "invited"})
		return
	if _inflight.has(verb):
		return
	_inflight[verb] = true
	var key: String = verb + ":" + pid
	var rid: String = str(_pending.get(key, ""))
	if rid == "":
		rid = ctx.new_req_id()
	var g: int = _gen
	var action: Dictionary = {"type": "ask_hobby", "target": pid} if verb == "ask" else {"type": "invite", "to": pid}
	var r: Dictionary = await ctx.act_once(action, {"rid": rid})
	if g != _gen:
		return  # 期间离开 / 换人：结果不属于现在这个人
	_inflight.erase(verb)
	var same_card: bool = _card_id == pid
	if bool(r.get("ok", false)):
		_pending.erase(key)
		var d: Dictionary = r["data"] if r.get("data") is Dictionary else {}
		var ack := {"ok": true}
		if verb == "ask":
			_asks += 1
			var names: Array = []
			var it = d.get("interests")
			if it is Array:
				for x in it:
					if x is Dictionary:
						names.append(str(x.get("name", "")))
			_hobby[pid] = names
			ack["interests"] = names
		else:
			_invites_sent += 1
			var iv = d.get("invite")
			var ex: float = ctx.server_now() + 24.0 * 3600.0 * 1000.0
			if iv is Dictionary and iv.has("expiresAt"):
				ex = float(iv["expiresAt"])
			_sent[pid] = ex
			ctx.refresh_me()
		if not same_card:
			ack["stale"] = true
		_ack(n, verb, pid, ack)
		_push()
		return
	var data = r.get("data")
	var code: String = "net" if bool(r.get("net_fail", false)) else str(r.get("reason", ""))
	if code == "" and not bool(r.get("net_fail", false)):
		code = str(r.get("error", ""))
	if bool(r.get("net_fail", false)):
		_pending[key] = str(r.get("rid", rid))  # 用户再点同一个动作同一个人时带回同一个请求号
	else:
		_pending.erase(key)
	var ack2 := {"ok": false, "code": code, "reason": str(r.get("reason", "")), "message": str(r.get("message", "")), "retryMs": int(r.get("retry_after_ms", 0))}
	if code == "too_far" and data is Dictionary and str(data.get("navigateTo", "")) != "":
		var tid: String = str(data["navigateTo"])
		if _card_id == tid:
			_card_walk = true
		ack2["walking"] = true
		ctx.c4_approach(tid)
	elif code == "not_here":
		ctx.refresh_me()
	if not same_card:
		ack2["stale"] = true
	_ack(n, verb, pid, ack2)
	_push()


# ───────────────────────── 每帧 ─────────────────────────


func tick(dt: float, _now_ms: float) -> void:
	_clock += dt
	if _notice_wait > 0.0:
		_notice_wait -= dt
		if _notice_wait <= 0.0:
			_notice_wait = -1.0
			ctx.refresh_me()
	_acc += dt
	if _acc < 0.25:
		return
	_acc = 0.0
	var acts: Dictionary = ctx.actors()
	var sa = acts.get(ctx.self_id())
	if sa == null:
		return
	var reach: float = ctx.c4_person_reach()
	# 待开卡：走到了，等位置跟上
	if _want_id != "":
		if _clock > _want_until or not acts.has(_want_id):
			if acts.has(_want_id) and _pickable(_want_id):
				ctx.toast("%s 走开了，再点一下 ta 走过去。" % (acts[_want_id] as TActor).actor_name, "info")
			_want_id = ""
		elif _dist_to(_want_id) <= reach + REACH_SLACK:
			var wid: String = _want_id
			_want_id = ""
			if not ctx.in_game():
				_open_card(wid)
	# 卡片的自动关闭
	if _card_id != "":
		var d: float = _dist_to(_card_id)
		if not acts.has(_card_id) or ctx.cur_scene() != _card_scene or ctx.in_game():
			_close_card()
		elif _card_walk and d <= reach + REACH_SLACK:
			_card_walk = false
			feed("ack", {"n": 0, "verb": "walk", "id": _card_id, "ok": true, "code": "arrived"})
		elif not _card_walk and d > AUTO_CLOSE_DIST:
			_close_card()
	# 「认识一下」：最近的人，带迟滞
	var best: String = ""
	var best_d: float = INF
	for aid in acts:
		if aid == ctx.self_id():
			continue
		var a: TActor = acts[aid]
		if a.busy or not (a.kind == "human" or a.kind == "agent"):
			continue
		var dd: float = a.disp.distance_to((sa as TActor).disp)
		if dd < best_d:
			best_d = dd
			best = aid
	var want_meet: String = ""
	if best != "":
		if best == _meet_id:
			if best_d <= reach + MEET_HYST:
				want_meet = best
		elif best_d <= reach:
			want_meet = best
	if want_meet != _meet_id:
		_meet_id = want_meet
		ctx.mark_dirty()
	_push()


# ───────────────────────── 推给网页 ─────────────────────────


func _ctl() -> String:
	return _block_reason()


func _mins_left(ex: float) -> int:
	var m: int = int(ceil((ex - ctx.server_now()) / 60000.0))
	if m < 1:
		m = 1
	return int(ceil(float(m) / 5.0)) * 5  # 向上取整到 5 分钟：不让状态每分钟都变


func _card_state() -> Variant:
	if _card_id == "" or not _pickable(_card_id):
		return null
	var p: Dictionary = _profile_of(_card_id)
	var a: TActor = ctx.actors()[_card_id]
	p["busy"] = a.busy
	p["near"] = _dist_to(_card_id) <= ctx.c4_person_reach()
	p["walking"] = _card_walk
	p["hobby"] = _hobby.get(_card_id)
	if _sent.has(_card_id) and float(_sent[_card_id]) > ctx.server_now():
		p["invited"] = {"mins": _mins_left(float(_sent[_card_id]))}
	else:
		p["invited"] = null
	return p


func _invites_state() -> Array:
	var out: Array = []
	var items: Array = []
	for g in _recv:
		if g.get("host") is Dictionary and float(g.get("expiresAt", 0)) > ctx.server_now():
			items.append(g)
	items.sort_custom(func(x, y): return float(x.get("expiresAt", 0)) < float(y.get("expiresAt", 0)))
	for g in items:
		var gid: String = str(g["grantId"])
		out.append(
			{
				"grantId": gid,
				"home": str(g.get("home", "")),
				"hostId": str(g["host"].get("id", "")),
				"hostName": str(g["host"].get("name", "")),
				"hostKind": _kind_of(str(g["host"].get("kind", ""))),
				"mins": _mins_left(float(g.get("expiresAt", 0))),
				"fresh": _fresh.has(gid),
			}
		)
	return out


func _push() -> void:
	if not _entered and _me_id == "":
		return
	var inv: Array = _invites_state()
	var unseen: int = 0
	for iv in inv:
		if _fresh.has(iv["grantId"]) and _unseen.has(iv["grantId"]):
			unseen += 1
	feed_state(
		{
			"me": {"id": _me_id},
			"ctl": _ctl(),
			"reach": ctx.c4_person_reach(),
			"card": _card_state(),
			"doors": _doors,
			"home": _home,
			"invites": inv,
			"freshCount": unseen,
		}
	)


# ───────────────────────── 按钮（#actions） ─────────────────────────


func actions(out: Array) -> void:
	if ctx.in_game() or not ctx.control_mine():
		return
	var acts: Dictionary = ctx.actors()
	if _meet_id != "" and _meet_id != _card_id and acts.has(_meet_id):
		out.append({"id": "f:people:meet:" + _meet_id, "label": "认识一下", "sub": (acts[_meet_id] as TActor).actor_name, "mode": "do"})
	# 最新一张还没处理的请柬
	var best: Dictionary = {}
	for g in _recv:
		if _fresh.has(str(g.get("grantId", ""))) and g.get("host") is Dictionary:
			if best.is_empty() or float(g.get("expiresAt", 0)) > float(best.get("expiresAt", 0)):
				best = g
	if not best.is_empty():
		out.append({"id": "f:people:visit:" + str(best["home"]), "label": "去做客", "sub": "%s的家" % str(best["host"].get("name", "")), "mode": "do"})
	if _doors is Array:
		out.append({"id": "f:people:doors", "label": "门牌", "sub": "", "mode": "go"})


func on_action(verb: String, arg: String) -> void:
	match verb:
		"meet":
			_open_card(arg)
		"visit":
			_visit(arg)
		"doors":
			feed("open", {"tab": "people"})


func debug() -> Dictionary:
	var sent_to: Array = []
	for k in _sent:
		sent_to.append(k)
	return {
		"card": _card_id if _card_id != "" else null,
		"cardId": _card_id,
		"walk": _card_walk,
		"want": _want_id,
		"asks": _asks,
		"invitesSent": _invites_sent,
		"invites": _recv.size(),
		"fresh": _fresh.size(),
		"unseen": _unseen.size(),
		"doors": (_doors as Array).size() if _doors is Array else -1,
		"inHome": _home != null,
		"sentTo": sent_to,
		"hobbies": _hobby.size(),
		"known": _known.size(),
		"reach": ctx.c4_person_reach(),
		"meet": _meet_id,
		"lastAck": _last_ack,
		"me": _me_id,
	}
