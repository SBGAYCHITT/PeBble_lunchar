// 自动更新：检查 → 下载 → 校验 → 替换重启 一条链。
//
// 为什么不用 electron-updater：它强绑定 GitHub/对象存储这类发布渠道，还得配 publish，
// 而本项目是"自己发行"。这里做成"喂一个任意可访问的 JSON 地址就行"，
// 静态站点、网盘直链、对象存储、自建后端都能当更新源。真要换成 electron-updater 也只是替换这一层。
//
// 清单格式（feed）：
//   { "version": "5.0.0", "notes": "修复了…",
//     "url": "https://…/Pebble-Lunchar-5.0.0.exe",
//     "sha256": "…",            // 可选；带上才能「下载并安装」
//     "size": 79047176,          // 可选；只用于进度百分比与磁盘预检
//     "publishedAt": "2026-10-17" }
//
// ⚠️ 只有 url 而**没有 sha256** 时，只退化成"检查 + 打开下载页"（老行为）。
//    宁可少做一步，也不静默装一个校验不了的文件 —— 更新器自己就是最不该被冒充的组件。
//
// 本模块**刻意不 require electron**：保持纯 Node，好在无头测试里直接跑。
// 因此"目标 exe 是哪个"由调用方（ipc/update.js）算好传进来，见 applyUpdate 的 target。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 官方更新源。客户端**开箱即用**的关键：不填也能查，不用玩家自己找 JSON 地址。
 * 官网与更新源是同一个 Deno Deploy 应用，读的是同一份 data/latest.json。
 */
const DEFAULT_FEED_URL = 'https://pebble-site.shitsmart.deno.net/api/update/latest';

/**
 * 备用更新源，按顺序尝试。
 *
 * 教训：2026-10-18 Deno Deploy 免费额度用超，整个官网 503（USAGE_EXCEEDED），
 * 更新检查跟着一起哑了 —— 单一更新源 = 单一故障点。
 * 现在把清单同时作为 Release 资产传一份（`releases/latest/download/latest.json`，
 * 永远指向最新一次发布），再加一个 jsDelivr 镜像（大陆通常可达）。
 * 三个地址互相独立，任何一个活着，更新就能查。
 */
const FALLBACK_FEED_URLS = [
  'https://github.com/SBGAYCHITT/PeBble_lunchar/releases/latest/download/latest.json',
  'https://cdn.jsdelivr.net/gh/SBGAYCHITT/pebble-site@main/data/latest.json',
];

/** 官方源集合（第一个是主源） */
const DEFAULT_FEED_URLS = [DEFAULT_FEED_URL, ...FALLBACK_FEED_URLS];

/** 检查更新时的总超时（这只是拿一个小 JSON，够用） */
const CHECK_TIMEOUT_MS = 15000;
/** 下载时用的是「无数据超时」而不是总超时 —— 79MB 在慢网络下总超时必然误杀 */
const STALL_TIMEOUT_MS = 30000;
/** 进度回调的最小间隔，避免每 64KB 就跨进程喊一次 */
const PROGRESS_STEP_MS = 200;

/**
 * 实际要用哪个更新源：玩家填了就用玩家的，没填（或只填了空格）就走官方源。
 * 纯函数，便于测试「设置页清空之后仍然能检查更新」这条行为。
 * @param {unknown} configured
 * @returns {string}
 */
function effectiveFeedUrl(configured) {
  const s = String(configured == null ? '' : configured).trim();
  return s || DEFAULT_FEED_URL;
}

/**
 * 按顺序要尝试的更新源。
 * 玩家自己填了地址就**只**试它（他可能指向自己的分支，别拿官方包去覆盖），
 * 没填才用官方主源 + 备用源。
 * @param {unknown} configured
 * @returns {string[]}
 */
function effectiveFeedUrls(configured) {
  const s = String(configured == null ? '' : configured).trim();
  return s ? [s] : DEFAULT_FEED_URLS.slice();
}

/**
 * 比较两段版本号（纯函数）。非数字段按字符串比，长度不等按 0 补齐。
 * @returns {-1|0|1}
 */
