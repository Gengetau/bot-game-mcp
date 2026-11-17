extends SceneTree
## 清晰度策略（quality_logic.gd）的单测：三个档位、动态分辨率的升降、防抖、下限、像素上限、调试覆盖。无头 Godot 直接跑。

const L := preload("res://scripts/quality_logic.gd")
const PX := 1300000.0  # 1440x900，没触到像素上限

var _fails: int = 0
var _checks: int = 0


func check(cond: bool, what: String) -> void:
	_checks += 1
	if not cond:
		_fails += 1
		print("FAIL  ", what)


func _init() -> void:
	t_recover_60()
	t_recover_locked_30()
	t_no_fake_upgrade_when_slow()
	t_no_flapping()
	t_backoff_retry()
	t_floors()
	t_modes()
	t_pixel_cap()
	t_debug_override()
	t_mode_switch_keeps_state()
	t_insensitive()
	t_insensitive_under_pixel_cap()
	t_mode_switch_drops_probe()
	print("%d 项检查，%d 项失败" % [_checks, _fails])
	quit(1 if _fails > 0 else 0)


## 模拟一台设备：fps_of 给出「当前渲染比例下的帧率」。帧间隔就是 1/帧率。返回跑完后的动态比例。
func run(q, seconds: float, fps_of: Callable, px: float = PX) -> void:
	var end: float = q.t + seconds
	while q.t < end:
		var s: float = q.render_scale(px)
		var fps: float = fps_of.call(s)
		q.frame(1.0 / fps, px)


## 设备 A：60 帧屏，满分辨率下很吃力（20 帧），比例降到 0.6 以下就能跑满 60
func fps_60(s: float) -> float:
	return minf(60.0, 20.0 / (s * s))


## 设备 B：锁 30 帧的手机，满分辨率也能跑到 30
func fps_30(_s: float) -> float:
	return 30.0


## 跑不动的设备：降分辨率是有用的（帧率跟着像素数走），但降到底也到不了 24 帧
func _stuck(s: float) -> float:
	return 4.5 / (s * s)


## 一段很吃力的负载：帧率跟着像素数走，满分辨率只有 6 帧
func _heavy(s: float) -> float:
	return minf(60.0, 6.0 / (s * s))


## 瓶颈不在像素上（显卡被别的程序占着）：什么比例都是 9 帧
func _contended(_s: float) -> float:
	return 9.0


func t_recover_60() -> void:
	var q = L.new()
	run(q, 15.0, _heavy)  # 一段很吃力的负载
	check(q.drs < 0.6, "60 帧设备: 吃力时降档（%.2f）" % q.drs)
	var low: float = q.drs
	# 负载过去（比如切走了别的标签页），这台设备其实在任何比例下都跑得满 60 帧
	run(q, 120.0, func(_s): return 60.0)
	check(q.drs > low + 0.2, "60 帧设备: 负载过去后升档（%.2f -> %.2f）" % [low, q.drs])
	check(absf(q.drs - 1.0) < 0.001, "60 帧设备: 降档后能升回 1.0（%.3f）" % q.drs)


func t_recover_locked_30() -> void:
	# 这次要修的毛病：帧率被锁在 30 的设备一旦降档，旧规则（高于 52 才升）永远升不回来
	var q = L.new()
	run(q, 15.0, _heavy)
	check(q.drs < 0.6, "锁 30 帧设备: 先被卡顿压低（%.2f）" % q.drs)
	run(q, 180.0, fps_30)
	check(absf(q.drs - 1.0) < 0.001, "锁 30 帧设备: 降档后能升回 1.0（%.3f，估计 %.1f，平均 %.1f）" % [q.drs, q.fps_peak, q.fps_avg])
	check(q.fps_peak <= 31.0 and q.fps_peak >= 30.0, "锁 30 帧设备: 能力估计停在 30（%.1f）" % q.fps_peak)


func t_no_fake_upgrade_when_slow() -> void:
	# 跑不动（10 帧）的设备不会往上升
	var q = L.new()
	run(q, 60.0, _stuck)
	var d: float = q.drs
	run(q, 120.0, _stuck)
	check(q.drs <= d + 0.0001, "跑不动的设备不升档（%.2f -> %.2f）" % [d, q.drs])
	check(absf(q.drs - L.FLOOR_NORMAL) < 0.001, "跑不动的设备停在下限 0.5（%.3f）" % q.drs)


