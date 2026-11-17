// 灯光的「光晕」：面向镜头的小方片，加色混合，只在夜里（和黄昏）显现。路灯头、窗口、门灯、桌上的小灯都用它。
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled, fog_disabled;

global uniform float town_night;
uniform vec3 tint : source_color = vec3(1.0, 0.68, 0.32);
uniform float strength = 1.0;

void vertex() {
	float sx = length(MODEL_MATRIX[0].xyz);
	float sy = length(MODEL_MATRIX[1].xyz);
	MODELVIEW_MATRIX = VIEW_MATRIX * mat4(INV_VIEW_MATRIX[0] * sx, INV_VIEW_MATRIX[1] * sy, INV_VIEW_MATRIX[2], MODEL_MATRIX[3]);
}

void fragment() {
	vec2 p = UV * 2.0 - 1.0;
	float d = length(p);
	float core = smoothstep(0.35, 0.0, d);
	float halo = smoothstep(1.0, 0.0, d);
	halo *= halo;
	float k = (core * 0.9 + halo * 0.55) * town_night * strength;
	ALBEDO = tint * k;
	ALPHA = 1.0;
}
