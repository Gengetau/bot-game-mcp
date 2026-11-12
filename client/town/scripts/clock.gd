class_name TClock
extends RefCounted
## 服务器时间估计：server_now = 本机单调时钟 + offset。
## 用 ping/pong 的往返估计偏差，取最近几次里往返最短的一次（最不受网络抖动影响）。

var offset_ms: float = 0.0
var has_sync: bool = false
var rtt_ms: float = 0.0
var _samples: Array = []  # [rtt, offset, 采集时刻]

## 样本超过这个年龄就不可信（休眠、换网络之后偏移可能已经变了）
const MAX_AGE_MS := 25000.0
## 新样本的偏移和当前偏移差超过这个值，说明旧样本整体过时，丢掉重来
const JUMP_MS := 500.0


static func ticks_ms() -> float:
	return float(Time.get_ticks_usec()) / 1000.0


func server_now() -> float:
	return ticks_ms() + offset_ms


## 没有 ping 样本之前的粗略估计（假设单程延迟为 0）。
func rough(server_time: float) -> void:
	_prune(ticks_ms())
	if _samples.is_empty():
		offset_ms = server_time - ticks_ms()
		has_sync = true


func sample(sent_ticks: float, recv_ticks: float, server_time: float) -> void:
	var rtt: float = recv_ticks - sent_ticks
	if rtt < 0.0:
		return
	var off: float = server_time - (sent_ticks + recv_ticks) * 0.5
	_prune(recv_ticks)
	if not _samples.is_empty() and absf(off - offset_ms) > JUMP_MS:
		_samples.clear()
	_samples.append([rtt, off, recv_ticks])
	if _samples.size() > 8:
		_samples.pop_front()
	var best: Array = _samples[0]
	for s in _samples:
		if float(s[0]) < float(best[0]):
			best = s
	offset_ms = float(best[1])
	rtt_ms = float(best[0])
	has_sync = true


func _prune(now_ticks: float) -> void:
	var keep: Array = []
	for s in _samples:
		if now_ticks - float(s[2]) <= MAX_AGE_MS:
			keep.append(s)
	_samples = keep


func reset() -> void:
	_samples.clear()
	has_sync = false
