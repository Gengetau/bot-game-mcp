extends TFeature
## 入座玩小游戏（街机厅的游戏桌，数字炸弹）：点桌子走到落脚点、开一局 / 加入 / 开始 / 散桌，局中的面板（overlay）和结果卡。
## 数据来源：/me 的 here.tables / here.activities（局外）、/me.game 与 GET /game（局内）、事件 activity / game_started / game / game_out / game_ended。
## 动作一律 ctx.act_once（不动 pending、不睡眠重试、可复用请求号）；too_far 时只自动走到落脚点，不自动重发动作。
## 局中封锁：blocks_input 返回非空；局结束、主动退出、on_leave、/me 里没有 game 之后一定清空，不会把人卡死。
## 位置：只读 ctx.actors() 的显示位置；落脚点用 world 里的 useAnchors，桌上方的牌用 tags 钩子现算屏幕坐标（坐标不出 Godot）。

const TABLE_REACH := 2.0  # 和服务端地图里游戏桌的 reach 一致（2 米，从桌心算）
const SEAT_BUSY := 0.6  # 别的角色在落脚点 0.6 米内算占着
const NEAR_SLACK := 0.5  # 「在桌边 k」的估计容差（只是软提示，开局时以服务端为准）
const PULL_SAFETY_S := 20.0  # 局中每隔这么久兜底读一次 /game
const PULL_ZERO_S := 1.5  # 倒计时归零后多久补读一次
const START_HOLD_S := 2.5  # game_started 之后这段时间里，旧的 /me（没有 game）不能把「在局中」清掉
const PICK_GUARD_S := 1.5  # 点了桌子走过去之后，这段时间里再点同一张桌子不重复发导航
const BLOCK_TEXT := "对局中，先打完这一局（或点「离开这局」）。"
const DROPPED_TEXT := "开局的时候你不在桌边，没有加入这一局。"

var _gen: int = 0
var _clock: float = 0.0
var _acc: float = 0.0
var _me_id: String = ""

# 凑桌（局外）
var _acts: Dictionary = {}  # activityId -> ActivityView（当前场所里 forming / running 的）
var _tables: Array = []  # /me.here.tables
var _seen_players: Dictionary = {}  # activityId -> {id: name}：只给「谁加入 / 离开」的提示做差
var _left_acts: Dictionary = {}  # 我自己点了离开的 activityId：别因此再弹「散了」
var _dropped_told: Dictionary = {}  # activityId -> true：已经提示过「开局时不在桌边」
var _near_sig: String = ""
var _walk_table: String = ""
var _walk_until: float = 0.0
var _inflight: Dictionary = {}  # verb -> true
var _rids: Dictionary = {}  # 动作键 -> 上次网络失败的请求号

# 局中
var _in_game: bool = false
var _act_id: String = ""
var _game_id: String = ""
var _game_name: String = ""
var _my_seat: int = -1
var _started_at: float = -100.0
var _view: Dictionary = {}
var _view_key: Array = [-2, -1]
var _view_t: float = 0.0
var _fetching: bool = false
var _fetch_again: bool = false
var _next_pull: float = 0.0
var _zero_done: Array = []  # 已经补读过的 (phase_id, 最后 seq)
var _ignored: Dictionary = {}  # 我自己退出的 activityId：之后到来的 game_ended 不弹卡
var _held_end: Dictionary = {}  # activityId -> game_ended 的载荷：退出请求还在路上时被抑制的结局，请求失败了要补弹
var _ended_aids: Dictionary = {}  # 已经结束 / 退出 / 清掉的 activityId：迟到的旧 /me 里还带着它，也不能把局复活
var _quitting: bool = false
var _quit_rid: String = ""
var _quit_aid: String = ""
var _guess_busy: bool = false
var _guess_rid: String = ""
var _guess_key: String = ""
var _last_ack: Dictionary = {}
var _result: Dictionary = {}
var _result_aid: String = ""

# 计数 / 记录（debug 与端到端用）
var _pulls: int = 0
var _stale_drops: int = 0
var _ended_ignored: int = 0
var _dropped_toasts: int = 0
var _walks: int = 0
var _last_seat: Array = []
var _sent: Dictionary = {}  # verb -> 请求次数
var _tag_texts: Dictionary = {}
var _last_tag_n: int = 0
var _inferred_ends: int = 0


func _init() -> void:
	id = "game"


func event_types() -> PackedStringArray:
	return PackedStringArray(["activity", "game_started", "game", "game_out", "game_ended"])


func wants_tick() -> bool:
	return true


func on_enter() -> void:
	pass


func on_leave() -> void:
	_gen += 1
	_reset_all()
	_me_id = ""
	feed("reset")
	forget_state()


func _reset_all() -> void:
	_acts.clear()
	_tables = []
	_seen_players.clear()
	_left_acts.clear()
	_dropped_told.clear()
	_near_sig = ""
	_walk_table = ""
	_walk_until = 0.0
	_inflight.clear()
	_rids.clear()
	_clear_game()
	_ended_aids.clear()
	_ignored.clear()
	_held_end.clear()
	_quitting = false
	_quit_rid = ""
	_result = {}
	_result_aid = ""
	_last_ack = {}
	_tag_texts.clear()


