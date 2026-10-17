/**
 * 跨存档统一数据库（V4 第二组起家，V5 第二组补完「深度」）。
 *
 * 把所有存档的内容索引成可搜索的本地库：容器里的物品、命名实体、玩家背包、各存档统计。
 * 支持「我的附魔钻石剑在哪个存档哪个坐标」这种全局检索，以及跨存档统计。
 *
 * 设计：
 *   - 纯函数 indexChunk(root,{cx,cz,dim}) 抽容器 + 命名实体 + 带物品栏的实体。
 *   - scanSave(saveDir,{cacheDir}) 遍历三个维度 × (region/entities)，读 level.dat 取元数据
 *     与玩家背包；给了 cacheDir 就把**每个 region 文件的索引结果**落盘，下次按
 *     mtime+size 指纹只重读变过的文件。
 *   - searchDetailed() / stats() 在聚合结果上做，不碰文件。
 *   - 物品中文名用内置 ~120 条映射；命中不到时回退到「去 minecraft: 前缀 + 下划线转空格」。
 *   - 计划里写的是 SQLite，但本启动器零依赖、沙箱无法编译原生模块，这里用内容寻址式的
 *     纯 JS 索引实现同一套查询 API（检索/统计），迁移到 SQLite 时只换存储层、不动调用方。
 *
 * @module worlddb
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const anvil = require('./anvil');
const nbt = require('./nbt');

/** 三个维度 */
const DIMS = ['overworld', 'nether', 'end'];

/**
 * 存档里两类"装东西的地方"。
 * 标成字面量联合而不是裸数组：两个来源都有同样的命名（region 里挖方块实体、
 * entities 里挖矿车船），传错一个字符串在运行时不会报错，只会**静默少索引一半**。
 * @type {Array<'region'|'entities'>}
 */
const KINDS = ['region', 'entities'];

/** 落盘索引的版本号。字段结构一改就 +1，旧缓存自动失效（不是"尽力兼容"，是直接重扫）。 */
const INDEX_VERSION = 2;

/* ================= 容器识别 ================= */

/**
 * 容器方块 id。
 *
 * ⚠️ 原来这份表里有个 `minecraft:smokestack` —— 这个方块**不存在**（烟熏炉是 smoker，
 *    已经在表里）。一条永远匹配不上的规则看起来无害，实际会让人误以为烟熏炉是靠它命中的。
 *
 * ⚠️ 更重要的一个坑：**染色的潜影盒** id 是 `minecraft:red_shulker_box` 这种，
 *    16 种颜色加原版一共 17 个 id，用白名单列全会漏掉 16 个。所以下面用规则匹配。
 */
const CONTAINER_IDS = new Set([
  'minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel',
  'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker', 'minecraft:hopper',
  'minecraft:dispenser', 'minecraft:dropper', 'minecraft:brewing_stand',
  'minecraft:crafter',
  'minecraft:chiseled_bookshelf', 'minecraft:lectern', 'minecraft:jukebox',
  'minecraft:decorated_pot', 'minecraft:campfire', 'minecraft:soul_campfire',
  'minecraft:bee_nest', 'minecraft:beehive'
]);

/**
 * 潜影盒：`shulker_box` / `white_shulker_box` / `light_blue_shulker_box` / …
 *
 * ⚠️ 颜色名本身带下划线（`light_blue`），所以字符类是 `[a-z_]+` 而不是 `[a-z]+` ——
 *    写成后者会让 16 种染色潜影盒里有 12 种命中不了，而且正好是最常用的那几种。
 */
const SHULKER_RE = /^minecraft:([a-z_]+_)?shulker_box$/;

/**
 * 这个方块 id 是不是"能装东西"的容器。
 * @param {string} id
 * @returns {boolean}
 */
function isContainerId(id) {
  const s = String(id || '');
  return CONTAINER_IDS.has(s) || SHULKER_RE.test(s);
}

/** 带物品栏的实体（矿车/船/漏斗矿车…）：这些是**实体**，但一样能装东西 */
const CONTAINER_ENTITIES = new Set([
  'minecraft:chest_minecart', 'minecraft:hopper_minecart', 'minecraft:minecart',
  'minecraft:chest_boat', 'minecraft:oak_chest_boat', 'minecraft:spruce_chest_boat',
  'minecraft:birch_chest_boat', 'minecraft:jungle_chest_boat', 'minecraft:acacia_chest_boat',
  'minecraft:dark_oak_chest_boat', 'minecraft:mangrove_chest_boat',
  'minecraft:cherry_chest_boat', 'minecraft:bamboo_chest_raft'
]);

/* ================= 物品中文名 ================= */

