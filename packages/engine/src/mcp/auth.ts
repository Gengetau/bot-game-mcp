/**
 * 身份认证。
 *
 * - keys 模式：每个 agent 在配置里有自己的密钥，HTTP 请求带 `Authorization: Bearer <key>`，
 *   会话身份固定，不能冒充别人 —— 推荐生产使用。
 * - open 模式：agent 调用 login(qq_id, nickname) 认领身份；首次认领会返回 secret，
 *   之后在别的会话里重新登录同一 QQ 号必须带上它（防止冒充偷看身份）。
 * 管理员密钥可以中止任何对局。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ResolvedAuth } from '../config.js';
import { GameError } from '../core/errors.js';
import type { GameManager } from '../core/manager.js';
import { sanitizeName } from '../core/text.js';
import type { Identity } from '../core/types.js';

export interface SessionContext {
  identity: Identity | null;
  /** 身份来自密钥/环境变量，不能通过 login 更改 */
  fixed: boolean;
  transport: 'stdio' | 'http' | 'sse' | 'memory';
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class Authenticator {
  constructor(
    readonly auth: ResolvedAuth,
    private readonly manager: GameManager,
  ) {}

  get mode(): 'keys' | 'open' {
    return this.auth.mode;
  }

  /** 从密钥解析身份：undefined 表示没带密钥；null 表示密钥无效。 */
  identityFromKey(key: string | undefined | null): Identity | null | undefined {
    if (!key) return undefined;
    for (const a of this.auth.agents) {
      if (safeEqual(a.key, key)) return { id: a.id, name: a.name, ...(a.admin ? { admin: true } : {}) };
    }
    for (const [i, k] of this.auth.adminKeys.entries()) {
      if (safeEqual(k, key)) return { id: `admin${i + 1}`, name: `管理员${i + 1}`, admin: true };
    }
    return null;
  }

  /** open 模式登录 / 认领。返回新生成的 secret（仅首次认领时）。 */
  login(ctx: SessionContext, input: { id: string; name: string; secret?: string }): { identity: Identity; secret?: string } {
    if (ctx.fixed && ctx.identity) {
      if (ctx.identity.id === input.id.trim()) return { identity: ctx.identity };
      throw new GameError('FORBIDDEN', `本会话已通过密钥绑定为 ${ctx.identity.name}(${ctx.identity.id})，不能切换身份。`);
    }
    if (this.auth.mode === 'keys') {
      throw new GameError('FORBIDDEN', '服务器处于 keys 认证模式：请在 MCP 客户端配置里添加 Authorization: Bearer <你的密钥> 请求头。');
    }
    const id = String(input.id ?? '').trim();
    const name = sanitizeName(String(input.name ?? ''));
    if (!/^[\w.:-]{1,32}$/u.test(id)) throw new GameError('BAD_REQUEST', 'qq_id 只能包含字母数字（一般就是 QQ 号）。');
    if (!name) throw new GameError('BAD_REQUEST', '需要 nickname（群昵称）。');
    if (this.auth.agents.some((a) => a.id === id)) {
      throw new GameError('FORBIDDEN', `QQ ${id} 已在服务器配置中绑定了密钥，请使用密钥连接。`);
    }
    if (this.manager.isActiveHuman(id)) {
      throw new GameError(
        'FORBIDDEN',
        `QQ ${id} 正作为真人玩家参加对局，不能以 AI 身份登录。`,
        '真人玩家不需要登录：直接在群里发言，或私聊裁判 bot。',
      );
    }
    const claim = this.manager.claims.get(id);
    let secret: string | undefined;
    if (claim) {
      if (!input.secret || !safeEqual(claim.secretHash, sha256(input.secret))) {
        throw new GameError(
          'FORBIDDEN',
          `QQ ${id} 已被认领。若这是你，请带上首次登录时返回的 secret 重新登录。`,
          '如果遗失了 secret，请服务器管理员重启服务或清理存档中的 claims。',
        );
      }
      claim.name = name;
    } else {
      secret = randomBytes(12).toString('base64url');
      this.manager.claims.set(id, { id, name, secretHash: sha256(secret), claimedAt: this.manager.now() });
    }
    ctx.identity = { id, name };
    this.manager.touch();
    return { identity: ctx.identity, ...(secret ? { secret } : {}) };
  }

  require(ctx: SessionContext): Identity {
    if (!ctx.identity) {
      throw new GameError(
        'NOT_LOGGED_IN',
        '尚未登录。',
        this.auth.mode === 'open'
          ? '请先调用 login(qq_id=你的QQ号, nickname=你的群昵称)。'
          : '请在 MCP 客户端配置 Authorization: Bearer <密钥> 请求头。',
      );
    }
    return ctx.identity;
  }
}

/** 从 HTTP 请求头 / 查询参数里取密钥。 */
export function extractKey(headers: Record<string, string | string[] | undefined>, query?: Record<string, unknown>): string | undefined {
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const auth = h('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1]!.trim();
  }
  const x = h('x-api-key') ?? h('x-botgame-key');
  if (x) return x.trim();
  const q = query?.key;
  if (typeof q === 'string' && q) return q;
  return undefined;
}
