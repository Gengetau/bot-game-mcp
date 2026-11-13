/**
 * 栖灯镇的内容数据：地图、物品、商店、家具活动、个性与兴趣、愿望、公共事件、可嵌入的小游戏。
 *
 * 这里只声明「已经有程序处理器的动作和效果」，不执行任何脚本。新增一种效果要同时加处理器、权限检查和测试。
 * 每条定义都带 version：进行中的愿望保存创建时的定义副本，内容更新不会悄悄提高已有目标的要求。
 * 地图、人物和文案全部原创。
 */

export const CONTENT_VERSION = 1;

// ───────────────────────── 地图 ─────────────────────────

export type PlaceKind = 'public' | 'residential';

export interface PlaceDef {
  id: string;
  name: string;
  kind: PlaceKind;
  /** 一句话用途 */
  blurb: string;
  /** 室内（下雨时更有吸引力） */
  indoor: boolean;
  /** 只是路过的地方：不算目的地，没有店和物件（路上） */
  through?: boolean;
}

/**
 * 地点 = 地图上有名字的区域（区域编号和地图数据 spatial/town-map.ts 里的 zone 一致）。
 * 位置本身是连续的坐标；这里的编号只是「这一片叫什么」，也是 navigate 的目的地别名。
 */
export const PLACES: readonly PlaceDef[] = [
  { id: 'plaza', name: '灯下广场', kind: 'public', blurb: '公告、集合、小集市，新居民从这里进镇。', indoor: false },
  { id: 'tea_house', name: '栖灯茶馆', kind: 'public', blurb: '坐下来喝杯茶，慢慢聊。', indoor: true },
  { id: 'bookshop', name: '檐下书屋', kind: 'public', blurb: '借书、读书、交换读后感。', indoor: true },
  { id: 'kitchen', name: '公共厨房', kind: 'public', blurb: '一起做饭，做好了分着吃。', indoor: true },
  { id: 'garden', name: '后巷花园', kind: 'public', blurb: '浇水、整理、照看大家的花。', indoor: false },
  { id: 'arcade', name: '游戏馆', kind: 'public', blurb: '凑一桌，按老规矩玩一局。', indoor: true },
  { id: 'road', name: '灯笼路', kind: 'public', blurb: '连着各处的路。走在路上也能和身边的人说话。', indoor: false, through: true },
  { id: 'residential', name: '灯巷会馆', kind: 'residential', blurb: '住宅接入点。信箱和归还箱在这里，回家、做客都从会馆门口进。', indoor: false },
];

/** 可以当目的地的地点（不含「路上」）。 */
export const DESTINATIONS: readonly PlaceDef[] = PLACES.filter((p) => !p.through);

/** 门牌上的巷名。两条巷子不再是能走到的地点：各家都从会馆门口进，巷名只用来写地址。 */
export const LANES: readonly { id: string; name: string }[] = [
  { id: 'street_east', name: '东灯巷' },
  { id: 'street_west', name: '西灯巷' },
];
export const STREETS = LANES.map((l) => l.id);
export const laneName = (id: string): string => LANES.find((l) => l.id === id)?.name ?? id;

export const ENTRY_PLACE = 'plaza';
export const ROAD_PLACE = 'road';
export const RESIDENTIAL_PLACE = 'residential';

export const placeDef = (id: string): PlaceDef | undefined => PLACES.find((p) => p.id === id);
export const isHome = (spaceId: string): boolean => spaceId.startsWith('home:');
export const homeId = (residentId: string): string => `home:${residentId}`;
export const homeOwner = (spaceId: string): string => spaceId.slice('home:'.length);

// ───────────────────────── 物品 ─────────────────────────

export type ItemCategory = 'consumable' | 'usable' | 'decor' | 'furniture';

export interface ItemDef {
  type: string;
  version: number;
  name: string;
  category: ItemCategory;
  /** 来源说明（展示用；真正的来源是商店、制作产出和新居民物资） */
  source: string;
  /** 用途说明 */
  use: string;
  tradable: boolean;
  lendable: boolean;
  /** 同类合并成一行数量；false = 每件有自己的编号（书、家具） */
  stackable: boolean;
  /** 自己用掉一件的效果（消耗品） */
  consume?: { energy?: number };
  /** 家具类：摆进自己家后成为哪种可互动物件 */
  places?: string;
}

