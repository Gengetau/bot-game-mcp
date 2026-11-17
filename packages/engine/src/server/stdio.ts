/**
 * stdio 模式：引擎与 MCP 服务器在同一进程，单个客户端独占。
 * 适合：一个 agent 当裁判、玩家全是真人；本地调试；或配合 auto_referee 单机试玩。
 * 多个 bot 共享对局请用 HTTP 模式（或 bridge 模式把 stdio 客户端接到 HTTP 服务器）。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { SessionContext } from '../mcp/auth.js';
import { createMcpServer } from '../mcp/server.js';
import { townPolicy } from '../mcp/town.js';
import type { Runtime } from './runtime.js';

export async function startStdioServer(rt: Runtime, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const id = env.BOTGAME_AGENT_ID?.trim();
  const name = env.BOTGAME_AGENT_NAME?.trim() || id;
  const ctx: SessionContext = {
    identity: id ? { id, name: name!, ...(env.BOTGAME_AGENT_ADMIN === '1' ? { admin: true } : {}) } : null,
    fixed: Boolean(id),
    transport: 'stdio',
  };
  const server = createMcpServer({ manager: rt.manager, auth: rt.auth, version: rt.version, ...(rt.world ? { town: { world: rt.world, auth: rt.auth, trustedIds: rt.config.refereeIds, ...townPolicy(rt.config.town) } } : {}) }, ctx);
  const transport = new StdioServerTransport();
  transport.onclose = () => rt.close();
  await server.connect(transport);
  process.stderr.write(
    `[bot-game-mcp] stdio 模式已启动${ctx.identity ? `，身份 ${ctx.identity.name}(${ctx.identity.id})` : '（请先调用 login）'}\n`,
  );
}
