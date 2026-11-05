/**
 * 身份认证。
 *
 * - keys 模式：每个 agent 在配置里有自己的密钥，HTTP 请求带 `Authorization: Bearer <key>`，
 *   会话身份固定，不能冒充别人 —— 推荐生产使用。
 * - open 模式：agent 调用 login(qq_id, nickname) 认领身份；首次认领会返回 secret，
 *   之后在别的会话里重新登录同一 QQ 号必须带上它（防止冒充偷看身份）。
 * 管理员密钥可以中止任何对局，还可以在运行时用 issue_key 给新的 bot 发放密钥（存在 issuedKeysFile 里，重启后仍有效）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

/** 运行时发放的一把密钥 */
export interface IssuedKey {
  id: string;
  name: string;
  key: string;
  /** 申请人（一般是 bot 主人的 QQ 号，或 bot 自己） */
  owner?: string;
  issuedBy: string;
  issuedAt: number;
}

const ID_RE = /^[\w.:-]{1,32}$/u;
export const newKey = () => `bgk_${randomBytes(24).toString('base64url')}`;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class Authenticator {
  /** 运行时发放的密钥（配置文件里的 agents 之外） */
  private readonly issued: IssuedKey[] = [];
  private readonly issuedFile: string | null;

  constructor(
    readonly auth: ResolvedAuth,
    private readonly manager: GameManager,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.issuedFile = auth.issuedKeysFile ? resolve(auth.issuedKeysFile) : null;
    if (this.issuedFile && existsSync(this.issuedFile)) this.loadIssued();
  }

  get mode(): 'keys' | 'open' {
    return this.auth.mode;
  }

  /** 发放功能是否开启（配置里 issuedKeysFile 为 null 则关闭） */
  get canIssue(): boolean {
    return this.auth.issuedKeysFile !== null;
  }

  private loadIssued(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.issuedFile!, 'utf8'));
    } catch (e) {
      this.log(`[auth] 读取已发放密钥失败（${this.issuedFile}）：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const list = Array.isArray((raw as any)?.keys) ? ((raw as any).keys as unknown[]) : [];
    const taken = new Set([...this.auth.agents.map((a) => a.key), ...this.auth.adminKeys]);
    const ids = new Set(this.auth.agents.map((a) => a.id));
    for (const k of list) {
      const e = k as Partial<IssuedKey>;
      if (typeof e?.id !== 'string' || typeof e.name !== 'string' || typeof e.key !== 'string' || e.key.length < 8) continue;
      if (taken.has(e.key) || ids.has(e.id)) {
        this.log(`[auth] 已发放的密钥与配置文件冲突，忽略：QQ ${e.id}`);
        continue;
      }
      taken.add(e.key);
      ids.add(e.id);
      this.issued.push({
        id: e.id,
        name: e.name,
        key: e.key,
        ...(typeof e.owner === 'string' ? { owner: e.owner } : {}),
        issuedBy: typeof e.issuedBy === 'string' ? e.issuedBy : '?',
        issuedAt: typeof e.issuedAt === 'number' ? e.issuedAt : 0,
      });
    }
    if (this.issued.length) this.log(`[auth] 已载入 ${this.issued.length} 把运行时发放的密钥`);
  }

  private saveIssued(): void {
    if (!this.issuedFile) return;
    mkdirSync(dirname(this.issuedFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.issuedFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, keys: this.issued }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.issuedFile);
  }

  /** 从密钥解析身份：undefined 表示没带密钥；null 表示密钥无效。 */
  identityFromKey(key: string | undefined | null): Identity | null | undefined {
    if (!key) return undefined;
    for (const a of this.auth.agents) {
      if (safeEqual(a.key, key)) return { id: a.id, name: a.name, ...(a.admin ? { admin: true } : {}), ...(a.keyIssuer ? { keyIssuer: true } : {}) };
    }
    for (const a of this.issued) {
      if (safeEqual(a.key, key)) return { id: a.id, name: a.name };
    }
    for (const [i, k] of this.auth.adminKeys.entries()) {
      if (safeEqual(k, key)) return { id: `admin${i + 1}`, name: `管理员${i + 1}`, admin: true };
    }
    return null;
  }

  /** 已登记了密钥的 QQ 号（配置 + 运行时发放） */
  hasKeyFor(id: string): boolean {
    return this.auth.agents.some((a) => a.id === id) || this.issued.some((a) => a.id === id);
  }

  private requireAdmin(actor: Identity): void {
    if (!actor.admin && !actor.keyIssuer) throw new GameError('FORBIDDEN', '只有管理员或负责发密钥的账号能管理其他 bot 的密钥。');
    if (!this.canIssue) throw new GameError('FORBIDDEN', '服务器关闭了运行时发放密钥（issuedKeysFile 为 null）。', '请管理员直接改配置文件里的 auth.agents。');
  }

  /**
   * 发放（或重新发放）一把密钥。同一 QQ 号再次申请会作废旧密钥；
   * 带 owner 时，只有同一个 owner（或 force）才能重新申请别人申请过的 QQ 号。
   */
  issueKey(actor: Identity, input: { id: string; name: string; owner?: string; force?: boolean }): { entry: Omit<IssuedKey, 'key'>; key: string; rotated: boolean } {
    this.requireAdmin(actor);
    const id = String(input.id ?? '').trim();
    const name = sanitizeName(String(input.name ?? ''));
    const owner = input.owner === undefined ? undefined : String(input.owner).trim();
    if (!ID_RE.test(id)) throw new GameError('BAD_REQUEST', 'qq_id 只能包含字母数字（一般就是 QQ 号）。');
    if (!name) throw new GameError('BAD_REQUEST', '需要 name（bot 的群昵称）。');
    if (owner !== undefined && !ID_RE.test(owner)) throw new GameError('BAD_REQUEST', 'owner 只能包含字母数字。');
    if (this.auth.agents.some((a) => a.id === id)) {
      throw new GameError('FORBIDDEN', `QQ ${id} 的密钥写在服务器配置文件里，不能在运行时重新发放。`);
    }
    const idx = this.issued.findIndex((a) => a.id === id);
    const old = idx >= 0 ? this.issued[idx]! : null;
    if (input.force && !actor.admin) throw new GameError('FORBIDDEN', '只有管理员能用 force 强制重新发放。');
    if (old && old.owner && owner !== undefined && old.owner !== owner && !input.force) {
      throw new GameError('FORBIDDEN', `QQ ${id} 的密钥是 ${old.owner} 申请的，只有申请人能重新申请。`, '管理员可以用 force 覆盖。');
    }
    const entry: IssuedKey = {
      id,
      name,
      key: newKey(),
      ...(owner !== undefined ? { owner } : old?.owner ? { owner: old.owner } : {}),
      issuedBy: actor.id,
      issuedAt: this.manager.now(),
    };
    if (old) this.issued[idx] = entry;
    else this.issued.push(entry);
    this.saveIssued();
    this.manager.claims.delete(id);
    this.log(`[auth] ${actor.name}(${actor.id}) ${old ? '重新' : ''}发放密钥给 ${name}(${id})${entry.owner ? `，申请人 ${entry.owner}` : ''}`);
    const { key, ...rest } = entry;
    return { entry: rest, key, rotated: Boolean(old) };
  }

  /** 作废一把运行时发放的密钥。返回 false 表示没有这把密钥。 */
  revokeKey(actor: Identity, id: string): boolean {
    this.requireAdmin(actor);
    const idx = this.issued.findIndex((a) => a.id === String(id ?? '').trim());
    if (idx < 0) {
      if (this.auth.agents.some((a) => a.id === String(id ?? '').trim())) {
        throw new GameError('FORBIDDEN', `QQ ${id} 的密钥写在服务器配置文件里，只能改配置文件删除。`);
      }
      return false;
    }
    const [gone] = this.issued.splice(idx, 1);
    this.saveIssued();
    this.log(`[auth] ${actor.name}(${actor.id}) 作废了 ${gone!.name}(${gone!.id}) 的密钥`);
    return true;
  }

  /** 运行时发放的密钥列表（不含密钥本身） */
  listIssued(actor: Identity): Omit<IssuedKey, 'key'>[] {
    this.requireAdmin(actor);
    return this.issued.map(({ key: _key, ...rest }) => rest);
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
    if (this.hasKeyFor(id)) {
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
