// 在线仓库（Modrinth / CurseForge）
// CurseForge 强制要求 API Key，没有就只出 Modrinth 的结果，并在 errors 里说明原因
// —— 不假装"搜不到"。
const modstore = require('../modstore');
const securestore = require('../securestore');
const { safe } = require('./util');

module.exports = function register(ctx) {
  const { ipcMain, emit } = ctx;

  ipcMain.handle('store-search', safe(async (_e, o) => {
    const r = await modstore.search(Object.assign({}, o, {
      apiKey: securestore.getSecret('cfKey')
    }));
    // 标出哪些已经装在本地了（按 sha1 比对，比按文件名猜准得多）
    if (o && o.destDir) {
      const hashes = modstore.localHashes(o.destDir, null);
      for (const it of r.items) it.installed = hashes.has(it.sha1);
    }
    return { ok: true, items: r.items, errors: r.errors };
  }));

  ipcMain.handle('store-mc-versions', safe(async () => {
    const v = await modstore.gameVersions();
    return { ok: true, versions: v };
  }));

  ipcMain.handle('store-details', safe(async (_e, o) => {
    const p = await modstore.details({
      source: o.source, id: o.id, apiKey: securestore.getSecret('cfKey')
    });
    return { ok: true, project: p };
  }));

  ipcMain.handle('store-versions', safe(async (_e, o) => {
    const v = await modstore.versions({
      source: o.source, id: o.id, mc: o.mc, apiKey: securestore.getSecret('cfKey')
    });
    return { ok: true, versions: v };
  }));

  ipcMain.handle('store-install', safe(async (_e, o) => {
    let url = o.url;
    // CurseForge 有些文件不直接给 downloadUrl，需要单独换一次
    if (!url && o.source === 'curseforge' && o.fileId) {
      url = await modstore.cfDownloadUrl(o.id, o.fileId, securestore.getSecret('cfKey'));
    }
    if (!url) throw new Error('没有可用的下载地址');
    const r = await modstore.install({
      url, name: o.name, destDir: o.destDir, sha1: o.sha1, size: o.size,
      onProgress: (got, total) => emit('store-progress', { key: o.key, got, total })
    });
    return r;
  }));

  /** 远程图片由主进程代抓 → data URL，这样渲染层不需要放宽 CSP */
  ipcMain.handle('store-image', safe(async (_e, url) => {
    const d = await modstore.fetchImage(url);
    return { ok: !!d, data: d };
  }));

  /** 本地已装文件的 sha1 集合，用于在在线列表上打「已安装」 */
  ipcMain.handle('store-local-hashes', (_e, dir) => {
    const m = modstore.localHashes(dir, null);
    return { ok: true, hashes: Array.from(m.keys()) };
  });

  ipcMain.handle('store-key-status', () => {
    const v = securestore.getSecret('cfKey');
    return { ok: true, has: !!v, hint: v ? ('已保存 · 结尾 ' + v.slice(-4)) : '' };
  });

  ipcMain.handle('store-key-set', (_e, value) => {
    const r = securestore.setSecret('cfKey', String(value || '').trim());
    if (!r.ok) return r;
    const v = securestore.getSecret('cfKey');
    return { ok: true, has: !!v, hint: v ? ('已保存 · 结尾 ' + v.slice(-4)) : '已清除' };
  });
};
