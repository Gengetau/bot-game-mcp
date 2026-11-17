class_name TStatefulProp
extends Node3D
## 带状态的物件 / 建筑的包装场景根节点（client/tools/kit_wrap.gd 生成的 .tscn 把它挂在根上，子节点是导入的 GLB）。
## 它只做表现：按状态名显示 base* 和 state_<名>* 节点、播同名动画、提供锚点和包围盒。不结算、不改库存、不发请求：
## 什么时候进哪个状态由服务端的数据决定，客户端只做「服务端数据 -> 状态名」的映射（prop_state.gd），再调 set_state。
## 命名约定和纯逻辑在 kit_logic.gd。

var _scanned: bool = false
var _state: String = TKitLogic.DEFAULT_STATE
var _states: Array = []  # 场景里出现的状态名
var _nodes: Dictionary = {}  # 名字 -> Node3D（只含 base / fade / state 角色的节点）
var _anchors: Dictionary = {}  # 名字 -> {node, kind}
var _meshes: Array = []  # 所有 MeshInstance3D
var _fades: Array = []  # fade 角色的节点
var _players: Array = []  # AnimationPlayer
var _warned: Dictionary = {}


func _ready() -> void:
	_ensure_scan()
	set_state(_state)


## 扫一遍子树。可以不进场景树就调用（单测、生成清单时）。
func _ensure_scan() -> void:
	if _scanned:
		return
	_scanned = true
	_scan(self)
	_states = TKitLogic.states_of(_nodes.keys())
	if not (TKitLogic.DEFAULT_STATE in _states):
		_states.append(TKitLogic.DEFAULT_STATE)


func _scan(n: Node) -> void:
	for c in n.get_children():
		var nm: String = str(c.name)
		var cl: Dictionary = TKitLogic.classify(nm)
		if c is Node3D:
			match cl["role"]:
				TKitLogic.ROLE_BASE, TKitLogic.ROLE_STATE:
					_nodes[nm] = c
				TKitLogic.ROLE_FADE:
					_nodes[nm] = c
					_fades.append(c)
				TKitLogic.ROLE_ANCHOR:
					_anchors[nm] = {"node": c, "kind": cl["kind"]}
		if c is MeshInstance3D and (c as MeshInstance3D).mesh != null:
			_meshes.append(c)
		if c is AnimationPlayer:
			_players.append(c)
		_scan(c)


## 切状态：显示 base* / fade* 和 state_<名>*，隐藏其它 state_*；有 `state_<名>` 动画就播。不认识的状态名退回 idle 并记一条警告。
func set_state(state: String) -> void:
	_ensure_scan()
	var want: String = TKitLogic.resolve_state(state, _states)
	if want != state and not _warned.has(state):
		_warned[state] = true
		push_warning("[prop] %s 没有状态「%s」，退回 idle（可用：%s）" % [name, state, ", ".join(PackedStringArray(_states))])
	_state = want
	var vis: Dictionary = TKitLogic.visibility(_nodes.keys(), want)
	for nm in vis:
		(_nodes[nm] as Node3D).visible = bool(vis[nm])
	_play_anim(want)


func _play_anim(state: String) -> void:
	var an: String = "state_" + state
	for p in _players:
		var ap: AnimationPlayer = p
		if ap.has_animation(an):
			ap.play(an)
		else:
			ap.stop()


func get_state() -> String:
	return _state


func states() -> Array:
	_ensure_scan()
	return _states.duplicate()


## 把所有状态的节点都显示出来（着色器预热用：隐藏的节点不会被画，第一次切状态才编译会卡一下）。之后调 set_state(get_state()) 还原。
func show_all_states() -> void:
	_ensure_scan()
	for nm in _nodes:
		(_nodes[nm] as Node3D).visible = true


