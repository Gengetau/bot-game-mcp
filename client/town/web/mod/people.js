/* 人家（页签「人家」）+ 居民卡。
 * 页签放长列表：请柬、会馆门牌、屋里；居民卡不是页签，是挂在 #dockOverlays 上的一块小名牌纸（点人随手出卡，不占抽屉）。
 * feed 的 kind：state（整份：card / doors / home / invites / freshCount / ctl / reach）、ack（一次动作的回应）、open（打开面板）、reset（离开 / 换人）。
 * 文字都在 people.html 的文字库里（host.t），这个文件里没有汉字字面量（lint 检查）。玩家文字一律 textContent，类名只用白名单，data-* 只放过滤后的编号。 */
(function () {
  'use strict';
  window.TownDock.register({
    id: 'people',
    api: 1,
    mount: function (host) {
      var $ = function (r) {
        return host.q('[data-role="' + r + '"]');
      };
      var safeId = function (s) {
        return String(s == null ? '' : s).replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 80);
      };
      var overlays = document.getElementById('dockOverlays');
      var tplCard = document.getElementById('tpl-people-card');
      var tplDoor = document.getElementById('tpl-people-door');
      var tplInvite = document.getElementById('tpl-people-invite');
      var card = null;
      if (overlays && tplCard) {
        var frag = tplCard.content.cloneNode(true);
        card = frag.querySelector('.people-card');
        if (card) overlays.appendChild(card);
      }
      if (!card) console.error('[people] card container or template missing; card disabled');
      var q = function (r) {
        return card ? card.querySelector('[data-role="' + r + '"]') : null;
      };

      var S = { ctl: '', card: null, doors: null, home: null, invites: [], freshCount: 0 };
      var seq = 0;
      var busy = { ask: false, invite: false };
      var busyTimer = { ask: 0, invite: 0 };
      var lastClick = { ask: 0, invite: 0 };
      var cool = { ask: 0, invite: 0 };
      var coolTimer = { ask: 0, invite: 0 };
      var hint = { text: '', kind: '', id: '' };
      var lastDoorsKey = '';
      var lastInvKey = '';
      var lastHomeKey = '';
      var hobbyById = {};

      var T = host.t;
      var names = function (arr) {
        return (arr || []).join(T('hobby.sep'));
      };

      /* ── 卡片位置：贴在 #bottombar 上沿之上 ── */
      function placeCard() {
        if (!card) return;
        var bb = document.getElementById('bottombar');
        if (!bb) return;
        var top = bb.getBoundingClientRect().top;
        var bottom = Math.max(8, Math.round(window.innerHeight - top + 8));
        card.style.setProperty('--people-bottom', bottom + 'px');
      }
      if (window.ResizeObserver && document.getElementById('bottombar')) {
        try {
          new ResizeObserver(placeCard).observe(document.getElementById('bottombar'));
        } catch (e) {
          /* ignore */
        }
      }
      window.addEventListener('resize', placeCard);
      /* 抽屉开合会抬高 #bottombar（改的是 --dock-h 和 body 的属性，#bottombar 自己的尺寸不变，ResizeObserver 看不到）：监听这两处 */
      if (window.MutationObserver) {
        try {
          new MutationObserver(placeCard).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
          new MutationObserver(placeCard).observe(document.body, { attributes: true, attributeFilter: ['data-dock-open', 'data-dock', 'data-kb'] });
        } catch (e) {
          /* ignore */
        }
      }

      function setHint(text, kind, id) {
        hint = { text: text || '', kind: kind || '', id: id || '' };
        var el = q('hint');
        if (!el) return;
        el.textContent = hint.text;
        el.className = 'people-hint' + (kind === 'ok' || kind === 'warn' || kind === 'err' ? ' ' + kind : '');
      }

      function setBusy(verb, b) {
        busy[verb] = b;
        clearTimeout(busyTimer[verb]);
        if (b)
          busyTimer[verb] = setTimeout(function () {
            busy[verb] = false;
            renderButtons();
          }, 15000);
      }

      /* ── 居民卡 ── */
      function chips(box, list, cls) {
        if (!box) return;
        box.textContent = '';
        (list || []).forEach(function (t) {
          var s = document.createElement('span');
          s.className = cls;
          s.textContent = String(t);
          box.appendChild(s);
        });
        box.hidden = !(list && list.length);
      }
      function localNote(c) {
        if (S.ctl === 'readonly') return T('note.readonly');
        if (S.ctl === 'game') return T('note.game');
        if (S.ctl === 'offline') return T('note.offline');
        if (c.busy) return T('note.busy');
        if (c.walking) return T('note.walking');
        if (!c.near) return T('note.far');
        return '';
      }
      function renderButtons() {
        var c = S.card;
        var ask = q('ask');
        var inv = q('invite');
        if (!c || !ask || !inv) return;
        var now = Date.now();
        var blocked = !!S.ctl || !!c.busy;
        ask.disabled = blocked || busy.ask || now < cool.ask;
        var invited = !!c.invited;
        inv.textContent = T(invited ? 'btn.invited' : 'btn.invite');
        inv.disabled = blocked || busy.invite || invited || now < cool.invite;
        var left = q('invleft');
        if (left) {
          if (invited) {
            var hours = Math.ceil(c.invited.mins / 60);
            left.textContent = c.invited.mins <= 60 ? T('invited.soon') : T('invited.left', { n: hours });
          } else left.textContent = '';
        }
      }
      function renderCard() {
        if (!card) return;
        var c = S.card;
        var show = !!c && host.core().phase === 'playing';
        var wasHidden = card.hidden;
        card.hidden = !show;
        if (!show) {
          if (!wasHidden) {
            setHint('', '', '');
            hobbyById = {};
          }
          return;
        }
        if (wasHidden) placeCard();
        if (hint.id && hint.id !== c.id) setHint('', '', '');
        card.setAttribute('data-id', safeId(c.id));
        q('name').textContent = c.name;
        var kind = q('kind');
        var isAi = c.kind === 'agent';
        kind.textContent = T(isAi ? 'kind.ai' : 'kind.human');
        kind.className = 'people-kind ' + (isAi ? 'ai' : 'human');
        chips(q('titles'), c.titles, 'people-seal');
        chips(q('traits'), c.traits, 'people-trait');
        var mood = q('mood');
        mood.hidden = !c.mood;
        mood.textContent = c.mood ? T('mood', { mood: c.mood }) : '';
        var bio = q('bio');
        bio.hidden = !c.bio;
        bio.textContent = c.bio || '';
        var hb = q('hobby');
        var list = c.hobby || hobbyById[c.id] || null;
        if (list) {
          hb.hidden = false;
          hb.textContent = list.length ? T('hobby.has', { list: names(list) }) : T('hobby.none');
        } else {
          hb.hidden = true;
          hb.textContent = '';
        }
        q('note').textContent = localNote(c);
        renderButtons();
      }

      /* ── 请柬、门牌、屋里 ── */
      function leftText(mins) {
        return mins <= 60 ? T('invite.left.soon') : T('invite.left.hours', { n: Math.ceil(mins / 60) });
      }
      function kindBadge(el, k) {
        el.textContent = T(k === 'agent' ? 'kind.ai' : 'kind.human');
        el.className = 'people-kind ' + (k === 'agent' ? 'ai' : 'human');
      }
      function renderInvites() {
        var list = S.invites || [];
        var key = JSON.stringify(list);
        $('invites').hidden = list.length === 0;
        if (key === lastInvKey) return;
        lastInvKey = key;
        var ol = $('inviteList');
        ol.textContent = '';
        if (!tplInvite) return;
        list.forEach(function (iv) {
          var li = tplInvite.content.firstElementChild.cloneNode(true);
          li.setAttribute('data-grant', safeId(iv.grantId));
          li.setAttribute('data-home', safeId(iv.home));
          if (iv.fresh) li.classList.add('fresh');
          li.querySelector('[data-role="host"]').textContent = iv.hostName;
          kindBadge(li.querySelector('[data-role="kind"]'), iv.hostKind);
          li.querySelector('[data-role="left"]').textContent = leftText(iv.mins);
          var go = li.querySelector('[data-role="go"]');
          go.textContent = T('btn.go');
          go.addEventListener('click', function () {
            host.emit('visit', safeId(iv.home));
            go.blur();
          });
          var skip = li.querySelector('[data-role="skip"]');
          if (iv.fresh) {
            skip.textContent = T('btn.skip');
            skip.addEventListener('click', function () {
              host.emit('dismiss', safeId(iv.grantId));
              skip.blur();
            });
          } else skip.hidden = true;
          ol.appendChild(li);
        });
      }
      function renderDoors() {
        var list = S.doors;
        $('doors').hidden = !list;
        var key = JSON.stringify(list);
        if (key === lastDoorsKey) return;
        lastDoorsKey = key;
        var ol = $('doorList');
        ol.textContent = '';
        if (!list || !tplDoor) return;
        list.forEach(function (d) {
          var li = tplDoor.content.firstElementChild.cloneNode(true);
          li.setAttribute('data-home', safeId(d.home));
          li.setAttribute('data-can', d.can ? '1' : '0');
          li.setAttribute('data-mine', d.mine ? '1' : '0');
          li.querySelector('[data-role="addr"]').textContent = T('door.addr', { lane: d.lane, no: d.no });
          li.querySelector('[data-role="owner"]').textContent = d.mine ? T('door.mine') : T('door.owner', { name: d.ownerName });
          var b = li.querySelector('[data-role="enter"]');
          b.textContent = d.mine ? T('door.home') : d.can ? T('door.enter') : T('door.locked');
          b.disabled = !d.mine && !d.can;
          b.addEventListener('click', function () {
            host.emit('visit', safeId(d.home));
            b.blur();
          });
          ol.appendChild(li);
        });
      }
      function renderHome() {
        var h = S.home;
        $('house').hidden = !h;
        var key = JSON.stringify(h);
        if (key === lastHomeKey) return;
        lastHomeKey = key;
        if (!h) return;
        $('houseTitle').textContent = h.mine ? T('house.mine') : T('house.title', { name: h.ownerName });
        $('houseTag').textContent = T(h.mine ? 'tag.owner' : 'tag.guest');
        $('houseTag').className = 'people-tag ' + (h.mine ? 'owner' : 'guest');
        var who = (h.others || []).map(function (o) {
          return o.name;
        });
        $('houseWho').textContent = who.length ? T('house.who', { list: names(who) }) : T('house.alone');
        var ul = $('decor');
        ul.textContent = '';
        (h.decor || []).forEach(function (t) {
          var li = document.createElement('li');
          li.textContent = String(t);
          ul.appendChild(li);
        });
        $('decorEmpty').hidden = !!(h.decor && h.decor.length);
        ul.hidden = !(h.decor && h.decor.length);
      }
      function renderAll() {
        renderCard();
        renderInvites();
        renderDoors();
        renderHome();
        var empty = !S.home && !(S.invites && S.invites.length) && !S.doors;
        $('empty').hidden = !empty;
        host.setUnread(S.freshCount | 0);
      }

      /* ── 卡片上的按钮 ── */
      function act(verb) {
        var c = S.card;
        if (!c) return;
        var now = Date.now();
        if (busy[verb] || now - lastClick[verb] < 800) return;
        var b = q(verb);
        if (b && b.disabled) return;
        lastClick[verb] = now;
        setBusy(verb, true);
        seq++;
        host.emit(verb, JSON.stringify({ n: seq, id: c.id }));
        renderButtons();
        if (b) b.blur();
      }
      if (card) {
        q('ask').addEventListener('click', function () {
          act('ask');
        });
        q('invite').addEventListener('click', function () {
          act('invite');
        });
        q('close').addEventListener('click', function () {
          host.emit('close');
          q('close').blur();
        });
      }
      /* Esc 关卡：不拦截，hud.js 照常发 esc 让走路中的角色也停下 */
      window.addEventListener(
        'keydown',
        function (e) {
          if (e.key !== 'Escape' || !card || card.hidden) return;
          var a = document.activeElement;
          if (a && a.tagName && /^(input|textarea|select)$/i.test(a.tagName)) return;
          host.emit('close');
        },
        true,
      );
      var leave = $('leave');
      if (leave)
        leave.addEventListener('click', function () {
          host.emit('leave_home');
          leave.blur();
        });

      function onAck(a) {
        if (!a) return;
        if (a.verb === 'walk') {
          if (S.card && S.card.id === a.id) setHint(T('note.arrived'), 'ok', a.id);
          return;
        }
        var verb = a.verb === 'invite' ? 'invite' : 'ask';
        setBusy(verb, false);
        if (a.stale) {
          renderButtons();
          return;
        }
        var cid = a.id;
        if (a.ok) {
          if (verb === 'ask') hobbyById[cid] = a.interests || [];
          setHint('', '', cid);
        } else {
          var text = '';
          var kind = 'warn';
          if (a.message) text = a.message;
          else if (a.code === 'readonly') text = T('note.readonly');
          else if (a.code === 'game') text = T('note.game');
          else if (a.code === 'offline') text = T('note.offline');
          else if (a.code === 'busy') text = T('note.busy');
          else if (a.code === 'invited') text = T('note.invited');
          else if (a.code === 'net') {
            text = T('err.net');
            kind = 'err';
          } else {
            text = T('err.default');
            kind = 'err';
          }
          setHint(text, kind, cid);
          if (a.retryMs > 0) {
            cool[verb] = Date.now() + Math.ceil(a.retryMs / 1000) * 1000;
            clearTimeout(coolTimer[verb]);
            coolTimer[verb] = setTimeout(function () {
              cool[verb] = 0;
              renderButtons();
            }, Math.ceil(a.retryMs / 1000) * 1000 + 50);
          }
        }
        renderCard();
      }

      function reset() {
        S = { ctl: '', card: null, doors: null, home: null, invites: [], freshCount: 0 };
        ['ask', 'invite'].forEach(function (v) {
          clearTimeout(busyTimer[v]);
          clearTimeout(coolTimer[v]);
          busy[v] = false;
          cool[v] = 0;
          lastClick[v] = 0;
        });
        hobbyById = {};
        lastDoorsKey = '';
        lastInvKey = '';
        lastHomeKey = '';
        setHint('', '', '');
        $('inviteList').textContent = '';
        $('doorList').textContent = '';
        if (card) card.hidden = true;
        renderAll();
      }

      /* 测试钩子：仅 ?debug=1。绕过按钮的 disabled 和这一侧的防连点 */
      if (window.TownDock && window.TownDock.test) {
        window.TownDock.test.people = {
          forceVisit: function (home) {
            host.emit('visit', String(home));
          },
          forceAsk: function (id) {
            seq++;
            host.emit('ask', JSON.stringify({ n: seq, id: String(id) }));
          },
          forceInvite: function (id) {
            seq++;
            host.emit('invite', JSON.stringify({ n: seq, id: String(id) }));
          },
        };
      }

      return {
        onFeed: function (kind, data) {
          if (kind === 'state' && data) {
            S = data;
            renderAll();
          } else if (kind === 'ack') onAck(data);
          else if (kind === 'open') host.open();
          else if (kind === 'reset') reset();
        },
        onCore: function () {
          renderCard();
        },
        onShow: function () {
          host.emit('seen');
        },
        onHide: function () {},
        debug: function () {
          var c = S.card;
          var r = card && !card.hidden ? card.getBoundingClientRect().toJSON() : null;
          var ask = q('ask');
          var inv = q('invite');
          var doors = [];
          host.root.querySelectorAll('[data-role="doorList"] > li').forEach(function (li) {
            var b = li.querySelector('[data-role="enter"]');
            doors.push({ home: li.getAttribute('data-home'), can: li.getAttribute('data-can') === '1', mine: li.getAttribute('data-mine') === '1', enterDisabled: !!(b && b.disabled), enterText: b ? b.textContent : '' });
          });
          var invites = [];
          host.root.querySelectorAll('[data-role="inviteList"] > li').forEach(function (li) {
            invites.push({ grantId: li.getAttribute('data-grant'), home: li.getAttribute('data-home'), fresh: li.classList.contains('fresh'), skip: !li.querySelector('[data-role="skip"]').hidden });
          });
          var kind = q('kind');
          return {
            cardOpen: !!(card && !card.hidden),
            cardId: c ? c.id : '',
            kind: kind ? (kind.classList.contains('ai') ? 'ai' : kind.classList.contains('human') ? 'human' : '') : '',
            kindText: kind ? kind.textContent : '',
            name: q('name') ? q('name').textContent : '',
            hint: hint.text,
            hintKind: hint.kind,
            note: q('note') ? q('note').textContent : '',
            askDisabled: !!(ask && ask.disabled),
            inviteDisabled: !!(inv && inv.disabled),
            inviteText: inv ? inv.textContent : '',
            invleft: q('invleft') ? q('invleft').textContent : '',
            hobby: q('hobby') && !q('hobby').hidden ? q('hobby').textContent : '',
            text: card && !card.hidden ? card.textContent : '',
            rect: r,
            doors: doors,
            invites: invites,
            houseOpen: !!S.home,
            houseMine: !!(S.home && S.home.mine),
            houseTitle: S.home ? $('houseTitle').textContent : '',
            houseTag: S.home ? $('houseTag').textContent : '',
            houseDecor: S.home ? (S.home.decor || []).slice() : [],
            unread: S.freshCount | 0,
          };
        },
      };
    },
  });
})();
