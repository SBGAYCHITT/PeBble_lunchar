// perfdoctor.js 单元测试（纯 Node，不依赖 Electron）
const assert = require('assert');
const perf = require('../perfdoctor');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('perfdoctor.test');
console.log('===============');

/* ---------------- extract ---------------- */
t('extract：空输入返回零值', () => {
  const r = perf.extract('');
  assert.strictEqual(r.lines, 0);
  assert.strictEqual(r.gc.count, 0);
  assert.strictEqual(r.oom, false);
});

t('extract：null / undefined 不抛异常', () => {
  assert.strictEqual(perf.extract(null).lines, 0);
  assert.strictEqual(perf.extract(undefined).lines, 0);
});

t('extract：Java 9+ GC 行统计停顿', () => {
  const log = [
    '[2026-10-02T11:00:00.100+0800][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 512M->128M(2048M) 12.345ms',
    '[2026-10-02T11:00:01.200+0800][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 600M->140M(2048M) 8.000ms'
  ].join('\n');
  const r = perf.extract(log);
  assert.strictEqual(r.gc.count, 2);
  assert.strictEqual(r.gc.maxPauseMs, 12.3);
  assert.strictEqual(r.gc.totalPauseMs, 20.3);
});

t('extract：Java 8 GC 行（secs 单位）也认', () => {
  const log = '[GC (Allocation Failure) 100M->20M(512M), 0.0123456 secs]';
  const r = perf.extract(log);
  assert.strictEqual(r.gc.count, 1);
  assert.ok(Math.abs(r.gc.maxPauseMs - 12.3) < 0.5, '应约 12.3ms，实际 ' + r.gc.maxPauseMs);
});

t('extract：忽略 0.0x ms 的日志噪声', () => {
  const log = '[x][info][gc] GC(1) Pause Young 1M->1M(2M) 0.010ms';
  assert.strictEqual(perf.extract(log).gc.count, 0);
});

t('extract：堆峰值取括号总量', () => {
  const log = '[x][info][gc] GC(1) Pause Young (Normal) 512M->128M(4096M) 10.0ms';
  const r = perf.extract(log);
  assert.strictEqual(r.gc.peakHeapMB, 4096);
});

t('extract：Can not keep up 计数与最严重值', () => {
  const log = [
    "Can't keep up! Is the server overloaded? Running 2500ms or 50 ticks behind",
    "Can't keep up! Running 800ms behind"
  ].join('\n');
  const r = perf.extract(log);
  assert.strictEqual(r.stutter.behindCount, 2);
  assert.strictEqual(r.stutter.worstBehindMs, 2500);
});

t('extract：OOM 关键字命中', () => {
  assert.strictEqual(perf.extract('java.lang.OutOfMemoryError: Java heap space').oom, true);
  assert.strictEqual(perf.extract('Exception in thread "main" GC overhead limit exceeded').oom, true);
  assert.strictEqual(perf.extract('一切正常').oom, false);
});

t('extract：chunk 准备进度', () => {
  assert.strictEqual(perf.extract('Preparing spawn area: 73%').chunkPct, 73);
});

t('extract：半行/截断日志不崩', () => {
  const r = perf.extract('[2026-10-02T11:00:00.100+0800][info][gc] GC(1) Pause Y');
  assert.strictEqual(r.lines, 1);
});

/* ---------------- diagnose：OOM ---------------- */
t('diagnose：OOM → fatal', () => {
  const d = perf.diagnose({ logText: 'java.lang.OutOfMemoryError: Java heap space' });
  const f = d.findings.find((x) => x.id === 'oom');
  assert.ok(f, '应有 oom 条目');
  assert.strictEqual(f.severity, 'fatal');
  // 单个 fatal 扣 45 分 → 55 分，落在 poor 档（40..69）
  assert.strictEqual(d.score, 55);
  assert.strictEqual(d.grade, 'poor');
});

