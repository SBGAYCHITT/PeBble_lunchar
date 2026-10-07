// 资源目录：Mod / 资源包 / 光影 / 存档 / 截图 / 崩溃报告
//
// 注意「打开目录 / 打开文件 / 复制文本 / 读写信中 options.txt」不在这里 ——
// 它们已挪到 ipc/base.js：Lite 版要裁资源管理但不裁设置页，留在本域会让 Lite 断链。
const fs = require('fs');
const mcapi = require('../mcapi');
const packinfo = require('../packinfo');
const modguard = require('../modguard');
const { safe } = require('./util');

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('list-mods', (_e, gd) => mcapi.listMods(gd));
  ipcMain.handle('list-resourcepacks', (_e, gd) => mcapi.listResourcepacks(gd));
  ipcMain.handle('list-shaderpacks', (_e, gd) => mcapi.listShaderpacks(gd));
  ipcMain.handle('list-saves', (_e, gd) => mcapi.listSaves(gd));
  ipcMain.handle('list-screenshots', (_e, gd) => mcapi.listScreenshots(gd));
  ipcMain.handle('list-crashes', (_e, gd) => mcapi.listCrashes(gd));
  ipcMain.handle('read-log', (_e, p, len) => mcapi.readLogTail(p, len));
  ipcMain.handle('toggle-file', (_e, p) => mcapi.toggleFile(p));
  ipcMain.handle('delete-path', (_e, p) => mcapi.deletePath(p));
  ipcMain.handle('copy-file', (_e, src, destDir) => mcapi.copyFile(src, destDir));
  ipcMain.handle('zip-dir', (_e, src, destZip) => mcapi.zipDir(src, destZip));

  /* ---------- 崩溃报告：读取全文 ---------- */
  ipcMain.handle('read-crash-report', (_e, p) => {
    try {
      if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
      return { ok: true, text: fs.readFileSync(p, 'utf8') };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /**
   * 资源包 / 光影包的元信息（名称、描述、图标、适用 MC 版本）。
   * 传 mcVersion 时会额外算出 compat：true 匹配 / false 不匹配 / null 无法判定。
   */
  ipcMain.handle('pack-info', safe((_e, list, kind, mcVersion) => {
    const items = packinfo.describePacks(list || [], kind);
    for (const it of items) {
      it.compat = it.format == null ? null : packinfo.formatMatches(it.format, mcVersion || '');
    }
    return { ok: true, items };
  }));

  /**
   * Mod 列表的真实元数据（名字 / 版本 / 载入器 / MC 区间）。
   * 与 list-mods 的区别：这里读 jar 里的 fabric.mod.json / mods.toml，
   * 而不是拿文件名当名字。结果带缓存，反复刷新不会反复解 jar。
   */
  ipcMain.handle('mod-meta', safe((_e, modsDir) => {
    const { mods, ok } = modguard.scan({ modsDir });
    return { ok, mods };
  }));
};
