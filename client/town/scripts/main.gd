extends Node3D
## 栖灯镇三维网页客户端的主控：启动流程、协议（HTTP + WebSocket）、场景同步、输入、续租、重连、界面桥。
## 约定：位置只按服务器给的折线 + 服务器时间现算，没有客户端预测；界面文字都在网页 DOM 里（web/hud.js）。

enum Phase { BOOT, READY, BUSY, LOGIN, ERROR, PLAYING }

const API := "/town/api"
## 点按判定的移动阈值，单位是 CSS 像素；实际比较时乘 devicePixelRatio 换成画布的物理像素
## （Godot 网页端的触摸/鼠标坐标是物理像素，高分屏手机上固定数值会把正常点按判成拖动）
const TAP_MAX_MOVE_CSS := 10.0
const TAP_MAX_MS := 700.0
const SELECT_NEAR := 15.0

var bridge := TBridge.new()
var clock := TClock.new()
var net := TNet.new()
var audio := TAudio.new()
var _frame_max_ms: float = 0.0
var _last_wall_us: int = 0
var _slow: Array = []
var world := TWorld.new()
var rig := TRig.new()
var actors_root := Node3D.new()
var actors: Dictionary = {}  # id -> TActor
var marker: MeshInstance3D
var marker_mat: StandardMaterial3D

var phase: int = Phase.BOOT
var phase_msg: String = ""
var phase_link: String = ""
var login_title: String = ""
var login_error: String = ""
var flow_running: bool = false
signal login_submitted(player_name: String)

# 身份与会话
var client_id: String = ""
var dev_login: bool = false
var user_name: String = ""
var self_id: String = ""
var heartbeat_ms: int = 20000
var presence_epoch: int = 0

# /me 的缓存
var action_window: String = ""
var ctx_version: int = 1
var ctx_activity = null
var control_epoch: int = 0
var control_mine: bool = true
var here: Dictionary = {}
var my_interaction = null
var my_exits: Array = []
var me_busy: bool = false
var me_again: bool = false

# 地图与场景
var manifest: Dictionary = {}
var map_loading: bool = false
var cur_scene: String = ""
var cur_space: String = ""
var cur_space_name: String = ""
var speed: float = 2.4

# 网络
var want_net: bool = false
var ticket_pending: bool = false
var ws_ticket: String = ""
var ws_ready: bool = false
var reconnect_at: float = 0.0
var backoff_ms: float = 1000.0
var ev_cursor: String = ""
var renew_every_ms: float = 3000.0
var next_renew: float = 0.0
var renew_id: String = ""
var renew_rev: int = 0
var next_ping: float = 0.0
var next_heartbeat: float = 0.0
var next_poll: float = 0.0
## 已应用的最新快照的服务器时间：晚到的旧快照（比如断线时轮询的回应）不能盖掉新的
var last_scene_time: float = -1.0
var last_pong_ms: float = 0.0
var ping_sent: Dictionary = {}
## 死连接检测：最近一次从 WebSocket 收到任何东西的时刻。半开连接（网络切换、NAT 超时）不会触发 close，只能靠静默时长判断
const WS_SILENT_MS := 12000.0
const WS_PROBE_MS := 3000.0
var last_rx_ms: float = 0.0
var probe_sent_ms: float = 0.0
var probe_until_ms: float = 0.0  # >0：回到前台后的探测期限，期限前没收到任何东西就按断线处理
const FRAME_GAP_MS := 3000.0  # 两帧之间隔了这么久，说明主循环停过
var last_frame_ms: float = 0.0

var claiming: bool = false  # 自己正在点「接管」：这期间的 control 事件是自己引起的
var poll_busy: bool = false
var map_retry_at: float = 0.0
var revoke_checking: bool = false

# 交互
var pending: int = 0
var selected_obj: String = ""
var near_valid: bool = false
var nav_generation: int = 0
var req_counter: int = 0
var _was_moving: bool = false
var step_timer: float = 0.0
var arrival_refresh_at: float = -1.0
var _taps: Dictionary = {}
var _tap_start: Dictionary = {}
var _pinch_prev: float = 0.0
var last_error: String = ""

# 键盘方向输入（WASD / 方向键）。键位由网页层 hud.js 盯着（输入框里、窗口失焦、切后台都由它处理），这里只收「现在按着哪几个」。
# 只发方向、序号、控制版本，不发坐标；服务器把它变成一段约 500 毫秒租约的短直线，所以按住时要定时重发，松手发零向量。
const DIR_RESEND_MS := 175.0  # 按住时重发的间隔
const DIR_MIN_GAP_MS := 100.0  # 方向变了也至少隔这么久才发（和服务器限频的稳态一致：每秒 10 条）
const INTERACT_RANGE := 8.0
var key_up: bool = false
var key_down: bool = false
var key_left: bool = false
var key_right: bool = false
var dir_seq: int = 0  # 只增不减，重连也不重置（服务器按连接序号区分新旧连接）
var dir_last: Vector2 = Vector2.ZERO
var dir_sent_ms: float = -1.0e9
var dir_active: bool = false  # 已经发过非零方向、还没发零
var dir_suppressed: bool = false  # 点了地面或物件、按了 Esc：不再发方向，直到出现新的按下沿（向量归零本身不解除）
var key_edge: int = 0  # hud.js 给的按下沿计数
var dir_conn: int = -1  # hello 里的连接序号，点地 / 停下时连同 dir_seq 一起作栅栏发给服务器
var dir_toast_ms: float = -1.0e9
var _dirty: bool = true
var _state_timer: float = 0.0
var _debug_timer: float = 0.0
var _last_tags: String = ""

# 面板功能（附近聊天等）：见 features/。main 只持有 hub，对它的调用都是一行转发。
var features := TFeatureHub.new()
var server_cfg: Dictionary = {}
var _had_hello: bool = false


func _ready() -> void:
	bridge.setup()
	add_child(world)
	add_child(rig)
	add_child(actors_root)
	audio.bridge = bridge
	audio.clock = clock
	add_child(audio)
	_build_environment()
	_build_marker()
	bridge.ui_event.connect(_on_ui)
	bridge.visibility_changed.connect(_on_visibility)
	net.opened.connect(_on_ws_open)
	net.message.connect(_on_ws_message)
	net.closed.connect(_on_ws_closed)
	client_id = bridge.client_id()
	if not bridge.web:
		print("[town] 不是网页环境：只做了加载检查。")
		return
	features.setup(self)
	if bridge.hud_protocol() != TBridge.HUD_PROTOCOL:
		_fail("页面文件和客户端版本不一致，请强制刷新（Ctrl+F5）")
		return
	phase = Phase.READY
	_dirty = true
	_push_state()
	print("[town] 客户端已就绪")


## 光照和昼夜在 daynight.gd（按服务器世界时间），画质档由界面按钮 / 默认值决定。
var _fps_avg: float = 60.0
var _drs: float = 1.0
var _drs_t: float = 0.0
var daynight: TDayNight = null
var quality_high: bool = true


func _build_environment() -> void:
	daynight = TDayNight.new()
	add_child(daynight)
	daynight.debug_hour = bridge.debug_hour
	daynight.bridge = bridge
	_set_quality(not DisplayServer.is_touchscreen_available())


func _set_quality(high: bool) -> void:
	quality_high = high
	if daynight != null:
		daynight.set_quality(high)
	world.set_quality(high)


func _build_marker() -> void:
	marker = MeshInstance3D.new()
	var cyl := CylinderMesh.new()
	cyl.top_radius = 0.4
	cyl.bottom_radius = 0.4
	cyl.height = 0.03
	cyl.radial_segments = 24
	marker.mesh = cyl
	marker_mat = StandardMaterial3D.new()
	marker_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	marker_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	marker.material_override = marker_mat
	marker.visible = false
	add_child(marker)


# ───────────────────────── 界面事件 ─────────────────────────


func _on_ui(ev: String, arg: String) -> void:
	match ev:
		"enter":
			audio.init_after_gesture()
			audio.confirm()
			if phase == Phase.READY or phase == Phase.ERROR:
				_run_flow()
		"retry":
			if phase == Phase.ERROR:
				_run_flow()
		"login":
			login_submitted.emit(arg)
		"quality":
			_set_quality(arg == "high")
		"sound":
			audio.set_enabled(arg == "1")
		"vol":
			audio.set_volume_text(arg)
		"bgmute":
			audio.set_bg_mute(arg == "1")
		"sfx":
			audio.ui_sfx(arg)
		"stop":
			_do_stop()
		"keys":
			_on_keys(arg)
		"interact":
			# arg 是来源：键盘 E 不带参数（"key"）；将来手机的「互动」按钮发 emit('interact', 'button')，走同一个入口
			_do_interact(arg if arg != "" else "key")
		"debug_pick_stub":
			if bridge.debug:
				features.set_pick_stub(arg)
		"esc":
			_do_esc()
		"claim":
			_do_claim()
		"home":
			_do_navigate({"to": "home"}, "")
		"leave_home":
			_do_navigate({"to": "residential"}, "")
		"dest":
			selected_obj = ""
			_do_navigate({"to": arg}, "")
		"act":
			_on_act_button(arg)
		"leave_activity":
			var r: Dictionary = await _act({"type": "leave_interaction"})
			if r["ok"]:
				_toast("已停下手上的事。", "ok")
				audio.confirm()
				await _refresh_me()
		"debug_act":
			if bridge.debug:
				var parsed = JSON.parse_string(arg)
				if parsed is Dictionary:
					var r2: Dictionary = await _act(parsed)
					_toast(str(r2.get("message", "ok")), "ok" if r2["ok"] else "err")
					await _refresh_me()
		_:
			features.on_ui(ev, arg)


