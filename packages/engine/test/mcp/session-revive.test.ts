import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { startHttpServer } from '../../src/server/http.js';
import { createRuntime } from '../../src/server/runtime.js';

const NIA = `bgk_${'n'.repeat(32)}`;

describe('引擎重启后接回会话', () => {
  it('a client keeps its session id across an engine restart; a bad key still gets 401', async () => {
    const config = (port: number) =>
      configSchema.parse({ host: '127.0.0.1', port, stateFile: null, auth: { mode: 'keys', agents: [{ key: NIA, id: '2362232313', name: '妮娅' }], issuedKeysFile: null } });
    const logs: string[] = [];
    let rt = createRuntime(config(0), () => undefined);
    let http = await startHttpServer(rt, (l) => logs.push(l));
    const port = Number(new URL(http.url).port);
    const transport = new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${NIA}` } } });
    const client = new Client({ name: 'revive-test', version: '1.0.0' });
    await client.connect(transport);
    const sid = transport.sessionId!;
    const whoami = async () => JSON.parse(((await client.callTool({ name: 'whoami', arguments: {} })) as any).content[0].text).identity.id;
    expect(await whoami()).toBe('2362232313');

    // 重启：同一端口起新进程，内存里的会话全丢了
    await http.close();
    rt.close();
    rt = createRuntime(config(port), () => undefined);
    // 临时端口被别的进程抢走时（EADDRINUSE）少量重试
    for (let i = 0; ; i++) {
      try {
        http = await startHttpServer(rt, (l) => logs.push(l));
        break;
      } catch (e) {
        if (i >= 20 || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      // 测试里客户端复用了连到旧进程的 keep-alive 连接，第一次可能直接断开；真实部署（隧道）每次是新连接
      expect(await whoami().catch(() => whoami())).toBe('2362232313');
      expect(transport.sessionId).toBe(sid);
      expect(logs.some((l) => l.includes(`接回会话 ${sid.slice(0, 8)}`))).toBe(true);

      // 别人拿着这个会话 ID 但密钥不对：401，不会接回
      const bad = await fetch(http.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'deadbeef-0000', authorization: 'Bearer bgk_wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(bad.status).toBe(401);
      // 已接回的会话不带密钥使用：403（会话与密钥不匹配）
      const other = await fetch(http.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(other.status).toBe(403);
    } finally {
      await client.close().catch(() => undefined);
      await http.close();
      rt.close();
    }
  });
});
