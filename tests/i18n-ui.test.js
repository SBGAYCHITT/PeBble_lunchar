// i18n-ui 契约测试：
//  1) renderer.js 用到的每个 T('key') 在字典里都必须有 zh-CN 与 en-US（否则运行时露裸 key / 英文退化成中文）
//  2) renderer.js 覆盖率必须为 100%（源码零中文文案，仅注释可含中文）
//  3) 带 {{x}} 占位符的 key，中英文占位符集合必须一致
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const I18N = require('../i18n');
const ui = require('../i18n-ui'); // Node 下导出 { ZH, EN }
I18N.addDict('zh-CN', ui.ZH);
I18N.addDict('en-US', ui.EN);

const ROOT = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log(' FAIL  ' + name + ' -> ' + e.message); fail++; }
}

/* ---------- 1) 提取 renderer 里用到的 key ---------- */
function extractKeys(src) {
  const keys = new Set();
  const re = /(?:T|I18N\.t)\(\s*'([a-zA-Z0-9_.]+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const k = m[1];
    if (k.endsWith('.')) continue;       // 动态拼接，如 'nav.' + page
    keys.add(k);
  }
  return [...keys];
}

const keys = extractKeys(renderer);

t('renderer 用到的 key 都能在 zh-CN 命中（不露裸 key）', () => {
  I18N.setLang('zh-CN');
  const missing = [];
  for (const k of keys) {
    const v = I18N.t(k);
    if (!v || v === k) missing.push(k);
  }
  assert.strictEqual(missing.length, 0, '缺中文翻译: ' + missing.join(', '));
});

t('renderer 用到的 key 都有 en-US 翻译（英文可用，非退化）', () => {
  const enMissing = I18N.missing('en-US');
  const bad = keys.filter((k) => enMissing.includes(k));
  assert.strictEqual(bad.length, 0, '缺英文翻译: ' + bad.join(', '));
  // 再确认翻译不是「退化成 key 或中文」（en-US 下取值应不同于中文）
  I18N.setLang('en-US');
  I18N.setLang('zh-CN');
  const zh = {};
  for (const k of keys) zh[k] = I18N.t(k);
  I18N.setLang('en-US');
  const degraded = [];
  for (const k of keys) {
    const e = I18N.t(k);
    if (!e || e === k || e === zh[k]) degraded.push(k);
  }
  assert.strictEqual(degraded.length, 0, '英文未真正翻译（等于 key 或中文）: ' + degraded.join(', '));
});

t('带占位符的 key，中英文占位符集合一致', () => {
  const params = (s) => {
    const out = [];
    const re = /\{\{(\w+)\}\}/g; let m;
    while ((m = re.exec(s)) !== null) out.push(m[1]);
    return out.sort().join(',');
  };
  const bad = [];
  for (const k of Object.keys(ui.ZH)) {
    const z = ui.ZH[k], e = ui.EN[k];
    if (z == null || e == null) continue;
    if ((z.includes('{{') || e.includes('{{')) && params(z) !== params(e)) {
      bad.push(k + ' [' + params(z) + ' vs ' + params(e) + ']');
    }
  }
  assert.strictEqual(bad.length, 0, '占位符不一致: ' + bad.join(', '));
});

/* ---------- 2) 覆盖率 100% ---------- */
t('renderer.js 覆盖率为 100%（源码无用户可见中文文案）', () => {
  const cov = require('../scripts/i18n-coverage');
  const r = cov.report(['renderer.js']);
  assert.strictEqual(r.missing.length, 0,
    '未覆盖 ' + r.missing.length + ' 条: ' + r.missing.slice(0, 5).map((x) => x.text).join(' | '));
});

console.log('\ni18n-ui: ' + pass + ' passed, ' + fail + ' failed (' + keys.length + ' keys checked)');
process.exit(fail ? 1 : 0);
