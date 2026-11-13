class_name TActor
extends Node3D
## 一个居民的三维形象。位置只由服务器给的折线 + 速度 + 出发时刻 + 服务器时间现算（没有客户端预测）；
## 服务器快照把位置纠正了，就把「显示位置 − 新的真值」记成偏差，让它指数衰减，画面平滑收敛。
## 外观：KayKit 的骨架（Rig_Medium）+ 8 套重新配色的衣服，按居民编号的哈希挑一套（见 appearance_for，换一套规则只改这一个函数）。
## 动作：idle / walk / sit_down / sit_idle / stand_up / wave / interact，朝向跟着移动方向。

const SNAP_DISTANCE := 6.0
const ERR_RATE := 6.0
const BODY_BASES := ["rogue", "rogue", "ranger", "ranger", "mage", "mage", "knight", "knight"]
const OUTFIT_COUNT := 8
const CHAR_DIR := "res://assets/models/characters/"
const TARGET_HEIGHT := 1.72  # 米：居民的身高（含头发），按模型实际高度折算缩放
const SIT_HEIGHT := 0.0
const SIT_DIST := 0.5  # 离座位锚点多近算坐着

var actor_id: String = ""
var actor_name: String = ""
var kind: String = ""
var is_self: bool = false
var busy: bool = false
var outfit: int = 0

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
var sitting: bool = false
var sit_face: Vector2 = Vector2.ZERO  # 坐着时面朝的点（桌子）
var _initialized: bool = false

var _pivot: Node3D
var _anim: AnimationPlayer = null
var _cur_anim: String = ""
var _ring: MeshInstance3D
var _shadow: MeshInstance3D
var _marker: MeshInstance3D = null
var _sit_phase: int = 0  # 0 站着 1 坐下中 2 坐着 3 起身中
var _flavor_t: float = 6.0
var _once: bool = false
var _age: float = 0.0

static var _lib: AnimationLibrary = null
static var _scenes: Dictionary = {}
static var _mats: Dictionary = {}
static var _shadow_tex: ImageTexture = null
static var _shadow_mat: StandardMaterial3D = null


## 外观规则：居民编号 -> 第几套衣服（0..7）。要换规则（比如按服务器给的外观字段）只改这里。
static func appearance_for(actor_id_: String, _actor_kind: String = "") -> int:
	return int(absi(actor_id_.hash())) % OUTFIT_COUNT


static func _outfit_mat(i: int) -> ShaderMaterial:
	if _mats.has(i):
		return _mats[i]
	var m := ShaderMaterial.new()
	m.shader = load("res://assets/shaders/town.gdshader")
	var tex = load(CHAR_DIR + "outfit_%d.png" % i)
	m.set_shader_parameter("pal", tex)
	_mats[i] = m
	return m


func setup(id: String, display_name: String, actor_kind: String, mine: bool) -> void:
	actor_id = id
	actor_name = display_name
	kind = actor_kind
	is_self = mine
	name = "actor_" + id
	outfit = appearance_for(id, actor_kind)
	_pivot = Node3D.new()
	_pivot.name = "pivot"
	add_child(_pivot)
	_build_model()
	_build_shadow()
	if mine:
		_build_ring()
		_build_marker()
	_flavor_t = 5.0 + float(absi(id.hash()) % 100) * 0.12


func _build_model() -> void:
	var base_name: String = BODY_BASES[outfit]
	if not _scenes.has(base_name):
		var path: String = CHAR_DIR + "body_%s.scn" % base_name
		_scenes[base_name] = load(path) if ResourceLoader.exists(path) else null
	if _lib == null:
		var lp: String = CHAR_DIR + "residents_anims.res"
		if ResourceLoader.exists(lp):
			_lib = load(lp)
	var ps = _scenes[base_name]
	if ps is PackedScene:
		var inst: Node = (ps as PackedScene).instantiate()
		if inst is Node3D:
			_pivot.add_child(inst)
			var mat := _outfit_mat(outfit)
			for mi in inst.find_children("*", "MeshInstance3D", true, false):
				(mi as MeshInstance3D).material_override = mat
			# 缩放到目标身高：用身体各部件在静止姿势下的包围盒
			var top: float = 0.0
			for mi in inst.find_children("*", "MeshInstance3D", true, false):
				var bb: AABB = (mi as MeshInstance3D).get_aabb()
				top = maxf(top, bb.position.y + bb.size.y)
			if top > 0.2:
				(inst as Node3D).scale = Vector3.ONE * (TARGET_HEIGHT / top)
			if _lib != null:
				_anim = AnimationPlayer.new()
				_anim.name = "anim"
				inst.add_child(_anim)
				_anim.root_node = NodePath("..")
				_anim.add_animation_library("", _lib)
				_anim.animation_finished.connect(_on_anim_finished)
				_play("idle")
			return
		inst.queue_free()
	# 占位：胶囊 + 一个指向前方（+Z）的小方块
	var mi2 := MeshInstance3D.new()
	var cm := CapsuleMesh.new()
	cm.radius = 0.3
	cm.height = 1.7
	mi2.mesh = cm
	mi2.position.y = 0.85
	var pm := StandardMaterial3D.new()
	pm.albedo_color = Color(0.25, 0.5, 0.85) if is_self else Color(0.85, 0.55, 0.25)
	mi2.material_override = pm
	_pivot.add_child(mi2)


