/* 启动外壳：读 Godot 导出配置、拦截 AudioContext（用户手势时恢复）、启动引擎、提供 fetch 和回调通道。
 * 整个页面没有内联脚本：这个文件、hud.js 和 Godot 的 index.js 都是同源外部文件。 */
(function () {
  'use strict';

  /* ── 记录 Godot 建出来的 AudioContext，用户点「进入小镇」时一并 resume ── */
  var audioCtxs = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig || Orig.__townPatched) return;
    var Tracked = function (a, b) {
      var c = a === undefined ? new Orig() : new Orig(a, b);
      audioCtxs.push(c);
      return c;
    };
    Tracked.prototype = Orig.prototype;
    Tracked.__townPatched = true;
    window[name] = Tracked;
  });

  /* ── Godot <-> 外壳 ── */
  var API_PREFIX = '/town/api/';
  var host = {
    cb: null,
    setCallback: function (f) {
      host.cb = f;
    },
    emit: function () {
      if (!host.cb) return;
      try {
        host.cb.apply(null, Array.prototype.slice.call(arguments));
      } catch (e) {
        console.error('[town] 回调出错', e);
      }
    },
    fetchJson: function (id, method, path, body) {
      if (typeof path !== 'string' || path.indexOf(API_PREFIX) !== 0) {
        host.emit('http', id, 0, 'bad path', '');
        return;
      }
      var ctl = new AbortController();
      var timer = setTimeout(function () {
        ctl.abort();
      }, 15000);
      var opts = { method: method, credentials: 'same-origin', cache: 'no-store', headers: {}, signal: ctl.signal };
      if (body) {
        opts.body = body;
        opts.headers['Content-Type'] = 'application/json';
      }
      fetch(path, opts)
        .then(function (r) {
          return r.text().then(function (t) {
            clearTimeout(timer);
            host.emit('http', id, r.status, t, r.headers.get('Retry-After') || '');
          });
        })
        .catch(function (e) {
          clearTimeout(timer);
          host.emit('http', id, 0, String((e && e.message) || e), '');
        });
    },
    unlockAudio: function () {
      audioCtxs.forEach(function (c) {
        try {
          if (c.state === 'suspended') c.resume();
        } catch (e) {
          /* 被阻止就静音继续 */
        }
      });
    },
    audioState: function () {
      return audioCtxs.map(function (c) {
        return c.state;
      });
    },
  };
  window.TownHost = host;

  document.addEventListener('visibilitychange', function () {
    host.emit('vis', document.visibilityState === 'visible' ? '1' : '0');
  });
  window.addEventListener('pageshow', function () {
    host.emit('vis', '1');
  });
  window.addEventListener('online', function () {
    host.emit('vis', '1');
  });
  document.addEventListener('gesturestart', function (e) {
    e.preventDefault();
  });
  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.id === 'canvas') e.preventDefault();
  });

  /* ── 启动引擎 ── */
  var hud = window.TownHud;
  var cfgEl = document.getElementById('godot-config');
  var config;
  try {
    config = JSON.parse(cfgEl.textContent);
  } catch (e) {
    hud.fatal('启动配置损坏，请刷新重试。');
    return;
  }
  if (typeof Engine === 'undefined') {
    hud.fatal('没有加载到游戏引擎文件（index.js），请刷新重试。');
    return;
  }
  var missing = Engine.getMissingFeatures({ threads: false });
  if (missing.length > 0) {
    hud.fatal('当前浏览器缺少必要功能：' + missing.join('；') + '。请换用较新的 Chrome / Edge / Safari。');
    return;
  }
  hud.setLoading(0, '正在加载客户端…');
  var engine = new Engine(config);
  var canvas = document.getElementById('canvas');
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    hud.fatal('图形上下文丢失了（设备资源紧张）。请刷新页面。');
  });
  engine
    .startGame({
      onProgress: function (cur, total) {
        if (total > 0) hud.setLoading(cur / total, '正在加载客户端… ' + Math.round((cur / total) * 100) + '%');
        else hud.setLoading(0.3, '正在加载客户端…');
      },
    })
    .then(function () {
      hud.setLoading(1, '正在初始化…');
    })
    .catch(function (err) {
      console.error('[town] 引擎启动失败', err);
      hud.fatal('客户端启动失败：' + ((err && err.message) || err));
    });
})();
