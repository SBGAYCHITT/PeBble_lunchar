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

/* ==================================================================
 * 七、帧时间分布（FPS / 帧计数 → 分位数、直方图、长帧占比）
 * ==================================================================
 * ⚠️ 这里是整个性能模块**最容易不诚实**的地方，先把口径写死：
 *
 *   分辨率 A `frame`            样本里有 `frameTimes`（逐帧毫秒数组）
 *                               → P50/P95/P99 是**真正的逐帧分位数**。
 *   分辨率 B `frame-aggregate`  样本里有 `frames` + `longFrames`（这一秒渲染了多少帧、
 *                               其中多少帧超过阈值）→ **长帧占比精确**，P99 只能给
 *                               「最差一秒的 P99」，不能冒充全程逐帧 P99。
 *   分辨率 C `second`           只有 `fps`（每秒一个读数）→ 只能算**每秒平均帧时间**
 *                               的分位数。它一定比真实 P99 好看，因为一秒内的毛刺被平均掉了。
 *                               所以这里显式标记 `derived: true`，并在 caveat 里说清楚。
 *
 * 没有数据时不编数字：`available: false`，分位数一律 null。
 */

// 分桶边界取「帧预算」：8.33ms=120fps、16.67ms=60fps、25ms=40fps、
// 33.33ms=30fps、50ms=20fps、100ms=10fps。柱子高度直接对应「掉到哪一档」。
const FRAME_EDGES = [0, 8.33, 16.67, 25, 33.33, 50, 100, Infinity];

/**
 * 有序数组上取分位数（线性插值）。
 * 用插值而不是 nearest-rank，是为了样本少（比如只有 300 秒）时 P99 不跳变。
 * @param {number[]} sorted 已升序
 * @param {number} p 0–1
 * @returns {number|null}
 */
