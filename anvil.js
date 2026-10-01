/**
 * Minecraft Anvil（region / .mca）读写层（零依赖）。
 *
 * 为什么单独抽出来：V3 里只有 `savetimemachine.scanRegion` 会解析 region 头表，
 * 而且**只读、只看坏块**；V4 第一组（世界版本控制 / 世界合并与建筑移植）需要的是
 * **可读可写**的区域级存取：读到单个区块的 NBT、改掉它、原样写回。
 * 于是把这一份正式抽成模块，scanRegion 改为复用（对齐 `nbt.js` 那次「抽掉重复实现」的做法）。
 *
 * 文件布局（`.mca`，小端无关，全部大端）：
 *   [0, 4096)     位置表：1024 × 4 字节 = 3 字节起始扇区号 + 1 字节扇区数
 *   [4096, 8192)  时间戳表：1024 × 4 字节（Unix 秒）
 *   [8192, ...)   区块负载，每个按 4096 字节（1 扇区）对齐
 *
 * 单个区块负载：
 *   [0,4)   长度 = 1 + 压缩后数据长度（**含**压缩类型字节本身）
 *   [4]     压缩类型：1 = gzip，2 = zlib，3 = 未压缩，4 = LZ4
 *   [5,...) 压缩后的 NBT 字节流
 *
 * 区块槽位 i 与区块坐标的映射：i = (cx & 31) + (cz & 31) * 32，
 * 而所在 region 文件为 r.(cx >> 5).(cz >> 5).mca。负数用位运算天然取到正确值
 * （-1 & 31 === 31，-1 >> 5 === -1），不需要额外的取模修正。
 *
 * ⚠️ **槽位语义（最容易踩的坑）**：一个 region buffer **不带 region 身份**，
 * 坐标在这里只按 `& 31` 归约。所以 (-1,-1) 与 (31,31) 的槽位是同一个，
 * 对同一个 buffer 读这两个坐标拿到的必然是同一个区块 —— 这是 Anvil 格式决定的。
 * 真正的隔离靠**先选对文件**：用 `regionFilePath()` 定位到 r.-1.-1.mca / r.0.0.mca，
 * 或直接用存档级接口 `readSaveChunk / writeSaveChunk / scanSaveChunks`（它们内部会选文件）。
 * 想让坐标直接跨 region 用，请走存档级接口，不要对单个 buffer 传越界坐标。
 *
 * 写回策略：**整文件重打包**。未改动的区块直接搬运磁盘上**已压缩的原始字节**，
 * 不重新压缩（既快又无损，避免 zlib 版本差异导致的字节漂移）；
 * 只有被改动的区块才重新压缩。region 文件通常 1~16MB，整读整写完全可接受，
 * 这也是 savetimemachine 一直在用的量级。
 *
 * @module anvil
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const nbt = require('./nbt');

const SECTOR = 4096;
const HEADER_BYTES = SECTOR * 2;    // 位置表 + 时间戳表
const SIDE = 32;                    // 一个 region 边长 32 个区块
const CHUNKS_PER_REGION = SIDE * SIDE;  // 1024

/** 压缩类型（与 Anvil 规格一致） */
const COMP = { GZIP: 1, ZLIB: 2, NONE: 3, LZ4: 4 };

/** 区块负载类型：1.18+ 把实体拆到了独立的 entities/ 目录，格式与 region 相同 */
const KIND = { REGION: 'region', ENTITIES: 'entities' };

/** 三个维度在存档目录下的落点 */
const DIMS = [
  { key: 'overworld', label: '主世界', sub: '' },
  { key: 'nether', label: '下界', sub: 'DIM-1' },
  { key: 'end', label: '末地', sub: 'DIM1' }
];

class AnvilError extends Error {
  constructor(msg) { super(msg); this.name = 'AnvilError'; }
}

/* ================= 坐标与命名 ================= */

/**
 * 区块坐标 → region 内的槽位下标（0..1023）
 * @param {number} cx
 * @param {number} cz
 * @returns {number}
 */
