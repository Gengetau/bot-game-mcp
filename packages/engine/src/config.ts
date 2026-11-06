/**
 * 配置：JSON 文件 + 环境变量覆盖。
 *
 * 示例见 examples/botgame.config.example.json。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const agentKeySchema = z.object({
  /** 该 agent 访问 MCP 时携带的密钥（Authorization: Bearer <key>） */
  key: z.string().min(8),
  /** QQ 号 */
  id: z.string().min(1),
  /** 昵称 */
  name: z.string().min(1),
  admin: z.boolean().optional(),
  /** 只能管理运行时发放的密钥（issue_key / revoke_key / list_keys），没有其他管理员权限 */
  keyIssuer: z.boolean().optional(),
});

export const configSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(7700),
  /** Streamable HTTP 端点路径 */
  path: z.string().default('/mcp'),
  /** Host 头白名单（只比主机名）。不设时监听本机只放行 localhost/127.0.0.1，经隧道对外暴露必须把对外域名加进来 */
  allowedHosts: z.array(z.string()).optional(),
  /** 兼容旧客户端的 HTTP+SSE 传输（/sse + /messages） */
  legacySse: z.boolean().default(true),
  /** 只读的公开观战接口 /api/games */
  publicApi: z.boolean().default(true),
  /** 只允许在这些群号开房；为空则不限制（对外开放时建议配置） */
  allowedGroups: z.array(z.string().min(1)).default([]),
  /** 整个服务器同时最多几局（报名中 + 进行中）；0 为不限制。想「一次只开一场」就设 1 */
  maxActiveGames: z.number().int().min(0).default(0),
  /** 只有这些 QQ 号能当裁判（抽签池、候补、接管）；为空则不限制。名单外的 AI 报名「都行」按玩家处理 */
  refereeIds: z.array(z.string().min(1)).default([]),
  /** 开房默认选项（所有游戏共用，不认识的键忽略；开房时传的选项覆盖它）。bot 直接 create_game 开的房也按这个来，如 {"night_timeout_s":150} */
  defaultOptions: z.record(z.string(), z.unknown()).default({}),
  /** 剧本杀数据包目录（私有，放 *.json）；null 则剧本杀没有可用剧本。剧本绝不能放进公开仓库 */
  scriptsDir: z.string().nullable().default(null),
  /** 剧本杀线索图（本地）：<assetsDir>/<剧本id>/<文件名>。和 drive 二选一，drive 优先 */
  assetsDir: z.string().nullable().default(null),
  /** 剧本杀线索图（Google 云盘，服务账号只读）：根文件夹下每个剧本一个以剧本 id 命名的子文件夹 */
  drive: z
    .object({
      folderId: z.string().min(1),
      /** 服务账号 JSON 密钥文件路径（私有，不要放进仓库或 bot 能读到的地方） */
      credentialsFile: z.string().min(1),
    })
    .nullable()
    .default(null),
  /** 云盘图片的本地缓存目录：开局时下载本局要用的图，对局结束 15 分钟后删除 */
  assetCacheDir: z.string().default('./data/asset-cache'),
  /** 存档文件；为空则仅内存 */
  stateFile: z.string().nullable().default('./data/botgame-state.json'),
  auth: z
    .object({
      /** keys：必须携带配置好的密钥；open：任何人可用 login 工具认领 QQ 号（适合可信小群/本地测试） */
      mode: z.enum(['keys', 'open']).optional(),
      adminKeys: z.array(z.string().min(8)).default([]),
      agents: z.array(agentKeySchema).default([]),
      /**
       * 管理员在运行时用 issue_key 发放的密钥存在这个文件里（引擎自己维护，重启后仍然有效）；
       * null 表示关闭运行时发放。
       */
      issuedKeysFile: z.string().nullable().default('./data/botgame-keys.json'),
    })
    .default({ adminKeys: [], agents: [], issuedKeysFile: './data/botgame-keys.json' }),
  refereeStaleSeconds: z.number().int().min(10).default(120),
  lobbyTtlMinutes: z.number().int().min(1).default(120),
  idleGameTtlMinutes: z.number().int().min(5).default(360),
  /** HTTP 会话空闲多久关闭 */
  sessionIdleMinutes: z.number().int().min(1).default(30),
  /** 仅用于测试/复现：固定随机种子（生产环境不要设置！） */
  seed: z.string().optional(),
});

export type BotGameConfig = z.infer<typeof configSchema>;
export type AgentKey = z.infer<typeof agentKeySchema>;

export interface ResolvedAuth {
  mode: 'keys' | 'open';
  adminKeys: string[];
  agents: AgentKey[];
  /** 运行时发放的密钥的存放文件；不给则只存内存（测试用），null 为关闭发放 */
  issuedKeysFile?: string | null;
}

export function resolveAuth(cfg: BotGameConfig): ResolvedAuth {
  const mode = cfg.auth.mode ?? (cfg.auth.agents.length > 0 ? 'keys' : 'open');
  return { mode, adminKeys: cfg.auth.adminKeys, agents: cfg.auth.agents, issuedKeysFile: cfg.auth.issuedKeysFile };
}

/** 读取配置：显式路径 > BOTGAME_CONFIG > ./botgame.config.json；再用环境变量覆盖。 */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): BotGameConfig {
  const file = path ?? env.BOTGAME_CONFIG ?? (existsSync('botgame.config.json') ? 'botgame.config.json' : undefined);
  let raw: Record<string, any> = {};
  if (file) {
    const full = resolve(file);
    if (!existsSync(full)) throw new Error(`配置文件不存在：${full}`);
    raw = JSON.parse(readFileSync(full, 'utf8'));
  }
  if (env.BOTGAME_HOST) raw.host = env.BOTGAME_HOST;
  if (env.BOTGAME_PORT) raw.port = Number(env.BOTGAME_PORT);
  if (env.BOTGAME_STATE_FILE !== undefined) raw.stateFile = env.BOTGAME_STATE_FILE || null;
  if (env.BOTGAME_SEED) raw.seed = env.BOTGAME_SEED;
  if (env.BOTGAME_SCRIPTS_DIR !== undefined) raw.scriptsDir = env.BOTGAME_SCRIPTS_DIR || null;
  if (env.BOTGAME_ASSETS_DIR !== undefined) raw.assetsDir = env.BOTGAME_ASSETS_DIR || null;
  if (env.BOTGAME_DRIVE_FOLDER_ID && env.BOTGAME_DRIVE_CREDENTIALS) {
    raw.drive = { folderId: env.BOTGAME_DRIVE_FOLDER_ID, credentialsFile: env.BOTGAME_DRIVE_CREDENTIALS };
  }
  if (env.BOTGAME_AUTH_MODE || env.BOTGAME_ADMIN_KEY) {
    raw.auth = { ...(raw.auth ?? {}) };
    if (env.BOTGAME_AUTH_MODE) raw.auth.mode = env.BOTGAME_AUTH_MODE;
    if (env.BOTGAME_ADMIN_KEY) raw.auth.adminKeys = [...(raw.auth.adminKeys ?? []), env.BOTGAME_ADMIN_KEY];
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`配置无效：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')}`);
  }
  const keys = new Set<string>();
  for (const k of [...parsed.data.auth.agents.map((a) => a.key), ...parsed.data.auth.adminKeys]) {
    if (keys.has(k)) throw new Error('配置无效：存在重复的密钥。');
    keys.add(k);
  }
  return parsed.data;
}
