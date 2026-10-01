// 跨启动器迁移：探测 PCL/HMCL/官方启动器等目录并导入内容
const migrate = require('../migrate');
const { safe } = require('./util');

module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  ipcMain.handle('mig-detect', safe(() => migrate.detectLaunchers({
    pclRoots: migrate.driveRoots()
  })));
  ipcMain.handle('mig-inspect', safe((_e, dir) => migrate.inspectDir(dir)));
  ipcMain.handle('mig-scan', safe((_e, gameDir) => migrate.scanContent({ gameDir })));
  ipcMain.handle('mig-import', safe(async (_e, destGameDir, items, overwrite) => {
    const r = migrate.importItems({ destGameDir, items: items || [], overwrite: !!overwrite });
    return { ok: true, report: r };
  }));
  ipcMain.handle('mig-default-env', () => migrate.defaultEnv());
};