function chunkIndex(cx, cz) { return (cx & (SIDE - 1)) + (cz & (SIDE - 1)) * SIDE; }

/**
 * 区块坐标 → 所属 region 的坐标
 * @param {number} cx
 * @param {number} cz
 * @returns {{rx:number, rz:number}}
 */
function regionOf(cx, cz) { return { rx: cx >> 5, rz: cz >> 5 }; }

/**
 * region 坐标 → 文件名
 * @param {number} rx
 * @param {number} rz
 * @returns {string}
 */
function regionFile(rx, rz) { return 'r.' + rx + '.' + rz + '.mca'; }

/**
 * 文件名 → region 坐标；不是合法命名返回 null
 * @param {string} fileName
 * @returns {{rx:number, rz:number}|null}
 */
function parseRegionName(fileName) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(fileName);
  if (!m) return null;
  return { rx: parseInt(m[1], 10), rz: parseInt(m[2], 10) };
}

/**
 * @param {string} key
 * @returns {{key:string, label:string, sub:string}}
 */
function dimInfo(key) {
  return DIMS.find((d) => d.key === key) || DIMS[0];
}

/**
 * 某个维度某个种类（region / entities）的目录
 * @param {string} saveDir
 * @param {string} [dim]
 * @param {string} [kind]
 * @returns {string}
 */
function dataDir(saveDir, dim, kind) {
  const sub = dimInfo(dim || 'overworld').sub;
  const base = sub ? path.join(saveDir, sub) : saveDir;
  return path.join(base, kind || KIND.REGION);
}

/* ================= 头部解析 ================= */

/**
 * 解析 region 头部。
 * 位置表里 offset / sectors 任一为 0 都按空槽处理（规格要求两者同时为 0，
 * 但现实中确实存在只写一半的条目，当成损坏会让整个文件不可读）。
 * @param {Buffer} buf
 * @returns {{entries: Array<{offset:number, sectors:number, time:number, empty:boolean}>,
 *            count:number, bytes:number, tooShort:boolean}}
 */
function parseHeader(buf) {
  const entries = new Array(CHUNKS_PER_REGION);
  let count = 0;
  const tooShort = !Buffer.isBuffer(buf) || buf.length < HEADER_BYTES;
  for (let i = 0; i < CHUNKS_PER_REGION; i++) {
    if (tooShort) { entries[i] = { offset: 0, sectors: 0, time: 0, empty: true }; continue; }
    const p = i * 4;
    const offset = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
    const sectors = buf[p + 3];
    const time = buf.readUInt32BE(4096 + i * 4);
    const empty = offset === 0 || sectors === 0;
    if (!empty) count++;
    entries[i] = { offset, sectors, time, empty };
  }
  return { entries, count, bytes: tooShort ? 0 : buf.length, tooShort };
}

/**
 * 列出 region 里实际存在的区块
 * @param {Buffer} buf
 * @param {number} rx region 的 x 坐标（用于换算世界区块坐标）
 * @param {number} rz
 * @param {string} [kind]
 * @returns {Array<{i:number, cx:number, cz:number, offset:number, sectors:number, bytes:number, comp:number, time:number, broken:boolean}>}
 */
function listChunks(buf, rx, rz, kind) {
  const { entries, tooShort } = parseHeader(buf);
  if (tooShort) return [];
  const out = [];
  for (let i = 0; i < CHUNKS_PER_REGION; i++) {
    const e = entries[i];
    if (e.empty) continue;
    const cx = rx * SIDE + (i % SIDE);
    const cz = rz * SIDE + Math.floor(i / SIDE);
    const rec = { i, cx, cz, offset: e.offset, sectors: e.sectors, bytes: 0, comp: 0, time: e.time, broken: false };
    const payload = payloadSlice(buf, e);
    if (!payload) { rec.broken = true; out.push(rec); continue; }
    rec.bytes = payload.length;
    rec.comp = payload[4];
    out.push(rec);
  }
  return out;
}

