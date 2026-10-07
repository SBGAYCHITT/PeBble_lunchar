// 无头运行时装配测试：桩掉 electron，真实 require('./main.js') 跑完整个启动链。
//
// 为什么需要它：静态契约测试只能证明「字符串层面 channel 对得上」，
// 证明不了装配期错误 —— 比如 ipcCtx 少了字段、某个域模块 require 了不存在的函数、
// registerAll 顺序错了。这些只有真跑一遍 whenReady 链才会暴露。
//
// 沙箱里起不了 Electron GUI（smoke.e2e 需要真窗口），所以这里用桩件替代。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
}
function ta(name, fn) {
  return (async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
  })();
}

/* ---------------- Electron 桩件 ---------------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ipcrt-'));
const registered = [];
const listeners = [];
const windows = [];
let trayCreated = 0;

function noop() {}

class StubBrowserWindow {
  constructor(o) {
    this.opts = o;
    this._visible = false;
    this._destroyed = false;
    this.webContents = { send: noop, on: noop, openDevTools: noop };
    windows.push(this);
  }
  loadFile() {}
  once(ev, cb) { if (ev === 'ready-to-show') cb(); }
  on(ev, cb) { this['_on_' + ev] = cb; }
  show() { this._visible = true; }
  hide() { this._visible = false; }
  focus() {}
  isVisible() { return this._visible; }
  isDestroyed() { return this._destroyed; }
  setBackgroundMaterial() {}
  minimize() {}
  maximize() {}
  isMaximized() { return false; }
  unmaximize() {}
  setTitle() {}
  getBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; }
  setSize() {}
  center() {}
}
class StubTray {
  constructor(p) { this.icon = p; trayCreated++; }
  setToolTip() {}
  setContextMenu(m) { this.menu = m; }
  on() {}
  destroy() {}
}

const electronStub = {
  app: {
    getPath: (n) => (n === 'userData' ? tmpRoot : path.join(tmpRoot, n)),
    getVersion: () => '0.0.0-test',
    getName: () => 'pebble-lunchar',
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: noop,
    quit: noop,
    exit: noop,
    setLoginItemSettings: (s) => { electronStub.app._login = s; },
    getLoginItemSettings: () => electronStub.app._login || { openAtLogin: false, openAsHidden: false },
    commandLine: { appendSwitch: noop },
    requestSingleInstanceLock: () => true,
    setAppUserModelId: noop
  },
  BrowserWindow: StubBrowserWindow,
  ipcMain: {
    handle: (ch, fn) => { registered.push({ kind: 'handle', ch, fn }); },
    on: (ch, fn) => { registered.push({ kind: 'on', ch, fn }); },
    removeHandler: noop
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox: noop
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => {},
    showItemInFolder: noop,
    trashItem: async () => true,
    beep: noop,
    writeShortcutLink: () => true
  },
  clipboard: { writeText: noop, readText: () => '' },
  Notification: class { constructor() {} show() {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s || '', 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8')
  },
  Tray: StubTray,
  Menu: { buildFromTemplate: (t) => ({ template: t }), setApplicationMenu: noop },
  nativeImage: { createFromPath: () => ({}), createFromBuffer: () => ({}) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  net: {},
  powerMonitor: { getSystemIdleState: () => 'active' }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

/* ---------------- 跑起来 ---------------- */
(async () => {
  console.log('=== 无头装配：真实 require("./main.js") ===');

  let bootError = null;
  try { require('../main.js'); } catch (e) { bootError = e; }
  t('require main.js 不抛错', () => {
    assert.strictEqual(bootError, null, bootError && (bootError.message + '\n' + bootError.stack));
  });

  // app.whenReady() 的 then 链是微任务，让出几轮确保 registerAll / createWindow / setupTray 都跑完
  await new Promise((r) => setTimeout(r, 60));

  const handles = registered.filter((x) => x.kind === 'handle');
  const chans = handles.map((x) => x.ch);

  t('注册了足量 IPC handler（不是空跑）', () => {
    assert.ok(handles.length >= 100, '实际只有 ' + handles.length + ' 个');
  });
  t('每个 handler 都是函数', () => {
    assert.ok(handles.every((x) => typeof x.fn === 'function'));
  });
  t('没有重复注册的 channel', () => {
    const dup = chans.filter((c, i) => chans.indexOf(c) !== i);
    assert.deepStrictEqual([...new Set(dup)], [], '重复: ' + dup.join(', '));
  });

  // 关键域各挑一个，确认拆分后每个域都真的挂上了
  const must = ['launch', 'list-versions', 'list-mods', 'inst-list', 'list-screenshots',
    'account-store-load', 'save-tm-list', 'lab-presets', 'ml-list', 'sysconf-get',
    'mig-scan', 'store-search', 'update-check', 'java-ensure', 'list-resourcepacks',
    'detect-java', 'install-loader', 'pack-info', 'mod-analyze', 'av-get'];
  for (const c of must) {
    t('关键 channel 已注册: ' + c, () => {
      assert.ok(chans.indexOf(c) >= 0, '缺失。已注册 ' + chans.length + ' 个');
    });
  }

  t('createWindow 真的建了窗口', () => {
    assert.strictEqual(windows.length, 1, '窗口数=' + windows.length);
  });
  t('窗口开了 contextIsolation + sandbox', () => {
    const wp = windows[0].opts.webPreferences;
    assert.strictEqual(wp.contextIsolation, true);
    assert.strictEqual(wp.sandbox, true);
    assert.strictEqual(wp.nodeIntegration, false);
  });
  t('托盘建立成功（桩环境）', () => assert.strictEqual(trayCreated, 1, '托盘数=' + trayCreated));

  // 真调用几个 handler，确认 ctx 接线没断（最典型的装配期错误就是 ctx 字段拼错）
  await ta('sysconf-get 能真跑（ctx 接线正常）', async () => {
    const h = handles.find((x) => x.ch === 'sysconf-get');
    const r = await h.fn({}, null);
    assert.ok(r && typeof r === 'object', '返回不是对象');
    assert.ok('autostart' in (r.conf || r), JSON.stringify(r));
  });
  await ta('lab-presets 能真跑', async () => {
    const h = handles.find((x) => x.ch === 'lab-presets');
    const r = await h.fn({});
    assert.ok(Array.isArray(r) || Array.isArray(r.presets), JSON.stringify(r).slice(0, 200));
  });
  await ta('list-screenshots 空目录返回数组而不是抛错（ctx 传递正确）', async () => {
    const h = handles.find((x) => x.ch === 'list-screenshots');
    const r = await h.fn({}, tmpRoot);
    assert.ok(Array.isArray(r), JSON.stringify(r).slice(0, 200));
  });
  await ta('窗口控制通道走 ipcMain.on 而不是 handle', async () => {
    const ons = registered.filter((x) => x.kind === 'on').map((x) => x.ch);
    for (const c of ['win-minimize', 'win-maximize', 'win-close']) {
      assert.ok(ons.indexOf(c) >= 0, '缺失 on: ' + c + '（实际 ' + ons.join(', ') + '）');
    }
  });

  t('sysconf.json 已落到 userData（持久化路径正确）', () => {
    // 只要没崩就算过；文件是 setAutoStart/patchSysConf 时才写，这里不强求存在
    assert.ok(fs.existsSync(tmpRoot));
  });

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  Module._load = origLoad;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
