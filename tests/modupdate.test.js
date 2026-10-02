// modupdate.js 单元测试
//
// 造 jar 的方式：用系统 tar 生成合法 zip（项目里已有先例）。
// 每个用例都造一对"旧 jar / 新 jar"，然后检查评估结果里的具体条目。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeZip } = require('./zipwrite');
const modupdate = require('../modupdate');

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name);
    console.log('      ' + (e && e.message));
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '断言失败'}: 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || '期望为真，实际为假'); }

/* ---------- 造 zip 的工具 ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-modupd-'));

/** 直接生成一个真 ZIP。不调 tar —— GNU / MSYS 版 tar 无法写出 zip 格式（只能写 tar 系列），
    跨平台测试里"用 tar 造 zip"必然翻车。见 tests/zipwrite.js。 */
function makeZip(dirName, files) {
  const out = path.join(TMP, dirName + '.jar');
  const flat = {};
  for (const [rel, content] of Object.entries(files)) {
    flat[rel] = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }
  return writeZip(out, flat);
}

/** 造一个 fabric mod 的 jar */
function fabricJar(name, { id, version, mcRange, deps, classes, zh }) {
  const meta = {
    schemaVersion: 1,
    id,
    version,
    name: id,
    depends: Object.assign({ minecraft: mcRange || '*' }, deps || {})
  };
  const files = { 'fabric.mod.json': meta };
  // 造若干 class 文件充数（内容无所谓，只要能数出条目数）
  for (let i = 0; i < (classes || 10); i++) {
    files[`com/example/${id}/Class${i}.class`] = 'x'.repeat(10);
  }
  files[`assets/${id}/lang/en_us.json`] = { 'item.test': 'Test Item', 'block.test': 'Test Block' };
  if (zh) files[`assets/${id}/lang/zh_cn.json`] = zh;
  return makeZip(name, files);
}

/* ---------- 用例 ---------- */

console.log('modupdate.js');

t('versionShape 拆版本号', () => {
  const s = modupdate.versionShape('1.20.4');
  eq(s.nums.join('.'), '1.20.4', '数字段');
});

t('bumpLevel：主版本跳跃', () => {
  const r = modupdate.bumpLevel('1.5.0', '2.0.0');
  eq(r.level, 'major', '应判为主版本');
});

t('bumpLevel：次版本', () => {
  eq(modupdate.bumpLevel('1.5.0', '1.6.0').level, 'minor');
});

t('bumpLevel：修订版', () => {
  eq(modupdate.bumpLevel('1.5.0', '1.5.1').level, 'patch');
});

t('bumpLevel：降级', () => {
  eq(modupdate.bumpLevel('2.0.0', '1.9.0').level, 'downgrade');
});

t('bumpLevel：相同（含补零对齐）', () => {
  eq(modupdate.bumpLevel('1.5', '1.5.0').level, 'same');
});

t('bumpLevel：非数字版本号不瞎猜', () => {
  eq(modupdate.bumpLevel('v-alpha', 'v-beta').level, 'unknown');
});

t('两个 jar 都缺 → 明确报错', () => {
  const r = modupdate.assess({});
  eq(r.ok, false, '应失败');
  ok(/oldPath/.test(r.error), '错误信息应提到参数名');
});

t('文件不存在 → 明确报错', () => {
  const r = modupdate.assess({ oldPath: 'nope.jar', newPath: 'nope2.jar' });
  eq(r.ok, false);
  ok(/不存在/.test(r.error));
});

t('安全的小更新（只动修订号、结构不变）→ 满分无 error', () => {
  // 注意：不能拿"完全一样的两份"当基准 —— 那会触发 VER_SAME / FILE_RENAMED 两条 info。
  // 真实更新里版本号一定会变，所以这里模拟 1.0.0 → 1.0.1 的正常小更新。
  const a = fabricJar('small-old', { id: 'mymod', version: '1.0.0', mcRange: '[1.20,1.21)', classes: 30 });
  const b = fabricJar('small-new', { id: 'mymod', version: '1.0.1', mcRange: '[1.20,1.21)', classes: 30 });
  const r = modupdate.assess({ oldPath: a, newPath: b, mcVersion: '1.20.1' });
  eq(r.ok, true);
  eq(r.hasError, false, '不该有 error');
  // 98 而不是 100：夹具里两个文件名不同（small-old / small-new），会触发一条
  // FILE_RENAMED 的 info（-2 分）。这在真实更新里也会发生（mod-1.0.0.jar → mod-1.0.1.jar），
  // 是**有意义的提示**，所以这里只要求接近满分。
  ok(r.score >= 98, '安全更新应接近满分，实际 ' + r.score);
  eq(r.grade, 'safe', '应判为安全');
});

