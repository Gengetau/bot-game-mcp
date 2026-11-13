class_name TAudio
extends Node
## 声音：两首循环音乐（按世界时间昼夜交叉淡入淡出）、环境声（白天/夜晚/室内/喷泉定点）、操作音效。
## - 浏览器要求用户手势之后才能出声：由「进入小镇」按钮触发 init_after_gesture()；被阻止时静音也能继续玩（不报错）。
## - 三条总线 Music / Ambience / SFX 各自有音量，Master 管总静音与「切后台静音」；音量变化一律经过平滑，不出现突响。
## - 音乐文件放在 pck 之外（client/town/stream/music/，导出时拷到 build/web/music/），进入小镇之后才用 HTTPRequest 取，
##   不占首屏；任何音频文件缺失或取不到都只是少一层声音，客户端照常运行。
## - 昼夜取自服务器世界时间（clock.server_now() 经 boot.js 的 worldHour 换成世界时区的钟点），和设备时区无关。
## - 音量/静音的偏好由网页层（hud.js，localStorage）保存，这里只接收 'vol' / 'sound' / 'bgmute' 事件。

const SFX_DIR := "res://assets/audio/sfx/"
const AMB_DIR := "res://assets/audio/ambience/"
const MUSIC_PATH := "/town/3d/music/"
## 取一首音乐的请求超时（秒）。
const FETCH_TIMEOUT_S := 30.0
const SFX_NAMES := ["confirm", "step", "tap", "fail", "start", "mail", "panel_open", "panel_close", "coin", "door"]
const AMB_NAMES := ["day", "night", "indoor", "fountain"]
const MUSIC_NAMES := ["day", "night"]

## 世界时间 18:00–06:00 放夜晚曲，其余放白天曲
const NIGHT_FROM := 18.0
const NIGHT_TO := 6.0
const MUSIC_FADE_S := 6.0
const AMB_FADE_S := 3.0
## 喷泉：离喷泉中心 NEAR 米以内满音量，FAR 米以外听不到，之间按平方衰减
const FOUNTAIN_NEAR := 4.0
const FOUNTAIN_FAR := 22.0
## 进室内后，室外环境声只留一点点（隔着墙）
const OUTDOOR_MUFFLED := 0.12
const EVENT_MAX_AGE_MS := 15000.0
const SEEN_MAX := 128

var enabled: bool = true  # 总静音的反面
var inited: bool = false
var bridge: TBridge
var clock: TClock
var world_tz: String = "Asia/Tokyo"

var vol := {"music": 0.6, "amb": 0.7, "sfx": 0.8}
var bg_mute: bool = true
var hidden: bool = false

var _rng := RandomNumberGenerator.new()
var _bus := {}  # 名字 -> 总线编号
var _cur := {"master": 1.0, "music": 0.6, "amb": 0.7, "sfx": 0.8}  # 平滑后的线性增益

var _sfx_streams := {}
var _sfx_players: Array = []
var _sfx_last := {}  # 名字 -> 上次播放的毫秒
var _first_play := {}  # 初始化后第一声音效播放时总线的分贝（调试用：验证已保存的静音在第一声前就生效）
var _plays := {}  # 名字 -> 实际播放过的次数（调试用）

var _amb_players := {}
var _amb_gain := {"day": 0.0, "night": 0.0, "indoor": 0.0, "fountain": 0.0}
var _music_players := {}
var _music_gain := {"day": 0.0, "night": 0.0}
var _music_loaded := {"day": false, "night": false}
var _music_tried := 0
var _music_fetch := {}  # 曲名 -> 取文件的状态（调试口只读：正在取、第几次、上次结果码、HTTP 码、字节数、已用毫秒、重试等待）

var _night: bool = false
var _hour: float = -1.0
var _phase_timer: float = 0.0

var _indoor: bool = false
var _scene: String = ""
var _place_known: bool = false
var _listener := Vector2(1.0e9, 1.0e9)
var _fountains := {}  # 场景 -> Vector2
var _fountain_checksum: String = ""

