#!/usr/bin/env node
// i18n 覆盖率统计。
//
// 这是个启发式工具：目标是"看趋势 + 定位遗漏"，不是精确指标。
// 判定规则（都只统计含汉字的、面向用户的文案）：
//   - index.html：带 data-i18n 的元素算已覆盖；其余的文本节点与
//     placeholder/title/alt 属性算未覆盖。
//   - js：字符串字面量出现在 t('...') 里算已覆盖，否则未覆盖。
//   - 注释一律跳过（块注释、行注释、JSDoc）。
//
// 用法：node scripts/i18n-coverage.js [--list] [--json]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['index.html', 'renderer.js', 'pages.js'];

const HAN = /[\u4e00-\u9fa5]/;
// 单引号 / 双引号 / 反引号字符串，支持内部转义
const STR_RE = /(['"`])(?:(?!\1)[^\\]|\\.)*\1/g;

/** 某行是否为整行注释（块注释内部由 status 维护） */
function skipLine(trim) {
  return trim.startsWith('//') || trim.startsWith('*') || trim.startsWith('/*');
}

/** 字符串字面量是否被 i18n 包裹：往前看一段字符。
 *  兼容三种写法：
 *   - T('key') / t('key') / I18N.t('key')  —— 键位置（renderer.js 习惯）
 *   - T('key', null, '中文')  —— 兜底位置（pages.js 迁移生成的 fallback 形式）
 *  这里 src 是单行文本，往回看 96 字符足够覆盖 T(...) 的完整参数结构。 */
function wrappedByT(src, start) {
  const back = src.slice(Math.max(0, start - 96), start);
  // 键位置：T( / t( / I18N.t( 紧邻字符串之前
  if (/\bT\(\s*$/.test(back)) return true;
  if (/\bI18N\.t\(\s*$/.test(back)) return true;
  if (/\bt\(\s*$/.test(back)) return true;
  // 兜底位置：T('key', null, '  / T("key", null, "  —— 字符串是 T() 的第三参 fallback
  if (/\bT\(\s*['"][^'"]*['"]\s*,\s*(?:null|undefined)?\s*,\s*$/.test(back)) return true;
  if (/\bI18N\.t\(\s*['"][^'"]*['"]\s*,\s*(?:null|undefined)?\s*,\s*$/.test(back)) return true;
  return false;
}

/** 扫描 js 文件里的中文文案 */
function collectJs(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = src.split(/\r?\n/);
  const items = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trim = raw.trim();
    if (inBlock) { if (raw.includes('*/')) inBlock = false; continue; }
    if (trim.startsWith('/*') && !raw.includes('*/')) { inBlock = true; continue; }
    if (skipLine(trim)) continue;

    STR_RE.lastIndex = 0;
    let m;
    while ((m = STR_RE.exec(raw)) !== null) {
      const text = m[0].slice(1, -1);
      if (!HAN.test(text)) continue;
      items.push({
        file, line: i + 1, text,
        covered: wrappedByT(raw, m.index)
      });
    }
  }
  return items;
}

/** 扫描 html：文本节点 + 常见可见属性 */
const VISIBLE_ATTR = /(placeholder|title|alt|aria-label)\s*=\s*(['"])(.*?)\2/g;

function collectHtml(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = src.split(/\r?\n/);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (skipLine(raw.trim())) continue;
    const covered = /data-i18n\b/.test(raw);

    // 可见属性（placeholder 等）
    VISIBLE_ATTR.lastIndex = 0;
    let m;
    while ((m = VISIBLE_ATTR.exec(raw)) !== null) {
      if (!HAN.test(m[3])) continue;
      items.push({ file, line: i + 1, text: m[3], covered });
    }
    // 标签之间的文本节点
    const text = raw.replace(/<[^>]*>/g, '\n').split('\n')
      .map((s) => s.trim()).filter((s) => s && HAN.test(s));
    for (const t of text) items.push({ file, line: i + 1, text: t, covered });
  }
  return items;
}

function collect(file) {
  return file.endsWith('.html') ? collectHtml(file) : collectJs(file);
}

/** 汇总报告 */
function report(targets) {
  const files = targets || TARGETS;
  const per = [];
  let total = 0, covered = 0;
  const missing = [];
  for (const f of files) {
    const items = collect(f);
    const c = items.filter((x) => x.covered).length;
    per.push({ file: f, total: items.length, covered: c });
    total += items.length; covered += c;
    for (const it of items) if (!it.covered) missing.push(it);
  }
  return {
    per, total, covered, missing,
    pct: total ? Math.round(covered / total * 1000) / 10 : 100
  };
}

module.exports = { report, collect, TARGETS };

if (require.main === module) {
  const args = process.argv.slice(2);
  // --file=xxx 只看某个文件（迁移时逐个击破）
  const only = (args.find((a) => a.startsWith('--file=')) || '').split('=')[1];
  const r = only ? report([only]) : report();
  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log('[i18n] 覆盖率报告（启发式）');
    for (const p of r.per) {
      const pct = p.total ? Math.round(p.covered / p.total * 100) : 100;
      console.log(`  ${p.file.padEnd(14)} ${String(p.covered).padStart(4)} / ${String(p.total).padEnd(4)} ${pct}%`);
    }
    console.log(`  ${'合计'.padEnd(13)} ${String(r.covered).padStart(4)} / ${String(r.total).padEnd(4)} ${r.pct}%`);
    if (args.includes('--list')) {
      console.log('\n未覆盖明细：');
      for (const m of r.missing) console.log(`  ${m.file}:${m.line}  ${m.text.slice(0, 60)}`);
    } else {
      console.log(`\n（共 ${r.missing.length} 条未覆盖，加 --list 看明细）`);
    }
  }
}
