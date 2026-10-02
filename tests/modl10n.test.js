// modl10n.js 单元测试
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('./zipwrite');
const l10n = require('../modl10n');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name); console.log('      ' + (e && e.message)); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '断言失败'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || '期望为真'); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-l10n-'));

/** 造一个带语言文件的 mod jar */
function makeMod(name, { ns, en, zh, zhTw }) {
  const files = { 'fabric.mod.json': JSON.stringify({ id: ns, version: '1.0.0' }) };
  if (en) files[`assets/${ns}/lang/en_us.json`] = JSON.stringify(en);
  if (zh) files[`assets/${ns}/lang/zh_cn.json`] = JSON.stringify(zh);
  if (zhTw) files[`assets/${ns}/lang/zh_tw.json`] = JSON.stringify(zhTw);
  return writeZip(path.join(TMP, name + '.jar'), files);
}

console.log('modl10n.js');

/* ---------- 词典翻译 ---------- */

t('整句精确匹配', () => {
  const r = l10n.translate('Diamond Sword');
  eq(r.text, '钻石剑');
  eq(r.method, 'phrase');
});

t('逐词替换全命中 → method=words', () => {
  const r = l10n.translate('Iron Ingot');
  eq(r.text, '铁锭');
  eq(r.method, 'words');
});

t('部分命中 → method=partial 且保留未命中原文', () => {
  const r = l10n.translate('Mysterious Diamond');
  eq(r.method, 'partial');
  ok(r.text.includes('钻石'), '该翻出钻石');
  ok(r.text.includes('Mysterious'), '未命中的词应原样保留');
});

t('完全未命中 → method=miss、text 为空', () => {
  const r = l10n.translate('Zzzqqq Wwwvvv');
  eq(r.method, 'miss');
  eq(r.text, '');
});

t('「A of B」语序调成中文（定语前置）', () => {
  eq(l10n.translate('Block of Iron').text, '铁方块');
  eq(l10n.translate('Block of Diamond').text, '钻石方块');
});

t('标点被保留', () => {
  const r = l10n.translate('Diamond:');
  ok(r.text.endsWith(':'), '冒号该留下，实际 ' + r.text);
});

t('大小写不敏感', () => {
  eq(l10n.translate('DIAMOND SWORD').text, '钻石剑');
  eq(l10n.translate('diamond sword').text, '钻石剑');
});

t('空串不炸', () => {
  eq(l10n.translate('').text, '');
  eq(l10n.translate(null).text, '');
  eq(l10n.translate(undefined).text, '');
});

t('纯占位符不翻译', () => {
  const r = l10n.translate('%s');
  eq(r.text, '');   // 没有可翻的词
});

t('专有名词保留（Mod / API 不翻）', () => {
  const r = l10n.translate('Mod');
  ok(!r.text || r.text === 'Mod', 'Mod 应保留，实际 ' + r.text);
});

/* ---------- worthTranslating ---------- */

t('worthTranslating：数字/符号不值得翻', () => {
  eq(l10n.worthTranslating('123.45'), false);
  eq(l10n.worthTranslating('%s'), false);
  eq(l10n.worthTranslating('§'), false);
});

t('worthTranslating：普通英文值得翻', () => {
  eq(l10n.worthTranslating('Diamond Sword'), true);
});

t('worthTranslating：全是专有词不翻', () => {
  eq(l10n.worthTranslating('mod api'), false);
});

t('worthTranslating：太短不翻', () => {
  eq(l10n.worthTranslating('a'), false);
});

/* ---------- 语言文件读取 ---------- */

t('listLangs 找出所有语言文件', () => {
  const j = makeMod('langs', { ns: 'demo', en: { a: 'A' }, zh: { a: '甲' } });
  const ls = l10n.listLangs(j);
  eq(ls.length, 2, '应有 2 个语言文件');
  ok(ls.some((l) => l.locale === 'en_us'));
  ok(ls.some((l) => l.locale === 'zh_cn'));
});

t('listLangs 对非 jar 返回空数组', () => {
  const bad = path.join(TMP, 'notjar.bin');
  fs.writeFileSync(bad, 'nope');
  eq(l10n.listLangs(bad).length, 0);
});

/* ---------- analyzeJar ---------- */

t('analyzeJar：全部缺失 → 全部进 missing/auto', () => {
  const j = makeMod('allmiss', {
    ns: 'demo',
    en: { 'item.sword': 'Diamond Sword', 'item.xyz': 'Quuxblorp Flimflam' }
  });
  const r = l10n.analyzeJar({ jarPath: j });
  eq(r.ok, true);
  eq(r.stats.total, 2, '两条都该算待翻');
  eq(r.stats.already, 0);
  // Diamond Sword 词典能翻；Quuxblorp Flimflam 是生造词，翻不了
  eq(r.stats.autoFilled, 1, '该自动填 1 条');
  eq(r.stats.stillMissing, 1, '该剩 1 条未翻');
});

t('analyzeJar：已有中文算 translated', () => {
  const j = makeMod('haszh', { ns: 'demo', en: { a: 'Apple', b: 'Banana' }, zh: { a: '苹果' } });
  const r = l10n.analyzeJar({ jarPath: j });
  eq(r.stats.already, 1, 'a 已有中文');
  const a = r.entries.find((e) => e.key === 'a');
  eq(a.status, 'translated');
  eq(a.zh, '苹果');
});

t('analyzeJar：中文等于英文 → 视为未翻译', () => {
  const j = makeMod('zhsame', { ns: 'demo', en: { a: 'Diamond' }, zh: { a: 'Diamond' } });
  const r = l10n.analyzeJar({ jarPath: j });
  const a = r.entries.find((e) => e.key === 'a');
  ok(a.status !== 'translated', '照抄英文不算翻译');
});

