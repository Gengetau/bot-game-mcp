#!/usr/bin/env node
/**
 * 把 client/town/web/mod/ 下的模块合并进导出目录：
 *   node client/tools/assemble.mjs <导出目录> <web 目录>
 *  1) 每个 mod/*.js 做语法检查（node --check）和 lint（lint-web.mjs），任何一条不过就失败；
 *  2) mod/*.js 按文件名排序（00-chatkit.js 先）用「换行;换行」连接，开头加 window.TownBuild，写成 town-modules.js；
 *     mod/*.css 同理写成 town-modules.css（没有模块时也生成空文件，shell.html 总是引用它）；
 *  3) mod/*.html 排序拼接，替换 index.html 里的 <!--TOWN:TEMPLATES-->（标记缺失就失败）；
 *     第一次注入前把原始 index.html 存成 .index.raw.html（点开头，引擎不发），web-only.sh 靠它重新注入；
 *  4) 打印模块清单和大小。
 * 注意：web/ 下不要放会被 Godot 当资源导入的文件；图标用模板内联 SVG，不加图片 / 字体文件（CSP 的 font-src 只有 self）。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintJs, lintHtml } from './lint-web.mjs';

if (!process.argv[2] || !process.argv[3]) {
  console.error('用法：node assemble.mjs <导出目录> <web 目录>');
  process.exit(2);
}
const OUT = resolve(process.argv[2]);
const WEB = resolve(process.argv[3]);
const MARK = '<!--TOWN:TEMPLATES-->';
const MOD = join(WEB, 'mod');
const files = existsSync(MOD) ? readdirSync(MOD).sort() : [];
const by = (ext) => files.filter((f) => f.endsWith(ext));
const problems = [];

for (const f of by('.js')) {
  const p = join(MOD, f);
  const chk = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (chk.status !== 0) problems.push(`mod/${f}: 语法错误\n${chk.stderr}`);
  problems.push(...lintJs(`mod/${f}`, readFileSync(p, 'utf8')));
}
for (const f of by('.html')) problems.push(...lintHtml(`mod/${f}`, readFileSync(join(MOD, f), 'utf8')));
if (problems.length) {
  console.error(`[assemble] 网页模块检查没过（${problems.length} 条）：`);
  for (const m of problems) console.error('  - ' + m);
  process.exit(1);
}

const jsParts = by('.js').map((f) => readFileSync(join(MOD, f), 'utf8'));
const stamp = `window.TownBuild={mods:${JSON.stringify(by('.js').map((f) => f.replace(/\.js$/, '')))},t:${JSON.stringify(new Date().toISOString())}};`;
writeFileSync(join(OUT, 'town-modules.js'), [stamp, ...jsParts].join('\n;\n') + '\n');
writeFileSync(join(OUT, 'town-modules.css'), by('.css').map((f) => readFileSync(join(MOD, f), 'utf8')).join('\n') + '\n');

const idx = join(OUT, 'index.html');
const raw = join(OUT, '.index.raw.html');
if (!existsSync(idx)) {
  console.error('[assemble] 导出目录里没有 index.html');
  process.exit(1);
}
if (!existsSync(raw)) copyFileSync(idx, raw);
const html = readFileSync(raw, 'utf8');
if (!html.includes(MARK)) {
  console.error(`[assemble] index.html 里找不到注入标记 ${MARK}（Godot 导出把它改掉了？或 shell.html 里漏写）`);
  process.exit(1);
}
const tpl = by('.html').map((f) => readFileSync(join(MOD, f), 'utf8')).join('\n');
writeFileSync(idx, html.replace(MARK, () => tpl));

const size = (f) => readFileSync(join(OUT, f)).length;
console.log(`[assemble] 模块 ${by('.js').length} 个 js / ${by('.css').length} 个 css / ${by('.html').length} 个 html：town-modules.js ${size('town-modules.js')} 字节，town-modules.css ${size('town-modules.css')} 字节`);
for (const f of files) console.log(`           mod/${f}`);
