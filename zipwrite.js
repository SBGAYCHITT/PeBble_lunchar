// Pebble Lunchar - 最小 ZIP 写入器（生产模块）
//
// 为什么不用系统 tar：
//   Windows 自带的 bsdtar 能靠 `-a -cf x.zip` 生成 zip，看着很方便。
//   但实际踩过两次坑：
//     ① MSYS/GNU tar **根本不支持 zip 格式** —— `-a` 只按扩展名挑"已支持的格式"，
//        而它支持的只有 tar 系列。结果是命令行"成功"了，产物 magic 却是 `2e2f0000`（`./`），
//        一个 tar 文件顶着 .zip 后缀。
//     ② MSYS tar 会把 `C:\...` 当成**远程主机名**，报 `Cannot connect to C: resolve failed`
//        —— 它把冒号前的 `C` 当成了 rsh 目标。传绝对路径给 `-C` 就必炸。
//   这两条都取决于"用户机器上哪个 tar 先被 PATH 找到"，不可控。
//   所以导出这类**决定产物品能不能被别的启动器读**的操作，自己写最稳。
//
// 只实现需要的部分：Deflate（method 8）+ Stored（method 0）回退。
// 不写 Zip64（32 位足以，整合包不可能到 4GB）；不做分卷、不做加密。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/** CRC-32（ZIP 用的那个多项式）。
 *  ⚠️ 必须 `>>> 0` —— JS 位运算是 32 位**有符号**的，`c ^ -1` 会得到负数，
 *  写进 `writeUInt32LE` 直接抛 "value out of range"。 */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** JS Date → DOS 时间/日期（ZIP 头里用） */
function dosTime(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date: date & 0xffff, time: time & 0xffff };
}

/**
 * 把一批内存条目写成 zip 文件
 * @param {string} outPath
 * @param {{name:string, data:string|Buffer}[]} entries 顺序即写入顺序
 * @param {{level?:number, mtime?:Date}} [opts] level=0 时不压缩
 * @returns {{size:number, count:number, rawTotal:number}} rawTotal 是压缩前总字节（用于估算压缩率）
 */
function writeZipEntries(outPath, entries, opts) {
  const o = opts || {};
  const level = o.level === undefined ? 9 : o.level;
  const mtime = o.mtime || new Date();

  const locals = [];
  const central = [];
  let off = 0;
  let rawTotal = 0;

  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    // 目录项（以 / 结尾且无内容）不进这里 —— 调用方传的是文件
    const name = e.name.replace(/\\/g, '/');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    // 小文件压了反而更大（deflate 头开销 2~5 字节），且 Stored 能让别的工具直读
    let comp = raw;
    let method = 0;
    if (level > 0 && raw.length > 32) {
      const def = zlib.deflateRawSync(raw, { level });
      if (def.length < raw.length) { comp = def; method = 8; }
    }

    const { date, time } = dosTime(mtime);
    rawTotal += raw.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // flags: bit11 = UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);    // version made by: 3 = unix, 0x1e = 3.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);        // extra
    ch.writeUInt16LE(0, 32);        // comment
    ch.writeUInt16LE(0, 34);        // disk
    ch.writeUInt16LE(0, 36);        // internal attrs
    // external attrs：高 16 位是 unix 权限。`<< 16` 会溢出成负数，必须 `>>> 0`。
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(off, 42);
    central.push(ch, nameBuf);

    off += lh.length + nameBuf.length + comp.length;
  }

  const body = Buffer.concat(locals);
  const cd = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = Buffer.concat([body, cd, eocd]);
  fs.writeFileSync(outPath, out);
  return { size: out.length, count: entries.length, rawTotal };
}

/**
 * 把一棵目录树打成 zip（保留相对路径）
 * @param {string} outPath
 * @param {string} rootDir
 * @param {{level?:number, skip?:(rel:string)=>boolean}} [opts]
 */
function zipDir(outPath, rootDir, opts) {
  const o = opts || {};
  const entries = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const a = path.join(abs, name);
      const r = rel ? rel + '/' + name : name;
      let st;
      try { st = fs.statSync(a); } catch { continue; }
      if (st.isDirectory()) { walk(a, r); continue; }
      if (!st.isFile()) continue;
      if (o.skip && o.skip(r)) continue;
      entries.push({ name: r, data: fs.readFileSync(a) });
    }
  };
  if (fs.existsSync(rootDir)) walk(rootDir, '');
  return writeZipEntries(outPath, entries, { level: o.level });
}

module.exports = { writeZipEntries, zipDir, crc32 };
