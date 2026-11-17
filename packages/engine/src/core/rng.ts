import { randomInt } from 'node:crypto';

/**
 * 随机数源。生产环境使用密码学安全随机数（身份分配不可被预测），
 * 测试/模拟使用可复现的种子随机数。
 */
export interface Rng {
  /** [0, maxExclusive) 的整数。 */
  int(maxExclusive: number): number;
}

export class CryptoRng implements Rng {
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new RangeError('maxExclusive must be > 0');
    if (maxExclusive === 1) return 0;
    return randomInt(maxExclusive);
  }
}

/** sfc32 —— 小而快、质量足够的种子随机数，仅用于测试与模拟。 */
export class SeededRng implements Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    let h = 1779033703 ^ String(seed).length;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    const next = () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.float();
  }

  private float(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new RangeError('maxExclusive must be > 0');
    return Math.floor(this.float() * maxExclusive);
  }

  /** 导出内部状态（可序列化）。持续世界把它和候选状态一起提交，失败就丢弃。 */
  saveState(): string {
    return [this.a, this.b, this.c, this.d].map((n) => (n >>> 0).toString(36)).join('.');
  }

  /** 从 saveState() 的结果恢复，之后的随机序列和导出时完全一致。 */
  static restore(state: string): SeededRng {
    const parts = state.split('.').map((x) => Number.parseInt(x, 36));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new RangeError('bad rng state');
    const rng = new SeededRng(0);
    [rng.a, rng.b, rng.c, rng.d] = parts as [number, number, number, number];
    return rng;
  }

  clone(): SeededRng {
    return SeededRng.restore(this.saveState());
  }
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick from empty array');
  return items[rng.int(items.length)]!;
}

/** Fisher–Yates 洗牌，返回新数组。 */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 生成不易混淆的短码（用于对局 ID）。 */
export function shortCode(rng: Rng, length = 4): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[rng.int(CODE_ALPHABET.length)];
  return out;
}
