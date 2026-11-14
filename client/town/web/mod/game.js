/* 小游戏面板（数字炸弹）：overlay 层，不占页签。局中显示炸弹、引信条（范围）、回合与倒计时、玩家、最近的猜数、输入区；局终显示结果卡。
 * feed 的 kind：state（整份：mode none / game / result）、ack（一次猜数的回应）、confirm（要求弹出「离开这局」的确认）、reset（离开 / 换人）。
 * 网页 -> Godot（game.<name>）：guess（JSON {n,number,phaseId,gameId}）、leave、dismiss、refresh。
 * 文字都在 game.html 的文字库里（host.t），这个文件里没有汉字字面量（lint 检查）。玩家名和服务端文字一律 textContent，类名只用白名单。
 * body[data-game="1"]：面板（对局或结果卡）显示期间设置，收起、离开、重置时一定清除；game.css 靠它藏掉底栏的动作按钮，居民卡（people.css）也靠它在局中隐藏。 */
(function () {
  'use strict';
  window.TownDock.register({
    id: 'game',
    api: 1,
    mount: function (host) {
      var $ = function (r) {
        return host.q('[data-role="' + r + '"]');
      };
      var T = host.t;
      var root = host.root;
      var tplPlayer = document.getElementById('tpl-game-player');
      var tplHist = document.getElementById('tpl-game-hist');
      var tplRp = document.getElementById('tpl-game-rplayer');
      var coarse = !!(window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches);
      var S = { mode: 'none' };
      var seq = 0;
      var pend = 0; // 在途的猜数序号（0 = 没有）
      var pendTimer = 0;
      var hint = { text: '', kind: '' };
      var t0 = 0; // 收到 state 的时刻（performance.now），倒计时靠它往下数
      var tick = 0;
      var autoClose = 0;
      var lastGame = '';
      var fullSpan = 0;
      var lastTurnKey = '';
      var dismissed = 0;
      var inputEl = $('input');

      /* 触屏：只读显示框 + 屏幕小键盘（不弹系统键盘）；桌面：文本框（只收数字）。用 readonly + aria-disabled，不用 disabled，否则失焦后 dock 的全局 Enter 会打开聊天面板 */
      inputEl.readOnly = coarse;
      if (coarse) {
        inputEl.setAttribute('inputmode', 'none');
        inputEl.setAttribute('tabindex', '-1');
      }
      root.setAttribute('data-input', coarse ? 'pad' : 'keys');

      function setHint(text, kind) {
        hint = { text: text || '', kind: kind || '' };
        var el = $('hint');
        el.textContent = hint.text;
        el.className = 'game-hint' + (hint.kind ? ' ' + hint.kind : '');
      }

      function shown() {
        return !root.hidden;
      }

      function setBody(on) {
        if (on) document.body.setAttribute('data-game', '1');
        else document.body.removeAttribute('data-game');
      }

      /* 面板位置：贴在 #bottombar 上沿之上（手机）；桌面靠左 */
      function place() {
        var bb = document.getElementById('bottombar');
        if (!bb) return;
        var top = bb.getBoundingClientRect().top;
        var bottom = Math.max(8, Math.round(window.innerHeight - top + 8));
        root.style.setProperty('--game-bottom', bottom + 'px');
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
          new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ['data-dock-open', 'data-dock', 'data-kb', 'data-game'] });
        } catch (e) {
          /* ignore */
        }
      }

      function remaining() {
        if (S.mode !== 'game' || typeof S.secondsLeft !== 'number' || S.secondsLeft < 0) return -1;
        return Math.max(0, Math.round(S.secondsLeft - (performance.now() - t0) / 1000));
      }

      function renderTimer() {
        var el = $('timer');
        var n = remaining();
        if (n < 0 || !S.open) {
          el.textContent = '';
          el.hidden = true;
          return;
        }
        el.hidden = false;
        el.textContent = T('timer', { n: n });
        el.classList.toggle('urgent', n <= 10);
      }

      function fillPlayer(p) {
        var li = tplPlayer.content.firstElementChild.cloneNode(true);
        li.setAttribute('data-seat', String(p.seat));
        if (p.turn) li.classList.add('turn');
        if (p.me) li.classList.add('me');
        if (!p.alive) li.classList.add('out');
        li.querySelector('[data-role="seat"]').textContent = String(p.seat);
        li.querySelector('[data-role="name"]').textContent = p.name + (p.me ? ' (' + T('me') + ')' : '');
        var k = li.querySelector('[data-role="kind"]');
        k.textContent = p.alive ? (p.kind === 'agent' ? T('kind.ai') : T('kind.human')) : T('out');
        k.className = 'game-kind ' + (p.alive ? (p.kind === 'agent' ? 'ai' : 'human') : 'out');
        return li;
      }

      function fillHist(h) {
        var li = tplHist.content.firstElementChild.cloneNode(true);
        li.setAttribute('data-seat', String(h.seat));
        li.querySelector('[data-role="who"]').textContent = h.name || String(h.seat);
        li.querySelector('[data-role="num"]').textContent = String(h.guess);
        li.querySelector('[data-role="res"]').textContent = h.result + (h.auto ? ' · ' + T('hist.auto') : '');
        return li;
      }

      function renderGame() {
        var loading = !!S.loading;
        $('title').textContent = S.name || T('title.fallback');
        var turn = $('turn');
        if (loading) turn.textContent = T('loading');
        else if (S.over) turn.textContent = T('turn.over');
        else if (S.yourTurn) turn.textContent = T('turn.you');
        else {
          var who = '';
          (S.players || []).forEach(function (p) {
            if (p.turn) who = p.name;
          });
          turn.textContent = who ? T('turn.other', { name: who }) : T('turn.wait');
        }
        turn.classList.toggle('mine', !!S.yourTurn && !loading);
        var rg = S.range || { from: 0, to: 0 };
        var span = rg.to - rg.from + 1;
        if (S.gameId !== lastGame) {
          lastGame = S.gameId;
          fullSpan = 0;
        }
        if (span > fullSpan) fullSpan = span;
        $('rangeFrom').textContent = loading ? '' : String(rg.from);
        $('rangeTo').textContent = loading ? '' : String(rg.to);
        var bar = $('bar');
        var pct = fullSpan > 0 && span > 0 ? Math.max(4, Math.min(100, Math.round((span / fullSpan) * 100))) : 100;
        bar.style.width = pct + '%';
        $('range').setAttribute('aria-label', T('range.label', { from: rg.from, to: rg.to }));
        $('range').setAttribute('data-pct', String(pct));

        var pl = $('players');
        pl.textContent = '';
        (S.players || []).forEach(function (p) {
          pl.appendChild(fillPlayer(p));
        });

        var hl = $('history');
        hl.textContent = '';
        var hs = S.history || [];
        /* 最近的在最上面；面板里只放最近 6 条 */
        for (var i = hs.length - 1, n = 0; i >= 0 && n < 6; i--, n++) hl.appendChild(fillHist(hs[i]));
        hl.setAttribute('data-count', String(hs.length));

        /* 输入区 */
        var mine = !!S.yourTurn && !loading && !S.over;
        root.setAttribute('data-turn', mine ? '1' : '0');
        inputEl.setAttribute('aria-disabled', mine ? 'false' : 'true');
        inputEl.placeholder = mine ? T('ph', { from: rg.from, to: rg.to }) : T('ph.wait');
        ['mid', 'submit'].forEach(function (r) {
          $(r).setAttribute('aria-disabled', mine ? 'false' : 'true');
          $(r).classList.toggle('off', !mine);
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-key]'), function (b) {
          b.setAttribute('aria-disabled', mine ? 'false' : 'true');
          b.classList.toggle('off', !mine);
        });
        if (!mine && document.activeElement === inputEl && !coarse) {
          /* 不是我的回合：保留焦点没有意义，但也别抢（失焦后 WASD 在局中本来就不动） */
        }
        /* 新的一轮轮到我：桌面上把焦点放进输入框（一轮只做一次，不和别的输入框抢） */
        var turnKey = mine ? S.gameId + ':' + S.phaseId : '';
        if (mine && turnKey !== lastTurnKey) {
          lastTurnKey = turnKey;
          if (!coarse && shown() && (!document.activeElement || document.activeElement === document.body)) {
            try {
              inputEl.focus({ preventScroll: true });
            } catch (e) {
              /* ignore */
            }
          }
          if (pend === 0) setHint('', '');
        }
        if (!mine) lastTurnKey = turnKey;
        renderTimer();
      }

      function renderResult() {
        var kind = S.kind || 'unknown';
        $('resultTitle').textContent = T('result.' + (kind === 'won' || kind === 'lost' || kind === 'aborted' ? kind : 'unknown'));
        root.setAttribute('data-result', kind === 'won' || kind === 'lost' || kind === 'aborted' ? kind : 'unknown');
        $('resultReason').textContent = S.reason || T('result.noreason');
        var ul = $('resultPlayers');
        ul.textContent = '';
        (S.players || []).forEach(function (p) {
          var li = tplRp.content.firstElementChild.cloneNode(true);
          li.querySelector('[data-role="name"]').textContent = p.name;
          li.querySelector('[data-role="tag"]').textContent = p.tag;
          ul.appendChild(li);
        });
        ul.hidden = !(S.players && S.players.length);
        var rw = $('reward');
        if (kind === 'aborted') rw.textContent = '';
        else rw.textContent = S.reward > 0 ? T('reward', { n: S.reward }) : T('reward.none');
        rw.hidden = !rw.textContent;
      }

      function render() {
        var mode = S.mode === 'game' || S.mode === 'result' ? S.mode : 'none';
        var wasShown = shown();
        root.hidden = mode === 'none';
        $('play').hidden = mode !== 'game';
        $('result').hidden = mode !== 'result';
        setBody(mode !== 'none');
        root.setAttribute('data-mode', mode);
        if (mode === 'game') renderGame();
        else if (mode === 'result') renderResult();
        if (mode !== 'game') {
          clearInterval(tick);
          tick = 0;
          if (document.activeElement === inputEl) inputEl.blur();
          $('confirm').hidden = true;
          if (!pend) inputEl.value = '';
          setHint('', '');
          lastTurnKey = '';
          if (mode === 'none') fullSpan = 0;
        } else if (!tick) {
          tick = setInterval(renderTimer, 250);
        }
        if (mode === 'result') {
          if (!autoClose) {
            /* 约 20 秒自动收起 */
            autoClose = setTimeout(function () {
              autoClose = 0;
              if (S.mode === 'result') dismiss();
            }, 20000);
          }
        } else if (autoClose) {
          clearTimeout(autoClose);
          autoClose = 0;
        }
        if (mode === 'none' && wasShown) {
          pend = 0;
          clearTimeout(pendTimer);
        }
        if (!shown() && document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
        place();
      }

      /* ── 输入 ── */
      function range() {
        return S.range || { from: 0, to: 0 };
      }
      function clampDigits() {
        var v = inputEl.value.replace(/[^0-9]/g, '').slice(0, 9);
        if (v !== inputEl.value) inputEl.value = v;
      }
      function mid() {
        var r = range();
        return Math.floor((r.from + r.to) / 2);
      }
      function setValue(v) {
        inputEl.value = String(v);
        if (!coarse && shown()) {
          try {
            inputEl.focus({ preventScroll: true });
          } catch (e) {
            /* ignore */
          }
        }
      }
      function canGuess() {
        return S.mode === 'game' && !S.loading && !S.over;
      }
      function submit() {
        if (!canGuess()) return;
        if (pend) {
          setHint(T('err.busy'), 'warn');
          return;
        }
        if (!S.yourTurn) {
          setHint(T('err.turn'), 'warn');
          return;
        }
        var raw = inputEl.value.trim();
        if (!/^[0-9]+$/.test(raw)) {
          setHint(T('err.nan'), 'err');
          return;
        }
        var n = parseInt(raw, 10);
        var r = range();
        if (n < r.from || n > r.to) {
          setHint(T('err.range', { from: r.from, to: r.to }), 'err');
          return;
        }
        send(n, S.phaseId, S.gameId);
      }
      function send(n, phaseId, gameId) {
        seq++;
        pend = seq;
        setHint(T('ok.sent', { n: n }), '');
        clearTimeout(pendTimer);
        pendTimer = setTimeout(function () {
          if (pend) {
            pend = 0;
            setHint(T('err.net'), 'warn');
          }
        }, 12000);
        $('submit').classList.add('wait');
        host.emit('guess', JSON.stringify({ n: seq, number: n, phaseId: phaseId, gameId: gameId }));
      }
      function onAck(a) {
        if (!a || a.n !== pend) return;
        pend = 0;
        clearTimeout(pendTimer);
        $('submit').classList.remove('wait');
        if (a.ok) {
          inputEl.value = '';
          return;
        }
        var msg = a.message || T('err.default');
        if (a.code === 'net') msg = T('err.net');
        if (a.code === 'phase_stale' || a.code === 'context_stale') inputEl.value = '';
        setHint(msg, a.code === 'net' ? 'warn' : 'err');
      }

      inputEl.addEventListener('input', function () {
        if (!coarse) clampDigits();
      });
      inputEl.addEventListener('keydown', function (e) {
        if (coarse) return;
        if (e.key === 'Enter') {
          if (e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          submit();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          var r = range();
          var cur = /^[0-9]+$/.test(inputEl.value) ? parseInt(inputEl.value, 10) : mid();
          cur += e.key === 'ArrowUp' ? 1 : -1;
          cur = Math.max(r.from, Math.min(r.to, cur));
          inputEl.value = String(cur);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          inputEl.blur();
        }
      });
      $('submit').addEventListener('click', submit);
      $('mid').addEventListener('click', function () {
        if (!canGuess() || !S.yourTurn) {
          if (canGuess()) setHint(T('err.turn'), 'warn');
          return;
        }
        setValue(mid());
        setHint('', '');
      });
      /* 小键盘：按下就响应（不抢焦点，不让系统键盘出现） */
      Array.prototype.forEach.call(root.querySelectorAll('[data-key]'), function (b) {
        b.addEventListener('mousedown', function (e) {
          e.preventDefault();
        });
        b.addEventListener('click', function () {
          if (!canGuess()) return;
          if (!S.yourTurn) {
            setHint(T('err.turn'), 'warn');
            return;
          }
          var k = b.getAttribute('data-key');
          var v = inputEl.value;
          if (k === 'del') v = v.slice(0, -1);
          else if (k === 'clear') v = '';
          else if (v.length < 9) v = v === '0' ? k : v + k;
          inputEl.value = v;
          if (hint.kind === 'err') setHint('', '');
        });
      });

      /* ── 离开这局（二次确认） ── */
      function askLeave() {
        if (S.mode !== 'game') return;
        $('confirmText').textContent = T('confirm.ask');
        $('confirm').hidden = false;
        $('leave').hidden = true;
      }
      function closeConfirm() {
        $('confirm').hidden = true;
        $('leave').hidden = false;
      }
      $('leave').addEventListener('click', askLeave);
      $('leaveNo').addEventListener('click', closeConfirm);
      $('leaveYes').addEventListener('click', function () {
        closeConfirm();
        host.emit('leave');
      });

      /* ── 结果卡 ── */
      function dismiss() {
        dismissed++;
        S = { mode: 'none' };
        render();
        host.emit('dismiss');
      }
      $('dismiss').addEventListener('click', dismiss);
      window.addEventListener(
        'keydown',
        function (e) {
          if (e.key !== 'Escape' || S.mode !== 'result') return;
          dismiss();
        },
        true,
      );

      function reset() {
        S = { mode: 'none' };
        pend = 0;
        clearTimeout(pendTimer);
        inputEl.value = '';
        render();
        closeConfirm();
      }

      /* 测试钩子：仅 ?debug=1。绕过本地校验和「还没轮到你」，直接把猜数交给 Godot（端到端用它强发越界 / 旧阶段号 / 非自己回合的猜数）。 */
      if (window.TownDock && window.TownDock.test) {
        window.TownDock.test.game = {
          forceGuess: function (number, phaseId, gameId) {
            seq++;
            host.emit('guess', JSON.stringify({ n: seq, number: number, phaseId: phaseId === undefined ? S.phaseId : phaseId, gameId: gameId === undefined ? S.gameId : gameId }));
            return seq;
          },
        };
      }

      return {
        onFeed: function (kind, data) {
          if (kind === 'state' && data) {
            S = data;
            t0 = performance.now();
            render();
          } else if (kind === 'ack') onAck(data);
          else if (kind === 'confirm') askLeave();
          else if (kind === 'reset') reset();
        },
        onCore: function (c) {
          /* 离开小镇 / 断开登录：收起 */
          if (c && c.phase && c.phase !== 'playing' && S.mode !== 'none') reset();
        },
        debug: function () {
          var r = shown() ? root.getBoundingClientRect().toJSON() : null;
          var rg = range();
          var players = [];
          Array.prototype.forEach.call($('players').children, function (li) {
            players.push({ seat: Number(li.getAttribute('data-seat')), text: li.textContent, turn: li.classList.contains('turn'), me: li.classList.contains('me'), ai: !!li.querySelector('.game-kind.ai') });
          });
          var hist = [];
          Array.prototype.forEach.call($('history').children, function (li) {
            hist.push({ seat: Number(li.getAttribute('data-seat')), who: li.querySelector('[data-role="who"]').textContent, guess: li.querySelector('[data-role="num"]').textContent, res: li.querySelector('[data-role="res"]').textContent });
          });
          return {
            mode: S.mode || 'none',
            shown: shown(),
            yourTurn: !!S.yourTurn,
            secondsLeft: remaining(),
            range: S.mode === 'game' ? { from: rg.from, to: rg.to } : null,
            players: players,
            historyCount: Number($('history').getAttribute('data-count') || 0),
            history: hist,
            input: inputEl.value,
            inputReadonly: !!inputEl.readOnly,
            hint: hint.text,
            hintKind: hint.kind,
            resultKind: S.mode === 'result' ? S.kind : '',
            resultTitle: S.mode === 'result' ? $('resultTitle').textContent : '',
            resultReason: S.mode === 'result' ? $('resultReason').textContent : '',
            resultReward: S.mode === 'result' ? $('reward').textContent : '',
            turnText: $('turn').textContent,
            timerText: $('timer').textContent,
            confirmOpen: !$('confirm').hidden,
            busy: pend !== 0,
            seq: seq,
            dismissed: dismissed,
            coarse: coarse,
            pct: Number($('range').getAttribute('data-pct') || 0),
            rect: r,
            bodyFlag: document.body.getAttribute('data-game'),
            focused: document.activeElement === inputEl,
            text: shown() ? root.textContent : '',
          };
        },
      };
    },
  });
})();
