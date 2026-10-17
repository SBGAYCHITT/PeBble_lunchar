// Pebble Lunchar - 方块状态解码（V5 第一组：世界版本控制完整版）
//
// 为什么单独成模块：
//   「从打包数组里取第 i 个索引、再查调色板拿到方块名」这段逻辑，
//   方块级 blame、时间轴回放、地图预览三处都要用。分散实现的下场是各修各的 bug，
//   而这里的 bug 是**静默给错方块** —— 不报错、不崩溃、方块看着像模像样，其实整体错位。
//
// ⚠️ 位打包在 1.16（20w17a）变过一次，这是本模块存在的首要理由：
//   · ≤1.15.2：索引**可以跨 long 边界**。4096 个索引连续占位，一个索引的后半截
//              接在下一个 long 的最低位，没有填充。
//   · ≥1.16  ：索引**不允许跨 long**。一个 long 放不下第 n 个索引就从下一个 long 的
//              最低位重新开始，高位直接浪费。
//   5 bits 时两者完全不同：前者每 long 挤 12 个索引、第 13 个跨边界；
//   后者每 long 放 12 个索引、剩 4 位填充，第 13 个从下一个 long 的第 0 位开始。
//   用错解码器读 5/6/7/9/10/11/12 bits 的区块，读出来的下标**全都落在调色板范围内**，
//   于是查得到一个合法的方块名 —— 错得毫无征兆。tests/blockstate.test.js 里专门有一条
//   用例断言这两种打包对同一份 data 必须解出不同结果，防止有人"顺手合并"成一个函数。
//
// ⚠️ 1.18 把 `Level.Sections` 拍平成顶层 `sections`（小写），且 y 可以为负（-4 起）。
//   只认 `Sections` 的读法在 1.18+ 存档上拿到的是 undefined —— 地图会整片空掉，
//   而且不报任何错。所以下面 section 的查找是**多键探测**，不假设单一布局。
//
// 怎么判断一段 data 用的是哪种打包（不靠 DataVersion 猜）：
//   2566 = 1.16 正式版，位打包在这一版改成不跨 long。但**不能只信 DataVersion**：
//   快照版本夹在两个正式版之间、第三方工具写的 data 会谎报、手工改过的区块更是没谱。
//   于是这里用两个**从数据本身就能看出来**的判据，按可信度排序：
//     ① long 个数。bits 不整除 64 时两种布局需要的 long 数不同，而且差得很明显 ——
//        1.16 的更新日志就写了 5 bits 时从 320 个 long 变成 342 个。这是最硬的判据。
//     ② 填充位是否全零。填充打包是往一个全零的 long 数组里 OR 进去的，尾部浪费的
//        高位必然是 0；交叉打包连续占位，那些位几乎不可能是 0。
//   两个都判不出来（比如调用方给了长度不对的数据）才退回 DataVersion。
//
//   曾经想用「解出来的下标有没有越界」当判据 —— 实测**不可靠**：5 bits 时用错解码器
//   读出来的下标仍然全部落在调色板范围内（高位来自填充零、低位来自邻接 long），
//   越界数为 0。靠它判断等于没判断。tests/blockstate.test.js 里有对应用例钉死这点。
//
// @module blockstate

const nbt = require('./nbt');

/** 1.16 正式版 DataVersion：位打包从此不跨 long */
const DV_PADDED_PACKING = 2566;

/** 空气类方块。顶块是这些时地图要继续往下找。 */
const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** 调色板条目可能是字符串（全默认方块状态的简写）或 {Name, Properties} 复合标签 */
function isAirName(name) { return AIR_NAMES.has(name); }

/* ================= 位打包 ================= */

/** 一个 long 的 64 位全 1 掩码。BigInt 的 & 是有符号语义，取无符号视图必须靠它。 */
const M64 = (1n << 64n) - 1n;

/** bits 位的掩码 */
function maskOf(bits) { return bits >= 64 ? -1n : ((1n << BigInt(bits)) - 1n); }

/** LONG_ARRAY 由 nbt.js 解成 BigInt[]；合成测试里可能是 Number[]，一律抬成 BigInt */
function wordOf(data, i) {
  const v = data[i];
  if (v === undefined || v === null) return 0n;
  return typeof v === 'bigint' ? v : BigInt(v);
}

