// Pebble Lunchar - 资源包 / 光影包的「看得见」信息
//
// 为什么需要它：资源页现在只有文件名，用户面对一堆 `§x.zip` 根本分不清谁是谁。
// 资源包真正的名字、描述、图标都在包内的 pack.mcmeta + pack.png 里，
// 光影包则是 zip（或目录）里的 shaders/ 目录。
//
// 只读、零依赖：复用 zipread.js 随机读取包内条目，不解压整个包。
// 目录形式的资源包（未解压，改起来方便，非常常见）也一并支持。

const fs = require('fs');
const path = require('path');
const { readFirst, listEntries } = require('./zipread');
const { cmpVer } = require('./modguard');

/* ---------- pack_format → 适用 MC 版本区间 ----------
 * 官方 wiki 的 Resource Pack format 表。区间用 [最低, 最高] 表示。
 * 超出已知范围的返回 null，由调用方降级显示「未知格式 N」，不乱猜。
 */
const PACK_FORMATS = {
  1: ['1.6.1', '1.8.9'],
  2: ['1.9', '1.10.2'],
  3: ['1.11', '1.12.2'],
  4: ['1.13', '1.14.4'],
  5: ['1.15', '1.16.1'],
  6: ['1.16.2', '1.16.5'],
  7: ['1.17', '1.17.1'],
  8: ['1.18', '1.18.2'],
  9: ['1.19', '1.19.2'],
  10: ['1.19.3', '1.19.3'],
  11: ['1.19.4', '1.19.4'],
  12: ['1.20', '1.20.1'],
  13: ['1.20.2', '1.20.2'],
  14: ['1.20.3', '1.20.4'],
  15: ['1.20.5', '1.20.6'],
  16: ['1.21', '1.21.1'],
  17: ['1.21.2', '1.21.3'],
  18: ['1.21.4', '1.21.4'],
  19: ['1.21.5', '1.21.5']
};

/** pack_format 对应的人类可读版本区间；未知返回 null */
function formatRange(fmt) {
  const r = PACK_FORMATS[fmt];
  if (!r) return null;
  return r[0] === r[1] ? r[0] : `${r[0]} – ${r[1]}`;
}

/**
 * 当前 MC 版本是否落在该 pack_format 支持的区间内
 * @param {number} fmt
 * @param {string} mc 例如 "1.20.1"；快照/未知一律返回 null（不误报）
 * @returns {boolean|null}
 */
function formatMatches(fmt, mc) {
  const r = PACK_FORMATS[fmt];
  if (!r || !mc) return null;
  // 快照版（1.20-pre1 / 24w14a 等）没法稳定比较，不判定
  if (!/^\d+\.\d+(\.\d+)?$/.test(mc)) return null;
  return cmpVer(mc, r[0]) >= 0 && cmpVer(mc, r[1]) <= 0;
}

/* ---------- mcmeta ---------- */

/** description 可能是字符串，也可能是文本组件对象（{"text":"..."} / 数组） */
function flattenDesc(d) {
  if (!d && d !== 0) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(flattenDesc).join('');
  if (typeof d === 'object') {
    if (typeof d.text === 'string') return d.text;
    if (typeof d.translate === 'string') return d.translate;
    if (Array.isArray(d.extra)) return d.extra.map(flattenDesc).join('');
    // 键/值混排的旧格式，兜底取第一个字符串
    for (const v of Object.values(d)) {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map(flattenDesc).join('');
    }
  }
  return String(d);
}

/** pack.mcmeta 里的注释不是合法 JSON，容错剥掉行注释再解析 */
function parseMcmeta(text) {
  let s = String(text || '').trim();
  try { return JSON.parse(s); } catch {}
  try {
    s = s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(s);
  } catch { return null; }
}

/* ---------- 图标 ---------- */
const ICON_MAX = 2 * 1024 * 1024; // 异常大的图标直接放弃，别把整个包读进内存

function toDataUrl(buf) {
  if (!buf || !buf.length || buf.length > ICON_MAX) return null;
  // 只认 PNG/JPEG，避免把任意二进制塞进 data: URL
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG';
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpg) return null;
  return `data:${isPng ? 'image/png' : 'image/jpeg'};base64,${buf.toString('base64')}`;
}

function readIconFromZip(file) {
  const hit = readFirst(file, ['pack.png', 'pack.jpg', 'pack.jpeg', 'preview.png', 'preview.jpg']);
  return hit ? toDataUrl(hit.data) : null;
}

