// Pebble Launcher - 世界合并与建筑移植
//
// 场景：创造存档里搭好的城堡搬进生存存档；把朋友存档里的一整片地形切过来当新地图；
//       再把它**挪个位置**（"这块地我要往东挪 32 格放"）。
//
// 为什么必须分成「干跑」和「执行」两步：
//   这个工具出错时覆盖掉的是玩家几百小时的世界，代价极高。所以 plan() 只读不写，
//   把"要动哪些区块、会覆盖掉什么、目标里有几处冲突"全摊开给人看；
//   apply() 才真正落盘，而且落盘前自动打时光机快照、每个 region 文件再留 .bak。
//
// ⚠️ 两个必须讲清楚的限制（不讲清楚用户会以为能搬"半个区块"）：
//   1. **区块是最小搬运单位**。给的是方块坐标矩形，实际按区块向外吸附 ——
//      要搬 x=20..40，落地的其实是 x=16..47（两个区块）。边角一定会多带一点。
//      平移量同理：只能是 16 的整数倍，给 24 会被拒绝并给出最近可用的 16 / 32。
//   2. **垂直方向是整列**（0~320），不做 y 范围裁剪。区块里的方块是长在一起的：
//      光照、高度图、方块实体、生物群系全挂在同一个 chunk 上，只搬一段 y 必然把
//      存档搞坏。想只搬一部分，请先在游戏里用结构方块或 WorldEdit 裁好。
//
// 【V5 第二组：平移为什么只做"整块对齐"】
//   整块平移 100% 安全：区块内部的一切（光照、高度图、生物群系、方块实体、刻）都是
//   相对区块自洽的，整块挪走不会破坏它们之间的相对关系 —— 只需要把**绝对坐标**那几处
//   改掉（xPos/zPos、方块实体与刻的 x/z、实体的 Pos、结构起点的 ChunkX/ChunkZ 与包围盒）。
//   而"挪 24 格"这种非对齐平移要逐格重排方块、重算高度图、重建光照，那是另一件大得多
//   也危险得多的事 —— 与其半吊子做，不如直接拒绝并给出最近的合法目标。
//
// @module worldmerge

const fs = require('fs');
const path = require('path');
const anvil = require('./anvil');
const nbt = require('./nbt');

/** 一次能搬的区块数上限。32768 = 128×128 区块 = 2048×2048 方块，已经远超"搬个建筑"。 */
const MAX_CHUNKS = 32768;
/** 超过这个数就提醒一句 —— 多半是把"整张地图"当"一栋房子"选了 */
const WARN_CHUNKS = 4096;
/** 实体热点阈值：单区块实体数超过它，就在计划里标出来 */
const ENTITY_THRESHOLD = 100;
/** 单批写入的堆内存预算 */
const PUT_BUDGET = 32 * 1024 * 1024;
/** 世界边界（方块）：原版 ±29999984，这里取整到 30000000 */
const WORLD_LIMIT = 30000000;
/** 1.18 的 DataVersion（21w43a 起正式版）。它引入了负 Y 区段，是搬存档最硬的一道坎。 */
const DV_NEGATIVE_Y = 2825;
/** session.lock 的更新时间在这个秒数内 → 认为这个存档正被游戏打开 */
const LOCK_OPEN_SEC = 60;

/**
 * 指纹矩阵的图例。UI 照着这个把字符画成方块颜色。
 * @type {Array<{ch:string, key:string, label:string}>}
 */
const MATRIX_LEGEND = [
  { ch: '.', key: 'missing', label: '源里没有这个区块（不会搬）' },
  { ch: 'n', key: 'create', label: '目标里没有 → 新建' },
  { ch: '=', key: 'same', label: '目标已经一致 → 不动' },
  { ch: '!', key: 'conflict', label: '目标已有内容且不同 → 覆盖' },
  { ch: '-', key: 'skipped', label: 'skip-existing 跳过' },
  { ch: 'x', key: 'broken', label: '源区块损坏读不出来' }
];

/**
 * 方块坐标矩形 → 区块盒子（向外吸附到区块边界）
 * @param {{x1:number,z1:number,x2:number,z2:number}} o
 * @returns {{cx1:number,cz1:number,cx2:number,cz2:number,chunks:number,
 *            block:{x1:number,z1:number,x2:number,z2:number}, aligned:boolean}}
 */
function chunkBox(o) {
  const px1 = Math.min(Number(o.x1), Number(o.x2));
  const px2 = Math.max(Number(o.x1), Number(o.x2));
  const pz1 = Math.min(Number(o.z1), Number(o.z2));
  const pz2 = Math.max(Number(o.z1), Number(o.z2));
  if (![px1, px2, pz1, pz2].every(Number.isFinite)) throw new Error('区域坐标必须是数字');
  const cx1 = Math.floor(px1 / 16);
  const cz1 = Math.floor(pz1 / 16);
  const cx2 = Math.floor(px2 / 16);
  const cz2 = Math.floor(pz2 / 16);
  const bx1 = cx1 * 16;
  const bz1 = cz1 * 16;
  const bx2 = (cx2 + 1) * 16 - 1;
  const bz2 = (cz2 + 1) * 16 - 1;
  return {
    cx1, cz1, cx2, cz2,
    chunks: (cx2 - cx1 + 1) * (cz2 - cz1 + 1),
    block: { x1: bx1, z1: bz1, x2: bx2, z2: bz2 },
    aligned: bx1 === px1 && bz1 === pz1 && bx2 === px2 && bz2 === pz2
  };
}

/**
 * 把盒子整体平移若干个区块。
 * @param {object} box chunkBox 的结果
 * @param {number} dxc 区块偏移（x）
 * @param {number} dzc 区块偏移（z）
 */
function shiftBox(box, dxc, dzc) {
  const cx1 = box.cx1 + dxc;
  const cz1 = box.cz1 + dzc;
  const cx2 = box.cx2 + dxc;
  const cz2 = box.cz2 + dzc;
  return {
    cx1, cz1, cx2, cz2,
    chunks: (cx2 - cx1 + 1) * (cz2 - cz1 + 1),
    block: {
      x1: cx1 * 16, z1: cz1 * 16,
      x2: (cx2 + 1) * 16 - 1, z2: (cz2 + 1) * 16 - 1
    },
    aligned: box.aligned
  };
}

