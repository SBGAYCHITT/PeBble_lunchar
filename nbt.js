/**
 * Minecraft NBT 读写（零依赖）。
 *
 * 背景：此前项目里有**两套重复的 NBT 实现**——
 *   - mcapi.parseNBT：为 level.dat 定制，把根结构硬编码成几个字段，且丢弃 byte/int/long 数组内容
 *   - savetimemachine.countEntitiesInChunk：只跳读不建树的实体计数器
 * 两处都缺边界检查，遇到损坏的区块会静默读出错误结果（甚至死循环风险）。
 *
 * 这里统一成一份：完整解析 + 跳读 + 编码，全部带越界检查。
 * 对外接口保持与旧实现兼容，调用方（mcapi / savetimemachine）改为复用本模块。
 *
 * @module nbt
 */

const zlib = require('zlib');

/* ---------- 标签类型 ---------- */
const T = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
};

const TYPE_NAME = {
  0: 'END', 1: 'BYTE', 2: 'SHORT', 3: 'INT', 4: 'LONG', 5: 'FLOAT', 6: 'DOUBLE',
  7: 'BYTE_ARRAY', 8: 'STRING', 9: 'LIST', 10: 'COMPOUND', 11: 'INT_ARRAY', 12: 'LONG_ARRAY'
};

class NbtError extends Error {
  constructor(msg) { super(msg); this.name = 'NbtError'; }
}

/* ---------- 解压：level.dat 可能是 gzip / zlib / 未压缩 ---------- */
/**
 * 自动识别并解压 NBT 数据。识别不了就原样返回（交给解析器报具体的错）。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function decompress(buf) {
  if (!Buffer.isBuffer(buf)) throw new NbtError('decompress: 需要 Buffer');
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch (e) { throw new NbtError('gzip 解压失败: ' + e.message); }
  }
  // zlib 头：CMF 低 4 位必须是 8（deflate），且 (CMF*256+FLG) % 31 === 0
  if (buf.length >= 2 && (buf[0] & 0x0f) === 8 && ((buf[0] << 8) | buf[1]) % 31 === 0) {
    try { return zlib.inflateSync(buf); } catch (e) { throw new NbtError('zlib 解压失败: ' + e.message); }
  }
  return buf;
}

/* ---------- 读取器（带边界检查） ---------- */
class Reader {
  /** @param {Buffer} buf */
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) throw new NbtError('需要 Buffer');
    this.buf = buf;
    this.p = 0;
    this.size = buf.length;
  }

  need(n) {
    if (this.p + n > this.size) {
      throw new NbtError(`数据越界：需要 ${n} 字节，偏移 ${this.p}，总长 ${this.size}`);
    }
  }

  u1() { this.need(1); return this.buf[this.p++]; }
  i1() { this.need(1); return this.buf.readInt8(this.p++); }
  i2() { this.need(2); const v = this.buf.readInt16BE(this.p); this.p += 2; return v; }
  i4() { this.need(4); const v = this.buf.readInt32BE(this.p); this.p += 4; return v; }
  u4() { this.need(4); const v = this.buf.readUInt32BE(this.p); this.p += 4; return v; }
  /** long 统一转 Number：NBT 里的 long 基本都是时间戳/坐标，Number 够用且不破坏既有调用方 */
  i8() { this.need(8); const v = Number(this.buf.readBigInt64BE(this.p)); this.p += 8; return v; }
  f4() { this.need(4); const v = this.buf.readFloatBE(this.p); this.p += 4; return v; }
  f8() { this.need(8); const v = this.buf.readDoubleBE(this.p); this.p += 8; return v; }

  u2() { this.need(2); const v = this.buf.readUInt16BE(this.p); this.p += 2; return v; }

  str() {
    const len = this.u2();
    this.need(len);
    const s = this.buf.toString('utf8', this.p, this.p + len);
    this.p += len;
    return s;
  }
}

