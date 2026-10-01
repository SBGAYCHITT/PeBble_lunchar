// 截图增强：读 PNG 头拿真实分辨率、算体积/时间，并支持按日期归档到子目录。
//
// 分辨率直接读 PNG 的 IHDR（第 16~23 字节是宽高的大端 uint32），
// 不需要引入任何图像库，也不用把整张几 MB 的图读进内存——只读前 24 字节。
const fs = require('fs');
const path = require('path');

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * 从 PNG 前 24 字节解析宽高（纯函数）
 * @param {Buffer} buf
 * @returns {{width:number,height:number}|null}
 */
function pngInfo(buf) {
  if (!buf || buf.length < 24) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

/** 读文件头部拿分辨率（失败返回 null，不抛） */
function pngInfoOfFile(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(24);
      const n = fs.readSync(fd, buf, 0, 24, 0);
      if (n < 24) return null;
      return pngInfo(buf);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** 归档用的日期键（纯函数）；mode: month(默认) / day / year */
function dateKey(ms, mode) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return 'unknown';
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  if (mode === 'year') return String(y);
  if (mode === 'day') return `${y}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${y}-${p(d.getMonth() + 1)}`;
}

/**
 * 生成归档计划（纯函数）
 * @param {Array<{path:string,name:string,mtime:number}>} files
 * @param {{baseDir:string, mode?:string}} o
 * @returns {Array<{from:string,to:string,key:string,name:string}>}
 */
function planOrganize(files, o) {
  const opt = /** @type {any} */ (o || {});
  const baseDir = opt.baseDir;
  if (!baseDir) return [];
  const mode = opt.mode || 'month';
  const used = new Map();
  const out = [];
  for (const f of files || []) {
    const key = dateKey(f.mtime, mode);
    let name = f.name;
    // 同名冲突自动加后缀，绝不覆盖玩家的原图
    const k = key + '/' + name;
    if (used.has(k)) {
      const n = used.get(k) + 1;
      used.set(k, n);
      const ext = path.extname(name);
      name = path.basename(name, ext) + ` (${n})` + ext;
    } else used.set(k, 0);
    const to = path.join(baseDir, key, name);
    if (path.resolve(to) !== path.resolve(f.path)) out.push({ from: f.path, to, key, name });
  }
  return out;
}

/** 汇总统计（纯函数） */
function stats(list) {
  const arr = list || [];
  let bytes = 0, earliest = null, latest = null;
  for (const f of arr) {
    bytes += f.size || 0;
    if (earliest == null || f.mtime < earliest) earliest = f.mtime;
    if (latest == null || f.mtime > latest) latest = f.mtime;
  }
  return { count: arr.length, bytes, earliest, latest };
}

/** 列出截图目录里的 PNG（含分辨率 / 体积 / 时间） */
function listWithMeta(gameDir) {
  const dir = path.join(gameDir || '', 'screenshots');
  if (!gameDir || !fs.existsSync(dir)) return [];
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!/\.png$/i.test(e.name)) continue;
    const p = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const dim = pngInfoOfFile(p);
    out.push({
      name: e.name, path: p, size: st.size, mtime: st.mtimeMs,
      width: dim ? dim.width : null, height: dim ? dim.height : null
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * 执行归档：把截图按日期移进子目录
 * @param {string} gameDir
 * @param {string} [mode] 'month' | 'day'
 * @returns {{ok:boolean, moved:number, skipped?:number, keys?:string[], failed?:Array, error?:string}}
 */
function organize(gameDir, mode) {
  const dir = path.join(gameDir || '', 'screenshots');
  if (!gameDir || !fs.existsSync(dir)) return { ok: false, moved: 0, error: '截图目录不存在' };
  const files = listWithMeta(gameDir).filter((f) => path.dirname(f.path) === path.resolve(dir));
  const plan = planOrganize(files, { baseDir: dir, mode: mode || 'month' });
  const keys = new Set();
  let moved = 0;
  const failed = [];
  for (const step of plan) {
    try {
      fs.mkdirSync(path.dirname(step.to), { recursive: true });
      fs.renameSync(step.from, step.to);
      keys.add(step.key);
      moved++;
    } catch (e) { failed.push({ from: step.from, error: e.message }); }
  }
  return { ok: failed.length === 0, moved, keys: Array.from(keys).sort(), failed };
}

module.exports = { pngInfo, pngInfoOfFile, dateKey, planOrganize, stats, listWithMeta, organize };