var _seen_events: Array = []


func _ready() -> void:
	_ensure_bus("Music")
	_ensure_bus("Ambience")
	_ensure_bus("SFX")
	_apply_buses(true)


func _ensure_bus(bus_name: String) -> void:
	var i: int = AudioServer.get_bus_index(bus_name)
	if i < 0:
		AudioServer.add_bus()
		i = AudioServer.bus_count - 1
		AudioServer.set_bus_name(i, bus_name)
		AudioServer.set_bus_send(i, "Master")
	_bus[bus_name] = i


func init_after_gesture() -> void:
	if inited:
		return
	inited = true
	_rng.randomize()
	for n in SFX_NAMES:
		var s = _load_res(SFX_DIR + n + ".ogg")
		if s != null:
			_sfx_streams[n] = s
	for i in range(6):
		var p := AudioStreamPlayer.new()
		p.bus = "SFX"
		add_child(p)
		_sfx_players.append(p)
	for n in AMB_NAMES:
		var s = _load_res(AMB_DIR + n + ".ogg")
		var p := AudioStreamPlayer.new()
		p.bus = "Ambience"
		if s != null:
			if s is AudioStreamOggVorbis:
				(s as AudioStreamOggVorbis).loop = true
			p.stream = s
		add_child(p)
		_amb_players[n] = p
	for n in MUSIC_NAMES:
		var p := AudioStreamPlayer.new()
		p.bus = "Music"
		add_child(p)
		_music_players[n] = p
	_update_phase()
	_apply_buses(true)  # 已保存的静音 / 音量在进入前就发来了，立刻生效，免得第一声确认音按默认增益漏出来
	_load_music()


func _load_res(path: String):
	if not ResourceLoader.exists(path):
		return null
	var s = load(path)
	return s if s is AudioStream else null


# ───────────────────────── 设置（来自网页层） ─────────────────────────


func set_enabled(on: bool) -> void:
	enabled = on


func set_volume(kind: String, v: float) -> void:
	if vol.has(kind):
		vol[kind] = clampf(v, 0.0, 1.0)


## 网页层发来的 "music:0.6"
func set_volume_text(arg: String) -> void:
	var parts: PackedStringArray = arg.split(":", true, 1)
	if parts.size() == 2 and parts[1].is_valid_float():
		set_volume(parts[0], float(parts[1]))


func set_bg_mute(on: bool) -> void:
	bg_mute = on


## 页面切到后台 / 回到前台。后台时是否静音由 bg_mute 决定；boot.js 另外会把 AudioContext 挂起。
func set_hidden(h: bool) -> void:
	hidden = h


# ───────────────────────── 每帧 ─────────────────────────


func _process(dt: float) -> void:
	_apply_buses(false, dt)
	if not inited:
		return
	_phase_timer -= dt
	if _phase_timer <= 0.0:
		_phase_timer = 2.0
		_update_phase()
	_update_music(dt)
	_update_ambience(dt)


func _apply_buses(immediate: bool, dt: float = 0.0) -> void:
	var master_t: float = 1.0 if enabled and not (hidden and bg_mute) else 0.0
	var tg := {"master": master_t, "music": float(vol["music"]), "amb": float(vol["amb"]), "sfx": float(vol["sfx"])}
	var k: float = 1.0 if immediate else 1.0 - exp(-dt / 0.12)
	for key in tg:
		_cur[key] = float(_cur[key]) + (float(tg[key]) - float(_cur[key])) * k
		if absf(float(_cur[key]) - float(tg[key])) < 0.0005:
			_cur[key] = tg[key]
	AudioServer.set_bus_volume_db(0, _db(float(_cur["master"])))
	if _bus.has("Music"):
		AudioServer.set_bus_volume_db(int(_bus["Music"]), _db(float(_cur["music"])))
		AudioServer.set_bus_volume_db(int(_bus["Ambience"]), _db(float(_cur["amb"])))
		AudioServer.set_bus_volume_db(int(_bus["SFX"]), _db(float(_cur["sfx"])))


