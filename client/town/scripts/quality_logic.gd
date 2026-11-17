extends RefCounted
## 清晰度策略的纯逻辑：三个档位（auto / high / low）、动态分辨率的升降和防抖、像素上限、调试覆盖。
## 不读场景、不取时间（时间靠累加每帧的 dt）、不用随机数，所以能在无头 Godot 里单测（client/tests/quality_logic_test.gd）。
## main.gd 只负责每帧喂 dt 和像素数、把结果写给视口的 scaling_3d_scale 和阴影开关。

const MODE_AUTO := "auto"
const MODE_HIGH := "high"
const MODE_LOW := "low"

## 画面像素上限：超过 250 万像素时按比例封顶（高分屏手机），三个档位都受它约束。
const PIXEL_CAP := 2500000.0
## auto 的下限：正常设备 0.5（再低字就糊得看不清了）；软件渲染（无头浏览器的端到端）保持 0.3，免得端到端变慢。
const FLOOR_NORMAL := 0.5
const FLOOR_SOFT := 0.3
## low 档的固定比例：0.6 约 36% 的像素，比以前的 0.3 下限清楚得多，又比满分辨率省一半多。
const LOW_SCALE := 0.6

## 检查周期 1.5 秒：和旧规则一样，平均帧率每过一个周期看一次。
const CHECK_S := 1.5
## 平滑帧率的时间常数约 1.4 秒（衰减系数 0.7 每秒）。
const FPS_SMOOTH := 0.7
## 降：平均帧率低于 24 降一档（乘 0.85）；单帧超过 0.35 秒立刻降一档（乘 0.7）。数值沿用旧规则。
const DOWN_FPS := 24.0
const DOWN_MUL := 0.85
const HITCH_S := 0.35
const HITCH_MUL := 0.7
## 升：每次乘 1.08（旧规则同），不再用固定的 52 帧做门槛。
const UP_MUL := 1.08
## 这台设备能到的帧率的估计：平滑帧率的衰减最大值，下限 30。锁 30 帧的手机估计就是 30，平均帧率达到估计的 90% 就算跑满了。
## 衰减时间常数 45 秒：设备换了一种负载（比如从 60 帧的场景到持续 45 帧）后，估计能在一两分钟内跟下来，不至于永远等不到「跑满」。
const PEAK_MIN := 30.0
const PEAK_TAU_S := 45.0
const UP_RATIO := 0.9
## 升上去之后 6 秒内又触发降档，说明刚升的那一档这台设备撑不住：6 秒够平滑帧率（约 1.4 秒时间常数）反应过来，又不会把无关的卡顿算进去。
const FLICKER_S := 6.0
## 撑不住的那一档记成暂时的上限，60 秒后再试，每次失败翻倍，封顶 5 分钟：不会一直试，也不会永远不试。
const BACKOFF_MIN_S := 60.0
const BACKOFF_MAX_S := 300.0
## 降了没用就不降：从开始降的那一档算起，比例降到 73% 以下（像素少了一半）帧率却没涨 15%，说明瓶颈不在像素上
## （显卡被别的程序占着、CPU 忙、绘制次数多），再降只会白白变糊。这时回到开始降之前的那一档，120 秒内不再降，每次再犯翻倍，封顶 10 分钟。
## 实测依据：主人的电脑上动态壁纸占着核显，1.0 和 0.5 的帧率一样（都是 8 帧上下），旧规则会一路降到底。
const INSENS_DROP := 0.73
## 要求的涨幅跟着少掉的像素走：完全由像素决定的设备，帧率该涨到 (原比例 / 现比例)² 倍；这里只要求拿到其中的两成
## （降到 73% 时是 1.18 倍）。帧率和比例成反比的「半敏感」设备（1.38 倍）也算有用。
const INSENS_SHARE := 0.2
## 到了下限也要看一眼，但这一轮至少降了一成才看（降得太少，量不出差别）
const INSENS_MIN_DROP := 0.9
const HOLD_MIN_S := 120.0
const HOLD_MAX_S := 600.0
## 调试覆盖的范围
const DEBUG_MIN := 0.3
const DEBUG_MAX := 1.0

var mode: String = MODE_AUTO
var soft: bool = false  # 软件渲染（网页层判断后告诉 main）
var debug_scale: float = -1.0  # >0：?debug=1&scale= 固定的渲染比例

var drs: float = 1.0  # auto 的动态比例
var fps_avg: float = 30.0  # 初值取 30 而不是 60：锁 30 帧的设备不用先花几十秒把虚高的估计衰减下来
var fps_peak: float = PEAK_MIN
var t: float = 0.0  # 累计时间（秒）

