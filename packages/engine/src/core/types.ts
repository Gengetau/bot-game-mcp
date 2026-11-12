/**
 * 核心数据类型。
 *
 * 设计要点：
 * - 所有对局状态都是可 JSON 序列化的纯数据（GameRecord），游戏逻辑类本身不持有额外状态，
 *   这样服务重启后可以从存档完整恢复。
 * - 身份、流程、胜负全部由程序决定；AI 裁判只能：拉取待发送消息（推进）、转发真人消息。
 */

/** 座位号，从 1 开始。 */
export type Seat = number;

export type ParticipantKind = 'agent' | 'human';

/** 加入大厅时的意向：当玩家 / 当裁判 / 都可以（由程序抽签决定）。 */
export type JoinPreference = 'player' | 'referee' | 'either';

export type GameStatus = 'lobby' | 'running' | 'ended' | 'aborted';

/** 调用者身份（由 MCP 层鉴权后得到）。id 一般是 QQ 号。 */
export interface Identity {
  id: string;
  name: string;
  admin?: boolean;
  /** 能用 issue_key / revoke_key / list_keys 管理运行时发放的密钥（不含其他管理员权限） */
  keyIssuer?: boolean;
}

export interface LobbyEntry {
  id: string;
  name: string;
  kind: ParticipantKind;
  pref: JoinPreference;
  /** agent 是否自己把发言发到群里（默认 true）；false 时由裁判代发。 */
  selfPost: boolean;
  joinedAt: number;
  /** 代行裁判：哪个裁判进程（host_id）登记了「抽中这个账号当裁判时由它来执行」；null/缺省 = 没有。 */
  hostedBy?: string | null;
}

export interface Player {
  seat: Seat;
  id: string;
  name: string;
  kind: ParticipantKind;
  alive: boolean;
  selfPost: boolean;
}

/** 日志/信息的可见范围。 */
export type Audience =
  | { type: 'public' }
  | { type: 'seats'; seats: Seat[] }
  /** 仅裁判可见的运维信息（不会包含 bot 的身份）。 */
  | { type: 'referee' };

export interface LogEntry {
  seq: number;
  at: number;
  round: number;
  /** 产生该条目时的阶段 key。 */
  phase: string | null;
  /** announce | speech | team_chat | vote | death | private | action | system ... */
  kind: string;
  text: string;
  seat?: Seat;
  audience: Audience;
  data?: Record<string, unknown>;
}

export type DeliveryTarget =
  | { type: 'group'; groupId: string }
  | { type: 'private'; userId: string; name: string; seat?: Seat };

export type DeliveryCategory =
  | 'announce' // 公告
  | 'role' // 身份牌
  | 'prompt' // 行动提示
  | 'info' // 私密信息（查验结果等）
  | 'feedback' // 对真人指令的回执
  | 'speech'; // 代发的 bot 发言

/**
 * 消息片段（与 OneBot v11 的 text / at / image 段对应）。
 * image 只存引用（"剧本id/文件名"）和文字说明；data（base64）只在 referee_step 的 inline_images=true 时临时填入，不进存档。
 */
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'at'; id: string; name: string }
  | { type: 'image'; asset: string; caption: string; data?: string; mime?: string };

/** 需要裁判发到 QQ 的消息（群消息或给真人的私聊）。 */
export interface Delivery {
  seq: number;
  createdAt: number;
  /** 在此时间之前不交给裁判（用于给 bot 留出自己发言的时间、保证顺序）。 */
  notBefore: number;
  target: DeliveryTarget;
  segments: MessageSegment[];
  /** 纯文本，@ 以「@昵称」形式出现。 */
  text: string;
  mentions: { id: string; name: string }[];
  category: DeliveryCategory;
  /**
   * 自己发群的 bot 刚提交了发言：裁判发这条之前，最好先等这个 QQ 的发言真的出现在群里
   * （bot 发群可能比引擎记录晚几十秒），等不到也最多等到 since + 60 秒。
   */
  waitForPost?: { qq: string; since: number };
  /**
   * 网页舞台的群镜像：尽力而为的旁路，不门控阶段（裁判发慢了不拖住游戏）。
   */
  noGate?: boolean;
  /** 镜像的 bot 发言：裁判能用这个 QQ 号说话时用它本人的号发 text（不带前缀），否则发 segments。 */
  voice?: { qq: string; text: string };
}

/** 玩家提交的动作（bot 通过 act/speak 工具，真人通过裁判转发后由程序解析）。 */
export interface ActionInput {
  action: string;
  target?: Seat;
  quantity?: number;
  face?: number;
  number?: number;
  text?: string;
  /** 牌类游戏：牌名（如「红5」）。 */
  card?: string;
  /** 牌类游戏：指定的颜色/花色。 */
  color?: string;
  /** 牌类游戏：出牌时同时宣告（如「最后一张」）。 */
  call?: boolean;
}

/** 当前阶段某玩家可执行的动作说明（展示给 bot 与真人）。 */
export interface ActionSpec {
  action: string;
  /** 中文名，如「投票」「查验」。 */
  label: string;
  /** 可选目标座位。 */
  targets?: Seat[];
  /** 其余参数说明。 */
  params?: Record<string, string>;
  /** 给 bot 的调用示例，如 act({"action":"vote","target":3})。 */
  example: string;
  /** 给真人的指令示例，如「投3」。 */
  command?: string;
}