func _on_visibility(vis: bool) -> void:
	audio.set_hidden(not vis)
	if not vis or phase != Phase.PLAYING:
		return
	# 回到前台：马上对时、续心跳、要一份快照
	next_heartbeat = 0.0
	# 休眠期间时钟样本全不可信：清掉，等快照粗对、ping 精对
	clock.reset()
	if ws_ready:
		# 立刻探测一次：3 秒内什么都没收到就是死连接（手机锁屏后常见）
		_start_probe(clock.ticks_ms())
	else:
		next_ping = 0.0
		reconnect_at = 0.0
	_poll_scene()


## 发一次 ping 并定下期限：期限前什么都没收到就按断线处理。
## 探测期间只看这个期限，不看「静默了多久」——页面在后台时主循环是停的，那段时间收不到东西不说明连接坏了。
func _start_probe(t: float) -> void:
	next_ping = t + 5000.0
	probe_sent_ms = t
	probe_until_ms = t + WS_PROBE_MS
	net.send({"t": "ping", "n": t})


func _set_phase(p: int, msg: String = "", link: String = "") -> void:
	phase = p
	if p == Phase.READY or p == Phase.LOGIN or p == Phase.ERROR:
		features.on_leave()
	if p != Phase.PLAYING:
		_dir_reset()
	phase_msg = msg
	phase_link = link
	_dirty = true
	_push_state()


func _toast(msg: String, kind: String = "info") -> void:
	bridge.hud_toast(msg, kind)
	if kind == "err":
		audio.fail()


# ───────────────────────── 启动流程 ─────────────────────────


func _fail(msg: String, link: String = "") -> void:
	last_error = msg
	_set_phase(Phase.ERROR, msg, link)


func _err_msg(res: Dictionary) -> String:
	var d = res.get("data")
	if d is Dictionary:
		var m: String = str(d.get("message", ""))
		if m != "":
			return m
		var reason: String = str(d.get("reason", d.get("error", "")))
		var table := {
			"unreachable": "那里走不到。",
			"no_route": "找不到过去的路。",
			"too_far": "离得太远了，先走到它旁边。",
			"control_lost": "这个页面现在没有控制权。",
			"rate_limited": "操作太频繁了，稍等一下。",
			"already_here": "你已经在这里了。",
			"no_access": "没有进去的权限。",
			"not_here": "那个地方不在这里。",
			"unauthenticated": "需要重新登录。",
			"recovering": "小镇正在恢复，请稍后再试。",
		}
		if table.has(reason):
			return table[reason]
	if int(res.get("status", 0)) == 0:
		return "网络不通，请稍后再试。"
	return "出错了（%d）。" % int(res.get("status", 0))


func _run_flow() -> void:
	if flow_running:
		return
	flow_running = true
	var ok: bool = await _flow_body()
	flow_running = false
	if ok:
		_after_ready()


func _flow_body() -> bool:
	_set_phase(Phase.BUSY, "正在确认登录状态…")
	var sess: Dictionary = await bridge.http("GET", API + "/session")
	if int(sess["status"]) != 200 or not (sess["data"] is Dictionary):
		_fail("连不上小镇服务。" + _err_msg(sess))
		return false
	var cfg: Dictionary = await bridge.http("GET", API + "/config")
	if int(cfg["status"]) == 200 and cfg["data"] is Dictionary:
		server_cfg = cfg["data"]
		dev_login = bool(cfg["data"].get("devLogin", false))
		heartbeat_ms = int(cfg["data"].get("heartbeatMs", 20000))
		var winfo = cfg["data"].get("world")
		if winfo is Dictionary and daynight != null:
			daynight.set_timezone(str(winfo.get("timezone", "")))
		var wcfg = cfg["data"].get("world")
		if wcfg is Dictionary and str(wcfg.get("timezone", "")) != "":
			audio.world_tz = str(wcfg["timezone"])
	var logged_in: bool = bool((sess["data"] as Dictionary).get("loggedIn", false))
	if logged_in:
		user_name = str((sess["data"] as Dictionary).get("name", ""))
	for attempt in range(4):
		if not logged_in:
			if not dev_login:
				_fail("请从登录链接进入小镇（登录票据在旧页面兑换），然后回到这里。", "/town/")
				return false
			login_title = "取一个名字，进入栖灯镇"
			login_error = ""
			while not logged_in:
				_set_phase(Phase.LOGIN)
				var nm: String = await login_submitted
				nm = nm.strip_edges()
				if nm == "":
					login_error = "名字不能为空。"
					continue
				_set_phase(Phase.BUSY, "正在登录…")
				var lr: Dictionary = await bridge.http("POST", API + "/auth/dev", {"name": nm})
				if int(lr["status"]) == 200 and lr["data"] is Dictionary and bool(lr["data"].get("ok", false)):
					logged_in = true
					user_name = nm
					login_error = ""
				else:
					login_error = _err_msg(lr)
		_set_phase(Phase.BUSY, "正在进入小镇…")
		var body := {"clientId": client_id}
		var er: Dictionary = await bridge.http("POST", API + "/enter", body)
		if int(er["status"]) == 200 and er["data"] is Dictionary and bool(er["data"].get("ok", false)):
			var d: Dictionary = er["data"]
			presence_epoch = int(d.get("presenceEpoch", 0))
			_apply_me(d.get("view", {}))
			var ctl: Dictionary = d.get("control", {})
			control_epoch = int(ctl.get("epoch", control_epoch))
			control_mine = bool(ctl.get("mine", true))
			break
		var edata = er["data"]
		var ecode: String = str(edata.get("error", "")) if edata is Dictionary else ""
		if int(er["status"]) == 401 or ecode == "unauthenticated":
			logged_in = false
			continue
		if ecode == "profile_required" or (edata is Dictionary and str(edata.get("reason", "")) == "profile_required"):
			login_title = "第一次来：给自己取个名字"
			login_error = ""
			var named: bool = false
			while not named:
				_set_phase(Phase.LOGIN)
				var nm2: String = (await login_submitted).strip_edges()
				if nm2 == "":
					login_error = "名字不能为空。"
					continue
				_set_phase(Phase.BUSY, "正在进入小镇…")
				var er2: Dictionary = await bridge.http("POST", API + "/enter", {"clientId": client_id, "profile": {"name": nm2}})
				if int(er2["status"]) == 200 and er2["data"] is Dictionary and bool(er2["data"].get("ok", false)):
					var d2: Dictionary = er2["data"]
					presence_epoch = int(d2.get("presenceEpoch", 0))
					_apply_me(d2.get("view", {}))
					var ctl2: Dictionary = d2.get("control", {})
					control_epoch = int(ctl2.get("epoch", control_epoch))
					control_mine = bool(ctl2.get("mine", true))
					named = true
				else:
					login_error = _err_msg(er2)
			break
		_fail(_err_msg(er))
		return false
	if self_id == "":
		_fail("进入小镇失败，请重试。")
		return false
	_set_phase(Phase.BUSY, "正在加载地图…")
	if not await _load_map():
		return false
	return true


func _after_ready() -> void:
	var loc: Dictionary = _me_loc
	cur_scene = str(loc.get("scene", "town"))
	world.show_scene(cur_scene)
	if loc.has("x"):
		rig.snap(Vector3(float(loc["x"]), 0.0, float(loc["z"])))
	_set_phase(Phase.PLAYING)
	_toast("欢迎来到栖灯镇。点地面走过去，点物件走近它。", "ok")
	want_net = true
	reconnect_at = 0.0
	backoff_ms = 1000.0
	next_heartbeat = clock.ticks_ms() + float(heartbeat_ms)
	_dirty = true
	features.on_enter()


var _me_loc: Dictionary = {}


