import { createVerify, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driveAssets, localAssets, splitAsset } from '../../src/core/assets.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('assets: references', () => {
  it('rejects path traversal and non-image files', () => {
    expect(splitAsset('045/地图.png')).toEqual({ pack: '045', file: '地图.png' });
    for (const bad of ['../x.png', '045/../../etc/passwd', '045/a/b.png', '045/.hidden.png', '045/x.txt', 'x.png', '/x.png']) {
      expect(() => splitAsset(bad)).toThrow();
    }
  });

  it('local store reads <dir>/<pack>/<file>', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assets-'));
    mkdirSync(join(dir, '045'));
    writeFileSync(join(dir, '045', 'map.png'), PNG);
    const s = localAssets(dir);
    expect(await s.exists('045/map.png')).toBe(true);
    expect(await s.exists('045/none.png')).toBe(false);
    const a = await s.load('JB-1', '045/map.png');
    expect(a.mime).toBe('image/png');
    expect(a.data.equals(PNG)).toBe(true);
  });
});

describe('assets: Google Drive', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds = { client_email: 'sa@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };

  function fakeDrive() {
    const calls: string[] = [];
    const fakeFetch: typeof globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://oauth2.googleapis.com/token') {
        const assertion = new URLSearchParams(String(init!.body)).get('assertion')!;
        const [h, c, sig] = assertion.split('.');
        const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
        const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
        if (!ok || claims.iss !== creds.client_email || !String(claims.scope).includes('drive.readonly')) return new Response('', { status: 401 });
        return Response.json({ access_token: 'tok', expires_in: 3600 });
      }
      if ((init?.headers as Record<string, string>)?.authorization !== 'Bearer tok') return new Response('', { status: 401 });
      const u = new URL(url);
      if (u.pathname === '/drive/v3/files') {
        const query = u.searchParams.get('q')!;
        if (query.startsWith("'ROOT' in parents and name = '045'")) return Response.json({ files: [{ id: 'F045' }] });
        if (query.startsWith("'F045' in parents and name = 'map.png'")) return Response.json({ files: [{ id: 'IMG1', size: '16' }] });
        return Response.json({ files: [] });
      }
      if (u.pathname === '/drive/v3/files/IMG1' && u.searchParams.get('alt') === 'media') return new Response(PNG);
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    return { fetch: fakeFetch, calls };
  }

  it('downloads into a per-game cache, reuses it, and sweeps it after the game ends', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'cache-'));
    let t = 1_000_000;
    const d = fakeDrive();
    const s = driveAssets({ folderId: 'ROOT', credentials: creds, cacheDir: cache, fetch: d.fetch, now: () => t, graceMs: 60_000 });
    const a = await s.load('JB-AB12', '045/map.png');
    expect(a.data.equals(PNG)).toBe(true);
    expect(existsSync(join(cache, 'JB-AB12', '045', 'map.png'))).toBe(true);
    const n = d.calls.length;
    await s.load('JB-AB12', '045/map.png');
    expect(d.calls.length).toBe(n); // 读缓存
    expect(await s.exists('045/map.png')).toBe(true);
    expect(await s.exists('045/none.png')).toBe(false);
    await expect(s.load('JB-AB12', '045/none.png')).rejects.toThrow(/找不到/);

    s.sweep(new Set(['JB-AB12']));
    expect(existsSync(join(cache, 'JB-AB12'))).toBe(true);
    s.sweep(new Set()); // 刚结束：先留着
    expect(existsSync(join(cache, 'JB-AB12'))).toBe(true);
    t += 61_000;
    s.sweep(new Set());
    expect(existsSync(join(cache, 'JB-AB12'))).toBe(false);
    // 删了以后还能按需重新下载
    expect((await s.load('JB-AB12', '045/map.png')).data.equals(PNG)).toBe(true);
  });

  it('prepare prefetches in the background', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'cache-'));
    const d = fakeDrive();
    const logs: string[] = [];
    const s = driveAssets({ folderId: 'ROOT', credentials: creds, cacheDir: cache, fetch: d.fetch, log: (m) => logs.push(m) });
    s.prepare('JB-X', ['045/map.png', '045/none.png']);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(cache, 'JB-X', '045', 'map.png'))).toBe(true);
    expect(logs.some((l) => l.includes('none.png'))).toBe(true);
  });
});
