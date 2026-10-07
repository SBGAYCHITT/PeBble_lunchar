#!/usr/bin/env node
/**
 * Lite 白名单校验：确认 build/lite.config.js 里列出的模块，
 * 覆盖了「Lite 版实际会加载的模块」的完整依赖闭包。
 *
 * 为什么需要它：
 *   Lite 版是「打包时按白名单挑文件」，漏掉一个被间接 require 的模块，
 *   主进程会在启动那一刻抛 Cannot find module —— 而且是在 whenReady 的 promise 里，
 *   表现是「进程活着但窗口永远不出现」，非常难查。
 *   实测就漏过一次：javadl.js 需要 zipread.js（当时以为 zipread 只有 modguard 用）。
 *
 * 做法：从入口出发沿 require 递归，把每个本地依赖和 package.json 的 files 白名单对账。
 * 已知的「可选依赖」（用 optional() 包住的）不算缺失 —— 它们本来就允许不在包里。
 *
 * 用法：node scripts/lite-verify.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRIES = [
  'main.js',
  'ipc/window.js', 'ipc/base.js', 'ipc/launch.js',
  'ipc/versions.js', 'ipc/account.js', 'ipc/system.js'
];

/* 用 optional() 包住的可选模块：不在白名单里属于正常降级，不算漏 */
const OPTIONAL = new Set(['savetimemachine.js', 'modguard.js', 'multilaunch.js', 'crashdoctor.js']);

/** 解析相对 require，返回绝对路径或 null（第三方 / 内置模块） */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/* 白名单：从 lite.config.js 里把 files 数组取出来（配置是 JS，直接 require 最准） */
const liteConfig = require('../build/lite.config.js');
const allowed = new Set();
for (const f of liteConfig.files) {
  if (typeof f === 'string') allowed.add(f.replace(/\\/g, '/'));
}
const isAllowed = (rel) => {
  if (allowed.has(rel)) return true;
  // 支持 assets/**/* 这类通配
  for (const a of allowed) {
    if (a.includes('*')) {
      const re = new RegExp('^' + a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
      if (re.test(rel)) return true;
    }
  }
  return false;
};

/* 递归收集依赖闭包 */
const seen = new Set();
const localDeps = [];
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  localDeps.push(rel);
  const src = fs.readFileSync(file, 'utf8');
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const r = resolveLocal(file, m[1]);
    if (r && r.startsWith(ROOT)) walk(r);
  }
}
for (const e of ENTRIES) {
  const p = path.resolve(ROOT, e);
  if (!fs.existsSync(p)) { console.error('✗ 入口不存在: ' + e); process.exit(2); }
  walk(p);
}

/* 对账 */
const missing = [];
for (const rel of localDeps) {
  const base = path.basename(rel);
  if (OPTIONAL.has(base)) continue;         // 可选模块，允许不在包里
  if (rel === 'package.json') continue;     // electron-builder 自动带上
  if (!isAllowed(rel)) missing.push(rel);
}

/* 反向检查：白名单里列了、但 require 闭包里用不到的文件（无害，但说明配置在腐化）。
   这几类属于「不会出现在 require 闭包里、但确实必需」：
     - 前端脚本由 index.html 的 <script> 加载，不走 require
     - ipc/* 是被 ipc/index.js 动态 require 的，静态扫不到
     - crashdoctor 走 optional()，文件在包里就会被加载 */
const BY_DESIGN = [
  'preload.js', 'renderer.js', 'pages.js', 'style.css', 'main.js',
  'i18n-ui.js', 'i18n-pages.js', 'crashdoctor.js', 'index.lite.html'
];
const unused = [...allowed].filter((a) => !a.includes('*') &&
  !localDeps.includes(a) &&
  !BY_DESIGN.includes(a) &&
  !a.startsWith('ipc/'));

console.log('Lite 白名单校验');
console.log('  入口        : ' + ENTRIES.length + ' 个');
console.log('  依赖闭包    : ' + localDeps.length + ' 个模块');
console.log('  白名单      : ' + allowed.size + ' 条');

/* ---------- 第二步：preload 暴露的 API ↔ Lite 实际注册的 handler 对账 ----------
   依赖闭包只管「模块文件在不在」，管不了「IPC 通道注册了没有」。
   实测踩过一次：read-options / write-options 挂在被裁掉的 content 域里，
   模块是齐的、打包也成功，但设置页一打开就报 No handler registered。 */
function preloadChannels() {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const out = new Map();   // apiName -> channel
  const re = /(\w+)\s*:\s*\([^)]*\)\s*=>\s*[^,\n]*ipcRenderer\.invoke\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.set(m[1], m[2]);
  return out;
}

function liteHandlers() {
  const set = new Set();
  const dir = path.join(ROOT, 'ipc');
  const files = allowed.has('ipc/index.js') ? fs.readdirSync(dir) : [];
  for (const f of files) {
    const rel = 'ipc/' + f;
    if (!allowed.has(rel)) continue;               // 该域没进包
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /ipcMain\.handle\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) set.add(m[1]);
  }
  return set;
}

const preload = preloadChannels();
const handlers = liteHandlers();
const noHandler = [...preload.entries()].filter(([, ch]) => !handlers.has(ch));

console.log('\n  preload 暴露 : ' + preload.size + ' 个 API');
console.log('  Lite 已注册  : ' + handlers.size + ' 个 handler');
if (noHandler.length) {
  console.log('\n  以下 API 在 Lite 包里没有对应 handler（调用会返回 No handler registered）。');
  console.log('  只有「Lite 保留页面里确实会用到」的才是 bug，其余是被裁功能留下的死接口：');
  for (const [name, ch] of noHandler) console.log('    ' + name.padEnd(20) + ch);
}

if (missing.length) {
  console.error('\n✗ 以下模块被依赖、但不在白名单里（打包后会在运行时抛 Cannot find module）：');
  for (const m of missing) console.error('    ' + m);
  process.exit(1);
}
if (unused.length) {
  console.log('\n  提示：白名单里这些文件当前用不到，可考虑移除以进一步瘦身：');
  for (const u of unused) console.log('    ' + u);
}
console.log('\n✓ 通过：闭包内所有必需模块都在白名单里');
