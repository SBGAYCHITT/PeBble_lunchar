// Pebble Lunchar - 在线仓库（Modrinth + CurseForge）
//
// 设计前提：
// 1. **Modrinth 免密钥**，直接可用；**CurseForge 必须 API Key**（无 key 会 403）。
//    所以 CurseForge 是"配了就能用"的可选源，不配就只出 Modrinth，不假装能用。
// 2. 所有网络请求都在主进程发起，渲染层只拿到已经整理好的数据。
//    远程图片也由主进程抓下来转成 data URL —— 这样不必为了显示图片去放宽 CSP。
// 3. 下载落盘后比对 sha1（Modrinth 提供），下载前若目标文件已存在且哈希一致则跳过。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'PebbleLunchar/1.0.0 (Minecraft launcher; +local)';
const TIMEOUT = 20000;

/* ---------- 类型映射 ---------- */
// CurseForge classId: 6=Mods, 12=Resource Packs, 6552=Shaders
const KINDS = {
  mods: { mr: 'mod', cf: 6 },
  rps: { mr: 'resourcepack', cf: 12 },
  shaders: { mr: 'shader', cf: 6552 }
};

// CurseForge modLoaderType：只列确定的，未知的宁可不传也别传错
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5 };

/* ---------- 基础请求 ---------- */
async function httpJson(url, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers || {}),
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return JSON.parse(await res.text());
}

/* ---------- 归一化 ---------- */
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(n);
}

function relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return '今天';
  if (d < 30) return d + ' 天前';
  if (d < 365) return Math.floor(d / 30) + ' 个月前';
  return Math.floor(d / 365) + ' 年前';
}

/* ---------- Modrinth ---------- */

function mrFacets({ kind, mc, loader }) {
  const f = [[`project_type:${(KINDS[kind] || KINDS.mods).mr}`]];
  if (mc) f.push([`versions:${mc}`]);
  if (loader) f.push([`categories:${loader}`]);
  return JSON.stringify(f);
}

async function searchModrinth(o) {
  const q = new URLSearchParams({
    query: o.query || '',
    limit: String(o.limit || 20),
    offset: String(o.offset || 0),
    index: o.sort || 'relevance',
    facets: mrFacets(o)
  });
  const j = await httpJson('https://api.modrinth.com/v2/search?' + q.toString());
  return (j.hits || []).map((h) => ({
    source: 'modrinth',
    id: h.project_id || h.slug,
    slug: h.slug,
    title: h.title || h.slug,
    author: h.author || '',
    icon: h.icon_url || '',
    summary: h.description || '',
    downloads: h.downloads || 0,
    downloadsText: fmtNum(h.downloads),
    follows: h.follows || 0,
    categories: h.display_categories || h.categories || [],
    loaders: (h.categories || []).filter((c) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    gameVersions: h.versions || [],
    updated: h.date_modified || h.date_created || '',
    updatedText: relTime(h.date_modified || h.date_created)
  }));
}

async function projectModrinth(id) {
  const j = await httpJson('https://api.modrinth.com/v2/project/' + encodeURIComponent(id));
  return {
    source: 'modrinth',
    id: j.id || j.slug,
    slug: j.slug,
    title: j.title,
    // 注：Modrinth 的 project 接口不直接返回作者名，要拿得再请求 /project/{id}/members。
    // 这里不做额外请求（列表页多卡片会放大成 N 次网络往返），作者名留空由详情页再补。
    author: j.author || '',
    icon: j.icon_url || '',
    summary: j.description || '',
    body: miniMarkdown(j.body || ''),     // Modrinth 的正文是 Markdown
    bodyRaw: j.body || '',
    gallery: (j.gallery || []).map((g) => ({
      url: g.raw_url || g.url,
      thumb: g.url || g.raw_url,
      title: g.title || '',
      desc: g.description || ''
    })),
    loaders: j.loaders || [],
    gameVersions: j.game_versions || [],
    categories: (j.categories || []).concat(j.additional_categories || []),
    downloads: j.downloads || 0,
    downloadsText: fmtNum(j.downloads),
    follows: j.followers || 0,
    updated: j.updated || '',
    updatedText: relTime(j.updated),
    license: (j.license && (j.license.name || j.license.id)) || '',
    links: {
      issues: j.issues_url || '',
      source: j.source_url || '',
      wiki: j.wiki_url || '',
      discord: j.discord_url || '',
      page: 'https://modrinth.com/' + (j.project_type || 'mod') + '/' + j.slug
    },
    clientSide: j.client_side || '',
    serverSide: j.server_side || ''
  };
}

async function versionsModrinth(id) {
  const j = await httpJson('https://api.modrinth.com/v2/project/' + encodeURIComponent(id) + '/version');
  return (j || []).map((v) => {
    const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0] || null;
    return {
      id: v.id,
      name: v.name || v.version_number,
      number: v.version_number || '',
      type: v.version_type || '',
      date: v.date_published || '',
      dateText: relTime(v.date_published),
      downloads: v.downloads || 0,
      loaders: v.loaders || [],
      gameVersions: v.game_versions || [],
      changelog: miniMarkdown(v.changelog || ''),
      file: f ? {
        name: f.filename,
        url: f.url,
        size: f.size || 0,
        sha1: (f.hashes && f.hashes.sha1) || '',
        sha512: (f.hashes && f.hashes.sha512) || ''
      } : null
    };
  });
}