function compareVersion(a, b) {
  const pa = String(a == null ? '' : a).trim().replace(/^v/i, '').split('.');
  const pb = String(b == null ? '' : b).trim().replace(/^v/i, '').split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] === undefined ? '0' : pa[i];
    const y = pb[i] === undefined ? '0' : pb[i];
    const nx = parseInt(x, 10), ny = parseInt(y, 10);
    if (!isNaN(nx) && !isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      if (String(x) !== String(y)) return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 校验并归一化 feed 内容（纯函数）
 * @returns {{ok:boolean, error?:string, version?:string, notes?:string, url?:string,
 *            publishedAt?:string, sha256?:string, size?:number}}
 */
function parseFeed(raw) {
  if (raw == null || typeof raw !== 'object') return { ok: false, error: '更新清单格式不正确（应为 JSON 对象）' };
  const version = raw.version == null ? '' : String(raw.version).trim();
  if (!version) return { ok: false, error: '更新清单缺少 version 字段' };
  // sha256 统一成小写，比对时不区分大小写（各家后端习惯不一样）
  const sha = raw.sha256 == null ? '' : String(raw.sha256).trim().toLowerCase();
  // size 只接受正数；给了 0 或负数当成"没给"，免得用它算出 0% 的假进度
  const n = Number(raw.size);
  const size = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return {
    ok: true,
    version,
    notes: raw.notes == null ? '' : String(raw.notes),
    url: raw.url == null ? '' : String(raw.url),
    publishedAt: raw.publishedAt == null ? '' : String(raw.publishedAt),
    sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : '',
    size
  };
}

/**
 * 这份清单能不能「自己下载并安装」。
 * 必须同时有可下载的 url 和能校验的 sha256 —— 缺一不可。
 * @param {{url?:string, sha256?:string}} feed
 */
function canAutoInstall(feed) {
  return !!(feed && /^https?:\/\//i.test(String(feed.url || '')) && /^[0-9a-f]{64}$/i.test(String(feed.sha256 || '')));
}

/**
 * 检查更新
 * @param {{feedUrl:string, currentVersion:string, timeoutMs?:number, fetchImpl?:any}} [o]
 * @returns {Promise<{ok:boolean, hasUpdate?:boolean, currentVersion?:string,
 *                    latestVersion?:string, notes?:string, url?:string,
 *                    publishedAt?:string, sha256?:string, size?:number,
 *                    canAutoInstall?:boolean, sameVersion?:boolean, older?:boolean,
 *                    error?:string}>}
 */
async function checkUpdate(o) {
  const opt = /** @type {any} */ (o || {});
  const feedUrl = String(opt.feedUrl || '').trim();
  if (!feedUrl) return { ok: false, error: '未配置更新源地址' };
  if (!/^https?:\/\//i.test(feedUrl)) return { ok: false, error: '更新源地址必须是 http(s) 链接' };
  // fetchImpl 由 Electron 层注入（net.fetch 走 Chromium 网络栈，认系统代理）；
  // Node 自带的 fetch(undici) 不读系统代理，大陆直连 GitHub 会直接超时。
  const doFetch = opt.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, error: '当前运行环境不支持网络请求' };

  const timeoutMs = opt.timeoutMs || CHECK_TIMEOUT_MS;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    /** @type {any} */
    const init = Object.assign({ redirect: /** @type {any} */ ('follow') }, ctrl ? { signal: ctrl.signal } : {});
    const res = await doFetch(feedUrl, init);
    if (!res.ok) return { ok: false, error: '更新源返回 HTTP ' + res.status };
    const json = /** @type {any} */ (await res.json());
    const feed = parseFeed(json);
    if (!feed.ok) return feed;
    const cmp = compareVersion(feed.version, opt.currentVersion);
    return {
      ok: true,
      hasUpdate: cmp > 0,
      currentVersion: opt.currentVersion,
      latestVersion: feed.version,
      notes: feed.notes,
      url: feed.url,
      publishedAt: feed.publishedAt,
      sha256: feed.sha256,
      size: feed.size,
      canAutoInstall: canAutoInstall(feed),
      sameVersion: cmp === 0,
      older: cmp < 0
    };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: '检查更新超时' };
    return { ok: false, error: '检查更新失败: ' + (e && e.message ? e.message : String(e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 依次尝试多个更新源，返回第一个成功的。
 * 单个源超时压到 8 秒：三个源全挂时，不能让玩家干等 45 秒才知道「查不到」。
 *
 * @param {{feedUrls:string[], currentVersion:string, timeoutMs?:number,
 *          onTry?:(url:string, index:number)=>void}} o
 * @returns {Promise<any>}
 */
async function checkUpdateAny(o) {
  const opt = /** @type {any} */ (o || {});
  const list = (Array.isArray(opt.feedUrls) ? opt.feedUrls : [])
    .map((u) => String(u || '').trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: '未配置更新源地址' };
  const perTry = opt.timeoutMs || Math.min(CHECK_TIMEOUT_MS, 8000);
  /** @type {any} */
  let last = null;
  for (let i = 0; i < list.length; i++) {
    if (typeof opt.onTry === 'function') {
      try { opt.onTry(list[i], i); } catch { /* 回调出错不影响检查本身 */ }
    }
    const r = await checkUpdate({
      feedUrl: list[i],
      currentVersion: opt.currentVersion,
      timeoutMs: perTry,
      fetchImpl: opt.fetchImpl
    });
    if (r && r.ok) return Object.assign({}, r, { feedUrlUsed: list[i], tried: i + 1 });
    last = r;
  }
  return Object.assign({}, last || { ok: false, error: '所有更新源都不可用' }, { tried: list.length });
}

/** 挂自定义字段的 Error（tsconfig 的 checkJs 下必须标 any，同 worldmerge/pebblecloud 的写法） */
function updErr(code, msg) {
  /** @type {any} */
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * 把 fetch 返回的人话翻译一下（沿用 pebblecloud 的口径，不另起一套说法）
 * @param {any} e
 */
function describeNet(e) {
  const m = String((e && e.message) || e || '');
  const c = String((e && e.code) || '');
  if (/ENOTFOUND|EAI_AGAIN/i.test(m + c)) return '域名解析失败，检查网络或更新源地址';
  if (/ECONNREFUSED/i.test(m + c)) return '连接被拒绝，更新源可能没在运行';
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/i.test(m + c)) return '连接中断了，可能是网络不稳';
  if (/CERT|SSL|TLS/i.test(m + c)) return 'HTTPS 证书校验失败';
  if (/fetch failed/i.test(m)) return '网络不可达';
  return m || '未知网络错误';
}

/** 保证整块写完（fs.writeSync 允许部分写，慢盘/大块时会真的发生） */
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/**
 * 下载安装包到本地，边下边算 SHA-256。
 *
 * 用的是「无数据超时」：每收到一块就把计时器往后推，所以慢但不断线的网络不会被误杀，
 * 而"连上了却一个字节都不来"能在 STALL_TIMEOUT_MS 内被发现。
 *
 * @param {{url:string, dest:string, sha256?:string, size?:number,
 *          onProgress?:(p:{received:number,total:number,percent:number,speed:number})=>void,
 *          stallMs?:number, isCancelled?:()=>boolean, fetchImpl?:any}} o
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, sha256?:string,
 *                    code?:string, error?:string, cancelled?:boolean}>}
 */
async function downloadUpdate(o) {
  const opt = /** @type {any} */ (o || {});
  const url = String(opt.url || '').trim();
  const dest = String(opt.dest || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, code: 'UPD_URL', error: '下载地址必须是 http(s) 链接' };
  if (!dest) return { ok: false, code: 'UPD_URL', error: '没有指定保存位置' };
  const f = opt.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, code: 'UPD_NET', error: '当前运行环境不支持网络请求' };

  const expectHash = String(opt.sha256 || '').trim().toLowerCase();
  const stallMs = opt.stallMs || STALL_TIMEOUT_MS;
  const isCancelled = typeof opt.isCancelled === 'function' ? opt.isCancelled : () => false;

  // 半截文件写 .part，成了再改名 —— 这样"下到一半断网"不会在目录里留下一个看起来像成品的 exe
  const tmp = dest + '.part';
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* 建不出来下一步自会报 */ }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* 残留删不掉就覆盖 */ }

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let stallTimer = null;
  const armStall = () => {
    if (!ctrl) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(), stallMs);
  };
  const disarm = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };

  let fd = -1;
  try {
    armStall();
    /** @type {any} */
    const init = Object.assign({ redirect: /** @type {any} */ ('follow') }, ctrl ? { signal: ctrl.signal } : {});
    const res = await f(url, init);
    if (!res.ok) {
      disarm();
      return { ok: false, code: 'UPD_HTTP', error: '下载失败：更新源返回 HTTP ' + res.status };
    }

    // 服务端给了 Content-Length 就以它为准；清单里的 size 只在断点/预告时用
    const headerLen = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    const total = Number.isFinite(headerLen) && headerLen > 0 ? headerLen : (opt.size || 0);

    if (!res.body || typeof res.body.getReader !== 'function') {
      disarm();
      return { ok: false, code: 'UPD_NET', error: '下载失败：响应没有可读的内容' };
    }

    fd = fs.openSync(tmp, 'w');
    const hash = crypto.createHash('sha256');
    const reader = res.body.getReader();
    let received = 0;
    let lastTick = 0;
    let lastBytes = 0;
    let lastAt = Date.now();

    for (;;) {
      if (isCancelled()) {
        disarm();
        try { fs.closeSync(fd); fd = -1; } catch { /* 已关 */ }
        try { fs.unlinkSync(tmp); } catch { /* 删不掉也不该卡住取消流程 */ }
        return { ok: false, code: 'UPD_CANCEL', error: '已取消下载', cancelled: true };
      }
      const step = await reader.read();
      if (step.done) break;
      const chunk = Buffer.from(step.value);
      if (!chunk.length) continue;
      armStall();                    // 收到数据就把"没有数据"的计时器往后推
      hash.update(chunk);
      writeAll(fd, chunk);
      received += chunk.length;

      const now = Date.now();
      if (opt.onProgress && now - lastTick >= PROGRESS_STEP_MS) {
        const dt = (now - lastAt) / 1000;
        opt.onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
          speed: dt > 0 ? Math.round((received - lastBytes) / dt) : 0
        });
        lastTick = now; lastBytes = received; lastAt = now;
      }
    }
    disarm();
    fs.closeSync(fd); fd = -1;

    // 收尾时补一次 100%，免得停在 97% 让人以为没下完
    if (opt.onProgress) opt.onProgress({ received, total: total || received, percent: 100, speed: 0 });

    // 大小对不上就直接判失败：要么下载被截断，要么清单写错了，两种情况都不该往下走
    if (opt.size > 0 && received !== opt.size) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, code: 'UPD_SIZE', error: `下载不完整（收到 ${received} 字节，清单说 ${opt.size} 字节）` };
    }

    const got = hash.digest('hex');
    if (expectHash && got !== expectHash) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return { ok: false, code: 'UPD_HASH', error: '下载的文件校验不过（SHA-256 不匹配），已丢弃。可能是下载被篡改或清单过期' };
    }

    fs.renameSync(tmp, dest);
    return { ok: true, path: dest, bytes: received, sha256: got };
  } catch (e) {
    disarm();
    if (fd >= 0) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    const aborted = e && (e.name === 'AbortError' || String(e.code) === 'ABORT_ERR');
    if (aborted && !isCancelled()) {
      return { ok: false, code: 'UPD_TIMEOUT', error: `下载卡住了（${Math.round(stallMs / 1000)} 秒没有任何数据）` };
    }
    if (aborted) return { ok: false, code: 'UPD_CANCEL', error: '已取消下载', cancelled: true };
    return { ok: false, code: 'UPD_NET', error: '下载失败：' + describeNet(e) };
  }
}