function percentileOf(sorted, p) {
  if (!sorted || !sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 统计帧时间分布。
 *
 * @param {Array<object>} samples 样本数组，可能来自 MetricsBuffer.all()
 *   （字段：`t` / `fps` / `frames` / `longFrames` / `ftP99` / `frameTimes`）
 * @param {{longMs?:number}} [opts] longMs = 长帧阈值，默认 50（≈20fps 以下）
 * @returns {object} 见下方 return
 */
function frameStats(samples, opts) {
  const o = /** @type {any} */ (opts || {});
  const longMs = Number(o.longMs) > 0 ? Number(o.longMs) : 50;
  const list = Array.isArray(samples) ? samples : [];

  /** 逐帧毫秒（只有 Mod 直接上报 frameTimes 时才有） */
  const raw = [];
  /** 一秒内的帧数与长帧数累计 —— 用来算精确的长帧占比 */
  let frameTotal = 0;
  let longTotal = 0;
  /** 由 fps 反推的「每秒平均帧时间」 */
  const perSec = [];
  let worstSecondP99 = 0;
  let spanStart = 0;
  let spanEnd = 0;

  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const t = Number(s.t);
    if (Number.isFinite(t) && t > 0) {
      if (!spanStart || t < spanStart) spanStart = t;
      if (t > spanEnd) spanEnd = t;
    }
    if (Array.isArray(s.frameTimes)) {
      // 防御：Mod 写出畸形数据（NaN / 负数）时不污染统计
      for (const v of s.frameTimes) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) raw.push(n);
      }
    }
    if (Number.isFinite(s.frames) && s.frames > 0) {
      frameTotal += s.frames;
      const lf = Number(s.longFrames);
      // longFrames 不可能超过 frames，脏数据直接夹紧，否则占比会 >100%
      longTotal += Number.isFinite(lf) ? Math.max(0, Math.min(s.frames, lf)) : 0;
    }
    const fp = Number(s.ftP99);
    if (Number.isFinite(fp) && fp > worstSecondP99) worstSecondP99 = fp;
    const fps = Number(s.fps);
    if (Number.isFinite(fps) && fps > 0) perSec.push(1000 / fps);
  }

  const hasRaw = raw.length > 0;
  const hasAgg = frameTotal > 0;
  const hasSec = perSec.length > 0;
  const resolution = hasRaw ? 'frame' : (hasAgg ? 'frame-aggregate' : (hasSec ? 'second' : 'none'));

  // 分位数和直方图的底料：优先逐帧，其次每秒均值
  const src = hasRaw ? raw : perSec;
  const sorted = src.slice().sort((a, b) => a - b);
  const count = sorted.length;

  // 直方图
  const hist = [];
  for (let i = 0; i < FRAME_EDGES.length - 1; i++) {
    hist.push({ from: FRAME_EDGES[i], to: FRAME_EDGES[i + 1], count: 0, ratio: 0 });
  }
  for (const v of src) {
    for (let i = 0; i < hist.length; i++) {
      if (v >= hist[i].from && v < hist[i].to) { hist[i].count++; break; }
    }
  }
  for (const h of hist) h.ratio = count ? Math.round((h.count / count) * 1000) / 1000 : 0;

  // 长帧：逐帧 / 帧计数两种口径是「帧占比」；只有每秒均值时是「长秒占比」，不能混
  let longCount = 0;
  let longBasis = 'none';
  let longDen = 0;
  if (hasRaw) { longBasis = 'frame'; longDen = raw.length; for (const v of raw) if (v > longMs) longCount++; }
  else if (hasAgg) { longBasis = 'frame'; longDen = frameTotal; longCount = longTotal; }
  else if (hasSec) { longBasis = 'second'; longDen = perSec.length; for (const v of perSec) if (v > longMs) longCount++; }
  const longRatio = longDen ? Math.round((longCount / longDen) * 10000) / 10000 : 0;

  const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
  const sum = count ? sorted.reduce((a, b) => a + b, 0) : 0;
  const avgFrameMs = count ? sum / count : null;

  // 分辨率 C 下这几个数只能说「秒均」，UI 会按 resolution 换措辞
  const caveat = {
    frame: '按逐帧实测数据统计，P99 是真正的逐帧分位数。',
    'frame-aggregate': '长帧占比来自 Mod 上报的帧计数（精确）；分位数来自每秒平均帧时间，会低估瞬时毛刺 —— Mod 若上报 ftP99，见「最差一秒 P99」。',
    second: '只有每秒 FPS 样本：分位数是「每秒平均帧时间」的分位数，会掩盖一秒内的瞬时毛刺，真实逐帧 P99 一定比这个更差。',
    none: '没有帧率数据。日志里没有 FPS，需要装伴随 Mod（或让已有 Mod 按 SPEC 上报 frames/longFrames）。'
  }[resolution];

  return {
    // 只有 frames 计数、没有 fps 的 Mod 也存在：此时分位数是空的，
    // 但长帧占比是精确的，不该整体判成「无数据」。
    available: count > 0 || hasAgg,
    resolution,
    /**
     * 分位数到底基于什么算的。必须和 resolution 分开：
     * Mod 同时给 frames（精确计数）和 fps（每秒均值）时，resolution 是 frame-aggregate，
     * 但 P99 仍然只能来自每秒均值 —— 合在一个字段里会让人以为 P99 是逐帧的。
     */
    percentileBasis: hasRaw ? 'frame' : (hasSec ? 'second' : 'none'),
    /** 是否由 FPS 反推（true = 不是实测帧时间） */
    derived: !hasRaw,
    count,
    seconds: perSec.length,
    spanMs: spanEnd > spanStart ? spanEnd - spanStart : 0,
    avgFrameMs: r1(avgFrameMs),
    p50: r1(percentileOf(sorted, 0.50)),
    p95: r1(percentileOf(sorted, 0.95)),
    p99: r1(percentileOf(sorted, 0.99)),
    max: count ? r1(sorted[sorted.length - 1]) : null,
    avgFps: avgFrameMs ? Math.round((1000 / avgFrameMs) * 10) / 10 : null,
    minFps: count ? Math.round((1000 / sorted[sorted.length - 1]) * 10) / 10 : null,
    worstSecondP99: worstSecondP99 ? r1(worstSecondP99) : null,
    longMs,
    longCount,
    longRatio,
    longBasis,
    histogram: hist,
    caveat
  };
}

