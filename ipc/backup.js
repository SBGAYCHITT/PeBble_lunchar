// 后悔药：存档时光机 + Mod 守卫
const path = require('path');
const timemachine = require('../savetimemachine');
const modguard = require('../modguard');
const { safe } = require('./util');

module.exports = function register(ctx) {
  const { ipcMain, TM_DIR, AUTO_KEEP } = ctx;

  ipcMain.handle('tm-dir', () => TM_DIR);

  ipcMain.handle('save-tm-list', (_e, saveDir) =>
    timemachine.listSnapshots({ storeDir: TM_DIR, world: path.basename(saveDir || '') }));

  ipcMain.handle('save-tm-create', safe(async (_e, saveDir, label) => {
    const snap = await timemachine.createSnapshot({ saveDir, storeDir: TM_DIR, label: label || '手动快照' });
    return { ok: true, snap };
  }));

  ipcMain.handle('save-tm-restore', safe(async (_e, saveDir, id) => {
    const r = await timemachine.restoreSnapshot({ saveDir, storeDir: TM_DIR, id });
    return { ok: true, ...r };
  }));

  ipcMain.handle('save-tm-delete', (_e, id) => {
    timemachine.deleteSnapshot({ storeDir: TM_DIR, id });
    timemachine.gc({ storeDir: TM_DIR });
    return { ok: true };
  });

  ipcMain.handle('save-tm-gc', () => timemachine.gc({ storeDir: TM_DIR }));

  ipcMain.handle('save-tm-stats', (_e, saveDir) =>
    timemachine.stats({ storeDir: TM_DIR, world: path.basename(saveDir || '') }));

  ipcMain.handle('save-health', safe((_e, saveDir) => timemachine.healthCheck({ saveDir })));

  /* ---------- Mod 守卫 ---------- */
  ipcMain.handle('mod-analyze', safe((_e, gameDir, mcVersion, loader) =>
    modguard.analyze({ modsDir: path.join(gameDir, 'mods'), mcVersion, loader })));

  ipcMain.handle('mod-snapshot', safe(async (_e, gameDir, label) => {
    const snap = await modguard.snapshot({ gameDir, storeDir: TM_DIR, label: label || '手动快照' });
    modguard.prune({ storeDir: TM_DIR, gameDir, keep: AUTO_KEEP });
    return { ok: true, snap };
  }));

  ipcMain.handle('mod-snap-list', (_e, gameDir) => modguard.listSnapshots({ storeDir: TM_DIR, gameDir }));

  ipcMain.handle('mod-restore', safe(async (_e, gameDir, id) => {
    const r = await modguard.restore({ gameDir, storeDir: TM_DIR, id });
    return { ok: true, ...r };
  }));

  ipcMain.handle('mod-snap-delete', (_e, id) => {
    modguard.removeSnapshot({ storeDir: TM_DIR, id });
    modguard.gc({ storeDir: TM_DIR });
    return { ok: true };
  });

  ipcMain.handle('mod-stats', (_e, gameDir) => modguard.stats({ storeDir: TM_DIR, gameDir }));

  /** 与最近一次快照对比，告诉玩家"这次到底动了什么" */
  ipcMain.handle('mod-diff-latest', safe((_e, gameDir) => {
    const list = modguard.listSnapshots({ storeDir: TM_DIR, gameDir });
    if (!list.length) return { ok: true, hasBase: false };
    const base = list[0];
    const now = modguard.scan({ modsDir: path.join(gameDir, 'mods') });
    return {
      ok: true, hasBase: true,
      base: { id: base.id, label: base.label, time: base.time },
      diff: modguard.diff(base.modList || [], now)
    };
  }));
};
