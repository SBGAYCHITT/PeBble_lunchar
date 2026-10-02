// perfautotune.js 单元测试（纯 Node）
const assert = require('assert');
const at = require('../perfautotune');
const perf = require('../perfdoctor');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('perfautotune.test');
console.log('=================');

/* ---------------- sizeTier ---------------- */
t('sizeTier：0 区块 → tiny', () => assert.strictEqual(at.sizeTier(0).id, 'tiny'));
t('sizeTier：2000 → tiny（边界闭区间）', () => assert.strictEqual(at.sizeTier(2000).id, 'tiny'));
t('sizeTier：2001 → small', () => assert.strictEqual(at.sizeTier(2001).id, 'small'));
t('sizeTier：50000 → large', () => assert.strictEqual(at.sizeTier(50000).id, 'large'));
t('sizeTier：200000 → huge', () => assert.strictEqual(at.sizeTier(200000).id, 'huge'));
t('sizeTier：非法值按 0 处理', () => assert.strictEqual(at.sizeTier('abc').id, 'tiny'));

/* ---------------- recommendXmx ---------------- */
t('recommendXmx：小存档 + 大内存 → 基准值', () => {
  const r = at.recommendXmx({ totalGB: 32, chunks: 1000 });
  assert.strictEqual(r.mb, 2048, 'tiny 基准 2G');
  assert.strictEqual(r.cappedBy, 'none');
});

t('recommendXmx：大型存档 → 6G', () => {
  const r = at.recommendXmx({ totalGB: 32, chunks: 50000 });
  assert.strictEqual(r.mb, 6 * 1024);
});

t('recommendXmx：实体热点 +1G', () => {
  const a = at.recommendXmx({ totalGB: 32, chunks: 1000 });
  const b = at.recommendXmx({ totalGB: 32, chunks: 1000, entityMax: 100 });
  assert.strictEqual(b.mb - a.mb, 1024);
});

t('recommendXmx：受物理内存一半封顶', () => {
  const r = at.recommendXmx({ totalGB: 8, chunks: 50000 }); // 想要 6G，但 8G 的一半是 4G
  assert.strictEqual(r.mb, 4 * 1024);
  assert.strictEqual(r.cappedBy, 'half-ram');
  assert.ok(r.reason.includes('封顶'));
});

t('recommendXmx：最低 2G 兜底', () => {
  const r = at.recommendXmx({ totalGB: 2, chunks: 0 });
  assert.ok(r.mb >= 2048, 'mb=' + r.mb);
});

t('recommendXmx：OOM 时按峰值上浮', () => {
  const r = at.recommendXmx({ totalGB: 64, chunks: 1000, hasOom: true, peakHeapMB: 3500 });
  // peak 3500 → ceil(3500/1024)=4 + 2 = 6G
  assert.strictEqual(r.mb, 6 * 1024);
  assert.ok(r.reason.includes('OOM'));
});

t('recommendXmx：非法输入不抛', () => {
  const r = at.recommendXmx({});
  assert.ok(r.mb >= 2048);
});

/* ---------------- recommendGc ---------------- */
t('recommendGc：Java 17+ 且有长停顿 + 大内存 → ZGC', () => {
  const r = at.recommendGc({ javaMajor: 17, totalGB: 32, cpuCores: 8, maxPauseMs: 300 });
  assert.strictEqual(r.gc, 'ZGC');
  assert.strictEqual(r.presetId, 'zgc');
});

t('recommendGc：Java 21 → ZGenerational', () => {
  const r = at.recommendGc({ javaMajor: 21, totalGB: 32, cpuCores: 8, maxPauseMs: 300 });
  assert.ok(r.args.includes('ZGenerational'), r.args);
});

t('recommendGc：Java 17 → 不带 ZGenerational', () => {
  const r = at.recommendGc({ javaMajor: 17, totalGB: 32, cpuCores: 8, maxPauseMs: 300 });
  assert.ok(!r.args.includes('ZGenerational'), r.args);
});

t('recommendGc：内存 ≤8G 不选 ZGC，走 lowmem', () => {
  const r = at.recommendGc({ javaMajor: 21, totalGB: 8, cpuCores: 8, maxPauseMs: 300 });
  assert.strictEqual(r.gc, 'G1');
  assert.strictEqual(r.presetId, 'lowmem');
  assert.ok(r.args.includes('UseStringDeduplication'));
});

t('recommendGc：核多且无长停顿 → Parallel', () => {
  const r = at.recommendGc({ javaMajor: 17, totalGB: 32, cpuCores: 16, maxPauseMs: 30 });
  assert.strictEqual(r.gc, 'Parallel');
});

t('recommendGc：普通场景 → G1 平衡', () => {
  const r = at.recommendGc({ javaMajor: 17, totalGB: 16, cpuCores: 4 });
  assert.strictEqual(r.presetId, 'g1-balanced');
  assert.ok(r.args.includes('MaxGCPauseMillis=50'));
});