/**
 * 交叉打包（≤1.15.2）：索引可以跨 long 边界，全体连续占位。
 * @param {Array<bigint|number>} data
 * @param {number} idx
 * @param {number} bits
 * @returns {number}
 */
function packedIndexCrossing(data, idx, bits) {
  if (bits <= 0) return 0;
  const bitOffset = idx * bits;
  const li = Math.floor(bitOffset / 64);
  const off = bitOffset % 64;
  // ⚠️ 跨 long 时，从本字移进来的那一段必须**先掩掉高位**，再拼下一个字。
  //    wordOf 是 readBigInt64BE 出来的**有符号**值，而 BigInt 的 >> 是**算术**右移 ——
  //    高位为 1 时会补一串 1。那一串 1 恰好落在"本应由下一个 long 填充"的位上，
  //    一旦参与后面的 `|` 就把结果污染了，而最后那句 `& maskOf(bits)` 拦不住
  //   （它只看结果位，看不出这一位是本字补进来的还是下一个字给的）。
  //    只在 off + bits > 64 时才有这个问题 —— 也正因如此，4 bit / 8 bit（off 永远是 4 的倍数，
  //    到不了 63）一直表现正常，5 bit、6 bit 这些才会踩到。
  let v = (wordOf(data, li) >> BigInt(off)) & maskOf(64 - off);
  if (off + bits > 64) v |= wordOf(data, li + 1) << BigInt(64 - off);
  return Number(v & maskOf(bits));
}

/**
 * 填充打包（≥1.16）：索引不允许跨 long，放不下就换下一个 long，高位浪费。
 *
 * 注意 per 必须用 64/bits 的**下取整**：bits 不整除 64 时，每个 long 尾部
 * 都会浪费掉 64 % bits 位。写成 `Math.ceil(64/bits)` 会把填充位当成索引位。
 * @param {Array<bigint|number>} data
 * @param {number} idx
 * @param {number} bits
 * @returns {number}
 */
function packedIndexPadded(data, idx, bits) {
  if (bits <= 0) return 0;
  const per = Math.floor(64 / bits);
  if (per <= 0) return 0;
  const li = Math.floor(idx / per);
  const off = (idx % per) * bits;
  return Number((wordOf(data, li) >> BigInt(off)) & maskOf(bits));
}

/**
 * 历史名：等价于**交叉**打包，保持既有调用点（worldmap 旧代码 / 单测）语义不变。
 * @param {Array<bigint|number>} data
 * @param {number} idx
 * @param {number} bits
 */
function packedIndex(data, idx, bits) { return packedIndexCrossing(data, idx, bits); }

/** 调色板长度 → 每个索引占多少位（下限 4 位；只有一个条目时不需要 data） */
function bitsFor(paletteLen) { return bitsForCount(paletteLen, 4); }

/**
 * 调色板长度 → 位宽，指定位数下限。
 * 方块状态的下限是 4 位，生物群系没有下限（调色板可能只有 1~2 个群系，1 位就够）。
 * @param {number} paletteLen
 * @param {number} minBits
 */
function bitsForCount(paletteLen, minBits) {
  if (paletteLen <= 1) return 0;
  return Math.max(minBits, 32 - Math.clz32(paletteLen - 1));
}

/** bits 位宽下，两种打包各自需要多少个 long */
function longCount(bits, total) {
  if (bits <= 0) return { padded: 0, crossing: 0, identical: true };
  const per = Math.floor(64 / bits);
  return {
    padded: Math.ceil(total / per),
    crossing: Math.ceil(total * bits / 64),
    identical: per * bits === 64
  };
}

/**
 * 填充位是否全为零（填充打包的必要特征）。
 * BigInt 的 `&` 按无限符号位的二进制补码运算，所以负的 long 与 M64 相与会得到
 * 正确的无符号视图 —— nbt.js 的 LONG_ARRAY 是 readBigInt64BE，高位为 1 时是负数。
 * @param {Array<bigint|number>} data
 * @param {number} bits
 */
function paddingBitsAllZero(data, bits) {
  const per = Math.floor(64 / bits);
  if (per * bits === 64 || per <= 0) return true;   // 没有填充位，无从判断
  const shift = BigInt(per * bits);
  for (let li = 0; li < data.length; li++) {
    if (((wordOf(data, li) & M64) >> shift) !== 0n) return false;
  }
  return true;
}

