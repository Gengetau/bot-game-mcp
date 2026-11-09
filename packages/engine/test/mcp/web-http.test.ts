import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { startHttpServer, type HttpHandle } from '../../src/server/http.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';
import { REF, bot } from '../helpers.js';

const ADMIN = `bgk_${'a'.repeat(32)}`;

/** 读 SSE，直到拿到一条 view 事件 */
async function firstView(url: string, headers: Record<string, string> = {}): Promise<{ id: string; data: any; res: Response }> {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const reader = res.body!.getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += new TextDecoder().decode(value);
      const m = /id: (\d+)\nevent: view\ndata: (.*)\n\n/.exec(buf);
      if (m) return { id: m[1]!, data: JSON.parse(m[2]!), res };
    }
  } finally {
    ctrl.abort();
  }
}

describe('灯下剧场 HTTP 接口', () => {
  let rt: Runtime;
  let http: HttpHandle;
  let base: string;
  let gameId: string;
  let token: string;

  beforeAll(async () => {
    rt = createRuntime(
      configSchema.parse({
        host: '127.0.0.1',
        port: 0,
        stateFile: null,
        scriptsDir: join(__dirname, '../../examples/jubensha'),
        webUrl: 'https://stage.example.com/web/',
        auth: { mode: 'keys', adminKeys: [ADMIN], agents: [], issuedKeysFile: null },
      }),
      () => undefined,
    );
    http = await startHttpServer(rt, () => undefined);
    base = http.url.replace(/\/mcp$/, '');
    const m = rt.manager;
    const { summary } = m.createGame(REF, { type: 'jubensha', groupId: 'g', joinAs: 'referee', options: { stage: 'web', script: 'demo-search' } });
    for (const n of [1, 2, 3, 4]) m.joinGame(bot(n), summary.game_id, { as: 'player' });
    const started = m.startGame(REF, summary.game_id);
    gameId = summary.game_id;
    token = m.getRecord(gameId).watchToken!;
    expect(started.watch_url).toBe(`https://stage.example.com/web/?g=${gameId}&t=${token}`);
  });
  afterAll(async () => {
    await http.close();
    rt.close();
  });

  it('serves the page and assets from the repo with a strict CSP', async () => {
    const page = await fetch(`${base}/web/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await page.text();
    expect(html).toContain('灯下剧场');
    // 不从 CDN 加载任何东西
    expect(html).not.toMatch(/https?:\/\//);
    for (const f of ['app.js', 'style.css', 'icon.svg']) expect((await fetch(`${base}/web/${f}`)).status).toBe(200);
    expect((await fetch(`${base}/web/../package.json`)).status).toBe(404);
    expect((await fetch(`${base}/web/nope.js`)).status).toBe(404);
    const r = await fetch(`${base}/web?g=X&t=Y`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/web/?g=X&t=Y');
  });

  it('answers 404 for a wrong token or a group-stage game, and the public view for the right one', async () => {
    expect((await fetch(`${base}/web/api/games/${gameId}?t=wrong`)).status).toBe(404);
    expect((await fetch(`${base}/web/api/games/${gameId}`)).status).toBe(404);
    expect((await fetch(`${base}/web/api/games/${gameId}/stream?t=wrong`)).status).toBe(404);
    const ok = await fetch(`${base}/web/api/games/${gameId}?t=${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const v = (await ok.json()) as any;
    expect(v.game.id).toBe(gameId);
    expect(v.events.length).toBeGreaterThan(0);
    expect(v.board.script.title).toBe('灯塔之夜');
  });

  it('streams the view over SSE and resumes from Last-Event-ID', async () => {
    const first = await firstView(`${base}/web/api/games/${gameId}/stream?t=${token}`);
    expect(first.res.headers.get('content-type')).toContain('text/event-stream');
    expect(first.data.events.length).toBe(Number(first.id));
    const again = await firstView(`${base}/web/api/games/${gameId}/stream?t=${token}`, { 'Last-Event-ID': first.id });
    expect(again.data.events).toEqual([]);
    expect(again.id).toBe(first.id);
  });

  describe('观众席', () => {
    const say = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }, t = token) =>
      fetch(`${base}/web/api/games/${gameId}/chat?t=${t}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const SECRET_TALK = '我赌凶手是三号座位';

    it('web viewers can post; wrong token and non-JSON are refused; names and text are cleaned', async () => {
      expect((await say({ name: 'x', text: 'hi' }, undefined, 'wrong')).status).toBe(404);
      expect((await say({ name: 'x', text: 'hi' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
      expect((await say({ name: 'x', text: '   ' })).status).toBe(400);
      const r = await say({ name: '  路过的{@all}观众  ', text: SECRET_TALK });
      expect(r.status).toBe(200);
      const v = (await (await fetch(`${base}/web/api/games/${gameId}?t=${token}`)).json()) as any;
      const c = v.chat.find((x: any) => x.text === SECRET_TALK);
      expect(c).toMatchObject({ from: 'web' });
      expect(c.name).not.toContain('{@');
      expect(v.chat_seq).toBeGreaterThanOrEqual(1);
      // 增量：chat_since 之后没有新的
      const v2 = (await (await fetch(`${base}/web/api/games/${gameId}?t=${token}&chat_since=${v.chat_seq}`)).json()) as any;
      expect(v2.chat).toEqual([]);
    });

    it('rate-limits a web viewer', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await say({ name: '刷屏的', text: `第${i}条` })).status);
      expect(codes).toContain(400);
    });

    it('bots that are not in the game can watch and talk; participants can neither see nor post', () => {
      const m = rt.manager;
      const outsider = bot(9);
      const r = m.spectatorSayAs(outsider, gameId, 'AI 观众来了，我也觉得是三号');
      expect(r.ok).toBe(true);
      const sv = m.getView(outsider, gameId) as any;
      expect(sv.you.role).toBe('spectator');
      expect(sv.spectator_chat.map((c: any) => c.text)).toEqual(expect.arrayContaining([SECRET_TALK, 'AI 观众来了，我也觉得是三号']));
      expect(sv.spectator_chat.find((c: any) => c.from === 'agent').name).toBe('Bot9');
      // 再看一次只给新的
      expect((m.getView(outsider, gameId) as any).spectator_chat).toEqual([]);

      for (const who of [bot(1), REF]) {
        expect(() => m.spectatorSayAs(who, gameId, '我是参与者')).toThrow(/参与者/);
        expect(JSON.stringify(m.getView(who, gameId, { fullLog: true }))).not.toContain('三号');
      }
      // 不进群、不进任何对局记录
      const rec = m.getRecord(gameId);
      expect(JSON.stringify(rec.outbox)).not.toContain('三号');
      expect(JSON.stringify(rec.log)).not.toContain('三号');
      expect(rec.spectatorChat!.length).toBeGreaterThanOrEqual(2);
    });

    it('closed before the game starts', () => {
      const m = rt.manager;
      const { summary } = m.createGame(REF, { type: 'jubensha', groupId: 'g-lobby', joinAs: 'referee', options: { stage: 'web', script: 'demo-search' } });
      expect(() => m.spectatorSayAs(bot(9), summary.game_id, 'hi')).toThrow(/还没开始/);
    });
  });

  describe('真人座位', () => {
    /** 读 SSE，直到拿到一条 view 事件（座位推送不带 id） */
    async function seatView(url: string): Promise<any> {
      const ctrl = new AbortController();
      const res = await fetch(url, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buf += new TextDecoder().decode(value);
          const m = /event: view\ndata: (.*)\n\n/.exec(buf);
          if (m) return JSON.parse(m[1]!);
        }
      } finally {
        ctrl.abort();
      }
    }

    let groups = 0;
    async function auctionWithHuman() {
      const m = rt.manager;
      const { summary } = m.createGame(REF, { type: 'sealed_auction', groupId: `g-seat-${++groups}`, joinAs: 'referee', options: { random_seats: false } });
      for (const n of [1, 2]) m.joinGame(bot(n), summary.game_id, { as: 'player' });
      m.addHuman(REF, summary.game_id, { userId: '20001', name: '小明' });
      m.startGame(REF, summary.game_id);
      await m.refereeStep(REF, summary.game_id);
      const rec = m.getRecord(summary.game_id);
      const seat = rec.players.find((p) => p.kind === 'human')!.seat;
      return { id: summary.game_id, rec, seat, tok: rec.seatTokens![String(seat)]! };
    }

    it('shows the seat view, takes commands as JSON only, and 404s on wrong tokens', async () => {
      const { id, rec, seat, tok } = await auctionWithHuman();
      const v = (await (await fetch(`${base}/web/api/games/${id}/seat?s=${tok}`)).json()) as any;
      expect(v.me).toMatchObject({ seat, name: '小明' });
      expect(v.me.todo.channel).toBe('private');
      expect(v.mine.some((x: any) => x.text.includes(tok))).toBe(true);
      expect(v.chat).toBeUndefined();

      expect((await fetch(`${base}/web/api/games/${id}/seat?s=${'x'.repeat(24)}`)).status).toBe(404);
      // 观战接口不认座位令牌（群舞台的局也没有观战令牌）
      expect((await fetch(`${base}/web/api/games/${id}?t=${tok}`)).status).toBe(404);

      const form = await fetch(`${base}/web/api/games/${id}/seat/act?s=${tok}`, { method: 'POST', body: 'text=出价3' });
      expect(form.status).toBe(415);
      const post = (body: unknown) =>
        fetch(`${base}/web/api/games/${id}/seat/act?s=${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const empty = await post({ text: ' ' });
      expect(empty.status).toBe(400);
      const ok = await (await post({ text: '出价 2', mode: 'command' })).json();
      expect(ok).toMatchObject({ ok: true, accepted: true });
      expect(rec.phase!.pending[String(seat)]?.done ?? true).toBe(true);

      const sv = await seatView(`${base}/web/api/games/${id}/seat/stream?s=${tok}`);
      expect(sv.me.seat).toBe(seat);
      expect((await fetch(`${base}/web/api/games/${id}/seat/stream?s=nope`)).status).toBe(404);
    });

    it('stops working the moment the game is over', async () => {
      const { id, tok } = await auctionWithHuman();
      rt.manager.abortGame(REF, id, '测试');
      expect((await fetch(`${base}/web/api/games/${id}/seat?s=${tok}`)).status).toBe(404);
      const r = await fetch(`${base}/web/api/games/${id}/seat/act?s=${tok}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '出价 1' }),
      });
      expect(r.status).toBe(404);
    });
  });
});