func _apply_me(view: Dictionary) -> void:
	if view.is_empty():
		return
	action_window = str(view.get("actionWindow", action_window))
	var ctx: Dictionary = view.get("context", {})
	ctx_version = int(ctx.get("version", ctx_version))
	ctx_activity = ctx.get("activityId")
	var ctl: Dictionary = view.get("control", {})
	if not ctl.is_empty():
		control_epoch = int(ctl.get("epoch", control_epoch))
		control_mine = bool(ctl.get("mine", control_mine))
	var me: Dictionary = view.get("me", {})
	if me.has("id"):
		self_id = str(me["id"])
		user_name = str(me.get("name", user_name))
	var h = view.get("here")
	here = h if h is Dictionary else {}
	my_exits = here.get("exits", []) if here.has("exits") else []
	my_interaction = view.get("interaction")
	var loc = view.get("location")
	if loc is Dictionary:
		_me_loc = loc
		cur_space = str(loc.get("space", cur_space))
		cur_space_name = str(loc.get("name", cur_space_name))
	near_valid = true
	features.on_me(view)
	_dirty = true


func _refresh_me() -> bool:
	if me_busy:
		me_again = true  # 正在读的这一份可能已经旧了：读完再读一次
		return false
	me_busy = true
	me_again = false
	var r: Dictionary = await bridge.http("GET", API + "/me?clientId=" + client_id.uri_encode())
	me_busy = false
	if me_again:
		me_again = false
		arrival_refresh_at = clock.ticks_ms() + 30.0
	if int(r["status"]) == 200 and r["data"] is Dictionary:
		_apply_me(r["data"])
		return true
	if int(r["status"]) == 401:
		_relogin()
	return false


func _relogin() -> void:
	features.on_leave()  # 它不设 phase，随后 _flow_body 把 PLAYING 直接设成 BUSY：共用设备换人登录时不能留着上一个人听到的话
	want_net = false
	ws_ready = false
	net.close_now()
	_clear_actors()
	if not flow_running:
		_run_flow()


## fatal=false 用于游戏中途重载：失败只提示，不把正在玩的人踢到错误面板。
func _load_map(fatal: bool = true) -> bool:
	if map_loading:
		return false
	map_loading = true
	var r: Dictionary = await bridge.http("GET", API + "/map")
	map_loading = false
	if int(r["status"]) != 200 or not (r["data"] is Dictionary):
		if fatal:
			_fail("加载地图失败。" + _err_msg(r))
		return false
	manifest = r["data"]
	var src: Dictionary = manifest.get("source", {})
	speed = float(src.get("speed", 2.4))
	world.build(manifest)
	if cur_scene != "":
		world.show_scene(cur_scene)
	return true


## 地图校验值对不上：停掉新的空间动作，重新取地图、重建场景。
func _reload_map_after_mismatch() -> void:
	var now_t: float = clock.ticks_ms()
	# 失败后隔几秒才允许再试（下一份对不上的快照会再次触发），不会无限快速重试
	if map_loading or now_t < map_retry_at:
		return
	map_retry_at = now_t + 5000.0
	_toast("地图更新了，正在重新加载…", "warn")
	var ok: bool = await _load_map(false)
	if not ok:
		return
	_clear_actors()
	# 对不上的快照被丢掉了，新地图要一份新快照；时间门槛归零，免得被旧时间戳挡掉
	last_scene_time = 0.0
	if net.is_open():
		net.send({"t": "ping", "n": clock.ticks_ms()})
	_dirty = true
	await _poll_scene(true)


# ───────────────────────── 网络：WebSocket ─────────────────────────


func _start_ws_attempt() -> void:
	if ticket_pending or net.state != "idle":
		return
	ticket_pending = true
	var r: Dictionary = await bridge.http("POST", API + "/ws-ticket", {"clientId": client_id})
	ticket_pending = false
	if int(r["status"]) == 200 and r["data"] is Dictionary and bool(r["data"].get("ok", false)):
		ws_ticket = str(r["data"].get("ticket", ""))
		var err: int = net.connect_to(bridge.ws_origin() + "/town/ws")
		if err != OK:
			ws_ticket = ""
			_schedule_reconnect()
	elif int(r["status"]) == 401:
		_relogin()
	else:
		_schedule_reconnect()


func _schedule_reconnect() -> void:
	var jitter: float = randf() * 400.0
	reconnect_at = clock.ticks_ms() + backoff_ms + jitter
	backoff_ms = minf(backoff_ms * 2.0, 15000.0)
	_dirty = true


func _on_ws_open() -> void:
	last_rx_ms = clock.ticks_ms()
	probe_until_ms = 0.0
	net.send({"t": "hello", "v": 1, "ticket": ws_ticket} if ev_cursor == "" else {"t": "hello", "v": 1, "ticket": ws_ticket, "cursor": ev_cursor})
	ws_ticket = ""


func _on_ws_closed(code: int, _reason: String) -> void:
	features.on_ws_closed()
	ws_ready = false
	dir_active = false  # 发不出零向量了；服务器最迟 500 毫秒后自己停
	_dirty = true
	if not want_net:
		return
	if code == 4403:
		_on_revoked()
		return
	if revoke_checking:
		return
	_schedule_reconnect()


## 连接被判为死连接：关掉、立刻重连（断线期间续租退回 HTTP、离线轮询自动启动）。
func _drop_dead_ws() -> void:
	ws_ready = false
	probe_until_ms = 0.0
	net.close_now()
	reconnect_at = 0.0
	next_poll = 0.0
	_dirty = true


## 会话被撤销（4403 / revoked）：可能是登录失效，也可能是居民在别处主动离开了小镇。
## 先查清楚再决定，网络抖动查不出结果时按普通断线重连，不能误判成「离开」。
func _on_revoked() -> void:
	if revoke_checking or not want_net:
		return
	revoke_checking = true
	ws_ready = false
	net.close_now()
	_dirty = true
	var sess: Dictionary = await bridge.http("GET", API + "/session")
	revoke_checking = false
	if phase != Phase.PLAYING or not want_net:
		return
	var d = sess.get("data")
	if int(sess["status"]) == 200 and d is Dictionary:
		if not bool(d.get("loggedIn", false)):
			_relogin()
			return
		var res = d.get("resident")
		if res is Dictionary and not bool(res.get("present", true)):
			_enter_left_state()
			return
		_schedule_reconnect()  # 登录还在、人也还在：只是连接被换掉了
		return
	if int(sess["status"]) == 401:
		_relogin()
		return
	_schedule_reconnect()  # 查不到（网络问题）：当普通断线处理


## 居民已经不在场：停在面板上等用户点按钮，不自动重新进入。
func _enter_left_state() -> void:
	want_net = false
	ws_ready = false
	net.close_now()
	_clear_actors()
	_hide_marker()
	_set_phase(Phase.READY, "你已经离开了小镇。想回来的话，点下面的按钮重新进入。")


func _on_ws_message(msg: Dictionary) -> void:
	last_rx_ms = clock.ticks_ms()
	var t: String = str(msg.get("t", ""))
	match t:
		"hello":
			ws_ready = true
			backoff_ms = 1000.0
			# 新连接：旧样本全丢，先用 serverTime 粗对，再立刻 ping 精对
			clock.reset()
			clock.rough(float(msg.get("serverTime", 0.0)))
			renew_every_ms = maxf(1000.0, float(msg.get("renewEveryMs", 3000.0)))
			dir_conn = int(msg.get("dirConn", -1))
			# 服务器只在我们带的事件游标可用时回显它，否则回新水位并随后发 resync：相等即被接受（要在覆盖 ev_cursor 之前算）
			var resumed: bool = ev_cursor != "" and str(msg.get("cursor", "")) == ev_cursor
			ev_cursor = str(msg.get("cursor", ev_cursor))
			next_ping = 0.0
			var m = msg.get("map")
			if m is Dictionary and manifest.has("checksum") and str(m.get("checksum", "")) != str(manifest["checksum"]):
				_reload_map_after_mismatch()
			features.on_hello(msg, resumed, not _had_hello)
			_had_hello = true
			_dirty = true
		"scene":
			_on_scene(msg)
		"events":
			ev_cursor = str(msg.get("cursor", ev_cursor))
			for ev in msg.get("events", []):
				if ev is Dictionary:
					_on_event(ev)
		"resync":
			ev_cursor = str(msg.get("cursor", ev_cursor))
			features.on_resync()
			_refresh_me()
		"pong":
			var n = msg.get("n")
			var sent: float = float(n) if n != null else 0.0
			clock.sample(sent, clock.ticks_ms(), float(msg.get("serverTime", 0.0)))
			last_pong_ms = clock.ticks_ms()
		"renewed":
			_on_renewed(msg)
		"dir_dropped":
			dir_last = Vector2.ZERO  # 丢了就当没发过：下一帧立刻重发（旧序号的丢弃由栅栏保证是对的）
		"error":
			var code: String = str(msg.get("code", ""))
			if code == "revoked":
				_on_revoked()
			elif code == "control_lost":
				# 和 HTTP 续租路径一致：失去控制权，界面变只读，并读一次自己的状态
				control_mine = false
				_dirty = true
				_heartbeat()
				_refresh_me()
			elif code == "unauthenticated":
				_relogin()
			elif code == "precondition_failed" and str(msg.get("reason", "")) == "in_activity":
				_dir_hint(str(msg.get("message", "")))
			elif code != "rate_limited" and not (code == "precondition_failed" and str(msg.get("reason", "")) == "not_present"):
				last_error = code + ": " + str(msg.get("message", ""))
		_:
			features.on_frame(t, msg)


