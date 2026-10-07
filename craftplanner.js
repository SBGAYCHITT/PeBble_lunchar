'use strict';
/**
 * craftplanner.js — 离线合成规划器
 *
 * 定位：不进游戏也能算合成。输入目标物品，展开完整合成树，算出到底要挖多少、砍多少、
 * 熔多少 —— 并且**多个目标一起算**，共享的中间产物只算一次。
 *
 * 四件事：
 *   1. `plan()`   目标 → 合成树 + 基础材料清单 + 分步合成步骤（含库存抵扣与共享中间产物）；
 *   2. `order()`  基础材料 → 按「来源」分组的采集顺序（挖矿/伐木/农牧/熔炼）；
 *   3. `gaps()`   需求 vs 库存 → 缺口（"我手上还差多少"）；
 *   4. `importRecipes()` 追加/覆盖配方，供扩展包或新版本使用。
 *
 * 设计约束：
 *   - **纯计算，不读盘、不联网**。配方表内置于此文件。
 *   - 全部导出都是纯函数，单测直接喂对象。
 *   - 配方表是**人工精选的核心集**，不是 Minecraft 的全量配方。覆盖常见建筑/工具/红石/食物路径；
 *     缺失的走 `unresolved` 明确报出来（而不是悄悄算错），需要全量可以 `importRecipes()` 灌入。
 *
 * ⚠️ 坑：**库存抵扣与共享中间产物必须在同一遍里算**。
 *   如果按"每个目标各算一棵树再相加"，共享的木板/木棍会被重复计算（3 个目标要 3 份木棍），
 *   数字偏大且误导。这里用「全局需求表 + 不动点迭代」：先把所有目标的需求汇总，
 *   再让每个可合成物品按**总需求**决定合成次数，增量只补差额。
 *
 * ⚠️ 标签材料（`#planks` 这类）必须**解析一次就固定**（`tagChoice` 记忆化），
 *   否则迭代过程中会在"用橡木木板"和"用云杉木板"之间反复横跳，需求表永远不收敛。
 */

const worlddb = require('./worlddb');

/* ================= 中文名 ================= */

