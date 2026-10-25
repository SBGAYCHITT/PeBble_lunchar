// 加载器安装器的「断网也能装」支持。
//
// 背景（2026-10-25 实际踩到）：NeoForge 安装器在 Java 里用 HttpsURLConnection
// 直接从 https://maven.neoforged.net/releases/... 下 70 个库。这个域名国内
// 经常连不上 —— 每个库都要等一次超时，最后 "There was an error during installation"。
// 安装器自带的 --mirror 参数实测对这批 URL 不生效（日志里从头到尾没出现镜像地址），
// 所以我们不跟它较劲，改成：**安装前把它要的库全部预下到 libraries/**。
//
// 安装器对已存在的库会打印 "File exists. Checksum valid." 并跳过下载，
// 于是整个安装过程不碰网络。缺点是要多花几十秒下载（本地 46 个文件约 30 秒）。
//
// 另一个坑：NeoForge 21.1.264 的安装器退出码 0、打印 "Successfully installed"，
// 却**只写了 launcher_profiles.json，没写 versions/<id>/<id>.json**。
// 少了这个文件启动器就找不到版本，所以装完补写一份（ensureVersionJson）。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const BMCL_MAVEN = 'https://bmclapi2.bangbang93.com/maven/';
const CONCURRENCY = 6;

/* ---------------- 最小 ZIP 读取（只读单个条目，零依赖） ---------------- */

/** 找 EOCD：签名 0x06054b50，最多在末尾 65557 字节内 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 从 jar 里读一个条目并解压。只支持 stored / deflate —— installer jar 就这两种。
 * 不做 zip64：安装器 jar 的单条目都远小于 4 GB。
 */
function readZipEntry(zipPath, wanted) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 zip/jar：' + path.basename(zipPath));

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (name === wanted) {
      const localNameLen = buf.readUInt16LE(localOff + 26);
      const localExtraLen = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + localNameLen + localExtraLen;
      const data = buf.subarray(dataOff, dataOff + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('不支持的压缩方式 ' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/* ---------------- 库清单 ---------------- */

/** 从 install_profile.json / version.json / versionInfo 里收集所有可下载 artifact */
function collectArtifacts(json) {
  const out = [];
  const add = (a) => {
    if (a && a.path && a.sha1) {
      out.push({ path: String(a.path).replace(/\\/g, '/'), sha1: String(a.sha1).toLowerCase() });
    }
  };
  const buckets = [];
  if (Array.isArray(json.libraries)) buckets.push(...json.libraries);
  if (json.versionInfo && Array.isArray(json.versionInfo.libraries)) buckets.push(...json.versionInfo.libraries);

  for (const l of buckets) {
    const d = l.downloads || {};
    add(d.artifact);
    for (const c of Object.values(d.classifiers || {})) add(c);
  }
  return out;
}

const sha1Of = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

/* ---------------- 预下载 ---------------- */

/**
 * 把安装器声明的库全部预置到 <mcDir>/libraries。
 *
 * 失败不抛：安装器自己还会试一次网络，别因为我们某个镜像 404 就把安装卡死。
 * 返回 { total, downloaded, skipped, failed[] } 方便打日志。
 */
async function prefetchInstallerLibraries(jarPath, mcDir, onLog) {
  const log = (s) => onLog && onLog(s);

  let prof = null;
  let ver = null;
  try {
    const raw = readZipEntry(jarPath, 'install_profile.json');
    if (raw) prof = JSON.parse(raw.toString('utf8'));
  } catch {
    /* 老版本 Forge 可能没有这个文件 */
  }
  try {
    const raw = readZipEntry(jarPath, 'version.json');
    if (raw) ver = JSON.parse(raw.toString('utf8'));
  } catch {
    /* 没有也继续 —— 至少能预置 install_profile 里那批 */
  }
  if (!prof && !ver) return { total: 0, downloaded: 0, skipped: 0, failed: [] };

  const uniq = new Map();
  for (const a of [...collectArtifacts(prof || {}), ...collectArtifacts(ver || {})]) {
    if (!uniq.has(a.path)) uniq.set(a.path, a);
  }
  const list = [...uniq.values()];
  if (!list.length) return { total: 0, downloaded: 0, skipped: 0, failed: [] };

  const libDir = path.join(mcDir, 'libraries');
  let downloaded = 0;
  let skipped = 0;
  const failed = [];

  async function one(a) {
    const dest = path.join(libDir, a.path.split('/').join(path.sep));
    try {
      if (fs.existsSync(dest)) {
        if (sha1Of(fs.readFileSync(dest)) === a.sha1) {
          skipped++;
          return;
        }
      }
      const res = await fetch(BMCL_MAVEN + a.path, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha1Of(buf) !== a.sha1) throw new Error('sha1 不匹配');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      downloaded++;
    } catch (e) {
      failed.push(a.path + '（' + e.message + '）');
    }
  }

  log('预置安装器依赖：共 ' + list.length + ' 个库，从 BMCL 镜像补齐…');
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    await Promise.all(list.slice(i, i + CONCURRENCY).map(one));
  }
  log(
    '依赖就绪：新下 ' + downloaded + ' 个，已有 ' + skipped + ' 个' +
      (failed.length ? '，失败 ' + failed.length + ' 个（交给安装器联网重试）' : ''),
  );
  return { total: list.length, downloaded, skipped, failed };
}

/* ---------------- 版本 JSON 兜底 ---------------- */

/**
 * 某些安装器（NeoForge 21.1.264 实测）只写 launcher_profiles.json，
 * 不写 versions/<id>/<id>.json。缺这个文件，启动器的版本列表里就看不到它。
 * 安装成功后检查一次，缺了就从安装器 jar 里把 version.json 拿出来补上。
 *
 * 返回补写的版本 id（没补则 null）。
 */
function ensureVersionJson(jarPath, mcDir, onLog) {
  let raw;
  try {
    raw = readZipEntry(jarPath, 'version.json');
  } catch {
    return null;
  }
  if (!raw) return null;

  let json;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  const id = json && json.id;
  if (!id) return null;

  const dest = path.join(mcDir, 'versions', id, id + '.json');
  if (fs.existsSync(dest)) return null;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, raw);
  if (onLog) onLog('安装器没写版本清单，已补：versions/' + id + '/' + id + '.json');
  return id;
}

module.exports = { readZipEntry, collectArtifacts, prefetchInstallerLibraries, ensureVersionJson };
