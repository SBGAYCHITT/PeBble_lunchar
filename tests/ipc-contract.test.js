// IPC 契约测试（纯静态扫描，离线）
// 目的：main 进程注册了什么 / preload 用到了什么，两边必须严格对齐。
// 这类错误在运行时是「静默失效」或「Attempted to register a second handler」，
// 靠手点 UI 很难发现——尤其是把 main.js 拆成 ipc/ 多文件之后。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(f) { return fs.readFileSync(f, 'utf8'); }

/** 收集一个文件里所有匹配 re 的通道名 */
function collect(src, re) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, re.flags);
  while ((m = rx.exec(src))) out.push(m[1]);
  return out;
}

/* ---------- 主进程侧文件：main.js + ipc/*.js ---------- */
const mainFiles = ['main.js'];
const ipcDir = path.join(ROOT, 'ipc');
if (fs.existsSync(ipcDir)) {
  for (const f of fs.readdirSync(ipcDir)) {
    if (f.endsWith('.js')) mainFiles.push(path.join('ipc', f));
  }
}

const RE = {
  handle: /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g,
  on: /ipcMain\.on\(\s*['"]([^'"]+)['"]/g,
  emit: /emit\(\s*['"]([^'"]+)['"]/g,
  send: /webContents\.send\(\s*['"]([^'"]+)['"]/g,
  rendererInvoke: /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g,
  rendererOn: /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g,
  rendererSend: /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g
};

const handled = new Map();     // channel -> [文件...]
const listened = new Map();    // channel -> [文件...]（ipcMain.on）
const emitted = new Set();
const invoked = new Set();
const onRenderer = new Set();
const sentFromRenderer = new Set();

for (const rel of mainFiles) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(' FAIL 主进程文件缺失: ' + rel);
    process.exit(1);
  }
  const src = read(abs);
  for (const c of collect(src, RE.handle)) {
    if (!handled.has(c)) handled.set(c, []);
    handled.get(c).push(rel);
  }
  for (const c of collect(src, RE.on)) {
    if (!listened.has(c)) listened.set(c, []);
    listened.get(c).push(rel);
  }
  for (const c of collect(src, RE.emit)) emitted.add(c);
  for (const c of collect(src, RE.send)) emitted.add(c);
}

const preloadSrc = read(path.join(ROOT, 'preload.js'));
for (const c of collect(preloadSrc, RE.rendererInvoke)) invoked.add(c);
for (const c of collect(preloadSrc, RE.rendererOn)) onRenderer.add(c);
for (const c of collect(preloadSrc, RE.rendererSend)) sentFromRenderer.add(c);

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fail++;
}
function diff(setA, setB) { return [...setA].filter((x) => !setB.has(x)); }

console.log('=== 规模 ===');
console.log('  主进程文件: ' + mainFiles.join(', '));
console.log('  注册 handle: ' + handled.size + ' | ipcMain.on: ' + listened.size);
console.log('  preload invoke: ' + invoked.size + ' | 监听事件: ' + onRenderer.size);
check('handle 数量与 preload 调用规模相当（不是扫描失败）', handled.size > 50 && invoked.size > 50,
  `handle=${handled.size} invoke=${invoked.size}`);

console.log('\n=== 重复注册（Electron 会直接抛错） ===');
const dupHandled = [...handled.entries()].filter(([, files]) => files.length > 1);
check('没有 channel 被注册两次', dupHandled.length === 0,
  dupHandled.map(([c, f]) => c + ' @ ' + f.join('+')).join('; '));
const dupOn = [...listened.entries()].filter(([, files]) => files.length > 1);
check('没有 ipcMain.on 被注册两次', dupOn.length === 0,
  dupOn.map(([c, f]) => c + ' @ ' + f.join('+')).join('; '));

console.log('\n=== 完整性：preload 调用的每个 channel 都必须有人处理 ===');
const missing = diff(invoked, new Set(handled.keys()));
check('没有「调用了但没注册」的 channel', missing.length === 0, missing.join(', '));

console.log('\n=== 冗余：注册了但没人用（不算错，只是提示） ===');
const unused = diff(new Set(handled.keys()), invoked);
console.log('  未使用: ' + (unused.length ? unused.join(', ') : '（无）'));

console.log('\n=== 事件推送：preload 监听的每个事件都必须有发送方 ===');
const neverEmitted = diff(onRenderer, emitted);
check('没有「监听了但没人发」的事件', neverEmitted.length === 0, neverEmitted.join(', '));

console.log('\n=== 窗口控制：preload send 的每个通道都必须有 ipcMain.on ===');
const missingOn = diff(sentFromRenderer, new Set(listened.keys()));
check('没有「send 了但没监听」的通道', missingOn.length === 0, missingOn.join(', '));

/* ---------- ctx 契约：ipc/*.js 用到的 ctx 字段，main.js 必须都提供 ----------
 * 这是拆分 IPC 特有的坑：handler 不再直接访问 main.js 的 let 变量，
 * 少给一个字段就是运行时 undefined，静态扫描抓不到，只能靠这条断言。 */
console.log('\n=== ctx 契约（ipc 模块用到的字段必须在 main.js 提供） ===');
const used = new Map();   // field -> [文件]
for (const rel of mainFiles) {
  if (rel === 'main.js') continue;
  const src = read(path.join(ROOT, rel));
  // 解构：const { a, b } = ctx
  for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*ctx/g)) {
    for (const raw of m[1].split(',')) {
      const k = raw.trim().split(':')[0].trim();
      if (!k) continue;
      if (!used.has(k)) used.set(k, []);
      used.get(k).push(rel);
    }
  }
  // 点用：ctx.foo(
  for (const m of src.matchAll(/ctx\.([A-Za-z_$][\w$]*)/g)) {
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(rel);
  }
}

const mainSrc = read(path.join(ROOT, 'main.js'));
const block = mainSrc.match(/const ipcCtx = \{([\s\S]*?)\n\};/);
check('main.js 里能找到 ipcCtx 定义', !!block);
const provided = new Set();
if (block) {
  // 两种写法都要认：带值的 `getWin: () => win,` 和简写的 `ipcMain, dialog, emit,`
  for (const line of block[1].split('\n')) {
    const kv = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (kv) { provided.add(kv[1]); continue; }
    const bare = line.match(/^\s{2}([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*,?\s*$/);
    if (bare) for (const k of bare[1].split(',')) provided.add(k.trim());
  }
}
const missingCtx = diff(new Set(used.keys()), provided);
check('ipc 模块用到的 ctx 字段全部已提供', missingCtx.length === 0,
  missingCtx.map((k) => k + ' @ ' + [...new Set(used.get(k))].join('+')).join('; '));
console.log('  ctx 字段: ' + [...provided].sort().join(', '));

console.log('\n' + (fail === 0 ? '★ IPC 契约全部通过' : `★ IPC 契约有 ${fail} 项失败`));
process.exit(fail === 0 ? 0 : 1);
