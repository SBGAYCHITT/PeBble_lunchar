// 世界相关功能 IPC 聚合（V4 第一组 + 第二组，V5 第一组补齐）：
//   - 世界版本控制   worldver（纳入跟踪 / 提交 / 历史 / 分支 / 回滚 / diff / gc）
//   - 版本控制完整版 worldver（V5：方块级 blame / 时间轴回放 / 自研三方合并）
//   - 世界合并搬运   worldmerge（plan 只读预览 / apply 执行，落盘前自动快照）
//   - 存档地图预览   worldmap（区块分辨率俯视地图）
//   - 跨存档统一数据库 worlddb（容器 / 命名实体索引 + 检索 + 统计）
//
// 所有 handler 走 safe 包装：抛错统一转成 {ok:false,error}，渲染层 await 即可。
// storeDir（worldver 自己的对象库）落在 userData 下，不污染存档目录。
const path = require('path');
const worldver = require('../worldver');
const worldmerge = require('../worldmerge');
const worldmap = require('../worldmap');
const worlddb = require('../worlddb');
const blockstate = require('../blockstate');
const anvil = require('../anvil');
const { safe } = require('./util');

/** worldver 对象库根目录（与存档目录分离） */
function storeDirOf(ctx) {
  return path.join(ctx.userData || require('os').homedir(), 'worldver');
}
/** 存档目录 → 世界 key（worldver 用 basename 作库名） */
function worldOf(saveDir) { return path.basename(String(saveDir || 'world')); }

