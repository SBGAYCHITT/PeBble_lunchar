'use strict';
/**
 * livemetrics.js — 游戏运行时指标（悬浮窗的数据链路）
 *
 * 背景：规划里的「游戏内悬浮窗」原本要求写一个伴随 Mod。但 Mod 只能由用户自己用
 * JDK + Gradle 构建，本仓库无法随包附带编译产物。所以这里把功能**拆成两层**，
 * 让它在**没有任何 Mod 的情况下也能立刻用**：
 *
 *   数据源 A（零依赖，默认可用）：增量读 `logs/latest.log`
 *     - `Can't keep up! Running Nms or M ticks behind` → 卡顿（落后）曲线
 *     - `-Xlog:gc` 的行（若启动参数里开了）→ 堆占用曲线
 *     - 进程存活 / 退出时间
 *     ✅ 只要开过游戏就有数据，不需要装任何东西。
 *
 *   数据源 B（可选增强，装了伴随 Mod 才有）：行式 JSON 文件 `pebble-metrics.jsonl`
 *     - FPS / TPS / 堆用量 / 实体数 / 区块数 / 维度
 *     - 协议见 `SPEC`，参考实现见仓库 `companion-mod/`
 *
 * 设计约束：
 *   - 解析与统计**全是纯函数 / 纯内存结构**，单测直接喂文本与样本对象；只有
 *     `MetricsBuffer` 涉及时间，也是可注入的。
 *   - **不假装**：日志推算不出真实 FPS。源 A 只报"落后程度"与"卡顿健康度"，
 *     FPS/TPS 这类精确值明确标注为需要 Mod，不拿估算值冒充实测。
 *
 * ⚠️ 坑：`Can't keep up!` 有两种句式 ——
 *   `Running 2500ms behind` 与 `Running 2500ms or 50 ticks behind`。
 *   正则**不能**写成 `Running\s+(\d+)ms\s+behind`（第二种句式就匹配不上），
 *   必须用 `Running\s+(\d+)ms` 且 ticks 部分可选。
 */

/* ================= 协议 ================= */

/**
 * 伴随 Mod 需要写入的行式 JSON 协议（每行一个 JSON 对象，UTF-8，按行追加）。
 *
 * 文件位置（由启动器通过系统属性告知 Mod）：
 *   `<实例目录>/pebble-metrics.jsonl`
 *
 * 字段（全部可选，缺的按 null 处理；`t` 为毫秒时间戳）：
 * ```
 * {
 *   "t": 1696000000000,   // 采样时间（ms）
 *   "fps": 142,           // 帧率
 *   "tps": 20.0,          // 服务端 tick 率（单人存档也有）
 *   "mspt": 12.3,         // 每 tick 毫秒数
 *   "mem": 1234567890,    // 已用堆内存（字节）
 *   "memMax": 4294967296, // 堆上限（字节）
 *   "entities": 1234,     // 已加载实体数
 *   "chunks": 441,        // 已加载区块数
 *   "players": 1,         // 在线玩家数
 *   "dim": "overworld"    // 当前维度
 * }
 * ```
 */
const SPEC = {
  fileName: 'pebble-metrics.jsonl',
  metaKey: 'pebble.metrics.path',
  intervalMs: 1000,
  fields: ['t', 'fps', 'tps', 'mspt', 'mem', 'memMax', 'entities', 'chunks', 'players', 'dim']
};

/** 可能出现在样本里的数值指标 */
const METRICS = ['fps', 'tps', 'mspt', 'mem', 'memMax', 'entities', 'chunks', 'players'];

/* ================= 解析 ================= */

/**
 * 解析伴随 Mod 写出的一行。
 * @param {string} line
 * @returns {{t:number|null, fps:number|null, tps:number|null, mspt:number|null,
 *   mem:number|null, memMax:number|null, entities:number|null, chunks:number|null,
 *   players:number|null, dim:string|null}|null} 无法解析时返回 null
 */
function parseModLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!s || s.charAt(0) !== '{') return null;
  let o;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;

  const num = v => {
    // ⚠️ 必须先挡掉 null/undefined/空串 —— `Number(null)` 是 0，
    // 会把"这一项没有读数"变成"读数是 0"，在内存/实体数上完全是两回事
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  // 逐字段赋值，先给个 any 兜住 —— `@returns` 声明的是完整形状，
  // 直接写对象字面量会因为"缺字段"报 TS2740
  const out = /** @type {any} */ ({ t: num(o.t), dim: typeof o.dim === 'string' ? o.dim : null });
  for (const k of METRICS) out[k] = num(o[k]);
  if (out.t === null && out.fps === null && out.tps === null && out.mem === null) return null;
  return out;
}

/**
 * 解析一段日志文本里的「落后」与「GC」信息。
 *
 * 只解析**能确定含义**的两类行，其余原样忽略 —— 宁可少报也不误报。
 *
 * @param {string} text
 * @returns {{lag:Array<{t:number|null, ms:number, ticks:number|null}>,
 *   gc:Array<{t:number|null, used:number, total:number, max:number}>}}
 */
function parseLogChunk(text) {
  const out = { lag: [], gc: [] };
  if (typeof text !== 'string' || !text) return out;

  // 日志行前缀的时间戳：[2026-10-02T11:00:00.100+0800]
  const TS = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{4})?)\]/;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const mTs = TS.exec(raw);
    let t = null;
    if (mTs) {
      const v = Date.parse(mTs[1]);
      if (Number.isFinite(v)) t = v;
    }

    // 卡顿：两种句式都吃
    if (raw.indexOf("Can't keep up!") >= 0) {
      const m = /Running\s+(\d+)ms(?:\s+or\s+(\d+)\s+ticks?)?\s+behind/.exec(raw);
      if (m) {
        out.lag.push({
          t,
          ms: Number(m[1]),
          ticks: m[2] === undefined ? null : Number(m[2])
        });
      }
      continue;
    }

    // GC：Java 9+ 统一日志 `GC(12) Pause Young ... 512M->128M(2048M) 12.3ms`
    if (/\[gc\]|\[gc,/.test(raw) || /GC\(\d+\)/.test(raw)) {
      const g = /(\d+)M->(\d+)M\((\d+)M\)/.exec(raw);
      if (g) {
        out.gc.push({
          t,
          used: Number(g[2]) * 1024 * 1024,
          total: Number(g[3]) * 1024 * 1024,
          max: Number(g[3]) * 1024 * 1024
        });
      }
    }
  }
  return out;
}

/**
 * 卡顿健康度（0–100，越高越好）。
 *
 * 只看「落后」样本：次数越多、单次落后越久，分越低。
 * 这是**从日志能得到的唯一可靠信号**，别拿它当 FPS。
 *
 * @param {Array<{ms:number}>} lag
 * @param {{spanMs?:number}} [opts] spanMs = 采样覆盖的时间跨度，用于算发生频率
 * @returns {{score:number, grade:string, count:number, worstMs:number, avgMs:number, eventsPerHour:number|null}}
 */
function lagHealth(lag, opts) {
  const list = (Array.isArray(lag) ? lag : []).filter(x => x && Number.isFinite(x.ms));
  if (!list.length) {
    return { score: 100, grade: 'good', count: 0, worstMs: 0, avgMs: 0, eventsPerHour: null };
  }
  let sum = 0, worst = 0;
  for (const x of list) { sum += x.ms; if (x.ms > worst) worst = x.ms; }
  const avg = sum / list.length;

  const opt = /** @type {any} */ (opts || {});
  const span = Number(opt.spanMs);
  const eventsPerHour = Number.isFinite(span) && span > 0 ? list.length / (span / 3600000) : null;

  // 单次落后 5000ms 视为"非常严重"，按对数刻度给分；频率同样计入
  const sev = Math.min(1, Math.log10(1 + worst / 100) / Math.log10(1 + 5000 / 100));
  const freq = eventsPerHour === null ? 0.4 : Math.min(1, eventsPerHour / 60);
  let score = Math.round(100 - (sev * 55 + freq * 45));
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  const grade = score >= 90 ? 'good' : score >= 70 ? 'fair' : score >= 40 ? 'poor' : 'bad';
  return { score, grade, count: list.length, worstMs: worst, avgMs: Math.round(avg * 10) / 10, eventsPerHour };
}

