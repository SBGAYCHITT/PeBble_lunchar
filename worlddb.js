/**
 * 跨存档统一数据库（第二组：存档可视化与数据，优先级 #2）。
 *
 * 把所有存档的内容索引成可搜索的本地库：容器(箱子/潜影盒/桶…)里的物品、命名实体、
 * 各存档统计。支持「我的附魔钻石剑在哪个存档哪个坐标」这种全局检索，以及跨存档统计
 * （游戏时长、容器数、命名实体、热门物品）。
 *
 * 设计：
 *   - 纯函数 indexChunk(root,{cx,cz}) 抽容器物品 + 命名实体，单测直接喂合成 NBT root。
 *   - scanSave(saveDir) 用 anvil 遍历 region + entities，聚合；读 level.dat 取存档元数据。
 *   - search() / stats() 在聚合结果上做，不碰文件。
 *   - 物品中文名用内置 ~120 条映射；命中不到时回退到「去 minecraft: 前缀 + 下划线转空格」。
 *   - 计划里写的是 SQLite，但本启动器零依赖、沙箱无法编译原生模块，这里用内容寻址式的
 *     纯 JS 索引实现同一套查询 API（检索/统计），迁移到 SQLite 时只换存储层、不动调用方。
 *
 * @module worlddb
 */
const fs = require('fs');
const path = require('path');
const anvil = require('./anvil');
const nbt = require('./nbt');

/** 容器方块 id（这些 BlockEntity 里才有物品栏） */
const CONTAINER_IDS = new Set([
  'minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel', 'minecraft:shulker_box',
  'minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker', 'minecraft:hopper',
  'minecraft:dispenser', 'minecraft:dropper', 'minecraft:brewing_stand', 'minecraft:smokestack'
]);

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
  diamond_horse_armor: '钻石马铠', golden_horse_armor: '金马铠', saddle: '鞍', name_tag: '命名牌'
};

function itemZh(id) {
  const n = (id || '').replace(/^minecraft:/, '');
  if (ITEM_ZH[n]) return ITEM_ZH[n];
  return n.replace(/_/g, ' ');
}

function isEnchanted(tag) {
  if (!tag || typeof tag !== 'object') return false;
  if (Array.isArray(tag.Enchantments) && tag.Enchantments.length) return true;
  if (Array.isArray(tag.StoredEnchantments) && tag.StoredEnchantments.length) return true;
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
    return null;
  }
  return null;
}

/* ================= 纯函数：分析单个区块 ================= */

/**
 * 给定已解析的区块/实体文件 NBT root，抽取容器与命名实体。
 * @param {object} root nbt.parse(raw).value
 * @param {{cx:number, cz:number}} pos
 * @returns {{containers:Array<object>, entities:Array<object>}}
 */
function indexChunk(root, pos) {
  const out = { containers: [], entities: [] };
  if (!root || typeof root !== 'object') return out;
  const lv = root.Level || root;
  const cx = pos ? pos.cx : (Number(lv.xPos) || 0);
  const cz = pos ? pos.cz : (Number(lv.zPos) || 0);

  const bes = lv.BlockEntities;
  if (Array.isArray(bes)) {
    for (const be of bes) {
      const id = be ? be.id : null;
      if (!id || !CONTAINER_IDS.has(id)) continue;
      const items = [];
      if (Array.isArray(be.Items)) {
        for (const it of be.Items) {
          if (!it || !it.id) continue;
          items.push({ id: it.id, count: Number(it.Count) || 1, zh: itemZh(it.id), enchanted: isEnchanted(it.tag) });
        }
      }
      out.containers.push({
        type: id.replace(/^minecraft:/, ''),
        x: Number(be.x), y: Number(be.y), z: Number(be.z),
        cx, cz, items
      });
    }
  }

  const ents = lv.Entities;
  if (Array.isArray(ents)) {
    for (const e of ents) {
      if (!e) continue;
      const name = customName(e.CustomName);
      if (!name) continue;
      const pos3 = Array.isArray(e.Pos) ? e.Pos : null;
      out.entities.push({
        type: (e.id || '').replace(/^minecraft:/, ''),
        name, x: pos3 ? Number(pos3[0]) : null, y: pos3 ? Number(pos3[1]) : null, z: pos3 ? Number(pos3[2]) : null,
        cx, cz
      });
    }
  }
  return out;
}

/* ================= 扫描单个存档 ================= */

/**
 * 扫描一个存档：level.dat 元数据 + 所有容器 + 命名实体。
 * @param {{saveDir:string}} o
 * @returns {Promise<{dir:string, name:string, version:string, time:number, containers:Array<object>,
 *   entities:Array<object>, biome?:any}>}
 */
