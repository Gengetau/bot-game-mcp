/**
 * 世界命令的失败码。客户端只对可安全重试的错误（recovering、rate_limited）用同一个请求号重试。
 *
 * 权限类的失败对外用一致的说法（not_available），不区分「不存在」和「无权访问」，免得被用来枚举私人对象。
 */
export type WorldErrorCode =
  | 'unauthenticated'
  | 'control_lost'
  | 'context_stale'
  | 'phase_stale'
  | 'precondition_failed'
  | 'request_conflict'
  | 'request_expired'
  | 'rate_limited'
  | 'resync_required'
  | 'recovering'
  | 'bad_request'
  | 'not_available';

export const HTTP_STATUS: Record<WorldErrorCode, number> = {
  unauthenticated: 401,
  control_lost: 409,
  context_stale: 409,
  phase_stale: 409,
  precondition_failed: 422,
  request_conflict: 409,
  request_expired: 410,
  rate_limited: 429,
  resync_required: 410,
  recovering: 503,
  bad_request: 400,
  not_available: 404,
};

export class WorldError extends Error {
  readonly code: WorldErrorCode;
  /** 机器可读的细分原因（如 not_same_place、insufficient_coins），前端据此给出可理解的说明 */
  readonly reason?: string;
  readonly data?: Record<string, unknown>;

  constructor(code: WorldErrorCode, message: string, reason?: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'WorldError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
    if (data !== undefined) this.data = data;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...(this.reason ? { reason: this.reason } : {}), ...(this.data ?? {}) };
  }
}

export const precondition = (message: string, reason?: string, data?: Record<string, unknown>) =>
  new WorldError('precondition_failed', message, reason, data);
export const badRequest = (message: string) => new WorldError('bad_request', message);
/** 「不存在」和「无权访问」统一成这一种说法 */
export const notAvailable = (message = '找不到这个对象，或者你现在不能访问它。') => new WorldError('not_available', message);