/**
 * Modrinth 的游戏版本列表（只取正式版，新的在前）。
 * 为什么不硬编码：MC 版本号一直在涨，写死的列表过几个月就全是过期选项。
 */
async function gameVersions() {
  const j = await httpJson('https://api.modrinth.com/v2/tag/game_version');
  return (j || [])
    .filter((v) => v && v.version_type === 'release')
    .map((v) => String(v.version))
    .slice(0, 40);
}

/* ---------- CurseForge ---------- */

function cfLoaderId(loader) {
  return CF_LOADER[String(loader || '').toLowerCase()] || 0;
}

async function searchCurseForge(o) {
  if (!o.apiKey) throw new Error('未配置 CurseForge API Key');
  const p = new URLSearchParams({
    gameId: '432',
    classId: String((KINDS[o.kind] || KINDS.mods).cf),
    pageSize: String(o.limit || 20),
    index: String(o.offset || 0),
    sortField: o.sort === 'updated' ? '3' : (o.sort === 'newest' ? '3' : '6'),
    sortOrder: 'desc'
  });
  if (o.query) p.set('searchFilter', o.query);
  if (o.mc) p.set('gameVersion', o.mc);
  const lt = cfLoaderId(o.loader);
  if (lt) p.set('modLoaderType', String(lt));
  const j = await httpJson('https://api.curseforge.com/v1/mods/search?' + p.toString(),
    { 'x-api-key': o.apiKey });
  return (j.data || []).map((m) => ({
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug || String(m.id),
    title: m.name || '',
    author: (m.authors || []).map((a) => a.name).join(', '),
    icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || '',
    summary: m.summary || '',
    downloads: m.downloadCount || 0,
    downloadsText: fmtNum(m.downloadCount),
    follows: m.thumbsUpCount || 0,
    categories: (m.categories || []).map((c) => c.name),
    loaders: (m.categories || []).map((c) => String(c.slug || '').toLowerCase())
      .filter((c) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    gameVersions: (m.gameVersionLatestFiles || []).map((g) => g.gameVersion).filter(Boolean),
    updated: m.dateModified || '',
    updatedText: relTime(m.dateModified)
  }));
}

async function projectCurseForge(id, apiKey) {
  if (!apiKey) throw new Error('未配置 CurseForge API Key');
  const j = await httpJson('https://api.curseforge.com/v1/mods/' + encodeURIComponent(id),
    { 'x-api-key': apiKey });
  const m = j.data || {};
  let bodyRaw = '';
  try {
    const d = await httpJson('https://api.curseforge.com/v1/mods/' + encodeURIComponent(id) + '/description',
      { 'x-api-key': apiKey });
    // CurseForge 返回的是 HTML，不能直接塞进 innerHTML —— 一律剥成纯文本
    bodyRaw = htmlToText(d.data || '');
  } catch {}
  return {
    source: 'curseforge',
    id: String(m.id || id),
    slug: m.slug || String(m.id || id),
    title: m.name || '',
    author: (m.authors || []).map((a) => a.name).join(', '),
    icon: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || '',
    summary: m.summary || '',
    body: miniMarkdown(bodyRaw),
    bodyRaw,
    gallery: [],
    loaders: (m.categories || []).map((c) => String(c.slug || '').toLowerCase())
      .filter((c) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(c)),
    gameVersions: (m.gameVersionLatestFiles || []).map((g) => g.gameVersion).filter(Boolean),
    categories: (m.categories || []).map((c) => c.name),
    downloads: m.downloadCount || 0,
    downloadsText: fmtNum(m.downloadCount),
    follows: m.thumbsUpCount || 0,
    updated: m.dateModified || '',
    updatedText: relTime(m.dateModified),
    license: '',
    links: {
      issues: (m.links && m.links.issuesUrl) || '',
      source: (m.links && m.links.sourceUrl) || '',
      wiki: (m.links && m.links.wikiUrl) || '',
      discord: '',
      page: (m.links && m.links.websiteUrl) || ''
    },
    clientSide: '',
    serverSide: ''
  };
}

async function versionsCurseForge(id, apiKey, mc) {
  if (!apiKey) throw new Error('未配置 CurseForge API Key');
  const p = new URLSearchParams({ pageSize: '50' });
  if (mc) p.set('gameVersion', mc);
  const j = await httpJson(
    'https://api.curseforge.com/v1/mods/' + encodeURIComponent(id) + '/files?' + p.toString(),
    { 'x-api-key': apiKey });
  return (j.data || []).map((f) => {
    const sha1 = ((f.hashes || []).find((h) => h.algo === 1) || {}).value || '';
    const md5 = ((f.hashes || []).find((h) => h.algo === 2) || {}).value || '';
    return {
      id: String(f.id),
      name: f.displayName || f.fileName,
      number: f.displayName || f.fileName,
      type: String(f.releaseType || ''),
      date: f.fileDate || '',
      dateText: relTime(f.fileDate),
      downloads: f.downloadCount || 0,
      loaders: (f.sortableGameVersions || [])
        .map((g) => String(g.gameVersionName || '').toLowerCase())
        .filter((g) => ['fabric', 'forge', 'quilt', 'neoforge'].includes(g)),
      gameVersions: (f.gameVersions || []).slice(),
      changelog: '',
      file: {
        name: f.fileName || '',
        url: f.downloadUrl || '',
        size: f.fileLength || 0,
        sha1,
        sha512: md5 ? '' : ''
      },
      // downloadUrl 有时为空，需要单独换一次下载链接
      needsDownloadUrl: !f.downloadUrl
    };
  });
}

async function cfDownloadUrl(modId, fileId, apiKey) {
  const j = await httpJson(
    'https://api.curseforge.com/v1/mods/' + encodeURIComponent(modId) + '/files/' + encodeURIComponent(fileId) + '/download-url',
    { 'x-api-key': apiKey });
  return j.data || '';
}

/* ---------- 统一入口 ---------- */

/**
 * 搜索。source: 'modrinth' | 'curseforge' | 'all'
 * @param {{source?:string, query?:string, mc?:string, loader?:string, limit?:number}} [o]
 * @returns {Promise<{items:Array, errors:Array<string>}>}
 */
async function search(o) {
  const want = o.source || 'all';
  const jobs = [];
  if (want === 'all' || want === 'modrinth') jobs.push(['modrinth', searchModrinth(o)]);
  if (want === 'all' || want === 'curseforge') jobs.push(['curseforge', searchCurseForge(o)]);
  const items = [];
  const errors = [];
  const rs = await Promise.allSettled(jobs.map((j) => j[1]));
  rs.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push.apply(items, r.value);
    else errors.push(jobs[i][0] + ': ' + (r.reason && r.reason.message || r.reason));
  });
  items.sort((a, b) => b.downloads - a.downloads);
  return { items, errors };
}

