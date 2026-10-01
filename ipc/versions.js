// 版本：清单拉取 / 下载安装 / 加载器安装 / 版本文件操作 / 版本号解析
const fs = require('fs');
const path = require('path');
const downloader = require('../downloader');
const loaders = require('../loaders');
const mcapi = require('../mcapi');

module.exports = function register(ctx) {
  const { ipcMain, emit } = ctx;

  ipcMain.handle('get-manifest', async () => {
    try {
      const m = await downloader.getManifest();
      return {
        ok: true,
        latest: m.latest,
        versions: m.versions.slice(0, 120).map(v => ({ id: v.id, type: v.type, time: v.releaseTime }))
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('install-version', async (_e, opts) => {
    const send = (p) => emit('install-progress', p);
    try { return await downloader.installVersion(opts, send); }
    catch (e) {
      send({ phase: '失败: ' + e.message, done: 0, total: 1, failed: true });
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('loader-versions', async (_e, kind, mcVersion) => {
    try {
      // Forge 会返回更丰富的结果（含 reason/forgeLatestMc），用于区分「网络失败」和「该版本未被支持」
      if (kind === 'forge') return await loaders.forgeVersions(mcVersion);
      let list = [];
      if (kind === 'neoforge') list = await loaders.neoforgeVersions(mcVersion);
      else if (kind === 'fabric') list = await loaders.fabricLoaderVersions();
      else if (kind === 'quilt') list = await loaders.quiltLoaderVersions();
      else if (kind === 'optifine') list = await loaders.optifineVersions(mcVersion);
      return { ok: true, list };
    } catch (e) { return { ok: false, error: e.message, list: [] }; }
  });

  ipcMain.handle('install-loader', async (_e, opts) => {
    const send = (l) => emit('install-progress', { phase: l, done: 0, total: 1 });
    try {
      const r = await loaders.installLoader(opts, send);
      emit('install-progress', { phase: opts.loader + ' 安装完成', done: 1, total: 1, finished: true });
      return r;
    } catch (e) {
      emit('install-progress', { phase: '安装失败: ' + e.message, done: 0, total: 1, failed: true });
      return { ok: false, error: e.message };
    }
  });

  /* ---------- 版本文件操作 ---------- */
  ipcMain.handle('version-action', async (_e, action, args) => {
    const { mcDir, id, newId, file } = args || {};
    try {
      if (action === 'delete') return mcapi.deleteVersion(mcDir, id);
      if (action === 'copy') return mcapi.copyVersion(mcDir, id, newId);
      if (action === 'rename') return mcapi.renameVersion(mcDir, id, newId);
      if (action === 'export') return mcapi.exportVersion(mcDir, id, file);
      if (action === 'import') return mcapi.importVersion(mcDir, file, id);
      return { ok: false, error: '未知操作' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /**
   * 从版本 id 解析出真正的 MC 版本号。
   * "1.20.1" → 1.20.1；"fabric-loader-0.15.7-1.20.1" 要沿 inheritsFrom 走到 1.20.1。
   * 不做这步的话，Mod 守卫会拿 loader 的 id 去做版本区间比较，全是误报。
   */
  ipcMain.handle('resolve-mc-version', (_e, mcDir, id) => {
    try {
      let cur = id;
      for (let i = 0; i < 10 && cur; i++) {
        const p = path.join(mcDir, 'versions', cur, cur + '.json');
        if (!fs.existsSync(p)) return { ok: false, error: '找不到版本 JSON: ' + cur };
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!j.inheritsFrom) return { ok: true, mc: cur, requested: id };
        cur = j.inheritsFrom;
      }
      return { ok: false, error: '继承链过深' };
    } catch (e) { return { ok: false, error: e.message }; }
  });
};