func _on_event(ev: Dictionary) -> void:
	var t: String = str(ev.get("type", ""))
	var data: Dictionary = ev.get("data", {}) if ev.get("data") is Dictionary else {}
	# 提示音：按事件编号去重，太旧的不补播。自己说的附近聊天回声不响（只在这里过滤，不动 audio.gd）
	var echo: bool = false
	if t == "chat":
		var frm = data.get("from")
		echo = frm is Dictionary and str(frm.get("id", "")) == self_id
	if not echo:
		audio.on_event(ev)
	features.on_event(ev)
	match t:
		"you_arrived":
			arrival_refresh_at = clock.ticks_ms() + 80.0
		"nav_stopped":
			var reason: String = str(data.get("reason", ""))
			var table := {"lease": "路上没有续上，停下了。", "control": "控制权换了人，停下了。", "blocked": "前面走不过去，停下了。", "activity": "进入了一局游戏，停下了。", "eject": "你被请出了门。"}
			# 自己点「接管」也会让原来的路线停下：这时不是别人接管，不报
			if reason != "control" or (not claiming and not control_mine):
				_toast(str(table.get(reason, "停下了。")), "warn")
			_hide_marker()
			arrival_refresh_at = clock.ticks_ms() + 80.0
		"control":
			# 自己接管期间，事件可能先于 HTTP 回应到达：忽略。平时只有 epoch 比已知的大才是被别处接管
			if not claiming and int(data.get("epoch", 0)) > control_epoch:
				control_mine = false
				control_epoch = int(data.get("epoch", control_epoch))
				_toast("另一处接管了你的居民，这里变成只读。", "warn")
				_dirty = true
		"notice":
			_toast(str(data.get("text", "")), "info")
		"interaction_done":
			_toast("%s：%s" % [str(data.get("name", "做完了")), str(data.get("text", ""))], "ok")
			arrival_refresh_at = clock.ticks_ms() + 50.0
		"interaction":
			arrival_refresh_at = clock.ticks_ms() + 50.0


func _on_renewed(msg: Dictionary) -> void:
	var sa: TActor = actors.get(self_id)
	if bool(msg.get("ok", false)):
		if sa != null and sa.has_nav and msg.get("leaseUntil") != null:
			sa.nav_until = maxf(sa.nav_until, float(msg["leaseUntil"]))
	else:
		var nav = msg.get("navigation")
		if nav is Dictionary:
			# 续的不是现在这一段：照新的接着续
			renew_id = str(nav.get("navigationId", ""))
			renew_rev = int(nav.get("revision", 0))
			next_renew = 0.0
	var sp: String = str(msg.get("space", cur_space))
	if sp != "" and sp != cur_space:
		cur_space = sp
		cur_space_name = world.space_name(cur_scene, sp)
		audio.set_place(manifest, cur_scene, cur_space)
		_dirty = true
		arrival_refresh_at = clock.ticks_ms() + 50.0


# ───────────────────────── 场景同步 ─────────────────────────


func _on_scene(msg: Dictionary) -> void:
	if phase != Phase.PLAYING and phase != Phase.BUSY:
		return
	var cs: String = str(msg.get("checksum", ""))
	if cs != "" and manifest.has("checksum") and cs != str(manifest["checksum"]):
		_reload_map_after_mismatch()
		return
	# 旧快照不能盖掉新的：WS 推送和 GET /scene 兜底在路上会交错，晚到的旧回应会把刚开始走的人「按回原地」
	if msg.has("serverTime"):
		var st: float = float(msg["serverTime"])
		if st < last_scene_time:
			return
		last_scene_time = st
	var sid: String = str(msg.get("scene", cur_scene))
	if msg.has("serverTime"):
		clock.rough(float(msg["serverTime"]))
	var switched: bool = sid != cur_scene
	if switched:
		cur_scene = sid
		world.show_scene(sid)
		_clear_actors()
		selected_obj = ""
		near_valid = false
		_hide_marker()
	var sp: String = str(msg.get("space", cur_space))
	if sp != cur_space or switched or not audio.place_known():
		cur_space = sp
		cur_space_name = world.space_name(sid, sp)
		audio.set_place(manifest, cur_scene, cur_space)
		arrival_refresh_at = clock.ticks_ms() + 50.0
	var now: float = clock.server_now()
	if msg.has("self"):
		self_id = str(msg["self"])
	var seen: Dictionary = {}
	for a in msg.get("actors", []):
		if not (a is Dictionary):
			continue
		var id: String = str(a.get("id", ""))
		if id == "":
			continue
		seen[id] = true
		var act: TActor = actors.get(id)
		if act == null:
			act = TActor.new()
			actors_root.add_child(act)
			act.setup(id, str(a.get("name", "")), str(a.get("kind", "")), id == self_id)
			actors[id] = act
		act.apply(a, now)
		if id == self_id:
			if act.has_nav and _dir_recent(clock.ticks_ms()):
				renew_id = ""  # 方向输入的短租约只由方向输入续，不走 10 秒的续租
			elif act.has_nav:
				if act.nav_id != renew_id or act.nav_rev != renew_rev:
					renew_id = act.nav_id
					renew_rev = act.nav_rev
					if next_renew <= 0.0 or switched:
						next_renew = clock.ticks_ms() + renew_every_ms
			if switched or not rig_ready:
				rig.snap(Vector3(act.disp.x, 0.0, act.disp.y))
				rig_ready = true
	for id in actors.keys():
		if not seen.has(id):
			(actors[id] as TActor).queue_free()
			actors.erase(id)
	features.on_scene(msg)
	_dirty = true


var rig_ready: bool = false


func _clear_actors() -> void:
	for id in actors.keys():
		(actors[id] as TActor).queue_free()
	actors.clear()
	rig_ready = false
	renew_id = ""


## 上一份还没回来就不再发新的（离线轮询每 1.5 秒一次，回前台时还会补一次，慢网络下会越叠越多）。
## force 只给地图重载用：它要的是重载之后的新快照，不能被重载前发出的那一份顶掉。
func _poll_scene(force: bool = false) -> void:
	if poll_busy and not force:
		return
	poll_busy = true
	var r: Dictionary = await bridge.http("GET", API + "/scene")
	poll_busy = false
	if int(r["status"]) == 200 and r["data"] is Dictionary:
		_on_scene(r["data"])
	elif int(r["status"]) == 401:
		_relogin()


# ───────────────────────── 动作 ─────────────────────────


func _new_req_id() -> String:
	req_counter += 1
	return "q-%s-%d-%d" % [client_id.substr(0, 12), int(Time.get_unix_time_from_system()) % 1000000, req_counter]


## 提交一个动作。返回 {ok, data, error, reason, message}。失败时已经按需要处理了控制权、过期等状态。
func _act(action: Dictionary) -> Dictionary:
	pending += 1
	_dirty = true
	var out: Dictionary = {"ok": false, "message": "没有完成。"}
	var rid: String = _new_req_id()
	for attempt in range(3):
		var body := {
			"clientId": client_id,
			"requestId": rid,
			"actionWindow": action_window,
			"expected": {"contextVersion": ctx_version, "controlEpoch": control_epoch, "activityId": ctx_activity},
			"action": action,
		}
		var res: Dictionary = await bridge.http("POST", API + "/actions", body)
		var d = res["data"]
		if int(res["status"]) == 200 and d is Dictionary and bool(d.get("ok", false)):
			ctx_version = int(d.get("contextVersion", ctx_version))
			out = {"ok": true, "data": d, "message": ""}
			break
		var code: String = str(d.get("error", "")) if d is Dictionary else ""
		var reason: String = str(d.get("reason", "")) if d is Dictionary else ""
		out = {"ok": false, "data": d, "error": code, "reason": reason, "message": _err_msg(res)}
		if code == "control_lost":
			control_mine = false
			_dirty = true
			break
		if code == "context_stale" or code == "request_expired":
			await _refresh_me()
			rid = _new_req_id()
			continue
		if code == "rate_limited" or code == "recovering":
			var wait_ms: float = 600.0
			if d is Dictionary and d.has("retryAfterMs"):
				wait_ms = clampf(float(d["retryAfterMs"]), 200.0, 3000.0)
			await get_tree().create_timer(wait_ms / 1000.0).timeout
			continue
		if code == "unauthenticated":
			_relogin()
		break
	pending -= 1
	_dirty = true
	return out