/**
 * 检查一个表项在磁盘上到底能不能读，并在读不了时给出**人话原因**。
 * 健康检查直接把 reason 展示给玩家，所以这里要区分「偏移越界」和「长度字段异常」，
 * 而不是笼统地说一句"坏了"。
 * @param {Buffer} buf
 * @param {{offset:number, sectors:number}} e
 * @returns {{ok:boolean, reason:string, payload:Buffer|null, comp:number}}
 */
function inspectEntry(buf, e) {
  const start = e.offset * SECTOR;
  if (start + 5 > buf.length) return { ok: false, reason: '区块偏移越界', payload: null, comp: 0 };
  const len = buf.readUInt32BE(start);
  if (len < 1 || start + 4 + len > buf.length) return { ok: false, reason: '长度字段异常', payload: null, comp: 0 };
  return { ok: true, reason: '', payload: buf.slice(start, start + 4 + len), comp: buf[start + 4] };
}

/**
 * 取出某个槽位在磁盘上的**原始负载**（含 4 字节长度头与压缩类型字节）。
 * 越界 / 长度异常一律返回 null，由调用方决定是报损坏还是丢弃。
 * @param {Buffer} buf
 * @param {{offset:number, sectors:number}} e
 * @returns {Buffer|null}
 */
function payloadSlice(buf, e) {
  const ins = inspectEntry(buf, e);
  return ins.ok ? ins.payload : null;
}

/* ================= 解压 / 压缩 ================= */

/**
 * 解压区块 NBT。LZ4（4）没有内置实现，明确报错而不是当成未压缩读出一堆垃圾。
 * @param {Buffer} data
 * @param {number} comp
 * @returns {Buffer}
 */
function decompress(data, comp) {
  if (comp === COMP.ZLIB) return zlib.inflateSync(data);
  if (comp === COMP.GZIP) return zlib.gunzipSync(data);
  if (comp === COMP.NONE) return data;
  if (comp === COMP.LZ4) throw new AnvilError('暂不支持 LZ4 压缩的区块（类型 4）');
  throw new AnvilError('未知压缩类型: ' + comp);
}

/**
 * 压缩区块 NBT 并拼成负载（长度头 + 类型字节 + 数据）
 * @param {Buffer} raw 未压缩的 NBT
 * @param {number} [comp]
 * @returns {Buffer}
 */
function pack(raw, comp) {
  const c = comp || COMP.ZLIB;
  const data = c === COMP.NONE ? raw
    : c === COMP.GZIP ? zlib.gzipSync(raw)
      : c === COMP.ZLIB ? zlib.deflateSync(raw)
        : null;
  if (!data) throw new AnvilError('不支持的写入压缩类型: ' + c);
  const out = Buffer.alloc(4 + 1 + data.length);
  out.writeUInt32BE(data.length + 1, 0);   // 长度含压缩类型字节本身
  out[4] = c;
  data.copy(out, 5);
  return out;
}

/* ================= 读取 ================= */

/**
 * 读一个区块的**未压缩 NBT 字节**（相对该 region 的局部槽位）。
 * @param {Buffer} buf
 * @param {number} i 槽位下标 0..1023
 * @returns {{data:Buffer, comp:number, bytes:number, time:number}|null}
 */
function readRawByIndex(buf, i) {
  const { entries, tooShort } = parseHeader(buf);
  if (tooShort || i < 0 || i >= CHUNKS_PER_REGION) return null;
  const e = entries[i];
  if (e.empty) return null;
  const payload = payloadSlice(buf, e);
  if (!payload) throw new AnvilError('区块负载越界（槽位 ' + i + '，偏移 ' + e.offset + '）');
  const comp = payload[4];
  const data = decompress(payload.slice(5), comp);
  return { data, comp, bytes: payload.length, time: e.time };
}

/**
 * 按区块坐标读未压缩 NBT 字节。
 * 坐标只用于 `& 31` 归约出槽位（见模块头「槽位语义」），buffer 本身不知道自己是哪个 region。
 * @param {Buffer} buf
 * @param {number} cx
 * @param {number} cz
 * @returns {{data:Buffer, comp:number, bytes:number, time:number}|null}
 */
