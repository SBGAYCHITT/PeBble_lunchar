// livemetrics.js 单元测试（纯 Node，不依赖 Electron）
const assert = require('assert');
const lm = require('../livemetrics');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('livemetrics.test');
console.log('=================');

/* ---------------- SPEC ---------------- */
t('SPEC：协议里声明了文件名与全部字段', () => {
  assert.strictEqual(lm.SPEC.fileName, 'pebble-metrics.jsonl');
  assert.ok(lm.SPEC.fields.includes('fps'));
  assert.ok(lm.SPEC.fields.includes('tps'));
  assert.ok(lm.SPEC.fields.includes('mem'));
});

/* ---------------- parseModLine ---------------- */
t('parseModLine：完整行解析出全部字段', () => {
  const r = lm.parseModLine('{"t":1696000000000,"fps":142,"tps":20,"mspt":12.3,"mem":1000,"memMax":4096,"entities":1234,"chunks":441,"players":1,"dim":"overworld"}');
  assert.strictEqual(r.t, 1696000000000);
  assert.strictEqual(r.fps, 142);
  assert.strictEqual(r.tps, 20);
  assert.strictEqual(r.mspt, 12.3);
  assert.strictEqual(r.entities, 1234);
  assert.strictEqual(r.chunks, 441);
  assert.strictEqual(r.dim, 'overworld');
});
t('parseModLine：缺失字段补 null 而不是 undefined', () => {
  const r = lm.parseModLine('{"t":1,"fps":60}');
  assert.strictEqual(r.fps, 60);
  assert.strictEqual(r.tps, null);
  assert.strictEqual(r.entities, null);
  assert.strictEqual(r.dim, null);
});
t('parseModLine：数字字符串会被转成数值', () => {
  const r = lm.parseModLine('{"t":1,"fps":"60"}');
  assert.strictEqual(r.fps, 60);
});
t('parseModLine：NaN / 非数字字段归 null', () => {
  const r = lm.parseModLine('{"t":1,"fps":"abc","tps":null,"mem":{}}');
  assert.strictEqual(r.fps, null);
  assert.strictEqual(r.tps, null);
  assert.strictEqual(r.mem, null);
});
t('parseModLine：忽略未知字段', () => {
  const r = lm.parseModLine('{"t":1,"fps":60,"weird":true}');
  assert.strictEqual(r.fps, 60);
  assert.strictEqual(r.weird, undefined);
});
t('parseModLine：非 JSON 行返回 null', () => {
  assert.strictEqual(lm.parseModLine('hello world'), null);
  assert.strictEqual(lm.parseModLine('{ not json'), null);
});
t('parseModLine：空行 / null / 非字符串返回 null', () => {
  assert.strictEqual(lm.parseModLine(''), null);
  assert.strictEqual(lm.parseModLine('   '), null);
  assert.strictEqual(lm.parseModLine(null), null);
  assert.strictEqual(lm.parseModLine(42), null);
});
t('parseModLine：JSON 数组返回 null', () => {
  assert.strictEqual(lm.parseModLine('[1,2,3]'), null);
});
t('parseModLine：完全没有可用指标的行返回 null', () => {
  assert.strictEqual(lm.parseModLine('{"foo":"bar"}'), null);
});

/* ---------------- parseLogChunk：卡顿 ---------------- */
t('parseLogChunk：简洁句式（只有 ms）', () => {
  const r = lm.parseLogChunk("  [11:00:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2500ms behind");
  assert.strictEqual(r.lag.length, 1);
  assert.strictEqual(r.lag[0].ms, 2500);
  assert.strictEqual(r.lag[0].ticks, null);
});
t('parseLogChunk：完整句式（ms + ticks）', () => {
  const r = lm.parseLogChunk("Can't keep up! Is the server overloaded? Running 2500ms or 50 ticks behind");
  assert.strictEqual(r.lag.length, 1);
  assert.strictEqual(r.lag[0].ms, 2500);
  assert.strictEqual(r.lag[0].ticks, 50);
});
t('parseLogChunk：单数 tick 也能解析', () => {
  const r = lm.parseLogChunk("Can't keep up! Running 60ms or 1 tick behind");
  assert.strictEqual(r.lag[0].ticks, 1);
});
t('parseLogChunk：带 ISO 时间戳的行能解析出时间', () => {
  const r = lm.parseLogChunk("[2026-10-02T11:00:00.100+0800] [Server thread/WARN]: Can't keep up! Running 100ms behind");
  assert.strictEqual(r.lag.length, 1);
  assert.ok(Number.isFinite(r.lag[0].t));
});
t('parseLogChunk：多行里挑出多条卡顿记录', () => {
  const text = [
    "[2026-10-02T11:00:00+0800] Can't keep up! Running 100ms or 2 ticks behind",
    'some unrelated log line',
    "[2026-10-02T11:00:10+0800] Can't keep up! Running 300ms or 6 ticks behind"
  ].join('\n');
  assert.strictEqual(lm.parseLogChunk(text).lag.length, 2);
});
t('parseLogChunk：提到 Can\'t keep up 但没有可解析数字时不误报', () => {
  assert.strictEqual(lm.parseLogChunk("Can't keep up! but no numbers here").lag.length, 0);
});

