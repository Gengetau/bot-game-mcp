class_name TClock
extends RefCounted
## 服务器时间估计：server_now = 本机单调时钟 + offset。
## 用 ping/pong 的往返估计偏差，取最近几次里往返最短的一次（最不受网络抖动影响）。

var offset_ms: float = 0.0
var has_sync: bool = false
var rtt_ms: float = 0.0
var _samples: Array = []  # [rtt, offset]


static func ticks_ms() -> float:
	return float(Time.get_ticks_usec()) / 1000.0


func server_now() -> float:
	return ticks_ms() + offset_ms


## 没有 ping 样本之前的粗略估计（假设单程延迟为 0）。
func rough(server_time: float) -> void:
	if _samples.is_empty():
		offset_ms = server_time - ticks_ms()
		has_sync = true


func sample(sent_ticks: float, recv_ticks: float, server_time: float) -> void:
	var rtt: float = recv_ticks - sent_ticks
	if rtt < 0.0:
		return
	var off: float = server_time - (sent_ticks + recv_ticks) * 0.5
	_samples.append([rtt, off])
	if _samples.size() > 8:
		_samples.pop_front()
	var best: Array = _samples[0]
	for s in _samples:
		if float(s[0]) < float(best[0]):
			best = s
	offset_ms = float(best[1])
	rtt_ms = float(best[0])
	has_sync = true


func reset() -> void:
	_samples.clear()
	has_sync = false
