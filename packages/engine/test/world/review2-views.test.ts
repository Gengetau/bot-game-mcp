/**
 * 二轮审查：门牌不借未生效的邀请泄露寄信人、已发信箱不回显已读、agentView 的 itemId 条件。
 */
import { describe, expect, it } from 'vitest';
import { listLetters } from '../../src/world/mail.js';
import { agentView } from '../../src/world/views.js';
import { makeTown } from './helpers.js';

const doorNames = (here: { doors?: { owner: { name: string } }[] } | null | undefined) => (here?.doors ?? []).map((d) => d.owner.name);

describe('门牌只列已得知且已生效的邀请', () => {
  it('寄信人离线：信在路上 / 送达未读时收信人的门牌里没有寄信人；读信后才出现', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go('residential');
    const out = a.act('send_letter', { to: b.residentId, body: '来坐坐', invite: true });
    a.leave();
    expect(a.row().present_since).toBeNull();
    b.go('residential');
    expect(b.row().location_id).toBe('residential');
    // 信还在路上
    expect(t.clock.t).toBeLessThan(out.deliverAt);
    expect(doorNames(b.view().here)).not.toContain('阿灯');
    // 送达未读
    for (const x of [b]) x.heartbeat();
    t.advanceAlive(out.deliverAt - t.clock.t + 1000, [b], 50_000);
    expect(b.view().mail.unread).toBe(1);
    expect(doorNames(b.view().here)).not.toContain('阿灯');
    // 读信（要在自己家）后回到巷子
    b.go('home');
    b.act('read_letter', { letterId: out.letterId });
    b.go('residential');
    expect(doorNames(b.view().here)).toContain('阿灯');
  });
});

describe('已发信箱不暴露已读', () => {
  it('寄信人看不到 read；收信人的信箱仍有 read', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const out = a.act('send_letter', { to: b.residentId, body: '你好' });
    for (const x of [a, b]) x.heartbeat();
    t.advanceAlive(out.deliverAt - t.clock.t + 1000, [a, b], 50_000);
    const sentBefore = listLetters(t.w, a.residentId, 'sent', null, 20, t.clock.t).letters[0]!;
    expect('read' in sentBefore).toBe(false);
    b.go('home');
    b.act('read_letter', { letterId: out.letterId });
    const sentAfter = listLetters(t.w, a.residentId, 'sent', null, 20, t.clock.t).letters[0]!;
    expect('read' in sentAfter).toBe(false);
    expect(JSON.stringify(sentAfter)).not.toContain('"read"');
    expect(listLetters(t.w, b.residentId, 'inbox', null, 20, t.clock.t).letters[0]!.read).toBe(true);
    for (const x of [a, b]) {
      expect(JSON.stringify(agentView(t.w, x.row(), x.clientId))).not.toContain('"read"');
    }
  });
});

describe('agentView 的 itemId 只给不可叠放的物品', () => {
  it('只剩 1 个可叠放装饰物：不给 itemId，用 itemType 摆出和送人都成功', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.act('buy', { shop: 'stall', sku: 'lantern', qty: 1 });
    const items = () => (agentView(t.w, a.row(), a.clientId).items as { itemId?: string; type: string; qty: number }[]);
    const lamp = items().find((i) => i.type === 'lantern')!;
    expect(lamp.qty).toBe(1);
    expect(lamp.itemId).toBeUndefined();
    expect(a.view().inventory.items.find((i) => i.type === 'lantern')!.stackable).toBe(true);
    a.go('home');
    a.act('display_item', { itemType: 'lantern' });
    a.act('display_item', { itemType: 'lantern', on: false });
    a.go('plaza');
    a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'lantern', qty: 1 }] } });
  });

  it('不可叠放的物品仍给 itemId，且能用它操作', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go('kitchen');
    a.act('buy', { shop: 'pantry', sku: 'stove_kit' });
    const kit = (agentView(t.w, a.row(), a.clientId).items as { itemId?: string; type: string }[]).find((i) => i.type === 'stove_kit')!;
    expect(kit.itemId).toBeTruthy();
    // 用 itemId 能被服务端识别（不可交易 -> not_tradable，而不是 not_yours）
    b.go('kitchen');
    expect(a.fail('offer', { kind: 'gift', to: b.residentId, give: { items: [{ itemId: kit.itemId }] } }).reason).toBe('not_tradable');
  });
});
