#!/usr/bin/env node
/**
 * 网页模块（client/town/web/mod/*）的静态检查。assemble.mjs 在导出时调用；也可单独跑：npm run client:lint。
 * 规则（客户端面板规格 §6.3、§6.4、§9）：
 *  - JS：不用 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval( / new Function / setAttribute('style'…)；
 *        不读写 localStorage / sessionStorage / indexedDB（聊天内容只放内存）；字符串字面量里不出现汉字（文字放 HTML 的文字库里）。
 *  - HTML：没有 <script>、没有内联事件处理器（on*=）。
 * 命中任何一条退出码 1，并给出 文件:行号。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MOD = resolve(HERE, '..', 'town', 'web', 'mod');

/** 去掉注释，保留字符串字面量的内容；同时返回「每个字符串字面量」(用来查汉字)。行号保持不变。 */
export function scanJs(src) {
  let code = '';
  const strings = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') {
          line++;
          code += '\n';
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      const startLine = line;
      let s = '';
      code += q;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          s += src[i] + (src[i + 1] ?? '');
          code += src[i] + (src[i + 1] ?? '');
          if (src[i + 1] === '\n') line++;
          i += 2;
          continue;
        }
        if (src[i] === '\n') line++;
        s += src[i];
        code += src[i];
        i++;
      }
      code += q;
      i++;
      strings.push({ s, line: startLine });
      continue;
    }
    if (c === '\n') line++;
    code += c;
    i++;
  }
  return { code, strings };
}

const BAD_JS = [
  [/\binnerHTML\b/, 'innerHTML'],
  [/\bouterHTML\b/, 'outerHTML'],
  [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bdocument\s*\.\s*write(ln)?\b/, 'document.write'],
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\blocalStorage\b/, 'localStorage（聊天相关代码不读写本机存储）'],
  [/\bsessionStorage\b/, 'sessionStorage（聊天相关代码不读写本机存储）'],
  [/\bindexedDB\b/, 'indexedDB（聊天相关代码不读写本机存储）'],
];

export function lintJs(file, src) {
  const out = [];
  const { code, strings } = scanJs(src);
  const lines = code.split('\n');
  lines.forEach((l, k) => {
    for (const [re, name] of BAD_JS) if (re.test(l)) out.push(`${file}:${k + 1}: 禁用 ${name}`);
    if (/setAttribute\s*\(\s*['"`]style['"`]/.test(l)) out.push(`${file}:${k + 1}: 禁用 setAttribute('style'…)`);
  });
  for (const { s, line } of strings) {
    if (/[㐀-鿿＀-￯　-〿]/.test(s)) out.push(`${file}:${line}: 字符串字面量里有汉字或中文标点（文字放 HTML 文字库，用 host.t）：${s.slice(0, 30)}`);
  }
  return out;
}

export function lintHtml(file, src) {
  const out = [];
  src.split('\n').forEach((l, k) => {
    if (/<script\b/i.test(l)) out.push(`${file}:${k + 1}: 模板里不能有 <script>`);
    if (/\son[a-z]+\s*=/i.test(l)) out.push(`${file}:${k + 1}: 不能有内联事件处理器`);
  });
  return out;
}

export function lintDir(modDir = DEFAULT_MOD) {
  const problems = [];
  if (!existsSync(modDir)) return problems;
  for (const f of readdirSync(modDir).sort()) {
    const p = join(modDir, f);
    if (f.endsWith('.js')) problems.push(...lintJs(`mod/${f}`, readFileSync(p, 'utf8')));
    else if (f.endsWith('.html')) problems.push(...lintHtml(`mod/${f}`, readFileSync(p, 'utf8')));
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_MOD;
  const problems = lintDir(dir);
  if (problems.length) {
    console.error(`[lint-web] ${problems.length} 条问题：`);
    for (const m of problems) console.error('  - ' + m);
    process.exit(1);
  }
  console.log(`[lint-web] 通过（${dir}）`);
}
