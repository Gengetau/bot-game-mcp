import type { AssetStore } from '../core/assets.js';
import { GameRegistry } from '../core/registry.js';
import { createJubenshaDefinition, emptyLibrary, type ScriptLibrary } from './jubensha/index.js';
import { liarsDiceDefinition } from './liars-dice/index.js';
import { numberBombDefinition } from './number-bomb/index.js';
import { sealedAuctionDefinition } from './sealed-auction/index.js';
import { undercoverDefinition } from './undercover/index.js';
import { werewolfDefinition } from './werewolf/index.js';

export interface RegistryOptions {
  /** 剧本杀的剧本库（私有数据包）；不给则剧本杀没有可用剧本 */
  scripts?: ScriptLibrary;
  /** 图片素材库（剧本杀线索图） */
  assets?: AssetStore;
  /** 剧本杀开房没写 script、剧本库又不止一个剧本时用的剧本 id（管理页设置） */
  defaultScript?: () => string | undefined;
}

/** 创建包含全部内置游戏的注册表。 */
export function createRegistry(opts: RegistryOptions = {}): GameRegistry {
  return new GameRegistry()
    .register(werewolfDefinition)
    .register(undercoverDefinition)
    .register(liarsDiceDefinition)
    .register(numberBombDefinition)
    .register(sealedAuctionDefinition)
    .register(createJubenshaDefinition(opts.scripts ?? emptyLibrary, opts.assets, opts.defaultScript));
}