/* ==================================================================
 * 八、卡顿归因（先有证据，再谈原因）
 * ==================================================================
 * 原则（这是本节的唯一原则）：
 *   **因果必须有时序证据**。「日志里有 GC 停顿」+「日志里有卡顿」两件事同时存在，
 *   不等于「卡顿是 GC 引起的」。所以这里先做**时间关联**：
 *   对每一次 `Can't keep up!`，看它之前 N 秒内有没有 GC / 区块加载。
 *
 * 还要防一个陷阱：如果 GC 本身极其频繁，那么"随便一次卡顿前 2 秒内有 GC"
 * 几乎必然成立 —— 这是随机重合，不是因果。所以额外算一个 `gcDensity`
 * （= GC 次数 × 窗口 / 会话时长，即随机情况下命中的期望比例），
 * 只有命中率明显高于这个基线（`lift`）才敢下结论。
 *
 * 没有时序证据的一律进 `undetermined`，写清楚"为什么不给结论"，而不是猜一个。
 */

/** 日志行首时间戳：ISO 带日期 或 只有时分秒 */
const RE_TS_ISO = /^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3})\d*)?([+-]\d{2}:?\d{2}|Z)?\]/;
const RE_TS_HMS = /^\[(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3})\d*)?\]/;
/** 区块加载/生成的"事件级"标记（不要匹配到每个区块，否则会把时间轴淹掉） */
const RE_CHUNK_EVENT = /Preparing spawn area:?\s*(\d+)%|Loaded\s+\d+\s+of\s+\d+\s+chunks?|Time to load\s+\d+\s+chunks?/i;

/**
 * 从日志里抽出带时间戳的事件时间轴。
 * 没有时间戳的行照样参与 extract() 的统计，但不进时间轴（无法用于因果判断）。
 *
 * @param {string} text
 * @returns {{ok:boolean, spanMs:number, firstT:number|null, lastT:number|null,
 *   gc:Array<{t:number, ms:number}>, stutter:Array<{t:number, ms:number}>,
 *   chunk:Array<{t:number, pct:number|null}>}}
 */
function parseLogTimeline(text) {
  const out = {
    ok: false, spanMs: 0, firstT: null, lastT: null,
    gc: [], stutter: [], chunk: []
  };
  const src = String(text || '');
  if (!src.trim()) return out;

  const lines = src.split(/\r?\n/);
  let dayOffset = 0;
  let prevHms = null;

  for (const line of lines) {
    if (!line) continue;
    let t = null;

    const mi = RE_TS_ISO.exec(line);
    if (mi) {
      // 必须保留原始时区偏移（+0800）—— 统一换成 Z 会让绝对时间整体偏移 8 小时。
      // 相关性分析本身不怕整体平移，但 UI 上要显示"几点几分"，得是真的。
      const zone = mi[4] && /^[+-]/.test(mi[4]) ? mi[4] : 'Z';
      const iso = mi[1] + 'T' + mi[2] + (mi[3] ? '.' + mi[3] : '') + zone;
      const v = Date.parse(iso);
      if (Number.isFinite(v)) t = v;
    } else {
      const mh = RE_TS_HMS.exec(line);
      if (mh) {
        const raw = ((+mh[1]) * 3600 + (+mh[2]) * 60 + (+mh[3])) * 1000 + (mh[4] ? +mh[4] : 0);
        // 跨零点：时间倒退超过 12 小时就认为进了下一天
        if (prevHms !== null && raw < prevHms - 12 * 3600 * 1000) dayOffset += 86400000;
        prevHms = raw;
        t = raw + dayOffset;
      }
    }

    // ---- 卡顿 ----
    const st = RE_CANT_KEEP_UP.exec(line);
    if (st) {
      const ms = parseInt(st[1] || st[2], 10);
      if (t !== null) out.stutter.push({ t, ms: isFinite(ms) ? ms : 0 });
      // 没有时间戳时不要 continue —— 同一行可能还带 GC 信息（极少见），且 continue 省不了什么
    }

    // ---- GC 停顿 ----
    let pauseMs = null;
    if (RE_GCLOG_GCID.test(line) || RE_GCLOG_PAUSE_KIND.test(line)) {
      const m = RE_GCLOG_PAUSE.exec(line);
      if (m) pauseMs = parseFloat(m[1]);
    }
    if (pauseMs === null) {
      const m8 = RE_J8_GC.exec(line);
      if (m8) {
        const secs = parseFloat(m8[1] || m8[2]);
        if (isFinite(secs)) pauseMs = secs * 1000;
      }
    }
    if (pauseMs !== null && pauseMs >= 0.05 && t !== null) {
      out.gc.push({ t, ms: Math.round(pauseMs * 10) / 10 });
    }

    // ---- 区块加载事件 ----
    if (RE_CHUNK_EVENT.test(line) && t !== null) {
      const cp = RE_CHUNK_PREPARE.exec(line);
      out.chunk.push({ t, pct: cp ? parseInt(cp[1], 10) : null });
    }
  }

  const all = [];
  for (const e of out.gc) all.push(e.t);
  for (const e of out.stutter) all.push(e.t);
  for (const e of out.chunk) all.push(e.t);
  if (all.length) {
    out.ok = true;
    out.firstT = Math.min.apply(null, all);
    out.lastT = Math.max.apply(null, all);
    out.spanMs = out.lastT - out.firstT;
  }
  return out;
}

