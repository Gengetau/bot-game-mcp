#!/usr/bin/env node
/**
 * bot-game-check：接入前的连通性自检。连上引擎，确认密钥对应的身份，列出本群对局。
 *
 *   bot-game-check --url https://主机/mcp --key 密钥 [--group 群号]
 *   （也可用环境变量 BOTGAME_URL、BOTGAME_KEY、BOTGAME_GROUP）
 */
import { parseArgs } from 'node:util';
import { BotGameClient, ToolError } from './index.js';

const HELP = `bot-game-check —— bot-game-mcp 接入自检

用法：bot-game-check --url https://主机/mcp --key 密钥 [--group 群号]
环境变量：BOTGAME_URL BOTGAME_KEY BOTGAME_GROUP

依次做三件事：连接引擎（Streamable HTTP + Bearer 密钥）、whoami 看密钥对应的身份、list_games 看本群对局。
全部通过就说明网络、密钥、群号都对；之后把同样的地址和密钥填进你的 agent 框架即可。`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: false,
    options: { url: { type: 'string' }, key: { type: 'string' }, group: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const url = str('url') ?? process.env.BOTGAME_URL;
  const key = str('key') ?? process.env.BOTGAME_KEY;
  const group = str('group') ?? process.env.BOTGAME_GROUP;
  if (!url) {
    console.error('❌ 需要 --url（引擎的 MCP 地址，例如 https://主机/mcp）');
    return 2;
  }
  if (!key) console.error('⚠️ 没有 --key：只有 open 模式的引擎能连上，keys 模式会被拒绝');

  let client: BotGameClient;
  try {
    client = await BotGameClient.connect({ url, key, clientName: 'bot-game-check' });
    console.log(`✅ 已连接 ${url}`);
  } catch (e) {
    console.error(`❌ 连不上引擎：${e instanceof Error ? e.message : String(e)}`);
    console.error('   检查：地址是否以 /mcp 结尾、主机是否已开放隧道、密钥是否正确（401/403 多半是密钥问题）');
    return 1;
  }
  try {
    const who = await client.whoami();
    const id = who.identity ?? who;
    console.log(`✅ 身份：${id.name ?? '?'}(${id.id ?? '?'})${id.admin ? '，管理员' : ''}`);
    if (!id.id) console.log('   引擎没有返回身份：可能是 open 模式，agent 需要先调用 login 认领 QQ 号');
    const r = await client.listGames(group);
    const games: any[] = r.games ?? [];
    if (games.length === 0) console.log(`✅ ${group ? `群 ${group} ` : ''}现在没有对局（正常；开房后这里会出现）`);
    for (const g of games) {
      console.log(`✅ 对局 ${g.game_id}：${g.name}，${g.status === 'lobby' ? '报名中' : g.status === 'running' ? '进行中' : g.status}，${g.players} 人，群 ${g.group_id}`);
    }
    console.log('自检通过。把同样的地址和密钥填进 agent 框架，等裁判在群里 @ 你报名即可。');
    await client.close();
    return 0;
  } catch (e) {
    console.error(`❌ 引擎拒绝：${e instanceof ToolError ? e.message : e instanceof Error ? e.message : String(e)}`);
    await client.close().catch(() => undefined);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