/* ---------- 跳读：只为推进偏移，不构造对象 ---------- */
/**
 * 跳过一个指定类型的载荷。用于「只需要某个字段」的场景（如区块实体计数），
 * 避免为几 MB 的区块构造完整对象树。
 * @param {Reader} r
 * @param {number} type
 */
function skip(r, type) {
  switch (type) {
    case T.BYTE: r.p += 1; break;
    case T.SHORT: r.p += 2; break;
    case T.INT: r.p += 4; break;
    case T.LONG: r.p += 8; break;
    case T.FLOAT: r.p += 4; break;
    case T.DOUBLE: r.p += 8; break;
    case T.BYTE_ARRAY: { const n = r.i4(); r.need(n); r.p += n; break; }
    case T.STRING: { const len = r.u2(); r.need(len); r.p += len; break; }
    case T.LIST: {
      const et = r.u1();
      const n = r.i4();
      // 负数/超大长度是损坏数据的典型特征，提前拦掉而不是循环几十亿次
      if (n < 0 || n > 1e8) throw new NbtError('LIST 长度异常: ' + n);
      if (et === T.END && n > 0) throw new NbtError('LIST 元素类型为 END 但长度 > 0');
      for (let i = 0; i < n; i++) skip(r, et);
      break;
    }
    case T.COMPOUND: {
      for (;;) {
        const tt = r.u1();
        if (tt === T.END) break;
        r.str();            // 字段名
        skip(r, tt);
      }
      break;
    }
    case T.INT_ARRAY: { const n = r.i4(); if (n < 0 || n > 1e8) throw new NbtError('INT_ARRAY 长度异常: ' + n); r.need(n * 4); r.p += n * 4; break; }
    case T.LONG_ARRAY: { const n = r.i4(); if (n < 0 || n > 1e8) throw new NbtError('LONG_ARRAY 长度异常: ' + n); r.need(n * 8); r.p += n * 8; break; }
    default: throw new NbtError('未知 NBT 类型: ' + type);
  }
  if (r.p > r.size) throw new NbtError('跳读越界');
}

/* ---------- 类型旁路表：让「解析 → 改一点 → 写回」不改变原来的类型 ---------- */
/**
 * 类型旁路表。
 *
 * 三张表各管一段：
 *   · comp —— COMPOUND 的每个字段原名原来是哪个类型（SHORT/INT/BYTE…都长得一样）；
 *   · list —— LIST 的元素类型（空列表尤其需要：除了头部那一字节没地方记得住）；
 *   · node —— 节点整体是什么类型（LONG_ARRAY 在 JS 里就是个普通 Array，和 LIST 无法区分）。
 *
 * 之所以定义成一个具名 typedef，是因为这些表要在 readValue / writeValue / parse /
 * serialize 之间一路传下去 —— 每处都手抄一遍内联类型，抄漏一个字段（`node` 就漏过）
 * 就会在真正读写的那几行报一堆 "Property 'node' does not exist"，
 * 而错误位置离"类型标注写少了"这个真因很远。
 *
 * @typedef {object} NbtTypeTable
 * @property {WeakMap<object, Map<string, number>>} comp
 * @property {WeakMap<any[], number>} list
 * @property {WeakMap<object, number>} node
 */
