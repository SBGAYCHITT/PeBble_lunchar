#!/usr/bin/env node
// pages.js i18n 深度覆盖（AST 版，重写自脆弱的正则词法扫描）。
//
// 等价性保证：window.I18N.t(key, null, fallback) 在字典未命中该 key 时返回 fallback。
// 所以 T('pg.L{行}C{序号}', null, <原文字面量>) 恒等于原字符串 / 原模板（模板的 fallback
// 由 JS 在调用处求值，结果与原模板完全一致）。中文显示零变化。
//
// 为什么用 AST 而不是手写词法扫描：
//   pages.js 里满是「模板里嵌模板」「HTML 片段里带 < > / " ' 」「正则字面量 /[&<>"']/g」
//   这些对手写扫描是噩梦（旧版因此反复错位、吞掉半截代码）。直接借 TypeScript 编译器
//   的解析器拿到精确的字符串 / 模板字面量位置，从根上消除错位。
//
// 策略：把「含中文的、最外层的」字符串 / 模板字面量整体包裹成 T(key, null, <原字面量>)。
//   不向内递归（避免双重包裹）；模板内的中文随外层模板一起被 fallback 覆盖。
//
// 用法：node scripts/migrate-pages-i18n.js            （原地改写 pages.js + 生成 i18n-pages.js）
//       node scripts/migrate-pages-i18n.js --dry      （只统计，不改写）
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const FILE = 'pages.js';
const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const DRY = process.argv.includes('--dry');

const HAN = /[一-鿿]/;

const edits = [];          // { start, end, repl }
const keys = [];           // 顺序记录：{ key, line, type, text }
let count = 0;

const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true);

function isStringLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}
function hasHan(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return HAN.test(node.text);
  if (ts.isTemplateExpression(node)) return HAN.test(node.getText(sf));
  return false;
}
function isTCall(call) {
  const c = call.expression;
  if (!c) return false;
  if (ts.isIdentifier(c)) return c.text === 'T' || c.text === 't';
  if (ts.isPropertyAccessExpression(c)) return c.name.text === 't';
  return false;
}
function walk(node) {
  if (isStringLike(node) && hasHan(node)) {
    // 已经被 T()/t()/I18N.t() 包裹的（再次运行时的幂等保护）：跳过，不向内递归
    const p = node.parent;
    if (p && ts.isCallExpression(p) && isTCall(p)) return;
    const start = node.getStart(sf);
    const end = node.end;
    const line = sf.getLineAndCharacterOfPosition(start).line + 1;
    const key = 'pg.L' + line + 'C' + (++count);
    const raw = src.slice(start, end);
    edits.push({ start, end, repl: 'T(' + JSON.stringify(key) + ', null, ' + raw + ')' });
    let text = '';
    let type = 'string';
    if (ts.isTemplateExpression(node)) { type = 'template'; text = raw; }
    else { text = node.text; }
    keys.push({ key, line, type, text });
    return; // 不向内递归：外层整体包裹已覆盖内部中文
  }
  ts.forEachChild(node, walk);
}
ts.forEachChild(sf, walk);

if (DRY) {
  const strings = keys.filter((k) => k.type === 'string').length;
  const templates = keys.filter((k) => k.type === 'template').length;
  console.log('[dry] 待包裹字面量:', keys.length, '（字符串', strings, '/ 模板', templates, '）');
  for (const k of keys.slice(0, 25)) console.log('   ' + k.key + ' [' + k.type + ']  ' + k.text.slice(0, 36));
  process.exit(0);
}

// 1) 应用改写（按位置倒序，避免索引偏移）
edits.sort((a, b) => b.start - a.start);
let out = src;
for (const e of edits) out = out.slice(0, e.start) + e.repl + out.slice(e.end);

// 2) 注入 T 别名（pages.js 是独立 IIFE，作用域内没有 renderer.js 的 T）
const ALIAS = "  const T = (key, params, fb) => (window.I18N ? window.I18N.t(key, params, fb) : (fb != null ? fb : key));\n";
if (!/const T = \(key, params, fb\)/.test(out)) {
  const iife = out.indexOf('(function () {');
  if (iife >= 0) {
    const nl = out.indexOf('\n', iife) + 1;
    out = out.slice(0, nl) + ALIAS + out.slice(nl);
  } else {
    console.error('[warn] 未找到 IIFE 起点，T 别名未注入，请手动添加');
  }
}