/**
 * 把卡顿事件与更早的 GC / 区块加载事件做时间关联。
 * @param {ReturnType<typeof parseLogTimeline>} tl
 * @param {number} [windowMs] 默认 2000ms（一次 GC 停顿之后 2 秒内仍 tick 落后，算相关）
 * @returns {{windowMs:number, stutters:number, gcMatched:number, chunkMatched:number,
 *   gcRate:number, chunkRate:number, gcDensity:number, lift:number,
 *   samples:Array<object>}}
 */
function correlateEvents(tl, windowMs) {
  const win = Number(windowMs) > 0 ? Number(windowMs) : 2000;
  const n = tl.stutter.length;
  const out = {
    windowMs: win, stutters: n,
    gcMatched: 0, chunkMatched: 0,
    gcRate: 0, chunkRate: 0,
    gcDensity: 0, lift: 0,
    /** 前 12 条样本，UI 上要能点开看"哪一次卡顿前 X ms 有 GC" */
    samples: []
  };
  if (!n) return out;

  const span = tl.spanMs || 0;
  // 随机重合的期望命中率：GC 平均每 span/gcCount 毫秒一次，窗口内至少落一个的概率上界
  out.gcDensity = span > 0 && tl.gc.length
    ? Math.round(Math.min(1, (tl.gc.length * win) / span) * 100) / 100
    : 0;

  const gcList = tl.gc.slice().sort((a, b) => a.t - b.t);
  const ckList = tl.chunk.slice().sort((a, b) => a.t - b.t);

  /**
   * 找 t 之前 win 毫秒内最近的一个事件。
   * 列表已升序，从尾部往前扫：先跳过"发生在卡顿之后"的事件，再取最近的前置事件。
   */
  const nearBefore = (list, t) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const d = t - list[i].t;
      if (d < 0) continue;
      if (d <= win) return { ev: list[i], since: d };
      break;
    }
    return null;
  };

  for (const s of tl.stutter) {
    const g = nearBefore(gcList, s.t);
    const c = nearBefore(ckList, s.t);
    if (g) {
      out.gcMatched++;
      if (out.samples.length < 12) {
        out.samples.push({ t: s.t, ms: s.ms, cause: 'gc', gcPauseMs: g.ev.ms, sinceMs: g.since });
      }
    }
    if (c) {
      out.chunkMatched++;
      if (out.samples.length < 12) {
        out.samples.push({ t: s.t, ms: s.ms, cause: 'chunk', pct: c.ev.pct, sinceMs: c.since });
      }
    }
  }

  out.gcRate = Math.round((out.gcMatched / n) * 100) / 100;
  out.chunkRate = Math.round((out.chunkMatched / n) * 100) / 100;
  out.lift = Math.round((out.gcRate - out.gcDensity) * 100) / 100;
  return out;
}