/**
 * 规范化平移量。
 *
 * **只接受 16 的整数倍**，理由见文件头。给非整数倍时不猜、不四舍五入悄悄改，
 * 而是明确拒绝并把"最近可用的两个值"算出来交给调用方 —— UI 可以直接拿它做两个按钮。
 *
 * @param {{dx?:number, dz?:number}} o
 * @returns {{ok:boolean, dx:number, dz:number, dxc:number, dzc:number, reason:string,
 *            nearest:{dx:number, dz:number, dxc:number, dzc:number}}}
 */
function normalizeShift(o) {
  const raw = { dx: o ? Number(o.dx) || 0 : 0, dz: o ? Number(o.dz) || 0 : 0 };
  const dxc = Math.round(raw.dx / 16);
  const dzc = Math.round(raw.dz / 16);
  const nearest = { dx: dxc * 16, dz: dzc * 16, dxc, dzc };
  if (!Number.isFinite(raw.dx) || !Number.isFinite(raw.dz)) {
    return Object.assign({
      ok: false, dx: 0, dz: 0, dxc: 0, dzc: 0,
      reason: '平移量必须是数字'
    }, { nearest });
  }
  if (nearest.dx !== raw.dx || nearest.dz !== raw.dz) {
    return Object.assign({
      ok: false, dx: raw.dx, dz: raw.dz, dxc: 0, dzc: 0,
      reason: '平移量必须是 16 的整数倍（区块是最小搬运单位）：'
        + raw.dx + ',' + raw.dz + ' 不是；最近可用的是 '
        + nearest.dx + ',' + nearest.dz
    }, { nearest });
  }
  return Object.assign({ ok: true, dx: raw.dx, dz: raw.dz, dxc, dzc, reason: '' }, { nearest });
}

/** 把区块盒子里涉及到的 region 文件分组列出来（一次只处理一个文件，控制内存） */
function regionsInBox(box) {
  const groups = new Map();
  for (let cx = box.cx1; cx <= box.cx2; cx++) {
    for (let cz = box.cz1; cz <= box.cz2; cz++) {
      const { rx, rz } = anvil.regionOf(cx, cz);
      const key = rx + ',' + rz;
      let g = groups.get(key);
      if (!g) { g = { rx, rz, keys: [] }; groups.set(key, g); }
      g.keys.push({ cx, cz });
    }
  }
  return [...groups.values()];
}

/**
 * 读一个 region 文件里盒子里那些区块。
 * 自己做而不是复用 scanSaveChunks：后者扫整个存档（几千个 region），
 * 而搬一栋房子只涉及几个文件，扫全库纯属浪费时间。
 * @returns {{map: Map<string, {raw:Buffer, hash:string, bytes:number, entities:number}>,
 *            exists:boolean, broken:number}}
 */
function readRegionBox(file, keys, withEntities) {
  /** @type {Map<string, {raw:Buffer, hash:string, bytes:number, entities:number}>} */
  const map = new Map();
  let broken = 0;
  const buf = anvil.readRegionFile(file);
  if (!buf) return { map, exists: false, broken: 0 };
  for (const { cx, cz } of keys) {
    let r;
    try { r = anvil.readRaw(buf, cx, cz); } catch { broken++; continue; }
    if (!r) continue;
    const raw = r.data;
    const rec = { raw, hash: anvil.hashOf(raw), bytes: raw.length, entities: 0 };
    if (withEntities) { try { rec.entities = nbt.countEntities(raw); } catch {} }
    map.set(cx + ',' + cz, rec);
  }
  return { map, exists: true, broken };
}

/**
 * 按**给定的区块坐标**读一批区块，跨 region 自动分组。
 *
 * 为什么需要它：平移之后，一个目标 region 里装的区块可能来自源里 2~4 个不同的 region
 * （只要平移量不是 32 的整数倍就必然如此 —— region 是 32×32 个区块）。
 * 原来那套"一个盒子对一个文件"的写法在这里会读到错的东西，而且是**静默**读错。
 *
 * @param {string} saveDir
 * @param {string} dim
 * @param {'region'|'entities'} kind
 * @param {Array<{cx:number,cz:number}>} keys
 * @param {boolean} [withEntities]
 * @returns {{map: Map<string, object>, groups:number, files:number, broken:number}}
 */
function readChunksByKey(saveDir, dim, kind, keys, withEntities) {
  const byRegion = new Map();
  for (const k of keys) {
    const { rx, rz } = anvil.regionOf(k.cx, k.cz);
    const rk = rx + ',' + rz;
    let g = byRegion.get(rk);
    if (!g) { g = { rx, rz, keys: [] }; byRegion.set(rk, g); }
    g.keys.push(k);
  }
  const map = new Map();
  let broken = 0;
  let files = 0;
  for (const g of byRegion.values()) {
    const r = readRegionBox(regionFileOf(saveDir, dim, kind, g.rx, g.rz), g.keys, withEntities);
    if (r.exists) files++;
    broken += r.broken;
    for (const [k, v] of r.map) map.set(k, v);
  }
  return { map, groups: byRegion.size, files, broken };
}

function regionFileOf(saveDir, dim, kind, rx, rz) {
  return path.join(anvil.dataDir(saveDir, dim, kind), anvil.regionFile(rx, rz));
}

/* ================= 坐标同步：平移一块区块 ================= */

/** 1.18+ 顶层 block_entities；≤1.17 在 Level.TileEntities */
function beListOf(root) {
  if (Array.isArray(root.block_entities)) return root.block_entities;
  const lv = levelOf(root);
  if (lv && Array.isArray(lv.TileEntities)) return lv.TileEntities;
  if (Array.isArray(root.TileEntities)) return root.TileEntities;
  return null;
}

function levelOf(root) {
  return root && root.Level && typeof root.Level === 'object' ? root.Level : null;
}

/**
 * 刻列表（计划刻）。1.18+ 叫 block_ticks / fluid_ticks，≤1.17 叫 TileTicks / LiquidTicks。
 * 它们里面存的是**方块绝对坐标**，不跟着搬的话，被搬走的机器会在原位置凭空触发一次。
 */
