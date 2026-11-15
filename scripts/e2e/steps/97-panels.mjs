// V1 第四项：面板上的七件小事。A 桌面 1440x900，B 手机 390x844 触摸（抽屉）。
//  4.1 聊天列表第一行不被页头盖住   4.2 手机全镇公屏至少 6 行、地点下拉有样式、点得到的目标不小于 44 像素
//  4.3 按钮不透底：启用对比度 >= 4.5、禁用 >= 3 且明显发灰（正午和傍晚各量一遍）   4.4 气泡折行：最后一行至少 2 个字
//  4.5 只读提示不重复   4.6 页签条能滚时有渐隐和箭头   4.7 手机横屏矮屏：游戏面板不压提示条、「轮到你」时面板内部不出滚动条
import { poll, openDock, closeDock, frames, rectOf } from '../lib/ui.mjs';
import { apiSay } from '../lib/chat.mjs';
import { hit, contrastOf, settleView, sleep } from '../lib/look.mjs';

export const meta = { id: 'look-panels', n: 97, title: 'V1 面板小项' };

export default async function run(h) {
  const { check, note, until, step, shot, BASE, snap } = h;
  const { A, B } = await h.pair();

  const selectTab = (p, id) => p.page.evaluate((i) => window.TownDock.test.select(i), id);
  const feedGame = (p, kind, d) => p.page.evaluate(([k, j]) => window.TownHud.feed('game', k, j), [kind, JSON.stringify(d)]);
  const fakeGame = (n, over = {}) => ({
    mode: 'game', name: '数字炸弹', gameId: 'fake-game-v1', mySeat: 1, loading: false, round: 3, title: '猜数', open: true, secondsLeft: 40, phaseId: 7, yourTurn: true, curSeat: 1,
    range: { from: 20, to: 80 }, bombMode: 'single', over: false,
    players: Array.from({ length: n }, (_, i) => ({ seat: i + 1, name: `玩家${i + 1}号`, kind: i % 2 ? 'agent' : 'human', alive: true, turn: i === 0, me: i === 0 })),
    history: Array.from({ length: 6 }, (_, i) => ({ round: i + 1, seat: (i % n) + 1, name: `玩家${(i % n) + 1}号`, guess: 20 + i, result: '炸弹更大', auto: false })),
    ...over,
  });

  // ───────────────────────── 97 聊天列表第一行 ─────────────────────────
  await step(97, '聊天列表第一行不被页头盖住：附近、全镇两个页签，手机抽屉里和桌面侧栏里，列表滚到顶时第一条消息的上沿不低于页头下沿；列表有 3 条以上消息', async () => {
    const lines = ['第一条：今天的灯会在广场上点灯，大家记得来看看呀', '第二条：我带了新煮的茶，路过茶馆的话可以来喝一杯', '第三条：书屋新到了一批旧书，有人想一起去翻翻吗'];
    for (const t of lines) await apiSay(A, t);
    for (const p of [B, A]) {
      await openDock(p.page);
      for (const id of ['nearby', 'town']) {
        await selectTab(p, id);
        await frames(p.page, 3);
        if (id === 'nearby') await until(async () => (await p.page.evaluate(() => document.querySelectorAll('[data-pane="nearby"] li.msg').length)) >= 3, 20_000, `${p.label} 附近列表有 3 条`, 200);
        const r = await p.page.evaluate((pane) => {
          const root = document.querySelector(`[data-pane="${pane}"]`);
          const list = root.querySelector('[data-role="list"]');
          list.scrollTop = 0;
          const head = root.querySelector('.scope').getBoundingClientRect();
          const first = list.querySelector('li');
          const lr = list.getBoundingClientRect();
          return { headBottom: head.bottom, listTop: lr.top, first: first ? first.getBoundingClientRect().top : null, n: list.querySelectorAll('li').length, scrollTop: list.scrollTop };
        }, id);
        check(r.first === null || r.first >= r.headBottom - 0.5, `${p.label} ${id}：第一行（上沿 ${r.first}）不应被页头（下沿 ${r.headBottom}）盖住：${JSON.stringify(r)}`);
        note(`${p.label} ${id}：页头下沿 ${r.headBottom.toFixed(0)}，列表上沿 ${r.listTop.toFixed(0)}，第一行上沿 ${r.first === null ? '无' : r.first.toFixed(0)}，共 ${r.n} 行`);
      }
      await closeDock(p.page);
    }
  });

  // ───────────────────────── 97.1 手机全镇公屏 ─────────────────────────
  await step(97.1, '手机 390x844 抽屉开着的全镇公屏：列表区至少能放 6 行（按气泡行高算）；地点下拉有自己的样式（不是浏览器默认外观）；输入栏、发送、类型小牌、地点下拉、静音等可点目标高度不低于 44 像素', async () => {
    await openDock(B.page);
    await selectTab(B, 'town');
    await settleView(B.page, { what: 'B 稳定' });
    await frames(B.page, 3);
    const m = await B.page.evaluate(() => {
      const root = document.querySelector('[data-pane="town"]');
      const list = root.querySelector('[data-role="list"]');
      const bub = list.querySelector('.bub') ?? document.createElement('div');
      const lh = parseFloat(getComputedStyle(root.querySelector('.msg .bub') ?? bub).lineHeight) || 18;
      const sel = root.querySelector('[data-role="placeSel"]');
      const cs = sel ? getComputedStyle(sel) : null;
      // 点按区高度：元素自己的高度，加上用伪元素外扩出来的部分（沿中线上下用 elementFromPoint 探到不再是它自己为止）
      const reach = (e) => {
        const r = e.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const mine = (x) => !!x && (x === e || e.contains(x));
        let up = 0;
        let down = 0;
        while (up < 40 && mine(document.elementFromPoint(cx, cy - up - 1))) up++;
        while (down < 40 && mine(document.elementFromPoint(cx, cy + down + 1))) down++;
        return Math.max(r.height, up + down + 1);
      };
      const targets = [...root.querySelectorAll('button, select, input')]
        .filter((e) => !e.hidden && e.offsetWidth > 0 && e.offsetHeight > 0 && getComputedStyle(e).visibility !== 'hidden')
        .map((e) => ({ name: (e.getAttribute('data-role') || e.getAttribute('data-kind') || e.tagName) + '', h: reach(e), w: e.getBoundingClientRect().width }));
      return { listH: list.clientHeight, lh, sel: cs && { appearance: cs.appearance, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, border: cs.borderTopWidth, hidden: sel.hidden }, targets, kinds: !!root.querySelector('.kinds') && getComputedStyle(root.querySelector('.kinds')).display };
    });
    const lines = m.listH / m.lh;
    check(lines >= 6, `列表区应至少放 6 行：${m.listH}px / 行高 ${m.lh}px = ${lines.toFixed(1)}`);
    note(`列表高 ${m.listH}px，气泡行高 ${m.lh}px，约 ${lines.toFixed(1)} 行；下拉 ${JSON.stringify(m.sel)}`);
    if (m.sel && !m.sel.hidden) check(m.sel.appearance === 'none' && parseFloat(m.sel.radius) > 0 && parseFloat(m.sel.border) >= 1, `地点下拉应有自己的样式：${JSON.stringify(m.sel)}`);
    const small = m.targets.filter((t) => t.h < 44);
    check(small.length === 0, `可点目标高度应不低于 44 像素：${JSON.stringify(small)}`);
    note(`可点目标：${m.targets.map((t) => `${t.name}:${t.h.toFixed(0)}`).join(' ')}`);
    await shot(B.page, '95-mobile-town-chat');
    await closeDock(B.page);
  });

  // ───────────────────────── 97.2 按钮不透底 ─────────────────────────
  await step(97.2, '按钮对比度（正午 hour=12 和傍晚 hour=19.5 各量一遍，A 桌面、B 手机）：启用的按钮文字对底不低于 4.5，禁用的不低于 3 且底色和启用的明显不同（发灰）', async () => {
    const results = {};
    for (const hour of [12, 19.5]) {
      for (const p of [A, B]) {
        p.w.closing = true;
        await p.page.goto(`${BASE}/town/3d/?debug=1&hour=${hour}`);
        await p.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
        p.w.closing = false;
        await p.page.click('#enterBtn');
        await p.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
        await until(async () => Math.abs((await p.page.evaluate(() => window.__town.hour)) - hour) < 0.4, 15_000, `${p.label} 钟点到 ${hour}`);
        await settleView(p.page, { what: `${p.label} 稳定` });
        const rows = await p.page.evaluate(() =>
          [...document.querySelectorAll('#controls button, #actions button, #stack button')]
            .filter((e) => !e.hidden && e.offsetWidth > 0 && e.offsetHeight > 0)
            .map((e) => ({ id: e.id || e.textContent.trim().slice(0, 6), dis: e.disabled, sel: e.id ? `#${e.id}` : null })),
        );
        const withId = rows.filter((r) => r.sel);
        check(withId.some((r) => r.dis) && withId.some((r) => !r.dis), `${p.label} hour=${hour}：应能量到启用和禁用的按钮各至少一个：${JSON.stringify(rows)}`);
        const out = await contrastOf(p.page, withId.map((r) => r.sel));
        const byDis = Object.fromEntries(withId.map((r) => [r.id, r.dis]));
        const bad = [];
        const grey = [];
        for (const o of out) {
          const id = o.sel.slice(1);
          const dis = byDis[id];
          if (!dis && o.ratio < 4.5) bad.push(`${id}(启用) ${o.ratio}`);
          if (dis && o.ratio < 3) bad.push(`${id}(禁用) ${o.ratio}`);
          if (dis) grey.push(o.bg);
        }
        const enabledBg = out.filter((o) => !byDis[o.sel.slice(1)]).map((o) => o.bg);
        const dist = (a, b) => Math.hypot(...a.split(',').map(Number).map((v, i) => v - b.split(',').map(Number)[i]));
        for (const g of grey) if (enabledBg.length && Math.min(...enabledBg.map((e) => dist(g, e))) < 12) bad.push(`禁用底色 ${g} 与启用底色 ${enabledBg} 区别不明显`);
        check(bad.length === 0, `${p.label} hour=${hour}：对比度不达标：${bad.join('；')}（全部 ${JSON.stringify(out.map((o) => [o.sel, o.ratio, o.bg]))}）`);
        results[`${p.label.slice(2, 4)}${hour}`] = out.map((o) => `${o.sel.slice(1)}:${o.ratio}${byDis[o.sel.slice(1)] ? '禁' : ''}`).join(' ');
        if (hour === 19.5 && p === B) await shot(p.page, '95-mobile-buttons-evening');
      }
    }
    note(`对比度：${JSON.stringify(results)}`);
  });

  // ───────────────────────── 97.3 气泡折行 ─────────────────────────
  await step(97.3, '气泡折行：#tags 里放一块真的 .tag.b，文字从 8 到 48 个字逐个长度试一遍（带标点和不带各一遍），凡是折成多行的，最后一行至少 2 个字', async () => {
    const r = await A.page.evaluate(() => {
      const base = '今天的灯会在广场上点灯大家记得来看看呀我带了新煮的茶路过茶馆的话可以来喝一杯书屋新到了一批旧书有人想一起去翻翻吗';
      const withP = '今天的灯会，在广场上点灯！大家记得来看看呀。我带了新煮的茶，路过茶馆的话可以来喝一杯；书屋新到了一批旧书，有人想一起去翻翻吗？';
      const box = document.getElementById('tags');
      const el = document.createElement('div');
      el.className = 'tag b';
      el.style.left = '40px';
      el.style.top = '300px';
      el.style.visibility = 'hidden';
      box.appendChild(el);
      const bad = [];
      let multi = 0;
      const lastLen = (txt) => {
        el.textContent = txt;
        const node = el.firstChild;
        const tops = [];
        for (let i = 0; i < txt.length; i++) {
          const rg = document.createRange();
          rg.setStart(node, i);
          rg.setEnd(node, i + 1);
          const rr = rg.getClientRects()[0];
          if (rr) tops.push(Math.round(rr.top));
        }
        const lastTop = tops[tops.length - 1];
        const first = tops[0];
        return { n: tops.filter((t) => t === lastTop).length, lines: new Set(tops).size, single: lastTop === first };
      };
      for (const src of [base, withP]) {
        for (let n = 8; n <= 48; n++) {
          const txt = src.slice(0, n);
          const m = lastLen(txt);
          if (m.lines > 1) {
            multi++;
            if (m.n < 2) bad.push(`${n} 字：最后一行 ${m.n} 个字（${m.lines} 行）`);
          }
        }
      }
      const width = el.getBoundingClientRect().width;
      el.remove();
      return { bad, multi, width, ws: getComputedStyle(box).textWrap };
    });
    check(r.multi >= 10, `应有足够多折成多行的样本：${r.multi}`);
    check(r.bad.length === 0, `最后一行不足 2 个字：${r.bad.join('；')}`);
    note(`折成多行的样本 ${r.multi} 个，最后一行都至少 2 个字`);
  });

  // ───────────────────────── 97.4 只读提示不重复 ─────────────────────────
  await step(97.4, '只读提示不重复：另一处接管后，横幅说一次「只读」；强行发话被拒后弹出的提示条不再重复「只读」，只说怎么拿回来；#stack 里含「只读」的可见元素只有横幅一个', async () => {
    await openDock(A.page);
    await selectTab(A, 'nearby');
    const cid = await A.page.evaluate(() => window.TownHud.clientId());
    const other = `e2e-other-${Math.random().toString(36).slice(2, 8)}`;
    const re = await A.ctx.request.post(`${BASE}/town/api/enter`, { data: { clientId: other } });
    check(re.ok(), `另一处登记在场应成功：${re.status()}`);
    const rc = await A.ctx.request.post(`${BASE}/town/api/claim`, { data: { clientId: other } });
    check(rc.ok(), `另一处接管应成功：${rc.status()}`);
    try {
      await until(async () => (await snap(A.page)).mine === false, 15_000, 'A 页面变成只读', 200);
      await poll(async () => (await A.page.evaluate(() => !document.getElementById('readonly').hidden)), 10_000, '横幅出现', 100);
      await A.page.evaluate(() => window.TownDock.test.forceSend('只读里的一句话'));
      await poll(async () => (await A.page.evaluate(() => document.querySelectorAll('#toasts .toast').length)) > 0, 10_000, '提示条出现', 100);
      const v = await A.page.evaluate(() => {
        const vis = (e) => e.offsetWidth > 0 && e.offsetHeight > 0 && !e.hidden;
        const hits = [...document.querySelectorAll('#stack *')].filter((e) => vis(e) && e.children.length === 0 && /只读/.test(e.textContent)).map((e) => `${e.id || e.className}:${e.textContent.trim()}`);
        const toasts = [...document.querySelectorAll('#toasts .toast')].map((e) => e.textContent);
        return { hits, toasts };
      });
      check(v.hits.length === 1 && v.hits[0].startsWith('') && /接管|只读/.test(v.hits[0]), `#stack 里含「只读」的可见元素应只有横幅一个：${JSON.stringify(v.hits)}`);
      check(v.toasts.length > 0 && v.toasts.every((t) => !/只读/.test(t)) && v.toasts.some((t) => /接管/.test(t)), `提示条应只说怎么拿回来：${JSON.stringify(v.toasts)}`);
      note(`横幅 ${JSON.stringify(v.hits)}；提示条 ${JSON.stringify(v.toasts)}`);
      await shot(A.page, '95-desktop-readonly');
    } finally {
      // 接管回来
      await A.page.evaluate(() => document.getElementById('claimBtn')?.click()).catch(() => {});
      await until(async () => (await snap(A.page)).mine === true, 20_000, 'A 接管回来', 300).catch(() => {});
      await closeDock(A.page).catch(() => {});
    }
    void cid;
  });

  // ───────────────────────── 97.5 页签条渐隐 ─────────────────────────
  await step(97.5, '页签条放不下时有渐隐加箭头：窗口窄到 320 时页签条能滚；滚到最左只有右侧提示，中间两侧都有，滚到最右只有左侧；宽到放得下时两侧都没有', async () => {
    try {
      await B.page.setViewportSize({ width: 320, height: 640 });
      await openDock(B.page);
      await frames(B.page, 4);
      const st = () => B.page.evaluate(() => {
        const box = document.getElementById('dockTabs');
        const l = document.getElementById('dockFadeL');
        const r = document.getElementById('dockFadeR');
        const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
        return { max: box.scrollWidth - box.clientWidth, sl: box.scrollLeft, L: vis(l), R: vis(r), pe: l && getComputedStyle(l).pointerEvents };
      });
      let s = await st();
      if (s.max <= 8) {
        // 现在只有四个页签，320 宽也放得下：把页签条的可用宽度压到 150，让它真的放不下（模块多起来之后就是这个样子）
        await B.page.evaluate(() => { const b = document.getElementById('dockTabs'); b.style.maxWidth = '150px'; b.scrollLeft = 0; b.dispatchEvent(new Event('scroll')); });
        await frames(B.page, 3);
        s = await st();
        note('320 宽时四个页签放得下，用 max-width:150px 把页签条压窄来触发（V1.md 里说明）');
      }
      check(s.max > 8, `页签条应能滚：${JSON.stringify(s)}`);
      await B.page.evaluate(() => { document.getElementById('dockTabs').scrollLeft = 0; });
      await poll(async () => { const x = await st(); return !x.L && x.R; }, 5000, '最左：只有右侧提示', 100);
      await B.page.evaluate(() => { const b = document.getElementById('dockTabs'); b.scrollLeft = (b.scrollWidth - b.clientWidth) / 2; });
      await poll(async () => { const x = await st(); return x.L && x.R; }, 5000, '中间：两侧都有', 100);
      await shot(B.page, '95-mobile-tabfade');
      await B.page.evaluate(() => { const b = document.getElementById('dockTabs'); b.scrollLeft = b.scrollWidth; });
      await poll(async () => { const x = await st(); return x.L && !x.R; }, 5000, '最右：只有左侧提示', 100);
      s = await st();
      check(s.pe === 'none', `渐隐不应收指针：${s.pe}`);
      await B.page.evaluate(() => { const b = document.getElementById('dockTabs'); b.style.maxWidth = ''; b.dispatchEvent(new Event('scroll')); });
      await B.page.setViewportSize({ width: 1000, height: 640 });
      await frames(B.page, 4);
      await poll(async () => { const x = await st(); return x.max <= 2 && !x.L && !x.R; }, 5000, '放得下时没有提示', 100);
    } finally {
      await B.page.evaluate(() => { const b = document.getElementById('dockTabs'); if (b) b.style.maxWidth = ''; }).catch(() => {});
      await B.page.setViewportSize({ width: 390, height: 844 });
      await closeDock(B.page).catch(() => {});
    }
    await frames(B.page, 3);
  });

  // ───────────────────────── 97.6 手机横屏矮屏的游戏面板 ─────────────────────────
  await step(97.6, '手机横屏 667x375（侧栏面板开着）：游戏面板「轮到你」时不压提示条（#stack）、不压底部按钮、面板内部没有滚动条；568x320 尽力而为（只记录）', async () => {
    const meas = (p) => p.page.evaluate(() => {
      const g = document.getElementById('gamePanel');
      const r = g.getBoundingClientRect();
      const cs = (id) => { const e = document.getElementById(id); if (!e || e.hidden || e.offsetWidth === 0) return null; return e.getBoundingClientRect().toJSON(); };
      return { kids: [...g.querySelectorAll('.game-play > *, .game-play')].map((e) => `${e.className}:${Math.round(e.getBoundingClientRect().height)}`), panel: r.toJSON(), sh: g.scrollHeight, ch: g.clientHeight, stack: cs('stack'), toasts: cs('toasts'), bottombar: cs('bottombar'), dock: cs('dock'), topbar: cs('topbar'), vh: window.innerHeight, vw: window.innerWidth, shown: !g.hidden };
    });
    const results = [];
    try {
      for (const [w, hgt, strict] of [[667, 375, true], [568, 320, false]]) {
        await B.page.setViewportSize({ width: w, height: hgt });
        await frames(B.page, 4);
        await openDock(B.page); // 侧栏面板开着：这是最挤的情形
        await feedGame(B, 'state', fakeGame(2));
        await until(async () => (await B.page.evaluate(() => document.body.getAttribute('data-game'))) === '1', 8000, 'B 进入局中', 100);
        await settleView(B.page, { what: '稳定', timeout: 20_000 }).catch(() => {});
        await poll(async () => (await meas(B)).shown, 5000, '面板出现', 100);
        // 提示条还在的时候量（它几秒就收）：放一条，等它出现和面板按它让开，马上量
        await B.page.evaluate(() => window.TownHud.toast('这是一条提示，用来看面板有没有压到它', 'info'));
        await poll(async () => (await B.page.evaluate(() => document.querySelectorAll('#toasts .toast').length)) > 0, 3000, '提示条出现', 50);
        await sleep(450);
        const m = await meas(B);
        check(m.toasts && m.toasts.height > 10, `量的时候提示条应还在：${JSON.stringify(m.toasts)}`);
        const overlapToast = m.toasts && hit(m.panel, m.toasts);
        const overlapStack = m.stack && hit(m.panel, m.stack);
        const overlapBar = m.bottombar && hit(m.panel, m.bottombar);
        const scroll = m.sh > m.ch + 1;
        note(`${w}x${hgt} 面板各块：${m.kids.join(' ')}`);
        results.push(`${w}x${hgt}：面板 ${Math.round(m.panel.top)}..${Math.round(m.panel.bottom)} 提示条 ${m.toasts ? `${Math.round(m.toasts.top)}..${Math.round(m.toasts.bottom)}` : '无'} 底栏 ${m.bottombar ? Math.round(m.bottombar.top) : '无'} 内部滚动 ${m.sh}/${m.ch}`);
        if (strict) {
          check(!overlapToast && !overlapStack, `${w}x${hgt}：游戏面板不应压提示条：面板 ${JSON.stringify([m.panel.left, m.panel.top, m.panel.right, m.panel.bottom].map(Math.round))} 提示条 ${JSON.stringify(m.toasts)}`);
          check(!overlapBar, `${w}x${hgt}：游戏面板不应压底栏：${JSON.stringify(m.bottombar)}`);
          check(!scroll, `${w}x${hgt}：「轮到你」时面板内部不应有滚动条：scrollHeight ${m.sh} 对 clientHeight ${m.ch}`);
          check(m.panel.top >= (m.topbar?.bottom ?? 0) - 1, `${w}x${hgt}：面板不应顶到顶栏上去：${m.panel.top} 对 ${m.topbar?.bottom}`);
          await shot(B.page, '95-mobile-landscape-game');
        }
        await feedGame(B, 'reset', null);
        await until(async () => (await B.page.evaluate(() => document.body.getAttribute('data-game'))) === null, 8000, '局中撤掉', 100);
      }
    } finally {
      await feedGame(B, 'reset', null).catch(() => {});
      await B.page.setViewportSize({ width: 390, height: 844 });
      await closeDock(B.page).catch(() => {});
    }
    note(results.join('；'));
  });

  await h.release(A);
  await h.release(B);
}

/*
 * 怎么让它失败（临时改动 -> 应当变红的子步骤；改完一定改回来）
 * 【实测过】（结果见 client/docs/V1.md「反向验证」）
 *  1. 00-chatkit.css 的 .chat-pane .scope 改成 position:absolute（盖在列表上）-> 97「第一行不应被页头盖住」。
 *  2. hud.css 里把 #controls button 的背景改回半透明（rgba(...,0.4)）-> 97.2 对比度不达标。
 *  3. bubbles.css 去掉 text-wrap: pretty -> 97.3 最后一行只有 1 个字。
 *  4. hud.js 的 toast() 去掉「只读」换句 -> 97.4 提示条重复。
 *  5. dock.js 的 updateTabFade 里 r 永远 false -> 97.5 最左「只有右侧提示」。
 * 【只是推演】
 *  - 97.1 的 6 行：town.css 里抽屉模式把 .rules 恢复显示 -> 列表高度不够 6 行。
 *  - 97.6：game.css 去掉横屏矮屏的 @media 规则 -> 面板压到提示条或出滚动条。
 */
