// Pebble Lunchar - 性能诊断引擎
//
// 和 crashdoctor.js 的分工：
//   crashdoctor  = 游戏**崩了**之后解释为什么崩（exception / 致命错）
//   perfdoctor   = 游戏**能跑但卡**的归因（掉帧、卡顿、内存吃满、加载慢）
//
// 设计原则同 crashdoctor：纯本地、零 API、零 LLM。规则库可众包扩展。
// 输入有三路，都是本地现成的：
//   1) latest.log / 日志尾部  —— GC 停顿、内存峰值、chunk 加载速率、渲染线程警告
//   2) 存档规模（worldmap/worlddb 的产物）—— 实体热点、容器爆炸、区块总数
//   3) 系统规格（CPU 核数 / 物理内存）—— 判断「参数是否配得离谱」
//
// 关键取舍：**诊断只给结论与理由，不自动改配置**。
// 自动改 JVM 参数这种事出错就是「游戏起不来」，得让用户在 UI 上看见变化再确认。

/** @typedef {{id:string, name:string, severity:'fatal'|'error'|'warn'|'info', category:string,
 *   evidence:string, advice:string[]}} Finding */

/* ==================================================================
 * 一、日志证据提取（纯函数）
 * ================================================================== */

// Java 9+ -Xlog:gc* 的行形如：
//   [2026-10-02T11:00:00.123+0800][info][gc] GC(42) Pause Young (Normal) (G1 Evacuation Pause) 512M->128M(2048M) 12.345ms
const RE_GCLOG_PAUSE = /([\d.]+)\s*ms\s*$/;
const RE_GCLOG_GCID = /GC\((\d+)\)/;
const RE_GCLOG_PAUSE_KIND = /Pause (Full|Young|Mixed|Initial Mark|Remark)/i;
const RE_J8_GC = /\[GC.*?([\d.]+)\s*secs\]|([\d.]+)\s*secs\]/;
// 堆前后：512M->128M(2048M)
const RE_HEAP = /(\d+)\s*([KMG])\s*->\s*(\d+)\s*([KMG])\((\d+)\s*([KMG])\)/;
// 加载 chunk / 生成 chunk 的进度行
const RE_CHUNK_PREPARE = /Preparing spawn area:\s*(\d+)%/i;
const RE_CHUNK_LOAD = /Loaded\s+(\d+)\s+chunk|Loaded\s+(\d+)\s+of\s+(\d+)/i;
// 日志里常见的性能告警
// "Can not keep up! ... Running 2500ms or 50 ticks behind" 与 "Running 800ms behind" 两种句式都要认。
// 关键：第一种句式的毫秒数后面跟的是 "or N ticks behind"，所以不能写 \s+behind 强行卡住。
const RE_CANT_KEEP_UP = /Can.?t keep up!.*?Running\s+(\d+)ms|Running\s+(\d+)ms/i;
const RE_OUT_OF_MEMORY = /OutOfMemoryError|Java heap space|GC overhead limit exceeded/i;
const RE_LOW_FPS_WARN = /(?:Low|slow).*?frame|Framerate.*?(?:low|drop)/i;
const RE_SHADER_ERR = /shader.*(?:fail|error|compile)/i;
// 启动耗时：从首行到「资源重载」/「音频就绪」（jvmlab 的 PHASES 同款锚点）
const RE_RESOURCE_RELOAD = /Reloading ResourceManager|Resource reload|Loading [0-9]+ (?:recipes|advancements)/i;

const MB = { K: 1 / 1024, M: 1, G: 1024 };

/**
 * 纯函数：从一段日志文本里抽取性能相关的证据。
 * 容错优先 —— 半行、截断的日志不该让它抛异常（tail 读到的日志本来就可能从中间开始）。
 *
 * @param {string} text 日志全文或尾部
 * @returns {{
 *   lines:number,
 *   gc:{count:number, totalPauseMs:number, maxPauseMs:number, avgPauseMs:number, fullCount:number, peakHeapMB:number},
 *   stutter:{behindCount:number, worstBehindMs:number},
 *   oom:boolean,
 *   chunkPct:number|null,
 *   shaderWarn:boolean,
 *   startedAt:string|null, firstLineAt:string|null
 * }}
 */
