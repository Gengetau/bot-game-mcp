/* 栖灯镇三维客户端的界面层：普通 DOM，叠在 canvas 上。
 * 协议和状态都在 Godot（GDScript）里，这里只显示和发按钮事件。
 * 玩家提供的文字（名字等）一律用 textContent 写入。 */
(function () {
  'use strict';
  var $ = function (id) {
    return document.getElementById(id);
  };
  var DEBUG = /[?&]debug=1(&|$)/.test(location.search);

  /* ── 本机存储（不可用时照常工作）── */
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
  var cid = null;
  function clientId() {
    if (cid) return cid;
    try {
      cid = sessionStorage.getItem('town3d.clientId');
    } catch (e) {
      cid = null;
    }
    if (!cid) {
      var r = '';
      var a = new Uint8Array(9);
      (window.crypto || window.msCrypto).getRandomValues(a);
      for (var i = 0; i < a.length; i++) r += (a[i] % 36).toString(36);
      cid = 'web-' + r;
      try {
        sessionStorage.setItem('town3d.clientId', cid);
      } catch (e) {
        /* ignore */
      }
    }
    return cid;
  }

  function emit(name, arg) {
    if (window.TownHost) window.TownHost.emit('ui', name, arg === undefined ? '' : String(arg));
  }

  /* ── 声音开关 ── */
  var soundOn = lsGet('town3d.sound') !== '0';
  function renderSound() {
    $('soundBtn').textContent = soundOn ? '声音：开' : '声音：关';
  }
  renderSound();
  $('soundBtn').addEventListener('click', function () {
    soundOn = !soundOn;
    lsSet('town3d.sound', soundOn ? '1' : '0');
    renderSound();
    emit('sound', soundOn ? '1' : '0');
    if (soundOn && window.TownHost) window.TownHost.unlockAudio();
  });

  /* ── 面板 ── */
  var state = {};
  var lastPhase = '';
  function show(el, on) {
    el.hidden = !on;
  }
  function renderPanel(s) {
    var panel = $('panel');
    var ph = s.phase;
    panel.style.display = ph === 'playing' ? 'none' : 'flex';
    if (ph === 'playing') return;
    show($('enterBtn'), ph === 'ready');
    show($('retryBtn'), ph === 'error');
    show($('loginForm'), ph === 'login');
    show($('panelLoading'), ph === 'boot' || ph === 'loading');
    show($('panelLink'), ph === 'error' && !!s.link);
    var txt = '';
    if (ph === 'ready') txt = '点击进入，开始你的一天。';
    else if (ph === 'busy' || ph === 'error') txt = s.msg || '';
    else if (ph === 'login') txt = '';
    else txt = s.msg || '正在加载客户端…';
    $('panelText').textContent = txt;
    $('panelText').className = 'sub' + (ph === 'error' ? ' err' : '');
    if (ph === 'login') {
      $('loginLabel').textContent = s.loginTitle || '取一个名字';
      var le = $('loginError');
      le.textContent = s.loginError || '';
      show(le, !!s.loginError);
      if (lastPhase !== 'login') {
        var saved = lsGet('town3d.name');
        if (saved && !$('nameInput').value) $('nameInput').value = saved;
        setTimeout(function () {
          $('nameInput').focus();
        }, 50);
      }
    }
    if (ph === 'error' && s.link) $('panelLink').setAttribute('href', s.link);
  }

  $('enterBtn').addEventListener('click', function () {
    if (window.TownHost) window.TownHost.unlockAudio();
    emit('sound', soundOn ? '1' : '0');
    emit('enter');
  });
  $('retryBtn').addEventListener('click', function () {
    if (window.TownHost) window.TownHost.unlockAudio();
    emit('retry');
  });
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('nameInput').value.trim();
    if (v) lsSet('town3d.name', v);
    emit('login', v);
  });
  $('stopBtn').addEventListener('click', function () {
    emit('stop');
  });
  $('claimBtn').addEventListener('click', function () {
    emit('claim');
  });
  $('leaveActBtn').addEventListener('click', function () {
    emit('leave_activity');
  });
  $('homeBtn').addEventListener('click', function () {
    emit(state.inHome ? 'leave_home' : 'home');
  });
  $('destBtn').addEventListener('click', function () {
    show($('destMenu'), $('destMenu').hidden);
  });

  /* ── 状态 ── */
  var lastActionsJson = '';
  var lastDestJson = '';
  var actEnds = null;
  function renderActions(list) {
    var j = JSON.stringify(list || []);
    if (j === lastActionsJson) return;
    lastActionsJson = j;
    var box = $('actions');
    box.textContent = '';
    (list || []).forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = a.mode;
      b.setAttribute('data-action', a.id);
      var t = document.createElement('span');
      t.textContent = a.label;
      b.appendChild(t);
      if (a.sub) {
        var sm = document.createElement('small');
        sm.textContent = a.sub;
        b.appendChild(sm);
      }
      if (a.mode === 'busy') b.disabled = true;
      b.addEventListener('click', function () {
        emit('act', a.id);
      });
      box.appendChild(b);
    });
  }
  function renderDest(list) {
    var j = JSON.stringify(list || []);
    if (j === lastDestJson) return;
    lastDestJson = j;
    var box = $('destMenu');
    box.textContent = '';
    (list || []).forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-dest', d.id);
      b.textContent = d.name + (d.seconds ? ' · ' + d.seconds + ' 秒' : '');
      b.addEventListener('click', function () {
        show($('destMenu'), false);
        emit('dest', d.id);
      });
      box.appendChild(b);
    });
  }
  function renderActivity(a) {
    if (!a) {
      actEnds = null;
      show($('activityChip'), false);
      return;
    }
    var rem = a.remainMs;
    actEnds = rem >= 0 ? performance.now() + rem : null;
    $('activityChip').setAttribute('data-name', a.name);
    updateActivityText(a.name);
    show($('activityChip'), true);
  }
  function updateActivityText(name) {
    var n = name || $('activityChip').getAttribute('data-name') || '';
    var t = '正在：' + n;
    if (actEnds !== null) {
      var s = Math.max(0, Math.round((actEnds - performance.now()) / 1000));
      t += '（剩 ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + '）';
    }
    $('activityText').textContent = t;
  }
  setInterval(function () {
    if (!$('activityChip').hidden) updateActivityText();
  }, 1000);

  function setState(json) {
    var s;
    try {
      s = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (e) {
      return;
    }
    state = s;
    renderPanel(s);
    lastPhase = s.phase;
    if (s.phase !== 'playing') {
      document.body.setAttribute('data-phase', s.phase);
      return;
    }
    document.body.setAttribute('data-phase', 'playing');
    $('space').textContent = s.space || s.sceneName || '栖灯镇';
    $('conn').className = 'dot ' + (s.conn || '');
    $('conn').title = s.conn === 'ok' ? '已连接' : s.conn === 'reconnecting' ? '重新连接中…' : '离线';
    // 不只靠一个会闪的小点：断线时写出文字（屏幕阅读器和截图里都看得见）
    $('connText').textContent = s.conn === 'ok' || !s.conn ? '' : s.conn === 'reconnecting' ? '重连中…' : '离线';
    show($('connText'), s.conn !== 'ok' && !!s.conn);
    show($('readonly'), s.mine === false);
    show($('pendingChip'), (s.pending || 0) > 0);
    $('stopBtn').disabled = !(s.walking && s.mine !== false);
    $('homeBtn').textContent = s.inHome ? '出门' : '回家';
    renderActions(s.actions);
    renderDest(s.dest);
    renderActivity(s.activity);
  }

  /* ── 提示条 ── */
  function toast(msg, kind) {
    var box = $('toasts');
    var d = document.createElement('div');
    d.className = 'toast ' + (kind || 'info');
    d.textContent = String(msg);
    box.appendChild(d);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(function () {
      if (d.parentNode) d.parentNode.removeChild(d);
    }, 4500);
  }

  /* ── 姓名牌：Godot 每帧给归一化的屏幕坐标，这里用 transform 摆 ── */
  var tagEls = {};
  function setTags(json) {
    var list;
    try {
      list = JSON.parse(json);
    } catch (e) {
      return;
    }
    var box = $('tags');
    var W = box.clientWidth;
    var H = box.clientHeight;
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      seen[t.i] = true;
      var el = tagEls[t.i];
      if (!el) {
        el = document.createElement('div');
        tagEls[t.i] = el;
        box.appendChild(el);
      }
      el.className = 'tag ' + t.k + (t.m ? ' m' : '') + (t.sel ? ' sel' : '');
      if (el.textContent !== t.n) el.textContent = t.n;
      el.style.zIndex = t.k === 's' ? '5' : t.k === 'a' ? '4' : t.k === 'z' ? '1' : '3';
      el.style.transform = 'translate(' + (t.x * W).toFixed(1) + 'px,' + (t.y * H).toFixed(1) + 'px) translate(-50%,-100%)';
      el.setAttribute('data-id', t.i);
    }
    for (var id in tagEls) {
      if (!seen[id]) {
        if (tagEls[id].parentNode) tagEls[id].parentNode.removeChild(tagEls[id]);
        delete tagEls[id];
      }
    }
  }

  /* ── 加载进度 / 致命错误（引擎起来之前）── */
  function setLoading(frac, text) {
    if (state.phase && state.phase !== 'boot') return;
    renderPanel({ phase: 'boot', msg: text });
    $('progressBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  }
  function fatal(msg) {
    renderPanel({ phase: 'error', msg: msg, link: '/town/' });
    $('retryBtn').onclick = function () {
      location.reload();
    };
  }

  /* ── 调试钩子：?debug=1 时 window.__town（Godot 每 100 毫秒写一次）── */
  function debugSet(json) {
    if (!DEBUG) return;
    var d;
    try {
      d = JSON.parse(json);
    } catch (e) {
      return;
    }
    var r = $('canvas').getBoundingClientRect();
    function px(o) {
      if (typeof o.nx === 'number') {
        o.sx = r.left + o.nx * r.width;
        o.sy = r.top + o.ny * r.height;
      }
    }
    (d.actors || []).forEach(px);
    (d.objects || []).forEach(px);
    d.canvasRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    d.audio = window.TownHost ? window.TownHost.audioState() : [];
    d.soundOn = soundOn;
    d.toasts = Array.prototype.map.call($('toasts').children, function (e) {
      return e.textContent;
    });
    /* 世界坐标 -> 屏幕像素（用 Godot 给的投影矩阵）*/
    d.project = function (x, y, z) {
      var m = d.vp;
      var cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      var cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      var cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      return { x: r.left + (cx / cw * 0.5 + 0.5) * r.width, y: r.top + (1 - (cy / cw * 0.5 + 0.5)) * r.height };
    };
    d.act = function (action) {
      emit('debug_act', JSON.stringify(action));
    };
    window.__town = d;
  }

  window.TownHud = {
    setState: setState,
    setTags: setTags,
    toast: toast,
    clientId: clientId,
    setLoading: setLoading,
    fatal: fatal,
    debugSet: debugSet,
  };
  setLoading(0, '正在加载客户端…');
})();
