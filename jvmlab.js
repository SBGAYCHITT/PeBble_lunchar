// Pebble Lunchar - JVM A/B 调优实验室
//
// 想解决的问题：「到底该给 MC 配多少内存、用哪个 GC」在网上全是玄学答案。
// 这里把它变成可重复的实测：同一份存档/同一版本，用两套 JVM 参数各跑几次，
// 直接比「到主菜单耗时」「GC 停顿总量」「峰值内存」这三个客观数字。
//
// 难点在于 MC **没有任何一条日志明确表示「主菜单已就绪」**（1.14 之后就没了）。
// 所以就绪判定用「日志静默」：
//   资源重载 → 音频/OpenAL 初始化之后，日志会突然安静下来（此时就是主菜单在等你操作）。
//   最后一行输出之后连续 quietMs（默认 6 秒）没有新输出 → 判定已进入主菜单。
// 这条路���不同版本/加载器都成立，代价是不能秒判 —— 换来的是跨版本可比。
//
// 本文件的核心逻辑全部写成纯函数（parse / match / compare / build*），方便单测；
// 真正碰进程的部分集中在末尾的 probe 里。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let app = null;
try { app = require('electron').app; } catch { /* 纯 Node（单测） */ }

/* ==================================================================
 * 一、预设
 * ================================================================== */
const PRESETS = [
  {
    id: 'default', name: '默认（不动参数）', tag: '基线',
    desc: '只用启动器给的 -Xmx/-Xms，其余交给 JVM 自己选。任何对比都该拿它当参考组。',
    minJava: 0,
    argsFor: () => ''
  },
  {
    id: 'g1-balanced', name: 'G1 平衡', tag: '推荐',
    desc: '限制单次 GC 停顿 50ms 并并行处理引用，综合最稳，适合大多数机器。',
    minJava: 8,
    argsFor: () => '-XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ParallelRefProcEnabled'
  },
  {
    id: 'load-opt', name: '加载优化', tag: '进图快',
    desc: '调大新生代比例、提前触发并发标记，牺牲一点内存换取更短的整段启动时间。',
    minJava: 8,
    argsFor: () => '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=30 ' +
      '-XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 ' +
      '-XX:InitiatingHeapOccupancyPercent=15 -XX:+ParallelRefProcEnabled'
  },
  {
    id: 'lowmem', name: '小内存友好', tag: '≤ 6G',
    desc: '内存紧张时放宽停顿目标、开启字符串去重，宁可多停几次也不让堆爆掉。',
    minJava: 8,
    argsFor: () => '-XX:+UseG1GC -XX:MaxGCPauseMillis=120 -XX:+UseStringDeduplication -XX:G1HeapRegionSize=4M'
  },
  {
    id: 'parallel', name: 'Parallel 高吞吐', tag: '核多',
    desc: '多线程回收，单次停顿更长但总量更小。CPU 核心多、不在意偶发卡顿时可试。',
    minJava: 8,
    // 不写 UseParallelOldGC：JDK 15 起已合并进 UseParallelGC，写出来只会刷 Obsolete 警告
    argsFor: () => '-XX:+UseParallelGC -XX:+AlwaysPreTouch'
  },
  {
    id: 'zgc', name: 'ZGC 极低延迟', tag: 'Java 17+',
    desc: '停顿通常在 1ms 级，玩大型整合包时几乎感觉不到 GC。代价是更高的内存与一点吞吐损失。',
    minJava: 17,
    argsFor: (javaMajor) => javaMajor >= 21 ? '-XX:+UseZGC -XX:+ZGenerational' : '-XX:+UseZGC'
  },
  {
    id: 'aikar', name: 'Aikar 系（客户端改）', tag: '偏激进',
    desc: '服主圈流传的一组参数，这里按客户端调整为偏新生代。整合包玩家值得一试。',
    minJava: 8,
    argsFor: () => '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1HeapWastePercent=5 ' +
      '-XX:MaxGCPauseMillis=40 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 ' +
      '-XX:G1MixedGCLiveThresholdPercent=90 -XX:+ParallelRefProcEnabled'
  }
];

function getPreset(id) { return PRESETS.find(p => p.id === id) || null; }

