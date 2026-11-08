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
});
