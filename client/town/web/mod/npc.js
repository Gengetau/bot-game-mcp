/* NPC 服务菜单（点一个 NPC 出一块小木牌：话题按钮、它的回话、有货架的还有「买」）。
 * 不是页签：.dock-pane 只是文字库的容器（hidden），真正的菜单是 #tpl-npc-menu 克隆出来挂在 #dockOverlays 上的一块小名牌纸，同居民卡一个路数。
 * feed 的 kind：state（整份：open / id / name / role / ctl / topics / answer / msg / shop / shopClosed / busy / cool / far / walking）、ack（一次动作的回应）、reset（离开 / 换人）。
 * 事件回 Godot：close、ask（话题编号）、buy（JSON {sku, qty}）、walk。
 * 文字都在 npc.html 的文字库里（host.t），这个文件里没有汉字字面量（lint 检查）。服务器给的文字一律 textContent，类名只用白名单，data-* 只放过滤后的编号。 */
(function () {
  'use strict';
  window.TownDock.register({
    id: 'npc',
    api: 1,
    mount: function (host) {
      var T = host.t;
      var safeId = function (s) {
        return String(s == null ? '' : s).replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80);
      };
      var overlays = document.getElementById('dockOverlays');
      var tplMenu = document.getElementById('tpl-npc-menu');
      var tplGood = document.getElementById('tpl-npc-good');
      var menu = null;
      if (overlays && tplMenu) {
        var frag = tplMenu.content.cloneNode(true);
        menu = frag.querySelector('.npc-menu');
        if (menu) overlays.appendChild(menu);
      }
      if (!menu) console.error('[npc] menu container or template missing; menu disabled');
      if (host.root) host.root.setAttribute('role', 'dialog');
      var q = function (r) {
        return menu ? menu.querySelector('[data-role="' + r + '"]') : null;
      };

      /* 名牌上的「店」「闲」小标记：文字在文字库里，用 CSS 变量交给样式（::after 的 content） */
      function cssStr(s) {
        var plain = String(s).split(String.fromCharCode(34)).join('').split(String.fromCharCode(92)).join('').split(String.fromCharCode(10)).join('');
        return String.fromCharCode(34) + plain + String.fromCharCode(34);
      }
      try {
        document.documentElement.style.setProperty('--npc-mark-service', cssStr(T('mark.service')));
        document.documentElement.style.setProperty('--npc-mark-ambient', cssStr(T('mark.ambient')));
      } catch (e) {
        /* ignore */
      }

      var S = { open: false, ctl: '' };
      var qty = {}; /* sku -> 要买几份 */
      var lastClick = { ask: 0, buy: 0 };
      var localBusy = { ask: false, buy: false };
      var busyTimer = { ask: 0, buy: 0 };
      var coolAt = 0;
      var coolTimer = 0;
      var lastTopicsKey = '';
      var lastGoodsKey = '';
      var openedId = '';

      function setLocalBusy(verb, b) {
        localBusy[verb] = b;
        clearTimeout(busyTimer[verb]);
        if (b)
          busyTimer[verb] = setTimeout(function () {
            localBusy[verb] = false;
            renderButtons();
          }, 15000);
      }

      /* ── 位置：贴在 #bottombar 上沿之上（同居民卡） ── */
      function place() {
        if (!menu) return;
        var bb = document.getElementById('bottombar');
        if (!bb) return;
        var top = bb.getBoundingClientRect().top;
        menu.style.setProperty('--npc-bottom', Math.max(8, Math.round(window.innerHeight - top + 8)) + 'px');
      }
      if (window.ResizeObserver && document.getElementById('bottombar')) {
        try {
          new ResizeObserver(place).observe(document.getElementById('bottombar'));
        } catch (e) {
          /* ignore */
        }
      }
      window.addEventListener('resize', place);
      if (window.MutationObserver) {
        try {
          new MutationObserver(place).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
          new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ['data-dock-open', 'data-dock', 'data-kb'] });
        } catch (e) {
          /* ignore */
        }
      }

      function coolLeft() {
        return coolAt > Date.now() ? Math.ceil((coolAt - Date.now()) / 1000) : 0;
      }

      /* ── 渲染 ── */
      function renderTopics() {
        var box = q('topics');
        if (!box) return;
        var list = S.topics || [];
        var key = JSON.stringify(list);
        if (key === lastTopicsKey) return;
        lastTopicsKey = key;
        box.textContent = '';
        list.forEach(function (t) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'npc-btn npc-topic';
          b.setAttribute('data-topic', safeId(t.id));
          b.textContent = String(t.label);
          b.addEventListener('click', function (e) {
            act('ask', safeId(t.id), e);
          });
          box.appendChild(b);
        });
      }
      function clampQty(sku, stock) {
        var n = qty[sku] | 0;
        if (n < 1) n = 1;
        var hi = 10;
        if (stock > 0 && stock < hi) hi = stock;
        if (n > hi) n = hi;
        qty[sku] = n;
        return n;
      }
      function renderGoods() {
        var shop = q('shop');
        var ul = q('goods');
        var sh = S.shop;
        if (shop) shop.hidden = !sh;
        if (!sh || !ul || !tplGood) {
          lastGoodsKey = '';
          return;
        }
        q('shopTitle').textContent = T('shop.title');
        var key = JSON.stringify(sh.goods || []) + '|' + JSON.stringify(qty);
        if (key === lastGoodsKey) return;
        lastGoodsKey = key;
        ul.textContent = '';
        (sh.goods || []).forEach(function (g) {
          var li = tplGood.content.firstElementChild.cloneNode(true);
          var sku = safeId(g.sku);
          li.setAttribute('data-sku', sku);
          li.querySelector('[data-role="gname"]').textContent = String(g.name);
          li.querySelector('[data-role="gprice"]').textContent = T('shop.price', { n: g.price });
          var soldout = (g.stock | 0) <= 0;
          li.querySelector('[data-role="gstock"]').textContent = soldout ? T('shop.soldout') : T('shop.stock', { n: g.stock });
          var n = clampQty(sku, g.stock | 0);
          li.querySelector('[data-role="qn"]').textContent = String(n);
          var dec = li.querySelector('[data-role="dec"]');
          var inc = li.querySelector('[data-role="inc"]');
          var buy = li.querySelector('[data-role="buy"]');
          dec.textContent = T('qty.dec');
          inc.textContent = T('qty.inc');
          dec.setAttribute('aria-label', T('qty.dec.label'));
          inc.setAttribute('aria-label', T('qty.inc.label'));
          buy.textContent = T('btn.buy');
          dec.addEventListener('click', function (e) {
            qty[sku] = Math.max(1, (qty[sku] | 0) - 1);
            lastGoodsKey = '';
            renderGoods();
            if (e.detail !== 0) dec.blur();
          });
          inc.addEventListener('click', function (e) {
            qty[sku] = clampQty(sku, g.stock | 0) + 1;
            clampQty(sku, g.stock | 0);
            lastGoodsKey = '';
            renderGoods();
            if (e.detail !== 0) inc.blur();
          });
          buy.addEventListener('click', function (e) {
            act('buy', JSON.stringify({ sku: sku, qty: clampQty(sku, g.stock | 0) }), e);
          });
          ul.appendChild(li);
        });
        renderButtons();
      }
      function blockedNote() {
        if (S.ctl === 'readonly') return T('note.readonly');
        if (S.ctl === 'game') return T('note.game');
        if (S.ctl === 'offline') return T('note.offline');
        return '';
      }
      function msgText() {
        var m = S.msg;
        if (!m) return { text: '', kind: '' };
        if (m.kind === 'ok') return { text: String(m.text || ''), kind: 'ok' };
        var c = String(m.code || '');
        if (c === 'rate_limited') {
          var n = coolLeft();
          return { text: n > 0 ? T('err.rate_limited', { n: n }) : T('err.rate_limited.nosec'), kind: 'warn' };
        }
        if (c === 'net') return { text: T(m.scope === 'buy' ? 'err.net.buy' : 'err.net.ask'), kind: 'err' };
        if (c === 'too_far') return { text: m.text ? String(m.text) : T('err.too_far'), kind: 'warn' };
        return { text: m.text ? String(m.text) : T('err.default'), kind: 'err' };
      }
      function renderButtons() {
        if (!menu) return;
        var blocked = !!S.ctl;
        var busy = S.busy || {};
        var cooling = coolLeft() > 0;
        menu.querySelectorAll('.npc-topic').forEach(function (b) {
          b.disabled = blocked || !!busy.ask || localBusy.ask || cooling;
        });
        menu.querySelectorAll('.npc-good').forEach(function (li) {
          var stockOut = li.querySelector('[data-role="gstock"]').textContent === T('shop.soldout');
          li.querySelector('[data-role="buy"]').disabled = blocked || !!busy.buy || localBusy.buy || !!S.shopClosed || stockOut;
        });
      }
      function renderNote() {
        var note = q('note');
        if (!note) return;
        var text = blockedNote();
        var kind = '';
        if (!text) {
          var m = msgText();
          text = m.text;
          kind = m.kind;
        }
        if (!text && S.walking) text = T('note.walking');
        else if (!text && S.far) text = T('note.far');
        note.textContent = text;
        note.className = 'npc-note' + (kind ? ' ' + kind : '');
      }
      function render() {
        if (!menu) return;
        var show = !!S.open && host.core().phase === 'playing';
        var was = menu.hidden;
        menu.hidden = !show;
        if (!show) {
          openedId = '';
          return;
        }
        if (was) place();
        menu.setAttribute('data-id', safeId(S.id));
        menu.setAttribute('data-role-kind', safeId(S.role));
        q('name').textContent = String(S.name || '');
        q('mark').textContent = T(S.role === 'service' ? 'mark.service' : 'mark.ambient');
        q('who').textContent = T(S.role === 'service' ? 'role.service' : 'role.ambient');
        q('topicsTitle').textContent = T('topics.title');
        var ans = q('answer');
        ans.textContent = S.answer && S.answer.text ? String(S.answer.text) : T('answer.empty');
        ans.className = 'npc-answer' + (S.answer && S.answer.text ? '' : ' empty');
        renderTopics();
        renderGoods();
        var closed = q('closed');
        if (closed) {
          closed.hidden = !S.shopClosed;
          closed.textContent = S.shopClosed ? T('shop.closed') : '';
        }
        var row = q('walkRow');
        if (row) {
          row.hidden = !(S.far && !S.walking && !S.ctl);
          q('walk').textContent = T('btn.walk');
        }
        renderNote();
        renderButtons();
        /* 刚打开：键盘用户直接落在第一个话题上；触屏不弹焦点环 */
        if (was || openedId !== S.id) {
          openedId = S.id;
          var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
          if (!coarse) {
            var first = menu.querySelector('.npc-topic');
            if (first && !first.disabled)
              try {
                first.focus({ preventScroll: true });
              } catch (e) {
                /* ignore */
              }
          }
        }
      }
      function startCool() {
        clearTimeout(coolTimer);
        var n = coolLeft();
        if (n <= 0) return;
        coolTimer = setTimeout(function () {
          renderNote();
          renderButtons();
          startCool();
        }, 1000);
      }

      /* ── 点击 ── */
      function act(verb, arg, e) {
        if (!S.open) return;
        var now = Date.now();
        if (localBusy[verb] || now - lastClick[verb] < 700) return;
        lastClick[verb] = now;
        setLocalBusy(verb, true);
        host.emit(verb, arg);
        renderButtons();
        if (e && e.detail !== 0 && e.currentTarget) e.currentTarget.blur();
      }
      if (menu) {
        q('close').addEventListener('click', function (e) {
          host.emit('close');
          if (e.detail !== 0) q('close').blur();
        });
        q('walk').addEventListener('click', function (e) {
          host.emit('walk');
          if (e.detail !== 0) q('walk').blur();
        });
      }
      /* Esc：同居民卡（地点菜单开着时它先关；输入框里不管；卡片被 CSS 藏起来时不算开着）。不拦截，hud.js 照常发 esc */
      var menuEl = document.getElementById('destMenu');
      var destOpen = !!(menuEl && !menuEl.hidden);
      if (menuEl && window.MutationObserver) {
        new MutationObserver(function () {
          var o = !menuEl.hidden;
          setTimeout(function () {
            destOpen = o;
          }, 0);
        }).observe(menuEl, { attributes: true, attributeFilter: ['hidden'] });
      }
      window.addEventListener(
        'keydown',
        function (e) {
          if (e.key !== 'Escape' || !menu || menu.hidden || destOpen) return;
          if (window.getComputedStyle(menu).display === 'none') return;
          var a = document.activeElement;
          if (a && a.tagName && /^(input|textarea|select)$/i.test(a.tagName)) return;
          host.emit('close');
        },
        true,
      );

      function onAck(a) {
        if (!a) return;
        if (a.verb === 'ask' || a.verb === 'buy') setLocalBusy(a.verb, false);
        /* 买失败（数量被服务器打回）时把数量退回 1，免得下一次还是同一个错数 */
        if (a.verb === 'buy' && a.code === 'bad_request' && a.sku) qty[safeId(a.sku)] = 1;
        lastGoodsKey = '';
      }

      function reset() {
        S = { open: false, ctl: '' };
        qty = {};
        ['ask', 'buy'].forEach(function (v) {
          clearTimeout(busyTimer[v]);
          localBusy[v] = false;
          lastClick[v] = 0;
        });
        clearTimeout(coolTimer);
        coolAt = 0;
        lastTopicsKey = '';
        lastGoodsKey = '';
        openedId = '';
        if (menu) menu.hidden = true;
      }

      return {
        onFeed: function (kind, data) {
          if (kind === 'state' && data) {
            var prevCool = coolLeft();
            S = data;
            if (!S.open) {
              qty = {};
              lastTopicsKey = '';
              lastGoodsKey = '';
            }
            var cl = S.cool | 0;
            if (cl > 0 && (prevCool === 0 || Math.abs(cl - prevCool) > 1)) coolAt = Date.now() + cl * 1000;
            else if (cl === 0) coolAt = 0;
            /* 已经没有请求在路上：本地的防连点也放开 */
            if (S.busy) {
              if (!S.busy.ask) setLocalBusy('ask', false);
              if (!S.busy.buy) setLocalBusy('buy', false);
            }
            lastGoodsKey = '';
            render();
            startCool();
          } else if (kind === 'ack') {
            onAck(data);
            render();
          } else if (kind === 'reset') reset();
        },
        onCore: function () {
          render();
        },
        debug: function () {
          var topics = [];
          if (menu)
            menu.querySelectorAll('.npc-topic').forEach(function (b) {
              topics.push({ id: b.getAttribute('data-topic'), disabled: b.disabled });
            });
          var goods = [];
          if (menu)
            menu.querySelectorAll('.npc-good').forEach(function (li) {
              goods.push({ sku: li.getAttribute('data-sku'), qty: li.querySelector('[data-role="qn"]').textContent, buyDisabled: li.querySelector('[data-role="buy"]').disabled, stock: li.querySelector('[data-role="gstock"]').textContent });
            });
          var open = !!(menu && !menu.hidden);
          return {
            open: open,
            id: open ? menu.getAttribute('data-id') : '',
            name: open && q('name') ? q('name').textContent : '',
            mark: open && q('mark') ? q('mark').textContent : '',
            who: open && q('who') ? q('who').textContent : '',
            answer: open && q('answer') ? q('answer').textContent : '',
            note: open && q('note') ? q('note').textContent : '',
            noteKind: open && q('note') ? q('note').className : '',
            topics: topics,
            goods: goods,
            shopOpen: !!(menu && q('shop') && !q('shop').hidden),
            closedText: open && q('closed') && !q('closed').hidden ? q('closed').textContent : '',
            walkVisible: !!(menu && q('walkRow') && !q('walkRow').hidden),
            rect: open ? menu.getBoundingClientRect().toJSON() : null,
            cool: coolLeft(),
            text: open ? menu.textContent : '',
          };
        },
      };
    },
  });
})();
