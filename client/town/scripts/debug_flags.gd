extends RefCounted
## 调试开关的判定：纯函数，可以无头单测（client/tests/pick_logic_test.gd 里一并测）。
## 「隐藏 NPC」只在调试模式（?debug=1）下认：不带 ?debug=1 的页面，不管页面全局量设没设，都照常显示 NPC。

static func hide_npcs(debug_on: bool, flag_set: bool) -> bool:
	return debug_on and flag_set