/* ================= 环形缓冲与统计 ================= */

/**
 * 有界采样缓冲。按时间窗保留最新样本，超出的自动丢弃。
 *
 * 用固定容量数组 + 覆盖写，避免长时间运行时数组无限增长
 * （一次玩几小时、每秒一个样本 = 上万个点，全留着画图也会卡）。
 */
class MetricsBuffer {
  /**
   * @param {{capacity?:number, now?:()=>number}} [opts]
   *   `now` 可注入，便于单测控制时间
   */
  constructor(opts) {
    const o = /** @type {any} */ (opts || {});
    this.capacity = Math.max(1, o.capacity || 7200);
    this._now = typeof o.now === 'function' ? o.now : () => Date.now();
    /** @type {Array<object>} */
    this._items = [];
    this._dropped = 0;
  }

  /** 当前样本数 */
  get size() { return this._items.length; }

  /** 因超出容量被丢弃的样本数 */
  get dropped() { return this._dropped; }

  /**
   * 追加一个样本。缺 `t` 时用注入的时钟补上。
   * @param {object} sample
   * @returns {object} 实际存入的样本
   */
  push(sample) {
    if (!sample || typeof sample !== 'object') return null;
    const s = { t: Number.isFinite(sample.t) ? sample.t : this._now() };
    for (const k of METRICS) s[k] = Number.isFinite(sample[k]) ? sample[k] : null;
    s.dim = typeof sample.dim === 'string' ? sample.dim : null;
    this._items.push(s);
    while (this._items.length > this.capacity) { this._items.shift(); this._dropped++; }
    return s;
  }

  /** 清空 */
  clear() { this._items = []; this._dropped = 0; }

  /** 全部样本（副本） */
  all() { return this._items.slice(); }

  /** 最后一个样本 */
  last() { return this._items.length ? this._items[this._items.length - 1] : null; }

  /**
   * 取时间窗内的样本。
   * @param {number} ms 窗口长度
   * @returns {Array<object>}
   */
  window(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return this.all();
    const last = this.last();
    if (!last) return [];
    const from = last.t - n;
    return this._items.filter(s => s.t >= from);
  }

  /**
   * 某个指标的时间序列（用于画曲线），可降采样。
   * @param {string} key
   * @param {{maxPoints?:number, winMs?:number}} [opts]
   * @returns {Array<{t:number, v:number}>}
   */
  series(key, opts) {
    const o = /** @type {any} */ (opts || {});
    const src = o.winMs ? this.window(o.winMs) : this.all();
    const pts = src
      .filter(s => Number.isFinite(s[key]))
      .map(s => ({ t: s.t, v: s[key] }));
    const max = Number(o.maxPoints);
    if (!Number.isFinite(max) || max <= 1 || pts.length <= max) return pts;
    return downsample(pts, max);
  }

  /**
   * 某个指标的统计摘要。
   * @param {string} key
   * @param {{winMs?:number}} [opts]
   * @returns {{count:number, min:number|null, max:number|null, avg:number|null,
   *   p95:number|null, last:number|null}}
   */
  summary(key, opts) {
    const o = /** @type {any} */ (opts || {});
    const src = o.winMs ? this.window(o.winMs) : this.all();
    const out = summarize(src.filter(s => Number.isFinite(s[key])).map(s => s[key]));
    // `last` 要的是"最新一次读数"，不能取排序后的末位（那是最大值）
    const tail = src.length ? src[src.length - 1] : null;
    out.last = tail && Number.isFinite(tail[key]) ? tail[key] : null;
    return out;
  }
}

