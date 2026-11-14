/**
 * 居民提示词：文件和代码一致，并且和引擎的 TOWN_GUIDE、docs/TOWN.md 的动作表对得上。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOWN_GUIDE, TOWN_NOT_ADMITTED, townParamsSchema } from 'bot-game-mcp';
import { DEFAULT_TUNING, RESIDENT_PROMPT_ZH, TOWN_ACTION_TYPES, residentPrompt } from '../src/index.js';

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
  it('附近聊天的叫醒说明：指南和居民提示词都有，且不再说「全部」', () => {
    for (const [name, text] of [['TOWN_GUIDE', TOWN_GUIDE], ['residentPrompt', residentPrompt()]] as const) {
      expect(text, name).toContain('here.chat');
      expect(text, name).toContain('攒一攒');
      expect(text, name).toContain('不要为了「不漏话」缩短等待去轮询');
      // here.chat 只有最近 20 条、30 分钟内：文字不能说成「全部」，并要指路到更早的历史
      expect(text, name).not.toContain('错过的全部的话');
      expect(text, name).toContain('最多 20 条、30 分钟内');
      expect(text, name).toContain('history');
    }
  });

  it('docs/TOWN-BOTS.md 里的数字和 DEFAULT_TUNING、town 参数默认值一致', () => {
    const doc = read('../../../docs/TOWN-BOTS.md');
    const P = townParamsSchema.parse({});
    const T = DEFAULT_TUNING;
    const sec = (ms: number) => ms / 1000;
    const expected = [
      `每小时最多 ${T.budgetPerHour} 次决策`,
      `至少隔 ${sec(T.minIntervalMs)} 秒`,
      `安静 ${sec(T.debounceMs)} 秒才决策，最多拖 ${sec(T.debounceMaxMs)} 秒`,
      `决策超时 ${sec(T.decideTimeoutMs)} 秒`,
      `每轮长轮询 ${T.waitSeconds} 秒`,
      `每位 AI 听者的叫醒额度是突发 ${P.nearbyWakeBurst} 次、每小时恢复 ${P.nearbyWakePerHour} 次`,
      `同一位发言者对你是突发 ${P.nearbyWakePairBurst} 次、每小时恢复 ${P.nearbyWakePairPerHour} 次`,
      `每分钟最多 ${P.chatPerMinute} 句、突发 ${P.chatBurst} 句，每句最多 ${P.chatMaxChars} 字`,
      `公屏每分钟最多 ${P.townChatPerMinute} 条、突发 ${P.townChatBurst} 条`,
      `同时在场的居民有上限，默认 ${P.activeResidentLimit}`,
    ];
    for (const e of expected) expect(doc, e).toContain(e);
    // 指路到的文档和工具真的存在
    expect(doc).toContain('最多 20 条、30 分钟内');
    for (const f of ['ONBOARDING.md', 'TOOLS.md', 'TOWN.md']) expect(doc, f).toContain(f);
    expect(read(`../../../docs/${'ONBOARDING.md'}`)).toContain('撤销密钥');
  });
});
