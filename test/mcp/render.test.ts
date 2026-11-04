import { describe, expect, it } from 'vitest';
import type { Delivery } from '../../src/core/types.js';
import { renderDelivery } from '../../src/mcp/render.js';

const delivery: Delivery = {
  seq: 7,
  createdAt: 0,
  notBefore: 0,
  target: { type: 'group', groupId: '9000' },
  segments: [
    { type: 'text', text: '请 ' },
    { type: 'at', id: '10001', name: '小克' },
    { type: 'text', text: ' 发言 [CQ:at,qq=all] & ok' },
  ],
  text: '请 @小克 发言 [CQ:at,qq=all] & ok',
  mentions: [{ id: '10001', name: '小克' }],
  category: 'prompt',
};

describe('renderDelivery', () => {
  it('text format keeps mentions but defuses CQ codes', () => {
    const r = renderDelivery(delivery, 'text') as any;
    expect(r).toMatchObject({ seq: 7, to: 'group', group_id: '9000', category: 'prompt' });
    expect(r.message).toBe('请 @小克 发言 ［CQ:at,qq=all] & ok');
    expect(r.mentions).toEqual([{ qq: '10001', name: '小克' }]);
  });

  it('cq format escapes text and renders real @', () => {
    expect(renderDelivery(delivery, 'cq').message).toBe('请 [CQ:at,qq=10001] 发言 &#91;CQ:at,qq=all&#93; &amp; ok');
  });

  it('onebot format returns message segments', () => {
    expect(renderDelivery(delivery, 'onebot').message).toEqual([
      { type: 'text', data: { text: '请 ' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 发言 [CQ:at,qq=all] & ok' } },
    ]);
  });

  it('private deliveries carry the user id', () => {
    const r = renderDelivery({ ...delivery, target: { type: 'private', userId: '2001', name: '阿强' } }, 'text') as any;
    expect(r).toMatchObject({ to: 'private', user_id: '2001', nickname: '阿强' });
  });
});