/** 复用 worlddb 的 71 条，再补足配方表里出现的其余物品 */
const ITEM_ZH = Object.assign({}, worlddb.ITEM_ZH, {
  oak_log: '橡木原木', spruce_log: '云杉原木', birch_log: '白桦原木', jungle_log: '丛林原木',
  acacia_log: '金合欢原木', dark_oak_log: '深色橡木原木', mangrove_log: '红树原木',
  cherry_log: '樱花原木', pale_oak_log: '苍白橡木原木', crimson_stem: '绯红菌柄', warped_stem: '诡异菌柄',
  oak_planks: '橡木木板', spruce_planks: '云杉木板', birch_planks: '白桦木板', jungle_planks: '丛林木板',
  acacia_planks: '金合欢木板', dark_oak_planks: '深色橡木木板', mangrove_planks: '红树木板',
  cherry_planks: '樱花木板', pale_oak_planks: '苍白橡木木板', crimson_planks: '绯红木板', warped_planks: '诡异木板',
  stick: '木棍', crafting_table: '工作台', chest: '箱子', furnace: '熔炉', torch: '火把',
  ladder: '梯子', cobblestone: '圆石', stone: '石头', stone_bricks: '石砖', sand: '沙子',
  gravel: '砂砾', dirt: '泥土', glass: '玻璃', glass_pane: '玻璃板', sandstone: '砂岩',
  brick: '砖块', clay_ball: '黏土球', brick_block: '红砖块', netherrack: '下界岩',
  obsidian: '黑曜石', crying_obsidian: '哭泣的黑曜石', quartz: '下界石英', amethyst_shard: '紫水晶碎片',
  raw_iron: '粗铁', raw_gold: '粗金', raw_copper: '粗铜', iron_nugget: '铁粒', gold_nugget: '金粒',
  coal: '煤炭', charcoal: '木炭', redstone: '红石粉', lapis_lazuli: '青金石', emerald: '绿宝石',
  copper_ingot: '铜锭', netherite_scrap: '下界合金碎片',
  wheat: '小麦', bread: '面包', cookie: '曲奇', cake: '蛋糕', sugar: '糖', egg: '鸡蛋',
  milk_bucket: '奶桶', cocoa_beans: '可可豆', sugar_cane: '甘蔗', bamboo: '竹子',
  apple: '苹果', golden_apple: '金苹果', pumpkin: '南瓜', pumpkin_pie: '南瓜派',
  brown_mushroom: '棕色蘑菇', red_mushroom: '红色蘑菇', bowl: '碗', mushroom_stew: '蘑菇煲',
  carrot: '胡萝卜', potato: '马铃薯', beetroot: '甜菜根', melon_slice: '西瓜片', honeycomb: '蜜脾',
  leather: '皮革', string: '线', feather: '羽毛', flint: '打火石', bone: '骨头', bone_meal: '骨粉',
  gunpowder: '火药', slime_ball: '黏液球', slime_block: '黏液块', blaze_rod: '烈焰棒',
  blaze_powder: '烈焰粉', magma_cream: '岩浆膏', ender_pearl: '末影珍珠', eye_of_ender: '末影之眼',
  shulker_shell: '潜影壳', nautilus_shell: '鹦鹉螺壳', heart_of_the_sea: '海洋之心',
  prismarine_shard: '海晶碎片', prismarine_crystals: '海晶砂粒', glowstone_dust: '荧石粉',
  paper: '纸', book: '书', bookshelf: '书架', item_frame: '物品展示框', painting: '画',
  armor_stand: '盔甲架', flower_pot: '花盆', chain: '锁链', iron_bars: '铁栏杆', bucket: '桶',
  shears: '剪刀', flint_and_steel: '打火石与铁锭', compass: '指南针', clock: '时钟',
  spyglass: '望远镜', fishing_rod: '钓鱼竿', lead: '拴绳', saddle: '鞍', name_tag: '命名牌',
  arrow: '箭', bow: '弓', crossbow: '弩', shield: '盾牌', spectral_arrow: '光灵箭',
  firework_rocket: '烟花火箭', tnt: 'TNT', minecart: '矿车', rail: '铁轨', powered_rail: '充能铁轨',
  detector_rail: '探测铁轨', activator_rail: '激活铁轨', hopper: '漏斗', dropper: '投掷器',
  dispenser: '发射器', piston: '活塞', sticky_piston: '黏性活塞', observer: '侦测器',
  redstone_torch: '红石火把', repeater: '红石中继器', comparator: '红石比较器', lever: '拉杆',
  note_block: '音符盒', jukebox: '唱片机', target: '标靶', daylight_detector: '阳光探测器',
  lightning_rod: '避雷针', tripwire_hook: '绊线钩', stone_pressure_plate: '石质压力板',
  stone_button: '石质按钮', wooden_pressure_plate: '木质压力板',
  enchanting_table: '附魔台', anvil: '铁砧', cauldron: '炼药锅', brewing_stand: '酿造台',
  beacon: '信标', conduit: '潮涌核心', respawn_anchor: '重生锚', ender_chest: '末影箱',
  shulker_box: '潜影盒', blast_furnace: '高炉', smoker: '烟熏炉', stonecutter: '切石机',
  smithing_table: '锻造台', grindstone: '砂轮', loom: '织布机', cartography_table: '制图台',
  fletching_table: '制箭台', composter: '堆肥桶', barrel: '木桶', bed: '床', carpet: '地毯',
  banner: '旗帜', lantern: '灯笼', soul_lantern: '灵魂灯笼', soul_torch: '灵魂火把',
  campfire: '营火', soul_campfire: '灵魂营火', sea_lantern: '海晶灯', jack_o_lantern: '南瓜灯',
  item_obsidian: '黑曜石', nether_star: '下界之星', scrap: '碎片',
  iron_block: '铁块', gold_block: '金块', diamond_block: '钻石块', coal_block: '煤炭块',
  redstone_block: '红石块', lapis_block: '青金石块', emerald_block: '绿宝石块',
  copper_block: '铜块', netherite_block: '下界合金块'
});

/**
 * 取物品中文名（未知则把下划线换成空格）。
 * @param {string} id
 * @returns {string}
 */
function itemZh(id) {
  if (!id) return '';
  const s = String(id).replace(/^minecraft:/, '');
  return ITEM_ZH[s] || s.replace(/_/g, ' ');
}

/* ================= 物品标签 ================= */

/** 标签 → 候选物品（对应 Minecraft 的物品标签，去掉了 minecraft: 前缀） */
const TAGS = {
  logs: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem'],
  planks: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks',
    'crimson_planks', 'warped_planks'],
  wool: ['white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool', 'purple_wool',
    'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool'],
  coals: ['coal', 'charcoal'],
  stone_tool_materials: ['cobblestone', 'blackstone', 'cobbled_deepslate'],
  stone_crafting_materials: ['cobblestone', 'blackstone', 'cobbled_deepslate'],
  wooden_slabs: ['oak_slab', 'spruce_slab', 'birch_slab', 'jungle_slab', 'acacia_slab',
    'dark_oak_slab', 'mangrove_slab', 'cherry_slab', 'pale_oak_slab', 'crimson_slab', 'warped_slab']
};

/* ================= 配方表 ================= */

/**
 * @typedef {{out:string, n:number, in:Record<string,number>, via:string}} Recipe
 * `in` 的键可以是物品 id，也可以是 `#标签`。
 */

/**
 * 配方全表。用 `add()` 追加；成套的规则配方用循环生成，避免把 11 种木头手写 11 遍。
 * @type {Recipe[]}
 */
const RECIPES = [];
/** @param {string} out @param {number} n @param {Record<string,number>} ing @param {string} [via] */
function add(out, n, ing, via) { RECIPES.push({ out, n, in: ing, via: via || 'craft' }); }

/* --- 木材家族（按木头种类生成） --- */
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak',
  'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped'];
