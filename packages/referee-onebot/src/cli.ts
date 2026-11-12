#!/usr/bin/env node
/**
 * bot-game-referee 命令行：代码驱动的裁判（OneBot v11 正向 WebSocket）。
 *
 *   bot-game-referee --url http://主机:7700/mcp --key 密钥|--key-file 文件 --onebot ws://127.0.0.1:3001/ --group 群号
 *                    [--onebot-token-file 文件] [--admins QQ,QQ] [--bots QQ,QQ] [--bot-commands] [--main-plays] [--options '{"nudge_ai":true}']
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runReferee, type TownOptions, type VoiceSpec } from './index.js';
import { VERSION } from './version.js';

const HELP = `bot-game-referee ${VERSION} —— bot-game-mcp 的代码裁判（OneBot v11）

用法：
  bot-game-referee --url http://主机:7700/mcp --key 密钥|--key-file 文件 --onebot ws://127.0.0.1:3001/ --group 群号
                   [--onebot-token-file 文件] [--admins QQ,QQ] [--bots QQ,QQ] [--bot-commands] [--main-plays] [--options '{"nudge_ai":true}']
                   [--prefix /桌游] [--wait 25] [--auto-start 60] [--lobby-timeout 600]
                   [--voices voices.json] [--host-id 标识] [--no-self-in-pool] [--wheel-font unifont.hex.gz] [--no-wheel] [--follower] [--no-night-mute] [--no-spectator-mute]
                   [--key-issuer QQ --issuer-key-file 管理员密钥文件 --public-url https://主机/mcp [--max-keys 3]]
                   [--town [--town-keywords 小镇,进小镇] [--town-cooldown 60] [--town-silent] [--town-open-private]
                    [--town-outbox [--town-outbox-group 群号] [--town-outbox-interval 300] [--town-outbox-limit 5]]]

  用一个或多个 OneBot v11 账号（正向 WebSocket）把引擎的消息发到群里和私聊里，转交真人消息，响应「/桌游」指令。
  它只用裁判能用的那几个工具，没有任何能影响结果的接口。
  --bot-commands：允许 --bots 里的账号发「/桌游 <游戏>」开房、「/桌游 开局」开局（中止仍只有管理员能用）。
  --main-plays：主账号也参赛。开房时不自动当裁判候选，由它自己的模型 join_game 报名当玩家，报名了就进抽签池；
    抽不出别的裁判（没有别的候选，或人数只够不能少一个）时，开局前把主账号改回裁判，它这局坐庄。
  --auto-start N：报名够人后 N 秒没有新人加入就自动开局（默认 60，0 为关闭）；开房时写人数（/桌游 狼人杀 7）则凑满立刻开局。
  --lobby-timeout N：人数还不够时 N 秒没有新人报名就取消房间（默认 600，0 为关闭）。
  --voices 文件：额外的嗓子账号，JSON 数组，每项 {"keyFile"|"key", "onebot", "onebotTokenFile"|"onebotToken"}。
    报名了的嗓子账号会进裁判抽签池，抽中谁就用谁的账号主持；抽中账号自己的模型拿不到任何该发的话。
  --host-id：本进程的标识（默认主机名），重启后要保持一致。--no-self-in-pool：主账号不进抽签池。
  --wheel-font：GNU Unifont 的 .hex/.hex.gz，用来在转盘图上写中文名；--no-wheel 不发转盘图。
  --follower：跟随模式，给外接 bot 用。不开房、不响应指令、不当候补，只在自己的账号报名后登记进抽签池，抽中了就用自己的账号主持。
  --no-night-mute：关掉夜间禁言。默认开：狼人杀夜里存活的 AI 玩家在群里说话，撤回那条消息并禁言到天亮（裁判账号要是管理员）。
  --no-spectator-mute：关掉旁观禁言。默认开：对局进行中，没参加本局的人（bot 和真人）在群里说话，撤回并禁言到本局结束（管理员和「/桌游」指令不管）。
  --key-issuer QQ：这个账号（主账号或嗓子账号）负责发密钥：群成员私聊它「申请密钥 <bot的QQ号> <昵称>」就给那个 bot 发一把，
    「撤销密钥 <QQ号>」作废；已发放的 bot 自动算进 --bots。要配 --issuer-key-file（引擎的管理员密钥）和 --public-url（告诉对方的地址）。
  --issuer-key-file 也用于管理员「/桌游 中止」：有了它，bot 自己开的房、程序自动主持的局也能中止（否则只能中止主账号当房主或裁判的局）。
  --town：接入栖灯镇（持续世界，引擎要开 town 且本账号在 refereeIds 里）。真人在群里或私聊发关键词（默认「小镇」「进小镇」「栖灯镇」，
    整条消息就是关键词才算），裁判给他本人签发一次性登录链接，只私聊发给他，群里只回一句提示；私聊发不出去就在群里提示先加好友，不贴链接。
    号码只取自消息事件，不读消息文字。--town-keywords 自定义关键词；--town-cooldown 同一人两次领取的最短间隔秒数（默认 60）；
    --town-silent 引擎没开小镇时不回话（默认回「小镇没开」）；--town-open-private 私聊领取不要求对方在群里（默认要求，管理员不限）。
  --town-outbox：把小镇的稀疏公告（公共活动开场、每日小报）转发到群里（默认关）。发成功才向引擎确认，发送失败下个周期重发（至少一次）。
    --town-outbox-group 目标群（默认 --group）；--town-outbox-interval 取公告的间隔秒数（默认 300）；--town-outbox-limit 每次最多几条（默认 5）。

环境变量：BOTGAME_URL BOTGAME_KEY BOTGAME_ONEBOT_URL BOTGAME_ONEBOT_TOKEN BOTGAME_GROUP BOTGAME_ADMINS BOTGAME_BOTS
          BOTGAME_VOICES BOTGAME_HOST_ID BOTGAME_WHEEL_FONT BOTGAME_KEY_ISSUER BOTGAME_ISSUER_KEY BOTGAME_PUBLIC_URL
          BOTGAME_REFEREE_TOWN=1（等同 --town） BOTGAME_REFEREE_TOWN_OUTBOX=1（等同 --town-outbox）`;

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
      'no-night-mute': { type: 'boolean' },
      'no-spectator-mute': { type: 'boolean' },
      'bot-commands': { type: 'boolean' },
      'main-plays': { type: 'boolean' },
      'key-issuer': { type: 'string' },
      'issuer-key-file': { type: 'string' },
      'public-url': { type: 'string' },
      'max-keys': { type: 'string' },
      town: { type: 'boolean' },
      'town-keywords': { type: 'string' },
      'town-cooldown': { type: 'string' },
      'town-silent': { type: 'boolean' },
      'town-open-private': { type: 'boolean' },
      'town-outbox': { type: 'boolean' },
      'town-outbox-group': { type: 'string' },
      'town-outbox-interval': { type: 'string' },
      'town-outbox-limit': { type: 'string' },
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
  const flag = (v: unknown, env: string) => Boolean(v) || process.env[env] === '1' || process.env[env] === 'true';
  const townOn = flag(values.town, 'BOTGAME_REFEREE_TOWN');
  const outboxOn = flag(values['town-outbox'], 'BOTGAME_REFEREE_TOWN_OUTBOX');
  if (outboxOn && !townOn) throw new Error('--town-outbox 要和 --town 一起用');
  const num = (k: string) => (str(k) !== undefined ? Number(str(k)) : undefined);
  const town: TownOptions | undefined = townOn
    ? {
        keywords: str('town-keywords') || process.env.BOTGAME_TOWN_KEYWORDS ? list(str('town-keywords') ?? process.env.BOTGAME_TOWN_KEYWORDS) : undefined,
        ticketCooldownSeconds: num('town-cooldown'),
        whenOff: values['town-silent'] ? 'silent' : 'reply',
        requireGroupMember: !values['town-open-private'],
        ...(outboxOn ? { outbox: { groupId: str('town-outbox-group'), intervalSeconds: num('town-outbox-interval'), limit: num('town-outbox-limit') } } : {}),
      }
    : undefined;
  const ac = new AbortController();
  // 兜底：正常收尾超过 10 秒就强制退出，部署时不用 kill -9
  ac.signal.addEventListener(
    'abort',
    () => {
      setTimeout(() => {
        console.error('[referee] 10 秒内没能正常退出，强制退出');
        process.exit(1);
      }, 10_000).unref();
    },
    { once: true },
  );
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
    mainPlays: Boolean(values['main-plays']),
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
    nightMute: !values['no-night-mute'],
    spectatorMute: !values['no-spectator-mute'],
    wheelFont: str('wheel-font') ?? process.env.BOTGAME_WHEEL_FONT,
    keyIssuer: str('key-issuer') ?? process.env.BOTGAME_KEY_ISSUER,
    issuerKey: str('issuer-key-file') ? readFileSync(str('issuer-key-file')!, 'utf8').trim() : process.env.BOTGAME_ISSUER_KEY,
    publicUrl: str('public-url') ?? process.env.BOTGAME_PUBLIC_URL,
    maxKeysPerOwner: str('max-keys') ? Number(str('max-keys')) : undefined,
    ...(town ? { town } : {}),
    signal: ac.signal,
  });
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