async function details({ source, id, apiKey }) {
  return source === 'curseforge' ? projectCurseForge(id, apiKey) : projectModrinth(id);
}

async function versions({ source, id, apiKey, mc }) {
  return source === 'curseforge' ? versionsCurseForge(id, apiKey, mc) : versionsModrinth(id);
}

/**
 * 下载并安装到资源目录
 * @param {{url:string,name:string,destDir:string,sha1?:string,size?:number,onProgress?:Function}} o
 * @returns {Promise<{ok:boolean, skipped?:boolean, file?:string, bytes?:number, error?:string}>}
 */
async function install(o) {
  const name = safeName(o.name || 'download');
  const dest = path.join(o.destDir, name);
  fs.mkdirSync(o.destDir, { recursive: true });

  // 已存在且哈希一致 → 直接跳过（重复点安装不会重复下载）
  if (fs.existsSync(dest)) {
    if (o.sha1 && sha1OfFile(dest) === String(o.sha1).toLowerCase()) {
      return { ok: true, skipped: true, file: dest };
    }
    if (!o.sha1) return { ok: true, skipped: true, file: dest };
  }

  const res = await fetch(o.url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const total = Number(res.headers.get('content-length') || o.size || 0);
  const chunks = [];
  let got = 0;
  const reader = res.body && res.body.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
      if (o.onProgress) o.onProgress(got, total);
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('下载内容为空');
  if (o.sha1 && sha1Of(buf) !== String(o.sha1).toLowerCase()) throw new Error('SHA1 校验不通过');
  if (o.size && buf.length !== Number(o.size)) throw new Error('文件大小不符');
  fs.writeFileSync(dest + '.part', buf);
  fs.renameSync(dest + '.part', dest);
  return { ok: true, file: dest, bytes: buf.length };
}

function sha1Of(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function sha1OfFile(p) {
  try { return sha1Of(fs.readFileSync(p)); } catch { return ''; }
}

/** 本地已装文件的 sha1 → 文件名，用来在在线列表上标「已安装」 */
function localHashes(dir, exts) {
  const out = new Map();
  let items = [];
  try { items = fs.readdirSync(dir); } catch { return out; }
  for (const n of items) {
    if (exts && !exts.some((e) => n.toLowerCase().endsWith(e))) continue;
    const p = path.join(dir, n);
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    try { out.set(sha1OfFile(p), n); } catch {}
  }
  return out;
}

function safeName(n) {
  return String(n).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
}

/* ---------- 远程图片（主进程代抓 → data URL）---------- */
const imgCache = new Map();
const IMG_MAX = 3 * 1024 * 1024;

/* 并发队列：一屏 30 张卡片如果同时发 30 个请求，CDN 会限流、用户反而等更久。
   限制 4 路并发，并对同一个 URL 去重（列表滚动时会重复请求同一张图）。 */
const IMG_CONCURRENCY = 4;
let imgActive = 0;
const imgQueue = [];
const imgInflight = new Map();

function pumpImages() {
  while (imgActive < IMG_CONCURRENCY && imgQueue.length) {
    const it = imgQueue.shift();
    imgActive++;
    it.task().then(it.resolve, it.reject).finally(() => {
      imgActive--;
      imgInflight.delete(it.key);
      pumpImages();
    });
  }
}

function enqueueImage(key, task) {
  if (imgInflight.has(key)) return imgInflight.get(key);
  const p = new Promise((resolve, reject) => {
    imgQueue.push({ key, task, resolve, reject });
  });
  imgInflight.set(key, p);
  pumpImages();
  return p;
}

async function fetchImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (imgCache.has(url)) return imgCache.get(url);
  return enqueueImage(url, async () => {
    if (imgCache.has(url)) return imgCache.get(url);
    return fetchImageNow(url);
  });
}

async function fetchImageNow(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > IMG_MAX) return null;
    const type = res.headers.get('content-type') || '';
    let mime = type.split(';')[0].trim();
    if (!/^image\//.test(mime)) {
      // webp / png / jpeg 兜底识别（CDN 有时不给 content-type）
      if (buf.length > 12 && buf.toString('latin1', 8, 12) === 'WEBP') mime = 'image/webp';
      else if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') mime = 'image/png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
      else if (buf.toString('latin1', 0, 4) === 'RIFF') mime = 'image/webp';
      else return null;
    }
    const data = 'data:' + mime + ';base64,' + buf.toString('base64');
    if (imgCache.size > 300) imgCache.clear();
    imgCache.set(url, data);
    return data;
  } catch { return null; }
}