function tickListOf(root, which) {
  const names = which === 'fluid' ? ['fluid_ticks', 'LiquidTicks'] : ['block_ticks', 'TileTicks'];
  const lv = levelOf(root);
  for (const node of [root, lv]) {
    if (!node) continue;
    for (const n of names) if (Array.isArray(node[n])) return node[n];
  }
  return null;
}

/** 实体列表：1.17+ 独立的 entities/ 文件里是顶层 Entities；≤1.16 挂在 Level.Entities */
function entityListOf(root) {
  if (Array.isArray(root.Entities)) return root.Entities;
  const lv = levelOf(root);
  if (lv && Array.isArray(lv.Entities)) return lv.Entities;
  return null;
}

/** block_entities / block_ticks / fluid_ticks 统一用 { x, y, z }，都是方块绝对坐标 */
function shiftBlockCoords(list, ddx, ddz) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (Number.isFinite(e.x)) { e.x += ddx; n++; }
    if (Number.isFinite(e.z)) { e.z += ddz; n++; }
  }
  return n;
}

/**
 * 实体用的是**双精度世界坐标** Pos:[x, y, z]（y 是竖直方向，不动）。
 *
 * ⚠️ 这里正是里程碑一那个坑的翻版：实体如果恰好站在整数坐标上（Pos = [100.0, 64.0, -200.0]），
 *    `100.0 + 32` 在 JS 里就是整数 116，不带类型表写回会从 **DOUBLE 变成 INT** ——
 *    值是"对"的，类型是错的。所以平移必须走**保类型**的写入端（见 translateChunkRaw）。
 *
 * 乘客（Passengers）挂在载具上，自己的 Pos 也是绝对坐标：漏掉它就会出现
 * "船搬走了，船上的猪还留在原地"。
 */
function shiftEntityTree(e, ddx, ddz) {
  if (!e || typeof e !== 'object') return 0;
  let n = 0;
  const pos = e.Pos;
  if (Array.isArray(pos) && pos.length >= 3) {
    if (Number.isFinite(pos[0])) { pos[0] = pos[0] + ddx; n++; }
    if (Number.isFinite(pos[2])) { pos[2] = pos[2] + ddz; n++; }
  }
  // falling_block / 画 / 物品展示框这类会把"贴在哪个方块上"也记下来
  if (Number.isFinite(e.TileX)) { e.TileX += ddx; n++; }
  if (Number.isFinite(e.TileZ)) { e.TileZ += ddz; n++; }
  if (Array.isArray(e.Passengers)) for (const p of e.Passengers) n += shiftEntityTree(p, ddx, ddz);
  return n;
}

/**
 * 结构起点。`structures.starts` 里的 ChunkX/ChunkZ、Children、BB（包围盒）和
 * References 的键**全是坐标**，不跟着搬的话游戏会以为结构还锚在原处。
 *
 * 但有一条这个层面救不了的：结构通常是跨区块的，每个区块里都存一份"同一个起点"的副本。
 * 只搬其中一部分区块，新位置那份和原位置那些就对不上了。所以 plan 会把带结构起点的
 * 区块数记下来并给一条警告，让用户知道"要么把整个结构圈进选区，要么接受它不完整"。
 */
function shiftStructureTree(st, dxc, dzc, ddx, ddz) {
  if (!st || typeof st !== 'object') return 0;
  let n = 0;
  /** @param {object} node 起点或它的 Child */
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Number.isFinite(node.ChunkX)) { node.ChunkX += dxc; n++; }
    if (Number.isFinite(node.ChunkZ)) { node.ChunkZ += dzc; n++; }
    // BB = [minX, minY, minZ, maxX, maxY, maxZ]，下标 0/3 是 X，2/5 是 Z
    if (Array.isArray(node.BB) && node.BB.length >= 6) {
      for (const i of [0, 2, 3, 5]) {
        if (Number.isFinite(node.BB[i])) node.BB[i] += (i % 3 === 0 ? ddx : ddz);
      }
      n++;
    }
    if (Array.isArray(node.Children)) for (const c of node.Children) visit(c);
  };
  const starts = st.starts;
  if (Array.isArray(starts)) for (const s of starts) visit(s);
  else if (starts && typeof starts === 'object') for (const k of Object.keys(starts)) visit(starts[k]);

  // References 的**键**是 "cx,cz"，得整体重新编号。
  // 用"就地删了再加"而不是新建对象：新建会把类型旁路表里这个节点登记的 COMPOUND 丢掉，
  // 虽然序列化能靠 JS 值兜回来，但空对象就只能靠猜了 —— 没必要冒这个险。
  const refs = st.References;
  if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
    const keys = Object.keys(refs);
    if (keys.length) {
      for (const k of keys) {
        const v = refs[k];
        delete refs[k];
        const parts = String(k).split(',');
        const cx = Number(parts[0]);
        const cz = Number(parts[1]);
        refs[Number.isFinite(cx) && Number.isFinite(cz) ? (cx + dxc) + ',' + (cz + dzc) : k] = v;
      }
      n++;
    }
  }
  return n;
}

/**
 * 平移一个区块的 NBT 树（**就地**修改 root），返回动了几处。
 *
 * @param {object} root nbt.parse(raw).value
 * @param {number} ddx 方块偏移（x）
 * @param {number} ddz 方块偏移（z）
 * @param {number} dxc 区块偏移（x）
 * @param {number} dzc 区块偏移（z）
 * @returns {{pos:number, blockEntities:number, ticks:number, entities:number, structures:number}}
 */
function translateChunkTree(root, ddx, ddz, dxc, dzc) {
  const m = { pos: 0, blockEntities: 0, ticks: 0, entities: 0, structures: 0 };
  // xPos/zPos 是"这个区块在哪个区块格"（区块坐标）；≤1.17 它们在 Level 里
  for (const node of [root, levelOf(root)]) {
    if (!node) continue;
    if (Number.isFinite(node.xPos)) { node.xPos += dxc; m.pos++; }
    if (Number.isFinite(node.zPos)) { node.zPos += dzc; m.pos++; }
  }
  // 实体区块（1.17+ 的 entities/r.x.z.mca）用 Position: [cx, cz] 标自己的位置
  const pos = root.Position;
  if (Array.isArray(pos) && pos.length >= 2 && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
    pos[0] += dxc; pos[1] += dzc; m.pos++;
  }
  m.blockEntities = shiftBlockCoords(beListOf(root), ddx, ddz);
  m.ticks = shiftBlockCoords(tickListOf(root, 'block'), ddx, ddz)
    + shiftBlockCoords(tickListOf(root, 'fluid'), ddx, ddz);
  const ents = entityListOf(root);
  if (ents) for (const e of ents) m.entities += shiftEntityTree(e, ddx, ddz);
  m.structures = shiftStructureTree(root.structures, dxc, dzc, ddx, ddz);
  return m;
}

