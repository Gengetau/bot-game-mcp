// 「我」面板：资料、硬币、三项需要、愿望、背包、设置。
import { avatar, confirmDialog, dateTimeOf, h, icon, toast } from './dom.js';
import { openMoodEditor, openProfileEditor } from './sheets.js';
import { act, leaveTown, logout, state } from './store.js';
import { cycleTheme, getTheme, themeName } from './theme.js';
import { btn, chip, empty, meter, progress, row, section, toggle } from './ui.js';

/** @typedef {import('./types.js').InvItem} InvItem */
/** @typedef {import('./types.js').MeView} MeView */

const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

/** 能直接吃掉 / 喝掉的东西 */
const USABLE = new Set(['soup', 'cookie']);

/**
 * @param {InvItem} it
 * @param {MeView} me
 */
function itemRow(it, me) {
  const atHome = me.location.space === me.me.home.id;
  /** @type {import('./dom.js').Child[]} */
  const btns = [];
  if (it.borrowedFrom) {
    btns.push(btn('归还', () => act({ type: 'return_item', itemId: it.itemId }), { small: true, variant: 'soft' }));
  } else {
    if (USABLE.has(it.type) && it.available > 0) btns.push(btn('用掉一份', () => act({ type: 'use_item', itemType: it.type }), { small: true, variant: 'soft' }));
    if (it.category === 'decor') {
      if (it.available > 0) btns.push(btn('摆出一份', () => act({ type: 'display_item', itemType: it.type, qty: 1, on: true }), { small: true, variant: 'soft', disabled: !atHome, why: '回到自己家才能布置。' }));
      if (it.shelved > 0) btns.push(btn('收起一份', () => act({ type: 'display_item', itemType: it.type, qty: 1, on: false }), { small: true, variant: 'ghost', disabled: !atHome, why: '回到自己家才能布置。' }));
    }
    if (it.category === 'furniture') btns.push(btn('摆进家里', () => act({ type: 'place_furniture', itemId: it.itemId }), { small: true, variant: 'soft', disabled: !atHome, why: '回到自己家才能摆家具。' }));
  }
  return row({
    lead: icon(it.category === 'decor' ? 'lantern' : it.type === 'book' ? 'book' : it.category === 'furniture' ? 'home' : 'bag', 20),
    title: h('span', null, it.name, it.qty > 1 ? h('em', { class: 'qty' }, ` ×${it.qty}`) : null),
    sub: [it.borrowedFrom ? `借自${it.borrowedFrom}${it.dueAt ? `，${dateTimeOf(it.dueAt, tz())} 前还` : ''}` : it.use, it.shelved ? `已摆出 ${it.shelved}` : ''].filter(Boolean).join(' · '),
    aside: btns.length ? h('div', { class: 'row-wrap end' }, btns) : null,
  });
}