/** 常见物品中文名（覆盖度够「找东西」用；查不到回退英文 id）。 */
const ITEM_ZH = {
  diamond_sword: '钻石剑', diamond: '钻石', diamond_ore: '钻石矿石', diamond_block: '钻石块',
  enchanted_book: '附魔书', netherite_sword: '下界合金剑', netherite_ingot: '下界合金锭',
  netherite_block: '下界合金块', gold_ingot: '金锭', gold_block: '金块', gold_ore: '金矿石',
  iron_ingot: '铁锭', iron_block: '铁块', iron_ore: '铁矿石', emerald: '绿宝石',
  emerald_ore: '绿宝石矿石', emerald_block: '绿宝石块', redstone: '红石', redstone_block: '红石块',
  redstone_ore: '红石矿石', lapis_lazuli: '青金石', lapis_block: '青金石块', lapis_ore: '青金石矿石',
  coal: '煤炭', coal_ore: '煤炭矿石', copper_ingot: '铜锭', copper_ore: '铜矿石', copper_block: '铜块',
  diamond_pickaxe: '钻石镐', diamond_axe: '钻石斧', diamond_shovel: '钻石铲', diamond_hoe: '钻石锄',
  elytra: '鞘翅', totem_of_undying: '不死图腾', golden_apple: '金苹果', enchanted_golden_apple: '附魔金苹果',
  beacon: '信标', ender_pearl: '末影珍珠', ender_eye: '末影之眼', blaze_rod: '烈焰棒',
  ghast_tear: '恶魂之泪', nether_star: '下界之星', dragon_head: '龙首', prismarine: '海晶石',
  sponge: '海绵', heart_of_the_sea: '海洋之心', nautilus_shell: '鹦鹉螺壳', trident: '三叉戟',
  conduit: '潮涌核心', obsidian: '黑曜石', crying_obsidian: '哭泣的黑曜石', ancient_debris: '远古残骸',
  chest: '箱子', barrel: '桶', shulker_box: '潜影盒', furnace: '熔炉', book: '书',
  oak_log: '橡木原木', oak_planks: '橡木木板', cobblestone: '圆石', stone: '石头', dirt: '泥土',
  grass_block: '草方块', sand: '沙子', gravel: '砂砾', brick: '红砖', iron_nugget: '铁粒',
  diamond_horse_armor: '钻石马铠', golden_horse_armor: '金马铠', saddle: '鞍', name_tag: '命名牌',
  netherite_scrap: '下界合金碎片', raw_iron: '粗铁', raw_gold: '粗金', raw_copper: '粗铜',
  wooden_sword: '木剑', stone_sword: '石剑', iron_sword: '铁剑', golden_sword: '金剑',
  iron_pickaxe: '铁镐', iron_axe: '铁斧', shield: '盾牌', bow: '弓', crossbow: '弩', arrow: '箭',
  bucket: '桶', water_bucket: '水桶', lava_bucket: '岩浆桶', milk_bucket: '奶桶',
  ender_chest: '末影箱', anvil: '铁砧', crafting_table: '工作台', torch: '火把',
  wheat: '小麦', bread: '面包', cooked_beef: '牛排', apple: '苹果', carrot: '胡萝卜',
  potato: '马铃薯', sugar_cane: '甘蔗', bamboo: '竹子', egg: '鸡蛋', honey_bottle: '蜂蜜瓶'
};

/** 附魔中文名（DSL 里 `ench:锋利` 能命中） */
const ENCH_ZH = {
  sharpness: '锋利', smite: '亡灵杀手', bane_of_arthropods: '节肢杀手', knockback: '击退',
  fire_aspect: '火焰附加', looting: '抢夺', sweeping: '横扫之刃', efficiency: '效率',
  silk_touch: '精准采集', unbreaking: '耐久', fortune: '时运', power: '力量',
  punch: '冲击', flame: '火矢', infinity: '无限', mending: '经验修补',
  protection: '保护', fire_protection: '火焰保护', feather_falling: '摔落保护',
  blast_protection: '爆炸保护', projectile_protection: '弹射物保护', respiration: '水下呼吸',
  aqua_affinity: '水下速掘', thorns: '荆棘', depth_strider: '深海探索者', frost_walker: '冰霜行者',
  soul_speed: '灵魂疾行', swift_sneak: '迅捷潜行', loyalty: '忠诚', impaling: '穿刺',
  riptide: '激流', channeling: '引雷', multishot: '多重射击', quick_charge: '快速装填',
  piercing: '穿透', luck_of_the_sea: '海之眷顾', lure: '饵钓', curse_of_binding: '绑定诅咒',
  curse_of_vanishing: '消失诅咒'
};

/** 去掉 minecraft: 前缀 */
function short(id) { return String(id || '').replace(/^[a-z_]+:/, ''); }

function itemZh(id) {
  const n = short(id);
  if (ITEM_ZH[n]) return ITEM_ZH[n];
  return n.replace(/_/g, ' ');
}

/** 附魔 id → 中文名（查不到就去前缀） */
function enchZh(id) { const n = short(id); return ENCH_ZH[n] || n.replace(/_/g, ' '); }

function isEnchanted(tag) {
  if (!tag || typeof tag !== 'object') return false;
  if (Array.isArray(tag.Enchantments) && tag.Enchantments.length) return true;
  if (Array.isArray(tag.StoredEnchantments) && tag.StoredEnchantments.length) return true;
  if (tag.components && tag.components['minecraft:enchantments']) return true;
  return false;
}

/**
 * 把 NBT 里的 CustomName（1.20+ 可能是字符串，也可能是组件）转成可读名字。
 * @param {*} cn
 * @returns {string|null}
 */
function customName(cn) {
  if (!cn) return null;
  if (typeof cn === 'string') {
    try { const j = JSON.parse(cn); if (j && j.text) return j.text; } catch {}
    return cn;
  }
  if (typeof cn === 'object') {
    if (cn.text) return String(cn.text);
    if (Array.isArray(cn.extra)) return cn.extra.map((e) => (e && e.text) || '').join('');
    // 1.20.5+ 的文本组件：{ type:'translatable', translate:'...' } / { type:'literal', text }
    if (cn.translate) return String(cn.translate);
    return null;
  }
  return null;
}

/* ================= 物品读取（1.20.5 前后两种写法） ================= */

/**
 * 物品 id。
 *
 * 1.20.5（24w09a）把物品格式从 `{id, Count, tag}` 改成了 `{id, count, components}`，
 * 而且 `id` 还可能是 `{id:'…', count:n}` 这种"堆叠"形态。只认老写法的话，
 * 所有新版存档会**一条物品都索引不到**，而且不报任何错 —— 索引"成功"但空的。
 */
function itemId(it) {
  if (!it || typeof it !== 'object') return null;
  if (typeof it.id === 'string') return it.id;
  if (it.id && typeof it.id === 'object' && typeof it.id.id === 'string') return it.id.id;
  return null;
}

