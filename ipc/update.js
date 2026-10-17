// 自动更新域：检查 / 下载 / 校验 / 替换重启。
//
// 从 ipc/system.js 迁出来的 —— 那边原本只有 update-check / update-feed-set 两条，
// 单看像"顺手检查一下版本"；加上下载与安装之后是完整一条链，放一块才看得清。
// 通道名**刻意保持不变**：tests/ipc-contract.test.js 是拿 preload 里的 invoke 名字
// 跟 ipcMain.handle 的名字静态对账的，两边同时改名会"看起来都对"却和渲染层失联。
//
// ⚠️ 进度为什么走 emit 而不是 invoke 的返回值：79MB 的包按分钟计。
//    ipcRenderer.invoke 挂那么久，渲染层既拿不到进度也没法取消，只能干等。
//    所以 update-download 立刻返回 {started:true}，过程与结果都从 'update-progress' 事件推。

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, shell, Notification } = require('electron');
const updater = require('../updater');

/** 同一时刻只允许一个下载任务 */
/** @type {{cancelled:boolean, version:string, dest:string, percent:number, received:number, total:number, speed:number}|null} */
let job = null;

/** 已下载、待安装的包（下载成功后才赋值） */
/** @type {{version:string, path:string, bytes:number, sha256:string}|null} */
let staged = null;

/**
 * 要替换的到底是哪个 exe。
 *
 * ⚠️ 这是本域最容易写错的一行。portable 包运行时会把自身解压到 %TEMP% 下再跑，
 * 于是 app.getPath('exe') 指的是那个**临时副本**。照着它替换 = 换了临时文件，
 * 下次双击原文件还是旧版 —— 静默失效，且现场什么错都看不到。
 * electron-builder 为此专门提供 PORTABLE_EXECUTABLE_FILE，指的就是用户双击的那一份。
 * @returns {{path:string, portable:boolean}}
 */
function targetExe() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && fs.existsSync(portable)) return { path: portable, portable: true };
  return { path: app.getPath('exe'), portable: false };
}

/** 版本号会被拼进文件名，先洗一遍，免得 `../` 之类跑出目录 */
function safeVersion(v) {
  return String(v || '').trim().replace(/[^0-9A-Za-z._-]/g, '');
}

/**
 * 扫一遍下载目录，找出已下载好待安装的最高版本。
 * 重启之后 staged 变量是空的，但文件还在 —— 这里恢复它，否则用户重启一次就白下了。
 * @param {string} dir
 */
function scanStaged(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    const m = /^Pebble-Lunchar-(.+)\.exe$/i.exec(n);
    if (!m) continue;
    const full = path.join(dir, n);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.size < 1024 * 1024) continue;
    if (!best || updater.compareVersion(m[1], best.version) > 0) {
      best = { version: m[1], path: full, bytes: st.size, sha256: '' };
    }
  }
  return best;
}

/**
 * 下载并即时回报进度（fire-and-forget，调用方不等它）
 * @param {{url:string, dest:string, sha256:string, size:number, version:string}} o
 * @param {import('./index').IpcContext} ctx
 */
function runDownload(o, ctx) {
  /** @param {any} p */
  const push = (p) => ctx.emit('update-progress', Object.assign({ version: o.version }, p));
  /** @param {any} e */
  const msg = (e) => (e && e.message ? e.message : String(e));

  updater.downloadUpdate({
    url: o.url,
    dest: o.dest,
    sha256: o.sha256,
    size: o.size,
    isCancelled: () => !!(job && job.cancelled),
    onProgress: (p) => { if (job) Object.assign(job, p); push(Object.assign({ phase: 'downloading' }, p)); }
  }).then((r) => {
    if (r.ok) {
      staged = { version: o.version, path: /** @type {string} */ (r.path), bytes: r.bytes || 0, sha256: r.sha256 || '' };
      push({ phase: 'done', bytes: r.bytes, sha256: r.sha256, percent: 100 });
      if (Notification.isSupported()) {
        new Notification({
          title: '更新已下载完成',
          body: `Pebble Lunchar ${o.version} 已就绪，重启启动器即可生效`
        }).show();
      }
      return;
    }
    push({ phase: r.cancelled ? 'cancelled' : 'error', code: r.code, error: r.error });
  }).catch((e) => {
    push({ phase: 'error', error: '下载出错：' + msg(e) });
  }).finally(() => { job = null; });
}

