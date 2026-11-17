class_name TDayNight
extends Node3D
## 昼夜：按服务器的世界时间（clock.gd 的 server_now + /config 的时区）平滑地走过 清晨 - 白天 - 黄昏 - 夜晚。
## 控制一盏平行光（颜色、强度、角度、阴影）、环境光、背景色，和着色器全局量 town_night（路灯、窗、地面光池的亮度）。
## 没有高光，没有后处理。debug_hour >= 0 时固定在那个钟点（截图、端到端用）。

# 关键帧：[钟点, night, 光色, 光强, 光的俯角, 光的方位, 环境色, 环境强度, 背景色]
const KEYS := [
	[0.0, 1.0, Color(0.55, 0.62, 0.95), 0.30, 48.0, -40.0, Color(0.30, 0.36, 0.58), 0.95, Color(0.07, 0.09, 0.17)],
	[5.0, 0.95, Color(0.55, 0.62, 0.95), 0.30, 48.0, -40.0, Color(0.30, 0.36, 0.58), 0.95, Color(0.09, 0.11, 0.21)],
	[6.5, 0.45, Color(1.00, 0.72, 0.55), 0.95, 20.0, -78.0, Color(0.58, 0.52, 0.62), 0.85, Color(0.80, 0.66, 0.66)],
	[8.0, 0.0, Color(1.00, 0.95, 0.86), 1.45, 52.0, -38.0, Color(0.72, 0.78, 0.86), 0.78, Color(0.64, 0.78, 0.90)],
	[15.5, 0.0, Color(1.00, 0.95, 0.86), 1.45, 52.0, -38.0, Color(0.72, 0.78, 0.86), 0.78, Color(0.64, 0.78, 0.90)],
	[17.5, 0.28, Color(1.00, 0.70, 0.45), 1.15, 24.0, 78.0, Color(0.66, 0.58, 0.64), 0.82, Color(0.90, 0.68, 0.52)],
	[18.8, 0.78, Color(0.78, 0.55, 0.62), 0.70, 14.0, 84.0, Color(0.42, 0.42, 0.60), 0.90, Color(0.36, 0.30, 0.46)],
	[20.3, 1.0, Color(0.55, 0.62, 0.95), 0.30, 48.0, -40.0, Color(0.30, 0.36, 0.58), 0.95, Color(0.07, 0.09, 0.17)],
	[24.0, 1.0, Color(0.55, 0.62, 0.95), 0.30, 48.0, -40.0, Color(0.30, 0.36, 0.58), 0.95, Color(0.07, 0.09, 0.17)],
]

var light: DirectionalLight3D
var env: Environment
var tz_name: String = "Asia/Tokyo"
## 网页桥（TBridge）。钟点取自 boot.js 的 worldHour（Intl，认夏令时、任意 IANA 时区），和音频同一个来源；没有桥（非网页环境）时退路是东京时间（UTC+9），与音频的退路一致。
var bridge = null
## 钟点至多每秒向 JS 要一次，不每帧调用。
const HOUR_REFRESH_MS := 1000
var _hour_ticks: int = -1000000
var debug_hour: float = -1.0
var hour: float = 12.0
var night: float = 0.0
var high_quality: bool = true
var _energy: float = 1.0
## 兼容渲染器里开了平行光阴影后同样的 light_energy 的受光量约是无阴影时的 2.4 倍（实测），所以高画质档把光强乘这个系数，两档看起来一样亮。
const HQ_ENERGY := 0.3


func _ready() -> void:
	light = DirectionalLight3D.new()
	light.name = "sun"
	light.light_specular = 0.0
	light.shadow_enabled = high_quality
	light.directional_shadow_mode = DirectionalLight3D.SHADOW_ORTHOGONAL
	light.directional_shadow_max_distance = 60.0
	light.shadow_bias = 0.06
	light.shadow_normal_bias = 1.2
	light.shadow_blur = 1.6
	add_child(light)
	env = Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.tonemap_mode = Environment.TONE_MAPPER_LINEAR
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	apply_hour(12.0)


func set_timezone(name: String) -> void:
	if name != "" and name != tz_name:
		tz_name = name
		_hour_ticks = -1000000  # 时区换了，下一次 tick 马上重算


func set_quality(high: bool) -> void:
	high_quality = high
	if light != null:
		light.shadow_enabled = high
		light.light_energy = _energy * (HQ_ENERGY if high else 1.0)


## 世界钟点（0..24）。server_ms 是服务器毫秒时间（clock.server_now()）。
func hour_at(server_ms: float) -> float:
	if bridge != null and bridge.web:
		var h: float = float(bridge.host.worldHour(tz_name, server_ms))
		if h >= 0.0:
			return h
	var dt: Dictionary = Time.get_datetime_dict_from_unix_time(int(server_ms / 1000.0) + 9 * 3600)
	return float(dt["hour"]) + float(dt["minute"]) / 60.0


## synced：服务器时间已经对上（clock.has_sync）。没对上之前保持上一次的光照，不按错的钟点闪一下。
## debug_hour >= 0 时固定在那个钟点，不受 synced 影响。
func tick(server_ms: float, synced: bool = true) -> void:
	if debug_hour >= 0.0:
		if hour != debug_hour:
			apply_hour(debug_hour)
		return
	if not synced:
		return
	var t: int = Time.get_ticks_msec()
	if t - _hour_ticks < HOUR_REFRESH_MS:
		return
	_hour_ticks = t
	apply_hour(hour_at(server_ms))


func apply_hour(h: float) -> void:
	hour = h
	var i: int = 0
	while i < KEYS.size() - 2 and h >= float(KEYS[i + 1][0]):
		i += 1
	var a: Array = KEYS[i]
	var b: Array = KEYS[i + 1]
	var span: float = float(b[0]) - float(a[0])
	var t: float = clampf((h - float(a[0])) / span, 0.0, 1.0)
	t = t * t * (3.0 - 2.0 * t)
	night = lerpf(float(a[1]), float(b[1]), t)
	light.light_color = (a[2] as Color).lerp(b[2], t)
	_energy = lerpf(float(a[3]), float(b[3]), t)
	light.light_energy = _energy * (HQ_ENERGY if high_quality else 1.0)
	var pitch: float = lerpf(float(a[4]), float(b[4]), t)
	var yaw: float = lerpf(float(a[5]), float(b[5]), t)
	light.rotation_degrees = Vector3(-pitch, yaw, 0.0)
	env.ambient_light_color = (a[6] as Color).lerp(b[6], t)
	env.ambient_light_energy = lerpf(float(a[7]), float(b[7]), t)
	env.background_color = (a[8] as Color).lerp(b[8], t)
	RenderingServer.global_shader_parameter_set("town_night", night)