function itemCount(it) {
  const raw = it.Count != null ? it.Count : (it.count != null ? it.count : (it.id && it.id.count));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** 物品的自定义名：老写法在 tag.display.Name，新写法在 components['minecraft:custom_name'] */
function itemName(it) {
  if (it.tag && it.tag.display && it.tag.display.Name) return customName(it.tag.display.Name);
  const comp = it.components;
  if (comp && comp['minecraft:custom_name'] != null) return customName(comp['minecraft:custom_name']);
  return null;
}

/**
 * 附魔清单 → [{ id, lvl, zh }]
 * 老写法：tag.Enchantments = [{ id, lvl }]
 * 新写法：components['minecraft:enchantments'] = { levels: { 'minecraft:sharpness': 5 } }
 * 附魔书另有 StoredEnchantments（老）与 'minecraft:stored_enchantments'（新）。
 */
function itemEnchants(it) {
  const out = [];
  const push = (id, lvl) => {
    if (!id) return;
    out.push({ id: short(id), lvl: Number(lvl) || 1, zh: enchZh(id) });
  };
  const fromList = (list) => {
    if (!Array.isArray(list)) return;
    for (const e of list) if (e) push(e.id, e.lvl != null ? e.lvl : e.level);
  };
  const fromMap = (obj) => {
    // { levels: { 'minecraft:sharpness': 5 }, show_in_tooltip: true }
    const levels = obj && typeof obj === 'object' && obj.levels && typeof obj.levels === 'object' ? obj.levels : null;
    if (!levels) return;
    for (const k of Object.keys(levels)) push(k, levels[k]);
  };
  const tag = it.tag;
  if (tag) { fromList(tag.Enchantments); fromList(tag.StoredEnchantments); }
  const c = it.components;
  if (c) {
    fromMap(c['minecraft:enchantments']);
    fromMap(c['minecraft:stored_enchantments']);
  }
  return out;
}

/** 嵌套内容：潜影盒 / 收纳袋 / 1.20.5+ 的 container 组件 */
function nestedItems(it) {
  const out = [];
  const t = it.tag;
  if (t) {
    // 1.11+ 潜影盒的内容在 tag.BlockEntityTag.Items；更早的版本直接是 tag.Items
    if (t.BlockEntityTag && Array.isArray(t.BlockEntityTag.Items)) out.push(...t.BlockEntityTag.Items);
    else if (Array.isArray(t.Items)) out.push(...t.Items);
  }
  const c = it.components;
  if (c) {
    // 1.20.5+：components['minecraft:container'] = [{ slot, item:{...} }]
    const cont = c['minecraft:container'];
    if (Array.isArray(cont)) for (const s of cont) { if (s && s.item) out.push(s.item); else if (s && s.id) out.push(s); }
    const bundle = c['minecraft:bundle_contents'];
    if (Array.isArray(bundle)) out.push(...bundle);
  }
  return out;
}

/**
 * 读一列物品槽 → 精简记录。嵌套最多展开两层（潜影盒套潜影盒），
 * 再深就没有信息价值了，而且给了构造深层嵌套数据打爆内存的机会。
 */
function readItems(list, depth) {
  const d = depth || 0;
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const it of list) {
    const id = itemId(it);
    if (!id) continue;
    const ench = itemEnchants(it);
    const rec = {
      id, count: itemCount(it), zh: itemZh(id),
      enchanted: ench.length > 0, ench: ench.map((e) => e.id),
      name: itemName(it)
    };
    if (d < 2) {
      const nest = nestedItems(it);
      if (nest.length) rec.nested = readItems(nest, d + 1);
    }
    out.push(rec);
  }
  return out;
}

/** 递归统计物品条数/总数（含嵌套） */
function countItems(items) {
  let kinds = 0;
  let total = 0;
  for (const it of items || []) {
    kinds++;
    total += it.count || 1;
    if (it.nested) { const n = countItems(it.nested); kinds += n.kinds; total += n.total; }
  }
  return { kinds, total };
}

/* ================= 纯函数：分析单个区块 ================= */

const DIM_ZH = { overworld: '主世界', nether: '下界', end: '末地' };

/** 区块里的方块实体列表：1.18+ 顶层 block_entities；≤1.17 在 Level.BlockEntities */
function beListOf(root) {
  const lv = levelOf(root);
  if (Array.isArray(root.block_entities)) return root.block_entities;
  if (root.BlockEntities) return root.BlockEntities;
  if (lv && Array.isArray(lv.block_entities)) return lv.block_entities;
  if (lv && Array.isArray(lv.BlockEntities)) return lv.BlockEntities;
  return null;
}

/** 区块里的实体列表：1.17+ 另有独立的 entities/ 文件；≤1.16 在 Level.Entities */
function entListOf(root) {
  const lv = levelOf(root);
  if (Array.isArray(root.Entities)) return root.Entities;
  if (lv && Array.isArray(lv.Entities)) return lv.Entities;
  return null;
}

function levelOf(root) {
  return root && root.Level && typeof root.Level === 'object' ? root.Level : null;
}

function num3(v) {
  return Array.isArray(v) && v.length >= 3 && Number.isFinite(Number(v[0])) ? Number(v[0]) : null;
}

/**
 * 给定已解析的区块/实体文件 NBT root，抽取容器、带物品栏的实体与命名实体。
 *
 * ⚠️ 原来只认 `Level.BlockEntities`。1.18 起方块实体挪到了**顶层 block_entities**，
 *    于是 1.18+ 的存档一条容器都索引不到 —— 而且不报错，就是"这个存档没有箱子"。
 *    这里两种写法都认。
 *
 * @param {object} root nbt.parse(raw).value
 * @param {{cx:number, cz:number, dim?:string}} pos
 * @returns {{containers:Array<object>, entities:Array<object>}}
 */
function indexChunk(root, pos) {
  const out = { containers: [], entities: [] };
  if (!root || typeof root !== 'object') return out;
  const lv = levelOf(root) || root;
  const cx = pos && Number.isFinite(pos.cx) ? pos.cx : (Number(lv.xPos) || 0);
  const cz = pos && Number.isFinite(pos.cz) ? pos.cz : (Number(lv.zPos) || 0);
  const dim = pos && pos.dim ? pos.dim : 'overworld';

  const bes = beListOf(root);
  if (Array.isArray(bes)) {
    for (const be of bes) {
      if (!be || !isContainerId(be.id)) continue;
      const items = readItems(be.Items, 0);
      out.containers.push({
        kind: 'container',
        type: short(be.id),
        x: Number(be.x), y: Number(be.y), z: Number(be.z),
        cx, cz, dim,
        items, slots: Array.isArray(be.Items) ? be.Items.length : 0,
        name: customName(be.CustomName)
      });
    }
  }

  const ents = entListOf(root);
  if (Array.isArray(ents)) {
    for (const e of ents) {
      if (!e) continue;
      // 带物品栏的实体（矿车/船）也是容器 —— 不索引它们，"我的东西呢"就会漏掉最常见的一种
      if (Array.isArray(e.Items) && (CONTAINER_ENTITIES.has(e.id) || e.Items.length)) {
        const p = Array.isArray(e.Pos) ? e.Pos : null;
        out.containers.push({
          kind: 'entity-container',
          type: short(e.id),
          x: p && Number.isFinite(Number(p[0])) ? Number(p[0]) : null,
          y: p && Number.isFinite(Number(p[1])) ? Number(p[1]) : null,
          z: p && Number.isFinite(Number(p[2])) ? Number(p[2]) : null,
          cx, cz, dim,
          items: readItems(e.Items, 0), slots: e.Items.length,
          name: customName(e.CustomName)
        });
      }
      const name = customName(e.CustomName);
      if (!name) continue;
      const p3 = Array.isArray(e.Pos) ? e.Pos : null;
      out.entities.push({
        type: short(e.id), name,
        x: p3 && Number.isFinite(Number(p3[0])) ? Number(p3[0]) : null,
        y: p3 && Number.isFinite(Number(p3[1])) ? Number(p3[1]) : null,
        z: p3 && Number.isFinite(Number(p3[2])) ? Number(p3[2]) : null,
        cx, cz, dim
      });
    }
  }
  return out;
}

