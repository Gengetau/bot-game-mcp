class_name TChatUtil
extends RefCounted
## 聊天类功能共用的静态函数：把服务端的事件 / 历史条目转成网页模块（TownChatKit）用的消息字典。
## 字段：id（收件人自己的连续序号，messageId）、from、name、kind（只有 human / agent，其余当 human）、text、at、space、spaceName、mine。


static func kind_of(frm: Dictionary) -> String:
	return "agent" if str(frm.get("kind", "")) == "agent" else "human"


static func item(mid: int, frm: Dictionary, text: String, at: float, space: String, space_name: String, self_id: String) -> Dictionary:
	var fid: String = str(frm.get("id", ""))
	return {
		"id": mid,
		"from": fid,
		"name": str(frm.get("name", "")),
		"kind": kind_of(frm),
		"text": text,
		"at": at,
		"space": space,
		"spaceName": space_name,
		"mine": fid != "" and fid == self_id,
	}


## events 帧里的 chat 事件（data.scope == "nearby"）。事件里只有空间编号，没有名字：就在当前空间时补上当前空间名
static func from_event(ev: Dictionary, self_id: String, cur_space: String, cur_space_name: String) -> Dictionary:
	var data = ev.get("data")
	if not (data is Dictionary):
		return {}
	var frm = data.get("from")
	if not (frm is Dictionary) or data.get("messageId") == null:
		return {}
	var sp: String = str(data.get("space", ""))
	return item(int(data["messageId"]), frm, str(data.get("text", "")), float(ev.get("at", 0.0)), sp, cur_space_name if sp == cur_space else "", self_id)


## GET /history 的一条
static func from_history(m: Dictionary, self_id: String) -> Dictionary:
	var frm = m.get("from")
	if not (frm is Dictionary) or m.get("messageId") == null:
		return {}
	return item(int(m["messageId"]), frm, str(m.get("text", "")), float(m.get("at", 0.0)), str(m.get("space", "")), str(m.get("spaceName", "")), self_id)
