extends TFeature
## 共同活动（页签「一起」、桌牌、「约人 / 加入 / 开始」按钮、走开前的提示）：茶桌、藏书架、灶台、花箱这类 action.max >= 2 的公共物件。
## 单人动作（main 的 do: 按钮）和「停下手上的事」都在 main，这里不重复。坐下动画由 main._update_sitting 按 /me 的 here.objects 触发，
## 这里只保证动作之后马上刷新 /me、不同的人走到不同的座位。说明见 client/docs/C2.md。

const Logic := preload("res://scripts/features/activity_logic.gd")

const SELECT_NEAR := 15.0  # 和 main 的名牌同一口径：离物件超过这么远不画桌牌
const TAG_LIFT := 1.0  # 桌牌比物件锚点高多少米（物件名牌在锚点本身，头顶名牌在 2.05 米）
const LOBBY_REASON_KEY := "太久"  # 服务器取消原因里「等了太久没凑齐人」的关键字：只用来判断要不要对发起人自己提示，文字原样展示
const WALK_STALE_MS := 10000

var _gen: int = 0  # 离开 / 换人时加一，在途结果回来后丢弃
var _me_id: String = ""
var _mine: Dictionary = {}  # 我的活动（已校验的 InteractionView），空 = 没有
var _objs: Dictionary = {}  # 物件编号 -> {label, type, action:{name,cost,min,max}, active:Dictionary|null, near:bool}，只含 action.max >= 2 的
var _order: Array = []  # _objs 的编号顺序（服务器顺序）
var _tags: Array = []  # [{oid, wp: Vector3, text}]：on_me 里预先算好，逐帧只做投影
var _people: Dictionary = {}  # 我这一桌最近一次已知的名单 {编号: 名字}
var _last: Dictionary = {}  # 刚才的收获 {name, text}
var _gate: Dictionary = Logic.new_gate()
var _busy: bool = false
var _walk_busy: bool = false
var _walk_oid: String = ""
var _walk_at: int = 0
var _begin_mark: String = ""  # 我刚点了「开始」的活动编号：它的开始事件不再弹「开始了」
var _events: int = 0
var _last_act: Dictionary = {}
var _last_done: Dictionary = {}
var _picks: int = 0


func _init() -> void:
	id = "activity"


func event_types() -> PackedStringArray:
	return PackedStringArray(["interaction", "interaction_done"])


# ───────────────────────── 生命周期 ─────────────────────────


func on_enter() -> void:
	if ctx.ws_ready():
		ctx.refresh_me()


func on_leave() -> void:
	_gen += 1
	_me_id = ""
	_mine = {}
	_objs = {}
	_order = []
	_tags = []
	_people = {}
	_last = {}
	_busy = false
	_walk_busy = false
	_walk_oid = ""
	_walk_at = 0
	_begin_mark = ""
	Logic.gate_clear(_gate)
	_last_act = {}
	_last_done = {}
	feed("reset")
	forget_state()


func on_hello(_msg: Dictionary, _resumed: bool, _first: bool) -> void:
	ctx.refresh_me()


func on_resync() -> void:
	ctx.refresh_me()


# ───────────────────────── 权威状态 ─────────────────────────


func on_me(view: Dictionary) -> void:
	var me = view.get("me")
	var mid: String = str(me.get("id", "")) if me is Dictionary else ""
	if mid != "" and _me_id != "" and mid != _me_id:
		_reset_person()  # 换人（共用设备）：上一位的活动、收获、确认状态都不留
	if mid != "":
		_me_id = mid
	var old_id: String = str(_mine.get("id", ""))
	_mine = _parse_mine(view.get("interaction"))
	var new_id: String = str(_mine.get("id", ""))
	if new_id != old_id:
		Logic.gate_clear(_gate)  # 这是最危险的地方：活动没了，走开拦截必须立刻回到空串
		if new_id != "":
			_last = {}  # 新的一次活动开始，上一次的「刚才」小卡让位
	if _mine.is_empty():
		Logic.gate_clear(_gate)
		_people = {}
	else:
		_people = _people_of(_mine)
	_parse_objects(view.get("here"))
	_push_feed()


func _reset_person() -> void:
	_mine = {}
	_objs = {}
	_order = []
	_tags = []
	_people = {}
	_last = {}
	_busy = false
	_walk_busy = false
	_walk_oid = ""
	_begin_mark = ""
	Logic.gate_clear(_gate)
	_last_done = {}
	_gen += 1