/**
 * 生成"等旧进程退出 → 覆盖 → 重启"的批处理（纯函数，便于单测）。
 *
 * Windows 不允许覆盖正在运行的 exe，所以替换必须在**本进程退出之后**由外部执行。
 * 只等 PID 消失还不够稳（文件句柄可能晚一拍释放），所以 copy 失败会再重试几轮。
 *
 * 编码：中文 Windows 的 cmd 默认按 GBK 读 bat，路径里一有中文就会乱码，
 * 所以脚本存成 UTF-8 无 BOM 并在第一行 chcp 65001（这一行自己已被按 GBK 解释，但生效后后续行按 UTF-8 读）。
 *
 * @param {{staged:string, target:string, pid?:number, restart?:boolean, tries?:number, pidWait?:number}} o
 * @returns {string}
 */
function buildApplyScript(o) {
  const staged = String(o.staged);
  const target = String(o.target);
  const pid = o.pid == null ? 0 : Number(o.pid);
  const tries = o.tries == null ? 30 : Number(o.tries);
  const pidWait = o.pidWait == null ? 120 : Number(o.pidWait);
  const lines = [
    '@echo off',
    'chcp 65001 >NUL',
    'setlocal'
  ];
  if (pid > 0) {
    // ⚠️ 变量只出现在**非括号块**的行里 —— cmd 是读一行解释一行，
    // 放进 if (...) 块里 %w% 在解析整块时就固定住了，计数永远涨不上去（要 setlocal enabledelayedexpansion 才行）。
    // 这里干脆全用 goto 展开，避开那个陷阱。等待也必须有上限：万一应用没了结干净，脚本不能永远赖着。
    lines.push(
      'set /a w=0',
      ':wait_pid',
      'timeout /t 1 /nobreak >NUL',
      `tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL`,
      'if errorlevel 1 goto pid_gone',
      'set /a w+=1',
      `if %w% lss ${pidWait} goto wait_pid`,
      ':pid_gone'
    );
  } else {
    lines.push('timeout /t 2 /nobreak >NUL');
  }
  lines.push(
    'set /a n=0',
    ':do_copy',
    `copy /Y "${staged}" "${target}" >NUL 2>&1`,
    'if not errorlevel 1 goto copied',
    'set /a n+=1',
    `if %n% lss ${tries} goto do_copy`,
    'exit /b 1',
    ':copied'
  );
  if (o.restart !== false) lines.push(`start "" "${target}"`);
  lines.push('del "%~f0"');
  // bat 必须是 CRLF，否则 labels/goto 在某些环境下会出怪问题
  return lines.join('\r\n') + '\r\n';
}