/**
 * 从数据本身判断打包方式。
 * @param {Array<bigint|number>} data
 * @param {number} bits
 * @param {number} dv DataVersion（0 表示未知）
 * @param {number} total 这个容器里有多少个条目（方块 4096、生物群系 64）
 * @returns {boolean} true = 交叉打包（≤1.15.2）
 */
function detectPacking(data, bits, dv, total) {
  const n4096 = total || 4096;
  const cnt = longCount(bits, n4096);
  if (cnt.identical) return dv ? dv < DV_PADDED_PACKING : false;   // 两种布局一模一样
  const n = Array.isArray(data) ? data.length : 0;
  // ① long 个数：只要和其中一种精确吻合、和另一种不吻合，就定了
  if (n === cnt.padded && n !== cnt.crossing) return false;
  if (n === cnt.crossing && n !== cnt.padded) return true;
  // ② 填充位（只在两种长度都判不出来时才有意义）
  if (paddingBitsAllZero(data, bits)) return false;
  if (dv) return dv < DV_PADDED_PACKING;
  return true;
}

/**
 * 通用：把一个调色板容器解成 count 个下标。
 * @param {{palette:Array, data:Array|null}} c
 * @param {number} dv
 * @param {number} count
 * @param {number} minBits
 * @returns {{idx:Int32Array, crossing:boolean}}
 */
function decodeIndices(c, dv, count, minBits) {
  const bits = bitsForCount(c.palette.length, minBits);
  const out = new Int32Array(count);
  if (bits === 0) { out.fill(0); return { idx: out, crossing: false }; }
  const data = c.data || [];
  const crossing = detectPacking(data, bits, dv, count);
  if (crossing) for (let i = 0; i < count; i++) out[i] = packedIndexCrossing(data, i, bits);
  else for (let i = 0; i < count; i++) out[i] = packedIndexPadded(data, i, bits);
  return { idx: out, crossing };
}

/* ================= 打包（写入端） ================= */

/**
 * 64 位无符号视图 → 有符号 BigInt。
 *
 * 必须做这一步：nbt 的 LONG_ARRAY 走 writeBigInt64BE，它只接受 [-2^63, 2^63-1]。
 * 打包出来高位为 1 的 long（无符号看是 0xFFFF...）直接丢进去会抛 ERR_OUT_OF_RANGE，
 * 而报错地点离"我打包了个 long 数组"很远，很容易查半天。
 * 解码侧不需要这层对称处理 —— packedIndex* 里的 `& maskOf(bits)` 会把符号位掩掉。
 * @param {bigint} v
 * @returns {bigint}
 */
function toSigned64(v) {
  const u = v & M64;
  return u >= (1n << 63n) ? u - (1n << 64n) : u;
}

/**
 * 下标序列 → long 数组，是 packedIndexCrossing / packedIndexPadded 的逆。
 *
 * 两条路都必须**严格互逆**，所以单测用「对拍」验证（随机序列 encode 再 decode 逐位相等），
 * 而不是两边各测各的 —— 各测各的抓不到"两个函数刚好都错、而且错得一致"这种最坏情况。
 *
 * @param {ArrayLike<number>} idx
 * @param {number} bits
 * @param {boolean} crossing true = 跨 long（≤1.15.2）；false = 填充（≥1.16）
 * @returns {bigint[]} 可直接交给 nbt 的 LONG_ARRAY 写出去
 */
function encodeIndices(idx, bits, crossing) {
  const n = idx.length;
  if (bits <= 0 || n === 0) return [];
  const per = Math.floor(64 / bits);
  const words = new Array(crossing ? Math.ceil(n * bits / 64) : Math.ceil(n / per)).fill(0n);
  for (let i = 0; i < n; i++) {
    const v = BigInt(idx[i]) & maskOf(bits);
    if (crossing) {
      const bitOffset = i * bits;
      const li = Math.floor(bitOffset / 64);
      const off = bitOffset % 64;
      words[li] = (words[li] | ((v << BigInt(off)) & M64)) & M64;
      if (off + bits > 64) {
        words[li + 1] = (words[li + 1] | (v >> BigInt(64 - off))) & M64;
      }
    } else {
      const li = Math.floor(i / per);
      const off = (i % per) * bits;
      words[li] = (words[li] | (v << BigInt(off))) & M64;
    }
  }
  return words.map(toSigned64);
}