func t_no_flapping() -> void:
	# 满分辨率 20 帧、0.85 以下才到 24 帧以上：能力估计 30，在 0.9 附近的比例会反复「升上去就掉下来」
	var q = L.new()
	run(q, 600.0, fps_60)
	var n: int = q.changes
	# 十分钟里，有退避就不该一直抖：每次失败后至少隔 60 秒才再试一次
	check(n < 40, "不来回抖: 十分钟内比例变动 %d 次" % n)
	var before: int = q.changes
	run(q, 120.0, fps_60)
	check(q.changes - before <= 8, "不来回抖: 稳定后两分钟内变动 %d 次" % (q.changes - before))


func t_backoff_retry() -> void:
	# 升了又掉：刚升的那一档作为暂时的上限被记下；上限在期间不被突破，到期后再试
	var q = L.new()
	q.drs = 0.7
	q.fps_avg = 30.0
	# 稳定地满足升档条件（锁 30 帧、负担很轻）
	run(q, 4.0, func(_s): return 30.0)
	check(q.drs > 0.7, "升了又掉: 先升上去了（%.3f）" % q.drs)
	var peak_level: float = q.drs
	# 升上去之后马上变卡：必须降档，并把升之前的一档记成上限
	var up_from: float = 0.7
	run(q, 3.0, _heavy)
	check(q.drs < peak_level, "升了又掉: 变卡后降档（%.3f）" % q.drs)
	check(q.ceil_scale() <= peak_level and q.ceil_scale() >= up_from - 0.001 and q.ceil_scale() < 1.0, "升了又掉: 记下暂时上限（%.3f）" % q.ceil_scale())
	var ceil_v: float = q.ceil_scale()
	# 恢复流畅之后，上限期间不会超过它
	run(q, 30.0, func(_s): return 30.0)
	check(q.drs <= ceil_v + 0.001, "升了又掉: 上限期间不突破（%.3f <= %.3f）" % [q.drs, ceil_v])
	# 过了退避时间（60 秒起）再试，能继续往上
	run(q, 200.0, func(_s): return 30.0)
	check(absf(q.drs - 1.0) < 0.001, "升了又掉: 到期后再试并升回 1.0（%.3f）" % q.drs)
	check(q.ceil_scale() >= 0.999, "升了又掉: 升成功并稳住后清掉上限（%.3f）" % q.ceil_scale())


func t_floors() -> void:
	var a = L.new()
	run(a, 120.0, _stuck)
	check(absf(a.drs - 0.5) < 0.001, "正常设备下限 0.5（%.3f）" % a.drs)
	check(absf(a.render_scale(PX) - 0.5) < 0.001, "正常设备渲染比例不低于 0.5")
	var b = L.new()
	b.soft = true
	run(b, 120.0, func(s): return 1.8 / (s * s))  # 降到 0.3 也只有 20 帧
	check(absf(b.drs - 0.3) < 0.001, "软件渲染下限 0.3（%.3f）" % b.drs)
	check(absf(b.floor_scale() - 0.3) < 0.0001 and absf(a.floor_scale() - 0.5) < 0.0001, "下限读数")
	# 一帧超过 0.35 秒：立刻降一档，也不低于下限
	var c = L.new()
	c.frame(0.5, PX)
	check(absf(c.drs - 0.7) < 0.001, "单帧过长立刻乘 0.7（%.3f）" % c.drs)
	c.frame(0.5, PX)
	check(absf(c.drs - 0.5) < 0.001, "单帧过长不低于下限（%.3f）" % c.drs)


func t_modes() -> void:
	var q = L.new()
	check(q.mode == "auto", "默认档位 auto")
	check(not q.set_mode("ultra") and q.mode == "auto", "未知档位被拒绝")
	# high：固定为像素上限允许的最大值，不动态调整，开阴影
	q.set_mode("high")
	run(q, 60.0, _stuck)
	check(absf(q.render_scale(PX) - 1.0) < 0.0001, "high 渲染比例 1.0，不受帧率影响（%.3f）" % q.render_scale(PX))
	check(q.shadows(false) and q.shadows(true), "high 开阴影（触屏也开）")
	check(q.changes == 0, "high 不动态调整")
	# low：固定 0.6，关阴影
	q.set_mode("low")
	check(absf(q.render_scale(PX) - 0.6) < 0.0001, "low 渲染比例 0.6")
	check(not q.shadows(false), "low 关阴影")
	# auto：阴影看触屏和软件渲染
	var a = L.new()
	check(a.shadows(false), "auto 桌面开阴影")
	check(not a.shadows(true), "auto 触屏关阴影")
	a.soft = true
	check(not a.shadows(false), "auto 软件渲染关阴影")
	check(L.valid_mode("auto") and L.valid_mode("high") and L.valid_mode("low") and not L.valid_mode(""), "档位名")


