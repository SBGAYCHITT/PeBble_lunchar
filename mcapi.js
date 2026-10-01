// Pebble Lunchar - 文件系统层：资源目录管理、存档 NBT 解析、版本文件操作
const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');
const nbt = require('./nbt');

const DISABLED = '.disabled';

/* ---------- 游戏目录（支持版本隔离） ---------- */
function gameDirOf(mcDir, version, isolation) {
  return isolation ? path.join(mcDir, 'versions', version, 'isolation') : mcDir;
}

/* ---------- 通用目录列表 ----------
 * allowDirs: 资源包 / 光影包经常以「未解压目录」的形式存在（改起来方便），
 *            原来这里 `if (it.isDirectory()) continue` 会把它们整个吞掉 —— 用户会以为文件丢了。
 *            目录同样支持 .disabled 后缀禁用。
 */
function listFiles(dir, exts, opts) {
  const allowDirs = !!(opts && opts.allowDirs);
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const isDirItem = it.isDirectory();
    if (isDirItem && !allowDirs) continue;
    const name = it.name;
    const disabled = name.endsWith(DISABLED);
    const real = disabled ? name.slice(0, -DISABLED.length) : name;
    // 目录没有扩展名：只在 allowDirs 时放行；文件仍要过扩展名过滤
    if (!isDirItem && exts && !exts.some(e => real.toLowerCase().endsWith(e))) continue;
    let size = 0, mtime = 0;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isDirectory()) { size = dirSize(path.join(dir, name)); mtime = st.mtimeMs; }
      else { size = st.size; mtime = st.mtimeMs; }
    } catch {}
    out.push({ name: real, file: name, path: path.join(dir, name), size, mtime, enabled: !disabled, isDir: it.isDirectory() });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function toggleFile(p) {
  try {
    if (p.endsWith(DISABLED)) { fs.renameSync(p, p.slice(0, -DISABLED.length)); return { enabled: true }; }
    fs.renameSync(p, p + DISABLED); return { enabled: false };
  } catch (e) { return { error: e.message }; }
}

function deletePath(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/* ---------- 各资源目录 ---------- */
function listMods(gd)      { return listFiles(path.join(gd, 'mods'), ['.jar', '.zip', '.litemod']); }
// 资源包 / 光影包允许「未解压目录」形式（很常见：自己改材质、改光影参数）
function listResourcepacks(gd) { return listFiles(path.join(gd, 'resourcepacks'), ['.zip'], { allowDirs: true }); }
function listShaderpacks(gd)   { return listFiles(path.join(gd, 'shaderpacks'), ['.zip'], { allowDirs: true }); }
function listScreenshots(gd) {
  const s = listFiles(path.join(gd, 'screenshots'), ['.png', '.jpg', '.jpeg']);
  return s.sort((a, b) => b.mtime - a.mtime);
}

/* ---------- 存档（saves） ---------- */
function listSaves(gd) {
  const dir = path.join(gd, 'saves');
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    const p = path.join(dir, it.name);
    const dat = path.join(p, 'level.dat');
    if (!fs.existsSync(dat)) continue;
    const info = readLevelDat(dat);
    let size = 0, mtime = 0;
    try {
      const st = fs.statSync(dat); mtime = st.mtimeMs;
      size = dirSize(p);
    } catch {}
    out.push({
      dir: p,
      folder: it.name,
      name: (info && info.LevelName) || it.name,
      version: (info && info.Version) || '',
      gameType: gameTypeName(info ? info.GameType : 0),
      hardcore: !!(info && info.hardcore),
      cheats: !!(info && info.allowCommands),
      lastPlayed: (info && info.LastPlayed) ? Number(info.LastPlayed) : mtime,
      size,
      icon: fs.existsSync(path.join(p, 'icon.png')) ? path.join(p, 'icon.png') : null
    });
  }
  out.sort((a, b) => b.lastPlayed - a.lastPlayed);
  return out;
}

function gameTypeName(t) {
  return { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' }[t] || '生存';
}

function dirSize(dir) {
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 3) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      try {
        if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
        else total += fs.statSync(path.join(d, it.name)).size;
      } catch {}
    }
  };
  walk(dir, 0);
  return total;
}

/* ---------- level.dat 读取 ----------
 * NBT 解析统一走 ./nbt（此前这里有第二份实现，缺边界检查且会丢 byte/int/long 数组）。
 * 本模块只负责「文件路径 → UI 字段」这一步。
 */
function readLevelDat(file) {
  try {
    return nbt.levelDatFields(nbt.parseAuto(fs.readFileSync(file)));
  } catch { return null; }
}

/** @deprecated 保留导出以兼容旧调用方；字段提取已迁到 nbt.levelDatFields */
function parseNBT(buf) {
  try {
    return nbt.levelDatFields(nbt.parseAuto(buf));
  } catch { return null; }
}

/* ---------- options.txt ---------- */
function readOptions(gd) {
  const p = path.join(gd, 'options.txt');
  const map = {};
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return map; }
  for (const line of txt.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return map;
}

