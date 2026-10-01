// 找不到 Java 时自动下载一份 JRE
//
// 数据源用 Eclipse Temurin（Adoptium）官方 API，免登录、免 Key、有国内可直连的 CDN 跳转。
// 下载下来的是 .zip（Windows），直接用项目自带的 zipread 解开，不引入第三方解压库。
//
// 两个必须注意的点：
// 1) 解压要防 zip-slip：条目名里带 ../ 的必须丢弃，否则能把文件写到安装目录之外。
// 2) zip 里通常有一层 jdk-xx 目录，不能直接假设 bin/javaw.exe 就在解压根目录下。
const fs = require('fs');
const path = require('path');
const zipread = require('./zipread');
const downloader = require('./downloader');

const ARCH_MAP = { x64: 'x64', ia32: 'x86', arm64: 'aarch64' };

/** Adoptium API 地址（纯函数） */
function apiUrl(major, o) {
  const opt = o || {};
  const arch = opt.arch || ARCH_MAP[process.arch] || 'x64';
  const os = opt.os || 'windows';
  const imageType = opt.imageType || 'jre';
  const vendor = opt.vendor || 'eclipse';
  return `https://api.adoptium.net/v3/assets/latest/${major}/hotspot` +
    `?architecture=${arch}&image_type=${imageType}&os=${os}&vendor=${vendor}`;
}

/**
 * 从 API 返回里挑出安装包（纯函数）
 * @returns {{url:string,name:string,size:number,checksum:string,version:string}|null}
 */
function pickAsset(json) {
  if (!Array.isArray(json)) return null;
  for (const rel of json) {
    for (const b of (rel && rel.binaries) || []) {
      if (b && b.package && b.package.link) {
        return {
          url: b.package.link,
          name: b.package.name || '',
          size: b.package.size || 0,
          checksum: b.package.checksum || '',
          version: (rel.version_data && rel.version_data.semver) || (rel.release_name || '')
        };
      }
    }
  }
  return null;
}

/** 在解压目录里定位 javaw.exe / java（兼容"zip 里多一层目录"的情况） */
function locateJava(root) {
  if (!root || !fs.existsSync(root)) return null;
  const names = process.platform === 'win32' ? ['javaw.exe', 'java.exe'] : ['java'];
  for (const n of names) {
    const p = path.join(root, 'bin', n);
    if (fs.existsSync(p)) return p;
  }
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    for (const n of names) {
      const p = path.join(root, e.name, 'bin', n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 解压 zip（纯本地操作）
 * @returns {number} 实际写出的文件数
 */
function extractZip(zipPath, destDir, onProgress) {
  const entries = zipread.listEntries(zipPath);
  if (!entries.length) throw new Error('压缩包为空或格式不支持（ZIP64 不支持）');
  const root = path.resolve(destDir);
  const fd = fs.openSync(zipPath, 'r');
  let written = 0;
  try {
    for (const e of entries) {
      const name = e.name || '';
      if (!name || /\/$/.test(name)) continue;
      // zip-slip 防护：只接受解压目录之内的目标路径
      const out = path.resolve(root, name);
      if (out !== root && !out.startsWith(root + path.sep)) continue;
      const data = zipread.readEntry(fd, e);
      if (!data) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written++;
      if (onProgress && written % 50 === 0) onProgress(written, entries.length);
    }
  } finally { fs.closeSync(fd); }
  return written;
}

/**
 * 确保本地有一份可用 Java：已有就直接用，没有就下载安装
 * @param {{major?:number, destRoot?:string, arch?:string, onProgress?:Function}} [o]
 * @returns {Promise<{ok:boolean, javaPath?:string, cached?:boolean, dir?:string,
 *                    version?:string, error?:string}>}
 */
async function ensureJava(o) {
  // 可选配置包：o || {} 会让类型塌成 `声明类型 | {}`，取字段要断言回 any
  const opt = /** @type {any} */ (o || {});
  const major = parseInt(opt.major, 10) || 21;
  const destRoot = opt.destRoot;
  if (!destRoot) return { ok: false, error: '未指定安装目录' };

  const destDir = path.join(destRoot, 'java', 'temurin-' + major);
  const cached = locateJava(destDir);
  if (cached) return { ok: true, javaPath: cached, cached: true, dir: destDir };

  const log = opt.onProgress || (() => {});
  log({ phase: '查询 Temurin 下载信息…' });
  let asset;
  try {
    const json = await downloader.fetchJson(apiUrl(major, opt));
    asset = pickAsset(json);
  } catch (e) {
    return { ok: false, error: '查询 Java 下载信息失败: ' + e.message };
  }
  if (!asset) return { ok: false, error: `Temurin 没有提供 Java ${major} 的 Windows 版本` };

  fs.mkdirSync(destDir, { recursive: true });
  const zipPath = path.join(destDir, 'jre-download.zip');
  log({ phase: `下载 Java ${major}（${(asset.size / 1048576).toFixed(0)} MB）…`, url: asset.url });
  try {
    await downloader.downloadFile(asset.url, zipPath);
  } catch (e) {
    return { ok: false, error: '下载 Java 失败: ' + e.message };
  }

  log({ phase: '解压 Java 运行环境…' });
  let n = 0;
  try {
    n = extractZip(zipPath, destDir, (done, total) => log({ phase: `解压中 ${done}/${total}` }));
  } catch (e) {
    return { ok: false, error: '解压 Java 失败: ' + e.message };
  }
  try { fs.unlinkSync(zipPath); } catch {}   // 安装包留着没用，占几十 MB

  const javaPath = locateJava(destDir);
  if (!javaPath) return { ok: false, error: '解压完成但没找到 javaw.exe' };
  log({ phase: `Java ${major} 安装完成（${n} 个文件）` });
  return { ok: true, javaPath, cached: false, dir: destDir, version: asset.version };
}

/** 列出本地已下载的 Java（供设置页显示"已装 / 清理"） */
function installed(destRoot) {
  const base = path.join(destRoot || '', 'java');
  if (!destRoot || !fs.existsSync(base)) return [];
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { return []; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    const p = locateJava(dir);
    let bytes = 0;
    try {
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const x of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, x.name);
          if (x.isDirectory()) stack.push(fp);
          else { try { bytes += fs.statSync(fp).size; } catch {} }
        }
      }
    } catch {}
    out.push({ name: e.name, dir, javaPath: p, bytes });
  }
  return out;
}

/** 删除某个已下载的 Java */
function remove(destRoot, name) {
  const dir = path.join(destRoot || '', 'java', String(name || ''));
  if (!name || !fs.existsSync(dir)) return { ok: false, error: '不存在' };
  const rm = (d) => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) rm(p); else { try { fs.unlinkSync(p); } catch {} }
    }
    try { fs.rmdirSync(d); } catch {}
  };
  try { rm(dir); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { apiUrl, pickAsset, locateJava, extractZip, ensureJava, installed, remove };
