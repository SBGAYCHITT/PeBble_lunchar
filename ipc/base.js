// 基础信息与通用文件操作：默认游戏目录、已装版本、Java 探测、系统对话框、
// 打开目录/文件、读写信中 options.txt、复制文本。
//
// 为什么 options.txt 和「打开目录」在这里而不是 ipc/content.js：
//   content.js 是资源管理（Mod / 资源包 / 光影 / 存档 / 截图）的聚合域，
//   而 Lite 版只裁资源管理、不裁设置页 —— 如果这几项留在 content 里，
//   Lite 的设置页会直接拿到「No handler registered for 'read-options'」。
//   它们本质就是 mcapi 上的薄封装，放基础域更贴切，两个版本行为完全一致。
const path = require('path');
const { shell, clipboard } = require('electron');
const launcher = require('../launcher');
const mcapi = require('../mcapi');

module.exports = function register(ctx) {
  const { ipcMain, dialog } = ctx;

  ipcMain.handle('default-mcdir', () => path.join(process.env.APPDATA || '', '.minecraft'));

  ipcMain.handle('list-versions', (_e, mcDir) => {
    try { return launcher.listVersions(mcDir); } catch { return []; }
  });

  ipcMain.handle('detect-java', async (_e, mcDir, preferMajor) => {
    try { return await launcher.detectJava(mcDir, preferMajor); } catch { return null; }
  });

  ipcMain.handle('pick-directory', async () => {
    const r = await dialog.showOpenDialog(ctx.getWin(), { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('pick-file', async (_e, filters) => {
    const r = await dialog.showOpenDialog(ctx.getWin(), {
      properties: ['openFile'],
      filters: filters && filters.length ? filters : [{ name: '可执行文件', extensions: ['exe'] }]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('save-file', async (_e, defaultName, filters) => {
    const r = await dialog.showSaveDialog(ctx.getWin(), {
      defaultPath: defaultName || 'export.zip',
      filters: filters && filters.length ? filters : [{ name: '压缩包', extensions: ['zip'] }]
    });
    return r.canceled ? null : r.filePath;
  });

  /* ---------- 通用文件操作 ---------- */
  ipcMain.handle('open-folder', (_e, p) => mcapi.openFolder(p));
  ipcMain.handle('open-path', (_e, p) => { shell.openPath(p); });
  ipcMain.handle('show-in-explorer', (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle('copy-text', (_e, text) => {
    try { clipboard.writeText(String(text || '')); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  /* ---------- 游戏内设置（options.txt） ---------- */
  ipcMain.handle('read-options', (_e, gd) => mcapi.readOptions(gd));
  ipcMain.handle('write-options', (_e, gd, patch) => mcapi.writeOptions(gd, patch));
};
