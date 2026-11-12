class_name TAudio
extends Node
## 音效：确认音、脚步声。浏览器要求用户手势之后才能出声，所以由「进入小镇」按钮触发 init()；
## 被阻止时静音也能继续玩（播放只是没有声音，不报错）。

const CONFIRM_PATH := "res://assets/audio/sfx/confirm.wav"
const STEP_PATH := "res://assets/audio/sfx/footstep.wav"

var enabled: bool = true
var inited: bool = false
var _confirm: AudioStreamPlayer
var _step: AudioStreamPlayer
var _rng := RandomNumberGenerator.new()


func init_after_gesture() -> void:
	if inited:
		return
	inited = true
	_rng.randomize()
	_confirm = _make(CONFIRM_PATH, -4.0)
	_step = _make(STEP_PATH, -8.0)


func _make(path: String, vol_db: float) -> AudioStreamPlayer:
	var p := AudioStreamPlayer.new()
	if ResourceLoader.exists(path):
		var s = load(path)
		if s is AudioStream:
			p.stream = s
	p.volume_db = vol_db
	add_child(p)
	return p


func set_enabled(on: bool) -> void:
	enabled = on
	AudioServer.set_bus_mute(0, not on)


func confirm() -> void:
	if inited and enabled and _confirm != null and _confirm.stream != null:
		_confirm.play()


func step() -> void:
	if inited and enabled and _step != null and _step.stream != null:
		_step.pitch_scale = _rng.randf_range(0.92, 1.08)
		_step.play()
