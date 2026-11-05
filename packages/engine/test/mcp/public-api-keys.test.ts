import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { startHttpServer } from '../../src/server/http.js';
import { createRuntime } from '../../src/server/runtime.js';

const NIA = `bgk_${'n'.repeat(32)}`;

describe('publicApi: "keys"', () => {
  for (const [mode, anon, withKey] of [
    ['keys', 401, 200],
    [true, 200, 200],
    [false, 404, 404],
  ] as const) {
    it(`publicApi=${JSON.stringify(mode)}: anonymous ${anon}, with key ${withKey}`, async () => {
      const rt = createRuntime(
        configSchema.parse({ host: '127.0.0.1', port: 0, stateFile: null, publicApi: mode, auth: { mode: 'keys', agents: [{ key: NIA, id: '2362232313', name: '妮娅' }], issuedKeysFile: null } }),
        () => undefined,
      );
      const http = await startHttpServer(rt, () => undefined);
      try {
        const api = http.url.replace('/mcp', '/api/games');
        expect((await fetch(api)).status).toBe(anon);
        expect((await fetch(api, { headers: { authorization: 'Bearer bgk_wrong' } })).status).toBe(mode === 'keys' ? 401 : anon);
        const ok = await fetch(api, { headers: { authorization: `Bearer ${NIA}` } });
        expect(ok.status).toBe(withKey);
        if (withKey === 200) expect(Array.isArray(((await ok.json()) as any).games)).toBe(true);
        expect((await fetch(`${api}/NOPE`, { headers: { authorization: `Bearer ${NIA}` } })).status).toBe(404);
        if (mode === 'keys') expect((await fetch(`${api}/NOPE`)).status).toBe(401);
      } finally {
        await http.close();
        rt.close();
      }
    });
  }
});
