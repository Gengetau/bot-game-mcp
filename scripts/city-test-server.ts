#!/usr/bin/env node
/**
 * 启动隔离的灯都城市联调测试服务器（含确定性时钟与 `/__test/city/*` 故障开关控制面）。
 *
 * 用法（仅用于本机隔离测试，绝不连接线上数据库）：
 *   npx tsx scripts/city-test-server.ts [--port 17700] [--dir /tmp/city-test-run]
 */
import { parseArgs } from 'node:util';
import { createIsolatedCityHarness } from '../packages/engine/test/city/test-harness.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      dir: { type: 'string' },
      seed: { type: 'string' },
    },
  });
  const harness = await createIsolatedCityHarness({
    port: values.port ? Number(values.port) : 17700,
    ...(values.dir ? { workDir: values.dir } : {}),
    ...(values.seed ? { seed: values.seed } : {}),
    enableControlRoutes: true,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      baseUrl: harness.baseUrl,
      mcpUrl: harness.mcpUrl,
      bridgeUrl: harness.bridgeUrl,
      controlUrl: `${harness.baseUrl}/__test/city`,
      dbPath: harness.dbPath,
      townEnabled: false,
      cityEnabled: true,
    })}\n`,
  );
  const stop = async () => {
    await harness.close({ cleanup: !values.dir });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e) => {
  process.stderr.write(`city-test-server 启动失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