/** 纯函数：预设 + Java 版本 → 参数串。版本不够就返回 null（UI 要禁用而不是给用户跑挂） */
function presetArgs(id, javaMajor) {
  const p = getPreset(id);
  if (!p) return null;
  const v = parseInt(javaMajor, 10) || 0;
  if (p.minJava && v && v < p.minJava) return null;
  return p.argsFor(v) || '';
}

/** 纯函数：可用预设列表（按 Java 版本过滤，不满足的标 unsupported 而不是隐藏） */
function usablePresets(javaMajor) {
  const v = parseInt(javaMajor, 10) || 0;
  return PRESETS.map(p => ({
    id: p.id, name: p.name, tag: p.tag, desc: p.desc, minJava: p.minJava,
    supported: !p.minJava || !v || v >= p.minJava,
    args: (!p.minJava || !v || v >= p.minJava) ? (p.argsFor(v) || '') : ''
  }));
}

/* ==================================================================
 * 二、内存建议
 * ================================================================== */
// upto 是**闭区间上界**（t <= upto 命中这一档）。写成闭区间是因为 Windows 上报的
// 物理内存通常比标称少一点（16G 机器常见 15.9G），用开区间会把它们挤到下一档去。
const MEM_TABLE = [
  { upto: 4, gb: 2, note: '内存偏小，保守给 2G 并保证后台干净' },
  { upto: 8, gb: 4, note: '4G 足够原版与轻量整合包' },
  { upto: 12, gb: 6, note: '主流配置，中型整合包够用' },
  { upto: 16, gb: 8, note: '8G 是大多数整合包的甜点位' },
  { upto: 24, gb: 8, note: '再多收益很小，别把内存全给 MC' },
  { upto: 32, gb: 10, note: '大型整合包可到 10G' },
  { upto: Infinity, gb: 12, note: '超过 12G 反而更容易被 GC 拖累' }
];

/** 纯函数：按物理内存推荐 -Xmx（GB） */
function recommendMem(totalGB) {
  const t = Number(totalGB) || 0;
  for (const r of MEM_TABLE) if (t <= r.upto) return { gb: r.gb, note: r.note, physicalGB: Math.round(t * 10) / 10 };
  return { gb: 12, note: '', physicalGB: t };
}

/** 客户端给 MC 的内存超过物理内存的一半就没有意义了（系统还要留一半给 OS 与页缓存） */
function saneMax(totalGB) { return Math.max(2, Math.min(16, Math.floor((Number(totalGB) || 0) / 2))); }

/* ==================================================================
 * 三、GC 日志开关
 * ================================================================== */
/**
 * 纯函数：为一次基准跑生成 GC 日志参数。
 * 相对路径是有意的：MC 进程的 cwd 就是 gameDir，写相对路径可以绕开
 * Windows 盘符冒号把 `-Xlog:gc*:file=C:/...` 这种语法切坏的老问题。
 */
function gcLogArgs(javaMajor, fileName) {
  const name = fileName || 'pl-gc.log';
  const v = parseInt(javaMajor, 10) || 0;
  if (v >= 9) return [`-Xlog:gc*:file=${name}:time,uptime`];
  return ['-verbose:gc', '-XX:+PrintGCDetails', '-XX:+PrintGCDateStamps', `-Xloggc:${name}`];
}

/**
 * 纯函数：组装一次基准跑要用的 jvmArgs。
 * @returns {{args:string[]} | null} 预设不被当前 Java 支持时返回 null
 */
function buildBenchArgs(o) {
  const preset = presetArgs(o.presetId, o.javaMajor);
  if (preset === null) return null;
  const out = preset.split(/\s+/).filter(Boolean);
  if (o.gcLog !== false) out.push(...gcLogArgs(o.javaMajor, o.gcLogName));
  if (o.extraArgs) out.push(...String(o.extraArgs).split(/\s+/).filter(Boolean));
  return { args: out };
}

/* ==================================================================
 * 四、GC 日志解析
 * ================================================================== */
const RE_XMLOG_PAUSE = /Pause[\s\S]*?\b(\d+(?:[.,]\d+)?)ms\b/;   // Java 9+: "... Pause Young ... 3.456ms"
const RE_XMLOG_TOTAL = /(\d+(?:[.,]\d+)?)ms\s*$/;
const RE_J8_PAUSE = /\b(\d+(?:\.\d+)?)\s+secs\]/;             // Java 8:  "... , 0.0123456 secs]"
const RE_HEAP_AFTER = /(\d+)([KMG])->(\d+)([KMG])\((\d+)([KMG])\)/;