/* ---------------- diagnose：GC 停顿 ---------------- */
t('diagnose：单次停顿超 200ms → error + gc-pause-long', () => {
  const d = perf.diagnose({ logText: '[x][info][gc] GC(9) Pause Full 12G->11G(12G) 850.0ms' });
  const f = d.findings.find((x) => x.id === 'gc-pause-long');
  assert.ok(f, '应有 gc-pause-long');
  assert.strictEqual(f.severity, 'error');
  assert.ok(f.evidence.includes('850'), '证据应含实测值');
});

t('diagnose：停顿 60ms 不触发 200ms 规则，但触发 frequent？不（次数太少）', () => {
  const d = perf.diagnose({ logText: '[x][gc] GC(1) Pause Young 1G->1G(2G) 60.0ms' });
  assert.strictEqual(d.findings.some((x) => x.id === 'gc-pause-long'), false);
  assert.strictEqual(d.findings.some((x) => x.id === 'gc-pause-frequent'), false);
});

t('diagnose：GC 次数多且平均停顿短 → frequent', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`[x][gc] GC(${i}) Pause Young (Normal) 1G->512M(2G) 5.0ms`);
  const d = perf.diagnose({ logText: lines.join('\n') });
  assert.ok(d.findings.some((x) => x.id === 'gc-pause-frequent'), '应有 frequent');
});

t('diagnose：Full GC 达阈值', () => {
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(`[x][gc] GC(${i}) Pause Full 4G->1G(4G) 90.0ms`);
  const d = perf.diagnose({ logText: lines.join('\n') });
  assert.ok(d.findings.some((x) => x.id === 'full-gc'), '应有 full-gc');
});

/* ---------------- diagnose：世界数据 ---------------- */
t('diagnose：实体热点 → warn', () => {
  const d = perf.diagnose({ entityMax: 120 });
  const f = d.findings.find((x) => x.id === 'entity-hotspot');
  assert.ok(f, '应有 entity-hotspot');
  assert.ok(f.evidence.includes('120'));
});

t('diagnose：实体数 10 不触发热点', () => {
  const d = perf.diagnose({ entityMax: 10 });
  assert.strictEqual(d.findings.some((x) => x.id === 'entity-hotspot'), false);
});

t('diagnose：容器多 → info', () => {
  const d = perf.diagnose({ containerCount: 5000 });
  assert.ok(d.findings.some((x) => x.id === 'container-heavy'));
});

/* ---------------- diagnose：配置 ---------------- */
t('diagnose：Xmx 超过物理内存一半 → mem-overcommit', () => {
  const d = perf.diagnose({ totalGB: 8, xmxMB: 8 * 1024 });
  const f = d.findings.find((x) => x.id === 'mem-overcommit');
  assert.ok(f, '应有 mem-overcommit');
  assert.ok(f.advice.join(' ').includes('4G'), '建议应给出具体数值');
});

t('diagnose：Xmx 合理（4G/16G）不触发 overcommit', () => {
  const d = perf.diagnose({ totalGB: 16, xmxMB: 4096 });
  assert.strictEqual(d.findings.some((x) => x.id === 'mem-overcommit'), false);
});

t('diagnose：堆峰值逼近上限 → mem-undercommit', () => {
  const log = '[x][gc] GC(1) Pause Young 3500M->3200M(3800M) 10.0ms';
  const d = perf.diagnose({ logText: log, xmxMB: 4000 });
  assert.ok(d.findings.some((x) => x.id === 'mem-undercommit'), '应有 undercommit');
});

t('diagnose：2 核 → low-cores', () => {
  const d = perf.diagnose({ cpuCores: 2 });
  assert.ok(d.findings.some((x) => x.id === 'low-cores'));
});

t('diagnose：8 核不触发 low-cores', () => {
  const d = perf.diagnose({ cpuCores: 8 });
  assert.strictEqual(d.findings.some((x) => x.id === 'low-cores'), false);
});

