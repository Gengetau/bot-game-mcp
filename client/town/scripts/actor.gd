class_name TActor
extends Node3D
## 一个居民的三维形象。位置只由服务器给的折线 + 速度 + 出发时刻 + 服务器时间现算（没有客户端预测）；
## 服务器快照把位置纠正了，就把「显示位置 − 新的真值」记成偏差，让它指数衰减，画面平滑收敛。

const SNAP_DISTANCE := 6.0
const ERR_RATE := 6.0
const MODEL_PATH := "res://assets/models/characters/resident.glb"

var actor_id: String = ""
var actor_name: String = ""
var kind: String = ""
var is_self: bool = false
var busy: bool = false

# 服务器给的真值
var base: Vector2 = Vector2.ZERO
var heading: float = 0.0
var has_nav: bool = false
var nav_id: String = ""
var nav_rev: int = 0
var nav_speed: float = 2.4
var nav_start: float = 0.0
var nav_until: float = 0.0
var _pts: Array = []  # Array[Vector2]
var _cum: Array = []  # 累计长度
var _total: float = 0.0

# 显示
var err: Vector2 = Vector2.ZERO
var disp: Vector2 = Vector2.ZERO
var moving: bool = false
var dir: Vector2 = Vector2(0, 1)  # 世界 (x, z) 方向
var _initialized: bool = false

var _pivot: Node3D
var _anim: AnimationPlayer = null
var _cur_anim: String = ""
var _ring: MeshInstance3D


static var _model_scene: PackedScene = null
static var _model_tried: bool = false


func setup(id: String, display_name: String, actor_kind: String, mine: bool) -> void:
	actor_id = id
	actor_name = display_name
	kind = actor_kind
	is_self = mine
	name = "actor_" + id
	_pivot = Node3D.new()
	_pivot.name = "pivot"
	add_child(_pivot)
	_build_model()
	_build_ring()


func _build_model() -> void:
	if not _model_tried:
		_model_tried = true
		if ResourceLoader.exists(MODEL_PATH):
			var res = load(MODEL_PATH)
			if res is PackedScene:
				_model_scene = res
	if _model_scene != null:
		var inst: Node = _model_scene.instantiate()
		if inst is Node3D:
			_pivot.add_child(inst)
			var found: Array = inst.find_children("*", "AnimationPlayer", true, false)
			if not found.is_empty():
				_anim = found[0] as AnimationPlayer
				for an in ["idle", "walk"]:
					if _anim.has_animation(an):
						_anim.get_animation(an).loop_mode = Animation.LOOP_LINEAR
				_play("idle")
			return
		inst.queue_free()
	# 占位：胶囊 + 一个指向前方（+Z）的小方块
	var mi := MeshInstance3D.new()
	var cm := CapsuleMesh.new()
	cm.radius = 0.3
	cm.height = 1.7
	mi.mesh = cm
	mi.position.y = 0.85
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.25, 0.5, 0.85) if is_self else Color(0.85, 0.55, 0.25)
	mi.material_override = mat
	_pivot.add_child(mi)
	var nose := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(0.18, 0.18, 0.3)
	nose.mesh = bm
	nose.position = Vector3(0, 1.3, 0.3)
	nose.material_override = mat
	_pivot.add_child(nose)


func _build_ring() -> void:
	_ring = MeshInstance3D.new()
	var cyl := CylinderMesh.new()
	cyl.top_radius = 0.55
	cyl.bottom_radius = 0.55
	cyl.height = 0.02
	cyl.radial_segments = 24
	cyl.rings = 1
	_ring.mesh = cyl
	_ring.position.y = 0.03
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.albedo_color = Color(0.1, 0.8, 0.75, 0.55) if is_self else Color(0.95, 0.95, 0.95, 0.28)
	_ring.material_override = mat
	add_child(_ring)


func _play(anim: String, speed_scale: float = 1.0) -> void:
	if _anim == null or not _anim.has_animation(anim):
		return
	if _cur_anim != anim:
		_cur_anim = anim
		_anim.play(anim, 0.15)
	_anim.speed_scale = speed_scale


