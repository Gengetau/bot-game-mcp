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
  /* clientId 存 sessionStorage（每个标签页一个，刷新不变）。但「复制标签页」/ window.open 会把 sessionStorage
   * 一起复制，两个活页面就共用一个 id，服务器分不出谁是控制者。所以启动时先查这个 id 是不是已被另一个
   * 活着的页面占着：占着就换新 id 写回。Web Locks 优先（页面存活期间一直持锁，死了自动释放），
   * 没有就退回 BroadcastChannel 询问，再没有就保持原状。Godot 启动前 boot.js 会等 ready。 */
  var cid = null;
  function randomCid() {
    var r = '';
    var a = new Uint8Array(9);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) r += (a[i] % 36).toString(36);
    return 'web-' + r;
  }
  function storeCid(v) {
    cid = v;
    try {
      sessionStorage.setItem('town3d.clientId', v);
    } catch (e) {
      /* ignore */
    }
  }
  function clientId() {
    if (cid) return cid;
    var v = null;
    try {
      v = sessionStorage.getItem('town3d.clientId');
    } catch (e) {
      v = null;
    }
    if (v) cid = v;
    else storeCid(randomCid());
    return cid;
  }
  function delay(ms) {
    return new Promise(function (res) {
      setTimeout(res, ms);
    });
  }
  /* 抢这个 id 的锁：抢到则永远不放（Promise 不 resolve，直到页面关闭）；抢不到返回 false */
  function holdLock(id) {
    return new Promise(function (res) {
      navigator.locks
        .request('town3d.cid.' + id, { ifAvailable: true }, function (lock) {
          res(!!lock);
          return lock ? new Promise(function () {}) : undefined;
        })
        .catch(function () {
          res(true);
        });
    });
  }
  function claimCid() {
    var id = clientId();
    if (navigator.locks && navigator.locks.request) {
      return holdLock(id)
        .then(function (ok) {
          // 刷新时旧文档的锁可能还没放掉，等一下再试一次，别把刷新当成复制
          return ok ? true : delay(250).then(function () { return holdLock(id); });
        })
        .then(function (ok) {
          if (ok) return;
          storeCid(randomCid());
          return holdLock(cid);
        });
    }
    if (typeof BroadcastChannel === 'function') {
      return new Promise(function (res) {
        var ch;
        try {
          ch = new BroadcastChannel('town3d.cid');
        } catch (e) {
          res();
          return;
        }
        var taken = false;
        ch.onmessage = function (ev) {
          var m = ev.data || {};
          if (m.id !== cid) return;
          if (m.t === 'who') ch.postMessage({ t: 'have', id: cid });
          else if (m.t === 'have') taken = true;
        };
        ch.postMessage({ t: 'who', id: id });
        setTimeout(function () {
          if (taken) storeCid(randomCid());
          res();
        }, 250);
      });
    }
    return Promise.resolve();
  }
  var ready = claimCid().catch(function () {});

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

  /* ── 画质：高 = 实时阴影；低 = 只有脚下的软影（手机默认低）。选择记在本机 ── */
  var qualityHigh = (function () {
    var v = lsGet('town3d.quality');
    if (v === 'high') return true;
    if (v === 'low') return false;
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return false;
    // 软件渲染（SwiftShader / llvmpipe）开实时阴影只会更卡
    try {
      var gl = document.createElement('canvas').getContext('webgl2');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var rn = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      if (/swiftshader|llvmpipe|software/i.test(rn)) return false;
    } catch (e) {
      /* 取不到就按桌面默认 */
    }
    return true;
  })();
  function renderQuality() {
    $('qualityBtn').textContent = qualityHigh ? '画质：高' : '画质：低';
  }
  renderQuality();
  $('qualityBtn').addEventListener('click', function () {
    qualityHigh = !qualityHigh;
    lsSet('town3d.quality', qualityHigh ? 'high' : 'low');
    renderQuality();
    emit('quality', qualityHigh ? 'high' : 'low');
  });
  /* ── 音量设置：音乐 / 环境声 / 音效三条独立音量 + 切后台静音，记在 localStorage（读写都包 try/catch，读不到用默认值） ── */
  var AUDIO_DEFAULT = { music: 60, amb: 70, sfx: 80, bg: true };
  var audioPrefs = (function () {
    var out = { music: AUDIO_DEFAULT.music, amb: AUDIO_DEFAULT.amb, sfx: AUDIO_DEFAULT.sfx, bg: AUDIO_DEFAULT.bg };
    try {
      var j = JSON.parse(lsGet('town3d.audio') || 'null');
      if (j && typeof j === 'object') {
        ['music', 'amb', 'sfx'].forEach(function (k) {
          var v = Number(j[k]);
          if (isFinite(v)) out[k] = Math.max(0, Math.min(100, Math.round(v)));
        });
        if (typeof j.bg === 'boolean') out.bg = j.bg;
      }
    } catch (e) {
      /* 损坏就用默认值 */
    }
    return out;
  })();
  var VOL_IDS = { music: 'volMusic', amb: 'volAmb', sfx: 'volSfx' };
  function renderAudioPrefs() {
    Object.keys(VOL_IDS).forEach(function (k) {
      $(VOL_IDS[k]).value = String(audioPrefs[k]);
      $(VOL_IDS[k] + 'V').textContent = audioPrefs[k] + '%';
    });
    $('bgMute').checked = audioPrefs.bg;
  }
  function emitAudioPrefs() {
    Object.keys(VOL_IDS).forEach(function (k) {
      emit('vol', k + ':' + audioPrefs[k] / 100);
    });
    emit('bgmute', audioPrefs.bg ? '1' : '0');
  }
  renderAudioPrefs();
  Object.keys(VOL_IDS).forEach(function (k) {
    $(VOL_IDS[k]).addEventListener('input', function () {
      audioPrefs[k] = Math.max(0, Math.min(100, parseInt(this.value, 10) || 0));
      $(VOL_IDS[k] + 'V').textContent = audioPrefs[k] + '%';
      lsSet('town3d.audio', JSON.stringify(audioPrefs));
      emit('vol', k + ':' + audioPrefs[k] / 100);
    });
  });
  $('bgMute').addEventListener('change', function () {
    audioPrefs.bg = this.checked;
    lsSet('town3d.audio', JSON.stringify(audioPrefs));
    emit('bgmute', audioPrefs.bg ? '1' : '0');
  });
  function setSoundPanel(on) {
    $('soundPanel').hidden = !on;
    $('soundSetBtn').setAttribute('aria-expanded', on ? 'true' : 'false');
    emit('sfx', on ? 'panel_open' : 'panel_close');
  }
  $('soundSetBtn').addEventListener('click', function () {
    if (window.TownHost) window.TownHost.unlockAudio();
    setSoundPanel($('soundPanel').hidden);
  });
  document.addEventListener(
    'pointerdown',
    function (e) {
      if (!$('soundPanel').hidden && !$('soundPanel').contains(e.target) && e.target !== $('soundSetBtn')) setSoundPanel(false);
    },
    true,
  );

  /* ── 面板 ── */
  var state = {};
  var dead = false;
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
    if (ph === 'ready') txt = s.msg || '点击进入，开始你的一天。';
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
    emit('quality', qualityHigh ? 'high' : 'low');
    emitAudioPrefs();
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
  // 键盘弹出后输入框 / 进入按钮滚进可见范围
  $('nameInput').addEventListener('focus', function () {
    setTimeout(function () {
      try {
        $('loginBtn').scrollIntoView({ block: 'nearest' });
      } catch (e) {
        /* ignore */
      }
    }, 300);
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
    emit('sfx', $('destMenu').hidden ? 'panel_open' : 'panel_close');
    show($('destMenu'), $('destMenu').hidden);
  });

  /* ── 键盘：WASD / 方向键移动，E 互动，Esc 关面板或停步 ──
   * 在网页层处理：焦点在输入框里时一律不响应；窗口失焦、切后台、焦点进输入框都当成全部松开（Godot 会据此发零向量）。
   * 只发「现在按着哪几个方向」，方向到世界坐标的换算和协议在 main.gd。 */
  var KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  var held = {}; // e.code -> true
  var lastKeys = '';
  function isTyping(t) {
    if (!t || !t.tagName) return false;
    var n = t.tagName.toLowerCase();
    return n === 'input' || n === 'textarea' || n === 'select' || !!t.isContentEditable;
  }
  function playing() {
    return state.phase === 'playing';
  }
  function emitKeys() {
    var dirs = {};
    for (var c in held) if (held[c]) dirs[KEYMAP[c]] = true;
    var j = ['up', 'down', 'left', 'right'].filter(function (d) { return dirs[d]; }).join(',');
    // 末尾的编号是「按下沿」计数：只有新按下一个方向键才会加一，客户端靠它决定要不要解除"点地后的抑制"
    var out = j + '|' + pressEdge;
    if (out === lastKeys) return;
    lastKeys = out;
    emit('keys', out);
  }
  var pressEdge = 0;
  function releaseAll() {
    held = {};
    emitKeys();
  }
  window.addEventListener(
    'keydown',
    function (e) {
      // macOS 上 Cmd 按着时，其他键的 keyup 不会送到页面：一见到修饰键就全部松开，免得粘键一直走
      if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') {
        releaseAll();
        return;
      }
      if (isTyping(e.target) || !playing()) return;
      var code = e.code;
      if (KEYMAP[code]) {
        e.preventDefault();
        if (!held[code] && !e.repeat) pressEdge++;
        held[code] = true;
        emitKeys();
      } else if (code === 'KeyE') {
        e.preventDefault();
        if (!e.repeat) emit('interact');
      } else if (code === 'Escape') {
        if (e.repeat) return;
        if (!$('destMenu').hidden) show($('destMenu'), false);
        else {
          /* 面板开着：这一下 Esc 关面板，同时照常发 esc（走路中也停下）；键位提示「Esc 停下」始终成立 */
          if (window.TownDock) window.TownDock.escape();
          emit('esc');
        }
      }
    },
    true,
  );
  window.addEventListener(
    'keyup',
    function (e) {
      if (!KEYMAP[e.code]) return;
      held[e.code] = false;
      emitKeys();
    },
    true,
  );
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') releaseAll();
  });
  document.addEventListener('focusin', function (e) {
    if (isTyping(e.target)) releaseAll();
  });
  // 触摸设备不显示键位提示（主要输入是手指，没有物理键盘）
  var hasKeyboard = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

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
    if (dead) return; // 致命错误面板不能被下一次状态推送盖掉
    var s;
    try {
      s = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (e) {
      return;
    }
    state = s;
    if (window.TownDock) window.TownDock.onCore(s);
    renderPanel(s);
    lastPhase = s.phase;
    if (s.phase !== 'playing') {
      releaseAll();
      show($('keyHint'), false);
      document.body.setAttribute('data-phase', s.phase);
      clearTags(); // 重新登录 / 出错面板下不留旧姓名牌
      return;
    }
    document.body.setAttribute('data-phase', 'playing');
    show($('keyHint'), hasKeyboard);
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
    // 请求在途时，会再发请求的按钮先禁用，免得连点出第二个请求和一条红色报错；「停下」不在此列，随时可用
    var busy = (s.pending || 0) > 0;
    Array.prototype.forEach.call($('actions').children, function (b) {
      b.disabled = busy || b.className === 'busy';
    });
    ['claimBtn', 'leaveActBtn', 'homeBtn'].forEach(function (id) {
      $(id).disabled = busy;
    });
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
  function clearTags() {
    if (!Object.keys(tagEls).length) return;
    $('tags').textContent = '';
    tagEls = {};
  }
  // 顶栏下沿：地面标签（区域名、门口）不画进这条带里，免得压住右上角按钮；一秒量一次，别每帧强制布局
  var topLimit = 0;
  var topLimitAt = -1e9;
  function getTopLimit() {
    var now = performance.now();
    if (now - topLimitAt > 1000) {
      topLimitAt = now;
      topLimit = $('topbar').getBoundingClientRect().bottom + 4;
    }
    return topLimit;
  }
  function setTags(json) {
    if (dead) return;
    var list;
    try {
      list = JSON.parse(json);
    } catch (e) {
      return;
    }
    var box = $('tags');
    var W = box.clientWidth;
    var H = box.clientHeight;
    var top = getTopLimit();
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var px = t.x * W;
      var py = t.y * H;
      // 明显在屏幕外的不建 DOM、不写 transform
      if (px < -80 || px > W + 80 || py < -30 || py > H + 60) continue;
      var el = tagEls[t.i];
      if (!el) {
        el = document.createElement('div');
        tagEls[t.i] = el;
        el.setAttribute('data-id', t.i);
        box.appendChild(el);
      }
      var cls = 'tag ' + t.k + (t.m ? ' m' : '') + (t.sel ? ' sel' : '');
      if (el.className !== cls) el.className = cls;
      if (el.textContent !== t.n) el.textContent = t.n;
      var sig = cls + '|' + t.n;
      if (el._sig !== sig) {
        // 文字或样式变了才量一次尺寸（不每帧读布局）
        el._sig = sig;
        el._w = el.offsetWidth;
        el._h = el.offsetHeight;
      }
      var hw = el._w / 2 + 2;
      var hh = el._h;
      if (t.k === 'z' || t.k === 'p') {
        // 区域名 / 门口牌贴着顶栏时直接不画，比被按钮遮住好
        if (py - hh < top) {
          if (el.style.display !== 'none') el.style.display = 'none';
          seen[t.i] = true;
          continue;
        }
      } else if (py - hh < top) {
        py = top + hh;
      }
      if (el.style.display === 'none') el.style.display = '';
      // 贴着左右边缘时钳进屏幕，整块牌都看得见
      px = hw * 2 >= W ? W / 2 : Math.max(hw, Math.min(W - hw, px));
      py = Math.min(py, H - 2);
      seen[t.i] = true;
      var zi = t.k === 's' ? '5' : t.k === 'a' ? '4' : t.k === 'z' ? '1' : '3';
      if (el.style.zIndex !== zi) el.style.zIndex = zi;
      el.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px) translate(-50%,-100%)';
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
    if (dead) return; // 出了致命错误：加载进度不能把错误面板盖回去
    if (state.phase && state.phase !== 'boot') return;
    renderPanel({ phase: 'boot', msg: text });
    $('progressBar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  }
  function fatal(msg) {
    dead = true; // 之后 setState / setTags 都不再接受，错误面板留着
    clearTags();
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
    /* 最长帧间隔：Godot 每次推送带来「自上次推送以来的最大值」，这里累计，端到端每步开头清零、结尾读取 */
    window.__frameMaxMs = Math.max(window.__frameMaxMs || 0, d.frameMaxMs || 0);
    d.canvasRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    d.audio = window.TownHost ? window.TownHost.audioState() : [];
    d.soundOn = soundOn;
    d.audioPrefs = audioPrefs;
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
    /* 端到端的假接管：对这个编号的 on_pick 直接算被接管；传 '-' 是一律算没接管（不问任何功能）；空串清除。只在 ?debug=1 下有，main.gd 也只在 debug 下认 */
    d.pickStub = function (id) {
      emit('debug_pick_stub', String(id || ''));
    };
    d.dock = window.TownDock ? window.TownDock.debug() : {};
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
    bgMute: function () {
      return audioPrefs.bg;
    },
    ready: ready,
    /* 面板功能的网页通道：dock.js 在同一个对象上换成真实现（不能整体替换 window.TownHud）；没加载 dock.js 时协议号 0 与客户端的 2 对不上，Godot 会报版本不一致 */
    feed: function () {},
    protocol: function () {
      return 0;
    },
  };
  setLoading(0, '正在加载客户端…');
})();
