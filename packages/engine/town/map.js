// 小镇地图：手绘风格的 SVG。地点之间的边来自服务器的 PublicView.edges，居民位置来自公开投影或本人视图。
import { s } from './dom.js';

/** @typedef {import('./types.js').PublicView} PublicView */
/** @typedef {import('./types.js').MeView} MeView */
/** @typedef {import('./types.js').PublicSpot} PublicSpot */

const W = 640;
const H = 600;

/** 节点在画面里的位置。dotDy：居民小灯点相对节点的纵向偏移。 */
const NODES = {
  plaza: { x: 322, y: 300, label: 58, dot: -82, name: '灯下广场' },
  tea_house: { x: 150, y: 148, label: 54, dot: -76, name: '栖灯茶馆' },
  bookshop: { x: 452, y: 116, label: 52, dot: -76, name: '檐下书屋' },
  arcade: { x: 546, y: 330, label: 54, dot: -78, name: '游戏馆' },
  kitchen: { x: 440, y: 498, label: 54, dot: -74, name: '公共厨房' },
  garden: { x: 206, y: 504, label: 54, dot: -72, name: '后巷花园' },
  residential: { x: 92, y: 336, label: 64, dot: -56, name: '住宅区' },
};

/** 路的弯曲：从 a 到 b 的二次贝塞尔控制点（键按字典序）。 */
const BENDS = {
  'plaza|tea_house': [226, 206],
  'bookshop|plaza': [398, 196],
  'kitchen|plaza': [394, 410],
  'garden|plaza': [244, 408],
  'arcade|plaza': [440, 300],
  'plaza|residential': [206, 330],
  'bookshop|tea_house': [300, 78],
  'residential|tea_house': [96, 236],
  'garden|residential': [96, 440],
  'garden|kitchen': [322, 548],
};

const PALETTE = ['#d98b3a', '#6f9a63', '#5f8fb0', '#b9605a', '#8b6bb0', '#c4a23c', '#4f9a94', '#c77a96'];

