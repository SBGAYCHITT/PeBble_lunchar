// 游戏运行时指标 IPC（V4 第三组尾巴 · R13 游戏内悬浮窗的数据链路）
//
// 定位：规划里的「游戏内悬浮窗」需要写一个伴随 Mod，而 Mod 只能由用户自己用
// JDK + Gradle 构建，仓库无法附带编译产物。所以这里把链路拆成**两层数据源**：
//
//   源 A（零依赖，默认就有）：增量读 `<gameDir>/logs/latest.log`
//     - `Can't keep up! Running Nms [or M ticks] behind` → 卡顿曲线
//     - `-Xlog:gc` 的堆占用行（若启动参数里开了）→ 内存曲线
//     ✅ 只要开过游戏就有数据，不需要装任何东西。
//
//   源 B（可选增强，装了伴随 Mod 才有）：`<gameDir>/pebble-metrics.jsonl`
//     - FPS / TPS / MSPT / 堆用量 / 实体数 / 区块数 / 维度（协议见 livemetrics.SPEC）
//
// 设计要点：
//   1) 一次请求把两层读齐，返回 `{ok, hasMod, series, summary, lag, lagHealth, verdict, meta}`。
//      UI 只要定时轮询这一个 channel 就能画全部曲线，不用自己拼三四个调用。
//   2) 日志只读**尾部**（默认 512KB）—— 大整合包的日志能到几十 MB，整读既慢又没必要。
//   3) **不假装**：日志推算不出真实 FPS。源 A 只报"落后程度"和"卡顿健康度"，
//      FPS/TPS 在没有 Mod 时明确返回 null，不拿估算值冒充实测。
const fs = require('fs');
const path = require('path');
const livemetrics = require('../livemetrics');
const { safe } = require('./util');

/** 读文件尾部：文件不存在 / 读失败都返回空串，不抛 */
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

/** `<gameDir>/logs/latest.log`，没有就返回 null */
function latestLogPath(gameDir) {
  if (!gameDir) return null;
  const p = path.join(gameDir, 'logs', 'latest.log');
  return fs.existsSync(p) ? p : null;
}

/** 伴随 Mod 的落盘位置 */
function metricsPath(gameDir) {
  return gameDir ? path.join(gameDir, livemetrics.SPEC.fileName) : null;
}

/**
 * 读 JSONL 尾部若干条样本。
 *
 * 逐行 parse 并**丢掉解析不了的行**（Mod 正在写最后一行时容易读到半截），
 * 只保留最后 `limit` 条 —— 文件最大 5MB，全读进来再截断是浪费。
 * @param {string} p
 * @param {number} limit
 * @returns {{samples:Array<object>, lines:number, bad:number}}
 */
function readSamples(p, limit) {
  const out = { samples: [], lines: 0, bad: 0 };
  const text = readTail(p, 4 * 1024 * 1024);
  if (!text) return out;
  const rows = text.split(/\r?\n/);
  const buf = [];
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].trim();
    if (!line) continue;
    out.lines++;
    const s = livemetrics.parseModLine(line);
    if (!s) { out.bad++; continue; }
    buf.push(s);
  }
  out.samples = buf.slice(-Math.max(1, limit));
  return out;
}

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  /** 协议与能力说明：UI 上要告诉用户「FPS 这条线为什么是空的」 */
  ipcMain.handle('live-spec', safe(() => ({
    ok: true,
    spec: livemetrics.SPEC,
    metrics: livemetrics.METRICS
  })));

  /**
   * 一次取齐两层数据。
   * @param {{gameDir:string, winMs?:number, maxPoints?:number, capacity?:number}} o
   */
  ipcMain.handle('live-snapshot', safe(async (_e, o) => {
    const opt = o || {};
    const gameDir = opt.gameDir;
    if (!gameDir) return { ok: false, error: '没有指定游戏目录。' };

    const winMs = Number(opt.winMs) || 0;
    const maxPoints = Number(opt.maxPoints) || 240;
    const capacity = Math.max(1, Number(opt.capacity) || 7200);

    /* ---------- 源 B：伴随 Mod 的 JSONL ---------- */
    const modPath = metricsPath(gameDir);
    const mod = readSamples(modPath, capacity);
    const hasMod = mod.samples.length > 0;

    const buffer = new livemetrics.MetricsBuffer({ capacity });
    for (const s of mod.samples) buffer.push(s);

    const series = {};
    const summary = {};
    for (const k of livemetrics.METRICS) {
      const opts = { maxPoints };
      if (winMs) opts.winMs = winMs;
      series[k] = buffer.series(k, opts);
      summary[k] = buffer.summary(k, winMs ? { winMs } : undefined);
    }
    const last = buffer.last();

    /* ---------- 源 A：latest.log ---------- */
    const logPath = latestLogPath(gameDir);
    const logText = logPath ? readTail(logPath, 512 * 1024) : '';
    const parsed = livemetrics.parseLogChunk(logText);

    // 发生频率要用"这些卡顿覆盖了多长时间"来算；日志里带时间戳就取首尾差
    const ts = parsed.lag.map((x) => x.t).filter((v) => Number.isFinite(v));
    let spanMs = null;
    if (ts.length >= 2) {
      const lo = Math.min.apply(null, ts);
      const hi = Math.max.apply(null, ts);
      if (hi > lo) spanMs = hi - lo;
    }

    const lagHealth = livemetrics.lagHealth(parsed.lag, spanMs ? { spanMs } : undefined);
    const gcLast = parsed.gc.length ? parsed.gc[parsed.gc.length - 1] : null;

    const vd = livemetrics.verdict({
      fps: summary.fps,
      tps: summary.tps,
      mem: summary.mem,
      lagHealth,
      hasMod
    });

    return {
      ok: true,
      hasMod,
      /** 数据来源：让 UI 能写清楚"这条线来自哪里" */
      sources: {
        logPath,
        logBytes: logText.length,
        modPath: hasMod ? modPath : null,
        modLines: mod.lines,
        modBad: mod.bad,
        sampleCount: buffer.size,
        dropped: buffer.dropped
      },
      last,
      series,
      summary,
      lag: { events: parsed.lag.slice(-80), gc: parsed.gc.slice(-60), gcLast, spanMs },
      lagHealth,
      verdict: vd
    };
  }));

  /** 只解析一段用户贴进来的日志（不带 gameDir 时的兜底，与 perf-parse-args 同思路） */
  ipcMain.handle('live-parse-log', safe((_e, text) => {
    const parsed = livemetrics.parseLogChunk(String(text || ''));
    return {
      ok: true,
      lag: parsed.lag,
      gc: parsed.gc,
      lagHealth: livemetrics.lagHealth(parsed.lag)
    };
  }));
};
