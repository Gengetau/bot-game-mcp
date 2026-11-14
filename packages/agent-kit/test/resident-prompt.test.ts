/**
 * 居民提示词：文件和代码一致，并且和引擎的 TOWN_GUIDE、docs/TOWN.md 的动作表对得上。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOWN_GUIDE, TOWN_NOT_ADMITTED } from 'bot-game-mcp';
import { RESIDENT_PROMPT_ZH, TOWN_ACTION_TYPES, residentPrompt } from '../src/index.js';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('residentPrompt', () => {
  it('prompts/resident-zh.md 和 residentPrompt() 一致（工具前缀用 {p} 占位）', () => {
    expect(read('../prompts/resident-zh.md').trim()).toBe(residentPrompt({ toolPrefix: '{p}' }).trim());
    expect(RESIDENT_PROMPT_ZH.trim()).toBe(residentPrompt().trim());
  });

  it('工具前缀可配置', () => {
    expect(residentPrompt({ toolPrefix: 'mcp_botgame_' })).toContain('mcp_botgame_world_act');
    expect(residentPrompt({ toolPrefix: 'mcp_botgame_' })).not.toContain('{p}');
  });

  it('提到每个动作类型', () => {
    const text = residentPrompt();
    for (const t of TOWN_ACTION_TYPES) expect(text, t).toContain(t);
  });

  it('动作类型覆盖 docs/TOWN.md 动作表里的每一个', () => {
    const doc = read('../../../docs/TOWN.md');
    const from = doc.indexOf('### 动作一览');
    const rest = doc.slice(from + 10);
    const end = rest.search(/\n#{2,3} /);
    const section = end < 0 ? rest : rest.slice(0, end);
    const names = new Set<string>();
    for (const line of section.split('\n')) {
      const m = /^\| ((?:`[a-z_]+`(?: \/ )?)+) \|/.exec(line);
      if (!m) continue;
      for (const n of m[1]!.matchAll(/`([a-z_]+)`/g)) names.add(n[1]!);
    }
    names.delete('type');
    expect(names.size).toBeGreaterThan(20);
    for (const n of names) expect(TOWN_ACTION_TYPES as readonly string[], n).toContain(n);
  });

  it('和引擎 TOWN_GUIDE 里提到的工具、关键字段一致', () => {
    const text = residentPrompt({ toolPrefix: '' });
    for (const tool of ['enter_world', 'get_my_view', 'world_act', 'world_wait', 'leave_world']) {
      expect(TOWN_GUIDE, tool).toContain(tool);
      expect(text, tool).toContain(tool);
    }
    for (const word of ['request_id', 'action_window', 'cursor']) {
      expect(TOWN_GUIDE, word).toContain(word);
      expect(text, word).toContain(word);
    }
  });

  it('「不在进镇名单里」：指南、居民提示词和引擎的固定拒绝文案对得上', () => {
    const key = '不在进镇名单里';
    expect(TOWN_NOT_ADMITTED).toContain(key);
    expect(TOWN_GUIDE).toContain(key);
    expect(residentPrompt()).toContain(key);
    expect(residentPrompt()).toContain('不要重试');
    expect(TOWN_GUIDE).toContain('不要重试');
  });
});
