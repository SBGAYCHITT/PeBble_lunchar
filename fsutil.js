// Pebble Lunchar - 文件系统小工具
//
// 存在的原因：Node 22 在 Windows 上，fs.cpSync 往「含非 ASCII 字符的目标路径」
// 递归复制时会直接段错误退出（进程崩溃，try/catch 拦不住）。
// 已复现：fs.cpSync(src, 'C:\\...\\整合包-A\\mods', {recursive:true, force:true}) → EXIT 139。
// 启动器的实例名、游戏目录、甚至 Windows 用户名都可能带中文，所以这里一律手写递归复制。

const fs = require('fs');
const path = require('path');

/**
 * 递归复制文件 / 目录。
 * @param {string} src
 * @param {string} dest
 * @param {object} [o]
 * @param {boolean}[o.overwrite] 目标已存在时是否覆盖（默认覆盖）
 * @param {(s:{src:string,dest:string})=>void} [o.onFile] 每个文件复制完回调
 * @returns {{files:number, bytes:number, skipped:number}}
 */
function copyPath(src, dest, o) {
  o = o || {};
  const stat = { files: 0, bytes: 0, skipped: 0 };
  walk(src, dest, o, stat, 0);
  return stat;
}

function walk(src, dest, o, stat, depth) {
  if (depth > 24) return;                       // 防符号链接环
  let st;
  try { st = fs.lstatSync(src); } catch { return; }

  if (st.isSymbolicLink()) return;              // 不做链接跟随，避免跨盘 / 意外写穿

  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    let items;
    try { items = fs.readdirSync(src); } catch { return; }
    for (const name of items) walk(path.join(src, name), path.join(dest, name), o, stat, depth + 1);
    try { fs.utimesSync(dest, st.atime, st.mtime); } catch {}
    return;
  }

  if (!st.isFile()) return;

  if (fs.existsSync(dest) && o.overwrite === false) { stat.skipped++; return; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(src, dest);
    stat.files++;
    stat.bytes += st.size;
    try { fs.utimesSync(dest, st.atime, st.mtime); } catch {}
    if (o.onFile) o.onFile({ src, dest });
  } catch (e) {
    if (o.onError) o.onError({ src, dest, error: e.message });
  }
}

/** 递归统计体积（可选上限，超过就提前收手） */
function sizeOf(p, limit) {
  const cap = limit || 0;
  let total = 0;
  const walkDir = (d, depth) => {
    if (depth > 12) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (cap && total >= cap) return;
      try {
        const full = path.join(d, it.name);
        if (it.isDirectory()) walkDir(full, depth + 1);
        else total += fs.statSync(full).size;
      } catch {}
    }
  };
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  walkDir(p, 0);
  return total;
}

/** 安全删除：不存在 / 权限问题都不会抛 */
function remove(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { copyPath, sizeOf, remove };