## 清掉「在局中」的全部状态（结果卡不在这里清）
func _clear_game() -> void:
	if _act_id != "":
		_ended_aids[_act_id] = true
	_in_game = false
	_act_id = ""
	_game_id = ""
	_game_name = ""
	_my_seat = -1
	_view = {}
	_view_key = [-2, -1]
	_fetching = false
	_fetch_again = false
	_zero_done = []
	_guess_busy = false
	_guess_rid = ""
	_guess_key = ""


# ───────────────────────── 读 /me ─────────────────────────


func on_me(view: Dictionary) -> void:
	var me = view.get("me")
	var mid: String = ""
	if me is Dictionary:
		mid = str(me.get("id", ""))
	if mid != "" and mid != _me_id:
		var had: bool = _me_id != ""
		_gen += 1
		_reset_all()
		_me_id = mid
		if had:
			feed("reset")
			forget_state()
	var g = view.get("game")
	if g is Dictionary and not (g as Dictionary).is_empty():
		_enter_game(str(g.get("activityId", "")), g)
	else:
		if _in_game and _clock - _started_at > START_HOLD_S:
			_game_vanished()
	var here = view.get("here")
	_tables = []
	if here is Dictionary:
		var ts = here.get("tables")
		if ts is Array:
			for t in ts:
				if t is Dictionary:
					_tables.append(t)
		var al = here.get("activities")
		var fresh: Dictionary = {}
		if al is Array:
			for a in al:
				if a is Dictionary and str(a.get("id", "")) != "" and a.get("players") is Array:
					fresh[str(a["id"])] = a
		_acts = {}
		for aid in fresh:
			_set_act(str(aid), fresh[aid])
		_forget_gone(fresh)
	else:
		_acts = {}
	_push()
	ctx.mark_dirty()


## 局外 /me 里没有的活动，不再记「谁在里面」
func _forget_gone(fresh: Dictionary) -> void:
	for k in _seen_players.keys():
		if not fresh.has(k):
			_seen_players.erase(k)


func _enter_game(aid: String, g: Dictionary) -> void:
	if not _in_game and _ended_aids.has(aid):
		return  # 这一局已经结束 / 退出了：迟到的旧 /me 不能把它复活，也不能抹掉结果卡
	if not _in_game or aid != _act_id:
		_in_game = true
		_act_id = aid
		_game_id = str(g.get("game_id", ""))
		_game_name = str(g.get("name", _game_name))
		_result = {}
		_result_aid = ""
		_view = {}
		_view_key = [-2, -1]
		_zero_done = []
		_next_pull = _clock + PULL_SAFETY_S
		_acts.clear()
		_walk_table = ""
	_ingest(g)


## /me 里没有 game 了，可是我们还以为在局中：局已经结束或中止，而 game_ended 没收到（断线）。补一张结果卡（我自己退出的不弹）
func _game_vanished() -> void:
	var aid: String = _act_id
	var nm: String = _game_name
	_clear_game()
	if aid == "":
		return
	if _ignored.has(aid):
		_ignored.erase(aid)
		_ended_ignored += 1
		return
	_inferred_ends += 1
	_show_result({"activityId": aid, "name": nm, "outcome": "", "reason": "", "won": false, "reward": 0}, true)


# ───────────────────────── 视图 ─────────────────────────


## 接受一份 /me.game 或 GET /game 的视图：按 (phase_id, 最后一条事件的 seq) 防乱序（旧的丢掉）
func _ingest(g: Dictionary) -> void:
	var gid: String = str(g.get("game_id", ""))
	if gid != "" and gid != _game_id:
		_game_id = gid
		_view_key = [-2, -1]
		_view = {}
	var pid = g.get("phase_id")
	var k0: int = -1 if pid == null else int(pid)
	var k1: int = 0
	var evs = g.get("events")
	if evs is Array and not (evs as Array).is_empty():
		var last = (evs as Array)[(evs as Array).size() - 1]
		if last is Dictionary:
			k1 = int(last.get("seq", 0))
	if k0 < int(_view_key[0]) or (k0 == int(_view_key[0]) and k1 < int(_view_key[1])):
		_stale_drops += 1
		return
	_view = g
	_view_key = [k0, k1]
	_view_t = _clock
	_game_name = str(g.get("name", _game_name))
	var you = g.get("you")
	if you is Dictionary and you.has("seat"):
		_my_seat = int(you["seat"])
	_next_pull = _clock + PULL_SAFETY_S


## 读 GET /game：合并并发请求（读的当口又来了新事件就读完再读一次）
func _pull() -> void:
	if not _in_game:
		return
	if _fetching:
		_fetch_again = true
		return
	_fetching = true
	var g: int = _gen
	while true:
		_fetch_again = false
		_pulls += 1
		var r: Dictionary = await ctx.api_get("/game")
		if g != _gen:
			return
		var d = r.get("data")
		if int(r.get("status", 0)) == 200 and d is Dictionary and _in_game:
			if str((d as Dictionary).get("activityId", "")) == _act_id:
				_ingest(d)
				_push()
		elif int(r.get("status", 0)) == 409:
			ctx.refresh_me()  # 已经不在局里：/me 回来后 on_me 清理
		if not _fetch_again:
			break
	_fetching = false