export const ITEMS: readonly ItemDef[] = [
  { type: 'tea_leaves', version: 1, name: '茶叶', category: 'consumable', source: '茶馆柜台、新居民物资', use: '在茶桌泡一壶茶，和人一起喝。', tradable: true, lendable: false, stackable: true },
  { type: 'vegetables', version: 1, name: '蔬菜', category: 'consumable', source: '公共厨房的菜篮、新居民物资', use: '做汤的食材。', tradable: true, lendable: false, stackable: true },
  { type: 'seeds', version: 1, name: '花种', category: 'consumable', source: '花园小棚、新居民物资', use: '在花箱里种下、照料。', tradable: true, lendable: false, stackable: true },
  { type: 'soup', version: 1, name: '热汤', category: 'consumable', source: '在灶台做汤', use: '喝掉恢复一些精力，也可以分给别人。', tradable: true, lendable: false, stackable: true, consume: { energy: 15 } },
  { type: 'cookie', version: 1, name: '小饼干', category: 'consumable', source: '广场小摊', use: '吃掉恢复一点精力，适合当小礼物。', tradable: true, lendable: false, stackable: true, consume: { energy: 8 } },
  { type: 'book', version: 1, name: '书', category: 'usable', source: '书屋柜台、新居民物资；镇上的藏书可以借', use: '在书架边读；可以借给别人。', tradable: true, lendable: true, stackable: false },
  { type: 'flower', version: 1, name: '鲜花', category: 'decor', source: '照料花箱的收获', use: '摆在家里，或者送人。', tradable: true, lendable: false, stackable: true },
  { type: 'lantern', version: 1, name: '小灯笼', category: 'decor', source: '广场小摊', use: '挂在家里。', tradable: true, lendable: false, stackable: true },
  { type: 'paper_lamp', version: 1, name: '集市纸灯', category: 'decor', source: '只在「灯下集市」期间的广场小摊', use: '挂在家里，集市的纪念。', tradable: true, lendable: false, stackable: true },
  { type: 'planter_box', version: 1, name: '花箱', category: 'furniture', source: '花园小棚', use: '摆进自己家，之后可以在家照料植物。', tradable: false, lendable: false, stackable: false, places: 'planter' },
  { type: 'stove_kit', version: 1, name: '小灶台', category: 'furniture', source: '公共厨房', use: '摆进自己家，之后可以在家做汤。', tradable: false, lendable: false, stackable: false, places: 'stove' },
];

export const itemDef = (type: string): ItemDef | undefined => ITEMS.find((i) => i.type === type);

export interface BookDef {
  id: string;
  title: string;
  /** 这本书偏向的兴趣（除了「书籍」本身） */
  tag: string;
}

/** 原创书目。 */
export const BOOKS: readonly BookDef[] = [
  { id: 'rain_lane', title: '《雨巷里的灯》', tag: 'letters' },
  { id: 'bread_stars', title: '《面包与星图》', tag: 'cooking' },
  { id: 'gardener_notes', title: '《园丁手记》', tag: 'plants' },
  { id: 'polite_dice', title: '《骰子的礼貌》', tag: 'games' },
  { id: 'slow_fire', title: '《慢火》', tag: 'tea' },
  { id: 'twelve_letters', title: '《给远方的十二封信》', tag: 'letters' },
];

export const bookDef = (id: string): BookDef | undefined => BOOKS.find((b) => b.id === id);

/** 新居民物资（只发一次，由数据库唯一约束保证）。书另外随机发一本。 */
export const STARTER_KIT: readonly { type: string; qty: number }[] = [
  { type: 'tea_leaves', qty: 2 },
  { type: 'vegetables', qty: 2 },
  { type: 'seeds', qty: 2 },
];

// ───────────────────────── 商店 ─────────────────────────

export interface ShopGood {
  /** 商品编号：普通物品就是 type；书是 book:<bookId> */
  sku: string;
  type: string;
  bookId?: string;
  price: number;
  /** 每个世界日补到多少件 */
  dailyStock: number;
  /** 只在这种公共事件进行期间出售 */
  onlyDuringEvent?: string;
}

export interface ShopDef {
  id: string;
  place: string;
  name: string;
  goods: ShopGood[];
  /** 照看这家店的 NPC 编号：有掌柜的店，买东西要走到掌柜身边（够得着掌柜），不再只看人在不在这片区域 */
  keeper?: string;
}

