// Pebble Lunchar - JVM 参数自动调优
//
// 和 jvmlab.js 的分工（别搞混）：
//   jvmlab.js        = 「我给了 A、B 两组参数，帮我实测哪个更好」——事后验证
//   perfautotune.js  = 「我这台机器 + 这个存档，一开始该给什么参数」——事前生成
//
// 输入三路（都是本地现成的，零联网）：
//   1) 系统画像：物理内存 / CPU 核数 / 平台
//   2) 存档规模：区块数 / 实体峰值 / 容器数（来自 worldmap + worlddb）
//   3) 诊断结果：perfdoctor.diagnose 的 findings（已经有明确症状就对症下药）
//
// 输出：一组完整 JVM 参数 + 逐条理由 + 风险提示。
//
// ⚠️ 设计约束：**只给建议，不写配置**。
// 自动改 JVM 参数改错了就是「游戏起不来」，必须让用户在 UI 上看见每一处变化再确认。

/** JVM 档位：决定 -Xmx 的基准 */
const TIERS = [
  { id: 'tiny', maxChunks: 2000, label: '小型存档' },
  { id: 'small', maxChunks: 8000, label: '中小型存档' },
  { id: 'medium', maxChunks: 25000, label: '中型存档' },
  { id: 'large', maxChunks: 80000, label: '大型存档' },
  { id: 'huge', maxChunks: Infinity, label: '超大型存档' }
];

/**
 * 纯函数：按存档规模分档。
 * @param {number} chunks 存档区块数
 * @returns {{id:string, label:string}}
 */
function sizeTier(chunks) {
  const n = Number(chunks) || 0;
  const t = TIERS.find((x) => n <= x.maxChunks) || TIERS[TIERS.length - 1];
  return { id: t.id, label: t.label };
}

/**
 * 纯函数：算建议的 -Xmx（MB）。
 *
 * 三条约束同时成立才有意义：
 *   a) 不能超过物理内存的一半（系统要留一半给 OS / 页缓存，超了就开始换页，反而更卡）
 *   b) 存档越大越吃内存（区块缓存、实体表都随规模涨）
 *   c) 不能低于 2G（低于这个数原版都跑不顺）
 *
 * @param {{totalGB:number, chunks:number, entityMax:number, hasOom?:boolean, peakHeapMB?:number}} o
 * @returns {{mb:number, gb:number, reason:string, cappedBy:string}}
 */
function recommendXmx(o) {
  const opt = /** @type {any} */ (o || {});
  const totalGB = Number(opt.totalGB) || 8;
  const chunks = Number(opt.chunks) || 0;
  const entityMax = Number(opt.entityMax) || 0;

  // 基准：按存档规模给
  const tier = sizeTier(chunks);
  const base = { tiny: 2, small: 3, medium: 4, large: 6, huge: 8 }[tier.id];

  let mb = base * 1024;
  let reason = `${tier.label}（${chunks} 区块）基准 ${base}G`;

  // 实体热点多 → 实体表与 tick 缓存更大
  if (entityMax >= 40) {
    mb += 1024;
    reason += `，实体热点 ${entityMax}/区块 再加 1G`;
  }

  // 已经 OOM 过 → 至少比现在的峰值高一档
  if (opt.hasOom) {
    const peak = Number(opt.peakHeapMB) || 0;
    const want = peak > 0 ? Math.ceil(peak / 1024) + 2 : base + 2;
    if (want * 1024 > mb) { mb = want * 1024; reason += `；发生过 OOM，按峰值上浮到 ${want}G`; }
  }

  // 上限：物理内存的一半
  const halfGB = Math.max(2, Math.floor(totalGB / 2));
  let cappedBy = 'none';
  if (mb / 1024 > halfGB) {
    mb = halfGB * 1024;
    cappedBy = 'half-ram';
    reason += `；但受限于物理内存 ${Math.round(totalGB * 10) / 10}G，封顶在 ${halfGB}G（留一半给系统）`;
  }
  if (mb < 2048) { mb = 2048; cappedBy = 'min'; reason += '；已抬到最低 2G'; }

  return { mb, gb: Math.round(mb / 1024 * 10) / 10, reason, cappedBy };
}

/**
 * 纯函数：选 GC 策略。
 * 决策依据（按优先级）：
 *   1) 有严重停顿/OOM → 优先 ZGC（Java 17+）或 G1 + 紧停顿目标
 *   2) 内存紧张（≤8G）→ G1 + 宽松停顿，别选 ZGC（ZGC 吃内存）
 *   3) 核心多（≥8）且不在意偶发卡顿 → Parallel
 *   4) 默认 → G1 平衡
 *
 * @param {{javaMajor:number, totalGB:number, cpuCores:number, hasOom?:boolean, maxPauseMs?:number}} o
 * @returns {{gc:string, args:string, presetId:string, reason:string}}
 */
