/**
 * 从代码生成 docs/GAMES.md（游戏规则与选项）和 docs/TOOLS.md（MCP 工具参考），保证文档与实现一致。
 *   npx tsx scripts/gen-docs.ts
 */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GameManager } from '../src/core/manager.js';
import { createRegistry } from '../src/games/index.js';
import { Authenticator } from '../src/mcp/auth.js';
import { createMcpServer } from '../src/mcp/server.js';

const registry = createRegistry();
const parts: string[] = [
  '# 游戏规则',
  '',
  '> 本文件由 `npx tsx scripts/gen-docs.ts` 根据代码中的游戏定义自动生成，请勿手改。',
  '> 运行时也可以通过 `get_rules` 工具或 `botgame://rules/{game_type}` 资源获取。',
  '',
  '| 类型 | 名称 | 人数 | 简介 |',
  '|---|---|---|---|',
  ...registry.list().map((d) => `| \`${d.type}\` | ${d.name} | ${d.minPlayers}~${d.maxPlayers} | ${d.summary} |`),
  '',
];
for (const d of registry.list()) {
  parts.push(`---\n\n# ${d.name}（\`${d.type}\`）\n`);
  parts.push(`别名：${d.aliases.map((a) => `\`${a}\``).join('、')}　对局 ID 前缀：\`${d.idPrefix}-\`\n`);
  parts.push(d.rules.replace(/^## /m, '## 规则：'));
  parts.push('\n### 选项（create_game 的 options）\n');
  parts.push('| 选项 | 说明 |\n|---|---|');
  for (const [k, v] of Object.entries(d.optionsHelp)) parts.push(`| \`${k}\` | ${v.replace(/\|/g, '\\|')} |`);
  if (d.playerTips) parts.push(`\n### 给 AI 玩家的提示\n\n${d.playerTips}`);
  parts.push('');
}
writeFileSync(new URL('../docs/GAMES.md', import.meta.url), `${parts.join('\n')}\n`);
console.log('docs/GAMES.md 已生成');

async function genTools(): Promise<void> {
  const manager = new GameManager({ registry });
  const auth = new Authenticator({ mode: 'open', adminKeys: [], agents: [] }, manager);
  const server = createMcpServer({ manager, auth, version: 'docs' }, { identity: null, fixed: false, transport: 'memory' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs', version: '1' });
  await server.connect(b);
  await client.connect(a);
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();
  const { prompts } = await client.listPrompts();
  const out: string[] = [
    '# MCP 接口参考',
    '',
    '> 本文件由 `npx tsx scripts/gen-docs.ts` 自动生成，请勿手改。',
    '',
    `共 ${tools.length} 个工具。所有工具返回一个 JSON 文本块；业务错误以 \`isError: true\` 的工具结果返回（含中文原因与建议），不会是协议错误。`,
    '',
    '## 工具',
    '',
  ];
  for (const t of tools) {
    const props = (t.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string; enum?: string[] }>;
    const req = new Set((t.inputSchema.required as string[] | undefined) ?? []);
    const ann = t.annotations ?? {};
    const flags = [ann.readOnlyHint ? '只读' : '', ann.destructiveHint ? '破坏性' : '', ann.idempotentHint ? '幂等' : ''].filter(Boolean);
    out.push(`### \`${t.name}\` —— ${t.title ?? ''}${flags.length ? `（${flags.join('、')}）` : ''}`, '', t.description ?? '', '');
    const entries = Object.entries(props);
    if (entries.length) {
      out.push('| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|');
      for (const [k, v] of entries) {
        const type = v.enum ? v.enum.map((e) => `\`${e}\``).join(' / ') : (v.type ?? 'object');
        out.push(`| \`${k}\` | ${type} | ${req.has(k) ? '是' : ''} | ${(v.description ?? '').replace(/\|/g, '\\|')} |`);
      }
    } else out.push('无参数。');
    out.push('');
  }
  out.push('## 资源', '');
  for (const r of resources) out.push(`- \`${r.uri}\` —— ${r.title ?? r.name}`);
  for (const r of resourceTemplates) out.push(`- \`${r.uriTemplate}\` —— ${r.title ?? r.name}`);
  out.push('', '## 提示词（prompts）', '');
  for (const p of prompts) out.push(`- \`${p.name}\` —— ${p.title ?? ''}：${p.description ?? ''}`);
  writeFileSync(new URL('../docs/TOOLS.md', import.meta.url), `${out.join('\n')}\n`);
  console.log('docs/TOOLS.md 已生成');
  await client.close();
}

await genTools();
