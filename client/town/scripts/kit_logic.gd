class_name TKitLogic
extends RefCounted
## 资产套件的纯逻辑：节点名 -> 角色、给定状态哪些节点显示、状态名解析。不碰场景树，能在无头 Godot 里单测（client/tests/kit_logic_test.gd）。
## 命名约定（Blender 里就这样命名，见 client/docs/T02a.md）：
##   base*                   任何状态都显示
##   fade*                   任何状态都显示，挡镜头 / 人进屋时淡出（建筑的屋顶、上半墙）
##   state_<状态名>*         只在该状态显示；状态名是 state_ 后面到下一个下划线（或结尾）的小写字母数字
##   anchor_use_<n> / anchor_put_<n> / anchor_fx_<n>   空节点锚点
## 其它名字（分组、子节点）没有角色，显示与否跟着祖先走。

const ROLE_NONE := ""
const ROLE_BASE := "base"
const ROLE_FADE := "fade"
const ROLE_STATE := "state"
const ROLE_ANCHOR := "anchor"
const DEFAULT_STATE := "idle"
## 首批固定的四个状态名；清单里可以有别的，但服务端映射只会给出这四个
const STATES := ["idle", "busy", "done", "fault"]
const ANCHOR_KINDS := ["use", "put", "fx"]


## 节点名的角色：{role, state, kind}。state 只对 state 角色有值，kind 只对 anchor 角色有值（use / put / fx）。
static func classify(node_name: String) -> Dictionary:
	if node_name == "base" or (node_name.begins_with("base") and _plain_tail(node_name.substr(4))):
		return {"role": ROLE_BASE, "state": "", "kind": ""}
	if node_name == "fade" or (node_name.begins_with("fade") and _plain_tail(node_name.substr(4))):
		return {"role": ROLE_FADE, "state": "", "kind": ""}
	if node_name.begins_with("state_"):
		var rest: String = node_name.substr(6)
		var tok: String = rest.get_slice("_", 0)
		if tok != "" and _is_token(tok):
			return {"role": ROLE_STATE, "state": tok, "kind": ""}
		return {"role": ROLE_NONE, "state": "", "kind": ""}
	if node_name.begins_with("anchor_"):
		var parts: PackedStringArray = node_name.split("_")
		if parts.size() == 3 and parts[1] in ANCHOR_KINDS and parts[2].is_valid_int():
			return {"role": ROLE_ANCHOR, "state": "", "kind": parts[1]}
	return {"role": ROLE_NONE, "state": "", "kind": ""}


## base / fade 后面只许跟下划线开头的小写字母数字（"base_top"、"base2"），不许 "baseball" 这种误中。
static func _plain_tail(tail: String) -> bool:
	if tail == "":
		return true
	return tail[0] == "_" or tail[0].is_valid_int()


static func _is_token(s: String) -> bool:
	for i in range(s.length()):
		var c: int = s.unicode_at(i)
		if not ((c >= 97 and c <= 122) or (c >= 48 and c <= 57)):
			return false
	return true


## 一组节点名里出现的状态（去重、保持首次出现的顺序）。
static func states_of(names: Array) -> Array:
	var out: Array = []
	for n in names:
		var c: Dictionary = classify(str(n))
		if c["role"] == ROLE_STATE and not (c["state"] in out):
			out.append(c["state"])
	return out


## 一组节点名在给定状态下谁显示：{名字: bool}，只含 base / fade / state 角色的节点（其它没有角色的不在里面）。
static func visibility(names: Array, state: String) -> Dictionary:
	var out: Dictionary = {}
	for n in names:
		var c: Dictionary = classify(str(n))
		match c["role"]:
			ROLE_BASE, ROLE_FADE:
				out[str(n)] = true
			ROLE_STATE:
				out[str(n)] = c["state"] == state
	return out


## 解析状态名：认识就原样，不认识退回 idle。
static func resolve_state(state: String, known: Array) -> String:
	return state if state in known else DEFAULT_STATE


## 动画名 -> {state, loop}：`state_busy` 是只播一次；Godot 导入时 Blender 里的 `state_busy-loop` 会变成循环的 `state_busy`，
## 所以这里的 loop 要由调用方从 Animation.loop_mode 读出来；这个函数只管名字是不是某个状态的动画。
static func anim_state(anim_name: String) -> String:
	if not anim_name.begins_with("state_"):
		return ""
	return anim_name.substr(6)
