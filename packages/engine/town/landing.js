// 入口页：没登录也能看公开的小镇；有票据就兑换；本机试玩；第一次进来建居民；离开后回来。
import { dateTimeOf, h, icon, toast } from './dom.js';
import { openGameResult as _unused } from './game.js';
import { createMap } from './map.js';
import { openPlace } from './sheets.js';
import { devLogin, enter, http, logout, refreshPub, serverNow, state } from './store.js';
import { openSpectate } from './game.js';
import { btn, chip, empty, field, section } from './ui.js';
import { cycleTheme, getTheme, themeName } from './theme.js';
import { hourMinute } from './dom.js';

/** @typedef {import('./types.js').Report} Report */

const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

export function weatherIcon(id) {
  return { clear: 'sun', cloudy: 'cloud', breeze: 'breeze', rain: 'rain' }[id] ?? 'sun';
}

/** 注册表单 */
function registerForm() {
  const cfg = state.config;
  if (!cfg) return h('p', { class: 'err' }, '没能读到小镇的设置。');
  const name = h('input', { type: 'text', maxLength: 16, required: true, class: 'text-input', value: state.session.name ?? '', autocomplete: 'off', placeholder: '给自己起个名字' });
  const bio = h('textarea', { rows: 2, maxLength: 80, class: 'text-input', placeholder: '一句话介绍自己（可以不写）' });
  /** @type {Set<string>} */
  const traitSet = new Set();
  /** @type {Set<string>} */
  const intSet = new Set();
  const err = h('p', { class: 'err', role: 'alert' });
  const picker = (/** @type {{ id: string, name: string, hint?: string }[]} */ list, /** @type {Set<string>} */ set, /** @type {number} */ limit, /** @type {string} */ label) => {
    const left = h('span', { class: 'hint' }, `选 ${limit} 个以内`);
    const box = h('fieldset', { class: 'chips-pick' }, h('legend', null, label, ' ', left));
    for (const t of list) {
      const input = h('input', { type: 'checkbox', onchange: () => {
        if (input.checked) {
          if (set.size >= limit) {
            input.checked = false;
            toast(`${label}最多选 ${limit} 个。`, 'warn');
            return;
          }
          set.add(t.id);
        } else set.delete(t.id);
        left.textContent = set.size ? `已选 ${set.size}/${limit}` : `选 ${limit} 个以内`;
      } });
      box.appendChild(h('label', { class: 'pill' }, input, h('span', null, t.name, t.hint ? h('small', null, t.hint) : null)));
    }
    return box;
  };
  return h(
    'form',
    {
      class: 'stack',
      onsubmit: async (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        err.textContent = '';
        const r = await enter({ name: name.value.trim(), bio: bio.value.trim(), traits: [...traitSet], interests: [...intSet] });
        if (r !== true) err.textContent = typeof r === 'string' ? r : '没能进入。';
      },
    },
    field('名字', name, '镇上不能重名，最多 16 个字。'),
    field('简介', bio),
    picker(cfg.traits, traitSet, cfg.limits.traits, '个性倾向'),
    picker(cfg.interests, intSet, cfg.limits.interests, '兴趣'),
    err,
    h('button', { type: 'submit', class: 'btn primary block' }, '搬进栖灯镇'),
    h('p', { class: 'hint' }, '搬进来会分到一间家和一点见面礼：几样食材、花种、茶叶和一本书，只发一次。'),
  );
}

function loginCard() {
  const cfg = state.config;
  const note = state.entryNote;
  const name = h('input', { type: 'text', class: 'text-input', maxLength: 16, placeholder: '输入名字就能进来', autocomplete: 'off', 'aria-label': '本机试玩的名字' });
  const err = h('p', { class: 'err', role: 'alert' }, note);
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'para' }, '真人居民通过群里裁判私聊发来的一次性登录链接进入。打开链接，页面会自动登录。'),
    h('div', { class: 'note' }, icon('lock', 16), ' 登录链接 5 分钟有效，只能用一次；打开后地址栏里的票据会立刻清掉。'),
    cfg?.devLogin
      ? h(
          'form',
          {
            class: 'stack dev-login',
            onsubmit: async (/** @type {SubmitEvent} */ e) => {
              e.preventDefault();
              err.textContent = '';
              const r = await devLogin(name.value);
              if (!r.ok) err.textContent = r.message;
            },
          },
          h('h4', null, '本机试玩'),
          field('名字', name, '只在本机或可信内网开放。同一个名字总是同一位居民。'),
          h('button', { class: 'btn primary block', type: 'submit' }, '本机试玩'),
        )
      : h('p', { class: 'hint' }, '这个小镇没有开放本机试玩。'),
    err,
  );
}

function leftCard() {
  const s = state.session;
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'para' }, state.leftNote || '欢迎回来。'),
    state.entryNote ? h('p', { class: 'err' }, state.entryNote) : null,
    btn('回到小镇', async () => {
      const r = await enter();
      if (r !== true && typeof r === 'string') toast(r, 'warn');
    }, { variant: 'primary', block: true, always: true, icon: 'lantern' }),
    h('p', { class: 'hint' }, `以 ${s.resident?.name ?? s.name ?? ''} 的身份回去。`),
    btn('退出登录', () => logout(), { variant: 'ghost', small: true, always: true }),
  );
}

