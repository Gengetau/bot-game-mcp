# 用 Godot 4.7.2 检查 resident.glb 的导入结果（不属于游戏工程，只是素材验收脚本）。
# 用法见 client/art_source/README.md「验收」一节。
# 运行：godot --headless --path <含 resident.glb 的临时工程> --script check_resident.gd
extends SceneTree

func _init():
	var failed := false
	var root = (load("res://resident.glb") as PackedScene).instantiate()
	get_root().add_child(root)
	await process_frame
	var ap: AnimationPlayer = root.find_child("AnimationPlayer", true, false)
	var sk: Skeleton3D = root.find_child("Skeleton3D", true, false)
	print("AnimationPlayer=", ap != null, " Skeleton3D=", sk != null, " bones=", sk.get_bone_count())
	for n in ["idle", "walk"]:
		var ok = ap.has_animation(n)
		print("动作 ", n, ": ", ok)
		if ok:
			print("  长度(秒)=", ap.get_animation(n).length, " 轨道数=", ap.get_animation(n).get_track_count())
		failed = failed or not ok
	print("动作列表=", ap.get_animation_list())
	var lo = Vector3(1e9, 1e9, 1e9)
	var hi = Vector3(-1e9, -1e9, -1e9)
	for m in root.find_children("*", "MeshInstance3D", true, false):
		var b: AABB = m.global_transform * m.get_aabb()
		lo = lo.min(b.position)
		hi = hi.max(b.end)
	var h = hi.y - lo.y
	print("包围盒 min=", lo, " max=", hi, " 高度=", h)
	failed = failed or abs(h - 1.7) > 0.1 or abs(lo.y) > 0.05
	# walk 里骨骼确实在动
	ap.get_animation("walk").loop_mode = Animation.LOOP_LINEAR
	ap.play("walk")
	var li = sk.find_bone("leg-left")
	ap.seek(0.1, true)
	var r1 = sk.get_bone_pose_rotation(li)
	ap.seek(0.3, true)
	var r2 = sk.get_bone_pose_rotation(li)
	print("walk 中 leg-left 旋转 0.1s=", r1, " 0.3s=", r2)
	failed = failed or r1.is_equal_approx(r2)
	print("RESULT ", "FAIL" if failed else "PASS")
	quit(1 if failed else 0)
