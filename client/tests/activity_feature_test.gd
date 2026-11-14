extends SceneTree
## activity.gd 的功能级单测：用假的 ctx（继承 TCtx、覆盖要用到的口子）直接喂 on_me / on_event / on_pick / actions，不起浏览器。
## 覆盖评审核实过的生命周期问题：自己造成的取消不再对自己提示、动作之后到 /me 回来之前按钮不重复出现、
## 改道之后再点同一张桌不被吞掉、点自己所在的桌不白白消耗走开放行、更旧的 /me 迟到不复活已结束的活动、换场景后旧桌牌不留。
## 用法：npm run client:unit（或 /opt/godot/godot --headless --path client/town --script ../tests/activity_feature_test.gd）

const Activity := preload("res://scripts/features/activity.gd")

const TEA := "tea_house:table1"
const SELF := "r_me"
const ANCHORS := [Vector2(7, 3.75), Vector2(7, 6.25), Vector2(8.25, 5), Vector2(5.75, 5)]

var _fails: int = 0
var _checks: int = 0


class FakeCtx:
	extends TCtx
	signal act_release
	var scene: String = "tea_house"
	var acts: Dictionary = {}
	var toasts: Array = []
	var walks: Array = []
	var gen: int = 0
	var near: bool = true
	var key_edge: int = -1  # 方向键按着时这一次按下的编号，-1 = 没按着
	var control: bool = true
	var tree: SceneTree
	var act_calls: Array = []
	var _br := TBridge.new()

	func bridge() -> TBridge:
		return _br

	func self_id() -> String:
		return SELF

	func actors() -> Dictionary:
		return acts

	func playing() -> bool:
		return true

	func in_game() -> bool:
		return false

	func control_mine() -> bool:
		return control

	func server_now() -> float:
		return 1000000.0

	func cur_scene() -> String:
		return scene

	func near_ok(_oid: String) -> bool:
		return near

	func toast(text: String, kind: String = "info") -> void:
		toasts.append({"text": text, "kind": kind})

	func refresh_me() -> void:
		pass

	func mark_dirty() -> void:
		pass

	func refresh_me_wait() -> bool:
		return false  # 正有一次在读：返回 false，on_me 之后才到

	func invalidate_near() -> void:
		pass

	func object_info(oid: String) -> Dictionary:
		if oid != TEA:
			return {}
		return {"id": TEA, "name": "靠窗的茶桌", "kind": "tea_table", "anchors": ANCHORS, "pos": Vector3(7, 0, 5)}

	func act(action: Dictionary) -> Dictionary:
		act_calls.append(action)
		await act_release
		return {"ok": true, "data": {"interaction": {"name": "一起喝茶"}}}

	func walk_to(to: Dictionary, _label: String, _mark = null) -> void:
		gen += 1  # main._do_navigate 一开始就同步加一
		walks.append(to)

	func key_press_edge() -> int:
		return key_edge

	func nav_gen() -> int:
		return gen

	func next_frame() -> void:
		await tree.process_frame


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	_run()


func _view(interaction, active = null, near: bool = true) -> Dictionary:
	return {
		"me": {"id": SELF},
		"interaction": interaction,
		"here": {"objects": [{"id": TEA, "type": "tea_table", "label": "靠窗的茶桌", "near": near, "action": {"def": "tea", "name": "一起喝茶", "cost": "茶叶 1", "min": 2, "max": 4}, "active": active}]},
	}


func _it(id: String, status: String, ini_id: String, parts: Array) -> Dictionary:
	var ps: Array = []
	for pid in parts:
		ps.append({"id": pid, "name": "名" + str(pid), "kind": "human"})
	return {"id": id, "status": status, "name": "一起喝茶", "objectId": TEA, "initiator": {"id": ini_id, "name": "名" + ini_id, "kind": "human"}, "participants": ps, "min": 2, "max": 4, "endsAt": 1600000.0 if status == "running" else null, "lobbyExpiresAt": 1010000.0, "startedAt": 1000000.0 if status == "running" else null, "cost": "茶叶 1"}