## 缺字段、类型不对都当没有
func _parse_mine(raw) -> Dictionary:
	if not (raw is Dictionary):
		return {}
	var st: String = str(raw.get("status", ""))
	if str(raw.get("id", "")) == "" or (st != "open" and st != "running"):
		return {}
	if not (raw.get("participants") is Array):
		return {}
	return (raw as Dictionary).duplicate()  # 浅拷贝：事件里改 status 时不动 main 手里的那份


func _people_of(it: Dictionary) -> Dictionary:
	var out: Dictionary = {}
	var arr = it.get("participants")
	if arr is Array:
		for p in arr:
			if p is Dictionary:
				out[str(p.get("id", ""))] = str(p.get("name", ""))
	return out


func _parse_objects(here) -> void:
	_objs = {}
	_order = []
	_tags = []
	if not (here is Dictionary):
		return
	var arr = here.get("objects")
	if not (arr is Array):
		return
	for o in arr:
		if not (o is Dictionary):
			continue
		var act = o.get("action")
		if not (act is Dictionary) or int(act.get("max", 1)) < 2:
			continue
		var oid: String = str(o.get("id", ""))
		if oid == "":
			continue
		var active = o.get("active")
		var a: Dictionary = active if active is Dictionary and str(active.get("id", "")) != "" else {}
		_objs[oid] = {"label": str(o.get("label", "")), "type": str(o.get("type", "")), "action": act, "active": a, "near": bool(o.get("near", false))}
		_order.append(oid)
		if not a.is_empty():
			var info: Dictionary = ctx.object_info(oid)
			if not info.is_empty():
				var n: int = (a.get("participants") as Array).size() if a.get("participants") is Array else 0
				var wp: Vector3 = info["pos"]
				_tags.append({"oid": oid, "wp": Vector3(wp.x, wp.y + TAG_LIFT, wp.z), "text": Logic.tag_text(str(a.get("name", "")), str(a.get("status", "")), n, int(a.get("min", 1)), int(a.get("max", 1)))})


func _person_view(p: Dictionary, initiator_id: String) -> Dictionary:
	var pid: String = str(p.get("id", ""))
	return {"id": pid, "name": str(p.get("name", "")), "kind": str(p.get("kind", "human")), "you": pid == _me_id, "initiator": pid == initiator_id}


func _people_list(it: Dictionary) -> Array:
	var out: Array = []
	var ini = it.get("initiator")
	var iid: String = str(ini.get("id", "")) if ini is Dictionary else ""
	var arr = it.get("participants")
	if arr is Array:
		for p in arr:
			if p is Dictionary:
				out.append(_person_view(p, iid))
	return out


func _remain(it: Dictionary, key: String) -> float:
	var v = it.get(key)
	if v == null:
		return -1.0
	return maxf(0.0, float(v) - ctx.server_now())


func _push_feed() -> void:
	var now: float = ctx.server_now()
	var mine = null
	if not _mine.is_empty():
		var ini = _mine.get("initiator")
		var iid: String = str(ini.get("id", "")) if ini is Dictionary else ""
		var oid: String = str(_mine.get("objectId", ""))
		var started = _mine.get("startedAt")
		var ends = _mine.get("endsAt")
		mine = {
			"id": str(_mine.get("id", "")),
			"status": str(_mine.get("status", "")),
			"name": str(_mine.get("name", "")),
			"objectId": oid,
			"objectLabel": str((_objs.get(oid, {}) as Dictionary).get("label", "")),
			"cost": str(_mine.get("cost", "")),
			"min": int(_mine.get("min", 1)),
			"max": int(_mine.get("max", 1)),
			"isInitiator": iid != "" and iid == _me_id,
			"initiator": str(ini.get("name", "")) if ini is Dictionary else "",
			"remainMs": _remain(_mine, "endsAt"),
			"lobbyRemainMs": _remain(_mine, "lobbyExpiresAt"),
			"startedAgoMs": maxf(0.0, now - float(started)) if started != null else null,
			"totalMs": maxf(0.0, float(ends) - float(started)) if started != null and ends != null else null,
			"people": _people_list(_mine),
		}
	var tables: Array = []
	var mine_oid: String = str(_mine.get("objectId", ""))
	for oid2 in _order:
		if oid2 == mine_oid:
			continue
		var o: Dictionary = _objs[oid2]
		var a: Dictionary = o["active"]
		var act: Dictionary = o["action"]
		tables.append(
			{
				"id": oid2,
				"label": str(o["label"]),
				"type": str(o["type"]),
				"actionName": str(act.get("name", "")),
				"cost": str(act.get("cost", "")),
				"min": int(act.get("min", 1)),
				"max": int(act.get("max", 1)),
				"near": bool(o["near"]),
				"status": str(a.get("status", "free")) if not a.is_empty() else "free",
				"people": _people_list(a) if not a.is_empty() else [],
				"remainMs": _remain(a, "endsAt") if not a.is_empty() else -1.0,
				"lobbyRemainMs": _remain(a, "lobbyExpiresAt") if not a.is_empty() else -1.0,
			}
		)
	feed_state({"mine": mine, "tables": tables, "last": _last if not _last.is_empty() else null})