/** 完整状态名 → 调色板条目：`minecraft:oak_stairs[facing=north]` → {Name, Properties} */
function entryFromName(name) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(name == null ? '' : name));
  if (!m) return { Name: String(name) };
  if (!m[2]) return { Name: m[1] };
  const props = {};
  for (const kv of m[2].split(',')) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    props[kv.slice(0, eq)] = kv.slice(eq + 1);   // 属性值在 NBT 里永远是字符串
  }
  return { Name: m[1], Properties: props };
}

/**
 * 算出一个 section 改过若干格之后的完整方块状态。
 *
 * 为什么必须**整段重编码**、没有"只改几个 long"的捷径：
 * 往调色板里加一个条目就可能把位宽从 5 抬到 6，bits 一变，long 数组的长度和
 * 每个下标的落位全变。与其做局部修补，不如解出来、改完、重新打包。
 *
 * 注意位宽变化时**打包方式不跟着变**：跨 long / 填充是版本属性（1.16 的分水岭），
 * 由 DataVersion 决定，和位宽无关。
 *
 * 纯函数：不修改传入的 section，把结果交给调用方去写（这样类型旁路表的登记
 * 留在调用方手里，blockstate 不需要认识 nbt）。
 *
 * @param {object} sec
 * @param {number} dv DataVersion
 * @param {Map<number, string>} edits 局部下标（0..4095，`y*256 + z*16 + x`）→ 完整状态名
 * @returns {{ok:boolean, reason:string, changed:number,
 *            palette:Array|null, data:bigint[]|null, bits:number, crossing:boolean}}
 */
function applyBlockEdits(sec, dv, edits) {
  const c = containerOf(sec);
  if (!c) return { ok: false, reason: '这个区段没有方块状态容器（史前字节格式不支持）', changed: 0, palette: null, data: null, bits: 0, crossing: false };

  const entries = c.palette.slice();
  const names = entries.map((e) => entryName(e));
  /** @type {Map<string, number>} */
  const index = new Map();
  for (let i = 0; i < names.length; i++) if (!index.has(names[i])) index.set(names[i], i);

  const oldBits = bitsForCount(entries.length, 4);
  const dec = decodeIndices(c, dv, 4096, 4);
  const idx = dec.idx;

  let changed = 0;
  for (const [local, name] of edits) {
    if (!(local >= 0 && local < 4096)) continue;
    let pi = index.get(name);
    if (pi === undefined) {
      pi = entries.length;
      entries.push(entryFromName(name));
      names.push(name);
      index.set(name, pi);
    }
    if (idx[local] !== pi) { idx[local] = pi; changed++; }
  }
  if (!changed) {
    return { ok: true, reason: '', changed: 0, palette: null, data: null, bits: oldBits, crossing: dec.crossing };
  }

  const bits = bitsForCount(entries.length, 4);
  // 原来没有 data（单色区段）时检测不出打包方式，只能按版本判
  const crossing = (oldBits === 0 || !c.data || c.data.length === 0)
    ? (dv ? dv < DV_PADDED_PACKING : false)
    : dec.crossing;
  return { ok: true, reason: '', changed, palette: entries, data: encodeIndices(idx, bits, crossing), bits, crossing };
}

/* ================= 方块层面的判据（合并时要用） ================= */

/** 剥掉属性后缀：`minecraft:oak_stairs[facing=north]` → `minecraft:oak_stairs` */
function baseName(name) {
  if (!name) return '';
  return String(name).replace(/\[[^\]]*\]$/, '');
}

/**
 * 会挡不住光 / 不参与表面高度图的方块。判据**保守**：不确定的一律当"会变"。
 *
 * 保守的方向是有意的：判成"会变"只是少自动合流一次（退回整块取一侧，用户看得见）；
 * 判成"不会变"却会让存档里留下一片亮度和实际不符的区块，而且**不报错**。
 *
 * 默认"是实心"也是有意的：Minecraft 里绝大多数方块是不透明完整方块，
 * 反过来列白名单会漏掉 crafting_table / furnace / bookshelf / pumpkin 这类日常方块。
 */