/* ================= 落盘索引（按文件指纹增量） ================= */

function cachePath(cacheDir, saveDir) {
  const h = crypto.createHash('sha1').update(path.resolve(String(saveDir))).digest('hex').slice(0, 16);
  return path.join(cacheDir, h + '.json');
}

function loadIndex(cacheDir, saveDir) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(cacheDir, saveDir), 'utf8'));
    // 版本对不上就**整份丢弃**：字段结构变了还去"尽力兼容"，
    // 结果是索引里混着新旧两种形状的记录，报错的地方离这里很远。
    if (j && j.version === INDEX_VERSION && j.files && typeof j.files === 'object') return j;
  } catch {}
  return null;
}

function saveIndex(cacheDir, saveDir, data) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const body = Object.assign({ version: INDEX_VERSION, saveDir: path.resolve(saveDir) }, data);
    const txt = JSON.stringify(body);
    fs.writeFileSync(cachePath(cacheDir, saveDir), txt);
    return txt.length;
  } catch { return 0; }
}

function dropIndex(cacheDir, saveDir) {
  try { fs.rmSync(cachePath(cacheDir, saveDir), { force: true }); return true; } catch { return false; }
}

/**
 * 读一个 region 文件里**所有**区块的索引记录。
 * @param {string} file
 * @param {string} dim
 * @param {'region'|'entities'} kind
 */
function readRegionRecords(file, dim, kind) {
  const out = { containers: [], entities: [], chunks: 0, broken: 0, bytes: 0 };
  let buf = null;
  try { buf = anvil.readRegionFile(file); } catch { return out; }
  if (!buf) return out;
  out.bytes = buf.length;
  const rn = anvil.parseRegionName(path.basename(file)) || { rx: 0, rz: 0 };
  let list = [];
  try { list = anvil.listChunks(buf, rn.rx, rn.rz, kind); } catch { return out; }
  for (const rec of list) {
    if (rec.broken) { out.broken++; continue; }
    let raw = null;
    try { raw = anvil.readRawByIndex(buf, rec.i); } catch { out.broken++; continue; }
    if (!raw || !raw.data || !raw.data.length) continue;
    let root;
    try { root = nbt.parse(raw.data).value; } catch { out.broken++; continue; }
    out.chunks++;
    const r = indexChunk(root, { cx: rec.cx, cz: rec.cz, dim });
    for (const c of r.containers) out.containers.push(c);
    for (const e of r.entities) out.entities.push(e);
  }
  return out;
}

/* ================= 存档元数据 ================= */

function pos3(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const x = Number(v[0]);
  const y = Number(v[1]);
  const z = Number(v[2]);
  return [x, y, z].every(Number.isFinite) ? [x, y, z] : null;
}

/** 玩家所在的维度：1.16+ 是字符串 id，更早是数字（0/-1/1） */
function dimFromValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v === -1 ? 'nether' : (v === 1 ? 'end' : 'overworld');
  }
  const s = String(v == null ? '' : v);
  if (/nether/.test(s)) return 'nether';
  if (/_end|the_end/.test(s)) return 'end';
  return 'overworld';
}

/**
 * 读 level.dat：元数据 + 玩家位置/背包/末影箱。
 * 读不出来不是错误 —— 没有 level.dat 的目录（比如只有 region 的残档）一样能索引物品。
 * @param {string} saveDir
 * @param {string} fallbackName
 */