export function createLanding() {
  const map = createMap({ onPlace: (id) => openPlace(id) });
  const mapCard = h('div', { class: 'map-card' }, map.el);
  const facts = h('div', { class: 'facts' });
  const cardTitle = h('h2', null, '');
  const cardBody = h('div', { class: 'entry-body' });
  const entry = h('section', { class: 'entry-card' }, cardTitle, cardBody);
  const extra = h('div', { class: 'landing-extra' });
  const header = h(
    'header',
    { class: 'landing-head' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('lantern', 26)), h('div', null, h('h1', null, '栖灯镇'), h('p', null, 'AI 与真人一起住的小镇'))),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': '切换外观', title: '外观', onclick: () => ((cycleTheme(), (themeBtn.textContent = themeName(getTheme())))) }, icon('theme', 20)),
  );
  const themeBtn = h('span');
  const el = h('div', { class: 'landing' }, header, h('div', { class: 'landing-grid' }, h('div', { class: 'landing-left' }, mapCard, facts), h('div', { class: 'landing-right' }, entry, extra)));

  let lastPhase = '';
  /** @type {Report | null} */
  let pubReport = null;
  let reportFetched = false;

  async function loadReport() {
    const r = await http('GET', '/public/report').catch(() => null);
    if (r && r.status === 200) {
      pubReport = r.data;
      renderExtra();
    }
  }

  function renderExtra() {
    const pub = state.pub;
    if (!pub) return;
    const running = pub.places.flatMap((p) => p.activities.filter((a) => a.status === 'running').map((a) => ({ ...a, place: p.name })));
    el.querySelector('.landing-extra')?.replaceChildren(
      section(
        '今天的公共事件',
        pub.events.length
          ? h('div', { class: 'stack' }, pub.events.map((e) => h('div', { class: `ev ${e.status}` }, h('div', { class: 'ev-top' }, h('b', null, e.title), chip(e.status === 'open' ? '进行中' : e.status === 'scheduled' ? '待开始' : e.status === 'missed' ? '错过了' : '已结束', e.status === 'open' ? 'moss' : 'dim')), h('p', { class: 'hint' }, `${pub.places.find((p) => p.id === e.place)?.name ?? ''} · ${dateTimeOf(e.opensAt, tz())} 起${e.target ? ` · 共同进度 ${e.progress ?? 0}/${e.target}` : ''}`), h('p', { class: 'hint' }, e.text))))
          : empty('今天没有公共事件'),
      ),
      running.length
        ? section(
            '正在进行的小游戏（可观战）',
            h(
              'div',
              { class: 'stack' },
              running.map((a) => h('div', { class: 'row' }, h('div', { class: 'row-lead' }, icon('dice', 20)), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, a.name), h('div', { class: 'row-sub' }, `${a.place} · ${a.players} 人`)), h('div', { class: 'row-aside' }, btn('观战', () => openSpectate(a.id, a.name), { small: true, icon: 'eye', always: true })))),
            ),
            { hint: '观战只能看到公开信息。' },
          )
        : null,
      section(
        '公开日报',
        pubReport && pubReport.lines.length ? h('ul', { class: 'bullets report' }, pubReport.lines.map((l) => h('li', null, l))) : h('p', { class: 'hint' }, pubReport ? '今天还没有可记的事。' : '正在取日报……'),
        { hint: pubReport && !pubReport.final ? `${pubReport.date} 的稿子还没定，明天会更完整。` : undefined },
      ),
    );
  }

  function update() {
    const pub = state.pub;
    if (!pub) return;
    const phase = state.phase;
    const hh = hourMinute(serverNow(), tz());
    map.update({ pub, me: null, now: serverNow(), hour: hh.h + hh.m / 60 });
    facts.replaceChildren(
      h('div', { class: 'fact' }, icon('clock', 17), h('b', null, pub.world.clock), h('span', null, pub.world.date)),
      h('div', { class: 'fact' }, icon(weatherIcon(pub.world.weather.id), 17), h('b', null, pub.world.weather.name)),
      h('div', { class: 'fact' }, icon('people', 17), h('b', null, `${pub.counts.present}`), h('span', null, `位在镇上 · 共 ${pub.counts.residents} 位居民`)),
    );
    const sig = `${phase}|${state.session.loggedIn}|${state.entryNote}|${state.leftNote}`;
    if (sig !== lastPhase) {
      lastPhase = sig;
      if (phase === 'register') {
        cardTitle.textContent = '搬进栖灯镇';
        cardBody.replaceChildren(registerForm());
      } else if (phase === 'left') {
        cardTitle.textContent = `欢迎回来，${state.session.resident?.name ?? state.session.name ?? ''}`;
        cardBody.replaceChildren(leftCard());
      } else {
        cardTitle.textContent = '进入小镇';
        cardBody.replaceChildren(loginCard());
      }
    }
    if (!reportFetched) {
      reportFetched = true;
      void loadReport();
    }
    renderExtra();
  }

  return { el, update, tick: (/** @type {number} */ now) => map.tick(now), map };
}

void refreshPub;
void _unused;
