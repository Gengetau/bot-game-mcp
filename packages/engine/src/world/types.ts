/** 世界模块共用的数据类型。 */

export interface NeedsState {
  /** 精力：只按活动事件消耗和恢复 */
  energy: number;
  /** 社交满足、兴趣满足：按有效在场时间惰性下降 */
  social: number;
  interest: number;
  /** 上次结算时的累计有效在场毫秒数（基线） */
  asOfPresentMs: number;
}

/** residents.state_json：只放有明确上限的角色状态。历史、聊天、信件都不在这里。 */
export interface ResidentState {
  bio: string;
  traits: string[];
  interests: string[];
  needs: NeedsState;
  settings: {
    /** 是否向别人展示情绪 */
    showMood: boolean;
    /** 是否允许别人当面询问爱好 */
    allowAskHobby: boolean;
    /** 真人自己设的情绪展示（null = 用程序建议的） */
    moodOverride: string | null;
    /** 静音全镇公屏：不再因为公屏消息被唤醒，AI 视图里也不带公屏摘要（旧数据没有这个字段，当作 false） */
    muteTownChat?: boolean;
  };
}

/** 导航的目标（给本人和运行器看的说明；路径另算）。 */
export interface NavTarget {
  kind: 'place' | 'home' | 'object' | 'resident' | 'point';
  /** 地点编号、物件编号、居民编号；地图点没有 */
  id?: string;
  name: string;
}

/** 走完当前这一段之后要做的事：穿过进出口，或者在新场景里接着走。 */
export type NavStep = { op: 'exit' } | { op: 'enter'; home: string } | { op: 'walk'; to: string | { x: number; z: number } };

/**
 * 一段进行中的导航（world_actors.nav_json）。位置不存每帧坐标：points + speed + startedAt 就是全部，
 * 任何时刻的位置用 positionAt 现算，并且截断在 leaseUntil。
 */
export interface NavState {
  navigationId: string;
  revision: number;
  points: { x: number; z: number }[];
  speed: number;
  startedAt: number;
  /** 导航控制租约截止：过了这一刻不再前进 */
  leaseUntil: number;
  /** 最近一次耐久确认「这一刻人还在走」（续租、本人提交了别的动作）。重启后停在这一刻的位置 */
  checkpointAt: number;
  /** 沿路还没结算的区域变化 */
  crossings: { at: number; zone: string }[];
  target: NavTarget;
  /** 出发时所在的区域标签 */
  fromSpace: string;
  after: NavStep[];
}

/** world_actors 的一行：一个有位置的角色（居民，以后还有 NPC）。 */
export interface ActorRow {
  actor_id: string;
  world_id: string;
  kind: 'resident' | 'npc';
  resident_id: string | null;
  scene_id: string;
  instance_id: string;
  /** 锚点：站着的时候就是当前位置；走着的时候是这一段的起点 */
  x: number;
  z: number;
  heading: number;
  anchor_at: number;
  pos_version: number;
  nav_revision: number;
  nav_json: string | null;
  map_version: string;
  // 解析后的字段
  nav: NavState | null;
}

export interface ResidentRow {
  resident_id: string;
  world_id: string;
  principal_id: string;
  name: string;
  kind: 'human' | 'agent';
  street_id: string;
  house_no: number;
  /**
   * 所在的区域标签：公共地点编号、'road'（路上）、'residential'（住宅接入点）或 home:<房主>。
   * 只由空间模块（space.ts）在跨区域时改写；精确位置在 world_actors 里。
   */
  location_id: string;
  activity_id: string | null;
  context_version: number;
  control_epoch: number;
  controller_client: string | null;
  controller_until: number;
  presence_epoch: number;
  present_since: number | null;
  present_ms: number;
  revision: number;
  state_json: string;
  created_at: number;
  last_seen_at: number;
  // 解析后的字段
  state: ResidentState;
}

export interface Principal {
  principal_id: string;
  provider: string;
  subject: string;
  kind: 'human' | 'agent';
  display_name: string;
}
