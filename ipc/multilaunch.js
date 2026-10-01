// 多账户并行：登记表查询 / 结束单个 / 全部结束 / 占用检查
const multilaunch = require('../multilaunch');

module.exports = function register(ctx) {
  const { ipcMain, emit } = ctx;

  ipcMain.handle('ml-list', () => ({ ok: true, items: multilaunch.list() }));

  ipcMain.handle('ml-stop', (_e, key) => {
    const log = (s) => emit('game-log', '[多开] ' + s);
    const r = multilaunch.stop(key, log);
    emit('ml-changed', multilaunch.list());
    return r;
  });

  ipcMain.handle('ml-stop-all', () => {
    const log = (s) => emit('game-log', '[多开] ' + s);
    const r = multilaunch.stopAll(log);
    emit('ml-changed', multilaunch.list());
    return r;
  });

  ipcMain.handle('ml-busy', (_e, o) => ({ ok: true, entry: multilaunch.occupied(o) }));
};
