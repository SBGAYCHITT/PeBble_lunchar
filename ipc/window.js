// 窗口控制：最小化 / 关闭 / 透明度（渲染层自制标题栏用）
module.exports = function register(ctx) {
  const { ipcMain } = ctx;

  ipcMain.on('win-minimize', () => { const w = ctx.getWin(); if (w) w.minimize(); });
  ipcMain.on('win-close', () => { const w = ctx.getWin(); if (w) w.close(); });
  ipcMain.on('set-opacity', (_e, v) => {
    try {
      const w = ctx.getWin();
      if (w) w.setOpacity(Math.min(1, Math.max(0.3, v)));
    } catch {}
  });
};