/**
 * 落盘脚本并准备执行（不负责退出应用，那是调用方的事）。
 *
 * @param {{staged:string, target:string, pid?:number, restart?:boolean,
 *          scriptPath?:string, onSpawn?:(cmd:string,args:string[],opts:any)=>any}} o
 * @returns {{ok:boolean, script?:string, pid?:number, error?:string}}
 */
function applyUpdate(o) {
  const opt = /** @type {any} */ (o || {});
  const staged = String(opt.staged || '').trim();
  const target = String(opt.target || '').trim();
  if (!staged || !fs.existsSync(staged)) return { ok: false, error: '待安装的文件不存在，请重新下载' };
  if (!target) return { ok: false, error: '不知道要替换哪个程序（目标路径为空）' };
  if (!/\.exe$/i.test(target)) return { ok: false, error: '目标路径不像可执行文件，已拒绝替换以免误删' };
  if (path.resolve(staged) === path.resolve(target)) return { ok: false, error: '待安装文件与目标文件是同一个' };

  // 脚本跟待安装文件放一起，别丢进 exe 所在目录（那里可能是只读的 Program Files）
  const script = opt.scriptPath || path.join(path.dirname(staged), 'pl-apply-update.bat');
  const body = buildApplyScript({
    staged, target, pid: opt.pid, restart: opt.restart, tries: opt.tries, pidWait: opt.pidWait
  });
  try {
    fs.writeFileSync(script, Buffer.from(body, 'utf8'));
  } catch (e) {
    return { ok: false, error: '写替换脚本失败：' + (e && e.message ? e.message : String(e)) };
  }

  // 真正起进程的活儿交给调用方注入（ipc 层用 child_process），这样本模块依然可无头测试
  if (typeof opt.onSpawn === 'function') {
    try {
      opt.onSpawn(script, body);
    } catch (e) {
      return { ok: false, error: '启动替换脚本失败：' + (e && e.message ? e.message : String(e)) };
    }
  }
  return { ok: true, script, pid: opt.pid };
}

module.exports = {
  DEFAULT_FEED_URL, DEFAULT_FEED_URLS, FALLBACK_FEED_URLS, CHECK_TIMEOUT_MS, STALL_TIMEOUT_MS,
  effectiveFeedUrl, effectiveFeedUrls, compareVersion, parseFeed, canAutoInstall,
  checkUpdate, checkUpdateAny, downloadUpdate, buildApplyScript, applyUpdate
};
