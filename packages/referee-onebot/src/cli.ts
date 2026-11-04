#!/usr/bin/env node
/**
 * bot-game-referee 命令行：代码驱动的裁判（OneBot v11 正向 WebSocket）。
 *
 *   bot-game-referee --url http://主机:7700/mcp --key 密钥|--key-file 文件 --onebot ws://127.0.0.1:3001/ --group 群号
 *                    [--onebot-token-file 文件] [--admins QQ,QQ] [--bots QQ,QQ] [--options '{"nudge_ai":true}']
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runReferee } from './index.js';
import { VERSION } from './version.js';

const HELP = `bot-game-referee ${VERSION} —— bot-game-mcp 的代码裁判（OneBot v11）

用法：
  bot-game-referee --url http://主机:7700/mcp --key 密钥|--key-file 文件 --onebot ws://127.0.0.1:3001/ --group 群号
                   [--onebot-token-file 文件] [--admins QQ,QQ] [--bots QQ,QQ] [--options '{"nudge_ai":true}']
                   [--prefix /桌游] [--wait 25]

  用一个 OneBot v11 账号（正向 WebSocket）把引擎的消息发到群里和私聊里，转交真人消息，响应「/桌游」指令。
  它只用裁判能用的那几个工具，没有任何能影响结果的接口。

环境变量：BOTGAME_URL BOTGAME_KEY BOTGAME_ONEBOT_URL BOTGAME_ONEBOT_TOKEN BOTGAME_GROUP BOTGAME_ADMINS BOTGAME_BOTS`;

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: 'string' },
      key: { type: 'string', short: 'k' },
      'key-file': { type: 'string' },
      onebot: { type: 'string' },
      'onebot-token-file': { type: 'string' },
      group: { type: 'string' },
      admins: { type: 'string' },
      bots: { type: 'string' },
      options: { type: 'string' },
      prefix: { type: 'string' },
      wait: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  const url = str('url') ?? process.env.BOTGAME_URL;
  if (!url) throw new Error('需要 --url（引擎地址，例如 http://127.0.0.1:7700/mcp）');
  const key = str('key') ?? (str('key-file') ? readFileSync(str('key-file')!, 'utf8').trim() : process.env.BOTGAME_KEY);
  const onebotUrl = str('onebot') ?? process.env.BOTGAME_ONEBOT_URL;
  if (!onebotUrl) throw new Error('需要 --onebot（OneBot v11 正向 WebSocket 地址，例如 ws://127.0.0.1:3001/）');
  const onebotToken = str('onebot-token-file') ? readFileSync(str('onebot-token-file')!, 'utf8').trim() : process.env.BOTGAME_ONEBOT_TOKEN;
  const groupId = str('group') ?? process.env.BOTGAME_GROUP;
  if (!groupId) throw new Error('需要 --group（只服务这个群）');
  const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());
  await runReferee({
    url,
    key,
    onebotUrl,
    onebotToken,
    groupId,
    admins: list(str('admins') ?? process.env.BOTGAME_ADMINS),
    bots: list(str('bots') ?? process.env.BOTGAME_BOTS),
    defaultOptions: str('options') ? JSON.parse(str('options')!) : undefined,
    commandPrefix: str('prefix'),
    stepWaitSeconds: str('wait') ? Number(str('wait')) : undefined,
    signal: ac.signal,
  });
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