const NON_OPAQUE_SUFFIX = [
  '_glass', '_glass_pane', '_leaves', '_slab', '_stairs', '_fence', '_fence_gate',
  '_wall', '_door', '_trapdoor', '_carpet', '_torch', '_lantern', '_candle',
  '_ladder', '_sign', '_banner', '_button', '_lever', '_pressure_plate', '_rail',
  '_sapling', '_flower', '_bud', '_vine', '_roots', '_sprouts', '_fern', '_bush',
  '_coral', '_anvil', '_chain', '_bars', '_pane', '_scaffolding', '_air'
];
const NON_OPAQUE_EXACT = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air',
  'minecraft:water', 'minecraft:lava', 'minecraft:ice', 'minecraft:frosted_ice',
  'minecraft:snow', 'minecraft:powder_snow', 'minecraft:fire', 'minecraft:soul_fire',
  'minecraft:cobweb', 'minecraft:vine', 'minecraft:lily_pad', 'minecraft:seagrass',
  'minecraft:kelp', 'minecraft:bamboo', 'minecraft:sugar_cane', 'minecraft:cactus',
  'minecraft:torch', 'minecraft:lantern', 'minecraft:campfire', 'minecraft:flower_pot',
  'minecraft:end_portal', 'minecraft:nether_portal', 'minecraft:end_gateway',
  'minecraft:light', 'minecraft:barrier', 'minecraft:structure_void',
  'minecraft:moving_piston', 'minecraft:piston_head', 'minecraft:spawner',
  'minecraft:bell', 'minecraft:cake', 'minecraft:brewing_stand', 'minecraft:cauldron',
  /* 这几个名字本身就是裸名，"endsWith('_glass')" 之类的后缀规则匹配不到 */
  'minecraft:glass', 'minecraft:leaves'
]);

/**
 * 这一格是不是"不透明完整方块"。判不出来的一律当**是**（理由见上面）。
 * @param {string} name 完整状态名或裸名
 * @returns {boolean}
 */
function isOpaque(name) {
  const n = baseName(name);
  if (!n) return true;
  if (NON_OPAQUE_EXACT.has(n)) return false;
  const bare = n.replace(/^minecraft:/, '');
  for (const suf of NON_OPAQUE_SUFFIX) if (bare.endsWith(suf)) return false;
  return true;
}

/**
 * 需要方块实体才能承载数据的方块：箱子里的物品、告示牌上的字、刷怪笼的内容…
 *
 * 合并只处理"方块"这一层，碰到这些方块就没法把方块实体一起合过来 ——
 * 硬合的结果是**箱子变空、告示牌变白**。这种静默丢数据比"光照过时"严重得多，
 * 所以碰到它们直接拒绝自动合流，让上层退回"整块取一侧"并说明原因。
 *
 * 同样保守：认不出来的一律当"需要"，代价只是少合流一次。
 */
const NEEDS_BE_SUFFIX = ['_shulker_box', '_sign', '_hanging_sign', '_banner', '_head', '_skull', '_bed', '_chest'];
const NEEDS_BE_EXACT = new Set([
  'minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel', 'minecraft:furnace',
  'minecraft:blast_furnace', 'minecraft:smoker', 'minecraft:hopper', 'minecraft:dispenser',
  'minecraft:dropper', 'minecraft:brewing_stand', 'minecraft:beacon', 'minecraft:conduit',
  'minecraft:enchanting_table', 'minecraft:jukebox', 'minecraft:lectern', 'minecraft:spawner',
  'minecraft:mob_spawner', 'minecraft:end_portal', 'minecraft:end_gateway', 'minecraft:nether_portal',
  'minecraft:end_portal_frame', 'minecraft:bee_nest', 'minecraft:beehive', 'minecraft:campfire',
  'minecraft:soul_campfire', 'minecraft:sculk_sensor', 'minecraft:calibrated_sculk_sensor',
  'minecraft:sculk_shrieker', 'minecraft:sculk_catalyst', 'minecraft:chiseled_bookshelf',
  'minecraft:decorated_pot', 'minecraft:vault', 'minecraft:trial_spawner', 'minecraft:creaking_heart',
  'minecraft:barrier', 'minecraft:light', 'minecraft:structure_block', 'minecraft:jigsaw',
  'minecraft:command_block', 'minecraft:chain_command_block', 'minecraft:repeating_command_block',
  'minecraft:structure_void', 'minecraft:flower_pot', 'minecraft:bell', 'minecraft:comparator',
  'minecraft:repeater', 'minecraft:piston', 'minecraft:sticky_piston', 'minecraft:moving_piston',
  'minecraft:piston_head', 'minecraft:cauldron', 'minecraft:cake'
]);

