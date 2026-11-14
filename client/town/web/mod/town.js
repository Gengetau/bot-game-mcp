/* 全镇公屏（页签「全镇」）：消息列表和输入栏复用 00-chatkit.js；这里补三类东西：
 *  - 发话时带上类型（闲聊 / 组织活动 / 求助）和可选的地点（给 host.emit 套一层）；
 *  - 每一行的装饰（类型小牌、「走过去」、@ 高亮），由 MutationObserver 在 kit 生成行之后补上；
 *  - 静音开关、读取状态条（读取中 / 失败 / 看更早的话）、读更早时保持视线不跳。
 * feed 的 kind：state、append（items 带 tkind / place）、ack、reset、rebuild（整体重读，保留草稿）。
 * 玩家提供的文字一律 textContent；类名和 data-* 只放白名单值或数字。聊天内容、游标、草稿、静音状态都只放内存。
 * 文字都在 town.html 的文字库里，这个文件里没有汉字字面量（lint 检查）。 */
(function () {
  'use strict';

  var KINDS = ['chat', 'activity', 'help'];
  var PLACES = ['plaza', 'tea_house', 'bookshop', 'kitchen', 'garden', 'arcade', 'residential'];
  var META_KEEP = 400;

  /* 判定函数单独放，方便以后换成服务端给的标记：非自己的话里含「@我的名字」。NFKC + 小写 + 去零宽字符后比较；名字不足 2 个字符不判 */
  function normText(s) {
    var x = String(s === undefined || s === null ? '' : s);
    try {
      x = x.normalize('NFKC');
    } catch (e) {
      /* ignore */
    }
    return x.toLowerCase().replace(/[​-‏‪-‮⁠-⁤﻿]/g, '');
  }
  function mentionsMe(text, myName) {
    var n = normText(myName);
    if (Array.from(n).length < 2) return false;
    return normText(text).indexOf('@' + n) >= 0;
  }

  window.TownDock.register({
    id: 'town',
    api: 1,
    mount: function (host) {
      var kind = 'chat';
      var place = '';
      var muted = false;
      var me = '';
      var meta = {}; // ord -> {tkind, place:{id,name}|null, mention}
      var usedOlder = false;
      var restore = null; // 读更早之前记下的视线锚点
      var lastState = null;

      /* 发话时补上类型与地点：kit 发出 {n,text}，这里转成 {n,text,kind,place?} */
      var wrapped = Object.assign({}, host, {
        emit: function (name, arg) {
          if (name === 'send') {
            var o;
            try {
              o = JSON.parse(arg);
            } catch (e) {
              o = null;
            }
            if (o && typeof o === 'object') {
              o.kind = kind;
              if (place && kind !== 'chat') o.place = place;
              host.emit(name, JSON.stringify(o));
              return;
            }
          }
          host.emit(name, arg);
        },
      });
      var kit = window.TownChatKit.create(wrapped, { msgTpl: 'tpl-town-msg', mergeMs: 1 });

      var q = function (role) {
        return host.q('[data-role="' + role + '"]');
      };
      var list = q('list');
      var jump = q('jump');
      var muteBtn = q('mute');
      var muteText = q('muteText');
      var rules = q('rules');
      var strip = q('strip');
      var stripText = q('stripText');
      var olderBtn = q('older');
      var kinds = q('kinds');
      var placeSel = q('placeSel');
      var scope = q('scope');
      var input = q('input');

      /* ── 静态文字（来自文字库） ── */
      rules.textContent = host.t('rules');
      muteBtn.setAttribute('title', host.t('mute.tip'));
      muteBtn.setAttribute('aria-label', host.t('mute.tip'));
      scope.setAttribute('title', host.t('rules'));
      var kindBtns = Array.prototype.slice.call(kinds.querySelectorAll('button[data-kind]'));
      kindBtns.forEach(function (b) {
        b.textContent = host.t('kind.' + b.getAttribute('data-kind'));
      });
      (function buildPlaces() {
        var none = document.createElement('option');
        none.value = '';
        none.textContent = host.t('place.none');
        placeSel.appendChild(none);
        PLACES.forEach(function (id) {
          var o = document.createElement('option');
          o.value = id;
          o.textContent = host.t('place.' + id);
          placeSel.appendChild(o);
        });
      })();

      function renderMute() {
        muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
        muteText.textContent = host.t(muted ? 'mute.on' : 'mute.off');
      }
      function renderKinds() {
        kindBtns.forEach(function (b) {
          var on = b.getAttribute('data-kind') === kind;
          b.setAttribute('aria-checked', on ? 'true' : 'false');
          b.tabIndex = on ? 0 : -1;
        });
        placeSel.hidden = kind === 'chat';
        if (kind === 'chat') {
          place = '';
          placeSel.value = '';
        }
      }
      function resetCompose() {
        kind = 'chat';
        place = '';
        placeSel.value = '';
        renderKinds();
      }
      renderMute();
      renderKinds();

      kindBtns.forEach(function (b, i) {
        b.addEventListener('click', function () {
          var k = b.getAttribute('data-kind');
          if (KINDS.indexOf(k) < 0) return;
          kind = k;
          renderKinds();
        });
        b.addEventListener('keydown', function (e) {
          /* radiogroup 的方向键：左右切换 */
          var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          var nb = kindBtns[(i + d + kindBtns.length) % kindBtns.length];
          nb.click();
          nb.focus();
        });
      });
      placeSel.addEventListener('change', function () {
        place = PLACES.indexOf(placeSel.value) >= 0 ? placeSel.value : '';
      });
      muteBtn.addEventListener('click', function () {
        host.emit('mute', muted ? '0' : '1');
      });

      /* ── 行装饰：类名白名单 + 小牌 + 走过去 ── */
      function placeName(p) {
        if (!p) return '';
        return p.name ? String(p.name) : host.t('place.' + p.id);
      }
      function decorate(li) {
        if (!li || li.nodeType !== 1 || !li.hasAttribute('data-mid') || li.hasAttribute('data-dec')) return;
        li.setAttribute('data-dec', '1');
        var m = meta[li.getAttribute('data-mid')];
        if (!m) return;
        if (m.tkind === 'activity') li.classList.add('tk-activity');
        else if (m.tkind === 'help') li.classList.add('tk-help');
        if (m.mention) li.classList.add('mention');
        if (m.tkind !== 'activity' && m.tkind !== 'help') return;
        var foot = document.createElement('div');
        foot.className = 'extra';
        var chip = document.createElement('span');
        chip.className = 'chip';
        var pn = placeName(m.place);
        chip.textContent = host.t('kind.' + m.tkind) + (pn ? ' · ' + pn : '');
        foot.appendChild(chip);
        if (m.place && PLACES.indexOf(m.place.id) >= 0) {
          var go = document.createElement('button');
          go.type = 'button';
          go.className = 'go';
          go.setAttribute('data-place', m.place.id);
          go.textContent = host.t('go');
          foot.appendChild(go);
        }
        li.appendChild(foot);
      }
      if (window.MutationObserver) {
        new MutationObserver(function (recs) {
          recs.forEach(function (r) {
            for (var i = 0; i < r.addedNodes.length; i++) decorate(r.addedNodes[i]);
          });
        }).observe(list, { childList: true });
      }
      list.addEventListener('click', function (e) {
        var t = e.target;
        var go = t && t.closest ? t.closest('button.go') : null;
        if (!go || !list.contains(go)) return;
        var id = go.getAttribute('data-place');
        if (PLACES.indexOf(id) >= 0) host.emit('goto', id);
      });

      /* ── 读更早：记下视线锚点，加载后把同一行放回原处 ── */
      function firstVisible() {
        var top = list.getBoundingClientRect().top;
        var rows = list.querySelectorAll('li[data-mid]');
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i].getBoundingClientRect();
          if (r.bottom > top + 1) return { mid: rows[i].getAttribute('data-mid'), off: r.top - top };
        }
        return null;
      }
      function applyRestore(a) {
        if (!a) return;
        var rows = list.querySelectorAll('li[data-mid]');
        var li = null;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute('data-mid') === a.mid) {
            li = rows[i];
            break;
          }
        }
        if (!li) return;
        var delta = li.getBoundingClientRect().top - list.getBoundingClientRect().top - a.off;
        if (delta) list.scrollTop += delta;
        jump.hidden = true;
      }
      olderBtn.addEventListener('click', function () {
        if (olderBtn.disabled) return;
        usedOlder = true;
        restore = firstVisible();
        host.emit('older');
      });

      function pruneMeta() {
        var keys = Object.keys(meta);
        if (keys.length <= META_KEEP + 100) return;
        keys
          .map(Number)
          .sort(function (a, b) {
            return a - b;
          })
          .slice(0, keys.length - META_KEEP)
          .forEach(function (k) {
            delete meta[k];
          });
      }

      function renderStrip(st) {
        var text = '';
        var showOlder = false;
        var busy = false;
        if (st.loadErr) text = host.t('loadErr');
        else if (st.loading) text = host.t('loading');
        else if (st.atCap) text = host.t('atCap');
        else if (st.hasOlder) {
          showOlder = true;
          busy = !!st.olderBusy;
        } else if (usedOlder) text = host.t('end');
        stripText.textContent = text;
        olderBtn.hidden = !showOlder;
        olderBtn.disabled = busy;
        olderBtn.textContent = host.t(busy ? 'olderBusy' : 'older');
        strip.hidden = !(text || showOlder);
      }

      return {
        onFeed: function (k, data) {
          if (k === 'state') {
            lastState = data || {};
            muted = !!lastState.muted;
            me = String(lastState.me || '');
            renderMute();
            renderStrip(lastState);
            var enable = !!lastState.canSend;
            kindBtns.forEach(function (b) {
              b.disabled = !enable;
            });
            placeSel.disabled = !enable;
            kit.setState(lastState);
          } else if (k === 'append') {
            var items = data && Array.isArray(data.items) ? data.items : [];
            items.forEach(function (it) {
              if (!it || typeof it.id !== 'number') return;
              var p = it.place && typeof it.place === 'object' && PLACES.indexOf(it.place.id) >= 0 ? { id: it.place.id, name: typeof it.place.name === 'string' ? it.place.name : '' } : null;
              meta[it.id] = { tkind: KINDS.indexOf(it.tkind) >= 0 ? it.tkind : 'chat', place: p, mention: !it.mine && mentionsMe(it.text, me) };
            });
            pruneMeta();
            /* 静音时一律当历史处理：kit 就不计未读（已有的未读保留到打开） */
            kit.append(items, !!(data && data.live) && !muted);
            if (data && data.older) {
              var a = restore;
              restore = null;
              requestAnimationFrame(function () {
                applyRestore(a);
                requestAnimationFrame(function () {
                  applyRestore(a);
                });
              });
            }
          } else if (k === 'ack') {
            kit.onAck(data);
            if (data && data.ok) resetCompose();
          } else if (k === 'reset') {
            kit.reset();
            meta = {};
            usedOlder = false;
            restore = null;
            muted = false;
            me = '';
            lastState = null;
            renderMute();
            resetCompose();
            strip.hidden = true;
            stripText.textContent = '';
            olderBtn.hidden = true;
          } else if (k === 'rebuild') {
            /* 游标过期，整体重读：只清列表和序号。发送中、限流倒计时、提示、ArrowUp 历史、草稿都留着（不走 kit.reset） */
            kit.clearList();
            meta = {};
            restore = null;
          }
        },
        onCore: function () {},
        onShow: function () {
          kit.onShow();
        },
        onHide: function () {},
        forceSend: function (text) {
          kit.forceSend(text);
        },
        debug: function () {
          var d = kit.debug();
          d.muted = muted;
          d.kind = kind;
          d.place = place;
          d.meta = Object.keys(meta).length;
          d.usedOlder = usedOlder;
          d.st = lastState;
          return d;
        },
      };
    },
  });
})();