func _make() -> Array:
	var c := FakeCtx.new()
	c.tree = self
	var me := TActor.new()
	me.disp = Vector2(10, 10)
	c.acts = {SELF: me}
	var f = Activity.new()
	f.ctx = c
	return [f, c, me]


func _has_toast(c: FakeCtx, frag: String) -> bool:
	for t in c.toasts:
		if str(t["text"]).find(frag) >= 0:
			return true
	return false


func _ids(out: Array) -> Array:
	var r: Array = []
	for e in out:
		r.append(str(e.get("id", "")))
	return r


func _has_prefix(out: Array, prefix: String) -> bool:
	for i in _ids(out):
		if str(i).begins_with(prefix):
			return true
	return false


func _run() -> void:
	t_cancel_by_own_leave()
	await t_button_gap()
	t_repick_after_redirect()
	await t_pick_own_table()
	t_late_me()
	t_scene_switch()
	await t_hold_key_stall()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


## 评审 lifecycle#0：自己是最后一个走开的非发起人，服务器以「大家都离开了」取消；这是自己造成的，不再对自己弹「这一桌散了」
func t_cancel_by_own_leave() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	f.on_me(_view(_it("i1", "running", "r_ini", [SELF]), _it("i1", "running", "r_ini", [SELF])))
	f.on_event({"type": "interaction", "data": {"interaction": _it("i1", "cancelled", "r_ini", []), "reason": "大家都离开了"}})
	check(not _has_toast(c, "这一桌散了"), "取消: 我是最后走开的非发起人，不应对自己弹「这一桌散了」：%s" % str(c.toasts))
	check(f._mine.is_empty(), "取消: 状态已清")
	# 别人造成的取消仍要说（发起人在等人阶段走开）
	var s2: Array = _make()
	var f2 = s2[0]
	var c2: FakeCtx = s2[1]
	f2.on_me(_view(_it("i2", "open", "r_ini", ["r_ini", SELF]), _it("i2", "open", "r_ini", ["r_ini", SELF])))
	f2.on_event({"type": "interaction", "data": {"interaction": _it("i2", "cancelled", "r_ini", []), "reason": "发起人走开了"}})
	check(_has_toast(c2, "这一桌散了：发起人走开了"), "取消: 别人造成的取消照常提示：%s" % str(c2.toasts))
	# 等太久散场对发起人自己也要说
	var s3: Array = _make()
	var f3 = s3[0]
	var c3: FakeCtx = s3[1]
	f3.on_me(_view(_it("i3", "open", SELF, [SELF]), _it("i3", "open", SELF, [SELF])))
	f3.on_event({"type": "interaction", "data": {"interaction": _it("i3", "cancelled", SELF, []), "reason": "等了太久没凑齐人"}})
	check(_has_toast(c3, "等了太久"), "取消: 等太久散场要对发起人说：%s" % str(c3.toasts))
	# 发起人自己走开引起的取消不说
	var s4: Array = _make()
	var f4 = s4[0]
	var c4: FakeCtx = s4[1]
	f4.on_me(_view(_it("i4", "open", SELF, [SELF]), _it("i4", "open", SELF, [SELF])))
	f4.on_event({"type": "interaction", "data": {"interaction": _it("i4", "cancelled", SELF, []), "reason": "发起人走开了"}})
	check(not _has_toast(c4, "这一桌散了"), "取消: 发起人自己走开引起的取消不说：%s" % str(c4.toasts))