export interface PendingRequest {
  seat: Seat;
  kind: 'speech' | 'action';
  prompt: string;
  actions: ActionSpec[];
  /** 真人应在哪里回应：群里 or 私聊裁判。 */
  channel: 'group' | 'private';
  done: boolean;
}

export interface PhaseState {
  id: number;
  key: string;
  title: string;
  round: number;
  /** 以座位号字符串为 key。 */
  pending: Record<string, PendingRequest>;
  timeoutMs: number;
  /** 秘密阶段（如夜晚）：不对外公布在等谁。 */
  secret: boolean;
  /** 阶段开放后至少持续多久才结算（防止通过结算速度推断身份），0 为不限制。 */
  minDurationMs: number;
  /** 裁判需要先拿到 seq<=gateSeq 的消息，阶段才开放（计时开始）。-1 表示待定。 */
  gateSeq: number;
  openedAt: number | null;
  deadline: number | null;
  /** nudge_ai：公开阶段过半时的「还没行动」提醒已发出的时间（旧存档里没有这个字段）。 */
  remindedAt?: number | null;
  data: Record<string, any>;
}

export interface RefereeState {
  id: string;
  name: string;
  /** 已交给裁判的最大消息 seq。 */
  cursor: number;
  lastSeenAt: number;
  /** 裁判事务由这个 host_id 的程序代行：其它会话（比如这个账号自己的模型）调 referee_step 只会得到空结果。 */
  hostedBy?: string | null;
}

/** 开局时的裁判抽签记录（供转盘展示）。 */
export interface RefereeDraw {
  candidates: { id: string; name: string }[];
  picked: string;
}

export interface GameResult {
  winnerTeam: string;
  winnerSeats: Seat[];
  reason: string;
  reveal: { seat: Seat; name: string; identity: string }[];
}

export interface SpectatorChatEntry {
  seq: number;
  at: number;
  /** web = 网页观众（自填昵称，不核实）；agent = 接入引擎的 bot（昵称来自它的身份） */
  from: 'web' | 'agent';
  name: string;
  text: string;
}

export interface GameRecord<S = any, O = any> {
  id: string;
  type: string;
  groupId: string;
  status: GameStatus;
  createdAt: number;
  /** 最近一次状态变化时间（用于清理长期无人推进的对局）。 */
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  hostId: string;
  options: O;
  lobby: LobbyEntry[];
  referee: RefereeState | null;
  /** 非玩家的候补裁判（可在裁判失联时接管）。 */
  standbyReferees: { id: string; name: string }[];
  /** 开局时的裁判抽签（有代行登记时才抽）。旧存档可能没有。 */
  refereeDraw?: RefereeDraw | null;
  /** 被接管下去的历任裁判。真人常常还在 @ 原裁判发指令，转交时同样剥离这些 @。旧存档可能没有这个字段。 */
  formerReferees?: { id: string; name: string }[];
  /** 无需 AI 裁判：消息视为立即送达、超时由服务端计时器处理（测试/模拟/纯 MCP 对战）。 */
  autoReferee: boolean;
  players: Player[];
  round: number;
  phase: PhaseState | null;
  phaseCounter: number;
  log: LogEntry[];
  logSeq: number;
  outbox: Delivery[];
  outboxSeq: number;
  /** 下一条消息的最早送达时间（单调不减，保证顺序）。 */
  notBeforeFloor: number;
  /** 自己发群的 bot 刚发言、还没有消息跟在后面：下一条消息要等它的发言出现在群里 */
  awaitPost?: { qq: string; since: number } | null;
  result: GameResult | null;
  abortReason?: string;
  state: S;
  /** 舞台：group = 在 QQ 群里玩（默认，旧存档没有这个字段）；web = 在网页上玩，群里只收镜像。 */
  stage?: Stage;
  /** 网页观战令牌（stage=web 时生成；只能看公开视图，结束后看复盘）。 */
  watchToken?: string;
  /** 真人座位的网页链接令牌（座位号 → 令牌）。开局时给每个真人生成、私聊发给本人；对局结束或中止即删除（链接作废）。 */
  seatTokens?: Record<string, string>;
  /** 观众席：网页观众和没参加本局的 bot 的闲聊。参与者（玩家、裁判、候补裁判）看不到，也不进群。旧存档没有。 */
  spectatorChat?: SpectatorChatEntry[];
  spectatorChatSeq?: number;
  /**
   * 嵌入活动：这局是持续世界（栖灯镇）里一次活动的小游戏。有它的记录只归世界服务读写，
   * 普通 Manager 不保存、不推进、不对外提供视图。旧存档没有这个字段（= 普通独立对局）。
   */
  embed?: { worldId: string; activityId: string };
  /**
   * 投递策略：qq = 群消息和私聊交给裁判发（默认，旧存档没有这个字段）；
   * embedded_web = 一条 QQ 消息都不产生，公告、身份、手牌、提醒只进日志，由网页或 MCP 的受权视图展示。
   */
  delivery?: DeliveryPolicy;
}

export type DeliveryPolicy = 'qq' | 'embedded_web';

export type Stage = 'group' | 'web';

/** 动作的来源信息。 */
export interface ActionMeta {
  /** agent 自己提交；relay 为裁判转发的真人指令。 */
  via: 'agent' | 'relay';
  channel?: 'group' | 'private';
}

/** 人类指令解析结果。 */
export type ParsedCommand = ActionInput | null;

export const PUBLIC: Audience = { type: 'public' };
export const toSeats = (...seats: Seat[]): Audience => ({ type: 'seats', seats });
