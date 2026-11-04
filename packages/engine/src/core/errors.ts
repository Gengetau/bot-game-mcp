/**
 * 面向调用者（LLM / 裁判）的业务错误。message 用中文，尽量附带「下一步怎么做」。
 */
export type GameErrorCode =
  | 'NOT_LOGGED_IN'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INVALID_STATE'
  | 'NOT_YOUR_TURN'
  | 'INVALID_ACTION'
  | 'CONFLICT';

export class GameError extends Error {
  readonly code: GameErrorCode;
  readonly hint?: string;

  constructor(code: GameErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.hint = hint;
  }
}

export const badRequest = (msg: string, hint?: string) => new GameError('BAD_REQUEST', msg, hint);
export const invalidAction = (msg: string, hint?: string) => new GameError('INVALID_ACTION', msg, hint);
export const invalidState = (msg: string, hint?: string) => new GameError('INVALID_STATE', msg, hint);
export const forbidden = (msg: string, hint?: string) => new GameError('FORBIDDEN', msg, hint);
export const notFound = (msg: string, hint?: string) => new GameError('NOT_FOUND', msg, hint);