t('modId 变了 → error', () => {
  const a = fabricJar('id-old', { id: 'mymod', version: '1.0.0' });
  const b = fabricJar('id-new', { id: 'othermod', version: '1.0.0' });
  const r = modupdate.assess({ oldPath: a, newPath: b });
  ok(r.findings.some((f) => f.code === 'ID_CHANGED'), '应报 modId 变了');
  eq(r.hasError, true);
});

t('新版不支持当前 MC → error', () => {
  const a = fabricJar('mc-old', { id: 'mymod', version: '1.0.0', mcRange: '[1.20,1.21)' });
  const b = fabricJar('mc-new', { id: 'mymod', version: '2.0.0', mcRange: '[1.21,1.22)' });
  const r = modupdate.assess({ oldPath: a, newPath: b, mcVersion: '1.20.1' });
  ok(r.findings.some((f) => f.code === 'MC_UNSUPPORTED'), '应报不支持');
  eq(r.hasError, true);
});

t('新增依赖且本地没有 → error', () => {
  const a = fabricJar('dep-old', { id: 'mymod', version: '1.0.0' });
  const b = fabricJar('dep-new', { id: 'mymod', version: '1.1.0', deps: { clothconfig: '>=11.0.0' } });
  const r = modupdate.assess({ oldPath: a, newPath: b, installedIds: ['mymod'] });
  ok(r.findings.some((f) => f.code === 'DEP_ADDED_MISSING'), '应报缺依赖');
  eq(r.hasError, true);
});

t('新增依赖但本地已装 → warn 而非 error', () => {
  const a = fabricJar('dep2-old', { id: 'mymod', version: '1.0.0' });
  const b = fabricJar('dep2-new', { id: 'mymod', version: '1.1.0', deps: { clothconfig: '>=11.0.0' } });
  const r = modupdate.assess({ oldPath: a, newPath: b, installedIds: ['mymod', 'clothconfig'] });
  ok(r.findings.some((f) => f.code === 'DEP_ADDED'), '应报新增依赖');
  eq(r.hasError, false, '已装就不该是 error');
});

t('去掉依赖 → info（不是问题）', () => {
  const a = fabricJar('dep3-old', { id: 'mymod', version: '1.0.0', deps: { oldlib: '>=1.0.0' } });
  const b = fabricJar('dep3-new', { id: 'mymod', version: '2.0.0' });
  const r = modupdate.assess({ oldPath: a, newPath: b });
  ok(r.findings.some((f) => f.code === 'DEP_REMOVED'), '应报去掉依赖');
  eq(r.hasError, false);
});

t('类数量大改（>35%）→ warn STRUCT_BIG', () => {
  const a = fabricJar('cls-old', { id: 'mymod', version: '1.0.0', classes: 20 });
  const b = fabricJar('cls-new', { id: 'mymod', version: '2.0.0', classes: 200 });
  const r = modupdate.assess({ oldPath: a, newPath: b });
  ok(r.findings.some((f) => f.code === 'STRUCT_BIG'), '应报结构大改');
});

t('类数量小变化 → info 而非 warn', () => {
  const a = fabricJar('cls2-old', { id: 'mymod', version: '1.0.0', classes: 100 });
  const b = fabricJar('cls2-new', { id: 'mymod', version: '1.0.1', classes: 103 });
  const r = modupdate.assess({ oldPath: a, newPath: b });
  ok(r.findings.some((f) => f.code === 'STRUCT_CLASSES' && f.severity === 'info'), '应是 info');
  ok(!r.findings.some((f) => f.code === 'STRUCT_BIG'), '不该报大改');
});

