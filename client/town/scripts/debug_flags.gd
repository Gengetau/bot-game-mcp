extends RefCounted
## 调试开关的判定：纯函数，可以无头单测（client/tests/pick_logic_test.gd、kit_feature_test.gd 里一并测）。
## 所有开关都只在调试模式（?debug=1）下认：不带 ?debug=1 的页面，不管页面全局量、地址栏参数设没设，都照常。

## 「隐藏 NPC」
static func hide_npcs(debug_on: bool, flag_set: bool) -> bool:
	return debug_on and flag_set


## 地址栏 ?debug=1&props=sample：把灶台和公共厨房指到占位样件（assets/kits/sample/）。bridge.gd 在启动时按地址栏设好，
## art.gd 读表时叠上去。线上的外观表不指向样件；不带 ?debug=1 时这里一定是空串。
static var props_mode: String = ""

const SAMPLE_PROPS := {
	"prop.stove": {"scene": "res://assets/kits/sample/station_sample/station_sample.tscn"},
	"building.kitchen": {"scene": "res://assets/kits/sample/building_sample/building_sample.tscn"},
}


## 从地址栏查询串（带不带开头的 ? 都行）取 props 的值；没开调试一律返回空串。
static func props_mode_of(debug_on: bool, search: String) -> String:
	if not debug_on:
		return ""
	for kv in search.trim_prefix("?").split("&"):
		if kv.begins_with("props="):
			return kv.substr(6)
	return ""


## ?debug=1&props=kitchen：把灶台指到厨房的标准工位样件（assets/kits/kitchen/stove_station/，T02b）。样件在实际镜头下过关、
## 主人点头之前不进默认的外观表，只能这样看。文件不存在时 art.gd 的 scene_path 会当没有这个条目。
const KITCHEN_PROPS := {
	"prop.stove": {"scene": "res://assets/kits/kitchen/stove_station/stove_station.tscn"},
}

const PROP_MODES := {"sample": SAMPLE_PROPS, "kitchen": KITCHEN_PROPS}


## 把调试用的外观条目叠到 kinds 上（原地改），返回被覆盖的键。mode 不认识就什么都不做。
static func apply_props(kinds: Dictionary, mode: String) -> Array:
	var out: Array = []
	var table: Dictionary = PROP_MODES.get(mode, {})
	for k in table:
		kinds[k] = (table[k] as Dictionary).duplicate(true)
		out.append(k)
	return out
