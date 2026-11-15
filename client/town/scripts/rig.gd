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
var _aspect: float = 1.6
# 镜头给面板让位（V1）：自己的角色投影在「目标屏幕点」上（归一化，默认正中）。网页层发来没被界面盖住的那块，目标点缓动过去。
# focus 仍是「跟随点」（平滑追角色）；镜头实际看向 focus 减去目标点的地面偏移（view_logic.gd），所以角色停在目标点上。
var tgt: Vector2 = Vector2(0.5, 0.5)  # 现在的目标点（缓动中）
var tgt_goal: Vector2 = Vector2(0.5, 0.5)
var view_msgs: int = 0  # 收到的版式消息条数（?debug=1 里读：站着不动不应增加）
var _tgt_from: Vector2 = Vector2(0.5, 0.5)
var _tgt_t: float = ViewLogic.DUR
var settled: bool = true  # 目标点缓动完、跟随也赶上了
var hold_t: float = -1.0  # 仅测试（?debug=1）：>= 0 时把缓动冻结在这个时刻（秒），让端到端能在「缓动中途」精确地点地；负数是不冻结


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
	_aspect = a
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


## 网页层发来版式（没被界面盖住的那块）：算出新的目标点，不同就缓动过去；太小不追（保持原来的目标点）。
func set_view(rect: Dictionary) -> void:
	view_msgs += 1
	var g: Vector2 = ViewLogic.target(rect, tgt_goal)
	if g.is_equal_approx(tgt_goal):
		return
	_tgt_from = tgt
	tgt_goal = g
	_tgt_t = 0.0
	settled = false


func follow(p: Vector3, dt: float) -> void:
	focus = focus.lerp(p, 1.0 - exp(-dt * 5.0))
	if hold_t >= 0.0:
		_tgt_t = minf(hold_t, ViewLogic.DUR * 0.99)
		tgt = ViewLogic.eased(_tgt_from, tgt_goal, _tgt_t)
	elif _tgt_t < ViewLogic.DUR:
		_tgt_t += dt
		tgt = ViewLogic.eased(_tgt_from, tgt_goal, _tgt_t)
	settled = hold_t < 0.0 and _tgt_t >= ViewLogic.DUR and focus.distance_to(p) < 0.03
	_update()


func zoom_mul(f: float) -> void:
	dist = clampf(dist * f, DIST_MIN, DIST_MAX)
	_update()


## 目标点相对画面正中的地面偏移（世界 x、z）：镜头看向 focus - 这个偏移，角色就落在目标点上；缩放、横竖屏切换时随距离、视野一起变。
func target_offset() -> Vector2:
	if cam == null or (absf(tgt.x - 0.5) < 0.0001 and absf(tgt.y - 0.5) < 0.0001):
		return Vector2.ZERO
	return ViewLogic.ground_offset(pitch_deg, dist, cam.fov, cam.keep_aspect == Camera3D.KEEP_WIDTH, _aspect, tgt)


func _update() -> void:
	if cam == null:
		return
	var off: Vector2 = target_offset()
	var look: Vector3 = focus - Vector3(off.x, 0.0, off.y)
	var pitch: float = deg_to_rad(pitch_deg)
	cam.position = look + Vector3(0.0, sin(pitch), cos(pitch)) * dist
	cam.look_at_from_position(cam.position, look, Vector3.UP)


## 屏幕点 -> 地面 (y=0) 上的点；射线朝上或没打到返回 null。
func ground_hit(screen: Vector2):
	var o: Vector3 = cam.project_ray_origin(screen)
	var n: Vector3 = cam.project_ray_normal(screen)
	if n.y >= -0.0001:
		return null
	var t: float = -o.y / n.y
	return o + n * t
