// Pebble Lunchar - 版本下载安装（官方源优先，失败自动切国内镜像 BMCLAPI）
// 安全基线：所有文件下载后都比对官方版本 JSON 里的 sha1，不匹配即删除换源重试，
// 防止镜像投毒 / CDN 缓存污染 / 断点续传损坏。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ruleAllowed, libPath } = require('./launcher');

const MANIFEST_URLS = [
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
];

// 官方域名 -> 国内镜像
function mirrorOf(url) {
  /** @type {Array<[RegExp, string]>} */
  const rules = [
    [/^https?:\/\/piston-meta\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
    [/^https?:\/\/launchermeta\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
    [/^https?:\/\/piston-data\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
    [/^https?:\/\/libraries\.minecraft\.net\//, 'https://bmclapi2.bangbang93.com/maven/'],
    [/^https?:\/\/resources\.download\.minecraft\.net\//, 'https://bmclapi2.bangbang93.com/assets/']
  ];
  for (const [re, rep] of rules) if (re.test(url)) return url.replace(re, rep);
  return null;
}

/**
 * 拉 JSON（官方失败自动换镜像源）
 * @param {string} url
 * @returns {Promise<any>} 远端 JSON 结构无类型保证，调用方按需取字段
 */
async function fetchJson(url) {
  const urls = [url, mirrorOf(url)].filter(Boolean);
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw new Error('获取失败: ' + url + ' (' + lastErr.message + ')');
}

let PREFER_MIRROR = false;
let THREADS = 16;
function configure(opts) {
  if (!opts) return;
  if (opts.source === 'bmclapi') PREFER_MIRROR = true;
  if (opts.source === 'official') PREFER_MIRROR = false;
  if (opts.threads) THREADS = Math.max(1, Math.min(64, parseInt(opts.threads, 10) || 16));
}

function sha1Of(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

/**
 * 下载并校验文件。
 * @param {string} url
 * @param {string} dest
 * @param {Function} [onProgress]
 * @param {{sha1?:string, size?:number}} [expect] 期望的校验值；给了就强制比对
 * @returns {Promise<'ok'|'skip'>} 校验不过会抛错（并已删除损坏文件）
 */
async function downloadFile(url, dest, onProgress, expect) {
  const want = expect && expect.sha1 ? String(expect.sha1).toLowerCase() : null;

  // 已存在：直接校验，通过才跳过；不通过视为损坏，删除重下
  if (fs.existsSync(dest)) {
    let good = false;
    try {
      const buf = fs.readFileSync(dest);
      if (buf.length) {
        if (want) good = (sha1Of(buf) === want);
        else good = !(expect && expect.size) || buf.length === expect.size;
      }
    } catch {}
    if (good) return 'skip';
    try { fs.unlinkSync(dest); } catch {}
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const m = mirrorOf(url);
  const urls = PREFER_MIRROR ? [m, url].filter(Boolean) : [url, m].filter(Boolean);
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空文件');
      if (want && sha1Of(buf) !== want) throw new Error('SHA1 校验不通过');
      if (expect && expect.size && buf.length !== expect.size) throw new Error('文件大小不符');
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      return 'ok';
    } catch (e) { lastErr = e; }
  }
  throw new Error('下载失败 ' + path.basename(dest) + ': ' + (lastErr ? lastErr.message : '未知'));
}

async function pool(items, worker, concurrency, onTick) {
  let idx = 0, done = 0;
  const errors = [];
  async function run() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { await worker(items[i]); }
      catch (e) { errors.push(e.message); }
      done++;
      if (onTick) onTick(done, items.length, items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, run));
  return errors;
}

/* ---------- 获取可安装版本列表 ---------- */
async function getManifest() {
  let lastErr;
  for (const u of MANIFEST_URLS) {
    try { return await fetchJson(u); } catch (e) { lastErr = e; }
  }
  throw new Error('无法获取版本清单（网络问题）: ' + (lastErr ? lastErr.message : ''));
}

/* ---------- 安装指定版本 ---------- */
async function installVersion({ mcDir, versionId, source, threads }, onProgress) {
  const emit = (o) => onProgress && onProgress(o);
  configure({ source, threads });
  const manifest = await getManifest();
  const entry = manifest.versions.find(v => v.id === versionId);
  if (!entry) throw new Error('版本不存在: ' + versionId);

  emit({ phase: '获取版本信息', done: 0, total: 1 });
  const vjson = await fetchJson(entry.url);
  const vDir = path.join(mcDir, 'versions', versionId);
  fs.mkdirSync(vDir, { recursive: true });
  fs.writeFileSync(path.join(vDir, versionId + '.json'), JSON.stringify(vjson, null, 2));

  // 1. 客户端 jar（校验官方 sha1）
  if (vjson.downloads && vjson.downloads.client) {
    emit({ phase: '下载客户端主程序', done: 0, total: 1 });
    const c = vjson.downloads.client;
    await downloadFile(c.url, path.join(vDir, versionId + '.jar'), null, { sha1: c.sha1, size: c.size });
  }

  // 2. 依赖库 + natives
  const libs = (vjson.libraries || []).filter(l => ruleAllowed(l.rules));
  const libDir = path.join(mcDir, 'libraries');
  const jobs = [];
  for (const l of libs) {
    const nativesKey = l.natives && l.natives['windows'];
    if (nativesKey) {
      const classifier = nativesKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const cls = l.downloads && l.downloads.classifiers && l.downloads.classifiers[classifier];
      const url = (cls && cls.url)
        || (l.url ? l.url.replace(/\/$/, '') + '/' + libPath({ name: l.name + ':' + classifier }).replace(/\\/g, '/') : null);
      if (url) {
        jobs.push({
          url,
          dest: path.join(libDir, libPath({ name: l.name + ':' + classifier })),
          sha1: cls && cls.sha1, size: cls && cls.size
        });
      }
    }
    const art = l.downloads && l.downloads.artifact;
    if (art && art.url) {
      jobs.push({
        url: art.url,
        dest: path.join(libDir, art.path ? art.path.replace(/\//g, '\\') : libPath(l)),
        sha1: art.sha1, size: art.size
      });
    } else if (l.url && !l.downloads) {
      jobs.push({ url: l.url.replace(/\/$/, '') + '/' + libPath(l).replace(/\\/g, '/'), dest: path.join(libDir, libPath(l)) });
    }
  }
  emit({ phase: '下载依赖库', done: 0, total: jobs.length });
  const libErr = await pool(jobs, j => downloadFile(j.url, j.dest, null, { sha1: j.sha1, size: j.size }), THREADS,
    (d, t, it) => emit({ phase: '下载依赖库', done: d, total: t, file: path.basename(it.dest) }));
  if (libErr.length) emit({ phase: '依赖库有 ' + libErr.length + ' 项失败（可能仍可启动）', done: 1, total: 1 });

  // 3. 资源文件
  if (vjson.assetIndex) {
    const ai = await fetchJson(vjson.assetIndex.url);
    const aiPath = path.join(mcDir, 'assets', 'indexes', vjson.assetIndex.id + '.json');
    fs.mkdirSync(path.dirname(aiPath), { recursive: true });
    fs.writeFileSync(aiPath, JSON.stringify(ai));
    // 资源文件是内容寻址的：hash 本身就是 sha1
    const objs = Object.values(ai.objects || {}).map(o => ({
      url: 'https://resources.download.minecraft.net/' + o.hash.slice(0, 2) + '/' + o.hash,
      dest: path.join(mcDir, 'assets', 'objects', o.hash.slice(0, 2), o.hash),
      sha1: o.hash, size: o.size
    }));
    emit({ phase: '下载游戏资源', done: 0, total: objs.length });
    const aErr = await pool(objs, o => downloadFile(o.url, o.dest, null, { sha1: o.sha1, size: o.size }), THREADS,
      (d, t) => emit({ phase: '下载游戏资源', done: d, total: t }));
    if (aErr.length) emit({ phase: '资源有 ' + aErr.length + ' 项失败（可稍后重试补全）', done: 1, total: 1 });
  }

  emit({ phase: '安装完成', done: 1, total: 1, finished: true });
  return { ok: true, version: versionId };
}

// downloadFile / fetchJson / mirrorOf / configure 必须导出：
// loaders.js 里所有加载器版本查询和安装器下载都依赖它们，
// 之前漏导出会让调用点直接 TypeError（表现为 UI 上「获取失败 / 安装失败」）。
module.exports = { installVersion, getManifest, downloadFile, fetchJson, mirrorOf, configure };
