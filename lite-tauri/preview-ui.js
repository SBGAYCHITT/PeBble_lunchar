#!/usr/bin/env node
/**
 * 前端预览台：不开 WebView2、不启真启动器，直接把 ui/ 塞进 Electron 里画出来。
 *
 * 为什么需要它：
 *   1. WebView2 的实时验证在这台机器上做不了 —— 沙箱会拦本机回环连接，
 *      连不上远程调试端口；外部的 BitBlt / PrintWindow 又抓不到 DirectComposition
 *      的合成表面（截出来全黑），所以「界面到底长什么样」拿不到可信证据。
 *   2. Tauri 返回值不做命名转换，前端读 `info.defaultMcDir` 而 Rust 字段是
 *      `default_mc_dir` 时，界面只是**静默显示 undefined**，不报错、不崩溃。
 *      这类问题只有真把页面渲染一遍、逐项断言页面里的实测值才能发现。
 *
 * 做法：注入一个 __TAURI__ 桩件（命令返回按真实结构造的假数据），
 * 然后既跑断言，也存一张 PNG 供人工看版式。
 *
 * 用法（在 lite-tauri/ 下）：node preview-ui.js [页面名]
 *   页面名 ∈ launch | versions | account | settings | about，默认 launch
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, 'target');
const STUB = path.join(OUT_DIR, '_tauri-stub.js');

// ---------------------------------------------------------------- 桩数据
// 字段名必须和 Rust 侧 `#[serde(rename_all = "camelCase")]` 之后的输出一致。
// 故意的：这里写错就说明前后端契约对不上，断言会立刻炸出来。
const VERSIONS = [
  { id: '26.3-forge-66.0.4', type: 'release', dir: 'versions/26.3-forge-66.0.4',
    inherits: '26.3', javaMajor: 21, jarSize: 0, error: null },
  { id: '26.3', type: 'release', dir: 'versions/26.3',
    inherits: null, javaMajor: 21, jarSize: 41234567, error: null },
  { id: 'broken-demo', type: 'release', dir: 'versions/broken-demo',
    inherits: null, javaMajor: null, jarSize: 0, error: 'JSON 解析失败：expected value' },
];

const SETTINGS = {
  mc_dir: 'C:\\Users\\Felix\\AppData\\Roaming\\.minecraft',
  java_path: '',
  jvm_args: '-XX:+UseG1GC',
  memory_gb: 4, win_w: 854, win_h: 480,
  fullscreen: false, player_name: 'DryRunPlayer',
  hide_after_launch: false, active_account: 'bcf1ea47-1fbf-3420-ae49-5b32ac6afc9f',
};

const ACCOUNTS = [
  { id: 'bcf1ea47-1fbf-3420-ae49-5b32ac6afc9f', name: 'DryRunPlayer', kind: 'offline',
    uuid: 'bcf1ea47-1fbf-3420-ae49-5b32ac6afc9f' },
];

const JAVAS = [
  { path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe', version: '21.0.5',
    major: 21, source: 'JAVA_HOME' },
  { path: 'C:\\Program Files\\Java\\jre1.8.0_401\\bin\\java.exe', version: '1.8.0_401',
    major: 8, source: '常见安装目录' },
];

const RET = {
  app_info: { name: 'Pebble Lunchar Lite', version: '4.2.0',
    runtime: 'Rust edition2021 · WebView2',
    defaultMcDir: 'C:\\Users\\Felix\\AppData\\Roaming\\.minecraft',
    dataDir: 'C:\\Users\\Felix\\AppData\\Roaming\\com.sbgaychitt.pebblelunchar.lite' },
  settings_get: SETTINGS,
  settings_save: null,
  default_mcdir: 'C:\\Users\\Felix\\AppData\\Roaming\\.minecraft',
  list_versions: VERSIONS,
  version_detail: { id: '26.3', mainClass: 'net.minecraft.client.main.Main',
    inherits: null, javaMajor: 21, libraryCount: 65, missingLibraries: 0,
    hasAssetsIndex: true, assetIndex: '34' },
  detect_java: JAVAS,
  accounts_list: ACCOUNTS,
  account_add_offline: ACCOUNTS,
  account_set_active: null,
  account_remove: [],
  launch_game: { pid: 4321, java: 'C:\\jdk-21\\bin\\java.exe', javaMajor: 21,
    preview: 'java -Xmx4G … 39 个参数' },
  kill_game: null,
  game_running: false,
  pick_dir: null,
  pick_file: null,
  open_path: null,
  win_min: null, win_max: null, win_close: null,
  ui_ready: null,
  dry_run_launch: { java: '', java_note: '', cwd: '', natives_dir: '',
    classpath_count: 65, args: [], warnings: [] },
};

const stubJs = `window.__TAURI__ = {
  core: { invoke: (cmd, args) => {
    // 用 includes 判断，不要写成 cmd in [..] —— 对数组用 in 查的是下标不是值
    if (!${JSON.stringify(Object.keys(RET))}.includes(cmd)) {
      return Promise.reject(new Error('command not found: ' + cmd));
    }
    return Promise.resolve(${JSON.stringify(RET)}[cmd]);
  } },
  event: { listen: () => Promise.resolve(() => {}) },
};
// 收集页面错误：init() 的失败是 async 的，不会自己冒到控制台，
// 不主动接住就只能看到「日志区空着」这种间接症状。
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.type)));
window.addEventListener('unhandledrejection', (e) => window.__errs.push(
  'rejection: ' + ((e.reason && (e.reason.message || e.reason.stack)) || e.reason)));
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(STUB, stubJs, 'utf8');

// ---------------------------------------------------------------- Electron
// 在 Electron 主进程里必须用裸模块名 `require('electron')`；写成
// `require('../node_modules/electron')` 拿到的是 npm 包（一个路径字符串），
// 解构出来全是 undefined。
const { app, BrowserWindow } = require('electron');

const page = process.argv[2] || 'launch';
const SHOT = path.join(OUT_DIR, '_ui-preview-' + page + '.png');

// 无头/沙箱环境下 GPU 进程会直接崩掉并连累整个 app（`FATAL: GPU process isn't
// usable. Goodbye.`），这几个开关沿用 tests/smoke.e2e.js 里验证过的那一组。
for (const s of ['disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'no-sandbox']) {
  app.commandLine.appendSwitch(s);
}
app.disableHardwareAcceleration();

// Electron 在 Windows 上是 GUI 子系统程序，父进程重定向 stdout 有时收不到输出，
// 所以结论同时落一份文件，跟 tests/smoke.e2e.js 一个套路。
const LOG = path.join(OUT_DIR, '_ui-preview.log');
try { fs.writeFileSync(LOG, ''); } catch {}
const _out = console.log.bind(console);
console.log = (...a) => {
  const line = a.map(String).join(' ');
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  _out(line);
};

// 每次跑用独立的 profile：共用默认 profile 时上一轮残留的 Electron 会占着
// 缓存目录，报一堆 `Unable to move the cache: 拒绝访问`，进程还会吊住不退。
app.setPath('userData', path.join(OUT_DIR, '_pv-profile'));

app.whenReady().then(async () => {
  try {
    await run();
  } catch (e) {
    console.log('✗ 预览台自身出错：' + (e && e.stack || e));
    app.exit(1);
  }
});

/**
 * 在页面里跑的探针。写成真函数（而不是拼字符串）是为了让转义问题消失，
 * 同时本文件在编辑器里也能被正常高亮/检查。
 */
