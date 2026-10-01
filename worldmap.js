/**
 * 存档地图预览引擎（第二组：存档可视化与数据）。
 *
 * 不进游戏就能看到存档的俯视地图。从 region 文件读每个区块的 NBT，
 * 解码现代(1.13+)格式的「顶层方块 / 表面高度 / 生物群系」，生成区块分辨率的
 * 彩色网格，供 UI 在 Canvas 上缩放、平移、坐标定位。
 *
 * 三层：
 *   - blocks：每个区块的顶层非空气方块按类别着色（草地绿、水蓝、沙黄、石头灰…）
 *   - height：按表面高度做绿→黄→白的渐变（越高越亮）
 *   - biome ：生物群系 id 哈希成一个稳定色（群系分布一目了然）
 *
 * 设计要点：
 *   - 方块/群系都是「位打包」存在 LONG_ARRAY 里，单 long 常 > 2^53，必须用 BigInt 解码
 *     （nbt.js 现已精确返回 BigInt）。
 *   - 实体热点顺便统计（从区块 NBT 的 Entities 直接数，给「实体清理建议」打地基）。
 *   - 纯函数 analyzeChunk(root) 不碰文件，单测直接喂合成 NBT root。
 *
 * @module worldmap
 */
const anvil = require('./anvil');
const nbt = require('./nbt');

/** 空气类方块（顶块是这些时继续向下找） */
const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** 几种不需要着色的「透明/流体顶部」——水/玻璃顶会回落到下面实心块，这里只在 blocks 层特殊处理水。 */
function cleanName(name) {
  return (name || '').replace(/^minecraft:/, '');
}

/* ================= 颜色 ================= */

/** 顶层方块名 → 类别颜色（RGB）。返回 null 表示该方块不单独着色（交给高度层）。 */
function blockColor(name) {
  const n = cleanName(name);
  // 流体
  if (n === 'water' || n === 'flowing_water') return [38, 92, 170];
  if (n === 'lava' || n === 'flowing_lava') return [200, 70, 20];
  // 植被
  if (n === 'grass_block' || n === 'grass' || n === 'tall_grass' || n === 'fern' || n === 'mycelium') return [86, 148, 64];
  if (n === 'sand' || n === 'red_sand' || n === 'soul_sand' || n === 'soul_soil') return [200, 184, 120];
  if (n === 'snow' || n === 'snow_block' || n === 'powder_snow' || n.endsWith('ice') || n === 'packed_ice' || n === 'frosted_ice') return [225, 235, 240];
  if (n === 'gravel') return [150, 146, 140];
  // 石头系
  if (n === 'stone' || n === 'andesite' || n === 'diorite' || n === 'granite' || n === 'cobblestone' || n === 'bedrock') return [120, 120, 124];
  if (n === 'netherrack' || n === 'crimson_nylium' || n === 'warped_nylium' || n === 'basalt' || n === 'blackstone') return [110, 52, 52];
  if (n === 'obsidian') return [26, 18, 40];
  if (n === 'end_stone' || n === 'end_stone_bricks') return [220, 216, 156];
  // 木头/叶子
  if (n.endsWith('_log') || n.endsWith('_wood') || n === 'log' || n === 'wood') return [104, 74, 44];
  if (n.endsWith('_leaves') || n === 'leaves') return [54, 104, 46];
  // 建筑/矿石（好认的颜色，方便玩家定位据点）
  if (n === 'diamond_ore' || n === 'deepslate_diamond_ore') return [90, 200, 220];
  if (n === 'gold_ore' || n === 'deepslate_gold_ore' || n === 'nether_gold_ore') return [220, 190, 60];
  if (n === 'iron_ore' || n === 'deepslate_iron_ore') return [200, 160, 150];
  if (n === 'emerald_ore' || n === 'deepslate_emerald_ore') return [60, 200, 120];
  if (n === 'redstone_ore' || n === 'deepslate_redstone_ore' || n === 'redstone_block') return [200, 40, 40];
  if (n === 'coal_ore' || n === 'deepslate_coal_ore') return [70, 70, 74];
  if (n === 'lapis_ore' || n === 'deepslate_lapis_ore' || n === 'lapis_block') return [50, 80, 200];
  if (n === 'copper_ore' || n === 'deepslate_copper_ore') return [200, 130, 90];
  if (n.endsWith('_planks') || n.endsWith('_concrete') || n === 'concrete') return [180, 170, 150];
  if (n === 'crafting_table' || n === 'furnace' || n === 'chest' || n === 'trapped_chest' || n === 'barrel' || n === 'shulker_box') return [150, 110, 60];
  // 兜底：用名字哈希出一个稳定但不刺眼的灰蓝
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return [90 + (h % 60), 100 + ((h >> 3) % 60), 120 + ((h >> 6) % 60)];
}