## 一次性提交一个动作（聊天用）：请求体与 _act 相同（放在这里避免复制漂移），但不动 pending、不置 _dirty
## （聊天不能让所有按钮变灰），不对 rate_limited / recovering 睡眠重试，直接返回给调用方。
## opts.rid：给了就复用（网络层失败后重发同一句话时带回，服务器按请求号回放回执，不会说两遍）；
## opts.retry_stale（默认 true）：context_stale / request_expired 时刷新 /me、换新请求号再发一次（被拒的请求没执行，重发安全）。
## 返回 {ok, data, error, reason, message, retry_after_ms, net_fail, rid}；data 保留整个响应。
func _act_once(action: Dictionary, opts: Dictionary = {}) -> Dictionary:
	var rid: String = str(opts.get("rid", ""))
	if rid == "":
		rid = _new_req_id()
	var may_retry: bool = bool(opts.get("retry_stale", true))
	var out: Dictionary = {}
	while true:
		var body := {
			"clientId": client_id,
			"requestId": rid,
			"actionWindow": action_window,
			"expected": {"contextVersion": ctx_version, "controlEpoch": control_epoch, "activityId": ctx_activity},
			"action": action,
		}
		var res: Dictionary = await bridge.http("POST", API + "/actions", body)
		var d = res["data"]
		if int(res["status"]) == 200 and d is Dictionary and bool(d.get("ok", false)):
			ctx_version = int(d.get("contextVersion", ctx_version))
			return {"ok": true, "data": d, "error": "", "reason": "", "message": "", "retry_after_ms": 0, "net_fail": false, "rid": rid}
		var code: String = str(d.get("error", "")) if d is Dictionary else ""
		var reason: String = str(d.get("reason", "")) if d is Dictionary else ""
		var retry_ms: int = int(d.get("retryAfterMs", 0)) if d is Dictionary else 0
		out = {"ok": false, "data": d, "error": code, "reason": reason, "message": _err_msg(res), "retry_after_ms": retry_ms, "net_fail": int(res["status"]) == 0, "rid": rid}
		if (code == "context_stale" or code == "request_expired") and may_retry:
			may_retry = false
			await _refresh_me()
			rid = _new_req_id()
			continue
		if code == "control_lost":
			control_mine = false
			_dirty = true
		elif code == "unauthenticated":
			_relogin()
		break
	return out


func _can_control() -> bool:
	if phase != Phase.PLAYING:
		return false
	var why: String = features.blocks_input()
	if why != "":
		_toast(why, "warn")
		return false
	if not control_mine:
		_toast("现在是只读：另一处握着控制权。点上方「接管」拿回来。", "warn")
		return false
	return true


func _show_marker(p: Vector3, confirmed: bool) -> void:
	marker.position = Vector3(p.x, 0.04, p.z)
	marker_mat.albedo_color = Color(1.0, 0.75, 0.15, 0.85) if confirmed else Color(0.8, 0.8, 0.8, 0.5)
	marker.visible = true


func _hide_marker() -> void:
	marker.visible = false


## 走过去。target_pos 是点击在地面上的位置（用来先画「等待确认」的标记）。
func _do_navigate(to: Dictionary, label: String, mark = null) -> void:
	if not _can_control():
		return
	_dir_cancel()
	nav_generation += 1
	var gen: int = nav_generation
	near_valid = false
	if mark is Vector3:
		_show_marker(mark, false)
	var r: Dictionary = await _act({"type": "navigate"}.merged(to).merged(_dir_fence()))
	if gen != nav_generation:
		# 之后又点了别处或又按了方向键，这个回答不再代表现状，不画标记；但服务器的现状照记：谁生效由服务器的序号栅栏决定
		if r["ok"] and r["data"] is Dictionary and r["data"].get("navigation") is Dictionary:
			var nv0: Dictionary = r["data"]["navigation"]
			renew_id = str(nv0.get("navigationId", ""))
			renew_rev = int(nv0.get("revision", 0))
			next_renew = clock.ticks_ms() + float(nv0.get("renewEveryMs", renew_every_ms))
		return
	if not r["ok"]:
		_hide_marker()
		_toast(str(r["message"]), "err")
		arrival_refresh_at = clock.ticks_ms() + 50.0
		return
	var d: Dictionary = r["data"]
	audio.tap()
	if str(d.get("status", "")) == "completed":
		_hide_marker()
		arrival_refresh_at = clock.ticks_ms() + 50.0
		return
	var nav = d.get("navigation")
	if nav is Dictionary:
		renew_id = str(nav.get("navigationId", ""))
		renew_rev = int(nav.get("revision", 0))
		next_renew = clock.ticks_ms() + float(nav.get("renewEveryMs", renew_every_ms))
		if mark is Vector3:
			_show_marker(mark, true)
		if not ws_ready:
			_poll_scene()


func _do_stop() -> void:
	if not _can_control():
		return
	_dir_cancel()
	nav_generation += 1
	var r: Dictionary = await _act({"type": "stop_navigation"}.merged(_dir_fence()))
	_hide_marker()
	if r["ok"]:
		audio.confirm()
		if not ws_ready:
			_poll_scene()
	else:
		_toast(str(r["message"]), "err")
	arrival_refresh_at = clock.ticks_ms() + 80.0


func _do_claim() -> void:
	if claiming:
		return
	claiming = true
	var r: Dictionary = await bridge.http("POST", API + "/claim", {"clientId": client_id})
	if int(r["status"]) == 200 and r["data"] is Dictionary and bool(r["data"].get("ok", true)):
		var ctl = r["data"].get("control")
		if ctl is Dictionary:
			control_epoch = int(ctl.get("epoch", control_epoch))
			control_mine = bool(ctl.get("mine", true))
		else:
			control_mine = true
		await _refresh_me()
		audio.confirm()
		_toast("已接管，可以操作了。", "ok")
	else:
		_toast(_err_msg(r), "err")
	claiming = false
	_dirty = true


func _on_act_button(arg: String) -> void:
	var parts: PackedStringArray = arg.split(":", true, 1)
	if parts.size() < 2:
		return
	if parts[0] == "f":
		features.on_action(parts[1])  # "f:<功能>:<动作>:<参数>"
		return
	var oid: String = parts[1]
	if parts[0] == "go":
		selected_obj = oid
		_do_navigate({"to": oid}, "")
		return
	if parts[0] == "do":
		if not _can_control():
			return
		var r: Dictionary = await _act({"type": "start_interaction", "objectId": oid})
		if r["ok"]:
			audio.start()
			var inter = r["data"].get("interaction")
			var nm: String = str(inter.get("name", "")) if inter is Dictionary else ""
			_toast("开始了：%s" % nm if nm != "" else "开始了。", "ok")
			await _refresh_me()
		else:
			_toast(str(r["message"]), "err")
			if str(r.get("reason", "")) == "too_far":
				near_valid = false
				_dirty = true


# ───────────────────────── 键盘 ─────────────────────────


## 网页层报来现在按着的方向键（"up,left" 这样的列表，空串 = 都松开）。
func _on_keys(arg: String) -> void:
	var halves: PackedStringArray = arg.split("|")
	var parts: PackedStringArray = halves[0].split(",", false)
	var edge: int = int(halves[1]) if halves.size() > 1 else key_edge
	var was_idle: bool = _key_vec() == Vector2.ZERO
	key_up = "up" in parts
	key_down = "down" in parts
	key_left = "left" in parts
	key_right = "right" in parts
	if edge != key_edge:
		key_edge = edge
		if _key_vec() != Vector2.ZERO:
			dir_suppressed = false  # 新按下了一个方向键：这才是新的一次起步
	if phase != Phase.PLAYING:
		return
	if was_idle and _key_vec() != Vector2.ZERO and not control_mine:
		_can_control()  # 只读：提示一次


## 屏幕方向 -> 世界方向。镜头固定朝北俯视（向上 = -z，向右 = +x），所以不用旋转；斜向归一化。
func _key_vec() -> Vector2:
	var v := Vector2(float(key_right) - float(key_left), float(key_down) - float(key_up))
	return v.normalized() if v != Vector2.ZERO else v


func _key_vec_text() -> String:
	var v: Vector2 = _key_vec()
	return "%.3f,%.3f" % [v.x, v.y]


func _send_dir(v: Vector2, now_t: float) -> void:
	dir_seq += 1
	dir_last = v
	dir_sent_ms = now_t
	net.send({"t": "dir", "seq": dir_seq, "epoch": control_epoch, "x": snappedf(v.x, 0.001), "z": snappedf(v.y, 0.001)})


## 每帧：按住就定时重发，方向变了马上发，松手发零向量。
func _tick_dir(now_t: float) -> void:
	var v: Vector2 = _key_vec()
	if v == Vector2.ZERO:
		if dir_active:
			dir_active = false
			if net.is_open() and ws_ready:
				_send_dir(Vector2.ZERO, now_t)
		return
	if dir_suppressed or not ws_ready or not net.is_open() or not control_mine or ctx_activity != null:
		return
	var why: String = features.blocks_input()
	if why != "":
		_dir_hint(why)  # 3 秒节流，不每帧提示
		return
	var gap: float = now_t - dir_sent_ms
	if (v != dir_last and gap >= DIR_MIN_GAP_MS) or gap >= DIR_RESEND_MS:
		if not dir_active:
			# 起步：之后点地确认的回答不再代表现状，也不再显示"正在走向某处"的标记
			nav_generation += 1
			near_valid = false
			_hide_marker()
			_dirty = true
		dir_active = true
		_send_dir(v, now_t)