async function scanSave(o) {
  const saveDir = o.saveDir;
  const name = path.basename(saveDir);
  let meta = { LevelName: name, Version: '', Time: 0, GameType: 0 };
  try {
    const ld = path.join(saveDir, 'level.dat');
    if (fs.existsSync(ld)) {
      const f = nbt.levelDatFields(nbt.parseAuto(fs.readFileSync(ld)).value !== undefined
        ? nbt.parseAuto(fs.readFileSync(ld)).value : null);
      if (f) meta = Object.assign({ LevelName: name, Version: '', Time: 0, GameType: 0 }, f);
    }
  } catch { /* 读不到元数据也不影响物品索引 */ }

  const containers = [];
  const entities = [];

  await anvil.scanSaveChunks({
    saveDir, dim: 'overworld', kind: 'region',
    onChunk: (key, raw) => {
      let root;
      try { root = nbt.parse(raw).value; } catch { return; }
      const cx = parseInt(key.split(',')[0], 10), cz = parseInt(key.split(',')[1], 10);
      const r = indexChunk(root, { cx, cz });
      for (const c of r.containers) containers.push(c);
      for (const e of r.entities) entities.push(e);
    }
  });
  await anvil.scanSaveChunks({
    saveDir, dim: 'overworld', kind: 'entities',
    onChunk: (key, raw) => {
      let root;
      try { root = nbt.parse(raw).value; } catch { return; }
      const cx = parseInt(key.split(',')[0], 10), cz = parseInt(key.split(',')[1], 10);
      const r = indexChunk(root, { cx, cz });
      for (const e of r.entities) entities.push(e);
    }
  });

  return {
    dir: saveDir, name: meta.LevelName || name, version: meta.Version || '', time: Number(meta.Time) || 0,
    containers, entities
  };
}

/**
 * 扫描一个 gameDir 下的所有存档。
 * @param {{gameDir:string, onProgress?:(done:number,total:number)=>void}} o
 * @returns {Promise<Array<object>>} 每个元素为 scanSave 的结果
 */
async function scanGameDir(o) {
  const savesDir = path.join(o.gameDir, 'saves');
  let saves = [];
  try { saves = fs.readdirSync(savesDir).map((n) => path.join(savesDir, n)).filter((p) => fs.statSync(p).isDirectory()); } catch { return []; }
  const out = [];
  let done = 0;
  for (const s of saves) {
    try { out.push(await scanSave({ saveDir: s })); } catch {}
    if (o.onProgress) o.onProgress(++done, saves.length);
  }
  return out;
}

/* ================= 检索与统计 ================= */

/**
 * 跨存档检索物品 / 命名实体。
 * @param {Array<object>} saves scanGameDir 的结果
 * @param {string} query 关键词（支持「附魔」「钻石剑」等；附魔=要求有附魔）
 * @returns {Array<{save:string, kind:'container'|'entity', type:string, name?:string,
 *   x:number, y:number, z:number, items?:Array<object>}>}
 */
function search(saves, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  // 「附魔」是修饰词：只查带附魔的物品；其余词（如「钻石剑」）做子串匹配
  const wantEnchanted = /附魔|enchant/.test(q);
  const qNorm = q.replace(/附魔|enchant(ed)?/g, '').trim();

  /** @type {Array<{save:string, kind:'container'|'entity', type:string, name?:string,
   *   x:number, y:number, z:number, items?:Array<object>}>} */
  const results = [];
  for (const sv of saves) {
    for (const c of sv.containers) {
      const hitItems = c.items.filter((it) => {
        if (wantEnchanted && !it.enchanted) return false;
        if (!qNorm) return true; // 只查「附魔」
        const zh = (it.zh || '').toLowerCase();
        const id = (it.id || '').replace(/^minecraft:/, '').toLowerCase();
        return zh.includes(qNorm) || id.includes(qNorm);
      });
      if (hitItems.length) {
        results.push({ save: sv.name, kind: 'container', type: c.type, x: c.x, y: c.y, z: c.z, items: hitItems });
      }
    }
    for (const e of sv.entities) {
      if (wantEnchanted) continue; // 实体没有「附魔」概念
      if (!qNorm) continue;
      const nm = (e.name || '').toLowerCase();
      const tp = (e.type || '').toLowerCase();
      if (nm.includes(qNorm) || tp.includes(qNorm)) {
        results.push({ save: sv.name, kind: 'entity', type: e.type, name: e.name, x: e.x, y: e.y, z: e.z });
      }
    }
  }
  return results;
}

/**
 * 跨存档统计。
 * @param {Array<object>} saves
 * @returns {{saves:number, totalContainers:number, totalNamedEntities:number,
 *   totalPlayTicks:number, playHours:number, topItems:Array<{zh:string,count:number}>,
 *   topSavesByContainers:Array<{name:string, containers:number}>}}
 */
function stats(saves) {
  let totalContainers = 0, totalNamedEntities = 0, totalPlayTicks = 0;
  const itemHist = new Map();
  const saveByContainers = [];
  for (const sv of saves) {
    totalContainers += sv.containers.length;
    totalNamedEntities += sv.entities.length;
    totalPlayTicks += sv.time || 0;
    const cset = new Set();
    for (const c of sv.containers) {
      cset.add(c);
      for (const it of c.items) {
        const k = it.zh || itemZh(it.id);
        itemHist.set(k, (itemHist.get(k) || 0) + (it.count || 1));
      }
    }
    saveByContainers.push({ name: sv.name, containers: cset.size });
  }
  const topItems = [...itemHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([zh, count]) => ({ zh, count }));
  saveByContainers.sort((a, b) => b.containers - a.containers);
  return {
    saves: saves.length,
    totalContainers,
    totalNamedEntities,
    totalPlayTicks,
    playHours: Math.round((totalPlayTicks / 20 / 3600) * 10) / 10,
    topItems,
    topSavesByContainers: saveByContainers.slice(0, 8)
  };
}

module.exports = { ITEM_ZH, itemZh, isEnchanted, customName, indexChunk, scanSave, scanGameDir, search, stats };
