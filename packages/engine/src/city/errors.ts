/**
 * 东京城市世界的失败码。
 *
 * 桥接协议（docs/city/bridge-v1.schema.json）里出现的码都在这里；对外一律大写。
 * 调用方只对 RECOVERING 和 RATE_LIMITED 用同一个请求号重试；CONFLICT、STALE_DOMAIN_EPOCH 之类重试也没用。
 * 「不存在」和「无权访问」统一成 NOT_FOUND：不公开的节点（小屋门口）不能被拿来枚举。
 */
export type CityErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'RECOVERING'
  | 'REQUEST_EXPIRED'
  | 'ENTRY_VIA_HOME_ONLY'
  | 'STALE_DOMAIN_EPOCH'
  | 'VISIT_NOT_ACTIVE'
  | 'VERSION_MISMATCH'
  | 'CONTROL_LOST'
  | 'INTERNAL';

export const CITY_HTTP_STATUS: Record<CityErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 422,
  RATE_LIMITED: 429,
  RECOVERING: 503,
  REQUEST_EXPIRED: 410,
  ENTRY_VIA_HOME_ONLY: 403,
  STALE_DOMAIN_EPOCH: 409,
  VISIT_NOT_ACTIVE: 409,
  VERSION_MISMATCH: 422,
  CONTROL_LOST: 409,
  INTERNAL: 500,
};

export class CityError extends Error {
  readonly code: CityErrorCode;
  /** 机器可读的细分原因（insufficient_funds、place_closed……） */
  readonly reason?: string;
  readonly data?: Record<string, unknown>;

  constructor(code: CityErrorCode, message: string, reason?: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'CityError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
    if (data !== undefined) this.data = data;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...(this.reason ? { reason: this.reason } : {}), ...(this.data ?? {}) };
  }
}

export const cityBadRequest = (message: string, reason?: string, data?: Record<string, unknown>) => new CityError('BAD_REQUEST', message, reason, data);
export const cityPrecondition = (message: string, reason?: string, data?: Record<string, unknown>) => new CityError('PRECONDITION_FAILED', message, reason, data);
export const cityNotFound = (message = '找不到这个对象，或者你现在不能访问它。') => new CityError('NOT_FOUND', message);
export const cityConflict = (message: string, reason?: string, data?: Record<string, unknown>) => new CityError('CONFLICT', message, reason, data);
export const cityControlLost = (epoch: number) =>
  new CityError('CONTROL_LOST', '这位居民当前由另一个客户端控制，如需接管请先调用 claim_control。', 'control_lost', {
    control: { epoch, mine: false },
  });
