/**
 * 栖灯镇的内容数据：地图、物品、商店、家具活动、个性与兴趣、愿望、公共事件、可嵌入的小游戏。
 *
 * 这里只声明「已经有程序处理器的动作和效果」，不执行任何脚本。新增一种效果要同时加处理器、权限检查和测试。
 * 每条定义都带 version：进行中的愿望保存创建时的定义副本，内容更新不会悄悄提高已有目标的要求。
 * 地图、人物和文案全部原创。
 */

export const CONTENT_VERSION = 1;

// ───────────────────────── 地图 ─────────────────────────

export type PlaceKind = 'public' | 'street';

export interface PlaceDef {
  id: string;
  name: string;
  kind: PlaceKind;
  /** 一句话用途 */
  blurb: string;
  /** 室内（下雨时更有吸引力） */
  indoor: boolean;
}

export const PLACES: readonly PlaceDef[] = [
  { id: 'plaza', name: '灯下广场', kind: 'public', blurb: '公告、集合、小集市，新居民从这里进镇。', indoor: false },
  { id: 'tea_house', name: '栖灯茶馆', kind: 'public', blurb: '坐下来喝杯茶，慢慢聊。', indoor: true },
  { id: 'bookshop', name: '檐下书屋', kind: 'public', blurb: '借书、读书、交换读后感。', indoor: true },
  { id: 'kitchen', name: '公共厨房', kind: 'public', blurb: '一起做饭，做好了分着吃。', indoor: true },
  { id: 'garden', name: '后巷花园', kind: 'public', blurb: '浇水、整理、照看大家的花。', indoor: false },
  { id: 'arcade', name: '游戏馆', kind: 'public', blurb: '凑一桌，按老规矩玩一局。', indoor: true },
  { id: 'street_east', name: '东灯巷', kind: 'street', blurb: '住宅街。各家门口有信箱和归还箱。', indoor: false },
  { id: 'street_west', name: '西灯巷', kind: 'street', blurb: '住宅街。各家门口有信箱和归还箱。', indoor: false },
];

/** 无向边。不设必须绕行的迷宫路线：广场是枢纽，任意两处最多两段路。 */
export const EDGES: readonly (readonly [string, string])[] = [
  ['plaza', 'tea_house'],
  ['plaza', 'bookshop'],
  ['plaza', 'kitchen'],
  ['plaza', 'garden'],
  ['plaza', 'arcade'],
  ['tea_house', 'bookshop'],
  ['kitchen', 'garden'],
  ['plaza', 'street_east'],
  ['plaza', 'street_west'],
  ['garden', 'street_east'],
  ['tea_house', 'street_west'],
];

export const STREETS = PLACES.filter((p) => p.kind === 'street').map((p) => p.id);
export const ENTRY_PLACE = 'plaza';

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
  { id: 'tea_counter', place: 'tea_house', name: '茶馆柜台', goods: [{ sku: 'tea_leaves', type: 'tea_leaves', price: 2, dailyStock: 30 }] },
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
    description: '在游戏馆或广场参加一局并打完，输赢都算。',
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
  { type: 'number_bomb', venues: ['arcade', 'plaza'], minPlayers: 2, maxPlayers: 8, options: { mode: 'single', turn_timeout_s: 45 } },
  { type: 'sealed_auction', venues: ['arcade'], minPlayers: 3, maxPlayers: 6, options: { rounds: 4, bid_timeout_s: 45 } },
  { type: 'liars_dice', venues: ['arcade', 'tea_house'], minPlayers: 2, maxPlayers: 6, options: { lives: 2, turn_timeout_s: 40 } },
];

export const embeddedGameDef = (type: string): EmbeddedGameDef | undefined => EMBEDDED_GAMES.find((g) => g.type === type);

// ───────────────────────── 地图计算 ─────────────────────────

/** 邻接表（只含公共地点和住宅街；住宅另算）。 */
export function neighbors(placeId: string): string[] {
  const out: string[] = [];
  for (const [a, b] of EDGES) {
    if (a === placeId) out.push(b);
    else if (b === placeId) out.push(a);
  }
  return out;
}

/** 两个公共节点之间的最短路径（含起点和终点）。不连通返回 null。 */
export function shortestPath(from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of neighbors(cur).sort()) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      if (n === to) {
        const path = [to];
        let p = to;
        while (prev.has(p)) {
          p = prev.get(p)!;
          path.unshift(p);
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}
