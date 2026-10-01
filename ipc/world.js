// 世界相关功能 IPC 聚合（V4 第一组 + 第二组）：
//   - 世界版本控制   worldver（纳入跟踪 / 提交 / 历史 / 分支 / 回滚 / diff / gc）
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
const { safe } = require('./util');

/** worldver 对象库根目录（与存档目录分离） */
function storeDirOf(ctx) {
  return path.join(ctx.userData || require('os').homedir(), 'worldver');
}
/** 存档目录 → 世界 key（worldver 用 basename 作库名） */
function worldOf(saveDir) { return path.basename(String(saveDir || 'world')); }

module.exports = function register(ctx) {
  const { ipcMain } = ctx;
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
  ipcMain.handle('world-ver-gc', safe((_e, saveDir) => worldver.gc({
    storeDir: STORE, world: worldOf(saveDir)
  })));
  ipcMain.handle('world-ver-stats', safe((_e, saveDir) => worldver.stats({
    storeDir: STORE, world: worldOf(saveDir)
  })));

  /* ---------- 世界合并与建筑移植 ---------- */
  ipcMain.handle('world-merge-plan', safe((_e, o) => worldmerge.plan(o)));
  ipcMain.handle('world-merge-apply', safe((_e, o) => worldmerge.apply(Object.assign({}, o, { tmDir: ctx.TM_DIR }))));

  /* ---------- 存档地图预览 ---------- */
  ipcMain.handle('world-map-scan', safe((_e, saveDir, dim, layer) => worldmap.scan({
    saveDir, dim: dim || 'overworld', layer: layer || 'blocks'
  })));
  ipcMain.handle('world-map-regions', safe((_e, saveDir, dim) => worldmap.regionOverview({
    saveDir, dim: dim || 'overworld'
  })));

  /* ---------- 跨存档统一数据库：索引缓存（按 gameDir 复用，避免反复整库扫描） ---------- */
  let lastGameDir = null;
  let lastSaves = null;
  ipcMain.handle('world-db-index', safe(async (_e, gameDir) => {
    lastSaves = await worlddb.scanGameDir({ gameDir });
    lastGameDir = path.resolve(gameDir);
    const stats = worlddb.stats(lastSaves);
    return { count: lastSaves.length, saves: lastSaves, stats };
  }));
  ipcMain.handle('world-db-search', safe(async (_e, gameDir, query) => {
    const key = gameDir ? path.resolve(gameDir) : null;
    if (!lastSaves || key !== lastGameDir) {
      lastSaves = await worlddb.scanGameDir({ gameDir });
      lastGameDir = key;
    }
    const results = worlddb.search(lastSaves, query || '');
    const stats = worlddb.stats(lastSaves);
    return { results, stats };
  }));
};