# ───────────────────────── 事件 ─────────────────────────


func on_event(ev: Dictionary) -> void:
	var data = ev.get("data")
	if not (data is Dictionary):
		return
	_events += 1
	var t: String = str(ev.get("type", ""))
	if t == "interaction_done":
		_last_done = {"id": str(data.get("interactionId", "")), "text": str(data.get("text", ""))}
		_last = {"name": str(data.get("name", "")), "text": str(data.get("text", ""))}
		# 活动已经结算：走开拦截立刻放开，不等 /me
		_mine = {}
		_people = {}
		Logic.gate_clear(_gate)
		_begin_mark = ""
		_push_feed()
		return
	var it = data.get("interaction")
	if not (it is Dictionary) or _mine.is_empty() or str(it.get("id", "")) != str(_mine.get("id", "")):
		return  # 不是我这一桌：旁观者不弹提示
	var status: String = str(it.get("status", ""))
	var reason: String = str(data.get("reason", ""))
	if status == "cancelled":
		var ini = it.get("initiator")
		var mine_ini: bool = ini is Dictionary and str(ini.get("id", "")) == _me_id
		# 发起人自己走开引起的取消不再对他自己说一遍；等太久散场、别人造成的取消都要说
		if not mine_ini or reason.find(LOBBY_REASON_KEY) >= 0:
			ctx.toast("这一桌散了：" + reason if reason != "" else "这一桌散了。", "warn")
		_mine = {}
		_people = {}
		Logic.gate_clear(_gate)
		_begin_mark = ""
		_push_feed()
		return
	var parts = it.get("participants")
	if parts is Array:
		var diff: Dictionary = Logic.diff_people(_people, parts, _me_id)
		for nm in diff["joined"]:
			ctx.toast("%s 加入了。" % nm, "info")
		for nm2 in diff["left"]:
			ctx.toast("%s 走开了。" % nm2, "info")
		_people = _people_of(it)
	if status == "running" and str(_mine.get("status", "")) == "open":
		if _begin_mark != str(_mine.get("id", "")):
			var ends = it.get("endsAt")
			var ms: float = maxf(0.0, float(ends) - ctx.server_now()) if ends != null else 0.0
			ctx.toast("开始了，大约 %s。" % Logic.dur_text(ms), "info")
		_begin_mark = ""
		_mine["status"] = "running"


# ───────────────────────── 按钮 ─────────────────────────


func actions(out: Array) -> void:
	if _order.is_empty() or not ctx.playing() or ctx.in_game():
		return
	var sa = ctx.actors().get(ctx.self_id())
	if sa == null or (sa as TActor).moving:
		return
	var ini_id: String = ""
	if not _mine.is_empty() and _mine.get("initiator") is Dictionary:
		ini_id = str((_mine["initiator"] as Dictionary).get("id", ""))
	for oid in _order:
		var o: Dictionary = _objs[oid]
		if not ctx.near_ok(oid):
			continue
		var a: Dictionary = o["active"]
		var act: Dictionary = o["action"]
		var label: String = str(o["label"])
		# 故意：main._build_actions 对 min<=1 的物件（藏书架）在有活动时追加「使用中」，对玩家点过的物件追加「走过去」；
		# 这两条和下面的「加入 / 已开始」重复，只删自己这类物件（action.max>=2）且已经够得着的那几条
		_remove_entry(out, "busy:" + oid)
		_remove_entry(out, "go:" + oid)
		if a.is_empty():
			if _mine.is_empty():
				out.append({"id": "f:activity:invite:" + oid, "label": "约人" + str(act.get("name", "")), "sub": label, "mode": "do"})
			continue
		var aid: String = str(a.get("id", ""))
		var n: int = (a.get("participants") as Array).size() if a.get("participants") is Array else 0
		var mx: int = int(a.get("max", 1))
		var mn: int = int(a.get("min", 1))
		var status: String = str(a.get("status", ""))
		var in_it: bool = not _mine.is_empty() and str(_mine.get("id", "")) == aid
		if status == "open":
			if in_it:
				if ini_id != "" and ini_id == _me_id:
					if n >= mn:
						out.append({"id": "f:activity:begin:" + aid, "label": "开始", "sub": "%d/%d 人 · %s" % [n, mx, label], "mode": "do"})
					else:
						out.append({"id": "f:activity:wait:" + oid, "label": "等人中", "sub": "还差 %d 人 · %d/%d" % [mn - n, n, mn], "mode": "busy"})
			elif _mine.is_empty():
				var who: String = str((a.get("initiator") as Dictionary).get("name", "")) if a.get("initiator") is Dictionary else ""
				if n < mx:
					out.append({"id": "f:activity:join:" + aid, "label": "加入", "sub": "%s的%s %d/%d" % [who, str(a.get("name", "")), n, mx], "mode": "do"})
				else:
					out.append({"id": "f:activity:full:" + aid, "label": "已满", "sub": label, "mode": "busy"})
		elif status == "running" and not in_it:
			out.append({"id": "f:activity:running:" + oid, "label": "已开始", "sub": label, "mode": "busy"})


