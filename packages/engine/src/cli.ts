#!/usr/bin/env node
/**
 * bot-game-mcp 命令行
 *
 *   bot-game-mcp [serve]          启动 HTTP 服务（Streamable HTTP + 旧版 SSE），多个 bot 共享对局
 *   bot-game-mcp stdio            stdio 模式（单客户端，进程内引擎）
 *   bot-game-mcp bridge --url URL --key KEY   把 stdio 客户端桥接到远端 HTTP 引擎
 *   bot-game-mcp simulate <game>  离线模拟一局（随机策略），打印 QQ 风格消息记录
 *   bot-game-mcp gen-key [-n 3]   生成随机密钥
 *   bot-game-mcp init-config      生成示例配置 botgame.config.json
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { startBridge } from './server/bridge.js';
import { startHttpServer } from './server/http.js';
import { createRuntime } from './server/runtime.js';
import { startStdioServer } from './server/stdio.js';
import { simulate } from './sim/simulate.js';
import { VERSION } from './version.js';

const HELP = `bot-game-mcp ${VERSION} —— QQ 群桌游引擎（MCP 服务器）

用法：
  bot-game-mcp [serve] [--config 文件] [--host 地址] [--port 端口] [--state 文件|--no-state]
  bot-game-mcp stdio   [--config 文件] [--state 文件|--no-state] [--agent-id QQ号 --agent-name 昵称]
  bot-game-mcp bridge  --url http://主机:7700/mcp [--key 密钥]
  bot-game-mcp simulate <werewolf|undercover|liars_dice|number_bomb> [--players 9] [--humans 0]
                       [--seed 42] [--options '{"win_mode":"all"}'] [--afk 0.1] [--cq]
  bot-game-mcp gen-key [-n 3]
  bot-game-mcp init-config [--force]

环境变量：BOTGAME_CONFIG BOTGAME_HOST BOTGAME_PORT BOTGAME_STATE_FILE BOTGAME_AUTH_MODE
          BOTGAME_ADMIN_KEY BOTGAME_AGENT_ID BOTGAME_AGENT_NAME（stdio 身份）
代码裁判（OneBot v11）在另一个包：bot-game-mcp-referee-onebot（命令 bot-game-referee）
文档：README.md / docs/`;

const EXAMPLE_CONFIG = {
  host: '127.0.0.1',
  port: 7700,
  path: '/mcp',
  legacySse: true,
  publicApi: true,
  stateFile: './data/botgame-state.json',
  auth: {
    mode: 'keys',
    adminKeys: ['<运行 bot-game-mcp gen-key 生成>'],
    agents: [
      { key: '<密钥1>', id: '<裁判bot的QQ号>', name: '小克' },
      { key: '<密钥2>', id: '<bot2的QQ号>', name: 'Mio' },
    ],
  },
  refereeStaleSeconds: 120,
};

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      config: { type: 'string', short: 'c' },
      host: { type: 'string' },
      port: { type: 'string', short: 'p' },
      state: { type: 'string' },
      'no-state': { type: 'boolean' },
      'agent-id': { type: 'string' },
      'agent-name': { type: 'string' },
      url: { type: 'string' },
      key: { type: 'string', short: 'k' },
      players: { type: 'string' },
      humans: { type: 'string' },
      seed: { type: 'string' },
      options: { type: 'string' },
      afk: { type: 'string' },
      cq: { type: 'boolean' },
      n: { type: 'string', short: 'n' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const cmd = positionals[0] ?? 'serve';

  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  const configFor = () => {
    const cfg = loadConfig(str('config'));
    if (str('host')) cfg.host = str('host')!;
    if (str('port')) cfg.port = Number(str('port'));
    if (str('state')) cfg.stateFile = str('state')!;
    if (values['no-state']) cfg.stateFile = null;
    return cfg;
  };

  switch (cmd) {
    case 'serve':
    case 'http': {
      const rt = createRuntime(configFor());
      const handle = await startHttpServer(rt);
      console.error(`[bot-game-mcp] v${VERSION} 已启动`);
      console.error(`  Streamable HTTP : ${handle.url}`);
      if (rt.config.legacySse) console.error(`  旧版 SSE        : ${handle.url.replace(rt.config.path, '/sse')}`);
      console.error(`  认证模式        : ${rt.auth.mode}${rt.auth.mode === 'keys' ? `（${rt.auth.auth.agents.length} 个 agent 密钥）` : '（agent 用 login 工具认领身份）'}`);
      console.error(`  存档            : ${rt.config.stateFile ?? '（仅内存）'}`);
      const stop = async () => {
        await handle.close();
        rt.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void stop());
      process.on('SIGTERM', () => void stop());
      return;
    }
    case 'stdio': {
      const env = { ...process.env };
      if (str('agent-id')) env.BOTGAME_AGENT_ID = str('agent-id');
      if (str('agent-name')) env.BOTGAME_AGENT_NAME = str('agent-name');
      const rt = createRuntime(configFor());
      await startStdioServer(rt, env);
      const stop = () => {
        rt.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'bridge': {
      const url = str('url') ?? process.env.BOTGAME_URL;
      if (!url) throw new Error('bridge 需要 --url（例如 http://127.0.0.1:7700/mcp）');
      await startBridge({ url, key: str('key') ?? process.env.BOTGAME_KEY });
      process.stderr.write(`[bot-game-mcp] bridge 已连接 ${url}\n`);
      return;
    }
    case 'simulate':
    case 'sim': {
      const type = positionals[1];
      if (!type) throw new Error('用法：bot-game-mcp simulate <game> [--players N]');
      const players = Number(str('players') ?? (type.startsWith('were') || type === '狼人杀' ? 9 : 6));
      const res = await simulate({
        type,
        players,
        humans: Number(str('humans') ?? 0),
        seed: str('seed'),
        options: str('options') ? JSON.parse(str('options')!) : undefined,
        afk: str('afk') ? Number(str('afk')) : undefined,
        format: values.cq ? 'cq' : 'text',
      });
      process.exitCode = res.status === 'ended' ? 0 : 1;
      return;
    }
    case 'gen-key': {
      const n = Math.max(1, Math.min(50, Number(str('n') ?? 1)));
      for (let i = 0; i < n; i++) console.log(`bgk_${randomBytes(24).toString('base64url')}`);
      return;
    }
    case 'init-config': {
      const file = str('config') ?? 'botgame.config.json';
      if (existsSync(file) && !values.force) throw new Error(`${file} 已存在（加 --force 覆盖）`);
      const cfg = structuredClone(EXAMPLE_CONFIG);
      cfg.auth.adminKeys = [`bgk_${randomBytes(24).toString('base64url')}`];
      cfg.auth.agents = cfg.auth.agents.map((a) => ({ ...a, key: `bgk_${randomBytes(24).toString('base64url')}` }));
      writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
      console.log(`已生成 ${file}：请把 agents 里的 QQ 号/昵称改成你的 bot，并把各自的 key 配到对应 agent 的 MCP 客户端里。`);
      return;
    }
    default:
      console.error(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