module.exports = function register(ctx) {
  const { ipcMain, emit } = ctx;
  const STORE = storeDirOf(ctx);

  /* ---------- 世界版本控制 ---------- */
  ipcMain.handle('world-ver-list', safe(() => worldver.listWorlds({ storeDir: STORE })));
  ipcMain.handle('world-ver-status', safe((_e, saveDir) => worldver.status({
    saveDir, storeDir: STORE, world: worldOf(saveDir)
  })));
  ipcMain.handle('world-ver-track', safe((_e, saveDir, message) => worldver.init({
    saveDir, storeDir: STORE, world: worldOf(saveDir), message
  })));
  ipcMain.handle('world-ver-commit', safe((_e, saveDir, message, branch) => worldver.commit({
    saveDir, storeDir: STORE, world: worldOf(saveDir), message, branch
  })));
  ipcMain.handle('world-ver-log', safe((_e, saveDir) => worldver.log({
    storeDir: STORE, world: worldOf(saveDir)
  })));
  ipcMain.handle('world-ver-branches', safe((_e, saveDir) => worldver.branches({
    storeDir: STORE, world: worldOf(saveDir)
  })));
  ipcMain.handle('world-ver-branch-create', safe((_e, saveDir, name, from) => worldver.createBranch({
    storeDir: STORE, world: worldOf(saveDir), name, from
  })));
  ipcMain.handle('world-ver-branch-switch', safe((_e, saveDir, name) => worldver.switchBranch({
    storeDir: STORE, world: worldOf(saveDir), name
  })));
  ipcMain.handle('world-ver-checkout', safe((_e, saveDir, ref, prune) => worldver.checkout({
    saveDir, storeDir: STORE, world: worldOf(saveDir),
    id: /^[0-9]{8}-/.test(ref || '') ? ref : undefined,
    branch: /^[0-9]{8}-/.test(ref || '') ? undefined : (ref || undefined),
    tmDir: ctx.TM_DIR, prune
  })));
  ipcMain.handle('world-ver-diff', safe((_e, saveDir, a, b) => worldver.diff({
    storeDir: STORE, world: worldOf(saveDir), a, b
  })));
  ipcMain.handle('world-ver-blame', safe((_e, saveDir, cx, cz, dim, kind, id) => worldver.blame({
    storeDir: STORE, world: worldOf(saveDir), cx, cz, dim, kind, id
  })));

  /* ---------- V5 第一组：方块级 blame / 时间轴回放 / 自研三方合并 ---------- */

  // 方块级 blame：给一个**世界坐标**（不是区块坐标），回答"这格是谁改的"
  ipcMain.handle('world-ver-blame-block', safe((_e, o) => worldver.blameBlock({
    storeDir: STORE, world: worldOf(o && o.saveDir),
    x: o && o.x, y: o && o.y, z: o && o.z,
    dim: o && o.dim, kind: o && o.kind, id: o && o.id
  })));

  // 时间轴：先拿帧列表，再按帧 id 逐帧取内容（滑块拖动时只重复第二个）
  ipcMain.handle('world-ver-timeline', safe((_e, o) => worldver.timeline({
    storeDir: STORE, world: worldOf(o && o.saveDir),
    cx: o && o.cx, cz: o && o.cz,
    dim: o && o.dim, kind: o && o.kind, branch: o && o.branch, id: o && o.id
  })));
  // 帧内容额外带上颜色。着色表只存在主进程（worldmap.blockColor），
  // 在这里映射一次，渲染层就不用再抄一份方块→颜色表 —— 两份表迟早会走偏。
  ipcMain.handle('world-ver-frame', safe((_e, o) => {
    const r = worldver.frame({
      storeDir: STORE, world: worldOf(o && o.saveDir),
      cx: o && o.cx, cz: o && o.cz, y: o && o.y,
      dim: o && o.dim, kind: o && o.kind, branch: o && o.branch, id: o && o.id
    });
    r.colors = r.states ? r.states.map((n) => (n && !blockstate.AIR_NAMES.has(n) ? worldmap.blockColor(n) : null)) : null;
    return r;
  }));

  ipcMain.handle('world-ver-merge-plan', safe((_e, o) => worldver.mergePlan({
    storeDir: STORE, world: worldOf(o && o.saveDir),
    ours: o && o.ours, theirs: o && o.theirs,
    strategy: o && o.strategy, analyze: !(o && o.analyze === false),
    analyzeLimit: o && o.analyzeLimit
  })));
  // mergeApply 在有冲突时抛的错里带着 **计划书**，UI 要靠它显示冲突详情。
  // safe() 会把 plan 丢掉，所以这一条单独包一层，把 plan / code 原样带回去。
  ipcMain.handle('world-ver-merge-apply', async (_e, o) => {
    try {
      return await worldver.mergeApply({
        storeDir: STORE, world: worldOf(o && o.saveDir),
        ours: o && o.ours, theirs: o && o.theirs, message: o && o.message,
        strategy: o && o.strategy, allowConflicts: !!(o && o.allowConflicts),
        analyze: !(o && o.analyze === false), analyzeLimit: o && o.analyzeLimit
      });
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null, plan: e.plan || null };
    }
  });

  ipcMain.handle('world-ver-gc', safe((_e, saveDir) => worldver.gc({
    storeDir: STORE, world: worldOf(saveDir)
  })));
  ipcMain.handle('world-ver-stats', safe((_e, saveDir) => worldver.stats({
    storeDir: STORE, world: worldOf(saveDir)
  })));

  /* ---------- 世界合并与建筑移植 ---------- */
  // 这两条不走 safe()：plan 抛的 SHIFT_NOT_ALIGNED 里带着 nearest（最近可用的 16 倍数平移量），
  // UI 要拿它摆一颗"就用它"的按钮；safe() 只留 message，那个字段会被丢掉。
  // 其余情况（真失败）仍然只是 {ok:false, error}，形状和 safe() 一致。
  const errOut = (e) => ({
    ok: false, error: e.message,
    code: e.code || null, nearest: e.nearest || null, plan: e.plan || null
  });
  ipcMain.handle('world-merge-plan', async (_e, o) => {
    try { return await worldmerge.plan(o); } catch (e) { return errOut(e); }
  });
  ipcMain.handle('world-merge-apply', async (_e, o) => {
    try {
      return await worldmerge.apply(Object.assign({}, o, { tmDir: ctx.TM_DIR }));
    } catch (e) { return errOut(e); }
  });

  /* ---------- 存档地图预览 ---------- */
  ipcMain.handle('world-map-scan', safe((_e, saveDir, dim, layer) => worldmap.scan({
    saveDir, dim: dim || 'overworld', layer: layer || 'blocks'
  })));
  ipcMain.handle('world-map-regions', safe((_e, saveDir, dim) => worldmap.regionOverview({
    saveDir, dim: dim || 'overworld'
  })));

  /* ---------- 跨存档统一数据库 ---------- */
  // 索引缓存落在 userData 下（**不写进存档目录**）：按 region 文件的 mtime+size 指纹，
  // 第二次扫描只重读变过的文件。一次全量扫描要解压几万个区块，而"只多了一个箱子"的
  // 世界通常只有一两个 region 文件会变。
  const DB_DIR = path.join(ctx.userData || require('os').homedir(), 'worlddb');
  let lastKey = null;
  let lastSaves = null;
  const keyOf = (g) => (Array.isArray(g) ? g.map((x) => path.resolve(String(x))).join('|')
    : (g ? path.resolve(String(g)) : ''));
  /**
   * 拿到索引结果（必要时重新扫）。
   * @param {string|string[]} gameDir 单个 gameDir，或一组（多启动器/多版本共用一份索引）
   * @param {{force?:boolean, incremental?:boolean, dims?:string[]}} t
   */
  async function ensureIndex(gameDir, t) {
    const opt = t || {};
    const key = keyOf(gameDir) + '#' + (opt.dims ? opt.dims.join(',') : '');
    if (!opt.force && lastSaves && key === lastKey) return lastSaves;
    const dirs = Array.isArray(gameDir) ? gameDir.filter(Boolean) : (gameDir ? [gameDir] : []);
    lastSaves = await worlddb.scanGameDir({
      gameDirs: dirs,
      cacheDir: DB_DIR,
      // force 就是"别信缓存"：走全量重扫并顺手把缓存刷新一遍，
      // 比"先删缓存文件再扫"少一次目录遍历，而且不会留下半删的状态。
      incremental: opt.force ? false : opt.incremental !== false,
      dims: Array.isArray(opt.dims) && opt.dims.length ? opt.dims : undefined
    });
    lastKey = key;
    return lastSaves;
  }

  ipcMain.handle('world-db-index', safe(async (_e, gameDir, t) => {
    const saves = await ensureIndex(gameDir, t);
    const stats = worlddb.stats(saves);
    const sum = (f) => saves.reduce((n, s) => n + (s.scan ? (f(s.scan) || 0) : 0), 0);
    return {
      count: saves.length,
      saves,
      stats,
      cacheDir: DB_DIR,
      scanned: {
        files: sum((s) => s.files),
        parsedFiles: sum((s) => s.parsedFiles),
        reusedFiles: sum((s) => s.reusedFiles),
        chunks: stats.indexedChunks,
        broken: stats.brokenChunks
      }
    };
  }));

  ipcMain.handle('world-db-search', safe(async (_e, gameDir, query) => {
    const saves = await ensureIndex(gameDir, {});
    // 用 searchDetailed：检索串写错（dim:天界 / near:abc）时要把错误带回渲染层，
    // 否则用户只会看到"没有匹配"，然后反复改词去猜。
    const d = worlddb.searchDetailed(saves, query || '');
    return {
      results: d.results,
      total: d.total, pages: d.pages, page: d.page,
      query: d.query,
      searchError: d.error,       // 检索串本身的错（和 r.error 那种"操作失败"分开）
      stats: worlddb.stats(saves)
    };
  }));

  /* ---------- 存档自检 ---------- */
  // 把每个区块解出来再原样写回去，逐字节比对 —— 用来证明"编解码不会弄坏玩家存档"。
  // 不用 safe()：这里最要紧的恰恰是如实区分「检查过、没问题」和「没检查」，
  // 而 safe() 会把异常压成一句 error，把两者的边界抹掉。
  ipcMain.handle('world-selfcheck', async (_e, saveDir, opt) => {
    const o = opt || {};
    const n = Number(o.limit);
    // 不传默认 4000：真实存档动辄上万区块，全量跑一遍界面会以为卡死了。
    // 显式传 0 才是"全量"，那是用户自己选的。
    const limit = n === 0 ? 0 : (n > 0 ? n : 4000);
    try {
      return await anvil.selfCheckSave(saveDir, {
        limit,
        onProgress: (p) => emit('selfcheck-progress', p)
      });
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
};