function readSaveMeta(saveDir, fallbackName) {
  const out = {
    name: fallbackName, levelName: fallbackName, version: '', dataVersion: null,
    time: 0, dayTime: 0, lastPlayed: 0, gameType: 0, hardcore: false, difficulty: null,
    spawn: null, player: null, seed: null, playerItems: [], enderItems: [],
    ok: false, error: ''
  };
  const p = path.join(saveDir, 'level.dat');
  if (!fs.existsSync(p)) { out.error = '没有 level.dat'; return out; }
  try {
    const tree = nbt.parseAuto(fs.readFileSync(p));
    // levelDatFields 的返回类型是可空的，`|| {}` 之后 TS 会把它推成「{...} | {}」，
    // 于是下面 f.LevelName 全部报「不存在于 {}」。显式标一遍字段（都可选）最省事也最准确。
    /** @type {{LevelName?:*, Version?:string, GameType?:*, hardcore?:*, allowCommands?:*,
     *           LastPlayed?:*, Time?:*, Difficulty?:*}} */
    const f = nbt.levelDatFields(tree) || {};
    const d = tree && tree.Data && typeof tree.Data === 'object' ? tree.Data : tree;
    out.levelName = f.LevelName != null ? String(f.LevelName) : fallbackName;
    out.name = out.levelName;
    out.version = f.Version || '';
    out.time = Number(f.Time) || 0;
    out.dayTime = Number(d.DayTime) || 0;
    out.lastPlayed = Number(f.LastPlayed) || 0;
    out.gameType = Number(f.GameType) || 0;
    out.hardcore = !!f.hardcore;
    out.difficulty = f.Difficulty != null ? Number(f.Difficulty) : null;
    out.dataVersion = Number.isFinite(Number(d.DataVersion)) ? Number(d.DataVersion) : null;
    const sp = [Number(d.SpawnX), Number(d.SpawnY), Number(d.SpawnZ)];
    if (sp.every(Number.isFinite)) out.spawn = sp;
    const seed = d.WorldGenSettings && d.WorldGenSettings.seed != null ? d.WorldGenSettings.seed : d.RandomSeed;
    if (seed != null && Number.isFinite(Number(seed))) out.seed = Number(seed);

    const pl = d.Player;
    if (pl && typeof pl === 'object') {
      const pp = pos3(pl.Pos);
      out.player = {
        pos: pp,
        dim: dimFromValue(pl.Dimension != null ? pl.Dimension : pl.SpawnDimension),
        gameType: Number(pl.playerGameType != null ? pl.playerGameType : pl.GameType) || 0,
        health: Number(pl.Health),
        food: Number(pl.foodLevel),
        xpLevel: Number(pl.XpLevel),
        score: Number(pl.Score)
      };
      out.playerItems = readItems(pl.Inventory, 0);
      out.enderItems = readItems(pl.EnderItems, 0);
    }
    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

/* ================= 扫描单个存档 ================= */

/**
 * 扫描一个存档：level.dat 元数据 + 玩家背包/末影箱 + 三个维度所有容器与命名实体。
 *
 * 给了 `cacheDir` 就启用落盘索引：每个 region 文件按 `mtime+size` 记指纹，
 * 指纹没变就直接复用上次的索引结果，不再解压一遍 NBT。
 * 一次全量扫描要解压几万个区块（几百 MB），而"只加了一个箱子"的世界里
 * 通常只有一两个 region 文件变过 —— 这个差别就是几十秒和零点几秒的差别。
 *
 * @param {{saveDir:string, cacheDir?:string, incremental?:boolean, dims?:string[],
 *          gameDir?:string, onProgress?:(o:object)=>void}} o
 * @returns {Promise<object>}
 */
async function scanSave(o) {
  const saveDir = o.saveDir;
  const fallback = path.basename(saveDir);
  const meta = readSaveMeta(saveDir, fallback);
  const dims = Array.isArray(o.dims) && o.dims.length ? o.dims : DIMS;

  const useCache = !!o.cacheDir && o.incremental !== false;
  const prev = useCache ? loadIndex(o.cacheDir, saveDir) : null;

  const containers = [];
  const entities = [];
  const files = {};
  let reused = 0;
  let parsedCount = 0;
  let broken = 0;
  let chunks = 0;
  let bytes = 0;

  for (const dim of dims) {
    for (const kind of KINDS) {
      const dir = anvil.dataDir(saveDir, dim, kind);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }   // 维度目录不存在是正常的
      for (const fn of names) {
        if (!/\.mca$/.test(fn)) continue;
        const full = path.join(dir, fn);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const rel = dim + '/' + kind + '/' + fn;
        const fp = st.mtimeMs + ':' + st.size;
        const hit = prev && prev.files[rel];
        // ⚠️ "mtime+size 没变"不等于"文件没变"：如果文件是在我们写下这份索引的**同一毫秒**
        //    里被改的，两者的 mtime 会一模一样 —— 于是改动被当成"没变"而永远看不出来。
        //    git 对这个"racy timestamp"的处理是：凡是 mtime 不早于索引写入时刻的文件，
        //    一律重新读一遍。这里照抄这条规则。
        const racy = !!(prev && prev.scannedAt && st.mtimeMs >= prev.scannedAt);
        let rec;
        if (hit && hit.fp === fp && !racy) {
          rec = hit;
          reused++;
        } else {
          const r = readRegionRecords(full, dim, kind);
          rec = { fp, containers: r.containers, entities: r.entities, chunks: r.chunks, broken: r.broken, bytes: r.bytes };
          parsedCount++;
        }
        files[rel] = rec;
        broken += rec.broken || 0;
        chunks += rec.chunks || 0;
        bytes += rec.bytes || 0;
        for (const c of rec.containers) containers.push(c);
        for (const e of rec.entities) entities.push(e);
      }
    }
  }

  // 玩家背包 / 末影箱：这是"我的东西到底放哪了"最常问的一个，别漏
  const pDim = meta.player ? meta.player.dim : 'overworld';
  const pPos = meta.player && meta.player.pos ? meta.player.pos : meta.spawn;
  const pseudo = (kind, type, items, slots) => {
    if (!items.length) return;
    containers.push({
      kind, type,
      x: pPos ? pPos[0] : null, y: pPos ? pPos[1] : null, z: pPos ? pPos[2] : null,
      cx: pPos ? Math.floor(pPos[0] / 16) : 0, cz: pPos ? Math.floor(pPos[2] / 16) : 0,
      dim: pDim, items, slots, name: null
    });
  };
  pseudo('player', 'player', meta.playerItems, 36);
  pseudo('ender_chest', 'ender_chest', meta.enderItems, 27);

  const result = {
    dir: saveDir,
    gameDir: o.gameDir || null,
    name: meta.name || fallback,
    levelName: meta.levelName,
    version: meta.version,
    dataVersion: meta.dataVersion,
    time: meta.time,
    dayTime: meta.dayTime,
    lastPlayed: meta.lastPlayed,
    gameType: meta.gameType,
    hardcore: meta.hardcore,
    difficulty: meta.difficulty,
    spawn: meta.spawn,
    player: meta.player,
    seed: meta.seed,
    metaOk: meta.ok,
    metaError: meta.error,
    dims: dims.slice(),
    containers, entities,
    scan: {
      files: Object.keys(files).length,
      reusedFiles: reused,
      parsedFiles: parsedCount,
      chunks, broken, bytes,
      incremental: useCache,
      cached: !!prev
    }
  };

  // 落盘。加时间戳是为了让上层能判断"这份索引是多久之前扫的"，
  // 存档被别人改过之后 UI 需要提示"索引可能过时了，重新扫一遍"。
  if (useCache) {
    result.scan.cachedAt = Date.now();
    result.scan.cacheBytes = saveIndex(o.cacheDir, saveDir, {
      scannedAt: Date.now(), gameDir: o.gameDir || null,
      meta: {
        name: result.name, levelName: result.levelName, version: result.version,
        dataVersion: result.dataVersion, time: result.time, dayTime: result.dayTime,
        lastPlayed: result.lastPlayed, gameType: result.gameType, hardcore: result.hardcore,
        difficulty: result.difficulty, spawn: result.spawn, player: result.player,
        seed: result.seed, metaOk: result.metaOk, metaError: result.metaError
      },
      playerContainers: containers.filter((c) => c.kind === 'player' || c.kind === 'ender_chest'),
      files
    });
  }
  return result;
}

/**
 * 扫描一个或多个 gameDir 下的所有存档。
 * @param {{gameDir?:string, gameDirs?:string[], cacheDir?:string, incremental?:boolean,
 *          dims?:string[], onProgress?:(o:object)=>void}} o
 * @returns {Promise<Array<object>>}
 */
async function scanGameDir(o) {
  const dirs = (Array.isArray(o.gameDirs) && o.gameDirs.length ? o.gameDirs : [o.gameDir])
    .filter(Boolean);
  const out = [];
  let done = 0;
  // 先收集所有存档目录，才能报出有意义的总进度（多 gameDir 时尤其）
  const jobs = [];
  for (const gd of dirs) {
    const savesDir = path.join(gd, 'saves');
    let names = [];
    try { names = fs.readdirSync(savesDir); } catch { continue; }
    for (const n of names) {
      const p = path.join(savesDir, n);
      try { if (fs.statSync(p).isDirectory()) jobs.push({ dir: p, gameDir: gd }); } catch {}
    }
  }
  for (const j of jobs) {
    let sv = null;
    try {
      sv = await scanSave({
        saveDir: j.dir, cacheDir: o.cacheDir, incremental: o.incremental,
        dims: o.dims, gameDir: j.gameDir
      });
    } catch { sv = null; }
    if (sv) out.push(sv);
    if (o.onProgress) o.onProgress({ done: ++done, total: jobs.length, save: j.dir });
  }
  out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  return out;
}

/* ================= 检索 DSL ================= */

const FILTER_KEYS = new Set([
  'dim', 'dimension', 'save', 'kind', 'near', 'ench', 'enchant', 'enchantment',
  'exact', 'sort', 'order', 'limit', 'page'
]);

function normDim(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return null;
  if (s === 'overworld' || s === '主世界' || s === '地表' || s === 'over') return 'overworld';
  if (s === 'nether' || s === '下界' || s === '地狱') return 'nether';
  if (s === 'end' || s === 'the_end' || s === '末地' || s === '末影') return 'end';
  return null;
}

function parseNear(val) {
  const parts = String(val == null ? '' : val).split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (!parts.length) return { error: 'near 后面要跟 me（我身边）或者 x,y,z[,半径]' };
  if (/^(me|我|自己|玩家|周边|身边)$/i.test(parts[0])) {
    const r = parts.length > 1 ? Number(parts[1]) : 64;
    if (!Number.isFinite(r) || r <= 0) return { error: 'near:me 的半径必须是正数' };
    return { me: true, r };
  }
  if (parts.length !== 3 && parts.length !== 4) {
    return { error: 'near 要写成 near:x,y,z 或 near:x,y,z,半径' };
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  const r = parts.length === 4 ? Number(parts[3]) : 64;
  if (![x, y, z, r].every(Number.isFinite) || r <= 0) {
    return { error: 'near 的坐标与半径必须是数字' };
  }
  return { me: false, x, y, z, r };
}

/**
 * 解析检索串。支持：
 *   `钻石剑`                    普通词（子串匹配 zh / id / 自定义名）
 *   `附魔` / `ench:diamond`     要求有附魔 / 要求某个附魔
 *   `dim:nether`                只看某个维度（也认 主世界/下界/末地）
 *   `save:生存`                 只看名字里含"生存"的存档
 *   `kind:container|entity`     只看容器 / 只看命名实体
 *   `near:me,128`               离**该存档里玩家**128 格以内（跨存档才有意义）
 *   `near:100,64,-200,32`       离给定坐标 32 格以内（同一存档内才有意义）
 *   `exact:stone`               精确匹配（不然 stone 会命中 redstone、cobblestone）
 *   `exact`（裸词）              整串都按精确算；要搜这个字面词就写 `"exact"`
 *   `sort:count|dist|name|save` 排序；`order:asc|desc`；`limit:`/`page:` 分页
 *   `"两个 词"`                 引号里当一个词
 *
 * ⚠️ 只有**认得的** key 才当过滤器：`minecraft:diamond_sword` 这种也要能当普通词查，
 *    因为冒号在 Minecraft id 里太常见了。
 *
 * 只给过滤器、不给词（例如 `dim:nether`）时会列出**该范围内的全部**容器与命名实体 ——
 * 那是"下界里都有些什么"这种正常问法。完全空的串仍然是"什么都没查"，返回空。
 *
 * @param {string} input
 * @returns {object}
 */
function parseQuery(input) {
  const raw = String(input == null ? '' : input).trim();
  const out = {
    raw, terms: [], exactTerms: [], ench: [], enchanted: false,
    save: null, dim: null, kind: null, near: null, exactAll: false,
    sort: null, order: 'desc', limit: 0, page: 1, filters: 0, error: ''
  };
  if (!raw) return out;
  const tokens = raw.match(/"[^"]*"|\S+/g) || [];
  for (let tok of tokens) {
    let quoted = false;
    if (tok.length >= 2 && tok[0] === '"' && tok[tok.length - 1] === '"') {
      tok = tok.slice(1, -1);
      quoted = true;
    }
    const m = quoted ? null : /^([A-Za-z_]+):(.*)$/.exec(tok);
    if (m && FILTER_KEYS.has(m[1].toLowerCase())) {
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === 'dim' || key === 'dimension') {
        const d = normDim(val);
        if (!d) { out.error = '不认识的维度「' + val + '」（可用：主世界 / 下界 / 末地）'; }
        else { out.dim = d; out.filters++; }
        continue;
      }
      if (key === 'save') { out.save = val.toLowerCase(); out.filters++; continue; }
      if (key === 'kind') {
        const k = val.toLowerCase();
        if (k === 'container' || k === 'containers' || k === '容器') out.kind = 'container';
        else if (k === 'entity' || k === 'entities' || k === '实体') out.kind = 'entity';
        else out.error = 'kind 只能是 container 或 entity';
        out.filters++;
        continue;
      }
      if (key === 'near') {
        const n = parseNear(val);
        if (n.error) out.error = n.error;
        else { out.near = n; out.filters++; }
        continue;
      }
      if (key === 'ench' || key === 'enchant' || key === 'enchantment') {
        out.enchanted = true;
        out.filters++;
        if (val) out.ench.push(val.toLowerCase().replace(/^minecraft:/, ''));
        continue;
      }
      if (key === 'exact') {
        out.filters++;
        if (val) out.exactTerms.push(val.toLowerCase());
        else out.exactAll = true;
        continue;
      }
      if (key === 'sort') {
        const s = val.toLowerCase();
        if (['count', 'dist', 'distance', 'name', 'save', 'time'].includes(s)) {
          out.sort = s === 'distance' ? 'dist' : s;
          out.filters++;
        } else out.error = 'sort 只能是 count / dist / name / save / time';
        continue;
      }
      if (key === 'order') {
        out.order = val.toLowerCase() === 'asc' ? 'asc' : 'desc';
        out.filters++;
        continue;
      }
      if (key === 'limit' || key === 'page') {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) { out[key] = Math.floor(n); out.filters++; }
        else out.error = key + ' 必须是正整数';
        continue;
      }
    }
    if (!tok) continue;
    // 裸词 `exact`：让**整串**都按精确算。想搜"exact"这个字面词就加引号（`"exact"`）——
    // 所以下面两条裸词判断都要排除带引号的 token。
    if (!quoted && /^exact$/i.test(tok)) { out.exactAll = true; out.filters++; continue; }
    if (!quoted && /^附魔$|^ench(anted)?$/i.test(tok)) { out.enchanted = true; out.filters++; continue; }
    out.terms.push(tok.toLowerCase());
  }
  return out;
}