t('旧版有中文新版没有 → warn LANG_ZH_LOST', () => {
  const a = fabricJar('zh-old', { id: 'mymod', version: '1.0.0', zh: { 'item.test': '测试物品' } });
  const b = fabricJar('zh-new', { id: 'mymod', version: '2.0.0' });
  const r = modupdate.assess({ oldPath: a, newPath: b });
  ok(r.findings.some((f) => f.code === 'LANG_ZH_LOST'), '应报中文丢失');
});

t('新版带来中文 → info LANG_ZH_ADDED', () => {
  const a = fabricJar('zh2-old', { id: 'mymod', version: '1.0.0' });
  const b = fabricJar('zh2-new', { id: 'mymod', version: '1.1.0', zh: { 'item.test': '测试' } });
  const r = modupdate.assess({ oldPath: a, newPath: b });
  ok(r.findings.some((f) => f.code === 'LANG_ZH_ADDED'), '应报新增中文');
});

t('findings 按严重度排序（error 在前）', () => {
  const a = fabricJar('sort-old', { id: 'mymod', version: '1.0.0', classes: 20 });
  const b = fabricJar('sort-new', { id: 'othermod', version: '2.0.0', classes: 300 });
  const r = modupdate.assess({ oldPath: a, newPath: b, mcVersion: '1.20.1' });
  const sev = r.findings.map((f) => f.severity);
  const order = { error: 0, warn: 1, info: 2 };
  for (let i = 1; i < sev.length; i++) {
    ok(order[sev[i - 1]] <= order[sev[i]], `第 ${i} 项排序错了: ${sev.join(',')}`);
  }
});

t('评分随问题累积下降', () => {
  // 造一对"安全"的：改动最小、连文件名都一样（避免 FILE_RENAMED 这条 info 干扰分数）
  const d = path.join(TMP, 'scorecase');
  fs.mkdirSync(d, { recursive: true });
  writeZip(path.join(d, 'old.jar'), {
    'fabric.mod.json': JSON.stringify({ id: 'a', version: '1.0.0', depends: { minecraft: '*' } }),
    'com/example/a/C0.class': 'x'
  });
  writeZip(path.join(d, 'new.jar'), {
    'fabric.mod.json': JSON.stringify({ id: 'a', version: '1.0.1', depends: { minecraft: '*' } }),
    'com/example/a/C0.class': 'x'
  });
  const clean = modupdate.assess({ oldPath: path.join(d, 'old.jar'), newPath: path.join(d, 'new.jar') });
  ok(clean.score >= 90, '干净的小更新应接近满分，实际 ' + clean.score);

  // 造一对"有问题"的
  writeZip(path.join(d, 'bad-old.jar'), {
    'fabric.mod.json': JSON.stringify({ id: 'b', version: '1.0.0', depends: { minecraft: '*' } }),
    'com/example/b/C0.class': 'x'
  });
  writeZip(path.join(d, 'bad-new.jar'), {
    'fabric.mod.json': JSON.stringify({ id: 'c', version: '2.0.0', depends: { minecraft: '*' } }),
    'com/example/c/C0.class': 'x'
  });
  const bad = modupdate.assess({ oldPath: path.join(d, 'bad-old.jar'), newPath: path.join(d, 'bad-new.jar') });
  ok(bad.score < clean.score, '有问题应比干净的低分');
  ok(bad.score >= 0, '分数不该为负');
});

t('grade 分档正确', () => {
  const a = fabricJar('g-old', { id: 'x', version: '1.0.0' });
  const b = fabricJar('g-new', { id: 'x', version: '1.0.1' });
  eq(modupdate.assess({ oldPath: a, newPath: b }).grade, 'safe');
});

t('isNarrower：宽松→严格 判为收窄', () => {
  ok(modupdate.isNarrower('>=1.0.0', '*'), '* → >=1.0 应算收窄');
  ok(modupdate.isNarrower('1.0.0', '>=1.0.0'), '半开 → 精确应算收窄');
});

t('isNarrower：严格→宽松 不算收窄', () => {
  eq(modupdate.isNarrower('*', '>=1.0.0'), false);
});

t('rangeOf 优先取 minecraft 依赖', () => {
  const meta = { deps: [{ modId: 'minecraft', versionRange: '[1.20,1.21)' }], mcRange: '老了' };
  eq(modupdate.rangeOf(meta), '[1.20,1.21)');
});