function readRaw(buf, cx, cz) { return readRawByIndex(buf, chunkIndex(cx, cz)); }

/**
 * 按区块坐标读**已解析**的 NBT。返回值保留根名，便于原样写回。
 * 注意 1.18 起区块 NBT 的根就是区块本身；1.17 及更早还套着一层 `Level`，
 * 这里不做展平 —— 版本差异交给上层判断（本项目不硬编码版本）。
 * @param {Buffer} buf
 * @param {number} cx
 * @param {number} cz
 * @returns {{name:string, value:object, comp:number, time:number}|null}
 */
function readNbt(buf, cx, cz) {
  const r = readRaw(buf, cx, cz);
  if (!r) return null;
  const tree = nbt.parse(r.data);
  return { name: tree.name, value: tree.value, comp: r.comp, time: r.time };
}

/**
 * 区块内容的身份指纹（用于 diff / 去重）。
 * 取**未压缩** NBT 的 sha1：这样「同一内容被重新压缩」不会被误判成改动。
 * @param {Buffer} raw
 * @returns {string}
 */
function hashOf(raw) { return crypto.createHash('sha1').update(raw).digest('hex'); }

/**
 * 直接对 region 里某个区块取指纹
 * @param {Buffer} buf
 * @param {number} cx
 * @param {number} cz
 * @returns {string|null}
 */
function chunkHash(buf, cx, cz) {
  const r = readRaw(buf, cx, cz);
  return r ? hashOf(r.data) : null;
}

/* ================= 重打包 / 写入 ================= */

/** 一个全新的空 region（只有两张空表） */
function empty() { return Buffer.alloc(HEADER_BYTES); }

/**
 * 重打包 region。
 *
 * `changes` 的取值约定（**这是本模块最容易用错的地方**）：
 *   - 键不存在      → 保持原样（搬运磁盘上已压缩的字节，不重压缩）
 *   - 值为 `null`   → 删除该区块
 *   - 值为 Buffer   → 用这份**未压缩 NBT** 替换该区块
 *   - 值为 {data, comp} → 同上，但可指定压缩类型
 *
 * @param {Buffer} buf
 * @param {Map<number, Buffer|{data:Buffer, comp?:number}|null>} [changes]
 * @param {{time?:number}} [opts] 写入区块时使用的时间戳（秒），缺省取当前时间
 * @returns {{buf:Buffer, dropped:number[], written:number}}
 */
