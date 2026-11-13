/* 共同活动（页签「一起」）：只读，不放按钮（约人 / 加入 / 开始在 #actions，「停下手上的事」在 main 的状态条）。
 * feed 的 kind：state（整份替换：{mine, tables, last}，剩余时间都是相对毫秒，这里用 performance.now() 自己走）、reset（离开 / 换人）。
 * 玩家和服务器给的文字（名字、活动名、收获、投入说明）一律 textContent；类名和 data-* 只放白名单值。
 * 倒计时：收到 state 时记下 performance.now() + remainMs，1 秒一次的定时器刷新文字（面板不可见时不刷新，onShow 立即刷一次）；
 * 到 0 显示 00:00 而不是负数，等 Godot 的下一次 state 把这一桌收起。
 * 文字都在 activity.html 的文字库里，这个文件里没有汉字字面量（lint 检查）。 */
(function () {
  'use strict';
  window.TownDock.register({
    id: 'activity',
    api: 1,
    mount: function (host) {
      var q = function (role) {
        return host.q('[data-role="' + role + '"]');
      };
      var elMine = q('mine');
      var elTitle = q('title');
      var elWhere = q('where');
      var elStatus = q('status');
      var elNeed = q('need');
      var elPeople = q('people');
      var elRemain = q('remain');
      var elBarWrap = q('barwrap');
      var elBar = q('bar');
      var elCost = q('cost');
      var elTablesWrap = q('tableswrap');
      var elTablesH = q('tablesH');
      var elTables = q('tables');
      var elLast = q('last');
      var elLastH = q('lastH');
      var elLastName = q('lastName');
      var elLastText = q('lastText');
      var elEmpty = q('empty');
      var tpl = { person: document.getElementById('tpl-activity-person'), table: document.getElementById('tpl-activity-table') };
      var state = null;
      var t0 = 0; // 收到 state 时的 performance.now()
      var timer = 0;
      var barPct = null;

      function fmt(ms) {
        var s = Math.max(0, Math.ceil(ms / 1000));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
      }
      function left(ms) {
        return ms - (performance.now() - t0);
      }
      function sub(el, role) {
        return el.querySelector('[data-role="' + role + '"]');
      }
      function tmplNode(t) {
        return t.content.firstElementChild.cloneNode(true);
      }

      function remainText() {
        var m = state && state.mine;
        if (!m) return '';
        if (m.status === 'running') return m.remainMs >= 0 ? host.t('remain.running', { t: fmt(left(m.remainMs)) }) : '';
        return m.lobbyRemainMs >= 0 ? host.t('remain.open', { t: fmt(left(m.lobbyRemainMs)) }) : '';
      }
      function tableState(tb) {
        if (tb.status === 'running') return host.t('table.running', { t: fmt(left(tb.remainMs)) });
        var n = tb.people.length;
        if (tb.status === 'open') return n >= tb.min ? host.t('table.ready', { n: n, max: tb.max }) : host.t('table.open', { n: n, min: tb.min });
        return host.t('table.free');
      }
      /* 每秒刷新：只动文字和进度条，不重建列表 */
      function tick() {
        if (!state) return;
        if (state.mine) {
          elRemain.textContent = remainText();
          var m = state.mine;
          if (m.status === 'running' && m.totalMs > 0) {
            var pct = Math.max(0, Math.min(100, Math.round((1 - left(m.remainMs) / m.totalMs) * 100)));
            if (pct !== barPct) {
              barPct = pct;
              elBar.style.width = pct + '%';
            }
          }
        }
        var rows = elTables.children;
        for (var i = 0; i < rows.length; i++) {
          var tb = state.tables[i];
          if (tb && tb.status === 'running') sub(rows[i], 'state').textContent = tableState(tb);
        }
      }
      function ensureTimer() {
        if (timer) return;
        timer = setInterval(function () {
          if (host.isActive()) tick();
        }, 1000);
      }

      function renderPeople(list) {
        elPeople.textContent = '';
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          var li = tmplNode(tpl.person);
          li.setAttribute('data-id', String(p.id));
          sub(li, 'name').textContent = String(p.name);
          var ai = sub(li, 'ai');
          ai.hidden = p.kind !== 'agent';
          ai.textContent = host.t('tag.ai');
          var ini = sub(li, 'ini');
          ini.hidden = !p.initiator;
          ini.textContent = host.t('tag.ini');
          var you = sub(li, 'you');
          you.hidden = !p.you;
          you.textContent = host.t('tag.you');
          if (p.you) li.classList.add('me');
          elPeople.appendChild(li);
        }
      }
      function renderMine(m) {
        if (!m) {
          elMine.hidden = true;
          elPeople.textContent = '';
          barPct = null;
          return;
        }
        elMine.hidden = false;
        elTitle.textContent = String(m.name);
        elWhere.textContent = String(m.objectLabel || '');
        elStatus.setAttribute('data-status', m.status === 'running' ? 'running' : 'open');
        elStatus.textContent = host.t(m.status === 'running' ? 'status.running' : 'status.open');
        var n = m.people.length;
        var need;
        if (m.status === 'running') need = host.t('need.running');
        else if (n < m.min) need = host.t('need.lack', { n: m.min - n });
        else if (m.isInitiator) need = host.t('need.ready_ini');
        else need = host.t('need.wait_ini', { name: m.initiator });
        elNeed.textContent = need;
        renderPeople(m.people);
        elCost.textContent = String(m.cost || '');
        elCost.hidden = !m.cost;
        var showBar = m.status === 'running' && typeof m.startedAgoMs === 'number' && m.totalMs > 0;
        elBarWrap.hidden = !showBar;
        if (showBar) {
          barPct = Math.max(0, Math.min(100, Math.round((1 - left(m.remainMs) / m.totalMs) * 100)));
          elBar.style.width = barPct + '%';
        } else {
          barPct = null;
        }
        elRemain.textContent = remainText();
      }
      function renderTables(list) {
        elTables.textContent = '';
        for (var i = 0; i < list.length; i++) {
          var tb = list[i];
          var li = tmplNode(tpl.table);
          li.setAttribute('data-obj', String(tb.id));
          li.setAttribute('data-status', tb.status === 'running' || tb.status === 'open' ? tb.status : 'free');
          sub(li, 'name').textContent = String(tb.label);
          sub(li, 'state').textContent = tableState(tb);
          var names = [];
          for (var j = 0; j < tb.people.length; j++) names.push(String(tb.people[j].name));
          sub(li, 'who').textContent = names.join(host.t('table.sep'));
          var hint = '';
          if (!tb.near) {
            if (tb.status === 'open') hint = host.t('table.far_join');
            else if (tb.status === 'free') hint = host.t('table.far_start');
          }
          sub(li, 'hint').textContent = hint;
          elTables.appendChild(li);
        }
      }
      function render() {
        var s = state;
        if (!s) {
          elMine.hidden = true;
          elTablesWrap.hidden = true;
          elLast.hidden = true;
          elEmpty.hidden = true;
          elPeople.textContent = '';
          elTables.textContent = '';
          return;
        }
        t0 = performance.now();
        renderMine(s.mine);
        elTablesH.textContent = host.t('h.tables');
        elTablesWrap.hidden = !(s.tables && s.tables.length);
        renderTables(s.tables || []);
        if (s.last) {
          elLast.hidden = false;
          elLastH.textContent = host.t('h.last');
          elLastName.textContent = String(s.last.name);
          elLastText.textContent = String(s.last.text);
        } else {
          elLast.hidden = true;
        }
        var nothing = !s.mine && !(s.tables && s.tables.length) && !s.last;
        elEmpty.hidden = !nothing;
        elEmpty.textContent = nothing ? host.t('empty') : '';
        ensureTimer();
      }

      return {
        onFeed: function (kind, data) {
          if (kind === 'state' && data && typeof data === 'object') {
            state = {
              mine: data.mine && typeof data.mine === 'object' && Array.isArray(data.mine.people) ? data.mine : null,
              tables: Array.isArray(data.tables)
                ? data.tables.filter(function (x) {
                    return x && Array.isArray(x.people);
                  })
                : [],
              last: data.last && typeof data.last === 'object' ? data.last : null,
            };
            render();
          } else if (kind === 'reset') {
            state = null;
            barPct = null;
            render();
          }
        },
        onCore: function () {},
        onShow: function () {
          tick();
        },
        onHide: function () {},
        debug: function () {
          var rows = [];
          for (var i = 0; i < elTables.children.length; i++) {
            var r = elTables.children[i];
            rows.push({ obj: r.getAttribute('data-obj'), status: r.getAttribute('data-status'), text: sub(r, 'state').textContent, who: sub(r, 'who').textContent, hint: sub(r, 'hint').textContent });
          }
          var names = [];
          for (var k = 0; k < elPeople.children.length; k++) names.push(sub(elPeople.children[k], 'name').textContent);
          return {
            mine: !elMine.hidden,
            status: elMine.hidden ? null : elStatus.getAttribute('data-status'),
            title: elMine.hidden ? '' : elTitle.textContent,
            need: elMine.hidden ? '' : elNeed.textContent,
            people: names,
            remain: elMine.hidden ? '' : elRemain.textContent,
            remainMs: state && state.mine ? Math.max(0, (state.mine.status === 'running' ? state.mine.remainMs : state.mine.lobbyRemainMs) - (performance.now() - t0)) : null,
            bar: elBarWrap.hidden ? null : elBar.style.width,
            tables: rows,
            last: elLast.hidden ? null : elLastText.textContent,
            empty: !elEmpty.hidden,
            timer: !!timer,
          };
        },
      };
    },
  });
})();
