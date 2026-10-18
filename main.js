// Pebble Launcher 主进程：窗口 / 托盘 / 生命周期装配。
// 所有 ipcMain.handle 已按域拆到 ./ipc（见 ipc/index.js），这里只负责提供它们需要的上下文。
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

/* 改名迁移：Pebble Lunchar → Pebble Launcher。
   打包后 userData 目录名跟着 productName 走，改完名会指向一个空目录 ——
   玩家的设置、实例列表、自带 Java、时光机仓库全在旧目录里。
   所以第一次启动时整体搬过去，只搬一次；旧版还开着导致搬不动，就继续用旧目录。 */
(function adoptLegacyUserData() {
  try {
    const appData = app.getPath('appData');
    // 打包版按 productName 建目录，开发时按 package.json 的 name 建 —— 两种都要接上
    const pairs = [
      ['Pebble Lunchar', 'Pebble Launcher'],
      ['pebble-lunchar', 'pebble-launcher'],
    ];
    for (const [oldName, newName] of pairs) {
      const prevDir = path.join(appData, oldName);
      const nextDir = path.join(appData, newName);
      if (!fs.existsSync(nextDir) && fs.existsSync(prevDir)) {
        try {
          fs.renameSync(prevDir, nextDir);
        } catch {
          // 旧版还开着、文件被占用：这一次仍用旧目录，下次启动再搬
          app.setPath('userData', prevDir);
          return;
        }
      }
    }
  } catch (e) {
    console.warn('[main] 用户数据目录迁移失败，继续使用默认目录：', e && e.message);
  }
})();
const mcapi = require('./mcapi');
// Lite 版会把多开登记一起裁掉。取不到就当「没有并行多开」，
// 托盘的运行数显示 0、停止项点了也没反应 —— 但不能因此让主进程起不来。
let multilaunch = null;
try { multilaunch = require('./multilaunch'); }
catch (e) {
  if (!(e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'./multilaunch'"))) throw e;
}
const tray = require('./tray');
const sysconf = require('./sysconf');
const i18n = require('./i18n');
const ipc = require('./ipc');

let win = null;
let trayHandle = null;   // 托盘句柄（含 refresh）
let quitting = false;    // 真要退出时置 true，避免被"最小化到托盘"拦下来
let launching = false;   // 供托盘菜单判断"启动游戏"能否点击

/* 系统级配置持久化：开机自启 / 最小化到托盘 / 语言 / 更新源 / 上次的窗口大小。
   单独存一份 JSON，不塞渲染层的 localStorage —— 托盘在窗口创建之前就要读它。 */
const SYS_CONF_PATH = path.join(app.getPath('userData'), 'sysconf.json');
/** @type {{ autostart:boolean, minimizeToTray:boolean, lang:string, updateFeed:string, winSize:{w:number,h:number}|null }} */
const SYS_CONF_DEFAULT = { autostart: false, minimizeToTray: false, lang: 'zh-CN', updateFeed: '', winSize: null };
/** @type {typeof SYS_CONF_DEFAULT} */
let sysConf = Object.assign({}, SYS_CONF_DEFAULT);

function loadSysConf() {
  try {
    sysConf = Object.assign({}, SYS_CONF_DEFAULT, JSON.parse(fs.readFileSync(SYS_CONF_PATH, 'utf8')));
  } catch { sysConf = Object.assign({}, SYS_CONF_DEFAULT); }
  i18n.setLang(sysConf.lang);
  return sysConf;
}
function saveSysConf(patch) {
  sysConf = Object.assign({}, sysConf, patch || {});
  try {
    fs.mkdirSync(path.dirname(SYS_CONF_PATH), { recursive: true });
    fs.writeFileSync(SYS_CONF_PATH, JSON.stringify(sysConf, null, 2));
  } catch {}
  return sysConf;
}

// 时光机的块级去重仓库：放在 userData 下，和 .minecraft 分开，
// 这样即使玩家换了游戏目录，历史快照也不会跟着丢。
const TM_DIR = path.join(app.getPath('userData'), 'timemachine');
const AUTO_KEEP = 10;      // 每个存档/实例保留多少个自动快照
const INST_ROOT = path.join(app.getPath('userData'), 'instances');
const JAVA_ROOT = app.getPath('userData');   // 自带 Java 装这里，换游戏目录不会跟着丢

const emit = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// 窗口尺寸下限：顶部菜单栏会自动横向滚动、主区两列也能收，所以下限只保到"消息区还能看"。
// 上限刻意不设 —— 玩家想拉多大就拉多大，别替他决定。
const MIN_W = 960;
const MIN_H = 620;
let winSizeTimer = null;

/** 记住玩家自己拖出来的窗口大小（防抖 400ms，拖动过程中不写盘） */
function scheduleWinSizeSave() {
  if (winSizeTimer) clearTimeout(winSizeTimer);
  winSizeTimer = setTimeout(() => {
    winSizeTimer = null;
    if (!win || win.isDestroyed()) return;
    // 最大化 / 全屏 / 最小化时的尺寸不是玩家的选择，不记
    if (win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    try {
      const b = win.getNormalBounds();
      if (b.width >= MIN_W && b.height >= MIN_H) saveSysConf({ winSize: { w: b.width, h: b.height } });
    } catch {}
  }, 400);
}

function createWindow() {
  // 尺寸不写死：优先恢复玩家上次拖出来的大小，第一次启动才用 1440×900。
  // 两种情况都要夹进屏幕工作区 —— 1280×800 的笔记本上直接给 1440×900 会被系统硬压回来，
  // 与其让系统裁，不如自己算清楚，顺带保证不会跑到屏幕外面去。
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const saved = sysConf.winSize;
  const width = Math.min(Math.max(saved ? saved.w : 1440, MIN_W), wa.width);
  const height = Math.min(Math.max(saved ? saved.h : 900, MIN_H), wa.height);
  win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: false,   // V4.1.0：界面改成纯白，不再需要窗口透明
    resizable: true,
    maximizable: true,
    // frameless 窗口在 Windows 上靠 thickFrame 提供原生缩放边框；
    // 显式写上，免得哪天被误设成 false 之后四边都拖不动。
    thickFrame: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 渲染层与 Node 隔离
      nodeIntegration: false,   // 渲染层不直连 Node
      sandbox: true,            // 开启沙箱（preload 受限，仅能通过 contextBridge 暴露 API）
      webSecurity: true,        // 不关闭同源策略
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });
  try { win.setBackgroundColor('#ffffff'); } catch {}
  // 必须用 __dirname：相对路径会跟着 app 启动目录跑，换个 cwd 就白屏。
  // Lite 版会多打一份裁剪过页面入口 index.lite.html（见 scripts/make-lite.js），
  // 有它就优先用；标准版包里没有这个文件，走的仍然是 index.html。
  const litePage = path.join(__dirname, 'index.lite.html');
  win.loadFile(fs.existsSync(litePage) ? litePage : path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; refreshTray(); });
  // 开了"最小化到托盘"之后，点关闭只是把窗口藏起来，托盘里还能叫回来
  win.on('close', (e) => {
    if (sysConf.minimizeToTray && !quitting) {
      e.preventDefault();
      win.hide();
      refreshTray();
    }
  });
  win.on('show', () => refreshTray());
  win.on('hide', () => refreshTray());
  // 玩家拖四边改完大小就记下来（防抖，见 scheduleWinSizeSave）
  win.on('resize', scheduleWinSizeSave);
}

