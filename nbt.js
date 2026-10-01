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

/* ---------- 解析 ---------- */
/**
 * 解析一个指定类型的载荷，返回 JS 值。
 * @param {Reader} r
 * @param {number} type
 * @returns {*}
 */
function readValue(r, type) {
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
      return out;
    }
    case T.STRING: return r.str();
    case T.LIST: {
      const et = r.u1();
      const n = r.i4();
      if (n < 0 || n > 1e8) throw new NbtError('LIST 长度异常: ' + n);
      if (et === T.END && n > 0) throw new NbtError('LIST 元素类型为 END 但长度 > 0');
      const arr = new Array(n);
      for (let i = 0; i < n; i++) arr[i] = readValue(r, et);
      return arr;
    }
    case T.COMPOUND: {
      const obj = {};
      for (;;) {
        const tt = r.u1();
        if (tt === T.END) break;
        const name = r.str();
        obj[name] = readValue(r, tt);
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
      return out;
    }
    default: throw new NbtError('未知 NBT 类型: ' + type);
  }
}

/**
 * 解析完整 NBT（含根名）。
 * @param {Buffer} buf 已解压的 NBT 数据
 * @returns {{name: string, value: object, type: number}}
 */
function parse(buf) {
  const r = new Reader(buf);
  const rootType = r.u1();
  if (rootType !== T.COMPOUND) {
    throw new NbtError('根标签必须是 COMPOUND，实际为 ' + (TYPE_NAME[rootType] || rootType));
  }
  const name = r.str();
  const value = readValue(r, T.COMPOUND);
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

function writeValue(w, v, type) {
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
      if (v.length === 0) {
        w.u1(T.END);
        w.i4(0);
        break;
      }
      const et = tagOf(v[0]);
      if (et === null) throw new NbtError('LIST 元素无法推断类型: ' + String(v[0]));
      w.u1(et);
      w.i4(v.length);
      for (const item of v) {
        const it = tagOf(item);
        if (it !== et) throw new NbtError('LIST 元素类型不一致（NBT 要求同类型）');
        writeValue(w, item, et);
      }
      break;
    }
    case T.COMPOUND: {
      for (const [k, sub] of Object.entries(v)) {
        const st = tagOf(sub);
        if (st === null) throw new NbtError('COMPOUND 字段 ' + k + ' 无法推断类型');
        w.u1(st);
        w.str(k);
        writeValue(w, sub, st);
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
 * @returns {Buffer}
 */
function serialize(rootName, value) {
  const w = new Writer();
  w.u1(T.COMPOUND);
  w.str(rootName);
  writeValue(w, value, T.COMPOUND);
  return w.done();
}

module.exports = {
  T, TYPE_NAME, NbtError,
  decompress, parse, parseAuto,
  countEntities, levelDatFields,
  tagOf, serialize,
  /* 内部件，供单测直接验证边界行为 */
  _Reader: Reader, _skip: skip, _readValue: readValue
};
