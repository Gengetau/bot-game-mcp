/**
 * 物品与效果映射表（规格 3.5.1，依赖点 D1）。
 *
 * 权威文本是仓库里的 docs/city/mappings.json（内核侧读同一份的副本）；引擎打包后读不到 docs/，
 * 所以这里放一份逐字相同的常量，test/city/mappings.test.ts 保证两边一致。改映射时两处一起改，并且 version 加一。
 */
export interface ItemMapping {
  /** 内核侧的资源种类 */
  kernel: { kind: string; item: string };
  /** 引擎侧的物品类型（catalog.ts 的 ITEM_TYPES） */
  engine_type: string;
  stack: boolean;
  edible: boolean;
  /**
   * 方向。不写：双向（出门能带、回家能带）。`home`：只用于回家——城里得到的这类物品回家时变成 `kernel`，
   * 出门时不按这一行换算（几种城里的物品可以对到同一种内核资源，反过来没法唯一确定）。
   */
  direction?: 'home';
}

export interface EffectMapping {
  engine_kind: 'ate' | 'drank' | 'walked';
  engine_type?: string;
  /** walked：累计步行满这么多分钟算一次 */
  min_minutes?: number;
  kernel_effect: string;
}

export interface Mappings {
  version: number;
  items: ItemMapping[];
  effects: EffectMapping[];
}

export const MAPPINGS: Mappings = {
  version: 4,
  items: [
    // 双向：内核词表里有同名或同义的资源
    { kernel: { kind: 'food', item: 'cookie' }, engine_type: 'cookie', stack: true, edible: true },
    { kernel: { kind: 'food', item: 'onigiri' }, engine_type: 'onigiri', stack: true, edible: true },
    { kernel: { kind: 'food', item: 'bottled_tea' }, engine_type: 'green_tea', stack: true, edible: true },
    // 只回家：城里的具体品种归到内核已有的大类
    { kernel: { kind: 'food', item: 'coffee' }, engine_type: 'coffee_beans', stack: true, edible: false, direction: 'home' },
    { kernel: { kind: 'food', item: 'bread' }, engine_type: 'melon_pan', stack: true, edible: true, direction: 'home' },
    { kernel: { kind: 'food', item: 'bread' }, engine_type: 'cream_bun', stack: true, edible: true, direction: 'home' },
    { kernel: { kind: 'food', item: 'dessert' }, engine_type: 'cheesecake', stack: true, edible: true, direction: 'home' },
    { kernel: { kind: 'wardrobe_asset', item: '*' }, engine_type: 'apparel_bundle', stack: false, edible: false, direction: 'home' },
    // v4：城里买的透明雨伞回家变成她自己的一件配饰（内核衣柜），下雨天出门就有伞可带
    { kernel: { kind: 'garment', item: 'umbrella' }, engine_type: 'umbrella', stack: false, edible: false, direction: 'home' },
  ],
  effects: [
    { engine_kind: 'ate', engine_type: 'cookie', kernel_effect: 'snack' },
    { engine_kind: 'ate', engine_type: 'onigiri', kernel_effect: 'snack' },
    { engine_kind: 'ate', engine_type: 'melon_pan', kernel_effect: 'snack' },
    { engine_kind: 'ate', engine_type: 'cream_bun', kernel_effect: 'snack' },
    { engine_kind: 'ate', engine_type: 'cheesecake', kernel_effect: 'snack' },
    { engine_kind: 'drank', engine_type: 'coffee', kernel_effect: 'drink_coffee' },
    { engine_kind: 'drank', engine_type: 'milk_tea', kernel_effect: 'drink_tea' },
    { engine_kind: 'drank', engine_type: 'green_tea', kernel_effect: 'drink_tea' },
    { engine_kind: 'walked', min_minutes: 15, kernel_effect: 'walk_15m' },
  ],
};

/** 内核资源种类 → 引擎物品类型；表里没有、或者只有「只回家」的行，返回 null（出门不能带）。 */
export function engineTypeOf(kernel: { kind?: unknown; item?: unknown }): string | null {
  const m = MAPPINGS.items.find((i) => i.direction !== 'home' && i.kernel.kind === kernel.kind && i.kernel.item === kernel.item);
  return m ? m.engine_type : null;
}

/** 引擎物品类型 → 内核资源种类；表里没有返回 null（回不了家，留在寄存包裹）。 */
export function kernelItemOf(engineType: string): { kind: string; item: string } | null {
  const m = MAPPINGS.items.find((i) => i.engine_type === engineType);
  return m ? { ...m.kernel } : null;
}

/** 一次进食 / 饮用对应的内核效果名；表里没有返回 null（照样写 body_effect，由内核决定忽略）。 */
export function kernelEffectOf(kind: 'ate' | 'drank', engineType: string): string | null {
  return MAPPINGS.effects.find((e) => e.engine_kind === kind && e.engine_type === engineType)?.kernel_effect ?? null;
}

export function walkEffect(): { minutes: number; kernel_effect: string } | null {
  const m = MAPPINGS.effects.find((e) => e.engine_kind === 'walked');
  return m ? { minutes: m.min_minutes ?? 15, kernel_effect: m.kernel_effect } : null;
}