/** 一个词对一段文本的匹配（exact 时全等，否则子串） */
function hitText(text, q, exact) {
  const t = String(text == null ? '' : text).toLowerCase();
  return exact ? t === q : t.includes(q);
}

/** 一个物品是否命中所有词 */
function itemHit(it, q) {
  const terms = q.terms.concat(q.exactTerms);
  // "有没有真在查东西"：词、或者附魔条件。都没有就只剩过滤器了。
  // ⚠️ 这里必须把 `q.ench` 也算进去 —— 只写 `ench:mending` 时 terms 是空的，
  //    如果只按"有没有词"决定，就会退化成"只要带附魔的都算"，
  //    于是**没装这个附魔的东西也会被报出来**（用户以为找到了，实际是假的）。
  if (!terms.length && !q.enchanted && !q.ench.length) {
    // 只给了过滤器（dim:/save:/near:）→ 该范围内的东西全要（"下界里都有些什么"）
    return q.filters > 0;
  }
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const exact = q.exactAll || i >= q.terms.length;
    const ok = hitText(it.zh, term, exact) || hitText(short(it.id), term, exact) ||
      hitText(it.id, term, exact) || hitText(it.name, term, exact);
    if (!ok) return false;
  }
  if (q.enchanted && !it.enchanted) return false;
  for (const want of q.ench) {
    const ok = (it.ench || []).some((e) => hitText(e, want, false) || hitText(enchZh(e), want, false));
    if (!ok) return false;
  }
  return true;
}