function probePage() {
  try {
    const logo = document.querySelector('.logo-mark');
    const css = getComputedStyle(document.documentElement);
    const vis = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const activePage = document.querySelector('.page.active');
    return {
      title: document.title,
      navItems: document.querySelectorAll('.nav-item').length,
      activePage: (activePage || {}).id,
      activeVisible: vis(activePage),
      navVisible: vis(document.getElementById('nav')),
      titlebarVisible: vis(document.getElementById('titlebar')),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      cssVarAccent: css.getPropertyValue('--accent').trim(),
      titlebarHeight: getComputedStyle(document.getElementById('titlebar')).height,
      errs: window.__errs || [],
      // init() 失败会被 .catch 接住并插一段红字，这里把它捞出来
      initError: (() => {
        const m = document.body.textContent.match(/初始化失败：([^\n]{0,220})/);
        return m ? m[1].trim() : null;
      })(),
      logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
      blockIcons: document.querySelectorAll('img.blk').length,
      // 只挑「落在当前激活页里」的那份列表来量尺寸。
      // 另一份在别的页里，display:none 导致 0×0 是正常的，不能拿来判失败。
      activeList: (() => {
        const page = document.querySelector('.page.active');
        const b = page && page.querySelector('#version-list, #installed-list');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const it = b.querySelector('.item');
        const ir = it ? it.getBoundingClientRect() : null;
        return { id: b.id, w: Math.round(r.width), h: Math.round(r.height),
          children: b.children.length, itemH: ir ? Math.round(ir.height) : null,
          text: (it && it.innerText ? it.innerText : '').slice(0, 50) };
      })(),
      allLists: (() => {
        const out = {};
        for (const id of ['version-list', 'installed-list']) {
          const b = document.getElementById(id);
          out[id] = b ? b.querySelectorAll('.item').length : -1;
        }
        return out;
      })(),
      logText: ((document.getElementById('log-view') || {}).textContent || '').slice(0, 120),
      textSample: activePage ? activePage.innerText.replace(/\s+/g, ' ').slice(0, 200) : '',
    };
  } catch (e) {
    return { probeError: String((e && e.stack) || e) };
  }
}