/**
 * 卡顿归因。**只输出有证据的结论**，其余进 `undetermined`。
 *
 * @param {{logText?:string, evidence?:object, timeline?:object, entityMax?:number,
 *   saveChunks?:number, containerCount?:number, xmxMB?:number, windowMs?:number}} input
 * @returns {{ok:boolean, stutterCount:number, spanMs:number,
 *   timeline:object, correlation:object, causes:Array<object>,
 *   undetermined:Array<object>, caveats:string[]}}
 */
function attributeStutter(input) {
  const inp = /** @type {any} */ (input || {});
  const logText = String(inp.logText || '');
  const ev = inp.evidence || extract(logText);
  const tl = inp.timeline || parseLogTimeline(logText);
  const corr = tl.stutter.length ? correlateEvents(tl, inp.windowMs)
    : { windowMs: Number(inp.windowMs) || 2000, stutters: 0, gcMatched: 0, chunkMatched: 0, gcRate: 0, chunkRate: 0, gcDensity: 0, lift: 0, samples: [] };

  const stutterCount = ev.stutter.behindCount || tl.stutter.length || 0;
  const causes = [];
  const undetermined = [];
  const caveats = [];

  /* ---------- 1. GC 停顿 ---------- */
  let gcLevel = null;
  if (stutterCount > 0) {
    if (corr.gcMatched >= 3 && corr.gcRate >= 0.5 && corr.lift >= 0.25) gcLevel = 'high';
    else if (corr.gcMatched >= 2 && corr.gcRate >= 0.25 && corr.lift >= 0.1) gcLevel = 'medium';
    else if (corr.gcMatched >= 1 && corr.gcRate >= 0.1) gcLevel = 'low';
    else if (!tl.ok && ev.gc.maxPauseMs >= TH.maxPauseBad) gcLevel = 'low';
  }
  if (gcLevel) {
    const parts = [];
    if (corr.gcMatched > 0) {
      parts.push(`${stutterCount} 次卡顿里有 **${corr.gcMatched} 次**（${Math.round(corr.gcRate * 100)}%）发生在一段 GC 停顿之后的 ${corr.windowMs}ms 内。`);
      parts.push(`随机重合的期望命中率约 ${Math.round(corr.gcDensity * 100)}%，实际高出 ${Math.round(corr.lift * 100)} 个百分点。`);
    }
    if (ev.gc.maxPauseMs > 0) parts.push(`本次会话 GC ${ev.gc.count} 次，最长单次 ${ev.gc.maxPauseMs}ms，累计 ${ev.gc.totalPauseMs}ms。`);
    if (!tl.ok) parts.push('日志行没有时间戳，无法做时序关联 —— 这里只依据"停顿长度本身已经很严重"。');
    causes.push({
      id: 'gc',
      name: 'GC 停顿',
      confidence: gcLevel,
      basis: tl.ok ? 'timeline' : 'log',
      evidence: parts.join(' '),
      advice: [
        '换 G1 并把停顿目标压到 50ms：`-XX:+UseG1GC -XX:MaxGCPauseMillis=50`。',
        '大内存（≥16G）且 Java 17+ 可以试 `-XX:+UseZGC`，但会更吃内存。',
        '把 -Xms 设成和 -Xmx 一样大，减少堆扩容带来的抖动。',
        '改完到「JVM 实验室」做 A/B 实测，别只看感觉。'
      ]
    });
  } else {
    undetermined.push({
      id: 'gc',
      name: 'GC 停顿',
      why: stutterCount === 0
        ? '日志里没有卡顿记录，不需要归因。'
        : (ev.gc.count === 0
          ? '日志里**没有 GC 记录** —— 启动参数没开 `-Xlog:gc`，看不到停顿，也就不能说它有关系。'
          : `有 ${ev.gc.count} 次 GC，但与卡顿在时间上对不上（命中 ${corr.gcMatched}/${stutterCount} 次，未超过随机重合基线）。`),
      advice: ev.gc.count === 0
        ? ['想要 GC 证据，在 JVM 参数里加 `-Xlog:gc*:file=logs/gc.log:time,uptime:filecount=3,filesize=8M`，玩一局再看。']
        : ['GC 不是这次卡顿的主因，继续看下面几条。']
    });
  }

  /* ---------- 2. 区块加载 / 生成 ---------- */
  let ckLevel = null;
  if (stutterCount > 0 && tl.chunk.length) {
    if (corr.chunkMatched >= 3 && corr.chunkRate >= 0.4) ckLevel = 'high';
    else if (corr.chunkMatched >= 1 && corr.chunkRate >= 0.15) ckLevel = 'medium';
  }
  if (ckLevel) {
    causes.push({
      id: 'chunk',
      name: '区块加载 / 生成',
      confidence: ckLevel,
      basis: 'timeline',
      evidence: `${stutterCount} 次卡顿里有 **${corr.chunkMatched} 次**（${Math.round(corr.chunkRate * 100)}%）紧跟在区块加载/预生成之后 ${corr.windowMs}ms 内。日志里共有 ${tl.chunk.length} 条区块加载事件。`,
      advice: [
        '区块生成是 CPU 单线程重活，跨维度传送、首次进服、快速飞行都会触发。',
        '把渲染距离从 16 降到 10–12，是最直接的减负。',
        '大地图用 SSD；机械盘上加载区块会明显更痛。',
        '如果是服务器，考虑预生成地图（chunky 之类的工具）。'
      ]
    });
  }

  /* ---------- 3. 内存不足（OOM 是硬证据，不需要时序） ---------- */
  if (ev.oom) {
    causes.push({
      id: 'oom',
      name: '内存不足（已发生 OOM）',
      confidence: 'high',
      basis: 'log',
      evidence: '日志里出现了 OutOfMemoryError / Java heap space / GC overhead limit exceeded。',
      advice: [
        '这是硬性内存不够，不是"优化"能解决的 —— 加 -Xmx 是唯一正解。',
        '大型整合包 8–10G，原版 4G 就够；别把物理内存全给 MC。',
        '-Xmx 已经很大还 OOM，多半是某个 mod 泄漏，用二分法禁用 mod 定位。'
      ]
    });
  }

  /* ---------- 4. 渲染 / 着色器 ---------- */
  if (ev.shaderWarn && stutterCount > 0) {
    causes.push({
      id: 'render',
      name: '渲染 / 着色器',
      confidence: 'low',
      basis: 'log',
      evidence: '日志里有着色器编译 / 加载相关的告警，同时存在卡顿记录。注意：这只是"渲染链路可能有问题"，日志里没有帧时间数据能证明它就是卡顿来源。',
      advice: [
        '先用原版（不加载光影）跑一局确认基线帧率。',
        '换轻量光影或降低光影质量档位。',
        '确认显卡驱动是最新的（别用 Windows 自动装的旧驱动）。'
      ]
    });
  }

  /* ---------- 5. 明确"没有证据，不下结论"的几项 ---------- */
  undetermined.push({
    id: 'entities',
    name: '实体 / 掉落物过多',
    why: (Number(inp.entityMax) || 0) > 0
      ? `存档里单区块最多 ${Number(inp.entityMax)} 个实体 —— 这是**静态证据**，日志里没有把它和某一次具体卡顿对应起来的记录，所以不能断定是它。`
      : '没有提供存档目录，看不到实体分布；日志也不记录实体数。',
    advice: [
      '到「世界」页的地图预览看实体热点红框，确认聚集区。',
      '清理掉落物：`/kill @e[type=item]`；限制刷怪塔产出。',
      '想看实证就用 spark：`/spark profiler --timeout 30`，它会给出每个 mod / 每类实体的耗时占比。'
    ]
  });
  undetermined.push({
    id: 'mods',
    name: 'Mod 内部 tick 耗时',
    why: '日志不记录单个 mod 的 tick 耗时。没有 profiler 数据就指认某个 mod，属于猜测。',
    advice: [
      '用 spark（`/spark profiler --timeout 30`）或 Observable 抓一次采样。',
      '二分法：禁用一半 mod 跑一局，看卡顿是否消失。',
      '重点怀疑：大型科技模组、动态结构、频繁方块更新的机器。'
    ]
  });
  undetermined.push({
    id: 'gpu',
    name: '显卡 / 驱动瓶颈',
    why: '日志和存档里都没有 GPU 占用、帧时间、温度数据，无法判断。',
    advice: [
      '开任务管理器 → 性能 → GPU，看 Minecraft 运行时 GPU 占用是否长期 95%+。',
      '装伴随 Mod 后可以拿到真实 FPS / 帧时间，再回来看这一页。'
    ]
  });
  undetermined.push({
    id: 'disk',
    name: '磁盘 I/O 慢',
    why: '日志不记录磁盘等待时间，只有"区块加载慢"这种间接现象。',
    advice: ['确认存档在 SSD 上；用资源监视器看 Minecraft 进程的磁盘队列长度。']
  });

  /* ---------- 说明 ---------- */
  if (stutterCount === 0) {
    caveats.push('日志里没有 `Can\'t keep up!` 记录 —— 本次会话没有可归因的卡顿。');
  }
  if (!tl.ok && stutterCount > 0) {
    caveats.push('日志行**不带时间戳**（被裁剪过，或不是标准格式），无法做时序关联，只能给静态判断。');
  }
  if (ev.gc.count === 0 && stutterCount > 0) {
    caveats.push('没有 GC 记录：要么没开 `-Xlog:gc`，要么这次会话确实没触发 GC。前者更常见。');
  }

  const order = { high: 0, medium: 1, low: 2 };
  causes.sort((a, b) => order[a.confidence] - order[b.confidence]);

  return {
    ok: true,
    stutterCount,
    spanMs: tl.spanMs,
    timeline: {
      ok: tl.ok,
      gcCount: tl.gc.length,
      stutterCount: tl.stutter.length,
      chunkCount: tl.chunk.length,
      firstT: tl.firstT,
      lastT: tl.lastT
    },
    correlation: corr,
    causes,
    undetermined,
    caveats
  };
}

