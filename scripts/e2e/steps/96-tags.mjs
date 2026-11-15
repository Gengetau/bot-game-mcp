// V1 第三项：名牌、功能牌、物件牌、门牌、区域牌、气泡的避让。A 桌面 1440x900，B 手机 390x844 触摸；两人都带 NPC（h.pair({ npcs: true })）。
// 牌的优先级：自己的名牌 > 别人的名牌与 NPC 牌 > 功能牌(c) > 选中的物件牌 > 门牌(p) > 其他物件牌(o) > 区域牌(z)。
// 量的都是 #tags 里真正画着的牌（没被避让藏起来的）的包围盒；判定规则在 lib/look.mjs 之外还有 client/tests-web/fit.test.mjs 的纯函数单测。
import { poll, rectOf, frames } from '../lib/ui.mjs';
import { apiSay, apiAct } from '../lib/chat.mjs';
import { hit, overlapArea, area, selfScreen, tagList, contrastOf, settleView, sleep } from '../lib/look.mjs';

export const meta = { id: 'look-tags', n: 96, title: 'V1 名牌避让' };

const NAME = new Set(['s', 'a', 'npc']);

export default async function run(h) {
  const { check, note, until, step, shot, serverScene, selfActor, walkTo } = h;
  const { A, B } = await h.pair({ npcs: true });

  /** 页面里当前画着的牌：两两重叠超过较小一块的 5% 的，名牌之间的除外（它们靠位置错开，不靠避让）；返回问题列表。 */
  const pairIssues = (list) => {
    const bad = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (NAME.has(a.kind) && NAME.has(b.kind)) continue;
        const ov = overlapArea(a.rect, b.rect);
        const small = Math.min(area(a.rect), area(b.rect));
        if (small > 0 && ov / small > 0.05) bad.push(`${a.kind}「${a.text}」与 ${b.kind}「${b.text}」重叠 ${(100 * ov / small).toFixed(0)}%`);
      }
    }
    return bad;
  };
  /** 自己的名牌（s）与别的牌里优先级更低的（p z o）不能碰一点：它们必须让开或淡出。 */
  const ownVsLow = (list) => {
    const me = list.find((t) => t.kind === 's');
    if (!me) return ['没有自己的名牌'];
    return list.filter((t) => ['p', 'z', 'o'].includes(t.kind) && hit(me.rect, t.rect)).map((t) => `自己的名牌与 ${t.kind}「${t.text}」相交`);
  };
  const sample = async (p, n = 10, gap = 150) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await tagList(p.page));
      await sleep(gap);
    }
    return out;
  };
  const inViewport = (list, W, H) => list.filter((t) => ['z', 'p'].includes(t.kind)).filter((t) => t.rect.left < -1 || t.rect.top < -1 || t.rect.right > W + 1 || t.rect.bottom > H + 1).map((t) => `${t.kind}「${t.text}」超出视口`);
  const vpOf = (p) => p.page.evaluate(() => ({ W: window.innerWidth, H: window.innerHeight }));
  const near = async (p, x, z, tol = 1.2) => walkTo(p, x, z, tol, { avoidDock: true });

  await step(96, '站在家门口：自己的名牌不压门牌、区域牌、物件牌（它们让开或淡出）；十次抽样里任意两块牌（名牌之间除外）重叠不超过较小一块的 5%；区域牌、门牌整块在视口里；A、B 两个页面各量一遍', async () => {
    await near(A, 3.25, 26.25);
    await near(B, 4.75, 26.25, 1.5);
    for (const p of [A, B]) {
      await settleView(p.page, { what: `${p.label} 稳定` });
      const { W, H } = await vpOf(p);
      const kinds = new Set();
      let bad = [];
      const frames10 = await sample(p);
      for (const list of frames10) {
        list.forEach((t) => kinds.add(t.kind));
        bad = bad.concat(pairIssues(list), ownVsLow(list), inViewport(list, W, H));
      }
      check(kinds.has('s'), `${p.label}：应画着自己的名牌：${[...kinds]}`);
      check(bad.length === 0, `${p.label}：名牌避让有问题：${[...new Set(bad)].join('；')}`);
      note(`${p.label}（${W}x${H}）：十次抽样里出现过的牌 ${[...kinds].join(',')}，没有越规的重叠`);
      await shot(p.page, p === A ? '95-desktop-door' : '95-mobile-door');
    }
    // 门牌存在（站在门上时它会因为压到自己的名牌而淡出，所以连藏起来的一起找）
    const seenDoor = await poll(async () => (await tagList(A.page, { includeHidden: true })).some((t) => t.kind === 'p'), 8000, 'A 画面里有门牌', 200).catch(() => false);
    check(seenDoor, 'A 站在家门口，画面里应有门牌（p，可能已淡出）');
  });

  await step(96.1, '气泡不落在名牌上：B 站在 A 旁边说一句话，气泡存在期间的每次抽样，气泡与名牌（自己的、别人的）相交都不超过气泡的 5%', async () => {
    const text = '你好呀，今天天气真不错，一起去茶馆坐坐吧';
    await apiSay(B, text);
    await poll(async () => (await tagList(A.page)).some((t) => t.kind === 'b'), 8000, 'A 看到气泡', 150);
    const bad = [];
    let got = 0;
    for (let i = 0; i < 12; i++) {
      const list = await tagList(A.page);
      const bs = list.filter((t) => t.kind === 'b');
      if (bs.length) got++;
      for (const b of bs) for (const t of list.filter((x) => NAME.has(x.kind))) {
        const ov = overlapArea(b.rect, t.rect);
        if (ov / area(b.rect) > 0.05) bad.push(`气泡压到 ${t.kind}「${t.text}」${(100 * ov / area(b.rect)).toFixed(0)}%`);
      }
      await sleep(120);
    }
    check(got >= 3, `气泡存在期间应抽到至少 3 次：${got}`);
    check(bad.length === 0, `气泡不应压名牌：${[...new Set(bad)].join('；')}`);
    note(`气泡抽到 ${got} 次，均未压名牌`);
    await shot(A.page, '95-desktop-bubble');
  });

  await step(96.2, '茶馆柜台前：NPC 的牌、居民的牌、茶桌上的物件牌一起量，两两不相交（名牌之间也不相交）；手机页同样；牌里没有被藏起来的名牌', async () => {
    await near(A, 16.25, 11.25, 1.2);
    await near(B, 17.75, 11.25, 1.5);
    for (const p of [A, B]) {
      await settleView(p.page, { what: `${p.label} 稳定` });
      await poll(async () => (await tagList(p.page)).some((t) => t.kind === 'npc'), 15_000, `${p.label} 看到 NPC 的牌`, 200);
      const { W, H } = await vpOf(p);
      const kinds = new Set();
      let bad = [];
      for (const list of await sample(p, 8, 200)) {
        list.forEach((t) => kinds.add(t.kind));
        bad = bad.concat(pairIssues(list), ownVsLow(list), inViewport(list, W, H));
        // 自己的名牌（最高优先级）不与任何别的名牌（居民、NPC）相交；别人之间（镇上还有别的居民）挤在一起时靠位置错开，不在这里断言
        const mine = list.find((t) => t.kind === 's');
        for (const t of list.filter((x) => NAME.has(x.kind) && x.kind !== 's')) if (mine && hit(mine.rect, t.rect)) bad.push(`自己的名牌与 ${t.kind}「${t.text}」相交`);
      }
      // 名牌从不被藏起来
      const hidden = (await tagList(p.page, { includeHidden: true })).filter((t) => t.off && NAME.has(t.kind));
      check(hidden.length === 0, `${p.label}：名牌不应被避让藏起来：${JSON.stringify(hidden.map((t) => t.text))}`);
      check(bad.length === 0, `${p.label}：茶馆里牌的避让有问题：${[...new Set(bad)].join('；')}`);
      note(`${p.label}：出现过的牌 ${[...kinds].join(',')}`);
      await shot(p.page, p === A ? '95-desktop-tea' : '95-mobile-tea');
    }
  });

  await step(96.3, '两个人并排走 5 秒：自己名牌相对脚下的偏移几乎不跳（相邻两次抽样偏移变化超过 6 像素的不多于 2 次）', async () => {
    const me = selfActor(await serverScene(A));
    const sign = me.x > 20 ? -1 : 1;
    const go = (p, dz) => apiAct(p, { type: 'navigate', to: { x: me.x + sign * 7, z: me.z + dz } });
    const [ra] = await Promise.all([go(A, 0), go(B, 1.2)]);
    check(ra.status === 200, `A 能走：${ra.status}`);
    const offs = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const [list, s] = await Promise.all([tagList(A.page), selfScreen(A.page)]);
      const t = list.find((x) => x.kind === 's');
      if (t) offs.push(t.rect.bottom - s.y);
      await sleep(100);
    }
    let jumps = 0;
    for (let i = 1; i < offs.length; i++) if (Math.abs(offs[i] - offs[i - 1]) > 6) jumps++;
    check(offs.length >= 20, `抽样应不少于 20 次：${offs.length}`);
    check(jumps <= 2, `名牌偏移跳了 ${jumps} 次（>6 像素），应不多于 2 次：${offs.map((v) => v.toFixed(0)).join(' ')}`);
    note(`走 5 秒抽样 ${offs.length} 次，偏移 ${Math.min(...offs).toFixed(0)}..${Math.max(...offs).toFixed(0)}，跳变 ${jumps} 次`);
    await until(async () => !selfActor(await serverScene(A))?.nav, 30_000, 'A 走完', 400);
    await until(async () => !selfActor(await serverScene(B))?.nav, 30_000, 'B 走完', 400);
  });

  await step(96.4, '区域牌、门牌的对比度：白色底（最亮的地砖）上文字对底不低于 4.5', async () => {
    // 区域牌 z、门牌 p 现在都有垫底；走回家门口让它们都出现
    await near(A, 3.25, 23.25, 1.2); // 离门三米：门牌不再压自己的名牌，画着
    await settleView(A.page, { what: 'A 稳定' });
    await poll(async () => (await tagList(A.page)).some((t) => t.kind === 'p') && (await tagList(A.page)).some((t) => t.kind === 'z'), 10_000, '画面里画着门牌和区域牌', 200);
    const rows = await contrastOf(A.page, ['#tags .tag.z:not(.off)', '#tags .tag.p:not(.off)']);
    check(rows.some((r) => r.sel.includes('.p')) && rows.some((r) => r.sel.includes('.z')), `门牌和区域牌都应量到：${JSON.stringify(rows)}`);
    check(rows.length > 0, '应量到至少一块区域牌或门牌');
    const low = rows.filter((r) => r.ratio < 4.5);
    check(low.length === 0, `对比度不足 4.5：${JSON.stringify(low)}`);
    note(`对比度：${rows.map((r) => `${r.sel.split('.').pop()}「${r.text}」${r.ratio}`).join('、')}`);
  });

  await h.release(A);
  await h.release(B);
}

/*
 * 怎么让它失败（临时改动 -> 应当变红的子步骤；改完一定改回来）
 * 【实测过】（结果见 client/docs/V1.md「反向验证」）
 *  1. hud.js 的 setTags 在 TownFit.layoutTags 之后把结果换成原位置、全部显示（等于没有避让）
 *     -> 96「s『阿桌…』与 p『家门』重叠 64%；自己的名牌与 p『家门』相交」、96.2「z『檐下书屋』超出视口」。
 *  2. hud.css 的 .tag.p 底色改成浅色（rgba(250,245,220,0.9)）-> 96.4「ratio 1.33」。
 *     注意：.tag.z 的深色垫底改回原来的透明并不会让 96.4 变红，因为 .tag 基类本来就有深色底；z 上这条垫底是冗余的保险，不是 96.4 在测的东西。
 * 【只是推演】
 *  - 96.3：去掉 fit.js 里的滞回（HOLD、TOL）-> 并排走时偏移来回跳，跳变次数超过 2（fit.test.mjs 里有对应的纯函数断言）。
 *  - 96.1：气泡的避让由 bubbles.gd 的 layout 负责，把 bubbles.gd 里把名牌当障碍的那段去掉 -> 气泡压名牌。
 */