function readIconFromDir(dir) {
  for (const n of ['pack.png', 'pack.jpg', 'pack.jpeg', 'preview.png', 'preview.jpg']) {
    const p = path.join(dir, n);
    try {
      if (!fs.statSync(p).isFile()) continue;
      const d = toDataUrl(fs.readFileSync(p));
      if (d) return d;
    } catch {}
  }
  return null;
}

/* ---------- 包内容概览（光影用） ---------- */
const GLSL = /\.(glsl|fsh|vsh|gsh|csh|frag|vert)$/i;

/** 统计 zip 里 shaders/ 下的着色器数量；没有 shaders/ 返回 null（不是光影包） */
function shaderStatsFromZip(file) {
  try {
    const entries = listEntries(file);
    if (!entries.length) return null;
    const inShaders = entries.filter((e) => /^shaders\//i.test(e.name));
    const glsl = inShaders.filter((e) => GLSL.test(e.name));
    if (!glsl.length && !inShaders.length) return null;
    return { shaderFiles: glsl.length, hasShadersDir: true, total: entries.length };
  } catch { return null; }
}

function shaderStatsFromDir(dir) {
  const sd = path.join(dir, 'shaders');
  try {
    if (!fs.statSync(sd).isDirectory()) return null;
  } catch { return null; }
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
      else if (GLSL.test(it.name)) n++;
    }
  };
  walk(sd, 0);
  return { shaderFiles: n, hasShadersDir: true, total: n };
}

/* ---------- 主入口 ---------- */

/**
 * 读取一个资源包 / 光影包的信息。
 * 文件和目录（未解压的资源包）都支持。
 * @param {string} p 路径
 * @param {'rps'|'shaders'} kind
 * @returns {{path:string,name:string,desc:string,format:number|null,mc:string|null,
 *            icon:string|null,isDir:boolean,ok:boolean,note:string|null,
 *            shaderFiles:number|null}}
 */
function describePack(p, kind) {
  let isDir = false;
  // 访问失败也返回完整结构（字段填 null），UI 不必到处判空，只看 ok/note 即可
  try { isDir = fs.statSync(p).isDirectory(); } catch {
    return {
      path: p, name: path.basename(p), desc: '', format: null, mc: null,
      icon: null, isDir: false, ok: false, note: '无法访问', shaderFiles: null
    };
  }

  let meta = null;
  let icon = null;
  let shader = null;

  if (isDir) {
    const m = path.join(p, 'pack.mcmeta');
    try { if (fs.existsSync(m)) meta = parseMcmeta(fs.readFileSync(m, 'utf8')); } catch {}
    icon = readIconFromDir(p);
    if (kind === 'shaders') shader = shaderStatsFromDir(p);
  } else {
    const hit = readFirst(p, ['pack.mcmeta']);
    if (hit) meta = parseMcmeta(hit.data.toString('utf8'));
    icon = readIconFromZip(p);
    if (kind === 'shaders') shader = shaderStatsFromZip(p);
  }

  const pack = (meta && meta.pack) || null;
  const fmt = pack && Number.isFinite(Number(pack.pack_format)) ? Number(pack.pack_format) : null;
  const desc = flattenDesc(pack && pack.description);

  let name = path.basename(p);
  let note = null;
  let ok = true;

  if (kind === 'shaders') {
    // 光影包没有 mcmeta 是常态，用 shaders/ 目录判断是不是真光影
    if (!shader) { ok = false; note = '内部没有 shaders/ 目录，可能不是光影包'; }
  } else {
    if (!pack) { ok = false; note = '缺少 pack.mcmeta，游戏里可能不显示'; }
    else if (fmt === null) { note = 'pack.mcmeta 里没有 pack_format'; }
  }

  return {
    path: p,
    name,
    desc,
    format: fmt,
    mc: fmt === null ? null : formatRange(fmt),
    icon,
    isDir,
    ok,
    note,
    shaderFiles: shader ? shader.shaderFiles : null
  };
}

/** 批量读取（顺序执行，读盘受 IO 限制，开并发收益不大反而抢 IO） */
function describePacks(list, kind) {
  return (list || []).map((p) => {
    try { return describePack(p, kind); }
    catch (e) { return { path: p, name: path.basename(p), ok: false, note: String(e && e.message || e) }; }
  });
}

module.exports = { describePack, describePacks, formatRange, formatMatches, parseMcmeta, flattenDesc, PACK_FORMATS };