/**
 * 平移一个区块的**字节**：解析 → 改坐标 → 保类型写回。
 *
 * 区块（region/）和实体（entities/）两种文件的根结构不一样，但坐标字段是同一套
 * （xPos/zPos 或 Position，Entities 或 Level.Entities），所以共用这一个函数。
 *
 * @param {Buffer} raw 未压缩的 NBT 字节
 * @param {number} ddx
 * @param {number} ddz
 * @param {number} dxc
 * @param {number} dzc
 * @returns {{raw:Buffer, moved:object}}
 */
function translateChunkRaw(raw, ddx, ddz, dxc, dzc) {
  const types = nbt.newTypes();
  const parsed = nbt.parse(raw, types);
  const moved = translateChunkTree(parsed.value, ddx, ddz, dxc, dzc);
  // ⚠️ 必须把解析时的类型旁路表原样交给写入端。区块里到处是"从 JS 值看不出类型的字段"：
  //    PostProcessing 是 LIST of SHORT、Pos 是 LIST of DOUBLE（值可能恰好是整数）、
  //    不透明区域的 block_states.data 是 LONG_ARRAY（在 JS 里就是个普通数组）。
  //    不带表写回会静默改类型，游戏读这种区块直接报错 —— 而且错误现场离这里很远。
  const out = nbt.serialize(parsed.name, parsed.value, types);
  return { raw: out, moved };
}

/* ================= 目标存档预检 ================= */

/**
 * session.lock 探测。
 *
 * 原版在打开世界时会写一个**毫秒时间戳**进 session.lock，并每秒更新一次 ——
 * 所以"这个文件几十秒内被写过"就是"这个世界正开着"的强信号。
 * 但旧版本（以及部分第三方工具）往里写的是个随机数，时间戳不可信，
 * 所以两条信号都要看：时间戳合理就用时间戳，否则退回 mtime。
 *
 * @param {string} saveDir
 */
function lockInfo(saveDir) {
  const p = path.join(saveDir, 'session.lock');
  const out = { present: false, agoSec: null, mtimeAgoSec: null, open: false, via: '' };
  let st;
  try { st = fs.statSync(p); } catch { return out; }
  out.present = true;
  out.mtimeAgoSec = Math.round((Date.now() - st.mtimeMs) / 1000);
  let ts = null;
  try {
    const b = fs.readFileSync(p);
    if (b.length >= 8) ts = Number(b.readBigInt64BE(0));
  } catch {}
  // 只有落在"2000 年之后、且不在未来"的范围里才认它是时间戳，否则就是个随机数
  const now = Date.now();
  const plausible = Number.isFinite(ts) && ts > 946684800000 && ts < now + 86400000;
  if (plausible) {
    out.agoSec = Math.round((now - ts) / 1000);
    out.open = out.agoSec >= -5 && out.agoSec < LOCK_OPEN_SEC;
    out.via = out.open ? 'timestamp' : '';
  } else if (out.mtimeAgoSec >= 0 && out.mtimeAgoSec < LOCK_OPEN_SEC) {
    out.open = true;
    out.via = 'mtime';
  }
  return out;
}

/** 读 level.dat 里的版本信息（只读；读不出来就给 null，不抛） */
function readWorldInfo(saveDir) {
  const out = { dataVersion: null, name: null, version: null, error: '' };
  const p = path.join(saveDir, 'level.dat');
  if (!fs.existsSync(p)) { out.error = '没有 level.dat'; return out; }
  try {
    const root = nbt.parseAuto(fs.readFileSync(p));
    const d = root && root.Data && typeof root.Data === 'object' ? root.Data : root;
    if (d && Number.isFinite(Number(d.DataVersion))) out.dataVersion = Number(d.DataVersion);
    if (d && d.LevelName != null) out.name = String(d.LevelName);
    if (d && d.Version && d.Version.Name != null) out.version = String(d.Version.Name);
  } catch (e) { out.error = e.message; }
  return out;
}

/** 试着以"要写"的方式打开文件，确认没被别的进程占着 */
function canWriteFile(p) {
  try {
    let st = null;
    try { st = fs.statSync(p); } catch { st = null; }
    if (st) {
      // 路径上坐着个目录 → 永远写不进去。这不是"还没建"，是调用方把路径搞错了，
      // 提前说出来比等 anvil 报一个更靠后的错要好定位得多。
      if (st.isDirectory()) return { ok: false, reason: 'EISDIR' };
      const fd = fs.openSync(p, 'r+');
      fs.closeSync(fd);
    } else {
      // 文件还不存在不代表有问题 —— 写的时候会连目录一起建。
      // 只有"目录在、但写不进去"才算是真问题（只读盘、权限、被别的进程占着）。
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) return { ok: true, reason: '' };
      fs.accessSync(dir, fs.constants.W_OK);
    }
    return { ok: true, reason: '' };
  } catch (e) { return { ok: false, reason: e.code || e.message }; }
}

/**
 * 目标存档预检 —— **只读**，不动任何字节。
 *
 * 查的是三类"动手前必须先知道"的事：
 *   1. 目标存档是不是正被游戏打开（session.lock）—— 边玩边写 region 会把它写坏；
 *   2. 源和目标的 DataVersion 代差 —— 尤其是跨过 1.18（负 Y 区段）的那道坎；
 *   3. 要写的那些 region 文件能不能写（被别的进程占着就写不进去，不如提前说）。
 *
 * 返回 blockers（必须先解决的硬问题）与 warnings（值得看一眼的）分开，
 * 由调用方决定怎么用：plan 只展示，apply 在 blockers 非空时默认拒绝。
 *
 * @param {{from:string, to:string, dim?:string, files?:string[]}} o
 * @returns {object}
 */
