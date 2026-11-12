class_name TRig
extends Node3D
## 固定朝向和俯角的斜俯视镜头：平滑跟随目标，有限缩放（不做自由旋转）。

const PITCH_DEG := 52.0
const DIST_MIN := 9.0
const DIST_MAX := 42.0

var cam: Camera3D
var focus: Vector3 = Vector3.ZERO
var dist: float = 24.0


func _ready() -> void:
	cam = Camera3D.new()
	cam.fov = 40.0
	cam.near = 0.5
	cam.far = 400.0
	cam.current = true
	add_child(cam)
	_update()


## 竖屏（手机）时按宽度定视野，免得只看得到脚边一小块。
func set_aspect(a: float) -> void:
	if a < 1.0:
		cam.keep_aspect = Camera3D.KEEP_WIDTH
		cam.fov = 55.0
	else:
		cam.keep_aspect = Camera3D.KEEP_HEIGHT
		cam.fov = 40.0


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
	var pitch: float = deg_to_rad(PITCH_DEG)
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