function unitMB(n, u) {
  const k = { K: 1 / 1024, M: 1, G: 1024 }[u] || 1;
  return Math.round(n * k);
}

/**
 * 纯函数：解析 GC 日志，统计停顿。
 * Java 9+ 的 -Xlog 与 Java 8 的 -Xloggc 两种格式都支持。
 * @returns {{lines:number, pauseCount:number, totalPauseMs:number, maxPauseMs:number, avgPauseMs:number, fullGcCount:number, reclaimedMB:number}}
 */
function parseGcLog(text) {
  const out = { lines: 0, pauseCount: 0, totalPauseMs: 0, maxPauseMs: 0, avgPauseMs: 0, fullGcCount: 0, reclaimedMB: 0 };
  if (!text) return out;
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  out.lines = lines.length;
  let minSeenMs = null;
  for (const line of lines) {
    let ms = null;
    let m = RE_XMLOG_PAUSE.exec(line);
    if (m) ms = parseFloat(m[1].replace(',', '.'));
    if (ms === null) {
      m = RE_XMLOG_TOTAL.exec(line);
      if (m && /Pause|GC\(/.test(line)) ms = parseFloat(m[1].replace(',', '.'));
    }
    if (ms === null) {
      m = RE_J8_PAUSE.exec(line);
      if (m) ms = parseFloat(m[1]) * 1000;
    }
    if (ms === null) continue;
    if (ms < 0.05) continue;                       // 0.0x ms 的日志噪声
    out.pauseCount++;
    out.totalPauseMs += ms;
    if (ms > out.maxPauseMs) out.maxPauseMs = ms;
    if (minSeenMs === null || ms < minSeenMs) minSeenMs = ms;
    const h = RE_HEAP_AFTER.exec(line);
    if (h) out.reclaimedMB += Math.max(0, unitMB(+h[1], h[2]) - unitMB(+h[3], h[4]));
    if (/Pause Full|Full GC|G1 Compaction Pause/i.test(line)) out.fullGcCount++;
  }
  if (out.pauseCount) out.avgPauseMs = Math.round((out.totalPauseMs / out.pauseCount) * 10) / 10;
  out.totalPauseMs = Math.round(out.totalPauseMs * 10) / 10;
  out.maxPauseMs = Math.round(out.maxPauseMs * 10) / 10;
  return out;
}

/* ==================================================================
 * 五、启动阶段识别与「就绪」判定
 * ================================================================== */
const PHASES = [
  { id: 'first', label: 'JVM 首行', test: () => true },
  { id: 'resource', label: '资源重载', test: (l) => /Reloading ResourceManager|Resource reload|Loading [0-9]+ (?:recipes|advancements)/i.test(l) },
  { id: 'audio', label: '音频就绪', test: (l) => /Sound engine|OpenAL/i.test(l) },
  { id: 'world', label: '存档列表', test: (l) => /Loading [0-9]+ worlds|Scanning world/i.test(l) }
];

/** 纯函数：一行日志命中哪些阶段 */
function matchPhases(line) {
  const out = [];
  for (const p of PHASES) {
    try { if (p.test(String(line))) out.push(p.id); } catch { /* 正则写错不算致命 */ }
  }
  return out;
}

/**
 * 纯函数：从时间线算阶段耗时与就绪时间。
 * @param {Array<{t:number, line:string}>} timeline t = 相对启动时刻的毫秒
 * @param {{quietMs?:number, nowMs?:number}} opts
 * @returns {{firstMs, resourceMs, audioMs, readyMs, gapMs, phase:string}}
 */
function measure(timeline, opts) {
  const o = opts || {};
  const quietMs = o.quietMs == null ? 6000 : o.quietMs;
  const nowMs = o.nowMs == null ? (timeline.length ? timeline[timeline.length - 1].t : 0) : o.nowMs;
  const marks = { firstMs: null, resourceMs: null, audioMs: null, worldMs: null };
  for (const it of timeline) {
    for (const pid of matchPhases(it.line)) {
      const key = pid === 'first' ? 'firstMs' : pid + 'Ms';
      if (marks[key] === null) marks[key] = it.t;
    }
  }
  const lastT = timeline.length ? timeline[timeline.length - 1].t : null;
  const gapMs = lastT === null ? null : Math.max(0, nowMs - lastT);
  // 就绪 = 至少过了「资源重载」这个阶段，且日志已经安静够久
  let readyMs = null;
  const anchor = marks.audioMs != null ? marks.audioMs : marks.resourceMs;
  if (anchor != null && lastT != null && gapMs !== null && gapMs >= quietMs) readyMs = lastT;
  const phase = readyMs !== null ? 'ready'
    : (marks.audioMs !== null ? 'audio' : (marks.resourceMs !== null ? 'resource' : (marks.firstMs !== null ? 'booting' : 'idle')));
  return Object.assign({}, marks, { readyMs, gapMs, phase });
}

/** 纯函数：取中位数（偶数取中间两个的平均） */
function median(arr) {
  const a = (arr || []).filter(v => typeof v === 'number' && isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10;
}

/** 纯函数：把多次跑的结果聚成一行（取中位数） */
function aggregate(runs) {
  const list = runs || [];
  const ready = median(list.map(r => r.readyMs).filter(v => v != null));
  return {
    runs: list.length,
    readyMs: ready,
    totalPauseMs: median(list.map(r => r.totalPauseMs).filter(v => v != null)),
    maxPauseMs: median(list.map(r => r.maxPauseMs).filter(v => v != null)),
    pauseCount: median(list.map(r => r.pauseCount).filter(v => v != null)),
    peakMemMB: median(list.map(r => r.peakMemMB).filter(v => v != null)),
    succeeded: list.filter(r => r.ok !== false).length
  };
}

/**
 * 纯函数：A/B 对比。lowerIsBetter 的指标都统一成「越小越好」。
 * @returns {Array<{metric:string, unit:string, a:number|null, b:number|null, deltaPct:number|null, winner:'a'|'b'|'tie'|'na'}>}
 */
function compare(a, b) {
  const metrics = [
    { key: 'readyMs', label: '到主菜单', unit: 'ms' },
    { key: 'totalPauseMs', label: 'GC 停顿总计', unit: 'ms' },
    { key: 'maxPauseMs', label: '最长单次停顿', unit: 'ms' },
    { key: 'pauseCount', label: 'GC 次数', unit: '次' },
    { key: 'peakMemMB', label: '内存峰值', unit: 'MB' }
  ];
  return metrics.map(m => {
    const va = a && typeof a[m.key] === 'number' ? a[m.key] : null;
    const vb = b && typeof b[m.key] === 'number' ? b[m.key] : null;
    if (va === null || vb === null) return { metric: m.label, unit: m.unit, a: va, b: vb, deltaPct: null, winner: 'na' };
    if (va === 0 && vb === 0) return { metric: m.label, unit: m.unit, a: va, b: vb, deltaPct: 0, winner: 'tie' };
    const base = Math.max(va, vb) || 1;
    const deltaPct = Math.round(((vb - va) / base) * 1000) / 10;   // 正 = b 更慢/更大
    // 差异在 3% 以内视为噪声：跑两次 MC 启动时间本来就有波动
    const winner = Math.abs(deltaPct) < 3 ? 'tie' : (deltaPct > 0 ? 'a' : 'b');
    return { metric: m.label, unit: m.unit, a: va, b: vb, deltaPct, winner };
  });
}

/** 纯函数：给一串对比结论生成一句人话 */
function verdict(rows, nameA, nameB) {
  const valids = (rows || []).filter(r => r.winner !== 'na');
  if (!valids.length) return '两边都没有可比的数据。';
  const winA = valids.filter(r => r.winner === 'a').length;
  const winB = valids.filter(r => r.winner === 'b').length;
  if (winA === winB) return `${nameA} 与 ${nameB} 打平（各有 ${winA} 项占优），按体感随便挑一个即可。`;
  const win = winA > winB ? nameA : nameB;
  const n = Math.max(winA, winB);
  const ready = valids.find(r => r.metric === '到主菜单');
  let extra = '';
  if (ready && ready.winner !== 'na' && Math.abs(ready.deltaPct || 0) >= 3) {
    const better = ready.deltaPct > 0 ? ready.a : ready.b;
    const worse = ready.deltaPct > 0 ? ready.b : ready.a;
    extra = `其中启动耗时 ${better}ms vs ${worse}ms。`;
  }
  return `${win} 在 ${n}/${valids.length} 项指标上更优。${extra}`;
}

/* ==================================================================
 * 六、内存采样（Windows）
 * ================================================================== */
/** 读一个 pid 的工作集字节数。tasklist 比 PowerShell 轻得多，采样频率可以到 2s 一次 */
function processRss(pid) {
  if (!pid) return 0;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'latin1', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      });
      // 形如 "javaw.exe","1234","Console","1","1,234,560 K"
      const cols = out.split('"').filter((s) => s.trim() && s.trim() !== ',');
      const memStr = cols[cols.length - 1] || '';
      const kb = parseInt(memStr.replace(/[^\d]/g, ''), 10);
      return isFinite(kb) ? kb * 1024 : 0;
    } catch { return 0; }
  }
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const kb = parseInt(out.trim(), 10);
    return isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; }
}

