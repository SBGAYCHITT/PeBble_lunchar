// 用 NSIS 把 dist/win-unpacked 编译成单文件 exe（首次运行释放到本地目录并启动，之后秒开）
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = process.cwd();
/* 打包源目录与产物路径可用环境变量覆盖（**默认行为完全不变**）。
 * 用途：electron-builder 的 emptyDir 会被沙箱的批量删除守卫拦下
 *       （`dist/win-unpacked` 超过 50 项时直接抛 SAFE_DELETE_BULK_REJECTED），
 *       于是可以改成「输出到全新目录」重建，再指过来打包，全程不必删任何东西：
 *         node node_modules/electron-builder/out/cli/cli.js --win --x64 --dir \
 *              --config.directories.output=dist2
 *         PL_SRC=dist2/win-unpacked node make-exe.js
 */
const SRC = path.resolve(ROOT, process.env.PL_SRC || 'dist/win-unpacked');
const OUT = path.resolve(ROOT, process.env.PL_OUT || 'dist/Pebble-Lunchar.exe');
const NSI = path.join(ROOT, 'tools/pl.nsi');
const MAKENSIS = path.join(ROOT, 'tools/makensis.exe');

// 是否走 SignPath 免费签名（开源路线）。不设（默认）则沿用本地自签名（scripts/sign.js）。
const USE_SIGNPATH = process.env.SIGNPATH === '1';

if (!fs.existsSync(SRC)) { console.error('缺少 dist/win-unpacked'); process.exit(1); }
if (!fs.existsSync(MAKENSIS)) { console.error('缺少 makensis.exe'); process.exit(1); }

// 清理打包目录中的临时/无用文件（失败不影响打包）
for (const f of ['run.cmd', 'debug.log']) {
  const p = path.join(SRC, f);
  try {
    if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); console.log('清理:', f); }
  } catch (e) {
    console.log('跳过清理:', f, '(' + e.message.split('\n')[0].slice(0, 60) + ')');
  }
}

/* ---------------- 代码签名 ----------------
 * 顺序很关键：NSIS 会把 dist/win-unpacked 里的文件打进安装包，所以必须
 *   ① 先签 win-unpacked 里的 exe/dll  →  ② 跑 makensis  →  ③ 再签外层安装包本体
 * 没配证书时 scripts/sign.js 会自己打印指引并跳过，不会阻塞打包。
 * 想强行跳过用 SKIP_SIGN=1。
 */
function signTargets(files, label) {
  const list = files.filter((fp) => fs.existsSync(fp));
  if (!list.length) return;
  if (process.env.SKIP_SIGN === '1') { console.log('跳过签名（SKIP_SIGN=1）: ' + label); return; }
  const signer = path.join(ROOT, 'scripts/sign.js');
  if (!fs.existsSync(signer)) { console.log('找不到 scripts/sign.js，跳过签名'); return; }
  console.log('');
  console.log('代码签名（' + label + '，' + list.length + ' 个）…');
  const r = spawnSync(process.execPath, [signer, '--targets', list.join(',')], {
    stdio: ['ignore', 'inherit', 'inherit'], // stdin 必须 ignore：见 scripts/sign.js 顶部注释
  });
  if (r.error) console.log('  签名调用失败: ' + r.error.message);
}

/* ---------------- SignPath 签名（开源免费路线） ----------------
 * 当 SIGNPATH=1 时替代本地自签名。SignPath 走"构件配置批量签名"：把要签的文件打成 zip
 * 提交，按扩展名(.exe/.dll)批量签，下载回签名后的 zip 解压覆盖。
 * 这样内层 win-unpacked 与外层安装包复用同一套构件配置。前置见 SIGNING.md / scripts/signpath-sign.js。
 */
function spZipDir(dir, zipPath) {
  // -C dir . 把目录内容（不含目录本身）打进 zip，条目以 dir 内容为根
  const r = spawnSync('tar', ['-a', '-cf', zipPath, '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) { console.log('  压缩失败: ' + (r.stderr || '').toString().slice(0, 200)); process.exit(2); }
}
function spZipFile(file, zipPath) {
  const r = spawnSync('tar', ['-a', '-cf', zipPath, file], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) { console.log('  压缩失败: ' + (r.stderr || '').toString().slice(0, 200)); process.exit(2); }
}
function spUnzip(zipPath, destDir) {
  const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) { console.log('  解压失败: ' + (r.stderr || '').toString().slice(0, 200)); process.exit(2); }
}
function signPathArtifact(inputZip, outputZip, label) {
  const script = path.join(ROOT, 'scripts/signpath-sign.js');
  if (!fs.existsSync(script)) { console.log('找不到 scripts/signpath-sign.js，跳过 SignPath 签名'); return; }
  if (!process.env.SIGNPATH_API_TOKEN || !process.env.SIGNPATH_ORG_ID ||
      !process.env.SIGNPATH_PROJECT_SLUG || !process.env.SIGNPATH_POLICY_SLUG) {
    console.log('缺少 SignPath 环境变量（SIGNPATH_API_TOKEN/ORG_ID/PROJECT_SLUG/POLICY_SLUG），跳过。');
    return;
  }
  console.log('');
  console.log('SignPath 签名（' + label + '）…');
  const r = spawnSync(process.execPath, [script, inputZip, outputZip, label], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) { console.log('  SignPath 调用失败: ' + r.error.message); process.exit(2); }
  if (r.status !== 0) { console.log('  SignPath 签名未成功'); process.exit(2); }
}

const pkg = require('./package.json');
// 每次打包生成新的构建号：已安装副本的版本号不一致时重新解压覆盖，否则直接秒开
const BUILDVER = pkg.version + '.' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);