/** @param {string} str */
function hashColor(str) {
  let hsh = 0;
  for (const ch of str) hsh = (hsh * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[hsh % PALETTE.length] ?? '#d98b3a';
}

/**
 * 昼夜关键帧：[小时, rgb, 色罩不透明度, 夜色程度(灯光)]
 * @type {[number, [number, number, number], number, number][]}
 */
const KEYS = [
  [0, [26, 39, 85], 0.38, 1],
  [5, [26, 39, 85], 0.36, 1],
  [6.5, [240, 167, 122], 0.16, 0.5],
  [8, [255, 230, 190], 0, 0.1],
  [10, [255, 255, 255], 0, 0],
  [16, [255, 255, 255], 0, 0],
  [17.5, [243, 166, 77], 0.14, 0.15],
  [18.7, [155, 79, 122], 0.24, 0.55],
  [20, [38, 42, 102], 0.34, 1],
  [24, [26, 39, 85], 0.38, 1],
];

/** @param {number} hour 0~24 的小数 */
export function tintFor(hour) {
  for (let i = 1; i < KEYS.length; i++) {
    const a = KEYS[i - 1];
    const b = KEYS[i];
    if (!a || !b || hour > b[0]) continue;
    const t = (hour - a[0]) / (b[0] - a[0] || 1);
    const rgb = a[1].map((v, k) => Math.round(v + ((b[1][k] ?? 0) - v) * t));
    return { color: `rgb(${rgb.join(',')})`, opacity: a[2] + (b[2] - a[2]) * t, night: a[3] + (b[3] - a[3]) * t };
  }
  return { color: 'rgb(26,39,85)', opacity: 0.38, night: 1 };
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @typedef {{ pub: PublicView | null, me: MeView | null, now: number, hour: number }} MapInput
 */

/**
 * @param {{ onPlace: (id: string) => void }} opts
 */
export function createMap(opts) {
  const svg = s('svg', { class: 'townmap', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': '栖灯镇地图', preserveAspectRatio: 'xMidYMid meet' });
  const defs = s(
    'defs',
    null,
    s('radialGradient', { id: 'glow' }, s('stop', { offset: '0', 'stop-color': '#ffd27a', 'stop-opacity': '0.85' }), s('stop', { offset: '1', 'stop-color': '#ffd27a', 'stop-opacity': '0' })),
    s('pattern', { id: 'paper', width: 14, height: 14, patternUnits: 'userSpaceOnUse' }, s('circle', { cx: 3, cy: 4, r: 0.7, class: 'speck' }), s('circle', { cx: 10, cy: 11, r: 0.6, class: 'speck' })),
    s('clipPath', { id: 'frame' }, s('rect', { x: 0, y: 0, width: W, height: H, rx: 26 })),
  );
  svg.appendChild(defs);

  const clipped = s('g', { 'clip-path': 'url(#frame)' });
  svg.appendChild(clipped);
  clipped.appendChild(s('rect', { width: W, height: H, class: 'm-ground' }));
  clipped.appendChild(s('rect', { width: W, height: H, fill: 'url(#paper)' }));
  clipped.appendChild(decor());
  const roads = s('g', { class: 'roads' });
  clipped.appendChild(roads);
  const places = s('g', { class: 'places' });
  clipped.appendChild(places);
  const tint = s('rect', { width: W, height: H, class: 'm-tint', 'pointer-events': 'none', opacity: 0 });
  clipped.appendChild(tint);
  const lamps = s('g', { class: 'lamps', 'pointer-events': 'none' });
  clipped.appendChild(lamps);
  const sky = s('g', { class: 'sky', 'pointer-events': 'none' });
  clipped.appendChild(sky);
  const weather = s('g', { class: 'weather', 'pointer-events': 'none' });
  clipped.appendChild(weather);
  const labels = s('g', { class: 'labels' });
  clipped.appendChild(labels);
  const people = s('g', { class: 'people' });
  clipped.appendChild(people);
  clipped.appendChild(s('rect', { x: 3, y: 3, width: W - 6, height: H - 6, rx: 24, class: 'm-border', 'pointer-events': 'none' }));

  /** @type {Map<string, SVGPathElement>} */
  const roadPaths = new Map();
  /** @type {Map<string, SVGGElement>} */
  const placeGroups = new Map();
  /** @type {Map<string, { badge: SVGTextElement, flag: SVGGElement, flagText: SVGTextElement, game: SVGGElement, gameText: SVGTextElement, nameText: SVGTextElement }>} */
  const placeBits = new Map();
  /** @type {Map<string, SVGGElement>} */
  const dots = new Map();
  let builtEdges = '';
  let lastWeather = '';
  let lastSky = '';

  // 地点
  for (const [id, n] of Object.entries(NODES)) {
    const g = s('g', { class: 'place', transform: `translate(${n.x} ${n.y})`, tabindex: '0', role: 'button', 'data-id': id, 'aria-label': n.name });
    g.appendChild(s('circle', { r: 64, class: 'hit' }));
    g.appendChild(building(id));
    g.addEventListener('click', () => opts.onPlace(id));
    g.addEventListener('keydown', (e) => {
      const ev = /** @type {KeyboardEvent} */ (e);
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        opts.onPlace(id);
      }
    });
    places.appendChild(g);
    placeGroups.set(id, g);

    // 标签（画在色罩之上，保持清晰）
    const nameText = s('text', { class: 'm-label', x: n.x, y: n.y + n.label, 'text-anchor': 'middle' }, n.name);
    const badge = s('text', { class: 'm-count', x: n.x, y: n.y + n.label + 18, 'text-anchor': 'middle' });
    const flagText = s('text', { class: 'm-flag-text', x: 0, y: 4, 'text-anchor': 'middle' });
    const flag = s('g', { class: 'm-flag', transform: `translate(${n.x} ${n.y + n.label + 38})`, display: 'none' }, s('rect', { class: 'm-flag-bg', x: -60, y: -12, width: 120, height: 22, rx: 11 }), flagText);
    const gameText = s('text', { class: 'm-game-text', x: 15, y: 5 });
    const game = s('g', { class: 'm-game', transform: `translate(${n.x + 34} ${n.y - 36})`, display: 'none' }, s('rect', { class: 'm-game-bg', x: -3, y: -13, width: 54, height: 24, rx: 12 }), diceGlyph(), gameText);
    labels.appendChild(nameText);
    labels.appendChild(badge);
    labels.appendChild(flag);
    labels.appendChild(game);
    placeBits.set(id, { badge, flag, flagText, game, gameText, nameText });

    // 灯光（夜里亮）
    lamps.appendChild(s('circle', { cx: n.x, cy: n.y - 6, r: 62, fill: 'url(#glow)', class: 'lamp-glow' }));
  }

  /** @param {PublicView} pub */
  function buildRoads(pub) {
    const key = JSON.stringify(pub.edges);
    if (key === builtEdges) return;
    builtEdges = key;
    roads.replaceChildren();
    roadPaths.clear();
    const under = s('g', { class: 'road-under' });
    const inner = s('g', { class: 'road-inner' });
    const over = s('g', { class: 'road-over' });
    for (const [a, b] of pub.edges) {
      const A = NODES[/** @type {keyof typeof NODES} */ (a)];
      const B = NODES[/** @type {keyof typeof NODES} */ (b)];
      if (!A || !B) continue;
      const sorted = [a, b].sort().join('|');
      const ctl = BENDS[/** @type {keyof typeof BENDS} */ (sorted)];
      const d = ctl ? `M${A.x} ${A.y} Q${ctl[0]} ${ctl[1]} ${B.x} ${B.y}` : `M${A.x} ${A.y} L${B.x} ${B.y}`;
      under.appendChild(s('path', { d, class: 'road-edge' }));
      inner.appendChild(s('path', { d, class: 'road' }));
      over.appendChild(s('path', { d, class: 'road-line' }));
      const p = /** @type {SVGPathElement} */ (s('path', { d, fill: 'none', stroke: 'none' }));
      over.appendChild(p);
      roadPaths.set(`${a}>${b}`, p);
    }
    roads.appendChild(under);
    roads.appendChild(inner);
    roads.appendChild(over);
  }

  /**
   * 沿 from→to 这条路走了 t（0~1）之后的位置。
   * @param {string} from
   * @param {string} to
   * @param {number} t
   */
  function pointOnRoad(from, to, t) {
    const fwd = roadPaths.get(`${from}>${to}`);
    const rev = roadPaths.get(`${to}>${from}`);
    const path = fwd ?? rev;
    const A = NODES[/** @type {keyof typeof NODES} */ (from)];
    const B = NODES[/** @type {keyof typeof NODES} */ (to)];
    if (path && path.getTotalLength) {
      const len = path.getTotalLength();
      const at = fwd ? t * len : (1 - t) * len;
      const pt = path.getPointAtLength(at);
      return { x: pt.x, y: pt.y };
    }
    if (A && B) return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
    return { x: W / 2, y: H / 2 };
  }

  /**
   * @param {{ path: string[], startedAt: number, arriveAt: number }} mv
   * @param {number} now
   */
  function positionOnPath(mv, now) {
    const path = mv.path;
    const segs = Math.max(1, path.length - 1);
    const p = Math.min(1, Math.max(0, (now - mv.startedAt) / Math.max(1, mv.arriveAt - mv.startedAt)));
    const seg = Math.min(segs - 1, Math.floor(p * segs));
    const local = p * segs - seg;
    return pointOnRoad(path[seg] ?? path[0] ?? 'plaza', path[seg + 1] ?? path[path.length - 1] ?? 'plaza', Math.min(1, Math.max(0, local)));
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {string} kind
   * @param {boolean} mine
   */
  function ensureDot(id, name, kind, mine) {
    let g = dots.get(id);
    if (!g) {
      const color = hashColor(id);
      const shape = kind === 'agent' ? s('rect', { x: -10, y: -10, width: 20, height: 20, rx: 5, transform: 'rotate(45)', fill: color, class: 'dot-shape' }) : s('circle', { r: 11, fill: color, class: 'dot-shape' });
      g = /** @type {SVGGElement} */ (s('g', { class: `dot${mine ? ' mine' : ''}`, 'data-id': id }, s('circle', { r: 17, class: 'dot-halo' }), shape, s('text', { class: 'dot-text', y: 4.5, 'text-anchor': 'middle' }, [...name][0] ?? '?'), s('title', null, name)));
      people.appendChild(g);
      dots.set(id, g);
    }
    g.classList.toggle('mine', mine);
    return g;
  }

  /**
   * @param {SVGGElement} g
   * @param {number} x
   * @param {number} y
   * @param {boolean} [instant]
   */
  function place(g, x, y, instant) {
    if (instant) g.classList.add('no-ease');
    g.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    g.dataset.placed = '1';
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => g.classList.remove('no-ease')));
  }

  /** @type {{ mv: { path: string[], startedAt: number, arriveAt: number }, g: SVGGElement }[]} */
  let movers = [];
  /** @type {PublicView | null} */
  let lastPub = null;
  /** @type {MeView | null} */
  let lastMe = null;

  /**
   * @param {MapInput} input
   */
  function update(input) {
    const { pub, me } = input;
    lastPub = pub;
    lastMe = me;
    if (!pub) return;
    buildRoads(pub);
    const myId = me?.me.id ?? null;

    // 各地点的居民（不含我自己：我的位置以本人视图为准）
    /** @type {Map<string, PublicSpot[]>} */
    const byPlace = new Map();
    for (const p of pub.places) byPlace.set(p.id, p.residents.filter((r) => r.id !== myId));
    byPlace.set('residential', pub.residential.residents.filter((r) => r.id !== myId));
    const mePlace = me ? zoneOfMe(me) : null;
    if (me && mePlace && !me.location.moving) {
      byPlace.set(mePlace, [{ id: me.me.id, name: me.me.name, kind: me.me.kind, at: mePlace }, ...(byPlace.get(mePlace) ?? [])]);
    }

    const seen = new Set();
    for (const [pid, list] of byPlace) {
      const n = NODES[/** @type {keyof typeof NODES} */ (pid)];
      if (!n) continue;
      const shown = list.slice(0, 12);
      const cols = Math.min(6, shown.length);
      shown.forEach((r, k) => {
        const col = k % 6;
        const row = Math.floor(k / 6);
        const rowCount = row === Math.floor((shown.length - 1) / 6) ? shown.length - row * 6 : 6;
        const x = n.x + (col - (Math.min(6, rowCount) - 1) / 2) * 27;
        const y = n.y + n.dot - row * 27;
        const g = ensureDot(r.id, r.name, r.kind, r.id === myId);
        g.removeAttribute('display');
        const first = !g.dataset.placed;
        place(g, x, y, first);
        seen.add(r.id);
      });
      void cols;
      const bits = placeBits.get(pid);
      if (bits) {
        const total = list.length;
        bits.badge.textContent = total === 0 ? '' : total > 12 ? `${total} 人在场（显示 12 位）` : `${total} 人在场`;
        placeGroups.get(pid)?.setAttribute('aria-label', `${n.name}，${total} 人在场${total ? `：${list.slice(0, 8).map((r) => r.name).join('、')}` : ''}${total > 8 ? ' 等' : ''}`);
      }
    }

    // 在路上的人
    movers = [];
    /** @type {{ id: string, name: string, kind: string, mv: { path: string[], startedAt: number, arriveAt: number } }[]} */
    const moving = pub.moving.filter((m) => m.id !== myId && m.moving).map((m) => ({ id: m.id, name: m.name, kind: m.kind, mv: /** @type {{ path: string[], startedAt: number, arriveAt: number }} */ (m.moving) }));
    if (me?.location.moving) {
      const mv = me.location.moving;
      const zp = dedupe(mv.path.map(zoneOfId));
      if (zp.length >= 2) moving.push({ id: me.me.id, name: me.me.name, kind: me.me.kind, mv: { path: zp, startedAt: mv.startedAt, arriveAt: mv.arriveAt } });
      else {
        const z = zp[0];
        const n = z ? NODES[/** @type {keyof typeof NODES} */ (z)] : undefined;
        if (n) {
          const g = ensureDot(me.me.id, me.me.name, me.me.kind, true);
          g.removeAttribute('display');
          place(g, n.x, n.y + n.dot, !g.dataset.placed);
          seen.add(me.me.id);
        }
      }
    }
    for (const m of moving) {
      const g = ensureDot(m.id, m.name, m.kind, m.id === myId);
      g.removeAttribute('display');
      g.classList.add('walking');
      const pt = positionOnPath(m.mv, input.now);
      place(g, pt.x, pt.y, !g.dataset.placed);
      movers.push({ mv: m.mv, g });
      seen.add(m.id);
    }
    for (const [id, g] of dots) {
      if (!seen.has(id)) {
        g.setAttribute('display', 'none');
      } else if (!movers.some((m) => m.g === g)) g.classList.remove('walking');
    }

    // 事件旗与小游戏
    const openEvents = pub.events.filter((e) => e.status === 'open');
    for (const [pid, bits] of placeBits) {
      const ev = openEvents.find((e) => e.place === pid);
      if (ev) {
        bits.flag.removeAttribute('display');
        bits.flagText.textContent = `${ev.title} · 进行中`;
      } else bits.flag.setAttribute('display', 'none');
      const pl = pub.places.find((p) => p.id === pid);
      const act = pl?.activities ?? [];
      if (act.length) {
        bits.game.removeAttribute('display');
        const running = act.filter((a) => a.status === 'running').length;
        bits.gameText.textContent = running ? `${running} 局` : `${act.length} 桌`;
      } else bits.game.setAttribute('display', 'none');
    }

    // 昼夜与天气
    const t = tintFor(input.hour);
    tint.setAttribute('fill', t.color);
    tint.setAttribute('opacity', String(t.opacity.toFixed(3)));
    svg.style.setProperty('--night', t.night.toFixed(3));
    const wid = pub.world.weather.id;
    const skyKey = `${wid}|${t.night > 0.5 ? 'n' : 'd'}|${input.hour >= 6 && input.hour < 18 ? 's' : 'm'}`;
    if (skyKey !== lastSky) {
      lastSky = skyKey;
      drawSky(sky, wid, t.night > 0.5 || input.hour < 6 || input.hour >= 18);
    }
    if (wid !== lastWeather) {
      lastWeather = wid;
      drawWeather(weather, wid);
    }
    svg.dataset.weather = wid;
    svg.dataset.night = t.night > 0.5 ? '1' : '0';
  }

  /** 每帧推进在路上的人。 @param {number} now */
  function tick(now) {
    for (const m of movers) {
      const pt = positionOnPath(m.mv, now);
      place(m.g, pt.x, pt.y);
    }
  }

  return {
    el: svg,
    update,
    tick,
    hasMovers: () => movers.length > 0,
    lastInput: () => ({ pub: lastPub, me: lastMe }),
  };
}

/** @param {string} id */
function zoneOfId(id) {
  return id in NODES ? id : 'residential';
}
/** @param {string[]} a */
function dedupe(a) {
  return a.filter((v, i) => v !== a[i - 1]);
}
/** @param {MeView} me */
function zoneOfMe(me) {
  if (me.location.moving) return null;
  const sp = me.location.space;
  return sp ? zoneOfId(sp) : null;
}

// ───────────────────────── 画面元素 ─────────────────────────

function diceGlyph() {
  return s('g', { class: 'm-die', transform: 'translate(6 -1)' }, s('rect', { x: -7, y: -7, width: 14, height: 14, rx: 3.5 }), s('circle', { cx: -2.6, cy: -2.6, r: 1.3 }), s('circle', { cx: 2.6, cy: 2.6, r: 1.3 }), s('circle', { cx: 0, cy: 0, r: 1.3 }));
}

/** 背景的小景：树、池塘、草丛。 */
function decor() {
  const g = s('g', { class: 'decor', 'pointer-events': 'none' });
  const tree = (x, y, k = 1) => g.appendChild(s('g', { transform: `translate(${x} ${y}) scale(${k})` }, s('ellipse', { cx: 0, cy: 14, rx: 13, ry: 4, class: 'tree-shadow' }), s('rect', { x: -2, y: 2, width: 4, height: 13, class: 'tree-trunk' }), s('circle', { cx: 0, cy: -4, r: 13, class: 'tree-a' }), s('circle', { cx: -8, cy: 3, r: 9, class: 'tree-b' }), s('circle', { cx: 8, cy: 2, r: 9, class: 'tree-b' })));
  [
    [30, 60, 1],
    [58, 84, 0.8],
    [596, 60, 1.1],
    [612, 150, 0.8],
    [600, 440, 1],
    [584, 560, 0.9],
    [28, 560, 1],
    [40, 232, 0.8],
    [334, 560, 0.7],
    [330, 44, 0.8],
    [250, 80, 0.7],
  ].forEach(([x, y, k]) => tree(/** @type {number} */ (x), /** @type {number} */ (y), /** @type {number} */ (k)));
  // 池塘
  g.appendChild(s('path', { d: 'M520 440 q-30 8 -22 36 q14 28 52 22 q34 -8 30 -34 q-8 -30 -60 -24z', class: 'pond' }));
  g.appendChild(s('path', { d: 'M526 462 q14 -6 28 0 M534 476 q10 -4 22 0', class: 'pond-ripple' }));
  // 草丛
  for (const [x, y] of [
    [150, 230],
    [260, 140],
    [380, 60],
    [210, 420],
    [330, 440],
    [510, 230],
    [400, 360],
    [140, 420],
    [560, 200],
    [250, 580],
  ]) g.appendChild(s('path', { d: `M${x} ${y} l-3 -8 M${x} ${y} l0 -10 M${x} ${y} l3 -8`, class: 'tuft' }));
  return g;
}

/** @param {string} id */
function building(id) {
  const g = s('g', { class: `bld bld-${id}` });
  const add = (/** @type {SVGElement} */ el) => g.appendChild(el);
  const win = (x, y, w = 11, h = 12) => add(s('rect', { x, y, width: w, height: h, rx: 2, class: 'b-win' }));
  switch (id) {
    case 'tea_house':
      add(s('ellipse', { cx: 0, cy: 34, rx: 46, ry: 6, class: 'b-shadow' }));
      add(s('rect', { x: -34, y: -6, width: 68, height: 40, rx: 3, class: 'b-wall' }));
      add(s('path', { d: 'M-46 -4 Q-30 -10 0 -42 Q30 -10 46 -4 Q30 -8 0 -30 Q-30 -8 -46 -4z', class: 'b-roof roof-tea' }));
      add(s('rect', { x: 14, y: -38, width: 9, height: 16, class: 'b-wall' }));
      add(s('path', { d: 'M18 -42 q-6 -8 0 -14 q6 -6 0 -14', class: 'steam' }));
      add(s('path', { d: 'M24 -40 q-6 -8 0 -12 q5 -5 0 -11', class: 'steam s2' }));
      add(s('rect', { x: -8, y: 12, width: 16, height: 22, rx: 8, class: 'b-door' }));
      win(-28, 6);
      win(17, 6);
      add(s('path', { d: 'M40 6 v8', class: 'b-ink' }));
      add(s('circle', { cx: 40, cy: 20, r: 6, class: 'b-lantern' }));
      break;
    case 'bookshop':
      add(s('ellipse', { cx: 0, cy: 34, rx: 46, ry: 6, class: 'b-shadow' }));
      add(s('rect', { x: -34, y: -10, width: 68, height: 44, rx: 3, class: 'b-wall' }));
      add(s('path', { d: 'M-40 -8 L-34 -26 H34 L40 -8z', class: 'b-roof roof-book' }));
      for (let i = 0; i < 6; i++) add(s('path', { d: `M${-36 + i * 12} -8 h12 q-6 8 -12 0z`, class: i % 2 ? 'awn-a' : 'awn-b' }));
      add(s('rect', { x: -26, y: 6, width: 30, height: 20, rx: 2, class: 'b-win' }));
      ['#b9605a', '#6f9a63', '#5f8fb0', '#c4a23c', '#8b6bb0'].forEach((c, i) => add(s('rect', { x: -24 + i * 5.6, y: 10 + (i % 2) * 2, width: 4, height: 16 - (i % 2) * 2, fill: c, class: 'book' })));
      add(s('rect', { x: 10, y: 8, width: 16, height: 26, rx: 8, class: 'b-door' }));
      add(s('rect', { x: -14, y: -22, width: 28, height: 10, rx: 2, class: 'b-sign' }));
      break;
    case 'kitchen':
      add(s('ellipse', { cx: 0, cy: 34, rx: 46, ry: 6, class: 'b-shadow' }));
      add(s('rect', { x: -34, y: -8, width: 68, height: 42, rx: 3, class: 'b-wall' }));
      add(s('path', { d: 'M-42 -6 L-30 -26 H30 L42 -6z', class: 'b-roof roof-kitchen' }));
      add(s('rect', { x: -24, y: -42, width: 9, height: 18, class: 'b-wall' }));
      add(s('circle', { cx: -19, cy: -48, r: 5, class: 'smoke' }));
      add(s('circle', { cx: -14, cy: -58, r: 7, class: 'smoke s2' }));
      win(-26, 4, 14, 12);
      win(10, 4, 14, 12);
      add(s('rect', { x: -8, y: 14, width: 16, height: 20, rx: 2, class: 'b-door' }));
      add(s('path', { d: 'M-26 22 h14 M12 22 h14', class: 'b-ink' }));
      break;
    case 'garden':
      add(s('ellipse', { cx: 0, cy: 30, rx: 50, ry: 8, class: 'b-shadow' }));
      add(s('path', { d: 'M-48 26 h96', class: 'b-ink' }));
      for (let i = -4; i <= 4; i++) add(s('path', { d: `M${i * 11} 26 v-12`, class: 'fence' }));
      add(s('path', { d: 'M-48 18 h96', class: 'fence' }));
      add(s('path', { d: 'M-26 14 v-22 a16 16 0 0 1 32 0 v22z', class: 'b-wall glass' }));
      add(s('path', { d: 'M-10 -18 v32 M-26 -2 h32', class: 'b-ink' }));
      [
        [-40, 8, '#b9605a'],
        [-30, 12, '#c4a23c'],
        [22, 10, '#c77a96'],
        [32, 6, '#8b6bb0'],
        [42, 12, '#c4a23c'],
      ].forEach(([x, y, c]) => {
        add(s('path', { d: `M${x} ${y} v10`, class: 'stem' }));
        add(s('circle', { cx: x, cy: y, r: 5, fill: c, class: 'bloom' }));
      });
      break;
    case 'arcade':
      add(s('ellipse', { cx: 0, cy: 34, rx: 46, ry: 6, class: 'b-shadow' }));
      add(s('rect', { x: -34, y: -12, width: 68, height: 46, rx: 3, class: 'b-wall' }));
      add(s('path', { d: 'M-40 -10 L-34 -30 H34 L40 -10z', class: 'b-roof roof-arcade' }));
      for (let i = 0; i < 7; i++) add(s('circle', { cx: -30 + i * 10, cy: -20, r: 2.4, class: 'bulb', style: `animation-delay:${i * 0.18}s` }));
      add(s('rect', { x: -22, y: -4, width: 44, height: 20, rx: 3, class: 'b-win' }));
      add(s('rect', { x: -9, y: -2, width: 18, height: 18, rx: 4, class: 'die-face' }));
      add(s('circle', { cx: -4, cy: 3, r: 1.8, class: 'pip' }));
      add(s('circle', { cx: 4, cy: 11, r: 1.8, class: 'pip' }));
      add(s('circle', { cx: 0, cy: 7, r: 1.8, class: 'pip' }));
      add(s('rect', { x: -7, y: 20, width: 14, height: 14, rx: 2, class: 'b-door' }));
      break;
    case 'plaza':
      add(s('circle', { r: 50, class: 'plaza-ring' }));
      add(s('circle', { r: 38, class: 'plaza-inner' }));
      add(s('circle', { r: 26, class: 'plaza-fount' }));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        add(s('path', { d: `M${Math.cos(a) * 40} ${Math.sin(a) * 40} L${Math.cos(a) * 49} ${Math.sin(a) * 49}`, class: 'b-ink faint' }));
      }
      add(s('path', { d: 'M0 14 V-26', class: 'post' }));
      add(s('path', { d: 'M-8 -26 H8 L5 -40 H-5z', class: 'b-lantern lamp-cap' }));
      add(s('path', { d: 'M-9 -26 h18', class: 'b-ink' }));
      add(s('path', { d: 'M-4 18 q4 6 8 0', class: 'b-ink faint' }));
      break;
    case 'residential':
      add(s('ellipse', { cx: 0, cy: 38, rx: 62, ry: 7, class: 'b-shadow' }));
      [
        [-48, 0, 26, 'roof-r1'],
        [-14, -12, 28, 'roof-r2'],
        [20, -2, 26, 'roof-r3'],
        [50, 6, 22, 'roof-r1'],
      ].forEach(([x, y, w, rc]) => {
        const xx = /** @type {number} */ (x);
        const yy = /** @type {number} */ (y);
        const ww = /** @type {number} */ (w);
        add(s('rect', { x: xx - ww / 2, y: yy, width: ww, height: 30, rx: 2, class: 'b-wall' }));
        add(s('path', { d: `M${xx - ww / 2 - 4} ${yy + 2} L${xx} ${yy - 18} L${xx + ww / 2 + 4} ${yy + 2}z`, class: `b-roof ${rc}` }));
        add(s('rect', { x: xx - 4.5, y: yy + 8, width: 9, height: 9, rx: 1.5, class: 'b-win' }));
        add(s('rect', { x: xx - 3, y: yy + 22, width: 6, height: 8, rx: 1.5, class: 'b-door' }));
      });
      break;
    default:
      break;
  }
  return g;
}

/**
 * @param {SVGGElement} g
 * @param {string} weatherId
 * @param {boolean} night
 */
function drawSky(g, weatherId, night) {
  g.replaceChildren();
  const hide = weatherId === 'rain' || weatherId === 'cloudy';
  if (night) {
    if (!hide) {
      g.appendChild(s('path', { d: 'M596 28 a20 20 0 1 0 14 34 a15 15 0 1 1 -14 -34z', class: 'moon' }));
      [
        [540, 26],
        [514, 52],
        [560, 70],
        [470, 22],
        [430, 48],
        [262, 24],
        [190, 40],
      ].forEach(([x, y], i) => g.appendChild(s('circle', { cx: x, cy: y, r: i % 2 ? 1.4 : 2, class: 'star', style: `animation-delay:${i * 0.4}s` })));
    }
  } else if (!hide) {
    g.appendChild(s('circle', { cx: 598, cy: 46, r: 17, class: 'sun' }));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.appendChild(s('path', { d: `M${598 + Math.cos(a) * 24} ${46 + Math.sin(a) * 24} L${598 + Math.cos(a) * 31} ${46 + Math.sin(a) * 31}`, class: 'sun-ray' }));
    }
  }
}

