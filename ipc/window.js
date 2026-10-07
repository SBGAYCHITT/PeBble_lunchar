// 窗口控制：最小化 / 最大化 / 关闭（渲染层自制标题栏用）
// V4.1.0：删掉了 set-opacity —— 界面改成纯白后窗口不再透明，没有可调的东西。
module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  ipcMain.on('win-minimize', () => { const w = ctx.getWin(); if (w) w.minimize(); });
  ipcMain.on('win-close', () => { const w = ctx.getWin(); if (w) w.close(); });
  // 窗口放大到 1440×900 后在 1366×768 这类屏幕上会超出，得让用户能铺满
  ipcMain.on('win-maximize', () => {
    const w = ctx.getWin();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
};
