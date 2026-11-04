/**
 * 转盘结果图渲染器：纯 TypeScript、零依赖，输出 PNG。
 *
 * 用于裁判在群里公布「抽裁判」之类的程序抽签结果：
 * 扇区按候选顺序顺时针排布，整个转盘旋转到抽中扇区的中心正对 12 点方向，
 * 顶部画一个指针三角形。文字使用 GNU Unifont（可选）或内置 5x7 点阵。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';

export interface WheelOptions {
  /** 候选名字（扇区按这个顺序顺时针排布） */
  options: string[];
  /** 抽中的下标 */
  picked: number;
  title?: string; // 默认 '抽裁判'
  footer?: string; // 比如 '程序抽签 · 对局 WW-ABCD'
  /** GNU Unifont .hex 或 .hex.gz 文件路径；没有时中文用占位方块，但数字/ASCII 仍用内置 5x7 字体画 */
  fontPath?: string;
}

type RGB = readonly [number, number, number];

const W = 720;
const H = 960;
const CX = 360;
const CY = 400;
const R = 300;
const BG: RGB = [250, 246, 238];
const INK: RGB = [40, 40, 52];
const HILITE: RGB = [255, 92, 92];
const PALETTE: RGB[] = [
  [255, 214, 165],
  [253, 255, 182],
  [202, 255, 191],
  [155, 246, 255],
  [160, 196, 255],
  [189, 178, 255],
  [255, 198, 255],
  [255, 173, 173],
  [214, 232, 200],
  [222, 205, 180],
];

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

/** 内置 5x7 点阵：每个字形 7 行，每行 5 位（高位在左）。 */
const FONT_5X7: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  ':': [0, 4, 0, 0, 0, 4, 0],
  '.': [0, 0, 0, 0, 0, 0, 4],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '…': [0, 0, 0, 0, 0, 0, 21],
  _: [0, 0, 0, 0, 0, 0, 31],
  '·': [0, 0, 0, 4, 0, 0, 0],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  a: [0, 0, 14, 1, 15, 17, 15],
  b: [16, 16, 22, 25, 17, 17, 30],
  c: [0, 0, 14, 16, 16, 17, 14],
  d: [1, 1, 13, 19, 17, 17, 15],
  e: [0, 0, 14, 17, 31, 16, 14],
  f: [6, 9, 8, 28, 8, 8, 8],
  g: [0, 15, 17, 17, 15, 1, 14],
  h: [16, 16, 22, 25, 17, 17, 17],
  i: [4, 0, 12, 4, 4, 4, 14],
  j: [2, 0, 6, 2, 2, 18, 12],
  k: [16, 16, 18, 20, 24, 20, 18],
  l: [12, 4, 4, 4, 4, 4, 14],
  m: [0, 0, 26, 21, 21, 21, 21],
  n: [0, 0, 22, 25, 17, 17, 17],
  o: [0, 0, 14, 17, 17, 17, 14],
  p: [0, 0, 30, 17, 30, 16, 16],
  q: [0, 0, 15, 17, 15, 1, 1],
  r: [0, 0, 22, 25, 16, 16, 16],
  s: [0, 0, 15, 16, 14, 1, 30],
  t: [8, 8, 28, 8, 8, 9, 6],
  u: [0, 0, 17, 17, 17, 19, 13],
  v: [0, 0, 17, 17, 17, 10, 4],
  w: [0, 0, 17, 17, 21, 21, 10],
  x: [0, 0, 17, 10, 4, 10, 17],
  y: [0, 0, 17, 17, 15, 1, 14],
  z: [0, 0, 31, 2, 4, 8, 31],
};

const unifontCache = new Map<string, Map<number, string>>();

/** 读入 Unifont hex（支持 .gz）；结果按路径缓存；文件不存在或读取失败返回 null。 */
export function loadUnifont(path: string): Map<number, string> | null {
  const hit = unifontCache.get(path);
  if (hit) return hit;
  if (!existsSync(path)) return null;
  let text: string;
  try {
    const raw = readFileSync(path);
    text = (path.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  } catch {
    return null;
  }
  const map = new Map<number, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const hex = line.slice(i + 1).trim();
    if (hex.length !== 32 && hex.length !== 64) continue;
    const cp = parseInt(line.slice(0, i), 16);
    if (Number.isFinite(cp)) map.set(cp, hex);
  }
  unifontCache.set(path, map);
  return map;
}

/** 画布：RGB 8 位，每行前面预留 1 字节 PNG 滤波类型（0）。 */
class Canvas {
  readonly stride = 1 + W * 3;
  readonly raw = Buffer.alloc(H * (1 + W * 3));
  px(x: number, y: number, c: RGB): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = y * this.stride + 1 + x * 3;
    this.raw[o] = c[0];
    this.raw[o + 1] = c[1];
    this.raw[o + 2] = c[2];
  }
  fill(c: RGB): void {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.px(x, y, c);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }
}

/** 一个字符在给定缩放下占的宽度（像素）。 */
function advance(ch: string, scale: number, font: Map<number, string> | null): number {
  const g = font?.get(ch.codePointAt(0)!);
  if (g) return (g.length === 32 ? 8 : 16) * scale;
  const f = FONT_5X7[ch === '：' ? ':' : ch];
  return f ? 12 * scale : 16 * scale;
}

