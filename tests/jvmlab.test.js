// jvmlab 离线测试：预设准入、GC 日志解析、阶段识别 / 就绪判定、A/B 对比、探针全流程
// 联网/真开游戏的部分不在单测里跑（端到端交给 smoke）
const { EventEmitter } = require('events');
const lab = require('../jvmlab');

let fail = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (extra ? ' -> ' + extra : ''));
  if (!ok) fail++;
}
function eq(name, got, want) {
  check(name + ' (=' + JSON.stringify(want) + ')', JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) === JSON.stringify(want) ? '' : 'got=' + JSON.stringify(got));
}

console.log('=== 内存建议 ===');
eq('8G 机器推荐 4G', lab.recommendMem(8).gb, 4);
eq('16G 机器推荐 8G', lab.recommendMem(16).gb, 8);
eq('64G 机器封顶 12G', lab.recommendMem(64).gb, 12);
eq('2G 机器保底 2G', lab.recommendMem(2).gb, 2);
eq('saneMax 取物理内存一半', lab.saneMax(16), 8);
eq('saneMax 至少 2G', lab.saneMax(1), 2);

console.log('\n=== 预设准入 ===');
const p8 = lab.usablePresets(8);
const p21 = lab.usablePresets(21);
check('ZGC 在 Java 8 被标为不支持', p8.find(p => p.id === 'zgc').supported === false);
check('ZGC 在 Java 21 可用', p21.find(p => p.id === 'zgc').supported === true);
check('Java 21 的 ZGC 带分代参数', lab.presetArgs('zgc', 21).indexOf('ZGenerational') > 0, lab.presetArgs('zgc', 21));
check('Java 17 的 ZGC 不带分代参数', lab.presetArgs('zgc', 17).indexOf('ZGenerational') < 0, lab.presetArgs('zgc', 17));
check('不支持的预设返回 null', lab.presetArgs('zgc', 8) === null);
check('不存在的预设返回 null', lab.presetArgs('nope', 21) === null);
check('所有预设都至少要在某个版本可用', p21.every(p => p.supported || p.minJava > 21));

console.log('\n=== GC 日志参数 ===');
check('Java 9+ 用 -Xlog', lab.gcLogArgs(17, 'pl-gc.log')[0].indexOf('-Xlog:gc*:file=pl-gc.log') === 0, lab.gcLogArgs(17, 'pl-gc.log')[0]);
check('GC 日志路径必须相对（避开 Windows 盘符冒号）', /^[-A-Za-z0-9._]+\.log$/.test('pl-gc.log'));
check('Java 8 用 -verbose:gc', lab.gcLogArgs(8, 'a.log').indexOf('-verbose:gc') === 0);
const built = lab.buildBenchArgs({ presetId: 'g1-balanced', javaMajor: 17, gcLogName: 'x.log' });
check('组装结果含预设参数', built.args.some(a => a === '-XX:+UseG1GC'));
check('组装结果含 GC 日志参数', built.args.some(a => a.indexOf('-Xlog:gc*:file=x.log') === 0));
check('不支持的组合返回 null', lab.buildBenchArgs({ presetId: 'zgc', javaMajor: 8 }) === null);

console.log('\n=== GC 日志解析（Java 9+ -Xlog） ===');
const XLOG = [
  '[2026-09-19T10:00:00.123+0800][0.216s][info][gc] Using G1',
  '[2026-09-19T10:00:01.123+0800][1.216s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(1024M) 3.456ms',
  '[2026-09-19T10:00:02.123+0800][2.216s][info][gc] GC(1) Pause Young (Prepare Mixed) (G1 Evacuation Pause) 88M->44M(1024M) 12.100ms',
  '[2026-09-19T10:00:03.123+0800][3.216s][info][gc] GC(2) Pause Full (System.gc()) 300M->120M(1024M) 220.500ms',
  '[2026-09-19T10:00:04.123+0800][4.216s][info][gc] Concurrent Mark Cycle'
].join('\n');
const g1 = lab.parseGcLog(XLOG);
eq('识别 3 次停顿', g1.pauseCount, 3);
check('总停顿 236ms 左右', Math.abs(g1.totalPauseMs - 236.056) < 1, g1.totalPauseMs);
check('最长停顿 220.5ms', Math.abs(g1.maxPauseMs - 220.5) < 0.01, g1.maxPauseMs);
check('平均停顿已算', g1.avgPauseMs > 0);
eq('Full GC 计 1 次', g1.fullGcCount, 1);
check('回收量 > 0', g1.reclaimedMB > 0, g1.reclaimedMB);