## 评审 lifecycle#1：约人 / 加入成功后、/me 回来之前，按钮不能重新出现
func t_button_gap() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	f.on_me(_view(null, null))
	var out: Array = []
	f.actions(out)
	check(_ids(out).has("f:activity:invite:" + TEA), "按钮: 空着的桌有「约人」")
	f.on_action("invite", TEA)  # 不 await：act 停在 act_release 上
	check(c.act_calls.size() == 1, "按钮: 发出了一次 start_interaction")
	out = []
	f.actions(out)
	check(not _has_prefix(out, "f:activity:invite"), "按钮: 请求在路上时不再列出「约人」：%s" % str(_ids(out)))
	c.act_release.emit()  # 回应到了，但 /me 还没回来
	out = []
	f.actions(out)
	check(not _has_prefix(out, "f:activity:invite"), "按钮: 回应到了、/me 还没回来的空窗里不应重新出现「约人」：%s" % str(_ids(out)))
	f.on_action("invite", TEA)  # 空窗里再点（按钮若还在）也不能发第二次
	check(c.act_calls.size() == 1, "按钮: 空窗里不应再发一次请求：%d" % c.act_calls.size())
	# /me 回来：状态已是 open，按钮变成「等人中」，约人不再出现
	f.on_me(_view(_it("i1", "open", SELF, [SELF]), _it("i1", "open", SELF, [SELF])))
	for i in range(3):
		await process_frame
	out = []
	f.actions(out)
	check(_ids(out).has("f:activity:wait:" + TEA) and not _has_prefix(out, "f:activity:invite"), "按钮: /me 回来后是「等人中」：%s" % str(_ids(out)))
	check(not f._busy, "按钮: /me 回来后 _busy 放开")
	# 加入同理
	var s2: Array = _make()
	var f2 = s2[0]
	var c2: FakeCtx = s2[1]
	var act_open: Dictionary = _it("i9", "open", "r_ini", ["r_ini"])
	f2.on_me(_view(null, act_open))
	var out2: Array = []
	f2.actions(out2)
	check(_ids(out2).has("f:activity:join:i9"), "按钮: 别人开着的桌有「加入」")
	f2.on_action("join", "i9")
	c2.act_release.emit()
	out2 = []
	f2.actions(out2)
	check(not _has_prefix(out2, "f:activity:join"), "按钮: 加入之后 /me 回来之前不应重新出现「加入」：%s" % str(_ids(out2)))
	f2.on_me(_view(_it("i9", "open", "r_ini", ["r_ini", SELF]), _it("i9", "open", "r_ini", ["r_ini", SELF])))
	for i in range(3):
		await process_frame
	check(not f2._busy, "按钮: 加入后 /me 回来 _busy 放开")


## 评审 lifecycle#2：点桌子走过去，中途点地改道，再点同一张桌：这一下不能被吞掉
func t_repick_after_redirect() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	var me: TActor = s[2]
	f.on_me(_view(null, null, false))
	check(f.on_pick("obj", TEA), "改道: 第一次点桌被接管")
	check(c.walks.size() == 1, "改道: 发出一条走路：%d" % c.walks.size())
	me.moving = true
	check(f.on_pick("obj", TEA), "改道: 连点同一张桌仍被接管")
	check(c.walks.size() == 1, "改道: 没有改道时连点不重复发（防重入保留）：%d" % c.walks.size())
	c.gen += 1  # 点了地面，导航代号变了
	check(f.on_pick("obj", TEA), "改道: 改道之后再点同一张桌被接管")
	check(c.walks.size() == 2, "改道: 改道之后再点同一张桌要重新走过去：%d" % c.walks.size())


## 评审 lifecycle#3：点自己所在的桌子，走开拦截的放行窗口不能白白消耗，还要给一句话
func t_pick_own_table() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	var me: TActor = s[2]
	me.disp = ANCHORS[1]  # 站在座位上
	f.on_me(_view(_it("i1", "open", SELF, [SELF]), _it("i1", "open", SELF, [SELF])))
	var first: String = f.blocks_input()
	check(first != "", "点自己的桌: 第一次问被拦")
	await create_timer(0.45).timeout
	check(f.blocks_input() == "", "点自己的桌: 隔开一个操作的第二次放行（main 先问了 blocks_input 才调 on_pick）")
	var taken: bool = f.on_pick("obj", TEA)
	check(taken, "点自己的桌: 被吞掉（已坐在这张桌）")
	check(_has_toast(c, "按钮"), "点自己的桌: 要说一句约人、加入、开始请点按钮：%s" % str(c.toasts))
	check(int(f._gate["confirmed_until"]) == 0, "点自己的桌: 放行窗口应撤销，否则随后手滑点一下地面会无提示地走开并取消整桌")
	check(int(f._gate["passed"]) == 0, "点自己的桌: 没有真的走开，放行次数应退回")
	check(f.blocks_input() != "", "点自己的桌: 之后点地仍要先被拦一次")