/**
 * NBT 的类型有一大半在 JS 里是**看不见**的：
 *   · SHORT / INT / BYTE / LONG 到 JS 全是 number；
 *   · LIST 的元素类型只存在于头部那一个字节里，连空列表都能带类型。
 * 于是"解析 → 改一个字段 → 写回"这条路会**静默改类型**。
 * 最要命的一例：区块的 `PostProcessing` 是 LIST of SHORT，里面存的全是 0，
 * 写回时按 JS 值推断成 LIST of INT —— Minecraft 读区块时期望 TAG_Short，
 * 拿到 TAG_Int 直接抛异常。用户看到的是"存档区块损坏"，离真正的原因十万八千里。
 *
 * 所以解析时可以顺便把类型记进一张旁路表，写回时优先按原类型编码。
 * 表只记「JS 值看不出来」的几处，数值本身不需要身份 —— 知道"这个位置原本是 SHORT"就够了：
 *   comp: WeakMap<COMPOUND 对象, Map<字段名, 原类型>>
 *   list: WeakMap<LIST 数组, 元素类型>
 *   node: WeakMap<对象|数组, 它整体是什么类型>
 * 解析器新造出来的节点不在表里，自然回退到值推断（新数据本来就没有"原类型"）。
 *
 * node 表解决的是另一类坑：**LONG_ARRAY 在 JS 里就是一个普通 Array**，
 * 和 LIST 长得一模一样。解析时它是 LONG_ARRAY、写回时按值推断会变成 LIST of LONG。
 * 更麻烦的是"换了新数组"这种写法 —— `c.data = encode(...)` 造出来的数组不在任何表里，
 * 于是必须显式登记。有了 node 表，`types.node.set(newArr, T.LONG_ARRAY)` 就能表达清楚。
 *
 * ⚠️ 使用约束：**改数组内容优先原地改**（`arr[i] = v` / `push` / `length = 0`）。
 * 直接换新数组对象时必须自己登记 node 表，否则类型就丢了。
 * @returns {NbtTypeTable}
 */
function newTypes() {
  return { comp: new WeakMap(), list: new WeakMap(), node: new WeakMap() };
}

/**
 * 值能不能无损放进某个 NBT 类型。
 * 不能像写回那样直接用 tagOf 比对：SHORT 里存的 0 推断出来是 INT，
 * 拿 tagOf 校验会把**所有合法数据都判成非法**。对数值只能按取值范围判。
 * @param {*} v
 * @param {number} type
 * @returns {boolean}
 */
function fitsType(v, type) {
  switch (type) {
    case T.BYTE: return typeof v === 'boolean' || (typeof v === 'number' && Number.isInteger(v) && v >= -128 && v <= 127);
    case T.SHORT: return typeof v === 'number' && Number.isInteger(v) && v >= -32768 && v <= 32767;
    case T.INT: return typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
    // LONG 用 Number 承载时要求落在安全整数内，否则低位已经丢了，写回去是错的
    case T.LONG: return typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v));
    case T.FLOAT: case T.DOUBLE: return typeof v === 'number' && Number.isFinite(v);
    case T.STRING: return typeof v === 'string';
    case T.BYTE_ARRAY: return v instanceof Int8Array || Array.isArray(v);
    case T.INT_ARRAY: return v instanceof Int32Array || Array.isArray(v);
    case T.LONG_ARRAY: return v instanceof BigInt64Array || Array.isArray(v);
    case T.LIST: return Array.isArray(v);
    case T.COMPOUND: return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return false;
  }
}

/* ---------- 解析 ---------- */
/**
 * 解析一个指定类型的载荷，返回 JS 值。
 * @param {Reader} r
 * @param {number} type
 * @param {NbtTypeTable} [types]
 *   可选的类型旁路表；给了就把「值推断不出来的类型」记进去
 * @returns {*}
 */
