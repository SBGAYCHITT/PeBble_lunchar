// 测试用：最小 ZIP 生成器（store 模式，不压缩）
//
// 为什么不用 tar：GNU tar / MSYS tar **不能生成 zip 格式**（-a 只按扩展名挑已支持格式，
// 而它支持的只有 tar 系列）。Windows 自带的 bsdtar 能生成 zip，但 CI 的 Linux 上是 GNU tar，
// 所以"调 tar 造 zip"这条路在跨平台测试里必然翻车。
//
// 这里直接按 ZIP 规范手写，只用 Stored(0) 模式：
// 写 local file header + 数据 + central directory + EOCD。
// 顺带还能验证 zipread.js 的解析路径是否真的正确（比用真 jar 更可控）。

const fs = require('fs');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ (-1)) >>> 0;
}

/**
 * 生成 ZIP 文件
 * @param {string} outPath 输出路径
 * @param {Object<string,string|Buffer>} files 路径 → 内容（目录用 'a/b/c' 形式自动建）
 * @returns {string} outPath
 */
function writeZip(outPath, files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of Object.keys(files)) {
    const raw = files[name];
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    // ---- Local file header (30 bytes + name) ----
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);   // signature
    lfh.writeUInt16LE(20, 4);           // version needed
    lfh.writeUInt16LE(0, 6);            // flags
    lfh.writeUInt16LE(0, 8);            // method = 0 (stored)
    lfh.writeUInt16LE(0, 10);           // mod time
    lfh.writeUInt16LE(0x21, 12);        // mod date (1980-01-01 是 0，用 0x21 避免 0 值被某些解析器嫌弃)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size
    lfh.writeUInt32LE(data.length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);           // extra len

    chunks.push(lfh, nameBuf, data);

    // ---- Central directory record (46 bytes + name) ----
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);           // version made by
    cdh.writeUInt16LE(20, 6);           // version needed
    cdh.writeUInt16LE(0, 8);            // flags
    cdh.writeUInt16LE(0, 10);           // method
    cdh.writeUInt16LE(0, 12);           // time
    cdh.writeUInt16LE(0x21, 14);        // date
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);           // extra
    cdh.writeUInt16LE(0, 32);           // comment
    cdh.writeUInt16LE(0, 34);           // disk number
    cdh.writeUInt16LE(0, 36);           // internal attrs
    cdh.writeUInt32LE(0, 38);           // external attrs
    cdh.writeUInt32LE(offset, 42);      // offset of local header
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                        // disk
  eocd.writeUInt16LE(0, 6);                        // cd start disk
  eocd.writeUInt16LE(Object.keys(files).length, 8); // entries on this disk
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);                  // cd offset
  eocd.writeUInt16LE(0, 20);                       // comment len

  fs.mkdirSync(require('path').dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([Buffer.concat(chunks), cdBuf, eocd]));
  return outPath;
}

module.exports = { writeZip, crc32 };