/**
 * @param {SVGGElement} g
 * @param {string} weatherId
 */
function drawWeather(g, weatherId) {
  g.replaceChildren();
  const cloud = (x, y, k, delay) => g.appendChild(s('g', { class: 'cloud', style: `animation-delay:${delay}s`, transform: `translate(${x} ${y}) scale(${k})` }, s('path', { d: 'M-30 8 a14 14 0 0 1 4 -27 a20 20 0 0 1 38 -4 a15 15 0 0 1 14 31z' })));
  if (weatherId === 'rain') {
    cloud(120, 40, 1.4, 0);
    cloud(360, 30, 1.7, -4);
    cloud(560, 56, 1.3, -8);
    for (let i = 0; i < 46; i++) {
      const x = (i * 97) % W;
      const y = (i * 53) % H;
      g.appendChild(s('line', { x1: x, y1: y, x2: x - 5, y2: y + 15, class: 'drop', style: `animation-delay:${-(i % 9) * 0.11}s` }));
    }
  } else if (weatherId === 'cloudy') {
    cloud(150, 50, 1.3, 0);
    cloud(420, 34, 1.6, -5);
    cloud(580, 70, 1.1, -9);
  } else if (weatherId === 'breeze') {
    for (let i = 0; i < 6; i++) g.appendChild(s('path', { d: 'M0 0 q8 -6 16 0 q-8 6 -16 0z', class: 'leaf', transform: `translate(${60 + i * 100} ${80 + (i % 3) * 140})`, style: `animation-delay:${-i * 1.3}s` }));
  }
}