// Windows 的版本资源必须是 4 段数字（X.Y.Z.B，每段 0-65535）。
// 不写这个的话，用户右键「属性 → 详细信息」是空的 —— 下到手里没法确认是哪个版本，
// 排查问题时也少一条线索（内层的 Pebble Lunchar.exe 由 electron-builder 填好了，
// 但用户拿到的是外层这个单文件）。
const VER4 = (pkg.version.replace(/[^\d.]/g, '').split('.').concat(['0', '0', '0']).slice(0, 4)
  .map((n) => String(Math.min(65535, parseInt(n, 10) || 0))).join('.'));

const nsi = `
!define APPNAME "Pebble Lunchar"
!define EXENAME "Pebble Lunchar.exe"
!define INSTDIRNAME "PebbleLunchar"
!define VERSION "${pkg.version}"
!define BUILDVER "${BUILDVER}"

VIProductVersion "${VER4}"
VIAddVersionKey /LANG=2052 "ProductName" "Pebble Lunchar"
VIAddVersionKey /LANG=2052 "FileDescription" "Minecraft 启动器（免安装单文件）"
VIAddVersionKey /LANG=2052 "FileVersion" "\${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "\${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"
VIAddVersionKey /LANG=1033 "ProductName" "Pebble Lunchar"
VIAddVersionKey /LANG=1033 "FileDescription" "Minecraft launcher (portable single file)"
VIAddVersionKey /LANG=1033 "FileVersion" "\${VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "\${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT License"

Name "\${APPNAME}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\\\${INSTDIRNAME}"
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma
SetCompressorDictSize 64
Icon "${path.join(ROOT, 'build/icon.ico')}"
UninstallIcon "${path.join(ROOT, 'build/icon.ico')}"
BrandingText "\${APPNAME}"

Function .onInit
  ; Already installed and same build -> launch directly
  IfFileExists "$INSTDIR\\\${EXENAME}" 0 doInstall
  ClearErrors
  FileOpen $0 "$INSTDIR\\version.txt" r
  IfErrors doInstall
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "\${BUILDVER}" 0 doInstall
    Exec "$INSTDIR\\\${EXENAME}"
    Quit
  doInstall:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r /x debug.log /x run.cmd "${SRC}\\*"
  FileOpen $0 "$INSTDIR\\version.txt" w
  FileWrite $0 "\${BUILDVER}"
  FileClose $0
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  ; Uninstall info
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${INSTDIRNAME}" "DisplayName" "\${APPNAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${INSTDIRNAME}" "UninstallString" "$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${INSTDIRNAME}" "DisplayIcon" "$INSTDIR\\\${EXENAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${INSTDIRNAME}" "Publisher" "Felix"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${INSTDIRNAME}" "DisplayVersion" "\${VERSION}"
SectionEnd

Section "Launch"
  Exec "$INSTDIR\\\${EXENAME}"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\${INSTDIRNAME}"
SectionEnd
`;

fs.writeFileSync(NSI, '\uFEFF' + nsi.replace(/^\s*\n/, ''), 'utf8'); // UTF-8 BOM，避免 NSIS 编码报错
// 先把应用目录里的 exe/dll 签掉，这样打进安装包的就是已签名版本
if (USE_SIGNPATH) {
  const innerZip = path.join(ROOT, 'dist/.sp-inner.zip');
  const innerSigned = path.join(ROOT, 'dist/.sp-inner.signed.zip');
  try {
    spZipDir(SRC, innerZip);
    signPathArtifact(innerZip, innerSigned, 'win-unpacked 内层');
    spUnzip(innerSigned, SRC);
  } finally {
    for (const f of [innerZip, innerSigned]) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
} else {
  signTargets(
    fs.readdirSync(SRC).filter((n) => /\.(exe|dll)$/i.test(n)).map((n) => path.join(SRC, n)),
    '应用目录'
  );
}

console.log('NSI 已生成:', NSI);
console.log('开始编译（压缩约 250MB，需要几分钟）…');

try {
  // stdio 必须显式写成 [ignore, pipe, pipe]：默认的 'pipe' 会给 stdin 建管道，
  // 在受限沙箱里 CreateProcess 会直接 EBUSY。
  const out = execFileSync(MAKENSIS, ['/V2', NSI], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const lines = out.split('\n');
  console.log(lines.slice(-12).join('\n'));
} catch (e) {
  const o = ((e.stdout || '') + (e.stderr || '')).toString();
  console.log('编译输出尾部:\n' + o.split('\n').slice(-25).join('\n'));
  process.exit(2);
}
// 外层安装包本体也签（用户双击的就是它）
if (USE_SIGNPATH) {
  const outerZip = path.join(ROOT, 'dist/.sp-outer.zip');
  const outerSigned = path.join(ROOT, 'dist/.sp-outer.signed.zip');
  try {
    spZipFile(OUT, outerZip);
    signPathArtifact(outerZip, outerSigned, '单文件安装包 外层');
    spUnzip(outerSigned, path.dirname(OUT));
  } finally {
    for (const f of [outerZip, outerSigned]) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
} else {
  signTargets([OUT], '单文件安装包');
}

console.log('产物:', OUT, fs.existsSync(OUT) ? Math.round(fs.statSync(OUT).size / 1048576) + ' MB' : '(未生成)');
