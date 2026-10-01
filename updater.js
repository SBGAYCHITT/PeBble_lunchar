// 自动更新检查：拉一份 JSON 清单，比版本号，有新版就给出说明与下载地址。
//
// 为什么不用 electron-updater：它强绑定 GitHub/对象存储这类发布渠道，还得配 publish，
// 而本项目是"自己发行"。这里做成"喂一个任意可访问的 JSON 地址就行"，
// 静态站点、网盘直链、对象存储都能当更新源。真要换成 electron-updater 也只是替换这一层。
//
// 清单格式（feed）：
//   { "version": "1.1.0", "notes": "修复了…", "url": "https://…/Pebble-Lunchar.exe", "publishedAt": "2026-09-23" }

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
 * @returns {{ok:boolean, error?:string, version?:string, notes?:string, url?:string, publishedAt?:string}}
 */
function parseFeed(raw) {
  if (raw == null || typeof raw !== 'object') return { ok: false, error: '更新清单格式不正确（应为 JSON 对象）' };
  const version = raw.version == null ? '' : String(raw.version).trim();
  if (!version) return { ok: false, error: '更新清单缺少 version 字段' };
  return {
    ok: true,
    version,
    notes: raw.notes == null ? '' : String(raw.notes),
    url: raw.url == null ? '' : String(raw.url),
    publishedAt: raw.publishedAt == null ? '' : String(raw.publishedAt)
  };
}

/**
 * 检查更新
 * @param {{feedUrl:string, currentVersion:string, timeoutMs?:number}} [o]
 * @returns {Promise<{ok:boolean, hasUpdate?:boolean, currentVersion?:string,
 *                    latestVersion?:string, notes?:string, url?:string,
 *                    publishedAt?:string, sameVersion?:boolean, older?:boolean,
 *                    error?:string}>}
 */
async function checkUpdate(o) {
  const opt = /** @type {any} */ (o || {});
  const feedUrl = String(opt.feedUrl || '').trim();
  if (!feedUrl) return { ok: false, error: '未配置更新源地址' };
  if (!/^https?:\/\//i.test(feedUrl)) return { ok: false, error: '更新源地址必须是 http(s) 链接' };
  if (typeof fetch !== 'function') return { ok: false, error: '当前运行环境不支持网络请求' };

  const timeoutMs = opt.timeoutMs || 15000;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    /** @type {any} */
    const init = Object.assign({ redirect: /** @type {any} */ ('follow') }, ctrl ? { signal: ctrl.signal } : {});
    const res = await fetch(feedUrl, init);
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

module.exports = { compareVersion, parseFeed, checkUpdate };
