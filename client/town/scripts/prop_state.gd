class_name TPropState
extends RefCounted
## 「服务端数据 -> 状态名」的映射，纯函数（client/tests/kit_feature_test.gd 单测）。资产只声明有哪些状态，什么时候进哪个状态由服务端的数据说了算。
##
## 服务端现在给得出的只有「有没有人在用」：/me 的 here.objects[] 每项是 {id, type, label, action, active, near}，
## active 是 null（没人用）或一份共同活动（status 只会是 open 报名中 / running 进行中，互相不同的两条都说明这件东西被占着：
## 服务端对 open 和 running 的物件都拒绝新的开始，见 interact.ts 的 busy）。所以真实数据只驱动 idle 和 busy。
## done / fault 现在没有数据来源，只能用调试钩子（window.__town.setPropState）切出来看；服务端以后给了字段，在这里加一条映射。

const IDLE := "idle"
const BUSY := "busy"


## 一件物件（here.objects[] 里的一项）的状态名。
static func state_for_object(o: Variant) -> String:
	if o is Dictionary and (o as Dictionary).get("active") is Dictionary:
		return BUSY
	return IDLE


## 一批物件 -> {物件编号: 状态名}，只含 objs 里出现的编号。objs 不是数组就当空。
static func states_by_id(objs: Variant) -> Dictionary:
	var out: Dictionary = {}
	if objs is Array:
		for o in objs:
			if o is Dictionary and (o as Dictionary).has("id"):
				out[str((o as Dictionary)["id"])] = state_for_object(o)
	return out


## 某个编号的状态名：objs 里没有它（不在我所在的空间，或者数据还没来）按 idle。
static func state_of(objs: Variant, oid: String) -> String:
	return str(states_by_id(objs).get(oid, IDLE))
