// 基础信息：默认游戏目录、已装版本、Java 探测、系统对话框
const path = require('path');
const launcher = require('../launcher');

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
};
