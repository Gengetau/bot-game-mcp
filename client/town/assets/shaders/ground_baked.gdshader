// 栖灯镇地面的显示着色器：地面的花纹（草、石板、木地板……）由 ground.gdshader 在加载时画到一张贴图里（world.gd 的 _build_ground，只画一次），
// 这里每帧只采样这张贴图，再加上夜里路灯、门灯在地面上的暖色光池。这样软件渲染和老手机上，地面的开销只剩一次贴图采样。
shader_type spatial;
render_mode diffuse_lambert_wrap, specular_disabled;

global uniform float town_night;
uniform sampler2D baked : source_color, filter_linear, repeat_disable;
uniform vec2 size_m = vec2(64.0, 48.0);
uniform vec2 origin = vec2(0.0, 0.0);
uniform vec4 lamps[24];
uniform int lamp_count = 0;
uniform vec3 glow_color : source_color = vec3(1.0, 0.72, 0.4);

varying vec3 wp;

void vertex() {
	wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec3 c = texture(baked, UV).rgb;
	ALBEDO = c;
	ROUGHNESS = 1.0;
	SPECULAR = 0.0;
	vec3 em = vec3(0.0);
	if (town_night > 0.01) {
		for (int i = 0; i < 24; i++) {
			if (i >= lamp_count) {
				break;
			}
			vec4 L = lamps[i];
			float d = length(wp.xz - L.xy);
			float k = 1.0 - smoothstep(0.0, L.z, d);
			em += glow_color * k * k * L.w;
		}
	}
	EMISSION = c * em * town_night * 1.1;
}
