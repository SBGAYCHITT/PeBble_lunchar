// 性能诊断与优化 IPC 聚合（V4 第三组）：
//   - 性能诊断     perfdoctor（日志 + 存档 + 系统规格 → 分级 findings）
//   - 自动调参     perfautotune（系统画像 + 存档规模 + 诊断结果 → JVM 参数建议）
//   - 帧时间分布   perfdoctor.frameStats（V5 第三组：分位数 / 直方图 / 长帧占比）
//   - 卡顿归因     perfdoctor.attributeStutter（时序关联，没证据就标"未确定"）
//   - 会话对比     perfdoctor.compareSessions（改完参数到底有没有变好）
//
// 设计要点：
//   1) 诊断需要「日志 + 存档规模」两路证据，这里把它们合起来取，调用方只发一个请求。
//   2) latest.log 只读尾部（默认 512KB）—— 大整合包的日志能到几十 MB，
//      整读既慢又没必要（GC 统计看最近一段就够）。归因要时序，放宽到 2MB。
//   3) 全程只读：**不写任何配置**。参数建议由用户看过再自己应用。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const perfdoctor = require('../perfdoctor');
const perfautotune = require('../perfautotune');
const livemetrics = require('../livemetrics');
const worldmap = require('../worldmap');
const worlddb = require('../worlddb');
const { safe } = require('./util');

/** 读日志尾部：默认 512KB。文件不存在 / 读失败都返回空串，不抛。 */
function readTail(p, maxBytes) {
  try {
    const max = maxBytes || 512 * 1024;
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - max);
    const len = st.size - start;
    if (len <= 0) return '';
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** 找 gameDir 下的 latest.log（版本隔离时在 <gameDir>/logs/latest.log） */
function latestLogPath(gameDir) {
  if (!gameDir) return null;
  const p = path.join(gameDir, 'logs', 'latest.log');
  return fs.existsSync(p) ? p : null;
}

/** 找一个存档目录下的规模数据（区块数 / 实体峰值 / 容器数）。取不到就返回零值。 */
async function probeSave(saveDir) {
  const out = { saveChunks: 0, entityMax: 0, containerCount: 0 };
  if (!saveDir) return out;
  try {
    const map = await worldmap.scan({ saveDir, dim: 'overworld', layer: 'blocks' });
    out.saveChunks = (map && map.total) || 0;
    out.entityMax = (map && map.entityMax) || 0;
  } catch { /* 存档不完整时忽略规模数据 */ }
  try {
    const one = await worlddb.scanSave({ saveDir });
    out.containerCount = (one && one.containers && one.containers.length) || 0;
  } catch { /* 同上 */ }
  return out;
}

/** 伴随 Mod 的落盘位置（与 ipc/livemetrics 同一份协议） */
function metricsPath(gameDir) {
  return gameDir ? path.join(gameDir, livemetrics.SPEC.fileName) : null;
}

/**
 * 读 JSONL 尾部样本。逐行 parse，丢掉解析不了的行（Mod 正在写最后一行时是半截）。
 * @param {string} p
 * @param {number} limit
 * @returns {{samples:Array<object>, lines:number, bad:number}}
 */
function readSamples(p, limit) {
  const out = { samples: [], lines: 0, bad: 0 };
  if (!p) return out;
  const text = readTail(p, 4 * 1024 * 1024);
  if (!text) return out;
  const buf = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    out.lines++;
    const one = livemetrics.parseModLine(s);
    if (!one) { out.bad++; continue; }
    buf.push(one);
  }
  out.samples = buf.slice(-Math.max(1, limit));
  return out;
}

/** `<gameDir>/logs` 目录，没有就 null */
function logsDirOf(gameDir) {
  if (!gameDir) return null;
  const d = path.join(gameDir, 'logs');
  try { return fs.statSync(d).isDirectory() ? d : null; } catch { return null; }
}

/**
 * 列出 logs/ 下的日志（含轮转出来的 .log.gz），按修改时间倒序。
 * @param {string} gameDir
 * @returns {Array<{file:string, gz:boolean, bytes:number, mtime:number, current:boolean}>}
 */
function listSessions(gameDir) {
  const dir = logsDirOf(gameDir);
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = /^(.+)\.log(\.gz)?$/i.exec(name);
    if (!m) continue;
    let st;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({
      file: name,
      gz: !!m[2],
      bytes: st.size,
      mtime: st.mtimeMs,
      current: /^latest\.log$/i.test(name)
    });
  }
  // latest.log 永远排最前（它是"当前会话"），其余按修改时间倒序。
  // 只按 mtime 排会有个坑：刚启动时 latest.log 和刚轮转出来的 gz 可能落在同一毫秒，
  // 顺序变成随机，"默认选最新两份"就会选错。
  out.sort((a, b) => (Number(b.current) - Number(a.current)) || (b.mtime - a.mtime));
  return out.slice(0, 40);
}