## 锚点的全局变换（不在场景树里也能算：沿父链累乘到场景根）。找不到返回 Transform3D.IDENTITY 并记警告。
func anchor(anchor_name: String) -> Transform3D:
	_ensure_scan()
	var a: Dictionary = _anchors.get(anchor_name, {})
	if a.is_empty():
		push_warning("[prop] %s 没有锚点「%s」" % [name, anchor_name])
		return Transform3D.IDENTITY
	return _global_of(a["node"])


## 某类锚点（use / put / fx）：[{name, xf}]，按名字排序。
func anchors(kind: String) -> Array:
	_ensure_scan()
	var out: Array = []
	var keys: Array = _anchors.keys()
	keys.sort()
	for k in keys:
		var a: Dictionary = _anchors[k]
		if a["kind"] == kind:
			out.append({"name": k, "xf": _global_of(a["node"])})
	return out


func anchor_names() -> Array:
	_ensure_scan()
	var keys: Array = _anchors.keys()
	keys.sort()
	return keys


func _global_of(n: Node3D) -> Transform3D:
	if n.is_inside_tree():
		return n.global_transform
	var xf: Transform3D = n.transform
	var p: Node = n.get_parent()
	while p != null and p is Node3D:
		xf = (p as Node3D).transform * xf
		p = p.get_parent()
	return xf


func mesh_instances() -> Array:
	_ensure_scan()
	return _meshes


func fade_nodes() -> Array:
	_ensure_scan()
	return _fades


## 所有网格都换成城镇着色器的材质（昼夜、发光和周围一致）；fade* 下面的网格用 fade_mat（它们要各自淡出，由调用方给一份复制）。
func apply_materials(mat: Material, fade_mat: Material = null) -> void:
	_ensure_scan()
	for m in _meshes:
		var mi: MeshInstance3D = m
		mi.material_override = fade_mat if (fade_mat != null and _under_fade(mi)) else mat
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON


func _under_fade(n: Node) -> bool:
	var cur: Node = n
	while cur != null and cur != self:
		if TKitLogic.classify(str(cur.name))["role"] == TKitLogic.ROLE_FADE:
			return true
		cur = cur.get_parent()
	return false


## 在本节点局部坐标里的包围盒（只算 filter 选中的网格）。which："base"（base* 和 fade*，常显的部分）、"all"（含所有状态）。
func local_bounds(which: String = "all") -> AABB:
	_ensure_scan()
	var box := AABB()
	var first := true
	for m in _meshes:
		var mi: MeshInstance3D = m
		if which == "base" and not _is_always_on(mi):
			continue
		var xf: Transform3D = _relative_xf(mi)
		var bb: AABB = xf * mi.mesh.get_aabb()
		box = bb if first else box.merge(bb)
		first = false
	return box


func _is_always_on(n: Node) -> bool:
	var cur: Node = n
	while cur != null and cur != self:
		var r: String = TKitLogic.classify(str(cur.name))["role"]
		if r == TKitLogic.ROLE_STATE:
			return false
		if r == TKitLogic.ROLE_BASE or r == TKitLogic.ROLE_FADE:
			return true
		cur = cur.get_parent()
	return false


func _relative_xf(n: Node3D) -> Transform3D:
	var xf: Transform3D = Transform3D.IDENTITY
	var cur: Node = n
	while cur != null and cur != self:
		if cur is Node3D:
			xf = (cur as Node3D).transform * xf
		cur = cur.get_parent()
	return xf


## 某个 fade 节点下所有网格的包围盒（本节点局部坐标）。
func fade_bounds(fade_node: Node3D) -> AABB:
	_ensure_scan()
	var box := AABB()
	var first := true
	for m in _meshes:
		var mi: MeshInstance3D = m
		var cur: Node = mi
		var under: bool = false
		while cur != null and cur != self:
			if cur == fade_node:
				under = true
				break
			cur = cur.get_parent()
		if not under:
			continue
		var bb: AABB = _relative_xf(mi) * mi.mesh.get_aabb()
		box = bb if first else box.merge(bb)
		first = false
	return box