/* ==================================================================
 * 九、两次会话对比
 * ==================================================================
 * 用 `logs/` 里轮转出来的历史日志（`2026-10-01-1.log.gz`）和 `latest.log` 对比，
 * 回答"昨天改完参数到底有没有变好"。
 *
 * 判定要保守：变化幅度小于 2% 一律算「持平」，不把噪声当成果。
 */

/**
 * 把一份日志（+ 可选帧样本）压成可比较的会话摘要。
 * @param {{label?:string, logText?:string, samples?:Array<object>, frameOpts?:object}} input
 */
function summarizeSession(input) {
  const inp = /** @type {any} */ (input || {});
  const logText = String(inp.logText || '');
  const ev = extract(logText);
  const tl = parseLogTimeline(logText);
  return {
    label: String(inp.label || ''),
    lines: ev.lines,
    spanMs: tl.spanMs,
    hasTimeline: tl.ok,
    gc: ev.gc,
    stutter: ev.stutter,
    oom: ev.oom,
    chunkPct: ev.chunkPct,
    shaderWarn: ev.shaderWarn,
    frames: frameStats(inp.samples || [], inp.frameOpts)
  };
}

// dir: 'up' = 越高越好，'down' = 越低越好，'none' = 只报变化不下判断
const COMPARE_ROWS = [
  { key: 'avgFps', name: '平均帧率', unit: 'fps', dir: 'up', get: (s) => s.frames.avgFps },
  { key: 'p50', name: '帧时间 P50', unit: 'ms', dir: 'down', get: (s) => s.frames.p50 },
  { key: 'p95', name: '帧时间 P95', unit: 'ms', dir: 'down', get: (s) => s.frames.p95 },
  { key: 'p99', name: '帧时间 P99', unit: 'ms', dir: 'down', get: (s) => s.frames.p99 },
  { key: 'longRatio', name: '长帧占比', unit: '%', dir: 'down', get: (s) => (s.frames.available ? s.frames.longRatio * 100 : null) },
  { key: 'gcCount', name: 'GC 次数', unit: '次', dir: 'down', get: (s) => s.gc.count },
  { key: 'gcMax', name: '最长 GC 停顿', unit: 'ms', dir: 'down', get: (s) => s.gc.maxPauseMs },
  { key: 'stutter', name: '卡顿次数', unit: '次', dir: 'down', get: (s) => s.stutter.behindCount },
  { key: 'worst', name: '最严重落后', unit: 'ms', dir: 'down', get: (s) => s.stutter.worstBehindMs },
  { key: 'lines', name: '日志行数', unit: '', dir: 'none', get: (s) => s.lines }
];