func _remove_entry(out: Array, entry_id: String) -> void:
	var i: int = out.size() - 1
	while i >= 0:
		var e = out[i]
		if e is Dictionary and str(e.get("id", "")) == entry_id:
			out.remove_at(i)
		i -= 1


func on_action(verb: String, arg: String) -> void:
	if verb != "invite" and verb != "join" and verb != "begin":
		return  # wait / full / running 是灰按钮，点不到
	_do_action(verb, arg)


func _do_action(verb: String, arg: String) -> void:
	if not ctx.control_mine():
		ctx.toast("现在是只读：另一处握着控制权。点上方「接管」拿回来。", "warn")
		return
	if _busy:
		return
	var g: int = _gen
	var me: String = _me_id
	_busy = true
	var action: Dictionary
	if verb == "invite":
		action = {"type": "start_interaction", "objectId": arg, "wait": true}
	elif verb == "join":
		action = {"type": "join_interaction", "interactionId": arg}
	else:
		action = {"type": "begin_interaction", "interactionId": arg}
		_begin_mark = arg
	var r: Dictionary = await ctx.act(action)
	if g != _gen:
		return  # 离开 / 换人之后回来的结果丢弃（_busy 已由 on_leave 清掉）
	_busy = false
	if me != _me_id or not ctx.playing():
		return
	_last_act = {"verb": verb, "ok": bool(r.get("ok", false)), "reason": str(r.get("reason", "")), "message": str(r.get("message", ""))}
	if bool(r.get("ok", false)):
		var d = r.get("data")
		var inter = d.get("interaction") if d is Dictionary else null
		var nm: String = str(inter.get("name", "")) if inter is Dictionary else ""
		if verb == "invite":
			ctx.toast("约了一桌%s，等人加入。" % nm, "ok")
		elif verb == "join":
			ctx.toast("加入了%s。" % nm, "ok")
		await ctx.refresh_me_wait()
		return
	_begin_mark = ""
	if str(r.get("error", "")) != "control_lost":
		ctx.toast(str(r.get("message", "没有完成。")), "err")
	match str(r.get("reason", "")):
		"too_far":
			ctx.invalidate_near()
		"not_here", "busy", "not_open", "full", "not_initiator", "not_enough":
			ctx.refresh_me()


# ───────────────────────── 点桌子选座 ─────────────────────────


func on_pick(kind: String, pick_id: String) -> bool:
	if kind != "obj" or not _objs.has(pick_id):
		return false  # 不是我的：游戏桌（不在 here.objects）、单人物件、居民
	var info: Dictionary = ctx.object_info(pick_id)
	if info.is_empty():
		return false
	var anchors = info.get("anchors")
	if not (anchors is Array) or (anchors as Array).size() < 2:
		return false
	var sa = ctx.actors().get(ctx.self_id())
	if sa == null:
		return false
	var me: Vector2 = (sa as TActor).disp
	var others: Array = []
	var acts: Dictionary = ctx.actors()
	var self_id: String = ctx.self_id()
	for aid in acts:
		if str(aid) != self_id:
			others.append((acts[aid] as TActor).disp)
	var r: Dictionary = Logic.pick_seat(anchors, me, others)
	if bool(r["seated"]):
		return true  # 已经坐在这张桌的某个座位上：吞掉，不发导航，也不让 main 把它记成选中物件
	# 防重入：同一张桌的路已经在发或在走（连按两下 E、双击）
	var now: int = Time.get_ticks_msec()
	if _walk_oid == pick_id and (_walk_busy or ((sa as TActor).moving and now - _walk_at < WALK_STALE_MS)):
		return true
	_picks += 1
	_walk_oid = pick_id
	_walk_at = now
	_do_walk(pick_id, r["point"] as Vector2, str(info.get("name", "")))
	return true