func t_pixel_cap() -> void:
	var px: float = 5200000.0  # 桌面 dsf 2：2880x1800
	var cap: float = sqrt(2500000.0 / px)
	var q = L.new()
	q.set_mode("high")
	check(absf(q.render_scale(px) - cap) < 0.0001, "high 受像素上限约束（%.3f）" % q.render_scale(px))
	check(q.is_capped(px) and not q.is_capped(PX), "诊断看得出被像素上限压低")
	var au = L.new()
	run(au, 5.0, func(_s): return 60.0, px)
	check(absf(au.drs - cap) < 0.001 and au.is_capped(px) and au.changes == 0, "auto 的动态比例贴在像素上限上，诊断里看得出，不算一次变动（%.3f）" % au.drs)
	q.set_mode("low")
	check(absf(q.render_scale(px) - minf(cap, 0.6)) < 0.0001, "low 受像素上限约束（%.3f）" % q.render_scale(px))
	q.set_mode("auto")
	check(q.render_scale(px) <= cap + 0.0001, "auto 受像素上限约束")
	# 像素上限压住时，升档不超过上限：不做没有效果的升档
	var w = L.new()
	w.drs = 0.4
	w.fps_avg = 30.0
	run(w, 120.0, func(_s): return 30.0, px)
	check(w.drs <= cap + 0.001, "升档不超过像素上限（%.3f <= %.3f）" % [w.drs, cap])
	check(L.pixel_cap(2500000.0) == 1.0 and L.pixel_cap(1.0e6) == 1.0, "不超过 250 万像素不封顶")


## 高分屏（像素上限 0.69）上帧率跟着像素数走的设备：降档从上限算起，不会因为上限以上那几档「没效果」被判成降了没用
func t_insensitive_under_pixel_cap() -> void:
	var px: float = 5200000.0
	var cap: float = sqrt(2500000.0 / px)
	var q = L.new()
	run(q, 40.0, func(s): return minf(60.0, 6.0 / (s * s)), px)
	check(q.holds == 0, "像素上限下: 降了有用的设备不误判（%d 次）" % q.holds)
	check(q.drs < cap - 0.1, "像素上限下: 能降到上限以下（%.3f < %.3f）" % [q.drs, cap])
	# 对照：同一块屏上瓶颈不在像素的设备，照样判定，回到上限那一档
	var c = L.new()
	run(c, 14.0, _contended, px)
	check(c.holds == 1 and absf(c.drs - cap) < 0.001, "像素上限下: 降了没用照样判定，回到上限（%d 次，%.3f）" % [c.holds, c.drs])


## 降到一半切到别的档位，过一阵再切回 auto：不拿切走之前的帧率当基准去判「降了没用」
func t_mode_switch_drops_probe() -> void:
	var q = L.new()
	run(q, 2.0, _contended)  # 降了一档（0.85），探测刚开始
	check(q.drs < 0.99 and q.holds == 0, "切档: 先降了一档（%.2f）" % q.drs)
	q.set_mode("low")
	run(q, 300.0, func(_s): return 60.0)
	q.set_mode("auto")
	var d: float = q.drs
	run(q, 4.0, _heavy)  # 这回是真的吃力，而且降了有用
	check(q.holds == 0 and q.drs < d, "切档: 切回来后照常降，不被旧基准误判（%d 次，%.2f -> %.2f）" % [q.holds, d, q.drs])


