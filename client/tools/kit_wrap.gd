extends SceneTree
## 由已导入的 GLB 生成包装场景（.tscn）和清单（manifest.json）。包装场景由脚本生成，不手改；同样的 GLB 重跑结果逐字节相同。
## 用法（要先导入过 GLB，build_kits.sh 会处理）：
##   godot --headless --path client/town --script client/tools/kit_wrap.gd -- <套件>/<资产编号> [...]
## 没给参数就处理 assets/kits 下的全部资产。出错非零退出。

var _scan: GDScript


func _init() -> void:
	_scan = load(get_script().resource_path.get_base_dir().path_join("kit_scan.gd"))
	var targets: Array = []
	for a in OS.get_cmdline_user_args():
		var p: PackedStringArray = str(a).split("/")
		if p.size() == 2:
			targets.append({"kit": p[0], "id": p[1]})
	if targets.is_empty():
		targets = _scan.list_assets()
	var bad: int = 0
	for t in targets:
		if not _wrap(str(t["kit"]), str(t["id"])):
			bad += 1
	quit(1 if bad > 0 else 0)


func _wrap(kit: String, id: String) -> bool:
	var gp: String = _scan.glb_path(kit, id)
	var res = load(gp)
	if not (res is PackedScene):
		printerr("FAIL %s/%s：GLB 没导入或打不开（%s）；先 godot --headless --import" % [kit, id, gp])
		return false
	var inst: Node = (res as PackedScene).instantiate()
	var info: Dictionary = _scan.scan(inst)
	inst.free()
	if not info["ok"]:
		printerr("FAIL %s/%s：%s" % [kit, id, "；".join(PackedStringArray(info["problems"]))])
		return false
	var m: Dictionary = info["manifest"]
	if str(m["id"]) != id or str(m["kit"]) != kit:
		printerr("FAIL %s/%s：GLB 里写的编号 / 套件是 %s/%s，和目录对不上" % [kit, id, m["kit"], m["id"]])
		return false
	if not info["problems"].is_empty():
		printerr("FAIL %s/%s：%s" % [kit, id, "；".join(PackedStringArray(info["problems"]))])
		return false
	_write(_scan.tscn_path(kit, id), _scan.render_tscn(kit, id))
	_write(_scan.manifest_path(kit, id), _scan.manifest_text(m))
	print("[wrap] %s/%s：三角形 %d，状态 %s，锚点 %d" % [kit, id, m["stats"]["triangles"], str(m["states"]), (m["anchors"] as Array).size()])
	return true


func _write(path: String, text: String) -> void:
	var f := FileAccess.open(path, FileAccess.WRITE)
	f.store_string(text)  # 不加 BOM、不转换换行：GDScript 的 "\n" 就是 LF
	f.close()
