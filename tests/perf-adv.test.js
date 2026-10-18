// V5 第三组 · 性能诊断进阶的 IPC 运行时测试（不带 Electron）
//
// 纯函数逻辑已经在 perfdoctor.test.js 里覆盖，这里只测「接线」：
//   真读文件 / 解 gz / 列 logs / 路径校验 / 返回结构。
//
// 为什么单独一个文件：
//   ipc-v4.test.js 装配的 ctx 只注册了 V4 的几个域，而 perf 域依赖 worldmap/worlddb
//   （probeSave 会扫存档）。这里给一个只读的最小场景，避免被存档扫描拖慢。
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');

let tmp = '';
const H = {};
const ctx = {
  ipcMain: { handle: (c, f) => { H[c] = f; } },
  emit: () => {},
  userData: path.join(os.tmpdir(), 'pl-perf-adv-userdata')
};

require(path.join(ROOT, 'ipc', 'perf.js'))(ctx);

let pass = 0, fail = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log('  ok   ' + name);
    pass++;
  } catch (e) {
    console.log(' FAIL  ' + name + ' -> ' + e.message);
    fail++;
  }
}
const must = (v, msg) => { if (!v) throw new Error(msg || '期望为真'); return true; };
const need = (c) => { if (!H[c]) throw new Error('通道未注册：' + c); return H[c]; };

/** 带时间戳的日志行 */
function tsAt(sec) {
  return '[' + new Date(Date.UTC(2026, 9, 2, 3, 0, 0) + sec * 1000).toISOString().replace('Z', '+0000') + ']';
}
const gcLine = (s, ms) => `${tsAt(s)}[info][gc] GC(1) Pause Young (Normal) 512M->128M(2048M) ${ms.toFixed(3)}ms`;
const stutterLine = (s, ms) => `${tsAt(s)} [Server thread/WARN]: Can't keep up! Is the server overloaded? Running ${ms}ms behind`;

function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-perf-'));
  const logs = path.join(tmp, 'logs');
  fs.mkdirSync(logs);

  fs.writeFileSync(path.join(tmp, 'pebble-metrics.jsonl'), [
    JSON.stringify({ t: 1000, fps: 60, frames: 60, longFrames: 0 }),
    JSON.stringify({ t: 2000, fps: 50, frames: 50, longFrames: 2 }),
    JSON.stringify({ t: 3000, fps: 30, frames: 30, longFrames: 5 }),
    '{半截行'
  ].join('\n'));

  // 当前会话：5 次卡顿，其中 3 次紧跟 GC
  fs.writeFileSync(path.join(logs, 'latest.log'), [
    gcLine(9.5, 300), stutterLine(10, 1500),
    gcLine(19.5, 280), stutterLine(20, 1400),
    gcLine(29.5, 260), stutterLine(30, 1300),
    stutterLine(40, 500), stutterLine(50, 400)
  ].join('\n'));

  // 历史会话（轮转 + gz）：只有 1 次卡顿、没有 GC
  fs.writeFileSync(path.join(logs, '2026-10-01-1.log.gz'),
    zlib.gzipSync([stutterLine(5, 300)].join('\n')));

  // 放在 logs 外的文件：用来验证路径校验不会读到它
  fs.writeFileSync(path.join(tmp, 'secret.log'), gcLine(0, 10));

  return tmp;
}