## 点地、点物件、停下、Esc：方向输入让位。还按着键的话，这一次按住不再发方向（免得下一次重发把刚点的路线盖掉）。
func _dir_cancel() -> void:
	if dir_active and net.is_open() and ws_ready:
		_send_dir(Vector2.ZERO, clock.ticks_ms())
	dir_active = false
	dir_sent_ms = -1.0e9
	dir_suppressed = _key_vec() != Vector2.ZERO


## 点地 / 停下时带上的序号栅栏：这个页面在这条连接上已经发出的最大方向序号。发在它之前、迟到的方向帧会被服务器丢弃。
func _dir_fence() -> Dictionary:
	if dir_conn < 0 or dir_seq <= 0:
		return {}
	return {"dirFence": {"conn": dir_conn, "seq": dir_seq}}


## Esc（没有面板时）：只在确实在走的时候停下；只读页面、没在走都静默忽略。
func _do_esc() -> void:
	if phase != Phase.PLAYING or not control_mine:
		return
	var sa: TActor = actors.get(self_id)
	if dir_active or (sa != null and sa.has_nav):
		_do_stop()
	elif _key_vec() != Vector2.ZERO:
		dir_suppressed = true  # 没在走但键按着：Esc 也让这次按住作废


func _dir_reset() -> void:
	key_up = false
	key_down = false
	key_left = false
	key_right = false
	dir_active = false
	dir_suppressed = false
	dir_sent_ms = -1.0e9


## 刚发过方向输入（或还在按着）：这时自己的路线是方向输入的短租约，不能走 10 秒的续租。
func _dir_recent(now_t: float) -> bool:
	return dir_active or now_t - dir_sent_ms < 1200.0


func _dir_hint(msg: String) -> void:
	var t: float = clock.ticks_ms()
	if t - dir_toast_ms > 3000.0:
		dir_toast_ms = t
		_toast(msg, "warn")


## E：和最近的可互动物件或人互动。复用点击的入口：够得着的物件直接开始动作，远的先走过去，人就走到身边。
func _do_interact(src: String = "key") -> void:
	if phase != Phase.PLAYING or not _can_control():
		return
	var sa: TActor = actors.get(self_id)
	if sa == null:
		return
	var guard: int = 0
	while me_busy and guard < 150:
		await get_tree().process_frame  # 有一次读取在路上：等它读完，别拿旧的"够不够得着"去判断
		guard += 1
	if phase != Phase.PLAYING:
		return
	if not near_valid:
		await _refresh_me()  # 刚停下时"够不够得着"还是旧的：读一次再决定
		if phase != Phase.PLAYING:
			return
	var me := Vector2(sa.disp.x, sa.disp.y)
	var best_kind: String = ""
	var best_id: String = ""
	var best_d: float = INTERACT_RANGE
	for ob in world.scene_objects(cur_scene):
		var d: float = me.distance_to(Vector2((ob["pos"] as Vector3).x, (ob["pos"] as Vector3).z))
		if d < best_d:
			best_d = d
			best_kind = "obj"
			best_id = str(ob["id"])
	for id in actors:
		if id == self_id:
			continue
		var a: TActor = actors[id]
		var d2: float = me.distance_to(a.disp)
		if d2 < best_d:
			best_d = d2
			best_kind = "actor"
			best_id = id
	if best_kind == "":
		_toast("附近没有可以互动的东西。", "info")
		return
	# 先问功能模块：和点击一样，有功能接管就由它处理（居民卡、入座、一起喝茶），不再走下面的旧逻辑
	if features.on_pick(best_kind, best_id, src):
		return
	if best_kind == "actor":
		selected_obj = ""
		var a2: TActor = actors[best_id]
		_do_navigate({"approach": best_id}, a2.actor_name, Vector3(a2.disp.x, 0.0, a2.disp.y))
		return
	selected_obj = best_id
	_dirty = true
	if near_valid and _is_near(best_id):
		for o in here.get("objects", []):
			if str(o.get("id", "")) == best_id and o.get("action") is Dictionary and o.get("active") == null:
				_dir_cancel()
				_on_act_button("do:" + best_id)
				return
		_toast("现在没有可以做的事。", "info")
		return
	var ob2: Dictionary = world.find_object(cur_scene, best_id)
	_do_navigate({"to": best_id}, str(ob2.get("name", "")), Vector3(float(ob2["x"]), 0.0, float(ob2["z"])))


# ───────────────────────── 输入 ─────────────────────────


func _input(event: InputEvent) -> void:
	if phase != Phase.PLAYING:
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				_tap_begin(mb.position)
			else:
				_tap_finish(mb.position)
		elif mb.pressed and mb.button_index == MOUSE_BUTTON_WHEEL_UP:
			rig.zoom_mul(0.9)
		elif mb.pressed and mb.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			rig.zoom_mul(1.1)
	elif event is InputEventMouseMotion:
		_tap_move((event as InputEventMouseMotion).position)
	elif event is InputEventScreenTouch:
		var st := event as InputEventScreenTouch
		if st.pressed:
			_taps[st.index] = st.position
			if _taps.size() == 1:
				_tap_begin(st.position)
			else:
				_tap_start.clear()
				_pinch_prev = _pinch_dist()
		else:
			_taps.erase(st.index)
			if _taps.is_empty():
				_tap_finish(st.position)
				_pinch_prev = 0.0
			elif _taps.size() == 1:
				_pinch_prev = 0.0
	elif event is InputEventScreenDrag:
		var sd := event as InputEventScreenDrag
		_taps[sd.index] = sd.position
		if _taps.size() >= 2:
			var d: float = _pinch_dist()
			if _pinch_prev > 1.0 and d > 1.0:
				rig.zoom_mul(_pinch_prev / d)
			_pinch_prev = d
		else:
			_tap_move(sd.position)


func _pinch_dist() -> float:
	var ks: Array = _taps.keys()
	if ks.size() < 2:
		return 0.0
	return (_taps[ks[0]] as Vector2).distance_to(_taps[ks[1]] as Vector2)


func _tap_begin(p: Vector2) -> void:
	_tap_start = {"pos": p, "t": clock.ticks_ms()}


## 网页端 screen_get_scale() 返回 devicePixelRatio，输入坐标是物理像素：阈值按 CSS 像素换算
func _tap_limit() -> float:
	return TAP_MAX_MOVE_CSS * maxf(1.0, DisplayServer.screen_get_scale())


func _tap_move(p: Vector2) -> void:
	if _tap_start.is_empty():
		return
	if p.distance_to(_tap_start["pos"]) > _tap_limit():
		_tap_start.clear()


func _tap_finish(p: Vector2) -> void:
	if _tap_start.is_empty():
		return
	var ok: bool = p.distance_to(_tap_start["pos"]) <= _tap_limit() and clock.ticks_ms() - float(_tap_start["t"]) <= TAP_MAX_MS
	_tap_start.clear()
	if ok:
		_on_tap(p)


func _on_tap(p: Vector2) -> void:
	if not _can_control():
		return
	var o: Vector3 = rig.cam.project_ray_origin(p)
	var n: Vector3 = rig.cam.project_ray_normal(p)
	var best_t: float = INF
	var best_kind: String = ""
	var best_id: String = ""
	for id in actors:
		if id == self_id:
			continue
		var a: TActor = actors[id]
		var box := AABB(Vector3(a.disp.x - 0.5, 0.0, a.disp.y - 0.5), Vector3(1.0, 1.9, 1.0))
		var hit = box.intersects_ray(o, n)
		if hit is Vector3:
			var t: float = o.distance_to(hit)
			if t < best_t:
				best_t = t
				best_kind = "actor"
				best_id = id
	for ob in world.scene_objects(cur_scene):
		var hit2 = (ob["aabb"] as AABB).intersects_ray(o, n)
		if hit2 is Vector3:
			var t2: float = o.distance_to(hit2)
			if t2 < best_t:
				best_t = t2
				best_kind = "obj"
				best_id = str(ob["id"])
	if best_kind != "" and features.on_pick(best_kind, best_id, "tap"):
		return
	if best_kind == "actor":
		selected_obj = ""
		var a2: TActor = actors[best_id]
		_do_navigate({"approach": best_id}, a2.actor_name, Vector3(a2.disp.x, 0.0, a2.disp.y))
		return
	if best_kind == "obj":
		selected_obj = best_id
		_dirty = true
		var ob2: Dictionary = world.find_object(cur_scene, best_id)
		if near_valid and _is_near(best_id):
			return  # 已经够得着：直接给动作按钮
		_do_navigate({"to": best_id}, str(ob2.get("name", "")), Vector3(float(ob2["x"]), 0.0, float(ob2["z"])))
		return
	var g = rig.ground_hit(p)
	if g == null:
		return
	# 点到地图范围之外（竖屏时的天空、地图边缘外的远处）：射线会落在很远的地面上，不发导航
	var bnd = world.bounds.get(cur_scene)
	if bnd is Rect2 and not (bnd as Rect2).grow(1.0).has_point(Vector2(g.x, g.z)):
		return
	selected_obj = ""
	_do_navigate({"to": {"x": snappedf(g.x, 0.01), "z": snappedf(g.z, 0.01)}}, "", Vector3(g.x, 0.0, g.z))


