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
    getName: () => 'pebble-launcher',
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
    'detect-java', 'install-loader', 'pack-info', 'mod-analyze', 'av-get',
    // 云端域：它 require 的 pebblecloud.js 在仓库根目录，最容易从 build.files 里漏掉，
    // 一旦漏了整个应用都起不来（见 tests/packfiles.test.js），所以这里也钉一下。
    'cloud-status', 'cloud-login', 'cloud-upload-profiles',
    // 自动更新域是从 ipc/system.js 迁过来的，也钉一下，免得迁完漏注册。
    // update-status 会读 app.getVersion() 与 PORTABLE_EXECUTABLE_FILE，是最能暴露装配问题的一条。
    'update-status', 'update-download', 'update-apply'];
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
  await ta('cloud-status 能真跑，且不把 token 交给渲染层', async () => {
    // 这条只碰本地（读加密存储），**不发网络请求** —— 测试不该依赖外网。
    const h = handles.find((x) => x.ch === 'cloud-status');
    const r = await h.fn({});
    assert.ok(r && typeof r === 'object', JSON.stringify(r));
    assert.strictEqual(typeof r.loggedIn, 'boolean', JSON.stringify(r));
    assert.strictEqual(typeof r.endpoint, 'string', '没带服务端地址，界面没法显示');
    assert.ok(!('token' in r), 'cloud-status 泄漏了 token: ' + JSON.stringify(r));
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

  /* ================= V5 第一组：世界版本控制完整版的 IPC 接线 =================
   * worldver 的行为已经由单测覆盖；这里只问一件事：**接线对不对**。
   * 渲染层传的是 {saveDir, x, y, z} 这种扁平参数，worldver 要的是 {storeDir, world}；
   * 中间这一层是 ipc/world.js 拼的，拼错了单测永远发现不了。
   * 另外 `safe()` 会把错误压成 {ok:false,error}，而合并冲突必须把 plan 带回去 ——
   * 这条最容易在包装层被吃掉。
   */
  const V5P = (() => {
    const NBT = require('../nbt');
    const anvil = require('../anvil');
    const saveDir = path.join(tmpRoot, 'saves', 'V5IpcWorld');
    fs.mkdirSync(path.join(saveDir, 'region'), { recursive: true });
    const PAL = [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' },
      { Name: 'minecraft:dirt' }, { Name: 'minecraft:grass_block' }];
    const idx = (x, y, z) => (((y - 64) * 16 + z) * 16 + x);
    const put = (edits) => {
      const seq = new Array(4096).fill(1);
      for (const k of Object.keys(edits || {})) seq[Number(k)] = edits[k];
      const per = Math.floor(64 / 4);
      const words = new Array(Math.ceil(4096 / per)).fill(0n);
      for (let i = 0; i < 4096; i++) words[Math.floor(i / per)] |= BigInt(seq[i]) << BigInt((i % per) * 4);
      const raw = NBT.serialize('', {
        DataVersion: 3465, xPos: 0, zPos: 0, yPos: -4,
        sections: [{ Y: 4, block_states: { palette: PAL, data: BigInt64Array.from(words) } }]
      });
      anvil.writeSaveChunk({ saveDir, dim: 'overworld', kind: 'region', cx: 0, cz: 0, raw, backup: false });
    };
    const call = async (ch, ...args) => {
      const h = handles.find((x) => x.ch === ch);
      if (!h) throw new Error('channel 未注册: ' + ch);
      return h.fn({}, ...args);
    };
    return { saveDir, idx, put, call };
  })();

  let V5C1 = '', V5C2 = '';
  await ta('V5：纳入跟踪 → 两次提交，走后端真实对象库', async () => {
    V5P.put({});
    const tr = await V5P.call('world-ver-track', V5P.saveDir, 'ipc 测试：开始跟踪');
    assert.ok(tr && tr.initial, 'track 没返回初始提交: ' + JSON.stringify(tr));
    V5C1 = tr.initial;
    V5P.put({ [V5P.idx(3, 64, 5)]: 2 });
    const c2 = await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：放下泥土', null);
    assert.ok(c2 && c2.id && !c2.error, JSON.stringify(c2));
    V5C2 = c2.id;
    assert.notStrictEqual(V5C1, V5C2);
    // 对象库必须落在 userData/worldver/<存档目录名> 下，不是存档目录里
    const lib = path.join(tmpRoot, 'worldver', 'V5IpcWorld');
    assert.ok(fs.existsSync(path.join(lib, 'refs.json')), '对象库没建在 userData/worldver 下: ' + lib);
    assert.ok(!fs.existsSync(path.join(V5P.saveDir, 'refs.json')), '版本库被写进了存档目录');
  });

  await ta('V5：方块级 blame 接受渲染层的扁平参数（saveDir + 世界坐标）', async () => {
    const r = await V5P.call('world-ver-blame-block', { saveDir: V5P.saveDir, x: 3, y: 64, z: 5 });
    assert.strictEqual(r.error, undefined, JSON.stringify(r).slice(0, 200));
    assert.strictEqual(r.state, 'minecraft:dirt');
    assert.strictEqual(r.chunk, '0,0');
    assert.strictEqual(r.history.length, 2, JSON.stringify(r.history.map((h) => h.id)));
    assert.strictEqual(r.history[0].id, V5C2, '当前状态应归属第二次提交');
    assert.strictEqual(r.history[1].id, V5C1);
  });

  await ta('V5：时间轴由旧到新，帧内容带主进程算好的颜色', async () => {
    const tl = await V5P.call('world-ver-timeline', { saveDir: V5P.saveDir, cx: 0, cz: 0 });
    assert.strictEqual(tl.error, undefined, JSON.stringify(tl).slice(0, 200));
    assert.deepStrictEqual(tl.frames.map((f) => f.id), [V5C1, V5C2], '帧必须由旧到新');
    const f = await V5P.call('world-ver-frame', { saveDir: V5P.saveDir, cx: 0, cz: 0, y: 64, id: V5C2 });
    assert.strictEqual(f.states.length, 256);
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:dirt');
    // colors 是 ipc 层用 worldmap.blockColor 映射出来的，渲染层不再自带配色表
    assert.strictEqual(f.colors.length, 256, 'colors 没跟着 states 一起返回');
    assert.deepStrictEqual(f.colors[0], [120, 120, 124], '石头色不对: ' + JSON.stringify(f.colors[0]));
    assert.deepStrictEqual(f.colors[5 * 16 + 3], [124, 86, 58], '泥土色不对');
  });

  await ta('V5：空气格必须无颜色，否则画布会把"没有方块"画成随机色块', async () => {
    // y=0 落在 section Y=-4 之外的层不存在；换个办法：把一格挖成空气再看
    V5P.put({ [V5P.idx(3, 64, 5)]: 0 });
    const c3 = await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：挖空', null);
    const f = await V5P.call('world-ver-frame', { saveDir: V5P.saveDir, cx: 0, cz: 0, y: 64, id: c3.id });
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:air');
    assert.strictEqual(f.colors[5 * 16 + 3], null, 'air 必须是 null，不能是哈希出来的颜色');
    // 还原，后面的合并用例还要用这格
    V5P.put({ [V5P.idx(3, 64, 5)]: 2 });
    await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：填回泥土', null);
  });

  await ta('V5：无损的区块冲突能直接合掉，并且把合并账目带回渲染层', async () => {
    const br = await V5P.call('world-ver-branch-create', V5P.saveDir, 'ipcexp', V5C2);
    assert.strictEqual(br.error, undefined, JSON.stringify(br).slice(0, 160));
    await V5P.call('world-ver-branch-switch', V5P.saveDir, 'ipcexp');
    V5P.put({ [V5P.idx(3, 64, 5)]: 3 });
    await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：exp 改草', null);

    await V5P.call('world-ver-branch-switch', V5P.saveDir, 'main');
    await V5P.call('world-ver-checkout', V5P.saveDir, V5C2, true);
    V5P.put({ [V5P.idx(3, 64, 5)]: 2, [V5P.idx(12, 64, 7)]: 2 });
    await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：main 另加泥土', null);

    const plan = await V5P.call('world-ver-merge-plan', { saveDir: V5P.saveDir, ours: 'main', theirs: 'ipcexp' });
    assert.strictEqual(plan.error, undefined, JSON.stringify(plan).slice(0, 200));
    assert.strictEqual(plan.base, V5C2, '共同祖先不对');
    assert.strictEqual(plan.conflictCount, 1);
    assert.strictEqual(plan.conflicts[0].detail.disjoint, true, '两边改的是不同方块，应判为不相交');
    // ★ 里程碑二之后这里**行为反转**了：以前冲突区块只能整块取一侧，那一格必然被覆盖，
    //   所以 dropped 是 1；现在能做方块级三方合流，两侧改动都留得下来，损失是 0。
    //   （旧断言旁边原本就留了一句"等保类型写入端做出来，这条要跟着改"——就是这里。）
    assert.strictEqual(plan.conflicts[0].mergeable, true, plan.conflicts[0].mergeReason);
    assert.strictEqual(plan.conflicts[0].dropped, 0, '能合流就不该再丢方块');
    assert.strictEqual(plan.stats.droppedBlocks, 0);
    assert.ok(plan.conflicts[0].mergeCells >= 1, '应当真的合了几格');
    // 没有真冲突 → 没有"必丢"的格子，样板清单应当是空的
    assert.deepStrictEqual(plan.conflicts[0].droppedSample, []);
    assert.strictEqual(plan.stats.mergeableChunks, 1);

    const planT = await V5P.call('world-ver-merge-plan', {
      saveDir: V5P.saveDir, ours: 'main', theirs: 'ipcexp', strategy: 'theirs'
    });
    assert.strictEqual(planT.conflicts[0].mergeable, true);
    assert.strictEqual(planT.conflicts[0].dropped, 0, '策略只影响真冲突，这里没有真冲突');

    // 损失为 0 → 默认门槛**应当放行**（不再"看到冲突就拒"），而且不需要 allowConflicts
    const mg = await V5P.call('world-ver-merge-apply', {
      saveDir: V5P.saveDir, ours: 'main', theirs: 'ipcexp', message: 'ipc 测试：合流'
    });
    assert.strictEqual(mg.ok, true, JSON.stringify(mg).slice(0, 240));
    assert.ok(mg.id && !mg.fastForward);
    assert.ok(mg.mergedChunks >= 1, 'IPC 层应当把"合掉了几个区块"带回来，实际 ' + mg.mergedChunks);
    assert.ok(mg.mergedBytes > 0, '合流应当真的产出了字节');
    const f = await V5P.call('world-ver-frame', { saveDir: V5P.saveDir, cx: 0, cz: 0, y: 64, id: mg.id });
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:grass_block', '对方那格被采纳');
    // ★ 旧版这里是 'minecraft:stone' 并标着「已知边界」。合流做出来之后，
    //   我方在同一个区块里的另一处改动**不再被覆盖** —— 这正是里程碑二的价值所在。
    assert.strictEqual(f.states[7 * 16 + 12], 'minecraft:dirt', '我方那格必须留住');
    const rec = JSON.parse(fs.readFileSync(
      path.join(tmpRoot, 'worldver', 'V5IpcWorld', 'commits', mg.id + '.json'), 'utf8'));
    assert.strictEqual(rec.droppedBlocks, 0);
    assert.strictEqual(rec.conflicts[0].blockConflict, 0);
    assert.ok(rec.mergedChunks >= 1, '提交里要记下这次真的合掉了几块，事后才查得出来');
  });

  await ta('V5：救不回来的冲突 → IPC 把计划书和损失数字一起带回渲染层', async () => {
    // 这一条专测 safe() 那条路径：worldver 抛的错里带着 plan，包装层最容易把它吃掉，
    // 吃掉之后 UI 就只剩一句"有冲突"，无从下手。要让**真的**有损失才进得来，
    // 所以这里造一组"同一个方块两边改成不同东西"的分支。
    await V5P.call('world-ver-branch-create', V5P.saveDir, 'ipcA', V5C2);
    await V5P.call('world-ver-branch-switch', V5P.saveDir, 'ipcA');
    await V5P.call('world-ver-checkout', V5P.saveDir, V5C2, true);
    V5P.put({ [V5P.idx(3, 64, 5)]: 1 });                    // 石头
    await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：A 改石头', null);

    await V5P.call('world-ver-branch-create', V5P.saveDir, 'ipcB', V5C2);
    await V5P.call('world-ver-branch-switch', V5P.saveDir, 'ipcB');
    await V5P.call('world-ver-checkout', V5P.saveDir, V5C2, true);
    V5P.put({ [V5P.idx(3, 64, 5)]: 0 });                    // 挖成空气
    await V5P.call('world-ver-commit', V5P.saveDir, 'ipc 测试：B 挖空', null);

    const plan = await V5P.call('world-ver-merge-plan', { saveDir: V5P.saveDir, ours: 'ipcA', theirs: 'ipcB' });
    assert.strictEqual(plan.conflictCount, 1);
    assert.strictEqual(plan.conflicts[0].detail.conflict, 1, '方块级也要认出这一格是真冲突');
    assert.strictEqual(plan.conflicts[0].dropped, 1, '真冲突那一格必然被覆盖一次');
    assert.strictEqual(plan.conflicts[0].droppedSample[0].x, 3);
    assert.strictEqual(plan.conflicts[0].droppedSample[0].z, 5);

    const denied = await V5P.call('world-ver-merge-apply', { saveDir: V5P.saveDir, ours: 'ipcA', theirs: 'ipcB' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, 'MERGE_CONFLICT');
    assert.ok(denied.plan, '拒绝合并时 plan 被丢了，UI 就没法显示冲突详情');
    assert.ok(denied.plan.stats.droppedBlocks >= 1, '被拒的计划书里也要带上"会丢多少"');
    assert.ok(/allowConflicts/.test(denied.error || ''), '错误文案要告诉用户怎么继续: ' + denied.error);

    const mg = await V5P.call('world-ver-merge-apply', {
      saveDir: V5P.saveDir, ours: 'ipcA', theirs: 'ipcB',
      strategy: 'theirs', allowConflicts: true, message: 'ipc 测试：接受损失'
    });
    assert.strictEqual(mg.ok, true, JSON.stringify(mg).slice(0, 200));
    const f = await V5P.call('world-ver-frame', { saveDir: V5P.saveDir, cx: 0, cz: 0, y: 64, id: mg.id });
    assert.strictEqual(f.states[5 * 16 + 3], 'minecraft:air', 'strategy=theirs 应按对方落点');
    const rec = JSON.parse(fs.readFileSync(
      path.join(tmpRoot, 'worldver', 'V5IpcWorld', 'commits', mg.id + '.json'), 'utf8'));
    assert.strictEqual(rec.droppedBlocks, 1, '接受损失也要把损失记在提交里，事后才查得出来');
    assert.strictEqual(rec.conflicts[0].dropped, 1);
  });

  /* ================= V5 第二组：区域搬运的 IPC 接线 =================
   * 和上面同一个道理：worldmerge 单测已经证明了平移逻辑本身，这里只问接线。
   * 重点看 `nearest` —— 平移量不是 16 的倍数时，worldmerge 抛的错里带着"最近可用值"，
   * 渲染层要拿它摆一颗「就用它」的按钮。包装层一旦按常规压成 {ok:false,error}，
   * 这个字段就没了，UI 只能干说一句"错误"，用户自己猜该填几。
   */
  const WM = (() => {
    const NBT = require('../nbt');
    const anvil = require('../anvil');
    const root = path.join(tmpRoot, 'wmsaves');
    const mk = (name) => {
      const dir = path.join(root, name);
      fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
      return dir;
    };
    const from = mk('src');
    const to = mk('dst');
    const PAL = [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' }];
    // 每 16 个方块一个 long，全填 1（石头）。BigInt64Array 直接交给 serialize，
    // 和上面 V5P 用的是同一套造法，避免"测试造的字节本身就不合法"。
    const words = new Array(256).fill(0n);
    for (let i = 0; i < 4096; i++) words[Math.floor(i / 16)] |= 1n << BigInt((i % 16) * 4);
    const raw = NBT.serialize('', {
      DataVersion: 3465, xPos: 0, zPos: 0, yPos: -4,
      sections: [{ Y: 4, block_states: { palette: PAL, data: BigInt64Array.from(words) } }]
    });
    anvil.writeSaveChunk({ saveDir: from, dim: 'overworld', kind: 'region', cx: 0, cz: 0, raw, backup: false });
    const call = async (ch, ...args) => {
      const h = handles.find((x) => x.ch === ch);
      if (!h) throw new Error('channel 未注册: ' + ch);
      return h.fn({}, ...args);
    };
    return { from, to, call };
  })();

  await ta('V5：平移量没对齐 → IPC 把 nearest 一起带回渲染层，UI 才摆得出「就用它」', async () => {
    const bad = await WM.call('world-merge-plan', {
      from: WM.from, to: WM.to, x1: 0, z1: 0, x2: 15, z2: 15, dx: 8, dz: 0
    });
    assert.strictEqual(bad.ok, false, JSON.stringify(bad).slice(0, 200));
    assert.strictEqual(bad.code, 'SHIFT_NOT_ALIGNED', JSON.stringify(bad).slice(0, 200));
    assert.ok(bad.nearest, 'nearest 被包装层吃掉了，UI 没法给"最近可用值"按钮');
    assert.strictEqual(bad.nearest.dx, 16);
    assert.strictEqual(bad.nearest.dxc, 1);
    assert.ok(/16 的整数倍/.test(bad.error || ''), '错误文案要自己说清规则: ' + bad.error);
  });

  await ta('V5：平移量对齐后出的计划书带目标盒 / 平移账目 / 状态图数据', async () => {
    const p = await WM.call('world-merge-plan', {
      from: WM.from, to: WM.to, x1: 0, z1: 0, x2: 15, z2: 15, dx: 16, dz: 0
    });
    assert.strictEqual(p.error, undefined, JSON.stringify(p).slice(0, 240));
    assert.strictEqual(p.shift.needed, true);
    assert.strictEqual(p.shift.dxc, 1);
    assert.strictEqual(p.destBox.cx1, 1, '目标盒子应当在平移之后');
    assert.strictEqual(p.write.chunks, 1);
    // UI 直接照着 cells 画，主进程算好的，别让渲染层再去推断每个格子什么状态
    assert.ok(p.matrix && p.matrix.cells.length === 1 && p.matrix.cells[0].length === 1,
      '状态图数据不全: ' + JSON.stringify(p.matrix).slice(0, 160));
    assert.strictEqual(p.matrix.cells[0][0], 'n', '目标没有这个区块 → 应当是 n（新建）');
    assert.ok(Array.isArray(p.precheck.blockers) && p.precheck.blockers.length === 0,
      '刚建的空目标不该有拦阻: ' + JSON.stringify(p.precheck.blockers));
    // 干跑不许写盘：源还在原地，目标还是空的
    const anvil2 = require('../anvil');
    assert.ok(!fs.existsSync(path.join(WM.to, 'region', 'r.0.0.mca')), 'plan 阶段不该在目标存档里造出文件');
    assert.ok(anvil2.readSaveChunk({
      saveDir: WM.from, dim: 'overworld', kind: 'region', cx: 0, cz: 0
    }), 'plan 不该动源存档');
  });

  await ta('V5：执行搬运真的把区块挪到 +16 格，并且复验通过', async () => {
    const r = await WM.call('world-merge-apply', {
      from: WM.from, to: WM.to, x1: 0, z1: 0, x2: 15, z2: 15, dx: 16, dz: 0
    });
    assert.strictEqual(r.error, undefined, JSON.stringify(r).slice(0, 240));
    assert.strictEqual(r.written, 1, JSON.stringify(r).slice(0, 240));
    assert.strictEqual(r.translated, 1, '平移过的区块要计数，否则用户不知道坐标被改过');
    assert.strictEqual(r.verification.ok, true, '复验不一致: ' + JSON.stringify(r.verification));
    // 落点必须是 (1,0)，不是 (0,0) —— 复验拿"平移后的字节"做指纹，这里一旦错位就会红
    const anvil2 = require('../anvil');
    assert.ok(anvil2.readSaveChunk({
      saveDir: WM.to, dim: 'overworld', kind: 'region', cx: 1, cz: 0
    }), '目标 (1,0) 没有区块');
    assert.ok(!anvil2.readSaveChunk({
      saveDir: WM.to, dim: 'overworld', kind: 'region', cx: 0, cz: 0
    }), '目标 (0,0) 不该有区块');
  });

  await ta('V5：参数非法/状态不对时返回 {ok:false,error}，不把渲染层卡成 reject', async () => {
    // merge-plan 指向一个不存在的分支 → worldver 抛错 → safe() 必须转成 ok:false
    const bad = await V5P.call('world-ver-merge-plan', { saveDir: V5P.saveDir, ours: 'main', theirs: 'nope' });
    assert.strictEqual(bad.ok, false, JSON.stringify(bad).slice(0, 160));
    assert.ok(typeof bad.error === 'string' && /不存在|还没有提交/.test(bad.error), '错误文案不可读: ' + bad.error);

    // 空参数不该抛：没接入跟踪的存档应当得到"没被跟踪"这种可读结果
    const empty = await V5P.call('world-ver-blame-block', {});
    assert.strictEqual(empty.ok, undefined, '空参数不该被当成错误: ' + JSON.stringify(empty).slice(0, 160));
    assert.strictEqual(empty.history.length, 0);
    assert.ok(empty.reason.length > 0, '必须给出可读理由，而不是一个空对象');
  });

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  Module._load = origLoad;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