export const SHOPS: readonly ShopDef[] = [
  {
    id: 'stall',
    place: 'plaza',
    name: '广场小摊',
    goods: [
      { sku: 'cookie', type: 'cookie', price: 3, dailyStock: 20 },
      { sku: 'lantern', type: 'lantern', price: 5, dailyStock: 6 },
      { sku: 'paper_lamp', type: 'paper_lamp', price: 3, dailyStock: 10, onlyDuringEvent: 'lantern_market' },
    ],
  },
  { id: 'tea_counter', place: 'tea_house', name: '茶馆柜台', keeper: 'npc:teahouse_keeper', goods: [{ sku: 'tea_leaves', type: 'tea_leaves', price: 2, dailyStock: 30 }] },
  {
    id: 'book_counter',
    place: 'bookshop',
    name: '书屋柜台',
    goods: BOOKS.map((b) => ({ sku: `book:${b.id}`, type: 'book', bookId: b.id, price: 6, dailyStock: 1 })),
  },
  {
    id: 'pantry',
    place: 'kitchen',
    name: '厨房菜篮',
    goods: [
      { sku: 'vegetables', type: 'vegetables', price: 2, dailyStock: 30 },
      { sku: 'stove_kit', type: 'stove_kit', price: 10, dailyStock: 3 },
    ],
  },
  {
    id: 'shed',
    place: 'garden',
    name: '花园小棚',
    goods: [
      { sku: 'seeds', type: 'seeds', price: 1, dailyStock: 30 },
      { sku: 'planter_box', type: 'planter_box', price: 8, dailyStock: 3 },
    ],
  },
];

// ───────────────────────── 家具与共同活动 ─────────────────────────

export interface ObjectTypeDef {
  type: string;
  name: string;
}

export const OBJECT_TYPES: readonly ObjectTypeDef[] = [
  { type: 'tea_table', name: '茶桌' },
  { type: 'bookshelf', name: '书架' },
  { type: 'planter', name: '花箱' },
  { type: 'stove', name: '灶台' },
  { type: 'rest_nook', name: '小憩角' },
];

export const objectTypeName = (type: string): string => OBJECT_TYPES.find((o) => o.type === type)?.name ?? type;

/** 公共场所里固定的可互动物件。 */
export const PUBLIC_OBJECTS: readonly { id: string; place: string; type: string; label: string }[] = [
  { id: 'tea_house:table1', place: 'tea_house', type: 'tea_table', label: '靠窗的茶桌' },
  { id: 'tea_house:table2', place: 'tea_house', type: 'tea_table', label: '里间的茶桌' },
  { id: 'bookshop:shelf', place: 'bookshop', type: 'bookshelf', label: '镇上的藏书架' },
  { id: 'kitchen:stove1', place: 'kitchen', type: 'stove', label: '左边的灶台' },
  { id: 'kitchen:stove2', place: 'kitchen', type: 'stove', label: '右边的灶台' },
  { id: 'garden:planter1', place: 'garden', type: 'planter', label: '门边的花箱' },
  { id: 'garden:planter2', place: 'garden', type: 'planter', label: '墙角的花箱' },
  { id: 'garden:planter3', place: 'garden', type: 'planter', label: '向阳的花箱' },
];

/**
 * 公共场所里的游戏桌（小游戏按桌入局）。id 与地图（spatial/town-map.ts，kind = game_table）里的可交互物件一一对应，
 * 有测试核对。propose_game / join_game 的 objectId 只认这张白名单。
 */
export const GAME_TABLES: readonly { id: string; place: string; label: string }[] = [
  { id: 'arcade:table1', place: 'arcade', label: '靠门的游戏桌' },
  { id: 'arcade:table2', place: 'arcade', label: '里侧的游戏桌' },
];
export const gameTable = (id: string): { id: string; place: string; label: string } | undefined => GAME_TABLES.find((t) => t.id === id);

/** 新住宅自带的物件。花箱和灶台要另外买来摆。 */
export const HOME_STARTER_OBJECTS: readonly string[] = ['tea_table', 'bookshelf', 'rest_nook'];

export interface InteractionDef {
  id: string;
  version: number;
  name: string;
  objectType: string;
  participants: { min: number; max: number };
  durationSeconds: number;
  /** same_space_and_valid_access：同一空间且有权在场；own_home：只能在自己家 */
  permission: 'same_space_and_valid_access' | 'own_home';
  /** 发起人投入的物品（开始前预留，正式开始时消耗；开始前取消全数退回，开始后取消不退） */
  inputs: { type: string; qty: number }[];
  /** 完成时每位参与者得到的物品 */
  outputsEach: { type: string; qty: number; dailyCap?: number }[];
  /** 完成时发起人额外得到的物品 */
  outputsInitiator: { type: string; qty: number }[];
  /** 需要变化。social 只在实际参与者不少于两人时生效；interest 按 tag 与本人兴趣匹配给全额，不匹配给 interestOffTag */
  effects: { energy?: number; social?: number; interest?: number; interestOffTag?: number };
  /** 兴趣标签 */
  tag: string;
  /** 完成后形成的事实类型 */
  eventType: string;
  /** 完成后的短期情绪 */
  mood?: string;
  /** 下雨时室内进行的额外效果 */
  rainBonus?: { social?: number; interest?: number };
  /** 给人看的投入与产出说明 */
  costText: string;
}

