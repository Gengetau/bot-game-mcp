// 网页层版式纯函数（client/town/web/fit.js）的单测：node --test，挂在 npm run client:lint 上。
// 不读 DOM、不取时间：时间由测试传进去，所以能精确地推回差。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 仓库是 "type": "module"，.js 会被当成 ESM：fit.js 是给浏览器用的普通脚本，这里像浏览器那样在一个有 self 的上下文里跑它
const sandbox = {};
sandbox.self = sandbox;
vm.runInNewContext(readFileSync(new URL('../town/web/fit.js', import.meta.url), 'utf8'), sandbox);
const F = sandbox.TownFit;

const O = (extra = {}) => ({ W: 400, H: 800, top: 56, now: 1000, dt: 0.05, ...extra });
const tag = (id, k, x, y, w = 60, h = 22, extra = {}) => ({ id, k, x, y, w, h, sel: false, ...extra });
const rectOf = (r, w = 60, h = 22) => ({ l: r.x - w / 2, r: r.x + w / 2, t: r.y - h, b: r.y });
const inter = (a, b, m = 0) => a.l < b.r - m && b.l < a.r - m && a.t < b.b - m && b.t < a.b - m;
const by = (res, id) => res.find((r) => r.id === id);

// ───────────── visibleRect ─────────────

test('visibleRect：什么都没开，只去掉顶栏和底部按钮行', () => {
  const r = F.visibleRect({ w: 1440, h: 900, topBottom: 56, statusBottom: 0, bottomTop: 846, dock: null, kb: 0 });
  assert.equal(JSON.stringify(r), JSON.stringify({ l: 0, t: 56, r: 1440, b: 842 }));
});

test('visibleRect：桌面侧栏盖掉右边', () => {
  const r = F.visibleRect({ w: 1440, h: 900, topBottom: 56, bottomTop: 846, dock: { layout: 'side', left: 1088 }, kb: 0 });
  assert.equal(r.r, 1080);
});

test('visibleRect：手机抽屉盖掉下面（按钮行已被顶到抽屉上沿之上，取更高的那个）', () => {
  const r = F.visibleRect({ w: 390, h: 844, topBottom: 56, bottomTop: 440, dock: { layout: 'drawer', top: 504 }, kb: 0 });
  assert.equal(r.b, 436);
  // 按钮行比抽屉上沿还低（异常）：以抽屉上沿为准
  const r2 = F.visibleRect({ w: 390, h: 844, topBottom: 56, bottomTop: 520, dock: { layout: 'drawer', top: 504 }, kb: 0 });
  assert.equal(r2.b, 504);
});

test('visibleRect：软键盘盖掉底部；情境按钮把下沿再抬高', () => {
  const r = F.visibleRect({ w: 390, h: 844, topBottom: 56, bottomTop: Infinity, dock: { layout: 'drawer', top: 674 }, kb: 300 });
  assert.equal(r.b, 544);
  const r2 = F.visibleRect({ w: 390, h: 844, topBottom: 56, bottomTop: 390, dock: null, kb: 0 });
  assert.equal(r2.b, 386);
});

test('visibleRect：被盖得一点不剩时不出负数、不颠倒', () => {
  const r = F.visibleRect({ w: 300, h: 200, topBottom: 56, bottomTop: 20, dock: { layout: 'side', left: -50 }, kb: 500 });
  assert.ok(r.r >= 0 && r.b >= 0 && r.t <= r.b && r.l <= r.r, JSON.stringify(r));
});

test('visibleRect：状态条比顶栏更低时以状态条为准', () => {
  const r = F.visibleRect({ w: 1000, h: 800, topBottom: 56, statusBottom: 120, bottomTop: 740, dock: null, kb: 0 });
  assert.equal(r.t, 120);
});

// ───────────── keyHintMode ─────────────

const sizes = { full: { w: 425, h: 30 }, short: { w: 200, h: 30 } };
const base = { w: 1440, h: 900, left: 12, bottom: 14, sizes, obstacles: [], margin: 4, off: false };