function readValue(r, type, types) {
  switch (type) {
    case T.BYTE: return r.i1();
    case T.SHORT: return r.i2();
    case T.INT: return r.i4();
    case T.LONG: return r.i8();
    case T.FLOAT: return r.f4();
    case T.DOUBLE: return r.f8();
    case T.BYTE_ARRAY: {
      const n = r.i4();
      if (n < 0 || n > 1e8) throw new NbtError('BYTE_ARRAY 长度异常: ' + n);
      r.need(n);
      const out = new Int8Array(n);
      for (let i = 0; i < n; i++) out[i] = r.buf.readInt8(r.p + i);
      r.p += n;
      if (types) types.node.set(out, T.BYTE_ARRAY);
      return out;
    }
    case T.STRING: return r.str();
    case T.LIST: {
      const et = r.u1();
      const n = r.i4();
      if (n < 0 || n > 1e8) throw new NbtError('LIST 长度异常: ' + n);
      if (et === T.END && n > 0) throw new NbtError('LIST 元素类型为 END 但长度 > 0');
      const arr = new Array(n);
      // 元素类型先记账：空列表连一个元素都没有，除了这里没有任何地方还记得它是什么类型
      if (types) { types.list.set(arr, et); types.node.set(arr, T.LIST); }
      for (let i = 0; i < n; i++) arr[i] = readValue(r, et, types);
      return arr;
    }
    case T.COMPOUND: {
      const obj = {};
      const fieldTypes = types ? new Map() : null;
      if (types) { types.comp.set(obj, fieldTypes); types.node.set(obj, T.COMPOUND); }
      for (;;) {
        const tt = r.u1();
        if (tt === T.END) break;
        const name = r.str();
        if (fieldTypes) fieldTypes.set(name, tt);
        obj[name] = readValue(r, tt, types);
      }
      return obj;
    }
    case T.INT_ARRAY: {
      const n = r.i4();
      if (n < 0 || n > 1e8) throw new NbtError('INT_ARRAY 长度异常: ' + n);
      r.need(n * 4);
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) out[i] = r.buf.readInt32BE(r.p + i * 4);
      r.p += n * 4;
      if (types) types.node.set(out, T.INT_ARRAY);
      return out;
    }
    case T.LONG_ARRAY: {
      const n = r.i4();
      if (n < 0 || n > 1e8) throw new NbtError('LONG_ARRAY 长度异常: ' + n);
      r.need(n * 8);
      // 必须以 BigInt 返回：方块状态 / 生物群系的高度打包数组里单个 long 常超过 Number 的安全整数
      // (2^53)。转成 Number 会丢低位，导致方块索引解码错误。Time 等单 LONG 仍走 Number（见 readValue 的 LONG 分支）。
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = r.buf.readBigInt64BE(r.p + i * 8);
      r.p += n * 8;
      // 这个数组在 JS 里和 LIST 长得一样，必须靠 node 表记下它的真身
      if (types) types.node.set(out, T.LONG_ARRAY);
      return out;
    }
    default: throw new NbtError('未知 NBT 类型: ' + type);
  }
}

/**
 * 解析完整 NBT（含根名）。
 * @param {Buffer} buf 已解压的 NBT 数据
 * @param {NbtTypeTable} [types]
 *   可选。给了就把每个字段/LIST 的原始类型记进这张表，配合 serialize 使用可以做到
 *   「只改指定字段、其余字节一个不动」（见文件顶部「类型旁路表」）
 * @returns {{name: string, value: object, type: number}}
 */
function parse(buf, types) {
  const r = new Reader(buf);
  const rootType = r.u1();
  if (rootType !== T.COMPOUND) {
    throw new NbtError('根标签必须是 COMPOUND，实际为 ' + (TYPE_NAME[rootType] || rootType));
  }
  const name = r.str();
  const value = readValue(r, T.COMPOUND, types);
  return { name, value, type: rootType };
}

/**
 * 一步到位：自动解压 + 解析，只返回根 compound 的值。
 * @param {Buffer} buf
 * @returns {object}
 */
function parseAuto(buf) {
  return parse(decompress(buf)).value;
}

/**
 * 只统计区块里的实体数（Entities / block_entities），其余内容全部跳过。
 * 用于存档健康检查定位 lag 源头——不能为此构造完整对象树。
 * @param {Buffer} buf 已解压的区块 NBT
 * @returns {number}
 */
function countEntities(buf) {
  const r = new Reader(buf);
  // 空区块不是「损坏」，别当成异常抛出去（region 里确实存在 0 长度条目）
  if (r.size === 0) return 0;
  const rt = r.u1();
  if (rt !== T.COMPOUND) return 0;
  r.str(); // 根名
  let total = 0;
  for (;;) {
    const t = r.u1();
    if (t === T.END) break;
    const name = r.str();
    if ((name === 'Entities' || name === 'block_entities') && t === T.LIST) {
      const et = r.u1();
      const n = r.i4();
      if (n > 0) total += n;
      // 列表里的元素还要继续跳过，否则偏移就乱了
      for (let i = 0; i < n; i++) skip(r, et);
    } else {
      skip(r, t);
    }
  }
  return total;
}