static func _db(g: float) -> float:
	return -80.0 if g <= 0.0001 else linear_to_db(g)


func _update_phase() -> void:
	var ms: float
	if clock != null and clock.has_sync:
		ms = clock.server_now()
	else:
		ms = Time.get_unix_time_from_system() * 1000.0
	var h: float = -1.0
	if bridge != null and bridge.web:
		h = float(bridge.host.worldHour(world_tz, ms))
	if h < 0.0:
		var dt: Dictionary = Time.get_datetime_dict_from_unix_time(int(ms / 1000.0) + 9 * 3600)
		h = float(dt["hour"]) + float(dt["minute"]) / 60.0
	_hour = h
	_night = h >= NIGHT_FROM or h < NIGHT_TO


func _step_toward(cur: float, target: float, dt: float, fade_s: float) -> float:
	var step: float = dt / fade_s
	if cur < target:
		return minf(target, cur + step)
	return maxf(target, cur - step)


func _drive(p: AudioStreamPlayer, gain: float) -> void:
	if p == null or p.stream == null:
		return
	if gain < 0.002:
		if p.playing and not p.stream_paused:
			p.stream_paused = true
		return
	p.volume_db = _db(gain * gain)
	if not p.playing:
		p.play()
	elif p.stream_paused:
		p.stream_paused = false


func _update_music(dt: float) -> void:
	var want: String = "night" if _night else "day"
	var other: String = "day" if _night else "night"
	if not bool(_music_loaded[want]) and bool(_music_loaded[other]):
		want = other  # 这一首还没取到（或取不到）：先放另一首，总比没有好
	for n in MUSIC_NAMES:
		var t: float = 1.0 if n == want and bool(_music_loaded[n]) else 0.0
		_music_gain[n] = _step_toward(float(_music_gain[n]), t, dt, MUSIC_FADE_S)
		_drive(_music_players[n], float(_music_gain[n]))


func _update_ambience(dt: float) -> void:
	var outdoor: float = OUTDOOR_MUFFLED if _indoor else 1.0
	var tg := {
		"day": outdoor if not _night else 0.0,
		"night": outdoor if _night else 0.0,
		"indoor": 1.0 if _indoor else 0.0,
		"fountain": 0.0,
	}
	if not _indoor and _fountains.has(_scene):
		var d: float = _listener.distance_to(_fountains[_scene])
		var f: float = clampf(1.0 - (d - FOUNTAIN_NEAR) / (FOUNTAIN_FAR - FOUNTAIN_NEAR), 0.0, 1.0)
		tg["fountain"] = f * f
	for n in AMB_NAMES:
		var fade: float = AMB_FADE_S if n != "fountain" else 0.8
		_amb_gain[n] = _step_toward(float(_amb_gain[n]), float(tg[n]), dt, fade)
		_drive(_amb_players[n], float(_amb_gain[n]))


# ───────────────────────── 音乐：进游戏后再取 ─────────────────────────


func _load_music() -> void:
	if bridge == null or not bridge.web:
		return
	# 两首各自独立取、各自重试：一首卡住（半通的网络）不会拖住另一首
	var order: Array = ["night", "day"] if _night else ["day", "night"]
	for n in order:
		_load_track(n)


func _load_track(n: String) -> void:
	for attempt in range(3):
		if bool(_music_loaded[n]):
			return
		var data: PackedByteArray = await _fetch(bridge.origin + MUSIC_PATH + n + ".ogg", n, attempt + 1)
		_music_tried = maxi(_music_tried, attempt + 1)
		if data.size() >= 1000:
			var s := AudioStreamOggVorbis.load_from_buffer(data)
			if s != null:
				s.loop = true
				(_music_players[n] as AudioStreamPlayer).stream = s
				_music_loaded[n] = true
				(_music_fetch[n] as Dictionary)["decoded"] = true
				return
			(_music_fetch[n] as Dictionary)["decoded"] = false
		(_music_fetch[n] as Dictionary)["retryWait"] = true
		await get_tree().create_timer(20.0).timeout
		(_music_fetch[n] as Dictionary)["retryWait"] = false


