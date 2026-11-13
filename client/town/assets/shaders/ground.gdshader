// 栖灯镇的地面：一张大平面，按「地形编号贴图」（每个服务器栅格一个像素）在着色器里画出草地、石板路、广场砖、木地板等，
// 不需要任何贴图素材。地形编号来自服务器的地图清单（区域 + 可走范围），客户端只负责上色。
// 另有：建筑和墙脚的接触暗角（ao 贴图）、夜里路灯在地面上的暖色光池（lamps）。
shader_type spatial;
render_mode diffuse_lambert_wrap, specular_disabled;

global uniform float town_night;
uniform sampler2D types : filter_nearest, repeat_disable;   // R = 地形编号 / 255
uniform sampler2D ao : filter_linear, repeat_disable;       // R = 暗角 0..1
uniform vec2 grid_size = vec2(128.0, 96.0);
uniform float cell = 0.5;
uniform vec2 origin = vec2(0.0, 0.0);
uniform vec2 fountain = vec2(32.0, 24.0);
uniform vec4 lamps[24];
uniform int lamp_count = 0;
uniform vec3 glow_color : source_color = vec3(1.0, 0.72, 0.4);
uniform float bake = 0.0;   // 1 = 在加载时画进贴图（不受光，直接输出颜色）

varying vec3 wp;