console.log('\n=== GC 日志解析（Java 8 -Xloggc） ===');
const G8 = [
  '2026-09-19T10:00:00.123+0800: 0.389: [GC pause (G1 Evacuation Pause) (young), 0.0134567 secs]',
  '2026-09-19T10:00:01.123+0800: 1.402: [GC pause (G1 Evacuation Pause) (young) 45M->12M(1024M), 0.0234567 secs]',
  '2026-09-19T10:00:02.123+0800: 2.402: [Full GC (System.gc())  300M->120M(1024M), 0.5234567 secs]'
].join('\n');
const g2 = lab.parseGcLog(G8);
eq('Java8 识别 3 次停顿', g2.pauseCount, 3);
check('Java8 总停顿约 560ms', Math.abs(g2.totalPauseMs - 560.37) < 1, g2.totalPauseMs);
eq('Java8 Full GC 计 1 次', g2.fullGcCount, 1);
eq('空日志不炸', lab.parseGcLog('').pauseCount, 0);
eq('纯噪声不误判', lab.parseGcLog('hello world\n某某输出').pauseCount, 0);

console.log('\n=== 阶段识别与就绪判定 ===');
check('资源重载行能命中', lab.matchPhases('[Render thread/INFO]: Reloading ResourceManager: main').indexOf('resource') >= 0);
check('OpenAL 行能命中 audio', lab.matchPhases('OpenAL initialized on device 扬声器').indexOf('audio') >= 0);
check('普通行不命中 audio', lab.matchPhases('Setting user: Steve').indexOf('audio') < 0);

const tl = [
  { t: 100, line: 'Setting user: Steve' },
  { t: 1200, line: 'Backend library: LWJGL version 3.3.3' },
  { t: 5400, line: 'Reloading ResourceManager: main' },
  { t: 6100, line: 'OpenAL initialized on device 扬声器' },
  { t: 6400, line: 'Created: 256x256 textures-atlas' }
];
const mA = lab.measure(tl, { quietMs: 6000, nowMs: 12400 });
eq('就绪时间锚在最后一行', mA.readyMs, 6400);
eq('资源阶段时间', mA.resourceMs, 5400);
eq('音频阶段时间', mA.audioMs, 6100);
eq('阶段标记为 ready', mA.phase, 'ready');
const mB = lab.measure(tl, { quietMs: 6000, nowMs: 10000 });
check('静默不够不算就绪', mB.readyMs === null, JSON.stringify(mB));
eq('静默不够时阶段为 audio', mB.phase, 'audio');
const mC = lab.measure(tl.slice(0, 3), { quietMs: 6000, nowMs: 20000 });
eq('没有音频阶段也能就绪（只用 resource 锚点）', mC.readyMs, 5400);
const mD = lab.measure([], { quietMs: 1000, nowMs: 5000 });
eq('空日志不就绪', mD.readyMs, null);
check('空日志也没崩出数字', mD.firstMs === null && mD.phase === 'idle');

console.log('\n=== 聚合与对比 ===');
eq('奇数取中位数', lab.median([5, 1, 3]), 3);
eq('偶数取中间平均', lab.median([1, 3, 5, 7]), 4);
eq('空数组返回 null', lab.median([]), null);
check('过滤非数字', lab.median([1, null, 3, undefined, 5]) === 3);
const aggA = lab.aggregate([
  { readyMs: 10000, totalPauseMs: 200, maxPauseMs: 50, pauseCount: 40, peakMemMB: 3000 },
  { readyMs: 12000, totalPauseMs: 300, maxPauseMs: 70, pauseCount: 60, peakMemMB: 3200 }
]);
const aggB = lab.aggregate([
  { readyMs: 8000, totalPauseMs: 400, maxPauseMs: 90, pauseCount: 30, peakMemMB: 3400 }
]);
eq('聚合取中位数', aggA.readyMs, 11000);
eq('聚合跑数', aggA.runs, 2);
const cmp = lab.compare(aggA, aggB);
eq('就绪：B 更快', cmp[0].winner, 'b');
eq('GC 总计：A 更少', cmp[1].winner, 'a');
check('缺少数据标 na', lab.compare({ readyMs: null }, { readyMs: 1 })[0].winner === 'na');
check('3% 以内算持平', lab.compare({ readyMs: 10000 }, { readyMs: 10100 })[0].winner === 'tie');
check('结论是一句人话', typeof lab.verdict(cmp, 'A', 'B') === 'string' && lab.verdict(cmp, 'A', 'B').length > 4, lab.verdict(cmp, 'A', 'B'));