/* 托盘菜单要显示"最近一次启动用的版本/账户"，主进程自己记一份 */
let lastLaunch = { version: '', playerName: '', gameDir: '' };

function refreshTray() { if (trayHandle) trayHandle.refresh(); }

function trayState() {
  const running = multilaunch ? (multilaunch.list() || []).filter((x) => x.alive !== false).length : 0;
  return {
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    launching,
    running,
    version: lastLaunch.version,
    playerName: lastLaunch.playerName || '未登录',
    autostart: !!sysConf.autostart,
    gameDir: lastLaunch.gameDir
  };
}

function setAutoStart(enable) {
  saveSysConf({ autostart: !!enable });
  sysconf.setLoginItem(!!enable, false);
  refreshTray();
  return { ok: true, autostart: !!enable, settings: sysconf.getLoginItem() };
}

function setupTray() {
  // 托盘在部分远程会话/精简系统里会创建失败，失败就当没这功能，不能拖崩启动器
  trayHandle = tray.createTray({
    getState: trayState,
    onAction: (id) => {
      if (id === 'toggle') {
        if (!win || win.isDestroyed()) { createWindow(); return; }
        if (win.isVisible()) win.hide(); else { win.show(); win.focus(); }
      } else if (id === 'launch') {
        emit('tray-action', 'launch');   // 渲染层收到后按当前选择启动
      } else if (id === 'stopall') {
        if (multilaunch) {
          multilaunch.stopAll((s) => emit('game-log', '[多开] ' + s));
          emit('ml-changed', multilaunch.list());
        }
      } else if (id === 'openGameDir') {
        if (lastLaunch.gameDir) mcapi.openFolder(lastLaunch.gameDir);
      } else if (id === 'autostart') {
        setAutoStart(!sysConf.autostart);
        emit('sysconf-changed', sysConf);
      } else if (id === 'quit') {
        quitting = true; app.quit();
      }
      refreshTray();
    }
  });
}

/* ---------- 装配 IPC ---------- */
const ipcCtx = {
  ipcMain, dialog, emit,
  getWin: () => win,
  getSysConf: () => sysConf,
  patchSysConf: (patch) => saveSysConf(patch),
  setAutoStart,
  refreshTray,
  setLaunching: (v) => { launching = !!v; },
  getLaunching: () => launching,
  setLastLaunch: (o) => { lastLaunch = o || { version: '', playerName: '', gameDir: '' }; },
  getLastLaunch: () => lastLaunch,
  TM_DIR, INST_ROOT, JAVA_ROOT, AUTO_KEEP,
  userData: app.getPath('userData'),
  APP_DIR: __dirname
};

app.whenReady().then(() => {
  loadSysConf();
  ipc.registerAll(ipcCtx);   // 先注册，避免渲染层抢在 handler 就绪前发请求
  createWindow();
  setupTray();
});

app.on('window-all-closed', () => { if (!sysConf.minimizeToTray) app.quit(); });
