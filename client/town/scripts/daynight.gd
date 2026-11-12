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
const TZ_OFFSETS := {
	"Asia/Tokyo": 9.0, "Asia/Seoul": 9.0, "Asia/Shanghai": 8.0, "Asia/Hong_Kong": 8.0, "Asia/Taipei": 8.0, "Asia/Singapore": 8.0,
	"Asia/Kolkata": 5.5, "Europe/London": 0.0, "Europe/Paris": 1.0, "Europe/Berlin": 1.0, "UTC": 0.0, "Etc/UTC": 0.0,
	"America/New_York": -5.0, "America/Chicago": -6.0, "America/Denver": -7.0, "America/Los_Angeles": -8.0, "Australia/Sydney": 10.0,
}

var light: DirectionalLight3D
var env: Environment
var tz_hours: float = 9.0
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
	tz_hours = float(TZ_OFFSETS.get(name, 9.0))


func set_quality(high: bool) -> void:
	high_quality = high
	if light != null:
		light.shadow_enabled = high
		light.light_energy = _energy * (HQ_ENERGY if high else 1.0)


## 世界钟点（0..24）。
func hour_at(server_now: float) -> float:
	var h: float = fposmod(server_now / 3600.0 + tz_hours, 24.0)
	return h


func tick(server_now: float) -> void:
	apply_hour(debug_hour if debug_hour >= 0.0 else hour_at(server_now))


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
