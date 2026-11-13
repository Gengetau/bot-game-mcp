/* 面板底座：一个叠在画布上的「纸与木牌」面板，里面按页签装各个功能模块（web/mod/*.js，导出时合并成 town-modules.js）。
 *  - 模块用 TownDock.register({id, api, mount}) 注册；Godot 经 TownHud.feed(id, kind, json) 往模块推数据，模块经 host.emit 发 ui 事件回去。
 *  - 键盘规则（Enter 打开、输入框里 Enter 发送、Esc 先失焦再关面板）、手机软键盘、未读角标都集中在这里和 host.wireInput。
 *  - 整页没有内联脚本；玩家提供的文字一律 textContent。聊天内容只放内存。
 * 本文件由 C1a 拥有并冻结：后续功能只加 web/mod/ 下的新文件。 */
(function () {
  'use strict';
  var API_VERSION = 1;
  var PROTOCOL = 2;
  var DEBUG = /[?&]debug=1(&|$)/.test(location.search);
  var $ = function (id) {
    return document.getElementById(id);
  };
  var dock = $('dock');
  var btn = $('dockBtn');
  if (!dock || !btn) {
    console.error('[dock] 缺少 #dock / #dockBtn');
    return;
  }

  /* ── 本机存储：只放界面偏好（开关、最后页签）；读写都包 try/catch ── */
  function lsGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function lsSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      /* ignore */
    }
  }

  var mods = {}; // id -> {id, order, label, def, host, inst, tab, pane, unread}
  var order = []; // 按 data-order 排好的 id
  var queue = {}; // id -> [[kind, json]]（模块还没注册时先排队）
  var warned = {};
  var core = { phase: '', conn: '', mine: true };
  var isOpen = false;
  var wantOpen = lsGet('town3d.dock') === '1';
  var savedTab = lsGet('town3d.dockTab') || '';
  var activeId = '';
  var layout = 'drawer';
  var kb = 0;
  var testKb = null;
  var baseTitle = document.title;

  /* ── 布局：side（桌面侧栏 / 横屏小高度）或 drawer（手机抽屉） ── */
  var mqSide = window.matchMedia ? window.matchMedia('(min-width: 1100px) and (pointer: fine), (orientation: landscape) and (max-height: 520px)') : null;
  function computeLayout() {
    var side = mqSide ? mqSide.matches : window.innerWidth >= 1100;
    var l = side ? 'side' : 'drawer';
    if (l !== layout || document.body.getAttribute('data-dock') !== l) {
      layout = l;
      document.body.setAttribute('data-dock', l);
      measure();
    }
  }
  if (mqSide) {
    if (mqSide.addEventListener) mqSide.addEventListener('change', computeLayout);
    else if (mqSide.addListener) mqSide.addListener(computeLayout);
  }
  window.addEventListener('resize', computeLayout);
  window.addEventListener('orientationchange', computeLayout);

  /* ── 抽屉高度 -> --dock-h：让「停下 / 回家 / 地点 / 聊天」整体顶到抽屉上沿之上 ── */
  var measureQueued = false;
  function measure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(function () {
      measureQueued = false;
      var h = 0;
      if (isOpen && layout === 'drawer') h = dock.offsetHeight + kb;
      document.documentElement.style.setProperty('--dock-h', h + 'px');
    });
  }
  if (window.ResizeObserver) {
    try {
      new ResizeObserver(measure).observe(dock);
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 软键盘：visualViewport 算出键盘高度，写 --kb / --vvh；小于 80px 当成地址栏抖动忽略 ── */
  var kbQueued = false;
  function inDockInput() {
    var a = document.activeElement;
    return !!(a && a.tagName && /^(input|textarea)$/i.test(a.tagName) && dock.contains(a));
  }
  function applyKb(px) {
    var v = px >= 80 ? Math.round(px) : 0;
    if (v === kb && document.body.getAttribute('data-kb') === (v ? '1' : '0')) return;
    kb = v;
    var root = document.documentElement.style;
    root.setProperty('--kb', kb + 'px');
    if (kb) {
      var vv = window.visualViewport;
      root.setProperty('--vvh', (vv ? Math.round(vv.height) : window.innerHeight - kb) + 'px');
    } else {
      root.removeProperty('--vvh');
    }
    document.body.setAttribute('data-kb', kb ? '1' : '0');
    if (kb) {
      /* iOS 会把整个视觉视口顶上去：拉回来 */
      try {
        window.scrollTo(0, 0);
      } catch (e) {
        /* ignore */
      }
    }
    measure();
  }
  function recomputeKb() {
    kbQueued = false;
    if (testKb !== null) {
      applyKb(testKb);
      return;
    }
    var vv = window.visualViewport;
    if (!vv || !inDockInput()) {
      applyKb(0);
      return;
    }
    applyKb(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
  }
  function queueKb() {
    if (kbQueued) return;
    kbQueued = true;
    requestAnimationFrame(recomputeKb);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', queueKb);
    window.visualViewport.addEventListener('scroll', queueKb);
  }
  document.addEventListener('focusin', queueKb);
  document.addEventListener('focusout', function () {
    setTimeout(queueKb, 0);
  });

  /* ── 开 / 关 ── */
  var closeTimer = 0;
  function playing() {
    return core.phase === 'playing';
  }
  function visible() {
    return document.visibilityState === 'visible';
  }
  function activeMod() {
    return mods[activeId] || null;
  }
  function render() {
    var show = isOpen && playing();
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    btn.classList.toggle('on', show);
    document.body.setAttribute('data-dock-open', show ? '1' : '0');
  }
  function callMod(m, fn, a, b) {
    if (!m || !m.inst || typeof m.inst[fn] !== 'function') return undefined;
    try {
      return m.inst[fn](a, b);
    } catch (e) {
      console.error('[dock] 模块 ' + m.id + '.' + fn + ' 出错', e);
      return undefined;
    }
  }
  function open(opts) {
    opts = opts || {};
    if (!playing()) return;
    wantOpen = true;
    lsSet('town3d.dock', '1');
    if (!isOpen) {
      isOpen = true;
      clearTimeout(closeTimer);
      dock.hidden = false;
      dock.classList.remove('out');
      /* 下一帧再加 in，进场动画才会播 */
      requestAnimationFrame(function () {
        dock.classList.add('in');
      });
      render();
      measure();
      callMod(activeMod(), 'onShow');
    }
    if (opts.focus) focusActive();
  }
  function close() {
    wantOpen = false;
    lsSet('town3d.dock', '0');
    if (!isOpen) return;
    var a = document.activeElement;
    if (a && dock.contains(a) && a.blur) a.blur();
    isOpen = false;
    callMod(activeMod(), 'onHide');
    dock.classList.remove('in');
    dock.classList.add('out');
    render();
    measure();
    applyKb(0);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () {
      if (!isOpen) {
        dock.hidden = true;
        dock.classList.remove('out');
      }
    }, 140);
  }
  function focusActive() {
    var m = activeMod();
    if (!m) return;
    var el = m.pane.querySelector('[data-focus]');
    if (el && !el.disabled) {
      try {
        el.focus({ preventScroll: true });
      } catch (e) {
        el.focus();
      }
    }
  }
  function setActive(id) {
    if (!mods[id] || id === activeId) return;
    var prev = activeMod();
    if (prev) {
      callMod(prev, 'onHide');
      prev.pane.hidden = true;
      prev.tab.setAttribute('aria-selected', 'false');
      prev.tab.classList.remove('sel');
    }
    activeId = id;
    lsSet('town3d.dockTab', id);
    var m = mods[id];
    m.pane.hidden = false;
    m.tab.setAttribute('aria-selected', 'true');
    m.tab.classList.add('sel');
    if (isOpen) callMod(m, 'onShow');
  }
  btn.addEventListener('click', function () {
    if (isOpen) close();
    else open({ focus: !('ontouchstart' in window) });
  });
  $('dockClose').addEventListener('click', close);

  /* 把手：点击关闭，下拉超过 40px 关闭（pointer 事件；把手 touch-action:none） */
  (function () {
    var grip = $('dockGrip');
    var y0 = null;
    grip.addEventListener('pointerdown', function (e) {
      y0 = e.clientY;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    grip.addEventListener('pointermove', function (e) {
      if (y0 !== null && e.clientY - y0 > 40) {
        y0 = null;
        close();
      }
    });
    grip.addEventListener('pointerup', function (e) {
      if (y0 !== null && Math.abs(e.clientY - y0) < 8) close();
      y0 = null;
    });
    grip.addEventListener('pointercancel', function () {
      y0 = null;
    });
  })();

  /* ── 汇总未读 ── */
  var lastUnread = -1;
  function totalUnread() {
    var n = 0;
    for (var id in mods) n += mods[id].unread || 0;
    return n;
  }
  function renderUnread() {
    var n = totalUnread();
    if (n === lastUnread) return;
    lastUnread = n;
    var badge = btn.querySelector('.dock-badge');
    badge.hidden = n <= 0;
    badge.textContent = n > 9 ? '9+' : String(n);
    var lab = n > 0 ? (btn.getAttribute('data-label-unread') || '').replace('{n}', String(n)) : btn.getAttribute('data-label') || '';
    if (lab) btn.setAttribute('aria-label', lab);
    if (n > 0) {
      badge.classList.remove('pop');
      void badge.offsetWidth;
      badge.classList.add('pop');
    }
    renderTitle();
  }
  function renderTitle() {
    var n = totalUnread();
    document.title = n > 0 && !visible() ? '(' + n + ') ' + baseTitle : baseTitle;
  }
  document.addEventListener('visibilitychange', function () {
    renderTitle();
    if (visible() && isOpen) callMod(activeMod(), 'onShow');
  });

  /* ── 注册 ── */
  function register(def) {
    if (!def || !def.id) {
      console.error('[dock] 注册缺少 id');
      return;
    }
    if (def.api !== API_VERSION) {
      console.error('[dock] 模块 ' + def.id + ' 的 api ' + def.api + ' 与底座 ' + API_VERSION + ' 不一致，已跳过');
      return;
    }
    if (mods[def.id]) {
      console.error('[dock] 模块 ' + def.id + ' 重复注册');
      return;
    }
    var tpl = document.querySelector('template[data-mod="' + def.id + '"]');
    if (!tpl) {
      console.error('[dock] 找不到模块 ' + def.id + ' 的模板');
      return;
    }
    var slot = tpl.getAttribute('data-slot');
    var frag = tpl.content.cloneNode(true);
    var root;
    if (slot === 'controls' || slot === 'topbar') {
      root = document.createElement('div');
      root.className = 'dock-slot';
      root.setAttribute('data-pane', def.id);
      root.appendChild(frag);
      var holder = $(slot === 'controls' ? 'controls' : 'topbar');
      holder.appendChild(root);
    } else {
      root = frag.querySelector('.dock-pane') || document.createElement('section');
      if (!root.classList.contains('dock-pane')) root.classList.add('dock-pane');
      if (!root.parentNode) root.appendChild(frag);
      root.setAttribute('data-pane', def.id);
      root.setAttribute('role', 'tabpanel');
    }
    var m = { id: def.id, def: def, pane: root, unread: 0, label: tpl.getAttribute('data-tab-label') || def.id, order: Number(tpl.getAttribute('data-order')) || 100, layout: tpl.getAttribute('data-layout') || 'tab', slot: slot || '' };
    var host = makeHost(m);
    m.host = host;
    mods[def.id] = m;
    if (!m.slot) {
      var parent = m.layout === 'overlay' ? $('dockOverlays') : $('dockBody');
      root.hidden = true;
      parent.appendChild(root);
      if (m.layout !== 'overlay') {
        order.push(def.id);
        order.sort(function (x, y) {
          return mods[x].order - mods[y].order;
        });
        buildTabs();
        /* 记住的页签优先；否则（当前没有有效页签时）用排在最前的 */
        if (def.id === savedTab) activeId = def.id;
        else if (!mods[activeId] || order.indexOf(activeId) < 0) activeId = order[0];
        showOnly(activeId);
      }
    }
    try {
      m.inst = def.mount(host) || {};
    } catch (e) {
      console.error('[dock] 模块 ' + def.id + ' mount 出错', e);
      m.inst = {};
    }
    /* 补发排队的消息，再把当前核心状态告诉它 */
    var q = queue[def.id];
    if (q) {
      delete queue[def.id];
      q.forEach(function (it) {
        deliver(m, it[0], it[1]);
      });
    }
    callMod(m, 'onCore', core, { phase: 1, conn: 1, mine: 1 });
  }
  function showOnly(id) {
    order.forEach(function (oid) {
      var mm = mods[oid];
      var on = oid === id;
      mm.pane.hidden = !on;
      mm.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      mm.tab.classList.toggle('sel', on);
    });
  }
  function buildTabs() {
    var box = $('dockTabs');
    box.textContent = '';
    box.setAttribute('data-count', String(order.length));
    order.forEach(function (id) {
      var m = mods[id];
      var t = document.createElement('button');
      t.type = 'button';
      t.className = 'dock-tab';
      t.setAttribute('role', 'tab');
      t.setAttribute('data-tab', id);
      var lab = document.createElement('span');
      lab.textContent = m.label;
      t.appendChild(lab);
      var dot = document.createElement('i');
      dot.className = 'tab-dot';
      dot.hidden = true;
      t.appendChild(dot);
      t.addEventListener('click', function () {
        setActive(id);
        focusActive();
      });
      m.tab = t;
      box.appendChild(t);
    });
  }

  /* ── host 对象 ── */
  function makeHost(m) {
    var host = {
      id: m.id,
      root: m.pane,
      q: function (sel) {
        return m.pane.querySelector(sel);
      },
      t: function (key, vars) {
        var bank = m.pane.querySelector('[data-bank]');
        var el = bank ? bank.querySelector('[data-t="' + key + '"]') : null;
        var s = el ? el.textContent : '';
        if (vars) for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
        return s;
      },
      emit: function (name, arg) {
        if (window.TownHost) window.TownHost.emit('ui', m.id + '.' + name, arg === undefined ? '' : String(arg));
      },
      setUnread: function (n) {
        n = Math.max(0, n | 0);
        if (n === m.unread) return;
        m.unread = n;
        if (m.tab) {
          var d = m.tab.querySelector('.tab-dot');
          d.hidden = n <= 0;
        }
        renderUnread();
      },
      isActive: function () {
        return isOpen && playing() && activeId === m.id && visible();
      },
      open: function (opts) {
        if (!m.slot && m.layout === 'tab') setActive(m.id);
        open(opts);
      },
      close: close,
      wireInput: function (el, o) {
        return wireInput(el, o);
      },
      core: function () {
        return core;
      },
      toast: function (text, kind) {
        if (window.TownHud) window.TownHud.toast(text, kind);
      },
      freeRect: freeRect,
    };
    return host;
  }
  function freeRect() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (!isOpen || !playing()) return { l: 0, t: 0, r: w, b: h };
    var r = dock.getBoundingClientRect();
    if (layout === 'side') return { l: 0, t: 0, r: Math.min(w, r.left), b: h };
    return { l: 0, t: 0, r: w, b: Math.min(h, r.top) };
  }

  /* ── 输入框的统一键盘规则 ── */
  var lastCompEnd = 0;
  var desktop = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  function wireInput(el, o) {
    var form = el.closest ? el.closest('form') : null;
    var hist = []; // 最近发过的话（只在内存，最多 5 条）
    var hpos = -1;
    var busy = false;
    function trySend() {
      var text = el.value.trim();
      if (!text) {
        el.blur();
        return;
      }
      if (busy) return;
      if (o.canSend && !o.canSend()) return;
      hist.unshift(text);
      if (hist.length > 5) hist.pop();
      hpos = -1;
      o.onSend(text);
    }
    el.addEventListener('compositionend', function () {
      lastCompEnd = Date.now();
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229 || Date.now() - lastCompEnd < 30) return;
        e.preventDefault();
        trySend();
      } else if (e.key === 'Escape') {
        /* 只失焦（WASD 马上恢复），不关面板；失焦后再按 Esc 才由 hud.js 问 TownDock.escape() */
        e.preventDefault();
        el.blur();
      } else if (e.key === 'ArrowUp' && !e.isComposing) {
        if (hist.length && hpos < hist.length - 1) {
          e.preventDefault();
          hpos++;
          el.value = hist[hpos];
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else if (e.key === 'ArrowDown' && !e.isComposing) {
        if (hpos >= 0) {
          e.preventDefault();
          hpos--;
          el.value = hpos >= 0 ? hist[hpos] : '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
    /* 表单提交：无条件 preventDefault（引擎 CSP 有 form-action 'none'，真正提交一次就是违规） */
    if (form) {
      form.addEventListener('submit', function (e) {
        try {
          e.preventDefault();
          trySend();
        } finally {
          e.preventDefault();
        }
      });
    }
    /* 点「说」不能把焦点抢走：Android 上焦点一到按钮，输入框失焦、软键盘收起、抽屉弹回高度。
     * mousedown 的默认动作就是移焦点（触摸点按也会合成 mousedown），取消它；click 照常触发提交 */
    var sendBtn = form ? form.querySelector('[data-role="send"]') : null;
    if (sendBtn) {
      sendBtn.addEventListener('mousedown', function (e) {
        e.preventDefault();
      });
    }
    return {
      setBusy: function (b) {
        busy = !!b;
      },
      /* 发送被服务器接受之后调：桌面自动失焦（WASD 马上可用，想接着说再按 Enter）；手机保持聚焦 */
      done: function (ok) {
        if (ok && desktop && document.activeElement === el) el.blur();
      },
      reset: function () {
        hist.length = 0;
        hpos = -1;
        busy = false;
      },
      history: function () {
        return hist.slice();
      },
    };
  }

  /* ── 全局键盘：Enter 打开面板并聚焦输入框（写进 README：以后不要被别的功能占用） ── */
  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    var n = t.tagName.toLowerCase();
    return n === 'input' || n === 'textarea' || n === 'select' || !!t.isContentEditable;
  }
  window.addEventListener(
    'keydown',
    function (e) {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.isComposing || e.keyCode === 229) return;
      if (!playing() || isTypingTarget(e.target)) return;
      var t = e.target;
      if (t && t.closest && t.closest('button, a, summary, select, [role="button"]')) return;
      e.preventDefault();
      if (!isOpen) {
        var m = activeMod() || mods[order[0]];
        if (m && !m.slot) setActive(m.id);
      }
      open({ focus: true });
      if (isOpen) focusActive();
    },
    true,
  );
  /* 画布上按下：输入框先失焦（WASD 马上可用） */
  document.addEventListener(
    'pointerdown',
    function (e) {
      if (!inDockInput()) return;
      if (e.target && e.target.id === 'canvas') document.activeElement.blur();
    },
    true,
  );

  /* ── 核心状态（hud.js 的 setState 转来）：只在 phase / conn / mine 变化时通知模块 ── */
  function onCore(s) {
    var changed = {};
    var any = false;
    ['phase', 'conn', 'mine'].forEach(function (k) {
      var v = s[k];
      if (core[k] !== v) {
        changed[k] = true;
        any = true;
        core[k] = v;
      }
    });
    if (!any) return;
    if (changed.phase) {
      if (playing()) {
        /* 每次进入小镇：按记住的开关恢复 */
        if (wantOpen && !isOpen) open();
      } else if (isOpen) {
        /* 离开小镇（登录面板等）：先收起，但不清掉「想开着」的偏好 */
        var a = document.activeElement;
        if (a && dock.contains(a) && a.blur) a.blur();
        isOpen = false;
        callMod(activeMod(), 'onHide');
        dock.classList.remove('in');
        dock.hidden = true;
        render();
        measure();
        applyKb(0);
      }
      render();
    }
    for (var id in mods) callMod(mods[id], 'onCore', core, changed);
  }

  function escape() {
    if (!isOpen) return false;
    close();
    return true;
  }

  /* ── Godot -> 模块 ── */
  function deliver(m, kind, json) {
    var data = null;
    if (json !== undefined && json !== null && json !== '') {
      try {
        data = JSON.parse(json);
      } catch (e) {
        console.error('[dock] ' + m.id + ' 收到无法解析的 ' + kind, e);
        return;
      }
    }
    callMod(m, 'onFeed', kind, data);
  }
  function feed(id, kind, json) {
    var m = mods[id];
    if (!m) {
      var q = queue[id] || (queue[id] = []);
      if (q.length < 200) q.push([kind, json]);
      if (!warned[id]) {
        warned[id] = true;
        console.warn('[dock] 还没有注册的模块：' + id + '（消息先排队）');
      }
      return;
    }
    if (!m.inst) {
      /* 注册中途收到：排队，mount 之后补发 */
      (queue[id] || (queue[id] = [])).push([kind, json]);
      return;
    }
    deliver(m, kind, json);
  }

  function debug() {
    var d = { open: isOpen, tab: activeId, layout: layout, kb: kb, unread: totalUnread(), mods: order.slice(), core: core };
    return d;
  }

  /* ── 测试钩子（仅 ?debug=1） ── */
  var test = {
    noDedupe: false,
    setKeyboard: function (px) {
      testKb = px === null || px === undefined ? null : Number(px);
      queueKb();
    },
    forceSend: function (text) {
      var m = activeMod();
      if (m && m.inst && typeof m.inst.forceSend === 'function') m.inst.forceSend(String(text));
    },
  };

  window.TownDock = {
    API_VERSION: API_VERSION,
    register: register,
    feed: feed,
    onCore: onCore,
    escape: escape,
    open: open,
    close: close,
    isOpen: function () {
      return isOpen;
    },
    debug: debug,
    freeRect: freeRect,
  };
  if (DEBUG) {
    window.TownDock.test = test;
    /* 惰性读：每次取都现算，端到端不用等下一次推送 */
    Object.defineProperty(window, '__dock', {
      configurable: true,
      get: function () {
        var d = { _dock: debug() };
        for (var id in mods) {
          var x = callMod(mods[id], 'debug');
          d[id] = x && typeof x === 'object' ? x : {};
        }
        return d;
      },
    });
  }

  /* 通道：在 hud.js 的同一个对象上补方法（不能整体替换，Godot 手里拿的是它） */
  if (window.TownHud) {
    window.TownHud.feed = feed;
    window.TownHud.protocol = function () {
      return PROTOCOL;
    };
  }
  computeLayout();
  render();
})();
