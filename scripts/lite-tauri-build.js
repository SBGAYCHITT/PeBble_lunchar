#!/usr/bin/env node
/**
 * 编译 Tauri 版 Lite 并把产物覆盖到 dist-lite7。
 *
 * 为什么单独写一个脚本，而不是直接在 package.json 里写 `cargo build`：
 *   这台机器上 rustup 装在 D 盘，`CARGO_HOME/bin/cargo.exe` 只是个 0 字节的
 *   rustup 代理，在 Git Bash 里跑它什么也不做（不报错、不编译），非常难查。
 *   真正能用的二进制在 `~/.rustup/toolchains/<toolchain>/bin/` 下面，
 *   所以这里会按优先级自己去找，找不到再退回 PATH。
 *
 * 产出：dist-lite7/Pebble-Launcher-Lite.exe（单文件，运行时用系统自带 WebView2）
 * 用法：node scripts/lite-tauri-build.js [--verify]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'lite-tauri');
const EXE_NAME = 'pebble-launcher-lite.exe';
const BUILT = path.join(PROJ, 'target', 'release', EXE_NAME);
const DIST = path.join(ROOT, 'dist-lite7');
const OUT = path.join(DIST, 'Pebble-Launcher-Lite.exe');

function die(m) { console.error('✗ ' + m); process.exit(1); }
function mb(n) { return (n / 1048576).toFixed(2) + ' MB'; }

/** 按优先级找可用的 cargo。 */
function findCargo() {
  const home = os.homedir();
  const cands = [];
  // 1. rustup 工具链里的真身（本机就是这个）
  for (const root of [
    process.env.RUSTUP_HOME,
    path.join(home, '.rustup'),
    'D:\\apps\\rust\\rustup'
  ]) {
    if (!root) continue;
    const tc = path.join(root, 'toolchains');
    if (!fs.existsSync(tc)) continue;
    for (const t of fs.readdirSync(tc)) {
      for (const exe of ['cargo.exe', 'cargo']) {
        const p = path.join(tc, t, 'bin', exe);
        if (fs.existsSync(p) && fs.statSync(p).size > 1024) cands.push(p);
      }
    }
  }
  // 2. PATH 上的 cargo（避开 0 字节的 rustup 代理）
  const which = spawnSync('where', ['cargo'], { encoding: 'utf8', shell: true });
  for (const line of String(which.stdout || '').split(/\r?\n/)) {
    const p = line.trim();
    if (p && fs.existsSync(p)) {
      const sz = fs.statSync(p).size;
      if (sz > 1024) cands.push(p);
      else console.log('  跳过 0 字节的 rustup 代理：' + p);
    }
  }
  return cands[0];
}

const cargo = findCargo();
if (!cargo) die('找不到可用的 cargo（rustup 是否安装在 D 盘？）');
console.log('▸ cargo   ' + cargo);
console.log('▸ 编译     ' + PROJ);

/**
 * 找出 MSVC 与 Windows SDK 的 lib/include 目录。
 *
 * 为什么必须自己找：rustc 是靠读注册表的 `HKLM\…\Windows Kits\Installed Roots`
 * 来定位 Windows SDK 的，注册表读不到时它照样能找到 link.exe（PATH 里有），
 * 但 **不会** 配上 SDK 的 .lib 搜索路径，于是链接阶段直接炸在
 * `LNK1181: 无法打开输入文件"advapi32.lib"` —— 这个报错完全不提注册表，
 * 第一次遇到基本查不出来。
 */
function findMsvcLibDirs() {
  const libs = [], incs = [];
  const progX86 = 'C:\\Program Files (x86)';
  const sdkRoot = path.join(progX86, 'Windows Kits', '10');
  const sdkLib = path.join(sdkRoot, 'Lib');
  if (fs.existsSync(sdkLib)) {
    const vers = fs.readdirSync(sdkLib).filter((v) => /^\d+\./.test(v)).sort().reverse();
    if (vers.length) {
      const v = vers[0];
      libs.push(path.join(sdkLib, v, 'ucrt', 'x64'), path.join(sdkLib, v, 'um', 'x64'));
      for (const d of ['ucrt', 'shared', 'um']) {
        incs.push(path.join(sdkRoot, 'Include', v, d));
      }
    }
  }
  // VC 工具集可能在 VS 或 BuildTools 下，版本号目录也要挑
  for (const base of [
    path.join(progX86, 'Microsoft Visual Studio'),
    'C:\\Program Files\\Microsoft Visual Studio'
  ]) {
    if (!fs.existsSync(base)) continue;
    for (const ed of fs.readdirSync(base)) {
      const vc = path.join(base, ed, 'VC', 'Tools', 'MSVC');
      if (!fs.existsSync(vc)) continue;
      for (const ver of fs.readdirSync(vc).sort().reverse()) {
        const L = path.join(vc, ver, 'lib', 'x64');
        const I = path.join(vc, ver, 'include');
        if (fs.existsSync(L) && fs.existsSync(I)) { libs.unshift(L); incs.unshift(I); }
      }
    }
  }
  return { libs: libs.filter(fs.existsSync), incs: incs.filter(fs.existsSync) };
}

// CARGO_HOME 要指到有 registry 缓存的那一份，否则会重新下载整个依赖树
const env = { ...process.env };
if (!env.CARGO_HOME) {
  for (const c of [path.join(os.homedir(), '.cargo'), 'D:\\apps\\rust\\cargo']) {
    if (fs.existsSync(path.join(c, 'registry'))) { env.CARGO_HOME = c; break; }
  }
}