/** 一个命名实体是否命中 */
function entityHit(e, q) {
  if (q.enchanted || q.ench.length) return false;   // 实体没有附魔这个概念
  const terms = q.terms.concat(q.exactTerms);
  if (!terms.length) return q.filters > 0;           // 只给过滤器时（dim:/save:/near:）不排除实体
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const exact = q.exactAll || i >= q.terms.length;
    if (!hitText(e.name, term, exact) && !hitText(e.type, term, exact)) return false;
  }
  return true;
}

function horizontalDist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 跨存档检索物品 / 命名实体（带诊断信息的版本）。
 *
 * @param {Array<object>} saves scanGameDir 的结果
 * @param {string|object} query 检索串（或 {q, ...} 形式）
 * @returns {{results:Array<object>, total:number, pages:number, page:number,
 *            query:object, error:string}}
 */
function searchDetailed(saves, query) {
  const q = typeof query === 'string' ? parseQuery(query)
    : Object.assign(parseQuery(query && query.q), query || {});
  const list = Array.isArray(saves) ? saves : [];
  /** @type {Array<object>} */
  const results = [];
  if (!q || (!q.terms.length && !q.exactTerms.length && !q.filters && !q.enchanted)) {
    return { results, total: 0, pages: 0, page: 1, query: q, error: q ? q.error : '' };
  }

  for (const sv of list) {
    if (q.save && !(String(sv.name || '').toLowerCase().includes(q.save) ||
      String(sv.dir || '').toLowerCase().includes(q.save))) continue;
    if (q.kind === 'entity' && !sv.entities.length) continue;

    // near 的参照点：me → 这个存档里玩家的位置（没有就看世界出生点）；否则用给定坐标
    let anchor = null;
    if (q.near) {
      if (q.near.me) {
        anchor = (sv.player && sv.player.pos) || sv.spawn || null;
        if (!anchor) continue;               // 连玩家位置都不知道，谈不了"身边"
      } else anchor = [q.near.x, q.near.y, q.near.z];
    }

    if (q.kind !== 'entity') {
      for (const c of sv.containers) {
        if (q.dim && c.dim !== q.dim) continue;
        const hits = c.items.filter((it) => itemHit(it, q));
        if (!hits.length) continue;
        let dist = null;
        if (q.near) {
          if (![c.x, c.y, c.z].every(Number.isFinite)) continue;
          dist = horizontalDist(anchor, [c.x, c.y, c.z]);
          if (dist > q.near.r) continue;
        }
        const cnt = countItems(hits);
        results.push({
          save: sv.name, saveDir: sv.dir, gameDir: sv.gameDir,
          kind: c.kind === 'container' ? 'container' : c.kind,
          type: c.type, name: c.name || null, dim: c.dim,
          x: c.x, y: c.y, z: c.z, cx: c.cx, cz: c.cz,
          dist: dist == null ? null : Math.round(dist),
          items: hits, itemKinds: cnt.kinds, itemTotal: cnt.total,
          lastPlayed: sv.lastPlayed || 0
        });
      }
    }
    if (q.kind !== 'container') {
      for (const e of sv.entities) {
        if (q.dim && e.dim !== q.dim) continue;
        if (!entityHit(e, q)) continue;
        let dist = null;
        if (q.near) {
          if (![e.x, e.y, e.z].every(Number.isFinite)) continue;
          dist = horizontalDist(anchor, [e.x, e.y, e.z]);
          if (dist > q.near.r) continue;
        }
        results.push({
          save: sv.name, saveDir: sv.dir, gameDir: sv.gameDir,
          kind: 'entity', type: e.type, name: e.name, dim: e.dim,
          x: e.x, y: e.y, z: e.z, cx: e.cx, cz: e.cz,
          dist: dist == null ? null : Math.round(dist),
          items: null, itemKinds: 0, itemTotal: 0,
          lastPlayed: sv.lastPlayed || 0
        });
      }
    }
  }

  // 排序：默认不排（保持扫描顺序），显式给了 sort 才排
  if (q.sort) {
    const dir = q.order === 'asc' ? 1 : -1;
    const key = {
      count: (r) => r.itemTotal || 0,
      dist: (r) => (r.dist == null ? Number.MAX_SAFE_INTEGER : r.dist),
      name: (r) => String(r.name || ''),
      save: (r) => String(r.save || ''),
      time: (r) => r.lastPlayed || 0
    }[q.sort];
    if (key) {
      results.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (ka === kb) return 0;
        return ka > kb ? dir : -dir;
      });
    }
  }

  const total = results.length;
  const pages = q.limit > 0 ? Math.max(1, Math.ceil(total / q.limit)) : 1;
  const page = Math.min(Math.max(1, q.page || 1), pages);
  const paged = q.limit > 0 ? results.slice((page - 1) * q.limit, page * q.limit) : results;
  return { results: paged, total, pages, page, query: q, error: q.error || '' };
}