function repack(buf, changes, opts) {
  const { entries, tooShort } = parseHeader(buf);
  const ch = changes || new Map();
  const now = Math.floor(Date.now() / 1000);
  const when = opts && opts.time != null ? opts.time : now;

  /** @type {Buffer[]} */
  const parts = [];
  const table = new Array(CHUNKS_PER_REGION);
  const dropped = [];
  let written = 0;
  let sector = 2;   // 头两张表就占了 2 个扇区

  for (let i = 0; i < CHUNKS_PER_REGION; i++) {
    const e = entries[i];
    const has = ch.has(i);
    const change = has ? ch.get(i) : undefined;

    let payload = null;
    let time = e.time;

    if (has && change === null) {
      // 显式删除：不产出负载，表项留空
      continue;
    } else if (has && change) {
      const raw = Buffer.isBuffer(change) ? change : change.data;
      const comp = (Buffer.isBuffer(change) ? undefined : change.comp) || COMP.ZLIB;
      payload = pack(raw, comp);
      time = when;
      written++;
    } else if (!e.empty && !tooShort) {
      payload = payloadSlice(buf, e);
      if (!payload) {
        // 磁盘上这条已经是坏的（越界或长度异常）。没法安全搬运，只能丢弃并报告，
        // 而不是猜一个长度把垃圾抄过去。
        dropped.push(i);
        continue;
      }
    } else {
      continue;
    }

    const sectors = Math.ceil(payload.length / SECTOR);
    // 扇区数是 1 字节字段；单个区块超过 255 扇区（约 1MB）已超出 Anvil 规格，
    // 继续写下去只会让表项溢出成垃圾，所以宁可明确报错。
    if (sectors > 255) throw new AnvilError('区块负载超过 255 扇区（' + payload.length + ' 字节），拒绝写入');
    if (sector + sectors > 0x1000000) throw new AnvilError('region 超过 64GB 上限');
    const padded = Buffer.alloc(sectors * SECTOR);
    payload.copy(padded);
    parts.push(padded);
    table[i] = { offset: sector, sectors, time };
    sector += sectors;
  }

  const head = Buffer.alloc(HEADER_BYTES);
  for (let i = 0; i < CHUNKS_PER_REGION; i++) {
    const t = table[i];
    if (!t) continue;
    const p = i * 4;
    head[p] = (t.offset >> 16) & 0xff;
    head[p + 1] = (t.offset >> 8) & 0xff;
    head[p + 2] = t.offset & 0xff;
    head[p + 3] = t.sectors & 0xff;
    head.writeUInt32BE(t.time >>> 0, 4096 + i * 4);
  }

  // 一次性分配 + 逐个 copy，而不是 Buffer.concat([head].concat(parts))：
  // 后者的两个参数在新版 @types/node 里是不同泛型的 Buffer（ArrayBuffer vs ArrayBufferLike），
  // tsc 会报 TS2769；而且这样只分配一次，更省。
  let total = HEADER_BYTES;
  for (const p of parts) total += p.length;
  const out = Buffer.allocUnsafe(total);
  head.copy(out, 0);
  let off = HEADER_BYTES;
  for (const p of parts) { p.copy(out, off); off += p.length; }

  return { buf: out, dropped, written };
}

/**
 * 写入 / 替换一个区块
 * @param {Buffer} buf
 * @param {number} cx
 * @param {number} cz
 * @param {Buffer} raw 未压缩 NBT
 * @param {{comp?:number, time?:number}} [opts]
 * @returns {{buf:Buffer, dropped:number[], written:number}}
 */
function setChunk(buf, cx, cz, raw, opts) {
  const o = opts || {};
  const map = new Map();
  map.set(chunkIndex(cx, cz), { data: raw, comp: o.comp });
  return repack(buf, map, { time: o.time });
}

/**
 * 删除一个区块
 * @param {Buffer} buf
 * @param {number} cx
 * @param {number} cz
 * @returns {{buf:Buffer, dropped:number[], written:number}}
 */
function deleteChunk(buf, cx, cz) {
  const map = new Map();
  map.set(chunkIndex(cx, cz), null);
  return repack(buf, map);
}

/* ================= 文件级读写（原子 + 备份） ================= */

/**
 * 读 region 文件；不存在或过短返回 null（调用方按「空 region」处理）
 * @param {string} file
 * @returns {Buffer|null}
 */
function readRegionFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length < HEADER_BYTES) return null;
  return buf;
}

/**
 * 原子写回 region 文件：先写 `.tmp` 再改名，避免写一半断电留下半截文件。
 * 覆盖前默认把原文件另存一份 `.bak`（只在原文件确实存在时）。
 * @param {string} file
 * @param {Buffer} buf
 * @param {{backup?:boolean}} [opts]
 * @returns {{ok:true, backup:string|null, bytes:number}}
 */
function writeRegionFile(file, buf, opts) {
  const doBackup = !opts || opts.backup !== false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (doBackup && fs.existsSync(file)) {
    backup = file + '.bak';
    fs.copyFileSync(file, backup);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);   // Windows 上 Node 走 MoveFileEx(REPLACE_EXISTING)，可覆盖
  return { ok: true, backup, bytes: buf.length };
}

/* ================= 存档级便捷接口 ================= */

/**
 * 列出某个目录下所有 region 文件
 * @param {string} dir
 * @returns {Array<{file:string, name:string, rx:number, rz:number, size:number}>}
 */
function listRegionFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.mca')) continue;
    const rc = parseRegionName(n);
    if (!rc) continue;
    const file = path.join(dir, n);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    out.push({ file, name: n, rx: rc.rx, rz: rc.rz, size });
  }
  return out.sort((a, b) => (a.rx - b.rx) || (a.rz - b.rz));
}