// cargo 所在目录必须进 PATH：`embed-resource`（tauri-build 用来把图标和清单
// 塞进 exe 的依赖）会去调 `rustc` 拿版本号，PATH 上没有就直接 panic ——
// 报错是 `program not found`，不会告诉你是谁在找 rustc。
const binDir = path.dirname(cargo);
if (!String(env.PATH || '').toLowerCase().includes(binDir.toLowerCase())) {
  env.PATH = binDir + ';' + (env.PATH || '');
}

// 已有的 LIB/INCLUDE 追加在后面，不覆盖（用户可能在 vcvars 里手动配过）
const { libs, incs } = findMsvcLibDirs();
if (!libs.length || !incs.length) {
  console.log('  warn      没找到 MSVC / Windows SDK，链接阶段可能失败');
} else {
  const join = (a) => a.join(';');
  env.LIB = env.LIB ? env.LIB + ';' + join(libs) : join(libs);
  env.INCLUDE = env.INCLUDE ? env.INCLUDE + ';' + join(incs) : join(incs);
  console.log('▸ LIB      ' + libs.length + ' 个目录（含 ' + path.basename(path.dirname(libs[0])) + '）');
}

const t0 = Date.now();
const r = spawnSync(cargo, ['build', '--release'], {
  cwd: PROJ, stdio: 'inherit', env
});
if (r.status !== 0) die('cargo build 失败，退出码 ' + r.status);
console.log('▸ 编译完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

if (!fs.existsSync(BUILT)) die('没找到产物 ' + BUILT);
const size = fs.statSync(BUILT).size;

fs.mkdirSync(DIST, { recursive: true });
const old = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
fs.copyFileSync(BUILT, OUT);

console.log('');
console.log('  产物      ' + OUT);
console.log('  体积      ' + mb(size) + (old ? '（原 ' + mb(old) + '，缩小到 '
  + (size / old * 100).toFixed(1) + '%）' : ''));
console.log('  运行时    系统自带 WebView2（Win10 1803+ / Win11 默认已装）');

if (process.argv.includes('--verify')) {
  // 先跑静态对账 + 检查器自检。理由：契约错（字段名不一致）不会崩、只会静默
  // 显示空白，是最难靠肉眼发现的一类；而检查器自己也会静默失效，所以要
  // 连它一起验，否则后面那些"通过"没有可信度。
  console.log('');
  console.log('▸ 契约     前后端命令 / 字段静态对账');
  const runNode = (args) => spawnSync(process.execPath, args, { cwd: PROJ, stdio: 'inherit' });
  const st = runNode([path.join(PROJ, 'check-contract.js'), '--selftest']);
  if (st.status !== null && st.status !== 0) {
    die('契约检查器自检未通过 —— 检查器本身可能已经失效，别信它的 ok');
  }
  if (st.status === null) {
    console.log('  warn      本环境不允许起子进程，自检跳过');
  } else {
    console.log('  ok        检查器自检通过');
  }
  const cc = runNode([path.join(PROJ, 'check-contract.js')]);
  if (cc.status === null) {
    console.log('  warn      同上，跳过。手动补跑：cd lite-tauri && node check-contract.js');
  } else if (cc.status !== 0) {
    die('前后端契约对账未通过');
  }

  console.log('');
  console.log('▸ 演练     逐个版本拼启动命令');
  const mc = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
  const vdir = path.join(mc, 'versions');
  if (!fs.existsSync(vdir)) die('找不到 ' + vdir);
  const versions = fs.readdirSync(vdir)
    .filter((v) => fs.existsSync(path.join(vdir, v, v + '.json')));
  // status === null 表示 spawn 本身失败（本机沙箱会直接拒绝 Node 起子进程，
  // 报 EBUSY/EPERM）。这不是产物的问题，明确降级并说清怎么补跑，
  // 不要让「在沙箱里跑不了」看起来像「构建坏了」。
  let blocked = false;
  for (const v of versions) {
    const out = path.join(PROJ, 'target', 'dry-' + v + '.json');
    const q = spawnSync(OUT, ['--dry-run', mc, v, out], { encoding: 'utf8' });
    if (q.status === null) { blocked = true; break; }
    if (q.status !== 0) die('演练失败：' + v + ' 退出码 ' + q.status);
    console.log('  ok        ' + v + ' → ' + path.basename(out));
  }
  if (blocked) {
    console.log('  warn      本环境不允许 Node 起子进程，跳过。手动补跑：');
    console.log('              cd lite-tauri && ./target/release/' + EXE_NAME
      + ' --dry-run "' + mc + '" 26.3 target/dry-26.3.json');
    console.log('              node verify-lite.js');
  } else {
    const v = spawnSync(process.execPath, [path.join(PROJ, 'verify-lite.js')], {
      cwd: PROJ, stdio: 'inherit'
    });
    if (v.status !== 0) die('启动参数核验未全通过');
  }

  // 界面：用项目自带的 Electron 当 Chromium 渲染同一份 ui/。
  // 这是唯一能确认「前端真的画出来了、字段没读错」的办法 —— 见 preview-ui.js 顶部说明。
  console.log('');
  console.log('▸ 界面     逐页渲染核验');
  const env2 = { ...process.env };
  delete env2.ELECTRON_RUN_AS_NODE;
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electron)) die('找不到 electron.exe，先 npm install');
  let uiBlocked = false;
  for (const page of ['launch', 'versions', 'account', 'settings', 'about']) {
    const p = spawnSync(electron, ['preview-ui.js', page], { cwd: PROJ, env: env2 });
    if (p.status === null) { uiBlocked = true; break; }
    if (p.status !== 0) die('界面核验未通过：' + page);
  }
  if (uiBlocked) {
    console.log('  warn      同上，跳过。手动补跑：node scripts/lite-tauri-ui.js');
  } else {
    console.log('  ok        5 个页面全部通过');
  }
}