# ───────────────────────── 事件 ─────────────────────────


func on_event(ev: Dictionary) -> void:
	var d: Dictionary = ev.get("data", {}) if ev.get("data") is Dictionary else {}
	match str(ev.get("type", "")):
		"activity":
			_on_activity(d)
		"game_started":
			_on_started(d)
		"game":
			if _in_game and str(d.get("activityId", "")) == _act_id:
				_pull()
		"game_out":
			var tx: String = str(d.get("text", ""))
			if tx != "":
				ctx.toast(tx, "info")
		"game_ended":
			_on_ended(d)


func _on_activity(d: Dictionary) -> void:
	var a = d.get("activity")
	if not (a is Dictionary) or not (a.get("players") is Array):
		return  # 全镇的公开事件（只有人数）：不是这里要的
	var aid: String = str(a.get("id", ""))
	if aid == "":
		return
	var me_in: bool = _has_player(a, ctx.self_id())
	var was_mine: bool = _seen_players.has(aid) and (_seen_players[aid] as Dictionary).has(ctx.self_id())
	# 开局时被剔出去的人（dropped 里有我）：提示一次
	var dr = d.get("dropped")
	if dr is Array and (dr as Array).has(ctx.self_id()) and not _dropped_told.has(aid):
		_dropped_told[aid] = true
		_dropped_toasts += 1
		ctx.toast(DROPPED_TEXT, "warn")
	if d.has("ended") or d.has("reason") or str(a.get("status", "")) not in ["forming", "running"]:
		_acts.erase(aid)
		_seen_players.erase(aid)
		var why: String = str(d.get("reason", ""))
		if why != "" and was_mine and not _left_acts.has(aid) and not _in_game:
			ctx.toast("这一桌散了：%s。" % why, "warn")
		_left_acts.erase(aid)
	elif str(a.get("status", "")) == "running" and was_mine and not me_in and not _dropped_told.has(aid) and not _in_game:
		# 兜底：事件里没带 dropped 也能看出自己没进这一局
		_dropped_told[aid] = true
		_dropped_toasts += 1
		ctx.toast(DROPPED_TEXT, "warn")
		_acts.erase(aid)
		_seen_players.erase(aid)
	else:
		_set_act(aid, a)
	ctx.mark_dirty()
	ctx.refresh_me()  # near 与 here 以 /me 为准，也让事件和 /me 最终一致
	_push()


func _has_player(a: Dictionary, pid: String) -> bool:
	for p in (a.get("players", []) as Array):
		if p is Dictionary and str(p.get("id", "")) == pid:
			return true
	return false


## 记下一个活动，并对「我在这一桌里、有人加入 / 离开」弹一句提示
func _set_act(aid: String, a: Dictionary) -> void:
	var cur: Dictionary = {}
	for p in (a.get("players", []) as Array):
		if p is Dictionary:
			cur[str(p.get("id", ""))] = str(p.get("name", ""))
	var me: String = ctx.self_id()
	if _seen_players.has(aid) and (_seen_players[aid] as Dictionary).has(me) and cur.has(me) and str(a.get("status", "")) == "forming":
		var prev: Dictionary = _seen_players[aid]
		for k in cur:
			if not prev.has(k) and k != me:
				ctx.toast("%s 加入了这一桌。" % str(cur[k]), "ok")
		for k2 in prev:
			if not cur.has(k2) and k2 != me:
				ctx.toast("%s 离开了这一桌。" % str(prev[k2]), "info")
	_seen_players[aid] = cur
	_acts[aid] = a


func _on_started(d: Dictionary) -> void:
	var aid: String = str(d.get("activityId", ""))
	if aid == "":
		return
	_in_game = true
	_act_id = aid
	_game_id = str(d.get("gameId", ""))
	_game_name = str(d.get("name", ""))
	_my_seat = int(d.get("seat", -1))
	_started_at = _clock
	_view = {}
	_view_key = [-2, -1]
	_zero_done = []
	_result = {}
	_result_aid = ""
	_acts.clear()
	_walk_table = ""
	_next_pull = _clock + PULL_SAFETY_S
	ctx.mark_dirty()
	_push()
	var g: int = _gen
	await ctx.game_refresh_me_wait()
	if g != _gen:
		return
	if _in_game and _view.is_empty():
		_pull()


func _on_ended(d: Dictionary) -> void:
	var aid: String = str(d.get("activityId", ""))
	if aid == "":
		return
	if _ignored.has(aid):
		_ignored.erase(aid)
		_ended_ignored += 1
		if _quitting and aid == _quit_aid:
			_held_end[aid] = d  # 退出请求还没回来：它若失败，这一局其实是自然结束的，要补弹结果卡
		if aid == _act_id:
			_clear_game()
		_ended_aids[aid] = true
		_push()
		ctx.mark_dirty()
		ctx.refresh_me()
		return
	if aid == _result_aid and not _result.is_empty() and str(_result.get("kind", "")) != "unknown":
		return  # 重复的（只有「推断出来的」结果卡会被真实的事件覆盖：奖励和原因在事件里）
	_clear_game()
	_ended_aids[aid] = true
	_show_result(d, false)
	ctx.mark_dirty()
	ctx.refresh_me()