func _is_near(oid: String) -> bool:
	for o in here.get("objects", []):
		if str(o.get("id", "")) == oid:
			return bool(o.get("near", false))
	# 游戏桌不在 here.objects 里（它没有单人动作），够不够得着在 here.tables 里
	for t in here.get("tables", []):
		if str(t.get("id", "")) == oid:
			return bool(t.get("near", false))
	return false


# ───────────────────────── 每帧 ─────────────────────────


func _process(dt: float) -> void:
	# 墙钟量帧间隔：引擎传进来的 dt 会被主循环截断（长卡顿只显示成约 150 毫秒），不能用来看卡顿
	var wall_us: int = Time.get_ticks_usec()
	if _last_wall_us > 0:
		var gap: float = float(wall_us - _last_wall_us) / 1000.0
		_frame_max_ms = maxf(_frame_max_ms, gap)
		if gap > 400.0:
			var pa: TActor = actors.get(self_id)
			_slow.append("%d gap %.0f drs %.2f pos %s mv %s" % [Time.get_ticks_msec(), gap, _drs, str(pa.disp.snapped(Vector2(0.1, 0.1))) if pa != null else "-", str(pa.moving) if pa != null else "-"])
			if _slow.size() > 12:
				_slow.pop_front()
	_last_wall_us = wall_us
	net.poll()
	if phase != Phase.PLAYING:
		if _dirty:
			_push_state()
		return
	var now_t: float = clock.ticks_ms()
	var now_s: float = clock.server_now()
	var vs: Vector2 = get_viewport().get_visible_rect().size
	if vs.y > 1.0:
		rig.set_aspect(vs.x / vs.y)
		_adapt_resolution(vs, dt)

	# 连接维护
	if want_net:
		if net.state == "idle" and not ticket_pending and now_t >= reconnect_at:
			_start_ws_attempt()
		if not ws_ready and now_t >= next_poll:
			next_poll = now_t + 1500.0
			if net.state != "open":
				_poll_scene()
		if ws_ready and now_t >= next_ping:
			next_ping = now_t + 5000.0
			net.send({"t": "ping", "n": now_t})
		# 死连接检测：ping 每 5 秒一次，服务器每次都会回，静默超过 12 秒就是半开连接
		if net.state == "open":
			# 主循环停过（后台标签页、锁屏）：停掉的时间不算静默，改成探测一次。
			# 回前台的通知先到时已经发过探测，这里从这一帧重新计：上面刚读出来的可能是停之前就缓冲着的消息，不能当成连接还活着的证据。
			if ws_ready and now_t - last_frame_ms > FRAME_GAP_MS and (probe_until_ms <= 0.0 or probe_sent_ms > last_frame_ms):
				_start_probe(now_t)
			var dead: bool = false
			if probe_until_ms > 0.0:
				if last_rx_ms > probe_sent_ms:
					probe_until_ms = 0.0
				elif now_t >= probe_until_ms:
					dead = true
			else:
				dead = now_t - last_rx_ms > WS_SILENT_MS
			if dead:
				_drop_dead_ws()
	last_frame_ms = now_t
	if now_t >= next_heartbeat and presence_epoch >= 0:
		next_heartbeat = now_t + float(heartbeat_ms)
		_heartbeat()

	_tick_dir(now_t)
	features.tick(dt, now_t)

	# 角色
	for id in actors:
		var ta: TActor = actors[id]
		ta.tick(dt, now_s)
		_update_sitting(ta)
		ta.set_shadow_visible(true)
	_update_scenery(dt, now_s)
	var sa: TActor = actors.get(self_id)
	if sa != null:
		rig.follow(Vector3(sa.disp.x, 0.0, sa.disp.y), dt)
		audio.set_listener(sa.disp)
		if sa.moving:
			step_timer -= dt
			if step_timer <= 0.0:
				audio.step()
				step_timer = 0.33 / clampf(sa.nav_speed / 2.0, 0.6, 1.8)
			_was_moving = true
			if control_mine and sa.has_nav and now_t >= next_renew and renew_id != "":
				next_renew = now_t + renew_every_ms
				_send_renew()
		else:
			step_timer = 0.05
			if _was_moving:
				_was_moving = false
				_hide_marker()
				arrival_refresh_at = now_t + 120.0
	if arrival_refresh_at > 0.0 and now_t >= arrival_refresh_at:
		arrival_refresh_at = -1.0
		_refresh_me()

	_update_tags()
	_state_timer += dt
	if _dirty or _state_timer >= 0.5:
		_state_timer = 0.0
		_push_state()
	if bridge.debug:
		_debug_timer += dt
		if _debug_timer >= 0.1:
			_debug_timer = 0.0
			_push_debug()


## 坐下：站在茶桌的座位锚点上、那张桌子正在被使用时坐着（自己的活动也算）。
func _update_sitting(a: TActor) -> void:
	if a.moving:
		return
	var spot: Dictionary = world.sit_spot(cur_scene, a.disp)
	if spot.is_empty():
		a.set_sitting(false)
		return
	var active: bool = false
	for o in here.get("objects", []):
		if str(o.get("id", "")) == str(spot["object"]) and o.get("active") != null:
			active = true
	if a.is_self and my_interaction is Dictionary and str(my_interaction.get("objectId", "")) == str(spot["object"]):
		active = true
	a.set_sitting(active, spot["center"])


## 昼夜（服务器世界时间）、遮挡淡出（屋顶、树）。
func _update_scenery(dt: float, now_s: float) -> void:
	if daynight != null:
		daynight.tick(now_s, clock.has_sync)
		world.set_night(daynight.night)
	var heads: Array = []
	for id in actors:
		var ha: TActor = actors[id]
		heads.append(Vector3(ha.disp.x, 1.6, ha.disp.y))
	world.update_view(rig.cam.global_position, heads, dt)


## 画面像素太多（高分屏手机）时降低 3D 渲染分辨率，保证帧率；界面是 DOM，不受影响。
func _adapt_resolution(vs: Vector2, dt: float = 0.0) -> void:
	var px: float = vs.x * vs.y
	var scale: float = 1.0 if px <= 2500000.0 else sqrt(2500000.0 / px)
	# 动态分辨率：帧率长期过低（软件渲染、老手机）就逐步降低 3D 渲染分辨率，恢复后慢慢升回去；界面是 DOM，文字不受影响
	if dt > 0.0:
		_fps_avg = lerpf(_fps_avg, 1.0 / maxf(dt, 0.0005), 1.0 - exp(-dt * 0.7))
		if dt > 0.35 and _drs > 0.3:
			_drs = maxf(0.3, _drs * 0.7)  # 一帧就超过 0.35 秒：马上降一档，不等平均值
		_drs_t += dt
		if _drs_t > 1.5:
			_drs_t = 0.0
			if _fps_avg < 24.0 and _drs > 0.3:
				_drs = maxf(0.3, _drs * 0.85)
			elif _fps_avg > 52.0 and _drs < 1.0:
				_drs = minf(1.0, _drs * 1.08)
	scale = minf(scale, _drs)
	if absf(get_viewport().scaling_3d_scale - scale) > 0.01:
		get_viewport().scaling_3d_scale = scale


func _heartbeat() -> void:
	var r: Dictionary = await bridge.http("POST", API + "/heartbeat", {"clientId": client_id, "presenceEpoch": presence_epoch})
	if int(r["status"]) == 200 and r["data"] is Dictionary:
		var d: Dictionary = r["data"]
		heartbeat_ms = int(d.get("nextHeartbeatMs", heartbeat_ms))
		var ctl = d.get("control")
		if ctl is Dictionary:
			var was_mine: bool = control_mine
			control_epoch = int(ctl.get("epoch", control_epoch))
			control_mine = bool(ctl.get("mine", control_mine))
			if control_mine != was_mine:
				_dirty = true
				_refresh_me()
		var cv: int = int(d.get("contextVersion", ctx_version))
		if cv != ctx_version:
			_refresh_me()
	elif int(r["status"]) == 401 or (r["data"] is Dictionary and str(r["data"].get("error", "")) == "unauthenticated"):
		_relogin()
	elif r["data"] is Dictionary and str(r["data"].get("reason", "")) == "presence_lost":
		# 在场租约丢了（比如睡了很久）：重新进入。别的失败（限流、恢复中）不动，下一次心跳再说。
		# 但主动离开小镇（在别处点了离开）时，心跳也会得到同样的 presence_lost，而「已被撤销」的通知经 WebSocket 稍后才到：
		# 抢在它前面重新进入就违背了「离开后不自动重进」。所以先等一会儿，期间收到撤销（revoke_checking / 离开状态）就放弃。
		await get_tree().create_timer(2.0).timeout
		if revoke_checking or not want_net or phase != Phase.PLAYING:
			return
		var er: Dictionary = await bridge.http("POST", API + "/enter", {"clientId": client_id})
		if int(er["status"]) == 200 and er["data"] is Dictionary:
			presence_epoch = int(er["data"].get("presenceEpoch", presence_epoch))
			_apply_me(er["data"].get("view", {}))