## 应用一份快照里的条目 a（Dictionary），now_ms 是此刻的服务器时间估计。
func apply(a: Dictionary, now_ms: float) -> void:
	actor_name = str(a.get("name", actor_name))
	kind = str(a.get("kind", kind))
	busy = bool(a.get("busy", false))
	var old_disp: Vector2 = disp
	var was_init: bool = _initialized
	base = Vector2(float(a.get("x", 0.0)), float(a.get("z", 0.0)))
	heading = float(a.get("heading", heading))
	var nav = a.get("nav")
	if nav is Dictionary:
		var pts: Array = []
		for p in nav.get("points", []):
			pts.append(Vector2(float(p.get("x", 0.0)), float(p.get("z", 0.0))))
		if pts.size() >= 2:
			has_nav = true
			nav_id = str(nav.get("id", ""))
			nav_rev = int(nav.get("revision", 0))
			nav_speed = float(nav.get("speed", 2.4))
			nav_start = float(nav.get("startedAt", 0.0))
			nav_until = float(nav.get("until", 0.0))
			_pts = pts
			_cum = [0.0]
			var acc: float = 0.0
			for i in range(1, pts.size()):
				acc += (pts[i] as Vector2).distance_to(pts[i - 1])
				_cum.append(acc)
			_total = acc
		else:
			_clear_nav()
	else:
		_clear_nav()
	var t: Dictionary = truth_at(now_ms)
	var truth_pos: Vector2 = t["pos"]
	if was_init:
		err = old_disp - truth_pos
		if err.length() > SNAP_DISTANCE:
			err = Vector2.ZERO
	else:
		err = Vector2.ZERO
		_initialized = true
		# 初次出现：朝向直接对上
		var d0: Vector2 = t["dir"]
		_pivot.rotation.y = atan2(d0.x, d0.y)
	disp = truth_pos + err
	_apply_transform()


func _clear_nav() -> void:
	has_nav = false
	nav_id = ""
	_pts = []
	_cum = []
	_total = 0.0


## 某个服务器时刻的真值：{pos, moving, dir}。
func truth_at(t_ms: float) -> Dictionary:
	var d: Vector2 = Vector2(sin(heading), -cos(heading))
	if not has_nav:
		return {"pos": base, "moving": false, "dir": d}
	var te: float = minf(t_ms, nav_until)
	var dist: float = maxf(0.0, nav_speed * (te - nav_start) / 1000.0)
	if dist >= _total:
		var last_dir: Vector2 = d
		if _pts.size() >= 2:
			var seg: Vector2 = (_pts[_pts.size() - 1] as Vector2) - (_pts[_pts.size() - 2] as Vector2)
			if seg.length() > 0.001:
				last_dir = seg.normalized()
		return {"pos": _pts[_pts.size() - 1], "moving": false, "dir": last_dir}
	var i: int = 1
	while i < _cum.size() - 1 and float(_cum[i]) < dist:
		i += 1
	var seg_len: float = float(_cum[i]) - float(_cum[i - 1])
	var a: Vector2 = _pts[i - 1]
	var b: Vector2 = _pts[i]
	var f: float = 0.0 if seg_len <= 0.0001 else (dist - float(_cum[i - 1])) / seg_len
	var dir_v: Vector2 = (b - a)
	dir_v = dir_v.normalized() if dir_v.length() > 0.0001 else d
	var is_moving: bool = t_ms < nav_until
	return {"pos": a.lerp(b, clampf(f, 0.0, 1.0)), "moving": is_moving, "dir": dir_v}


## 每帧：now_ms 是服务器时间估计；返回这一帧是否在走。
func tick(dt: float, now_ms: float) -> void:
	var t: Dictionary = truth_at(now_ms)
	err *= exp(-dt * ERR_RATE)
	if err.length() < 0.002:
		err = Vector2.ZERO
	disp = (t["pos"] as Vector2) + err
	moving = bool(t["moving"])
	dir = t["dir"]
	var target_yaw: float = atan2(dir.x, dir.y)
	_pivot.rotation.y = lerp_angle(_pivot.rotation.y, target_yaw, 1.0 - exp(-dt * 12.0))
	_apply_transform()
	if moving:
		_play("walk", clampf(nav_speed / 2.0, 0.6, 1.8))
	else:
		_play("idle")


func _apply_transform() -> void:
	position = Vector3(disp.x, 0.0, disp.y)