/**
 * 这个方块是不是方块实体载体。
 * @param {string} name
 * @returns {boolean}
 */
function needsBlockEntity(name) {
  const n = baseName(name);
  if (!n) return false;
  if (NEEDS_BE_EXACT.has(n)) return true;
  const bare = n.replace(/^minecraft:/, '');
  for (const suf of NEEDS_BE_SUFFIX) if (bare.endsWith(suf)) return true;
  return false;
}

/**
 * 把 applyBlockEdits 的结果写回 section，并**登记 nbt 的类型旁路表**。
 *
 * 这一步必须由懂 NBT 类型的人来做：`data` 在 JS 里就是一个普通数组，
 * 直接换一个新数组，nbt 的写入端会把它当成 LIST of LONG 写出去 —— 非法区块。
 * 所以优先**原地换内容**（同一个数组对象，表里还认得），没有原数组时才新建并显式登记。
 *
 * @param {object} sec section 节点（就地修改）
 * @param {{palette:Array|null, data:bigint[]|null}} res applyBlockEdits 的结果
 * @param {{comp:WeakMap,list:WeakMap,node:WeakMap}} [types] nbt.newTypes() 的产物
 * @returns {boolean} 是否真的写了
 */
function writeBlockStates(sec, res, types) {
  if (!res || !res.data) return false;
  const bs = sec.block_states || sec.blockStates;
  const holder = bs || sec;
  const paletteKey = bs ? 'palette' : 'Palette';
  const dataKey = bs ? 'data' : 'BlockStates';

  if (res.palette) {
    const cur = holder[paletteKey];
    if (Array.isArray(cur)) {
      cur.length = 0;
      for (const e of res.palette) cur.push(e);
    } else {
      holder[paletteKey] = res.palette;
      if (types) { types.node.set(res.palette, nbt.T.LIST); types.list.set(res.palette, nbt.T.COMPOUND); }
    }
  }

  const cur = holder[dataKey];
  if (Array.isArray(cur)) {
    cur.length = 0;
    for (const v of res.data) cur.push(v);
  } else {
    holder[dataKey] = res.data;
    if (types) types.node.set(res.data, nbt.T.LONG_ARRAY);
  }
  return true;
}

/* ================= section 定位 ================= */

/**
 * 取出区块里的 section 列表。**多键探测**，不假设单一布局：
 *   1.18+ : root.sections（小写，Level 已被拍平）
 *   ≤1.17 : root.Level.Sections
 * 另外兼容 Level.sections / root.Sections 这两种非官方但见过的写法。
 * @param {object} root nbt.parse(raw).value
 * @returns {Array<object>}
 */
function sectionsOf(root) {
  if (!root || typeof root !== 'object') return [];
  const lv = root.Level && typeof root.Level === 'object' ? root.Level : null;
  const cands = [root.sections, lv && lv.Sections, lv && lv.sections, root.Sections];
  for (const c of cands) if (Array.isArray(c) && c.length) return c;
  return [];
}

/** 取区块的 DataVersion（拿不到返回 0） */
function dataVersionOf(root) {
  if (!root || typeof root !== 'object') return 0;
  const lv = root.Level && typeof root.Level === 'object' ? root.Level : null;
  const v = Number(root.DataVersion != null ? root.DataVersion
    : (lv && lv.DataVersion != null ? lv.DataVersion : 0));
  return Number.isFinite(v) ? v : 0;
}

/**
 * 拿一个 section 的调色板与索引数组。
 *
 * 认这些写法：
 *   · block_states / blockStates（1.16+ 与部分 1.15 工具导出）
 *   · Palette + BlockStates（1.13~1.15）
 * 返回 null 表示这个 section 用的是**全局方块 ID + 字节数组**的史前格式（≤1.12）。
 * 那种格式需要一张 4096 项的 ID→名字表，本启动器不支持，交给调用方显式降级，
 * 而不是硬猜一个方块名。
 * @param {object} sec
 * @returns {{palette:Array, data:Array|null}|null}
 */
