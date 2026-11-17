class_name TRig
extends Node3D
## 固定朝向和俯角的斜俯视镜头：平滑跟随目标，有限缩放（不做自由旋转）。
## 靠近、俯角放低一点，让人物的头发、衣服、朝向看得清；横屏（桌面）和竖屏（手机）各有适合的距离和俯角。

const PITCH_LANDSCAPE := 40.0
const PITCH_PORTRAIT := 46.0
const DIST_MIN := 6.5
const DIST_MAX := 36.0
const DIST_LANDSCAPE := 17.0
const DIST_PORTRAIT := 14.0

var cam: Camera3D
var focus: Vector3 = Vector3.ZERO
var dist: float = DIST_LANDSCAPE
var pitch_deg: float = PITCH_LANDSCAPE
var _portrait: bool = false
var _aspect_set: bool = false


func _ready() -> void:
	cam = Camera3D.new()
	cam.fov = 40.0
	cam.near = 0.5
	cam.far = 400.0
	cam.current = true
	add_child(cam)
	_update()


## 竖屏（手机）时按宽度定视野，免得只看得到脚边一小块；第一次、以及横竖屏切换时，换成该方向的默认距离和俯角。
func set_aspect(a: float) -> void:
	var portrait: bool = a < 1.0
	if portrait:
		cam.keep_aspect = Camera3D.KEEP_WIDTH
		cam.fov = 55.0
	else:
		cam.keep_aspect = Camera3D.KEEP_HEIGHT
		cam.fov = 40.0
	if not _aspect_set or portrait != _portrait:
		_aspect_set = true
		_portrait = portrait
		dist = DIST_PORTRAIT if portrait else DIST_LANDSCAPE
		pitch_deg = PITCH_PORTRAIT if portrait else PITCH_LANDSCAPE
		_update()


func snap(p: Vector3) -> void:
	focus = p
	_update()


func follow(p: Vector3, dt: float) -> void:
	focus = focus.lerp(p, 1.0 - exp(-dt * 5.0))
	_update()


func zoom_mul(f: float) -> void:
	dist = clampf(dist * f, DIST_MIN, DIST_MAX)
	_update()


func _update() -> void:
	if cam == null:
		return
	var pitch: float = deg_to_rad(pitch_deg)
	cam.position = focus + Vector3(0.0, sin(pitch), cos(pitch)) * dist
	cam.look_at_from_position(cam.position, focus, Vector3.UP)


## 屏幕点 -> 地面 (y=0) 上的点；射线朝上或没打到返回 null。
func ground_hit(screen: Vector2):
	var o: Vector3 = cam.project_ray_origin(screen)
	var n: Vector3 = cam.project_ray_normal(screen)
	if n.y >= -0.0001:
		return null
	var t: float = -o.y / n.y
	return o + n * t
