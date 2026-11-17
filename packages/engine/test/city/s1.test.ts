/**
 * 主用例 S1：一次完整的出门回家（规格 6.1），用假内核客户端跑引擎这一侧。
 */
import { describe, expect, it } from 'vitest';
import { BRIDGE, SHOPS, TRANSIT, latestReconcile, runReconcile, sceneView } from '../../src/city/index.js';
import { COOKIE, HOUSE_ENTRANCE, KISSA, MIN, makeCity } from './helpers.js';

describe('S1：妮娅带 ¥20,000 和一件零食去池袋的咖啡馆，再回家', () => {
  it('从 prepare 到 release 每一步都对得上', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    const nia = t.residentOf('nia');
    const purse = `acct:${nia}`;
    // 前置：外部 bot B 已经在城里
    const b = t.bot('小B', { entry: 'ikebukuro:station' });

    // ── 3. prepare → commit ──
    const start = t.clock.t;
    const commit = k.depart({ yen: 20_000, items: [COOKIE], to: KISSA });
    expect(commit.state).toBe('active');
    expect(t.balance(BRIDGE)).toBe(-20_000);
    expect(t.balance(purse)).toBe(20_000);
    expect(commit.payload).toMatchObject({ purse_yen: 20_000, return_reserve_yen: 200, domain_epoch: 1 });
    const carried = (commit.payload.items as any[])[0];
    expect(carried).toMatchObject({ ref: 'res:cookie:1', engine_type: 'cookie', qty: 1 });
    const item = t.c.db.get('SELECT * FROM items WHERE item_id = ?', carried.engine_item_id)!;
    expect(item).toMatchObject({ owner_id: nia, origin_ref: 'res:cookie:1', state: 'held' });
    expect(JSON.parse(String(item.origin_json))).toMatchObject({ domain: 'ai-house', ref: 'res:cookie:1', transfer_id: `tr-${k.visitId}` });
    // 出门时已经自动排好去咖啡馆的行程
    expect(commit.payload.trip).toMatchObject({ to: KISSA, ends_at_ms: start + 31 * MIN });
    expect(k.view().location).toMatchObject({ in_transit: true });

    // ── 4. 行程：小屋门口 → 赤羽站 → 池袋站 → 咖啡馆 ──
    t.run(20 * MIN);
    expect(k.view().location.trip.leg_index).toBe(1);
    t.run(11 * MIN);
    const progress = k.records('visit_progress');
    expect(progress.map((p) => [p.phase, p.place ?? p.to])).toEqual([
      ['departed', HOUSE_ENTRANCE],
      ['arrived_station', 'akabane:station'],
      ['boarded', 'ikebukuro:station'],
      ['arrived_station', 'ikebukuro:station'],
      ['arrived_place', KISSA],
    ]);
    expect(progress[2].text).toBe('乘车中（埼京线），预计 10:25 到池袋站');
    expect(progress[4].text).toBe('在池袋·喫茶「灯」');
    // 每段的事件时间是原定的到达时刻
    expect(t.outbox(k.visitId).filter((r) => r.kind === 'visit_progress').map((r) => (r.occurred_at_ms - start) / MIN)).toEqual([0, 12, 12, 25, 31]);
    expect(k.view().location).toEqual({ place: KISSA });
    expect(t.balance(purse)).toBe(19_800);
    expect(t.balance(TRANSIT)).toBe(200);
    expect(k.records('decision_wake').map((w) => w.reason)).toEqual(['arrived']);

    // ── 5. B 来到同一家咖啡馆，两人各说一句 ──
    b.go(KISSA);
    const niaScene: any = sceneView(t.c, KISSA, t.c.mustResident(nia), t.clock.t);
    expect(niaScene.people.map((p: any) => p.name)).toEqual(['小B']);
    expect(b.view().here.people.map((p: any) => p.name)).toEqual(['妮娅']);
    b.act({ type: 'say', text: '你好，这里的咖啡好喝吗？' });
    expect(k.records('encounter')).toHaveLength(0); // 只有一边说话还不算当面交谈
    k.act({ type: 'say', text: '我也是第一次来。' });
    b.act({ type: 'say', text: '那一起试试。' });
    const encounters = k.records('encounter');
    expect(encounters).toHaveLength(1);
    expect(encounters[0]).toMatchObject({ with: { name: '小B' }, place: KISSA });
    // encounter 里只有对方的显示名和地点
    expect(Object.keys(encounters[0]).sort()).toEqual(['actor_id', 'area', 'place', 'place_name', 'with']);
    expect(Object.keys(encounters[0].with)).toEqual(['name']);
    expect(k.view().here.recent_chat.map((m: any) => m.text)).toEqual(['你好，这里的咖啡好喝吗？', '我也是第一次来。', '那一起试试。']);

    // ── 6. 点一杯咖啡并喝掉 ──
    const buy = k.act({ type: 'buy', sku: 'coffee' });
    expect(buy.payload).toMatchObject({ status: 'completed', paid_yen: 450, purse_yen: 19_350 });
    expect(t.balance(SHOPS)).toBe(450);
    const drink = k.act({ type: 'consume', item: 'coffee' });
    expect(drink.payload).toMatchObject({ status: 'completed', consumed: { type: 'coffee', qty: 1 } });
    const purchases = k.records('purchase');
    expect(purchases.map((p) => [p.what, p.yen])).toEqual([
      ['电车', -200],
      ['混合咖啡', -450],
    ]);
    const drank = k.records('body_effect').filter((e) => e.engine_kind === 'drank');
    expect(drank).toEqual([expect.objectContaining({ engine_type: 'coffee', qty: 1, kernel_effect: 'drink_coffee', effect_id: drink.payload.effect_id })]);
    k.pull();
    expect(k.bodyApplied.get(drink.payload.effect_id as string)).toBe(1);

    // ── 7. 她决定回家 ──
    const home = k.act({ type: 'go_home' });
    expect(home.state).toBe('returning');
    expect(k.records('return_started')).toEqual([expect.objectContaining({ reason: 'self', from: KISSA })]);
    // 回家路上不能再买东西
    expect(() => k.act({ type: 'buy', sku: 'coffee' })).toThrowError(/回家的路上/);
    t.run(31 * MIN);
    expect(k.describe().state).toBe('settled');
    expect(t.c.mustResident(nia).in_city).toBe(0);
    k.pull();
    const s = k.settlement!;
    expect(s).toMatchObject({ visit_id: k.visitId, carry_yen: 20_000, purse_final_yen: 19_150, pending: [] });
    expect(s.items).toEqual([
      { engine_item_id: carried.engine_item_id, origin_ref: 'res:cookie:1', type: 'cookie', qty: 1, fate: 'back' },
      expect.objectContaining({ type: 'coffee', qty: 1, fate: 'consumed', origin_ref: null }),
    ]);
    expect(s.consumed).toEqual([{ type: 'coffee', qty: 1, effect_id: drink.payload.effect_id, origin_ref: null }]);
    expect(s.spend_summary).toEqual([
      { what: '电车', yen: -400 },
      { what: '咖啡', yen: -450 },
    ]);
    // cutoff_seq 是 visit_settled 之前这次访问的最后一条记录
    const recs = t.outbox(k.visitId);
    expect(recs[recs.length - 1]!.kind).toBe('visit_settled');
    expect(s.cutoff_seq).toBe(recs[recs.length - 2]!.seq);
    // 步行 12 + 6 + 6 + 12 = 36 分钟 → 两次 15 分钟的步行效果
    expect(k.records('body_effect').filter((e) => e.engine_kind === 'walked')).toHaveLength(2);
    // 到家之后城里不再接受她的动作
    expect(() => k.act({ type: 'say', text: '还在吗' })).toThrowError(/到家门口/);

    // ── 8. T3 + release ──
    const release = k.release();
    expect(release.state).toBe('closed');
    expect(t.balance(purse)).toBe(0);
    expect(t.balance(BRIDGE)).toBe(19_150 - 20_000);
    expect(k.homeYen).toBe(38_900 - 850);
    expect(k.frozenYen).toBe(0);
    expect(t.c.db.get('SELECT state FROM items WHERE item_id = ?', carried.engine_item_id)!.state).toBe('returned');
    expect(k.view().items).toEqual([]);

    // ── 9. 对账 ──
    expect(release.payload.reconcile_ok).toBe(true);
    const report = runReconcile(t.c, 'test');
    expect(report.findings).toEqual([]);
    expect(latestReconcile(t.c, 1)[0]!.trigger).toBe('test');
    // 全程：钱没有多出来
    expect(t.c.db.scalar('SELECT SUM(balance) FROM accounts')).toBe(0);
  });

  it('任何时刻只有一边接受她的动作：交接前、到家后、交回后城里都拒绝', () => {
    const t = makeCity();
    const k = t.kernel('nia');
    k.depart({ yen: 5000, to: 'akabane:ekimae-plaza' });
    t.run(20 * MIN);
    k.act({ type: 'go_home' });
    t.run(20 * MIN);
    expect(k.describe().state).toBe('settled');
    k.release();
    // 交回之后：用城里那一代的代次再发动作
    const stale = k.epoch - 1;
    expect(() => visitActWith(k, stale)).toThrowError(/已经结束/);
  });
});

function visitActWith(k: any, epoch: number): unknown {
  const saved = k.epoch;
  k.epoch = epoch;
  try {
    return k.act({ type: 'say', text: '迟到的动作' });
  } finally {
    k.epoch = saved;
  }
}
