class_name TManifest
extends RefCounted
## 功能清单。新增模块只许加一行（C1a 已把九个都写好，之后不再编辑）。按字母序，一行一个；
## 用 preload 路径而不是 class_name（避免全局类缓存问题）。
const LIST: Array = [
	preload("res://scripts/features/activity.gd"),
	preload("res://scripts/features/bubbles.gd"),
	preload("res://scripts/features/game.gd"),
	preload("res://scripts/features/mail.gd"),
	preload("res://scripts/features/nearby.gd"),
	preload("res://scripts/features/npc.gd"),
	preload("res://scripts/features/people.gd"),
	preload("res://scripts/features/session.gd"),
	preload("res://scripts/features/town.gd"),
]
