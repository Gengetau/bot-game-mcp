// 栖灯镇静态几何（建筑、树、摆设）共用的材质：
//   颜色 = 色板贴图（Kenney 重新配色的 colormap.png）x 顶点色；程序生成的几何体 UV 指向贴图左上角的纯白块，颜色全在顶点色里。
//   顶点色的 alpha 是「发光」遮罩：alpha 越小越是窗玻璃一类，夜里发暖光（town_night 由 daynight.gd 设置）。
//   漫反射用包裹式 Lambert，没有高光；fade < 1 时用 4x4 拜耳抖动半透明（不用 alpha 混合，没有排序问题），遮挡物淡出用它。
shader_type spatial;
render_mode diffuse_lambert_wrap, specular_disabled, cull_back;

global uniform float town_night;
uniform sampler2D pal : source_color, filter_linear, repeat_disable;
uniform float fade : hint_range(0.0, 1.0) = 1.0;
uniform vec3 glow_color : source_color = vec3(1.0, 0.70, 0.36);
uniform float glow_energy = 1.35;

float bayer4(vec2 p) {
	ivec2 q = ivec2(mod(p, 4.0));
	int i = q.x + q.y * 4;
	// 4x4 拜耳矩阵（0..15）
	int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
	return (float(m[i]) + 0.5) / 16.0;
}

void fragment() {
	if (fade < 0.999) {
		if (fade <= bayer4(FRAGCOORD.xy)) {
			discard;
		}
	}
	vec4 t = texture(pal, UV);
	ALBEDO = t.rgb * COLOR.rgb;
	ROUGHNESS = 1.0;
	SPECULAR = 0.0;
	float glass = 1.0 - COLOR.a;
	EMISSION = glow_color * glass * glow_energy * (0.05 + town_night);
}
