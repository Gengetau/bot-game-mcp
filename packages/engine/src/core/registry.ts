import type { z } from 'zod';
import type { BaseGame, GameEnv } from './game.js';
import type { GameRecord } from './types.js';

/**
 * 游戏类型定义。每个游戏模块导出一个 GameDefinition 并在 src/games/index.ts 注册。
 */
export interface GameDefinition<O = any> {
  /** 机器名，如 werewolf */
  type: string;
  /** 中文名，如 狼人杀 */
  name: string;
  /** 用于识别的别名（含中文），如 ['狼人杀','狼人'] */
  aliases: string[];
  /** 对局 ID 前缀，如 WW */
  idPrefix: string;
  minPlayers: number;
  maxPlayers: number;
  /** 一句话简介 */
  summary: string;
  /** 完整规则（Markdown） */
  rules: string;
  /** 给 bot 玩家的策略提示（Markdown，可选） */
  playerTips?: string;
  /** 选项 schema（zod object，所有字段都应有默认值） */
  optionsSchema: z.ZodType<O>;
  /** 选项说明：字段名 → 中文说明 */
  optionsHelp: Record<string, string>;
  /** 开局前根据人数与选项（以及报名的玩家，不含裁判）做额外校验，返回错误信息或 null */
  /** 开局时必须上场、不能被抽去当裁判的报名者（QQ 号或昵称），例如剧本杀指定的 DM。lobby 为当前报名名单。 */
  mustPlay?(options: O, lobby: readonly { id: string; name: string }[]): string[];
  checkStart?(playerCount: number, options: O, entries?: { id: string; name: string; kind: 'agent' | 'human' }[]): string | null;
  create(rec: GameRecord<any, O>, env: GameEnv): BaseGame<any, O>;
}

export class GameRegistry {
  private readonly defs = new Map<string, GameDefinition>();

  register(def: GameDefinition): this {
    if (this.defs.has(def.type)) throw new Error(`duplicate game type ${def.type}`);
    this.defs.set(def.type, def);
    return this;
  }

  get(type: string): GameDefinition | undefined {
    return this.defs.get(type);
  }

  /** 支持机器名、中文名与别名。 */
  resolve(nameOrAlias: string): GameDefinition | undefined {
    const key = nameOrAlias.trim().toLowerCase();
    for (const def of this.defs.values()) {
      if (def.type === key || def.name === nameOrAlias.trim() || def.aliases.some((a) => a.toLowerCase() === key)) return def;
    }
    return undefined;
  }

  list(): GameDefinition[] {
    return [...this.defs.values()];
  }
}