/**
 * 按坐标定位 region 文件路径
 * @param {string} saveDir
 * @param {string} dim
 * @param {string} kind
 * @param {number} cx
 * @param {number} cz
 * @returns {string}
 */
function regionFilePath(saveDir, dim, kind, cx, cz) {
  const { rx, rz } = regionOf(cx, cz);
  return path.join(dataDir(saveDir, dim, kind), regionFile(rx, rz));
}

/**
 * 从存档里读一个区块的原始 NBT
 * @param {{saveDir:string, dim?:string, kind?:string, cx:number, cz:number}} o
 * @returns {{raw:Buffer, comp:number, hash:string}|null}
 */
function readSaveChunk(o) {
  const file = regionFilePath(o.saveDir, o.dim, o.kind, o.cx, o.cz);
  const buf = readRegionFile(file);
  if (!buf) return null;
  const r = readRaw(buf, o.cx, o.cz);
  if (!r) return null;
  return { raw: r.data, comp: r.comp, hash: hashOf(r.data) };
}

/**
 * 往存档里写一个区块（自动建目录 / 建 region 文件）
 * @param {{saveDir:string, dim?:string, kind?:string, cx:number, cz:number,
 *          raw:Buffer, comp?:number, backup?:boolean}} o
 * @returns {{ok:boolean, file:string, dropped:number[], created:boolean}}
 */
function writeSaveChunk(o) {
  const file = regionFilePath(o.saveDir, o.dim, o.kind, o.cx, o.cz);
  const existed = fs.existsSync(file);
  const buf = readRegionFile(file) || empty();
  const res = setChunk(buf, o.cx, o.cz, o.raw, { comp: o.comp });
  writeRegionFile(file, res.buf, { backup: o.backup !== false });
  return { ok: true, file, dropped: res.dropped, created: !existed };
}

/**
 * 批量写入 / 删除区块：**按 region 分组，每个 .mca 只读一次、只重打包一次**。
 *
 * 为什么必须有这个接口：世界版本控制的一次 checkout 可能动几千个区块，
 * 而它们散落在几十个 region 文件里。若逐个调 writeSaveChunk，同一个文件会被
 * 完整读入 + repack + 写回上千次 —— 单次 repack 就要搬运整个文件的所有区块，
 * 那是纯浪费的几十 GB IO。按 region 归并后，组内所有改动合成**一次** repack。
 *
 * `puts` 与 `dels` 里出现同一个区块时**以删除为准**（正常调用方不该这么传，
 * 但真发生了也不能写出「刚写进去又删掉」的假成功）。
 * 只包含删除、且目标 region 文件原本就不存在时，不会凭空造一个空 region 出来。
 *
 * @param {{saveDir:string, dim?:string, kind?:string, backup?:boolean,
 *          puts?: Array<{cx:number, cz:number, raw:Buffer, comp?:number}>,
 *          dels?: Array<{cx:number, cz:number}>,
 *          onProgress?:(done:number, total:number)=>void}} o
 * @returns {Promise<{files:number, written:number, deleted:number, dropped:number, created:number}>}
 */