/**
 * 对比两个会话摘要（a = 之前，b = 之后）。
 * @param {object} a
 * @param {object} b
 * @returns {{ok:boolean, a:object, b:object, rows:Array<object>, better:number,
 *   worse:number, overall:string, caveats:string[]}}
 */
function compareSessions(a, b) {
  const A = a || /** @type {any} */ ({});
  const B = b || /** @type {any} */ ({});
  const rows = [];
  let better = 0;
  let worse = 0;

  for (const r of COMPARE_ROWS) {
    let va = null;
    let vb = null;
    try { va = r.get(A); } catch { va = null; }
    try { vb = r.get(B); } catch { vb = null; }
    const okA = Number.isFinite(va);
    const okB = Number.isFinite(vb);

    /** @type {any} */
    const row = {
      key: r.key, name: r.name, unit: r.unit, dir: r.dir,
      a: okA ? Math.round(va * 10) / 10 : null,
      b: okB ? Math.round(vb * 10) / 10 : null,
      delta: null, pct: null, verdict: 'na'
    };

    if (okA && okB) {
      const d = vb - va;
      row.delta = Math.round(d * 10) / 10;
      // 相对变化：以 a 的绝对值为基准；a 为 0 时没有百分比可言
      row.pct = va !== 0 ? Math.round((d / Math.abs(va)) * 1000) / 10 : null;
      // 2% 或 0.5 个单位的容差 —— 小样本下的抖动不该被当成"变好了"
      const eps = Math.max(0.5, Math.abs(va) * 0.02);
      if (Math.abs(d) <= eps) {
        row.verdict = 'same';
      } else if (r.dir === 'none') {
        row.verdict = 'changed';
      } else {
        const improved = r.dir === 'up' ? d > 0 : d < 0;
        row.verdict = improved ? 'better' : 'worse';
        if (improved) better++; else worse++;
      }
    }
    rows.push(row);
  }

  const overall = better === 0 && worse === 0 ? 'same' : (better > worse ? 'better' : (worse > better ? 'worse' : 'mixed'));
  const caveats = [];
  if (!A.frames || !A.frames.available || !B.frames || !B.frames.available) {
    caveats.push('至少一侧没有帧率样本，帧相关的行会是「不可比」。日志只能比 GC 与卡顿。');
  }
  if (A.lines && B.lines && Math.abs(A.lines - B.lines) > Math.max(A.lines, B.lines) * 0.5) {
    caveats.push('两份日志长度相差很大，统计口径可能不可比（玩的时间不一样长）。');
  }

  return {
    ok: true,
    a: { label: A.label || '', lines: A.lines || 0, spanMs: A.spanMs || 0, frames: A.frames || null },
    b: { label: B.label || '', lines: B.lines || 0, spanMs: B.spanMs || 0, frames: B.frames || null },
    rows, better, worse, overall, caveats
  };
}

module.exports = {
  extract, diagnose, systemProfile, parseJvmArgs,
  frameStats, percentileOf, FRAME_EDGES,
  parseLogTimeline, correlateEvents, attributeStutter,
  summarizeSession, compareSessions, COMPARE_ROWS,
  RULES, TH
};