/* ---------------- parseLogChunk：GC ---------------- */
t('parseLogChunk：Java 9+ 统一 GC 日志解析出堆用量', () => {
  const r = lm.parseLogChunk('[2026-10-02T11:00:00.100+0800][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 512M->128M(2048M) 12.345ms');
  assert.strictEqual(r.gc.length, 1);
  assert.strictEqual(r.gc[0].used, 128 * 1024 * 1024);
  assert.strictEqual(r.gc[0].max, 2048 * 1024 * 1024);
});
t('parseLogChunk：没有堆用量数字的 GC 行不产生样本', () => {
  const r = lm.parseLogChunk('[info][gc] GC(3) Pause Full (G1 Compaction Pause) 12.3ms');
  assert.strictEqual(r.gc.length, 0);
});
t('parseLogChunk：卡顿与 GC 可同时出现在一段文本里', () => {
  const text = [
    "Can't keep up! Running 500ms or 10 ticks behind",
    '[info][gc] GC(2) Pause Young 512M->128M(2048M) 8.0ms'
  ].join('\n');
  const r = lm.parseLogChunk(text);
  assert.strictEqual(r.lag.length, 1);
  assert.strictEqual(r.gc.length, 1);
});
t('parseLogChunk：空输入 / null 不抛异常', () => {
  assert.deepStrictEqual(lm.parseLogChunk('').lag, []);
  assert.deepStrictEqual(lm.parseLogChunk(null).lag, []);
});
t('parseLogChunk：无关内容不会产生任何样本', () => {
  const r = lm.parseLogChunk('Preparing spawn area: 12%\nTime elapsed: 300 ms\nDone (12.5s)!');
  assert.strictEqual(r.lag.length, 0);
  assert.strictEqual(r.gc.length, 0);
});

/* ---------------- lagHealth ---------------- */
t('lagHealth：没有卡顿记录给满分', () => {
  const r = lm.lagHealth([]);
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.grade, 'good');
  assert.strictEqual(r.count, 0);
});
t('lagHealth：严重且频繁的卡顿分数很低', () => {
  const lag = [];
  for (let i = 0; i < 200; i++) lag.push({ ms: 4000 });
  const r = lm.lagHealth(lag, { spanMs: 600000 }); // 10 分钟内 200 次
  assert.ok(r.score < 40, '分数应很低，实际 ' + r.score);
  assert.strictEqual(r.grade, 'bad');
});
t('lagHealth：偶发轻微卡顿分数较高', () => {
  const r = lm.lagHealth([{ ms: 60 }], { spanMs: 3600000 });
  assert.ok(r.score >= 70, '分数应较高，实际 ' + r.score);
});
t('lagHealth：报告最差与平均', () => {
  const r = lm.lagHealth([{ ms: 100 }, { ms: 900 }, { ms: 200 }]);
  assert.strictEqual(r.worstMs, 900);
  assert.strictEqual(r.avgMs, 400);
  assert.strictEqual(r.count, 3);
});
t('lagHealth：没有时间跨度时不报频率', () => {
  assert.strictEqual(lm.lagHealth([{ ms: 100 }]).eventsPerHour, null);
});
t('lagHealth：给时间跨度就算出每小时次数', () => {
  const r = lm.lagHealth([{ ms: 100 }, { ms: 100 }], { spanMs: 3600000 });
  assert.strictEqual(r.eventsPerHour, 2);
});
t('lagHealth：忽略无效条目', () => {
  const r = lm.lagHealth([{ ms: 100 }, null, { ms: 'x' }, {}]);
  assert.strictEqual(r.count, 1);
});
t('lagHealth：非数组输入不抛异常', () => {
  assert.strictEqual(lm.lagHealth(null).score, 100);
});
t('lagHealth：分数始终落在 0..100', () => {
  const a = lm.lagHealth(new Array(5000).fill({ ms: 99000 }), { spanMs: 1000 });
  assert.ok(a.score >= 0 && a.score <= 100);
});