export const INTERACTIONS: readonly InteractionDef[] = [
  {
    id: 'share_tea',
    version: 1,
    name: '一起喝茶',
    objectType: 'tea_table',
    participants: { min: 2, max: 4 },
    durationSeconds: 600,
    permission: 'same_space_and_valid_access',
    inputs: [{ type: 'tea_leaves', qty: 1 }],
    outputsEach: [],
    outputsInitiator: [],
    effects: { energy: -5, social: 10 },
    tag: 'tea',
    eventType: 'shared_tea_completed',
    mood: 'relaxed',
    rainBonus: { social: 2 },
    costText: '发起人出 1 份茶叶；至少两人，十分钟。',
  },
  {
    id: 'read',
    version: 1,
    name: '读书',
    objectType: 'bookshelf',
    participants: { min: 1, max: 4 },
    durationSeconds: 600,
    permission: 'same_space_and_valid_access',
    inputs: [],
    outputsEach: [],
    outputsInitiator: [],
    effects: { energy: -5, interest: 10, interestOffTag: 4, social: 4 },
    tag: 'books',
    eventType: 'reading_completed',
    mood: 'relaxed',
    rainBonus: { interest: 2 },
    costText: '不需要投入；可以一个人读，也可以几个人一起，十分钟。',
  },
  {
    id: 'cook_soup',
    version: 1,
    name: '做汤',
    objectType: 'stove',
    participants: { min: 1, max: 3 },
    durationSeconds: 300,
    permission: 'same_space_and_valid_access',
    inputs: [{ type: 'vegetables', qty: 2 }],
    outputsEach: [{ type: 'soup', qty: 1 }],
    outputsInitiator: [{ type: 'soup', qty: 1 }],
    effects: { energy: -5, interest: 10, interestOffTag: 4, social: 6 },
    tag: 'cooking',
    eventType: 'soup_cooked',
    mood: 'content',
    costText: '发起人出 2 份蔬菜；每位参与者得 1 碗汤，发起人多 1 碗，五分钟。',
  },
  {
    id: 'tend_plants',
    version: 1,
    name: '照料花箱',
    objectType: 'planter',
    participants: { min: 1, max: 4 },
    durationSeconds: 300,
    permission: 'same_space_and_valid_access',
    inputs: [{ type: 'seeds', qty: 1 }],
    outputsEach: [{ type: 'flower', qty: 1, dailyCap: 2 }],
    outputsInitiator: [],
    effects: { energy: -5, interest: 10, interestOffTag: 4, social: 5 },
    tag: 'plants',
    eventType: 'plants_tended',
    mood: 'content',
    costText: '发起人出 1 份花种；每位参与者收获 1 朵鲜花（每天最多 2 朵），五分钟。',
  },
  {
    id: 'rest',
    version: 1,
    name: '在家休息',
    objectType: 'rest_nook',
    participants: { min: 1, max: 1 },
    durationSeconds: 600,
    permission: 'own_home',
    inputs: [],
    outputsEach: [],
    outputsInitiator: [],
    effects: { energy: 20 },
    tag: 'rest',
    eventType: 'rested',
    mood: 'relaxed',
    costText: '只能在自己家；十分钟恢复 20 点精力。',
  },
];

export const interactionDef = (id: string): InteractionDef | undefined => INTERACTIONS.find((i) => i.id === id);

// ───────────────────────── 个性、兴趣、情绪 ─────────────────────────

export const TRAITS: readonly { id: string; name: string; hint: string }[] = [
  { id: 'quiet', name: '喜静', hint: '人少的地方更自在' },
  { id: 'outgoing', name: '外向', hint: '喜欢热闹，爱主动搭话' },
  { id: 'meticulous', name: '细致', hint: '做事有条理，记得小约定' },
  { id: 'curious', name: '好奇', hint: '什么都想试一试' },
  { id: 'gentle', name: '温和', hint: '说话不急，照顾别人的感受' },
  { id: 'playful', name: '爱玩', hint: '见到游戏就手痒' },
];

export const INTERESTS: readonly { id: string; name: string; place: string }[] = [
  { id: 'books', name: '书籍', place: 'bookshop' },
  { id: 'cooking', name: '烹饪', place: 'kitchen' },
  { id: 'plants', name: '植物', place: 'garden' },
  { id: 'games', name: '桌游', place: 'arcade' },
  { id: 'tea', name: '茶', place: 'tea_house' },
  { id: 'letters', name: '写信', place: 'plaza' },
];

