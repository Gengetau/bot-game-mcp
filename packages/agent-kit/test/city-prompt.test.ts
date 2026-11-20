/**
 * 晴空都居民提示词契约单测：
 *  1. 验证 prompts/city-resident-zh.md 与 cityResidentPrompt({ toolPrefix: '{p}' }) 字节级完全一致（Buffer.compare === 0）；
 *  2. 验证工具名前缀注入、核心 MCP 工具名、M1 全部城市动作与关键安全红线词完整覆盖。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CITY_ACTION_TYPES,
  CITY_RESIDENT_PROMPT_ZH,
  cityResidentPrompt,
} from '../src/index.js';

const PROMPT_FILE = new URL('../prompts/city-resident-zh.md', import.meta.url);
const CONTRACT_FILE = new URL('../../../docs/city/CLIENT-AND-WEB-CONTRACT.md', import.meta.url);

describe('cityResidentPrompt', () => {
  it('prompts/city-resident-zh.md 与 cityResidentPrompt({ toolPrefix: "{p}" }) 字节级完全一致', () => {
    const fileBytes = readFileSync(PROMPT_FILE);
    const generatedBytes = Buffer.from(cityResidentPrompt({ toolPrefix: '{p}' }), 'utf8');
    expect(Buffer.compare(fileBytes, generatedBytes)).toBe(0);
    expect(fileBytes.toString('utf8')).toBe(cityResidentPrompt({ toolPrefix: '{p}' }));
    expect(CITY_RESIDENT_PROMPT_ZH).toBe(cityResidentPrompt());
  });

  it('支持自定义 toolPrefix 且不残留 {p} 占位符', () => {
    const prefixed = cityResidentPrompt({ toolPrefix: 'mcp__city__' });
    expect(prefixed).toContain('mcp__city__enter_world');
    expect(prefixed).toContain('mcp__city__world_act');
    expect(prefixed).toContain('mcp__city__claim_control');
    expect(prefixed).toContain('mcp__city__leave_world');
    expect(prefixed).not.toContain('{p}');
  });

  it('覆盖 M0/M1 冻结工具集、全部外部居民动作与安全红线条款', () => {
    const text = cityResidentPrompt();
    for (const tool of [
      'enter_world',
      'get_my_view',
      'speak',
      'world_act',
      'world_wait',
      'world_query',
      'heartbeat',
      'claim_control',
      'leave_world',
    ]) {
      expect(text, `缺少工具 ${tool}`).toContain(tool);
    }
    for (const act of CITY_ACTION_TYPES) {
      expect(text, `缺少动作 ${act}`).toContain(act);
    }
    for (const token of [
      'world_id',
      'city',
      '晴空都',
      'request_id',
      'locker_items',
      'carry_home:false',
      'CONTROL_LOST',
      'ENTRY_VIA_HOME_ONLY',
      'RECOVERING',
      'RATE_LIMITED',
      'PRECONDITION_FAILED',
      'untrusted:true',
      'trip_progress',
    ]) {
      expect(text, `缺少关键规则词 ${token}`).toContain(token);
    }
    // 与 M0 冻结客户端契约文档核心工具保持一致
    const contractDoc = readFileSync(CONTRACT_FILE, 'utf8');
    for (const shared of ['enter_world', 'get_my_view', 'world_act', 'world_wait', 'world_query', 'claim_control', 'heartbeat', 'leave_world']) {
      expect(contractDoc).toContain(shared);
    }
  });
});