function textWidth(s: string, scale: number, font: Map<number, string> | null): number {
  let w = 0;
  for (const ch of s) w += advance(ch, scale, font);
  return w;
}

/** 在 (x, y) 左上角处画一行文字，字格高 16*scale。 */
function drawText(cv: Canvas, s: string, x: number, y: number, scale: number, font: Map<number, string> | null): void {
  for (const ch of s) {
    const adv = advance(ch, scale, font);
    const g = font?.get(ch.codePointAt(0)!);
    if (g) {
      const cols = g.length === 32 ? 8 : 16;
      const hexPerRow = cols / 4;
      for (let r = 0; r < 16; r++) {
        const bits = parseInt(g.slice(r * hexPerRow, (r + 1) * hexPerRow), 16);
        for (let c = 0; c < cols; c++) {
          if (bits & (1 << (cols - 1 - c))) cv.rect(x + c * scale, y + r * scale, scale, scale, INK);
        }
      }
    } else {
      const f = FONT_5X7[ch === '：' ? ':' : ch];
      if (f) {
        const s2 = scale * 2; // 5x7 放大两倍后约 10x14，刚好落进 16 像素字格
        for (let r = 0; r < 7; r++) {
          for (let c = 0; c < 5; c++) {
            if (f[r]! & (1 << (4 - c))) cv.rect(x + (1 + c) * s2, y + (1 + r) * s2, s2, s2, INK);
          }
        }
      } else if (ch.trim() !== '') {
        // 没有字形：画空心方块占位
        const t = Math.max(1, scale);
        const bx = x + scale, by = y + scale, bw = 14 * scale, bh = 14 * scale;
        cv.rect(bx, by, bw, t, INK);
        cv.rect(bx, by + bh - t, bw, t, INK);
        cv.rect(bx, by, t, bh, INK);
        cv.rect(bx + bw - t, by, t, bh, INK);
      }
    }
    x += adv;
  }
}

function drawCentered(cv: Canvas, s: string, cx: number, y: number, scale: number, font: Map<number, string> | null): void {
  drawText(cv, s, Math.round(cx - textWidth(s, scale, font) / 2), y, scale, font);
}

/** 超过 max 个字符就截断并加「…」（总长不超过 max）。 */
function truncate(s: string, max: number): string {
  const a = Array.from(s);
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : s;
}

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // 颜色类型：RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 转盘
// ---------------------------------------------------------------------------

/** 渲染转盘结果图，返回 PNG 的 Buffer（RGB 8 位，不带 alpha）。 */
export function renderWheel(opts: WheelOptions): Buffer {
  const names = opts.options;
  const n = names.length;
  if (n < 1) throw new Error('renderWheel: options 不能为空');
  const picked = Math.min(Math.max(0, Math.trunc(opts.picked)), n - 1);
  const font = opts.fontPath ? loadUnifont(opts.fontPath) : null;
  const cv = new Canvas();
  cv.fill(BG);

  const TAU = Math.PI * 2;
  const w = TAU / n; // 每个扇区的角度
  const shift = (picked + 0.5) * w; // 旋转量：抽中扇区中心转到 12 点
  for (let y = CY - R; y <= CY + R; y++) {
    for (let x = CX - R; x <= CX + R; x++) {
      const dx = x - CX, dy = y - CY;
      const d2 = dx * dx + dy * dy;
      if (d2 > (R + 1.5) * (R + 1.5)) continue;
      const r = Math.sqrt(d2);
      if (r > R + 1.5) continue;
      if (r > R - 1.5) {
        cv.px(x, y, INK); // 外圈轮廓
        continue;
      }
      let theta = Math.atan2(dx, -dy) + shift; // 自 12 点顺时针
      theta = ((theta % TAU) + TAU) % TAU;
      const idx = Math.min(n - 1, Math.floor(theta / w));
      const m = theta - idx * w;
      if (n > 1 && r > 2 && Math.min(m, w - m) * r < 1) {
        cv.px(x, y, INK); // 扇区分隔线
        continue;
      }
      cv.px(x, y, idx === picked ? HILITE : PALETTE[idx % PALETTE.length]!);
    }
  }

  // 指针：顶部向下的三角形，尖端指向抽中扇区
  for (let y = 70; y <= 122; y++) {
    const half = Math.round(24 * (122 - y) / 52);
    for (let x = CX - half; x <= CX + half; x++) cv.px(x, y, INK);
  }

  // 扇区标签
  const lscale = n > 10 ? 1 : 2;
  const lr = R * 0.6;
  for (let i = 0; i < n; i++) {
    const a = (i + 0.5) * w - shift;
    const lx = CX + lr * Math.sin(a);
    const ly = CY - lr * Math.cos(a);
    drawCentered(cv, truncate(names[i]!, 6), lx, Math.round(ly - 8 * lscale), lscale, font);
  }

  drawCentered(cv, opts.title ?? '抽裁判', CX, 14, 3, font);
  drawCentered(cv, `抽中：${truncate(names[picked]!, 10)}`, CX, 740, 3, font);
  if (opts.footer) {
    let f = Array.from(opts.footer);
    while (f.length > 1 && textWidth(f.join(''), 2, font) > W - 40) f = [...f.slice(0, -2), '…'];
    drawCentered(cv, f.join(''), CX, 880, 2, font);
  }

  return encodePng(cv.raw);
}
