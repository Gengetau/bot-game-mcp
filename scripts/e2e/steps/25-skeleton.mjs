// S0：骨架小补丁。页签条放得下五六个页签（四种视口）、E 键先问功能模块（on_pick）、测试口只在 ?debug=1 下存在。
// A 桌面 1440x900（侧栏），B 手机 390x844 触摸（抽屉）。假页签、假接管测完都卸掉，后面的 30、60 号文件不受影响。
// 末尾有一段「怎么让它失败」：分「实测过」和「只是推演、没验证」两部分，别把后一部分当成验证过的。
import { poll, dockState, godotFeature, openDock, closeDock, rectOf, frames } from '../lib/ui.mjs';
import { apiAct } from '../lib/chat.mjs';

export const meta = { id: 'skeleton', n: 25, title: 'S0 骨架：页签条容量与 E 键经 on_pick' };

// 假页签的文字：两个汉字，和真的页签一样宽（文字只在这个测试文件里，不进 mod/*.js）
const LABELS = ['甲乙', '丙丁', '戊己', '庚辛', '壬癸', '子丑'];
const FAKE_IDS = LABELS.map((_, i) => `s0fake${i + 1}`);

export default async function run(h) {
  const { check, note, until, step, shot, selfActor, dist, serverScene, snap, BASE } = h;
  const { A, B } = await h.pair();
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);

  // ───────────────────────── 页签条 ─────────────────────────
  const saveStore = (p) =>
    p.page.evaluate(() => {
      const r = {};
      for (const k of ['town3d.dockTab', 'town3d.dock']) {
        try {
          r[k] = localStorage.getItem(k);
        } catch {
          r[k] = null;
        }
      }
      return r;
    });
  const restoreStore = (p, saved) =>
    p.page.evaluate((s) => {
      for (const k of Object.keys(s)) {
        try {
          if (s[k] === null) localStorage.removeItem(k);
          else localStorage.setItem(k, s[k]);
        } catch {
          /* 没有存储也能跑 */
        }
      }
    }, saved);

  /** 临时注册 n 个假页签（编号 s0fake1..n，排在真页签后面）。 */
  const addFakes = (p, from, to) =>
    p.page.evaluate(
      ([labels, ids, a, b]) => {
        window.__s0hosts = window.__s0hosts || {};
        for (let i = a; i < b; i++) {
          const tpl = document.createElement('template');
          tpl.setAttribute('data-mod', ids[i]);
          tpl.setAttribute('data-tab-label', labels[i]);
          tpl.setAttribute('data-order', String(900 + i));
          const sec = document.createElement('section');
          sec.className = 'dock-pane';
          tpl.content.appendChild(sec);
          document.body.appendChild(tpl);
          window.TownDock.register({
            id: ids[i],
            api: window.TownDock.API_VERSION,
            mount(host) {
              window.__s0hosts[ids[i]] = host;
              return {};
            },
          });
        }
      },
      [LABELS, FAKE_IDS, from, to],
    );
  const removeFakes = (p) =>
    p.page.evaluate((ids) => {
      for (const id of ids) {
        window.TownDock.test.unregister(id);
        document.querySelector(`template[data-mod="${id}"]`)?.remove();
      }
      window.__s0hosts = {};
    }, FAKE_IDS);

  /** 页签条现状：每个页签的宽、中心点命中的是不是它自己（没被关闭钮或别的页签盖住）、关闭钮的外框。 */
  const stripInfo = (p) =>
    p.page.evaluate(() => {
      const box = document.getElementById('dockTabs');
      const br = box.getBoundingClientRect();
      const cr = document.getElementById('dockClose').getBoundingClientRect();
      const tabs = [...box.querySelectorAll('.dock-tab')].map((t) => {
        const r = t.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const el = document.elementFromPoint(cx, cy);
        // 点按区：条的顶端和底端各取一点，仍应命中这个页签（抽屉里要 >= 44px 高）
        const top = document.elementFromPoint(cx, br.top + 1);
        const bot = document.elementFromPoint(cx, br.bottom - 1);
        const dot = t.querySelector('.tab-dot');
        const dr = dot && !dot.hidden ? dot.getBoundingClientRect() : null;
        const dEl = dr ? document.elementFromPoint(dr.left + dr.width / 2, dr.top + dr.height / 2) : null;
        return {
          id: t.getAttribute('data-tab'),
          w: r.width,
          left: r.left,
          right: r.right,
          sel: t.classList.contains('sel'),
          hit: !!el && el.closest('.dock-tab') === t,
          hitWhat: el ? el.id || el.className || el.tagName : null,
          topHit: !!top && top.closest('.dock-tab') === t,
          botHit: !!bot && bot.closest('.dock-tab') === t,
          dotHit: dr ? !!dEl && dEl.closest('.dock-tab') === t : null,
        };
      });
      return { count: tabs.length, tabs, box: { left: br.left, right: br.right, top: br.top, bottom: br.bottom, h: br.height, scrollLeft: box.scrollLeft, scrollWidth: box.scrollWidth, clientWidth: box.clientWidth }, close: { left: cr.left, right: cr.right }, dataCount: box.getAttribute('data-count') };
    });

  async function stripRound(p, vp, expectLayout) {
    const tag = `${p.label} ${vp.width}x${vp.height}`;
    await p.page.setViewportSize(vp);
    await poll(async () => {
      const d = await dockState(p.page);
      return d?.layout === expectLayout;
    }, 10_000, `${tag} 布局变成 ${expectLayout}`);
    await openDock(p.page);
    await frames(p.page, 2);
    const real = (await dockState(p.page)).mods.length;
    // 不依赖真页签有几个：先数出来，再用假页签补到总数 5、6（真页签变多时假页签变少）
    check(real >= 1 && real <= 5, `真页签应有 1 到 5 个（假页签补到五个、六个）：现在 ${real} 个`);
    const nFive = 5 - real;
    await addFakes(p, 0, nFive);
    await until(async () => (await stripInfo(p)).count === 5, 5000, `${tag} 页签条里共五个页签（${real} 真 + ${nFive} 假）`);
    let s = await stripInfo(p);
    for (const t of s.tabs) check(t.hit, `${tag} 五个页签：${t.id} 的中心点命中的不是它自己，而是 ${t.hitWhat}`);
    const widths = s.tabs.map((t) => t.w.toFixed(1)).join('/');
    note(`${tag} 五个页签：宽 ${widths}，条宽 ${s.box.clientWidth}，内容宽 ${s.box.scrollWidth}${s.box.scrollWidth > s.box.clientWidth ? '（要滚动）' : '（放得下）'}`);
    if (expectLayout === 'drawer') {
      check(s.box.h >= 44, `${tag} 抽屉里页签条高应 >= 44 像素（触摸点按区），实际 ${s.box.h}`);
      for (const t of s.tabs) check(t.topHit && t.botHit, `${tag} ${t.id} 在条的顶端和底端都应点得到（点按区 >= 44 像素高）：top ${t.topHit} bottom ${t.botHit}`);
    }
    await shot(p.page, `25-${expectLayout}-${vp.width}-5tabs`);
    // 悬停：选中页签仍是纸色底（不能被 #dock button:hover 清成 none 而露出木色），未选中的仍是深木色底
    if (expectLayout === 'side') {
      const bg = (id) => p.page.evaluate((i) => getComputedStyle(document.querySelector(`#dockTabs [data-tab="${i}"]`)).backgroundColor, id);
      const paper = await p.page.evaluate(() => {
        const e = document.createElement('i');
        e.style.background = getComputedStyle(document.getElementById('dock')).getPropertyValue('--d-paper');
        document.body.appendChild(e);
        const c = getComputedStyle(e).backgroundColor;
        e.remove();
        return c;
      });
      const wood = await p.page.evaluate(() => getComputedStyle(document.getElementById('dockTabs')).backgroundColor);
      const selId = s.tabs.find((t) => t.sel).id;
      const other = s.tabs.find((t) => !t.sel).id;
      await p.page.hover(`#dockTabs [data-tab="${selId}"]`);
      await until(async () => (await p.page.evaluate((i) => document.querySelector(`#dockTabs [data-tab="${i}"]`).matches(':hover'), selId)) === true, 5000, `${tag} 鼠标悬停在选中页签上`);
      const fg = (id) => p.page.evaluate((i) => getComputedStyle(document.querySelector(`#dockTabs [data-tab="${i}"]`)).color, id);
      const ink = await p.page.evaluate(() => {
        const e = document.createElement('i');
        e.style.color = getComputedStyle(document.getElementById('dock')).getPropertyValue('--d-ink');
        document.body.appendChild(e);
        const c = getComputedStyle(e).color;
        e.remove();
        return c;
      });
      check((await fg(selId)) === ink, `${tag} 悬停时选中页签的字应仍是墨色 ${ink}，实际 ${await fg(selId)}`);
      check((await bg(selId)) === paper && paper !== wood, `${tag} 悬停时选中页签的背景应仍是纸色 ${paper}，实际 ${await bg(selId)}（木色底 ${wood}）`);
      await p.page.hover(`#dockTabs [data-tab="${other}"]`);
      await until(async () => (await p.page.evaluate((i) => document.querySelector(`#dockTabs [data-tab="${i}"]`).matches(':hover'), other)) === true, 5000, `${tag} 鼠标悬停在未选中页签上`);
      check((await bg(other)) !== wood && (await bg(other)) !== 'rgba(0, 0, 0, 0)', `${tag} 悬停时未选中页签仍有木牌底（不是透明、也不是条的木色）：${await bg(other)}`);
      await p.page.mouse.move(5, 5);
    }
    // 六个：再加一个，最后一个必须能滚到可见并点中
    await addFakes(p, nFive, nFive + 1);
    await until(async () => (await stripInfo(p)).count === 6, 5000, `${tag} 页签条里共六个页签`);
    const lastId = FAKE_IDS[nFive];
    // 给最后一个页签一个未读：小圆点不能被裁掉或被关闭钮盖住
    await p.page.evaluate((id) => window.__s0hosts[id].setUnread(2), lastId);
    await p.page.evaluate(() => {
      const b = document.getElementById('dockTabs');
      b.scrollLeft = b.scrollWidth;
    });
    await until(async () => {
      const x = await stripInfo(p);
      const last = x.tabs.find((t) => t.id === lastId);
      return last.hit && (x.box.scrollWidth <= x.box.clientWidth || x.box.scrollLeft > 0);
    }, 5000, `${tag} 最后一个页签滚到可见并且中心点命中自己`);
    s = await stripInfo(p);
    const last = s.tabs.find((t) => t.id === lastId);
    check(last.right <= s.close.left + 0.5, `${tag} 最后一个页签的右沿 ${last.right.toFixed(1)} 应在关闭钮左沿 ${s.close.left.toFixed(1)} 之内`);
    check(last.dotHit === true, `${tag} 最后一个页签的未读小圆点应可见且没被盖住：${last.dotHit}`);
    note(`${tag} 六个页签：条宽 ${s.box.clientWidth}，内容宽 ${s.box.scrollWidth}，滚到 ${s.box.scrollLeft.toFixed(0)}，最后一个右沿 ${last.right.toFixed(1)}，关闭钮左沿 ${s.close.left.toFixed(1)}`);
    await shot(p.page, `25-${expectLayout}-${vp.width}-6tabs`);
    // 真点最后一个：带 sel
    await p.page.click(`#dockTabs [data-tab="${lastId}"]`);
    await until(async () => (await stripInfo(p)).tabs.find((t) => t.id === lastId)?.sel === true, 5000, `${tag} 点最后一个页签后它带 sel`);
    check((await dockState(p.page)).tab === lastId, `${tag} 当前页签应是 ${lastId}`);
    // 回点第一个（真页签）：自动滚回可见，且它带 sel
    await p.page.evaluate(() => {
      document.getElementById('dockTabs').scrollLeft = 0;
    });
    const firstId = s.tabs[0].id;
    await p.page.click(`#dockTabs [data-tab="${firstId}"]`);
    await until(async () => {
      const x = await stripInfo(p);
      const f = x.tabs.find((t) => t.id === firstId);
      return f.sel && f.hit;
    }, 5000, `${tag} 点第一个页签后它带 sel 且可见`);
    // 选中的页签自动滚进可见范围：不动滚动条，直接用底座的接口选最后一个（和页签点击走同一个 setActive）
    await p.page.evaluate((id) => window.TownDock.test.select(id), lastId);
    await until(async () => {
      const x = await stripInfo(p);
      const l = x.tabs.find((t) => t.id === lastId);
      return l.sel && l.hit && l.right <= x.close.left + 0.5;
    }, 5000, `${tag} 选中最后一个页签后自动滚进可见（右沿在关闭钮之左）`);
    await removeFakes(p);
    await until(async () => (await stripInfo(p)).count === real, 5000, `${tag} 假页签卸干净，只剩 ${real} 个真页签`);
    s = await stripInfo(p);
    // 只有一个真页签时仍是不可点的标题（真页签变多以后这条不适用，由真页签数决定）
    if (real === 1) check(s.dataCount === '1' && (await p.page.evaluate(() => getComputedStyle(document.querySelector('#dockTabs .dock-tab')).pointerEvents)) === 'none', `${tag} 只有一个页签时仍是不可点的标题`);
    check(s.box.scrollLeft === 0, `${tag} 页签卸掉后滚动位置回到 0：${s.box.scrollLeft}`);
  }

  await step(25, '页签条（侧栏 1440x900 与 1100x800，抽屉 390x844 与 360x740）：五个、六个页签都点得到；关闭钮不盖页签；选中的自动滚进可见；只剩一个时仍是标题', async () => {
    const saved = { A: await saveStore(A), B: await saveStore(B) };
    const wasOpen = { A: (await dockState(A.page)).open, B: (await dockState(B.page)).open };
    const realAtStart = (await dockState(A.page)).mods.length;
    for (const [p, vp, lay] of [
      [A, { width: 1440, height: 900 }, 'side'],
      [A, { width: 1100, height: 800 }, 'side'],
      [B, { width: 390, height: 844 }, 'drawer'],
      [B, { width: 360, height: 740 }, 'drawer'],
    ]) {
      await stripRound(p, vp, lay);
    }
    // 恢复：视口、面板开关、记住的页签
    await A.page.setViewportSize({ width: 1440, height: 900 });
    await B.page.setViewportSize({ width: 390, height: 844 });
    await restoreStore(A, saved.A);
    await restoreStore(B, saved.B);
    if (!wasOpen.A) await closeDock(A.page);
    if (!wasOpen.B) await closeDock(B.page);
    const dA = await dockState(A.page);
    const dB = await dockState(B.page);
    check(dA.layout === 'side' && dB.layout === 'drawer', `视口恢复后布局应是侧栏 / 抽屉：${dA.layout} ${dB.layout}`);
    check(dA.mods.length === realAtStart && dB.mods.length === realAtStart, `假页签应已卸掉，只剩 ${realAtStart} 个真页签：A ${dA.mods} B ${dB.mods}`);
  });

  // ───────────────────────── 测试口只在 ?debug=1 下 ─────────────────────────
  await step(25.1, '没有 ?debug=1 的页面上没有测试口（TownDock.test、__dock、__town）；有 ?debug=1 的页面上有', async () => {
    check(await A.page.evaluate(() => !!window.TownDock.test && typeof window.TownDock.test.unregister === 'function' && typeof window.TownDock.test.select === 'function' && typeof window.__town?.pickStub === 'function'), '带 ?debug=1 的页面应有 TownDock.test.unregister / select 和 __town.pickStub');
    // 不带 debug 的页面：只要网页层（不起 Godot：把 wasm 和 pck 拦掉）
    const pg = await h.browsers[0].newPage();
    try {
      await pg.route(/\.(wasm|pck)(\?.*)?$/, (r) => r.abort());
      await pg.goto(`${BASE}/town/3d/`, { waitUntil: 'domcontentloaded' });
      await poll(() => pg.evaluate(() => !!window.TownDock && !!window.TownHud), 15_000, '不带 debug 的页面里有 TownDock 和 TownHud');
      const r = await pg.evaluate(() => ({ test: typeof window.TownDock.test, dock: typeof window.__dock, town: typeof window.__town, pickStub: typeof window.__town?.pickStub }));
      check(r.test === 'undefined' && r.dock === 'undefined' && r.town === 'undefined' && r.pickStub === 'undefined', `不带 ?debug=1 时不应有测试口：${JSON.stringify(r)}`);
    } finally {
      await pg.close();
    }
  });

  // ───────────────────────── E 键先问功能模块 ─────────────────────────
  const pickRec = async (p) => (await godotFeature(p.page, '_pick')) ?? null;
  const meReqs = [];
  A.page.on('request', (r) => {
    if (r.method() === 'GET' && /\/town\/api\/me(\?|$)/.test(r.url())) meReqs.push(Date.now());
  });
  const pressE = async (p) => {
    await p.page.keyboard.press('KeyE');
  };
  // 已并入的真功能会接管一部分点选（居民卡接管 3 米内的人，共同活动、游戏桌以后会接管物件）。这个文件核对的是骨架：
  // 「没有功能接管时旧行为照常」一律在「一律不接管」（pickStub('-')，hub 不问任何功能）下核对，真功能的接管由它们各自的步骤文件测
  const setStub = async (p, v) => {
    await p.page.evaluate((x) => window.__town.pickStub(x), v);
    await until(async () => ((await godotFeature(p.page, '_stub')) ?? '') === v, 10_000, `假接管状态变成「${v}」`);
  };
  const clearStub = (p) => p.page.evaluate(() => window.__town.pickStub('')).catch(() => {});
  const idle = (p) => until(async () => !selfActor(await serverScene(p))?.nav, 60_000, `${p.label} 走完`, 700);
  const meInteraction = async (p) => {
    const cid = await p.page.evaluate(() => window.TownHud.clientId());
    const j = await (await p.ctx.request.get(`${BASE}/town/api/me?clientId=${encodeURIComponent(cid)}`)).json();
    return j.interaction ?? null;
  };
  const SHELF = 'bookshop:shelf';

  await step(25.2, 'E 键走到物件旁：on_pick 记录 (obj, 藏书架, key, 没接管)，旧行为照常发生（start_interaction 成功、selected 记下）', async () => {
    await closeDock(A.page);
    const r0 = await apiAct(A, { type: 'navigate', to: SHELF });
    check(r0.status === 200, `A 导航到藏书架应成功：${JSON.stringify(r0.body)}`);
    await idle(A);
    const sc = await h.snap(A.page);
    const shelf = sc.objects.find((o) => o.id === SHELF);
    const me = sc.actors.find((a) => a.id === sc.self);
    check(shelf && dist(me, shelf) <= 8, `A 应在藏书架 8 米内（INTERACT_RANGE）：${shelf ? dist(me, shelf).toFixed(1) : '没有这个物件'}`);
    const nearest = Math.min(...sc.objects.filter((o) => o.id !== SHELF).map((o) => dist(me, o)), ...sc.actors.filter((a) => a.id !== sc.self).map((a) => dist(me, a)));
    check(dist(me, shelf) < nearest, `藏书架应是 A 最近的可互动目标（别的最近 ${nearest.toFixed(1)}）`);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    await setStub(A, '-');
    const n0 = (await pickRec(A))?.n ?? 0;
    const s0 = actionsOf(A, 'start_interaction').length;
    await pressE(A);
    const rec = await until(async () => {
      const r = await pickRec(A);
      return r && r.n > n0 ? r : null;
    }, 20_000, 'on_pick 记录出现');
    check(rec.kind === 'obj' && rec.id === SHELF && rec.src === 'key' && rec.taken === false, `记录应是 (obj, ${SHELF}, key, 没接管)：${JSON.stringify(rec)}`);
    const ok = await until(() => actionsOf(A, 'start_interaction').slice(s0).find((r) => r.status), 20_000, '旧行为：发出 start_interaction');
    check(ok.status === 200, `旧行为的 start_interaction 应成功：${ok.status} ${ok.code}`);
    check((await snap(A.page)).selected === SHELF, `旧行为应记下 selected：${(await snap(A.page)).selected}`);
    await until(async () => (await meInteraction(A))?.def === 'read_book' || (await meInteraction(A)) !== null, 15_000, '服务器上 A 在做共同活动');
    await clearStub(A);
    // 收拾：停下手上的事，等服务器确认
    const lv = await apiAct(A, { type: 'leave_interaction' });
    check(lv.status === 200, `A 停下读书：${JSON.stringify(lv.body)}`);
    await until(async () => (await meInteraction(A)) === null, 15_000, 'A 不在共同活动里了');
  });

  await step(25.3, 'E 键走到居民旁：on_pick 记录 (actor, 那位居民, key, 没接管)，旧行为照常发生（发出 navigate）', async () => {
    const r1 = await apiAct(A, { type: 'navigate', approach: B.id });
    check(r1.status === 200, `A 走到 B 身边：${JSON.stringify(r1.body)}`);
    await idle(A);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    const sc = await h.snap(A.page);
    const me = sc.actors.find((a) => a.id === sc.self);
    const b = sc.actors.find((a) => a.id === B.id);
    const nearestObj = Math.min(...sc.objects.map((o) => dist(me, o)));
    check(b && dist(me, b) <= 8 && dist(me, b) < nearestObj, `B 应是 A 最近的可互动目标：B ${b ? dist(me, b).toFixed(1) : '不见了'}，最近的物件 ${nearestObj.toFixed(1)}`);
    await setStub(A, '-');
    const n0 = (await pickRec(A))?.n ?? 0;
    const nav0 = actionsOf(A, 'navigate').length;
    await pressE(A);
    const rec = await until(async () => {
      const r = await pickRec(A);
      return r && r.n > n0 ? r : null;
    }, 20_000, 'on_pick 记录出现');
    check(rec.kind === 'actor' && rec.id === B.id && rec.src === 'key' && rec.taken === false, `记录应是 (actor, ${B.id}, key, 没接管)：${JSON.stringify(rec)}`);
    await until(() => actionsOf(A, 'navigate').length > nav0, 20_000, '旧行为：发出 navigate（走到 ta 身边）');
    await idle(A);
    await clearStub(A);
  });

  await step(25.4, '假接管：对 B 返回 true 之后按 E，记录是 (actor, B, key, 接管)，旧行为没有发生（屏障：之后的 /me 刷新和若干帧）；撤掉假接管后恢复旧行为', async () => {
    await setStub(A, B.id);
    try {
    await frames(A.page, 3);
    const rec0 = await pickRec(A);
    const n0 = rec0.n;
    const nav0 = actionsOf(A, 'navigate').length;
    const sel0 = (await snap(A.page)).selected;
    await pressE(A);
    const rec = await until(async () => {
      const r = await pickRec(A);
      return r && r.n > n0 ? r : null;
    }, 20_000, '有假接管时 on_pick 记录出现');
    check(rec.kind === 'actor' && rec.id === B.id && rec.src === 'key' && rec.taken === true, `记录应是 (actor, ${B.id}, key, 接管)：${JSON.stringify(rec)}`);
    // 屏障：一个在它之后才会出现的可观察事件。debug_act 发一个无副作用的动作，Godot 在它之后会读一次 /me；
    // 等到这次 /me，再多等几帧，才断言「没有」。旧逻辑（若错误地继续）在按键的同一帧里就会发 navigate，早于这个屏障
    const mark = meReqs.length;
    const up0 = actionsOf(A, 'update_profile').length;
    await A.page.evaluate(() => window.__town.act({ type: 'update_profile', muteTownChat: false }));
    await until(() => actionsOf(A, 'update_profile').length > up0, 20_000, '屏障动作有回应');
    await until(() => meReqs.length > mark, 20_000, '屏障动作之后 Godot 读了一次 /me');
    await frames(A.page, 5);
    check(actionsOf(A, 'navigate').length === nav0, `被接管后不应发出 navigate：${nav0} -> ${actionsOf(A, 'navigate').length}`);
    check((await snap(A.page)).selected === sel0, `被接管后不应改 selected：${sel0} -> ${(await snap(A.page)).selected}`);
    check((await pickRec(A)).n === rec.n, `被接管后 on_pick 不应再被调：${rec.n} -> ${(await pickRec(A)).n}`);
    check(!selfActor(await serverScene(A)).nav, '被接管后 A 不应在走');
    // 假接管换成「一律不接管」：同样的一下 E 又走旧逻辑（正面对照，证明上面的「没有」不是按键根本没生效）。
    // 不直接撤成空串：A 就站在 B 身边，空串下居民卡这个真功能会接管这一下（那是 60 号文件测的事）
    await setStub(A, '-');
    await frames(A.page, 3);
    await pressE(A);
    const rec2 = await until(async () => {
      const r = await pickRec(A);
      return r && r.n > rec.n ? r : null;
    }, 20_000, '撤掉假接管后 on_pick 记录出现');
    check(rec2.id === B.id && rec2.taken === false, `撤掉后应是没接管：${JSON.stringify(rec2)}`);
    await until(() => actionsOf(A, 'navigate').length > nav0, 20_000, '撤掉假接管后旧行为恢复（发出 navigate）');
    await idle(A);
    } finally {
      // 任何一条 check 抛出时也要撤掉假接管，免得它留在 A 页面上把后面步骤里对 B 的 E 键 / 点选都变成「被接管」。
      // 反向验证口：E2E_KEEP_PICK_STUB=1 时故意不撤，25.5 应当红（见文件末尾）
      if (process.env.E2E_KEEP_PICK_STUB !== '1') await clearStub(A);
    }
  });

  await step(25.5, '假接管已撤干净：Godot 一侧不再有假接管状态（25.4 无论成败都不把它留给后面的步骤）；真功能恢复生效', async () => {
    // 屏障：发一个无副作用的动作并等它有回应、再过几帧，保证 25.4 的 finally 发出的「撤掉」已经被 Godot 处理
    const up0 = actionsOf(A, 'update_profile').length;
    await A.page.evaluate(() => window.__town.act({ type: 'update_profile', muteTownChat: false }));
    await until(() => actionsOf(A, 'update_profile').length > up0, 20_000, '屏障动作有回应');
    await frames(A.page, 5);
    const stub = (await godotFeature(A.page, '_stub')) ?? '';
    check(stub === '', `25.4 之后不应还有假接管状态：「${stub}」`);
    // 撤干净之后按 E：有没有被接管由真功能决定（A 在 B 身边：有居民卡功能就被它接管并出卡，没有就走旧逻辑）；这里只核对记录和真功能一致
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    const hasPeople = (await godotFeature(A.page, 'people')) !== null;
    const n0 = (await pickRec(A))?.n ?? 0;
    await pressE(A);
    const rec = await until(async () => {
      const r = await pickRec(A);
      return r && r.n > n0 ? r : null;
    }, 20_000, 'on_pick 记录出现');
    check(rec.kind === 'actor' && rec.id === B.id && rec.taken === hasPeople, `撤干净后对身边的 B 按 E：接管与否应由真功能决定（居民卡功能${hasPeople ? '在' : '不在'}）：${JSON.stringify(rec)}`);
    if (hasPeople) await A.page.keyboard.press('Escape');
    await idle(A);
  });

  await h.release(A);
  await h.release(B);
}

