/* TownChatKit：聊天类面板的共用实现（消息列表 + 输入栏）。附近聊天（nearby）用它，C1b 的全镇公屏（town）复用。
 * 本文件由 C1a 拥有并冻结：要改行为先加 options 参数，不改内部。
 *
 * 用法：var kit = TownChatKit.create(host, options); 然后在模块的 onFeed / onShow / onHide 里转给 kit。
 *   kit.setState(st)    st = {canSend, reason, max, alone, place, hear}
 *   kit.append(items, live)   items = [{id, from, name, kind, text, at, space, spaceName, mine}]；按 id 去重、按 id 升序；live=false 的（历史补读）永不计未读
 *   kit.onAck(ack)      ack = {n, ok, heardBy?, code?, reason?, message?, retryMs?, maxChars?}
 *   kit.reset()         离开 / 换人：清列表、草稿、ArrowUp 历史、倒计时（聊天内容只放内存）
 *   kit.clearList()     只清列表与未读（整体重读用），不动发送中状态、倒计时、提示、历史、草稿
 *   kit.onShow() / kit.forceSend(text) / kit.debug()
 * options：
 *   msgTpl     消息行模板的 id（独立顶层 <template>，不嵌套）
 *   maxRows    DOM 里最多保留的消息行数，默认 200
 *   mergeMs    同一发言人这么久之内合并（只在组首显示名字），默认 60 秒
 *   gapMs      相邻两条间隔超过这么久插一行时间，默认 5 分钟
 *   countsUnread  默认 true
 * 模板里的 data-role：list jump hint compose input count send place alone；文字库 [data-bank] 里的键见 nearby.html。
 * 玩家提供的文字（昵称、消息正文、地点名）一律 textContent；类名只用白名单值；data-* 里只放编号。 */