/* ---------------- MetricsBuffer ---------------- */
function mkBuf(n, cap) {
  let clock = 1000;
  const b = new lm.MetricsBuffer({ capacity: cap || 100, now: () => clock++ });
  for (let i = 0; i < n; i++) b.push({ t: 1000 + i * 1000, fps: 60 + i, tps: 20 });
  return b;
}

t('MetricsBuffer：push 后 size 增长', () => {
  const b = mkBuf(5);
  assert.strictEqual(b.size, 5);
});
t('MetricsBuffer：超过容量时丢弃最旧的并计数', () => {
  const b = mkBuf(10, 4);
  assert.strictEqual(b.size, 4);
  assert.strictEqual(b.dropped, 6);
  assert.strictEqual(b.all()[0].fps, 66, '应保留最新 4 个');
});
t('MetricsBuffer：缺 t 时用注入的时钟补', () => {
  const b = new lm.MetricsBuffer({ now: () => 777 });
  const s = b.push({ fps: 30 });
  assert.strictEqual(s.t, 777);
});
t('MetricsBuffer：无效字段存成 null', () => {
  const b = new lm.MetricsBuffer({ now: () => 1 });
  const s = b.push({ fps: 'x', tps: 20 });
  assert.strictEqual(s.fps, null);
  assert.strictEqual(s.tps, 20);
});
t('MetricsBuffer：push 非对象返回 null 且不改变 size', () => {
  const b = new lm.MetricsBuffer();
  assert.strictEqual(b.push(null), null);
  assert.strictEqual(b.push('x'), null);
  assert.strictEqual(b.size, 0);
});
t('MetricsBuffer：last 返回最新样本', () => {
  assert.strictEqual(mkBuf(3).last().fps, 62);
});
t('MetricsBuffer：空缓冲 last 为 null', () => {
  assert.strictEqual(new lm.MetricsBuffer().last(), null);
});
t('MetricsBuffer：clear 清空并重置计数', () => {
  const b = mkBuf(10, 3);
  b.clear();
  assert.strictEqual(b.size, 0);
  assert.strictEqual(b.dropped, 0);
});
t('MetricsBuffer：window 只取时间窗内', () => {
  const b = mkBuf(10);
  const w = b.window(3000); // 最后一条 t=10000 → 取 t>=7000
  assert.ok(w.length >= 3);
  assert.ok(w.every(s => s.t >= 7000));
});
t('MetricsBuffer：window 参数非法时返回全部', () => {
  const b = mkBuf(5);
  assert.strictEqual(b.window(0).length, 5);
  assert.strictEqual(b.window(null).length, 5);
});
t('MetricsBuffer：series 输出 {t,v} 序列', () => {
  const s = mkBuf(4).series('fps');
  assert.strictEqual(s.length, 4);
  assert.strictEqual(s[0].v, 60);
  assert.ok(Number.isFinite(s[0].t));
});
t('MetricsBuffer：series 跳过该指标为 null 的样本', () => {
  const b = new lm.MetricsBuffer({ now: () => 1 });
  b.push({ t: 1, fps: 60 });
  b.push({ t: 2, tps: 20 });
  assert.strictEqual(b.series('fps').length, 1);
});
t('MetricsBuffer：series 按 maxPoints 降采样', () => {
  const b = mkBuf(1000);
  const s = b.series('fps', { maxPoints: 50 });
  assert.ok(s.length <= 50);
  assert.ok(s.length > 10);
});
t('MetricsBuffer：maxPoints 大于点数时原样返回', () => {
  assert.strictEqual(mkBuf(10).series('fps', { maxPoints: 100 }).length, 10);
});
t('MetricsBuffer：summary 给出统计量', () => {
  const s = mkBuf(5).summary('fps'); // 60,61,62,63,64
  assert.strictEqual(s.count, 5);
  assert.strictEqual(s.min, 60);
  assert.strictEqual(s.max, 64);
  assert.strictEqual(s.avg, 62);
});
t('MetricsBuffer：summary.last 是最新读数而非最大值', () => {
  const b = new lm.MetricsBuffer({ now: () => 1 });
  b.push({ t: 1, fps: 100 });
  b.push({ t: 2, fps: 20 });
  assert.strictEqual(b.summary('fps').last, 20);
  assert.strictEqual(b.summary('fps').max, 100);
});
t('MetricsBuffer：summary 空缓冲返回 null 统计', () => {
  const s = new lm.MetricsBuffer().summary('fps');
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.avg, null);
});

