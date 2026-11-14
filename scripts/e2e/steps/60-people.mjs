// C4：居民卡、当面邀请、会馆门牌与入户。A 桌面 1440x900，B 手机 390x844 触摸。
// 步骤号都是数字（60.15 就是「60.1 之后的一步」），文件内的子步骤按顺序互相依赖，只能整个文件一起跑。
// 末尾有一段「怎么让它失败」，每条新断言都按那里写的做过反向验证。
import { poll, frames, hitTest, rectOf, godotFeature } from '../lib/ui.mjs';
import { apiAct } from '../lib/chat.mjs';
import { peopleCard, doorRows, inviteRows, houseInfo, godotPeople, bank, serverMe, screenOf, clickActor, actionButtons, toastTexts, badge, peopleDot, openPeopleTab, closePanel, clickDoor, hit, inside } from '../lib/people.mjs';

export const meta = { id: 'people', n: 60, title: '居民卡、当面邀请、门牌与入户' };

const PANE = '#dock [data-pane="people"]';
const CARD = '#peopleCard';
const MSG_NO_ACCESS = '需要主人当前有效的邀请';

export default async function run(h) {
  const { check, note, until, sleep, step, shot, allowFailure, selfActor, dist, serverScene, snap, rnd, BASE } = h;
  const { A, B } = await h.pair();
  const actionsOf = (p, type) => p.w.actions.filter((r) => r.type === type);
  const nameOf = async (viewer, id) => (await snap(viewer.page)).actors.find((x) => x.id === id)?.name ?? '';
  const sceneOf = async (p) => selfActor(await serverScene(p));
  const navIdle = async (p) => !(await sceneOf(p)).nav;
  const waitIdle = (p, ms = 60_000) => until(() => navIdle(p), ms, `${p.label} 走完`, 600);
  const gapAB = async () => {
    const sc = await serverScene(A);
    const a = selfActor(sc);
    const b = sc.actors.find((x) => x.id === B.id);
    return b ? dist(a, b) : Infinity;
  };
  const cardIs = (p, id) => until(async () => { const c = await peopleCard(p.page); return c?.cardOpen && c.cardId === id ? c : null; }, 30_000, `${p.label} 的居民卡出现（${id}）`);
  const cardClosed = (p) => until(async () => !(await peopleCard(p.page))?.cardOpen, 10_000, `${p.label} 的居民卡关闭`);
  const ackAfter = (p, verb, n0) => until(async () => { const a = (await godotPeople(p))?.lastAck; return a && a.verb === verb && a.n > n0 ? a : null; }, 30_000, `${p.label} 的 ${verb} 得到回应`);
  const lastN = async (p) => (await godotPeople(p))?.lastAck?.n ?? 0;
  const where = async (p) => { const s = await snap(p.page); return { scene: s.scene, space: s.space, spaceName: s.spaceName }; };
  const toastHas = (p, frag) => until(async () => (await toastTexts(p.page)).find((t) => t.includes(frag)) ?? null, 20_000, `${p.label} 出现提示「${frag}」`, 200);
  /** 去灯巷会馆：点「地点」再点「灯巷会馆」，等到了（页面自己续租的长路） */
  const goResidential = async (p) => {
    await p.page.click('#destBtn');
    await p.page.click('[data-dest="residential"]');
    await until(async () => (await where(p)).space === 'residential', 120_000, `${p.label} 到了灯巷会馆`, 700);
    await waitIdle(p);
  };
  /** A 的画面里，世界坐标 (x, z) 处 1 米高的那一点（clickActor 点的就是这个高度）点不点得到：在视口里（留边），而且最上面是画布 */
  const clickableFromA = (x, z) =>
    A.page.evaluate(([wx, wz]) => {
      const q = window.__town.project(wx, 1.0, wz);
      const m = 48;
      if (!(q.x >= m && q.x <= window.innerWidth - m && q.y >= m && q.y <= window.innerHeight - m)) return false;
      return (document.elementFromPoint(q.x, q.y)?.id ?? '') === 'canvas';
    }, [x, z]);
  /**
   * 离 A 一定距离处，找一个能走到的点让 B 走过去并停稳（API 代发，短路）。
   * clickable：之后要在 A 的画面上点 B，落点必须在 A 的画面里、没被界面盖住。
   * 沿「A 到 B 现在的方向」拉开是第一选择，但这个方向由前面的步骤留下的站位决定（比如 A 刚从正左边走到 B 身边），
   * 拉到 9 米可能正好出了 1440 像素宽的画面：所以先按投影筛一遍落点，B 停稳后再按页面上的真实位置核一遍。
   */
  const moveBAway = async (min, max, { clickable = false } = {}) => {
    const offs = [[5, 0], [-5, 0], [0, 5], [0, -5], [6, 4], [-6, -4], [4, -6], [-4, 6], [7, 0], [-7, 0], [0, 7], [0, -7]];
    const sc0 = await sceneOf(A);
    // 先沿 A 到 B 现在的方向直接拉到目标距离：B 少绕路，A 开着的卡也不会因为 B 路上绕到 8 米外而自动关掉
    const scb = (await serverScene(A)).actors.find((x) => x.id === B.id);
    if (scb) {
      const vx = scb.x - sc0.x;
      const vz = scb.z - sc0.z;
      const vl = Math.hypot(vx, vz);
      if (vl > 0.5) {
        // 要点得到的时候，同一方向上再备一个近一点的落点（刚过下限 1 米）
        if (clickable) offs.unshift([(vx / vl) * (min + 1), (vz / vl) * (min + 1)]);
        offs.unshift([(vx / vl) * ((min + max) / 2), (vz / vl) * ((min + max) / 2)]);
      }
    }
    const skipped = [];
    for (const [dx, dz] of offs) {
      const tx = sc0.x + dx;
      const tz = sc0.z + dz;
      if (clickable && !(await clickableFromA(tx, tz))) {
        skipped.push(`(${dx.toFixed(1)},${dz.toFixed(1)}) 落点不在 A 的画面里`);
        continue;
      }
      const r = await apiAct(B, { type: 'navigate', to: { x: tx, z: tz } });
      if (r.status !== 200) continue;
      await waitIdle(B);
      const g = await gapAB();
      if (g < min || g > max) continue;
      if (clickable) {
        // 页面上的 B 是按服务器时间插值的：等它也停到位，再看那一点是不是真的点得到（落点可能被吸附到别处）
        const ok = await until(
          async () => {
            const s = await screenOf(A.page, B.id);
            if (!s) return false;
            const m = 24;
            const vp = await A.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
            if (!(s.x >= m && s.x <= vp.w - m && s.y >= m && s.y <= vp.h - m)) return false;
            return (await A.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id ?? '', [s.x, s.y])) === 'canvas';
          },
          3000,
          'B 停稳后在 A 的画面里点得到',
          200,
        ).then(() => true, () => false);
        if (!ok) {
          skipped.push(`(${dx.toFixed(1)},${dz.toFixed(1)}) 停稳后点不到`);
          continue;
        }
      }
      return g;
    }
    throw new Error(`B 找不到离 A ${min}~${max} 米${clickable ? '、又在 A 画面里点得到' : ''}的落点${skipped.length ? `（跳过：${skipped.join('；')}）` : ''}`);
  };
  const apiCount = (p, type) => actionsOf(p, type).length;
  /** 最后一条该类型请求的记录；等它的回应体读完（client-e2e 的监视是异步读 json 的，reason 在那之后才有） */
  const lastRec = (p, type) => until(() => { const r = actionsOf(p, type).at(-1); return r && 'reason' in r ? r : null; }, 10_000, `${p.label} 的 ${type} 请求记录读完`, 100);
  let aName = '';
  let bName = '';
  let interestsB = [];

  // ───────────────────────── 60 初始 ─────────────────────────
  await step(60, '初始：两边都有「人家」页签（在「附近」之后）；居民卡存在但隐藏；__dock.people 与 Godot 一侧 people 存在；#actions 里的 f:people 按钮只会是「认识一下」，副标题是对方的名字', async () => {
    aName = await nameOf(A, A.id);
    bName = await nameOf(A, B.id);
    for (const p of [A, B]) {
      const d = await p.page.evaluate(() => window.__dock?._dock ?? null);
      check(d && d.mods.includes('people'), `${p.label} 应有 people 模块：${JSON.stringify(d?.mods)}`);
      check(d.mods.indexOf('nearby') >= 0 && d.mods.indexOf('nearby') < d.mods.indexOf('people'), `${p.label} 的页签顺序应是 附近 在 人家 之前：${JSON.stringify(d.mods)}`);
      check(await p.page.evaluate(() => !!document.querySelector('#dockTabs [data-tab="people"]')), `${p.label} 应有「人家」页签`);
      check((await p.page.evaluate((sel) => document.querySelector(sel)?.hidden, CARD)) === true, `${p.label} 的 #peopleCard 应存在且隐藏`);
      check(await peopleCard(p.page), `${p.label} 应有 __dock.people`);
      check(await godotPeople(p), `${p.label} 应有 __town.features.people`);
    }
    await until(async () => (await actionButtons(A.page)).some((b) => b.id.startsWith('f:people:meet:')), 20_000, 'A 的 #actions 出现「认识一下」');
    const ps = (await actionButtons(A.page)).filter((b) => b.id.startsWith('f:people:'));
    check(ps.length === 1 && ps[0].id === `f:people:meet:${B.id}` && ps[0].sub === bName && ps[0].label === '认识一下', `A 的 f:people 按钮应只有「认识一下（${bName}）」：${JSON.stringify(ps)}`);
    // 给 B 定三个爱好（顺序固定），否则爱好为空时「顺序」与「有无」都测不出来
    check((await apiAct(B, { type: 'update_profile', interests: ['books', 'tea', 'plants'] })).status === 200, '给 B 设三个爱好');
    interestsB = (await serverMe(B)).me.interests.map((x) => x.name ?? x);
    note(`A=${aName} B=${bName}，B 的爱好（服务器）：${interestsB.join('、') || '（空）'}`);
  });

  // ───────────────────────── 60.1 近处点人 ─────────────────────────
  await step(60.1, '近处点人：A 点 B（3 米内）立即出卡，不走路；名字、「真人」徽章对；卡里没有 B 的爱好；卡片不盖住 controls 与双方；「认识一下」按钮可再开卡', async () => {
    check((await gapAB()) < 3, `A、B 出生点应相距不到 3 米：${await gapAB()}`);
    const nav0 = apiCount(A, 'navigate');
    await clickActor(A, B.id);
    const c = await cardIs(A, B.id);
    check(c.name === bName, `卡上名字应是 ${bName}：${c.name}`);
    check(c.kindText === '真人' && c.kind === 'human', `徽章应是「真人」类名 human：${c.kindText}/${c.kind}`);
    // 屏障：卡可见之后再过几帧、等 /me 刷新过，再数导航
    await frames(A.page, 3);
    await sleep(1500);
    check(apiCount(A, 'navigate') === nav0, `近处点人不应发 navigate：${nav0} -> ${apiCount(A, 'navigate')}`);
    check(!(await sceneOf(A)).nav, '服务器里 A 不应在走');
    const c2 = await peopleCard(A.page);
    check(c2.cardOpen, '等了几帧之后卡仍开着');
    for (const nm of interestsB) check(!c2.text.includes(nm), `卡里不应有 B 的爱好「${nm}」（没问之前不知道）：${c2.text}`);
    check(c2.hobby === '', `没问之前不该有爱好行：${c2.hobby}`);
    const ctlRects = await A.page.evaluate(() => [...document.querySelectorAll('#controls button')].map((b) => b.getBoundingClientRect().toJSON()).filter((r) => r.width > 0));
    for (const r of ctlRects) check(!hit(c2.rect, r), `居民卡不应盖住 controls 的按钮：${JSON.stringify({ card: c2.rect, r })}`);
    const sa = await screenOf(A.page, A.id);
    const sb = await screenOf(A.page, B.id);
    check(!inside(c2.rect, sa) && !inside(c2.rect, sb), `居民卡不应盖住自己 ${JSON.stringify(sa)} 或对方 ${JSON.stringify(sb)}：${JSON.stringify(c2.rect)}`);
    await shot(A.page, '60-desktop-card');
    // Esc 关卡后，「认识一下」按钮点一下重新出卡
    await A.page.keyboard.press('Escape');
    await cardClosed(A);
    const btn = `#actions [data-action="f:people:meet:${B.id}"]`;
    await until(() => A.page.isVisible(btn), 15_000, '关卡后「认识一下」按钮出现');
    check((await actionButtons(A.page)).find((b) => b.id === `f:people:meet:${B.id}`)?.sub === bName, '按钮副标题应是对方的名字');
    await A.page.click(btn);
    await cardIs(A, B.id);
    note(`卡片矩形 ${JSON.stringify(c2.rect)}`);
  });

  // ───────────────────────── 60.15 Esc 与 ✕ ─────────────────────────
  await step(60.15, 'Esc 与 ✕：Esc 关卡；再开，点 ✕ 关；关卡后 Godot 一侧 card 为 null', async () => {
    await A.page.keyboard.press('Escape');
    await cardClosed(A);
    check((await godotPeople(A)).card === null, 'Esc 之后 Godot 的 card 应为 null');
    await until(async () => (await peopleCard(A.page)) && (await A.page.isVisible(`#actions [data-action="f:people:meet:${B.id}"]`)), 15_000, '按钮回来');
    await clickActor(A, B.id);
    await cardIs(A, B.id);
    await A.page.click(`${CARD} [data-role="close"]`);
    await cardClosed(A);
    await until(async () => (await godotPeople(A)).card === null, 10_000, '点 ✕ 之后 Godot 的 card 为 null');
  });

  // ───────────────────────── 60.16 E 键和点击走同一个入口（S0 之后）─────────────────────────
  await step(60.16, 'E 键和点击一样：站在 B 身边按 E 立即出卡，on_pick 记录是 (actor, B, key, 接管)，不走路；卡开着再按一下 E 还是这一张卡、不走路', async () => {
    await cardClosed(A);
    check((await gapAB()) < 3, `A、B 应相距不到 3 米：${await gapAB()}`);
    await until(async () => (await snap(A.page)).nearValid === true, 15_000, 'A 的「够得着」状态有效');
    const sc = await snap(A.page);
    const me = sc.actors.find((a) => a.id === sc.self);
    const b = sc.actors.find((a) => a.id === B.id);
    // E 键选的是 8 米内最近的物件或居民：B 必须是最近的那个，这一步才是在测「对人按 E」
    const others = [...sc.objects.map((o) => dist(me, o)), ...sc.actors.filter((a) => a.id !== sc.self && a.id !== B.id).map((a) => dist(me, a))];
    const nearestOther = others.length ? Math.min(...others) : Infinity;
    check(b && dist(me, b) < nearestOther, `B 应是 A 最近的可互动目标：B ${b ? dist(me, b).toFixed(1) : '不见了'}，别的最近 ${nearestOther.toFixed(1)}`);
    const pickN = async () => (await godotFeature(A.page, '_pick'))?.n ?? 0;
    const n0 = await pickN();
    const nav0 = apiCount(A, 'navigate');
    await A.page.keyboard.press('KeyE');
    const rec = await until(async () => { const r = await godotFeature(A.page, '_pick'); return r && r.n > n0 ? r : null; }, 20_000, '按 E 之后 on_pick 记录出现');
    check(rec.kind === 'actor' && rec.id === B.id && rec.src === 'key' && rec.taken === true, `记录应是 (actor, ${B.id}, key, 接管)：${JSON.stringify(rec)}`);
    await cardIs(A, B.id);
    // 卡开着再按一下 E：同一个人、同一张卡，仍算接管（不落回旧逻辑去走路）
    await A.page.keyboard.press('KeyE');
    const rec2 = await until(async () => { const r = await godotFeature(A.page, '_pick'); return r && r.n > rec.n ? r : null; }, 20_000, '第二下 E 的 on_pick 记录出现');
    check(rec2.id === B.id && rec2.src === 'key' && rec2.taken === true, `第二下 E 也应被居民卡接管：${JSON.stringify(rec2)}`);
    // 屏障：旧逻辑若错误地继续，会在 on_pick 的同一帧里发 navigate；记录已经出现，再过几帧才断言「没有」
    await frames(A.page, 5);
    check(apiCount(A, 'navigate') === nav0, `对身边的人按 E 不应发 navigate：${nav0} -> ${apiCount(A, 'navigate')}`);
    check(!(await sceneOf(A)).nav, '服务器里 A 不应在走');
    const c = await peopleCard(A.page);
    check(c.cardOpen && c.cardId === B.id, `卡应仍开着、还是 B：${JSON.stringify({ open: c.cardOpen, id: c.cardId })}`);
    await A.page.keyboard.press('Escape');
    await cardClosed(A);
  });

  // ───────────────────────── 60.17 别处发起的走近不弹卡 ─────────────────────────
  await step(60.17, '别处发起的走近不弹卡：A 没在这里点过 B，由接口代发 approach 走到 B 身边 -> 页面收到 you_arrived 之后没有卡、没有待开卡、没有「走开了」提示（另一台设备握着控制权、接口代发时就是这种情况）', async () => {
    if ((await peopleCard(A.page)).cardOpen) {
      await A.page.keyboard.press('Escape');
      await cardClosed(A);
    }
    const g = await moveBAway(6, 12);
    const gp0 = await godotPeople(A);
    check(gp0.far === '' && gp0.want === '', `起点：A 没有点过谁、也没有待开的卡：${JSON.stringify({ far: gp0.far, want: gp0.want })}`);
    const pick0 = (await A.page.evaluate(() => window.__town.features._pick))?.n ?? 0;
    check((await apiAct(A, { type: 'navigate', approach: B.id })).status === 200, 'A 走向 B（接口代发）应被接受');
    await waitIdle(A);
    // 屏障：这次到达的 you_arrived 已经进了 people 模块（计数加一），之后才谈得上「没有开卡」
    await until(async () => (await godotPeople(A)).arrivals > gp0.arrivals, 15_000, 'A 的页面收到这次到达（you_arrived）', 150);
    const g1 = await gapAB();
    check(g1 < 3, `A 应已走到 B 的 3 米内（够得着，旧写法这时会开卡）：${g1.toFixed(2)}`);
    // 待开卡每 0.25 秒看一次距离：守 1.5 秒（六次检查的时间），其间一直没有卡
    const t1 = Date.now();
    let looks = 0;
    while (Date.now() - t1 < 1500) {
      const c = await peopleCard(A.page);
      check(!c.cardOpen, `接口代发的走近不应弹出居民卡：${JSON.stringify({ cardId: c.cardId })}`);
      looks += 1;
      await sleep(120);
    }
    const gp1 = await godotPeople(A);
    check(gp1.want === '' && gp1.far === '' && gp1.card === null, `Godot 一侧没有待开卡、没有记号、没有卡：${JSON.stringify({ want: gp1.want, far: gp1.far, card: gp1.card })}`);
    check(((await A.page.evaluate(() => window.__town.features._pick))?.n ?? 0) === pick0, '全程没有发生点选（卡不是因为点了谁才没开）');
    check(!(await toastTexts(A.page)).some((t) => t.includes('走开了')), '也不应提示「走开了，再点一下」');
    note(`B 先走到 ${g.toFixed(1)} 米外；A 由接口走近到 ${g1.toFixed(2)} 米；之后 1.5 秒里看了 ${looks} 次都没有卡`);
  });

  // ───────────────────────── 60.2 远处点人先走过去 ─────────────────────────
  await step(60.2, '远处点人先走过去：B 走到 6 米外；A 点 B -> 走路时没有卡、发 navigate、停下后离 B 小于 1.5 米，卡自动出现；全程没有 ask_hobby / invite', async () => {
    const g = await moveBAway(6, 12, { clickable: true });
    note(`B 走到离 A ${g.toFixed(1)} 米`);
    const nav0 = apiCount(A, 'navigate');
    const ask0 = apiCount(A, 'ask_hobby');
    const inv0 = apiCount(A, 'invite');
    await clickActor(A, B.id);
    await until(async () => !!(await sceneOf(A)).nav, 15_000, 'A 开始走（服务器 /scene 里有导航）', 250);
    check(!(await peopleCard(A.page)).cardOpen, '走路时不应有卡');
    await until(() => apiCount(A, 'navigate') >= nav0 + 1, 10_000, 'A 的 navigate 记录出现', 100);
    check(apiCount(A, 'navigate') === nav0 + 1, `A 应发出一次 navigate：${nav0} -> ${apiCount(A, 'navigate')}`);
    await waitIdle(A);
    check((await gapAB()) < 1.5, `A 停下后应离 B 小于 1.5 米：${await gapAB()}`);
    await cardIs(A, B.id);
    check(apiCount(A, 'ask_hobby') === ask0 && apiCount(A, 'invite') === inv0, '全程不应发 ask_hobby / invite');
  });

  // ───────────────────────── 60.3 问爱好 ─────────────────────────
  await step(60.3, '问爱好：成功后卡上「喜欢：…」与 B 的 /me 爱好一致；B 弹出 toast；B 关掉被问后 A 再问，提示等于服务器原文、爱好行不变', async () => {
    const n0 = await lastN(A);
    await A.page.click(`${CARD} [data-role="ask"]`);
    const ack = await ackAfter(A, 'ask', n0);
    check(ack.ok, `问爱好应成功：${JSON.stringify(ack)}`);
    const want = interestsB.length ? (await bank(A.page, 'hobby.has')).replace('{list}', interestsB.join(await bank(A.page, 'hobby.sep'))) : await bank(A.page, 'hobby.none');
    await until(async () => (await peopleCard(A.page)).hobby === want, 10_000, `卡上爱好行应是「${want}」`);
    check(JSON.stringify(ack.interests) === JSON.stringify(interestsB), `回应里的爱好应与 B 的 /me 一致：${JSON.stringify(ack.interests)} vs ${JSON.stringify(interestsB)}`);
    check((await godotPeople(A)).hobbies === 1, 'Godot 一侧应缓存了 1 个人的爱好');
    await toastHas(B, aName);
    check((await toastTexts(B.page)).some((t) => t.includes(aName) && t.includes('问了你的爱好')), 'B 的 toast 应含 A 的名字和「问了你的爱好」');
    // 关掉被问
    check((await apiAct(B, { type: 'update_profile', allowAskHobby: false })).status === 200, 'B 关掉「允许问爱好」');
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '60.3：对方关了允许问爱好，ask_hobby 必定 declined（422）' });
    await sleep(900); // 网页一侧 800 毫秒防连点
    const n1 = await lastN(A);
    await A.page.click(`${CARD} [data-role="ask"]`);
    const a2 = await ackAfter(A, 'ask', n1);
    check(!a2.ok && a2.code === 'declined', `应被拒绝（declined）：${JSON.stringify(a2)}`);
    const c = await peopleCard(A.page);
    check(c.hint === `${bName}现在不太想聊这个。`, `提示应等于服务器原文：${c.hint}`);
    check(c.hobby === want, `爱好行不变：${c.hobby}`);
    const rec = await lastRec(A, 'ask_hobby');
    check(rec.status === 422 && rec.reason === 'declined', `服务器应回 422 declined：${JSON.stringify(rec)}`);
    check((await apiAct(B, { type: 'update_profile', allowAskHobby: true })).status === 200, 'B 重新打开');
  });

  // ───────────────────────── 60.35 限流 ─────────────────────────
  await step(60.35, '限流：A 用 API 烧光问爱好额度；界面再点 -> 提示含「太频繁」，按钮禁用；额度恢复后可点（40 秒内没恢复只记 note）', async () => {
    // 额度每 30 秒补 1 个：烧光之后到界面点击之间若恰好补回一个，界面那一次会成功而不是 429。所以点完发现成功就再烧一轮重来（最多 3 轮），
    // 每一轮「烧光 -> 立刻点」之间只隔一次 API 往返，补回的概率本来就小，三轮都碰上等于不可能
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 3, why: '60.35：额度烧光后界面再问一次必定 429（恰好补到额度的那一轮界面会成功，再烧一轮，最多 3 轮）' });
    let ack = null;
    for (let round = 0; round < 3; round++) {
      let got = false;
      for (let i = 0; i < 5 && !got; i++) {
        const r = await apiAct(A, { type: 'ask_hobby', target: B.id });
        if (r.status === 429) got = true;
      }
      check(got, '5 次之内应出现 429');
      await sleep(900);
      const n0 = await lastN(A);
      await A.page.click(`${CARD} [data-role="ask"]`);
      ack = await ackAfter(A, 'ask', n0);
      if (!ack.ok) break;
      note(`第 ${round + 1} 轮：额度恰好补回一个，界面那一次成功了，再烧一轮`);
    }
    check(!ack.ok && ack.retryMs > 0, `应被限流：${JSON.stringify(ack)}`);
    const c = await peopleCard(A.page);
    check(c.hint.includes('太频繁'), `提示应含服务器原文「太频繁」：${c.hint}`);
    check(c.askDisabled, '限流期间「问爱好」应禁用');
    const rec = await lastRec(A, 'ask_hobby');
    check(rec.status === 429, `服务器应回 429：${JSON.stringify(rec)}`);
    try {
      await until(async () => !(await peopleCard(A.page)).askDisabled, 40_000, '额度恢复后按钮可点', 500);
      note('额度恢复后按钮重新可点');
    } catch {
      note('40 秒内按钮没有恢复（额度补得慢），只记录不判失败');
    }
  });

  // ───────────────────────── 60.4 会馆门牌 ─────────────────────────
  await step(60.4, '会馆门牌（无邀请）：B 去灯巷会馆，#actions 出现「门牌」；点开面板在「人家」；有「你家」（回家，可点）和 A 的牌子（data-can=0、进门按钮灰、写「需要主人的邀请」）；与 /me 的 here.doors 一一对应；没有「在线 / 在家」字样', async () => {
    await closePanel(A.page);
    await goResidential(B);
    await until(async () => (await actionButtons(B.page)).some((b) => b.id === 'f:people:doors'), 20_000, 'B 的 #actions 出现「门牌」');
    await B.page.click('#actions [data-action="f:people:doors"]');
    await until(async () => { const d = await B.page.evaluate(() => window.__dock._dock); return d.open && d.tab === 'people'; }, 10_000, '面板开着且在「人家」页签');
    await until(async () => (await doorRows(B.page)).length >= 2, 20_000, '门牌里至少有两块');
    const rows = await doorRows(B.page);
    const mine = rows.find((r) => r.home === `home:${B.id}`);
    const theirs = rows.find((r) => r.home === `home:${A.id}`);
    check(mine && mine.mine && mine.can && !mine.enterDisabled && mine.enterText === '回家', `「你家」应带可点的「回家」：${JSON.stringify(mine)}`);
    check(theirs && !theirs.can && theirs.enterDisabled && theirs.enterText === '需要主人的邀请', `A 的牌子应灰掉并写「需要主人的邀请」：${JSON.stringify(theirs)}`);
    const me = await serverMe(B);
    const doors = me.here.doors;
    check(doors.length === rows.length, `门牌数量应与 /me 一致：${doors.length} vs ${rows.length}`);
    for (const d of doors) check(rows.find((r) => r.home === d.home)?.can === d.canEnter, `canEnter 应一一对应：${d.home}`);
    const text = await B.page.evaluate((sel) => document.querySelector(sel).textContent, PANE);
    check(!/在线|在家|离线/.test(text), `门牌与卡片里不应出现在线 / 在家字样：${text.slice(0, 200)}`);
    // 面板已经开在「人家」页签：「门牌」按钮没有意义（还叠在脚下的地点文字上），不再出；关了面板它回来
    await until(async () => !(await actionButtons(B.page)).some((b) => b.id === 'f:people:doors'), 10_000, '面板开在「人家」页签时 #actions 没有「门牌」');
    await shot(B.page, '61-mobile-doors');
    await closePanel(B.page);
    await until(async () => (await actionButtons(B.page)).some((b) => b.id === 'f:people:doors'), 10_000, '关了面板「门牌」按钮回来');
  });

  // ───────────────────────── 60.45 无权入户（竞态） ─────────────────────────
  await step(60.45, '无权入户（竞态）：绕过 disabled 强发 -> B 的提示等于服务器 message，B 留在会馆', async () => {
    allowFailure(B.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '60.45：没有邀请时强行进别人家，navigate 必定 422 no_access' });
    const nav0 = apiCount(B, 'navigate');
    await B.page.evaluate((home) => window.TownDock.test.people.forceVisit(home), `home:${A.id}`);
    await toastHas(B, MSG_NO_ACCESS);
    const rec = await lastRec(B, 'navigate');
    check(apiCount(B, 'navigate') === nav0 + 1 && rec.status === 422 && rec.reason === 'no_access', `服务器应回 422 no_access：${JSON.stringify(rec)}`);
    await frames(B.page, 3);
    const w = await where(B);
    check(w.scene === 'town' && w.space === 'residential', `B 应仍在会馆：${JSON.stringify(w)}`);
    check(!(await sceneOf(B)).nav, '服务器里 B 没有导航');
  });

  // ───────────────────────── 60.5 当面邀请 ─────────────────────────
  await step(60.5, '当面邀请：A 去会馆点 B -> 卡；点「邀请到家里」-> 已邀请（灰、含「小时」）；/me 恰好 1 份；强发被 Godot 拦下；B 收到 toast、「去做客」、角标、请柬、A 的牌子变 data-can=1', async () => {
    await closePanel(B.page);
    await goResidential(A);
    await until(async () => (await gapAB()) < 8, 20_000, 'A、B 都在会馆门口');
    await clickActor(A, B.id);
    await cardIs(A, B.id);
    const inv0 = apiCount(A, 'invite');
    const n0 = await lastN(A);
    await A.page.click(`${CARD} [data-role="invite"]`);
    const ack = await ackAfter(A, 'invite', n0);
    check(ack.ok, `邀请应成功：${JSON.stringify(ack)}`);
    await until(async () => { const c = await peopleCard(A.page); return c.inviteDisabled && c.inviteText === '已邀请' && c.invleft.includes('小时'); }, 15_000, '邀请钮变成灰的「已邀请」，旁边写「…小时内有效」');
    const meA = await serverMe(A);
    const sentToB = meA.invites.sent.filter((s) => s.guest.id === B.id);
    check(sentToB.length === 1, `A 的 /me 应恰有 1 份给 B 的邀请：${meA.invites.sent.length}`);
    // 强发：绕过按钮，Godot 一侧自己拦下
    await A.page.evaluate((id) => window.TownDock.test.people.forceInvite(id), B.id);
    await until(async () => (await godotPeople(A)).lastAck?.code === 'invited', 10_000, 'Godot 一侧拦下重复邀请（屏障）');
    check(apiCount(A, 'invite') === inv0 + 1, `invite 请求应只有一次：${inv0} -> ${apiCount(A, 'invite')}`);
    check((await serverMe(A)).invites.sent.filter((s) => s.guest.id === B.id).length === 1, '服务器里仍只有 1 份');
    // B 一侧
    await toastHas(B, aName);
    await until(async () => (await actionButtons(B.page)).some((b) => b.id === `f:people:visit:home:${A.id}`), 20_000, 'B 的 #actions 出现「去做客」');
    const vb = (await actionButtons(B.page)).find((b) => b.id === `f:people:visit:home:${A.id}`);
    check(vb.label === '去做客' && vb.sub === `${aName}的家`, `「去做客」副标题应是「${aName}的家」：${JSON.stringify(vb)}`);
    await until(async () => (await badge(B.page)).people === 1, 15_000, 'B 的 people 未读为 1');
    const bg = await badge(B.page);
    check(!bg.hidden && bg.total === bg.sum && bg.total >= 1, `#dockBtn 角标应等于各模块未读之和：${JSON.stringify(bg)}`);
    check(await peopleDot(B.page), '「人家」页签应有小圆点');
    await until(async () => (await inviteRows(B.page)).length === 1, 15_000, '请柬栏有一条');
    const row = (await inviteRows(B.page))[0];
    check(row.fresh && row.skip, `请柬应是新的、带「先不去」：${JSON.stringify(row)}`);
    await until(async () => (await doorRows(B.page)).find((r) => r.home === `home:${A.id}`)?.can === true, 20_000, 'A 的牌子 data-can 变 1（invite 事件后刷新了 /me）');
    const meB = await serverMe(B);
    const rec = meB.invites.received.find((r) => r.host.id === A.id);
    check(rec, 'B 的 /me invites.received 应有这一份');
    const left = rec.expiresAt - Date.now();
    check(Math.abs(left - 24 * 3600_000) < 5 * 60_000, `邀请有效期应约 24 小时：${(left / 3600_000).toFixed(2)} 小时`);
    await shot(B.page, '62-mobile-invite');
    // 先不去
    await openPeopleTab(B.page);
    await until(async () => (await badge(B.page)).people === 0, 10_000, '面板上的「人家」页签被看到后角标清零');
    await B.page.click(`${PANE} li.people-invite [data-role="skip"]`);
    await until(async () => { const r = (await inviteRows(B.page))[0]; return r && !r.fresh && !r.skip; }, 10_000, '请柬的 fresh 标和「先不去」消失');
    check(!(await actionButtons(B.page)).some((b) => b.id.startsWith('f:people:visit:')), '「先不去」之后 #actions 不应再有「去做客」');
    check((await inviteRows(B.page)).length === 1 && (await doorRows(B.page)).find((r) => r.home === `home:${A.id}`)?.can === true, '请柬行与门牌仍在');
    check((await serverMe(B)).invites.received.some((r) => r.host.id === A.id), '服务器里邀请仍然有效');
    await closePanel(B.page);
  });

  // ───────────────────────── 60.55 too_far ─────────────────────────
  await step(60.55, 'too_far 路径：B 走到约 5 米外，A 强发问爱好 -> 服务器 422 too_far；A 自己走近，停下后卡上提示「到了，再点一次。」；没有第二个 ask_hobby', async () => {
    check((await peopleCard(A.page)).cardOpen, 'A 的卡应还开着');
    const g = await moveBAway(3.6, 7.5);
    note(`B 离 A ${g.toFixed(1)} 米`);
    await until(async () => (await peopleCard(A.page)).cardOpen, 5000, '5 米多时卡不自动关');
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '60.55：离得太远时 ask_hobby 必定 too_far' });
    const ask0 = apiCount(A, 'ask_hobby');
    const nav0 = apiCount(A, 'navigate');
    await A.page.evaluate((id) => window.TownDock.test.people.forceAsk(id), B.id);
    await until(() => apiCount(A, 'ask_hobby') === ask0 + 1, 15_000, '这次 ask_hobby 发出了');
    const rec = await lastRec(A, 'ask_hobby');
    check(rec.status === 422 && rec.reason === 'too_far', `应是 422 too_far：${JSON.stringify(rec)}`);
    await until(async () => !!(await sceneOf(A)).nav, 15_000, 'A 自己走近（服务器里有导航，屏障）', 250);
    await until(() => apiCount(A, 'navigate') >= nav0 + 1, 10_000, 'A 的 navigate 记录出现', 100);
    check(apiCount(A, 'navigate') === nav0 + 1, `应多一次 navigate：${nav0} -> ${apiCount(A, 'navigate')}`);
    await waitIdle(A);
    const arrived = await bank(A.page, 'note.arrived');
    await until(async () => (await peopleCard(A.page)).hint === arrived, 15_000, `卡上提示变成「${arrived}」`);
    await frames(A.page, 3);
    check(apiCount(A, 'ask_hobby') === ask0 + 1, `不应自动重发 ask_hobby：${apiCount(A, 'ask_hobby') - ask0}`);
  });

  // ───────────────────────── 60.57 / 60.58 too_far 之后的走路 ─────────────────────────
  /** 站到 B 身边并让 A 的卡开着（上一步失败时也能从这里重新起步） */
  const nearWithCard = async () => {
    if ((await gapAB()) > 3.2 || !(await peopleCard(A.page)).cardOpen) {
      if ((await peopleCard(A.page)).cardOpen) { await A.page.click(`${CARD} [data-role="close"]`); await cardClosed(A); }
      if ((await gapAB()) > 3.2) {
        // 走到 B 身边（API 代发，短路；对方在屏幕外时点不到）
        check((await apiAct(A, { type: 'navigate', approach: B.id })).status === 200, 'A 走向 B 应被接受');
        await waitIdle(A);
      }
      await clickActor(A, B.id);
      await cardIs(A, B.id);
    }
  };
  await step(60.57, 'too_far 之后：走向 ta 的路上点了别处 -> 「正在走向」不再卡住，对方走远后卡自动关', async () => {
    const { clickWorld, walkTo } = h;
    await nearWithCard();
    const g0 = await moveBAway(6.5, 7.5); // 越远，走到跟前（reach + 0.5 米）要的时间越长，改道的点击才赶得上「正在走向」
    note(`B 离 A ${g0.toFixed(1)} 米`);
    await until(async () => (await peopleCard(A.page)).cardOpen, 5000, '8 米内卡不自动关');
    // 先量好背离 B 的方向（点击要在 A 走到跟前之前发出去）
    const sa = await sceneOf(A);
    const sb = (await serverScene(A)).actors.find((x) => x.id === B.id);
    const len = Math.hypot(sa.x - sb.x, sa.z - sb.z) || 1;
    const ux = (sa.x - sb.x) / len;
    const uz = (sa.z - sb.z) / len;
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '60.57：改道一段，离得远时 ask_hobby 必定 too_far' });
    const ask0 = apiCount(A, 'ask_hobby');
    await A.page.evaluate((id) => window.TownDock.test.people.forceAsk(id), B.id);
    await until(() => apiCount(A, 'ask_hobby') === ask0 + 1, 15_000, '这次 ask_hobby 发出了');
    const rec = await lastRec(A, 'ask_hobby');
    check(rec.status === 422 && rec.reason === 'too_far', `应是 422 too_far：${JSON.stringify(rec)}`);
    await until(async () => (await godotPeople(A)).walk === true, 10_000, 'Godot 一侧记下「正在走向 ta」', 50);
    // 走到一半点了别处：往背离 B 的方向走，直到离 B 超过 8 米（卡的自动关闭距离）。第一下点击紧跟着发
    check((await godotPeople(A)).walk === true, '点击之前 A 还在「正在走向」（否则这一步测不到卡住的状态）');
    let far = false;
    for (const k of [2, 3, 4.5]) {
      await clickWorld(A, sa.x + ux * k, sa.z + uz * k);
      await walkTo(A, sa.x + ux * k, sa.z + uz * k, 1.2);
      if ((await gapAB()) > 8.4) { far = true; break; }
    }
    check(far, `A 应走到离 B 8 米以外：${(await gapAB()).toFixed(1)}`);
    await until(async () => (await godotPeople(A)).walk === false, 15_000, '改道后「正在走向 ta」解除（不再卡住）', 250);
    await cardClosed(A); // 解除后恢复距离自动关卡：对方已在 8 米外
    check((await godotPeople(A)).cardId === '', '卡关了，Godot 一侧 cardId 为空');
  });

  await step(60.58, 'too_far 的回应晚到而卡已关 -> 只算过期的回应，不会把玩家拽向 ta', async () => {
    await nearWithCard();
    await moveBAway(3.6, 7.5);
    await until(async () => (await peopleCard(A.page)).cardOpen, 5000, '8 米内卡不自动关');
    allowFailure(A.w, 'POST', /\/town\/api\/actions$/, { min: 1, max: 1, why: '60.58：回应晚到一段，离得远时 ask_hobby 必定 too_far' });
    const actionsUrl = /\/town\/api\/actions(\?|$)/;
    let hits = 0;
    await A.page.route(actionsUrl, async (route) => {
      const req = route.request();
      const body = req.method() === 'POST' ? (req.postDataBuffer()?.toString('utf8') ?? req.postData() ?? '') : '';
      if (req.method() === 'POST' && (body === '' || body.includes('ask_hobby'))) { hits++; await sleep(1500); } // 让 too_far 的回应晚到（读不到请求体时一律延迟，这一小段里只有这一个请求）
      await route.continue();
    });
    try {
      const ask1 = apiCount(A, 'ask_hobby');
      const nav2 = apiCount(A, 'navigate');
      const n0 = await lastN(A);
      await A.page.evaluate((id) => window.TownDock.test.people.forceAsk(id), B.id);
      await until(() => hits >= 1, 15_000, '这次 ask_hobby 被拦截延迟了（回应还在路上；请求记录要等回应回来才有，不能拿它当信号）', 20);
      await A.page.click(`${CARD} [data-role="close"]`); // 回应回来之前，卡已经关了
      await cardClosed(A);
      const ack = await ackAfter(A, 'ask', n0);
      await until(() => apiCount(A, 'ask_hobby') === ask1 + 1, 15_000, '这次 ask_hobby 的记录出现');
      check(!ack.ok && ack.code === 'too_far' && ack.stale === true && !ack.walking, `晚到的 too_far 只算过期的回应，不走路：${JSON.stringify(ack)}`);
      await frames(A.page, 3);
      await sleep(800);
      check(apiCount(A, 'navigate') === nav2, `回应晚到不应再发 navigate：${nav2} -> ${apiCount(A, 'navigate')}`);
      check(!(await sceneOf(A)).nav && (await godotPeople(A)).walk === false, '服务器里 A 没有在走，Godot 一侧也没有「正在走向」');
    } finally {
      await A.page.unroute(actionsUrl);
    }
    // 收尾：两人都回会馆（往远处走时可能出了会馆的范围，后面的门牌步骤要在会馆里），回到 B 身边，留一张开着的卡（和 60.55 结束时一样）
    for (const p of [A, B]) if ((await where(p)).space !== 'residential') await goResidential(p);
    await until(async () => (await gapAB()) < 8, 20_000, 'A、B 都在会馆门口');
    await nearWithCard();
  });

  // ───────────────────────── 60.6 受邀入户 ─────────────────────────
  await step(60.6, '受邀入户：B 在门牌里点 A 的「进门」-> 进 A 的家，「屋里」写 A 的名字、标签「做客」、陈设与 /me 一致；A 看不到 B；B 点「出门」回会馆', async () => {
    await openPeopleTab(B.page);
    const doorsBefore = JSON.stringify(await doorRows(A.page));
    await clickDoor(B.page, `home:${A.id}`);
    await until(async () => (await where(B)).scene === 'home', 90_000, 'B 进了私宅场景', 500);
    // 场所名以服务器为准（页面自己的 spaceName 来自地图表，私宅只写「家」）
    const loc = await until(async () => { const m = await serverMe(B); return m.here?.kind === 'home' ? m : null; }, 20_000, 'B 的 /me 里 here 是私宅');
    check(loc.here.name.includes(aName) && loc.location.name.includes(aName), `B 的场所名应含 A 的名字：${loc.here.name} / ${loc.location.name}`);
    await until(async () => (await houseInfo(B.page))?.open, 15_000, '「屋里」栏出现');
    const hi = await houseInfo(B.page);
    check(hi.title === `${aName}的家` && hi.tag === '做客' && !hi.mine, `屋里应写 A 的名字、标签做客：${JSON.stringify(hi)}`);
    const me = await serverMe(B);
    check(JSON.stringify(hi.decor) === JSON.stringify(me.here.home.decor), `陈设应与 /me 一致：${JSON.stringify(hi.decor)} vs ${JSON.stringify(me.here.home.decor)}`);
    // A 看不到 B（屏障：服务器 /scene 里 A 已经没有 B）
    await until(async () => !(await serverScene(A)).actors.some((x) => x.id === B.id), 20_000, '服务器里 A 的场景已没有 B');
    await until(async () => !(await snap(A.page)).actors.some((x) => x.id === B.id), 15_000, 'A 的画面里已没有 B');
    const ca = await peopleCard(A.page);
    check(!ca.cardOpen && !ca.houseOpen && JSON.stringify(await doorRows(A.page)) === doorsBefore, `A 一侧不应有 B 在 A 家的迹象：${JSON.stringify({ open: ca.cardOpen, house: ca.houseOpen })}`);
    await shot(B.page, '62-mobile-home');
    await B.page.click(`${PANE} [data-role="leave"]`);
    await until(async () => { const x = await where(B); return x.scene === 'town' && x.space === 'residential'; }, 60_000, 'B 回到灯巷会馆', 500);
    await until(async () => !(await houseInfo(B.page)).open, 15_000, '屋里栏收起');
  });

  // ───────────────────────── 60.65 自己家与屋里点人 ─────────────────────────
  await step(60.65, '自己家与屋里点人：A 点「你家」的回家 -> 标签「主人」、标题「你的家」；B 受邀再进，A 点 B 出卡；B 出门，A 出门', async () => {
    await openPeopleTab(A.page);
    await until(async () => (await doorRows(A.page)).some((r) => r.home === `home:${A.id}`), 20_000, `A 的门牌里有自己家（现在：${JSON.stringify(await where(A))} ${JSON.stringify(await doorRows(A.page))}）`);
    await clickDoor(A.page, `home:${A.id}`);
    await until(async () => (await where(A)).scene === 'home', 90_000, 'A 进了自己家', 500);
    await until(async () => (await houseInfo(A.page))?.open, 15_000, 'A 的「屋里」栏出现');
    const hi = await houseInfo(A.page);
    check(hi.mine && hi.title === '你的家' && hi.tag === '主人', `自己家：标签应是「主人」、标题「你的家」：${JSON.stringify(hi)}`);
    await closePanel(A.page);
    await clickDoor(B.page, `home:${A.id}`);
    await until(async () => (await where(B)).scene === 'home', 90_000, 'B 再次进了 A 的家', 500);
    await until(async () => (await snap(A.page)).actors.some((x) => x.id === B.id), 20_000, 'A 的画面里出现 B');
    await clickActor(A, B.id);
    await cardIs(A, B.id);
    await A.page.keyboard.press('Escape');
    await cardClosed(A);
    await B.page.click(`${PANE} [data-role="leave"]`);
    await until(async () => (await where(B)).scene === 'town', 60_000, 'B 出门', 500);
    await openPeopleTab(A.page);
    await A.page.click(`${PANE} [data-role="leave"]`);
    await until(async () => { const x = await where(A); return x.scene === 'town' && x.space === 'residential'; }, 60_000, 'A 出门回会馆', 500);
    await closePanel(A.page);
  });

  // ───────────────────────── 60.7 收回后的门牌 ─────────────────────────
  await step(60.7, '收回后的门牌与服务器兜底：A 用 API 收回邀请；B 收到 notice，A 的牌子变回 data-can=0，请柬栏里那一条消失', async () => {
    const meA = await serverMe(A);
    const g = meA.invites.sent.find((s) => s.guest.id === B.id);
    check(g, 'A 的 /me 里应有给 B 的邀请');
    const r = await apiAct(A, { type: 'revoke_invite', grantId: g.grantId });
    check(r.status === 200, `收回应成功：${r.status}`);
    await until(async () => (await doorRows(B.page)).find((x) => x.home === `home:${A.id}`)?.can === false, 20_000, 'B 一侧 A 的牌子变回 data-can=0（notice 之后刷新）');
    await until(async () => (await inviteRows(B.page)).length === 0, 10_000, 'B 的请柬栏里那一条消失');
    check(!(await serverMe(B)).invites.received.some((x) => x.host.id === A.id), '服务器里 B 也没有这份邀请了');
  });

  // ───────────────────────── 60.72 / 60.73 请柬的「新」标 ─────────────────────────
  let grant72 = null;
  /** A 给 B 一份当面邀请（A 要在 B 的 3 米内）；返回那份授权 */
  const inviteBFromA = async () => {
    await apiAct(B, { type: 'navigate', approach: A.id });
    await waitIdle(B);
    await until(async () => (await gapAB()) < 3, 20_000, 'B 在 A 身边');
    const r = await apiAct(A, { type: 'invite', to: B.id });
    check(r.status === 200, `A 邀请 B 应成功：${r.status} ${JSON.stringify(r.body)}`);
    const g = (await serverMe(A)).invites.sent.find((x) => x.guest.id === B.id);
    check(g, 'A 的 /me 里应有这份邀请');
    return g;
  };
  await step(60.72, '面板正开在「人家」页签时来了新请柬：请柬栏有、角标和页签小圆点不留', async () => {
    await closePanel(B.page);
    await apiAct(B, { type: 'navigate', approach: A.id });
    await waitIdle(B);
    await openPeopleTab(B.page);
    grant72 = await inviteBFromA();
    await until(async () => (await inviteRows(B.page)).some((r) => r.grantId === grant72.grantId && r.fresh), 20_000, 'B 的请柬栏出现这份新请柬（屏障）');
    await until(async () => (await badge(B.page)).people === 0 && !(await peopleDot(B.page)), 10_000, '面板开着时新请柬不留未读角标和页签小圆点');
    check((await godotPeople(B)).unseen === 0, 'Godot 一侧也没有未读');
    await closePanel(B.page);
  });

  await step(60.73, '请柬的「新」标：点「去做客」被只读拦下时仍是新的；真的走进那户人家之后才算处理过', async () => {
    const homeA = `home:${A.id}`;
    // 上一步没留下请柬（失败了）就重新造一份
    if (!grant72 || !(await serverMe(A)).invites.sent.some((x) => x.grantId === grant72.grantId)) grant72 = await inviteBFromA();
    await until(async () => (await godotPeople(B)).fresh >= 1, 20_000, 'B 一侧有新请柬');
    // 另一处接管（同一身份、另一个 clientId），B 变只读；强发「去做客」被 main 的只读检查拦下
    const other = `e2e-other-${rnd()}`;
    check((await B.ctx.request.post(`${BASE}/town/api/enter`, { data: { clientId: other } })).ok(), '另一处登记在场应成功');
    check((await B.ctx.request.post(`${BASE}/town/api/claim`, { data: { clientId: other } })).ok(), '另一处接管应成功');
    await until(async () => (await snap(B.page)).mine === false, 15_000, 'B 页面变成只读');
    const nav0 = apiCount(B, 'navigate');
    const fresh0 = (await godotPeople(B)).fresh;
    await B.page.evaluate((home) => window.TownDock.test.people.forceVisit(home), homeA);
    await toastHas(B, '只读'); // 屏障：main 的拦截提示出来了
    await frames(B.page, 3);
    check(apiCount(B, 'navigate') === nav0, `被拦下就不该发 navigate：${nav0} -> ${apiCount(B, 'navigate')}`);
    check((await godotPeople(B)).fresh === fresh0 && fresh0 >= 1, `没走成，请柬仍是新的：fresh ${fresh0} -> ${(await godotPeople(B)).fresh}`);
    check((await inviteRows(B.page)).some((r) => r.grantId === grant72.grantId && r.fresh && r.skip), '请柬行仍带「新」标与「先不去」');
    // 接管回来：「去做客」按钮还在，点它真的走进去；进门之后这张请柬才算处理过
    await B.page.click('#claimBtn');
    await until(async () => (await snap(B.page)).mine === true, 15_000, 'B 接管回来');
    await closePanel(B.page);
    const visitBtn = `#actions [data-action="f:people:visit:${homeA}"]`;
    await until(() => B.page.isVisible(visitBtn), 15_000, '「去做客」按钮还在');
    await B.page.click(visitBtn);
    await until(async () => (await where(B)).scene === 'home', 90_000, 'B 走进 A 的家', 500);
    await until(async () => (await godotPeople(B)).fresh === 0, 15_000, '进门之后请柬才算处理过（fresh 清零）');
    check((await godotPeople(B)).unseen === 0 && !(await actionButtons(B.page)).some((b) => b.id.startsWith('f:people:visit:')), '进门之后没有「去做客」按钮、没有未读');
    await openPeopleTab(B.page);
    await B.page.click(`${PANE} [data-role="leave"]`);
    await until(async () => (await where(B)).scene === 'town', 60_000, 'B 出门', 500);
    await closePanel(B.page);
    // 收回这份邀请，给后面的步骤一个干净的起点
    check((await apiAct(A, { type: 'revoke_invite', grantId: grant72.grantId })).status === 200, '收回应成功');
    await until(async () => (await inviteRows(B.page)).length === 0, 20_000, 'B 的请柬栏空了');
    grant72 = null;
  });

  // ───────────────────────── 60.8 XSS 与隐私 ─────────────────────────
  await step(60.8, 'XSS：A 的简介与名字含 HTML；B 点 A 开卡 -> 以字面量显示、不产生元素、window.__xss 未定义；门牌同理', async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    const evilName = `<u>${rnd()}`;
    check((await apiAct(A, { type: 'update_profile', bio: evil, name: evilName })).status === 200, 'A 改简介与名字');
    await openPeopleTab(B.page); // 打开面板会让 Godot 刷新 /me
    await closePanel(B.page);
    if ((await gapAB()) > 2.5) note(`A、B 相距 ${(await gapAB()).toFixed(1)} 米，B 点 A 会先走过去`);
    await clickActor(B, A.id);
    const srv = async () => (await serverMe(B)).here.residents.find((x) => x.id === A.id);
    const info = await srv();
    check(info && info.bio.includes('<img'), `服务器里 A 的简介应保留尖括号：${info?.bio}`);
    let c;
    try {
      c = await until(async () => { const x = await peopleCard(B.page); return x.cardOpen && x.cardId === A.id && x.name === info.name ? x : null; }, 40_000, 'B 的卡上是 A 的新名字');
    } catch (e) {
      const x = await peopleCard(B.page);
      throw new Error(`${e.message}；服务器：${info.name}；现状：${JSON.stringify({ open: x.cardOpen, id: x.cardId, name: x.name, hint: x.hint })} ${JSON.stringify(await godotPeople(B))} 画面里的 A：${JSON.stringify((await snap(B.page)).actors.find((y) => y.id === A.id))}`);
    }
    check(c.name === info.name && c.name.includes('<u>'), `名字应以字面量显示：${c.name}`);
    await until(async () => (await B.page.evaluate((s) => document.querySelector(`${s} [data-role="bio"]`).textContent, CARD)) === info.bio, 20_000, '简介等于服务器里的字面量');
    const dom = await B.page.evaluate((s) => ({ img: !!document.querySelector(`${s} img`), u: !!document.querySelector(`${s} u`), paneImg: !!document.querySelector('#dock img'), paneU: !!document.querySelector('#dock u'), xss: window.__xss }), CARD);
    check(!dom.img && !dom.u && !dom.paneImg && !dom.paneU && dom.xss === undefined, `不应产生元素或执行脚本：${JSON.stringify(dom)}`);
    // 门牌上的名字
    await openPeopleTab(B.page);
    const ownerText = () => B.page.evaluate(([p, id]) => document.querySelector(`${p} li[data-home="home:${id}"] [data-role="owner"]`)?.textContent ?? '', [PANE, A.id]);
    try {
      await until(async () => (await ownerText()).includes('<u>'), 20_000, '门牌上以字面量显示 A 的名字');
    } catch (e) {
      const sm = await serverMe(B);
      throw new Error(`${e.message}；门牌文字「${await ownerText()}」；门牌行 ${JSON.stringify(await doorRows(B.page))}；服务器 doors ${JSON.stringify((sm.here?.doors ?? []).map((d) => [d.home, d.owner.name]))}；B 的位置 ${JSON.stringify(await where(B))}；godot ${JSON.stringify(await godotPeople(B))}`);
    }
    check(!(await B.page.evaluate(() => !!document.querySelector('#dock u, #dock img'))), '门牌里也不应产生元素');
    await closePanel(B.page);
    // 还原名字，免得影响后面的断言
    check((await apiAct(A, { type: 'update_profile', bio: '', name: aName })).status === 200, 'A 还原名字');
    await until(async () => (await snap(B.page)).actors.find((x) => x.id === A.id)?.name === aName, 20_000, 'B 一侧 A 的名字还原');
  });

  // ───────────────────────── 60.85 AI 徽章 ─────────────────────────
  await step(60.85, 'AI 徽章（注入状态验证）：kind 为 agent 的卡 -> 文字「AI」、类名 ai，与「真人」的文字和颜色都不同', async () => {
    const mk = (kind) => JSON.stringify({ me: { id: A.id }, ctl: '', reach: 3, card: { id: 'x', name: '灯灯', kind, busy: false, near: true, known: true, bio: '', traits: [], titles: [], mood: '', hobby: null, invited: null, walking: false }, doors: null, home: null, invites: [], freshCount: 0 });
    const look = async (kind) => {
      await A.page.evaluate((j) => window.TownDock.feed('people', 'state', j), mk(kind));
      await until(async () => (await peopleCard(A.page)).cardOpen && (await peopleCard(A.page)).cardId === 'x' && (await peopleCard(A.page)).kind === (kind === 'agent' ? 'ai' : 'human'), 5000, `注入 ${kind} 的卡`, 100);
      return A.page.evaluate((s) => { const k = document.querySelector(`${s} [data-role="kind"]`); const cs = getComputedStyle(k); return { text: k.textContent, cls: k.className, bg: cs.backgroundColor, color: cs.color }; }, CARD);
    };
    const ai = await look('agent');
    const hu = await look('human');
    check(ai.text === 'AI' && /\bai\b/.test(ai.cls), `AI 徽章：${JSON.stringify(ai)}`);
    check(hu.text === '真人' && /\bhuman\b/.test(hu.cls), `真人徽章：${JSON.stringify(hu)}`);
    check(ai.bg !== hu.bg && ai.text !== hu.text, `两种徽章颜色和文字都应不同：${JSON.stringify({ ai, hu })}`);
    await A.page.evaluate((j) => window.TownDock.feed('people', 'state', j), JSON.stringify({ me: { id: A.id }, ctl: '', reach: 3, card: null, doors: null, home: null, invites: [], freshCount: 0 }));
    await cardClosed(A);
    note('AI 徽章靠注入状态验证；真实 AI 居民由 C7 整条试玩覆盖');
  });

  // ───────────────────────── 60.9 手机 ─────────────────────────
  await step(60.9, '手机与布局：B 的卡不超出视口、按钮高 >= 44、不盖 controls；点卡空白处不走路；抽屉开着卡仍可见按钮可点；桌面侧栏开着时卡与 #dock 不相交', async () => {
    // 60.8 留下的卡还开着（里面是 A 改过的简介）：先关掉再点，重新开卡会取最新资料
    if ((await peopleCard(B.page)).cardOpen) {
      await B.page.keyboard.press('Escape');
      await cardClosed(B);
    }
    await clickActor(B, A.id);
    const c = await cardIs(B, A.id);
    const vp = await B.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    check(c.rect.left >= 8 && c.rect.right <= vp.w - 8, `卡片左右应各留 >= 8px：${JSON.stringify(c.rect)} 视口 ${vp.w}`);
    const btnH = await B.page.evaluate((s) => [...document.querySelectorAll(`${s} .people-btns button`)].map((b) => b.getBoundingClientRect().height), CARD);
    check(btnH.length === 2 && btnH.every((x) => x >= 44), `按钮高度应 >= 44：${btnH}`);
    const ctl = await B.page.evaluate(() => [...document.querySelectorAll('#controls button')].map((b) => b.getBoundingClientRect().toJSON()).filter((r) => r.width > 0));
    for (const r of ctl) check(!hit(c.rect, r), `卡片不应盖住 controls：${JSON.stringify({ card: c.rect, r })}`);
    const sa = await screenOf(B.page, A.id);
    const sb = await screenOf(B.page, B.id);
    check(!inside(c.rect, sa) && !inside(c.rect, sb), `手机卡片不应盖住双方：${JSON.stringify({ sa, sb, rect: c.rect })}`);
    await until(async () => !(await peopleCard(B.page)).text.includes('<img'), 20_000, '卡片取到最新资料（A 的简介已还原）后再截图', 300);
    await shot(B.page, '60-mobile-card');
    // 点卡空白处不穿透成点地走路
    const nav0 = apiCount(B, 'navigate');
    const cNow = await peopleCard(B.page); // 开卡之后资料会补全、卡片高度会变：用此刻的矩形
    const pt = { x: cNow.rect.left + 10, y: cNow.rect.top + 10 };
    const top = await hitTest(B.page, pt.x, pt.y);
    check(await B.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#peopleCard'), [pt.x, pt.y]), `点位应落在卡片上：${JSON.stringify(top)} 点 ${JSON.stringify(pt)} 卡 ${JSON.stringify(cNow.rect)} 开卡时 ${JSON.stringify(c.rect)}`);
    await B.page.touchscreen.tap(pt.x, pt.y);
    await frames(B.page, 4);
    await sleep(800);
    check(apiCount(B, 'navigate') === nav0 && !(await sceneOf(B)).nav, `点卡片空白处不应走路：${nav0} -> ${apiCount(B, 'navigate')}`);
    // 抽屉开着
    await openPeopleTab(B.page);
    const c2 = await peopleCard(B.page);
    check(c2.cardOpen, '抽屉开着时卡仍可见');
    const dr = await rectOf(B.page, '#dock');
    check(c2.rect.bottom <= dr.top + 1, `抽屉开着：卡应在抽屉之上：卡底 ${c2.rect.bottom} 抽屉顶 ${dr.top}`);
    for (const role of ['ask', 'invite']) {
      const ok = await B.page.evaluate(([s, r]) => { const b = document.querySelector(`${s} [data-role="${r}"]`); const q = b.getBoundingClientRect(); const e = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return e === b; }, [CARD, role]);
      check(ok, `抽屉开着：「${role}」按钮应可点（最上层）`);
    }
    // 抽屉开着时卡片也不能压在自己和对方的名牌、身体上（脚环、头顶名牌、1 米高处的屏幕位置都算）
    const body = await B.page.evaluate(([me, other]) => {
      const t = window.__town;
      const feet = (id) => { const a = t.actors.find((x) => x.id === id); const q = t.project(a.x, 0, a.z); return { x: q.x, y: q.y }; };
      const tag = (id) => { const e = document.querySelector(`#tags .tag[data-id="${id}"]`); return e ? e.getBoundingClientRect().toJSON() : null; };
      return { feet: [feet(me), feet(other)], tags: [tag(me), tag(other)] };
    }, [B.id, A.id]);
    const heads = [await screenOf(B.page, B.id), await screenOf(B.page, A.id)];
    for (const pt of [...heads, ...body.feet]) check(!inside(c2.rect, pt), `抽屉开着：卡片不应盖住人的位置 ${JSON.stringify(pt)}：${JSON.stringify(c2.rect)}`);
    for (const tr of body.tags) if (tr) check(!hit(c2.rect, tr), `抽屉开着：卡片不应盖住名牌 ${JSON.stringify(tr)}：${JSON.stringify(c2.rect)}`);
    await closePanel(B.page);
    await A.page.keyboard.press('Escape');
    // 桌面：侧栏开着时卡与 #dock 不相交
    await clickActor(A, B.id).catch(async () => { await A.page.click(`#actions [data-action="f:people:meet:${B.id}"]`); });
    await cardIs(A, B.id);
    await openPeopleTab(A.page);
    const ca = await peopleCard(A.page);
    const da = await rectOf(A.page, '#dock');
    check(ca.cardOpen && !hit(ca.rect, da), `桌面侧栏开着：卡与面板不相交：${JSON.stringify({ card: ca.rect, dock: da })}`);
    await closePanel(A.page);
  });

  // ───────────────────────── 60.91 Esc 与地点菜单、被 CSS 藏起来的卡 ─────────────────────────
  await step(60.91, 'Esc 与 hud.js 一致：地点菜单开着时那一下 Esc 只关菜单、卡不动；卡被 CSS 藏起来（软键盘）时 Esc 不去关看不见的卡', async () => {
    await closePanel(B.page);
    if (!(await peopleCard(B.page)).cardOpen) {
      await clickActor(B, A.id);
      await cardIs(B, A.id);
    }
    await B.page.click('#destBtn');
    await until(() => B.page.evaluate(() => !document.getElementById('destMenu').hidden), 5000, '地点菜单打开');
    await B.page.keyboard.press('Escape');
    await until(() => B.page.evaluate(() => document.getElementById('destMenu').hidden), 5000, '这一下 Esc 关了地点菜单');
    await frames(B.page, 3);
    check((await peopleCard(B.page)).cardOpen && (await godotPeople(B)).cardId === A.id, '地点菜单开着时那一下 Esc 不该顺带关卡');
    // 卡被 CSS 藏起来时（软键盘出现）Esc 不去关一张看不见的卡。
    // 软键盘用底座的测试钩子装出来，不直接写 body 的 data-kb：刚点过的「地点」按钮还握着焦点，它被这个标记藏起来就会失焦，
    // 底座一见焦点变化就重算键盘高度、把手写的标记清回 0（卡又看得见了），之后那一下 Esc 关卡是对的——手写标记只在按键抢在重算之前才测得到想测的东西
    await B.page.evaluate(() => window.TownDock.test.setKeyboard(300));
    await until(() => B.page.evaluate(() => getComputedStyle(document.getElementById('peopleCard')).display === 'none'), 5000, '软键盘状态下卡被藏起来');
    // 屏障：失焦引出的那次重算已经过去（失焦 -> 下一个宏任务 -> 下一帧），标记仍在
    await until(() => B.page.evaluate(() => document.activeElement === document.body), 5000, '被藏起来的「地点」按钮已经失焦');
    await frames(B.page, 4);
    const kbState = await B.page.evaluate(() => ({ flag: document.body.dataset.kb, display: getComputedStyle(document.getElementById('peopleCard')).display }));
    check(kbState.flag === '1' && kbState.display === 'none', `重算之后软键盘状态仍在、卡仍藏着：${JSON.stringify(kbState)}`);
    await B.page.keyboard.press('Escape');
    await frames(B.page, 3);
    const gpHidden = await godotPeople(B);
    check(gpHidden.cardId === A.id, `卡被 CSS 藏起来时 Esc 不该关它：${JSON.stringify({ cardId: gpHidden.cardId, flag: await B.page.evaluate(() => document.body.dataset.kb) })}`);
    await B.page.evaluate(() => window.TownDock.test.setKeyboard(null));
    await until(() => B.page.evaluate(() => getComputedStyle(document.getElementById('peopleCard')).display !== 'none'), 5000, '软键盘状态解除，卡又看得见');
    await B.page.keyboard.press('Escape');
    await cardClosed(B);
  });

  // ───────────────────────── 60.92 只读 / 游戏中 / 离线 / 对方在游戏里 ─────────────────────────
  await step(60.92, '只读、游戏中、离线、对方在游戏里（注入状态，只验界面）：按钮灰掉，提示是对应文字', async () => {
    const base = (ctl, busy) => JSON.stringify({ me: { id: A.id }, ctl, reach: 3, card: { id: 'x', name: '灯灯', kind: 'human', busy, near: true, known: true, bio: '', traits: [], titles: [], mood: '', hobby: null, invited: null, walking: false }, doors: null, home: null, invites: [], freshCount: 0 });
    for (const [ctl, busy, key] of [['readonly', false, 'note.readonly'], ['game', false, 'note.game'], ['offline', false, 'note.offline'], ['', true, 'note.busy']]) {
      await A.page.evaluate((j) => window.TownDock.feed('people', 'state', j), base(ctl, busy));
      const want = await bank(A.page, key);
      const c = await until(async () => { const x = await peopleCard(A.page); return x.cardOpen && x.cardId === 'x' && x.note === want ? x : null; }, 5000, `提示是「${want}」`, 100);
      check(c.askDisabled && c.inviteDisabled, `${ctl || 'busy'}：两个按钮都应禁用：${JSON.stringify(c)}`);
    }
    await A.page.evaluate((j) => window.TownDock.feed('people', 'state', j), JSON.stringify({ me: { id: A.id }, ctl: '', reach: 3, card: null, doors: null, home: null, invites: [], freshCount: 0 }));
    await cardClosed(A);
    note('真实的只读 / 游戏中由 C3 与 C7 的整条试玩补');
  });

  // ───────────────────────── 60.93 截图 ─────────────────────────
  let letterId = null;
  await step(60.93, '截图：B 向 A 问爱好并邀请 -> A 的门牌 + 请柬（桌面）；A 回家的屋里；A 傍晚点 B 的居民卡', async () => {
    // 顺手先寄一封附邀请的信（A -> B）：投递要 60 秒，让等待和下面的截图重叠；60.96 读它
    const lr0 = await apiAct(A, { type: 'send_letter', to: B.id, body: '来家里坐坐', invite: {} });
    check(lr0.status === 200 || lr0.status === 202, `寄信应成功：${lr0.status} ${JSON.stringify(lr0.body)}`);
    letterId = lr0.body?.letterId ?? null;
    check(letterId, `寄信应回 letterId：${JSON.stringify(lr0.body)}`);
    await clickActor(B, A.id).catch(async () => { await B.page.click(`#actions [data-action="f:people:meet:${A.id}"]`); });
    await cardIs(B, A.id);
    const nb = await lastN(B);
    await B.page.click(`${CARD} [data-role="ask"]`);
    await ackAfter(B, 'ask', nb);
    const nb2 = await lastN(B);
    await B.page.click(`${CARD} [data-role="invite"]`);
    check((await ackAfter(B, 'invite', nb2)).ok, 'B 邀请 A 应成功');
    await until(async () => (await inviteRows(A.page)).length === 1, 20_000, 'A 的请柬栏有一条');
    await openPeopleTab(A.page);
    await sleep(400);
    await shot(A.page, '61-desktop-doors');
    await clickDoor(A.page, `home:${A.id}`);
    await until(async () => (await where(A)).scene === 'home', 90_000, 'A 回家', 500);
    await until(async () => (await houseInfo(A.page))?.open, 15_000, '屋里栏出现');
    await sleep(500);
    await shot(A.page, '62-desktop-home');
    await A.page.click(`${PANE} [data-role="leave"]`);
    await until(async () => (await where(A)).scene === 'town', 60_000, 'A 出门', 500);
    await closePanel(A.page);
    // 傍晚：钟点只在页面加载时读，重新进入一次（会话 Cookie 还在）
    A.w.closing = true;
    await A.page.goto(`${BASE}/town/3d/?debug=1&hour=19.5`);
    await A.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    A.w.closing = false;
    await A.page.click('#enterBtn');
    await A.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    await until(async () => Math.abs((await A.page.evaluate(() => window.__town.hour)) - 19.5) < 0.4, 15_000, 'A 钟点到 19.5');
    await until(async () => (await snap(A.page)).actors.some((x) => x.id === B.id), 30_000, 'A 看到 B');
    await until(async () => (await actionButtons(A.page)).some((b) => b.id === `f:people:meet:${B.id}`), 30_000, 'A 的「认识一下」出现');
    await A.page.click(`#actions [data-action="f:people:meet:${B.id}"]`);
    await cardIs(A, B.id);
    await sleep(400);
    await shot(A.page, '60-desktop-card-evening');
  });

  // ───────────────────────── 60.96 信里的邀请 ─────────────────────────
  await step(60.96, '信里的邀请：B 在读信之前 /me 与界面都没有这份请柬；B 回家读信（API）后，/me 出现 via=letter 的邀请，Godot 一侧算新请柬（没有 invite 事件也不弹 toast），#actions 出现「去做客」，请柬栏有一条', async () => {
    await closePanel(B.page);
    const bHome = `home:${B.id}`;
    // 屏障：信已经投递到 B 的信箱，而且 B 还没读（读之前 /me 的 received 里没有 A 的邀请）
    const cid = await B.page.evaluate(() => window.TownHud.clientId());
    const inbox = async () => (await (await B.ctx.request.get(`${BASE}/town/api/letters?clientId=${encodeURIComponent(cid)}`)).json()).letters ?? [];
    await until(async () => (await inbox()).some((l) => l.id === letterId), 120_000, 'A 的信投递到 B 的信箱（60 秒延迟）', 1000);
    check(!(await serverMe(B)).invites.received.some((r) => r.host.id === A.id), '读信之前 B 的 /me 不应有 A 的邀请');
    const g0 = await godotPeople(B);
    check(g0.fresh === 0, `读信之前 Godot 一侧不应有新请柬：${g0.fresh}`);
    check((await inviteRows(B.page)).length === 0 && !(await actionButtons(B.page)).some((b) => b.id.startsWith('f:people:visit:')), '读信之前界面不应有请柬或「去做客」');
    // 回家（走页面，长路），读信
    await openPeopleTab(B.page);
    await clickDoor(B.page, bHome);
    await until(async () => (await where(B)).scene === 'home', 90_000, 'B 回到自己家', 500);
    await closePanel(B.page);
    const rr = await apiAct(B, { type: 'read_letter', letterId });
    check(rr.status === 200, `读信应成功：${rr.status} ${JSON.stringify(rr.body)}`);
    const me = await serverMe(B);
    const inv = me.invites.received.find((r) => r.host.id === A.id);
    check(inv && inv.via === 'letter', `读信之后 /me 应有 via=letter 的邀请：${JSON.stringify(me.invites.received)}`);
    // 读信是 API 代发的，页面不知道；开面板（页签被看到）会让 Godot 刷新 /me
    await openPeopleTab(B.page);
    await until(async () => (await godotPeople(B)).fresh === 1, 20_000, 'Godot 一侧出现 1 张新请柬');
    await until(async () => (await inviteRows(B.page)).some((r) => r.home === `home:${A.id}` && r.fresh), 15_000, '请柬栏出现这一份且是新的');
    await closePanel(B.page);
    await until(async () => (await actionButtons(B.page)).some((b) => b.id === `f:people:visit:home:${A.id}`), 15_000, 'B 的 #actions 出现「去做客」');
    // 出门回会馆，给 60.95 一个干净的起点
    await openPeopleTab(B.page);
    await B.page.click(`${PANE} [data-role="leave"]`);
    await until(async () => { const x = await where(B); return x.scene === 'town'; }, 60_000, 'B 出门', 500);
    await closePanel(B.page);
  });

  // ───────────────────────── 60.95 离开与换人 ─────────────────────────
  await step(60.95, '离开与换人：B（问过爱好、发过邀请）离开小镇 -> 卡、请柬、门牌清空；换名重进后 Godot 一侧缓存为 0，API 读新居民没有上一位的任何信息', async () => {
    allowFailure(B.w, 'POST', /\/town\/api\/heartbeat$/, { min: 0, max: 1, why: '60.95：离开瞬间在途的心跳可能 presence_lost' });
    const g = await godotPeople(B);
    check(g.hobbies >= 1 && g.sentTo.length >= 1, `离开前 B 应有爱好缓存与已邀请记录（否则清空断言是空的）：${JSON.stringify({ h: g.hobbies, s: g.sentTo })}`);
    const cid = await B.page.evaluate(() => window.TownHud.clientId());
    const lr = await B.ctx.request.post(`${BASE}/town/api/leave`, { data: { clientId: cid } });
    check(lr.ok(), `POST /leave 返回 ${lr.status()}`);
    await until(() => B.page.evaluate(() => document.body.dataset.phase === 'ready'), 20_000, 'B 回到「已离开」');
    const d = await peopleCard(B.page);
    check(!d.cardOpen && d.cardId === '' && d.doors.length === 0 && d.invites.length === 0 && !d.houseOpen, `离开后网页一侧应清空：${JSON.stringify({ c: d.cardOpen, id: d.cardId, doors: d.doors.length, inv: d.invites.length })}`);
    await B.ctx.clearCookies();
    const oldId = B.id;
    await B.page.click('#enterBtn');
    await B.page.waitForSelector('#nameInput', { state: 'visible', timeout: 30_000 });
    await B.page.fill('#nameInput', `阿换${rnd()}`);
    await B.page.click('#loginBtn');
    await B.page.waitForFunction(() => window.__town && window.__town.actors.length > 0 && document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
    B.id = (await snap(B.page)).self;
    check(B.id !== oldId, '换名重进应是另一位居民');
    await frames(B.page, 3);
    await until(async () => { const x = await godotPeople(B); return x && x.me === B.id; }, 15_000, 'Godot 一侧已是新居民');
    const g2 = await godotPeople(B);
    check(g2.hobbies === 0 && g2.sentTo.length === 0 && g2.cardId === '' && g2.invites === 0 && g2.fresh === 0, `换人后 Godot 一侧缓存应清空：${JSON.stringify(g2)}`);
    const d2 = await peopleCard(B.page);
    check(!d2.cardOpen && d2.invites.length === 0 && d2.unread === 0, '换人后网页一侧也应是空的');
    const me = await serverMe(B);
    check(me.invites.received.length === 0 && me.invites.sent.length === 0, `新居民的 /me 不应有上一位的邀请：${JSON.stringify(me.invites)}`);
  });

  await h.release(A);
  await h.release(B);
}

/* ───────────────────────── 怎么让它失败（反向验证）─────────────────────────
 * 每条：改坏哪里 -> 哪个子步骤变红（现象）。都是临时改坏、跑完还原。
 * 第一批（接手前的实现；红的步骤是当时亲眼见过的）：
 *  - people.js 简介 textContent 改成 DOMParser 解析后追加（等价 innerHTML）-> 60.8（简介不等于字面量、卡里出现 img）
 *  - people.js 爱好名单 reverse() -> 60.3（卡上爱好行与 B 的 /me 顺序不一致）
 *  - people.js 门牌「进门」按钮永不禁用 -> 60.4（A 的灰牌子 enterDisabled 为假）
 *  - people.js 屋里标签「做客 / 主人」对调 -> 60.6、60.65
 *  - people.css 卡片 bottom:0; left:0; width:100vw -> 60.1（卡片盖住 #controls 的按钮）
 *  - people.gd on_pick 近处改回 return false -> 60.1（多出一次 navigate）
 *  - people.gd 去掉 you_arrived 里的待开卡 -> 60.2（走到之后卡不出现）
 *  - people.gd 去掉「已邀请」的本地拦截 -> 60.5（强发邀请没被 Godot 拦下）
 *  - people.gd 去掉 notice 的刷新 -> 60.7（A 的牌子不变回 data-can=0）
 *  - people.gd _reset_all 不清爱好缓存 -> 60.95（换人后 hobbies 仍为 1）
 * 第二批（评审后补的）：
 *  - dock.css 去掉 .dock-tab 的 z-index:3（手机抽屉里 #dockGrip 盖住页签）-> openPeopleTab 抛「页签中心最上面是 dockGrip，真手指点不到页签」，
 *    60.5、60.6、60.72、60.8、60.96 都因此变红（连带后面依赖它们的步骤）
 *  - people.gd _watch_walk 直接 return（「正在走向」不再因改道 / 走完 / 超时结束）、nav_stopped 不再取消 -> 60.57（改道后 15 秒内 walk 仍为 true，卡也不自动关）
 *  - people.gd too_far 分支不判 _card_id == tid 就 c4_approach -> 60.58（ack 带 stale 却也带 walking:true，A 被拽向 ta）
 *  - people.gd _visit 里一点「去做客」就清 fresh / unseen -> 60.73（只读拦下之后 fresh 1 -> 0）
 *  - people.js 去掉 onFeed('state') 里面板开着时的 seen -> 60.72（角标和页签小圆点一直挂着）
 *  - people.js 不再告诉 Godot 面板开着（panel）-> 60.4（面板开在「人家」页签时 #actions 里还有「门牌」）
 *  - people.css 去掉抽屉开着时卡片改挂上半屏的那条 -> 60.9（卡片盖住自己的头部位置 / 名牌）
 *  - people.js 的 Esc 监听去掉 menuOpen 与 getComputedStyle 判断 -> 60.91（地点菜单开着时那一下 Esc 顺带关了卡）；
 *    「卡被 CSS 藏起来时 Esc 不关它」那一半是同一处改动，但上一句先红了、没有单独见到它变红
 *  - 「认识一下」选人的迟滞（pick_meet）：Godot 无头单测 client/tools/test-people.gd（两个人距离相近时不来回换）。把 pick_meet 写回旧逻辑
 *    （只有当前对象本身就是最近者才有迟滞）-> 单测 5 项失败；浏览器里只有两个居民，造不出「两个候选」，所以不放在这个文件里
 * 没有做出红灯 / 没有做的（如实）：
 *  - 「把 3 米改成 30 米」：没有单独做。on_pick 近处分支与待开卡各有一条红灯，距离门槛本身靠 60.2（远处点人必须走路、不出卡）覆盖
 *  - 「把 needs / interests 渲染进卡」：客户端手里没有别人的爱好，做不出诚实的泄露改法；60.1 的「卡里没有 B 的爱好」是在 B 设了三个爱好的前提下断言的
 *  - 「去掉 invite 事件后的 refresh_me」：没有单独做；门牌可进靠 60.5 的 data-can 等待覆盖，但同一步里还有 notice 与打开面板的刷新
 *  - 限流（60.35）、declined（60.3）：断言用服务器原文与 422 / 429 记录，没有改坏实现的反向验证
 *  - 60.35 改成「烧光额度后若界面那一次恰好补到额度而成功，就再烧一轮」（最多 3 轮），不再靠 900 毫秒的侥幸；这条没法在浏览器里造出「恰好补到」，只验过正常路径
 */