func _fetch(url: String, track: String = "", attempt: int = 0) -> PackedByteArray:
	var info := {"fetching": true, "attempt": attempt, "startMs": Time.get_ticks_msec(), "result": -1, "http": -1, "bytes": -1, "elapsedMs": 0, "retryWait": false, "decoded": false, "reqErr": 0}
	if track != "":
		_music_fetch[track] = info
	var req := HTTPRequest.new()
	req.accept_gzip = false
	req.timeout = FETCH_TIMEOUT_S  # 连上了但不返回的请求不能一直拖住后面的曲子和重试
	add_child(req)
	var rerr: int = req.request(url)
	if rerr != OK:
		info["reqErr"] = rerr
		info["fetching"] = false
		req.queue_free()
		return PackedByteArray()
	var res: Array = await req.request_completed
	req.queue_free()
	info["fetching"] = false
	info["result"] = int(res[0])
	info["http"] = int(res[1])
	info["bytes"] = (res[3] as PackedByteArray).size()
	info["elapsedMs"] = Time.get_ticks_msec() - int(info["startMs"])
	if int(res[0]) != HTTPRequest.RESULT_SUCCESS or int(res[1]) != 200:
		return PackedByteArray()
	return res[3]


# ───────────────────────── 位置：室内外、喷泉 ─────────────────────────


## 记下所在场景和区域；室内外变了就切环境声，并响一声门。第一次（刚进来、刚重连）不响。
func set_place(manifest: Dictionary, sid: String, space: String) -> void:
	_index_fountains(manifest)
	var indoor: bool = false
	var g: Dictionary = (manifest.get("grids", {}) as Dictionary).get(sid, {})
	for z in g.get("zones", []):
		var zid: String = str(z.get("id", ""))
		# 私宅的区域编号是 home:<居民编号>，区域表里只有 home
		if zid == space or space.begins_with(zid + ":"):
			indoor = bool(z.get("indoor", false))
	if _place_known and indoor != _indoor:
		sfx("door")
	_indoor = indoor
	_scene = sid
	_place_known = true


func place_known() -> bool:
	return _place_known


func set_listener(p: Vector2) -> void:
	_listener = p


func _index_fountains(manifest: Dictionary) -> void:
	var cs: String = str(manifest.get("checksum", ""))
	if cs == _fountain_checksum and cs != "":
		return
	_fountain_checksum = cs
	_fountains.clear()
	var src: Dictionary = manifest.get("source", {})
	for sc in src.get("scenes", []):
		for ob in sc.get("obstacles", []):
			if str(ob.get("id", "")).ends_with("fountain"):
				_fountains[str(sc.get("id", ""))] = Vector2(float(ob["x"]) + float(ob.get("w", 1.0)) * 0.5, float(ob["z"]) + float(ob.get("d", 1.0)) * 0.5)
				break


# ───────────────────────── 音效 ─────────────────────────


func sfx(nm: String, pitch: float = 1.0, min_gap_ms: float = 60.0) -> void:
	if not inited or not _sfx_streams.has(nm):
		return
	var now: float = Time.get_ticks_msec()
	if now - float(_sfx_last.get(nm, -1.0e9)) < min_gap_ms:
		return
	_sfx_last[nm] = now
	if _first_play.is_empty():
		_first_play = {"name": nm, "masterDb": AudioServer.get_bus_volume_db(0), "sfxDb": AudioServer.get_bus_volume_db(int(_bus["SFX"])) if _bus.has("SFX") else 0.0}
	_plays[nm] = int(_plays.get(nm, 0)) + 1
	var pick: AudioStreamPlayer = null
	for p in _sfx_players:
		if not (p as AudioStreamPlayer).playing:
			pick = p
			break
	if pick == null:
		pick = _sfx_players[0]
	pick.stream = _sfx_streams[nm]
	pick.pitch_scale = pitch
	pick.play()