func _send_renew() -> void:
	if net.is_open() and ws_ready:
		net.send({"t": "renew", "navigationId": renew_id, "revision": renew_rev})
		return
	var r: Dictionary = await bridge.http("POST", API + "/nav/renew", {"clientId": client_id, "navigationId": renew_id, "revision": renew_rev})
	if int(r["status"]) == 200 and r["data"] is Dictionary:
		_on_renewed(r["data"])
	elif r["data"] is Dictionary and str(r["data"].get("error", "")) == "control_lost":
		control_mine = false
		_dirty = true


# ───────────────────────── 界面状态 ─────────────────────────


func _build_actions() -> Array:
	var out: Array = []
	var sa: TActor = actors.get(self_id)
	var walking: bool = sa != null and sa.moving
	var listed: Dictionary = {}
	for o in here.get("objects", []):
		var oid: String = str(o.get("id", ""))
		var act = o.get("action")
		var near: bool = bool(o.get("near", false)) and near_valid and not walking
		if near and act is Dictionary and int(act.get("min", 2)) <= 1:
			listed[oid] = true
			if o.get("active") != null:
				out.append({"id": "busy:" + oid, "label": "使用中", "sub": str(o.get("label", "")), "mode": "busy"})
			else:
				out.append({"id": "do:" + oid, "label": str(act.get("name", "做")), "sub": str(o.get("label", "")), "mode": "do"})
	if selected_obj != "" and not listed.has(selected_obj):
		var wo: Dictionary = world.find_object(cur_scene, selected_obj)
		if not wo.is_empty():
			out.append({"id": "go:" + selected_obj, "label": "走过去", "sub": str(wo.get("name", "")), "mode": "go"})
	features.actions(out)
	return out


func _conn_state() -> String:
	if ws_ready:
		return "ok"
	if want_net:
		return "reconnecting"
	return "offline"


func _push_state() -> void:
	_dirty = false
	var sa: TActor = actors.get(self_id)
	var d := {
		"phase": ["boot", "ready", "busy", "login", "error", "playing"][phase],
		"msg": phase_msg,
		"link": phase_link,
		"loginTitle": login_title,
		"loginError": login_error,
		"name": user_name,
		"space": cur_space_name,
		"scene": cur_scene,
		"sceneName": str(world.scene_names.get(cur_scene, "")),
		"conn": _conn_state(),
		"mine": control_mine,
		"pending": pending,
		"walking": sa != null and sa.moving,
		"actions": _build_actions() if phase == Phase.PLAYING else [],
		"dest": my_exits,
		"inHome": cur_scene == "home",
	}
	if my_interaction is Dictionary:
		var ends = my_interaction.get("endsAt")
		var rem: float = -1.0
		if ends != null:
			rem = maxf(0.0, float(ends) - clock.server_now())
		d["activity"] = {"name": str(my_interaction.get("name", "")), "status": str(my_interaction.get("status", "")), "remainMs": rem}
	bridge.hud_state(d)


func _update_tags() -> void:
	var size: Vector2 = get_viewport().get_visible_rect().size
	if size.x < 2.0 or size.y < 2.0:
		return
	var cam: Camera3D = rig.cam
	var tags: Array = []
	for id in actors:
		var a: TActor = actors[id]
		var wp := Vector3(a.disp.x, 2.05, a.disp.y)
		if cam.is_position_behind(wp):
			continue
		var sp: Vector2 = cam.unproject_position(wp)
		tags.append({"i": id, "n": a.actor_name, "x": snappedf(sp.x / size.x, 0.0005), "y": snappedf(sp.y / size.y, 0.0005), "k": "s" if id == self_id else "a", "m": a.moving})
	var sa: TActor = actors.get(self_id)
	for ob in world.scene_objects(cur_scene):
		var wp2: Vector3 = ob["pos"]
		var near_self: bool = sa != null and Vector2(sa.disp.x, sa.disp.y).distance_to(Vector2(wp2.x, wp2.z)) < SELECT_NEAR
		if not near_self and selected_obj != str(ob["id"]):
			continue
		if cam.is_position_behind(wp2):
			continue
		var sp2: Vector2 = cam.unproject_position(wp2)
		tags.append({"i": "o:" + str(ob["id"]), "n": str(ob["name"]), "x": snappedf(sp2.x / size.x, 0.0005), "y": snappedf(sp2.y / size.y, 0.0005), "k": "o", "sel": selected_obj == str(ob["id"])})
	for zl in world.zone_labels.get(cur_scene, []):
		var wp3: Vector3 = zl["pos"]
		if cam.is_position_behind(wp3):
			continue
		var sp3: Vector2 = cam.unproject_position(wp3)
		tags.append({"i": "z:" + str(zl["name"]), "n": str(zl["name"]), "x": snappedf(sp3.x / size.x, 0.0005), "y": snappedf(sp3.y / size.y, 0.0005), "k": "z"})
	for pl in world.portals.get(cur_scene, []):
		var wp4: Vector3 = pl["pos"]
		if cam.is_position_behind(wp4):
			continue
		var sp4: Vector2 = cam.unproject_position(wp4)
		tags.append({"i": "p:" + str(pl["id"]), "n": str(pl["name"]), "x": snappedf(sp4.x / size.x, 0.0005), "y": snappedf(sp4.y / size.y, 0.0005), "k": "p"})
	features.tags(cam, size, tags)
	var s: String = JSON.stringify(tags)
	if s != _last_tags:
		_last_tags = s
		bridge.hud_tags(s)


func _push_debug() -> void:
	var size: Vector2 = get_viewport().get_visible_rect().size
	var cam: Camera3D = rig.cam
	var al: Array = []
	for id in actors:
		var a: TActor = actors[id]
		var sp: Vector2 = cam.unproject_position(Vector3(a.disp.x, 1.0, a.disp.y))
		al.append({"id": id, "name": a.actor_name, "x": a.disp.x, "z": a.disp.y, "moving": a.moving, "nx": sp.x / size.x, "ny": sp.y / size.y})
	var ol: Array = []
	for ob in world.scene_objects(cur_scene):
		var wp: Vector3 = ob["pos"]
		var sp2: Vector2 = cam.unproject_position(Vector3(wp.x, 0.5, wp.z))
		ol.append({"id": ob["id"], "name": ob["name"], "x": ob["x"], "z": ob["z"], "nx": sp2.x / size.x, "ny": sp2.y / size.y, "near": _is_near(str(ob["id"])) and near_valid})
	var proj := Projection(cam.get_camera_projection())
	var view := Projection(cam.global_transform.affine_inverse())
	var vp: Projection = proj * view
	var m: Array = []
	for c in range(4):
		var col: Vector4 = vp[c]
		m.append_array([col.x, col.y, col.z, col.w])
	var d := {
		"self": self_id,
		"scene": cur_scene,
		"space": cur_space,
		"spaceName": cur_space_name,
		"serverTimeOffset": clock.offset_ms,
		"rttMs": clock.rtt_ms,
		"connection": _conn_state(),
		"phase": phase,
		"mine": control_mine,
		"pending": pending,
		"selected": selected_obj,
		"nearValid": near_valid,
		"actors": al,
		"objects": ol,
		"vp": m,
		"zoom": rig.dist,
		"drs": snappedf(_drs, 0.01),
		"quality": "high" if quality_high else "low",
		"hour": snappedf(daynight.hour, 0.01) if daynight != null else -1.0,
		"serverNow": clock.server_now(),
		"fps": Engine.get_frames_per_second(),
		"checksum": str(manifest.get("checksum", "")),
		"lastError": last_error,
		"markerVisible": marker.visible,
		"tapLimit": _tap_limit(),
		"dir": {"conn": dir_conn, "seq": dir_seq, "active": dir_active, "suppressed": dir_suppressed, "keys": _key_vec_text()},
		"screenScale": DisplayServer.screen_get_scale(),
		"snd": audio.debug_info(),
		# 自上次推送以来最长的一帧间隔（毫秒）。网页层累计，端到端每步结束时读，用来分清「机器忙」和「某处卡了主线程」
		"frameMaxMs": snappedf(_frame_max_ms, 0.1),
		"slow": _slow,
		"features": features.debug(),
	}
	_frame_max_ms = 0.0
	bridge.hud_debug(JSON.stringify(d))
