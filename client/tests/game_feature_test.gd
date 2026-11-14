extends SceneTree
## game.gd 的功能级单测：用假的 ctx（继承 TCtx、覆盖要用到的口子）直接喂 on_me / on_event / on_action / on_ui，不起浏览器。
## 覆盖评审核实过的生命周期问题：
##  - 迟到的旧 /me（还带着已结束的局）不能把局复活、不能抹掉真实的结果卡；推断出来的结果卡要被真实的 game_ended 覆盖（补上奖励）；
##  - 主动退出之后迟到的旧 /me 不复活，之后到的 game_ended 仍被抑制；
##  - 退出请求网络失败后「我退出了」的记号撤掉，局自然结束时照常弹结果卡；退出请求在路上时局自然结束、退出又失败（context_stale），补弹结果卡；
##  - 离开一桌之后重新加入同一桌，这一桌之后被取消要照常提示「这一桌散了」；
##  - 开局那一刻还在路上的旧 /me（没有 game）晚到，推断出「结束了」之后，下一份带着 game 的 /me 要把局接回来（推断的结束不登记）；
##  - 推断出来的结果卡被公开投影补全（kind 不再是 unknown）之后，真实的 game_ended 仍要覆盖它；
##  - 退出时网络失败留下的请求号只对同一局有效，下一局退出要换新的请求号；
##  - 退出请求在路上时一份没有 game 的 /me 抢先到（把「我退出了」的记号用掉）：退出成功后记号要补上，之后到的 game_ended 不弹卡；
##  - 上一局确实结束、下一局已经开始，还带着上一局的旧 /me 晚到：不能把面板换回上一局。
## 用法：npm run client:unit（或 /opt/godot/godot --headless --path client/town --script ../tests/game_feature_test.gd）

const Game := preload("res://scripts/features/game.gd")

const SELF := "r_me"
const AID := "act_1"

var _fails: int = 0
var _checks: int = 0


class FakeCtx:
	extends TCtx
	signal act_release
	var toasts: Array = []
	var acts: Dictionary = {}
	var act_calls: Array = []
	var act_opts: Array = []
	var public_data = null  # 不是 null 时，GET /public/game/<aid> 返回它
	var act_result: Dictionary = {"ok": true, "data": {}}
	var hold_act: bool = false
	var refreshes: int = 0
	var _br := TBridge.new()

	func bridge() -> TBridge:
		return _br

	func self_id() -> String:
		return SELF

	func actors() -> Dictionary:
		return acts

	func control_mine() -> bool:
		return true

	func toast(text: String, kind: String = "info") -> void:
		toasts.append({"text": text, "kind": kind})

	func refresh_me() -> void:
		refreshes += 1

	func mark_dirty() -> void:
		pass

	func new_req_id() -> String:
		return "rid_%d" % act_calls.size()

	func act_once(action: Dictionary, _opts: Dictionary = {}) -> Dictionary:
		act_calls.append(action)
		act_opts.append(_opts)
		if hold_act:
			await act_release
		return act_result

	func api_get(_path: String) -> Dictionary:
		if public_data != null and _path.begins_with("/public/game/"):
			return {"status": 200, "data": public_data}
		return {"status": 404, "data": null}

	func game_refresh_me_wait() -> bool:
		return true

	func game_object_info(_oid: String) -> Dictionary:
		return {}

	func game_near_valid() -> bool:
		return true


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	_run()


func _make() -> Array:
	var c := FakeCtx.new()
	var f = Game.new()
	f.ctx = c
	return [f, c]


func _game_view(aid: String = AID) -> Dictionary:
	return {"activityId": aid, "game_id": "g_" + aid, "name": "数字炸弹", "phase_id": 1, "events": [], "public": {"range": {"from": 1, "to": 100}}, "players": [{"seat": 1, "name": "我", "kind": "human", "alive": true}, {"seat": 2, "name": "对手", "kind": "human", "alive": true}], "you": {"seat": 1}}


func _me(game = null) -> Dictionary:
	var v: Dictionary = {"me": {"id": SELF}, "here": {"tables": [], "activities": []}}
	if game != null:
		v["game"] = game
	return v


func _ended(aid: String = AID, won: bool = true, reward: int = 2) -> Dictionary:
	return {"type": "game_ended", "data": {"activityId": aid, "gameId": "g_" + aid, "name": "数字炸弹", "outcome": "completed", "reason": "对手猜中了炸弹", "won": won, "reward": reward}}


func _has_toast(c: FakeCtx, frag: String) -> bool:
	for t in c.toasts:
		if str(t["text"]).find(frag) >= 0:
			return true
	return false