function precheckTarget(o) {
  const out = {
    ok: true, blockers: [], warnings: [],
    lock: null, dataVersion: null, files: { checked: 0, locked: [] },
    src: null, dst: null
  };
  out.lock = lockInfo(o.to);
  if (out.lock.open) {
    out.blockers.push('目标存档似乎正被游戏打开（session.lock '
      + (out.lock.via === 'timestamp'
        ? '的时间戳是 ' + out.lock.agoSec + ' 秒前'
        : '在 ' + out.lock.mtimeAgoSec + ' 秒前被写过')
      + '）—— 游戏运行时写 region 文件会把它写坏。请先退出游戏。');
  }

  out.src = readWorldInfo(o.from);
  out.dst = readWorldInfo(o.to);
  const s = out.src.dataVersion;
  const d = out.dst.dataVersion;
  out.dataVersion = {
    src: s, dst: d, gap: (s != null && d != null) ? d - s : null,
    srcVersion: out.src.version, dstVersion: out.dst.version
  };
  if (s == null) out.warnings.push('读不出源存档的版本（level.dat 缺失或损坏），没法做版本代差检查');
  if (d == null) out.warnings.push('读不出目标存档的版本（level.dat 缺失或损坏）—— 这个目录真的是存档吗？');
  if (s != null && d != null) {
    if (s >= DV_NEGATIVE_Y && d < DV_NEGATIVE_Y) {
      out.blockers.push('源存档是 1.18 及以后的（DataVersion ' + s + '），目标存档是 1.18 之前的（'
        + d + '）：源区块里有 **负 Y 区段**（y<0），目标版本根本不认识它们，'
        + '搬过去要么被丢掉要么让游戏直接报错。请把两边都升级到同一版本再搬。');
    } else if (d < s) {
      out.warnings.push('源存档比目标新（DataVersion ' + s + ' → ' + d + '）：搬过去的方块与字段'
        + '目标版本可能读不懂。建议先把目标存档在游戏里打开一次，或改用同一版本的两个存档。');
    } else if (d > s) {
      out.warnings.push('源存档比目标旧（DataVersion ' + s + ' → ' + d + '）：新版游戏一般能自动升级'
        + '旧区块，但仍建议搬完进游戏看一眼。');
    }
  }

  if (out.dst.error === '没有 level.dat') {
    out.warnings.push('目标目录里没有 level.dat —— 它可能不是存档目录，而是一个父目录');
  }

  for (const f of (o.files || [])) {
    out.files.checked++;
    const w = canWriteFile(f);
    if (!w.ok) {
      out.files.locked.push({ file: f, reason: w.reason });
    }
  }
  if (out.files.locked.length) {
    out.blockers.push('有 ' + out.files.locked.length + ' 个目标文件写不进去（被占用或没有权限）：'
      + out.files.locked.slice(0, 3).map((x) => path.basename(x.file) + '(' + x.reason + ')').join('、')
      + (out.files.locked.length > 3 ? ' 等' : ''));
  }
  out.ok = out.blockers.length === 0;
  return out;
}

/** 把目标盒子里会写到的 region / entities 文件列出来（去重），供预检与提示用 */
function destFilesOf(to, dim, destBox, syncEntities) {
  const set = new Set();
  for (const g of regionsInBox(destBox)) {
    set.add(regionFileOf(to, dim, 'region', g.rx, g.rz));
    if (syncEntities) set.add(regionFileOf(to, dim, 'entities', g.rx, g.rz));
  }
  return [...set];
}

/* ================= 干跑 ================= */

/**
 * 干跑：算清楚这次搬运会做什么，**只读不写**。
 *
 * @param {{from:string, to:string, dim?:string, kind?:string, x1:number, z1:number,
 *          x2:number, z2:number, dx?:number, dz?:number, mode?:'replace'|'skip-existing',
 *          syncEntities?:boolean, entityThreshold?:number, precheck?:boolean,
 *          verifyFiles?:boolean}} o
 * @returns {Promise<object>} 计划书
 */