/**
 * 读一份日志（自动解 gz）。超过 16MB 直接放弃 —— 那种体积的日志解析起来会把 UI 卡死。
 * @param {string} file
 * @returns {string}
 */
function readLogFile(file) {
  const st = fs.statSync(file);
  if (st.size > 16 * 1024 * 1024) return '';
  const buf = fs.readFileSync(file);
  if (/\.gz$/i.test(file)) return zlib.gunzipSync(buf).toString('utf8');
  return buf.toString('utf8');
}

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  /** 本机性能画像（内存 / 核数 / 平台） */
  ipcMain.handle('perf-profile', safe(() => {
    const prof = perfdoctor.systemProfile();
    const mem = require('../jvmlab').recommendMem(prof.totalGB);
    return Object.assign({}, prof, { memAdviceGB: mem.gb, memNote: mem.note });
  }));

  /**
   * 综合诊断：日志 + 存档 + 系统规格 → findings。
   * @param {{gameDir?:string, saveDir?:string, xmxMB?:number, javaMajor?:number, logText?:string}} o
   */
  ipcMain.handle('perf-diagnose', safe(async (_e, o) => {
    const opt = o || {};
    const prof = perfdoctor.systemProfile();

    // 日志：优先用调用方直接给的文本（UI 里能贴），否则读 gameDir 的 latest.log 尾部
    let logText = opt.logText || '';
    let logPath = null;
    if (!logText) {
      logPath = latestLogPath(opt.gameDir);
      if (logPath) logText = readTail(logPath);
    }

    // 存档规模
    const size = await probeSave(opt.saveDir);

    // 当前 JVM 参数：从日志里反解（用户可能填了别处的 -Xmx）
    const jvm = perfdoctor.parseJvmArgs(logText);
    const xmxMB = Number(opt.xmxMB) || jvm.xmxMB;

    const result = perfdoctor.diagnose({
      logText,
      entityMax: size.entityMax,
      saveChunks: size.saveChunks,
      containerCount: size.containerCount,
      totalGB: prof.totalGB,
      cpuCores: prof.cpuCores,
      xmxMB,
      javaMajor: Number(opt.javaMajor) || 0
    });

    // 附上证据来源，UI 上要告诉用户「这是从哪看出来的」
    result.sources = {
      logPath, logBytes: logText.length,
      saveDir: opt.saveDir || null,
      size,
      jvm,
      profile: prof
    };
    return result;
  }));

  /**
   * 自动调参：在诊断结果（可选）之上生成 JVM 参数建议。
   * @param {{gameDir?:string, saveDir?:string, totalGB?:number, cpuCores?:number,
   *          javaMajor?:number, chunks?:number, entityMax?:number,
   *          hasOom?:boolean, maxPauseMs?:number, peakHeapMB?:number}} o
   */
  ipcMain.handle('perf-autotune', safe(async (_e, o) => {
    const opt = o || {};
    const prof = perfdoctor.systemProfile();
    const size = await probeSave(opt.saveDir);

    // 没显式给诊断信号时，顺手从日志跑一次诊断，把 OOM / 长停顿带进来
    let sig = {
      hasOom: !!opt.hasOom,
      maxPauseMs: Number(opt.maxPauseMs) || 0,
      peakHeapMB: Number(opt.peakHeapMB) || 0
    };
    if (!sig.hasOom && !sig.maxPauseMs) {
      const lp = latestLogPath(opt.gameDir);
      if (lp) {
        const d = perfdoctor.diagnose({ logText: readTail(lp) });
        sig = perfautotune.fromDiagnosis(d);
      }
    }

    const tuned = perfautotune.tune({
      totalGB: Number(opt.totalGB) || prof.totalGB,
      cpuCores: Number(opt.cpuCores) || prof.cpuCores,
      javaMajor: Number(opt.javaMajor) || 0,
      chunks: Number(opt.chunks) || size.saveChunks,
      entityMax: Number(opt.entityMax) || size.entityMax,
      hasOom: sig.hasOom,
      maxPauseMs: sig.maxPauseMs,
      peakHeapMB: sig.peakHeapMB
    });
    return { ok: true, tune: tuned, profile: prof, size };
  }));

  /** 只解析 JVM 参数行（贴一段日志就能看当前配了什么） */
  ipcMain.handle('perf-parse-args', safe((_e, logText) => perfdoctor.parseJvmArgs(logText || '')));

  /** 规则库（给 UI 展示「都会检查哪些项」） */
  ipcMain.handle('perf-rules', safe(() => perfdoctor.RULES.map((r) => ({
    id: r.id, name: r.name, severity: r.severity, category: r.category
  }))));

  /* ================================================================
   * V5 第三组：性能诊断进阶
   * ================================================================ */

  /**
   * 帧时间分布。数据只可能来自伴随 Mod —— 日志里没有 FPS，这里不估算。
   * @param {{gameDir?:string, winMs?:number, longMs?:number, limit?:number}} o
   */
  ipcMain.handle('perf-frames', safe((_e, o) => {
    const opt = o || {};
    const gameDir = opt.gameDir || '';
    const limit = Math.max(60, Math.min(20000, Number(opt.limit) || 7200));
    const modPath = metricsPath(gameDir);
    const mod = readSamples(modPath, limit);

    // winMs：只看最近一段（全部 = 0）
    let samples = mod.samples;
    const winMs = Number(opt.winMs) || 0;
    if (winMs > 0 && samples.length) {
      const lastT = Number(samples[samples.length - 1].t);
      if (Number.isFinite(lastT)) samples = samples.filter((s) => Number(s.t) >= lastT - winMs);
    }

    const stats = perfdoctor.frameStats(samples, { longMs: Number(opt.longMs) || 0 });
    return Object.assign(stats, {
      ok: true,
      sources: {
        gameDir,
        modPath: mod.samples.length ? modPath : null,
        modLines: mod.lines,
        modBad: mod.bad,
        sampleCount: mod.samples.length,
        usedCount: samples.length,
        winMs
      }
    });
  }));

  /**
   * 卡顿归因：把每次 `Can't keep up!` 和它前面 2 秒内的 GC / 区块加载做时序关联。
   * @param {{gameDir?:string, logText?:string, saveDir?:string, windowMs?:number,
   *          entityMax?:number, saveChunks?:number}} o
   */
  ipcMain.handle('perf-attribute', safe(async (_e, o) => {
    const opt = o || {};
    let logText = opt.logText || '';
    let logPath = null;
    if (!logText) {
      logPath = latestLogPath(opt.gameDir);
      // 归因要时间轴，512KB 可能只覆盖几分钟；放宽到 2MB（仍然只读尾部）
      if (logPath) logText = readTail(logPath, 2 * 1024 * 1024);
    }

    // 存档规模只在调用方没直接给数时才去扫（扫描本身是重活）
    let size = { saveChunks: 0, entityMax: 0, containerCount: 0 };
    const given = Number(opt.entityMax) || Number(opt.saveChunks);
    if (!given) size = await probeSave(opt.saveDir);
    else {
      size.entityMax = Number(opt.entityMax) || 0;
      size.saveChunks = Number(opt.saveChunks) || 0;
    }

    const res = perfdoctor.attributeStutter({
      logText,
      entityMax: size.entityMax,
      saveChunks: size.saveChunks,
      containerCount: size.containerCount,
      windowMs: Number(opt.windowMs) || 0
    });
    res.sources = {
      logPath,
      logBytes: logText.length,
      saveDir: opt.saveDir || null,
      size
    };
    return res;
  }));

  /** 列出可对比的历史日志（logs/*.log 与轮转出来的 logs/*.log.gz） */
  ipcMain.handle('perf-sessions', safe((_e, gameDir) => {
    const dir = logsDirOf(gameDir);
    const modPath = metricsPath(gameDir);
    return {
      ok: true,
      dir,
      sessions: dir ? listSessions(gameDir) : [],
      /** 只有"当前会话"能配上帧样本 —— 历史日志没有对应的 jsonl */
      hasModSamples: !!(modPath && fs.existsSync(modPath))
    };
  }));

  /**
   * 两次会话对比。a / b 只接受 logs/ 下的文件名（不接受任意路径）。
   * @param {{gameDir?:string, a?:string, b?:string}} o
   */
  ipcMain.handle('perf-compare', safe((_e, o) => {
    const opt = o || {};
    const dir = logsDirOf(opt.gameDir);
    if (!dir) return { ok: false, error: '找不到 logs 目录，请先指定游戏目录。' };

    const pick = (name) => {
      const base = path.basename(String(name || ''));
      if (!/^.+\.log(\.gz)?$/i.test(base)) throw new Error('日志文件名不合法：' + name);
      const full = path.join(dir, base);
      if (!fs.existsSync(full)) throw new Error('找不到日志：' + base);
      return full;
    };
    const fa = pick(opt.a);
    const fb = pick(opt.b);

    const build = (file) => {
      const input = { label: path.basename(file), logText: readLogFile(file) };
      // 只有 latest.log 有对应的实时 jsonl；历史 gz 没有帧样本，对比里会标"不可比"
      if (/^latest\.log$/i.test(path.basename(file)) && metricsPath(opt.gameDir)) {
        input.samples = readSamples(metricsPath(opt.gameDir), 7200).samples;
      }
      return perfdoctor.summarizeSession(input);
    };

    const res = perfdoctor.compareSessions(build(fa), build(fb));
    res.files = { a: path.basename(fa), b: path.basename(fb) };
    return res;
  }));
};