var _check_t: float = 0.0
var _up_armed: bool = false  # 上一次检查已经满足升档条件：连续两次满足才升（「稳定了一个检查周期」）
var _ceil: float = 1.0  # 暂时的上限，没有时为 1
var _ceil_until: float = 0.0
var _backoff_s: float = BACKOFF_MIN_S
var _probing: bool = false  # 上限到期后正在试探：试成功了就把退避清零
var _up_from: float = 0.0  # 最近一次升档之前的比例，<=0 表示没有待观察的升档
var _up_at: float = -1.0e9
var _probe_from: float = 0.0  # 这一轮下降开始之前的比例，<=0 表示没有在下降
var _probe_fps: float = 0.0  # 当时的帧率（开始降之前那个检查周期里实数出来的，不用平滑值：平滑值有滞后，会把刚启动时的虚高算进去）
var _win_n: int = 0  # 这个检查周期里过了几帧
var _last_win_fps: float = 0.0  # 上一个完整检查周期的帧率
var _hold_until: float = 0.0  # 在这之前不再降档（降了没用）
var _hold_s: float = HOLD_MIN_S
var holds: int = 0  # 判定过几次「降了没用」，单测和诊断用
var changes: int = 0  # 动态比例变过几次（升降都算），单测和诊断用


static func pixel_cap(px: float) -> float:
	return 1.0 if px <= PIXEL_CAP else sqrt(PIXEL_CAP / px)


static func valid_mode(m: String) -> bool:
	return m == MODE_AUTO or m == MODE_HIGH or m == MODE_LOW


func set_mode(m: String) -> bool:
	if not valid_mode(m):
		return false
	if m != mode:
		_reset_probe()  # 切走再切回来，隔了多久不知道：不拿切走之前的帧率当「降了没用」的基准
	mode = m
	return true


func set_debug_scale(s: float) -> void:
	debug_scale = clampf(s, DEBUG_MIN, DEBUG_MAX) if s > 0.0 else -1.0
	_reset_probe()


func floor_scale() -> float:
	return FLOOR_SOFT if soft else FLOOR_NORMAL


## 暂时的上限（没有时为 1）
func ceil_scale() -> float:
	return _ceil


## 现在是不是处在「降了没用，先不降」的那段时间里（诊断用）
func holding() -> bool:
	return t < _hold_until


## 实时阴影开不开。auto：触屏和软件渲染关，其余开。
func shadows(touch: bool) -> bool:
	if mode == MODE_HIGH:
		return true
	if mode == MODE_LOW:
		return false
	return not touch and not soft


## 这一帧该用的渲染比例。debug_scale 优先（仍受像素上限约束）；high 取像素上限；low 固定 0.6；auto 取动态比例。
func render_scale(px: float) -> float:
	var cap: float = pixel_cap(px)
	if debug_scale > 0.0:
		return minf(cap, debug_scale)
	if mode == MODE_HIGH:
		return cap
	if mode == MODE_LOW:
		return minf(cap, LOW_SCALE)
	return minf(cap, drs)


## 渲染比例是不是被像素上限压低了（诊断里看得出来）
func is_capped(px: float) -> bool:
	var cap: float = pixel_cap(px)
	if cap >= 1.0:
		return false
	if debug_scale > 0.0:
		return debug_scale > cap
	if mode == MODE_HIGH:
		return true
	if mode == MODE_LOW:
		return LOW_SCALE > cap
	return drs >= cap - 0.0005  # auto 的动态比例会被压到上限上（见 frame），贴着上限就算被它压着