test('keyHintMode：没有障碍就是完整版', () => {
  assert.equal(F.keyHintMode(base), 'full');
});
test('keyHintMode：完整版压到按钮行，换成只留按键的短版；短版也压就隐藏', () => {
  const controls = { l: 285, t: 846, r: 615, b: 886 };
  assert.equal(F.keyHintMode({ ...base, w: 901, obstacles: [controls] }), 'short');
  assert.equal(F.keyHintMode({ ...base, w: 901, obstacles: [{ l: 100, t: 846, r: 615, b: 886 }] }), 'off');
});
test('keyHintMode：留 4 像素的缝', () => {
  // 完整版右沿 437；障碍左沿 440 距离 3 < 4：算相交
  const ob = { l: 440, t: 846, r: 700, b: 886 };
  assert.equal(F.keyHintMode({ ...base, obstacles: [ob] }), 'short');
  assert.equal(F.keyHintMode({ ...base, obstacles: [{ ...ob, l: 441 }] }), 'full');
});
test('keyHintMode：局中强制隐藏；视口太窄放不下也隐藏', () => {
  assert.equal(F.keyHintMode({ ...base, off: true }), 'off');
  assert.equal(F.keyHintMode({ ...base, w: 200 }), 'off');
});
test('keyHintMode：侧栏盖住的右边也是障碍', () => {
  assert.equal(F.keyHintMode({ ...base, w: 1000, obstacles: [{ l: 400, t: 0, r: 1000, b: 900 }] }), 'short');
});

// ───────────── layoutTags ─────────────

test('名牌：两块重叠，后一块往上挪且不出屏、不超过一个牌高加 4', () => {
  const st = {};
  const res = F.layoutTags([tag('a', 's', 200, 400), tag('b', 'a', 210, 405)], st, O());
  assert.equal(by(res, 'a').y, 400);
  let r = res;
  for (let i = 0; i < 40; i++) r = F.layoutTags([tag('a', 's', 200, 400), tag('b', 'a', 210, 405)], st, O({ now: 1100 + i * 50 }));
  const b = by(r, 'b');
  assert.ok(!inter(rectOf(by(r, 'a')), rectOf(b)), '两块不相交');
  assert.ok(Math.abs(b.y - 405) <= 22 + 4, `挪动量 ${b.y - 405}`);
  assert.ok(b.y - 22 >= 56 && b.y <= 798, '不出屏');
  assert.equal(b.show, true, '名牌永不隐藏');
});

test('名牌：挪不开就保持原位或只挪一小段，永不隐藏', () => {
  const items = [tag('a', 's', 200, 300), tag('c', 'a', 200, 322), tag('b', 'a', 200, 344), tag('d', 'a', 200, 311)];
  const st = {};
  let r;
  for (let i = 0; i < 40; i++) r = F.layoutTags(items, st, O({ now: 1000 + i * 50 }));
  for (const x of r) assert.equal(x.show, true);
  for (const it of items) assert.ok(Math.abs(by(r, it.id).y - it.y) <= 26.01, `${it.id} 偏移 ${by(r, it.id).y - it.y}`);
});

test('名牌压门口牌：门口牌隐藏，名牌不动', () => {
  const st = {};
  const items = [tag('me', 's', 200, 400, 80, 22), tag('p:出口', 'p', 205, 410, 50, 20)];
  const r = F.layoutTags(items, st, O());
  assert.equal(by(r, 'p:出口').show, false);
  assert.equal(by(r, 'me').y, 400);
  assert.equal(by(r, 'me').show, true);
});

test('门口牌、物件牌、地点大字：按优先级互相让位', () => {
  const st = {};
  const items = [
    tag('z:广场', 'z', 200, 300, 100, 24),
    tag('o:椅', 'o', 200, 296, 40, 20),
    tag('p:门', 'p', 200, 292, 40, 20),
    tag('o:选中', 'o', 200, 288, 40, 20, { sel: true }),
  ];
  const r = F.layoutTags(items, st, O());
  assert.equal(by(r, 'o:选中').show, true);
  assert.equal(by(r, 'p:门').show, false);
  assert.equal(by(r, 'o:椅').show, false);
  assert.equal(by(r, 'z:广场').show, false);
});