const LOG_OF = w => (w === 'crimson' || w === 'warped') ? w + '_stem' : w + '_log';
for (const w of WOODS) {
  const p = w + '_planks';
  add(p, 4, { [LOG_OF(w)]: 1 });
  add(w + '_stairs', 4, { [p]: 6 });
  add(w + '_slab', 6, { [p]: 3 });
  add(w + '_fence', 3, { [p]: 4, stick: 2 });
  add(w + '_fence_gate', 1, { [p]: 2, stick: 4 });
  add(w + '_door', 3, { [p]: 6 });
  add(w + '_trapdoor', 2, { [p]: 3 });
  add(w + '_button', 1, { [p]: 1 });
  add(w + '_pressure_plate', 1, { [p]: 2 });
  add(w + '_sign', 3, { [p]: 6, stick: 1 });
  add(w + '_boat', 1, { [p]: 5 });
}
add('stick', 4, { '#planks': 2 });
add('crafting_table', 1, { '#planks': 4 });
add('chest', 1, { '#planks': 8 });
add('barrel', 1, { '#planks': 6, '#wooden_slabs': 2 });
add('bookshelf', 1, { '#planks': 6, book: 3 });
add('note_block', 1, { '#planks': 8, redstone: 1 });
add('jukebox', 1, { '#planks': 8, diamond: 1 });
add('bowl', 4, { '#planks': 3 });
add('ladder', 3, { stick: 7 });
add('scaffolding', 6, { bamboo: 6, string: 1 });
add('composter', 1, { '#wooden_slabs': 7 });
add('chest_boat', 1, { '#planks': 5, chest: 1 });

/* --- 石质家族 --- */
const STONES = ['cobblestone', 'stone', 'stone_bricks', 'mossy_cobblestone', 'mossy_stone_bricks',
  'brick', 'sandstone', 'red_sandstone', 'deepslate_bricks', 'cobbled_deepslate',
  'polished_deepslate', 'nether_bricks', 'end_stone_bricks', 'prismarine', 'blackstone',
  'quartz', 'purpur'];
for (const s of STONES) {
  add(s + '_stairs', 4, { [s]: 6 });
  add(s + '_slab', 6, { [s]: 3 });
  add(s + '_wall', 6, { [s]: 6 });
}
add('stone', 1, { cobblestone: 1 }, 'smelt');
add('stone_bricks', 4, { stone: 4 });
add('cobbled_deepslate', 1, { cobblestone: 1 });
add('polished_deepslate', 4, { cobbled_deepslate: 4 });
add('deepslate_bricks', 4, { polished_deepslate: 4 });
add('mossy_cobblestone', 1, { cobblestone: 1, vine: 1 });
add('mossy_stone_bricks', 1, { stone_bricks: 1, vine: 1 });
add('brick', 1, { clay_ball: 1 }, 'smelt');
add('brick_block', 1, { brick: 4 });
add('sandstone', 1, { sand: 4 });
add('red_sandstone', 1, { red_sand: 4 });
add('quartz', 1, { nether_quartz_ore: 1 }, 'smelt');
add('furnace', 1, { cobblestone: 8 });
add('blast_furnace', 1, { furnace: 1, iron_ingot: 5, smooth_stone: 3 });
add('smoker', 1, { furnace: 1, '#logs': 4 });
add('stonecutter', 1, { stone: 3, iron_ingot: 1 });
add('cauldron', 1, { iron_ingot: 7 });
add('stone_pressure_plate', 1, { stone: 2 });
add('stone_button', 1, { stone: 1 });

/* --- 矿物与金属 --- */
add('iron_ingot', 1, { raw_iron: 1 }, 'smelt');
add('gold_ingot', 1, { raw_gold: 1 }, 'smelt');
add('copper_ingot', 1, { raw_copper: 1 }, 'smelt');
add('charcoal', 1, { '#logs': 1 }, 'smelt');
add('iron_ingot', 1, { iron_ore: 1, coal: 1, cobblestone: 1 }, 'smelt');
add('iron_ingot', 1, { iron_ore: 1, charcoal: 1, cobblestone: 1 }, 'smelt');
add('gold_ingot', 1, { gold_ore: 1, coal: 1, cobblestone: 1 }, 'smelt');
add('copper_ingot', 1, { copper_ore: 1, coal: 1, cobblestone: 1 }, 'smelt');

/**
 * ⚠️ 方块 ↔ 锭 的双向配方必须区分方向：
 *   「9 锭 → 1 方块」是正常的**合成**；「1 方块 → 9 锭」是**拆解**，用 `via:'uncraft'` 标记。
 * 如果不标记，`choose()` 会把拆解当成默认配方，于是
 * `diamond → diamond_block → diamond → …` 无限来回，需求表指数爆炸
 * （实测会跑到 guard 上限 1998 次才停，输出 `diamond ×1998` 这种荒谬结果）。
 * 拆解只在 `opts.allowUncraft` 显式打开时才参与规划。
 */