## 每帧调用。dt 是这一帧的间隔（秒）；px 是画面像素数（用来知道像素上限，升档不超过上限）。
## 平滑帧率和能力估计在所有档位下都更新（诊断用），只有 auto 且没有调试覆盖时才调整动态比例。
func frame(dt: float, px: float = 0.0) -> void:
	if dt <= 0.0:
		return
	t += dt
	fps_avg = lerpf(fps_avg, 1.0 / maxf(dt, 0.0005), 1.0 - exp(-dt * FPS_SMOOTH))
	fps_peak = maxf(PEAK_MIN, maxf(fps_avg, fps_peak * exp(-dt / PEAK_TAU_S)))
	if mode != MODE_AUTO or debug_scale > 0.0:
		return
	var fl: float = floor_scale()
	# 像素上限以上的那一截本来就没有生效（实际渲染比例是 min(上限, drs)）：先压到上限上。
	# 不压的话，高分屏上头几次「降档」一个像素都没少，帧率自然不涨，会被当成「降了没用」，从此降不到上限以下。
	if px > 0.0:
		var capf: float = maxf(fl, pixel_cap(px))
		drs = minf(drs, capf)
		if _probe_from > capf:
			_probe_from = capf
	# 暂时上限到期：放开，开始试探
	if _ceil < 1.0 and t >= _ceil_until:
		_ceil = 1.0
		_probing = true
	# 升档之后稳住了（没被打回来）：清掉退避记录
	if _up_from > 0.0 and t - _up_at > FLICKER_S:
		_up_from = 0.0
		if _probing:
			_probing = false
			_backoff_s = BACKOFF_MIN_S
	var held: bool = t < _hold_until
	if dt > HITCH_S and drs > fl and not held:
		# 基准用上一个完整检查周期的帧率；还没有的话（刚启动就卡）用这一帧自己的：偏低，只会让判定偏向「降了有用」，也就是原来的做法
		_probe_begin(_last_win_fps if _last_win_fps > 0.0 else 1.0 / dt)
		_down(maxf(fl, drs * HITCH_MUL))  # 一帧就超过 0.35 秒：马上降一档，不等平均值
		_check_t = 0.0
		_win_n = 0
		return
	_check_t += dt
	_win_n += 1
	if _check_t <= CHECK_S:
		return
	var win_fps: float = float(_win_n) / _check_t  # 这个检查周期里实数出来的帧率
	_last_win_fps = win_fps
	_check_t = 0.0
	_win_n = 0
	if fps_avg < DOWN_FPS:
		if held:
			return
		# 已经降了不少（或者到底了）还是慢：看看降下来有没有换到帧率
		if _probe_from > 0.0 and (drs <= _probe_from * INSENS_DROP or drs <= fl + 0.001):
			# 软件渲染不做这个判定：那里画得慢就是像素多，照旧一路降到 0.3（端到端跑在软件渲染上，不想让它变慢）
			if drs <= _probe_from * INSENS_MIN_DROP and not soft:
				var r: float = _probe_from / drs
				if win_fps < _probe_fps * (1.0 + INSENS_SHARE * (r * r - 1.0)):
					_give_up_dropping()
					return
				_hold_s = HOLD_MIN_S  # 降下来是有用的
			_probe_from = 0.0  # 从这里重新算
		if drs > fl:
			_probe_begin(win_fps)
			_down(maxf(fl, drs * DOWN_MUL))
		return
	_probe_from = 0.0  # 帧率够了：这一轮下降结束
	var limit: float = minf(_ceil, maxf(fl, pixel_cap(px) if px > 0.0 else 1.0))
	if fps_avg >= fps_peak * UP_RATIO and drs < limit - 0.001:
		if _up_armed:
			_up_armed = false
			_up_from = drs
			_up_at = t
			drs = minf(limit, drs * UP_MUL)
			changes += 1
		else:
			_up_armed = true
	else:
		_up_armed = false


## 丢掉正在进行的探测和升档观察（档位或调试覆盖变了）。暂时上限和「不再降」的时段按时间算，照旧有效。
func _reset_probe() -> void:
	_probe_from = 0.0
	_probe_fps = 0.0
	_check_t = 0.0
	_win_n = 0
	_last_win_fps = 0.0
	_up_armed = false
	_up_from = 0.0


func _probe_begin(fps_now: float) -> void:
	if _probe_from <= 0.0:
		_probe_from = drs
		_probe_fps = fps_now


## 降了没用：回到开始降之前的那一档，一段时间内不再降
func _give_up_dropping() -> void:
	drs = minf(_probe_from, _ceil)
	_probe_from = 0.0
	_hold_until = t + _hold_s
	_hold_s = minf(HOLD_MAX_S, _hold_s * 2.0)
	_up_armed = false
	_up_from = 0.0
	holds += 1
	changes += 1


func _down(new_scale: float) -> void:
	_up_armed = false
	# 刚升上去不久就又降了：升之前那一档记成暂时的上限，过一段时间再试
	if _up_from > 0.0 and t - _up_at <= FLICKER_S:
		_ceil = _up_from
		_ceil_until = t + _backoff_s
		_backoff_s = minf(BACKOFF_MAX_S, _backoff_s * 2.0)
		_probing = false
		_up_from = 0.0
	drs = new_scale
	changes += 1
