// 打包白名单契约测试。
//
// 为什么需要它（这不是「多加一条断言」，是补一个真出过事的缺口）：
//   package.json 的 build.files 是**白名单**，没登记的文件不会进 asar。而
//   ipc/*.js 是被 ipc/index.js 动态 require 的，主进程启动时会一个个 require 进来 ——
//   只要有哪个域 require 了一个没登记的模块，registerAll 就会抛 Cannot find module。
//   而且 ipc/index.js **刻意不 catch**（怕把域内部的真 bug 吞成「功能静默消失」），
//   所以后果不是「那个功能不可用」，是**整个应用起不来**。
//   实际踩过一次：新加 ipc/cloud.js 时忘了把根目录的 pebblecloud.js 登记进白名单，
//   打出来的 exe 直接启动失败。scripts/lite-verify.js 早就在给 Lite 白名单做这件事，
//   标准版这一侧一直是空的 —— 这个文件就是补上它。
//
// 做法：从 main.js + ipc/*.js 出发沿 require 递归（只看相对路径），
// 把闭包里的每个本地模块和 build.files 对账。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log(' FAIL ' + name + ' -> ' + e.message); }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = pkg.build.files;

/* ---------- 白名单匹配（支持 assets 目录下的星号通配） ---------- */
const allowed = new Set(files.map((f) => f.replace(/\\/g, '/')));
function isAllowed(rel) {
  if (allowed.has(rel)) return true;
  for (const a of allowed) {
    if (!a.includes('*')) continue;
    const re = new RegExp('^' + a
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/\*/g, '.*')
      .replace(/\*/g, '[^/]*') + '$');
    if (re.test(rel)) return true;
  }
  return false;
}

/* ---------- 依赖闭包 ---------- */
/** 用 optional() 或 try/catch 包住的可选依赖：不在白名单里属于正常降级 */
const OPTIONAL = new Set(['savetimemachine.js', 'modguard.js', 'multilaunch.js', 'crashdoctor.js']);

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

const ipcDir = path.join(ROOT, 'ipc');
const ipcFiles = fs.readdirSync(ipcDir).filter((f) => f.endsWith('.js')).map((f) => 'ipc/' + f);
const ENTRIES = ['main.js'].concat(ipcFiles);

const seen = new Set();
const closure = [];
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  closure.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  const src = fs.readFileSync(file, 'utf8');
  while ((m = re.exec(src))) {
    const r = resolveLocal(file, m[1]);
    if (r && r.startsWith(ROOT)) walk(r);
  }
}
for (const e of ENTRIES) {
  const p = path.resolve(ROOT, e);
  assert.ok(fs.existsSync(p), '入口不存在: ' + e);
  walk(p);
}

console.log('=== 规模 ===');
console.log('  入口        : ' + ENTRIES.length + ' 个（main.js + ' + ipcFiles.length + ' 个 ipc 域）');
console.log('  依赖闭包    : ' + closure.length + ' 个本地模块');
console.log('  白名单      : ' + allowed.size + ' 条');

t('依赖闭包不是空的（扫描本身没坏）', () => assert.ok(closure.length > 30, '只有 ' + closure.length + ' 个'));

/* ---------- 核心断言 ---------- */
const missing = closure.filter((rel) => {
  if (OPTIONAL.has(path.basename(rel))) return false;
  if (rel === 'package.json') return false;   // electron-builder 自动带上
  return !isAllowed(rel);
});
t('依赖闭包里每个模块都在 build.files 白名单里（否则打包版启动即崩）', () => {
  assert.deepStrictEqual(missing, [],
    '漏登记 ' + missing.length + ' 个：' + missing.join(', '));
});

/* ---------- 反向：白名单里提到的文件必须真的存在 ----------
 * 拼错文件名不会报错，只会安静地少打一个文件 —— 然后运行时才发现。 */
const bad = [];
for (const a of allowed) {
  if (a.includes('*')) {
    const root = a.split('/')[0];
    if (!fs.existsSync(path.join(ROOT, root))) bad.push(a + '（目录不存在）');
    continue;
  }
  if (!fs.existsSync(path.join(ROOT, a))) bad.push(a);
}
t('白名单里列的文件都存在（拼错就是静默少打一个文件）', () => {
  assert.deepStrictEqual(bad, [], '不存在: ' + bad.join(', '));
});

/* ---------- ipc/index.js 的 DOMAINS ↔ 磁盘上的域文件 ---------- */
const idxSrc = fs.readFileSync(path.join(ipcDir, 'index.js'), 'utf8');
const domBlock = idxSrc.match(/const DOMAINS = \[([\s\S]*?)\];/);
t('ipc/index.js 里能找到 DOMAINS', () => assert.ok(domBlock, '没匹配到'));
const domains = [...domBlock[1].matchAll(/'\.\/([\w-]+)'/g)].map((m) => m[1] + '.js');
t('DOMAINS 里每个域文件都存在（写错名字等于该域静默不注册）', () => {
  const gone = domains.filter((d) => !fs.existsSync(path.join(ipcDir, d)));
  assert.deepStrictEqual(gone, [], '不存在: ' + gone.join(', '));
});
t('DOMAINS 里没有重复项（重复 require 会二次注册，Electron 直接抛错）', () => {
  const dup = domains.filter((d, i) => domains.indexOf(d) !== i);
  assert.deepStrictEqual(dup, [], '重复: ' + dup.join(', '));
});
t('DOMAINS 覆盖了所有会被打包的 ipc 域文件（漏了就等于该域不进包）', () => {
  // ipc/util.js 是被 require 的工具，不是域；index.js 自身是入口
  const notDomain = new Set(['util.js', 'index.js']);
  const onDisk = ipcFiles.map((f) => f.replace(/^ipc\//, '')).filter((f) => !notDomain.has(f));
  const absent = onDisk.filter((f) => !domains.includes(f));
  assert.deepStrictEqual(absent, [], '未登记: ' + absent.join(', '));
});

console.log('\n' + (fail === 0 ? '★ 打包白名单全部通过' : `★ 打包白名单有 ${fail} 项失败`));
process.exit(fail ? 1 : 0);
