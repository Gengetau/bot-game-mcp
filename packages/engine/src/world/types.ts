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
  };
}

export interface MoveState {
  from: string;
  to: string;
  /** 经过的节点（含起点和终点） */
  path: string[];
  startedAt: number;
  arriveAt: number;
}

export interface ResidentRow {
  resident_id: string;
  world_id: string;
  principal_id: string;
  name: string;
  kind: 'human' | 'agent';
  street_id: string;
  house_no: number;
  /** 最后一个合法位置。在途时仍是出发地，到达后才改 */
  location_id: string;
  move_json: string | null;
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
  move: MoveState | null;
}

export interface Principal {
  principal_id: string;
  provider: string;
  subject: string;
  kind: 'human' | 'agent';
  display_name: string;
}