console.log('\n=== 探针（假子进程） ===');
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // 场景一：正常跑到主菜单后被自动关闭
  const c1 = fakeChild();
  let killed = 0;
  const probe1 = lab.attachProbe(c1, {
    pid: 12345, gameDir: 'C:/fake', gcLogName: 'gc.log', presetId: 'g1-balanced',
    version: '1.20.1', memMB: 4096, javaMajor: 17,
    quietMs: 150, holdMs: 40, pollMs: 20, autoClose: true, save: false,
    readGc: () => XLOG,
    rss: () => 3000 * 1048576,
    kill: () => { killed++; }
  });
  c1.stdout.emit('data', 'Setting user: Steve\n');
  c1.stdout.emit('data', 'Reloading ResourceManager: main\n');
  c1.stdout.emit('data', 'OpenAL initialized on device X\n');
  c1.stdout.emit('data', 'Created: 256x256 textures-atlas\n');
  const run1 = await probe1.promise;
  check('正常跑：判定为成功', run1.ok === true, JSON.stringify(run1));
  // 假进程的行是一瞬间喂进去的，readyMs 可能是 0 —— 这里只要求「有数且非负」
  check('正常跑：有就绪时间', typeof run1.readyMs === 'number' && run1.readyMs >= 0, run1.readyMs);
  check('正常跑：峰值内存被采到', run1.peakMemMB === 3000, run1.peakMemMB);
  check('正常跑：GC 数据来自注入的日志', run1.pauseCount === 3, run1.pauseCount);
  eq('正常跑：自动关闭理由', run1.reason, 'ready-closed');
  eq('正常跑：kill 被调用一次', killed, 1);
  eq('正常跑：预设 id 落进结果', run1.presetId, 'g1-balanced');

  // 场景二：进程提前退出（崩了 / 用户关了）
  const c2 = fakeChild();
  const probe2 = lab.attachProbe(c2, {
    pid: 222, gameDir: 'C:/fake', gcLogName: 'gc.log', presetId: 'zgc',
    version: '1.20.1', memMB: 4096, javaMajor: 21,
    quietMs: 60000, pollMs: 20, save: false, readGc: () => '', rss: () => 0, kill: () => {}
  });
  c2.stdout.emit('data', 'Exception in thread "main" java.lang.RuntimeException\n');
  setTimeout(() => c2.emit('close', 1), 40);
  const run2 = await probe2.promise;
  check('提前退出：不计成功', run2.ok === false);
  eq('提前退出：理由为 exited', run2.reason, 'exited');
  check('提前退出：留了最后一行供诊断', String(run2.lastLine).indexOf('RuntimeException') > 0, run2.lastLine);

  // 场景三：autoClose=false —— 就绪后立即收探针，不杀进程
  const c3 = fakeChild();
  let killed3 = 0;
  const probe3 = lab.attachProbe(c3, {
    pid: 333, gameDir: 'C:/fake', gcLogName: 'gc.log', presetId: 'default',
    version: '1.20.1', memMB: 4096, javaMajor: 17,
    quietMs: 100, pollMs: 20, autoClose: false, save: false,
    readGc: () => '', rss: () => 0, kill: () => { killed3++; }
  });
  c3.stdout.emit('data', 'Reloading ResourceManager: main\n');
  c3.stdout.emit('data', 'OpenAL initialized\n');
  await sleep(260);
  const run3 = await probe3.promise;
  eq('手动模式：不杀进程', killed3, 0);
  eq('手动模式：理由是 ready-manual', run3.reason, 'ready-manual');
  check('手动模式：就绪时间已算出来', typeof run3.readyMs === 'number', run3.readyMs);

  console.log('\n' + (fail === 0 ? '★ jvmlab 全部通过' : `★ jvmlab 有 ${fail} 项失败`));
  process.exit(fail === 0 ? 0 : 1);
})();