async function run() {
  const win = new BrowserWindow({
    width: 1180, height: 760, show: false, frame: false,
    webPreferences: { preload: STUB, contextIsolation: false, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level < 2) return;
    // Electron 自己会抱怨「没设 CSP」，这是它开发模式下的提示。
    // 真正的 Tauri 里 CSP 由 tauri.conf.json 的 app.security.csp 管，与本机关。
    if (/Security Warning|Content Security Policy/.test(message)) return;
    errors.push('[console] ' + message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push('[load] ' + code + ' ' + desc));

  await win.loadFile(path.join(ROOT, 'ui', 'index.html'));
  // 等界面把 async init() 跑完
  await new Promise((r) => setTimeout(r, 1200));

  if (page !== 'launch') {
    await win.webContents.executeJavaScript(
      `document.querySelector('.nav-item[data-page="${page}"]').click()`);
    await new Promise((r) => setTimeout(r, 700));
  }

  // 探针写成**真函数**再 toString() 注入，而不是拼模板字符串：
  // 拼字符串时每一个 `\` 都要多想一层（`\n` 会被展开成真换行，正则直接语法错误），
  // 而 executeJavaScript 遇到语法错误只会回一句含糊的 "Script failed to execute"。
  const probe = '(' + probePage.toString() + ')()';

  const r = await win.webContents.executeJavaScript(probe);
  if (r.probeError) {
    console.log('✗ 探针自身出错：' + r.probeError);
    app.exit(1);
    return;
  }

  let pass = 0, fail = 0;
  const chk = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); c ? pass++ : fail++; };

  console.log('=== 渲染（页面：' + page + '）===');
  chk(r.title === 'Pebble Lunchar Lite', '标题 ' + JSON.stringify(r.title));
  chk(r.navItems === 5, '导航 5 项（实为 ' + r.navItems + '）');
  chk(r.navVisible === true, '导航栏有实际尺寸（不是被 CSS 藏起来）');
  chk(r.titlebarVisible === true, '标题栏有实际尺寸');
  chk(r.activePage === 'page-' + page, '当前页 ' + r.activePage);
  chk(r.activeVisible === true, '当前页有实际尺寸（不是白屏）');
  // 这一版主题是「纯白底」（见 style.css 顶部注释），所以 --bg 这类变量不存在；
  // 拿 --accent 和一条具体规则（标题栏 48px）来证明样式表确实生效了。
  chk(r.cssVarAccent === '#00b3a4', 'style.css 已生效，--accent = ' + r.cssVarAccent);
  chk(r.titlebarHeight === '48px', '标题栏高度 48px（来自样式表，实为 ' + r.titlebarHeight + '）');
  chk(r.bodyBg === 'rgb(255, 255, 255)', 'body 白底 = ' + r.bodyBg);
  chk(r.logoLoaded === true, 'logo.png 真的解码出来了（不是 404）');
  // 版本列表在 refreshAll 里就会渲染，跟当前停在哪个页面无关
  chk(r.allLists['version-list'] === 3 && r.allLists['installed-list'] === 3,
    '两份版本列表都渲染了 3 行（启动页 ' + r.allLists['version-list']
    + ' / 版本页 ' + r.allLists['installed-list'] + '）');
  if (r.activeList) {
    console.log('       列表 ' + JSON.stringify(r.activeList));
    chk(r.activeList.h > 60 && r.activeList.itemH > 20, r.activeList.id + ' 有实际尺寸（容器 '
      + r.activeList.h + 'px / 行 ' + r.activeList.itemH + 'px）');
  }
  if (r.errs.length) {
    console.log('  ---- 页面内部错误 ----');
    for (const e of r.errs) console.log('       ' + String(e).slice(0, 200));
  }
  chk(!r.initError, 'init() 没有失败' + (r.initError ? '：' + r.initError : ''));;

  console.log('\n=== 数据绑定（最能暴露字段名不匹配）===');
  if (page === 'versions') {
    chk(!/undefined/.test(r.textSample), '页面上没有 undefined；样本：' + r.textSample.slice(0, 110));
  }
  if (page === 'about') {
    chk(!/undefined/.test(r.textSample), '关于页没有 undefined；样本：' + r.textSample.slice(0, 110));
  }
  if (page === 'account') {
    chk(!/undefined/.test(r.textSample), '账户页没有 undefined；样本：' + r.textSample.slice(0, 110));
  }
  if (page === 'settings') {
    chk(!/undefined/.test(r.textSample), '设置页没有 undefined；样本：' + r.textSample.slice(0, 110));
  }
  if (page === 'launch') {
    chk(r.logText.includes('就绪'), '日志区打印了就绪：' + r.logText.slice(0, 80));
    chk(!/undefined/.test(r.logText), '日志里没有 undefined');
  }

  const img = await win.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  console.log('\n  截图      ' + path.relative(ROOT, SHOT)
    + '（' + (fs.statSync(SHOT).size / 1024).toFixed(1) + ' KB）');

  if (errors.length) {
    console.log('\n=== 页面报错 ===');
    for (const e of errors.slice(0, 15)) console.log('  ' + e.slice(0, 200));
    fail += errors.length;
  }
  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  app.exit(fail ? 1 : 0);
}