function recommendGc(o) {
  const opt = /** @type {any} */ (o || {});
  const javaMajor = Number(opt.javaMajor) || 8;
  const totalGB = Number(opt.totalGB) || 8;
  const cores = Number(opt.cpuCores) || 4;
  const maxPause = Number(opt.maxPauseMs) || 0;

  // 有严重停顿或 OOM，且 Java 够新 → ZGC 最稳
  if ((opt.hasOom || maxPause >= 200) && javaMajor >= 17 && totalGB >= 12) {
    const args = javaMajor >= 21
      ? '-XX:+UseZGC -XX:+ZGenerational'
      : '-XX:+UseZGC';
    return { gc: 'ZGC', args, presetId: 'zgc', reason: `有过${opt.hasOom ? 'OOM' : ` ${maxPause}ms 的长停顿`}且内存充足，ZGC 停顿在 1ms 级` };
  }

  // 内存紧张 → 用 G1 且放宽停顿（ZGC 会更吃内存，这里不能选）
  if (totalGB <= 8) {
    return {
      gc: 'G1', presetId: 'lowmem',
      args: '-XX:+UseG1GC -XX:MaxGCPauseMillis=120 -XX:+UseStringDeduplication -XX:G1HeapRegionSize=4M',
      reason: `物理内存 ${Math.round(totalGB * 10) / 10}G 偏紧，用 G1 + 宽松停顿目标，开字符串去重省内存`
    };
  }

  // 核心多且没有严重停顿 → Parallel 换吞吐
  if (cores >= 8 && !opt.hasOom && maxPause > 0 && maxPause < 200) {
    return {
      gc: 'Parallel', presetId: 'parallel',
      args: '-XX:+UseParallelGC -XX:+AlwaysPreTouch',
      reason: `${cores} 核且无明显长停顿，Parallel 吞吐更高`
    };
  }

  return {
    gc: 'G1', presetId: 'g1-balanced',
    args: '-XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ParallelRefProcEnabled',
    reason: '通用最稳档，适合大多数机器'
  };
}

/**
 * 纯函数：生成完整参数建议。
 * @param {{totalGB:number, cpuCores:number, javaMajor:number,
 *          chunks?:number, entityMax?:number, hasOom?:boolean, maxPauseMs?:number, peakHeapMB?:number}} o
 * @returns {{
 *   xmxMB:number, xmsMB:number, args:string, argsArray:string[],
 *   gc:string, presetId:string, tier:object,
 *   reasons:string[], warnings:string[]
 * }}
 */
function tune(o) {
  const opt = /** @type {any} */ (o || {});
  const totalGB = Number(opt.totalGB) || 8;
  const cpuCores = Number(opt.cpuCores) || 4;
  // javaMajor 缺失要先记下来 —— 下面用 || 8 兜底后就没法区分「真的是 Java 8」和「没传」了
  const javaMajorKnown = Number(opt.javaMajor) > 0;
  const javaMajor = javaMajorKnown ? Number(opt.javaMajor) : 8;

  const xmx = recommendXmx({
    totalGB, chunks: opt.chunks, entityMax: opt.entityMax,
    hasOom: opt.hasOom, peakHeapMB: opt.peakHeapMB
  });
  const gcPick = recommendGc({
    javaMajor, totalGB, cpuCores,
    hasOom: opt.hasOom, maxPauseMs: opt.maxPauseMs
  });

  const xmxMB = xmx.mb;
  // Xms 与 Xmx 相等：避免堆反复扩容导致的启动抖动。
  // 但内存紧张时不这么干 —— 一启动就占满一半内存，系统自己会卡。
  const xmsMB = totalGB <= 8 ? Math.min(xmxMB, 2048) : xmxMB;

  const argsArray = [
    `-Xmx${Math.round(xmxMB / 1024 * 10) / 10}G`,
    `-Xms${Math.round(xmsMB / 1024 * 10) / 10}G`,
    ...gcPick.args.split(/\s+/).filter(Boolean)
  ];

  /** @type {string[]} */
  const reasons = [
    `堆大小：${xmx.reason}`,
    `GC 策略：${gcPick.reason}`,
    xmsMB === xmxMB
      ? 'Xms = Xmx：避免堆反复扩容造成的启动抖动'
      : `Xms 只给 ${Math.round(xmsMB / 1024 * 10) / 10}G：内存紧张，一上来就占满一半会让系统自己变卡`
  ];

  /** @type {string[]} */
  const warnings = [];
  if (javaMajor >= 17 && gcPick.gc === 'ZGC' && xmxMB / 1024 > totalGB / 2) {
    warnings.push('ZGC 对内存敏感，如果出现卡顿优先降 -Xmx。');
  }
  if (opt.hasOom && xmx.cappedBy === 'half-ram') {
    warnings.push('已经 OOM 了，但物理内存限制住了堆上限 —— 这种情况建议加内存条，或减少同时运行的整合包 mod。');
  }
  if (cpuCores <= 2) {
    warnings.push(`只有 ${cpuCores} 个逻辑核心，任何 GC 策略的提升都有限，优先降渲染距离。`);
  }
  if (!javaMajorKnown) {
    warnings.push('没法确定 Java 主版本，参数按 Java 8 保守给 —— 建议先在「设置 → Java 路径」里确认版本。');
  }
  // ZGC 的版本门槛提示（jvmlab 的预设也会拦，这里提前告知）
  if (gcPick.gc === 'ZGC' && javaMajor < 17) {
    warnings.push('ZGC 需要 Java 17+，当前版本不满足，已回退到 G1。');
  }

  return {
    xmxMB,
    xmsMB,
    args: argsArray.join(' '),
    argsArray,
    gc: gcPick.gc,
    presetId: gcPick.presetId,
    tier: sizeTier(opt.chunks),
    reasons,
    warnings
  };
}

/**
 * 纯函数：把诊断结果转成 tune 的输入（省得调用方自己抽字段）。
 * @param {object} perfResult perfdoctor.diagnose() 的返回
 * @returns {{hasOom:boolean, maxPauseMs:number, peakHeapMB:number}}
 */
function fromDiagnosis(perfResult) {
  const r = /** @type {any} */ (perfResult || {});
  const ev = (r.evidence && r.evidence.log) || {};
  return {
    hasOom: !!ev.oom,
    maxPauseMs: (ev.gc && ev.gc.maxPauseMs) || 0,
    peakHeapMB: (ev.gc && ev.gc.peakHeapMB) || 0
  };
}

module.exports = {
  tune, recommendXmx, recommendGc, sizeTier, fromDiagnosis, TIERS
};