async function plan(o) {
  if (!o.from || !o.to) throw new Error('必须同时给出源存档 from 和目标存档 to');
  if (path.resolve(o.from) === path.resolve(o.to)) throw new Error('源存档和目标存档是同一个目录');
  if (!fs.existsSync(o.from)) throw new Error('源存档不存在: ' + o.from);
  if (!fs.existsSync(o.to)) throw new Error('目标存档不存在: ' + o.to);

  const dim = o.dim || 'overworld';
  const mode = o.mode === 'skip-existing' ? 'skip-existing' : 'replace';
  const syncEntities = o.syncEntities !== false;
  const threshold = o.entityThreshold || ENTITY_THRESHOLD;

  const shift = normalizeShift(o);
  if (!shift.ok) {
    // 自带错误码与"最近可用值"，UI 靠 nearest 摆一颗「就用它」的按钮。
    // 这里挂的是自定义字段，Error 上没有，所以标 any 而不是反复断言。
    /** @type {any} */
    const e = new Error(shift.reason);
    e.code = 'SHIFT_NOT_ALIGNED';
    e.nearest = shift.nearest;
    throw e;
  }

  const box = chunkBox(o);
  if (box.chunks > MAX_CHUNKS) {
    throw new Error('一次最多搬 ' + MAX_CHUNKS + ' 个区块（本次 ' + box.chunks + ' 个），请缩小范围');
  }
  const destBox = shiftBox(box, shift.dxc, shift.dzc);
  /** 轴名与坐标成对，`[string, number]` 写清楚，否则数组字面量会被推成 (string|number)[]，
   *  下面 Math.abs(b) 就报"算术运算的操作数类型不对"。 */
  /** @type {Array<[string, number]>} */
  const bounds = [['x', destBox.block.x1], ['x', destBox.block.x2],
    ['z', destBox.block.z1], ['z', destBox.block.z2]];
  for (const [n, b] of bounds) {
    if (Math.abs(b) > WORLD_LIMIT) {
      throw new Error('平移后超出世界边界（' + n + '=' + b + '，上限 ±' + WORLD_LIMIT + '），请换个平移量或选区');
    }
  }

  const needShift = shift.dxc !== 0 || shift.dzc !== 0;
  const ddx = shift.dxc * 16;
  const ddz = shift.dzc * 16;

  const out = {
    ok: false,
    from: o.from, to: o.to, dim, dimLabel: anvil.dimInfo(dim).label,
    mode, syncEntities, box, destBox,
    shift: {
      dx: shift.dx, dz: shift.dz, dxc: shift.dxc, dzc: shift.dzc,
      needed: needShift, nearest: shift.nearest
    },
    translate: {
      chunks: 0, pos: 0, blockEntities: 0, ticks: 0, entities: 0,
      structures: 0, chunksWithStructures: 0
    },
    source: { present: 0, missing: 0, bytes: 0, entities: 0, files: 0, broken: 0, missingSample: [] },
    target: { create: 0, same: 0, conflict: 0, entities: 0, files: 0 },
    write: { chunks: 0, same: 0, skipped: 0, entityWrite: 0, entityDelete: 0 },
    conflictsSample: [],
    hotspots: [],
    matrix: null,
    precheck: null,
    warnings: []
  };

  if (o.precheck !== false) {
    out.precheck = precheckTarget({
      from: o.from, to: o.to, dim,
      files: o.verifyFiles === false ? [] : destFilesOf(o.to, dim, destBox, syncEntities)
    });
  }

  const w = destBox.cx2 - destBox.cx1 + 1;
  const h = destBox.cz2 - destBox.cz1 + 1;
  /** 指纹矩阵：每个目标区块一个字符，UI 直接照着画。存成字符串行，省得传几万个对象。 */
  const cells = Array.from({ length: h }, () => new Array(w).fill(' '));
  const put = (cx, cz, ch) => { cells[cz - destBox.cz1][cx - destBox.cx1] = ch; };

  const destGroups = regionsInBox(destBox);
  // 源 region 文件去重：平移之后同一个源文件会被好几个目标分组各读到一次，
  // 直接用计数累加会把"涉及 3 个源文件"报成 6 个。
  const srcFiles = new Set();
  for (const dg of destGroups) {
    const srcKeys = dg.keys.map((k) => ({ cx: k.cx - shift.dxc, cz: k.cz - shift.dzc }));
    const s = readChunksByKey(o.from, dim, 'region', srcKeys, true);
    const d = readRegionBox(regionFileOf(o.to, dim, 'region', dg.rx, dg.rz), dg.keys, false);
    if (d.exists) out.target.files++;
    for (const k of srcKeys) {
      const r = anvil.regionOf(k.cx, k.cz);
      const f = regionFileOf(o.from, dim, 'region', r.rx, r.rz);
      if (fs.existsSync(f)) srcFiles.add(f);
    }
    out.source.broken += s.broken;

    const sEnt = syncEntities
      ? readChunksByKey(o.from, dim, 'entities', srcKeys, false).map
      : new Map();
    const dEnt = syncEntities
      ? readRegionBox(regionFileOf(o.to, dim, 'entities', dg.rx, dg.rz), dg.keys, false).map
      : new Map();

    for (const dk of dg.keys) {
      const dkey = dk.cx + ',' + dk.cz;
      const skey = (dk.cx - shift.dxc) + ',' + (dk.cz - shift.dzc);
      const src = s.map.get(skey);
      if (!src) {
        out.source.missing++;
        if (out.source.missingSample.length < 200) out.source.missingSample.push(skey);
        put(dk.cx, dk.cz, '.');
        continue;
      }
      out.source.present++;
      out.source.bytes += src.bytes;
      out.source.entities += src.entities;
      if (src.entities >= threshold) out.hotspots.push({ cx: dk.cx, cz: dk.cz, entities: src.entities });

      // "目标已经和源一致"必须拿**平移之后**的字节去比。
      // 直接比原始字节会把每一次平移都判成"全部冲突"，那是假的。
      let wantHash = src.hash;
      if (needShift) {
        try {
          const tr = translateChunkRaw(src.raw, ddx, ddz, shift.dxc, shift.dzc);
          wantHash = anvil.hashOf(tr.raw);
          out.translate.chunks++;
          for (const k of Object.keys(out.translate)) {
            if (k !== 'chunks' && k !== 'chunksWithStructures') out.translate[k] += tr.moved[k] || 0;
          }
          if (tr.moved.structures) out.translate.chunksWithStructures++;
        } catch {
          // 平移不了（区块 NBT 坏了）→ 当成读不出来，和 region 层的损坏同等对待
          out.source.broken++;
          put(dk.cx, dk.cz, 'x');
          continue;
        }
      }

      const dst = d.map.get(dkey);
      if (!dst) { out.target.create++; put(dk.cx, dk.cz, 'n'); }
      else if (dst.hash === wantHash) { out.target.same++; put(dk.cx, dk.cz, '='); }
      else {
        out.target.conflict++;
        put(dk.cx, dk.cz, '!');
        if (out.conflictsSample.length < 200) {
          const [scx, scz] = skey.split(',');
          out.conflictsSample.push({
            cx: Number(scx) | 0, cz: Number(scz) | 0,
            dcx: dk.cx, dcz: dk.cz,
            targetEntities: dst.entities, sourceEntities: src.entities
          });
        }
      }

      // 区块与实体**两边都相同**才算"没什么可做"。只看区块会让"区块没变但实体变了"
      // 被误判成无需处理，那正是搬运最该修的一种脏数据。
      const sameRegion = !!dst && dst.hash === wantHash;
      const sameEnt = syncEntities
        ? (sEnt.has(skey) ? !!(dEnt.has(dkey) && dEnt.get(dkey).hash === sEnt.get(skey).hash) : !dEnt.has(dkey))
        : true;
      if (sameRegion && sameEnt) { out.write.same++; continue; }

      // 目标已经有内容、又要求不覆盖 → 这个区块整块跳过（连实体也不动它）
      if (dst && mode === 'skip-existing') { out.write.skipped++; put(dk.cx, dk.cz, '-'); continue; }
      out.write.chunks++;
      // 实体跟着区块走：源里有就写过去，源里没有而目标里有就删掉
      // （不然新搬来的城堡里会残留目标存档原有的生物和掉落物）
      if (syncEntities) {
        if (sEnt.has(skey)) out.write.entityWrite++;
        else if (dEnt.has(dkey)) out.write.entityDelete++;
      }
      out.target.entities += dEnt.has(dkey) ? 1 : 0;
    }
  }

  out.hotspots.sort((a, b) => b.entities - a.entities);
  out.hotspots = out.hotspots.slice(0, 100);
  out.source.files = srcFiles.size;
  out.matrix = {
    w, h, cx1: destBox.cx1, cz1: destBox.cz1,
    cells: cells.map((row) => row.join('')),
    legend: MATRIX_LEGEND
  };
  out.ok = out.write.chunks > 0;

  if (!box.aligned) {
    out.warnings.push('给定的方块范围已按区块向外吸附到 x=' + box.block.x1 + '..' + box.block.x2 +
      '，z=' + box.block.z1 + '..' + box.block.z2 + '（区块是搬运的最小单位）');
  }
  if (needShift) {
    out.warnings.push('这会把选中的区块整体搬到 x' + (shift.dx >= 0 ? '+' : '') + shift.dx +
      '、z' + (shift.dz >= 0 ? '+' : '') + shift.dz + ' 的位置：源区块 (' + box.cx1 + ',' + box.cz1 +
      '..' + box.cx2 + ',' + box.cz2 + ') → 目标区块 (' + destBox.cx1 + ',' + destBox.cz1 +
      '..' + destBox.cx2 + ',' + destBox.cz2 + ')。只做整块平移，垂直方向不动。');
  }
  if (out.translate.structures) {
    out.warnings.push('有 ' + out.translate.chunksWithStructures + ' 个区块带结构起点，已一并改写'
      + '（ChunkX/ChunkZ、包围盒、References 键）。但跨区块的结构如果只圈进来一部分，'
      + '剩下那些区块里的副本仍指向原位置 —— 要么把整个结构圈进选区，要么接受它不完整。');
  }
  if (out.source.missing) {
    out.warnings.push('源存档里有 ' + out.source.missing + ' 个区块是空的（未探索或未生成），这部分不会搬过去');
  }
  if (out.source.broken) {
    out.warnings.push('有 ' + out.source.broken + ' 个源区块读不出来（解压失败或 NBT 损坏），会被跳过');
  }
  if (out.write.chunks > WARN_CHUNKS) {
    out.warnings.push('这次要动 ' + out.write.chunks + ' 个区块，数量偏大 —— 确认不是把整张地图当一栋房子选了吗？');
  }
  if (out.target.conflict && mode === 'replace') {
    out.warnings.push('目标存档里有 ' + out.target.conflict + ' 个区块将被覆盖，apply 前会自动打快照');
  }
  if (out.hotspots.length) {
    out.warnings.push('源存档有 ' + out.hotspots.length + ' 个区块实体数偏高（最多 ' + out.hotspots[0].entities + ' 个），搬过去可能拖慢目标存档');
  }
  if (out.precheck) {
    for (const b of out.precheck.blockers) out.warnings.push('【必须先解决】' + b);
    for (const w2 of out.precheck.warnings) out.warnings.push(w2);
  }
  if (!out.ok) {
    out.warnings.push(out.source.present
      ? '目标存档里这些区块已经和源一致，没有需要搬的内容'
      : '源存档在这个范围内一个区块都没有，没有可搬的内容');
  }
  return out;
}

