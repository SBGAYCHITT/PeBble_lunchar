#!/usr/bin/env node
// 精确校验 pages.js 的 i18n 覆盖：用极简词法扫描，正确处理
//  - 行注释 / 块注释（注释里的汉字不算文案）
//  - 模板字符串 `...` 里的 ${...} 插值（插值是代码，不是文案；文案是 ${} 之外的文本片段）
//  - 跨行的 T("k", null, "v") 兜底（按绝对字符位置判定，不受换行影响）
//  - 正则字面量 /[一-鿿]/ 这类（含汉字但属于代码，跳过）
//
// 判定：凡是"面向用户的汉字文案"（出现在顶层字符串或模板文本片段里）都必须位于某个 T(...) 参数区间内，
// 否则记为未覆盖。模板文本片段里本不应再有汉字（迁移时已被 wrapTemplate 抽进 ${T(...)}）。
//
// 用法：node scripts/check-pages-i18n.js [file]
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const file = process.argv[2] || 'pages.js';
const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
const n = src.length;

const HAN = /[一-鿿　-〿！-～…（）·，。、：；？！“”‘’《》【】—]/;
const tSpans = []; // 被 T(...) 覆盖的字符区间

function inside(lo, hi) {
  for (const s of tSpans) if (lo >= s.start && hi <= s.end) return true;
  return false;
}

// 跳过一段括号配平区域（同时跳过内部的字符串/模板字面量，避免引号/括号干扰计数）
function skipBalanced(startAfter, open, close) {
  let depth = 1, j = startAfter;
  while (j < n && depth > 0) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '"' || c === "'") { const q = c; j++; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } j++; continue; }
    if (c === '`') { j++; while (j < n && src[j] !== '`') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '$' && src[j + 1] === '{') { j = skipBalanced(j + 2, '{', '}'); continue; } j++; } j++; continue; }
    if (c === open) depth++; else if (c === close) depth--;
    j++;
  }
  return j;
}

const uncovered = [];
let i = 0;
while (i < n) {
  const c = src[i];
  // 注释
  if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
  if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
  // T( / I18N.t( / window.I18N.t(
  if (c === 'T' && src[i + 1] === '(' && !(i > 0 && /[A-Za-z0-9_$]/.test(src[i - 1]))) {
    const after = skipBalanced(i + 2, '(', ')');
    tSpans.push({ start: i, end: after });
    i = after; continue;
  }
  if (c === '.' && src[i + 1] === 't' && src[i + 2] === '(') {
    const after = skipBalanced(i + 3, '(', ')');
    tSpans.push({ start: i, end: after });
    i = after; continue;
  }
  // 顶层字符串
  if (c === '"' || c === "'") {
    const q = c, start = i; i++;
    while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    i++;
    const content = src.slice(start + 1, i - 1);
    if (HAN.test(content) && !inside(start, i)) {
      const line = src.slice(0, start).split('\n').length;
      uncovered.push({ line, text: content.slice(0, 40), tpl: false });
    }
    continue;
  }
  // 模板字符串
  if (c === '`') {
    const start = i; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i = skipBalanced(i + 2, '{', '}'); continue; }
      i++;
    }
    i++; // 收尾反引号
    const tmpl = src.slice(start, i);
    const re2 = /\$\{([\s\S]*?)\}/g;
    let m, lastPos = 0;
    while ((m = re2.exec(tmpl)) !== null) {
      const seg = tmpl.slice(lastPos, m.index);
      if (HAN.test(seg)) {
        const line = src.slice(0, start + lastPos).split('\n').length;
        uncovered.push({ line, text: seg.slice(0, 40), tpl: true });
      }
      lastPos = m.index + m[0].length;
    }
    const tail = tmpl.slice(lastPos);
    if (HAN.test(tail)) {
      const line = src.slice(0, start + lastPos).split('\n').length;
      uncovered.push({ line, text: tail.slice(0, 40), tpl: true });
    }
    continue;
  }
  i++;
}

if (uncovered.length === 0) {
  console.log('OK: ' + file + ' 无未包裹的中文文案（i18n 覆盖 100%，且注释/正则/键名已正确排除）');
  process.exit(0);
} else {
  console.log('FAIL: 发现 ' + uncovered.length + ' 处未包裹中文：');
  for (const u of uncovered.slice(0, 60)) console.log('  L' + u.line + (u.tpl ? ' [模板文本]' : ' [字符串]') + ': ' + u.text);
  process.exit(1);
}