const ORE_BLOCKS = [
  ['iron_ingot', 'iron_block'], ['gold_ingot', 'gold_block'], ['diamond', 'diamond_block'],
  ['coal', 'coal_block'], ['redstone', 'redstone_block'], ['lapis_lazuli', 'lapis_block'],
  ['emerald', 'emerald_block'], ['copper_ingot', 'copper_block'], ['netherite_ingot', 'netherite_block']
];
for (const [ing, blk] of ORE_BLOCKS) {
  add(blk, 1, { [ing]: 9 });
  add(ing, 9, { [blk]: 1 }, 'uncraft');
}
add('iron_nugget', 9, { iron_ingot: 1 });
add('iron_ingot', 1, { iron_nugget: 9 }, 'uncraft');
add('gold_nugget', 9, { gold_ingot: 1 });
add('gold_ingot', 1, { gold_nugget: 9 }, 'uncraft');
add('netherite_ingot', 1, { netherite_scrap: 4, gold_ingot: 4 });

/* --- 工具与盔甲（按材质生成） --- */
const TIERS = [
  { p: 'wooden', mat: '#planks' },
  { p: 'stone', mat: '#stone_tool_materials' },
  { p: 'iron', mat: 'iron_ingot' },
  { p: 'golden', mat: 'gold_ingot' },
  { p: 'diamond', mat: 'diamond' },
  { p: 'netherite', mat: 'netherite_ingot' }
];
for (const { p, mat } of TIERS) {
  if (p === 'netherite') continue; // 下界合金走锻造台，见下方 smith
  add(p + '_pickaxe', 1, { [mat]: 3, stick: 2 });
  add(p + '_axe', 1, { [mat]: 3, stick: 2 });
  add(p + '_shovel', 1, { [mat]: 1, stick: 2 });
  add(p + '_hoe', 1, { [mat]: 2, stick: 2 });
  add(p + '_sword', 1, { [mat]: 2, stick: 1 });
}
const ARMOR_TIERS = [
  ['leather', 'leather'], ['iron', 'iron_ingot'], ['golden', 'gold_ingot'], ['diamond', 'diamond']
];
for (const [p, mat] of ARMOR_TIERS) {
  add(p + '_helmet', 1, { [mat]: 5 });
  add(p + '_chestplate', 1, { [mat]: 8 });
  add(p + '_leggings', 1, { [mat]: 7 });
  add(p + '_boots', 1, { [mat]: 4 });
}
for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
  add('netherite_' + piece, 1, { ['diamond_' + piece]: 1, netherite_ingot: 1 }, 'smith');
}
add('smithing_table', 1, { iron_ingot: 2, '#planks': 4 });
add('anvil', 1, { iron_block: 3, iron_ingot: 4 });
add('grindstone', 1, { stick: 2, stone_slab: 1, '#planks': 2 });
add('shield', 1, { '#planks': 6, iron_ingot: 1 });
add('bucket', 1, { iron_ingot: 3 });
add('shears', 1, { iron_ingot: 2 });
add('flint_and_steel', 1, { iron_ingot: 1, flint: 1 });
add('compass', 1, { iron_ingot: 4, redstone: 1 });
add('clock', 1, { gold_ingot: 4, redstone: 1 });
add('spyglass', 1, { amethyst_shard: 1, copper_ingot: 2 });
add('fishing_rod', 1, { stick: 3, string: 2 });
add('lead', 2, { string: 4, slime_ball: 1 });
add('saddle', 1, { leather: 3, iron_ingot: 1 });
add('chain', 1, { iron_ingot: 1, iron_nugget: 2 });
add('iron_bars', 16, { iron_ingot: 6 });
add('tripwire_hook', 2, { iron_ingot: 1, stick: 1, '#planks': 1 });

/* --- 远程武器与弹药 --- */
add('bow', 1, { stick: 3, string: 3 });
add('crossbow', 1, { stick: 3, string: 2, iron_ingot: 1, tripwire_hook: 1 });
add('arrow', 4, { flint: 1, stick: 1, feather: 1 });
add('spectral_arrow', 2, { arrow: 1, glowstone_dust: 4 });
add('firework_rocket', 3, { paper: 1, gunpowder: 1 });
add('tnt', 1, { gunpowder: 5, sand: 4 });

/* --- 红石与机械 --- */
add('redstone_torch', 1, { redstone: 1, stick: 1 });
add('repeater', 1, { stone: 3, redstone_torch: 2, redstone: 1 });
add('comparator', 1, { stone: 3, redstone_torch: 3, quartz: 1 });
add('piston', 1, { '#planks': 3, cobblestone: 4, iron_ingot: 1, redstone: 1 });
add('sticky_piston', 1, { piston: 1, slime_ball: 1 });
add('observer', 1, { cobblestone: 6, redstone: 2, quartz: 1 });
add('hopper', 1, { iron_ingot: 5, chest: 1 });
add('dropper', 1, { cobblestone: 7, redstone: 1 });
add('dispenser', 1, { cobblestone: 7, bow: 1, redstone: 1 });
add('lever', 1, { cobblestone: 1, stick: 1 });
add('target', 1, { redstone: 4, hay_block: 1 });
add('daylight_detector', 1, { glass: 3, quartz: 3, '#wooden_slabs': 3 });
add('lightning_rod', 1, { copper_ingot: 3 });
add('minecart', 1, { iron_ingot: 5 });
add('chest_minecart', 1, { minecart: 1, chest: 1 });
add('hopper_minecart', 1, { minecart: 1, hopper: 1 });
add('rail', 16, { iron_ingot: 6, stick: 1 });
add('powered_rail', 6, { gold_ingot: 6, stick: 1, redstone: 1 });
add('detector_rail', 6, { iron_ingot: 6, stone_pressure_plate: 1, redstone: 1 });
add('activator_rail', 6, { iron_ingot: 6, stick: 2, redstone_torch: 1 });