function containerOf(sec) {
  if (!sec || typeof sec !== 'object') return null;
  const bs = sec.block_states || sec.blockStates;
  if (bs && typeof bs === 'object' && Array.isArray(bs.palette)) {
    return { palette: bs.palette, data: Array.isArray(bs.data) ? bs.data : null };
  }
  if (Array.isArray(sec.Palette)) {
    const d = sec.BlockStates || sec.Data;
    return { palette: sec.Palette, data: Array.isArray(d) ? d : null };
  }
  return null;
}

/* ================= 调色板条目 → 方块名 ================= */

/**
 * 调色板条目 → 规范化方块名，形如 `minecraft:oak_stairs[facing=north,half=bottom]`。
 *
 * 属性按**键名排序**输出：同一个方块状态无论在存档里怎么写，名字必须逐字节可比，
 * 否则 blame 会把"只改了属性书写顺序"当成一次改动。
 * @param {object|string} entry
 * @returns {string|null}
 */
function entryName(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') return entry.includes(':') ? entry : 'minecraft:' + entry;
  const name = entry.Name != null ? String(entry.Name) : (entry.name != null ? String(entry.name) : null);
  if (!name) return null;
  const full = name.includes(':') ? name : 'minecraft:' + name;
  const props = entry.Properties || entry.properties;
  if (!props || typeof props !== 'object') return full;
  const keys = Object.keys(props).sort();
  if (!keys.length) return full;
  return full + '[' + keys.map((k) => k + '=' + props[k]).join(',') + ']';
}

/* ================= 单点读取 ================= */

/**
 * 解出 section 内的 4096 个调色板下标。
 * 打包方式由 detectPacking 从数据本身判断（long 个数 → 填充位 → 最后才看 DataVersion）。
 * @param {{palette:Array, data:Array|null}} c
 * @param {number} dv DataVersion
 * @returns {{idx:Int32Array, crossing:boolean}}
 */
function decodeContainer(c, dv) { return decodeIndices(c, dv, 4096, 4); }

/** section 的绝对 Y（section 索引 → 最低方块 y） */
function sectionBaseY(sec) { return (Number(sec.Y) || 0) * 16; }

/**
 * 读某个绝对坐标上的方块状态。
 * @param {object} root nbt.parse(raw).value
 * @param {number} x 方块绝对 x
 * @param {number} y 方块绝对 y
 * @param {number} z 方块绝对 z
 * @returns {string|null} 方块名；坐标不在任何 section 里返回 null
 */
function blockAt(root, x, y, z) {
  const secs = sectionsOf(root);
  if (!secs.length) return null;
  const lx = ((Math.trunc(x) % 16) + 16) % 16;
  const lz = ((Math.trunc(z) % 16) + 16) % 16;
  const yy = Math.trunc(y);
  for (const sec of secs) {
    const base = sectionBaseY(sec);
    if (yy < base || yy >= base + 16) continue;
    const c = containerOf(sec);
    if (!c) return null;                 // 史前字节格式：显式不支持
    const { idx } = decodeContainer(c, dataVersionOf(root));
    const ly = yy - base;
    const i = (ly * 16 + lz) * 16 + lx;  // 顺序：y → z → x
    return entryName(c.palette[idx[i]]);
  }
  return null;
}

/**
 * 取一个水平层（固定 y）的 16×16 方块名，索引 `[z*16 + x]`。
 * 时间轴回放就是把这个结果丢给渲染层画一张俯视切片。
 * @param {object} root
 * @param {number} y
 * @returns {Array<string|null>|null} 该 y 不在任何 section 里时返回 null
 */
function layerAt(root, y) {
  const secs = sectionsOf(root);
  const yy = Math.trunc(y);
  for (const sec of secs) {
    const base = sectionBaseY(sec);
    if (yy < base || yy >= base + 16) continue;
    const c = containerOf(sec);
    if (!c) return null;
    const { idx } = decodeContainer(c, dataVersionOf(root));
    const ly = yy - base;
    const out = new Array(256);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        out[z * 16 + x] = entryName(c.palette[idx[(ly * 16 + z) * 16 + x]]);
      }
    }
    return out;
  }
  return null;
}