t('rangeOf 无 minecraft 依赖时回落 mcRange', () => {
  eq(modupdate.rangeOf({ deps: [], mcRange: '[1.19,1.20)' }), '[1.19,1.20)');
});

t('jarShape 数出类/语言文件', () => {
  const j = fabricJar('shape-a', { id: 'z', version: '1.0.0', classes: 7, zh: { a: '甲' } });
  const s = modupdate.jarShape(j);
  eq(s.classes, 7, '类数量');
  eq(s.langs.length, 2, '应有 en_us 与 zh_cn 两个语言文件');
});

t('jarShape 对非 zip 返回 null', () => {
  const bad = path.join(TMP, 'not-a.zip');
  fs.writeFileSync(bad, 'definitely not a zip');
  eq(modupdate.jarShape(bad), null);
});

/* ---------- assessDir 批量 ---------- */

t('assessDir：配对更新 / 新装 / 忽略相同', () => {
  const cur = path.join(TMP, 'cur-mods');
  const inc = path.join(TMP, 'inc-mods');
  fs.mkdirSync(cur, { recursive: true });
  fs.mkdirSync(inc, { recursive: true });

  // 该更新：同 id 不同版本
  fs.copyFileSync(fabricJar('d-upd-old', { id: 'upd', version: '1.0.0' }), path.join(cur, 'upd-1.0.0.jar'));
  fs.copyFileSync(fabricJar('d-upd-new2', { id: 'upd', version: '1.1.0' }), path.join(inc, 'upd-1.1.0.jar'));
  // 完全相同：两边同 id 同版本同大小 → 不该出现
  const same = fabricJar('d-same', { id: 'same', version: '2.0.0' });
  fs.copyFileSync(same, path.join(cur, 'same-2.0.0.jar'));
  fs.copyFileSync(same, path.join(inc, 'same-2.0.0.jar'));
  // 新装：本地没有
  fs.copyFileSync(fabricJar('d-fresh', { id: 'brandnew', version: '3.0.0' }), path.join(inc, 'brandnew.jar'));

  const r = modupdate.assessDir({ modsDir: cur, incomingDir: inc });
  eq(r.ok, true);
  eq(r.count, 1, '应只有 1 个更新');
  eq(r.freshCount, 1, '应识别 1 个新装');
  eq(r.updates[0].newVersion, '1.1.0');
});

t('assessDir：风险高的排前面', () => {
  const cur = path.join(TMP, 'cur2');
  const inc = path.join(TMP, 'inc2');
  fs.mkdirSync(cur, { recursive: true });
  fs.mkdirSync(inc, { recursive: true });

  // 安全的：只改修订号，内容有实质变化（类数量不同 → size 不同，不会被当成"一模一样"跳过）
  fs.copyFileSync(fabricJar('s-old', { id: 'safe', version: '1.0.0', classes: 50 }), path.join(cur, 'safe.jar'));
  fs.copyFileSync(fabricJar('s-new', { id: 'safe', version: '1.0.1', classes: 51 }), path.join(inc, 'safe.jar'));
  // 危险的：同名同 id，但新版依赖一个本地没有的 mod → 更新后必崩
  // （不能用"改 modId"当危险样例：id 变了 assessDir 会判成新装而不是更新，这是对的）
  fs.copyFileSync(fabricJar('r-old', { id: 'risk', version: '1.0.0', classes: 30 }), path.join(cur, 'risk.jar'));
  fs.copyFileSync(fabricJar('r-new', { id: 'risk', version: '2.0.0', classes: 30, deps: { missinglib: '>=1.0.0' } }),
    path.join(inc, 'risk.jar'));

  const r = modupdate.assessDir({ modsDir: cur, incomingDir: inc, mcVersion: '' });
  eq(r.count, 2, '两个都该被认成更新');
  eq(r.updates[0].fileName, 'risk.jar', '有 error 的应排第一');
  eq(r.risky, 1, '应统计出 1 个高风险');
});

t('assessDir：目录不存在时不崩', () => {
  const r = modupdate.assessDir({ modsDir: path.join(TMP, 'no-such'), incomingDir: path.join(TMP, 'no-such-2') });
  eq(r.count, 0);
  eq(r.freshCount, 0);
});

console.log(`\n  ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
