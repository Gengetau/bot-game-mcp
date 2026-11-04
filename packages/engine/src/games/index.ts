import { GameRegistry } from '../core/registry.js';
import { liarsDiceDefinition } from './liars-dice/index.js';
import { numberBombDefinition } from './number-bomb/index.js';
import { undercoverDefinition } from './undercover/index.js';
import { werewolfDefinition } from './werewolf/index.js';

/** 创建包含全部内置游戏的注册表。 */
export function createRegistry(): GameRegistry {
  return new GameRegistry()
    .register(werewolfDefinition)
    .register(undercoverDefinition)
    .register(liarsDiceDefinition)
    .register(numberBombDefinition);
}