/* ==================================================================
 * 六点五、一次基准跑的探针
 * ================================================================== */
/**
 * 挂在一个刚 spawn 出来的子进程上，采集启动时间线 / 内存峰值，判定「到主菜单」，然后收尾。
 * 传进来的可以是假的 EventEmitter —— 这样不用真开 MC 也能测完整流程。
 *
 * @param {object} o {
 *   pid, startedAt, gameDir, gcLogName, presetId, version, memMB, javaMajor, extraArgs,
 *   quietMs=6000, holdMs=8000, timeoutMs=300000, autoClose=true,
 *   logger, onUpdate, readGc=(path)=>string, rss=(pid)=>bytes, kill=(pid)=>void, now=()=>ms
 * }
 * @returns {{promise:Promise<object>, timeline:Array, state:object,
 *            finish:(reason?:string)=>void, evaluate:()=>number, cancel:()=>void}}
 */
function attachProbe(child, o) {
  const opt = o || {};
  const now = opt.now || (() => Date.now());
  const startedAt = opt.startedAt || now();
  const quietMs = opt.quietMs == null ? 6000 : opt.quietMs;
  const holdMs = opt.holdMs == null ? 8000 : opt.holdMs;
  const timeoutMs = opt.timeoutMs == null ? 300000 : opt.timeoutMs;
  const pollMs = opt.pollMs || 500;
  const rssFn = opt.rss || processRss;
  const killFn = opt.kill || ((pid) => {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGKILL');
    } catch { /* 已经没了 */ }
  });
  const log = (s) => { if (opt.logger) opt.logger(String(s)); };
  const readGc = opt.readGc || ((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } });

  const timeline = [];
  const state = { phase: 'idle', readyMs: null, peakMemMB: 0, lastLine: '', exited: false, closed: false, reason: 'running' };
  let buf = '';
  let timer = null;
  let resolved = false;
  let resolveFn = null;
  const promise = new Promise((res) => { resolveFn = res; });

  const pump = (chunk) => {
    buf += (chunk || '').toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const t = now() - startedAt;
      timeline.push({ t, line: line.slice(0, 2000) });
      state.lastLine = line.slice(0, 200);
    }
    if (timeline.length > 5000) timeline.splice(0, timeline.length - 5000);
  };

  const evaluate = () => {
    const elapsed = now() - startedAt;
    const m = measure(timeline, { quietMs, nowMs: elapsed });
    state.phase = m.phase;
    if (state.readyMs === null && m.readyMs !== null) state.readyMs = m.readyMs;
    const bytes = rssFn(opt.pid);
    if (bytes) state.peakMemMB = Math.max(state.peakMemMB, Math.round(bytes / 1048576));
    if (opt.onUpdate) {
      try { opt.onUpdate({ phase: state.phase, elapsedMs: elapsed, readyMs: state.readyMs, peakMemMB: state.peakMemMB, lines: timeline.length }); }
      catch { /* 回调炸了不影响采样 */ }
    }
    return elapsed;
  };

  const finish = (reason) => {
    if (resolved) return;
    resolved = true;
    if (timer) { clearInterval(timer); timer = null; }
    state.reason = reason || state.reason;
    evaluate();
    const elapsed = now() - startedAt;
    const gcText = opt.gcLogName && opt.gameDir ? readGc(path.join(opt.gameDir, opt.gcLogName)) : '';
    const gc = parseGcLog(gcText);
    const run = {
      ts: Date.now(),
      presetId: opt.presetId || 'default',
      version: opt.version || '',
      memMB: opt.memMB || 0,
      javaMajor: opt.javaMajor || 0,
      ok: state.readyMs !== null,
      readyMs: state.readyMs,
      elapsedMs: elapsed,
      firstMs: timeline.length ? timeline[0].t : null,
      lines: timeline.length,
      peakMemMB: state.peakMemMB,
      pauseCount: gc.pauseCount,
      totalPauseMs: gc.totalPauseMs,
      maxPauseMs: gc.maxPauseMs,
      fullGcCount: gc.fullGcCount,
      reclaimedMB: gc.reclaimedMB,
      reason: state.reason,
      lastLine: state.lastLine
    };
    log(`[实验室] 结束（${run.reason}）：耗时 ${elapsed}ms，就绪 ${run.readyMs == null ? '未判定' : run.readyMs + 'ms'}，` +
        `GC ${gc.pauseCount} 次 / 共 ${gc.totalPauseMs}ms，峰值内存 ${run.peakMemMB}MB`);
    if (opt.save !== false) saveRun(run);
    resolveFn(run);
  };

  if (child) {
    if (child.stdout) child.stdout.on('data', pump);
    if (child.stderr) child.stderr.on('data', pump);
    if (child.on) {
      // exit 与 close 都会来一次，finish 自己做了幂等，这里统一记为 exited
      child.on('exit', () => { state.exited = true; finish('exited'); });
      child.on('close', () => { state.closed = true; finish('exited'); });
    }
  }

  timer = setInterval(() => {
    const elapsed = evaluate();
    if (elapsed > timeoutMs) { finish('timeout'); return; }
    if (state.readyMs !== null) {
      if (opt.autoClose === false) { finish('ready-manual'); return; }
      if (elapsed - state.readyMs >= holdMs) {
        if (opt.pid) killFn(opt.pid);
        finish('ready-closed');
      }
    }
  }, pollMs);

  return { promise, timeline, state, finish, evaluate, cancel: () => finish('cancelled') };
}