/**
 * 跨存档检索（保持既有契约：返回结果数组）。
 * @param {Array<object>} saves scanGameDir 的结果
 * @param {string|object} query
 * @returns {Array<object>}
 */
function search(saves, query) { return searchDetailed(saves, query).results; }

/* ================= 统计 ================= */

/**
 * 跨存档统计。
 * @param {Array<object>} saves
 * @returns {object}
 */
function stats(saves) {
  const list = Array.isArray(saves) ? saves : [];
  let totalContainers = 0;
  let totalNamedEntities = 0;
  let totalPlayTicks = 0;
  let totalItemKinds = 0;
  let totalItemCount = 0;
  let totalEnchanted = 0;
  let totalCustomNamed = 0;
  let brokenChunks = 0;
  let indexedChunks = 0;
  let indexedBytes = 0;
  const itemHist = new Map();
  const enchHist = new Map();
  const dimHist = { overworld: 0, nether: 0, end: 0 };
  const saveByContainers = [];

  for (const sv of list) {
    totalContainers += sv.containers.length;
    totalNamedEntities += sv.entities.length;
    totalPlayTicks += sv.time || 0;
    if (sv.scan) {
      brokenChunks += sv.scan.broken || 0;
      indexedChunks += sv.scan.chunks || 0;
      indexedBytes += sv.scan.bytes || 0;
    }
    for (const c of sv.containers) {
      if (c.dim && dimHist[c.dim] != null) dimHist[c.dim]++;
      const walk = (items) => {
        for (const it of items || []) {
          const k = it.zh || itemZh(it.id);
          itemHist.set(k, (itemHist.get(k) || 0) + (it.count || 1));
          totalItemKinds++;
          totalItemCount += it.count || 1;
          if (it.enchanted) {
            totalEnchanted++;
            for (const e of it.ench || []) enchHist.set(enchZh(e), (enchHist.get(enchZh(e)) || 0) + 1);
          }
          if (it.name) totalCustomNamed++;
          if (it.nested) walk(it.nested);
        }
      };
      walk(c.items);
    }
    saveByContainers.push({
      name: sv.name, dir: sv.dir, containers: sv.containers.length,
      entities: sv.entities.length, dims: sv.dims ? sv.dims.slice() : [],
      lastPlayed: sv.lastPlayed || 0, version: sv.version || '',
      playHours: Math.round(((sv.time || 0) / 20 / 3600) * 10) / 10
    });
  }
  const topItems = [...itemHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([zh, count]) => ({ zh, count }));
  const topEnchants = [...enchHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([zh, count]) => ({ zh, count }));
  saveByContainers.sort((a, b) => b.containers - a.containers);
  return {
    saves: list.length,
    totalContainers,
    totalNamedEntities,
    totalPlayTicks,
    playHours: Math.round((totalPlayTicks / 20 / 3600) * 10) / 10,
    topItems,
    topSavesByContainers: saveByContainers.slice(0, 8),
    // ↓ V5 第二组补的：让"我这一堆存档到底有些什么"能一眼看完
    totalItems: totalItemCount,
    totalItemStacks: totalItemKinds,
    totalEnchantedItems: totalEnchanted,
    totalCustomNamedItems: totalCustomNamed,
    topEnchants,
    dims: dimHist,
    indexedChunks,
    brokenChunks,
    indexedBytes,
    savings: {
      indexMB: Math.round((indexedBytes / 1024 / 1024) * 10) / 10,
      reusedFiles: list.reduce((n, s) => n + ((s.scan && s.scan.reusedFiles) || 0), 0),
      parsedFiles: list.reduce((n, s) => n + ((s.scan && s.scan.parsedFiles) || 0), 0)
    }
  };
}

module.exports = {
  DIMS, INDEX_VERSION, DIM_ZH,
  ITEM_ZH, ENCH_ZH, CONTAINER_IDS, CONTAINER_ENTITIES,
  itemZh, enchZh, short, isEnchanted, customName,
  isContainerId, beListOf, entListOf,
  itemId, itemCount, itemEnchants, nestedItems, readItems, countItems,
  indexChunk, readRegionRecords, readSaveMeta, dimFromValue,
  scanSave, scanGameDir,
  cachePath, loadIndex, saveIndex, dropIndex,
  parseQuery, parseNear, normDim, searchDetailed, search, stats
};
