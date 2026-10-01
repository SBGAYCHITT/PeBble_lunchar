// Pebble Lunchar - 极简 ZIP 读取器
//
// 为什么要自己写：为了读 mod jar 里的 fabric.mod.json / mods.toml，或者资源包里的
// pack.png，我们需要在不解压整个文件、也不引入第三方依赖的前提下随机读取 ZIP 内的
// 单个条目。Node 标准库没有 ZIP 能力，装 adm-zip/yauzl 又要多一个依赖和一层打包风险。
// 这里只实现"读"，不实现"写"，100 行以内够用。
//
// 支持 Stored(0) 与 Deflate(8)。ZIP64 的 jar 极其罕见，遇到了安全降级（返回空列表）。

const fs = require('fs');
const zlib = require('zlib');

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** 定位 EOCD 并解析出中央目录条目 */
function listEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) return [];

    // EOCD 在文件尾部（评论最多 64KB），从后往前找
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return [];

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    // ZIP64：偏移被置为 0xFFFFFFFF，本读取器不处理
    if (cdOff === 0xffffffff || cdSize === 0xffffffff) return [];
    if (cdOff + cdSize > size) { cdSize = size - cdOff; } // 容忍尾部有垃圾数据
    if (cdOff < 0 || cdSize <= 0) return [];

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);

    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CDH_SIG) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const lfhOff = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      out.push({ name, method, compSize, size: rawSize, offset: lfhOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/** 从已打开的 fd 里读出某个条目的内容（Buffer）；失败返回 null */
function readEntry(fd, entry) {
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.offset);
    if (head.readUInt32LE(0) !== LFH_SIG) return null;
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = entry.offset + 30 + nameLen + extraLen;
    const buf = Buffer.alloc(entry.compSize);
    fs.readSync(fd, buf, 0, entry.compSize, start);
    if (entry.method === 0) return buf;
    if (entry.method === 8) return zlib.inflateRawSync(buf);
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 zip/jar 中读取第一个存在的条目
 * @param {string} file zip 路径
 * @param {string[]} names 候选条目名，按顺序尝试
 * @returns {{name:string, data:Buffer}|null}
 */
function readFirst(file, names) {
  const entries = listEntries(file);
  if (!entries.length) return null;
  const fd = fs.openSync(file, 'r');
  try {
    for (const want of names) {
      const e = entries.find((x) => x.name === want);
      if (!e) continue;
      const data = readEntry(fd, e);
      if (data) return { name: e.name, data };
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

/** 按后缀过滤条目名（例如找 pack.png） */
function findEntries(file, predicate) {
  try {
    return listEntries(file).filter(predicate);
  } catch {
    return [];
  }
}

module.exports = { listEntries, readEntry, readFirst, findEntries };