## 网页层的界面音（开关面板）：只认白名单
func ui_sfx(nm: String) -> void:
	if nm == "panel_open" or nm == "panel_close":
		sfx(nm)


func confirm() -> void:
	sfx("confirm")


func tap() -> void:
	sfx("tap", _rng.randf_range(0.97, 1.03))


func fail() -> void:
	sfx("fail", 1.0, 200.0)


func start() -> void:
	sfx("start")


func step() -> void:
	sfx("step", _rng.randf_range(0.92, 1.08), 0.0)


## 服务器事件对应的提示音。事件编号去重（重连补发、重复回执不重复响），太旧的不补播。
func on_event(ev: Dictionary) -> void:
	var id: String = str(ev.get("id", ""))
	if id != "":
		if _seen_events.has(id):
			return
		_seen_events.append(id)
		if _seen_events.size() > SEEN_MAX:
			_seen_events.pop_front()
	if clock != null and clock.has_sync and ev.get("at") != null:
		if clock.server_now() - float(ev["at"]) > EVENT_MAX_AGE_MS:
			return
	var t: String = str(ev.get("type", ""))
	var data: Dictionary = ev.get("data", {}) if ev.get("data") is Dictionary else {}
	match t:
		"mail", "chat", "invite", "offer", "asked_hobby":
			sfx("mail")
		"interaction_done":
			if str(data.get("text", "")).contains("硬币"):
				sfx("coin")
			else:
				sfx("confirm")
		"notice":
			if str(data.get("text", "")).contains("硬币"):
				sfx("coin")


# ───────────────────────── 调试 ─────────────────────────


func _music_fetch_debug() -> Dictionary:
	var out := {}
	for n in _music_fetch:
		var d: Dictionary = (_music_fetch[n] as Dictionary).duplicate()
		if bool(d["fetching"]):
			d["elapsedMs"] = Time.get_ticks_msec() - int(d["startMs"])
		out[n] = d
	return out


func debug_info() -> Dictionary:
	var pl := {}
	for n in MUSIC_NAMES:
		var p: AudioStreamPlayer = _music_players.get(n)
		pl["music_" + n] = {"loaded": bool(_music_loaded[n]), "gain": snappedf(float(_music_gain[n]), 0.001), "playing": p != null and p.playing and not p.stream_paused, "pos": snappedf(p.get_playback_position(), 0.01) if p != null and p.playing else 0.0}
	for n in AMB_NAMES:
		var p2: AudioStreamPlayer = _amb_players.get(n)
		pl["amb_" + n] = {"has": p2 != null and p2.stream != null, "gain": snappedf(float(_amb_gain[n]), 0.001), "playing": p2 != null and p2.playing and not p2.stream_paused}
	var bus_db := {}
	if inited:
		bus_db = {
			"master": AudioServer.get_bus_volume_db(0),
			"music": AudioServer.get_bus_volume_db(int(_bus["Music"])),
			"amb": AudioServer.get_bus_volume_db(int(_bus["Ambience"])),
			"sfx": AudioServer.get_bus_volume_db(int(_bus["SFX"])),
		}
	return {"inited": inited, "enabled": enabled, "hidden": hidden, "bgMute": bg_mute, "vol": vol, "night": _night, "hour": _hour, "indoor": _indoor, "scene": _scene, "busDb": bus_db, "layers": pl, "sfxLoaded": _sfx_streams.keys(), "plays": _plays, "firstPlay": _first_play, "musicTried": _music_tried, "musicFetch": _music_fetch_debug(), "ticksMs": Time.get_ticks_msec(), "fountains": _fountains.keys(), "fountainDist": snappedf(_listener.distance_to(_fountains[_scene]), 0.1) if _fountains.has(_scene) else -1.0}