/* ---------- level.dat 字段提取（保持 mcapi.parseNBT 的既有契约） ---------- */
/**
 * 从 level.dat 的解析结果里取出 UI 需要的字段，并套上 .Data 兼容。
 * 旧实现把字段硬编码在解析器里，这里拆开：解析器只管解析，字段提取是独立纯函数（可测）。
 * @param {object} tree parseAuto 的结果
 * @returns {{LevelName:*, Version:string, GameType:*, hardcore:*, allowCommands:*, LastPlayed:*, Time:*, Difficulty:*}|null}
 */
function levelDatFields(tree) {
  if (!tree || typeof tree !== 'object') return null;
  const data = tree.Data && typeof tree.Data === 'object' ? tree.Data : tree;
  let version = '';
  if (data.Version && typeof data.Version === 'object') version = data.Version.Name || '';
  else if (data.Version != null) version = String(data.Version);
  return {
    LevelName: data.LevelName,
    Version: version,
    GameType: data.GameType,
    hardcore: data.hardcore,
    allowCommands: data.allowCommands,
    LastPlayed: data.LastPlayed,
    Time: data.Time,
    Difficulty: data.Difficulty
  };
}

/* ---------- 编码 ---------- */
/** 由 JS 值推断 NBT 类型；推断不出返回 null（调用方应当报错而不是猜） */
function tagOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return T.BYTE;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return (v >= -2147483648 && v <= 2147483647) ? T.INT : T.LONG;
    return T.DOUBLE;
  }
  if (typeof v === 'bigint') return T.LONG;
  if (typeof v === 'string') return T.STRING;
  if (v instanceof Int8Array) return T.BYTE_ARRAY;
  if (v instanceof Int32Array) return T.INT_ARRAY;
  if (v instanceof BigInt64Array) return T.LONG_ARRAY;
  if (Array.isArray(v)) return T.LIST;
  if (typeof v === 'object') return T.COMPOUND;
  return null;
}

class Writer {
  constructor() { this.parts = []; }
  u1(v) { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); this.parts.push(b); }
  i1(v) { const b = Buffer.alloc(1); b.writeInt8(v); this.parts.push(b); }
  i2(v) { const b = Buffer.alloc(2); b.writeInt16BE(v); this.parts.push(b); }
  i4(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.parts.push(b); }
  i8(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.parts.push(b); }
  f4(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.parts.push(b); }
  f8(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.parts.push(b); }
  str(s) {
    const body = Buffer.from(String(s), 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length);
    this.parts.push(len, body);
  }
  done() { return Buffer.concat(this.parts); }
}

/**
 * 把一个值按指定类型写出去。
 * @param {Writer} w
 * @param {*} v
 * @param {number} type
 * @param {NbtTypeTable} [types]
 *   类型旁路表。有记录就用记录里的类型，没有才按 JS 值推断。
 *   类型不符时**直接报错**——这里宁可炸，也不能写出一个"类型不对但能存进去"的区块，
 *   那种数据在游戏里的报错离现场太远（用户只会看到"区块损坏"）。
 */
