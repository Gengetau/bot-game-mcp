/** 审计回归：财产（buy 账本键、报价错误统一）。 */
import { describe, expect, it } from 'vitest';
import { makeTown } from './helpers.js';
import { checkInvariants } from './invariants.js';

const DAY = 24 * 3600_000;
const NO_GOALS = { shortGoals: 0, longGoals: 0 };

describe('审计 1/6：buy 的账本键不依赖客户端请求号', () => {
  it('回执过期后复用同一请求号再买：照样扣币，不会白拿', () => {
    const t = makeTown({ seed: 'audit-buy', params: NO_GOALS });
    const a = t.join('阿灯');
    const rid = 'reuse-request-0001';
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 5 }, { requestId: rid });
    expect(a.coins()).toBe(5);
    expect(a.qty('cookie')).toBe(5);

    // 推进 8 天，让回执被清理
    t.advance(8 * DAY);
    a.enter(); // 长时间离开后重新进入
    expect(t.w.db.scalar('SELECT COUNT(*) FROM request_receipts')).toBe(0);
    const coins0 = a.coins();
    const cookies0 = a.qty('cookie');
    if (coins0 >= 15) {
      a.act('buy', { shop: 'stall', sku: 'cookie', qty: 5 }, { requestId: rid });
      expect(a.coins()).toBe(coins0 - 15);
      expect(a.qty('cookie')).toBe(cookies0 + 5);
    } else {
      // 钱不够时必须被拒，不能白拿
      expect(a.fail('buy', { shop: 'stall', sku: 'cookie', qty: 5 }, { requestId: rid }).reason).toBeDefined();
      expect(a.qty('cookie')).toBe(cookies0);
    }
    checkInvariants(t);
  });

  it('同一请求号在回执期内重试：回放，不重复扣币', () => {
    const t = makeTown({ seed: 'audit-buy2', params: NO_GOALS });
    const a = t.join('阿灯');
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 }, { requestId: 'retry-request-0001' });
    const before = a.coins();
    a.act('buy', { shop: 'stall', sku: 'cookie', qty: 2 }, { requestId: 'retry-request-0001' });
    expect(a.coins()).toBe(before);
    expect(a.qty('cookie')).toBe(2);
  });
});

describe('审计 22：报价的权限类失败统一为 not_available', () => {
  it('不存在、不是给我的、不是我发的，错误一模一样', () => {
    const t = makeTown({ seed: 'audit-offer', params: NO_GOALS });
    const a = t.join('阿灯');
    const b = t.join('小岚', 'agent');
    const c = t.join('阿木');
    const o = a.act('offer', { kind: 'gift', to: b.residentId, give: { coins: 1 } });
    const missing = c.fail('accept_offer', { offerId: 'nope' });
    const others = c.fail('accept_offer', { offerId: o.offer.id });
    expect(missing.code).toBe('not_available');
    expect(others.code).toBe('not_available');
    expect(others.reason).toBe(missing.reason);
    expect(others.message).toBe(missing.message);
    expect(a.fail('decline_offer', { offerId: o.offer.id }).code).toBe('not_available');
    expect(b.fail('cancel_offer', { offerId: o.offer.id }).code).toBe('not_available');
    // 当事人仍能正常处理
    expect(b.act('accept_offer', { offerId: o.offer.id }).status).toBe('completed');
  });
});
