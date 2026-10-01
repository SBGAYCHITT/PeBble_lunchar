// Pebble Lunchar - 账户头像 / 皮肤渲染图抓取
//
// 为什么走主进程抓再转 data URL：渲染层开了 CSP，`<img src="https://crafatar.com/...">`
// 会被拦掉（在线仓库那会儿已经踩过一次）。所以这里统一在主进程 fetch 成 base64
// data URL 再回传，Renderer 只负责贴上去。
//
// 三级降级：磁盘缓存（含过期也能兜底）→ Crafatar → MC-Heads → null（UI 画首字母）。
// 离线账户的 UUID 是本地算法生成的，皮肤站一般返回默认 Steve/Alex 头，属于正常结果，
// 所以这里不把它当失败处理。

const fs = require('fs');
const path = require('path');
const os = require('os');

const UA = 'PebbleLunchar/1.0';
const TIMEOUT = 12000;
const MAX_BYTES = 2 * 1024 * 1024;      // 头像再大就离谱了
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

let app = null;
try { app = require('electron').app; } catch { /* 纯 Node 环境（单测）下拿不到 */ }

function cacheDir() {
  if (app) {
    try { return path.join(app.getPath('userData'), 'avatars'); } catch { /* 落到临时目录 */ }
  }
  return path.join(os.tmpdir(), 'pebble-avatars');
}

/** 纯函数：组装皮肤站 URL。kind: head（正面头像）| body（全身渲染）| skin（原图） */
function avatarUrl(uuid, size, kind) {
  const u = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(u)) return '';
  const withDashes = String(uuid);
  const s = Math.max(8, Math.min(512, parseInt(size, 10) || 64));
  if (kind === 'skin') return {
    primary: `https://crafatar.com/skins/${u}`,
    fallback: `https://mc-heads.net/skin/${u}`
  };
  if (kind === 'body') {
    return {
      primary: `https://crafatar.com/renders/body/${u}?scale=6&overlay`,
      fallback: `https://mc-heads.net/body/${withDashes}/128`
    };
  }
  return {
    primary: `https://crafatar.com/avatars/${u}?size=${s}&overlay`,
    fallback: `https://mc-heads.net/avatar/${withDashes}/${s}`
  };
}

/** 纯函数：缓存文件名。uuid 里的横杠去掉，避免 Windows 路径意外转义问题 */
function cacheName(uuid, size, kind) {
  const u = String(uuid || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(u)) return '';
  return `${u}-${kind || 'head'}-${parseInt(size, 10) || 64}.img`;
}

/** 纯函数：把字节流猜成 mime。皮肤站偶而不给 content-type，不能只看 header */
function sniffMime(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 12 && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 3 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 5 && buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return '';
}

function dataUrl(mime, buf) {
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

/* ---------- 磁盘缓存 ---------- */
function readCache(name, ttlMs) {
  try {
    const p = path.join(cacheDir(), name);
    const st = fs.statSync(p);
    const ttl = ttlMs == null ? CACHE_TTL_MS : ttlMs;
    if (ttl > 0 && Date.now() - st.mtimeMs > ttl) return null;   // 过期
    const buf = fs.readFileSync(p);
    const mime = sniffMime(buf) || 'image/png';
    return dataUrl(mime, buf);
  } catch { return null; }
}

/** 过期旧图仍然留着，用于断网时兜底（readCache 的 ttl=0 就是「不管多久都要」） */
function readStaleCache(name) {
  return readCache(name, 0);
}

function writeCache(name, buf) {
  try {
    const d = cacheDir();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, name), buf);
    return true;
  } catch { return false; }
}

/* ---------- 下载（2 路并发，去重） ---------- */
let inflight = new Map();
let queue = [];
let active = 0;
const LANES = 2;

function pump() {
  while (active < LANES && queue.length) {
    const job = queue.shift();
    active++;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => { active--; pump(); });
  }
}

function enqueue(key, task) {
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve, reject) => {
    queue.push({ key, task, resolve, reject });
    setImmediate(pump);
  });
  const wrapped = p.finally(() => { inflight.delete(key); });
  inflight.set(key, wrapped);
  return wrapped;
}

async function download(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'image/*' },
    signal: AbortSignal.timeout(TIMEOUT)
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return null;
  let mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(mime)) mime = sniffMime(buf);
  if (!mime) return null;
  return { data: dataUrl(mime, buf), buf };
}

/**
 * 取头像（data URL）。uuid 非法直接返回 null，不做网络请求。
 * @param {object} o { uuid, size=64, kind='head', refresh=false }
 * @returns {Promise<string|null>}
 */
async function getAvatar(o) {
  const opts = o || {};
  const size = parseInt(opts.size, 10) || 64;
  const kind = opts.kind || 'head';
  const name = cacheName(opts.uuid, size, kind);
  if (!name) return null;

  if (!opts.refresh) {
    const hit = readCache(name);
    if (hit) return hit;
  }

  const urls = avatarUrl(opts.uuid, size, kind);
  if (!urls) return null;

  return enqueue(name, async () => {
    if (!opts.refresh) {
      const hit = readCache(name);
      if (hit) return hit;
    }
    for (const u of [urls.primary, urls.fallback]) {
      try {
        const got = await download(u);
        if (got) { writeCache(name, got.buf); return got.data; }
      } catch { /* 换下一个源 */ }
    }
    // 全挂了：断网/被墙时拿旧图顶一下，比显示空白强
    return readStaleCache(name);
  });
}

/** 批量取（内部自动去重 + 限流），返回 { uuid: dataUrl|null } */
async function getAvatars(list, size, kind) {
  const out = {};
  const seen = new Set();
  const jobs = [];
  for (const a of list || []) {
    const uuid = (a && a.uuid) || '';
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);
    jobs.push(getAvatar({ uuid, size, kind }).then((d) => { out[uuid] = d; }));
  }
  await Promise.all(jobs);
  return out;
}

/** 清掉磁盘缓存（设置页「清除图像缓存」用） */
function clearCache() {
  const d = cacheDir();
  try {
    if (!fs.existsSync(d)) return { ok: true, removed: 0 };
    const files = fs.readdirSync(d);
    for (const f of files) { try { fs.unlinkSync(path.join(d, f)); } catch { /* 占用中跳过 */ } }
    return { ok: true, removed: files.length };
  } catch (e) { return { ok: false, error: e.message, removed: 0 }; }
}

function cacheSize() {
  const d = cacheDir();
  try {
    if (!fs.existsSync(d)) return 0;
    return fs.readdirSync(d).reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(d, f)).size; } catch { return sum; }
    }, 0);
  } catch { return 0; }
}

/** 纯函数：头像取不到时的兜底文字。中文取首字，英文取首字母 */
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const first = Array.from(s)[0] || '?';
  return /[a-zA-Z]/.test(first) ? first.toUpperCase() : first;
}

module.exports = {
  avatarUrl, cacheName, sniffMime, initials, cacheDir,
  getAvatar, getAvatars, clearCache, cacheSize,
  CACHE_TTL_MS
};