func _run() -> void:
	t_late_me_after_end()
	t_inferred_card_overwritten()
	await t_late_me_after_quit()
	await t_quit_net_fail()
	await t_quit_collides_with_end()
	await t_left_act_rejoin()
	t_stale_me_at_start_heals()
	t_inferred_resolved_then_real()
	await t_quit_rid_per_game()
	await t_quit_me_races_ahead()
	t_ended_game_cannot_replace_next()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


## lifecycle#1：game_ended 先到、旧 /me（还带着 game）后到：局不复活，真实结果卡（奖励 2、赢）保留；追读的 /me 没有 game 也不会推断出另一张卡
func t_late_me_after_end() -> void:
	var s: Array = _make()
	var f = s[0]
	f.on_me(_me(_game_view()))
	check(f._in_game, "进局")
	f.on_event(_ended())
	check(not f._in_game and f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2, "game_ended 之后：结果卡是赢、奖励 2：%s" % str(f._result))
	f.on_me(_me(_game_view()))  # 迟到的旧 /me
	check(not f._in_game, "迟到的旧 /me 不能把已结束的局复活")
	check(f.blocks_input() == "", "迟到的旧 /me 之后不应封锁输入")
	check(f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2, "迟到的旧 /me 不能抹掉真实的结果卡：%s" % str(f._result))
	f.on_me(_me())  # 追读的 /me：没有 game
	check(f._result.get("kind") == "won" and f._inferred_ends == 0, "追读的 /me 不应推断出另一张卡：%s" % str(f._result))
	f.on_event(_ended())  # 重复的 game_ended 也不改
	check(int(f._result.get("reward", 0)) == 2, "重复的 game_ended 不改结果卡")


## lifecycle#1：先推断出结果卡（reward 0、unknown），之后真实的 game_ended 到了，要用它覆盖（补上奖励和输赢）
func t_inferred_card_overwritten() -> void:
	var s: Array = _make()
	var f = s[0]
	f.on_me(_me(_game_view()))
	f.on_me(_me())  # 断线期间错过 game_ended：/me 里没有 game 了 -> 推断
	check(f._result.get("kind") == "unknown" and int(f._result.get("reward", -1)) == 0, "先是推断出来的结果卡：%s" % str(f._result))
	f.on_event(_ended())
	check(f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2, "真实的 game_ended 要覆盖推断卡（奖励 2、赢）：%s" % str(f._result))


## lifecycle#1（主动退出版）：退出成功之后旧 /me 迟到，不复活、不消耗「我退出了」的记号；之后的 game_ended 仍被抑制
func t_late_me_after_quit() -> void:
	var s: Array = _make()
	var f = s[0]
	f.on_me(_me(_game_view()))
	await f.on_ui("leave", "")
	check(not f._in_game and f._ignored.has(AID), "退出成功：不在局里、记号还在")
	f.on_me(_me(_game_view()))  # 迟到的旧 /me
	check(not f._in_game, "退出之后迟到的旧 /me 不复活")
	f.on_me(_me())
	check(f._ignored.has(AID) and f._result.is_empty(), "追读的 /me 不消耗记号、不弹卡：%s" % str(f._result))
	f.on_event(_ended())
	check(f._result.is_empty() and f._ended_ignored == 1, "之后到的 game_ended 仍被抑制")


## lifecycle#3：退出请求网络失败：记号撤掉，局自然结束时照常弹卡
func t_quit_net_fail() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	f.on_me(_me(_game_view()))
	c.act_result = {"ok": false, "net_fail": true, "rid": "x"}
	await f.on_ui("leave", "")
	check(f._in_game and not f._ignored.has(AID), "网络失败：还在局里、记号撤掉")
	f.on_event(_ended())
	check(f._result.get("kind") == "won", "网络失败之后局自然结束：要弹结果卡：%s" % str(f._result))
	# 再点一次：同一个请求号，记号重新记上
	var s2: Array = _make()
	var f2 = s2[0]
	var c2: FakeCtx = s2[1]
	f2.on_me(_me(_game_view()))
	c2.act_result = {"ok": false, "net_fail": true, "rid": "x"}
	await f2.on_ui("leave", "")
	c2.act_result = {"ok": true, "data": {}}
	await f2.on_ui("leave", "")
	check(f2._ignored.has(AID) and not f2._in_game, "再点一次成功：记号重新记上")
	check(c2.act_calls.size() == 2, "两次退出请求")