func _build_shadow() -> void:
	if _shadow_tex == null:
		var img := Image.create(64, 64, false, Image.FORMAT_RGBA8)
		for y in range(64):
			for x in range(64):
				var d: float = Vector2(float(x) - 31.5, float(y) - 31.5).length() / 32.0
				var a: float = clampf(1.0 - d, 0.0, 1.0)
				a = a * a * (3.0 - 2.0 * a)
				img.set_pixel(x, y, Color(0.05, 0.05, 0.12, a * 0.42))
		_shadow_tex = ImageTexture.create_from_image(img)
		_shadow_mat = StandardMaterial3D.new()
		_shadow_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		_shadow_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		_shadow_mat.albedo_texture = _shadow_tex
		_shadow_mat.cull_mode = BaseMaterial3D.CULL_DISABLED
		_shadow_mat.disable_receive_shadows = true
	_shadow = MeshInstance3D.new()
	var q := QuadMesh.new()
	q.size = Vector2(1.15, 1.15)
	q.orientation = PlaneMesh.FACE_Y
	_shadow.mesh = q
	_shadow.material_override = _shadow_mat
	_shadow.position.y = 0.04
	_shadow.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_shadow.name = "blob_shadow"
	add_child(_shadow)


func _build_ring() -> void:
	_ring = MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.52
	tm.outer_radius = 0.64
	tm.rings = 24
	tm.ring_segments = 4
	_ring.mesh = tm
	_ring.scale = Vector3(1.0, 0.05, 1.0)
	_ring.position.y = 0.06
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = Color(0.20, 0.88, 0.80)
	mat.no_depth_test = false
	_ring.material_override = mat
	_ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_ring.name = "self_ring"
	add_child(_ring)


func _build_marker() -> void:
	# 头顶浮着的小菱锥（上下轻轻晃），一眼找到自己
	_marker = MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 0.2
	cm.bottom_radius = 0.0
	cm.height = 0.32
	cm.radial_segments = 4
	cm.rings = 1
	_marker.mesh = cm
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = Color(0.20, 0.88, 0.80)
	_marker.material_override = mat
	_marker.position.y = 2.15
	_marker.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_marker.name = "self_marker"
	add_child(_marker)


func set_shadow_visible(v: bool) -> void:
	if _shadow != null:
		_shadow.visible = v


func _play(anim: String, speed_scale: float = 1.0) -> void:
	if _anim == null or not _anim.has_animation(anim):
		return
	if _cur_anim != anim:
		_cur_anim = anim
		_anim.play(anim, 0.18)
	_anim.speed_scale = speed_scale


func _on_anim_finished(an: StringName) -> void:
	var n: String = str(an)
	if n == "sit_down" and _sit_phase == 1:
		_sit_phase = 2
		_cur_anim = ""
		_play("sit_idle")
	elif n == "stand_up" and _sit_phase == 3:
		_sit_phase = 0
		_cur_anim = ""
		_play("idle")
	elif _once:
		_once = false
		_cur_anim = ""
		_play("idle")


## 坐下 / 起身（座位由 main.gd 按服务器给的座位锚点和「物件正在使用」判断）。face：面朝的点。
func set_sitting(on: bool, face: Vector2 = Vector2.ZERO) -> void:
	if on:
		sit_face = face
	if on == sitting:
		return
	sitting = on
	if on:
		_sit_phase = 1
		_cur_anim = ""
		_play("sit_down")
	else:
		_sit_phase = 3
		_cur_anim = ""
		_play("stand_up")


func play_once(anim: String) -> void:
	if _anim == null or sitting or moving or not _anim.has_animation(anim):
		return
	_once = true
	_cur_anim = ""
	_play(anim)


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
	_age += dt
	if moving and sitting:
		sitting = false
		_sit_phase = 0
		_cur_anim = ""
	var target_yaw: float = atan2(dir.x, dir.y)
	if sitting and sit_face != Vector2.ZERO:
		var fd: Vector2 = sit_face - disp
		if fd.length() > 0.05:
			target_yaw = atan2(fd.x, fd.y)
	if not moving or sitting or true:
		_pivot.rotation.y = lerp_angle(_pivot.rotation.y, target_yaw, 1.0 - exp(-dt * 12.0))
	_apply_transform()
	if moving:
		_once = false
		# 起身 / 坐下动画被走路顶掉时 Godot 不发 animation_finished，阶段要在这里清零，否则站定后永远不再回到 idle
		if _sit_phase == 1 or _sit_phase == 3:
			_sit_phase = 0
		_play("walk", clampf(nav_speed / 2.0, 0.6, 1.8))
	elif _sit_phase == 0 and not _once:
		_play("idle")
		_flavor_t -= dt
		if _flavor_t <= 0.0:
			_flavor_t = 9.0 + float(absi(actor_id.hash() + int(_age)) % 120) * 0.1
			play_once("wave" if int(_age) % 2 == 0 else "interact")
	if _marker != null:
		_marker.position.y = 2.15 + 0.07 * sin(_age * 3.0)
		_marker.rotation.y = _age * 1.6


func _apply_transform() -> void:
	position = Vector3(disp.x, 0.0, disp.y)