func _do_walk(oid: String, p: Vector2, label: String) -> void:
	var g: int = _gen
	_walk_busy = true
	var x: float = snappedf(p.x, 0.01)
	var z: float = snappedf(p.y, 0.01)
	await ctx.walk_to({"to": {"x": x, "z": z}}, label, Vector3(x, 0.0, z))
	if g == _gen and _walk_oid == oid:
		_walk_busy = false
		_walk_at = Time.get_ticks_msec()


# ───────────────────────── 走开前提示一次 ─────────────────────────


## 每帧可能被问：没有活动时第一行就返回，零开销。窗口和取值理由见 activity_logic.gd 与 client/docs/C2.md。
func blocks_input() -> String:
	if _mine.is_empty() or ctx.in_game() or not ctx.control_mine():
		return ""
	var now: int = Time.get_ticks_msec()
	if now < int(_gate["confirmed_until"]):
		return ""
	var ini = _mine.get("initiator")
	var is_ini: bool = ini is Dictionary and str(ini.get("id", "")) == _me_id
	var text: String = Logic.warn_text(str(_mine.get("status", "")), is_ini, str(_mine.get("name", "")))
	return Logic.gate(_gate, now, text)


# ───────────────────────── 桌牌 ─────────────────────────


func tags(cam: Camera3D, size: Vector2, out: Array) -> void:
	if _tags.is_empty():
		return
	var sa = ctx.actors().get(ctx.self_id())
	var me := Vector2.ZERO
	var has_me: bool = sa != null
	if has_me:
		me = (sa as TActor).disp
	for t in _tags:
		var wp: Vector3 = t["wp"]
		if has_me and me.distance_to(Vector2(wp.x, wp.z)) > SELECT_NEAR:
			continue
		if cam.is_position_behind(wp):
			continue
		var sp: Vector2 = cam.unproject_position(wp)
		out.append({"i": "c:" + str(t["oid"]), "n": str(t["text"]), "x": snappedf(sp.x / size.x, 0.0005), "y": snappedf(sp.y / size.y, 0.0005), "k": "c"})


# ───────────────────────── 调试 ─────────────────────────


func debug() -> Dictionary:
	var m = null
	if not _mine.is_empty():
		var ini = _mine.get("initiator")
		m = {
			"id": str(_mine.get("id", "")),
			"status": str(_mine.get("status", "")),
			"n": _people.size(),
			"min": int(_mine.get("min", 1)),
			"max": int(_mine.get("max", 1)),
			"isInitiator": ini is Dictionary and str(ini.get("id", "")) == _me_id,
			"objectId": str(_mine.get("objectId", "")),
		}
	var tb: Array = []
	for oid in _order:
		var o: Dictionary = _objs[oid]
		var a: Dictionary = o["active"]
		tb.append({"id": oid, "status": str(a.get("status", "free")) if not a.is_empty() else "free", "n": (a.get("participants") as Array).size() if not a.is_empty() and a.get("participants") is Array else 0, "max": int((o["action"] as Dictionary).get("max", 1)), "near": bool(o["near"])})
	var sit: Array = []
	var acts: Dictionary = ctx.actors()
	for aid in acts:
		if (acts[aid] as TActor).sitting:
			sit.append(str(aid))
	var tg: Array = []
	for t in _tags:
		tg.append(str(t["text"]))
	var left: int = maxi(0, int(_gate["confirmed_until"]) - Time.get_ticks_msec())
	return {
		"mine": m,
		"tables": tb,
		"sitting": sit,
		"warned": int(_gate["warned"]),
		"passed": int(_gate["passed"]),
		"confirmedLeft": left,
		"armed": int(_gate["warn_at"]) > 0 or left > 0,
		"last": _last_act if not _last_act.is_empty() else null,
		"lastDone": _last_done if not _last_done.is_empty() else null,
		"events": _events,
		"tags": tg,
		"picks": _picks,
		"busy": _busy,
	}
