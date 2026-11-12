import { describe, expect, it } from 'vitest';
import { publicView } from '../../src/world/views.js';
import { makeTown } from './helpers.js';
import { checkInvariants } from './invariants.js';

describe('栖灯镇：主流程冒烟', () => {
  it('注册、移动、说话、买东西、送礼、一起喝茶', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    expect(a.coins()).toBe(20);
    expect(a.view().goals.length).toBe(3);
    expect(a.view().here?.space).toBe('plaza');
    expect(a.view().here?.residents.map((r) => r.name)).toEqual(['小岚']);

    a.act('speak', { text: '你好呀' });
    b.act('speak', { text: '你好' });
    expect(b.view().here?.chat.map((c) => c.text)).toEqual(['你好呀', '你好']);

    a.go('tea_house');
    b.go('tea_house');
    expect(a.view().here?.space).toBe('tea_house');
    a.act('buy', { shop: 'tea_counter', sku: 'tea_leaves', qty: 1 });
    expect(a.coins()).toBe(18);
    expect(a.qty('tea_leaves')).toBe(3);

    const offer = a.act('offer', { kind: 'gift', to: b.residentId, give: { items: [{ type: 'tea_leaves', qty: 1 }] } });
    b.act('accept_offer', { offerId: offer.offer.id });
    expect(a.qty('tea_leaves')).toBe(2);
    expect(b.qty('tea_leaves')).toBe(3);

    const table = a.view().here!.objects.find((o) => o.type === 'tea_table')!;
    expect(table.near).toBe(false);
    a.go(table.id);
    b.go(table.id);
    expect(a.view().here!.objects.find((o) => o.id === table.id)!.near).toBe(true);
    const ix = a.act('start_interaction', { objectId: table.id });
    expect(ix.interaction.status).toBe('open');
    b.act('join_interaction', { interactionId: ix.interaction.id });
    a.act('begin_interaction', { interactionId: ix.interaction.id });
    expect(a.qty('tea_leaves')).toBe(1);
    t.advanceAlive(600_000, [a, b]);
    expect(a.view().interaction).toBeNull();
    expect(a.view().me.needs.social).toBeGreaterThan(60);
    const pub = publicView(t.w);
    expect(pub.places.find((p) => p.id === 'tea_house')!.residents.length).toBe(2);
    checkInvariants(t);
  });

  it('凑一桌数字炸弹并打完', () => {
    const t = makeTown();
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    a.go('arcade');
    b.go('arcade');
    const p = a.act('propose_game', { game: 'number_bomb' });
    b.act('join_game', { activityId: p.activity.id });
    a.act('start_game', { activityId: p.activity.id });
    expect(a.view().context.activityId).toBe(p.activity.id);
    expect(a.view().here).toBeNull();
    for (let i = 0; i < 200; i++) {
      const who = [a, b].find((x) => x.view().game?.your_turn);
      if (!who) break;
      const g = who.lastView.game!;
      const pub = g.public as { range: { from: number; to: number } };
      who.act('game_act', { phaseId: g.phase_id, input: { action: 'guess', number: pub.range.from } });
    }
    expect(a.view().context.activityId).toBeNull();
    expect(a.view().here?.space).toBe('arcade');
    expect(a.coins() + b.coins()).toBeGreaterThan(40);
  });
});