test('优先级的次序：门口牌高于普通物件牌，物件牌高于地点大字', () => {
  const st = {};
  const r = F.layoutTags([tag('o:椅', 'o', 200, 296, 40, 20), tag('p:门', 'p', 200, 292, 40, 20)], st, O());
  assert.equal(by(r, 'p:门').show, true);
  assert.equal(by(r, 'o:椅').show, false);
  const st2 = {};
  const r2 = F.layoutTags([tag('z:广场', 'z', 200, 300, 100, 24), tag('o:椅', 'o', 200, 296, 40, 20)], st2, O());
  assert.equal(by(r2, 'o:椅').show, true);
  assert.equal(by(r2, 'z:广场').show, false);
});

test('功能牌（桌牌）压在名牌上：功能牌挪，名牌不动', () => {
  const st = {};
  let r;
  for (let i = 0; i < 40; i++) r = F.layoutTags([tag('b', 'a', 200, 400, 70, 22), tag('c:桌', 'c', 205, 404, 60, 22)], st, O({ now: 1000 + i * 50 }));
  assert.equal(by(r, 'b').y, 400);
  assert.ok(!inter(rectOf(by(r, 'b'), 70), rectOf(by(r, 'c:桌'), 60)));
  assert.equal(by(r, 'c:桌').show, true);
});

test('NPC 的名牌和别人的名牌同级（k 的第一个词是 npc）', () => {
  const st = {};
  let r;
  for (let i = 0; i < 40; i++) r = F.layoutTags([tag('n1', 'npc', 200, 400, 70, 22), tag('b', 'a', 205, 404, 60, 22)], st, O({ now: 1000 + i * 50 }));
  assert.equal(by(r, 'n1').y, 400, '同级按顺序：先到的不动');
  assert.ok(!inter(rectOf(by(r, 'n1'), 70), rectOf(by(r, 'b'), 60)));
});

test('回差：藏起来之后，边界上来回 1 像素不翻转', () => {
  const st = {};
  const me = tag('me', 's', 200, 400, 80, 22); // 矩形 160..240 x 378..400
  let t = 1000;
  const frame = (px) => {
    t += 300; // 每帧间隔超过 HOLD，回差只由距离决定
    return by(F.layoutTags([me, tag('p', 'p', px, 395, 40, 20)], st, O({ now: t })), 'p').show;
  };
  assert.equal(frame(240 + 20 - 5), false, '相交 5px：藏');
  assert.equal(frame(240 + 20 - 1), false, '相交 1px：仍藏（要离开 8px 才回来）');
  assert.equal(frame(240 + 20 + 1), false, '刚离开 1px：仍藏');
  assert.equal(frame(240 + 20 + 7), false, '离开 7px：仍藏');
  assert.equal(frame(240 + 20 + 9), true, '离开 9px：回来');
  assert.equal(frame(240 + 20 - 1), true, '相交 1px：不藏');
  assert.equal(frame(240 + 20 - 2.5), false, '相交 2.5px：藏');
  // 从显示态出发，深度在 2 像素以内来回抖，一直显示
  const st2 = {};
  t = 1000;
  const seq = [1.5, 1.0, 1.9, 1.2, 1.9].map((d) => by(F.layoutTags([me, tag('p', 'p', 240 + 20 - d, 395, 40, 20)], st2, O({ now: (t += 300) })), 'p').show);
  assert.equal(seq.join(), 'true,true,true,true,true');
});

test('回差：一次决定至少保持 250 毫秒', () => {
  const st = {};
  const me = tag('me', 's', 200, 400, 80, 22);
  const at = (now, px) => by(F.layoutTags([me, tag('p', 'p', px, 395, 40, 20)], st, O({ now })), 'p').show;
  assert.equal(at(1000, 400), true);
  assert.equal(at(1010, 255), false, '第一次决定：马上藏（之前没有决定）');
  assert.equal(at(1100, 300), false, '100 毫秒后已经离开很远，但还在保持期内');
  assert.equal(at(1300, 300), true, '超过 250 毫秒：回来');
  assert.equal(at(1320, 255), true, '刚回来：20 毫秒后又相交，保持期内不藏');
  assert.equal(at(1600, 255), false, '过了保持期：藏');
});