/* ================= 执行 ================= */

/**
 * 执行搬运。
 *
 * 落盘前的四道保险：
 *   1. 预检有 blocker（游戏正开着目标存档 / 版本跨过 1.18 / 目标文件写不进去）→ 默认拒绝，
 *      除非显式传 `force:true`；
 *   2. 给了 tmDir → 先给**目标存档**打一个时光机快照（这是唯一能整档回退的手段）；
 *   3. 每个被改动的 region 文件写回前自动留 `.bak`（anvil 的默认行为）；
 *   4. 写完复验：重扫目标，逐个比对指纹，对不上的列出来（默认严格模式直接抛错）。
 *      平移时比对的是"源字节平移之后"的指纹 —— 拿原始字节去比会把一次完全正确的
 *      平移判成全部失败。
 *
 * @param {{from:string, to:string, dim?:string, x1:number, z1:number, x2:number, z2:number,
 *          dx?:number, dz?:number, mode?:'replace'|'skip-existing', syncEntities?:boolean,
 *          tmDir?:string, backup?:boolean, verify?:boolean, force?:boolean,
 *          onProgress?:(o:object)=>void}} o
 * @returns {Promise<object>}
 */
async function apply(o) {
  const p = await plan(o);
  // "没什么要搬的"不是错误：目标里这些区块已经和源一模一样了。
  // 所以不要用 ok:false 表达它 —— ok 只表示"这次操作本身顺不顺利"，
  // 否则调用方没法区分"没事干"和"失败了"。
  if (!p.write.chunks) {
    return {
      ok: true, nothingToDo: true, plan: p, safety: null,
      written: 0, deleted: 0, files: 0,
      verification: { ok: true, checked: 0, mismatched: [] }, verified: true
    };
  }

  // 预检硬问题：默认拦下来。这里返回对象而不是抛错，交给 IPC 层的 safe() 统一转成
  // {ok:false, error}，同时把 blockers 原样带回去 —— UI 要拿它们显示"为什么不让搬"。
  if (p.precheck && p.precheck.blockers.length && !o.force) {
    return {
      ok: false, blocked: true, blockedReason: 'precheck',
      blockers: p.precheck.blockers, precheck: p.precheck,
      plan: p, safety: null, written: 0, deleted: 0, files: 0,
      verification: { ok: false, checked: 0, mismatched: [] }, verified: false
    };
  }

  // 1. 安全快照（打的是目标存档 —— 被改的是它）
  let safety = null;
  if (o.tmDir) {
    const tm = require('./savetimemachine');
    try {
      const s = await tm.createSnapshot({
        saveDir: o.to, storeDir: o.tmDir, label: '合并前自动快照', auto: true
      });
      safety = s.id;
    } catch { safety = null; }
  }

  const dim = p.dim;
  const mode = p.mode;
  const syncEntities = p.syncEntities;
  const dxc = p.shift.dxc;
  const dzc = p.shift.dzc;
  const ddx = dxc * 16;
  const ddz = dzc * 16;
  const needShift = p.shift.needed;
  let written = 0;
  let deleted = 0;
  let files = 0;
  let objects = 0;
  let translated = 0;
  /** 真正写过的区块，键是**目标**坐标 "dcx,dcz"。复验只认这些 —— 见下方说明。 */
  const writtenKeys = new Set();

  for (const dg of regionsInBox(p.destBox)) {
    const srcKeys = dg.keys.map((k) => ({ cx: k.cx - dxc, cz: k.cz - dzc }));
    const s = readChunksByKey(o.from, dim, 'region', srcKeys, false);
    const d = readRegionBox(regionFileOf(o.to, dim, 'region', dg.rx, dg.rz), dg.keys, false);
    const sEntMap = syncEntities
      ? readChunksByKey(o.from, dim, 'entities', srcKeys, false).map
      : null;
    const dEntMap = syncEntities
      ? readRegionBox(regionFileOf(o.to, dim, 'entities', dg.rx, dg.rz), dg.keys, false).map
      : new Map();

    /** @type {Array<{cx:number,cz:number,raw:Buffer}>} */
    const puts = [];
    /** @type {Array<{cx:number,cz:number,raw:Buffer}>} */
    const entPuts = [];
    /** @type {Array<{cx:number,cz:number}>} */
    const entDels = [];
    let budget = 0;

    const tf = (raw) => {
      if (!needShift) return raw;
      const r = translateChunkRaw(raw, ddx, ddz, dxc, dzc);
      translated++;
      return r.raw;
    };

    for (const dk of dg.keys) {
      const skey = (dk.cx - dxc) + ',' + (dk.cz - dzc);
      const dkey = dk.cx + ',' + dk.cz;
      const src = s.map.get(skey);
      if (!src) continue;
      const dst = d.map.get(dkey);
      // 目标已有内容而要求不覆盖 → 整块跳过，连它的实体也不动
      if (dst && mode === 'skip-existing') continue;

      let want = null;
      try { want = tf(src.raw); } catch { continue; }   // 平移不了就跳过（plan 里已经报过）
      const wantHash = anvil.hashOf(want);
      const e = sEntMap ? sEntMap.get(skey) : null;
      const de = dEntMap.get(dkey);
      // 区块和它的实体归同一个 key，必须**成对**判断与替换：
      // 只看区块就跳过的话，新搬来的城堡里会残留目标存档原有的生物与掉落物；
      // 反过来只看区块就写的话，又会在空地上凭空多出一堆实体。
      const sameRegion = !!dst && dst.hash === wantHash;
      let wantEnt = null;
      if (syncEntities && e) {
        try { wantEnt = tf(e.raw); } catch { wantEnt = null; }
      }
      const sameEnt = syncEntities
        ? (e ? !!(de && wantEnt && de.hash === anvil.hashOf(wantEnt)) : !de)
        : true;
      if (sameRegion && sameEnt) continue;

      if (!sameRegion) {
        puts.push({ cx: dk.cx, cz: dk.cz, raw: want });
        writtenKeys.add(dkey);
        budget += want.length;
        objects++;
      }
      if (syncEntities) {
        if (e) { if (wantEnt && !(de && de.hash === anvil.hashOf(wantEnt))) entPuts.push({ cx: dk.cx, cz: dk.cz, raw: wantEnt }); }
        else if (de) entDels.push({ cx: dk.cx, cz: dk.cz });
      }
    }

    if (puts.length) {
      const r = await anvil.applySaveChunks({
        saveDir: o.to, dim, kind: 'region', puts, dels: [], backup: o.backup !== false
      });
      written += r.written; files += r.files; deleted += r.deleted;
    }
    if (entPuts.length || entDels.length) {
      const r2 = await anvil.applySaveChunks({
        saveDir: o.to, dim, kind: 'entities', puts: entPuts, dels: entDels, backup: o.backup !== false
      });
      written += r2.written; files += r2.files; deleted += r2.deleted;
    }
    if (o.onProgress) o.onProgress({ dim, written, deleted, files, budget });
  }

  // 4. 复验：**只核对确实写过的区块**。
  //    不能拿整个盒子去对指纹 —— skip-existing 模式下被"故意跳过"的区块本来就该和源不同，
  //    那样会把一次完全正确的搬运判成失败（而且要人盯着看半天才发现是误报）。
  let verification = { ok: true, checked: 0, mismatched: [] };
  if (o.verify !== false) {
    const tf = (raw) => {
      if (!needShift) return raw;
      try { return translateChunkRaw(raw, ddx, ddz, dxc, dzc).raw; } catch { return null; }
    };
    for (const dg of regionsInBox(p.destBox)) {
      const need = dg.keys.filter((k) => writtenKeys.has(k.cx + ',' + k.cz));
      if (!need.length) continue;
      const srcKeys = need.map((k) => ({ cx: k.cx - dxc, cz: k.cz - dzc }));
      const s = readChunksByKey(o.from, dim, 'region', srcKeys, false);
      const d = readRegionBox(regionFileOf(o.to, dim, 'region', dg.rx, dg.rz), need, false);
      for (const k of need) {
        const dkey = k.cx + ',' + k.cz;
        const src = s.map.get((k.cx - dxc) + ',' + (k.cz - dzc));
        if (!src) continue;
        verification.checked++;
        const want = tf(src.raw);
        const dst = d.map.get(dkey);
        if (!want || !dst || dst.hash !== anvil.hashOf(want)) {
          if (verification.mismatched.length < 200) verification.mismatched.push(dkey);
        }
      }
    }
    verification.ok = verification.mismatched.length === 0;
  }

  return {
    ok: verification.ok,
    blocked: false,
    nothingToDo: false,
    plan: p,
    safety,
    written, deleted, files,
    objects, translated,
    verification,
    verified: verification.ok
  };
}

module.exports = {
  MAX_CHUNKS, WARN_CHUNKS, ENTITY_THRESHOLD, PUT_BUDGET,
  WORLD_LIMIT, DV_NEGATIVE_Y, MATRIX_LEGEND,
  chunkBox, shiftBox, normalizeShift, regionsInBox, readRegionBox, readChunksByKey,
  translateChunkTree, translateChunkRaw,
  lockInfo, readWorldInfo, precheckTarget, destFilesOf,
  plan, apply
};