/* ───────────────────────── 怎么让它失败（反向验证）─────────────────────────
 * 实测过（临时改坏、跑 --only=1,skeleton，看红在哪，改回后绿）：
 *  - dock.css 删掉 `#dock .dock-tab.sel:hover:not(:disabled)` 那条：步骤 25 红，「悬停时选中页签的背景应仍是纸色 …，实际 rgb(91, 61, 39)」。
 *  - dock.js 把 `if (DEBUG) {` 换成 `if (true) {`（测试口对所有页面开放）：步骤 25.1 红，「不带 ?debug=1 时不应有测试口：{test:object, dock:object, …}」。
 *  - dock.js 的 revealTab 开头加 return（空函数）：步骤 25 红，等待超时「选中最后一个页签后自动滚进可见（右沿在关闭钮之左）」。
 *  - hub.gd 的 on_pick 记录里把来源固定写成 "tap"：步骤 25.2、25.3、25.4 都红（「记录应是 (…, key, …)」，实际 src 是 tap）。
 * 只是推演、没验证过（改坏时应红的位置是按代码读出来的，没有真的改坏跑过）：
 *  - main.gd 的 _do_interact 里 on_pick 返回 true 后不 return：本次和上一条一起改坏，25.4 在更前面的「来源应是 key」就红了，
 *    「被接管后不应发出 navigate」这条没有单独被触发过。
 *  - main.gd 里去掉 `features.on_pick(best_kind, best_id, src)` 那三行：25.2 的记录出不来（超时）。
 *  - 25.4 去掉 try/finally 并在假接管装上后立刻 throw（模拟中途 check 失败）：25.5 红，「25.4 之后不应还有假接管状态」。
 *    （S0 当时实测过旧写法：25.4 红「inject」、25.5 红「… taken:true」。C4 并入后 25.5 改成直接读 Godot 的假接管状态 `_stub`，
 *    因为居民卡这个真功能会接管身边的人，「taken 为假」不再成立；新写法的这条反向验证见下面「C4 并入后」。）
 *  - dock.css 里 #dockTabs 去掉 overflow-x:auto / padding-right 改 0 / 内边距改回 14：六个页签的「最后一个页签中心点命中自己」「右沿在关闭钮之内」会红。
 *  - dock.css 去掉抽屉里 `.dock-tab::before { top: -14px }` 或条高改回 40：抽屉里「页签条高应 >= 44」「顶端点不到」会红。
 *  - dock.css 去掉 `#dock #dockTabs[data-count="1"] .dock-tab`：真页签只有一个时「仍是不可点的标题」会红。
 *  - dock.js 的 unregister 不重建页签条：「假页签卸干净」超时。
 *  - 把 on_pick 放到 `_can_control()` 之前或 `if best_kind == "":` 之前：结果不变，靠代码评审，不靠这个文件。
 * C4 并入后（居民卡会接管 3 米内的人）：25.2、25.3 和 25.4 的正面对照改在「一律不接管」（pickStub('-')）下核对旧行为；
 * 25.5 直接读 `__town.features._stub`，并核对撤干净后按 E 的接管与否和真功能一致（有居民卡功能就是被接管）。
 * __REVERSE_C4__
 */