test('名牌的挪动有回差：两个人并排走时不上下跳', () => {
  const st = {};
  let t = 1000;
  const a = tag('a', 's', 200, 400, 70, 22);
  const ys = [];
  // B 在 A 右边来回晃：重叠深度在 1 到 6 像素之间抖动
  for (let i = 0; i < 80; i++) {
    const jitter = [3, 5, 1, 6, 4, 2, 5, 1][i % 8];
    const bx = 270 - jitter; // A 右沿 235；B 宽 70，B 左沿 = 235 - jitter，所以中心 = 270 - jitter
    t += 50;
    const r = F.layoutTags([a, tag('b', 'a', bx, 400, 70, 22)], st, O({ now: t, dt: 0.05 }));
    ys.push(by(r, 'b').y);
  }
  assert.notEqual(st.b.tdy, 0);
  const late = ys.slice(20);
  assert.ok(Math.max(...late) - Math.min(...late) < 1, `后 60 帧纵向位置的波动 ${Math.max(...late) - Math.min(...late)}`);
});

test('挪动不一帧跳：指数趋近', () => {
  const st = {};
  const items = [tag('a', 's', 200, 400), tag('b', 'a', 210, 405)];
  const r1 = F.layoutTags(items, st, O({ dt: 0.016 }));
  assert.ok(Math.abs(by(r1, 'b').y - 405) < 8, '第一帧只走了一小段');
  assert.notEqual(st.b.tdy, 0);
});

test('贴边：整块钳进屏幕；比屏幕还宽的牌居中', () => {
  const st = {};
  const r = F.layoutTags([tag('z:左', 'z', 5, 300, 100, 24), tag('z:右', 'z', 395, 300, 100, 24), tag('z:宽', 'z', 100, 500, 500, 24)], st, O());
  assert.equal(by(r, 'z:左').x, 50);
  assert.equal(by(r, 'z:右').x, 350);
  assert.equal(by(r, 'z:宽').x, 200);
});

test('贴着顶栏的地点大字和门口牌不画；名牌被推到顶栏之下', () => {
  const st = {};
  const r = F.layoutTags([tag('z:x', 'z', 200, 60, 100, 24), tag('p:y', 'p', 100, 70, 40, 20), tag('n', 'a', 300, 40, 60, 22)], st, O());
  assert.equal(by(r, 'z:x').show, false);
  assert.equal(by(r, 'p:y').show, false);
  assert.equal(by(r, 'n').show, true);
  assert.equal(by(r, 'n').y, 56 + 22);
});

test('气泡不参加避让：不被挪、不被藏；名牌的挪动不许撞上气泡', () => {
  const st = {};
  const bubble = tag('b:1', 'b', 200, 372, 100, 30); // 在 A 的名牌正上方
  let r;
  for (let i = 0; i < 40; i++) r = F.layoutTags([tag('a', 's', 200, 400), tag('n', 'a', 210, 404), bubble], st, O({ now: 1000 + i * 50 }));
  assert.equal(by(r, 'b:1').show, true);
  assert.equal(by(r, 'b:1').y, 372);
  const nb = rectOf(by(r, 'n'));
  assert.ok(!inter(nb, { l: 150, r: 250, t: 342, b: 372 }), '名牌没有挪进气泡里');
  assert.ok(!inter(nb, rectOf(by(r, 'a'))), '也没有压着 A');
});

test('不在这一帧里的牌，状态被清掉', () => {
  const st = {};
  F.layoutTags([tag('a', 's', 100, 300), tag('b', 'a', 105, 302)], st, O());
  assert.ok(st.a && st.b);
  F.layoutTags([tag('a', 's', 100, 300)], st, O());
  assert.ok(st.a && !st.b);
});

test('性能：一屏 40 块牌，每帧不到 5 毫秒（宽松上限）', () => {
  const st = {};
  const items = [];
  for (let i = 0; i < 40; i++) {
    const k = ['s', 'a', 'a', 'c', 'o', 'p', 'z', 'a'][i % 8];
    items.push(tag(`t${i}`, k, 100 + ((i * 37) % 200), 150 + ((i * 53) % 500), 40 + (i % 5) * 12, 22));
  }
  F.layoutTags(items, st, O()); // 预热
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) F.layoutTags(items, st, O({ now: 2000 + i * 16 }));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(ms < 5, `每帧 ${ms.toFixed(3)} 毫秒`);
});