/** 表面高度 → 绿(低) → 黄(中) → 白(高) 渐变。y 通常为 0..320 左右。 */
function heightColor(y) {
  const t = Math.max(0, Math.min(1, (y || 0) / 256));
  if (t < 0.5) {
    const k = t / 0.5;
    return [Math.round(60 + k * 140), Math.round(140 + k * 80), Math.round(60 + k * 40)];
  }
  const k = (t - 0.5) / 0.5;
  return [Math.round(200 + k * 35), Math.round(220 - k * 10), Math.round(100 + k * 140)];
}

/** 生物群系 id → 稳定色（哈希）。 */
function biomeColor(id) {
  const v = Number(id) || 0;
  let h = (v * 2654435761) >>> 0;
  const hue = h % 360;
  // HSL→RGB 简化（中等饱和、中高亮度），保证可分辨且不刺眼
  const c = 0.45, l = 0.62, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
  let r, g, b;
  const seg = Math.floor(hue / 60) % 6;
  if (seg === 0) { r = c; g = x; b = 0; }
  else if (seg === 1) { r = x; g = c; b = 0; }
  else if (seg === 2) { r = 0; g = c; b = x; }
  else if (seg === 3) { r = 0; g = x; b = c; }
  else if (seg === 4) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* ================= 位打包解码 ================= */

/**
 * 从 LONG_ARRAY（BigInt[]）里取第 idx 个、占 bits 位的索引值。
 * 一个 long 64 位，可能横跨两个 long。
 * @param {bigint[]} data
 * @param {number} idx
 * @param {number} bits
 * @returns {number}
 */
function packedIndex(data, idx, bits) {
  const bitOffset = idx * bits;
  const longIndex = Math.floor(bitOffset / 64);
  const bitInLong = bitOffset % 64;
  const mask = (bits >= 64) ? -1n : ((1n << BigInt(bits)) - 1n);
  // 兼容两种来源：真实区块的 data 是 BigInt[]（LONG_ARRAY），合成测试里可能是 Number[]（LIST of LONG）。
  const a = BigInt(data[longIndex] || 0n);
  let v = a >> BigInt(bitInLong);
  if (bitInLong + bits > 64) {
    const b = BigInt(data[longIndex + 1] || 0n);
    v |= b << BigInt(64 - bitInLong);
  }
  v &= mask;
  return Number(v);
}

/**
 * 区块 sections → 每列 (x,z) 的顶层非空气方块名 + 所在 Y。
 * 返回形如 { name, y } 或 null（整列全空）。
 * 支持 1.13/1.14 的 {Palette, BlockStates} 与 1.15+ 的 {block_states:{palette,data}}。
 * @param {Array<object>} sections
 * @returns {{name:string, y:number}|null}
 */
function topBlock(sections) {
  if (!Array.isArray(sections) || !sections.length) return null;
  const sorted = sections.slice().sort((a, b) => (Number(b.Y) || 0) - (Number(a.Y) || 0));
  for (const sec of sorted) {
    const Y = Number(sec.Y) || 0;
    const bs = sec.block_states || (sec.Palette ? { palette: sec.Palette, data: sec.BlockStates } : null);
    if (!bs || !Array.isArray(bs.palette) || !bs.palette.length) continue;
    const palette = bs.palette;
    const bits = palette.length <= 1 ? 0 : Math.max(4, 32 - Math.clz32(palette.length - 1));
    const data = bits === 0 ? [] : (Array.isArray(bs.data) ? bs.data : []);
    // 从最高一层的顶部找起
    for (let yLocal = 15; yLocal >= 0; yLocal--) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const i = (yLocal * 16 + z) * 16 + x;
          let name;
          if (bits === 0) name = palette[0] ? cleanName(palette[0].Name) : null;
          else name = palette[packedIndex(data, i, bits)] ? cleanName(palette[packedIndex(data, i, bits)].Name) : null;
          if (name && !AIR_NAMES.has('minecraft:' + name)) {
            return { name: 'minecraft:' + name, y: Y * 16 + yLocal };
          }
        }
      }
    }
  }
  return null;
}

/**
 * 区块根 → 生物群系 id（尽力而为）。
 * 1.15-1.17 的 Level.Biomes 是 256/1024 长度的 int 数组；1.18+ 改成了 chunk 级 packed，
 * 这里优先取第一个有意义的整数，取不到返回 null。
 * @param {object} root
 * @returns {number|null}
 */