/* --- 照明与装饰 --- */
add('torch', 4, { '#coals': 1, stick: 1 });
add('soul_torch', 4, { '#coals': 1, stick: 1, soul_sand: 1 });
add('lantern', 1, { iron_nugget: 8, torch: 1 });
add('soul_lantern', 1, { iron_nugget: 8, soul_torch: 1 });
add('campfire', 1, { stick: 3, '#logs': 3, '#coals': 1 });
add('soul_campfire', 1, { stick: 3, '#logs': 3, soul_sand: 1, '#coals': 1 });
add('sea_lantern', 1, { prismarine_shard: 5, prismarine_crystals: 4 });
add('glass', 1, { sand: 1 }, 'smelt');
add('glass_pane', 16, { glass: 6 });
add('item_frame', 1, { stick: 8, leather: 1 });
add('painting', 1, { stick: 8, '#wool': 1 });
add('armor_stand', 1, { stick: 6, stone_slab: 1 });
add('flower_pot', 1, { brick: 3 });
add('bed', 1, { '#wool': 3, '#planks': 3 });
add('carpet', 3, { '#wool': 2 });
add('banner', 1, { '#wool': 6, stick: 1 });
add('shulker_box', 1, { shulker_shell: 2, chest: 1 });
add('barrel_deco', 1, { '#planks': 6, '#wooden_slabs': 2 });
add('jack_o_lantern', 1, { carved_pumpkin: 1, torch: 1 });
add('ender_chest', 1, { obsidian: 8, eye_of_ender: 1 });
add('enchanting_table', 1, { obsidian: 4, diamond: 2, book: 1 });
add('brewing_stand', 1, { blaze_rod: 1, cobblestone: 3 });
add('beacon', 1, { glass: 5, nether_star: 1, obsidian: 3 });
add('conduit', 1, { nautilus_shell: 8, heart_of_the_sea: 1 });
add('respawn_anchor', 1, { crying_obsidian: 6, glowstone: 3 });
add('loom', 1, { string: 2, '#planks': 2 });
add('cartography_table', 1, { paper: 2, '#planks': 4 });
add('fletching_table', 1, { flint: 2, '#planks': 4 });

/* --- 材料与食物 --- */
add('paper', 3, { sugar_cane: 3 });
add('book', 1, { paper: 3, leather: 1 });
add('sugar', 1, { sugar_cane: 1 });
add('bone_meal', 3, { bone: 1 });
add('blaze_powder', 2, { blaze_rod: 1 });
add('magma_cream', 1, { blaze_powder: 1, slime_ball: 1 });
add('slime_block', 1, { slime_ball: 9 });
add('slime_ball', 9, { slime_block: 1 }, 'uncraft');
add('eye_of_ender', 1, { ender_pearl: 1, blaze_powder: 1 });
add('bread', 1, { wheat: 3 });
add('cookie', 8, { wheat: 2, cocoa_beans: 1 });
add('cake', 1, { milk_bucket: 3, sugar: 2, egg: 1, wheat: 3 });
add('pumpkin_pie', 1, { pumpkin: 1, sugar: 1, egg: 1 });
add('golden_apple', 1, { gold_ingot: 8, apple: 1 });
add('enchanted_golden_apple', 1, { gold_block: 8, apple: 1 });
add('mushroom_stew', 1, { brown_mushroom: 1, red_mushroom: 1, bowl: 1 });
add('beetroot_soup', 1, { beetroot: 6, bowl: 1 });

/* --- 常用熔炼 --- */
add('dried_kelp', 1, { kelp: 1 }, 'smelt');
add('glass_bottle', 3, { glass: 3 });
add('smooth_stone', 1, { stone: 1 }, 'smelt');
add('netherite_scrap', 1, { ancient_debris: 1 }, 'smelt');

/** 输出 → 配方列表（同一种输出可能有多个配方，如铁锭既可从粗铁熔也可从铁矿熔） */
const INDEX = new Map();
function rebuildIndex() {
  INDEX.clear();
  for (const r of RECIPES) {
    if (!INDEX.has(r.out)) INDEX.set(r.out, []);
    INDEX.get(r.out).push(r);
  }
}
rebuildIndex();

/**
 * 追加配方（用于扩展包 / 新版本覆盖）。
 * @param {Array<Recipe|Array>} list 对象形式，或 `[out, n, in, via]` 数组形式
 * @param {{replace?:boolean}} [opts] replace=true 时先清空内置表
 * @returns {{ok:boolean, added:number, total:number}}
 */