void vertex() {
	wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec3 grass(vec2 w) {
	float n = vnoise(w * 0.35) * 0.7 + vnoise(w * 1.7) * 0.3;
	vec3 a = vec3(0.50, 0.69, 0.39);
	vec3 b = vec3(0.60, 0.76, 0.43);
	vec3 c = mix(a, b, smoothstep(0.35, 0.75, n));
	// 草丛：细小的深色短划
	float t = hash12(floor(w * vec2(9.0, 5.0)));
	c *= 1.0 - 0.07 * step(0.8, t);
	return c;
}

vec3 flowers(vec3 base, vec2 w, float density) {
	vec2 q = w * 2.2;
	vec2 id = floor(q);
	float h = hash12(id);
	if (h < density) {
		vec2 c = (id + 0.25 + 0.5 * vec2(hash12(id + 7.1), hash12(id + 3.3))) / 2.2;
		float d = length(w - c);
		if (d < 0.07) {
			float k = hash12(id + 11.0);
			vec3 col = k < 0.34 ? vec3(0.96, 0.78, 0.84) : (k < 0.67 ? vec3(0.98, 0.92, 0.62) : vec3(0.97, 0.97, 0.95));
			return col;
		}
	}
	return base;
}

vec3 cobble(vec2 w, float row_off) {
	// 0.5 米宽的卵石路：错缝的小砖
	vec2 q = w / vec2(0.5, 0.35);
	float row = floor(q.y);
	q.x += 0.5 * mod(row, 2.0) + row_off;
	vec2 f = fract(q);
	vec2 id = vec2(floor(q.x), row);
	float h = hash12(id);
	vec3 stone = mix(vec3(0.83, 0.77, 0.66), vec3(0.74, 0.69, 0.60), h * 0.9);
	float gap = min(min(f.x, 1.0 - f.x) * 0.5, min(f.y, 1.0 - f.y) * 0.35);
	float m = smoothstep(0.012, 0.03, gap);
	return mix(vec3(0.58, 0.53, 0.46), stone, m);
}

vec3 tiles(vec2 w, float size, vec3 a, vec3 b) {
	vec2 q = w / size;
	vec2 id = floor(q);
	vec2 f = fract(q);
	float chk = mod(id.x + id.y, 2.0);
	vec3 c = mix(a, b, chk);
	c *= 0.97 + 0.05 * hash12(id);
	float gap = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * size;
	return mix(c * 0.78, c, smoothstep(0.012, 0.03, gap));
}

vec3 planks(vec2 w, vec3 base, float width) {
	float row = floor(w.y / width);
	float f = fract(w.y / width);
	float seg = floor((w.x + hash12(vec2(row, 1.0)) * 3.0) / 2.4);
	float h = hash12(vec2(row, seg));
	vec3 c = base * (0.92 + 0.16 * h);
	float line = smoothstep(0.0, 0.05, f) * smoothstep(1.0, 0.95, f);
	c *= 0.97 + 0.05 * sin(w.x * 4.7 + row * 1.9);
	return mix(c * 0.72, c, line);
}

vec3 terrain(int id, vec2 w) {
	if (id == 0) {
		return grass(w);
	}
	if (id == 1) {
		return cobble(w, 0.0);       // 灯笼路
	}
	if (id == 2) {                    // 广场：浅色石板 + 喷泉周围的环
		vec3 c = tiles(w, 1.0, vec3(0.88, 0.84, 0.76), vec3(0.84, 0.80, 0.72));
		float d = length(w - fountain);
		float ring = smoothstep(0.08, 0.0, abs(d - 4.2)) + smoothstep(0.08, 0.0, abs(d - 6.0)) * 0.7;
		return mix(c, vec3(0.62, 0.56, 0.48), ring * 0.8);
	}
	if (id == 3) {                    // 花园：草坪 + 小花
		vec3 c = grass(w) * vec3(1.0, 1.04, 0.95);
		return flowers(c, w, 0.18);
	}
	if (id == 4) {                    // 会馆前：暖色铺地
		return tiles(w, 0.7, vec3(0.86, 0.75, 0.66), vec3(0.82, 0.70, 0.62));
	}
	if (id == 5) {
		return planks(w, vec3(0.78, 0.56, 0.36), 0.28);    // 茶馆：暖木
	}
	if (id == 6) {
		return planks(w, vec3(0.66, 0.50, 0.38), 0.24);    // 书屋：深一点的木
	}
	if (id == 7) {
		return tiles(w, 0.5, vec3(0.92, 0.90, 0.82), vec3(0.78, 0.84, 0.78));  // 厨房：浅色方砖
	}
	if (id == 8) {                    // 游戏馆：灰蓝地毯
		vec3 c = vec3(0.45, 0.53, 0.63) * (0.95 + 0.07 * vnoise(w * 3.0));
		float b = step(0.5, fract(w.x * 0.5)) + step(0.5, fract(w.y * 0.5));
		return c * (1.0 - 0.06 * mod(b, 2.0));
	}
	if (id == 9) {
		return tiles(w, 0.5, vec3(0.80, 0.78, 0.73), vec3(0.76, 0.74, 0.69));  // 门槛石
	}
	if (id == 10) {
		return planks(w, vec3(0.84, 0.68, 0.50), 0.3);     // 私宅：浅木
	}
	if (id == 11) {
		return vec3(0.17, 0.18, 0.22);                      // 私宅外面的虚空
	}
	return vec3(1.0, 0.0, 1.0);
}

bool paved(int id) {
	return id == 1 || id == 2 || id == 4 || id == 9;
}

void fragment() {
	vec2 w = wp.xz;
	vec2 g = (w - origin) / cell;
	int id = 11;
	int m = 0;
	if (g.x >= 0.0 && g.y >= 0.0 && g.x < grid_size.x && g.y < grid_size.y) {
		vec4 tv = texture(types, (floor(g) + 0.5) / grid_size);
		id = int(tv.r * 255.0 + 0.5);
		m = int(tv.g * 255.0 + 0.5);
	} else {
		id = 0;
	}
	vec3 c = terrain(id, w);
	vec2 f = fract(g);

	// 路 / 广场的边缘：和草地交界处画一道深色路缘；草地靠近铺面处压出一圈泥土色。
	// 哪一侧的邻格是什么，world.gd 在生成地形编号贴图时已经算好放在 G 通道的低四位（1 = -x，2 = +x，4 = -z，8 = +z）。
	if (m != 0) {
		float edge = 9.0;
		if ((m & 1) != 0) { edge = min(edge, f.x); }
		if ((m & 2) != 0) { edge = min(edge, 1.0 - f.x); }
		if ((m & 4) != 0) { edge = min(edge, f.y); }
		if ((m & 8) != 0) { edge = min(edge, 1.0 - f.y); }
		if (paved(id)) {
			c = mix(vec3(0.52, 0.47, 0.40), c, smoothstep(0.0, 0.16, edge));
		} else if (id == 0) {
			c = mix(vec3(0.62, 0.55, 0.40), c, smoothstep(0.0, 0.35, edge));
		}
	}

	// 接触暗角
	float a = texture(ao, (w - origin) / (cell * grid_size)).r;
	c *= 1.0 - 0.24 * a;

	ALBEDO = c * (1.0 - bake);
	ROUGHNESS = 1.0;
	SPECULAR = 0.0;

	// 路灯的暖色光池（只在夜里）
	vec3 em = vec3(0.0);
	for (int i = 0; i < 24; i++) {
		if (town_night < 0.01) {
			break;
		}
		if (i >= lamp_count) {
			break;
		}
		vec4 L = lamps[i];
		float d = length(w - L.xy);
		float k = 1.0 - smoothstep(0.0, L.z, d);
		em += glow_color * k * k * L.w;
	}
	EMISSION = c * bake + c * em * town_night * 1.1 * (1.0 - bake);
}