function extract(text) {
  const out = {
    lines: 0,
    gc: { count: 0, totalPauseMs: 0, maxPauseMs: 0, avgPauseMs: 0, fullCount: 0, peakHeapMB: 0 },
    stutter: { behindCount: 0, worstBehindMs: 0 },
    oom: false,
    chunkPct: null,
    shaderWarn: false,
    startedAt: null,
    firstLineAt: null
  };
  const src = String(text || '');
  if (!src.trim()) return out;

  const lines = src.split(/\r?\n/).filter((l) => l.trim());
  out.lines = lines.length;
  out.firstLineAt = (lines[0] || '').slice(0, 60);

  let total = 0;
  let max = 0;
  let count = 0;
  let full = 0;
  let peakHeap = 0;

  for (const line of lines) {
    // ---- GC 停顿 ----
    // Java 9+：以「xx.xxms」结尾且含 GC( 或 Pause
    let pauseMs = null;
    if (RE_GCLOG_GCID.test(line) || RE_GCLOG_PAUSE_KIND.test(line)) {
      const m = RE_GCLOG_PAUSE.exec(line);
      if (m) pauseMs = parseFloat(m[1]);
    }
    // Java 8：形如 "[GC (Allocation Failure) 100M->20M(512M), 0.0123456 secs]"
    if (pauseMs === null) {
      const m8 = RE_J8_GC.exec(line);
      if (m8) {
        const secs = parseFloat(m8[1] || m8[2]);
        if (isFinite(secs)) pauseMs = secs * 1000;
      }
    }
    if (pauseMs !== null && pauseMs >= 0.05) {
      count++;
      total += pauseMs;
      if (pauseMs > max) max = pauseMs;
      if (/Pause Full|Full GC|GC \(Full\)/i.test(line)) full++;
    }
    // ---- 堆峰值 ----
    const h = RE_HEAP.exec(line);
    if (h) {
      // 取「堆总量」那一项（括号里的），没有就用 -> 后的存活量
      const totalMB = h[5] ? (+h[5]) * (MB[h[6]] || 1) : (+h[3]) * (MB[h[4]] || 1);
      if (totalMB > peakHeap) peakHeap = totalMB;
    }
    // ---- 掉帧/卡顿告警 ----
    const st = RE_CANT_KEEP_UP.exec(line);
    if (st) {
      const ms = parseInt(st[1] || st[2], 10);
      out.stutter.behindCount++;
      if (isFinite(ms) && ms > out.stutter.worstBehindMs) out.stutter.worstBehindMs = ms;
    }
    // ---- OOM ----
    if (RE_OUT_OF_MEMORY.test(line)) out.oom = true;
    // ---- chunk 加载进度 ----
    const cp = RE_CHUNK_PREPARE.exec(line);
    if (cp) out.chunkPct = parseInt(cp[1], 10);
    // ---- 着色器/渲染告警 ----
    if (RE_SHADER_ERR.test(line)) out.shaderWarn = true;
  }

  out.gc = {
    count,
    totalPauseMs: Math.round(total * 10) / 10,
    maxPauseMs: Math.round(max * 10) / 10,
    avgPauseMs: count ? Math.round((total / count) * 10) / 10 : 0,
    fullCount: full,
    peakHeapMB: Math.round(peakHeap)
  };
  return out;
}

/* ==================================================================
 * 二、判定阈值
 * ================================================================== */
// 这些数字不是拍脑袋：60fps 的帧预算 16.7ms，GC 单次超过 50ms 就能被肉眼察觉为「一顿」；
// 一次 GC 停顿超过 200ms 属于明显卡顿；日志里出现的 "Can't keep up" 是服务端/客户端 tick 落后。
const TH = {
  maxPauseWarn: 50,        // ms，单次 GC 停顿
  maxPauseBad: 200,
  totalPauseWarn: 200,     // ms，一次会话累计
  fullGcWarn: 3,           // 次数
  behindWarn: 1,           // Can't keep up 次数
  behindBadMs: 1000,
  entitiesPerChunkWarn: 40, // 单区块实体数（worldmap 的 entityMax）
  containersWarn: 2000      // 单存档容器总数（worlddb）
};

/* ==================================================================
 * 三、规则库
 * ================================================================== */
/**
 * 每条规则：{ id, name, severity, category, when(ev, ctx) => boolean, evidence(ev, ctx) => string,
 *            advice(ev, ctx) => string[] }
 * ev  = extract() 的结果；ctx = { entityMax, saveChunks, containerCount, totalGB, cpuCores, xmxMB, javaMajor }
 */