async function applySaveChunks(o) {
  /** @type {Map<string, {file:string, changes:Map<number, Buffer|null>}>} */
  const groups = new Map();
  const groupOf = (cx, cz) => {
    const { rx, rz } = regionOf(cx, cz);
    const key = rx + ',' + rz;
    let g = groups.get(key);
    if (!g) {
      g = { file: regionFilePath(o.saveDir, o.dim, o.kind, cx, cz), changes: new Map() };
      groups.set(key, g);
    }
    return g;
  };

  for (const p of (o.puts || [])) groupOf(p.cx, p.cz).changes.set(chunkIndex(p.cx, p.cz), p.raw);
  for (const d of (o.dels || [])) groupOf(d.cx, d.cz).changes.set(chunkIndex(d.cx, d.cz), null);

  const list = [...groups.values()];
  let written = 0, deleted = 0, dropped = 0, created = 0;
  let done = 0;

  for (const g of list) {
    const existed = fs.existsSync(g.file);
    const buf = readRegionFile(g.file) || empty();
    let deletedHere = 0;
    if (existed) {
      const { entries } = parseHeader(buf);
      for (const [i, v] of g.changes) if (v === null && !entries[i].empty) deletedHere++;
    }
    const res = repack(buf, g.changes);
    // 目标文件本来就没有、又没有真正要写的内容 → 别造一个空 region 出来
    if (existed || res.written > 0) {
      writeRegionFile(g.file, res.buf, { backup: o.backup !== false });
      if (!existed) created++;
    }
    written += res.written;
    deleted += deletedHere;
    dropped += res.dropped.length;
    if (++done % 4 === 0) await new Promise((r) => setImmediate(r));
    if (o.onProgress) o.onProgress(done, list.length);
  }

  return { files: list.length, written, deleted, dropped, created };
}

/**
 * 扫描存档里所有区块的内容指纹（世界版本控制 / diff 的地基）。
 *
 * 结果形如 `{'0,0': {hash, bytes}}`，键是 `cx,cz`。
 * 只读、不改盘；每个 region 文件读完就释放，不会把整个存档读进内存。
 *
 * `onChunk` 是给世界版本控制用的：它在扫描的同时要把每个区块的**未压缩字节**
 * 收进内容寻址对象库。这些字节在这里本来就被解压出来算指纹了，回调等于白送，
 * 免得 worldver 再写一份「遍历 region + 解压」的重复实现出来。
 *
 * @param {{saveDir:string, dim?:string, kind?:string,
 *          onProgress?:(done:number, total:number)=>void,
 *          onChunk?:(key:string, raw:Buffer, bytes:number)=>void}} o
 * @returns {Promise<{index: Record<string, {hash:string, bytes:number}>, files:number,
 *                    chunks:number, broken:number, missing:boolean}>}
 */
async function scanSaveChunks(o) {
  const dir = dataDir(o.saveDir, o.dim, o.kind);
  const files = listRegionFiles(dir);
  /** @type {Record<string, {hash:string, bytes:number}>} */
  const index = {};
  let chunks = 0;
  let broken = 0;
  let done = 0;

  for (const f of files) {
    const buf = readRegionFile(f.file);
    if (buf) {
      const { entries, tooShort } = parseHeader(buf);
      if (!tooShort) {
        for (let i = 0; i < CHUNKS_PER_REGION; i++) {
          const e = entries[i];
          if (e.empty) continue;
          const payload = payloadSlice(buf, e);
          if (!payload) { broken++; continue; }
          let raw;
          try { raw = decompress(payload.slice(5), payload[4]); } catch { broken++; continue; }
          const cx = f.rx * SIDE + (i % SIDE);
          const cz = f.rz * SIDE + Math.floor(i / SIDE);
          const key = cx + ',' + cz;
          index[key] = { hash: hashOf(raw), bytes: payload.length };
          chunks++;
          if (o.onChunk) o.onChunk(key, raw, payload.length);
        }
      } else {
        broken++;
      }
    }
    if (++done % 8 === 0) await new Promise((r) => setImmediate(r));
    if (o.onProgress) o.onProgress(done, files.length);
  }

  return { index, files: files.length, chunks, broken, missing: !fs.existsSync(dir) };
}

module.exports = {
  SECTOR, HEADER_BYTES, SIDE, CHUNKS_PER_REGION, COMP, KIND, DIMS,
  AnvilError,
  chunkIndex, regionOf, regionFile, parseRegionName, dimInfo, dataDir,
  parseHeader, listChunks, payloadSlice, inspectEntry,
  decompress, pack,
  readRawByIndex, readRaw, readNbt, hashOf, chunkHash,
  empty, repack, setChunk, deleteChunk,
  readRegionFile, writeRegionFile,
  listRegionFiles, regionFilePath, readSaveChunk, writeSaveChunk, applySaveChunks, scanSaveChunks
};
