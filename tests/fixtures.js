// 测试夹具：最小 zip 打包器（只用于造测试用的假 jar / 假资源包，不上生产）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 造一个 zip（Deflate 压缩）
 * @param {string} file 输出路径
 * @param {{name:string, data:string|Buffer}[]} entries
 */
function makeZip(file, entries) {
  const locals = [], central = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, name);

    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const body = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([body, cd, eocd]));
}

/** 一个"结构合法"的最小 PNG（只保证头部能被识别，不是真图片） */
function fakePng() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24)
  ]);
}

/* ---------- NBT：够用即可，只支持复合的读写不涉及的少量类型 ---------- */

function tag(type, name, payload) {
  const nb = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(3 + nb.length);
  head[0] = type;
  head.writeUInt16BE(nb.length, 1);
  nb.copy(head, 3);
  return Buffer.concat([head, payload]);
}
function tagString(name, value) {
  const vb = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(vb.length, 0);
  return tag(8, name, Buffer.concat([len, vb]));
}
function tagInt(name, value) {
  const v = Buffer.alloc(4);
  v.writeInt32BE(value, 0);
  return tag(3, name, v);
}

/**
 * 造一份能被 mcapi.readLevelDat 正确解析的 level.dat。
 * @param {{name?:string, version?:string, gameType?:number}} o
 */
function makeLevelDat(o) {
  o = o || {};
  const root = tag(10, '', Buffer.concat([
    tagString('LevelName', o.name || '测试世界'),
    tagString('Version', o.version || '1.20.1'),
    tagInt('GameType', o.gameType === undefined ? 0 : o.gameType),
    Buffer.from([0])            // TAG_End
  ]));
  return zlib.gzipSync(root);
}

module.exports = { makeZip, fakePng, crc32, makeLevelDat, tagString, tagInt };
