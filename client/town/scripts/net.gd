class_name TNet
extends RefCounted
## WebSocket 连接（/town/ws）。WebSocketPeer 必须每帧 poll，由 main 调用。

signal opened()
signal message(msg: Dictionary)
signal closed(code: int, reason: String)

var ws: WebSocketPeer = null
var state: String = "idle"  # idle | connecting | open


func is_open() -> bool:
	return ws != null and state == "open"


func connect_to(url: String) -> int:
	close_now()
	ws = WebSocketPeer.new()
	ws.inbound_buffer_size = 262144
	ws.outbound_buffer_size = 16384
	ws.max_queued_packets = 512
	var err: int = ws.connect_to_url(url)
	if err != OK:
		ws = null
		state = "idle"
		return err
	state = "connecting"
	return OK


func send(d: Dictionary) -> void:
	if is_open():
		ws.send_text(JSON.stringify(d))


func close_now() -> void:
	if ws != null:
		ws.close(1000, "bye")
	ws = null
	state = "idle"


func poll() -> void:
	if ws == null:
		return
	ws.poll()
	var s: int = ws.get_ready_state()
	if s == WebSocketPeer.STATE_OPEN:
		if state == "connecting":
			state = "open"
			opened.emit()
		while ws != null and ws.get_available_packet_count() > 0:
			var pkt: PackedByteArray = ws.get_packet()
			var parsed = JSON.parse_string(pkt.get_string_from_utf8())
			if parsed is Dictionary:
				message.emit(parsed)
	elif s == WebSocketPeer.STATE_CLOSED:
		var code: int = ws.get_close_code()
		var reason: String = ws.get_close_reason()
		ws = null
		state = "idle"
		closed.emit(code, reason)