// 3) 自校验：AST 复解析 + node --check
try {
  ts.createSourceFile(FILE, out, ts.ScriptTarget.Latest, false);
} catch (e) {
  console.error('[fatal] 改写后 AST 解析失败:', e.message);
  process.exit(2);
}
const outPath = path.join(ROOT, FILE);
fs.writeFileSync(outPath, out, 'utf8');
try {
  execSync(process.execPath + ' --check ' + JSON.stringify(outPath), { stdio: 'pipe' });
} catch (e) {
  fs.writeFileSync(path.join(ROOT, '_pages_syntax_err.txt'), String(e.stderr || e.stdout || e.message));
  console.error('[fatal] node --check 失败，详见 _pages_syntax_err.txt');
  process.exit(3);
}

// 4) 写出 key 清单（只列本次新包裹的，便于 review）
fs.writeFileSync(path.join(ROOT, '_pages_keys.json'), JSON.stringify(keys, null, 2));

// 5) 生成 i18n-pages.js：zh-CN = 所有「字符串字面量」原文；模板字面量靠 fallback 覆盖，不进字典。
//
// ⚠️ 这里必须从**改写后的完整源码**重新收集，而不是只用本次包裹出来的 keys。
//    keys 只包含"本次新包裹的"字面量；拿它去写整份字典，第二次运行时会把上一次
//    已经建好的词条整批抹掉 —— 覆盖率仍是 100%（源码里 fallback 还在），
//    但字典少了 200 多条，测试里表现为"一堆老 key 退化成裸 key"。
//    所以收集源一律用 out（全量），保证脚本可以反复运行。
const sf2 = ts.createSourceFile(FILE, out, ts.ScriptTarget.Latest, true);
/** @type {Array<{key:string, text:string}>} */
const all = [];
const seenKey = new Set();
const collect = (node) => {
  if (ts.isCallExpression(node) && isTCall(node) && node.arguments.length >= 3) {
    const a0 = node.arguments[0], fb = node.arguments[2];
    if (a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) &&
        /^pg\.L\d+C\d+$/.test(a0.text) &&
        fb && (ts.isStringLiteral(fb) || ts.isNoSubstitutionTemplateLiteral(fb))) {
      if (!seenKey.has(a0.text)) { seenKey.add(a0.text); all.push({ key: a0.text, text: fb.text }); }
    }
  }
  ts.forEachChild(node, collect);
};
ts.forEachChild(sf2, collect);

const zhLines = all.map((k) => '    ' + JSON.stringify(k.key) + ': ' + JSON.stringify(k.text) + ',');
const zhBody = zhLines.length ? '\n' + zhLines.join('\n') + '\n  ' : ' ';
const dict = '// pages.js 文案字典（i18n-pages.js）。\n' +
  '// 由 scripts/migrate-pages-i18n.js 自动生成：key 形如 pg.L{行}C{序号}。\n' +
  '// 策略：zh-CN 收录所有「字符串字面量」原文；模板字面量（含 ${...}）因无法以静态字符串入字典，\n' +
  '//   统一走 T(key, null, <模板>) 的 fallback（JS 在调用处求值，中文零变化）。\n' +
  '// ⚠️ 本文件由脚本从**全量源码**重建（不是只收本次新包裹的），因此脚本可反复运行。\n' +
  '// en-US 为渐进迁移占位：当前为空，运行期回退中文；需要英文时在此补 I18N.addDict(\'en-US\', {...})。\n' +
  '(function (root) {\n' +
  '  const I18N = (typeof module === \'object\' && module.exports) ? null : root.I18N;\n' +
  '  const ZH = {' + zhBody + '};\n' +
  '  const EN = {};\n' +
  '  if (I18N && I18N.addDict) {\n' +
  '    I18N.addDict(\'zh-CN\', ZH);\n' +
  '    I18N.addDict(\'en-US\', EN);\n' +
  '  }\n' +
  "  if (typeof module === 'object' && module.exports) module.exports = { ZH, EN };\n" +
  '})(typeof self !== \'undefined\' ? self : this);\n';
fs.writeFileSync(path.join(ROOT, 'i18n-pages.js'), dict, 'utf8');

console.log('REWRITE 完成：本次新包裹', edits.length, '处（字符串',
  keys.filter((k) => k.type === 'string').length, '/ 模板',
  keys.filter((k) => k.type === 'template').length, '）');
console.log('字典共写入', all.length, '条（从全量源码重建，脚本可反复运行）；node --check 通过。');