/* ---------------- tune ---------------- */
t('tune：返回完整结构', () => {
  const r = at.tune({ totalGB: 16, cpuCores: 8, javaMajor: 17, chunks: 10000 });
  assert.ok(r.xmxMB > 0);
  assert.ok(r.xmsMB > 0);
  assert.ok(typeof r.args === 'string' && r.args.includes('-Xmx'));
  assert.ok(Array.isArray(r.argsArray) && r.argsArray.length >= 3);
  assert.ok(Array.isArray(r.reasons) && r.reasons.length >= 3);
  assert.ok(Array.isArray(r.warnings));
});

t('tune：argsArray 与 args 字符串一致', () => {
  const r = at.tune({ totalGB: 16, cpuCores: 8, javaMajor: 17, chunks: 10000 });
  assert.strictEqual(r.argsArray.join(' '), r.args);
});

t('tune：大内存机器 Xms = Xmx', () => {
  const r = at.tune({ totalGB: 32, cpuCores: 8, javaMajor: 17, chunks: 10000 });
  assert.strictEqual(r.xmsMB, r.xmxMB, '大内存时 Xms 应等于 Xmx');
});

t('tune：小内存机器 Xms 受限', () => {
  const r = at.tune({ totalGB: 8, cpuCores: 4, javaMajor: 17, chunks: 30000 });
  assert.ok(r.xmsMB < r.xmxMB, `Xms(${r.xmsMB}) 应小于 Xmx(${r.xmxMB})`);
  assert.ok(r.xmsMB <= 2048);
});

t('tune：OOM + 内存封顶 → 提醒加内存条', () => {
  const r = at.tune({ totalGB: 8, cpuCores: 4, javaMajor: 17, chunks: 90000, hasOom: true, peakHeapMB: 6000 });
  assert.ok(r.warnings.some((w) => w.includes('内存条') || w.includes('加内存')), r.warnings.join('|'));
});

t('tune：2 核 → 提示核心少', () => {
  const r = at.tune({ totalGB: 16, cpuCores: 2, javaMajor: 17 });
  assert.ok(r.warnings.some((w) => w.includes('核心')), r.warnings.join('|'));
});

t('tune：javaMajor 缺失 → 提示确认版本', () => {
  const r = at.tune({ totalGB: 16, cpuCores: 8 });
  assert.ok(r.warnings.some((w) => w.includes('Java 主版本') || w.includes('javaMajor')), r.warnings.join('|'));
});

t('tune：结果可直接拼进 JVM 参数（无占位符残留）', () => {
  const r = at.tune({ totalGB: 16, cpuCores: 8, javaMajor: 21, chunks: 10000 });
  assert.ok(!r.args.includes('${'), '不该有未替换的占位符');
  assert.ok(!/\bNaN\b|\bundefined\b/.test(r.args), '不该出现 NaN/undefined：' + r.args);
});

t('tune：非法输入不抛异常', () => {
  const r = at.tune({});
  assert.ok(r.args.includes('-Xmx'));
  assert.ok(!/\bNaN\b/.test(r.args));
});

t('tune：tier 反映存档规模', () => {
  const r = at.tune({ totalGB: 32, cpuCores: 8, javaMajor: 17, chunks: 100000 });
  assert.strictEqual(r.tier.id, 'huge');
});

/* ---------------- fromDiagnosis ---------------- */
t('fromDiagnosis：抽取 OOM / 长停顿 / 峰值', () => {
  const d = perf.diagnose({ logText: 'java.lang.OutOfMemoryError\n[x][gc] GC(1) Pause Full 4G->1G(4G) 500.0ms' });
  const f = at.fromDiagnosis(d);
  assert.strictEqual(f.hasOom, true);
  assert.strictEqual(f.maxPauseMs, 500);
  assert.strictEqual(f.peakHeapMB, 4096);
});

t('fromDiagnosis：空输入返回零值', () => {
  const f = at.fromDiagnosis(null);
  assert.strictEqual(f.hasOom, false);
  assert.strictEqual(f.maxPauseMs, 0);
});

t('端到端：诊断 → 调参 链路顺畅', () => {
  const log = 'java.lang.OutOfMemoryError: Java heap space\n[x][gc] GC(5) Pause Full 4G->1G(4G) 600.0ms';
  const d = perf.diagnose({ logText: log, entityMax: 80, totalGB: 32, cpuCores: 8, xmxMB: 4096 });
  const input = Object.assign({ totalGB: 32, cpuCores: 8, javaMajor: 21, chunks: 30000, entityMax: 80 }, at.fromDiagnosis(d));
  const r = at.tune(input);
  assert.ok(r.xmxMB > 4096, 'OOM 后应比原来的 4G 更大');
  assert.strictEqual(r.gc, 'ZGC', '大内存 + OOM → ZGC');
  assert.ok(r.args.includes('-Xmx'));
});

console.log('=================');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
