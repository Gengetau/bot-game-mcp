#!/usr/bin/env node
/**
 * bot-game-referee 命令行：代码驱动的裁判（OneBot v11 正向 WebSocket）。
 *
 *   bot-game-referee --url http://主机:7700/mcp --key 密钥|--key-file 文件 --onebot ws://127.0.0.1:3001/ --group 群号
 *                    [--onebot-token-file 文件] [--admins QQ,QQ] [--bots QQ,QQ] [--bot-commands] [--options '{"nudge_ai":true}']
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runReferee, type VoiceSpec } from './index.js';
import { VERSION } from './version.js';

const HELP = `bot-game-referee ${VERSION} —— bot-game-mcp 的代码裁判（OneBot v11）

用法：
  bot-game-referee --url http://主机:7700/mcp --key 密钥|--key-file 文件 --onebot ws://127.0.0.1:3001/ --group 群号
                   [--onebot-token-file 文件] [--admins QQ,QQ] [--bots QQ,QQ] [--bot-commands] [--options '{"nudge_ai":true}']
                   [--prefix /桌游] [--wait 25] [--auto-start 60] [--lobby-timeout 600]
                   [--voices voices.json] [--host-id 标识] [--no-self-in-pool] [--wheel-font unifont.hex.gz] [--no-wheel] [--follower]

  用一个或多个 OneBot v11 账号（正向 WebSocket）把引擎的消息发到群里和私聊里，转交真人消息，响应「/桌游」指令。
  它只用裁判能用的那几个工具，没有任何能影响结果的接口。
  --bot-commands：允许 --bots 里的账号发「/桌游 <游戏>」开房、「/桌游 开局」开局（中止仍只有管理员能用）。
  --auto-start N：报名够人后 N 秒没有新人加入就自动开局（默认 60，0 为关闭）；开房时写人数（/桌游 狼人杀 7）则凑满立刻开局。
  --lobby-timeout N：人数还不够时 N 秒没有新人报名就取消房间（默认 600，0 为关闭）。
  --voices 文件：额外的嗓子账号，JSON 数组，每项 {"keyFile"|"key", "onebot", "onebotTokenFile"|"onebotToken"}。
    报名了的嗓子账号会进裁判抽签池，抽中谁就用谁的账号主持；抽中账号自己的模型拿不到任何该发的话。
  --host-id：本进程的标识（默认主机名），重启后要保持一致。--no-self-in-pool：主账号不进抽签池。
  --wheel-font：GNU Unifont 的 .hex/.hex.gz，用来在转盘图上写中文名；--no-wheel 不发转盘图。
  --follower：跟随模式，给外接 bot 用。不开房、不响应指令、不当候补，只在自己的账号报名后登记进抽签池，抽中了就用自己的账号主持。

环境变量：BOTGAME_URL BOTGAME_KEY BOTGAME_ONEBOT_URL BOTGAME_ONEBOT_TOKEN BOTGAME_GROUP BOTGAME_ADMINS BOTGAME_BOTS
          BOTGAME_VOICES BOTGAME_HOST_ID BOTGAME_WHEEL_FONT`;

/** --voices 文件：[{ "keyFile": "...", "onebot": "ws://...", "onebotTokenFile": "..." }, …]，路径相对文件所在目录。 */
function loadVoices(file: string): VoiceSpec[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file}：应是一个 JSON 数组`);
  const base = dirname(resolve(file));
  const rel = (p: string) => resolve(base, p);
  return raw.map((v: any, i: number) => {
    const key = typeof v?.key === 'string' ? v.key : typeof v?.keyFile === 'string' ? readFileSync(rel(v.keyFile), 'utf8').trim() : '';
    const onebotUrl = typeof v?.onebot === 'string' ? v.onebot : '';
    if (!key || !onebotUrl) throw new Error(`${file} 第 ${i + 1} 项：需要 key/keyFile 和 onebot`);
    const onebotToken =
      typeof v?.onebotToken === 'string' ? v.onebotToken : typeof v?.onebotTokenFile === 'string' ? readFileSync(rel(v.onebotTokenFile), 'utf8').trim() : undefined;
    return { key, onebotUrl, onebotToken };
  });
}

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
      'auto-start': { type: 'string' },
      'lobby-timeout': { type: 'string' },
      voices: { type: 'string' },
      'host-id': { type: 'string' },
      'no-self-in-pool': { type: 'boolean' },
      'wheel-font': { type: 'string' },
      'no-wheel': { type: 'boolean' },
      follower: { type: 'boolean' },
      'bot-commands': { type: 'boolean' },
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
  const voicesFile = str('voices') ?? process.env.BOTGAME_VOICES;
  const voices = voicesFile ? loadVoices(voicesFile) : [];
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
    botCommands: Boolean(values['bot-commands']),
    defaultOptions: str('options') ? JSON.parse(str('options')!) : undefined,
    commandPrefix: str('prefix'),
    stepWaitSeconds: str('wait') ? Number(str('wait')) : undefined,
    autoStartSeconds: str('auto-start') !== undefined ? Number(str('auto-start')) : 60,
    lobbyTimeoutSeconds: str('lobby-timeout') !== undefined ? Number(str('lobby-timeout')) : 600,
    voices,
    hostId: str('host-id') ?? process.env.BOTGAME_HOST_ID,
    selfInPool: !values['no-self-in-pool'],
    wheelImage: !values['no-wheel'],
    follower: Boolean(values.follower),
    wheelFont: str('wheel-font') ?? process.env.BOTGAME_WHEEL_FONT,
    signal: ac.signal,
  });
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
