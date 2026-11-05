/**
 * MCP 服务器：把 GameManager 暴露为标准 MCP tools / resources / prompts。
 * 每个 MCP 会话创建一个 McpServer 实例（共享同一个 GameManager），会话里绑定调用者身份。
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GameError } from '../core/errors.js';
import type { GameManager } from '../core/manager.js';
import type { ActionInput, Identity } from '../core/types.js';
import type { Authenticator, SessionContext } from './auth.js';
import { OVERVIEW, PLAYER_GUIDE, REFEREE_GUIDE, gameTips, gameTypeTable } from './guides.js';
import { renderDelivery, type DeliveryFormat } from './render.js';

export interface ServerDeps {
  manager: GameManager;
  auth: Authenticator;
  version: string;
}

const MAX_WAIT_SECONDS = 50;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  if (err instanceof GameError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `❌ ${err.message}${err.hint ? `\n💡 ${err.hint}` : ''}\n(code: ${err.code})` }],
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: `❌ 服务器内部错误：${msg}` }] };
}

const gameIdOpt = z.string().optional().describe('对局 ID（如 WW-7K3Q）。不填则自动使用你当前参与的对局');
const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(`长轮询等待秒数（0~${MAX_WAIT_SECONDS}），有新情况会提前返回`);

const actionShape = {
  action: z
    .string()
    .describe('动作名，取自 get_my_view 返回的 todo.actions[].action，例如 vote / kill / check / guard / save / poison / shoot / skip / bid / challenge / guess / speech / end_speech'),
  target: z.number().int().min(0).max(99).optional().describe('目标座位号（数字）'),
  quantity: z.number().int().min(1).max(999).optional().describe('大话骰：叫的个数'),
  face: z.number().int().min(1).max(6).optional().describe('大话骰：叫的点数 1~6'),
  number: z.number().int().min(-1_000_000).max(1_000_000).optional().describe('数字炸弹：猜的数字'),
  text: z.string().optional().describe('文字内容（发言等）'),
};

export const SERVER_INSTRUCTIONS = `QQ 群桌游引擎（狼人杀 / 谁是卧底 / 大话骰 / 数字炸弹）。
程序决定一切身份与结果；程序抽签产生的 AI 裁判只负责：循环调用 referee_step 并把消息发到群里/私聊真人，以及用 relay_human_message 转发真人的消息。
AI 玩家：get_my_view 看身份和待办 → 轮到你时用 speak / act。
首次使用：open 认证模式下先 login；不确定时先 whoami。详细说明见 prompts「referee」「player」或资源 botgame://guide/overview。`;

export function createMcpServer(deps: ServerDeps, ctx: SessionContext): McpServer {
  const { manager, auth, version } = deps;
  const server = new McpServer(
    { name: 'bot-game-mcp', title: 'QQ 群桌游引擎', version },
    { capabilities: { logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  const me = (): Identity => auth.require(ctx);

  type Handler<A> = (args: A, extra: { signal: AbortSignal }) => unknown | Promise<unknown>;
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Shape;
      readOnly?: boolean;
      destructive?: boolean;
      idempotent?: boolean;
    },
    handler: Handler<z.infer<z.ZodObject<Shape>>>,
  ): void {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: {
          title: config.title,
          readOnlyHint: config.readOnly ?? false,
          destructiveHint: config.destructive ?? false,
          idempotentHint: config.idempotent ?? false,
          openWorldHint: false,
        },
      },
      (async (args: any, extra: any) => {
        try {
          return ok(await handler(args, extra));
        } catch (e) {
          return fail(e);
        }
      }) as any,
    );
  }

  // ─────────────────────────── 身份 ───────────────────────────

  tool(
    'login',
    {
      title: '登录 / 认领身份',
      description:
        '（open 认证模式）用你的 QQ 号和群昵称登录，之后所有操作都以此身份进行。首次认领会返回 secret，请记住；在新会话里重新登录同一 QQ 号时需要它。keys 模式下无需调用（身份由密钥决定）。',
      inputSchema: {
        qq_id: z.string().describe('你的 QQ 号'),
        nickname: z.string().describe('你在群里的昵称'),
        secret: z.string().optional().describe('首次登录时返回的 secret（重新登录时需要）'),
      },
      idempotent: true,
    },
    (a) => {
      const r = auth.login(ctx, { id: a.qq_id, name: a.nickname, secret: a.secret });
      return {
        ok: true,
        identity: r.identity,
        ...(r.secret
          ? { secret: r.secret, note: '这是你的身份凭证，请保存好、不要告诉任何人；在新会话重新 login 同一 QQ 号时需要提供。' }
          : {}),
      };
    },
  );

  tool(
    'whoami',
    {
      title: '我是谁',
      description: '查看当前会话的身份、认证模式，以及你正在参与（作为玩家/裁判/房主）的对局。',
      inputSchema: {},
      readOnly: true,
    },
    () => {
      const id = ctx.identity;
      const games = id
        ? manager
            .listGames()
            .filter((g) => {
              const rec = manager.getRecord(g.game_id);
              return (
                rec.hostId === id.id ||
                rec.referee?.id === id.id ||
                rec.players.some((p) => p.id === id.id) ||
                rec.lobby.some((e) => e.id === id.id)
              );
            })
        : [];
      return {
        identity: id,
        auth_mode: auth.mode,
        logged_in: Boolean(id),
        my_games: games,
        hint: id
          ? games.length
            ? '调用 get_my_view 查看对局详情。'
            : '可以 list_games 查看群里的对局，或 create_game 开一局。'
          : auth.mode === 'open'
            ? '请先调用 login。'
            : '请在 MCP 客户端配置 Authorization: Bearer <密钥>。',
      };
    },
  );

  // ─────────────────────────── 大厅 ───────────────────────────

  tool(
    'list_games',
    {
      title: '游戏与对局列表',
      description: '列出可玩的游戏类型，以及进行中/报名中的对局（可按 QQ 群筛选）。',
      inputSchema: {
        group_id: z.string().optional().describe('只看这个 QQ 群的对局'),
        include_finished: z.boolean().optional().describe('是否包含已结束的对局'),
      },
      readOnly: true,
    },
    (a) => ({
      game_types: manager.registry.list().map((d) => ({
        type: d.type,
        name: d.name,
        players: `${d.minPlayers}~${d.maxPlayers}`,
        summary: d.summary,
      })),
      games: manager.listGames({ groupId: a.group_id, includeFinished: a.include_finished }),
    }),
  );

  tool(
    'get_rules',
    {
      title: '查看规则',
      description: '查看某个游戏的完整规则、可用选项（create_game 的 options）以及给 AI 玩家的提示。不填 game_type 则列出所有游戏。',
      inputSchema: { game_type: z.string().optional().describe('游戏类型或中文名，如 werewolf / 狼人杀') },
      readOnly: true,
    },
    (a) => {
      if (!a.game_type) return { overview: OVERVIEW, games: gameTypeTable(manager.registry) };
      const def = manager.describeType(a.game_type);
      return {
        type: def.type,
        name: def.name,
        players: `${def.minPlayers}~${def.maxPlayers}`,
        rules: def.rules,
        options: def.optionsHelp,
        tips_for_ai_players: def.playerTips ?? '',
      };
    },
  );

  tool(
    'create_game',
    {
      title: '开房',
      description:
        '在某个 QQ 群开一局游戏（同一群同时只能有一局）。你成为房主。返回的 group_message 请发到群里招呼大家报名。join_as 决定你自己是否参加：player 玩家 / referee 只当裁判 / either 由程序抽签（默认）/ none 不参加。',
      inputSchema: {
        game_type: z.string().describe('werewolf(狼人杀) / undercover(谁是卧底) / liars_dice(大话骰) / number_bomb(数字炸弹)，也可用中文名'),
        group_id: z.string().describe('QQ 群号'),
        join_as: z.enum(['player', 'referee', 'either', 'none']).optional().describe('你自己的报名方式，默认 either'),
        options: z.looseObject({}).optional().describe('游戏选项（见 get_rules），如 {"win_mode":"all"}'),
        self_post: z
          .boolean()
          .optional()
          .describe('你作为玩家时是否自己把发言发到群里（默认 true）；false 则由裁判代发'),
        auto_referee: z
          .boolean()
          .optional()
          .describe('true = 不需要 AI 裁判，程序自动推进（适合纯 MCP 对战/测试；不会有人往 QQ 发消息）'),
      },
    },
    (a) => {
      const r = manager.createGame(me(), {
        type: a.game_type,
        groupId: a.group_id,
        joinAs: a.join_as,
        options: a.options,
        selfPost: a.self_post,
        autoReferee: a.auto_referee,
      });
      return { ...r, instruction: '请把 group_message 发到群里。' };
    },
  );

  tool(
    'join_game',
    {
      title: '报名',
      description:
        '以 AI 身份报名对局。join_as: player 当玩家 / referee 只当裁判 / either 都行（默认，由程序在开局时抽签决定谁当裁判）。游戏进行中以 referee 报名则成为候补裁判。',
      inputSchema: {
        game_id: z.string().describe('对局 ID'),
        join_as: z.enum(['player', 'referee', 'either']).optional(),
        self_post: z.boolean().optional().describe('是否自己把发言发到群里（默认 true）'),
      },
      idempotent: true,
    },
    (a) => manager.joinGame(me(), a.game_id, { as: a.join_as, selfPost: a.self_post }),
  );

  tool(
    'add_human_player',
    {
      title: '登记真人玩家',
      description: '真人在群里说想参加时，由房主或任意已报名的 AI 代为登记（真人无法直接调用工具）。开局后真人的身份会由裁判私聊发送。',
      inputSchema: {
        game_id: z.string(),
        qq_id: z.string().describe('真人的 QQ 号'),
        nickname: z.string().describe('真人的群昵称'),
      },
      idempotent: true,
    },
    (a) => manager.addHuman(me(), a.game_id, { userId: a.qq_id, name: a.nickname }),
  );

  tool(
    'leave_game',
    {
      title: '退出报名',
      description: '报名阶段退出（不填 qq_id 则退出自己；房主/已报名的 AI 可移除真人）。游戏开始后不能退出。',
      inputSchema: { game_id: z.string(), qq_id: z.string().optional() },
    },
    (a) => manager.leaveGame(me(), a.game_id, a.qq_id),
  );

  tool(
    'start_game',
    {
      title: '开局',
      description: '房主开局：程序抽签选出 AI 裁判（有 referee_offer 登记时在登记池里抽，返回 referee_draw）、随机分配座位和身份。返回裁判是谁；group_message 请发到群里。',
      inputSchema: { game_id: z.string() },
    },
    (a) => manager.startGame(me(), a.game_id),
  );

  tool(
    'abort_game',
    {
      title: '中止对局',
      description: '房主、裁判或管理员中止对局（无胜负）。',
      inputSchema: { game_id: z.string(), reason: z.string().optional() },
      destructive: true,
    },
    (a) => manager.abortGame(me(), a.game_id, a.reason),
  );

  // ─────────────────────────── 玩家 ───────────────────────────

  tool(
    'get_my_view',
    {
      title: '我的视角',
      description:
        '查看你在对局中的视角：你的身份/词语/骰子等私密信息(you)、公开局面(public)、新事件(new_events)、待办(todo, your_turn)。wait_seconds>0 时会等到轮到你（或游戏结束）再返回。裁判调用时返回主持信息。',
      inputSchema: {
        game_id: gameIdOpt,
        wait_seconds: waitSeconds,
        wake_on: z.enum(['turn', 'any']).optional().describe('等待时：turn=轮到我才返回（默认）；any=有任何新事件就返回'),
        full_log: z.boolean().optional().describe('返回你可见的全部历史事件（默认只返回上次查看后的新事件）'),
      },
      readOnly: true,
    },
    async (a, extra) => {
      const wait = Math.min(a.wait_seconds ?? 0, MAX_WAIT_SECONDS) * 1000;
      return manager.waitView(me(), a.game_id, wait, { fullLog: a.full_log, wakeOn: a.wake_on }, extra.signal);
    },
  );

  tool(
    'speak',
    {
      title: '发言',
      description:
        '轮到你发言（白天发言、遗言、PK 发言、描述词语等）时调用。channel="team" 用于狼人夜间队内交流。若结果含 post_to_group，请把发言原文发到群里。',
      inputSchema: {
        text: z.string().min(1).max(1000).describe('发言内容'),
        channel: z.enum(['public', 'team']).optional().describe('public（默认）或 team（狼队夜聊）'),
        game_id: gameIdOpt,
      },
    },
    (a) => manager.speak(me(), a.game_id, a.text, a.channel ?? 'public'),
  );

  tool(
    'act',
    {
      title: '行动',
      description:
        '执行游戏动作（投票、夜间技能、出价、开骰、猜数……）。可用的 action 及参数以 get_my_view 返回的 todo.actions 为准，示例：act({"action":"vote","target":3})、act({"action":"bid","quantity":4,"face":6})、act({"action":"skip"})。',
      inputSchema: { ...actionShape, game_id: gameIdOpt },
    },
    (a) => {
      const { game_id, ...input } = a;
      return manager.act(me(), game_id, input as ActionInput);
    },
  );

  tool(
    'get_game_log',
    {
      title: '对局记录',
      description: '查看你可见的对局事件记录。游戏结束后所有人都能看到完整复盘（含所有私密信息）。',
      inputSchema: {
        game_id: gameIdOpt,
        since_seq: z.number().int().min(0).max(1_000_000_000).optional().describe('只返回 seq 大于此值的事件（seq 是你视角内的连续编号；游戏正常结束公开完整复盘后会重新编号）'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
      readOnly: true,
    },
    (a) => manager.getLog(me(), a.game_id, { sinceSeq: a.since_seq, limit: a.limit }),
  );

  // ─────────────────────────── 裁判 ───────────────────────────

  tool(
    'referee_step',
    {
      title: '裁判：推进并取消息',
      description:
        '【仅裁判】推进游戏并取回需要发送的消息：程序处理超时与结算，返回按顺序排列的 deliveries（to=group 发群里，to=private 私聊对应真人）。发完立刻再调用，建议 wait_seconds=25；finished=true 时结束。',
      inputSchema: {
        game_id: gameIdOpt,
        wait_seconds: waitSeconds,
        since_seq: z.number().int().min(0).max(1_000_000_000).optional().describe('重发：返回 seq 大于此值的所有已到期消息'),
        host_id: z.string().max(100).optional().describe('代行裁判进程的标识（referee_offer 时登记的那个）。裁判事务被代行时，不带正确 host_id 的调用只得到空结果'),
        format: z
          .enum(['text', 'cq', 'onebot'])
          .optional()
          .describe('消息格式：text（默认，@昵称 + mentions）/ cq（CQ 码）/ onebot（OneBot v11 消息段数组）'),
        inline_images: z
          .boolean()
          .optional()
          .describe('代码裁判用：cq / onebot 格式里把图片以 base64 内嵌（剧本杀线索图）。默认不内嵌，图片位置显示为「[图片]」，后面跟着图片的文字说明'),
      },
    },
    async (a, extra) => {
      const r = await manager.refereeStep(
        me(),
        a.game_id,
        {
          sinceSeq: a.since_seq,
          waitMs: Math.min(a.wait_seconds ?? 0, MAX_WAIT_SECONDS) * 1000,
          hostId: a.host_id,
          inlineImages: Boolean(a.inline_images) && (a.format === 'cq' || a.format === 'onebot'),
        },
        extra.signal,
      );
      const fmt: DeliveryFormat = a.format ?? 'text';
      return { ...r, deliveries: r.deliveries.map((d) => renderDelivery(d, fmt)) };
    },
  );

  tool(
    'relay_human_message',
    {
      title: '裁判：转发真人消息',
      description:
        '【裁判；报名阶段任意已报名 AI 也可】把真人玩家在群里或私聊里说的话原样转交给程序解析（投票、发言、夜间行动、出价、「加入」等）。不是指令会被忽略。意思明确但未被识别时，可附 action 结构化指令（程序会私聊告知该玩家）。',
      inputSchema: {
        game_id: gameIdOpt,
        qq_id: z.string().describe('发消息的真人 QQ 号'),
        nickname: z.string().optional().describe('真人昵称（报名「加入」时需要）'),
        text: z.string().describe('消息原文'),
        channel: z.enum(['group', 'private']).optional().describe('消息来自群聊(group，默认)还是私聊(private)'),
        action: z.object(actionShape).optional().describe('可选：结构化指令（仅在自动识别失败但玩家意思明确时使用）'),
        host_id: z.string().max(100).optional().describe('代行裁判进程的标识（见 referee_offer）'),
      },
    },
    (a) =>
      manager.relayHumanMessage(me(), a.game_id, {
        userId: a.qq_id,
        nickname: a.nickname,
        text: a.text,
        channel: a.channel ?? 'group',
        action: a.action as ActionInput | undefined,
        hostId: a.host_id,
      }),
  );

  tool(
    'referee_offer',
    {
      title: '登记代行裁判',
      description:
        '【代码裁判进程用】登记「开局若抽中这个账号当裁判，裁判事务由 host_id 这个程序代行」。登记过的账号进入开局抽签池：玩家报名的账号被抽中就改当裁判（人数仍够时才会抽到玩家），没报名的账号自动以 referee 身份报名。抽中后这个账号自己的模型调 referee_step 只得到空结果，裁判的每句话都由程序发出。',
      inputSchema: {
        game_id: z.string(),
        host_id: z.string().min(1).max(100).describe('裁判进程的标识（同一进程每次都用同一个）'),
        withdraw: z.boolean().optional().describe('true：撤销登记'),
      },
      idempotent: true,
    },
    (a) => manager.offerReferee(me(), a.game_id, a.host_id, a.withdraw ?? false),
  );

  tool(
    'referee_takeover',
    {
      title: '接管裁判',
      description: '当前裁判失联超过时限时，由候补裁判接管裁判职责。候补裁判 = 开局时未被抽中的裁判候选，或开局后以 join_game(join_as="referee") 登记的非玩家 AI。',
      inputSchema: { game_id: z.string(), host_id: z.string().max(100).optional().describe('接管后由这个代行进程执行裁判事务（代码裁判用）') },
    },
    (a) => manager.refereeTakeover(me(), a.game_id, a.host_id),
  );

  // ─────────────────────────── 管理（管理员密钥） ───────────────────────────

  tool(
    'issue_key',
    {
      title: '发放密钥',
      description:
        '【管理员或负责发密钥的账号用】给一个新的 bot 发放接入密钥（bgk_ 开头），立即生效并持久保存；同一 QQ 号再次发放会作废旧密钥。带 owner（申请人 QQ 号）时，别人申请过的 QQ 号只有同一申请人能重新发放（管理员可用 force 覆盖）。返回的 key 只出现这一次，请转交给对方。',
      inputSchema: {
        qq_id: z.string().describe('bot 的 QQ 号'),
        name: z.string().describe('bot 的群昵称'),
        owner: z.string().optional().describe('申请人的 QQ 号（记录归属，用于限制重复申请）'),
        force: z.boolean().optional().describe('true：无视归属强制重新发放（仅管理员）'),
      },
    },
    (a) => {
      const r = auth.issueKey(me(), { id: a.qq_id, name: a.name, owner: a.owner, force: a.force });
      return { ok: true, ...r.entry, key: r.key, rotated: r.rotated, note: '密钥只返回这一次；对方在 MCP 客户端里配置 Authorization: Bearer <key>。' };
    },
  );

  tool(
    'revoke_key',
    {
      title: '作废密钥',
      description: '【管理员或负责发密钥的账号用】作废一把运行时发放的密钥（配置文件里写死的密钥不能用这个删）。',
      inputSchema: { qq_id: z.string().describe('bot 的 QQ 号') },
      destructive: true,
      idempotent: true,
    },
    (a) => ({ ok: true, revoked: auth.revokeKey(me(), a.qq_id) }),
  );

  tool(
    'list_keys',
    {
      title: '已发放的密钥',
      description: '【管理员或负责发密钥的账号用】列出运行时发放过的密钥对应的 QQ 号、昵称、申请人和时间（不含密钥本身）。',
      inputSchema: {},
      readOnly: true,
    },
    () => ({ keys: auth.listIssued(me()) }),
  );

  // ─────────────────────────── 资源 ───────────────────────────

  const md = (uri: URL, text: string) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] });
  server.registerResource(
    'overview',
    'botgame://guide/overview',
    { title: '总览', description: '引擎概念与典型流程', mimeType: 'text/markdown' },
    (uri) => md(uri, `${OVERVIEW}\n## 游戏\n${gameTypeTable(manager.registry)}`),
  );
  server.registerResource(
    'referee-guide',
    'botgame://guide/referee',
    { title: 'AI 裁判指南', mimeType: 'text/markdown' },
    (uri) => md(uri, REFEREE_GUIDE),
  );
  server.registerResource(
    'player-guide',
    'botgame://guide/player',
    { title: 'AI 玩家指南', mimeType: 'text/markdown' },
    (uri) => md(uri, `${PLAYER_GUIDE}\n${gameTips(manager.registry)}`),
  );
  server.registerResource(
    'rules',
    new ResourceTemplate('botgame://rules/{game_type}', {
      list: async () => ({
        resources: manager.registry.list().map((d) => ({
          uri: `botgame://rules/${d.type}`,
          name: `${d.name}规则`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    { title: '游戏规则', mimeType: 'text/markdown' },
    (uri, vars) => {
      const def = manager.describeType(String(vars.game_type));
      const opts = Object.entries(def.optionsHelp)
        .map(([k, v]) => `- \`${k}\`：${v}`)
        .join('\n');
      return md(uri, `${def.rules}\n\n### 选项\n${opts}\n\n### AI 玩家提示\n${def.playerTips ?? '无'}`);
    },
  );

  // ─────────────────────────── 提示词 ───────────────────────────

  server.registerPrompt(
    'referee',
    {
      title: 'AI 裁判指南',
      description: '给被选为裁判的 AI 的系统提示词',
      argsSchema: { game_id: z.string().optional().describe('对局 ID') },
    },
    (a) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `${REFEREE_GUIDE}${a.game_id ? `\n\n当前对局：${a.game_id}` : ''}` },
        },
      ],
    }),
  );
  server.registerPrompt(
    'player',
    {
      title: 'AI 玩家指南',
      description: '给 AI 玩家的系统提示词（含游戏策略提示）',
      argsSchema: { game_type: z.string().optional().describe('游戏类型，如 werewolf') },
    },
    (a) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `${PLAYER_GUIDE}\n${gameTips(manager.registry, a.game_type)}` } }],
    }),
  );

  return server;
}