const RULES = [
  {
    id: 'oom',
    name: '内存不足（已发生 OOM）',
    severity: 'fatal',
    category: 'memory',
    when: (ev) => ev.oom,
    evidence: () => '日志里出现了 OutOfMemoryError / Java heap space。',
    advice: () => [
      '这是**硬性内存不够**，不是「卡」的问题 —— 加 -Xmx 是唯一正解。',
      '大型整合包建议 8–10G；原版 4G 就够。别把物理内存全给 MC（系统还要留一半）。',
      '如果 -Xmx 已经很大还 OOM，多半是某个 mod 泄漏，试试二分法禁用 mod。',
      '到「性能」页的「自动调参」可以直接按你的机器生成一组参数。'
    ]
  },
  {
    id: 'gc-pause-long',
    name: 'GC 停顿过长',
    severity: 'error',
    category: 'gc',
    when: (ev) => ev.gc.maxPauseMs >= TH.maxPauseBad,
    evidence: (ev) => `最长单次 GC 停顿 ${ev.gc.maxPauseMs}ms（阈值 ${TH.maxPauseBad}ms），累计 ${ev.gc.count} 次。`,
    advice: (ev) => [
      `单次停顿到了 ${ev.gc.maxPauseMs}ms，体感就是「每隔一会儿一顿」。`,
      '首选换 G1 并调小停顿目标：`-XX:+UseG1GC -XX:MaxGCPauseMillis=50`。',
      '大内存（≥16G）且 Java 17+ 可以试 `-XX:+UseZGC`（停顿极低，但吃更多内存）。',
      '到「JVM 实验室」用 A/B 实测确认改动真的有效，别凭感觉。'
    ]
  },
  {
    id: 'gc-pause-frequent',
    name: 'GC 频繁',
    severity: 'warn',
    category: 'gc',
    when: (ev) => ev.gc.count >= 50 && ev.gc.avgPauseMs > 0 && ev.gc.avgPauseMs < TH.maxPauseWarn,
    evidence: (ev) => `本次会话 GC 触发 ${ev.gc.count} 次，平均每次 ${ev.gc.avgPauseMs}ms。`,
    advice: () => [
      'GC 次数多但每次都不长，通常是**堆太小**导致频繁回收。',
      '适当加大 -Xmx（例如 +2G）往往比换 GC 更有效。',
      '同时把 -Xms 设成和 -Xmx 一样大，避免堆反复扩容。'
    ]
  },
  {
    id: 'full-gc',
    name: 'Full GC 偏多',
    severity: 'warn',
    category: 'gc',
    when: (ev) => ev.gc.fullCount >= TH.fullGcWarn,
    evidence: (ev) => `Full GC ${ev.gc.fullCount} 次（阈值 ${TH.fullGcWarn}）。`,
    advice: () => [
      'Full GC 会 STW 冻住整个游戏，出现多次说明堆压力大或内存泄漏。',
      '优先加大堆；Java 17+ 用 G1/ZGC 能显著减少 Full GC。',
      '若加大堆仍频繁 Full GC，怀疑 mod 内存泄漏。'
    ]
  },
  {
    id: 'stutter',
    name: '游戏 tick 落后（卡顿）',
    severity: 'error',
    category: 'runtime',
    when: (ev) => ev.stutter.behindCount >= TH.behindWarn,
    evidence: (ev) => `日志出现 "Can't keep up" ${ev.stutter.behindCount} 次，最严重落后 ${ev.stutter.worstBehindMs}ms。`,
    advice: (ev) => [
      ev.stutter.worstBehindMs >= TH.behindBadMs
        ? '落后超过 1 秒说明有单帧/单 tick 严重阻塞，通常是区块生成或实体过多。'
        : '轻微的 tick 落后在自动保存/区块加载时常见，若不影响体感可忽略。',
      '降低渲染距离（设置 → 游戏内设置）是最立竿见影的。',
      '看「性能」页的实体热点，把刷怪塔/掉落物聚集区清理一下。'
    ]
  },
  {
    id: 'entity-hotspot',
    name: '实体热点过多',
    severity: 'warn',
    category: 'world',
    when: (ev, ctx) => (ctx.entityMax || 0) >= TH.entitiesPerChunkWarn,
    evidence: (ev, ctx) => `单区块最多有 ${ctx.entityMax} 个实体（阈值 ${TH.entitiesPerChunkWarn}）。`,
    advice: (ev, ctx) => [
      `一个区块塞了 ${ctx.entityMax} 个实体，实体 tick 是单线程的，这块区域就是卡顿源。`,
      '常见元凶：刷怪塔、村民聚集区、掉落物堆积、大量船/矿车。',
      '到「世界」页的地图预览，用实体热点红框定位具体坐标。',
      '处理：清理掉落物（/kill @e[type=item]）、限制刷怪塔产出、给村民区块用区块加载器之外的方案。'
    ]
  },
  {
    id: 'container-heavy',
    name: '容器/物品数据庞大',
    severity: 'info',
    category: 'world',
    when: (ev, ctx) => (ctx.containerCount || 0) >= TH.containersWarn,
    evidence: (ev, ctx) => `单存档共有 ${ctx.containerCount} 个容器。`,
    advice: (ev, ctx) => [
      `存档里有 ${ctx.containerCount} 个容器，存档体积与加载时间会明显上升。`,
      '这本身不是 bug，但如果加载慢可以考虑整理或归档一部分。',
      '到「世界」页的全局检索看看物品都堆在哪，方便集中处理。'
    ]
  },
  {
    id: 'mem-overcommit',
    name: '-Xmx 配得过大',
    severity: 'warn',
    category: 'config',
    when: (ev, ctx) => (ctx.xmxMB || 0) > 0 && (ctx.totalGB || 0) > 0 && (ctx.xmxMB / 1024) > (ctx.totalGB / 2 + 0.5),
    evidence: (ev, ctx) => `-Xmx 给了 ${Math.round(ctx.xmxMB / 1024 * 10) / 10}G，物理内存只有 ${Math.round(ctx.totalGB * 10) / 10}G。`,
    advice: (ev, ctx) => [
      '堆给超过物理内存一半，系统会开始换页，反而更卡（负优化）。',
      `建议降到 ${Math.max(2, Math.floor(ctx.totalGB / 2))}G 左右。`,
      '内存给多了 GC 单次停顿也会更长（堆越大扫得越久），不是越多越好。'
    ]
  },
  {
    id: 'mem-undercommit',
    name: '-Xmx 可能偏小',
    severity: 'info',
    category: 'config',
    when: (ev, ctx) => ev.gc.peakHeapMB > 0 && (ctx.xmxMB || 0) > 0 && ev.gc.peakHeapMB > ctx.xmxMB * 0.9,
    evidence: (ev, ctx) => `堆峰值 ${ev.gc.peakHeapMB}MB 逼近上限 ${ctx.xmxMB}MB。`,
    advice: (ev, ctx) => [
      '堆几乎被吃满，离 OOM 只有一步。',
      `建议把 -Xmx 提高到 ${Math.ceil(ev.gc.peakHeapMB / 1024) + 2}G 左右留出余量。`,
      '同时设 -Xms = -Xmx 可以减少扩容抖动。'
    ]
  },
  {
    id: 'low-cores',
    name: 'CPU 核心数偏少',
    severity: 'info',
    category: 'system',
    when: (ev, ctx) => (ctx.cpuCores || 0) > 0 && ctx.cpuCores <= 2,
    evidence: (ev, ctx) => `检测到 ${ctx.cpuCores} 个逻辑核心。`,
    advice: () => [
      'MC 的区块构建与 GC 都吃多核，2 核及以下会成为瓶颈。',
      '降低渲染距离、关闭光影能明显改善。',
      '限制后台程序（浏览器、录屏）能给 MC 让出更多 CPU。'
    ]
  },
  {
    id: 'shader-warn',
    name: '着色器相关告警',
    severity: 'warn',
    category: 'render',
    when: (ev) => ev.shaderWarn,
    evidence: () => '日志里有着色器编译/加载相关的告警。',
    advice: () => [
      '光影包对性能影响巨大，先用原版确认基线帧率。',
      '换轻量光影（如 Complementary Reimagined 的低配档）或降低光影质量。',
      '确认显卡驱动是最新的（不要用 Windows 自动装的旧驱动）。'
    ]
  },
  {
    id: 'chunk-load-slow',
    name: '区块加载缓慢',
    severity: 'info',
    category: 'world',
    when: (ev, ctx) => (ctx.saveChunks || 0) >= 20000,
    evidence: (ev, ctx) => `存档已有 ${ctx.saveChunks} 个区块。`,
    advice: () => [
      '存档非常大，首次进入或跨维度传送时会明显加载慢。',
      '这是存档规模的自然结果，不是配置问题。',
      '给存档盘用 SSD；机械盘加载大地图会非常痛苦。'
    ]
  }
];

