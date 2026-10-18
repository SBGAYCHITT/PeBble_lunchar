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

/* ================================================================
 * V5 第三组：帧时间分布 / 卡顿归因 / 会话对比
 * ================================================================ */

/** 造一行带 ISO 时间戳的日志（UTC，避免本地时区影响断言） */
function tsAt(sec) {
  const t = new Date(Date.UTC(2026, 9, 2, 3, 0, 0) + sec * 1000);
  return '[' + t.toISOString().replace('Z', '+0000') + ']';
}
function gcLine(sec, ms) {
  return `${tsAt(sec)}[info][gc] GC(1) Pause Young (Normal) 512M->128M(2048M) ${ms.toFixed(3)}ms`;
}
function stutterLine(sec, ms) {
  return `${tsAt(sec)} [Server thread/WARN]: Can't keep up! Is the server overloaded? Running ${ms}ms or ${Math.floor(ms / 50)} ticks behind`;
}

/* ---------------- frameStats ---------------- */
t('frameStats：没有样本时 available=false 且分位数为 null', () => {
  const r = perf.frameStats([]);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.resolution, 'none');
  assert.strictEqual(r.p50, null);
  assert.strictEqual(r.p99, null);
  assert.ok(r.caveat.length > 0, '要给出为什么没有数据');
});

t('frameStats：只有 fps → 标记为"每秒均值推算"（derived）', () => {
  const r = perf.frameStats([{ t: 1, fps: 100 }, { t: 2, fps: 50 }]);
  assert.strictEqual(r.resolution, 'second');
  assert.strictEqual(r.derived, true, '必须承认这是反推的');
  assert.strictEqual(r.longBasis, 'second');
  assert.strictEqual(r.percentileBasis, 'second');
  assert.strictEqual(r.p50, 15, '[10,20] 的中位数');
  assert.strictEqual(r.longCount, 0);
});

t('frameStats：frameTimes → 逐帧分位数（不是推算）', () => {
  const r = perf.frameStats([{ t: 1, frameTimes: [16, 17, 500] }]);
  assert.strictEqual(r.resolution, 'frame');
  assert.strictEqual(r.derived, false);
  assert.strictEqual(r.count, 3);
  assert.ok(r.p99 > 400, 'P99 必须反映那根 500ms 的长帧，实际 ' + r.p99);
  assert.strictEqual(r.max, 500);
});

t('frameStats：frames + longFrames → 长帧占比精确', () => {
  const r = perf.frameStats([
    { t: 1, frames: 120, longFrames: 3 },
    { t: 2, frames: 120, longFrames: 1 }
  ]);
  assert.strictEqual(r.resolution, 'frame-aggregate');
  assert.strictEqual(r.longBasis, 'frame');
  assert.strictEqual(r.longCount, 4);
  assert.strictEqual(r.longRatio, Math.round((4 / 240) * 10000) / 10000, '占比按 4 位小数收敛');
});

t('frameStats：longFrames 超过 frames 时被夹紧（脏数据不放大占比）', () => {
  const r = perf.frameStats([{ t: 1, frames: 10, longFrames: 999 }]);
  assert.strictEqual(r.longRatio, 1);
  assert.ok(r.longRatio <= 1);
});

t('frameStats：直方图比例之和为 1', () => {
  const r = perf.frameStats([{ t: 1, fps: 144 }, { t: 2, fps: 60 }, { t: 3, fps: 20 }]);
  const sum = r.histogram.reduce((s, h) => s + h.ratio, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, '实际 ' + sum);
});

t('frameStats：负数 / NaN 帧时间被丢弃', () => {
  const r = perf.frameStats([{ t: 1, frameTimes: [-5, NaN, 0, 16.7] }]);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.p50, 16.7);
});

