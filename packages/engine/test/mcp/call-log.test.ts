import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { GameManager } from '../../src/core/manager.js';
import { SeededRng } from '../../src/core/rng.js';
import { createRegistry } from '../../src/games/index.js';
import { Authenticator } from '../../src/mcp/auth.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { stamp } from '../../src/server/log.js';

describe('tool call log', () => {
  it('one line per call: who, tool, ok or error code, time; no arguments or keys', async () => {
    const manager = new GameManager({ registry: createRegistry(), rng: new SeededRng('log') });
    const agents = [{ key: 'bgk_secret_key_1234567890', id: '4015457484', name: '小葫芦' }];
    const auth = new Authenticator({ mode: 'keys', adminKeys: [], agents }, manager);
    const lines: string[] = [];
    const server = createMcpServer({ manager, auth, version: 'test', log: (m) => lines.push(m) }, { identity: { id: '4015457484', name: '小葫芦' } } as any);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await server.connect(b);
    await client.connect(a);

    await client.callTool({ name: 'whoami', arguments: {} });
    await client.callTool({ name: 'join_game', arguments: { game_id: 'WW-NONE', join_as: 'player' } });
    await client.callTool({ name: 'referee_step', arguments: { game_id: 'WW-NONE' } });

    expect(lines[0]).toMatch(/^\[call\] 小葫芦\(4015457484\) whoami ok \d+ms$/);
    expect(lines[1]).toMatch(/^\[call\] 小葫芦\(4015457484\) join_game ✗ [A-Z_]+ \d+ms$/);
    expect(lines[2]).toMatch(/referee_step ✗/); // 高频的 referee_step 只在失败时记
    expect(lines.join('\n')).not.toMatch(/WW-NONE|bgk_/);
  });

  it('timestamps look like 11-06 16:41:25', () => {
    expect(stamp(new Date(2026, 10, 6, 16, 41, 5))).toBe('11-06 16:41:05');
  });
});