function chunkBiome(root) {
  const lv = root.Level || root;
  const b = lv.biomes || lv.Biomes;
  if (Array.isArray(b) && b.length) {
    for (const v of b) { const n = Number(v); if (!Number.isNaN(n)) return n; }
    if (b[0] != null) return Number(b[0]);
  }
  return null;
}

/* ================= 纯函数：分析单个区块 ================= */

/**
 * 给定已解析的区块 NBT root，提取地图要素。
 * @param {object} root nbt.parse(raw).value
 * @returns {{topName:string|null, topY:number|null, biome:number|null}}
 */
function analyzeChunk(root) {
  if (!root || typeof root !== 'object') return { topName: null, topY: null, biome: null };
  const lv = root.Level || root;
  const tb = topBlock(lv.Sections);
  return {
    topName: tb ? tb.name : null,
    topY: tb ? tb.y : null,
    biome: chunkBiome(root)
  };
}

/* ================= 扫描存档 ================= */

/**
 * 扫描一个存档，生成区块分辨率地图。
 * @param {{saveDir:string, dim?:string, layer?:'blocks'|'height'|'biome', onProgress?:(done:number,total:number)=>void, entityThreshold?:number}} o
 * @returns {Promise<{bounds:{minCx:number,minCz:number,maxCx:number,maxCz:number},
 *   cells:Array<{cx:number,cz:number,topY:number|null,topName:string|null,biome:number|null,
 *     cBlocks:number[],cHeight:number[],cBiome:number[]}>,
 *   entityHotspots:Array<{cx:number,cz:number,count:number}>, entityMax:number}>}
 */
async function scan(o) {
  const layer = o.layer || 'blocks';
  /** @type {Array<object>} */
  const cells = [];
  let minCx = Infinity, minCz = Infinity, maxCx = -Infinity, maxCz = -Infinity;
  const hotspots = [];
  let entityMax = 0;
  const thr = o.entityThreshold != null ? o.entityThreshold : 80;

  await anvil.scanSaveChunks({
    saveDir: o.saveDir,
    dim: o.dim || 'overworld',
    onProgress: o.onProgress,
    onChunk: (key, raw) => {
      const cx = parseInt(key.split(',')[0], 10);
      const cz = parseInt(key.split(',')[1], 10);
      let root = null;
      try { root = nbt.parse(raw).value; } catch { /* 损坏区块跳过 */ }
      const a = root ? analyzeChunk(root) : { topName: null, topY: null, biome: null };
      // 实体计数：region 区块的实体在 Level.Entities（1.18+ 独立的 entities 文件在根级 Entities）。
      // nbt.countEntities 只数根级 Entities，对 region 区块会漏掉，这里直接从已解析 root 数。
      let ents = 0;
      try {
        const lv = root ? (root.Level || root) : null;
        const arr = (lv && Array.isArray(lv.Entities)) ? lv.Entities
          : (root && Array.isArray(root.Entities) ? root.Entities : []);
        ents = arr.length;
      } catch {}
      if (ents > entityMax) entityMax = ents;
      if (ents >= thr) hotspots.push({ cx, cz, count: ents });
      const cBlocks = a.topName ? blockColor(a.topName) : [20, 22, 28];
      const cHeight = heightColor(a.topY);
      const cBiome = a.biome != null ? biomeColor(a.biome) : [40, 42, 50];
      cells.push({
        cx, cz, topY: a.topY, topName: a.topName, biome: a.biome,
        cBlocks, cHeight, cBiome
      });
      if (cx < minCx) minCx = cx; if (cz < minCz) minCz = cz;
      if (cx > maxCx) maxCx = cx; if (cz > maxCz) maxCz = cz;
    }
  });

  if (!cells.length) {
    return { bounds: { minCx: 0, minCz: 0, maxCx: 0, maxCz: 0 }, cells: [], entityHotspots: [], entityMax: 0 };
  }
  // 把当前图层颜色提到顶层，方便 UI 直接取（仍保留三色供切换）
  return { bounds: { minCx, minCz, maxCx, maxCz }, cells, entityHotspots: hotspots, entityMax };
}

/**
 * 列出存档下某维度已存在的 region 文件（给 UI 显示覆盖范围）。
 * @param {{saveDir:string, dim?:string}} o
 * @returns {Array<{rx:number, rz:number, file:string}>}
 */
function regionOverview(o) {
  const fs = require('fs');
  const dir = anvil.dataDir(o.saveDir, o.dim || 'overworld', 'region');
  if (!fs.existsSync(dir)) return [];
  return anvil.listRegionFiles(dir);
}

module.exports = { analyzeChunk, topBlock, blockColor, heightColor, biomeColor, packedIndex, scan, regionOverview };
