extends SceneTree
## 生成「开源许可」静态文本：由 export.sh 在导出后调用，写进导出目录（licenses.txt），页面进入面板底部有链接。
## 用法：godot --headless --script client/tools/gen_licenses.gd -- <输出文件路径>
## 内容全部来自引擎自己：Engine.get_license_text()（Godot 的 MIT 许可）、get_copyright_info()（内置第三方组件的版权）、
## get_license_info()（各许可全文）。开头几行是这个页面自己的说明和素材致谢，素材台账见仓库 client/ASSETS.md。


const HEADER := """栖灯镇 · 开源许可与致谢

这个页面用 Godot Engine 构建（https://godotengine.org ，MIT 许可，许可文本和引擎内置的第三方组件的版权与许可见下）。
页面里的美术与音频素材均为 CC0（公共领域），来源、版本、取得日期和处理过程见仓库里的 client/ASSETS.md。CC0 不要求署名，这里照例致谢：

- Kenney（www.kenney.nl）：Fantasy Town Kit（街景模型）、Interface Sounds、Impact Sounds、RPG Audio（操作音效）
- Kay Lousberg（www.kaylousberg.com）：KayKit Adventurers、KayKit Character Animations（居民模型与动作）
- neonarkade：Quaint Town（白天音乐，opengameart.org）
- Zane Little Music：Hush Hamlet（夜晚音乐，opengameart.org）
- Thimras：Park Ambiences（白天环境声、喷泉声，opengameart.org）
- Wolfgang_（Ted Kerr）：Crickets ambient noise loopable（夜晚环境声，opengameart.org）
- PagDev：Fireplace sound loop（室内环境声，opengameart.org）

"""


func _init() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.is_empty():
		printerr("用法：godot --headless --script gen_licenses.gd -- <输出文件>")
		quit(2)
		return
	var out: String = HEADER
	out += "=" .repeat(72) + "\n"
	out += "Godot Engine " + Engine.get_version_info().get("string", "") + "\n"
	out += "=" .repeat(72) + "\n\n"
	out += Engine.get_license_text().strip_edges() + "\n\n"
	out += "=" .repeat(72) + "\n"
	out += "引擎内置的第三方组件（版权声明）\n"
	out += "=" .repeat(72) + "\n\n"
	for comp in Engine.get_copyright_info():
		out += "## " + str(comp.get("name", "")) + "\n"
		for part in comp.get("parts", []):
			out += "  文件：" + ", ".join(PackedStringArray(part.get("files", []))) + "\n"
			for c in part.get("copyright", []):
				out += "  Copyright: " + str(c) + "\n"
			var lic: String = str(part.get("license", ""))
			out += "  License: " + lic + "\n"
		out += "\n"
	out += "=" .repeat(72) + "\n"
	out += "许可全文\n"
	out += "=" .repeat(72) + "\n\n"
	var infos: Dictionary = Engine.get_license_info()
	var names: Array = infos.keys()
	names.sort()
	for n in names:
		out += "-" .repeat(72) + "\n" + str(n) + "\n" + "-" .repeat(72) + "\n\n"
		out += str(infos[n]).strip_edges() + "\n\n"
	var f := FileAccess.open(args[0], FileAccess.WRITE)
	if f == null:
		printerr("写不了 ", args[0])
		quit(1)
		return
	f.store_string(out)
	f.close()
	print("[licenses] ", args[0], " ", out.length(), " 字符，", names.size(), " 种许可")
	quit()