## 结果卡：先用事件里的话立刻显示，再拉匿名公开投影补原因和每个人的结局（失败就算了）
func _show_result(d: Dictionary, inferred: bool) -> void:
	var aid: String = str(d.get("activityId", ""))
	var outcome: String = str(d.get("outcome", ""))
	var won: bool = bool(d.get("won", false))
	var kind: String = "aborted" if outcome == "aborted" else ("won" if won else "lost")
	if inferred:
		kind = "unknown"
	_result_aid = aid
	_result = {
		"kind": kind,
		"name": str(d.get("name", _game_name)),
		"reason": str(d.get("reason", "")),
		"reward": int(d.get("reward", 0)),
		"players": [],
		"aid": aid,
	}
	_push()
	_pull_public(aid)


func _pull_public(aid: String) -> void:
	var g: int = _gen
	var r: Dictionary = await ctx.api_get("/public/game/" + aid.uri_encode())
	if g != _gen or _result_aid != aid or _result.is_empty():
		return
	var d = r.get("data")
	if int(r.get("status", 0)) != 200 or not (d is Dictionary):
		return
	var res = d.get("result")
	var pl: Array = []
	if res is Dictionary:
		if str(_result.get("reason", "")) == "":
			_result["reason"] = str(res.get("reason", ""))
		var rv = res.get("reveal")
		if rv is Array:
			for x in rv:
				if x is Dictionary:
					pl.append({"name": str(x.get("name", "")), "tag": str(x.get("identity", ""))})
		if str(_result.get("kind", "")) == "unknown":
			var ws = res.get("winnerSeats")
			var mine: bool = ws is Array and (ws as Array).has(_my_seat_from(d))
			_result["kind"] = "won" if mine else "lost"
	elif d.get("aborted") != null and str(_result.get("kind", "")) == "unknown":
		_result["kind"] = "aborted"
		if str(_result.get("reason", "")) == "":
			_result["reason"] = str(d.get("aborted")) if d.get("aborted") is String else ""
	_result["players"] = pl
	_push()


## 公开投影里找我的座位：按名字对（公开投影没有居民编号）
func _my_seat_from(d: Dictionary) -> int:
	var nm: String = _my_name()
	for p in (d.get("players", []) as Array):
		if p is Dictionary and str(p.get("name", "")) == nm:
			return int(p.get("seat", -1))
	return _my_seat


func _my_name() -> String:
	var a = ctx.actors().get(ctx.self_id())
	return str((a as TActor).actor_name) if a != null else ""


# ───────────────────────── 点桌子、按钮 ─────────────────────────


func _table_entry(oid: String) -> Dictionary:
	for t in _tables:
		if str(t.get("id", "")) == oid:
			return t
	return {}


func _my_pos() -> Variant:
	var sa = ctx.actors().get(ctx.self_id())
	if sa == null:
		return null
	return (sa as TActor).disp


func _walking() -> bool:
	var sa = ctx.actors().get(ctx.self_id())
	return sa != null and bool((sa as TActor).moving)


func _dist_table(oid: String) -> float:
	var info: Dictionary = ctx.game_object_info(oid)
	var me = _my_pos()
	if info.is_empty() or me == null:
		return INF
	return (me as Vector2).distance_to(info["center"])


func on_pick(kind: String, pick_id: String) -> bool:
	if kind != "obj":
		return false
	if _table_entry(pick_id).is_empty():
		return false
	if _in_game:
		return true
	# 已经站在这张桌的落脚点上：什么都不做（吞掉，免得 main 再发一次 navigate、把桌子记成选中物件）
	if _dist_table(pick_id) <= TABLE_REACH:
		return true
	# 刚点过同一张桌子、正在走过去：不重复发导航（连按两下 E）
	if _walk_table == pick_id and _clock < _walk_until:
		return true
	_walk_to_table(pick_id)
	return true


func _walk_to_table(oid: String) -> void:
	var info: Dictionary = ctx.game_object_info(oid)
	if info.is_empty():
		return
	var me = _my_pos()
	var others: Array = []
	for aid in ctx.actors():
		if aid == ctx.self_id():
			continue
		others.append((ctx.actors()[aid] as TActor).disp)
	var anchors: Array = info.get("anchors", [])
	var nm: String = str(info.get("name", ""))
	_walk_table = oid
	_walk_until = _clock + PICK_GUARD_S
	_walks += 1
	if anchors.is_empty() or me == null:
		_last_seat = []
		ctx.game_walk_to({"to": oid}, nm)
		return
	var i: int = pick_seat(anchors, others, me, SEAT_BUSY)
	var p: Vector2 = anchors[i]
	_last_seat = [snappedf(p.x, 0.01), snappedf(p.y, 0.01)]
	ctx.game_walk_to({"to": {"x": snappedf(p.x, 0.01), "z": snappedf(p.y, 0.01)}}, nm, Vector3(p.x, 0.0, p.y))


