extends SceneTree
## 从 KayKit Adventurers 2.0 的角色 glb 和 Character Animations 1.1 的动画 glb 里，抽出栖灯镇居民用的资源：
##  1) 每个底模一个 .scn：只留身体各部件（躯干、头、四肢），不要披风、帽子、头盔、箭袋、熊头帽；网格去掉材质（运行时按外观套贴图），
##     不带那张 1024x1024 的内嵌贴图。
##  2) 一个 residents_anims.res（AnimationLibrary）：只留用到的几个动作，并设好循环。
## 运行方式见 client/art_source/build_residents.sh（在临时工程里导入 glb 后调用本脚本）。
## 用法：godot --headless --path <临时工程> --script res://build_residents.gd -- out=<输出目录>

const BASES := ["Rogue", "Ranger", "Mage", "Knight"]
const KEEP_SUFFIX := ["_ArmLeft", "_ArmRight", "_Body", "_Head", "_LegLeft", "_LegRight"]
# 动作库里的名字 -> [来源 glb, 原名, 是否循环]
const ANIMS := {
	"idle": ["Rig_Medium_General", "Idle_A", true],
	"idle2": ["Rig_Medium_General", "Idle_B", true],
	"walk": ["Rig_Medium_MovementBasic", "Walking_A", true],
	"sit_down": ["Rig_Medium_Simulation", "Sit_Chair_Down", false],
	"sit_idle": ["Rig_Medium_Simulation", "Sit_Chair_Idle", true],
	"stand_up": ["Rig_Medium_Simulation", "Sit_Chair_StandUp", false],
	"wave": ["Rig_Medium_Simulation", "Waving", false],
	"interact": ["Rig_Medium_General", "Interact", false],
	"use_item": ["Rig_Medium_General", "Use_Item", false],
}


func _arg(k: String, d: String) -> String:
	for a in OS.get_cmdline_user_args():
		if a.begins_with(k + "="):
			return a.substr(k.length() + 1)
	return d


func _own(n: Node, root: Node) -> void:
	for c in n.get_children():
		c.owner = root
		_own(c, root)


func _init() -> void:
	var out: String = _arg("out", "")
	if out == "":
		push_error("缺少 out=")
		quit(1)
		return
	for b in BASES:
		var ps := load("res://src/" + b + ".glb") as PackedScene
		var root := ps.instantiate() as Node3D
		var skel: Skeleton3D = root.find_child("Skeleton3D", true, false)
		var drop: Array = []
		for c in skel.get_children():
			var keep := false
			for s in KEEP_SUFFIX:
				if c.name.ends_with(s):
					keep = true
			if not keep:
				drop.append(c)
		for c in drop:
			skel.remove_child(c)
			c.free()
		for c in skel.get_children():
			var mi := c as MeshInstance3D
			var m: Mesh = mi.mesh.duplicate()
			for i in range(m.get_surface_count()):
				m.surface_set_material(i, null)
			mi.mesh = m
			mi.material_override = null
			mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
		root.name = b
		_own(root, root)
		var pk := PackedScene.new()
		pk.pack(root)
		var path: String = out + "/body_" + b.to_lower() + ".scn"
		print("save ", path, " ", ResourceSaver.save(pk, path, ResourceSaver.FLAG_COMPRESS))
		root.free()

	var lib := AnimationLibrary.new()
	var cache: Dictionary = {}
	for key in ANIMS:
		var spec: Array = ANIMS[key]
		var src: String = spec[0]
		if not cache.has(src):
			cache[src] = (load("res://src/" + src + ".glb") as PackedScene).instantiate()
		var ap: AnimationPlayer = (cache[src] as Node).find_child("AnimationPlayer", true, false)
		var a: Animation = ap.get_animation(spec[1]).duplicate()
		a.loop_mode = Animation.LOOP_LINEAR if bool(spec[2]) else Animation.LOOP_NONE
		# 去掉持物点等不影响居民的轨道（身体骨骼之外的），以及全程不变的位置轨道
		var i: int = a.get_track_count() - 1
		while i >= 0:
			var p: String = str(a.track_get_path(i))
			if p.contains("handslot") or p.contains("Handslot") or p.contains("Weapon") or p.contains("weapon"):
				a.remove_track(i)
			i -= 1
		lib.add_animation(key, a)
		print("anim ", key, " ", a.length, " tracks=", a.get_track_count())
	for k in cache:
		(cache[k] as Node).free()
	print("save anims ", ResourceSaver.save(lib, out + "/residents_anims.res", ResourceSaver.FLAG_COMPRESS))
	quit()