/* ---------- 极简 Markdown ----------
 * 只做安全渲染：**先转义 HTML**，再做有限的排版转换。
 * 这样正文里的 <script> / onerror 之类永远进不来。
 * 链接只允许 http/https，图片一律丢弃（画廊已经单独展示了）。
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(u) {
  return /^https?:\/\//i.test(String(u)) ? String(u) : '';
}

function miniMarkdown(src) {
  if (!src) return '';
  let s = escapeHtml(String(src));
  // 代码块
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, c) => '<pre>' + c + '</pre>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // 标题
  s = s.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>')
       .replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>')
       .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
       .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
       .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
       .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  // 粗体 / 斜体 / 删除线
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
       .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 图片丢弃（画廊单独展示）
  s = s.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1');
  // 链接（URL 里可能带括号，例如维基百科，用平衡括号的写法）
  s = s.replace(/\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g, (m, text, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'));
    return u ? `<a data-ext="${escapeHtml(u)}">${text}</a>` : text;
  });
  // 分隔线
  s = s.replace(/^\s*([-*_])\s*\1\s*\1[\s\S]*$/gm, '<hr/>');
  // 列表
  const lines = s.split('\n');
  let out = '';
  let inUl = false, inOl = false;
  const close = () => { if (inUl) { out += '</ul>'; inUl = false; } if (inOl) { out += '</ol>'; inOl = false; } };
  for (const ln of lines) {
    const ul = /^\s*[-*+]\s+(.*)$/.exec(ln);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(ln);
    if (ul) { if (!inUl) { close(); out += '<ul>'; inUl = true; } out += '<li>' + ul[1] + '</li>'; continue; }
    if (ol) { if (!inOl) { close(); out += '<ol>'; inOl = true; } out += '<li>' + ol[1] + '</li>'; continue; }
    close();
    if (/^\s*$/.test(ln)) continue;
    if (/^<(h[1-6]|pre|hr)/.test(ln.trim())) { out += ln; continue; }
    out += '<p>' + ln + '</p>';
  }
  close();
  return out;
}

/** CurseForge 描述是 HTML —— 一律剥成纯文本，绝不原样塞进 DOM */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

module.exports = {
  search, details, versions, install, fetchImage, localHashes, gameVersions,
  cfDownloadUrl, miniMarkdown, htmlToText, fmtNum, relTime, safeName,
  sha1Of, sha1OfFile, KINDS
};
