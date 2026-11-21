extends RefCounted
## 「这次 you_arrived 是哪一趟路走完了」：纯逻辑，不碰节点、不读网络。main.gd 持有一个实例；单测在 client/tests/nav_route_test.gd。
##
## 为什么要分辨：服务器按「应到时刻」结算到达，但结算这个动作要等调度器的下一拍（每秒一次），或者等这位居民的下一条命令
## 顺手结清（navigate 会先把旧路线结算到现在）。场景快照和画面按折线和时间现算，人到点就停了。所以从「画面上人已经停下」
## 到「这一趟的 you_arrived 发出来」最多隔一秒。这一秒里又点了别处（比如点远处的 NPC），上一趟路的 you_arrived 就会落在
## 新的 navigate 之后；等到达的功能（npc.gd、people.gd）要是把它当成新这一趟的结局，「在这里点的」记号就被白白用掉，
## 真到了反而不开菜单（端到端 83.1 的间歇失败就是它）。
##
## 判据只比服务器给的两个时刻，不看本机时钟：
##   上一趟路的到达时刻 <= 服务器处理新 navigate 的时刻 < 新路线第一段的 arriveAt <= 新路线自己的到达时刻
## 所以事件的 at 小于「本页最近一次发出、并被接受的 navigate」的 arriveAt，就是它出发之前的路（prior）。
## 新 navigate 的回答还没回来时判断不了：main 先把 you_arrived 扣着（hold），回答到了再按顺序放出来。
## 最近一次导航意图不是被接受的 navigate（停下、方向键、被拒、已经在旁边）时没有可比的时刻：一律不算 prior，照旧处理。

var _gen: int = -1  # 最近一次被服务器接受的 navigate 是第几次导航意图（main 的 nav_generation）
var _arrive_at: float = 0.0  # 它第一段的 arriveAt（服务器毫秒）
var _held: Array = []


## 换一段会话：之前的回答和扣着的事件都不算数
func reset() -> void:
	_gen = -1
	_arrive_at = 0.0
	_held.clear()


## 服务器接受了第 gen 次导航意图的 navigate（回答里有 navigation）
func accepted(gen: int, arrive_at: float) -> void:
	if gen >= _gen:
		_gen = gen
		_arrive_at = arrive_at


## 有 navigate 还在路上时到的 you_arrived：先扣着
func hold(ev: Dictionary) -> void:
	_held.append(ev)


## 取走扣着的事件（按到的先后）
func take_held() -> Array:
	var out: Array = _held
	_held = []
	return out


func held_count() -> int:
	return _held.size()


## 这次到达是不是「现在这一趟」出发之前的路。nav_gen：main 现在的导航代号；ev_at：事件的 at（没有就传 0，不算 prior）
func is_prior(nav_gen: int, ev_at: float) -> bool:
	return prior(_gen, _arrive_at, nav_gen, ev_at)


static func prior(accept_gen: int, arrive_at: float, nav_gen: int, ev_at: float) -> bool:
	if accept_gen != nav_gen:
		return false  # 最近一次导航意图不是这条被接受的 navigate（之后又停下 / 按了方向键 / 新的 navigate 还没被接受）
	if ev_at <= 0.0 or arrive_at <= 0.0:
		return false  # 没有可比的时刻
	return ev_at < arrive_at
