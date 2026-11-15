extends RefCounted
## 场景里不碰节点的小判断：纯函数，client/tests/scene_logic_test.gd 单测。

## 遮挡淡出（world.update_view）用的「头」：只放居民。
## update_view 的规则是「只要有一个头落在某栋楼的外框里，那栋楼的上层就整个隐藏」，意思是「有人在楼里就掀屋顶」。
## NPC 是固定站在楼里的（掌柜永远在茶馆柜台后面，闲逛者读书时站在书屋书架旁），把它们的头放进来，
## 茶馆屋顶就会对所有玩家永远隐藏，书屋屋顶也会随闲逛者走进走出。NPC 要是想被楼挡住淡出，另走线段遮挡，不参与「在楼里」。
## actors：角色表（id -> TActor，含 kind == "npc" 的 NPC）。返回 Array[Vector3]。
static func occluder_heads(actors: Dictionary) -> Array:
	var heads: Array = []
	for id in actors:
		var a = actors[id]
		if a.kind == "npc":
			continue
		heads.append(Vector3(a.disp.x, 1.6, a.disp.y))
	return heads