/**
 * @param {import('./index').IpcContext} ctx
 */
module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  /** 下载目录：放在 userData 下，和游戏目录分开；换游戏目录不会把下好的包丢了 */
  const updatesDir = () => path.join(ctx.userData, 'updates');

  staged = scanStaged(updatesDir());   // 上次下载没来得及装，这次接着用

  /* ---------- 检查 ---------- */

  ipcMain.handle('update-check', async (_e, feedUrl) => {
    const url = String(feedUrl || ctx.getSysConf().updateFeed || '').trim();
    const r = await updater.checkUpdate({ feedUrl: url, currentVersion: app.getVersion() });
    if (r.ok && r.hasUpdate && Notification.isSupported()) {
      new Notification({
        title: 'Pebble Lunchar 有新版本 ' + r.latestVersion,
        body: r.canAutoInstall ? '可在「设置 → 系统与更新」里直接下载安装' : '可在「设置 → 系统与更新」查看并下载'
      }).show();
    }
    return r;
  });

  ipcMain.handle('update-feed-set', (_e, url) => {
    ctx.patchSysConf({ updateFeed: String(url || '').trim() });
    return { ok: true, updateFeed: ctx.getSysConf().updateFeed };
  });

  /* ---------- 状态 ---------- */

  ipcMain.handle('update-status', () => {
    const t = targetExe();
    return {
      ok: true,
      currentVersion: app.getVersion(),
      feed: ctx.getSysConf().updateFeed || '',
      target: t.path,
      portable: t.portable,
      job: job ? {
        active: true, version: job.version, percent: job.percent,
        received: job.received, total: job.total, speed: job.speed
      } : null,
      staged
    };
  });

  /* ---------- 下载 ---------- */

  ipcMain.handle('update-download', (_e, o) => {
    if (job) return { ok: false, error: '已经有一个更新包在下载中了' };
    const opt = o || {};
    const url = String(opt.url || '').trim();
    const sha = String(opt.sha256 || '').trim().toLowerCase();
    const version = safeVersion(opt.version);
    // 没给校验值就不自动装：更新器是最不该被冒充的组件，装个验不了的包等于自毁
    if (!updater.canAutoInstall({ url, sha256: sha })) {
      return { ok: false, error: '这份更新清单没提供校验值（sha256），无法自动安装。请用「打开下载页」手动下载。' };
    }
    const dest = path.join(updatesDir(), 'Pebble-Lunchar-' + (version || 'update') + '.exe');
    job = { cancelled: false, version, dest, percent: 0, received: 0, total: Number(opt.size) || 0, speed: 0 };
    runDownload({ url, dest, sha256: sha, size: Number(opt.size) || 0, version }, ctx);
    return { ok: true, started: true, dest };
  });

  ipcMain.handle('update-cancel', () => {
    if (!job) return { ok: false, error: '当前没有下载任务' };
    job.cancelled = true;
    return { ok: true };
  });

  /* ---------- 安装 ---------- */

  ipcMain.handle('update-apply', () => {
    if (!staged) return { ok: false, error: '还没有下载好的更新包' };
    if (!fs.existsSync(staged.path)) {
      staged = null;
      return { ok: false, error: '更新包已经不在了（可能被清理过），请重新下载' };
    }
    const t = targetExe();
    const r = updater.applyUpdate({
      staged: staged.path,
      target: t.path,
      pid: process.pid,
      restart: true,
      onSpawn: (script) => {
        // 脚本自己会等本进程退出再动手；detached 保证它不随我们被一起收走
        spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    });
    if (!r.ok) return r;
    // 留一点时间让渲染层把"正在重启…"显示出来，再退出
    setTimeout(() => { try { app.quit(); } catch { app.exit(0); } }, 300);
    return { ok: true, target: t.path, portable: t.portable };
  });

  /* ---------- 杂项 ---------- */

  ipcMain.handle('update-open-folder', () => {
    shell.openPath(updatesDir());
    return { ok: true, dir: updatesDir() };
  });
};