func t_debug_override() -> void:
	var q = L.new()
	q.set_debug_scale(0.75)
	check(absf(q.render_scale(PX) - 0.75) < 0.0001, "调试覆盖固定为 0.75")
	run(q, 60.0, _stuck)
	check(absf(q.render_scale(PX) - 0.75) < 0.0001 and q.changes == 0, "调试覆盖下不动态调整")
	q.set_mode("low")
	check(absf(q.render_scale(PX) - 0.75) < 0.0001, "调试覆盖压过档位")
	q.set_debug_scale(2.0)
	check(absf(q.render_scale(PX) - 1.0) < 0.0001, "调试覆盖上限 1.0")
	q.set_debug_scale(0.1)
	check(absf(q.render_scale(PX) - 0.3) < 0.0001, "调试覆盖下限 0.3")
	q.set_debug_scale(0.9)
	check(absf(q.render_scale(5200000.0) - sqrt(2500000.0 / 5200000.0)) < 0.0001 and q.is_capped(5200000.0), "调试覆盖仍受像素上限约束，诊断里看得出")
	q.set_debug_scale(-1.0)
	check(q.debug_scale < 0.0, "取消调试覆盖")


func t_mode_switch_keeps_state() -> void:
	# 切到 high 再切回 auto，动态比例从原来的位置继续
	var q = L.new()
	run(q, 20.0, fps_60)
	var d: float = q.drs
	q.set_mode("high")
	run(q, 20.0, fps_60)
	check(absf(q.drs - d) < 0.0001, "high 期间动态比例不变")
	q.set_mode("auto")
	check(absf(q.render_scale(PX) - d) < 0.0001, "切回 auto 从原来的动态比例继续")


func t_insensitive() -> void:
	# 降了没用：什么比例都是 9 帧。降两档之后发现帧率没涨，回到原来的比例，之后一段时间不再降
	var q = L.new()
	run(q, 12.0, _contended)
	check(q.holds == 1, "降了没用: 判定一次（%d）" % q.holds)
	check(absf(q.drs - 1.0) < 0.001, "降了没用: 回到开始降之前的比例（%.3f）" % q.drs)
	check(q.holding(), "降了没用: 进入不再降的时段")
	var lowest: float = 1.0
	var end: float = q.t + 90.0
	while q.t < end:
		q.frame(1.0 / 9.0, PX)
		lowest = minf(lowest, q.drs)
	check(lowest > 0.999, "降了没用: 时段内不再降（最低 %.3f）" % lowest)
	# 时段内偶尔一帧很长也不降
	q.frame(0.5, PX)
	check(absf(q.drs - 1.0) < 0.001, "降了没用: 时段内单帧过长也不降（%.3f）" % q.drs)
	# 到期后再试一次，还是没用：再回来，时段翻倍
	run(q, 60.0, _contended)
	check(q.holds == 2 and absf(q.drs - 1.0) < 0.001, "降了没用: 到期再试，仍回到原比例（%d 次，%.3f）" % [q.holds, q.drs])
	var before: int = q.changes
	run(q, 200.0, _contended)
	check(q.changes == before and q.holds == 2, "降了没用: 第二个时段更长（200 秒内不再试，变动 %d 次）" % (q.changes - before))
	# 十分钟里绝大部分时间是清晰的
	var blurry: float = 0.0
	var total: float = 0.0
	var w = L.new()
	while w.t < 600.0:
		w.frame(1.0 / 9.0, PX)
		total += 1.0
		if w.drs < 0.99:
			blurry += 1.0
	check(blurry / total < 0.05, "降了没用: 十分钟里变糊的时间不到 5%%（%.1f%%）" % (100.0 * blurry / total))
	# 从暂时上限下面开始降的：回到的是开始降之前那一档，不是 1.0
	var c = L.new()
	c.drs = 0.8
	run(c, 12.0, _contended)
	check(absf(c.drs - 0.8) < 0.001, "降了没用: 回到的是开始降之前那一档（%.3f）" % c.drs)
	# 软件渲染不做这个判定：照旧降到下限
	var sw = L.new()
	sw.soft = true
	run(sw, 60.0, _contended)
	check(sw.holds == 0 and absf(sw.drs - 0.3) < 0.001, "软件渲染不判定，照旧降到 0.3（%d 次，%.3f）" % [sw.holds, sw.drs])
	# 对照：降了有用的设备不会被误判（帧率跟着像素数走），照常降下去
	var s = L.new()
	run(s, 30.0, _heavy)
	check(s.holds == 0 and s.drs < 0.6, "降了有用的设备不误判（%d 次，%.2f）" % [s.holds, s.drs])
	# 对照：半敏感的设备（帧率和比例成反比）也不误判
	var h = L.new()
	run(h, 30.0, func(sc): return 14.0 / sc)
	check(h.holds == 0 and h.drs < 0.62, "半敏感的设备不误判（%d 次，%.2f）" % [h.holds, h.drs])
