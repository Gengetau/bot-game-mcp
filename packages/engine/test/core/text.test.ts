import { describe, expect, it } from 'vitest';
import {
  isEndSpeech,
  isSkipWord,
  normalizeText,
  parseIntLoose,
  resolveSeat,
  sanitizeName,
  sanitizeUserText,
} from '../../src/core/text.js';
import type { Player } from '../../src/core/types.js';

const players: Player[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seat) => ({
  seat,
  id: String(10000 + seat),
  name: seat === 3 ? '小明' : seat === 4 ? '小明明' : `玩家${seat}`,
  kind: 'human',
  alive: true,
  selfPost: false,
}));

describe('parseIntLoose', () => {
  it.each([
    ['3', 3],
    ['３', 3],
    ['十', 10],
    ['十二', 12],
    ['二十', 20],
    ['二十五', 25],
    ['一百零五', 105],
    ['两', 2],
    ['九十九', 99],
    ['一二', 12],
  ])('%s → %d', (input, expected) => {
    expect(parseIntLoose(input)).toBe(expected);
  });

  it('rejects non-numbers', () => {
    expect(parseIntLoose('一下')).toBeNull();
    expect(parseIntLoose('abc')).toBeNull();
  });
});

describe('resolveSeat', () => {
  it.each([
    ['3', 3],
    ['3号', 3],
    ['三号', 3],
    ['十二号', 12],
    ['12号玩家', 12],
    ['[CQ:at,qq=10005]', 5],
    ['@小明', 3],
    ['@小明明', 4],
    ['小明', 3],
    ['五', 5],
  ])('%s → %d', (input, expected) => {
    expect(resolveSeat(input, players)).toBe(expected);
  });

  it('returns null for unknown or out of range', () => {
    expect(resolveSeat('13号', players)).toBeNull();
    expect(resolveSeat('一下', players)).toBeNull();
    expect(resolveSeat('@不存在的人', players)).toBeNull();
  });

  it('requires the target at the start, so chit-chat is not mistaken for a command', () => {
    expect(resolveSeat('资有风险，我觉得3号可疑', players)).toBeNull();
    expect(resolveSeat('资 @小明', players)).toBeNull();
    expect(resolveSeat('资[CQ:at,qq=10005]', players)).toBeNull();
    expect(resolveSeat('3号，他踩了预言家', players)).toBe(3);
    expect(resolveSeat('3，他是狼', players)).toBe(3);
    expect(resolveSeat('[CQ:at,qq=10005] 他是狼', players)).toBe(5);
    expect(resolveSeat('@小明 你别装了', players)).toBe(3);
  });
});

describe('sanitizing user text', () => {
  it('neutralizes @ placeholders, CQ codes and control characters', () => {
    expect(sanitizeUserText('a{@3}b[CQ:at,qq=all]\u0000c')).toBe('a{＠3}b［CQ:at,qq=all]c');
    expect(sanitizeName('  坏\n人[CQ:face,id=1]  ')).toBe('坏 人［CQ:face,id=1]');
    expect([...sanitizeName('长'.repeat(50))]).toHaveLength(24);
  });
});

describe('misc', () => {
  it('normalizes full width', () => {
    expect(normalizeText('  投　３号 ')).toBe('投 3号');
  });
  it('detects end of speech and skip words', () => {
    expect(isEndSpeech('过')).toBe(true);
    expect(isEndSpeech('我说完了。')).toBe(true);
    expect(isEndSpeech('我觉得3号是狼')).toBe(false);
    expect(isSkipWord('弃票')).toBe(true);
    expect(isSkipWord('不用药')).toBe(true);
  });
});

describe('isIdentityQuery', () => {
  it('recognizes questions about one’s own identity, and nothing else', async () => {
    const { isIdentityQuery } = await import('../../src/core/manager.js');
    for (const t of ['我身份呢', '我身份呢？', '身份', '我的身份', '我是什么身份', '我什么身份来着', '补发身份', '请重发一下身份牌', '没收到身份', '我的词呢', '我的骰子']) {
      expect(isIdentityQuery(t), t).toBe(true);
    }
    for (const t of ['刀3', '查验2号', '我觉得3号身份可疑', '投4', '身份不重要，先刀1', '你什么身份']) {
      expect(isIdentityQuery(t), t).toBe(false);
    }
  });
});