/**
 * 取某个 section 的生物群系容器（1.18+ 为 `biomes`，形状与 block_states 一致）。
 * 1.15~1.17 的 Level.Biomes 是扁平的 int 数组，不算容器，这里返回 null。
 * @param {object} sec
 * @returns {{palette:Array, data:Array|null}|null}
 */
function biomeContainerOf(sec) {
  const b = sec && (sec.biomes || sec.Biomes);
  if (b && typeof b === 'object' && !Array.isArray(b) && Array.isArray(b.palette)) {
    return { palette: b.palette, data: Array.isArray(b.data) ? b.data : null };
  }
  return null;
}

/**
 * 读某个绝对 y 所在 section 的**生物群系名**。
 *
 * 1.18+ 的生物群系调色板里存的是 resource location 字符串（`minecraft:plains`），
 * 不再是数字 id —— 所以这里返回名字，由调用方去决定怎么显示。
 * 群系以 4×4×4 为一个单元，一个 section 只有 64 个单元；这里取单元 (0,0,0)，
 * 也就是该层左下角的群系。地图预览本来就是"每个区块一个颜色"的粗粒度近似，
 * 取哪个单元都只是代表值，取固定单元至少保证**同一份数据每次都得到同一个结果**。
 * @param {object} root
 * @param {number} y
 * @returns {string|null}
 */
function biomeNameAt(root, y) {
  const secs = sectionsOf(root);
  const yy = Math.trunc(y);
  const dv = dataVersionOf(root);
  for (const sec of secs) {
    const base = sectionBaseY(sec);
    if (yy < base || yy >= base + 16) continue;
    const c = biomeContainerOf(sec);
    if (!c || !c.palette.length) return null;
    const { idx } = decodeIndices(c, dv, 64, 0);
    return entryName(c.palette[idx[0]]);
  }
  return null;
}

/**
 * 顶层非空气方块（地图预览用）。从最高的 section 往下找。
 * @param {object} root
 * @returns {{name:string, y:number}|null}
 */
function topBlock(root) {
  const secs = sectionsOf(root).slice()
    .sort((a, b) => (Number(b.Y) || 0) - (Number(a.Y) || 0));
  for (const sec of secs) {
    const base = sectionBaseY(sec);
    const c = containerOf(sec);
    if (!c || !c.palette.length) continue;
    const { idx } = decodeContainer(c, dataVersionOf(root));
    for (let ly = 15; ly >= 0; ly--) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const name = entryName(c.palette[idx[(ly * 16 + z) * 16 + x]]);
          if (name && !isAirName(name)) return { name, y: base + ly };
        }
      }
    }
  }
  return null;
}

/**
 * 这个区块能不能做方块级读取。
 * 用来给 UI 一句诚实的理由，而不是"blame 出来是空的"。
 * @param {object} root
 * @returns {{ok:boolean, reason:string}}
 */
function supportLevel(root) {
  const secs = sectionsOf(root);
  if (!secs.length) return { ok: false, reason: '区块里没有 section（空区块或格式不认识）' };
  for (const sec of secs) if (!containerOf(sec)) {
    return { ok: false, reason: '这是 1.12 及更早的全局方块 ID 格式，需要方块 ID 映射表，暂不支持方块级读取' };
  }
  return { ok: true, reason: '' };
}

module.exports = {
  DV_PADDED_PACKING, AIR_NAMES,
  isAirName, maskOf, bitsFor, bitsForCount, longCount, paddingBitsAllZero, detectPacking,
  packedIndex, packedIndexCrossing, packedIndexPadded,
  toSigned64, encodeIndices, entryFromName, applyBlockEdits, writeBlockStates,
  baseName, isOpaque, needsBlockEntity,
  sectionsOf, dataVersionOf, containerOf, biomeContainerOf, sectionBaseY,
  entryName, decodeContainer, decodeIndices,
  blockAt, layerAt, topBlock, biomeNameAt, supportLevel,
  /* nbt 由本模块独占依赖，导出只为让单测少 require 一次 */
  _nbt: nbt
};