t('analyzeJar：没有语言文件 → 明确报错', () => {
  const j = writeZip(path.join(TMP, 'nolangs.jar'), { 'fabric.mod.json': '{"id":"x"}' });
  const r = l10n.analyzeJar({ jarPath: j });
  eq(r.ok, false);
  ok(/语言文件/.test(r.error));
});

t('analyzeJar：jar 不存在 → 明确报错', () => {
  const r = l10n.analyzeJar({ jarPath: 'nope.jar' });
  eq(r.ok, false);
  ok(/不存在/.test(r.error));
});

t('analyzeJar：没有 en_us 但有 en_gb → 能退回', () => {
  const j = writeZip(path.join(TMP, 'engb.jar'), {
    'fabric.mod.json': '{"id":"x"}',
    'assets/x/lang/en_gb.json': JSON.stringify({ a: 'Colour' }),
    'assets/x/lang/zh_cn.json': JSON.stringify({})
  });
  const r = l10n.analyzeJar({ jarPath: j });
  eq(r.ok, true, '应能退回 en_gb');
  eq(r.source, 'assets/x/lang/en_gb.json');
});

t('analyzeJar：extraDict 优先于内置词典', () => {
  const j = makeMod('extra', { ns: 'demo', en: { a: 'Diamond Sword' } });
  const r = l10n.analyzeJar({ jarPath: j, extraDict: { 'diamond sword': '钻石大宝剑' } });
  const a = r.entries.find((e) => e.key === 'a');
  eq(a.zh, '钻石大宝剑');
  eq(a.source, 'user');
});

t('analyzeJar：useDict=false 时不自动填', () => {
  const j = makeMod('nodict', { ns: 'demo', en: { a: 'Diamond Sword' } });
  const r = l10n.analyzeJar({ jarPath: j, useDict: false });
  const a = r.entries.find((e) => e.key === 'a');
  eq(a.status, 'missing');
  eq(a.zh, '');
});

t('analyzeJar：coverage 计算正确', () => {
  const j = makeMod('cov', {
    ns: 'demo',
    en: { a: 'Diamond', b: 'Iron', c: 'Quuxblorp' },
    zh: { a: '钻石' }
  });
  const r = l10n.analyzeJar({ jarPath: j });
  // a 已有中文，b 词典能翻，c 是生造词翻不了 → coverage 2/3 ≈ 67%
  eq(r.stats.coverage, 67, 'coverage 应为 67%，实际 ' + r.stats.coverage);
});

t('analyzeJar：排序把 missing 放最前', () => {
  const j = makeMod('order', {
    ns: 'demo',
    en: { a: 'Diamond', b: 'Quuxblorp', c: 'Iron' },
    zh: { a: '钻石' }
  });
  const r = l10n.analyzeJar({ jarPath: j });
  eq(r.entries[0].status, 'missing', '待翻译的该排第一');
});

/* ---------- buildPackFiles ---------- */

t('buildPackFiles：输出资源包路径正确', () => {
  const j = makeMod('pack1', { ns: 'mymod', en: { 'item.a': 'Diamond Sword' } });
  const a = l10n.analyzeJar({ jarPath: j });
  const p = l10n.buildPackFiles(a);
  ok(p.langs['assets/mymod/lang/zh_cn.json'], '该有 zh_cn 路径');
  eq(p.langs['assets/mymod/lang/zh_cn.json']['item.a'], '钻石剑');
});

t('buildPackFiles：已翻译的默认不重复收录', () => {
  const j = makeMod('pack2', { ns: 'm2', en: { a: 'Diamond', b: 'Iron' }, zh: { a: '钻石' } });
  const a = l10n.analyzeJar({ jarPath: j });
  const p = l10n.buildPackFiles(a);
  const zh = p.langs['assets/m2/lang/zh_cn.json'];
  ok(zh, '该产出资源包内容，实际 keys=' + JSON.stringify(Object.keys(p.langs)));
  ok(!('a' in zh), 'a 已在 jar 里翻译过，不该重复');
  ok('b' in zh, 'b 该被收录，实际 ' + JSON.stringify(zh));
});

t('buildPackFiles：includeTranslated 时全量收录', () => {
  const j = makeMod('pack3', { ns: 'm3', en: { a: 'Diamond', b: 'Iron' }, zh: { a: '钻石' } });
  const a = l10n.analyzeJar({ jarPath: j });
  const p = l10n.buildPackFiles(a, { includeTranslated: true });
  const zh = p.langs['assets/m3/lang/zh_cn.json'];
  ok('a' in zh && 'b' in zh, '全量模式该都收');
});

t('buildPackFiles：同时产出 zh_tw', () => {
  const j = makeMod('pack4', { ns: 'm4', en: { a: 'Diamond Sword' } });
  const a = l10n.analyzeJar({ jarPath: j });
  const p = l10n.buildPackFiles(a);
  ok(p.langs['assets/m4/lang/zh_tw.json'], '该有 zh_tw');
});

t('buildPackFiles：analysis 无效时返回空', () => {
  const p = l10n.buildPackFiles(null);
  eq(p.count, 0);
  eq(Object.keys(p.langs).length, 0);
});

/* ---------- 简繁转换 ---------- */

t('toTraditional 转换常见字', () => {
  eq(l10n.toTraditional('钻石'), '鑽石');
  eq(l10n.toTraditional('铁剑'), '鐵劍');
});

t('toTraditional 未收录字原样保留', () => {
  eq(l10n.toTraditional('ABC'), 'ABC');
});

console.log(`\n  ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
