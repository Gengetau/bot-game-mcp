extends RefCounted
## E 键「挑最近的」：纯函数，不碰节点、不读网络，所以能在无头 Godot 里单测（client/tests/pick_logic_test.gd）。
## 规则（C6 的 D1）：
##  - 物件的距离 = min（到物件中心的距离，到它每一个使用站位的距离）。站在物件的使用位置上按 E，就该用得上这个物件，
##    不能因为别人（含 NPC）离我比物件中心更近就被抢走；
##  - 人和 NPC 的距离是到它的显示位置；
##  - 范围内严格小于才替换：先比物件后比人，所以等距时物件赢；正好等于范围的不算。

## me：我的位置（x, z）。
## objects：[{id, center: Vector2, anchors: Array[Vector2]（可以空）}]。
## others：[{id, pos: Vector2}]，已经去掉我自己。
## 返回 {"kind": "obj" | "actor" | "none", "id": String}
static func nearest(me: Vector2, objects: Array, others: Array, range_m: float) -> Dictionary:
	var best_kind: String = "none"
	var best_id: String = ""
	var best_d: float = range_m
	for ob in objects:
		var d: float = object_distance(me, ob["center"], ob.get("anchors", []))
		if d < best_d:
			best_d = d
			best_kind = "obj"
			best_id = str(ob["id"])
	for o in others:
		var d2: float = me.distance_to(o["pos"])
		if d2 < best_d:
			best_d = d2
			best_kind = "actor"
			best_id = str(o["id"])
	return {"kind": best_kind, "id": best_id}


static func object_distance(me: Vector2, center: Vector2, anchors: Array) -> float:
	var d: float = me.distance_to(center)
	for a in anchors:
		d = minf(d, me.distance_to(a as Vector2))
	return d
