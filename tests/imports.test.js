/*
 * 导入契约测试 —— 防止「模块少导出、调用点静默拿到 undefined」这类事故。
 *
 * 事故回顾：downloader.js 的 module.exports 只写了 { installVersion, getManifest }，
 * 而 loaders.js 顶部是 `const { downloadFile, fetchJson } = require('./downloader')`。
 * 于是所有加载器版本查询、安装器下载全部在运行期抛
 *   TypeError: downloadFile is not a function
 * 用户看到的只有 UI 上干巴巴的「获取失败」，排查成本极高。
 *
 * 这个测试静态扫描所有 `const { a, b } = require('./x')`，逐个校验导出是否真的存在。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tools', '.probe', '.git', 'tests', 'build']);

let pass = 0, fail = 0;
const problems = [];

function collectFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) collectFiles(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out;
}

// 匹配 const { a, b: c } = require('./mod')  （允许跨行；[^{}] 防止跨到别的 require 上）
const RE = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;

const files = collectFiles(ROOT);
console.log(`\n[imports] 扫描 ${files.length} 个本地模块\n`);

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(src))) {
    const names = m[1].split(',')
      .map(s => s.trim().replace(/\/\/.*$/, '').trim()) // 去掉同行注释
      .filter(Boolean)
      .map(s => (s.includes(':') ? s.split(':')[0].trim() : s));
    const target = path.resolve(path.dirname(file), m[2]);
    const rel = path.relative(ROOT, file) + ' → ' + m[2];
    let mod;
    try {
      mod = require(target);
    } catch (e) {
      problems.push(`${rel}: 加载失败 ${e.message.split('\n')[0]}`);
      continue;
    }
    for (const n of names) {
      if (mod[n] === undefined) problems.push(`${rel}: 导出的 \`${n}\` 不存在（undefined）`);
    }
  }
}

if (problems.length) {
  fail += problems.length;
  console.log('[imports] ✗ 发现 ' + problems.length + ' 处缺失导出：');
  for (const p of problems) console.log('      · ' + p);
} else {
  pass++;
  console.log('[imports] ✓ 所有相对导入的解构字段都能在目标模块找到');
}

console.log(`\n[imports] 通过 ${pass} 组，失败 ${fail} 处\n`);
process.exit(fail ? 1 : 0);