(function () {
  'use strict';

  function safeId(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[^\w.:-]/g, '_').slice(0, 64);
  }
  function codepoints(s) {
    return Array.from(s).length;
  }

  function create(host, options) {
    var o = options || {};
    var MAX_ROWS = o.maxRows || 200;
    var MERGE_MS = o.mergeMs || 60000;
    var GAP_MS = o.gapMs || 300000;
    var counts = o.countsUnread !== false;
    var q = function (role) {
      return host.q('[data-role="' + role + '"]');
    };
    var list = q('list');
    var jump = q('jump');
    var hint = q('hint');
    var form = q('compose');
    var input = q('input');
    var count = q('count');
    var sendBtn = q('send');
    var placeEl = q('place');
    var aloneEl = q('alone');
    var scopeEl = q('scope');
    var tpl = document.getElementById(o.msgTpl);

    var items = []; // 按 id 升序
    var byId = {}; // id -> {it, li}
    var pendingIn = []; // 等 rAF 一次性插入
    var rafId = 0;
    var unread = 0;
    var state = { canSend: false, reason: 'offline', max: 120, alone: false, place: '', hear: 0 };
    var sending = false;
    var sentText = '';
    var seq = 0;
    var lastSendAt = 0;
    var watchdog = 0;
    var cool = 0;
    var coolTimer = 0;
    var hintKind = '';
    var lenHint = false;
    var sysTimers = [];

    /* ── 输入栏 ── */
    var wired = host.wireInput(input, { onSend: doSend, canSend: canSend });

    function maxChars() {
      return state.max || 120;
    }
    function len() {
      return codepoints(input.value);
    }
    function canSend() {
      return state.canSend && !sending && cool <= 0 && Date.now() - lastSendAt >= 300 && len() <= maxChars();
    }
    function setHint(text, kind) {
      lenHint = false;
      hintKind = text ? kind || 'err' : '';
      hint.textContent = text || '';
      hint.className = 'hint' + (hintKind ? ' ' + hintKind : '');
    }
    function updateSend() {
      var n = len();
      sendBtn.disabled = !state.canSend || sending || cool > 0 || n === 0 || n > maxChars();
    }
    function updateCount() {
      var n = len();
      var mx = maxChars();
      var show = n >= mx * 0.6;
      count.textContent = show ? n + '/' + mx : '';
      count.classList.toggle('over', n > mx);
      if (n > mx) {
        setHint(host.t('err.text_too_long', { n: mx }), 'err');
        lenHint = true;
      } else if (lenHint) {
        setHint('');
      }
      updateSend();
    }
    input.addEventListener('input', updateCount);

    function doSend(text) {
      if (sending) return;
      sending = true;
      sentText = text;
      lastSendAt = Date.now();
      seq++;
      wired.setBusy(true);
      updateSend();
      host.emit('send', JSON.stringify({ n: seq, text: text }));
      var mine = seq;
      clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        if (sending && seq === mine) {
          sending = false;
          wired.setBusy(false);
          setHint(host.t('err.net'), 'err');
          updateSend();
        }
      }, 20000);
    }

    function startCooldown(sec) {
      cool = Math.max(1, sec | 0);
      clearInterval(coolTimer);
      var tick = function () {
        if (cool > 0) setHint(host.t('err.rate_limited', { n: cool }), 'cool');
        if (cool <= 0) {
          clearInterval(coolTimer);
          if (hintKind === 'cool') setHint('');
          updateSend();
        }
        cool--;
      };
      tick();
      coolTimer = setInterval(tick, 1000);
      updateSend();
    }

    function onAck(a) {
      if (!a || a.n !== seq) return;
      clearTimeout(watchdog);
      sending = false;
      wired.setBusy(false);
      if (a.ok) {
        /* 用户已经接着打了新字就不动它 */
        if (input.value.trim() === sentText) {
          input.value = '';
          updateCount();
        }
        setHint('');
        if (a.heardBy === 0) addSystem(host.t('sys.nobody'), 4000);
        wired.done(true);
        updateSend();
        return;
      }
      var code = a.code || '';
      var reason = a.reason || '';
      if (code === 'rate_limited') {
        startCooldown(Math.max(1, Math.ceil((a.retryMs || 1000) / 1000)));
        return;
      }
      var text = host.t('err.' + reason, { n: a.maxChars || maxChars() }) || host.t('err.' + code, { n: a.maxChars || maxChars() });
      if (!text) text = a.message ? String(a.message) : host.t('err.net');
      setHint(text, 'err');
      updateSend();
    }

    /* ── 列表 ── */
    function atBottom() {
      return list.scrollHeight - list.scrollTop - list.clientHeight <= 40;
    }
    function toBottom() {
      list.scrollTop = list.scrollHeight;
      jump.hidden = true;
    }
    list.addEventListener('scroll', function () {
      if (!jump.hidden && atBottom()) jump.hidden = true;
    });
    jump.addEventListener('click', function () {
      toBottom();
      if (unread) {
        unread = 0;
        host.setUnread(0);
      }
    });

    function timeRow(at) {
      var li = document.createElement('li');
      li.className = 'time';
      var d = new Date(at);
      li.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      return li;
    }
    function sepRow(name) {
      var li = document.createElement('li');
      li.className = 'sep';
      li.textContent = name;
      return li;
    }
    function addSystem(text, ttl) {
      if (!text) return;
      var li = document.createElement('li');
      li.className = 'sys';
      li.textContent = text;
      var stick = atBottom();
      list.appendChild(li);
      if (stick) list.scrollTop = list.scrollHeight;
      var t = setTimeout(function () {
        if (li.parentNode) li.parentNode.removeChild(li);
      }, ttl || 4000);
      sysTimers.push(t);
    }

    function nodesFor(it, prev) {
      var out = [];
      var sep = !!(prev && it.spaceName && prev.space !== it.space);
      var gap = !!(prev && it.at - prev.at > GAP_MS);
      if (sep) out.push(sepRow(it.spaceName));
      if (gap) out.push(timeRow(it.at));
      var li = tpl.content.firstElementChild.cloneNode(true);
      li.setAttribute('data-mid', String(it.id));
      li.setAttribute('data-from', safeId(it.from));
      li.classList.add(it.mine ? 'mine' : 'other');
      if (it.kind === 'agent') li.classList.add('agent');
      var cont = !!(prev && !sep && !gap && prev.from === it.from && it.at - prev.at <= MERGE_MS);
      if (cont) li.classList.add('cont');
      var nm = li.querySelector('[data-role="name"]');
      if (nm) nm.textContent = it.name || '';
      var ai = li.querySelector('[data-role="ai"]');
      if (ai) ai.hidden = it.kind !== 'agent';
      var tx = li.querySelector('[data-role="text"]');
      if (tx) tx.textContent = it.text || '';
      out.push(li);
      byId[it.id] = { it: it, li: li };
      return out;
    }

    function rebuild() {
      /* 记下距底距离：清空会把 scrollTop 夹成 0，重建后按距底距离还原，正在看旧消息的人不被拽到最顶 */
      var fromBottom = list.scrollHeight - list.scrollTop;
      list.textContent = '';
      byId = {};
      var frag = document.createDocumentFragment();
      for (var i = 0; i < items.length; i++) {
        nodesFor(items[i], items[i - 1]).forEach(function (n) {
          frag.appendChild(n);
        });
      }
      list.appendChild(frag);
      list.scrollTop = Math.max(0, list.scrollHeight - fromBottom);
    }

    function trimHead() {
      while (items.length > MAX_ROWS) {
        var gone = items.shift();
        delete byId[gone.id];
      }
      /* DOM：从头删到消息行数 <= 上限（连同头上的时间行 / 分隔行） */
      var rows = list.querySelectorAll('li[data-mid]');
      var extra = rows.length - MAX_ROWS;
      while (extra > 0 && list.firstChild) {
        var n = list.firstChild;
        if (n.getAttribute && n.hasAttribute('data-mid')) extra--;
        list.removeChild(n);
      }
      /* 头上留着的时间 / 分隔行也去掉 */
      while (list.firstChild && list.firstChild.getAttribute && !list.firstChild.hasAttribute('data-mid') && list.firstChild.className !== 'sys') list.removeChild(list.firstChild);
    }

    function flush() {
      rafId = 0;
      if (!pendingIn.length) return;
      var batch = pendingIn;
      pendingIn = [];
      var stick = atBottom() || list.clientHeight === 0;
      var needRebuild = false;
      var prevLast = items.length ? items[items.length - 1] : null;
      var inBatch = {};
      var added = [];
      var mineAdded = false;
      var fresh = 0;
      batch.forEach(function (p) {
        var it = p.it;
        var ex = byId[it.id] || inBatch[it.id];
        if (ex && !(window.TownDock && window.TownDock.test && window.TownDock.test.noDedupe)) {
          /* 同 id 已在：服务端文字为准，覆盖 */
          if (it.text !== ex.it.text) {
            ex.it.text = it.text;
            var tx = ex.li ? ex.li.querySelector('[data-role="text"]') : null;
            if (tx) tx.textContent = it.text;
          }
          return;
        }
        inBatch[it.id] = { it: it, li: null };
        if (items.length && it.id < items[items.length - 1].id) needRebuild = true;
        items.push(it);
        added.push(it);
        if (it.mine) mineAdded = true;
        else if (p.live) fresh++;
      });
      if (!added.length) return;
      if (needRebuild) {
        items.sort(function (a, b) {
          return a.id - b.id;
        });
        while (items.length > MAX_ROWS) delete byId[items.shift().id];
        rebuild();
      } else {
        var frag = document.createDocumentFragment();
        added.forEach(function (it, k) {
          nodesFor(it, k === 0 ? prevLast : added[k - 1]).forEach(function (n) {
            frag.appendChild(n);
          });
        });
        /* 系统行（临时提示）总在最后：新消息插在它们前面太绕，直接追加即可 */
        list.appendChild(frag);
        if (items.length > MAX_ROWS) trimHead();
      }
      if (counts && fresh > 0 && !host.isActive()) {
        unread += fresh;
        host.setUnread(unread);
      }
      if (stick || mineAdded) toBottom();
      else jump.hidden = false;
    }
    function schedule() {
      if (!rafId) rafId = requestAnimationFrame(flush);
    }

    function append(arr, live) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function (it) {
        if (!it || typeof it.id !== 'number') return;
        pendingIn.push({ it: Object.assign({ from: '', name: '', kind: 'human', text: '', at: 0, space: '', spaceName: '', mine: false }, it), live: !!live });
      });
      schedule();
    }

    function setState(st) {
      if (!st) return;
      state = Object.assign(state, st);
      var reason = state.canSend ? 'ok' : state.reason || 'offline';
      input.disabled = !state.canSend;
      input.placeholder = host.t('ph.' + reason);
      if (placeEl) placeEl.textContent = state.place || '';
      if (scopeEl) {
        var lab = scopeEl.querySelector('[data-role="scopeText"]');
        if (lab) lab.textContent = host.t('scope', { n: Math.round(state.hear || 0) });
      }
      if (aloneEl) aloneEl.hidden = !(state.alone && state.canSend);
      updateCount();
    }

    function reset() {
      pendingIn = [];
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      items = [];
      byId = {};
      list.textContent = '';
      jump.hidden = true;
      unread = 0;
      host.setUnread(0);
      input.value = '';
      sending = false;
      sentText = '';
      clearTimeout(watchdog);
      clearInterval(coolTimer);
      cool = 0;
      sysTimers.forEach(clearTimeout);
      sysTimers = [];
      wired.reset();
      setHint('');
      updateCount();
    }

    /* 只清列表（整体重读用）：不动发送中、限流倒计时、提示、ArrowUp 历史、草稿；未读清零（重读的是历史，不计未读） */
    function clearList() {
      pendingIn = [];
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      items = [];
      byId = {};
      list.textContent = '';
      jump.hidden = true;
      unread = 0;
      host.setUnread(0);
    }

    function onShow() {
      requestAnimationFrame(toBottom);
      if (unread) {
        unread = 0;
        host.setUnread(0);
      }
    }

    function forceSend(text) {
      /* 测试用：绕过前端字数检查强发（验证服务器的 text_too_long） */
      sentText = text;
      sending = true;
      lastSendAt = Date.now();
      seq++;
      wired.setBusy(true);
      updateSend();
      host.emit('send', JSON.stringify({ n: seq, text: text }));
    }

    function debug() {
      var ids = [];
      var rows = list.querySelectorAll('li[data-mid]');
      for (var i = 0; i < rows.length; i++) ids.push(Number(rows[i].getAttribute('data-mid')));
      return { count: items.length, rows: rows.length, unread: unread, canSend: !!state.canSend, reason: state.reason, sending: sending, seq: seq, cool: cool, hist: wired.history().length, ids: ids, active: host.isActive() };
    }

    updateCount();
    return { setState: setState, append: append, onAck: onAck, reset: reset, clearList: clearList, onShow: onShow, forceSend: forceSend, debug: debug, addSystem: addSystem };
  }

  window.TownChatKit = { create: create };
})();