## 选落脚点：没被别人占着（0.6 米内没有别的角色）的里面取离自己最近的；全占了就取最近的。返回 anchors 的下标。
static func pick_seat(anchors: Array, others: Array, me: Vector2, busy_d: float) -> int:
	var best: int = -1
	var best_d: float = INF
	var any: int = -1
	var any_d: float = INF
	for i in range(anchors.size()):
		var p: Vector2 = anchors[i]
		var d: float = p.distance_to(me)
		if d < any_d:
			any_d = d
			any = i
		var taken: bool = false
		for o in others:
			if (o as Vector2).distance_to(p) < busy_d:
				taken = true
				break
		if not taken and d < best_d:
			best_d = d
			best = i
	return best if best >= 0 else any


## 我在哪一桌里（forming 的那桌的 ActivityView），不在返回空字典
func _my_lobby() -> Dictionary:
	var me: String = ctx.self_id()
	for aid in _acts:
		var a: Dictionary = _acts[aid]
		if str(a.get("status", "")) == "forming" and _has_player(a, me):
			return a
	return {}


func _table_label(oid: String) -> String:
	var t: Dictionary = _table_entry(oid)
	return str(t.get("name", oid))


func _count_near(a: Dictionary) -> int:
	var tid: String = str(a.get("tableId", ""))
	var info: Dictionary = ctx.game_object_info(tid)
	if info.is_empty():
		return 0
	var c: Vector2 = info["center"]
	var n: int = 0
	for p in (a.get("players", []) as Array):
		var x = ctx.actors().get(str((p as Dictionary).get("id", "")))
		if x != null and ((x as TActor).disp as Vector2).distance_to(c) <= TABLE_REACH + NEAR_SLACK:
			n += 1
	return n


func actions(out: Array) -> void:
	# 游戏桌不该出「走过去」按钮（on_pick 已经接管了点选）；只删游戏桌的，别的条目不碰
	var i: int = out.size() - 1
	while i >= 0:
		var oid: String = str(out[i].get("id", ""))
		if oid.begins_with("go:") and not _table_entry(oid.substr(3)).is_empty():
			out.remove_at(i)
		i -= 1
	if _in_game:
		out.append({"id": "f:game:quit", "label": "离开这局", "sub": _game_name, "mode": "do"})
		return
	if not ctx.control_mine() or _tables.is_empty():
		return
	var mine: Dictionary = _my_lobby()
	if not mine.is_empty():
		var aid: String = str(mine.get("id", ""))
		var host_id: String = str((mine.get("host", {}) as Dictionary).get("id", ""))
		var players: int = (mine.get("players", []) as Array).size()
		if host_id == ctx.self_id():
			out.append({"id": "f:game:start:" + aid, "label": "开始", "sub": "%d/%d 人 · 在桌边 %d" % [players, int(mine.get("max", 2)), _count_near(mine)], "mode": "do"})
			out.append({"id": "f:game:leave", "label": "散桌", "sub": _table_label(str(mine.get("tableId", ""))), "mode": "go"})
		else:
			out.append({"id": "f:game:leave", "label": "离开这桌", "sub": _table_label(str(mine.get("tableId", ""))), "mode": "go"})
		return
	if not ctx.game_near_valid() or _walking():
		return
	for t in _tables:
		if not bool(t.get("near", false)):
			continue
		var tid: String = str(t.get("id", ""))
		var act: Dictionary = {}
		for k in _acts:
			if str((_acts[k] as Dictionary).get("tableId", "")) == tid:
				act = _acts[k]
		var t_act = t.get("activityId")  # JSON 的 null 在 GDScript 里 str() 出来是 "<null>"，不能直接和空串比
		if act.is_empty() and (t_act == null or str(t_act) == ""):
			out.append({"id": "f:game:propose:" + tid, "label": "开一局：数字炸弹", "sub": str(t.get("name", "")), "mode": "do"})
		elif not act.is_empty() and str(act.get("status", "")) == "forming" and (act.get("players", []) as Array).size() < int(act.get("max", 2)):
			out.append({"id": "f:game:join:" + str(act.get("id", "")), "label": "加入", "sub": "%s · %d/%d" % [str(act.get("name", "")), (act.get("players", []) as Array).size(), int(act.get("max", 2))], "mode": "do"})
		else:
			out.append({"id": "f:game:busy:" + tid, "label": "这桌在玩", "sub": str(t.get("name", "")), "mode": "busy"})