/**
 * 把一串数值做成统计摘要（只按数值统计，不含时间语义）。
 * `last` 由 `MetricsBuffer.summary` 用真实的最新样本覆盖。
 * @param {number[]} values
 * @returns {{count:number, min:number|null, max:number|null, avg:number|null,
 *   p95:number|null, last:number|null}}
 */
function summarize(values) {
  const a = (Array.isArray(values) ? values : []).filter(v => Number.isFinite(v)).slice().sort((x, y) => x - y);
  if (!a.length) return { count: 0, min: null, max: null, avg: null, p95: null, last: null };
  let sum = 0;
  for (const v of a) sum += v;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(a.length * 0.95) - 1));
  return {
    count: a.length,
    min: a[0],
    max: a[a.length - 1],
    avg: Math.round((sum / a.length) * 100) / 100,
    p95: a[idx],
    last: null
  };
}

/**
 * 把序列按时间等分桶后取均值，压到 maxPoints 个点。
 * 画图前必做 —— 几千个点直接丢给 canvas 又慢又看不出东西。
 *
 * @param {Array<{t:number, v:number}>} pts 需按 t 升序
 * @param {number} maxPoints
 * @returns {Array<{t:number, v:number}>}
 */
function downsample(pts, maxPoints) {
  const list = Array.isArray(pts) ? pts : [];
  const max = Math.max(1, Number(maxPoints) || 1);
  if (list.length <= max) return list.slice();

  const t0 = list[0].t;
  const t1 = list[list.length - 1].t;
  const span = t1 - t0;
  if (!(span > 0)) return list.slice(0, max);

  const buckets = [];
  for (let i = 0; i < max; i++) buckets.push({ sum: 0, n: 0, t: t0 + (span * (i + 0.5)) / max });
  for (const p of list) {
    let i = Math.floor(((p.t - t0) / span) * max);
    if (i < 0) i = 0;
    if (i >= max) i = max - 1;
    buckets[i].sum += p.v;
    buckets[i].n++;
  }
  const out = [];
  for (const b of buckets) {
    if (b.n > 0) out.push({ t: Math.round(b.t), v: Math.round((b.sum / b.n) * 100) / 100 });
  }
  return out;
}

/**
 * 综合当前状态，给一句人话结论。
 * @param {{fps?:object, tps?:object, mem?:object, lagHealth?:object, hasMod?:boolean}} o
 * @returns {{level:string, title:string, detail:string}}
 */
function verdict(o) {
  const x = /** @type {any} */ (o || {});
  const has = x.hasMod;
  const fpsAvg = x.fps && Number.isFinite(x.fps.avg) ? x.fps.avg : null;
  const tpsAvg = x.tps && Number.isFinite(x.tps.avg) ? x.tps.avg : null;
  const lag = x.lagHealth || {};

  if (tpsAvg !== null && tpsAvg < 15) {
    return { level: 'error', title: '服务端 tick 跟不上', detail: `平均 TPS ${tpsAvg}，低于 15。世界逻辑在变慢，检查实体数量与红石装置。` };
  }
  if (fpsAvg !== null && fpsAvg < 30) {
    return { level: 'warn', title: '帧率偏低', detail: `平均 FPS ${fpsAvg}。显卡或渲染设置是瓶颈，可降低渲染距离与视场。` };
  }
  if (lag.score !== undefined && lag.score < 70) {
    return { level: 'warn', title: '出现过明显卡顿', detail: `落后 ${lag.count} 次，最长 ${lag.worstMs}ms。多为区块加载或实体过多的瞬时毛刺。` };
  }
  if (fpsAvg === null && tpsAvg === null) {
    return {
      level: 'info',
      title: '仅有日志级指标',
      detail: '当前没有检测到伴随 Mod 的数据，只能看到卡顿记录。装上伴随 Mod 后可获得 FPS / TPS / 内存曲线。'
    };
  }
  return { level: 'good', title: '运行状态良好', detail: has ? '各项指标都在正常范围。' : '日志里没有发现卡顿记录。' };
}

module.exports = {
  SPEC, METRICS,
  parseModLine, parseLogChunk, lagHealth,
  MetricsBuffer, summarize, downsample, verdict
};
