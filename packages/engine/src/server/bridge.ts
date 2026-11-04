/**
 * bridge 模式：把只支持 stdio 的 MCP 客户端接到远端 HTTP 引擎上。
 *   bot-game-mcp bridge --url http://host:7700/mcp --key <密钥>
 * 本进程对上游是 stdio MCP 服务器，对下游是 Streamable HTTP 客户端，原样转发 tools/resources/prompts。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { VERSION } from '../version.js';

export interface BridgeOptions {
  url: string;
  key?: string;
  /** 单次调用超时（长轮询需要较长时间），默认 120 秒 */
  timeoutMs?: number;
}

export async function startBridge(opts: BridgeOptions, upstream: Transport = new StdioServerTransport()): Promise<{ close(): Promise<void> }> {
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  const client = new Client({ name: 'bot-game-mcp-bridge', version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers } }));

  const remote = client.getServerVersion();
  const caps = client.getServerCapabilities() ?? {};
  const server = new Server(
    { name: remote?.name ?? 'bot-game-mcp', version: remote?.version ?? VERSION },
    {
      capabilities: {
        tools: {},
        ...(caps.resources ? { resources: {} } : {}),
        ...(caps.prompts ? { prompts: {} } : {}),
      },
      instructions: client.getInstructions(),
    },
  );
  const timeout = opts.timeoutMs ?? 120_000;
  const reqOpts = (signal: AbortSignal) => ({ signal, timeout });

  server.setRequestHandler(ListToolsRequestSchema, (req, extra) => client.listTools(req.params, reqOpts(extra.signal)));
  server.setRequestHandler(CallToolRequestSchema, (req, extra) => client.callTool(req.params, undefined, reqOpts(extra.signal)));
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (req, extra) => client.listResources(req.params, reqOpts(extra.signal)));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (req, extra) =>
      client.listResourceTemplates(req.params, reqOpts(extra.signal)),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (req, extra) => client.readResource(req.params, reqOpts(extra.signal)));
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (req, extra) => client.listPrompts(req.params, reqOpts(extra.signal)));
    server.setRequestHandler(GetPromptRequestSchema, (req, extra) => client.getPrompt(req.params, reqOpts(extra.signal)));
  }
  upstream.onclose = () => void client.close();
  await server.connect(upstream);
  return {
    async close() {
      await server.close();
      await client.close();
    },
  };
}