## lifecycle#3（后半）：退出请求在路上时局自然结束（game_ended 被抑制），请求回来是 context_stale：补弹结果卡
func t_quit_collides_with_end() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	f.on_me(_me(_game_view()))
	c.hold_act = true
	c.act_result = {"ok": false, "error": "context_stale", "message": "已经不在局里"}
	f.on_ui("leave", "")  # 不 await：请求在路上
	check(f._quitting, "退出请求在路上")
	f.on_event(_ended())
	check(f._result.is_empty(), "请求在路上时 game_ended 被抑制")
	c.act_release.emit()
	await process_frame
	check(f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2, "退出失败（context_stale）之后补弹结果卡：%s" % str(f._result))
	# 退出成功就不补
	var s2: Array = _make()
	var f2 = s2[0]
	var c2: FakeCtx = s2[1]
	f2.on_me(_me(_game_view()))
	c2.hold_act = true
	f2.on_ui("leave", "")
	f2.on_event(_ended())
	c2.act_release.emit()
	await process_frame
	check(f2._result.is_empty() and f2._held_end.is_empty(), "退出成功：不补卡、不留暂存")
	check(not f2._ignored.has(AID), "game_ended 已经到过：退出成功后不把记号重新记上（不残留）")


## lifecycle#4：离开一桌之后又加入同一桌，这一桌被取消：照常提示「这一桌散了」
func t_left_act_rejoin() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	var act: Dictionary = {"id": "a1", "game": "number_bomb", "tableId": "arcade:table1", "status": "forming", "host": "r_other", "players": [{"id": "r_other", "name": "他", "kind": "human"}, {"id": SELF, "name": "我", "kind": "human"}], "min": 2, "max": 8}
	f.on_me({"me": {"id": SELF}, "here": {"tables": [{"id": "arcade:table1", "near": true}], "activities": [act]}})
	await f.on_action("leave", "")
	check(f._left_acts.has("a1"), "离开之后记着")
	c.act_result = {"ok": true, "data": {"activity": act}}
	await f.on_action("join", "a1")
	check(not f._left_acts.has("a1"), "重新加入同一桌：不再记着我离开过")
	f.on_event({"type": "activity", "data": {"activity": {"id": "a1", "game": "number_bomb", "tableId": "arcade:table1", "status": "cancelled", "host": "r_other", "players": []}, "reason": "等了太久没凑齐人", "ended": true}})
	check(_has_toast(c, "这一桌散了：等了太久没凑齐人"), "重新加入之后被取消：要提示「这一桌散了」：%s" % str(c.toasts))


## 开局那一刻还在路上的旧 /me（没有 game）晚于 START_HOLD_S 才到：会推断出「结束了」，但这是错的。
## 下一份 /me 带着 game，必须把这一局接回来（面板回来、结果卡收起、输入重新封锁），不能因为「这一局登记过结束」而永远不认
func t_stale_me_at_start_heals() -> void:
	var s: Array = _make()
	var f = s[0]
	f.on_me(_me())
	f.on_event({"type": "game_started", "data": {"activityId": AID, "gameId": "g_" + AID, "name": "数字炸弹", "seat": 1}})
	check(f._in_game, "game_started 之后在局里")
	f.on_me(_me())  # 保护时间之内到的旧 /me：不清
	check(f._in_game and f._inferred_ends == 0, "START_HOLD_S 之内的旧 /me 不清掉对局")
	f.tick(Game.START_HOLD_S + 0.5, 0.0)
	f.on_me(_me())  # 慢网：旧 /me 过了保护时间才到 -> 推断成结束（错的）
	check(not f._in_game and f._inferred_ends == 1 and bool(f._result.get("inferred", false)), "过了保护时间的旧 /me：推断出一张结果卡：%s" % str(f._result))
	f.on_me(_me(_game_view()))  # 下一份 /me 带着 game：接回来
	check(f._in_game and f._act_id == AID, "下一份带着 game 的 /me 把这一局接回来")
	check(f._result.is_empty(), "接回来之后推断的结果卡收起：%s" % str(f._result))
	check(f.blocks_input() != "", "接回来之后输入重新封锁")
	check(f._state().get("mode") == "game", "推给网页的是对局面板：%s" % str(f._state().get("mode")))
	f.on_event(_ended())  # 之后真的结束：照常弹真实的结果卡
	check(not f._in_game and f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2, "之后真的结束：真实的结果卡：%s" % str(f._result))