function writeOptions(gd, patch) {
  const p = path.join(gd, 'options.txt');
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
  const idx = new Map();
  lines.forEach((l, i) => { const k = l.slice(0, l.indexOf(':')); if (k) idx.set(k.trim(), i); });
  for (const [k, v] of Object.entries(patch)) {
    const line = k + ':' + v;
    if (idx.has(k)) lines[idx.get(k)] = line;
    else lines.push(line);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return { ok: true };
}

/* ---------- 日志 / 崩溃报告 ---------- */
function listCrashes(gd) {
  const dir = path.join(gd, 'crash-reports');
  const out = [];
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  if (items) {
    for (const it of items) {
      if (!it.isFile()) continue;
      let mtime = 0, size = 0;
      try { const st = fs.statSync(path.join(dir, it.name)); mtime = st.mtimeMs; size = st.size; } catch {}
      out.push({ name: it.name, path: path.join(dir, it.name), kind: '崩溃报告', mtime, size });
    }
  }
  for (const f of ['logs/latest.log', 'logs/debug.log']) {
    const p = path.join(gd, f);
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        out.push({ name: f.replace('/', '\\'), path: p, kind: '日志', mtime: st.mtimeMs, size: st.size });
      }
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readLogTail(p, len) {
  try {
    const buf = fs.readFileSync(p);
    const txt = buf.toString('utf8');
    return txt.slice(Math.max(0, txt.length - (len || 20000)));
  } catch (e) { return '(读取失败: ' + e.message + ')'; }
}

/* ---------- 版本文件操作 ---------- */
function versionDir(mcDir, id) { return path.join(mcDir, 'versions', id); }

function deleteVersion(mcDir, id) {
  try { fs.rmSync(versionDir(mcDir, id), { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function copyVersion(mcDir, id, newId) {
  const src = versionDir(mcDir, id);
  const dst = versionDir(mcDir, newId);
  if (fs.existsSync(dst)) return { ok: false, error: '目标版本已存在' };
  try {
    fsutil.copyPath(src, dst);   // 不能用 fs.cpSync：目标路径含中文时 Node 会段错误
    // 重命名内部 json/jar
    for (const ext of ['.json', '.jar']) {
      const a = path.join(dst, id + ext);
      if (fs.existsSync(a)) fs.renameSync(a, path.join(dst, newId + ext));
    }
    return { ok: true, id: newId };
  } catch (e) { return { ok: false, error: e.message }; }
}

function renameVersion(mcDir, id, newId) {
  const src = versionDir(mcDir, id);
  const dst = versionDir(mcDir, newId);
  if (!fs.existsSync(src)) return { ok: false, error: '版本不存在' };
  if (fs.existsSync(dst)) return { ok: false, error: '目标版本已存在' };
  try {
    fs.renameSync(src, dst);
    for (const ext of ['.json', '.jar']) {
      const a = path.join(dst, id + ext);
      if (fs.existsSync(a)) fs.renameSync(a, path.join(dst, newId + ext));
    }
    return { ok: true, id: newId };
  } catch (e) { return { ok: false, error: e.message }; }
}

function exportVersion(mcDir, id, destZip, isolation) {
  const src = versionDir(mcDir, id);
  try {
    fs.mkdirSync(path.dirname(destZip), { recursive: true });
    require('child_process').execSync(`tar -a -cf "${destZip}" -C "${src}" .`, { stdio: 'ignore' });
    return { ok: true, file: destZip };
  } catch (e) { return { ok: false, error: e.message }; }
}

function importVersion(mcDir, zipPath, id) {
  const dst = versionDir(mcDir, id);
  if (fs.existsSync(dst)) return { ok: false, error: '版本已存在' };
  try {
    fs.mkdirSync(dst, { recursive: true });
    require('child_process').execSync(`tar -xf "${zipPath}" -C "${dst}"`, { stdio: 'ignore' });
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e.message }; }
}

function copyFile(src, destDir) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(src));
    fs.copyFileSync(src, dest);
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
}

function zipDir(src, destZip) {
  try {
    fs.mkdirSync(path.dirname(destZip), { recursive: true });
    require('child_process').execSync(`tar -a -cf "${destZip}" -C "${src}" .`, { stdio: 'ignore' });
    return { ok: true, file: destZip };
  } catch (e) { return { ok: false, error: e.message }; }
}

function openFolder(p) {
  try {
    require('child_process').execSync(`explorer "${p.replace(/\//g, '\\\\')}"`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  gameDirOf, listMods, listResourcepacks, listShaderpacks, listScreenshots, listSaves,
  toggleFile, deletePath, readOptions, writeOptions, listCrashes, readLogTail,
  versionDir, deleteVersion, copyVersion, renameVersion, exportVersion, importVersion, openFolder,
  dirSize, copyFile, zipDir,
  parseNBT, readLevelDat   // 供存档时光机做区块级实体统计
};
