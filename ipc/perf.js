// 性能诊断与优化 IPC 聚合（V4 第三组）：
//   - 性能诊断     perfdoctor（日志 + 存档 + 系统规格 → 分级 findings）
//   - 自动调参     perfautotune（系统画像 + 存档规模 + 诊断结果 → JVM 参数建议）
//
// 设计要点：
//   1) 诊断需要「日志 + 存档规模」两路证据，这里把它们合起来取，调用方只发一个请求。
//   2) latest.log 只读尾部（默认 512KB）—— 大整合包的日志能到几十 MB，
//      整读既慢又没必要（GC 统计看最近一段就够）。
//   3) 全程只读：**不写任何配置**。参数建议由用户看过再自己应用。
const fs = require('fs');
const path = require('path');
const perfdoctor = require('../perfdoctor');
const perfautotune = require('../perfautotune');
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
};
