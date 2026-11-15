/* 版式控制器（V1）：版式一变化就量一次界面各块的位置，只做两件事：
 *  1. 算出「没被界面盖住的那块」（fit.js 的 visibleRect），归一化后经 ui 事件 'view' 发给 Godot，镜头据此让自己的角色站在那块的中间偏下；
 *  2. 决定左下角的键位提示条放哪一版（完整 / 只留按键 / 隐藏），写在 #keyHint 的 data-mode 上。
 * 触发：invalidate()（dock.js、hud.js、模块在版式变了的时候调）、窗口尺寸、visualViewport、几块关键元素的 ResizeObserver、body 上几个状态属性的 MutationObserver。
 * 全部合并到一个 90 毫秒的定时器里，一次最多量一回；量完和上次发出的一样就不发。不在每帧路径上：站着不动时一次布局读取都没有。 */
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };
  var DEBUG = /[?&]debug=1(&|$)/.test(location.search);
  var DELAY = 90;
  var timer = 0;
  var lastSent = '';
  var sent = 0; // 发给 Godot 的版式消息条数（?debug=1 的 __town.layout 里读）
  var passes = 0;
  var lastRect = null;
  var lastMode = '';

  function shown(el) {
    return !!el && !el.hidden && el.offsetHeight > 0 && el.offsetWidth > 0;
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  }
  function playing() {
    return document.body.getAttribute('data-phase') === 'playing';
  }

  /* 键位提示条：量两版的尺寸（只在这里量），连同障碍交给 fit.js 选 */
  function fitKeyHint(W, H, obstacles) {
    var el = $('keyHint');
    if (!el) return;
    var inGame = document.body.getAttribute('data-game') === '1';
    if (el.hidden) {
      setMode(el, 'off');
      return;
    }
    var cs = getComputedStyle(el);
    var left = parseFloat(cs.left) || 12;
    var bottom = parseFloat(cs.bottom) || 14;
    var sizes = {};
    ['full', 'short'].forEach(function (m) {
      el.setAttribute('data-mode', m);
      sizes[m] = { w: el.offsetWidth, h: el.offsetHeight };
    });
    var mode = window.TownFit.keyHintMode({ w: W, h: H, left: left, bottom: bottom, sizes: sizes, obstacles: obstacles, margin: 4, off: inGame });
    setMode(el, mode);
  }
  function setMode(el, mode) {
    lastMode = mode;
    if (el.getAttribute('data-mode') !== mode) el.setAttribute('data-mode', mode);
  }

  function measure() {
    timer = 0;
    passes++;
    var hud = $('hud');
    var W = hud.clientWidth;
    var H = hud.clientHeight;
    if (W < 2 || H < 2) return;
    var dock = $('dock');
    var dockOpen = !!(window.TownDock && window.TownDock.isOpen && window.TownDock.isOpen()) && playing() && !dock.hidden;
    var layout = document.body.getAttribute('data-dock') === 'side' ? 'side' : 'drawer';
    // 面板的位置用 offsetLeft / offsetTop（布局位置，不含进场动画的 transform），不然开关面板的那 0.18 秒里量到的是半路上的数
    var dockIn = dockOpen ? (layout === 'side' ? { layout: 'side', left: dock.offsetLeft } : { layout: 'drawer', top: dock.offsetTop }) : null;
    var kb = window.TownDock && window.TownDock.kbHeight ? window.TownDock.kbHeight() : 0;

    // 顶部：顶栏、只读横幅、状态条（提示条 #toasts 是一闪而过的，不算，免得每条提示都让镜头动一下）
    var topBottom = $('topbar').getBoundingClientRect().bottom + 4;
    var statusBottom = 0;
    ['readonly', 'statusRow'].forEach(function (id) {
      var e = $(id);
      if (shown(e)) statusBottom = Math.max(statusBottom, e.getBoundingClientRect().bottom + 4);
    });
    // 底部：情境按钮（#actions）和 停下 / 回家 / 地点 / 聊天（#controls）。地点菜单（#destMenu）是点开才有的小菜单，不算
    var bottomTop = Infinity;
    var obstacles = [];
    ['actions', 'controls'].forEach(function (id) {
      var e = $(id);
      if (shown(e)) {
        var r = rectOf(e);
        bottomTop = Math.min(bottomTop, r.t);
        obstacles.push(r);
      }
    });
    var vr = window.TownFit.visibleRect({ w: W, h: H, topBottom: topBottom, statusBottom: statusBottom, bottomTop: bottomTop, dock: dockIn, kb: kb });
    lastRect = vr;

    if (playing()) {
      var msg = JSON.stringify({ l: +(vr.l / W).toFixed(4), t: +(vr.t / H).toFixed(4), r: +(vr.r / W).toFixed(4), b: +(vr.b / H).toFixed(4), w: W, h: H });
      if (msg !== lastSent) {
        lastSent = msg;
        sent++;
        if (window.TownHost) window.TownHost.emit('ui', 'view', msg);
      }
    }

    // 键位提示条的障碍：按钮行（上面已加）、地点菜单、面板、状态条、提示条、浮层卡（游戏面板、居民卡、NPC 菜单）
    var extra = ['destMenu', 'readonly', 'statusRow', 'toasts'];
    extra.forEach(function (id) {
      var e = $(id);
      if (shown(e)) obstacles.push(rectOf(e));
    });
    if (dockIn) obstacles.push(layout === 'side' ? { l: dockIn.left, t: 0, r: W, b: H } : { l: 0, t: dockIn.top, r: W, b: H });
    var ov = $('dockOverlays');
    if (ov) for (var i = 0; i < ov.children.length; i++) if (shown(ov.children[i])) obstacles.push(rectOf(ov.children[i]));
    fitKeyHint(W, H, obstacles);
  }

  function invalidate(now) {
    if (timer) {
      if (!now) return;
      clearTimeout(timer);
    }
    timer = setTimeout(measure, now ? 0 : DELAY);
  }

  window.addEventListener('resize', function () {
    invalidate();
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      invalidate();
    });
  }
  if (window.ResizeObserver) {
    try {
      var ro = new ResizeObserver(function () {
        invalidate();
      });
      ['topbar', 'stack', 'bottombar', 'actions', 'controls', 'dock', 'dockOverlays'].forEach(function (id) {
        if ($(id)) ro.observe($(id));
      });
    } catch (e) {
      /* ignore */
    }
  }
  if (window.MutationObserver) {
    try {
      new MutationObserver(function () {
        invalidate();
      }).observe(document.body, { attributes: true, attributeFilter: ['data-phase', 'data-dock', 'data-dock-open', 'data-kb', 'data-game'] });
      // 浮层卡（游戏面板、居民卡、NPC 菜单）出现、消失、换位置：提示条要重新选
      new MutationObserver(function () {
        invalidate();
      }).observe($('dockOverlays'), { attributes: true, childList: true, subtree: true, attributeFilter: ['hidden', 'class'] });
      new MutationObserver(function () {
        invalidate();
      }).observe($('keyHint'), { attributes: true, attributeFilter: ['hidden'] });
    } catch (e) {
      /* ignore */
    }
  }

  window.TownLayout = {
    invalidate: invalidate,
    /* 进入小镇（phase 变成 playing）：把上一次发出的清掉，保证新一轮的第一条版式消息一定发出（重新登录后目标点复位） */
    reset: function () {
      lastSent = '';
      invalidate(true);
    },
    debug: function () {
      return { sent: sent, passes: passes, rect: lastRect, hintMode: lastMode };
    },
  };
  if (DEBUG) window.TownLayoutDebug = window.TownLayout.debug;
  invalidate();
})();