func on_action(verb: String, arg: String) -> void:
	match verb:
		"propose":
			await _lobby_act("propose", {"type": "propose_game", "game": "number_bomb", "objectId": arg}, arg)
		"join":
			var a: Dictionary = _acts.get(arg, {})
			var tid: String = str(a.get("tableId", ""))
			var act: Dictionary = {"type": "join_game", "activityId": arg}
			if tid != "":
				act["objectId"] = tid
			await _lobby_act("join", act, tid)
		"start":
			var a2: Dictionary = _acts.get(arg, {})
			await _lobby_act("start", {"type": "start_game", "activityId": arg}, str(a2.get("tableId", "")))
		"leave":
			var m: Dictionary = _my_lobby()
			if not m.is_empty():
				_left_acts[str(m.get("id", ""))] = true
			await _lobby_act("leave", {"type": "leave_game_lobby"}, "")
		"quit":
			feed("confirm")
		"busy":
			pass


func _lobby_act(verb: String, action: Dictionary, table_id: String) -> void:
	if _in_game or _inflight.has(verb):
		return
	if not ctx.control_mine():
		ctx.toast("现在是只读：另一处握着控制权。点上方「接管」拿回来。", "warn")
		return
	_inflight[verb] = true
	_sent[verb] = int(_sent.get(verb, 0)) + 1
	var key: String = verb + ":" + JSON.stringify(action)
	var rid: String = str(_rids.get(key, ""))
	if rid == "":
		rid = ctx.new_req_id()
	var g: int = _gen
	var r: Dictionary = await ctx.act_once(action, {"rid": rid})
	if g != _gen:
		return
	_inflight.erase(verb)
	ctx.mark_dirty()
	if bool(r.get("ok", false)):
		_rids.erase(key)
		var d: Dictionary = r["data"] if r.get("data") is Dictionary else {}
		var a = d.get("activity")
		if a is Dictionary and a.get("players") is Array:
			_set_act(str(a.get("id", "")), a)
		if verb == "join":
			_left_acts.erase(str(action.get("activityId", "")))  # 重新加入了：这一桌之后散了，要照常提示
		var dropped = d.get("dropped")
		if verb == "start" and dropped is Array and not (dropped as Array).is_empty():
			var names: Array = []
			for x in dropped:
				names.append(str(x))
			ctx.toast("%s 不在桌边，没有加入这一局。" % "、".join(names), "info")
		ctx.refresh_me()
		_push()
		return
	if bool(r.get("net_fail", false)):
		_rids[key] = str(r.get("rid", rid))  # 再点同一个动作带回同一个请求号：不会开两桌
		ctx.toast("网络不通，再点一次就好。", "warn")
		return
	_rids.erase(key)
	var reason: String = str(r.get("reason", ""))
	var data = r.get("data")
	if reason == "too_far":
		# 只自动走过去，不重发：到了再点一次
		var tid: String = table_id
		if tid == "" and data is Dictionary:
			tid = str(data.get("navigateTo", ""))
		if tid != "" and not _table_entry(tid).is_empty():
			_walk_to_table(tid)
		ctx.toast("离桌子有点远，先走过去，到了再点一次。", "info")
		return
	ctx.toast(str(r.get("message", "没能做成，稍后再试。")), "warn")
	if verb == "leave":
		_left_acts.clear()
	if reason in ["table_busy", "not_open", "not_here", "full", "wrong_table", "not_in_lobby", "not_host", "already_in_activity"] or str(r.get("error", "")) == "context_stale":
		ctx.refresh_me()


# ───────────────────────── 网页 -> Godot ─────────────────────────


func on_ui(ui_name: String, arg: String) -> void:
	match ui_name:
		"guess":
			await _guess(arg)
		"leave":
			await _quit()
		"dismiss":
			if not _result.is_empty():
				_result = {}
				_result_aid = ""
				_push()
				ctx.mark_dirty()
		"refresh":
			_pull()


func _ack(n: int, extra: Dictionary) -> void:
	var a: Dictionary = {"n": n}
	a.merge(extra)
	_last_ack = a
	feed("ack", a)


func _range() -> Array:
	var pub = _view.get("public")
	if pub is Dictionary and pub.get("range") is Dictionary:
		var rg: Dictionary = pub["range"]
		return [int(rg.get("from", 0)), int(rg.get("to", 0))]
	return []


func _guess(arg: String) -> void:
	var p = JSON.parse_string(arg)
	if not (p is Dictionary):
		return
	var n: int = int(p.get("n", 0))
	if not _in_game:
		_ack(n, {"ok": false, "code": "not_in_game", "message": ""})
		return
	if _guess_busy:
		_ack(n, {"ok": false, "code": "busy", "message": ""})
		return
	var rg: Array = _range()
	var num: int = int(p.get("number", 0))
	# 本地再核一次范围（网页一侧已经核过）：越界不发请求。强发旧阶段号 / 非本人回合的由服务器回答
	if rg.size() == 2 and (num < int(rg[0]) or num > int(rg[1])):
		_ack(n, {"ok": false, "code": "range", "message": "只能猜 %d~%d 之间的数。" % [int(rg[0]), int(rg[1])]})
		return
	var gid: String = str(p.get("gameId", _game_id))
	var phase_id: int = int(p.get("phaseId", -1))
	var key: String = "%s:%d:%d" % [gid, phase_id, num]
	var rid: String = _guess_rid if key == _guess_key and _guess_rid != "" else ctx.new_req_id()
	_guess_key = key
	_guess_rid = rid
	_guess_busy = true
	_sent["guess"] = int(_sent.get("guess", 0)) + 1
	var g: int = _gen
	var r: Dictionary = await ctx.act_once({"type": "game_act", "gameId": gid, "phaseId": phase_id, "input": {"action": "guess", "number": num}}, {"rid": rid, "retry_stale": false})
	if g != _gen:
		return
	_guess_busy = false
	if bool(r.get("ok", false)):
		_guess_key = ""
		_guess_rid = ""
		_ack(n, {"ok": true})
		_pull()
		return
	if bool(r.get("net_fail", false)):
		_ack(n, {"ok": false, "code": "net", "message": "网络不通，再点一次就好。"})
		return
	_guess_key = ""
	_guess_rid = ""
	var code: String = str(r.get("error", ""))
	_ack(n, {"ok": false, "code": code, "reason": str(r.get("reason", "")), "message": str(r.get("message", "")), "retryMs": int(r.get("retry_after_ms", 0))})
	if code == "phase_stale":
		_pull()
	elif code == "context_stale":
		ctx.refresh_me()