function writeValue(w, v, type, types) {
  switch (type) {
    case T.BYTE: w.i1(typeof v === 'boolean' ? (v ? 1 : 0) : v); break;
    case T.SHORT: w.i2(v); break;
    case T.INT: w.i4(v); break;
    case T.LONG: w.i8(v); break;
    case T.FLOAT: w.f4(v); break;
    case T.DOUBLE: w.f8(v); break;
    case T.BYTE_ARRAY: {
      w.i4(v.length);
      const b = Buffer.alloc(v.length);
      for (let i = 0; i < v.length; i++) b.writeInt8(v[i], i);
      w.parts.push(b);
      break;
    }
    case T.STRING: w.str(v); break;
    case T.LIST: {
      const known = types ? types.list.get(v) : undefined;
      if (v.length === 0) {
        // 空列表的元素类型只能来自旁路表；没有记录时写 END（NBT 允许的空列表形态）
        w.u1(known === undefined ? T.END : known);
        w.i4(0);
        break;
      }
      const et = known === undefined ? tagOf(v[0]) : known;
      if (et === null || et === undefined) throw new NbtError('LIST 元素无法推断类型: ' + String(v[0]));
      w.u1(et);
      w.i4(v.length);
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (!fitsType(item, et)) {
          throw new NbtError('LIST 第 ' + i + ' 项放不进 ' + TYPE_NAME[et] + ': ' + String(item));
        }
        writeValue(w, item, et, types);
      }
      break;
    }
    case T.COMPOUND: {
      const known = types ? types.comp.get(v) : undefined;
      for (const [k, sub] of Object.entries(v)) {
        // 类型优先级：这个字段原本是什么 → 这个节点整体是什么 → 按值推断。
        // 中间那层是给「换了新对象/新数组」留的：解析时记的字段表已经对不上了，
        // 但调用方可以用 node 表显式告诉他新节点是什么。
        let st = known ? known.get(k) : undefined;
        if (st === undefined && types && sub && typeof sub === 'object') st = types.node.get(sub);
        if (st === undefined) st = tagOf(sub);
        if (st === null || st === undefined) throw new NbtError('COMPOUND 字段 ' + k + ' 无法推断类型');
        if (!fitsType(sub, st)) {
          throw new NbtError('COMPOUND 字段 ' + k + ' 放不进 ' + TYPE_NAME[st] + ': ' + String(sub));
        }
        w.u1(st);
        w.str(k);
        writeValue(w, sub, st, types);
      }
      w.u1(T.END);
      break;
    }
    case T.INT_ARRAY: {
      w.i4(v.length);
      const b = Buffer.alloc(v.length * 4);
      for (let i = 0; i < v.length; i++) b.writeInt32BE(v[i], i * 4);
      w.parts.push(b);
      break;
    }
    case T.LONG_ARRAY: {
      w.i4(v.length);
      const b = Buffer.alloc(v.length * 8);
      for (let i = 0; i < v.length; i++) b.writeBigInt64BE(BigInt(v[i]), i * 8);
      w.parts.push(b);
      break;
    }
    default: throw new NbtError('无法编码类型: ' + type);
  }
}

/**
 * 编码成 NBT 字节流（未压缩）。
 * @param {string} rootName 根名
 * @param {object} value 根 compound
 * @param {NbtTypeTable} [types]
 *   类型旁路表（parse 时产出的那张）。给了就按原类型编码 —— 这是"只改一个字段、
 *   不改变其它任何字节"的关键；不给则全部按 JS 值推断。
 * @returns {Buffer}
 */
function serialize(rootName, value, types) {
  const w = new Writer();
  w.u1(T.COMPOUND);
  w.str(rootName);
  writeValue(w, value, T.COMPOUND, types);
  return w.done();
}

/**
 * 解析 + 立刻原样写回，用来验证「保类型编码」是否真的无损。
 * 不是给生产路径用的（没人需要为了写回去先写回来），纯粹是让自检和测试有个
 * 一步就能跑的动作：结果和输入不相等，就说明类型保真还有漏。
 * @param {Buffer} buf
 * @returns {{name:string, value:object, types:object, out:Buffer, identical:boolean}}
 */
function roundTrip(buf) {
  const types = newTypes();
  const r = parse(buf, types);
  const out = serialize(r.name, r.value, types);
  return { name: r.name, value: r.value, types, out, identical: out.equals(buf) };
}

module.exports = {
  T, TYPE_NAME, NbtError,
  decompress, parse, parseAuto,
  countEntities, levelDatFields,
  tagOf, serialize, newTypes, fitsType, roundTrip,
  /* 内部件，供单测直接验证边界行为 */
  _Reader: Reader, _skip: skip, _readValue: readValue
};
