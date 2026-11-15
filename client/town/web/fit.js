/* 版式里的纯函数：不读 DOM、不取时间（时间由调用方传进来）、不用随机数，所以能在 node 里直接单测（client/tests-web/fit.test.mjs，挂在 npm run client:lint 上）。
 *  - visibleRect：整个视口去掉顶栏、面板、底部按钮行、软键盘之后「没被界面盖住的那块」（V1 第一项：镜头往这块的中间让位）；
 *  - keyHintMode：键位提示条放得下哪一版（完整 / 只留按键 / 隐藏），第二项；
 *  - layoutTags：名牌、桌牌、门口牌、物件牌、地点大字的避让与回差，第三项。
 * 浏览器里挂成 window.TownFit；node 里 require 得到同一个对象。所有长度都是 CSS 像素。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TownFit = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ───────────── 没被盖住的那块 ─────────────
   * in: { w, h, topBottom（顶栏下沿）, statusBottom（只读横幅 / 状态条下沿，没有就 0）, bottomTop（底部按钮行最高处的上沿，没有就 Infinity）,
   *       dock: null | { layout: 'side', left } | { layout: 'drawer', top }, kb（软键盘高度） }
   * out: { l, t, r, b }（像素，l <= r、t <= b；盖得一点不剩时 r - l、b - t 为 0） */
  function visibleRect(i) {
    var t = Math.max(i.topBottom || 0, i.statusBottom || 0);
    var b = i.h - (i.kb || 0);
    if (isFinite(i.bottomTop)) b = Math.min(b, i.bottomTop - 4);
    var r = i.w;
    if (i.dock) {
      if (i.dock.layout === 'side') r = Math.min(r, i.dock.left - 8);
      else b = Math.min(b, i.dock.top);
    }
    r = Math.max(0, Math.min(i.w, r));
    b = Math.max(0, Math.min(i.h, b));
    t = Math.max(0, Math.min(t, b));
    return { l: 0, t: t, r: r, b: b };
  }

  /* ───────────── 键位提示条 ─────────────
   * in: { w, h, left, bottom（提示条的左边距、下边距）, sizes: { full: {w, h}, short: {w, h} }, obstacles: [{l,t,r,b}], margin, off（局中等强制隐藏） }
   * out: 'full' | 'short' | 'off'：第一个不碰任何障碍、也整块落在视口里的版本；都放不下就 off。 */
  function rectsHit(a, b, m) {
    return a.l < b.r + m && b.l < a.r + m && a.t < b.b + m && b.t < a.b + m;
  }
  function keyHintMode(i) {
    if (i.off) return 'off';
    var modes = ['full', 'short'];
    var m = i.margin == null ? 4 : i.margin;
    for (var k = 0; k < modes.length; k++) {
      var s = i.sizes[modes[k]];
      if (!s || !(s.w > 0)) continue;
      var r = { l: i.left, t: i.h - i.bottom - s.h, r: i.left + s.w, b: i.h - i.bottom };
      if (r.r > i.w - 8) continue;
      var ok = true;
      for (var j = 0; j < i.obstacles.length; j++) {
        if (rectsHit(r, i.obstacles[j], m)) {
          ok = false;
          break;
        }
      }
      if (ok) return modes[k];
    }
    return 'off';
  }

  /* ───────────── 标签避让 ─────────────
   * 优先级（数字小的先占位）：自己的名牌 0 > 别人的名牌（含 NPC）1 > 功能牌（桌牌 c、游戏桌牌 g）2 > 选中的物件牌 3 > 门口牌 p 4 > 其余物件牌 o 5 > 地点大字 z 6。
   * 名牌和功能牌（0 到 2）是「挪」的：撞上已占位的就往上或往下挪，最多一个牌高加 4 像素，挪了还撞就保持原位，永不隐藏；
   * 3 到 6 是「藏」的：撞上就淡出，让出位置。气泡（b）不参加避让，只当成「挪的时候不许撞上」的障碍。
   * 不闪：
   *   藏起来要相交超过 TOL（2 像素）；再显示要离开 CLEAR（8 像素）以上；一次决定（藏或现）至少保持 HOLD（250 毫秒）；
   *   挪过的牌要等原位置周围 CLEAR 像素都空了才放回去；挪的量用指数趋近（时间常数 0.08 秒），不一帧跳 20 多像素。
   * items: [{ id, k（第一个词：s a npc c g o p z b）, x, y（牌底边中点，像素）, w, h, sel }]
   * st: 每块牌上一次的决定，调用方一直拿着同一个对象（{ [id]: {dy, tdy, hid, at} }）；不在 items 里的 id 会被清掉
   * o: { W, H, top（顶栏下沿）, now（毫秒）, dt（秒）}
   * 返回 out：[{ id, x, y, show }]（顺序和 items 一样；show=false 的牌不画）。 */
  var TOL = 2;
  var CLEAR = 8;
  var HOLD = 250;
  var TAU = 0.08;

  function prioOf(it) {
    switch (it.k) {
      case 's':
        return 0;
      case 'a':
      case 'npc':
        return 1;
      case 'c':
      case 'g':
        return 2;
      case 'o':
        return it.sel ? 3 : 5;
      case 'p':
        return 4;
      case 'z':
        return 6;
      default:
        return -1; // 气泡等：不参加
    }
  }
  function hit(a, b, tol) {
    // 相交深度大于 tol 才算（负的 tol = 要离开这么远才算不相交）
    return a.l < b.r - tol && b.l < a.r - tol && a.t < b.b - tol && b.t < a.b - tol;
  }
  function anyHit(r, list, tol) {
    for (var i = 0; i < list.length; i++) if (hit(r, list[i], tol)) return true;
    return false;
  }
  function shifted(r, dy) {
    return { l: r.l, r: r.r, t: r.t + dy, b: r.b + dy };
  }

  /* 往上或往下挪一小段：挪到刚好不碰挡着它的牌，量不超过 h + 4，挪完不碰任何已占位的牌和气泡，也不出屏；两边都行取挪得少的，一样就往上。找不到返回 0。 */
  function findShift(r0, h, placed, fixed, o) {
    var maxd = h + 4;
    var minTop = Infinity;
    var maxBot = -Infinity;
    for (var i = 0; i < placed.length; i++) {
      var q = placed[i];
      if (hit(r0, q, TOL)) {
        if (q.t < minTop) minTop = q.t;
        if (q.b > maxBot) maxBot = q.b;
      }
    }
    var best = 0;
    var up = -(r0.b - (minTop - 2));
    var dn = maxBot + 2 - r0.t;
    var cand = [];
    if (isFinite(minTop) && -up <= maxd) cand.push(up);
    if (isFinite(maxBot) && dn <= maxd) cand.push(dn);
    cand.sort(function (a, b) {
      var d = Math.abs(a) - Math.abs(b);
      return d !== 0 ? d : a - b; // 一样远：往上（负的）在前
    });
    for (var c = 0; c < cand.length; c++) {
      var r = shifted(r0, cand[c]);
      if (r.t < o.top || r.b > o.H - 2) continue;
      if (anyHit(r, placed, TOL) || anyHit(r, fixed, TOL)) continue;
      best = cand[c];
      break;
    }
    return best;
  }

  var sortBuf = [];
  var placedBuf = [];
  var fixedBuf = [];

  function layoutTags(items, st, o) {
    var out = [];
    var n = items.length;
    var W = o.W;
    var H = o.H;
    var seen = {};
    sortBuf.length = 0;
    placedBuf.length = 0;
    fixedBuf.length = 0;
    var placed = placedBuf;
    var fixed = fixedBuf;
    var base = new Array(n); // 贴边钳进屏幕之后的原位置矩形
    var res = new Array(n);
    for (var i = 0; i < n; i++) {
      var it = items[i];
      seen[it.id] = true;
      var px = it.x;
      var py = it.y;
      var forceHide = false;
      var hideable = it.k === 'p' || it.k === 'z';
      if (hideable) {
        // 贴着顶栏时直接不画，比被按钮遮住好
        if (py - it.h < o.top) forceHide = true;
      } else if (py - it.h < o.top) py = o.top + it.h;
      // 贴着左右边缘时钳进屏幕，整块牌都看得见
      var hw = it.w / 2;
      px = hw * 2 >= W ? W / 2 : Math.max(hw, Math.min(W - hw, px));
      py = Math.min(py, H - 2);
      base[i] = { l: px - hw, r: px + hw, t: py - it.h, b: py };
      res[i] = { id: it.id, x: px, y: py, show: !forceHide };
      var p = prioOf(it);
      sortBuf.push({ i: i, p: p, forceHide: forceHide });
      if (p < 0) fixed.push(base[i]);
    }
    sortBuf.sort(function (a, b) {
      return a.p - b.p || a.i - b.i;
    });
    for (var s = 0; s < sortBuf.length; s++) {
      var e = sortBuf[s];
      if (e.p < 0) continue;
      var it2 = items[e.i];
      var r0 = base[e.i];
      var rs = res[e.i];
      var cur = st[it2.id];
      if (!cur) cur = st[it2.id] = { dy: 0, tdy: 0, hid: false, at: -1e9 };
      if (e.p <= 2) {
        // 挪：永不隐藏
        var tdy = cur.tdy;
        if (tdy !== 0) {
          // 已经挪开了：原位置周围 CLEAR 像素都空了才放回去；否则沿用，沿用的位置不行了就重找
          if (!anyHit(r0, placed, -CLEAR)) tdy = 0;
          else {
            var rr = shifted(r0, tdy);
            if (anyHit(rr, placed, TOL) || anyHit(rr, fixed, TOL)) tdy = findShift(r0, it2.h, placed, fixed, o);
          }
        } else if (anyHit(r0, placed, TOL)) tdy = findShift(r0, it2.h, placed, fixed, o);
        cur.tdy = tdy;
        var k = 1 - Math.exp(-Math.max(0, o.dt) / TAU);
        cur.dy += (tdy - cur.dy) * k;
        if (Math.abs(tdy - cur.dy) < 0.5) cur.dy = tdy;
        rs.y = r0.b + cur.dy;
        placed.push(shifted(r0, tdy));
      } else {
        // 藏：撞上就淡出
        if (e.forceHide) {
          cur.hid = true;
          rs.show = false;
          continue;
        }
        var wantHide = cur.hid;
        if (o.now - cur.at >= HOLD) {
          if (cur.hid) {
            if (!anyHit(r0, placed, -CLEAR)) wantHide = false;
          } else if (anyHit(r0, placed, TOL)) wantHide = true;
        }
        if (wantHide !== cur.hid) {
          cur.hid = wantHide;
          cur.at = o.now;
        }
        rs.show = !cur.hid;
        if (!cur.hid) placed.push(r0);
      }
    }
    for (var j = 0; j < n; j++) out.push(res[j]);
    for (var id in st) if (!seen[id]) delete st[id];
    return out;
  }

  return { visibleRect: visibleRect, keyHintMode: keyHintMode, layoutTags: layoutTags, rectsHit: rectsHit, TOL: TOL, CLEAR: CLEAR, HOLD: HOLD };
});
