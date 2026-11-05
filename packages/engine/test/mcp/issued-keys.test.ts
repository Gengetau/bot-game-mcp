import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config.js';
import { startHttpServer, type HttpHandle } from '../../src/server/http.js';
import { createRuntime, type Runtime } from '../../src/server/runtime.js';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

const ADMIN = `bgk_${'a'.repeat(32)}`;
const NIA = `bgk_${'n'.repeat(32)}`;

async function connect(url: string, key: string): Promise<Client> {
  const client = new Client({ name: 'issued-keys-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (r.isError) throw new Error(r.content[0]?.text);
  return JSON.parse(r.content[0]!.text);
}

describe('runtime key issuance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botgame-keys-'));
  const keysFile = join(dir, 'nested', 'keys.json');
  const config = () =>
    configSchema.parse({
      host: '127.0.0.1',
      port: 0,
      stateFile: null,
      auth: { mode: 'keys', adminKeys: [ADMIN], agents: [{ key: NIA, id: '2362232313', name: '妮娅' }], issuedKeysFile: keysFile },
    });
  let rt: Runtime;
  let http: HttpHandle;

  beforeAll(async () => {
    rt = createRuntime(config(), () => undefined);
    http = await startHttpServer(rt, () => undefined);
  });
  afterAll(async () => {
    await http.close();
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('admin issues, rotates, lists and revokes keys; the file survives restarts', async () => {
    const admin = await connect(http.url, ADMIN);
    const nia = await connect(http.url, NIA);

    // 普通 agent 不能发放
    await expect(call(nia, 'issue_key', { qq_id: '10086', name: '外来bot' })).rejects.toThrow(/管理员/);

    const issued = await call(admin, 'issue_key', { qq_id: '10086', name: '外来 bot', owner: '555' });
    expect(issued.key).toMatch(/^bgk_[A-Za-z0-9_-]{32}$/);
    expect(issued.rotated).toBe(false);
    expect(issued.owner).toBe('555');
    expect(existsSync(keysFile)).toBe(true);
    expect(statSync(keysFile).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(keysFile, 'utf8'));
    expect(onDisk.keys).toHaveLength(1);
    expect(onDisk.keys[0].key).toBe(issued.key);

    // 新密钥立刻能用，身份是发放时写的
    const bot = await connect(http.url, issued.key);
    const who = await call(bot, 'whoami');
    expect(who.identity).toEqual({ id: '10086', name: '外来 bot' });
    await expect(call(bot, 'list_keys')).rejects.toThrow(/管理员/);

    // 列表不含密钥
    const list = await call(admin, 'list_keys');
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).toMatchObject({ id: '10086', name: '外来 bot', owner: '555', issuedBy: 'admin1' });
    expect(list.keys[0].key).toBeUndefined();

    // 配置文件里的账号不能重新发放；别人申请过的 QQ 号只有申请人能重新申请
    await expect(call(admin, 'issue_key', { qq_id: '2362232313', name: 'x' })).rejects.toThrow(/配置文件/);
    await expect(call(admin, 'issue_key', { qq_id: '10086', name: '抢号', owner: '666' })).rejects.toThrow(/申请人/);
    const forced = await call(admin, 'issue_key', { qq_id: '10086', name: '抢号', owner: '666', force: true });
    expect(forced.rotated).toBe(true);
    expect(forced.key).not.toBe(issued.key);

    // 旧密钥失效，新密钥可用
    const stale = new Client({ name: 't', version: '1' });
    await expect(
      stale.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${issued.key}` } } })),
    ).rejects.toThrow();
    const bot2 = await connect(http.url, forced.key);
    expect((await call(bot2, 'whoami')).identity.name).toBe('抢号');

    // 重启后仍然有效
    await http.close();
    rt.close();
    rt = createRuntime(config(), () => undefined);
    http = await startHttpServer(rt, () => undefined);
    const bot3 = await connect(http.url, forced.key);
    expect((await call(bot3, 'whoami')).identity.id).toBe('10086');

    // 作废
    const admin2 = await connect(http.url, ADMIN);
    expect((await call(admin2, 'revoke_key', { qq_id: '10086' })).revoked).toBe(true);
    expect((await call(admin2, 'revoke_key', { qq_id: '10086' })).revoked).toBe(false);
    await expect(call(admin2, 'revoke_key', { qq_id: '2362232313' })).rejects.toThrow(/配置文件/);
    await expect(call(bot3, 'whoami')).rejects.toThrow();
    expect(JSON.parse(readFileSync(keysFile, 'utf8')).keys).toHaveLength(0);
  });

  it('issuing is disabled when issuedKeysFile is null', async () => {
    const cfg = configSchema.parse({ host: '127.0.0.1', port: 0, stateFile: null, auth: { adminKeys: [ADMIN], agents: [], issuedKeysFile: null } });
    const rt2 = createRuntime(cfg, () => undefined);
    const http2 = await startHttpServer(rt2, () => undefined);
    try {
      const admin = await connect(http2.url, ADMIN);
      await expect(call(admin, 'issue_key', { qq_id: '1', name: 'x' })).rejects.toThrow(/关闭/);
    } finally {
      await http2.close();
      rt2.close();
    }
  });
});