export const MOODS: Readonly<Record<string, { name: string; tone: string }>> = {
  relaxed: { name: '放松', tone: '语气可以慢一点、松一点' },
  happy: { name: '开心', tone: '语气可以明快一些' },
  expectant: { name: '期待', tone: '可以提到在盼着的事' },
  down: { name: '失落', tone: '可以安静一点，不必强颜欢笑' },
  content: { name: '满足', tone: '可以带一点做成了事的踏实' },
};

// ───────────────────────── 愿望 ─────────────────────────

/** 程序记录的结构化事实类型。愿望、关系、回顾都读它，聊天文字不算数。 */
export type FactType =
  | 'arrived'
  | 'interaction_completed'
  | 'item_acquired'
  | 'gift_accepted'
  | 'trade_completed'
  | 'loan_started'
  | 'loan_returned'
  | 'letter_sent'
  | 'home_visit'
  | 'asked_hobby'
  | 'game_completed'
  | 'public_event_contribution'
  | 'conversation';

export interface GoalPath {
  fact: FactType;
  where?: {
    /** interaction_completed：哪种活动 */
    interaction?: string;
    /** 实际参与人数下限 */
    minParticipants?: number;
    /** arrived：哪个地点（'$place' 表示创建愿望时选定的地点） */
    place?: string;
    /** 本人在这件事里的角色 */
    role?: 'initiator' | 'borrower' | 'host' | 'guest' | 'asker' | 'sender';
    /** item_acquired：哪种物品 */
    itemType?: string;
  };
}

export interface GoalDef {
  id: string;
  version: number;
  kind: 'long' | 'short';
  title: string;
  description: string;
  /** 需要累计几次（或几位不同的人） */
  count: number;
  /** partner：按不同的对方计数；owned：按当前拥有的件数计（不是累计获得次数） */
  measure: 'times' | 'partner' | 'owned';
  /** 任意一条路径上的事实都算数。依赖别人配合的愿望要有多条路径 */
  paths: GoalPath[];
  /** 生成前要检查的前提：没有来源就不生成 */
  requires?: { shopSku?: string; embeddedGames?: boolean; interaction?: string };
  /** 完成后得到的称号（只陈述事实，不点名别人） */
  title_award?: string;
}

export const GOALS: readonly GoalDef[] = [
  {
    id: 'own_bookshelf',
    version: 1,
    kind: 'long',
    title: '建立自己的小书架',
    description: '拥有三本属于自己的书。书屋柜台每天会上架，新居民物资里也有一本。',
    count: 3,
    measure: 'owned',
    paths: [{ fact: 'item_acquired', where: { itemType: 'book' } }],
    requires: { shopSku: 'book:rain_lane' },
    title_award: '小书架的主人',
  },
  {
    id: 'meet_neighbors',
    version: 1,
    kind: 'long',
    title: '认识不同的居民',
    description: '和三位不同的居民有过真实的往来：一起完成一件事、玩过一局，或者问过对方的爱好。',
    count: 3,
    measure: 'partner',
    paths: [
      { fact: 'interaction_completed', where: { minParticipants: 2 } },
      { fact: 'game_completed' },
      { fact: 'asked_hobby', where: { role: 'asker' } },
      { fact: 'home_visit' },
    ],
    title_award: '镇上的熟面孔',
  },
  {
    id: 'garden_friend',
    version: 1,
    kind: 'long',
    title: '让花箱常开',
    description: '累计照料六次花箱，公共花园或自己家的都算。',
    count: 6,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { interaction: 'tend_plants' } }],
    requires: { interaction: 'tend_plants' },
    title_award: '花园的朋友',
  },
  {
    id: 'good_soup',
    version: 1,
    kind: 'long',
    title: '练出一手好汤',
    description: '累计做五锅汤。',
    count: 5,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { interaction: 'cook_soup' } }],
    requires: { interaction: 'cook_soup' },
    title_award: '会做汤的人',
  },
  {
    id: 'tea_regular',
    version: 1,
    kind: 'long',
    title: '常坐茶桌边',
    description: '和别人一起喝五次茶，在茶馆或谁家都算。',
    count: 5,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { interaction: 'share_tea' } }],
    requires: { interaction: 'share_tea' },
    title_award: '茶桌的常客',
  },
  {
    id: 'join_shared',
    version: 1,
    kind: 'short',
    title: '和人一起做件事',
    description: '参与一次至少两人的共同活动：喝茶、做汤、照料花箱或一起读书。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { minParticipants: 2 } }],
  },
  {
    id: 'return_borrowed',
    version: 1,
    kind: 'short',
    title: '借一本书，再还回去',
    description: '归还一件借来的东西。书屋的藏书谁都能借，还回书屋就算。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'loan_returned', where: { role: 'borrower' } }],
  },
  {
    id: 'visit_place',
    version: 1,
    kind: 'short',
    title: '去$placeName走走',
    description: '走到$placeName看看现在有什么。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'arrived', where: { place: '$place' } }],
  },
  {
    id: 'read_once',
    version: 1,
    kind: 'short',
    title: '读一会儿书',
    description: '在书架边读完一次书。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { interaction: 'read' } }],
    requires: { interaction: 'read' },
  },
  {
    id: 'cook_once',
    version: 1,
    kind: 'short',
    title: '做一锅汤',
    description: '在灶台做完一锅汤，自己喝或者分给别人。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { interaction: 'cook_soup' } }],
    requires: { interaction: 'cook_soup' },
  },
  {
    id: 'tend_once',
    version: 1,
    kind: 'short',
    title: '照料一次花箱',
    description: '带上花种，去花园或自己家的花箱照料一次。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'interaction_completed', where: { interaction: 'tend_plants' } }],
    requires: { interaction: 'tend_plants' },
  },
  {
    id: 'write_letter',
    version: 1,
    kind: 'short',
    title: '写一封信',
    description: '给一位居民寄一封信。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'letter_sent', where: { role: 'sender' } }],
  },
  {
    id: 'play_game',
    version: 1,
    kind: 'short',
    title: '玩一局小游戏',
    description: '在游戏馆的桌边参加一局并打完，输赢都算。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'game_completed' }],
    requires: { embeddedGames: true },
  },
  {
    id: 'ask_hobby',
    version: 1,
    kind: 'short',
    title: '了解一位居民的爱好',
    description: '当面问一问身边的居民喜欢什么。',
    count: 1,
    measure: 'times',
    paths: [{ fact: 'asked_hobby', where: { role: 'asker' } }, { fact: 'interaction_completed', where: { minParticipants: 2 } }],
  },
];

