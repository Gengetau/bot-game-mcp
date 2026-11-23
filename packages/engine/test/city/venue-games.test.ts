import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  AUCTION_ESCROW,
  AUCTION_HOUSE_RESIDENT,
  BOARDGAME_CHAYA_ID,
  accountBalance,
  createCity,
  createVenueAuction,
  issueCityTicket,
  ledgerImbalance,
  leaveCity,
  place,
  placeOpen,
  runReconcile,
} from '../../src/city/index.js';
import { mountCity } from '../../src/city/http.js';
import { SeededRng } from '../../src/core/rng.js';
import { FakeClock } from '../helpers.js';
import { CityTest, HOUSE, MIN, T0, makeCity, rejects } from './helpers.js';

/** 在满载情况下也保持 selfView <= 4 KB */
function expectViewUnder4KB(view: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8');
  expect(bytes).toBeLessThanOrEqual(4096);
}

describe('晴空都 M3-B：桌游茶屋同店成局 + 旧物密封竞拍会 (#263)', () => {
  it('桌游茶屋为虚构室内场所，雨天照常开放，且严格执行同场硬门禁', () => {
    const t = makeCity();
    const p = place(BOARDGAME_CHAYA_ID)!;
    expect(p).toBeDefined();
    expect(p.fictional).toBe(true);
    expect(p.source).toBe('fictional');
    expect(p.indoor).toBe(true);
    expect(p.rain).toBe('none');

    // 注入暴雨天气：桌游茶屋仍照常开放
    t.c.db.run(
      "INSERT OR REPLACE INTO weather_snapshots(area, observed_at_ms, fetched_at_ms, last_ok_at_ms, code, temp_c, precip_mm, rain, source, status, hourly_json) VALUES ('ryokogai',?,?,?,63,16,8.5,1,'open-meteo','ok','[]')",
      t.clock.now(),
      t.clock.now(),
      t.clock.now(),
    );
    expect(placeOpen(t.c, p, t.clock.now()).open).toBe(true);

    // 不在茶屋（站在棱光街站）时不可开桌、不可出价
    const bot = t.bot('茶客A', { entry: 'ryokogai:station', stay: true });
    rejects(() => bot.act({ type: 'open_table', game: 'liars_dice' }), 'PRECONDITION_FAILED', 'not_at_venue');
    rejects(() => bot.act({ type: 'auction_bid', yen: 500 }), 'PRECONDITION_FAILED', 'not_at_venue');

    // 走到茶屋途中也不行
    bot.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    rejects(() => bot.act({ type: 'open_table', game: 'liars_dice' }), 'PRECONDITION_FAILED', 'in_transit');

    // 到店后可以开桌，且单次视图 <= 4 KB
    t.run(10 * MIN);
    const openRes = bot.act({ type: 'open_table', game: 'liars_dice' });
    expect(openRes.table_id).toBeTruthy();
    expectViewUnder4KB(bot.view());
  });

  it('同店打通「大话骰」与「彩牌接龙」，散局后参与者原位留在茶屋内，且视图 <= 4 KB', () => {
    const t = makeCity();
    const a = t.bot('旅人A', { entry: 'ryokogai:station', stay: true });
    const b = t.bot('旅人B', { entry: 'ryokogai:station', stay: true });
    a.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    b.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    t.run(10 * MIN);

    // 1) 大话骰：1 条命快速成局并打完
    const tbl1 = a.act({ type: 'open_table', game: 'liars_dice', options: { lives: 1, dice_per_player: 2, random_seats: false } });
    b.act({ type: 'join_table', table_id: tbl1.table_id });
    a.act({ type: 'start_table', table_id: tbl1.table_id });

    expectViewUnder4KB(a.view());
    expectViewUnder4KB(b.view());

    // 1号先叫，2号直接开牌（1条命，一回合分胜负）
    const v1 = a.view() as any;
    expect(v1.venue_table.todo.actions).toContain('bid');
    a.act({ type: 'game_act', input: { action: 'bid', quantity: 2, face: 6 } });
    const v2 = b.view() as any;
    expect(v2.venue_table.todo.actions).toContain('challenge');
    const fin1 = b.act({ type: 'game_act', input: { action: 'challenge' } });
    expect(fin1.game_status).toBe('ended');

    // 散局后两人仍在茶屋内，且牌桌占位已释放
    expect((a.view() as any).location.place).toBe(BOARDGAME_CHAYA_ID);
    expect((b.view() as any).location.place).toBe(BOARDGAME_CHAYA_ID);
    expect((a.view() as any).venue_table).toBeUndefined();

    // 2) 彩牌接龙：2 人局开局并推进到结束（通过超时/出牌完成）
    const tbl2 = a.act({ type: 'open_table', game: 'color_chain', options: { hand_size: 5, target_score: 0, turn_timeout_s: 15 } });
    b.act({ type: 'join_table', table_id: tbl2.table_id });
    a.act({ type: 'start_table', table_id: tbl2.table_id });

    expectViewUnder4KB(a.view());
    expectViewUnder4KB(b.view());

    // 推进回合直到彩牌接龙正常结束
    for (let step = 0; step < 80; step++) {
      const va = a.view() as any;
      const vb = b.view() as any;
      if (!va.venue_table && !vb.venue_table) break;
      const actor = va.venue_table?.todo ? a : vb.venue_table?.todo ? b : null;
      if (!actor) {
        t.run(20_000);
        continue;
      }
      const vt = (actor.view() as any).venue_table;
      const todo = vt.todo;
      if (todo.actions.includes('color')) {
        actor.act({ type: 'game_act', input: { action: 'color', color: '红' } });
      } else if (todo.actions.includes('accept')) {
        actor.act({ type: 'game_act', input: { action: 'accept' } });
      } else {
        const playable: string[] = vt.you?.playable ?? [];
        if (playable.length > 0) {
          const cardName = playable[0]!;
          const needsColor = cardName.startsWith('变色');
          actor.act({ type: 'game_act', input: { action: 'play', card: cardName, ...(needsColor ? { color: '红' } : {}), call: true } });
        } else if (todo.actions.includes('draw')) {
          actor.act({ type: 'game_act', input: { action: 'draw' } });
        } else {
          actor.act({ type: 'game_act', input: { action: 'pass' } });
        }
      }
    }
    expect((a.view() as any).venue_table).toBeUndefined();
    expect((b.view() as any).venue_table).toBeUndefined();
    expect((a.view() as any).location.place).toBe(BOARDGAME_CHAYA_ID);
    expect((b.view() as any).location.place).toBe(BOARDGAME_CHAYA_ID);
  });

  it('中途离开、掉线超时或室友触发终电自动返程时立即退座托管，绝不死锁牌桌', () => {
    const t = makeCity();
    const nia = t.kernel('nia');
    const bot = t.bot('牌友B', { entry: 'ryokogai:station', stay: true });

    nia.depart({ yen: 10000, to: BOARDGAME_CHAYA_ID, returnIn: 90 * MIN });
    bot.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    t.run(35 * MIN);

    nia.act({ type: 'open_table', game: 'liars_dice', options: { lives: 1, dice_per_player: 2, random_seats: false } });
    const joinRes = bot.act({ type: 'join_table' });
    const tblId = String(joinRes.table_id);
    nia.act({ type: 'start_table', table_id: tblId });

    // 推进到妮娅触发终电自动返程（return_by_ms 到点）
    t.run(40 * MIN);

    // 妮娅已经不在牌桌上，且正常返程结算；牌桌不死锁，轮到牌友B直接可推进收尾
    const botView = bot.view() as any;
    if (botView.venue_table?.todo) {
      const actName = botView.venue_table.todo.actions.includes('challenge') ? 'challenge' : 'bid';
      bot.act({ type: 'game_act', input: actName === 'bid' ? { action: 'bid', quantity: 2, face: 6 } : { action: 'challenge' } });
    }
    // 即使之前已由托管打完，最终状态一定已离开牌桌
    const tblRow = t.c.db.get<{ status: string }>('SELECT status FROM venue_tables WHERE table_id = ?', tblId)!;
    expect(['completed', 'aborted']).toContain(tblRow.status);

    // 妮娅正常结算回家且对账全绿
    t.run(60 * MIN);
    const settleRes = nia.release();
    expect(settleRes.state).toBe('closed');
    expect(runReconcile(t.c, 'after-table-return').ok).toBe(true);

    // 外部 bot 中途离线（leaveCity）与全员离开也不死锁
    const c = t.bot('牌友C', { entry: 'ryokogai:station', stay: true });
    c.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    t.run(10 * MIN);
    const tbl2 = bot.act({ type: 'open_table', game: 'liars_dice', options: { lives: 1, random_seats: false } });
    c.act({ type: 'join_table', table_id: tbl2.table_id });
    bot.act({ type: 'start_table', table_id: tbl2.table_id });
    leaveCity(t.c, c.id);
    // 牌友B离开导致全员离席 -> 自动 aborted
    bot.act({ type: 'travel', to: 'ryokogai:station' });
    const tbl2Row = t.c.db.get<{ status: string }>('SELECT status FROM venue_tables WHERE table_id = ?', tbl2.table_id)!;
    expect(tbl2Row.status).toBe('aborted');
  });

  it('旧物密封竞拍会：spendable() 守卫、流拍全额解冻、成交原子转移同一永久 item_id 且 Σ 余额 === 0', () => {
    const t = makeCity();
    const nia = t.kernel('nia');
    const bot = t.bot('藏家B', { entry: 'ryokogai:station', stay: true });

    // 从茶屋回小屋的车费是 ¥200（ryokogai -> hiyorizaka）
    nia.depart({ yen: 1000, to: BOARDGAME_CHAYA_ID, returnIn: 120 * MIN });
    bot.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    t.run(35 * MIN);

    const auction = t.c.commit(() =>
      createVenueAuction(t.c, {
        auctionId: 'auc:test:rare-book',
        itemId: 'curio:rare-book-01',
        itemType: 'paperback',
        itemName: '古书店稀有旧书·初版诗集',
        reserveYen: 300,
        priceMode: 'first',
        closesAt: t.clock.now() + 30 * MIN,
      }),
    );

    // 妮娅出发带 1000，去程车费花 ¥200 后钱包剩 800；扣除回程预留 200 后 spendable = 600；出价 700 必须被 return_fare_reserved 拒绝
    rejects(() => nia.act({ type: 'auction_bid', auction_id: auction.auction_id, yen: 700 }), 'PRECONDITION_FAILED', 'return_fare_reserved');

    // 妮娅出价 550，藏家B 出价 500
    nia.act({ type: 'auction_bid', auction_id: auction.auction_id, yen: 550 });
    bot.act({ type: 'auction_bid', auction_id: auction.auction_id, yen: 500 });

    // 密封性检查：开放期视图只给 bid_count 和本人出价，不泄露对方价格
    const botAuctionView = bot.act({ type: 'auction_view', auction_id: auction.auction_id }) as any;
    expect(botAuctionView.auctions[0].bid_count).toBe(2);
    expect(botAuctionView.auctions[0].my_bid.yen).toBe(500);
    expect(JSON.stringify(botAuctionView)).not.toContain('550');
    expectViewUnder4KB(nia.view());

    // 复式账本全程零和
    expect(ledgerImbalance(t.c)).toBe(0);
    expect(accountBalance(t.c, AUCTION_ESCROW)).toBe(1050);

    // 推进到截标时刻自动开标结算
    t.run(35 * MIN);
    expect(ledgerImbalance(t.c)).toBe(0);
    expect(accountBalance(t.c, AUCTION_ESCROW)).toBe(0);

    // 同一永久 item_id 原子转移到妮娅名下，且 instance = 1
    const itemRow = t.c.db.get<{ owner_id: string; instance: number; state: string; visit_id: string | null }>(
      'SELECT owner_id, instance, state, visit_id FROM items WHERE item_id = ?',
      'curio:rare-book-01',
    )!;
    expect(itemRow.owner_id).toBe(t.residentOf('nia'));
    expect(itemRow.instance).toBe(1);
    expect(itemRow.state).toBe('held');
    expect(itemRow.visit_id).toBeTruthy();

    // 藏家B 的 500 全额解冻退回
    expect((bot.view() as any).wallet.yen).toBe(200_000);
    expectViewUnder4KB(nia.view());

    // 妮娅回家结算，paperback 在映射表内可正常带回
    nia.act({ type: 'go_home' });
    t.run(40 * MIN);
    const released = nia.release();
    expect(released.state).toBe('closed');
    expect(runReconcile(t.c, 'after-auction-win').ok).toBe(true);

    // 流拍场景：出价后在开标前离开触发撤回 -> 到期无人有效出价 -> unsold，原 item_id 仍在拍行
    const auc2 = t.c.commit(() =>
      createVenueAuction(t.c, {
        auctionId: 'auc:test:lamp',
        itemId: 'curio:lamp-01',
        itemType: 'antique_curio',
        itemName: '昭和古董台灯摆件',
        reserveYen: 400,
        closesAt: t.clock.now() + 20 * MIN,
      }),
    );
    bot.act({ type: 'auction_bid', auction_id: auc2.auction_id, yen: 600 });
    expect(accountBalance(t.c, AUCTION_ESCROW)).toBe(600);
    bot.act({ type: 'travel', to: 'ryokogai:station' });
    expect(accountBalance(t.c, AUCTION_ESCROW)).toBe(0);
    expect((bot.view() as any).wallet.yen).toBe(200_000);

    t.run(25 * MIN);
    const auc2Row = t.c.db.get<{ status: string }>('SELECT status FROM venue_auctions WHERE auction_id = ?', auc2.auction_id)!;
    expect(auc2Row.status).toBe('unsold');
    const lampRow = t.c.db.get<{ owner_id: string; state: string }>('SELECT owner_id, state FROM items WHERE item_id = ?', 'curio:lamp-01')!;
    expect(lampRow.owner_id).toBe(AUCTION_HOUSE_RESIDENT);
    expect(lampRow.state).toBe('space');
    expect(ledgerImbalance(t.c)).toBe(0);
    expect(runReconcile(t.c, 'after-auction-unsold').ok).toBe(true);
  });

  it('MCP Agent 与人类网页端同权参桌与竞拍（HTTP /city/api/act + /me）', async () => {
    const clock = new FakeClock();
    clock.t = T0;
    const c = createCity({ dbPath: ':memory:', now: clock.now, rng: new SeededRng('city-http'), house: HOUSE, fetchWeather: null });
    c.startSync();
    const t = new CityTest(c, clock);
    const app = express();
    mountCity(app, t.c, () => undefined);
    const srv = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (srv.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      // 通过一次性票据创建人类网页会话并登录
      const issued = issueCityTicket(t.c, { userId: 'human-1', name: '人类旅人' });
      const loginRes = await fetch(`${baseUrl}/city/api/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ ticket: issued.ticket }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
      const loginJson = (await loginRes.json()) as any;
      const csrf = loginJson.csrf_token;

      const enterRes = await fetch(`${baseUrl}/city/api/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: cookie, 'x-city-csrf': csrf },
        body: JSON.stringify({ name: '人类旅人', entry: 'ryokogai:station', client_id: 'tab-1' }),
      });
      expect(enterRes.status).toBe(200);

      const humanAct = async (requestId: string, action: Record<string, unknown>) => {
        const res = await fetch(`${baseUrl}/city/api/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: cookie, 'x-city-csrf': csrf },
          body: JSON.stringify({ request_id: requestId, action, client_id: 'tab-1' }),
        });
        return (await res.json()) as any;
      };

      // 人类玩家进茶屋，MCP Bot 也进茶屋
      await humanAct('req-h-travel-1', { type: 'travel', to: BOARDGAME_CHAYA_ID });
      const mcpBot = t.bot('MCP旅人', { entry: 'ryokogai:station', stay: true });
      mcpBot.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
      t.run(6 * MIN);

      // 人类玩家开桌，MCP Bot 入座并开局
      const openOut = await humanAct('req-h-open-1', { type: 'open_table', game: 'liars_dice', options: { lives: 1, random_seats: false } });
      expect(openOut.ok).toBe(true);
      mcpBot.act({ type: 'join_table', table_id: openOut.table_id });
      await humanAct('req-h-start-1', { type: 'start_table', table_id: openOut.table_id });

      const myRes = await fetch(`${baseUrl}/city/api/me?client_id=tab-1`, { headers: { Cookie: cookie } });
      const myJson = (await myRes.json()) as any;
      expect(myJson.venue_table.status).toBe('running');
      expect(Array.isArray(myJson.here.auctions)).toBe(true);
      expect(myJson.here.auctions.length).toBeGreaterThanOrEqual(1);
      expectViewUnder4KB(myJson);

      // 同页还可对默认场次提交密封出价并查看场次记录
      const auc = myJson.here.auctions[0];
      const bidOut = await humanAct('req-h-auc-1', { type: 'auction_bid', auction_id: auc.id, yen: auc.reserve_yen + 100 });
      expect(bidOut.ok).toBe(true);
      expect(bidOut.held_yen).toBe(auc.reserve_yen + 100);
      expectViewUnder4KB(bidOut.view);
      const viewAucOut = await humanAct('req-h-auc-view-1', { type: 'auction_view' });
      expect(viewAucOut.ok).toBe(true);
      expect(Array.isArray(viewAucOut.auctions)).toBe(true);
      expect(viewAucOut.auctions.some((x: any) => x.auction_id === auc.id && x.my_bid?.yen === auc.reserve_yen + 100)).toBe(true);
    } finally {
      srv.close();
    }
  });

  it('P2-2 回归：5 名茶客、2 人开大话骰并各自发送 230 字长茶话后，selfView 仍严格 <= 4 KB 且保留私密状态与合法行动', () => {
    const t = makeCity();
    const visitors = ['茶客甲', '茶客乙', '茶客丙', '茶客丁', '茶客戊'].map((name, i) =>
      t.bot(name, {
        id: `810${i}`,
        entry: 'ryokogai:station',
        stay: true,
      }),
    );
    for (const v of visitors) {
      v.act({ type: 'update_profile', name: v.name, bio: '喜欢在棱光街雨天逛旧书店与茶屋桌游的长期旅人简介测试文本' });
      v.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    }
    t.run(10 * MIN);

    const a = visitors[0]!;
    const b = visitors[1]!;
    const tbl = a.act({ type: 'open_table', game: 'liars_dice', options: { lives: 3, dice_per_player: 5, random_seats: false } });
    b.act({ type: 'join_table', table_id: tbl.table_id });
    a.act({ type: 'start_table', table_id: tbl.table_id });

    // 5 人茶室刚开桌时严格 <= 4 KB
    for (const v of visitors) expectViewUnder4KB(v.view());

    // 5 人各发一条约 230 字的合法长茶话
    const longText =
      '今天雨下得好大啊，刚从棱光街东口走过来顺便来路地裏茶屋坐坐，看看有没有朋友想一起打一局大话骰或者彩牌接龙，顺便瞄一眼今天的旧物密封竞拍会。'.repeat(3) +
      '路地裏茶屋里暖洋洋的，大家一起慢悠悠玩桌游真开心！';
    expect([...longText].length).toBeGreaterThanOrEqual(220);
    expect([...longText].length).toBeLessThanOrEqual(250);
    for (const v of visitors) {
      v.act({ type: 'say', text: longText });
    }

    for (const v of visitors) {
      expectViewUnder4KB(v.view());
    }
    // 参桌者本人私密状态与合法行动必须完整保留
    const av = a.view() as any;
    expect(av.me.in_city).toBe(true);
    expect(Array.isArray(av.can)).toBe(true);
    expect(av.venue_table.you.dice).toHaveLength(5);
    expect(av.venue_table.todo.actions).toContain('bid');

    // 极端压力：叠加大量长文本聊天与多条背包物品，依然严格 <= 4 KB 且保留私密状态与合法行动
    for (let i = 0; i < 12; i++) {
      t.c.commit(() => {
        t.c.db.run(
          "INSERT INTO items(item_id, owner_id, type, quantity, instance, origin_ref, origin_json, meta_json, borrowed_from, visit_id, state, created_at, updated_at) VALUES (?, ?, 'antique_curio', 1, 1, NULL, NULL, ?, NULL, NULL, 'held', ?, ?)",
          `stress-curio-${i}`,
          a.id,
          JSON.stringify({ title: `超长名称古董旧物编号${i}_${'珍藏纪念版'.repeat(6)}`, provenance: '棱光街旧书街'.repeat(10) }),
          t.clock.now(),
          t.clock.now(),
        );
      });
    }
    const avStress = a.view() as any;
    expectViewUnder4KB(avStress);
    expect(avStress.me.in_city).toBe(true);
    expect(Array.isArray(avStress.can)).toBe(true);
    expect(avStress.venue_table.you.dice).toHaveLength(5);
    expect(avStress.venue_table.todo.actions).toContain('bid');
  });

  it('P2-3 回归：不手造拍卖数据，默认 15 分钟固定场次让普通短访（10:00-12:00）在离店前正常开标成交并返家关单', () => {
    // 2026-11-19 10:00 JST = 2026-11-19 01:00 UTC
    const startAt = Date.UTC(2026, 10, 19, 1, 0, 0);
    const t = makeCity({ at: startAt });
    const nia = t.kernel('nia');

    // 10:00 出发，计划 12:00 前到家（11:25 JST 自动触发返程）
    nia.depart({ yen: 1000, to: BOARDGAME_CHAYA_ID, returnIn: 120 * MIN });
    t.run(35 * MIN); // 10:35 JST 到店

    // 无需手动 createVenueAuction：默认场次已可见
    const view = nia.view() as any;
    expect(view.here.place.id).toBe(BOARDGAME_CHAYA_ID);
    expect(Array.isArray(view.here.auctions)).toBe(true);
    expect(view.here.auctions.length).toBeGreaterThanOrEqual(1);
    const curAuction = view.here.auctions[0];

    // 出价 ¥550（满足起拍价与回程预留）
    const bidRes = nia.act({ type: 'auction_bid', auction_id: curAuction.id, yen: 550 });
    expect(bidRes.payload.held_yen).toBe(550);
    expect(accountBalance(t.c, AUCTION_ESCROW)).toBe(550);

    // 推进 30 分钟到 11:05 JST（仍在 11:25 JST 自动返程前）：默认排期应已开标成交
    t.run(30 * MIN);
    expect(accountBalance(t.c, AUCTION_ESCROW)).toBe(0);
    expect(ledgerImbalance(t.c)).toBe(0);

    const aucRow = t.c.db.get<{ status: string; winner_id: string; winning_price: number; item_id: string }>(
      'SELECT status, winner_id, winning_price, item_id FROM venue_auctions WHERE auction_id = ?',
      curAuction.id,
    )!;
    expect(aucRow.status).toBe('settled');
    expect(aucRow.winner_id).toBe(t.residentOf('nia'));
    expect(aucRow.winning_price).toBe(550);

    const itemRow = t.c.db.get<{ owner_id: string; instance: number }>('SELECT owner_id, instance FROM items WHERE item_id = ?', aucRow.item_id)!;
    expect(itemRow.owner_id).toBe(t.residentOf('nia'));
    expect(itemRow.instance).toBe(1);

    // 继续推进至终电自动返程回家并关单
    t.run(60 * MIN);
    const rel = nia.release();
    expect(rel.state).toBe('closed');
    expect(runReconcile(t.c, 'default-auction-short-visit').ok).toBe(true);
  });

  it('P2 换场刷新回归：在店旁观者跨过 15 分钟换场时收到不含密封金额的私有刷新事件，SSE 无需手动刷新即可对新场出价', async () => {
    // 2026-11-17 10:00 JST = 2026-11-17 01:00 UTC（s40: 10:00-10:15, s41: 10:15-10:30, s42: 10:30-10:45）
    const startAt = Date.UTC(2026, 10, 17, 1, 0, 0);
    const clock = new FakeClock();
    clock.t = startAt;
    const c = createCity({ dbPath: ':memory:', now: clock.now, rng: new SeededRng('city-rollover'), house: HOUSE, fetchWeather: null });
    c.startSync();
    const t = new CityTest(c, clock);
    const app = express();
    const closeCity = mountCity(app, t.c, () => undefined);
    const srv = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (srv.address() as any).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const ac = new AbortController();
    try {
      const issued = issueCityTicket(t.c, { userId: 'human-rollover', name: '茶客旁观者' });
      const loginRes = await fetch(`${baseUrl}/city/api/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ ticket: issued.ticket }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
      const csrf = ((await loginRes.json()) as any).csrf_token;

      const enterRes = await fetch(`${baseUrl}/city/api/enter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: cookie, 'x-city-csrf': csrf },
        body: JSON.stringify({ name: '茶客旁观者', entry: 'ryokogai:station', client_id: 'tab-roll' }),
      });
      expect(enterRes.status).toBe(200);
      const enterJson = (await enterRes.json()) as any;
      const humanId = String(enterJson.resident_id);

      const humanAct = async (requestId: string, action: Record<string, unknown>) => {
        const res = await fetch(`${baseUrl}/city/api/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: cookie, 'x-city-csrf': csrf },
          body: JSON.stringify({ request_id: requestId, action, client_id: 'tab-roll' }),
        });
        return { status: res.status, body: (await res.json()) as any };
      };
      const heartbeat = async () => {
        const res = await fetch(`${baseUrl}/city/api/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: cookie, 'x-city-csrf': csrf },
          body: JSON.stringify({ client_id: 'tab-roll' }),
        });
        expect(res.status).toBe(200);
      };
      const advanceKeepingOnline = async (totalMs: number) => {
        let left = totalMs;
        while (left > 0) {
          const step = Math.min(left, 5 * MIN);
          t.run(step);
          left -= step;
          await heartbeat();
        }
      };

      // 网页茶客与另一位 MCP 藏家同到棱光街茶屋（10:06 JST，处于 s40）
      await humanAct('req-roll-travel', { type: 'travel', to: BOARDGAME_CHAYA_ID });
      const bidderBot = t.bot('神秘藏家', { entry: 'ryokogai:station', stay: true });
      bidderBot.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
      t.run(6 * MIN);

      const v0 = (await (await fetch(`${baseUrl}/city/api/me?client_id=tab-roll`, { headers: { Cookie: cookie } })).json()) as any;
      expect(v0.here.place.id).toBe(BOARDGAME_CHAYA_ID);
      expect(v0.here.auctions).toHaveLength(1);
      const s40Id = String(v0.here.auctions[0].id);
      expect(s40Id).toContain(':s40:');

      // 打开真实 SSE 流（从当前游标监听，模拟网页停留在茶屋不手动刷新）
      const sseRes = await fetch(`${baseUrl}/city/api/stream?client_id=tab-roll&cursor=${encodeURIComponent(String(v0.cursor))}`, {
        headers: { Cookie: cookie },
        signal: ac.signal,
      });
      expect(sseRes.status).toBe(200);
      const reader = sseRes.body!.getReader();
      const dec = new TextDecoder();
      let sseBuf = '';
      const readNextPrivate = async (timeoutMs = 1500): Promise<Record<string, any>> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const sep = sseBuf.indexOf('\n\n');
          if (sep >= 0) {
            const chunk = sseBuf.slice(0, sep);
            sseBuf = sseBuf.slice(sep + 2);
            let evName = '';
            let dataLine = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) evName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
            }
            if (evName === 'private' && dataLine) return JSON.parse(dataLine);
            continue;
          }
          const waitLeft = Math.max(10, deadline - Date.now());
          const readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('SSE private event timeout')), waitLeft)),
          ]);
          if (readResult.done) throw new Error('SSE stream closed early');
          sseBuf += dec.decode(readResult.value, { stream: true });
        }
      };

      // 1) s40 无人出价，茶客在线保活跨过 10:15 JST 自动滚到 s41
      const cursorBeforeS41 = t.c.cursorOf(humanId);
      await advanceKeepingOnline(10 * MIN); // 10:16 JST

      const evs1 = t.c.readResidentEvents(humanId, cursorBeforeS41, 20).events;
      expect(evs1.some((e) => e.type === 'auction_unsold' && e.data.auction_id === s40Id)).toBe(true);
      expect(evs1.some((e) => e.type === 'auction_opened' && String(e.data.auction_id).includes(':s41:'))).toBe(true);
      for (const e of evs1) {
        expect(e.data).not.toHaveProperty('bid_yen');
        expect(e.data).not.toHaveProperty('winning_price');
      }

      const sseEv1 = await readNextPrivate();
      expect(['auction_unsold', 'auction_opened']).toContain(sseEv1.type);
      expect(sseEv1).not.toHaveProperty('bid_yen');
      expect(sseEv1).not.toHaveProperty('winning_price');
      // 把同一批次的第二条 private 事件也消费掉，保持后续 s42 断言边界清晰
      const sseEv1b = await readNextPrivate();
      expect(['auction_unsold', 'auction_opened']).toContain(sseEv1b.type);

      const v1 = (await (await fetch(`${baseUrl}/city/api/me?client_id=tab-roll`, { headers: { Cookie: cookie } })).json()) as any;
      expect(v1.here.auctions).toHaveLength(1);
      const s41Id = String(v1.here.auctions[0].id);
      expect(s41Id).toContain(':s41:');
      expect(s41Id).not.toBe(s40Id);

      const oldBid = await humanAct('req-old-s40', { type: 'auction_bid', auction_id: s40Id, yen: 600 });
      expect(oldBid.status).toBe(422);
      expect(oldBid.body.reason).toBe('auction_closed');

      // 2) 他人在 s41 密封出价 ¥777，网页旁观者未出价且在线保活，跨过 10:30 JST 成交滚到 s42
      bidderBot.act({ type: 'auction_bid', auction_id: s41Id, yen: 777 });
      const cursorBeforeS42 = t.c.cursorOf(humanId);
      await advanceKeepingOnline(15 * MIN); // 10:31 JST

      const evs2 = t.c.readResidentEvents(humanId, cursorBeforeS42, 20).events;
      expect(evs2.some((e) => e.type === 'auction_closed' && e.data.auction_id === s41Id)).toBe(true);
      expect(evs2.some((e) => e.type === 'auction_opened' && String(e.data.auction_id).includes(':s42:'))).toBe(true);
      // 旁观者事件流中严禁出现他人密封金额 777 或任何成交价字段
      expect(JSON.stringify(evs2)).not.toContain('777');
      for (const e of evs2) {
        expect(e.data).not.toHaveProperty('bid_yen');
        expect(e.data).not.toHaveProperty('winning_price');
        expect(e.data).not.toHaveProperty('winner');
      }

      const sseEv2a = await readNextPrivate();
      const sseEv2b = await readNextPrivate();
      expect([sseEv2a.type, sseEv2b.type]).toEqual(['auction_closed', 'auction_opened']);
      expect(JSON.stringify([sseEv2a, sseEv2b])).not.toContain('777');

      // 网页收到 SSE 自动拉取 /me 后按新场次 s42 直接出价成功
      const v2 = (await (await fetch(`${baseUrl}/city/api/me?client_id=tab-roll`, { headers: { Cookie: cookie } })).json()) as any;
      const s42 = v2.here.auctions[0];
      expect(String(s42.id)).toContain(':s42:');
      const newBid = await humanAct('req-new-s42', { type: 'auction_bid', auction_id: s42.id, yen: s42.reserve_yen + 80 });
      expect(newBid.status).toBe(200);
      expect(newBid.body.ok).toBe(true);
      expect(newBid.body.auction_id).toBe(s42.id);
      expect(ledgerImbalance(t.c)).toBe(0);
      expect(runReconcile(t.c, 'rollover-bystander-bid').ok).toBe(true);
    } finally {
      ac.abort();
      closeCity();
      srv.close();
    }
  });

  it('牌桌实时事件回归：在店旁观者同步收到入座/开局/散局公开事件，且对局超时托管推进时同桌玩家收到 venue_table_updated', () => {
    const t = makeCity();
    const a = t.bot('牌客甲', { entry: 'ryokogai:station', stay: true });
    const b = t.bot('牌客乙', { entry: 'ryokogai:station', stay: true });
    const cWatcher = t.bot('茶客旁观丙', { entry: 'ryokogai:station', stay: true });
    a.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    b.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    cWatcher.act({ type: 'travel', to: BOARDGAME_CHAYA_ID });
    t.run(10 * MIN);

    const cur0 = t.c.cursorOf(cWatcher.id);
    const opened = a.act({
      type: 'open_table',
      game: 'liars_dice',
      options: { lives: 1, dice_per_player: 2, turn_timeout_s: 15, random_seats: false },
    });
    b.act({ type: 'join_table', table_id: opened.table_id });
    a.act({ type: 'start_table', table_id: opened.table_id });

    const watcherEvs = t.c.readResidentEvents(cWatcher.id, cur0, 20).events;
    expect(watcherEvs.map((e) => e.type)).toEqual(
      expect.arrayContaining(['venue_table_opened', 'venue_table_joined', 'venue_table_started']),
    );
    // 旁观者事件严禁泄露手牌或骰子
    for (const ev of watcherEvs) {
      expect(ev.data).not.toHaveProperty('hand');
      expect(ev.data).not.toHaveProperty('dice');
      expect(ev.data).not.toHaveProperty('you');
    }

    // 当前行动方不操作，等 20s 触发 venue_table_tick 超时托管推进，对手必须收到 venue_table_updated 唤醒
    const bCurBeforeTimeout = t.c.cursorOf(b.id);
    const aCurBeforeTimeout = t.c.cursorOf(a.id);
    t.run(20_000);
    const aTickEvs = t.c.readResidentEvents(a.id, aCurBeforeTimeout, 20).events;
    const bTickEvs = t.c.readResidentEvents(b.id, bCurBeforeTimeout, 20).events;
    expect(
      aTickEvs.some((e) => e.type === 'venue_table_updated' || e.type === 'venue_table_ended') &&
        bTickEvs.some((e) => e.type === 'venue_table_updated' || e.type === 'venue_table_ended'),
    ).toBe(true);

    // 推进到整局结束，在店旁观者收到散局通知以刷新大厅列表
    const cCurBeforeEnd = t.c.cursorOf(cWatcher.id);
    const bViewAfterTick = b.view() as any;
    if (bViewAfterTick.venue_table?.todo?.actions?.includes('challenge')) {
      b.act({ type: 'game_act', input: { action: 'challenge' } });
    } else {
      for (let i = 0; i < 20; i++) {
        const tbl = t.c.db.get<{ status: string }>('SELECT status FROM venue_tables WHERE table_id = ?', opened.table_id)!;
        if (tbl.status !== 'running') break;
        t.run(20_000);
      }
    }
    const finalTbl = t.c.db.get<{ status: string }>('SELECT status FROM venue_tables WHERE table_id = ?', opened.table_id)!;
    expect(finalTbl.status).toBe('completed');
    const watcherEndEvs = t.c.readResidentEvents(cWatcher.id, cCurBeforeEnd, 20).events;
    expect(watcherEndEvs.some((e) => e.type === 'venue_table_ended')).toBe(true);
  });
});