/* ---------------- percentileOf ---------------- */
t('percentileOf：边界与插值', () => {
  const s = [10, 20, 30, 40, 50];
  assert.strictEqual(perf.percentileOf(s, 0), 10);
  assert.strictEqual(perf.percentileOf(s, 1), 50);
  assert.strictEqual(perf.percentileOf(s, 0.5), 30);
  assert.strictEqual(perf.percentileOf([], 0.5), null);
  assert.strictEqual(perf.percentileOf([7], 0.99), 7);
});

/* ---------------- parseLogTimeline ---------------- */
t('parseLogTimeline：抽出 GC / 卡顿 / 区块加载的时间轴', () => {
  const log = [
    gcLine(0, 30),
    stutterLine(1, 800),
    `${tsAt(2)} [Server thread/INFO]: Preparing spawn area: 42%`,
    stutterLine(9, 1200)
  ].join('\n');
  const tl = perf.parseLogTimeline(log);
  assert.strictEqual(tl.ok, true);
  assert.strictEqual(tl.gc.length, 1);
  assert.strictEqual(tl.stutter.length, 2);
  assert.strictEqual(tl.chunk.length, 1);
  assert.strictEqual(tl.spanMs, 9000);
});

t('parseLogTimeline：跨零点的时间戳不会算成负跨度', () => {
  const log = [
    '[23:59:59] [GC (Allocation Failure) 100M->20M(512M), 0.030000 secs]',
    '[00:00:01] [Server thread/WARN]: Can\'t keep up! Is the server overloaded? Running 900ms behind'
  ].join('\n');
  const tl = perf.parseLogTimeline(log);
  assert.strictEqual(tl.spanMs, 2000, '实际 ' + tl.spanMs);
});

t('parseLogTimeline：没有时间戳 → ok=false，事件不进时间轴', () => {
  const tl = perf.parseLogTimeline('Can\'t keep up! Is the server overloaded? Running 900ms behind');
  assert.strictEqual(tl.ok, false);
  assert.strictEqual(tl.stutter.length, 0);
});

/* ---------------- correlateEvents ---------------- */
t('correlateEvents：GC 在卡顿之前才算命中（因果方向不能反）', () => {
  const before = perf.parseLogTimeline([gcLine(9, 200), stutterLine(10, 900)].join('\n'));
  const after = perf.parseLogTimeline([stutterLine(10, 900), gcLine(11, 200)].join('\n'));
  assert.strictEqual(perf.correlateEvents(before, 2000).gcMatched, 1);
  assert.strictEqual(perf.correlateEvents(after, 2000).gcMatched, 0);
});

t('correlateEvents：窗口外不算命中', () => {
  const tl = perf.parseLogTimeline([gcLine(0, 200), stutterLine(10, 900)].join('\n'));
  assert.strictEqual(perf.correlateEvents(tl, 2000).gcMatched, 0);
});

/* ---------------- attributeStutter：有证据才归因 ---------------- */
t('attributeStutter：3/5 次卡顿紧跟在 GC 后 → 高置信归因到 GC', () => {
  const log = [
    gcLine(9.5, 300), stutterLine(10, 1500),
    gcLine(19.5, 280), stutterLine(20, 1400),
    gcLine(29.5, 260), stutterLine(30, 1300),
    stutterLine(40, 400), stutterLine(50, 350)
  ].join('\n');
  const r = perf.attributeStutter({ logText: log });
  const gc = r.causes.find((c) => c.id === 'gc');
  assert.ok(gc, '应该给出 GC 归因');
  assert.strictEqual(gc.confidence, 'high');
  assert.strictEqual(gc.basis, 'timeline');
  assert.ok(gc.evidence.includes('3'), '证据里要有具体次数');
});

