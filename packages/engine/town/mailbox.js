// 「信箱」面板：收件、已发、邀请。没读过的信要回家才能拆。
import { dateTimeOf, h, icon, toast } from './dom.js';
import { moveTo, openLetter, openLetterComposer } from './sheets.js';
import { act, http, state } from './store.js';
import { btn, chip, empty, row, section, segmented } from './ui.js';

/** @typedef {import('./types.js').Letter} Letter */

const tz = () => state.config?.world.timezone ?? 'Asia/Tokyo';

export function createMailbox() {
  const el = h('div', { class: 'panel mailbox' });
  let tab = 'inbox';
  /** @type {Record<string, { letters: Letter[], next: number | null, loaded: boolean }>} */
  const boxes = { inbox: { letters: [], next: null, loaded: false }, sent: { letters: [], next: null, loaded: false } };
  let lastSig = '';
  let loading = false;

  /**
   * @param {'inbox' | 'sent'} box
   * @param {boolean} more
   */
  async function load(box, more = false) {
    if (loading) return;
    loading = true;
    try {
      const b = boxes[box];
      if (!b) return;
      const r = await http('GET', `/letters?box=${box}&limit=15${more && b.next ? `&before=${b.next}` : ''}`);
      if (r.status !== 200) {
        toast(r.data?.message ?? '没能读到信箱。', 'warn');
        return;
      }
      b.letters = more ? [...b.letters, ...r.data.letters] : r.data.letters;
      b.next = r.data.next;
      b.loaded = true;
    } catch {
      toast('网络不通，信箱没刷新。', 'warn');
    } finally {
      loading = false;
      render();
    }
  }

  /** @param {Letter} l */
  function letterRow(l) {
    const me = state.me;
    const atHome = me?.location.space === me?.me.home.id;
    const sent = l.box === 'sent';
    const other = sent ? l.to : l.from;
    const unread = !sent && !l.read;
    return row({
      lead: h('span', { class: `mail-ico${unread ? ' new' : ''}` }, icon('mail', 20)),
      title: h('span', null, `${sent ? '寄给 ' : ''}${other.name}`, unread ? chip('未读', 'amber') : null, l.invite ? chip('附邀请', 'moss') : null),
      sub: unread ? `${dateTimeOf(l.deliveredAt ?? l.sentAt, tz())} 送到 · 回到自己家才能拆开读` : sent && l.deliveredAt === null ? `${dateTimeOf(l.sentAt, tz())} 寄出 · 还在路上` : `${dateTimeOf(sent ? l.sentAt : (l.deliveredAt ?? l.sentAt), tz())}${l.body ? ` · ${[...l.body].slice(0, 24).join('')}${[...l.body].length > 24 ? '…' : ''}` : ''}`,
      aside: unread
        ? atHome
          ? btn('拆信', async () => {
              const r = await act({ type: 'read_letter', letterId: l.id });
              if (r.ok) {
                await Promise.all([load('inbox'), load('sent')]);
                const got = /** @type {Letter | undefined} */ (r.letter);
                if (got) openLetter(got);
              }
            }, { small: true, variant: 'primary' })
          : btn('回家', () => moveTo('home', '家'), { small: true, variant: 'soft', icon: 'home', disabled: Boolean(me?.location.moving) })
        : btn('打开', () => openLetter(l), { small: true, variant: 'ghost', always: true }),
    });
  }

  function render() {
    const me = state.me;
    if (!me) return;
    const unread = me.mail.unread;
    const head = h(
      'header',
      { class: 'panel-head' },
      h('div', null, h('p', { class: 'eyebrow' }, '信箱'), h('h2', null, unread ? `有 ${unread} 封新信` : '信箱'), h('p', { class: 'hint' }, `收到 ${me.mail.total} 封${me.location.space === me.me.home.id ? '' : '，新信要回家才能拆'}`)),
      btn('写信', () => openLetterComposer(), { variant: 'primary', small: true, icon: 'plus', always: true }),
    );
    const seg = segmented(
      [
        { id: 'inbox', label: '收件', badge: unread || undefined },
        { id: 'sent', label: '已发' },
        { id: 'invites', label: '邀请', badge: me.invites.received.length || undefined },
      ],
      tab,
      (id) => {
        tab = id;
        lastSig = '';
        if (id !== 'invites' && !boxes[id]?.loaded) void load(/** @type {'inbox' | 'sent'} */ (id));
        render();
      },
      '信箱分页',
    );
    /** @type {import('./dom.js').Child} */
    let body;
    if (tab === 'invites') {
      const rec = me.invites.received;
      const sent = me.invites.sent;
      body = h(
        'div',
        { class: 'stack' },
        section(
          '收到的邀请',
          rec.length
            ? h('div', { class: 'stack' }, rec.map((i) => row({ lead: icon('home', 20), title: `${i.host.name} 邀请你去家里`, sub: `${dateTimeOf(i.expiresAt, tz())} 前有效 · ${i.reentry ? '出入随意' : '进去一次'} · ${i.via === 'letter' ? '随信' : '当面'}`, aside: btn('前往', () => moveTo(i.home, `${i.host.name}家`), { small: true, variant: 'primary', icon: 'walk', disabled: Boolean(me.location.moving || me.game) }) })))
            : empty('没有收到的邀请', '读信时附的邀请，或者别人当面邀请你，会出现在这里。'),
        ),
        section(
          '我发出的邀请',
          sent.length
            ? h(
                'div',
                { class: 'stack' },
                sent.map((i) =>
                  row({
                    lead: icon('home', 20),
                    title: `邀请了 ${i.guest.name}`,
                    sub: `${dateTimeOf(i.expiresAt, tz())} 前有效`,
                    aside: btn('撤销', async () => {
                      const r = await act({ type: 'revoke_invite', grantId: i.grantId });
                      if (r.ok) toast('邀请已撤销，还在你家里的客人会被送到门口。', 'info');
                    }, { small: true, variant: 'ghost' }),
                  }),
                ),
              )
            : empty('没有发出的邀请', '当面点开一个人，或者写信时勾选附上邀请。'),
          { hint: '撤销之后，还在你屋里的客人会被送到门口。' },
        ),
      );
    } else {
      const b = boxes[tab];
      if (!b || !b.loaded) body = h('p', { class: 'hint pad' }, '正在翻信箱……');
      else if (!b.letters.length) body = empty(tab === 'inbox' ? '信箱是空的' : '还没寄过信', tab === 'inbox' ? '写一封信给镇上的人吧，对方会在几分钟内收到。' : '');
      else body = h('div', { class: 'stack' }, b.letters.map((l) => letterRow(l)), b.next ? btn('更早的信', () => load(/** @type {'inbox' | 'sent'} */ (tab), true), { variant: 'ghost', small: true, always: true }) : null);
    }
    el.replaceChildren(head, h('div', { class: 'seg-wrap' }, seg), h('div', { class: 'panel-body' }, body));
  }

  function update() {
    const me = state.me;
    if (!me) return;
    const sig = JSON.stringify([me.mail, me.invites, me.location.space === me.me.home.id, me.location.moving ? 1 : 0, state.readOnly, tab]);
    if (sig === lastSig) return;
    const mailChanged = lastSig && JSON.parse(lastSig)[0]?.total !== me.mail.total;
    lastSig = sig;
    render();
    if (mailChanged || !boxes.inbox?.loaded) void Promise.all([load('inbox'), tab === 'sent' ? load('sent') : Promise.resolve()]);
  }

  window.addEventListener('town:letters-changed', () => {
    void load('inbox');
    void load('sent');
  });

  return {
    el,
    update,
    activate() {
      lastSig = '';
      update();
      void load(tab === 'sent' ? 'sent' : 'inbox');
    },
  };
}