function importRecipes(list, opts) {
  const ctx = /** @type {any} */ (opts || {});
  if (ctx.replace) RECIPES.length = 0;
  let added = 0;
  for (const r of (Array.isArray(list) ? list : [])) {
    if (!r) continue;
    const rec = Array.isArray(r)
      ? { out: r[0], n: Number(r[1]) || 1, in: r[2] || {}, via: r[3] || 'craft' }
      : { out: r.out, n: Number(r.n) || 1, in: r.in || {}, via: r.via || 'craft' };
    if (!rec.out || !rec.in || !Object.keys(rec.in).length) continue;
    RECIPES.push(rec);
    added++;
  }
  rebuildIndex();
  return { ok: true, added, total: RECIPES.length };
}

/**
 * 配方表概况。
 * @returns {{recipes:number, outputs:number, tags:number, byVia:Record<string,number>}}
 */
function stats() {
  const byVia = /** @type {Record<string, number>} */ ({});
  for (const r of RECIPES) byVia[r.via] = (byVia[r.via] || 0) + 1;
  return { recipes: RECIPES.length, outputs: INDEX.size, tags: Object.keys(TAGS).length, byVia };
}

/**
 * 查某个物品的所有配方。
 * @param {string} id
 * @returns {Recipe[]}
 */
function recipesFor(id) {
  return INDEX.get(String(id || '').replace(/^minecraft:/, '')) || [];
}

/**
 * 展开标签为候选物品列表；不是标签则返回 `[自身]`。
 * @param {string} key 形如 `#planks` 或 `stick`
 * @returns {string[]}
 */
function expandTag(key) {
  if (typeof key !== 'string') return [];
  if (key.charAt(0) === '#') return (TAGS[key.slice(1)] || []).slice();
  return [key.replace(/^minecraft:/, '')];
}

/* ================= 规划 ================= */

/** 材料的「来源」分组（用于采集顺序）
 *  @type {Array<[string, string, RegExp]>} */
const SOURCE_RULES = [
  ['mine', '挖矿', /(_ore|^raw_|_scrap|^coal$|^redstone$|^lapis_lazuli$|^diamond$|^emerald$|^quartz$|^amethyst_shard$|^obsidian$|^crying_obsidian$|^netherrack$|^cobblestone$|^stone$|^deepslate|^gravel$|^sand$|^red_sand$|^flint$|^ancient_debris$|^nether_quartz_ore$|^glowstone_dust$|^gunpowder$|^blaze_rod$|^ender_pearl$|^shulker_shell$|^nautilus_shell$|^heart_of_the_sea$|^prismarine)/],
  ['wood', '伐木', /(_log$|_stem$|^bamboo$|^sapling$|^vine$|^kelp$|^sugar_cane$)/],
  ['farm', '农牧', /(^wheat$|^carrot$|^potato$|^beetroot$|^cocoa_beans$|^egg$|^milk_bucket$|^leather$|^string$|^feather$|^bone$|^slime_ball$|^honeycomb$|^pumpkin$|^melon|^apple$|^brown_mushroom$|^red_mushroom$|_wool$|^hay_block$|^soul_sand$|^carved_pumpkin$)/],
  ['smelt', '熔炼', /(_ingot$|^charcoal$|^glass$|^brick$|^dried_kelp$|^smooth_stone$|^netherite_ingot$)/],
  ['craft', '合成/其他', /./]
];

/**
 * 单个物品的需求上限。正常规划绝不可能到达这个数量级；
 * 一旦越过就说明配方表里有回路（模组数据写坏 / 我们漏标了 uncraft），
 * 此时停止扩张并记入 `unresolved`，而不是让需求表指数膨胀把内存吃光。
 */
const NEED_CAP = 1e6;

/**
 * 判断一个材料该归到哪一类来源。
 * @param {string} id
 * @returns {{key:string, label:string}}
 */
function sourceOf(id) {
  const s = String(id || '').replace(/^minecraft:/, '');
  for (const [key, label, re] of SOURCE_RULES) {
    if (re.test(s)) return { key, label };
  }
  return { key: 'craft', label: '合成/其他' };
}

/**
 * 规划合成。
 *
 * @param {Array<{id:string,n:number}>|Record<string,number>} targets 目标物品
 * @param {{have?:Record<string,number>, depth?:number, pick?:Function}} [opts]
 *   `have` 手上已有的数量（会被抵扣）；`pick(id, recipes)` 自定义多配方时的选择
 * @returns {{ok:boolean, targets:Array<object>, steps:Array<object>,
 *   base:Array<{id:string, zh:string, need:number, have:number, missing:number, source:string, sourceLabel:string}>,
 *   totals:{kinds:number, items:number}, craftable:number, unresolved:Array<object>, tagChoice:Record<string,string>,
 *   need:Record<string,number>, unknown:Array<{key:string, qty:number}>}}
 */