export const goalDef = (id: string): GoalDef | undefined => GOALS.find((g) => g.id === id);

// ───────────────────────── 公共事件与天气 ─────────────────────────

export interface PublicEventDef {
  id: string;
  version: number;
  title: string;
  place: string;
  /** 世界时区的开始时刻 */
  startHour: number;
  startMinute: number;
  durationMinutes: number;
  /** 0 = 周日 … 6 = 周六；不写 = 每天 */
  weekdays?: number[];
  /** 处理器：garden_care = 期间在花园照料花箱计入共同进度；market = 小摊出售限定商品；tea_party = 茶馆喝茶不用自带茶叶 */
  kind: 'garden_care' | 'market' | 'tea_party';
  /** garden_care：共同目标需要多少次贡献 */
  target?: number;
  openText: string;
  doneText?: string;
  quietText: string;
}

export const PUBLIC_EVENTS: readonly PublicEventDef[] = [
  {
    id: 'garden_care',
    version: 1,
    title: '花园整理',
    place: 'garden',
    startHour: 12,
    startMinute: 30,
    durationMinutes: 30,
    kind: 'garden_care',
    target: 4,
    openText: '后巷花园开始午间整理：这半小时里照料花箱会计入大家的共同进度，先后来都算。',
    doneText: '花园整理完成，花箱今天开得格外好。',
    quietText: '午间的花园整理安静地过去了。',
  },
  {
    id: 'lantern_market',
    version: 1,
    title: '灯下集市',
    place: 'plaza',
    startHour: 20,
    startMinute: 0,
    durationMinutes: 30,
    weekdays: [1, 2, 3, 4, 5],
    kind: 'market',
    openText: '灯下集市开摊了：广场小摊这半小时有集市纸灯。',
    quietText: '今晚的灯下集市收摊了。',
  },
  {
    id: 'tea_party',
    version: 1,
    title: '周末茶会',
    place: 'tea_house',
    startHour: 20,
    startMinute: 0,
    durationMinutes: 30,
    weekdays: [0, 6],
    kind: 'tea_party',
    openText: '栖灯茶馆的周末茶会开始了：这半小时在茶馆喝茶由茶馆出茶叶。',
    quietText: '周末茶会散场了。',
  },
];

export const publicEventDef = (id: string): PublicEventDef | undefined => PUBLIC_EVENTS.find((e) => e.id === id);

export const WEATHERS: readonly { id: string; name: string; weight: number }[] = [
  { id: 'clear', name: '晴', weight: 4 },
  { id: 'cloudy', name: '多云', weight: 3 },
  { id: 'breeze', name: '微风', weight: 2 },
  { id: 'rain', name: '小雨', weight: 3 },
];
/** 一种天气持续多久（现实时间） */
export const WEATHER_SLOT_MS = 6 * 3600_000;

// ───────────────────────── 可嵌入的小游戏 ─────────────────────────

