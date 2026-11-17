// T02a：带状态的物件与资产管线。A 桌面 1440x900。用占位样件（?debug=1&props=sample）：公共厨房的两个灶台换成 station_sample、厨房房子换成 building_sample。
// 步骤号都是数字，文件内的子步骤按顺序互相依赖，只能整个文件一起跑（--only=props 或 --only=100）。
// 末尾有一段「怎么让它失败」。
//
// 这个文件需要先导出客户端（npm run client:export）。
import { propsOf, propState, setPropState } from '../lib/props.mjs';
import { goPlace, settle } from '../lib/activity.mjs';

export const meta = { id: 'props', n: 100, title: '带状态的物件（占位灶台、占位建筑）' };

const S1 = 'kitchen:stove1';
const S2 = 'kitchen:stove2';
const STATES = ['idle', 'busy', 'done', 'fault'];

export default async function run(h) {
  const { check, until, sleep, step, shot, walkTo, BASE, townParams } = h;
  const { A, B } = await h.pair();
  await h.release(B); // 这个文件只用桌面页面；手机那位不放走的话会一直站在出生点，污染后面文件里「附近的人」的断言
  const loadIn = async (p, query) => {
    p.w.closing = true;
    await p.page.goto(`${BASE}/town/3d/?${query}`);
    await p.page.waitForSelector('#enterBtn:not([hidden])', { timeout: 120_000 });
    p.w.closing = false;
    await p.page.click('#enterBtn');
    await p.page.waitForFunction(() => document.body.dataset.phase === 'playing', null, { timeout: 60_000 });
  };
  const stateIs = (id, st) => async () => ((await propState(A.page, id)) === st ? true : null);
  // 人已经在厨房里时地点菜单里没有「公共厨房」这一项（重新进页面后人还在原地）：在了就不用走
  const toKitchen = async () => {
    const s = await until(async () => {
      const v = await h.snap(A.page);
      return v && v.self && v.space ? v : null;
    }, 20_000, '进镇后拿到场景快照');
    if (s.space !== 'kitchen') await goPlace(h, A, 'kitchen');
  };

  await step(100, '占位样件：?debug=1&props=sample 进镇，__town.props 里有两个灶台，状态是 idle，可用状态是四个', async () => {
    await loadIn(A, 'debug=1&hour=12&props=sample');
    await toKitchen();
    const ps = await until(async () => {
      const l = await propsOf(A.page);
      return l.length === 2 ? l : null;
    }, 20_000, '__town.props 里有两个带状态的物件');
    check(ps.map((p) => p.id).sort().join() === [S1, S2].join(), `应是两个灶台：${JSON.stringify(ps)}`);
    for (const p of ps) {
      check(p.kind === 'stove' && p.state === 'idle' && !p.forced, `${p.id} 应是 idle、没被强行指定：${JSON.stringify(p)}`);
      check(STATES.every((s) => p.states.includes(s)), `${p.id} 应有四个状态：${JSON.stringify(p.states)}`);
    }
    // 函数过不了 page.evaluate 的序列化，在页面里取 typeof
    check((await A.page.evaluate(() => typeof window.__town.setPropState)) === 'function', 'window.__town.setPropState 应是函数（hud.js 在 debug 下挂）');
  });

  await step(100.1, '强行切四种状态并截图；__town.props 跟着变，forced 为真；解除后回到服务端数据（idle）', async () => {
    for (const st of STATES) {
      await A.page.evaluate(([i, s]) => window.__town.setPropState(i, s), [S1, st]);
      // 状态和 forced 一起等：第一个是 idle，本来就是 idle，只等状态的话会在调试读数（每 100 毫秒推一次）更新之前就过去
      const p = await until(async () => {
        const x = (await propsOf(A.page)).find((y) => y.id === S1);
        return x && x.state === st && x.forced === true ? x : null;
      }, 8000, `${S1} 切到 ${st} 并标 forced`);
      check(p.forced === true, `切到 ${st} 后应标 forced：${JSON.stringify(p)}`);
      check((await propState(A.page, S2)) === 'idle', '另一个灶台不受影响');
      await sleep(400); // 让这一状态至少画出几帧再截图
      await shot(A.page, `100-station-${st}`);
    }
    await A.page.evaluate((i) => window.__town.setPropState(i, ''), S1);
    await until(stateIs(S1, 'idle'), 8000, '解除强行状态后回到 idle');
    check((await propsOf(A.page)).every((p) => !p.forced), '解除后没有 forced');
  });

  await step(100.2, '真实的共同活动：在灶台上做汤，服务端有活动 -> busy；强行状态不被服务端刷新盖回去；结束或离开后回到 idle', async () => {
    await walkTo(A, 47.75, 4.25, 0.5, { avoidDock: true });
    await settle(h, A);
    await A.page.evaluate((oid) => window.__town.act({ type: 'start_interaction', objectId: oid }), S1);
    await until(stateIs(S1, 'busy'), 15_000, '开始做汤后灶台变 busy');
    check((await propState(A.page, S2)) === 'idle', '另一个灶台仍是 idle');
    await shot(A.page, '100-station-real-busy');
    // 强行切到 fault：服务端刷新（活动还在）盖不回去
    await setPropState(A.page, S1, 'fault');
    await until(stateIs(S1, 'fault'), 8000, '强行切到 fault');
    await sleep(1500);
    check((await propState(A.page, S1)) === 'fault', '服务端刷新不应把强行状态盖回去');
    await setPropState(A.page, S1, '');
    await until(stateIs(S1, 'busy'), 8000, '解除后回到服务端数据：活动还在，busy');
    // 离开：回到 idle
    await A.page.evaluate(() => window.__town.act({ type: 'leave_interaction' }));
    await until(stateIs(S1, 'idle'), 20_000 + 300 * 1000 * townParams.interactionTimeScale, '活动结束或离开后回到 idle');
  });

  await step(100.3, '不带 props=sample：__town.props 为空，灶台还是原来的程序模型（地图物件还在）；带 props=sample 但不带 debug=1：一律无视', async () => {
    await loadIn(A, 'debug=1&hour=12');
    await toKitchen();
    await sleep(800);
    check((await propsOf(A.page)).length === 0, `不带 props=sample 时 __town.props 应为空：${JSON.stringify(await propsOf(A.page))}`);
    const ids = await A.page.evaluate(() => window.__town.objects.map((o) => o.id));
    check(ids.includes(S1) && ids.includes(S2), `灶台仍在地图物件里：${JSON.stringify(ids)}`);
    await shot(A.page, '100-station-procedural');
    await loadIn(A, 'props=sample');
    check((await A.page.evaluate(() => window.__town ?? null)) === null, '不带 debug=1 时没有 __town（也就没有 props，样件也不会出现）');
  });

  await h.release(A);
}

// 怎么让它失败（改完记得还原）：
//  - client/town/scripts/prop_state.gd 的 state_for_object 恒返回 idle：100.2「开始做汤后灶台变 busy」红。
//  - client/town/scripts/world.gd 的 sync_object_states 里去掉 `if not _prop_forced.has(oid)`：100.2「服务端刷新不应把强行状态盖回去」红。
//  - client/town/scripts/bridge.gd 里把 props_mode_of 的第一个参数改成恒真：100.3 里不带 props=sample 的那一遍不受影响，
//    但不带 debug=1 的最后一条（__town 应为 null）靠 hud.js 的 DEBUG 开关，和样件无关；这条只证明调试面不外露。
//  - client/town/web/hud.js 的 debugSet 里去掉 setPropState：100 的「setPropState 应是函数」红。
//  - client/town/assets/kits/sample/station_sample/manifest.json 改坏：不影响这个文件（运行时不读清单），由 npm run client:assets:check 红。