/* ==================================================================
 * 七、历史记录
 * ================================================================== */
function historyPath() {
  if (app) {
    try { return path.join(app.getPath('userData'), 'jvmlab.json'); } catch { /* 落到临时目录 */ }
  }
  return path.join(os.tmpdir(), 'pebble-jvmlab.json');
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf8');
    const j = JSON.parse(raw);
    return { ok: true, runs: Array.isArray(j.runs) ? j.runs : [] };
  } catch {
    return { ok: true, runs: [] };
  }
}

/** 追加一条跑分。保留最近 N 条，超了丢最旧的 */
function saveRun(run, keepN) {
  const keep = keepN || 200;
  const h = loadHistory();
  h.runs.push(Object.assign({ id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6) }, run));
  while (h.runs.length > keep) h.runs.shift();
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    fs.writeFileSync(historyPath(), JSON.stringify({ v: 1, runs: h.runs }, null, 1), 'utf8');
    return { ok: true, count: h.runs.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

function clearHistory() {
  try { try { fs.unlinkSync(historyPath()); } catch { /* 本来就没有 */ } return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/** 按预设分组聚合全部历史 */
function presetSummary(runs) {
  const byPreset = {};
  for (const r of runs || []) {
    (byPreset[r.presetId] = byPreset[r.presetId] || []).push(r);
  }
  const out = [];
  for (const id of Object.keys(byPreset)) {
    const agg = aggregate(byPreset[id]);
    const p = getPreset(id);
    out.push(Object.assign({ presetId: id, presetName: p ? p.name : id }, agg, {
      // 同一预设可能在不同内存档跑过，按 memMB 再分组方便筛选
      mems: Array.from(new Set(byPreset[id].map(r => r.memMB).filter(Boolean)))
    }));
  }
  out.sort((a, b) => (a.readyMs == null ? Infinity : a.readyMs) - (b.readyMs == null ? Infinity : b.readyMs));
  return out;
}

module.exports = {
  PRESETS, getPreset, presetArgs, usablePresets,
  recommendMem, saneMax, MEM_TABLE,
  gcLogArgs, buildBenchArgs,
  parseGcLog, unitMB,
  PHASES, matchPhases, measure,
  median, aggregate, compare, verdict, attachProbe,
  processRss,
  loadHistory, saveRun, clearHistory, presetSummary, historyPath
};