/* ---------------- 排序与评分 ---------------- */
t('diagnose：findings 按严重度排序（fatal 在前）', () => {
  const d = perf.diagnose({
    logText: 'java.lang.OutOfMemoryError: Java heap space',
    entityMax: 100
  });
  assert.strictEqual(d.findings[0].severity, 'fatal', '首条应为 fatal');
  const order = { fatal: 0, error: 1, warn: 2, info: 3 };
  for (let i = 1; i < d.findings.length; i++) {
    assert.ok(order[d.findings[i - 1].severity] <= order[d.findings[i].severity], '排序应单调');
  }
});

t('diagnose：无问题 → 100 分 good', () => {
  const d = perf.diagnose({});
  assert.strictEqual(d.score, 100);
  assert.strictEqual(d.grade, 'good');
  assert.strictEqual(d.findings.length, 0);
});

t('diagnose：评分为 0..100 之间', () => {
  const d = perf.diagnose({
    logText: 'java.lang.OutOfMemoryError\nCan\'t keep up! Running 3000ms behind',
    entityMax: 500, containerCount: 9000, totalGB: 4, xmxMB: 16384, cpuCores: 1
  });
  assert.ok(d.score >= 0 && d.score <= 100, 'score=' + d.score);
  // 问题叠满 → 应落到最低档 bad
  assert.strictEqual(d.grade, 'bad');
  assert.ok(d.findings.length >= 5, '应命中多条规则，实际 ' + d.findings.length);
});

t('diagnose：summary 人话包含问题数量', () => {
  const d = perf.diagnose({ entityMax: 100 });
  assert.ok(d.summary.includes('1') || d.summary.includes('发现'), d.summary);
});

t('diagnose：规则里的 when 抛异常不会带崩整个诊断', () => {
  // 传入畸形 ctx（字符串），不应抛
  const d = perf.diagnose({ entityMax: 'abc', totalGB: {}, cpuCores: [] });
  assert.ok(Array.isArray(d.findings));
});

/* ---------------- parseJvmArgs ---------------- */
t('parseJvmArgs：抽 -Xmx / -Xms / GC', () => {
  const log = '[11:00:00] [main/INFO]: Command line: javaw -Xmx4G -Xms2G -XX:+UseG1GC -cp ...';
  const r = perf.parseJvmArgs(log);
  assert.strictEqual(r.xmxMB, 4096);
  assert.strictEqual(r.xmsMB, 2048);
  assert.strictEqual(r.gc, 'G1');
});

t('parseJvmArgs：ZGC 识别', () => {
  const r = perf.parseJvmArgs('javaw -Xmx8G -XX:+UseZGC');
  assert.strictEqual(r.gc, 'ZGC');
  assert.strictEqual(r.xmxMB, 8192);
});

t('parseJvmArgs：MB 单位', () => {
  const r = perf.parseJvmArgs('java -Xmx2048M');
  assert.strictEqual(r.xmxMB, 2048);
});

t('parseJvmArgs：无参数返回零值', () => {
  const r = perf.parseJvmArgs('nothing here');
  assert.strictEqual(r.xmxMB, 0);
  assert.strictEqual(r.gc, null);
  assert.strictEqual(r.raw, null);
});

t('parseJvmArgs：只扫前 200 行（后面的参数不算数）', () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push('filler ' + i);
  lines.push('javaw -Xmx16G');
  const r = perf.parseJvmArgs(lines.join('\n'));
  assert.strictEqual(r.xmxMB, 0, '第 301 行的参数不该被读到');
});

/* ---------------- systemProfile ---------------- */
t('systemProfile：返回合理结构', () => {
  const p = perf.systemProfile();
  assert.ok(p.totalGB > 0, 'physical mem');
  assert.ok(p.cpuCores > 0, 'cpu cores');
  assert.ok(typeof p.cpuModel === 'string');
  assert.ok(p.platform.includes('/'));
});

console.log('===============');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