export function createSelf() {
  const el = h('div', { class: 'panel self' });
  let key = '';

  function update() {
    const me = state.me;
    if (!me) return;
    const k = JSON.stringify([me.me, me.inventory, me.goals, me.suggestions, me.location.space, state.readOnly, getTheme(), me.game?.activityId ?? null]);
    if (k === key) return;
    key = k;
    const m = me.me;
    const needs = m.needs;
    const inv = me.inventory;
    const groups = [
      ['消耗品', inv.items.filter((i) => i.category === 'consumable' && !i.borrowedFrom)],
      ['书与用品', inv.items.filter((i) => i.category === 'usable')],
      ['装饰', inv.items.filter((i) => i.category === 'decor')],
      ['家具', inv.items.filter((i) => i.category === 'furniture')],
    ];
    el.replaceChildren(
      h(
        'header',
        { class: 'panel-head' },
        h('div', null, h('p', { class: 'eyebrow' }, '我'), h('h2', null, m.name)),
        h('div', { class: 'row-wrap' }, btn('改资料', () => openProfileEditor(), { small: true, variant: 'soft', icon: 'user' })),
      ),
      h(
        'div',
        { class: 'me-card' },
        avatar(m.name, m.kind, true),
        h(
          'div',
          { class: 'me-main' },
          h('div', { class: 'chips' }, chip(m.kind === 'agent' ? 'AI 居民' : '真人居民', m.kind === 'agent' ? 'teal' : 'amber'), ...m.titles.map((t) => chip(`「${t}」`, 'moss')), m.mood ? chip(`心情：${m.mood.name}`) : null),
          m.bio ? h('p', { class: 'para' }, m.bio) : h('p', { class: 'hint' }, '还没有简介。'),
          m.mood?.reason ? h('p', { class: 'hint' }, `因为：${m.mood.reason}`) : null,
          h('div', { class: 'chips' }, m.traits.map((t) => chip(t.name)), m.interests.map((t) => chip(t.name, 'amber'))),
          h('p', { class: 'hint' }, `家：${m.home.streetName} ${m.home.no} 号`),
        ),
      ),
      h(
        'div',
        { class: 'coin-card' },
        h('div', { class: 'coin-main' }, icon('coin', 26), h('b', null, String(inv.coins.available)), h('span', null, '枚硬币可用')),
        h('div', { class: 'hint' }, `共 ${inv.coins.balance} 枚${inv.coins.reserved ? `，其中 ${inv.coins.reserved} 枚预留在没完成的报价里` : ''}`),
      ),
      section('状态', h('div', { class: 'needs' }, meter('精力', needs.energy, 'energy'), meter('社交', needs.social, 'social'), meter('兴趣', needs.interest, 'interest')), { hint: '数值低不会禁止任何事，只是提醒：社交和兴趣随在场时间慢慢下降，离线不掉。' }),
      me.suggestions.length ? section('小建议', h('ul', { class: 'bullets' }, me.suggestions.map((t) => h('li', null, t)))) : null,
      section(
        '愿望',
        me.goals.length
          ? h(
              'div',
              { class: 'stack' },
              me.goals.map((g) =>
                h(
                  'div',
                  { class: 'goal' },
                  h('div', { class: 'goal-top' }, chip(g.kind === 'long' ? '长期' : '短期', g.kind === 'long' ? 'moss' : 'amber'), h('b', null, g.title), h('span', { class: 'price' }, icon('coin', 13), `+${g.reward}`)),
                  h('p', { class: 'hint' }, g.description),
                  progress(g.progress, g.target, g.title),
                  h('div', { class: 'goal-foot' }, h('span', null, `${g.progress} / ${g.target}`), g.kind === 'short' ? btn('换一个', () => act({ type: 'replace_goal', goalId: g.id }), { small: true, variant: 'ghost', why: '每天只能换一次。' }) : null),
                ),
              ),
            )
          : empty('暂时没有愿望', '完成一个愿望之后，新的会出现。'),
        { hint: '愿望的进度只来自真正做过的事（程序记录的事实），聊天文字不算。' },
      ),
      section(
        '背包',
        inv.items.length === 0 && inv.lent.length === 0
          ? empty('背包是空的', '去商店逛逛，或者做点共同的事。')
          : h(
              'div',
              { class: 'stack' },
              ...groups.map(([name, list]) => (/** @type {InvItem[]} */ (list).length ? h('div', { class: 'inv-group' }, h('h4', null, /** @type {string} */ (name)), /** @type {InvItem[]} */ (list).map((it) => itemRow(it, me))) : null)),
              inv.items.some((i) => i.borrowedFrom) ? h('div', { class: 'inv-group' }, h('h4', null, '借来的'), inv.items.filter((i) => i.borrowedFrom).map((it) => itemRow(it, me))) : null,
              inv.lent.length ? h('div', { class: 'inv-group' }, h('h4', null, '借出去的'), inv.lent.map((l) => row({ lead: icon('book', 20), title: l.name, sub: `借给了${l.to}，约定 ${dateTimeOf(l.dueAt, tz())} 前还` }))) : null,
            ),
        { hint: '归还：当面还给主人、放进主人家门口的归还箱（在 TA 那条巷子），书屋的书还回檐下书屋。' },
      ),
      section(
        '展示与隐私',
        h(
          'div',
          { class: 'stack' },
          toggle('向同一处的人展示我的心情', m.settings.showMood, (v) => void act({ type: 'update_profile', showMood: v }), '关掉后，别人看不到你的心情。'),
          toggle('允许别人当面问我的爱好', m.settings.allowAskHobby, (v) => void act({ type: 'update_profile', allowAskHobby: v }), '关掉后，别人问你会得到婉拒。'),
          btn(m.settings.moodOverride ? `我设的心情：${m.settings.moodOverride}` : '自己设置心情文字', () => openMoodEditor(), { small: true, variant: 'ghost' }),
        ),
      ),
      section(
        '页面与离开',
        h(
          'div',
          { class: 'stack' },
          btn(`外观：${themeName(getTheme())}`, () => {
            cycleTheme();
            key = '';
            update();
          }, { variant: 'ghost', icon: 'theme', always: true }),
          h('div', { class: 'leave-box' }, h('p', { class: 'hint' }, '关闭页面不等于离开：小镇还会给你留 1 分钟，然后你会显示为离线（位置和物品都留着）。'), btn('离开小镇', async () => {
            const ok = await confirmDialog({
              title: '离开小镇？',
              text: h('div', { class: 'stack' }, h('p', null, '你会立刻离线，所有页面都会收到通知。'), h('ul', { class: 'bullets' }, h('li', null, '没开始的报价、凑桌、共同活动会取消，预留的东西退回。'), h('li', null, '正在路上的行程和已经寄出的信照常完成。'), h('li', null, '如果在小游戏里，视为退出这一局。'), h('li', null, '你的家、背包、朋友和愿望都保留，随时回来。'))),
              ok: '离开小镇',
              danger: true,
            });
            if (ok) await leaveTown();
          }, { variant: 'danger', icon: 'leave', always: true }),
          btn('退出登录', async () => {
            const ok = await confirmDialog({ title: '退出登录？', text: '会撤销这台设备的登录。居民不会被删除，下次用登录链接或本机试玩重新进来就行。注意：退出登录不会让你立刻离线，想离开请用「离开小镇」。', ok: '退出登录' });
            if (ok) await logout();
          }, { variant: 'ghost', always: true })),
        ),
      ),
    );
    void toast;
  }

  return { el, update };
}
