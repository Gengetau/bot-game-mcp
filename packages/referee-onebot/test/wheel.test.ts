import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { loadUnifont, renderWheel } from '../src/wheel.js';

const NAMES = ['小明', 'Alice', '王小花', 'Bob_7', '张三丰', 'Carol'];
const W = 720;
const H = 960;

function idat(png: Buffer): Buffer {
  const parts: Buffer[] = [];
  let p = 8;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  return Buffer.concat(parts);
}

function countColor(raw: Buffer, r: number, g: number, b: number): number {
  let n = 0;
  const stride = 1 + W * 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * stride + 1 + x * 3;
      if (raw[o] === r && raw[o + 1] === g && raw[o + 2] === b) n++;
    }
  }
  return n;
}

describe('renderWheel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wheel-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('输出合法 PNG，尺寸与解压长度正确，且包含高亮色', () => {
    const png = renderWheel({ options: NAMES, picked: 3, footer: '程序抽签 · 对局 WW-ABCD' });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(W);
    expect(png.readUInt32BE(20)).toBe(H);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(2);
    const raw = inflateSync(idat(png));
    expect(raw.length).toBe(H * (1 + W * 3));
    expect(countColor(raw, 255, 92, 92)).toBeGreaterThan(5000);
  });

  it('抽中不同扇区结果不同', () => {
    const a = renderWheel({ options: NAMES, picked: 0 });
    const b = renderWheel({ options: NAMES, picked: 3 });
    expect(a.equals(b)).toBe(false);
  });

  it('loadUnifont 解析 8x16 / 16x16 字形，缺文件返回 null', () => {
    const p = join(dir, 'tiny.hex');
    writeFileSync(p, `0041:${'18'.repeat(16)}\n4E2D:${'0FF0'.repeat(16)}\nbad line\n`);
    const f = loadUnifont(p)!;
    expect(f.size).toBe(2);
    expect(f.get(0x41)!.length).toBe(32);
    expect(f.get(0x4e2d)!.length).toBe(64);
    expect(loadUnifont(join(dir, 'nope.hex'))).toBeNull();
  });

  it('带字体与不带字体的图不同', () => {
    const p = join(dir, 'font.hex');
    writeFileSync(p, `0041:${'7E'.repeat(16)}\n4E2D:${'FFFF'.repeat(16)}\n`);
    const opts = { options: ['A', '中', 'B'], picked: 1 };
    const without = renderWheel(opts);
    const withFont = renderWheel({ ...opts, fontPath: p });
    expect(withFont.equals(without)).toBe(false);
  });
});