function plan(targets, opts) {
  const opt = /** @type {any} */ (opts || {});
  const maxDepth = Math.max(1, opt.depth || 32);
  const pick = typeof opt.pick === 'function' ? opt.pick : null;
  const allowUncraft = Boolean(opt.allowUncraft);
  const have = Object.assign({}, opt.have || {});

  const list = [];
  if (Array.isArray(targets)) {
    for (const t of targets) {
      if (!t) continue;
      const id = String(t.id || '').replace(/^minecraft:/, '');
      // ⚠️ 不能写 `Number(t.n) || 1` —— 那会把 0 也变成 1，用户写 0 就变成"要 1 个"
      const n = (t.n === undefined || t.n === null) ? 1 : Number(t.n);
      if (id && Number.isFinite(n) && n > 0) list.push({ id, n });
    }
  } else if (targets && typeof targets === 'object') {
    for (const id of Object.keys(targets)) {
      const n = (targets[id] === undefined || targets[id] === null) ? 1 : Number(targets[id]);
      if (Number.isFinite(n) && n > 0) list.push({ id: id.replace(/^minecraft:/, ''), n });
    }
  }

  /** 总需求（不含库存抵扣） */
  const need = Object.create(null);
  for (const t of list) need[t.id] = (need[t.id] || 0) + t.n;

  /** 标签解析结果，一旦选定就不再变（否则不动点迭代不收敛） */
  const tagChoice = Object.create(null);
  /** 多配方选择结果，同样固定 */
  const recipeChoice = Object.create(null);
  /** 合成次数 */
  const craftOf = Object.create(null);
  const unresolved = [];

  function resolveKey(key) {
    if (key.charAt(0) !== '#') return key.replace(/^minecraft:/, '');
    if (tagChoice[key]) return tagChoice[key];
    const cands = TAGS[key.slice(1)] || [];
    if (!cands.length) { tagChoice[key] = null; return null; }
    let best = cands[0], bestN = -1;
    for (const c of cands) {
      const n = have[c] || 0;
      if (n > bestN) { bestN = n; best = c; }
    }
    tagChoice[key] = best;
    return best;
  }

  function choose(id) {
    if (recipeChoice[id] !== undefined) return recipeChoice[id];
    let rs = recipesFor(id);
    // 拆解配方（方块→锭）默认不参与 —— 否则和「锭→方块」形成回路，需求表会指数爆炸
    if (!allowUncraft) rs = rs.filter(r => r.via !== 'uncraft');
    // 配方里含输出自己（模组数据写坏）也剔掉
    rs = rs.filter(r => !Object.prototype.hasOwnProperty.call(r.in, id));
    const r = rs.length ? (pick ? (pick(id, rs) || rs[0]) : rs[0]) : null;
    recipeChoice[id] = r;
    return r;
  }

  // 不动点迭代：某物品需求变多 → 合成次数变多 → 上游材料需求变多
  let changed = true, guard = 0;
  while (changed && guard++ < 2000) {
    changed = false;
    for (const id of Object.keys(need)) {
      const rec = choose(id);
      if (!rec) continue;
      const stock = Math.max(0, have[id] || 0);
      const want = Math.max(0, need[id] - stock);
      const times = want > 0 ? Math.ceil(want / rec.n) : 0;
      const prev = craftOf[id] ? craftOf[id].times : 0;
      if (times > prev) {
        const delta = times - prev;
        for (const key of Object.keys(rec.in)) {
          const item = resolveKey(key);
          if (!item) {
            if (!unresolved.some(u => u.key === key)) {
              unresolved.push({ key, reason: 'unknown_tag', qty: 0 });
            }
            continue;
          }
          const next = (need[item] || 0) + rec.in[key] * delta;
          // 兜底：需求超过上限说明配方表里有回路，停止扩张并报出来（而不是把内存跑满）
          if (next > NEED_CAP) {
            if (!unresolved.some(u => u.key === item)) {
              unresolved.push({ key: item, reason: 'runaway', qty: need[item] || 0 });
            }
            continue;
          }
          need[item] = next;
        }
        craftOf[id] = { times, recipe: rec };
        changed = true;
      }
    }
  }

  // 基础材料 = 有需求但没有（或不需要）合成的
  const base = [];
  let missingTotal = 0;
  for (const id of Object.keys(need)) {
    const rec = choose(id);
    const times = craftOf[id] ? craftOf[id].times : 0;
    // 合成出来的量已经覆盖需求 → 不是基础材料
    if (rec && times > 0 && times * rec.n + (have[id] || 0) >= need[id]) continue;
    const remain = Math.max(0, need[id] - (have[id] || 0) - (rec ? times * rec.n : 0));
    if (remain <= 0) continue;
    const src = sourceOf(id);
    missingTotal += remain;
    base.push({
      id, zh: itemZh(id), need: need[id], have: have[id] || 0,
      missing: remain, source: src.key, sourceLabel: src.label
    });
  }
  base.sort((a, b) => b.missing - a.missing || a.id.localeCompare(b.id));

  const steps = [];
  for (const id of Object.keys(craftOf)) {
    const c = craftOf[id];
    if (!c || c.times <= 0) continue;
    steps.push({
      id, zh: itemZh(id), times: c.times, out: c.times * c.recipe.n,
      via: c.recipe.via, ingredients: c.recipe.in,
      from: Object.keys(c.recipe.in).map(k => ({ key: k, zh: k.charAt(0) === '#' ? k : itemZh(k), n: c.recipe.in[k] }))
    });
  }
  // 合成步骤：熔炼/锻造类放前面（要先有锭），其余按次数降序
  const VIA_ORDER = { smelt: 0, smith: 1, craft: 2 };
  steps.sort((a, b) => ((VIA_ORDER[a.via] || 2) - (VIA_ORDER[b.via] || 2)) || b.times - a.times);

  // 认不出来的物品（多半是拼错或模组物品）单独列出来，别混进"未解析"里吓人
  const unknown = [];
  for (const b of base) {
    if (!ITEM_ZH[b.id]) unknown.push({ key: b.id, qty: b.missing });
  }

  return {
    ok: true,
    targets: list.map(t => ({ ...t, zh: itemZh(t.id) })),
    need: Object.assign({}, need),
    base,
    steps,
    craftable: Object.keys(craftOf).length,
    unresolved,
    unknown,
    tagChoice: Object.assign({}, tagChoice),
    totals: { kinds: base.length, items: Math.round(missingTotal * 100) / 100 }
  };
}