## 评审 lifecycle#4：interaction_done / 取消之后，更旧的 /me 迟到，不能复活 _mine、不能擦掉「刚才」小卡
func t_late_me() -> void:
	var s: Array = _make()
	var f = s[0]
	var run: Dictionary = _it("i1", "running", SELF, [SELF, "r_b"])
	f.on_me(_view(run, run))
	f.on_event({"type": "interaction_done", "data": {"interactionId": "i1", "name": "一起喝茶", "text": "一起喝茶完成了：社交 +10"}})
	check(f._mine.is_empty() and not f._last.is_empty(), "迟到: 结算后 _mine 清空、「刚才」小卡在")
	f.on_me(_view(run, run))  # 结算之前读到的更旧的一份
	check(f._mine.is_empty(), "迟到: 更旧的 /me 不应让已结算的活动复活：%s" % str(f._mine.get("id", "")))
	check(not f._last.is_empty() and str(f._last.get("text", "")).find("社交") >= 0, "迟到: 「刚才」小卡不应被擦掉")
	check(f.blocks_input() == "", "迟到: 走开拦截保持空串")
	# 真正的新活动照常进来
	var run2: Dictionary = _it("i2", "open", SELF, [SELF])
	f.on_me(_view(run2, run2))
	check(str(f._mine.get("id", "")) == "i2", "迟到: 新的活动照常接收")
	check(f._last.is_empty(), "迟到: 新活动开始后小卡让位")
	# 取消同理
	var s2: Array = _make()
	var f2 = s2[0]
	var op: Dictionary = _it("i3", "open", "r_ini", ["r_ini", SELF])
	f2.on_me(_view(op, op))
	f2.on_event({"type": "interaction", "data": {"interaction": _it("i3", "cancelled", "r_ini", []), "reason": "发起人走开了"}})
	f2.on_me(_view(op, op))
	check(f2._mine.is_empty(), "迟到: 取消之后更旧的 /me 也不复活")


## 评审 lifecycle#5：换场景之后旧场景的桌牌与物件不能留着
func t_scene_switch() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	var act_open: Dictionary = _it("i1", "open", "r_ini", ["r_ini"])
	f.on_me(_view(null, act_open))
	check(f.debug()["tags"].size() == 1, "换场景: 茶馆里有一块桌牌")
	c.scene = "street"
	f.on_scene({"scene": "street", "actors": []})
	check(f.debug()["tags"].size() == 0, "换场景: 新场景的快照来了之后旧桌牌清掉")
	check(f.debug()["tables"].size() == 0, "换场景: 旧物件清掉")
	var out: Array = []
	f.actions(out)
	check(out.is_empty(), "换场景: 旧物件不再出按钮")
	# 同一场景的快照不清
	var s2: Array = _make()
	var f2 = s2[0]
	f2.on_me(_view(null, act_open))
	f2.on_scene({"scene": "tea_house", "actors": []})
	check(f2.debug()["tags"].size() == 1, "换场景: 同一场景的快照不清桌牌")


## 走开拦截（统筹发现的 40.7）：按住方向键、中间卡了一帧（超过 300 毫秒）不能被当成第二次尝试放行；松开再按（新的按下编号）才放行
func t_hold_key_stall() -> void:
	var s: Array = _make()
	var f = s[0]
	var c: FakeCtx = s[1]
	var op: Dictionary = _it("i1", "running", "r_ini", ["r_ini", SELF])
	f.on_me(_view(op, op))
	c.key_edge = 7
	check(f.blocks_input() != "", "按住卡顿: 第一帧被拦")
	await create_timer(0.45).timeout  # 一帧卡了 450 毫秒
	check(f.blocks_input() != "", "按住卡顿: 卡顿之后同一次按下仍被拦，不能放行")
	check(int(f.debug()["passed"]) == 0, "按住卡顿: 一次都没放行")
	await create_timer(0.45).timeout
	c.key_edge = 8  # 松开再按
	check(f.blocks_input() == "", "按住卡顿: 松开再按放行")
	check(int(f.debug()["passed"]) == 1, "按住卡顿: 放行计一次")