export interface EmbeddedGameDef {
  type: string;
  /** 能在哪些公共场所发起 */
  venues: string[];
  /** 人数范围（不超出游戏自己的规则范围） */
  minPlayers: number;
  maxPlayers: number;
  /** 世界给定的选项：只在游戏原有选项范围内取值，不改规则、不为缩短一局改胜负 */
  options: Record<string, unknown>;
}

/** 已通过接入检查并接入的游戏。计划接入但还没核查的不写在这里（见 docs/TOWN.md）。 */
export const EMBEDDED_GAMES: readonly EmbeddedGameDef[] = [
  { type: 'number_bomb', venues: ['arcade'], minPlayers: 2, maxPlayers: 8, options: { mode: 'single', turn_timeout_s: 45 } },
  { type: 'sealed_auction', venues: ['arcade'], minPlayers: 3, maxPlayers: 6, options: { rounds: 4, bid_timeout_s: 45 } },
  { type: 'liars_dice', venues: ['arcade'], minPlayers: 2, maxPlayers: 6, options: { lives: 2, turn_timeout_s: 40 } },
];

export const embeddedGameDef = (type: string): EmbeddedGameDef | undefined => EMBEDDED_GAMES.find((g) => g.type === type);

// ───────────────────────── NPC ─────────────────────────

export type NpcRole = 'service' | 'ambient';
/** 姿态：站着、坐着、站着看书。走路时是 stand（走没走由快照里的 nav 表示）。 */
export type NpcPose = 'stand' | 'sit' | 'read';

/** 日程里的一站：到了某个地图锚点，摆什么姿态。 */
export interface NpcStop {
  anchor: string;
  pose: NpcPose;
}

/**
 * 程序驱动的 NPC：不用模型、不占在场名额、不被唤醒、不发事件。
 * 编号稳定（npc:<名字>），同时就是 world_actors 的 actor_id。
 * schedule 为 null 的 NPC 全天站在岗位上；有 schedule 的在这些站点之间走动、停留（停留时长和下一站由 w.rng 选，范围在参数里）。
 * 以后要加更多 NPC、按钟点分段的安排，在这里加定义，不改引擎代码。
 */
export interface NpcDef {
  id: string;
  name: string;
  role: NpcRole;
  /** 岗位（也是地图换版本后挪回的位置）：地图锚点编号 */
  post: NpcStop;
  schedule: { stops: NpcStop[] } | null;
  /** 可以问它的话题；第一个是默认话题（未知话题按它回答） */
  topics: NpcTopic[];
  /** 它照看的店（SHOPS 的编号）。有店的 NPC 回答里带出柜台的货品 */
  shop?: string;
}

export interface NpcTopic {
  id: string;
  label: string;
}

export const NPCS: readonly NpcDef[] = [
  { id: 'npc:teahouse_keeper', name: '茶馆掌柜', role: 'service', post: { anchor: 'tea_house.counter.staff', pose: 'stand' },
    schedule: null,
    shop: 'tea_counter',
    topics: [
      { id: 'hello', label: '打个招呼' },
      { id: 'tea', label: '怎么喝茶' },
      { id: 'town', label: '镇上的事' },
    ],
  },
  {
    id: 'npc:plaza_stroller',
    name: '广场闲逛者',
    role: 'ambient',
    post: { anchor: 'plaza.bench1.sit', pose: 'sit' },
    schedule: {
      stops: [
        { anchor: 'plaza.bench1.sit', pose: 'sit' },
        { anchor: 'plaza.bench2.sit', pose: 'sit' },
        { anchor: 'bookshop.shelf.stand', pose: 'read' },
      ],
    },
    topics: [
      { id: 'hello', label: '打个招呼' },
      { id: 'bench', label: '广场的长椅' },
      { id: 'books', label: '书' },
    ],
  },
];

export const npcDef = (id: string): NpcDef | undefined => NPCS.find((n) => n.id === id);

// ───────────────────────── NPC 的台词 ─────────────────────────

/**
 * NPC 的固定台词模板。键是 `<NPC 编号>/<话题>`（带情境的话题再加 `.<情境>`）；每个键有几句变体，由可复现的随机选。
 * 模板里唯一允许的「动态」部分是占位符：{name} 提问人的名字（注册时已清洗，拼之前再清洗一次）、{period} 时段、
 * {place} 区域名、{price} {stock} 柜台的价格和今天的存量、{places} 公共地点名、{events} 今天开着的公开活动的名字。
 * 除此之外不引用任何玩家文字，也不引用聊天、信件、背包、关系、愿望。
 */