/**
 * 把基础材料按「来源」分组成采集顺序。
 *
 * 顺序依据：先挖矿/伐木/农牧把原料拿到手，再进熔炼 —— 因为熔炼要占用熔炉且消耗燃料，
 * 放在最后一次性做完最省来回。
 *
 * @param {Array<{id:string,missing:number}>} base plan().base
 * @returns {Array<{key:string, label:string, items:Array<object>, total:number}>}
 */
function order(base) {
  const groups = new Map();
  for (const b of (Array.isArray(base) ? base : [])) {
    if (!b || !(b.missing > 0)) continue;
    const src = sourceOf(b.id);
    if (!groups.has(src.key)) groups.set(src.key, { key: src.key, label: src.label, items: [], total: 0 });
    const g = groups.get(src.key);
    g.items.push(b);
    g.total += b.missing;
  }
  const RANK = { mine: 0, wood: 1, farm: 2, craft: 3, smelt: 4 };
  for (const g of groups.values()) g.items.sort((a, b) => b.missing - a.missing || a.id.localeCompare(b.id));
  return [...groups.values()].sort((a, b) => {
    const ra = RANK[a.key] === undefined ? 9 : RANK[a.key];
    const rb = RANK[b.key] === undefined ? 9 : RANK[b.key];
    return ra - rb;
  });
}

/**
 * 算缺口：目标需求 vs 手上库存。
 * @param {Array<{id:string,n:number}>|Record<string,number>} targets
 * @param {Record<string,number>} have
 * @returns {{items:Array<{id:string, zh:string, need:number, have:number, missing:number, enough:boolean}>,
 *   missingKinds:number, missingTotal:number, allEnough:boolean}}
 */
function gaps(targets, have) {
  const h = have || {};
  const list = [];
  const norm = v => (v === undefined || v === null) ? 1 : Number(v);
  if (Array.isArray(targets)) {
    for (const t of targets) {
      if (!t || !t.id) continue;
      const n = norm(t.n);
      if (Number.isFinite(n) && n > 0) list.push({ id: String(t.id).replace(/^minecraft:/, ''), n });
    }
  } else if (targets && typeof targets === 'object') {
    for (const id of Object.keys(targets)) {
      const n = norm(targets[id]);
      if (Number.isFinite(n) && n > 0) list.push({ id: id.replace(/^minecraft:/, ''), n });
    }
  }
  const items = [];
  let missingKinds = 0, missingTotal = 0;
  for (const t of list) {
    const needN = t.n;
    const haveN = Number(h[t.id]) || 0;
    const miss = Math.max(0, needN - haveN);
    if (miss > 0) { missingKinds++; missingTotal += miss; }
    items.push({ id: t.id, zh: itemZh(t.id), need: needN, have: haveN, missing: miss, enough: miss === 0 });
  }
  items.sort((a, b) => (a.enough === b.enough ? b.missing - a.missing : (a.enough ? 1 : -1)));
  return { items, missingKinds, missingTotal, allEnough: missingKinds === 0 };
}

/**
 * 从容器物品列表（worlddb 的格式）汇总成库存表。
 * @param {Array<{id:string,count?:number,Count?:number}>} items
 * @returns {Record<string, number>}
 */
function inventoryOf(items) {
  const out = Object.create(null);
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || !it.id) continue;
    const id = String(it.id).replace(/^minecraft:/, '');
    const n = Number(it.count !== undefined ? it.count : it.Count) || 1;
    out[id] = (out[id] || 0) + n;
  }
  return out;
}

module.exports = {
  ITEM_ZH, TAGS, RECIPES,
  itemZh, expandTag, recipesFor, stats, importRecipes,
  sourceOf, plan, order, gaps, inventoryOf,
  WOODS, TIERS
};