/* ==================================================================
 * 四、诊断主入口
 * ================================================================== */
/**
 * 综合诊断。所有输入可选 —— 只有日志就只做日志诊断，只有存档就只做存档诊断。
 * @param {{logText?:string, entityMax?:number, saveChunks?:number, containerCount?:number,
 *          totalGB?:number, cpuCores?:number, xmxMB?:number, javaMajor?:number}} input
 * @returns {{findings:Finding[], score:number, grade:string, summary:string, evidence:object}}
 */
function diagnose(input) {
  const inp = input || {};
  const ev = extract(inp.logText || '');
  const ctx = {
    entityMax: Number(inp.entityMax) || 0,
    saveChunks: Number(inp.saveChunks) || 0,
    containerCount: Number(inp.containerCount) || 0,
    totalGB: Number(inp.totalGB) || 0,
    cpuCores: Number(inp.cpuCores) || 0,
    xmxMB: Number(inp.xmxMB) || 0,
    javaMajor: Number(inp.javaMajor) || 0
  };

  /** @type {Finding[]} */
  const findings = [];
  for (const r of RULES) {
    let hit = false;
    try { hit = !!r.when(ev, ctx); } catch { hit = false; }
    if (!hit) continue;
    let evidence = '';
    let advice = [];
    try { evidence = r.evidence(ev, ctx); } catch { evidence = ''; }
    try { advice = r.advice(ev, ctx) || []; } catch { advice = []; }
    // severity 在 RULES 里是字面量联合类型，但 RULES 数组本身没标注，
    // 逐个 push 时会被推成 string —— 这里显式收窄回 Finding 的联合类型。
    findings.push({ id: r.id, name: r.name, severity: /** @type {Finding["severity"]} */ (r.severity), category: r.category, evidence, advice });
  }

  // 按严重度排序：fatal > error > warn > info
  const order = { fatal: 0, error: 1, warn: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  // 评分：从 100 往下扣，扣到 0 为止。目的是给用户一个「一眼看出多严重」的直觉
  const penal = { fatal: 45, error: 20, warn: 8, info: 2 };
  let score = 100;
  for (const f of findings) score -= (penal[f.severity] || 0);
  score = Math.max(0, Math.min(100, score));
  const grade = score >= 90 ? 'good' : (score >= 70 ? 'fair' : (score >= 40 ? 'poor' : 'bad'));

  const counts = { fatal: 0, error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const summary = findings.length === 0
    ? '没有发现明显的性能问题。'
    : `发现 ${counts.fatal + counts.error} 个需要处理的问题（其中 ${counts.fatal} 个致命）、${counts.warn} 个警告、${counts.info} 条提示。`;

  return { findings, score, grade, summary, evidence: { log: ev, ctx } };
}

/* ==================================================================
 * 五、系统画像（碰系统的那部分，与纯函数分开方便单测）
 * ================================================================== */
/**
 * 采集本机性能画像。
 * @returns {{totalGB:number, cpuCores:number, cpuModel:string, platform:string, freeGB:number}}
 */
function systemProfile() {
  const os = require('os');
  const total = os.totalmem() / 1073741824;
  const free = os.freemem() / 1073741824;
  const cpus = os.cpus() || [];
  return {
    totalGB: Math.round(total * 10) / 10,
    freeGB: Math.round(free * 10) / 10,
    cpuCores: cpus.length,
    cpuModel: cpus.length ? String(cpus[0].model || '').trim() : '',
    platform: process.platform + '/' + process.arch
  };
}

/* ==================================================================
 * 六、从日志尾部提取当前 JVM 参数（用于判断「配得对不对」）
 * ================================================================== */
/**
 * 纯函数：从日志里找启动时的 JVM 参数行，抽出 -Xmx / -Xms / GC 选择。
 * @param {string} text
 * @returns {{xmxMB:number, xmsMB:number, gc:string|null, raw:string|null}}
 */
function parseJvmArgs(text) {
  const out = { xmxMB: 0, xmsMB: 0, gc: null, raw: null };
  const src = String(text || '');
  if (!src) return out;
  // 只扫前 200 行：JVM 参数一般在启动头部，全文件扫没必要
  const head = src.split(/\r?\n/).slice(0, 200).join('\n');
  const mx = /-Xmx(\d+)([KMGkmg])/.exec(head);
  const ms = /-Xms(\d+)([KMGkmg])/.exec(head);
  const toMB = (m) => (m ? Math.round(parseInt(m[1], 10) * ((MB[m[2].toUpperCase()] || 1))) : 0);
  out.xmxMB = toMB(mx);
  out.xmsMB = toMB(ms);
  if (/UseZGC/.test(head)) out.gc = 'ZGC';
  else if (/UseShenandoahGC/.test(head)) out.gc = 'Shenandoah';
  else if (/UseParallelGC/.test(head)) out.gc = 'Parallel';
  else if (/UseG1GC/.test(head)) out.gc = 'G1';
  else if (/UseSerialGC/.test(head)) out.gc = 'Serial';
  // 保留原始参数行供 UI 展示
  const line = head.split(/\r?\n/).find((l) => /-Xmx|-Xms|UseG1GC|UseZGC/.test(l));
  out.raw = line ? line.trim().slice(0, 400) : null;
  return out;
}

module.exports = {
  extract, diagnose, systemProfile, parseJvmArgs,
  RULES, TH
};
