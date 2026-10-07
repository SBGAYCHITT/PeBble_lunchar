// Pebble Lunchar 主进程：窗口 / 托盘 / 生命周期装配。
// 所有 ipcMain.handle 已按域拆到 ./ipc（见 ipc/index.js），这里只负责提供它们需要的上下文。
const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const mcapi = require('./mcapi');
const multilaunch = require('./multilaunch');
const tray = require('./tray');
const sysconf = require('./sysconf');
const i18n = require('./i18n');
const ipc = require('./ipc');

let win = null;
let trayHandle = null;   // 托盘句柄（含 refresh）
let quitting = false;    // 真要退出时置 true，避免被"最小化到托盘"拦下来
let launching = false;   // 供托盘菜单判断"启动游戏"能否点击

/* 系统级配置持久化：开机自启 / 最小化到托盘 / 语言 / 更新源。
   单独存一份 JSON，不塞渲染层的 localStorage —— 托盘在窗口创建之前就要读它。 */
const SYS_CONF_PATH = path.join(app.getPath('userData'), 'sysconf.json');
const SYS_CONF_DEFAULT = { autostart: false, minimizeToTray: false, lang: 'zh-CN', updateFeed: '' };
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

function createWindow() {
  // 目标 1440×900，但不能超过屏幕工作区 —— 1280×800 的笔记本上窗口会被系统硬压回来，
  // 与其让系统裁，不如自己算清楚，顺带保证不会跑到屏幕外面去。
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1440, wa.width);
  const height = Math.min(900, wa.height);
  win = new BrowserWindow({
    width,
    height,
    minWidth: 1180,
    minHeight: 700,
    frame: false,
    transparent: false,   // V4.1.0：界面改成纯白，不再需要窗口透明
    resizable: true,
    maximizable: true,
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
  // 必须用 __dirname：相对路径会跟着 app 启动目录跑，换个 cwd 就白屏
  win.loadFile(path.join(__dirname, 'index.html'));
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
}

/* 托盘菜单要显示"最近一次启动用的版本/账户"，主进程自己记一份 */
let lastLaunch = { version: '', playerName: '', gameDir: '' };

function refreshTray() { if (trayHandle) trayHandle.refresh(); }

function trayState() {
  const running = (multilaunch.list() || []).filter((x) => x.alive !== false).length;
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
        multilaunch.stopAll((s) => emit('game-log', '[多开] ' + s));
        emit('ml-changed', multilaunch.list());
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