t('attributeStutter：有 GC 但与卡顿对不上 → 进"未确定"，不给结论', () => {
  const log = [
    gcLine(12, 200), gcLine(22, 200), gcLine(32, 200),
    stutterLine(10, 1500), stutterLine(20, 1400), stutterLine(30, 1300)
  ].join('\n');
  const r = perf.attributeStutter({ logText: log });
  assert.strictEqual(r.causes.filter((c) => c.id === 'gc').length, 0, '不能把同时发生当因果');
  const u = r.undetermined.find((x) => x.id === 'gc');
  assert.ok(u, '要出现在未确定里');
  assert.ok(u.why.length > 0);
});

t('attributeStutter：没有时间戳 + 长停顿 → 低置信，并标明依据只是停顿长度', () => {
  const log = [
    '[GC (Allocation Failure) 100M->20M(512M), 0.300000 secs]',
    'Can\'t keep up! Is the server overloaded? Running 2500ms behind'
  ].join('\n');
  const r = perf.attributeStutter({ logText: log });
  const gc = r.causes.find((c) => c.id === 'gc');
  assert.ok(gc);
  assert.strictEqual(gc.confidence, 'low');
  assert.strictEqual(gc.basis, 'log');
});

t('attributeStutter：实体热点是静态证据 → 只进"未确定"，不进结论', () => {
  const log = [stutterLine(1, 900), stutterLine(2, 800)].join('\n');
  const r = perf.attributeStutter({ logText: log, entityMax: 80 });
  assert.strictEqual(r.causes.filter((c) => c.id === 'entities').length, 0);
  const u = r.undetermined.find((x) => x.id === 'entities');
  assert.ok(u);
  assert.ok(u.why.includes('80'), '要写出实际观测值');
});

t('attributeStutter：OOM 是硬证据，直接高置信', () => {
  const r = perf.attributeStutter({ logText: 'java.lang.OutOfMemoryError: Java heap space' });
  const oom = r.causes.find((c) => c.id === 'oom');
  assert.ok(oom);
  assert.strictEqual(oom.confidence, 'high');
});

t('attributeStutter：没有卡顿时明确说不需要归因', () => {
  const r = perf.attributeStutter({ logText: gcLine(1, 20) });
  assert.strictEqual(r.stutterCount, 0);
  assert.strictEqual(r.causes.length, 0);
  assert.ok(r.caveats.some((c) => c.includes("Can't keep up")), '要说明日志里没有卡顿记录');
});

/* ---------------- compareSessions ---------------- */
t('compareSessions：帧率变高 / 停顿变短 → 判定为变好', () => {
  const a = perf.summarizeSession({ label: 'A', logText: gcLine(1, 120), samples: [{ t: 1, fps: 60 }] });
  const b = perf.summarizeSession({ label: 'B', logText: gcLine(1, 40), samples: [{ t: 1, fps: 120 }] });
  const r = perf.compareSessions(a, b);
  assert.strictEqual(r.rows.find((x) => x.key === 'avgFps').verdict, 'better');
  assert.strictEqual(r.rows.find((x) => x.key === 'gcMax').verdict, 'better');
  assert.strictEqual(r.overall, 'better');
  assert.ok(r.better >= 2);
});

t('compareSessions：变化小于 2% 算持平（不把噪声当成果）', () => {
  const a = perf.summarizeSession({ label: 'A', logText: gcLine(1, 100) });
  const b = perf.summarizeSession({ label: 'B', logText: gcLine(1, 101) });
  const r = perf.compareSessions(a, b);
  assert.strictEqual(r.rows.find((x) => x.key === 'gcMax').verdict, 'same');
});

t('compareSessions：一侧没有帧样本 → 帧相关行标不可比，并给出说明', () => {
  const a = perf.summarizeSession({ label: 'A', logText: gcLine(1, 100) });
  const b = perf.summarizeSession({ label: 'B', logText: gcLine(1, 50), samples: [{ t: 1, fps: 60 }] });
  const r = perf.compareSessions(a, b);
  assert.strictEqual(r.rows.find((x) => x.key === 'avgFps').verdict, 'na');
  assert.ok(r.caveats.length > 0, '要说明为什么不可比');
});

console.log('===============');
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
