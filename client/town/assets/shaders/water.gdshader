// 喷泉水和小池塘：柔和的青蓝色，缓慢移动的亮纹，夜里略暗。没有反射，没有高光。
shader_type spatial;
render_mode diffuse_lambert_wrap, specular_disabled;

global uniform float town_night;
uniform vec3 deep : source_color = vec3(0.34, 0.62, 0.70);
uniform vec3 shallow : source_color = vec3(0.60, 0.82, 0.82);
uniform float scale = 1.0;

varying vec3 wp;

void vertex() {
	wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 p = wp.xz * scale;
	float t = TIME * 0.35;
	float a = sin(p.x * 2.3 + t * 1.7) * sin(p.y * 2.1 - t * 1.3);
	float b = sin((p.x + p.y) * 3.1 + t * 2.1);
	float r = clamp(0.5 + 0.35 * a + 0.2 * b, 0.0, 1.0);
	vec3 c = mix(deep, shallow, smoothstep(0.35, 0.9, r));
	ALBEDO = c * (1.0 - 0.25 * town_night);
	ROUGHNESS = 1.0;
	SPECULAR = 0.0;
	EMISSION = c * 0.06;
}