func _quit() -> void:
	if _quitting or not _in_game:
		return
	_quitting = true
	var aid: String = _act_id
	_quit_aid = aid
	var g: int = _gen
	_ignored[aid] = true
	if _quit_rid == "":
		_quit_rid = ctx.new_req_id()
	var r: Dictionary = await ctx.act_once({"type": "quit_game"}, {"rid": _quit_rid, "retry_stale": false})
	if g != _gen:
		return
	_quitting = false
	if bool(r.get("ok", false)):
		_quit_rid = ""
		_held_end.erase(aid)
		if _act_id == aid:
			_clear_game()
		_push()
		ctx.mark_dirty()
		ctx.toast("你离开了这一局，回到了街机厅。", "ok")
		await ctx.game_refresh_me_wait()
		return
	if bool(r.get("net_fail", false)):
		# 请求号留着（再点一次是同一个请求，不会退两次）；「我退出了」的记号撤掉：请求可能根本没到服务端，
		# 这一局之后自然结束时要照常弹结果卡。再点「离开这局」时 _quit 会重新记上
		_ignored.erase(aid)
		_release_held(aid)
		ctx.toast("网络不通，再点一次「离开这局」。", "warn")
		return
	_quit_rid = ""
	_ignored.erase(aid)
	_release_held(aid)
	ctx.toast(str(r.get("message", "没能离开，稍后再试。")), "warn")
	if str(r.get("error", "")) == "context_stale":
		ctx.refresh_me()


## 退出没成：退出请求在路上的时候，这一局自然结束了（game_ended 被「我退出了」的记号抑制）。补弹那张结果卡
func _release_held(aid: String) -> void:
	if not _held_end.has(aid):
		return
	var d: Dictionary = _held_end[aid]
	_held_end.erase(aid)
	if not _in_game and _result.is_empty():
		_show_result(d, false)
		ctx.mark_dirty()


# ───────────────────────── 重连 ─────────────────────────


func on_hello(_msg: Dictionary, _resumed: bool, first: bool) -> void:
	if first:
		return
	if _in_game or not _acts.is_empty() or not _my_lobby().is_empty():
		ctx.refresh_me()
		_pull()


func on_resync() -> void:
	if _in_game:
		ctx.refresh_me()
		_pull()


# ───────────────────────── 每帧 ─────────────────────────


func tick(dt: float, _now_ms: float) -> void:
	_clock += dt
	_acc += dt
	if _acc < 0.25:
		return
	_acc = 0.0
	if _in_game:
		if not _view.is_empty():
			var ph = _view.get("phase")
			if ph is Dictionary and ph.get("seconds_left") != null and bool(ph.get("open", false)):
				var left: float = float(ph["seconds_left"]) - (_clock - _view_t)
				if left < -PULL_ZERO_S and not _zero_done.has(_view_key):
					_zero_done.append(_view_key.duplicate())
					_pull()
		if _clock >= _next_pull:
			_next_pull = _clock + PULL_SAFETY_S
			_pull()
		return
	# 局外：「在桌边 k」随人走动变化，按钮的副标题要跟着变
	var sig: String = ""
	var mine: Dictionary = _my_lobby()
	if not mine.is_empty():
		sig = "%s:%d:%d" % [str(mine.get("id", "")), (mine.get("players", []) as Array).size(), _count_near(mine)]
	if sig != _near_sig:
		_near_sig = sig
		ctx.mark_dirty()


func blocks_input() -> String:
	return BLOCK_TEXT if _in_game else ""


# ───────────────────────── 桌上方的牌 ─────────────────────────