(async () => {
  console.log('perf-adv.test');

  setup();

  /* ---------------- perf-frames ---------------- */
  await t('perf-frames：读 jsonl 并给出帧分布（帧计数精确 / 分位数按秒）', async () => {
    const r = await need('perf-frames')(null, { gameDir: tmp });
    must(r.ok, 'ok 应为 true');
    must(r.available, '有 fps 就该有数据');
    must(r.resolution === 'frame-aggregate', '有 frames 时应是 frame-aggregate，实际 ' + r.resolution);
    must(r.percentileBasis === 'second', '没有 frameTimes 时分位数只能来自每秒均值');
    must(r.derived === true, '必须标记为反推');
    must(r.count === 3, '样本数应为 3，实际 ' + r.count);
    must(r.longCount === 7, '长帧计数应为 0+2+5=7，实际 ' + r.longCount);
    must(r.sources.modBad === 1, '半截行应计入 bad，实际 ' + r.sources.modBad);
    must(Array.isArray(r.histogram) && r.histogram.length === 7, '直方图应有 7 个桶');
  });

  await t('perf-frames：时间窗过滤只保留最近样本', async () => {
    const r = await need('perf-frames')(null, { gameDir: tmp, winMs: 1500 });
    must(r.count === 2, '最近 1.5s 内只有 2 个样本，实际 ' + r.count);
  });

  await t('perf-frames：没有 Mod 文件时明确返回"无数据"', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-perf-empty-'));
    const r = await need('perf-frames')(null, { gameDir: empty });
    must(r.available === false, '不能凭空造数据');
    must(r.resolution === 'none');
    must(typeof r.caveat === 'string' && r.caveat.length > 0, '要说明原因');
  });

  /* ---------------- perf-attribute ---------------- */
  await t('perf-attribute：3/5 次卡顿紧跟在 GC 后 → 归因到 GC', async () => {
    const r = await need('perf-attribute')(null, { gameDir: tmp, entityMax: 10, windowMs: 2000 });
    must(r.ok);
    must(r.stutterCount === 5, '卡顿次数应为 5，实际 ' + r.stutterCount);
    must(r.timeline.gcCount === 3, 'GC 事件应为 3，实际 ' + r.timeline.gcCount);
    const gc = (r.causes || []).find((c) => c.id === 'gc');
    must(gc, '应给出 GC 归因');
    must(gc.confidence === 'high', '3/5 且超出基线应为高置信，实际 ' + gc.confidence);
  });

  await t('perf-attribute：实体数没有时序证据 → 只进未确定', async () => {
    const r = await need('perf-attribute')(null, { gameDir: tmp, entityMax: 120 });
    must(!(r.causes || []).some((c) => c.id === 'entities'), '实体不该进结论');
    must((r.undetermined || []).some((c) => c.id === 'entities'), '应出现在未确定里');
  });

  /* ---------------- perf-sessions ---------------- */
  await t('perf-sessions：列出 latest.log 与轮转 gz，标记 gz 与 current', async () => {
    const r = await need('perf-sessions')(null, tmp);
    must(r.ok);
    must(r.sessions.length === 2, '应有 2 份日志，实际 ' + r.sessions.length);
    const gz = r.sessions.find((s) => s.file.endsWith('.log.gz'));
    const cur = r.sessions.find((s) => s.file === 'latest.log');
    must(gz && gz.gz === true, 'gz 标记');
    must(cur && cur.current === true, 'current 标记');
    must(r.sessions[0].file === 'latest.log', '最新的排在最前');
  });

  await t('perf-sessions：没有 logs 目录时返回空列表而不是报错', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-perf-nologs-'));
    const r = await need('perf-sessions')(null, empty);
    must(r.ok && r.sessions.length === 0);
  });

  /* ---------------- perf-compare ---------------- */
  await t('perf-compare：解 gz 并与当前会话对比', async () => {
    const r = await need('perf-compare')(null, { gameDir: tmp, a: '2026-10-01-1.log.gz', b: 'latest.log' });
    must(r.ok, '对比应成功：' + (r.error || ''));
    must(r.rows.length === 10, '应有 10 行指标，实际 ' + r.rows.length);
    const st = r.rows.find((x) => x.key === 'stutter');
    must(st.a === 1 && st.b === 5, '卡顿次数 1 vs 5，实际 ' + st.a + ' vs ' + st.b);
    must(st.verdict === 'worse', '卡顿变多应判为 worse');
    must(r.overall === 'worse', '整体应变差');
  });

  await t('perf-compare：拒绝 logs 目录之外的路径', async () => {
    const r = await need('perf-compare')(null, { gameDir: tmp, a: '../secret.log', b: 'latest.log' });
    must(r.ok === false, '越界路径必须被拒');
    must(typeof r.error === 'string' && r.error.length > 0);
  });

  await t('perf-compare：同一个文件对比给出说明而不是崩', async () => {
    const r = await need('perf-compare')(null, { gameDir: tmp, a: 'latest.log', b: 'latest.log' });
    // 后端不拦同一文件（UI 拦），但至少不能抛
    must(r.ok === true || r.ok === false);
  });

  /* ---------------- 收尾 ---------------- */
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log('=================');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