export const NPC_LINES: Readonly<Record<string, readonly string[]>> = {
  'npc:teahouse_keeper/hello': [
    '{name}，来啦。茶叶{price}枚一份，今天还剩{stock}份，要的话直接说。',
    '欢迎来栖灯茶馆，{name}。茶叶{price}枚一份，今天还有{stock}份。',
    '{name}，随便坐。要茶叶的话，{price}枚一份，今天还剩{stock}份。',
  ],
  'npc:teahouse_keeper/hello.empty': [
    '{name}，来啦。茶叶今天卖完了，明天再来吧，一份{price}枚。',
    '欢迎来栖灯茶馆，{name}。今天的茶叶已经卖完，明天会补上。',
  ],
  'npc:teahouse_keeper/tea': [
    '想喝茶先备好茶叶，再找个人作伴：两个人一起走到茶桌旁，就能开一壶。',
    '茶叶柜台这儿有卖，一份{price}枚。拿着茶叶，约一位同伴走到茶桌边，两个人才泡得成。',
    '一起喝茶要有茶叶、要有两个人，还要走到茶桌旁边。一个人是开不了一壶的。',
  ],
  'npc:teahouse_keeper/town.event': [
    '镇上的公共地点有：{places}。今天开着的活动有：{events}。',
    '想四处走走的话：{places}，都可以去。眼下开着的活动有：{events}。',
  ],
  'npc:teahouse_keeper/town.none': [
    '镇上的公共地点有：{places}。眼下没有开着的活动。',
    '想四处走走的话：{places}，都可以去。眼下没有开着的活动。',
  ],
  'npc:teahouse_keeper/sold': [
    '{name}，茶叶给你包好了，慢用。',
    '收好，{name}。茶叶两清，欢迎再来。',
    '好嘞，{name}，茶叶在这儿，路上慢些。',
  ],
  'npc:plaza_stroller/hello.sit': [
    '{name}，这会儿是{period}，我坐在{place}的长椅上歇脚。',
    '{name}，来坐坐？{period}的{place}最适合发呆了。',
  ],
  'npc:plaza_stroller/hello.read': [
    '嘘，{name}……我在{place}翻书呢。这会儿是{period}，正适合看一会儿。',
    '{name}，我在{place}的书架旁看书，{period}的光线刚好。',
  ],
  'npc:plaza_stroller/hello.walk': [
    '{name}，我正在{place}一带慢慢走，这会儿是{period}，不赶时间。',
    '{name}，边走边聊吧，{period}的镇子走起来很舒服。',
  ],
  'npc:plaza_stroller/hello.stand': [
    '{name}，我在{place}站一会儿，{period}的镇子挺安静的。',
    '{name}，在{place}站着看看风景，这会儿是{period}。',
  ],
  'npc:plaza_stroller/bench': [
    '广场上有两张长椅，累了就坐下，路过的人都能搭上两句。',
    '长椅是镇上最好的位置，能看到整个广场的人来人往。',
  ],
  'npc:plaza_stroller/books': [
    '檐下书屋的书可以借也可以买，借了记得按时还。',
    '我常去书屋的书架旁站着看书，一站就是半天。',
  ],
};

/** 时段（按世界时区的钟点）。 */
export function dayPeriod(hour: number): string {
  if (hour < 5) return '夜里';
  if (hour < 11) return '早上';
  if (hour < 13) return '中午';
  if (hour < 18) return '下午';
  if (hour < 21) return '傍晚';
  return '夜里';
}

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACEHOLDER_PATTERNS: Record<string, string> = {
  name: '[\\s\\S]{1,64}',
  period: '(?:早上|中午|下午|傍晚|夜里)',
  place: `(?:${[...PLACES.map((p) => p.name), '这一带'].map(reEscape).join('|')})`,
  price: '\\d{1,4}',
  stock: '\\d{1,4}',
  places: '[^。]{1,100}',
  events: '[^。]{1,100}',
};

/** 把模板里的占位符换成值（缺的值保持原样，测试和不变量会发现）。 */
export function renderNpcLine(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** 一条模板对应的完整匹配正则：占位符只能出现在占位符的位置，其余字一字不差。 */
export function npcLinePattern(template: string): RegExp {
  let out = '';
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    out += reEscape(template.slice(last, m.index)) + (PLACEHOLDER_PATTERNS[m[1]!] ?? '(?!)');
    last = m.index! + m[0].length;
  }
  out += reEscape(template.slice(last));
  return new RegExp(`^${out}$`, 'u');
}

/** 这句话是不是这名 NPC 的某条模板渲染出来的（不变量和测试用，不依赖实现怎么选模板）。 */
export function npcLineMatches(npcId: string, text: string): boolean {
  for (const [key, lines] of Object.entries(NPC_LINES)) {
    if (!key.startsWith(`${npcId}/`)) continue;
    if (lines.some((t) => npcLinePattern(t).test(text))) return true;
  }
  return false;
}