func tags(cam: Camera3D, size: Vector2, out: Array) -> void:
	_tag_texts.clear()
	if _in_game:
		return
	for k in _acts:
		var a: Dictionary = _acts[k]
		var tid: String = str(a.get("tableId", ""))
		var info: Dictionary = ctx.game_object_info(tid)
		if info.is_empty():
			continue
		var text: String = ""
		var n: int = (a.get("players", []) as Array).size()
		if str(a.get("status", "")) == "forming":
			text = "%s · 等人 %d/%d（至少 %d 人）" % [str(a.get("name", "")), n, int(a.get("max", 2)), int(a.get("min", 2))]
		else:
			text = "%s · 对局中" % str(a.get("name", ""))
		_tag_texts["g:" + tid] = text
		var c: Vector2 = info["center"]
		var wp := Vector3(c.x, 1.9, c.y)
		if cam.is_position_behind(wp):
			continue
		var sp: Vector2 = cam.unproject_position(wp)
		out.append({"i": "g:" + tid, "n": text, "x": snappedf(sp.x / size.x, 0.0005), "y": snappedf(sp.y / size.y, 0.0005), "k": "g", "sel": false})


# ───────────────────────── 推给网页 ─────────────────────────


func _push() -> void:
	feed_state(_state())


func _state() -> Dictionary:
	if _in_game:
		return _game_state()
	if not _result.is_empty():
		var rs: Dictionary = _result.duplicate(true)
		rs["mode"] = "result"
		return rs
	return {"mode": "none"}


func _game_state() -> Dictionary:
	var v: Dictionary = _view
	var d: Dictionary = {"mode": "game", "name": _game_name, "gameId": _game_id, "mySeat": _my_seat, "loading": v.is_empty()}
	if v.is_empty():
		return d
	var pub: Dictionary = v.get("public", {}) if v.get("public") is Dictionary else {}
	var ph = v.get("phase")
	var cur: int = -1
	var ct = pub.get("current_turn")
	if ct != null:
		cur = str(ct).to_int()
	d["round"] = int(v.get("round", 0))
	d["title"] = str(ph.get("title", "")) if ph is Dictionary else ""
	d["open"] = ph is Dictionary and bool(ph.get("open", false))
	d["secondsLeft"] = int(ph["seconds_left"]) if ph is Dictionary and ph.get("seconds_left") != null else -1
	d["phaseId"] = int(v["phase_id"]) if v.get("phase_id") != null else -1
	d["yourTurn"] = bool(v.get("your_turn", false))
	d["curSeat"] = cur
	d["range"] = {"from": 0, "to": 0}
	if pub.get("range") is Dictionary:
		d["range"] = {"from": int(pub["range"].get("from", 0)), "to": int(pub["range"].get("to", 0))}
	d["bombMode"] = str(pub.get("mode", ""))
	d["over"] = v.get("aborted") != null
	var names: Dictionary = {}
	var pl: Array = []
	for p in (v.get("players", []) as Array):
		if not (p is Dictionary):
			continue
		var seat: int = int(p.get("seat", -1))
		names[seat] = str(p.get("name", ""))
		pl.append({"seat": seat, "name": str(p.get("name", "")), "kind": "agent" if str(p.get("kind", "")) == "agent" else "human", "alive": bool(p.get("alive", true)), "turn": seat == cur, "me": seat == _my_seat})
	d["players"] = pl
	var hist: Array = []
	var hs = pub.get("history")
	if hs is Array:
		var start: int = maxi(0, (hs as Array).size() - 12)
		for i in range(start, (hs as Array).size()):
			var h = hs[i]
			if h is Dictionary:
				hist.append({"round": int(h.get("round", 0)), "seat": int(h.get("seat", -1)), "name": str(names.get(int(h.get("seat", -1)), "")), "guess": int(h.get("guess", 0)), "result": str(h.get("result", "")), "auto": bool(h.get("auto", false))})
	d["history"] = hist
	return d


# ───────────────────────── 调试 ─────────────────────────


func debug() -> Dictionary:
	var tbl: Array = []
	for t in _tables:
		tbl.append({"id": str(t.get("id", "")), "activityId": t.get("activityId"), "near": bool(t.get("near", false))})
	var acts: Array = []
	for k in _acts:
		var a: Dictionary = _acts[k]
		acts.append({"id": str(k), "table": str(a.get("tableId", "")), "status": str(a.get("status", "")), "players": (a.get("players", []) as Array).size(), "max": int(a.get("max", 0)), "host": str((a.get("host", {}) as Dictionary).get("id", ""))})
	return {
		"inGame": _in_game,
		"activityId": _act_id,
		"gameId": _game_id,
		"seat": _my_seat,
		"hasView": not _view.is_empty(),
		"viewKey": _view_key,
		"yourTurn": bool(_view.get("your_turn", false)),
		"blocks": blocks_input(),
		"resultKind": str(_result.get("kind", "")),
		"resultReason": str(_result.get("reason", "")),
		"endedIgnored": _ended_ignored,
		"droppedToasts": _dropped_toasts,
		"inferredEnds": _inferred_ends,
		"pulls": _pulls,
		"staleDrops": _stale_drops,
		"walks": _walks,
		"lastSeat": _last_seat,
		"sent": _sent,
		"tables": tbl,
		"acts": acts,
		"lobby": str(_my_lobby().get("id", "")),
		"tagTexts": _tag_texts,
		"lastAck": _last_ack,
		"guessBusy": _guess_busy,
		"me": _me_id,
	}
