// i18n-pages 契约测试（AST 版，与 i18n-ui.test.js 同思路，但用编译器解析器判定覆盖率）：
//  1) pages.js 里「含中文的最外层字符串 / 模板字面量」必须整体被 T(key, null, <字面量>) 包裹
//     —— 模板字面量（含 ${...}）由 fallback 在调用处求值，中文零变化，不进静态字典。
//  2) 字典（i18n-pages.js）的 zh-CN 必须收录所有「字符串字面量」key（模板 key 走 fallback，不要求进字典）。
//  3) 带 {{x}} 占位符的 key，中英文占位符集合一致（当前 en-US 为空，属渐进迁移占位，本条不强制）。
//  4) 运行时：每个 key 通过 I18N.t 取值不能退化成裸 key。
//
// 关键：覆盖率判定借 TypeScript 解析器，精准识别「被 T()/t()/I18N.t() 包裹」的字面量，
//      不会像正则扫描那样被模板 / 正则字面量 / HTML 里的引号误导。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const ts = require('typescript');

const I18N = require('../i18n');
const pages = require('../i18n-pages'); // Node 下导出 { ZH, EN }
I18N.addDict('zh-CN', pages.ZH);
I18N.addDict('en-US', pages.EN);

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'pages.js'), 'utf8');
const sf = ts.createSourceFile('pages.js', src, ts.ScriptTarget.Latest, true);

const HAN = /[一-鿿]/;
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log(' FAIL  ' + name + ' -> ' + e.message); fail++; }
}

function isTCall(call) {
  const c = call.expression;
  if (!c) return false;
  if (ts.isIdentifier(c)) return c.text === 'T' || c.text === 't';
  if (ts.isPropertyAccessExpression(c)) return c.name.text === 't';
  return false;
}
// 某中文字面量是否被「包裹」：沿祖先链上溯，若存在某个祖先本身就是 T()/t()/I18N.t() 的直接实参，则算覆盖。
//   - 直接被包裹的字面量：自身就是 T() 的实参 -> 覆盖。
//   - 模板内的中文（如 ${'（回退）'} ）：其祖先模板整体是 T() 的 fallback -> 也覆盖。
function isCovered(lit) {
  let node = lit, parent = lit.parent;
  while (parent) {
    if (ts.isCallExpression(parent) && isTCall(parent) && parent.arguments.includes(node)) return true;
    node = parent; parent = parent.parent;
  }
  return false;
}
function isStringLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}
function hasHan(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return HAN.test(node.text);
  if (ts.isTemplateExpression(node)) return HAN.test(node.getText(sf));
  return false;
}

// 收集：① 未覆盖的中文字面量 ② 所有 T('pg...') 调用及其 fallback 类型
const uncovered = [];
const tCalls = []; // { key, kind: 'string'|'template' }
const visit = (node) => {
  if (isStringLike(node) && hasHan(node)) {
    if (!isCovered(node)) uncovered.push(node);
    return; // 不向内递归
  }
  if (ts.isCallExpression(node) && isTCall(node) && node.arguments.length >= 1) {
    const a0 = node.arguments[0];
    if (a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) && /^pg\.L\d+C\d+$/.test(a0.text)) {
      const fb = node.arguments[2];
      let kind = 'other';
      if (fb && (ts.isStringLiteral(fb) || ts.isNoSubstitutionTemplateLiteral(fb))) kind = 'string';
      else if (fb && ts.isTemplateExpression(fb)) kind = 'template';
      tCalls.push({ key: a0.text, kind });
    }
  }
  ts.forEachChild(node, visit);
};
ts.forEachChild(sf, visit);

/* ---------- 1) 覆盖率 100% ---------- */
t('pages.js 覆盖率 100%（含中文字面量全部被 T 包裹，无露裸中文文案）', () => {
  assert.strictEqual(uncovered.length, 0,
    '未覆盖 ' + uncovered.length + ' 处: ' +
    uncovered.slice(0, 8).map((n) => 'L' + (sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1) +
      ' ' + (n.getText ? n.getText(sf).slice(0, 30) : '')).join(' | '));
});

/* ---------- 2) 字典收录 ---------- */
t('i18n-pages.js 的 zh-CN 收录了所有字符串字面量 key', () => {
  const missing = tCalls.filter((c) => c.kind === 'string' && !(c.key in pages.ZH));
  assert.strictEqual(missing.length, 0, 'zh-CN 缺: ' + missing.map((m) => m.key).join(', '));
});

t('i18n-pages.js 的 zh-CN 值与原文一致（fallback 未被篡改）', () => {
  // 重新解析 pages.js，按 key 取每个字符串 fallback 的原文，与字典比对
  const byKey = {};
  const v2 = (node) => {
    if (ts.isCallExpression(node) && isTCall(node) && node.arguments.length >= 3) {
      const a0 = node.arguments[0], fb = node.arguments[2];
      if (a0 && (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) && /^pg\.L\d+C\d+$/.test(a0.text)) {
        if (fb && (ts.isStringLiteral(fb) || ts.isNoSubstitutionTemplateLiteral(fb))) byKey[a0.text] = fb.text;
      }
    }
    ts.forEachChild(node, v2);
  };
  ts.forEachChild(sf, v2);
  const bad = [];
  for (const k of Object.keys(byKey)) {
    if (byKey[k] !== pages.ZH[k]) bad.push(k);
  }
  assert.strictEqual(bad.length, 0, '值与原文不一致: ' + bad.slice(0, 5).join(', '));
});

/* ---------- 3) 占位符一致性（en-US 为空时本条自动通过） ---------- */
t('带 {{x}} 占位符的 key，中英文占位符集合一致', () => {
  const params = (s) => {
    const out = []; const re = /\{\{(\w+)\}\}/g; let m;
    while ((m = re.exec(s || '')) !== null) out.push(m[1]);
    return out.sort().join(',');
  };
  const bad = [];
  for (const k of Object.keys(pages.ZH)) {
    const z = pages.ZH[k], e = pages.EN[k];
    if (z == null || e == null) continue;
    if ((z.includes('{{') || e.includes('{{')) && params(z) !== params(e)) {
      bad.push(k + ' [' + params(z) + ' vs ' + params(e) + ']');
    }
  }
  assert.strictEqual(bad.length, 0, '占位符不一致: ' + bad.join(', '));
});

/* ---------- 4) 运行时不露裸 key ----------
 * 仅校验「字符串字面量」key：它们进 zh-CN 字典，I18N.t(key) 必命中。
 * 模板字面量 key 不进字典，靠 T(key, null, <模板>) 的 fallback（调用处求值）覆盖，
 * 该保证已由「覆盖率 100%」这条（isCovered 命中祖先 T 调用）证明，此处不重复断言。 */
t('每个字符串字面量 key 经 I18N.t 取值不退化成裸 key', () => {
  I18N.setLang('zh-CN');
  const bare = [];
  for (const c of tCalls) {
    if (c.kind !== 'string') continue;
    const v = I18N.t(c.key);
    if (!v || v === c.key) bare.push(c.key);
  }
  assert.strictEqual(bare.length, 0, '裸 key / 空值: ' + bare.slice(0, 8).join(', '));
});

console.log('\ni18n-pages: ' + pass + ' passed, ' + fail + ' failed (' +
  tCalls.length + ' keys / ' + uncovered.length + ' uncovered)');
process.exit(fail ? 1 : 0);