/* ---------------- summarize ---------------- */
t('summarize：空数组返回零值', () => {
  const s = lm.summarize([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.min, null);
});
t('summarize：忽略非数值', () => {
  const s = lm.summarize([1, null, 'x', 3, NaN, undefined]);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.min, 1);
  assert.strictEqual(s.max, 3);
});
t('summarize：p95 取靠上分位', () => {
  const vals = [];
  for (let i = 1; i <= 100; i++) vals.push(i);
  const s = lm.summarize(vals);
  assert.strictEqual(s.p95, 95);
});
t('summarize：非数组不抛异常', () => {
  assert.strictEqual(lm.summarize(null).count, 0);
});

/* ---------------- downsample ---------------- */
t('downsample：点数少于上限时原样返回', () => {
  const pts = [{ t: 1, v: 1 }, { t: 2, v: 2 }];
  assert.strictEqual(lm.downsample(pts, 10).length, 2);
});
t('downsample：压缩到上限以内', () => {
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push({ t: i * 100, v: i });
  assert.ok(lm.downsample(pts, 20).length <= 20);
});
t('downsample：桶内取均值', () => {
  const pts = [{ t: 0, v: 10 }, { t: 10, v: 20 }, { t: 20, v: 30 }, { t: 30, v: 40 }];
  const out = lm.downsample(pts, 2);
  assert.strictEqual(out.length, 2);
  assert.ok(out[0].v > 0);
});
t('downsample：所有 t 相同时不抛异常', () => {
  const pts = [{ t: 5, v: 1 }, { t: 5, v: 2 }, { t: 5, v: 3 }];
  assert.ok(Array.isArray(lm.downsample(pts, 2)));
});
t('downsample：空数组返回空数组', () => {
  assert.deepStrictEqual(lm.downsample([], 10), []);
});

/* ---------------- verdict ---------------- */
t('verdict：TPS 过低报 error', () => {
  const v = lm.verdict({ tps: { avg: 12 }, hasMod: true });
  assert.strictEqual(v.level, 'error');
  assert.ok(v.title.includes('tick'));
});
t('verdict：FPS 偏低报 warn', () => {
  const v = lm.verdict({ fps: { avg: 25 }, tps: { avg: 20 }, hasMod: true, lagHealth: { score: 100 } });
  assert.strictEqual(v.level, 'warn');
  assert.ok(v.title.includes('帧率'));
});
t('verdict：卡顿健康度低报 warn', () => {
  const v = lm.verdict({ fps: { avg: 120 }, tps: { avg: 20 }, lagHealth: { score: 40, count: 9, worstMs: 4000 } });
  assert.strictEqual(v.level, 'warn');
  assert.ok(v.title.includes('卡顿'));
});
t('verdict：没有 Mod 数据时说明只能看日志', () => {
  const v = lm.verdict({ lagHealth: { score: 100 } });
  assert.strictEqual(v.level, 'info');
  assert.ok(v.detail.includes('伴随 Mod'));
});
t('verdict：一切正常报 good', () => {
  const v = lm.verdict({ fps: { avg: 120 }, tps: { avg: 20 }, lagHealth: { score: 100 }, hasMod: true });
  assert.strictEqual(v.level, 'good');
});
t('verdict：空输入不抛异常', () => {
  assert.ok(typeof lm.verdict(null).title === 'string');
});

console.log('=================');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
