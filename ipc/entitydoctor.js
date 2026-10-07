// 实体清理建议 IPC（V4 第二组尾巴 · R11）
//
// 职责：把 entitydoctor 的「扫描 → 归因 → 给清理指令」三步接到渲染层。
// 定位遵循 R11 的原意：**只读存档、只给建议与现成指令**，不代替玩家删任何东西
// （清理指令由玩家自己在游戏里执行，单人存档需要开启作弊权限）。
//
// 设计要点：
//   1) 三维度全扫很慢（要解压全部 region + entities），所以拆两个 channel：
//      `entdoc-scan` 只扫一个维度给原始分布；`entdoc-analyze` 一次扫完给结论与指令。
//   2) `entdoc-scan` 只回传最挤的前 200 个区块 —— 一个存档几万个区块全传过去纯属浪费。
//   3) 全程只读：不写、不删、不改存档。
const entitydoctor = require('../entitydoctor');
const { safe } = require('./util');

/** entitydoctor.analyze 支持的维度（与 anvil 的目录约定一致） */
const DIMS = ['overworld', 'nether', 'end'];

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  /** 类别 / 成本 / 阈值元数据：给 UI 画图例、设置门限 */
  ipcMain.handle('entdoc-meta', safe(() => ({
    ok: true,
    categories: Object.keys(entitydoctor.CATEGORY).map((k) => ({
      key: k,
      label: entitydoctor.CATEGORY_ZH[k] || k,
      cost: entitydoctor.COST[k] || 0
    })),
    thresholds: entitydoctor.TH,
    dims: DIMS
  })));

  /**
   * 扫描单个维度的实体分布（原始数据，不下结论）。
   * @param {{saveDir:string, dim?:string}} o
   */
  ipcMain.handle('entdoc-scan', safe(async (_e, o) => {
    const opt = o || {};
    if (!opt.saveDir) return { ok: false, error: '没有指定存档目录。' };
    const dim = DIMS.indexOf(opt.dim) >= 0 ? opt.dim : 'overworld';
    const r = await entitydoctor.scanDim({ saveDir: opt.saveDir, dim });
    const chunks = Array.isArray(r.chunks) ? r.chunks : [];
    let total = 0;
    let empty = 0;
    for (const c of chunks) { total += c.count || 0; if (!c.count) empty++; }
    return {
      ok: true,
      dim,
      files: r.files,
      broken: r.broken,
      missing: r.missing,
      chunkCount: chunks.length,
      emptyChunks: empty,
      total,
      top: chunks.slice().sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 200)
    };
  }));

  /**
   * 全存档实体诊断：三维度扫完 → findings + 评分 + 可复制的清理指令。
   * @param {{saveDir:string, name?:string, dims?:string[], top?:number, th?:object}} o
   */
  ipcMain.handle('entdoc-analyze', safe(async (_e, o) => {
    const opt = o || {};
    if (!opt.saveDir) return { ok: false, error: '没有指定存档目录。' };
    let dims = Array.isArray(opt.dims) ? opt.dims.filter((d) => DIMS.indexOf(d) >= 0) : [];
    if (!dims.length) dims = DIMS;
    const r = await entitydoctor.analyze({
      saveDir: opt.saveDir,
      name: opt.name,
      dims,
      top: Number(opt.top) || undefined,
      th: opt.th
    });
    return Object.assign({ ok: true }, r);
  }));

  /** 把分析结果渲染成纯文本报告（UI 上一个「复制报告」按钮直接用） */
  ipcMain.handle('entdoc-report', safe((_e, analysis) => ({
    ok: true,
    text: entitydoctor.report(analysis || {})
  })));
};
