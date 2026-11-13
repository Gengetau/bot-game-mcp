#!/usr/bin/env node
/**
 * 对导出目录顶层的 .wasm/.pck/.js/.css 生成 .br / .gz 预压缩副本（引擎优先发预压缩副本）。
 *   node client/tools/compress.mjs <目录> [文件名…]     不给文件名就处理全部；给了只处理这些（并先删它们旧的 .br/.gz）
 * 环境变量 BROTLI_QUALITY（默认 11）。
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { join, resolve } from 'node:path';

if (!process.argv[2]) {
  console.error('用法：node compress.mjs <目录> [文件名…]');
  process.exit(2);
}
const dir = resolve(process.argv[2]);
const only = process.argv.slice(3);
const q = Number(process.env.BROTLI_QUALITY ?? 11);
if (!only.length) for (const f of readdirSync(dir)) if (/\.(br|gz)$/.test(f)) rmSync(join(dir, f));
const targets = only.length ? only : readdirSync(dir).filter((f) => /\.(wasm|pck|js|css)$/.test(f));
for (const f of targets) {
  const p = join(dir, f);
  for (const ext of ['.br', '.gz']) if (existsSync(p + ext)) rmSync(p + ext);
  if (!existsSync(p) || !/\.(wasm|pck|js|css)$/.test(f)) continue;
  const buf = readFileSync(p);
  writeFileSync(p + '.gz', gzipSync(buf, { level: 9 }));
  writeFileSync(p + '.br', brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: q, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }));
}
