import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { startAdminServer, type AdminHandle } from '../../src/server/admin.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';
import { REF, bot } from '../helpers.js';

const ADMIN_KEY = `bgk_${'a'.repeat(32)}`;
const W = { 'Content-Type': 'application/json', 'X-Admin-Request': '1' };

describe('管理页', () => {
  let rt: Runtime;
  let admin: AdminHandle;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bg-admin-'));
    rt = createRuntime(
      configSchema.parse({
        host: '127.0.0.1',
        port: 0,
        stateFile: join(dir, 'state.json'),
        scriptsDir: join(__dirname, '../../examples/jubensha'),
        webUrl: 'https://stage.example.com/web/',
        admin: { host: '127.0.0.1', port: 0 },
        auth: { mode: 'keys', adminKeys: [ADMIN_KEY], agents: [], issuedKeysFile: join(dir, 'keys.json') },
      }),
      () => undefined,
    );
    admin = (await startAdminServer(rt, () => undefined))!;
    base = admin.url.replace(/\/$/, '');
  });
  afterAll(async () => {
    await admin.close();
    rt.close();
  });

  const post = (path: string, body: unknown = {}, headers: Record<string, string> = W) =>
    fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('is off unless admin.port is set', async () => {
    const off = createRuntime(configSchema.parse({ stateFile: null, auth: { adminKeys: [ADMIN_KEY], agents: [] } }), () => undefined);
    expect(await startAdminServer(off, () => undefined)).toBeNull();
    off.close();
  });

  it('serves the page with a strict CSP and nothing from a CDN', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('桌游管理');
    expect(html).not.toMatch(/https?:\/\//);
    for (const f of ['admin.js', 'admin.css']) expect((await fetch(`${base}/${f}`)).status).toBe(200);
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/api/overview`);
      http
        .get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example.com' } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        })
        .on('error', reject);
    });
    expect(status).toBe(421);
  });

  it('lists scripts, games and keys without secrets', async () => {
    const m = rt.manager;
    const { summary } = m.createGame(REF, { type: 'jubensha', groupId: 'g', joinAs: 'referee', options: { stage: 'web', script: 'demo-search' } });
    for (const n of [1, 2, 3, 4]) m.joinGame(bot(n), summary.game_id, { as: 'player' });
    m.startGame(REF, summary.game_id);
    rt.auth.issueKey({ id: 'x', name: 'x', admin: true }, { id: '10001', name: '测试bot', owner: '2362232313' });

    const o = await (await fetch(`${base}/api/overview`)).json();
    expect(o.scripts.map((s: any) => s.id).sort()).toEqual(['demo', 'demo-search']);
    expect(o.default_needed).toBe(true);
    expect(o.default_script).toBeNull();
    const g = o.games.active.find((x: any) => x.id === summary.game_id);
    expect(g.status).toBe('running');
    expect(g.watch_url).toMatch(/^https:\/\/stage\.example\.com\/web\/\?g=/);
    expect(o.keys).toEqual([expect.objectContaining({ id: '10001', name: '测试bot', owner: '2362232313' })]);
    const text = JSON.stringify(o);
    // 不带密钥、身份、剧本正文
    expect(text).not.toMatch(/bgk_/);
    expect(text).not.toContain('鞋印');
    expect(text).not.toContain('identity');
  });

  it('write calls need the header, JSON and a same-site Origin', async () => {
    expect((await post('/api/default-script', { id: 'demo' }, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect((await post('/api/default-script', { id: 'demo' }, { 'X-Admin-Request': '1', 'Content-Type': 'text/plain' })).status).toBe(403);
    expect((await post('/api/default-script', { id: 'demo' }, { ...W, Origin: 'https://evil.example.com' })).status).toBe(403);
    expect(rt.settings.jubenshaDefaultScript).toBeUndefined();
  });

  it('sets the default script, persists it, and jubensha uses it', async () => {
    expect((await post('/api/default-script', { id: 'nope' })).status).toBe(400);
    const r = await post('/api/default-script', { id: 'demo' }, { ...W, Origin: base });
    expect(r.status).toBe(200);
    const o = await r.json();
    expect(o.default_script).toBe('demo');
    expect(o.scripts.find((s: any) => s.id === 'demo').is_default).toBe(true);
    const file = join(dir, 'botgame-settings.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ jubenshaDefaultScript: 'demo' });
    expect(statSync(file).mode & 0o077).toBe(0);

    // 开房不写 script 也能开，用的是默认剧本
    const m = rt.manager;
    const { summary } = m.createGame(REF, { type: 'jubensha', groupId: 'g2', joinAs: 'referee', options: { stage: 'web' } });
    const players = m.getRecord(summary.game_id);
    expect(players.status).toBe('lobby');
    const need = rt.scripts!.get('demo')!.roles.length;
    for (let n = 1; n <= need; n++) m.joinGame(bot(20 + n), summary.game_id, { as: 'player' });
    m.startGame(REF, summary.game_id);
    expect((m.getRecord(summary.game_id).state as any).pack.id).toBe('demo');

    // 取消默认后，多个剧本又必须写 script
    const off = await (await post('/api/default-script', { id: null })).json();
    expect(off.default_script).toBeNull();
    const { summary: s3 } = m.createGame(REF, { type: 'jubensha', groupId: 'g3', joinAs: 'referee', options: { stage: 'web' } });
    for (let n = 1; n <= need; n++) m.joinGame(bot(40 + n), s3.game_id, { as: 'player' });
    expect(() => m.startGame(REF, s3.game_id)).toThrow(/script/);
  });

  it('aborts a game and revokes a key', async () => {
    const o = await (await fetch(`${base}/api/overview`)).json();
    const id = o.games.active.find((g: any) => g.status === 'running').id;
    const r = await post(`/api/games/${id}/abort`, {});
    expect(r.status).toBe(200);
    expect(rt.manager.getRecord(id).status).toBe('aborted');
    expect((await post(`/api/games/${id}/abort`, {})).status).toBe(400);

    const k = await post('/api/keys/10001/revoke', {});
    expect(k.status).toBe(200);
    expect((await k.json()).keys).toEqual([]);
    expect((await post('/api/keys/10001/revoke', {})).status).toBe(400);
  });
});
