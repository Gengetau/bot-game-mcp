class_name TNpcLook
extends RefCounted
## NPC 的随身小物件，程序生成（不引入新的第三方素材）：
##   service（茶馆掌柜）：围裙 + 胸前一块小木牌；
##   ambient（广场闲逛者）：软帽（挂在头骨上，跟着头动）；
##   ambient 的「看书」姿态：手里一本书（挂在胸骨上，平时隐藏，由 actor.gd 按 pose 切换显隐）。
## 坐标全在身体骨架的局部空间里（Rogue / Knight 同一副骨架，静止姿势下头顶约 2.18，脸朝 +Z），
## 随 inst 的缩放一起缩到身高。尺寸是量过骨架得来的，见 client/docs/C6.md。

const APRON := Color(0.93, 0.89, 0.80)
const APRON_EDGE := Color(0.80, 0.72, 0.56)
const SIGN_WOOD := Color(0.62, 0.43, 0.24)
const SIGN_TRIM := Color(0.40, 0.27, 0.15)
const HAT := Color(0.46, 0.40, 0.58)
const HAT_BAND := Color(0.80, 0.64, 0.30)
const BOOK_COVER := Color(0.55, 0.22, 0.20)
const BOOK_PAGES := Color(0.94, 0.91, 0.82)

static var _mat: ShaderMaterial = null


static func _material() -> ShaderMaterial:
	if _mat != null:
		return _mat
	var img := Image.create(4, 4, false, Image.FORMAT_RGBA8)
	img.fill(Color(1, 1, 1, 1))
	var m := ShaderMaterial.new()
	m.shader = load("res://assets/shaders/town.gdshader")
	m.set_shader_parameter("pal", ImageTexture.create_from_image(img))
	_mat = m
	return m


static func _mesh_node(b: TMB, node_name: String) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.name = node_name
	mi.mesh = b.to_mesh()
	mi.material_override = _material()
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi


## 把 node 挂到骨架的某根骨头上，位置按「骨架空间里想放的位置」给（desired），换算成相对骨头静止姿势
static func _attach(sk: Skeleton3D, bone: String, node: Node3D, desired: Transform3D, att_name: String) -> void:
	var bi: int = sk.find_bone(bone)
	if bi < 0:
		sk.add_child(node)
		node.transform = desired
		return
	var att := BoneAttachment3D.new()
	att.name = att_name
	att.bone_name = bone
	sk.add_child(att)
	att.add_child(node)
	node.transform = sk.get_bone_global_rest(bi).affine_inverse() * desired


## 给 inst（身体模型，已缩放）穿戴小物件。返回「书」节点（没有就 null），由调用方按姿态显隐。
static func dress(inst: Node3D, role: String) -> Node3D:
	var sks: Array = inst.find_children("*", "Skeleton3D", true, false)
	var sk: Skeleton3D = null
	if not sks.is_empty():
		sk = sks[0] as Skeleton3D
	var host: Node3D = sk if sk != null else inst
	if role == "service":
		_apron(host, sk)
		return null
	_hat(host, sk)
	return _book(host, sk)


static func _apron(host: Node3D, sk: Skeleton3D) -> void:
	var b := TMB.new()
	b.jitter = 0.02
	# 围裙：腰到胸下的一块布，前面略厚；脖子上一条带
	b.box(Vector3(0, 0.80, 0.335), Vector3(0.58, 0.46, 0.05), APRON)
	b.box(Vector3(0, 0.54, 0.34), Vector3(0.62, 0.06, 0.06), APRON_EDGE)
	b.box(Vector3(0, 1.10, 0.32), Vector3(0.36, 0.22, 0.04), APRON)
	b.box(Vector3(-0.17, 1.20, 0.18), Vector3(0.06, 0.06, 0.34), APRON_EDGE)
	b.box(Vector3(0.17, 1.20, 0.18), Vector3(0.06, 0.06, 0.34), APRON_EDGE)
	# 小木牌：挂在围裙上（茶馆的牌子）
	b.box(Vector3(0, 0.88, 0.375), Vector3(0.26, 0.17, 0.035), SIGN_WOOD)
	b.box(Vector3(0, 0.88, 0.395), Vector3(0.18, 0.09, 0.012), SIGN_TRIM)
	var mi := _mesh_node(b, "npc_apron")
	if sk != null:
		_attach(sk, "chest", mi, Transform3D.IDENTITY, "att_apron")
	else:
		host.add_child(mi)


static func _hat(host: Node3D, sk: Skeleton3D) -> void:
	var b := TMB.new()
	b.jitter = 0.02
	b.blob(Vector3(0, 1.98, 0.0), 0.60, HAT, 8, 4, 0.55)
	b.cyl(Vector3(0, 1.90, 0.0), 0.07, 0.70, 0.68, HAT_BAND, 10)
	b.cyl(Vector3(0, 1.84, 0.0), 0.07, 0.74, 0.74, HAT, 10)
	var mi := _mesh_node(b, "npc_hat")
	if sk != null:
		_attach(sk, "head", mi, Transform3D.IDENTITY, "att_hat")
	else:
		host.add_child(mi)


static func _book(host: Node3D, sk: Skeleton3D) -> Node3D:
	var b := TMB.new()
	b.jitter = 0.02
	b.box(Vector3(0, 0, 0), Vector3(0.40, 0.05, 0.30), BOOK_COVER)
	b.box(Vector3(0, 0.035, 0.0), Vector3(0.36, 0.03, 0.27), BOOK_PAGES)
	var mi := _mesh_node(b, "npc_book")
	var desired := Transform3D(Basis(Vector3.RIGHT, deg_to_rad(-55.0)), Vector3(0, 1.0, 0.50))
	if sk != null:
		_attach(sk, "chest", mi, desired, "att_book")
	else:
		host.add_child(mi)
		mi.transform = desired
	mi.visible = false
	return mi