## 推断出来的结果卡，被公开投影补全之后 kind 已经不是 unknown（这里补成了「输」）；真实的 game_ended（赢、奖励 2）到了仍然要覆盖它
func t_inferred_resolved_then_real() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	c.public_data = {"players": [{"seat": 1, "name": "甲"}, {"seat": 2, "name": "乙"}], "result": {"reason": "乙猜中了炸弹", "winnerSeats": [2], "reveal": []}}
	f.on_me(_me(_game_view()))
	f.on_me(_me())  # 断线期间错过 game_ended -> 推断，随即读公开投影
	check(bool(f._result.get("inferred", false)) and f._result.get("kind") == "lost" and int(f._result.get("reward", -1)) == 0, "推断卡被公开投影补全：kind 已不是 unknown、奖励仍是 0：%s" % str(f._result))
	f.on_event(_ended())
	check(f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2 and not bool(f._result.get("inferred", true)), "真实的 game_ended 仍要覆盖补全过的推断卡：%s" % str(f._result))
	f.on_event(_ended(AID, false, 0))  # 再来一份（重复的）：真实的卡不再被改
	check(f._result.get("kind") == "won" and int(f._result.get("reward", 0)) == 2, "真实的结果卡不被重复的 game_ended 改掉：%s" % str(f._result))


## 退出请求网络失败留下的请求号：同一局再点一次沿用（不会退两次）；换了一局必须换新的
## （上一次请求若其实到了服务端，沿用旧请求号只会拿回上一局的回执，这一局并没有退掉）
func t_quit_rid_per_game() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	f.on_me(_me(_game_view()))
	c.act_result = {"ok": false, "net_fail": true, "rid": "x"}
	await f.on_ui("leave", "")
	await f.on_ui("leave", "")
	check(c.act_opts.size() == 2 and str(c.act_opts[0].get("rid", "")) != "" and str(c.act_opts[0].get("rid", "")) == str(c.act_opts[1].get("rid", "")), "同一局再点一次：沿用同一个请求号：%s" % str(c.act_opts))
	f.on_event(_ended())  # 这一局自然结束（记号已撤，弹卡）
	check(not f._in_game and f._result.get("kind") == "won", "上一局结束：%s" % str(f._result))
	f.on_ui("dismiss", "")
	f.on_me(_me(_game_view("act_2")))  # 下一局
	check(f._in_game and f._act_id == "act_2", "进了下一局")
	c.act_result = {"ok": true, "data": {}}
	await f.on_ui("leave", "")
	check(c.act_opts.size() == 3 and str(c.act_opts[2].get("rid", "")) != str(c.act_opts[0].get("rid", "")), "下一局退出：换新的请求号：%s" % str(c.act_opts))
	check(not f._in_game and f._ignored.has("act_2"), "下一局退出成功")
	f.on_me(_me(_game_view("act_2")))  # 退出成功之后迟到的旧 /me：不接回来
	check(not f._in_game, "退出成功之后迟到的旧 /me 不把局接回来")


## 退出请求在路上时，一份（退出提交之后才发出的）没有 game 的 /me 抢在回执和 game_ended 前面到：它经 _game_vanished 把「我退出了」的记号用掉。
## 退出成功的回执到了要把记号补上，之后到的 game_ended 不能给主动退出的人弹结果卡
func t_quit_me_races_ahead() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	f.on_me(_me(_game_view()))
	c.hold_act = true
	f.on_ui("leave", "")  # 不 await：请求在路上
	check(f._quitting and f._ignored.has(AID), "退出请求在路上：记号已记")
	f.on_me(_me())  # 没有 game 的 /me 先到
	check(not f._in_game and f._result.is_empty(), "先到的 /me：出局、不弹卡：%s" % str(f._result))
	c.act_release.emit()
	await process_frame
	check(not f._quitting and f._ignored.has(AID), "退出成功的回执到了：记号补上")
	f.on_event(_ended())
	check(f._result.is_empty(), "之后到的 game_ended 不给主动退出的人弹结果卡：%s" % str(f._result))
	check(not f._ignored.has(AID), "记号用掉了，不残留")


## 上一局确实结束了、下一局已经开始，一份还带着上一局的旧 /me 晚到：不能把面板换回上一局（活动号不复用，结束过的不再认）
func t_ended_game_cannot_replace_next() -> void:
	var s: Array = _make()
	var f = s[0]
	f.on_me(_me(_game_view()))
	f.on_event(_ended())
	f.on_event({"type": "game_started", "data": {"activityId": "act_2", "gameId": "g_act_2", "name": "数字炸弹", "seat": 1}})
	check(f._in_game and f._act_id == "act_2", "下一局开始")
	f.on_me(_me(_game_view()))  # 还带着上一局（act_1）的旧 /me
	check(f._in_game and f._act_id == "act_2", "带着上一局的旧 /me 不能把面板换回去：%s" % f._act_id)
	f.on_me(_me(_game_view("act_2")))
	check(f._act_id == "act_2" and not f._view.is_empty(), "下一局自己的 /me 照常收下")
